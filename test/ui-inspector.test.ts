import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	WorkflowExecutionView,
	WorkflowRunInspection,
	WorkflowRunPage,
	WorkflowRunSummary,
	WorkflowServiceTaskView,
} from "../src/service-views.js";
import {
	actionsBody,
	applyRunFilter,
	confirmBody,
	currentActions,
	DEFAULT_INVALIDATE_REASON,
	DEFAULT_STOP_REASON,
	detailBody,
	formatRunDetail,
	formatRunList,
	INSPECTOR_ACTION_LABELS,
	type InspectorData,
	type InspectorEffect,
	type InspectorKey,
	type InspectorService,
	type InspectorState,
	type InspectorUiState,
	initialInspectorState,
	initialInspectorUiState,
	invalidateConsequence,
	keyValue,
	PLAIN_LINE_THEME,
	pad,
	paletteActions,
	RUN_FILTER_NAMES,
	reduceInspector,
	runFilterStatuses,
	runsBody,
	showWorkflowInspector,
	taskActions,
	taskPickerBody,
	truncate,
} from "../src/ui/inspector.js";

const NOW = Date.parse("2026-09-15T12:05:00.000Z");
const PARENT = "workflow_parent000000001";
const CHILD = "workflow_child0000000001";

function counts(
	overrides: Partial<WorkflowRunSummary["taskCounts"]> = {},
): WorkflowRunSummary["taskCounts"] {
	return {
		pending: 0,
		ready: 0,
		running: 0,
		waiting: 0,
		completed: 0,
		failed: 0,
		interrupted: 0,
		blocked: 0,
		cancelling: 0,
		cancelled: 0,
		"cleanup-blocked": 0,
		invalidated: 0,
		abandoned: 0,
		total: 0,
		...overrides,
	};
}

function summary(
	status: WorkflowRunSummary["status"],
	overrides: Partial<WorkflowRunSummary> = {},
): WorkflowRunSummary {
	return {
		runId: PARENT,
		definitionName: "release",
		status,
		createdAt: "2026-09-15T12:00:00.000Z",
		updatedAt: "2026-09-15T12:04:00.000Z",
		deadlineAt: "2026-09-15T13:00:00.000Z",
		depth: 0,
		lastSequence: 12,
		taskCounts: counts({ completed: 2, failed: 1, abandoned: 1, total: 5 }),
		ownership: "inactive",
		leasedElsewhere: false,
		pendingCheckpointCount: 0,
		requiresAttention: status === "failed" || status === "interrupted",
		...overrides,
		availableActions: overrides.availableActions ?? [],
	};
}

function task(
	overrides: Partial<WorkflowServiceTaskView> = {},
): WorkflowServiceTaskView {
	return {
		id: "task_report",
		namespace: [],
		key: "report",
		kind: "agent",
		role: "task",
		disposition: "required",
		status: "completed",
		generation: 1,
		dependsOn: [],
		inputs: {},
		...overrides,
	};
}

const TASKS: readonly WorkflowServiceTaskView[] = [
	task({
		id: "task_report",
		key: "report",
		status: "failed",
		generation: 3,
		executionId: "execution_report3",
		attempts: 2,
		settlement: {
			attemptOrdinal: 2,
			status: "failed",
			failureCode: "provider-error",
			failureRetry: "manual",
			usageComplete: true,
		},
		outcome: "failed",
	}),
	task({
		id: "task_summary",
		key: "summary",
		status: "blocked",
		dependsOn: ["task_report"],
		inputs: { report: "task_report" },
	}),
	task({
		id: "task_child",
		key: "child",
		kind: "workflow",
		status: "completed",
		executionId: "execution_child1",
	}),
	task({
		id: "task_old",
		namespace: ["legacy"],
		key: "old",
		status: "completed",
		abandoned: true,
	}),
	task({
		id: "task_cleanup",
		key: "cleanup",
		kind: "support",
		role: "finalizer",
		status: "completed",
	}),
];

const EXECUTIONS: readonly WorkflowExecutionView[] = [
	{
		id: "execution_report3",
		taskId: "task_report",
		generation: 3,
		kind: "agent",
		phase: "terminal",
		current: true,
		createdSequence: 8,
		attempts: [
			{
				kind: "retry",
				ordinal: 2,
				status: "failed",
				state: "receipted",
				intentSequence: 9,
			},
		],
		terminal: {
			outcome: "failed",
			failure: { code: "provider-error", retry: "manual" },
			sequence: 10,
		},
		artifactIds: [],
	},
	{
		id: "execution_child1",
		taskId: "task_child",
		generation: 1,
		kind: "workflow",
		phase: "terminal",
		current: true,
		createdSequence: 3,
		childRunId: CHILD,
		attempts: [],
		artifactIds: [],
	},
];

function inspection(
	overrides: Partial<WorkflowRunInspection> = {},
): WorkflowRunInspection {
	return {
		run: summary("failed", {
			availableActions: ["wait", "invalidate", "reconcile", "stop"],
		}),
		budget: {
			declared: { cost: 5, childRuntimeMs: 3_600_000 },
			effective: { cost: 5, childRuntimeMs: 3_600_000 },
			settled: {
				cost: 1.25,
				totalTokens: 12_345,
				childRuntimeMs: 185_000,
				usageComplete: true,
			},
			reserved: { cost: 0, totalTokens: 0, childRuntimeMs: 0 },
		},
		tasks: TASKS,
		executions: EXECUTIONS,
		barriers: [
			{ epoch: 1, kind: "result", taskIds: ["task_report"], sequence: 5 },
			{ epoch: 2, kind: "final", taskIds: ["task_summary"], sequence: 11 },
			{
				epoch: 1,
				kind: "results",
				taskIds: ["task_old"],
				sequence: 4,
				abandoned: true,
			},
		],
		artifacts: [],
		truncated: {},
		...overrides,
	};
}

