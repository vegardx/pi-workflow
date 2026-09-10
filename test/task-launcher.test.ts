import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
	type AgentLaunchPlan,
	canonicalSha256,
	type RunReceipt,
	type RunResult,
	SUBAGENT_RUNTIME_CONTRACT,
	type SubagentClient,
	type SubagentPreflight,
	type SubagentRequest,
} from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowArtifactStore } from "../src/artifact-store.js";
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
		tools: [...request.tools].sort(),
		preloadSkills: [...request.preloadSkills].sort(),
		contextScopes: [...request.contextScopes].sort(),
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

async function readyJournalWithInput() {
	const root = path.resolve(
		".pi",
		"test-task-launcher-input",
		`run-${randomUUID()}`,
	);
	const lease = await acquireWorkflowRunLease({
		storeRoot: root,
		runId: "workflow_launcher",
		ownerId: "launcher-input-test",
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
	const producer = materializer.agent("producer", request());
	const consumer = materializer.agent("consumer", {
		...request(),
		task: {
			...request().task,
			goal: "Use the producer result",
			context: ["Existing context"],
		},
		inputs: { research: producer.output },
	});
	const commit = materializer.closeEpoch("final", [consumer]);
	for (const event of commit.events) {
		await journal.appendEvent(event);
	}
	const producerDeclaration = commit.events.find(
		(event) =>
			event.type === "task-declared" &&
			event.data.task.id === producer.ref.taskId,
	);
	if (producerDeclaration?.type !== "task-declared") {
		throw new Error("missing producer declaration");
	}
	const producerTask = producerDeclaration.data.task;
	await journal.append("run-status-changed", {
		from: "created",
		to: "running",
	});
	await journal.append("task-status-changed", {
		taskId: producer.ref.taskId,
		from: "pending",
		to: "ready",
	});
	const generation = 1;
	const executionId = deriveTaskExecutionId(
		"workflow_launcher",
		producer.ref.taskId,
		generation,
	);
	const operationId = deriveSubagentOperationId(
		"workflow_launcher",
		producer.ref.taskId,
		generation,
	);
	await journal.append("task-execution-created", {
		execution: {
			id: executionId,
			runId: "workflow_launcher",
			taskId: producer.ref.taskId,
			generation,
			taskIdentitySha256: producerTask.spec.identitySha256,
			operationId,
		},
	});
	await journal.append("task-execution-preflighted", {
		executionId,
		operationId,
		preflightId: "preflight-producer",
		planIdentitySha256: hash,
		plannedSubagentRunId: "run_producer",
		plannedSubagentAttemptId: "attempt_producer",
		expiresAt: "2099-01-01T00:00:00.000Z",
	});
	await journal.append("task-execution-launch-intended", {
		executionId,
		operationId,
		preflightId: "preflight-producer",
		planIdentitySha256: hash,
	});
	await journal.append("task-execution-launch-receipted", {
		executionId,
		operationId,
		subagentRunId: "run_producer",
		subagentAttemptId: "attempt_producer",
		status: "completed",
	});
	await journal.append("task-execution-child-observed", {
		executionId,
		subagentRunId: "run_producer",
		subagentAttemptId: "attempt_producer",
		status: "completed",
	});
	const structuredOutput = { answer: "producer value" };
	const result: RunResult = {
		runId: "run_producer",
		status: "completed",
		structuredOutput,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: 0,
		},
		usageComplete: true,
		runtimeMs: 100,
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
	};
	const resultSha256 = deriveSubagentResultSha256(result);
	const evidence = {
		kind: "subagent" as const,
		resultSha256,
		status: "completed" as const,
		usage: structuredClone(result.usage),
		usageComplete: true,
		runtimeMs: 100,
		sandboxCleanup: "proved" as const,
		workspaceCleanup: "not-needed" as const,
		truncated: false,
		structuredOutputSha256: deriveJsonValueSha256(structuredOutput),
	};
	await journal.append("task-execution-child-settled", {
		executionId,
		evidence,
	});
	const artifacts = await WorkflowArtifactStore.open({ journal });
	const artifact = await artifacts.putJson(structuredOutput, {
		runId: "workflow_launcher",
		producerTaskId: producer.ref.taskId,
		output: "result",
		schemaSha256: deriveJsonValueSha256(producerTask.spec.request.outputSchema),
	});
	await journal.append("artifact-declared", { artifact });
	await journal.append("task-execution-artifact-imported", {
		executionId,
		subagentRunId: "run_producer",
		artifactId: artifact.id,
		sourceResultSha256: resultSha256,
	});
	await journal.append("task-execution-release-intended", {
		executionId,
		subagentRunId: "run_producer",
	});
	await journal.append("task-execution-released", {
		executionId,
		subagentRunId: "run_producer",
		status: "completed",
	});
	await journal.append("task-execution-terminal", {
		executionId,
		outcome: "completed",
		evidence,
	});
	await journal.append("task-status-changed", {
		taskId: producer.ref.taskId,
		from: "ready",
		to: "completed",
	});
	await journal.append("task-status-changed", {
		taskId: consumer.ref.taskId,
		from: "pending",
		to: "ready",
	});
	return {
		artifact,
		artifacts,
		consumerId: consumer.ref.taskId,
		journal,
		lease,
		root,
	};
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
		plannedSubagentRunId: "run_launcher",
		plannedSubagentAttemptId: "attempt_launcher",
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

	it("reopens and binds verified artifacts into delegated context", async () => {
		const setup = await readyJournalWithInput();
		await setup.lease.release();
		leases.delete(setup.lease);
		const replacement = await acquireWorkflowRunLease({
			storeRoot: setup.root,
			runId: "workflow_launcher",
			ownerId: "launcher-input-restart",
		});
		leases.add(replacement);
		const journal = await WorkflowRunJournal.open(
			setup.root,
			"workflow_launcher",
			replacement,
		);
		const artifacts = await WorkflowArtifactStore.open({ journal });
		const preflightCall = vi.fn(async (input: SubagentRequest) =>
			preflight(input, "pi-workflow:workflow_launcher"),
		);
		const launcher = createWorkflowTaskLauncher({
			journal,
			artifacts,
			binding: binding(
				client({
					preflight: preflightCall,
					launch: vi.fn(async () => ({
						runId: "run_launcher",
						attemptId: "attempt_launcher",
						status: "active" as const,
					})),
				}),
			),
		});

		await expect(launcher.launch(setup.consumerId)).resolves.toMatchObject({
			state: "launched",
		});
		const delegated = preflightCall.mock.calls[0]?.[0];
		expect(delegated?.task.context[0]).toBe("Existing context");
		const projected = JSON.parse(delegated?.task.context[1] ?? "null");
		expect(projected).toMatchObject({
			kind: "pi-workflow-artifact-input",
			name: "research",
			mediaType: "application/json",
			value: { answer: "producer value" },
		});
		expect(projected.sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("durably fails before preflight when an input artifact is corrupt", async () => {
		const { artifact, artifacts, consumerId, journal } =
			await readyJournalWithInput();
		await writeFile(
			path.join(artifacts.root, `${artifact.sha256}.json`),
			"corrupt",
		);
		const preflightCall = vi.fn();
		const launcher = createWorkflowTaskLauncher({
			journal,
			artifacts,
			binding: binding(client({ preflight: preflightCall })),
		});

		await expect(launcher.launch(consumerId)).rejects.toMatchObject({
			stage: "preflight",
		});
		expect(preflightCall).not.toHaveBeenCalled();
		const current = await projection(journal);
		const task = current.tasks[consumerId];
		const execution = task?.currentExecutionId
			? current.executions[task.currentExecutionId]
			: undefined;
		expect(task?.status).toBe("failed");
		expect(execution?.terminal).toMatchObject({
			outcome: "failed",
			evidence: {
				kind: "workflow",
				stage: "preflight",
				message:
					"Workflow task input projection failed before subagent preflight.",
			},
		});
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
			runId: "run_launcher",
			attemptId: "attempt_launcher",
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

	it("rejects a recovered receipt for another planned child", async () => {
		const { journal, taskId } = await readyJournal();
		await primeLaunchIntent(journal, taskId);
		const launcher = createWorkflowTaskLauncher({
			journal,
			binding: binding(
				client({
					findByOperation: vi.fn(async () => ({
						runId: "run_other",
						attemptId: "attempt_other",
						status: "active" as const,
					})),
				}),
			),
		});
		await expect(launcher.launch(taskId)).rejects.toMatchObject({
			stage: "reconciliation",
		});
		expect(
			Object.values((await projection(journal)).executions)[0]?.phase,
		).toBe("launch-uncertain");
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

	it("finishes terminalization after a crash following absence evidence", async () => {
		const { journal, taskId } = await readyJournal();
		await primeLaunchIntent(journal, taskId);
		const current = await projection(journal);
		const execution = Object.values(current.executions)[0];
		if (!execution) throw new Error("missing execution");
		await journal.append("task-execution-launch-uncertain", {
			executionId: execution.execution.id,
			operationId: execution.execution.operationId,
			reason: "receipt missing after crash",
		});
		await journal.append("task-execution-launch-absent", {
			executionId: execution.execution.id,
			operationId: execution.execution.operationId,
		});
		const ownerClient = client();
		const launcher = createWorkflowTaskLauncher({
			journal,
			binding: binding(ownerClient),
		});

		await expect(launcher.launch(taskId)).resolves.toMatchObject({
			state: "absent",
		});
		const settled = await projection(journal);
		expect(settled.executions[execution.execution.id]?.phase).toBe("terminal");
		expect(settled.tasks[taskId]?.status).toBe("failed");
		expect(ownerClient.findByOperation).not.toHaveBeenCalled();
	});

	it("finishes task failure after a crash following terminal evidence", async () => {
		const { journal, taskId } = await readyJournal();
		const { executionId } = await primePreflight(journal, taskId);
		const message = "Subagent preflight failed before launch.";
		await journal.append("task-execution-terminal", {
			executionId,
			outcome: "failed",
			evidence: {
				kind: "workflow",
				stage: "preflight",
				failureSha256: canonicalSha256({ message, stage: "preflight" }),
				message,
			},
		});
		const launcher = createWorkflowTaskLauncher({
			journal,
			binding: binding(client()),
		});

		await expect(launcher.launch(taskId)).resolves.toMatchObject({
			state: "terminal",
		});
		expect((await projection(journal)).tasks[taskId]?.status).toBe("failed");
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
