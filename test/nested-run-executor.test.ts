import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import {
	canonicalArtifactJson,
	WorkflowArtifactStore,
} from "../src/artifact-store.js";
import type {
	MaterializedNestedWorkflowTask,
	NestedWorkflowInputArtifacts,
	NestedWorkflowTaskRequest,
	NestedWorkflowUsage,
	WorkflowArtifactRef,
	WorkflowRunId,
	WorkflowTaskId,
} from "../src/contracts.js";
import type {
	TaskExecutionProjection,
	WorkflowStateProjection,
	WorkflowTaskProjection,
} from "../src/events.js";
import {
	deriveJsonValueSha256,
	deriveNestedWorkflowRunId,
	deriveTaskExecutionId,
	deriveWorkflowArtifactId,
	deriveWorkflowFailureSha256,
} from "../src/execution.js";
import {
	deriveWorkflowTaskId,
	WorkflowTaskMaterializer,
} from "../src/materializer.js";
import {
	createWorkflowNestedRunExecutor,
	type NestedWorkflowTerminalStatus,
	WorkflowNestedRunError,
	type WorkflowNestedRunExecutor,
	type WorkflowNestedRunExecutorOptions,
	type WorkflowNestedRunProvider,
	type WorkflowNestedRunSettlement,
} from "../src/nested-run-executor.js";
import { WorkflowRunJournal } from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
	type WorkflowRunLease,
} from "../src/persistence/run-lease.js";
import { reduceWorkflowEvents } from "../src/reducer.js";
import { defineSupportTask } from "../src/support.js";
import { createWorkflowSupportTaskExecutor } from "../src/support-executor.js";

const RUN_ID = "workflow_nestedrunexecutor";
const parentIdentitySha256 = "a".repeat(64);
const inputSha256 = "b".repeat(64);
const childIdentitySha256 = "c".repeat(64);
const childSourceSha256 = "d".repeat(64);
const FAR_FUTURE_MS = 24 * 60 * 60 * 1_000;
const CHILD_TIMEOUT_MS = 600_000;
const CHILD_INPUT = { value: "yes" };
const OUTPUT_SCHEMA = {
	type: "object",
	properties: { answer: { type: "string" } },
	required: ["answer"],
	additionalProperties: false,
};
const USAGE: NestedWorkflowUsage = {
	cost: 0.5,
	totalTokens: 1_200,
	childRuntimeMs: 4_000,
};
const leases = new Set<WorkflowRunLease>();

const supportHelper = defineSupportTask({
	name: "@vegardx/workflow-tools/noop",
	moduleSpecifier: "@vegardx/workflow-tools",
	revision: 1,
	implementationSha256: "f".repeat(64),
	parametersSchema: Type.Object({}),
	outputSchema: Type.Object({ ok: Type.Boolean() }),
});

function nestedRequest(
	overrides: Partial<NestedWorkflowTaskRequest> = {},
): NestedWorkflowTaskRequest {
	return {
		definitionName: "child",
		definitionIdentitySha256: childIdentitySha256,
		definitionSourceSha256: childSourceSha256,
		definitionVersion: 1,
		input: CHILD_INPUT,
		inputSha256: deriveJsonValueSha256(CHILD_INPUT),
		inputSchema: {
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
			additionalProperties: false,
		},
		outputSchema: OUTPUT_SCHEMA,
		budget: { cost: 10, totalTokens: 100_000, childRuntimeMs: 600_000 },
		timeoutMs: CHILD_TIMEOUT_MS,
		concurrency: 2,
		...overrides,
	};
}