function data(overrides: Partial<InspectorData> = {}): InspectorData {
	return { runs: [], total: 0, issues: [], ...overrides };
}

/** What the service's `previewInvalidation` reports for `report` on the fixture. */
const REPORT_PREVIEW = {
	taskIds: ["task_report", "task_summary"],
	taskKeys: ["/report", "/summary"],
	abandonedEpochs: [2],
	abandonedTaskIds: [],
};

function detailState(partial: Partial<InspectorState> = {}): InspectorState {
	return initialInspectorState({
		view: "detail",
		runStack: [PARENT],
		...partial,
	});
}

/** Drives the reducer through a key sequence and collects every effect. */
function drive(
	state: InspectorState,
	ui: InspectorUiState,
	current: InspectorData,
	keys: readonly InspectorKey[],
): { state: InspectorState; ui: InspectorUiState; effects: InspectorEffect[] } {
	const effects: InspectorEffect[] = [];
	let step = { state, ui };
	for (const key of keys) {
		const next = reduceInspector(step.state, step.ui, current, key);
		effects.push(...next.effects);
		step = { state: next.state, ui: next.ui };
	}
	return { ...step, effects };
}

function doneIntent(effects: readonly InspectorEffect[]) {
	const done = effects.find((effect) => effect.type === "done");
	return done?.type === "done" ? done.intent : undefined;
}

describe("inspector action palette", () => {
	it("mirrors availableActions minus wait, never re-deriving legality", () => {
		expect(
			paletteActions(
				summary("failed", {
					availableActions: ["stop", "wait", "reconcile", "invalidate"],
				}),
			),
		).toEqual(["stop", "reconcile", "invalidate"]);
		// `decide` is offered exactly while the service offers it.
		expect(
			paletteActions(
				summary("waiting", {
					availableActions: ["wait", "stop", "decide"],
					pendingCheckpointCount: 1,
				}),
			),
		).toEqual(["stop", "decide"]);
		expect(paletteActions(summary("failed"))).toEqual([]);
		expect(
			paletteActions(
				summary("running", {
					ownership: "leased-elsewhere",
					leasedElsewhere: true,
				}),
			),
		).toEqual([]);
		// A run the table would call terminal still shows whatever the service says.
		expect(
			paletteActions(summary("completed", { availableActions: ["retry"] })),
		).toEqual(["retry"]);
	});

	it("scopes task actions and keeps abandoned tasks unactionable", () => {
		const run = summary("failed", {
			availableActions: ["stop", "invalidate", "reconcile", "retry"],
		});
		// Order is the service's order, never a UI ranking.
		expect(taskActions(run, task())).toEqual([
			"invalidate",
			"reconcile",
			"retry",
		]);
		expect(taskActions(run, task({ abandoned: true }))).toEqual([]);
	});
});

describe("inspector filters", () => {
	it("cycles the four filters and maps them to status queries plus post-filters", () => {
		expect(RUN_FILTER_NAMES).toEqual([
			"all",
			"ongoing",
			"needs action",
			"terminal",
		]);
		expect(runFilterStatuses("all")).toBeUndefined();
		expect(runFilterStatuses("needs action")).toEqual([
			"failed",
			"interrupted",
			"cleanup-blocked",
		]);
		const runs = [
			summary("running", { runId: "workflow_running000000001" }),
			summary("failed", { runId: "workflow_failed0000000001" }),
			summary("failed", {
				runId: "workflow_recovering000001",
				requiresAttention: false,
			}),
			summary("completed", { runId: "workflow_done00000000001" }),
		];
		expect(applyRunFilter(runs, "all")).toHaveLength(4);
		expect(applyRunFilter(runs, "ongoing").map((run) => run.runId)).toEqual([
			"workflow_running000000001",
			"workflow_recovering000001",
		]);
		expect(
			applyRunFilter(runs, "needs action").map((run) => run.runId),
		).toEqual(["workflow_failed0000000001"]);
		expect(applyRunFilter(runs, "terminal").map((run) => run.runId)).toEqual([
			"workflow_failed0000000001",
			"workflow_recovering000001",
			"workflow_done00000000001",
		]);
	});

	it("advances the filter and the children toggle from the runs screen", () => {
		const state = initialInspectorState();
		const ui = initialInspectorUiState(state);
		const filtered = drive(state, ui, data(), [{ char: "f" }]);
		expect(filtered.state.filter).toBe("ongoing");
		expect(filtered.effects).toEqual([{ type: "load-runs" }]);
		const wrapped = drive(state, ui, data(), [
			{ char: "f" },
			{ char: "f" },
			{ char: "f" },
			{ char: "f" },
		]);
		expect(wrapped.state.filter).toBe("all");
		const children = drive(state, ui, data(), [{ char: "c" }]);
		expect(children.state.includeChildren).toBe(true);
		expect(children.effects).toEqual([{ type: "load-runs" }]);
	});
});

