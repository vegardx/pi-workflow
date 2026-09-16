import type { WorkflowRunId, WorkflowTaskId } from "../contracts.js";
import type { WorkflowService } from "../service.js";
import type {
	WorkflowPendingCheckpointView,
	WorkflowRunSummary,
	WorkflowServiceRunView,
} from "../service-views.js";
import {
	type CheckpointFormContext,
	type CheckpointFormTask,
	collectCheckpointDecision,
} from "./checkpoint-form.js";
import { shortId } from "./format.js";
import {
	WORKFLOW_WIDGET_DEBOUNCE_MS,
	WORKFLOW_WIDGET_LIMIT,
} from "./widget.js";

/**
 * The parked-run observer: when a run this session owns parks on a checkpoint,
 * the session user is asked to decide it, once per execution, in a dialog they
 * can always dismiss.
 *
 * The rules it enforces, all of them because Pi's dialogs have no queue:
 *
 * - **One dialog at a time.** A single in-flight promise is the mutex, and an
 *   observation that arrives while a dialog is open re-evaluates from fresh
 *   service state afterwards, so a checkpoint decided or expired meanwhile is
 *   dropped rather than asked.
 * - **Never over a foreign prompt.** A dialog opened by Pi or another
 *   extension replaces an open one and the replaced promise never resolves,
 *   so `ui_prompt_start`/`ui_prompt_end` defer the evaluation instead.
 * - **Once per execution.** The pending checkpoint's `executionId` - the
 *   identity the decision record binds to - keys the asked set, so a dismissed
 *   prompt is never repeated and a new generation after invalidation is.
 * - **Never across sessions.** An `ExtensionContext` throws once its session
 *   is replaced, so the context is fetched per evaluation and a throw stops
 *   the observer.
 *
 * The observer never throws into the session: every failure is a warning that
 * names the `/workflow decide` fallback, and the run simply stays parked.
 */

type TimerHandle = unknown;

export interface ParkedObserverContext extends CheckpointFormContext {
	/** Dialog-capable UI; reading it throws once the session is replaced. */
	readonly hasUI: boolean;
}

export interface ParkedRunObserverOptions {
	readonly service: Pick<
		WorkflowService,
		"subscribe" | "status" | "listRuns" | "decide"
	>;
	/**
	 * The live session context, or `undefined` once this generation has been
	 * superseded; a throw or `undefined` stops the observer.
	 */
	readonly getContext: () => ParkedObserverContext | undefined;
	/** The guided form; injectable for tests. */
	readonly collect?: typeof collectCheckpointDecision;
	/** Called after a decision is recorded (the widget refreshes on it). */
	readonly onDecided?: () => void | Promise<void>;
	/** Injectable for tests; production timers are unref'd. */
	readonly setTimer?: (callback: () => void, ms: number) => TimerHandle;
	readonly clearTimer?: (handle: TimerHandle) => void;
	readonly debounceMs?: number;
	readonly now?: () => number;
}

export interface ParkedRunObserver {
	/** Subscribes and evaluates once; idempotent. */
	start(): void;
	/** Unsubscribes, aborts an open dialog, and stops asking; idempotent. */
	stop(): void;
	/** A prompt opened by Pi or another extension; defers our dialogs. */
	notePromptStart(): void;
	notePromptEnd(): void;
	/** Resolves once no evaluation is in flight; a test seam. */
	settled(): Promise<void>;
}

/** The dismiss notice; the widget line and `/workflow decide` still offer it. */
export function checkpointDismissedMessage(
	runId: WorkflowRunId,
	taskKey: string,
): string {
	return `Checkpoint ${taskKey} still waits. /workflow decide ${shortId(runId)} ${taskKey} — or alt+w.`;
}

