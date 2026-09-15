import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	type AgentTaskExecutionRecord,
	MAX_TASK_EXECUTION_GENERATIONS,
	type MaterializedWorkflowTask,
	type SubagentTerminalEvidence,
	type WorkflowArtifactRef,
	type WorkflowRunStatus,
	type WorkflowTaskId,
	type WorkflowTaskStatus,
} from "../src/contracts.js";
import {
	type WorkflowEventInput,
	type WorkflowStateProjection,
	WorkflowStateProjectionSchema,
} from "../src/events.js";
import {
	deriveJsonValueSha256,
	deriveSubagentOperationId,
	deriveTaskExecutionId,
	deriveWorkflowArtifactId,
} from "../src/execution.js";
import {
	deriveAgentTaskIdentity,
	type MaterializationCommit,
	WorkflowTaskMaterializer,
} from "../src/materializer.js";
import type { WorkflowJournalEvent } from "../src/persistence/journal.js";
import {
	invalidationClosure,
	reduceWorkflowEvents,
	WorkflowEventReductionError,
} from "../src/reducer.js";

const RUN_ID = "workflow_invalidation" as const;
const definitionIdentitySha256 = "a".repeat(64);
const inputSha256 = "b".repeat(64);
const planIdentitySha256 = "c".repeat(64);
const resultSha256 = "d".repeat(64);
const structuredOutputSha256 = "e".repeat(64);
const outputSchema = Type.Object({ answer: Type.String() });

