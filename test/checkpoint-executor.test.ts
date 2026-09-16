import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { HANDOFF_EXPORT_MEDIA_TYPE } from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowArtifactStore } from "../src/artifact-store.js";
import {
	CHECKPOINT_RUN_ENDING_REASON,
	cancelOpenWorkflowCheckpoints,
	createWorkflowCheckpointTaskExecutor,
	WorkflowCheckpointExecutionError,
	type WorkflowCheckpointTaskExecutor,
} from "../src/checkpoint-executor.js";
import {
	type CheckpointHeadlessPolicy,
	type MaterializedAgentTask,
	type MaterializedCheckpointTask,
	type SubagentTerminalEvidence,
	WORKFLOW_CONTRACT_REVISION,
	WORKFLOW_HANDOFF_FORMAT_SHA256,
	type WorkflowArtifactRef,
	type WorkflowTaskId,
} from "../src/contracts.js";
import {
	type WorkflowDecisionBinding,
	type WorkflowDecisionRecord,
	WorkflowDecisionRecordStore,
} from "../src/decision-store.js";
import type {
	TaskExecutionProjection,
	WorkflowEventInput,
	WorkflowStateProjection,
	WorkflowTaskProjection,
} from "../src/events.js";
import {
	deriveCheckpointEffectSha256,
	deriveJsonValueSha256,
	deriveSubagentOperationId,
	deriveTaskExecutionId,
	deriveWorkflowFailureSha256,
} from "../src/execution.js";
import { WorkflowTaskMaterializer } from "../src/materializer.js";
import { WorkflowRunJournal } from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
	type WorkflowRunLease,
} from "../src/persistence/run-lease.js";
import { reduceWorkflowEvents } from "../src/reducer.js";
import { defineSupportTask } from "../src/support.js";
import { createWorkflowSupportTaskExecutor } from "../src/support-executor.js";

const RUN_ID = "workflow_checkpoint";
const MODULE = "@vegardx/workflow-tools";
const definitionIdentitySha256 = "a".repeat(64);
const inputSha256 = "b".repeat(64);
const leases = new Set<WorkflowRunLease>();

const decisionSchema = Type.Object(
	{ proceed: Type.Boolean(), note: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);
const APPROVE = { proceed: true, note: "ship it" };
const DEFAULT = { proceed: false };
const TIMEOUT_MS = 60_000;

const shout = defineSupportTask({
	name: `${MODULE}/shout`,
	moduleSpecifier: MODULE,
	revision: 1,
	implementationSha256: "c".repeat(64),
	parametersSchema: Type.Object({ value: Type.String() }),
	outputSchema: Type.Object({ answer: Type.String() }),
});

const HANDOFF_PLAN_SHA256 = "c".repeat(64);
const HANDOFF_BASELINE_SHA256 = "f".repeat(64);
const HANDOFF_RESULT_SHA256 = "7".repeat(64);
const BASELINE_HEAD = "0123456789abcdef0123456789abcdef01234567";
const HANDOFF_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";

function writerRequest() {
	return {
		agent: "writer",
		task: {
			goal: "Write the change",
			context: [],
			instructions: ["Return structured output."],
		},
		contextMode: "fresh" as const,
		tools: ["read", "write"],
		preloadSkills: [],
		contextScopes: ["project" as const],
		workspace: { mode: "worktree" as const, cwd: "/repo" },
		outputSchema: Type.Object({ answer: Type.String() }),
		limits: {
			cumulativeRuntimeMs: 300_000,
			attemptTimeoutMs: 300_000,
			totalTokens: 1_000_000,
			cost: 100,
			outputBytes: 1_048_576,
			workspaceWriteBytes: 1_048_576,
			retries: 0,
			resumes: 0,
		},
	};
}

function patchContent(commit: string): Buffer {
	return Buffer.from(
		[
			`From ${commit} Mon Sep 17 00:00:00 2001`,
			"From: writer <writer@example.test>",
			"Date: Tue, 15 Sep 2026 00:00:00 +0000",
			"Subject: [PATCH] change",
			"",
			"---",
			"diff --git a/notes.txt b/notes.txt",
			"--- a/notes.txt",
			"+++ b/notes.txt",
			"@@ -0,0 +1 @@",
			"+x",
			"",
		].join("\n"),
		"utf8",
	);
}

/** Drives a ready worktree task through the success ladder with a real handoff blob. */
async function completeWorktreeTask(
	journal: WorkflowRunJournal,
	artifacts: WorkflowArtifactStore,
	task: MaterializedAgentTask,
): Promise<{ executionId: string; patch: WorkflowArtifactRef }> {
	const runId = journal.runId;
	const generation = 1;
	const executionId = deriveTaskExecutionId(runId, task.id, generation);
	const operationId = deriveSubagentOperationId(runId, task.id, generation);
	const stem = `${task.id.slice(5, 13)}g${generation}`;
	const subagentRunId = `run_${stem}`;
	const subagentAttemptId = `attempt_${stem}`;
	const preflightId = `preflight-${generation}`;
	await journal.append("task-execution-created", {
		execution: {
			kind: "agent",
			id: executionId,
			runId,
			taskId: task.id,
			generation,
			taskIdentitySha256: task.spec.identitySha256,
			operationId,
		},
	});
	await journal.append("task-execution-preflighted", {
		executionId,
		operationId,
		preflightId,
		planIdentitySha256: HANDOFF_PLAN_SHA256,
		plannedSubagentRunId: subagentRunId,
		plannedSubagentAttemptId: subagentAttemptId,
		expiresAt: "2027-01-01T00:00:00.000Z",
		workspaceMode: "worktree",
		workspaceBaselineSha256: HANDOFF_BASELINE_SHA256,
	});
	await journal.append("task-execution-launch-intended", {
		executionId,
		operationId,
		preflightId,
		planIdentitySha256: HANDOFF_PLAN_SHA256,
	});
	await journal.append("task-execution-launch-receipted", {
		executionId,
		operationId,
		subagentRunId,
		subagentAttemptId,
		status: "active",
	});
	await journal.append("task-status-changed", {
		taskId: task.id,
		from: "ready",
		to: "running",
	});
	await journal.append("task-execution-child-observed", {
		executionId,
		subagentRunId,
		subagentAttemptId,
		status: "completed",
	});
	const result = await artifacts.putJson(
		{ answer: "written" },
		{
			runId,
			producerTaskId: task.id,
			producerExecutionId: executionId,
			output: "result",
			schemaSha256: deriveJsonValueSha256(task.spec.request.outputSchema),
		},
	);
	const evidence: SubagentTerminalEvidence = {
		kind: "subagent",
		attemptOrdinal: 1,
		resultSha256: HANDOFF_RESULT_SHA256,
		status: "completed",
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
		sandboxCleanup: "proved",
		workspaceCleanup: "proved",
		truncated: false,
		structuredOutputSha256: result.sha256,
		handoff: {
			attemptId: subagentAttemptId,
			baselineHead: BASELINE_HEAD,
			handoffCommit: HANDOFF_COMMIT,
		},
	};
	await journal.append("task-execution-child-settled", {
		executionId,
		evidence,
	});
	await journal.append("artifact-declared", { artifact: result });
	await journal.append("task-execution-artifact-imported", {
		executionId,
		subagentRunId,
		artifactId: result.id,
		sourceResultSha256: HANDOFF_RESULT_SHA256,
	});
	const patch = await artifacts.putBytes(patchContent(HANDOFF_COMMIT), {
		runId,
		producerTaskId: task.id,
		producerExecutionId: executionId,
		output: "handoff",
		mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
		schemaSha256: WORKFLOW_HANDOFF_FORMAT_SHA256,
	});
	await journal.append("artifact-declared", { artifact: patch });
	await journal.append("task-execution-handoff-imported", {
		executionId,
		subagentRunId,
		subagentAttemptId,
		artifactId: patch.id,
		handoffCommit: HANDOFF_COMMIT,
		baselineHead: BASELINE_HEAD,
		sha256: patch.sha256,
		bytes: patch.bytes,
	});
	await journal.append("task-execution-release-intended", {
		executionId,
		subagentRunId,
	});
	await journal.append("task-execution-released", {
		executionId,
		subagentRunId,
		status: "completed",
	});
	await journal.append("task-execution-terminal", {
		executionId,
		outcome: "completed",
		evidence,
	});
	await journal.append("task-status-changed", {
		taskId: task.id,
		from: "running",
		to: "completed",
	});
	return { executionId, patch };
}

interface Fixture {
	readonly root: string;
	readonly lease: WorkflowRunLease;
	readonly journal: WorkflowRunJournal;
	readonly artifacts: WorkflowArtifactStore;
	readonly decisions: WorkflowDecisionRecordStore;
	/** The support producer feeding the checkpoint (undefined for a handoff fixture). */
	readonly producerId: WorkflowTaskId | undefined;
	readonly producerArtifact: WorkflowArtifactRef | undefined;
	readonly taskId: WorkflowTaskId;
	readonly secondId: WorkflowTaskId | undefined;
	readonly maxArtifactBytes: number | undefined;
}

interface FixtureOptions {
	readonly headless?: CheckpointHeadlessPolicy;
	readonly timeoutMs?: number;
	readonly withDefault?: boolean;
	readonly second?: boolean;
	/** Leave the checkpoint pending instead of readying it. */
	readonly pending?: boolean;
	readonly maxArtifactBytes?: number;
	readonly runId?: string;
}

async function openJournal(root: string, runId: string, ownerId: string) {
	const lease = await acquireWorkflowRunLease({
		storeRoot: root,
		runId,
		ownerId,
	});
	leases.add(lease);
	const journal = await WorkflowRunJournal.open(root, runId, lease);
	return { lease, journal };
}

function freshRoot(): string {
	return path.resolve(".pi", "test-checkpoint-executor", `run-${randomUUID()}`);
}

/**
 * A running run with a completed support producer and a ready checkpoint that
 * consumes its result, built with the real materializer, reducer, journal,
 * artifact store, decision store, and support executor.
 */
async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
	const runId = options.runId ?? RUN_ID;
	const root = freshRoot();
	const { lease, journal } = await openJournal(
		root,
		runId,
		"checkpoint-executor-test",
	);
	await journal.append("run-created", {
		definitionIdentitySha256,
		inputSha256,
	});
	const materializer = new WorkflowTaskMaterializer({
		runId,
		definitionIdentitySha256,
		inputSha256,
	});
	const producer = materializer.support(
		"shout",
		shout({ parameters: { value: "hello" } }),
	);
	const request = {
		schema: decisionSchema,
		prompt: "Approve the plan?",
		headless: options.headless ?? "block",
		...(options.withDefault ? { default: DEFAULT } : {}),
		...(options.timeoutMs === undefined
			? {}
			: { timeoutMs: options.timeoutMs }),
		inputs: { plan: producer.output },
	};
	const checkpoint = materializer.checkpoint("approve", request);
	const second = options.second
		? materializer.checkpoint("approve-2", {
				...request,
				prompt: "Approve again?",
			})
		: undefined;
	for (const event of materializer.closeEpoch("final", [
		checkpoint,
		...(second ? [second] : []),
	]).events) {
		await journal.appendEvent(event);
	}
	await journal.append("run-status-changed", {
		from: "created",
		to: "running",
	});
	await journal.append("task-status-changed", {
		taskId: producer.ref.taskId,
		from: "pending",
		to: "ready",
	});
	const artifacts = await WorkflowArtifactStore.open({
		journal,
		...(options.maxArtifactBytes === undefined
			? {}
			: { maxArtifactBytes: options.maxArtifactBytes }),
	});
	const registration = shout.registration(({ parameters }) => ({
		answer: parameters.value.toUpperCase(),
	}));
	const support = createWorkflowSupportTaskExecutor({
		journal,
		artifacts,
		registrations: new Map([[registration.name, registration]]),
		signal: () => new AbortController().signal,
	});
	await support.intend(producer.ref.taskId);
	const executed = await support.execute(producer.ref.taskId);
	const produced = reduceWorkflowEvents(await journal.readEvents());
	if (executed.outcome !== "completed") {
		const execution = produced.executions[executed.executionId];
		throw new Error(
			`producer did not complete: ${JSON.stringify(execution?.terminal)}`,
		);
	}
	const producerArtifact = Object.values(produced.artifacts).find(
		(artifact) => artifact.producerTaskId === producer.ref.taskId,
	);
	if (!producerArtifact) throw new Error("producer artifact missing");
	if (!options.pending) {
		for (const id of [checkpoint.ref.taskId, second?.ref.taskId]) {
			if (!id) continue;
			await journal.append("task-status-changed", {
				taskId: id,
				from: "pending",
				to: "ready",
			});
		}
	}
	const decisions = await WorkflowDecisionRecordStore.open({ journal });
	return {
		root,
		lease,
		journal,
		artifacts,
		decisions,
		producerId: producer.ref.taskId,
		producerArtifact,
		taskId: checkpoint.ref.taskId,
		secondId: second?.ref.taskId,
		maxArtifactBytes: options.maxArtifactBytes,
	};
}

