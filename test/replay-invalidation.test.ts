import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { RunResult } from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { WorkflowArtifactStore } from "../src/artifact-store.js";
import type { WorkflowTaskId } from "../src/contracts.js";
import { defineWorkflow } from "../src/definition.js";
import type {
	WorkflowEventInput,
	WorkflowStateProjection,
} from "../src/events.js";
import {
	deriveJsonValueSha256,
	deriveSubagentOperationId,
	deriveSubagentResultSha256,
	deriveTaskExecutionId,
	deriveWorkflowFailureSha256,
} from "../src/execution.js";
import {
	WorkflowMaterializationError,
	WorkflowTaskMaterializer,
} from "../src/materializer.js";
import {
	type WorkflowJournalEvent,
	WorkflowRunJournal,
} from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
	type WorkflowRunLease,
} from "../src/persistence/run-lease.js";
import { invalidationClosure, reduceWorkflowEvents } from "../src/reducer.js";
import type {
	WorkflowSchedulerOutcome,
	WorkflowSequentialScheduler,
} from "../src/scheduler.js";
import {
	createStaticWorkflowRuntime,
	StaticWorkflowRuntimeError,
} from "../src/static-runtime.js";

const RUN_ID = "workflow_replayinvalidation" as const;
const definitionIdentitySha256 = "a".repeat(64);
const inputSha256 = "b".repeat(64);
const planIdentitySha256 = "c".repeat(64);
const REMATERIALIZATION_REASON = "Explicit invalidation re-executes the task.";
const RECOVERY_REASON = "Explicit invalidation re-executes invalidated tasks.";
const INVALIDATION_REASON = "operator re-execution";

// ---------------------------------------------------------------------------
// Part A helpers: pure materializer replay against reduced projections.
// ---------------------------------------------------------------------------

function request(goal = "Answer") {
	return {
		agent: "researcher",
		task: {
			goal,
			context: [],
			instructions: ["Return structured output."],
		},
		contextMode: "fresh" as const,
		tools: ["read", "grep", "find", "ls"],
		preloadSkills: [],
		contextScopes: ["project" as const],
		workspace: { mode: "read-only" as const, cwd: "/repo" },
		outputSchema: Type.Object({ answer: Type.String() }),
		limits: {
			cumulativeRuntimeMs: 300_000,
			attemptTimeoutMs: 300_000,
			totalTokens: 1_000_000,
			cost: 100,
			outputBytes: 1_048_576,
			workspaceWriteBytes: 0,
			retries: 1,
			resumes: 1,
		},
	};
}

function materializer(previousState?: WorkflowStateProjection) {
	return new WorkflowTaskMaterializer({
		runId: RUN_ID,
		definitionIdentitySha256,
		inputSha256,
		...(previousState === undefined ? {} : { previousState }),
	});
}

/** Journal records for a running run: run-created, running, then `events`. */
function records(
	events: readonly WorkflowEventInput[],
): WorkflowJournalEvent[] {
	const all: WorkflowEventInput[] = [
		{
			type: "run-created",
			data: { definitionIdentitySha256, inputSha256 },
		},
		{
			type: "run-status-changed",
			data: { from: "created", to: "running" },
		},
		...events,
	];
	return all.map((event, index) => ({
		schema: "pi-workflow-event",
		contractRevision: 21,
		sequence: index + 1,
		eventId: `event-${index + 1}`,
		timestamp: "2026-08-20T00:00:00.000Z",
		runId: RUN_ID,
		ownerId: "test",
		leaseId: "lease-test",
		fencingGeneration: 1,
		type: event.type,
		data: event.data,
	}));
}

function reduce(
	events: readonly WorkflowEventInput[],
): WorkflowStateProjection {
	return reduceWorkflowEvents(records(events));
}

/** The exact `task-invalidated` event the spec's helper computes for a cause. */
function invalidation(
	state: WorkflowStateProjection,
	causeTaskId: WorkflowTaskId,
): WorkflowEventInput & { type: "task-invalidated" } {
	const closure = invalidationClosure(state, causeTaskId);
	return {
		type: "task-invalidated",
		data: {
			causeTaskId,
			taskIds: [...closure.taskIds],
			abandonedEpochs: [...closure.abandonedEpochs],
			reason: INVALIDATION_REASON,
		},
	};
}

function rematerialization(taskId: WorkflowTaskId): WorkflowEventInput {
	return {
		type: "task-status-changed",
		data: {
			taskId,
			from: "invalidated",
			to: "pending",
			reason: REMATERIALIZATION_REASON,
		},
	};
}

function sortedIds(...ids: readonly WorkflowTaskId[]): WorkflowTaskId[] {
	return [...ids].sort();
}

/**
 * Epoch 1 {a, b after a} closed by result[a]; epoch 2 {c} closed by
 * results[c]; then a is invalidated. The result barrier orders c after a, so
 * the closure is {a, b, c} and epoch 2 is abandoned together with c, which
 * is therefore both invalidated and abandoned.
 */
function twoEpochGraph() {
	const initial = materializer();
	const a = initial.agent("a", request("A"));
	const b = initial.agent("b", { ...request("B"), after: [a.ref] });
	const first = initial.closeEpoch("result", [a]);
	const c = initial.agent("c", request("C"));
	const second = initial.closeEpoch("results", [c]);
	const declared = [...first.events, ...second.events];
	const declaredState = reduce(declared);
	const invalidated = invalidation(declaredState, a.ref.taskId);
	const events = [...declared, invalidated];
	return {
		ids: { a: a.ref.taskId, b: b.ref.taskId, c: c.ref.taskId },
		invalidated,
		events,
		state: reduce(events),
	};
}

