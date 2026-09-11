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
import {
	defineSupportTask,
	type SupportTaskExecutionContext,
	type SupportTaskRegistration,
} from "../src/support.js";
import { createWorkflowSupportTaskExecutor } from "../src/support-executor.js";
import { createWorkflowTaskFinalizer } from "../src/task-finalizer.js";

const definitionIdentitySha256 = "a".repeat(64);
const inputSha256 = "b".repeat(64);
const hash = "c".repeat(64);
const leases = new Set<WorkflowRunLease>();

type Deferred<T> = {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	return { promise, reject, resolve };
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
			cumulativeRuntimeMs: 300_000,
			attemptTimeoutMs: 300_000,
			totalTokens: 1_000_000,
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

function result(
	status: "completed" | "failed" | "cancelled" | "cleanup-blocked",
): RunResult {
	const failure =
		status === "completed"
			? undefined
			: {
					code:
						status === "cancelled"
							? ("cancellation" as const)
							: status === "cleanup-blocked"
								? ("sandbox-cleanup" as const)
								: ("tool" as const),
					origin:
						status === "cancelled"
							? ("operator" as const)
							: status === "cleanup-blocked"
								? ("sandbox" as const)
								: ("tool" as const),
					retry:
						status === "cleanup-blocked"
							? ("reconcile" as const)
							: ("never" as const),
					message:
						status === "cancelled"
							? "cancelled"
							: status === "cleanup-blocked"
								? "cleanup blocked"
								: "tool failed",
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
		sandboxCleanup: status === "cleanup-blocked" ? "blocked" : "proved",
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

function concurrentClient(
	prefix: string,
	wait: SubagentClient["wait"],
): {
	ownerClient: SubagentClient;
	preflightCall: ReturnType<typeof vi.fn>;
	launch: ReturnType<typeof vi.fn>;
} {
	const grants = new Map<string, SubagentPreflight>();
	let ordinal = 0;
	const preflightCall = vi.fn(async (input: SubagentRequest) => {
		const index = ordinal++;
		const original = launchPlan(input, "pi-workflow:workflow_scheduler");
		const { identitySha256: _identity, ...base } = original;
		const draft = {
			...base,
			runId: `run_${prefix}${index}`,
			attemptId: `attempt_${prefix}${index}`,
		};
		const plan = { ...draft, identitySha256: canonicalSha256(draft) };
		const grant: SubagentPreflight = {
			preflightId: `preflight-${prefix}${index}`,
			identitySha256: plan.identitySha256,
			expiresAt: "2099-01-01T00:00:00.000Z",
			launchPlan: plan,
		};
		grants.set(grant.preflightId, grant);
		return grant;
	});
	const launch = vi.fn(async (preflightId: string) => {
		const grant = grants.get(preflightId);
		if (!grant) throw new Error("missing grant");
		return {
			runId: grant.launchPlan.runId,
			attemptId: grant.launchPlan.attemptId,
			status: "active" as const,
		};
	});
	return {
		ownerClient: client({ preflight: preflightCall, launch, wait }),
		preflightCall,
		launch,
	};
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
	it("reserves declared maxima before launching a task", async () => {
		const { journal, tasks } = await fixture();
		const ownerClient = client();
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(ownerClient),
			budget: { cost: 99, totalTokens: 1_000_000, childRuntimeMs: 300_000 },
		});

		await expect(scheduler.drive()).resolves.toEqual({
			state: "terminal",
			runStatus: "failed",
		});
		const state = await projection(journal);
		expect(state.status).toBe("failed");
		expect(state.tasks[tasks[0]?.ref.taskId ?? ""]?.status).toBe("blocked");
		expect(ownerClient.preflight).not.toHaveBeenCalled();
	});

	it("defers a candidate while active reservations consume its capacity", async () => {
		const { journal } = await fixture((materializer) => [
			materializer.agent("first", request()),
			materializer.agent("second", request()),
		]);
		const waiting = deferred<ReturnType<typeof executionResult>>();
		const delegated = concurrentClient("budget", async () => waiting.promise);
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(delegated.ownerClient),
			concurrency: 2,
			budget: { cost: 150, childRuntimeMs: 600_000 },
		});

		const first = scheduler.drive();
		await vi.waitFor(() => expect(delegated.launch).toHaveBeenCalledOnce());
		await expect(scheduler.drive()).resolves.toMatchObject({ state: "idle" });
		expect(delegated.launch).toHaveBeenCalledOnce();
		waiting.resolve(
			executionResult({ ...result("completed"), runId: "run_budget0" }),
		);
		await expect(first).resolves.toMatchObject({
			state: "awaiting-finalization",
		});
	});

	it("requires task maxima for an effective workflow token budget", async () => {
		const { journal, tasks } = await fixture((materializer) => {
			const task = request();
			const { totalTokens: _totalTokens, ...limits } = task.limits;
			return [materializer.agent("answer", { ...task, limits })];
		});
		const ownerClient = client();
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(ownerClient),
			budget: {
				cost: 100,
				totalTokens: 1_000_000,
				childRuntimeMs: 300_000,
			},
		});

		await expect(scheduler.drive()).resolves.toEqual({
			state: "terminal",
			runStatus: "failed",
		});
		const state = await projection(journal);
		expect(state.tasks[tasks[0]?.ref.taskId ?? ""]?.status).toBe("blocked");
		expect(ownerClient.preflight).not.toHaveBeenCalled();
	});

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

	it("fails after a settled child overshoots the workflow budget", async () => {
		const { journal } = await fixture((materializer) => [
			materializer.agent("optional", request({ disposition: "optional" })),
		]);
		const overage = result("failed");
		overage.usage.cost = 101;
		const ownerClient = client({
			wait: vi.fn(async () => executionResult(overage)),
			release: vi.fn(async () => ({
				runId: "run_scheduler",
				attemptId: "attempt_scheduler",
				status: "failed" as const,
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
			budget: { cost: 100, childRuntimeMs: 300_000 },
		});

		await expect(scheduler.drive()).resolves.toEqual({
			state: "terminal",
			runStatus: "failed",
		});
		expect((await projection(journal)).status).toBe("failed");
	});

	it("launches two independent tasks before either child settles", async () => {
		const { journal } = await fixture((materializer) => [
			materializer.agent("first", request()),
			materializer.agent("second", request()),
			materializer.agent("third", request()),
		]);
		const pending = [
			deferred<ReturnType<typeof executionResult>>(),
			deferred<ReturnType<typeof executionResult>>(),
		];
		const grants = new Map<string, SubagentPreflight>();
		let ordinal = 0;
		const preflightCall = vi.fn(async (input: SubagentRequest) => {
			const index = ordinal++;
			const original = launchPlan(input, "pi-workflow:workflow_scheduler");
			const { identitySha256: _identity, ...base } = original;
			const draft = {
				...base,
				runId: `run_parallel${index}`,
				attemptId: `attempt_parallel${index}`,
			};
			const plan = { ...draft, identitySha256: canonicalSha256(draft) };
			const grant: SubagentPreflight = {
				preflightId: `preflight-parallel${index}`,
				identitySha256: plan.identitySha256,
				expiresAt: "2099-01-01T00:00:00.000Z",
				launchPlan: plan,
			};
			grants.set(grant.preflightId, grant);
			return grant;
		});
		const launch = vi.fn(async (preflightId: string) => {
			const grant = grants.get(preflightId);
			if (!grant) throw new Error("missing grant");
			return {
				runId: grant.launchPlan.runId,
				attemptId: grant.launchPlan.attemptId,
				status: "active" as const,
			};
		});
		const wait = vi.fn((runId: string) => {
			const index = Number(runId.at(-1));
			const value = pending[index];
			if (!value) throw new Error("unexpected child");
			return value.promise;
		});
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(client({ preflight: preflightCall, launch, wait })),
			concurrency: 2,
		});

		const drives = [scheduler.drive(), scheduler.drive()];
		while (wait.mock.calls.length < 2) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		expect(launch).toHaveBeenCalledTimes(2);
		await expect(scheduler.drive()).resolves.toMatchObject({ state: "idle" });
		expect(launch).toHaveBeenCalledTimes(2);
		pending[1]?.resolve(
			executionResult({ ...result("completed"), runId: "run_parallel1" }),
		);
		pending[0]?.resolve(
			executionResult({ ...result("completed"), runId: "run_parallel0" }),
		);
		await expect(Promise.all(drives)).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ outcome: "completed" }),
				expect.objectContaining({ outcome: "completed" }),
			]),
		);
	});

	it("preserves an active sibling when a later launch fails", async () => {
		const { journal } = await fixture((materializer) => [
			materializer.agent("first", request()),
			materializer.agent("second", request()),
		]);
		const pending = deferred<ReturnType<typeof executionResult>>();
		const wait = vi.fn(() => pending.promise);
		const harness = concurrentClient("partial", wait);
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(harness.ownerClient),
			concurrency: 2,
		});
		const first = scheduler.drive();
		while (wait.mock.calls.length < 1) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		harness.preflightCall.mockRejectedValueOnce(new Error("agent unavailable"));
		await expect(scheduler.drive()).rejects.toMatchObject({
			stage: "preflight",
		});
		expect(harness.launch).toHaveBeenCalledOnce();
		pending.resolve(
			executionResult({ ...result("completed"), runId: "run_partial0" }),
		);
		await expect(first).resolves.toMatchObject({ outcome: "completed" });
		const state = await projection(journal);
		expect(state.status).toBe("failed");
		expect(
			Object.values(state.executions).some(
				(execution) => execution.settlement?.evidence.status === "completed",
			),
		).toBe(true);
	}, 15_000);

	it("reacquires every active child after lease rotation", async () => {
		const { journal, lease, root } = await fixture((materializer) => [
			materializer.agent("first", request()),
			materializer.agent("second", request()),
		]);
		const pending = [
			deferred<ReturnType<typeof executionResult>>(),
			deferred<ReturnType<typeof executionResult>>(),
		];
		const initialWait = vi.fn((runId: string) => {
			const value = pending[Number(runId.at(-1))];
			if (!value) throw new Error("unexpected child");
			return value.promise;
		});
		const initial = concurrentClient("restart", initialWait);
		const firstScheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(initial.ownerClient),
			concurrency: 2,
		});
		const drives = [firstScheduler.drive(), firstScheduler.drive()];
		while (initialWait.mock.calls.length < 2) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		pending[0]?.reject(new Error("seat lost"));
		pending[1]?.reject(new Error("seat lost"));
		await Promise.allSettled(drives);
		expect(initial.launch).toHaveBeenCalledTimes(2);

		await lease.release();
		leases.delete(lease);
		const replacement = await acquireWorkflowRunLease({
			storeRoot: root,
			runId: "workflow_scheduler",
			ownerId: "scheduler-restart",
		});
		leases.add(replacement);
		const resumedJournal = await WorkflowRunJournal.open(
			root,
			"workflow_scheduler",
			replacement,
		);
		const resumedWait = vi.fn(async (runId: string) =>
			executionResult({ ...result("completed"), runId }),
		);
		const resumed = concurrentClient("unused", resumedWait);
		const secondScheduler = createWorkflowSequentialScheduler({
			journal: resumedJournal,
			binding: binding(resumed.ownerClient),
			concurrency: 2,
		});

		await expect(
			Promise.all([secondScheduler.drive(), secondScheduler.drive()]),
		).resolves.toHaveLength(2);
		expect(resumed.preflightCall).not.toHaveBeenCalled();
		expect(resumed.launch).not.toHaveBeenCalled();
		expect(new Set(resumedWait.mock.calls.map(([runId]) => runId))).toEqual(
			new Set(["run_restart0", "run_restart1"]),
		);
	}, 15_000);

	it("stops and releases every concurrently active child", async () => {
		const { journal } = await fixture((materializer) => [
			materializer.agent("first", request()),
			materializer.agent("second", request()),
		]);
		const pending = [
			deferred<ReturnType<typeof executionResult>>(),
			deferred<ReturnType<typeof executionResult>>(),
		];
		const grants = new Map<string, SubagentPreflight>();
		let ordinal = 0;
		const preflightCall = vi.fn(async (input: SubagentRequest) => {
			const index = ordinal++;
			const original = launchPlan(input, "pi-workflow:workflow_scheduler");
			const { identitySha256: _identity, ...base } = original;
			const draft = {
				...base,
				runId: `run_stop${index}`,
				attemptId: `attempt_stop${index}`,
			};
			const plan = { ...draft, identitySha256: canonicalSha256(draft) };
			const grant: SubagentPreflight = {
				preflightId: `preflight-stop${index}`,
				identitySha256: plan.identitySha256,
				expiresAt: "2099-01-01T00:00:00.000Z",
				launchPlan: plan,
			};
			grants.set(grant.preflightId, grant);
			return grant;
		});
		const launch = vi.fn(async (preflightId: string) => {
			const grant = grants.get(preflightId);
			if (!grant) throw new Error("missing grant");
			return {
				runId: grant.launchPlan.runId,
				attemptId: grant.launchPlan.attemptId,
				status: "active" as const,
			};
		});
		const wait = vi.fn((runId: string) => {
			const value = pending[Number(runId.at(-1))];
			if (!value) throw new Error("unexpected child");
			return value.promise;
		});
		const interrupt = vi.fn(async (runId: string) => {
			const index = Number(runId.at(-1));
			pending[index]?.resolve(
				executionResult({ ...result("cancelled"), runId }),
			);
			return {
				runId,
				attemptId: `attempt_stop${index}`,
				status: "stopping" as const,
			};
		});
		const release = vi.fn(async (runId: string) => ({
			runId,
			attemptId: `attempt_stop${Number(runId.at(-1))}`,
			status: "cancelled" as const,
		}));
		const ownerClient = client({
			preflight: preflightCall,
			launch,
			wait,
			interrupt,
			release,
		});
		const ownerBinding = binding(ownerClient);
		const artifacts = await WorkflowArtifactStore.open({ journal });
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			binding: ownerBinding,
			artifacts,
		});
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: ownerBinding,
			finalizer,
			concurrency: 2,
		});

		const drives = [scheduler.drive(), scheduler.drive()];
		while (wait.mock.calls.length < 2) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		await expect(scheduler.stop("operator stop")).resolves.toMatchObject({
			state: "terminal",
			runStatus: "cancelled",
		});
		await Promise.allSettled(drives);
		expect(interrupt).toHaveBeenCalledTimes(2);
		expect(release).toHaveBeenCalledTimes(2);
		const state = await projection(journal);
		expect(state.status).toBe("cancelled");
		expect(Object.values(state.tasks).map((task) => task.status)).toEqual([
			"cancelled",
			"cancelled",
		]);
	}, 15_000);

	it("keeps parallel stop action-required after one interrupt fails", async () => {
		const { journal } = await fixture((materializer) => [
			materializer.agent("first", request()),
			materializer.agent("second", request()),
		]);
		const pending = [
			deferred<ReturnType<typeof executionResult>>(),
			deferred<ReturnType<typeof executionResult>>(),
		];
		const wait = vi.fn((runId: string) => {
			const value = pending[Number(runId.at(-1))];
			if (!value) throw new Error("unexpected child");
			return value.promise;
		});
		const harness = concurrentClient("interrupt", wait);
		let interruptCalls = 0;
		const interrupt = vi.fn(async (runId: string) => {
			interruptCalls += 1;
			if (interruptCalls === 1) throw new Error("interrupt unavailable");
			const index = Number(runId.at(-1));
			pending[index]?.resolve(
				executionResult({ ...result("cancelled"), runId }),
			);
			return {
				runId,
				attemptId: `attempt_interrupt${index}`,
				status: "stopping" as const,
			};
		});
		const release = vi.fn(async (runId: string) => ({
			runId,
			attemptId: `attempt_interrupt${Number(runId.at(-1))}`,
			status: "cancelled" as const,
		}));
		const ownerClient = harness.ownerClient;
		vi.mocked(ownerClient.interrupt).mockImplementation(interrupt);
		vi.mocked(ownerClient.release).mockImplementation(release);
		const ownerBinding = binding(ownerClient);
		const artifacts = await WorkflowArtifactStore.open({ journal });
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			binding: ownerBinding,
			artifacts,
		});
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: ownerBinding,
			finalizer,
			concurrency: 2,
		});
		const drives = [scheduler.drive(), scheduler.drive()];
		while (wait.mock.calls.length < 2) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}

		await expect(scheduler.stop("operator stop")).rejects.toMatchObject({
			stage: "stop",
		});
		const blocked = await projection(journal);
		expect(blocked.status).toBe("stopping");
		expect(Object.values(blocked.tasks).map((task) => task.status)).toEqual([
			"cancelling",
			"running",
		]);
		await expect(scheduler.stop("retry stop")).resolves.toMatchObject({
			state: "terminal",
			runStatus: "cancelled",
		});
		await Promise.allSettled(drives);
		expect(interrupt).toHaveBeenCalledTimes(3);
		expect(release).toHaveBeenCalledTimes(2);
	}, 15_000);

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

	it("does not wait for the same child twice in one scheduler", async () => {
		const { journal } = await fixture();
		const waiting = deferred<ReturnType<typeof executionResult>>();
		const wait = vi.fn(() => waiting.promise);
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(client({ wait })),
		});
		const first = scheduler.drive();
		await expect(scheduler.drive()).resolves.toMatchObject({ state: "idle" });
		expect(wait).toHaveBeenCalledOnce();
		waiting.resolve(executionResult(result("completed")));
		await expect(first).resolves.toMatchObject({ outcome: "completed" });
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

	it("reconciles cleanup-blocked child evidence and finalizes again", async () => {
		const { journal, tasks } = await fixture();
		const wait = vi
			.fn()
			.mockResolvedValueOnce(executionResult(result("cleanup-blocked")))
			.mockResolvedValueOnce(executionResult(result("failed")));
		const release = vi
			.fn()
			.mockResolvedValueOnce({
				runId: "run_scheduler",
				attemptId: "attempt_scheduler",
				status: "cleanup-blocked" as const,
			})
			.mockResolvedValueOnce({
				runId: "run_scheduler",
				attemptId: "attempt_scheduler",
				status: "failed" as const,
			});
		const ownerClient = client({
			wait,
			release,
			reconcile: vi.fn(async () => ({
				run: {
					runId: "run_scheduler",
					attemptId: "attempt_scheduler",
					status: "failed" as const,
				},
				sandboxProcess: "absent" as const,
				workspace: "not-needed" as const,
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
		await expect(scheduler.drive()).resolves.toMatchObject({
			state: "terminal",
			runStatus: "cleanup-blocked",
		});
		await expect(
			scheduler.reconcile(tasks[0]?.ref.taskId ?? ""),
		).resolves.toMatchObject({
			state: "terminal",
			runStatus: "failed",
		});
		expect(ownerClient.reconcile).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledTimes(2);
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
				kind: "agent",
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

const echo = defineSupportTask({
	name: "test/echo",
	moduleSpecifier: "@vegardx/workflow-tools",
	revision: 1,
	implementationSha256: hash,
	parametersSchema: Type.Object({ value: Type.String() }),
	outputSchema: Type.Object({ answer: Type.String() }),
});

type EchoContext = SupportTaskExecutionContext<{ value: string }>;
type EchoExecute = (
	context: EchoContext,
) => Promise<{ answer: string }> | { answer: string };

function echoRegistry(
	execute: EchoExecute,
): ReadonlyMap<string, SupportTaskRegistration> {
	const registration = echo.registration(execute);
	return new Map([[registration.name, registration]]);
}

function supportOnlyClient(): SubagentClient {
	const unexpected = () =>
		vi.fn(async () => {
			throw new Error("unexpected subagent call");
		});
	return {
		preflight: unexpected(),
		launch: unexpected(),
		findByOperation: unexpected(),
		status: unexpected(),
		listRuns: unexpected(),
		logs: unexpected(),
		wait: unexpected(),
		interrupt: unexpected(),
		steer: unexpected(),
		followUp: unexpected(),
		retry: unexpected(),
		resume: unexpected(),
		reconcile: unexpected(),
		release: unexpected(),
		abandon: unexpected(),
		pin: unexpected(),
		unpin: unexpected(),
		exportArtifact: unexpected(),
	} as unknown as SubagentClient;
}

function subagentCallCount(ownerClient: SubagentClient): number {
	return Object.values(ownerClient).reduce<number>(
		(total, method) =>
			total + (vi.isMockFunction(method) ? method.mock.calls.length : 0),
		0,
	);
}

async function driveToRest(scheduler: {
	drive(): Promise<{ state: string; runStatus: string }>;
}) {
	for (let round = 0; round < 16; round += 1) {
		const outcome = await scheduler.drive();
		if (outcome.state === "idle" || outcome.state === "terminal") {
			return outcome;
		}
	}
	throw new Error("scheduler did not come to rest");
}

async function rotateLease(fx: { root: string; lease: WorkflowRunLease }) {
	await fx.lease.release();
	leases.delete(fx.lease);
	const replacement = await acquireWorkflowRunLease({
		storeRoot: fx.root,
		runId: "workflow_scheduler",
		ownerId: "scheduler-restart",
	});
	leases.add(replacement);
	const journal = await WorkflowRunJournal.open(
		fx.root,
		"workflow_scheduler",
		replacement,
	);
	return { journal, lease: replacement };
}

/**
 * Persists a support task as `running` with durable intent through the
 * executor alone, the way a crashed process would have left it behind.
 */
async function seedRunningSupportTask(
	journal: WorkflowRunJournal,
	taskId: string,
	registrations: ReadonlyMap<string, SupportTaskRegistration>,
) {
	await journal.append("run-status-changed", {
		from: "created",
		to: "running",
	});
	await journal.append("task-status-changed", {
		taskId,
		from: "pending",
		to: "ready",
	});
	const executor = createWorkflowSupportTaskExecutor({
		journal,
		artifacts: await WorkflowArtifactStore.open({ journal }),
		registrations,
		signal: () => new AbortController().signal,
	});
	await expect(executor.intend(taskId)).resolves.toMatchObject({
		state: "intended",
	});
	const seeded = await projection(journal);
	expect(seeded.tasks[taskId]?.status).toBe("running");
}

function statusChanges(
	events: readonly { type: string; data: unknown }[],
	type: "task-status-changed" | "run-status-changed",
) {
	return events
		.filter((event) => event.type === type)
		.map((event) => event.data as { to: string; reason?: string });
}

// Full lifecycle cases here take 1-2 s locally and exceeded the 5 s default
// under Ubuntu CI load (run 34596885650); use the file's existing allowance.
describe("support task scheduling", { timeout: 15_000 }, () => {
	it("completes a support-only graph without any subagent call", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.support("left", echo({ parameters: { value: "left" } })),
			materializer.support("right", echo({ parameters: { value: "right" } })),
		]);
		const implementation = vi.fn<EchoExecute>(async ({ parameters }) => ({
			answer: parameters.value.toUpperCase(),
		}));
		const ownerClient = supportOnlyClient();
		const artifacts = await WorkflowArtifactStore.open({ journal });
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(ownerClient),
			concurrency: 2,
			artifacts,
			supportTasks: echoRegistry(implementation),
		});

		await expect(driveToRest(scheduler)).resolves.toEqual({
			state: "idle",
			runStatus: "waiting",
		});
		const state = await projection(journal);
		expect(implementation).toHaveBeenCalledTimes(2);
		expect(subagentCallCount(ownerClient)).toBe(0);
		for (const [handle, answer] of [
			[tasks[0], "LEFT"],
			[tasks[1], "RIGHT"],
		] as const) {
			const taskId = handle?.ref.taskId ?? "";
			expect(state.tasks[taskId]?.status).toBe("completed");
			const results = Object.values(state.artifacts).filter(
				(artifact) =>
					artifact.producerTaskId === taskId && artifact.output === "result",
			);
			expect(results).toHaveLength(1);
			const artifact = results[0];
			if (!artifact) throw new Error("missing result artifact");
			await expect(artifacts.readJson(artifact)).resolves.toEqual({ answer });
			const execution =
				state.executions[state.tasks[taskId]?.currentExecutionId ?? ""];
			expect(execution).toMatchObject({
				phase: "terminal",
				terminal: {
					outcome: "completed",
					evidence: { kind: "support", artifactId: artifact.id },
				},
			});
		}
	});

	it("keeps an agent task out of the lane a running support task occupies", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.support("prepare", echo({ parameters: { value: "x" } })),
			materializer.agent("answer", request()),
		]);
		const invoked = deferred<void>();
		const release = deferred<{ answer: string }>();
		const implementation = vi.fn<EchoExecute>(() => {
			invoked.resolve();
			return release.promise;
		});
		const ownerClient = client();
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(ownerClient),
			concurrency: 1,
			artifacts: await WorkflowArtifactStore.open({ journal }),
			supportTasks: echoRegistry(implementation),
		});

		const first = scheduler.drive();
		await invoked.promise;
		expect(
			(await projection(journal)).tasks[tasks[0]?.ref.taskId ?? ""]?.status,
		).toBe("running");
		await expect(scheduler.drive()).resolves.toMatchObject({ state: "idle" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(ownerClient.preflight).not.toHaveBeenCalled();
		expect(ownerClient.launch).not.toHaveBeenCalled();
		expect(
			(await projection(journal)).tasks[tasks[1]?.ref.taskId ?? ""]?.status,
		).toBe("pending");

		release.resolve({ answer: "done" });
		await expect(first).resolves.toMatchObject({
			state: "awaiting-finalization",
			outcome: "completed",
		});
		expect(ownerClient.preflight).toHaveBeenCalledOnce();
		expect(ownerClient.launch).toHaveBeenCalledOnce();
		const state = await projection(journal);
		expect(state.tasks[tasks[0]?.ref.taskId ?? ""]?.status).toBe("completed");
		expect(state.tasks[tasks[1]?.ref.taskId ?? ""]?.status).toBe("running");
	});

	it("runs a support task and an agent task in parallel lanes", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.support("prepare", echo({ parameters: { value: "x" } })),
			materializer.agent("answer", request()),
		]);
		const invoked = deferred<void>();
		const release = deferred<{ answer: string }>();
		const implementation = vi.fn<EchoExecute>(() => {
			invoked.resolve();
			return release.promise;
		});
		const childResult = deferred<ReturnType<typeof executionResult>>();
		const wait = vi.fn(() => childResult.promise);
		const harness = concurrentClient("lanes", wait);
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(harness.ownerClient),
			concurrency: 2,
			artifacts: await WorkflowArtifactStore.open({ journal }),
			supportTasks: echoRegistry(implementation),
		});

		const first = scheduler.drive();
		await invoked.promise;
		const second = scheduler.drive();
		await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
		expect(harness.launch).toHaveBeenCalledOnce();
		const parallel = await projection(journal);
		expect(parallel.tasks[tasks[0]?.ref.taskId ?? ""]?.status).toBe("running");
		expect(parallel.tasks[tasks[1]?.ref.taskId ?? ""]?.status).toBe("running");
		expect(implementation).toHaveBeenCalledOnce();

		childResult.resolve(
			executionResult({ ...result("completed"), runId: "run_lanes0" }),
		);
		await expect(second).resolves.toMatchObject({
			state: "awaiting-finalization",
			outcome: "completed",
		});
		release.resolve({ answer: "done" });
		await expect(first).resolves.toMatchObject({
			state: "awaiting-finalization",
			outcome: "completed",
		});
		expect(harness.launch).toHaveBeenCalledOnce();
		expect(
			(await projection(journal)).tasks[tasks[0]?.ref.taskId ?? ""]?.status,
		).toBe("completed");
	});

	it("resumes a running support task after lease rotation with one execution", async () => {
		const fx = await fixture((materializer) => [
			materializer.support("prepare", echo({ parameters: { value: "x" } })),
		]);
		const taskId = fx.tasks[0]?.ref.taskId ?? "";
		const implementation = vi.fn<EchoExecute>(async ({ parameters }) => ({
			answer: parameters.value,
		}));
		const registrations = echoRegistry(implementation);
		await seedRunningSupportTask(fx.journal, taskId, registrations);
		expect(implementation).not.toHaveBeenCalled();

		const resumed = await rotateLease(fx);
		const ownerClient = supportOnlyClient();
		const scheduler = createWorkflowSequentialScheduler({
			journal: resumed.journal,
			binding: binding(ownerClient),
			artifacts: await WorkflowArtifactStore.open({
				journal: resumed.journal,
			}),
			supportTasks: registrations,
		});

		await expect(driveToRest(scheduler)).resolves.toEqual({
			state: "idle",
			runStatus: "waiting",
		});
		expect(implementation).toHaveBeenCalledOnce();
		expect(subagentCallCount(ownerClient)).toBe(0);
		const state = await projection(resumed.journal);
		expect(state.tasks[taskId]?.status).toBe("completed");
		expect(
			Object.values(state.executions).filter(
				(execution) => execution.execution.taskId === taskId,
			),
		).toHaveLength(1);
		expect(
			Object.values(state.artifacts).filter(
				(artifact) =>
					artifact.producerTaskId === taskId && artifact.output === "result",
			),
		).toHaveLength(1);
	});

	it("blocks a required support task and fails the run without an executor", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.support("prepare", echo({ parameters: { value: "x" } })),
		]);
		const ownerClient = supportOnlyClient();
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(ownerClient),
		});

		await expect(scheduler.drive()).resolves.toEqual({
			state: "terminal",
			runStatus: "failed",
		});
		const message =
			"Support task execution is not configured for this workflow run.";
		const state = await projection(journal);
		expect(state.status).toBe("failed");
		expect(state.tasks[tasks[0]?.ref.taskId ?? ""]?.status).toBe("blocked");
		expect(state.tasks[tasks[0]?.ref.taskId ?? ""]?.currentExecutionId).toBe(
			undefined,
		);
		const events = await journal.readEvents();
		expect(statusChanges(events, "task-status-changed").at(-1)).toEqual({
			taskId: tasks[0]?.ref.taskId,
			from: "ready",
			to: "blocked",
			reason: message,
		});
		expect(statusChanges(events, "run-status-changed").at(-1)).toEqual({
			from: "running",
			to: "failed",
			reason: message,
		});
		expect(subagentCallCount(ownerClient)).toBe(0);
	});

	it("blocks an optional support task and proceeds without an executor", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.support(
				"prepare",
				echo({ parameters: { value: "x" }, disposition: "optional" }),
			),
		]);
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(supportOnlyClient()),
		});

		await expect(scheduler.drive()).resolves.toEqual({
			state: "idle",
			runStatus: "waiting",
		});
		const state = await projection(journal);
		expect(state.status).toBe("waiting");
		expect(state.tasks[tasks[0]?.ref.taskId ?? ""]?.status).toBe("blocked");
		expect(
			statusChanges(await journal.readEvents(), "task-status-changed").at(-1),
		).toMatchObject({
			to: "blocked",
			reason: "Support task execution is not configured for this workflow run.",
		});
	});

	it("fails the run when a required support implementation throws", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.support("prepare", echo({ parameters: { value: "x" } })),
		]);
		const implementation = vi.fn<EchoExecute>(async () => {
			throw new Error("secret detail that must not leak");
		});
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(supportOnlyClient()),
			artifacts: await WorkflowArtifactStore.open({ journal }),
			supportTasks: echoRegistry(implementation),
		});

		await expect(scheduler.drive()).resolves.toEqual({
			state: "terminal",
			runStatus: "failed",
		});
		const state = await projection(journal);
		const taskId = tasks[0]?.ref.taskId ?? "";
		expect(state.status).toBe("failed");
		expect(state.tasks[taskId]?.status).toBe("failed");
		const execution =
			state.executions[state.tasks[taskId]?.currentExecutionId ?? ""];
		expect(execution).toMatchObject({
			phase: "terminal",
			terminal: {
				outcome: "failed",
				evidence: {
					kind: "workflow",
					stage: "support-execution",
					message: "Support task implementation failed.",
				},
			},
		});
		expect(JSON.stringify(execution)).not.toContain("secret detail");
		expect(
			statusChanges(await journal.readEvents(), "run-status-changed").at(-1),
		).toEqual({
			from: "running",
			to: "failed",
			reason: "A required workflow task did not complete.",
		});
		expect(implementation).toHaveBeenCalledOnce();
	});

	it("keeps the run alive after an optional support failure and blocks dependents", async () => {
		const { journal, tasks } = await fixture((materializer) => {
			const prepare = materializer.support(
				"prepare",
				echo({ parameters: { value: "x" }, disposition: "optional" }),
			);
			const dependent = materializer.agent(
				"answer",
				request({ after: [prepare.ref] }),
			);
			return [prepare, dependent];
		});
		const implementation = vi.fn<EchoExecute>(async () => {
			throw new Error("boom");
		});
		const ownerClient = supportOnlyClient();
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(ownerClient),
			artifacts: await WorkflowArtifactStore.open({ journal }),
			supportTasks: echoRegistry(implementation),
		});

		await expect(driveToRest(scheduler)).resolves.toEqual({
			state: "idle",
			runStatus: "waiting",
		});
		const state = await projection(journal);
		expect(state.status).toBe("waiting");
		expect(state.tasks[tasks[0]?.ref.taskId ?? ""]?.status).toBe("failed");
		expect(state.tasks[tasks[1]?.ref.taskId ?? ""]?.status).toBe("blocked");
		expect(
			state.executions[
				state.tasks[tasks[0]?.ref.taskId ?? ""]?.currentExecutionId ?? ""
			]?.terminal,
		).toMatchObject({
			outcome: "failed",
			evidence: { kind: "workflow", stage: "support-execution" },
		});
		expect(
			statusChanges(await journal.readEvents(), "run-status-changed").some(
				(change) => change.to === "failed",
			),
		).toBe(false);
		expect(subagentCallCount(ownerClient)).toBe(0);
	});

	it("aborts an in-flight support task on stop and cancels the run", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.support("prepare", echo({ parameters: { value: "x" } })),
		]);
		const invoked = deferred<void>();
		const observedAbort = deferred<void>();
		const implementation = vi.fn<EchoExecute>(
			({ signal }) =>
				new Promise<{ answer: string }>((_resolve, reject) => {
					invoked.resolve();
					signal.addEventListener(
						"abort",
						() => {
							observedAbort.resolve();
							reject(signal.reason);
						},
						{ once: true },
					);
				}),
		);
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(supportOnlyClient()),
			artifacts: await WorkflowArtifactStore.open({ journal }),
			supportTasks: echoRegistry(implementation),
		});

		const drive = scheduler.drive();
		await invoked.promise;
		expect(scheduler.stopSignal.aborted).toBe(false);
		const stop = await scheduler.stop("operator stop");
		expect(scheduler.stopSignal.aborted).toBe(true);
		expect(["stopping", "terminal"]).toContain(stop.state);
		await observedAbort.promise;
		await Promise.allSettled([drive]);
		await expect(drive).resolves.toEqual({
			state: "terminal",
			runStatus: "cancelled",
		});
		const state = await projection(journal);
		const taskId = tasks[0]?.ref.taskId ?? "";
		expect(state.status).toBe("cancelled");
		expect(state.tasks[taskId]?.status).toBe("cancelled");
		expect(
			state.executions[state.tasks[taskId]?.currentExecutionId ?? ""]?.terminal,
		).toMatchObject({
			outcome: "cancelled",
			evidence: { kind: "workflow", stage: "stop" },
		});
		expect(implementation).toHaveBeenCalledOnce();
	});

	it("discards a late result from an implementation that ignores abort", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.support("prepare", echo({ parameters: { value: "x" } })),
		]);
		const invoked = deferred<void>();
		const late = deferred<{ answer: string }>();
		const implementation = vi.fn<EchoExecute>(() => {
			invoked.resolve();
			return late.promise;
		});
		const artifacts = await WorkflowArtifactStore.open({ journal });
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(supportOnlyClient()),
			artifacts,
			supportTasks: echoRegistry(implementation),
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const drive = scheduler.drive();
			await invoked.promise;
			await scheduler.stop("operator stop");
			await expect(drive).resolves.toEqual({
				state: "terminal",
				runStatus: "cancelled",
			});
			const taskId = tasks[0]?.ref.taskId ?? "";
			const stopped = await projection(journal);
			expect(stopped.tasks[taskId]?.status).toBe("cancelled");
			const before = await journal.readEvents();

			late.resolve({ answer: "too late" });
			await new Promise((resolve) => setTimeout(resolve, 20));

			const after = await journal.readEvents();
			expect(after).toEqual(before);
			const state = await projection(journal);
			expect(state.status).toBe("cancelled");
			expect(state.tasks[taskId]?.status).toBe("cancelled");
			expect(
				Object.values(state.artifacts).filter(
					(artifact) => artifact.producerTaskId === taskId,
				),
			).toHaveLength(0);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("cancels a running support task that no process is executing on stop", async () => {
		const fx = await fixture((materializer) => [
			materializer.support("prepare", echo({ parameters: { value: "x" } })),
		]);
		const taskId = fx.tasks[0]?.ref.taskId ?? "";
		const implementation = vi.fn<EchoExecute>(async () => ({ answer: "x" }));
		const registrations = echoRegistry(implementation);
		await seedRunningSupportTask(fx.journal, taskId, registrations);

		const resumed = await rotateLease(fx);
		const ownerClient = supportOnlyClient();
		const scheduler = createWorkflowSequentialScheduler({
			journal: resumed.journal,
			binding: binding(ownerClient),
			artifacts: await WorkflowArtifactStore.open({
				journal: resumed.journal,
			}),
			supportTasks: registrations,
		});

		await expect(scheduler.stop("operator stop")).resolves.toEqual({
			state: "terminal",
			runStatus: "cancelled",
		});
		const state = await projection(resumed.journal);
		expect(state.status).toBe("cancelled");
		expect(state.tasks[taskId]?.status).toBe("cancelled");
		expect(
			state.executions[state.tasks[taskId]?.currentExecutionId ?? ""]?.terminal,
		).toMatchObject({
			outcome: "cancelled",
			evidence: { kind: "workflow", stage: "stop", message: "operator stop" },
		});
		expect(implementation).not.toHaveBeenCalled();
		expect(subagentCallCount(ownerClient)).toBe(0);
	});

	it("stops and releases active children unchanged beside a completed support task", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.support("prepare", echo({ parameters: { value: "x" } })),
			materializer.agent("first", request()),
			materializer.agent("second", request()),
		]);
		const pending = [
			deferred<ReturnType<typeof executionResult>>(),
			deferred<ReturnType<typeof executionResult>>(),
		];
		const wait = vi.fn((runId: string) => {
			const value = pending[Number(runId.at(-1))];
			if (!value) throw new Error("unexpected child");
			return value.promise;
		});
		const harness = concurrentClient("beside", wait);
		const interrupt = vi.fn(async (runId: string) => {
			const index = Number(runId.at(-1));
			pending[index]?.resolve(
				executionResult({ ...result("cancelled"), runId }),
			);
			return {
				runId,
				attemptId: `attempt_beside${index}`,
				status: "stopping" as const,
			};
		});
		const release = vi.fn(async (runId: string) => ({
			runId,
			attemptId: `attempt_beside${Number(runId.at(-1))}`,
			status: "cancelled" as const,
		}));
		const ownerClient = harness.ownerClient;
		vi.mocked(ownerClient.interrupt).mockImplementation(interrupt);
		vi.mocked(ownerClient.release).mockImplementation(release);
		const ownerBinding = binding(ownerClient);
		const artifacts = await WorkflowArtifactStore.open({ journal });
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			binding: ownerBinding,
			artifacts,
		});
		const implementation = vi.fn<EchoExecute>(async ({ parameters }) => ({
			answer: parameters.value,
		}));
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: ownerBinding,
			finalizer,
			concurrency: 2,
			artifacts,
			supportTasks: echoRegistry(implementation),
		});

		const drives = [scheduler.drive(), scheduler.drive()];
		while (wait.mock.calls.length < 2) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		expect(implementation).toHaveBeenCalledOnce();
		expect(
			(await projection(journal)).tasks[tasks[0]?.ref.taskId ?? ""]?.status,
		).toBe("completed");
		await expect(scheduler.stop("operator stop")).resolves.toMatchObject({
			state: "terminal",
			runStatus: "cancelled",
		});
		await Promise.allSettled(drives);
		expect(interrupt).toHaveBeenCalledTimes(2);
		expect(release).toHaveBeenCalledTimes(2);
		expect(implementation).toHaveBeenCalledOnce();
		const state = await projection(journal);
		expect(state.status).toBe("cancelled");
		expect(state.tasks[tasks[0]?.ref.taskId ?? ""]?.status).toBe("completed");
		expect(state.tasks[tasks[1]?.ref.taskId ?? ""]?.status).toBe("cancelled");
		expect(state.tasks[tasks[2]?.ref.taskId ?? ""]?.status).toBe("cancelled");
		expect(
			state.executions[
				state.tasks[tasks[0]?.ref.taskId ?? ""]?.currentExecutionId ?? ""
			]?.terminal,
		).toMatchObject({ outcome: "completed", evidence: { kind: "support" } });
	}, 15_000);

	it("admits an agent task against the budget while a support task is running", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.support("prepare", echo({ parameters: { value: "x" } })),
			materializer.agent("answer", {
				...request(),
				limits: { ...request().limits, cost: 0.4 },
			}),
		]);
		const invoked = deferred<void>();
		const release = deferred<{ answer: string }>();
		const implementation = vi.fn<EchoExecute>(() => {
			invoked.resolve();
			return release.promise;
		});
		const childResult = deferred<ReturnType<typeof executionResult>>();
		const wait = vi.fn(() => childResult.promise);
		const harness = concurrentClient("budgeted", wait);
		vi.mocked(harness.ownerClient.release).mockImplementation(
			async (runId: string) => ({
				runId,
				attemptId: "attempt_budgeted0",
				status: "completed" as const,
			}),
		);
		const ownerBinding = binding(harness.ownerClient);
		const artifacts = await WorkflowArtifactStore.open({ journal });
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			binding: ownerBinding,
			artifacts,
		});
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: ownerBinding,
			finalizer,
			concurrency: 2,
			budget: { cost: 0.5, childRuntimeMs: 300_000 },
			artifacts,
			supportTasks: echoRegistry(implementation),
		});

		const first = scheduler.drive();
		await invoked.promise;
		const second = scheduler.drive();
		await vi.waitFor(() => expect(harness.launch).toHaveBeenCalledOnce());
		expect(
			(await projection(journal)).tasks[tasks[0]?.ref.taskId ?? ""]?.status,
		).toBe("running");

		childResult.resolve(
			executionResult({ ...result("completed"), runId: "run_budgeted0" }),
		);
		await expect(second).resolves.toMatchObject({ state: "idle" });
		release.resolve({ answer: "done" });
		await expect(first).resolves.toMatchObject({ state: "idle" });
		const state = await projection(journal);
		expect(state.tasks[tasks[0]?.ref.taskId ?? ""]?.status).toBe("completed");
		expect(state.tasks[tasks[1]?.ref.taskId ?? ""]?.status).toBe("completed");
		expect(
			statusChanges(await journal.readEvents(), "task-status-changed").some(
				(change) => change.to === "blocked",
			),
		).toBe(false);
		expect(
			statusChanges(await journal.readEvents(), "run-status-changed").some(
				(change) => change.to === "failed",
			),
		).toBe(false);
	});
});
