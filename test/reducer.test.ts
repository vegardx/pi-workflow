import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { WorkflowEventInput } from "../src/events.js";
import { WorkflowTaskMaterializer } from "../src/materializer.js";
import type { WorkflowJournalEvent } from "../src/persistence/journal.js";
import {
	reduceWorkflowEvents,
	WorkflowEventReductionError,
} from "../src/reducer.js";

const definitionIdentitySha256 = "a".repeat(64);
const inputSha256 = "b".repeat(64);

function request(goal = "Answer") {
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

function journalEvents(inputs: readonly WorkflowEventInput[]) {
	return inputs.map(
		(input, index): WorkflowJournalEvent => ({
			schema: "pi-workflow-event",
			contractRevision: 1,
			sequence: index + 1,
			eventId: `event-${index + 1}`,
			timestamp: "2026-08-20T00:00:00.000Z",
			runId: "workflow_reducer",
			ownerId: "test",
			leaseId: "lease-test",
			fencingGeneration: 1,
			type: input.type,
			data: input.data,
		}),
	);
}

function runCreated(): WorkflowEventInput {
	return {
		type: "run-created",
		data: { definitionIdentitySha256, inputSha256 },
	};
}

function committedGraph() {
	const materializer = new WorkflowTaskMaterializer({
		runId: "workflow_reducer",
		definitionIdentitySha256,
		inputSha256,
	});
	const first = materializer.agent("first", request());
	const second = materializer.agent("second", {
		...request("Review"),
		after: [first.ref],
	});
	return {
		first,
		second,
		commit: materializer.closeEpoch("final", [second]),
	};
}

describe("workflow event reducer", () => {
	it("rebuilds committed tasks and lifecycle state from events", () => {
		const { first, commit } = committedGraph();
		const state = reduceWorkflowEvents(
			journalEvents([
				runCreated(),
				...commit.events,
				{
					type: "run-status-changed",
					data: { from: "created", to: "running" },
				},
				{
					type: "task-status-changed",
					data: { taskId: first.ref.taskId, from: "pending", to: "ready" },
				},
			]),
		);
		expect(state.status).toBe("running");
		expect(state.tasks[first.ref.taskId]).toMatchObject({
			status: "ready",
			committed: true,
		});
		expect(state.currentEpoch).toBe(2);
		expect(Object.isFrozen(state)).toBe(true);
		expect(Object.isFrozen(state.tasks[first.ref.taskId])).toBe(true);
	});

	it("does not allow an uncommitted declaration to execute", () => {
		const { first, commit } = committedGraph();
		const declaration = commit.events[0];
		if (declaration?.type !== "task-declared") {
			throw new Error("missing task declaration");
		}
		expect(() =>
			reduceWorkflowEvents(
				journalEvents([
					runCreated(),
					declaration,
					{
						type: "task-status-changed",
						data: {
							taskId: first.ref.taskId,
							from: "pending",
							to: "ready",
						},
					},
				]),
			),
		).toThrow("uncommitted task");
	});

	it("requires invalidation to cover the exact transitive closure", () => {
		const { first, second, commit } = committedGraph();
		const base = [runCreated(), ...commit.events] as WorkflowEventInput[];
		expect(() =>
			reduceWorkflowEvents(
				journalEvents([
					...base,
					{
						type: "task-invalidated",
						data: {
							causeTaskId: first.ref.taskId,
							taskIds: [first.ref.taskId],
							reason: "re-execute",
						},
					},
				]),
			),
		).toThrow("exact dependent closure");
		const state = reduceWorkflowEvents(
			journalEvents([
				...base,
				{
					type: "task-invalidated",
					data: {
						causeTaskId: first.ref.taskId,
						taskIds: [first.ref.taskId, second.ref.taskId],
						reason: "re-execute",
					},
				},
			]),
		);
		expect(state.tasks[first.ref.taskId]?.status).toBe("invalidated");
		expect(state.tasks[second.ref.taskId]?.status).toBe("invalidated");
	});

	it("rejects missing creation and invalid lifecycle transitions", () => {
		expect(() => reduceWorkflowEvents([])).toThrow(WorkflowEventReductionError);
		expect(() =>
			reduceWorkflowEvents(
				journalEvents([
					runCreated(),
					{
						type: "run-status-changed",
						data: { from: "created", to: "completed" },
					},
				]),
			),
		).toThrow("invalid workflow run transition");
	});
});