describe("inspector state machine", () => {
	it("opens a run from the list and returns to the list on escape", () => {
		const state = initialInspectorState();
		const ui = initialInspectorUiState(state);
		const runs = [summary("running"), summary("failed", { runId: CHILD })];
		const opened = drive(state, ui, data({ runs, total: 2 }), [
			"down",
			"enter",
		]);
		expect(opened.state).toMatchObject({
			view: "detail",
			runStack: [CHILD],
			tab: "overview",
		});
		expect(opened.ui.screen).toBe("detail");
		expect(opened.effects).toEqual([{ type: "load-detail", runId: CHILD }]);
		const closed = drive(opened.state, opened.ui, data({ runs, total: 2 }), [
			"escape",
		]);
		expect(closed.state.view).toBe("runs");
		expect(closed.ui.screen).toBe("runs");
		expect(closed.effects).toEqual([]);
		const intent = doneIntent(
			drive(closed.state, closed.ui, data({ runs }), ["escape"]).effects,
		);
		expect(intent).toMatchObject({ type: "close" });
	});

	it("requests the next page when moving past the last loaded run", () => {
		const state = initialInspectorState();
		const ui = initialInspectorUiState(state);
		const runs = [summary("running")];
		const step = drive(
			state,
			ui,
			data({ runs, total: 60, nextCursor: "cursor" }),
			["down"],
		);
		expect(step.effects).toEqual([{ type: "load-runs", append: true }]);
	});

	it("cycles tabs and skips the task tab until a task is selected", () => {
		const state = detailState();
		const ui = initialInspectorUiState(state);
		const current = data({ inspection: inspection() });
		const tabs = [];
		let step = { state, ui, effects: [] as InspectorEffect[] };
		for (let index = 0; index < 4; index += 1) {
			step = drive(step.state, step.ui, current, ["right"]);
			tabs.push(step.state.tab);
		}
		expect(tabs).toEqual(["tasks", "activity", "technical", "overview"]);
		const selected = drive(state, ui, current, ["right", "down", "right"]);
		expect(selected.state.selectedTaskId).toBe("task_summary");
		expect(selected.state.tab).toBe("task");
		const viaEnter = drive(state, ui, current, ["right", "enter"]);
		expect(viaEnter.state).toMatchObject({
			tab: "task",
			selectedTaskId: "task_report",
		});
	});

	it("drills into a nested child run and pops back with the previous tab intact", () => {
		const state = detailState();
		const ui = initialInspectorUiState(state);
		const current = data({ inspection: inspection() });
		const drilled = drive(state, ui, current, [
			"right",
			"down",
			"down",
			{ char: "o" },
		]);
		expect(drilled.state.runStack).toEqual([PARENT, CHILD]);
		expect(drilled.state.tab).toBe("overview");
		expect(drilled.effects.at(-1)).toEqual({
			type: "load-detail",
			runId: CHILD,
		});
		// The child inspection is not loaded yet: the detail body says so.
		expect(
			detailBody(drilled.state, drilled.ui, current, 80, PLAIN_LINE_THEME, NOW),
		).toEqual(["Loading…"]);
		const popped = drive(drilled.state, drilled.ui, current, ["escape"]);
		expect(popped.state.runStack).toEqual([PARENT]);
		expect(popped.state.tab).toBe("tasks");
		expect(popped.state.selectedTaskId).toBe("task_child");
		expect(popped.ui.selectedTask).toBe(2);
		expect(popped.effects).toEqual([{ type: "load-detail", runId: PARENT }]);
		// `o` on a task without a child run is a no-op.
		const noChild = drive(state, ui, current, ["right", { char: "o" }]);
		expect(noChild.state.runStack).toEqual([PARENT]);
	});

	it("toggles help from any non-input screen", () => {
		const state = detailState();
		const ui = initialInspectorUiState(state);
		const opened = drive(state, ui, data({ inspection: inspection() }), [
			{ char: "?" },
		]);
		expect(opened.ui.screen).toBe("help");
		const closed = drive(opened.state, opened.ui, data(), [{ char: "?" }]);
		expect(closed.ui.screen).toBe("detail");
		const escaped = drive(opened.state, opened.ui, data(), ["escape"]);
		expect(escaped.ui.screen).toBe("detail");
	});

	it("refreshes the list and the displayed run on r", () => {
		const state = detailState();
		const ui = initialInspectorUiState(state);
		expect(drive(state, ui, data(), [{ char: "r" }]).effects).toEqual([
			{ type: "load-runs" },
			{ type: "load-detail", runId: PARENT },
		]);
	});

	it("opens the palette with exactly the service's actions and runs reconcile without confirmation", () => {
		const state = detailState();
		const ui = initialInspectorUiState(state);
		const current = data({ inspection: inspection() });
		const palette = drive(state, ui, current, ["space"]);
		expect(palette.ui.screen).toBe("actions");
		expect(currentActions(palette.state, palette.ui, current)).toEqual([
			"invalidate",
			"reconcile",
			"stop",
		]);
		const reconciled = drive(palette.state, palette.ui, current, [
			"down",
			"enter",
		]);
		expect(doneIntent(reconciled.effects)).toEqual({
			type: "action",
			state: reconciled.state,
			confirmed: true,
			request: { action: "reconcile", run: current.inspection?.run },
		});
	});

	it("confirms stop, collects a reason, and emits the confirmed request", () => {
		const state = detailState();
		const ui = initialInspectorUiState(state);
		const current = data({ inspection: inspection() });
		const confirm = drive(state, ui, current, [
			"space",
			"down",
			"down",
			"enter",
		]);
		expect(confirm.ui).toMatchObject({
			screen: "confirm",
			pendingAction: "stop",
		});
		expect(
			confirmBody(confirm.state, confirm.ui, current, PLAIN_LINE_THEME),
		).toMatchObject({ title: `Confirm stop · workflow_par…` });
		const input = drive(confirm.state, confirm.ui, current, ["enter"]);
		expect(input.ui.screen).toBe("input");
		expect(input.effects).toEqual([
			{ type: "open-input", initial: DEFAULT_STOP_REASON },
		]);
		const defaulted = drive(input.state, input.ui, current, [{ submit: "  " }]);
		expect(doneIntent(defaulted.effects)).toMatchObject({
			type: "action",
			confirmed: true,
			request: { action: "stop", reason: DEFAULT_STOP_REASON },
		});
		const custom = drive(input.state, input.ui, current, [
			{ submit: "operator requested" },
		]);
		expect(doneIntent(custom.effects)).toMatchObject({
			request: { action: "stop", reason: "operator requested" },
		});
		const cancelled = drive(input.state, input.ui, current, ["escape"]);
		expect(cancelled.ui.screen).toBe("actions");
		const backedOut = drive(confirm.state, confirm.ui, current, ["escape"]);
		expect(backedOut.ui.screen).toBe("actions");
	});

	it("picks a live task for invalidate, ignores abandoned rows, previews, and emits taskId", () => {
		const state = detailState();
		const ui = initialInspectorUiState(state);
		const current = data({ inspection: inspection() });
		const picker = drive(state, ui, current, ["space", "enter"]);
		expect(picker.ui).toMatchObject({
			screen: "task-picker",
			pendingAction: "invalidate",
		});
		expect(
			taskPickerBody(
				picker.state,
				picker.ui,
				current,
				100,
				PLAIN_LINE_THEME,
			).join("\n"),
		).toContain("legacy/old");
		// Row 3 is the abandoned task: enter is ignored there.
		const abandoned = drive(picker.state, picker.ui, current, [
			"down",
			"down",
			"down",
			"enter",
		]);
		expect(abandoned.ui.screen).toBe("task-picker");
		expect(abandoned.ui.pendingTaskId).toBeUndefined();
		const chosen = drive(picker.state, picker.ui, current, ["enter"]);
		expect(chosen.ui).toMatchObject({
			screen: "confirm",
			pendingTaskId: "task_report",
		});
		expect(chosen.effects).toEqual([
			{ type: "load-preview", runId: PARENT, taskId: "task_report" },
		]);
		const previewed = data({
			inspection: inspection(),
			preview: REPORT_PREVIEW,
		});
		const body = confirmBody(
			chosen.state,
			chosen.ui,
			previewed,
			PLAIN_LINE_THEME,
		);
		expect(body.title).toBe("Confirm invalidate · workflow_par…");
		expect(body.body).toContain("Task: report");
		expect(body.body).toContain(
			"2 task(s) re-execute as new generations: report, summary.",
		);
		const emitted = drive(chosen.state, chosen.ui, previewed, [
			"enter",
			{ submit: "" },
		]);
		expect(doneIntent(emitted.effects)).toMatchObject({
			type: "action",
			confirmed: true,
			request: {
				action: "invalidate",
				taskId: "task_report",
				reason: DEFAULT_INVALIDATE_REASON,
			},
		});
	});

	it("scopes the palette to the selected task from the task tab", () => {
		const state = detailState();
		const ui = initialInspectorUiState(state);
		const current = data({ inspection: inspection() });
		const scoped = drive(state, ui, current, ["right", "enter", "space"]);
		expect(scoped.ui).toMatchObject({
			paletteScope: "task",
			pendingTaskId: "task_report",
		});
		expect(currentActions(scoped.state, scoped.ui, current)).toEqual([
			"invalidate",
			"reconcile",
		]);
		const confirm = drive(scoped.state, scoped.ui, current, ["enter"]);
		expect(confirm.ui.screen).toBe("confirm");
		expect(confirm.effects).toEqual([
			{ type: "load-preview", runId: PARENT, taskId: "task_report" },
		]);
		// An abandoned task offers nothing, so enter cannot start anything.
		const abandoned = drive(state, ui, current, [
			"right",
			"down",
			"down",
			"down",
			"enter",
			"space",
			"enter",
		]);
		expect(currentActions(abandoned.state, abandoned.ui, current)).toEqual([]);
		expect(abandoned.ui.screen).toBe("actions");
		expect(doneIntent(abandoned.effects)).toBeUndefined();
		expect(
			actionsBody(abandoned.state, abandoned.ui, current, PLAIN_LINE_THEME),
		).toEqual(["No actions are available for this run."]);
	});

	it("shows an empty palette for a run leased elsewhere", () => {
		const leased = inspection({
			run: summary("running", {
				ownership: "leased-elsewhere",
				leasedElsewhere: true,
			}),
		});
		const state = detailState();
		const ui = initialInspectorUiState(state);
		const current = data({ inspection: leased });
		const palette = drive(state, ui, current, ["space"]);
		expect(currentActions(palette.state, palette.ui, current)).toEqual([]);
		expect(
			actionsBody(palette.state, palette.ui, current, PLAIN_LINE_THEME),
		).toEqual(["No actions: this run is leased by another Pi process."]);
		const lines = detailBody(state, ui, current, 80, PLAIN_LINE_THEME, NOW);
		expect(lines).toContain("Leased by another Pi process · read-only");
		expect(lines.join("\n")).toContain("leased elsewhere (no actions)");
	});
});

