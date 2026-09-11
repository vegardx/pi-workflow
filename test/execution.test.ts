import { randomUUID } from "node:crypto";
import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type {
	AgentTaskExecutionRecord,
	MaterializedNestedWorkflowTask,
	MaterializedSupportTask,
	NestedWorkflowTaskExecutionRecord,
	NestedWorkflowTaskRequest,
	NestedWorkflowTerminalEvidence,
	SubagentTerminalEvidence,
	SupportTaskExecutionRecord,
	SupportTaskTerminalEvidence,
	WorkflowArtifactRef,
	WorkflowRunStatus,
	WorkflowTaskId,
} from "../src/contracts.js";
import type { WorkflowEventInput } from "../src/events.js";
import {
	deriveJsonValueSha256,
	deriveNestedWorkflowRunId,
	deriveSubagentOperationId,
	deriveSubagentResultSha256,
	deriveSupportImplementationIdentitySha256,
	deriveTaskExecutionId,
	deriveWorkflowArtifactId,
	deriveWorkflowFailureSha256,
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
		contractRevision: 12,
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
				output: "result",
				schemaSha256: planIdentitySha256,
				sha256: planIdentitySha256,
			}),
		).not.toBe(
			deriveWorkflowArtifactId({
				runId: "workflow_execution",
				producerTaskId: "task_two",
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
		).toThrow("generation is unavailable");
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
		inputs?: MaterializedNestedWorkflowTask["spec"]["inputs"];
	} = {},
): MaterializedNestedWorkflowTask {
	const key = options.key ?? "child";
	const position = options.position ?? 1;
	const namespace: string[] = [];
	const spec = {
		key,
		kind: "workflow" as const,
		disposition: "required" as const,
		after: [],
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
		).toThrow("event payload does not match a known workflow event");
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
