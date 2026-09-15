import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	IMPLEMENTED_WORKFLOW_RUN_ACTIONS,
	WORKFLOW_RUN_ACTIONS,
} from "../src/run-actions.js";
import type { WorkflowService } from "../src/service.js";
import type {
	WorkflowLogEntry,
	WorkflowRunPage,
	WorkflowRunSummary,
	WorkflowServiceTaskView,
} from "../src/service-views.js";
import {
	ACTION_LABELS,
	actionUnavailableMessage,
	CONFIRMED_ACTIONS,
	collectLogTail,
	DEFAULT_INVALIDATE_REASON,
	DEFAULT_RESUME_REASON,
	DEFAULT_RETRY_REASON,
	DEFAULT_STOP_REASON,
	invalidateConsequence,
	parseWorkflowCommand,
	performRunAction,
	resolveRunPrefix,
	resolveTaskKey,
	WORKFLOW_ACTION_SUBCOMMANDS,
	WORKFLOW_SUBCOMMANDS,
	WorkflowCommandError,
	workflowArgumentCompletions,
} from "../src/ui/commands.js";

function summary(
	status: WorkflowRunSummary["status"],
	overrides: Partial<WorkflowRunSummary> = {},
): WorkflowRunSummary {
	return {
		runId: "workflow_abcdef0123",
		definitionName: "example",
		status,
		createdAt: "2026-09-15T00:00:00.000Z",
		updatedAt: "2026-09-15T00:00:01.000Z",
		deadlineAt: "2026-09-16T00:00:00.000Z",
		depth: 0,
		lastSequence: 3,
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
		requiresAttention: false,
		...overrides,
		// Legality is always stated explicitly by the test.
		availableActions: overrides.availableActions ?? [],
	};
}

function task(
	overrides: Partial<WorkflowServiceTaskView> &
		Pick<WorkflowServiceTaskView, "id" | "key">,
): WorkflowServiceTaskView {
	return {
		namespace: [],
		kind: "agent",
		role: "task",
		disposition: "required",
		status: "completed",
		generation: 1,
		...overrides,
	};
}

function page(
	runs: WorkflowRunSummary[],
	nextCursor?: string,
): WorkflowRunPage {
	return {
		runs,
		...(nextCursor ? { nextCursor } : {}),
		total: runs.length,
		issues: [],
		issuesTruncated: 0,
		generatedAt: "2026-09-15T00:00:00.000Z",
	};
}

function entry(sequence: number): WorkflowLogEntry {
	return {
		sequence,
		timestamp: "2026-09-15T00:00:00.000Z",
		kind: "run",
		message: `event ${sequence}`,
	};
}

const view = (status: string) => ({
	runId: "workflow_abcdef0123",
	status,
	definitionName: "example",
	createdAt: "2026-09-15T00:00:00.000Z",
	deadlineAt: "2026-09-16T00:00:00.000Z",
	depth: 0,
});

function fakeService(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		stop: vi.fn(async () => view("cancelled")),
		wait: vi.fn(async () => view("completed")),
		reconcile: vi.fn(async () => ({ ...view("completed"), reconciled: [{}] })),
		invalidate: vi.fn(async () => view("running")),
		...overrides,
	} as unknown as WorkflowService;
}