function farFuture(): string {
	return new Date(Date.now() + FAR_FUTURE_MS).toISOString();
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

async function isPending(promise: Promise<unknown>): Promise<boolean> {
	const outcome = await Promise.race([
		promise.then(
			() => "settled",
			() => "settled",
		),
		new Promise<"pending">((resolve) =>
			setTimeout(() => resolve("pending"), 0),
		),
	]);
	return outcome === "pending";
}

interface Fixture {
	readonly root: string;
	readonly lease: WorkflowRunLease;
	readonly journal: WorkflowRunJournal;
	readonly artifacts: WorkflowArtifactStore;
	readonly taskId: WorkflowTaskId;
	readonly supportId: WorkflowTaskId | undefined;
	readonly executionId: TaskExecutionProjection["execution"]["id"];
	readonly childRunId: WorkflowRunId;
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

async function fixture(options: { support?: boolean } = {}): Promise<Fixture> {
	const root = path.resolve(
		".pi",
		"test-nested-run-executor",
		`run-${randomUUID()}`,
	);
	const { lease, journal } = await openJournal(root, "nested-executor-test");
	await journal.append("run-created", {
		definitionIdentitySha256: parentIdentitySha256,
		inputSha256,
	});
	const materializer = new WorkflowTaskMaterializer({
		runId: RUN_ID,
		definitionIdentitySha256: parentIdentitySha256,
		inputSha256,
	});
	const child = materializer.workflow("child", { request: nestedRequest() });
	const support = options.support
		? materializer.support("helper", supportHelper({ parameters: {} }))
		: undefined;
	const leaves = [child, ...(support ? [support] : [])];
	for (const event of materializer.closeEpoch("final", leaves).events) {
		await journal.appendEvent(event);
	}
	await journal.append("run-status-changed", {
		from: "created",
		to: "running",
	});
	await journal.append("task-status-changed", {
		taskId: child.ref.taskId,
		from: "pending",
		to: "ready",
	});
	const artifacts = await WorkflowArtifactStore.open({ journal });
	return {
		root,
		lease,
		journal,
		artifacts,
		taskId: child.ref.taskId,
		supportId: support?.ref.taskId,
		executionId: deriveTaskExecutionId(RUN_ID, child.ref.taskId, 1),
		childRunId: deriveNestedWorkflowRunId(RUN_ID, child.ref.taskId, 1),
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
	const artifacts = await WorkflowArtifactStore.open({ journal });
	return { ...fx, lease, journal, artifacts };
}

type ProviderSpies = {
	[K in keyof WorkflowNestedRunProvider]: Mock<WorkflowNestedRunProvider[K]>;
};

interface ChildOutput {
	readonly artifact: WorkflowArtifactRef;
	readonly value: unknown;
}

function fakeProvider(
	options: {
		settlement?: WorkflowNestedRunSettlement;
		output?: ChildOutput;
	} = {},
): ProviderSpies {
	return {
		launch: vi.fn<WorkflowNestedRunProvider["launch"]>(async () => {}),
		wait: vi.fn<WorkflowNestedRunProvider["wait"]>(async () => {
			if (!options.settlement) throw new Error("no settlement configured");
			return options.settlement;
		}),
		readOutput: vi.fn<WorkflowNestedRunProvider["readOutput"]>(async () => {
			if (!options.output) throw new Error("no output configured");
			return options.output;
		}),
		stop: vi.fn<WorkflowNestedRunProvider["stop"]>(async () => {}),
		reconcile: vi.fn<WorkflowNestedRunProvider["reconcile"]>(async () => {}),
	};
}

function outputSchemaSha256(): string {
	return deriveJsonValueSha256(OUTPUT_SCHEMA);
}

/** Fabricates the child-owned output artifact exactly as the child store would. */
function childOutput(
	childRunId: WorkflowRunId,
	value: unknown,
	schemaSha256 = outputSchemaSha256(),
): ChildOutput {
	const content = canonicalArtifactJson(value);
	const sha256 = createHash("sha256").update(content).digest("hex");
	return {
		artifact: {
			id: deriveWorkflowArtifactId({ runId: childRunId, schemaSha256, sha256 }),
			runId: childRunId,
			sha256,
			bytes: content.byteLength,
			mediaType: "application/json",
			schemaSha256,
		},
		value,
	};
}

function settlement(
	status: NestedWorkflowTerminalStatus,
	output?: ChildOutput,
): WorkflowNestedRunSettlement {
	return {
		status,
		usage: USAGE,
		usageComplete: true,
		...(output ? { outputArtifact: output.artifact } : {}),
	};
}

function executor(
	fx: Fixture,
	provider: WorkflowNestedRunProvider,
	nesting: Partial<WorkflowNestedRunExecutorOptions["nesting"]> = {},
): WorkflowNestedRunExecutor {
	return createWorkflowNestedRunExecutor({
		journal: fx.journal,
		artifacts: fx.artifacts,
		provider,
		nesting: {
			depth: 0,
			ancestorDefinitionIdentities: [],
			definitionIdentitySha256: parentIdentitySha256,
			deadlineAt: farFuture(),
			...nesting,
		},
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
	spec: MaterializedNestedWorkflowTask["spec"];
	execution: TaskExecutionProjection | undefined;
} {
	const task = state.tasks[taskId];
	if (!task) throw new Error("missing task projection");
	if (task.task.spec.kind !== "workflow")
		throw new Error("not a workflow task");
	const execution = task.currentExecutionId
		? state.executions[task.currentExecutionId]
		: undefined;
	return { task, spec: task.task.spec, execution };
}

async function current(fx: Fixture) {
	return view(await projection(fx), fx.taskId);
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

async function terminalEventCount(fx: Fixture): Promise<number> {
	return (await eventTypes(fx)).filter(
		(type) => type === "task-execution-terminal",
	).length;
}

async function createdByHand(fx: Fixture): Promise<void> {
	const { spec } = await current(fx);
	await fx.journal.append("task-execution-created", {
		execution: {
			kind: "workflow",
			id: fx.executionId,
			runId: RUN_ID,
			taskId: fx.taskId,
			generation: 1,
			taskIdentitySha256: spec.identitySha256,
			childRunId: fx.childRunId,
		},
	});
}

async function intendedByHand(fx: Fixture): Promise<void> {
	await createdByHand(fx);
	const request = nestedRequest();
	await fx.journal.append("task-execution-nested-intended", {
		executionId: fx.executionId,
		childRunId: fx.childRunId,
		definitionIdentitySha256: request.definitionIdentitySha256,
		inputSha256: request.inputSha256,
		inputsSha256: deriveJsonValueSha256({}),
		resolvedInputSha256: request.inputSha256,
		budget: request.budget,
		timeoutMs: request.timeoutMs,
		deadlineAt: new Date(Date.now() + request.timeoutMs).toISOString(),
		concurrency: request.concurrency,
	});
}

async function launchedByHand(fx: Fixture): Promise<void> {
	await intendedByHand(fx);
	await fx.journal.append("task-execution-nested-launched", {
		executionId: fx.executionId,
		childRunId: fx.childRunId,
	});
	await fx.journal.append("task-status-changed", {
		taskId: fx.taskId,
		from: "ready",
		to: "running",
	});
}

async function settledByHand(
	fx: Fixture,
	settled: WorkflowNestedRunSettlement,
): Promise<void> {
	await fx.journal.append("task-execution-nested-settled", {
		executionId: fx.executionId,
		childRunId: fx.childRunId,
		status: settled.status,
		usage: settled.usage,
		usageComplete: settled.usageComplete,
		...(settled.outputArtifact
			? {
					outputArtifactId: settled.outputArtifact.id,
					outputSha256: settled.outputArtifact.sha256,
				}
			: {}),
	});
}

async function importedByHand(
	fx: Fixture,
	output: ChildOutput,
	declare = true,
): Promise<WorkflowArtifactRef> {
	const artifact = await fx.artifacts.putJson(output.value, {
		runId: RUN_ID,
		producerTaskId: fx.taskId,
		output: "result",
		schemaSha256: outputSchemaSha256(),
	});
	if (!declare) return artifact;
	await fx.journal.append("artifact-declared", { artifact });
	await fx.journal.append("task-execution-nested-output-imported", {
		executionId: fx.executionId,
		childRunId: fx.childRunId,
		artifactId: artifact.id,
		sourceArtifactId: output.artifact.id,
		sourceSha256: output.artifact.sha256,
	});
	return artifact;
}

async function terminalByHand(
	fx: Fixture,
	artifact: WorkflowArtifactRef,
): Promise<void> {
	await fx.journal.append("task-execution-terminal", {
		executionId: fx.executionId,
		outcome: "completed",
		evidence: {
			kind: "nested-workflow",
			childRunId: fx.childRunId,
			status: "completed",
			usage: USAGE,
			usageComplete: true,
			outputSha256: artifact.sha256,
			artifactId: artifact.id,
		},
	});
}

async function expectLaunched(fx: Fixture): Promise<TaskExecutionProjection> {
	const { task, execution } = await current(fx);
	expect(task.status).toBe("running");
	expect(execution?.phase).toBe("nested-launched");
	expect(execution?.nestedLaunch).toMatchObject({ childRunId: fx.childRunId });
	if (!execution) throw new Error("missing execution");
	return execution;
}

async function expectWorkflowFailure(
	fx: Fixture,
	outcome: "failed" | "cancelled" | "cleanup-blocked",
	stage:
		| "nested-resolution"
		| "nested-input"
		| "nested-launch"
		| "nested-import"
		| "stop",
	message: string,
): Promise<WorkflowStateProjection> {
	const state = await projection(fx);
	const { task, execution } = view(state, fx.taskId);
	expect(task.status).toBe(outcome);
	expect(execution?.phase).toBe("terminal");
	expect(execution?.terminal).toMatchObject({
		outcome,
		evidence: {
			kind: "workflow",
			stage,
			message,
			failureSha256: deriveWorkflowFailureSha256(stage, message),
		},
	});
	expect(resultArtifacts(state, fx.taskId)).toHaveLength(0);
	return state;
}

async function expectNestedTerminal(
	fx: Fixture,
	status: Exclude<
		NestedWorkflowTerminalStatus,
		"completed" | "completed-degraded"
	>,
): Promise<WorkflowStateProjection> {
	const state = await projection(fx);
	const { task, execution } = view(state, fx.taskId);
	expect(task.status).toBe(status);
	expect(execution?.phase).toBe("terminal");
	expect(execution?.nestedSettlement).toMatchObject({
		childRunId: fx.childRunId,
		status,
		usage: USAGE,
		usageComplete: true,
	});
	expect(execution?.nestedSettlement?.outputArtifactId).toBeUndefined();
	expect(execution?.nestedSettlement?.outputSha256).toBeUndefined();
	expect(execution?.nestedOutputImport).toBeUndefined();
	expect(execution?.terminal).toEqual({
		outcome: status,
		evidence: {
			kind: "nested-workflow",
			childRunId: fx.childRunId,
			status,
			usage: USAGE,
			usageComplete: true,
		},
		sequence: expect.any(Number),
	});
	expect(resultArtifacts(state, fx.taskId)).toHaveLength(0);
	return state;
}

async function expectCompleted(
	fx: Fixture,
	output: ChildOutput,
	status: "completed" | "completed-degraded" = "completed",
): Promise<{
	state: WorkflowStateProjection;
	artifact: WorkflowArtifactRef;
	execution: TaskExecutionProjection;
}> {
	const state = await projection(fx);
	const { task, spec, execution } = view(state, fx.taskId);
	if (!execution) throw new Error("missing execution");
	expect(task.status).toBe("completed");
	expect(execution.phase).toBe("terminal");
	const artifacts = resultArtifacts(state, fx.taskId);
	expect(artifacts).toHaveLength(1);
	const artifact = artifacts[0] as WorkflowArtifactRef;
	const schemaSha256 = deriveJsonValueSha256(spec.request.outputSchema);
	expect(schemaSha256).toBe(outputSchemaSha256());
	expect(artifact).toEqual({
		id: deriveWorkflowArtifactId({
			runId: RUN_ID,
			producerTaskId: fx.taskId,
			output: "result",
			schemaSha256,
			sha256: output.artifact.sha256,
		}),
		runId: RUN_ID,
		producerTaskId: fx.taskId,
		output: "result",
		sha256: output.artifact.sha256,
		bytes: output.artifact.bytes,
		mediaType: "application/json",
		schemaSha256,
	});
	expect(execution.nestedSettlement).toMatchObject({
		childRunId: fx.childRunId,
		status,
		usage: USAGE,
		usageComplete: true,
		outputArtifactId: output.artifact.id,
		outputSha256: output.artifact.sha256,
	});
	expect(execution.nestedOutputImport).toMatchObject({
		childRunId: fx.childRunId,
		artifactId: artifact.id,
		sourceArtifactId: output.artifact.id,
		sourceSha256: output.artifact.sha256,
	});
	expect(execution.terminal).toEqual({
		outcome: "completed",
		evidence: {
			kind: "nested-workflow",
			childRunId: fx.childRunId,
			status,
			usage: USAGE,
			usageComplete: true,
			outputSha256: output.artifact.sha256,
			artifactId: artifact.id,
		},
		sequence: expect.any(Number),
	});
	expect(await fx.artifacts.readJson(artifact)).toEqual(output.value);
	return { state, artifact, execution };
}

afterEach(async () => {
	await Promise.all([...leases].map((lease) => lease.release()));
	leases.clear();
});

describe("nested run executor launch", () => {
	it("records, intends, launches the child, and marks the task running", async () => {
		const fx = await fixture();
		const before = await eventTypes(fx);
		const provider = fakeProvider();
		const ex = executor(fx, provider);
		const started = Date.now();
		const outcome = await ex.launch(fx.taskId);
		const finished = Date.now();

		expect(outcome).toEqual({
			taskId: fx.taskId,
			executionId: fx.executionId,
			state: "launched",
			runStatus: "running",
		});
		expect(fx.childRunId).toBe(deriveNestedWorkflowRunId(RUN_ID, fx.taskId, 1));
		const { spec, execution } = await current(fx);
		if (!execution) throw new Error("missing execution");
		expect(execution.execution).toEqual({
			kind: "workflow",
			id: fx.executionId,
			runId: RUN_ID,
			taskId: fx.taskId,
			generation: 1,
			taskIdentitySha256: spec.identitySha256,
			childRunId: fx.childRunId,
		});
		const intent = execution.nestedIntent;
		if (!intent) throw new Error("missing intent");
		expect(intent).toMatchObject({
			childRunId: fx.childRunId,
			definitionIdentitySha256: childIdentitySha256,
			inputSha256: deriveJsonValueSha256(CHILD_INPUT),
			budget: spec.request.budget,
			timeoutMs: spec.request.timeoutMs,
			concurrency: spec.request.concurrency,
		});
		expect(intent.timeoutMs).toBe(CHILD_TIMEOUT_MS);
		const deadline = Date.parse(intent.deadlineAt);
		expect(deadline).toBeGreaterThanOrEqual(started + CHILD_TIMEOUT_MS);
		expect(deadline).toBeLessThanOrEqual(finished + CHILD_TIMEOUT_MS);
		await expectLaunched(fx);

		expect(provider.launch).toHaveBeenCalledTimes(1);
		expect(provider.launch).toHaveBeenCalledWith({
			childRunId: fx.childRunId,
			parent: {
				runId: RUN_ID,
				taskId: fx.taskId,
				executionId: fx.executionId,
				depth: 1,
				ancestorDefinitionIdentities: [parentIdentitySha256],
			},
			definitionName: "child",
			definitionIdentitySha256: childIdentitySha256,
			definitionSourceSha256: childSourceSha256,
			input: CHILD_INPUT,
			inputArtifacts: {},
			budget: spec.request.budget,
			deadlineAt: intent.deadlineAt,
			concurrency: spec.request.concurrency,
		});
		expect(provider.wait).not.toHaveBeenCalled();
		expect(provider.readOutput).not.toHaveBeenCalled();
		expect(provider.stop).not.toHaveBeenCalled();
		expect(provider.reconcile).not.toHaveBeenCalled();
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"task-execution-created",
			"task-execution-nested-intended",
			"task-execution-nested-launched",
			"task-status-changed",
		]);
	});

	it("bounds the child timeout by the parent deadline", async () => {
		const fx = await fixture();
		const provider = fakeProvider();
		const remainingMs = 30_000;
		const parentDeadline = Date.now() + remainingMs;
		const ex = executor(fx, provider, {
			deadlineAt: new Date(parentDeadline).toISOString(),
		});
		expect((await ex.launch(fx.taskId)).state).toBe("launched");

		const { execution } = await current(fx);
		const intent = execution?.nestedIntent;
		if (!intent) throw new Error("missing intent");
		expect(intent.timeoutMs).toBeLessThanOrEqual(remainingMs);
		expect(intent.timeoutMs).toBeGreaterThanOrEqual(remainingMs - 5_000);
		expect(Date.parse(intent.deadlineAt)).toBeLessThanOrEqual(parentDeadline);
		expect(provider.launch).toHaveBeenCalledTimes(1);
		expect(provider.launch.mock.calls[0]?.[0].deadlineAt).toBe(
			intent.deadlineAt,
		);
	});

	it.each([
		["already passed", -1_000],
		["under one second away", 500],
	])(
		"fails the launch when the parent deadline is %s",
		async (_label, offsetMs) => {
			const fx = await fixture();
			const before = await eventTypes(fx);
			const provider = fakeProvider();
			const ex = executor(fx, provider, {
				deadlineAt: new Date(Date.now() + offsetMs).toISOString(),
			});
			expect(await ex.launch(fx.taskId)).toEqual({
				taskId: fx.taskId,
				executionId: fx.executionId,
				state: "terminal",
				outcome: "failed",
				runStatus: "running",
			});
			expect(provider.launch).not.toHaveBeenCalled();
			const state = await expectWorkflowFailure(
				fx,
				"failed",
				"nested-launch",
				"Nested workflow has no remaining time before the parent deadline.",
			);
			expect(view(state, fx.taskId).execution?.nestedIntent).toBeUndefined();
			expect((await eventTypes(fx)).slice(before.length)).toEqual([
				"task-execution-created",
				"task-execution-terminal",
				"task-status-changed",
			]);
		},
	);

	it.each([
		[
			"resolution",
			"nested-resolution",
			"Nested workflow definition could not be resolved exactly.",
		],
		["launch", "nested-launch", "Nested workflow run could not be launched."],
	] as const)(
		"fails closed when the provider reports a %s error",
		async (stage, terminalStage, message) => {
			const fx = await fixture();
			const provider = fakeProvider();
			provider.launch.mockRejectedValueOnce(
				new WorkflowNestedRunError(stage, "provider detail"),
			);
			const ex = executor(fx, provider);
			expect(await ex.launch(fx.taskId)).toMatchObject({
				state: "terminal",
				outcome: "failed",
			});
			expect(provider.launch).toHaveBeenCalledTimes(1);
			const state = await expectWorkflowFailure(
				fx,
				"failed",
				terminalStage,
				message,
			);
			expect(view(state, fx.taskId).execution?.nestedIntent).toBeDefined();
			expect(view(state, fx.taskId).execution?.nestedLaunch).toBeUndefined();
		},
	);

	it("rejects an unclassified provider launch failure without terminal evidence", async () => {
		const fx = await fixture();
		const before = await eventTypes(fx);
		const provider = fakeProvider();
		provider.launch.mockRejectedValueOnce(new Error("boom"));
		const ex = executor(fx, provider);
		await expect(ex.launch(fx.taskId)).rejects.toThrow("boom");
		expect(provider.launch).toHaveBeenCalledTimes(1);
		const { task, execution } = await current(fx);
		expect(task.status).toBe("ready");
		expect(execution?.phase).toBe("nested-intended");
		expect(execution?.terminal).toBeUndefined();
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"task-execution-created",
			"task-execution-nested-intended",
		]);

		const retry = executor(await reopen(fx), provider);
		expect((await retry.launch(fx.taskId)).state).toBe("launched");
		expect(provider.launch).toHaveBeenCalledTimes(2);
		await expectLaunched(fx);
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"task-execution-created",
			"task-execution-nested-intended",
			"task-execution-nested-launched",
			"task-status-changed",
		]);
	});

	it("launches the child exactly once across repeated launches", async () => {
		const fx = await fixture();
		const provider = fakeProvider();
		expect((await executor(fx, provider).launch(fx.taskId)).state).toBe(
			"launched",
		);
		const after = await eventTypes(fx);
		const again = await executor(await reopen(fx), provider).launch(fx.taskId);
		expect(again).toEqual({
			taskId: fx.taskId,
			executionId: fx.executionId,
			state: "launched",
			runStatus: "running",
		});
		expect(provider.launch).toHaveBeenCalledTimes(1);
		expect(await eventTypes(fx)).toEqual(after);
		await expectLaunched(fx);
	});
});

