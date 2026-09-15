import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type {
	MaterializedAgentTask,
	MaterializedNestedWorkflowTask,
	MaterializedSupportTask,
	MaterializedWorkflowTask,
	SubagentTerminalEvidence,
	WorkflowArtifactRef,
	WorkflowTaskId,
	WorkflowTaskStatus,
} from "../src/contracts.js";
import { WORKFLOW_CONTRACT_REVISION } from "../src/contracts.js";
import type {
	TaskExecutionProjection,
	WorkflowBarrierProjection,
	WorkflowEffectProjection,
	WorkflowEventInput,
	WorkflowStateProjection,
} from "../src/events.js";
import {
	deriveNestedWorkflowRunId,
	deriveSubagentOperationId,
	deriveTaskExecutionId,
} from "../src/execution.js";
import type { WorkflowJournalEvent } from "../src/persistence/journal.js";
import {
	runInspection,
	runLogs,
	runSummary,
	taskViews,
} from "../src/run-projection.js";
import type { WorkflowRunRecord } from "../src/run-record.js";
import {
	MAX_WORKFLOW_LOG_MESSAGE_LENGTH,
	MAX_WORKFLOW_TASK_KEY_LENGTH,
	WorkflowArtifactViewSchema,
	WorkflowBarrierViewSchema,
	WorkflowBudgetViewSchema,
	WorkflowEffectViewSchema,
	WorkflowExecutionViewSchema,
	WorkflowLogEntrySchema,
	WorkflowLogPageSchema,
	WorkflowRunInspectionSchema,
	WorkflowRunSummarySchema,
	WorkflowServiceTaskViewSchema,
} from "../src/service-views.js";

// ---------------------------------------------------------------------------
// Hand-built fixtures shaped like the reducer's projections
// ---------------------------------------------------------------------------

const RUN_ID = "workflow_projectionfixture";
const SHA = "a".repeat(64);
const SHA_B = "b".repeat(64);
const NOW = Date.parse("2026-09-15T12:05:00.000Z");
const PROMPT_GOAL = "Answer the secret question";
const PROMPT_INSTRUCTION = "Return structured output only.";
const CHILD_PROSE = "provider hiccup while calling the model";
const CHILD_GUIDANCE = "Try again later.";
const WORKFLOW_FAILURE_MESSAGE = "preflight rejected the plan: SECRET PATH";
const DECLINED_REASON = "Workflow deadline precedes the retry backoff.";

const record: WorkflowRunRecord = {
	schema: "pi-workflow-run",
	contractRevision: WORKFLOW_CONTRACT_REVISION,
	runId: RUN_ID,
	depth: 0,
	definitionName: "projection",
	definitionPath: "/project/workflows/projection.workflow.ts",
	definitionIdentitySha256: SHA,
	definitionSourceSha256: SHA_B,
	concurrency: 2,
	declaredBudget: { cost: 10, childRuntimeMs: 3_600_000 },
	effectiveBudget: { cost: 1, totalTokens: 10_000, childRuntimeMs: 60_000 },
	declaredTimeoutMs: 3_600_000,
	effectiveTimeoutMs: 900_000,
	deadlineAt: "2026-09-15T12:15:00.000Z",
	cwd: "/project",
	input: { value: "x" },
	createdAt: "2026-09-15T12:00:00.000Z",
};

const nestedRecord: WorkflowRunRecord = {
	...record,
	depth: 1,
	parent: {
		runId: "workflow_parentrun",
		taskId: "task_parentchild",
		executionId: deriveTaskExecutionId(
			"workflow_parentrun",
			"task_parentchild",
			1,
		),
		ancestorDefinitionIdentities: [SHA_B],
		inputArtifacts: {
			doc: {
				runId: "workflow_parentrun",
				artifactId: `artifact_${SHA}`,
				sha256: SHA,
			},
		},
	},
};

function agentTask(
	key: string,
	sequence: number,
	options: {
		namespace?: readonly string[];
		after?: readonly WorkflowTaskId[];
		inputs?: Readonly<Record<string, WorkflowTaskId>>;
		disposition?: "required" | "optional";
	} = {},
): MaterializedAgentTask {
	return {
		id: `task_${key}`,
		runId: RUN_ID,
		namespace: [...(options.namespace ?? [])],
		spec: {
			key,
			kind: "agent",
			role: "task",
			disposition: options.disposition ?? "required",
			after: (options.after ?? []).map((taskId) => ({ runId: RUN_ID, taskId })),
			inputs: Object.fromEntries(
				Object.entries(options.inputs ?? {}).map(([name, producerTaskId]) => [
					name,
					{ runId: RUN_ID, producerTaskId, output: "result" as const },
				]),
			),
			replay: "auto",
			request: {
				agent: "researcher",
				task: {
					goal: PROMPT_GOAL,
					context: [],
					instructions: [PROMPT_INSTRUCTION],
				},
				contextMode: "fresh",
				tools: ["read"],
				preloadSkills: [],
				contextScopes: ["project"],
				workspace: { mode: "read-only", cwd: "/project" },
				outputSchema: { type: "object" },
				limits: {
					cumulativeRuntimeMs: 30_000,
					attemptTimeoutMs: 30_000,
					totalTokens: 1_000,
					cost: 0.5,
					outputBytes: 1024,
					workspaceWriteBytes: 0,
					retries: 1,
					resumes: 0,
				},
			},
			identitySha256: SHA,
		},
		definitionIdentitySha256: SHA,
		materializationSequence: sequence,
		materializationEpoch: 1,
		epochPosition: sequence,
	};
}

function supportTask(
	key: string,
	sequence: number,
	options: {
		after?: readonly WorkflowTaskId[];
		inputs?: Readonly<Record<string, WorkflowTaskId>>;
	} = {},
): MaterializedSupportTask {
	return {
		id: `task_${key}`,
		runId: RUN_ID,
		namespace: [],
		spec: {
			key,
			kind: "support",
			role: "task",
			disposition: "optional",
			after: (options.after ?? []).map((taskId) => ({ runId: RUN_ID, taskId })),
			inputs: Object.fromEntries(
				Object.entries(options.inputs ?? {}).map(([name, producerTaskId]) => [
					name,
					{ runId: RUN_ID, producerTaskId, output: "result" as const },
				]),
			),
			replay: "auto",
			request: {
				implementation: {
					name: "tools/summarize",
					moduleSpecifier: "tools",
					revision: 1,
					implementationSha256: SHA,
					parametersSchema: { type: "object" },
					outputSchema: { type: "object" },
				},
				parameters: {},
			},
			identitySha256: SHA,
		},
		definitionIdentitySha256: SHA,
		materializationSequence: sequence,
		materializationEpoch: 1,
		epochPosition: sequence,
	};
}

