import { randomUUID } from "node:crypto";
import path from "node:path";
import {
	type AgentLaunchPlan,
	canonicalSha256,
	type RunResult,
	SUBAGENT_RUNTIME_CONTRACT,
	type SubagentClient,
	type SubagentPreflight,
	type SubagentRequest,
} from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowArtifactStore } from "../src/artifact-store.js";
import type { TaskRef } from "../src/contracts.js";
import type { TaskHandle } from "../src/definition.js";
import {
	deriveSubagentOperationId,
	deriveTaskExecutionId,
} from "../src/execution.js";
import { WorkflowTaskMaterializer } from "../src/materializer.js";
import { WorkflowRunJournal } from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
	type WorkflowRunLease,
	WorkflowRunLeaseFencedError,
} from "../src/persistence/run-lease.js";
import { reduceWorkflowEvents } from "../src/reducer.js";
import {
	createWorkflowSequentialScheduler,
	WorkflowSchedulerError,
} from "../src/scheduler.js";
import type { WorkflowSubagentBinding } from "../src/subagent-provider.js";
import { createWorkflowTaskFinalizer } from "../src/task-finalizer.js";

const definitionIdentitySha256 = "a".repeat(64);
const inputSha256 = "b".repeat(64);
const hash = "c".repeat(64);
const leases = new Set<WorkflowRunLease>();

