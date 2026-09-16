import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	checkpointSchemaSummary,
	checkpointTaskKey,
	renderCheckpointInputs,
} from "../checkpoint-render.js";
import type {
	WorkflowRunId,
	WorkflowRunStatus,
	WorkflowTaskId,
} from "../contracts.js";
import type { WorkflowService } from "../service.js";
import type {
	WorkflowInspectSection,
	WorkflowInvalidationPreview,
	WorkflowLogPage,
	WorkflowRunInspection,
	WorkflowRunListIssue,
	WorkflowRunPage,
	WorkflowRunSummary,
	WorkflowServiceTaskView,
} from "../service-views.js";
import {
	ATTENTION_RUN_STATUSES,
	formatAge,
	formatCost,
	formatDurationMs,
	formatGeneration,
	formatTokens,
	formatUntil,
	isNonterminalRunStatus,
	logLine,
	NONTERMINAL_RUN_STATUSES,
	normalizeTaskKey,
	ownershipLabel,
	RUN_STATUS_ICON,
	runLine,
	shortId,
	TERMINAL_RUN_STATUSES,
	taskLine,
	taskPath,
} from "./format.js";

/** Truncates to `width` terminal columns with an ellipsis; never widens. */
export function truncate(value: string, width: number): string {
	return truncateToWidth(value, Math.max(1, width), "…");
}

