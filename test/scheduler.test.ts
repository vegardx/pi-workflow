import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
	type AgentLaunchPlan,
	canonicalSha256,
	HANDOFF_EXPORT_MEDIA_TYPE,
	type HandoffRef,
	RetryBackoffError,
	type RunResult,
	SUBAGENT_RUNTIME_CONTRACT,
	type SubagentClient,
	type SubagentPreflight,
	type SubagentRequest,
	type WorktreeRecord,
} from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import {
	canonicalArtifactJson,
	WorkflowArtifactStore,
} from "../src/artifact-store.js";
import { settledAgentUsage } from "../src/attempts.js";
import { CHECKPOINT_RUN_ENDING_REASON } from "../src/checkpoint-executor.js";
import type {
	NestedWorkflowTaskRequest,
	NestedWorkflowUsage,
	TaskRef,
	WorkflowArtifactRef,
	WorkflowBudget,
} from "../src/contracts.js";
import { WorkflowDecisionRecordStore } from "../src/decision-store.js";
import type { TaskHandle } from "../src/definition.js";
import {
	deriveJsonValueSha256,
	deriveNestedWorkflowRunId,
	deriveSubagentOperationId,
	deriveTaskExecutionId,
	deriveWorkflowArtifactId,
	deriveWorkflowFailureSha256,
} from "../src/execution.js";
import {
	type NestedWorkflowDeclaration,
	WorkflowTaskMaterializer,
} from "../src/materializer.js";
import {
	createWorkflowNestedRunExecutor,
	type WorkflowNestedRunProvider,
	type WorkflowNestedRunSettlement,
} from "../src/nested-run-executor.js";
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
			memoryBytes: requestValue.memoryBytes ?? 536_870_912,
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

function executionResult(runResult: RunResult, handoff?: WorktreeRecord) {
	return {
		result: runResult,
		output: "not persisted by workflow scheduler",
		sessionFile: "/private/session.jsonl",
		handoff,
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
		exportHandoff: unavailable,
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
		await vi.waitFor(
			() => expect(delegated.launch).toHaveBeenCalledOnce(),
			WAIT_FOR,
		);
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
	});

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
	});

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
	});

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
		exportHandoff: unexpected(),
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
describe("support task scheduling", () => {
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
		await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce(), WAIT_FOR);
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
	});

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
		await vi.waitFor(
			() => expect(harness.launch).toHaveBeenCalledOnce(),
			WAIT_FOR,
		);
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

const childDefinitionIdentitySha256 = "d".repeat(64);
const childDefinitionSourceSha256 = "e".repeat(64);
const childOutputSchema = {
	type: "object",
	properties: { answer: { type: "string" } },
	required: ["answer"],
	additionalProperties: false,
};
const childOutputSchemaSha256 = deriveJsonValueSha256(childOutputSchema);
const nesting = {
	depth: 0,
	ancestorDefinitionIdentities: [] as readonly string[],
	definitionIdentitySha256,
	deadlineAt: "2099-01-01T00:00:00.000Z",
};
const nestedUsage: NestedWorkflowUsage = {
	cost: 0.05,
	totalTokens: 500,
	childRuntimeMs: 1_000,
};

function nested(
	overrides: {
		disposition?: "required" | "optional";
		after?: readonly TaskRef[];
		budget?: WorkflowBudget;
	} = {},
): NestedWorkflowDeclaration {
	const input = { value: "yes" };
	const request: NestedWorkflowTaskRequest = {
		definitionName: "child",
		definitionIdentitySha256: childDefinitionIdentitySha256,
		definitionSourceSha256: childDefinitionSourceSha256,
		definitionVersion: 1,
		input,
		inputSha256: deriveJsonValueSha256(input),
		inputSchema: {
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
			additionalProperties: false,
		},
		outputSchema: childOutputSchema,
		budget: overrides.budget ?? { cost: 0.3, childRuntimeMs: 60_000 },
		timeoutMs: 600_000,
		concurrency: 2,
	};
	return {
		...(overrides.disposition ? { disposition: overrides.disposition } : {}),
		...(overrides.after ? { after: overrides.after } : {}),
		request,
	};
}

function childRunIdOf(taskId: string) {
	return deriveNestedWorkflowRunId("workflow_scheduler", taskId, 1);
}

function childOutput(childRunId: string, value: unknown) {
	const content = canonicalArtifactJson(value);
	const sha256 = createHash("sha256").update(content).digest("hex");
	const artifact: WorkflowArtifactRef = {
		id: deriveWorkflowArtifactId({
			runId: childRunId,
			schemaSha256: childOutputSchemaSha256,
			sha256,
		}),
		runId: childRunId,
		sha256,
		bytes: content.byteLength,
		mediaType: "application/json",
		schemaSha256: childOutputSchemaSha256,
	};
	return { artifact, value };
}

type FakeNestedProvider = {
	readonly [K in keyof WorkflowNestedRunProvider]: Mock<
		WorkflowNestedRunProvider[K]
	>;
};

/**
 * In-memory nested run provider: `completed` fabricates a child-owned output
 * artifact that `readOutput` serves back, `ended` builds any other terminal
 * settlement. Every method is a mock the test may reprogram.
 */
function nestedProvider() {
	const outputs = new Map<string, ReturnType<typeof childOutput>>();
	const completed = (
		childRunId: string,
		overrides: {
			value?: unknown;
			usage?: Partial<NestedWorkflowUsage>;
			usageComplete?: boolean;
		} = {},
	): WorkflowNestedRunSettlement => {
		const output = childOutput(
			childRunId,
			overrides.value ?? { answer: "yes" },
		);
		outputs.set(output.artifact.id, output);
		return {
			status: "completed",
			usage: { ...nestedUsage, ...overrides.usage },
			usageComplete: overrides.usageComplete ?? true,
			outputArtifact: output.artifact,
		};
	};
	const ended = (
		status: "failed" | "cancelled" | "interrupted" | "cleanup-blocked",
		usage: Partial<NestedWorkflowUsage> = {},
	): WorkflowNestedRunSettlement => ({
		status,
		usage: { ...nestedUsage, ...usage },
		usageComplete: true,
	});
	const provider: FakeNestedProvider = {
		launch: vi.fn<WorkflowNestedRunProvider["launch"]>(async () => undefined),
		wait: vi.fn<WorkflowNestedRunProvider["wait"]>(async (childRunId) =>
			completed(childRunId),
		),
		readOutput: vi.fn<WorkflowNestedRunProvider["readOutput"]>(
			async (_childRunId, artifactId) => {
				const output = outputs.get(artifactId);
				if (!output) throw new Error("unknown child artifact");
				return output;
			},
		),
		stop: vi.fn<WorkflowNestedRunProvider["stop"]>(async () => undefined),
		reconcile: vi.fn<WorkflowNestedRunProvider["reconcile"]>(
			async () => undefined,
		),
	};
	return { provider, completed, ended };
}

async function nestedScheduler(
	journal: WorkflowRunJournal,
	provider: WorkflowNestedRunProvider | undefined,
	options: {
		ownerClient?: SubagentClient;
		concurrency?: number;
		budget?: WorkflowBudget;
		finalize?: boolean;
	} = {},
) {
	const ownerClient = options.ownerClient ?? supportOnlyClient();
	const ownerBinding = binding(ownerClient);
	const artifacts = await WorkflowArtifactStore.open({ journal });
	const scheduler = createWorkflowSequentialScheduler({
		journal,
		binding: ownerBinding,
		...(options.finalize
			? {
					finalizer: createWorkflowTaskFinalizer({
						journal,
						artifacts,
						binding: ownerBinding,
					}),
				}
			: {}),
		...(options.concurrency ? { concurrency: options.concurrency } : {}),
		...(options.budget ? { budget: options.budget } : {}),
		artifacts,
		...(provider ? { nestedRuns: provider, nesting } : {}),
	});
	return { scheduler, artifacts, ownerClient };
}

/**
 * Persists a nested task as launched (`running`, phase nested-launched)
 * through the executor alone, the way a crashed process would have left it.
 */
async function seedLaunchedNestedTask(
	journal: WorkflowRunJournal,
	taskId: string,
	provider: WorkflowNestedRunProvider,
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
	const executor = createWorkflowNestedRunExecutor({
		journal,
		artifacts: await WorkflowArtifactStore.open({ journal }),
		provider,
		nesting,
	});
	await expect(executor.launch(taskId)).resolves.toMatchObject({
		state: "launched",
	});
	const seeded = await projection(journal);
	expect(seeded.tasks[taskId]?.status).toBe("running");
	expect(
		seeded.executions[seeded.tasks[taskId]?.currentExecutionId ?? ""]?.phase,
	).toBe("nested-launched");
}

function nestedExecutionOf(
	state: Awaited<ReturnType<typeof projection>>,
	taskId: string,
) {
	return state.executions[state.tasks[taskId]?.currentExecutionId ?? ""];
}

// vi.waitFor defaults to 1 s; under Ubuntu CI load (run 34819667769) the first
// drive's journal appends took longer than that before the provider mock was
// invoked, so these waits share the suite-wide bound from vitest.config.ts.
const WAIT_FOR = { timeout: 60_000, interval: 5 };