describe("checkpoint decide entry", () => {
	const decidedAt = "2026-09-15T12:04:30.000Z";
	const checkpointTask = (
		overrides: Partial<WorkflowServiceTaskView["checkpoint"]> = {},
	): WorkflowServiceTaskView =>
		task({
			id: "task_approve",
			namespace: ["review"],
			key: "approve",
			kind: "checkpoint",
			status: "waiting",
			executionId: "execution_approve1",
			checkpoint: {
				prompt: "Approve the release plan?",
				schema: {
					type: "object",
					properties: {
						proceed: { type: "boolean" },
						note: { type: "string" },
					},
					required: ["proceed"],
				},
				headless: "block",
				requestedAt: "2026-09-15T12:03:00.000Z",
				expiresAt: "2026-09-15T12:30:00.000Z",
				inputs: { plan: "Ship v2 on Friday.", risk: { level: "low" } },
				...overrides,
			},
		});

	/** A parked run: the checkpoint task is the last of six. */
	const parked = (
		checkpoint: WorkflowServiceTaskView = checkpointTask(),
		actions: WorkflowRunSummary["availableActions"] = [
			"wait",
			"stop",
			"decide",
		],
	) =>
		inspection({
			run: summary("waiting", {
				availableActions: actions,
				pendingCheckpointCount: 1,
			}),
			tasks: [...TASKS, checkpoint],
		});

	it("offers the decide entry only while availableActions carries decide", () => {
		expect(INSPECTOR_ACTION_LABELS.decide).toBe("Decide a checkpoint");
		const state = detailState();
		const ui = initialInspectorUiState(state);
		const current = data({ inspection: parked() });
		const palette = drive(state, ui, current, ["space"]);
		expect(currentActions(palette.state, palette.ui, current)).toEqual([
			"stop",
			"decide",
		]);
		expect(
			actionsBody(palette.state, palette.ui, current, PLAIN_LINE_THEME),
		).toEqual(["› Stop run", "  Decide a checkpoint"]);
		// The same run once the service stops offering it.
		const running = data({
			inspection: parked(checkpointTask(), ["wait", "stop"]),
		});
		const without = drive(state, ui, running, ["space"]);
		expect(currentActions(without.state, without.ui, running)).toEqual([
			"stop",
		]);
		// Task scope: only the checkpoint still awaiting a decision offers it.
		const run = parked().run;
		expect(taskActions(run, checkpointTask())).toEqual(["decide"]);
		expect(taskActions(run, task())).toEqual([]);
		expect(
			taskActions(
				run,
				checkpointTask({
					decision: {
						source: "operator",
						decidedBy: "pi-session",
						decidedAt,
						sha256: "a".repeat(64),
						value: { proceed: true },
					},
				}),
			),
		).toEqual([]);
		// A checkpoint whose request is not durable yet is not answerable.
		expect(
			taskActions(run, {
				checkpoint: {
					prompt: "Approve the release plan?",
					schema: { type: "boolean" },
					headless: "block",
				},
			}),
		).toEqual([]);
	});

	it("picks the waiting checkpoint and resolves a decide intent for the caller", () => {
		const state = detailState();
		const ui = initialInspectorUiState(state);
		const current = data({ inspection: parked() });
		const run = current.inspection?.run;
		// decide is the second entry; it needs a task, so the picker opens
		// even though the form - not the inspector - confirms the decision.
		const picker = drive(state, ui, current, ["space", "down", "enter"]);
		expect(picker.ui).toMatchObject({
			screen: "task-picker",
			pendingAction: "decide",
			selectedTask: 5,
		});
		expect(doneIntent(picker.effects)).toBeUndefined();
		expect(
			taskPickerBody(
				picker.state,
				picker.ui,
				current,
				100,
				PLAIN_LINE_THEME,
			)[0],
		).toContain("only a checkpoint awaiting a decision can be selected");
		// A task with no pending checkpoint is visible but never selectable.
		const other = drive(picker.state, picker.ui, current, ["up", "enter"]);
		expect(other.ui.screen).toBe("task-picker");
		expect(other.ui.pendingTaskId).toBeUndefined();
		expect(doneIntent(other.effects)).toBeUndefined();
		const chosen = drive(picker.state, picker.ui, current, ["enter"]);
		expect(doneIntent(chosen.effects)).toEqual({
			type: "decide",
			state: chosen.state,
			run,
			taskId: "task_approve",
			request: { action: "decide", run, taskId: "task_approve" },
		});
		// No confirm screen: the guided form carries its own.
		expect(chosen.ui.screen).toBe("task-picker");
		expect(
			chosen.effects.some((effect) => effect.type === "load-preview"),
		).toBe(false);
	});

	it("resolves the decide intent directly from the task tab scope", () => {
		const state = detailState();
		const ui = initialInspectorUiState(state);
		const current = data({ inspection: parked() });
		const scoped = drive(state, ui, current, [
			"right",
			"down",
			"down",
			"down",
			"down",
			"down",
			"enter",
			"space",
		]);
		expect(scoped.ui).toMatchObject({
			paletteScope: "task",
			pendingTaskId: "task_approve",
		});
		expect(currentActions(scoped.state, scoped.ui, current)).toEqual([
			"decide",
		]);
		const emitted = drive(scoped.state, scoped.ui, current, ["enter"]);
		expect(doneIntent(emitted.effects)).toMatchObject({
			type: "decide",
			run: { runId: PARENT },
			taskId: "task_approve",
			request: { action: "decide", taskId: "task_approve" },
		});
	});

	it("renders the pending checkpoint in the run and task detail, bounded", () => {
		const current = data({ inspection: parked() });
		const overview = detailBody(
			detailState(),
			initialInspectorUiState(detailState()),
			current,
			100,
			PLAIN_LINE_THEME,
			NOW,
		);
		const text = overview.join("\n");
		expect(text).toContain("Checkpoint");
		expect(text).toMatch(/Task key\s+review\/approve/);
		expect(text).toContain("Approve the release plan?");
		expect(text).toMatch(/Answer\s+\{ proceed: boolean, note\?: string \}/);
		expect(text).toContain("plan:");
		expect(text).toContain("  Ship v2 on Friday.");
		expect(text).toContain('  "level": "low"');
		for (const line of overview) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		}
		// A run with nothing pending says nothing about checkpoints.
		expect(
			detailBody(
				detailState(),
				initialInspectorUiState(detailState()),
				data({ inspection: inspection() }),
				100,
				PLAIN_LINE_THEME,
				NOW,
			).join("\n"),
		).not.toContain("Checkpoint");
		const detail = detailBody(
			detailState({ tab: "task", selectedTaskId: "task_approve" }),
			initialInspectorUiState(detailState()),
			current,
			100,
			PLAIN_LINE_THEME,
			NOW,
		).join("\n");
		expect(detail).toContain("Approve the release plan?");
		expect(detail).toMatch(/Answer\s+\{ proceed: boolean, note\?: string \}/);
		expect(detail).toMatch(/Decision\s+awaiting a person · space to decide/);
		expect(detail).toContain("Decide a checkpoint");
		// A long prompt and large inputs are cut, never unbounded.
		const wordy = data({
			inspection: parked(
				checkpointTask({
					prompt: Array.from(
						{ length: 40 },
						(_, index) => `line ${index}`,
					).join("\n"),
					inputs: { draft: "x".repeat(8_000) },
				}),
			),
		});
		const cut = detailBody(
			detailState({ tab: "task", selectedTaskId: "task_approve" }),
			initialInspectorUiState(detailState()),
			wordy,
			100,
			PLAIN_LINE_THEME,
			NOW,
		);
		expect(cut.join("\n")).toContain("line 7");
		expect(cut.join("\n")).not.toContain("line 8");
		expect(cut.join("\n")).toContain("line(s) · /workflow show");
		expect(cut.join("\n")).toContain("input cut at 2048 bytes");
		for (const line of cut) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		}
		expect(cut.length).toBeLessThan(60);
	});
});

