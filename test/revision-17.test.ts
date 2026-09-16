import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { HANDOFF_EXPORT_MEDIA_TYPE } from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	type AgentTaskExecutionRecord,
	type HandoffPolicy,
	type MaterializedAgentTask,
	MaterializedAgentTaskSchema,
	type MaterializedNestedWorkflowTask,
	type MaterializedSupportTask,
	type MaterializedWorkflowTask,
	type NestedWorkflowTaskExecutionRecord,
	type SubagentHandoffEvidence,
	type SubagentTerminalEvidence,
	type SupportTaskExecutionRecord,
	type SupportTaskTerminalEvidence,
	WORKFLOW_HANDOFF_FORMAT_SHA256,
	type WorkflowArtifactRef,
	type WorkflowRunStatus,
	type WorkflowTaskId,
	type WorkflowTaskStatus,
} from "../src/contracts.js";
import type { ArtifactHandle, HandoffHandle } from "../src/definition.js";
import {
	type TaskExecutionProjection,
	type WorkflowEventInput,
	type WorkflowStateProjection,
	WorkflowStateProjectionSchema,
} from "../src/events.js";
import {
	deriveJsonValueSha256,
	deriveNestedWorkflowRunId,
	deriveSubagentOperationId,
	deriveSupportImplementationIdentitySha256,
	deriveTaskExecutionId,
	deriveWorkflowArtifactId,
	deriveWorkflowFailureSha256,
} from "../src/execution.js";
import {
	deriveAgentTaskIdentity,
	deriveNestedWorkflowTaskIdentity,
	deriveWorkflowTaskId,
	type MaterializationCommit,
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

// Every expectation below follows the revision 17 handoff-adoption spec
// (sections 1, 2.3, 4.1, 4.2, 4.5, 7), not the reducer implementation.

const RUN_ID = "workflow_revision17" as const;
const RECORD_TIMESTAMP = "2026-09-15T00:00:00.000Z";
const definitionIdentitySha256 = "a".repeat(64);
const inputSha256 = "b".repeat(64);
const planIdentitySha256 = "c".repeat(64);
const resultSha256 = "d".repeat(64);
const structuredOutputSha256 = "e".repeat(64);
const workspaceBaselineSha256 = "f".repeat(64);
const movedBaselineSha256 = "0".repeat(64);
const handoffSha256 = "1".repeat(64);
const otherHandoffSha256 = "2".repeat(64);
const supportOutputSha256 = "3".repeat(64);
const childDefinitionIdentitySha256 = "4".repeat(64);
const childDefinitionSourceSha256 = "5".repeat(64);
// Git object ids: spec 1.2 GitObjectIdSchema `^[a-f0-9]{40,64}$`.
const BASELINE_HEAD = "0123456789abcdef0123456789abcdef01234567";
const HANDOFF_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";
const OTHER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
const OTHER_BASELINE = "76543210fedcba9876543210fedcba9876543210";
const HANDOFF_BYTES = 4096;
/** Spec D7 / 4.2: the fixed message of a required-policy no-handoff completion. */
const NO_HANDOFF_MESSAGE = "Completed worktree task captured no handoff.";
const BLOCKED_HANDOFF_MESSAGE =
	"Workflow handoff artifact import requires reconciliation.";
const outputSchema = Type.Object({ answer: Type.String() });
const supportHelper = defineSupportTask({
	name: "@vegardx/workflow-tools/summarize",
	moduleSpecifier: "@vegardx/workflow-tools",
	revision: 1,
	implementationSha256: "6".repeat(64),
	parametersSchema: Type.Object({ strict: Type.Boolean() }),
	outputSchema: Type.Object({ value: Type.String() }),
});

function readOnlyRequest(goal = "Answer") {
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

/** Spec D3 / 2.2: worktree workspace, positive write limit, optional policy. */
function worktreeRequest(goal = "Write", handoff?: HandoffPolicy) {
	const base = readOnlyRequest(goal);
	return {
		...base,
		agent: "writer",
		workspace: { mode: "worktree" as const, cwd: "/repo" },
		...(handoff === undefined ? {} : { handoff }),
		limits: { ...base.limits, workspaceWriteBytes: 1_048_576 },
	};
}

function records(
	inputs: readonly WorkflowEventInput[],
): WorkflowJournalEvent[] {
	return inputs.map((input, index) => ({
		schema: "pi-workflow-event",
		contractRevision: 18,
		sequence: index + 1,
		eventId: `event-${index + 1}`,
		timestamp: RECORD_TIMESTAMP,
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

function agentDeclaration(
	commit: MaterializationCommit,
	taskId: WorkflowTaskId,
): MaterializedAgentTask {
	const task = declaration(commit, taskId);
	if (task.spec.kind !== "agent") throw new Error("not an agent task");
	return task as MaterializedAgentTask;
}

function declarationEvent(
	commit: MaterializationCommit,
	taskId: WorkflowTaskId,
): WorkflowEventInput {
	for (const event of commit.events) {
		if (event.type === "task-declared" && event.data.task.id === taskId) {
			return structuredClone(event);
		}
	}
	throw new Error(`missing declaration event for ${taskId}`);
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
	reason?: string,
): WorkflowEventInput {
	return {
		type: "run-status-changed",
		data: { from, to, ...(reason === undefined ? {} : { reason }) },
	};
}

function taskStatus(
	taskId: WorkflowTaskId,
	from: WorkflowTaskStatus,
	to: WorkflowTaskStatus,
	reason?: string,
): WorkflowEventInput {
	return {
		type: "task-status-changed",
		data: { taskId, from, to, ...(reason === undefined ? {} : { reason }) },
	};
}

function invalidated(
	causeTaskId: WorkflowTaskId,
	taskIds: readonly WorkflowTaskId[],
): WorkflowEventInput {
	return {
		type: "task-invalidated",
		data: {
			causeTaskId,
			taskIds: [...taskIds],
			abandonedEpochs: [],
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
	execution:
		| AgentTaskExecutionRecord
		| SupportTaskExecutionRecord
		| NestedWorkflowTaskExecutionRecord,
): WorkflowEventInput {
	return { type: "task-execution-created", data: { execution } };
}

function childIds(execution: AgentTaskExecutionRecord): {
	subagentRunId: string;
	subagentAttemptId: string;
} {
	const stem = `${execution.taskId.slice(5, 13)}g${execution.generation}`;
	return { subagentRunId: `run_${stem}`, subagentAttemptId: `attempt_${stem}` };
}

type PreflightData = Extract<
	WorkflowEventInput,
	{ type: "task-execution-preflighted" }
>["data"];

/** Spec 4.1: the preflight persists the launch plan's workspace mode and baseline. */
function preflighted(
	execution: AgentTaskExecutionRecord,
	workspaceMode: "read-only" | "worktree",
	overrides: Partial<PreflightData> = {},
): WorkflowEventInput {
	const child = childIds(execution);
	return {
		type: "task-execution-preflighted",
		data: {
			executionId: execution.id,
			operationId: execution.operationId,
			preflightId: `preflight-${execution.generation}`,
			planIdentitySha256,
			plannedSubagentRunId: child.subagentRunId,
			plannedSubagentAttemptId: child.subagentAttemptId,
			expiresAt: "2027-01-01T00:00:00.000Z",
			workspaceMode,
			workspaceBaselineSha256,
			...overrides,
		},
	};
}

function launchIntended(
	execution: AgentTaskExecutionRecord,
	preflightId = `preflight-${execution.generation}`,
): WorkflowEventInput {
	return {
		type: "task-execution-launch-intended",
		data: {
			executionId: execution.id,
			operationId: execution.operationId,
			preflightId,
			planIdentitySha256,
		},
	};
}

function launchReceipted(
	execution: AgentTaskExecutionRecord,
): WorkflowEventInput {
	const child = childIds(execution);
	return {
		type: "task-execution-launch-receipted",
		data: {
			executionId: execution.id,
			operationId: execution.operationId,
			subagentRunId: child.subagentRunId,
			subagentAttemptId: child.subagentAttemptId,
			status: "active",
		},
	};
}

/** Preflight, launch intent, launch receipt, and the `ready -> running` step. */
function launchLadder(
	execution: AgentTaskExecutionRecord,
	workspaceMode: "read-only" | "worktree",
): WorkflowEventInput[] {
	return [
		preflighted(execution, workspaceMode),
		launchIntended(execution),
		launchReceipted(execution),
		taskStatus(execution.taskId, "ready", "running"),
	];
}

function observed(
	execution: AgentTaskExecutionRecord,
	status: "active" | "completed" | "failed" | "abandoned",
): WorkflowEventInput {
	const child = childIds(execution);
	return {
		type: "task-execution-child-observed",
		data: {
			executionId: execution.id,
			subagentRunId: child.subagentRunId,
			subagentAttemptId: child.subagentAttemptId,
			status,
		},
	};
}

function settled(
	execution: AgentTaskExecutionRecord,
	evidence: SubagentTerminalEvidence,
): WorkflowEventInput {
	return {
		type: "task-execution-child-settled",
		data: { executionId: execution.id, evidence },
	};
}

/** Spec D5: settlement evidence carries handoff identity, never paths. */
function handoffEvidence(
	execution: AgentTaskExecutionRecord,
	overrides: Partial<SubagentHandoffEvidence> = {},
): SubagentHandoffEvidence {
	return {
		attemptId: childIds(execution).subagentAttemptId,
		baselineHead: BASELINE_HEAD,
		handoffCommit: HANDOFF_COMMIT,
		...overrides,
	};
}

const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: 0.01,
};

function completedEvidence(
	handoff?: SubagentHandoffEvidence,
): SubagentTerminalEvidence {
	return {
		kind: "subagent",
		attemptOrdinal: 1,
		resultSha256,
		status: "completed",
		usage,
		usageComplete: true,
		runtimeMs: 1000,
		sandboxCleanup: "proved",
		workspaceCleanup: "proved",
		truncated: false,
		structuredOutputSha256,
		...(handoff === undefined ? {} : { handoff }),
	};
}

function failedEvidence(): SubagentTerminalEvidence {
	return {
		kind: "subagent",
		attemptOrdinal: 1,
		resultSha256: "7".repeat(64),
		status: "failed",
		usage,
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
		workspaceCleanup: "proved",
		truncated: false,
	};
}

function abandonedEvidence(
	handoff?: SubagentHandoffEvidence,
): SubagentTerminalEvidence {
	return {
		kind: "subagent",
		attemptOrdinal: 1,
		resultSha256: "8".repeat(64),
		status: "abandoned",
		usage,
		usageComplete: true,
		runtimeMs: 400,
		failure: {
			code: "operator-abandoned",
			origin: "operator",
			retry: "never",
			message: "Operator abandoned the run.",
			guidance: "No further attempts.",
		},
		sandboxCleanup: "proved",
		workspaceCleanup: "proved",
		truncated: false,
		...(handoff === undefined ? {} : { handoff }),
	};
}

function resultArtifact(
	taskId: WorkflowTaskId,
	producerExecutionId: string,
	overrides: Partial<
		Pick<WorkflowArtifactRef, "mediaType" | "schemaSha256">
	> = {},
): WorkflowArtifactRef {
	const input = {
		runId: RUN_ID,
		producerTaskId: taskId,
		producerExecutionId,
		output: "result" as const,
		sha256: structuredOutputSha256,
		schemaSha256: overrides.schemaSha256 ?? deriveJsonValueSha256(outputSchema),
	};
	return {
		id: deriveWorkflowArtifactId(input),
		...input,
		bytes: 18,
		mediaType: overrides.mediaType ?? "application/json",
	};
}

/** Spec D4 / 1.2: content-addressed patch blob with the fixed format digest. */
function handoffArtifact(
	taskId: WorkflowTaskId,
	producerExecutionId: string,
	overrides: Partial<
		Pick<WorkflowArtifactRef, "sha256" | "schemaSha256" | "mediaType" | "bytes">
	> = {},
): WorkflowArtifactRef {
	const input = {
		runId: RUN_ID,
		producerTaskId: taskId,
		producerExecutionId,
		output: "handoff" as const,
		sha256: overrides.sha256 ?? handoffSha256,
		schemaSha256: overrides.schemaSha256 ?? WORKFLOW_HANDOFF_FORMAT_SHA256,
	};
	return {
		id: deriveWorkflowArtifactId(input),
		...input,
		bytes: overrides.bytes ?? HANDOFF_BYTES,
		mediaType: overrides.mediaType ?? HANDOFF_EXPORT_MEDIA_TYPE,
	};
}

function artifactDeclared(artifact: WorkflowArtifactRef): WorkflowEventInput {
	return { type: "artifact-declared", data: { artifact } };
}

function artifactImported(
	execution: AgentTaskExecutionRecord,
	artifact: WorkflowArtifactRef,
): WorkflowEventInput {
	return {
		type: "task-execution-artifact-imported",
		data: {
			executionId: execution.id,
			subagentRunId: childIds(execution).subagentRunId,
			artifactId: artifact.id,
			sourceResultSha256: resultSha256,
		},
	};
}

type HandoffImportData = Extract<
	WorkflowEventInput,
	{ type: "task-execution-handoff-imported" }
>["data"];

function handoffImported(
	execution: AgentTaskExecutionRecord,
	artifact: WorkflowArtifactRef,
	overrides: Partial<HandoffImportData> = {},
): WorkflowEventInput {
	const child = childIds(execution);
	return {
		type: "task-execution-handoff-imported",
		data: {
			executionId: execution.id,
			subagentRunId: child.subagentRunId,
			subagentAttemptId: child.subagentAttemptId,
			artifactId: artifact.id,
			handoffCommit: HANDOFF_COMMIT,
			baselineHead: BASELINE_HEAD,
			sha256: artifact.sha256,
			bytes: artifact.bytes,
			...overrides,
		},
	};
}

function handoffAbsent(
	execution: AgentTaskExecutionRecord,
): WorkflowEventInput {
	const child = childIds(execution);
	return {
		type: "task-execution-handoff-absent",
		data: {
			executionId: execution.id,
			subagentRunId: child.subagentRunId,
			subagentAttemptId: child.subagentAttemptId,
		},
	};
}

function releaseIntended(
	execution: AgentTaskExecutionRecord,
): WorkflowEventInput {
	return {
		type: "task-execution-release-intended",
		data: {
			executionId: execution.id,
			subagentRunId: childIds(execution).subagentRunId,
		},
	};
}

function released(
	execution: AgentTaskExecutionRecord,
	status: "completed" | "failed" | "abandoned",
): WorkflowEventInput {
	return {
		type: "task-execution-released",
		data: {
			executionId: execution.id,
			subagentRunId: childIds(execution).subagentRunId,
			status,
		},
	};
}

function terminal(
	execution: AgentTaskExecutionRecord,
	outcome: "completed" | "failed" | "cancelled",
	evidence: SubagentTerminalEvidence,
): WorkflowEventInput {
	return {
		type: "task-execution-terminal",
		data: { executionId: execution.id, outcome, evidence },
	};
}

type FailureStage = Parameters<typeof deriveWorkflowFailureSha256>[0];

function workflowTerminal(
	executionId: string,
	outcome: "failed" | "cancelled" | "cleanup-blocked",
	stage: FailureStage,
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

interface AgentGraph {
	readonly task: MaterializedAgentTask;
	readonly execution: AgentTaskExecutionRecord;
	readonly commit: MaterializationCommit;
	readonly events: WorkflowEventInput[];
}

/** One required worktree task under a final barrier, ready with generation 1 created. */
function worktreeGraph(handoff?: HandoffPolicy): AgentGraph {
	const m = materializer();
	const handle = m.agent("writer", worktreeRequest("Write", handoff));
	const commit = m.closeEpoch("final", [handle]);
	const task = agentDeclaration(commit, handle.ref.taskId);
	const execution = agentExecution(task, 1);
	return {
		task,
		execution,
		commit,
		events: [
			runCreated(),
			...commit.events,
			runStatus("created", "running"),
			taskStatus(task.id, "pending", "ready"),
			executionCreated(execution),
		],
	};
}

/** One required read-only task under a final barrier, ready with generation 1 created. */
function readOnlyGraph(): AgentGraph {
	const m = materializer();
	const handle = m.agent("reader", readOnlyRequest("Read"));
	const commit = m.closeEpoch("final", [handle]);
	const task = agentDeclaration(commit, handle.ref.taskId);
	const execution = agentExecution(task, 1);
	return {
		task,
		execution,
		commit,
		events: [
			runCreated(),
			...commit.events,
			runStatus("created", "running"),
			taskStatus(task.id, "pending", "ready"),
			executionCreated(execution),
		],
	};
}

function workspaceMode(task: MaterializedAgentTask): "read-only" | "worktree" {
	return task.spec.request.workspace.mode;
}

/** Launched, observed completed, settled: phase `settled`. */
function settledCompleted(
	graph: AgentGraph,
	evidence: SubagentTerminalEvidence,
): WorkflowEventInput[] {
	return [
		...launchLadder(graph.execution, workspaceMode(graph.task)),
		observed(graph.execution, "completed"),
		settled(graph.execution, evidence),
	];
}

/** Result artifact declared and imported: phase `artifact-imported`. */
function resultImport(graph: AgentGraph): WorkflowEventInput[] {
	const output = resultArtifact(graph.task.id, graph.execution.id);
	return [artifactDeclared(output), artifactImported(graph.execution, output)];
}

/** Worktree task at phase `artifact-imported` with a captured handoff. */
function importedWithHandoff(graph: AgentGraph): WorkflowEventInput[] {
	return [
		...settledCompleted(
			graph,
			completedEvidence(handoffEvidence(graph.execution)),
		),
		...resultImport(graph),
	];
}

/** Worktree task at phase `artifact-imported` whose settlement captured no handoff. */
function importedWithoutHandoff(graph: AgentGraph): WorkflowEventInput[] {
	return [
		...settledCompleted(graph, completedEvidence()),
		...resultImport(graph),
	];
}

/** Handoff artifact declared and imported: phase `handoff-resolved`. */
function handoffImport(graph: AgentGraph): WorkflowEventInput[] {
	const patch = handoffArtifact(graph.task.id, graph.execution.id);
	return [artifactDeclared(patch), handoffImported(graph.execution, patch)];
}

/** Spec 4.5 "worktree success" from launch through `task-status-changed -> completed`. */
function worktreeSuccessLadder(graph: AgentGraph): WorkflowEventInput[] {
	const evidence = completedEvidence(handoffEvidence(graph.execution));
	return [
		...importedWithHandoff(graph),
		...handoffImport(graph),
		releaseIntended(graph.execution),
		released(graph.execution, "completed"),
		terminal(graph.execution, "completed", evidence),
		taskStatus(graph.task.id, "running", "completed"),
	];
}

/** Spec 4.5 "no changes": settled without handoff, absent recorded, released. */
function absentReleasedLadder(graph: AgentGraph): WorkflowEventInput[] {
	return [
		...importedWithoutHandoff(graph),
		handoffAbsent(graph.execution),
		releaseIntended(graph.execution),
		released(graph.execution, "completed"),
	];
}

/** Revision 16 read-only ladder plus the two new preflight fields. */
function readOnlySuccessLadder(graph: AgentGraph): WorkflowEventInput[] {
	return [
		...settledCompleted(graph, completedEvidence()),
		...resultImport(graph),
		releaseIntended(graph.execution),
		released(graph.execution, "completed"),
		terminal(graph.execution, "completed", completedEvidence()),
		taskStatus(graph.task.id, "running", "completed"),
	];
}

function projectionOf(
	state: WorkflowStateProjection,
	execution: { id: string },
): TaskExecutionProjection {
	const projection = state.executions[execution.id];
	if (!projection) throw new Error("missing execution projection");
	return projection;
}

function supportExecution(
	task: MaterializedSupportTask,
): SupportTaskExecutionRecord {
	return {
		kind: "support",
		id: deriveTaskExecutionId(RUN_ID, task.id, 1),
		runId: RUN_ID,
		taskId: task.id,
		generation: 1,
		taskIdentitySha256: task.spec.identitySha256,
		implementationIdentitySha256: deriveSupportImplementationIdentitySha256(
			task.spec.request.implementation,
		),
	};
}

function supportArtifact(task: MaterializedSupportTask): WorkflowArtifactRef {
	const input = {
		runId: RUN_ID,
		producerTaskId: task.id,
		producerExecutionId: deriveTaskExecutionId(RUN_ID, task.id, 1),
		output: "result" as const,
		sha256: supportOutputSha256,
		schemaSha256: deriveJsonValueSha256(
			task.spec.request.implementation.outputSchema,
		),
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
	execution: SupportTaskExecutionRecord,
	inputsSha256: string,
): WorkflowEventInput {
	return {
		type: "task-execution-support-intended",
		data: {
			executionId: execution.id,
			implementationIdentitySha256: execution.implementationIdentitySha256,
			parametersSha256: deriveJsonValueSha256(task.spec.request.parameters),
			inputsSha256,
		},
	};
}

/** Support ladder from intent through `task-status-changed -> completed`. */
function supportSuccessLadder(
	task: MaterializedSupportTask,
	execution: SupportTaskExecutionRecord,
	inputsSha256: string,
): WorkflowEventInput[] {
	const output = supportArtifact(task);
	const evidence: SupportTaskTerminalEvidence = {
		kind: "support",
		implementationIdentitySha256: execution.implementationIdentitySha256,
		parametersSha256: deriveJsonValueSha256(task.spec.request.parameters),
		inputsSha256,
		outputSha256: supportOutputSha256,
		artifactId: output.id,
		durationMs: 12,
	};
	return [
		supportIntent(task, execution, inputsSha256),
		taskStatus(task.id, "ready", "running"),
		artifactDeclared(output),
		{
			type: "task-execution-support-output-committed",
			data: {
				executionId: execution.id,
				artifactId: output.id,
				outputSha256: supportOutputSha256,
			},
		},
		{
			type: "task-execution-terminal",
			data: { executionId: execution.id, outcome: "completed", evidence },
		},
		taskStatus(task.id, "running", "completed"),
	];
}

/** A worktree writer whose handoff feeds a support task; both under the final barrier. */
function writerWithSupportConsumer(): {
	writer: AgentGraph;
	support: MaterializedSupportTask;
	supportExecution: SupportTaskExecutionRecord;
	events: WorkflowEventInput[];
} {
	const m = materializer();
	const writer = m.agent("writer", worktreeRequest("Write"));
	if (!writer.handoff) throw new Error("worktree handle lacks a handoff");
	const summarize = m.support(
		"summarize",
		supportHelper({
			parameters: { strict: true },
			inputs: { patch: asInput(writer.handoff) },
		}),
	);
	const commit = m.closeEpoch("final", [writer, summarize]);
	const writerTask = agentDeclaration(commit, writer.ref.taskId);
	const supportTask = declaration(
		commit,
		summarize.ref.taskId,
	) as MaterializedSupportTask;
	const writerExecution = agentExecution(writerTask, 1);
	const graph: AgentGraph = {
		task: writerTask,
		execution: writerExecution,
		commit,
		events: [],
	};
	const record = supportExecution(supportTask);
	return {
		writer: graph,
		support: supportTask,
		supportExecution: record,
		events: [
			runCreated(),
			...commit.events,
			runStatus("created", "running"),
			taskStatus(writerTask.id, "pending", "ready"),
			executionCreated(writerExecution),
			...worktreeSuccessLadder(graph),
			taskStatus(supportTask.id, "pending", "ready"),
			executionCreated(record),
		],
	};
}

/**
 * Spec 2.1: `inputs` accepts `ArtifactHandle<unknown> | HandoffHandle`. The
 * support descriptor type still names only ArtifactHandle, so the handoff
 * handle is passed through unchanged under that type.
 */
function asInput(handle: HandoffHandle): ArtifactHandle<unknown> {
	return handle as unknown as ArtifactHandle<unknown>;
}

function nestedTask(): MaterializedNestedWorkflowTask {
	const namespace: string[] = [];
	const input = { topic: "nested" };
	const spec = {
		key: "child",
		kind: "workflow" as const,
		role: "task" as const,
		disposition: "required" as const,
		after: [],
		inputs: {},
		replay: "read-only" as const,
		request: {
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
		},
	};
	return {
		id: deriveWorkflowTaskId(RUN_ID, namespace, "child"),
		runId: RUN_ID,
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
		materializationSequence: 1,
		materializationEpoch: 1,
		epochPosition: 1,
	};
}

describe("revision 17 preflight workspace identity", () => {
	it("rejects a preflight whose workspace mode does not match its task", () => {
		const worktree = worktreeGraph();
		expect(() =>
			reduce([
				...worktree.events,
				preflighted(worktree.execution, "read-only"),
			]),
		).toThrow("task execution preflight workspace does not match its task");
		const readOnly = readOnlyGraph();
		expect(() =>
			reduce([...readOnly.events, preflighted(readOnly.execution, "worktree")]),
		).toThrow("task execution preflight workspace does not match its task");
	});

	it("persists the workspace mode and baseline on the preflight projection", () => {
		const graph = worktreeGraph();
		const state = reduce([
			...graph.events,
			preflighted(graph.execution, "worktree"),
		]);
		expect(projectionOf(state, graph.execution).preflight).toStrictEqual({
			operationId: graph.execution.operationId,
			preflightId: "preflight-1",
			planIdentitySha256,
			plannedSubagentRunId: childIds(graph.execution).subagentRunId,
			plannedSubagentAttemptId: childIds(graph.execution).subagentAttemptId,
			expiresAt: "2027-01-01T00:00:00.000Z",
			workspaceMode: "worktree",
			workspaceBaselineSha256,
			fencingGeneration: 1,
			sequence: graph.events.length + 1,
		});
	});

	it("accepts a superseding preflight with a moved baseline and makes it authoritative", () => {
		const graph = worktreeGraph();
		const expired = preflighted(graph.execution, "worktree", {
			expiresAt: RECORD_TIMESTAMP,
		});
		const replacement = preflighted(graph.execution, "worktree", {
			preflightId: "preflight-2",
			supersedesPreflightId: "preflight-1",
			workspaceBaselineSha256: movedBaselineSha256,
		});
		const state = reduce([
			...graph.events,
			expired,
			replacement,
			launchIntended(graph.execution, "preflight-2"),
		]);
		const projection = projectionOf(state, graph.execution);
		expect(projection.phase).toBe("launch-intended");
		expect(projection.preflight).toMatchObject({
			preflightId: "preflight-2",
			supersedesPreflightId: "preflight-1",
			workspaceMode: "worktree",
			workspaceBaselineSha256: movedBaselineSha256,
		});
		expect(projection.launchIntent?.preflightId).toBe("preflight-2");
	});
});

describe("revision 17 child settlement", () => {
	it("rejects a read-only task settlement that carries a handoff", () => {
		const graph = readOnlyGraph();
		expect(() =>
			reduce([
				...graph.events,
				...settledCompleted(
					graph,
					completedEvidence(handoffEvidence(graph.execution)),
				),
			]),
		).toThrow("read-only task settlement carries a handoff");
	});

	it("rejects a worktree settlement whose handoff names another attempt", () => {
		const graph = worktreeGraph();
		expect(() =>
			reduce([
				...graph.events,
				...settledCompleted(
					graph,
					completedEvidence(
						handoffEvidence(graph.execution, { attemptId: "attempt_other" }),
					),
				),
			]),
		).toThrow("settlement handoff names another attempt");
	});

	it("rejects an abandoned settlement that carries a handoff", () => {
		const graph = worktreeGraph();
		const prefix: WorkflowEventInput[] = [
			...graph.events,
			...launchLadder(graph.execution, "worktree"),
			observed(graph.execution, "abandoned"),
		];
		expect(() =>
			reduce([
				...prefix,
				settled(
					graph.execution,
					abandonedEvidence(handoffEvidence(graph.execution)),
				),
			]),
		).toThrow("task execution child settlement is invalid");
		const state = reduce([
			...prefix,
			settled(graph.execution, abandonedEvidence()),
		]);
		expect(projectionOf(state, graph.execution).phase).toBe("settled");
	});

	it("accepts a worktree settlement with and without a captured handoff", () => {
		const graph = worktreeGraph();
		const without = reduce([
			...graph.events,
			...settledCompleted(graph, completedEvidence()),
		]);
		expect(projectionOf(without, graph.execution).phase).toBe("settled");
		expect(
			projectionOf(without, graph.execution).settlement?.evidence.handoff,
		).toBeUndefined();
		const handoff = handoffEvidence(graph.execution);
		const withHandoff = reduce([
			...graph.events,
			...settledCompleted(graph, completedEvidence(handoff)),
		]);
		expect(
			projectionOf(withHandoff, graph.execution).settlement?.evidence.handoff,
		).toStrictEqual(handoff);
	});
});

describe("revision 17 handoff import", () => {
	it("accepts a handoff import at phase artifact-imported with a matching artifact", () => {
		const graph = worktreeGraph();
		const patch = handoffArtifact(graph.task.id, graph.execution.id);
		const events: WorkflowEventInput[] = [
			...graph.events,
			...importedWithHandoff(graph),
			artifactDeclared(patch),
			handoffImported(graph.execution, patch),
		];
		const state = reduce(events);
		const projection = projectionOf(state, graph.execution);
		expect(projection.phase).toBe("handoff-resolved");
		expect(projection.handoffImport).toStrictEqual({
			subagentRunId: childIds(graph.execution).subagentRunId,
			subagentAttemptId: childIds(graph.execution).subagentAttemptId,
			artifactId: patch.id,
			handoffCommit: HANDOFF_COMMIT,
			baselineHead: BASELINE_HEAD,
			sha256: handoffSha256,
			bytes: HANDOFF_BYTES,
			sequence: events.length,
		});
		expect(projection.handoffAbsent).toBeUndefined();
		expect(projection.terminal).toBeUndefined();
	});

	it("rejects a handoff import on a read-only task", () => {
		const graph = readOnlyGraph();
		const patch = handoffArtifact(graph.task.id, graph.execution.id);
		expect(() =>
			reduce([
				...graph.events,
				...settledCompleted(graph, completedEvidence()),
				...resultImport(graph),
				handoffImported(graph.execution, patch),
			]),
		).toThrow("handoff import requires a worktree task");
	});

	it("rejects a handoff import outside phase artifact-imported", () => {
		const graph = worktreeGraph();
		const patch = handoffArtifact(graph.task.id, graph.execution.id);
		const settledPrefix: WorkflowEventInput[] = [
			...graph.events,
			...settledCompleted(
				graph,
				completedEvidence(handoffEvidence(graph.execution)),
			),
		];
		// Before the result import (phase settled).
		expect(() =>
			reduce([
				...settledPrefix,
				artifactDeclared(patch),
				handoffImported(graph.execution, patch),
			]),
		).toThrow("task execution handoff import is invalid");
		// Twice (phase handoff-resolved).
		expect(() =>
			reduce([
				...graph.events,
				...importedWithHandoff(graph),
				...handoffImport(graph),
				handoffImported(graph.execution, patch),
			]),
		).toThrow("task execution handoff import is invalid");
		// After release (phase released).
		expect(() =>
			reduce([
				...graph.events,
				...importedWithHandoff(graph),
				...handoffImport(graph),
				releaseIntended(graph.execution),
				released(graph.execution, "completed"),
				handoffImported(graph.execution, patch),
			]),
		).toThrow("task execution handoff import is invalid");
	});

	it("rejects a handoff import that does not match the settlement handoff", () => {
		const graph = worktreeGraph();
		const patch = handoffArtifact(graph.task.id, graph.execution.id);
		const prefix: WorkflowEventInput[] = [
			...graph.events,
			...importedWithHandoff(graph),
			artifactDeclared(patch),
		];
		expect(() =>
			reduce([
				...prefix,
				handoffImported(graph.execution, patch, {
					handoffCommit: OTHER_COMMIT,
				}),
			]),
		).toThrow("handoff import does not match the settlement handoff");
		expect(() =>
			reduce([
				...prefix,
				handoffImported(graph.execution, patch, {
					baselineHead: OTHER_BASELINE,
				}),
			]),
		).toThrow("handoff import does not match the settlement handoff");
		// A settlement that captured no handoff has nothing to import.
		expect(() =>
			reduce([
				...graph.events,
				...importedWithoutHandoff(graph),
				artifactDeclared(patch),
				handoffImported(graph.execution, patch),
			]),
		).toThrow("handoff import does not match the settlement handoff");
	});

	it("rejects a handoff import that names another attempt or child run", () => {
		const graph = worktreeGraph();
		const patch = handoffArtifact(graph.task.id, graph.execution.id);
		const prefix: WorkflowEventInput[] = [
			...graph.events,
			...importedWithHandoff(graph),
			artifactDeclared(patch),
		];
		// Spec 4.2 gates on the current attempt and the receipted run without
		// naming a distinct message; either the phase/gating message or the
		// settlement message satisfies the rule, but the import must be refused.
		const gating =
			/task execution handoff import is invalid|handoff import does not match the settlement handoff/;
		expect(() =>
			reduce([
				...prefix,
				handoffImported(graph.execution, patch, {
					subagentAttemptId: "attempt_other",
				}),
			]),
		).toThrow(gating);
		expect(() =>
			reduce([
				...prefix,
				handoffImported(graph.execution, patch, {
					subagentRunId: "run_other",
				}),
			]),
		).toThrow(gating);
	});

	it("rejects a handoff import whose artifact belongs to another task", () => {
		const m = materializer();
		const writer = m.agent("writer", worktreeRequest("Write"));
		const other = m.agent("other", worktreeRequest("Other"));
		const commit = m.closeEpoch("final", [writer, other]);
		const writerTask = agentDeclaration(commit, writer.ref.taskId);
		const otherTask = agentDeclaration(commit, other.ref.taskId);
		const writerExecution = agentExecution(writerTask, 1);
		const otherExecution = agentExecution(otherTask, 1);
		const graph: AgentGraph = {
			task: writerTask,
			execution: writerExecution,
			commit,
			events: [],
		};
		const foreign = handoffArtifact(otherTask.id, otherExecution.id);
		expect(() =>
			reduce([
				runCreated(),
				...commit.events,
				runStatus("created", "running"),
				taskStatus(otherTask.id, "pending", "ready"),
				executionCreated(otherExecution),
				taskStatus(writerTask.id, "pending", "ready"),
				executionCreated(writerExecution),
				...importedWithHandoff(graph),
				artifactDeclared(foreign),
				handoffImported(writerExecution, foreign),
			]),
		).toThrow("handoff import artifact does not match");
	});

	it("rejects a handoff import whose artifact belongs to a prior generation (D10)", () => {
		const graph = worktreeGraph();
		const firstPatch = handoffArtifact(graph.task.id, graph.execution.id);
		const second = agentExecution(graph.task, 2);
		const secondGraph: AgentGraph = { ...graph, execution: second };
		const prefix: WorkflowEventInput[] = [
			...graph.events,
			...worktreeSuccessLadder(graph),
			invalidated(graph.task.id, [graph.task.id]),
			taskStatus(graph.task.id, "invalidated", "pending"),
			taskStatus(graph.task.id, "pending", "ready"),
			executionCreated(second),
			...importedWithHandoff(secondGraph),
		];
		const before = reduce(prefix);
		// The generation-1 handoff artifact remains declared as history.
		expect(before.artifacts[firstPatch.id]).toStrictEqual(firstPatch);
		expect(() =>
			reduce([...prefix, handoffImported(second, firstPatch)]),
		).toThrow("handoff import artifact does not match");
		// The current generation imports its own artifact.
		const secondPatch = handoffArtifact(graph.task.id, second.id);
		const state = reduce([
			...prefix,
			artifactDeclared(secondPatch),
			handoffImported(second, secondPatch),
		]);
		expect(projectionOf(state, second).handoffImport?.artifactId).toBe(
			secondPatch.id,
		);
		expect(projectionOf(state, graph.execution).handoffImport?.artifactId).toBe(
			firstPatch.id,
		);
	});

	it("rejects a handoff import that names a result artifact", () => {
		const graph = worktreeGraph();
		// A result artifact that carries the handoff media type and format digest
		// differs from a handoff artifact in `output` alone.
		const disguised = resultArtifact(graph.task.id, graph.execution.id, {
			mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
			schemaSha256: WORKFLOW_HANDOFF_FORMAT_SHA256,
		});
		expect(() =>
			reduce([
				...graph.events,
				...settledCompleted(
					graph,
					completedEvidence(handoffEvidence(graph.execution)),
				),
				artifactDeclared(disguised),
				artifactImported(graph.execution, disguised),
				handoffImported(graph.execution, disguised),
			]),
		).toThrow("handoff import artifact does not match");
	});

	it("rejects a handoff import whose artifact media type is not the handoff media type", () => {
		const graph = worktreeGraph();
		// A declared handoff artifact always carries the handoff media type
		// (artifact-declared enforces it), so the only durable artifact with a
		// foreign media type is a result artifact; it differs in output as well.
		const jsonArtifact = resultArtifact(graph.task.id, graph.execution.id, {
			schemaSha256: WORKFLOW_HANDOFF_FORMAT_SHA256,
		});
		expect(() =>
			reduce([
				...graph.events,
				...settledCompleted(
					graph,
					completedEvidence(handoffEvidence(graph.execution)),
				),
				artifactDeclared(jsonArtifact),
				artifactImported(graph.execution, jsonArtifact),
				handoffImported(graph.execution, jsonArtifact),
			]),
		).toThrow("handoff import artifact does not match");
	});

	it("rejects a handoff import whose artifact schema digest is not the format digest", () => {
		const graph = worktreeGraph();
		const wrongFormat = resultArtifact(graph.task.id, graph.execution.id, {
			mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
		});
		expect(() =>
			reduce([
				...graph.events,
				...settledCompleted(
					graph,
					completedEvidence(handoffEvidence(graph.execution)),
				),
				artifactDeclared(wrongFormat),
				artifactImported(graph.execution, wrongFormat),
				handoffImported(graph.execution, wrongFormat),
			]),
		).toThrow("handoff import artifact does not match");
	});

	it("rejects a handoff import whose sha256 differs from the artifact", () => {
		const graph = worktreeGraph();
		const patch = handoffArtifact(graph.task.id, graph.execution.id);
		expect(() =>
			reduce([
				...graph.events,
				...importedWithHandoff(graph),
				artifactDeclared(patch),
				handoffImported(graph.execution, patch, { sha256: otherHandoffSha256 }),
			]),
		).toThrow("handoff import artifact does not match");
	});

	it("rejects a handoff import whose byte count differs from the artifact", () => {
		const graph = worktreeGraph();
		const patch = handoffArtifact(graph.task.id, graph.execution.id);
		expect(() =>
			reduce([
				...graph.events,
				...importedWithHandoff(graph),
				artifactDeclared(patch),
				handoffImported(graph.execution, patch, { bytes: HANDOFF_BYTES + 1 }),
			]),
		).toThrow("handoff import artifact does not match");
	});

	it("recovers a cleanup-blocked handoff import and deletes the terminal", () => {
		const graph = worktreeGraph();
		const patch = handoffArtifact(graph.task.id, graph.execution.id);
		const blocked: WorkflowEventInput[] = [
			...graph.events,
			...importedWithHandoff(graph),
			workflowTerminal(
				graph.execution.id,
				"cleanup-blocked",
				"handoff-import",
				BLOCKED_HANDOFF_MESSAGE,
			),
			taskStatus(graph.task.id, "running", "cleanup-blocked"),
			runStatus("running", "cleanup-blocked"),
		];
		const blockedState = reduce(blocked);
		expect(projectionOf(blockedState, graph.execution)).toMatchObject({
			phase: "terminal",
			terminal: {
				outcome: "cleanup-blocked",
				evidence: { kind: "workflow", stage: "handoff-import" },
			},
		});
		expect(blockedState.tasks[graph.task.id]?.status).toBe("cleanup-blocked");
		const events: WorkflowEventInput[] = [
			...blocked,
			artifactDeclared(patch),
			handoffImported(graph.execution, patch),
		];
		const state = reduce(events);
		const projection = projectionOf(state, graph.execution);
		expect(projection.phase).toBe("handoff-resolved");
		expect(projection.terminal).toBeUndefined();
		expect(projection.handoffImport?.artifactId).toBe(patch.id);
		expect(projection.handoffImport?.sequence).toBe(events.length);
	});
});

describe("revision 17 handoff absence", () => {
	it("accepts a handoff absence at artifact-imported when the settlement captured none", () => {
		const graph = worktreeGraph("optional");
		const events: WorkflowEventInput[] = [
			...graph.events,
			...importedWithoutHandoff(graph),
			handoffAbsent(graph.execution),
		];
		const state = reduce(events);
		const projection = projectionOf(state, graph.execution);
		expect(projection.phase).toBe("handoff-resolved");
		expect(projection.handoffAbsent).toStrictEqual({
			subagentRunId: childIds(graph.execution).subagentRunId,
			subagentAttemptId: childIds(graph.execution).subagentAttemptId,
			sequence: events.length,
		});
		expect(projection.handoffImport).toBeUndefined();
	});

	it("admits a handoff absence under the required policy as well", () => {
		const graph = worktreeGraph("required");
		const state = reduce([
			...graph.events,
			...importedWithoutHandoff(graph),
			handoffAbsent(graph.execution),
		]);
		expect(projectionOf(state, graph.execution).phase).toBe("handoff-resolved");
	});

	it("rejects a handoff absence when the settlement captured a handoff", () => {
		const graph = worktreeGraph("optional");
		expect(() =>
			reduce([
				...graph.events,
				...importedWithHandoff(graph),
				handoffAbsent(graph.execution),
			]),
		).toThrow("handoff absence contradicts a captured handoff");
	});

	it("rejects a handoff absence from a terminal phase and on a read-only task", () => {
		const graph = worktreeGraph("optional");
		// Absence is never a recovery: a cleanup-blocked handoff-import terminal
		// is only cleared by an import.
		expect(() =>
			reduce([
				...graph.events,
				...importedWithoutHandoff(graph),
				workflowTerminal(
					graph.execution.id,
					"cleanup-blocked",
					"handoff-import",
					BLOCKED_HANDOFF_MESSAGE,
				),
				handoffAbsent(graph.execution),
			]),
		).toThrow("task execution handoff import is invalid");
		// Nor may it follow the phase it produces or precede the result import.
		expect(() =>
			reduce([
				...graph.events,
				...importedWithoutHandoff(graph),
				handoffAbsent(graph.execution),
				handoffAbsent(graph.execution),
			]),
		).toThrow("task execution handoff import is invalid");
		expect(() =>
			reduce([
				...graph.events,
				...settledCompleted(graph, completedEvidence()),
				handoffAbsent(graph.execution),
			]),
		).toThrow("task execution handoff import is invalid");
		const readOnly = readOnlyGraph();
		expect(() =>
			reduce([
				...readOnly.events,
				...settledCompleted(readOnly, completedEvidence()),
				...resultImport(readOnly),
				handoffAbsent(readOnly.execution),
			]),
		).toThrow("handoff import requires a worktree task");
	});
});

describe("revision 17 artifact declaration", () => {
	it("rejects a handoff artifact for a non-worktree producer", () => {
		const graph = readOnlyGraph();
		expect(() =>
			reduce([
				...graph.events,
				artifactDeclared(handoffArtifact(graph.task.id, graph.execution.id)),
			]),
		).toThrow("handoff artifact requires a worktree producer");
	});

	it("rejects a handoff artifact with a foreign media type or format digest", () => {
		const graph = worktreeGraph();
		expect(() =>
			reduce([
				...graph.events,
				artifactDeclared(
					handoffArtifact(graph.task.id, graph.execution.id, {
						mediaType: "application/json",
					}),
				),
			]),
		).toThrow("handoff artifact format is invalid");
		expect(() =>
			reduce([
				...graph.events,
				artifactDeclared(
					handoffArtifact(graph.task.id, graph.execution.id, {
						schemaSha256: deriveJsonValueSha256(outputSchema),
					}),
				),
			]),
		).toThrow("handoff artifact format is invalid");
	});

	it("lets one result and one handoff of the same execution coexist", () => {
		const graph = worktreeGraph();
		const output = resultArtifact(graph.task.id, graph.execution.id);
		const patch = handoffArtifact(graph.task.id, graph.execution.id);
		const state = reduce([
			...graph.events,
			artifactDeclared(output),
			artifactDeclared(patch),
		]);
		expect(state.artifacts[output.id]).toStrictEqual(output);
		expect(state.artifacts[patch.id]).toStrictEqual(patch);
		expect(output.id).not.toBe(patch.id);
	});

	it("rejects a second handoff artifact for the same execution", () => {
		const graph = worktreeGraph();
		expect(() =>
			reduce([
				...graph.events,
				artifactDeclared(handoffArtifact(graph.task.id, graph.execution.id)),
				artifactDeclared(
					handoffArtifact(graph.task.id, graph.execution.id, {
						sha256: otherHandoffSha256,
					}),
				),
			]),
		).toThrow("artifact output identity is ambiguous");
	});

	it("keeps every revision 16 result artifact id stable under the widened output", () => {
		const graph = readOnlyGraph();
		const output = resultArtifact(graph.task.id, graph.execution.id);
		// Spec 1.3: the hash envelope is unchanged, so the revision 16 derivation
		// (sha256 over the JSON of the alphabetically keyed envelope) still holds.
		const revision16Id = `artifact_${createHash("sha256")
			.update(
				JSON.stringify({
					output: "result",
					producerExecutionId: graph.execution.id,
					producerTaskId: graph.task.id,
					runId: RUN_ID,
					schemaSha256: output.schemaSha256,
					sha256: output.sha256,
				}),
			)
			.digest("hex")}`;
		expect(output.id).toBe(revision16Id);
		const state = reduce([...graph.events, artifactDeclared(output)]);
		expect(state.artifacts[revision16Id]).toStrictEqual(output);
		// The same digests under `output: "handoff"` derive a distinct id.
		expect(
			deriveWorkflowArtifactId({
				runId: RUN_ID,
				producerTaskId: graph.task.id,
				producerExecutionId: graph.execution.id,
				output: "handoff",
				schemaSha256: output.schemaSha256,
				sha256: output.sha256,
			}),
		).not.toBe(revision16Id);
	});
});

describe("revision 17 release intent", () => {
	it("requires phase handoff-resolved for a completed worktree child", () => {
		const graph = worktreeGraph();
		expect(() =>
			reduce([
				...graph.events,
				...importedWithHandoff(graph),
				releaseIntended(graph.execution),
			]),
		).toThrow("task execution release intent is invalid");
		const imported = reduce([
			...graph.events,
			...importedWithHandoff(graph),
			...handoffImport(graph),
			releaseIntended(graph.execution),
		]);
		expect(projectionOf(imported, graph.execution).phase).toBe(
			"release-intended",
		);
		const absent = reduce([
			...graph.events,
			...importedWithoutHandoff(graph),
			handoffAbsent(graph.execution),
			releaseIntended(graph.execution),
		]);
		expect(projectionOf(absent, graph.execution).phase).toBe(
			"release-intended",
		);
	});

	it("still requires phase artifact-imported for a completed read-only child", () => {
		const graph = readOnlyGraph();
		expect(() =>
			reduce([
				...graph.events,
				...settledCompleted(graph, completedEvidence()),
				releaseIntended(graph.execution),
			]),
		).toThrow("task execution release intent is invalid");
		const state = reduce([
			...graph.events,
			...settledCompleted(graph, completedEvidence()),
			...resultImport(graph),
			releaseIntended(graph.execution),
		]);
		expect(projectionOf(state, graph.execution).phase).toBe("release-intended");
	});

	it("requires phase settled for non-completed worktree settlements", () => {
		const graph = worktreeGraph();
		const prefix: WorkflowEventInput[] = [
			...graph.events,
			...launchLadder(graph.execution, "worktree"),
			observed(graph.execution, "failed"),
		];
		expect(() => reduce([...prefix, releaseIntended(graph.execution)])).toThrow(
			"task execution release intent is invalid",
		);
		const state = reduce([
			...prefix,
			settled(graph.execution, failedEvidence()),
			releaseIntended(graph.execution),
			released(graph.execution, "failed"),
			terminal(graph.execution, "failed", failedEvidence()),
			taskStatus(graph.task.id, "running", "failed"),
		]);
		expect(state.tasks[graph.task.id]?.status).toBe("failed");
	});
});

describe("revision 17 terminal evidence", () => {
	it("completes the worktree success ladder with subagent evidence", () => {
		const graph = worktreeGraph();
		const events = [...graph.events, ...worktreeSuccessLadder(graph)];
		const state = reduce(events);
		const projection = projectionOf(state, graph.execution);
		expect(projection.phase).toBe("terminal");
		expect(projection.terminal).toMatchObject({
			outcome: "completed",
			evidence: {
				kind: "subagent",
				status: "completed",
				handoff: handoffEvidence(graph.execution),
			},
		});
		expect(projection.handoffImport?.artifactId).toBe(
			handoffArtifact(graph.task.id, graph.execution.id).id,
		);
		expect(state.tasks[graph.task.id]?.status).toBe("completed");
		// The import precedes the release intent in the journal (D6).
		const importSequence = projection.handoffImport?.sequence ?? 0;
		const releaseSequence = projection.releaseIntent?.sequence ?? 0;
		expect(importSequence).toBeGreaterThan(0);
		expect(importSequence).toBeLessThan(releaseSequence);
		// No path, branch, or ref ever reaches the projection.
		const serialized = JSON.stringify(state);
		expect(serialized).not.toContain("worktreePath");
		expect(serialized).not.toContain("refs/pi-subagent");
		expect(serialized).not.toContain("branch");
	});

	it("completes an optional-policy worktree task whose child captured no handoff", () => {
		// Spec amendment 1: a recorded absence under the optional policy is the
		// documented "no changes, optional" completion, not a mismatch.
		const graph = worktreeGraph("optional");
		const state = reduce([
			...graph.events,
			...absentReleasedLadder(graph),
			terminal(graph.execution, "completed", completedEvidence()),
		]);
		const projection = projectionOf(state, graph.execution);
		expect(projection.phase).toBe("terminal");
		expect(projection.terminal?.outcome).toBe("completed");
		expect(projection.handoffAbsent).toBeDefined();
		expect(projection.handoffImport).toBeUndefined();
	});

	it("rejects completed subagent evidence on an optional worktree task that reports a handoff after recording its absence", () => {
		const graph = worktreeGraph("optional");
		expect(() =>
			reduce([
				...graph.events,
				...absentReleasedLadder(graph),
				terminal(graph.execution, "completed", {
					...completedEvidence(),
					handoff: {
						attemptId: "attempt_servicechild",
						baselineHead: "a".repeat(40),
						handoffCommit: "b".repeat(40),
					},
				}),
			]),
		).toThrow("subagent terminal settlement does not match");
	});

	it("rejects completed subagent evidence once a handoff absence is recorded under the required policy", () => {
		const graph = worktreeGraph("required");
		expect(() =>
			reduce([
				...graph.events,
				...absentReleasedLadder(graph),
				terminal(graph.execution, "completed", completedEvidence()),
			]),
		).toThrow("subagent terminal handoff does not match");
	});

	it("accepts cleanup-blocked handoff-import evidence only from artifact-imported on a worktree task", () => {
		const graph = worktreeGraph();
		const blocked = (executionId: string) =>
			workflowTerminal(
				executionId,
				"cleanup-blocked",
				"handoff-import",
				BLOCKED_HANDOFF_MESSAGE,
			);
		const state = reduce([
			...graph.events,
			...importedWithHandoff(graph),
			blocked(graph.execution.id),
			taskStatus(graph.task.id, "running", "cleanup-blocked"),
		]);
		expect(projectionOf(state, graph.execution).terminal).toMatchObject({
			outcome: "cleanup-blocked",
			evidence: {
				kind: "workflow",
				stage: "handoff-import",
				message: BLOCKED_HANDOFF_MESSAGE,
			},
		});
		expect(state.tasks[graph.task.id]?.status).toBe("cleanup-blocked");
		// From settled (before the result import).
		expect(() =>
			reduce([
				...graph.events,
				...settledCompleted(
					graph,
					completedEvidence(handoffEvidence(graph.execution)),
				),
				blocked(graph.execution.id),
			]),
		).toThrow("workflow terminal evidence is inconsistent");
		// From handoff-resolved.
		expect(() =>
			reduce([
				...graph.events,
				...importedWithHandoff(graph),
				...handoffImport(graph),
				blocked(graph.execution.id),
			]),
		).toThrow("workflow terminal evidence is inconsistent");
		// On a read-only task at artifact-imported.
		const readOnly = readOnlyGraph();
		expect(() =>
			reduce([
				...readOnly.events,
				...settledCompleted(readOnly, completedEvidence()),
				...resultImport(readOnly),
				blocked(readOnly.execution.id),
			]),
		).toThrow("workflow terminal evidence is inconsistent");
	});

	it("accepts failed handoff-import evidence only from released with an absent required handoff and the fixed message", () => {
		const graph = worktreeGraph("required");
		const events: WorkflowEventInput[] = [
			...graph.events,
			...absentReleasedLadder(graph),
			workflowTerminal(
				graph.execution.id,
				"failed",
				"handoff-import",
				NO_HANDOFF_MESSAGE,
			),
			taskStatus(graph.task.id, "running", "failed", NO_HANDOFF_MESSAGE),
		];
		const state = reduce(events);
		const projection = projectionOf(state, graph.execution);
		expect(projection.phase).toBe("terminal");
		expect(projection.terminal).toStrictEqual({
			outcome: "failed",
			evidence: {
				kind: "workflow",
				stage: "handoff-import",
				failureSha256: deriveWorkflowFailureSha256(
					"handoff-import",
					NO_HANDOFF_MESSAGE,
				),
				message: NO_HANDOFF_MESSAGE,
			},
			sequence: events.length - 1,
		});
		expect(projection.release?.status).toBe("completed");
		expect(state.tasks[graph.task.id]?.status).toBe("failed");
	});

	it("rejects failed handoff-import evidence with any other message, policy, phase, or handoff state", () => {
		const required = worktreeGraph("required");
		// Another message.
		expect(() =>
			reduce([
				...required.events,
				...absentReleasedLadder(required),
				workflowTerminal(
					required.execution.id,
					"failed",
					"handoff-import",
					"Completed worktree task captured no handoff",
				),
			]),
		).toThrow("workflow terminal evidence is inconsistent");
		// Optional policy.
		const optional = worktreeGraph("optional");
		expect(() =>
			reduce([
				...optional.events,
				...absentReleasedLadder(optional),
				workflowTerminal(
					optional.execution.id,
					"failed",
					"handoff-import",
					NO_HANDOFF_MESSAGE,
				),
			]),
		).toThrow("workflow terminal evidence is inconsistent");
		// Released with an imported handoff instead of an absence.
		expect(() =>
			reduce([
				...required.events,
				...importedWithHandoff(required),
				...handoffImport(required),
				releaseIntended(required.execution),
				released(required.execution, "completed"),
				workflowTerminal(
					required.execution.id,
					"failed",
					"handoff-import",
					NO_HANDOFF_MESSAGE,
				),
			]),
		).toThrow("workflow terminal evidence is inconsistent");
		// Absent but not yet released (phase handoff-resolved).
		expect(() =>
			reduce([
				...required.events,
				...importedWithoutHandoff(required),
				handoffAbsent(required.execution),
				workflowTerminal(
					required.execution.id,
					"failed",
					"handoff-import",
					NO_HANDOFF_MESSAGE,
				),
			]),
		).toThrow("workflow terminal evidence is inconsistent");
		// Absent and release intended but not released.
		expect(() =>
			reduce([
				...required.events,
				...importedWithoutHandoff(required),
				handoffAbsent(required.execution),
				releaseIntended(required.execution),
				workflowTerminal(
					required.execution.id,
					"failed",
					"handoff-import",
					NO_HANDOFF_MESSAGE,
				),
			]),
		).toThrow("workflow terminal evidence is inconsistent");
		// Cancelled never carries the handoff-import stage.
		expect(() =>
			reduce([
				...required.events,
				...absentReleasedLadder(required),
				workflowTerminal(
					required.execution.id,
					"cancelled",
					"handoff-import",
					NO_HANDOFF_MESSAGE,
				),
			]),
		).toThrow("workflow terminal evidence is inconsistent");
		// Failed from artifact-imported (where only cleanup-blocked is admitted).
		expect(() =>
			reduce([
				...required.events,
				...importedWithHandoff(required),
				workflowTerminal(
					required.execution.id,
					"failed",
					"handoff-import",
					NO_HANDOFF_MESSAGE,
				),
			]),
		).toThrow("workflow terminal evidence is inconsistent");
	});

	it("rejects the handoff-import stage on support and nested executions", () => {
		const m = materializer();
		const summarize = m.support(
			"summarize",
			supportHelper({ parameters: { strict: true } }),
		);
		const commit = m.closeEpoch("final", [summarize]);
		const supportTask = declaration(
			commit,
			summarize.ref.taskId,
		) as MaterializedSupportTask;
		const supportRecord = supportExecution(supportTask);
		const supportPrefix: WorkflowEventInput[] = [
			runCreated(),
			...commit.events,
			runStatus("created", "running"),
			taskStatus(supportTask.id, "pending", "ready"),
			executionCreated(supportRecord),
		];
		expect(() =>
			reduce([
				...supportPrefix,
				workflowTerminal(
					supportRecord.id,
					"failed",
					"handoff-import",
					NO_HANDOFF_MESSAGE,
				),
			]),
		).toThrow("workflow terminal evidence is inconsistent");
		expect(() =>
			reduce([
				...supportPrefix,
				workflowTerminal(
					supportRecord.id,
					"cleanup-blocked",
					"handoff-import",
					BLOCKED_HANDOFF_MESSAGE,
				),
			]),
		).toThrow("workflow terminal evidence is inconsistent");
		const nested = nestedTask();
		const nestedRecord: NestedWorkflowTaskExecutionRecord = {
			kind: "workflow",
			id: deriveTaskExecutionId(RUN_ID, nested.id, 1),
			runId: RUN_ID,
			taskId: nested.id,
			generation: 1,
			taskIdentitySha256: nested.spec.identitySha256,
			childRunId: deriveNestedWorkflowRunId(RUN_ID, nested.id, 1),
		};
		const nestedPrefix: WorkflowEventInput[] = [
			runCreated(),
			{ type: "task-declared", data: { task: nested } },
			{
				type: "barrier-reached",
				data: { epoch: 1, kind: "final", taskIds: [nested.id] },
			},
			runStatus("created", "running"),
			taskStatus(nested.id, "pending", "ready"),
			executionCreated(nestedRecord),
		];
		expect(() =>
			reduce([
				...nestedPrefix,
				workflowTerminal(
					nestedRecord.id,
					"failed",
					"handoff-import",
					NO_HANDOFF_MESSAGE,
				),
			]),
		).toThrow("workflow terminal evidence is inconsistent");
		expect(() =>
			reduce([
				...nestedPrefix,
				workflowTerminal(
					nestedRecord.id,
					"cleanup-blocked",
					"handoff-import",
					BLOCKED_HANDOFF_MESSAGE,
				),
			]),
		).toThrow("workflow terminal evidence is inconsistent");
	});
});

describe("revision 17 task declaration and handoff inputs", () => {
	it("rejects an ordinary task whose input names a handoff of a non-worktree task", () => {
		const m = materializer();
		const reader = m.agent("reader", readOnlyRequest("Read"));
		const commit = m.closeEpoch("final", [reader]);
		const producer = agentDeclaration(commit, reader.ref.taskId);
		// Hand-built (the materializer refuses this shape): a read-only consumer
		// whose data dependency names the reader's non-existent handoff.
		const specWithoutIdentity = {
			key: "consumer",
			kind: "agent" as const,
			role: "task" as const,
			disposition: "required" as const,
			after: [{ runId: RUN_ID, taskId: producer.id }],
			inputs: {
				patch: {
					runId: RUN_ID,
					producerTaskId: producer.id,
					output: "handoff" as const,
				},
			},
			replay: "read-only" as const,
			request: structuredClone(producer.spec.request),
		};
		const consumer: MaterializedAgentTask = {
			id: deriveWorkflowTaskId(RUN_ID, [], "consumer"),
			runId: RUN_ID,
			namespace: [],
			spec: {
				...specWithoutIdentity,
				identitySha256: deriveAgentTaskIdentity({
					definitionIdentitySha256,
					inputSha256,
					namespace: [],
					spec: specWithoutIdentity,
				}),
			},
			definitionIdentitySha256,
			materializationSequence: 2,
			materializationEpoch: 1,
			epochPosition: 2,
		};
		expect(Value.Check(MaterializedAgentTaskSchema, consumer)).toBe(true);
		expect(() =>
			reduce([
				runCreated(),
				declarationEvent(commit, producer.id),
				{ type: "task-declared", data: { task: consumer } },
			]),
		).toThrow("task input names a handoff of a non-worktree task");
	});

	it("digests a support intent over the handoff artifact named by its input", () => {
		const run = writerWithSupportConsumer();
		expect(run.support.spec.inputs.patch).toStrictEqual({
			runId: RUN_ID,
			producerTaskId: run.writer.task.id,
			output: "handoff",
		});
		// Spec 2.3: the digest map keeps { [inputName]: sha256 of the selected
		// artifact }, and the selection follows ref.output.
		const expectedInputsSha256 = deriveJsonValueSha256({
			patch: handoffSha256,
		});
		expect(() =>
			reduce([
				...run.events,
				supportIntent(
					run.support,
					run.supportExecution,
					deriveJsonValueSha256({ patch: structuredOutputSha256 }),
				),
			]),
		).toThrow("support task intent does not match its task");
		const state = reduce([
			...run.events,
			...supportSuccessLadder(
				run.support,
				run.supportExecution,
				expectedInputsSha256,
			),
		]);
		expect(
			projectionOf(state, run.supportExecution).supportIntent?.inputsSha256,
		).toBe(expectedInputsSha256);
		expect(state.tasks[run.support.id]?.status).toBe("completed");
	});
});

describe("revision 17 compatibility and persistence", () => {
	it("reduces the revision 16 read-only ladder to the same projection", () => {
		const graph = readOnlyGraph();
		const events: WorkflowEventInput[] = [
			...graph.events,
			...readOnlySuccessLadder(graph),
		];
		const sequenceOf = (type: WorkflowEventInput["type"]): number => {
			const index = events.findIndex((event) => event.type === type);
			if (index < 0) throw new Error(`missing ${type}`);
			return index + 1;
		};
		const child = childIds(graph.execution);
		const output = resultArtifact(graph.task.id, graph.execution.id);
		const evidence = completedEvidence();
		const expected: WorkflowStateProjection = {
			runId: RUN_ID,
			definitionIdentitySha256,
			inputSha256,
			status: "running",
			currentEpoch: 2,
			effects: [],
			lastSequence: events.length,
			tasks: {
				[graph.task.id]: {
					task: graph.task,
					status: "completed",
					committed: true,
					currentExecutionId: graph.execution.id,
				},
			},
			executions: {
				[graph.execution.id]: {
					execution: graph.execution,
					phase: "terminal",
					createdSequence: sequenceOf("task-execution-created"),
					preflight: {
						operationId: graph.execution.operationId,
						preflightId: "preflight-1",
						planIdentitySha256,
						plannedSubagentRunId: child.subagentRunId,
						plannedSubagentAttemptId: child.subagentAttemptId,
						expiresAt: "2027-01-01T00:00:00.000Z",
						workspaceMode: "read-only",
						workspaceBaselineSha256,
						fencingGeneration: 1,
						sequence: sequenceOf("task-execution-preflighted"),
					},
					launchIntent: {
						operationId: graph.execution.operationId,
						preflightId: "preflight-1",
						planIdentitySha256,
						sequence: sequenceOf("task-execution-launch-intended"),
					},
					launchReceipt: {
						operationId: graph.execution.operationId,
						subagentRunId: child.subagentRunId,
						subagentAttemptId: child.subagentAttemptId,
						status: "active",
						sequence: sequenceOf("task-execution-launch-receipted"),
					},
					observation: {
						subagentRunId: child.subagentRunId,
						subagentAttemptId: child.subagentAttemptId,
						status: "completed",
						sequence: sequenceOf("task-execution-child-observed"),
					},
					settlement: {
						evidence,
						sequence: sequenceOf("task-execution-child-settled"),
					},
					artifactImport: {
						subagentRunId: child.subagentRunId,
						artifactId: output.id,
						sourceResultSha256: resultSha256,
						sequence: sequenceOf("task-execution-artifact-imported"),
					},
					releaseIntent: {
						subagentRunId: child.subagentRunId,
						sequence: sequenceOf("task-execution-release-intended"),
					},
					release: {
						subagentRunId: child.subagentRunId,
						status: "completed",
						sequence: sequenceOf("task-execution-released"),
					},
					terminal: {
						outcome: "completed",
						evidence,
						sequence: sequenceOf("task-execution-terminal"),
					},
				},
			},
			artifacts: { [output.id]: output },
			barriers: [
				{
					epoch: 1,
					kind: "final",
					taskIds: [graph.task.id],
					sequence: sequenceOf("barrier-reached"),
				},
			],
		};
		const state = reduce(events);
		expect(JSON.parse(JSON.stringify(state))).toStrictEqual(expected);
		expect(JSON.stringify(state)).toBe(
			JSON.stringify(JSON.parse(JSON.stringify(state))),
		);
		expect(Value.Check(WorkflowStateProjectionSchema, state)).toBe(true);
		// The read-only spec never carries a handoff policy or handoff evidence.
		expect(graph.task.spec.request).not.toHaveProperty("handoff");
		expect(state.executions[graph.execution.id]).not.toHaveProperty(
			"handoffImport",
		);
		expect(state.executions[graph.execution.id]).not.toHaveProperty(
			"handoffAbsent",
		);
	});

	it("survives JSON and journal snapshot round trips and passes the strict schema", async () => {
		const m = materializer();
		const writer = m.agent("writer", worktreeRequest("Write"));
		if (!writer.handoff) throw new Error("worktree handle lacks a handoff");
		const noop = m.agent("noop", {
			...worktreeRequest("Noop", "required"),
			disposition: "optional" as const,
		});
		const reader = m.agent("reader", readOnlyRequest("Read"));
		const summarize = m.support(
			"summarize",
			supportHelper({
				parameters: { strict: true },
				inputs: { patch: asInput(writer.handoff), answer: reader.output },
			}),
		);
		const commit = m.closeEpoch("final", [writer, noop, reader, summarize]);
		const writerGraph: AgentGraph = {
			task: agentDeclaration(commit, writer.ref.taskId),
			execution: agentExecution(declaration(commit, writer.ref.taskId), 1),
			commit,
			events: [],
		};
		const noopGraph: AgentGraph = {
			task: agentDeclaration(commit, noop.ref.taskId),
			execution: agentExecution(declaration(commit, noop.ref.taskId), 1),
			commit,
			events: [],
		};
		const readerGraph: AgentGraph = {
			task: agentDeclaration(commit, reader.ref.taskId),
			execution: agentExecution(declaration(commit, reader.ref.taskId), 1),
			commit,
			events: [],
		};
		const supportTask = declaration(
			commit,
			summarize.ref.taskId,
		) as MaterializedSupportTask;
		const supportRecord = supportExecution(supportTask);
		const events: WorkflowEventInput[] = [
			runCreated(),
			...commit.events,
			runStatus("created", "running"),
			taskStatus(writerGraph.task.id, "pending", "ready"),
			executionCreated(writerGraph.execution),
			...worktreeSuccessLadder(writerGraph),
			taskStatus(noopGraph.task.id, "pending", "ready"),
			executionCreated(noopGraph.execution),
			...absentReleasedLadder(noopGraph),
			workflowTerminal(
				noopGraph.execution.id,
				"failed",
				"handoff-import",
				NO_HANDOFF_MESSAGE,
			),
			taskStatus(noopGraph.task.id, "running", "failed", NO_HANDOFF_MESSAGE),
			taskStatus(readerGraph.task.id, "pending", "ready"),
			executionCreated(readerGraph.execution),
			...readOnlySuccessLadder(readerGraph),
			taskStatus(supportTask.id, "pending", "ready"),
			executionCreated(supportRecord),
			...supportSuccessLadder(
				supportTask,
				supportRecord,
				deriveJsonValueSha256({
					answer: structuredOutputSha256,
					patch: handoffSha256,
				}),
			),
		];
		const state = reduce(events);
		expect(state.tasks[writerGraph.task.id]?.status).toBe("completed");
		expect(state.tasks[noopGraph.task.id]?.status).toBe("failed");
		expect(state.tasks[readerGraph.task.id]?.status).toBe("completed");
		expect(state.tasks[supportTask.id]?.status).toBe("completed");
		expect(
			projectionOf(state, writerGraph.execution).handoffImport,
		).toBeDefined();
		expect(
			projectionOf(state, noopGraph.execution).handoffAbsent,
		).toBeDefined();
		const roundTrip = JSON.parse(JSON.stringify(state)) as unknown;
		expect(roundTrip).toStrictEqual(state);
		expect(Value.Check(WorkflowStateProjectionSchema, roundTrip)).toBe(true);
		expect(reduce(structuredClone(events))).toStrictEqual(state);
		for (let length = 1; length <= events.length; length += 1) {
			expect(
				Value.Check(
					WorkflowStateProjectionSchema,
					reduce(events.slice(0, length)),
				),
			).toBe(true);
		}
		const root = path.resolve(".pi", "test-revision-17", randomUUID());
		const lease = await acquireWorkflowRunLease({
			storeRoot: root,
			runId: RUN_ID,
			ownerId: "revision-17",
		});
		try {
			const journal = await WorkflowRunJournal.open(root, RUN_ID, lease);
			for (const event of events) await journal.appendEvent(event);
			const snapshot = await rebuildWorkflowSnapshot(journal);
			expect(snapshot.state).toStrictEqual(state);
			expect(await journal.readSnapshot()).toStrictEqual(snapshot);
		} finally {
			await lease.release();
		}
	});
});