describe("nested workflow scheduling", () => {
	it("completes a nested-only graph through the provider without any subagent call", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.workflow("child", nested()),
		]);
		const taskId = tasks[0]?.ref.taskId ?? "";
		const { provider } = nestedProvider();
		const { scheduler, artifacts, ownerClient } = await nestedScheduler(
			journal,
			provider,
		);

		await expect(scheduler.drive()).resolves.toEqual({
			state: "idle",
			runStatus: "waiting",
		});
		expect(provider.launch).toHaveBeenCalledOnce();
		expect(provider.launch).toHaveBeenCalledWith({
			childRunId: childRunIdOf(taskId),
			parent: {
				runId: "workflow_scheduler",
				taskId,
				executionId: deriveTaskExecutionId("workflow_scheduler", taskId, 1),
				depth: 1,
				ancestorDefinitionIdentities: [definitionIdentitySha256],
			},
			definitionName: "child",
			definitionIdentitySha256: childDefinitionIdentitySha256,
			definitionSourceSha256: childDefinitionSourceSha256,
			input: { value: "yes" },
			inputArtifacts: {},
			budget: { cost: 0.3, childRuntimeMs: 60_000 },
			deadlineAt: expect.stringMatching(/^\d{4}-/),
			concurrency: 2,
		});
		expect(provider.wait).toHaveBeenCalledExactlyOnceWith(childRunIdOf(taskId));
		expect(provider.readOutput).toHaveBeenCalledOnce();
		expect(provider.stop).not.toHaveBeenCalled();
		expect(subagentCallCount(ownerClient)).toBe(0);
		const state = await projection(journal);
		expect(state.status).toBe("waiting");
		expect(state.tasks[taskId]?.status).toBe("completed");
		const results = Object.values(state.artifacts).filter(
			(artifact) =>
				artifact.producerTaskId === taskId && artifact.output === "result",
		);
		expect(results).toHaveLength(1);
		const artifact = results[0];
		if (!artifact) throw new Error("missing result artifact");
		expect(artifact.runId).toBe("workflow_scheduler");
		await expect(artifacts.readJson(artifact)).resolves.toEqual({
			answer: "yes",
		});
		expect(nestedExecutionOf(state, taskId)).toMatchObject({
			phase: "terminal",
			terminal: {
				outcome: "completed",
				evidence: {
					kind: "nested-workflow",
					childRunId: childRunIdOf(taskId),
					status: "completed",
					usage: nestedUsage,
					usageComplete: true,
					artifactId: artifact.id,
					outputSha256: artifact.sha256,
				},
			},
		});
	});

	it("defers a nested task while an active nested reservation consumes the budget", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.workflow(
				"first",
				nested({ budget: { cost: 0.4, childRuntimeMs: 60_000 } }),
			),
			materializer.workflow(
				"second",
				nested({ budget: { cost: 0.2, childRuntimeMs: 60_000 } }),
			),
		]);
		const firstId = tasks[0]?.ref.taskId ?? "";
		const secondId = tasks[1]?.ref.taskId ?? "";
		const { provider, completed } = nestedProvider();
		const waiting = deferred<WorkflowNestedRunSettlement>();
		provider.wait.mockImplementation(async (childRunId) =>
			childRunId === childRunIdOf(firstId)
				? waiting.promise
				: completed(childRunId),
		);
		const { scheduler } = await nestedScheduler(journal, provider, {
			concurrency: 2,
			budget: { cost: 0.5, childRuntimeMs: 600_000 },
		});

		const first = scheduler.drive();
		await vi.waitFor(
			() => expect(provider.wait).toHaveBeenCalledOnce(),
			WAIT_FOR,
		);
		await expect(scheduler.drive()).resolves.toMatchObject({ state: "idle" });
		expect(provider.launch).toHaveBeenCalledOnce();
		const deferredState = await projection(journal);
		expect(deferredState.tasks[firstId]?.status).toBe("running");
		expect(deferredState.tasks[secondId]?.status).toBe("ready");

		waiting.resolve(completed(childRunIdOf(firstId), { usage: { cost: 0.1 } }));
		await expect(first).resolves.toEqual({
			state: "idle",
			runStatus: "waiting",
		});
		expect(provider.launch).toHaveBeenCalledTimes(2);
		expect(
			provider.launch.mock.calls.map(([launch]) => launch.childRunId),
		).toEqual([childRunIdOf(firstId), childRunIdOf(secondId)]);
		const state = await projection(journal);
		expect(state.tasks[firstId]?.status).toBe("completed");
		expect(state.tasks[secondId]?.status).toBe("completed");
		expect(
			statusChanges(await journal.readEvents(), "task-status-changed").some(
				(change) => change.to === "blocked",
			),
		).toBe(false);
	});

	it("blocks a nested task whose declared budget exceeds the workflow budget", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.workflow(
				"child",
				nested({ budget: { cost: 0.6, childRuntimeMs: 60_000 } }),
			),
		]);
		const taskId = tasks[0]?.ref.taskId ?? "";
		const { provider } = nestedProvider();
		const { scheduler } = await nestedScheduler(journal, provider, {
			budget: { cost: 0.5, childRuntimeMs: 600_000 },
		});

		await expect(scheduler.drive()).resolves.toEqual({
			state: "terminal",
			runStatus: "failed",
		});
		expect(provider.launch).not.toHaveBeenCalled();
		const state = await projection(journal);
		expect(state.status).toBe("failed");
		expect(state.tasks[taskId]?.status).toBe("blocked");
		expect(state.tasks[taskId]?.currentExecutionId).toBeUndefined();
		const events = await journal.readEvents();
		expect(statusChanges(events, "task-status-changed").at(-1)).toEqual({
			taskId,
			from: "ready",
			to: "blocked",
			reason: "Workflow cost budget is exhausted.",
		});
		expect(statusChanges(events, "run-status-changed").at(-1)).toEqual({
			from: "running",
			to: "failed",
			reason: "Workflow cost budget is exhausted.",
		});
	});

	it("counts settled nested usage against a later agent task's maxima", async () => {
		const { journal, tasks } = await fixture((materializer) => {
			const child = materializer.workflow("child", nested());
			const answer = materializer.agent("answer", {
				...request({ after: [child.ref] }),
				limits: { ...request().limits, cost: 0.2 },
			});
			return [child, answer];
		});
		const childId = tasks[0]?.ref.taskId ?? "";
		const answerId = tasks[1]?.ref.taskId ?? "";
		const { provider, completed } = nestedProvider();
		provider.wait.mockImplementation(async (childRunId) =>
			completed(childRunId, { usage: { cost: 0.4 } }),
		);
		const ownerClient = client();
		const { scheduler } = await nestedScheduler(journal, provider, {
			ownerClient,
			budget: { cost: 0.5, childRuntimeMs: 600_000 },
		});

		await expect(scheduler.drive()).resolves.toEqual({
			state: "terminal",
			runStatus: "failed",
		});
		expect(ownerClient.preflight).not.toHaveBeenCalled();
		expect(ownerClient.launch).not.toHaveBeenCalled();
		const state = await projection(journal);
		expect(state.status).toBe("failed");
		expect(state.tasks[childId]?.status).toBe("completed");
		expect(state.tasks[answerId]?.status).toBe("blocked");
		expect(
			statusChanges(await journal.readEvents(), "run-status-changed").at(-1),
		).toEqual({
			from: "running",
			to: "failed",
			reason: "Workflow cost budget is exhausted.",
		});
	});

	it("fails the run after finalization when nested usage evidence is incomplete", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.workflow("child", nested()),
			materializer.agent("answer", {
				...request(),
				limits: { ...request().limits, cost: 0.1 },
			}),
		]);
		const childId = tasks[0]?.ref.taskId ?? "";
		const answerId = tasks[1]?.ref.taskId ?? "";
		const { provider, completed } = nestedProvider();
		const childSettled = deferred<WorkflowNestedRunSettlement>();
		provider.wait.mockImplementation(() => childSettled.promise);
		const agentResult = deferred<ReturnType<typeof executionResult>>();
		const ownerClient = client({
			wait: vi.fn(() => agentResult.promise),
			release: vi.fn(async () => ({
				runId: "run_scheduler",
				attemptId: "attempt_scheduler",
				status: "completed" as const,
			})),
		});
		const { scheduler } = await nestedScheduler(journal, provider, {
			ownerClient,
			concurrency: 2,
			budget: { cost: 0.5, childRuntimeMs: 600_000 },
			finalize: true,
		});

		const first = scheduler.drive();
		await vi.waitFor(
			() => expect(provider.wait).toHaveBeenCalledOnce(),
			WAIT_FOR,
		);
		const second = scheduler.drive();
		await vi.waitFor(
			() => expect(ownerClient.wait).toHaveBeenCalledOnce(),
			WAIT_FOR,
		);
		childSettled.resolve(
			completed(childRunIdOf(childId), { usageComplete: false }),
		);
		await expect(first).resolves.toEqual({
			state: "idle",
			runStatus: "waiting",
		});
		expect((await projection(journal)).tasks[childId]?.status).toBe(
			"completed",
		);

		agentResult.resolve(executionResult(result("completed")));
		await expect(second).resolves.toEqual({
			state: "terminal",
			runStatus: "failed",
		});
		const state = await projection(journal);
		expect(state.status).toBe("failed");
		expect(state.tasks[answerId]?.status).toBe("completed");
		expect(nestedExecutionOf(state, childId)?.nestedSettlement).toMatchObject({
			usageComplete: false,
		});
		expect(
			statusChanges(await journal.readEvents(), "run-status-changed").at(-1),
		).toEqual({
			from: "waiting",
			to: "failed",
			reason: "Nested workflow usage evidence is incomplete.",
		});
	});

	it("keeps an agent task out of the lane a running nested task occupies", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.workflow("child", nested()),
			materializer.agent("answer", request()),
		]);
		const childId = tasks[0]?.ref.taskId ?? "";
		const answerId = tasks[1]?.ref.taskId ?? "";
		const { provider, completed } = nestedProvider();
		const waiting = deferred<WorkflowNestedRunSettlement>();
		provider.wait.mockImplementation(() => waiting.promise);
		const ownerClient = client();
		const { scheduler } = await nestedScheduler(journal, provider, {
			ownerClient,
			concurrency: 1,
		});

		const first = scheduler.drive();
		await vi.waitFor(
			() => expect(provider.wait).toHaveBeenCalledOnce(),
			WAIT_FOR,
		);
		expect((await projection(journal)).tasks[childId]?.status).toBe("running");
		await expect(scheduler.drive()).resolves.toMatchObject({ state: "idle" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(ownerClient.preflight).not.toHaveBeenCalled();
		expect(ownerClient.launch).not.toHaveBeenCalled();
		expect((await projection(journal)).tasks[answerId]?.status).toBe("pending");

		waiting.resolve(completed(childRunIdOf(childId)));
		await expect(first).resolves.toMatchObject({
			state: "awaiting-finalization",
			outcome: "completed",
		});
		expect(ownerClient.preflight).toHaveBeenCalledOnce();
		expect(ownerClient.launch).toHaveBeenCalledOnce();
		const state = await projection(journal);
		expect(state.tasks[childId]?.status).toBe("completed");
		expect(state.tasks[answerId]?.status).toBe("running");
	});

	it("blocks a required nested task and fails the run without a provider", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.workflow("child", nested()),
		]);
		const taskId = tasks[0]?.ref.taskId ?? "";
		const { scheduler, ownerClient } = await nestedScheduler(
			journal,
			undefined,
		);

		await expect(scheduler.drive()).resolves.toEqual({
			state: "terminal",
			runStatus: "failed",
		});
		const message =
			"Nested workflow execution is not configured for this workflow run.";
		const state = await projection(journal);
		expect(state.status).toBe("failed");
		expect(state.tasks[taskId]?.status).toBe("blocked");
		expect(state.tasks[taskId]?.currentExecutionId).toBeUndefined();
		const events = await journal.readEvents();
		expect(statusChanges(events, "task-status-changed").at(-1)).toEqual({
			taskId,
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

	it("blocks an optional nested task and proceeds without a provider", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.workflow("child", nested({ disposition: "optional" })),
		]);
		const taskId = tasks[0]?.ref.taskId ?? "";
		const { scheduler } = await nestedScheduler(journal, undefined);

		await expect(scheduler.drive()).resolves.toEqual({
			state: "idle",
			runStatus: "waiting",
		});
		const state = await projection(journal);
		expect(state.status).toBe("waiting");
		expect(state.tasks[taskId]?.status).toBe("blocked");
		expect(
			statusChanges(await journal.readEvents(), "task-status-changed").at(-1),
		).toMatchObject({
			to: "blocked",
			reason:
				"Nested workflow execution is not configured for this workflow run.",
		});
	});

	it("fails the run when a required nested run fails", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.workflow("child", nested()),
		]);
		const taskId = tasks[0]?.ref.taskId ?? "";
		const { provider, ended } = nestedProvider();
		provider.wait.mockResolvedValue(ended("failed"));
		const { scheduler, ownerClient } = await nestedScheduler(journal, provider);

		await expect(scheduler.drive()).resolves.toEqual({
			state: "terminal",
			runStatus: "failed",
		});
		expect(provider.readOutput).not.toHaveBeenCalled();
		const state = await projection(journal);
		expect(state.status).toBe("failed");
		expect(state.tasks[taskId]?.status).toBe("failed");
		expect(nestedExecutionOf(state, taskId)).toMatchObject({
			phase: "terminal",
			terminal: {
				outcome: "failed",
				evidence: {
					kind: "nested-workflow",
					childRunId: childRunIdOf(taskId),
					status: "failed",
				},
			},
		});
		expect(
			statusChanges(await journal.readEvents(), "run-status-changed").at(-1),
		).toEqual({
			from: "running",
			to: "failed",
			reason: "A required workflow task did not complete.",
		});
		expect(subagentCallCount(ownerClient)).toBe(0);
	});

	it("keeps the run alive after an optional nested failure and blocks dependents", async () => {
		const { journal, tasks } = await fixture((materializer) => {
			const child = materializer.workflow(
				"child",
				nested({ disposition: "optional" }),
			);
			const dependent = materializer.agent(
				"answer",
				request({ after: [child.ref] }),
			);
			return [child, dependent];
		});
		const childId = tasks[0]?.ref.taskId ?? "";
		const answerId = tasks[1]?.ref.taskId ?? "";
		const { provider, ended } = nestedProvider();
		provider.wait.mockResolvedValue(ended("failed"));
		const { scheduler, ownerClient } = await nestedScheduler(journal, provider);

		await expect(driveToRest(scheduler)).resolves.toEqual({
			state: "idle",
			runStatus: "waiting",
		});
		const state = await projection(journal);
		expect(state.status).toBe("waiting");
		expect(state.tasks[childId]?.status).toBe("failed");
		expect(state.tasks[answerId]?.status).toBe("blocked");
		expect(
			statusChanges(await journal.readEvents(), "run-status-changed").some(
				(change) => change.to === "failed",
			),
		).toBe(false);
		expect(subagentCallCount(ownerClient)).toBe(0);
	});

	it("interrupts the run when a required nested run is interrupted", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.workflow("child", nested()),
		]);
		const taskId = tasks[0]?.ref.taskId ?? "";
		const { provider, ended } = nestedProvider();
		provider.wait.mockResolvedValue(ended("interrupted"));
		const { scheduler } = await nestedScheduler(journal, provider);

		await expect(scheduler.drive()).resolves.toEqual({
			state: "terminal",
			runStatus: "interrupted",
		});
		const state = await projection(journal);
		expect(state.status).toBe("interrupted");
		expect(state.tasks[taskId]?.status).toBe("interrupted");
		expect(nestedExecutionOf(state, taskId)?.terminal).toMatchObject({
			outcome: "interrupted",
			evidence: { kind: "nested-workflow", status: "interrupted" },
		});
		expect(
			statusChanges(await journal.readEvents(), "run-status-changed").at(-1),
		).toEqual({
			from: "running",
			to: "interrupted",
			reason: "A required workflow task was interrupted.",
		});
	});

	it("reconciles a cleanup-blocked nested run back into a completed task", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.workflow("child", nested()),
		]);
		const taskId = tasks[0]?.ref.taskId ?? "";
		const { provider, completed, ended } = nestedProvider();
		provider.wait
			.mockResolvedValueOnce(ended("cleanup-blocked"))
			.mockImplementation(async (childRunId) => completed(childRunId));
		const { scheduler, artifacts } = await nestedScheduler(journal, provider);

		await expect(scheduler.drive()).resolves.toEqual({
			state: "terminal",
			runStatus: "cleanup-blocked",
		});
		const blocked = await projection(journal);
		expect(blocked.status).toBe("cleanup-blocked");
		expect(blocked.tasks[taskId]?.status).toBe("cleanup-blocked");
		expect(nestedExecutionOf(blocked, taskId)).toMatchObject({
			phase: "terminal",
			nestedSettlement: { status: "cleanup-blocked" },
			terminal: {
				outcome: "cleanup-blocked",
				evidence: { kind: "nested-workflow", status: "cleanup-blocked" },
			},
		});
		expect(provider.reconcile).not.toHaveBeenCalled();

		await expect(scheduler.reconcile(taskId)).resolves.toEqual({
			state: "idle",
			runStatus: "running",
		});
		expect(provider.reconcile).toHaveBeenCalledExactlyOnceWith(
			childRunIdOf(taskId),
		);
		expect(provider.wait).toHaveBeenCalledTimes(2);
		const recovered = await projection(journal);
		expect(recovered.status).toBe("running");
		expect(recovered.tasks[taskId]?.status).toBe("completed");
		expect(nestedExecutionOf(recovered, taskId)).toMatchObject({
			phase: "terminal",
			nestedSettlement: { status: "completed" },
			terminal: {
				outcome: "completed",
				evidence: { kind: "nested-workflow", status: "completed" },
			},
		});
		const results = Object.values(recovered.artifacts).filter(
			(artifact) =>
				artifact.producerTaskId === taskId && artifact.output === "result",
		);
		expect(results).toHaveLength(1);
		const artifact = results[0];
		if (!artifact) throw new Error("missing result artifact");
		await expect(artifacts.readJson(artifact)).resolves.toEqual({
			answer: "yes",
		});
		await expect(scheduler.drive()).resolves.toEqual({
			state: "idle",
			runStatus: "waiting",
		});
		expect(provider.launch).toHaveBeenCalledOnce();
	});

	it("stops an in-flight nested run and drains its cancellation evidence", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.workflow("child", nested()),
		]);
		const taskId = tasks[0]?.ref.taskId ?? "";
		const { provider, ended } = nestedProvider();
		const waiting = deferred<WorkflowNestedRunSettlement>();
		provider.wait.mockImplementation(() => waiting.promise);
		const { scheduler, ownerClient } = await nestedScheduler(journal, provider);

		const drive = scheduler.drive();
		await vi.waitFor(
			() => expect(provider.wait).toHaveBeenCalledOnce(),
			WAIT_FOR,
		);
		expect(scheduler.stopSignal.aborted).toBe(false);
		const stop = scheduler.stop("operator stop");
		await vi.waitFor(
			() => expect(provider.stop).toHaveBeenCalledOnce(),
			WAIT_FOR,
		);
		expect(provider.stop).toHaveBeenCalledWith(
			childRunIdOf(taskId),
			"operator stop",
		);
		expect(scheduler.stopSignal.aborted).toBe(true);
		const stopping = await projection(journal);
		expect(stopping.status).toBe("stopping");
		expect(stopping.tasks[taskId]?.status).toBe("cancelling");

		waiting.resolve(ended("cancelled"));
		await expect(stop).resolves.toEqual({
			state: "terminal",
			runStatus: "cancelled",
		});
		await Promise.allSettled([drive]);
		await expect(drive).resolves.toEqual({
			state: "terminal",
			runStatus: "cancelled",
		});
		expect(provider.wait).toHaveBeenCalledOnce();
		const state = await projection(journal);
		expect(state.status).toBe("cancelled");
		expect(state.tasks[taskId]?.status).toBe("cancelled");
		expect(nestedExecutionOf(state, taskId)).toMatchObject({
			phase: "terminal",
			terminal: {
				outcome: "cancelled",
				evidence: {
					kind: "nested-workflow",
					childRunId: childRunIdOf(taskId),
					status: "cancelled",
				},
			},
		});
		expect(
			statusChanges(await journal.readEvents(), "run-status-changed").map(
				(change) => change.to,
			),
		).toEqual(["running", "stopping", "cancelled"]);
		expect(subagentCallCount(ownerClient)).toBe(0);
	});

	it("stops a launched nested run that no process is waiting on", async () => {
		const fx = await fixture((materializer) => [
			materializer.workflow("child", nested()),
		]);
		const taskId = fx.tasks[0]?.ref.taskId ?? "";
		const seed = nestedProvider();
		await seedLaunchedNestedTask(fx.journal, taskId, seed.provider);
		expect(seed.provider.launch).toHaveBeenCalledOnce();

		const resumed = await rotateLease(fx);
		const { provider, ended } = nestedProvider();
		const waiting = deferred<WorkflowNestedRunSettlement>();
		provider.wait.mockImplementation(() => waiting.promise);
		provider.stop.mockImplementation(async () => {
			waiting.resolve(ended("cancelled"));
		});
		const { scheduler, ownerClient } = await nestedScheduler(
			resumed.journal,
			provider,
		);

		await expect(scheduler.stop("operator stop")).resolves.toEqual({
			state: "terminal",
			runStatus: "cancelled",
		});
		expect(provider.launch).not.toHaveBeenCalled();
		expect(provider.stop).toHaveBeenCalledExactlyOnceWith(
			childRunIdOf(taskId),
			"operator stop",
		);
		expect(provider.wait).toHaveBeenCalledExactlyOnceWith(childRunIdOf(taskId));
		const state = await projection(resumed.journal);
		expect(state.status).toBe("cancelled");
		expect(state.tasks[taskId]?.status).toBe("cancelled");
		expect(nestedExecutionOf(state, taskId)).toMatchObject({
			phase: "terminal",
			terminal: {
				outcome: "cancelled",
				evidence: { kind: "nested-workflow", status: "cancelled" },
			},
		});
		expect(
			Object.values(state.executions).filter(
				(execution) => execution.execution.taskId === taskId,
			),
		).toHaveLength(1);
		expect(subagentCallCount(ownerClient)).toBe(0);
	});

	it("resumes a launched nested run after lease rotation without relaunching", async () => {
		const fx = await fixture((materializer) => [
			materializer.workflow("child", nested()),
		]);
		const taskId = fx.tasks[0]?.ref.taskId ?? "";
		const seed = nestedProvider();
		await seedLaunchedNestedTask(fx.journal, taskId, seed.provider);

		const resumed = await rotateLease(fx);
		const { provider } = nestedProvider();
		const { scheduler, ownerClient } = await nestedScheduler(
			resumed.journal,
			provider,
		);

		await expect(scheduler.drive()).resolves.toEqual({
			state: "idle",
			runStatus: "waiting",
		});
		expect(provider.launch).not.toHaveBeenCalled();
		expect(provider.wait).toHaveBeenCalledExactlyOnceWith(childRunIdOf(taskId));
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

	it("re-waits a launched nested run after restart under a tight budget", async () => {
		const fx = await fixture((materializer) => [
			materializer.workflow(
				"child",
				nested({ budget: { cost: 0.4, childRuntimeMs: 60_000 } }),
			),
		]);
		const taskId = fx.tasks[0]?.ref.taskId ?? "";
		const seed = nestedProvider();
		await seedLaunchedNestedTask(fx.journal, taskId, seed.provider);

		const resumed = await rotateLease(fx);
		const { provider } = nestedProvider();
		const { scheduler } = await nestedScheduler(resumed.journal, provider, {
			budget: { cost: 0.5, childRuntimeMs: 600_000 },
		});

		await expect(scheduler.drive()).resolves.toEqual({
			state: "idle",
			runStatus: "waiting",
		});
		expect(provider.launch).not.toHaveBeenCalled();
		expect(provider.wait).toHaveBeenCalledExactlyOnceWith(childRunIdOf(taskId));
		expect((await projection(resumed.journal)).tasks[taskId]?.status).toBe(
			"completed",
		);
	});

	it("stops and releases active children unchanged beside a completed nested task", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.workflow("child", nested()),
			materializer.agent("first", request()),
			materializer.agent("second", request()),
		]);
		const childId = tasks[0]?.ref.taskId ?? "";
		const pending = [
			deferred<ReturnType<typeof executionResult>>(),
			deferred<ReturnType<typeof executionResult>>(),
		];
		const wait = vi.fn((runId: string) => {
			const value = pending[Number(runId.at(-1))];
			if (!value) throw new Error("unexpected child");
			return value.promise;
		});
		const harness = concurrentClient("nestedstop", wait);
		const interrupt = vi.fn(async (runId: string) => {
			const index = Number(runId.at(-1));
			pending[index]?.resolve(
				executionResult({ ...result("cancelled"), runId }),
			);
			return {
				runId,
				attemptId: `attempt_nestedstop${index}`,
				status: "stopping" as const,
			};
		});
		const release = vi.fn(async (runId: string) => ({
			runId,
			attemptId: `attempt_nestedstop${Number(runId.at(-1))}`,
			status: "cancelled" as const,
		}));
		const ownerClient = harness.ownerClient;
		vi.mocked(ownerClient.interrupt).mockImplementation(interrupt);
		vi.mocked(ownerClient.release).mockImplementation(release);
		const { provider } = nestedProvider();
		const { scheduler } = await nestedScheduler(journal, provider, {
			ownerClient,
			concurrency: 2,
			finalize: true,
		});

		const drives = [scheduler.drive(), scheduler.drive()];
		while (wait.mock.calls.length < 2) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		expect(provider.launch).toHaveBeenCalledOnce();
		expect((await projection(journal)).tasks[childId]?.status).toBe(
			"completed",
		);
		await expect(scheduler.stop("operator stop")).resolves.toMatchObject({
			state: "terminal",
			runStatus: "cancelled",
		});
		await Promise.allSettled(drives);
		expect(interrupt).toHaveBeenCalledTimes(2);
		expect(release).toHaveBeenCalledTimes(2);
		expect(provider.stop).not.toHaveBeenCalled();
		expect(provider.wait).toHaveBeenCalledOnce();
		const state = await projection(journal);
		expect(state.status).toBe("cancelled");
		expect(state.tasks[childId]?.status).toBe("completed");
		expect(state.tasks[tasks[1]?.ref.taskId ?? ""]?.status).toBe("cancelled");
		expect(state.tasks[tasks[2]?.ref.taskId ?? ""]?.status).toBe("cancelled");
		expect(nestedExecutionOf(state, childId)?.terminal).toMatchObject({
			outcome: "completed",
			evidence: { kind: "nested-workflow", status: "completed" },
		});
	});
});