function nestedTask(
	key: string,
	sequence: number,
): MaterializedNestedWorkflowTask {
	return {
		id: `task_${key}`,
		runId: RUN_ID,
		namespace: [],
		spec: {
			key,
			kind: "workflow",
			role: "task",
			disposition: "required",
			after: [],
			inputs: {},
			replay: "auto",
			request: {
				definitionName: "child",
				definitionIdentitySha256: SHA,
				definitionSourceSha256: SHA_B,
				definitionVersion: 1,
				input: { value: "x" },
				inputSha256: SHA,
				inputSchema: { type: "object" },
				outputSchema: { type: "object" },
				budget: { cost: 0.25, totalTokens: 500, childRuntimeMs: 5_000 },
				timeoutMs: 600_000,
				concurrency: 2,
			},
			identitySha256: SHA,
		},
		definitionIdentitySha256: SHA,
		materializationSequence: sequence,
		materializationEpoch: 1,
		epochPosition: sequence,
	};
}

function evidence(
	status: SubagentTerminalEvidence["status"],
	attemptOrdinal: number,
	failure?: SubagentTerminalEvidence["failure"],
): SubagentTerminalEvidence {
	return {
		kind: "subagent",
		attemptOrdinal,
		resultSha256: SHA,
		status,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: 0.01,
		},
		usageComplete: true,
		runtimeMs: 10,
		...(failure ? { failure } : {}),
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
	};
}

function subagentFailure(retry: "never" | "manual" | "backoff" | "resume") {
	return {
		code: "provider-transient" as const,
		origin: "provider" as const,
		retry,
		message: CHILD_PROSE,
		guidance: CHILD_GUIDANCE,
	};
}

function agentRecord(task: MaterializedWorkflowTask, generation: number) {
	return {
		kind: "agent" as const,
		id: deriveTaskExecutionId(RUN_ID, task.id, generation),
		runId: RUN_ID,
		taskId: task.id,
		generation,
		taskIdentitySha256: SHA,
		operationId: deriveSubagentOperationId(RUN_ID, task.id, generation),
	};
}

function receipt(
	task: MaterializedWorkflowTask,
	generation: number,
	sequence: number,
) {
	return {
		operationId: deriveSubagentOperationId(RUN_ID, task.id, generation),
		subagentRunId: `run_child${generation}${task.spec.key}`,
		subagentAttemptId: `attempt_child${generation}${task.spec.key}`,
		status: "active" as const,
		sequence,
	};
}

function artifact(
	id: string,
	producer?: { taskId: WorkflowTaskId; executionId: string },
): WorkflowArtifactRef {
	return {
		id: `artifact_${id.padStart(8, "0").padEnd(64, "0")}`,
		runId: RUN_ID,
		...(producer
			? {
					producerTaskId: producer.taskId,
					producerExecutionId: producer.executionId,
					output: "result" as const,
				}
			: {}),
		sha256: SHA,
		bytes: 42,
		mediaType: "application/json",
		schemaSha256: SHA_B,
	};
}

// Rich fixture --------------------------------------------------------------

const answer = agentTask("answer", 1);
const summary = supportTask("summary", 2, {
	after: [answer.id],
	inputs: { doc: answer.id },
});
const child = nestedTask("child", 3);
const stale = agentTask("stale", 4);
const blocked = agentTask("blocked", 5);
const declined = agentTask("declined", 6, { disposition: "optional" });
const item = agentTask("item", 7, { namespace: ["batch"] });

const answerGen1Id = deriveTaskExecutionId(RUN_ID, answer.id, 1);
const answerGen2Id = deriveTaskExecutionId(RUN_ID, answer.id, 2);
const summaryExecutionId = deriveTaskExecutionId(RUN_ID, summary.id, 1);
const childExecutionId = deriveTaskExecutionId(RUN_ID, child.id, 1);
const blockedExecutionId = deriveTaskExecutionId(RUN_ID, blocked.id, 1);
const declinedExecutionId = deriveTaskExecutionId(RUN_ID, declined.id, 1);
const childRunId = deriveNestedWorkflowRunId(RUN_ID, child.id, 1);

const answerResult = artifact("1", {
	taskId: answer.id,
	executionId: answerGen2Id,
});
const summaryResult = artifact("2", {
	taskId: summary.id,
	executionId: summaryExecutionId,
});
const runLevelArtifact = artifact("3");

const answerGen1: TaskExecutionProjection = {
	execution: agentRecord(answer, 1),
	phase: "terminal",
	createdSequence: 7,
	launchReceipt: receipt(answer, 1, 8),
	settlement: {
		evidence: evidence("failed", 1, subagentFailure("manual")),
		sequence: 9,
	},
	terminal: {
		outcome: "failed",
		evidence: evidence("failed", 1, subagentFailure("manual")),
		sequence: 15,
	},
};

const answerGen2: TaskExecutionProjection = {
	execution: agentRecord(answer, 2),
	phase: "terminal",
	createdSequence: 21,
	launchReceipt: receipt(answer, 2, 22),
	priorSettlements: [
		{
			evidence: evidence("failed", 1, subagentFailure("backoff")),
			sequence: 23,
		},
	],
	attempts: [
		{
			kind: "retry",
			ordinal: 2,
			previousAttemptId: "attempt_child2answer",
			origin: "policy" as const,
			subagentAttemptId: "attempt_child2answerx2",
			status: "active",
			intentSequence: 10,
			receiptSequence: 11,
		},
	],
	settlement: { evidence: evidence("completed", 2), sequence: 24 },
	artifactImport: {
		subagentRunId: "run_child2answer",
		artifactId: answerResult.id,
		sourceResultSha256: SHA,
		sequence: 25,
	},
	terminal: {
		outcome: "completed",
		evidence: evidence("completed", 2),
		sequence: 13,
	},
};

const summaryExecution: TaskExecutionProjection = {
	execution: {
		kind: "support",
		id: summaryExecutionId,
		runId: RUN_ID,
		taskId: summary.id,
		generation: 1,
		taskIdentitySha256: SHA,
		implementationIdentitySha256: SHA_B,
	},
	phase: "terminal",
	createdSequence: 26,
	supportIntent: {
		implementationIdentitySha256: SHA_B,
		parametersSha256: SHA,
		inputsSha256: SHA,
		sequence: 27,
	},
	supportOutput: {
		artifactId: summaryResult.id,
		outputSha256: SHA,
		sequence: 28,
	},
	terminal: {
		outcome: "completed",
		evidence: {
			kind: "support",
			implementationIdentitySha256: SHA_B,
			parametersSha256: SHA,
			inputsSha256: SHA,
			outputSha256: SHA,
			artifactId: summaryResult.id,
			durationMs: 5,
		},
		sequence: 29,
	},
};

const childExecution: TaskExecutionProjection = {
	execution: {
		kind: "workflow",
		id: childExecutionId,
		runId: RUN_ID,
		taskId: child.id,
		generation: 1,
		taskIdentitySha256: SHA,
		childRunId,
	},
	phase: "terminal",
	createdSequence: 31,
	nestedIntent: {
		childRunId,
		definitionIdentitySha256: SHA,
		inputSha256: SHA,
		inputsSha256: SHA,
		resolvedInputSha256: SHA,
		budget: { cost: 0.25, totalTokens: 500, childRuntimeMs: 5_000 },
		timeoutMs: 600_000,
		deadlineAt: "2026-09-15T12:15:00.000Z",
		concurrency: 2,
		sequence: 32,
	},
	nestedLaunch: { childRunId, sequence: 33 },
	nestedSettlement: {
		childRunId,
		status: "completed",
		usage: { cost: 0.05, totalTokens: 50, childRuntimeMs: 500 },
		usageComplete: false,
		sequence: 34,
	},
	terminal: {
		outcome: "completed",
		evidence: {
			kind: "nested-workflow",
			childRunId,
			status: "completed",
			usage: { cost: 0.05, totalTokens: 50, childRuntimeMs: 500 },
			usageComplete: false,
		},
		sequence: 35,
	},
};

