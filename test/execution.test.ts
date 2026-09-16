import { randomUUID } from "node:crypto";
import path from "node:path";
import {
	canonicalSha256,
	HANDOFF_EXPORT_MEDIA_TYPE,
} from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	currentSubagentAttemptId,
	settledAgentUsage,
} from "../src/attempts.js";
import {
	type AgentTaskExecutionRecord,
	type MaterializedNestedWorkflowTask,
	type MaterializedSupportTask,
	type NestedWorkflowTaskExecutionRecord,
	type NestedWorkflowTaskRequest,
	type NestedWorkflowTerminalEvidence,
	type SubagentTerminalEvidence,
	type SupportTaskExecutionRecord,
	type SupportTaskTerminalEvidence,
	WORKFLOW_HANDOFF_FORMAT_SHA256,
	type WorkflowArtifactRef,
	type WorkflowRunStatus,
	type WorkflowTaskId,
} from "../src/contracts.js";
import {
	canonicalJson,
	deriveJsonValueSha256 as digestJsonValueSha256,
} from "../src/digest.js";
import type { WorkflowEventInput } from "../src/events.js";
import {
	deriveJsonValueSha256,
	deriveNestedWorkflowRunId,
	deriveSubagentOperationId,
	deriveSubagentResultSha256,
	deriveSubagentSettlementEvidence,
	deriveSupportImplementationIdentitySha256,
	deriveTaskExecutionId,
	deriveWorkflowArtifactId,
	deriveWorkflowFailureSha256,
	deriveWorkflowHandoffDescriptor,
} from "../src/execution.js";
import {
	deriveNestedWorkflowTaskIdentity,
	deriveWorkflowTaskId,
	WorkflowTaskMaterializer,
} from "../src/materializer.js";
import {
	type WorkflowJournalEvent,
	WorkflowRunJournal,
} from "../src/persistence/journal.js";
import { acquireWorkflowRunLease } from "../src/persistence/run-lease.js";
import {
	rebuildWorkflowSnapshot,
	reduceWorkflowEvents,
} from "../src/reducer.js";
import { defineSupportTask } from "../src/support.js";

const definitionIdentitySha256 = "a".repeat(64);
const inputSha256 = "b".repeat(64);
const planIdentitySha256 = "c".repeat(64);
const resultSha256 = "d".repeat(64);
const structuredOutputSha256 = "e".repeat(64);
const supportOutputSha256 = "1".repeat(64);
const supportHelper = defineSupportTask({
	name: "@vegardx/workflow-tools/summarize",
	moduleSpecifier: "@vegardx/workflow-tools",
	revision: 1,
	implementationSha256: "f".repeat(64),
	parametersSchema: Type.Object({ strict: Type.Boolean() }),
	outputSchema: Type.Object({ value: Type.String() }),
});

function request() {
	return {
		agent: "researcher",
		task: {
			goal: "Answer",
			context: [],
			instructions: ["Return structured output."],
		},
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

function graph() {
	const materializer = new WorkflowTaskMaterializer({
		runId: "workflow_execution",
		definitionIdentitySha256,
		inputSha256,
	});
	const task = materializer.agent("answer", request());
	return { task, commit: materializer.closeEpoch("final", [task]) };
}

function records(
	inputs: readonly WorkflowEventInput[],
): WorkflowJournalEvent[] {
	return inputs.map((input, index) => ({
		schema: "pi-workflow-event",
		contractRevision: 19,
		sequence: index + 1,
		eventId: `event-${index + 1}`,
		timestamp: "2026-09-01T00:00:00.000Z",
		runId: "workflow_execution",
		ownerId: "test",
		leaseId: "lease-test",
		fencingGeneration: 1,
		type: input.type,
		data: input.data,
	}));
}

function runCreated(): WorkflowEventInput {
	return {
		type: "run-created",
		data: { definitionIdentitySha256, inputSha256 },
	};
}

function execution(taskId: WorkflowTaskId, taskIdentitySha256: string) {
	const generation = 1;
	return {
		kind: "agent" as const,
		id: deriveTaskExecutionId("workflow_execution", taskId, generation),
		runId: "workflow_execution" as const,
		taskId,
		generation,
		taskIdentitySha256,
		operationId: deriveSubagentOperationId(
			"workflow_execution",
			taskId,
			generation,
		),
	} satisfies AgentTaskExecutionRecord;
}

function setupEvents(): {
	taskId: WorkflowTaskId;
	execution: AgentTaskExecutionRecord;
	events: WorkflowEventInput[];
} {
	const { task, commit } = graph();
	const declaration = commit.events.find(
		(event) => event.type === "task-declared",
	);
	if (declaration?.type !== "task-declared") {
		throw new Error("missing task declaration");
	}
	const record = execution(
		task.ref.taskId,
		declaration.data.task.spec.identitySha256,
	);
	return {
		taskId: task.ref.taskId,
		execution: record,
		events: [
			runCreated(),
			...commit.events,
			{
				type: "run-status-changed",
				data: { from: "created", to: "running" },
			},
			{
				type: "task-status-changed",
				data: { taskId: task.ref.taskId, from: "pending", to: "ready" },
			},
			{ type: "task-execution-created", data: { execution: record } },
		],
	};
}

function preflightEvents(
	record: AgentTaskExecutionRecord,
): WorkflowEventInput[] {
	return [
		{
			type: "task-execution-preflighted",
			data: {
				executionId: record.id,
				operationId: record.operationId,
				preflightId: "preflight-1",
				planIdentitySha256,
				plannedSubagentRunId: "run_child",
				plannedSubagentAttemptId: "attempt_child",
				expiresAt: "2026-09-01T01:00:00.000Z",
				workspaceMode: "read-only",
				workspaceBaselineSha256: "c".repeat(64),
			},
		},
		{
			type: "task-execution-launch-intended",
			data: {
				executionId: record.id,
				operationId: record.operationId,
				preflightId: "preflight-1",
				planIdentitySha256,
			},
		},
	];
}

function settlement(
	record: AgentTaskExecutionRecord,
	evidence: SubagentTerminalEvidence,
): WorkflowEventInput {
	return {
		type: "task-execution-child-settled",
		data: { executionId: record.id, evidence },
	};
}

function artifact(taskId: WorkflowTaskId): WorkflowArtifactRef {
	const input = {
		runId: "workflow_execution" as const,
		producerTaskId: taskId,
		producerExecutionId: deriveTaskExecutionId("workflow_execution", taskId, 1),
		output: "result" as const,
		sha256: structuredOutputSha256,
		schemaSha256: deriveJsonValueSha256(request().outputSchema),
	};
	return {
		id: deriveWorkflowArtifactId(input),
		...input,
		bytes: 18,
		mediaType: "application/json",
	};
}

function releaseEvents(
	record: AgentTaskExecutionRecord,
	status: "completed" | "failed" | "cleanup-blocked",
): WorkflowEventInput[] {
	return [
		{
			type: "task-execution-release-intended",
			data: {
				executionId: record.id,
				subagentRunId: "run_child",
			},
		},
		{
			type: "task-execution-released",
			data: {
				executionId: record.id,
				subagentRunId: "run_child",
				status,
			},
		},
	];
}

function completedEvidence() {
	return {
		kind: "subagent" as const,
		attemptOrdinal: 1,
		resultSha256,
		status: "completed" as const,
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
		sandboxCleanup: "proved" as const,
		workspaceCleanup: "not-needed" as const,
		truncated: false,
		structuredOutputSha256,
	};
}

describe("task execution persistence", () => {
	it("derives stable generation, operation, and evidence identities", () => {
		const taskId = "task_example";
		expect(deriveTaskExecutionId("workflow_execution", taskId, 1)).toMatch(
			/^execution_[a-f0-9]{64}$/,
		);
		expect(deriveTaskExecutionId("workflow_execution", taskId, 1)).not.toBe(
			deriveTaskExecutionId("workflow_execution", taskId, 2),
		);
		expect(deriveSubagentOperationId("workflow_execution", taskId, 1)).toMatch(
			/^workflow-op_[a-f0-9]{64}$/,
		);
		const result = {
			runId: "run_child",
			status: "completed" as const,
			structuredOutput: { answer: "yes" },
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
			sandboxCleanup: "proved" as const,
			workspaceCleanup: "not-needed" as const,
			truncated: false,
		};
		expect(deriveSubagentResultSha256(result)).toMatch(/^[a-f0-9]{64}$/);
		expect(deriveSubagentResultSha256(structuredClone(result))).toBe(
			deriveSubagentResultSha256(result),
		);
		expect(deriveWorkflowFailureSha256("preflight", "missing agent")).not.toBe(
			deriveWorkflowFailureSha256("launch", "missing agent"),
		);
		expect(
			deriveWorkflowArtifactId({
				runId: "workflow_execution",
				producerTaskId: "task_one",
				producerExecutionId: "execution_one",
				output: "result",
				schemaSha256: planIdentitySha256,
				sha256: planIdentitySha256,
			}),
		).not.toBe(
			deriveWorkflowArtifactId({
				runId: "workflow_execution",
				producerTaskId: "task_two",
				producerExecutionId: "execution_two",
				output: "result",
				schemaSha256: planIdentitySha256,
				sha256: planIdentitySha256,
			}),
		);
	});

	it("reduces a complete successful execution without raw child output", () => {
		const setup = setupEvents();
		const output = artifact(setup.taskId);
		const events: WorkflowEventInput[] = [
			...setup.events,
			...preflightEvents(setup.execution),
			{
				type: "task-execution-launch-receipted",
				data: {
					executionId: setup.execution.id,
					operationId: setup.execution.operationId,
					subagentRunId: "run_child",
					subagentAttemptId: "attempt_child",
					status: "active",
				},
			},
			{
				type: "task-status-changed",
				data: { taskId: setup.taskId, from: "ready", to: "running" },
			},
			{
				type: "task-execution-child-observed",
				data: {
					executionId: setup.execution.id,
					subagentRunId: "run_child",
					subagentAttemptId: "attempt_child",
					status: "completed",
				},
			},
			settlement(setup.execution, completedEvidence()),
			{ type: "artifact-declared", data: { artifact: output } },
			{
				type: "task-execution-artifact-imported",
				data: {
					executionId: setup.execution.id,
					subagentRunId: "run_child",
					artifactId: output.id,
					sourceResultSha256: resultSha256,
				},
			},
			...releaseEvents(setup.execution, "completed"),
			{
				type: "task-execution-terminal",
				data: {
					executionId: setup.execution.id,
					outcome: "completed",
					evidence: completedEvidence(),
				},
			},
			{
				type: "task-status-changed",
				data: { taskId: setup.taskId, from: "running", to: "completed" },
			},
		];
		const state = reduceWorkflowEvents(records(events));
		const projection = state.executions[setup.execution.id];
		expect(projection).toMatchObject({
			phase: "terminal",
			execution: setup.execution,
			artifactImport: { artifactId: output.id },
			terminal: { outcome: "completed" },
		});
		expect(state.tasks[setup.taskId]?.status).toBe("completed");
		expect(JSON.stringify(projection)).not.toContain(
			"Return structured output",
		);
	});

	it("replaces an expired preflight before launch intent", () => {
		const setup = setupEvents();
		const first = preflightEvents(setup.execution)[0];
		if (first?.type !== "task-execution-preflighted") {
			throw new Error("missing preflight event");
		}
		const expired: WorkflowEventInput = {
			...first,
			data: { ...first.data, expiresAt: "2026-09-01T00:00:00.000Z" },
		};
		const replacement: WorkflowEventInput = {
			type: "task-execution-preflighted",
			data: {
				...first.data,
				preflightId: "preflight-2",
				expiresAt: "2026-09-01T02:00:00.000Z",
				supersedesPreflightId: "preflight-1",
			},
		};
		expect(() =>
			reduceWorkflowEvents(records([...setup.events, first, replacement])),
		).toThrow("preflight is out of order");
		const expiredIntent = preflightEvents(setup.execution)[1];
		if (expiredIntent?.type !== "task-execution-launch-intended") {
			throw new Error("missing launch intent");
		}
		expect(() =>
			reduceWorkflowEvents(records([...setup.events, expired, expiredIntent])),
		).toThrow("launch intent is out of order");
		const state = reduceWorkflowEvents(
			records([
				...setup.events,
				expired,
				replacement,
				{
					type: "task-execution-launch-intended",
					data: {
						executionId: setup.execution.id,
						operationId: setup.execution.operationId,
						preflightId: "preflight-2",
						planIdentitySha256,
					},
				},
			]),
		);
		expect(state.executions[setup.execution.id]?.preflight?.preflightId).toBe(
			"preflight-2",
		);
	});

	it("recovers an uncertain launch with the same operation identity", () => {
		const setup = setupEvents();
		const events: WorkflowEventInput[] = [
			...setup.events,
			...preflightEvents(setup.execution),
			{
				type: "task-execution-launch-uncertain",
				data: {
					executionId: setup.execution.id,
					operationId: setup.execution.operationId,
					reason: "connection closed before receipt",
				},
			},
			{
				type: "task-execution-launch-receipted",
				data: {
					executionId: setup.execution.id,
					operationId: setup.execution.operationId,
					subagentRunId: "run_child",
					subagentAttemptId: "attempt_child",
					status: "active",
				},
			},
		];
		const state = reduceWorkflowEvents(records(events));
		expect(state.executions[setup.execution.id]).toMatchObject({
			phase: "launched",
			launchUncertain: {
				operationId: setup.execution.operationId,
			},
			launchReceipt: { subagentRunId: "run_child" },
		});
	});

	it("requires durable operation absence before uncertain launch failure", () => {
		const setup = setupEvents();
		const uncertain: WorkflowEventInput = {
			type: "task-execution-launch-uncertain",
			data: {
				executionId: setup.execution.id,
				operationId: setup.execution.operationId,
				reason: "timeout",
			},
		};
		const terminal: WorkflowEventInput = {
			type: "task-execution-terminal",
			data: {
				executionId: setup.execution.id,
				outcome: "failed",
				evidence: {
					kind: "workflow",
					stage: "reconciliation",
					failureSha256: deriveWorkflowFailureSha256(
						"reconciliation",
						"operation is absent",
					),
					message: "operation is absent",
				},
			},
		};
		const prefix = [
			...setup.events,
			...preflightEvents(setup.execution),
			uncertain,
		];
		expect(() => reduceWorkflowEvents(records([...prefix, terminal]))).toThrow(
			"workflow terminal evidence is inconsistent",
		);
		const state = reduceWorkflowEvents(
			records([
				...prefix,
				{
					type: "task-execution-launch-absent",
					data: {
						executionId: setup.execution.id,
						operationId: setup.execution.operationId,
					},
				},
				terminal,
			]),
		);
		expect(state.executions[setup.execution.id]?.terminal?.outcome).toBe(
			"failed",
		);
	});

	it("completes when the first child observation is already terminal", () => {
		const setup = setupEvents();
		const output = artifact(setup.taskId);
		const events: WorkflowEventInput[] = [
			...setup.events,
			...preflightEvents(setup.execution),
			{
				type: "task-execution-launch-receipted",
				data: {
					executionId: setup.execution.id,
					operationId: setup.execution.operationId,
					subagentRunId: "run_child",
					subagentAttemptId: "attempt_child",
					status: "completed",
				},
			},
			{
				type: "task-execution-child-observed",
				data: {
					executionId: setup.execution.id,
					subagentRunId: "run_child",
					subagentAttemptId: "attempt_child",
					status: "completed",
				},
			},
			settlement(setup.execution, completedEvidence()),
			{ type: "artifact-declared", data: { artifact: output } },
			{
				type: "task-execution-artifact-imported",
				data: {
					executionId: setup.execution.id,
					subagentRunId: "run_child",
					artifactId: output.id,
					sourceResultSha256: resultSha256,
				},
			},
			...releaseEvents(setup.execution, "completed"),
			{
				type: "task-execution-terminal",
				data: {
					executionId: setup.execution.id,
					outcome: "completed",
					evidence: completedEvidence(),
				},
			},
			{
				type: "task-status-changed",
				data: { taskId: setup.taskId, from: "ready", to: "completed" },
			},
		];
		const state = reduceWorkflowEvents(records(events));
		expect(state.tasks[setup.taskId]?.status).toBe("completed");
	});

	it("replaces cleanup-blocked evidence after reconciliation", () => {
		const setup = setupEvents();
		const failure = {
			code: "sandbox-cleanup" as const,
			origin: "sandbox" as const,
			retry: "reconcile" as const,
			message: "cleanup is not yet proved",
			guidance: "Reconcile the child.",
		};
		const usage = completedEvidence().usage;
		const cleanupEvidence: SubagentTerminalEvidence = {
			kind: "subagent",
			attemptOrdinal: 1,
			resultSha256,
			status: "cleanup-blocked",
			usage,
			usageComplete: true,
			runtimeMs: 1000,
			failure,
			sandboxCleanup: "blocked",
			workspaceCleanup: "not-needed",
			truncated: false,
		};
		const failedEvidence: SubagentTerminalEvidence = {
			kind: "subagent",
			attemptOrdinal: 1,
			resultSha256: "3".repeat(64),
			status: "failed",
			usage,
			usageComplete: true,
			runtimeMs: 1200,
			failure: { ...failure, code: "sandbox-launch", retry: "never" },
			sandboxCleanup: "proved",
			workspaceCleanup: "not-needed",
			truncated: false,
		};
		const events: WorkflowEventInput[] = [
			...setup.events,
			...preflightEvents(setup.execution),
			{
				type: "task-execution-launch-receipted",
				data: {
					executionId: setup.execution.id,
					operationId: setup.execution.operationId,
					subagentRunId: "run_child",
					subagentAttemptId: "attempt_child",
					status: "active",
				},
			},
			{
				type: "task-status-changed",
				data: { taskId: setup.taskId, from: "ready", to: "running" },
			},
			{
				type: "task-execution-child-observed",
				data: {
					executionId: setup.execution.id,
					subagentRunId: "run_child",
					subagentAttemptId: "attempt_child",
					status: "cleanup-blocked",
				},
			},
			settlement(setup.execution, cleanupEvidence),
			...releaseEvents(setup.execution, "cleanup-blocked"),
			{
				type: "task-execution-terminal",
				data: {
					executionId: setup.execution.id,
					outcome: "cleanup-blocked",
					evidence: cleanupEvidence,
				},
			},
			{
				type: "task-status-changed",
				data: {
					taskId: setup.taskId,
					from: "running",
					to: "cleanup-blocked",
				},
			},
			{
				type: "task-execution-child-observed",
				data: {
					executionId: setup.execution.id,
					subagentRunId: "run_child",
					subagentAttemptId: "attempt_child",
					status: "failed",
				},
			},
			settlement(setup.execution, failedEvidence),
			...releaseEvents(setup.execution, "failed"),
			{
				type: "task-execution-terminal",
				data: {
					executionId: setup.execution.id,
					outcome: "failed",
					evidence: failedEvidence,
				},
			},
			{
				type: "task-status-changed",
				data: {
					taskId: setup.taskId,
					from: "cleanup-blocked",
					to: "failed",
				},
			},
		];
		const state = reduceWorkflowEvents(records(events));
		expect(state.executions[setup.execution.id]?.terminal).toMatchObject({
			outcome: "failed",
			evidence: { kind: "subagent", status: "failed" },
		});
		expect(state.tasks[setup.taskId]?.status).toBe("failed");
	});

	it("terminalizes a preflight failure without a child identity", () => {
		const setup = setupEvents();
		const events: WorkflowEventInput[] = [
			...setup.events,
			{
				type: "task-execution-terminal",
				data: {
					executionId: setup.execution.id,
					outcome: "failed",
					evidence: {
						kind: "workflow",
						stage: "preflight",
						failureSha256: deriveWorkflowFailureSha256(
							"preflight",
							"agent is unavailable",
						),
						message: "agent is unavailable",
					},
				},
			},
			{
				type: "task-status-changed",
				data: { taskId: setup.taskId, from: "ready", to: "failed" },
			},
		];
		const state = reduceWorkflowEvents(records(events));
		expect(state.executions[setup.execution.id]?.terminal).toMatchObject({
			outcome: "failed",
			evidence: { kind: "workflow", stage: "preflight" },
		});
		expect(state.tasks[setup.taskId]?.status).toBe("failed");
	});

	it("does not bind one subagent run to two task executions", () => {
		const materializer = new WorkflowTaskMaterializer({
			runId: "workflow_execution",
			definitionIdentitySha256,
			inputSha256,
		});
		const first = materializer.agent("first", request());
		const second = materializer.agent("second", request());
		const commit = materializer.closeEpoch("final", [first, second]);
		const declarations = commit.events.filter(
			(event) => event.type === "task-declared",
		);
		const firstDeclaration = declarations[0];
		const secondDeclaration = declarations[1];
		if (
			firstDeclaration?.type !== "task-declared" ||
			secondDeclaration?.type !== "task-declared"
		) {
			throw new Error("missing task declarations");
		}
		const firstExecution = execution(
			first.ref.taskId,
			firstDeclaration.data.task.spec.identitySha256,
		);
		const secondExecution = execution(
			second.ref.taskId,
			secondDeclaration.data.task.spec.identitySha256,
		);
		const receipt = (record: AgentTaskExecutionRecord): WorkflowEventInput => ({
			type: "task-execution-launch-receipted",
			data: {
				executionId: record.id,
				operationId: record.operationId,
				subagentRunId: "run_shared",
				subagentAttemptId: "attempt_shared",
				status: "active",
			},
		});
		expect(() =>
			reduceWorkflowEvents(
				records([
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
					{
						type: "task-status-changed",
						data: { taskId: second.ref.taskId, from: "pending", to: "ready" },
					},
					{
						type: "task-execution-created",
						data: { execution: firstExecution },
					},
					...preflightEvents(firstExecution),
					receipt(firstExecution),
					{
						type: "task-execution-created",
						data: { execution: secondExecution },
					},
					...preflightEvents(secondExecution),
					receipt(secondExecution),
				]),
			),
		).toThrow("launch receipt is out of order");
	});

	it("rejects missing intent, changed identities, and duplicate evidence", () => {
		const setup = setupEvents();
		const receipt: WorkflowEventInput = {
			type: "task-execution-launch-receipted",
			data: {
				executionId: setup.execution.id,
				operationId: setup.execution.operationId,
				subagentRunId: "run_child",
				subagentAttemptId: "attempt_child",
				status: "active",
			},
		};
		expect(() =>
			reduceWorkflowEvents(records([...setup.events, receipt])),
		).toThrow("launch receipt is out of order");

		const preflight = preflightEvents(setup.execution)[0];
		if (preflight?.type !== "task-execution-preflighted") {
			throw new Error("missing preflight event");
		}
		expect(() =>
			reduceWorkflowEvents(
				records([
					...setup.events,
					{
						...preflight,
						data: {
							...preflight.data,
							operationId: `workflow-op_${"9".repeat(64)}`,
						},
					},
				]),
			),
		).toThrow("preflight is out of order");
	});

	it("rejects unsupported generations and running without execution", () => {
		const setup = setupEvents();
		const created = setup.events.at(-1);
		if (
			created?.type !== "task-execution-created" ||
			created.data.execution.kind !== "agent"
		) {
			throw new Error("missing execution event");
		}
		const generation = 2;
		const changed: WorkflowEventInput = {
			type: "task-execution-created",
			data: {
				execution: {
					...created.data.execution,
					generation,
					id: deriveTaskExecutionId(
						"workflow_execution",
						setup.taskId,
						generation,
					),
					operationId: deriveSubagentOperationId(
						"workflow_execution",
						setup.taskId,
						generation,
					),
				},
			},
		};
		expect(() =>
			reduceWorkflowEvents(records([...setup.events.slice(0, -1), changed])),
		).toThrow("generation is not contiguous");
		expect(() =>
			reduceWorkflowEvents(records([...setup.events, changed])),
		).toThrow("supersedes an active execution");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...setup.events.slice(0, -1),
					{
						type: "task-status-changed",
						data: {
							taskId: setup.taskId,
							from: "ready",
							to: "running",
						},
					},
				]),
			),
		).toThrow("without an active execution");
	});

	it("rebuilds execution evidence after lease ownership changes", async () => {
		const root = path.resolve(
			".pi",
			"test-execution",
			`restart-${randomUUID()}`,
		);
		const firstLease = await acquireWorkflowRunLease({
			storeRoot: root,
			runId: "workflow_execution",
			ownerId: "first-owner",
		});
		const first = await WorkflowRunJournal.open(
			root,
			"workflow_execution",
			firstLease,
		);
		const setup = setupEvents();
		for (const event of setup.events) await first.appendEvent(event);
		const beforeRestart = await rebuildWorkflowSnapshot(first);
		await firstLease.release();

		const secondLease = await acquireWorkflowRunLease({
			storeRoot: root,
			runId: "workflow_execution",
			ownerId: "second-owner",
		});
		try {
			const second = await WorkflowRunJournal.open(
				root,
				"workflow_execution",
				secondLease,
			);
			expect(await second.readSnapshot()).toEqual(beforeRestart);
			const preflight = preflightEvents(setup.execution)[0];
			if (!preflight) throw new Error("missing preflight event");
			await second.appendEvent(preflight);
			expect(await second.readSnapshot()).toBeUndefined();
			const rebuilt = await rebuildWorkflowSnapshot(second);
			expect(rebuilt.fencingGeneration).toBe(secondLease.record.generation);
			expect(
				rebuilt.state.executions[setup.execution.id]?.preflight
					?.planIdentitySha256,
			).toBe(planIdentitySha256);
		} finally {
			await secondLease.release();
		}
	});

	it("accepts every prefix and rebuilds the same final projection", () => {
		const setup = setupEvents();
		const events: WorkflowEventInput[] = [
			...setup.events,
			...preflightEvents(setup.execution),
			{
				type: "task-execution-launch-uncertain",
				data: {
					executionId: setup.execution.id,
					operationId: setup.execution.operationId,
					reason: "timeout",
				},
			},
		];
		for (let length = 1; length <= events.length; length += 1) {
			expect(() =>
				reduceWorkflowEvents(records(events.slice(0, length))),
			).not.toThrow();
		}
		const first = reduceWorkflowEvents(records(events));
		const second = reduceWorkflowEvents(records(structuredClone(events)));
		expect(second).toEqual(first);
	});
});