/** A completed worktree writer whose handoff descriptor a checkpoint reviews. */
async function handoffFixture(): Promise<
	Fixture & { readonly patch: WorkflowArtifactRef }
> {
	const root = freshRoot();
	const { lease, journal } = await openJournal(
		root,
		RUN_ID,
		"checkpoint-executor-test",
	);
	await journal.append("run-created", {
		definitionIdentitySha256,
		inputSha256,
	});
	const materializer = new WorkflowTaskMaterializer({
		runId: RUN_ID,
		definitionIdentitySha256,
		inputSha256,
	});
	const writer = materializer.agent("writer", writerRequest());
	if (!writer.handoff) throw new Error("worktree handle lacks a handoff");
	const review = materializer.checkpoint("review", {
		schema: decisionSchema,
		prompt: "Accept the handoff?",
		headless: "block",
		inputs: { handoff: writer.handoff },
	});
	for (const event of materializer.closeEpoch("final", [review]).events) {
		await journal.appendEvent(event);
	}
	await journal.append("run-status-changed", {
		from: "created",
		to: "running",
	});
	await journal.append("task-status-changed", {
		taskId: writer.ref.taskId,
		from: "pending",
		to: "ready",
	});
	const artifacts = await WorkflowArtifactStore.open({ journal });
	const declared = reduceWorkflowEvents(await journal.readEvents());
	const task = declared.tasks[writer.ref.taskId]?.task;
	if (task?.spec.kind !== "agent") throw new Error("missing writer task");
	const { patch } = await completeWorktreeTask(
		journal,
		artifacts,
		task as MaterializedAgentTask,
	);
	await journal.append("task-status-changed", {
		taskId: review.ref.taskId,
		from: "pending",
		to: "ready",
	});
	const decisions = await WorkflowDecisionRecordStore.open({ journal });
	return {
		root,
		lease,
		journal,
		artifacts,
		decisions,
		producerId: undefined,
		producerArtifact: undefined,
		taskId: review.ref.taskId,
		secondId: undefined,
		maxArtifactBytes: undefined,
		patch,
	};
}

/** Re-opens the stores as a fresh process would after a crash. */
async function reopen(fx: Fixture): Promise<Fixture> {
	const journal = await WorkflowRunJournal.open(fx.root, RUN_ID, fx.lease);
	const artifacts = await WorkflowArtifactStore.open({
		journal,
		...(fx.maxArtifactBytes === undefined
			? {}
			: { maxArtifactBytes: fx.maxArtifactBytes }),
	});
	const decisions = await WorkflowDecisionRecordStore.open({ journal });
	return { ...fx, journal, artifacts, decisions };
}

function executor(
	fx: Fixture,
	options: {
		controller?: AbortController;
		deadlineAt?: string;
		headless?: boolean;
	} = {},
): WorkflowCheckpointTaskExecutor {
	const controller = options.controller ?? new AbortController();
	return createWorkflowCheckpointTaskExecutor({
		journal: fx.journal,
		artifacts: fx.artifacts,
		decisions: fx.decisions,
		signal: () => controller.signal,
		...(options.deadlineAt === undefined
			? {}
			: { deadlineAt: options.deadlineAt }),
		...(options.headless === undefined ? {} : { headless: options.headless }),
	});
}

async function projection(fx: Fixture): Promise<WorkflowStateProjection> {
	return reduceWorkflowEvents(await fx.journal.readEvents());
}

async function eventTypes(fx: Fixture): Promise<string[]> {
	return (await fx.journal.readEvents()).map((event) => event.type);
}

async function eventsAfter(fx: Fixture, count: number) {
	return (await fx.journal.readEvents())
		.slice(count)
		.map((event) => ({ type: event.type, data: event.data }));
}

function view(
	state: WorkflowStateProjection,
	taskId: WorkflowTaskId,
): {
	task: WorkflowTaskProjection;
	spec: MaterializedCheckpointTask["spec"];
	execution: TaskExecutionProjection;
} {
	const task = state.tasks[taskId];
	if (!task) throw new Error("missing task projection");
	if (task.task.spec.kind !== "checkpoint") throw new Error("not a checkpoint");
	const execution = task.currentExecutionId
		? state.executions[task.currentExecutionId]
		: undefined;
	if (!execution) throw new Error("missing execution projection");
	return { task, spec: task.task.spec, execution };
}