describe("retry attempts", () => {
	it("retries a backoff-classified failure under the same execution and completes", async () => {
		const base = request();
		const { journal, tasks } = await fixture((materializer) => [
			materializer.agent("answer", {
				...base,
				retry: { attempts: 1 },
				limits: { ...base.limits, retries: 1 },
			}),
		]);
		const taskId = tasks[0]?.ref.taskId ?? "";
		const failedResult = result("failed");
		const transient: RunResult = {
			...failedResult,
			failure: {
				...(failedResult.failure ?? {
					code: "tool",
					origin: "tool",
					message: "tool failed",
					guidance: "Inspect the result.",
				}),
				retry: "backoff",
			},
		};
		let waits = 0;
		const ownerClient = client({
			wait: vi.fn(async () => {
				waits += 1;
				return executionResult(waits === 1 ? transient : result("completed"));
			}),
			retry: vi.fn(async () => ({
				runId: "run_scheduler",
				attemptId: "attempt_scheduler2",
				status: "active" as const,
			})),
			release: vi.fn(async () => ({
				runId: "run_scheduler",
				attemptId: "attempt_scheduler2",
				status: "completed" as const,
			})),
		});
		const artifacts = await WorkflowArtifactStore.open({ journal });
		const ownerBinding = binding(ownerClient);
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: ownerBinding,
			artifacts,
			finalizer: createWorkflowTaskFinalizer({
				journal,
				artifacts,
				binding: ownerBinding,
			}),
		});
		await driveToRest(scheduler);
		const state = await projection(journal);
		const task = state.tasks[taskId];
		expect(task?.status).toBe("completed");
		const execution = state.executions[task?.currentExecutionId ?? ""];
		expect(execution?.attempts).toMatchObject([
			{
				kind: "retry",
				ordinal: 2,
				previousAttemptId: "attempt_scheduler",
				subagentAttemptId: "attempt_scheduler2",
			},
		]);
		expect(execution?.priorSettlements).toHaveLength(1);
		expect(execution?.priorSettlements?.[0]?.evidence).toMatchObject({
			status: "failed",
			attemptOrdinal: 1,
		});
		expect(execution?.settlement?.evidence).toMatchObject({
			status: "completed",
			attemptOrdinal: 2,
		});
		expect(execution?.terminal?.evidence).toMatchObject({
			kind: "subagent",
			attemptOrdinal: 2,
		});
		expect(ownerClient.retry).toHaveBeenCalledWith("run_scheduler");
		expect(ownerClient.launch).toHaveBeenCalledTimes(1);
		expect((await journal.readEvents()).map((event) => event.type)).toContain(
			"task-execution-attempt-receipted",
		);
	});

	function transient(retry: "backoff" | "manual" = "backoff"): RunResult {
		const failed = result("failed");
		if (!failed.failure) throw new Error("failed result lacks a failure");
		return { ...failed, failure: { ...failed.failure, retry } };
	}

	function retryRequest(
		attempts = 1,
		overrides: Parameters<typeof request>[0] = {},
	) {
		const base = request(overrides);
		return {
			...base,
			retry: { attempts },
			limits: { ...base.limits, retries: attempts },
		};
	}

	function budgeted<T extends { limits: { cost: number } }>(value: T): T {
		return { ...value, limits: { ...value.limits, cost: 0.01 } };
	}

	function attemptReceipt<S extends string>(status: S) {
		return { runId: "run_scheduler", attemptId: "attempt_scheduler2", status };
	}

	async function retryScheduler(
		journal: WorkflowRunJournal,
		ownerClient: SubagentClient,
		options: { budget?: WorkflowBudget } = {},
	) {
		const artifacts = await WorkflowArtifactStore.open({ journal });
		const ownerBinding = binding(ownerClient);
		return createWorkflowSequentialScheduler({
			journal,
			binding: ownerBinding,
			artifacts,
			finalizer: createWorkflowTaskFinalizer({
				journal,
				artifacts,
				binding: ownerBinding,
			}),
			...(options.budget ? { budget: options.budget } : {}),
		});
	}

	async function executionOf(journal: WorkflowRunJournal, taskId: string) {
		const state = await projection(journal);
		const task = state.tasks[taskId];
		const execution = state.executions[task?.currentExecutionId ?? ""];
		if (!task || !execution) throw new Error("missing task execution");
		return { state, task, execution };
	}

	async function attemptEventCounts(journal: WorkflowRunJournal) {
		const types = (await journal.readEvents()).map((event) => event.type);
		return {
			intended: types.filter((t) => t === "task-execution-attempt-intended")
				.length,
			receipted: types.filter((t) => t === "task-execution-attempt-receipted")
				.length,
			declined: types.filter((t) => t === "task-execution-attempt-declined")
				.length,
		};
	}

	it("fails the task and run when the retried attempt exhausts the policy", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.agent("answer", retryRequest(1)),
		]);
		const taskId = tasks[0]?.ref.taskId ?? "";
		const ownerClient = client({
			wait: vi.fn(async () => executionResult(transient())),
			retry: vi.fn(async () => attemptReceipt("active" as const)),
			release: vi.fn(async () => attemptReceipt("failed" as const)),
		});
		const scheduler = await retryScheduler(journal, ownerClient);
		await expect(driveToRest(scheduler)).resolves.toEqual({
			state: "terminal",
			runStatus: "failed",
		});
		const { state, task, execution } = await executionOf(journal, taskId);
		expect(task.status).toBe("failed");
		expect(state.status).toBe("failed");
		expect(execution.phase).toBe("terminal");
		expect(execution.terminal).toMatchObject({
			outcome: "failed",
			evidence: { kind: "subagent", status: "failed", attemptOrdinal: 2 },
		});
		expect(execution.priorSettlements).toHaveLength(1);
		expect(execution.priorSettlements?.[0]?.evidence.attemptOrdinal).toBe(1);
		expect(execution.settlement?.evidence.attemptOrdinal).toBe(2);
		expect(execution.attempts).toHaveLength(1);
		expect(execution.attemptsClosed).toBeUndefined();
		const usage = settledAgentUsage(execution);
		expect(usage.cost).toBeCloseTo(0.02, 10);
		expect(usage.totalTokens).toBe(30);
		expect(usage.runtimeMs).toBe(2000);
		expect(usage.usageComplete).toBe(true);
		expect(ownerClient.wait).toHaveBeenCalledTimes(2);
		expect(ownerClient.retry).toHaveBeenCalledTimes(1);
		expect(ownerClient.launch).toHaveBeenCalledTimes(1);
		expect(ownerClient.release).toHaveBeenCalledWith("run_scheduler");
		await expect(attemptEventCounts(journal)).resolves.toEqual({
			intended: 1,
			receipted: 1,
			declined: 0,
		});
	});

	it("counts every attempt's settled usage when admitting the next task", async () => {
		// Admission adds the candidate's declared maximum to all settled usage.
		// Both attempts of the first task settled 0.01 each (0.02 <= 0.025, so
		// the run itself is within budget), and the second task's 0.01 maximum
		// pushes the sum to 0.03 > 0.025 with nothing reserved, which is the
		// non-deferred "exhausted" branch: the task is blocked and, being
		// required, the run fails.
		const { journal, tasks } = await fixture((materializer) => [
			materializer.agent("first", budgeted(retryRequest(1))),
			materializer.agent("second", budgeted(request())),
		]);
		const [firstId, secondId] = tasks.map((task) => task.ref.taskId);
		let waits = 0;
		const ownerClient = client({
			wait: vi.fn(async () => {
				waits += 1;
				return executionResult(waits === 1 ? transient() : result("completed"));
			}),
			retry: vi.fn(async () => attemptReceipt("active" as const)),
			release: vi.fn(async () => attemptReceipt("completed" as const)),
		});
		const scheduler = await retryScheduler(journal, ownerClient, {
			budget: { cost: 0.025, childRuntimeMs: 600_000 },
		});
		await expect(driveToRest(scheduler)).resolves.toEqual({
			state: "terminal",
			runStatus: "failed",
		});
		const state = await projection(journal);
		expect(state.tasks[firstId ?? ""]?.status).toBe("completed");
		expect(state.tasks[secondId ?? ""]?.status).toBe("blocked");
		expect(state.status).toBe("failed");
		const changes = statusChanges(
			await journal.readEvents(),
			"task-status-changed",
		);
		expect(changes.at(-1)).toMatchObject({
			to: "blocked",
			reason: "Workflow cost budget is exhausted.",
		});
		expect(
			statusChanges(await journal.readEvents(), "run-status-changed").at(-1),
		).toMatchObject({
			to: "failed",
			reason: "Workflow cost budget is exhausted.",
		});
		expect(ownerClient.launch).toHaveBeenCalledTimes(1);
		expect(ownerClient.retry).toHaveBeenCalledTimes(1);
	});

	it("fails the run when both attempts' settled usage overshoot the budget", async () => {
		// With a 0.015 budget the second task is never admitted: settled usage
		// across both attempts (0.02) already exceeds the budget once the first
		// task finalizes, so the post-finalization budget check fails the run.
		const { journal, tasks } = await fixture((materializer) => [
			materializer.agent("first", budgeted(retryRequest(1))),
			materializer.agent("second", budgeted(request())),
		]);
		const [firstId, secondId] = tasks.map((task) => task.ref.taskId);
		let waits = 0;
		const ownerClient = client({
			wait: vi.fn(async () => {
				waits += 1;
				return executionResult(waits === 1 ? transient() : result("completed"));
			}),
			retry: vi.fn(async () => attemptReceipt("active" as const)),
			release: vi.fn(async () => attemptReceipt("completed" as const)),
		});
		const scheduler = await retryScheduler(journal, ownerClient, {
			budget: { cost: 0.015, childRuntimeMs: 600_000 },
		});
		await expect(driveToRest(scheduler)).resolves.toEqual({
			state: "terminal",
			runStatus: "failed",
		});
		const state = await projection(journal);
		expect(state.tasks[firstId ?? ""]?.status).toBe("completed");
		expect(state.tasks[secondId ?? ""]?.status).toBe("pending");
		expect(
			statusChanges(await journal.readEvents(), "run-status-changed").at(-1),
		).toMatchObject({
			to: "failed",
			reason: "Workflow cost budget was exceeded.",
		});
		expect(ownerClient.launch).toHaveBeenCalledTimes(1);
	});

	it("interrupts the retried attempt on stop and cancels the run", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.agent("answer", retryRequest(1)),
		]);
		const taskId = tasks[0]?.ref.taskId ?? "";
		const waiting = deferred<ReturnType<typeof executionResult>>();
		let waits = 0;
		const ownerClient = client({
			wait: vi.fn(() => {
				waits += 1;
				return waits === 1
					? Promise.resolve(executionResult(transient()))
					: waiting.promise;
			}),
			retry: vi.fn(async () => attemptReceipt("active" as const)),
			interrupt: vi.fn(async () => attemptReceipt("stopping" as const)),
			release: vi.fn(async () => attemptReceipt("cancelled" as const)),
		});
		const scheduler = await retryScheduler(journal, ownerClient);
		const drive = scheduler.drive();
		await vi.waitFor(
			() => expect(ownerClient.wait).toHaveBeenCalledTimes(2),
			WAIT_FOR,
		);
		expect((await executionOf(journal, taskId)).execution.phase).toBe(
			"launched",
		);
		const stop = scheduler.stop("operator stop");
		await vi.waitFor(
			() => expect(ownerClient.interrupt).toHaveBeenCalledOnce(),
			WAIT_FOR,
		);
		expect(ownerClient.interrupt).toHaveBeenCalledWith("run_scheduler");
		const stopping = await executionOf(journal, taskId);
		expect(stopping.state.status).toBe("stopping");
		expect(stopping.task.status).toBe("cancelling");
		await vi.waitFor(async () => {
			const { execution } = await executionOf(journal, taskId);
			expect(execution.observation).toMatchObject({
				subagentAttemptId: "attempt_scheduler2",
				status: "stopping",
			});
		}, WAIT_FOR);
		waiting.resolve(executionResult(result("cancelled")));
		await expect(stop).resolves.toEqual({
			state: "terminal",
			runStatus: "cancelled",
		});
		await expect(drive).resolves.toEqual({
			state: "terminal",
			runStatus: "cancelled",
		});
		const { state, task, execution } = await executionOf(journal, taskId);
		expect(task.status).toBe("cancelled");
		expect(state.status).toBe("cancelled");
		expect(execution.terminal).toMatchObject({
			outcome: "cancelled",
			evidence: { status: "cancelled", attemptOrdinal: 2 },
		});
		expect(execution.priorSettlements).toHaveLength(1);
		expect(ownerClient.release).toHaveBeenCalledTimes(1);
		expect(ownerClient.retry).toHaveBeenCalledTimes(1);
	});

	it("declines the pending attempt on stop while the retrier waits out backoff", async () => {
		// The stop signal aborts the retrier's backoff wait, so the open intent
		// is declined and the settled failure proceeds to finalization. The
		// task ends `failed` (its child really failed; nothing was interrupted)
		// and the run drains to `cancelled` because it was stopping when the
		// required task finalized.
		const { journal, tasks } = await fixture((materializer) => [
			materializer.agent("answer", retryRequest(1)),
		]);
		const taskId = tasks[0]?.ref.taskId ?? "";
		const ownerClient = client({
			wait: vi.fn(async () => executionResult(transient())),
			retry: vi.fn(async () => {
				throw new RetryBackoffError(
					new Date(Date.now() + 60 * 60 * 1000).toISOString(),
				);
			}),
			release: vi.fn(async () => ({
				runId: "run_scheduler",
				attemptId: "attempt_scheduler",
				status: "failed" as const,
			})),
		});
		const scheduler = await retryScheduler(journal, ownerClient);
		const drive = scheduler.drive();
		await vi.waitFor(
			() => expect(ownerClient.retry).toHaveBeenCalledOnce(),
			WAIT_FOR,
		);
		expect((await executionOf(journal, taskId)).execution.phase).toBe(
			"attempt-intended",
		);
		const started = Date.now();
		const stop = await scheduler.stop("operator stop");
		expect(Date.now() - started).toBeLessThan(30_000);
		expect(stop).toEqual({ state: "terminal", runStatus: "cancelled" });
		await expect(drive).resolves.toEqual({
			state: "terminal",
			runStatus: "cancelled",
		});
		const { state, task, execution } = await executionOf(journal, taskId);
		expect(task.status).toBe("failed");
		expect(state.status).toBe("cancelled");
		expect(execution.attemptsClosed).toBe(true);
		expect(execution.terminal).toMatchObject({
			outcome: "failed",
			evidence: { status: "failed", attemptOrdinal: 1 },
		});
		expect(execution.priorSettlements).toBeUndefined();
		const declined = (await journal.readEvents()).find(
			(event) => event.type === "task-execution-attempt-declined",
		);
		expect(declined?.data).toMatchObject({
			ordinal: 2,
			reason: "Workflow stop requested before the attempt.",
		});
		await expect(attemptEventCounts(journal)).resolves.toEqual({
			intended: 1,
			receipted: 0,
			declined: 1,
		});
		expect(ownerClient.interrupt).not.toHaveBeenCalled();
		expect(ownerClient.retry).toHaveBeenCalledTimes(1);
		expect(ownerClient.release).toHaveBeenCalledTimes(1);
	});

	it("recovers an open attempt intent after restart with one intent and one receipt", async () => {
		const fx = await fixture((materializer) => [
			materializer.agent("answer", retryRequest(1)),
		]);
		const taskId = fx.tasks[0]?.ref.taskId ?? "";
		const crashing = client({
			wait: vi.fn(async () => executionResult(transient())),
			retry: vi.fn(async () => {
				throw new Error("connection reset");
			}),
			findByOperation: vi.fn(async () => {
				throw new Error("lookup unavailable");
			}),
		});
		const first = await retryScheduler(fx.journal, crashing);
		await expect(first.drive()).rejects.toMatchObject({
			name: "WorkflowAttemptError",
			stage: "reconciliation",
		});
		expect((await executionOf(fx.journal, taskId)).execution.phase).toBe(
			"attempt-intended",
		);
		await expect(attemptEventCounts(fx.journal)).resolves.toEqual({
			intended: 1,
			receipted: 0,
			declined: 0,
		});

		const rotated = await rotateLease(fx);
		const ownerClient = client({
			wait: vi.fn(async () => executionResult(result("completed"))),
			retry: vi.fn(async () => attemptReceipt("active" as const)),
			release: vi.fn(async () => attemptReceipt("completed" as const)),
		});
		const second = await retryScheduler(rotated.journal, ownerClient);
		// The scheduler never marks a run `completed` itself; a fully completed
		// graph rests at `idle`/`waiting` for the run owner to close.
		await expect(driveToRest(second)).resolves.toEqual({
			state: "idle",
			runStatus: "waiting",
		});
		const { state, task, execution } = await executionOf(
			rotated.journal,
			taskId,
		);
		expect(task.status).toBe("completed");
		expect(state.status).toBe("waiting");
		expect(execution.attempts).toMatchObject([
			{ kind: "retry", ordinal: 2, subagentAttemptId: "attempt_scheduler2" },
		]);
		expect(execution.terminal?.evidence).toMatchObject({
			status: "completed",
			attemptOrdinal: 2,
		});
		await expect(attemptEventCounts(rotated.journal)).resolves.toEqual({
			intended: 1,
			receipted: 1,
			declined: 0,
		});
		expect(ownerClient.preflight).not.toHaveBeenCalled();
		expect(ownerClient.launch).not.toHaveBeenCalled();
		expect(ownerClient.retry).toHaveBeenCalledTimes(1);
		expect(ownerClient.findByOperation).not.toHaveBeenCalled();
		// One wait for the recovered attempt plus the finalizer's exact-result
		// re-read before artifact import.
		expect(ownerClient.wait).toHaveBeenCalledTimes(2);
	});

	it("blocks cleanup when a release receipt names the superseded attempt", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.agent("answer", retryRequest(1)),
		]);
		const taskId = tasks[0]?.ref.taskId ?? "";
		let waits = 0;
		const ownerClient = client({
			wait: vi.fn(async () => {
				waits += 1;
				return executionResult(waits === 1 ? transient() : result("completed"));
			}),
			retry: vi.fn(async () => attemptReceipt("active" as const)),
			release: vi.fn(async () => ({
				runId: "run_scheduler",
				attemptId: "attempt_scheduler",
				status: "completed" as const,
			})),
		});
		const scheduler = await retryScheduler(journal, ownerClient);
		await expect(driveToRest(scheduler)).rejects.toMatchObject({
			name: "WorkflowTaskFinalizationError",
			stage: "release",
			message: "Child release returned an invalid receipt.",
		});
		expect(ownerClient.release).toHaveBeenCalledWith("run_scheduler");
		const { state, task, execution } = await executionOf(journal, taskId);
		expect(task.status).toBe("cleanup-blocked");
		expect(["running", "waiting", "cleanup-blocked"]).toContain(state.status);
		expect(execution.phase).toBe("terminal");
		expect(execution.terminal).toMatchObject({
			outcome: "cleanup-blocked",
			evidence: { kind: "workflow", stage: "release" },
		});
		expect(execution.release).toBeUndefined();
		expect(execution.releaseIntent).toBeDefined();
		expect(execution.settlement?.evidence.attemptOrdinal).toBe(2);
		const types = (await journal.readEvents()).map((event) => event.type);
		expect(types).toContain("task-execution-release-intended");
		expect(types).not.toContain("task-execution-released");
		expect(types).toContain("task-execution-terminal");
	});
});

