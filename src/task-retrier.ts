import { RetryBackoffError, type RunReceipt } from "@vegardx/pi-subagent";
import { Value } from "typebox/value";
import { currentSubagentAttemptId } from "./attempts.js";
import {
	type AgentTaskSpec,
	type MaterializedAgentTask,
	type WorkflowTaskId,
	WorkflowTaskIdSchema,
} from "./contracts.js";
import type {
	TaskExecutionProjection,
	WorkflowEventInput,
	WorkflowStateProjection,
	WorkflowTaskProjection,
} from "./events.js";
import type { WorkflowRunJournal } from "./persistence/journal.js";
import type { WorkflowSubagentBinding } from "./subagent-provider.js";

export type WorkflowAttemptKind = "retry" | "resume";

export type WorkflowAttemptDecision =
	| { readonly kind: "attempt"; readonly receipt: RunReceipt }
	| { readonly kind: "none" };

export interface WorkflowTaskRetrier {
	/**
	 * Decides whether the settled agent execution of `taskId` may start a
	 * retry or resume attempt under its policy, persists the intent, performs
	 * the idempotent attempt call (waiting out backoff under the stop signal
	 * and deadline), and records the receipt. Also recovers an intent left
	 * open by a crash. Returns the new attempt receipt or `none`.
	 */
	consider(taskId: WorkflowTaskId): Promise<WorkflowAttemptDecision>;
	/** Declines an open attempt intent so finalization can proceed. */
	decline(taskId: WorkflowTaskId, reason: string): Promise<void>;
}

export interface WorkflowTaskRetrierOptions {
	readonly journal: WorkflowRunJournal;
	readonly binding: WorkflowSubagentBinding;
	readonly signal: () => AbortSignal;
	readonly deadlineAt?: string;
}

export class WorkflowAttemptError extends Error {
	constructor(
		readonly stage: "validation" | "attempt" | "reconciliation",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "WorkflowAttemptError";
	}
}

const MESSAGES = Object.freeze({
	stopped: "Workflow stop requested before the attempt.",
	deadline: "Workflow deadline passed before the attempt.",
	refused: "Subagent refused the attempt.",
	uncertain: "Attempt call ended without a durable receipt.",
});

interface AgentSelection {
	readonly task: WorkflowTaskProjection & {
		readonly task: MaterializedAgentTask;
	};
	readonly execution: TaskExecutionProjection;
}

function receiptedAttempts(
	execution: TaskExecutionProjection,
	kind: WorkflowAttemptKind,
): number {
	return (execution.attempts ?? []).filter(
		(attempt) =>
			attempt.kind === kind && attempt.subagentAttemptId !== undefined,
	).length;
}

function policyDecision(
	spec: AgentTaskSpec,
	execution: TaskExecutionProjection,
):
	| { kind: WorkflowAttemptKind; failureCode: string; failureRetry: string }
	| undefined {
	const settlement = execution.settlement;
	if (!settlement || execution.attemptsClosed) return undefined;
	const failure = settlement.evidence.failure;
	if (!failure) return undefined;
	if (
		settlement.evidence.status === "failed" &&
		spec.request.retry &&
		(failure.retry === "backoff" || failure.retry === "manual") &&
		spec.request.retry.on.includes(failure.retry) &&
		receiptedAttempts(execution, "retry") < spec.request.retry.attempts
	) {
		return {
			kind: "retry",
			failureCode: failure.code,
			failureRetry: failure.retry,
		};
	}
	if (
		settlement.evidence.status === "interrupted" &&
		spec.request.resume &&
		failure.retry === "resume" &&
		receiptedAttempts(execution, "resume") < spec.request.resume.attempts
	) {
		return {
			kind: "resume",
			failureCode: failure.code,
			failureRetry: failure.retry,
		};
	}
	return undefined;
}

