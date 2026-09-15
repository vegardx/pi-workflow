import { randomUUID } from "node:crypto";
import path from "node:path";
import {
	RetryBackoffError,
	type RunResult,
	type SubagentClient,
} from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentSubagentAttemptId } from "../src/attempts.js";
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
	createWorkflowTaskRetrier,
	WorkflowAttemptError,
} from "../src/task-retrier.js";

const hash = "a".repeat(64);
const RUN_ID = "workflow_retrier";
const CHILD_RUN = "run_retrier";
const LAUNCH_ATTEMPT = "attempt_retrier";
const RETRY_ATTEMPT = "attempt_retrier2";
const leases = new Set<WorkflowRunLease>();

type RetryClass = "backoff" | "manual";
type FailureRetry = "never" | "manual" | "backoff" | "resume" | "reconcile";

interface Policies {
	readonly retry?: { attempts: number; on?: readonly RetryClass[] };
	readonly resume?: { attempts: number };
}

function request(policies: Policies = {}) {
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
			cumulativeRuntimeMs: 300_000,
			attemptTimeoutMs: 300_000,
			totalTokens: 1_000_000,
			cost: 10,
			outputBytes: 1024,
			workspaceWriteBytes: 0,
			retries: policies.retry?.attempts ?? 0,
			resumes: policies.resume?.attempts ?? 0,
		},
		...(policies.retry ? { retry: policies.retry } : {}),
		...(policies.resume ? { resume: policies.resume } : {}),
	};
}

function failedResult(
	retry: FailureRetry,
	status: "failed" | "interrupted" = "failed",
): RunResult {
	const interrupted = status === "interrupted";
	return {
		runId: CHILD_RUN,
		status,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: 0.01,
		},
		usageComplete: true,
		runtimeMs: 100,
		failure: {
			code: interrupted ? "seat-interruption" : "tool",
			origin: interrupted ? "service" : "tool",
			retry,
			message: interrupted ? "seat lost" : "tool failed",
			guidance: "Inspect the child.",
		},
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
	};
}

