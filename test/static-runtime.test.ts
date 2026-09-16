import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	HANDOFF_EXPORT_MEDIA_TYPE,
	type RunResult,
} from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { WorkflowArtifactStore } from "../src/artifact-store.js";
import {
	WORKFLOW_HANDOFF_FORMAT_SHA256,
	type WorkflowHandoffDescriptor,
	WorkflowHandoffDescriptorSchema,
} from "../src/contracts.js";
import { defineWorkflow, type WorkflowContext } from "../src/definition.js";
import {
	deriveJsonValueSha256,
	deriveNestedWorkflowRunId,
	deriveSubagentOperationId,
	deriveSubagentResultSha256,
	deriveTaskExecutionId,
	deriveWorkflowFailureSha256,
} from "../src/execution.js";
import { WorkflowHandoffVerificationError } from "../src/handoff.js";
import { WorkflowTaskMaterializer } from "../src/materializer.js";
import { WorkflowRunJournal } from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
	type WorkflowRunLease,
} from "../src/persistence/run-lease.js";
import { invalidationClosure, reduceWorkflowEvents } from "../src/reducer.js";
import { type DiscoveredWorkflow, discoverWorkflows } from "../src/registry.js";
import type {
	WorkflowSchedulerOutcome,
	WorkflowSequentialScheduler,
} from "../src/scheduler.js";
import {
	createStaticWorkflowRuntime,
	isStaticWorkflowParked,
	isStaticWorkflowParkSignal,
	type StaticWorkflowDriveResult,
	type StaticWorkflowRunResult,
	StaticWorkflowRuntimeError,
	type StaticWorkflowRuntimeOptions,
	type WorkflowHostBridge,
	workflowHostBridge,
} from "../src/static-runtime.js";
import { defineSupportTask } from "../src/support.js";

const definitionIdentitySha256 = "a".repeat(64);

/** Narrows a drive result to the finished shape; a park here is a test failure. */
function completed<T>(
	result: StaticWorkflowDriveResult<T>,
): StaticWorkflowRunResult<T> {
	if (isStaticWorkflowParked(result)) {
		throw new Error("workflow run parked unexpectedly");
	}
	return result;
}
const planIdentitySha256 = "b".repeat(64);
const leases = new Set<WorkflowRunLease>();
const nestedRoot = path.resolve(
	".pi",
	"test-static-runtime",
	`nested-${randomUUID()}`,
);
const childOutputArtifactId = `artifact_${"5".repeat(64)}`;
const nestedUsage = { cost: 0.5, totalTokens: 1_200, childRuntimeMs: 4_000 };
let discovery: Promise<readonly DiscoveredWorkflow[]> | undefined;

function childDefinitionSource(name: string): string {
	return `export default {
  schema: "pi-workflow-definition",
  meta: { name: ${JSON.stringify(name)}, description: "Nested child", version: 2, budget: { cost: 10, totalTokens: 100000, childRuntimeMs: 600000 }, timeoutMs: 600000, concurrency: 2 },
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  run(ctx) { return { answer: ctx.input.value }; }
};\n`;
}

function discoveredWorkflows(): Promise<readonly DiscoveredWorkflow[]> {
	discovery ??= (async () => {
		const cwd = path.join(nestedRoot, "project");
		await mkdir(path.join(cwd, "workflows"), { recursive: true });
		await writeFile(
			path.join(cwd, "workflows", "child.workflow.ts"),
			childDefinitionSource("child"),
		);
		return discoverWorkflows({
			cwd,
			agentDir: path.join(nestedRoot, "agent"),
			projectTrusted: true,
		});
	})();
	return discovery;
}

async function discoveredChild(): Promise<DiscoveredWorkflow> {
	const child = (await discoveredWorkflows()).find(
		(workflow) => workflow.definition.meta.name === "child",
	);
	if (!child) throw new Error("missing discovered child workflow");
	return child;
}

async function nesting(
	depth = 0,
	ancestorDefinitionIdentities: readonly string[] = [],
): Promise<
	NonNullable<StaticWorkflowRuntimeOptions<unknown, unknown>["nesting"]>
> {
	const workflows = await discoveredWorkflows();
	return {
		depth,
		ancestorDefinitionIdentities,
		resolveWorkflow: (name) =>
			workflows.find((workflow) => workflow.definition.meta.name === name),
	};
}

function parentMeta(name: string) {
	return {
		name,
		description: "Nested parent",
		version: 1,
		budget: { cost: 1000, childRuntimeMs: 3600000 },
		timeoutMs: 3600000,
	};
}

function nestedSchedulerFor(
	journal: WorkflowRunJournal,
	artifacts: WorkflowArtifactStore,
	outcomes: ReadonlyMap<
		string,
		{ status: "completed"; output: unknown } | { status: "failed" }
	>,
): WorkflowSequentialScheduler & { calls: number } {
	const scheduler = {
		concurrency: 1,
		stopSignal: new AbortController().signal,
		calls: 0,
		async drive(): Promise<WorkflowSchedulerOutcome> {
			scheduler.calls += 1;
			let current = await journal.readState();
			if (current.status === "created" || current.status === "waiting") {
				await journal.append("run-status-changed", {
					from: current.status,
					to: "running",
				});
				current = await journal.readState();
			}
			const task = Object.values(current.tasks)
				.sort(
					(left, right) =>
						left.task.materializationSequence -
						right.task.materializationSequence,
				)
				.find(
					(candidate) =>
						candidate.status !== "completed" && candidate.status !== "failed",
				);
			if (!task) return { state: "idle", runStatus: current.status };
			if (task.task.spec.kind !== "workflow") {
				throw new Error("nested fake scheduler only supports workflow tasks");
			}
			const outcome = outcomes.get(task.task.spec.key);
			if (!outcome) throw new Error("missing fake nested outcome");
			const spec = task.task.spec;
			const taskId = task.task.id;
			const inputDigests: Record<string, string> = {};
			const merged: Record<string, unknown> = {
				...(spec.request.input as Record<string, unknown>),
			};
			for (const [name, input] of Object.entries(spec.inputs)) {
				const artifact = Object.values(current.artifacts).find(
					(candidate) =>
						candidate.producerTaskId === input.producerTaskId &&
						candidate.output === "result",
				);
				if (!artifact) throw new Error("missing fake nested input artifact");
				inputDigests[name] = artifact.sha256;
				merged[name] = await artifacts.readJson(artifact);
			}
			await journal.append("task-status-changed", {
				taskId,
				from: "pending",
				to: "ready",
			});
			const executionId = deriveTaskExecutionId(current.runId, taskId, 1);
			const childRunId = deriveNestedWorkflowRunId(current.runId, taskId, 1);
			await journal.append("task-execution-created", {
				execution: {
					kind: "workflow",
					id: executionId,
					runId: current.runId,
					taskId,
					generation: 1,
					taskIdentitySha256: spec.identitySha256,
					childRunId,
				},
			});
			await journal.append("task-execution-nested-intended", {
				executionId,
				childRunId,
				definitionIdentitySha256: spec.request.definitionIdentitySha256,
				inputSha256: spec.request.inputSha256,
				inputsSha256: deriveJsonValueSha256(inputDigests),
				resolvedInputSha256:
					Object.keys(spec.inputs).length === 0
						? spec.request.inputSha256
						: deriveJsonValueSha256(merged),
				budget: structuredClone(spec.request.budget),
				timeoutMs: spec.request.timeoutMs,
				deadlineAt: new Date(Date.now() + 1_000).toISOString(),
				concurrency: spec.request.concurrency,
			});
			await journal.append("task-execution-nested-launched", {
				executionId,
				childRunId,
			});
			await journal.append("task-status-changed", {
				taskId,
				from: "ready",
				to: "running",
			});
			if (outcome.status === "failed") {
				await journal.append("task-execution-nested-settled", {
					executionId,
					childRunId,
					status: "failed",
					usage: { ...nestedUsage },
					usageComplete: true,
				});
				await journal.append("task-execution-terminal", {
					executionId,
					outcome: "failed",
					evidence: {
						kind: "nested-workflow",
						childRunId,
						status: "failed",
						usage: { ...nestedUsage },
						usageComplete: true,
					},
				});
				await journal.append("task-status-changed", {
					taskId,
					from: "running",
					to: "failed",
				});
				return { state: "idle", runStatus: "running" };
			}
			const artifact = await artifacts.putJson(outcome.output, {
				runId: current.runId,
				producerTaskId: taskId,
				producerExecutionId: executionId,
				output: "result",
				schemaSha256: deriveJsonValueSha256(spec.request.outputSchema),
			});
			await journal.append("task-execution-nested-settled", {
				executionId,
				childRunId,
				status: "completed",
				usage: { ...nestedUsage },
				usageComplete: true,
				outputArtifactId: childOutputArtifactId,
				outputSha256: artifact.sha256,
			});
			await journal.append("artifact-declared", { artifact });
			await journal.append("task-execution-nested-output-imported", {
				executionId,
				childRunId,
				artifactId: artifact.id,
				sourceArtifactId: childOutputArtifactId,
				sourceSha256: artifact.sha256,
			});
			await journal.append("task-execution-terminal", {
				executionId,
				outcome: "completed",
				evidence: {
					kind: "nested-workflow",
					childRunId,
					status: "completed",
					usage: { ...nestedUsage },
					usageComplete: true,
					outputSha256: artifact.sha256,
					artifactId: artifact.id,
				},
			});
			await journal.append("task-status-changed", {
				taskId,
				from: "running",
				to: "completed",
			});
			return { state: "idle", runStatus: "running" };
		},
		async reconcile() {
			throw new Error("fake nested workflow has no cleanup-blocked task");
		},
		async decide() {
			throw new Error("fake scheduler records no decisions");
		},
		async stop() {
			return { state: "terminal", runStatus: "cancelled" } as const;
		},
	};
	return scheduler;
}

function mixedSchedulerFor(
	journal: WorkflowRunJournal,
	artifacts: WorkflowArtifactStore,
	agentOutputs: ReadonlyMap<string, unknown>,
	nestedOutcomes: ReadonlyMap<
		string,
		{ status: "completed"; output: unknown } | { status: "failed" }
	>,
): WorkflowSequentialScheduler & { calls: number } {
	const agents = schedulerFor(journal, artifacts, agentOutputs);
	const nested = nestedSchedulerFor(journal, artifacts, nestedOutcomes);
	const scheduler = {
		concurrency: 1,
		stopSignal: new AbortController().signal,
		calls: 0,
		async drive(): Promise<WorkflowSchedulerOutcome> {
			scheduler.calls += 1;
			const current = await journal.readState();
			const task = Object.values(current.tasks)
				.sort(
					(left, right) =>
						left.task.materializationSequence -
						right.task.materializationSequence,
				)
				.find(
					(candidate) =>
						candidate.status !== "completed" && candidate.status !== "failed",
				);
			return task?.task.spec.kind === "agent" ? agents.drive() : nested.drive();
		},
		async reconcile() {
			throw new Error("fake mixed workflow has no cleanup-blocked task");
		},
		async decide() {
			throw new Error("fake scheduler records no decisions");
		},
		async stop() {
			return { state: "terminal", runStatus: "cancelled" } as const;
		},
	};
	return scheduler;
}

async function nestedDeclarationFailure(
	options: {
		nesting?: StaticWorkflowRuntimeOptions<unknown, unknown>["nesting"];
		definitionIdentitySha256?: string;
	},
	declare: (ctx: WorkflowContext<unknown>) => unknown,
): Promise<unknown> {
	const { journal, artifacts } = await fixture();
	const definition = defineWorkflow({
		meta: parentMeta("rejecting-parent"),
		inputSchema: Type.Object({}),
		outputSchema: Type.Object({}),
		run(ctx) {
			declare(ctx);
			return {};
		},
	});
	const runtime = createStaticWorkflowRuntime({
		definition,
		definitionIdentitySha256:
			options.definitionIdentitySha256 ?? definitionIdentitySha256,
		input: {},
		cwd: "/repo",
		journal,
		artifacts,
		scheduler: schedulerFor(journal, artifacts, new Map()),
		...(options.nesting === undefined ? {} : { nesting: options.nesting }),
	});
	const error = await runtime.drive().then(
		() => undefined,
		(reason: unknown) => reason,
	);
	expect(error).toBeInstanceOf(StaticWorkflowRuntimeError);
	expect((error as StaticWorkflowRuntimeError).stage).toBe("execution");
	const state = await journal.readState();
	expect(Object.keys(state.tasks)).toHaveLength(0);
	expect(state.status).toBe("failed");
	return (error as StaticWorkflowRuntimeError).cause;
}

function request(goal = "Answer") {
	return {
		agent: "researcher",
		task: { goal, context: [], instructions: ["Return structured output."] },
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
			cost: 10,
			outputBytes: 1024,
			workspaceWriteBytes: 0,
			retries: 0,
			resumes: 0,
		},
	};
}

async function fixture(runId = "workflow_static") {
	const root = path.resolve(
		".pi",
		"test-static-runtime",
		`run-${randomUUID()}`,
	);
	const lease = await acquireWorkflowRunLease({
		storeRoot: root,
		runId,
		ownerId: "static-runtime-test",
	});
	leases.add(lease);
	const journal = await WorkflowRunJournal.open(root, runId, lease);
	const artifacts = await WorkflowArtifactStore.open({ journal });
	return { root, lease, journal, artifacts };
}

function completedResult(runId: string, value: unknown): RunResult {
	return {
		runId,
		status: "completed",
		structuredOutput: value,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: 0,
		},
		usageComplete: true,
		runtimeMs: 10,
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
	};
}