function checkpointSpec(
	state: WorkflowStateProjection,
	taskId: WorkflowTaskId,
): MaterializedCheckpointTask["spec"] {
	const task = state.tasks[taskId];
	if (task?.task.spec.kind !== "checkpoint")
		throw new Error("not a checkpoint");
	return task.task.spec;
}

function resultArtifacts(
	state: WorkflowStateProjection,
	taskId: WorkflowTaskId,
): WorkflowArtifactRef[] {
	return Object.values(state.artifacts).filter(
		(artifact) =>
			artifact.producerTaskId === taskId && artifact.output === "result",
	);
}

function bindingOf(
	state: WorkflowStateProjection,
	taskId: WorkflowTaskId,
): WorkflowDecisionBinding {
	const { spec, execution } = view(state, taskId);
	const request = execution.checkpointRequest;
	if (!request) throw new Error("checkpoint has no request");
	return {
		kind: "checkpoint",
		runId: RUN_ID,
		taskId,
		executionId: execution.execution.id,
		effectSha256: deriveCheckpointEffectSha256({
			taskIdentitySha256: spec.identitySha256,
			inputsSha256: request.inputsSha256,
		}),
	};
}

async function expectError(
	operation: Promise<unknown>,
	stage: WorkflowCheckpointExecutionError["stage"],
	message: string,
): Promise<void> {
	await expect(operation).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof WorkflowCheckpointExecutionError &&
			error.stage === stage &&
			error.message === message,
	);
}

async function expectWaiting(
	fx: Fixture,
	taskId: WorkflowTaskId,
): Promise<WorkflowStateProjection> {
	const state = await projection(fx);
	const { task, execution } = view(state, taskId);
	expect(task.status).toBe("waiting");
	expect(execution.phase).toBe("checkpoint-requested");
	expect(resultArtifacts(state, taskId)).toHaveLength(0);
	return state;
}

async function expectFailure(
	fx: Fixture,
	taskId: WorkflowTaskId,
	stage: "checkpoint-input" | "checkpoint-expired",
	message: string,
): Promise<WorkflowStateProjection> {
	const state = await projection(fx);
	const { task, execution } = view(state, taskId);
	expect(task.status).toBe("failed");
	expect(execution.phase).toBe("terminal");
	expect(execution.terminal).toMatchObject({
		outcome: "failed",
		evidence: {
			kind: "workflow",
			stage,
			message,
			failureSha256: deriveWorkflowFailureSha256(stage, message),
		},
	});
	expect(resultArtifacts(state, taskId)).toHaveLength(0);
	return state;
}

async function expectCancelled(
	fx: Fixture,
	taskId: WorkflowTaskId,
	message: string,
): Promise<WorkflowStateProjection> {
	const state = await projection(fx);
	const { task, execution } = view(state, taskId);
	expect(task.status).toBe("cancelled");
	expect(execution.phase).toBe("terminal");
	expect(execution.terminal).toMatchObject({
		outcome: "cancelled",
		evidence: {
			kind: "workflow",
			stage: "stop",
			message,
			failureSha256: deriveWorkflowFailureSha256("stop", message),
		},
	});
	expect(resultArtifacts(state, taskId)).toHaveLength(0);
	return state;
}

async function expectDecided(
	fx: Fixture,
	taskId: WorkflowTaskId,
	expected: {
		value: unknown;
		source: "operator" | "default";
		decidedBy?: string;
		reason?: string;
	},
): Promise<{
	state: WorkflowStateProjection;
	artifact: WorkflowArtifactRef;
	execution: TaskExecutionProjection;
	record: WorkflowDecisionRecord;
}> {
	const state = await projection(fx);
	const { task, spec, execution } = view(state, taskId);
	expect(task.status).toBe("completed");
	expect(execution.phase).toBe("terminal");
	const artifacts = resultArtifacts(state, taskId);
	expect(artifacts).toHaveLength(1);
	const artifact = artifacts[0] as WorkflowArtifactRef;
	const decisionSha256 = deriveJsonValueSha256(expected.value);
	expect(artifact).toMatchObject({
		runId: RUN_ID,
		producerTaskId: taskId,
		producerExecutionId: execution.execution.id,
		output: "result",
		mediaType: "application/json",
		sha256: decisionSha256,
		schemaSha256: deriveJsonValueSha256(spec.request.schema),
	});
	expect(await fx.artifacts.readJson(artifact)).toEqual(expected.value);
	expect(execution.checkpointDecision).toMatchObject({
		artifactId: artifact.id,
		decisionSha256,
		source: expected.source,
	});
	expect(execution.checkpointDecision?.decidedBy).toBe(expected.decidedBy);
	expect(execution.checkpointDecision?.reason).toBe(expected.reason);
	expect(execution.terminal).toEqual({
		outcome: "completed",
		evidence: {
			kind: "checkpoint",
			artifactId: artifact.id,
			decisionSha256,
			source: expected.source,
			...(expected.decidedBy === undefined
				? {}
				: { decidedBy: expected.decidedBy }),
		},
		sequence: execution.terminal?.sequence,
	});
	const record = await fx.decisions.read(bindingOf(state, taskId));
	if (!record) throw new Error("decision record missing");
	expect(record).toMatchObject({
		schema: "pi-workflow-decision",
		contractRevision: WORKFLOW_CONTRACT_REVISION,
		source: expected.source,
		valueSchemaSha256: deriveJsonValueSha256(spec.request.schema),
		valueSha256: decisionSha256,
		value: expected.value,
	});
	expect(record.decidedBy).toBe(expected.decidedBy);
	expect(record.reason).toBe(expected.reason);
	return { state, artifact, execution, record };
}

/** Requests the checkpoint with a healthy executor; it parks waiting. */
async function requested(
	fx: Fixture,
	taskId: WorkflowTaskId = fx.taskId,
): Promise<{ executionId: string; expiresAt: string | undefined }> {
	const outcome = await executor(fx).request(taskId);
	expect(outcome.state).toBe("requested");
	return { executionId: outcome.executionId, expiresAt: outcome.expiresAt };
}

/** A decision record persisted directly (a crash before its event). */
async function recordByHand(
	fx: Fixture,
	value: unknown,
	decidedBy = "vegard",
	reason?: string,
	decidedAt = new Date().toISOString(),
): Promise<WorkflowDecisionRecord> {
	const state = await projection(fx);
	return fx.decisions.put({
		schema: "pi-workflow-decision",
		contractRevision: WORKFLOW_CONTRACT_REVISION,
		binding: bindingOf(state, fx.taskId),
		source: "operator",
		decidedBy,
		...(reason === undefined ? {} : { reason }),
		decidedAt,
		valueSchemaSha256: deriveJsonValueSha256(
			checkpointSpec(state, fx.taskId).request.schema,
		),
		valueSha256: deriveJsonValueSha256(value),
		value,
	});
}

async function artifactByHand(
	fx: Fixture,
	value: unknown,
	declare = true,
	taskId: WorkflowTaskId = fx.taskId,
): Promise<WorkflowArtifactRef> {
	const state = await projection(fx);
	const { spec, execution } = view(state, taskId);
	const artifact = await fx.artifacts.putJson(value, {
		runId: RUN_ID,
		producerTaskId: taskId,
		producerExecutionId: execution.execution.id,
		output: "result",
		schemaSha256: deriveJsonValueSha256(spec.request.schema),
	});
	if (declare) await fx.journal.append("artifact-declared", { artifact });
	return artifact;
}

async function decidedByHand(
	fx: Fixture,
	artifact: WorkflowArtifactRef,
	decidedBy = "vegard",
	decidedAt = new Date().toISOString(),
): Promise<void> {
	const { execution } = view(await projection(fx), fx.taskId);
	await fx.journal.append("task-execution-checkpoint-decided", {
		executionId: execution.execution.id,
		artifactId: artifact.id,
		decisionSha256: artifact.sha256,
		source: "operator",
		decidedAt,
		decidedBy,
	});
}

async function terminalByHand(fx: Fixture): Promise<void> {
	const { execution } = view(await projection(fx), fx.taskId);
	const decision = execution.checkpointDecision;
	if (!decision) throw new Error("missing decision");
	await fx.journal.append("task-execution-terminal", {
		executionId: execution.execution.id,
		outcome: "completed",
		evidence: {
			kind: "checkpoint",
			artifactId: decision.artifactId,
			decisionSha256: decision.decisionSha256,
			source: decision.source,
			...(decision.decidedBy === undefined
				? {}
				: { decidedBy: decision.decidedBy }),
		},
	});
}