/** Truncates and right-pads to exactly `width` terminal columns. */
export function pad(value: string, width: number): string {
	const truncated = truncate(value, width);
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

/** `label      value` with the label column bounded to a quarter of the width. */
export function keyValue(label: string, value: string, width: number): string {
	const labelWidth = Math.max(
		1,
		Math.min(16, Math.max(10, Math.floor(width / 4)), width - 2),
	);
	return truncate(
		`${pad(label, labelWidth)} ${truncate(value, Math.max(1, width - labelWidth - 1))}`,
		width,
	);
}

/**
 * Workflow inspector. The first half is a pure state machine over persisted
 * service views and key events (`reduceInspector`, line builders, text
 * fallback); the second half is the pi-tui glue that loads data, subscribes,
 * and renders. The inspector projects state: every action it offers comes
 * verbatim from `availableActions`, and every action it emits is a request
 * the caller forwards to the service, which remains the lifecycle authority.
 */

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type InspectorScreen =
	| "runs"
	| "detail"
	| "actions"
	| "task-picker"
	| "confirm"
	| "input"
	| "help";

export type InspectorTab =
	| "overview"
	| "tasks"
	| "task"
	| "activity"
	| "technical";

export const INSPECTOR_TABS: readonly InspectorTab[] = Object.freeze([
	"overview",
	"tasks",
	"task",
	"activity",
	"technical",
]);

export type RunFilterName = "all" | "ongoing" | "needs action" | "terminal";

export const RUN_FILTER_NAMES: readonly RunFilterName[] = Object.freeze([
	"all",
	"ongoing",
	"needs action",
	"terminal",
]);

/** Status set sent to `listRuns`; `undefined` lists every status. */
export function runFilterStatuses(
	filter: RunFilterName,
): readonly WorkflowRunStatus[] | undefined {
	switch (filter) {
		case "all":
			return undefined;
		case "ongoing":
			// Failed and interrupted runs that await recovery keep moving on the
			// next drive; the post-filter keeps only those (requiresAttention false).
			return Object.freeze([
				...NONTERMINAL_RUN_STATUSES,
				"failed",
				"interrupted",
			]);
		case "needs action":
			return ATTENTION_RUN_STATUSES;
		case "terminal":
			return TERMINAL_RUN_STATUSES;
	}
}

/** Post-filter over summary fields only; idempotent over the status query. */
export function applyRunFilter(
	runs: readonly WorkflowRunSummary[],
	filter: RunFilterName,
): readonly WorkflowRunSummary[] {
	switch (filter) {
		case "all":
			return runs;
		case "ongoing":
			return runs.filter(
				(run) =>
					isNonterminalRunStatus(run.status) ||
					((run.status === "failed" || run.status === "interrupted") &&
						!run.requiresAttention),
			);
		case "needs action":
			return runs.filter((run) => run.requiresAttention);
		case "terminal":
			return runs.filter((run) => TERMINAL_RUN_STATUSES.includes(run.status));
	}
}

export function nextRunFilter(filter: RunFilterName): RunFilterName {
	const index = RUN_FILTER_NAMES.indexOf(filter);
	return RUN_FILTER_NAMES[(index + 1) % RUN_FILTER_NAMES.length] ?? "all";
}

export type WorkflowRunActionName =
	WorkflowRunSummary["availableActions"][number];

/** Palette entries: `wait` alone is meaningless in a live, self-refreshing view. */
export type InspectorAction = Exclude<WorkflowRunActionName, "wait">;

export const INSPECTOR_ACTION_LABELS: Readonly<
	Record<InspectorAction, string>
> = Object.freeze({
	stop: "Stop run",
	reconcile: "Reconcile cleanup-blocked work",
	invalidate: "Invalidate a task and its dependents",
	retry: "Retry failed work",
	resume: "Resume interrupted child",
	decide: "Decide a checkpoint",
});

/**
 * `decide` is deliberately absent: the inspector cannot host the guided form,
 * so it resolves with a `decide` intent and the form runs its own confirm.
 */
export const CONFIRMED_INSPECTOR_ACTIONS: ReadonlySet<InspectorAction> =
	new Set<InspectorAction>(["stop", "invalidate", "retry", "resume"]);

/** Actions that need a task before they can be confirmed or handed over. */
const TASK_REQUIRED_ACTIONS: ReadonlySet<InspectorAction> = new Set([
	"invalidate",
	"resume",
	"decide",
]);

/** Actions that accept a task scope from the task tab. */
const TASK_SCOPED_ACTIONS: ReadonlySet<InspectorAction> = new Set([
	"invalidate",
	"resume",
	"reconcile",
	"retry",
	"decide",
]);

export const DEFAULT_STOP_REASON = "Stopped by operator.";
export const DEFAULT_INVALIDATE_REASON = "Invalidated by operator.";

const STATIC_CONSEQUENCES: Readonly<
	Partial<Record<InspectorAction, readonly string[]>>
> = Object.freeze({
	stop: [
		"Stop intent is persisted and active delegated work is interrupted.",
		"Terminal evidence is drained; the run ends cancelled.",
	],
	retry: [
		"A new attempt for each failed or interrupted execution",
		"consumes remaining workflow budget.",
	],
	resume: [
		"The interrupted child continues as a new attempt",
		"and consumes remaining workflow budget.",
	],
});

function isInspectorAction(
	action: WorkflowRunActionName,
): action is InspectorAction {
	return action !== "wait";
}

/**
 * Whether the task is the one `decide` can act on: a checkpoint whose request
 * is durable and whose decision is not recorded yet. The run's
 * `availableActions` says a checkpoint waits somewhere; this says which task.
 */
export function isPendingCheckpointTask(
	task: Pick<WorkflowServiceTaskView, "abandoned" | "checkpoint">,
): boolean {
	const { checkpoint } = task;
	return (
		task.abandoned !== true &&
		checkpoint !== undefined &&
		checkpoint.requestedAt !== undefined &&
		checkpoint.decision === undefined
	);
}

/** The only source of palette entries: the service's own projection. */
export function paletteActions(summary: WorkflowRunSummary): InspectorAction[] {
	return summary.availableActions.filter(isInspectorAction);
}

/**
 * Task-scoped subset of the run's actions; abandoned tasks are never
 * actionable, and `decide` is offered only on the checkpoint task that is
 * actually awaiting a decision.
 */
export function taskActions(
	summary: WorkflowRunSummary,
	task: Pick<WorkflowServiceTaskView, "abandoned" | "checkpoint">,
): InspectorAction[] {
	if (task.abandoned === true) return [];
	const pending = isPendingCheckpointTask(task);
	return paletteActions(summary).filter(
		(action) =>
			TASK_SCOPED_ACTIONS.has(action) && (action !== "decide" || pending),
	);
}

export interface InspectorState {
	includeChildren: boolean;
	filter: RunFilterName;
	view: "runs" | "detail";
	/** Drill-in stack; the last entry is the displayed run. */
	runStack: readonly WorkflowRunId[];
	tab: InspectorTab;
	selectedTaskId?: WorkflowTaskId;
}

/**
 * The service's `previewInvalidation` result as the confirm screen shows it,
 * or the service's refusal for the cause with an empty closure.
 */
export interface InvalidationPreview
	extends Pick<
		WorkflowInvalidationPreview,
		"taskIds" | "taskKeys" | "abandonedEpochs" | "abandonedTaskIds"
	> {
	/** The refusal `previewInvalidation` raised for this cause. */
	readonly refusal?: string;
}

export interface InspectorData {
	runs: readonly WorkflowRunSummary[];
	total: number;
	nextCursor?: string;
	issues: readonly WorkflowRunListIssue[];
	inspection?: WorkflowRunInspection;
	logs?: WorkflowLogPage;
	preview?: InvalidationPreview;
	error?: string;
}

export interface DetailHistoryEntry {
	readonly tab: InspectorTab;
	readonly scroll: number;
	readonly selectedTask: number;
	readonly selectedTaskId?: WorkflowTaskId;
}

export interface InspectorUiState {
	screen: InspectorScreen;
	selectedRun: number;
	selectedTask: number;
	selectedAction: number;
	scroll: number;
	/** Whether the open palette was requested from the task tab. */
	paletteScope: "run" | "task";
	pendingAction?: InspectorAction;
	pendingTaskId?: WorkflowTaskId;
	/** Saved tab/scroll per drill-in level; restored on escape. */
	history: readonly DetailHistoryEntry[];
}

export interface InspectorActionRequest {
	readonly action: InspectorAction;
	readonly run: WorkflowRunSummary;
	readonly taskId?: WorkflowTaskId;
	readonly reason?: string;
}

/**
 * What the operator asked for. `action` is a confirmed request the caller
 * forwards to the service as it is; `decide` is a checkpoint the caller must
 * answer through the guided form, because the inspector owns the terminal
 * while it is open and cannot host a dialog. Both carry `state`, so the
 * caller reopens the inspector exactly where it was.
 */
export type InspectorIntent =
	| { type: "close"; state: InspectorState }
	| {
			type: "action";
			state: InspectorState;
			request: InspectorActionRequest;
			confirmed: true;
	  }
	| {
			type: "decide";
			state: InspectorState;
			run: WorkflowRunSummary;
			taskId: WorkflowTaskId;
			/**
			 * The same request shape the other intents carry, so a caller that
			 * dispatches every intent through `performRunAction` can keep doing
			 * so; it carries no `decision`, which is what makes that call ask
			 * the injected form instead of recording anything.
			 */
			request: InspectorActionRequest;
	  };

export type InspectorKey =
	| "up"
	| "down"
	| "left"
	| "right"
	| "enter"
	| "escape"
	| "space"
	| "pageUp"
	| "pageDown"
	| { char: string }
	| { submit: string };

export type InspectorEffect =
	| { type: "load-runs"; append?: true }
	| { type: "load-detail"; runId: WorkflowRunId }
	| { type: "load-preview"; runId: WorkflowRunId; taskId: WorkflowTaskId }
	| { type: "open-input"; initial: string }
	| { type: "done"; intent: InspectorIntent };

export interface InspectorStep {
	state: InspectorState;
	ui: InspectorUiState;
	effects: InspectorEffect[];
}

const RUN_ROWS = 16;
const DETAIL_PAGE_LINES = 24;
const PAGE_STEP = 10;

export function initialInspectorState(
	partial: Partial<InspectorState> = {},
): InspectorState {
	const runStack = [...(partial.runStack ?? [])];
	return {
		includeChildren: partial.includeChildren ?? false,
		filter: partial.filter ?? "all",
		view: partial.view === "detail" && runStack.length > 0 ? "detail" : "runs",
		runStack,
		tab: partial.tab ?? "overview",
		...(partial.selectedTaskId
			? { selectedTaskId: partial.selectedTaskId }
			: {}),
	};
}

export function initialInspectorUiState(
	state: InspectorState,
): InspectorUiState {
	return {
		screen: state.view,
		selectedRun: 0,
		selectedTask: 0,
		selectedAction: 0,
		scroll: 0,
		paletteScope: "run",
		history: [],
	};
}

export function displayedRunId(
	state: InspectorState,
): WorkflowRunId | undefined {
	return state.runStack.at(-1);
}

export function visibleRuns(
	state: InspectorState,
	data: InspectorData,
): readonly WorkflowRunSummary[] {
	return applyRunFilter(data.runs, state.filter);
}

/** The loaded inspection only when it belongs to the displayed run. */
export function currentInspection(
	state: InspectorState,
	data: InspectorData,
): WorkflowRunInspection | undefined {
	const runId = displayedRunId(state);
	return runId && data.inspection?.run.runId === runId
		? data.inspection
		: undefined;
}

export function selectedTaskView(
	state: InspectorState,
	data: InspectorData,
): WorkflowServiceTaskView | undefined {
	const inspection = currentInspection(state, data);
	if (!inspection || !state.selectedTaskId) return undefined;
	return inspection.tasks?.find((task) => task.id === state.selectedTaskId);
}

/** Child run of a nested-workflow task, from its current execution. */
export function childRunIdOf(
	inspection: WorkflowRunInspection,
	taskId: WorkflowTaskId,
): WorkflowRunId | undefined {
	const executions = (inspection.executions ?? []).filter(
		(execution) => execution.taskId === taskId && execution.childRunId,
	);
	return (
		executions.find((execution) => execution.current)?.childRunId ??
		executions[0]?.childRunId
	);
}

/** Palette entries for the open palette scope; equals `availableActions` filtered. */
export function currentActions(
	state: InspectorState,
	ui: InspectorUiState,
	data: InspectorData,
): InspectorAction[] {
	const inspection = currentInspection(state, data);
	if (!inspection) return [];
	if (ui.paletteScope === "task") {
		const task = selectedTaskView(state, data);
		return task ? taskActions(inspection.run, task) : [];
	}
	return paletteActions(inspection.run);
}

export function invalidateConsequence(preview: InvalidationPreview): string {
	const keys = preview.taskKeys.map(normalizeTaskKey);
	const shown = keys.slice(0, 6);
	const more = keys.length - shown.length;
	return `${preview.taskIds.length} task(s) re-execute as new generations: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}. ${preview.abandonedEpochs.length} epoch(s) after the exposing barrier are abandoned, retiring ${preview.abandonedTaskIds.length} declaration(s). Effects after that barrier are marked abandoned.`;
}

/** Consequence lines for the confirm screen; invalidate needs the preview. */
export function actionConsequence(
	action: InspectorAction,
	preview?: InvalidationPreview,
): string[] {
	if (action === "invalidate") {
		if (!preview) return ["Computing consequences…"];
		const sentences = invalidateConsequence(preview)
			.split(". ")
			.map((sentence, index, all) =>
				index < all.length - 1 ? `${sentence}.` : sentence,
			);
		return preview.refusal
			? [...sentences, `The service will refuse: ${preview.refusal}.`]
			: sentences;
	}
	return [...(STATIC_CONSEQUENCES[action] ?? ["Continue?"])];
}

function defaultReason(action: InspectorAction): string | undefined {
	if (action === "stop") return DEFAULT_STOP_REASON;
	if (action === "invalidate") return DEFAULT_INVALIDATE_REASON;
	return undefined;
}

function isChar(key: InspectorKey, char: string): boolean {
	return typeof key === "object" && "char" in key && key.char === char;
}

function clamp(value: number, max: number): number {
	return Math.max(0, Math.min(Math.max(0, max), value));
}

function cycleTab(
	tab: InspectorTab,
	direction: -1 | 1,
	hasTask: boolean,
): InspectorTab {
	let index = INSPECTOR_TABS.indexOf(tab);
	for (let step = 0; step < INSPECTOR_TABS.length; step += 1) {
		index = (index + direction + INSPECTOR_TABS.length) % INSPECTOR_TABS.length;
		const candidate = INSPECTOR_TABS[index];
		if (candidate && (candidate !== "task" || hasTask)) return candidate;
	}
	return tab;
}

function actionIntent(
	state: InspectorState,
	run: WorkflowRunSummary,
	ui: InspectorUiState,
	action: InspectorAction,
	reason?: string,
): InspectorIntent {
	if (action === "decide" && ui.pendingTaskId) {
		return decideIntent(state, run, ui.pendingTaskId);
	}
	return {
		type: "action",
		state,
		confirmed: true,
		request: {
			action,
			run,
			...(ui.pendingTaskId ? { taskId: ui.pendingTaskId } : {}),
			...(reason ? { reason } : {}),
		},
	};
}

/** The checkpoint the caller answers through the guided form. */
function decideIntent(
	state: InspectorState,
	run: WorkflowRunSummary,
	taskId: WorkflowTaskId,
): InspectorIntent {
	return {
		type: "decide",
		state,
		run,
		taskId,
		request: { action: "decide", run, taskId },
	};
}

/** Rows the task picker lets the operator choose for the pending action. */
function selectableTask(
	action: InspectorAction | undefined,
	task: Pick<WorkflowServiceTaskView, "abandoned" | "checkpoint">,
): boolean {
	if (task.abandoned === true) return false;
	return action !== "decide" || isPendingCheckpointTask(task);
}

function verticalDelta(key: InspectorKey): number | undefined {
	if (key === "up") return -1;
	if (key === "down") return 1;
	if (key === "pageUp") return -PAGE_STEP;
	if (key === "pageDown") return PAGE_STEP;
	return undefined;
}

/**
 * Pure transition over key events. Effects describe loads and completion;
 * the glue executes them. Legality never enters here: the palette is the
 * filtered `availableActions`, and `enter` on an entry only sequences the
 * confirmation the caller's service will ultimately judge.
 */
export function reduceInspector(
	state: InspectorState,
	ui: InspectorUiState,
	data: InspectorData,
	key: InspectorKey,
): InspectorStep {
	const next: InspectorState = { ...state, runStack: [...state.runStack] };
	const nextUi: InspectorUiState = { ...ui, history: [...ui.history] };
	const effects: InspectorEffect[] = [];
	const step = (): InspectorStep => ({ state: next, ui: nextUi, effects });
	const inspection = currentInspection(state, data);
	const done = (intent: InspectorIntent) =>
		effects.push({ type: "done", intent });

	if (ui.screen === "input") {
		if (key === "escape") {
			nextUi.screen = "actions";
		} else if (
			typeof key === "object" &&
			"submit" in key &&
			inspection &&
			ui.pendingAction
		) {
			const reason = key.submit.trim() || defaultReason(ui.pendingAction);
			done(actionIntent(next, inspection.run, ui, ui.pendingAction, reason));
		}
		return step();
	}
	if (isChar(key, "?")) {
		nextUi.screen = ui.screen === "help" ? state.view : "help";
		return step();
	}
	if (ui.screen === "help") {
		if (key === "escape") nextUi.screen = state.view;
		return step();
	}
	if (isChar(key, "r")) {
		effects.push({ type: "load-runs" });
		const top = displayedRunId(state);
		if (top) effects.push({ type: "load-detail", runId: top });
		return step();
	}

	switch (ui.screen) {
		case "runs": {
			const runs = visibleRuns(state, data);
			const delta = verticalDelta(key);
			if (key === "escape") {
				done({ type: "close", state: next });
			} else if (delta !== undefined) {
				nextUi.selectedRun = clamp(ui.selectedRun + delta, runs.length - 1);
				if (
					delta > 0 &&
					nextUi.selectedRun === runs.length - 1 &&
					data.nextCursor
				) {
					effects.push({ type: "load-runs", append: true });
				}
			} else if (key === "enter") {
				const run = runs[ui.selectedRun];
				if (run) {
					next.runStack = [run.runId];
					next.view = "detail";
					next.tab = "overview";
					delete next.selectedTaskId;
					nextUi.screen = "detail";
					nextUi.scroll = 0;
					nextUi.selectedTask = 0;
					nextUi.history = [];
					effects.push({ type: "load-detail", runId: run.runId });
				}
			} else if (isChar(key, "f")) {
				next.filter = nextRunFilter(state.filter);
				nextUi.selectedRun = 0;
				effects.push({ type: "load-runs" });
			} else if (isChar(key, "c")) {
				next.includeChildren = !state.includeChildren;
				nextUi.selectedRun = 0;
				effects.push({ type: "load-runs" });
			}
			return step();
		}
		case "detail": {
			const tasks = inspection?.tasks ?? [];
			const delta = verticalDelta(key);
			if (key === "escape") {
				next.runStack = next.runStack.slice(0, -1);
				const restored = nextUi.history.at(-1);
				nextUi.history = nextUi.history.slice(0, -1);
				if (next.runStack.length === 0) {
					next.view = "runs";
					next.tab = "overview";
					delete next.selectedTaskId;
					nextUi.screen = "runs";
					nextUi.scroll = 0;
					nextUi.history = [];
				} else {
					next.tab = restored?.tab ?? "overview";
					nextUi.scroll = restored?.scroll ?? 0;
					nextUi.selectedTask = restored?.selectedTask ?? 0;
					if (restored?.selectedTaskId) {
						next.selectedTaskId = restored.selectedTaskId;
					} else {
						delete next.selectedTaskId;
					}
					const top = next.runStack.at(-1);
					if (top) effects.push({ type: "load-detail", runId: top });
				}
			} else if (key === "left" || key === "right") {
				next.tab = cycleTab(
					state.tab,
					key === "left" ? -1 : 1,
					state.selectedTaskId !== undefined,
				);
				nextUi.scroll = 0;
			} else if (delta !== undefined) {
				if (state.tab === "tasks") {
					nextUi.selectedTask = clamp(
						ui.selectedTask + delta,
						tasks.length - 1,
					);
					const task = tasks[nextUi.selectedTask];
					if (task) next.selectedTaskId = task.id;
					else delete next.selectedTaskId;
				} else {
					nextUi.scroll = Math.max(0, ui.scroll + delta);
				}
			} else if (key === "enter") {
				if (state.tab === "tasks") {
					const task = tasks[ui.selectedTask];
					if (task) {
						next.selectedTaskId = task.id;
						next.tab = "task";
						nextUi.scroll = 0;
					}
				}
			} else if (isChar(key, "o")) {
				const focusTaskId =
					state.tab === "tasks"
						? tasks[ui.selectedTask]?.id
						: state.selectedTaskId;
				const childRunId =
					inspection && focusTaskId
						? childRunIdOf(inspection, focusTaskId)
						: undefined;
				if (childRunId) {
					nextUi.history = [
						...nextUi.history,
						{
							tab: state.tab,
							scroll: ui.scroll,
							selectedTask: ui.selectedTask,
							...(state.selectedTaskId
								? { selectedTaskId: state.selectedTaskId }
								: {}),
						},
					];
					next.runStack = [...next.runStack, childRunId];
					next.tab = "overview";
					delete next.selectedTaskId;
					nextUi.scroll = 0;
					nextUi.selectedTask = 0;
					effects.push({ type: "load-detail", runId: childRunId });
				}
			} else if (key === "space" && inspection) {
				const taskScope =
					state.tab === "task" && state.selectedTaskId !== undefined;
				nextUi.paletteScope = taskScope ? "task" : "run";
				if (taskScope && state.selectedTaskId) {
					nextUi.pendingTaskId = state.selectedTaskId;
				} else {
					delete nextUi.pendingTaskId;
				}
				delete nextUi.pendingAction;
				nextUi.selectedAction = 0;
				nextUi.screen = "actions";
			}
			return step();
		}
		case "actions": {
			const actions = currentActions(state, ui, data);
			const delta = verticalDelta(key);
			if (key === "escape") {
				nextUi.screen = "detail";
				delete nextUi.pendingAction;
			} else if (delta !== undefined) {
				nextUi.selectedAction = clamp(
					ui.selectedAction + delta,
					actions.length - 1,
				);
			} else if (key === "enter" && inspection) {
				const action = actions[ui.selectedAction];
				if (!action) return step();
				nextUi.pendingAction = action;
				// The task comes first even for an unconfirmed action: `decide`
				// addresses one checkpoint and the form needs to know which.
				if (TASK_REQUIRED_ACTIONS.has(action) && !ui.pendingTaskId) {
					nextUi.screen = "task-picker";
					nextUi.selectedTask = Math.max(
						0,
						tasksOf(inspection).findIndex((task) =>
							selectableTask(action, task),
						),
					);
					return step();
				}
				if (!CONFIRMED_INSPECTOR_ACTIONS.has(action)) {
					done(actionIntent(next, inspection.run, nextUi, action));
					return step();
				}
				if (action === "invalidate" && ui.pendingTaskId) {
					effects.push({
						type: "load-preview",
						runId: inspection.run.runId,
						taskId: ui.pendingTaskId,
					});
				}
				nextUi.screen = "confirm";
			}
			return step();
		}
		case "task-picker": {
			const tasks = tasksOf(inspection);
			const delta = verticalDelta(key);
			if (key === "escape") {
				nextUi.screen = "actions";
			} else if (delta !== undefined) {
				nextUi.selectedTask = clamp(ui.selectedTask + delta, tasks.length - 1);
			} else if (key === "enter" && inspection && ui.pendingAction) {
				const task = tasks[ui.selectedTask];
				// Abandoned rows are visible but never selectable, and `decide`
				// only reaches a checkpoint that is still awaiting a decision.
				if (task && selectableTask(ui.pendingAction, task)) {
					nextUi.pendingTaskId = task.id;
					if (!CONFIRMED_INSPECTOR_ACTIONS.has(ui.pendingAction)) {
						done(actionIntent(next, inspection.run, nextUi, ui.pendingAction));
						return step();
					}
					if (ui.pendingAction === "invalidate") {
						effects.push({
							type: "load-preview",
							runId: inspection.run.runId,
							taskId: task.id,
						});
					}
					nextUi.screen = "confirm";
				}
			}
			return step();
		}
		case "confirm": {
			if (key === "escape") {
				nextUi.screen = "actions";
			} else if (key === "enter" && inspection && ui.pendingAction) {
				const initial = defaultReason(ui.pendingAction);
				if (initial !== undefined) {
					nextUi.screen = "input";
					effects.push({ type: "open-input", initial });
				} else {
					done(actionIntent(next, inspection.run, ui, ui.pendingAction));
				}
			}
			return step();
		}
		default:
			return step();
	}
}

function tasksOf(
	inspection: WorkflowRunInspection | undefined,
): readonly WorkflowServiceTaskView[] {
	return inspection?.tasks ?? [];
}

// ---------------------------------------------------------------------------
// Line builders (pure; theme is an injected colouring function pair)
// ---------------------------------------------------------------------------

export interface LineTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
}

