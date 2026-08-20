import type { WorkflowRunStatus, WorkflowTaskStatus } from "./contracts.js";

const RUN_TRANSITIONS: Readonly<
	Record<WorkflowRunStatus, ReadonlySet<WorkflowRunStatus>>
> = {
	created: new Set(["running", "cancelled", "failed"]),
	running: new Set([
		"waiting",
		"finalizing",
		"stopping",
		"failed",
		"interrupted",
		"cleanup-blocked",
	]),
	waiting: new Set([
		"running",
		"stopping",
		"failed",
		"interrupted",
		"cleanup-blocked",
	]),
	finalizing: new Set([
		"stopping",
		"completed",
		"completed-degraded",
		"failed",
		"cleanup-blocked",
	]),
	stopping: new Set(["cancelled", "failed", "cleanup-blocked"]),
	completed: new Set(),
	"completed-degraded": new Set(),
	failed: new Set(["running"]),
	cancelled: new Set(),
	interrupted: new Set(["running", "stopping"]),
	"cleanup-blocked": new Set([
		"finalizing",
		"completed",
		"completed-degraded",
		"failed",
		"cancelled",
		"interrupted",
	]),
};

const TASK_TRANSITIONS: Readonly<
	Record<WorkflowTaskStatus, ReadonlySet<WorkflowTaskStatus>>
> = {
	pending: new Set(["ready", "blocked", "cancelled", "invalidated"]),
	ready: new Set(["running", "blocked", "cancelled", "invalidated"]),
	running: new Set([
		"waiting",
		"completed",
		"failed",
		"interrupted",
		"cancelling",
		"cleanup-blocked",
	]),
	waiting: new Set([
		"running",
		"completed",
		"failed",
		"interrupted",
		"cancelling",
		"cleanup-blocked",
	]),
	completed: new Set(["invalidated"]),
	failed: new Set(["running", "invalidated"]),
	interrupted: new Set(["running", "cancelling", "invalidated"]),
	blocked: new Set(["pending", "ready", "cancelled", "invalidated"]),
	cancelling: new Set(["cancelled", "failed", "cleanup-blocked"]),
	cancelled: new Set(["invalidated"]),
	"cleanup-blocked": new Set([
		"completed",
		"failed",
		"cancelled",
		"interrupted",
	]),
	invalidated: new Set(),
};

export class InvalidWorkflowRunTransitionError extends Error {
	constructor(
		readonly from: WorkflowRunStatus,
		readonly to: WorkflowRunStatus,
	) {
		super(`invalid workflow run transition: ${from} -> ${to}`);
		this.name = "InvalidWorkflowRunTransitionError";
	}
}

export class InvalidWorkflowTaskTransitionError extends Error {
	constructor(
		readonly from: WorkflowTaskStatus,
		readonly to: WorkflowTaskStatus,
	) {
		super(`invalid workflow task transition: ${from} -> ${to}`);
		this.name = "InvalidWorkflowTaskTransitionError";
	}
}

export function transitionWorkflowRunStatus(
	from: WorkflowRunStatus,
	to: WorkflowRunStatus,
): WorkflowRunStatus {
	if (!RUN_TRANSITIONS[from].has(to)) {
		throw new InvalidWorkflowRunTransitionError(from, to);
	}
	return to;
}

export function transitionWorkflowTaskStatus(
	from: WorkflowTaskStatus,
	to: WorkflowTaskStatus,
): WorkflowTaskStatus {
	if (!TASK_TRANSITIONS[from].has(to)) {
		throw new InvalidWorkflowTaskTransitionError(from, to);
	}
	return to;
}