describe("/workflow grammar", () => {
	it("derives the action subcommands from the implemented set only", () => {
		const expected = WORKFLOW_RUN_ACTIONS.filter(
			(action) =>
				IMPLEMENTED_WORKFLOW_RUN_ACTIONS.has(action) &&
				action !== "wait" &&
				action !== "decide",
		);
		expect([...WORKFLOW_ACTION_SUBCOMMANDS]).toEqual(expected);
		expect([...WORKFLOW_SUBCOMMANDS]).toEqual([
			"list",
			"runs",
			"validate",
			"run",
			"show",
			"status",
			"logs",
			"wait",
			...expected,
		]);
		expect(WORKFLOW_SUBCOMMANDS).not.toContain("decide");
		for (const action of WORKFLOW_RUN_ACTIONS) {
			if (!IMPLEMENTED_WORKFLOW_RUN_ACTIONS.has(action)) {
				expect(WORKFLOW_SUBCOMMANDS).not.toContain(action);
			}
		}
		expect(Object.isFrozen(WORKFLOW_SUBCOMMANDS)).toBe(true);
		expect(Object.keys(ACTION_LABELS).sort()).toEqual(
			WORKFLOW_RUN_ACTIONS.filter((action) => action !== "decide").sort(),
		);
		expect([...CONFIRMED_ACTIONS].sort()).toEqual([
			"invalidate",
			"resume",
			"retry",
			"stop",
		]);
	});

	it("parses every grammar line", () => {
		expect(parseWorkflowCommand("")).toEqual({ kind: "inspector" });
		expect(parseWorkflowCommand("   ")).toEqual({ kind: "inspector" });
		expect(parseWorkflowCommand("list")).toEqual({ kind: "list" });
		expect(parseWorkflowCommand("runs")).toEqual({
			kind: "runs",
			includeChildren: false,
		});
		expect(parseWorkflowCommand("runs --all")).toEqual({
			kind: "runs",
			includeChildren: true,
		});
		expect(parseWorkflowCommand("validate example")).toEqual({
			kind: "validate",
			ref: "example",
		});
		expect(parseWorkflowCommand('validate example {"a": [1, 2]}')).toEqual({
			kind: "validate",
			ref: "example",
			input: { a: [1, 2] },
		});
		expect(parseWorkflowCommand("run example")).toEqual({
			kind: "run",
			ref: "example",
		});
		expect(
			parseWorkflowCommand('  run   example   { "topic":  "x y" } '),
		).toEqual({
			kind: "run",
			ref: "example",
			input: { topic: "x y" },
		});
		expect(parseWorkflowCommand("show workflow_ab")).toEqual({
			kind: "show",
			runPrefix: "workflow_ab",
		});
		expect(parseWorkflowCommand("status workflow_ab")).toEqual({
			kind: "show",
			runPrefix: "workflow_ab",
		});
		expect(parseWorkflowCommand("logs workflow_ab")).toEqual({
			kind: "logs",
			runPrefix: "workflow_ab",
			tail: 20,
		});
		expect(parseWorkflowCommand("logs workflow_ab --tail 500")).toEqual({
			kind: "logs",
			runPrefix: "workflow_ab",
			tail: 500,
		});
		expect(parseWorkflowCommand("wait workflow_ab")).toEqual({
			kind: "wait",
			runPrefix: "workflow_ab",
		});
		expect(parseWorkflowCommand("wait workflow_ab --timeout 1000")).toEqual({
			kind: "wait",
			runPrefix: "workflow_ab",
			timeoutMs: 1000,
		});
		expect(parseWorkflowCommand("stop workflow_ab")).toEqual({
			kind: "stop",
			runPrefix: "workflow_ab",
		});
		expect(parseWorkflowCommand("stop workflow_ab bad   input here")).toEqual({
			kind: "stop",
			runPrefix: "workflow_ab",
			reason: "bad input here",
		});
		expect(parseWorkflowCommand("reconcile workflow_ab")).toEqual({
			kind: "reconcile",
			runPrefix: "workflow_ab",
		});
		expect(
			parseWorkflowCommand("reconcile workflow_ab phase-1/report"),
		).toEqual({
			kind: "reconcile",
			runPrefix: "workflow_ab",
			taskKey: "phase-1/report",
		});
		expect(parseWorkflowCommand("invalidate workflow_ab report")).toEqual({
			kind: "invalidate",
			runPrefix: "workflow_ab",
			taskKey: "report",
		});
		expect(
			parseWorkflowCommand("invalidate workflow_ab report stale source data"),
		).toEqual({
			kind: "invalidate",
			runPrefix: "workflow_ab",
			taskKey: "report",
			reason: "stale source data",
		});
	});

	it("offers retry and resume only when the build implements them", () => {
		const retry = () => parseWorkflowCommand("retry workflow_ab report");
		const resume = () => parseWorkflowCommand("resume workflow_ab report");
		if (WORKFLOW_ACTION_SUBCOMMANDS.includes("retry")) {
			expect(retry()).toEqual({
				kind: "retry",
				runPrefix: "workflow_ab",
				taskKey: "report",
			});
			expect(
				parseWorkflowCommand("retry workflow_ab report flaky net"),
			).toEqual({
				kind: "retry",
				runPrefix: "workflow_ab",
				taskKey: "report",
				reason: "flaky net",
			});
			expect(() => parseWorkflowCommand("retry workflow_ab")).toThrow(
				"Usage: /workflow retry <run-prefix> <task-key> [reason]",
			);
		} else {
			expect(retry).toThrow(/^Unknown workflow command: retry\./);
		}
		if (WORKFLOW_ACTION_SUBCOMMANDS.includes("resume")) {
			expect(resume()).toEqual({
				kind: "resume",
				runPrefix: "workflow_ab",
				taskKey: "report",
			});
			expect(parseWorkflowCommand("resume workflow_ab")).toEqual({
				kind: "resume",
				runPrefix: "workflow_ab",
			});
			expect(() => parseWorkflowCommand("resume workflow_ab a b")).toThrow(
				"Unexpected arguments for resume.",
			);
		} else {
			expect(resume).toThrow(/^Unknown workflow command: resume\./);
		}
		expect(() => parseWorkflowCommand("decide workflow_ab")).toThrow(
			/^Unknown workflow command: decide\./,
		);
	});

	it("reports every grammar error with its fixed message", () => {
		const fails = (args: string, message: string | RegExp) => {
			let caught: unknown;
			try {
				parseWorkflowCommand(args);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(WorkflowCommandError);
			if (typeof message === "string") {
				expect((caught as Error).message).toBe(message);
			} else {
				expect((caught as Error).message).toMatch(message);
			}
		};
		fails(
			"bogus",
			`Unknown workflow command: bogus. Expected one of ${WORKFLOW_SUBCOMMANDS.join(", ")}.`,
		);
		fails("list extra", "Unexpected arguments for list.");
		fails("runs --children", "Usage: /workflow runs [--all]");
		fails("runs --all more", "Usage: /workflow runs [--all]");
		fails("validate", "Usage: /workflow validate <ref> [json-input]");
		fails("run", "Usage: /workflow run <ref> [json-input]");
		fails("run example {not json", "Workflow input is not valid JSON.");
		fails("validate example [1,", "Workflow input is not valid JSON.");
		for (const subcommand of [
			"show",
			"status",
			"logs",
			"wait",
			"stop",
			"reconcile",
			"invalidate",
		]) {
			fails(subcommand, `Run prefix required for ${subcommand}.`);
		}
		fails("show workflow_ab extra", "Unexpected arguments for show.");
		fails("status workflow_ab extra", "Unexpected arguments for status.");
		fails("reconcile workflow_ab a b", "Unexpected arguments for reconcile.");
		const logsUsage = "Usage: /workflow logs <run-prefix> [--tail <1..500>]";
		fails("logs workflow_ab --tail", logsUsage);
		fails("logs workflow_ab --tail 0", logsUsage);
		fails("logs workflow_ab --tail 501", logsUsage);
		fails("logs workflow_ab --tail ten", logsUsage);
		fails("logs workflow_ab --tail 5 more", logsUsage);
		fails("logs workflow_ab 5", logsUsage);
		const waitUsage =
			"Usage: /workflow wait <run-prefix> [--timeout <1000..3600000>]";
		fails("wait workflow_ab --timeout", waitUsage);
		fails("wait workflow_ab --timeout 999", waitUsage);
		fails("wait workflow_ab --timeout 3600001", waitUsage);
		fails("wait workflow_ab --timeout 1.5", waitUsage);
		fails("wait workflow_ab now", waitUsage);
		fails(
			"invalidate workflow_ab",
			"Usage: /workflow invalidate <run-prefix> <task-key> [reason]",
		);
	});

	it("completes subcommands, run ids on the second token, and --all", () => {
		const runIds = ["workflow_aaa111", "workflow_abb222", "workflow_zzz999"];
		expect(workflowArgumentCompletions("", runIds)).toEqual(
			WORKFLOW_SUBCOMMANDS.map((value) => ({ value, label: value })),
		);
		expect(workflowArgumentCompletions("s", runIds)).toEqual([
			{ value: "show", label: "show" },
			{ value: "status", label: "status" },
			{ value: "stop", label: "stop" },
		]);
		expect(workflowArgumentCompletions("zzz", runIds)).toBeNull();
		expect(workflowArgumentCompletions("show ", runIds)).toEqual(
			runIds.map((runId) => ({ value: `show ${runId}`, label: runId })),
		);
		expect(workflowArgumentCompletions("stop workflow_a", runIds)).toEqual([
			{ value: "stop workflow_aaa111", label: "workflow_aaa111" },
			{ value: "stop workflow_abb222", label: "workflow_abb222" },
		]);
		expect(workflowArgumentCompletions("stop workflow_q", runIds)).toBeNull();
		expect(workflowArgumentCompletions("show ", [])).toBeNull();
		expect(workflowArgumentCompletions("runs ", runIds)).toEqual([
			{ value: "runs --all", label: "--all" },
		]);
		expect(workflowArgumentCompletions("runs --a", runIds)).toEqual([
			{ value: "runs --all", label: "--all" },
		]);
		expect(workflowArgumentCompletions("runs --x", runIds)).toBeNull();
		expect(workflowArgumentCompletions("list ", runIds)).toBeNull();
		expect(workflowArgumentCompletions("run ", runIds)).toBeNull();
		expect(workflowArgumentCompletions("show workflow_a x", runIds)).toBeNull();
		expect(workflowArgumentCompletions("bogus ", runIds)).toBeNull();
	});
});

describe("run prefix resolution", () => {
	it("pages listRuns with children until two matches and refuses ambiguity", async () => {
		const first = summary("running", { runId: "workflow_aaa111" });
		const second = summary("failed", { runId: "workflow_aaa222" });
		const third = summary("completed", { runId: "workflow_aaa333" });
		const listRuns = vi
			.fn()
			.mockResolvedValueOnce(page([first], "cursor-1"))
			.mockResolvedValueOnce(page([second], "cursor-2"))
			.mockResolvedValueOnce(page([third]));
		await expect(
			resolveRunPrefix({ listRuns }, "workflow_aaa"),
		).rejects.toThrow(
			"Run prefix is ambiguous: workflow_aaa (workflow_aaa111, workflow_aaa222)",
		);
		// Stops after the second match: the third page is never read.
		expect(listRuns).toHaveBeenCalledTimes(2);
		expect(listRuns.mock.calls[0]?.[0]).toEqual({
			includeChildren: true,
			limit: 100,
		});
		expect(listRuns.mock.calls[1]?.[0]).toEqual({
			includeChildren: true,
			limit: 100,
			cursor: "cursor-1",
		});
	});

	it("resolves a unique prefix and lets an exact id win over a longer sibling", async () => {
		const exact = summary("running", { runId: "workflow_aaa111" });
		const longer = summary("running", { runId: "workflow_aaa1111" });
		const listRuns = vi.fn(async () => page([longer, exact]));
		await expect(
			resolveRunPrefix({ listRuns }, "workflow_aaa111"),
		).resolves.toBe(exact);
		await expect(
			resolveRunPrefix({ listRuns }, "workflow_aaa1111"),
		).resolves.toBe(longer);
		await expect(resolveRunPrefix({ listRuns }, "workflow_q")).rejects.toThrow(
			"Run not found: workflow_q",
		);
		const empty = vi.fn(async () => page([]));
		await expect(resolveRunPrefix({ listRuns: empty }, "x")).rejects.toThrow(
			"Run not found: x",
		);
	});

	it("lists at most five ambiguous candidates", async () => {
		const runs = Array.from({ length: 7 }, (_, index) =>
			summary("completed", { runId: `workflow_aaa${index}00` }),
		);
		const listRuns = vi.fn(async () => page(runs));
		await expect(
			resolveRunPrefix({ listRuns }, "workflow_aaa"),
		).rejects.toThrow(
			"Run prefix is ambiguous: workflow_aaa (workflow_aaa000, workflow_aaa100, workflow_aaa200, workflow_aaa300, workflow_aaa400)",
		);
	});
});

describe("task key resolution", () => {
	const report = task({ id: "task_report", key: "report" });
	const nested = task({
		id: "task_nested",
		namespace: ["phase-1"],
		key: "report",
	});
	const abandoned = task({
		id: "task_old",
		key: "old-task",
		abandoned: true,
		status: "invalidated",
	});
	const tasks = [report, nested, abandoned];

	it("matches by path, by slash-prefixed path, and by id", () => {
		expect(resolveTaskKey(tasks, "report")).toBe(report);
		expect(resolveTaskKey(tasks, "/report")).toBe(report);
		expect(resolveTaskKey(tasks, "  phase-1/report ")).toBe(nested);
		expect(resolveTaskKey(tasks, "/phase-1/report")).toBe(nested);
		expect(resolveTaskKey(tasks, "task_nested")).toBe(nested);
	});

	it("refuses ambiguous, abandoned-only, and missing keys", () => {
		const duplicate = task({ id: "task_dup", key: "report" });
		expect(() => resolveTaskKey([report, duplicate], "report")).toThrow(
			"Task key is ambiguous: report",
		);
		expect(() => resolveTaskKey(tasks, "old-task")).toThrow(
			"Task old-task is abandoned and cannot be acted on.",
		);
		expect(() => resolveTaskKey(tasks, "task_old")).toThrow(
			"Task task_old is abandoned and cannot be acted on.",
		);
		expect(() => resolveTaskKey(tasks, "nothing")).toThrow(
			"Task not found: nothing",
		);
		// A live task shadows an abandoned one with the same path.
		const readopted = task({ id: "task_new", key: "old-task" });
		expect(resolveTaskKey([abandoned, readopted], "old-task")).toBe(readopted);
	});
});

describe("log tail collection", () => {
	it("follows nextAfterSequence at 500 a page and keeps the last entries", async () => {
		const logs = vi.fn(
			async (
				_runId: string,
				options: { afterSequence?: number; limit?: number } = {},
			) => {
				const after = options.afterSequence ?? 0;
				const entries = Array.from({ length: 3 }, (_, index) =>
					entry(after + index + 1),
				);
				const last = after + 3;
				return {
					runId: "workflow_abcdef0123",
					entries,
					lastSequence: 9,
					...(last < 9 ? { nextAfterSequence: last } : {}),
				};
			},
		);
		const tail = await collectLogTail({ logs }, "workflow_abcdef0123", 4);
		expect(logs).toHaveBeenCalledTimes(3);
		expect(logs.mock.calls.map((call) => call[1])).toEqual([
			{ limit: 500 },
			{ limit: 500, afterSequence: 3 },
			{ limit: 500, afterSequence: 6 },
		]);
		expect(tail).toEqual({
			runId: "workflow_abcdef0123",
			entries: [entry(6), entry(7), entry(8), entry(9)],
			lastSequence: 9,
		});
		const empty = await collectLogTail(
			{
				logs: vi.fn(async () => ({
					runId: "workflow_abcdef0123",
					entries: [],
					lastSequence: 0,
				})),
			},
			"workflow_abcdef0123",
			20,
		);
		expect(empty.entries).toEqual([]);
	});
});

describe("action dispatch", () => {
	it("acts only on availableActions and names the reason", async () => {
		const leased = summary("running", {
			ownership: "leased-elsewhere",
			leasedElsewhere: true,
		});
		expect(actionUnavailableMessage("stop", leased)).toBe(
			"stop is unavailable: workflow_abcdef0123 is leased by another Pi process.",
		);
		const done = summary("completed");
		expect(actionUnavailableMessage("invalidate", done)).toBe(
			"invalidate is unavailable while the run is completed.",
		);
		const service = fakeService();
		await expect(
			performRunAction(service, { action: "stop", run: leased }),
		).rejects.toThrow(
			"stop is unavailable: workflow_abcdef0123 is leased by another Pi process.",
		);
		await expect(
			performRunAction(service, { action: "invalidate", run: done }),
		).rejects.toThrow("invalidate is unavailable while the run is completed.");
		expect(service.stop).not.toHaveBeenCalled();
		expect(service.invalidate).not.toHaveBeenCalled();
		// wait without availability reports the durable status instead.
		await expect(
			performRunAction(service, { action: "wait", run: done }),
		).resolves.toEqual({
			message: "workflow_abcdef0123: completed",
			level: "info",
		});
		expect(service.wait).not.toHaveBeenCalled();
	});

	it("dispatches stop, wait, reconcile, and invalidate with default reasons", async () => {
		const service = fakeService();
		const run = summary("running", {
			availableActions: ["stop", "wait", "reconcile", "invalidate"],
		});
		await expect(
			performRunAction(service, { action: "stop", run }),
		).resolves.toEqual({
			message: "stop accepted for workflow_abcdef0123: cancelled.",
			level: "info",
		});
		expect(service.stop).toHaveBeenLastCalledWith(
			"workflow_abcdef0123",
			DEFAULT_STOP_REASON,
		);
		await performRunAction(service, { action: "stop", run, reason: "why" });
		expect(service.stop).toHaveBeenLastCalledWith("workflow_abcdef0123", "why");

		await expect(
			performRunAction(service, { action: "wait", run }),
		).resolves.toEqual({
			message: "workflow_abcdef0123: completed",
			level: "info",
		});
		expect(service.wait).toHaveBeenLastCalledWith("workflow_abcdef0123", {});
		vi.mocked(service.wait).mockResolvedValueOnce({
			...view("running"),
			timedOut: true,
		} as never);
		await expect(
			performRunAction(service, { action: "wait", run, timeoutMs: 1500 }),
		).resolves.toEqual({
			message:
				"workflow_abcdef0123: running (timed out after 1500 ms; the run keeps driving)",
			level: "warning",
		});
		expect(service.wait).toHaveBeenLastCalledWith("workflow_abcdef0123", {
			timeoutMs: 1500,
		});

		await expect(
			performRunAction(service, { action: "reconcile", run }),
		).resolves.toEqual({
			message:
				"reconcile: 1 execution(s) reconciled; workflow_abcdef0123 is completed.",
			level: "info",
		});
		expect(service.reconcile).toHaveBeenLastCalledWith(
			"workflow_abcdef0123",
			{},
		);
		await performRunAction(service, {
			action: "reconcile",
			run,
			taskId: "task_report",
		});
		expect(service.reconcile).toHaveBeenLastCalledWith("workflow_abcdef0123", {
			taskId: "task_report",
		});

		await expect(
			performRunAction(service, { action: "invalidate", run }),
		).rejects.toThrow(
			"Usage: /workflow invalidate <run-prefix> <task-key> [reason]",
		);
		await expect(
			performRunAction(service, {
				action: "invalidate",
				run,
				taskId: "task_report",
				taskKey: "report",
			}),
		).resolves.toEqual({
			message:
				"invalidate accepted for workflow_abcdef0123: report and its dependents re-execute; run is running.",
			level: "info",
		});
		expect(service.invalidate).toHaveBeenLastCalledWith(
			"workflow_abcdef0123",
			"task_report",
			DEFAULT_INVALIDATE_REASON,
		);
		await expect(
			performRunAction(service, {
				action: "invalidate",
				run,
				taskId: "task_report",
				reason: "bad input",
				preview: {
					taskIds: ["task_report", "task_summary", "task_publish"],
					taskKeys: ["/report", "/summary", "/publish"],
					abandonedEpochs: [],
					abandonedTaskIds: [],
				},
			}),
		).resolves.toEqual({
			message:
				"invalidate accepted for workflow_abcdef0123: task_report and 2 dependent(s) re-execute; run is running.",
			level: "info",
		});
		expect(service.invalidate).toHaveBeenLastCalledWith(
			"workflow_abcdef0123",
			"task_report",
			"bad input",
		);
	});

	it("uses previewInvalidation when the service ships it", async () => {
		const previewInvalidation = vi.fn(async () => ({
			taskIds: ["task_report", "task_summary"],
			taskKeys: ["/report", "/summary"],
			abandonedEpochs: [2],
			abandonedTaskIds: ["task_late"],
		}));
		const service = fakeService({ previewInvalidation });
		const run = summary("failed", {
			requiresAttention: true,
			availableActions: ["invalidate"],
		});
		await expect(
			performRunAction(service, {
				action: "invalidate",
				run,
				taskId: "task_report",
				taskKey: "report",
			}),
		).resolves.toEqual({
			message:
				"invalidate accepted for workflow_abcdef0123: report and 1 dependent(s) re-execute; run is running.",
			level: "info",
		});
		expect(previewInvalidation).toHaveBeenCalledWith(
			"workflow_abcdef0123",
			"task_report",
		);
	});

	it("composes the invalidate consequence with and without a preview", () => {
		expect(invalidateConsequence("report", undefined)).toBe(
			"report and its live transitive dependents re-execute as new generations. Epochs after the exposing barrier are abandoned, retiring their declarations, and effects after that barrier are marked abandoned.",
		);
		expect(
			invalidateConsequence("report", {
				taskIds: ["task_report", "task_summary"],
				taskKeys: ["/report", "/summary"],
				abandonedEpochs: [3],
				abandonedTaskIds: ["task_late"],
			}),
		).toBe(
			"2 task(s) re-execute as new generations: report, summary. 1 epoch(s) after the exposing barrier are abandoned, retiring 1 declaration(s). Effects after that barrier are marked abandoned.",
		);
		expect(
			invalidateConsequence("a", {
				taskIds: Array.from({ length: 8 }, (_, index) => `task_${index}`),
				taskKeys: Array.from({ length: 8 }, (_, index) => `/t${index}`),
				abandonedEpochs: [],
				abandonedTaskIds: [],
			}),
		).toBe(
			"8 task(s) re-execute as new generations: t0, t1, t2, t3, t4, t5, +2 more. 0 epoch(s) after the exposing barrier are abandoned, retiring 0 declaration(s). Effects after that barrier are marked abandoned.",
		);
	});

	it("dispatches retry and resume with the service signatures and refuses a missing method", async () => {
		const absent = fakeService();
		const run = summary("failed", { availableActions: ["retry", "resume"] });
		await expect(
			performRunAction(absent, { action: "retry", run, taskId: "task_x" }),
		).rejects.toThrow("retry is not implemented by this workflow service.");
		await expect(
			performRunAction(absent, { action: "resume", run }),
		).rejects.toThrow("resume is not implemented by this workflow service.");
		const retry = vi.fn(async () => view("running"));
		const resume = vi.fn(async () => view("running"));
		const service = fakeService({ retry, resume });
		await expect(
			performRunAction(service, { action: "retry", run }),
		).rejects.toThrow(
			"Usage: /workflow retry <run-prefix> <task-key> [reason]",
		);
		expect(retry).not.toHaveBeenCalled();
		await expect(
			performRunAction(service, {
				action: "retry",
				run,
				taskId: "task_report",
			}),
		).resolves.toEqual({
			message: "retry accepted for workflow_abcdef0123: running.",
			level: "info",
		});
		expect(retry).toHaveBeenLastCalledWith(
			"workflow_abcdef0123",
			"task_report",
			DEFAULT_RETRY_REASON,
		);
		await performRunAction(service, {
			action: "retry",
			run,
			taskId: "task_report",
			reason: "flaky network",
		});
		expect(retry).toHaveBeenLastCalledWith(
			"workflow_abcdef0123",
			"task_report",
			"flaky network",
		);
		await expect(
			performRunAction(service, { action: "resume", run }),
		).resolves.toEqual({
			message: "resume accepted for workflow_abcdef0123: running.",
			level: "info",
		});
		expect(resume).toHaveBeenLastCalledWith(
			"workflow_abcdef0123",
			DEFAULT_RESUME_REASON,
			{},
		);
		await performRunAction(service, {
			action: "resume",
			run,
			taskId: "task_report",
			reason: "operator resume",
		});
		expect(resume).toHaveBeenLastCalledWith(
			"workflow_abcdef0123",
			"operator resume",
			{ taskId: "task_report" },
		);
	});
});

describe("ui import discipline", () => {
	it("consumes legality from views and never imports the predicates or the reducer", async () => {
		const directory = path.resolve("src", "ui");
		const files = (await readdir(directory)).filter((file) =>
			file.endsWith(".ts"),
		);
		expect(files.length).toBeGreaterThan(0);
		const allowed = new Set([
			"WORKFLOW_RUN_ACTIONS",
			"IMPLEMENTED_WORKFLOW_RUN_ACTIONS",
		]);
		for (const file of files) {
			const source = await readFile(path.join(directory, file), "utf8");
			expect(source, file).not.toMatch(/from\s+"\.\.\/reducer\.js"/);
			const imports = source.matchAll(
				/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"\.\.\/run-actions\.js"/g,
			);
			for (const match of imports) {
				if (match[1]) continue;
				const names = (match[2] ?? "")
					.split(",")
					.map((name) => name.trim())
					.filter(Boolean)
					.filter((name) => !name.startsWith("type "));
				for (const name of names) {
					expect(allowed.has(name), `${file} imports ${name}`).toBe(true);
				}
			}
		}
	});
});