export const PLAIN_LINE_THEME: LineTheme = Object.freeze({
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
});

export function runsTitle(state: InspectorState): string {
	return `Workflows · ${state.filter}${state.includeChildren ? " · with children" : ""}`;
}

export function detailTitle(inspection: WorkflowRunInspection): string {
	const run = inspection.run;
	return `${run.definitionName} · ${run.status} · ${shortId(run.runId)}${run.depth ? ` · depth ${run.depth}` : ""}${run.leasedElsewhere ? " · leased elsewhere" : ""}`;
}

function runRow(
	run: WorkflowRunSummary,
	selected: boolean,
	width: number,
	theme: LineTheme,
	now: number,
): string {
	const statusWidth = 20;
	const ageWidth = 5;
	const actionsWidth = width >= 90 ? 20 : 0;
	const nameWidth = Math.max(
		10,
		width - statusWidth - ageWidth - actionsWidth - 8,
	);
	const marker = selected ? "›" : " ";
	const lease = run.leasedElsewhere ? "⇄" : " ";
	const status = `${RUN_STATUS_ICON[run.status]} ${run.status}`;
	const name = `${run.definitionName}${run.depth > 0 ? ` ↳${run.depth}` : ""}`;
	const actions = actionsWidth
		? ` ${pad(run.availableActions.join(","), actionsWidth)}`
		: "";
	const row = `${marker}${lease} ${pad(status, statusWidth)} ${pad(name, nameWidth)} ${pad(formatAge(run.updatedAt, now), ageWidth)}${actions}`;
	if (selected)
		return theme.bg("selectedBg", theme.fg("text", truncate(row, width)));
	return theme.fg(
		run.requiresAttention ? "warning" : run.leasedElsewhere ? "muted" : "text",
		truncate(row, width),
	);
}