function request(goal = "Answer") {
	return {
		agent: "researcher",
		task: { goal, context: [], instructions: ["Return structured output."] },
		contextMode: "fresh" as const,
		tools: ["read"],
		preloadSkills: [],
		contextScopes: ["project" as const],
		workspace: { mode: "read-only" as const, cwd: "/repo" },
		outputSchema,
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

function records(
	inputs: readonly WorkflowEventInput[],
): WorkflowJournalEvent[] {
	return inputs.map((input, index) => ({
		schema: "pi-workflow-event",
		contractRevision: 16,
		sequence: index + 1,
		eventId: `event-${index + 1}`,
		timestamp: "2026-09-01T00:00:00.000Z",
		runId: RUN_ID,
		ownerId: "test",
		leaseId: "lease-test",
		fencingGeneration: 1,
		type: input.type,
		data: input.data,
	}));
}

function reduce(
	inputs: readonly WorkflowEventInput[],
): WorkflowStateProjection {
	return reduceWorkflowEvents(records(inputs));
}

function materializer(): WorkflowTaskMaterializer {
	return new WorkflowTaskMaterializer({
		runId: RUN_ID,
		definitionIdentitySha256,
		inputSha256,
	});
}

function declaration(
	commit: MaterializationCommit,
	taskId: WorkflowTaskId,
): MaterializedWorkflowTask {
	for (const event of commit.events) {
		if (event.type === "task-declared" && event.data.task.id === taskId) {
			return event.data.task;
		}
	}
	throw new Error(`missing declaration for ${taskId}`);
}

function repositioned(
	task: MaterializedWorkflowTask,
	position: {
		materializationSequence: number;
		materializationEpoch: number;
		epochPosition: number;
	},
): MaterializedWorkflowTask {
	return { ...task, ...position };
}

function runCreated(): WorkflowEventInput {
	return {
		type: "run-created",
		data: { definitionIdentitySha256, inputSha256 },
	};
}

function runStatus(
	from: WorkflowRunStatus,
	to: WorkflowRunStatus,
): WorkflowEventInput {
	return { type: "run-status-changed", data: { from, to } };
}

function taskStatus(
	taskId: WorkflowTaskId,
	from: WorkflowTaskStatus,
	to: WorkflowTaskStatus,
): WorkflowEventInput {
	return { type: "task-status-changed", data: { taskId, from, to } };
}

function effect(ordinal: number): WorkflowEventInput {
	return {
		type: "workflow-effect",
		data: { ordinal, kind: "log", value: `effect ${ordinal}` },
	};
}

function invalidated(
	causeTaskId: WorkflowTaskId,
	taskIds: readonly WorkflowTaskId[],
	abandonedEpochs: readonly number[],
): WorkflowEventInput {
	return {
		type: "task-invalidated",
		data: {
			causeTaskId,
			taskIds: [...taskIds],
			abandonedEpochs: [...abandonedEpochs],
			reason: "re-execute",
		},
	};
}

function agentExecution(
	task: MaterializedWorkflowTask,
	generation: number,
): AgentTaskExecutionRecord {
	return {
		kind: "agent",
		id: deriveTaskExecutionId(RUN_ID, task.id, generation),
		runId: RUN_ID,
		taskId: task.id,
		generation,
		taskIdentitySha256: task.spec.identitySha256,
		operationId: deriveSubagentOperationId(RUN_ID, task.id, generation),
	};
}

function executionCreated(
	execution: AgentTaskExecutionRecord,
): WorkflowEventInput {
	return { type: "task-execution-created", data: { execution } };
}

function resultArtifact(
	taskId: WorkflowTaskId,
	producerExecutionId: string,
	sha256 = structuredOutputSha256,
): WorkflowArtifactRef {
	const input = {
		runId: RUN_ID,
		producerTaskId: taskId,
		producerExecutionId,
		output: "result" as const,
		sha256,
		schemaSha256: deriveJsonValueSha256(outputSchema),
	};
	return {
		id: deriveWorkflowArtifactId(input),
		...input,
		bytes: 18,
		mediaType: "application/json",
	};
}

function runOutputArtifact(): WorkflowArtifactRef {
	const input = {
		runId: RUN_ID,
		sha256: "9".repeat(64),
		schemaSha256: "8".repeat(64),
	};
	return {
		id: deriveWorkflowArtifactId(input),
		...input,
		bytes: 2,
		mediaType: "application/json",
	};
}

function completedEvidence(): SubagentTerminalEvidence {
	return {
		kind: "subagent",
		attemptOrdinal: 1,
		resultSha256,
		status: "completed",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: 0.01,
		},
		usageComplete: true,
		runtimeMs: 1000,
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
		structuredOutputSha256,
	};
}

function failedEvidence(): SubagentTerminalEvidence {
	return {
		kind: "subagent",
		attemptOrdinal: 1,
		resultSha256: "6".repeat(64),
		status: "failed",
		usage: {
			input: 20,
			output: 4,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 24,
			cost: 0.02,
		},
		usageComplete: true,
		runtimeMs: 500,
		failure: {
			code: "provider-transient",
			origin: "provider",
			retry: "backoff",
			message: "Provider timed out.",
			guidance: "Retry later.",
		},
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
	};
}

function childIds(execution: AgentTaskExecutionRecord): {
	subagentRunId: string;
	subagentAttemptId: string;
} {
	const stem = `${execution.taskId.slice(5, 13)}g${execution.generation}`;
	return { subagentRunId: `run_${stem}`, subagentAttemptId: `attempt_${stem}` };
}

/**
 * The agent execution ladder from a `created` execution on a `ready` task
 * through `task-execution-terminal` and the matching task status change.
 */
function executionLadder(
	execution: AgentTaskExecutionRecord,
	outcome: "completed" | "failed",
): WorkflowEventInput[] {
	const child = childIds(execution);
	const evidence =
		outcome === "completed" ? completedEvidence() : failedEvidence();
	const output = resultArtifact(execution.taskId, execution.id);
	const imported: WorkflowEventInput[] =
		outcome === "completed"
			? [
					{ type: "artifact-declared", data: { artifact: output } },
					{
						type: "task-execution-artifact-imported",
						data: {
							executionId: execution.id,
							subagentRunId: child.subagentRunId,
							artifactId: output.id,
							sourceResultSha256: resultSha256,
						},
					},
				]
			: [];
	return [
		{
			type: "task-execution-preflighted",
			data: {
				executionId: execution.id,
				operationId: execution.operationId,
				preflightId: `preflight-${execution.generation}`,
				planIdentitySha256,
				plannedSubagentRunId: child.subagentRunId,
				plannedSubagentAttemptId: child.subagentAttemptId,
				expiresAt: "2026-09-01T01:00:00.000Z",
			},
		},
		{
			type: "task-execution-launch-intended",
			data: {
				executionId: execution.id,
				operationId: execution.operationId,
				preflightId: `preflight-${execution.generation}`,
				planIdentitySha256,
			},
		},
		{
			type: "task-execution-launch-receipted",
			data: {
				executionId: execution.id,
				operationId: execution.operationId,
				subagentRunId: child.subagentRunId,
				subagentAttemptId: child.subagentAttemptId,
				status: "active",
			},
		},
		taskStatus(execution.taskId, "ready", "running"),
		{
			type: "task-execution-child-observed",
			data: {
				executionId: execution.id,
				subagentRunId: child.subagentRunId,
				subagentAttemptId: child.subagentAttemptId,
				status: outcome,
			},
		},
		{
			type: "task-execution-child-settled",
			data: { executionId: execution.id, evidence },
		},
		...imported,
		{
			type: "task-execution-release-intended",
			data: { executionId: execution.id, subagentRunId: child.subagentRunId },
		},
		{
			type: "task-execution-released",
			data: {
				executionId: execution.id,
				subagentRunId: child.subagentRunId,
				status: outcome,
			},
		},
		{
			type: "task-execution-terminal",
			data: { executionId: execution.id, outcome, evidence },
		},
		taskStatus(execution.taskId, "running", outcome),
	];
}

/** Epoch 1 declares a, d, and e (e consumes a's result); barrier 1 exposes a. */
function threeEpochGraph() {
	const m = materializer();
	const a = m.agent("a", request("A"));
	const d = m.agent("d", request("D"));
	const e = m.agent("e", { ...request("E"), inputs: { a: a.output } });
	const first = m.closeEpoch("result", [a]);
	const b = m.agent("b", request("B"));
	const second = m.closeEpoch("result", [b]);
	const c = m.agent("c", request("C"));
	const third = m.closeEpoch("final", [c]);
	const ids = {
		a: a.ref.taskId,
		b: b.ref.taskId,
		c: c.ref.taskId,
		d: d.ref.taskId,
		e: e.ref.taskId,
	};
	const events: WorkflowEventInput[] = [
		runCreated(),
		effect(1),
		...first.events,
		effect(2),
		...second.events,
		effect(3),
		...third.events,
		effect(4),
		runStatus("created", "running"),
	];
	return {
		ids,
		events,
		tasks: {
			a: declaration(first, ids.a),
			b: declaration(second, ids.b),
			c: declaration(third, ids.c),
		},
	};
}

/** One required agent task exposed by a final barrier. */
function singleTaskGraph() {
	const m = materializer();
	const handle = m.agent("solo", request("Solo"));
	const commit = m.closeEpoch("final", [handle]);
	const task = declaration(commit, handle.ref.taskId);
	return {
		task,
		commitEvents: commit.events,
		events: [
			runCreated(),
			...commit.events,
			runStatus("created", "running"),
			taskStatus(task.id, "pending", "ready"),
		] as WorkflowEventInput[],
	};
}

/** A single task that ran generation 1 to `outcome` with the run still running. */
function generationOne(outcome: "completed" | "failed") {
	const graph = singleTaskGraph();
	const execution = agentExecution(graph.task, 1);
	return {
		...graph,
		execution,
		events: [
			...graph.events,
			executionCreated(execution),
			...executionLadder(execution, outcome),
		] as WorkflowEventInput[],
	};
}

/** Generation 1 failed, invalidated, re-materialized, and ready again. */
function readyForGenerationTwo() {
	const base = generationOne("failed");
	return {
		...base,
		second: agentExecution(base.task, 2),
		events: [
			...base.events,
			invalidated(base.task.id, [base.task.id], []),
			taskStatus(base.task.id, "invalidated", "pending"),
			taskStatus(base.task.id, "pending", "ready"),
		] as WorkflowEventInput[],
	};
}

/** Epoch 1 exposes a by a result barrier; epoch 2 declares b under a final barrier. */
function twoEpochGraph() {
	const m = materializer();
	const a = m.agent("a", request("A"));
	const first = m.closeEpoch("result", [a]);
	const b = m.agent("b", request("B"));
	const second = m.closeEpoch("final", [b]);
	const taskA = declaration(first, a.ref.taskId);
	const taskB = declaration(second, b.ref.taskId);
	return {
		taskA,
		taskB,
		events: [
			runCreated(),
			...first.events,
			...second.events,
			runStatus("created", "running"),
			invalidated(taskA.id, [taskA.id, taskB.id], [2]),
		] as WorkflowEventInput[],
	};
}

function legacyArtifactId(artifact: WorkflowArtifactRef): string {
	// Revision 14 derivation: the producer execution is absent from the digest.
	const digest = createHash("sha256")
		.update(
			JSON.stringify({
				output: artifact.output,
				producerTaskId: artifact.producerTaskId,
				runId: artifact.runId,
				schemaSha256: artifact.schemaSha256,
				sha256: artifact.sha256,
			}),
		)
		.digest("hex");
	return `artifact_${digest}`;
}

function abandonedIds(state: WorkflowStateProjection): {
	tasks: WorkflowTaskId[];
	barriers: number[];
	effects: number[];
} {
	return {
		tasks: Object.values(state.tasks)
			.filter((task) => task.abandoned === true)
			.map((task) => task.task.id)
			.sort(),
		barriers: state.barriers
			.filter((barrier) => barrier.abandoned === true)
			.map((barrier) => barrier.epoch),
		effects: state.effects
			.filter((entry) => entry.abandoned === true)
			.map((entry) => entry.ordinal),
	};
}

describe("invalidation closure", () => {
	it("returns the cause and transitive order and data dependents sorted", () => {
		const graph = threeEpochGraph();
		const state = reduce(graph.events);
		expect(invalidationClosure(state, graph.ids.a)).toEqual({
			taskIds: [graph.ids.a, graph.ids.b, graph.ids.c, graph.ids.e].sort(),
			abandonedEpochs: [2, 3],
		});
		expect(invalidationClosure(state, graph.ids.b)).toEqual({
			taskIds: [graph.ids.b, graph.ids.c].sort(),
			abandonedEpochs: [3],
		});
		expect(invalidationClosure(state, graph.ids.d)).toEqual({
			taskIds: [graph.ids.d],
			abandonedEpochs: [],
		});
	});

	it("excludes already-invalidated dependents from a later closure", () => {
		const graph = threeEpochGraph();
		const state = reduce([
			...graph.events,
			invalidated(graph.ids.c, [graph.ids.c], []),
		]);
		expect(state.tasks[graph.ids.c]?.status).toBe("invalidated");
		expect(invalidationClosure(state, graph.ids.a)).toEqual({
			taskIds: [graph.ids.a, graph.ids.b, graph.ids.e].sort(),
			abandonedEpochs: [2, 3],
		});
	});

	it("throws for an unknown cause and for an already-invalidated cause", () => {
		const graph = threeEpochGraph();
		const state = reduce([
			...graph.events,
			invalidated(graph.ids.c, [graph.ids.c], []),
		]);
		expect(() => invalidationClosure(state, `task_${"0".repeat(64)}`)).toThrow(
			"invalidation cause task is unknown",
		);
		expect(() => invalidationClosure(state, graph.ids.c)).toThrow(
			"invalidation cause is already invalidated",
		);
		expect(() =>
			reduce([
				...graph.events,
				invalidated(`task_${"0".repeat(64)}`, [graph.ids.a], []),
			]),
		).toThrow("invalidation cause task is unknown");
		expect(() =>
			reduce([
				...graph.events,
				invalidated(graph.ids.c, [graph.ids.c], []),
				invalidated(graph.ids.c, [graph.ids.c], []),
			]),
		).toThrow("invalidation cause is already invalidated");
	});

	it("rejects task sets that omit a dependent or include a stranger", () => {
		const graph = threeEpochGraph();
		const closure = [graph.ids.a, graph.ids.b, graph.ids.c, graph.ids.e];
		expect(() =>
			reduce([
				...graph.events,
				invalidated(
					graph.ids.a,
					[graph.ids.a, graph.ids.b, graph.ids.c],
					[2, 3],
				),
			]),
		).toThrow("invalidation does not cover the exact dependent closure");
		expect(() =>
			reduce([
				...graph.events,
				invalidated(graph.ids.a, [...closure, graph.ids.d], [2, 3]),
			]),
		).toThrow("invalidation does not cover the exact dependent closure");
		const state = reduce([
			...graph.events,
			invalidated(graph.ids.a, [...closure].reverse(), [2, 3]),
		]);
		for (const taskId of closure) {
			expect(state.tasks[taskId]?.status).toBe("invalidated");
		}
		expect(state.tasks[graph.ids.d]?.status).toBe("pending");
	});

	it("rejects abandoned epochs that are missing, partial, extra, or unordered", () => {
		const graph = threeEpochGraph();
		const closure = [graph.ids.a, graph.ids.b, graph.ids.c, graph.ids.e];
		for (const epochs of [[], [2], [3], [2, 3, 4], [3, 2]]) {
			expect(() =>
				reduce([...graph.events, invalidated(graph.ids.a, closure, epochs)]),
			).toThrow("invalidation does not cover the exact abandoned epochs");
		}
		expect(() =>
			reduce([...graph.events, invalidated(graph.ids.d, [graph.ids.d], [2])]),
		).toThrow("invalidation does not cover the exact abandoned epochs");
	});
});

describe("abandonment", () => {
	it("abandons every epoch after the first barrier exposing the closure", () => {
		const graph = threeEpochGraph();
		const state = reduce([
			...graph.events,
			invalidated(
				graph.ids.a,
				[graph.ids.a, graph.ids.b, graph.ids.c, graph.ids.e],
				[2, 3],
			),
		]);
		expect(abandonedIds(state)).toEqual({
			tasks: [graph.ids.b, graph.ids.c].sort(),
			barriers: [2, 3],
			effects: [2, 3, 4],
		});
		expect(state.barriers.map((barrier) => barrier.epoch)).toEqual([1, 2, 3]);
		expect(state.tasks[graph.ids.a]?.abandoned).toBeUndefined();
		expect(state.tasks[graph.ids.d]?.abandoned).toBeUndefined();
		expect(state.tasks[graph.ids.e]?.abandoned).toBeUndefined();
		expect(state.tasks[graph.ids.b]).toMatchObject({
			status: "invalidated",
			committed: true,
			abandoned: true,
		});
		expect(state.currentEpoch).toBe(4);
		expect(state.effects).toHaveLength(4);
	});

	it("abandons only the epochs after the exposing barrier of a later cause", () => {
		const graph = threeEpochGraph();
		const state = reduce([
			...graph.events,
			invalidated(graph.ids.b, [graph.ids.b, graph.ids.c], [3]),
		]);
		expect(abandonedIds(state)).toEqual({
			tasks: [graph.ids.c],
			barriers: [3],
			effects: [3, 4],
		});
		expect(state.tasks[graph.ids.b]).toMatchObject({
			status: "invalidated",
			committed: true,
		});
		expect(state.tasks[graph.ids.b]?.abandoned).toBeUndefined();
		expect(state.tasks[graph.ids.a]?.status).toBe("pending");
	});

	it("abandons nothing when no barrier exposes the closure", () => {
		const graph = threeEpochGraph();
		const unexposed = reduce([
			...graph.events,
			invalidated(graph.ids.d, [graph.ids.d], []),
		]);
		expect(abandonedIds(unexposed)).toEqual({
			tasks: [],
			barriers: [],
			effects: [],
		});
		expect(unexposed.tasks[graph.ids.d]?.status).toBe("invalidated");
	});

	it("abandons no epochs or tasks when only the last barrier exposes the closure", () => {
		const graph = threeEpochGraph();
		const last = reduce([
			...graph.events,
			invalidated(graph.ids.c, [graph.ids.c], []),
		]);
		expect(abandonedIds(last).tasks).toEqual([]);
		expect(abandonedIds(last).barriers).toEqual([]);
		expect(last.tasks[graph.ids.c]?.status).toBe("invalidated");
		expect(
			last.effects
				.filter((entry) => entry.ordinal <= 3)
				.map((entry) => entry.abandoned),
		).toEqual([undefined, undefined, undefined]);
	});

	it("abandons effects recorded after the exposing barrier even when it is the last barrier", () => {
		// Spec: every effect with sequence > B.sequence is abandoned, where B is
		// the first on-path barrier exposing the closure. Effect 4 was recorded
		// after the final barrier that exposes c, so it depends on c's result.
		const graph = threeEpochGraph();
		const last = reduce([
			...graph.events,
			invalidated(graph.ids.c, [graph.ids.c], []),
		]);
		const finalBarrier = last.barriers.find((barrier) => barrier.epoch === 3);
		const trailing = last.effects.find((entry) => entry.ordinal === 4);
		if (!finalBarrier || !trailing) throw new Error("missing fixtures");
		expect(trailing.sequence).toBeGreaterThan(finalBarrier.sequence);
		expect(abandonedIds(last).effects).toEqual([4]);
	});

	it("includes abandoned non-invalidated dependents in a later closure", () => {
		// g is declared in epoch 2 and depends only on d (declared in epoch 1 and
		// never exposed). Invalidating a abandons epoch 2, so g is abandoned but
		// stays pending; invalidating d must then still cover g.
		const graph = threeEpochGraph();
		const separate = materializer();
		const dHandle = separate.agent("d", request("D"));
		const gHandle = separate.agent("g", {
			...request("G"),
			after: [dHandle.ref],
		});
		const taskG = repositioned(
			declaration(separate.closeEpoch("final", [gHandle]), gHandle.ref.taskId),
			{ materializationSequence: 4, materializationEpoch: 2, epochPosition: 1 },
		);
		const m = materializer();
		const a = m.agent("a", request("A"));
		const d = m.agent("d", request("D"));
		const e = m.agent("e", { ...request("E"), inputs: { a: a.output } });
		const first = m.closeEpoch("result", [a]);
		expect(d.ref.taskId).toBe(graph.ids.d);
		expect(e.ref.taskId).toBe(graph.ids.e);
		const events: WorkflowEventInput[] = [
			runCreated(),
			...first.events,
			{ type: "task-declared", data: { task: taskG } },
			{
				type: "barrier-reached",
				data: { epoch: 2, kind: "final", taskIds: [taskG.id] },
			},
			runStatus("created", "running"),
			invalidated(graph.ids.a, [graph.ids.a, graph.ids.e].sort(), [2]),
		];
		const state = reduce(events);
		expect(state.tasks[taskG.id]).toMatchObject({
			status: "pending",
			abandoned: true,
		});
		expect(invalidationClosure(state, graph.ids.d)).toEqual({
			taskIds: [graph.ids.d, taskG.id].sort(),
			abandonedEpochs: [],
		});
		expect(() =>
			reduce([...events, invalidated(graph.ids.d, [graph.ids.d], [])]),
		).toThrow("invalidation does not cover the exact dependent closure");
		const after = reduce([
			...events,
			invalidated(graph.ids.d, [graph.ids.d, taskG.id].sort(), []),
		]);
		expect(after.tasks[taskG.id]).toMatchObject({
			status: "invalidated",
			abandoned: true,
		});
		expect(after.tasks[graph.ids.d]?.status).toBe("invalidated");
	});

	it("computes the exposing barrier among on-path barriers only", () => {
		// After epochs 2 and 3 are abandoned, a fresh epoch 4 barrier exposes d;
		// invalidating d must not abandon anything (no later on-path barrier).
		const graph = threeEpochGraph();
		const state = reduce([
			...graph.events,
			invalidated(
				graph.ids.a,
				[graph.ids.a, graph.ids.b, graph.ids.c, graph.ids.e],
				[2, 3],
			),
			{
				type: "barrier-reached",
				data: { epoch: 4, kind: "result", taskIds: [graph.ids.d] },
			},
			invalidated(graph.ids.d, [graph.ids.d], []),
		]);
		expect(abandonedIds(state)).toEqual({
			tasks: [graph.ids.b, graph.ids.c].sort(),
			barriers: [2, 3],
			effects: [2, 3, 4],
		});
		expect(state.currentEpoch).toBe(5);
	});
});

describe("run-status admission", () => {
	function completedRun() {
		const base = generationOne("completed");
		const output = runOutputArtifact();
		return {
			...base,
			events: [
				...base.events,
				runStatus("running", "finalizing"),
				{ type: "artifact-declared", data: { artifact: output } },
				{ type: "run-output-committed", data: { artifactId: output.id } },
				runStatus("finalizing", "completed"),
			] as WorkflowEventInput[],
		};
	}

	it("rejects invalidation on a completed run", () => {
		const run = completedRun();
		expect(reduce(run.events).status).toBe("completed");
		expect(() =>
			reduce([...run.events, invalidated(run.task.id, [run.task.id], [])]),
		).toThrow("workflow run status does not admit invalidation");
	});

	it("rejects invalidation on a cancelled run", () => {
		const graph = singleTaskGraph();
		const events: WorkflowEventInput[] = [
			runCreated(),
			...graph.commitEvents,
			runStatus("created", "running"),
			runStatus("running", "stopping"),
			taskStatus(graph.task.id, "pending", "cancelled"),
			runStatus("stopping", "cancelled"),
		];
		expect(reduce(events).status).toBe("cancelled");
		expect(() =>
			reduce([...events, invalidated(graph.task.id, [graph.task.id], [])]),
		).toThrow("workflow run status does not admit invalidation");
	});

	it("rejects invalidation while any current execution is non-terminal", () => {
		const graph = singleTaskGraph();
		const execution = agentExecution(graph.task, 1);
		expect(() =>
			reduce([
				...graph.events,
				executionCreated(execution),
				invalidated(graph.task.id, [graph.task.id], []),
			]),
		).toThrow("workflow run has active task executions");
		// A launched execution on another task also blocks invalidation of a task
		// that has no execution of its own.
		const m = materializer();
		const x = m.agent("x", request("X"));
		const y = m.agent("y", request("Y"));
		const commit = m.closeEpoch("final", [x, y]);
		const xTask = declaration(commit, x.ref.taskId);
		const xExecution = agentExecution(xTask, 1);
		expect(() =>
			reduce([
				runCreated(),
				...commit.events,
				runStatus("created", "running"),
				taskStatus(xTask.id, "pending", "ready"),
				executionCreated(xExecution),
				...executionLadder(xExecution, "failed").slice(0, 4),
				invalidated(y.ref.taskId, [y.ref.taskId], []),
			]),
		).toThrow("workflow run has active task executions");
	});

	it("accepts invalidation on a failed run and recovery back to running", () => {
		const base = generationOne("failed");
		const failed: WorkflowEventInput[] = [
			...base.events,
			runStatus("running", "failed"),
		];
		expect(() => reduce([...failed, runStatus("failed", "running")])).toThrow(
			"recovery requires invalidated work",
		);
		const state = reduce([
			...failed,
			invalidated(base.task.id, [base.task.id], []),
			runStatus("failed", "running"),
		]);
		expect(state.status).toBe("running");
		expect(state.tasks[base.task.id]?.status).toBe("invalidated");
	});

	it("accepts invalidation on an interrupted run and recovery back to running", () => {
		const base = generationOne("failed");
		const interrupted: WorkflowEventInput[] = [
			...base.events,
			runStatus("running", "interrupted"),
		];
		expect(() =>
			reduce([...interrupted, runStatus("interrupted", "running")]),
		).toThrow("recovery requires invalidated work");
		const state = reduce([
			...interrupted,
			invalidated(base.task.id, [base.task.id], []),
			runStatus("interrupted", "running"),
		]);
		expect(state.status).toBe("running");
	});

	it("does not count abandoned invalidated tasks as recoverable work", () => {
		const graph = threeEpochGraph();
		const closure = [graph.ids.a, graph.ids.b, graph.ids.c, graph.ids.e];
		const events: WorkflowEventInput[] = [
			...graph.events,
			invalidated(graph.ids.a, closure, [2, 3]),
			taskStatus(graph.ids.a, "invalidated", "pending"),
			taskStatus(graph.ids.e, "invalidated", "pending"),
			runStatus("running", "failed"),
		];
		const state = reduce(events);
		expect(state.tasks[graph.ids.b]).toMatchObject({
			status: "invalidated",
			abandoned: true,
		});
		expect(() => reduce([...events, runStatus("failed", "running")])).toThrow(
			"recovery requires invalidated work",
		);
	});
});

describe("re-materialization", () => {
	it("accepts invalidated -> pending when the current execution is terminal", () => {
		const base = generationOne("failed");
		const state = reduce([
			...base.events,
			invalidated(base.task.id, [base.task.id], []),
			taskStatus(base.task.id, "invalidated", "pending"),
		]);
		expect(state.tasks[base.task.id]).toMatchObject({
			status: "pending",
			committed: true,
		});
		expect(state.tasks[base.task.id]?.currentExecutionId).toBeUndefined();
		expect(state.executions[base.execution.id]?.phase).toBe("terminal");
	});

	it("accepts invalidated -> pending when the task has no execution", () => {
		const graph = threeEpochGraph();
		const state = reduce([
			...graph.events,
			invalidated(graph.ids.d, [graph.ids.d], []),
			taskStatus(graph.ids.d, "invalidated", "pending"),
		]);
		expect(state.tasks[graph.ids.d]?.status).toBe("pending");
		expect(state.tasks[graph.ids.d]?.currentExecutionId).toBeUndefined();
	});

	it("rejects any status change on an abandoned task", () => {
		const graph = threeEpochGraph();
		const events: WorkflowEventInput[] = [
			...graph.events,
			invalidated(
				graph.ids.a,
				[graph.ids.a, graph.ids.b, graph.ids.c, graph.ids.e],
				[2, 3],
			),
		];
		expect(() =>
			reduce([...events, taskStatus(graph.ids.b, "invalidated", "pending")]),
		).toThrow("abandoned task may not change status");
	});

	it("rejects invalidated -> pending while the current execution is non-terminal", () => {
		const graph = singleTaskGraph();
		const execution = agentExecution(graph.task, 1);
		const events: WorkflowEventInput[] = [
			...graph.events,
			executionCreated(execution),
			taskStatus(graph.task.id, "ready", "invalidated"),
		];
		expect(reduce(events).tasks[graph.task.id]?.status).toBe("invalidated");
		expect(() =>
			reduce([...events, taskStatus(graph.task.id, "invalidated", "pending")]),
		).toThrow("re-materialization requires a terminal execution");
	});

	it("rejects a pending transition from any status other than invalidated", () => {
		const graph = singleTaskGraph();
		const events: WorkflowEventInput[] = [
			runCreated(),
			...graph.commitEvents,
			runStatus("created", "running"),
			taskStatus(graph.task.id, "pending", "blocked"),
		];
		expect(reduce(events).tasks[graph.task.id]?.status).toBe("blocked");
		expect(() =>
			reduce([...events, taskStatus(graph.task.id, "blocked", "pending")]),
		).toThrow("re-materialization requires a terminal execution");
	});
});

describe("execution generations", () => {
	it("accepts generation 2 after a terminal generation 1 and invalidation", () => {
		const ready = readyForGenerationTwo();
		const before = reduce(ready.events);
		const state = reduce([...ready.events, executionCreated(ready.second)]);
		expect(ready.second.id).not.toBe(ready.execution.id);
		expect(state.tasks[ready.task.id]).toMatchObject({
			status: "ready",
			currentExecutionId: ready.second.id,
		});
		expect(state.executions[ready.second.id]).toMatchObject({
			phase: "created",
			execution: { generation: 2, id: ready.second.id },
		});
		expect(state.executions[ready.execution.id]).toEqual(
			before.executions[ready.execution.id],
		);
		expect(state.executions[ready.execution.id]?.terminal?.outcome).toBe(
			"failed",
		);
		expect(Object.keys(state.executions)).toHaveLength(2);
	});

	it("rejects a skipped or repeated generation", () => {
		const ready = readyForGenerationTwo();
		expect(() =>
			reduce([
				...ready.events,
				executionCreated(agentExecution(ready.task, 3)),
			]),
		).toThrow("task execution generation is not contiguous");
		expect(() =>
			reduce([
				...ready.events,
				executionCreated(ready.second),
				executionCreated(ready.second),
			]),
		).toThrow(/not contiguous|duplicate/);
		expect(() =>
			reduce([...ready.events, executionCreated(ready.execution)]),
		).toThrow(/not contiguous|duplicate/);
	});

	it("rejects generation 2 while generation 1 is non-terminal", () => {
		const graph = singleTaskGraph();
		const first = agentExecution(graph.task, 1);
		const second = agentExecution(graph.task, 2);
		expect(() =>
			reduce([
				...graph.events,
				executionCreated(first),
				executionCreated(second),
			]),
		).toThrow("task execution supersedes an active execution");
		// Preflighted and launch-intended leave the task ready but the execution
		// active.
		const settled = executionLadder(first, "failed");
		expect(() =>
			reduce([
				...graph.events,
				executionCreated(first),
				...settled.slice(0, 2),
				executionCreated(second),
			]),
		).toThrow("task execution supersedes an active execution");
	});

	it("bounds generations at MAX_TASK_EXECUTION_GENERATIONS", () => {
		const graph = singleTaskGraph();
		const events: WorkflowEventInput[] = [...graph.events];
		for (
			let generation = 1;
			generation <= MAX_TASK_EXECUTION_GENERATIONS;
			generation += 1
		) {
			if (generation > 1) {
				events.push(
					invalidated(graph.task.id, [graph.task.id], []),
					taskStatus(graph.task.id, "invalidated", "pending"),
					taskStatus(graph.task.id, "pending", "ready"),
				);
			}
			const execution = agentExecution(graph.task, generation);
			events.push(
				executionCreated(execution),
				...executionLadder(execution, "failed"),
			);
		}
		const state = reduce(events);
		expect(MAX_TASK_EXECUTION_GENERATIONS).toBe(16);
		expect(Object.keys(state.executions)).toHaveLength(
			MAX_TASK_EXECUTION_GENERATIONS,
		);
		const last = deriveTaskExecutionId(
			RUN_ID,
			graph.task.id,
			MAX_TASK_EXECUTION_GENERATIONS,
		);
		expect(state.tasks[graph.task.id]).toMatchObject({
			status: "failed",
			currentExecutionId: last,
		});
		expect(state.executions[last]).toMatchObject({
			phase: "terminal",
			execution: { generation: MAX_TASK_EXECUTION_GENERATIONS },
		});

		// The bound is enforced at invalidation: a task that has run its final
		// generation may not be invalidated again, so no further generation can
		// ever be created for it.
		expect(() => invalidationClosure(state, graph.task.id)).toThrow(
			"task execution generation bound exceeded",
		);
		const overflowInvalidation = invalidated(
			graph.task.id,
			[graph.task.id],
			[],
		);
		expect(() => reduce([...events, overflowInvalidation])).toThrow(
			"task execution generation bound exceeded",
		);
		expect(() => reduce([...events, overflowInvalidation])).toThrow(
			WorkflowEventReductionError,
		);
		expect(() =>
			reduce([
				...events,
				overflowInvalidation,
				taskStatus(graph.task.id, "invalidated", "pending"),
				taskStatus(graph.task.id, "pending", "ready"),
				executionCreated(
					agentExecution(graph.task, MAX_TASK_EXECUTION_GENERATIONS + 1),
				),
			]),
		).toThrow("task execution generation bound exceeded");
		// Generation 17 is unrepresentable in the event schema regardless.
		expect(() =>
			reduce([
				...events,
				executionCreated(
					agentExecution(graph.task, MAX_TASK_EXECUTION_GENERATIONS + 1),
				),
			]),
		).toThrow("event payload does not match a known workflow event");
	});

	it("rejects an invalidation whose closure holds a task at the generation bound", () => {
		// a completed once; its dependent b (ordered after a by the result
		// barrier) ran every generation. Invalidating a would re-execute b.
		const m = materializer();
		const a = m.agent("a", request("A"));
		const first = m.closeEpoch("result", [a]);
		const b = m.agent("b", request("B"));
		const second = m.closeEpoch("final", [b]);
		const taskA = declaration(first, a.ref.taskId);
		const taskB = declaration(second, b.ref.taskId);
		const executionA = agentExecution(taskA, 1);
		const events: WorkflowEventInput[] = [
			runCreated(),
			...first.events,
			...second.events,
			runStatus("created", "running"),
			taskStatus(taskA.id, "pending", "ready"),
			executionCreated(executionA),
			...executionLadder(executionA, "completed"),
			taskStatus(taskB.id, "pending", "ready"),
		];
		for (
			let generation = 1;
			generation <= MAX_TASK_EXECUTION_GENERATIONS;
			generation += 1
		) {
			if (generation > 1) {
				events.push(
					invalidated(taskB.id, [taskB.id], []),
					taskStatus(taskB.id, "invalidated", "pending"),
					taskStatus(taskB.id, "pending", "ready"),
				);
			}
			const execution = agentExecution(taskB, generation);
			events.push(
				executionCreated(execution),
				...executionLadder(execution, "failed"),
			);
		}
		const state = reduce(events);
		expect(state.tasks[taskA.id]?.status).toBe("completed");
		expect(state.tasks[taskB.id]?.status).toBe("failed");
		expect(
			Object.values(state.executions).filter(
				(execution) => execution.execution.taskId === taskB.id,
			),
		).toHaveLength(MAX_TASK_EXECUTION_GENERATIONS);

		expect(() => invalidationClosure(state, taskA.id)).toThrow(
			"task execution generation bound exceeded",
		);
		expect(() =>
			reduce([...events, invalidated(taskA.id, [taskA.id, taskB.id], [])]),
		).toThrow("task execution generation bound exceeded");
		// The bound is checked on the computed closure before the declared task
		// set is compared, so omitting b changes nothing.
		expect(() =>
			reduce([...events, invalidated(taskA.id, [taskA.id], [])]),
		).toThrow("task execution generation bound exceeded");

		// A cause whose closure holds no task at the bound is still admitted:
		// the bound is a property of the closure, not of the run.
		const c = materializer();
		const soloA = c.agent("a", request("A"));
		const soloCommit = c.closeEpoch("final", [soloA]);
		const soloTask = declaration(soloCommit, soloA.ref.taskId);
		const soloExecution = agentExecution(soloTask, 1);
		const soloState = reduce([
			runCreated(),
			...soloCommit.events,
			runStatus("created", "running"),
			taskStatus(soloTask.id, "pending", "ready"),
			executionCreated(soloExecution),
			...executionLadder(soloExecution, "completed"),
		]);
		expect(invalidationClosure(soloState, soloTask.id)).toEqual({
			taskIds: [soloTask.id],
			abandonedEpochs: [],
		});
	});
});

describe("artifacts per execution", () => {
	function twoReadyTasks() {
		const m = materializer();
		const x = m.agent("x", request("X"));
		const y = m.agent("y", request("Y"));
		const commit = m.closeEpoch("final", [x, y]);
		const xTask = declaration(commit, x.ref.taskId);
		const yTask = declaration(commit, y.ref.taskId);
		const xExecution = agentExecution(xTask, 1);
		const yExecution = agentExecution(yTask, 1);
		return {
			xTask,
			yTask,
			xExecution,
			yExecution,
			events: [
				runCreated(),
				...commit.events,
				runStatus("created", "running"),
				taskStatus(xTask.id, "pending", "ready"),
				taskStatus(yTask.id, "pending", "ready"),
				executionCreated(xExecution),
				executionCreated(yExecution),
			] as WorkflowEventInput[],
		};
	}

	it("requires the producer execution to belong to the producer task", () => {
		const setup = twoReadyTasks();
		expect(() =>
			reduce([
				...setup.events,
				{
					type: "artifact-declared",
					data: {
						artifact: resultArtifact(setup.xTask.id, setup.yExecution.id),
					},
				},
			]),
		).toThrow("artifact producer execution does not match");
		expect(() =>
			reduce([
				...setup.events,
				{
					type: "artifact-declared",
					data: {
						artifact: resultArtifact(
							setup.xTask.id,
							deriveTaskExecutionId(RUN_ID, setup.xTask.id, 2),
						),
					},
				},
			]),
		).toThrow("artifact producer execution does not match");
	});

	it("rejects a producer without its execution and an execution without its producer", () => {
		const setup = twoReadyTasks();
		const full = resultArtifact(setup.xTask.id, setup.xExecution.id);
		const { producerExecutionId: _execution, ...withoutExecution } = full;
		expect(() =>
			reduce([
				...setup.events,
				{ type: "artifact-declared", data: { artifact: withoutExecution } },
			]),
		).toThrow(
			"artifact producer, execution, and output identity must appear together",
		);
		const {
			producerTaskId: _producer,
			output: _output,
			...withoutProducer
		} = full;
		expect(() =>
			reduce([
				...setup.events,
				{ type: "artifact-declared", data: { artifact: withoutProducer } },
			]),
		).toThrow(
			"artifact producer, execution, and output identity must appear together",
		);
	});

	it("rejects an artifact id derived without the producer execution", () => {
		const setup = twoReadyTasks();
		const full = resultArtifact(setup.xTask.id, setup.xExecution.id);
		expect(() =>
			reduce([
				...setup.events,
				{
					type: "artifact-declared",
					data: { artifact: { ...full, id: legacyArtifactId(full) } },
				},
			]),
		).toThrow("artifact identity is not deterministic");
		const other = resultArtifact(
			setup.xTask.id,
			deriveTaskExecutionId(RUN_ID, setup.xTask.id, 2),
		);
		expect(() =>
			reduce([
				...setup.events,
				{
					type: "artifact-declared",
					data: { artifact: { ...full, id: other.id } },
				},
			]),
		).toThrow("artifact identity is not deterministic");
	});

	it("accepts one result per execution and rejects a second for the same execution", () => {
		const ready = readyForGenerationTwo();
		const first = resultArtifact(ready.task.id, ready.execution.id);
		const second = resultArtifact(ready.task.id, ready.second.id);
		const events: WorkflowEventInput[] = [
			...ready.events,
			executionCreated(ready.second),
			{ type: "artifact-declared", data: { artifact: first } },
			{ type: "artifact-declared", data: { artifact: second } },
		];
		const state = reduce(events);
		expect(first.id).not.toBe(second.id);
		expect(state.artifacts[first.id]).toEqual(first);
		expect(state.artifacts[second.id]).toEqual(second);
		expect(() =>
			reduce([
				...events,
				{
					type: "artifact-declared",
					data: {
						artifact: resultArtifact(
							ready.task.id,
							ready.second.id,
							"f".repeat(64),
						),
					},
				},
			]),
		).toThrow("artifact output identity is ambiguous");
	});

	it("does not let a generation-1 artifact satisfy generation 2", () => {
		const base = generationOne("completed");
		const second = agentExecution(base.task, 2);
		const firstArtifact = resultArtifact(base.task.id, base.execution.id);
		const events: WorkflowEventInput[] = [
			...base.events,
			invalidated(base.task.id, [base.task.id], []),
			taskStatus(base.task.id, "invalidated", "pending"),
			taskStatus(base.task.id, "pending", "ready"),
			executionCreated(second),
		];
		const state = reduce(events);
		expect(state.artifacts[firstArtifact.id]).toEqual(firstArtifact);
		expect(state.tasks[base.task.id]?.currentExecutionId).toBe(second.id);
		// The generation-1 result may not be imported into generation 2.
		const ladder = executionLadder(second, "completed");
		const importEvent = ladder[7];
		if (importEvent?.type !== "task-execution-artifact-imported") {
			throw new Error("unexpected ladder shape");
		}
		expect(() =>
			reduce([
				...events,
				...ladder.slice(0, 6),
				{
					type: "task-execution-artifact-imported",
					data: { ...importEvent.data, artifactId: firstArtifact.id },
				},
			]),
		).toThrow("task execution artifact import is invalid");
		// Completion of generation 2 requires its own evidence; the generation-1
		// artifact and evidence do not carry over to the current execution.
		expect(() =>
			reduce([...events, taskStatus(base.task.id, "ready", "completed")]),
		).toThrow("task terminal status lacks matching execution evidence");
		// A full generation-2 ladder binds its own artifact and completes.
		const completed = reduce([...events, ...ladder]);
		const secondArtifact = resultArtifact(base.task.id, second.id);
		expect(completed.tasks[base.task.id]?.status).toBe("completed");
		expect(completed.artifacts[secondArtifact.id]).toEqual(secondArtifact);
		expect(completed.artifacts[firstArtifact.id]).toEqual(firstArtifact);
	});
});

describe("declaration after abandonment", () => {
	it("readopts an abandoned task with fresh position fields", () => {
		const graph = twoEpochGraph();
		const before = reduce(graph.events);
		expect(before.tasks[graph.taskB.id]).toMatchObject({
			status: "invalidated",
			abandoned: true,
		});
		expect(before.currentEpoch).toBe(3);
		const readopted = repositioned(graph.taskB, {
			materializationSequence: 3,
			materializationEpoch: 3,
			epochPosition: 1,
		});
		const state = reduce([
			...graph.events,
			{ type: "task-declared", data: { task: readopted } },
		]);
		expect(state.tasks[graph.taskB.id]).toEqual({
			task: readopted,
			status: "invalidated",
			committed: true,
		});
		expect(state.tasks[graph.taskB.id]?.abandoned).toBeUndefined();
		expect(Object.keys(state.tasks)).toHaveLength(2);
		expect(state.currentEpoch).toBe(3);
		for (const stale of [
			{ materializationSequence: 2, materializationEpoch: 3, epochPosition: 1 },
			{ materializationSequence: 3, materializationEpoch: 2, epochPosition: 1 },
			{ materializationSequence: 3, materializationEpoch: 3, epochPosition: 2 },
		]) {
			expect(() =>
				reduce([
					...graph.events,
					{
						type: "task-declared",
						data: { task: repositioned(graph.taskB, stale) },
					},
				]),
			).toThrow(WorkflowEventReductionError);
		}
	});

	it("readoption keeps the task status and current execution", () => {
		const run = independentSuffixRun();
		const events: WorkflowEventInput[] = [
			...run.events,
			runStatus("running", "failed"),
			invalidated(run.taskA.id, [run.taskA.id], [2]),
			runStatus("failed", "running"),
		];
		const before = reduce(events);
		expect(before.tasks[run.taskB.id]).toMatchObject({
			status: "failed",
			abandoned: true,
			currentExecutionId: run.executionB.id,
		});
		const readopted = repositioned(run.taskB, {
			materializationSequence: 3,
			materializationEpoch: 3,
			epochPosition: 1,
		});
		const state = reduce([
			...events,
			{ type: "task-declared", data: { task: readopted } },
			{
				type: "barrier-reached",
				data: { epoch: 3, kind: "final", taskIds: [readopted.id] },
			},
		]);
		expect(state.tasks[run.taskB.id]).toEqual({
			task: readopted,
			status: "failed",
			committed: true,
			currentExecutionId: run.executionB.id,
		});
		expect(state.executions[run.executionB.id]?.terminal?.outcome).toBe(
			"failed",
		);
		// Back on the path, the failed required task blocks finalization again.
		expect(() =>
			reduce([
				...events,
				{ type: "task-declared", data: { task: readopted } },
				{
					type: "barrier-reached",
					data: { epoch: 3, kind: "final", taskIds: [readopted.id] },
				},
				taskStatus(run.taskA.id, "invalidated", "pending"),
				taskStatus(run.taskA.id, "pending", "ready"),
				executionCreated(agentExecution(run.taskA, 2)),
				...executionLadder(agentExecution(run.taskA, 2), "completed"),
				runStatus("running", "finalizing"),
			]),
		).toThrow("run finalized before its required work completed");
	});

	it("rejects re-declaring an abandoned task with a changed request", () => {
		const graph = twoEpochGraph();
		const m = materializer();
		const a = m.agent("a", request("A"));
		m.closeEpoch("result", [a]);
		const changed = m.agent("b", request("B changed"));
		const commit = m.closeEpoch("final", [changed]);
		const changedTask = declaration(commit, changed.ref.taskId);
		expect(changedTask.id).toBe(graph.taskB.id);
		expect(changedTask.spec.identitySha256).not.toBe(
			graph.taskB.spec.identitySha256,
		);
		expect(() =>
			reduce([
				...graph.events,
				{
					type: "task-declared",
					data: {
						task: repositioned(changedTask, {
							materializationSequence: 3,
							materializationEpoch: 3,
							epochPosition: 1,
						}),
					},
				},
			]),
		).toThrow("duplicate workflow task ID");
	});

	it("rejects an on-path task id re-declaration as a duplicate", () => {
		const graph = twoEpochGraph();
		expect(() =>
			reduce([
				...graph.events,
				{
					type: "task-declared",
					data: {
						task: repositioned(graph.taskA, {
							materializationSequence: 3,
							materializationEpoch: 3,
							epochPosition: 1,
						}),
					},
				},
			]),
		).toThrow("duplicate workflow task ID");
	});

	it("rejects fresh declarations whose order or data dependency is abandoned", () => {
		const graph = twoEpochGraph();
		const m = materializer();
		const a = m.agent("a", request("A"));
		m.closeEpoch("result", [a]);
		const b = m.agent("b", request("B"));
		m.closeEpoch("result", [b]);
		const e = m.agent("e", { ...request("E"), inputs: { b: b.output } });
		const commit = m.closeEpoch("final", [e]);
		const orderDependent = declaration(commit, e.ref.taskId);
		expect(orderDependent).toMatchObject({
			materializationSequence: 3,
			materializationEpoch: 3,
			epochPosition: 1,
		});
		expect(() =>
			reduce([
				...graph.events,
				{ type: "task-declared", data: { task: orderDependent } },
			]),
		).toThrow("task dependency is abandoned");
		if (orderDependent.spec.kind !== "agent") {
			throw new Error("expected an agent task");
		}
		const { identitySha256: _identity, ...spec } = orderDependent.spec;
		const dataOnlySpec = { ...spec, after: [] };
		const dataDependent: MaterializedWorkflowTask = {
			...orderDependent,
			spec: {
				...dataOnlySpec,
				identitySha256: deriveAgentTaskIdentity({
					definitionIdentitySha256,
					inputSha256,
					namespace: orderDependent.namespace,
					spec: dataOnlySpec,
				}),
			},
		};
		expect(() =>
			reduce([
				...graph.events,
				{ type: "task-declared", data: { task: dataDependent } },
			]),
		).toThrow("task dependency is abandoned");
	});

	it("rejects barriers that expose an abandoned task", () => {
		const graph = twoEpochGraph();
		expect(() =>
			reduce([
				...graph.events,
				{
					type: "barrier-reached",
					data: { epoch: 3, kind: "result", taskIds: [graph.taskB.id] },
				},
			]),
		).toThrow("barrier references an abandoned task");
	});

	it("accepts declarations after an abandoned final barrier but not an on-path one", () => {
		const graph = twoEpochGraph();
		const m = materializer();
		const a = m.agent("a", request("A"));
		m.closeEpoch("result", [a]);
		m.closeEpoch("result", []);
		const fresh = m.agent("fresh", request("Fresh"));
		const commit = m.closeEpoch("final", [fresh]);
		const freshTask = repositioned(declaration(commit, fresh.ref.taskId), {
			materializationSequence: 3,
			materializationEpoch: 3,
			epochPosition: 1,
		});
		const state = reduce([
			...graph.events,
			{ type: "task-declared", data: { task: freshTask } },
			{
				type: "barrier-reached",
				data: { epoch: 3, kind: "final", taskIds: [freshTask.id] },
			},
		]);
		expect(state.tasks[freshTask.id]).toEqual({
			task: freshTask,
			status: "pending",
			committed: true,
		});
		expect(
			state.barriers.map((barrier) => [barrier.epoch, barrier.abandoned]),
		).toEqual([
			[1, undefined],
			[2, true],
			[3, undefined],
		]);
		expect(state.currentEpoch).toBe(4);
		const single = singleTaskGraph();
		const late = repositioned(declaration(commit, fresh.ref.taskId), {
			materializationSequence: 2,
			materializationEpoch: 2,
			epochPosition: 1,
		});
		expect(() =>
			reduce([
				runCreated(),
				...single.commitEvents,
				{ type: "task-declared", data: { task: late } },
			]),
		).toThrow("task declaration follows the final barrier");
	});
});

/**
 * Epoch 1 exposes a (required) by a result barrier; epoch 2 declares b
 * (required, no dependencies) under a final barrier. a completes and b fails.
 */
function independentSuffixRun() {
	const m = materializer();
	const a = m.agent("a", request("A"));
	const first = m.closeEpoch("result", [a]);
	const taskA = declaration(first, a.ref.taskId);
	const separate = materializer();
	const b = separate.agent("b", request("B"));
	const taskB = repositioned(
		declaration(separate.closeEpoch("final", [b]), b.ref.taskId),
		{ materializationSequence: 2, materializationEpoch: 2, epochPosition: 1 },
	);
	const executionA = agentExecution(taskA, 1);
	const executionB = agentExecution(taskB, 1);
	const events: WorkflowEventInput[] = [
		runCreated(),
		...first.events,
		{ type: "task-declared", data: { task: taskB } },
		{
			type: "barrier-reached",
			data: { epoch: 2, kind: "final", taskIds: [taskB.id] },
		},
		runStatus("created", "running"),
		taskStatus(taskA.id, "pending", "ready"),
		executionCreated(executionA),
		...executionLadder(executionA, "completed"),
		taskStatus(taskB.id, "pending", "ready"),
		executionCreated(executionB),
		...executionLadder(executionB, "failed"),
	];
	return { taskA, taskB, executionA, executionB, events };
}

function recoveredRun() {
	const run = independentSuffixRun();
	const secondA = agentExecution(run.taskA, 2);
	const output = runOutputArtifact();
	return {
		...run,
		secondA,
		events: [
			...run.events,
			runStatus("running", "failed"),
			invalidated(run.taskA.id, [run.taskA.id], [2]),
			runStatus("failed", "running"),
			taskStatus(run.taskA.id, "invalidated", "pending"),
			taskStatus(run.taskA.id, "pending", "ready"),
			executionCreated(secondA),
			...executionLadder(secondA, "completed"),
			{
				type: "barrier-reached",
				data: { epoch: 3, kind: "final", taskIds: [] },
			},
			runStatus("running", "finalizing"),
			{ type: "artifact-declared", data: { artifact: output } },
			{ type: "run-output-committed", data: { artifactId: output.id } },
			runStatus("finalizing", "completed"),
		] as WorkflowEventInput[],
	};
}

describe("run completion scans", () => {
	it("blocks finalization while an on-path required task is failed", () => {
		const run = independentSuffixRun();
		const state = reduce(run.events);
		expect(state.tasks[run.taskB.id]?.status).toBe("failed");
		expect(() =>
			reduce([...run.events, runStatus("running", "finalizing")]),
		).toThrow("run finalized before its required work completed");
	});

	it("skips abandoned failed required tasks after recovery", () => {
		const run = recoveredRun();
		const state = reduce(run.events);
		expect(state.status).toBe("completed");
		expect(state.tasks[run.taskB.id]).toMatchObject({
			status: "failed",
			abandoned: true,
			currentExecutionId: run.executionB.id,
		});
		expect(state.tasks[run.taskA.id]).toMatchObject({
			status: "completed",
			currentExecutionId: run.secondA.id,
		});
		expect(state.tasks[run.taskA.id]?.abandoned).toBeUndefined();
		expect(
			state.barriers.map((barrier) => [
				barrier.epoch,
				barrier.kind,
				barrier.abandoned,
			]),
		).toEqual([
			[1, "result", undefined],
			[2, "final", true],
			[3, "final", undefined],
		]);
		expect(Object.keys(state.executions)).toHaveLength(3);
		expect(state.executions[run.executionA.id]?.terminal?.outcome).toBe(
			"completed",
		);
		const invalidatedIndex = run.events.findIndex(
			(event) => event.type === "task-invalidated",
		);
		// Without the invalidation the failed required task still blocks.
		expect(() =>
			reduce([
				...run.events.slice(0, invalidatedIndex),
				runStatus("failed", "running"),
			]),
		).toThrow("recovery requires invalidated work");
	});
});

describe("snapshot round trip", () => {
	it("survives JSON serialization and passes the projection schema", () => {
		const run = recoveredRun();
		const state = reduce(run.events);
		const roundTrip = JSON.parse(JSON.stringify(state)) as unknown;
		expect(roundTrip).toStrictEqual(state);
		expect(Value.Check(WorkflowStateProjectionSchema, roundTrip)).toBe(true);
		expect(Value.Check(WorkflowStateProjectionSchema, state)).toBe(true);
		expect(Object.isFrozen(state.tasks[run.taskB.id])).toBe(true);
		const prefix = reduce(run.events.slice(0, -3));
		expect(Value.Check(WorkflowStateProjectionSchema, prefix)).toBe(true);
		expect(prefix.status).toBe("finalizing");
	});
});