function schedulerFor(
	journal: WorkflowRunJournal,
	artifacts: WorkflowArtifactStore,
	outputs: ReadonlyMap<string, unknown>,
): WorkflowSequentialScheduler & { calls: number } {
	const scheduler = {
		concurrency: 1,
		stopSignal: new AbortController().signal,
		calls: 0,
		async drive(): Promise<WorkflowSchedulerOutcome> {
			scheduler.calls += 1;
			let current = await journal.readState();
			if (current.status === "created" || current.status === "waiting") {
				await journal.append("run-status-changed", {
					from: current.status,
					to: "running",
				});
				current = await journal.readState();
			}
			const task = Object.values(current.tasks)
				.sort(
					(left, right) =>
						left.task.materializationSequence -
						right.task.materializationSequence,
				)
				.find((candidate) => candidate.status !== "completed");
			if (!task) return { state: "idle", runStatus: current.status };
			if (task.task.spec.kind !== "agent") {
				throw new Error("fake scheduler only supports agent tasks");
			}
			const output = outputs.get(task.task.spec.key);
			if (output === undefined) throw new Error("missing fake task output");
			if (task.status === "pending") {
				await journal.append("task-status-changed", {
					taskId: task.task.id,
					from: "pending",
					to: "ready",
				});
			}
			const executionId = deriveTaskExecutionId(current.runId, task.task.id, 1);
			const operationId = deriveSubagentOperationId(
				current.runId,
				task.task.id,
				1,
			);
			const childKey = task.task.spec.key.replaceAll("-", "");
			const childRunId = `run_${childKey}`;
			const childAttemptId = `attempt_${childKey}`;
			await journal.append("task-execution-created", {
				execution: {
					kind: "agent",
					id: executionId,
					runId: current.runId,
					taskId: task.task.id,
					generation: 1,
					taskIdentitySha256: task.task.spec.identitySha256,
					operationId,
				},
			});
			await journal.append("task-execution-preflighted", {
				executionId,
				operationId,
				preflightId: `preflight-${task.task.spec.key}`,
				workspaceMode: "read-only" as const,
				workspaceBaselineSha256: "c".repeat(64),
				planIdentitySha256,
				plannedSubagentRunId: childRunId,
				plannedSubagentAttemptId: childAttemptId,
				expiresAt: "2099-01-01T00:00:00.000Z",
			});
			await journal.append("task-execution-launch-intended", {
				executionId,
				operationId,
				preflightId: `preflight-${task.task.spec.key}`,
				planIdentitySha256,
			});
			await journal.append("task-execution-launch-receipted", {
				executionId,
				operationId,
				subagentRunId: childRunId,
				subagentAttemptId: childAttemptId,
				status: "completed",
			});
			await journal.append("task-status-changed", {
				taskId: task.task.id,
				from: "ready",
				to: "waiting",
			});
			await journal.append("task-execution-child-observed", {
				executionId,
				subagentRunId: childRunId,
				subagentAttemptId: childAttemptId,
				status: "completed",
			});
			const result = completedResult(childRunId, output);
			const evidence = {
				kind: "subagent" as const,
				attemptOrdinal: 1,
				resultSha256: deriveSubagentResultSha256(result),
				status: "completed" as const,
				usage: result.usage,
				usageComplete: true,
				runtimeMs: 10,
				sandboxCleanup: "proved" as const,
				workspaceCleanup: "not-needed" as const,
				truncated: false,
				structuredOutputSha256: deriveJsonValueSha256(output),
			};
			await journal.append("task-execution-child-settled", {
				executionId,
				evidence,
			});
			const artifact = await artifacts.putJson(output, {
				runId: current.runId,
				producerTaskId: task.task.id,
				producerExecutionId: executionId,
				output: "result",
				schemaSha256: deriveJsonValueSha256(
					task.task.spec.request.outputSchema,
				),
			});
			await journal.append("artifact-declared", { artifact });
			await journal.append("task-execution-artifact-imported", {
				executionId,
				subagentRunId: childRunId,
				artifactId: artifact.id,
				sourceResultSha256: evidence.resultSha256,
			});
			await journal.append("task-execution-release-intended", {
				executionId,
				subagentRunId: childRunId,
			});
			await journal.append("task-execution-released", {
				executionId,
				subagentRunId: childRunId,
				status: "completed",
			});
			await journal.append("task-execution-terminal", {
				executionId,
				outcome: "completed",
				evidence,
			});
			await journal.append("task-status-changed", {
				taskId: task.task.id,
				from: "waiting",
				to: "completed",
			});
			return {
				state: "awaiting-finalization",
				runStatus: "running",
				taskId: task.task.id,
				executionId,
				child: {
					runId: childRunId,
					attemptId: childAttemptId,
					status: "completed",
				},
				outcome: "completed",
			};
		},
		async reconcile() {
			throw new Error("fake workflow has no cleanup-blocked task");
		},
		async decide() {
			throw new Error("fake scheduler records no decisions");
		},
		async stop() {
			return { state: "terminal", runStatus: "cancelled" } as const;
		},
	};
	return scheduler;
}

afterEach(async () => {
	await Promise.all([...leases].map((lease) => lease.release()));
	leases.clear();
});

afterAll(async () => {
	await rm(nestedRoot, { recursive: true, force: true });
});

describe("static workflow runtime nested workflows", () => {
	it("rejects invalid nesting options at construction", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: parentMeta("nesting-options"),
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({}),
			run() {
				return {};
			},
		});
		const resolveWorkflow = () => undefined;
		for (const nesting of [
			{ depth: 4, ancestorDefinitionIdentities: [], resolveWorkflow },
			{ depth: -1, ancestorDefinitionIdentities: [], resolveWorkflow },
			{ depth: 1, ancestorDefinitionIdentities: [], resolveWorkflow },
			{
				depth: 1,
				ancestorDefinitionIdentities: ["not-a-sha256"],
				resolveWorkflow,
			},
			{
				depth: 0,
				ancestorDefinitionIdentities: [],
				resolveWorkflow: undefined as never,
			},
		]) {
			expect(() =>
				createStaticWorkflowRuntime({
					definition,
					definitionIdentitySha256,
					input: {},
					cwd: "/repo",
					journal,
					artifacts,
					scheduler: schedulerFor(journal, artifacts, new Map()),
					nesting,
				}),
			).toThrow("Static workflow runtime nesting is invalid.");
		}
		expect(await journal.readEvents()).toEqual([]);
	});

	it("rejects nested declarations when the runtime has no nesting", async () => {
		await expect(
			nestedDeclarationFailure({}, (ctx) =>
				ctx.workflow("child", { workflow: "child", input: { value: "x" } }),
			),
		).resolves.toMatchObject({
			stage: "validation",
			message: "Nested workflows are not available in this runtime.",
		});
	});

	it("rejects undiscovered and invalid nested workflow names", async () => {
		await expect(
			nestedDeclarationFailure({ nesting: await nesting() }, (ctx) =>
				ctx.workflow("child", { workflow: "missing", input: { value: "x" } }),
			),
		).resolves.toMatchObject({
			stage: "validation",
			message: "Nested workflow definition is not discovered.",
		});
		await expect(
			nestedDeclarationFailure({ nesting: await nesting() }, (ctx) =>
				ctx.workflow("child", { workflow: "Bad Name", input: {} }),
			),
		).resolves.toMatchObject({
			stage: "validation",
			message: "Nested workflow name is invalid.",
		});
	});

	it("rejects nested declarations at the depth bound", async () => {
		await expect(
			nestedDeclarationFailure(
				{
					nesting: await nesting(3, [
						"1".repeat(64),
						"2".repeat(64),
						"3".repeat(64),
					]),
				},
				(ctx) =>
					ctx.workflow("child", { workflow: "child", input: { value: "x" } }),
			),
		).resolves.toMatchObject({
			stage: "validation",
			message: "Nested workflow depth bound exceeded.",
		});
	});

	it("rejects recursive nested declarations", async () => {
		const child = await discoveredChild();
		await expect(
			nestedDeclarationFailure(
				{
					nesting: await nesting(),
					definitionIdentitySha256: child.identity.identitySha256,
				},
				(ctx) =>
					ctx.workflow("child", { workflow: "child", input: { value: "x" } }),
			),
		).resolves.toMatchObject({
			stage: "validation",
			message: "Nested workflow recursion is not allowed.",
		});
		await expect(
			nestedDeclarationFailure(
				{ nesting: await nesting(1, [child.identity.identitySha256]) },
				(ctx) =>
					ctx.workflow("child", { workflow: "child", input: { value: "x" } }),
			),
		).resolves.toMatchObject({
			stage: "validation",
			message: "Nested workflow recursion is not allowed.",
		});
	});

	it("rejects nested input that does not match the child schema", async () => {
		await expect(
			nestedDeclarationFailure({ nesting: await nesting() }, (ctx) =>
				ctx.workflow("child", { workflow: "child", input: { value: 42 } }),
			),
		).resolves.toMatchObject({
			stage: "validation",
			message: "Nested workflow input does not match its schema.",
		});
		await expect(
			nestedDeclarationFailure({ nesting: await nesting() }, (ctx) =>
				ctx.workflow("child", {
					workflow: "child",
					input: { value: "x", extra: undefined },
				}),
			),
		).resolves.toMatchObject({
			stage: "validation",
			message: "Nested workflow input is not losslessly JSON-serializable.",
		});
	});

	it("declares nested artifact inputs and defers schema validation to launch", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: parentMeta("nested-inputs"),
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			run(ctx) {
				const producer = ctx.agent("producer", {
					...request("Produce the child value"),
					outputSchema: Type.String(),
				});
				return ctx.workflow<{ answer: string }>("child", {
					workflow: "child",
					input: {},
					inputs: { value: producer.output },
				});
			},
		});
		const scheduler = mixedSchedulerFor(
			journal,
			artifacts,
			new Map([["producer", "from agent"]]),
			new Map([
				[
					"child",
					{ status: "completed" as const, output: { answer: "from child" } },
				],
			]),
		);
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
			nesting: await nesting(),
		});
		await expect(runtime.drive()).resolves.toMatchObject({
			status: "completed",
			value: { answer: "from child" },
		});
		const state = await journal.readState();
		const tasks = Object.values(state.tasks).sort(
			(left, right) =>
				left.task.materializationSequence - right.task.materializationSequence,
		);
		expect(tasks.map((task) => task.status)).toEqual([
			"completed",
			"completed",
		]);
		const producer = tasks[0]?.task;
		const child = tasks[1]?.task;
		if (producer?.spec.kind !== "agent" || child?.spec.kind !== "workflow") {
			throw new Error("expected an agent producer and a workflow child");
		}
		expect(child.spec.inputs).toEqual({
			value: {
				runId: journal.runId,
				producerTaskId: producer.id,
				output: "result",
			},
		});
		expect(child.spec.after).toEqual([
			{ runId: journal.runId, taskId: producer.id },
		]);
		expect(child.spec.request.input).toEqual({});
		expect(child.spec.request.inputSha256).toBe(deriveJsonValueSha256({}));
		const intent = Object.values(state.executions).find(
			(execution) => execution.execution.taskId === child.id,
		)?.nestedIntent;
		expect(intent?.inputsSha256).toBe(
			deriveJsonValueSha256({
				value: Object.values(state.artifacts).find(
					(artifact) => artifact.producerTaskId === producer.id,
				)?.sha256,
			}),
		);
		expect(intent?.resolvedInputSha256).toBe(
			deriveJsonValueSha256({ value: "from agent" }),
		);
		const calls = scheduler.calls;
		await expect(runtime.drive()).resolves.toMatchObject({
			status: "completed",
			value: { answer: "from child" },
		});
		expect(scheduler.calls).toBe(calls);
	});

	it("persists support-sourced nested inputs at the declaring barrier", async () => {
		const { journal, artifacts } = await fixture();
		const summarize = defineSupportTask({
			name: "@vegardx/workflow-tools/summarize",
			moduleSpecifier: "@vegardx/workflow-tools",
			revision: 1,
			implementationSha256: "f".repeat(64),
			parametersSchema: Type.Object({ strict: Type.Boolean() }),
			outputSchema: Type.String(),
		});
		const definition = defineWorkflow({
			meta: parentMeta("nested-support-inputs"),
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			run(ctx) {
				const summary = ctx.support(
					"summary",
					summarize({ parameters: { strict: true } }),
				);
				return ctx.workflow<{ answer: string }>("child", {
					workflow: "child",
					input: {},
					inputs: { value: summary.output },
				});
			},
		});
		const sentinel = new Error("scheduler stopped by test");
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler: {
				concurrency: 1,
				stopSignal: new AbortController().signal,
				async drive() {
					throw sentinel;
				},
				async reconcile() {
					throw sentinel;
				},
				async decide() {
					throw new Error("fake scheduler records no decisions");
				},
				async stop() {
					return { state: "terminal", runStatus: "cancelled" } as const;
				},
			},
			nesting: await nesting(),
		});
		await expect(runtime.drive()).rejects.toBe(sentinel);
		const state = await journal.readState();
		const tasks = Object.values(state.tasks).sort(
			(left, right) =>
				left.task.materializationSequence - right.task.materializationSequence,
		);
		const summary = tasks[0]?.task;
		const child = tasks[1]?.task;
		if (summary?.spec.kind !== "support" || child?.spec.kind !== "workflow") {
			throw new Error("expected a support producer and a workflow child");
		}
		expect(child.spec.inputs).toEqual({
			value: {
				runId: journal.runId,
				producerTaskId: summary.id,
				output: "result",
			},
		});
		expect(child.spec.after).toEqual([
			{ runId: journal.runId, taskId: summary.id },
		]);
	});

	it("rejects non-object and colliding authored input with artifact inputs", async () => {
		for (const input of ["text", 42, null, ["value"]]) {
			await expect(
				nestedDeclarationFailure({ nesting: await nesting() }, (ctx) => {
					const producer = ctx.agent("producer", request());
					ctx.workflow("child", {
						workflow: "child",
						input,
						inputs: { value: producer.output },
					});
				}),
			).resolves.toMatchObject({
				stage: "validation",
				message: "Nested workflow artifact inputs require an object input.",
			});
		}
		await expect(
			nestedDeclarationFailure({ nesting: await nesting() }, (ctx) => {
				const producer = ctx.agent("producer", request());
				ctx.workflow("child", {
					workflow: "child",
					input: { value: "authored" },
					inputs: { value: producer.output },
				});
			}),
		).resolves.toMatchObject({
			stage: "validation",
			message: "Nested workflow input name collides with the authored input.",
		});
		await expect(
			nestedDeclarationFailure({ nesting: await nesting() }, (ctx) => {
				const producer = ctx.agent("producer", request());
				ctx.workflow("child", {
					workflow: "child",
					input: { extra: undefined },
					inputs: { value: producer.output },
				});
			}),
		).resolves.toMatchObject({
			stage: "validation",
			message: "Nested workflow input is not losslessly JSON-serializable.",
		});
	});

	it("validates authored input at declaration when artifact inputs are empty", async () => {
		await expect(
			nestedDeclarationFailure({ nesting: await nesting() }, (ctx) =>
				ctx.workflow("child", { workflow: "child", input: {}, inputs: {} }),
			),
		).resolves.toMatchObject({
			stage: "validation",
			message: "Nested workflow input does not match its schema.",
		});
	});

	it("declares, completes, and replays a nested workflow task", async () => {
		const { journal, artifacts } = await fixture();
		const child = await discoveredChild();
		const definition = defineWorkflow({
			meta: parentMeta("nested-parent"),
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			run(ctx) {
				return ctx.workflow<{ answer: string }>("child", {
					workflow: "child",
					input: { value: "nested" },
				});
			},
		});
		const scheduler = nestedSchedulerFor(
			journal,
			artifacts,
			new Map([
				[
					"child",
					{ status: "completed" as const, output: { answer: "from child" } },
				],
			]),
		);
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
			nesting: await nesting(),
		});
		await expect(runtime.drive()).resolves.toMatchObject({
			status: "completed",
			value: { answer: "from child" },
		});
		expect(scheduler.calls).toBe(1);
		const state = await journal.readState();
		const tasks = Object.values(state.tasks);
		expect(tasks).toHaveLength(1);
		const task = tasks[0]?.task;
		if (task?.spec.kind !== "workflow")
			throw new Error("expected workflow task");
		expect(tasks[0]?.status).toBe("completed");
		expect(task.spec.inputs).toEqual({});
		expect(task.spec.after).toEqual([]);
		expect(task.spec.disposition).toBe("required");
		expect(task.spec.replay).toBe("read-only");
		expect(task.spec.request).toEqual({
			definitionName: "child",
			definitionIdentitySha256: child.identity.identitySha256,
			definitionSourceSha256: child.identity.sourceSha256,
			definitionVersion: 2,
			input: { value: "nested" },
			inputSha256: deriveJsonValueSha256({ value: "nested" }),
			inputSchema: child.definition.inputSchema,
			outputSchema: child.definition.outputSchema,
			budget: { cost: 10, totalTokens: 100_000, childRuntimeMs: 600_000 },
			timeoutMs: 600_000,
			concurrency: 2,
		});
		expect(task.spec.request.budget).toEqual(child.definition.meta.budget);
		const execution = Object.values(state.executions)[0];
		expect(execution?.execution.kind).toBe("workflow");
		expect(execution?.terminal?.evidence.kind).toBe("nested-workflow");
		await expect(runtime.drive()).resolves.toMatchObject({
			status: "completed",
			value: { answer: "from child" },
		});
		expect(scheduler.calls).toBe(1);
	});

	it("projects nested workflow failure into settled results", async () => {
		const { journal, artifacts } = await fixture();
		let declaredTaskId = "";
		const definition = defineWorkflow({
			meta: parentMeta("nested-settled"),
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({
				status: Type.String(),
				taskId: Type.String(),
				outcome: Type.String(),
				code: Type.String(),
				message: Type.String(),
			}),
			async run(ctx) {
				const task = ctx.workflow<{ answer: string }>("child", {
					workflow: "child",
					input: { value: "doomed" },
					disposition: "optional",
				});
				declaredTaskId = task.ref.taskId;
				const [outcome] = await ctx.settled([task] as const);
				if (outcome.status !== "rejected") {
					throw new Error("expected a rejected nested task");
				}
				return {
					status: outcome.status,
					taskId: outcome.taskId,
					outcome: outcome.outcome,
					code: outcome.failure?.code ?? "missing",
					message: outcome.failure?.message ?? "missing",
				};
			},
		});
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler: nestedSchedulerFor(
				journal,
				artifacts,
				new Map([["child", { status: "failed" as const }]]),
			),
			nesting: await nesting(),
		});
		const result = completed(await runtime.drive());
		expect(result.status).toBe("completed-degraded");
		expect(result.value).toEqual({
			status: "rejected",
			taskId: declaredTaskId,
			outcome: "failed",
			code: "nested-workflow",
			message: "failed",
		});
		expect(declaredTaskId).not.toBe("");
	});
});