function evidence(
	result: RunResult,
	attemptOrdinal: number,
): SubagentTerminalEvidence {
	return {
		kind: "subagent",
		attemptOrdinal,
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

function receipt(attemptId: string, status: "active" | "failed" = "active") {
	return { runId: CHILD_RUN, attemptId, status };
}

function client(overrides: Partial<SubagentClient> = {}): SubagentClient {
	const unavailable = vi.fn(async () => {
		throw new Error("not implemented");
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
		retry: vi.fn(async () => receipt(RETRY_ATTEMPT)),
		resume: vi.fn(async () => receipt(RETRY_ATTEMPT)),
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
		workflowRunId: RUN_ID,
		ownerId: `pi-workflow:${RUN_ID}`,
		client: ownerClient,
	};
}

/**
 * Seeds one agent execution to phase `settled` with the given terminal
 * result as its first-attempt settlement, the way the scheduler leaves it
 * before the retrier runs.
 */
async function fixture(result: RunResult, policies: Policies = {}) {
	const root = path.resolve(".pi", "test-retrier", `run-${randomUUID()}`);
	const lease = await acquireWorkflowRunLease({
		storeRoot: root,
		runId: RUN_ID,
		ownerId: "retrier-test",
	});
	leases.add(lease);
	const journal = await WorkflowRunJournal.open(root, RUN_ID, lease);
	await journal.append("run-created", {
		definitionIdentitySha256: hash,
		inputSha256: hash,
	});
	const materializer = new WorkflowTaskMaterializer({
		runId: RUN_ID,
		definitionIdentitySha256: hash,
		inputSha256: hash,
	});
	const handle = materializer.agent("answer", request(policies));
	for (const event of materializer.closeEpoch("final", [handle]).events) {
		await journal.appendEvent(event);
	}
	await journal.append("run-status-changed", {
		from: "created",
		to: "running",
	});
	const taskId = handle.ref.taskId;
	await journal.append("task-status-changed", {
		taskId,
		from: "pending",
		to: "ready",
	});
	const current = reduceWorkflowEvents(await journal.readEvents());
	const task = current.tasks[taskId];
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
		preflightId: "preflight-retrier",
		planIdentitySha256: hash,
		plannedSubagentRunId: CHILD_RUN,
		plannedSubagentAttemptId: LAUNCH_ATTEMPT,
		expiresAt: "2099-01-01T00:00:00.000Z",
	});
	await journal.append("task-execution-launch-intended", {
		executionId,
		operationId,
		preflightId: "preflight-retrier",
		planIdentitySha256: hash,
	});
	await journal.append("task-execution-launch-receipted", {
		executionId,
		operationId,
		subagentRunId: CHILD_RUN,
		subagentAttemptId: LAUNCH_ATTEMPT,
		status: "active",
	});
	await journal.append("task-status-changed", {
		taskId,
		from: "ready",
		to: "running",
	});
	await settleAttempt(journal, executionId, LAUNCH_ATTEMPT, result, 1);
	return { root, lease, journal, taskId, executionId, operationId };
}

async function settleAttempt(
	journal: WorkflowRunJournal,
	executionId: string,
	attemptId: string,
	result: RunResult,
	attemptOrdinal: number,
) {
	await journal.append("task-execution-child-observed", {
		executionId,
		subagentRunId: CHILD_RUN,
		subagentAttemptId: attemptId,
		status: result.status,
	});
	await journal.append("task-execution-child-settled", {
		executionId,
		evidence: evidence(result, attemptOrdinal),
	});
}

function retrier(
	journal: WorkflowRunJournal,
	ownerClient: SubagentClient,
	options: { signal?: AbortSignal; deadlineAt?: string } = {},
) {
	const signal = options.signal ?? new AbortController().signal;
	return createWorkflowTaskRetrier({
		journal,
		binding: binding(ownerClient),
		signal: () => signal,
		...(options.deadlineAt ? { deadlineAt: options.deadlineAt } : {}),
	});
}

async function executionOf(journal: WorkflowRunJournal, executionId: string) {
	const execution = reduceWorkflowEvents(await journal.readEvents()).executions[
		executionId
	];
	if (!execution) throw new Error("missing execution");
	return execution;
}

async function eventsOfType(journal: WorkflowRunJournal, type: string) {
	return (await journal.readEvents()).filter((event) => event.type === type);
}

async function eventCount(journal: WorkflowRunJournal) {
	return (await journal.readEvents()).length;
}

function inFuture(ms: number) {
	return new Date(Date.now() + ms).toISOString();
}

afterEach(async () => {
	await Promise.all([...leases].map((lease) => lease.release()));
	leases.clear();
});

describe("workflow task retrier", () => {
	it("rejects a binding that does not match the journal", async () => {
		const { journal } = await fixture(failedResult("backoff"));
		expect(() =>
			createWorkflowTaskRetrier({
				journal,
				binding: { ...binding(client()), ownerId: "pi-workflow:other" },
				signal: () => new AbortController().signal,
			}),
		).toThrow(WorkflowAttemptError);
		expect(() =>
			createWorkflowTaskRetrier({
				journal,
				binding: binding(client()),
				signal: () => new AbortController().signal,
				deadlineAt: "not a date",
			}),
		).toThrowError("Workflow deadline is invalid.");
	});

	describe("policy decisions", () => {
		it("returns none without a policy and appends nothing", async () => {
			const { journal, taskId } = await fixture(failedResult("backoff"));
			const ownerClient = client();
			const before = await eventCount(journal);
			await expect(
				retrier(journal, ownerClient).consider(taskId),
			).resolves.toEqual({ kind: "none" });
			expect(await eventCount(journal)).toBe(before);
			expect(ownerClient.retry).not.toHaveBeenCalled();
			expect(ownerClient.resume).not.toHaveBeenCalled();
		});

		it("never enters the attempt path for never or reconcile classifications", async () => {
			for (const classification of ["never", "reconcile"] as const) {
				const { journal, taskId } = await fixture(
					failedResult(classification),
					{
						retry: { attempts: 3, on: ["backoff", "manual"] },
						resume: { attempts: 3 },
					},
				);
				const ownerClient = client();
				const before = await eventCount(journal);
				await expect(
					retrier(journal, ownerClient).consider(taskId),
				).resolves.toEqual({ kind: "none" });
				expect(await eventCount(journal)).toBe(before);
				expect(ownerClient.retry).not.toHaveBeenCalled();
				expect(ownerClient.resume).not.toHaveBeenCalled();
			}
		});

		it("honours retry.on for manual failures", async () => {
			const backoffOnly = await fixture(failedResult("manual"), {
				retry: { attempts: 1, on: ["backoff"] },
			});
			const untouched = client();
			await expect(
				retrier(backoffOnly.journal, untouched).consider(backoffOnly.taskId),
			).resolves.toEqual({ kind: "none" });
			expect(untouched.retry).not.toHaveBeenCalled();
			expect(
				await eventsOfType(
					backoffOnly.journal,
					"task-execution-attempt-intended",
				),
			).toHaveLength(0);

			const manual = await fixture(failedResult("manual"), {
				retry: { attempts: 1, on: ["manual"] },
			});
			const ownerClient = client();
			await expect(
				retrier(manual.journal, ownerClient).consider(manual.taskId),
			).resolves.toEqual({
				kind: "attempt",
				receipt: receipt(RETRY_ATTEMPT),
			});
			expect(ownerClient.retry).toHaveBeenCalledWith(CHILD_RUN);
			const [intent] = await eventsOfType(
				manual.journal,
				"task-execution-attempt-intended",
			);
			expect(intent?.data).toMatchObject({
				kind: "retry",
				failureCode: "tool",
				failureRetry: "manual",
			});
		});

		it("does not retry an interrupted child without a resume policy", async () => {
			const { journal, taskId } = await fixture(
				failedResult("resume", "interrupted"),
				{ retry: { attempts: 2, on: ["backoff", "manual"] } },
			);
			const ownerClient = client();
			await expect(
				retrier(journal, ownerClient).consider(taskId),
			).resolves.toEqual({ kind: "none" });
			expect(ownerClient.retry).not.toHaveBeenCalled();
			expect(ownerClient.resume).not.toHaveBeenCalled();
		});
	});

	describe("attempt journal", () => {
		it("persists intent, calls retry once, and records the receipt", async () => {
			const { journal, taskId, executionId } = await fixture(
				failedResult("backoff"),
				{ retry: { attempts: 1 } },
			);
			const ownerClient = client();
			const decision = await retrier(journal, ownerClient).consider(taskId);
			expect(decision).toEqual({
				kind: "attempt",
				receipt: receipt(RETRY_ATTEMPT),
			});
			expect(ownerClient.retry).toHaveBeenCalledTimes(1);
			expect(ownerClient.retry).toHaveBeenCalledWith(CHILD_RUN);
			expect(ownerClient.resume).not.toHaveBeenCalled();

			const events = await journal.readEvents();
			const tail = events.slice(-2).map((event) => event.type);
			expect(tail).toEqual([
				"task-execution-attempt-intended",
				"task-execution-attempt-receipted",
			]);
			expect(events.at(-2)?.data).toEqual({
				executionId,
				subagentRunId: CHILD_RUN,
				kind: "retry",
				ordinal: 2,
				previousAttemptId: LAUNCH_ATTEMPT,
				failureCode: "tool",
				failureRetry: "backoff",
			});
			expect(events.at(-1)?.data).toEqual({
				executionId,
				subagentRunId: CHILD_RUN,
				ordinal: 2,
				subagentAttemptId: RETRY_ATTEMPT,
				status: "active",
			});

			const execution = await executionOf(journal, executionId);
			expect(execution.phase).toBe("launched");
			expect(execution.settlement).toBeUndefined();
			expect(execution.observation).toBeUndefined();
			expect(execution.priorSettlements).toHaveLength(1);
			expect(execution.priorSettlements?.[0]?.evidence).toMatchObject({
				status: "failed",
				attemptOrdinal: 1,
			});
			expect(execution.attempts).toMatchObject([
				{
					kind: "retry",
					ordinal: 2,
					previousAttemptId: LAUNCH_ATTEMPT,
					subagentAttemptId: RETRY_ATTEMPT,
					status: "active",
				},
			]);
			expect(execution.attemptsClosed).toBeUndefined();
			expect(currentSubagentAttemptId(execution)).toBe(RETRY_ATTEMPT);
		});

		it("resumes an interrupted child classified resume through resume()", async () => {
			const { journal, taskId, executionId } = await fixture(
				failedResult("resume", "interrupted"),
				{ resume: { attempts: 1 } },
			);
			const ownerClient = client();
			await expect(
				retrier(journal, ownerClient).consider(taskId),
			).resolves.toEqual({ kind: "attempt", receipt: receipt(RETRY_ATTEMPT) });
			expect(ownerClient.resume).toHaveBeenCalledTimes(1);
			expect(ownerClient.resume).toHaveBeenCalledWith(CHILD_RUN);
			expect(ownerClient.retry).not.toHaveBeenCalled();
			const [intent] = await eventsOfType(
				journal,
				"task-execution-attempt-intended",
			);
			expect(intent?.data).toMatchObject({
				kind: "resume",
				ordinal: 2,
				previousAttemptId: LAUNCH_ATTEMPT,
				failureCode: "seat-interruption",
				failureRetry: "resume",
			});
			const execution = await executionOf(journal, executionId);
			expect(execution.phase).toBe("launched");
			expect(execution.attempts?.[0]).toMatchObject({
				kind: "resume",
				subagentAttemptId: RETRY_ATTEMPT,
			});
			expect(execution.priorSettlements?.[0]?.evidence.status).toBe(
				"interrupted",
			);
		});

		it("stops after the policy's receipted attempts are exhausted", async () => {
			const { journal, taskId, executionId } = await fixture(
				failedResult("backoff"),
				{ retry: { attempts: 1 } },
			);
			const ownerClient = client();
			const subject = retrier(journal, ownerClient);
			await expect(subject.consider(taskId)).resolves.toMatchObject({
				kind: "attempt",
			});
			await settleAttempt(
				journal,
				executionId,
				RETRY_ATTEMPT,
				failedResult("backoff"),
				2,
			);
			const before = await eventCount(journal);
			await expect(subject.consider(taskId)).resolves.toEqual({
				kind: "none",
			});
			expect(await eventCount(journal)).toBe(before);
			expect(ownerClient.retry).toHaveBeenCalledTimes(1);
			const execution = await executionOf(journal, executionId);
			expect(execution.phase).toBe("settled");
			expect(execution.settlement?.evidence.attemptOrdinal).toBe(2);
			expect(execution.attempts).toHaveLength(1);
			expect(
				await eventsOfType(journal, "task-execution-attempt-intended"),
			).toHaveLength(1);
		});

		it("returns none for a run that is stopping", async () => {
			const { journal, taskId } = await fixture(failedResult("backoff"), {
				retry: { attempts: 1 },
			});
			await journal.append("run-status-changed", {
				from: "running",
				to: "stopping",
				reason: "operator stop",
			});
			const ownerClient = client();
			const before = await eventCount(journal);
			await expect(
				retrier(journal, ownerClient).consider(taskId),
			).resolves.toEqual({ kind: "none" });
			expect(await eventCount(journal)).toBe(before);
			expect(ownerClient.retry).not.toHaveBeenCalled();
		});
	});

	describe("backoff, stop, and deadline", () => {
		it("waits out a backoff and calls retry again without a second intent", async () => {
			const { journal, taskId } = await fixture(failedResult("backoff"), {
				retry: { attempts: 1 },
			});
			const retry = vi
				.fn()
				.mockRejectedValueOnce(new RetryBackoffError(inFuture(200)))
				.mockResolvedValueOnce(receipt(RETRY_ATTEMPT));
			const ownerClient = client({ retry });
			const started = Date.now();
			await expect(
				retrier(journal, ownerClient).consider(taskId),
			).resolves.toEqual({ kind: "attempt", receipt: receipt(RETRY_ATTEMPT) });
			expect(Date.now() - started).toBeGreaterThanOrEqual(150);
			expect(retry).toHaveBeenCalledTimes(2);
			expect(retry.mock.calls).toEqual([[CHILD_RUN], [CHILD_RUN]]);
			expect(
				await eventsOfType(journal, "task-execution-attempt-intended"),
			).toHaveLength(1);
			expect(
				await eventsOfType(journal, "task-execution-attempt-receipted"),
			).toHaveLength(1);
			expect(ownerClient.findByOperation).not.toHaveBeenCalled();
		});

		it("declines the intent when stop arrives during backoff", async () => {
			const { journal, taskId, executionId } = await fixture(
				failedResult("backoff"),
				{ retry: { attempts: 1 } },
			);
			const controller = new AbortController();
			// Abort only once the backoff wait has started so the decline is
			// attributed to the wait, not to the pre-call stop check.
			const retry = vi.fn(async () => {
				setTimeout(() => controller.abort(new Error("stop")), 50);
				throw new RetryBackoffError(inFuture(60 * 60 * 1000));
			});
			const ownerClient = client({ retry });
			const started = Date.now();
			await expect(
				retrier(journal, ownerClient, {
					signal: controller.signal,
				}).consider(taskId),
			).resolves.toEqual({ kind: "none" });
			expect(Date.now() - started).toBeLessThan(30_000);
			expect(retry).toHaveBeenCalledTimes(1);
			const [declined] = await eventsOfType(
				journal,
				"task-execution-attempt-declined",
			);
			expect(declined?.data).toEqual({
				executionId,
				subagentRunId: CHILD_RUN,
				ordinal: 2,
				reason: "Workflow stop requested before the attempt.",
			});
			const execution = await executionOf(journal, executionId);
			expect(execution.phase).toBe("settled");
			expect(execution.attemptsClosed).toBe(true);
			expect(execution.settlement?.evidence.attemptOrdinal).toBe(1);
			expect(execution.attempts).toMatchObject([
				{ kind: "retry", ordinal: 2, previousAttemptId: LAUNCH_ATTEMPT },
			]);
			expect(execution.attempts?.[0]?.subagentAttemptId).toBeUndefined();
			expect(execution.attempts?.[0]?.declinedSequence).toBeDefined();
			expect(currentSubagentAttemptId(execution)).toBe(LAUNCH_ATTEMPT);
		});

		it("returns none without intent once the deadline has passed", async () => {
			const { journal, taskId } = await fixture(failedResult("backoff"), {
				retry: { attempts: 1 },
			});
			const ownerClient = client();
			const before = await eventCount(journal);
			await expect(
				retrier(journal, ownerClient, {
					deadlineAt: new Date(Date.now() - 1000).toISOString(),
				}).consider(taskId),
			).resolves.toEqual({ kind: "none" });
			expect(await eventCount(journal)).toBe(before);
			expect(ownerClient.retry).not.toHaveBeenCalled();
		});

		it("declines with the deadline reason when backoff outlasts the deadline", async () => {
			const { journal, taskId, executionId } = await fixture(
				failedResult("backoff"),
				{ retry: { attempts: 1 } },
			);
			const retry = vi
				.fn()
				.mockRejectedValue(new RetryBackoffError(inFuture(120_000)));
			const ownerClient = client({ retry });
			const started = Date.now();
			await expect(
				retrier(journal, ownerClient, {
					deadlineAt: inFuture(60_000),
				}).consider(taskId),
			).resolves.toEqual({ kind: "none" });
			expect(Date.now() - started).toBeLessThan(10_000);
			expect(retry).toHaveBeenCalledTimes(1);
			const execution = await executionOf(journal, executionId);
			expect(execution.phase).toBe("settled");
			expect(execution.attemptsClosed).toBe(true);
			const [declined] = await eventsOfType(
				journal,
				"task-execution-attempt-declined",
			);
			expect(declined?.data).toMatchObject({
				ordinal: 2,
				reason: "Workflow deadline passed before the attempt.",
			});
		});
	});

	describe("refusal and reconciliation", () => {
		it("declines a refused attempt when the operation still maps to the old attempt", async () => {
			const { journal, taskId, executionId, operationId } = await fixture(
				failedResult("backoff"),
				{ retry: { attempts: 1 } },
			);
			const ownerClient = client({
				retry: vi.fn(async () => {
					throw new Error("attempt refused");
				}),
				findByOperation: vi.fn(async () => receipt(LAUNCH_ATTEMPT, "failed")),
			});
			await expect(
				retrier(journal, ownerClient).consider(taskId),
			).resolves.toEqual({ kind: "none" });
			expect(ownerClient.findByOperation).toHaveBeenCalledWith(operationId);
			const [declined] = await eventsOfType(
				journal,
				"task-execution-attempt-declined",
			);
			expect(declined?.data).toMatchObject({
				executionId,
				ordinal: 2,
				reason: "Subagent refused the attempt.",
			});
			const execution = await executionOf(journal, executionId);
			expect(execution.phase).toBe("settled");
			expect(execution.attemptsClosed).toBe(true);
			expect(currentSubagentAttemptId(execution)).toBe(LAUNCH_ATTEMPT);
		});

		it("adopts a new attempt found by operation id after an uncertain call", async () => {
			const { journal, taskId, executionId } = await fixture(
				failedResult("backoff"),
				{ retry: { attempts: 1 } },
			);
			const ownerClient = client({
				retry: vi.fn(async () => {
					throw new Error("connection reset");
				}),
				findByOperation: vi.fn(async () => receipt(RETRY_ATTEMPT)),
			});
			await expect(
				retrier(journal, ownerClient).consider(taskId),
			).resolves.toEqual({ kind: "attempt", receipt: receipt(RETRY_ATTEMPT) });
			expect(
				await eventsOfType(journal, "task-execution-attempt-declined"),
			).toHaveLength(0);
			const [receipted] = await eventsOfType(
				journal,
				"task-execution-attempt-receipted",
			);
			expect(receipted?.data).toMatchObject({
				executionId,
				ordinal: 2,
				subagentAttemptId: RETRY_ATTEMPT,
			});
			const execution = await executionOf(journal, executionId);
			expect(execution.phase).toBe("launched");
			expect(currentSubagentAttemptId(execution)).toBe(RETRY_ATTEMPT);
		});

		it("fails closed with the intent open when reconciliation is unavailable", async () => {
			const { journal, taskId, executionId } = await fixture(
				failedResult("backoff"),
				{ retry: { attempts: 1 } },
			);
			const ownerClient = client({
				retry: vi.fn(async () => {
					throw new Error("connection reset");
				}),
				findByOperation: vi.fn(async () => {
					throw new Error("lookup unavailable");
				}),
			});
			await expect(
				retrier(journal, ownerClient).consider(taskId),
			).rejects.toMatchObject({
				name: "WorkflowAttemptError",
				stage: "reconciliation",
			});
			const execution = await executionOf(journal, executionId);
			expect(execution.phase).toBe("attempt-intended");
			expect(execution.attemptsClosed).toBeUndefined();
			expect(execution.settlement).toBeDefined();
			const types = (await journal.readEvents()).map((event) => event.type);
			expect(types.at(-1)).toBe("task-execution-attempt-intended");
		});

		it("rejects a receipt for a different child run", async () => {
			const { journal, taskId, executionId } = await fixture(
				failedResult("backoff"),
				{ retry: { attempts: 1 } },
			);
			const ownerClient = client({
				retry: vi.fn(async () => ({
					runId: "run_other",
					attemptId: RETRY_ATTEMPT,
					status: "active" as const,
				})),
			});
			await expect(
				retrier(journal, ownerClient).consider(taskId),
			).rejects.toMatchObject({
				name: "WorkflowAttemptError",
				stage: "attempt",
			});
			const execution = await executionOf(journal, executionId);
			expect(execution.phase).toBe("attempt-intended");
		});
	});

	describe("recovery", () => {
		async function crashedAfterIntent() {
			const seeded = await fixture(failedResult("backoff"), {
				retry: { attempts: 1 },
			});
			const crashing = client({
				retry: vi.fn(async () => {
					throw new Error("connection reset");
				}),
				findByOperation: vi.fn(async () => {
					throw new Error("lookup unavailable");
				}),
			});
			await expect(
				retrier(seeded.journal, crashing).consider(seeded.taskId),
			).rejects.toBeInstanceOf(WorkflowAttemptError);
			expect(
				(await executionOf(seeded.journal, seeded.executionId)).phase,
			).toBe("attempt-intended");
			return seeded;
		}

		it("performs an open intent left by a crash without a second intent", async () => {
			const { journal, taskId, executionId } = await crashedAfterIntent();
			const ownerClient = client();
			await expect(
				retrier(journal, ownerClient).consider(taskId),
			).resolves.toEqual({ kind: "attempt", receipt: receipt(RETRY_ATTEMPT) });
			expect(ownerClient.retry).toHaveBeenCalledTimes(1);
			expect(
				await eventsOfType(journal, "task-execution-attempt-intended"),
			).toHaveLength(1);
			expect(
				await eventsOfType(journal, "task-execution-attempt-receipted"),
			).toHaveLength(1);
			const execution = await executionOf(journal, executionId);
			expect(execution.phase).toBe("launched");
			expect(execution.attempts).toHaveLength(1);
		});

		it("returns none over a receipted attempt without touching the child", async () => {
			const { journal, taskId, executionId } = await fixture(
				failedResult("backoff"),
				{ retry: { attempts: 3 } },
			);
			await retrier(journal, client()).consider(taskId);
			expect((await executionOf(journal, executionId)).phase).toBe("launched");
			const ownerClient = client();
			const before = await eventCount(journal);
			await expect(
				retrier(journal, ownerClient).consider(taskId),
			).resolves.toEqual({ kind: "none" });
			expect(await eventCount(journal)).toBe(before);
			expect(ownerClient.retry).not.toHaveBeenCalled();
			expect(ownerClient.findByOperation).not.toHaveBeenCalled();
		});

		it("declines an open intent on request and ignores a settled execution", async () => {
			const { journal, taskId, executionId } = await crashedAfterIntent();
			const subject = retrier(journal, client());
			await subject.decline(taskId, "Operator stop before recovery.");
			const [declined] = await eventsOfType(
				journal,
				"task-execution-attempt-declined",
			);
			expect(declined?.data).toEqual({
				executionId,
				subagentRunId: CHILD_RUN,
				ordinal: 2,
				reason: "Operator stop before recovery.",
			});
			const execution = await executionOf(journal, executionId);
			expect(execution.phase).toBe("settled");
			expect(execution.attemptsClosed).toBe(true);

			const before = await eventCount(journal);
			await subject.decline(taskId, "Nothing left to decline.");
			expect(await eventCount(journal)).toBe(before);
			await expect(subject.consider(taskId)).resolves.toEqual({
				kind: "none",
			});
			expect(await eventCount(journal)).toBe(before);
		});

		it("ignores unknown tasks and rejects malformed task ids", async () => {
			const { journal } = await fixture(failedResult("backoff"), {
				retry: { attempts: 1 },
			});
			const subject = retrier(journal, client());
			await expect(subject.consider("task_missing")).resolves.toEqual({
				kind: "none",
			});
			await expect(subject.consider("")).rejects.toMatchObject({
				name: "WorkflowAttemptError",
				stage: "validation",
			});
		});
	});
});