function completedAgentEvents(
	taskId: WorkflowTaskId,
	record: AgentTaskExecutionRecord,
): WorkflowEventInput[] {
	const output = artifact(taskId);
	return [
		{
			type: "task-status-changed",
			data: { taskId, from: "pending", to: "ready" },
		},
		{ type: "task-execution-created", data: { execution: record } },
		...preflightEvents(record),
		{
			type: "task-execution-launch-receipted",
			data: {
				executionId: record.id,
				operationId: record.operationId,
				subagentRunId: "run_child",
				subagentAttemptId: "attempt_child",
				status: "active",
			},
		},
		{
			type: "task-status-changed",
			data: { taskId, from: "ready", to: "running" },
		},
		{
			type: "task-execution-child-observed",
			data: {
				executionId: record.id,
				subagentRunId: "run_child",
				subagentAttemptId: "attempt_child",
				status: "completed",
			},
		},
		settlement(record, completedEvidence()),
		{ type: "artifact-declared", data: { artifact: output } },
		{
			type: "task-execution-artifact-imported",
			data: {
				executionId: record.id,
				subagentRunId: "run_child",
				artifactId: output.id,
				sourceResultSha256: resultSha256,
			},
		},
		...releaseEvents(record, "completed"),
		{
			type: "task-execution-terminal",
			data: {
				executionId: record.id,
				outcome: "completed",
				evidence: completedEvidence(),
			},
		},
		{
			type: "task-status-changed",
			data: { taskId, from: "running", to: "completed" },
		},
	];
}

function supportExecution(
	task: MaterializedSupportTask,
): SupportTaskExecutionRecord {
	const generation = 1;
	return {
		kind: "support",
		id: deriveTaskExecutionId("workflow_execution", task.id, generation),
		runId: "workflow_execution",
		taskId: task.id,
		generation,
		taskIdentitySha256: task.spec.identitySha256,
		implementationIdentitySha256: deriveSupportImplementationIdentitySha256(
			task.spec.request.implementation,
		),
	};
}

function supportArtifact(
	task: MaterializedSupportTask,
	overrides: Partial<Pick<WorkflowArtifactRef, "sha256" | "schemaSha256">> = {},
): WorkflowArtifactRef {
	const input = {
		runId: "workflow_execution" as const,
		producerTaskId: task.id,
		producerExecutionId: deriveTaskExecutionId(
			"workflow_execution",
			task.id,
			1,
		),
		output: "result" as const,
		sha256: supportOutputSha256,
		schemaSha256: deriveJsonValueSha256(
			task.spec.request.implementation.outputSchema,
		),
		...overrides,
	};
	return {
		id: deriveWorkflowArtifactId(input),
		...input,
		bytes: 17,
		mediaType: "application/json",
	};
}

function supportIntent(
	task: MaterializedSupportTask,
	record: SupportTaskExecutionRecord,
): {
	implementationIdentitySha256: string;
	parametersSha256: string;
	inputsSha256: string;
} {
	return {
		implementationIdentitySha256: record.implementationIdentitySha256,
		parametersSha256: deriveJsonValueSha256(task.spec.request.parameters),
		inputsSha256: deriveJsonValueSha256({ answer: structuredOutputSha256 }),
	};
}

