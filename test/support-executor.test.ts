import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { HANDOFF_EXPORT_MEDIA_TYPE } from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowArtifactStore } from "../src/artifact-store.js";
import {
	type MaterializedAgentTask,
	type MaterializedSupportTask,
	type SubagentTerminalEvidence,
	WORKFLOW_HANDOFF_FORMAT_SHA256,
	type WorkflowArtifactRef,
	type WorkflowHandoffDescriptor,
	type WorkflowTaskId,
} from "../src/contracts.js";
import type {
	TaskExecutionProjection,
	WorkflowStateProjection,
	WorkflowTaskProjection,
} from "../src/events.js";
import {
	deriveJsonValueSha256,
	deriveSubagentOperationId,
	deriveSupportImplementationIdentitySha256,
	deriveTaskExecutionId,
	deriveWorkflowFailureSha256,
	deriveWorkflowHandoffDescriptor,
} from "../src/execution.js";
import { WorkflowTaskMaterializer } from "../src/materializer.js";
import { WorkflowRunJournal } from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
	type WorkflowRunLease,
} from "../src/persistence/run-lease.js";
import { reduceWorkflowEvents } from "../src/reducer.js";
import {
	defineSupportTask,
	type SupportTaskExecutionContext,
	type SupportTaskRegistration,
	supportRegistrationIdentity,
} from "../src/support.js";
import {
	createWorkflowSupportTaskExecutor,
	WorkflowSupportExecutionError,
	type WorkflowSupportTaskExecutor,
} from "../src/support-executor.js";

const RUN_ID = "workflow_support";
const MODULE = "@vegardx/workflow-tools";
const definitionIdentitySha256 = "a".repeat(64);
const inputSha256 = "b".repeat(64);
const leases = new Set<WorkflowRunLease>();

const shoutSchemas = {
	parametersSchema: Type.Object({ value: Type.String() }),
	outputSchema: Type.Object({ answer: Type.String() }),
};

const shout = defineSupportTask({
	name: `${MODULE}/shout`,
	moduleSpecifier: MODULE,
	revision: 1,
	implementationSha256: "c".repeat(64),
	...shoutSchemas,
});

const echo = defineSupportTask({
	name: `${MODULE}/echo`,
	moduleSpecifier: MODULE,
	revision: 1,
	implementationSha256: "d".repeat(64),
	parametersSchema: Type.Object({}),
	outputSchema: Type.Object({
		echoed: Type.Object({ answer: Type.String() }),
	}),
});

type ShoutContext = SupportTaskExecutionContext<{ value: string }>;
type ExecuteSpy<TParameters> = ReturnType<
	typeof vi.fn<(context: SupportTaskExecutionContext<TParameters>) => unknown>
>;

const shoutValue = ({ parameters }: ShoutContext) => ({
	answer: parameters.value.toUpperCase(),
});

function register<TParameters>(
	helper: { registration(execute: never): SupportTaskRegistration },
	fn: (context: SupportTaskExecutionContext<TParameters>) => unknown,
): { execute: ExecuteSpy<TParameters>; registration: SupportTaskRegistration } {
	const execute = vi.fn(fn);
	return { execute, registration: helper.registration(execute as never) };
}

function shoutImpl(fn: (context: ShoutContext) => unknown = shoutValue) {
	return register<{ value: string }>(shout, fn);
}

const HANDOFF_PLAN_SHA256 = "c".repeat(64);
const HANDOFF_BASELINE_SHA256 = "f".repeat(64);
const HANDOFF_RESULT_SHA256 = "7".repeat(64);
/** Git object ids (spec 1.2 GitObjectIdSchema). */
const BASELINE_HEAD = "0123456789abcdef0123456789abcdef01234567";
const HANDOFF_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";

/** A worktree writer request (spec D3): worktree workspace, positive write limit. */
function writerRequest(goal = "Write the change") {
	return {
		agent: "writer",
		task: { goal, context: [], instructions: ["Return structured output."] },
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

/** A single-commit git-format-patch as pi-subagent renders it (spec 4.4 step 6). */
function patchContent(commit: string, padding = 0): Buffer {
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
			`+${"x".repeat(padding)}`,
			"",
		].join("\n"),
		"utf8",
	);
}

function agentTask(
	state: WorkflowStateProjection,
	taskId: WorkflowTaskId,
): MaterializedAgentTask {
	const task = state.tasks[taskId]?.task;
	if (task?.spec.kind !== "agent") throw new Error("missing agent task");
	return task as MaterializedAgentTask;
}

function executionOf(
	state: WorkflowStateProjection,
	executionId: string,
): TaskExecutionProjection {
	const execution = state.executions[executionId];
	if (!execution) throw new Error("missing execution projection");
	return execution;
}

interface CompletedWorktreeTask {
	readonly executionId: string;
	readonly subagentRunId: string;
	readonly subagentAttemptId: string;
	readonly result: WorkflowArtifactRef;
	readonly patch: WorkflowArtifactRef;
}

/**
 * Drives a ready worktree task through the spec 4.5 success ladder with a
 * real result artifact and a digest-verified handoff blob, exactly as the
 * scheduler and finalizer would persist it.
 */