describe("nested run executor wait", () => {
	it.each(["completed", "completed-degraded"] as const)(
		"imports the output of a %s child and completes the task",
		async (status) => {
			const fx = await fixture();
			const output = childOutput(fx.childRunId, { answer: "YES" });
			const provider = fakeProvider({
				settlement: settlement(status, output),
				output,
			});
			const ex = executor(fx, provider);
			await ex.launch(fx.taskId);
			const before = await eventTypes(fx);

			expect(await ex.wait(fx.taskId)).toEqual({
				taskId: fx.taskId,
				executionId: fx.executionId,
				outcome: "completed",
				runStatus: "running",
			});
			expect(provider.wait).toHaveBeenCalledTimes(1);
			expect(provider.wait).toHaveBeenCalledWith(fx.childRunId);
			expect(provider.readOutput).toHaveBeenCalledTimes(1);
			expect(provider.readOutput).toHaveBeenCalledWith(
				fx.childRunId,
				output.artifact.id,
			);
			expect(provider.stop).not.toHaveBeenCalled();
			expect(provider.reconcile).not.toHaveBeenCalled();
			const { artifact } = await expectCompleted(fx, output, status);
			expect(artifact.producerTaskId).toBe(fx.taskId);
			expect((await eventTypes(fx)).slice(before.length)).toEqual([
				"task-execution-nested-settled",
				"artifact-declared",
				"task-execution-nested-output-imported",
				"task-execution-terminal",
				"task-status-changed",
			]);
		},
	);

	it.each(["failed", "cancelled", "interrupted", "cleanup-blocked"] as const)(
		"terminalizes a %s child without importing output",
		async (status) => {
			const fx = await fixture();
			const provider = fakeProvider({ settlement: settlement(status) });
			const ex = executor(fx, provider);
			await ex.launch(fx.taskId);
			const before = await eventTypes(fx);

			expect(await ex.wait(fx.taskId)).toEqual({
				taskId: fx.taskId,
				executionId: fx.executionId,
				outcome: status,
				runStatus: "running",
			});
			expect(provider.readOutput).not.toHaveBeenCalled();
			await expectNestedTerminal(fx, status);
			expect((await eventTypes(fx)).slice(before.length)).toEqual([
				"task-execution-nested-settled",
				"task-execution-terminal",
				"task-status-changed",
			]);
		},
	);

	it("fails closed when a completed child reports no output artifact", async () => {
		const fx = await fixture();
		const provider = fakeProvider({ settlement: settlement("completed") });
		const ex = executor(fx, provider);
		await ex.launch(fx.taskId);
		const before = await eventTypes(fx);
		await expect(ex.wait(fx.taskId)).rejects.toThrow(
			"Completed nested workflow run has no output artifact.",
		);
		expect(await eventTypes(fx)).toEqual(before);
		const { task, execution } = await current(fx);
		expect(task.status).toBe("running");
		expect(execution?.phase).toBe("nested-launched");
	});
});