export function runsBody(
	state: InspectorState,
	ui: InspectorUiState,
	data: InspectorData,
	width: number,
	theme: LineTheme,
	now = Date.now(),
): string[] {
	const runs = visibleRuns(state, data);
	const ongoing = data.runs.filter((run) =>
		isNonterminalRunStatus(run.status),
	).length;
	const needsAction = data.runs.filter((run) => run.requiresAttention).length;
	const elsewhere = data.runs.filter((run) => run.leasedElsewhere).length;
	const lines: string[] = [];
	if (data.error) lines.push(theme.fg("error", data.error), "");
	lines.push(
		`${ongoing} ongoing · ${needsAction} need action${elsewhere ? ` · ${elsewhere} elsewhere` : ""} · ${data.total} total`,
		"",
	);
	if (runs.length === 0) {
		lines.push(
			theme.fg(
				"muted",
				state.filter === "all"
					? "No workflow runs in this project."
					: "No runs match this filter.",
			),
		);
	} else {
		const selected = clamp(ui.selectedRun, runs.length - 1);
		const start = clamp(
			selected - Math.floor(RUN_ROWS / 2),
			runs.length - RUN_ROWS,
		);
		for (const [index, run] of runs.slice(start, start + RUN_ROWS).entries()) {
			lines.push(runRow(run, start + index === selected, width, theme, now));
		}
		if (runs.length > RUN_ROWS || data.nextCursor) {
			lines.push(
				theme.fg(
					"dim",
					`${selected + 1}/${runs.length}${data.nextCursor ? " · more available" : ""}`,
				),
			);
		}
		const run = runs[selected];
		if (run) {
			lines.push(
				"",
				`${run.runId}${run.parent ? ` · parent ${shortId(run.parent.runId)}` : ""}`,
				run.leasedElsewhere
					? theme.fg("muted", "leased elsewhere · read-only")
					: `actions: ${run.availableActions.join(", ") || "none"}`,
			);
		}
	}
	if (data.issues.length > 0) {
		const first = data.issues[0];
		lines.push(
			"",
			theme.fg(
				"warning",
				`${data.issues.length} store issue(s)${first ? ` · ${first.kind} ${first.directory}` : ""}`,
			),
		);
	}
	return lines.map((line) => truncate(line, width));
}

function tabLine(
	tab: InspectorTab,
	hasTask: boolean,
	theme: LineTheme,
): string {
	return INSPECTOR_TABS.filter((candidate) => candidate !== "task" || hasTask)
		.map((candidate) =>
			candidate === tab
				? theme.fg("accent", `[${candidate}]`)
				: theme.fg("muted", candidate),
		)
		.join("  ");
}

