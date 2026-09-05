import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RunResult, SubagentClient } from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	WorkflowArtifactStore,
	WorkflowArtifactStoreError,
} from "../src/artifact-store.js";
import type { SubagentTerminalEvidence } from "../src/contracts.js";
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
	createWorkflowTaskFinalizer,
	WorkflowTaskFinalizationError,
} from "../src/task-finalizer.js";

const hash = "a".repeat(64);
const leases = new Set<WorkflowRunLease>();

function request() {
	return {
		agent: "researcher",
		task: {
			goal: "Answer",
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
			cost: 10,
			outputBytes: 1024,
			workspaceWriteBytes: 0,
			retries: 0,
			resumes: 0,
		},
	};
}

function runResult(
	status: "completed" | "failed" | "cleanup-blocked",
	structuredOutput: unknown = { answer: "yes" },
): RunResult {
	const failure =
		status === "completed"
			? undefined
			: {
					code:
						status === "cleanup-blocked"
							? ("sandbox-cleanup" as const)
							: ("tool" as const),
					origin:
						status === "cleanup-blocked"
							? ("sandbox" as const)
							: ("tool" as const),
					retry:
						status === "cleanup-blocked"
							? ("reconcile" as const)
							: ("never" as const),
					message:
						status === "cleanup-blocked" ? "cleanup blocked" : "tool failed",
					guidance: "Inspect the child.",
				};
	return {
		runId: "run_finalizer",
		status,
		...(status === "completed" ? { structuredOutput } : {}),
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
		...(failure ? { failure } : {}),
		sandboxCleanup: status === "cleanup-blocked" ? "blocked" : "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
	};
}

function evidence(result: RunResult): SubagentTerminalEvidence {
	return {
		kind: "subagent",
		resultSha256: deriveSubagentResultSha256(result),
		status: result.status,
		usage: structuredClone(result.usage),
		usageComplete: result.usageComplete,
		runtimeMs: result.runtimeMs,
		...(result.failure ? { failure: structuredClone(result.failure) } : {}),
		sandboxCleanup: result.sandboxCleanup,
		workspaceCleanup: result.workspaceCleanup,
		truncated: result.truncated,
		...(result.structuredOutput === undefined
			? {}
			: {
					structuredOutputSha256: deriveJsonValueSha256(
						result.structuredOutput,
					),
				}),
	};
}

function executionResult(result: RunResult) {
	return {
		result,
		output: "raw child output",
		sessionFile: "/private/session.jsonl",
		handoff: undefined,
		structuredOutput: result.structuredOutput,
		error: undefined,
	};
}

function client(overrides: Partial<SubagentClient>): SubagentClient {
	const unavailable = vi.fn(async () => {
		throw new Error("not implemented");
	});
	return {
		preflight: unavailable,
		launch: unavailable,
		findByOperation: unavailable,
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
		workflowRunId: "workflow_finalizer",
		ownerId: "pi-workflow:workflow_finalizer",
		client: ownerClient,
	};
}

async function fixture(result: RunResult) {
	const root = path.resolve(".pi", "test-finalizer", `run-${randomUUID()}`);
	const lease = await acquireWorkflowRunLease({
		storeRoot: root,
		runId: "workflow_finalizer",
		ownerId: "finalizer-test",
	});
	leases.add(lease);
	const journal = await WorkflowRunJournal.open(
		root,
		"workflow_finalizer",
		lease,
	);
	await journal.append("run-created", {
		definitionIdentitySha256: hash,
		inputSha256: hash,
	});
	const materializer = new WorkflowTaskMaterializer({
		runId: "workflow_finalizer",
		definitionIdentitySha256: hash,
		inputSha256: hash,
	});
	const handle = materializer.agent("answer", request());
	for (const event of materializer.closeEpoch("final", [handle]).events) {
		await journal.appendEvent(event);
	}
	await journal.append("run-status-changed", {
		from: "created",
		to: "running",
	});
	await journal.append("task-status-changed", {
		taskId: handle.ref.taskId,
		from: "pending",
		to: "ready",
	});
	const current = reduceWorkflowEvents(await journal.readEvents());
	const task = current.tasks[handle.ref.taskId];
	if (!task) throw new Error("missing task");
	const executionId = deriveTaskExecutionId(current.runId, task.task.id, 1);
	const operationId = deriveSubagentOperationId(current.runId, task.task.id, 1);
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
		preflightId: "preflight-finalizer",
		planIdentitySha256: hash,
		plannedSubagentRunId: "run_finalizer",
		plannedSubagentAttemptId: "attempt_finalizer",
		expiresAt: "2099-01-01T00:00:00.000Z",
	});
	await journal.append("task-execution-launch-intended", {
		executionId,
		operationId,
		preflightId: "preflight-finalizer",
		planIdentitySha256: hash,
	});
	await journal.append("task-execution-launch-receipted", {
		executionId,
		operationId,
		subagentRunId: "run_finalizer",
		subagentAttemptId: "attempt_finalizer",
		status: "active",
	});
	await journal.append("task-status-changed", {
		taskId: handle.ref.taskId,
		from: "ready",
		to: "running",
	});
	await journal.append("task-execution-child-observed", {
		executionId,
		subagentRunId: "run_finalizer",
		subagentAttemptId: "attempt_finalizer",
		status: result.status,
	});
	await journal.append("task-execution-child-settled", {
		executionId,
		evidence: evidence(result),
	});
	const artifacts = await WorkflowArtifactStore.open({ journal });
	return { journal, artifacts, taskId: handle.ref.taskId, executionId };
}