function supportEvidence(
	task: MaterializedSupportTask,
	record: SupportTaskExecutionRecord,
): SupportTaskTerminalEvidence {
	return {
		kind: "support",
		...supportIntent(task, record),
		outputSha256: supportOutputSha256,
		artifactId: supportArtifact(task).id,
		durationMs: 12,
	};
}

function setupSupportEvents(): {
	task: MaterializedSupportTask;
	execution: SupportTaskExecutionRecord;
	events: WorkflowEventInput[];
} {
	const materializer = new WorkflowTaskMaterializer({
		runId: "workflow_execution",
		definitionIdentitySha256,
		inputSha256,
	});
	const producer = materializer.agent("answer", request());
	const support = materializer.support(
		"summarize",
		supportHelper({
			parameters: { strict: true },
			inputs: { answer: producer.output },
		}),
	);
	const commit = materializer.closeEpoch("final", [support]);
	const declarations = commit.events.filter(
		(event) => event.type === "task-declared",
	);
	const producerDeclaration = declarations[0];
	const supportDeclaration = declarations[1];
	if (
		producerDeclaration?.type !== "task-declared" ||
		supportDeclaration?.type !== "task-declared" ||
		supportDeclaration.data.task.spec.kind !== "support"
	) {
		throw new Error("missing task declarations");
	}
	const task = supportDeclaration.data.task as MaterializedSupportTask;
	const record = supportExecution(task);
	return {
		task,
		execution: record,
		events: [
			runCreated(),
			...commit.events,
			{
				type: "run-status-changed",
				data: { from: "created", to: "running" },
			},
			...completedAgentEvents(
				producer.ref.taskId,
				execution(
					producer.ref.taskId,
					producerDeclaration.data.task.spec.identitySha256,
				),
			),
			{
				type: "task-status-changed",
				data: { taskId: task.id, from: "pending", to: "ready" },
			},
			{ type: "task-execution-created", data: { execution: record } },
		],
	};
}

function intended(
	setup: ReturnType<typeof setupSupportEvents>,
): WorkflowEventInput[] {
	return [
		...setup.events,
		{
			type: "task-execution-support-intended",
			data: {
				executionId: setup.execution.id,
				...supportIntent(setup.task, setup.execution),
			},
		},
		{
			type: "task-status-changed",
			data: { taskId: setup.task.id, from: "ready", to: "running" },
		},
	];
}

function workflowFailure(
	executionId: string,
	outcome: "failed" | "cancelled",
	stage: Parameters<typeof deriveWorkflowFailureSha256>[0],
	message: string,
): WorkflowEventInput {
	return {
		type: "task-execution-terminal",
		data: {
			executionId,
			outcome,
			evidence: {
				kind: "workflow",
				stage,
				failureSha256: deriveWorkflowFailureSha256(stage, message),
				message,
			},
		},
	};
}

describe("support task execution persistence", () => {
	it("reduces a complete successful support execution", () => {
		const setup = setupSupportEvents();
		const output = supportArtifact(setup.task);
		const events: WorkflowEventInput[] = [
			...intended(setup),
			{ type: "artifact-declared", data: { artifact: output } },
			{
				type: "task-execution-support-output-committed",
				data: {
					executionId: setup.execution.id,
					artifactId: output.id,
					outputSha256: supportOutputSha256,
				},
			},
			{
				type: "task-execution-terminal",
				data: {
					executionId: setup.execution.id,
					outcome: "completed",
					evidence: supportEvidence(setup.task, setup.execution),
				},
			},
			{
				type: "task-status-changed",
				data: { taskId: setup.task.id, from: "running", to: "completed" },
			},
		];
		for (let length = 1; length <= events.length; length += 1) {
			expect(() =>
				reduceWorkflowEvents(records(events.slice(0, length))),
			).not.toThrow();
		}
		const state = reduceWorkflowEvents(records(events));
		expect(state.executions[setup.execution.id]).toMatchObject({
			phase: "terminal",
			execution: setup.execution,
			supportIntent: supportIntent(setup.task, setup.execution),
			supportOutput: {
				artifactId: output.id,
				outputSha256: supportOutputSha256,
			},
			terminal: { outcome: "completed", evidence: { kind: "support" } },
		});
		expect(state.tasks[setup.task.id]?.status).toBe("completed");
	});

	it("rejects support execution records that do not match their task", () => {
		const setup = setupSupportEvents();
		const prefix = setup.events.slice(0, -1);
		const agentShaped: WorkflowEventInput = {
			type: "task-execution-created",
			data: {
				execution: {
					kind: "agent",
					id: setup.execution.id,
					runId: setup.execution.runId,
					taskId: setup.execution.taskId,
					generation: 1,
					taskIdentitySha256: setup.execution.taskIdentitySha256,
					operationId: deriveSubagentOperationId(
						"workflow_execution",
						setup.task.id,
						1,
					),
				},
			},
		};
		expect(() =>
			reduceWorkflowEvents(records([...prefix, agentShaped])),
		).toThrow("task execution kind does not match its task");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...prefix,
					{
						type: "task-execution-created",
						data: {
							execution: {
								...setup.execution,
								implementationIdentitySha256: "9".repeat(64),
							},
						},
					},
				]),
			),
		).toThrow("implementation identity does not match");

		const agent = setupEvents();
		const created = agent.events.at(-1);
		if (created?.type !== "task-execution-created") {
			throw new Error("missing execution event");
		}
		expect(() =>
			reduceWorkflowEvents(
				records([
					...agent.events.slice(0, -1),
					{
						type: "task-execution-created",
						data: {
							execution: {
								kind: "support",
								id: agent.execution.id,
								runId: agent.execution.runId,
								taskId: agent.execution.taskId,
								generation: 1,
								taskIdentitySha256: agent.execution.taskIdentitySha256,
								implementationIdentitySha256: "9".repeat(64),
							},
						},
					},
				]),
			),
		).toThrow("task execution kind does not match its task");
	});

	it("rejects support intent with mismatched digests", () => {
		const setup = setupSupportEvents();
		const intent = supportIntent(setup.task, setup.execution);
		for (const key of Object.keys(intent) as Array<keyof typeof intent>) {
			expect(() =>
				reduceWorkflowEvents(
					records([
						...setup.events,
						{
							type: "task-execution-support-intended",
							data: {
								executionId: setup.execution.id,
								...intent,
								[key]: "9".repeat(64),
							},
						},
					]),
				),
			).toThrow("support task intent does not match its task");
		}
		expect(() =>
			reduceWorkflowEvents(
				records([
					...setup.events,
					{
						type: "task-status-changed",
						data: { taskId: setup.task.id, from: "ready", to: "running" },
					},
				]),
			),
		).toThrow("support task became running without persisted intent");
	});

	it("rejects output commits whose artifact digest or schema differ", () => {
		const setup = setupSupportEvents();
		const output = supportArtifact(setup.task);
		const wrongSchema = supportArtifact(setup.task, {
			schemaSha256: "9".repeat(64),
		});
		const commit = (artifactId: string): WorkflowEventInput => ({
			type: "task-execution-support-output-committed",
			data: {
				executionId: setup.execution.id,
				artifactId,
				outputSha256: supportOutputSha256,
			},
		});
		expect(() =>
			reduceWorkflowEvents(
				records([
					...intended(setup),
					{
						type: "artifact-declared",
						data: {
							artifact: supportArtifact(setup.task, {
								sha256: "8".repeat(64),
							}),
						},
					},
					commit(supportArtifact(setup.task, { sha256: "8".repeat(64) }).id),
				]),
			),
		).toThrow("support task output artifact does not match");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...intended(setup),
					{ type: "artifact-declared", data: { artifact: wrongSchema } },
					commit(wrongSchema.id),
				]),
			),
		).toThrow("support task output artifact does not match");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...setup.events,
					{ type: "artifact-declared", data: { artifact: output } },
					commit(output.id),
				]),
			),
		).toThrow("support task output commit is out of order");
	});

	it("rejects support terminal evidence before the output commit", () => {
		const setup = setupSupportEvents();
		const output = supportArtifact(setup.task);
		const terminal: WorkflowEventInput = {
			type: "task-execution-terminal",
			data: {
				executionId: setup.execution.id,
				outcome: "completed",
				evidence: supportEvidence(setup.task, setup.execution),
			},
		};
		expect(() =>
			reduceWorkflowEvents(
				records([
					...intended(setup),
					{ type: "artifact-declared", data: { artifact: output } },
					terminal,
				]),
			),
		).toThrow("support terminal evidence precedes output commit");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...intended(setup),
					{ type: "artifact-declared", data: { artifact: output } },
					{
						type: "task-execution-support-output-committed",
						data: {
							executionId: setup.execution.id,
							artifactId: output.id,
							outputSha256: supportOutputSha256,
						},
					},
					{
						...terminal,
						data: {
							...terminal.data,
							evidence: {
								...supportEvidence(setup.task, setup.execution),
								inputsSha256: "9".repeat(64),
							},
						},
					},
				]),
			),
		).toThrow("support terminal intent does not match");
		const agent = setupEvents();
		expect(() =>
			reduceWorkflowEvents(
				records([
					...agent.events,
					{
						type: "task-execution-terminal",
						data: {
							executionId: agent.execution.id,
							outcome: "completed",
							evidence: supportEvidence(setup.task, setup.execution),
						},
					},
				]),
			),
		).toThrow("agent task has support terminal evidence");
	});

	it("rejects subagent-shaped events on a support execution", () => {
		const setup = setupSupportEvents();
		const executionId = setup.execution.id;
		const operationId = deriveSubagentOperationId(
			"workflow_execution",
			setup.task.id,
			1,
		);
		const subagentShaped: WorkflowEventInput[] = [
			{
				type: "task-execution-preflighted",
				data: {
					executionId,
					operationId,
					preflightId: "preflight-1",
					planIdentitySha256,
					plannedSubagentRunId: "run_child",
					plannedSubagentAttemptId: "attempt_child",
					expiresAt: "2026-09-01T01:00:00.000Z",
					workspaceMode: "read-only",
					workspaceBaselineSha256: "c".repeat(64),
				},
			},
			{
				type: "task-execution-launch-uncertain",
				data: { executionId, operationId, reason: "timeout" },
			},
			{
				type: "task-execution-child-observed",
				data: {
					executionId,
					subagentRunId: "run_child",
					subagentAttemptId: "attempt_child",
					status: "active",
				},
			},
			{
				type: "task-execution-release-intended",
				data: { executionId, subagentRunId: "run_child" },
			},
		];
		for (const event of subagentShaped) {
			expect(() =>
				reduceWorkflowEvents(records([...setup.events, event])),
			).toThrow("subagent execution event targets a support execution");
		}
		expect(() =>
			reduceWorkflowEvents(
				records([
					...setup.events,
					{
						type: "task-execution-terminal",
						data: {
							executionId,
							outcome: "completed",
							evidence: completedEvidence(),
						},
					},
				]),
			),
		).toThrow("support task has subagent terminal evidence");
		const agent = setupEvents();
		expect(() =>
			reduceWorkflowEvents(
				records([
					...agent.events,
					{
						type: "task-execution-support-intended",
						data: {
							executionId: agent.execution.id,
							...supportIntent(setup.task, setup.execution),
						},
					},
				]),
			),
		).toThrow("support execution event targets an agent execution");
	});

	it("binds workflow failure stages to the task kind", () => {
		const setup = setupSupportEvents();
		for (const stage of [
			"preflight",
			"launch",
			"reconciliation",
			"artifact-import",
			"release",
		] as const) {
			expect(() =>
				reduceWorkflowEvents(
					records([
						...setup.events,
						workflowFailure(setup.execution.id, "failed", stage, "boom"),
					]),
				),
			).toThrow("workflow terminal evidence is inconsistent");
		}
		const agent = setupEvents();
		for (const stage of [
			"support-resolution",
			"support-input",
			"support-execution",
			"support-output",
		] as const) {
			expect(() =>
				reduceWorkflowEvents(
					records([
						...agent.events,
						workflowFailure(agent.execution.id, "failed", stage, "boom"),
					]),
				),
			).toThrow("workflow terminal evidence is inconsistent");
		}
		const failed = reduceWorkflowEvents(
			records([
				...intended(setup),
				workflowFailure(
					setup.execution.id,
					"failed",
					"support-execution",
					"implementation threw",
				),
				{
					type: "task-status-changed",
					data: { taskId: setup.task.id, from: "running", to: "failed" },
				},
			]),
		);
		expect(failed.executions[setup.execution.id]?.terminal).toMatchObject({
			outcome: "failed",
			evidence: { kind: "workflow", stage: "support-execution" },
		});
		expect(failed.tasks[setup.task.id]?.status).toBe("failed");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...intended(setup),
					workflowFailure(
						setup.execution.id,
						"cancelled",
						"support-execution",
						"stopped",
					),
				]),
			),
		).toThrow("workflow terminal evidence is inconsistent");
	});

	it("cancels an intended support execution on stop", () => {
		const setup = setupSupportEvents();
		const state = reduceWorkflowEvents(
			records([
				...intended(setup),
				{
					type: "run-status-changed",
					data: { from: "running", to: "stopping" },
				},
				workflowFailure(setup.execution.id, "cancelled", "stop", "stopped"),
				{
					type: "task-status-changed",
					data: { taskId: setup.task.id, from: "running", to: "cancelled" },
				},
			]),
		);
		expect(state.executions[setup.execution.id]?.terminal).toMatchObject({
			outcome: "cancelled",
			evidence: { kind: "workflow", stage: "stop" },
		});
		expect(state.tasks[setup.task.id]?.status).toBe("cancelled");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...intended(setup),
					{
						type: "task-status-changed",
						data: { taskId: setup.task.id, from: "running", to: "waiting" },
					},
				]),
			),
		).toThrow("support task may not wait");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...intended(setup),
					{
						type: "run-status-changed",
						data: { from: "running", to: "stopping" },
					},
					{
						type: "task-status-changed",
						data: {
							taskId: setup.task.id,
							from: "running",
							to: "cancelling",
						},
					},
				]),
			),
		).toThrow("support task may not enter cancelling");
	});
});

const childDefinitionIdentitySha256 = "2".repeat(64);
const childDefinitionSourceSha256 = "3".repeat(64);
const nestedOutputSha256 = "4".repeat(64);
const childOutputArtifactId = `artifact_${"5".repeat(64)}`;
const nestedUsage = { cost: 0.5, totalTokens: 1_200, childRuntimeMs: 4_000 };