function overviewLines(
	inspection: WorkflowRunInspection,
	width: number,
	theme: LineTheme,
	now: number,
): string[] {
	const run = inspection.run;
	const counts = run.taskCounts;
	const budget = inspection.budget;
	const lines = [
		keyValue("Definition", run.definitionName, width),
		keyValue(
			"Status",
			`${run.status}${run.requiresAttention ? " · needs action" : ""}`,
			width,
		),
		keyValue(
			"Ownership",
			run.leasedElsewhere
				? "leased elsewhere (no actions)"
				: ownershipLabel(run),
			width,
		),
		keyValue(
			"Depth",
			run.parent
				? `depth ${run.depth} · parent ${shortId(run.parent.runId)} / ${run.parent.taskId}`
				: "root",
			width,
		),
		keyValue(
			"Created",
			`${run.createdAt} · ${formatAge(run.createdAt, now)} ago`,
			width,
		),
		keyValue(
			"Updated",
			`${run.updatedAt} · ${formatAge(run.updatedAt, now)} ago`,
			width,
		),
		keyValue(
			"Deadline",
			`${run.deadlineAt} · ${formatUntil(run.deadlineAt, now)}`,
			width,
		),
		keyValue(
			"Tasks",
			`${counts.completed}/${counts.total} completed · ${counts.running} running · ${counts.failed} failed · ${counts.abandoned} abandoned`,
			width,
		),
	];
	if (budget) {
		lines.push(
			keyValue(
				"Budget",
				`${formatCost(budget.settled.cost)} of ${formatCost(budget.effective.cost)} · ${formatTokens(budget.settled.totalTokens)} tok · ${formatDurationMs(budget.settled.childRuntimeMs)}${budget.reserved.cost ? ` · reserved ${formatCost(budget.reserved.cost)}` : ""}`,
				width,
			),
		);
		if (budget.exceeded) {
			lines.push(theme.fg("error", keyValue("Budget", budget.exceeded, width)));
		}
	}
	lines.push(
		keyValue("Output", run.outputArtifactId ?? "none", width),
		keyValue("Sequence", String(run.lastSequence), width),
		keyValue("Actions", run.availableActions.join(", ") || "none", width),
	);
	// A parked run leads with the question it is parked on: the first pending
	// checkpoint in materialization order, as the run view lists them.
	const pending = pendingCheckpointTasks(inspection);
	const first = pending[0];
	if (first) {
		lines.push("", ...checkpointLines(first, run.runId, width, theme));
		if (pending.length > 1) {
			lines.push(
				theme.fg(
					"muted",
					`+${pending.length - 1} more checkpoint(s) awaiting a decision`,
				),
			);
		}
	}
	return lines;
}

/** On-path checkpoints awaiting a decision, in materialization order. */
export function pendingCheckpointTasks(
	inspection: WorkflowRunInspection,
): readonly WorkflowServiceTaskView[] {
	return (inspection.tasks ?? []).filter(isPendingCheckpointTask);
}

function taskRow(
	inspection: WorkflowRunInspection,
	task: WorkflowServiceTaskView,
	selected: boolean,
	width: number,
	theme: LineTheme,
): string {
	const child = childRunIdOf(inspection, task.id);
	const row = `${selected ? "›" : " "}${task.role === "finalizer" ? "F" : " "} ${taskLine(task)}${child ? ` → ${shortId(child)}` : ""}`;
	if (selected)
		return theme.bg("selectedBg", theme.fg("text", truncate(row, width)));
	return task.abandoned
		? theme.fg("dim", truncate(row, width))
		: truncate(row, width);
}

function tasksLines(
	inspection: WorkflowRunInspection,
	ui: InspectorUiState,
	width: number,
	theme: LineTheme,
): string[] {
	const tasks = inspection.tasks ?? [];
	const live = tasks.filter((task) => task.abandoned !== true).length;
	const lines = [
		theme.fg(
			"muted",
			`${live} live · ${tasks.length - live} abandoned · o open child · enter details`,
		),
	];
	if (tasks.length === 0) {
		lines.push(theme.fg("muted", "No tasks have been declared."));
		return lines;
	}
	const selected = clamp(ui.selectedTask, tasks.length - 1);
	for (const [index, task] of tasks.entries()) {
		lines.push(taskRow(inspection, task, index === selected, width, theme));
	}
	return lines;
}

/** Line and byte bounds of one checkpoint block in a detail pane. */
const MAX_CHECKPOINT_DETAIL_PROMPT_LINES = 8;
const MAX_CHECKPOINT_DETAIL_INPUT_LINES = 12;
const CHECKPOINT_DETAIL_INPUTS_BYTES = 2_048;

function boundedBlock(
	text: string,
	limit: number,
	width: number,
	theme: LineTheme,
): string[] {
	const lines = text.split("\n");
	const kept = lines.slice(0, limit).map((line) => truncate(line, width));
	if (lines.length > limit) {
		kept.push(
			theme.fg("dim", `  … +${lines.length - limit} line(s) · /workflow show`),
		);
	}
	return kept;
}

/** The recorded decision, or the fact that a person still has to answer. */
function checkpointDecisionLabel(
	checkpoint: NonNullable<WorkflowServiceTaskView["checkpoint"]>,
): string {
	const decision = checkpoint.decision;
	if (!decision) {
		return checkpoint.requestedAt
			? "awaiting a person · space to decide"
			: "not requested yet";
	}
	const value =
		"value" in decision ? JSON.stringify(decision.value) : decision.sha256;
	return `${decision.source}${decision.decidedBy ? ` · ${decision.decidedBy}` : ""} · ${value}`;
}

/**
 * The answerable question of one checkpoint task, bounded for a detail pane:
 * the task key `/workflow decide` accepts, the answer shape, the prompt and
 * the declared inputs. Every value is the one the pending-checkpoint view
 * fields carry, rendered through the one shared renderer, so the inspector,
 * the dialogs and the tool output never disagree. A lease-free `inspect`
 * carries no verified `inputs`; the block then stops after the prompt.
 */
function checkpointLines(
	task: Pick<WorkflowServiceTaskView, "namespace" | "key" | "checkpoint">,
	runId: WorkflowRunId,
	width: number,
	theme: LineTheme,
): string[] {
	const checkpoint = task.checkpoint;
	if (!checkpoint) return [];
	const lines = [
		theme.fg("accent", "Checkpoint"),
		keyValue("Task key", checkpointTaskKey(task), width),
		keyValue("Answer", checkpointSchemaSummary(checkpoint.schema), width),
	];
	lines.push(
		...boundedBlock(
			checkpoint.promptTruncated ? `${checkpoint.prompt}…` : checkpoint.prompt,
			MAX_CHECKPOINT_DETAIL_PROMPT_LINES,
			width,
			theme,
		),
	);
	const inputs = checkpoint.inputs ?? {};
	if (Object.keys(inputs).length > 0) {
		lines.push(theme.fg("muted", "Inputs"));
		lines.push(
			...boundedBlock(
				renderCheckpointInputs(inputs, {
					budget: CHECKPOINT_DETAIL_INPUTS_BYTES,
					run: runId,
				}),
				MAX_CHECKPOINT_DETAIL_INPUT_LINES,
				width,
				theme,
			),
		);
	}
	return lines;
}