async function completeWorktreeTask(
	journal: WorkflowRunJournal,
	artifacts: WorkflowArtifactStore,
	task: MaterializedAgentTask,
	generation: number,
	options: { commit?: string; padding?: number } = {},
): Promise<CompletedWorktreeTask> {
	const runId = journal.runId;
	const executionId = deriveTaskExecutionId(runId, task.id, generation);
	const operationId = deriveSubagentOperationId(runId, task.id, generation);
	const stem = `${task.id.slice(5, 13)}g${generation}`;
	const subagentRunId = `run_${stem}`;
	const subagentAttemptId = `attempt_${stem}`;
	const preflightId = `preflight-${generation}`;
	const commit = options.commit ?? HANDOFF_COMMIT;
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
		{ answer: `generation ${generation}` },
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
			handoffCommit: commit,
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
	const patch = await artifacts.putBytes(
		patchContent(commit, options.padding ?? 0),
		{
			runId,
			producerTaskId: task.id,
			producerExecutionId: executionId,
			output: "handoff",
			mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
			schemaSha256: WORKFLOW_HANDOFF_FORMAT_SHA256,
		},
	);
	await journal.append("artifact-declared", { artifact: patch });
	await journal.append("task-execution-handoff-imported", {
		executionId,
		subagentRunId,
		subagentAttemptId,
		artifactId: patch.id,
		handoffCommit: commit,
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
	return { executionId, subagentRunId, subagentAttemptId, result, patch };
}

const describePatch = defineSupportTask({
	name: `${MODULE}/describe-patch`,
	moduleSpecifier: MODULE,
	revision: 1,
	implementationSha256: "e".repeat(64),
	parametersSchema: Type.Object({}),
	outputSchema: Type.Object({ commit: Type.String(), bytes: Type.Integer() }),
});

interface HandoffFixture extends Fixture {
	readonly writerId: WorkflowTaskId;
	readonly writerExecutionId: string;
	readonly patch: WorkflowArtifactRef;
}

/** A completed worktree writer whose handoff feeds a support consumer (spec 6). */
async function handoffFixture(): Promise<HandoffFixture> {
	const root = path.resolve(
		".pi",
		"test-support-executor",
		`run-${randomUUID()}`,
	);
	const { lease, journal } = await openJournal(root, "support-executor-test");
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
	const consumer = materializer.support(
		"describe",
		describePatch({ parameters: {}, inputs: { patch: writer.handoff } }),
	);
	for (const event of materializer.closeEpoch("final", [consumer]).events) {
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
	const produced = await completeWorktreeTask(
		journal,
		artifacts,
		agentTask(declared, writer.ref.taskId),
		1,
	);
	return {
		root,
		lease,
		journal,
		artifacts,
		taskId: writer.ref.taskId,
		secondId: undefined,
		consumerId: consumer.ref.taskId,
		maxArtifactBytes: undefined,
		writerId: writer.ref.taskId,
		writerExecutionId: produced.executionId,
		patch: produced.patch,
	};
}

function defer<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

interface Fixture {
	readonly root: string;
	readonly lease: WorkflowRunLease;
	readonly journal: WorkflowRunJournal;
	readonly artifacts: WorkflowArtifactStore;
	readonly taskId: WorkflowTaskId;
	readonly secondId: WorkflowTaskId | undefined;
	readonly consumerId: WorkflowTaskId | undefined;
	readonly maxArtifactBytes: number | undefined;
}

async function openJournal(root: string, ownerId: string) {
	const lease = await acquireWorkflowRunLease({
		storeRoot: root,
		runId: RUN_ID,
		ownerId,
	});
	leases.add(lease);
	const journal = await WorkflowRunJournal.open(root, RUN_ID, lease);
	return { lease, journal };
}

async function fixture(
	options: {
		consumer?: boolean;
		second?: boolean;
		maxArtifactBytes?: number;
	} = {},
): Promise<Fixture> {
	const root = path.resolve(
		".pi",
		"test-support-executor",
		`run-${randomUUID()}`,
	);
	const { lease, journal } = await openJournal(root, "support-executor-test");
	await journal.append("run-created", {
		definitionIdentitySha256,
		inputSha256,
	});
	const materializer = new WorkflowTaskMaterializer({
		runId: RUN_ID,
		definitionIdentitySha256,
		inputSha256,
	});
	const producer = materializer.support(
		"shout",
		shout({ parameters: { value: "hello" } }),
	);
	const second = options.second
		? materializer.support("shout-2", shout({ parameters: { value: "world" } }))
		: undefined;
	const consumer = options.consumer
		? materializer.support(
				"echo",
				echo({ parameters: {}, inputs: { source: producer.output } }),
			)
		: undefined;
	const leaves = [consumer ?? producer, ...(second ? [second] : [])];
	for (const event of materializer.closeEpoch("final", leaves).events) {
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
	if (second) {
		await journal.append("task-status-changed", {
			taskId: second.ref.taskId,
			from: "pending",
			to: "ready",
		});
	}
	const artifacts = await WorkflowArtifactStore.open({
		journal,
		...(options.maxArtifactBytes === undefined
			? {}
			: { maxArtifactBytes: options.maxArtifactBytes }),
	});
	return {
		root,
		lease,
		journal,
		artifacts,
		taskId: producer.ref.taskId,
		secondId: second?.ref.taskId,
		consumerId: consumer?.ref.taskId,
		maxArtifactBytes: options.maxArtifactBytes,
	};
}

/** Re-opens the journal and artifact store as a fresh process would. */
async function reopen(
	fx: Fixture,
	rotate?: { ownerId: string },
): Promise<Fixture> {
	let lease = fx.lease;
	if (rotate) {
		await fx.lease.release();
		leases.delete(fx.lease);
		lease = await acquireWorkflowRunLease({
			storeRoot: fx.root,
			runId: RUN_ID,
			ownerId: rotate.ownerId,
		});
		leases.add(lease);
	}
	const journal = await WorkflowRunJournal.open(fx.root, RUN_ID, lease);
	const artifacts = await WorkflowArtifactStore.open({
		journal,
		...(fx.maxArtifactBytes === undefined
			? {}
			: { maxArtifactBytes: fx.maxArtifactBytes }),
	});
	return { ...fx, lease, journal, artifacts };
}

function executor(
	fx: Fixture,
	registrations: readonly SupportTaskRegistration[],
	controller = new AbortController(),
): WorkflowSupportTaskExecutor {
	return createWorkflowSupportTaskExecutor({
		journal: fx.journal,
		artifacts: fx.artifacts,
		registrations: new Map(
			registrations.map((registration) => [registration.name, registration]),
		),
		signal: () => controller.signal,
	});
}

async function projection(fx: Fixture): Promise<WorkflowStateProjection> {
	return reduceWorkflowEvents(await fx.journal.readEvents());
}

async function eventTypes(fx: Fixture): Promise<string[]> {
	return (await fx.journal.readEvents()).map((event) => event.type);
}

function view(
	state: WorkflowStateProjection,
	taskId: WorkflowTaskId,
): {
	task: WorkflowTaskProjection;
	spec: MaterializedSupportTask["spec"];
	execution: TaskExecutionProjection;
} {
	const task = state.tasks[taskId];
	if (!task) throw new Error("missing task projection");
	if (task.task.spec.kind !== "support") throw new Error("not a support task");
	const execution = task.currentExecutionId
		? state.executions[task.currentExecutionId]
		: undefined;
	if (!execution) throw new Error("missing execution projection");
	return { task, spec: task.task.spec, execution };
}

function supportSpec(
	state: WorkflowStateProjection,
	taskId: WorkflowTaskId,
): MaterializedSupportTask["spec"] {
	const task = state.tasks[taskId];
	if (task?.task.spec.kind !== "support") {
		throw new Error("missing support task");
	}
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

async function expectFailure(
	fx: Fixture,
	taskId: WorkflowTaskId,
	stage: string,
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
			failureSha256: deriveWorkflowFailureSha256(stage as never, message),
		},
	});
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

async function expectCompleted(
	fx: Fixture,
	taskId: WorkflowTaskId,
): Promise<{
	state: WorkflowStateProjection;
	artifact: WorkflowArtifactRef;
	execution: TaskExecutionProjection;
}> {
	const state = await projection(fx);
	const { task, spec, execution } = view(state, taskId);
	expect(task.status).toBe("completed");
	expect(execution.phase).toBe("terminal");
	const artifacts = resultArtifacts(state, taskId);
	expect(artifacts).toHaveLength(1);
	const artifact = artifacts[0] as WorkflowArtifactRef;
	expect(artifact).toMatchObject({
		runId: RUN_ID,
		producerTaskId: taskId,
		output: "result",
		mediaType: "application/json",
		schemaSha256: deriveJsonValueSha256(
			spec.request.implementation.outputSchema,
		),
	});
	expect(execution.supportOutput).toMatchObject({
		artifactId: artifact.id,
		outputSha256: artifact.sha256,
	});
	expect(execution.terminal).toMatchObject({
		outcome: "completed",
		evidence: {
			kind: "support",
			implementationIdentitySha256:
				execution.supportIntent?.implementationIdentitySha256,
			parametersSha256: execution.supportIntent?.parametersSha256,
			inputsSha256: execution.supportIntent?.inputsSha256,
			outputSha256: artifact.sha256,
			artifactId: artifact.id,
		},
	});
	const evidence = execution.terminal?.evidence;
	if (evidence?.kind !== "support")
		throw new Error("expected support evidence");
	expect(Number.isInteger(evidence.durationMs)).toBe(true);
	expect(evidence.durationMs).toBeGreaterThanOrEqual(0);
	return { state, artifact, execution };
}

/** Persists intent with a healthy executor, simulating a crash afterwards. */
async function intentOnly(fx: Fixture): Promise<WorkflowSupportTaskExecutor> {
	const ex = executor(fx, [shoutImpl().registration]);
	const intent = await ex.intend(fx.taskId);
	expect(intent.state).toBe("intended");
	return ex;
}

async function declareByHand(
	fx: Fixture,
	taskId: WorkflowTaskId,
	value: unknown,
	declare = true,
): Promise<WorkflowArtifactRef> {
	const spec = supportSpec(await projection(fx), taskId);
	const artifact = await fx.artifacts.putJson(value, {
		runId: RUN_ID,
		producerTaskId: taskId,
		producerExecutionId: deriveTaskExecutionId(RUN_ID, taskId, 1),
		output: "result",
		schemaSha256: deriveJsonValueSha256(
			spec.request.implementation.outputSchema,
		),
	});
	if (declare) await fx.journal.append("artifact-declared", { artifact });
	return artifact;
}

async function commitByHand(
	fx: Fixture,
	taskId: WorkflowTaskId,
	artifact: WorkflowArtifactRef,
): Promise<void> {
	const { execution } = view(await projection(fx), taskId);
	await fx.journal.append("task-execution-support-output-committed", {
		executionId: execution.execution.id,
		artifactId: artifact.id,
		outputSha256: artifact.sha256,
	});
}

async function terminalByHand(
	fx: Fixture,
	taskId: WorkflowTaskId,
	artifact: WorkflowArtifactRef,
): Promise<void> {
	const { execution } = view(await projection(fx), taskId);
	const intent = execution.supportIntent;
	if (!intent) throw new Error("missing intent");
	await fx.journal.append("task-execution-terminal", {
		executionId: execution.execution.id,
		outcome: "completed",
		evidence: {
			kind: "support",
			implementationIdentitySha256: intent.implementationIdentitySha256,
			parametersSha256: intent.parametersSha256,
			inputsSha256: intent.inputsSha256,
			outputSha256: artifact.sha256,
			artifactId: artifact.id,
			durationMs: 0,
		},
	});
}

async function completeProducer(
	fx: Fixture,
	ex: WorkflowSupportTaskExecutor,
): Promise<WorkflowArtifactRef> {
	await ex.intend(fx.taskId);
	expect((await ex.execute(fx.taskId)).outcome).toBe("completed");
	return (await expectCompleted(fx, fx.taskId)).artifact;
}

async function readyConsumer(fx: Fixture): Promise<WorkflowTaskId> {
	if (!fx.consumerId) throw new Error("fixture has no consumer");
	await fx.journal.append("task-status-changed", {
		taskId: fx.consumerId,
		from: "pending",
		to: "ready",
	});
	return fx.consumerId;
}

afterEach(async () => {
	await Promise.all([...leases].map((lease) => lease.release()));
	leases.clear();
});

describe("support task executor execution", () => {
	it("intends and executes a parameters-only support task to durable completion", async () => {
		const fx = await fixture();
		const before = await eventTypes(fx);
		const { execute, registration } = shoutImpl();
		const ex = executor(fx, [registration]);
		const executionId = deriveTaskExecutionId(RUN_ID, fx.taskId, 1);

		const intent = await ex.intend(fx.taskId);
		expect(intent).toEqual({
			taskId: fx.taskId,
			executionId,
			state: "intended",
			runStatus: "running",
		});
		expect(execute).not.toHaveBeenCalled();
		const intended = await projection(fx);
		const { task, spec, execution } = view(intended, fx.taskId);
		const implementationIdentitySha256 =
			deriveSupportImplementationIdentitySha256(spec.request.implementation);
		expect(implementationIdentitySha256).toBe(
			supportRegistrationIdentity(registration),
		);
		expect(task.status).toBe("running");
		expect(execution.phase).toBe("support-intended");
		expect(execution.execution).toEqual({
			kind: "support",
			id: executionId,
			runId: RUN_ID,
			taskId: fx.taskId,
			generation: 1,
			taskIdentitySha256: spec.identitySha256,
			implementationIdentitySha256,
		});
		expect(execution.supportIntent).toMatchObject({
			implementationIdentitySha256,
			parametersSha256: deriveJsonValueSha256({ value: "hello" }),
			inputsSha256: deriveJsonValueSha256({}),
		});
		expect(execution.supportIntent?.parametersSha256).toBe(
			deriveJsonValueSha256(spec.request.parameters),
		);

		const result = await ex.execute(fx.taskId);
		expect(result).toEqual({
			taskId: fx.taskId,
			executionId,
			outcome: "completed",
			runStatus: "running",
		});
		expect(execute).toHaveBeenCalledTimes(1);
		const context = execute.mock.calls[0]?.[0];
		if (!context) throw new Error("missing execution context");
		expect(context.parameters).toEqual({ value: "hello" });
		expect(Object.keys(context.inputs)).toEqual([]);
		expect(Object.isFrozen(context.inputs)).toBe(true);
		expect(Object.getPrototypeOf(context.inputs)).toBeNull();
		expect(context.signal).toBeInstanceOf(AbortSignal);
		expect(context.signal.aborted).toBe(false);

		const { artifact, execution: terminal } = await expectCompleted(
			fx,
			fx.taskId,
		);
		expect(artifact.schemaSha256).toBe(
			deriveJsonValueSha256(shoutSchemas.outputSchema),
		);
		expect(terminal.terminal?.evidence).toMatchObject({
			kind: "support",
			implementationIdentitySha256,
			parametersSha256: deriveJsonValueSha256({ value: "hello" }),
			inputsSha256: deriveJsonValueSha256({}),
		});
		expect(await fx.artifacts.readJson(artifact)).toEqual({ answer: "HELLO" });
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"task-execution-created",
			"task-execution-support-intended",
			"task-status-changed",
			"artifact-declared",
			"task-execution-support-output-committed",
			"task-execution-terminal",
			"task-status-changed",
		]);
	});

	it("feeds a support producer's concrete output to a support consumer", async () => {
		const fx = await fixture({ consumer: true });
		const producer = shoutImpl();
		let seen: SupportTaskExecutionContext | undefined;
		const consumer = register<Record<string, never>>(echo, (context) => {
			seen = context;
			return { echoed: context.inputs.source };
		});
		const ex = executor(fx, [producer.registration, consumer.registration]);
		const first = await completeProducer(fx, ex);

		const consumerId = await readyConsumer(fx);
		await ex.intend(consumerId);
		const { execution } = view(await projection(fx), consumerId);
		expect(execution.supportIntent?.inputsSha256).toBe(
			deriveJsonValueSha256({ source: first.sha256 }),
		);
		expect(execution.supportIntent?.parametersSha256).toBe(
			deriveJsonValueSha256({}),
		);

		expect((await ex.execute(consumerId)).outcome).toBe("completed");
		expect(consumer.execute).toHaveBeenCalledTimes(1);
		if (!seen) throw new Error("consumer was not invoked");
		expect(seen.inputs).toEqual({ source: { answer: "HELLO" } });
		expect(Object.getPrototypeOf(seen.inputs)).toBeNull();
		expect(Object.isFrozen(seen.inputs)).toBe(true);
		expect(Object.isFrozen(seen.inputs.source)).toBe(true);
		const { artifact } = await expectCompleted(fx, consumerId);
		expect(await fx.artifacts.readJson(artifact)).toEqual({
			echoed: { answer: "HELLO" },
		});
	});

	it("never invokes the implementation from intend", async () => {
		const fx = await fixture();
		const { execute, registration } = shoutImpl();
		const ex = executor(fx, [registration]);
		await ex.intend(fx.taskId);
		await ex.intend(fx.taskId);
		expect(execute).not.toHaveBeenCalled();
		const { task, execution } = view(await projection(fx), fx.taskId);
		expect(task.status).toBe("running");
		expect(execution.phase).toBe("support-intended");
		expect(
			(await eventTypes(fx)).filter(
				(type) => type === "task-execution-support-intended",
			),
		).toHaveLength(1);
	});
});

describe("support task executor failures", () => {
	it("fails resolution at intend when the implementation is not registered", async () => {
		const fx = await fixture();
		const ex = executor(fx, []);
		const intent = await ex.intend(fx.taskId);
		expect(intent).toMatchObject({ state: "terminal", outcome: "failed" });
		const state = await expectFailure(
			fx,
			fx.taskId,
			"support-resolution",
			"Support task implementation is not registered.",
		);
		expect(view(state, fx.taskId).execution.supportIntent).toBeUndefined();
	});

	const drifts = [
		["implementationSha256", { implementationSha256: "e".repeat(64) }],
		[
			"outputSchema",
			{
				outputSchema: Type.Object({
					answer: Type.String(),
					extra: Type.Optional(Type.String()),
				}),
			},
		],
		["revision", { revision: 2 }],
	] as const;

	it.each(drifts)(
		"fails resolution when the registered %s drifts from the persisted descriptor",
		async (_label, override) => {
			const fx = await fixture();
			const drifted = defineSupportTask({
				name: shout.implementation,
				moduleSpecifier: MODULE,
				revision: 1,
				implementationSha256: "c".repeat(64),
				...shoutSchemas,
				...override,
			});
			const { execute, registration } = register<{ value: string }>(
				drifted,
				shoutValue,
			);
			const ex = executor(fx, [registration]);
			const intent = await ex.intend(fx.taskId);
			expect(intent).toMatchObject({ state: "terminal", outcome: "failed" });
			expect(execute).not.toHaveBeenCalled();
			await expectFailure(
				fx,
				fx.taskId,
				"support-resolution",
				"Support task implementation does not match the constructor registry.",
			);
		},
	);

	it("fails execution without leaking the thrown error", async () => {
		const fx = await fixture();
		const { registration } = shoutImpl(() => {
			throw new Error("boom /secret/path");
		});
		const ex = executor(fx, [registration]);
		await ex.intend(fx.taskId);
		expect((await ex.execute(fx.taskId)).outcome).toBe("failed");
		const state = await expectFailure(
			fx,
			fx.taskId,
			"support-execution",
			"Support task implementation failed.",
		);
		const events = await fx.journal.readEvents();
		const serialized = JSON.stringify(events);
		expect(serialized).not.toContain("boom");
		expect(serialized).not.toContain("/secret/path");
		expect(serialized).not.toContain("    at ");
		expect(resultArtifacts(state, fx.taskId)).toHaveLength(0);
	});

	it("fails output that violates the output schema", async () => {
		const fx = await fixture();
		const { registration } = shoutImpl(() => ({ answer: 42 }));
		const ex = executor(fx, [registration]);
		await ex.intend(fx.taskId);
		expect((await ex.execute(fx.taskId)).outcome).toBe("failed");
		const state = await expectFailure(
			fx,
			fx.taskId,
			"support-output",
			"Support task output does not match its output schema.",
		);
		expect(resultArtifacts(state, fx.taskId)).toHaveLength(0);
	});

	it.each([
		["undefined property", () => ({ value: undefined })],
		["function", () => () => undefined],
		["bigint", () => ({ answer: 1n })],
		["NaN", () => ({ answer: Number.NaN })],
	])("fails output that is not lossless JSON (%s)", async (_label, produce) => {
		const fx = await fixture();
		const { registration } = shoutImpl(produce);
		const ex = executor(fx, [registration]);
		await ex.intend(fx.taskId);
		expect((await ex.execute(fx.taskId)).outcome).toBe("failed");
		await expectFailure(
			fx,
			fx.taskId,
			"support-output",
			"Support task output is not losslessly JSON serializable.",
		);
	});

	it("fails output that exceeds the artifact byte bound", async () => {
		const fx = await fixture({ maxArtifactBytes: 256 });
		const { registration } = shoutImpl(() => ({ answer: "x".repeat(1024) }));
		const ex = executor(fx, [registration]);
		await ex.intend(fx.taskId);
		expect((await ex.execute(fx.taskId)).outcome).toBe("failed");
		const state = await expectFailure(
			fx,
			fx.taskId,
			"support-output",
			"Support task output exceeds the workflow artifact bound.",
		);
		expect(Object.keys(state.artifacts)).toHaveLength(0);
	});

	it("fails input verification when a producer artifact is corrupt on disk", async () => {
		const fx = await fixture({ consumer: true });
		const producer = shoutImpl();
		const consumer = register<Record<string, never>>(echo, ({ inputs }) => ({
			echoed: inputs.source,
		}));
		const ex = executor(fx, [producer.registration, consumer.registration]);
		const first = await completeProducer(fx, ex);
		await writeFile(
			path.join(fx.artifacts.root, `${first.sha256}.json`),
			"corrupt",
		);
		const consumerId = await readyConsumer(fx);
		expect((await ex.intend(consumerId)).state).toBe("intended");
		expect((await ex.execute(consumerId)).outcome).toBe("failed");
		expect(consumer.execute).not.toHaveBeenCalled();
		await expectFailure(
			fx,
			consumerId,
			"support-input",
			"Support task inputs could not be read and verified.",
		);
	});
});

describe("support task executor recovery", () => {
	it("recovers from a bare execution record", async () => {
		const fx = await fixture();
		const spec = supportSpec(await projection(fx), fx.taskId);
		await fx.journal.append("task-execution-created", {
			execution: {
				kind: "support",
				id: deriveTaskExecutionId(RUN_ID, fx.taskId, 1),
				runId: RUN_ID,
				taskId: fx.taskId,
				generation: 1,
				taskIdentitySha256: spec.identitySha256,
				implementationIdentitySha256: deriveSupportImplementationIdentitySha256(
					spec.request.implementation,
				),
			},
		});
		const before = await eventTypes(fx);
		const { execute, registration } = shoutImpl();
		const ex = executor(await reopen(fx), [registration]);
		expect((await ex.intend(fx.taskId)).state).toBe("intended");
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"task-execution-support-intended",
			"task-status-changed",
		]);
		expect(view(await projection(fx), fx.taskId).task.status).toBe("running");
		expect((await ex.execute(fx.taskId)).outcome).toBe("completed");
		expect(execute).toHaveBeenCalledTimes(1);
		await expectCompleted(fx, fx.taskId);
		expect(
			(await eventTypes(fx)).filter((t) => t === "task-execution-created"),
		).toHaveLength(1);
	});

	it("recovers from persisted intent by executing exactly once", async () => {
		const fx = await fixture();
		await intentOnly(fx);
		const before = await eventTypes(fx);
		const { execute, registration } = shoutImpl();
		const ex = executor(await reopen(fx), [registration]);
		expect((await ex.execute(fx.taskId)).outcome).toBe("completed");
		expect(execute).toHaveBeenCalledTimes(1);
		await expectCompleted(fx, fx.taskId);
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"artifact-declared",
			"task-execution-support-output-committed",
			"task-execution-terminal",
			"task-status-changed",
		]);
	});

	it("recovers from an undeclared artifact file by recomputing to the same id", async () => {
		const fx = await fixture();
		await intentOnly(fx);
		const direct = await declareByHand(
			fx,
			fx.taskId,
			{ answer: "HELLO" },
			false,
		);
		const before = await eventTypes(fx);
		const { execute, registration } = shoutImpl();
		const ex = executor(await reopen(fx), [registration]);
		expect((await ex.execute(fx.taskId)).outcome).toBe("completed");
		expect(execute).toHaveBeenCalledTimes(1);
		const { artifact } = await expectCompleted(fx, fx.taskId);
		expect(artifact).toEqual(direct);
		const types = await eventTypes(fx);
		expect(types.filter((t) => t === "artifact-declared")).toHaveLength(1);
		expect(types.slice(before.length)).toEqual([
			"artifact-declared",
			"task-execution-support-output-committed",
			"task-execution-terminal",
			"task-status-changed",
		]);
	});

	it("recovers from a declared artifact without re-executing", async () => {
		const fx = await fixture();
		await intentOnly(fx);
		const declared = await declareByHand(fx, fx.taskId, { answer: "HELLO" });
		const before = await eventTypes(fx);
		const { execute, registration } = shoutImpl();
		const ex = executor(await reopen(fx), [registration]);
		expect((await ex.execute(fx.taskId)).outcome).toBe("completed");
		expect(execute).not.toHaveBeenCalled();
		const { artifact } = await expectCompleted(fx, fx.taskId);
		expect(artifact).toEqual(declared);
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"task-execution-support-output-committed",
			"task-execution-terminal",
			"task-status-changed",
		]);
	});

	it("recovers from a committed output with zero-duration terminal evidence", async () => {
		const fx = await fixture();
		await intentOnly(fx);
		const declared = await declareByHand(fx, fx.taskId, { answer: "HELLO" });
		await commitByHand(fx, fx.taskId, declared);
		const before = await eventTypes(fx);
		const { execute, registration } = shoutImpl();
		const ex = executor(await reopen(fx), [registration]);
		expect((await ex.execute(fx.taskId)).outcome).toBe("completed");
		expect(execute).not.toHaveBeenCalled();
		const { execution } = await expectCompleted(fx, fx.taskId);
		expect(execution.terminal?.evidence).toMatchObject({ durationMs: 0 });
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"task-execution-terminal",
			"task-status-changed",
		]);
	});

	it("repairs only the task transition after terminal evidence", async () => {
		const fx = await fixture();
		await intentOnly(fx);
		const declared = await declareByHand(fx, fx.taskId, { answer: "HELLO" });
		await commitByHand(fx, fx.taskId, declared);
		await terminalByHand(fx, fx.taskId, declared);
		expect(view(await projection(fx), fx.taskId).task.status).toBe("running");
		const before = await eventTypes(fx);
		const { execute, registration } = shoutImpl();
		const ex = executor(await reopen(fx), [registration]);
		expect(await ex.intend(fx.taskId)).toMatchObject({
			state: "terminal",
			outcome: "completed",
		});
		expect(execute).not.toHaveBeenCalled();
		await expectCompleted(fx, fx.taskId);
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"task-status-changed",
		]);
		const events = await fx.journal.readEvents();
		expect(events.at(-1)?.data).toMatchObject({
			taskId: fx.taskId,
			from: "running",
			to: "completed",
		});
		expect((await ex.execute(fx.taskId)).outcome).toBe("completed");
		expect(await eventTypes(fx)).toHaveLength(events.length);
	});

	it("replays a completed task as a no-op", async () => {
		const fx = await fixture();
		const first = shoutImpl();
		await completeProducer(fx, executor(fx, [first.registration]));
		const before = await fx.journal.readEvents();
		const { execute, registration } = shoutImpl();
		const ex = executor(await reopen(fx), [registration]);
		expect(await ex.intend(fx.taskId)).toMatchObject({
			state: "terminal",
			outcome: "completed",
			runStatus: "running",
		});
		expect((await ex.execute(fx.taskId)).outcome).toBe("completed");
		expect(execute).not.toHaveBeenCalled();
		expect(first.execute).toHaveBeenCalledTimes(1);
		expect(await fx.journal.readEvents()).toEqual(before);
	});

	it("completes persisted intent after a lease rotation", async () => {
		const fx = await fixture();
		await intentOnly(fx);
		const rotated = await reopen(fx, {
			ownerId: "support-executor-replacement",
		});
		expect(rotated.lease.record.ownerId).toBe("support-executor-replacement");
		const { execute, registration } = shoutImpl();
		const ex = executor(rotated, [registration]);
		expect((await ex.execute(fx.taskId)).outcome).toBe("completed");
		expect(execute).toHaveBeenCalledTimes(1);
		await expectCompleted(rotated, fx.taskId);
	});

	it("fails closed on registry drift across a restart", async () => {
		const fx = await fixture();
		await intentOnly(fx);
		const drifted = defineSupportTask({
			name: shout.implementation,
			moduleSpecifier: MODULE,
			revision: 1,
			implementationSha256: "f".repeat(64),
			...shoutSchemas,
		});
		const { execute, registration } = register<{ value: string }>(
			drifted,
			shoutValue,
		);
		const ex = executor(await reopen(fx), [registration]);
		expect((await ex.execute(fx.taskId)).outcome).toBe("failed");
		expect(execute).not.toHaveBeenCalled();
		await expectFailure(
			fx,
			fx.taskId,
			"support-resolution",
			"Support task implementation does not match the constructor registry.",
		);
	});

	it("completes from a foreign but valid declared artifact without executing", async () => {
		const fx = await fixture();
		await intentOnly(fx);
		const manual = await declareByHand(fx, fx.taskId, { answer: "MANUAL" });
		const { execute, registration } = shoutImpl();
		const ex = executor(await reopen(fx), [registration]);
		expect((await ex.execute(fx.taskId)).outcome).toBe("completed");
		expect(execute).not.toHaveBeenCalled();
		const { artifact } = await expectCompleted(fx, fx.taskId);
		expect(artifact).toEqual(manual);
		expect(await fx.artifacts.readJson(artifact)).toEqual({ answer: "MANUAL" });
	});

	it("throws a persistence error when the declared artifact violates the output schema", async () => {
		const fx = await fixture();
		await intentOnly(fx);
		await declareByHand(fx, fx.taskId, { answer: 42 });
		const before = await fx.journal.readEvents();
		const { execute, registration } = shoutImpl();
		const ex = executor(await reopen(fx), [registration]);
		const failure = await ex.execute(fx.taskId).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(WorkflowSupportExecutionError);
		expect((failure as WorkflowSupportExecutionError).stage).toBe(
			"persistence",
		);
		expect(execute).not.toHaveBeenCalled();
		expect(await fx.journal.readEvents()).toEqual(before);
		const { task, execution } = view(await projection(fx), fx.taskId);
		expect(task.status).toBe("running");
		expect(execution.phase).toBe("support-intended");
	});
});

