import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HANDOFF_EXPORT_MEDIA_TYPE } from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	type AgentTaskExecutionRecord,
	type CheckpointHeadlessPolicy,
	type CheckpointTaskExecutionRecord,
	type CheckpointTaskRequest,
	type CheckpointTaskSpec,
	type CheckpointTerminalEvidence,
	type MaterializedAgentTask,
	type MaterializedCheckpointTask,
	MaterializedCheckpointTaskSchema,
	type MaterializedWorkflowTask,
	type SubagentHandoffEvidence,
	type SubagentTerminalEvidence,
	type TaskDisposition,
	type TaskRef,
	type TaskRole,
	WORKFLOW_CONTRACT_REVISION,
	WORKFLOW_HANDOFF_FORMAT_SHA256,
	type WorkflowArtifactHandleRef,
	type WorkflowArtifactRef,
	type WorkflowRunStatus,
	type WorkflowTaskId,
	type WorkflowTaskStatus,
} from "../src/contracts.js";
import {
	type TaskExecutionProjection,
	type WorkflowEventInput,
	type WorkflowStateProjection,
	WorkflowStateProjectionSchema,
} from "../src/events.js";
import {
	deriveJsonValueSha256,
	deriveSubagentOperationId,
	deriveTaskExecutionId,
	deriveWorkflowArtifactId,
	deriveWorkflowFailureSha256,
} from "../src/execution.js";
import {
	deriveCheckpointTaskIdentity,
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
	invalidationClosure,
	rebuildWorkflowSnapshot,
	reduceWorkflowEvents,
} from "../src/reducer.js";

// Every expectation below follows the authoritative revision 18 checkpoint
// spec (decisions C1-C15, section 2.4 exact messages, section 3 ladders), not
// the reducer implementation.

const RUN_ID = "workflow_revision18" as const;
/** Every event is stamped at T0 unless a step names a later instant. */
const T0 = "2026-09-15T00:00:00.000Z";
const TIMEOUT_MS = 3_600_000;
/** T0 + timeoutMs: the latest expiry a request stamped at T0 may carry. */
const EXPIRES_AT = "2026-09-15T01:00:00.000Z";
const BEFORE_EXPIRY = "2026-09-15T00:30:00.000Z";
/** A decision record's own time, a moment before the event that carries it. */
const RECORDED_AT = "2026-09-15T00:29:59.950Z";
const AFTER_EXPIRY = "2026-09-15T01:00:00.001Z";
/** Accepted by the date-time format yet not a finite instant (leap second). */
const NON_FINITE_EXPIRY = "2026-09-15T23:59:60.000Z";
const definitionIdentitySha256 = "a".repeat(64);
const inputSha256 = "b".repeat(64);
const planIdentitySha256 = "c".repeat(64);
const resultSha256 = "d".repeat(64);
const structuredOutputSha256 = "e".repeat(64);
const workspaceBaselineSha256 = "f".repeat(64);
const handoffSha256 = "1".repeat(64);
const BASELINE_HEAD = "0123456789abcdef0123456789abcdef01234567";
const HANDOFF_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";
const HANDOFF_BYTES = 4096;
const APPROVER = "vegard";
// C15 fixed strings.
const AWAITS_REASON = "Checkpoint awaits a decision.";
const DECIDED_REASON = "Checkpoint decided.";
const EXPIRED_REASON = "Checkpoint expired without a decision.";
const RUN_ENDING_REASON =
	"Workflow run ended before the checkpoint was decided.";
const STOP_REASON = "Workflow stop requested.";
const RUN_AWAITS_REASON = "Workflow run awaits a checkpoint decision.";
const INPUT_REASON = "Checkpoint input artifact evidence is incomplete.";
const outputSchema = Type.Object({ answer: Type.String() });
const decisionSchema = {
	type: "object",
	properties: { proceed: { type: "boolean" }, note: { type: "string" } },
	required: ["proceed"],
	additionalProperties: false,
};
const DECISION = { proceed: true };
const DEFAULT_DECISION = { proceed: false };
const DECISION_SHA256 = deriveJsonValueSha256(DECISION);
const DEFAULT_SHA256 = deriveJsonValueSha256(DEFAULT_DECISION);
const DECISION_SCHEMA_SHA256 = deriveJsonValueSha256(decisionSchema);
/** The same decision schema as authored through TypeBox (spec 3 authoring). */
const decisionTypebox = Type.Object(
	{ proceed: Type.Boolean(), note: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);
const PROMPT = "Approve the plan before the writer runs?";

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

function worktreeRequest(goal = "Write") {
	const base = readOnlyRequest(goal);
	return {
		...base,
		agent: "writer",
		workspace: { mode: "worktree" as const, cwd: "/repo" },
		limits: { ...base.limits, workspaceWriteBytes: 1_048_576 },
	};
}

/** An event input, optionally stamped at a later instant than its predecessor. */
type Step =
	| WorkflowEventInput
	| { readonly at: string; readonly event: WorkflowEventInput };

function at(timestamp: string, event: WorkflowEventInput): Step {
	return { at: timestamp, event };
}

function records(steps: readonly Step[]): WorkflowJournalEvent[] {
	let timestamp = T0;
	return steps.map((step, index) => {
		const input = "at" in step ? step.event : step;
		if ("at" in step) timestamp = step.at;
		return {
			schema: "pi-workflow-event",
			contractRevision: 20,
			sequence: index + 1,
			eventId: `event-${index + 1}`,
			timestamp,
			runId: RUN_ID,
			ownerId: "test",
			leaseId: "lease-test",
			fencingGeneration: 1,
			type: input.type,
			data: input.data,
		};
	});
}

function reduce(steps: readonly Step[]): WorkflowStateProjection {
	return reduceWorkflowEvents(records(steps));
}

function inputsOf(steps: readonly Step[]): WorkflowEventInput[] {
	return steps.map((step) => ("at" in step ? step.event : step));
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

function checkpointDeclaration(
	commit: MaterializationCommit,
	taskId: WorkflowTaskId,
): MaterializedCheckpointTask {
	const task = declaration(commit, taskId);
	if (task.spec.kind !== "checkpoint") throw new Error("not a checkpoint");
	return task as MaterializedCheckpointTask;
}

function declared(task: MaterializedWorkflowTask): WorkflowEventInput {
	return { type: "task-declared", data: { task: structuredClone(task) } };
}

function barrier(
	kind: "result" | "results" | "settled" | "final",
	taskIds: readonly WorkflowTaskId[],
	epoch = 1,
): WorkflowEventInput {
	return {
		type: "barrier-reached",
		data: { epoch, kind, taskIds: [...taskIds] },
	};
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
	state: WorkflowStateProjection,
): WorkflowEventInput {
	const closure = invalidationClosure(state, causeTaskId);
	return {
		type: "task-invalidated",
		data: {
			causeTaskId,
			taskIds: [...closure.taskIds],
			abandonedEpochs: [...closure.abandonedEpochs],
			reason: "re-execute",
		},
	};
}

function ref(task: { readonly id: WorkflowTaskId }): TaskRef {
	return { runId: RUN_ID, taskId: task.id };
}

function resultRef(task: {
	readonly id: WorkflowTaskId;
}): WorkflowArtifactHandleRef {
	return { runId: RUN_ID, producerTaskId: task.id, output: "result" };
}

function handoffRef(task: {
	readonly id: WorkflowTaskId;
}): WorkflowArtifactHandleRef {
	return { runId: RUN_ID, producerTaskId: task.id, output: "handoff" };
}

// --- Checkpoint declarations (spec 2.1, 2.5) --------------------------------

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, child]) => [key, canonicalValue(child)]),
	);
}

/** Spec 2.5: the exported derivation, with `deriveSupportTaskIdentity`'s body. */
function checkpointIdentity(
	spec: Omit<CheckpointTaskSpec, "identitySha256">,
	namespace: readonly string[] = [],
): string {
	return deriveCheckpointTaskIdentity({
		definitionIdentitySha256,
		inputSha256,
		namespace,
		spec,
	});
}

/** The spec 2.5 derivation spelled out: sha256 over sorted-key canonical JSON. */
function expectedCheckpointIdentity(
	spec: Omit<CheckpointTaskSpec, "identitySha256">,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify(
				canonicalValue({
					contractRevision: WORKFLOW_CONTRACT_REVISION,
					definitionIdentitySha256,
					inputSha256,
					namespace: [],
					...spec,
				}),
			),
		)
		.digest("hex");
}

interface RequestOptions {
	readonly headless?: CheckpointHeadlessPolicy;
	readonly default?: unknown;
	/** `null` drops `timeoutMs`; omitted keeps the one-hour default. */
	readonly timeoutMs?: number | null;
}