describe("static workflow runtime", () => {
	it("commits and replays a concrete workflow output", async () => {
		const { journal, artifacts } = await fixture();
		let calls = 0;
		const definition = defineWorkflow({
			meta: {
				name: "concrete",
				description: "Concrete",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({ value: Type.String() }),
			outputSchema: Type.Object({ answer: Type.String() }),
			run(ctx) {
				calls += 1;
				ctx.phase("answering");
				ctx.log("Returning concrete output.");
				return { answer: ctx.input.value };
			},
		});
		const scheduler = schedulerFor(journal, artifacts, new Map());
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: { value: "yes" },
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		const first = completed(await runtime.drive());
		const replay = await runtime.drive();
		expect(first).toMatchObject({
			status: "completed",
			value: { answer: "yes" },
		});
		expect(replay).toEqual(first);
		expect(calls).toBe(2);
		expect(scheduler.calls).toBe(0);
		expect(
			(await journal.readState()).effects.map((effect) => [
				effect.kind,
				effect.value,
			]),
		).toEqual([
			["phase", "answering"],
			["log", "Returning concrete output."],
		]);
		expect(await artifacts.readJson(first.artifact)).toEqual({ answer: "yes" });
	});

	it("executes and replays a result-dependent branch", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: {
				name: "branch",
				description: "Branch",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			async run(ctx) {
				const first = ctx.agent("first", request("First"));
				const result = await ctx.result(first);
				if (result.answer === "continue") {
					return ctx.agent("second", request("Second"));
				}
				return first;
			},
		});
		const scheduler = schedulerFor(
			journal,
			artifacts,
			new Map([
				["first", { answer: "continue" }],
				["second", { answer: "done" }],
			]),
		);
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		await expect(runtime.drive()).resolves.toMatchObject({
			status: "completed",
			value: { answer: "done" },
		});
		expect(scheduler.calls).toBe(2);
		await expect(runtime.drive()).resolves.toMatchObject({
			value: { answer: "done" },
		});
		expect(scheduler.calls).toBe(2);
		const state = await journal.readState();
		expect(state.barriers.map((barrier) => barrier.kind)).toEqual([
			"result",
			"final",
		]);
		expect(Object.values(state.tasks).map((task) => task.status)).toEqual([
			"completed",
			"completed",
		]);
	});

	it("returns declaration-ordered fulfilled settled results", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: {
				name: "settled",
				description: "Settled",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ values: Type.Array(Type.String()) }),
			async run(ctx) {
				const tasks = ctx.fanOut(
					"items",
					[
						{ id: "first", goal: "First" },
						{ id: "second", goal: "Second" },
					],
					{
						key: (item) => item.id,
						task: (item) => request(item.goal),
					},
				);
				const outcomes = await ctx.settled(tasks);
				return {
					values: outcomes.map((outcome) =>
						outcome.status === "fulfilled" ? outcome.value.answer : "rejected",
					),
				};
			},
		});
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler: schedulerFor(
				journal,
				artifacts,
				new Map([
					["first", { answer: "alpha" }],
					["second", { answer: "beta" }],
				]),
			),
		});

		await expect(runtime.drive()).resolves.toMatchObject({
			value: { values: ["alpha", "beta"] },
		});
		const state = await journal.readState();
		expect(state.barriers[0]?.kind).toBe("settled");
		expect(
			Object.values(state.tasks).map((task) => task.task.namespace),
		).toEqual([["items"], ["items"]]);
	});

	it("materializes a namespace-scoped pipeline with explicit artifact flow", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: {
				name: "pipeline",
				description: "Pipeline",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			run(ctx) {
				return ctx.pipeline("analysis", (stage) => {
					const collect = stage.agent("collect", request("Collect"));
					return stage.agent("review", {
						...request("Review"),
						inputs: { input: collect.output },
					});
				});
			},
		});
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler: schedulerFor(
				journal,
				artifacts,
				new Map([
					["collect", { answer: "draft" }],
					["review", { answer: "approved" }],
				]),
			),
		});
		await expect(runtime.drive()).resolves.toMatchObject({
			value: { answer: "approved" },
		});
		const tasks = Object.values((await journal.readState()).tasks).map(
			(task) => task.task,
		);
		expect(tasks.map((task) => task.namespace)).toEqual([
			["analysis"],
			["analysis"],
		]);
		expect(Object.keys(tasks[1]?.spec.inputs ?? {})).toEqual(["input"]);
		expect(tasks[1]?.spec.after).toEqual([
			{ runId: tasks[0]?.runId, taskId: tasks[0]?.id },
		]);
	});

	it("rejects oversized pipelines and foreign final handles", async () => {
		for (const kind of ["oversized", "foreign"] as const) {
			const { journal, artifacts } = await fixture();
			const definition = defineWorkflow({
				meta: {
					name: `pipeline-${kind}`,
					description: "Invalid",
					version: 1,
					budget: { cost: 1000, childRuntimeMs: 3600000 },
					timeoutMs: 3600000,
				},
				inputSchema: Type.Object({}),
				outputSchema: Type.Object({ answer: Type.String() }),
				run(ctx) {
					const external = ctx.agent("external", request());
					return ctx.pipeline("stages", (stage) => {
						let final = stage.agent("stage-0", request());
						if (kind === "oversized") {
							for (let index = 1; index <= 64; index += 1) {
								final = stage.agent(`stage-${index}`, request());
							}
						}
						return kind === "foreign" ? external : final;
					});
				},
			});
			const runtime = createStaticWorkflowRuntime({
				definition,
				definitionIdentitySha256,
				input: {},
				cwd: "/repo",
				journal,
				artifacts,
				scheduler: schedulerFor(journal, artifacts, new Map()),
			});
			await expect(runtime.drive()).rejects.toMatchObject({
				stage: "execution",
			});
			expect(Object.keys((await journal.readState()).tasks)).toHaveLength(0);
		}
	});

	it("materializes bounded fan-in with explicit named artifact inputs", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: {
				name: "fan-in",
				description: "Fan in",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			run(ctx) {
				const sources = ctx.fanOut("items", ["first", "second"], {
					key: (item) => item,
					task: (item) => request(item),
				});
				return ctx.fanIn("aggregate", sources, {
					inputKey: (_, index) => `item-${index}`,
					task: request("Aggregate"),
				});
			},
		});
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler: schedulerFor(
				journal,
				artifacts,
				new Map([
					["first", { answer: "alpha" }],
					["second", { answer: "beta" }],
					["aggregate", { answer: "combined" }],
				]),
			),
		});
		await expect(runtime.drive()).resolves.toMatchObject({
			value: { answer: "combined" },
		});
		const state = await journal.readState();
		const aggregate = Object.values(state.tasks).find(
			(task) => task.task.spec.key === "aggregate",
		)?.task;
		expect(Object.keys(aggregate?.spec.inputs ?? {})).toEqual([
			"item-0",
			"item-1",
		]);
		expect(aggregate?.spec.after).toHaveLength(2);
	});

	it("rejects empty and duplicate-key fan-in before its barrier", async () => {
		for (const kind of ["empty", "duplicate"] as const) {
			const { journal, artifacts } = await fixture();
			const definition = defineWorkflow({
				meta: {
					name: `fan-in-${kind}`,
					description: "Invalid",
					version: 1,
					budget: { cost: 1000, childRuntimeMs: 3600000 },
					timeoutMs: 3600000,
				},
				inputSchema: Type.Object({}),
				outputSchema: Type.Object({}),
				run(ctx) {
					const sources =
						kind === "empty"
							? []
							: [ctx.agent("first", request()), ctx.agent("second", request())];
					ctx.fanIn("aggregate", sources, {
						inputKey: () => "duplicate",
						task: request("Aggregate"),
					});
					return {};
				},
			});
			const runtime = createStaticWorkflowRuntime({
				definition,
				definitionIdentitySha256,
				input: {},
				cwd: "/repo",
				journal,
				artifacts,
				scheduler: schedulerFor(journal, artifacts, new Map()),
			});
			await expect(runtime.drive()).rejects.toMatchObject({
				stage: "execution",
			});
			expect(Object.keys((await journal.readState()).tasks)).toHaveLength(0);
		}
	});

	it("rejects oversized fan-out before task materialization", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: {
				name: "fan-out-bound",
				description: "Bound",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({}),
			run(ctx) {
				ctx.fanOut(
					"items",
					Array.from({ length: 65 }, (_, index) => index),
					{
						key: (item) => `item-${item}`,
						task: () => request("Item"),
					},
				);
				return {};
			},
		});
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler: schedulerFor(journal, artifacts, new Map()),
		});
		await expect(runtime.drive()).rejects.toMatchObject({ stage: "execution" });
		const state = await journal.readState();
		expect(Object.keys(state.tasks)).toHaveLength(0);
		expect(state.status).toBe("failed");
	});

	it("returns bounded rejection evidence for an optional task", async () => {
		const { journal, artifacts } = await fixture();
		const message = "Subagent preflight failed before launch.";
		const scheduler: WorkflowSequentialScheduler = {
			concurrency: 1,
			stopSignal: new AbortController().signal,
			async drive() {
				let current = await journal.readState();
				if (current.status === "created") {
					await journal.append("run-status-changed", {
						from: "created",
						to: "running",
					});
					current = await journal.readState();
				}
				const task = Object.values(current.tasks)[0];
				if (!task || task.status === "failed") {
					return { state: "idle" as const, runStatus: "running" as const };
				}
				await journal.append("task-status-changed", {
					taskId: task.task.id,
					from: "pending",
					to: "ready",
				});
				const executionId = deriveTaskExecutionId(
					current.runId,
					task.task.id,
					1,
				);
				await journal.append("task-execution-created", {
					execution: {
						kind: "agent",
						id: executionId,
						runId: current.runId,
						taskId: task.task.id,
						generation: 1,
						taskIdentitySha256: task.task.spec.identitySha256,
						operationId: deriveSubagentOperationId(
							current.runId,
							task.task.id,
							1,
						),
					},
				});
				await journal.append("task-execution-terminal", {
					executionId,
					outcome: "failed",
					evidence: {
						kind: "workflow",
						stage: "preflight",
						failureSha256: deriveWorkflowFailureSha256("preflight", message),
						message,
					},
				});
				await journal.append("task-status-changed", {
					taskId: task.task.id,
					from: "ready",
					to: "failed",
				});
				throw new Error("preflight failed after durable task failure");
			},
			async reconcile() {
				throw new Error("not cleanup-blocked");
			},
			async decide() {
				throw new Error("fake scheduler records no decisions");
			},
			async stop() {
				return { state: "terminal" as const, runStatus: "cancelled" as const };
			},
		};
		const definition = defineWorkflow({
			meta: {
				name: "rejected",
				description: "Rejected",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({
				status: Type.String(),
				message: Type.String(),
			}),
			async run(ctx) {
				const task = ctx.agent("optional", {
					...request("Optional"),
					disposition: "optional",
				});
				const [outcome] = await ctx.settled([task] as const);
				return {
					status: outcome.status,
					message:
						outcome.status === "rejected"
							? (outcome.failure?.message ?? "missing")
							: "fulfilled",
				};
			},
		});
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		await expect(runtime.drive()).resolves.toMatchObject({
			status: "completed-degraded",
			value: { status: "rejected", message },
		});
	});

	it("captures result barriers before later synchronous effects", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: {
				name: "ordering",
				description: "Ordering",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			async run(ctx) {
				const task = ctx.agent("answer", request());
				const pending = ctx.result(task);
				ctx.log("after result barrier");
				return pending;
			},
		});
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler: schedulerFor(
				journal,
				artifacts,
				new Map([["answer", { answer: "yes" }]]),
			),
		});
		await runtime.drive();
		const state = await journal.readState();
		expect(state.barriers[0]?.sequence).toBeLessThan(
			state.effects[0]?.sequence ?? 0,
		);
		await expect(runtime.drive()).resolves.toMatchObject({
			value: { answer: "yes" },
		});
	});

	it("settles declared final-epoch work before concrete completion", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: {
				name: "effects-only",
				description: "Effects only",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			run(ctx) {
				ctx.agent("side-effect", request("Required work"));
				return { answer: "complete" };
			},
		});
		const scheduler = schedulerFor(
			journal,
			artifacts,
			new Map([["side-effect", { answer: "done" }]]),
		);
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		await expect(runtime.drive()).resolves.toMatchObject({
			value: { answer: "complete" },
		});
		expect(scheduler.calls).toBe(1);
		expect(Object.values((await journal.readState()).tasks)[0]?.status).toBe(
			"completed",
		);
	});

	it("rejects declaration drift on source re-execution", async () => {
		const { journal, artifacts } = await fixture();
		let goal = "Original";
		const definition = defineWorkflow({
			meta: {
				name: "drift",
				description: "Drift",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			run(ctx) {
				return ctx.agent("answer", request(goal));
			},
		});
		const scheduler = schedulerFor(
			journal,
			artifacts,
			new Map([["answer", { answer: "done" }]]),
		);
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		await runtime.drive();
		goal = "Changed";
		await expect(runtime.drive()).rejects.toBeInstanceOf(
			StaticWorkflowRuntimeError,
		);
	});

	it("rejects changed final output and invalid input", async () => {
		const { journal, artifacts } = await fixture();
		let answer = "first";
		const definition = defineWorkflow({
			meta: {
				name: "output",
				description: "Output",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({ value: Type.String() }),
			outputSchema: Type.Object({ answer: Type.String() }),
			run() {
				return { answer };
			},
		});
		const scheduler = schedulerFor(journal, artifacts, new Map());
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: { value: "yes" },
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		await runtime.drive();
		answer = "changed";
		await expect(runtime.drive()).rejects.toThrow("output changed");

		const invalidFixture = await fixture("workflow_invalid");
		expect(() =>
			createStaticWorkflowRuntime({
				definition,
				definitionIdentitySha256,
				input: { value: 42 } as never,
				cwd: "/repo",
				journal: invalidFixture.journal,
				artifacts: invalidFixture.artifacts,
				scheduler: schedulerFor(
					invalidFixture.journal,
					invalidFixture.artifacts,
					new Map(),
				),
			}),
		).toThrow("input does not match");
		expect(await invalidFixture.journal.readEvents()).toEqual([]);
	});

	it("rejects changed or omitted phase and log effects", async () => {
		const { journal, artifacts } = await fixture();
		let includeLog = true;
		const definition = defineWorkflow({
			meta: {
				name: "effects",
				description: "Effects",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			run(ctx) {
				ctx.phase("work");
				if (includeLog) ctx.log("stable log");
				return { answer: "yes" };
			},
		});
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler: schedulerFor(journal, artifacts, new Map()),
		});
		await runtime.drive();
		includeLog = false;
		await expect(runtime.drive()).rejects.toThrow("omitted a persisted");
	});

	it("persists fresh source failure without exposing its raw error", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: {
				name: "failure",
				description: "Failure",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			run() {
				throw new Error("sensitive implementation detail");
			},
		});
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler: schedulerFor(journal, artifacts, new Map()),
		});
		await expect(runtime.drive()).rejects.toMatchObject({
			stage: "execution",
			message: "Static workflow source execution failed.",
		});
		const events = await journal.readEvents();
		expect(reduceWorkflowEvents(events).status).toBe("failed");
		expect(JSON.stringify(events)).not.toContain("sensitive implementation");
	});

	it("repairs completion after durable output commit", async () => {
		const { journal, artifacts } = await fixture();
		const input = {};
		const inputSha256 = deriveJsonValueSha256(input);
		const outputSchema = Type.Object({ answer: Type.String() });
		const definition = defineWorkflow({
			meta: {
				name: "repair",
				description: "Repair",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({}),
			outputSchema,
			run() {
				return { answer: "yes" };
			},
		});
		await journal.append("run-created", {
			definitionIdentitySha256,
			inputSha256,
		});
		const materializer = new WorkflowTaskMaterializer({
			runId: journal.runId,
			definitionIdentitySha256,
			inputSha256,
		});
		for (const event of materializer.closeEpoch("final", []).events) {
			await journal.appendEvent(event);
		}
		await journal.append("run-status-changed", {
			from: "created",
			to: "running",
		});
		await journal.append("run-status-changed", {
			from: "running",
			to: "finalizing",
		});
		const artifact = await artifacts.putJson(
			{ answer: "yes" },
			{
				runId: journal.runId,
				schemaSha256: deriveJsonValueSha256(outputSchema),
			},
		);
		await journal.append("artifact-declared", { artifact });
		await journal.append("run-output-committed", { artifactId: artifact.id });
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input,
			cwd: "/repo",
			journal,
			artifacts,
			scheduler: schedulerFor(journal, artifacts, new Map()),
		});
		await expect(runtime.drive()).resolves.toMatchObject({
			status: "completed",
			value: { answer: "yes" },
		});
		expect((await journal.readState()).status).toBe("completed");
	});

	it("serializes concurrent source drives", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: {
				name: "serial",
				description: "Serial",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			run() {
				return { answer: "yes" };
			},
		});
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler: schedulerFor(journal, artifacts, new Map()),
		});
		const [first, second] = await Promise.all([
			runtime.drive(),
			runtime.drive(),
		]);
		expect(second).toEqual(first);
	});
});