type Deferred<T> = {
	promise: Promise<T>;
	resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

function request(
	overrides: {
		disposition?: "required" | "optional";
		after?: readonly TaskRef[];
	} = {},
) {
	return {
		...(overrides.disposition ? { disposition: overrides.disposition } : {}),
		...(overrides.after ? { after: overrides.after } : {}),
		agent: "researcher",
		task: {
			goal: "Answer the question",
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
			runtimeMs: 300_000,
			attemptRuntimeMs: 300_000,
			tokens: 1_000_000,
			cost: 100,
			outputBytes: 1_048_576,
			workspaceWriteBytes: 0,
			retries: 0,
			resumes: 0,
		},
	};
}

function launchPlan(
	requestValue: SubagentRequest,
	ownerId: string,
): AgentLaunchPlan {
	const draft = {
		schema: "pi-subagent-launch" as const,
		contractRevision: SUBAGENT_RUNTIME_CONTRACT.contractRevision,
		operationId: requestValue.operationId,
		ownerId,
		runId: "run_scheduler",
		attemptId: "attempt_scheduler",
		agent: requestValue.agent,
		agentDisplayName: "Researcher",
		agentPrompt: "Research the requested question.",
		agentSource: "/agents/researcher.md",
		agentSha256: hash,
		agentScope: "global" as const,
		task: structuredClone(requestValue.task),
		contextMode: requestValue.contextMode,
		model:
			requestValue.model ??
			({ provider: "test", id: "model", thinking: "low" } as const),
		cwd: "/workspace" as const,
		tools: [...requestValue.tools],
		preloadSkills: [...requestValue.preloadSkills],
		contextScopes: [...requestValue.contextScopes],
		resources: [
			{
				kind: "agent" as const,
				name: requestValue.agent,
				source: "/agents/researcher.md",
				sha256: hash,
			},
		],
		workspace: {
			mode: requestValue.workspace.mode,
			hostPathSha256: hash,
			baselineSha256: hash,
		},
		sandbox: {
			backend: "gondolin" as const,
			packageVersion: "0.12.0",
			imageSha256: hash,
			mountPolicySha256: hash,
			networkPolicySha256: hash,
			capacityPolicySha256: hash,
			memoryBytes: 512 * 1024 * 1024,
			guestDiskBytes: 1024,
			workspaceWriteBytes: requestValue.limits.workspaceWriteBytes,
		},
		network: {
			mode: "public-egress" as const,
			blockInternalRanges: true as const,
		},
		outputSchema: structuredClone(requestValue.outputSchema),
		limits: structuredClone(requestValue.limits),
	} satisfies Omit<AgentLaunchPlan, "identitySha256">;
	return { ...draft, identitySha256: canonicalSha256(draft) };
}

function preflight(requestValue: SubagentRequest): SubagentPreflight {
	const plan = launchPlan(requestValue, "pi-workflow:workflow_scheduler");
	return {
		preflightId: "preflight-scheduler",
		identitySha256: plan.identitySha256,
		expiresAt: "2099-01-01T00:00:00.000Z",
		launchPlan: plan,
	};
}

function result(status: "completed" | "failed" | "cancelled"): RunResult {
	const failure =
		status === "completed"
			? undefined
			: {
					code:
						status === "cancelled"
							? ("cancellation" as const)
							: ("tool" as const),
					origin:
						status === "cancelled" ? ("operator" as const) : ("tool" as const),
					retry: "never" as const,
					message: status === "cancelled" ? "cancelled" : "tool failed",
					guidance: "Inspect the result.",
				};
	return {
		runId: "run_scheduler",
		status,
		...(status === "completed" ? { structuredOutput: { answer: "yes" } } : {}),
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
		...(failure ? { failure } : {}),
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
	};
}

function executionResult(runResult: RunResult) {
	return {
		result: runResult,
		output: "not persisted by workflow scheduler",
		sessionFile: "/private/session.jsonl",
		handoff: undefined,
		structuredOutput: runResult.structuredOutput,
		error: undefined,
	};
}

function client(overrides: Partial<SubagentClient> = {}): SubagentClient {
	const unavailable = vi.fn(async () => {
		throw new Error("not implemented by test client");
	});
	return {
		preflight: vi.fn(async (input: SubagentRequest) => preflight(input)),
		launch: vi.fn(async () => ({
			runId: "run_scheduler",
			attemptId: "attempt_scheduler",
			status: "active" as const,
		})),
		findByOperation: vi.fn(async () => undefined),
		status: unavailable,
		listRuns: unavailable,
		logs: unavailable,
		wait: vi.fn(async () => executionResult(result("completed"))),
		interrupt: vi.fn(async () => ({
			runId: "run_scheduler",
			attemptId: "attempt_scheduler",
			status: "stopping" as const,
		})),
		steer: unavailable,
		followUp: unavailable,
		retry: unavailable,
		resume: unavailable,
		reconcile: unavailable,
		release: unavailable,
		abandon: unavailable,
		pin: unavailable,
		unpin: unavailable,
		exportArtifact: unavailable,
		...overrides,
	} as unknown as SubagentClient;
}

function binding(ownerClient: SubagentClient): WorkflowSubagentBinding {
	return {
		workflowRunId: "workflow_scheduler",
		ownerId: "pi-workflow:workflow_scheduler",
		client: ownerClient,
	};
}

async function fixture(
	configure: (
		materializer: WorkflowTaskMaterializer,
	) => readonly TaskHandle<unknown>[] = (materializer) => [
		materializer.agent("answer", request()),
	],
) {
	const root = path.resolve(".pi", "test-scheduler", `run-${randomUUID()}`);
	const lease = await acquireWorkflowRunLease({
		storeRoot: root,
		runId: "workflow_scheduler",
		ownerId: "scheduler-test",
	});
	leases.add(lease);
	const journal = await WorkflowRunJournal.open(
		root,
		"workflow_scheduler",
		lease,
	);
	await journal.append("run-created", {
		definitionIdentitySha256,
		inputSha256,
	});
	const materializer = new WorkflowTaskMaterializer({
		runId: "workflow_scheduler",
		definitionIdentitySha256,
		inputSha256,
	});
	const tasks = configure(materializer);
	for (const event of materializer.closeEpoch("final", tasks).events) {
		await journal.appendEvent(event);
	}
	return { root, lease, journal, tasks };
}

async function projection(journal: WorkflowRunJournal) {
	return reduceWorkflowEvents(await journal.readEvents());
}

afterEach(async () => {
	await Promise.all([...leases].map((lease) => lease.release()));
	leases.clear();
});

describe("durable sequential scheduler", () => {
	it("launches one ready task and persists bounded child settlement", async () => {
		const { journal, tasks } = await fixture();
		const ownerClient = client();
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(ownerClient),
		});

		await expect(scheduler.drive()).resolves.toMatchObject({
			state: "awaiting-finalization",
			outcome: "completed",
			child: { runId: "run_scheduler", status: "completed" },
		});
		const state = await projection(journal);
		const task = state.tasks[tasks[0]?.ref.taskId ?? ""];
		const execution = task?.currentExecutionId
			? state.executions[task.currentExecutionId]
			: undefined;
		expect(state.status).toBe("running");
		expect(task?.status).toBe("running");
		expect(execution).toMatchObject({
			phase: "settled",
			observation: { status: "completed" },
			settlement: {
				evidence: {
					kind: "subagent",
					status: "completed",
					structuredOutputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				},
			},
		});
		expect(JSON.stringify(execution)).not.toContain("not persisted");
		expect(JSON.stringify(execution)).not.toContain("session.jsonl");
		expect(ownerClient.preflight).toHaveBeenCalledOnce();
		expect(ownerClient.launch).toHaveBeenCalledOnce();
		expect(ownerClient.wait).toHaveBeenCalledOnce();
	});

	it("represents a queued child as waiting until settlement", async () => {
		const { journal, tasks } = await fixture();
		const waiting = deferred<ReturnType<typeof executionResult>>();
		const ownerClient = client({
			launch: vi.fn(async () => ({
				runId: "run_scheduler",
				attemptId: "attempt_scheduler",
				status: "queued" as const,
			})),
			wait: vi.fn(() => waiting.promise),
		});
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(ownerClient),
		});
		const drive = scheduler.drive();
		while (vi.mocked(ownerClient.wait).mock.calls.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		expect(
			(await projection(journal)).tasks[tasks[0]?.ref.taskId ?? ""]?.status,
		).toBe("waiting");
		waiting.resolve(executionResult(result("completed")));
		await expect(drive).resolves.toMatchObject({
			state: "awaiting-finalization",
			outcome: "completed",
		});
	});

	it("finalizes a settled task before selecting more work", async () => {
		const { journal, tasks } = await fixture();
		const ownerClient = client({
			release: vi.fn(async () => ({
				runId: "run_scheduler",
				attemptId: "attempt_scheduler",
				status: "completed" as const,
			})),
		});
		const artifacts = await WorkflowArtifactStore.open({ journal });
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			artifacts,
			binding: binding(ownerClient),
		});
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(ownerClient),
			finalizer,
		});

		await expect(scheduler.drive()).resolves.toEqual({
			state: "idle",
			runStatus: "waiting",
		});
		const state = await projection(journal);
		expect(state.tasks[tasks[0]?.ref.taskId ?? ""]?.status).toBe("completed");
		expect(ownerClient.wait).toHaveBeenCalledTimes(2);
		expect(ownerClient.release).toHaveBeenCalledOnce();
	});

	it("replays a settled task without relaunching or waiting again", async () => {
		const { journal } = await fixture();
		const ownerClient = client();
		await createWorkflowSequentialScheduler({
			journal,
			binding: binding(ownerClient),
		}).drive();
		const resumed = createWorkflowSequentialScheduler({
			journal,
			binding: binding(ownerClient),
		});

		await expect(resumed.drive()).resolves.toMatchObject({
			state: "awaiting-finalization",
			outcome: "completed",
		});
		expect(ownerClient.launch).toHaveBeenCalledOnce();
		expect(ownerClient.wait).toHaveBeenCalledOnce();
	});

	it("serializes launch across scheduler instances for one run", async () => {
		const { journal } = await fixture();
		const waiting = deferred<ReturnType<typeof executionResult>>();
		const ownerClient = client({ wait: vi.fn(() => waiting.promise) });
		const first = createWorkflowSequentialScheduler({
			journal,
			binding: binding(ownerClient),
		});
		const second = createWorkflowSequentialScheduler({
			journal,
			binding: binding(ownerClient),
		});
		const drives = [first.drive(), second.drive()];
		while (vi.mocked(ownerClient.wait).mock.calls.length < 2) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		waiting.resolve(executionResult(result("completed")));
		await expect(Promise.all(drives)).resolves.toHaveLength(2);
		expect(ownerClient.preflight).toHaveBeenCalledOnce();
		expect(ownerClient.launch).toHaveBeenCalledOnce();
	});

	it("rejects conflicting terminal results from concurrent waits", async () => {
		const { journal } = await fixture();
		const firstWait = deferred<ReturnType<typeof executionResult>>();
		const secondWait = deferred<ReturnType<typeof executionResult>>();
		const wait = vi
			.fn()
			.mockImplementationOnce(() => firstWait.promise)
			.mockImplementationOnce(() => secondWait.promise);
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(client({ wait })),
		});
		const first = scheduler.drive();
		const second = scheduler.drive();
		const conflicting = expect(second).rejects.toMatchObject({
			stage: "observation",
		});
		while (wait.mock.calls.length < 2) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		firstWait.resolve(executionResult(result("completed")));
		await expect(first).resolves.toMatchObject({ outcome: "completed" });
		secondWait.resolve(executionResult(result("failed")));
		await conflicting;
		expect(
			Object.values((await projection(journal)).executions)[0]?.settlement
				?.evidence.status,
		).toBe("completed");
	});

	it("persists stop intent before interrupt and drains cancellation evidence", async () => {
		const { journal, tasks } = await fixture();
		const waiting = deferred<ReturnType<typeof executionResult>>();
		const ownerClient = client({
			wait: vi.fn(() => waiting.promise),
		});
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(ownerClient),
		});
		const drive = scheduler.drive();
		while (vi.mocked(ownerClient.wait).mock.calls.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		const stop = scheduler.stop("operator requested stop");
		while (vi.mocked(ownerClient.interrupt).mock.calls.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		const stopping = await projection(journal);
		expect(stopping.status).toBe("stopping");
		expect(stopping.tasks[tasks[0]?.ref.taskId ?? ""]?.status).toBe(
			"cancelling",
		);
		waiting.resolve(executionResult(result("cancelled")));

		await expect(stop).resolves.toMatchObject({
			state: "awaiting-finalization",
			outcome: "cancelled",
			runStatus: "stopping",
		});
		await expect(drive).resolves.toMatchObject({
			state: "awaiting-finalization",
			outcome: "cancelled",
		});
		const settled = await projection(journal);
		expect(
			settled.executions[
				settled.tasks[tasks[0]?.ref.taskId ?? ""]?.currentExecutionId ?? ""
			]?.settlement?.evidence.status,
		).toBe("cancelled");
	});

	it("cancels an unstarted graph without acquiring a child", async () => {
		const { journal } = await fixture();
		const ownerClient = client();
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(ownerClient),
		});

		await expect(scheduler.stop("not needed")).resolves.toEqual({
			state: "terminal",
			runStatus: "cancelled",
		});
		const state = await projection(journal);
		expect(state.status).toBe("cancelled");
		expect(Object.values(state.tasks).map((task) => task.status)).toEqual([
			"cancelled",
		]);
		expect(ownerClient.preflight).not.toHaveBeenCalled();
		expect(ownerClient.interrupt).not.toHaveBeenCalled();
	});

	it("fails the run when a required task fails before launch", async () => {
		const { journal, tasks } = await fixture();
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(
				client({
					preflight: vi.fn(async () => {
						throw new Error("agent unavailable");
					}),
				}),
			),
		});

		await expect(scheduler.drive()).rejects.toThrow("preflight");
		const state = await projection(journal);
		expect(state.status).toBe("failed");
		expect(state.tasks[tasks[0]?.ref.taskId ?? ""]?.status).toBe("failed");
	});

	it("cancels a created execution without launching after stop intent", async () => {
		const { journal, tasks } = await fixture();
		const taskId = tasks[0]?.ref.taskId;
		if (!taskId) throw new Error("missing task");
		await journal.append("run-status-changed", {
			from: "created",
			to: "running",
		});
		await journal.append("task-status-changed", {
			taskId,
			from: "pending",
			to: "ready",
		});
		const current = await projection(journal);
		const task = current.tasks[taskId];
		if (!task) throw new Error("missing projected task");
		await journal.append("task-execution-created", {
			execution: {
				id: deriveTaskExecutionId(current.runId, taskId, 1),
				runId: current.runId,
				taskId,
				generation: 1,
				taskIdentitySha256: task.task.spec.identitySha256,
				operationId: deriveSubagentOperationId(current.runId, taskId, 1),
			},
		});
		const ownerClient = client();
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(ownerClient),
		});

		await expect(scheduler.stop("cancel before launch")).resolves.toEqual({
			state: "terminal",
			runStatus: "cancelled",
		});
		const stopped = await projection(journal);
		expect(stopped.status).toBe("cancelled");
		expect(stopped.tasks[taskId]?.status).toBe("cancelled");
		expect(Object.values(stopped.executions)[0]?.terminal).toMatchObject({
			outcome: "cancelled",
			evidence: { kind: "workflow", stage: "stop" },
		});
		expect(ownerClient.preflight).not.toHaveBeenCalled();
		expect(ownerClient.launch).not.toHaveBeenCalled();
	});

	it("resumes persisted stop intent and retries interruption", async () => {
		const { journal } = await fixture();
		const firstClient = client({
			interrupt: vi.fn(async () => {
				throw new Error("seat lost after stop intent");
			}),
			wait: vi.fn(
				async () =>
					new Promise<ReturnType<typeof executionResult>>(() => undefined),
			),
		});
		const first = createWorkflowSequentialScheduler({
			journal,
			binding: binding(firstClient),
		});
		const drive = first.drive();
		while (vi.mocked(firstClient.wait).mock.calls.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		await expect(first.stop("stop now")).rejects.toMatchObject({
			stage: "stop",
		});
		void drive.catch(() => undefined);

		const secondClient = client({
			wait: vi.fn(async () => executionResult(result("cancelled"))),
		});
		const resumed = createWorkflowSequentialScheduler({
			journal,
			binding: binding(secondClient),
		});
		await expect(resumed.drive()).resolves.toMatchObject({
			state: "awaiting-finalization",
			outcome: "cancelled",
			runStatus: "stopping",
		});
		expect(secondClient.interrupt).toHaveBeenCalledOnce();
	});

	it("blocks dependents after an optional predecessor fails preflight", async () => {
		const { journal, tasks } = await fixture((materializer) => {
			const first = materializer.agent(
				"first",
				request({ disposition: "optional" }),
			);
			const second = materializer.agent(
				"second",
				request({ after: [first.ref] }),
			);
			return [first, second];
		});
		const ownerClient = client({
			preflight: vi.fn(async () => {
				throw new Error("agent unavailable");
			}),
		});
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(ownerClient),
		});

		await expect(scheduler.drive()).rejects.toThrow("preflight");
		await expect(scheduler.drive()).resolves.toMatchObject({ state: "idle" });
		const state = await projection(journal);
		expect(state.tasks[tasks[0]?.ref.taskId ?? ""]?.status).toBe("failed");
		expect(state.tasks[tasks[1]?.ref.taskId ?? ""]?.status).toBe("blocked");
		expect(state.status).toBe("waiting");
	});

	it("leaves invalid child results uncommitted for reconciliation", async () => {
		const { journal, tasks } = await fixture();
		const invalid = executionResult(result("completed"));
		invalid.result = { ...invalid.result, runId: "run_other" };
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(client({ wait: vi.fn(async () => invalid) })),
		});

		await expect(scheduler.drive()).rejects.toBeInstanceOf(
			WorkflowSchedulerError,
		);
		const state = await projection(journal);
		const executionId =
			state.tasks[tasks[0]?.ref.taskId ?? ""]?.currentExecutionId;
		expect(
			executionId ? state.executions[executionId]?.settlement : undefined,
		).toBeUndefined();
	});

	it("rejects settlement writes after scheduler lease loss", async () => {
		const { root, lease, journal } = await fixture();
		const waiting = deferred<ReturnType<typeof executionResult>>();
		const ownerClient = client({ wait: vi.fn(() => waiting.promise) });
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(ownerClient),
		});
		const drive = scheduler.drive();
		const rejection = expect(drive).rejects.toBeInstanceOf(
			WorkflowRunLeaseFencedError,
		);
		while (vi.mocked(ownerClient.wait).mock.calls.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		await lease.release();
		leases.delete(lease);
		const replacement = await acquireWorkflowRunLease({
			storeRoot: root,
			runId: "workflow_scheduler",
			ownerId: "replacement-scheduler",
		});
		leases.add(replacement);
		waiting.resolve(executionResult(result("completed")));

		await rejection;
	});
});