describe("nested run executor import failures", () => {
	const importMessage = "Nested workflow output could not be imported.";

	async function launchedWith(
		options: Parameters<typeof fakeProvider>[0],
	): Promise<{
		fx: Fixture;
		provider: ProviderSpies;
		ex: WorkflowNestedRunExecutor;
	}> {
		const fx = await fixture();
		const provider = fakeProvider(options);
		const ex = executor(fx, provider);
		await ex.launch(fx.taskId);
		return { fx, provider, ex };
	}

	async function expectImportBlocked(
		fx: Fixture,
		output: ChildOutput,
		message: string,
	): Promise<void> {
		const state = await expectWorkflowFailure(
			fx,
			"cleanup-blocked",
			"nested-import",
			message,
		);
		const { execution } = view(state, fx.taskId);
		expect(execution?.nestedSettlement).toMatchObject({
			status: "completed",
			outputArtifactId: output.artifact.id,
			outputSha256: output.artifact.sha256,
		});
		expect(execution?.nestedOutputImport).toBeUndefined();
		expect(Object.keys(state.artifacts)).toHaveLength(0);
	}

	it("blocks cleanup when the child output cannot be read", async () => {
		const output = childOutput("workflow_other", { answer: "YES" });
		const { fx, provider, ex } = await launchedWith({
			settlement: settlement("completed", output),
		});
		provider.readOutput.mockRejectedValueOnce(new Error("disk gone"));
		const before = await eventTypes(fx);
		expect(await ex.wait(fx.taskId)).toMatchObject({
			outcome: "cleanup-blocked",
		});
		expect(provider.readOutput).toHaveBeenCalledTimes(1);
		await expectImportBlocked(fx, output, importMessage);
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"task-execution-nested-settled",
			"task-execution-terminal",
			"task-status-changed",
		]);
	});

	it("blocks cleanup when the child output violates the output schema", async () => {
		const fx = await fixture();
		const output = childOutput(fx.childRunId, { answer: 5 });
		const provider = fakeProvider({
			settlement: settlement("completed", output),
			output,
		});
		const ex = executor(fx, provider);
		await ex.launch(fx.taskId);
		expect(await ex.wait(fx.taskId)).toMatchObject({
			outcome: "cleanup-blocked",
		});
		await expectImportBlocked(
			fx,
			output,
			"Nested workflow output does not match its output schema.",
		);
	});

	it("blocks cleanup when the read artifact does not match the settlement", async () => {
		const fx = await fixture();
		const output = childOutput(fx.childRunId, { answer: "YES" });
		const drifted = childOutput(fx.childRunId, { answer: "NO" });
		const provider = fakeProvider({
			settlement: settlement("completed", output),
			output: { artifact: drifted.artifact, value: drifted.value },
		});
		const ex = executor(fx, provider);
		await ex.launch(fx.taskId);
		expect(await ex.wait(fx.taskId)).toMatchObject({
			outcome: "cleanup-blocked",
		});
		await expectImportBlocked(fx, output, importMessage);
	});

	it.each([
		[
			"run",
			(artifact: WorkflowArtifactRef) => ({ ...artifact, runId: RUN_ID }),
		],
		[
			"media type",
			(artifact: WorkflowArtifactRef) => ({
				...artifact,
				mediaType: "text/plain",
			}),
		],
		[
			"schema",
			(artifact: WorkflowArtifactRef) => ({
				...artifact,
				schemaSha256: "e".repeat(64),
			}),
		],
	] as const)(
		"blocks cleanup when the read artifact %s is foreign",
		async (_label, mutate) => {
			const fx = await fixture();
			const output = childOutput(fx.childRunId, { answer: "YES" });
			const provider = fakeProvider({
				settlement: settlement("completed", output),
				output: { artifact: mutate(output.artifact), value: output.value },
			});
			const ex = executor(fx, provider);
			await ex.launch(fx.taskId);
			expect(await ex.wait(fx.taskId)).toMatchObject({
				outcome: "cleanup-blocked",
			});
			await expectImportBlocked(fx, output, importMessage);
		},
	);

	it("blocks cleanup when the read value does not hash to the settled digest", async () => {
		const fx = await fixture();
		const output = childOutput(fx.childRunId, { answer: "YES" });
		const provider = fakeProvider({
			settlement: settlement("completed", output),
			output: { artifact: output.artifact, value: { answer: "NO" } },
		});
		const ex = executor(fx, provider);
		await ex.launch(fx.taskId);
		expect(await ex.wait(fx.taskId)).toMatchObject({
			outcome: "cleanup-blocked",
		});
		await expectImportBlocked(fx, output, importMessage);
	});
});

describe("nested run executor recovery", () => {
	it("recovers from a bare execution record", async () => {
		const fx = await fixture();
		await createdByHand(fx);
		const before = await eventTypes(fx);
		const provider = fakeProvider();
		const ex = executor(await reopen(fx), provider);
		expect((await ex.launch(fx.taskId)).state).toBe("launched");
		expect(provider.launch).toHaveBeenCalledTimes(1);
		await expectLaunched(fx);
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"task-execution-nested-intended",
			"task-execution-nested-launched",
			"task-status-changed",
		]);
	});

	it("recovers from persisted intent by launching exactly once without re-intending", async () => {
		const fx = await fixture();
		await intendedByHand(fx);
		const before = await eventTypes(fx);
		const intentBefore = (await current(fx)).execution?.nestedIntent;
		const provider = fakeProvider();
		const rotated = await reopen(fx, {
			ownerId: "nested-executor-replacement",
		});
		expect(rotated.lease.record.ownerId).toBe("nested-executor-replacement");
		const ex = executor(rotated, provider);
		expect((await ex.launch(fx.taskId)).state).toBe("launched");
		expect(provider.launch).toHaveBeenCalledTimes(1);
		expect(provider.launch.mock.calls[0]?.[0]).toMatchObject({
			childRunId: fx.childRunId,
			budget: intentBefore?.budget,
			deadlineAt: intentBefore?.deadlineAt,
			concurrency: intentBefore?.concurrency,
		});
		const execution = await expectLaunched(rotated);
		expect(execution.nestedIntent).toEqual(intentBefore);
		expect((await eventTypes(rotated)).slice(before.length)).toEqual([
			"task-execution-nested-launched",
			"task-status-changed",
		]);
	});

	it("recovers from a launched child by waiting without relaunching", async () => {
		const fx = await fixture();
		await launchedByHand(fx);
		const before = await eventTypes(fx);
		const output = childOutput(fx.childRunId, { answer: "YES" });
		const provider = fakeProvider({
			settlement: settlement("completed", output),
			output,
		});
		const ex = executor(await reopen(fx), provider);
		expect((await ex.wait(fx.taskId)).outcome).toBe("completed");
		expect(provider.launch).not.toHaveBeenCalled();
		expect(provider.wait).toHaveBeenCalledTimes(1);
		expect(provider.wait).toHaveBeenCalledWith(fx.childRunId);
		await expectCompleted(fx, output);
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"task-execution-nested-settled",
			"artifact-declared",
			"task-execution-nested-output-imported",
			"task-execution-terminal",
			"task-status-changed",
		]);
	});

	it("recovers from a persisted settlement by importing without waiting", async () => {
		const fx = await fixture();
		await launchedByHand(fx);
		const output = childOutput(fx.childRunId, { answer: "YES" });
		await settledByHand(fx, settlement("completed", output));
		const before = await eventTypes(fx);
		const provider = fakeProvider({ output });
		const ex = executor(await reopen(fx), provider);
		expect((await ex.wait(fx.taskId)).outcome).toBe("completed");
		expect(provider.launch).not.toHaveBeenCalled();
		expect(provider.wait).not.toHaveBeenCalled();
		expect(provider.readOutput).toHaveBeenCalledTimes(1);
		await expectCompleted(fx, output);
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"artifact-declared",
			"task-execution-nested-output-imported",
			"task-execution-terminal",
			"task-status-changed",
		]);
	});

	it("recovers from a persisted non-completed settlement without touching the provider", async () => {
		const fx = await fixture();
		await launchedByHand(fx);
		await settledByHand(fx, settlement("interrupted"));
		const before = await eventTypes(fx);
		const provider = fakeProvider();
		const ex = executor(await reopen(fx), provider);
		expect((await ex.wait(fx.taskId)).outcome).toBe("interrupted");
		for (const spy of Object.values(provider)) {
			expect(spy).not.toHaveBeenCalled();
		}
		await expectNestedTerminal(fx, "interrupted");
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"task-execution-terminal",
			"task-status-changed",
		]);
	});

	it("recovers from an undeclared artifact file by declaring the same id", async () => {
		const fx = await fixture();
		await launchedByHand(fx);
		const output = childOutput(fx.childRunId, { answer: "YES" });
		await settledByHand(fx, settlement("completed", output));
		const undeclared = await importedByHand(fx, output, false);
		const before = await eventTypes(fx);
		const provider = fakeProvider({ output });
		const ex = executor(await reopen(fx), provider);
		expect((await ex.wait(fx.taskId)).outcome).toBe("completed");
		const { artifact } = await expectCompleted(fx, output);
		expect(artifact).toEqual(undeclared);
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"artifact-declared",
			"task-execution-nested-output-imported",
			"task-execution-terminal",
			"task-status-changed",
		]);
	});

	it("recovers from an imported output by terminalizing without the provider", async () => {
		const fx = await fixture();
		await launchedByHand(fx);
		const output = childOutput(fx.childRunId, { answer: "YES" });
		await settledByHand(fx, settlement("completed", output));
		await importedByHand(fx, output);
		const before = await eventTypes(fx);
		const provider = fakeProvider();
		const ex = executor(await reopen(fx), provider);
		expect((await ex.wait(fx.taskId)).outcome).toBe("completed");
		for (const spy of Object.values(provider)) {
			expect(spy).not.toHaveBeenCalled();
		}
		await expectCompleted(fx, output);
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"task-execution-terminal",
			"task-status-changed",
		]);
	});

	it("repairs only the task transition after terminal evidence", async () => {
		const fx = await fixture();
		await launchedByHand(fx);
		const output = childOutput(fx.childRunId, { answer: "YES" });
		await settledByHand(fx, settlement("completed", output));
		const artifact = await importedByHand(fx, output);
		await terminalByHand(fx, artifact);
		expect((await current(fx)).task.status).toBe("running");
		const before = await eventTypes(fx);
		const provider = fakeProvider();
		const ex = executor(await reopen(fx), provider);
		expect((await ex.wait(fx.taskId)).outcome).toBe("completed");
		for (const spy of Object.values(provider)) {
			expect(spy).not.toHaveBeenCalled();
		}
		await expectCompleted(fx, output);
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"task-status-changed",
		]);

		const launchRepair = await fixture();
		await launchedByHand(launchRepair);
		await settledByHand(launchRepair, settlement("failed"));
		await launchRepair.journal.append("task-execution-terminal", {
			executionId: launchRepair.executionId,
			outcome: "failed",
			evidence: {
				kind: "nested-workflow",
				childRunId: launchRepair.childRunId,
				status: "failed",
				usage: USAGE,
				usageComplete: true,
			},
		});
		const repairing = fakeProvider();
		expect(
			await executor(await reopen(launchRepair), repairing).launch(
				launchRepair.taskId,
			),
		).toMatchObject({ state: "terminal", outcome: "failed" });
		expect(repairing.launch).not.toHaveBeenCalled();
		await expectNestedTerminal(launchRepair, "failed");
	});

	it("replays a completed task as a no-op", async () => {
		const fx = await fixture();
		const output = childOutput(fx.childRunId, { answer: "YES" });
		const provider = fakeProvider({
			settlement: settlement("completed", output),
			output,
		});
		const ex = executor(fx, provider);
		await ex.launch(fx.taskId);
		await ex.wait(fx.taskId);
		const after = await eventTypes(fx);
		const replay = fakeProvider();
		const again = executor(await reopen(fx), replay);
		expect(await again.launch(fx.taskId)).toMatchObject({
			state: "terminal",
			outcome: "completed",
		});
		expect((await again.wait(fx.taskId)).outcome).toBe("completed");
		expect((await again.stop(fx.taskId, "late stop")).outcome).toBe(
			"completed",
		);
		for (const spy of Object.values(replay)) {
			expect(spy).not.toHaveBeenCalled();
		}
		expect(await eventTypes(fx)).toEqual(after);
		await expectCompleted(fx, output);
	});
});