export function createWorkflowTaskRetrier(
	options: WorkflowTaskRetrierOptions,
): WorkflowTaskRetrier {
	const { journal, binding } = options;
	if (
		binding.workflowRunId !== journal.runId ||
		binding.ownerId !== `pi-workflow:${journal.runId}`
	) {
		throw new WorkflowAttemptError(
			"validation",
			"Subagent owner binding does not match the workflow journal.",
		);
	}
	if (
		options.deadlineAt !== undefined &&
		Number.isNaN(Date.parse(options.deadlineAt))
	) {
		throw new WorkflowAttemptError(
			"validation",
			"Workflow deadline is invalid.",
		);
	}
	const chains = new Map<WorkflowTaskId, Promise<unknown>>();

	async function state(): Promise<WorkflowStateProjection> {
		return journal.readState();
	}

	async function append(input: WorkflowEventInput): Promise<void> {
		await journal.appendEvent(input);
	}

	function select(
		current: WorkflowStateProjection,
		taskId: WorkflowTaskId,
	): AgentSelection | undefined {
		if (!Value.Check(WorkflowTaskIdSchema, taskId)) {
			throw new WorkflowAttemptError(
				"validation",
				"Workflow task id is invalid.",
			);
		}
		const task = current.tasks[taskId];
		if (!task?.committed || task.task.spec.kind !== "agent") return undefined;
		const execution = task.currentExecutionId
			? current.executions[task.currentExecutionId]
			: undefined;
		if (!execution) return undefined;
		return { task: task as AgentSelection["task"], execution };
	}

	function stopReason(): string | undefined {
		if (options.signal().aborted) return MESSAGES.stopped;
		if (
			options.deadlineAt !== undefined &&
			Date.parse(options.deadlineAt) <= Date.now()
		) {
			return MESSAGES.deadline;
		}
		return undefined;
	}

	function waitUntil(
		retryAt: string,
	): Promise<"elapsed" | "stopped" | "deadline"> {
		const signal = options.signal();
		const target = Date.parse(retryAt);
		if (Number.isNaN(target)) return Promise.resolve("elapsed");
		const deadline =
			options.deadlineAt === undefined
				? Number.POSITIVE_INFINITY
				: Date.parse(options.deadlineAt);
		if (target >= deadline) return Promise.resolve("deadline");
		const delay = Math.max(0, target - Date.now());
		if (delay === 0) return Promise.resolve("elapsed");
		if (signal.aborted) return Promise.resolve("stopped");
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve("elapsed");
			}, delay);
			const onAbort = () => {
				clearTimeout(timer);
				resolve("stopped");
			};
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	async function appendDeclined(
		execution: TaskExecutionProjection,
		reason: string,
	): Promise<void> {
		const open = (execution.attempts ?? []).at(-1);
		const runId = execution.launchReceipt?.subagentRunId;
		if (!open || !runId) {
			throw new WorkflowAttemptError(
				"validation",
				"Open attempt intent is missing from the projection.",
			);
		}
		await append({
			type: "task-execution-attempt-declined",
			data: {
				executionId: execution.execution.id,
				subagentRunId: runId,
				ordinal: open.ordinal,
				reason,
			},
		});
	}

	async function appendReceipt(
		execution: TaskExecutionProjection,
		receipt: RunReceipt,
	): Promise<void> {
		const open = (execution.attempts ?? []).at(-1);
		if (!open) {
			throw new WorkflowAttemptError(
				"validation",
				"Open attempt intent is missing from the projection.",
			);
		}
		await append({
			type: "task-execution-attempt-receipted",
			data: {
				executionId: execution.execution.id,
				subagentRunId: receipt.runId,
				ordinal: open.ordinal,
				subagentAttemptId: receipt.attemptId,
				status: receipt.status,
			},
		});
	}

	/**
	 * Performs the attempt call for an open intent. Retries the call after an
	 * elapsed backoff; a stop or deadline while waiting declines the intent.
	 * A call that throws for any other reason is reconciled by operation id:
	 * a new attempt id means the attempt exists and is adopted.
	 */
	async function performAttempt(
		selection: AgentSelection,
	): Promise<WorkflowAttemptDecision> {
		const execution = selection.execution;
		const open = (execution.attempts ?? []).at(-1);
		const runId = execution.launchReceipt?.subagentRunId;
		if (!open || open.subagentAttemptId !== undefined || !runId) {
			throw new WorkflowAttemptError(
				"validation",
				"Attempt intent is not open.",
			);
		}
		const operationId =
			execution.execution.kind === "agent"
				? execution.execution.operationId
				: undefined;
		if (!operationId) {
			throw new WorkflowAttemptError(
				"validation",
				"Attempt requires an agent execution.",
			);
		}
		for (;;) {
			const stopped = stopReason();
			if (stopped) {
				await appendDeclined(execution, stopped);
				return { kind: "none" };
			}
			let receipt: RunReceipt | undefined;
			let refusal: string | undefined;
			try {
				receipt =
					open.kind === "retry"
						? await binding.client.retry(runId)
						: await binding.client.resume(runId);
			} catch (error) {
				if (error instanceof RetryBackoffError) {
					const outcome = await waitUntil(error.retryAt);
					if (outcome === "deadline") {
						await appendDeclined(execution, MESSAGES.deadline);
						return { kind: "none" };
					}
					if (outcome === "stopped") {
						await appendDeclined(execution, stopReason() ?? MESSAGES.stopped);
						return { kind: "none" };
					}
					continue;
				}
				refusal = MESSAGES.refused;
			}
			if (!receipt) {
				// The call may have created the attempt before failing; consult the
				// durable operation mapping before declining.
				let current: RunReceipt | undefined;
				try {
					current = await binding.client.findByOperation(operationId);
				} catch (error) {
					throw new WorkflowAttemptError(
						"reconciliation",
						"Attempt reconciliation by operation id failed.",
						{ cause: error },
					);
				}
				if (current && current.attemptId !== open.previousAttemptId) {
					receipt = current;
				} else {
					await appendDeclined(execution, refusal ?? MESSAGES.uncertain);
					return { kind: "none" };
				}
			}
			if (
				receipt.runId !== runId ||
				receipt.attemptId === open.previousAttemptId
			) {
				throw new WorkflowAttemptError(
					"attempt",
					"Attempt receipt does not match the persisted child identity.",
				);
			}
			await appendReceipt(execution, receipt);
			return { kind: "attempt", receipt };
		}
	}

	async function considerCurrent(
		taskId: WorkflowTaskId,
	): Promise<WorkflowAttemptDecision> {
		let current = await state();
		let selection = select(current, taskId);
		if (!selection) return { kind: "none" };
		let execution = selection.execution;
		if (execution.phase === "attempt-intended") {
			return performAttempt(selection);
		}
		if (execution.phase !== "settled") return { kind: "none" };
		if (
			current.status !== "running" &&
			current.status !== "waiting" &&
			current.status !== "finalizing"
		) {
			return { kind: "none" };
		}
		const decision = policyDecision(selection.task.task.spec, execution);
		if (!decision) return { kind: "none" };
		const stopped = stopReason();
		if (stopped) return { kind: "none" };
		const previousAttemptId = currentSubagentAttemptId(execution);
		const runId = execution.launchReceipt?.subagentRunId;
		if (!previousAttemptId || !runId) return { kind: "none" };
		await append({
			type: "task-execution-attempt-intended",
			data: {
				executionId: execution.execution.id,
				subagentRunId: runId,
				kind: decision.kind,
				ordinal: 2 + (execution.attempts?.length ?? 0),
				previousAttemptId,
				failureCode: decision.failureCode,
				failureRetry: decision.failureRetry as "backoff" | "manual" | "resume",
				origin: "policy",
			},
		});
		current = await state();
		selection = select(current, taskId);
		execution = selection?.execution ?? execution;
		if (!selection || execution.phase !== "attempt-intended") {
			throw new WorkflowAttemptError(
				"validation",
				"Attempt intent was not durably recorded.",
			);
		}
		return performAttempt(selection);
	}

	async function declineCurrent(
		taskId: WorkflowTaskId,
		reason: string,
	): Promise<void> {
		const current = await state();
		const selection = select(current, taskId);
		if (selection?.execution.phase !== "attempt-intended") return;
		await appendDeclined(selection.execution, reason);
	}

	function serialized<T>(
		taskId: WorkflowTaskId,
		operation: () => Promise<T>,
	): Promise<T> {
		const predecessor = chains.get(taskId) ?? Promise.resolve();
		const next = predecessor.then(operation, operation);
		const settled = next.then(
			() => undefined,
			() => undefined,
		);
		chains.set(taskId, settled);
		void settled.then(() => {
			if (chains.get(taskId) === settled) chains.delete(taskId);
		});
		return next;
	}

	return Object.freeze({
		consider: (taskId: WorkflowTaskId) =>
			serialized(taskId, () => considerCurrent(taskId)),
		decline: (taskId: WorkflowTaskId, reason: string) =>
			serialized(taskId, () => declineCurrent(taskId, reason)),
	});
}
