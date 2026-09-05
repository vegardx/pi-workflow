import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { WorkflowEventInput } from "../src/events.js";
import {
	WorkflowMaterializationError,
	WorkflowTaskMaterializer,
} from "../src/materializer.js";
import type { WorkflowJournalEvent } from "../src/persistence/journal.js";
import { reduceWorkflowEvents } from "../src/reducer.js";

const definitionIdentitySha256 = "a".repeat(64);
const inputSha256 = "b".repeat(64);

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
			runtimeMs: 300_000,
			attemptRuntimeMs: 300_000,
			tokens: 1_000_000,
			cost: 100,
			outputBytes: 1_048_576,
			workspaceWriteBytes: 0,
			retries: 1,
			resumes: 1,
		},
	};
}

function materializer(previousState?: ReturnType<typeof reduceWorkflowEvents>) {
	return new WorkflowTaskMaterializer({
		runId: "workflow_materializer",
		definitionIdentitySha256,
		inputSha256,
		...(previousState === undefined ? {} : { previousState }),
	});
}

function records(
	events: readonly WorkflowEventInput[],
): WorkflowJournalEvent[] {
	const all: WorkflowEventInput[] = [
		{
			type: "run-created",
			data: { definitionIdentitySha256, inputSha256 },
		},
		...events,
	];
	return all.map((event, index) => ({
		schema: "pi-workflow-event",
		contractRevision: 1,
		sequence: index + 1,
		eventId: `event-${index + 1}`,
		timestamp: "2026-08-20T00:00:00.000Z",
		runId: "workflow_materializer",
		ownerId: "test",
		leaseId: "lease-test",
		fencingGeneration: 1,
		type: event.type,
		data: event.data,
	}));
}

describe("workflow task materializer", () => {
	it("materializes dependencies and closes a committed epoch", () => {
		const runtime = materializer();
		const first = runtime.agent("first", request());
		const second = runtime.agent("second", {
			...request("Review"),
			inputs: { first: first.output },
		});
		const commit = runtime.closeEpoch("final", [second]);
		expect(commit.epoch).toBe(1);
		expect(commit.events.map((event) => event.type)).toEqual([
			"task-declared",
			"task-declared",
			"barrier-reached",
		]);
		const declarations = commit.events.filter(
			(event) => event.type === "task-declared",
		);
		if (
			declarations[0]?.type !== "task-declared" ||
			declarations[1]?.type !== "task-declared"
		) {
			throw new Error("missing declarations");
		}
		expect(declarations[1].data.task.spec.after).toEqual([first.ref]);
		expect(declarations[1].data.task.spec.inputs.first).toEqual(
			first.output.ref,
		);
		expect(first.output.ref).toEqual({
			runId: "workflow_materializer",
			producerTaskId: first.ref.taskId,
			output: "result",
		});
		expect(Object.isFrozen(commit.events)).toBe(true);
	});

	it("adds result-barrier control dependencies to the next epoch", () => {
		const runtime = materializer();
		const first = runtime.agent("first", request());
		runtime.closeEpoch("result", [first]);
		const second = runtime.agent("second", request("Continue"));
		const commit = runtime.closeEpoch("final", [second]);
		const declaration = commit.events[0];
		if (declaration?.type !== "task-declared") {
			throw new Error("missing declaration");
		}
		expect(declaration.data.task.spec.after).toEqual([first.ref]);
	});

	it("retains control dependencies across an empty barrier", () => {
		const runtime = materializer();
		const first = runtime.agent("first", request());
		runtime.closeEpoch("result", [first]);
		runtime.closeEpoch("results", []);
		const second = runtime.agent("second", request("Continue"));
		const commit = runtime.closeEpoch("final", [second]);
		const declaration = commit.events[0];
		if (declaration?.type !== "task-declared") {
			throw new Error("missing declaration");
		}
		expect(declaration.data.task.spec.after).toEqual([first.ref]);
	});

	it("replays an exact ordered epoch without producing new events", () => {
		const initial = materializer();
		const answer = initial.agent("answer", request());
		const commit = initial.closeEpoch("result", [answer]);
		const previousState = reduceWorkflowEvents(records(commit.events));
		const replay = materializer(previousState);
		const replayed = replay.agent("answer", request());
		expect(replayed.ref).toEqual(answer.ref);
		expect(replay.closeEpoch("result", [replayed]).events).toEqual([]);
	});

	it("does not commit a partial persisted epoch with omitted declarations", () => {
		const initial = materializer();
		initial.agent("first", request());
		initial.agent("second", request("Second"));
		const pending = initial
			.closeEpoch("final", [])
			.events.filter((event) => event.type === "task-declared");
		const previousState = reduceWorkflowEvents(records(pending));
		const replay = materializer(previousState);
		replay.agent("first", request());
		expect(() => replay.closeEpoch("final", [])).toThrow("omits declarations");
	});

	it("enforces task bounds and rejects declarations after final", () => {
		const runtime = materializer();
		Array.from({ length: 256 }, (_, index) =>
			runtime.agent(`task-${index}` as `task-${number}`, request()),
		);
		expect(() => runtime.agent("overflow", request())).toThrow(
			"task limit exceeded",
		);
		const finalRuntime = materializer();
		const answer = finalRuntime.agent("answer", request());
		finalRuntime.closeEpoch("final", [answer]);
		expect(() => finalRuntime.agent("later", request())).toThrow(
			"final materialization barrier",
		);
	});

	it("rejects an epoch that cannot fit in the durable projection", () => {
		const runtime = materializer();
		const largeRequest = {
			...request(),
			workspace: {
				mode: "read-only" as const,
				cwd: `/${"x".repeat(4095)}`,
			},
		};
		for (let index = 0; index < 256; index += 1) {
			runtime.agent(`task-${index}` as `task-${number}`, largeRequest);
		}
		expect(() => runtime.closeEpoch("final", [])).toThrow(
			"durable state bounds",
		);
	});

	it("does not resume materialization for a cancelled run", () => {
		const terminal = reduceWorkflowEvents(
			records([
				{
					type: "run-status-changed",
					data: { from: "created", to: "running" },
				},
				{
					type: "run-status-changed",
					data: { from: "running", to: "stopping" },
				},
				{
					type: "run-status-changed",
					data: { from: "stopping", to: "cancelled" },
				},
			]),
		);
		expect(() => materializer(terminal)).toThrow(
			"cancelled workflow run may not materialize",
		);
	});

	it("fails closed on changed or duplicate declarations", () => {
		const initial = materializer();
		const answer = initial.agent("answer", request());
		const previousState = reduceWorkflowEvents(
			records(initial.closeEpoch("result", [answer]).events),
		);
		const replay = materializer(previousState);
		expect(() => replay.agent("answer", request("Changed"))).toThrow(
			WorkflowMaterializationError,
		);
		const duplicate = materializer();
		duplicate.agent("answer", request());
		expect(() => duplicate.agent("answer", request())).toThrow(
			"duplicate task key",
		);
	});
});