// ---------------------------------------------------------------------------
// Worktree tasks and handoffs (spec sections 5, 7, 8.3).
// ---------------------------------------------------------------------------

const HANDOFF_BASELINE_HEAD = "b".repeat(40);
const HANDOFF_UNVERIFIED_MESSAGE =
	"Completed worktree task has no verified handoff artifact.";

/** The rendered commit of a generation; distinct generations capture distinct commits. */
function handoffCommitFor(generation: number): string {
	return `${"a".repeat(39)}${generation}`;
}

/** A single-commit `git format-patch` rendering with git's fixed mbox date. */
function handoffPatch(commit: string): Buffer {
	return Buffer.from(
		[
			`From ${commit} Mon Sep 17 00:00:00 2001`,
			"From: Writer <writer@example.com>",
			"Subject: [PATCH] Write the change",
			"",
			"---",
			"diff --git a/file.txt b/file.txt",
			"--- a/file.txt",
			"+++ b/file.txt",
			"@@ -1 +1 @@",
			"-before",
			`+after ${commit}`,
			"",
		].join("\n"),
		"utf8",
	);
}

function worktreeRequest(goal = "Write") {
	const base = request(goal);
	return {
		...base,
		agent: "writer",
		tools: ["read", "write"],
		workspace: { mode: "worktree" as const, cwd: "/repo" },
		limits: { ...base.limits, workspaceWriteBytes: 1_048_576 },
	};
}

interface WorktreeOutcome {
	readonly output: unknown;
	/** The commit rendered on the patch's first line when it must disagree. */
	readonly patchCommit?: string;
}

/**
 * Settles the first on-path pending/ready worktree agent task with the next
 * execution generation through spec 4.5's "worktree success" ladder: the
 * settlement carries handoff identity, the result and handoff artifacts are
 * declared and imported before release intent, then the child is released
 * and terminalized on subagent evidence.
 */
function worktreeSchedulerFor(
	journal: WorkflowRunJournal,
	artifacts: WorkflowArtifactStore,
	outcomes: ReadonlyMap<string, WorktreeOutcome>,
): WorkflowSequentialScheduler & { calls: number } {
	const scheduler = {
		concurrency: 1,
		stopSignal: new AbortController().signal,
		calls: 0,
		async drive(): Promise<WorkflowSchedulerOutcome> {
			scheduler.calls += 1;
			let current = await journal.readState();
			if (current.status === "created" || current.status === "waiting") {
				await journal.append("run-status-changed", {
					from: current.status,
					to: "running",
				});
				current = await journal.readState();
			}
			const task = Object.values(current.tasks)
				.filter((candidate) => candidate.abandoned !== true)
				.sort(
					(left, right) =>
						left.task.materializationSequence -
						right.task.materializationSequence,
				)
				.find(
					(candidate) =>
						candidate.status === "pending" || candidate.status === "ready",
				);
			if (!task) return { state: "idle", runStatus: current.status };
			const spec = task.task.spec;
			if (spec.kind !== "agent" || spec.request.workspace.mode !== "worktree") {
				throw new Error("fake worktree scheduler only supports worktree tasks");
			}
			const outcome = outcomes.get(spec.key);
			if (!outcome) throw new Error(`missing fake outcome for ${spec.key}`);
			const taskId = task.task.id;
			const generation =
				1 +
				Object.values(current.executions).filter(
					(execution) => execution.execution.taskId === taskId,
				).length;
			if (task.status === "pending") {
				await journal.append("task-status-changed", {
					taskId,
					from: "pending",
					to: "ready",
				});
			}
			const executionId = deriveTaskExecutionId(
				current.runId,
				taskId,
				generation,
			);
			const operationId = deriveSubagentOperationId(
				current.runId,
				taskId,
				generation,
			);
			const childKey = `${spec.key.replaceAll("-", "")}g${generation}`;
			const childRunId = `run_${childKey}`;
			const childAttemptId = `attempt_${childKey}`;
			await journal.append("task-execution-created", {
				execution: {
					kind: "agent",
					id: executionId,
					runId: current.runId,
					taskId,
					generation,
					taskIdentitySha256: spec.identitySha256,
					operationId,
				},
			});
			await journal.append("task-execution-preflighted", {
				executionId,
				operationId,
				preflightId: `preflight-${childKey}`,
				workspaceMode: "worktree",
				workspaceBaselineSha256: `${"c".repeat(63)}${generation}`,
				planIdentitySha256,
				plannedSubagentRunId: childRunId,
				plannedSubagentAttemptId: childAttemptId,
				expiresAt: "2099-01-01T00:00:00.000Z",
			});
			await journal.append("task-execution-launch-intended", {
				executionId,
				operationId,
				preflightId: `preflight-${childKey}`,
				planIdentitySha256,
			});
			await journal.append("task-execution-launch-receipted", {
				executionId,
				operationId,
				subagentRunId: childRunId,
				subagentAttemptId: childAttemptId,
				status: "completed",
			});
			await journal.append("task-status-changed", {
				taskId,
				from: "ready",
				to: "waiting",
			});
			await journal.append("task-execution-child-observed", {
				executionId,
				subagentRunId: childRunId,
				subagentAttemptId: childAttemptId,
				status: "completed",
			});
			const handoffCommit = handoffCommitFor(generation);
			const result = completedResult(childRunId, outcome.output);
			const evidence = {
				kind: "subagent" as const,
				attemptOrdinal: 1,
				resultSha256: deriveSubagentResultSha256(result),
				status: "completed" as const,
				usage: result.usage,
				usageComplete: true,
				runtimeMs: 10,
				sandboxCleanup: "proved" as const,
				workspaceCleanup: "proved" as const,
				truncated: false,
				structuredOutputSha256: deriveJsonValueSha256(outcome.output),
				handoff: {
					attemptId: childAttemptId,
					baselineHead: HANDOFF_BASELINE_HEAD,
					handoffCommit,
				},
			};
			await journal.append("task-execution-child-settled", {
				executionId,
				evidence,
			});
			const artifact = await artifacts.putJson(outcome.output, {
				runId: current.runId,
				producerTaskId: taskId,
				producerExecutionId: executionId,
				output: "result",
				schemaSha256: deriveJsonValueSha256(spec.request.outputSchema),
			});
			await journal.append("artifact-declared", { artifact });
			await journal.append("task-execution-artifact-imported", {
				executionId,
				subagentRunId: childRunId,
				artifactId: artifact.id,
				sourceResultSha256: evidence.resultSha256,
			});
			const handoff = await artifacts.putBytes(
				handoffPatch(outcome.patchCommit ?? handoffCommit),
				{
					runId: current.runId,
					producerTaskId: taskId,
					producerExecutionId: executionId,
					output: "handoff",
					mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
					schemaSha256: WORKFLOW_HANDOFF_FORMAT_SHA256,
				},
			);
			await journal.append("artifact-declared", { artifact: handoff });
			await journal.append("task-execution-handoff-imported", {
				executionId,
				subagentRunId: childRunId,
				subagentAttemptId: childAttemptId,
				artifactId: handoff.id,
				handoffCommit,
				baselineHead: HANDOFF_BASELINE_HEAD,
				sha256: handoff.sha256,
				bytes: handoff.bytes,
			});
			await journal.append("task-execution-release-intended", {
				executionId,
				subagentRunId: childRunId,
			});
			await journal.append("task-execution-released", {
				executionId,
				subagentRunId: childRunId,
				status: "completed",
			});
			await journal.append("task-execution-terminal", {
				executionId,
				outcome: "completed",
				evidence,
			});
			await journal.append("task-status-changed", {
				taskId,
				from: "waiting",
				to: "completed",
			});
			return {
				state: "awaiting-finalization",
				runStatus: "running",
				taskId,
				executionId,
				child: {
					runId: childRunId,
					attemptId: childAttemptId,
					status: "completed",
				},
				outcome: "completed",
			};
		},
		async reconcile() {
			throw new Error("fake worktree workflow has no cleanup-blocked task");
		},
		async decide() {
			throw new Error("fake scheduler records no decisions");
		},
		async stop() {
			return { state: "terminal", runStatus: "cancelled" } as const;
		},
	};
	return scheduler;
}