function nestedRequest(): NestedWorkflowTaskRequest {
	const input = { topic: "nested" };
	return {
		definitionName: "child",
		definitionIdentitySha256: childDefinitionIdentitySha256,
		definitionSourceSha256: childDefinitionSourceSha256,
		definitionVersion: 1,
		input,
		inputSha256: deriveJsonValueSha256(input),
		inputSchema: { type: "object" },
		outputSchema: {
			type: "object",
			properties: { summary: { type: "string" } },
			required: ["summary"],
			additionalProperties: false,
		},
		budget: { cost: 10, totalTokens: 100_000, childRuntimeMs: 600_000 },
		timeoutMs: 600_000,
		concurrency: 2,
	};
}

function nestedTask(
	options: {
		key?: string;
		position?: number;
		request?: Partial<NestedWorkflowTaskRequest>;
		after?: MaterializedNestedWorkflowTask["spec"]["after"];
		inputs?: MaterializedNestedWorkflowTask["spec"]["inputs"];
	} = {},
): MaterializedNestedWorkflowTask {
	const key = options.key ?? "child";
	const position = options.position ?? 1;
	const namespace: string[] = [];
	const spec = {
		key,
		kind: "workflow" as const,
		role: "task" as const,
		disposition: "required" as const,
		after: options.after ?? [],
		inputs: options.inputs ?? {},
		replay: "read-only" as const,
		request: { ...nestedRequest(), ...options.request },
	};
	return {
		id: deriveWorkflowTaskId("workflow_execution", namespace, key),
		runId: "workflow_execution",
		namespace,
		spec: {
			...spec,
			identitySha256: deriveNestedWorkflowTaskIdentity({
				definitionIdentitySha256,
				inputSha256,
				namespace,
				spec,
			}),
		},
		definitionIdentitySha256,
		materializationSequence: position,
		materializationEpoch: 1,
		epochPosition: position,
	};
}

function nestedExecution(
	task: MaterializedNestedWorkflowTask,
): NestedWorkflowTaskExecutionRecord {
	return {
		kind: "workflow",
		id: deriveTaskExecutionId("workflow_execution", task.id, 1),
		runId: "workflow_execution",
		taskId: task.id,
		generation: 1,
		taskIdentitySha256: task.spec.identitySha256,
		childRunId: deriveNestedWorkflowRunId("workflow_execution", task.id, 1),
	};
}

function nestedArtifact(
	task: MaterializedNestedWorkflowTask,
): WorkflowArtifactRef {
	const input = {
		runId: "workflow_execution" as const,
		producerTaskId: task.id,
		producerExecutionId: deriveTaskExecutionId(
			"workflow_execution",
			task.id,
			1,
		),
		output: "result" as const,
		sha256: nestedOutputSha256,
		schemaSha256: deriveJsonValueSha256(task.spec.request.outputSchema),
	};
	return {
		id: deriveWorkflowArtifactId(input),
		...input,
		bytes: 20,
		mediaType: "application/json",
	};
}

type NestedSetup = {
	task: MaterializedNestedWorkflowTask;
	execution: NestedWorkflowTaskExecutionRecord;
	events: WorkflowEventInput[];
};

function setupNestedEvents(task = nestedTask()): NestedSetup {
	const record = nestedExecution(task);
	return {
		task,
		execution: record,
		events: [
			runCreated(),
			{ type: "task-declared", data: { task } },
			{
				type: "barrier-reached",
				data: { epoch: 1, kind: "final", taskIds: [task.id] },
			},
			{
				type: "run-status-changed",
				data: { from: "created", to: "running" },
			},
			{
				type: "task-status-changed",
				data: { taskId: task.id, from: "pending", to: "ready" },
			},
			{ type: "task-execution-created", data: { execution: record } },
		],
	};
}

function nestedIntent(
	setup: NestedSetup,
	overrides: Partial<
		Extract<
			WorkflowEventInput,
			{ type: "task-execution-nested-intended" }
		>["data"]
	> = {},
): WorkflowEventInput {
	const request = setup.task.spec.request;
	return {
		type: "task-execution-nested-intended",
		data: {
			executionId: setup.execution.id,
			childRunId: setup.execution.childRunId,
			definitionIdentitySha256: request.definitionIdentitySha256,
			inputSha256: request.inputSha256,
			inputsSha256: deriveJsonValueSha256({}),
			resolvedInputSha256: request.inputSha256,
			budget: structuredClone(request.budget),
			timeoutMs: request.timeoutMs,
			deadlineAt: "2026-09-01T00:10:00.000Z",
			concurrency: request.concurrency,
			...overrides,
		},
	};
}

function nestedLaunched(
	setup: NestedSetup,
	childRunId = setup.execution.childRunId,
): WorkflowEventInput {
	return {
		type: "task-execution-nested-launched",
		data: { executionId: setup.execution.id, childRunId },
	};
}

function nestedSettled(
	setup: NestedSetup,
	status: WorkflowRunStatus,
	output?: { outputArtifactId?: string; outputSha256?: string },
): WorkflowEventInput {
	return {
		type: "task-execution-nested-settled",
		data: {
			executionId: setup.execution.id,
			childRunId: setup.execution.childRunId,
			status,
			usage: { ...nestedUsage },
			usageComplete: true,
			...output,
		},
	};
}

function completedSettlement(setup: NestedSetup): WorkflowEventInput {
	return nestedSettled(setup, "completed", {
		outputArtifactId: childOutputArtifactId,
		outputSha256: nestedOutputSha256,
	});
}

function nestedImported(
	setup: NestedSetup,
	artifact: WorkflowArtifactRef,
	overrides: { sourceArtifactId?: string; sourceSha256?: string } = {},
): WorkflowEventInput {
	return {
		type: "task-execution-nested-output-imported",
		data: {
			executionId: setup.execution.id,
			childRunId: setup.execution.childRunId,
			artifactId: artifact.id,
			sourceArtifactId: childOutputArtifactId,
			sourceSha256: nestedOutputSha256,
			...overrides,
		},
	};
}

function nestedEvidence(
	setup: NestedSetup,
	status: WorkflowRunStatus,
	extras: Partial<NestedWorkflowTerminalEvidence> = {},
): NestedWorkflowTerminalEvidence {
	return {
		kind: "nested-workflow",
		childRunId: setup.execution.childRunId,
		status,
		usage: { ...nestedUsage },
		usageComplete: true,
		...extras,
	};
}

function nestedTerminal(
	setup: NestedSetup,
	outcome:
		| "completed"
		| "failed"
		| "cancelled"
		| "interrupted"
		| "cleanup-blocked",
	evidence: NestedWorkflowTerminalEvidence,
): WorkflowEventInput {
	return {
		type: "task-execution-terminal",
		data: { executionId: setup.execution.id, outcome, evidence },
	};
}

function launched(setup: NestedSetup): WorkflowEventInput[] {
	return [
		...setup.events,
		nestedIntent(setup),
		nestedLaunched(setup),
		{
			type: "task-status-changed",
			data: { taskId: setup.task.id, from: "ready", to: "running" },
		},
	];
}

function completedLadder(setup: NestedSetup): WorkflowEventInput[] {
	const artifact = nestedArtifact(setup.task);
	return [
		...launched(setup),
		completedSettlement(setup),
		{ type: "artifact-declared", data: { artifact } },
		nestedImported(setup, artifact),
		nestedTerminal(
			setup,
			"completed",
			nestedEvidence(setup, "completed", {
				outputSha256: nestedOutputSha256,
				artifactId: artifact.id,
			}),
		),
		{
			type: "task-status-changed",
			data: { taskId: setup.task.id, from: "running", to: "completed" },
		},
	];
}

function setupNestedInputEvents(
	options: { after?: boolean } = {},
): NestedSetup & { producerTaskId: WorkflowTaskId } {
	const materializer = new WorkflowTaskMaterializer({
		runId: "workflow_execution",
		definitionIdentitySha256,
		inputSha256,
	});
	const producer = materializer.agent("answer", request());
	const producerDeclaration = materializer
		.closeEpoch("final", [producer])
		.events.find((event) => event.type === "task-declared");
	if (producerDeclaration?.type !== "task-declared") {
		throw new Error("missing producer declaration");
	}
	const task = nestedTask({
		position: 2,
		after: options.after === false ? [] : [producer.ref],
		inputs: { answer: producer.output.ref },
	});
	const record = nestedExecution(task);
	return {
		task,
		execution: record,
		producerTaskId: producer.ref.taskId,
		events: [
			runCreated(),
			producerDeclaration,
			{ type: "task-declared", data: { task } },
			{
				type: "barrier-reached",
				data: { epoch: 1, kind: "final", taskIds: [task.id] },
			},
			{
				type: "run-status-changed",
				data: { from: "created", to: "running" },
			},
			...completedAgentEvents(
				producer.ref.taskId,
				execution(
					producer.ref.taskId,
					producerDeclaration.data.task.spec.identitySha256,
				),
			),
			{
				type: "task-status-changed",
				data: { taskId: task.id, from: "pending", to: "ready" },
			},
			{ type: "task-execution-created", data: { execution: record } },
		],
	};
}

