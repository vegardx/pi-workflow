import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	WorkflowRunPage,
	WorkflowRunSummary,
} from "../src/service-views.js";
import {
	createWidgetController,
	firstParkedOwnedRun,
	WORKFLOW_WIDGET_DEBOUNCE_MS,
	WORKFLOW_WIDGET_KEY,
	WORKFLOW_WIDGET_LIMIT,
	WORKFLOW_WIDGET_PARKED_PREFIX,
	WORKFLOW_WIDGET_POLL_MS,
	WORKFLOW_WIDGET_STATUSES,
	WORKFLOW_WIDGET_WIDTH,
	widgetNeedsPolling,
	workflowWidgetLines,
} from "../src/ui/widget.js";

let counter = 0;

function summary(
	status: WorkflowRunSummary["status"],
	overrides: Partial<WorkflowRunSummary> = {},
): WorkflowRunSummary {
	counter += 1;
	return {
		runId: `workflow_widget${counter.toString().padStart(4, "0")}`,
		definitionName: "example",
		status,
		createdAt: "2026-09-15T00:00:00.000Z",
		updatedAt: "2026-09-15T00:00:01.000Z",
		deadlineAt: "2026-09-16T00:00:00.000Z",
		depth: 0,
		lastSequence: 1,
		taskCounts: {
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
		},
		ownership: "inactive",
		leasedElsewhere: false,
		pendingCheckpointCount: 0,
		requiresAttention:
			status === "failed" ||
			status === "interrupted" ||
			status === "cleanup-blocked",
		...overrides,
		availableActions: overrides.availableActions ?? [],
	};
}

/** A run this session owns, waiting for a decision it may record. */
function parked(
	overrides: Partial<WorkflowRunSummary> = {},
): WorkflowRunSummary {
	return summary("waiting", {
		ownership: "owned",
		pendingCheckpointCount: 1,
		availableActions: ["decide"],
		...overrides,
	});
}

/** The `include: ["tasks"]` inspection of a run parked at one checkpoint. */
function inspection(prompt: string, executionId = "execution-1"): unknown {
	return {
		run: parked(),
		tasks: [
			{
				id: "task-done",
				namespace: [],
				key: "plan",
				kind: "agent",
				role: "task",
				disposition: "required",
				status: "completed",
				generation: 1,
			},
			{
				id: "task-checkpoint",
				namespace: ["phase-1"],
				key: "approve",
				kind: "checkpoint",
				role: "task",
				disposition: "required",
				status: "waiting",
				generation: 1,
				executionId,
				checkpoint: { prompt, schema: { type: "boolean" }, headless: "block" },
			},
		],
		truncated: {},
	};
}

function page(runs: WorkflowRunSummary[]): WorkflowRunPage {
	return {
		runs,
		total: runs.length,
		issues: [],
		issuesTruncated: 0,
		generatedAt: "2026-09-15T00:00:00.000Z",
	};
}

