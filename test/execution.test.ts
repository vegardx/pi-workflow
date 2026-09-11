import { randomUUID } from "node:crypto";
import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type {
	AgentTaskExecutionRecord,
	MaterializedSupportTask,
	SubagentTerminalEvidence,
	SupportTaskExecutionRecord,
	SupportTaskTerminalEvidence,
	WorkflowArtifactRef,
	WorkflowTaskId,
} from "../src/contracts.js";
import type { WorkflowEventInput } from "../src/events.js";
import {
	deriveJsonValueSha256,
	deriveSubagentOperationId,
	deriveSubagentResultSha256,
	deriveSupportImplementationIdentitySha256,
	deriveTaskExecutionId,
	deriveWorkflowArtifactId,
	deriveWorkflowFailureSha256,
} from "../src/execution.js";
import { WorkflowTaskMaterializer } from "../src/materializer.js";
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
		contractRevision: 11,
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
