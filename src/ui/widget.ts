import type { WorkflowRunStatus } from "../contracts.js";
import type { WorkflowService } from "../service.js";
import type { WorkflowRunPage, WorkflowRunSummary } from "../service-views.js";
import { ATTENTION_RUN_STATUSES, NONTERMINAL_RUN_STATUSES } from "./format.js";

/**
 * The ambient widget is a projection of `listRuns`: at most two lines, hidden
 * when nothing is ongoing or needs attention. It reads only summary fields
 * (`status`, `leasedElsewhere`, `requiresAttention`, `ownership`,
 * `availableActions`, `pendingCheckpointCount`) and never decides what an
 * operator may do.
 *
 * The single non-summary fact it shows is the checkpoint prompt of a parked
 * run this session owns. A prompt is not a summary field, so the controller
 * reads it through one lease-free `inspect(runId, { include: ["tasks"] })` and
 * caches it until that run stops being the parked one; polling never
 * re-inspects.
 */

export const WORKFLOW_WIDGET_KEY = "pi-workflow";
export const WORKFLOW_WIDGET_STATUSES: readonly WorkflowRunStatus[] =
	Object.freeze([...NONTERMINAL_RUN_STATUSES, ...ATTENTION_RUN_STATUSES]);
export const WORKFLOW_WIDGET_LIMIT = 100;
export const WORKFLOW_WIDGET_POLL_MS = 5_000;
export const WORKFLOW_WIDGET_DEBOUNCE_MS = 250;
export const WORKFLOW_WIDGET_SHORTCUT = "alt+w";
/** Columns a widget line is cut to; the widget has no terminal width of its own. */
export const WORKFLOW_WIDGET_WIDTH = 80;
/** Opens the first line while a run this session owns waits for a decision. */
export const WORKFLOW_WIDGET_PARKED_PREFIX = "waiting for you: ";

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

/**
 * The first listed run this session owns that waits for a decision it may
 * record. `decide` comes from `availableActions`, so nested children and runs
 * leased by another Pi process are excluded by the service, not by the widget.
 */
export function firstParkedOwnedRun(
	runs: readonly WorkflowRunSummary[],
): WorkflowRunSummary | undefined {
	return runs.find(
		(run) =>
			run.status === "waiting" &&
			run.ownership === "owned" &&
			run.pendingCheckpointCount > 0 &&
			run.availableActions.includes("decide"),
	);
}

/** `waiting for you: <prompt>` on one line, cut to the widget width. */
function parkedLine(prompt: string): string | undefined {
	const collapsed = prompt.replace(/\s+/g, " ").trim();
	if (collapsed === "") return undefined;
	const line = `${WORKFLOW_WIDGET_PARKED_PREFIX}${collapsed}`;
	return line.length <= WORKFLOW_WIDGET_WIDTH
		? line
		: `${line.slice(0, WORKFLOW_WIDGET_WIDTH - 1)}…`;
}

/**
 * ≤2 lines; `undefined` hides the widget. With `parkedPrompt` - the prompt of
 * the run `firstParkedOwnedRun` selects - the question takes the first line
 * and the ongoing and attention counts collapse into the second, so the
 * two-line bound holds.
 */
export function workflowWidgetLines(
	runs: readonly WorkflowRunSummary[],
	parkedPrompt?: string,
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
	const counts = [
		ongoingParts.length > 0
			? `workflows ongoing: ${ongoingParts.join(" · ")}${
					elsewhere > 0 ? ` (${elsewhere} elsewhere)` : ""
				}`
			: undefined,
		attentionParts.length > 0
			? `workflows need action: ${attentionParts.join(" · ")}`
			: undefined,
	].filter((line): line is string => line !== undefined);
	const parked =
		parkedPrompt === undefined ? undefined : parkedLine(parkedPrompt);
	const lines =
		parked === undefined
			? counts
			: [parked, ...(counts.length > 0 ? [counts.join(" · ")] : [])];
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
	readonly service: Pick<WorkflowService, "listRuns" | "subscribe" | "inspect">;
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

/**
 * One parked run's prompt, as read from `inspect`. `executionId` names the
 * checkpoint generation the prompt belongs to; both are absent when the
 * inspection carried no waiting checkpoint task.
 */
interface ParkedPromptCacheEntry {
	readonly runId: string;
	readonly executionId?: string;
	readonly prompt?: string;
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
	let cachedPrompt: ParkedPromptCacheEntry | undefined;

	/**
	 * The parked run's prompt, read at most once per (runId, executionId): the
	 * entry is kept while the same run is still the parked one and dropped as
	 * soon as it is not, so a re-park under a new execution reads the new
	 * prompt and a poll tick reads nothing.
	 */
	async function parkedPrompt(runId: string): Promise<string | undefined> {
		if (cachedPrompt?.runId === runId) return cachedPrompt.prompt;
		const inspection = await options.service.inspect(runId, {
			include: ["tasks"],
		});
		const pending = inspection.tasks?.find(
			(task) =>
				task.kind === "checkpoint" &&
				task.status === "waiting" &&
				task.abandoned !== true &&
				task.checkpoint !== undefined,
		);
		const entry: ParkedPromptCacheEntry = {
			runId,
			...(pending?.executionId === undefined
				? {}
				: { executionId: pending.executionId }),
			...(pending?.checkpoint?.prompt === undefined
				? {}
				: { prompt: pending.checkpoint.prompt }),
		};
		if (disposed) return entry.prompt;
		cachedPrompt = entry;
		return entry.prompt;
	}

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
			const parked = firstParkedOwnedRun(page.runs);
			if (parked === undefined) cachedPrompt = undefined;
			let prompt: string | undefined;
			if (parked !== undefined) {
				try {
					prompt = await parkedPrompt(parked.runId);
				} catch {
					// The counts still stand; the next refresh reads the prompt again.
					prompt = undefined;
				}
				if (disposed) return;
			}
			options.setWidget(workflowWidgetLines(page.runs, prompt));
			if (widgetNeedsPolling(page.runs)) ensurePolling();
			else stopPolling();
		} catch {
			if (disposed) return;
			// The next subscribe event retries; until then nothing is claimed.
			cachedPrompt = undefined;
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
			cachedPrompt = undefined;
			options.setWidget(undefined);
		},
		get lastPage() {
			return lastPage;
		},
	};
}