function worktreeMeta(name: string) {
	return {
		name,
		description: "Worktree",
		version: 1,
		budget: { cost: 1000, childRuntimeMs: 3600000 },
		timeoutMs: 3600000,
	};
}

/** The handoff artifacts a task declared, in declaration order. */
function handoffArtifactsOf(
	state: ReturnType<typeof reduceWorkflowEvents>,
	taskId: string,
) {
	return Object.values(state.artifacts).filter(
		(artifact) =>
			artifact.producerTaskId === taskId && artifact.output === "handoff",
	);
}

function writerTaskId(state: ReturnType<typeof reduceWorkflowEvents>): string {
	const writer = Object.values(state.tasks).find(
		(task) => task.task.spec.key === "writer",
	);
	if (!writer) throw new Error("missing writer task");
	return writer.task.id;
}

describe("static workflow runtime worktree handoffs", () => {
	it("resolves a verified handoff descriptor through ctx.handoff as a result barrier", async () => {
		const { journal, artifacts } = await fixture();
		let seen: WorkflowHandoffDescriptor | undefined;
		const definition = defineWorkflow({
			meta: worktreeMeta("handoff-descriptor"),
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ commit: Type.String() }),
			async run(ctx) {
				const writer = ctx.agent("writer", worktreeRequest());
				const descriptor = await ctx.handoff(writer);
				seen = descriptor;
				return { commit: descriptor?.handoffCommit ?? "none" };
			},
		});
		const scheduler = worktreeSchedulerFor(
			journal,
			artifacts,
			new Map([["writer", { output: { answer: "written" } }]]),
		);
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		await expect(runtime.drive()).resolves.toMatchObject({
			status: "completed",
			value: { commit: handoffCommitFor(1) },
		});
		expect(scheduler.calls).toBe(1);
		const state = await journal.readState();
		const taskId = writerTaskId(state);
		const executionId = deriveTaskExecutionId(journal.runId, taskId, 1);
		const [handoff] = handoffArtifactsOf(state, taskId);
		if (!handoff) throw new Error("missing handoff artifact");
		expect(seen).toEqual({
			artifactId: handoff.id,
			runId: journal.runId,
			producerTaskId: taskId,
			producerExecutionId: executionId,
			subagentRunId: "run_writerg1",
			subagentAttemptId: "attempt_writerg1",
			baselineHead: HANDOFF_BASELINE_HEAD,
			handoffCommit: handoffCommitFor(1),
			format: "git-format-patch",
			mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
			sha256: handoff.sha256,
			bytes: handoff.bytes,
		});
		expect(Value.Check(WorkflowHandoffDescriptorSchema, seen)).toBe(true);
		expect(Object.isFrozen(seen)).toBe(true);
		// The descriptor carries identity only: no path, branch, or ref.
		const serialized = JSON.stringify(seen);
		expect(serialized).not.toContain("worktreePath");
		expect(serialized).not.toContain("refs/pi-subagent");
		expect(serialized).not.toContain("branch");
		// A persisted "result"-kind barrier, no new barrier kind.
		expect(state.barriers.map((barrier) => barrier.kind)).toEqual([
			"result",
			"final",
		]);
		expect(state.barriers[0]?.taskIds).toEqual([taskId]);
		// Replay reuses the verified artifact without driving the scheduler.
		await expect(runtime.drive()).resolves.toMatchObject({
			value: { commit: handoffCommitFor(1) },
		});
		expect(scheduler.calls).toBe(1);
	});

	it("rejects ctx.handoff on a handle without a handoff", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: worktreeMeta("handoff-read-only"),
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({}),
			async run(ctx) {
				const reader = ctx.agent("reader", request("Read"));
				await ctx.handoff(reader as never);
				return {};
			},
		});
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler: schedulerFor(journal, artifacts, new Map()),
		});
		const error = await runtime.drive().then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(error).toMatchObject({ stage: "execution" });
		expect((error as StaticWorkflowRuntimeError).cause).toMatchObject({
			stage: "validation",
			message: "Workflow handoff barrier requires a worktree task handle.",
		});
	});

	it("commits a returned handoff handle's descriptor as the JSON run output", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: worktreeMeta("handoff-output"),
			inputSchema: Type.Object({}),
			outputSchema: WorkflowHandoffDescriptorSchema,
			run(ctx) {
				const writer = ctx.agent("writer", worktreeRequest());
				return writer.handoff;
			},
		});
		const scheduler = worktreeSchedulerFor(
			journal,
			artifacts,
			new Map([["writer", { output: { answer: "written" } }]]),
		);
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		const result = completed(await runtime.drive());
		expect(result.status).toBe("completed");
		const state = await journal.readState();
		const taskId = writerTaskId(state);
		const [handoff] = handoffArtifactsOf(state, taskId);
		if (!handoff) throw new Error("missing handoff artifact");
		expect(result.value).toEqual({
			artifactId: handoff.id,
			runId: journal.runId,
			producerTaskId: taskId,
			producerExecutionId: deriveTaskExecutionId(journal.runId, taskId, 1),
			subagentRunId: "run_writerg1",
			subagentAttemptId: "attempt_writerg1",
			baselineHead: HANDOFF_BASELINE_HEAD,
			handoffCommit: handoffCommitFor(1),
			format: "git-format-patch",
			mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
			sha256: handoff.sha256,
			bytes: handoff.bytes,
		});
		// The run output is the ordinary JSON artifact, never the patch blob.
		expect(result.artifact.id).toBe(state.outputArtifactId);
		expect(result.artifact.id).not.toBe(handoff.id);
		expect(result.artifact).toMatchObject({
			mediaType: "application/json",
			schemaSha256: deriveJsonValueSha256(WorkflowHandoffDescriptorSchema),
		});
		expect(result.artifact.producerTaskId).toBeUndefined();
		expect(await artifacts.readJson(result.artifact)).toEqual(result.value);
		expect(state.barriers.map((barrier) => barrier.kind)).toEqual(["final"]);
		const replay = await runtime.drive();
		expect(replay).toEqual(result);
		expect(scheduler.calls).toBe(1);
	});

	it("rejects a returned handoff handle the run never declared", async () => {
		const { journal, artifacts } = await fixture();
		const foreign = new WorkflowTaskMaterializer({
			runId: journal.runId,
			definitionIdentitySha256,
			inputSha256: deriveJsonValueSha256({}),
		}).agent("foreign", worktreeRequest("Foreign")).handoff;
		const definition = defineWorkflow({
			meta: worktreeMeta("handoff-foreign"),
			inputSchema: Type.Object({}),
			outputSchema: WorkflowHandoffDescriptorSchema,
			run() {
				return foreign;
			},
		});
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler: schedulerFor(journal, artifacts, new Map()),
		});
		await expect(runtime.drive()).rejects.toMatchObject({
			stage: "finalization",
			message: "Workflow returned an unknown handoff handle.",
		});
	});

	it("fails the result when the handoff blob names another commit", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: worktreeMeta("handoff-corrupt-commit"),
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			run(ctx) {
				return ctx.agent("writer", worktreeRequest());
			},
		});
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler: worktreeSchedulerFor(
				journal,
				artifacts,
				new Map([
					[
						"writer",
						{ output: { answer: "written" }, patchCommit: "f".repeat(40) },
					],
				]),
			),
		});
		const error = await runtime.drive().then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(error).toBeInstanceOf(StaticWorkflowRuntimeError);
		expect(error).toMatchObject({
			stage: "result",
			message: HANDOFF_UNVERIFIED_MESSAGE,
		});
		const cause = (error as StaticWorkflowRuntimeError).cause;
		expect(cause).toBeInstanceOf(WorkflowHandoffVerificationError);
		expect((cause as WorkflowHandoffVerificationError).reason).toBe(
			"commit-mismatch",
		);
		// The journal is valid; only the workflow-owned bytes fail identity.
		const state = await journal.readState();
		expect(state.tasks[writerTaskId(state)]?.status).toBe("completed");
		expect(state.outputArtifactId).toBeUndefined();
	});

	it("fails the result with the fixed message when the handoff blob is missing or corrupt", async () => {
		const { journal, artifacts } = await fixture();
		let handoffCalls = 0;
		const definition = defineWorkflow({
			meta: worktreeMeta("handoff-blob"),
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			async run(ctx) {
				const writer = ctx.agent("writer", worktreeRequest());
				const result = await ctx.result(writer);
				handoffCalls += 1;
				return result;
			},
		});
		const scheduler = worktreeSchedulerFor(
			journal,
			artifacts,
			new Map([["writer", { output: { answer: "written" } }]]),
		);
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		await expect(runtime.drive()).resolves.toMatchObject({
			status: "completed",
			value: { answer: "written" },
		});
		expect(handoffCalls).toBe(1);
		const state = await journal.readState();
		const [handoff] = handoffArtifactsOf(state, writerTaskId(state));
		if (!handoff) throw new Error("missing handoff artifact");
		const blob = path.join(artifacts.root, `${handoff.sha256}.patch`);

		async function replayFailure(): Promise<WorkflowHandoffVerificationError> {
			const error = await runtime.drive().then(
				() => undefined,
				(reason: unknown) => reason,
			);
			// ctx.result rejected inside the source: the runtime reports the
			// source failure and keeps the exact result error as its cause.
			expect(error).toMatchObject({
				stage: "execution",
				message: "Static workflow source execution failed.",
			});
			const cause = (error as StaticWorkflowRuntimeError).cause;
			expect(cause).toBeInstanceOf(StaticWorkflowRuntimeError);
			expect(cause).toMatchObject({
				stage: "result",
				message: HANDOFF_UNVERIFIED_MESSAGE,
			});
			const verification = (cause as StaticWorkflowRuntimeError).cause;
			expect(verification).toBeInstanceOf(WorkflowHandoffVerificationError);
			return verification as WorkflowHandoffVerificationError;
		}

		// Corrupt: same length, different bytes, so the digest no longer matches.
		await writeFile(blob, Buffer.alloc(handoff.bytes, 0x78));
		expect((await replayFailure()).reason).toBe("artifact-unreadable");
		// Missing: the content-addressed blob is gone.
		await rm(blob);
		expect((await replayFailure()).reason).toBe("artifact-unreadable");
		expect(scheduler.calls).toBe(1);
		expect(handoffCalls).toBe(1);
		// The durable journal is untouched by the failed replays.
		const after = await journal.readState();
		expect(after.tasks[writerTaskId(after)]?.status).toBe("completed");
		expect(after.status).toBe("completed");
		expect(after.lastSequence).toBe(state.lastSequence);
	});

	it("selects the generation-2 handoff artifact while the generation-1 artifact remains declared", async () => {
		const { journal, artifacts } = await fixture();
		let failSource = true;
		const descriptors: (WorkflowHandoffDescriptor | undefined)[] = [];
		const definition = defineWorkflow({
			meta: worktreeMeta("handoff-generations"),
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({
				commit: Type.String(),
				answer: Type.String(),
			}),
			async run(ctx) {
				const writer = ctx.agent("writer", worktreeRequest());
				const descriptor = await ctx.handoff(writer);
				descriptors.push(descriptor);
				if (failSource) throw new Error("source failure after the handoff");
				const result = await ctx.result(writer);
				return {
					commit: descriptor?.handoffCommit ?? "none",
					answer: result.answer,
				};
			},
		});
		const outcomes = new Map<string, WorktreeOutcome>([
			["writer", { output: { answer: "first" } }],
		]);
		const scheduler = worktreeSchedulerFor(journal, artifacts, outcomes);
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		await expect(runtime.drive()).rejects.toMatchObject({
			stage: "execution",
			message: "Static workflow source execution failed.",
		});
		let state = await journal.readState();
		expect(state.status).toBe("failed");
		const taskId = writerTaskId(state);
		const gen1 = deriveTaskExecutionId(journal.runId, taskId, 1);
		const gen2 = deriveTaskExecutionId(journal.runId, taskId, 2);
		expect(state.tasks[taskId]).toMatchObject({
			status: "completed",
			currentExecutionId: gen1,
		});
		const [firstHandoff] = handoffArtifactsOf(state, taskId);
		if (!firstHandoff) throw new Error("missing generation-1 handoff");
		expect(descriptors).toEqual([
			expect.objectContaining({
				artifactId: firstHandoff.id,
				producerExecutionId: gen1,
				handoffCommit: handoffCommitFor(1),
			}),
		]);

		// Explicit invalidation re-executes the writer as generation 2 with a
		// fresh preflight, subagent run, worktree, and handoff.
		const closure = invalidationClosure(state, taskId);
		expect(closure).toEqual({ taskIds: [taskId], abandonedEpochs: [] });
		await journal.append("task-invalidated", {
			causeTaskId: taskId,
			taskIds: [...closure.taskIds],
			abandonedEpochs: [...closure.abandonedEpochs],
			reason: "Re-execute the writer.",
		});
		failSource = false;
		outcomes.set("writer", { output: { answer: "second" } });
		await expect(runtime.drive()).resolves.toMatchObject({
			status: "completed",
			value: { commit: handoffCommitFor(2), answer: "second" },
		});
		expect(scheduler.calls).toBe(2);

		state = await journal.readState();
		expect(state.tasks[taskId]).toMatchObject({
			status: "completed",
			currentExecutionId: gen2,
		});
		expect(state.executions[gen2]?.execution.generation).toBe(2);
		expect(state.executions[gen1]?.preflight?.workspaceBaselineSha256).not.toBe(
			state.executions[gen2]?.preflight?.workspaceBaselineSha256,
		);
		const handoffs = handoffArtifactsOf(state, taskId);
		expect(handoffs).toHaveLength(2);
		const secondHandoff = handoffs.find(
			(artifact) => artifact.producerExecutionId === gen2,
		);
		if (!secondHandoff) throw new Error("missing generation-2 handoff");
		// The generation-1 artifact is retained history with its own producer.
		expect(state.artifacts[firstHandoff.id]).toEqual(firstHandoff);
		expect(state.executions[gen1]?.handoffImport?.artifactId).toBe(
			firstHandoff.id,
		);
		expect(state.executions[gen2]?.handoffImport?.artifactId).toBe(
			secondHandoff.id,
		);
		expect(secondHandoff.sha256).not.toBe(firstHandoff.sha256);
		expect(descriptors).toHaveLength(2);
		expect(descriptors[1]).toEqual(
			expect.objectContaining({
				artifactId: secondHandoff.id,
				producerExecutionId: gen2,
				subagentRunId: "run_writerg2",
				subagentAttemptId: "attempt_writerg2",
				handoffCommit: handoffCommitFor(2),
				sha256: secondHandoff.sha256,
			}),
		);
		// Replay still selects the current generation without driving.
		await expect(runtime.drive()).resolves.toMatchObject({
			value: { commit: handoffCommitFor(2), answer: "second" },
		});
		expect(scheduler.calls).toBe(2);
	});
});