function taskDetailLines(
	inspection: WorkflowRunInspection,
	task: WorkflowServiceTaskView,
	width: number,
	theme: LineTheme,
): string[] {
	const byId = new Map((inspection.tasks ?? []).map((t) => [t.id, t]));
	const pathOf = (id: WorkflowTaskId) => {
		const found = byId.get(id);
		return found ? taskPath(found) : id;
	};
	const executions = (inspection.executions ?? []).filter(
		(execution) => execution.taskId === task.id,
	);
	const current =
		executions.find((execution) => execution.current) ??
		executions.find((execution) => execution.id === task.executionId);
	const lines = [
		keyValue("Id", task.id, width),
		keyValue("Path", taskPath(task), width),
		keyValue(
			"Kind",
			`${task.kind} · ${task.role} · ${task.disposition}`,
			width,
		),
		keyValue(
			"Status",
			`${task.status}${task.abandoned ? " · abandoned" : ""}`,
			width,
		),
		keyValue("Generation", formatGeneration(task.generation) || "gen 1", width),
		keyValue(
			"Execution",
			current
				? `${current.id} · ${current.phase}${current.current ? " · current" : ""}`
				: (task.executionId ?? "none"),
			width,
		),
		keyValue(
			"Attempts",
			String(task.attempts ?? current?.attempts.length ?? 0),
			width,
		),
	];
	for (const attempt of current?.attempts ?? []) {
		lines.push(
			`  #${attempt.ordinal} ${attempt.kind} ${attempt.state}${attempt.status ? ` · ${attempt.status}` : ""}${attempt.declinedReason ? ` · ${attempt.declinedReason}` : ""}`,
		);
	}
	if (executions.length > 1) {
		lines.push(theme.fg("accent", "Generations"));
		for (const execution of executions) {
			lines.push(
				`  gen ${execution.generation} · ${execution.phase}${execution.terminal ? ` · ${execution.terminal.outcome}` : ""}${execution.current ? " · current" : ""}`,
			);
		}
	}
	const settlement = task.settlement;
	lines.push(
		keyValue(
			"Settlement",
			settlement
				? `${settlement.status} · attempt ${settlement.attemptOrdinal}${settlement.failureCode ? ` · ${settlement.failureCode} (${settlement.failureRetry ?? "?"})` : ""}${settlement.usageComplete ? "" : " · usage incomplete"}`
				: "none",
			width,
		),
	);
	const terminal = current?.terminal;
	lines.push(
		keyValue(
			"Terminal",
			terminal
				? `${terminal.outcome}${terminal.failure ? ` · ${terminal.failure.code}${terminal.failure.stage ? ` @${terminal.failure.stage}` : ""}` : ""}`
				: (task.outcome ?? "none"),
			width,
		),
		keyValue(
			"Depends on",
			(task.dependsOn ?? []).map(pathOf).join(", ") || "none",
			width,
		),
		keyValue(
			"Inputs",
			Object.entries(task.inputs ?? {})
				.map(([name, producer]) => `${name} ← ${pathOf(producer)}`)
				.join(", ") || "none",
			width,
		),
	);
	const child = childRunIdOf(inspection, task.id);
	if (child) lines.push(keyValue("Child run", `${child} · o open`, width));
	if (task.checkpoint) {
		lines.push(
			...checkpointLines(task, inspection.run.runId, width, theme),
			keyValue("Decision", checkpointDecisionLabel(task.checkpoint), width),
		);
	}
	lines.push(
		keyValue("Artifacts", String(current?.artifactIds.length ?? 0), width),
		keyValue(
			"Actions",
			task.abandoned
				? "abandoned"
				: taskActions(inspection.run, task)
						.map((action) => INSPECTOR_ACTION_LABELS[action])
						.join(", ") || "none",
			width,
		),
	);
	return lines;
}

function activityLines(
	logs: WorkflowLogPage | undefined,
	theme: LineTheme,
): string[] {
	if (!logs || logs.entries.length === 0) {
		return [theme.fg("muted", "No lifecycle entries.")];
	}
	const lines = logs.entries.map((entry) => {
		const line = logLine(entry);
		if (entry.abandoned) return theme.fg("dim", line);
		if (entry.kind === "run") return theme.fg("accent", line);
		return line;
	});
	lines.push(
		theme.fg(
			"dim",
			`Showing ${logs.entries.length} of seq ${logs.lastSequence}`,
		),
	);
	return lines;
}

function technicalLines(
	inspection: WorkflowRunInspection,
	issues: readonly WorkflowRunListIssue[],
	width: number,
	theme: LineTheme,
): string[] {
	const run = inspection.run;
	const budget = inspection.budget;
	const lines = [
		keyValue("Run ID", run.runId, width),
		keyValue("Definition", run.definitionName, width),
		keyValue("Created", run.createdAt, width),
		keyValue("Deadline", run.deadlineAt, width),
		keyValue(
			"Effective budget",
			budget ? JSON.stringify(budget.effective) : "unavailable",
			width,
		),
		keyValue(
			"Declared budget",
			budget ? JSON.stringify(budget.declared) : "unavailable",
			width,
		),
	];
	const barriers = inspection.barriers ?? [];
	lines.push(keyValue("Barriers", String(barriers.length), width));
	for (const barrier of barriers.slice(-8)) {
		lines.push(
			theme.fg(
				barrier.abandoned ? "dim" : "text",
				`  epoch ${barrier.epoch} ${barrier.kind} ×${barrier.taskIds.length}${barrier.abandoned ? " abandoned" : ""}`,
			),
		);
	}
	const artifacts = inspection.artifacts ?? [];
	lines.push(keyValue("Artifacts", String(artifacts.length), width));
	for (const artifact of artifacts.slice(-8)) {
		lines.push(
			`  ${shortId(artifact.id)} ${artifact.bytes} B ${artifact.mediaType}${artifact.isRunOutput ? " · run output" : ""}`,
		);
	}
	const truncated = Object.entries(inspection.truncated)
		.filter(([, count]) => count !== undefined)
		.map(([section, count]) => `${section} ${count}`)
		.join(", ");
	lines.push(keyValue("Truncated", truncated || "none", width));
	lines.push(keyValue("Issues", String(issues.length), width));
	for (const issue of issues.slice(0, 8)) {
		lines.push(
			theme.fg(
				"warning",
				`  ${issue.kind} ${issue.directory}: ${issue.message}`,
			),
		);
	}
	return lines;
}

/** The detail screen body for the current tab; `Loading…` until the run's inspection arrives. */
export function detailBody(
	state: InspectorState,
	ui: InspectorUiState,
	data: InspectorData,
	width: number,
	theme: LineTheme,
	now = Date.now(),
): string[] {
	const inspection = currentInspection(state, data);
	if (!inspection) {
		return [data.error ? theme.fg("error", data.error) : "Loading…"];
	}
	const task = selectedTaskView(state, data);
	const lines = [tabLine(state.tab, task !== undefined, theme), ""];
	if (inspection.run.leasedElsewhere) {
		lines.push(
			theme.fg("warning", "Leased by another Pi process · read-only"),
			"",
		);
	}
	switch (state.tab) {
		case "overview":
			lines.push(...overviewLines(inspection, width, theme, now));
			break;
		case "tasks":
			lines.push(...tasksLines(inspection, ui, width, theme));
			break;
		case "task":
			lines.push(
				...(task
					? taskDetailLines(inspection, task, width, theme)
					: [theme.fg("muted", "Select a task on the tasks tab.")]),
			);
			break;
		case "activity":
			lines.push(...activityLines(data.logs, theme));
			break;
		case "technical":
			lines.push(...technicalLines(inspection, data.issues, width, theme));
			break;
	}
	return lines.map((line) => truncate(line, width));
}

export function actionsBody(
	state: InspectorState,
	ui: InspectorUiState,
	data: InspectorData,
	theme: LineTheme,
): string[] {
	const actions = currentActions(state, ui, data);
	const inspection = currentInspection(state, data);
	if (actions.length === 0) {
		return [
			theme.fg(
				"muted",
				inspection?.run.leasedElsewhere
					? "No actions: this run is leased by another Pi process."
					: "No actions are available for this run.",
			),
		];
	}
	const task =
		ui.paletteScope === "task" ? selectedTaskView(state, data) : undefined;
	const header = task ? [theme.fg("muted", `Task ${taskPath(task)}`), ""] : [];
	return [
		...header,
		...actions.map((action, index) =>
			index === ui.selectedAction
				? theme.bg("selectedBg", `› ${INSPECTOR_ACTION_LABELS[action]}`)
				: `  ${INSPECTOR_ACTION_LABELS[action]}`,
		),
	];
}

export function taskPickerBody(
	state: InspectorState,
	ui: InspectorUiState,
	data: InspectorData,
	width: number,
	theme: LineTheme,
): string[] {
	const inspection = currentInspection(state, data);
	const tasks = inspection?.tasks ?? [];
	if (!inspection || tasks.length === 0) {
		return [theme.fg("muted", "No tasks to choose from.")];
	}
	const selected = clamp(ui.selectedTask, tasks.length - 1);
	return [
		theme.fg(
			"muted",
			ui.pendingAction === "decide"
				? "Choose the checkpoint to decide · only a checkpoint awaiting a decision can be selected"
				: `Choose the task to ${ui.pendingAction ?? "act on"} · abandoned tasks cannot be selected`,
		),
		"",
		...tasks.map((task, index) =>
			taskRow(inspection, task, index === selected, width, theme),
		),
	];
}