describe("nested run executor stop", () => {
	it.each([
		["a bare record", createdByHand],
		["persisted intent", intendedByHand],
	])("cancels before launch from %s", async (_label, prepare) => {
		const fx = await fixture();
		await prepare(fx);
		const before = await eventTypes(fx);
		const provider = fakeProvider();
		const ex = executor(fx, provider);
		expect(await ex.stop(fx.taskId, "Operator stop.")).toEqual({
			taskId: fx.taskId,
			executionId: fx.executionId,
			outcome: "cancelled",
			runStatus: "running",
		});
		expect(provider.stop).not.toHaveBeenCalled();
		expect(provider.wait).not.toHaveBeenCalled();
		expect(provider.launch).not.toHaveBeenCalled();
		await expectWorkflowFailure(fx, "cancelled", "stop", "Operator stop.");
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"task-execution-terminal",
			"task-status-changed",
		]);
	});

	it("stops a launched child and drains its cancellation", async () => {
		const fx = await fixture();
		const provider = fakeProvider({ settlement: settlement("cancelled") });
		const ex = executor(fx, provider);
		await ex.launch(fx.taskId);
		await fx.journal.append("run-status-changed", {
			from: "running",
			to: "stopping",
		});
		const before = await eventTypes(fx);

		expect(await ex.stop(fx.taskId, "Operator stop.")).toEqual({
			taskId: fx.taskId,
			executionId: fx.executionId,
			outcome: "cancelled",
			runStatus: "stopping",
		});
		expect(provider.stop).toHaveBeenCalledTimes(1);
		expect(provider.stop).toHaveBeenCalledWith(fx.childRunId, "Operator stop.");
		expect(provider.wait).toHaveBeenCalledTimes(1);
		expect(provider.wait).toHaveBeenCalledWith(fx.childRunId);
		const stopOrder = provider.stop.mock.invocationCallOrder[0] ?? 0;
		const waitOrder = provider.wait.mock.invocationCallOrder[0] ?? 0;
		expect(stopOrder).toBeLessThan(waitOrder);
		await expectNestedTerminal(fx, "cancelled");
		const events = await fx.journal.readEvents();
		expect(events.slice(before.length).map((event) => event.type)).toEqual([
			"task-status-changed",
			"task-execution-nested-settled",
			"task-execution-terminal",
			"task-status-changed",
		]);
		expect(events[before.length]?.data).toMatchObject({
			taskId: fx.taskId,
			from: "running",
			to: "cancelling",
			reason: "Operator stop.",
		});
	});

	it("rejects a stop of a launched child when the run is not stopping", async () => {
		const fx = await fixture();
		const provider = fakeProvider({ settlement: settlement("cancelled") });
		const ex = executor(fx, provider);
		await ex.launch(fx.taskId);
		const before = await eventTypes(fx);
		await expect(ex.stop(fx.taskId, "Operator stop.")).rejects.toThrow();
		expect(provider.stop).not.toHaveBeenCalled();
		expect(provider.wait).not.toHaveBeenCalled();
		expect(await eventTypes(fx)).toEqual(before);
		expect((await current(fx)).task.status).toBe("running");
	});

	it("stops promptly while a wait is in flight and settles both once", async () => {
		const fx = await fixture();
		const provider = fakeProvider();
		const waiting = defer<void>();
		const settled = defer<WorkflowNestedRunSettlement>();
		const stopped = defer<void>();
		provider.wait.mockImplementation(() => {
			waiting.resolve();
			return settled.promise;
		});
		provider.stop.mockImplementation(async () => {
			stopped.resolve();
		});
		const ex = executor(fx, provider);
		await ex.launch(fx.taskId);
		await fx.journal.append("run-status-changed", {
			from: "running",
			to: "stopping",
		});

		const waitPromise = ex.wait(fx.taskId);
		await waiting.promise;
		const stopPromise = ex.stop(fx.taskId, "Operator stop.");
		await stopped.promise;
		expect(provider.stop).toHaveBeenCalledTimes(1);
		expect(provider.stop).toHaveBeenCalledWith(fx.childRunId, "Operator stop.");
		expect(await isPending(waitPromise)).toBe(true);
		expect(await isPending(stopPromise)).toBe(true);
		expect((await current(fx)).task.status).toBe("cancelling");
		expect(await terminalEventCount(fx)).toBe(0);

		settled.resolve(settlement("cancelled"));
		const [waited, stoppedResult] = await Promise.all([
			waitPromise,
			stopPromise,
		]);
		expect(waited.outcome).toBe("cancelled");
		expect(stoppedResult.outcome).toBe("cancelled");
		expect(provider.wait).toHaveBeenCalledTimes(1);
		expect(await terminalEventCount(fx)).toBe(1);
		await expectNestedTerminal(fx, "cancelled");
	});
});