const blockedExecution: TaskExecutionProjection = {
	execution: agentRecord(blocked, 1),
	phase: "terminal",
	createdSequence: 36,
	terminal: {
		outcome: "failed",
		evidence: {
			kind: "workflow",
			stage: "preflight",
			failureSha256: SHA,
			message: WORKFLOW_FAILURE_MESSAGE,
		},
		sequence: 14,
	},
};

const declinedExecution: TaskExecutionProjection = {
	execution: agentRecord(declined, 1),
	phase: "terminal",
	createdSequence: 37,
	launchReceipt: receipt(declined, 1, 38),
	settlement: {
		evidence: evidence("failed", 1, subagentFailure("backoff")),
		sequence: 39,
	},
	attempts: [
		{
			kind: "retry",
			ordinal: 2,
			previousAttemptId: "attempt_child1declined",
			origin: "policy" as const,
			intentSequence: 41,
			declinedSequence: 12,
		},
	],
	attemptsClosed: true,
	terminal: {
		outcome: "failed",
		evidence: evidence("failed", 1, subagentFailure("backoff")),
		sequence: 42,
	},
};

interface TaskEntry {
	readonly task: MaterializedWorkflowTask;
	readonly status: WorkflowTaskStatus;
	readonly executions?: readonly TaskExecutionProjection[];
	readonly abandoned?: true;
}

function stateOf(input: {
	status: WorkflowStateProjection["status"];
	entries: readonly TaskEntry[];
	effects?: readonly WorkflowEffectProjection[];
	barriers?: readonly WorkflowBarrierProjection[];
	artifacts?: readonly WorkflowArtifactRef[];
	outputArtifactId?: string;
	lastSequence?: number;
}): WorkflowStateProjection {
	const tasks: WorkflowStateProjection["tasks"] = {};
	const executions: WorkflowStateProjection["executions"] = {};
	for (const entry of input.entries) {
		const current = entry.executions?.at(-1);
		tasks[entry.task.id] = {
			task: entry.task,
			status: entry.status,
			committed: false,
			...(current ? { currentExecutionId: current.execution.id } : {}),
			...(entry.abandoned ? { abandoned: true } : {}),
		};
		for (const execution of entry.executions ?? []) {
			executions[execution.execution.id] = execution;
		}
	}
	const artifacts: WorkflowStateProjection["artifacts"] = {};
	for (const ref of input.artifacts ?? []) artifacts[ref.id] = ref;
	return {
		runId: RUN_ID,
		definitionIdentitySha256: SHA,
		inputSha256: SHA,
		status: input.status,
		currentEpoch: 2,
		effects: [...(input.effects ?? [])],
		lastSequence: input.lastSequence ?? 40,
		tasks,
		executions,
		artifacts,
		barriers: [...(input.barriers ?? [])],
		...(input.outputArtifactId
			? { outputArtifactId: input.outputArtifactId }
			: {}),
	};
}

const richState = stateOf({
	status: "completed",
	entries: [
		{ task: answer, status: "completed", executions: [answerGen1, answerGen2] },
		{ task: summary, status: "completed", executions: [summaryExecution] },
		{ task: child, status: "completed", executions: [childExecution] },
		{ task: stale, status: "invalidated", abandoned: true },
		{ task: blocked, status: "failed", executions: [blockedExecution] },
		{ task: declined, status: "failed", executions: [declinedExecution] },
		{ task: item, status: "pending" },
	],
	effects: [
		{ ordinal: 1, kind: "phase", value: "plan", sequence: 3 },
		{ ordinal: 2, kind: "log", value: "hello", sequence: 4 },
		{
			ordinal: 3,
			kind: "log",
			value: "after barrier",
			sequence: 40,
			abandoned: true,
		},
	],
	barriers: [
		{ epoch: 1, kind: "result", taskIds: [answer.id], sequence: 20 },
		{
			epoch: 2,
			kind: "final",
			taskIds: [answer.id, summary.id, child.id],
			sequence: 30,
			abandoned: true,
		},
	],
	artifacts: [answerResult, summaryResult, runLevelArtifact],
	outputArtifactId: answerResult.id,
});

// Events matching the rich fixture (hand-sequenced; runLogs is pure) ----------

function timestampAt(sequence: number): string {
	return new Date(
		Date.parse(record.createdAt) + sequence * 1_000,
	).toISOString();
}

function event(
	sequence: number,
	input: WorkflowEventInput,
): WorkflowJournalEvent {
	return {
		schema: "pi-workflow-event",
		contractRevision: WORKFLOW_CONTRACT_REVISION,
		sequence,
		eventId: randomUUID(),
		timestamp: timestampAt(sequence),
		runId: RUN_ID,
		ownerId: "pi-workflow-service:test",
		leaseId: "lease-test",
		fencingGeneration: 1,
		type: input.type,
		data: input.data,
	} as WorkflowJournalEvent;
}