/** Replays `twoEpochGraph` and declares a divergent task d in epoch 3. */
function divergedGraph() {
	const graph = twoEpochGraph();
	const replay = materializer(graph.state);
	const a = replay.agent("a", request("A"));
	replay.agent("b", { ...request("B"), after: [a.ref] });
	const first = replay.closeEpoch("result", [a]);
	const d = replay.agent("d", request("D"));
	const commit = replay.closeEpoch("results", [d]);
	const events = [...graph.events, ...first.events, ...commit.events];
	return {
		graph,
		ids: { ...graph.ids, d: d.ref.taskId },
		first,
		commit,
		events,
		state: reduce(events),
	};
}

describe("materializer replay after transactional invalidation", () => {
	it("re-materializes invalidated path tasks at their matched barrier", () => {
		const graph = twoEpochGraph();
		const { a, b, c } = graph.ids;
		expect(graph.invalidated.data).toMatchObject({
			taskIds: sortedIds(a, b, c),
			abandonedEpochs: [2],
		});
		expect(graph.state.tasks[a]?.status).toBe("invalidated");
		expect(graph.state.tasks[b]?.status).toBe("invalidated");
		expect(graph.state.tasks[a]?.abandoned).toBeUndefined();
		expect(graph.state.tasks[b]?.abandoned).toBeUndefined();
		expect(graph.state.tasks[c]).toMatchObject({
			status: "invalidated",
			abandoned: true,
		});
		expect(graph.state.barriers.map((barrier) => barrier.abandoned)).toEqual([
			undefined,
			true,
		]);

		const replay = materializer(graph.state);
		const replayedA = replay.agent("a", request("A"));
		const replayedB = replay.agent("b", {
			...request("B"),
			after: [replayedA.ref],
		});
		expect(replayedA.ref.taskId).toBe(a);
		expect(replayedB.ref.taskId).toBe(b);
		const commit = replay.closeEpoch("result", [replayedA]);
		expect(commit.epoch).toBe(1);
		expect(commit.events).toEqual([rematerialization(a), rematerialization(b)]);

		const state = reduce([...graph.events, ...commit.events]);
		expect(state.tasks[a]).toMatchObject({
			status: "pending",
			committed: true,
		});
		expect(state.tasks[b]).toMatchObject({
			status: "pending",
			committed: true,
		});
		expect(state.tasks[a]?.abandoned).toBeUndefined();
		expect(state.tasks[b]?.abandoned).toBeUndefined();
		// Abandoned history is untouched by re-materialization of the path.
		expect(state.tasks[c]).toMatchObject({
			status: "invalidated",
			abandoned: true,
		});
		expect(state.barriers.map((barrier) => barrier.abandoned)).toEqual([
			undefined,
			true,
		]);
		expect(state.currentEpoch).toBe(3);
	});

	it("accepts a divergent suffix numbered after every persisted barrier", () => {
		const diverged = divergedGraph();
		const { a, c, d } = diverged.ids;
		expect(diverged.first.events).toHaveLength(2);
		expect(diverged.commit.epoch).toBe(3);
		expect(diverged.commit.events.map((event) => event.type)).toEqual([
			"task-declared",
			"barrier-reached",
		]);
		const [declaration, barrier] = diverged.commit.events;
		if (
			declaration?.type !== "task-declared" ||
			barrier?.type !== "barrier-reached"
		) {
			throw new Error("missing divergent commit events");
		}
		expect(declaration.data.task).toMatchObject({
			id: d,
			materializationEpoch: 3,
			materializationSequence: 4,
			epochPosition: 1,
		});
		expect(declaration.data.task.spec.after).toEqual([
			{ runId: RUN_ID, taskId: a },
		]);
		expect(barrier.data).toEqual({ epoch: 3, kind: "results", taskIds: [d] });

		const { state } = diverged;
		expect(state.tasks[d]).toMatchObject({
			status: "pending",
			committed: true,
		});
		expect(state.tasks[d]?.abandoned).toBeUndefined();
		expect(state.tasks[c]?.abandoned).toBe(true);
		expect(
			state.barriers.map((entry) => [entry.epoch, entry.abandoned]),
		).toEqual([
			[1, undefined],
			[2, true],
			[3, undefined],
		]);
		expect(state.currentEpoch).toBe(4);

		const again = materializer(state);
		const againA = again.agent("a", request("A"));
		again.agent("b", { ...request("B"), after: [againA.ref] });
		const againFirst = again.closeEpoch("result", [againA]);
		expect(againFirst.epoch).toBe(1);
		expect(againFirst.events).toEqual([]);
		const againD = again.agent("d", request("D"));
		expect(againD.ref.taskId).toBe(d);
		const againThird = again.closeEpoch("results", [againD]);
		expect(againThird.epoch).toBe(3);
		expect(againThird.events).toEqual([]);

		const stale = materializer(state);
		const staleA = stale.agent("a", request("A"));
		stale.agent("b", { ...request("B"), after: [staleA.ref] });
		stale.closeEpoch("result", [staleA]);
		expect(() => stale.agent("c", request("C"))).toThrow(
			"does not match the persisted ordered prefix",
		);
	});

	it("readopts an abandoned task whose identity is unchanged", () => {
		const graph = twoEpochGraph();
		const { a, b, c } = graph.ids;
		const replay = materializer(graph.state);
		const replayedA = replay.agent("a", request("A"));
		replay.agent("b", { ...request("B"), after: [replayedA.ref] });
		const first = replay.closeEpoch("result", [replayedA]);
		const readopted = replay.agent("c", request("C"));
		expect(readopted.ref.taskId).toBe(c);
		const commit = replay.closeEpoch("results", [readopted]);
		expect(commit.epoch).toBe(3);
		expect(commit.events).toEqual([
			{
				type: "task-declared",
				data: {
					task: expect.objectContaining({
						id: c,
						materializationSequence: 4,
						materializationEpoch: 3,
						epochPosition: 1,
					}),
				},
			},
			{
				type: "barrier-reached",
				data: { epoch: 3, kind: "results", taskIds: [c] },
			},
			// c was invalidated with the closure, so readoption re-materializes
			// it in the same commit, after the barrier.
			rematerialization(c),
		]);
		const declaration = commit.events[0];
		if (declaration?.type !== "task-declared") {
			throw new Error("missing readoption declaration");
		}
		const {
			materializationSequence: _sequence,
			materializationEpoch: _epoch,
			epochPosition: _position,
			...redeclared
		} = declaration.data.task;
		const original = graph.state.tasks[c]?.task;
		if (!original) throw new Error("missing abandoned task");
		const {
			materializationSequence: _originalSequence,
			materializationEpoch: _originalEpoch,
			epochPosition: _originalPosition,
			...persisted
		} = original;
		expect(redeclared).toEqual(persisted);

		const state = reduce([...graph.events, ...first.events, ...commit.events]);
		expect(state.tasks[c]?.abandoned).toBeUndefined();
		expect(state.tasks[c]).toMatchObject({
			status: "pending",
			committed: true,
		});
		expect(state.tasks[c]?.task).toMatchObject({
			materializationSequence: 4,
			materializationEpoch: 3,
			epochPosition: 1,
		});
		expect(state.tasks[a]?.status).toBe("pending");
		expect(state.tasks[b]?.status).toBe("pending");
		expect(state.currentEpoch).toBe(4);

		const changed = materializer(graph.state);
		const changedA = changed.agent("a", request("A"));
		changed.agent("b", { ...request("B"), after: [changedA.ref] });
		changed.closeEpoch("result", [changedA]);
		expect(() => changed.agent("c", request("Changed C"))).toThrow(
			"abandoned task key re-declared with a changed request",
		);
		expect(() => changed.agent("c", request("Changed C"))).toThrow(
			WorkflowMaterializationError,
		);

		const duplicate = materializer(graph.state);
		const duplicateA = duplicate.agent("a", request("A"));
		duplicate.agent("b", { ...request("B"), after: [duplicateA.ref] });
		duplicate.closeEpoch("result", [duplicateA]);
		expect(() => duplicate.agent("a", request("A"))).toThrow(
			"duplicate task key in namespace",
		);
	});

	it("readopts and re-materializes an invalidated abandoned task in one commit", () => {
		const initial = materializer();
		const a = initial.agent("a", request("A"));
		const first = initial.closeEpoch("result", [a]);
		const c = initial.agent("c", {
			...request("C"),
			inputs: { seed: a.output },
		});
		const second = initial.closeEpoch("results", [c]);
		const declared = [...first.events, ...second.events];
		const invalidated = invalidation(reduce(declared), a.ref.taskId);
		expect(invalidated.data).toMatchObject({
			taskIds: sortedIds(a.ref.taskId, c.ref.taskId),
			abandonedEpochs: [2],
		});
		const events = [...declared, invalidated];
		const state = reduce(events);
		expect(state.tasks[c.ref.taskId]).toMatchObject({
			status: "invalidated",
			abandoned: true,
		});
		expect(state.tasks[a.ref.taskId]?.status).toBe("invalidated");

		const replay = materializer(state);
		const replayedA = replay.agent("a", request("A"));
		const rematerialized = replay.closeEpoch("result", [replayedA]);
		expect(rematerialized.epoch).toBe(1);
		expect(rematerialized.events).toEqual([rematerialization(a.ref.taskId)]);
		const readopted = replay.agent("c", {
			...request("C"),
			inputs: { seed: replayedA.output },
		});
		expect(readopted.ref.taskId).toBe(c.ref.taskId);
		const commit = replay.closeEpoch("results", [readopted]);
		expect(commit.epoch).toBe(3);
		expect(commit.events).toEqual([
			{
				type: "task-declared",
				data: {
					task: expect.objectContaining({
						id: c.ref.taskId,
						materializationSequence: 3,
						materializationEpoch: 3,
						epochPosition: 1,
					}),
				},
			},
			{
				type: "barrier-reached",
				data: { epoch: 3, kind: "results", taskIds: [c.ref.taskId] },
			},
			rematerialization(c.ref.taskId),
		]);

		const after = reduce([
			...events,
			...rematerialized.events,
			...commit.events,
		]);
		expect(after.tasks[a.ref.taskId]?.status).toBe("pending");
		expect(after.tasks[c.ref.taskId]).toMatchObject({
			status: "pending",
			committed: true,
		});
		expect(after.tasks[c.ref.taskId]?.abandoned).toBeUndefined();
		expect(after.currentEpoch).toBe(4);
	});

	it("re-materializes a readopted task persisted before its barrier by a crashed drive", () => {
		const initial = materializer();
		const a = initial.agent("a", request("A"));
		const first = initial.closeEpoch("result", [a]);
		const c = initial.agent("c", {
			...request("C"),
			inputs: { seed: a.output },
		});
		const second = initial.closeEpoch("results", [c]);
		const declared = [...first.events, ...second.events];
		const invalidated = invalidation(reduce(declared), a.ref.taskId);
		expect(invalidated.data).toMatchObject({
			taskIds: sortedIds(a.ref.taskId, c.ref.taskId),
			abandonedEpochs: [2],
		});
		const events = [...declared, invalidated];

		// The first recovery drive re-materializes a, readopts c, and crashes
		// after its `task-declared` was journaled but before `barrier-reached`.
		const crashed = materializer(reduce(events));
		const crashedA = crashed.agent("a", request("A"));
		const rematerialized = crashed.closeEpoch("result", [crashedA]);
		expect(rematerialized.events).toEqual([rematerialization(a.ref.taskId)]);
		const crashedC = crashed.agent("c", {
			...request("C"),
			inputs: { seed: crashedA.output },
		});
		expect(crashedC.ref.taskId).toBe(c.ref.taskId);
		const interrupted = crashed.closeEpoch("results", [crashedC]);
		expect(interrupted.events.map((event) => event.type)).toEqual([
			"task-declared",
			"barrier-reached",
			"task-status-changed",
		]);
		const declaration = interrupted.events.find(
			(event) => event.type === "task-declared",
		);
		if (!declaration) throw new Error("missing readoption declaration");
		const persistedEvents = [...events, ...rematerialized.events, declaration];
		const persisted = reduce(persistedEvents);
		// c is on-path again, committed by its abandoned barrier, still
		// invalidated, and its new epoch has no barrier yet.
		expect(persisted.tasks[c.ref.taskId]).toMatchObject({
			status: "invalidated",
			committed: true,
			task: {
				materializationSequence: 3,
				materializationEpoch: 3,
				epochPosition: 1,
			},
		});
		expect(persisted.tasks[c.ref.taskId]?.abandoned).toBeUndefined();
		expect(persisted.tasks[a.ref.taskId]?.status).toBe("pending");
		expect(
			persisted.barriers.map((barrier) => [barrier.epoch, barrier.abandoned]),
		).toEqual([
			[1, undefined],
			[2, true],
		]);
		expect(persisted.currentEpoch).toBe(3);

		// The next drive replays the persisted declaration as prefix and must
		// still re-materialize c when it closes the new epoch, even though c
		// was never declared by this drive.
		const fresh = materializer(persisted);
		const freshA = fresh.agent("a", request("A"));
		const freshFirst = fresh.closeEpoch("result", [freshA]);
		expect(freshFirst.epoch).toBe(1);
		expect(freshFirst.events).toEqual([]);
		const freshC = fresh.agent("c", {
			...request("C"),
			inputs: { seed: freshA.output },
		});
		expect(freshC.ref.taskId).toBe(c.ref.taskId);
		const commit = fresh.closeEpoch("results", [freshC]);
		expect(commit.epoch).toBe(3);
		expect(commit.events).toEqual([
			{
				type: "barrier-reached",
				data: { epoch: 3, kind: "results", taskIds: [c.ref.taskId] },
			},
			rematerialization(c.ref.taskId),
		]);

		const after = reduce([...persistedEvents, ...commit.events]);
		expect(after.tasks[c.ref.taskId]).toMatchObject({
			status: "pending",
			committed: true,
		});
		expect(after.tasks[c.ref.taskId]?.abandoned).toBeUndefined();
		expect(after.tasks[a.ref.taskId]?.status).toBe("pending");
		expect(
			after.barriers.map((barrier) => [barrier.epoch, barrier.abandoned]),
		).toEqual([
			[1, undefined],
			[2, true],
			[3, undefined],
		]);
		expect(after.currentEpoch).toBe(4);

		// A further replay of the completed prefix is silent.
		const again = materializer(after);
		const againA = again.agent("a", request("A"));
		expect(again.closeEpoch("result", [againA]).events).toEqual([]);
		const againC = again.agent("c", {
			...request("C"),
			inputs: { seed: againA.output },
		});
		expect(again.closeEpoch("results", [againC]).events).toEqual([]);
	});

	it("keeps the persisted prefix strict after a divergent suffix", () => {
		const { state, ids } = divergedGraph();
		const omitted = materializer(state);
		const omittedA = omitted.agent("a", request("A"));
		expect(() => omitted.closeEpoch("result", [omittedA])).toThrow(
			"barrier omits declarations from the persisted epoch prefix",
		);

		const replaced = materializer(state);
		replaced.agent("a", request("A"));
		expect(() => replaced.agent("x", request("X"))).toThrow(
			"does not match the persisted ordered prefix",
		);

		const reordered = materializer(state);
		const reorderedA = reordered.agent("a", request("A"));
		reordered.agent("b", { ...request("B"), after: [reorderedA.ref] });
		reordered.closeEpoch("result", [reorderedA]);
		expect(() => reordered.closeEpoch("results", [])).toThrow(
			"barrier omits declarations from the persisted epoch prefix",
		);
		expect(state.tasks[ids.d]?.task.materializationEpoch).toBe(3);
	});

	it("still bounds path declarations after abandonment", () => {
		const graph = twoEpochGraph();
		const replay = materializer(graph.state);
		const a = replay.agent("a", request("A"));
		replay.agent("b", { ...request("B"), after: [a.ref] });
		replay.closeEpoch("result", [a]);
		for (let index = 0; index < 254; index += 1) {
			replay.agent(`extra-${index}`, request("Extra"));
		}
		expect(() => replay.agent("overflow", request("Extra"))).toThrow(
			"workflow task limit exceeded",
		);
	});

	it("abandons nothing when only the last barrier exposes the closure", () => {
		const initial = materializer();
		const a = initial.agent("a", request("A"));
		const first = initial.closeEpoch("result", [a]);
		const c = initial.agent("c", request("C"));
		const second = initial.closeEpoch("results", [c]);
		const declared = [...first.events, ...second.events];
		const invalidated = invalidation(reduce(declared), c.ref.taskId);
		expect(invalidated.data).toMatchObject({
			taskIds: [c.ref.taskId],
			abandonedEpochs: [],
		});
		const events = [...declared, invalidated];
		const state = reduce(events);
		expect(state.barriers.map((barrier) => barrier.abandoned)).toEqual([
			undefined,
			undefined,
		]);
		expect(Object.values(state.tasks).map((task) => task.abandoned)).toEqual([
			undefined,
			undefined,
		]);
		expect(state.tasks[c.ref.taskId]?.status).toBe("invalidated");
		expect(state.currentEpoch).toBe(3);

		const partial = materializer(state);
		const partialA = partial.agent("a", request("A"));
		partial.closeEpoch("result", [partialA]);
		expect(() => partial.closeEpoch("results", [])).toThrow(
			"barrier omits declarations from the persisted epoch prefix",
		);

		const replay = materializer(state);
		const replayedA = replay.agent("a", request("A"));
		expect(replay.closeEpoch("result", [replayedA]).events).toEqual([]);
		const replayedC = replay.agent("c", request("C"));
		const rematerialized = replay.closeEpoch("results", [replayedC]);
		expect(rematerialized.epoch).toBe(2);
		expect(rematerialized.events).toEqual([rematerialization(c.ref.taskId)]);
		const d = replay.agent("d", request("D"));
		const commit = replay.closeEpoch("final", [d]);
		expect(commit.epoch).toBe(3);
		const declaration = commit.events[0];
		if (declaration?.type !== "task-declared") {
			throw new Error("missing declaration");
		}
		expect(declaration.data.task).toMatchObject({
			materializationSequence: 3,
			materializationEpoch: 3,
			epochPosition: 1,
		});
		const after = reduce([
			...events,
			...rematerialized.events,
			...commit.events,
		]);
		expect(after.tasks[c.ref.taskId]?.status).toBe("pending");
		expect(after.tasks[d.ref.taskId]).toMatchObject({
			status: "pending",
			committed: true,
		});
		expect(after.currentEpoch).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// Part B helpers: static runtime recovery with a generation-aware fake
// scheduler that settles agent tasks completed or failed on request.
// ---------------------------------------------------------------------------

type FakeOutcome =
	| { readonly status: "completed"; readonly output: unknown }
	| { readonly status: "failed" };

const leases = new Set<WorkflowRunLease>();
const fixtureRoot = path.resolve(
	".pi",
	"test-replay-invalidation",
	`session-${randomUUID()}`,
);

afterEach(async () => {
	await Promise.all([...leases].map((lease) => lease.release()));
	leases.clear();
});

afterAll(async () => {
	await rm(fixtureRoot, { recursive: true, force: true });
});

function runtimeRequest(goal = "Answer") {
	return {
		agent: "researcher",
		task: { goal, context: [], instructions: ["Return structured output."] },
		contextMode: "fresh" as const,
		tools: ["read"],
		preloadSkills: [],
		contextScopes: ["project" as const],
		workspace: { mode: "read-only" as const, cwd: "/repo" },
		outputSchema: Type.Object({ answer: Type.String() }),
		limits: {
			cumulativeRuntimeMs: 300_000,
			attemptTimeoutMs: 300_000,
			totalTokens: 1_000_000,
			cost: 10,
			outputBytes: 1024,
			workspaceWriteBytes: 0,
			retries: 0,
			resumes: 0,
		},
	};
}

function meta(name: string) {
	return {
		name,
		description: "Recovery",
		version: 1,
		budget: { cost: 1000, childRuntimeMs: 3600000 },
		timeoutMs: 3600000,
	};
}

async function fixture(runId = "workflow_replayrecovery") {
	const root = path.join(fixtureRoot, `run-${randomUUID()}`);
	const lease = await acquireWorkflowRunLease({
		storeRoot: root,
		runId,
		ownerId: "replay-invalidation-test",
	});
	leases.add(lease);
	const journal = await WorkflowRunJournal.open(root, runId, lease);
	const artifacts = await WorkflowArtifactStore.open({ journal });
	return { root, lease, journal, artifacts };
}

function completedResult(runId: string, value: unknown): RunResult {
	return {
		runId,
		status: "completed",
		structuredOutput: value,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: 0,
		},
		usageComplete: true,
		runtimeMs: 10,
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
	};
}

/**
 * Settles the first on-path pending/ready agent task in materialization
 * order with the next execution generation for that task.
 */
function generationSchedulerFor(
	journal: WorkflowRunJournal,
	artifacts: WorkflowArtifactStore,
	outcomes: Map<string, FakeOutcome>,
): WorkflowSequentialScheduler & { calls: number } {
	const scheduler = {
		concurrency: 1,
		stopSignal: new AbortController().signal,
		calls: 0,
		async drive(): Promise<WorkflowSchedulerOutcome> {
			scheduler.calls += 1;
			let current = reduceWorkflowEvents(await journal.readEvents());
			if (current.status === "created" || current.status === "waiting") {
				await journal.append("run-status-changed", {
					from: current.status,
					to: "running",
				});
				current = reduceWorkflowEvents(await journal.readEvents());
			}
			const task = Object.values(current.tasks)
				.filter((candidate) => candidate.abandoned !== true)
				.sort(
					(left, right) =>
						left.task.materializationSequence -
						right.task.materializationSequence,
				)
				.find(
					(candidate) =>
						candidate.status === "pending" || candidate.status === "ready",
				);
			if (!task) return { state: "idle", runStatus: current.status };
			if (task.task.spec.kind !== "agent") {
				throw new Error("fake scheduler only supports agent tasks");
			}
			const key = task.task.spec.key;
			const outcome = outcomes.get(key);
			if (!outcome) throw new Error(`missing fake outcome for ${key}`);
			const taskId = task.task.id;
			const generation =
				1 +
				Object.values(current.executions).filter(
					(execution) => execution.execution.taskId === taskId,
				).length;
			if (task.status === "pending") {
				await journal.append("task-status-changed", {
					taskId,
					from: "pending",
					to: "ready",
				});
			}
			const executionId = deriveTaskExecutionId(
				current.runId,
				taskId,
				generation,
			);
			const operationId = deriveSubagentOperationId(
				current.runId,
				taskId,
				generation,
			);
			await journal.append("task-execution-created", {
				execution: {
					kind: "agent",
					id: executionId,
					runId: current.runId,
					taskId,
					generation,
					taskIdentitySha256: task.task.spec.identitySha256,
					operationId,
				},
			});
			if (outcome.status === "failed") {
				const message = "Subagent preflight failed before launch.";
				await journal.append("task-execution-terminal", {
					executionId,
					outcome: "failed",
					evidence: {
						kind: "workflow",
						stage: "preflight",
						failureSha256: deriveWorkflowFailureSha256("preflight", message),
						message,
					},
				});
				await journal.append("task-status-changed", {
					taskId,
					from: "ready",
					to: "failed",
				});
				return { state: "idle", runStatus: "running" };
			}
			const childKey = `${key.replaceAll("-", "")}g${generation}`;
			const childRunId = `run_${childKey}`;
			const childAttemptId = `attempt_${childKey}`;
			await journal.append("task-execution-preflighted", {
				executionId,
				operationId,
				preflightId: `preflight-${childKey}`,
				workspaceMode: "read-only" as const,
				workspaceBaselineSha256: "c".repeat(64),
				planIdentitySha256,
				plannedSubagentRunId: childRunId,
				plannedSubagentAttemptId: childAttemptId,
				expiresAt: "2099-01-01T00:00:00.000Z",
			});
			await journal.append("task-execution-launch-intended", {
				executionId,
				operationId,
				preflightId: `preflight-${childKey}`,
				planIdentitySha256,
			});
			await journal.append("task-execution-launch-receipted", {
				executionId,
				operationId,
				subagentRunId: childRunId,
				subagentAttemptId: childAttemptId,
				status: "completed",
			});
			await journal.append("task-status-changed", {
				taskId,
				from: "ready",
				to: "waiting",
			});
			await journal.append("task-execution-child-observed", {
				executionId,
				subagentRunId: childRunId,
				subagentAttemptId: childAttemptId,
				status: "completed",
			});
			const output = outcome.output;
			const result = completedResult(childRunId, output);
			const evidence = {
				kind: "subagent" as const,
				attemptOrdinal: 1,
				resultSha256: deriveSubagentResultSha256(result),
				status: "completed" as const,
				usage: result.usage,
				usageComplete: true,
				runtimeMs: 10,
				sandboxCleanup: "proved" as const,
				workspaceCleanup: "not-needed" as const,
				truncated: false,
				structuredOutputSha256: deriveJsonValueSha256(output),
			};
			await journal.append("task-execution-child-settled", {
				executionId,
				evidence,
			});
			const artifact = await artifacts.putJson(output, {
				runId: current.runId,
				producerTaskId: taskId,
				producerExecutionId: executionId,
				output: "result",
				schemaSha256: deriveJsonValueSha256(
					task.task.spec.request.outputSchema,
				),
			});
			await journal.append("artifact-declared", { artifact });
			await journal.append("task-execution-artifact-imported", {
				executionId,
				subagentRunId: childRunId,
				artifactId: artifact.id,
				sourceResultSha256: evidence.resultSha256,
			});
			await journal.append("task-execution-release-intended", {
				executionId,
				subagentRunId: childRunId,
			});
			await journal.append("task-execution-released", {
				executionId,
				subagentRunId: childRunId,
				status: "completed",
			});
			await journal.append("task-execution-terminal", {
				executionId,
				outcome: "completed",
				evidence,
			});
			await journal.append("task-status-changed", {
				taskId,
				from: "waiting",
				to: "completed",
			});
			return {
				state: "awaiting-finalization",
				runStatus: "running",
				taskId,
				executionId,
				child: {
					runId: childRunId,
					attemptId: childAttemptId,
					status: "completed",
				},
				outcome: "completed",
			};
		},
		async reconcile() {
			throw new Error("fake workflow has no cleanup-blocked task");
		},
		async decide() {
			throw new Error("fake scheduler records no decisions");
		},
		async stop() {
			return { state: "terminal", runStatus: "cancelled" } as const;
		},
	};
	return scheduler;
}

async function journalState(
	journal: WorkflowRunJournal,
): Promise<WorkflowStateProjection> {
	return reduceWorkflowEvents(await journal.readEvents());
}

function taskIdByKey(
	state: WorkflowStateProjection,
	key: string,
): WorkflowTaskId {
	const task = Object.values(state.tasks).find(
		(candidate) => candidate.task.spec.key === key,
	);
	if (!task) throw new Error(`missing task ${key}`);
	return task.task.id;
}

async function appendInvalidation(
	journal: WorkflowRunJournal,
	causeTaskId: WorkflowTaskId,
) {
	const closure = invalidationClosure(await journalState(journal), causeTaskId);
	await journal.append("task-invalidated", {
		causeTaskId,
		taskIds: [...closure.taskIds],
		abandonedEpochs: [...closure.abandonedEpochs],
		reason: INVALIDATION_REASON,
	});
	return closure;
}

/** A single-task run whose required result task fails on the first drive. */
async function failedResultRun(name: string) {
	const { journal, artifacts } = await fixture();
	const outcomes = new Map<string, FakeOutcome>([["a", { status: "failed" }]]);
	const definition = defineWorkflow({
		meta: meta(name),
		inputSchema: Type.Object({}),
		outputSchema: Type.Object({ answer: Type.String() }),
		async run(ctx) {
			const a = ctx.agent("a", runtimeRequest("A"));
			const value = await ctx.result(a);
			return { answer: value.answer };
		},
	});
	const scheduler = generationSchedulerFor(journal, artifacts, outcomes);
	const runtime = createStaticWorkflowRuntime({
		definition,
		definitionIdentitySha256,
		input: {},
		cwd: "/repo",
		journal,
		artifacts,
		scheduler,
	});
	await expect(runtime.drive()).rejects.toMatchObject({ stage: "execution" });
	const state = await journalState(journal);
	expect(state.status).toBe("failed");
	const aId = taskIdByKey(state, "a");
	expect(state.tasks[aId]?.status).toBe("failed");
	expect(state.tasks[aId]?.currentExecutionId).toBe(
		deriveTaskExecutionId(journal.runId, aId, 1),
	);
	return { journal, artifacts, outcomes, scheduler, runtime, aId };
}

describe("static runtime recovery after transactional invalidation", () => {
	it("recovers a failed run by re-executing the invalidated task as generation 2", async () => {
		const { journal, outcomes, scheduler, runtime, aId } =
			await failedResultRun("recovery");
		const closure = await appendInvalidation(journal, aId);
		expect(closure).toEqual({ taskIds: [aId], abandonedEpochs: [] });
		expect((await journalState(journal)).tasks[aId]?.status).toBe(
			"invalidated",
		);
		outcomes.set("a", {
			status: "completed",
			output: { answer: "second time" },
		});
		const callsBefore = scheduler.calls;
		await expect(runtime.drive()).resolves.toMatchObject({
			status: "completed",
			value: { answer: "second time" },
		});
		expect(scheduler.calls).toBeGreaterThan(callsBefore);

		const events = await journal.readEvents();
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "run-status-changed",
				data: { from: "failed", to: "running", reason: RECOVERY_REASON },
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "task-status-changed",
				data: {
					taskId: aId,
					from: "invalidated",
					to: "pending",
					reason: REMATERIALIZATION_REASON,
				},
			}),
		);

		const state = reduceWorkflowEvents(events);
		expect(state.status).toBe("completed");
		const gen1 = deriveTaskExecutionId(journal.runId, aId, 1);
		const gen2 = deriveTaskExecutionId(journal.runId, aId, 2);
		expect(state.tasks[aId]).toMatchObject({
			status: "completed",
			currentExecutionId: gen2,
		});
		expect(state.executions[gen2]?.execution.generation).toBe(2);
		expect(state.executions[gen2]?.phase).toBe("terminal");
		expect(state.executions[gen2]?.terminal?.outcome).toBe("completed");
		const results = Object.values(state.artifacts).filter(
			(artifact) => artifact.producerTaskId === aId,
		);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			output: "result",
			producerExecutionId: gen2,
		});
		expect(state.executions[gen1]).toMatchObject({
			execution: { generation: 1 },
			phase: "terminal",
			terminal: { outcome: "failed", evidence: { kind: "workflow" } },
		});
		expect(Object.keys(state.executions).sort()).toEqual([gen1, gen2].sort());
	});

	it("still refuses to drive a failed run without invalidated work", async () => {
		const { journal, scheduler, runtime } = await failedResultRun("refusal");
		const callsBefore = scheduler.calls;
		const sequenceBefore = (await journalState(journal)).lastSequence;
		await expect(runtime.drive()).rejects.toThrow(
			"Workflow run requires explicit recovery from failed.",
		);
		expect(scheduler.calls).toBe(callsBefore);
		const state = await journalState(journal);
		expect(state.status).toBe("failed");
		expect(state.lastSequence).toBe(sequenceBefore);
	});

	async function effectsRun(name: string) {
		const { journal, artifacts } = await fixture();
		const logs = { pre: "before result", post: "after result" };
		const outcomes = new Map<string, FakeOutcome>([
			["a", { status: "completed", output: { answer: "a1" } }],
			["b", { status: "failed" }],
		]);
		const definition = defineWorkflow({
			meta: meta(name),
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			async run(ctx) {
				ctx.log(logs.pre);
				const a = ctx.agent("a", runtimeRequest("A"));
				const first = await ctx.result(a);
				ctx.log(logs.post);
				const b = ctx.agent("b", runtimeRequest("B"));
				const second = await ctx.result(b);
				return { answer: `${first.answer}/${second.answer}` };
			},
		});
		const scheduler = generationSchedulerFor(journal, artifacts, outcomes);
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		await expect(runtime.drive()).rejects.toMatchObject({
			stage: "execution",
		});
		const failed = await journalState(journal);
		expect(failed.status).toBe("failed");
		const aId = taskIdByKey(failed, "a");
		const bId = taskIdByKey(failed, "b");
		expect(failed.tasks[aId]?.status).toBe("completed");
		expect(failed.tasks[bId]?.status).toBe("failed");
		expect(failed.effects.map((effect) => effect.value)).toEqual([
			"before result",
			"after result",
		]);
		expect(failed.barriers.map((barrier) => barrier.taskIds)).toEqual([
			[aId],
			[bId],
		]);
		const [firstBarrier] = failed.barriers;
		if (!firstBarrier) throw new Error("missing first barrier");
		expect(failed.effects[0]?.sequence).toBeLessThan(firstBarrier.sequence);
		expect(failed.effects[1]?.sequence).toBeGreaterThan(firstBarrier.sequence);

		const closure = await appendInvalidation(journal, aId);
		expect(closure).toEqual({
			taskIds: sortedIds(aId, bId),
			abandonedEpochs: [2],
		});
		const invalidated = await journalState(journal);
		expect(invalidated.effects.map((effect) => effect.abandoned)).toEqual([
			undefined,
			true,
		]);
		expect(invalidated.tasks[bId]).toMatchObject({
			status: "invalidated",
			abandoned: true,
		});
		expect(invalidated.barriers.map((barrier) => barrier.abandoned)).toEqual([
			undefined,
			true,
		]);
		return { journal, outcomes, scheduler, runtime, logs, aId, bId };
	}

	it("accepts a different post-result effect on recovery and numbers it after every persisted effect", async () => {
		const { journal, outcomes, runtime, logs, aId, bId } =
			await effectsRun("effects-diverge");
		outcomes.set("a", { status: "completed", output: { answer: "a2" } });
		outcomes.set("b", { status: "completed", output: { answer: "b2" } });
		logs.post = "after result (recovered)";
		await expect(runtime.drive()).resolves.toMatchObject({
			status: "completed",
			value: { answer: "a2/b2" },
		});
		const state = await journalState(journal);
		expect(state.status).toBe("completed");
		expect(
			state.effects.map((effect) => [
				effect.ordinal,
				effect.value,
				effect.abandoned,
			]),
		).toEqual([
			[1, "before result", undefined],
			[2, "after result", true],
			[3, "after result (recovered)", undefined],
		]);
		expect(state.tasks[aId]?.currentExecutionId).toBe(
			deriveTaskExecutionId(journal.runId, aId, 2),
		);
		expect(state.tasks[bId]).toMatchObject({
			status: "completed",
			currentExecutionId: deriveTaskExecutionId(journal.runId, bId, 2),
		});
		expect(state.tasks[bId]?.abandoned).toBeUndefined();
		expect(state.tasks[bId]?.task).toMatchObject({
			materializationSequence: 3,
			materializationEpoch: 3,
			epochPosition: 1,
		});
		expect(
			state.barriers.map((barrier) => [
				barrier.epoch,
				barrier.kind,
				barrier.abandoned,
			]),
		).toEqual([
			[1, "result", undefined],
			[2, "result", true],
			[3, "result", undefined],
			[4, "final", undefined],
		]);
	});

	it("fails closed on a changed pre-result effect during recovery", async () => {
		const { journal, outcomes, runtime, logs, aId } =
			await effectsRun("effects-drift");
		outcomes.set("a", { status: "completed", output: { answer: "a2" } });
		outcomes.set("b", { status: "completed", output: { answer: "b2" } });
		logs.pre = "changed before result";
		const error = await runtime.drive().then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(error).toBeInstanceOf(StaticWorkflowRuntimeError);
		expect((error as StaticWorkflowRuntimeError).cause).toMatchObject({
			message: "Workflow phase or log effect changed during replay.",
		});
		const state = await journalState(journal);
		expect(state.status).toBe("failed");
		expect(state.tasks[aId]?.status).toBe("invalidated");
		expect(Object.keys(state.executions)).toHaveLength(2);
		expect(state.effects).toHaveLength(2);
	});

	it("re-executes the cause and follows a different branch end to end", async () => {
		const { journal, artifacts } = await fixture();
		const outcomes = new Map<string, FakeOutcome>([
			["a", { status: "completed", output: { branch: "x" } }],
			["bx", { status: "failed" }],
		]);
		const definition = defineWorkflow({
			meta: meta("branch-divergence"),
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({
				branch: Type.String(),
				answer: Type.String(),
			}),
			async run(ctx) {
				const a = ctx.agent("a", {
					...runtimeRequest("A"),
					outputSchema: Type.Object({ branch: Type.String() }),
				});
				const value = await ctx.result(a);
				const next =
					value.branch === "x"
						? ctx.agent("bx", runtimeRequest("BX"))
						: ctx.agent("by", runtimeRequest("BY"));
				const out = await ctx.result(next);
				return { branch: value.branch, answer: out.answer };
			},
		});
		const scheduler = generationSchedulerFor(journal, artifacts, outcomes);
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		await expect(runtime.drive()).rejects.toMatchObject({
			stage: "execution",
		});
		const failed = await journalState(journal);
		expect(failed.status).toBe("failed");
		const aId = taskIdByKey(failed, "a");
		const bxId = taskIdByKey(failed, "bx");
		expect(failed.tasks[bxId]?.status).toBe("failed");

		const closure = await appendInvalidation(journal, aId);
		expect(closure).toEqual({
			taskIds: sortedIds(aId, bxId),
			abandonedEpochs: [2],
		});
		outcomes.set("a", { status: "completed", output: { branch: "y" } });
		outcomes.set("by", {
			status: "completed",
			output: { answer: "by done" },
		});
		await expect(runtime.drive()).resolves.toMatchObject({
			status: "completed",
			value: { branch: "y", answer: "by done" },
		});

		const state = await journalState(journal);
		expect(state.status).toBe("completed");
		const byId = taskIdByKey(state, "by");
		expect(byId).not.toBe(bxId);
		// bx sits in the closure (it orders after a), so it was invalidated
		// before epoch 2 was abandoned; it stays abandoned history.
		expect(state.tasks[bxId]).toMatchObject({
			status: "invalidated",
			abandoned: true,
			currentExecutionId: deriveTaskExecutionId(journal.runId, bxId, 1),
		});
		expect(
			state.executions[deriveTaskExecutionId(journal.runId, bxId, 1)],
		).toMatchObject({ phase: "terminal", terminal: { outcome: "failed" } });
		expect(state.tasks[byId]).toMatchObject({
			status: "completed",
			currentExecutionId: deriveTaskExecutionId(journal.runId, byId, 1),
		});
		expect(state.tasks[byId]?.abandoned).toBeUndefined();
		expect(state.tasks[byId]?.task).toMatchObject({
			materializationSequence: 3,
			materializationEpoch: 3,
			epochPosition: 1,
		});
		expect(
			state.executions[deriveTaskExecutionId(journal.runId, byId, 1)]?.execution
				.generation,
		).toBe(1);
		const gen2 = deriveTaskExecutionId(journal.runId, aId, 2);
		expect(state.tasks[aId]).toMatchObject({
			status: "completed",
			currentExecutionId: gen2,
		});
		expect(state.executions[gen2]?.execution.generation).toBe(2);
		const aArtifacts = Object.values(state.artifacts)
			.filter((artifact) => artifact.producerTaskId === aId)
			.map((artifact) => artifact.producerExecutionId)
			.sort();
		expect(aArtifacts).toEqual(
			[deriveTaskExecutionId(journal.runId, aId, 1), gen2].sort(),
		);
		expect(
			state.barriers.map((barrier) => [barrier.epoch, barrier.abandoned]),
		).toEqual([
			[1, undefined],
			[2, true],
			[3, undefined],
			[4, undefined],
		]);
	});
});
