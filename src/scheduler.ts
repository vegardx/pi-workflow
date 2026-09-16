import { isDeepStrictEqual } from "node:util";
import {
	isRunResult,
	type ReconcileResult,
	type RunReceipt,
	type RunResult,
	RunStatusSchema,
} from "@vegardx/pi-subagent";
import { Value } from "typebox/value";
import type { WorkflowArtifactStore } from "./artifact-store.js";
import { currentSubagentAttemptId } from "./attempts.js";
import {
	budgetExceededReason,
	settledWorkflowUsage,
	workflowUsage,
} from "./budget.js";
import {
	CHECKPOINT_RUN_ENDING_REASON,
	cancelOpenWorkflowCheckpoints,
	createWorkflowCheckpointTaskExecutor,
	type WorkflowCheckpointDecisionInput,
	type WorkflowCheckpointExecutionResult,
	type WorkflowCheckpointTaskExecutor,
} from "./checkpoint-executor.js";
import type {
	SubagentTerminalEvidence,
	TaskExecutionId,
	TaskRole,
	WorkflowRunStatus,
	WorkflowTaskId,
	WorkflowTaskStatus,
} from "./contracts.js";
import type { WorkflowDecisionRecordStore } from "./decision-store.js";
import type { WorkflowBudget } from "./definition.js";
import type {
	TaskExecutionProjection,
	WorkflowEventInput,
	WorkflowStateProjection,
	WorkflowTaskProjection,
} from "./events.js";
import {
	deriveSubagentSettlementEvidence,
	deriveWorkflowFailureSha256,
} from "./execution.js";
import {
	createWorkflowNestedRunExecutor,
	type WorkflowNestedRunExecutor,
	type WorkflowNestedRunProvider,
} from "./nested-run-executor.js";
import type { WorkflowRunJournal } from "./persistence/journal.js";
import { hasOpenCheckpoint, reduceWorkflowEvents } from "./reducer.js";
import { isReopenedTask, OPERATOR_RESUME_REASON } from "./run-actions.js";
import type { WorkflowSubagentBinding } from "./subagent-provider.js";
import type { SupportTaskRegistration } from "./support.js";
import {
	createWorkflowSupportTaskExecutor,
	type WorkflowSupportTaskExecutor,
} from "./support-executor.js";
import type { WorkflowTaskFinalizer } from "./task-finalizer.js";
import {
	createWorkflowTaskLauncher,
	type WorkflowTaskLauncher,
} from "./task-launcher.js";
import {
	createWorkflowTaskRetrier,
	type WorkflowTaskRetrier,
} from "./task-retrier.js";

const TERMINAL_CHILD_STATUSES = new Set([
	"completed",
	"failed",
	"cancelled",
	"abandoned",
	"interrupted",
	"cleanup-blocked",
]);
const DEPENDENCY_FAILURE_STATUSES = new Set<WorkflowTaskStatus>([
	"failed",
	"interrupted",
	"blocked",
	"cancelled",
	"cleanup-blocked",
	"invalidated",
]);
const ACTIVE_TASK_STATUSES = new Set<WorkflowTaskStatus>([
	"ready",
	"running",
	"waiting",
	"cancelling",
]);
const schedulerMutations = new Map<string, Promise<void>>();

export type WorkflowSchedulerOutcome =
	| {
			readonly state: "idle" | "stopping" | "terminal";
			readonly runStatus: WorkflowRunStatus;
	  }
	| {
			readonly state: "awaiting-finalization";
			readonly runStatus: WorkflowRunStatus;
			readonly taskId: WorkflowTaskId;
			readonly executionId: TaskExecutionId;
			readonly child: RunReceipt;
			readonly outcome:
				| "completed"
				| "failed"
				| "cancelled"
				| "interrupted"
				| "cleanup-blocked";
	  }
	| {
			/** This lane has nothing else to do while a checkpoint awaits a decision. */
			readonly state: "awaiting-decision";
			readonly runStatus: WorkflowRunStatus;
			readonly pendingCheckpoints: readonly {
				readonly taskId: WorkflowTaskId;
				readonly executionId: TaskExecutionId;
				readonly expiresAt?: string;
			}[];
	  };

/** pi-subagent reconcile facts for the child that was reconciled. */
export type WorkflowSchedulerReconcileFacts = Pick<
	ReconcileResult,
	"sandboxProcess" | "workspace"
>;

export type WorkflowSchedulerReconcileOutcome = WorkflowSchedulerOutcome & {
	/** Absent for nested-run reconciliation. */
	readonly subagent?: WorkflowSchedulerReconcileFacts;
};

export interface WorkflowSequentialScheduler {
	readonly concurrency: number;
	/** Aborted once durable stop intent exists; observed by support tasks. */
	readonly stopSignal: AbortSignal;
	drive(): Promise<WorkflowSchedulerOutcome>;
	reconcile(taskId: WorkflowTaskId): Promise<WorkflowSchedulerReconcileOutcome>;
	/** Records an operator decision for a waiting checkpoint under the scheduler lock. */
	decide(
		taskId: WorkflowTaskId,
		decision: WorkflowCheckpointDecisionInput,
	): Promise<WorkflowCheckpointExecutionResult>;
	stop(reason: string): Promise<WorkflowSchedulerOutcome>;
}

export interface WorkflowSequentialSchedulerOptions {
	readonly journal: WorkflowRunJournal;
	readonly binding: WorkflowSubagentBinding;
	readonly launcher?: WorkflowTaskLauncher;
	readonly finalizer?: WorkflowTaskFinalizer;
	readonly concurrency?: number;
	readonly budget?: WorkflowBudget;
	/**
	 * Support execution: either an explicit executor, or the artifact store
	 * plus the immutable constructor registry used to build one bound to this
	 * scheduler's stop signal. Without either, support tasks fail closed.
	 */
	readonly supportExecutor?: WorkflowSupportTaskExecutor;
	readonly artifacts?: WorkflowArtifactStore;
	readonly supportTasks?: ReadonlyMap<string, SupportTaskRegistration>;
	/**
	 * Checkpoint execution: either an explicit executor, or the artifact store
	 * plus the decision record store used to build one bound to this
	 * scheduler's stop signal. Without either, checkpoint tasks fail closed.
	 */
	readonly checkpointExecutor?: WorkflowCheckpointTaskExecutor;
	readonly decisions?: WorkflowDecisionRecordStore;
	readonly checkpoints?: { readonly headless: boolean };
	/**
	 * Nested execution: either an explicit executor, or the artifact store,
	 * the nested run provider, and this run's nesting context used to build
	 * one. Without either, nested workflow tasks fail closed.
	 */
	/** Retry and resume attempts for agent tasks; built from the binding when omitted. */
	readonly retrier?: WorkflowTaskRetrier;
	readonly nestedExecutor?: WorkflowNestedRunExecutor;
	readonly nestedRuns?: WorkflowNestedRunProvider;
	readonly nesting?: {
		readonly depth: number;
		readonly ancestorDefinitionIdentities: readonly string[];
		readonly definitionIdentitySha256: string;
		readonly deadlineAt: string;
	};
}