function checkpointRequest(
	options: RequestOptions = {},
): CheckpointTaskRequest {
	const timeoutMs =
		options.timeoutMs === undefined ? TIMEOUT_MS : options.timeoutMs;
	return {
		schema: decisionSchema,
		prompt: PROMPT,
		headless: options.headless ?? "block",
		...(options.default === undefined ? {} : { default: options.default }),
		...(timeoutMs === null ? {} : { timeoutMs }),
	};
}

interface CheckpointOptions {
	readonly key?: string;
	readonly role?: TaskRole;
	readonly disposition?: TaskDisposition;
	readonly after?: readonly TaskRef[];
	readonly inputs?: Readonly<Record<string, WorkflowArtifactHandleRef>>;
	readonly request?: RequestOptions;
	readonly identitySha256?: string;
}

/** A hand-built checkpoint declaration at the given epoch-1 position. */
function checkpointTask(
	position: number,
	options: CheckpointOptions = {},
): MaterializedCheckpointTask {
	const key = options.key ?? "approve";
	const namespace: string[] = [];
	const after = [...(options.after ?? [])].sort((left, right) =>
		left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0,
	);
	const spec: Omit<CheckpointTaskSpec, "identitySha256"> = {
		key,
		kind: "checkpoint",
		role: options.role ?? "task",
		disposition: options.disposition ?? "required",
		after,
		inputs: { ...(options.inputs ?? {}) },
		replay: "read-only",
		request: checkpointRequest(options.request),
	};
	const task: MaterializedCheckpointTask = {
		id: deriveWorkflowTaskId(RUN_ID, namespace, key),
		runId: RUN_ID,
		namespace,
		spec: {
			...spec,
			identitySha256:
				options.identitySha256 ?? checkpointIdentity(spec, namespace),
		},
		definitionIdentitySha256,
		materializationSequence: position,
		materializationEpoch: 1,
		epochPosition: position,
	};
	if (!Value.Check(MaterializedCheckpointTaskSchema, task)) {
		throw new Error("test fixture is not a valid materialized checkpoint");
	}
	return task;
}

function checkpointExecution(
	task: MaterializedCheckpointTask,
	generation = 1,
): CheckpointTaskExecutionRecord {
	return {
		kind: "checkpoint",
		id: deriveTaskExecutionId(RUN_ID, task.id, generation),
		runId: RUN_ID,
		taskId: task.id,
		generation,
		taskIdentitySha256: task.spec.identitySha256,
	};
}

function executionCreated(execution: {
	readonly kind: string;
}): WorkflowEventInput {
	return {
		type: "task-execution-created",
		data: { execution: execution as CheckpointTaskExecutionRecord },
	};
}

// --- Agent ladders (revision 17 shapes) ----------------------------------------

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

function childIds(execution: AgentTaskExecutionRecord): {
	subagentRunId: string;
	subagentAttemptId: string;
} {
	const stem = `${execution.taskId.slice(5, 13)}g${execution.generation}`;
	return { subagentRunId: `run_${stem}`, subagentAttemptId: `attempt_${stem}` };
}

function preflighted(
	execution: AgentTaskExecutionRecord,
	workspaceMode: "read-only" | "worktree",
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
		},
	};
}

function launchLadder(
	execution: AgentTaskExecutionRecord,
	workspaceMode: "read-only" | "worktree",
): WorkflowEventInput[] {
	const child = childIds(execution);
	return [
		preflighted(execution, workspaceMode),
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
	];
}

const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: 0.01,
};

function handoffEvidence(
	execution: AgentTaskExecutionRecord,
): SubagentHandoffEvidence {
	return {
		attemptId: childIds(execution).subagentAttemptId,
		baselineHead: BASELINE_HEAD,
		handoffCommit: HANDOFF_COMMIT,
	};
}

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

function resultArtifact(
	taskId: WorkflowTaskId,
	producerExecutionId: string,
): WorkflowArtifactRef {
	const input = {
		runId: RUN_ID,
		producerTaskId: taskId,
		producerExecutionId,
		output: "result" as const,
		sha256: structuredOutputSha256,
		schemaSha256: deriveJsonValueSha256(outputSchema),
	};
	return {
		id: deriveWorkflowArtifactId(input),
		...input,
		bytes: 18,
		mediaType: "application/json",
	};
}

function handoffArtifact(
	taskId: WorkflowTaskId,
	producerExecutionId: string,
): WorkflowArtifactRef {
	const input = {
		runId: RUN_ID,
		producerTaskId: taskId,
		producerExecutionId,
		output: "handoff" as const,
		sha256: handoffSha256,
		schemaSha256: WORKFLOW_HANDOFF_FORMAT_SHA256,
	};
	return {
		id: deriveWorkflowArtifactId(input),
		...input,
		bytes: HANDOFF_BYTES,
		mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
	};
}

function artifactDeclared(artifact: WorkflowArtifactRef): WorkflowEventInput {
	return { type: "artifact-declared", data: { artifact } };
}