describe("nested run executor reconcile", () => {
	it("re-settles a cleanup-blocked child after reconciliation", async () => {
		const fx = await fixture();
		const output = childOutput(fx.childRunId, { answer: "YES" });
		const provider = fakeProvider({
			settlement: settlement("cleanup-blocked"),
			output,
		});
		const ex = executor(fx, provider);
		await ex.launch(fx.taskId);
		expect((await ex.wait(fx.taskId)).outcome).toBe("cleanup-blocked");
		await expectNestedTerminal(fx, "cleanup-blocked");
		const blocked = await eventTypes(fx);

		expect((await ex.reconcile(fx.taskId)).outcome).toBe("cleanup-blocked");
		expect(provider.reconcile).toHaveBeenCalledTimes(1);
		expect(provider.reconcile).toHaveBeenCalledWith(fx.childRunId);
		expect(provider.wait).toHaveBeenCalledTimes(2);
		expect(await eventTypes(fx)).toEqual(blocked);
		await expectNestedTerminal(fx, "cleanup-blocked");

		provider.wait.mockResolvedValueOnce(settlement("completed", output));
		expect(await ex.reconcile(fx.taskId)).toEqual({
			taskId: fx.taskId,
			executionId: fx.executionId,
			outcome: "completed",
			runStatus: "running",
		});
		expect(provider.reconcile).toHaveBeenCalledTimes(2);
		expect(provider.wait).toHaveBeenCalledTimes(3);
		expect(provider.readOutput).toHaveBeenCalledTimes(1);
		await expectCompleted(fx, output);
		expect((await eventTypes(fx)).slice(blocked.length)).toEqual([
			"task-execution-nested-settled",
			"artifact-declared",
			"task-execution-nested-output-imported",
			"task-execution-terminal",
			"task-status-changed",
		]);
	});

	it("re-settles a cleanup-blocked child to a non-completed outcome", async () => {
		const fx = await fixture();
		const provider = fakeProvider({
			settlement: settlement("cleanup-blocked"),
		});
		const ex = executor(fx, provider);
		await ex.launch(fx.taskId);
		await ex.wait(fx.taskId);
		provider.wait.mockResolvedValueOnce(settlement("failed"));
		expect(
			(await executor(await reopen(fx), provider).reconcile(fx.taskId)).outcome,
		).toBe("failed");
		expect(provider.readOutput).not.toHaveBeenCalled();
		await expectNestedTerminal(fx, "failed");
		expect(await terminalEventCount(fx)).toBe(2);
	});

	it("retries the import of a completed child without reconciling the provider", async () => {
		const fx = await fixture();
		const output = childOutput(fx.childRunId, { answer: "YES" });
		const provider = fakeProvider({
			settlement: settlement("completed", output),
			output,
		});
		provider.readOutput.mockRejectedValueOnce(new Error("disk gone"));
		const ex = executor(fx, provider);
		await ex.launch(fx.taskId);
		expect((await ex.wait(fx.taskId)).outcome).toBe("cleanup-blocked");
		await expectWorkflowFailure(
			fx,
			"cleanup-blocked",
			"nested-import",
			"Nested workflow output could not be imported.",
		);
		const blocked = await eventTypes(fx);

		expect((await ex.reconcile(fx.taskId)).outcome).toBe("completed");
		expect(provider.reconcile).not.toHaveBeenCalled();
		expect(provider.wait).toHaveBeenCalledTimes(1);
		expect(provider.readOutput).toHaveBeenCalledTimes(2);
		await expectCompleted(fx, output);
		expect((await eventTypes(fx)).slice(blocked.length)).toEqual([
			"artifact-declared",
			"task-execution-nested-output-imported",
			"task-execution-terminal",
			"task-status-changed",
		]);
	});

	it("rejects reconciliation of a task that is not cleanup-blocked", async () => {
		const fx = await fixture();
		const provider = fakeProvider({ settlement: settlement("failed") });
		const ex = executor(fx, provider);
		await ex.launch(fx.taskId);
		await expect(ex.reconcile(fx.taskId)).rejects.toThrow(
			"Nested workflow task is not cleanup-blocked.",
		);
		await ex.wait(fx.taskId);
		await expect(ex.reconcile(fx.taskId)).rejects.toThrow(
			"Nested workflow task is not cleanup-blocked.",
		);
		expect(provider.reconcile).not.toHaveBeenCalled();
	});
});

describe("nested run executor validation", () => {
	it("rejects invalid, unknown, and non-workflow task ids", async () => {
		const fx = await fixture({ support: true });
		if (!fx.supportId) throw new Error("fixture has no support task");
		const provider = fakeProvider();
		const ex = executor(fx, provider);
		const before = await eventTypes(fx);
		await expect(ex.launch("not a task id" as WorkflowTaskId)).rejects.toThrow(
			"Workflow task id is invalid.",
		);
		await expect(
			ex.launch(deriveWorkflowTaskId(RUN_ID, [], "ghost")),
		).rejects.toThrow("Workflow task is not committed.");
		await expect(ex.launch(fx.supportId)).rejects.toThrow(
			"Workflow task is not a nested workflow task.",
		);
		await expect(ex.wait(fx.supportId)).rejects.toThrow(
			"Workflow task is not a nested workflow task.",
		);
		await expect(ex.stop(fx.supportId, "stop")).rejects.toThrow(
			"Workflow task is not a nested workflow task.",
		);
		await expect(ex.reconcile(fx.supportId)).rejects.toThrow(
			"Workflow task is not a nested workflow task.",
		);
		for (const spy of Object.values(provider)) {
			expect(spy).not.toHaveBeenCalled();
		}
		expect(await eventTypes(fx)).toEqual(before);
	});

	it("rejects waiting or stopping before a durable launch", async () => {
		const fx = await fixture();
		const provider = fakeProvider();
		const ex = executor(fx, provider);
		await expect(ex.wait(fx.taskId)).rejects.toThrow(
			"Nested workflow task has no durable execution.",
		);
		await expect(ex.stop(fx.taskId, "stop")).rejects.toThrow(
			"Nested workflow task has no durable execution.",
		);
		await createdByHand(fx);
		await expect(ex.wait(fx.taskId)).rejects.toThrow(
			"Nested workflow run has not been launched.",
		);
		expect(provider.wait).not.toHaveBeenCalled();
		expect(provider.stop).not.toHaveBeenCalled();
	});

	it("rejects a nesting context whose ancestry does not match its depth", async () => {
		const fx = await fixture();
		const provider = fakeProvider();
		const build = (
			nesting: WorkflowNestedRunExecutorOptions["nesting"],
		): WorkflowNestedRunExecutor =>
			createWorkflowNestedRunExecutor({
				journal: fx.journal,
				artifacts: fx.artifacts,
				provider,
				nesting,
			});
		const invalid = "Nested run executor nesting context is invalid.";
		expect(() =>
			build({
				depth: 1,
				ancestorDefinitionIdentities: [],
				definitionIdentitySha256: parentIdentitySha256,
				deadlineAt: farFuture(),
			}),
		).toThrow(invalid);
		expect(() =>
			build({
				depth: 0,
				ancestorDefinitionIdentities: ["e".repeat(64)],
				definitionIdentitySha256: parentIdentitySha256,
				deadlineAt: farFuture(),
			}),
		).toThrow(invalid);
		expect(() =>
			build({
				depth: 0,
				ancestorDefinitionIdentities: [],
				definitionIdentitySha256: parentIdentitySha256,
				deadlineAt: "not a date",
			}),
		).toThrow(invalid);
		const nested = build({
			depth: 1,
			ancestorDefinitionIdentities: ["e".repeat(64)],
			definitionIdentitySha256: parentIdentitySha256,
			deadlineAt: farFuture(),
		});
		expect((await nested.launch(fx.taskId)).state).toBe("launched");
		expect(provider.launch.mock.calls[0]?.[0].parent).toMatchObject({
			depth: 2,
			ancestorDefinitionIdentities: ["e".repeat(64), parentIdentitySha256],
		});
	});
});

