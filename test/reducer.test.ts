import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	currentSubagentAttemptId,
	settledAgentUsage,
} from "../src/attempts.js";
import type {
	TaskExecutionProjection,
	WorkflowEventInput,
} from "../src/events.js";
import { deriveTaskExecutionId } from "../src/execution.js";
import { WorkflowTaskMaterializer } from "../src/materializer.js";
import type { WorkflowJournalEvent } from "../src/persistence/journal.js";
import {
	invalidationClosure,
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

function journalEvents(inputs: readonly WorkflowEventInput[]) {
	return inputs.map(
		(input, index): WorkflowJournalEvent => ({
			schema: "pi-workflow-event",
			contractRevision: 15,
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

	it("rejects artifacts from an uncommitted producer", () => {
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
						type: "artifact-declared",
						data: {
							artifact: {
								id: `artifact_${"c".repeat(64)}`,
								runId: "workflow_reducer",
								producerTaskId: first.ref.taskId,
								producerExecutionId: deriveTaskExecutionId(
									"workflow_reducer",
									first.ref.taskId,
									1,
								),
								output: "result",
								sha256: "d".repeat(64),
								bytes: 2,
								mediaType: "application/json",
								schemaSha256: "e".repeat(64),
							},
						},
					},
				]),
			),
		).toThrow("producer is not committed");
	});

	it("rejects invalidation of an uncommitted declaration", () => {
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
						type: "run-status-changed",
						data: { from: "created", to: "running" },
					},
					{
						type: "task-invalidated",
						data: {
							causeTaskId: first.ref.taskId,
							taskIds: [first.ref.taskId],
							abandonedEpochs: [],
							reason: "re-execute",
						},
					},
				]),
			),
		).toThrow("uncommitted task");
	});

	it("requires invalidation to cover the exact transitive closure", () => {
		const { first, second, commit } = committedGraph();
		const base: WorkflowEventInput[] = [
			runCreated(),
			...commit.events,
			{
				type: "run-status-changed",
				data: { from: "created", to: "running" },
			},
		];
		const closure = invalidationClosure(
			reduceWorkflowEvents(journalEvents(base)),
			first.ref.taskId,
		);
		expect(() =>
			reduceWorkflowEvents(
				journalEvents([
					...base,
					{
						type: "task-invalidated",
						data: {
							causeTaskId: first.ref.taskId,
							taskIds: [first.ref.taskId],
							abandonedEpochs: closure.abandonedEpochs,
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
						abandonedEpochs: closure.abandonedEpochs,
						reason: "re-execute",
					},
				},
			]),
		);
		expect(state.tasks[first.ref.taskId]?.status).toBe("invalidated");
		expect(state.tasks[second.ref.taskId]?.status).toBe("invalidated");
	});

	it("does not declare or commit tasks after cancellation", () => {
		const { commit } = committedGraph();
		const declaration = commit.events[0];
		if (declaration?.type !== "task-declared") {
			throw new Error("missing task declaration");
		}
		expect(() =>
			reduceWorkflowEvents(
				journalEvents([
					runCreated(),
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
					declaration,
				]),
			),
		).toThrow("terminal workflow run may not declare tasks");
	});

	it("does not declare artifacts after cancellation", () => {
		expect(() =>
			reduceWorkflowEvents(
				journalEvents([
					runCreated(),
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
					{
						type: "artifact-declared",
						data: {
							artifact: {
								id: `artifact_${"c".repeat(64)}`,
								runId: "workflow_reducer",
								sha256: "d".repeat(64),
								bytes: 2,
								mediaType: "application/json",
								schemaSha256: "e".repeat(64),
							},
						},
					},
				]),
			),
		).toThrow("terminal workflow run may not declare artifacts");
	});

	it("does not cancel a run while committed tasks remain unsettled", () => {
		const { commit } = committedGraph();
		expect(() =>
			reduceWorkflowEvents(
				journalEvents([
					runCreated(),
					...commit.events,
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
			),
		).toThrow("tasks remain unsettled");
	});

	it("allows cancellation after tasks are invalidated", () => {
		const { first, second, commit } = committedGraph();
		const running: WorkflowEventInput[] = [
			runCreated(),
			...commit.events,
			{
				type: "run-status-changed",
				data: { from: "created", to: "running" },
			},
		];
		const closure = invalidationClosure(
			reduceWorkflowEvents(journalEvents(running)),
			first.ref.taskId,
		);
		const state = reduceWorkflowEvents(
			journalEvents([
				...running,
				{
					type: "task-invalidated",
					data: {
						causeTaskId: first.ref.taskId,
						taskIds: [first.ref.taskId, second.ref.taskId],
						abandonedEpochs: closure.abandonedEpochs,
						reason: "re-execute",
					},
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
		expect(state.status).toBe("cancelled");
	});

	it("does not change task status after terminal run completion", () => {
		const { first, second, commit } = committedGraph();
		expect(() =>
			reduceWorkflowEvents(
				journalEvents([
					runCreated(),
					...commit.events,
					{
						type: "run-status-changed",
						data: { from: "created", to: "running" },
					},
					{
						type: "run-status-changed",
						data: { from: "running", to: "stopping" },
					},
					{
						type: "task-status-changed",
						data: {
							taskId: first.ref.taskId,
							from: "pending",
							to: "cancelled",
						},
					},
					{
						type: "task-status-changed",
						data: {
							taskId: second.ref.taskId,
							from: "pending",
							to: "cancelled",
						},
					},
					{
						type: "run-status-changed",
						data: { from: "stopping", to: "cancelled" },
					},
					{
						type: "task-status-changed",
						data: {
							taskId: first.ref.taskId,
							from: "cancelled",
							to: "invalidated",
						},
					},
				]),
			),
		).toThrow("terminal workflow run");
	});

	it("requires a final barrier on every completion path", () => {
		expect(() =>
			reduceWorkflowEvents(
				journalEvents([
					runCreated(),
					{
						type: "run-status-changed",
						data: { from: "created", to: "running" },
					},
					{
						type: "run-status-changed",
						data: { from: "running", to: "cleanup-blocked" },
					},
					{
						type: "run-status-changed",
						data: { from: "cleanup-blocked", to: "completed" },
					},
				]),
			),
		).toThrow("without a final barrier");
	});

	it("does not freeze caller-owned event payloads", () => {
		const { commit } = committedGraph();
		const inputs = structuredClone([runCreated(), ...commit.events]);
		reduceWorkflowEvents(journalEvents(inputs));
		const declaration = inputs[1];
		if (declaration?.type !== "task-declared") {
			throw new Error("missing task declaration");
		}
		expect(Object.isFrozen(declaration.data.task)).toBe(false);
	});

	it("rejects attempt events on unknown executions", () => {
		const { commit } = committedGraph();
		const executionId = deriveTaskExecutionId(
			"workflow_reducer",
			`task_${"9".repeat(64)}`,
			1,
		);
		const base: WorkflowEventInput[] = [
			runCreated(),
			...commit.events,
			{
				type: "run-status-changed",
				data: { from: "created", to: "running" },
			},
		];
		const attemptEvents: WorkflowEventInput[] = [
			{
				type: "task-execution-attempt-intended",
				data: {
					executionId,
					subagentRunId: "run_child",
					kind: "retry",
					ordinal: 2,
					previousAttemptId: "attempt_child",
					failureCode: "provider-transient",
					failureRetry: "backoff",
				},
			},
			{
				type: "task-execution-attempt-receipted",
				data: {
					executionId,
					subagentRunId: "run_child",
					ordinal: 2,
					subagentAttemptId: "attempt_retry",
					status: "active",
				},
			},
			{
				type: "task-execution-attempt-declined",
				data: {
					executionId,
					subagentRunId: "run_child",
					ordinal: 2,
					reason: "stop requested",
				},
			},
		];
		for (const event of attemptEvents) {
			expect(() =>
				reduceWorkflowEvents(journalEvents([...base, event])),
			).toThrow("task execution is unknown");
		}
	});

	it("derives the current attempt and settled usage from a projection", () => {
		const evidence = (attemptOrdinal: number, cost: number) => ({
			kind: "subagent" as const,
			attemptOrdinal,
			resultSha256: "d".repeat(64),
			status: "failed" as const,
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost,
			},
			usageComplete: attemptOrdinal === 1,
			runtimeMs: 100 * attemptOrdinal,
			failure: {
				code: "provider-transient" as const,
				origin: "provider" as const,
				retry: "backoff" as const,
				message: "Provider timed out.",
				guidance: "Retry later.",
			},
			sandboxCleanup: "proved" as const,
			workspaceCleanup: "not-needed" as const,
			truncated: false,
		});
		const execution = {
			kind: "agent" as const,
			id: `execution_${"a".repeat(64)}`,
			runId: "workflow_reducer",
			taskId: `task_${"b".repeat(64)}`,
			generation: 1,
			taskIdentitySha256: "c".repeat(64),
			operationId: `workflow-op_${"d".repeat(64)}`,
		};
		const created: TaskExecutionProjection = {
			execution,
			phase: "created",
			createdSequence: 1,
		};
		expect(currentSubagentAttemptId(created)).toBeUndefined();
		expect(settledAgentUsage(created)).toEqual({
			cost: 0,
			totalTokens: 0,
			runtimeMs: 0,
			usageComplete: true,
		});
		const launched: TaskExecutionProjection = {
			...created,
			phase: "settled",
			launchReceipt: {
				operationId: execution.operationId,
				subagentRunId: "run_child",
				subagentAttemptId: "attempt_child",
				status: "active",
				sequence: 2,
			},
			settlement: { evidence: evidence(1, 0.25), sequence: 3 },
		};
		expect(currentSubagentAttemptId(launched)).toBe("attempt_child");
		expect(settledAgentUsage(launched)).toEqual({
			cost: 0.25,
			totalTokens: 15,
			runtimeMs: 100,
			usageComplete: true,
		});
		const retried: TaskExecutionProjection = {
			...launched,
			attempts: [
				{
					kind: "retry",
					ordinal: 2,
					previousAttemptId: "attempt_child",
					subagentAttemptId: "attempt_retry",
					status: "active",
					intentSequence: 4,
					receiptSequence: 5,
				},
				{
					kind: "retry",
					ordinal: 3,
					previousAttemptId: "attempt_retry",
					intentSequence: 7,
				},
			],
			priorSettlements: [{ evidence: evidence(1, 0.25), sequence: 3 }],
			settlement: { evidence: evidence(2, 0.5), sequence: 6 },
			phase: "attempt-intended",
		};
		expect(currentSubagentAttemptId(retried)).toBe("attempt_retry");
		expect(settledAgentUsage(retried)).toEqual({
			cost: 0.75,
			totalTokens: 30,
			runtimeMs: 300,
			usageComplete: false,
		});
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