describe("worktree handoff settlement", () => {
	const baselineHead = "b".repeat(40);
	const handoffCommit = "d".repeat(40);

	function worktreeRequest(
		policy: "required" | "optional" = "required",
		overrides: Parameters<typeof request>[0] = {},
	) {
		const base = request(overrides);
		return {
			...base,
			workspace: { mode: "worktree" as const, cwd: "/repo" },
			handoff: policy,
			limits: { ...base.limits, workspaceWriteBytes: 1024 },
		};
	}

	function worktreeRecord(
		attemptId = "attempt_scheduler",
		overrides: Partial<WorktreeRecord> = {},
	): WorktreeRecord {
		return {
			schema: "pi-subagent-worktree",
			contractRevision: 8,
			runId: "run_scheduler",
			attemptId,
			repositoryRoot: "/private/repo",
			worktreePath: `/private/repo/.pi/worktrees/${attemptId}`,
			recordPath: `/private/repo/.pi/worktrees/${attemptId}.json`,
			branch: `pi-subagent/reservations/run_scheduler/${attemptId}`,
			baselineHead,
			createdAt: "2026-01-01T00:00:00.000Z",
			handoffCommit,
			handoffRef: `refs/pi-subagent/handoffs/run_scheduler/${attemptId}`,
			...overrides,
		};
	}

	function privateFields(record: WorktreeRecord): string[] {
		return [
			record.repositoryRoot,
			record.worktreePath,
			record.recordPath,
			record.branch,
			record.handoffRef ?? "",
			record.createdAt,
		];
	}

	function patch(): Buffer {
		return Buffer.from(
			`From ${handoffCommit} Mon Sep 17 00:00:00 2001\nFrom: Agent <agent@example.com>\nSubject: [PATCH] change\n\n---\n a.txt | 1 +\n`,
		);
	}

	function handoffExport(
		attemptId: string,
		content = patch(),
	): { ref: HandoffRef; content: Buffer } {
		return {
			ref: {
				runId: "run_scheduler",
				attemptId,
				baselineHead,
				handoffCommit,
				format: "git-format-patch",
				sha256: createHash("sha256").update(content).digest("hex"),
				bytes: content.byteLength,
				mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
			},
			content,
		};
	}

	function transientFailure(): RunResult {
		const failed = result("failed");
		if (!failed.failure) throw new Error("failed result lacks a failure");
		return { ...failed, failure: { ...failed.failure, retry: "backoff" } };
	}

	function causeMessages(error: unknown): string[] {
		const messages: string[] = [];
		let current: unknown = error;
		while (current instanceof Error) {
			messages.push(current.message);
			current = current.cause;
		}
		return messages;
	}

	async function worktreeScheduler(
		journal: WorkflowRunJournal,
		ownerClient: SubagentClient,
	) {
		const artifacts = await WorkflowArtifactStore.open({ journal });
		const ownerBinding = binding(ownerClient);
		return createWorkflowSequentialScheduler({
			journal,
			binding: ownerBinding,
			artifacts,
			finalizer: createWorkflowTaskFinalizer({
				journal,
				artifacts,
				binding: ownerBinding,
			}),
		});
	}

	it("persists only the handoff identity in worktree settlement evidence", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.agent("answer", worktreeRequest()),
		]);
		const record = worktreeRecord();
		const ownerClient = client({
			wait: vi.fn(async () => executionResult(result("completed"), record)),
		});
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(ownerClient),
		});

		await expect(scheduler.drive()).resolves.toMatchObject({
			state: "awaiting-finalization",
			outcome: "completed",
		});
		const state = await projection(journal);
		const task = state.tasks[tasks[0]?.ref.taskId ?? ""];
		const execution = state.executions[task?.currentExecutionId ?? ""];
		expect(execution).toMatchObject({
			phase: "settled",
			preflight: { workspaceMode: "worktree" },
			settlement: {
				evidence: {
					kind: "subagent",
					status: "completed",
					handoff: {
						attemptId: "attempt_scheduler",
						baselineHead,
						handoffCommit,
					},
				},
			},
		});
		expect(Object.keys(execution?.settlement?.evidence.handoff ?? {})).toEqual([
			"attemptId",
			"baselineHead",
			"handoffCommit",
		]);
		const journalText = JSON.stringify(await journal.readEvents());
		for (const secret of privateFields(record)) {
			expect(journalText).not.toContain(secret);
		}
		expect(journalText).not.toContain("not persisted");
		expect(journalText).not.toContain("session.jsonl");
	});

	it("settles a worktree child that captured no changes without a handoff", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.agent("answer", worktreeRequest("optional")),
		]);
		const {
			handoffCommit: _commit,
			handoffRef: _ref,
			...noChanges
		} = worktreeRecord();
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(
				client({
					wait: vi.fn(async () =>
						executionResult(result("completed"), noChanges),
					),
				}),
			),
		});
		await expect(scheduler.drive()).resolves.toMatchObject({
			state: "awaiting-finalization",
		});
		const state = await projection(journal);
		const task = state.tasks[tasks[0]?.ref.taskId ?? ""];
		const execution = state.executions[task?.currentExecutionId ?? ""];
		expect(execution?.settlement?.evidence.handoff).toBeUndefined();
		expect(JSON.stringify(execution)).not.toContain(baselineHead);
	});

	it("rejects a read-only child whose result carries a handoff", async () => {
		const { journal, tasks } = await fixture();
		const ownerClient = client({
			wait: vi.fn(async () =>
				executionResult(result("completed"), worktreeRecord()),
			),
		});
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(ownerClient),
		});
		const failure = await scheduler.drive().then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		expect(causeMessages(failure)).toContainEqual(
			expect.stringContaining("read-only task settlement carries a handoff"),
		);
		const state = await projection(journal);
		const task = state.tasks[tasks[0]?.ref.taskId ?? ""];
		const execution = state.executions[task?.currentExecutionId ?? ""];
		expect(execution?.settlement).toBeUndefined();
		expect(execution?.observation?.status).toBe("completed");
	});

	it("rejects a malformed handoff record as unrepresentable evidence", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.agent("answer", worktreeRequest()),
		]);
		const malformed = worktreeRecord("attempt_scheduler", {
			handoffCommit: baselineHead,
		});
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(
				client({
					wait: vi.fn(async () =>
						executionResult(result("completed"), malformed),
					),
				}),
			),
		});
		await expect(scheduler.drive()).rejects.toMatchObject({
			name: "WorkflowSchedulerError",
			stage: "observation",
			message:
				"Subagent terminal result cannot be represented as durable evidence.",
		});
		const state = await projection(journal);
		const task = state.tasks[tasks[0]?.ref.taskId ?? ""];
		expect(
			state.executions[task?.currentExecutionId ?? ""]?.settlement,
		).toBeUndefined();
	});

	it("imports the final attempt's handoff after a retry names a new attempt", async () => {
		const base = worktreeRequest();
		const { journal, tasks } = await fixture((materializer) => [
			materializer.agent("answer", {
				...base,
				retry: { attempts: 1 },
				limits: { ...base.limits, retries: 1 },
			}),
		]);
		const taskId = tasks[0]?.ref.taskId ?? "";
		const first = worktreeRecord("attempt_scheduler");
		const second = worktreeRecord("attempt_scheduler2");
		let waits = 0;
		const ownerClient = client({
			wait: vi.fn(async () => {
				waits += 1;
				return waits === 1
					? executionResult(transientFailure(), first)
					: executionResult(result("completed"), second);
			}),
			retry: vi.fn(async () => ({
				runId: "run_scheduler",
				attemptId: "attempt_scheduler2",
				status: "active" as const,
			})),
			release: vi.fn(async () => ({
				runId: "run_scheduler",
				attemptId: "attempt_scheduler2",
				status: "completed" as const,
			})),
			exportHandoff: vi.fn(async () => handoffExport("attempt_scheduler2")),
		});
		const scheduler = await worktreeScheduler(journal, ownerClient);

		// A completed graph leaves the run waiting for its output commit.
		await expect(driveToRest(scheduler)).resolves.toMatchObject({
			state: "idle",
			runStatus: "waiting",
		});
		const state = await projection(journal);
		const task = state.tasks[taskId];
		const execution = state.executions[task?.currentExecutionId ?? ""];
		expect(task?.status).toBe("completed");
		expect(execution?.priorSettlements?.[0]?.evidence).toMatchObject({
			status: "failed",
			attemptOrdinal: 1,
			handoff: { attemptId: "attempt_scheduler" },
		});
		expect(execution?.settlement?.evidence).toMatchObject({
			status: "completed",
			attemptOrdinal: 2,
			handoff: { attemptId: "attempt_scheduler2", baselineHead, handoffCommit },
		});
		expect(execution?.handoffImport).toMatchObject({
			subagentRunId: "run_scheduler",
			subagentAttemptId: "attempt_scheduler2",
			handoffCommit,
			baselineHead,
		});
		expect(execution?.terminal).toMatchObject({
			outcome: "completed",
			evidence: {
				kind: "subagent",
				attemptOrdinal: 2,
				handoff: { attemptId: "attempt_scheduler2" },
			},
		});
		expect(ownerClient.exportHandoff).toHaveBeenCalledExactlyOnceWith(
			"run_scheduler",
			{ maxBytes: 16 * 1024 * 1024 },
		);
		const journalText = JSON.stringify(await journal.readEvents());
		for (const secret of [...privateFields(first), ...privateFields(second)]) {
			expect(journalText).not.toContain(secret);
		}
	});

	it("reconciles a handoff-import block and completes the run", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.agent("answer", worktreeRequest()),
		]);
		const taskId = tasks[0]?.ref.taskId ?? "";
		const exportHandoff = vi
			.fn()
			.mockRejectedValueOnce(new Error("export unavailable"))
			.mockResolvedValueOnce(handoffExport("attempt_scheduler"));
		const ownerClient = client({
			wait: vi.fn(async () =>
				executionResult(result("completed"), worktreeRecord()),
			),
			release: vi.fn(async () => ({
				runId: "run_scheduler",
				attemptId: "attempt_scheduler",
				status: "completed" as const,
			})),
			reconcile: vi.fn(async () => ({
				run: {
					runId: "run_scheduler",
					attemptId: "attempt_scheduler",
					status: "completed" as const,
				},
				sandboxProcess: "absent" as const,
				workspace: "not-needed" as const,
			})),
			exportHandoff,
		});
		const scheduler = await worktreeScheduler(journal, ownerClient);

		await expect(scheduler.drive()).rejects.toMatchObject({
			name: "WorkflowTaskFinalizationError",
			stage: "handoff-import",
			message: "Subagent handoff export failed.",
		});
		let state = await projection(journal);
		expect(state.status).toBe("cleanup-blocked");
		expect(state.tasks[taskId]?.status).toBe("cleanup-blocked");
		expect(
			state.executions[state.tasks[taskId]?.currentExecutionId ?? ""]?.terminal,
		).toMatchObject({
			outcome: "cleanup-blocked",
			evidence: { kind: "workflow", stage: "handoff-import" },
		});
		expect(ownerClient.release).not.toHaveBeenCalled();

		// Reconciliation retries the import, releases, and drives on; the
		// completed graph leaves the run waiting for its output commit.
		await expect(scheduler.reconcile(taskId)).resolves.toMatchObject({
			state: "idle",
			runStatus: "waiting",
		});
		state = await projection(journal);
		expect(state.status).toBe("waiting");
		expect(state.tasks[taskId]?.status).toBe("completed");
		const execution =
			state.executions[state.tasks[taskId]?.currentExecutionId ?? ""];
		expect(execution).toMatchObject({
			phase: "terminal",
			handoffImport: { subagentAttemptId: "attempt_scheduler", handoffCommit },
			terminal: { outcome: "completed", evidence: { kind: "subagent" } },
		});
		expect(execution?.priorSettlements).toBeUndefined();
		expect(ownerClient.reconcile).toHaveBeenCalledOnce();
		expect(exportHandoff).toHaveBeenCalledTimes(2);
		// Scheduler settlement and the finalizer's exact-result check each wait,
		// before the block and again on reconciliation.
		expect(ownerClient.wait).toHaveBeenCalledTimes(4);
		expect(ownerClient.release).toHaveBeenCalledOnce();
		const types = (await journal.readEvents()).map((event) => event.type);
		expect(
			types.filter((type) => type === "task-execution-child-settled"),
		).toHaveLength(1);
	});
});