/** Any observer failure; never a path, never a stack. */
export function checkpointPromptFailureMessage(
	runId: WorkflowRunId,
	taskKey: string,
): string {
	return `Checkpoint ${taskKey} could not be asked in this session. Use /workflow decide ${shortId(runId)} ${taskKey}.`;
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

/** `${namespace}/${key}`, the token `/workflow decide` accepts. */
function pendingTaskKey(pending: WorkflowPendingCheckpointView): string {
	return pending.taskKey ?? [...pending.namespace, pending.key].join("/");
}

/**
 * The checkpoint task view the form needs, from the artifact-backed `status`
 * view: the full prompt, the schema, the expiry, and the verified inputs.
 */
function formTask(
	view: WorkflowServiceRunView,
	taskId: WorkflowTaskId,
): CheckpointFormTask | undefined {
	const task = view.tasks?.find((candidate) => candidate.id === taskId);
	return task?.checkpoint
		? {
				id: task.id,
				namespace: task.namespace,
				key: task.key,
				checkpoint: task.checkpoint,
			}
		: undefined;
}

/** Owned root run, parked, and the service offers `decide` on it. */
function isAskable(run: WorkflowRunSummary): boolean {
	return (
		run.status === "waiting" &&
		run.ownership === "owned" &&
		!run.leasedElsewhere &&
		run.pendingCheckpointCount > 0 &&
		run.availableActions.includes("decide")
	);
}

export function createParkedRunObserver(
	options: ParkedRunObserverOptions,
): ParkedRunObserver {
	const schedule =
		options.setTimer ??
		((callback, ms) => unref(setTimeout(callback, ms) as TimerHandle));
	const cancel =
		options.clearTimer ??
		((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	const debounceMs = options.debounceMs ?? WORKFLOW_WIDGET_DEBOUNCE_MS;
	const now = options.now ?? (() => Date.now());
	const collect = options.collect ?? collectCheckpointDecision;

	let disposed = false;
	let unsubscribe: (() => void) | undefined;
	let debounce: TimerHandle | undefined;
	let inFlight: Promise<void> | undefined;
	let queued = false;
	/** Prompts opened by Pi or another extension, `ui_prompt_start` counted. */
	let foreign = 0;
	/** True while one of our own dialogs is open; foreign events are ours then. */
	let dialogOpen = false;
	const asked = new Set<string>();
	let active:
		| {
				readonly runId: WorkflowRunId;
				readonly executionId: string;
				readonly controller: AbortController;
		  }
		| undefined;

	/** The live context, or `undefined`; a replaced session stops the observer. */
	function liveContext(): ParkedObserverContext | undefined {
		if (disposed) return undefined;
		try {
			const ctx = options.getContext();
			if (!ctx) {
				stop();
				return undefined;
			}
			return ctx.hasUI ? ctx : undefined;
		} catch {
			// `ExtensionContext` throws once its session is replaced.
			stop();
			return undefined;
		}
	}

	/** Asks one checkpoint; `true` when a dialog was opened. */
	async function askOne(ctx: ParkedObserverContext): Promise<boolean> {
		const page = await options.service.listRuns({
			statuses: ["waiting"],
			limit: WORKFLOW_WIDGET_LIMIT,
		});
		// Nested children are never listed here and are never offered `decide`.
		for (const run of page.runs.filter(isAskable)) {
			// Fresh, artifact-backed state: the prompt, the schema, the verified
			// inputs, and whether the checkpoint is still pending at all.
			const view = await options.service.status(run.runId);
			for (const pending of view.pendingCheckpoints ?? []) {
				if (asked.has(pending.executionId)) continue;
				if (
					pending.expiresAt !== undefined &&
					Date.parse(pending.expiresAt) <= now()
				) {
					continue;
				}
				const task = formTask(view, pending.taskId);
				if (!task) continue;
				const taskKey = pendingTaskKey(pending);
				// Marked before the dialog opens: a dismissal is final for this
				// execution, and no second evaluation can double-prompt.
				asked.add(pending.executionId);
				const controller = new AbortController();
				active = {
					runId: run.runId,
					executionId: pending.executionId,
					controller,
				};
				dialogOpen = true;
				try {
					const outcome = await collect(ctx, task, run, {
						service: options.service,
						signal: controller.signal,
						now,
					});
					if (outcome === undefined) {
						ctx.ui.notify(
							checkpointDismissedMessage(run.runId, taskKey),
							"info",
						);
					} else {
						await options.onDecided?.();
					}
				} catch {
					ctx.ui.notify(
						checkpointPromptFailureMessage(run.runId, taskKey),
						"warning",
					);
				} finally {
					dialogOpen = false;
					active = undefined;
				}
				return true;
			}
		}
		return false;
	}

	async function evaluate(): Promise<void> {
		for (;;) {
			queued = false;
			if (disposed) return;
			const ctx = liveContext();
			if (!ctx) return;
			// A foreign dialog would clobber ours (and ours would clobber it):
			// `ui_prompt_end` re-evaluates.
			if (foreign > 0) return;
			let prompted = false;
			try {
				prompted = await askOne(ctx);
			} catch {
				// A service failure leaves the run parked; the next observation,
				// the widget line, and `/workflow decide` all still work.
				return;
			}
			if (!prompted && !queued) return;
		}
	}

	function run(): Promise<void> {
		if (disposed) return Promise.resolve();
		if (inFlight) {
			queued = true;
			return inFlight;
		}
		inFlight = evaluate().finally(() => {
			inFlight = undefined;
		});
		return inFlight;
	}

	/** Aborts the open dialog once its checkpoint stops being pending. */
	async function revalidateActive(runId: WorkflowRunId): Promise<void> {
		const open = active;
		if (!open || open.runId !== runId) return;
		try {
			const view = await options.service.status(runId);
			const stillPending = (view.pendingCheckpoints ?? []).some(
				(pending) => pending.executionId === open.executionId,
			);
			if (!stillPending && active === open) open.controller.abort();
		} catch {
			// The dialog keeps its own expiry countdown; nothing to do.
		}
	}

	function onObservation(observation: { runId: string; status: string }): void {
		if (disposed) return;
		if (active) void revalidateActive(observation.runId as WorkflowRunId);
		if (observation.status !== "waiting") return;
		if (debounce !== undefined) return;
		debounce = schedule(() => {
			debounce = undefined;
			void run();
		}, debounceMs);
	}

	function stop(): void {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		unsubscribe = undefined;
		if (debounce !== undefined) {
			cancel(debounce);
			debounce = undefined;
		}
		active?.controller.abort();
		active = undefined;
	}

	return {
		start() {
			if (disposed) return;
			unsubscribe ??= options.service.subscribe(onObservation);
			void run();
		},
		stop,
		notePromptStart() {
			// Our own dialogs raise these events too; while one is open the
			// events are ours and the foreign count must not move.
			if (disposed || dialogOpen) return;
			foreign += 1;
		},
		notePromptEnd() {
			if (disposed || dialogOpen) return;
			foreign = Math.max(0, foreign - 1);
			if (foreign === 0) void run();
		},
		async settled() {
			while (inFlight) await inFlight;
		},
	};
}
