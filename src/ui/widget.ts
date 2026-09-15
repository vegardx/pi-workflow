import type { WorkflowRunStatus } from "../contracts.js";
import type { WorkflowService } from "../service.js";
import type { WorkflowRunPage, WorkflowRunSummary } from "../service-views.js";
import { ATTENTION_RUN_STATUSES, NONTERMINAL_RUN_STATUSES } from "./format.js";

/**
 * The ambient widget is a projection of `listRuns`: at most two lines, hidden
 * when nothing is ongoing or needs attention. It reads only summary fields
 * (`status`, `leasedElsewhere`, `requiresAttention`) and never decides what
 * an operator may do.
 */

export const WORKFLOW_WIDGET_KEY = "pi-workflow";
export const WORKFLOW_WIDGET_STATUSES: readonly WorkflowRunStatus[] =
	Object.freeze([...NONTERMINAL_RUN_STATUSES, ...ATTENTION_RUN_STATUSES]);
export const WORKFLOW_WIDGET_LIMIT = 100;
export const WORKFLOW_WIDGET_POLL_MS = 5_000;
export const WORKFLOW_WIDGET_DEBOUNCE_MS = 250;
export const WORKFLOW_WIDGET_SHORTCUT = "alt+w";

const ONGOING_ORDER: readonly WorkflowRunStatus[] = [
	"running",
	"waiting",
	"finalizing",
	"stopping",
	"created",
];
const ATTENTION_ORDER: readonly {
	status: WorkflowRunStatus;
	label: string;
}[] = [
	{ status: "failed", label: "failed" },
	{ status: "interrupted", label: "interrupted" },
	{ status: "cleanup-blocked", label: "cleanup blocked" },
];

/** ≤2 lines; `undefined` hides the widget. */
export function workflowWidgetLines(
	runs: readonly WorkflowRunSummary[],
): string[] | undefined {
	const ongoing = new Map<WorkflowRunStatus, number>();
	const attention = new Map<WorkflowRunStatus, number>();
	let elsewhere = 0;
	let recovering = 0;
	for (const run of runs) {
		if (NONTERMINAL_RUN_STATUSES.includes(run.status)) {
			ongoing.set(run.status, (ongoing.get(run.status) ?? 0) + 1);
			if (run.leasedElsewhere) elsewhere += 1;
		} else if (run.requiresAttention) {
			attention.set(run.status, (attention.get(run.status) ?? 0) + 1);
		} else if (run.status === "failed" || run.status === "interrupted") {
			// Durably failed or interrupted with invalidated work pending: the
			// next drive recovers it, so it is ongoing rather than actionable.
			recovering += 1;
		}
	}
	const ongoingParts = ONGOING_ORDER.filter((status) =>
		ongoing.has(status),
	).map((status) => `${ongoing.get(status)} ${status}`);
	if (recovering > 0) ongoingParts.push(`${recovering} recovering`);
	const attentionParts = ATTENTION_ORDER.filter(({ status }) =>
		attention.has(status),
	).map(({ status, label }) => `${attention.get(status)} ${label}`);
	const lines = [
		ongoingParts.length > 0
			? `workflows ongoing: ${ongoingParts.join(" · ")}${
					elsewhere > 0 ? ` (${elsewhere} elsewhere)` : ""
				}`
			: undefined,
		attentionParts.length > 0
			? `workflows need action: ${attentionParts.join(" · ")}`
			: undefined,
	].filter((line): line is string => line !== undefined);
	if (lines.length === 0) return undefined;
	lines[lines.length - 1] = `${lines.at(-1)} · ${WORKFLOW_WIDGET_SHORTCUT}`;
	return lines;
}

/**
 * Polling is needed while any listed run can change without notifying this
 * service: nonterminal runs (those leased elsewhere never notify) and runs
 * awaiting recovery.
 */
export function widgetNeedsPolling(
	runs: readonly WorkflowRunSummary[],
): boolean {
	return runs.some(
		(run) =>
			NONTERMINAL_RUN_STATUSES.includes(run.status) ||
			(ATTENTION_RUN_STATUSES.includes(run.status) && !run.requiresAttention),
	);
}