describe("support task executor cancellation", () => {
	it("cancels at intend when stop was already requested", async () => {
		const fx = await fixture();
		const controller = new AbortController();
		controller.abort();
		const { execute, registration } = shoutImpl();
		const ex = executor(fx, [registration], controller);
		expect(await ex.intend(fx.taskId)).toMatchObject({
			state: "terminal",
			outcome: "cancelled",
		});
		expect(execute).not.toHaveBeenCalled();
		const state = await expectCancelled(
			fx,
			fx.taskId,
			"Workflow stop requested.",
		);
		expect(view(state, fx.taskId).execution.supportIntent).toBeUndefined();
	});

	it("cancels before execution when the signal is already aborted", async () => {
		const fx = await fixture();
		const controller = new AbortController();
		const { execute, registration } = shoutImpl();
		const ex = executor(fx, [registration], controller);
		await ex.intend(fx.taskId);
		controller.abort();
		expect((await ex.execute(fx.taskId)).outcome).toBe("cancelled");
		expect(execute).not.toHaveBeenCalled();
		await expectCancelled(fx, fx.taskId, "Workflow stop requested.");
	});

	it("cancels an implementation that settles on abort", async () => {
		const fx = await fixture();
		const controller = new AbortController();
		const started = defer<void>();
		const { execute, registration } = shoutImpl(
			({ signal }) =>
				new Promise((resolve) => {
					expect(signal.aborted).toBe(false);
					started.resolve();
					signal.addEventListener(
						"abort",
						() => resolve({ answer: "aborted" }),
						{ once: true },
					);
				}),
		);
		const ex = executor(fx, [registration], controller);
		await ex.intend(fx.taskId);
		const running = ex.execute(fx.taskId);
		await started.promise;
		controller.abort();
		expect((await running).outcome).toBe("cancelled");
		expect(execute).toHaveBeenCalledTimes(1);
		await expectCancelled(fx, fx.taskId, "Workflow stop requested.");
	});

	it("discards late settlement from implementations that ignore abort", async () => {
		const fx = await fixture({ second: true });
		if (!fx.secondId) throw new Error("fixture has no second task");
		const controller = new AbortController();
		const resolving = defer<{ answer: string }>();
		const rejecting = defer<{ answer: string }>();
		const invoked = defer<void>();
		let count = 0;
		const { execute, registration } = shoutImpl(({ parameters }) => {
			count += 1;
			if (count === 2) invoked.resolve();
			return parameters.value === "hello"
				? resolving.promise
				: rejecting.promise;
		});
		const ex = executor(fx, [registration], controller);
		await ex.intend(fx.taskId);
		await ex.intend(fx.secondId);
		const runs = [ex.execute(fx.taskId), ex.execute(fx.secondId)];
		await invoked.promise;
		controller.abort();
		const outcomes = (await Promise.all(runs)).map((result) => result.outcome);
		expect(outcomes).toEqual(["cancelled", "cancelled"]);
		expect(execute).toHaveBeenCalledTimes(2);
		const before = await fx.journal.readEvents();

		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onRejection);
		try {
			resolving.resolve({ answer: "LATE" });
			rejecting.reject(new Error("late failure"));
			await new Promise((resolve) => setTimeout(resolve, 20));
		} finally {
			process.off("unhandledRejection", onRejection);
		}
		expect(rejections).toEqual([]);
		expect(await fx.journal.readEvents()).toEqual(before);
		await expectCancelled(fx, fx.taskId, "Workflow stop requested.");
		await expectCancelled(fx, fx.secondId, "Workflow stop requested.");
		expect(Object.keys((await projection(fx)).artifacts)).toHaveLength(0);
	});

	it("cancels an intended task and repairs a committed one", async () => {
		const intended = await fixture();
		const { execute, registration } = shoutImpl();
		const ex = executor(intended, [registration]);
		await ex.intend(intended.taskId);
		expect((await ex.cancel(intended.taskId, "Operator stop.")).outcome).toBe(
			"cancelled",
		);
		expect(execute).not.toHaveBeenCalled();
		await expectCancelled(intended, intended.taskId, "Operator stop.");

		const committed = await fixture();
		await intentOnly(committed);
		const declared = await declareByHand(committed, committed.taskId, {
			answer: "HELLO",
		});
		await commitByHand(committed, committed.taskId, declared);
		const repair = shoutImpl();
		const ex2 = executor(await reopen(committed), [repair.registration]);
		expect((await ex2.cancel(committed.taskId, "Operator stop.")).outcome).toBe(
			"completed",
		);
		expect(repair.execute).not.toHaveBeenCalled();
		const { execution } = await expectCompleted(committed, committed.taskId);
		expect(execution.terminal?.evidence).toMatchObject({ durationMs: 0 });
	});
});