describe("nested workflow task execution persistence", () => {
	it("derives a deterministic child run identity", () => {
		const childRunId = deriveNestedWorkflowRunId(
			"workflow_execution",
			"task_abc123",
			1,
		);
		expect(childRunId).toMatch(/^workflow_[a-z0-9]+$/);
		expect(
			deriveNestedWorkflowRunId("workflow_execution", "task_abc123", 1),
		).toBe(childRunId);
		expect(
			deriveNestedWorkflowRunId("workflow_execution", "task_abc123", 2),
		).not.toBe(childRunId);
		expect(
			deriveNestedWorkflowRunId("workflow_other", "task_abc123", 1),
		).not.toBe(childRunId);
	});

	it("reduces a complete successful nested workflow ladder", () => {
		const setup = setupNestedEvents();
		const artifact = nestedArtifact(setup.task);
		const events = completedLadder(setup);
		for (let length = 1; length <= events.length; length += 1) {
			expect(() =>
				reduceWorkflowEvents(records(events.slice(0, length))),
			).not.toThrow();
		}
		const state = reduceWorkflowEvents(records(events));
		expect(state.executions[setup.execution.id]).toMatchObject({
			phase: "terminal",
			execution: setup.execution,
			nestedIntent: {
				childRunId: setup.execution.childRunId,
				definitionIdentitySha256: childDefinitionIdentitySha256,
				budget: nestedRequest().budget,
			},
			nestedLaunch: { childRunId: setup.execution.childRunId },
			nestedSettlement: {
				status: "completed",
				usage: nestedUsage,
				outputArtifactId: childOutputArtifactId,
				outputSha256: nestedOutputSha256,
			},
			nestedOutputImport: {
				artifactId: artifact.id,
				sourceArtifactId: childOutputArtifactId,
				sourceSha256: nestedOutputSha256,
			},
			terminal: {
				outcome: "completed",
				evidence: { kind: "nested-workflow", status: "completed" },
			},
		});
		expect(state.tasks[setup.task.id]?.status).toBe("completed");
		expect(state.artifacts[artifact.id]).toEqual(artifact);
	});

	it("re-derives workflow task identity and validates the declaration", () => {
		const setup = setupNestedEvents();
		const forgedIdentity = {
			...setup.task,
			spec: { ...setup.task.spec, identitySha256: "9".repeat(64) },
		};
		expect(() =>
			reduceWorkflowEvents(
				records([
					runCreated(),
					{ type: "task-declared", data: { task: forgedIdentity } },
				]),
			),
		).toThrow("declared task identity digest does not match");
		expect(() =>
			reduceWorkflowEvents(
				records([
					runCreated(),
					{
						type: "task-declared",
						data: {
							task: nestedTask({ request: { inputSha256: "9".repeat(64) } }),
						},
					},
				]),
			),
		).toThrow("workflow task input digest does not match its input");
		expect(() =>
			reduceWorkflowEvents(
				records([
					runCreated(),
					{
						type: "task-declared",
						data: {
							task: nestedTask({
								inputs: {
									answer: {
										runId: "workflow_execution",
										producerTaskId: "task_abc123",
										output: "result",
									},
								},
							}),
						},
					},
				]),
			),
		).toThrow("task data dependency is unknown");
	});

	it("bounds the number of workflow tasks per run", () => {
		const declarations: WorkflowEventInput[] = [];
		for (let position = 1; position <= 64; position += 1) {
			declarations.push({
				type: "task-declared",
				data: { task: nestedTask({ key: `child-${position}`, position }) },
			});
		}
		expect(() =>
			reduceWorkflowEvents(records([runCreated(), ...declarations])),
		).not.toThrow();
		expect(() =>
			reduceWorkflowEvents(
				records([
					runCreated(),
					...declarations,
					{
						type: "task-declared",
						data: { task: nestedTask({ key: "child-65", position: 65 }) },
					},
				]),
			),
		).toThrow("workflow task count exceeds the nested workflow bound");
	});

	it("rejects execution records that do not match a workflow task", () => {
		const setup = setupNestedEvents();
		const prefix = setup.events.slice(0, -1);
		expect(() =>
			reduceWorkflowEvents(
				records([
					...prefix,
					{
						type: "task-execution-created",
						data: {
							execution: {
								kind: "agent",
								id: setup.execution.id,
								runId: setup.execution.runId,
								taskId: setup.execution.taskId,
								generation: 1,
								taskIdentitySha256: setup.execution.taskIdentitySha256,
								operationId: deriveSubagentOperationId(
									"workflow_execution",
									setup.task.id,
									1,
								),
							},
						},
					},
				]),
			),
		).toThrow("task execution kind does not match its task");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...prefix,
					{
						type: "task-execution-created",
						data: {
							execution: {
								...setup.execution,
								childRunId: deriveNestedWorkflowRunId(
									"workflow_execution",
									setup.task.id,
									2,
								),
							},
						},
					},
				]),
			),
		).toThrow("task execution identifiers are not deterministic");
		const agent = setupEvents();
		expect(() =>
			reduceWorkflowEvents(
				records([
					...agent.events.slice(0, -1),
					{
						type: "task-execution-created",
						data: {
							execution: {
								kind: "workflow",
								id: agent.execution.id,
								runId: agent.execution.runId,
								taskId: agent.execution.taskId,
								generation: 1,
								taskIdentitySha256: agent.execution.taskIdentitySha256,
								childRunId: deriveNestedWorkflowRunId(
									"workflow_execution",
									agent.taskId,
									1,
								),
							},
						},
					},
				]),
			),
		).toThrow("task execution kind does not match its task");
	});

	it("rejects nested intent that exceeds or mismatches the declaration", () => {
		const setup = setupNestedEvents();
		const reject = (event: WorkflowEventInput, message: string) => {
			expect(() =>
				reduceWorkflowEvents(records([...setup.events, event])),
			).toThrow(message);
		};
		reject(
			nestedIntent(setup, {
				budget: { cost: 11, totalTokens: 100_000, childRuntimeMs: 600_000 },
			}),
			"nested workflow intent exceeds its declared budget",
		);
		reject(
			nestedIntent(setup, {
				budget: { cost: 10, totalTokens: 100_001, childRuntimeMs: 600_000 },
			}),
			"nested workflow intent exceeds its declared budget",
		);
		reject(
			nestedIntent(setup, {
				budget: { cost: 10, childRuntimeMs: 600_000 },
			}),
			"nested workflow intent exceeds its declared budget",
		);
		reject(
			nestedIntent(setup, {
				budget: { cost: 10, totalTokens: 100_000, childRuntimeMs: 600_001 },
			}),
			"nested workflow intent exceeds its declared budget",
		);
		reject(
			nestedIntent(setup, { timeoutMs: 600_001 }),
			"nested workflow intent exceeds its declared limits",
		);
		reject(
			nestedIntent(setup, { concurrency: 3 }),
			"nested workflow intent exceeds its declared limits",
		);
		reject(
			nestedIntent(setup, { deadlineAt: "2026-09-01T00:10:00.001Z" }),
			"nested workflow intent deadline is invalid",
		);
		reject(
			nestedIntent(setup, { childRunId: "workflow_other" }),
			"nested workflow intent does not match its execution",
		);
		reject(
			nestedIntent(setup, { definitionIdentitySha256: "9".repeat(64) }),
			"nested workflow intent does not match its task",
		);
		reject(
			nestedIntent(setup, { inputSha256: "9".repeat(64) }),
			"nested workflow intent does not match its task",
		);
		expect(() =>
			reduceWorkflowEvents(
				records([...setup.events, nestedIntent(setup), nestedIntent(setup)]),
			),
		).toThrow("nested workflow intent is out of order");
		const withoutTokens = setupNestedEvents(
			nestedTask({
				request: { budget: { cost: 10, childRuntimeMs: 600_000 } },
			}),
		);
		expect(() =>
			reduceWorkflowEvents(
				records([
					...withoutTokens.events,
					nestedIntent(withoutTokens, {
						budget: { cost: 10, totalTokens: 5, childRuntimeMs: 600_000 },
					}),
				]),
			),
		).not.toThrow();
	});

	it("declares artifact inputs on a workflow task with their order dependency", () => {
		const setup = setupNestedInputEvents();
		const state = reduceWorkflowEvents(records(setup.events));
		expect(state.tasks[setup.task.id]).toMatchObject({
			status: "ready",
			committed: true,
			task: {
				spec: {
					inputs: {
						answer: {
							runId: "workflow_execution",
							producerTaskId: setup.producerTaskId,
							output: "result",
						},
					},
				},
			},
		});
		const withoutOrder = setupNestedInputEvents({ after: false });
		expect(() =>
			reduceWorkflowEvents(records(withoutOrder.events.slice(0, 3))),
		).toThrow("task data dependency lacks its order dependency");
		const unknownProducer = nestedTask({
			inputs: {
				answer: {
					runId: "workflow_execution",
					producerTaskId: `task_${"7".repeat(64)}`,
					output: "result",
				},
			},
		});
		expect(() =>
			reduceWorkflowEvents(
				records([
					runCreated(),
					{ type: "task-declared", data: { task: unknownProducer } },
				]),
			),
		).toThrow("task data dependency is unknown");
	});

	it("binds nested intent input digests to the declared inputs", () => {
		const setup = setupNestedEvents();
		expect(() =>
			reduceWorkflowEvents(
				records([
					...setup.events,
					nestedIntent(setup, { inputsSha256: "9".repeat(64) }),
				]),
			),
		).toThrow("nested workflow intent input artifacts do not match its task");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...setup.events,
					nestedIntent(setup, { resolvedInputSha256: "9".repeat(64) }),
				]),
			),
		).toThrow(
			"nested workflow intent resolved input does not match its declared input",
		);
		const withInputs = setupNestedInputEvents();
		const inputsSha256 = deriveJsonValueSha256({
			answer: structuredOutputSha256,
		});
		expect(() =>
			reduceWorkflowEvents(
				records([
					...withInputs.events,
					nestedIntent(withInputs, {
						inputsSha256: deriveJsonValueSha256({}),
						resolvedInputSha256: "9".repeat(64),
					}),
				]),
			),
		).toThrow("nested workflow intent input artifacts do not match its task");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...withInputs.events,
					nestedIntent(withInputs, {
						inputsSha256: deriveJsonValueSha256({
							answer: "9".repeat(64),
						}),
						resolvedInputSha256: "9".repeat(64),
					}),
				]),
			),
		).toThrow("nested workflow intent input artifacts do not match its task");
		const state = reduceWorkflowEvents(
			records([
				...withInputs.events,
				nestedIntent(withInputs, {
					inputsSha256,
					resolvedInputSha256: "9".repeat(64),
				}),
			]),
		);
		expect(state.executions[withInputs.execution.id]).toMatchObject({
			phase: "nested-intended",
			nestedIntent: {
				inputSha256: withInputs.task.spec.request.inputSha256,
				inputsSha256,
				resolvedInputSha256: "9".repeat(64),
			},
		});
		const missingArtifact = setupNestedInputEvents();
		const producerArtifactIndex = missingArtifact.events.findIndex(
			(event) => event.type === "artifact-declared",
		);
		expect(producerArtifactIndex).toBeGreaterThan(0);
		expect(() =>
			reduceWorkflowEvents(
				records([
					...missingArtifact.events.slice(0, producerArtifactIndex),
					{
						type: "task-status-changed",
						data: {
							taskId: missingArtifact.task.id,
							from: "pending",
							to: "ready",
						},
					},
				]),
			),
		).toThrow("task became ready before its dependencies completed");
	});

	it("binds the nested-input failure stage to the pre-launch phases", () => {
		const setup = setupNestedInputEvents();
		const inputsSha256 = deriveJsonValueSha256({
			answer: structuredOutputSha256,
		});
		const fromCreated = reduceWorkflowEvents(
			records([
				...setup.events,
				workflowFailure(
					setup.execution.id,
					"failed",
					"nested-input",
					"input schema rejected the merged input",
				),
				{
					type: "task-status-changed",
					data: { taskId: setup.task.id, from: "ready", to: "failed" },
				},
			]),
		);
		expect(fromCreated.tasks[setup.task.id]?.status).toBe("failed");
		expect(fromCreated.executions[setup.execution.id]?.terminal).toMatchObject({
			outcome: "failed",
			evidence: { stage: "nested-input" },
		});
		const intent = nestedIntent(setup, {
			inputsSha256,
			resolvedInputSha256: "9".repeat(64),
		});
		const fromIntended = reduceWorkflowEvents(
			records([
				...setup.events,
				intent,
				workflowFailure(
					setup.execution.id,
					"failed",
					"nested-input",
					"merged input digest changed",
				),
			]),
		);
		expect(fromIntended.executions[setup.execution.id]?.terminal).toMatchObject(
			{ outcome: "failed", evidence: { stage: "nested-input" } },
		);
		expect(() =>
			reduceWorkflowEvents(
				records([
					...setup.events,
					intent,
					nestedLaunched(setup),
					workflowFailure(
						setup.execution.id,
						"failed",
						"nested-input",
						"too late",
					),
				]),
			),
		).toThrow("workflow terminal evidence is inconsistent");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...setup.events,
					workflowFailure(
						setup.execution.id,
						"cancelled",
						"nested-input",
						"stopped",
					),
				]),
			),
		).toThrow("workflow terminal evidence is inconsistent");
		const agent = setupEvents();
		const support = setupSupportEvents();
		expect(() =>
			reduceWorkflowEvents(
				records([
					...agent.events,
					workflowFailure(agent.execution.id, "failed", "nested-input", "x"),
				]),
			),
		).toThrow("workflow terminal evidence is inconsistent");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...support.events,
					workflowFailure(support.execution.id, "failed", "nested-input", "x"),
				]),
			),
		).toThrow("workflow terminal evidence is inconsistent");
	});

	it("rejects launch and settlement out of order", () => {
		const setup = setupNestedEvents();
		expect(() =>
			reduceWorkflowEvents(records([...setup.events, nestedLaunched(setup)])),
		).toThrow("nested workflow launch is out of order");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...setup.events,
					nestedIntent(setup),
					nestedLaunched(setup, "workflow_other"),
				]),
			),
		).toThrow("nested workflow launch does not match its execution");
		expect(() =>
			reduceWorkflowEvents(
				records([...setup.events, completedSettlement(setup)]),
			),
		).toThrow("nested workflow settlement is out of order");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...setup.events,
					nestedIntent(setup),
					completedSettlement(setup),
				]),
			),
		).toThrow("nested workflow settlement is out of order");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...launched(setup),
					completedSettlement(setup),
					completedSettlement(setup),
				]),
			),
		).toThrow("nested workflow settlement is out of order");
		expect(() =>
			reduceWorkflowEvents(
				records([...launched(setup), nestedSettled(setup, "running")]),
			),
		).toThrow("nested workflow settlement status is not terminal");
		expect(() =>
			reduceWorkflowEvents(
				records([...launched(setup), nestedSettled(setup, "completed")]),
			),
		).toThrow("nested workflow settlement output is inconsistent");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...launched(setup),
					nestedSettled(setup, "failed", {
						outputArtifactId: childOutputArtifactId,
						outputSha256: nestedOutputSha256,
					}),
				]),
			),
		).toThrow("nested workflow settlement output is inconsistent");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...launched(setup),
					{
						...completedSettlement(setup),
						data: {
							...completedSettlement(setup).data,
							childRunId: "workflow_other",
						},
					} as WorkflowEventInput,
				]),
			),
		).toThrow("nested workflow settlement does not match its execution");
	});

	it("rejects output imports whose artifact or source differ", () => {
		const setup = setupNestedEvents();
		const artifact = nestedArtifact(setup.task);
		const settled: WorkflowEventInput[] = [
			...launched(setup),
			completedSettlement(setup),
			{ type: "artifact-declared", data: { artifact } },
		];
		expect(() =>
			reduceWorkflowEvents(
				records([...launched(setup), nestedImported(setup, artifact)]),
			),
		).toThrow("nested workflow output import is out of order");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...settled,
					nestedImported(setup, artifact, { sourceSha256: "9".repeat(64) }),
				]),
			),
		).toThrow("nested workflow output artifact does not match");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...settled,
					nestedImported(setup, artifact, {
						sourceArtifactId: `artifact_${"6".repeat(64)}`,
					}),
				]),
			),
		).toThrow("nested workflow output artifact does not match");
		const wrongSchemaInput = {
			runId: "workflow_execution" as const,
			producerTaskId: setup.task.id,
			producerExecutionId: setup.execution.id,
			output: "result" as const,
			sha256: nestedOutputSha256,
			schemaSha256: "7".repeat(64),
		};
		const wrongSchema: WorkflowArtifactRef = {
			...artifact,
			...wrongSchemaInput,
			id: deriveWorkflowArtifactId(wrongSchemaInput),
		};
		expect(() =>
			reduceWorkflowEvents(
				records([
					...launched(setup),
					completedSettlement(setup),
					{ type: "artifact-declared", data: { artifact: wrongSchema } },
					nestedImported(setup, wrongSchema),
				]),
			),
		).toThrow("nested workflow output artifact does not match");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...launched(setup),
					nestedSettled(setup, "failed"),
					{ type: "artifact-declared", data: { artifact } },
					nestedImported(setup, artifact),
				]),
			),
		).toThrow("nested workflow output import requires a completed child");
	});

	it("binds nested terminal evidence to the settlement and import", () => {
		const setup = setupNestedEvents();
		const artifact = nestedArtifact(setup.task);
		const settled = [...launched(setup), completedSettlement(setup)];
		expect(() =>
			reduceWorkflowEvents(
				records([
					...settled,
					nestedTerminal(
						setup,
						"completed",
						nestedEvidence(setup, "completed", {
							outputSha256: nestedOutputSha256,
							artifactId: artifact.id,
						}),
					),
				]),
			),
		).toThrow("nested workflow terminal evidence precedes output import");
		const imported: WorkflowEventInput[] = [
			...settled,
			{ type: "artifact-declared", data: { artifact } },
			nestedImported(setup, artifact),
		];
		expect(() =>
			reduceWorkflowEvents(
				records([
					...imported,
					nestedTerminal(
						setup,
						"completed",
						nestedEvidence(setup, "completed", {
							outputSha256: "9".repeat(64),
							artifactId: artifact.id,
						}),
					),
				]),
			),
		).toThrow("nested workflow terminal artifact does not match");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...imported,
					nestedTerminal(
						setup,
						"failed",
						nestedEvidence(setup, "completed", {
							outputSha256: nestedOutputSha256,
							artifactId: artifact.id,
						}),
					),
				]),
			),
		).toThrow("nested workflow terminal outcome does not match");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...imported,
					nestedTerminal(setup, "completed", {
						...nestedEvidence(setup, "completed", {
							outputSha256: nestedOutputSha256,
							artifactId: artifact.id,
						}),
						usage: { ...nestedUsage, cost: 0.75 },
					}),
				]),
			),
		).toThrow("nested workflow terminal settlement does not match");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...launched(setup),
					nestedSettled(setup, "failed"),
					nestedTerminal(
						setup,
						"failed",
						nestedEvidence(setup, "failed", { artifactId: artifact.id }),
					),
				]),
			),
		).toThrow("nested workflow terminal evidence is inconsistent");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...launched(setup),
					nestedTerminal(setup, "failed", nestedEvidence(setup, "failed")),
				]),
			),
		).toThrow("nested workflow terminal settlement does not match");
	});

	it("maps every terminal child status to its task outcome", () => {
		for (const [status, outcome] of [
			["failed", "failed"],
			["cancelled", "cancelled"],
			["interrupted", "interrupted"],
			["cleanup-blocked", "cleanup-blocked"],
		] as const) {
			const setup = setupNestedEvents();
			const state = reduceWorkflowEvents(
				records([
					...launched(setup),
					nestedSettled(setup, status),
					nestedTerminal(setup, outcome, nestedEvidence(setup, status)),
					{
						type: "task-status-changed",
						data: { taskId: setup.task.id, from: "running", to: outcome },
					},
				]),
			);
			expect(state.executions[setup.execution.id]?.terminal).toMatchObject({
				outcome,
				evidence: { kind: "nested-workflow", status },
			});
			expect(state.tasks[setup.task.id]?.status).toBe(outcome);
		}
		const degraded = setupNestedEvents();
		const artifact = nestedArtifact(degraded.task);
		const state = reduceWorkflowEvents(
			records([
				...launched(degraded),
				nestedSettled(degraded, "completed-degraded", {
					outputArtifactId: childOutputArtifactId,
					outputSha256: nestedOutputSha256,
				}),
				{ type: "artifact-declared", data: { artifact } },
				nestedImported(degraded, artifact),
				nestedTerminal(
					degraded,
					"completed",
					nestedEvidence(degraded, "completed-degraded", {
						outputSha256: nestedOutputSha256,
						artifactId: artifact.id,
					}),
				),
				{
					type: "task-status-changed",
					data: { taskId: degraded.task.id, from: "running", to: "completed" },
				},
			]),
		);
		expect(state.tasks[degraded.task.id]?.status).toBe("completed");
	});

	it("reconciles a cleanup-blocked child settlement", () => {
		const setup = setupNestedEvents();
		const artifact = nestedArtifact(setup.task);
		const resettled = reduceWorkflowEvents(
			records([
				...launched(setup),
				nestedSettled(setup, "cleanup-blocked"),
				nestedSettled(setup, "failed"),
				nestedTerminal(setup, "failed", nestedEvidence(setup, "failed")),
				{
					type: "task-status-changed",
					data: { taskId: setup.task.id, from: "running", to: "failed" },
				},
			]),
		);
		expect(resettled.executions[setup.execution.id]).toMatchObject({
			phase: "terminal",
			nestedSettlement: { status: "failed" },
			terminal: { outcome: "failed" },
		});
		const blocked: WorkflowEventInput[] = [
			...launched(setup),
			nestedSettled(setup, "cleanup-blocked"),
			nestedTerminal(
				setup,
				"cleanup-blocked",
				nestedEvidence(setup, "cleanup-blocked"),
			),
			{
				type: "task-status-changed",
				data: { taskId: setup.task.id, from: "running", to: "cleanup-blocked" },
			},
		];
		expect(
			reduceWorkflowEvents(records(blocked)).tasks[setup.task.id]?.status,
		).toBe("cleanup-blocked");
		const recovered = reduceWorkflowEvents(
			records([
				...blocked,
				completedSettlement(setup),
				{ type: "artifact-declared", data: { artifact } },
				nestedImported(setup, artifact),
				nestedTerminal(
					setup,
					"completed",
					nestedEvidence(setup, "completed", {
						outputSha256: nestedOutputSha256,
						artifactId: artifact.id,
					}),
				),
				{
					type: "task-status-changed",
					data: {
						taskId: setup.task.id,
						from: "cleanup-blocked",
						to: "completed",
					},
				},
			]),
		);
		expect(recovered.executions[setup.execution.id]).toMatchObject({
			phase: "terminal",
			nestedSettlement: { status: "completed" },
			terminal: { outcome: "completed" },
		});
		expect(recovered.tasks[setup.task.id]?.status).toBe("completed");
		expect(() =>
			reduceWorkflowEvents(
				records([...blocked, nestedSettled(setup, "cleanup-blocked")]),
			),
		).toThrow("nested workflow settlement is out of order");
	});

	it("rejects agent and support events on a workflow execution", () => {
		const setup = setupNestedEvents();
		const executionId = setup.execution.id;
		const operationId = deriveSubagentOperationId(
			"workflow_execution",
			setup.task.id,
			1,
		);
		const subagentShaped: WorkflowEventInput[] = [
			{
				type: "task-execution-preflighted",
				data: {
					executionId,
					operationId,
					preflightId: "preflight-1",
					planIdentitySha256,
					plannedSubagentRunId: "run_child",
					plannedSubagentAttemptId: "attempt_child",
					expiresAt: "2026-09-01T01:00:00.000Z",
					workspaceMode: "read-only",
					workspaceBaselineSha256: "c".repeat(64),
				},
			},
			{
				type: "task-execution-child-observed",
				data: {
					executionId,
					subagentRunId: "run_child",
					subagentAttemptId: "attempt_child",
					status: "active",
				},
			},
			{
				type: "task-execution-release-intended",
				data: { executionId, subagentRunId: "run_child" },
			},
		];
		for (const event of subagentShaped) {
			expect(() =>
				reduceWorkflowEvents(records([...setup.events, event])),
			).toThrow("subagent execution event targets a workflow execution");
		}
		expect(() =>
			reduceWorkflowEvents(
				records([
					...setup.events,
					{
						type: "task-execution-support-intended",
						data: {
							executionId,
							implementationIdentitySha256: "9".repeat(64),
							parametersSha256: "9".repeat(64),
							inputsSha256: "9".repeat(64),
						},
					},
				]),
			),
		).toThrow("support execution event targets a workflow execution");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...setup.events,
					{
						type: "task-execution-terminal",
						data: {
							executionId,
							outcome: "completed",
							evidence: completedEvidence(),
						},
					},
				]),
			),
		).toThrow("workflow task has subagent terminal evidence");
		const support = setupSupportEvents();
		expect(() =>
			reduceWorkflowEvents(
				records([
					...setup.events,
					{
						type: "task-execution-terminal",
						data: {
							executionId,
							outcome: "completed",
							evidence: supportEvidence(support.task, support.execution),
						},
					},
				]),
			),
		).toThrow("workflow task has support terminal evidence");
		const agent = setupEvents();
		for (const event of [
			nestedIntent(setup, { executionId: agent.execution.id }),
			{
				type: "task-execution-nested-launched",
				data: {
					executionId: agent.execution.id,
					childRunId: setup.execution.childRunId,
				},
			} satisfies WorkflowEventInput,
		]) {
			expect(() =>
				reduceWorkflowEvents(records([...agent.events, event])),
			).toThrow("nested workflow execution event targets an agent execution");
		}
		expect(() =>
			reduceWorkflowEvents(
				records([
					...support.events,
					nestedIntent(setup, { executionId: support.execution.id }),
				]),
			),
		).toThrow("nested workflow execution event targets a support execution");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...agent.events,
					{
						type: "task-execution-terminal",
						data: {
							executionId: agent.execution.id,
							outcome: "failed",
							evidence: nestedEvidence(setup, "failed"),
						},
					},
				]),
			),
		).toThrow("agent task has nested workflow terminal evidence");
	});

	it("binds nested failure stages to workflow tasks", () => {
		const setup = setupNestedEvents();
		for (const stage of [
			"preflight",
			"launch",
			"reconciliation",
			"artifact-import",
			"release",
			"support-resolution",
			"support-execution",
		] as const) {
			expect(() =>
				reduceWorkflowEvents(
					records([
						...setup.events,
						workflowFailure(setup.execution.id, "failed", stage, "boom"),
					]),
				),
			).toThrow("workflow terminal evidence is inconsistent");
		}
		const agent = setupEvents();
		const support = setupSupportEvents();
		for (const stage of [
			"nested-resolution",
			"nested-launch",
			"nested-import",
		] as const) {
			expect(() =>
				reduceWorkflowEvents(
					records([
						...agent.events,
						workflowFailure(agent.execution.id, "failed", stage, "boom"),
					]),
				),
			).toThrow("workflow terminal evidence is inconsistent");
			expect(() =>
				reduceWorkflowEvents(
					records([
						...support.events,
						workflowFailure(support.execution.id, "failed", stage, "boom"),
					]),
				),
			).toThrow("workflow terminal evidence is inconsistent");
		}
		const resolutionFailed = reduceWorkflowEvents(
			records([
				...setup.events,
				workflowFailure(
					setup.execution.id,
					"failed",
					"nested-resolution",
					"definition changed",
				),
				{
					type: "task-status-changed",
					data: { taskId: setup.task.id, from: "ready", to: "failed" },
				},
			]),
		);
		expect(resolutionFailed.tasks[setup.task.id]?.status).toBe("failed");
		const launchFailed = reduceWorkflowEvents(
			records([
				...setup.events,
				nestedIntent(setup),
				workflowFailure(
					setup.execution.id,
					"failed",
					"nested-launch",
					"child record write failed",
				),
			]),
		);
		expect(launchFailed.executions[setup.execution.id]?.terminal).toMatchObject(
			{ outcome: "failed", evidence: { stage: "nested-launch" } },
		);
		expect(() =>
			reduceWorkflowEvents(
				records([
					...launched(setup),
					workflowFailure(
						setup.execution.id,
						"failed",
						"nested-launch",
						"too late",
					),
				]),
			),
		).toThrow("workflow terminal evidence is inconsistent");
		const importBlocked: WorkflowEventInput = {
			type: "task-execution-terminal",
			data: {
				executionId: setup.execution.id,
				outcome: "cleanup-blocked",
				evidence: {
					kind: "workflow",
					stage: "nested-import",
					failureSha256: deriveWorkflowFailureSha256(
						"nested-import",
						"artifact store unavailable",
					),
					message: "artifact store unavailable",
				},
			},
		};
		expect(() =>
			reduceWorkflowEvents(records([...launched(setup), importBlocked])),
		).toThrow("workflow terminal evidence is inconsistent");
		const artifact = nestedArtifact(setup.task);
		const recovered = reduceWorkflowEvents(
			records([
				...launched(setup),
				completedSettlement(setup),
				importBlocked,
				{
					type: "task-status-changed",
					data: {
						taskId: setup.task.id,
						from: "running",
						to: "cleanup-blocked",
					},
				},
				{ type: "artifact-declared", data: { artifact } },
				nestedImported(setup, artifact),
				nestedTerminal(
					setup,
					"completed",
					nestedEvidence(setup, "completed", {
						outputSha256: nestedOutputSha256,
						artifactId: artifact.id,
					}),
				),
				{
					type: "task-status-changed",
					data: {
						taskId: setup.task.id,
						from: "cleanup-blocked",
						to: "completed",
					},
				},
			]),
		);
		expect(recovered.tasks[setup.task.id]?.status).toBe("completed");
	});

	it("constrains workflow task status transitions", () => {
		const setup = setupNestedEvents();
		expect(() =>
			reduceWorkflowEvents(
				records([
					...setup.events,
					nestedIntent(setup),
					{
						type: "task-status-changed",
						data: { taskId: setup.task.id, from: "ready", to: "running" },
					},
				]),
			),
		).toThrow("workflow task became running without a launched child run");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...launched(setup),
					{
						type: "task-status-changed",
						data: { taskId: setup.task.id, from: "running", to: "waiting" },
					},
				]),
			),
		).toThrow("workflow task may not wait");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...launched(setup),
					{
						type: "task-status-changed",
						data: { taskId: setup.task.id, from: "running", to: "cancelling" },
					},
				]),
			),
		).toThrow(
			"workflow task began cancellation without stop intent and a launched child run",
		);
		expect(() =>
			reduceWorkflowEvents(
				records([
					...setup.events,
					nestedIntent(setup),
					{
						type: "run-status-changed",
						data: { from: "running", to: "stopping" },
					},
					{
						type: "task-status-changed",
						data: { taskId: setup.task.id, from: "ready", to: "cancelling" },
					},
				]),
			),
		).toThrow(
			"workflow task began cancellation without stop intent and a launched child run",
		);
		const stopped = reduceWorkflowEvents(
			records([
				...launched(setup),
				{
					type: "run-status-changed",
					data: { from: "running", to: "stopping" },
				},
				{
					type: "task-status-changed",
					data: { taskId: setup.task.id, from: "running", to: "cancelling" },
				},
				nestedSettled(setup, "cancelled"),
				nestedTerminal(setup, "cancelled", nestedEvidence(setup, "cancelled")),
				{
					type: "task-status-changed",
					data: { taskId: setup.task.id, from: "cancelling", to: "cancelled" },
				},
				{
					type: "run-status-changed",
					data: { from: "stopping", to: "cancelled" },
				},
			]),
		);
		expect(stopped.tasks[setup.task.id]?.status).toBe("cancelled");
		expect(stopped.status).toBe("cancelled");
		const cancelledBeforeLaunch = reduceWorkflowEvents(
			records([
				...setup.events,
				nestedIntent(setup),
				{
					type: "run-status-changed",
					data: { from: "running", to: "stopping" },
				},
				workflowFailure(setup.execution.id, "cancelled", "stop", "stopped"),
				{
					type: "task-status-changed",
					data: { taskId: setup.task.id, from: "ready", to: "cancelled" },
				},
			]),
		);
		expect(cancelledBeforeLaunch.tasks[setup.task.id]?.status).toBe(
			"cancelled",
		);
		expect(() =>
			reduceWorkflowEvents(
				records([
					...launched(setup),
					{
						type: "run-status-changed",
						data: { from: "running", to: "stopping" },
					},
					workflowFailure(setup.execution.id, "cancelled", "stop", "stopped"),
				]),
			),
		).toThrow("workflow terminal evidence is inconsistent");
	});

	it("rebuilds the nested ladder into an identical snapshot", async () => {
		const setup = setupNestedEvents();
		const inputs = completedLadder(setup);
		const expected = reduceWorkflowEvents(records(inputs));
		const root = path.resolve(".pi", "test-execution", randomUUID());
		const lease = await acquireWorkflowRunLease({
			storeRoot: root,
			runId: "workflow_execution",
			ownerId: "nested-test",
		});
		try {
			const journal = await WorkflowRunJournal.open(
				root,
				"workflow_execution",
				lease,
			);
			for (const input of inputs) await journal.appendEvent(input);
			const snapshot = await rebuildWorkflowSnapshot(journal);
			expect(snapshot.state).toEqual(expected);
		} finally {
			await lease.release();
		}
	});
});

