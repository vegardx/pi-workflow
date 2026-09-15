import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	canonicalSha256,
	HANDOFF_EXPORT_MEDIA_TYPE,
	isRunResult,
	type RunResult,
} from "@vegardx/pi-subagent";
import { Value } from "typebox/value";
import {
	GitObjectIdSchema,
	SubagentAttemptIdSchema,
	type SubagentHandoffEvidence,
	type SubagentOperationId,
	type SubagentTerminalEvidence,
	type SupportImplementation,
	type TaskExecutionGeneration,
	type TaskExecutionId,
	WORKFLOW_HANDOFF_FORMAT_SHA256,
	type WorkflowArtifactOutput,
	type WorkflowArtifactRef,
	type WorkflowHandoffDescriptor,
	WorkflowHandoffDescriptorSchema,
	type WorkflowRunId,
	type WorkflowTaskId,
} from "./contracts.js";
import type { TaskExecutionProjection } from "./events.js";

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

export function deriveNestedWorkflowRunId(
	parentRunId: WorkflowRunId,
	taskId: WorkflowTaskId,
	generation: TaskExecutionGeneration,
): WorkflowRunId {
	return `workflow_${sha256({
		generation,
		kind: "nested-workflow-run",
		parentRunId,
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

function deriveSubagentHandoffEvidence(
	handoff: unknown,
): SubagentHandoffEvidence | undefined {
	if (handoff === undefined) return undefined;
	if (typeof handoff !== "object" || handoff === null) {
		throw new Error("subagent handoff record is invalid");
	}
	const record = handoff as Record<string, unknown>;
	if (
		!Value.Check(SubagentAttemptIdSchema, record.attemptId) ||
		!Value.Check(GitObjectIdSchema, record.baselineHead)
	) {
		throw new Error("subagent handoff record is invalid");
	}
	// A worktree record without a handoff commit captured no changes.
	if (record.handoffCommit === undefined) return undefined;
	if (
		!Value.Check(GitObjectIdSchema, record.handoffCommit) ||
		record.handoffCommit === record.baselineHead
	) {
		throw new Error("subagent handoff record is invalid");
	}
	return {
		attemptId: record.attemptId,
		baselineHead: record.baselineHead,
		handoffCommit: record.handoffCommit,
	};
}

/**
 * The single settlement-evidence derivation shared by the scheduler and the
 * finalizer, which must compute byte-identical evidence for one attempt result.
 * `handoff` is pi-subagent's worktree record; only its identity is projected.
 */
export function deriveSubagentSettlementEvidence(
	execution: { result: RunResult; handoff?: unknown },
	attemptOrdinal: number,
): SubagentTerminalEvidence {
	const result = execution.result;
	const handoff = deriveSubagentHandoffEvidence(execution.handoff);
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
		...(result.output ? { output: structuredClone(result.output) } : {}),
		...(result.structuredOutput === undefined
			? {}
			: {
					structuredOutputSha256: deriveJsonValueSha256(
						result.structuredOutput,
					),
				}),
		...(handoff === undefined ? {} : { handoff }),
	};
}

export function deriveWorkflowArtifactId(input: {
	runId: WorkflowRunId;
	producerTaskId?: WorkflowTaskId;
	producerExecutionId?: TaskExecutionId;
	output?: WorkflowArtifactOutput;
	schemaSha256: string;
	sha256: string;
}): WorkflowArtifactRef["id"] {
	if (
		(input.producerTaskId === undefined) !== (input.output === undefined) ||
		(input.producerTaskId === undefined) !==
			(input.producerExecutionId === undefined)
	) {
		throw new Error(
			"artifact producer, execution, and output must appear together",
		);
	}
	return `artifact_${sha256({
		output: input.output,
		producerExecutionId: input.producerExecutionId,
		producerTaskId: input.producerTaskId,
		runId: input.runId,
		schemaSha256: input.schemaSha256,
		sha256: input.sha256,
	})}`;
}

export function deriveSupportImplementationIdentitySha256(
	implementation: SupportImplementation,
): string {
	return deriveJsonValueSha256({
		implementationSha256: implementation.implementationSha256,
		moduleSpecifier: implementation.moduleSpecifier,
		name: implementation.name,
		outputSchema: implementation.outputSchema,
		parametersSchema: implementation.parametersSchema,
		revision: implementation.revision,
	});
}

export function deriveWorkflowFailureSha256(
	stage:
		| "preflight"
		| "launch"
		| "reconciliation"
		| "stop"
		| "artifact-import"
		| "release"
		| "support-resolution"
		| "support-input"
		| "support-execution"
		| "support-output"
		| "nested-resolution"
		| "nested-launch"
		| "nested-import"
		| "nested-input"
		| "handoff-import",
	message: string,
): string {
	return sha256({ message, stage });
}

/** The handoff-import projection fields the descriptor is derived from. */
export interface WorkflowHandoffImportProjection {
	readonly subagentRunId: string;
	readonly subagentAttemptId: string;
	readonly artifactId: string;
	readonly handoffCommit: string;
	readonly baselineHead: string;
	readonly sha256: string;
	readonly bytes: number;
}

/**
 * Pure: projects the durable handoff import of an execution and its declared
 * artifact into the JSON descriptor. Requires `projection.handoffImport` and a
 * ref with `output: "handoff"` that belongs to that execution and import.
 */
export function deriveWorkflowHandoffDescriptor(
	ref: WorkflowArtifactRef,
	projection: Pick<TaskExecutionProjection, "execution"> & {
		readonly handoffImport?: WorkflowHandoffImportProjection;
	},
): WorkflowHandoffDescriptor {
	if (ref.output !== "handoff") {
		throw new Error("workflow handoff descriptor requires a handoff artifact");
	}
	const handoffImport = projection.handoffImport;
	if (handoffImport === undefined) {
		throw new Error("workflow handoff descriptor requires a handoff import");
	}
	const execution = projection.execution;
	if (
		execution.kind !== "agent" ||
		ref.id !== handoffImport.artifactId ||
		ref.runId !== execution.runId ||
		ref.producerTaskId !== execution.taskId ||
		ref.producerExecutionId !== execution.id ||
		ref.mediaType !== HANDOFF_EXPORT_MEDIA_TYPE ||
		ref.schemaSha256 !== WORKFLOW_HANDOFF_FORMAT_SHA256 ||
		ref.sha256 !== handoffImport.sha256 ||
		ref.bytes !== handoffImport.bytes
	) {
		throw new Error("workflow handoff artifact does not match its import");
	}
	const descriptor: WorkflowHandoffDescriptor = {
		artifactId: ref.id,
		runId: execution.runId,
		producerTaskId: execution.taskId,
		producerExecutionId: execution.id,
		subagentRunId: handoffImport.subagentRunId,
		subagentAttemptId: handoffImport.subagentAttemptId,
		baselineHead: handoffImport.baselineHead,
		handoffCommit: handoffImport.handoffCommit,
		format: "git-format-patch",
		mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
		sha256: ref.sha256,
		bytes: ref.bytes,
	};
	if (!Value.Check(WorkflowHandoffDescriptorSchema, descriptor)) {
		throw new Error("workflow handoff descriptor is invalid");
	}
	return descriptor;
}