describe("invalidation preview", () => {
	it("renders the service's closure and never computes one itself", async () => {
		expect(invalidateConsequence(REPORT_PREVIEW)).toBe(
			"2 task(s) re-execute as new generations: report, summary. 1 epoch(s) after the exposing barrier are abandoned, retiring 0 declaration(s). Effects after that barrier are marked abandoned.",
		);
		expect(
			invalidateConsequence({
				taskIds: Array.from({ length: 8 }, (_, index) => `task_${index}`),
				taskKeys: Array.from({ length: 8 }, (_, index) => `/t${index}`),
				abandonedEpochs: [],
				abandonedTaskIds: [],
			}),
		).toBe(
			"8 task(s) re-execute as new generations: t0, t1, t2, t3, t4, t5, +2 more. 0 epoch(s) after the exposing barrier are abandoned, retiring 0 declaration(s). Effects after that barrier are marked abandoned.",
		);
		// The inspector module carries no closure logic: no dependency walk,
		// no barrier scan, and no generation bound of its own.
		const source = await readFile(
			path.resolve("src", "ui", "inspector.ts"),
			"utf8",
		);
		expect(source).not.toMatch(/MAX_TASK_EXECUTION_GENERATIONS|>= ?16\b/);
		expect(source).not.toMatch(
			/invalidationClosure|transitiveDependents|invalidationPreviewFromInspection/,
		);
	});

	it("shows the service's refusal on the confirm screen", () => {
		const state = detailState();
		const ui = initialInspectorUiState(state);
		const refused = data({
			inspection: inspection(),
			preview: {
				taskIds: [],
				taskKeys: [],
				abandonedEpochs: [],
				abandonedTaskIds: [],
				refusal: "invalidation cause is already invalidated",
			},
		});
		const chosen = drive(state, ui, refused, ["space", "enter", "enter"]);
		expect(chosen.ui.screen).toBe("confirm");
		const body = confirmBody(
			chosen.state,
			chosen.ui,
			refused,
			PLAIN_LINE_THEME,
		);
		expect(body.body).toContain(
			"The service will refuse: invalidation cause is already invalidated.",
		);
	});
});

