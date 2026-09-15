import { HANDOFF_EXPORT_MEDIA_TYPE } from "@vegardx/pi-subagent";
import type { WorkflowArtifactStore } from "./artifact-store.js";
import {
	WORKFLOW_HANDOFF_FORMAT_SHA256,
	type WorkflowArtifactRef,
} from "./contracts.js";
import type {
	TaskExecutionProjection,
	WorkflowStateProjection,
	WorkflowTaskProjection,
} from "./events.js";

/**
 * The single message the runtime, input readers, and service surface when
 * a completed worktree task's handoff evidence does not verify (spec 5).
 */
export const WORKFLOW_HANDOFF_UNVERIFIED_MESSAGE =
	"Completed worktree task has no verified handoff artifact.";

/** Fixed reasons of a failed verification; the message is the reason's text. */
export const WORKFLOW_HANDOFF_VERIFICATION_MESSAGES = Object.freeze({
	"not-worktree-task": "handoff verification requires a worktree agent task",
	"no-current-execution":
		"handoff verification requires a current agent execution",
	"preflight-not-worktree":
		"handoff execution preflight did not plan a worktree",
	"no-settlement": "handoff execution has no completed settlement",
	"no-handoff-evidence": "handoff execution recorded no handoff evidence",
	"required-absent": "required handoff is absent",
	"artifact-not-current":
		"handoff artifact is not declared for the current execution",
	"artifact-unreadable": "handoff artifact is unreadable",
	"commit-mismatch": "handoff artifact does not name the imported commit",
	"settlement-mismatch": "handoff import does not match the settlement handoff",
});
export type WorkflowHandoffVerificationReason =
	keyof typeof WORKFLOW_HANDOFF_VERIFICATION_MESSAGES;

export class WorkflowHandoffVerificationError extends Error {
	constructor(
		readonly reason: WorkflowHandoffVerificationReason,
		options?: ErrorOptions,
	) {
		super(WORKFLOW_HANDOFF_VERIFICATION_MESSAGES[reason], options);
		this.name = "WorkflowHandoffVerificationError";
	}
}

export type VerifiedWorkflowHandoff =
	| {
			readonly status: "imported";
			readonly execution: TaskExecutionProjection;
			readonly artifact: WorkflowArtifactRef;
			readonly content: Buffer;
	  }
	| {
			readonly status: "absent";
			readonly execution: TaskExecutionProjection;
	  };

/** git's fixed mbox separator; the captured group is the rendered commit. */
const HANDOFF_PATCH_FIRST_LINE =
	/^From ([a-f0-9]{40,64}) Mon Sep 17 00:00:00 2001$/;

function firstLineObjectId(content: Buffer): string | undefined {
	const newline = content.indexOf(0x0a);
	if (newline === -1) return undefined;
	return HANDOFF_PATCH_FIRST_LINE.exec(
		content.subarray(0, newline).toString("utf8"),
	)?.[1];
}

/**
 * Replay identity of a completed worktree task (spec 5, D8): the current
 * execution was preflighted as a worktree, and either recorded a handoff
 * absence under the optional policy, or imported a handoff artifact that is
 * declared for this execution, reads through the store with its digest and
 * patch shape intact, names the imported commit on its first line, and whose
 * `{ attemptId, baselineHead, handoffCommit }` equal the settlement's. Every
 * lookup selects the current execution's artifact; prior generations remain
 * declared history. Failures throw `WorkflowHandoffVerificationError`.
 */
export async function verifyWorkflowHandoffEvidence(
	state: WorkflowStateProjection,
	task: WorkflowTaskProjection,
	artifacts: WorkflowArtifactStore,
): Promise<VerifiedWorkflowHandoff> {
	const spec = task.task.spec;
	if (spec.kind !== "agent" || spec.request.workspace.mode !== "worktree") {
		throw new WorkflowHandoffVerificationError("not-worktree-task");
	}
	const currentExecutionId = task.currentExecutionId;
	const execution =
		currentExecutionId === undefined
			? undefined
			: state.executions[currentExecutionId];
	if (
		execution?.execution.kind !== "agent" ||
		execution.execution.taskId !== task.task.id
	) {
		throw new WorkflowHandoffVerificationError("no-current-execution");
	}
	if (execution.preflight?.workspaceMode !== "worktree") {
		throw new WorkflowHandoffVerificationError("preflight-not-worktree");
	}
	const settlement = execution.settlement;
	if (settlement?.evidence.status !== "completed") {
		throw new WorkflowHandoffVerificationError("no-settlement");
	}
	const handoffImport = execution.handoffImport;
	if (handoffImport === undefined) {
		if (execution.handoffAbsent === undefined) {
			throw new WorkflowHandoffVerificationError("no-handoff-evidence");
		}
		if (spec.request.handoff !== "optional") {
			throw new WorkflowHandoffVerificationError("required-absent");
		}
		if (settlement.evidence.handoff !== undefined) {
			throw new WorkflowHandoffVerificationError("settlement-mismatch");
		}
		return { status: "absent", execution };
	}
	const settled = settlement.evidence.handoff;
	if (
		!settled ||
		settled.attemptId !== handoffImport.subagentAttemptId ||
		settled.baselineHead !== handoffImport.baselineHead ||
		settled.handoffCommit !== handoffImport.handoffCommit
	) {
		throw new WorkflowHandoffVerificationError("settlement-mismatch");
	}
	const artifact = state.artifacts[handoffImport.artifactId];
	if (
		!artifact ||
		artifact.runId !== state.runId ||
		artifact.output !== "handoff" ||
		artifact.producerTaskId !== task.task.id ||
		artifact.producerExecutionId !== execution.execution.id ||
		artifact.mediaType !== HANDOFF_EXPORT_MEDIA_TYPE ||
		artifact.schemaSha256 !== WORKFLOW_HANDOFF_FORMAT_SHA256 ||
		artifact.sha256 !== handoffImport.sha256 ||
		artifact.bytes !== handoffImport.bytes
	) {
		throw new WorkflowHandoffVerificationError("artifact-not-current");
	}
	let content: Buffer;
	try {
		content = await artifacts.readBytes(artifact);
	} catch (error) {
		throw new WorkflowHandoffVerificationError("artifact-unreadable", {
			cause: error,
		});
	}
	if (firstLineObjectId(content) !== handoffImport.handoffCommit) {
		throw new WorkflowHandoffVerificationError("commit-mismatch");
	}
	return { status: "imported", execution, artifact, content };
}