describe("support task executor handoff inputs", () => {
	it("digests the handoff by its output and feeds the descriptor to the implementation", async () => {
		const fx = await handoffFixture();
		let seen: SupportTaskExecutionContext<Record<string, never>> | undefined;
		const consumer = register<Record<string, never>>(
			describePatch,
			(context) => {
				seen = context;
				const patch = context.inputs.patch as WorkflowHandoffDescriptor;
				return { commit: patch.handoffCommit, bytes: patch.bytes };
			},
		);
		const ex = executor(fx, [consumer.registration]);
		const consumerId = await readyConsumer(fx);
		expect((await ex.intend(consumerId)).state).toBe("intended");
		// Spec 2.3: the intent digest selects the handoff artifact by ref.output
		// and the reducer accepted it, so taskInputsSha256 agrees.
		const { execution } = view(await projection(fx), consumerId);
		expect(execution.supportIntent?.inputsSha256).toBe(
			deriveJsonValueSha256({ patch: fx.patch.sha256 }),
		);

		expect((await ex.execute(consumerId)).outcome).toBe("completed");
		expect(consumer.execute).toHaveBeenCalledTimes(1);
		if (!seen) throw new Error("consumer was not invoked");
		const state = await projection(fx);
		const descriptor = deriveWorkflowHandoffDescriptor(
			fx.patch,
			executionOf(state, fx.writerExecutionId),
		);
		expect(seen.inputs).toEqual({ patch: descriptor });
		expect(descriptor).toMatchObject({
			format: "git-format-patch",
			mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
			handoffCommit: HANDOFF_COMMIT,
			baselineHead: BASELINE_HEAD,
			producerExecutionId: fx.writerExecutionId,
		});
		expect(JSON.stringify(seen.inputs)).not.toContain("Mon Sep 17");
		expect(Object.getPrototypeOf(seen.inputs)).toBeNull();
		expect(Object.isFrozen(seen.inputs.patch)).toBe(true);
		const { artifact } = await expectCompleted(fx, consumerId);
		expect(await fx.artifacts.readJson(artifact)).toEqual({
			commit: HANDOFF_COMMIT,
			bytes: fx.patch.bytes,
		});
	});

	it("fails input verification when the handoff blob does not verify", async () => {
		const fx = await handoffFixture();
		const consumer = register<Record<string, never>>(describePatch, () => ({
			commit: "never",
			bytes: 1,
		}));
		const ex = executor(fx, [consumer.registration]);
		await writeFile(
			path.join(fx.artifacts.root, `${fx.patch.sha256}.patch`),
			"corrupt",
		);
		const consumerId = await readyConsumer(fx);
		expect((await ex.intend(consumerId)).state).toBe("intended");
		expect((await ex.execute(consumerId)).outcome).toBe("failed");
		expect(consumer.execute).not.toHaveBeenCalled();
		await expectFailure(
			fx,
			consumerId,
			"support-input",
			"Support task inputs could not be read and verified.",
		);
	});
});