// --- Revision 18 checkpoints (spec 2.8, C2, C3) ---------------------------------

const CHECKPOINT_AWAITS_REASON = "Checkpoint awaits a decision.";
const CHECKPOINT_DECIDED_REASON = "Checkpoint decided.";
const RUN_AWAITS_REASON = "Workflow run awaits a checkpoint decision.";
const RUN_ENDING_REASON =
	"Workflow run ended before the checkpoint was decided.";
const PARK_MESSAGE = "Workflow run is parked at a checkpoint.";
const decisionSchema = Type.Object({ proceed: Type.Boolean() });

function checkpointRequest(overrides: { timeoutMs?: number } = {}) {
	return {
		schema: decisionSchema,
		prompt: "Proceed with the plan?",
		headless: "block" as const,
		...overrides,
	};
}

function checkpointMeta(name: string) {
	return {
		name,
		description: "Checkpoint",
		version: 1,
		budget: { cost: 1000, childRuntimeMs: 3600000 },
		timeoutMs: 3600000,
	};
}

/**
 * A fake scheduler that starts the run and blocks its single required agent
 * task the way the real scheduler does for a failed dependency, without ending
 * the run itself: the runtime's final-graph backstop must fail it durably.
 */
function blockingScheduler(
	journal: WorkflowRunJournal,
): WorkflowSequentialScheduler & { calls: number } {
	const scheduler: WorkflowSequentialScheduler & { calls: number } = {
		concurrency: 1,
		stopSignal: new AbortController().signal,
		calls: 0,
		async drive(): Promise<WorkflowSchedulerOutcome> {
			scheduler.calls += 1;
			let current = await journal.readState();
			if (current.status === "created") {
				await journal.append("run-status-changed", {
					from: "created",
					to: "running",
				});
				current = await journal.readState();
			}
			const work = Object.values(current.tasks).find(
				(task) => task.task.spec.kind === "agent",
			);
			if (!work) throw new Error("task not declared");
			if (work.status === "pending") {
				await journal.append("task-status-changed", {
					taskId: work.task.id,
					from: "pending",
					to: "blocked",
					reason: "A workflow task dependency did not complete successfully.",
				});
			}
			return { state: "idle", runStatus: "running" };
		},
		async reconcile() {
			throw new Error("fake workflow has no cleanup-blocked task");
		},
		async decide() {
			throw new Error("fake scheduler records no decisions");
		},
		async stop() {
			return { state: "terminal", runStatus: "cancelled" } as const;
		},
	};
	return scheduler;
}

interface CheckpointFakeOptions {
	/** Decisions by checkpoint key; a missing key leaves the checkpoint parked. */
	readonly decisions?: Map<string, unknown>;
	/** Thrown right after the request ladder, leaving the checkpoint open. */
	readonly throwAfterRequest?: Error;
}

/**
 * A fake scheduler that requests checkpoints (spec 2.7 request ladder), parks
 * with `awaiting-decision`, decides them from `decisions` on a later drive
 * (spec 2.7 decide ladder), and delegates agent tasks to `schedulerFor`.
 */
function checkpointSchedulerFor(
	journal: WorkflowRunJournal,
	artifacts: WorkflowArtifactStore,
	outputs: ReadonlyMap<string, unknown>,
	options: CheckpointFakeOptions = {},
): WorkflowSequentialScheduler & {
	calls: number;
	readonly decisions: Map<string, unknown>;
} {
	const inner = schedulerFor(journal, artifacts, outputs);
	const decisions = options.decisions ?? new Map<string, unknown>();
	const scheduler = {
		concurrency: 1,
		stopSignal: new AbortController().signal,
		calls: 0,
		decisions,
		async drive(): Promise<WorkflowSchedulerOutcome> {
			scheduler.calls += 1;
			let current = await journal.readState();
			if (current.status === "created" || current.status === "waiting") {
				await journal.append("run-status-changed", {
					from: current.status,
					to: "running",
				});
				current = await journal.readState();
			}
			const task = Object.values(current.tasks)
				.filter((candidate) => candidate.committed)
				.sort(
					(left, right) =>
						left.task.materializationSequence -
						right.task.materializationSequence,
				)
				.find((candidate) => candidate.status !== "completed");
			if (!task) return { state: "idle", runStatus: current.status };
			const spec = task.task.spec;
			if (spec.kind !== "checkpoint") return inner.drive();
			const taskId = task.task.id;
			const executionId = deriveTaskExecutionId(current.runId, taskId, 1);
			if (task.status === "pending") {
				await journal.append("task-status-changed", {
					taskId,
					from: "pending",
					to: "ready",
				});
			}
			if (task.status === "pending" || task.status === "ready") {
				if (!current.executions[executionId]) {
					await journal.append("task-execution-created", {
						execution: {
							kind: "checkpoint",
							id: executionId,
							runId: current.runId,
							taskId,
							generation: 1,
							taskIdentitySha256: spec.identitySha256,
						},
					});
				}
				const inputs: Record<string, string> = {};
				for (const [name, input] of Object.entries(spec.inputs)) {
					const artifact = Object.values(current.artifacts).find(
						(candidate) =>
							candidate.producerTaskId === input.producerTaskId &&
							candidate.output === input.output,
					);
					if (!artifact) throw new Error("missing checkpoint input artifact");
					inputs[name] = artifact.sha256;
				}
				const timeoutMs = spec.request.timeoutMs;
				await journal.append("task-execution-checkpoint-requested", {
					executionId,
					inputsSha256: deriveJsonValueSha256(inputs),
					...(timeoutMs === undefined
						? {}
						: { expiresAt: new Date(Date.now() + timeoutMs).toISOString() }),
				});
				await journal.append("task-status-changed", {
					taskId,
					from: "ready",
					to: "waiting",
					reason: CHECKPOINT_AWAITS_REASON,
				});
				if (options.throwAfterRequest) throw options.throwAfterRequest;
				current = await journal.readState();
			}
			const decision = decisions.get(spec.key);
			if (decision === undefined) {
				if (current.status === "running") {
					await journal.append("run-status-changed", {
						from: "running",
						to: "waiting",
						reason: RUN_AWAITS_REASON,
					});
				}
				const expiresAt =
					current.executions[executionId]?.checkpointRequest?.expiresAt;
				return {
					state: "awaiting-decision",
					runStatus: "waiting",
					pendingCheckpoints: [
						{
							taskId,
							executionId,
							...(expiresAt === undefined ? {} : { expiresAt }),
						},
					],
				};
			}
			const artifact = await artifacts.putJson(decision, {
				runId: current.runId,
				producerTaskId: taskId,
				producerExecutionId: executionId,
				output: "result",
				schemaSha256: deriveJsonValueSha256(spec.request.schema),
			});
			if (!current.artifacts[artifact.id]) {
				await journal.append("artifact-declared", { artifact });
			}
			await journal.append("task-execution-checkpoint-decided", {
				executionId,
				artifactId: artifact.id,
				decisionSha256: artifact.sha256,
				source: "operator",
				decidedAt: new Date().toISOString(),
				decidedBy: "tester",
			});
			await journal.append("task-execution-terminal", {
				executionId,
				outcome: "completed",
				evidence: {
					kind: "checkpoint",
					artifactId: artifact.id,
					decisionSha256: artifact.sha256,
					source: "operator",
					decidedBy: "tester",
				},
			});
			await journal.append("task-status-changed", {
				taskId,
				from: "waiting",
				to: "completed",
				reason: CHECKPOINT_DECIDED_REASON,
			});
			scheduler.calls -= 1;
			return scheduler.drive();
		},
		async reconcile() {
			throw new Error("fake workflow has no cleanup-blocked task");
		},
		async decide() {
			throw new Error("fake scheduler records no decisions");
		},
		async stop() {
			return { state: "terminal", runStatus: "cancelled" } as const;
		},
	};
	return scheduler;
}

function runStatusChanges(
	events: readonly { readonly type: string; readonly data: unknown }[],
): readonly { from: string; to: string; reason?: string }[] {
	return events
		.filter((event) => event.type === "run-status-changed")
		.map(
			(event) => event.data as { from: string; to: string; reason?: string },
		);
}