type PreparedWork =
	| { state: "wait"; taskId: WorkflowTaskId; receipt: RunReceipt }
	| { state: "attempt"; taskId: WorkflowTaskId }
	| { state: "support"; taskId: WorkflowTaskId }
	| { state: "nested"; taskId: WorkflowTaskId }
	| WorkflowSchedulerOutcome;

export class WorkflowSchedulerError extends Error {
	constructor(
		readonly stage: "validation" | "selection" | "observation" | "stop",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "WorkflowSchedulerError";
	}
}

function isTerminalChildStatus(status: string): boolean {
	return TERMINAL_CHILD_STATUSES.has(status);
}

function executionFor(
	state: WorkflowStateProjection,
	task: WorkflowTaskProjection,
): TaskExecutionProjection | undefined {
	return task.currentExecutionId
		? state.executions[task.currentExecutionId]
		: undefined;
}

function receiptFor(
	execution: TaskExecutionProjection,
): RunReceipt | undefined {
	const receipt = execution.launchReceipt;
	if (!receipt) return undefined;
	const attempt = (execution.attempts ?? []).at(-1);
	return {
		runId: receipt.subagentRunId,
		attemptId: currentSubagentAttemptId(execution) ?? receipt.subagentAttemptId,
		status:
			attempt?.subagentAttemptId !== undefined && attempt.status !== undefined
				? attempt.status
				: receipt.status,
	};
}

function receiptedAttemptCount(execution: TaskExecutionProjection): number {
	return (execution.attempts ?? []).filter(
		(attempt) => attempt.subagentAttemptId !== undefined,
	).length;
}

function dependencies(
	state: WorkflowStateProjection,
	task: WorkflowTaskProjection,
): readonly WorkflowTaskProjection[] {
	const ids = new Set([
		...task.task.spec.after.map((dependency) => dependency.taskId),
		...Object.values(task.task.spec.inputs).map(
			(input) => input.producerTaskId,
		),
	]);
	return [...ids].map((id) => {
		const dependency = state.tasks[id];
		if (!dependency) {
			throw new WorkflowSchedulerError(
				"selection",
				"Committed workflow task has an unknown dependency.",
			);
		}
		return dependency;
	});
}

/**
 * Committed tasks on the current path in materialization order. Abandoned
 * tasks stay in the projection as history and are never scheduled.
 */
function orderedTasks(
	state: WorkflowStateProjection,
): readonly WorkflowTaskProjection[] {
	return Object.values(state.tasks)
		.filter((task) => task.committed && task.abandoned !== true)
		.sort(
			(left, right) =>
				left.task.materializationSequence - right.task.materializationSequence,
		);
}

function outcomeFromStatus(
	status: string,
): "completed" | "failed" | "cancelled" | "interrupted" | "cleanup-blocked" {
	if (status === "abandoned") return "cancelled";
	if (
		status === "completed" ||
		status === "failed" ||
		status === "cancelled" ||
		status === "interrupted" ||
		status === "cleanup-blocked"
	) {
		return status;
	}
	throw new WorkflowSchedulerError(
		"observation",
		"Subagent settlement has a nonterminal status.",
	);
}

function terminalOutcome(result: RunResult) {
	return outcomeFromStatus(result.status);
}

function validateReceipt(
	receipt: RunReceipt,
	expected: RunReceipt,
	stage: "observation" | "stop",
): void {
	if (
		receipt.runId !== expected.runId ||
		receipt.attemptId !== expected.attemptId ||
		!Value.Check(RunStatusSchema, receipt.status)
	) {
		throw new WorkflowSchedulerError(
			stage,
			"Subagent receipt does not match the persisted child identity.",
		);
	}
}