const decisionSchema = Type.Object(
	{ proceed: Type.Boolean() },
	{ additionalProperties: false },
);
const APPROVE = { proceed: true };
const CHECKPOINT_NOT_CONFIGURED =
	"Checkpoint execution is not configured for this workflow run.";

function checkpoint(
	overrides: {
		disposition?: "required" | "optional";
		headless?: "block" | "use-explicit-default";
		default?: { proceed: boolean };
		timeoutMs?: number;
		after?: readonly TaskRef[];
	} = {},
) {
	return {
		schema: decisionSchema,
		prompt: "Approve the plan?",
		headless: overrides.headless ?? ("block" as const),
		...(overrides.default ? { default: overrides.default } : {}),
		...(overrides.timeoutMs ? { timeoutMs: overrides.timeoutMs } : {}),
		...(overrides.disposition ? { disposition: overrides.disposition } : {}),
		...(overrides.after ? { after: overrides.after } : {}),
	};
}

function releasingClient(
	overrides: Partial<SubagentClient> = {},
	status: "completed" | "failed" = "completed",
): SubagentClient {
	return client({
		release: vi.fn(async () => ({
			runId: "run_scheduler",
			attemptId: "attempt_scheduler",
			status,
		})),
		...overrides,
	});
}

/** A scheduler with the real checkpoint executor built from both stores. */
async function checkpointScheduler(
	journal: WorkflowRunJournal,
	options: {
		ownerClient?: SubagentClient;
		concurrency?: number;
		budget?: WorkflowBudget;
		finalize?: boolean;
		supportTasks?: ReadonlyMap<string, SupportTaskRegistration>;
		nestedRuns?: WorkflowNestedRunProvider;
		headless?: boolean;
		decisions?: boolean;
	} = {},
) {
	const ownerClient = options.ownerClient ?? supportOnlyClient();
	const ownerBinding = binding(ownerClient);
	const artifacts = await WorkflowArtifactStore.open({ journal });
	const decisions = await WorkflowDecisionRecordStore.open({ journal });
	const scheduler = createWorkflowSequentialScheduler({
		journal,
		binding: ownerBinding,
		artifacts,
		...(options.decisions === false ? {} : { decisions }),
		...(options.finalize
			? {
					finalizer: createWorkflowTaskFinalizer({
						journal,
						artifacts,
						binding: ownerBinding,
					}),
				}
			: {}),
		...(options.concurrency ? { concurrency: options.concurrency } : {}),
		...(options.budget ? { budget: options.budget } : {}),
		...(options.supportTasks ? { supportTasks: options.supportTasks } : {}),
		...(options.nestedRuns ? { nestedRuns: options.nestedRuns, nesting } : {}),
		...(options.headless === undefined
			? {}
			: { checkpoints: { headless: options.headless } }),
	});
	return { scheduler, artifacts, decisions, ownerClient };
}

