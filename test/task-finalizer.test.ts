import { createHash, randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
	HANDOFF_EXPORT_MEDIA_TYPE,
	type HandoffRef,
	type RunResult,
	type SubagentClient,
	type WorktreeRecord,
} from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	WorkflowArtifactStore,
	WorkflowArtifactStoreError,
} from "../src/artifact-store.js";
import {
	CHECKPOINT_RUN_ENDING_REASON,
	createWorkflowCheckpointTaskExecutor,
} from "../src/checkpoint-executor.js";
import {
	type HandoffPolicy,
	MAX_WORKFLOW_HANDOFF_BYTES,
	type SubagentTerminalEvidence,
	WORKFLOW_HANDOFF_FORMAT_SHA256,
} from "../src/contracts.js";
import { WorkflowDecisionRecordStore } from "../src/decision-store.js";
import type { WorkflowEventInput } from "../src/events.js";
import {
	deriveJsonValueSha256,
	deriveSubagentOperationId,
	deriveSubagentResultSha256,
	deriveTaskExecutionId,
	deriveWorkflowFailureSha256,
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
const baselineHead = "b".repeat(40);
const handoffCommit = "d".repeat(40);
const leases = new Set<WorkflowRunLease>();

type RequestOptions = {
	readonly worktree?: HandoffPolicy;
	readonly disposition?: "required" | "optional";
};

function request(options: RequestOptions = {}) {
	return {
		agent: "researcher",
		...(options.disposition ? { disposition: options.disposition } : {}),
		task: {
			goal: "Answer",
			context: [],
			instructions: ["Return structured output."],
		},
		contextMode: "fresh" as const,
		tools: ["read"],
		preloadSkills: [],
		contextScopes: ["project" as const],
		workspace: options.worktree
			? { mode: "worktree" as const, cwd: "/repo" }
			: { mode: "read-only" as const, cwd: "/repo" },
		...(options.worktree ? { handoff: options.worktree } : {}),
		outputSchema: Type.Object({ answer: Type.String() }),
		limits: {
			cumulativeRuntimeMs: 300_000,
			attemptTimeoutMs: 300_000,
			totalTokens: 1_000_000,
			cost: 10,
			outputBytes: 1024,
			workspaceWriteBytes: options.worktree ? 1024 : 0,
			retries: 0,
			resumes: 0,
		},
	};
}

/** pi-subagent's private worktree record: only its identity may be persisted. */
function worktreeRecord(
	overrides: Partial<WorktreeRecord> = {},
): WorktreeRecord {
	return {
		schema: "pi-subagent-worktree",
		contractRevision: 7,
		runId: "run_finalizer",
		attemptId: "attempt_finalizer",
		repositoryRoot: "/private/repo",
		worktreePath: "/private/repo/.pi/worktrees/run_finalizer",
		recordPath: "/private/repo/.pi/worktrees/run_finalizer.json",
		branch: "pi-subagent/reservations/run_finalizer",
		baselineHead,
		createdAt: "2026-01-01T00:00:00.000Z",
		handoffCommit,
		handoffRef: "refs/pi-subagent/handoffs/run_finalizer/attempt_finalizer",
		...overrides,
	};
}

function sha256(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function patch(
	commit = handoffCommit,
	body = "Subject: [PATCH] change\n",
): Buffer {
	return Buffer.from(
		`From ${commit} Mon Sep 17 00:00:00 2001\nFrom: Agent <agent@example.com>\n${body}\n---\n a.txt | 1 +\n`,
	);
}

function handoffExport(
	content: Buffer,
	overrides: Partial<HandoffRef> = {},
): { ref: HandoffRef; content: Buffer } {
	return {
		ref: {
			runId: "run_finalizer",
			attemptId: "attempt_finalizer",
			baselineHead,
			handoffCommit,
			format: "git-format-patch",
			sha256: sha256(content),
			bytes: content.byteLength,
			mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
			...overrides,
		},
		content,
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

function evidence(
	result: RunResult,
	handoff?: WorktreeRecord,
): SubagentTerminalEvidence {
	return {
		kind: "subagent",
		attemptOrdinal: 1,
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
		...(handoff?.handoffCommit
			? {
					handoff: {
						attemptId: handoff.attemptId,
						baselineHead: handoff.baselineHead,
						handoffCommit: handoff.handoffCommit,
					},
				}
			: {}),
	};
}

function executionResult(result: RunResult, handoff?: WorktreeRecord) {
	return {
		result,
		output: "raw child output",
		sessionFile: "/private/session.jsonl",
		handoff,
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
		exportHandoff: unavailable,
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

async function fixture(
	result: RunResult,
	options: RequestOptions & {
		handoff?: WorktreeRecord;
		/** Also park a required checkpoint beside the agent task. */
		checkpoint?: boolean;
	} = {},
) {
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
	const approve = options.checkpoint
		? materializer.checkpoint("approve", {
				schema: Type.Object(
					{ proceed: Type.Boolean() },
					{ additionalProperties: false },
				),
				prompt: "Approve the answer?",
				headless: "block",
			})
		: undefined;
	const handle = materializer.agent("answer", request(options));
	for (const event of materializer.closeEpoch("final", [
		...(approve ? [approve] : []),
		handle,
	]).events) {
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
		preflightId: "preflight-finalizer",
		workspaceMode: options.worktree
			? ("worktree" as const)
			: ("read-only" as const),
		workspaceBaselineSha256: "c".repeat(64),
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
		evidence: evidence(result, options.handoff),
	});
	const artifacts = await WorkflowArtifactStore.open({ journal });
	let checkpointId = "";
	let checkpointExecutionId = "";
	if (approve) {
		await journal.append("task-status-changed", {
			taskId: approve.ref.taskId,
			from: "pending",
			to: "ready",
		});
		const executor = createWorkflowCheckpointTaskExecutor({
			journal,
			artifacts,
			decisions: await WorkflowDecisionRecordStore.open({ journal }),
			signal: () => new AbortController().signal,
		});
		const requested = await executor.request(approve.ref.taskId);
		expect(requested.state).toBe("requested");
		checkpointId = approve.ref.taskId;
		checkpointExecutionId = requested.executionId;
	}
	return {
		journal,
		artifacts,
		taskId: handle.ref.taskId,
		executionId,
		checkpointId,
		checkpointExecutionId,
	};
}

async function eventTypes(journal: WorkflowRunJournal) {
	return (await journal.readEvents()).map((event) => event.type);
}

function completedRelease() {
	return vi.fn(async () => ({
		runId: "run_finalizer",
		attemptId: "attempt_finalizer",
		status: "completed" as const,
	}));
}

const WORKTREE_SUCCESS_LADDER = [
	"artifact-declared",
	"task-execution-artifact-imported",
	"artifact-declared",
	"task-execution-handoff-imported",
	"task-execution-release-intended",
	"task-execution-released",
	"task-execution-terminal",
	"task-status-changed",
] as const;

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

describe("worktree handoff import", () => {
	const record = worktreeRecord();
	const HANDOFF_ABSENT_LADDER = [
		"artifact-declared",
		"task-execution-artifact-imported",
		"task-execution-handoff-absent",
		"task-execution-release-intended",
		"task-execution-released",
		"task-execution-terminal",
		"task-status-changed",
	] as const;

	function noChangesRecord(): WorktreeRecord {
		const { handoffCommit: _commit, handoffRef: _ref, ...rest } = record;
		return rest;
	}

	async function worktreeFixture(
		policy: HandoffPolicy = "required",
		handoff: WorktreeRecord = record,
		disposition: "required" | "optional" = "required",
	) {
		const result = runResult("completed");
		const fx = await fixture(result, {
			worktree: policy,
			handoff,
			disposition,
		});
		return { ...fx, result };
	}

	function worktreeClient(
		overrides: Partial<SubagentClient>,
		result: RunResult,
		handoff: WorktreeRecord = record,
	) {
		return client({
			wait: vi.fn(async () => executionResult(result, handoff)),
			release: completedRelease(),
			exportHandoff: vi.fn(async () => handoffExport(patch())),
			...overrides,
		});
	}

	function privateFields(): string[] {
		return [
			record.repositoryRoot,
			record.worktreePath,
			record.recordPath,
			record.branch,
			record.handoffRef ?? "",
			record.createdAt,
		];
	}

	it("imports the handoff after the result and before release in the spec 4.5 order", async () => {
		const { journal, artifacts, taskId, executionId, result } =
			await worktreeFixture();
		const content = patch();
		const ownerClient = worktreeClient(
			{ exportHandoff: vi.fn(async () => handoffExport(content)) },
			result,
		);
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			artifacts,
			binding: binding(ownerClient),
		});
		const settledCount = (await eventTypes(journal)).length;

		const outcome = await finalizer.finalize(taskId);
		expect(outcome).toMatchObject({ outcome: "completed", artifact: {} });
		expect((await eventTypes(journal)).slice(settledCount)).toEqual([
			...WORKTREE_SUCCESS_LADDER,
		]);
		expect(ownerClient.exportHandoff).toHaveBeenCalledExactlyOnceWith(
			"run_finalizer",
			{ maxBytes: MAX_WORKFLOW_HANDOFF_BYTES },
		);
		expect(ownerClient.release).toHaveBeenCalledOnce();

		const state = await projection(journal);
		const execution = state.executions[executionId];
		expect(state.tasks[taskId]?.status).toBe("completed");
		expect(execution).toMatchObject({
			phase: "terminal",
			handoffImport: {
				subagentRunId: "run_finalizer",
				subagentAttemptId: "attempt_finalizer",
				handoffCommit,
				baselineHead,
				sha256: sha256(content),
				bytes: content.byteLength,
			},
			terminal: {
				outcome: "completed",
				evidence: {
					kind: "subagent",
					handoff: {
						attemptId: "attempt_finalizer",
						baselineHead,
						handoffCommit,
					},
				},
			},
		});
		const handoffArtifact =
			state.artifacts[execution?.handoffImport?.artifactId ?? ""];
		if (!handoffArtifact) throw new Error("missing handoff artifact");
		expect(handoffArtifact).toMatchObject({
			output: "handoff",
			mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
			schemaSha256: WORKFLOW_HANDOFF_FORMAT_SHA256,
			producerTaskId: taskId,
			producerExecutionId: executionId,
			sha256: sha256(content),
			bytes: content.byteLength,
		});
		expect((await artifacts.readBytes(handoffArtifact)).equals(content)).toBe(
			true,
		);
		// The result and the handoff blobs share one workflow-owned store.
		const entries = await readdir(artifacts.root);
		expect(entries).toContain(`${handoffArtifact.sha256}.patch`);
		expect(entries).toContain(`${outcome.artifact?.sha256}.json`);
		// Only the handoff identity is durable; pi-subagent's paths, branch,
		// ref, and timestamps never reach the journal.
		const journalText = JSON.stringify(await journal.readEvents());
		for (const secret of privateFields()) {
			expect(journalText).not.toContain(secret);
		}
		expect(journalText).not.toContain("raw child output");
	});

	it("blocks at handoff-import when export fails and imports on reconciliation", async () => {
		const { journal, artifacts, taskId, executionId, result } =
			await worktreeFixture();
		const exportHandoff = vi
			.fn()
			.mockRejectedValueOnce(new Error("export unavailable"))
			.mockResolvedValueOnce(handoffExport(patch()));
		const ownerClient = worktreeClient({ exportHandoff }, result);
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			artifacts,
			binding: binding(ownerClient),
		});

		await expect(finalizer.finalize(taskId)).rejects.toMatchObject({
			name: "WorkflowTaskFinalizationError",
			stage: "handoff-import",
			message: "Subagent handoff export failed.",
		});
		let state = await projection(journal);
		expect(state.tasks[taskId]?.status).toBe("cleanup-blocked");
		expect(state.status).toBe("cleanup-blocked");
		expect(state.executions[executionId]).toMatchObject({
			phase: "terminal",
			terminal: {
				outcome: "cleanup-blocked",
				evidence: {
					kind: "workflow",
					stage: "handoff-import",
					message: "Workflow handoff artifact import requires reconciliation.",
				},
			},
		});
		const types = await eventTypes(journal);
		expect(types.slice(-3)).toEqual([
			"task-execution-terminal",
			"task-status-changed",
			"run-status-changed",
		]);
		expect(types).not.toContain("task-execution-release-intended");
		expect(ownerClient.release).not.toHaveBeenCalled();
		expect(JSON.stringify(await journal.readEvents())).not.toContain(
			"export unavailable",
		);

		await expect(finalizer.finalize(taskId)).resolves.toMatchObject({
			outcome: "completed",
		});
		state = await projection(journal);
		expect(state.tasks[taskId]?.status).toBe("completed");
		expect(state.status).toBe("running");
		expect(state.executions[executionId]).toMatchObject({
			phase: "terminal",
			handoffImport: { handoffCommit },
			terminal: { outcome: "completed", evidence: { kind: "subagent" } },
		});
		expect(exportHandoff).toHaveBeenCalledTimes(2);
		expect(ownerClient.release).toHaveBeenCalledOnce();
	});

	it.each([
		{
			name: "a digest mismatch",
			exported: () => handoffExport(patch(), { sha256: "e".repeat(64) }),
			message: "Exported handoff digest or size does not match its reference.",
		},
		{
			name: "a size mismatch",
			exported: () => {
				const exported = handoffExport(patch());
				return {
					...exported,
					ref: { ...exported.ref, bytes: exported.ref.bytes + 1 },
				};
			},
			message: "Exported handoff digest or size does not match its reference.",
		},
		{
			name: "another attempt",
			exported: () => handoffExport(patch(), { attemptId: "attempt_other" }),
			message: "Exported handoff does not match the settled handoff identity.",
		},
		{
			name: "another run",
			exported: () => handoffExport(patch(), { runId: "run_other" }),
			message: "Exported handoff does not match the settled handoff identity.",
		},
		{
			name: "another baseline",
			exported: () => handoffExport(patch(), { baselineHead: "e".repeat(40) }),
			message: "Exported handoff does not match the settled handoff identity.",
		},
		{
			name: "another handoff commit",
			exported: () =>
				handoffExport(patch("e".repeat(40)), { handoffCommit: "e".repeat(40) }),
			message: "Exported handoff does not match the settled handoff identity.",
		},
		{
			name: "a malformed first line",
			exported: () =>
				handoffExport(Buffer.from("diff --git a/a.txt b/a.txt\n+change\n")),
			message: "Exported handoff is not a single-commit git-format-patch.",
		},
		{
			name: "a first line naming another commit",
			exported: () => handoffExport(patch("e".repeat(40))),
			message: "Exported handoff is not a single-commit git-format-patch.",
		},
		{
			name: "a first line without a newline",
			exported: () =>
				handoffExport(
					Buffer.from(`From ${handoffCommit} Mon Sep 17 00:00:00 2001`),
				),
			message: "Exported handoff is not a single-commit git-format-patch.",
		},
		{
			name: "an invalid reference",
			exported: () => {
				const exported = handoffExport(patch());
				const { sha256: _digest, ...ref } = exported.ref;
				return { ref, content: exported.content };
			},
			message: "Subagent handoff export returned an invalid reference.",
		},
		{
			name: "an unsupported media type",
			exported: () =>
				handoffExport(patch(), {
					mediaType: "text/x-diff" as typeof HANDOFF_EXPORT_MEDIA_TYPE,
				}),
			message: "Subagent handoff export returned an invalid reference.",
		},
		{
			name: "content that is not a buffer",
			exported: () => ({
				...handoffExport(patch()),
				content: patch().toString("utf8"),
			}),
			message: "Subagent handoff export returned an invalid reference.",
		},
	])("blocks at handoff-import on $name", async ({ exported, message }) => {
		const { journal, artifacts, taskId, executionId, result } =
			await worktreeFixture();
		const ownerClient = worktreeClient(
			{
				exportHandoff: vi.fn(async () =>
					exported(),
				) as unknown as SubagentClient["exportHandoff"],
			},
			result,
		);
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			artifacts,
			binding: binding(ownerClient),
		});
		await expect(finalizer.finalize(taskId)).rejects.toMatchObject({
			name: "WorkflowTaskFinalizationError",
			stage: "handoff-import",
			message,
		});
		const state = await projection(journal);
		expect(state.tasks[taskId]?.status).toBe("cleanup-blocked");
		expect(state.status).toBe("cleanup-blocked");
		expect(state.executions[executionId]).toMatchObject({
			phase: "terminal",
			artifactImport: {},
			terminal: {
				outcome: "cleanup-blocked",
				evidence: { kind: "workflow", stage: "handoff-import" },
			},
		});
		expect(state.executions[executionId]?.handoffImport).toBeUndefined();
		expect(
			Object.values(state.artifacts).some(
				(artifact) => artifact.output === "handoff",
			),
		).toBe(false);
		expect(await readdir(artifacts.root)).not.toContainEqual(
			expect.stringMatching(/\.patch$/),
		);
		expect(ownerClient.release).not.toHaveBeenCalled();
	});

	/** pi-subagent's fixed refusal of an export above the bound it was given. */
	function boundRefusal(): Error {
		const refusal = new Error("handoff export exceeds byte limit");
		refusal.name = "WorktreeError";
		return refusal;
	}

	const HANDOFF_BOUND_MESSAGE = "Workflow handoff exceeds the import bound.";
	const HANDOFF_BOUND_LADDER = [
		"artifact-declared",
		"task-execution-artifact-imported",
		"task-execution-terminal",
		"task-status-changed",
		"run-status-changed",
	] as const;

	it.each([
		{
			name: "pi-subagent refuses the export",
			exportHandoff: () =>
				vi.fn(async () => {
					throw boundRefusal();
				}) as unknown as SubagentClient["exportHandoff"],
		},
		{
			name: "pi-subagent returns an oversize reference",
			exportHandoff: () =>
				vi.fn(async () =>
					handoffExport(
						Buffer.concat([
							patch(),
							Buffer.alloc(MAX_WORKFLOW_HANDOFF_BYTES, 0x20),
						]),
					),
				) as unknown as SubagentClient["exportHandoff"],
		},
		{
			name: "the refusal arrives wrapped in another error",
			exportHandoff: () =>
				vi.fn(async () => {
					throw new Error("owner client call failed", {
						cause: boundRefusal(),
					});
				}) as unknown as SubagentClient["exportHandoff"],
		},
	])(
		"fails a required task at handoff-import when $name",
		async ({ exportHandoff }) => {
			const { journal, artifacts, taskId, executionId, result } =
				await worktreeFixture();
			const ownerClient = worktreeClient(
				{ exportHandoff: exportHandoff() },
				result,
			);
			const finalizer = createWorkflowTaskFinalizer({
				journal,
				artifacts,
				binding: binding(ownerClient),
			});
			const settledCount = (await eventTypes(journal)).length;

			await expect(finalizer.finalize(taskId)).resolves.toMatchObject({
				outcome: "failed",
				runStatus: "failed",
			});
			expect((await eventTypes(journal)).slice(settledCount)).toEqual([
				...HANDOFF_BOUND_LADDER,
			]);
			const state = await projection(journal);
			expect(state.status).toBe("failed");
			expect(state.tasks[taskId]?.status).toBe("failed");
			expect(state.executions[executionId]).toMatchObject({
				phase: "terminal",
				artifactImport: {},
				terminal: {
					outcome: "failed",
					evidence: {
						kind: "workflow",
						stage: "handoff-import",
						message: HANDOFF_BOUND_MESSAGE,
					},
				},
			});
			expect(state.executions[executionId]?.handoffImport).toBeUndefined();
			expect(state.executions[executionId]?.handoffAbsent).toBeUndefined();
			// The child keeps its worktree: an unreleased worktree run is never an
			// ordinary retention candidate, so the operator can still recover it.
			expect(state.executions[executionId]?.releaseIntent).toBeUndefined();
			expect(ownerClient.release).not.toHaveBeenCalled();
			expect(await readdir(artifacts.root)).not.toContainEqual(
				expect.stringMatching(/\.patch$/),
			);
			const events = await eventTypes(journal);

			// Re-driving repairs the projection and calls nothing else.
			await expect(finalizer.finalize(taskId)).resolves.toMatchObject({
				outcome: "failed",
				runStatus: "failed",
			});
			expect(await eventTypes(journal)).toEqual(events);
			expect(ownerClient.release).not.toHaveBeenCalled();
		},
	);

	it("degrades an optional task when the handoff exceeds the import bound", async () => {
		const { journal, artifacts, taskId, executionId, result } =
			await worktreeFixture("optional", record, "optional");
		const ownerClient = worktreeClient(
			{
				exportHandoff: vi.fn(async () => {
					throw boundRefusal();
				}) as unknown as SubagentClient["exportHandoff"],
			},
			result,
		);
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			artifacts,
			binding: binding(ownerClient),
		});
		const settledCount = (await eventTypes(journal)).length;

		// An optional task fails on its own evidence and leaves the run running;
		// the scheduler concludes it `completed-degraded`.
		await expect(finalizer.finalize(taskId)).resolves.toMatchObject({
			outcome: "failed",
			runStatus: "running",
		});
		expect((await eventTypes(journal)).slice(settledCount)).toEqual(
			HANDOFF_BOUND_LADDER.filter((type) => type !== "run-status-changed"),
		);
		const state = await projection(journal);
		expect(state.status).toBe("running");
		expect(state.tasks[taskId]?.status).toBe("failed");
		expect(state.executions[executionId]).toMatchObject({
			terminal: {
				outcome: "failed",
				evidence: { stage: "handoff-import", message: HANDOFF_BOUND_MESSAGE },
			},
		});
		expect(ownerClient.release).not.toHaveBeenCalled();
	});

	it("converges a handoff-import block on a bound refusal instead of looping", async () => {
		const { journal, artifacts, taskId, executionId, result } =
			await worktreeFixture();
		const exportHandoff = vi
			.fn()
			.mockRejectedValueOnce(new Error("export unavailable"))
			.mockRejectedValue(boundRefusal());
		const ownerClient = worktreeClient({ exportHandoff }, result);
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			artifacts,
			binding: binding(ownerClient),
		});

		await expect(finalizer.finalize(taskId)).rejects.toMatchObject({
			stage: "handoff-import",
			message: "Subagent handoff export failed.",
		});
		let state = await projection(journal);
		expect(state.status).toBe("cleanup-blocked");
		expect(state.executions[executionId]?.terminal?.outcome).toBe(
			"cleanup-blocked",
		);

		// The re-drive proves the bound refusal and supersedes the blocked
		// terminal with the permanent failure of the same stage.
		await expect(finalizer.finalize(taskId)).resolves.toMatchObject({
			outcome: "failed",
			runStatus: "failed",
		});
		expect((await eventTypes(journal)).slice(-3)).toEqual([
			"task-execution-terminal",
			"task-status-changed",
			"run-status-changed",
		]);
		state = await projection(journal);
		expect(state.status).toBe("failed");
		expect(state.tasks[taskId]?.status).toBe("failed");
		expect(state.executions[executionId]).toMatchObject({
			phase: "terminal",
			terminal: {
				outcome: "failed",
				evidence: {
					kind: "workflow",
					stage: "handoff-import",
					message: HANDOFF_BOUND_MESSAGE,
				},
			},
		});
		expect(exportHandoff).toHaveBeenCalledTimes(2);
		expect(ownerClient.release).not.toHaveBeenCalled();
	});

	it("completes an optional-handoff worktree task that captured no changes", async () => {
		const noChanges = noChangesRecord();
		const { journal, artifacts, taskId, executionId, result } =
			await worktreeFixture("optional", noChanges);
		const exportHandoff = vi.fn();
		const ownerClient = worktreeClient({ exportHandoff }, result, noChanges);
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			artifacts,
			binding: binding(ownerClient),
		});
		const settledCount = (await eventTypes(journal)).length;

		await expect(finalizer.finalize(taskId)).resolves.toMatchObject({
			outcome: "completed",
			runStatus: "running",
		});
		expect((await eventTypes(journal)).slice(settledCount)).toEqual([
			...HANDOFF_ABSENT_LADDER,
		]);
		const state = await projection(journal);
		expect(state.tasks[taskId]?.status).toBe("completed");
		expect(state.executions[executionId]).toMatchObject({
			phase: "terminal",
			handoffAbsent: {
				subagentRunId: "run_finalizer",
				subagentAttemptId: "attempt_finalizer",
			},
			terminal: { outcome: "completed", evidence: { kind: "subagent" } },
		});
		expect(state.executions[executionId]?.handoffImport).toBeUndefined();
		expect(
			state.executions[executionId]?.terminal?.evidence.kind === "subagent"
				? state.executions[executionId]?.terminal?.evidence.handoff
				: "wrong kind",
		).toBeUndefined();
		expect(exportHandoff).not.toHaveBeenCalled();
		expect(ownerClient.release).toHaveBeenCalledOnce();

		// Re-running repairs nothing and calls nothing.
		await expect(finalizer.finalize(taskId)).resolves.toMatchObject({
			outcome: "completed",
		});
		expect((await eventTypes(journal)).slice(settledCount)).toEqual([
			...HANDOFF_ABSENT_LADDER,
		]);
		expect(ownerClient.release).toHaveBeenCalledOnce();
	});

	it("releases and then fails a required-handoff worktree task that captured no changes", async () => {
		const noChanges = noChangesRecord();
		const { journal, artifacts, taskId, executionId, result } =
			await worktreeFixture("required", noChanges);
		const exportHandoff = vi.fn();
		const ownerClient = worktreeClient({ exportHandoff }, result, noChanges);
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			artifacts,
			binding: binding(ownerClient),
		});
		const settledCount = (await eventTypes(journal)).length;

		await expect(finalizer.finalize(taskId)).resolves.toEqual({
			taskId,
			executionId,
			outcome: "failed",
			runStatus: "failed",
		});
		const ladder = [...HANDOFF_ABSENT_LADDER, "run-status-changed"];
		expect((await eventTypes(journal)).slice(settledCount)).toEqual(ladder);
		const state = await projection(journal);
		expect(state.tasks[taskId]?.status).toBe("failed");
		expect(state.status).toBe("failed");
		expect(state.executions[executionId]).toMatchObject({
			phase: "terminal",
			handoffAbsent: { subagentAttemptId: "attempt_finalizer" },
			release: { status: "completed" },
			terminal: {
				outcome: "failed",
				evidence: {
					kind: "workflow",
					stage: "handoff-import",
					message: "Completed worktree task captured no handoff.",
				},
			},
		});
		const statusChange = (await journal.readEvents())
			.filter((event) => event.type === "task-status-changed")
			.at(-1);
		expect(statusChange?.data).toMatchObject({
			to: "failed",
			reason: "Completed worktree task captured no handoff.",
		});
		expect(ownerClient.release).toHaveBeenCalledOnce();
		expect(exportHandoff).not.toHaveBeenCalled();

		// The persisted failure repairs idempotently without touching the child.
		await expect(finalizer.finalize(taskId)).resolves.toMatchObject({
			outcome: "failed",
			runStatus: "failed",
		});
		expect((await eventTypes(journal)).slice(settledCount)).toEqual(ladder);
		expect(ownerClient.release).toHaveBeenCalledOnce();
		expect(ownerClient.wait).toHaveBeenCalledOnce();
	});

	it("repairs a required-handoff failure persisted before its task status", async () => {
		const noChanges = noChangesRecord();
		const { journal, artifacts, taskId, executionId, result } =
			await worktreeFixture("required", noChanges);
		const ownerClient = worktreeClient({}, result, noChanges);
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			artifacts,
			binding: binding(ownerClient),
		});
		await finalizer.finalize(taskId);
		// Rebuild the same prefix up to the terminal on a fresh run.
		const events = await journal.readEvents();
		const settledIndex = events.findIndex(
			(event) => event.type === "task-execution-child-settled",
		);
		const terminalIndex = events.findIndex(
			(event) => event.type === "task-execution-terminal",
		);
		const resultRef = Object.values((await projection(journal)).artifacts).find(
			(artifact) => artifact.output === "result",
		);
		if (!resultRef) throw new Error("missing result artifact");
		const crashed = await worktreeFixture("required", noChanges);
		await crashed.artifacts.putJson(
			{ answer: "yes" },
			{
				runId: "workflow_finalizer",
				producerTaskId: crashed.taskId,
				producerExecutionId: crashed.executionId,
				output: "result",
				schemaSha256: resultRef.schemaSha256,
			},
		);
		for (const event of events.slice(settledIndex + 1, terminalIndex + 1)) {
			await crashed.journal.appendEvent({
				type: event.type,
				data: event.data,
			} as WorkflowEventInput);
		}
		const unexpected = vi.fn(async () => {
			throw new Error("child must not be touched during repair");
		});
		await expect(
			createWorkflowTaskFinalizer({
				journal: crashed.journal,
				artifacts: crashed.artifacts,
				binding: binding(client({ wait: unexpected, release: unexpected })),
			}).finalize(crashed.taskId),
		).resolves.toMatchObject({ outcome: "failed", runStatus: "failed" });
		const state = await projection(crashed.journal);
		expect(state.tasks[crashed.taskId]?.status).toBe("failed");
		expect(state.status).toBe("failed");
		expect(state.executions[executionId]?.terminal).toMatchObject({
			outcome: "failed",
			evidence: { kind: "workflow", stage: "handoff-import" },
		});
	});

	it("re-runs idempotently after every crash prefix of the worktree ladder", async () => {
		const content = patch();
		const reference = await worktreeFixture();
		const settledCount = (await eventTypes(reference.journal)).length;
		await createWorkflowTaskFinalizer({
			journal: reference.journal,
			artifacts: reference.artifacts,
			binding: binding(
				worktreeClient(
					{ exportHandoff: vi.fn(async () => handoffExport(content)) },
					reference.result,
				),
			),
		}).finalize(reference.taskId);
		const ladder = (await reference.journal.readEvents())
			.slice(settledCount)
			.map(
				(event) =>
					({ type: event.type, data: event.data }) as WorkflowEventInput,
			);
		expect(ladder.map((event) => event.type)).toEqual([
			...WORKTREE_SUCCESS_LADDER,
		]);
		const resultArtifact = (await projection(reference.journal)).artifacts;
		const resultRef = Object.values(resultArtifact).find(
			(artifact) => artifact.output === "result",
		);
		if (!resultRef) throw new Error("missing result artifact");

		for (let prefix = 0; prefix <= ladder.length; prefix += 1) {
			const fx = await worktreeFixture();
			// Blobs may already exist before their declaration; content-addressed
			// orphans are safe and dedup on the next put.
			await fx.artifacts.putJson(
				{ answer: "yes" },
				{
					runId: "workflow_finalizer",
					producerTaskId: fx.taskId,
					producerExecutionId: fx.executionId,
					output: "result",
					schemaSha256: resultRef.schemaSha256,
				},
			);
			await fx.artifacts.putBytes(content, {
				runId: "workflow_finalizer",
				producerTaskId: fx.taskId,
				producerExecutionId: fx.executionId,
				output: "handoff",
				mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
				schemaSha256: WORKFLOW_HANDOFF_FORMAT_SHA256,
			});
			for (const event of ladder.slice(0, prefix)) {
				await fx.journal.appendEvent(event);
			}
			const exportHandoff = vi.fn(async () => handoffExport(content));
			const ownerClient = worktreeClient({ exportHandoff }, fx.result);
			const finalizer = createWorkflowTaskFinalizer({
				journal: fx.journal,
				artifacts: fx.artifacts,
				binding: binding(ownerClient),
			});

			await expect(
				finalizer.finalize(fx.taskId),
				`prefix ${prefix}`,
			).resolves.toMatchObject({
				outcome: "completed",
			});
			expect(
				(await eventTypes(fx.journal)).slice(settledCount),
				`prefix ${prefix}`,
			).toEqual([...WORKTREE_SUCCESS_LADDER]);
			// Export happens only until the handoff artifact is declared; release
			// only until the release receipt is durable; a persisted terminal never
			// touches the child again.
			const handoffDeclared = prefix >= 3;
			const released = prefix >= 6;
			const terminal = prefix >= 7;
			expect(exportHandoff, `prefix ${prefix}`).toHaveBeenCalledTimes(
				handoffDeclared ? 0 : 1,
			);
			expect(ownerClient.release, `prefix ${prefix}`).toHaveBeenCalledTimes(
				released ? 0 : 1,
			);
			expect(ownerClient.wait, `prefix ${prefix}`).toHaveBeenCalledTimes(
				terminal ? 0 : 1,
			);
			const state = await projection(fx.journal);
			expect(state.tasks[fx.taskId]?.status).toBe("completed");
			expect(state.executions[fx.executionId]).toMatchObject({
				phase: "terminal",
				handoffImport: { handoffCommit, sha256: sha256(content) },
				terminal: { outcome: "completed", evidence: { kind: "subagent" } },
			});
		}
	});

	it("blocks a declared handoff whose blob is missing instead of exporting again", async () => {
		const content = patch();
		const { journal, artifacts, taskId, executionId, result } =
			await worktreeFixture();
		const ref = await artifacts.putBytes(content, {
			runId: "workflow_finalizer",
			producerTaskId: taskId,
			producerExecutionId: executionId,
			output: "handoff",
			mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
			schemaSha256: WORKFLOW_HANDOFF_FORMAT_SHA256,
		});
		await rm(path.join(artifacts.root, `${ref.sha256}.patch`));
		const first = createWorkflowTaskFinalizer({
			journal,
			artifacts,
			binding: binding(worktreeClient({}, result)),
		});
		// Import the result and declare the handoff without importing it.
		await journal.append("artifact-declared", { artifact: ref });
		const exportHandoff = vi.fn(async () => handoffExport(content));
		await expect(
			createWorkflowTaskFinalizer({
				journal,
				artifacts,
				binding: binding(worktreeClient({ exportHandoff }, result)),
			}).finalize(taskId),
		).rejects.toMatchObject({
			stage: "handoff-import",
			message: "Completed worktree task has no durable handoff artifact.",
		});
		expect(exportHandoff).not.toHaveBeenCalled();
		const state = await projection(journal);
		expect(state.tasks[taskId]?.status).toBe("cleanup-blocked");
		expect(state.executions[executionId]?.terminal).toMatchObject({
			outcome: "cleanup-blocked",
			evidence: { kind: "workflow", stage: "handoff-import" },
		});
		void first;
	});

	it("verifies the durable handoff blob when repairing a persisted completion", async () => {
		const content = patch();
		const { journal, artifacts, taskId, executionId, result } =
			await worktreeFixture();
		const ownerClient = worktreeClient(
			{ exportHandoff: vi.fn(async () => handoffExport(content)) },
			result,
		);
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			artifacts,
			binding: binding(ownerClient),
		});
		await expect(finalizer.finalize(taskId)).resolves.toMatchObject({
			outcome: "completed",
		});
		const state = await projection(journal);
		const handoffArtifact =
			state.artifacts[
				state.executions[executionId]?.handoffImport?.artifactId ?? ""
			];
		if (!handoffArtifact) throw new Error("missing handoff artifact");

		// Repair reads both blobs and never touches the child again.
		await expect(finalizer.finalize(taskId)).resolves.toMatchObject({
			outcome: "completed",
			artifact: { output: "result" },
		});
		expect(ownerClient.wait).toHaveBeenCalledOnce();
		expect(ownerClient.release).toHaveBeenCalledOnce();

		await rm(path.join(artifacts.root, `${handoffArtifact.sha256}.patch`));
		await expect(finalizer.finalize(taskId)).rejects.toMatchObject({
			name: "WorkflowTaskFinalizationError",
			stage: "handoff-import",
			message: "Completed worktree task has no durable handoff artifact.",
		});
		expect((await projection(journal)).tasks[taskId]?.status).toBe("completed");
	});

	it("keeps read-only finalization free of handoff events", async () => {
		const result = runResult("completed");
		const { journal, taskId, artifacts } = await fixture(result);
		const exportHandoff = vi.fn();
		await expect(
			createWorkflowTaskFinalizer({
				journal,
				artifacts,
				binding: binding(
					client({
						wait: vi.fn(async () => executionResult(result)),
						release: completedRelease(),
						exportHandoff,
					}),
				),
			}).finalize(taskId),
		).resolves.toMatchObject({ outcome: "completed" });
		const types = await eventTypes(journal);
		expect(types).not.toContain("task-execution-handoff-imported");
		expect(types).not.toContain("task-execution-handoff-absent");
		expect(exportHandoff).not.toHaveBeenCalled();
	});
});