describe("detail rendering", () => {
	it("renders generations, finalizer markers, abandoned rows, and child arrows", () => {
		const state = detailState({ tab: "tasks" });
		const ui = initialInspectorUiState(state);
		const lines = detailBody(
			state,
			ui,
			data({ inspection: inspection() }),
			120,
			PLAIN_LINE_THEME,
			NOW,
		);
		const text = lines.join("\n");
		expect(text).toContain("gen 3/16");
		expect(text).toContain("4 live · 1 abandoned");
		expect(text).toContain("→ workflow_chi…");
		expect(text).toContain("legacy/old");
		expect(text).toContain("· abandoned");
		expect(lines.some((line) => line.startsWith(" F "))).toBe(true);
		const summaryRow = lines.find((line) => line.includes("summary"));
		expect(summaryRow).not.toContain("gen ");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(120);
		}
	});

	it("renders the task drill-down with generations and attempts", () => {
		const state = detailState({ tab: "task", selectedTaskId: "task_report" });
		const ui = initialInspectorUiState(state);
		const text = detailBody(
			state,
			ui,
			data({ inspection: inspection() }),
			100,
			PLAIN_LINE_THEME,
			NOW,
		).join("\n");
		expect(text).toContain("gen 3/16");
		expect(text).toContain("#2 retry receipted · failed");
		expect(text).toContain("provider-error (manual)");
		expect(text).toContain("Invalidate a task and its dependents");
		const abandoned = detailBody(
			detailState({ tab: "task", selectedTaskId: "task_old" }),
			ui,
			data({ inspection: inspection() }),
			100,
			PLAIN_LINE_THEME,
			NOW,
		).join("\n");
		expect(abandoned).toContain("completed · abandoned");
		expect(abandoned).toMatch(/Actions\s+abandoned/);
	});

	it("renders the overview, activity, and technical tabs from persisted views", () => {
		const current = data({
			inspection: inspection(),
			logs: {
				runId: PARENT,
				entries: [
					{
						sequence: 1,
						timestamp: "2026-09-15T12:00:00.000Z",
						kind: "run",
						status: "running",
						message: "Run status changed from created to running.",
					},
				],
				lastSequence: 12,
			},
			issues: [
				{
					directory: "broken",
					kind: "corrupt-journal",
					message: "Journal is corrupt.",
				},
			],
		});
		const ui = initialInspectorUiState(detailState());
		const overview = detailBody(
			detailState(),
			ui,
			current,
			100,
			PLAIN_LINE_THEME,
			NOW,
		).join("\n");
		expect(overview).toMatch(/Status\s+failed · needs action/);
		expect(overview).toMatch(
			/Tasks\s+2\/5 completed · 0 running · 1 failed · 1 abandoned/,
		);
		expect(overview).toContain("$1.2500 of $5.0000 · 12k tok · 3m 05s");
		expect(overview).toMatch(/Actions\s+wait, invalidate, reconcile, stop/);
		const activity = detailBody(
			detailState({ tab: "activity" }),
			ui,
			current,
			100,
			PLAIN_LINE_THEME,
			NOW,
		).join("\n");
		expect(activity).toContain("Run status changed from created to running.");
		expect(activity).toContain("Showing 1 of seq 12");
		const technical = detailBody(
			detailState({ tab: "technical" }),
			ui,
			current,
			100,
			PLAIN_LINE_THEME,
			NOW,
		).join("\n");
		expect(technical).toContain("epoch 2 final ×1");
		expect(technical).toContain("epoch 1 results ×1 abandoned");
		expect(technical).toContain("corrupt-journal broken: Journal is corrupt.");
	});

	it("marks leased runs in the list and bounds every row", () => {
		const state = initialInspectorState();
		const ui = initialInspectorUiState(state);
		const runs = [
			summary("running", {
				ownership: "leased-elsewhere",
				leasedElsewhere: true,
				definitionName:
					"a-deliberately-long-definition-name-for-narrow-terminals",
			}),
		];
		for (const width of [30, 60, 120]) {
			const lines = runsBody(
				state,
				ui,
				data({ runs, total: 1 }),
				width,
				PLAIN_LINE_THEME,
				NOW,
			);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			expect(lines.join("\n")).toContain("⇄");
			expect(lines.join("\n")).toContain("leased elsewhere · read-only");
		}
		expect(runsBody(state, ui, data(), 80, PLAIN_LINE_THEME, NOW)).toContain(
			"No workflow runs in this project.",
		);
	});
});

