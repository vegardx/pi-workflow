import {
	MAX_TASK_EXECUTION_GENERATIONS,
	type WorkflowRunStatus,
	type WorkflowTaskStatus,
} from "../contracts.js";
import type {
	WorkflowLogEntry,
	WorkflowRunSummary,
	WorkflowServiceTaskView,
} from "../service-views.js";

/**
 * Pure rendering helpers for the operator surface. Everything here maps
 * persisted views to strings; nothing decides legality or lifecycle, and
 * nothing here touches pi-tui: terminal-width padding and truncation live in
 * the lazily loaded inspector module.
 */

export const RUN_STATUS_ICON: Readonly<Record<WorkflowRunStatus, string>> =
	Object.freeze({
		created: "○",
		running: "▶",
		waiting: "◔",
		finalizing: "◑",
		stopping: "■",
		completed: "✓",
		"completed-degraded": "✓",
		failed: "●",
		cancelled: "−",
		interrupted: "!",
		"cleanup-blocked": "✕",
	});

export const TASK_STATUS_ICON: Readonly<Record<WorkflowTaskStatus, string>> =
	Object.freeze({
		pending: "○",
		ready: "◌",
		running: "▶",
		waiting: "◔",
		completed: "✓",
		failed: "●",
		interrupted: "!",
		blocked: "⊘",
		cancelling: "■",
		cancelled: "−",
		"cleanup-blocked": "✕",
		invalidated: "↺",
	});

export const NONTERMINAL_RUN_STATUSES: readonly WorkflowRunStatus[] =
	Object.freeze(["created", "running", "waiting", "finalizing", "stopping"]);

export const ATTENTION_RUN_STATUSES: readonly WorkflowRunStatus[] =
	Object.freeze(["failed", "interrupted", "cleanup-blocked"]);

export const TERMINAL_RUN_STATUSES: readonly WorkflowRunStatus[] =
	Object.freeze([
		"completed",
		"completed-degraded",
		"failed",
		"cancelled",
		"interrupted",
		"cleanup-blocked",
	]);

export function isNonterminalRunStatus(status: WorkflowRunStatus): boolean {
	return NONTERMINAL_RUN_STATUSES.includes(status);
}

/** `12s`, `4m`, `3h`, `2d`; `?` for an unparseable timestamp. */
export function formatAge(timestamp: string, now = Date.now()): string {
	const parsed = Date.parse(timestamp);
	if (!Number.isFinite(parsed)) return "?";
	const seconds = Math.floor(Math.max(0, now - parsed) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/** `in 4m` while the timestamp is ahead of `now`, otherwise `passed`. */
export function formatUntil(timestamp: string, now = Date.now()): string {
	const parsed = Date.parse(timestamp);
	if (!Number.isFinite(parsed)) return "?";
	if (parsed <= now) return "passed";
	return `in ${formatAge(new Date(now).toISOString(), parsed)}`;
}

/** `999`, `1.2k`, `35k`. */
export function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}

export function formatCost(cost: number): string {
	return `$${cost.toFixed(4)}`;
}

/** `850 ms`, `12.4 s`, `3m 05s`, `2h 07m`. */
export function formatDurationMs(ms: number): string {
	const clamped = Math.max(0, Math.floor(ms));
	if (clamped < 1000) return `${clamped} ms`;
	if (clamped < 60_000) return `${(clamped / 1000).toFixed(1)} s`;
	const totalSeconds = Math.floor(clamped / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) {
		return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
	}
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** At most 14 characters: the first 12 and an ellipsis when longer. */
export function shortId(value: string): string {
	return value.length <= 14 ? value : `${value.slice(0, 12)}…`;
}

export function taskPath(
	task: Pick<WorkflowServiceTaskView, "namespace" | "key">,
): string {
	return [...task.namespace, task.key].join("/");
}

/** Trims and strips one leading `/` (log entries prefix root tasks with it). */
export function normalizeTaskKey(input: string): string {
	const trimmed = input.trim();
	return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
}

/** `gen n/16` for re-executed tasks; blank for the first generation. */
export function formatGeneration(generation: number): string {
	return generation > 1
		? `gen ${generation}/${MAX_TASK_EXECUTION_GENERATIONS}`
		: "";
}

export function ownershipLabel(
	summary: Pick<WorkflowRunSummary, "ownership">,
): string {
	switch (summary.ownership) {
		case "owned":
			return "owned";
		case "leased-elsewhere":
			return "leased elsewhere";
		case "inactive":
			return "inactive";
	}
}

/** One unpadded text line per run for the non-TUI fallback. */
export function runLine(summary: WorkflowRunSummary): string {
	const marker = summary.leasedElsewhere ? "⇄ " : "  ";
	const depth = summary.depth > 0 ? ` (depth ${summary.depth})` : "";
	return `${marker}${RUN_STATUS_ICON[summary.status]} ${summary.status.padEnd(18)} ${summary.runId} ${summary.definitionName}${depth} [${summary.availableActions.join(", ")}]`;
}

/** One unpadded text line per task; abandoned tasks are marked, never hidden. */
export function taskLine(task: WorkflowServiceTaskView): string {
	const flags = `${task.kind}${task.role === "finalizer" ? " finalizer" : ""}${task.disposition === "optional" ? " optional" : ""}`;
	const attempts = task.attempts ? ` · ${task.attempts} attempt(s)` : "";
	const failure = task.settlement?.failureCode
		? ` · ${task.settlement.failureCode}`
		: "";
	const abandoned = task.abandoned ? " · abandoned" : "";
	return `${TASK_STATUS_ICON[task.status]} ${task.status.padEnd(15)} ${taskPath(task).padEnd(24)} ${flags} ${formatGeneration(task.generation)}${attempts}${failure}${abandoned}`.trimEnd();
}

export function logLine(entry: WorkflowLogEntry): string {
	const task = entry.taskKey ? `${normalizeTaskKey(entry.taskKey)} ` : "";
	const abandoned = entry.abandoned ? " (abandoned)" : "";
	return `${String(entry.sequence).padStart(5)} ${entry.timestamp} ${entry.kind.padEnd(12)} ${task}${entry.message}${abandoned}`;
}