async function projection(journal: WorkflowRunJournal) {
	return reduceWorkflowEvents(await journal.readEvents());
}

afterEach(async () => {
	await Promise.all([...leases].map((lease) => lease.release()));
	leases.clear();
});

describe("workflow task finalizer", () => {
	it("imports structured output, releases the child, and completes the task", async () => {
		const result = runResult("completed");
		const { journal, artifacts, taskId, executionId } = await fixture(result);
		const ownerClient = client({
			wait: vi.fn(async () => executionResult(result)),
			release: vi.fn(async () => ({
				runId: "run_finalizer",
				attemptId: "attempt_finalizer",
				status: "completed" as const,
			})),
		});
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			artifacts,
			binding: binding(ownerClient),
		});

		const outcome = await finalizer.finalize(taskId);
		expect(outcome).toMatchObject({ outcome: "completed", artifact: {} });
		if (!outcome.artifact) throw new Error("missing artifact");
		expect(await artifacts.readJson(outcome.artifact)).toEqual({
			answer: "yes",
		});
		const state = await projection(journal);
		expect(state.tasks[taskId]?.status).toBe("completed");
		expect(state.executions[executionId]).toMatchObject({
			phase: "terminal",
			artifactImport: { artifactId: outcome.artifact.id },
			release: { status: "completed" },
			terminal: { outcome: "completed" },
		});
		expect(ownerClient.release).toHaveBeenCalledOnce();
		expect(JSON.stringify(state)).not.toContain("raw child output");
		expect(JSON.stringify(state)).not.toContain("session.jsonl");
	});

	it("recovers persisted release intent idempotently", async () => {
		const result = runResult("failed");
		const { journal, artifacts, taskId, executionId } = await fixture(result);
		await journal.append("task-execution-release-intended", {
			executionId,
			subagentRunId: "run_finalizer",
		});
		const release = vi.fn(async () => ({
			runId: "run_finalizer",
			attemptId: "attempt_finalizer",
			status: "failed" as const,
		}));
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			artifacts,
			binding: binding(client({ release })),
		});
		await expect(finalizer.finalize(taskId)).resolves.toMatchObject({
			outcome: "failed",
		});
		expect(release).toHaveBeenCalledOnce();
		expect((await projection(journal)).status).toBe("failed");
	});

	it("leaves release intent durable when release outcome is uncertain", async () => {
		const result = runResult("failed");
		const { journal, artifacts, taskId, executionId } = await fixture(result);
		const release = vi
			.fn()
			.mockRejectedValueOnce(new Error("connection lost"))
			.mockResolvedValueOnce({
				runId: "run_finalizer",
				attemptId: "attempt_finalizer",
				status: "failed" as const,
			});
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			artifacts,
			binding: binding(client({ release })),
		});
		await expect(finalizer.finalize(taskId)).rejects.toMatchObject({
			stage: "release",
		});
		expect((await projection(journal)).executions[executionId]?.phase).toBe(
			"release-intended",
		);
		await expect(finalizer.finalize(taskId)).resolves.toMatchObject({
			outcome: "failed",
		});
		expect(release).toHaveBeenCalledTimes(2);
	});

	it("blocks completion when structured output violates its schema", async () => {
		const result = runResult("completed", { answer: 42 });
		const { journal, artifacts, taskId, executionId } = await fixture(result);
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			artifacts,
			binding: binding(
				client({ wait: vi.fn(async () => executionResult(result)) }),
			),
		});
		await expect(finalizer.finalize(taskId)).rejects.toBeInstanceOf(
			WorkflowTaskFinalizationError,
		);
		const state = await projection(journal);
		expect(state.tasks[taskId]?.status).toBe("cleanup-blocked");
		expect(state.executions[executionId]?.terminal).toMatchObject({
			outcome: "cleanup-blocked",
			evidence: { kind: "workflow", stage: "artifact-import" },
		});
	});

	it("recovers artifact import after a durable cleanup block", async () => {
		const result = runResult("completed");
		const { journal, taskId } = await fixture(result);
		const bounded = await WorkflowArtifactStore.open({
			journal,
			maxArtifactBytes: 2,
			maxTotalBytes: 2,
		});
		const ownerClient = client({
			wait: vi.fn(async () => executionResult(result)),
			release: vi.fn(async () => ({
				runId: "run_finalizer",
				attemptId: "attempt_finalizer",
				status: "completed" as const,
			})),
		});
		await expect(
			createWorkflowTaskFinalizer({
				journal,
				artifacts: bounded,
				binding: binding(ownerClient),
			}).finalize(taskId),
		).rejects.toBeInstanceOf(WorkflowArtifactStoreError);
		expect((await projection(journal)).tasks[taskId]?.status).toBe(
			"cleanup-blocked",
		);

		const recovered = await WorkflowArtifactStore.open({ journal });
		await expect(
			createWorkflowTaskFinalizer({
				journal,
				artifacts: recovered,
				binding: binding(ownerClient),
			}).finalize(taskId),
		).resolves.toMatchObject({ outcome: "completed" });
		expect((await projection(journal)).tasks[taskId]?.status).toBe("completed");
	});

	it("repairs task and run state after terminal evidence was persisted", async () => {
		const result = runResult("failed");
		const { journal, artifacts, taskId, executionId } = await fixture(result);
		await journal.append("task-execution-release-intended", {
			executionId,
			subagentRunId: "run_finalizer",
		});
		await journal.append("task-execution-released", {
			executionId,
			subagentRunId: "run_finalizer",
			status: "failed",
		});
		await journal.append("task-execution-terminal", {
			executionId,
			outcome: "failed",
			evidence: evidence(result),
		});
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			artifacts,
			binding: binding(client({})),
		});
		await expect(finalizer.finalize(taskId)).resolves.toMatchObject({
			outcome: "failed",
			runStatus: "failed",
		});
		const state = await projection(journal);
		expect(state.tasks[taskId]?.status).toBe("failed");
		expect(state.status).toBe("failed");
	});

	it("recovers a release receipt persisted before changed settlement", async () => {
		const initial = runResult("cleanup-blocked");
		const released = runResult("failed");
		const { journal, artifacts, taskId, executionId } = await fixture(initial);
		await journal.append("task-execution-release-intended", {
			executionId,
			subagentRunId: "run_finalizer",
		});
		await journal.append("task-execution-released", {
			executionId,
			subagentRunId: "run_finalizer",
			status: "failed",
		});
		const release = vi.fn();
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			artifacts,
			binding: binding(
				client({
					release,
					wait: vi.fn(async () => executionResult(released)),
				}),
			),
		});
		await expect(finalizer.finalize(taskId)).resolves.toMatchObject({
			outcome: "failed",
		});
		expect(release).not.toHaveBeenCalled();
		expect(
			(await projection(journal)).executions[executionId]?.settlement?.evidence
				.status,
		).toBe("failed");
	});

	it("persists a release status change before replacing settlement", async () => {
		const initial = runResult("cleanup-blocked");
		const released = runResult("failed");
		const { journal, artifacts, taskId, executionId } = await fixture(initial);
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			artifacts,
			binding: binding(
				client({
					release: vi.fn(async () => ({
						runId: "run_finalizer",
						attemptId: "attempt_finalizer",
						status: "failed" as const,
					})),
					wait: vi.fn(async () => executionResult(released)),
				}),
			),
		});
		await expect(finalizer.finalize(taskId)).resolves.toMatchObject({
			outcome: "failed",
		});
		const state = await projection(journal);
		expect(state.executions[executionId]?.settlement?.evidence.status).toBe(
			"failed",
		);
		expect(state.executions[executionId]?.release?.status).toBe("failed");
		expect(state.tasks[taskId]?.status).toBe("failed");
	});
});
