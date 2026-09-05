import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RunResult } from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowArtifactStore } from "../src/artifact-store.js";
import { defineWorkflow } from "../src/definition.js";
import {
	deriveJsonValueSha256,
	deriveSubagentOperationId,
	deriveSubagentResultSha256,
	deriveTaskExecutionId,
} from "../src/execution.js";
import { WorkflowTaskMaterializer } from "../src/materializer.js";
import { WorkflowRunJournal } from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
	type WorkflowRunLease,
} from "../src/persistence/run-lease.js";
import { reduceWorkflowEvents } from "../src/reducer.js";
import type {
	WorkflowSchedulerOutcome,
	WorkflowSequentialScheduler,
} from "../src/scheduler.js";
import {
	createStaticWorkflowRuntime,
	StaticWorkflowRuntimeError,
} from "../src/static-runtime.js";

const definitionIdentitySha256 = "a".repeat(64);
const planIdentitySha256 = "b".repeat(64);
const leases = new Set<WorkflowRunLease>();

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
			runtimeMs: 300_000,
			attemptRuntimeMs: 300_000,
			tokens: 1_000_000,
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
		calls: 0,
		async drive(): Promise<WorkflowSchedulerOutcome> {
			scheduler.calls += 1;
			let current = reduceWorkflowEvents(await journal.readEvents());
			if (current.status === "created" || current.status === "waiting") {
				await journal.append("run-status-changed", {
					from: current.status,
					to: "running",
				});
				current = reduceWorkflowEvents(await journal.readEvents());
			}
			const task = Object.values(current.tasks)
				.sort(
					(left, right) =>
						left.task.materializationSequence -
						right.task.materializationSequence,
				)
				.find((candidate) => candidate.status !== "completed");
			if (!task) return { state: "idle", runStatus: current.status };
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

describe("static workflow runtime", () => {
	it("commits and replays a concrete workflow output", async () => {
		const { journal, artifacts } = await fixture();
		let calls = 0;
		const definition = defineWorkflow({
			meta: { name: "concrete", description: "Concrete", version: 1 },
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
		const first = await runtime.drive();
		const replay = await runtime.drive();
		expect(first).toMatchObject({
			status: "completed",
			value: { answer: "yes" },
		});
		expect(replay).toEqual(first);
		expect(calls).toBe(2);
		expect(scheduler.calls).toBe(0);
		expect(
			reduceWorkflowEvents(await journal.readEvents()).effects.map((effect) => [
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
			meta: { name: "branch", description: "Branch", version: 1 },
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
		const state = reduceWorkflowEvents(await journal.readEvents());
		expect(state.barriers.map((barrier) => barrier.kind)).toEqual([
			"result",
			"final",
		]);
		expect(Object.values(state.tasks).map((task) => task.status)).toEqual([
			"completed",
			"completed",
		]);
	}, 15_000);

	it("captures result barriers before later synchronous effects", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: { name: "ordering", description: "Ordering", version: 1 },
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
		const state = reduceWorkflowEvents(await journal.readEvents());
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
			meta: { name: "effects-only", description: "Effects only", version: 1 },
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
		expect(
			Object.values(reduceWorkflowEvents(await journal.readEvents()).tasks)[0]
				?.status,
		).toBe("completed");
	});

	it("rejects declaration drift on source re-execution", async () => {
		const { journal, artifacts } = await fixture();
		let goal = "Original";
		const definition = defineWorkflow({
			meta: { name: "drift", description: "Drift", version: 1 },
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
			meta: { name: "output", description: "Output", version: 1 },
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
			meta: { name: "effects", description: "Effects", version: 1 },
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
			meta: { name: "failure", description: "Failure", version: 1 },
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
			meta: { name: "repair", description: "Repair", version: 1 },
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
		expect(reduceWorkflowEvents(await journal.readEvents()).status).toBe(
			"completed",
		);
	});

	it("serializes concurrent source drives", async () => {
		const { journal, artifacts } = await fixture();
		const definition = defineWorkflow({
			meta: { name: "serial", description: "Serial", version: 1 },
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
