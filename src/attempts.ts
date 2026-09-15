import type { RunStatus as SubagentRunStatus } from "@vegardx/pi-subagent";
import type { TaskExecutionProjection } from "./events.js";

export interface CurrentSubagentAttempt {
	readonly subagentAttemptId: string;
	readonly status: SubagentRunStatus;
}

export function currentSubagentAttempt(
	projection: TaskExecutionProjection,
): CurrentSubagentAttempt | undefined {
	for (const attempt of [...(projection.attempts ?? [])].reverse()) {
		if (
			attempt.receiptSequence !== undefined &&
			attempt.subagentAttemptId !== undefined &&
			attempt.status !== undefined
		) {
			return {
				subagentAttemptId: attempt.subagentAttemptId,
				status: attempt.status,
			};
		}
	}
	const receipt = projection.launchReceipt;
	if (!receipt) return undefined;
	return {
		subagentAttemptId: receipt.subagentAttemptId,
		status: receipt.status,
	};
}

export function currentSubagentAttemptId(
	projection: TaskExecutionProjection,
): string | undefined {
	return currentSubagentAttempt(projection)?.subagentAttemptId;
}

export interface SettledAgentUsage {
	readonly cost: number;
	readonly totalTokens: number;
	readonly runtimeMs: number;
	readonly usageComplete: boolean;
}

export function settledAgentUsage(
	projection: TaskExecutionProjection,
): SettledAgentUsage {
	const settlements = [
		...(projection.priorSettlements ?? []),
		...(projection.settlement ? [projection.settlement] : []),
	];
	let cost = 0;
	let totalTokens = 0;
	let runtimeMs = 0;
	let usageComplete = true;
	for (const settlement of settlements) {
		cost += settlement.evidence.usage.cost;
		totalTokens += settlement.evidence.usage.totalTokens;
		runtimeMs += settlement.evidence.runtimeMs;
		usageComplete &&= settlement.evidence.usageComplete;
	}
	return { cost, totalTokens, runtimeMs, usageComplete };
}