describe("checkpoint cancellation before run failure", () => {
	/**
	 * The failure ladder: the open checkpoint's execution is terminalized as
	 * cancelled and its status follows, both before the run leaves running.
	 */
	async function expectCheckpointCancelledFirst(
		journal: WorkflowRunJournal,
		checkpointId: string,
		checkpointExecutionId: string,
		runStatus: "failed" | "interrupted" | "cleanup-blocked",
	) {
		const events = await journal.readEvents();
		const terminal = events.findIndex(
			(event) =>
				event.type === "task-execution-terminal" &&
				(event.data as { executionId: string }).executionId ===
					checkpointExecutionId,
		);
		const cancelled = events.findIndex(
			(event) =>
				event.type === "task-status-changed" &&
				(event.data as { taskId: string }).taskId === checkpointId &&
				(event.data as { to: string }).to === "cancelled",
		);
		const ended = events.findIndex(
			(event) =>
				event.type === "run-status-changed" &&
				(event.data as { to: string }).to === runStatus,
		);
		expect(terminal).toBeGreaterThan(-1);
		expect(cancelled).toBeGreaterThan(terminal);
		expect(ended).toBeGreaterThan(cancelled);
		expect(events[terminal]?.data).toEqual({
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
		expect(events[cancelled]?.data).toEqual({
			taskId: checkpointId,
			from: "waiting",
			to: "cancelled",
			reason: CHECKPOINT_RUN_ENDING_REASON,
		});
		const state = await projection(journal);
		expect(state.status).toBe(runStatus);
		expect(state.tasks[checkpointId]?.status).toBe("cancelled");
		expect(state.executions[checkpointExecutionId]?.terminal?.outcome).toBe(
			"cancelled",
		);
	}

	it("cancels the open checkpoint before a required failure fails the run", async () => {
		const fx = await fixture(runResult("failed"), { checkpoint: true });
		expect((await projection(fx.journal)).tasks[fx.checkpointId]?.status).toBe(
			"waiting",
		);
		const finalizer = createWorkflowTaskFinalizer({
			journal: fx.journal,
			artifacts: fx.artifacts,
			binding: binding(
				client({
					release: vi.fn(async () => ({
						runId: "run_finalizer",
						attemptId: "attempt_finalizer",
						status: "failed" as const,
					})),
				}),
			),
		});

		await expect(finalizer.finalize(fx.taskId)).resolves.toMatchObject({
			outcome: "failed",
			runStatus: "failed",
		});
		await expectCheckpointCancelledFirst(
			fx.journal,
			fx.checkpointId,
			fx.checkpointExecutionId,
			"failed",
		);
		const runChanges = (await fx.journal.readEvents())
			.filter((event) => event.type === "run-status-changed")
			.map((event) => event.data);
		expect(runChanges.at(-1)).toEqual({
			from: "running",
			to: "failed",
			reason: "A required workflow task did not complete.",
		});
	});

	it("cancels the open checkpoint before an interrupted child interrupts the run", async () => {
		const interrupted = {
			...runResult("failed"),
			status: "interrupted",
			failure: {
				code: "seat-interruption",
				origin: "provider",
				retry: "resume",
				message: "seat lost",
				guidance: "Resume when a seat is available.",
			},
		} as RunResult;
		const fx = await fixture(interrupted, { checkpoint: true });
		const finalizer = createWorkflowTaskFinalizer({
			journal: fx.journal,
			artifacts: fx.artifacts,
			binding: binding(client({})),
		});

		await expect(finalizer.finalize(fx.taskId)).resolves.toMatchObject({
			outcome: "interrupted",
			runStatus: "interrupted",
		});
		await expectCheckpointCancelledFirst(
			fx.journal,
			fx.checkpointId,
			fx.checkpointExecutionId,
			"interrupted",
		);
		expect((await projection(fx.journal)).tasks[fx.taskId]?.status).toBe(
			"interrupted",
		);
	});

	it("cancels the open checkpoint before a cleanup-blocked child blocks the run", async () => {
		const fx = await fixture(runResult("cleanup-blocked"), {
			checkpoint: true,
		});
		const finalizer = createWorkflowTaskFinalizer({
			journal: fx.journal,
			artifacts: fx.artifacts,
			binding: binding(
				client({
					release: vi.fn(async () => ({
						runId: "run_finalizer",
						attemptId: "attempt_finalizer",
						status: "cleanup-blocked" as const,
					})),
				}),
			),
		});

		await expect(finalizer.finalize(fx.taskId)).resolves.toMatchObject({
			outcome: "cleanup-blocked",
			runStatus: "cleanup-blocked",
		});
		await expectCheckpointCancelledFirst(
			fx.journal,
			fx.checkpointId,
			fx.checkpointExecutionId,
			"cleanup-blocked",
		);
		expect((await projection(fx.journal)).tasks[fx.taskId]?.status).toBe(
			"cleanup-blocked",
		);
	});

	it("leaves a run without open checkpoints on its ordinary failure ladder", async () => {
		const fx = await fixture(runResult("failed"));
		const before = (await fx.journal.readEvents()).length;
		const finalizer = createWorkflowTaskFinalizer({
			journal: fx.journal,
			artifacts: fx.artifacts,
			binding: binding(
				client({
					release: vi.fn(async () => ({
						runId: "run_finalizer",
						attemptId: "attempt_finalizer",
						status: "failed" as const,
					})),
				}),
			),
		});

		await expect(finalizer.finalize(fx.taskId)).resolves.toMatchObject({
			outcome: "failed",
			runStatus: "failed",
		});
		const appended = (await fx.journal.readEvents()).slice(before);
		expect(appended.map((event) => event.type)).toEqual([
			"task-execution-release-intended",
			"task-execution-released",
			"task-execution-terminal",
			"task-status-changed",
			"run-status-changed",
		]);
		expect(
			appended.some(
				(event) =>
					event.type === "task-status-changed" &&
					(event.data as { to: string }).to === "cancelled",
			),
		).toBe(false);
	});
});