function executionOf(
	state: Awaited<ReturnType<typeof projection>>,
	taskId: string,
) {
	return state.executions[state.tasks[taskId]?.currentExecutionId ?? ""];
}

/**
 * Journal facts about the failure ladder: the open checkpoint is cancelled
 * (terminal, then status) before the run leaves running.
 */
function cancellationOrder(
	events: readonly { type: string; data: unknown }[],
	checkpointExecutionId: string,
) {
	const index = (
		predicate: (event: { type: string; data: unknown }) => boolean,
	) => events.findIndex(predicate);
	const terminal = index(
		(event) =>
			event.type === "task-execution-terminal" &&
			(event.data as { executionId: string }).executionId ===
				checkpointExecutionId,
	);
	const cancelled = index(
		(event) =>
			event.type === "task-status-changed" &&
			(event.data as { to: string }).to === "cancelled",
	);
	const runEnded = index(
		(event) =>
			event.type === "run-status-changed" &&
			["failed", "interrupted", "cleanup-blocked"].includes(
				(event.data as { to: string }).to,
			),
	);
	return {
		terminal,
		cancelled,
		runEnded,
		terminalEvent: events[terminal]?.data,
		cancelledEvent: events[cancelled]?.data,
	};
}

function expectCancelledBeforeRunEnded(
	events: readonly { type: string; data: unknown }[],
	checkpointTaskId: string,
	checkpointExecutionId: string,
) {
	const order = cancellationOrder(events, checkpointExecutionId);
	expect(order.terminal).toBeGreaterThan(-1);
	expect(order.cancelled).toBeGreaterThan(order.terminal);
	expect(order.runEnded).toBeGreaterThan(order.cancelled);
	expect(order.terminalEvent).toEqual({
		executionId: checkpointExecutionId,
		outcome: "cancelled",
		evidence: {
			kind: "workflow",
			stage: "stop",
			failureSha256: deriveWorkflowFailureSha256(
				"stop",
				CHECKPOINT_RUN_ENDING_REASON,
			),
			message: CHECKPOINT_RUN_ENDING_REASON,
		},
	});
	expect(order.cancelledEvent).toEqual({
		taskId: checkpointTaskId,
		from: "waiting",
		to: "cancelled",
		reason: CHECKPOINT_RUN_ENDING_REASON,
	});
}

