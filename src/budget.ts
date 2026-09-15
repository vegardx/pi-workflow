import { settledAgentUsage } from "./attempts.js";
import type { WorkflowBudget, WorkflowTaskId } from "./contracts.js";
import type { WorkflowStateProjection } from "./events.js";

export interface WorkflowSettledUsage {
	readonly cost: number;
	readonly totalTokens: number;
	readonly childRuntimeMs: number;
	readonly usageComplete: boolean;
	/** Fixed string naming the first incomplete evidence; present iff `usageComplete` is false. */
	readonly incompleteReason?: string;
}

export interface WorkflowReservedUsage {
	readonly cost: number;
	readonly totalTokens: number;
	readonly childRuntimeMs: number;
	/** Fixed string for the first reservation that cannot be accounted; absent when every reservation is sound. */
	readonly refusal?: string;
}

export interface WorkflowUsage {
	readonly settled: WorkflowSettledUsage;
	readonly reserved: WorkflowReservedUsage;
	/** The first settled-evidence or reservation problem in execution order. */
	readonly refusal?: string;
}

export interface WorkflowUsageOptions {
	/** Skip this task's active execution: admission decides on it, so counting it would double-charge. */
	readonly excludeTaskId?: WorkflowTaskId;
	/** Reservation accounting needs the budget to know whether total tokens are bounded. */
	readonly budget?: WorkflowBudget;
}

/**
 * One pass over every execution: settled usage (`settledAgentUsage` per agent
 * execution, `nestedSettlement.usage` per nested execution) and reserved usage
 * (declared agent limits behind a launch receipt without settlement, and the
 * declared budget of launched, unsettled nested executions). The first problem
 * encountered in execution order is reported as `refusal`.
 */
export function workflowUsage(
	state: WorkflowStateProjection,
	options: WorkflowUsageOptions = {},
): WorkflowUsage {
	const budget = options.budget;
	let settledCost = 0;
	let settledTotalTokens = 0;
	let settledChildRuntimeMs = 0;
	let usageComplete = true;
	let incompleteReason: string | undefined;
	let reservedCost = 0;
	let reservedTotalTokens = 0;
	let reservedChildRuntimeMs = 0;
	let reservationRefusal: string | undefined;
	let refusal: string | undefined;
	const problem = (message: string) => {
		refusal ??= message;
	};
	for (const execution of Object.values(state.executions)) {
		if (
			options.excludeTaskId !== undefined &&
			execution.execution.taskId === options.excludeTaskId &&
			!execution.settlement &&
			!execution.nestedSettlement
		) {
			continue;
		}
		if (execution.settlement) {
			const usage = settledAgentUsage(execution);
			if (!usage.usageComplete) {
				usageComplete = false;
				incompleteReason ??= "Workflow child usage evidence is incomplete.";
				problem("Workflow child usage evidence is incomplete.");
			}
			settledCost += usage.cost;
			settledTotalTokens += usage.totalTokens;
			settledChildRuntimeMs += usage.runtimeMs;
			continue;
		}
		if (execution.nestedSettlement) {
			if (!execution.nestedSettlement.usageComplete) {
				usageComplete = false;
				incompleteReason ??= "Nested workflow usage evidence is incomplete.";
				problem("Nested workflow usage evidence is incomplete.");
			}
			settledCost += execution.nestedSettlement.usage.cost;
			settledTotalTokens += execution.nestedSettlement.usage.totalTokens;
			settledChildRuntimeMs += execution.nestedSettlement.usage.childRuntimeMs;
			continue;
		}
		if (execution.nestedLaunch && execution.nestedIntent) {
			if (
				budget?.totalTokens !== undefined &&
				execution.nestedIntent.budget.totalTokens === undefined
			) {
				reservationRefusal ??=
					"Active nested workflow has no total-token budget for its reservation.";
				problem(
					"Active nested workflow has no total-token budget for its reservation.",
				);
			}
			reservedCost += execution.nestedIntent.budget.cost;
			reservedTotalTokens += execution.nestedIntent.budget.totalTokens ?? 0;
			reservedChildRuntimeMs += execution.nestedIntent.budget.childRuntimeMs;
			continue;
		}
		if (!execution.launchReceipt) continue;
		const task = state.tasks[execution.execution.taskId];
		if (!task) {
			reservationRefusal ??=
				"Workflow budget reservation has no task declaration.";
			problem("Workflow budget reservation has no task declaration.");
			continue;
		}
		if (task.task.spec.kind !== "agent") {
			reservationRefusal ??=
				"Workflow budget reservation is not an agent task.";
			problem("Workflow budget reservation is not an agent task.");
			continue;
		}
		if (
			budget?.totalTokens !== undefined &&
			task.task.spec.request.limits.totalTokens === undefined
		) {
			reservationRefusal ??=
				"Active workflow task has no total-token maximum for its reservation.";
			problem(
				"Active workflow task has no total-token maximum for its reservation.",
			);
		}
		reservedCost += task.task.spec.request.limits.cost;
		reservedTotalTokens += task.task.spec.request.limits.totalTokens ?? 0;
		reservedChildRuntimeMs += task.task.spec.request.limits.cumulativeRuntimeMs;
	}
	return Object.freeze({
		settled: Object.freeze({
			cost: settledCost,
			totalTokens: settledTotalTokens,
			childRuntimeMs: settledChildRuntimeMs,
			usageComplete,
			...(incompleteReason === undefined ? {} : { incompleteReason }),
		}),
		reserved: Object.freeze({
			cost: reservedCost,
			totalTokens: reservedTotalTokens,
			childRuntimeMs: reservedChildRuntimeMs,
			...(reservationRefusal === undefined
				? {}
				: { refusal: reservationRefusal }),
		}),
		...(refusal === undefined ? {} : { refusal }),
	});
}

/** Settled usage across every agent and nested execution. */
export function settledWorkflowUsage(
	state: WorkflowStateProjection,
): WorkflowSettledUsage {
	return workflowUsage(state).settled;
}

/** Declared limits of launched, unsettled agent and nested executions. */
export function reservedWorkflowUsage(
	state: WorkflowStateProjection,
	budget: WorkflowBudget,
): WorkflowReservedUsage {
	return workflowUsage(state, { budget }).reserved;
}

/**
 * The fixed scheduler string for settled usage that is incomplete or exceeds
 * the effective budget; undefined when settled usage fits.
 */
export function budgetExceededReason(
	settled: WorkflowSettledUsage,
	budget: WorkflowBudget,
): string | undefined {
	if (!settled.usageComplete) {
		return (
			settled.incompleteReason ?? "Workflow child usage evidence is incomplete."
		);
	}
	if (settled.cost > budget.cost) return "Workflow cost budget was exceeded.";
	if (
		budget.totalTokens !== undefined &&
		settled.totalTokens > budget.totalTokens
	) {
		return "Workflow total-token budget was exceeded.";
	}
	if (settled.childRuntimeMs > budget.childRuntimeMs) {
		return "Workflow child-runtime budget was exceeded.";
	}
	return undefined;
}
