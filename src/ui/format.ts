import {
	MAX_TASK_EXECUTION_GENERATIONS,
	type WorkflowRunStatus,
	type WorkflowTaskStatus,
} from "../contracts.js";
import { MAX_DYNAMIC_APPROVAL_RENDER_BYTES } from "../dynamic/constants.js";
import type { DynamicWorkflowProposalInspection } from "../service.js";
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

/** JSON with object keys sorted at every level; arrays keep their order. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, entry: unknown) => {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			return entry;
		}
		return Object.fromEntries(
			Object.entries(entry as Record<string, unknown>).sort(
				([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
			),
		);
	});
}

/**
 * The body of the approve/reject confirmation: identity, budget, digests,
 * schemas, the current decision state, and the numbered source. The result
 * never exceeds `MAX_DYNAMIC_APPROVAL_RENDER_BYTES`: source lines are cut and
 * the last line points the approver at the stored source file.
 */
export function renderDynamicProposal(
	view: DynamicWorkflowProposalInspection,
): string {
	const { meta } = view.manifest;
	const tokens = meta.budget.totalTokens
		? ` · ${formatTokens(meta.budget.totalTokens)} tok`
		: "";
	const decision = view.decision
		? `${view.decision.decision} at ${view.decision.approvedAt} by ${view.decision.approver.kind}:${view.decision.approver.via}${view.decision.reason ? ` (${view.decision.reason})` : ""}`
		: "none (awaiting a human decision)";
	const header = [
		`Dynamic workflow ${view.ref}`,
		`name: ${meta.name} v${meta.version} · concurrency ${meta.concurrency} · budget ${formatCost(meta.budget.cost)}${tokens} · ${formatDurationMs(meta.budget.childRuntimeMs)} child runtime · timeout ${formatDurationMs(meta.timeoutMs)}`,
		`description: ${meta.description}`,
		`proposed: ${view.proposedAt} by ${view.proposer.kind}:${view.proposer.via}`,
		`decision: ${decision}`,
		`runnable: ${view.runnable ? "yes" : "no"}`,
		`host API: ${view.hostApiSha256}`,
		`import policy: ${view.importPolicySha256}`,
		`identity: ${view.definitionIdentitySha256}`,
		`input schema: ${canonicalJson(view.manifest.inputSchema)}`,
		`output schema: ${canonicalJson(view.manifest.outputSchema)}`,
		`source (${view.sourceBytes} bytes, sha256 ${view.sourceSha256}):`,
	];
	const sourceLines = view.source
		.split("\n")
		.map((line, index) => `${String(index + 1).padStart(4)} │ ${line}`);
	const full = [...header, ...sourceLines].join("\n");
	if (Buffer.byteLength(full) <= MAX_DYNAMIC_APPROVAL_RENDER_BYTES) return full;
	const notice = `… source truncated at ${MAX_DYNAMIC_APPROVAL_RENDER_BYTES} bytes; read ${view.path} before approving.`;
	const kept: string[] = [];
	let bytes = Buffer.byteLength([...header, notice].join("\n"));
	for (const line of sourceLines) {
		const cost = Buffer.byteLength(line) + 1;
		if (bytes + cost > MAX_DYNAMIC_APPROVAL_RENDER_BYTES) break;
		kept.push(line);
		bytes += cost;
	}
	return [...header, ...kept, notice].join("\n");
}