describe("checkpoint scheduling", () => {
	it("parks a ready checkpoint and reports awaiting-decision", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.checkpoint("approve", checkpoint({ timeoutMs: 60_000 })),
		]);
		const taskId = tasks[0]?.ref.taskId ?? "";
		const { scheduler, ownerClient } = await checkpointScheduler(journal);
		const before = (await journal.readEvents()).length;

		const outcome = await scheduler.drive();
		const state = await projection(journal);
		const execution = executionOf(state, taskId);
		const expiresAt = execution?.checkpointRequest?.expiresAt;
		expect(expiresAt).toBeDefined();
		expect(outcome).toEqual({
			state: "awaiting-decision",
			runStatus: "waiting",
			pendingCheckpoints: [
				{ taskId, executionId: execution?.execution.id, expiresAt },
			],
		});
		expect(state.status).toBe("waiting");
		expect(state.tasks[taskId]?.status).toBe("waiting");
		expect(execution?.phase).toBe("checkpoint-requested");
		const events = (await journal.readEvents()).slice(before);
		expect(events.map((event) => event.type)).toEqual([
			"run-status-changed",
			"task-status-changed",
			"task-execution-created",
			"task-execution-checkpoint-requested",
			"task-status-changed",
			"run-status-changed",
		]);
		expect(events.at(-2)?.data).toEqual({
			taskId,
			from: "ready",
			to: "waiting",
			reason: "Checkpoint awaits a decision.",
		});
		expect(events.at(-1)?.data).toEqual({
			from: "running",
			to: "waiting",
			reason: "Workflow run awaits a checkpoint decision.",
		});

		// Quiescence (C3): another drive has nothing to do and reports the same
		// parked checkpoint without asking again.
		const parked = (await journal.readEvents()).length;
		await expect(scheduler.drive()).resolves.toEqual(outcome);
		const again = (await journal.readEvents()).slice(parked);
		expect(again.every((event) => event.type === "run-status-changed")).toBe(
			true,
		);
		expect((await projection(journal)).status).toBe("waiting");
		expect(subagentCallCount(ownerClient)).toBe(0);
	});

	it("holds no lane and reserves no budget while parked", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.checkpoint("approve", checkpoint()),
			materializer.agent("answer", request()),
		]);
		const checkpointId = tasks[0]?.ref.taskId ?? "";
		const agentId = tasks[1]?.ref.taskId ?? "";
		const ownerClient = releasingClient();
		// The agent's declared cost maximum equals the whole budget: any
		// reservation held by the parked checkpoint would defer it.
		const { scheduler } = await checkpointScheduler(journal, {
			ownerClient,
			concurrency: 1,
			budget: { cost: 100, childRuntimeMs: 300_000 },
			finalize: true,
		});

		const first = await scheduler.drive();
		expect(first).toMatchObject({ state: "awaiting-decision" });
		if (first.state !== "awaiting-decision") throw new Error("not parked");
		expect(first.pendingCheckpoints).toEqual([
			{
				taskId: checkpointId,
				executionId: executionOf(await projection(journal), checkpointId)
					?.execution.id,
			},
		]);

		await expect(scheduler.drive()).resolves.toMatchObject({
			state: "awaiting-decision",
			runStatus: "waiting",
		});
		expect(ownerClient.launch).toHaveBeenCalledOnce();
		const state = await projection(journal);
		expect(state.tasks[agentId]?.status).toBe("completed");
		expect(state.tasks[checkpointId]?.status).toBe("waiting");
		expect(state.status).toBe("waiting");
		expect(
			statusChanges(await journal.readEvents(), "task-status-changed").some(
				(change) => change.to === "blocked",
			),
		).toBe(false);
	});

	it("expires a required block checkpoint on the next sweep and fails the run", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.checkpoint("approve", checkpoint({ timeoutMs: 1_000 })),
		]);
		const taskId = tasks[0]?.ref.taskId ?? "";
		const { scheduler } = await checkpointScheduler(journal);
		const first = await scheduler.drive();
		if (first.state !== "awaiting-decision") throw new Error("not parked");
		const expiresAt = first.pendingCheckpoints[0]?.expiresAt ?? "";
		await new Promise((resolve) =>
			setTimeout(resolve, Math.max(0, Date.parse(expiresAt) - Date.now()) + 50),
		);

		await expect(scheduler.drive()).resolves.toEqual({
			state: "terminal",
			runStatus: "failed",
		});
		const state = await projection(journal);
		expect(state.status).toBe("failed");
		expect(state.tasks[taskId]?.status).toBe("failed");
		expect(executionOf(state, taskId)).toMatchObject({
			phase: "terminal",
			terminal: {
				outcome: "failed",
				evidence: {
					kind: "workflow",
					stage: "checkpoint-expired",
					message: "Checkpoint expired without a decision.",
				},
			},
		});
		expect(
			statusChanges(await journal.readEvents(), "run-status-changed").at(-1),
		).toMatchObject({
			to: "failed",
			reason: "A required workflow task did not complete.",
		});
	});

	it("expires an optional use-explicit-default checkpoint to its default and continues", async () => {
		const { journal, tasks } = await fixture((materializer) => {
			const approve = materializer.checkpoint(
				"approve",
				checkpoint({
					disposition: "optional",
					headless: "use-explicit-default",
					default: { proceed: false },
					timeoutMs: 1_000,
				}),
			);
			return [
				approve,
				materializer.support(
					"after",
					echo({ parameters: { value: "x" }, after: [approve.ref] }),
				),
			];
		});
		const checkpointId = tasks[0]?.ref.taskId ?? "";
		const supportId = tasks[1]?.ref.taskId ?? "";
		const { scheduler } = await checkpointScheduler(journal, {
			supportTasks: echoRegistry(({ parameters }) => ({
				answer: parameters.value,
			})),
		});
		const first = await scheduler.drive();
		if (first.state !== "awaiting-decision") throw new Error("not parked");
		const expiresAt = first.pendingCheckpoints[0]?.expiresAt ?? "";
		await new Promise((resolve) =>
			setTimeout(resolve, Math.max(0, Date.parse(expiresAt) - Date.now()) + 50),
		);

		await expect(driveToRest(scheduler)).resolves.toEqual({
			state: "idle",
			runStatus: "waiting",
		});
		const state = await projection(journal);
		expect(state.tasks[checkpointId]?.status).toBe("completed");
		expect(state.tasks[supportId]?.status).toBe("completed");
		expect(executionOf(state, checkpointId)?.checkpointDecision).toMatchObject({
			source: "default",
		});
	});

	it("decides a use-explicit-default checkpoint immediately in headless mode", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.checkpoint(
				"approve",
				checkpoint({
					headless: "use-explicit-default",
					default: { proceed: false },
				}),
			),
		]);
		const taskId = tasks[0]?.ref.taskId ?? "";
		const { scheduler } = await checkpointScheduler(journal, {
			headless: true,
		});

		await expect(scheduler.drive()).resolves.toEqual({
			state: "idle",
			runStatus: "waiting",
		});
		const state = await projection(journal);
		expect(state.tasks[taskId]?.status).toBe("completed");
		expect(
			statusChanges(await journal.readEvents(), "task-status-changed").some(
				(change) => change.to === "waiting",
			),
		).toBe(false);
		expect(
			statusChanges(await journal.readEvents(), "run-status-changed").some(
				(change) =>
					change.reason === "Workflow run awaits a checkpoint decision.",
			),
		).toBe(false);
	});

	it("records a decision under the scheduler lock and continues on the next drive", async () => {
		const { journal, tasks } = await fixture((materializer) => {
			const approve = materializer.checkpoint("approve", checkpoint());
			return [
				approve,
				materializer.agent("answer", request({ after: [approve.ref] })),
			];
		});
		const checkpointId = tasks[0]?.ref.taskId ?? "";
		const agentId = tasks[1]?.ref.taskId ?? "";
		const ownerClient = releasingClient();
		const { scheduler } = await checkpointScheduler(journal, {
			ownerClient,
			finalize: true,
		});
		await expect(scheduler.drive()).resolves.toMatchObject({
			state: "awaiting-decision",
		});

		await expect(
			scheduler.decide(checkpointId, { value: APPROVE, decidedBy: "vegard" }),
		).resolves.toMatchObject({
			taskId: checkpointId,
			outcome: "completed",
			runStatus: "waiting",
		});
		const decidedState = await projection(journal);
		expect(decidedState.tasks[checkpointId]?.status).toBe("completed");
		expect(executionOf(decidedState, checkpointId)).toMatchObject({
			phase: "terminal",
			checkpointDecision: { source: "operator", decidedBy: "vegard" },
			terminal: { outcome: "completed", evidence: { kind: "checkpoint" } },
		});
		expect(
			statusChanges(await journal.readEvents(), "task-status-changed").at(-1),
		).toEqual({
			taskId: checkpointId,
			from: "waiting",
			to: "completed",
			reason: "Checkpoint decided.",
		});

		await expect(driveToRest(scheduler)).resolves.toEqual({
			state: "idle",
			runStatus: "waiting",
		});
		const state = await projection(journal);
		expect(state.tasks[agentId]?.status).toBe("completed");
		expect(ownerClient.launch).toHaveBeenCalledOnce();
	});

	it("queues a decision behind the lane holding the scheduler lock", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.checkpoint("approve", checkpoint()),
			materializer.agent("answer", request()),
		]);
		const checkpointId = tasks[0]?.ref.taskId ?? "";
		const launch = deferred<{
			runId: string;
			attemptId: string;
			status: "active";
		}>();
		const ownerClient = releasingClient({
			launch: vi.fn(async () => launch.promise),
		});
		const { scheduler } = await checkpointScheduler(journal, {
			ownerClient,
			concurrency: 2,
			finalize: true,
		});
		await expect(scheduler.drive()).resolves.toMatchObject({
			state: "awaiting-decision",
		});

		// The second lane holds the lock inside `prepare` until launch returns.
		const second = scheduler.drive();
		while (vi.mocked(ownerClient.launch).mock.calls.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		let decided = false;
		const decision = scheduler
			.decide(checkpointId, { value: APPROVE, decidedBy: "vegard" })
			.then((outcome) => {
				decided = true;
				return outcome;
			});
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(decided).toBe(false);
		expect((await projection(journal)).tasks[checkpointId]?.status).toBe(
			"waiting",
		);

		launch.resolve({
			runId: "run_scheduler",
			attemptId: "attempt_scheduler",
			status: "active",
		});
		await expect(decision).resolves.toMatchObject({
			taskId: checkpointId,
			outcome: "completed",
		});
		await expect(second).resolves.toMatchObject({ state: "idle" });
		const state = await projection(journal);
		expect(state.tasks[checkpointId]?.status).toBe("completed");
		expect(state.tasks[tasks[1]?.ref.taskId ?? ""]?.status).toBe("completed");
	});

	it("refuses a decision without a checkpoint executor", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.checkpoint("approve", checkpoint()),
		]);
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(supportOnlyClient()),
		});
		await expect(
			scheduler.decide(tasks[0]?.ref.taskId ?? "", {
				value: APPROVE,
				decidedBy: "vegard",
			}),
		).rejects.toMatchObject({
			name: "WorkflowSchedulerError",
			stage: "validation",
			message: CHECKPOINT_NOT_CONFIGURED,
		});
	});

	it("blocks a required checkpoint and fails the run without an executor", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.checkpoint("approve", checkpoint()),
		]);
		const taskId = tasks[0]?.ref.taskId ?? "";
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding: binding(supportOnlyClient()),
			artifacts: await WorkflowArtifactStore.open({ journal }),
		});

		await expect(scheduler.drive()).resolves.toEqual({
			state: "terminal",
			runStatus: "failed",
		});
		const state = await projection(journal);
		expect(state.status).toBe("failed");
		expect(state.tasks[taskId]?.status).toBe("blocked");
		expect(state.tasks[taskId]?.currentExecutionId).toBe(undefined);
		const events = await journal.readEvents();
		expect(statusChanges(events, "task-status-changed").at(-1)).toEqual({
			taskId,
			from: "ready",
			to: "blocked",
			reason: CHECKPOINT_NOT_CONFIGURED,
		});
		expect(statusChanges(events, "run-status-changed").at(-1)).toEqual({
			from: "running",
			to: "failed",
			reason: CHECKPOINT_NOT_CONFIGURED,
		});
	});

	it("blocks an optional checkpoint and proceeds without an executor", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.checkpoint(
				"approve",
				checkpoint({ disposition: "optional" }),
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
	});

	it("stops a parked checkpoint and cancels the run", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.checkpoint("approve", checkpoint()),
		]);
		const taskId = tasks[0]?.ref.taskId ?? "";
		const { scheduler, ownerClient } = await checkpointScheduler(journal);
		await expect(scheduler.drive()).resolves.toMatchObject({
			state: "awaiting-decision",
		});
		const parked = (await journal.readEvents()).length;
		const executionId =
			executionOf(await projection(journal), taskId)?.execution.id ?? "";

		await expect(scheduler.stop("Operator requested stop.")).resolves.toEqual({
			state: "terminal",
			runStatus: "cancelled",
		});
		const events = (await journal.readEvents()).slice(parked);
		expect(
			events.map((event) => ({ type: event.type, data: event.data })),
		).toEqual([
			{
				type: "run-status-changed",
				data: {
					from: "waiting",
					to: "stopping",
					reason: "Operator requested stop.",
				},
			},
			{
				type: "task-execution-terminal",
				data: {
					executionId,
					outcome: "cancelled",
					evidence: {
						kind: "workflow",
						stage: "stop",
						failureSha256: deriveWorkflowFailureSha256(
							"stop",
							"Operator requested stop.",
						),
						message: "Operator requested stop.",
					},
				},
			},
			{
				type: "task-status-changed",
				data: {
					taskId,
					from: "waiting",
					to: "cancelled",
					reason: "Operator requested stop.",
				},
			},
			{
				type: "run-status-changed",
				data: {
					from: "stopping",
					to: "cancelled",
					reason: "Operator requested stop.",
				},
			},
		]);
		expect(scheduler.stopSignal.aborted).toBe(true);
		expect(subagentCallCount(ownerClient)).toBe(0);
	});

	it("refuses to stop a parked checkpoint without an executor", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.checkpoint("approve", checkpoint()),
		]);
		const { scheduler } = await checkpointScheduler(journal);
		await expect(scheduler.drive()).resolves.toMatchObject({
			state: "awaiting-decision",
		});
		const bare = createWorkflowSequentialScheduler({
			journal,
			binding: binding(supportOnlyClient()),
		});

		await expect(bare.stop("Operator requested stop.")).rejects.toMatchObject({
			name: "WorkflowSchedulerError",
			stage: "stop",
			message: "Open checkpoint task has no executor to cancel it.",
		});
		const state = await projection(journal);
		expect(state.status).toBe("stopping");
		expect(state.tasks[tasks[0]?.ref.taskId ?? ""]?.status).toBe("waiting");
	});

	it("cancels the open checkpoint before a required support failure fails the run", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.checkpoint("approve", checkpoint()),
			materializer.support("prepare", echo({ parameters: { value: "x" } })),
		]);
		const checkpointId = tasks[0]?.ref.taskId ?? "";
		const { scheduler } = await checkpointScheduler(journal, {
			concurrency: 2,
			supportTasks: echoRegistry(async () => {
				throw new Error("boom");
			}),
		});
		await expect(scheduler.drive()).resolves.toMatchObject({
			state: "awaiting-decision",
		});
		const executionId =
			executionOf(await projection(journal), checkpointId)?.execution.id ?? "";

		await expect(scheduler.drive()).resolves.toEqual({
			state: "terminal",
			runStatus: "failed",
		});
		const state = await projection(journal);
		expect(state.status).toBe("failed");
		expect(state.tasks[checkpointId]?.status).toBe("cancelled");
		expect(state.tasks[tasks[1]?.ref.taskId ?? ""]?.status).toBe("failed");
		const events = await journal.readEvents();
		expectCancelledBeforeRunEnded(events, checkpointId, executionId);
		expect(statusChanges(events, "run-status-changed").at(-1)).toMatchObject({
			to: "failed",
			reason: "A required workflow task did not complete.",
		});
	});

	it("cancels the open checkpoint before a required nested failure fails the run", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.checkpoint("approve", checkpoint()),
			materializer.workflow("child", nested()),
		]);
		const checkpointId = tasks[0]?.ref.taskId ?? "";
		const { provider, ended } = nestedProvider();
		provider.wait.mockResolvedValue(ended("failed"));
		const { scheduler } = await checkpointScheduler(journal, {
			concurrency: 2,
			nestedRuns: provider,
		});
		await expect(scheduler.drive()).resolves.toMatchObject({
			state: "awaiting-decision",
		});
		const executionId =
			executionOf(await projection(journal), checkpointId)?.execution.id ?? "";

		await expect(scheduler.drive()).resolves.toEqual({
			state: "terminal",
			runStatus: "failed",
		});
		const state = await projection(journal);
		expect(state.tasks[checkpointId]?.status).toBe("cancelled");
		expectCancelledBeforeRunEnded(
			await journal.readEvents(),
			checkpointId,
			executionId,
		);
	});

	it("cancels the open checkpoint before a required nested interruption interrupts the run", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.checkpoint("approve", checkpoint()),
			materializer.workflow("child", nested()),
		]);
		const checkpointId = tasks[0]?.ref.taskId ?? "";
		const { provider, ended } = nestedProvider();
		provider.wait.mockResolvedValue(ended("interrupted"));
		const { scheduler } = await checkpointScheduler(journal, {
			concurrency: 2,
			nestedRuns: provider,
		});
		await expect(scheduler.drive()).resolves.toMatchObject({
			state: "awaiting-decision",
		});
		const executionId =
			executionOf(await projection(journal), checkpointId)?.execution.id ?? "";

		await expect(scheduler.drive()).resolves.toEqual({
			state: "terminal",
			runStatus: "interrupted",
		});
		const state = await projection(journal);
		expect(state.status).toBe("interrupted");
		expect(state.tasks[checkpointId]?.status).toBe("cancelled");
		expectCancelledBeforeRunEnded(
			await journal.readEvents(),
			checkpointId,
			executionId,
		);
	});

	it("cancels the open checkpoint before a budget overage fails the run", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.checkpoint("approve", checkpoint()),
			materializer.agent("optional", request({ disposition: "optional" })),
		]);
		const checkpointId = tasks[0]?.ref.taskId ?? "";
		const overage = result("failed");
		overage.usage.cost = 101;
		const ownerClient = releasingClient(
			{ wait: vi.fn(async () => executionResult(overage)) },
			"failed",
		);
		const { scheduler } = await checkpointScheduler(journal, {
			ownerClient,
			finalize: true,
			budget: { cost: 100, childRuntimeMs: 300_000 },
		});
		await expect(scheduler.drive()).resolves.toMatchObject({
			state: "awaiting-decision",
		});
		const executionId =
			executionOf(await projection(journal), checkpointId)?.execution.id ?? "";

		await expect(scheduler.drive()).resolves.toEqual({
			state: "terminal",
			runStatus: "failed",
		});
		const state = await projection(journal);
		expect(state.status).toBe("failed");
		expect(state.tasks[checkpointId]?.status).toBe("cancelled");
		const events = await journal.readEvents();
		expectCancelledBeforeRunEnded(events, checkpointId, executionId);
		expect(statusChanges(events, "run-status-changed").at(-1)).toMatchObject({
			to: "failed",
			reason: "Workflow cost budget was exceeded.",
		});
	});

	it("cancels the open checkpoint before a launch failure fails the run", async () => {
		const { journal, tasks } = await fixture((materializer) => [
			materializer.checkpoint("approve", checkpoint()),
			materializer.agent("answer", request()),
		]);
		const checkpointId = tasks[0]?.ref.taskId ?? "";
		const { scheduler } = await checkpointScheduler(journal, {
			ownerClient: client({
				preflight: vi.fn(async () => {
					throw new Error("agent unavailable");
				}),
			}),
			concurrency: 2,
		});
		await expect(scheduler.drive()).resolves.toMatchObject({
			state: "awaiting-decision",
		});
		const executionId =
			executionOf(await projection(journal), checkpointId)?.execution.id ?? "";

		await expect(scheduler.drive()).rejects.toThrow("preflight");
		const state = await projection(journal);
		expect(state.status).toBe("failed");
		expect(state.tasks[checkpointId]?.status).toBe("cancelled");
		expect(state.tasks[tasks[1]?.ref.taskId ?? ""]?.status).toBe("failed");
		expectCancelledBeforeRunEnded(
			await journal.readEvents(),
			checkpointId,
			executionId,
		);
	});
});