describe("static workflow runtime checkpoints", () => {
	it("parks at a result barrier with the pending checkpoint and no failure", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: checkpointMeta("park-result"),
			inputSchema: Type.Object({}),
			outputSchema: decisionSchema,
			async run(ctx) {
				const approve = ctx.checkpoint(
					"approve",
					checkpointRequest({ timeoutMs: 60_000 }),
				);
				const decision = await ctx.result(approve);
				return { proceed: decision.proceed };
			},
		});
		const scheduler = checkpointSchedulerFor(journal, artifacts, new Map());
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		const result = await runtime.drive();
		expect(isStaticWorkflowParked(result)).toBe(true);
		const events = await journal.readEvents();
		const state = reduceWorkflowEvents(events);
		const [task] = Object.values(state.tasks);
		if (!task) throw new Error("checkpoint task not declared");
		const executionId = deriveTaskExecutionId(journal.runId, task.task.id, 1);
		const expiresAt =
			state.executions[executionId]?.checkpointRequest?.expiresAt;
		expect(typeof expiresAt).toBe("string");
		expect(result).toEqual({
			runId: journal.runId,
			status: "waiting",
			parked: true,
			pendingCheckpoints: [{ taskId: task.task.id, executionId, expiresAt }],
		});
		expect(task.task.spec).toMatchObject({
			kind: "checkpoint",
			request: {
				prompt: "Proceed with the plan?",
				headless: "block",
				timeoutMs: 60_000,
			},
		});
		expect(task.status).toBe("waiting");
		expect(state.status).toBe("waiting");
		expect(state.barriers.map((barrier) => barrier.kind)).toEqual(["result"]);
		expect(runStatusChanges(events)).toEqual([
			{ from: "created", to: "running" },
			{ from: "running", to: "waiting", reason: RUN_AWAITS_REASON },
		]);
		expect(events.at(-1)?.type).toBe("run-status-changed");
		expect(scheduler.calls).toBe(1);
	});

	it("re-drives after a decision, replays the decision through its artifact, and validates it against the request schema", async () => {
		const { journal, artifacts } = await fixture();
		let sourceRuns = 0;
		const definition = defineWorkflow({
			meta: checkpointMeta("re-drive"),
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			async run(ctx) {
				sourceRuns += 1;
				const approve = ctx.checkpoint("approve", checkpointRequest());
				const decision = await ctx.result(approve);
				if (!decision.proceed) return { answer: "stopped" };
				return ctx.agent("write", {
					...request("Write"),
					after: [approve.ref],
				});
			},
		});
		const scheduler = checkpointSchedulerFor(
			journal,
			artifacts,
			new Map([["write", { answer: "written" }]]),
		);
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		const parked = await runtime.drive();
		expect(isStaticWorkflowParked(parked)).toBe(true);
		expect(scheduler.calls).toBe(1);
		const parkedState = await journal.readState();
		expect(Object.values(parkedState.tasks).map((task) => task.status)).toEqual(
			["waiting"],
		);

		scheduler.decisions.set("approve", { proceed: true });
		const finished = await runtime.drive();
		expect(isStaticWorkflowParked(finished)).toBe(false);
		expect(finished).toMatchObject({
			status: "completed",
			value: { answer: "written" },
		});
		expect(sourceRuns).toBe(2);
		const events = await journal.readEvents();
		const state = reduceWorkflowEvents(events);
		expect(state.status).toBe("completed");
		const tasks = Object.values(state.tasks);
		expect(tasks.map((task) => [task.task.spec.kind, task.status])).toEqual([
			["checkpoint", "completed"],
			["agent", "completed"],
		]);
		expect(tasks[0]?.task.id).toBe(Object.keys(parkedState.tasks)[0]);
		expect(runStatusChanges(events).map((change) => change.to)).toEqual([
			"running",
			"waiting",
			"running",
			"finalizing",
			"completed",
		]);
		expect(
			events
				.filter((event) => event.type === "task-status-changed")
				.map((event) => (event.data as { to: string; reason?: string }).reason),
		).toContain(CHECKPOINT_DECIDED_REASON);
		// The decided checkpoint replays from its artifact; the writer replays too.
		const callsBeforeReplay = scheduler.calls;
		await expect(runtime.drive()).resolves.toMatchObject({
			value: { answer: "written" },
		});
		expect(scheduler.calls).toBe(callsBeforeReplay);
		expect(sourceRuns).toBe(3);
	});

	it("rejects a replayed decision that no longer matches the request schema", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: checkpointMeta("schema"),
			inputSchema: Type.Object({}),
			outputSchema: decisionSchema,
			async run(ctx) {
				const approve = ctx.checkpoint("approve", checkpointRequest());
				return { proceed: (await ctx.result(approve)).proceed };
			},
		});
		const scheduler = checkpointSchedulerFor(journal, artifacts, new Map(), {
			decisions: new Map([["approve", { proceed: "yes" }]]),
		});
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		const error: unknown = await runtime.drive().catch((cause) => cause);
		expect(error).toMatchObject({
			stage: "execution",
			message: "Static workflow source execution failed.",
		});
		expect((error as Error).cause).toMatchObject({
			stage: "result",
			message: "Workflow task artifact no longer matches its output schema.",
		});
		const state = await journal.readState();
		expect(state.status).toBe("failed");
		expect(Object.values(state.tasks)[0]?.status).toBe("completed");
	});

	it("keeps the run parked when trusted source swallows the park signal", async () => {
		const { journal, artifacts } = await fixture();
		const observed: { name: string; message: string }[] = [];
		const definition = defineWorkflow({
			meta: checkpointMeta("swallow"),
			inputSchema: Type.Object({}),
			outputSchema: decisionSchema,
			async run(ctx) {
				const approve = ctx.checkpoint("approve", checkpointRequest());
				try {
					await ctx.result(approve);
				} catch (error) {
					const failure = error as Error;
					observed.push({ name: failure.name, message: failure.message });
				}
				const other = ctx.agent("other", request("Other"));
				try {
					await ctx.result(other);
				} catch (error) {
					const failure = error as Error;
					observed.push({ name: failure.name, message: failure.message });
				}
				ctx.log("Source continued past the park.");
				return { proceed: false };
			},
		});
		const scheduler = checkpointSchedulerFor(
			journal,
			artifacts,
			new Map([["other", { answer: "never" }]]),
		);
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		const result = await runtime.drive();
		expect(isStaticWorkflowParked(result)).toBe(true);
		expect(observed).toEqual([
			{ name: "StaticWorkflowParkSignal", message: PARK_MESSAGE },
			{ name: "StaticWorkflowParkSignal", message: PARK_MESSAGE },
		]);
		expect(scheduler.calls).toBe(1);
		const events = await journal.readEvents();
		const state = reduceWorkflowEvents(events);
		expect(state.status).toBe("waiting");
		expect(state.barriers.map((barrier) => barrier.kind)).toEqual(["result"]);
		expect(runStatusChanges(events).map((change) => change.to)).toEqual([
			"running",
			"waiting",
		]);
		expect(state.outputArtifactId).toBeUndefined();
	});

	it("parks at a settled barrier", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: checkpointMeta("park-settled"),
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ status: Type.String() }),
			async run(ctx) {
				const approve = ctx.checkpoint("approve", {
					...checkpointRequest(),
					disposition: "optional",
				});
				const [outcome] = await ctx.settled([approve] as const);
				return { status: outcome.status };
			},
		});
		const scheduler = checkpointSchedulerFor(journal, artifacts, new Map());
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		const parked = await runtime.drive();
		expect(parked).toMatchObject({ parked: true, status: "waiting" });
		expect(
			isStaticWorkflowParked(parked) && parked.pendingCheckpoints,
		).toHaveLength(1);
		const state = await journal.readState();
		expect(state.status).toBe("waiting");
		expect(state.barriers.map((barrier) => barrier.kind)).toEqual(["settled"]);

		scheduler.decisions.set("approve", { proceed: false });
		await expect(runtime.drive()).resolves.toMatchObject({
			status: "completed",
			value: { status: "fulfilled" },
		});
	});

	it("parks while settling the final graph and completes once decided", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: checkpointMeta("park-final"),
			inputSchema: Type.Object({}),
			outputSchema: decisionSchema,
			run(ctx) {
				return ctx.checkpoint("approve", checkpointRequest());
			},
		});
		const scheduler = checkpointSchedulerFor(journal, artifacts, new Map());
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		const parked = await runtime.drive();
		expect(isStaticWorkflowParked(parked)).toBe(true);
		let state = await journal.readState();
		expect(state.status).toBe("waiting");
		expect(state.barriers.map((barrier) => barrier.kind)).toEqual(["final"]);
		expect(state.outputArtifactId).toBeUndefined();

		scheduler.decisions.set("approve", { proceed: true });
		const finished = await runtime.drive();
		expect(finished).toMatchObject({
			status: "completed",
			value: { proceed: true },
		});
		state = await journal.readState();
		expect(state.status).toBe("completed");
		expect(await artifacts.readJson(completed(finished).artifact)).toEqual({
			proceed: true,
		});
	});

	it("cancels an open checkpoint before persisting source failure", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: checkpointMeta("fail-open"),
			inputSchema: Type.Object({}),
			outputSchema: decisionSchema,
			async run(ctx) {
				const approve = ctx.checkpoint("approve", checkpointRequest());
				return { proceed: (await ctx.result(approve)).proceed };
			},
		});
		const scheduler = checkpointSchedulerFor(journal, artifacts, new Map(), {
			throwAfterRequest: new Error("scheduler lane failed"),
		});
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		await expect(runtime.drive()).rejects.toMatchObject({
			stage: "execution",
			message: "Static workflow source execution failed.",
		});
		const events = await journal.readEvents();
		const state = reduceWorkflowEvents(events);
		expect(state.status).toBe("failed");
		const [task] = Object.values(state.tasks);
		if (!task) throw new Error("checkpoint task not declared");
		expect(task.status).toBe("cancelled");
		const executionId = deriveTaskExecutionId(journal.runId, task.task.id, 1);
		expect(state.executions[executionId]?.terminal).toMatchObject({
			outcome: "cancelled",
			evidence: {
				kind: "workflow",
				stage: "stop",
				message: RUN_ENDING_REASON,
				failureSha256: deriveWorkflowFailureSha256("stop", RUN_ENDING_REASON),
			},
		});
		const types = events.map((event) => event.type);
		const cancelledAt = events.findIndex(
			(event) =>
				event.type === "task-status-changed" &&
				(event.data as { to: string }).to === "cancelled",
		);
		const failedAt = events.findIndex(
			(event) =>
				event.type === "run-status-changed" &&
				(event.data as { to: string }).to === "failed",
		);
		expect(cancelledAt).toBeGreaterThan(-1);
		expect(failedAt).toBeGreaterThan(cancelledAt);
		expect(types.indexOf("task-execution-terminal")).toBeLessThan(cancelledAt);
		expect(
			events[cancelledAt]?.data as { from: string; reason?: string },
		).toMatchObject({ from: "waiting", reason: RUN_ENDING_REASON });
		expect(runStatusChanges(events).map((change) => change.to)).toEqual([
			"running",
			"failed",
		]);
	});

	it("fails the run durably when a required task cannot complete in the final graph, cancelling an open checkpoint first", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: checkpointMeta("final-graph-failure"),
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			run(ctx) {
				ctx.checkpoint("approve", checkpointRequest());
				return ctx.agent("work", request());
			},
		});
		// Requests the checkpoint (leaving it open), then blocks the required
		// agent task the way the real scheduler does for a failed dependency,
		// without ending the run itself: the runtime must fail it durably.
		const scheduler: WorkflowSequentialScheduler & { calls: number } = {
			concurrency: 1,
			stopSignal: new AbortController().signal,
			calls: 0,
			async drive(): Promise<WorkflowSchedulerOutcome> {
				scheduler.calls += 1;
				let current = await journal.readState();
				if (current.status === "created" || current.status === "waiting") {
					await journal.append("run-status-changed", {
						from: current.status,
						to: "running",
					});
					current = await journal.readState();
				}
				const tasks = Object.values(current.tasks);
				const approve = tasks.find(
					(task) => task.task.spec.kind === "checkpoint",
				);
				const work = tasks.find((task) => task.task.spec.kind === "agent");
				if (!approve || !work) throw new Error("tasks not declared");
				if (approve.status === "pending") {
					const executionId = deriveTaskExecutionId(
						current.runId,
						approve.task.id,
						1,
					);
					await journal.append("task-status-changed", {
						taskId: approve.task.id,
						from: "pending",
						to: "ready",
					});
					await journal.append("task-execution-created", {
						execution: {
							kind: "checkpoint",
							id: executionId,
							runId: current.runId,
							taskId: approve.task.id,
							generation: 1,
							taskIdentitySha256: approve.task.spec.identitySha256,
						},
					});
					await journal.append("task-execution-checkpoint-requested", {
						executionId,
						inputsSha256: deriveJsonValueSha256({}),
					});
					await journal.append("task-status-changed", {
						taskId: approve.task.id,
						from: "ready",
						to: "waiting",
						reason: CHECKPOINT_AWAITS_REASON,
					});
				}
				if (work.status === "pending") {
					await journal.append("task-status-changed", {
						taskId: work.task.id,
						from: "pending",
						to: "blocked",
						reason: "A workflow task dependency did not complete successfully.",
					});
				}
				return { state: "idle", runStatus: "running" };
			},
			async reconcile() {
				throw new Error("fake workflow has no cleanup-blocked task");
			},
			async decide() {
				throw new Error("fake scheduler records no decisions");
			},
			async stop() {
				return { state: "terminal", runStatus: "cancelled" } as const;
			},
		};
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		const message = "Required workflow task did not complete: blocked.";
		await expect(runtime.drive()).rejects.toMatchObject({
			stage: "execution",
			message,
		});
		expect(scheduler.calls).toBe(1);
		const events = await journal.readEvents();
		const state = reduceWorkflowEvents(events);
		expect(state.status).toBe("failed");
		const approve = Object.values(state.tasks).find(
			(task) => task.task.spec.kind === "checkpoint",
		);
		if (!approve) throw new Error("checkpoint task not declared");
		expect(approve.status).toBe("cancelled");
		const executionId = deriveTaskExecutionId(
			journal.runId,
			approve.task.id,
			1,
		);
		expect(state.executions[executionId]?.terminal).toMatchObject({
			outcome: "cancelled",
			evidence: {
				kind: "workflow",
				stage: "stop",
				message: RUN_ENDING_REASON,
				failureSha256: deriveWorkflowFailureSha256("stop", RUN_ENDING_REASON),
			},
		});
		const cancelledAt = events.findIndex(
			(event) =>
				event.type === "task-status-changed" &&
				(event.data as { to: string }).to === "cancelled",
		);
		const failedAt = events.findIndex(
			(event) =>
				event.type === "run-status-changed" &&
				(event.data as { to: string }).to === "failed",
		);
		expect(cancelledAt).toBeGreaterThan(-1);
		expect(failedAt).toBeGreaterThan(cancelledAt);
		expect(failedAt).toBe(events.length - 1);
		expect(runStatusChanges(events)).toEqual([
			{ from: "created", to: "running" },
			{ from: "running", to: "failed", reason: message },
		]);
	});

	it("lets the original error propagate when a concurrent lane fails the run between the backstop's read and append", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: checkpointMeta("final-graph-race"),
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			run(ctx) {
				return ctx.agent("work", request());
			},
		});
		const concurrentReason = "A concurrently driving lane failed the run.";
		// The fake scheduler blocks the required task without ending the run;
		// the journal handed to the runtime flips the run to `failed` on behalf
		// of another lane right before the runtime's own `-> failed` lands.
		const scheduler = blockingScheduler(journal);
		let flipped = 0;
		const racing = new Proxy(journal, {
			get(target, property, receiver) {
				if (property !== "append") {
					return Reflect.get(target, property, receiver);
				}
				return async (type: string, data: Record<string, unknown>) => {
					if (
						type === "run-status-changed" &&
						data.to === "failed" &&
						flipped === 0
					) {
						flipped += 1;
						await target.append("run-status-changed", {
							from: "running",
							to: "failed",
							reason: concurrentReason,
						});
					}
					return target.append(type as never, data as never);
				};
			},
		});
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal: racing,
			artifacts,
			scheduler,
		});
		await expect(runtime.drive()).rejects.toMatchObject({
			stage: "execution",
			message: "Required workflow task did not complete: blocked.",
		});
		expect(flipped).toBe(1);
		const events = await journal.readEvents();
		expect(reduceWorkflowEvents(events).status).toBe("failed");
		expect(runStatusChanges(events)).toEqual([
			{ from: "created", to: "running" },
			{ from: "running", to: "failed", reason: concurrentReason },
		]);
	});

	it("propagates a rejected backstop append while the run is still failable", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: checkpointMeta("final-graph-stale-source"),
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			run(ctx) {
				return ctx.agent("work", request());
			},
		});
		const scheduler = blockingScheduler(journal);
		// A stale `from` is rejected while the run keeps running: nothing ended
		// the run, so the rejection itself must surface rather than be hidden.
		const stale = new Proxy(journal, {
			get(target, property, receiver) {
				if (property !== "append") {
					return Reflect.get(target, property, receiver);
				}
				return async (type: string, data: Record<string, unknown>) =>
					target.append(
						type as never,
						(type === "run-status-changed" && data.to === "failed"
							? { ...data, from: "created" }
							: data) as never,
					);
			},
		});
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal: stale,
			artifacts,
			scheduler,
		});
		await expect(runtime.drive()).rejects.toThrow(
			"workflow journal event violates run invariants",
		);
		const events = await journal.readEvents();
		expect(reduceWorkflowEvents(events).status).toBe("running");
		expect(runStatusChanges(events)).toEqual([
			{ from: "created", to: "running" },
		]);
	});

	it("rejects a non-object checkpoint request with the fixed message", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: checkpointMeta("invalid-request"),
			inputSchema: Type.Object({}),
			outputSchema: decisionSchema,
			async run(ctx) {
				const approve = ctx.checkpoint(
					"approve",
					null as unknown as ReturnType<typeof checkpointRequest>,
				);
				return { proceed: (await ctx.result(approve)).proceed };
			},
		});
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler: checkpointSchedulerFor(journal, artifacts, new Map()),
		});
		const error: unknown = await runtime.drive().catch((cause) => cause);
		expect(error).toBeInstanceOf(StaticWorkflowRuntimeError);
		expect((error as Error).cause).toMatchObject({
			stage: "validation",
			message: "Workflow checkpoint request is invalid.",
		});
		expect((await journal.readState()).status).toBe("failed");
	});

	it("runs a gated task only after the checkpoint is decided", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: checkpointMeta("gated"),
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			async run(ctx) {
				const approve = ctx.checkpoint("approve", checkpointRequest());
				const writer = ctx.agent("write", {
					...request("Write"),
					after: [approve.ref],
				});
				await ctx.result(approve);
				return writer;
			},
		});
		const scheduler = checkpointSchedulerFor(
			journal,
			artifacts,
			new Map([["write", { answer: "written" }]]),
		);
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler,
		});
		const parked = await runtime.drive();
		expect(isStaticWorkflowParked(parked)).toBe(true);
		let state = await journal.readState();
		expect(Object.values(state.tasks).map((task) => task.status)).toEqual([
			"waiting",
			"pending",
		]);
		scheduler.decisions.set("approve", { proceed: true });
		await expect(runtime.drive()).resolves.toMatchObject({
			status: "completed",
			value: { answer: "written" },
		});
		state = await journal.readState();
		expect(Object.values(state.tasks).map((task) => task.status)).toEqual([
			"completed",
			"completed",
		]);
	});
});