describe("workflow widget lines", () => {
	it("hides when nothing is ongoing or needs attention", () => {
		expect(WORKFLOW_WIDGET_KEY).toBe("pi-workflow");
		expect(workflowWidgetLines([])).toBeUndefined();
		expect(
			workflowWidgetLines([
				summary("completed"),
				summary("completed-degraded"),
				summary("cancelled"),
			]),
		).toBeUndefined();
	});

	it("renders ongoing counts in a fixed order with the shortcut on the last line", () => {
		expect(workflowWidgetLines([summary("running")])).toEqual([
			"workflows ongoing: 1 running · alt+w",
		]);
		expect(
			workflowWidgetLines([
				summary("created"),
				summary("stopping"),
				summary("waiting"),
				summary("finalizing"),
				summary("running"),
				summary("running"),
			]),
		).toEqual([
			"workflows ongoing: 2 running · 1 waiting · 1 finalizing · 1 stopping · 1 created · alt+w",
		]);
	});

	it("renders attention counts only for runs that require attention", () => {
		expect(
			workflowWidgetLines([
				summary("cleanup-blocked"),
				summary("interrupted"),
				summary("failed"),
				summary("failed"),
			]),
		).toEqual([
			"workflows need action: 2 failed · 1 interrupted · 1 cleanup blocked · alt+w",
		]);
		// A cleanup-blocked run leased elsewhere still needs attention when the
		// service says so; the widget never decides on its own.
		expect(
			workflowWidgetLines([
				summary("cleanup-blocked", {
					leasedElsewhere: true,
					ownership: "leased-elsewhere",
					requiresAttention: false,
				}),
			]),
		).toBeUndefined();
	});

	it("combines both lines, marks runs leased elsewhere, and counts recovery as ongoing", () => {
		const lines = workflowWidgetLines([
			summary("running", {
				leasedElsewhere: true,
				ownership: "leased-elsewhere",
			}),
			summary("running"),
			summary("failed", { requiresAttention: false }),
			summary("interrupted"),
		]);
		expect(lines).toEqual([
			"workflows ongoing: 2 running · 1 recovering (1 elsewhere)",
			"workflows need action: 1 interrupted · alt+w",
		]);
		expect(lines?.length).toBeLessThanOrEqual(2);
		expect(
			workflowWidgetLines([
				summary("interrupted", { requiresAttention: false }),
			]),
		).toEqual(["workflows ongoing: 1 recovering · alt+w"]);
	});

	it("puts a parked owned run's question first and collapses the counts", () => {
		const runs = [
			summary("running"),
			parked(),
			summary("failed"),
			summary("interrupted"),
		];
		expect(firstParkedOwnedRun(runs)).toBe(runs[1]);
		const lines = workflowWidgetLines(runs, "Approve the plan?");
		expect(lines).toEqual([
			"waiting for you: Approve the plan?",
			"workflows ongoing: 1 running · 1 waiting · workflows need action: 1 failed · 1 interrupted · alt+w",
		]);
		expect(lines?.length).toBeLessThanOrEqual(2);
		// Without the prompt the widget is exactly what it was before.
		expect(workflowWidgetLines(runs)).toEqual([
			"workflows ongoing: 1 running · 1 waiting",
			"workflows need action: 1 failed · 1 interrupted · alt+w",
		]);
	});

	it("selects only an owned run the service offers decide on", () => {
		expect(firstParkedOwnedRun([])).toBeUndefined();
		expect(
			firstParkedOwnedRun([summary("waiting"), summary("running")]),
		).toBeUndefined();
		// Parked, but this session may not decide it: nested child, leased
		// elsewhere, or no checkpoint pending.
		expect(
			firstParkedOwnedRun([
				parked({ availableActions: ["stop"] }),
				parked({ ownership: "leased-elsewhere", leasedElsewhere: true }),
				parked({ pendingCheckpointCount: 0 }),
			]),
		).toBeUndefined();
		const owned = parked();
		expect(
			firstParkedOwnedRun([parked({ ownership: "inactive" }), owned]),
		).toBe(owned);
	});

	it("cuts the question to the widget width and collapses its whitespace", () => {
		const long = "A".repeat(WORKFLOW_WIDGET_WIDTH * 2);
		const lines = workflowWidgetLines([parked()], long);
		const first = lines?.[0] ?? "";
		expect(first.length).toBe(WORKFLOW_WIDGET_WIDTH);
		expect(first.startsWith(`${WORKFLOW_WIDGET_PARKED_PREFIX}AAA`)).toBe(true);
		expect(first.endsWith("…")).toBe(true);
		expect(workflowWidgetLines([parked()], "  Which\n tone?\t ")?.[0]).toBe(
			"waiting for you: Which tone?",
		);
		// A prompt that is only whitespace is no question at all.
		expect(workflowWidgetLines([parked()], "   ")).toEqual([
			"workflows ongoing: 1 waiting · alt+w",
		]);
	});

	it("polls only while a run can change without notifying", () => {
		expect(WORKFLOW_WIDGET_STATUSES).toEqual([
			"created",
			"running",
			"waiting",
			"finalizing",
			"stopping",
			"failed",
			"interrupted",
			"cleanup-blocked",
		]);
		expect(widgetNeedsPolling([])).toBe(false);
		expect(widgetNeedsPolling([summary("failed"), summary("completed")])).toBe(
			false,
		);
		expect(widgetNeedsPolling([summary("running")])).toBe(true);
		expect(widgetNeedsPolling([summary("created")])).toBe(true);
		expect(
			widgetNeedsPolling([summary("failed", { requiresAttention: false })]),
		).toBe(true);
	});
});

