import {
	MAX_TASK_ATTEMPTS,
	type WorkflowRunStatus,
	type WorkflowTaskId,
} from "./contracts.js";
import type {
	WorkflowStateProjection,
	WorkflowTaskProjection,
} from "./events.js";
import { invalidationClosure } from "./reducer.js";

export const WORKFLOW_RUN_ACTIONS = Object.freeze([
	"stop",
	"wait",
	"reconcile",
	"invalidate",
	"retry",
	"resume",
	"decide",
] as const);
export type WorkflowRunAction = (typeof WORKFLOW_RUN_ACTIONS)[number];

/**
 * Actions whose service method exists in this build; the emission gate for
 * `availableWorkflowRunActions`. "decide" waits for checkpoints.
 */
export const IMPLEMENTED_WORKFLOW_RUN_ACTIONS: ReadonlySet<WorkflowRunAction> =
	new Set<WorkflowRunAction>([
		"stop",
		"wait",
		"reconcile",
		"invalidate",
		"retry",
		"resume",
	]);

/** Fixed reason of the `interrupted -> running` transition an operator resume appends. */
export const OPERATOR_RESUME_REASON =
	"Operator resume re-attempts the interrupted task.";

export type WorkflowRunOwnership = "owned" | "leased-elsewhere" | "inactive";

export function isTerminalWorkflowRunStatus(
	status: WorkflowRunStatus,
): boolean {
	return (
		status === "completed" ||
		status === "completed-degraded" ||
		status === "failed" ||
		status === "cancelled" ||
		status === "interrupted" ||
		status === "cleanup-blocked"
	);
}

export function admitsInvalidation(status: WorkflowRunStatus): boolean {
	return status === "failed" || status === "interrupted";
}

type RecoveryTask = {
	readonly status: string;
	readonly abandoned?: true;
	readonly currentExecutionId?: string;
};
type RecoveryAttempt = {
	readonly origin?: string;
	readonly receiptSequence?: number;
	readonly declinedSequence?: number;
};
type RecoveryExecution = {
	readonly phase: string;
	readonly attempts?: readonly RecoveryAttempt[];
};
type RecoveryRun = {
	readonly status: WorkflowRunStatus;
	readonly tasks?:
		| Iterable<RecoveryTask>
		| Readonly<Record<string, RecoveryTask>>;
	/** Present on a state projection; a run view carries no executions. */
	readonly executions?: Readonly<Record<string, RecoveryExecution>>;
};

function recoveryTasks(run: RecoveryRun): Iterable<RecoveryTask> {
	const tasks = run.tasks ?? [];
	return Symbol.iterator in tasks
		? (tasks as Iterable<RecoveryTask>)
		: Object.values(tasks as Readonly<Record<string, RecoveryTask>>);
}

/**
 * An on-path task whose current execution holds an operator resume intent
 * that is neither receipted nor declined. The reducer admits
 * `interrupted -> running` on this evidence exactly as it does on invalidated
 * work, so the next drive performs the operator's attempt.
 */
export function hasOpenOperatorIntent(run: RecoveryRun): boolean {
	const executions = run.executions;
	if (!executions) return false;
	for (const task of recoveryTasks(run)) {
		if (task.abandoned === true || task.currentExecutionId === undefined) {
			continue;
		}
		const execution = executions[task.currentExecutionId];
		const open = execution?.attempts?.at(-1);
		if (
			execution?.phase === "attempt-intended" &&
			open?.origin === "operator" &&
			open.receiptSequence === undefined &&
			open.declinedSequence === undefined
		) {
			return true;
		}
	}
	return false;
}

/**
 * A durably failed or interrupted run whose on-path work was invalidated, or
 * whose interrupted task carries an open operator resume intent, is not
 * final: the next drive performs the explicit recovery. Structural so a run
 * view (`tasks` array) and a state projection (`tasks` record) both satisfy
 * it; only the projection can expose an open operator intent.
 */
export function awaitsRecovery(run: RecoveryRun): boolean {
	if (run.status !== "failed" && run.status !== "interrupted") return false;
	for (const task of recoveryTasks(run)) {
		if (task.status === "invalidated" && task.abandoned !== true) return true;
	}
	return run.status === "interrupted" && hasOpenOperatorIntent(run);
}

/**
 * An interrupted task whose current execution an operator resume reopened
 * and that has not re-terminalized: the attempt is intended, receipted and
 * running, or declined and awaiting the finalizer. Every other interrupted
 * task holds terminal evidence.
 */
export function isReopenedTask(
	state: Pick<WorkflowStateProjection, "executions">,
	task: WorkflowTaskProjection,
): boolean {
	if (
		task.status !== "interrupted" ||
		task.abandoned === true ||
		task.currentExecutionId === undefined
	) {
		return false;
	}
	const execution = state.executions[task.currentExecutionId];
	return execution !== undefined && execution.phase !== "terminal";
}

export function deadlinePassed(deadlineAt: string, now: number): boolean {
	return Date.parse(deadlineAt) <= now;
}

export function isNestedRun(
	record: { readonly parent?: unknown } | object,
): boolean {
	return "parent" in record && record.parent !== undefined;
}

function onPathTasks(state: WorkflowStateProjection) {
	return Object.values(state.tasks)
		.filter((task) => task.abandoned !== true)
		.sort(
			(left, right) =>
				left.task.materializationSequence - right.task.materializationSequence,
		);
}