/** Reads the symbol-keyed bridge the way the dynamic definition does. */
function bridgeOf(
	ctx: WorkflowContext<unknown>,
): WorkflowHostBridge | undefined {
	return (ctx as unknown as Record<symbol, WorkflowHostBridge | undefined>)[
		workflowHostBridge
	];
}

describe("static workflow runtime host bridge", () => {
	it("exposes agentInNamespace only through the non-enumerable symbol key", async () => {
		const { journal, artifacts } = await fixture();
		const observed: Record<string, unknown> = {};
		const definition = defineWorkflow({
			meta: {
				name: "bridge",
				description: "Bridge",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			async run(ctx) {
				const bridge = bridgeOf(ctx);
				if (!bridge) throw new Error("bridge missing");
				observed.frozenContext = Object.isFrozen(ctx);
				observed.frozenBridge = Object.isFrozen(bridge);
				observed.keys = Object.keys(ctx);
				observed.json = JSON.stringify(ctx);
				observed.spread = Object.getOwnPropertySymbols({ ...ctx });
				observed.symbols = Object.getOwnPropertySymbols(ctx);
				observed.descriptor = Object.getOwnPropertyDescriptor(
					ctx,
					workflowHostBridge,
				);
				observed.bridgeKeys = Object.keys(bridge);
				const handle = bridge.agentInNamespace(
					["batch"],
					"item",
					request("Item"),
				);
				observed.handleRegistered = handle.ref.runId === ctx.runId;
				const value = (await ctx.result(handle)) as { answer: string };
				return { answer: value.answer };
			},
		});
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler: schedulerFor(
				journal,
				artifacts,
				new Map([["item", { answer: "bridged" }]]),
			),
		});
		await expect(runtime.drive()).resolves.toMatchObject({
			value: { answer: "bridged" },
		});
		expect(observed.frozenContext).toBe(true);
		expect(observed.frozenBridge).toBe(true);
		expect(observed.keys).not.toContain("agentInNamespace");
		expect(observed.json).not.toContain("agentInNamespace");
		expect(observed.spread).toEqual([]);
		expect(observed.symbols).toEqual([workflowHostBridge]);
		expect(observed.descriptor).toMatchObject({
			enumerable: false,
			writable: false,
			configurable: false,
		});
		expect(observed.bridgeKeys).toEqual(["agentInNamespace"]);
		expect(observed.handleRegistered).toBe(true);
		expect(workflowHostBridge.description).toBe("pi-workflow-host-bridge");
		expect(Symbol.for("pi-workflow-host-bridge")).not.toBe(workflowHostBridge);

		// The bridge lowers exactly like `fanOut`: same namespace, same task identity.
		const bridged = Object.values((await journal.readState()).tasks).map(
			(task) => task.task,
		);
		const fanned = await fixture();
		const viaFanOut = createStaticWorkflowRuntime({
			definition: defineWorkflow({
				meta: definition.meta,
				inputSchema: Type.Object({}),
				outputSchema: Type.Object({ answer: Type.String() }),
				async run(ctx) {
					const [handle] = ctx.fanOut("batch", ["only"], {
						key: () => "item",
						task: () => request("Item"),
					});
					if (!handle) throw new Error("fan-out produced no handle");
					const value = (await ctx.result(handle)) as { answer: string };
					return { answer: value.answer };
				},
			}),
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal: fanned.journal,
			artifacts: fanned.artifacts,
			scheduler: schedulerFor(
				fanned.journal,
				fanned.artifacts,
				new Map([["item", { answer: "bridged" }]]),
			),
		});
		await expect(viaFanOut.drive()).resolves.toMatchObject({
			value: { answer: "bridged" },
		});
		const fannedTasks = Object.values(
			reduceWorkflowEvents(await fanned.journal.readEvents()).tasks,
		).map((task) => task.task);
		expect(bridged.map((task) => task.namespace)).toEqual([["batch"]]);
		expect(bridged).toEqual(fannedTasks);
	});

	it("recognises a real park signal and rejects lookalikes", async () => {
		const { journal, artifacts } = await fixture();
		const captured: unknown[] = [];
		const definition = defineWorkflow({
			meta: checkpointMeta("park-signal"),
			inputSchema: Type.Object({}),
			outputSchema: decisionSchema,
			async run(ctx) {
				const approve = ctx.checkpoint("approve", checkpointRequest());
				try {
					await ctx.result(approve);
				} catch (error) {
					captured.push(error);
					throw error;
				}
				return { proceed: true };
			},
		});
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256,
			input: {},
			cwd: "/repo",
			journal,
			artifacts,
			scheduler: checkpointSchedulerFor(journal, artifacts, new Map()),
		});
		const result = await runtime.drive();
		expect(isStaticWorkflowParked(result)).toBe(true);
		expect(captured).toHaveLength(1);
		expect(isStaticWorkflowParkSignal(captured[0])).toBe(true);
		expect(captured[0]).toMatchObject({
			name: "StaticWorkflowParkSignal",
			message: PARK_MESSAGE,
		});
		const lookalike = Object.assign(new Error(PARK_MESSAGE), {
			name: "StaticWorkflowParkSignal",
			pendingCheckpoints: [],
		});
		expect(isStaticWorkflowParkSignal(lookalike)).toBe(false);
		expect(isStaticWorkflowParkSignal({ ...(captured[0] as object) })).toBe(
			false,
		);
		expect(isStaticWorkflowParkSignal(new Error(PARK_MESSAGE))).toBe(false);
		expect(
			isStaticWorkflowParkSignal(
				new StaticWorkflowRuntimeError("execution", PARK_MESSAGE),
			),
		).toBe(false);
		expect(isStaticWorkflowParkSignal(PARK_MESSAGE)).toBe(false);
		expect(isStaticWorkflowParkSignal(undefined)).toBe(false);
		expect(isStaticWorkflowParkSignal(null)).toBe(false);
	});

	it("persists a dynamic execution error's exact reason and keeps the static reason otherwise", async () => {
		class DynamicWorkflowExecutionError extends Error {
			constructor(
				readonly stage: string,
				message: string,
			) {
				super(message);
				this.name = "DynamicWorkflowExecutionError";
			}
		}
		const reasons = [
			"Dynamic workflow VM exceeded its memory limit.",
			"Dynamic workflow source execution failed: TypeError: boom",
			"x".repeat(5000),
		];
		for (const reason of reasons) {
			const { journal, artifacts } = await fixture();
			const definition = defineWorkflow({
				meta: checkpointMeta("dynamic-failure"),
				inputSchema: Type.Object({}),
				outputSchema: decisionSchema,
				async run(ctx) {
					const approve = ctx.checkpoint("approve", checkpointRequest());
					// The bridge rethrows the VM failure from the awaited barrier.
					try {
						await ctx.result(approve);
					} catch {
						throw new DynamicWorkflowExecutionError("memory", reason);
					}
					return { proceed: true };
				},
			});
			const runtime = createStaticWorkflowRuntime({
				definition,
				definitionIdentitySha256,
				input: {},
				cwd: "/repo",
				journal,
				artifacts,
				scheduler: checkpointSchedulerFor(journal, artifacts, new Map(), {
					throwAfterRequest: new Error("scheduler lane failed"),
				}),
			});
			const expected = reason.slice(0, 4096);
			await expect(runtime.drive()).rejects.toMatchObject({
				name: "StaticWorkflowRuntimeError",
				stage: "execution",
				message: expected,
				cause: { name: "DynamicWorkflowExecutionError", stage: "memory" },
			});
			const events = await journal.readEvents();
			const state = reduceWorkflowEvents(events);
			expect(state.status).toBe("failed");
			expect(runStatusChanges(events).at(-1)).toMatchObject({
				to: "failed",
				reason: expected,
			});
			// The undecided checkpoint is cancelled before `-> failed`.
			const [task] = Object.values(state.tasks);
			expect(task?.status).toBe("cancelled");
			const cancelledAt = events.findIndex(
				(event) =>
					event.type === "task-status-changed" &&
					(event.data as { to: string }).to === "cancelled",
			);
			const failedAt = events.findIndex(
				(event) =>
					event.type === "run-status-changed" &&
					(event.data as { to: string }).to === "failed",
			);
			expect(cancelledAt).toBeGreaterThan(-1);
			expect(failedAt).toBeGreaterThan(cancelledAt);
		}

		// A dynamic-looking error without a message, a plain object, and every
		// other error keep the fixed static reason.
		for (const thrown of [
			Object.assign(new Error(""), { name: "DynamicWorkflowExecutionError" }),
			{ name: "DynamicWorkflowExecutionError", message: "plain object" },
			new Error("Dynamic workflow VM exceeded its memory limit."),
		]) {
			const { journal, artifacts } = await fixture();
			const definition = defineWorkflow({
				meta: {
					name: "static-failure",
					description: "Static failure",
					version: 1,
					budget: { cost: 1000, childRuntimeMs: 3600000 },
					timeoutMs: 3600000,
				},
				inputSchema: Type.Object({}),
				outputSchema: Type.Object({ answer: Type.String() }),
				run() {
					throw thrown;
				},
			});
			const runtime = createStaticWorkflowRuntime({
				definition,
				definitionIdentitySha256,
				input: {},
				cwd: "/repo",
				journal,
				artifacts,
				scheduler: schedulerFor(journal, artifacts, new Map()),
			});
			await expect(runtime.drive()).rejects.toMatchObject({
				stage: "execution",
				message: "Static workflow source execution failed.",
			});
			const events = await journal.readEvents();
			expect(runStatusChanges(events).at(-1)).toMatchObject({
				to: "failed",
				reason: "Static workflow source execution failed.",
			});
			expect(JSON.stringify(events)).not.toContain("plain object");
		}
	});
});