describe("terminal width helpers", () => {
	it("bounds truncated, padded, and key-value output to the width", () => {
		const wide =
			"定義名が非常に長いワークフロー definition name that keeps going";
		for (const width of [1, 5, 12, 40]) {
			expect(visibleWidth(truncate(wide, width))).toBeLessThanOrEqual(width);
			expect(visibleWidth(pad(wide, width))).toBe(width);
			expect(visibleWidth(pad("x", width))).toBe(width);
			expect(
				visibleWidth(keyValue("Definition", wide, width)),
			).toBeLessThanOrEqual(width);
		}
		expect(truncate("short", 10)).toBe("short");
		expect(pad("ab", 4)).toBe("ab  ");
		expect(keyValue("Status", "running", 40)).toBe("Status     running");
	});
});

describe("text fallback", () => {
	it("formats the run list and the run detail as bounded text", () => {
		const page: WorkflowRunPage = {
			runs: [summary("failed", { availableActions: ["invalidate", "stop"] })],
			total: 3,
			nextCursor: "next",
			issues: [
				{ directory: "broken", kind: "unreadable", message: "unreadable" },
			],
			issuesTruncated: 2,
			generatedAt: "2026-09-15T12:05:00.000Z",
		};
		expect(formatRunList(page)).toBe(
			[
				"  ● failed             workflow_parent000000001 release [invalidate, stop]",
				"1 of 3 run(s) · more available",
				"3 issue(s)",
			].join("\n"),
		);
		expect(
			formatRunList({ ...page, runs: [], issues: [], issuesTruncated: 0 }),
		).toBe("No workflow runs.");
		const detail = formatRunDetail(inspection());
		expect(detail.split("\n").slice(0, 4)).toEqual([
			"failed             workflow_parent000000001",
			"definition: release",
			"ownership: inactive",
			"depth: 0",
		]);
		expect(detail).toContain("actions: wait, invalidate, reconcile, stop");
		expect(detail).toContain("gen 3/16");
		expect(detail).toContain("legacy/old");
		const wide = formatRunDetail(
			inspection({ tasks: [task({ key: "k".repeat(1000) })] }),
		);
		for (const line of wide.split("\n")) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(200);
		}
	});
});