/** Terminal failed-or-interrupted current executions: the cause set for `retry`. */
export function retryableTasks(
	state: WorkflowStateProjection,
): readonly WorkflowTaskId[] {
	return Object.freeze(
		onPathTasks(state)
			.filter((task) => {
				const execution = task.currentExecutionId
					? state.executions[task.currentExecutionId]
					: undefined;
				return (
					execution?.phase === "terminal" &&
					(execution.terminal?.outcome === "failed" ||
						execution.terminal?.outcome === "interrupted")
				);
			})
			.map((task) => task.task.id),
	);
}

/**
 * The first applicable resume refusal for a task, or undefined when the task
 * is resumable: an on-path agent task whose current execution is terminal
 * interrupted with a `resume`-classified failure, headroom under the attempt
 * bound, and no dependent that already observed it.
 */
export function resumeRefusal(
	state: WorkflowStateProjection,
	taskId: WorkflowTaskId,
): string | undefined {
	const task = state.tasks[taskId];
	if (!task || task.abandoned === true) return "Unknown workflow task.";
	if (task.task.spec.kind !== "agent") {
		return "Workflow resume requires an agent task.";
	}
	const execution = task.currentExecutionId
		? state.executions[task.currentExecutionId]
		: undefined;
	if (
		execution?.phase !== "terminal" ||
		execution.terminal?.outcome !== "interrupted" ||
		execution.settlement?.evidence.status !== "interrupted" ||
		execution.settlement.evidence.failure?.retry !== "resume"
	) {
		return "Workflow resume requires an interrupted task with a resumable failure.";
	}
	if ((execution.attempts?.length ?? 0) + 2 > MAX_TASK_ATTEMPTS) {
		return "Workflow task attempt bound exceeded.";
	}
	const closure = invalidationClosure(state, taskId);
	const observed =
		closure.abandonedEpochs.length > 0 ||
		closure.taskIds.some(
			(dependent) =>
				dependent !== taskId &&
				Object.values(state.executions).some(
					(candidate) => candidate.execution.taskId === dependent,
				),
		);
	if (observed) {
		return "Use workflow_invalidate; dependents already observed this task.";
	}
	return undefined;
}

/** On-path tasks that `resumeRefusal` accepts; closure errors exclude the task. */
export function resumableTasks(
	state: WorkflowStateProjection,
): readonly WorkflowTaskId[] {
	return Object.freeze(
		onPathTasks(state)
			.filter((task) => {
				try {
					return resumeRefusal(state, task.task.id) === undefined;
				} catch {
					return false;
				}
			})
			.map((task) => task.task.id),
	);
}

export interface WorkflowRunActionFacts {
	readonly status: WorkflowRunStatus;
	readonly ownership: WorkflowRunOwnership;
	/** Owned and the drive has not settled. */
	readonly driving: boolean;
	readonly nested: boolean;
	readonly deadlinePassed: boolean;
	readonly awaitsRecovery: boolean;
	readonly hasCleanupBlockedTask: boolean;
	readonly retryableTaskCount: number;
	readonly resumableTaskCount: number;
}

export function runActionFacts(input: {
	readonly record: { readonly deadlineAt: string; readonly parent?: unknown };
	/** Undefined when the journal is empty (status "created"). */
	readonly state: WorkflowStateProjection | undefined;
	readonly ownership: WorkflowRunOwnership;
	readonly driving: boolean;
	readonly now: number;
}): WorkflowRunActionFacts {
	const { state } = input;
	return Object.freeze({
		status: state?.status ?? "created",
		ownership: input.ownership,
		driving: input.driving,
		nested: isNestedRun(input.record),
		deadlinePassed: deadlinePassed(input.record.deadlineAt, input.now),
		awaitsRecovery: state ? awaitsRecovery(state) : false,
		hasCleanupBlockedTask: state
			? onPathTasks(state).some((task) => task.status === "cleanup-blocked")
			: false,
		retryableTaskCount: state ? retryableTasks(state).length : 0,
		resumableTaskCount: state ? resumableTasks(state).length : 0,
	});
}

function legal(
	action: WorkflowRunAction,
	facts: WorkflowRunActionFacts,
): boolean {
	if (facts.ownership === "leased-elsewhere") return false;
	const terminal = isTerminalWorkflowRunStatus(facts.status);
	const invalidate =
		admitsInvalidation(facts.status) &&
		!facts.nested &&
		!facts.awaitsRecovery &&
		!facts.deadlinePassed &&
		!facts.driving;
	switch (action) {
		case "stop":
			return !terminal;
		case "wait":
			return !terminal || facts.awaitsRecovery;
		case "reconcile":
			return (
				facts.status === "cleanup-blocked" ||
				(!terminal && facts.ownership === "inactive")
			);
		case "invalidate":
			return invalidate;
		case "retry":
			return invalidate && facts.retryableTaskCount > 0;
		case "resume":
			return (
				facts.status === "interrupted" &&
				!facts.nested &&
				!facts.awaitsRecovery &&
				!facts.deadlinePassed &&
				!facts.driving &&
				facts.resumableTaskCount > 0
			);
		case "decide":
			return false;
	}
}

/**
 * The single legality table for operator actions, filtered by the implemented
 * set and returned in `WORKFLOW_RUN_ACTIONS` order.
 */
export function availableWorkflowRunActions(
	facts: WorkflowRunActionFacts,
): readonly WorkflowRunAction[] {
	return Object.freeze(
		WORKFLOW_RUN_ACTIONS.filter(
			(action) =>
				IMPLEMENTED_WORKFLOW_RUN_ACTIONS.has(action) && legal(action, facts),
		),
	);
}

export function requiresAttention(facts: WorkflowRunActionFacts): boolean {
	return (
		facts.status === "cleanup-blocked" ||
		((facts.status === "failed" || facts.status === "interrupted") &&
			!facts.awaitsRecovery)
	);
}