type AttemptPolicies = {
	retry?: { attempts: number; on?: ("backoff" | "manual")[] };
	resume?: { attempts: number };
};

function attemptRequest(policies: AttemptPolicies) {
	const base = request();
	return {
		...base,
		limits: { ...base.limits, retries: 3, resumes: 3 },
		...policies,
	};
}

function setupAttemptEvents(
	agentRequest: ReturnType<typeof request> = attemptRequest({
		retry: { attempts: 2, on: ["backoff", "manual"] },
		resume: { attempts: 1 },
	}),
): ReturnType<typeof setupEvents> {
	const materializer = new WorkflowTaskMaterializer({
		runId: "workflow_execution",
		definitionIdentitySha256,
		inputSha256,
	});
	const task = materializer.agent("answer", agentRequest);
	const commit = materializer.closeEpoch("final", [task]);
	const declaration = commit.events.find(
		(event) => event.type === "task-declared",
	);
	if (declaration?.type !== "task-declared") {
		throw new Error("missing task declaration");
	}
	const record = execution(
		task.ref.taskId,
		declaration.data.task.spec.identitySha256,
	);
	return {
		taskId: task.ref.taskId,
		execution: record,
		events: [
			runCreated(),
			...commit.events,
			{
				type: "run-status-changed",
				data: { from: "created", to: "running" },
			},
			{
				type: "task-status-changed",
				data: { taskId: task.ref.taskId, from: "pending", to: "ready" },
			},
			{ type: "task-execution-created", data: { execution: record } },
		],
	};
}