describe("workflow widget controller", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function harness(initial: WorkflowRunPage) {
		let current = initial;
		let currentInspection: unknown = inspection("Approve the plan?");
		let listener: (() => void) | undefined;
		const unsubscribe = vi.fn(() => {
			listener = undefined;
		});
		const listRuns = vi.fn(async () => current);
		const inspect = vi.fn(async () => currentInspection);
		const subscribe = vi.fn((next: () => void) => {
			listener = next;
			return unsubscribe;
		});
		const setWidget = vi.fn();
		const controller = createWidgetController({
			service: { listRuns, subscribe, inspect } as never,
			setWidget,
		});
		return {
			controller,
			listRuns,
			inspect,
			subscribe,
			unsubscribe,
			setWidget,
			notify: () => listener?.(),
			set: (next: WorkflowRunPage) => {
				current = next;
			},
			setInspection: (next: unknown) => {
				currentInspection = next;
			},
		};
	}

	it("reads one page on start, subscribes, and stays idle on an empty store", async () => {
		const h = harness(page([]));
		await h.controller.start();
		expect(h.subscribe).toHaveBeenCalledTimes(1);
		expect(h.listRuns).toHaveBeenCalledTimes(1);
		expect(h.listRuns).toHaveBeenCalledWith({
			statuses: [...WORKFLOW_WIDGET_STATUSES],
			limit: WORKFLOW_WIDGET_LIMIT,
		});
		expect(h.setWidget).toHaveBeenCalledWith(undefined);
		expect(h.controller.lastPage).toEqual(page([]));
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(WORKFLOW_WIDGET_POLL_MS * 3);
		expect(h.listRuns).toHaveBeenCalledTimes(1);
		h.controller.stop();
		expect(h.unsubscribe).toHaveBeenCalledTimes(1);
		expect(h.setWidget).toHaveBeenLastCalledWith(undefined);
	});

	it("debounces subscribe events into a single refresh", async () => {
		const h = harness(page([summary("failed")]));
		await h.controller.start();
		expect(h.setWidget).toHaveBeenLastCalledWith([
			"workflows need action: 1 failed · alt+w",
		]);
		h.notify();
		h.notify();
		h.notify();
		expect(h.listRuns).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(WORKFLOW_WIDGET_DEBOUNCE_MS - 1);
		expect(h.listRuns).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.listRuns).toHaveBeenCalledTimes(2);
		// No nonterminal run: nothing polls afterwards.
		await vi.advanceTimersByTimeAsync(WORKFLOW_WIDGET_POLL_MS * 2);
		expect(h.listRuns).toHaveBeenCalledTimes(2);
		h.controller.stop();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("polls only while nonterminal runs exist", async () => {
		const running = summary("running", {
			leasedElsewhere: true,
			ownership: "leased-elsewhere",
		});
		const h = harness(page([running]));
		await h.controller.start();
		expect(h.setWidget).toHaveBeenLastCalledWith([
			"workflows ongoing: 1 running (1 elsewhere) · alt+w",
		]);
		await vi.advanceTimersByTimeAsync(WORKFLOW_WIDGET_POLL_MS);
		expect(h.listRuns).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(WORKFLOW_WIDGET_POLL_MS);
		expect(h.listRuns).toHaveBeenCalledTimes(3);
		h.set(page([]));
		await vi.advanceTimersByTimeAsync(WORKFLOW_WIDGET_POLL_MS);
		expect(h.listRuns).toHaveBeenCalledTimes(4);
		expect(h.setWidget).toHaveBeenLastCalledWith(undefined);
		await vi.advanceTimersByTimeAsync(WORKFLOW_WIDGET_POLL_MS * 4);
		expect(h.listRuns).toHaveBeenCalledTimes(4);
		expect(vi.getTimerCount()).toBe(0);
		// A later event resumes polling when the page is nonterminal again.
		h.set(page([summary("running")]));
		h.notify();
		await vi.advanceTimersByTimeAsync(WORKFLOW_WIDGET_DEBOUNCE_MS);
		expect(h.listRuns).toHaveBeenCalledTimes(5);
		await vi.advanceTimersByTimeAsync(WORKFLOW_WIDGET_POLL_MS);
		expect(h.listRuns).toHaveBeenCalledTimes(6);
		h.controller.stop();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("coalesces overlapping refreshes into one in-flight and one queued read", async () => {
		let release: ((value: WorkflowRunPage) => void) | undefined;
		const listRuns = vi.fn(
			() =>
				new Promise<WorkflowRunPage>((resolve) => {
					release = resolve;
				}),
		);
		const setWidget = vi.fn();
		const controller = createWidgetController({
			service: { listRuns, subscribe: () => () => {} } as never,
			setWidget,
		});
		const started = controller.start();
		const second = controller.refresh();
		const third = controller.refresh();
		expect(listRuns).toHaveBeenCalledTimes(1);
		release?.(page([summary("running")]));
		await vi.advanceTimersByTimeAsync(0);
		expect(listRuns).toHaveBeenCalledTimes(2);
		release?.(page([]));
		await Promise.all([started, second, third]);
		expect(listRuns).toHaveBeenCalledTimes(2);
		expect(setWidget).toHaveBeenLastCalledWith(undefined);
		controller.stop();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops everything and ignores late callbacks after stop", async () => {
		const h = harness(page([summary("running")]));
		await h.controller.start();
		expect(vi.getTimerCount()).toBe(1);
		h.notify();
		expect(vi.getTimerCount()).toBe(2);
		h.controller.stop();
		expect(h.unsubscribe).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		expect(h.setWidget).toHaveBeenLastCalledWith(undefined);
		const calls = h.setWidget.mock.calls.length;
		h.notify();
		await h.controller.refresh();
		await h.controller.start();
		await vi.advanceTimersByTimeAsync(WORKFLOW_WIDGET_POLL_MS * 2);
		expect(h.listRuns).toHaveBeenCalledTimes(1);
		expect(h.setWidget.mock.calls.length).toBe(calls);
		h.controller.stop();
		expect(h.unsubscribe).toHaveBeenCalledTimes(1);
	});

	it("reads a parked run's prompt once and reuses it across polls", async () => {
		const run = parked();
		const h = harness(page([run]));
		await h.controller.start();
		expect(h.inspect).toHaveBeenCalledTimes(1);
		expect(h.inspect).toHaveBeenCalledWith(run.runId, { include: ["tasks"] });
		expect(h.setWidget).toHaveBeenLastCalledWith([
			"waiting for you: Approve the plan?",
			"workflows ongoing: 1 waiting · alt+w",
		]);
		// Polling re-reads the page but never the prompt.
		await vi.advanceTimersByTimeAsync(WORKFLOW_WIDGET_POLL_MS * 3);
		expect(h.listRuns).toHaveBeenCalledTimes(4);
		expect(h.inspect).toHaveBeenCalledTimes(1);
		h.controller.stop();
	});

	it("drops the cached prompt when the run stops waiting and re-reads the next execution", async () => {
		const run = parked();
		const h = harness(page([run]));
		await h.controller.start();
		expect(h.inspect).toHaveBeenCalledTimes(1);
		// Decided: the run drives again and the question is gone.
		h.set(page([summary("running", { runId: run.runId })]));
		await vi.advanceTimersByTimeAsync(WORKFLOW_WIDGET_POLL_MS);
		expect(h.setWidget).toHaveBeenLastCalledWith([
			"workflows ongoing: 1 running · alt+w",
		]);
		expect(h.inspect).toHaveBeenCalledTimes(1);
		// Parked again on a later checkpoint: a new execution, a new prompt.
		h.set(page([run]));
		h.setInspection(inspection("Which tone should the summary use?", "e2"));
		await vi.advanceTimersByTimeAsync(WORKFLOW_WIDGET_POLL_MS);
		expect(h.inspect).toHaveBeenCalledTimes(2);
		expect(h.setWidget).toHaveBeenLastCalledWith([
			"waiting for you: Which tone should the summary use?",
			"workflows ongoing: 1 waiting · alt+w",
		]);
		h.controller.stop();
	});

	it("keeps the counts when the prompt cannot be read", async () => {
		const h = harness(page([parked()]));
		h.inspect.mockRejectedValueOnce(new Error("run unavailable"));
		await h.controller.start();
		expect(h.setWidget).toHaveBeenLastCalledWith([
			"workflows ongoing: 1 waiting · alt+w",
		]);
		// Nothing was cached, so the next refresh asks again and succeeds.
		await vi.advanceTimersByTimeAsync(WORKFLOW_WIDGET_POLL_MS);
		expect(h.inspect).toHaveBeenCalledTimes(2);
		expect(h.setWidget).toHaveBeenLastCalledWith([
			"waiting for you: Approve the plan?",
			"workflows ongoing: 1 waiting · alt+w",
		]);
		h.controller.stop();
	});

	it("shows the counts alone when the inspection carries no waiting checkpoint", async () => {
		const h = harness(page([parked()]));
		h.setInspection({ run: parked(), tasks: [], truncated: {} });
		await h.controller.start();
		expect(h.setWidget).toHaveBeenLastCalledWith([
			"workflows ongoing: 1 waiting · alt+w",
		]);
		// The empty read is cached like any other: polling does not retry it.
		await vi.advanceTimersByTimeAsync(WORKFLOW_WIDGET_POLL_MS * 2);
		expect(h.inspect).toHaveBeenCalledTimes(1);
		h.controller.stop();
	});

	it("hides the widget and stops polling when a refresh fails, then retries on the next event", async () => {
		const h = harness(page([summary("running")]));
		await h.controller.start();
		expect(vi.getTimerCount()).toBe(1);
		h.listRuns.mockRejectedValueOnce(new Error("store unavailable"));
		await vi.advanceTimersByTimeAsync(WORKFLOW_WIDGET_POLL_MS);
		expect(h.listRuns).toHaveBeenCalledTimes(2);
		expect(h.setWidget).toHaveBeenLastCalledWith(undefined);
		expect(vi.getTimerCount()).toBe(0);
		expect(h.controller.lastPage?.runs).toHaveLength(1);
		h.notify();
		await vi.advanceTimersByTimeAsync(WORKFLOW_WIDGET_DEBOUNCE_MS);
		expect(h.listRuns).toHaveBeenCalledTimes(3);
		expect(h.setWidget).toHaveBeenLastCalledWith([
			"workflows ongoing: 1 running · alt+w",
		]);
		expect(vi.getTimerCount()).toBe(1);
		h.controller.stop();
		expect(vi.getTimerCount()).toBe(0);
	});
});