export function confirmBody(
	state: InspectorState,
	ui: InspectorUiState,
	data: InspectorData,
	theme: LineTheme,
): { title: string; body: string[] } {
	const inspection = currentInspection(state, data);
	const action = ui.pendingAction;
	if (!inspection || !action)
		return { title: "Confirm", body: ["Nothing to confirm."] };
	const task = ui.pendingTaskId
		? inspection.tasks?.find((candidate) => candidate.id === ui.pendingTaskId)
		: undefined;
	const body = [
		theme.fg("accent", INSPECTOR_ACTION_LABELS[action]),
		...(task ? [`Task: ${taskPath(task)}`] : []),
		"",
		...actionConsequence(action, data.preview),
	];
	return {
		title: `Confirm ${action} · ${shortId(inspection.run.runId)}`,
		body,
	};
}

export function helpBody(): string[] {
	return [
		"↑↓        select / scroll",
		"pgup/pgdn page",
		"enter     inspect run / task details / choose",
		"escape    back / close",
		"←→        change detail tab",
		"space     action palette (availableActions only)",
		"o         open the child run of a nested task",
		"f         cycle filter: all · ongoing · needs action · terminal",
		"c         toggle child runs in the list",
		"r         refresh",
		"?         help",
	];
}

// ---------------------------------------------------------------------------
// Non-TUI text fallback (bounded)
// ---------------------------------------------------------------------------

/** Widest line the text fallback emits; task paths alone can reach 4256 chars. */
export const FALLBACK_LINE_WIDTH = 200;

function boundedLines(lines: readonly string[]): string {
	return lines.map((line) => truncate(line, FALLBACK_LINE_WIDTH)).join("\n");
}

export function formatRunList(page: WorkflowRunPage): string {
	const lines =
		page.runs.length === 0
			? ["No workflow runs."]
			: page.runs.map((run) => runLine(run));
	if (page.runs.length > 0) {
		lines.push(
			`${page.runs.length} of ${page.total} run(s)${page.nextCursor ? " · more available" : ""}`,
		);
	}
	if (page.issues.length > 0) {
		lines.push(`${page.issues.length + page.issuesTruncated} issue(s)`);
	}
	return boundedLines(lines);
}

export function formatRunDetail(inspection: WorkflowRunInspection): string {
	const run = inspection.run;
	const counts = run.taskCounts;
	const lines = [
		`${run.status.padEnd(18)} ${run.runId}`,
		`definition: ${run.definitionName}`,
		`ownership: ${ownershipLabel(run)}${run.leasedElsewhere ? " (no actions)" : ""}`,
		`depth: ${run.depth}${run.parent ? ` · parent ${run.parent.runId} / ${run.parent.taskId}` : ""}`,
		`created: ${run.createdAt}`,
		`updated: ${run.updatedAt}`,
		`deadline: ${run.deadlineAt}`,
		`tasks: ${counts.completed}/${counts.total} completed · ${counts.running} running · ${counts.failed} failed · ${counts.interrupted} interrupted · ${counts["cleanup-blocked"]} cleanup-blocked · ${counts.abandoned} abandoned`,
	];
	if (inspection.budget) {
		const budget = inspection.budget;
		lines.push(
			`budget: ${formatCost(budget.settled.cost)} of ${formatCost(budget.effective.cost)} · ${formatTokens(budget.settled.totalTokens)} tok · ${formatDurationMs(budget.settled.childRuntimeMs)}${budget.exceeded ? ` · ${budget.exceeded}` : ""}`,
		);
	}
	lines.push(`actions: ${run.availableActions.join(", ") || "none"}`);
	for (const task of inspection.tasks ?? []) {
		lines.push(`  ${taskLine(task)}`);
	}
	return boundedLines(lines);
}

/** Spec-named aliases of the text fallback. */
export const runsText = formatRunList;
export const detailText = formatRunDetail;

// ---------------------------------------------------------------------------
// pi-tui glue
// ---------------------------------------------------------------------------

type Theme = ExtensionContext["ui"]["theme"];

export const INSPECTOR_RUN_PAGE_SIZE = 50;
export const INSPECTOR_LOG_TAIL = 100;
export const INSPECTOR_CLOCK_MS = 1_000;
/** Clock ticks between background reloads while runs are nonterminal or leased elsewhere. */
export const INSPECTOR_POLL_TICKS = 5;
export const INSPECTOR_INSPECT_SECTIONS: readonly WorkflowInspectSection[] =
	Object.freeze([
		"run",
		"budget",
		"tasks",
		"executions",
		"barriers",
		"artifacts",
	]);

/** The read surface the inspector needs; every method is lease-free. */
export type InspectorService = Pick<
	WorkflowService,
	"listRuns" | "inspect" | "logs" | "subscribe" | "previewInvalidation"
>;

export interface ShowWorkflowInspectorOptions extends Partial<InspectorState> {
	/** Same as passing the fields directly; kept for callers that wrap them. */
	initialState?: Partial<InspectorState>;
	/** Injectable clock for tests. */
	now?: () => number;
}

async function collectLogTail(
	service: Pick<InspectorService, "logs">,
	runId: WorkflowRunId,
	tail: number,
): Promise<WorkflowLogPage> {
	let afterSequence: number | undefined;
	let entries: WorkflowLogPage["entries"] = [];
	let lastSequence = 0;
	for (;;) {
		const page = await service.logs(runId, {
			limit: 500,
			...(afterSequence === undefined ? {} : { afterSequence }),
		});
		entries = [...entries, ...page.entries].slice(-tail);
		lastSequence = page.lastSequence;
		if (page.nextAfterSequence === undefined) break;
		afterSequence = page.nextAfterSequence;
	}
	return { runId, entries, lastSequence };
}