describe("nested artifact inputs", () => {
	const AUTHORED_INPUT = { mode: "fast" };
	const DOC_SCHEMA = {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
		additionalProperties: false,
	};
	const schemaMessage = "Nested workflow input does not match its schema.";
	const boundMessage =
		"Nested workflow input exceeds the workflow input bound.";
	const readMessage = "Nested workflow inputs could not be read and verified.";
	const objectMessage =
		"Nested workflow artifact inputs require an object input.";
	const collisionMessage =
		"Nested workflow input name collides with the authored input.";
	const driftMessage =
		"Nested workflow resolved input drifted from durable intent.";

	const docHelper = defineSupportTask({
		name: "@vegardx/workflow-tools/doc",
		moduleSpecifier: "@vegardx/workflow-tools",
		revision: 1,
		implementationSha256: "9".repeat(64),
		parametersSchema: Type.Object({
			text: Type.String(),
			repeat: Type.Integer({ minimum: 1 }),
		}),
		outputSchema: Type.Object({ text: Type.String() }),
	});
	const docRegistration = docHelper.registration(({ parameters }) => ({
		text: parameters.text.repeat(parameters.repeat),
	}));

	type DocParameters = { text: string; repeat: number };

	interface InputFixture extends Fixture {
		/** Producer task ids keyed by the child's input name. */
		readonly producers: Readonly<Record<string, WorkflowTaskId>>;
		readonly authored: unknown;
	}

	interface InputFixtureOptions {
		/** Input names in declaration order; each gets its own producer. */
		readonly names?: readonly string[];
		readonly parameters?: Readonly<Record<string, DocParameters>>;
		readonly input?: unknown;
		readonly inputSchema?: NestedWorkflowTaskRequest["inputSchema"];
	}

	function inputSchemaFor(
		names: readonly string[],
	): NestedWorkflowTaskRequest["inputSchema"] {
		return {
			type: "object",
			properties: {
				mode: { type: "string" },
				...Object.fromEntries(names.map((name) => [name, DOC_SCHEMA])),
			},
			required: ["mode", ...names],
			additionalProperties: false,
		};
	}

	async function inputFixture(
		options: InputFixtureOptions = {},
	): Promise<InputFixture> {
		const names = options.names ?? ["doc"];
		const authored = options.input ?? AUTHORED_INPUT;
		const root = path.resolve(
			".pi",
			"test-nested-run-executor",
			`run-${randomUUID()}`,
		);
		const { lease, journal } = await openJournal(root, "nested-executor-test");
		await journal.append("run-created", {
			definitionIdentitySha256: parentIdentitySha256,
			inputSha256,
		});
		const materializer = new WorkflowTaskMaterializer({
			runId: RUN_ID,
			definitionIdentitySha256: parentIdentitySha256,
			inputSha256,
		});
		const producers = names.map((name) => ({
			name,
			handle: materializer.support(
				`producer-${name}`,
				docHelper({
					parameters: options.parameters?.[name] ?? { text: name, repeat: 1 },
				}),
			),
		}));
		const child = materializer.workflow("child", {
			request: nestedRequest({
				input: authored,
				inputSha256: deriveJsonValueSha256(authored),
				inputSchema: options.inputSchema ?? inputSchemaFor([...names].sort()),
			}),
			inputs: Object.fromEntries(
				producers.map(({ name, handle }) => [name, handle.output]),
			),
		});
		for (const event of materializer.closeEpoch("final", [child]).events) {
			await journal.appendEvent(event);
		}
		await journal.append("run-status-changed", {
			from: "created",
			to: "running",
		});
		for (const { handle } of producers) {
			await journal.append("task-status-changed", {
				taskId: handle.ref.taskId,
				from: "pending",
				to: "ready",
			});
		}
		const artifacts = await WorkflowArtifactStore.open({ journal });
		return {
			root,
			lease,
			journal,
			artifacts,
			taskId: child.ref.taskId,
			supportId: undefined,
			executionId: deriveTaskExecutionId(RUN_ID, child.ref.taskId, 1),
			childRunId: deriveNestedWorkflowRunId(RUN_ID, child.ref.taskId, 1),
			producers: Object.fromEntries(
				producers.map(({ name, handle }) => [name, handle.ref.taskId]),
			),
			authored,
		};
	}

	async function readyChild(fx: InputFixture): Promise<void> {
		await fx.journal.append("task-status-changed", {
			taskId: fx.taskId,
			from: "pending",
			to: "ready",
		});
	}

	/** Completes every producer through the real support executor. */
	async function completeProducers(
		fx: InputFixture,
	): Promise<Record<string, WorkflowArtifactRef>> {
		const support = createWorkflowSupportTaskExecutor({
			journal: fx.journal,
			artifacts: fx.artifacts,
			registrations: new Map([[docRegistration.name, docRegistration]]),
			signal: () => new AbortController().signal,
		});
		const produced: Record<string, WorkflowArtifactRef> = {};
		for (const [name, producerId] of Object.entries(fx.producers)) {
			expect((await support.intend(producerId)).state).toBe("intended");
			expect((await support.execute(producerId)).outcome).toBe("completed");
			const [artifact] = resultArtifacts(await projection(fx), producerId);
			if (!artifact) throw new Error(`producer ${name} has no artifact`);
			produced[name] = artifact;
		}
		await readyChild(fx);
		return produced;
	}

	function artifactOf(
		produced: Record<string, WorkflowArtifactRef>,
		name: string,
	): WorkflowArtifactRef {
		const artifact = produced[name];
		if (!artifact) throw new Error(`no artifact for ${name}`);
		return artifact;
	}

	function lineageOf(
		produced: Record<string, WorkflowArtifactRef>,
	): NestedWorkflowInputArtifacts {
		return Object.fromEntries(
			Object.entries(produced).map(([name, artifact]) => [
				name,
				{ runId: RUN_ID, artifactId: artifact.id, sha256: artifact.sha256 },
			]),
		);
	}

	function digestsOf(
		produced: Record<string, WorkflowArtifactRef>,
	): Record<string, string> {
		return Object.fromEntries(
			Object.entries(produced).map(([name, artifact]) => [
				name,
				artifact.sha256,
			]),
		);
	}

	function launchOf(provider: ProviderSpies, index = 0) {
		const request = provider.launch.mock.calls[index]?.[0];
		if (!request) throw new Error(`provider.launch call ${index} is missing`);
		return request;
	}

	async function expectInputFailure(
		fx: InputFixture,
		message: string,
	): Promise<void> {
		const before = await eventTypes(fx);
		const provider = fakeProvider();
		expect(await executor(fx, provider).launch(fx.taskId)).toEqual({
			taskId: fx.taskId,
			executionId: fx.executionId,
			state: "terminal",
			outcome: "failed",
			runStatus: "running",
		});
		expect(provider.launch).not.toHaveBeenCalled();
		const state = await expectWorkflowFailure(
			fx,
			"failed",
			"nested-input",
			message,
		);
		expect(view(state, fx.taskId).execution?.nestedIntent).toBeUndefined();
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"task-execution-created",
			"task-execution-terminal",
			"task-status-changed",
		]);
	}

	/** Leaves a durable intent with no launch, as a crash between them would. */
	async function intentOnlyPrefix(fx: InputFixture): Promise<ProviderSpies> {
		const crashed = fakeProvider();
		crashed.launch.mockRejectedValueOnce(new Error("crashed before launch"));
		await expect(executor(fx, crashed).launch(fx.taskId)).rejects.toThrow(
			"crashed before launch",
		);
		const { task, execution } = await current(fx);
		expect(task.status).toBe("ready");
		expect(execution?.phase).toBe("nested-intended");
		return crashed;
	}

	it("launches with the authored input merged with one verified artifact value", async () => {
		const fx = await inputFixture();
		const produced = await completeProducers(fx);
		const doc = artifactOf(produced, "doc");
		const before = await eventTypes(fx);
		const provider = fakeProvider();
		expect(await executor(fx, provider).launch(fx.taskId)).toEqual({
			taskId: fx.taskId,
			executionId: fx.executionId,
			state: "launched",
			runStatus: "running",
		});

		const merged = { mode: "fast", doc: { text: "doc" } };
		const { spec, execution } = await current(fx);
		expect(spec.inputs).toEqual({
			doc: {
				runId: RUN_ID,
				producerTaskId: fx.producers.doc,
				output: "result",
			},
		});
		expect(spec.after).toEqual([{ runId: RUN_ID, taskId: fx.producers.doc }]);
		expect(spec.request.input).toEqual(AUTHORED_INPUT);
		expect(doc.producerTaskId).toBe(fx.producers.doc);
		expect(await fx.artifacts.readJson(doc)).toEqual({ text: "doc" });
		const intent = execution?.nestedIntent;
		if (!intent) throw new Error("missing intent");
		expect(intent.inputSha256).toBe(deriveJsonValueSha256(AUTHORED_INPUT));
		expect(intent.inputsSha256).toBe(
			deriveJsonValueSha256({ doc: doc.sha256 }),
		);
		expect(intent.resolvedInputSha256).toBe(deriveJsonValueSha256(merged));
		expect(intent.resolvedInputSha256).not.toBe(intent.inputSha256);

		expect(provider.launch).toHaveBeenCalledTimes(1);
		expect(provider.launch).toHaveBeenCalledWith({
			childRunId: fx.childRunId,
			parent: {
				runId: RUN_ID,
				taskId: fx.taskId,
				executionId: fx.executionId,
				depth: 1,
				ancestorDefinitionIdentities: [parentIdentitySha256],
			},
			definitionName: "child",
			definitionIdentitySha256: childIdentitySha256,
			definitionSourceSha256: childSourceSha256,
			input: merged,
			inputArtifacts: {
				doc: { runId: RUN_ID, artifactId: doc.id, sha256: doc.sha256 },
			},
			budget: spec.request.budget,
			deadlineAt: intent.deadlineAt,
			concurrency: spec.request.concurrency,
		});
		await expectLaunched(fx);
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"task-execution-created",
			"task-execution-nested-intended",
			"task-execution-nested-launched",
			"task-status-changed",
		]);
	});

	it("injects two inputs under their names in sorted order", async () => {
		const fx = await inputFixture({ names: ["notes", "doc"] });
		const produced = await completeProducers(fx);
		const doc = artifactOf(produced, "doc");
		const notes = artifactOf(produced, "notes");
		expect(doc.sha256).not.toBe(notes.sha256);
		const provider = fakeProvider();
		expect((await executor(fx, provider).launch(fx.taskId)).state).toBe(
			"launched",
		);

		const { spec, execution } = await current(fx);
		expect(Object.keys(spec.inputs)).toEqual(["doc", "notes"]);
		expect(spec.after).toEqual(
			[fx.producers.doc, fx.producers.notes]
				.sort()
				.map((taskId) => ({ runId: RUN_ID, taskId })),
		);
		const launch = launchOf(provider);
		expect(launch.input).toEqual({
			mode: "fast",
			doc: { text: "doc" },
			notes: { text: "notes" },
		});
		expect(Object.keys(launch.inputArtifacts)).toEqual(["doc", "notes"]);
		expect(launch.inputArtifacts).toEqual({
			doc: { runId: RUN_ID, artifactId: doc.id, sha256: doc.sha256 },
			notes: { runId: RUN_ID, artifactId: notes.id, sha256: notes.sha256 },
		});
		expect(execution?.nestedIntent).toMatchObject({
			inputSha256: deriveJsonValueSha256(AUTHORED_INPUT),
			inputsSha256: deriveJsonValueSha256({
				doc: doc.sha256,
				notes: notes.sha256,
			}),
			resolvedInputSha256: deriveJsonValueSha256(launch.input),
		});
		await expectLaunched(fx);
	});

	it.each([
		["the authored keys violate the child schema", { input: { mode: 5 } }],
		[
			"an injected value violates the child schema",
			{
				inputSchema: {
					type: "object",
					properties: {
						mode: { type: "string" },
						doc: {
							type: "object",
							properties: { text: { type: "integer" } },
							required: ["text"],
							additionalProperties: false,
						},
					},
					required: ["mode", "doc"],
					additionalProperties: false,
				},
			},
		],
	] as const)("fails the launch when %s", async (_label, options) => {
		const fx = await inputFixture(options);
		await completeProducers(fx);
		await expectInputFailure(fx, schemaMessage);
	});

	it("fails the launch when the authored input is not an object", async () => {
		// The materializer accepts any JSON input; only ctx.workflow rejects
		// this at declaration, so a hand-materialized spec reaches the executor.
		const fx = await inputFixture({ input: "plain" });
		expect((await current(fx)).spec.request.input).toBe("plain");
		await completeProducers(fx);
		await expectInputFailure(fx, objectMessage);
	});

	it("fails the launch when an authored key collides with an input name", async () => {
		const fx = await inputFixture({ input: { mode: "fast", doc: "mine" } });
		await completeProducers(fx);
		await expectInputFailure(fx, collisionMessage);
	});

	it("fails the launch when the producer artifact is corrupt on disk", async () => {
		const fx = await inputFixture();
		const doc = artifactOf(await completeProducers(fx), "doc");
		await writeFile(
			path.join(fx.artifacts.root, `${doc.sha256}.json`),
			"corrupt",
		);
		await expectInputFailure(fx, readMessage);
	});

	it("fails the launch when the merged input exceeds the input bound", async () => {
		const fx = await inputFixture({
			parameters: { doc: { text: "x", repeat: 900 * 1024 } },
		});
		const doc = artifactOf(await completeProducers(fx), "doc");
		expect(doc.bytes).toBeGreaterThan(900 * 1024);
		await expectInputFailure(fx, boundMessage);
	});

	it("recovers from an intent-only prefix by re-resolving the same merged input", async () => {
		const fx = await inputFixture();
		const produced = await completeProducers(fx);
		const crashed = await intentOnlyPrefix(fx);
		const intent = (await current(fx)).execution?.nestedIntent;
		if (!intent) throw new Error("missing intent");
		const before = await eventTypes(fx);

		const provider = fakeProvider();
		const ex = executor(await reopen(fx), provider);
		expect((await ex.launch(fx.taskId)).state).toBe("launched");
		expect(provider.launch).toHaveBeenCalledTimes(1);
		const launch = launchOf(provider);
		expect(launch.input).toEqual({ mode: "fast", doc: { text: "doc" } });
		expect(launch.inputArtifacts).toEqual(lineageOf(produced));
		expect(launch).toEqual(launchOf(crashed));
		expect(deriveJsonValueSha256(launch.input)).toBe(
			intent.resolvedInputSha256,
		);
		expect(deriveJsonValueSha256(digestsOf(produced))).toBe(
			intent.inputsSha256,
		);
		const execution = await expectLaunched(fx);
		expect(execution.nestedIntent).toEqual(intent);
		expect((await eventTypes(fx)).slice(before.length)).toEqual([
			"task-execution-nested-launched",
			"task-status-changed",
		]);
	});

	it("fails closed when the durable intent carries a foreign resolved digest", async () => {
		const fx = await inputFixture();
		const produced = await completeProducers(fx);
		await createdByHand(fx);
		const { spec } = await current(fx);
		await fx.journal.append("task-execution-nested-intended", {
			executionId: fx.executionId,
			childRunId: fx.childRunId,
			definitionIdentitySha256: spec.request.definitionIdentitySha256,
			inputSha256: spec.request.inputSha256,
			inputsSha256: deriveJsonValueSha256(digestsOf(produced)),
			resolvedInputSha256: deriveJsonValueSha256({
				mode: "fast",
				doc: { text: "tampered" },
			}),
			budget: spec.request.budget,
			timeoutMs: spec.request.timeoutMs,
			deadlineAt: new Date(Date.now() + spec.request.timeoutMs).toISOString(),
			concurrency: spec.request.concurrency,
		});
		const before = await eventTypes(fx);

		const provider = fakeProvider();
		const failure = await executor(await reopen(fx), provider)
			.launch(fx.taskId)
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(failure).toBeInstanceOf(WorkflowNestedRunError);
		expect(failure).toMatchObject({
			stage: "persistence",
			message: driftMessage,
		});
		expect(provider.launch).not.toHaveBeenCalled();
		expect(await eventTypes(fx)).toEqual(before);
		const { task, execution } = await current(fx);
		expect(task.status).toBe("ready");
		expect(execution?.phase).toBe("nested-intended");
		expect(execution?.terminal).toBeUndefined();
	});

	it("fails closed when an intended input artifact is corrupted before launch", async () => {
		const fx = await inputFixture();
		const doc = artifactOf(await completeProducers(fx), "doc");
		await intentOnlyPrefix(fx);
		await writeFile(
			path.join(fx.artifacts.root, `${doc.sha256}.json`),
			"corrupt",
		);
		const before = await eventTypes(fx);

		const provider = fakeProvider();
		const failure = await executor(await reopen(fx), provider)
			.launch(fx.taskId)
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(failure).toBeInstanceOf(WorkflowNestedRunError);
		expect(failure).toMatchObject({
			stage: "persistence",
			message: driftMessage,
			cause: {
				name: "WorkflowNestedRunError",
				stage: "input",
				message: readMessage,
			},
		});
		expect(provider.launch).not.toHaveBeenCalled();
		expect(await eventTypes(fx)).toEqual(before);
		expect((await current(fx)).execution?.terminal).toBeUndefined();
	});

	it("repeats the identical lineage to a provider that pins an existing child", async () => {
		const fx = await inputFixture();
		const produced = await completeProducers(fx);
		const provider = fakeProvider();
		let pinned: NestedWorkflowInputArtifacts | undefined;
		provider.launch.mockImplementation(async (request) => {
			if (!pinned) {
				pinned = structuredClone(request.inputArtifacts);
				throw new Error("crashed after the child recorded its lineage");
			}
			if (!isDeepStrictEqual(request.inputArtifacts, pinned)) {
				throw new WorkflowNestedRunError("launch", "child lineage mismatch");
			}
		});
		await expect(executor(fx, provider).launch(fx.taskId)).rejects.toThrow(
			"crashed after the child recorded its lineage",
		);
		expect(pinned).toEqual(lineageOf(produced));

		expect(
			(await executor(await reopen(fx), provider).launch(fx.taskId)).state,
		).toBe("launched");
		expect(provider.launch).toHaveBeenCalledTimes(2);
		expect(launchOf(provider, 1).inputArtifacts).toEqual(lineageOf(produced));
		expect(launchOf(provider, 1)).toEqual(launchOf(provider, 0));
		await expectLaunched(fx);
	});

	it("launches a child without inputs with empty lineage and the authored digest", async () => {
		const fx = await fixture();
		const provider = fakeProvider();
		expect((await executor(fx, provider).launch(fx.taskId)).state).toBe(
			"launched",
		);
		const { spec, execution } = await current(fx);
		expect(spec.inputs).toEqual({});
		const launch = launchOf(provider);
		expect(launch.input).toEqual(CHILD_INPUT);
		expect(launch.inputArtifacts).toEqual({});
		expect(execution?.nestedIntent).toMatchObject({
			inputSha256: spec.request.inputSha256,
			inputsSha256: deriveJsonValueSha256({}),
			resolvedInputSha256: spec.request.inputSha256,
		});
		expect(spec.request.inputSha256).toBe(deriveJsonValueSha256(CHILD_INPUT));
	});
});