function terminal(
	executionId: string,
	outcome: "completed" | "failed" | "cancelled",
	evidence: SubagentTerminalEvidence | CheckpointTerminalEvidence,
): WorkflowEventInput {
	return {
		type: "task-execution-terminal",
		data: { executionId, outcome, evidence },
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
}

/** Launch through settlement, result import, release, terminal, completed. */
function agentSuccessLadder(graph: AgentGraph): WorkflowEventInput[] {
	const { task, execution } = graph;
	const worktree = task.spec.request.workspace.mode === "worktree";
	const child = childIds(execution);
	const evidence = completedEvidence(
		worktree ? handoffEvidence(execution) : undefined,
	);
	const output = resultArtifact(task.id, execution.id);
	const patch = handoffArtifact(task.id, execution.id);
	return [
		...launchLadder(execution, worktree ? "worktree" : "read-only"),
		{
			type: "task-execution-child-observed",
			data: {
				executionId: execution.id,
				subagentRunId: child.subagentRunId,
				subagentAttemptId: child.subagentAttemptId,
				status: "completed",
			},
		},
		{
			type: "task-execution-child-settled",
			data: { executionId: execution.id, evidence },
		},
		artifactDeclared(output),
		{
			type: "task-execution-artifact-imported",
			data: {
				executionId: execution.id,
				subagentRunId: child.subagentRunId,
				artifactId: output.id,
				sourceResultSha256: resultSha256,
			},
		},
		...(worktree
			? [
					artifactDeclared(patch),
					{
						type: "task-execution-handoff-imported",
						data: {
							executionId: execution.id,
							subagentRunId: child.subagentRunId,
							subagentAttemptId: child.subagentAttemptId,
							artifactId: patch.id,
							handoffCommit: HANDOFF_COMMIT,
							baselineHead: BASELINE_HEAD,
							sha256: patch.sha256,
							bytes: patch.bytes,
						},
					} satisfies WorkflowEventInput,
				]
			: []),
		{
			type: "task-execution-release-intended",
			data: { executionId: execution.id, subagentRunId: child.subagentRunId },
		},
		{
			type: "task-execution-released",
			data: {
				executionId: execution.id,
				subagentRunId: child.subagentRunId,
				status: "completed",
			},
		},
		terminal(execution.id, "completed", evidence),
		taskStatus(task.id, "running", "completed"),
	];
}

// --- Checkpoint events and ladders (spec 2.2, section 3) -------------------------

function requested(
	execution: CheckpointTaskExecutionRecord,
	inputsSha256: string,
	expiresAt?: string,
): WorkflowEventInput {
	return {
		type: "task-execution-checkpoint-requested",
		data: {
			executionId: execution.id,
			inputsSha256,
			...(expiresAt === undefined ? {} : { expiresAt }),
		},
	};
}

/** Spec 2.7 step 3: a `putJson`-style result artifact carrying the decision. */
function decisionArtifact(
	task: MaterializedCheckpointTask,
	execution: { readonly id: string },
	value: unknown = DECISION,
	overrides: Partial<
		Pick<WorkflowArtifactRef, "mediaType" | "schemaSha256" | "sha256">
	> = {},
): WorkflowArtifactRef {
	const canonical = JSON.stringify(canonicalValue(value));
	const input = {
		runId: RUN_ID,
		producerTaskId: task.id,
		producerExecutionId: execution.id,
		output: "result" as const,
		sha256: overrides.sha256 ?? deriveJsonValueSha256(value),
		schemaSha256: overrides.schemaSha256 ?? DECISION_SCHEMA_SHA256,
	};
	return {
		id: deriveWorkflowArtifactId(input),
		...input,
		bytes: Buffer.byteLength(canonical),
		mediaType: overrides.mediaType ?? "application/json",
	};
}

interface DecisionOptions {
	readonly source?: "operator" | "default";
	/** `null` omits the approver; omitted names the default operator. */
	readonly decidedBy?: string | null;
	readonly reason?: string;
	readonly decisionSha256?: string;
	readonly artifactId?: string;
	/** The decision record's own time; defaults to `T0` (the request time). */
	readonly decidedAt?: string;
}

function decidedBy(options: DecisionOptions): { decidedBy?: string } {
	const source = options.source ?? "operator";
	if (options.decidedBy === null) return {};
	if (options.decidedBy !== undefined) return { decidedBy: options.decidedBy };
	return source === "operator" ? { decidedBy: APPROVER } : {};
}

function decided(
	execution: { readonly id: string },
	artifact: WorkflowArtifactRef,
	options: DecisionOptions = {},
): WorkflowEventInput {
	return {
		type: "task-execution-checkpoint-decided",
		data: {
			executionId: execution.id,
			artifactId: options.artifactId ?? artifact.id,
			decisionSha256: options.decisionSha256 ?? artifact.sha256,
			source: options.source ?? "operator",
			decidedAt: options.decidedAt ?? T0,
			...decidedBy(options),
			...(options.reason === undefined ? {} : { reason: options.reason }),
		},
	};
}

function checkpointEvidence(
	artifact: WorkflowArtifactRef,
	options: DecisionOptions = {},
): CheckpointTerminalEvidence {
	return {
		kind: "checkpoint",
		artifactId: options.artifactId ?? artifact.id,
		decisionSha256: options.decisionSha256 ?? artifact.sha256,
		source: options.source ?? "operator",
		...decidedBy(options),
	};
}

interface CheckpointGraph {
	readonly task: MaterializedCheckpointTask;
	readonly execution: CheckpointTaskExecutionRecord;
	readonly inputsSha256: string;
	/** From `run-created` through the checkpoint's `task-execution-created`. */
	readonly events: Step[];
}

/** Section 3 "decided by operator" prefix: request, `ready -> waiting`, run parks. */
function requestLadder(
	graph: CheckpointGraph,
	options: {
		readonly expiresAt?: string | null;
		readonly parkRun?: boolean;
	} = {},
): WorkflowEventInput[] {
	const expiresAt =
		options.expiresAt === undefined ? EXPIRES_AT : options.expiresAt;
	return [
		requested(
			graph.execution,
			graph.inputsSha256,
			expiresAt === null ? undefined : expiresAt,
		),
		taskStatus(graph.task.id, "ready", "waiting", AWAITS_REASON),
		...(options.parkRun === false
			? []
			: [runStatus("running", "waiting", RUN_AWAITS_REASON)]),
	];
}

/** Section 3: artifact, decision, terminal, `waiting -> completed`. */
function decideLadder(
	graph: CheckpointGraph,
	options: DecisionOptions & { readonly value?: unknown } = {},
): WorkflowEventInput[] {
	const artifact = decisionArtifact(
		graph.task,
		graph.execution,
		options.value ?? DECISION,
	);
	return [
		artifactDeclared(artifact),
		decided(graph.execution, artifact, options),
		terminal(
			graph.execution.id,
			"completed",
			checkpointEvidence(artifact, options),
		),
		taskStatus(graph.task.id, "waiting", "completed", DECIDED_REASON),
	];
}

/** Section 3 stop / run-failure prefix: terminal cancelled at stage stop. */
function cancelLadder(
	graph: CheckpointGraph,
	from: "ready" | "waiting",
	reason: string,
): WorkflowEventInput[] {
	return [
		workflowTerminal(graph.execution.id, "cancelled", "stop", reason),
		taskStatus(graph.task.id, from, "cancelled", reason),
	];
}

/** One checkpoint alone under an epoch-1 barrier, ready with generation 1 created. */
function soloCheckpoint(
	options: CheckpointOptions & {
		readonly barrier?: "result" | "final";
	} = {},
): CheckpointGraph {
	const task = checkpointTask(1, options);
	const execution = checkpointExecution(task);
	return {
		task,
		execution,
		inputsSha256: deriveJsonValueSha256({}),
		events: [
			runCreated(),
			declared(task),
			barrier(options.barrier ?? "final", [task.id]),
			runStatus("created", "running"),
			taskStatus(task.id, "pending", "ready"),
			executionCreated(execution),
		],
	};
}

/** Section 3 authoring through the materializer: `plan` feeding `approve`'s inputs. */
function gatedCheckpoint(): CheckpointGraph & {
	readonly plan: AgentGraph;
	readonly planArtifact: WorkflowArtifactRef;
	readonly commit: MaterializationCommit;
} {
	const m = materializer();
	const handle = m.agent("plan", readOnlyRequest("Plan"));
	const approve = m.checkpoint("approve", {
		schema: decisionTypebox,
		prompt: PROMPT,
		headless: "block",
		timeoutMs: TIMEOUT_MS,
		inputs: { plan: handle.output },
	});
	const commit = m.closeEpoch("final", [handle, approve]);
	const planTask = agentDeclaration(commit, handle.ref.taskId);
	const plan: AgentGraph = {
		task: planTask,
		execution: agentExecution(planTask, 1),
	};
	const task = checkpointDeclaration(commit, approve.ref.taskId);
	const execution = checkpointExecution(task);
	return {
		task,
		execution,
		plan,
		commit,
		planArtifact: resultArtifact(planTask.id, plan.execution.id),
		inputsSha256: deriveJsonValueSha256({ plan: structuredOutputSha256 }),
		events: [
			runCreated(),
			...commit.events,
			runStatus("created", "running"),
			taskStatus(planTask.id, "pending", "ready"),
			executionCreated(plan.execution),
			...agentSuccessLadder(plan),
			taskStatus(task.id, "pending", "ready"),
			executionCreated(execution),
		],
	};
}

/** Section 3 authoring: `review` approving the worktree `write` task's handoff. */
function handoffCheckpoint(): CheckpointGraph & {
	readonly writer: AgentGraph;
	readonly patch: WorkflowArtifactRef;
} {
	const m = materializer();
	const handle = m.agent("write", worktreeRequest("Write"));
	if (!handle.handoff) throw new Error("worktree handle lacks a handoff");
	const review = m.checkpoint("review", {
		schema: decisionTypebox,
		prompt: PROMPT,
		headless: "block",
		timeoutMs: TIMEOUT_MS,
		inputs: { handoff: handle.handoff },
	});
	const commit = m.closeEpoch("final", [handle, review]);
	const writerTask = agentDeclaration(commit, handle.ref.taskId);
	const writer: AgentGraph = {
		task: writerTask,
		execution: agentExecution(writerTask, 1),
	};
	const task = checkpointDeclaration(commit, review.ref.taskId);
	const execution = checkpointExecution(task);
	return {
		task,
		execution,
		writer,
		patch: handoffArtifact(writerTask.id, writer.execution.id),
		inputsSha256: deriveJsonValueSha256({ handoff: handoffSha256 }),
		events: [
			runCreated(),
			...commit.events,
			runStatus("created", "running"),
			taskStatus(writerTask.id, "pending", "ready"),
			executionCreated(writer.execution),
			...agentSuccessLadder(writer),
			taskStatus(task.id, "pending", "ready"),
			executionCreated(execution),
		],
	};
}

/** One read-only agent task alone under a final barrier, ready with generation 1 created. */
function agentOnly(): AgentGraph & { readonly events: WorkflowEventInput[] } {
	const m = materializer();
	const handle = m.agent("reader", readOnlyRequest("Read"));
	const commit = m.closeEpoch("final", [handle]);
	const task = agentDeclaration(commit, handle.ref.taskId);
	const execution = agentExecution(task, 1);
	return {
		task,
		execution,
		events: [
			runCreated(),
			...commit.events,
			runStatus("created", "running"),
			taskStatus(task.id, "pending", "ready"),
			executionCreated(execution),
		],
	};
}

function projectionOf(
	state: WorkflowStateProjection,
	execution: { readonly id: string },
): TaskExecutionProjection {
	const projection = state.executions[execution.id];
	if (!projection) throw new Error("missing execution projection");
	return projection;
}

describe("revision 18 checkpoint task-declared", () => {
	it("materializes a checkpoint exactly as spec 2.1 lays it out, with the spec 2.5 identity", () => {
		const gated = gatedCheckpoint();
		const handBuilt = checkpointTask(2, {
			after: [ref(gated.plan.task)],
			inputs: { plan: resultRef(gated.plan.task) },
		});
		expect(gated.task).toStrictEqual(handBuilt);
		const { identitySha256, ...specWithoutIdentity } = handBuilt.spec;
		expect(gated.task.spec.identitySha256).toBe(identitySha256);
		expect(identitySha256).toBe(
			expectedCheckpointIdentity(specWithoutIdentity),
		);
		expect(gated.task.spec.request).toStrictEqual({
			schema: decisionSchema,
			prompt: PROMPT,
			headless: "block",
			timeoutMs: TIMEOUT_MS,
		});
		const reviewed = handoffCheckpoint();
		expect(reviewed.task).toStrictEqual(
			checkpointTask(2, {
				key: "review",
				after: [ref(reviewed.writer.task)],
				inputs: { handoff: handoffRef(reviewed.writer.task) },
			}),
		);
	});

	it("accepts a checkpoint whose identity follows the checkpoint derivation and rejects a tampered digest", () => {
		const task = checkpointTask(1);
		const state = reduce([
			runCreated(),
			declared(task),
			barrier("final", [task.id]),
		]);
		expect(state.tasks[task.id]).toStrictEqual({
			task,
			status: "pending",
			committed: true,
		});
		const tampered = checkpointTask(1, { identitySha256: "9".repeat(64) });
		expect(() => reduce([runCreated(), declared(tampered)])).toThrow(
			"declared task identity digest does not match",
		);
	});

	it("rejects a checkpoint declared with the finalizer role", () => {
		const task = checkpointTask(1, { role: "finalizer" });
		expect(() => reduce([runCreated(), declared(task)])).toThrow(
			"a checkpoint cannot be a finalizer",
		);
	});

	it("rejects a use-explicit-default checkpoint without a default", () => {
		const task = checkpointTask(1, {
			request: { headless: "use-explicit-default" },
		});
		expect(() => reduce([runCreated(), declared(task)])).toThrow(
			"checkpoint headless default requires an explicit default",
		);
		const withDefault = checkpointTask(1, {
			request: { headless: "use-explicit-default", default: DEFAULT_DECISION },
		});
		expect(
			reduce([runCreated(), declared(withDefault)]).tasks[withDefault.id]
				?.status,
		).toBe("pending");
	});

	it("accepts a checkpoint depending on an ordinary task's result and on a worktree handoff", () => {
		const gated = gatedCheckpoint();
		const gatedState = reduce(gated.events);
		expect(gatedState.tasks[gated.task.id]?.committed).toBe(true);
		expect(gatedState.tasks[gated.task.id]?.status).toBe("ready");
		expect(gated.task.spec.after).toStrictEqual([ref(gated.plan.task)]);
		const reviewed = handoffCheckpoint();
		const reviewedState = reduce(reviewed.events);
		expect(reviewedState.tasks[reviewed.task.id]?.status).toBe("ready");
		expect(reviewed.task.spec.inputs).toStrictEqual({
			handoff: handoffRef(reviewed.writer.task),
		});
	});

	it("still rejects a checkpoint naming the handoff of a read-only task", () => {
		const m = materializer();
		const handle = m.agent("plan", readOnlyRequest("Plan"));
		const commit = m.closeEpoch("final", [handle]);
		const planTask = agentDeclaration(commit, handle.ref.taskId);
		const task = checkpointTask(2, {
			after: [ref(planTask)],
			inputs: { handoff: handoffRef(planTask) },
		});
		expect(() =>
			reduce([runCreated(), declared(planTask), declared(task)]),
		).toThrow("task input names a handoff of a non-worktree task");
	});
});

describe("revision 18 checkpoint task-execution-created", () => {
	it("rejects a non-checkpoint execution record on a checkpoint task", () => {
		const graph = soloCheckpoint();
		const prefix = graph.events.slice(0, -1);
		const support = {
			kind: "support",
			id: graph.execution.id,
			runId: RUN_ID,
			taskId: graph.task.id,
			generation: 1,
			taskIdentitySha256: graph.task.spec.identitySha256,
			implementationIdentitySha256: "7".repeat(64),
		};
		expect(() => reduce([...prefix, executionCreated(support)])).toThrow(
			"task execution kind does not match its task",
		);
		const agent = {
			...agentExecution(graph.task, 1),
		};
		expect(() => reduce([...prefix, executionCreated(agent)])).toThrow(
			"task execution kind does not match its task",
		);
	});

	it("accepts a checkpoint execution record and makes it current at phase created", () => {
		const graph = soloCheckpoint();
		const state = reduce(graph.events);
		expect(state.tasks[graph.task.id]?.currentExecutionId).toBe(
			graph.execution.id,
		);
		expect(projectionOf(state, graph.execution)).toStrictEqual({
			execution: graph.execution,
			phase: "created",
			createdSequence: graph.events.length,
		});
	});
});

describe("revision 18 checkpoint-requested", () => {
	it("rejects a second request and a request after terminal as out of order", () => {
		const graph = soloCheckpoint();
		expect(() =>
			reduce([
				...graph.events,
				requested(graph.execution, graph.inputsSha256, EXPIRES_AT),
				requested(graph.execution, graph.inputsSha256, EXPIRES_AT),
			]),
		).toThrow("checkpoint request is out of order");
		expect(() =>
			reduce([
				...graph.events,
				workflowTerminal(
					graph.execution.id,
					"failed",
					"checkpoint-input",
					INPUT_REASON,
				),
				requested(graph.execution, graph.inputsSha256, EXPIRES_AT),
			]),
		).toThrow("checkpoint request is out of order");
	});

	it("rejects a request while the run is stopping", () => {
		const graph = soloCheckpoint();
		expect(() =>
			reduce([
				...graph.events,
				runStatus("running", "stopping", "Operator requested stop."),
				requested(graph.execution, graph.inputsSha256, EXPIRES_AT),
			]),
		).toThrow("checkpoint request requires a running workflow run");
	});

	it("rejects a request whose inputs digest does not match the current input artifacts", () => {
		const graph = gatedCheckpoint();
		expect(() =>
			reduce([
				...graph.events,
				requested(graph.execution, deriveJsonValueSha256({}), EXPIRES_AT),
			]),
		).toThrow("checkpoint request does not match its task");
		expect(() =>
			reduce([
				...graph.events,
				requested(
					graph.execution,
					deriveJsonValueSha256({ plan: handoffSha256 }),
					EXPIRES_AT,
				),
			]),
		).toThrow("checkpoint request does not match its task");
		const state = reduce([
			...graph.events,
			requested(graph.execution, graph.inputsSha256, EXPIRES_AT),
		]);
		expect(projectionOf(state, graph.execution).phase).toBe(
			"checkpoint-requested",
		);
	});

	it("rejects a request whose handoff input digest does not match the handoff artifact", () => {
		const graph = handoffCheckpoint();
		expect(() =>
			reduce([
				...graph.events,
				requested(
					graph.execution,
					deriveJsonValueSha256({ handoff: structuredOutputSha256 }),
					EXPIRES_AT,
				),
			]),
		).toThrow("checkpoint request does not match its task");
		const state = reduce([
			...graph.events,
			requested(graph.execution, graph.inputsSha256, EXPIRES_AT),
		]);
		expect(
			projectionOf(state, graph.execution).checkpointRequest?.inputsSha256,
		).toBe(graph.inputsSha256);
	});

	it("rejects an expiry present without timeoutMs", () => {
		const graph = soloCheckpoint({ request: { timeoutMs: null } });
		expect(() =>
			reduce([
				...graph.events,
				requested(graph.execution, graph.inputsSha256, EXPIRES_AT),
			]),
		).toThrow("checkpoint request expiry is invalid");
	});

	it("rejects a missing expiry when timeoutMs is set", () => {
		const graph = soloCheckpoint();
		expect(() =>
			reduce([...graph.events, requested(graph.execution, graph.inputsSha256)]),
		).toThrow("checkpoint request expiry is invalid");
	});

	it("rejects an expiry later than the event timestamp plus timeoutMs", () => {
		const graph = soloCheckpoint();
		expect(() =>
			reduce([
				...graph.events,
				requested(graph.execution, graph.inputsSha256, AFTER_EXPIRY),
			]),
		).toThrow("checkpoint request expiry is invalid");
		// The bound follows the request event's own timestamp, not T0.
		const state = reduce([
			...graph.events,
			at(
				BEFORE_EXPIRY,
				requested(graph.execution, graph.inputsSha256, AFTER_EXPIRY),
			),
		]);
		expect(
			projectionOf(state, graph.execution).checkpointRequest?.expiresAt,
		).toBe(AFTER_EXPIRY);
	});

	it("rejects an expiry that is not a finite instant", () => {
		const graph = soloCheckpoint({
			request: { timeoutMs: 365 * 24 * 3_600_000 },
		});
		expect(() =>
			reduce([
				...graph.events,
				requested(graph.execution, graph.inputsSha256, NON_FINITE_EXPIRY),
			]),
		).toThrow("checkpoint request expiry is invalid");
	});

	it("projects the request with requestedAt copied from the event timestamp", () => {
		const graph = soloCheckpoint();
		const state = reduce([
			...graph.events,
			at(
				BEFORE_EXPIRY,
				requested(graph.execution, graph.inputsSha256, EXPIRES_AT),
			),
		]);
		const projection = projectionOf(state, graph.execution);
		expect(projection.phase).toBe("checkpoint-requested");
		expect(projection.checkpointRequest).toStrictEqual({
			inputsSha256: graph.inputsSha256,
			expiresAt: EXPIRES_AT,
			requestedAt: BEFORE_EXPIRY,
			sequence: graph.events.length + 1,
		});
		const unbounded = soloCheckpoint({ request: { timeoutMs: null } });
		const unboundedState = reduce([
			...unbounded.events,
			requested(unbounded.execution, unbounded.inputsSha256),
		]);
		expect(
			projectionOf(unboundedState, unbounded.execution).checkpointRequest,
		).toStrictEqual({
			inputsSha256: unbounded.inputsSha256,
			requestedAt: T0,
			sequence: unbounded.events.length + 1,
		});
	});
});

describe("revision 18 checkpoint-decided", () => {
	it("rejects a decision before the request as out of order", () => {
		const graph = soloCheckpoint();
		const artifact = decisionArtifact(graph.task, graph.execution);
		expect(() =>
			reduce([
				...graph.events,
				artifactDeclared(artifact),
				decided(graph.execution, artifact),
			]),
		).toThrow("checkpoint decision is out of order");
	});

	it("rejects a decision while the run is stopping", () => {
		// `finalizing` is unreachable with an open checkpoint: a requested
		// checkpoint is ready or waiting, which blocks `-> finalizing`.
		const graph = soloCheckpoint();
		const artifact = decisionArtifact(graph.task, graph.execution);
		expect(() =>
			reduce([
				...graph.events,
				...requestLadder(graph),
				runStatus("waiting", "stopping", "Operator requested stop."),
				artifactDeclared(artifact),
				decided(graph.execution, artifact),
			]),
		).toThrow("checkpoint decision requires a running workflow run");
	});

	it("rejects a decision naming an artifact absent from the run", () => {
		const graph = soloCheckpoint();
		const artifact = decisionArtifact(graph.task, graph.execution);
		expect(() =>
			reduce([
				...graph.events,
				...requestLadder(graph),
				decided(graph.execution, artifact),
			]),
		).toThrow("checkpoint decision artifact does not match");
	});

	it("rejects a decision artifact produced by another task", () => {
		const graph = gatedCheckpoint();
		expect(() =>
			reduce([
				...graph.events,
				...requestLadder(graph),
				decided(graph.execution, graph.planArtifact, {
					decisionSha256: graph.planArtifact.sha256,
				}),
			]),
		).toThrow("checkpoint decision artifact does not match");
	});

	it("rejects a decision artifact produced by a superseded execution", () => {
		const graph = soloCheckpoint();
		const first = decisionArtifact(graph.task, graph.execution);
		const completed: Step[] = [
			...graph.events,
			...requestLadder(graph, { parkRun: false }),
			...decideLadder(graph),
		];
		const second = checkpointExecution(graph.task, 2);
		const rematerialized: Step[] = [
			...completed,
			invalidated(graph.task.id, reduce(completed)),
			taskStatus(graph.task.id, "invalidated", "pending"),
			taskStatus(graph.task.id, "pending", "ready"),
			executionCreated(second),
			requested(second, graph.inputsSha256, EXPIRES_AT),
		];
		expect(() => reduce([...rematerialized, decided(second, first)])).toThrow(
			"checkpoint decision artifact does not match",
		);
		const fresh = decisionArtifact(graph.task, second);
		const state = reduce([
			...rematerialized,
			artifactDeclared(fresh),
			decided(second, fresh),
		]);
		expect(projectionOf(state, second).phase).toBe("checkpoint-decided");
	});

	it("rejects a handoff artifact as a decision", () => {
		const graph = handoffCheckpoint();
		expect(() =>
			reduce([
				...graph.events,
				...requestLadder(graph),
				decided(graph.execution, graph.patch, {
					decisionSha256: graph.patch.sha256,
				}),
			]),
		).toThrow("checkpoint decision artifact does not match");
	});

	it("rejects a decision artifact whose media type is not JSON", () => {
		const graph = soloCheckpoint();
		const artifact = decisionArtifact(graph.task, graph.execution, DECISION, {
			mediaType: "text/plain",
		});
		expect(() =>
			reduce([
				...graph.events,
				...requestLadder(graph),
				artifactDeclared(artifact),
				decided(graph.execution, artifact),
			]),
		).toThrow("checkpoint decision artifact does not match");
	});

	it("rejects a decision digest that differs from the artifact digest", () => {
		const graph = soloCheckpoint();
		const artifact = decisionArtifact(graph.task, graph.execution);
		expect(() =>
			reduce([
				...graph.events,
				...requestLadder(graph),
				artifactDeclared(artifact),
				decided(graph.execution, artifact, { decisionSha256: DEFAULT_SHA256 }),
			]),
		).toThrow("checkpoint decision artifact does not match");
	});

	it("rejects a decision artifact bound to another schema", () => {
		const graph = soloCheckpoint();
		const artifact = decisionArtifact(graph.task, graph.execution, DECISION, {
			schemaSha256: deriveJsonValueSha256(outputSchema),
		});
		expect(() =>
			reduce([
				...graph.events,
				...requestLadder(graph),
				artifactDeclared(artifact),
				decided(graph.execution, artifact),
			]),
		).toThrow("checkpoint decision artifact does not match");
	});

	it("rejects a default decision on a block checkpoint", () => {
		const graph = soloCheckpoint();
		const artifact = decisionArtifact(graph.task, graph.execution);
		expect(() =>
			reduce([
				...graph.events,
				...requestLadder(graph),
				artifactDeclared(artifact),
				decided(graph.execution, artifact, { source: "default" }),
			]),
		).toThrow("checkpoint default decision requires the headless default");
	});

	it("rejects a default decision whose digest is not the declared default", () => {
		const graph = soloCheckpoint({
			request: { headless: "use-explicit-default", default: DEFAULT_DECISION },
		});
		const other = decisionArtifact(graph.task, graph.execution, DECISION);
		expect(() =>
			reduce([
				...graph.events,
				...requestLadder(graph),
				artifactDeclared(other),
				decided(graph.execution, other, { source: "default" }),
			]),
		).toThrow("checkpoint default decision requires the headless default");
	});

	it("rejects a default decision that names an approver", () => {
		const graph = soloCheckpoint({
			request: { headless: "use-explicit-default", default: DEFAULT_DECISION },
		});
		const artifact = decisionArtifact(
			graph.task,
			graph.execution,
			DEFAULT_DECISION,
		);
		expect(() =>
			reduce([
				...graph.events,
				...requestLadder(graph),
				artifactDeclared(artifact),
				decided(graph.execution, artifact, {
					source: "default",
					decidedBy: APPROVER,
				}),
			]),
		).toThrow("checkpoint default decision may not name an approver");
	});

	it("accepts a default decision equal to the declared default and proves the digest equality", () => {
		const graph = soloCheckpoint({
			request: { headless: "use-explicit-default", default: DEFAULT_DECISION },
		});
		const artifact = decisionArtifact(
			graph.task,
			graph.execution,
			DEFAULT_DECISION,
		);
		expect(artifact.sha256).toBe(
			deriveJsonValueSha256(graph.task.spec.request.default),
		);
		const state = reduce([
			...graph.events,
			...requestLadder(graph),
			artifactDeclared(artifact),
			decided(graph.execution, artifact, { source: "default" }),
		]);
		expect(
			projectionOf(state, graph.execution).checkpointDecision,
		).toStrictEqual({
			artifactId: artifact.id,
			decisionSha256: DEFAULT_SHA256,
			source: "default",
			decidedAt: T0,
			sequence: graph.events.length + 5,
		});
	});

	it("rejects an operator decision without an approver", () => {
		const graph = soloCheckpoint();
		const artifact = decisionArtifact(graph.task, graph.execution);
		expect(() =>
			reduce([
				...graph.events,
				...requestLadder(graph),
				artifactDeclared(artifact),
				decided(graph.execution, artifact, { decidedBy: null }),
			]),
		).toThrow("checkpoint operator decision requires an approver");
	});

	it("rejects an operator decision whose decidedAt is at or after the expiry and accepts one before it", () => {
		const graph = soloCheckpoint();
		const artifact = decisionArtifact(graph.task, graph.execution);
		const parked: Step[] = [...graph.events, ...requestLadder(graph)];
		expect(() =>
			reduce([
				...parked,
				at(EXPIRES_AT, artifactDeclared(artifact)),
				decided(graph.execution, artifact, { decidedAt: EXPIRES_AT }),
			]),
		).toThrow("checkpoint decision follows its expiry");
		expect(() =>
			reduce([
				...parked,
				at(AFTER_EXPIRY, artifactDeclared(artifact)),
				decided(graph.execution, artifact, { decidedAt: AFTER_EXPIRY }),
			]),
		).toThrow("checkpoint decision follows its expiry");
		const state = reduce([
			...parked,
			at(BEFORE_EXPIRY, artifactDeclared(artifact)),
			decided(graph.execution, artifact, { decidedAt: BEFORE_EXPIRY }),
		]);
		expect(projectionOf(state, graph.execution).phase).toBe(
			"checkpoint-decided",
		);
	});

	it("judges timeliness by the decision time, so a timely record appended after the expiry commits", () => {
		// The operator decided 50 ms before `expiresAt`; the record was fsynced,
		// the watchdog fired at `expiresAt`, and the decided event lands later.
		const graph = soloCheckpoint();
		const artifact = decisionArtifact(graph.task, graph.execution);
		const parked: Step[] = [...graph.events, ...requestLadder(graph)];
		const replayed = reduce([
			...parked,
			at(AFTER_EXPIRY, artifactDeclared(artifact)),
			decided(graph.execution, artifact, { decidedAt: RECORDED_AT }),
		]);
		const projection = projectionOf(replayed, graph.execution);
		expect(projection.phase).toBe("checkpoint-decided");
		expect(projection.checkpointDecision?.decidedAt).toBe(RECORDED_AT);
		// The same record with its own time at the expiry is still rejected.
		expect(() =>
			reduce([
				...parked,
				at(AFTER_EXPIRY, artifactDeclared(artifact)),
				decided(graph.execution, artifact, { decidedAt: EXPIRES_AT }),
			]),
		).toThrow("checkpoint decision follows its expiry");
	});

	it("rejects a decision time that is not finite or later than its event", () => {
		const graph = soloCheckpoint();
		const artifact = decisionArtifact(graph.task, graph.execution);
		const parked: Step[] = [
			...graph.events,
			...requestLadder(graph),
			artifactDeclared(artifact),
		];
		expect(() =>
			reduce([
				...parked,
				decided(graph.execution, artifact, { decidedAt: NON_FINITE_EXPIRY }),
			]),
		).toThrow("checkpoint decision time is invalid");
		expect(() =>
			reduce([
				...parked,
				decided(graph.execution, artifact, { decidedAt: BEFORE_EXPIRY }),
			]),
		).toThrow("checkpoint decision time is invalid");
		const state = reduce([
			...parked,
			at(
				BEFORE_EXPIRY,
				decided(graph.execution, artifact, { decidedAt: BEFORE_EXPIRY }),
			),
		]);
		expect(projectionOf(state, graph.execution).phase).toBe(
			"checkpoint-decided",
		);
	});

	it("projects the decision with decidedAt copied from the event's decision time", () => {
		const graph = soloCheckpoint();
		const artifact = decisionArtifact(graph.task, graph.execution);
		const events: Step[] = [
			...graph.events,
			...requestLadder(graph),
			artifactDeclared(artifact),
			at(
				BEFORE_EXPIRY,
				decided(graph.execution, artifact, {
					reason: "Plan looks right.",
					decidedAt: RECORDED_AT,
				}),
			),
		];
		const projection = projectionOf(reduce(events), graph.execution);
		expect(projection.phase).toBe("checkpoint-decided");
		expect(projection.checkpointDecision).toStrictEqual({
			artifactId: artifact.id,
			decisionSha256: DECISION_SHA256,
			source: "operator",
			decidedBy: APPROVER,
			reason: "Plan looks right.",
			decidedAt: RECORDED_AT,
			sequence: events.length,
		});
		expect(projection.checkpointRequest?.requestedAt).toBe(T0);
	});

	it("makes a second decision impossible: the phase has moved and a second result artifact is ambiguous", () => {
		const graph = soloCheckpoint();
		const artifact = decisionArtifact(graph.task, graph.execution);
		const other = decisionArtifact(
			graph.task,
			graph.execution,
			DEFAULT_DECISION,
		);
		const decidedEvents: Step[] = [
			...graph.events,
			...requestLadder(graph),
			artifactDeclared(artifact),
			decided(graph.execution, artifact),
		];
		expect(() =>
			reduce([...decidedEvents, decided(graph.execution, artifact)]),
		).toThrow("checkpoint decision is out of order");
		expect(() => reduce([...decidedEvents, artifactDeclared(other)])).toThrow(
			"artifact output identity is ambiguous",
		);
	});
});

describe("revision 18 checkpoint terminal evidence", () => {
	it("rejects checkpoint terminal evidence on an agent task", () => {
		const agent = agentOnly();
		const artifact = decisionArtifact(checkpointTask(1), {
			id: agent.execution.id,
		});
		expect(() =>
			reduce([
				...agent.events,
				terminal(agent.execution.id, "completed", checkpointEvidence(artifact)),
			]),
		).toThrow("agent task has checkpoint terminal evidence");
	});

	it("rejects subagent terminal evidence on a checkpoint task", () => {
		const graph = soloCheckpoint();
		expect(() =>
			reduce([
				...graph.events,
				terminal(graph.execution.id, "completed", completedEvidence()),
			]),
		).toThrow("checkpoint task has subagent terminal evidence");
	});

	it("rejects checkpoint terminal evidence before the decision", () => {
		const graph = soloCheckpoint();
		const artifact = decisionArtifact(graph.task, graph.execution);
		expect(() =>
			reduce([
				...graph.events,
				...requestLadder(graph),
				artifactDeclared(artifact),
				terminal(graph.execution.id, "completed", checkpointEvidence(artifact)),
			]),
		).toThrow("checkpoint terminal evidence precedes its decision");
	});

	it("rejects a checkpoint terminal whose outcome is not completed", () => {
		const graph = soloCheckpoint();
		const artifact = decisionArtifact(graph.task, graph.execution);
		expect(() =>
			reduce([
				...graph.events,
				...requestLadder(graph),
				artifactDeclared(artifact),
				decided(graph.execution, artifact),
				terminal(graph.execution.id, "failed", checkpointEvidence(artifact)),
			]),
		).toThrow("checkpoint terminal outcome is not completed");
	});

	it("rejects checkpoint terminal evidence that differs from the decision on any field", () => {
		const graph = soloCheckpoint();
		const artifact = decisionArtifact(graph.task, graph.execution);
		const decidedEvents: Step[] = [
			...graph.events,
			...requestLadder(graph),
			artifactDeclared(artifact),
			decided(graph.execution, artifact),
		];
		const mismatches: DecisionOptions[] = [
			{ artifactId: `artifact_${"3".repeat(64)}` },
			{ decisionSha256: DEFAULT_SHA256 },
			{ source: "default", decidedBy: null },
			{ decidedBy: "someone-else" },
			{ decidedBy: null },
		];
		for (const mismatch of mismatches) {
			expect(() =>
				reduce([
					...decidedEvents,
					terminal(
						graph.execution.id,
						"completed",
						checkpointEvidence(artifact, mismatch),
					),
				]),
			).toThrow("checkpoint terminal decision does not match");
		}
	});

	it("accepts checkpoint terminal evidence matching the decision", () => {
		const graph = soloCheckpoint();
		const artifact = decisionArtifact(graph.task, graph.execution);
		const events: Step[] = [
			...graph.events,
			...requestLadder(graph),
			artifactDeclared(artifact),
			decided(graph.execution, artifact),
			terminal(graph.execution.id, "completed", checkpointEvidence(artifact)),
		];
		const projection = projectionOf(reduce(events), graph.execution);
		expect(projection.phase).toBe("terminal");
		expect(projection.terminal).toStrictEqual({
			outcome: "completed",
			evidence: checkpointEvidence(artifact),
			sequence: events.length,
		});
	});

	it("accepts a checkpoint-input failure at created and rejects it after the request", () => {
		const graph = soloCheckpoint();
		const state = reduce([
			...graph.events,
			workflowTerminal(
				graph.execution.id,
				"failed",
				"checkpoint-input",
				INPUT_REASON,
			),
			taskStatus(graph.task.id, "ready", "failed", INPUT_REASON),
		]);
		expect(state.tasks[graph.task.id]?.status).toBe("failed");
		expect(projectionOf(state, graph.execution).terminal?.outcome).toBe(
			"failed",
		);
		expect(() =>
			reduce([
				...graph.events,
				...requestLadder(graph),
				workflowTerminal(
					graph.execution.id,
					"failed",
					"checkpoint-input",
					INPUT_REASON,
				),
			]),
		).toThrow("workflow terminal evidence is inconsistent");
	});

	it("accepts a checkpoint-expired failure after the request without consulting the clock and rejects it at created", () => {
		const graph = soloCheckpoint();
		// Stamped at T0, well before EXPIRES_AT: the reducer checks phase only.
		const state = reduce([
			...graph.events,
			...requestLadder(graph),
			workflowTerminal(
				graph.execution.id,
				"failed",
				"checkpoint-expired",
				EXPIRED_REASON,
			),
		]);
		expect(projectionOf(state, graph.execution).terminal?.outcome).toBe(
			"failed",
		);
		expect(() =>
			reduce([
				...graph.events,
				workflowTerminal(
					graph.execution.id,
					"failed",
					"checkpoint-expired",
					EXPIRED_REASON,
				),
			]),
		).toThrow("workflow terminal evidence is inconsistent");
	});

	it("accepts a stop cancellation at created and after the request", () => {
		const graph = soloCheckpoint();
		const atCreated = reduce([
			...graph.events,
			...cancelLadder(graph, "ready", STOP_REASON),
		]);
		expect(atCreated.tasks[graph.task.id]?.status).toBe("cancelled");
		const atRequested = reduce([
			...graph.events,
			...requestLadder(graph),
			...cancelLadder(graph, "waiting", RUN_ENDING_REASON),
		]);
		expect(atRequested.tasks[graph.task.id]?.status).toBe("cancelled");
		expect(
			projectionOf(atRequested, graph.execution).terminal?.evidence,
		).toStrictEqual({
			kind: "workflow",
			stage: "stop",
			failureSha256: deriveWorkflowFailureSha256("stop", RUN_ENDING_REASON),
			message: RUN_ENDING_REASON,
		});
	});

	it("rejects a digest that does not match the failure message", () => {
		const graph = soloCheckpoint();
		expect(() =>
			reduce([
				...graph.events,
				{
					type: "task-execution-terminal",
					data: {
						executionId: graph.execution.id,
						outcome: "failed",
						evidence: {
							kind: "workflow",
							stage: "checkpoint-input",
							failureSha256: deriveWorkflowFailureSha256(
								"checkpoint-input",
								"other",
							),
							message: INPUT_REASON,
						},
					},
				},
			]),
		).toThrow("workflow terminal evidence is inconsistent");
	});

	it("rejects handoff-import, support, and nested stages on a checkpoint", () => {
		const graph = soloCheckpoint();
		const stages: readonly FailureStage[] = [
			"handoff-import",
			"support-input",
			"support-execution",
			"nested-input",
			"preflight",
		];
		for (const stage of stages) {
			expect(() =>
				reduce([
					...graph.events,
					workflowTerminal(
						graph.execution.id,
						"failed",
						stage,
						"Not a checkpoint stage.",
					),
				]),
			).toThrow("workflow terminal evidence is inconsistent");
		}
		expect(() =>
			reduce([
				...graph.events,
				workflowTerminal(
					graph.execution.id,
					"cleanup-blocked",
					"handoff-import",
					"Blocked.",
				),
			]),
		).toThrow("workflow terminal evidence is inconsistent");
	});

	it("rejects checkpoint stages on an agent task", () => {
		const agent = agentOnly();
		for (const stage of ["checkpoint-expired", "checkpoint-input"] as const) {
			expect(() =>
				reduce([
					...agent.events,
					workflowTerminal(agent.execution.id, "failed", stage, EXPIRED_REASON),
				]),
			).toThrow("workflow terminal evidence is inconsistent");
		}
	});
});

describe("revision 18 checkpoint task-status-changed", () => {
	it("rejects a checkpoint becoming running", () => {
		const graph = soloCheckpoint();
		expect(() =>
			reduce([...graph.events, taskStatus(graph.task.id, "ready", "running")]),
		).toThrow("checkpoint task may not run");
	});

	it("rejects a checkpoint entering cancelling even while stopping", () => {
		const graph = soloCheckpoint();
		expect(() =>
			reduce([
				...graph.events,
				...requestLadder(graph),
				runStatus("waiting", "stopping", "Operator requested stop."),
				taskStatus(graph.task.id, "waiting", "cancelling"),
			]),
		).toThrow("checkpoint task may not enter cancelling");
	});

	it("rejects a checkpoint becoming interrupted", () => {
		const graph = soloCheckpoint();
		expect(() =>
			reduce([
				...graph.events,
				...requestLadder(graph),
				taskStatus(graph.task.id, "waiting", "interrupted"),
			]),
		).toThrow("checkpoint task may not be interrupted");
	});

	it("rejects a checkpoint becoming cleanup-blocked", () => {
		const graph = soloCheckpoint();
		expect(() =>
			reduce([
				...graph.events,
				...requestLadder(graph),
				taskStatus(graph.task.id, "waiting", "cleanup-blocked"),
			]),
		).toThrow("checkpoint task may not be cleanup-blocked");
	});

	it("rejects waiting before the request is persisted", () => {
		const graph = soloCheckpoint();
		expect(() =>
			reduce([
				...graph.events,
				taskStatus(graph.task.id, "ready", "waiting", AWAITS_REASON),
			]),
		).toThrow("checkpoint task became waiting without a persisted request");
		const declaredOnly = graph.events.slice(0, -1);
		expect(() =>
			reduce([
				...declaredOnly,
				taskStatus(graph.task.id, "ready", "waiting", AWAITS_REASON),
			]),
		).toThrow("checkpoint task became waiting without a persisted request");
	});

	it("accepts waiting once the request is persisted", () => {
		const graph = soloCheckpoint();
		const state = reduce([
			...graph.events,
			requested(graph.execution, graph.inputsSha256, EXPIRES_AT),
			taskStatus(graph.task.id, "ready", "waiting", AWAITS_REASON),
		]);
		expect(state.tasks[graph.task.id]?.status).toBe("waiting");
	});

	it("rejects an agent task cancelled while waiting", () => {
		const agent = agentOnly();
		const waiting: WorkflowEventInput[] = [
			...agent.events,
			...launchLadder(agent.execution, "read-only"),
			taskStatus(agent.task.id, "running", "waiting"),
		];
		expect(reduce(waiting).tasks[agent.task.id]?.status).toBe("waiting");
		expect(() =>
			reduce([...waiting, taskStatus(agent.task.id, "waiting", "cancelled")]),
		).toThrow("only a checkpoint task may be cancelled while waiting");
	});

	it("rejects waiting -> completed without matching terminal evidence", () => {
		const graph = soloCheckpoint();
		expect(() =>
			reduce([
				...graph.events,
				...requestLadder(graph),
				taskStatus(graph.task.id, "waiting", "completed", DECIDED_REASON),
			]),
		).toThrow("task terminal status lacks matching execution evidence");
	});

	it("accepts waiting -> completed after a matching checkpoint terminal", () => {
		const graph = soloCheckpoint();
		const state = reduce([
			...graph.events,
			...requestLadder(graph),
			...decideLadder(graph),
		]);
		expect(state.tasks[graph.task.id]?.status).toBe("completed");
	});

	it("accepts waiting -> failed after an expiry terminal", () => {
		const graph = soloCheckpoint();
		const state = reduce([
			...graph.events,
			...requestLadder(graph),
			workflowTerminal(
				graph.execution.id,
				"failed",
				"checkpoint-expired",
				EXPIRED_REASON,
			),
			taskStatus(graph.task.id, "waiting", "failed", EXPIRED_REASON),
		]);
		expect(state.tasks[graph.task.id]?.status).toBe("failed");
	});
});

describe("revision 18 checkpoint run-status-changed", () => {
	it("rejects run failure, interruption, and cleanup-blocked while a checkpoint is open", () => {
		const graph = soloCheckpoint();
		for (const to of ["failed", "interrupted", "cleanup-blocked"] as const) {
			expect(() =>
				reduce([...graph.events, runStatus("running", to, "Something broke.")]),
			).toThrow("run failure leaves a checkpoint open");
			expect(() =>
				reduce([
					...graph.events,
					...requestLadder(graph),
					runStatus("waiting", to, "Something broke."),
				]),
			).toThrow("run failure leaves a checkpoint open");
		}
	});

	it("rejects run failure while a decided checkpoint awaits its terminal and accepts it once committed", () => {
		const graph = soloCheckpoint();
		const artifact = decisionArtifact(graph.task, graph.execution);
		const decidedOnly: Step[] = [
			...graph.events,
			...requestLadder(graph),
			artifactDeclared(artifact),
			decided(graph.execution, artifact),
		];
		expect(projectionOf(reduce(decidedOnly), graph.execution).phase).toBe(
			"checkpoint-decided",
		);
		for (const to of ["failed", "interrupted", "cleanup-blocked"] as const) {
			expect(() =>
				reduce([...decidedOnly, runStatus("waiting", to, "Something broke.")]),
			).toThrow("run failure leaves a checkpoint open");
		}
		const state = reduce([
			...decidedOnly,
			terminal(graph.execution.id, "completed", checkpointEvidence(artifact)),
			taskStatus(graph.task.id, "waiting", "completed", DECIDED_REASON),
			runStatus(
				"waiting",
				"failed",
				"A required workflow task did not complete.",
			),
		]);
		expect(state.status).toBe("failed");
		expect(state.tasks[graph.task.id]?.status).toBe("completed");
	});

	it("accepts run failure once the open checkpoint was cancelled", () => {
		const graph = soloCheckpoint();
		const state = reduce([
			...graph.events,
			...requestLadder(graph),
			...cancelLadder(graph, "waiting", RUN_ENDING_REASON),
			runStatus(
				"waiting",
				"failed",
				"A required workflow task did not complete.",
			),
		]);
		expect(state.status).toBe("failed");
		expect(state.tasks[graph.task.id]?.status).toBe("cancelled");
		const atCreated = reduce([
			...graph.events,
			...cancelLadder(graph, "ready", RUN_ENDING_REASON),
			runStatus("running", "interrupted", "Seat exited."),
		]);
		expect(atCreated.status).toBe("interrupted");
	});

	it("still blocks finalizing and completion while a checkpoint waits", () => {
		const required = soloCheckpoint();
		expect(() =>
			reduce([
				...required.events,
				...requestLadder(required, { parkRun: false }),
				runStatus("running", "finalizing"),
			]),
		).toThrow("run finalized before its required work completed");
		const optional = soloCheckpoint({ disposition: "optional" });
		expect(() =>
			reduce([
				...optional.events,
				...requestLadder(optional, { parkRun: false }),
				runStatus("running", "finalizing"),
			]),
		).toThrow("run finalized while ordinary tasks remain active");
		expect(() =>
			reduce([
				...required.events,
				...requestLadder(required),
				runStatus("waiting", "completed"),
			]),
		).toThrow("invalid workflow run transition: waiting -> completed");
	});

	it("refuses invalidation while a checkpoint is open and admits it after the cancel ladder", () => {
		const graph = soloCheckpoint();
		const parked: Step[] = [...graph.events, ...requestLadder(graph)];
		expect(() =>
			reduce([...parked, invalidated(graph.task.id, reduce(parked))]),
		).toThrow("workflow run has active task executions");
		const atCreated: Step[] = [...graph.events];
		expect(() =>
			reduce([...atCreated, invalidated(graph.task.id, reduce(atCreated))]),
		).toThrow("workflow run has active task executions");
		const cancelled: Step[] = [
			...parked,
			...cancelLadder(graph, "waiting", STOP_REASON),
		];
		const state = reduce([
			...cancelled,
			invalidated(graph.task.id, reduce(cancelled)),
		]);
		expect(state.tasks[graph.task.id]?.status).toBe("invalidated");
	});

	it("reduces the full decided ladder to a completed checkpoint whose dependents become ready", () => {
		const graph = gatedCheckpoint();
		const review = checkpointTask(3, {
			key: "review",
			after: [ref(graph.task)],
		});
		const events: Step[] = [
			...graph.events.slice(0, 3),
			declared(review),
			barrier("final", [graph.plan.task.id, graph.task.id, review.id]),
			...graph.events.slice(4),
		];
		expect(() =>
			reduce([...events, taskStatus(review.id, "pending", "ready")]),
		).toThrow("task became ready before its dependencies completed");
		const artifact = decisionArtifact(graph.task, graph.execution);
		const ladder: Step[] = [
			...events,
			...requestLadder(graph),
			at(BEFORE_EXPIRY, artifactDeclared(artifact)),
			decided(graph.execution, artifact, { decidedAt: BEFORE_EXPIRY }),
			terminal(graph.execution.id, "completed", checkpointEvidence(artifact)),
			taskStatus(graph.task.id, "waiting", "completed", DECIDED_REASON),
			runStatus("waiting", "running"),
			taskStatus(review.id, "pending", "ready"),
		];
		const state = reduce(ladder);
		expect(state.status).toBe("running");
		expect(state.tasks[graph.task.id]?.status).toBe("completed");
		expect(state.tasks[review.id]?.status).toBe("ready");
		const projection = projectionOf(state, graph.execution);
		expect(projection.phase).toBe("terminal");
		expect(projection.checkpointRequest?.requestedAt).toBe(T0);
		expect(projection.checkpointDecision?.decidedAt).toBe(BEFORE_EXPIRY);
		expect(state.artifacts[artifact.id]).toStrictEqual(artifact);
	});

	it("accepts a checkpoint as a result barrier target", () => {
		const m = materializer();
		const approve = m.checkpoint("approve", {
			schema: decisionTypebox,
			prompt: PROMPT,
			headless: "block",
			timeoutMs: TIMEOUT_MS,
		});
		const commit = m.closeEpoch("result", [approve]);
		const task = checkpointDeclaration(commit, approve.ref.taskId);
		expect(task).toStrictEqual(checkpointTask(1));
		const graph: CheckpointGraph = {
			task,
			execution: checkpointExecution(task),
			inputsSha256: deriveJsonValueSha256({}),
			events: [
				runCreated(),
				...commit.events,
				runStatus("created", "running"),
				taskStatus(task.id, "pending", "ready"),
				executionCreated(checkpointExecution(task)),
			],
		};
		const state = reduce([
			...graph.events,
			...requestLadder(graph),
			...decideLadder(graph),
		]);
		expect(state.barriers).toStrictEqual([
			{ epoch: 1, kind: "result", taskIds: [graph.task.id], sequence: 3 },
		]);
		expect(state.tasks[graph.task.id]?.status).toBe("completed");
	});

	/** Decided, expired, defaulted, and cancelled checkpoints in one epoch. */
	function richEvents(expiresAt: string): Step[] {
		const decidedTask = checkpointTask(1, { key: "approve" });
		const expiredTask = checkpointTask(2, {
			key: "gate",
			disposition: "optional",
		});
		const defaultedTask = checkpointTask(3, {
			key: "fallback",
			request: { headless: "use-explicit-default", default: DEFAULT_DECISION },
		});
		const cancelledTask = checkpointTask(4, {
			key: "abandoned",
			request: { timeoutMs: null },
		});
		const tasks = [decidedTask, expiredTask, defaultedTask, cancelledTask];
		const graphs = tasks.map(
			(task): CheckpointGraph => ({
				task,
				execution: checkpointExecution(task),
				inputsSha256: deriveJsonValueSha256({}),
				events: [],
			}),
		);
		const [decidedGraph, expiredGraph, defaultedGraph, cancelledGraph] =
			graphs as [
				CheckpointGraph,
				CheckpointGraph,
				CheckpointGraph,
				CheckpointGraph,
			];
		return [
			runCreated(),
			...tasks.map(declared),
			barrier(
				"final",
				tasks.map((task) => task.id),
			),
			runStatus("created", "running"),
			...graphs.flatMap((graph) => [
				taskStatus(graph.task.id, "pending", "ready"),
				executionCreated(graph.execution),
			]),
			...requestLadder(decidedGraph, { expiresAt }),
			...requestLadder(expiredGraph, { expiresAt, parkRun: false }),
			...requestLadder(defaultedGraph, { expiresAt, parkRun: false }),
			...requestLadder(cancelledGraph, { expiresAt: null, parkRun: false }),
			...decideLadder(decidedGraph, { reason: "Approved." }),
			workflowTerminal(
				expiredGraph.execution.id,
				"failed",
				"checkpoint-expired",
				EXPIRED_REASON,
			),
			taskStatus(expiredGraph.task.id, "waiting", "failed", EXPIRED_REASON),
			...decideLadder(defaultedGraph, {
				source: "default",
				value: DEFAULT_DECISION,
			}),
			...cancelLadder(cancelledGraph, "waiting", STOP_REASON),
			runStatus("waiting", "running"),
		];
	}

	it("round-trips a rich checkpoint state through JSON, the schema, every prefix, and the journal snapshot", async () => {
		const events = richEvents(EXPIRES_AT);
		const state = reduce(events);
		const statuses = Object.values(state.tasks).map((task) => task.status);
		expect(statuses).toStrictEqual([
			"completed",
			"failed",
			"completed",
			"cancelled",
		]);
		expect(state.status).toBe("running");
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
		// The journal stamps events with the clock, so the expiry is set relative to now.
		const liveEvents = inputsOf(
			richEvents(new Date(Date.now() + TIMEOUT_MS - 60_000).toISOString()),
		);
		const root = await mkdtemp(
			path.join(os.tmpdir(), "pi-workflow-revision-18-"),
		);
		try {
			const lease = await acquireWorkflowRunLease({
				storeRoot: root,
				runId: RUN_ID,
				ownerId: "revision-18",
			});
			try {
				const journal = await WorkflowRunJournal.open(root, RUN_ID, lease);
				for (const event of liveEvents) await journal.appendEvent(event);
				const snapshot = await rebuildWorkflowSnapshot(journal);
				expect(snapshot.state).toStrictEqual(
					reduceWorkflowEvents(await journal.readEvents()),
				);
				expect(await journal.readSnapshot()).toStrictEqual(snapshot);
				expect(
					Object.values(snapshot.state.tasks).map((task) => task.status),
				).toStrictEqual(statuses);
				expect(Value.Check(WorkflowStateProjectionSchema, snapshot.state)).toBe(
					true,
				);
			} finally {
				await lease.release();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});