function nowSpy(at: number) {
	return vi.spyOn(Date, "now").mockReturnValue(at);
}

/** Every message along an error's `cause` chain, outermost first. */
function causeMessages(error: unknown): string[] {
	const messages: string[] = [];
	for (let current = error; current instanceof Error; current = current.cause) {
		messages.push(current.message);
	}
	return messages;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all([...leases].map((lease) => lease.release()));
	leases.clear();
});

describe("checkpoint executor construction", () => {
	it("rejects stores that belong to another run or journal", async () => {
		const fx = await fixture();
		const other = await fixture({ runId: "workflow_other" });
		expect(() =>
			createWorkflowCheckpointTaskExecutor({
				journal: fx.journal,
				artifacts: other.artifacts,
				decisions: fx.decisions,
				signal: () => new AbortController().signal,
			}),
		).toThrow(
			"Checkpoint executor artifacts do not belong to the workflow journal.",
		);
		expect(() =>
			createWorkflowCheckpointTaskExecutor({
				journal: fx.journal,
				artifacts: fx.artifacts,
				decisions: other.decisions,
				signal: () => new AbortController().signal,
			}),
		).toThrow(
			"Checkpoint executor decisions do not belong to the workflow journal.",
		);
	});
});

describe("checkpoint executor request", () => {
	it("requests a checkpoint with a relative timeout and parks it waiting", async () => {
		const fx = await fixture({ timeoutMs: TIMEOUT_MS });
		const before = (await eventTypes(fx)).length;
		const ex = executor(fx);
		const executionId = deriveTaskExecutionId(RUN_ID, fx.taskId, 1);
		const lower = Date.now();
		const outcome = await ex.request(fx.taskId);
		const upper = Date.now();
		expect(outcome).toMatchObject({
			taskId: fx.taskId,
			executionId,
			state: "requested",
			runStatus: "running",
		});
		expect(outcome.outcome).toBeUndefined();
		const expiresAt = Date.parse(outcome.expiresAt ?? "");
		expect(expiresAt).toBeGreaterThanOrEqual(lower + TIMEOUT_MS);
		expect(expiresAt).toBeLessThanOrEqual(upper + TIMEOUT_MS);

		const state = await expectWaiting(fx, fx.taskId);
		const { spec, execution } = view(state, fx.taskId);
		expect(execution.execution).toEqual({
			kind: "checkpoint",
			id: executionId,
			runId: RUN_ID,
			taskId: fx.taskId,
			generation: 1,
			taskIdentitySha256: spec.identitySha256,
		});
		expect(execution.checkpointRequest).toMatchObject({
			inputsSha256: deriveJsonValueSha256({
				plan: fx.producerArtifact?.sha256,
			}),
			expiresAt: outcome.expiresAt,
		});
		expect(state.status).toBe("running");
		expect(await eventsAfter(fx, before)).toEqual([
			{
				type: "task-execution-created",
				data: { execution: execution.execution },
			},
			{
				type: "task-execution-checkpoint-requested",
				data: {
					executionId,
					inputsSha256: execution.checkpointRequest?.inputsSha256,
					expiresAt: outcome.expiresAt,
				},
			},
			{
				type: "task-status-changed",
				data: {
					taskId: fx.taskId,
					from: "ready",
					to: "waiting",
					reason: "Checkpoint awaits a decision.",
				},
			},
		]);
	});

	it("caps the expiry by the run deadline", async () => {
		const fx = await fixture({ timeoutMs: TIMEOUT_MS });
		const deadlineAt = new Date(Date.now() + 5_000).toISOString();
		const outcome = await executor(fx, { deadlineAt }).request(fx.taskId);
		expect(outcome.expiresAt).toBe(deadlineAt);
		const { execution } = view(await projection(fx), fx.taskId);
		expect(execution.checkpointRequest?.expiresAt).toBe(deadlineAt);
	});

	it("omits the expiry without a timeout even under a deadline", async () => {
		const fx = await fixture();
		const outcome = await executor(fx, {
			deadlineAt: new Date(Date.now() + 5_000).toISOString(),
		}).request(fx.taskId);
		expect(outcome.expiresAt).toBeUndefined();
		expect("expiresAt" in outcome).toBe(false);
		const { execution } = view(await projection(fx), fx.taskId);
		expect(execution.checkpointRequest?.expiresAt).toBeUndefined();
	});

	it("is idempotent for a parked checkpoint and repairs a missing waiting status", async () => {
		const fx = await fixture({ timeoutMs: TIMEOUT_MS });
		const first = await executor(fx).request(fx.taskId);
		const count = (await eventTypes(fx)).length;
		const again = await executor(await reopen(fx)).request(fx.taskId);
		expect(again).toEqual(first);
		expect((await eventTypes(fx)).length).toBe(count);

		// Crash prefix: created + requested without the waiting transition.
		const bare = await fixture();
		const spec = checkpointSpec(await projection(bare), bare.taskId);
		const executionId = deriveTaskExecutionId(RUN_ID, bare.taskId, 1);
		await bare.journal.append("task-execution-created", {
			execution: {
				kind: "checkpoint",
				id: executionId,
				runId: RUN_ID,
				taskId: bare.taskId,
				generation: 1,
				taskIdentitySha256: spec.identitySha256,
			},
		});
		await bare.journal.append("task-execution-checkpoint-requested", {
			executionId,
			inputsSha256: deriveJsonValueSha256({
				plan: bare.producerArtifact?.sha256,
			}),
		});
		const outcome = await executor(bare).request(bare.taskId);
		expect(outcome).toEqual({
			taskId: bare.taskId,
			executionId,
			state: "requested",
			runStatus: "running",
		});
		await expectWaiting(bare, bare.taskId);
	});

	it("continues from a bare execution record", async () => {
		const fx = await fixture({ timeoutMs: TIMEOUT_MS });
		const spec = checkpointSpec(await projection(fx), fx.taskId);
		const executionId = deriveTaskExecutionId(RUN_ID, fx.taskId, 1);
		await fx.journal.append("task-execution-created", {
			execution: {
				kind: "checkpoint",
				id: executionId,
				runId: RUN_ID,
				taskId: fx.taskId,
				generation: 1,
				taskIdentitySha256: spec.identitySha256,
			},
		});
		const ex = executor(fx);
		expect(await ex.sweep()).toEqual([]);
		const outcome = await ex.request(fx.taskId);
		expect(outcome).toMatchObject({ executionId, state: "requested" });
		await expectWaiting(fx, fx.taskId);
		const state = await projection(fx);
		expect(
			Object.values(state.executions).filter(
				(execution) => execution.execution.taskId === fx.taskId,
			),
		).toHaveLength(1);
	});

	it("rejects invalid, non-checkpoint, and unready tasks", async () => {
		const fx = await fixture({ pending: true });
		const ex = executor(fx);
		await expectError(
			ex.request("nope" as WorkflowTaskId),
			"validation",
			"Workflow task id is invalid.",
		);
		await expectError(
			ex.request(fx.producerId as WorkflowTaskId),
			"validation",
			"Workflow task is not a checkpoint task.",
		);
		await expectError(
			ex.request(fx.taskId),
			"validation",
			"Checkpoint task is not ready or waiting.",
		);
		const state = await projection(fx);
		expect(state.tasks[fx.taskId]?.currentExecutionId).toBeUndefined();
	});

	it("decides a use-explicit-default checkpoint immediately in headless mode", async () => {
		const fx = await fixture({
			headless: "use-explicit-default",
			withDefault: true,
			timeoutMs: TIMEOUT_MS,
		});
		const before = (await eventTypes(fx)).length;
		const outcome = await executor(fx, { headless: true }).request(fx.taskId);
		expect(outcome).toEqual({
			taskId: fx.taskId,
			executionId: deriveTaskExecutionId(RUN_ID, fx.taskId, 1),
			state: "terminal",
			outcome: "completed",
			runStatus: "running",
		});
		await expectDecided(fx, fx.taskId, { value: DEFAULT, source: "default" });
		const types = (await eventTypes(fx)).slice(before);
		expect(types).toEqual([
			"task-execution-created",
			"task-execution-checkpoint-requested",
			"artifact-declared",
			"task-execution-checkpoint-decided",
			"task-execution-terminal",
			"task-status-changed",
		]);
		const last = (await fx.journal.readEvents()).at(-1);
		expect(last?.data).toMatchObject({
			from: "ready",
			to: "completed",
			reason: "Checkpoint decided.",
		});
	});

	it("parks a block checkpoint even in headless mode", async () => {
		const fx = await fixture({ headless: "block", withDefault: true });
		const outcome = await executor(fx, { headless: true }).request(fx.taskId);
		expect(outcome.state).toBe("requested");
		await expectWaiting(fx, fx.taskId);
	});

	it("does not short-circuit use-explicit-default when not headless", async () => {
		const fx = await fixture({
			headless: "use-explicit-default",
			withDefault: true,
		});
		expect((await executor(fx).request(fx.taskId)).state).toBe("requested");
		await expectWaiting(fx, fx.taskId);
	});

	it("fails at checkpoint-input when an input cannot be read and verified", async () => {
		const fx = await fixture();
		await writeFile(
			path.join(fx.artifacts.root, `${fx.producerArtifact?.sha256}.json`),
			"corrupt",
		);
		const outcome = await executor(fx).request(fx.taskId);
		expect(outcome).toMatchObject({ state: "terminal", outcome: "failed" });
		await expectFailure(
			fx,
			fx.taskId,
			"checkpoint-input",
			"Checkpoint inputs could not be read and verified.",
		);
	});

	it("cancels at the stop stage when the run is stopping", async () => {
		const fx = await fixture();
		const controller = new AbortController();
		controller.abort();
		const outcome = await executor(fx, { controller }).request(fx.taskId);
		expect(outcome).toMatchObject({ state: "terminal", outcome: "cancelled" });
		await expectCancelled(fx, fx.taskId, "Workflow stop requested.");
	});

	it("hashes and reads a handoff input as its descriptor", async () => {
		const fx = await handoffFixture();
		const outcome = await executor(fx).request(fx.taskId);
		expect(outcome.state).toBe("requested");
		const state = await expectWaiting(fx, fx.taskId);
		expect(view(state, fx.taskId).execution.checkpointRequest).toMatchObject({
			inputsSha256: deriveJsonValueSha256({ handoff: fx.patch.sha256 }),
		});
		const result = await executor(fx).decide(fx.taskId, {
			value: APPROVE,
			decidedBy: "vegard",
		});
		expect(result.outcome).toBe("completed");
		await expectDecided(fx, fx.taskId, {
			value: APPROVE,
			source: "operator",
			decidedBy: "vegard",
		});
	});

	it("fails at checkpoint-input when a handoff input is corrupt on disk", async () => {
		const fx = await handoffFixture();
		await writeFile(
			path.join(fx.artifacts.root, `${fx.patch.sha256}.patch`),
			"corrupt",
		);
		const outcome = await executor(fx).request(fx.taskId);
		expect(outcome).toMatchObject({ state: "terminal", outcome: "failed" });
		await expectFailure(
			fx,
			fx.taskId,
			"checkpoint-input",
			"Checkpoint inputs could not be read and verified.",
		);
	});
});