export function createWorkflowSequentialScheduler(
	options: WorkflowSequentialSchedulerOptions,
): WorkflowSequentialScheduler {
	const { binding, finalizer, journal } = options;
	const budget = options.budget ?? {
		cost: Number.MAX_SAFE_INTEGER,
		childRuntimeMs: Number.MAX_SAFE_INTEGER,
	};
	const concurrency = options.concurrency ?? 1;
	if (
		!Number.isSafeInteger(concurrency) ||
		concurrency < 1 ||
		concurrency > 16
	) {
		throw new WorkflowSchedulerError(
			"validation",
			"Workflow scheduler concurrency limit is invalid.",
		);
	}
	const busy = new Set<WorkflowTaskId>();
	const interrupting = new Set<WorkflowTaskId>();
	const launcher =
		options.launcher ?? createWorkflowTaskLauncher({ binding, journal });
	const stopController = new AbortController();
	const supportExecutor =
		options.supportExecutor ??
		(options.artifacts && options.supportTasks
			? createWorkflowSupportTaskExecutor({
					journal,
					artifacts: options.artifacts,
					registrations: options.supportTasks,
					signal: () => stopController.signal,
				})
			: undefined);
	const checkpointExecutor =
		options.checkpointExecutor ??
		(options.artifacts && options.decisions
			? createWorkflowCheckpointTaskExecutor({
					journal,
					artifacts: options.artifacts,
					decisions: options.decisions,
					signal: () => stopController.signal,
					...(options.nesting
						? { deadlineAt: options.nesting.deadlineAt }
						: {}),
					headless: options.checkpoints?.headless ?? false,
				})
			: undefined);
	const retrier =
		options.retrier ??
		createWorkflowTaskRetrier({
			journal,
			binding,
			signal: () => stopController.signal,
			...(options.nesting ? { deadlineAt: options.nesting.deadlineAt } : {}),
		});
	const nestedExecutor =
		options.nestedExecutor ??
		(options.artifacts && options.nestedRuns && options.nesting
			? createWorkflowNestedRunExecutor({
					journal,
					artifacts: options.artifacts,
					provider: options.nestedRuns,
					nesting: options.nesting,
				})
			: undefined);
	const coordinationKey = journal.directory;

	if (
		!Number.isFinite(budget.cost) ||
		budget.cost < 0 ||
		!Number.isSafeInteger(budget.childRuntimeMs) ||
		budget.childRuntimeMs < 1_000 ||
		(budget.totalTokens !== undefined &&
			(!Number.isSafeInteger(budget.totalTokens) || budget.totalTokens < 1))
	) {
		throw new WorkflowSchedulerError(
			"validation",
			"Workflow scheduler budget is invalid.",
		);
	}

	if (
		binding.workflowRunId !== journal.runId ||
		binding.ownerId !== `pi-workflow:${journal.runId}`
	) {
		throw new WorkflowSchedulerError(
			"validation",
			"Subagent owner binding does not match the workflow journal.",
		);
	}

	function mutate<T>(operation: () => Promise<T>): Promise<T> {
		const predecessor =
			schedulerMutations.get(coordinationKey) ?? Promise.resolve();
		const result = predecessor.then(operation);
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		schedulerMutations.set(coordinationKey, settled);
		void settled.then(() => {
			if (schedulerMutations.get(coordinationKey) === settled) {
				schedulerMutations.delete(coordinationKey);
			}
		});
		return result;
	}

	async function state(): Promise<WorkflowStateProjection> {
		return reduceWorkflowEvents(await journal.readEvents());
	}

	async function append(input: WorkflowEventInput): Promise<void> {
		await journal.appendEvent(input);
	}

	async function changeRun(
		from: WorkflowRunStatus,
		to: WorkflowRunStatus,
		reason?: string,
	): Promise<void> {
		await append({
			type: "run-status-changed",
			data: { from, to, ...(reason ? { reason } : {}) },
		});
	}

	async function changeTask(
		taskId: WorkflowTaskId,
		from: WorkflowTaskStatus,
		to: WorkflowTaskStatus,
		reason?: string,
	): Promise<void> {
		await append({
			type: "task-status-changed",
			data: { taskId, from, to, ...(reason ? { reason } : {}) },
		});
	}

	async function failRunFromObservedStatus(reason: string): Promise<void> {
		await cancelOpenWorkflowCheckpoints(journal, CHECKPOINT_RUN_ENDING_REASON);
		const now = await state();
		await changeRun(now.status, "failed", reason);
	}

	async function observeReceipt(
		execution: TaskExecutionProjection,
		receipt: RunReceipt,
	): Promise<void> {
		const previous =
			execution.observation?.status ?? execution.launchReceipt?.status;
		if (execution.observation?.status === receipt.status) return;
		if (previous === receipt.status && !isTerminalChildStatus(receipt.status)) {
			return;
		}
		await append({
			type: "task-execution-child-observed",
			data: {
				executionId: execution.execution.id,
				subagentRunId: receipt.runId,
				subagentAttemptId: receipt.attemptId,
				status: receipt.status,
			},
		});
	}

	async function cancelUnlaunchedTask(
		task: WorkflowTaskProjection,
		execution: TaskExecutionProjection,
		reason: string,
	): Promise<void> {
		await append({
			type: "task-execution-terminal",
			data: {
				executionId: execution.execution.id,
				outcome: "cancelled",
				evidence: {
					kind: "workflow",
					stage: "stop",
					failureSha256: deriveWorkflowFailureSha256("stop", reason),
					message: reason,
				},
			},
		});
		await changeTask(task.task.id, task.status, "cancelled", reason);
	}

	async function normalizeTask(
		task: WorkflowTaskProjection,
		receipt: RunReceipt,
	): Promise<void> {
		if (task.status === "cancelling") return;
		// An interrupted task an operator reopened re-enters `running` on its
		// re-attempt receipt; `interrupted -> waiting` is not a task transition,
		// so a queued re-attempt also runs (the reducer admits it). A receipt
		// that is already terminal has no legal task transition from
		// `interrupted`, so it is refused here with its own message rather than
		// left for the finalizer to trip over.
		if (task.status === "interrupted") {
			if (receipt.status === "active" || receipt.status === "queued") {
				await changeTask(
					task.task.id,
					"interrupted",
					"running",
					OPERATOR_RESUME_REASON,
				);
				return;
			}
			if (receipt.status !== "stopping") {
				throw new WorkflowSchedulerError(
					"observation",
					`Operator re-attempt receipt is already ${receipt.status}; an interrupted task re-enters running only through an active or queued attempt.`,
				);
			}
		}
		if (receipt.status === "active") {
			if (task.status !== "running") {
				await changeTask(
					task.task.id,
					task.status,
					"running",
					"Subagent child is active.",
				);
			}
			return;
		}
		if (receipt.status === "stopping") {
			const current = await state();
			if (current.status !== "stopping") {
				await changeRun(
					current.status,
					"stopping",
					"Subagent child is stopping.",
				);
			}
			await changeTask(
				task.task.id,
				task.status,
				"cancelling",
				"Subagent child is stopping.",
			);
			return;
		}
		if (task.status !== "waiting") {
			await changeTask(
				task.task.id,
				task.status,
				"waiting",
				isTerminalChildStatus(receipt.status)
					? "Subagent child requires durable finalization."
					: "Subagent child is queued.",
			);
		}
	}

	function settledBudgetReason(
		current: WorkflowStateProjection,
	): string | undefined {
		return budgetExceededReason(settledWorkflowUsage(current), budget);
	}

	function budgetAdmission(
		current: WorkflowStateProjection,
		candidate: WorkflowTaskProjection,
	): { allowed: true } | { allowed: false; deferred: boolean; reason: string } {
		const candidateSpec = candidate.task.spec;
		// Support tasks run in process; checkpoints are routed before admission
		// and reserve nothing (they wait on a human, not on a child).
		if (
			candidateSpec.kind === "support" ||
			candidateSpec.kind === "checkpoint"
		) {
			return { allowed: true };
		}
		// The candidate's own active execution is what admission is deciding
		// on; counting it as a reservation would double-charge a task that is
		// re-selected after restart.
		const usage = workflowUsage(current, {
			budget,
			excludeTaskId: candidate.task.id,
		});
		if (usage.refusal !== undefined) {
			return { allowed: false, deferred: false, reason: usage.refusal };
		}
		const settledCost = usage.settled.cost;
		const settledTotalTokens = usage.settled.totalTokens;
		const settledChildRuntimeMs = usage.settled.childRuntimeMs;
		const reservedCost = usage.reserved.cost;
		const reservedTotalTokens = usage.reserved.totalTokens;
		const reservedChildRuntimeMs = usage.reserved.childRuntimeMs;
		const candidateMaximum =
			candidateSpec.kind === "workflow"
				? {
						cost: candidateSpec.request.budget.cost,
						totalTokens: candidateSpec.request.budget.totalTokens,
						childRuntimeMs: candidateSpec.request.budget.childRuntimeMs,
					}
				: {
						cost: candidateSpec.request.limits.cost,
						totalTokens: candidateSpec.request.limits.totalTokens,
						childRuntimeMs: candidateSpec.request.limits.cumulativeRuntimeMs,
					};
		const candidateCost = candidateMaximum.cost;
		if (
			budget.totalTokens !== undefined &&
			candidateMaximum.totalTokens === undefined
		) {
			return {
				allowed: false,
				deferred: false,
				reason:
					candidateSpec.kind === "workflow"
						? "Nested workflow has no total-token budget to reserve against the workflow budget."
						: "Workflow task has no total-token maximum to reserve against the workflow budget.",
			};
		}
		const candidateTotalTokens = candidateMaximum.totalTokens ?? 0;
		const candidateChildRuntimeMs = candidateMaximum.childRuntimeMs;
		const reason = (
			cost: number,
			totalTokens: number,
			childRuntimeMs: number,
		): string | undefined => {
			if (cost > budget.cost) return "Workflow cost budget is exhausted.";
			if (
				budget.totalTokens !== undefined &&
				totalTokens > budget.totalTokens
			) {
				return "Workflow total-token budget is exhausted.";
			}
			if (childRuntimeMs > budget.childRuntimeMs) {
				return "Workflow child-runtime budget is exhausted.";
			}
			return undefined;
		};
		const exhausted = reason(
			settledCost + candidateCost,
			settledTotalTokens + candidateTotalTokens,
			settledChildRuntimeMs + candidateChildRuntimeMs,
		);
		if (exhausted) {
			return { allowed: false, deferred: false, reason: exhausted };
		}
		const reserved = reason(
			settledCost + reservedCost + candidateCost,
			settledTotalTokens + reservedTotalTokens + candidateTotalTokens,
			settledChildRuntimeMs + reservedChildRuntimeMs + candidateChildRuntimeMs,
		);
		return reserved
			? { allowed: false, deferred: true, reason: reserved }
			: { allowed: true };
	}

	function isSupportTask(task: WorkflowTaskProjection): boolean {
		return task.task.spec.kind === "support";
	}

	function isNestedTask(task: WorkflowTaskProjection): boolean {
		return task.task.spec.kind === "workflow";
	}

	function isCheckpointTask(task: WorkflowTaskProjection): boolean {
		return task.task.spec.kind === "checkpoint";
	}

	function occupiesLane(
		current: WorkflowStateProjection,
		task: WorkflowTaskProjection,
	): boolean {
		// An operator-reopened interrupted task is live work: its open intent
		// is performed, its receipted re-attempt awaited, or its declined
		// intent finalized, exactly like a settled task in an active status.
		if (isReopenedTask(current, task)) return true;
		if (!ACTIVE_TASK_STATUSES.has(task.status)) return false;
		// A parked checkpoint waits on a human and holds no lane.
		if (isCheckpointTask(task)) return false;
		if (isSupportTask(task)) return task.status === "running";
		if (isNestedTask(task)) {
			return task.status === "running" || task.status === "cancelling";
		}
		return executionFor(current, task)?.launchReceipt !== undefined;
	}

	/**
	 * A run may not fail, interrupt, or block while a checkpoint is open, so
	 * run-ending transitions cancel first. Without an open checkpoint nothing
	 * is awaited and the status just read stays the `from` of the transition;
	 * after a cancel it is re-read, so a concurrently driving lane's
	 * `waiting -> running` cannot leave the transition with a stale source.
	 */
	async function cancelOpenCheckpointsBefore(
		current: WorkflowStateProjection,
	): Promise<WorkflowRunStatus> {
		if (!hasOpenCheckpoint(current)) return current.status;
		await cancelOpenWorkflowCheckpoints(journal, CHECKPOINT_RUN_ENDING_REASON);
		return (await state()).status;
	}

	async function failRunAfterRequiredTask(
		taskId: WorkflowTaskId,
	): Promise<WorkflowSchedulerOutcome | undefined> {
		const after = await state();
		const task = after.tasks[taskId];
		if (
			task?.task.spec.disposition === "required" &&
			(task.status === "failed" || task.status === "cancelled") &&
			(after.status === "running" ||
				after.status === "waiting" ||
				after.status === "finalizing")
		) {
			const from = await cancelOpenCheckpointsBefore(after);
			await changeRun(
				from,
				"failed",
				"A required workflow task did not complete.",
			);
			return { state: "terminal", runStatus: "failed" };
		}
		return undefined;
	}

	async function updateRunAfterNestedTask(
		taskId: WorkflowTaskId,
	): Promise<WorkflowSchedulerOutcome | undefined> {
		const after = await state();
		const task = after.tasks[taskId];
		if (!task) return undefined;
		if (after.status === "cleanup-blocked") {
			if (task.status === "cleanup-blocked") {
				return { state: "terminal", runStatus: "cleanup-blocked" };
			}
			const recovered =
				task.status === "completed"
					? "running"
					: task.status === "interrupted"
						? "interrupted"
						: "failed";
			if (recovered !== "running") {
				await cancelOpenCheckpointsBefore(after);
			}
			await changeRun(
				"cleanup-blocked",
				recovered,
				"Nested workflow reconciliation produced terminal evidence.",
			);
			return recovered === "running"
				? undefined
				: { state: "terminal", runStatus: recovered };
		}
		if (
			after.status === "completed" ||
			after.status === "completed-degraded" ||
			after.status === "failed" ||
			after.status === "cancelled" ||
			after.status === "interrupted"
		) {
			return { state: "terminal", runStatus: after.status };
		}
		if (task.status === "cleanup-blocked") {
			const from = await cancelOpenCheckpointsBefore(after);
			await changeRun(
				from,
				"cleanup-blocked",
				"Nested workflow run requires reconciliation.",
			);
			return { state: "terminal", runStatus: "cleanup-blocked" };
		}
		if (
			task.task.spec.disposition === "required" &&
			task.status === "interrupted" &&
			after.status !== "stopping"
		) {
			const from = await cancelOpenCheckpointsBefore(after);
			await changeRun(
				from,
				"interrupted",
				"A required workflow task was interrupted.",
			);
			return { state: "terminal", runStatus: "interrupted" };
		}
		return failRunAfterRequiredTask(taskId);
	}

	async function prepareNested(
		selected: WorkflowTaskProjection,
	): Promise<PreparedWork> {
		const taskId = selected.task.id;
		if (!nestedExecutor) {
			const message =
				"Nested workflow execution is not configured for this workflow run.";
			await changeTask(taskId, selected.status, "blocked", message);
			if (selected.task.spec.disposition === "required") {
				await failRunFromObservedStatus(message);
				return { state: "terminal", runStatus: "failed" };
			}
			return prepare();
		}
		const launch = await nestedExecutor.launch(taskId);
		if (launch.state === "terminal") {
			return (await updateRunAfterNestedTask(taskId)) ?? prepare();
		}
		busy.add(taskId);
		return { state: "nested", taskId };
	}

	async function continueAfterNested(
		taskId: WorkflowTaskId,
	): Promise<WorkflowSchedulerOutcome> {
		if (!nestedExecutor) {
			throw new WorkflowSchedulerError(
				"validation",
				"Nested workflow executor disappeared during execution.",
			);
		}
		const result = await nestedExecutor.wait(taskId);
		const updated = await updateRunAfterNestedTask(taskId);
		if (updated) return updated;
		const after = await state();
		if (
			after.status === "failed" ||
			after.status === "cancelled" ||
			after.status === "interrupted" ||
			after.status === "cleanup-blocked" ||
			after.status === "completed" ||
			after.status === "completed-degraded"
		) {
			return { state: "terminal", runStatus: after.status };
		}
		if (result.outcome === "cancelled" || after.status === "stopping") {
			return { state: "stopping", runStatus: after.status };
		}
		return drive();
	}

	async function prepareSupport(
		selected: WorkflowTaskProjection,
	): Promise<PreparedWork> {
		const taskId = selected.task.id;
		if (!supportExecutor) {
			const message =
				"Support task execution is not configured for this workflow run.";
			await changeTask(taskId, selected.status, "blocked", message);
			if (selected.task.spec.disposition === "required") {
				await failRunFromObservedStatus(message);
				return { state: "terminal", runStatus: "failed" };
			}
			return prepare();
		}
		const intent = await supportExecutor.intend(taskId);
		if (intent.state === "terminal") {
			return (await failRunAfterRequiredTask(taskId)) ?? prepare();
		}
		busy.add(taskId);
		return { state: "support", taskId };
	}

	/** On-path checkpoints whose durable request awaits a decision. */
	function pendingCheckpoints(
		current: WorkflowStateProjection,
	): Extract<
		WorkflowSchedulerOutcome,
		{ state: "awaiting-decision" }
	>["pendingCheckpoints"] {
		return orderedTasks(current).flatMap((task) => {
			if (!isCheckpointTask(task)) return [];
			const execution = executionFor(current, task);
			if (execution?.phase !== "checkpoint-requested") return [];
			const expiresAt = execution.checkpointRequest?.expiresAt;
			return [
				{
					taskId: task.task.id,
					executionId: execution.execution.id,
					...(expiresAt ? { expiresAt } : {}),
				},
			];
		});
	}

	/**
	 * This lane has nothing left to do while a checkpoint is parked: the run
	 * waits (durably) and the caller decides whether to park the drive.
	 */
	async function awaitingDecision(
		current: WorkflowStateProjection,
	): Promise<WorkflowSchedulerOutcome> {
		if (current.status === "running") {
			await changeRun(
				"running",
				"waiting",
				"Workflow run awaits a checkpoint decision.",
			);
		}
		return {
			state: "awaiting-decision",
			runStatus: "waiting",
			pendingCheckpoints: pendingCheckpoints(current),
		};
	}

	async function prepareCheckpoint(
		selected: WorkflowTaskProjection,
	): Promise<PreparedWork> {
		const taskId = selected.task.id;
		if (!checkpointExecutor) {
			const message =
				"Checkpoint execution is not configured for this workflow run.";
			await changeTask(taskId, selected.status, "blocked", message);
			if (selected.task.spec.disposition === "required") {
				await failRunFromObservedStatus(message);
				return { state: "terminal", runStatus: "failed" };
			}
			return prepare();
		}
		const outcome = await checkpointExecutor.request(taskId);
		if (outcome.state === "terminal") {
			return (await failRunAfterRequiredTask(taskId)) ?? prepare();
		}
		return awaitingDecision(await state());
	}

	async function prepare(): Promise<PreparedWork> {
		let current = await state();
		if (
			current.status === "completed" ||
			current.status === "completed-degraded" ||
			current.status === "failed" ||
			current.status === "cancelled" ||
			current.status === "interrupted" ||
			current.status === "cleanup-blocked"
		) {
			return { state: "terminal", runStatus: current.status };
		}
		if (current.status === "stopping") {
			return { state: "stopping", runStatus: current.status };
		}
		const finalizing = current.status === "finalizing";
		// A fresh run starts running here. A waiting run resumes only once this
		// lane has selected work for it (below): idle lanes of a parked or
		// barrier-blocked run append nothing instead of flapping the status.
		if (current.status === "created") {
			await changeRun("created", "running");
			current = await state();
		}
		if (finalizing && current.outputArtifactId === undefined) {
			return { state: "idle", runStatus: "finalizing" };
		}
		const role: TaskRole = finalizing ? "finalizer" : "task";
		const candidates = () =>
			orderedTasks(current).filter((task) => task.task.spec.role === role);

		const blockDependents = async (): Promise<void> => {
			for (const task of candidates()) {
				if (task.status !== "pending") continue;
				const blockers = dependencies(current, task).filter((dependency) =>
					DEPENDENCY_FAILURE_STATUSES.has(dependency.status),
				);
				if (blockers.length === 0) continue;
				await changeTask(
					task.task.id,
					"pending",
					"blocked",
					"A workflow task dependency did not complete successfully.",
				);
				current = await state();
			}
		};
		await blockDependents();

		// Expiry and crash repair for every requested checkpoint happen on
		// every pass, before selection reads their status.
		if (
			checkpointExecutor &&
			candidates().some(
				(task) =>
					isCheckpointTask(task) && executionFor(current, task) !== undefined,
			)
		) {
			const settled = await checkpointExecutor.sweep(Date.now());
			current = await state();
			for (const result of settled) {
				if (result.outcome === "completed") continue;
				const failed = await failRunAfterRequiredTask(result.taskId);
				if (failed) return failed;
			}
			if (settled.length > 0) await blockDependents();
		}

		const active = orderedTasks(current).filter((task) =>
			occupiesLane(current, task),
		);
		let selected = active.find((task) => !busy.has(task.task.id));
		if (!selected && active.length < concurrency) {
			selected = candidates().find((task) => {
				if (task.status === "ready") return true;
				return (
					task.status === "pending" &&
					dependencies(current, task).every(
						(dependency) => dependency.status === "completed",
					)
				);
			});
		}
		if (!selected) {
			if (
				candidates().some(
					(task) => isCheckpointTask(task) && task.status === "waiting",
				)
			) {
				return awaitingDecision(current);
			}
			if (current.status === "running") {
				await changeRun(
					"running",
					"waiting",
					"No committed workflow task is currently ready.",
				);
			}
			return {
				state: "idle",
				runStatus: finalizing ? "finalizing" : "waiting",
			};
		}
		if (current.status === "waiting") {
			// Deferred from the top of the pass: the run resumes with the work.
			await changeRun("waiting", "running");
			current = await state();
			selected = current.tasks[selected.task.id];
		}
		if (!selected) {
			throw new WorkflowSchedulerError(
				"selection",
				"Selected workflow task disappeared.",
			);
		}
		if (selected.status === "pending") {
			await changeTask(
				selected.task.id,
				"pending",
				"ready",
				"All workflow task dependencies completed.",
			);
			current = await state();
			selected = current.tasks[selected.task.id];
		}
		if (!selected) {
			throw new WorkflowSchedulerError(
				"selection",
				"Selected workflow task disappeared.",
			);
		}

		if (isCheckpointTask(selected)) {
			return prepareCheckpoint(selected);
		}
		if (isSupportTask(selected)) {
			return prepareSupport(selected);
		}

		const selectedExecution = executionFor(current, selected);
		if (
			selectedExecution?.settlement &&
			(selectedExecution.phase === "settled" ||
				selectedExecution.phase === "attempt-intended")
		) {
			busy.add(selected.task.id);
			return { state: "attempt", taskId: selected.task.id };
		}
		if (selectedExecution?.settlement) {
			const receipt = receiptFor(selectedExecution);
			if (!receipt) {
				throw new WorkflowSchedulerError(
					"selection",
					"Settled workflow task has no persisted child receipt.",
				);
			}
			busy.add(selected.task.id);
			return {
				state: "awaiting-finalization",
				runStatus: current.status,
				taskId: selected.task.id,
				executionId: selectedExecution.execution.id,
				child: {
					...receipt,
					status: selectedExecution.settlement.evidence.status,
				},
				outcome: outcomeFromStatus(
					selectedExecution.settlement.evidence.status,
				),
			};
		}

		const admission = budgetAdmission(current, selected);
		if (!admission.allowed && admission.deferred) {
			return { state: "idle", runStatus: current.status };
		}
		if (!admission.allowed) {
			await changeTask(
				selected.task.id,
				selected.status,
				"blocked",
				admission.reason,
			);
			if (
				selected.task.spec.disposition === "required" ||
				admission.reason.includes("incomplete") ||
				admission.reason.includes("no task declaration")
			) {
				await failRunFromObservedStatus(admission.reason);
				return { state: "terminal", runStatus: "failed" };
			}
			return prepare();
		}

		if (isNestedTask(selected)) {
			return prepareNested(selected);
		}

		let launch: Awaited<ReturnType<WorkflowTaskLauncher["launch"]>>;
		try {
			launch = await launcher.launch(selected.task.id);
		} catch (error) {
			const failed = await state();
			const failedTask = failed.tasks[selected.task.id];
			if (
				failedTask?.task.spec.disposition === "required" &&
				failedTask.status === "failed" &&
				(failed.status === "running" ||
					failed.status === "waiting" ||
					failed.status === "finalizing")
			) {
				await failRunFromObservedStatus(
					"A required workflow task failed before launch.",
				);
			}
			throw error;
		}
		if (!("receipt" in launch)) {
			const after = await state();
			const projected = after.tasks[selected.task.id];
			if (
				projected?.task.spec.disposition === "required" &&
				projected.status === "failed" &&
				(after.status === "running" ||
					after.status === "waiting" ||
					after.status === "finalizing")
			) {
				await failRunFromObservedStatus(
					"A required workflow task failed before launch.",
				);
				return { state: "terminal", runStatus: "failed" };
			}
			return { state: "idle", runStatus: after.status };
		}

		current = await state();
		const task = current.tasks[selected.task.id];
		const execution = task ? executionFor(current, task) : undefined;
		if (!task || !execution) {
			throw new WorkflowSchedulerError(
				"selection",
				"Launched workflow task has no durable execution.",
			);
		}
		const persistedReceipt = receiptFor(execution);
		if (!persistedReceipt) {
			throw new WorkflowSchedulerError(
				"selection",
				"Launched workflow task has no persisted child receipt.",
			);
		}
		validateReceipt(launch.receipt, persistedReceipt, "observation");
		const observedStatus = execution.observation?.status;
		const effectiveReceipt = observedStatus
			? { ...launch.receipt, status: observedStatus }
			: launch.receipt;
		await normalizeTask(task, effectiveReceipt);
		const normalized = await state();
		const normalizedTask = normalized.tasks[selected.task.id];
		const normalizedExecution = normalizedTask
			? executionFor(normalized, normalizedTask)
			: undefined;
		if (!normalizedExecution) {
			throw new WorkflowSchedulerError(
				"selection",
				"Normalized workflow task has no durable execution.",
			);
		}
		if (isTerminalChildStatus(effectiveReceipt.status)) {
			await observeReceipt(normalizedExecution, effectiveReceipt);
		}
		busy.add(selected.task.id);
		return { state: "wait", taskId: selected.task.id, receipt: launch.receipt };
	}

	async function settle(
		taskId: WorkflowTaskId,
		expected: RunReceipt,
	): Promise<WorkflowSchedulerOutcome> {
		let executionResult: Awaited<ReturnType<typeof binding.client.wait>>;
		try {
			executionResult = await binding.client.wait(expected.runId);
		} catch (error) {
			throw new WorkflowSchedulerError(
				"observation",
				"Waiting for the subagent child failed; execution remains durable.",
				{ cause: error },
			);
		}
		if (
			!isRunResult(executionResult.result) ||
			executionResult.result.runId !== expected.runId
		) {
			throw new WorkflowSchedulerError(
				"observation",
				"Subagent wait returned an invalid terminal result.",
			);
		}
		if (
			executionResult.result.status === "completed" &&
			executionResult.result.structuredOutput === undefined
		) {
			throw new WorkflowSchedulerError(
				"observation",
				"Completed subagent result has no structured output.",
			);
		}
		const terminalReceipt: RunReceipt = {
			runId: expected.runId,
			attemptId: expected.attemptId,
			status: executionResult.result.status,
		};
		validateReceipt(terminalReceipt, expected, "observation");
		const evidenceFor = (
			execution: TaskExecutionProjection,
		): SubagentTerminalEvidence => {
			try {
				return deriveSubagentSettlementEvidence(
					executionResult,
					1 + receiptedAttemptCount(execution),
				);
			} catch (error) {
				throw new WorkflowSchedulerError(
					"observation",
					"Subagent terminal result cannot be represented as durable evidence.",
					{ cause: error },
				);
			}
		};

		const settled = await mutate(async () => {
			let current = await state();
			const task = current.tasks[taskId];
			let execution = task ? executionFor(current, task) : undefined;
			if (!task || !execution) {
				throw new WorkflowSchedulerError(
					"observation",
					"Workflow task disappeared while recording child settlement.",
				);
			}
			const persisted = receiptFor(execution);
			if (!persisted) {
				throw new WorkflowSchedulerError(
					"observation",
					"Workflow task has no persisted child receipt.",
				);
			}
			validateReceipt(terminalReceipt, persisted, "observation");
			const evidence = evidenceFor(execution);
			// Only a child that was observed cleanup-blocked and now reports another
			// terminal status gets a replacement settlement. A workflow-evidence
			// block (artifact or handoff import, release) keeps its settlement and
			// lets the finalizer retry the blocked step.
			const reconcilesCleanup =
				execution.phase === "terminal" &&
				execution.terminal?.outcome === "cleanup-blocked" &&
				execution.observation?.status === "cleanup-blocked" &&
				terminalReceipt.status !== "cleanup-blocked";
			if (
				execution.settlement &&
				!reconcilesCleanup &&
				!isDeepStrictEqual(execution.settlement.evidence, evidence)
			) {
				throw new WorkflowSchedulerError(
					"observation",
					"Subagent terminal result changed after durable settlement.",
				);
			}
			if (execution.phase !== "settled") {
				if (execution.observation?.status !== terminalReceipt.status) {
					await observeReceipt(execution, terminalReceipt);
					current = await state();
					execution = current.executions[execution.execution.id];
				}
				if (!execution) {
					throw new WorkflowSchedulerError(
						"observation",
						"Workflow execution disappeared after child observation.",
					);
				}
				if (!execution.settlement || reconcilesCleanup) {
					await append({
						type: "task-execution-child-settled",
						data: { executionId: execution.execution.id, evidence },
					});
				}
			}
			current = await state();
			return {
				state: "awaiting-finalization",
				runStatus: current.status,
				taskId,
				executionId: execution.execution.id,
				child: terminalReceipt,
				outcome: terminalOutcome(executionResult.result),
			} as const;
		});
		return settleAfterAttempts(taskId, settled);
	}

	/**
	 * An operator resume receipt reactivates the interrupted task so its
	 * re-attempt can settle through the ordinary lifecycle; policy attempts
	 * leave the task in the active status it already holds.
	 */
	async function reactivateReopenedTask(
		taskId: WorkflowTaskId,
		receipt: RunReceipt,
	): Promise<void> {
		await mutate(async () => {
			const current = await state();
			const task = current.tasks[taskId];
			if (task?.status !== "interrupted") return;
			await normalizeTask(task, receipt);
		});
	}

	/**
	 * After a durable settlement, lets the retrier start a policy attempt.
	 * A new attempt receipt is waited on like the initial launch; otherwise
	 * the settled outcome proceeds to finalization.
	 */
	async function settleAfterAttempts(
		taskId: WorkflowTaskId,
		settled?: WorkflowSchedulerOutcome,
	): Promise<WorkflowSchedulerOutcome> {
		const decision = await retrier.consider(taskId);
		if (decision.kind === "attempt") {
			await reactivateReopenedTask(taskId, decision.receipt);
			return settle(taskId, decision.receipt);
		}
		if (settled) return settled;
		const current = await state();
		const task = current.tasks[taskId];
		const execution = task ? executionFor(current, task) : undefined;
		const receipt = execution ? receiptFor(execution) : undefined;
		if (!execution?.settlement || !receipt) {
			throw new WorkflowSchedulerError(
				"selection",
				"Settled workflow task has no persisted child receipt.",
			);
		}
		return {
			state: "awaiting-finalization",
			runStatus: current.status,
			taskId,
			executionId: execution.execution.id,
			child: { ...receipt, status: execution.settlement.evidence.status },
			outcome: outcomeFromStatus(execution.settlement.evidence.status),
		};
	}

	async function continueAfterFinalization(
		settled: WorkflowSchedulerOutcome,
	): Promise<WorkflowSchedulerOutcome> {
		if (settled.state !== "awaiting-finalization" || !finalizer) return settled;
		const finalized = await finalizer.finalize(settled.taskId);
		const afterFinalization = await state();
		const budgetFailure = settledBudgetReason(afterFinalization);
		if (
			budgetFailure &&
			afterFinalization.status !== "failed" &&
			afterFinalization.status !== "cancelled" &&
			afterFinalization.status !== "interrupted" &&
			afterFinalization.status !== "cleanup-blocked" &&
			afterFinalization.status !== "completed" &&
			afterFinalization.status !== "completed-degraded"
		) {
			const from = await cancelOpenCheckpointsBefore(afterFinalization);
			await changeRun(from, "failed", budgetFailure);
			return { state: "terminal", runStatus: "failed" };
		}
		if (
			finalized.runStatus === "failed" ||
			finalized.runStatus === "cancelled" ||
			finalized.runStatus === "interrupted" ||
			finalized.runStatus === "cleanup-blocked" ||
			finalized.runStatus === "completed" ||
			finalized.runStatus === "completed-degraded"
		) {
			return { state: "terminal", runStatus: finalized.runStatus };
		}
		return drive();
	}

	async function continueAfterSupport(
		taskId: WorkflowTaskId,
	): Promise<WorkflowSchedulerOutcome> {
		if (!supportExecutor) {
			throw new WorkflowSchedulerError(
				"validation",
				"Support task executor disappeared during execution.",
			);
		}
		const result = await supportExecutor.execute(taskId);
		const failed = await failRunAfterRequiredTask(taskId);
		if (failed) return failed;
		const after = await state();
		if (
			after.status === "failed" ||
			after.status === "cancelled" ||
			after.status === "interrupted" ||
			after.status === "cleanup-blocked" ||
			after.status === "completed" ||
			after.status === "completed-degraded"
		) {
			return { state: "terminal", runStatus: after.status };
		}
		if (result.outcome === "cancelled" || after.status === "stopping") {
			return { state: "stopping", runStatus: after.status };
		}
		return drive();
	}

	async function drive(): Promise<WorkflowSchedulerOutcome> {
		const prepared = await mutate(prepare);
		if (prepared.state === "stopping") {
			return stop("Resume persisted workflow stop intent.");
		}
		if (
			prepared.state !== "wait" &&
			prepared.state !== "attempt" &&
			prepared.state !== "support" &&
			prepared.state !== "nested" &&
			prepared.state !== "awaiting-finalization"
		) {
			return prepared;
		}
		try {
			if (prepared.state === "attempt") {
				return await continueAfterFinalization(
					await settleAfterAttempts(prepared.taskId),
				);
			}
			if (prepared.state === "support" || prepared.state === "nested") {
				const outcome =
					prepared.state === "support"
						? await continueAfterSupport(prepared.taskId)
						: await continueAfterNested(prepared.taskId);
				if (outcome.state === "stopping") {
					busy.delete(prepared.taskId);
					return stop("Resume persisted workflow stop intent.");
				}
				return outcome;
			}
			if (prepared.state === "awaiting-finalization") {
				return await continueAfterFinalization(prepared);
			}
			return await continueAfterFinalization(
				await settle(prepared.taskId, prepared.receipt),
			);
		} finally {
			busy.delete(prepared.taskId);
		}
	}

	async function reconcileNested(
		taskId: WorkflowTaskId,
	): Promise<WorkflowSchedulerOutcome> {
		return mutate(async () => {
			const current = await state();
			const task = current.tasks[taskId];
			if (
				current.status !== "cleanup-blocked" ||
				task?.status !== "cleanup-blocked" ||
				!nestedExecutor
			) {
				throw new WorkflowSchedulerError(
					"validation",
					"Workflow task has no cleanup-blocked nested run to reconcile.",
				);
			}
			await nestedExecutor.reconcile(taskId);
			const updated = await updateRunAfterNestedTask(taskId);
			return updated ?? { state: "idle", runStatus: (await state()).status };
		});
	}

	async function reconcile(
		taskId: WorkflowTaskId,
	): Promise<WorkflowSchedulerReconcileOutcome> {
		const prepared = await mutate(async () => {
			const current = await state();
			if (current.status !== "cleanup-blocked") {
				throw new WorkflowSchedulerError(
					"validation",
					"Workflow run is not cleanup-blocked.",
				);
			}
			const task = current.tasks[taskId];
			if (task && isNestedTask(task)) return { nested: true } as const;
			const execution = task ? executionFor(current, task) : undefined;
			const child = execution ? receiptFor(execution) : undefined;
			if (
				task?.status !== "cleanup-blocked" ||
				execution?.phase !== "terminal" ||
				execution.terminal?.outcome !== "cleanup-blocked" ||
				!child
			) {
				throw new WorkflowSchedulerError(
					"validation",
					"Workflow task has no cleanup-blocked child to reconcile.",
				);
			}
			const result = await binding.client.reconcile(child.runId);
			if (
				result.run.runId !== child.runId ||
				result.run.attemptId !== child.attemptId
			) {
				throw new WorkflowSchedulerError(
					"observation",
					"Subagent reconciliation returned another child identity.",
				);
			}
			const subagent: WorkflowSchedulerReconcileFacts = Object.freeze({
				sandboxProcess: result.sandboxProcess,
				workspace: result.workspace,
			});
			return { taskId, receipt: child, subagent };
		});
		if ("nested" in prepared) return reconcileNested(taskId);
		const outcome = await continueAfterFinalization(
			await settle(prepared.taskId, prepared.receipt),
		);
		return { ...outcome, subagent: prepared.subagent };
	}

	function decide(
		taskId: WorkflowTaskId,
		decision: WorkflowCheckpointDecisionInput,
	): Promise<WorkflowCheckpointExecutionResult> {
		return mutate(async () => {
			if (!checkpointExecutor) {
				throw new WorkflowSchedulerError(
					"validation",
					"Checkpoint execution is not configured for this workflow run.",
				);
			}
			return checkpointExecutor.decide(taskId, decision);
		});
	}

	async function stop(reason: string): Promise<WorkflowSchedulerOutcome> {
		if (reason.length < 1 || reason.length > 4096) {
			throw new WorkflowSchedulerError(
				"validation",
				"Workflow stop reason must contain 1 to 4096 characters.",
			);
		}
		const prepared = await mutate(async () => {
			let current = await state();
			if (
				current.status === "completed" ||
				current.status === "completed-degraded" ||
				current.status === "failed" ||
				current.status === "cancelled" ||
				current.status === "cleanup-blocked"
			) {
				return { state: "terminal", runStatus: current.status } as const;
			}
			if (current.status === "created") {
				await changeRun("created", "running", "Workflow stop requested.");
				current = await state();
			}
			if (current.status !== "stopping") {
				await changeRun(current.status, "stopping", reason);
				current = await state();
			}
			if (!stopController.signal.aborted) {
				stopController.abort(new Error(reason));
			}

			const runningSupport = orderedTasks(current).filter(
				(task) => isSupportTask(task) && task.status === "running",
			);
			for (const task of runningSupport) {
				if (!supportExecutor) {
					throw new WorkflowSchedulerError(
						"stop",
						"Running support task has no executor to cancel it.",
					);
				}
				if (busy.has(task.task.id)) {
					// An in-process execution observes the aborted stop signal and
					// terminalizes promptly even when its implementation ignores
					// abort; this waits only for that bounded drain, never for the
					// implementation itself.
					await supportExecutor.execute(task.task.id);
					continue;
				}
				await supportExecutor.cancel(task.task.id, reason);
			}
			if (runningSupport.length > 0) {
				current = await state();
			}
			const supportStillRunning = orderedTasks(current).some(
				(task) => isSupportTask(task) && task.status === "running",
			);
			const runningNested = orderedTasks(current).filter(
				(task) =>
					isNestedTask(task) &&
					(task.status === "running" || task.status === "cancelling"),
			);
			if (runningNested.length > 0 && !nestedExecutor) {
				throw new WorkflowSchedulerError(
					"stop",
					"Running nested workflow task has no executor to stop it.",
				);
			}
			if (nestedExecutor) {
				await Promise.all(
					runningNested.map((task) =>
						nestedExecutor.stop(task.task.id, reason),
					),
				);
			}
			if (runningNested.length > 0) {
				current = await state();
			}
			const openCheckpoints = orderedTasks(current).filter(
				(task) =>
					isCheckpointTask(task) &&
					(task.status === "waiting" ||
						(task.status === "ready" &&
							executionFor(current, task) !== undefined)),
			);
			for (const task of openCheckpoints) {
				if (!checkpointExecutor) {
					throw new WorkflowSchedulerError(
						"stop",
						"Open checkpoint task has no executor to cancel it.",
					);
				}
				await checkpointExecutor.cancel(task.task.id, reason);
			}
			if (openCheckpoints.length > 0) {
				current = await state();
			}

			const active = orderedTasks(current).filter((task) => {
				const execution = executionFor(current, task);
				return (
					execution !== undefined &&
					!execution.settlement &&
					(execution.launchReceipt !== undefined ||
						execution.phase === "launch-intended" ||
						execution.phase === "launch-uncertain" ||
						execution.phase === "launch-absent")
				);
			});
			let selected = active.find((task) => !interrupting.has(task.task.id));
			if (!selected && active.length > 0) {
				return { state: "stopping", runStatus: "stopping" } as const;
			}
			for (const task of orderedTasks(current)) {
				const execution = executionFor(current, task);
				if (execution?.phase === "attempt-intended") {
					await retrier.decline(task.task.id, reason);
				}
			}
			current = await state();
			const pendingFinalization = orderedTasks(current).find(
				(task) => executionFor(current, task)?.settlement,
			);
			for (const task of orderedTasks(current)) {
				if (selected?.task.id === task.task.id) continue;
				if (
					task.status === "pending" ||
					task.status === "ready" ||
					task.status === "blocked"
				) {
					const execution = executionFor(current, task);
					if (execution?.phase === "terminal" && execution.terminal) {
						await changeTask(
							task.task.id,
							task.status,
							execution.terminal.outcome,
							reason,
						);
					} else if (execution && !execution.launchReceipt) {
						await cancelUnlaunchedTask(task, execution, reason);
					} else {
						await changeTask(task.task.id, task.status, "cancelled", reason);
					}
				}
			}
			if (!selected && pendingFinalization) {
				const execution = executionFor(current, pendingFinalization);
				const receipt = execution ? receiptFor(execution) : undefined;
				if (!execution?.settlement || !receipt) {
					throw new WorkflowSchedulerError(
						"stop",
						"Settled workflow task has incomplete child identity.",
					);
				}
				return {
					state: "awaiting-finalization",
					runStatus: "stopping",
					taskId: pendingFinalization.task.id,
					executionId: execution.execution.id,
					child: { ...receipt, status: execution.settlement.evidence.status },
					outcome: outcomeFromStatus(execution.settlement.evidence.status),
				} as const;
			}
			if (!selected && supportStillRunning) {
				return { state: "stopping", runStatus: "stopping" } as const;
			}
			if (!selected) {
				await changeRun("stopping", "cancelled", reason);
				return { state: "terminal", runStatus: "cancelled" } as const;
			}
			let execution = executionFor(current, selected);
			let receipt = execution ? receiptFor(execution) : undefined;
			if (execution && !receipt) {
				const recovered = await launcher.launch(selected.task.id);
				if (!("receipt" in recovered)) {
					await changeRun(
						"stopping",
						"failed",
						"Uncertain child launch could not be recovered during stop.",
					);
					return { state: "terminal", runStatus: "failed" } as const;
				}
				current = await state();
				selected = current.tasks[selected.task.id];
				execution = selected ? executionFor(current, selected) : undefined;
				receipt = execution ? receiptFor(execution) : undefined;
			}
			if (!selected || !execution || !receipt) {
				throw new WorkflowSchedulerError(
					"stop",
					"Stopping workflow task has no persisted child receipt.",
				);
			}
			if (selected.status !== "cancelling") {
				await changeTask(
					selected.task.id,
					selected.status,
					"cancelling",
					reason,
				);
			}
			let interruptReceipt: RunReceipt;
			try {
				interruptReceipt = await binding.client.interrupt(receipt.runId);
			} catch (error) {
				throw new WorkflowSchedulerError(
					"stop",
					"Subagent interrupt failed after durable workflow stop intent.",
					{ cause: error },
				);
			}
			validateReceipt(interruptReceipt, receipt, "stop");
			const refreshed = await state();
			const refreshedExecution = refreshed.executions[execution.execution.id];
			if (!refreshedExecution) {
				throw new WorkflowSchedulerError(
					"stop",
					"Workflow execution disappeared after interrupt.",
				);
			}
			if (interruptReceipt.status !== receipt.status) {
				await observeReceipt(refreshedExecution, interruptReceipt);
			}
			interrupting.add(selected.task.id);
			return {
				state: "wait",
				taskId: selected.task.id,
				receipt,
			} as const;
		});
		if (prepared.state === "awaiting-finalization") {
			return continueAfterFinalization(prepared);
		}
		if (prepared.state !== "wait") return prepared;
		try {
			return await continueAfterFinalization(
				await settle(prepared.taskId, prepared.receipt),
			);
		} finally {
			interrupting.delete(prepared.taskId);
		}
	}

	return Object.freeze({
		concurrency,
		stopSignal: stopController.signal,
		drive,
		reconcile,
		decide,
		stop,
	});
}