describe("showWorkflowInspector", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function fakeContext(
		script: (component: {
			render(width: number): string[];
			handleInput(input: string): void;
		}) => Promise<void> | void,
		rendered: string[][],
	): ExtensionContext {
		const theme = PLAIN_LINE_THEME;
		return {
			ui: {
				theme,
				custom: async (
					factory: (
						tui: { requestRender(): void },
						themeValue: typeof theme,
						keybindings: object,
						done: (value: unknown) => void,
					) => {
						render(width: number): string[];
						handleInput(input: string): void;
						dispose?(): void;
					},
				) => {
					let result: unknown;
					const component = factory(
						{ requestRender() {} },
						theme,
						{},
						(value: unknown) => {
							result = value;
						},
					);
					const recording = {
						render(width: number) {
							const lines = component.render(width);
							rendered.push(lines);
							return lines;
						},
						handleInput(input: string) {
							component.handleInput(input);
						},
					};
					await script(recording);
					component.dispose?.();
					return result;
				},
			},
		} as unknown as ExtensionContext;
	}

	it("renders bounded lines, resolves close on escape, and releases its subscription and clock", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const unsubscribe = vi.fn();
		const runs = [
			summary("running", {
				definitionName:
					"an-intentionally-long-definition-name-for-a-narrow-view",
			}),
		];
		const service = {
			listRuns: vi.fn(async () => ({
				runs,
				total: 1,
				issues: [],
				issuesTruncated: 0,
				generatedAt: "2026-09-15T12:05:00.000Z",
			})),
			inspect: vi.fn(),
			logs: vi.fn(),
			subscribe: vi.fn(() => unsubscribe),
		} as unknown as InspectorService;
		const rendered: string[][] = [];
		const ctx = fakeContext((component) => {
			component.render(60);
			component.handleInput("");
		}, rendered);
		const intent = await showWorkflowInspector(ctx, service);
		expect(intent).toMatchObject({ type: "close" });
		expect(rendered).toHaveLength(1);
		for (const line of rendered[0] ?? []) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}
		expect(rendered[0]?.join("\n")).toContain("Workflows · all");
		expect(service.listRuns).toHaveBeenCalledWith({ limit: 50 });
		expect(service.subscribe).toHaveBeenCalledTimes(1);
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("opens on a run detail, loads its inspection and logs, and pops back to the list", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const service = {
			listRuns: vi.fn(async () => ({
				runs: [summary("failed")],
				total: 1,
				issues: [],
				issuesTruncated: 0,
				generatedAt: "2026-09-15T12:05:00.000Z",
			})),
			inspect: vi.fn(async () => inspection()),
			logs: vi.fn(async () => ({
				runId: PARENT,
				entries: [],
				lastSequence: 12,
			})),
			subscribe: vi.fn(() => () => {}),
		} as unknown as InspectorService;
		const rendered: string[][] = [];
		const ctx = fakeContext((component) => {
			component.render(100);
			component.handleInput("");
			component.render(100);
			component.handleInput("");
		}, rendered);
		const intent = await showWorkflowInspector(ctx, service, {
			initialState: {
				view: "detail",
				runStack: [PARENT],
				includeChildren: true,
			},
		});
		expect(intent).toMatchObject({ type: "close" });
		expect(service.inspect).toHaveBeenCalledWith(PARENT, {
			include: [
				"run",
				"budget",
				"tasks",
				"executions",
				"barriers",
				"artifacts",
			],
		});
		expect(service.logs).toHaveBeenCalledWith(PARENT, { limit: 500 });
		expect(service.listRuns).toHaveBeenCalledWith({
			includeChildren: true,
			limit: 50,
		});
		expect(rendered[0]?.join("\n")).toContain(
			"release · failed · workflow_par…",
		);
		expect(rendered[1]?.join("\n")).toContain(
			"Workflows · all · with children",
		);
		for (const lines of rendered) {
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(100);
			}
		}
		expect(vi.getTimerCount()).toBe(0);
	});

	it("uses the service's invalidation preview when it offers one", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const previewInvalidation = vi.fn(async () => ({
			taskIds: ["task_report", "task_summary"],
			taskKeys: ["/report", "/summary"],
			abandonedEpochs: [2],
			abandonedTaskIds: ["task_late"],
		}));
		const service = {
			listRuns: vi.fn(async () => ({
				runs: [summary("failed")],
				total: 1,
				issues: [],
				issuesTruncated: 0,
				generatedAt: "2026-09-15T12:05:00.000Z",
			})),
			inspect: vi.fn(async () => inspection()),
			logs: vi.fn(async () => ({
				runId: PARENT,
				entries: [],
				lastSequence: 12,
			})),
			subscribe: vi.fn(() => () => {}),
			previewInvalidation,
		} as unknown as InspectorService;
		const rendered: string[][] = [];
		const ctx = fakeContext(async (component) => {
			component.handleInput(" "); // palette
			component.handleInput("\r"); // invalidate → task picker
			component.handleInput("\r"); // choose report → preview + confirm
			await Promise.resolve();
			await Promise.resolve();
			component.render(120);
			component.handleInput("\r"); // reason input
			component.handleInput("\r"); // submit default reason
		}, rendered);
		const intent = await showWorkflowInspector(ctx, service, {
			view: "detail",
			runStack: [PARENT],
		});
		expect(previewInvalidation).toHaveBeenCalledWith(PARENT, "task_report");
		expect(rendered.at(-1)?.join("\n")).toContain("retiring 1 declaration(s)");
		expect(intent).toMatchObject({
			type: "action",
			confirmed: true,
			request: {
				action: "invalidate",
				taskId: "task_report",
				reason: DEFAULT_INVALIDATE_REASON,
			},
		});
		expect(vi.getTimerCount()).toBe(0);
	});
});