describe("checkpoint executor decide", () => {
	it("records an immutable operator decision and completes the task", async () => {
		const fx = await fixture({ timeoutMs: TIMEOUT_MS });
		const { executionId } = await requested(fx);
		const before = (await eventTypes(fx)).length;
		const result = await executor(fx).decide(fx.taskId, {
			value: APPROVE,
			decidedBy: "vegard",
			reason: "Looks good.",
		});
		expect(result).toEqual({
			taskId: fx.taskId,
			executionId,
			outcome: "completed",
			runStatus: "running",
		});
		const { artifact, record } = await expectDecided(fx, fx.taskId, {
			value: APPROVE,
			source: "operator",
			decidedBy: "vegard",
			reason: "Looks good.",
		});
		expect(record.binding).toEqual({
			kind: "checkpoint",
			runId: RUN_ID,
			taskId: fx.taskId,
			executionId,
			effectSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(await eventsAfter(fx, before)).toEqual([
			{ type: "artifact-declared", data: { artifact } },
			{
				type: "task-execution-checkpoint-decided",
				data: {
					executionId,
					artifactId: artifact.id,
					decisionSha256: artifact.sha256,
					source: "operator",
					decidedAt: record.decidedAt,
					decidedBy: "vegard",
					reason: "Looks good.",
				},
			},
			{
				type: "task-execution-terminal",
				data: {
					executionId,
					outcome: "completed",
					evidence: {
						kind: "checkpoint",
						artifactId: artifact.id,
						decisionSha256: artifact.sha256,
						source: "operator",
						decidedBy: "vegard",
					},
				},
			},
			{
				type: "task-status-changed",
				data: {
					taskId: fx.taskId,
					from: "waiting",
					to: "completed",
					reason: "Checkpoint decided.",
				},
			},
		]);
	});

	it("validates the approver and reason before touching the run", async () => {
		const fx = await fixture();
		await requested(fx);
		const count = (await eventTypes(fx)).length;
		const ex = executor(fx);
		for (const decidedBy of ["", "x".repeat(257), 42 as unknown as string]) {
			await expectError(
				ex.decide(fx.taskId, { value: APPROVE, decidedBy }),
				"validation",
				"Invalid checkpoint approver.",
			);
		}
		for (const reason of ["", "x".repeat(4097), 7 as unknown as string]) {
			await expectError(
				ex.decide(fx.taskId, { value: APPROVE, decidedBy: "vegard", reason }),
				"validation",
				"Invalid checkpoint decision reason.",
			);
		}
		expect((await eventTypes(fx)).length).toBe(count);
		await expectWaiting(fx, fx.taskId);
	});

	it("refuses a decision that does not match the schema", async () => {
		const fx = await fixture();
		await requested(fx);
		await expectError(
			executor(fx).decide(fx.taskId, {
				value: { proceed: "yes" },
				decidedBy: "vegard",
			}),
			"decision",
			"Checkpoint decision does not match its schema.",
		);
		await expectWaiting(fx, fx.taskId);
		const state = await projection(fx);
		expect(
			await fx.decisions.read(bindingOf(state, fx.taskId)),
		).toBeUndefined();
	});

	it("refuses a decision that is not losslessly JSON serializable", async () => {
		const fx = await fixture();
		await requested(fx);
		await expectError(
			executor(fx).decide(fx.taskId, {
				value: { proceed: true, note: undefined },
				decidedBy: "vegard",
			}),
			"decision",
			"Checkpoint decision is not losslessly JSON serializable.",
		);
		await expectWaiting(fx, fx.taskId);
	});

	it("refuses a decision that exceeds the artifact bound", async () => {
		const fx = await fixture({ maxArtifactBytes: 64 });
		await requested(fx);
		await expectError(
			executor(fx).decide(fx.taskId, {
				value: { proceed: true, note: "x".repeat(200) },
				decidedBy: "vegard",
			}),
			"decision",
			"Checkpoint decision exceeds the workflow artifact bound.",
		);
		await expectWaiting(fx, fx.taskId);
		expect(Object.keys((await projection(fx)).artifacts)).toHaveLength(1);
	});

	it("refuses a second decision", async () => {
		const fx = await fixture();
		await requested(fx);
		const ex = executor(fx);
		await ex.decide(fx.taskId, { value: APPROVE, decidedBy: "vegard" });
		const count = (await eventTypes(fx)).length;
		await expectError(
			ex.decide(fx.taskId, { value: DEFAULT, decidedBy: "someone-else" }),
			"validation",
			"Checkpoint is already decided.",
		);
		expect((await eventTypes(fx)).length).toBe(count);
		await expectDecided(fx, fx.taskId, {
			value: APPROVE,
			source: "operator",
			decidedBy: "vegard",
		});
	});

	it("refuses a checkpoint that is not awaiting a decision", async () => {
		const fx = await fixture();
		const ex = executor(fx);
		await expectError(
			ex.decide(fx.taskId, { value: APPROVE, decidedBy: "vegard" }),
			"validation",
			"Checkpoint task has no durable execution.",
		);
		const spec = checkpointSpec(await projection(fx), fx.taskId);
		await fx.journal.append("task-execution-created", {
			execution: {
				kind: "checkpoint",
				id: deriveTaskExecutionId(RUN_ID, fx.taskId, 1),
				runId: RUN_ID,
				taskId: fx.taskId,
				generation: 1,
				taskIdentitySha256: spec.identitySha256,
			},
		});
		await expectError(
			ex.decide(fx.taskId, { value: APPROVE, decidedBy: "vegard" }),
			"validation",
			"Checkpoint is not awaiting a decision.",
		);
	});

	it("expires a block checkpoint instead of accepting a late decision", async () => {
		const fx = await fixture({ timeoutMs: TIMEOUT_MS });
		const { expiresAt } = await requested(fx);
		const at = Date.parse(expiresAt ?? "");
		nowSpy(at);
		await expectError(
			executor(fx).decide(fx.taskId, { value: APPROVE, decidedBy: "vegard" }),
			"validation",
			"Checkpoint has expired.",
		);
		await expectFailure(
			fx,
			fx.taskId,
			"checkpoint-expired",
			"Checkpoint expired without a decision.",
		);
	});

	it("expires a use-explicit-default checkpoint to its default on a late decision", async () => {
		const fx = await fixture({
			headless: "use-explicit-default",
			withDefault: true,
			timeoutMs: TIMEOUT_MS,
		});
		const { expiresAt } = await requested(fx);
		nowSpy(Date.parse(expiresAt ?? "") + 1);
		await expectError(
			executor(fx).decide(fx.taskId, { value: APPROVE, decidedBy: "vegard" }),
			"validation",
			"Checkpoint has expired.",
		);
		await expectDecided(fx, fx.taskId, { value: DEFAULT, source: "default" });
	});

	it("accepts a decision one millisecond before expiry", async () => {
		const fx = await fixture({ timeoutMs: TIMEOUT_MS });
		const { expiresAt } = await requested(fx);
		nowSpy(Date.parse(expiresAt ?? "") - 1);
		const result = await executor(fx).decide(fx.taskId, {
			value: APPROVE,
			decidedBy: "vegard",
		});
		expect(result.outcome).toBe("completed");
		await expectDecided(fx, fx.taskId, {
			value: APPROVE,
			source: "operator",
			decidedBy: "vegard",
		});
	});

	it("refuses a decision that conflicts with declared decision evidence", async () => {
		const fx = await fixture();
		await requested(fx);
		await artifactByHand(fx, DEFAULT);
		await expectError(
			executor(fx).decide(fx.taskId, { value: APPROVE, decidedBy: "vegard" }),
			"persistence",
			"Checkpoint decision conflicts with existing decision evidence.",
		);
		const state = await projection(fx);
		expect(view(state, fx.taskId).execution.phase).toBe("checkpoint-requested");
	});
});

describe("checkpoint executor expiry and sweep", () => {
	it("expires a block checkpoint exactly at its expiry", async () => {
		const fx = await fixture({ timeoutMs: TIMEOUT_MS });
		const { executionId, expiresAt } = await requested(fx);
		const at = Date.parse(expiresAt ?? "");
		const ex = executor(fx);
		expect(await ex.sweep(at - 1)).toEqual([]);
		await expectWaiting(fx, fx.taskId);
		expect(await ex.sweep(at)).toEqual([
			{
				taskId: fx.taskId,
				executionId,
				outcome: "failed",
				runStatus: "running",
			},
		]);
		const state = await expectFailure(
			fx,
			fx.taskId,
			"checkpoint-expired",
			"Checkpoint expired without a decision.",
		);
		expect(state.status).toBe("running");
		expect(await ex.sweep(at)).toEqual([]);
	});

	it("expires a use-explicit-default checkpoint to its default", async () => {
		const fx = await fixture({
			headless: "use-explicit-default",
			withDefault: true,
			timeoutMs: TIMEOUT_MS,
		});
		const { executionId, expiresAt } = await requested(fx);
		const before = (await eventTypes(fx)).length;
		const settled = await executor(fx).sweep(Date.parse(expiresAt ?? ""));
		expect(settled).toEqual([
			{
				taskId: fx.taskId,
				executionId,
				outcome: "completed",
				runStatus: "running",
			},
		]);
		await expectDecided(fx, fx.taskId, { value: DEFAULT, source: "default" });
		expect((await eventTypes(fx)).slice(before)).toEqual([
			"artifact-declared",
			"task-execution-checkpoint-decided",
			"task-execution-terminal",
			"task-status-changed",
		]);
	});

	it("never expires a checkpoint without a timeout", async () => {
		const fx = await fixture();
		await requested(fx);
		expect(await executor(fx).sweep(Number.MAX_SAFE_INTEGER)).toEqual([]);
		await expectWaiting(fx, fx.taskId);
	});

	it("leaves parked and undecided checkpoints alone", async () => {
		const fx = await fixture({ timeoutMs: TIMEOUT_MS, second: true });
		await requested(fx);
		const count = (await eventTypes(fx)).length;
		expect(await executor(fx).sweep()).toEqual([]);
		expect((await eventTypes(fx)).length).toBe(count);
	});
});

describe("checkpoint executor crash ladder", () => {
	const operator = {
		value: APPROVE,
		source: "operator" as const,
		decidedBy: "vegard",
	};

	it("replays a decision record persisted before its event", async () => {
		const fx = await fixture({ timeoutMs: TIMEOUT_MS });
		const { executionId } = await requested(fx);
		await recordByHand(fx, APPROVE, "vegard", "Recorded.");
		const before = (await eventTypes(fx)).length;
		const ex = executor(await reopen(fx));
		expect(await ex.sweep()).toEqual([
			{
				taskId: fx.taskId,
				executionId,
				outcome: "completed",
				runStatus: "running",
			},
		]);
		await expectDecided(fx, fx.taskId, { ...operator, reason: "Recorded." });
		expect((await eventTypes(fx)).slice(before)).toEqual([
			"artifact-declared",
			"task-execution-checkpoint-decided",
			"task-execution-terminal",
			"task-status-changed",
		]);
	});

	it("replays a stored record from request and from decide without asking again", async () => {
		const viaRequest = await fixture();
		const { executionId } = await requested(viaRequest);
		await recordByHand(viaRequest, APPROVE);
		expect(await executor(viaRequest).request(viaRequest.taskId)).toEqual({
			taskId: viaRequest.taskId,
			executionId,
			state: "terminal",
			outcome: "completed",
			runStatus: "running",
		});
		await expectDecided(viaRequest, viaRequest.taskId, operator);

		const viaDecide = await fixture();
		await requested(viaDecide);
		await recordByHand(viaDecide, APPROVE);
		await expectError(
			executor(viaDecide).decide(viaDecide.taskId, {
				value: DEFAULT,
				decidedBy: "someone-else",
			}),
			"validation",
			"Checkpoint is already decided.",
		);
		await expectDecided(viaDecide, viaDecide.taskId, operator);
	});

	it("replays an expired checkpoint from its record rather than expiring it, carrying the record's decision time", async () => {
		const fx = await fixture({ timeoutMs: TIMEOUT_MS });
		const { expiresAt } = await requested(fx);
		// Decided before the expiry; the event lands after the watchdog fired.
		const decidedAt = new Date().toISOString();
		expect(Date.parse(decidedAt)).toBeLessThan(Date.parse(expiresAt ?? ""));
		await recordByHand(fx, APPROVE, "vegard", undefined, decidedAt);
		const before = (await eventTypes(fx)).length;
		const settled = await executor(fx).sweep(Date.parse(expiresAt ?? "") + 1);
		expect(settled.map((result) => result.outcome)).toEqual(["completed"]);
		const { execution } = await expectDecided(fx, fx.taskId, operator);
		expect(execution.checkpointDecision?.decidedAt).toBe(decidedAt);
		const decidedEvent = (await eventsAfter(fx, before)).find(
			(event) => event.type === "task-execution-checkpoint-decided",
		);
		expect(decidedEvent?.data).toMatchObject({ decidedAt });
	});

	it("refuses to replay a record whose own decision time is at its expiry", async () => {
		// A run deadline already in the past caps the expiry to a time that is
		// not in the future, so the record's time can sit exactly at it.
		const fx = await fixture({ timeoutMs: TIMEOUT_MS });
		const deadlineAt = new Date(Date.now() - 1_000).toISOString();
		const outcome = await executor(fx, { deadlineAt }).request(fx.taskId);
		expect(outcome).toMatchObject({
			state: "requested",
			expiresAt: deadlineAt,
		});
		await recordByHand(fx, APPROVE, "vegard", undefined, deadlineAt);
		const failure = await executor(fx)
			.sweep()
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(causeMessages(failure)).toContainEqual(
			expect.stringContaining("checkpoint decision follows its expiry"),
		);
		const state = await projection(fx);
		expect(view(state, fx.taskId).execution.phase).toBe("checkpoint-requested");
	});

	it("completes from a declared artifact whose decision event never landed", async () => {
		const fx = await fixture();
		const { executionId } = await requested(fx);
		await recordByHand(fx, APPROVE);
		const artifact = await artifactByHand(fx, APPROVE);
		const before = (await eventTypes(fx)).length;
		expect(await executor(await reopen(fx)).sweep()).toEqual([
			{
				taskId: fx.taskId,
				executionId,
				outcome: "completed",
				runStatus: "running",
			},
		]);
		const decided = await expectDecided(fx, fx.taskId, operator);
		expect(decided.artifact).toEqual(artifact);
		expect((await eventTypes(fx)).slice(before)).toEqual([
			"task-execution-checkpoint-decided",
			"task-execution-terminal",
			"task-status-changed",
		]);
	});

	it("completes from a stored blob that was never declared", async () => {
		const fx = await fixture();
		await requested(fx);
		await recordByHand(fx, APPROVE);
		const artifact = await artifactByHand(fx, APPROVE, false);
		const before = (await eventTypes(fx)).length;
		expect((await executor(fx).sweep()).map((r) => r.outcome)).toEqual([
			"completed",
		]);
		expect((await expectDecided(fx, fx.taskId, operator)).artifact).toEqual(
			artifact,
		);
		expect((await eventTypes(fx)).slice(before)[0]).toBe("artifact-declared");
	});

	it("terminalizes a decided execution from every entry point", async () => {
		for (const entry of ["sweep", "request", "cancel", "decide"] as const) {
			const fx = await fixture();
			const { executionId } = await requested(fx);
			await recordByHand(fx, APPROVE);
			await decidedByHand(fx, await artifactByHand(fx, APPROVE));
			const before = (await eventTypes(fx)).length;
			const ex = executor(await reopen(fx));
			if (entry === "sweep") {
				expect(await ex.sweep()).toEqual([
					{
						taskId: fx.taskId,
						executionId,
						outcome: "completed",
						runStatus: "running",
					},
				]);
			} else if (entry === "request") {
				expect(await ex.request(fx.taskId)).toMatchObject({
					state: "terminal",
					outcome: "completed",
				});
			} else if (entry === "cancel") {
				expect(await ex.cancel(fx.taskId, "Stop.")).toMatchObject({
					outcome: "completed",
				});
			} else {
				await expectError(
					ex.decide(fx.taskId, { value: DEFAULT, decidedBy: "other" }),
					"validation",
					"Checkpoint is already decided.",
				);
			}
			await expectDecided(fx, fx.taskId, operator);
			expect((await eventTypes(fx)).slice(before)).toEqual([
				"task-execution-terminal",
				"task-status-changed",
			]);
		}
	});

	it("repairs the task status of a terminal execution", async () => {
		const fx = await fixture();
		const { executionId } = await requested(fx);
		await recordByHand(fx, APPROVE);
		await decidedByHand(fx, await artifactByHand(fx, APPROVE));
		await terminalByHand(fx);
		expect(view(await projection(fx), fx.taskId).task.status).toBe("waiting");
		const before = (await eventTypes(fx)).length;
		const ex = executor(fx);
		expect(await ex.sweep()).toEqual([
			{
				taskId: fx.taskId,
				executionId,
				outcome: "completed",
				runStatus: "running",
			},
		]);
		await expectDecided(fx, fx.taskId, operator);
		expect((await eventTypes(fx)).slice(before)).toEqual([
			"task-status-changed",
		]);
		expect(await ex.sweep()).toEqual([]);
		expect(await ex.request(fx.taskId)).toMatchObject({
			state: "terminal",
			outcome: "completed",
		});
		expect(await ex.cancel(fx.taskId, "Stop.")).toMatchObject({
			outcome: "completed",
		});
		expect((await eventTypes(fx)).length).toBe(before + 1);
	});

	it("repairs a failed terminal status and reports the failure", async () => {
		const fx = await fixture({ timeoutMs: TIMEOUT_MS });
		const { executionId, expiresAt } = await requested(fx);
		const message = "Checkpoint expired without a decision.";
		await fx.journal.append("task-execution-terminal", {
			executionId,
			outcome: "failed",
			evidence: {
				kind: "workflow",
				stage: "checkpoint-expired",
				failureSha256: deriveWorkflowFailureSha256(
					"checkpoint-expired",
					message,
				),
				message,
			},
		});
		const ex = executor(fx);
		expect(await ex.sweep(Date.parse(expiresAt ?? ""))).toEqual([
			{
				taskId: fx.taskId,
				executionId,
				outcome: "failed",
				runStatus: "running",
			},
		]);
		await expectFailure(fx, fx.taskId, "checkpoint-expired", message);
		expect(await ex.request(fx.taskId)).toMatchObject({
			state: "terminal",
			outcome: "failed",
		});
		await expectError(
			ex.decide(fx.taskId, { value: APPROVE, decidedBy: "vegard" }),
			"validation",
			"Checkpoint is already decided.",
		);
	});

	it("converges every prefix to the same decision digest", async () => {
		const digests = new Set<string>();
		const prefixes = ["record", "artifact", "decided", "terminal"] as const;
		for (const prefix of prefixes) {
			const fx = await fixture();
			await requested(fx);
			await recordByHand(fx, APPROVE);
			if (prefix !== "record") {
				const artifact = await artifactByHand(fx, APPROVE);
				if (prefix !== "artifact") await decidedByHand(fx, artifact);
				if (prefix === "terminal") await terminalByHand(fx);
			}
			await executor(await reopen(fx)).sweep();
			const { execution } = await expectDecided(fx, fx.taskId, operator);
			digests.add(execution.checkpointDecision?.decisionSha256 ?? "");
		}
		expect([...digests]).toEqual([deriveJsonValueSha256(APPROVE)]);
	});
});

describe("checkpoint executor cancel", () => {
	it("cancels a parked checkpoint with the given reason", async () => {
		const fx = await fixture({ timeoutMs: TIMEOUT_MS });
		const { executionId } = await requested(fx);
		const result = await executor(fx).cancel(fx.taskId, "Deadline passed.");
		expect(result).toEqual({
			taskId: fx.taskId,
			executionId,
			outcome: "cancelled",
			runStatus: "running",
		});
		await expectCancelled(fx, fx.taskId, "Deadline passed.");
	});

	it("cancels a created execution and refuses a task without one", async () => {
		const fx = await fixture();
		const ex = executor(fx);
		await expectError(
			ex.cancel(fx.taskId, "Stop."),
			"validation",
			"Checkpoint task has no durable execution.",
		);
		const spec = checkpointSpec(await projection(fx), fx.taskId);
		await fx.journal.append("task-execution-created", {
			execution: {
				kind: "checkpoint",
				id: deriveTaskExecutionId(RUN_ID, fx.taskId, 1),
				runId: RUN_ID,
				taskId: fx.taskId,
				generation: 1,
				taskIdentitySha256: spec.identitySha256,
			},
		});
		expect((await ex.cancel(fx.taskId, "Stop.")).outcome).toBe("cancelled");
		await expectCancelled(fx, fx.taskId, "Stop.");
	});

	it("lets a durable decision win over cancellation", async () => {
		const fx = await fixture();
		await requested(fx);
		await recordByHand(fx, APPROVE);
		await decidedByHand(fx, await artifactByHand(fx, APPROVE));
		expect((await executor(fx).cancel(fx.taskId, "Stop.")).outcome).toBe(
			"completed",
		);
		await expectDecided(fx, fx.taskId, {
			value: APPROVE,
			source: "operator",
			decidedBy: "vegard",
		});
	});

	it("cancels every open checkpoint before a run fails", async () => {
		const fx = await fixture({ second: true, timeoutMs: TIMEOUT_MS });
		const secondId = fx.secondId as WorkflowTaskId;
		await requested(fx);
		const spec = checkpointSpec(await projection(fx), secondId);
		await fx.journal.append("task-execution-created", {
			execution: {
				kind: "checkpoint",
				id: deriveTaskExecutionId(RUN_ID, secondId, 1),
				runId: RUN_ID,
				taskId: secondId,
				generation: 1,
				taskIdentitySha256: spec.identitySha256,
			},
		});
		await expect(
			fx.journal.append("run-status-changed", {
				from: "running",
				to: "failed",
				reason: "boom",
			}),
		).rejects.toThrow();
		await cancelOpenWorkflowCheckpoints(
			fx.journal,
			CHECKPOINT_RUN_ENDING_REASON,
		);
		await expectCancelled(fx, fx.taskId, CHECKPOINT_RUN_ENDING_REASON);
		await expectCancelled(fx, secondId, CHECKPOINT_RUN_ENDING_REASON);
		const count = (await eventTypes(fx)).length;
		await cancelOpenWorkflowCheckpoints(
			fx.journal,
			CHECKPOINT_RUN_ENDING_REASON,
		);
		expect((await eventTypes(fx)).length).toBe(count);
		await fx.journal.append("run-status-changed", {
			from: "running",
			to: "failed",
			reason: "boom",
		});
		expect((await projection(fx)).status).toBe("failed");
	});

	it("commits a decided but unterminalized checkpoint before a run fails", async () => {
		// A crash between the decided event and its terminal, followed by a
		// failure site firing before any sweep: the commit must precede
		// `-> failed`, or the failed run could never be invalidated.
		const fx = await fixture({ second: true });
		const { executionId } = await requested(fx);
		await recordByHand(fx, APPROVE);
		const artifact = await artifactByHand(fx, APPROVE);
		await decidedByHand(fx, artifact);
		const rejected = await fx.journal
			.append("run-status-changed", {
				from: "running",
				to: "failed",
				reason: "boom",
			})
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(causeMessages(rejected)).toContainEqual(
			expect.stringContaining("run failure leaves a checkpoint open"),
		);
		const before = (await eventTypes(fx)).length;
		await cancelOpenWorkflowCheckpoints(
			fx.journal,
			CHECKPOINT_RUN_ENDING_REASON,
		);
		expect(await eventsAfter(fx, before)).toEqual([
			{
				type: "task-execution-terminal",
				data: {
					executionId,
					outcome: "completed",
					evidence: {
						kind: "checkpoint",
						artifactId: artifact.id,
						decisionSha256: artifact.sha256,
						source: "operator",
						decidedBy: "vegard",
					},
				},
			},
			{
				type: "task-status-changed",
				data: {
					taskId: fx.taskId,
					from: "waiting",
					to: "completed",
					reason: "Checkpoint decided.",
				},
			},
		]);
		await expectDecided(fx, fx.taskId, {
			value: APPROVE,
			source: "operator",
			decidedBy: "vegard",
		});
		expect((await projection(fx)).tasks[fx.secondId as string]?.status).toBe(
			"ready",
		);
		const count = (await eventTypes(fx)).length;
		await cancelOpenWorkflowCheckpoints(
			fx.journal,
			CHECKPOINT_RUN_ENDING_REASON,
		);
		expect((await eventTypes(fx)).length).toBe(count);
		await fx.journal.append("run-status-changed", {
			from: "running",
			to: "failed",
			reason: "boom",
		});
		const events = await eventTypes(fx);
		expect(events.at(-1)).toBe("run-status-changed");
		expect(events.indexOf("task-execution-terminal")).toBeLessThan(
			events.length - 1,
		);
		expect((await projection(fx)).status).toBe("failed");
	});

	it("tolerates a concurrent commit while committing a decided checkpoint", async () => {
		const fx = await fixture();
		const { executionId } = await requested(fx);
		await recordByHand(fx, APPROVE);
		const artifact = await artifactByHand(fx, APPROVE);
		await decidedByHand(fx, artifact);
		const ex = executor(fx);
		let raced = false;
		const racing = new Proxy(fx.journal, {
			get(target, property, receiver) {
				if (property !== "appendEvent") {
					return Reflect.get(target, property, receiver);
				}
				return async (input: WorkflowEventInput) => {
					if (!raced && input.type === "task-execution-terminal") {
						raced = true;
						await ex.sweep();
					}
					return target.appendEvent(input);
				};
			},
		});
		await cancelOpenWorkflowCheckpoints(racing, CHECKPOINT_RUN_ENDING_REASON);
		expect(raced).toBe(true);
		await expectDecided(fx, fx.taskId, {
			value: APPROVE,
			source: "operator",
			decidedBy: "vegard",
		});
		expect(
			(await fx.journal.readEvents()).filter(
				(event) =>
					event.type === "task-execution-terminal" &&
					(event.data as { executionId: string }).executionId === executionId,
			),
		).toHaveLength(1);
	});

	it("leaves decided checkpoints alone when cancelling open ones", async () => {
		const fx = await fixture({ second: true });
		await requested(fx);
		await executor(fx).decide(fx.taskId, {
			value: APPROVE,
			decidedBy: "vegard",
		});
		const count = (await eventTypes(fx)).length;
		await cancelOpenWorkflowCheckpoints(
			fx.journal,
			CHECKPOINT_RUN_ENDING_REASON,
		);
		expect((await eventTypes(fx)).length).toBe(count);
		await expectDecided(fx, fx.taskId, {
			value: APPROVE,
			source: "operator",
			decidedBy: "vegard",
		});
		expect((await projection(fx)).tasks[fx.secondId as string]?.status).toBe(
			"ready",
		);
	});

	it("tolerates a decision that lands while cancelling open checkpoints", async () => {
		const fx = await fixture();
		await requested(fx);
		const ex = executor(fx);
		let raced = false;
		const racing = new Proxy(fx.journal, {
			get(target, property, receiver) {
				if (property !== "appendEvent") {
					return Reflect.get(target, property, receiver);
				}
				return async (input: WorkflowEventInput) => {
					if (!raced && input.type === "task-execution-terminal") {
						raced = true;
						await ex.decide(fx.taskId, { value: APPROVE, decidedBy: "vegard" });
					}
					return target.appendEvent(input);
				};
			},
		});
		await cancelOpenWorkflowCheckpoints(racing, CHECKPOINT_RUN_ENDING_REASON);
		expect(raced).toBe(true);
		await expectDecided(fx, fx.taskId, {
			value: APPROVE,
			source: "operator",
			decidedBy: "vegard",
		});
	});

	it("propagates a rejected cancel whose execution is still open", async () => {
		const fx = await fixture();
		await requested(fx);
		const broken = new Proxy(fx.journal, {
			get(target, property, receiver) {
				if (property !== "appendEvent") {
					return Reflect.get(target, property, receiver);
				}
				return async (input: WorkflowEventInput) =>
					target.appendEvent(
						input.type === "task-execution-terminal"
							? {
									...input,
									data: { ...input.data, executionId: "exec_missing" },
								}
							: input,
					);
			},
		});
		await expect(
			cancelOpenWorkflowCheckpoints(broken, CHECKPOINT_RUN_ENDING_REASON),
		).rejects.toThrow();
		await expectWaiting(fx, fx.taskId);
	});
});

describe("checkpoint executor serialization", () => {
	it("serializes concurrent requests per task", async () => {
		const fx = await fixture({ timeoutMs: TIMEOUT_MS });
		const ex = executor(fx);
		const [first, second] = await Promise.all([
			ex.request(fx.taskId),
			ex.request(fx.taskId),
		]);
		expect(second).toEqual(first);
		const state = await expectWaiting(fx, fx.taskId);
		expect(
			Object.values(state.executions).filter(
				(execution) => execution.execution.taskId === fx.taskId,
			),
		).toHaveLength(1);
		expect(
			(await eventTypes(fx)).filter(
				(type) => type === "task-execution-checkpoint-requested",
			),
		).toHaveLength(1);
	});

	it("serializes concurrent decisions so exactly one is recorded", async () => {
		const fx = await fixture();
		await requested(fx);
		const ex = executor(fx);
		const outcomes = await Promise.allSettled([
			ex.decide(fx.taskId, { value: APPROVE, decidedBy: "first" }),
			ex.decide(fx.taskId, { value: DEFAULT, decidedBy: "second" }),
		]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual([
			"fulfilled",
			"rejected",
		]);
		const rejected = outcomes[1];
		expect(rejected.status === "rejected" && rejected.reason).toMatchObject({
			stage: "validation",
			message: "Checkpoint is already decided.",
		});
		await expectDecided(fx, fx.taskId, {
			value: APPROVE,
			source: "operator",
			decidedBy: "first",
		});
	});

	it("runs a sweep and a decision for independent tasks without interference", async () => {
		const fx = await fixture({ second: true, timeoutMs: TIMEOUT_MS });
		const secondId = fx.secondId as WorkflowTaskId;
		const ex = executor(fx);
		const first = await ex.request(fx.taskId);
		await ex.request(secondId);
		const [settled, decided] = await Promise.all([
			ex.sweep(Date.parse(first.expiresAt ?? "")),
			ex.decide(secondId, { value: APPROVE, decidedBy: "vegard" }),
		]);
		expect(decided.outcome).toBe("completed");
		expect(settled.map((result) => [result.taskId, result.outcome])).toEqual([
			[fx.taskId, "failed"],
		]);
		await expectFailure(
			fx,
			fx.taskId,
			"checkpoint-expired",
			"Checkpoint expired without a decision.",
		);
		await expectDecided(fx, secondId, {
			value: APPROVE,
			source: "operator",
			decidedBy: "vegard",
		});
	});
});