function launchedEvents(
	setup: ReturnType<typeof setupEvents>,
): WorkflowEventInput[] {
	return [
		...preflightEvents(setup.execution),
		{
			type: "task-execution-launch-receipted",
			data: {
				executionId: setup.execution.id,
				operationId: setup.execution.operationId,
				subagentRunId: "run_child",
				subagentAttemptId: "attempt_child",
				status: "active",
			},
		},
		{
			type: "task-status-changed",
			data: { taskId: setup.taskId, from: "ready", to: "running" },
		},
	];
}

function observed(
	record: AgentTaskExecutionRecord,
	subagentAttemptId: string,
	status: "active" | "completed" | "failed" | "interrupted" | "cleanup-blocked",
): WorkflowEventInput {
	return {
		type: "task-execution-child-observed",
		data: {
			executionId: record.id,
			subagentRunId: "run_child",
			subagentAttemptId,
			status,
		},
	};
}

const attemptUsage = {
	input: 20,
	output: 4,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 24,
	cost: 0.02,
};

function failedEvidence(
	attemptOrdinal: number,
	retry: "backoff" | "manual" | "never" = "backoff",
): SubagentTerminalEvidence {
	return {
		kind: "subagent",
		attemptOrdinal,
		resultSha256: "6".repeat(64),
		status: "failed",
		usage: attemptUsage,
		usageComplete: true,
		runtimeMs: 500,
		failure: {
			code: "provider-transient",
			origin: "provider",
			retry,
			message: "Provider timed out.",
			guidance: "Retry later.",
		},
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
	};
}

function interruptedEvidence(attemptOrdinal: number): SubagentTerminalEvidence {
	return {
		kind: "subagent",
		attemptOrdinal,
		resultSha256: "7".repeat(64),
		status: "interrupted",
		usage: attemptUsage,
		usageComplete: false,
		runtimeMs: 700,
		failure: {
			code: "seat-interruption",
			origin: "service",
			retry: "resume",
			message: "Seat exited.",
			guidance: "Resume the run.",
		},
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
	};
}

function cleanupBlockedEvidence(
	attemptOrdinal: number,
): SubagentTerminalEvidence {
	return {
		kind: "subagent",
		attemptOrdinal,
		resultSha256: "8".repeat(64),
		status: "cleanup-blocked",
		usage: attemptUsage,
		usageComplete: true,
		runtimeMs: 900,
		failure: {
			code: "sandbox-cleanup",
			origin: "sandbox",
			retry: "reconcile",
			message: "Cleanup is not yet proved.",
			guidance: "Reconcile the child.",
		},
		sandboxCleanup: "blocked",
		workspaceCleanup: "not-needed",
		truncated: false,
	};
}

function attemptIntended(
	record: AgentTaskExecutionRecord,
	overrides: Partial<{
		kind: "retry" | "resume";
		ordinal: number;
		previousAttemptId: string;
		failureCode: string;
		failureRetry: "backoff" | "manual" | "resume";
	}> = {},
): WorkflowEventInput {
	return {
		type: "task-execution-attempt-intended",
		data: {
			executionId: record.id,
			subagentRunId: "run_child",
			kind: "retry",
			ordinal: 2,
			previousAttemptId: "attempt_child",
			failureCode: "provider-transient",
			failureRetry: "backoff",
			origin: "policy",
			...overrides,
		},
	};
}

function attemptReceipted(
	record: AgentTaskExecutionRecord,
	ordinal: number,
	subagentAttemptId: string,
	status: "active" | "queued" = "active",
): WorkflowEventInput {
	return {
		type: "task-execution-attempt-receipted",
		data: {
			executionId: record.id,
			subagentRunId: "run_child",
			ordinal,
			subagentAttemptId,
			status,
		},
	};
}

function attemptDeclined(
	record: AgentTaskExecutionRecord,
	ordinal: number,
): WorkflowEventInput {
	return {
		type: "task-execution-attempt-declined",
		data: {
			executionId: record.id,
			subagentRunId: "run_child",
			ordinal,
			reason: "Workflow stop requested before the attempt.",
		},
	};
}

function failedPrefix(
	setup: ReturnType<typeof setupEvents>,
	evidence: SubagentTerminalEvidence = failedEvidence(1),
): WorkflowEventInput[] {
	return [
		...setup.events,
		...launchedEvents(setup),
		observed(
			setup.execution,
			"attempt_child",
			evidence.status as "failed" | "interrupted" | "cleanup-blocked",
		),
		settlement(setup.execution, evidence),
	];
}

function completedAttemptEvents(
	setup: ReturnType<typeof setupEvents>,
	subagentAttemptId: string,
	attemptOrdinal: number,
): WorkflowEventInput[] {
	const output = artifact(setup.taskId);
	const evidence = { ...completedEvidence(), attemptOrdinal };
	return [
		observed(setup.execution, subagentAttemptId, "active"),
		observed(setup.execution, subagentAttemptId, "completed"),
		settlement(setup.execution, evidence),
		{ type: "artifact-declared", data: { artifact: output } },
		{
			type: "task-execution-artifact-imported",
			data: {
				executionId: setup.execution.id,
				subagentRunId: "run_child",
				artifactId: output.id,
				sourceResultSha256: resultSha256,
			},
		},
		...releaseEvents(setup.execution, "completed"),
		{
			type: "task-execution-terminal",
			data: {
				executionId: setup.execution.id,
				outcome: "completed",
				evidence,
			},
		},
		{
			type: "task-status-changed",
			data: { taskId: setup.taskId, from: "running", to: "completed" },
		},
	];
}

describe("task execution attempts", () => {
	it("reduces a retry ladder under one execution", () => {
		const setup = setupAttemptEvents();
		const events: WorkflowEventInput[] = [
			...failedPrefix(setup),
			attemptIntended(setup.execution),
			attemptReceipted(setup.execution, 2, "attempt_retry"),
			...completedAttemptEvents(setup, "attempt_retry", 2),
		];
		for (let length = 1; length <= events.length; length += 1) {
			expect(() =>
				reduceWorkflowEvents(records(events.slice(0, length))),
			).not.toThrow();
		}
		const intended = reduceWorkflowEvents(
			records(events.slice(0, failedPrefix(setup).length + 1)),
		).executions[setup.execution.id];
		expect(intended).toMatchObject({
			phase: "attempt-intended",
			attempts: [
				{ kind: "retry", ordinal: 2, previousAttemptId: "attempt_child" },
			],
			settlement: { evidence: { attemptOrdinal: 1 } },
		});
		expect(intended?.attempts?.[0]?.receiptSequence).toBeUndefined();
		const receipted = reduceWorkflowEvents(
			records(events.slice(0, failedPrefix(setup).length + 2)),
		).executions[setup.execution.id];
		expect(receipted).toMatchObject({
			phase: "launched",
			attempts: [{ subagentAttemptId: "attempt_retry", status: "active" }],
			priorSettlements: [{ evidence: { attemptOrdinal: 1, status: "failed" } }],
		});
		expect(receipted?.observation).toBeUndefined();
		expect(receipted?.settlement).toBeUndefined();
		expect(receipted?.attempts?.[0]?.receiptSequence).toBe(
			failedPrefix(setup).length + 2,
		);
		if (!receipted) throw new Error("missing receipted projection");
		expect(currentSubagentAttemptId(receipted)).toBe("attempt_retry");
		const state = reduceWorkflowEvents(records(events));
		const projection = state.executions[setup.execution.id];
		if (!projection) throw new Error("missing projection");
		expect(projection).toMatchObject({
			phase: "terminal",
			attempts: [{ kind: "retry", ordinal: 2 }],
			settlement: { evidence: { attemptOrdinal: 2, status: "completed" } },
			terminal: {
				outcome: "completed",
				evidence: { kind: "subagent", attemptOrdinal: 2 },
			},
		});
		expect(projection.priorSettlements).toHaveLength(1);
		expect(projection.priorSettlements?.[0]?.evidence).toEqual(
			failedEvidence(1),
		);
		expect(projection.attemptsClosed).toBeUndefined();
		expect(currentSubagentAttemptId(projection)).toBe("attempt_retry");
		expect(settledAgentUsage(projection)).toEqual({
			cost: attemptUsage.cost + completedEvidence().usage.cost,
			totalTokens:
				attemptUsage.totalTokens + completedEvidence().usage.totalTokens,
			runtimeMs: 500 + completedEvidence().runtimeMs,
			usageComplete: true,
		});
		expect(state.tasks[setup.taskId]?.status).toBe("completed");
	});

	it("reduces a resume ladder from an interrupted settlement", () => {
		const setup = setupAttemptEvents();
		const events: WorkflowEventInput[] = [
			...failedPrefix(setup, interruptedEvidence(1)),
			attemptIntended(setup.execution, {
				kind: "resume",
				failureCode: "seat-interruption",
				failureRetry: "resume",
			}),
			attemptReceipted(setup.execution, 2, "attempt_resume"),
			...completedAttemptEvents(setup, "attempt_resume", 2),
		];
		const state = reduceWorkflowEvents(records(events));
		const projection = state.executions[setup.execution.id];
		if (!projection) throw new Error("missing projection");
		expect(projection).toMatchObject({
			phase: "terminal",
			attempts: [
				{
					kind: "resume",
					ordinal: 2,
					previousAttemptId: "attempt_child",
					subagentAttemptId: "attempt_resume",
				},
			],
			priorSettlements: [{ evidence: interruptedEvidence(1) }],
			terminal: { outcome: "completed" },
		});
		expect(currentSubagentAttemptId(projection)).toBe("attempt_resume");
		expect(settledAgentUsage(projection).usageComplete).toBe(false);
		expect(state.tasks[setup.taskId]?.status).toBe("completed");
	});

	it("uses the attempt receipt status for the running transition", () => {
		const setup = setupAttemptEvents();
		const waiting: WorkflowEventInput = {
			type: "task-status-changed",
			data: { taskId: setup.taskId, from: "running", to: "waiting" },
		};
		const running: WorkflowEventInput = {
			type: "task-status-changed",
			data: { taskId: setup.taskId, from: "waiting", to: "running" },
		};
		const prefix = [
			...failedPrefix(setup),
			waiting,
			attemptIntended(setup.execution),
		];
		const active = reduceWorkflowEvents(
			records([
				...prefix,
				attemptReceipted(setup.execution, 2, "attempt_retry", "active"),
				running,
			]),
		);
		expect(active.tasks[setup.taskId]?.status).toBe("running");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...prefix,
					attemptReceipted(setup.execution, 2, "attempt_retry", "queued"),
					running,
				]),
			),
		).toThrow("without an active execution");
		const queuedThenActive = reduceWorkflowEvents(
			records([
				...prefix,
				attemptReceipted(setup.execution, 2, "attempt_retry", "queued"),
				observed(setup.execution, "attempt_retry", "active"),
				running,
			]),
		);
		expect(queuedThenActive.tasks[setup.taskId]?.status).toBe("running");
	});

	it("rejects attempt intents that the task policy does not allow", () => {
		const withoutPolicy = setupAttemptEvents(request());
		expect(() =>
			reduceWorkflowEvents(
				records([
					...failedPrefix(withoutPolicy),
					attemptIntended(withoutPolicy.execution),
				]),
			),
		).toThrow("retry intent lacks a retry policy");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...failedPrefix(withoutPolicy, interruptedEvidence(1)),
					attemptIntended(withoutPolicy.execution, {
						kind: "resume",
						failureCode: "seat-interruption",
						failureRetry: "resume",
					}),
				]),
			),
		).toThrow("resume intent lacks a resume policy");
		const manualOnly = setupAttemptEvents(
			attemptRequest({ retry: { attempts: 1, on: ["manual"] } }),
		);
		expect(() =>
			reduceWorkflowEvents(
				records([
					...failedPrefix(manualOnly),
					attemptIntended(manualOnly.execution),
				]),
			),
		).toThrow("failure class is not covered by the retry policy");
		const single = setupAttemptEvents(
			attemptRequest({ retry: { attempts: 1 }, resume: { attempts: 1 } }),
		);
		const exhausted: WorkflowEventInput[] = [
			...failedPrefix(single),
			attemptIntended(single.execution),
			attemptReceipted(single.execution, 2, "attempt_retry"),
			observed(single.execution, "attempt_retry", "failed"),
			settlement(single.execution, failedEvidence(2)),
		];
		expect(() =>
			reduceWorkflowEvents(
				records([
					...exhausted,
					attemptIntended(single.execution, {
						ordinal: 3,
						previousAttemptId: "attempt_retry",
					}),
				]),
			),
		).toThrow("retry intent exceeds the retry policy");
		const resumeExhausted: WorkflowEventInput[] = [
			...failedPrefix(single, interruptedEvidence(1)),
			attemptIntended(single.execution, {
				kind: "resume",
				failureCode: "seat-interruption",
				failureRetry: "resume",
			}),
			attemptReceipted(single.execution, 2, "attempt_resume"),
			observed(single.execution, "attempt_resume", "interrupted"),
			settlement(single.execution, interruptedEvidence(2)),
		];
		expect(() =>
			reduceWorkflowEvents(
				records([
					...resumeExhausted,
					attemptIntended(single.execution, {
						kind: "resume",
						ordinal: 3,
						previousAttemptId: "attempt_resume",
						failureCode: "seat-interruption",
						failureRetry: "resume",
					}),
				]),
			),
		).toThrow("resume intent exceeds the resume policy");
		const state = reduceWorkflowEvents(
			records([
				...exhausted,
				...releaseEvents(single.execution, "failed"),
				{
					type: "task-execution-terminal",
					data: {
						executionId: single.execution.id,
						outcome: "failed",
						evidence: failedEvidence(2),
					},
				},
				{
					type: "task-status-changed",
					data: { taskId: single.taskId, from: "running", to: "failed" },
				},
			]),
		);
		expect(state.executions[single.execution.id]).toMatchObject({
			phase: "terminal",
			terminal: { outcome: "failed", evidence: { attemptOrdinal: 2 } },
			priorSettlements: [{ evidence: { attemptOrdinal: 1 } }],
		});
		expect(state.tasks[single.taskId]?.status).toBe("failed");
	});

	it("rejects attempt intents with wrong identities, ordinals, or run state", () => {
		const setup = setupAttemptEvents();
		const prefix = failedPrefix(setup);
		expect(() =>
			reduceWorkflowEvents(
				records([...prefix, attemptIntended(setup.execution, { ordinal: 3 })]),
			),
		).toThrow("attempt ordinal is not contiguous");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...prefix,
					attemptIntended(setup.execution, {
						previousAttemptId: "attempt_other",
					}),
				]),
			),
		).toThrow("does not match the current attempt");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...prefix,
					{
						...attemptIntended(setup.execution),
						data: {
							...attemptIntended(setup.execution).data,
							subagentRunId: "run_other",
						},
					} as WorkflowEventInput,
				]),
			),
		).toThrow("does not match the current attempt");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...prefix,
					attemptIntended(setup.execution, { failureCode: "timeout" }),
				]),
			),
		).toThrow("does not match the settled failure");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...prefix,
					attemptIntended(setup.execution, { failureRetry: "manual" }),
				]),
			),
		).toThrow("does not match the settled failure");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...prefix,
					{
						type: "run-status-changed",
						data: { from: "running", to: "stopping" },
					},
					attemptIntended(setup.execution),
				]),
			),
		).toThrow("requires a running workflow run");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...setup.events,
					...launchedEvents(setup),
					observed(setup.execution, "attempt_child", "failed"),
					attemptIntended(setup.execution),
				]),
			),
		).toThrow("attempt intent is out of order");
	});

	it("rejects attempt intents for never, reconcile, and mismatched kinds", () => {
		const setup = setupAttemptEvents();
		expect(() =>
			reduceWorkflowEvents(
				records([
					...failedPrefix(setup, failedEvidence(1, "never")),
					attemptIntended(setup.execution),
				]),
			),
		).toThrow("retry intent requires a retryable failed settlement");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...failedPrefix(setup, cleanupBlockedEvidence(1)),
					attemptIntended(setup.execution, { failureCode: "sandbox-cleanup" }),
				]),
			),
		).toThrow("retry intent requires a retryable failed settlement");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...failedPrefix(setup, cleanupBlockedEvidence(1)),
					attemptIntended(setup.execution, {
						kind: "resume",
						failureCode: "sandbox-cleanup",
						failureRetry: "resume",
					}),
				]),
			),
		).toThrow("resume intent requires a resumable interrupted settlement");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...failedPrefix(setup),
					attemptIntended(setup.execution, {
						kind: "resume",
						failureRetry: "resume",
					}),
				]),
			),
		).toThrow("resume intent requires a resumable interrupted settlement");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...failedPrefix(setup, interruptedEvidence(1)),
					attemptIntended(setup.execution, {
						kind: "retry",
						failureCode: "seat-interruption",
						failureRetry: "resume",
					}),
				]),
			),
		).toThrow("retry intent requires a retryable failed settlement");
	});

	it("rejects receipts, observations, and settlements that reuse or skip attempts", () => {
		const setup = setupAttemptEvents();
		const intended = [...failedPrefix(setup), attemptIntended(setup.execution)];
		expect(() =>
			reduceWorkflowEvents(
				records([
					...intended,
					attemptReceipted(setup.execution, 2, "attempt_child"),
				]),
			),
		).toThrow("reuses a subagent attempt identity");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...intended,
					attemptReceipted(setup.execution, 3, "attempt_retry"),
				]),
			),
		).toThrow("attempt receipt does not match its intent");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...failedPrefix(setup),
					attemptReceipted(setup.execution, 2, "attempt_retry"),
				]),
			),
		).toThrow("attempt receipt is out of order");
		const receipted = [
			...intended,
			attemptReceipted(setup.execution, 2, "attempt_retry"),
		];
		expect(() =>
			reduceWorkflowEvents(
				records([
					...receipted,
					attemptReceipted(setup.execution, 2, "attempt_retry"),
				]),
			),
		).toThrow("attempt receipt is out of order");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...receipted,
					observed(setup.execution, "attempt_child", "active"),
				]),
			),
		).toThrow("child observation is invalid");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...receipted,
					observed(setup.execution, "attempt_retry", "completed"),
					settlement(setup.execution, completedEvidence()),
				]),
			),
		).toThrow("settlement attempt ordinal does not match");
		expect(() =>
			reduceWorkflowEvents(
				records([...failedPrefix(setup, failedEvidence(2))]),
			),
		).toThrow("settlement attempt ordinal does not match");
		const secondFailure: WorkflowEventInput[] = [
			...receipted,
			observed(setup.execution, "attempt_retry", "failed"),
			settlement(setup.execution, failedEvidence(2)),
			attemptIntended(setup.execution, {
				ordinal: 3,
				previousAttemptId: "attempt_retry",
			}),
		];
		expect(() =>
			reduceWorkflowEvents(
				records([
					...secondFailure,
					attemptReceipted(setup.execution, 3, "attempt_retry"),
				]),
			),
		).toThrow("reuses a subagent attempt identity");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...secondFailure,
					attemptReceipted(setup.execution, 3, "attempt_child"),
				]),
			),
		).toThrow("reuses a subagent attempt identity");
		const third = reduceWorkflowEvents(
			records([
				...secondFailure,
				attemptReceipted(setup.execution, 3, "attempt_third"),
			]),
		).executions[setup.execution.id];
		expect(third?.priorSettlements).toHaveLength(2);
		if (!third) throw new Error("missing projection");
		expect(currentSubagentAttemptId(third)).toBe("attempt_third");
	});

	it("does not release or re-intend around an open or declined attempt", () => {
		const setup = setupAttemptEvents();
		const intended = [...failedPrefix(setup), attemptIntended(setup.execution)];
		expect(() =>
			reduceWorkflowEvents(
				records([
					...intended,
					{
						type: "task-execution-release-intended",
						data: {
							executionId: setup.execution.id,
							subagentRunId: "run_child",
						},
					},
				]),
			),
		).toThrow("release intent is invalid");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...intended,
					attemptIntended(setup.execution, { ordinal: 3 }),
				]),
			),
		).toThrow("attempt intent is out of order");
		expect(() =>
			reduceWorkflowEvents(
				records([...failedPrefix(setup), attemptDeclined(setup.execution, 2)]),
			),
		).toThrow("attempt decline is out of order");
		expect(() =>
			reduceWorkflowEvents(
				records([...intended, attemptDeclined(setup.execution, 3)]),
			),
		).toThrow("attempt decline does not match its intent");
		const declined = [...intended, attemptDeclined(setup.execution, 2)];
		const projection = reduceWorkflowEvents(records(declined)).executions[
			setup.execution.id
		];
		expect(projection).toMatchObject({
			phase: "settled",
			attemptsClosed: true,
			attempts: [{ ordinal: 2, declinedSequence: declined.length }],
			settlement: { evidence: failedEvidence(1) },
		});
		expect(projection?.priorSettlements).toBeUndefined();
		expect(() =>
			reduceWorkflowEvents(
				records([
					...declined,
					attemptIntended(setup.execution, { ordinal: 3 }),
				]),
			),
		).toThrow("attempt intents are closed");
		expect(() =>
			reduceWorkflowEvents(
				records([
					...declined,
					attemptReceipted(setup.execution, 2, "attempt_retry"),
				]),
			),
		).toThrow("attempt receipt is out of order");
		const state = reduceWorkflowEvents(
			records([
				...declined,
				...releaseEvents(setup.execution, "failed"),
				{
					type: "task-execution-terminal",
					data: {
						executionId: setup.execution.id,
						outcome: "failed",
						evidence: failedEvidence(1),
					},
				},
				{
					type: "task-status-changed",
					data: { taskId: setup.taskId, from: "running", to: "failed" },
				},
			]),
		);
		expect(state.executions[setup.execution.id]?.terminal).toMatchObject({
			outcome: "failed",
			evidence: { attemptOrdinal: 1 },
		});
		expect(state.tasks[setup.taskId]?.status).toBe("failed");
	});

	it("rebuilds the retry ladder into the same projection", () => {
		const setup = setupAttemptEvents();
		const events: WorkflowEventInput[] = [
			...failedPrefix(setup),
			attemptIntended(setup.execution),
			attemptReceipted(setup.execution, 2, "attempt_retry"),
			...completedAttemptEvents(setup, "attempt_retry", 2),
		];
		const first = reduceWorkflowEvents(records(events));
		const second = reduceWorkflowEvents(records(structuredClone(events)));
		expect(second).toEqual(first);
		expect(
			Object.isFrozen(first.executions[setup.execution.id]?.attempts),
		).toBe(true);
		expect(first.executions[setup.execution.id]?.priorSettlements).toHaveLength(
			1,
		);
	});
});

