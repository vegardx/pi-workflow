import { randomUUID } from "node:crypto";
import path from "node:path";
import {
	type AgentLaunchPlan,
	canonicalSha256,
	type RunReceipt,
	SUBAGENT_RUNTIME_CONTRACT,
	type SubagentClient,
	type SubagentPreflight,
	type SubagentRequest,
} from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	deriveSubagentOperationId,
	deriveTaskExecutionId,
} from "../src/execution.js";
import { WorkflowTaskMaterializer } from "../src/materializer.js";
import { WorkflowRunJournal } from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
	type WorkflowRunLease,
} from "../src/persistence/run-lease.js";
import { reduceWorkflowEvents } from "../src/reducer.js";
import type { WorkflowSubagentBinding } from "../src/subagent-provider.js";
import {
	createWorkflowTaskLauncher,
	WorkflowTaskLaunchError,
} from "../src/task-launcher.js";

const definitionIdentitySha256 = "a".repeat(64);
const inputSha256 = "b".repeat(64);
const hash = "c".repeat(64);
const leases = new Set<WorkflowRunLease>();

function request() {
	return {
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
	request: SubagentRequest,
	ownerId: string,
): AgentLaunchPlan {
	const draft = {
		schema: "pi-subagent-launch" as const,
		contractRevision: SUBAGENT_RUNTIME_CONTRACT.contractRevision,
		operationId: request.operationId,
		ownerId,
		runId: "run_launcher",
		attemptId: "attempt_launcher",
		agent: request.agent,
		agentDisplayName: "Researcher",
		agentPrompt: "Research the requested question.",
		agentSource: "/agents/researcher.md",
		agentSha256: hash,
		agentScope: "global" as const,
		task: structuredClone(request.task),
		contextMode: request.contextMode,
		model:
			request.model ??
			({ provider: "test", id: "model", thinking: "low" } as const),
		cwd: "/workspace" as const,
		tools: [...request.tools],
		preloadSkills: [...request.preloadSkills],
		contextScopes: [...request.contextScopes],
		resources: [
			{
				kind: "agent" as const,
				name: request.agent,
				source: "/agents/researcher.md",
				sha256: hash,
			},
		],
		workspace: {
			mode: request.workspace.mode,
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
			workspaceWriteBytes: request.limits.workspaceWriteBytes,
		},
		network: {
			mode: "public-egress" as const,
			blockInternalRanges: true as const,
		},
		outputSchema: structuredClone(request.outputSchema),
		limits: structuredClone(request.limits),
	} satisfies Omit<AgentLaunchPlan, "identitySha256">;
	return { ...draft, identitySha256: canonicalSha256(draft) };
}

function preflight(
	request: SubagentRequest,
	ownerId: string,
): SubagentPreflight {
	const plan = launchPlan(request, ownerId);
	return {
		preflightId: "preflight-launcher",
		identitySha256: plan.identitySha256,
		expiresAt: "2099-01-01T00:00:00.000Z",
		launchPlan: plan,
	};
}

function client(overrides: Partial<SubagentClient> = {}): SubagentClient {
	const unavailable = vi.fn(async () => {
		throw new Error("not implemented by test client");
	});
	return {
		preflight: unavailable,
		launch: unavailable,
		findByOperation: vi.fn(async () => undefined),
		status: unavailable,
		listRuns: unavailable,
		logs: unavailable,
		wait: unavailable,
		interrupt: unavailable,
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
		workflowRunId: "workflow_launcher",
		ownerId: "pi-workflow:workflow_launcher",
		client: ownerClient,
	};
}

async function readyJournal() {
	const root = path.resolve(".pi", "test-task-launcher", `run-${randomUUID()}`);
	const lease = await acquireWorkflowRunLease({
		storeRoot: root,
		runId: "workflow_launcher",
		ownerId: "launcher-test",
	});
	leases.add(lease);
	const journal = await WorkflowRunJournal.open(
		root,
		"workflow_launcher",
		lease,
	);
	await journal.append("run-created", {
		definitionIdentitySha256,
		inputSha256,
	});
	const materializer = new WorkflowTaskMaterializer({
		runId: "workflow_launcher",
		definitionIdentitySha256,
		inputSha256,
	});
	const task = materializer.agent("answer", request());
	for (const event of materializer.closeEpoch("final", [task]).events) {
		await journal.appendEvent(event);
	}
	await journal.append("run-status-changed", {
		from: "created",
		to: "running",
	});
	await journal.append("task-status-changed", {
		taskId: task.ref.taskId,
		from: "pending",
		to: "ready",
	});
	return { journal, lease, taskId: task.ref.taskId, root };
}

async function projection(journal: WorkflowRunJournal) {
	return reduceWorkflowEvents(await journal.readEvents());
}

async function primePreflight(
	journal: WorkflowRunJournal,
	taskId: string,
): Promise<{ executionId: string; operationId: string }> {
	const current = await projection(journal);
	const task = current.tasks[taskId];
	if (!task) throw new Error("missing task");
	const generation = 1;
	const executionId = deriveTaskExecutionId(
		current.runId,
		task.task.id,
		generation,
	);
	const operationId = deriveSubagentOperationId(
		current.runId,
		task.task.id,
		generation,
	);
	await journal.append("task-execution-created", {
		execution: {
			id: executionId,
			runId: current.runId,
			taskId: task.task.id,
			generation,
			taskIdentitySha256: task.task.spec.identitySha256,
			operationId,
		},
	});
	await journal.append("task-execution-preflighted", {
		executionId,
		operationId,
		preflightId: "preflight-persisted",
		planIdentitySha256: hash,
		expiresAt: "2099-01-01T00:00:00.000Z",
	});
	return { executionId, operationId };
}

async function primeLaunchIntent(
	journal: WorkflowRunJournal,
	taskId: string,
): Promise<void> {
	const { executionId, operationId } = await primePreflight(journal, taskId);
	await journal.append("task-execution-launch-intended", {
		executionId,
		operationId,
		preflightId: "preflight-persisted",
		planIdentitySha256: hash,
	});
}

afterEach(async () => {
	await Promise.all([...leases].map((lease) => lease.release()));
	leases.clear();
});

describe("workflow task launcher", () => {
	it("persists preflight and intent before one idempotent launch", async () => {
		const { journal, taskId } = await readyJournal();
		const preflightCall = vi.fn(async (input: SubagentRequest) =>
			preflight(input, "pi-workflow:workflow_launcher"),
		);
		const receipt: RunReceipt = {
			runId: "run_launcher",
			attemptId: "attempt_launcher",
			status: "active",
		};
		const launch = vi.fn(async () => receipt);
		const launcher = createWorkflowTaskLauncher({
			journal,
			binding: binding(client({ preflight: preflightCall, launch })),
		});

		await expect(launcher.launch(taskId)).resolves.toMatchObject({
			state: "launched",
			receipt,
		});
		const state = await projection(journal);
		const execution = Object.values(state.executions)[0];
		expect(execution).toMatchObject({
			phase: "launched",
			preflight: { preflightId: "preflight-launcher" },
			launchIntent: { operationId: execution?.execution.operationId },
			launchReceipt: { subagentRunId: "run_launcher" },
		});
		expect(preflightCall).toHaveBeenCalledOnce();
		expect(preflightCall.mock.calls[0]?.[0]).toMatchObject({
			operationId: execution?.execution.operationId,
			contextMode: "fresh",
			workspace: { mode: "read-only", cwd: "/repo" },
		});
		expect(launch).toHaveBeenCalledWith(
			"preflight-launcher",
			execution?.preflight?.planIdentitySha256,
		);

		await expect(launcher.launch(taskId)).resolves.toMatchObject({
			state: "already-launched",
			receipt,
		});
		expect(preflightCall).toHaveBeenCalledOnce();
		expect(launch).toHaveBeenCalledOnce();
	});

	it("recovers a launch call that loses its receipt", async () => {
		const { journal, taskId } = await readyJournal();
		const receipt: RunReceipt = {
			runId: "run_launcher",
			attemptId: "attempt_launcher",
			status: "active",
		};
		const findByOperation = vi.fn(async () => receipt);
		const launcher = createWorkflowTaskLauncher({
			journal,
			binding: binding(
				client({
					preflight: async (input) =>
						preflight(input, "pi-workflow:workflow_launcher"),
					launch: vi.fn(async () => {
						throw new Error("connection closed");
					}),
					findByOperation,
				}),
			),
		});

		await expect(launcher.launch(taskId)).resolves.toMatchObject({
			state: "launched",
			receipt,
		});
		const state = await projection(journal);
		const execution = Object.values(state.executions)[0];
		expect(execution?.launchUncertain).toBeDefined();
		expect(execution?.launchReceipt?.subagentRunId).toBe("run_launcher");
		expect(findByOperation).toHaveBeenCalledWith(
			execution?.execution.operationId,
		);
	});

	it("replaces process-local preflight evidence after lease rotation", async () => {
		const { journal, lease, taskId, root } = await readyJournal();
		await primePreflight(journal, taskId);
		await lease.release();
		leases.delete(lease);
		const nextLease = await acquireWorkflowRunLease({
			storeRoot: root,
			runId: "workflow_launcher",
			ownerId: "launcher-restart",
		});
		leases.add(nextLease);
		const resumed = await WorkflowRunJournal.open(
			root,
			"workflow_launcher",
			nextLease,
		);
		const receipt: RunReceipt = {
			runId: "run_launcher",
			attemptId: "attempt_launcher",
			status: "active",
		};
		const preflightCall = vi.fn(async (input: SubagentRequest) =>
			preflight(input, "pi-workflow:workflow_launcher"),
		);
		const launcher = createWorkflowTaskLauncher({
			journal: resumed,
			binding: binding(
				client({
					preflight: preflightCall,
					launch: vi.fn(async () => receipt),
				}),
			),
		});

		await expect(launcher.launch(taskId)).resolves.toMatchObject({
			state: "launched",
		});
		const state = await projection(resumed);
		const execution = Object.values(state.executions)[0];
		expect(execution?.preflight).toMatchObject({
			preflightId: "preflight-launcher",
			supersedesPreflightId: "preflight-persisted",
			fencingGeneration: nextLease.record.generation,
		});
		expect(preflightCall).toHaveBeenCalledOnce();
	});

	it("recovers a persisted intent without launching again", async () => {
		const { journal, taskId } = await readyJournal();
		await primeLaunchIntent(journal, taskId);
		const receipt: RunReceipt = {
			runId: "run_recovered",
			attemptId: "attempt_recovered",
			status: "active",
		};
		const launch = vi.fn();
		const findByOperation = vi.fn(async () => receipt);
		const launcher = createWorkflowTaskLauncher({
			journal,
			binding: binding(client({ launch, findByOperation })),
		});

		await expect(launcher.launch(taskId)).resolves.toMatchObject({
			state: "launched",
			receipt,
		});
		expect(launch).not.toHaveBeenCalled();
		expect(findByOperation).toHaveBeenCalledOnce();
	});

	it("terminalizes only after operation lookup proves launch absence", async () => {
		const { journal, taskId } = await readyJournal();
		await primeLaunchIntent(journal, taskId);
		const launcher = createWorkflowTaskLauncher({
			journal,
			binding: binding(
				client({ findByOperation: vi.fn(async () => undefined) }),
			),
		});

		await expect(launcher.launch(taskId)).resolves.toMatchObject({
			state: "absent",
		});
		const state = await projection(journal);
		const execution = Object.values(state.executions)[0];
		expect(execution).toMatchObject({
			phase: "terminal",
			launchAbsent: { operationId: execution?.execution.operationId },
			terminal: {
				outcome: "failed",
				evidence: { kind: "workflow", stage: "reconciliation" },
			},
		});
		expect(state.tasks[taskId]?.status).toBe("failed");
	});

	it("persists a preflight failure before failing the task", async () => {
		const { journal, taskId } = await readyJournal();
		const launcher = createWorkflowTaskLauncher({
			journal,
			binding: binding(
				client({
					preflight: vi.fn(async () => {
						throw new Error("missing agent");
					}),
				}),
			),
		});

		await expect(launcher.launch(taskId)).rejects.toMatchObject({
			stage: "preflight",
		});
		const state = await projection(journal);
		const execution = Object.values(state.executions)[0];
		expect(execution?.terminal).toMatchObject({
			outcome: "failed",
			evidence: { kind: "workflow", stage: "preflight" },
		});
		expect(state.tasks[taskId]?.status).toBe("failed");
	});

	it("leaves lookup failure uncertain for later reconciliation", async () => {
		const { journal, taskId } = await readyJournal();
		await primeLaunchIntent(journal, taskId);
		const launcher = createWorkflowTaskLauncher({
			journal,
			binding: binding(
				client({
					findByOperation: vi.fn(async () => {
						throw new Error("service unavailable");
					}),
				}),
			),
		});

		await expect(launcher.launch(taskId)).rejects.toBeInstanceOf(
			WorkflowTaskLaunchError,
		);
		const state = await projection(journal);
		expect(Object.values(state.executions)[0]?.phase).toBe("launch-uncertain");
		expect(state.tasks[taskId]?.status).toBe("ready");
	});

	it("rejects a client binding with a forged workflow owner", async () => {
		const { journal, taskId } = await readyJournal();
		const ownerClient = client();
		const launcher = createWorkflowTaskLauncher({
			journal,
			binding: {
				...binding(ownerClient),
				ownerId: "pi-workflow:workflow_other",
			},
		});
		await expect(launcher.launch(taskId)).rejects.toMatchObject({
			stage: "validation",
		});
		expect(ownerClient.preflight).not.toHaveBeenCalled();
	});

	it("serializes concurrent launch requests", async () => {
		const { journal, taskId } = await readyJournal();
		const receipt: RunReceipt = {
			runId: "run_launcher",
			attemptId: "attempt_launcher",
			status: "active",
		};
		const launch = vi.fn(async () => receipt);
		const launcher = createWorkflowTaskLauncher({
			journal,
			binding: binding(
				client({
					preflight: async (input) =>
						preflight(input, "pi-workflow:workflow_launcher"),
					launch,
				}),
			),
		});

		const [first, second] = await Promise.all([
			launcher.launch(taskId),
			launcher.launch(taskId),
		]);
		expect(first.state).toBe("launched");
		expect(second.state).toBe("already-launched");
		expect(launch).toHaveBeenCalledOnce();
	});
});