type TimerHandle = unknown;

export interface WidgetControllerOptions {
	readonly service: Pick<WorkflowService, "listRuns" | "subscribe">;
	readonly setWidget: (lines: string[] | undefined) => void;
	/** Injectable for tests; production timers are unref'd. */
	readonly setTimer?: (callback: () => void, ms: number) => TimerHandle;
	readonly clearTimer?: (handle: TimerHandle) => void;
	readonly setInterval?: (callback: () => void, ms: number) => TimerHandle;
	readonly clearInterval?: (handle: TimerHandle) => void;
}

export interface WidgetController {
	/** Subscribes, refreshes once, and starts polling when needed. */
	start(): Promise<void>;
	/** Coalesced: at most one `listRuns` in flight and one queued. */
	refresh(): Promise<void>;
	/** Unsubscribes, clears timers, hides the widget; later callbacks are no-ops. */
	stop(): void;
	/** The last page read; shared with command completions. */
	readonly lastPage: WorkflowRunPage | undefined;
}

function unref(handle: TimerHandle): TimerHandle {
	if (
		typeof handle === "object" &&
		handle !== null &&
		"unref" in handle &&
		typeof handle.unref === "function"
	) {
		handle.unref();
	}
	return handle;
}

export function createWidgetController(
	options: WidgetControllerOptions,
): WidgetController {
	const schedule =
		options.setTimer ??
		((callback, ms) => unref(setTimeout(callback, ms) as TimerHandle));
	const cancel =
		options.clearTimer ??
		((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	const repeat =
		options.setInterval ??
		((callback, ms) => unref(setInterval(callback, ms) as TimerHandle));
	const stopRepeat =
		options.clearInterval ??
		((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

	let disposed = false;
	let unsubscribe: (() => void) | undefined;
	let debounce: TimerHandle | undefined;
	let poll: TimerHandle | undefined;
	let inFlight: Promise<void> | undefined;
	let queued = false;
	let lastPage: WorkflowRunPage | undefined;

	function stopPolling(): void {
		if (poll === undefined) return;
		stopRepeat(poll);
		poll = undefined;
	}

	function ensurePolling(): void {
		if (poll !== undefined || disposed) return;
		poll = repeat(() => void refresh(), WORKFLOW_WIDGET_POLL_MS);
	}

	async function refreshOnce(): Promise<void> {
		try {
			const page = await options.service.listRuns({
				statuses: [...WORKFLOW_WIDGET_STATUSES],
				limit: WORKFLOW_WIDGET_LIMIT,
			});
			if (disposed) return;
			lastPage = page;
			options.setWidget(workflowWidgetLines(page.runs));
			if (widgetNeedsPolling(page.runs)) ensurePolling();
			else stopPolling();
		} catch {
			if (disposed) return;
			// The next subscribe event retries; until then nothing is claimed.
			options.setWidget(undefined);
			stopPolling();
		}
	}

	function refresh(): Promise<void> {
		if (disposed) return Promise.resolve();
		if (inFlight) {
			queued = true;
			return inFlight;
		}
		inFlight = (async () => {
			do {
				queued = false;
				await refreshOnce();
			} while (queued && !disposed);
		})().finally(() => {
			inFlight = undefined;
		});
		return inFlight;
	}

	function onObservation(): void {
		if (disposed || debounce !== undefined) return;
		debounce = schedule(() => {
			debounce = undefined;
			void refresh();
		}, WORKFLOW_WIDGET_DEBOUNCE_MS);
	}

	return {
		async start() {
			if (disposed) return;
			unsubscribe ??= options.service.subscribe(onObservation);
			await refresh();
		},
		refresh,
		stop() {
			if (disposed) return;
			disposed = true;
			unsubscribe?.();
			unsubscribe = undefined;
			if (debounce !== undefined) {
				cancel(debounce);
				debounce = undefined;
			}
			stopPolling();
			options.setWidget(undefined);
		},
		get lastPage() {
			return lastPage;
		},
	};
}