describe("handoff derivations", () => {
	const baselineHead = "1".repeat(40);
	const handoffCommit = "2".repeat(40);
	const worktreeRecord = {
		schema: "pi-subagent-worktree",
		contractRevision: 7,
		runId: "run_child",
		attemptId: "attempt_first",
		repositoryRoot: "/private/repo",
		worktreePath: "/private/repo/.worktrees/run_child",
		recordPath: "/private/records/run_child.json",
		branch: "pi-subagent/run_child/attempt_first",
		baselineHead,
		createdAt: "2026-09-01T00:00:00.000Z",
		handoffCommit,
		handoffRef: "refs/pi-subagent/handoffs/run_child/attempt_first",
	};
	const result = {
		runId: "run_child",
		status: "completed" as const,
		structuredOutput: { answer: "yes" },
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
		sandboxCleanup: "proved" as const,
		workspaceCleanup: "proved" as const,
		truncated: false,
	};

	it("projects only the handoff identity into settlement evidence", () => {
		const evidence = deriveSubagentSettlementEvidence(
			{ result, handoff: worktreeRecord },
			1,
		);
		expect(evidence.handoff).toEqual({
			attemptId: "attempt_first",
			baselineHead,
			handoffCommit,
		});
		expect(JSON.stringify(evidence)).not.toMatch(/private|refs\/|branch/);
		const readOnly = deriveSubagentSettlementEvidence({ result }, 1);
		expect("handoff" in readOnly).toBe(false);
		expect({ ...evidence, handoff: undefined }).toEqual({
			...readOnly,
			handoff: undefined,
		});
		const { handoffCommit: _omitted, ...noChanges } = worktreeRecord;
		expect(
			"handoff" in
				deriveSubagentSettlementEvidence({ result, handoff: noChanges }, 1),
		).toBe(false);
	});

	it("rejects malformed handoff records", () => {
		for (const handoff of [
			null,
			"attempt_first",
			{ ...worktreeRecord, attemptId: "first" },
			{ ...worktreeRecord, baselineHead: "main" },
			{ ...worktreeRecord, handoffCommit: "HEAD" },
			{ ...worktreeRecord, handoffCommit: baselineHead },
		]) {
			expect(() =>
				deriveSubagentSettlementEvidence({ result, handoff }, 1),
			).toThrow("subagent handoff record is invalid");
		}
	});

	it("derives the handoff descriptor from the import and its artifact", () => {
		const execution = {
			kind: "agent" as const,
			id: `execution_${"3".repeat(64)}`,
			runId: "workflow_handoff",
			taskId: "task_writer",
			generation: 1 as const,
			taskIdentitySha256: planIdentitySha256,
			operationId: `workflow-op_${"4".repeat(64)}`,
		};
		const sha256 = "5".repeat(64);
		const ref: WorkflowArtifactRef = {
			id: deriveWorkflowArtifactId({
				runId: execution.runId,
				producerTaskId: execution.taskId,
				producerExecutionId: execution.id,
				output: "handoff",
				schemaSha256: WORKFLOW_HANDOFF_FORMAT_SHA256,
				sha256,
			}),
			runId: execution.runId,
			producerTaskId: execution.taskId,
			producerExecutionId: execution.id,
			output: "handoff",
			sha256,
			bytes: 512,
			mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
			schemaSha256: WORKFLOW_HANDOFF_FORMAT_SHA256,
		};
		const handoffImport = {
			subagentRunId: "run_child",
			subagentAttemptId: "attempt_first",
			artifactId: ref.id,
			handoffCommit,
			baselineHead,
			sha256,
			bytes: 512,
			sequence: 9,
		};
		expect(
			deriveWorkflowHandoffDescriptor(ref, { execution, handoffImport }),
		).toEqual({
			artifactId: ref.id,
			runId: execution.runId,
			producerTaskId: execution.taskId,
			producerExecutionId: execution.id,
			subagentRunId: "run_child",
			subagentAttemptId: "attempt_first",
			baselineHead,
			handoffCommit,
			format: "git-format-patch",
			mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
			sha256,
			bytes: 512,
		});
		expect(() => deriveWorkflowHandoffDescriptor(ref, { execution })).toThrow(
			"workflow handoff descriptor requires a handoff import",
		);
		expect(() =>
			deriveWorkflowHandoffDescriptor(
				{ ...ref, output: "result" },
				{ execution, handoffImport },
			),
		).toThrow("workflow handoff descriptor requires a handoff artifact");
		for (const mismatch of [
			{ ...ref, bytes: 511 },
			{ ...ref, sha256: "6".repeat(64) },
			{ ...ref, producerExecutionId: `execution_${"7".repeat(64)}` },
			{ ...ref, mediaType: "application/json" },
			{ ...ref, schemaSha256: planIdentitySha256 },
		]) {
			expect(() =>
				deriveWorkflowHandoffDescriptor(mismatch, { execution, handoffImport }),
			).toThrow("workflow handoff artifact does not match its import");
		}
	});
});

describe("canonical JSON digests", () => {
	const fixtures: unknown[] = [
		null,
		true,
		"text",
		0,
		-0,
		1.5e300,
		[],
		{},
		{ b: [1, { d: null, c: "x" }], a: { z: -0, y: [true, false] } },
		{
			schema: "pi-workflow-support-task-descriptor",
			parametersSchema: { type: "object", additionalProperties: false },
			nested: [[[{ k: [] }]]],
		},
	];

	it("derives the same digest as pi-subagent's canonicalSha256", () => {
		// `digest.ts` reproduces pi-subagent's canonical form so the dynamic
		// worker can derive identities without loading pi-subagent; the two
		// implementations must never drift.
		for (const fixture of fixtures) {
			expect(deriveJsonValueSha256(fixture)).toBe(canonicalSha256(fixture));
			expect(digestJsonValueSha256(fixture)).toBe(canonicalSha256(fixture));
		}
		expect(canonicalJson({ b: 1, a: [-0, { d: 2, c: 3 }] })).toBe(
			'{"a":[0,{"c":3,"d":2}],"b":1}',
		);
	});

	it("refuses the values pi-subagent refuses with the same reasons", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		for (const [value, message] of [
			[Number.NaN, "non-finite canonical number"],
			[Number.POSITIVE_INFINITY, "non-finite canonical number"],
			[{ a: undefined }, "undefined canonical field: a"],
			[() => 1, "non-serializable canonical value: function"],
			[Symbol("s"), "non-serializable canonical value: symbol"],
			[10n, "non-serializable canonical value: bigint"],
			[cyclic, "cyclic canonical value"],
		] as const) {
			expect(() => deriveJsonValueSha256(value)).toThrow(message);
			expect(() => canonicalSha256(value)).toThrow(message);
		}
	});
});