function bordered(
	title: string,
	body: readonly string[],
	footer: readonly string[],
	width: number,
	theme: Theme,
): string[] {
	const inner = Math.max(20, width - 2);
	const topLabel = ` ${title} `;
	const label = truncate(topLabel, inner);
	const top = `┌${label}${"─".repeat(Math.max(0, inner - visibleWidth(label)))}┐`;
	const bottom = `└${"─".repeat(inner)}┘`;
	const line = (value: string) => `│${pad(` ${value}`, inner)}│`;
	return [
		theme.fg("borderAccent", truncate(top, width)),
		...body.map(line),
		...(footer.length > 0
			? [line(""), ...footer.map((value) => line(theme.fg("dim", value)))]
			: []),
		theme.fg("borderAccent", truncate(bottom, width)),
	];
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Opens the workflow inspector as a focused custom component and resolves
 * with the operator's intent: close, or a confirmed action request the
 * caller forwards to the service. Refreshes through `service.subscribe` and a
 * 1 s unref'd clock; both are released when the component resolves.
 */
export async function showWorkflowInspector(
	ctx: ExtensionContext,
	service: InspectorService,
	options: ShowWorkflowInspectorOptions = {},
): Promise<InspectorIntent> {
	const { initialState, now: nowOption, ...direct } = options;
	const now = nowOption ?? (() => Date.now());
	let state = initialInspectorState({ ...direct, ...initialState });
	let ui = initialInspectorUiState(state);
	const data: InspectorData = { runs: [], total: 0, issues: [] };
	const reasonInput = new Input();
	let disposed = false;
	let requestRender = () => {};
	let finish: ((intent: InspectorIntent) => void) | undefined;
	let finished = false;

	const render = () => {
		if (!disposed) requestRender();
	};

	const loadRuns = async (append = false) => {
		try {
			const statuses = runFilterStatuses(state.filter);
			const page = await service.listRuns({
				...(statuses ? { statuses: [...statuses] } : {}),
				...(state.includeChildren ? { includeChildren: true } : {}),
				...(append && data.nextCursor ? { cursor: data.nextCursor } : {}),
				limit: INSPECTOR_RUN_PAGE_SIZE,
			});
			if (disposed) return;
			const loaded = append ? [...data.runs, ...page.runs] : [...page.runs];
			data.runs = applyRunFilter(loaded, state.filter);
			data.total = page.total;
			if (page.nextCursor) data.nextCursor = page.nextCursor;
			else delete data.nextCursor;
			data.issues = page.issues;
			delete data.error;
			ui.selectedRun = clamp(ui.selectedRun, data.runs.length - 1);
		} catch (cause) {
			if (disposed) return;
			data.error = messageOf(cause);
		}
		render();
	};

	const loadDetail = async (runId: WorkflowRunId) => {
		try {
			const [inspection, logs] = await Promise.all([
				service.inspect(runId, { include: [...INSPECTOR_INSPECT_SECTIONS] }),
				collectLogTail(service, runId, INSPECTOR_LOG_TAIL),
			]);
			// A drill-in or escape may have moved on while this load was in flight.
			if (disposed || displayedRunId(state) !== runId) return;
			data.inspection = inspection;
			data.logs = logs;
			delete data.error;
			const tasks = inspection.tasks ?? [];
			ui.selectedTask = clamp(ui.selectedTask, tasks.length - 1);
			if (
				state.selectedTaskId &&
				!tasks.some((task) => task.id === state.selectedTaskId)
			) {
				delete state.selectedTaskId;
				if (state.tab === "task") state.tab = "tasks";
			}
		} catch (cause) {
			if (disposed) return;
			data.error = messageOf(cause);
		}
		render();
	};

	// The closure comes from the service, which runs the reducer's own
	// computation over durable state; the inspector never derives it.
	const loadPreview = async (runId: WorkflowRunId, taskId: WorkflowTaskId) => {
		delete data.preview;
		try {
			const preview = await service.previewInvalidation(runId, taskId);
			if (disposed) return;
			data.preview = {
				taskIds: preview.taskIds,
				taskKeys: preview.taskKeys,
				abandonedEpochs: preview.abandonedEpochs,
				abandonedTaskIds: preview.abandonedTaskIds,
			};
		} catch (cause) {
			if (disposed) return;
			data.preview = {
				taskIds: [],
				taskKeys: [],
				abandonedEpochs: [],
				abandonedTaskIds: [],
				refusal: messageOf(cause),
			};
		}
		render();
	};

	const runEffects = (effects: readonly InspectorEffect[]) => {
		for (const effect of effects) {
			switch (effect.type) {
				case "load-runs":
					void loadRuns(effect.append === true);
					break;
				case "load-detail":
					void loadDetail(effect.runId);
					break;
				case "load-preview":
					void loadPreview(effect.runId, effect.taskId);
					break;
				case "open-input":
					reasonInput.setValue(effect.initial);
					break;
				case "done":
					if (!finished) {
						finished = true;
						finish?.(effect.intent);
					}
					break;
			}
		}
	};

	const apply = (key: InspectorKey) => {
		if (disposed || finished) return;
		const step = reduceInspector(state, ui, data, key);
		state = step.state;
		ui = step.ui;
		runEffects(step.effects);
		render();
	};

	await loadRuns();
	const initialRun = displayedRunId(state);
	if (state.view === "detail" && initialRun) await loadDetail(initialRun);

	const unsubscribe = service.subscribe((observation) => {
		if (disposed) return;
		void loadRuns();
		const top = displayedRunId(state);
		if (top && state.runStack.includes(observation.runId)) void loadDetail(top);
	});
	let ticks = 0;
	const clock = setInterval(() => {
		if (disposed) return;
		ticks += 1;
		const displayed = currentInspection(state, data)?.run;
		const live =
			data.runs.some((run) => isNonterminalRunStatus(run.status)) ||
			(displayed !== undefined && isNonterminalRunStatus(displayed.status));
		if (live) render();
		// Runs leased elsewhere never notify through subscribe, so poll them.
		if (
			ticks % INSPECTOR_POLL_TICKS === 0 &&
			(live || displayed?.leasedElsewhere)
		) {
			void loadRuns();
			const top = displayedRunId(state);
			if (top) void loadDetail(top);
		}
	}, INSPECTOR_CLOCK_MS);
	clock.unref();

	try {
		return await ctx.ui.custom<InspectorIntent>(
			(tui, theme, _keybindings, done) => {
				requestRender = () => tui.requestRender();
				finish = done;
				reasonInput.onSubmit = (text) => apply({ submit: text });
				reasonInput.onEscape = () => apply("escape");
				return {
					render(width: number) {
						const contentWidth = Math.max(20, width - 4);
						const inspection = currentInspection(state, data);
						switch (ui.screen) {
							case "input": {
								const action = ui.pendingAction ?? "stop";
								return bordered(
									`${INSPECTOR_ACTION_LABELS[action]} · ${inspection ? shortId(inspection.run.runId) : ""}`,
									["Reason", ...reasonInput.render(contentWidth)],
									["enter submit · esc cancel"],
									width,
									theme,
								);
							}
							case "confirm": {
								const confirm = confirmBody(state, ui, data, theme);
								return bordered(
									confirm.title,
									confirm.body,
									["enter confirm · esc cancel"],
									width,
									theme,
								);
							}
							case "help":
								return bordered(
									"Workflow inspector help",
									helpBody(),
									["esc back"],
									width,
									theme,
								);
							case "actions":
								return bordered(
									`Actions · ${inspection ? shortId(inspection.run.runId) : ""}`,
									actionsBody(state, ui, data, theme),
									["enter select · esc cancel"],
									width,
									theme,
								);
							case "task-picker":
								return bordered(
									`Choose task · ${inspection ? shortId(inspection.run.runId) : ""}`,
									taskPickerBody(state, ui, data, contentWidth, theme),
									["↑↓ select · enter choose · esc cancel"],
									width,
									theme,
								);
							case "detail": {
								const lines = detailBody(
									state,
									ui,
									data,
									contentWidth,
									theme,
									now(),
								);
								const scroll = clamp(
									ui.scroll,
									Math.max(0, lines.length - DETAIL_PAGE_LINES),
								);
								ui.scroll = scroll;
								const visible = lines.slice(scroll, scroll + DETAIL_PAGE_LINES);
								return bordered(
									inspection ? detailTitle(inspection) : "Workflow run",
									visible,
									[
										`↑↓ scroll/select ${Math.min(lines.length, scroll + visible.length)}/${lines.length} · ←→ tabs · space actions · o open child`,
										"r refresh · ? help · esc back",
									],
									width,
									theme,
								);
							}
							default:
								return bordered(
									runsTitle(state),
									runsBody(state, ui, data, contentWidth, theme, now()),
									[
										"enter inspect · f filter · c children · r refresh",
										"? help · esc close",
									],
									width,
									theme,
								);
						}
					},
					handleInput(input: string) {
						if (ui.screen === "input") {
							reasonInput.handleInput(input);
							render();
							return;
						}
						if (matchesKey(input, Key.escape)) apply("escape");
						else if (matchesKey(input, Key.enter)) apply("enter");
						else if (matchesKey(input, Key.up)) apply("up");
						else if (matchesKey(input, Key.down)) apply("down");
						else if (matchesKey(input, Key.left)) apply("left");
						else if (matchesKey(input, Key.right)) apply("right");
						else if (matchesKey(input, Key.pageUp)) apply("pageUp");
						else if (matchesKey(input, Key.pageDown)) apply("pageDown");
						else if (matchesKey(input, Key.space)) apply("space");
						else if ([...input].length === 1 && input >= " ") {
							apply({ char: input });
						}
					},
					get focused() {
						return reasonInput.focused;
					},
					set focused(value: boolean) {
						reasonInput.focused = value;
					},
					invalidate() {
						reasonInput.invalidate();
					},
					dispose() {
						disposed = true;
					},
				};
			},
		);
	} finally {
		disposed = true;
		unsubscribe();
		clearInterval(clock);
	}
}
