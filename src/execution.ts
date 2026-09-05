import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	canonicalSha256,
	isRunResult,
	type RunResult,
} from "@vegardx/pi-subagent";
import type {
	SubagentOperationId,
	TaskExecutionGeneration,
	TaskExecutionId,
	WorkflowRunId,
	WorkflowTaskId,
} from "./contracts.js";

function sha256(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function deriveTaskExecutionId(
	runId: WorkflowRunId,
	taskId: WorkflowTaskId,
	generation: TaskExecutionGeneration,
): TaskExecutionId {
	return `execution_${sha256({ generation, runId, taskId })}`;
}

export function deriveSubagentOperationId(
	runId: WorkflowRunId,
	taskId: WorkflowTaskId,
	generation: TaskExecutionGeneration,
): SubagentOperationId {
	return `workflow-op_${sha256({
		generation,
		kind: "agent-task-launch",
		runId,
		taskId,
	})}`;
}

export function deriveJsonValueSha256(value: unknown): string {
	return canonicalSha256(value);
}

export function deriveSubagentResultSha256(result: RunResult): string {
	if (!isRunResult(result)) throw new Error("invalid subagent result");
	const serialized = JSON.stringify(result);
	const roundTrip = JSON.parse(serialized) as RunResult;
	if (!isDeepStrictEqual(result, roundTrip)) {
		throw new Error("subagent result is not losslessly JSON-serializable");
	}
	return canonicalSha256(roundTrip);
}

export function deriveWorkflowFailureSha256(
	stage:
		| "preflight"
		| "launch"
		| "reconciliation"
		| "stop"
		| "artifact-import"
		| "release",
	message: string,
): string {
	return sha256({ message, stage });
}