const richEvents: readonly WorkflowJournalEvent[] = [
	event(1, {
		type: "run-created",
		data: { definitionIdentitySha256: SHA, inputSha256: SHA },
	}),
	event(2, {
		type: "run-status-changed",
		data: { from: "created", to: "running" },
	}),
	event(3, {
		type: "workflow-effect",
		data: { ordinal: 1, kind: "phase", value: "plan" },
	}),
	event(4, {
		type: "workflow-effect",
		data: { ordinal: 2, kind: "log", value: "hello" },
	}),
	event(5, { type: "task-declared", data: { task: answer } }),
	event(6, {
		type: "task-status-changed",
		data: { taskId: answer.id, from: "pending", to: "ready" },
	}),
	event(7, {
		type: "task-execution-created",
		data: { execution: answerGen1.execution },
	}),
	event(8, {
		type: "task-execution-launch-receipted",
		data: {
			executionId: answerGen1Id,
			operationId: deriveSubagentOperationId(RUN_ID, answer.id, 1),
			subagentRunId: "run_child1answer",
			subagentAttemptId: "attempt_child1answer",
			status: "active",
		},
	}),
	event(9, {
		type: "task-execution-child-settled",
		data: {
			executionId: answerGen1Id,
			evidence: evidence("failed", 1, subagentFailure("manual")),
		},
	}),
	event(10, {
		type: "task-execution-attempt-intended",
		data: {
			executionId: answerGen2Id,
			subagentRunId: "run_child2answer",
			kind: "retry",
			ordinal: 2,
			previousAttemptId: "attempt_child2answer",
			origin: "policy" as const,
			failureCode: "provider-transient",
			failureRetry: "backoff",
		},
	}),
	event(11, {
		type: "task-execution-attempt-receipted",
		data: {
			executionId: answerGen2Id,
			subagentRunId: "run_child2answer",
			ordinal: 2,
			subagentAttemptId: "attempt_child2answerx2",
			status: "active",
		},
	}),
	event(12, {
		type: "task-execution-attempt-declined",
		data: {
			executionId: declinedExecutionId,
			subagentRunId: "run_child1declined",
			ordinal: 2,
			reason: DECLINED_REASON,
		},
	}),
	event(13, {
		type: "task-execution-terminal",
		data: {
			executionId: answerGen2Id,
			outcome: "completed",
			evidence: evidence("completed", 2),
		},
	}),
	event(14, {
		type: "task-execution-terminal",
		data: {
			executionId: blockedExecutionId,
			outcome: "failed",
			evidence: {
				kind: "workflow",
				stage: "preflight",
				failureSha256: SHA,
				message: WORKFLOW_FAILURE_MESSAGE,
			},
		},
	}),
	event(15, {
		type: "task-execution-terminal",
		data: {
			executionId: answerGen1Id,
			outcome: "failed",
			evidence: evidence("failed", 1, subagentFailure("manual")),
		},
	}),
	event(16, {
		type: "task-invalidated",
		data: {
			causeTaskId: answer.id,
			taskIds: [answer.id, summary.id],
			abandonedEpochs: [2],
			reason: "operator re-run",
		},
	}),
	event(17, {
		type: "run-status-changed",
		data: {
			from: "failed",
			to: "running",
			reason: "Explicit invalidation re-executes invalidated tasks.",
		},
	}),
	event(18, {
		type: "task-status-changed",
		data: {
			taskId: item.id,
			from: "pending",
			to: "blocked",
			reason: "A required predecessor failed.",
		},
	}),
	event(19, {
		type: "barrier-reached",
		data: { epoch: 1, kind: "result", taskIds: [answer.id] },
	}),
	event(20, { type: "artifact-declared", data: { artifact: answerResult } }),
	event(21, {
		type: "run-output-committed",
		data: { artifactId: answerResult.id },
	}),
	event(40, {
		type: "workflow-effect",
		data: { ordinal: 3, kind: "log", value: "after barrier" },
	}),
];

const ALL_SECTIONS = [
	"run",
	"budget",
	"tasks",
	"executions",
	"effects",
	"barriers",
	"artifacts",
] as const;

function keysOf(value: object): string[] {
	return Object.keys(value).sort();
}

// ---------------------------------------------------------------------------
// taskViews
// ---------------------------------------------------------------------------

describe("taskViews", () => {
	const views = taskViews(richState);

	it("lists every task in materialization order with the enriched fields", () => {
		expect(views.map((view) => view.id)).toEqual([
			answer.id,
			summary.id,
			child.id,
			stale.id,
			blocked.id,
			declined.id,
			item.id,
		]);
		expect(views[0]).toEqual({
			id: answer.id,
			namespace: [],
			key: "answer",
			kind: "agent",
			role: "task",
			disposition: "required",
			status: "completed",
			generation: 2,
			executionId: answerGen2Id,
			attempts: 1,
			settlement: {
				attemptOrdinal: 2,
				status: "completed",
				usageComplete: true,
			},
			outcome: "completed",
		});
	});

	it("omits attempts and settlement for a support task", () => {
		expect(views[1]).toEqual({
			id: summary.id,
			namespace: [],
			key: "summary",
			kind: "support",
			role: "task",
			disposition: "optional",
			status: "completed",
			generation: 1,
			executionId: summaryExecutionId,
			outcome: "completed",
		});
	});

	it("projects a nested settlement with attempt ordinal 1 and its terminal run status", () => {
		expect(views[2]).toEqual({
			id: child.id,
			namespace: [],
			key: "child",
			kind: "workflow",
			role: "task",
			disposition: "required",
			status: "completed",
			generation: 1,
			executionId: childExecutionId,
			settlement: {
				attemptOrdinal: 1,
				status: "completed",
				usageComplete: false,
			},
			outcome: "completed",
		});
	});

	it("keeps the abandoned marker and reports generation 0 without an execution", () => {
		expect(views[3]).toEqual({
			id: stale.id,
			namespace: [],
			key: "stale",
			kind: "agent",
			role: "task",
			disposition: "required",
			status: "invalidated",
			generation: 0,
			abandoned: true,
		});
		expect(views[6]).toEqual({
			id: item.id,
			namespace: ["batch"],
			key: "item",
			kind: "agent",
			role: "task",
			disposition: "required",
			status: "pending",
			generation: 0,
		});
	});

	it("reports zero attempts and no settlement for a workflow-stage failure", () => {
		expect(views[4]).toEqual({
			id: blocked.id,
			namespace: [],
			key: "blocked",
			kind: "agent",
			role: "task",
			disposition: "required",
			status: "failed",
			generation: 1,
			executionId: blockedExecutionId,
			attempts: 0,
			outcome: "failed",
		});
	});

	it("carries the failure code and retry class of a settled failure", () => {
		expect(views[5]).toEqual({
			id: declined.id,
			namespace: [],
			key: "declined",
			kind: "agent",
			role: "task",
			disposition: "optional",
			status: "failed",
			generation: 1,
			executionId: declinedExecutionId,
			attempts: 1,
			settlement: {
				attemptOrdinal: 1,
				status: "failed",
				failureCode: "provider-transient",
				failureRetry: "backoff",
				usageComplete: true,
			},
			outcome: "failed",
		});
	});

	it("adds sorted dependsOn and named inputs only when the graph is requested", () => {
		for (const view of views) {
			expect(view).not.toHaveProperty("dependsOn");
			expect(view).not.toHaveProperty("inputs");
		}
		const graph = taskViews(richState, { graph: true });
		expect(graph[1]).toMatchObject({
			id: summary.id,
			dependsOn: [answer.id],
			inputs: { doc: answer.id },
		});
		expect(graph[0]).toMatchObject({ dependsOn: [], inputs: {} });
	});

	it("validates against the task view schema and never leaks prompts", () => {
		for (const view of [...views, ...taskViews(richState, { graph: true })]) {
			expect(Value.Check(WorkflowServiceTaskViewSchema, view)).toBe(true);
		}
		const serialized = JSON.stringify(views);
		expect(serialized).not.toContain(PROMPT_GOAL);
		expect(serialized).not.toContain(PROMPT_INSTRUCTION);
		expect(serialized).not.toContain(CHILD_PROSE);
	});
});

// ---------------------------------------------------------------------------
// runSummary
// ---------------------------------------------------------------------------

