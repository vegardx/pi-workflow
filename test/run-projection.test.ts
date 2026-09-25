import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { CHECKPOINT_DECIDE_INSTRUCTION } from "../src/checkpoint-render.js";
import type {
	MaterializedAgentTask,
	MaterializedCheckpointTask,
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
import { invalidationClosure } from "../src/reducer.js";
import {
	invalidationPreview,
	pendingCheckpointViews,
	runInspection,
	runLogs,
	runSummary,
	taskViews,
} from "../src/run-projection.js";
import type { WorkflowRunRecord } from "../src/run-record.js";
import {
	MAX_WORKFLOW_INSPECTION_ITEMS,
	MAX_WORKFLOW_INSPECTION_PROMPT_LENGTH,
	MAX_WORKFLOW_LOG_MESSAGE_LENGTH,
	MAX_WORKFLOW_TASK_KEY_LENGTH,
	WorkflowArtifactViewSchema,
	WorkflowBarrierViewSchema,
	WorkflowBudgetViewSchema,
	WorkflowCheckpointTaskViewSchema,
	WorkflowDecideOptionsSchema,
	WorkflowEffectViewSchema,
	WorkflowExecutionViewSchema,
	WorkflowInvalidationPreviewSchema,
	WorkflowLogEntrySchema,
	WorkflowLogPageSchema,
	WorkflowPendingCheckpointViewSchema,
	WorkflowRunInspectionSchema,
	WorkflowRunSummarySchema,
	WorkflowServiceRunViewSchema,
	WorkflowServiceTaskViewSchema,
	WorkflowServiceWaitViewSchema,
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
	definitionKind: "static",
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
			// Derived from the key: this fixture names its tasks its own way, so
			// the kind is the honest `other` and there is no deliverable.
			narration: { stage: "answer", taskKind: "other" },
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
			narration: { stage: "summary", taskKind: "other" },
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
			narration: { stage: "child", taskKind: "other" },
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
			narration: { stage: "stale", taskKind: "other" },
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
			// A fan-out member's stage key is the whole path.
			narration: { stage: "batch/item", taskKind: "other" },
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
			narration: {
				stage: "blocked",
				taskKind: "other",
				// Composed from the journalled stage, never from a message.
				cause: "The run failed at preflight.",
			},
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
			narration: {
				stage: "declined",
				taskKind: "other",
				cause:
					"The delegated run failed: provider-transient (origin provider, retry backoff).",
			},
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
			pendingCheckpointCount: 0,
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
			pendingCheckpointCount: 0,
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

describe("invalidationPreview", () => {
	const cause = agentTask("cause", 11);
	const dependent = agentTask("dependent", 12, { inputs: { cause: cause.id } });
	const independent = agentTask("independent", 13);
	const late: MaterializedAgentTask = {
		...agentTask("late", 14),
		materializationEpoch: 2,
	};
	const retired: MaterializedAgentTask = {
		...agentTask("retired", 15),
		materializationEpoch: 2,
	};
	const causeExecution: TaskExecutionProjection = {
		execution: agentRecord(cause, 1),
		phase: "terminal",
		createdSequence: 7,
		terminal: {
			outcome: "failed",
			evidence: evidence("failed", 1, subagentFailure("manual")),
			sequence: 9,
		},
	};
	const state = stateOf({
		status: "failed",
		entries: [
			{ task: cause, status: "failed", executions: [causeExecution] },
			{ task: dependent, status: "blocked" },
			{ task: independent, status: "completed" },
			{ task: late, status: "pending" },
			{ task: retired, status: "completed", abandoned: true },
			{ task: stale, status: "invalidated" },
		],
		barriers: [
			{
				epoch: 1,
				kind: "results",
				taskIds: [cause.id, independent.id],
				sequence: 20,
			},
			{ epoch: 2, kind: "final", taskIds: [late.id], sequence: 30 },
		],
	});

	it("reports the reducer's closure, the abandoned epochs, and the declarations they retire", () => {
		const preview = invalidationPreview(state, cause.id);
		expect(Value.Check(WorkflowInvalidationPreviewSchema, preview)).toBe(true);
		expect(preview).toEqual({
			runId: RUN_ID,
			causeTaskId: cause.id,
			taskIds: [cause.id, dependent.id],
			taskKeys: ["/cause", "/dependent"],
			abandonedEpochs: [2],
			abandonedTaskIds: [late.id],
		});
		// The same function the reducer validates the append against.
		expect({
			taskIds: [...preview.taskIds],
			abandonedEpochs: [...preview.abandonedEpochs],
		}).toEqual(invalidationClosure(state, cause.id));
		expect(Object.isFrozen(preview)).toBe(true);
		expect(Object.isFrozen(preview.taskIds)).toBe(true);
		// A cause outside every barrier abandons nothing.
		expect(invalidationPreview(state, late.id)).toMatchObject({
			taskIds: [late.id],
			taskKeys: ["/late"],
			abandonedEpochs: [],
			abandonedTaskIds: [],
		});
	});

	it("raises the reducer's refusals unchanged", () => {
		expect(() => invalidationPreview(state, "task_unknown")).toThrow(
			"invalidation cause task is unknown",
		);
		expect(() => invalidationPreview(state, stale.id)).toThrow(
			"invalidation cause is already invalidated",
		);
	});
});

// ---------------------------------------------------------------------------
// Checkpoints (revision 18)
// ---------------------------------------------------------------------------

const CHECKPOINT_PROMPT = "Approve the plan before the writer runs?";
const CHECKPOINT_REASON = "Plan reviewed and accepted.";
const APPROVER = "vegard";
const DECISION_SHA = "c".repeat(64);
const DECISION_ARTIFACT_ID = `artifact_${DECISION_SHA}`;
const REQUESTED_AT = "2026-09-15T12:03:00.000Z";
const EXPIRES_AT = "2026-09-15T13:03:00.000Z";
const DECIDED_AT = "2026-09-15T12:04:00.000Z";

function checkpointTask(
	key: string,
	sequence: number,
	options: {
		namespace?: readonly string[];
		prompt?: string;
		headless?: "block" | "use-explicit-default";
		default?: unknown;
		timeoutMs?: number;
		inputs?: Readonly<Record<string, WorkflowTaskId>>;
	} = {},
): MaterializedCheckpointTask {
	return {
		id: `task_${key}`,
		runId: RUN_ID,
		namespace: [...(options.namespace ?? [])],
		spec: {
			key,
			kind: "checkpoint",
			role: "task",
			disposition: "required",
			after: [],
			inputs: Object.fromEntries(
				Object.entries(options.inputs ?? {}).map(([name, producerTaskId]) => [
					name,
					{ runId: RUN_ID, producerTaskId, output: "result" as const },
				]),
			),
			replay: "read-only",
			request: {
				schema: {
					type: "object",
					properties: { proceed: { type: "boolean" } },
					required: ["proceed"],
				},
				prompt: options.prompt ?? CHECKPOINT_PROMPT,
				headless: options.headless ?? "block",
				...(options.default === undefined ? {} : { default: options.default }),
				...(options.timeoutMs === undefined
					? {}
					: { timeoutMs: options.timeoutMs }),
			},
			identitySha256: SHA,
		},
		definitionIdentitySha256: SHA,
		materializationSequence: sequence,
		materializationEpoch: 1,
		epochPosition: sequence,
	};
}

function checkpointRecord(task: MaterializedWorkflowTask, generation: number) {
	return {
		kind: "checkpoint" as const,
		id: deriveTaskExecutionId(RUN_ID, task.id, generation),
		runId: RUN_ID,
		taskId: task.id,
		generation,
		taskIdentitySha256: SHA,
	};
}

function requestedExecution(
	task: MaterializedWorkflowTask,
	options: { expiresAt?: string; sequence?: number } = {},
): TaskExecutionProjection {
	const sequence = options.sequence ?? 50;
	return {
		execution: checkpointRecord(task, 1),
		phase: "checkpoint-requested",
		createdSequence: sequence,
		checkpointRequest: {
			inputsSha256: SHA,
			...(options.expiresAt === undefined
				? {}
				: { expiresAt: options.expiresAt }),
			requestedAt: REQUESTED_AT,
			sequence: sequence + 1,
		},
	};
}

function decidedExecution(
	task: MaterializedWorkflowTask,
	decision: {
		source: "operator" | "default";
		decidedBy?: string;
		reason?: string;
	},
): TaskExecutionProjection {
	const requested = requestedExecution(task, { expiresAt: EXPIRES_AT });
	return {
		...requested,
		phase: "terminal",
		checkpointDecision: {
			artifactId: DECISION_ARTIFACT_ID,
			decisionSha256: DECISION_SHA,
			source: decision.source,
			...(decision.decidedBy === undefined
				? {}
				: { decidedBy: decision.decidedBy }),
			...(decision.reason === undefined ? {} : { reason: decision.reason }),
			decidedAt: DECIDED_AT,
			sequence: 52,
		},
		terminal: {
			outcome: "completed",
			evidence: {
				kind: "checkpoint",
				artifactId: DECISION_ARTIFACT_ID,
				decisionSha256: DECISION_SHA,
				source: decision.source,
				...(decision.decidedBy === undefined
					? {}
					: { decidedBy: decision.decidedBy }),
			},
			sequence: 53,
		},
	};
}

function endedExecution(
	task: MaterializedWorkflowTask,
	shape: "expired" | "cancelled",
): TaskExecutionProjection {
	const requested = requestedExecution(task, { expiresAt: EXPIRES_AT });
	return {
		...requested,
		phase: "terminal",
		terminal: {
			outcome: shape === "expired" ? "failed" : "cancelled",
			evidence: {
				kind: "workflow",
				stage: shape === "expired" ? "checkpoint-expired" : "stop",
				failureSha256: SHA,
				message:
					shape === "expired"
						? "Checkpoint expired without a decision."
						: "Workflow run ended before the checkpoint was decided.",
			},
			sequence: 54,
		},
	};
}

const approve = checkpointTask("approve", 2, {
	timeoutMs: 3_600_000,
	inputs: { plan: answer.id },
});
const review = checkpointTask("review", 3, {
	namespace: ["release"],
	headless: "use-explicit-default",
	default: { proceed: false },
});
const defaulted = checkpointTask("defaulted", 4, {
	headless: "use-explicit-default",
	default: { proceed: true },
});
const expired = checkpointTask("expired", 5, { timeoutMs: 60_000 });
const cancelled = checkpointTask("cancelled", 6);
const fresh = checkpointTask("fresh", 7);
const approveExecutionId = deriveTaskExecutionId(RUN_ID, approve.id, 1);
const reviewExecutionId = deriveTaskExecutionId(RUN_ID, review.id, 1);
const approveExecution = requestedExecution(approve, { expiresAt: EXPIRES_AT });
const reviewExecution = decidedExecution(review, {
	source: "operator",
	decidedBy: APPROVER,
	reason: CHECKPOINT_REASON,
});
const defaultedExecution = decidedExecution(defaulted, { source: "default" });
const expiredExecution = endedExecution(expired, "expired");
const cancelledExecution = endedExecution(cancelled, "cancelled");

const parkedState = stateOf({
	status: "waiting",
	entries: [
		{ task: answer, status: "completed", executions: [answerGen1, answerGen2] },
		{ task: approve, status: "waiting", executions: [approveExecution] },
		{ task: review, status: "completed", executions: [reviewExecution] },
		{ task: defaulted, status: "completed", executions: [defaultedExecution] },
		{ task: expired, status: "failed", executions: [expiredExecution] },
		{ task: cancelled, status: "cancelled", executions: [cancelledExecution] },
		{ task: fresh, status: "pending" },
	],
	artifacts: [answerResult],
});

const checkpointEvents: readonly WorkflowJournalEvent[] = [
	event(50, {
		type: "task-execution-created",
		data: { execution: approveExecution.execution },
	}),
	event(51, {
		type: "task-execution-checkpoint-requested",
		data: {
			executionId: approveExecutionId,
			inputsSha256: SHA,
			expiresAt: EXPIRES_AT,
		},
	}),
	event(52, {
		type: "task-status-changed",
		data: {
			taskId: approve.id,
			from: "ready",
			to: "waiting",
			reason: "Checkpoint awaits a decision.",
		},
	}),
	event(53, {
		type: "run-status-changed",
		data: {
			from: "running",
			to: "waiting",
			reason: "Workflow run awaits a checkpoint decision.",
		},
	}),
	event(54, {
		type: "task-execution-checkpoint-decided",
		data: {
			executionId: reviewExecutionId,
			artifactId: DECISION_ARTIFACT_ID,
			decisionSha256: DECISION_SHA,
			source: "operator",
			decidedAt: DECIDED_AT,
			decidedBy: APPROVER,
			reason: CHECKPOINT_REASON,
		},
	}),
	event(55, {
		type: "task-execution-checkpoint-decided",
		data: {
			executionId: deriveTaskExecutionId(RUN_ID, defaulted.id, 1),
			artifactId: DECISION_ARTIFACT_ID,
			decisionSha256: DECISION_SHA,
			source: "default",
			decidedAt: DECIDED_AT,
		},
	}),
	event(56, {
		type: "task-execution-terminal",
		data: {
			executionId: deriveTaskExecutionId(RUN_ID, expired.id, 1),
			outcome: "failed",
			evidence: {
				kind: "workflow",
				stage: "checkpoint-expired",
				failureSha256: SHA,
				message: "Checkpoint expired without a decision.",
			},
		},
	}),
	event(57, {
		type: "task-execution-terminal",
		data: {
			executionId: deriveTaskExecutionId(RUN_ID, cancelled.id, 1),
			outcome: "cancelled",
			evidence: {
				kind: "workflow",
				stage: "stop",
				failureSha256: SHA,
				message: "Workflow run ended before the checkpoint was decided.",
			},
		},
	}),
	event(58, {
		type: "task-status-changed",
		data: {
			taskId: cancelled.id,
			from: "waiting",
			to: "cancelled",
			reason: "Workflow run ended before the checkpoint was decided.",
		},
	}),
];

describe("checkpoint task views", () => {
	const views = taskViews(parkedState);
	const byId = new Map(views.map((view) => [view.id, view]));

	it("projects a requested checkpoint from its spec and durable request", () => {
		expect(byId.get(approve.id)).toEqual({
			id: approve.id,
			namespace: [],
			key: "approve",
			kind: "checkpoint",
			role: "task",
			disposition: "required",
			status: "waiting",
			generation: 1,
			executionId: approveExecutionId,
			checkpoint: {
				prompt: CHECKPOINT_PROMPT,
				schema: approve.spec.request.schema,
				headless: "block",
				timeoutMs: 3_600_000,
				requestedAt: REQUESTED_AT,
				expiresAt: EXPIRES_AT,
			},
			// A checkpoint is a `gate` whatever it is called.
			narration: { stage: "approve", taskKind: "gate" },
		});
		expect(byId.get(approve.id)).not.toHaveProperty("attempts");
		expect(byId.get(approve.id)).not.toHaveProperty("settlement");
	});

	it("projects an operator decision with its digest, approver, and reason but never its value", () => {
		expect(byId.get(review.id)).toEqual({
			id: review.id,
			namespace: ["release"],
			key: "review",
			kind: "checkpoint",
			role: "task",
			disposition: "required",
			status: "completed",
			generation: 1,
			executionId: reviewExecutionId,
			outcome: "completed",
			checkpoint: {
				prompt: CHECKPOINT_PROMPT,
				schema: review.spec.request.schema,
				headless: "use-explicit-default",
				default: { proceed: false },
				requestedAt: REQUESTED_AT,
				expiresAt: EXPIRES_AT,
				decision: {
					source: "operator",
					decidedBy: APPROVER,
					decidedAt: DECIDED_AT,
					reason: CHECKPOINT_REASON,
					sha256: DECISION_SHA,
				},
			},
			narration: { stage: "release/review", taskKind: "gate" },
		});
		expect(byId.get(review.id)?.checkpoint?.decision).not.toHaveProperty(
			"value",
		);
	});

	it("projects a default decision without an approver", () => {
		expect(byId.get(defaulted.id)?.checkpoint).toEqual({
			prompt: CHECKPOINT_PROMPT,
			schema: defaulted.spec.request.schema,
			headless: "use-explicit-default",
			default: { proceed: true },
			requestedAt: REQUESTED_AT,
			expiresAt: EXPIRES_AT,
			decision: {
				source: "default",
				decidedAt: DECIDED_AT,
				sha256: DECISION_SHA,
			},
		});
	});

	it("keeps the request facts of expired and cancelled checkpoints with their outcomes", () => {
		expect(byId.get(expired.id)).toMatchObject({
			status: "failed",
			outcome: "failed",
			checkpoint: {
				timeoutMs: 60_000,
				requestedAt: REQUESTED_AT,
				expiresAt: EXPIRES_AT,
			},
		});
		expect(byId.get(expired.id)?.checkpoint).not.toHaveProperty("decision");
		expect(byId.get(cancelled.id)).toMatchObject({
			status: "cancelled",
			outcome: "cancelled",
			checkpoint: { requestedAt: REQUESTED_AT },
		});
	});

	it("describes an unrequested checkpoint from its spec alone", () => {
		expect(byId.get(fresh.id)).toEqual({
			id: fresh.id,
			namespace: [],
			key: "fresh",
			kind: "checkpoint",
			role: "task",
			disposition: "required",
			status: "pending",
			generation: 0,
			checkpoint: {
				prompt: CHECKPOINT_PROMPT,
				schema: fresh.spec.request.schema,
				headless: "block",
			},
			narration: { stage: "fresh", taskKind: "gate" },
		});
	});

	it("returns frozen copies that do not alias the persisted spec", () => {
		const view = byId.get(review.id);
		expect(Object.isFrozen(view?.checkpoint)).toBe(true);
		expect(Object.isFrozen(view?.checkpoint?.schema)).toBe(true);
		expect(Object.isFrozen(view?.checkpoint?.default)).toBe(true);
		expect(view?.checkpoint?.schema).not.toBe(review.spec.request.schema);
		expect(view?.checkpoint?.default).not.toBe(review.spec.request.default);
	});

	it("round-trips every checkpoint view through its schema, including the graph fields", () => {
		for (const view of [...views, ...taskViews(parkedState, { graph: true })]) {
			expect(Value.Check(WorkflowServiceTaskViewSchema, view)).toBe(true);
			if (view.kind === "checkpoint") {
				expect(
					Value.Check(WorkflowCheckpointTaskViewSchema, view.checkpoint),
				).toBe(true);
			} else {
				expect(view).not.toHaveProperty("checkpoint");
			}
		}
		expect(taskViews(parkedState, { graph: true })[1]).toMatchObject({
			id: approve.id,
			dependsOn: [],
			inputs: { plan: answer.id },
		});
		const serialized = JSON.stringify(views);
		expect(serialized).not.toContain('"value"');
		expect(serialized).not.toContain(PROMPT_GOAL);
	});

	it("rejects extra properties and malformed checkpoint fields", () => {
		const view = byId.get(review.id);
		if (!view?.checkpoint) throw new Error("missing checkpoint view");
		expect(
			Value.Check(WorkflowCheckpointTaskViewSchema, {
				...view.checkpoint,
				extra: 1,
			}),
		).toBe(false);
		expect(
			Value.Check(WorkflowCheckpointTaskViewSchema, {
				...view.checkpoint,
				decision: { ...view.checkpoint.decision, sha256: "nope" },
			}),
		).toBe(false);
		expect(
			Value.Check(WorkflowCheckpointTaskViewSchema, {
				...view.checkpoint,
				prompt: "",
			}),
		).toBe(false);
		expect(
			Value.Check(WorkflowCheckpointTaskViewSchema, {
				...view.checkpoint,
				headless: "auto",
			}),
		).toBe(false);
		// The service adds verified inputs and the decision value on artifact-backed views.
		expect(
			Value.Check(WorkflowCheckpointTaskViewSchema, {
				...view.checkpoint,
				inputs: { plan: { title: "x" } },
				decision: { ...view.checkpoint.decision, value: { proceed: true } },
			}),
		).toBe(true);
	});
});

describe("pendingCheckpointViews and run views", () => {
	it("lists only checkpoints awaiting a decision, in materialization order", () => {
		const pending = pendingCheckpointViews(parkedState);
		expect(pending).toEqual([
			{
				taskId: approve.id,
				namespace: [],
				key: "approve",
				executionId: approveExecutionId,
				requestedAt: REQUESTED_AT,
				expiresAt: EXPIRES_AT,
				taskKey: "approve",
				prompt: CHECKPOINT_PROMPT,
				schemaSummary: "{ proceed: boolean }",
				instruction: CHECKPOINT_DECIDE_INSTRUCTION,
			},
		]);
		// No lease, no verified inputs: the summary is omitted, never guessed.
		expect(pending[0]).not.toHaveProperty("inputsSummary");
		expect(pending[0]).not.toHaveProperty("promptTruncated");
		expect(Object.isFrozen(pending)).toBe(true);
		for (const entry of pending) {
			expect(Value.Check(WorkflowPendingCheckpointViewSchema, entry)).toBe(
				true,
			);
		}
		expect(pendingCheckpointViews(richState)).toEqual([]);
	});

	it("omits expiresAt for a checkpoint bounded only by the run deadline", () => {
		const open = checkpointTask("open", 1);
		const state = stateOf({
			status: "running",
			entries: [
				{
					task: open,
					status: "waiting",
					executions: [requestedExecution(open)],
				},
			],
		});
		const [entry] = pendingCheckpointViews(state);
		expect(entry).toEqual({
			taskId: open.id,
			namespace: [],
			key: "open",
			executionId: deriveTaskExecutionId(RUN_ID, open.id, 1),
			requestedAt: REQUESTED_AT,
			taskKey: "open",
			prompt: CHECKPOINT_PROMPT,
			schemaSummary: "{ proceed: boolean }",
			instruction: CHECKPOINT_DECIDE_INSTRUCTION,
		});
		expect(Value.Check(WorkflowPendingCheckpointViewSchema, entry)).toBe(true);
	});

	it("carries the decide fields, with the rendered inputs only when the caller has them", () => {
		const nested = checkpointTask("review", 1, { namespace: ["release"] });
		const state = stateOf({
			status: "waiting",
			entries: [
				{
					task: nested,
					status: "waiting",
					executions: [requestedExecution(nested, { expiresAt: EXPIRES_AT })],
				},
			],
		});
		const [bare] = pendingCheckpointViews(state);
		expect(bare?.taskKey).toBe("release/review");
		expect(bare).not.toHaveProperty("inputsSummary");
		const [rich] = pendingCheckpointViews(state, {
			inputs: new Map([[nested.id, { plan: "Ship on Friday.", rows: [1, 2] }]]),
		});
		expect(rich?.inputsSummary).toBe(
			[
				"plan:",
				"  Ship on Friday.",
				"",
				"rows:",
				"  [",
				"    1,",
				"    2",
				"  ]",
			].join("\n"),
		);
		expect(rich?.prompt).toBe(CHECKPOINT_PROMPT);
		expect(rich?.instruction).toBe(CHECKPOINT_DECIDE_INSTRUCTION);
		for (const entry of [bare, rich]) {
			expect(Value.Check(WorkflowPendingCheckpointViewSchema, entry)).toBe(
				true,
			);
		}
		// An input of a task the caller passed nothing for stays unrendered.
		const [other] = pendingCheckpointViews(state, {
			inputs: new Map([["task_elsewhere", { plan: "x" }]]),
		});
		expect(other).not.toHaveProperty("inputsSummary");
	});

	it("cuts the pending prompt on the lease-free views and marks the cut", () => {
		const longPrompt = "p".repeat(4096);
		const wordy = checkpointTask("wordy", 1, { prompt: longPrompt });
		const state = stateOf({
			status: "waiting",
			entries: [
				{
					task: wordy,
					status: "waiting",
					executions: [requestedExecution(wordy)],
				},
			],
		});
		const [cut] = pendingCheckpointViews(state, {
			promptLimit: MAX_WORKFLOW_INSPECTION_PROMPT_LENGTH,
		});
		expect(cut?.prompt).toBe("p".repeat(MAX_WORKFLOW_INSPECTION_PROMPT_LENGTH));
		expect(cut?.promptTruncated).toBe(true);
		expect(Value.Check(WorkflowPendingCheckpointViewSchema, cut)).toBe(true);
		// Artifact-backed views keep the whole contract-bounded prompt.
		const [full] = pendingCheckpointViews(state);
		expect(full?.prompt).toBe(longPrompt);
		expect(full).not.toHaveProperty("promptTruncated");
		// A prompt at the limit is not cut.
		const [exact] = pendingCheckpointViews(state, {
			promptLimit: longPrompt.length,
		});
		expect(exact).not.toHaveProperty("promptTruncated");
	});

	it("validates a run view and a parked wait view carrying pending checkpoints", () => {
		const runView = {
			runId: RUN_ID,
			status: parkedState.status,
			definitionName: record.definitionName,
			createdAt: record.createdAt,
			deadlineAt: record.deadlineAt,
			depth: record.depth,
			tasks: taskViews(parkedState),
			pendingCheckpoints: pendingCheckpointViews(parkedState),
		};
		expect(Value.Check(WorkflowServiceRunViewSchema, runView)).toBe(true);
		expect(
			Value.Check(WorkflowServiceWaitViewSchema, { ...runView, parked: true }),
		).toBe(true);
		expect(
			Value.Check(WorkflowServiceWaitViewSchema, { ...runView, parked: false }),
		).toBe(false);
		expect(
			Value.Check(WorkflowServiceRunViewSchema, {
				...runView,
				pendingCheckpoints: [{ taskId: approve.id }],
			}),
		).toBe(false);
	});

	it("summarizes a parked root run with decide, attention, and the pending count", () => {
		const summaryView = runSummary(
			record,
			parkedState,
			checkpointEvents,
			"inactive",
			false,
			NOW,
		);
		expect(summaryView).toMatchObject({
			status: "waiting",
			taskCounts: expect.objectContaining({
				waiting: 1,
				completed: 3,
				failed: 1,
				cancelled: 1,
				pending: 1,
				total: 7,
			}),
			availableActions: ["stop", "wait", "reconcile", "decide"],
			requiresAttention: true,
			pendingCheckpointCount: 1,
		});
		expect(Value.Check(WorkflowRunSummarySchema, summaryView)).toBe(true);
		const nested = runSummary(
			nestedRecord,
			parkedState,
			checkpointEvents,
			"owned",
			true,
			NOW,
		);
		expect(nested.availableActions).toEqual(["stop", "wait"]);
		expect(nested.pendingCheckpointCount).toBe(1);
		const live = runSummary(
			record,
			{ ...parkedState, status: "running" },
			checkpointEvents,
			"owned",
			true,
			NOW,
		);
		expect(live.availableActions).toEqual(["stop", "wait", "decide"]);
	});

	it("accepts decide options with an approver and optional reason, closed", () => {
		expect(
			Value.Check(WorkflowDecideOptionsSchema, {
				decision: { proceed: true },
				approver: APPROVER,
			}),
		).toBe(true);
		expect(
			Value.Check(WorkflowDecideOptionsSchema, {
				decision: null,
				approver: APPROVER,
				reason: CHECKPOINT_REASON,
			}),
		).toBe(true);
		expect(
			Value.Check(WorkflowDecideOptionsSchema, {
				decision: true,
				approver: "",
			}),
		).toBe(false);
		expect(
			Value.Check(WorkflowDecideOptionsSchema, {
				decision: true,
				approver: "a".repeat(257),
			}),
		).toBe(false);
		expect(
			Value.Check(WorkflowDecideOptionsSchema, {
				decision: true,
				approver: APPROVER,
				reason: "",
			}),
		).toBe(false);
		expect(
			Value.Check(WorkflowDecideOptionsSchema, {
				decision: true,
				approver: APPROVER,
				decidedBy: APPROVER,
			}),
		).toBe(false);
		expect(
			Value.Check(WorkflowDecideOptionsSchema, { approver: APPROVER }),
		).toBe(false);
	});
});

describe("checkpoint inspection and logs", () => {
	const longPrompt = "p".repeat(4096);
	const verbose = checkpointTask("verbose", 1, { prompt: longPrompt });
	const verboseState = stateOf({
		status: "waiting",
		entries: [
			{
				task: verbose,
				status: "waiting",
				executions: [requestedExecution(verbose, { expiresAt: EXPIRES_AT })],
			},
		],
	});

	it("bounds checkpoint prompts in the inspection and marks the cut", () => {
		const inspection = runInspection(
			record,
			verboseState,
			[],
			"inactive",
			false,
			NOW,
		);
		const task = inspection.tasks?.[0];
		expect(task?.checkpoint?.prompt).toBe(
			"p".repeat(MAX_WORKFLOW_INSPECTION_PROMPT_LENGTH),
		);
		expect(task?.checkpoint?.promptTruncated).toBe(true);
		expect(task?.checkpoint).toMatchObject({
			requestedAt: REQUESTED_AT,
			expiresAt: EXPIRES_AT,
		});
		expect(inspection.run.pendingCheckpointCount).toBe(1);
		expect(Value.Check(WorkflowRunInspectionSchema, inspection)).toBe(true);
		// Artifact-backed views keep the whole contract-bounded prompt.
		expect(taskViews(verboseState)[0]?.checkpoint?.prompt).toBe(longPrompt);
		expect(taskViews(verboseState)[0]?.checkpoint).not.toHaveProperty(
			"promptTruncated",
		);
		// A prompt at the limit is not cut.
		const exact = taskViews(verboseState, {
			promptLimit: longPrompt.length,
		})[0]?.checkpoint;
		expect(exact?.prompt).toBe(longPrompt);
		expect(exact).not.toHaveProperty("promptTruncated");
	});

	it("includes decision details in the inspection without the decision value", () => {
		const inspection = runInspection(
			record,
			parkedState,
			checkpointEvents,
			"inactive",
			false,
			NOW,
			{ include: ["tasks", "executions"], taskId: review.id },
		);
		expect(inspection.tasks?.[0]?.checkpoint?.decision).toEqual({
			source: "operator",
			decidedBy: APPROVER,
			decidedAt: DECIDED_AT,
			reason: CHECKPOINT_REASON,
			sha256: DECISION_SHA,
		});
		expect(inspection.executions?.[0]).toMatchObject({
			id: reviewExecutionId,
			kind: "checkpoint",
			phase: "terminal",
			terminal: { outcome: "completed", sequence: 53 },
		});
		expect(inspection.executions?.[0]?.terminal).not.toHaveProperty("failure");
		expect(JSON.stringify(inspection)).not.toContain('"value"');
		expect(Value.Check(WorkflowRunInspectionSchema, inspection)).toBe(true);
	});

	it("renders checkpoint lifecycle lines from the journal without the value or approver", () => {
		const page = runLogs(checkpointEvents, parkedState, {});
		expect(page.entries.map((entry) => entry.sequence)).toEqual([
			51, 52, 53, 54, 55, 56, 57, 58,
		]);
		expect(page.entries[0]).toEqual({
			sequence: 51,
			timestamp: timestampAt(51),
			kind: "checkpoint",
			taskId: approve.id,
			taskKey: "/approve",
			status: "requested",
			message: "Checkpoint requested.",
		});
		expect(page.entries[1]).toMatchObject({
			kind: "task",
			taskId: approve.id,
			status: "waiting",
			reason: "Checkpoint awaits a decision.",
			message: "Task /approve changed from ready to waiting.",
		});
		expect(page.entries[2]).toMatchObject({
			kind: "run",
			status: "waiting",
			reason: "Workflow run awaits a checkpoint decision.",
			message: "Run status changed from running to waiting.",
		});
		expect(page.entries[3]).toEqual({
			sequence: 54,
			timestamp: timestampAt(54),
			kind: "checkpoint",
			taskId: review.id,
			taskKey: "release/review",
			status: "decided",
			reason: CHECKPOINT_REASON,
			message: "Checkpoint decided by operator.",
		});
		expect(page.entries[4]).toEqual({
			sequence: 55,
			timestamp: timestampAt(55),
			kind: "checkpoint",
			taskId: defaulted.id,
			taskKey: "/defaulted",
			status: "decided",
			message: "Checkpoint decided by default.",
		});
		expect(page.entries[5]).toMatchObject({
			kind: "terminal",
			taskId: expired.id,
			status: "failed",
			failureCode: "checkpoint-expired",
			message: "Execution generation 1 ended failed.",
		});
		expect(page.entries[6]).toMatchObject({
			kind: "terminal",
			taskId: cancelled.id,
			status: "cancelled",
			failureCode: "stop",
			message: "Execution generation 1 ended cancelled.",
		});
		expect(page.entries[7]).toMatchObject({
			kind: "task",
			taskId: cancelled.id,
			status: "cancelled",
			reason: "Workflow run ended before the checkpoint was decided.",
			message: "Task /cancelled changed from waiting to cancelled.",
		});
		for (const entry of page.entries) {
			expect(Value.Check(WorkflowLogEntrySchema, entry)).toBe(true);
		}
		expect(Value.Check(WorkflowLogPageSchema, page)).toBe(true);
		const serialized = JSON.stringify(page);
		expect(serialized).not.toContain(APPROVER);
		expect(serialized).not.toContain(DECISION_SHA);
		expect(serialized).not.toContain("artifact_");
		expect(serialized).not.toContain(CHECKPOINT_PROMPT);
		expect(serialized).not.toContain("proceed");
	});
});

describe("checkpoint bounds", () => {
	it("bounds pending checkpoints to the inspection item limit while counting them all", () => {
		const entries: TaskEntry[] = [];
		for (let index = 0; index < 300; index += 1) {
			const task = checkpointTask(`cp${index}`, index + 1, {
				prompt: "q".repeat(4096),
				timeoutMs: 60_000,
			});
			entries.push({
				task,
				status: "waiting",
				executions: [
					requestedExecution(task, {
						expiresAt: EXPIRES_AT,
						sequence: 100 + index * 2,
					}),
				],
			});
		}
		const state = stateOf({ status: "waiting", entries, lastSequence: 800 });
		const pending = pendingCheckpointViews(state);
		expect(pending).toHaveLength(MAX_WORKFLOW_INSPECTION_ITEMS);
		expect(pending[0]?.key).toBe("cp0");
		expect(pending.at(-1)?.key).toBe(`cp${MAX_WORKFLOW_INSPECTION_ITEMS - 1}`);
		expect(
			Value.Check(WorkflowServiceRunViewSchema.properties.pendingCheckpoints, [
				...pending,
			]),
		).toBe(true);
		const summaryView = runSummary(record, state, [], "inactive", false, NOW);
		expect(summaryView.pendingCheckpointCount).toBe(300);
		expect(summaryView.availableActions).toContain("decide");
		expect(Value.Check(WorkflowRunSummarySchema, summaryView)).toBe(true);
		const inspected = taskViews(state, {
			graph: true,
			promptLimit: MAX_WORKFLOW_INSPECTION_PROMPT_LENGTH,
		});
		expect(inspected).toHaveLength(300);
		for (const view of inspected) {
			expect(view.checkpoint?.prompt).toHaveLength(
				MAX_WORKFLOW_INSPECTION_PROMPT_LENGTH,
			);
			expect(view.checkpoint?.promptTruncated).toBe(true);
			expect(Value.Check(WorkflowServiceTaskViewSchema, view)).toBe(true);
		}
	});
});