describe("runSummary", () => {
	it("summarizes a created run from its record alone", () => {
		const summaryView = runSummary(
			record,
			undefined,
			[],
			"inactive",
			false,
			NOW,
		);
		expect(summaryView).toEqual({
			runId: RUN_ID,
			definitionName: "projection",
			status: "created",
			createdAt: record.createdAt,
			updatedAt: record.createdAt,
			deadlineAt: record.deadlineAt,
			depth: 0,
			lastSequence: 0,
			taskCounts: {
				pending: 0,
				ready: 0,
				running: 0,
				waiting: 0,
				completed: 0,
				failed: 0,
				interrupted: 0,
				blocked: 0,
				cancelling: 0,
				cancelled: 0,
				"cleanup-blocked": 0,
				invalidated: 0,
				abandoned: 0,
				total: 0,
			},
			ownership: "inactive",
			leasedElsewhere: false,
			availableActions: ["stop", "wait", "reconcile"],
			requiresAttention: false,
		});
		expect(Value.Check(WorkflowRunSummarySchema, summaryView)).toBe(true);
	});

	it("counts on-path tasks per status and abandoned tasks separately", () => {
		const summaryView = runSummary(
			record,
			richState,
			richEvents,
			"inactive",
			false,
			NOW,
		);
		expect(summaryView).toMatchObject({
			status: "completed",
			updatedAt: timestampAt(40),
			lastSequence: 40,
			taskCounts: {
				pending: 1,
				completed: 3,
				failed: 2,
				invalidated: 0,
				abandoned: 1,
				total: 7,
			},
			ownership: "inactive",
			leasedElsewhere: false,
			availableActions: [],
			requiresAttention: false,
			outputArtifactId: answerResult.id,
		});
		expect(summaryView).not.toHaveProperty("output");
		expect(summaryView).not.toHaveProperty("parent");
		expect(Object.keys(summaryView.taskCounts)).toHaveLength(14);
		expect(Value.Check(WorkflowRunSummarySchema, summaryView)).toBe(true);
	});

	it("derives actions and attention from the run facts", () => {
		const failedState = stateOf({
			status: "failed",
			entries: [{ task: answer, status: "failed", executions: [answerGen1] }],
		});
		const failed = runSummary(
			record,
			failedState,
			richEvents,
			"inactive",
			false,
			NOW,
		);
		expect(failed.availableActions).toEqual(["invalidate", "retry"]);
		expect(failed.requiresAttention).toBe(true);
		const expired = runSummary(
			record,
			failedState,
			richEvents,
			"inactive",
			false,
			Date.parse(record.deadlineAt),
		);
		expect(expired.availableActions).toEqual([]);
		const driven = runSummary(
			record,
			failedState,
			richEvents,
			"owned",
			true,
			NOW,
		);
		expect(driven.availableActions).toEqual([]);
		expect(driven.ownership).toBe("owned");
	});

	it("reports a run leased elsewhere with no actions", () => {
		const leased = runSummary(
			record,
			richState,
			richEvents,
			"leased-elsewhere",
			false,
			NOW,
		);
		expect(leased.ownership).toBe("leased-elsewhere");
		expect(leased.leasedElsewhere).toBe(true);
		expect(leased.availableActions).toEqual([]);
		expect(Value.Check(WorkflowRunSummarySchema, leased)).toBe(true);
	});

	it("carries the nested lineage without the execution id or ancestors", () => {
		const nested = runSummary(
			nestedRecord,
			richState,
			richEvents,
			"inactive",
			false,
			NOW,
		);
		expect(nested.depth).toBe(1);
		expect(nested.parent).toEqual({
			runId: "workflow_parentrun",
			taskId: "task_parentchild",
			inputArtifacts: nestedRecord.parent?.inputArtifacts,
		});
		expect(Value.Check(WorkflowRunSummarySchema, nested)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// runInspection
// ---------------------------------------------------------------------------

describe("runInspection", () => {
	it("returns run, budget, and tasks by default with an empty truncation map", () => {
		const inspection = runInspection(
			record,
			richState,
			richEvents,
			"inactive",
			false,
			NOW,
		);
		expect(keysOf(inspection)).toEqual(["budget", "run", "tasks", "truncated"]);
		expect(inspection.truncated).toEqual({});
		expect(inspection.run).toEqual(
			runSummary(record, richState, richEvents, "inactive", false, NOW),
		);
		expect(inspection.tasks?.map((task) => task.id)).toEqual(
			taskViews(richState).map((task) => task.id),
		);
		expect(inspection.tasks?.[1]).toMatchObject({
			dependsOn: [answer.id],
			inputs: { doc: answer.id },
		});
		expect(Value.Check(WorkflowRunInspectionSchema, inspection)).toBe(true);
	});

	it("projects the budget from the shared usage functions", () => {
		const { budget } = runInspection(
			record,
			richState,
			richEvents,
			"inactive",
			false,
			NOW,
		);
		expect(budget).toBeDefined();
		if (!budget) throw new Error("missing budget");
		expect(budget.declared).toEqual(record.declaredBudget);
		expect(budget.effective).toEqual(record.effectiveBudget);
		// answer: 0.01 (gen 1) + 0.01 + 0.01 (gen 2 attempts); declined: 0.01; child: 0.05.
		expect(budget.settled.cost).toBeCloseTo(0.09, 10);
		expect(budget.settled.totalTokens).toBe(58);
		expect(budget.settled.childRuntimeMs).toBe(540);
		expect(budget.settled.usageComplete).toBe(false);
		expect(budget.reserved).toEqual({
			cost: 0,
			totalTokens: 0,
			childRuntimeMs: 0,
		});
		expect(budget.exceeded).toBe(
			"Nested workflow usage evidence is incomplete.",
		);
		expect(Value.Check(WorkflowBudgetViewSchema, budget)).toBe(true);
	});

	it("omits the exceeded string when settled usage fits", () => {
		const fitting = stateOf({
			status: "completed",
			entries: [
				{
					task: answer,
					status: "completed",
					executions: [answerGen1, answerGen2],
				},
			],
		});
		const { budget } = runInspection(
			record,
			fitting,
			richEvents,
			"inactive",
			false,
			NOW,
			{
				include: ["budget"],
			},
		);
		expect(budget?.exceeded).toBeUndefined();
		expect(budget?.settled.usageComplete).toBe(true);
	});

	it("lists executions by task order then newest generation with terminal facts", () => {
		const inspection = runInspection(
			record,
			richState,
			richEvents,
			"inactive",
			false,
			NOW,
			{
				include: ["executions"],
			},
		);
		expect(keysOf(inspection)).toEqual(["executions", "run", "truncated"]);
		const executions = inspection.executions ?? [];
		expect(executions.map((execution) => execution.id)).toEqual([
			answerGen2Id,
			answerGen1Id,
			summaryExecutionId,
			childExecutionId,
			blockedExecutionId,
			declinedExecutionId,
		]);
		expect(executions[0]).toMatchObject({
			id: answerGen2Id,
			taskId: answer.id,
			generation: 2,
			kind: "agent",
			phase: "terminal",
			current: true,
			createdSequence: 21,
			subagent: {
				operationId: deriveSubagentOperationId(RUN_ID, answer.id, 2),
				runId: "run_child2answer",
			},
			attempts: [
				{
					kind: "retry",
					ordinal: 2,
					status: "active",
					subagentAttemptId: "attempt_child2answerx2",
					state: "receipted",
					intentSequence: 10,
				},
			],
			settlement: {
				attemptOrdinal: 2,
				status: "completed",
				usageComplete: true,
			},
			terminal: { outcome: "completed", sequence: 13 },
			artifactIds: [answerResult.id],
		});
		expect(executions[0]?.terminal).not.toHaveProperty("failure");
		expect(executions[1]).toMatchObject({
			id: answerGen1Id,
			generation: 1,
			current: false,
			attempts: [],
			terminal: {
				outcome: "failed",
				failure: { code: "provider-transient", retry: "manual" },
				sequence: 15,
			},
			artifactIds: [],
		});
		expect(executions[2]).toMatchObject({
			id: summaryExecutionId,
			kind: "support",
			current: true,
			support: { implementationIdentitySha256: SHA_B },
			attempts: [],
			terminal: { outcome: "completed", sequence: 29 },
			artifactIds: [summaryResult.id],
		});
		expect(executions[2]).not.toHaveProperty("subagent");
		expect(executions[3]).toMatchObject({
			id: childExecutionId,
			kind: "workflow",
			childRunId,
			settlement: {
				attemptOrdinal: 1,
				status: "completed",
				usageComplete: false,
			},
			terminal: { outcome: "completed", sequence: 35 },
		});
		expect(executions[4]).toMatchObject({
			id: blockedExecutionId,
			terminal: {
				outcome: "failed",
				failure: { stage: "preflight" },
				sequence: 14,
			},
		});
		expect(executions[4]).not.toHaveProperty("subagent");
		expect(executions[4]?.terminal?.failure).not.toHaveProperty("retry");
		expect(typeof executions[4]?.terminal?.failure?.code).toBe("string");
		expect(executions[5]).toMatchObject({
			id: declinedExecutionId,
			attempts: [
				{
					kind: "retry",
					ordinal: 2,
					state: "declined",
					declinedReason: DECLINED_REASON,
					intentSequence: 41,
				},
			],
			settlement: {
				attemptOrdinal: 1,
				status: "failed",
				failureCode: "provider-transient",
				failureRetry: "backoff",
			},
		});
		expect(executions[5]?.attempts[0]).not.toHaveProperty("subagentAttemptId");
		for (const execution of executions) {
			expect(Value.Check(WorkflowExecutionViewSchema, execution)).toBe(true);
		}
	});

	it("lists effects and barriers with abandoned markers, and artifacts with the run output flag", () => {
		const inspection = runInspection(
			record,
			richState,
			richEvents,
			"inactive",
			false,
			NOW,
			{
				include: ["effects", "barriers", "artifacts"],
			},
		);
		expect(inspection.effects).toEqual([
			{ ordinal: 1, kind: "phase", value: "plan", sequence: 3 },
			{ ordinal: 2, kind: "log", value: "hello", sequence: 4 },
			{
				ordinal: 3,
				kind: "log",
				value: "after barrier",
				sequence: 40,
				abandoned: true,
			},
		]);
		expect(inspection.barriers).toEqual([
			{ epoch: 1, kind: "result", taskIds: [answer.id], sequence: 20 },
			{
				epoch: 2,
				kind: "final",
				taskIds: [answer.id, summary.id, child.id],
				sequence: 30,
				abandoned: true,
			},
		]);
		expect(inspection.artifacts).toEqual([
			{
				id: answerResult.id,
				producerTaskId: answer.id,
				producerExecutionId: answerGen2Id,
				output: "result",
				sha256: SHA,
				bytes: 42,
				mediaType: "application/json",
				schemaSha256: SHA_B,
				isRunOutput: true,
			},
			{
				id: summaryResult.id,
				producerTaskId: summary.id,
				producerExecutionId: summaryExecutionId,
				output: "result",
				sha256: SHA,
				bytes: 42,
				mediaType: "application/json",
				schemaSha256: SHA_B,
				isRunOutput: false,
			},
			{
				id: runLevelArtifact.id,
				sha256: SHA,
				bytes: 42,
				mediaType: "application/json",
				schemaSha256: SHA_B,
				isRunOutput: false,
			},
		]);
		for (const effect of inspection.effects ?? []) {
			expect(Value.Check(WorkflowEffectViewSchema, effect)).toBe(true);
		}
		for (const barrier of inspection.barriers ?? []) {
			expect(Value.Check(WorkflowBarrierViewSchema, barrier)).toBe(true);
		}
		for (const ref of inspection.artifacts ?? []) {
			expect(Value.Check(WorkflowArtifactViewSchema, ref)).toBe(true);
		}
		expect(inspection.truncated).toEqual({});
	});

	it("restricts tasks, executions, and artifacts to one task", () => {
		const inspection = runInspection(
			record,
			richState,
			richEvents,
			"inactive",
			false,
			NOW,
			{
				include: [...ALL_SECTIONS],
				taskId: answer.id,
			},
		);
		expect(inspection.tasks?.map((task) => task.id)).toEqual([answer.id]);
		expect(inspection.executions?.map((execution) => execution.id)).toEqual([
			answerGen2Id,
			answerGen1Id,
		]);
		expect(inspection.artifacts?.map((ref) => ref.id)).toEqual([
			answerResult.id,
		]);
		expect(inspection.effects).toHaveLength(3);
		expect(inspection.barriers).toHaveLength(2);
		expect(inspection.truncated).toEqual({});
		expect(Value.Check(WorkflowRunInspectionSchema, inspection)).toBe(true);
	});

	it("never includes prompts, child prose, failure messages, or output values", () => {
		const serialized = JSON.stringify(
			runInspection(record, richState, richEvents, "inactive", false, NOW, {
				include: [...ALL_SECTIONS],
			}),
		);
		expect(serialized).not.toContain(PROMPT_GOAL);
		expect(serialized).not.toContain(PROMPT_INSTRUCTION);
		expect(serialized).not.toContain(CHILD_PROSE);
		expect(serialized).not.toContain(CHILD_GUIDANCE);
		expect(serialized).not.toContain(WORKFLOW_FAILURE_MESSAGE);
		expect(serialized).not.toContain("/project");
		expect(serialized).not.toContain('"output":{');
	});
});

// ---------------------------------------------------------------------------
// runLogs
// ---------------------------------------------------------------------------

describe("runLogs", () => {
	it("derives one redacted entry per lifecycle event in the fixed formats", () => {
		const page = runLogs(richEvents, richState, {});
		expect(page.runId).toBe(RUN_ID);
		expect(page.lastSequence).toBe(40);
		expect(page.nextAfterSequence).toBeUndefined();
		expect(page.entries.map((entry) => entry.sequence)).toEqual([
			2, 3, 4, 6, 10, 11, 12, 13, 14, 15, 16, 17, 18, 40,
		]);
		expect(page.entries).toEqual([
			{
				sequence: 2,
				timestamp: timestampAt(2),
				kind: "run",
				status: "running",
				message: "Run status changed from created to running.",
			},
			{
				sequence: 3,
				timestamp: timestampAt(3),
				kind: "phase",
				message: "plan",
			},
			{ sequence: 4, timestamp: timestampAt(4), kind: "log", message: "hello" },
			{
				sequence: 6,
				timestamp: timestampAt(6),
				kind: "task",
				taskId: answer.id,
				taskKey: "/answer",
				status: "ready",
				message: "Task /answer changed from pending to ready.",
			},
			{
				sequence: 10,
				timestamp: timestampAt(10),
				kind: "attempt",
				taskId: answer.id,
				taskKey: "/answer",
				failureCode: "provider-transient",
				message: "Attempt 2 (retry) intended after provider-transient.",
			},
			{
				sequence: 11,
				timestamp: timestampAt(11),
				kind: "attempt",
				taskId: answer.id,
				taskKey: "/answer",
				status: "active",
				message: "Attempt 2 receipted (active).",
			},
			{
				sequence: 12,
				timestamp: timestampAt(12),
				kind: "attempt",
				taskId: declined.id,
				taskKey: "/declined",
				reason: DECLINED_REASON,
				message: "Attempt 2 declined.",
			},
			{
				sequence: 13,
				timestamp: timestampAt(13),
				kind: "terminal",
				taskId: answer.id,
				taskKey: "/answer",
				status: "completed",
				message: "Execution generation 2 ended completed.",
			},
			{
				sequence: 14,
				timestamp: timestampAt(14),
				kind: "terminal",
				taskId: blocked.id,
				taskKey: "/blocked",
				status: "failed",
				failureCode: "preflight",
				message: "Execution generation 1 ended failed.",
			},
			{
				sequence: 15,
				timestamp: timestampAt(15),
				kind: "terminal",
				taskId: answer.id,
				taskKey: "/answer",
				status: "failed",
				failureCode: "provider-transient",
				message: "Execution generation 1 ended failed.",
			},
			{
				sequence: 16,
				timestamp: timestampAt(16),
				kind: "invalidation",
				taskId: answer.id,
				taskKey: "/answer",
				reason: "operator re-run",
				message: "Invalidated 2 task(s) and abandoned 1 epoch(s).",
			},
			{
				sequence: 17,
				timestamp: timestampAt(17),
				kind: "run",
				status: "running",
				reason: "Explicit invalidation re-executes invalidated tasks.",
				message: "Run status changed from failed to running.",
			},
			{
				sequence: 18,
				timestamp: timestampAt(18),
				kind: "task",
				taskId: item.id,
				taskKey: "batch/item",
				status: "blocked",
				reason: "A required predecessor failed.",
				message: "Task batch/item changed from pending to blocked.",
			},
			{
				sequence: 40,
				timestamp: timestampAt(40),
				kind: "log",
				message: "after barrier",
				abandoned: true,
			},
		]);
		for (const entry of page.entries) {
			expect(Value.Check(WorkflowLogEntrySchema, entry)).toBe(true);
		}
		expect(Value.Check(WorkflowLogPageSchema, page)).toBe(true);
	});

	it("excludes identities, digests, prompts, child prose, and output values", () => {
		const serialized = JSON.stringify(runLogs(richEvents, richState, {}));
		expect(serialized).not.toContain(CHILD_PROSE);
		expect(serialized).not.toContain(CHILD_GUIDANCE);
		expect(serialized).not.toContain(WORKFLOW_FAILURE_MESSAGE);
		expect(serialized).not.toContain(PROMPT_GOAL);
		expect(serialized).not.toContain(SHA);
		expect(serialized).not.toContain("run_child");
		expect(serialized).not.toContain("attempt_child");
		expect(serialized).not.toContain("artifact_");
		expect(serialized).not.toContain("execution_");
	});

	it("pages by afterSequence and limit and points at the last returned entry", () => {
		const first = runLogs(richEvents, richState, { limit: 5 });
		expect(first.entries.map((entry) => entry.sequence)).toEqual([
			2, 3, 4, 6, 10,
		]);
		expect(first.nextAfterSequence).toBe(10);
		expect(first.lastSequence).toBe(40);
		const second = runLogs(richEvents, richState, {
			afterSequence: first.nextAfterSequence,
			limit: 5,
		});
		expect(second.entries.map((entry) => entry.sequence)).toEqual([
			11, 12, 13, 14, 15,
		]);
		expect(second.nextAfterSequence).toBe(15);
		const third = runLogs(richEvents, richState, {
			afterSequence: 15,
			limit: 5,
		});
		expect(third.entries.map((entry) => entry.sequence)).toEqual([
			16, 17, 18, 40,
		]);
		expect(third.nextAfterSequence).toBeUndefined();
		const exhausted = runLogs(richEvents, richState, { afterSequence: 40 });
		expect(exhausted.entries).toEqual([]);
		expect(exhausted.nextAfterSequence).toBeUndefined();
		expect(exhausted.lastSequence).toBe(40);
		// An exact fit has no next page.
		const exact = runLogs(richEvents, richState, {
			afterSequence: 17,
			limit: 2,
		});
		expect(exact.entries.map((entry) => entry.sequence)).toEqual([18, 40]);
		expect(exact.nextAfterSequence).toBeUndefined();
	});

	it("produces an empty page for an empty journal", () => {
		const page = runLogs([], undefined, {}, RUN_ID);
		expect(page).toEqual({ runId: RUN_ID, entries: [], lastSequence: 0 });
	});

	it("keeps a task key at the contract bounds and its status message within the schema", () => {
		// 32 namespace entries of 128 characters plus a 128-character key is the
		// deepest, longest task the contract admits; the id is bounded separately.
		const segment = "k".repeat(128);
		const deep: MaterializedAgentTask = {
			...agentTask(segment, 1, {
				namespace: Array.from({ length: 32 }, () => segment),
			}),
			id: "task_deep",
		};
		const state = stateOf({
			status: "running",
			entries: [{ task: deep, status: "cleanup-blocked" }],
		});
		const page = runLogs(
			[
				event(1, {
					type: "task-status-changed",
					data: { taskId: deep.id, from: "cancelling", to: "cleanup-blocked" },
				}),
			],
			state,
			{},
		);
		const [entry] = page.entries;
		expect(MAX_WORKFLOW_TASK_KEY_LENGTH).toBe(32 * (128 + 1) + 128);
		expect(MAX_WORKFLOW_LOG_MESSAGE_LENGTH).toBe(
			"Task  changed from  to .".length +
				MAX_WORKFLOW_TASK_KEY_LENGTH +
				2 * "cleanup-blocked".length,
		);
		expect(entry?.taskKey).toBe(`${deep.namespace.join("/")}/${segment}`);
		expect(entry?.taskKey).toHaveLength(MAX_WORKFLOW_TASK_KEY_LENGTH);
		expect(entry?.message).toBe(
			`Task ${entry?.taskKey} changed from cancelling to cleanup-blocked.`,
		);
		// Longer than the former fixed 4096 bound, so the derived bound matters.
		expect(entry?.message.length).toBeGreaterThan(4096);
		expect(entry?.message.length).toBeLessThanOrEqual(
			MAX_WORKFLOW_LOG_MESSAGE_LENGTH,
		);
		expect(Value.Check(WorkflowLogEntrySchema, entry)).toBe(true);
		expect(Value.Check(WorkflowLogPageSchema, page)).toBe(true);
		expect(
			Value.Check(WorkflowServiceTaskViewSchema, taskViews(state)[0]),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Bounds on a synthetic 256-task state
// ---------------------------------------------------------------------------

function syntheticState(): {
	state: WorkflowStateProjection;
	events: WorkflowJournalEvent[];
	tasks: MaterializedAgentTask[];
} {
	const tasks: MaterializedAgentTask[] = [];
	const entries: TaskEntry[] = [];
	const artifacts: WorkflowArtifactRef[] = [];
	for (let index = 0; index < 256; index += 1) {
		const task = agentTask(`t${index}`, index + 1);
		tasks.push(task);
		const gen1: TaskExecutionProjection = {
			execution: agentRecord(task, 1),
			phase: "terminal",
			createdSequence: 1_000 + index * 4,
			launchReceipt: receipt(task, 1, 1_001 + index * 4),
			settlement: {
				evidence: evidence("failed", 1, subagentFailure("manual")),
				sequence: 1_002 + index * 4,
			},
			terminal: {
				outcome: "failed",
				evidence: evidence("failed", 1, subagentFailure("manual")),
				sequence: 1_003 + index * 4,
			},
		};
		const gen2: TaskExecutionProjection = {
			execution: agentRecord(task, 2),
			phase: "terminal",
			createdSequence: 3_000 + index * 4,
			launchReceipt: receipt(task, 2, 3_001 + index * 4),
			settlement: {
				evidence: evidence("completed", 1),
				sequence: 3_002 + index * 4,
			},
			terminal: {
				outcome: "completed",
				evidence: evidence("completed", 1),
				sequence: 3_003 + index * 4,
			},
		};
		entries.push({ task, status: "completed", executions: [gen1, gen2] });
	}
	for (let index = 0; index < 300; index += 1) {
		const task = tasks[index % 256];
		if (!task) throw new Error("missing task");
		artifacts.push(
			artifact(index.toString(16), {
				taskId: task.id,
				executionId: deriveTaskExecutionId(RUN_ID, task.id, 2),
			}),
		);
	}
	const effects: WorkflowEffectProjection[] = Array.from(
		{ length: 300 },
		(_, index) => ({
			ordinal: index + 1,
			kind: index % 2 === 0 ? ("phase" as const) : ("log" as const),
			value: `effect ${index + 1}`,
			sequence: 5_000 + index,
		}),
	);
	const barriers: WorkflowBarrierProjection[] = Array.from(
		{ length: 300 },
		(_, index) => ({
			epoch: index + 1,
			kind: "results" as const,
			taskIds: [tasks[index % 256]?.id ?? ""],
			sequence: 6_000 + index,
		}),
	);
	const state = stateOf({
		status: "completed",
		entries,
		effects,
		barriers,
		artifacts,
		lastSequence: 6_300,
	});
	const events = effects.map((effect) =>
		event(effect.sequence, {
			type: "workflow-effect",
			data: { ordinal: effect.ordinal, kind: effect.kind, value: effect.value },
		}),
	);
	for (let index = 0; index < 300; index += 1) {
		events.push(
			event(6_000 + index, {
				type: "run-status-changed",
				data:
					index % 2 === 0
						? { from: "running", to: "waiting" }
						: { from: "waiting", to: "running" },
			}),
		);
	}
	return { state, events, tasks };
}

describe("projection bounds", () => {
	const { state, events, tasks } = syntheticState();

	it("keeps every task view within the schema bound", () => {
		const views = taskViews(state, { graph: true });
		expect(views).toHaveLength(256);
		for (const view of views) {
			expect(Value.Check(WorkflowServiceTaskViewSchema, view)).toBe(true);
		}
		const summaryView = runSummary(record, state, events, "owned", false, NOW);
		expect(summaryView.taskCounts).toMatchObject({
			completed: 256,
			total: 256,
		});
		expect(summaryView.lastSequence).toBe(6_299);
		expect(Value.Check(WorkflowRunSummarySchema, summaryView)).toBe(true);
	});

	it("truncates executions to the first 256 in task order and records the omitted count", () => {
		const inspection = runInspection(
			record,
			state,
			events,
			"owned",
			false,
			NOW,
			{
				include: [...ALL_SECTIONS],
			},
		);
		expect(inspection.tasks).toHaveLength(256);
		expect(inspection.executions).toHaveLength(256);
		expect(inspection.truncated.executions).toBe(256);
		const expected = tasks
			.slice(0, 128)
			.flatMap((task) => [
				deriveTaskExecutionId(RUN_ID, task.id, 2),
				deriveTaskExecutionId(RUN_ID, task.id, 1),
			]);
		expect(inspection.executions?.map((execution) => execution.id)).toEqual(
			expected,
		);
		expect(Value.Check(WorkflowRunInspectionSchema, inspection)).toBe(true);
	});

	it("keeps the newest 256 effects, barriers, and artifacts", () => {
		const inspection = runInspection(
			record,
			state,
			events,
			"owned",
			false,
			NOW,
			{
				include: ["effects", "barriers", "artifacts"],
			},
		);
		expect(inspection.effects).toHaveLength(256);
		expect(inspection.effects?.[0]?.ordinal).toBe(45);
		expect(inspection.effects?.at(-1)?.ordinal).toBe(300);
		expect(inspection.truncated.effects).toBe(44);
		expect(inspection.barriers).toHaveLength(256);
		expect(inspection.barriers?.[0]?.epoch).toBe(45);
		expect(inspection.barriers?.at(-1)?.epoch).toBe(300);
		expect(inspection.truncated.barriers).toBe(44);
		expect(inspection.artifacts).toHaveLength(256);
		expect(inspection.artifacts?.map((ref) => ref.id)).toEqual(
			Object.keys(state.artifacts).slice(-256),
		);
		expect(inspection.truncated.artifacts).toBe(44);
		expect(inspection.truncated).not.toHaveProperty("executions");
		expect(Value.Check(WorkflowRunInspectionSchema, inspection)).toBe(true);
	});

	it("returns every generation of one task without truncation when taskId is given", () => {
		const target = tasks[200];
		if (!target) throw new Error("missing task");
		const inspection = runInspection(
			record,
			state,
			events,
			"owned",
			false,
			NOW,
			{
				include: ["tasks", "executions", "artifacts"],
				taskId: target.id,
			},
		);
		expect(inspection.tasks?.map((task) => task.id)).toEqual([target.id]);
		expect(inspection.executions?.map((execution) => execution.id)).toEqual([
			deriveTaskExecutionId(RUN_ID, target.id, 2),
			deriveTaskExecutionId(RUN_ID, target.id, 1),
		]);
		expect(inspection.truncated).not.toHaveProperty("executions");
		expect(
			inspection.artifacts?.every((ref) => ref.producerTaskId === target.id),
		).toBe(true);
		expect(Value.Check(WorkflowRunInspectionSchema, inspection)).toBe(true);
	});

	it("caps a log page at 500 entries and defaults to 100", () => {
		const defaulted = runLogs(events, state, {});
		expect(defaulted.entries).toHaveLength(100);
		expect(defaulted.nextAfterSequence).toBe(
			defaulted.entries.at(-1)?.sequence,
		);
		expect(defaulted.lastSequence).toBe(6_299);
		const capped = runLogs(events, state, { limit: 500 });
		expect(capped.entries).toHaveLength(500);
		expect(capped.nextAfterSequence).toBe(capped.entries.at(-1)?.sequence);
		expect(Value.Check(WorkflowLogPageSchema, capped)).toBe(true);
		const rest = runLogs(events, state, {
			afterSequence: capped.nextAfterSequence,
			limit: 500,
		});
		expect(rest.entries).toHaveLength(100);
		expect(rest.nextAfterSequence).toBeUndefined();
		expect(Value.Check(WorkflowLogPageSchema, rest)).toBe(true);
	});
});
