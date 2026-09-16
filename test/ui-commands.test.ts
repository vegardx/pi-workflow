import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SubagentClient } from "@vegardx/pi-subagent";
import { describe, expect, it, vi } from "vitest";
import {
	IMPLEMENTED_WORKFLOW_RUN_ACTIONS,
	WORKFLOW_RUN_ACTIONS,
} from "../src/run-actions.js";
import {
	createWorkflowService,
	type WorkflowService,
	type WorkflowServiceOptions,
} from "../src/service.js";
import type {
	WorkflowLogEntry,
	WorkflowRunPage,
	WorkflowRunSummary,
	WorkflowServiceTaskView,
} from "../src/service-views.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";
import {
	ACTION_LABELS,
	actionUnavailableMessage,
	CHECKPOINT_DECISION_CANCELLED_MESSAGE,
	CHECKPOINT_DECISION_INVALID_JSON_MESSAGE,
	CHECKPOINT_DECISION_REQUIRES_UI_MESSAGE,
	CONFIRMED_ACTIONS,
	checkpointDecisionMode,
	collectLogTail,
	DECIDE_USAGE_MESSAGE,
	DEFAULT_DECIDE_APPROVER,
	DEFAULT_INVALIDATE_REASON,
	DEFAULT_RESUME_REASON,
	DEFAULT_RETRY_REASON,
	DEFAULT_STOP_REASON,
	DYNAMIC_REF_USAGE_MESSAGE,
	decideConsequence,
	invalidateConsequence,
	parseCheckpointDecision,
	parseWorkflowCommand,
	performRunAction,
	performSourceDecision,
	resolveRunPrefix,
	resolveTaskKey,
	SOURCE_DECISION_SUBCOMMANDS,
	sourceDecisionUnavailableMessage,
	sourceDecisionVia,
	splitQuoted,
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
		pendingCheckpointCount: 0,
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
		previewInvalidation: vi.fn(async () => ({
			runId: "workflow_abcdef0123",
			causeTaskId: "task_report",
			taskIds: ["task_report", "task_summary"],
			taskKeys: ["/report", "/summary"],
			abandonedEpochs: [],
			abandonedTaskIds: [],
		})),
		...overrides,
	} as unknown as WorkflowService;
}

describe("/workflow grammar", () => {
	it("derives the action subcommands from the implemented set only", () => {
		const expected = WORKFLOW_RUN_ACTIONS.filter(
			(action) =>
				IMPLEMENTED_WORKFLOW_RUN_ACTIONS.has(action) && action !== "wait",
		);
		expect([...WORKFLOW_ACTION_SUBCOMMANDS]).toEqual(expected);
		expect([...SOURCE_DECISION_SUBCOMMANDS]).toEqual(["approve", "reject"]);
		expect([...WORKFLOW_SUBCOMMANDS]).toEqual([
			"list",
			"runs",
			"validate",
			"run",
			"approve",
			"reject",
			"show",
			"status",
			"logs",
			"wait",
			...expected,
		]);
		// decide is a human command derived from the implemented set, never a tool.
		expect(WORKFLOW_SUBCOMMANDS).toContain("decide");
		for (const action of WORKFLOW_RUN_ACTIONS) {
			if (!IMPLEMENTED_WORKFLOW_RUN_ACTIONS.has(action)) {
				expect(WORKFLOW_SUBCOMMANDS).not.toContain(action);
			}
		}
		expect(Object.isFrozen(WORKFLOW_SUBCOMMANDS)).toBe(true);
		expect(Object.keys(ACTION_LABELS).sort()).toEqual(
			[...WORKFLOW_RUN_ACTIONS].sort(),
		);
		expect([...CONFIRMED_ACTIONS].sort()).toEqual([
			"decide",
			"invalidate",
			"resume",
			"retry",
			"stop",
		]);
		expect(DEFAULT_DECIDE_APPROVER).toBe("pi-session");
	});

	it("parses decide with a quoted JSON token and joins the reason", () => {
		expect(splitQuoted(`a  'b c' "d e" f`)).toEqual([
			"a",
			"'b c'",
			'"d e"',
			"f",
		]);
		expect(splitQuoted(`x '{"a": 1}' tail`)).toEqual([
			"x",
			`'{"a": 1}'`,
			"tail",
		]);
		expect(splitQuoted(`x {"a": 1, "b": "c d"} tail`)).toEqual([
			"x",
			`{"a": 1, "b": "c d"}`,
			"tail",
		]);
		expect(splitQuoted(`[1, 2, {"k": "v w"}] "q r" 'e f' end`)).toEqual([
			`[1, 2, {"k": "v w"}]`,
			'"q r"',
			"'e f'",
			"end",
		]);
		expect(splitQuoted(`{"a": "b\\" c"} next`)).toEqual([
			`{"a": "b\\" c"}`,
			"next",
		]);
		// Unbalanced openers fall back to whitespace splitting.
		expect(splitQuoted(`{"a": 1 tail`)).toEqual([`{"a":`, "1", "tail"]);
		expect(splitQuoted(`'open tail`)).toEqual(["'open", "tail"]);
		expect(parseCheckpointDecision("true")).toBe(true);
		expect(parseCheckpointDecision('"ship"')).toBe("ship");
		expect(parseCheckpointDecision(`'{"proceed": true}'`)).toEqual({
			proceed: true,
		});
		expect(parseCheckpointDecision(`{"proceed": false}`)).toEqual({
			proceed: false,
		});
		expect(() => parseCheckpointDecision("{nope")).toThrow(
			CHECKPOINT_DECISION_INVALID_JSON_MESSAGE,
		);
		expect(parseWorkflowCommand("decide workflow_ab approve true")).toEqual({
			kind: "decide",
			runPrefix: "workflow_ab",
			taskKey: "approve",
			decision: true,
		});
		expect(
			parseWorkflowCommand(
				`decide workflow_ab review/approve '{"proceed": true, "note": "ship it"}' Reviewed  the plan`,
			),
		).toEqual({
			kind: "decide",
			runPrefix: "workflow_ab",
			taskKey: "review/approve",
			decision: { proceed: true, note: "ship it" },
			reason: "Reviewed the plan",
		});
		expect(
			parseWorkflowCommand('decide workflow_ab approve {"proceed":true}'),
		).toEqual({
			kind: "decide",
			runPrefix: "workflow_ab",
			taskKey: "approve",
			decision: { proceed: true },
		});
		expect(
			parseWorkflowCommand(
				'decide workflow_ab approve {"proceed": true, "note": "a b"} because',
			),
		).toEqual({
			kind: "decide",
			runPrefix: "workflow_ab",
			taskKey: "approve",
			decision: { proceed: true, note: "a b" },
			reason: "because",
		});
		expect(
			parseWorkflowCommand('decide workflow_ab approve "text" by vegard'),
		).toEqual({
			kind: "decide",
			runPrefix: "workflow_ab",
			taskKey: "approve",
			decision: "text",
			reason: "by vegard",
		});
		expect(() => parseWorkflowCommand("decide")).toThrow(
			"Run prefix required for decide.",
		);
		expect(() => parseWorkflowCommand("decide workflow_ab")).toThrow(
			DECIDE_USAGE_MESSAGE,
		);
		expect(() =>
			parseWorkflowCommand("decide workflow_ab approve {not json}"),
		).toThrow(CHECKPOINT_DECISION_INVALID_JSON_MESSAGE);
		expect(() =>
			parseWorkflowCommand("decide workflow_ab approve {a: 1} reason"),
		).toThrow(CHECKPOINT_DECISION_INVALID_JSON_MESSAGE);
	});

	it("parses decide without a decision so the guided form can ask for it", () => {
		// Widening an accepted input: the 16 subcommands are unchanged and
		// every decide that parsed before still parses the same way.
		expect(WORKFLOW_SUBCOMMANDS).toHaveLength(16);
		expect(DECIDE_USAGE_MESSAGE).toBe(
			"Usage: /workflow decide <run-prefix> <task-key> [json] [reason]",
		);
		const bare = parseWorkflowCommand("decide workflow_ab approve");
		expect(bare).toEqual({
			kind: "decide",
			runPrefix: "workflow_ab",
			taskKey: "approve",
		});
		// The absent property, not an undefined one: the dispatcher reads it.
		expect("decision" in bare).toBe(false);
		expect(parseWorkflowCommand("decide workflow_ab review/approve")).toEqual({
			kind: "decide",
			runPrefix: "workflow_ab",
			taskKey: "review/approve",
		});
		expect(parseWorkflowCommand("decide workflow_ab /review/approve")).toEqual({
			kind: "decide",
			runPrefix: "workflow_ab",
			taskKey: "/review/approve",
		});
		// A reason still requires a decision: the token after the task key is
		// read as the JSON decision, so a bare reason is a JSON error.
		expect(() =>
			parseWorkflowCommand("decide workflow_ab approve looks good"),
		).toThrow(CHECKPOINT_DECISION_INVALID_JSON_MESSAGE);
	});

	it("routes decide to the form or the confirm and refuses a session without dialogs", () => {
		const parseDecide = (args: string) => {
			const parsed = parseWorkflowCommand(args);
			if (parsed.kind !== "decide") throw new Error(`not decide: ${args}`);
			return parsed;
		};
		const withJson = parseDecide("decide workflow_ab approve true");
		const withoutJson = parseDecide("decide workflow_ab approve");
		expect(checkpointDecisionMode(withJson, true)).toBe("confirm");
		expect(checkpointDecisionMode(withoutJson, true)).toBe("form");
		// A decision is a human act; without dialogs nothing is recorded.
		for (const parsed of [withJson, withoutJson]) {
			expect(() => checkpointDecisionMode(parsed, false)).toThrow(
				CHECKPOINT_DECISION_REQUIRES_UI_MESSAGE,
			);
			expect(() => checkpointDecisionMode(parsed, false)).toThrow(
				WorkflowCommandError,
			);
		}
		expect(CHECKPOINT_DECISION_REQUIRES_UI_MESSAGE).toBe(
			"Checkpoint decisions require an interactive Pi session.",
		);
	});

	it("parses approve and reject with a dynamic ref and an optional reason", () => {
		const ref = `dynamic:${"a".repeat(64)}`;
		expect(parseWorkflowCommand(`approve ${ref}`)).toEqual({
			kind: "approve",
			ref,
		});
		expect(parseWorkflowCommand(`approve ${ref} looks  safe`)).toEqual({
			kind: "approve",
			ref,
			reason: "looks safe",
		});
		expect(parseWorkflowCommand(`reject ${ref}`)).toEqual({
			kind: "reject",
			ref,
		});
		expect(parseWorkflowCommand(`reject ${ref} writes outside cwd`)).toEqual({
			kind: "reject",
			ref,
			reason: "writes outside cwd",
		});
		expect(() => parseWorkflowCommand("approve")).toThrow(
			"Usage: /workflow approve dynamic:<sha256> [reason]",
		);
		expect(() => parseWorkflowCommand("reject")).toThrow(
			"Usage: /workflow reject dynamic:<sha256> [reason]",
		);
		for (const bad of [
			"workflow_ab",
			"dynamic:",
			`dynamic:${"a".repeat(63)}`,
			`dynamic:${"A".repeat(64)}`,
			"a".repeat(64),
		]) {
			expect(() => parseWorkflowCommand(`approve ${bad}`)).toThrow(
				DYNAMIC_REF_USAGE_MESSAGE,
			);
		}
		expect(sourceDecisionVia("approve")).toBe("/workflow approve");
		expect(sourceDecisionVia("reject")).toBe("/workflow reject");
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
			DECIDE_USAGE_MESSAGE,
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
		expect(workflowArgumentCompletions("dec", runIds)).toEqual([
			{ value: "decide", label: "decide" },
		]);
		expect(workflowArgumentCompletions("decide workflow_z", runIds)).toEqual([
			{ value: "decide workflow_zzz999", label: "workflow_zzz999" },
		]);
	});

	it("completes approve and reject with undecided proposal refs or the dynamic: prefix", () => {
		const refs = [`dynamic:${"a".repeat(64)}`, `dynamic:${"b".repeat(64)}`];
		expect(workflowArgumentCompletions("approve ", [], refs)).toEqual(
			refs.map((ref) => ({ value: `approve ${ref}`, label: ref })),
		);
		expect(workflowArgumentCompletions("reject dynamic:b", [], refs)).toEqual([
			{ value: `reject ${refs[1]}`, label: refs[1] },
		]);
		expect(workflowArgumentCompletions("approve ", [])).toEqual([
			{ value: "approve dynamic:", label: "dynamic:" },
		]);
		expect(workflowArgumentCompletions("approve dyn", [])).toEqual([
			{ value: "approve dynamic:", label: "dynamic:" },
		]);
		expect(workflowArgumentCompletions("approve dynamic:", [])).toBeNull();
		expect(workflowArgumentCompletions("approve x", [], refs)).toBeNull();
		// Run ids never complete a definition-level command.
		expect(
			workflowArgumentCompletions("approve workflow_", ["workflow_abc"]),
		).toBeNull();
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
				"invalidate accepted for workflow_abcdef0123: report and 1 dependent(s) re-execute; run is running.",
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
					runId: "workflow_abcdef0123",
					causeTaskId: "task_report",
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

	it("sources the invalidate closure from the service and forwards its refusal", async () => {
		const refusing = fakeService({
			previewInvalidation: vi.fn(async () => {
				throw new Error("invalidation cause is already invalidated");
			}),
		});
		await expect(
			performRunAction(refusing, {
				action: "invalidate",
				run: summary("failed", { availableActions: ["invalidate"] }),
				taskId: "task_report",
			}),
		).rejects.toThrow("invalidation cause is already invalidated");
		expect(refusing.invalidate).not.toHaveBeenCalled();

		const previewInvalidation = vi.fn(async () => ({
			runId: "workflow_abcdef0123",
			causeTaskId: "task_report",
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

	it("composes the invalidate consequence from the service's preview", () => {
		expect(
			invalidateConsequence({
				runId: "workflow_abcdef0123",
				causeTaskId: "task_report",
				taskIds: ["task_report", "task_summary"],
				taskKeys: ["/report", "/summary"],
				abandonedEpochs: [3],
				abandonedTaskIds: ["task_late"],
			}),
		).toBe(
			"2 task(s) re-execute as new generations: report, summary. 1 epoch(s) after the exposing barrier are abandoned, retiring 1 declaration(s). Effects after that barrier are marked abandoned.",
		);
		expect(
			invalidateConsequence({
				runId: "workflow_abcdef0123",
				causeTaskId: "task_0",
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

describe("checkpoint decide dispatch", () => {
	const checkpointTask = task({
		id: "task_approve",
		key: "approve",
		namespace: ["review"],
		kind: "checkpoint",
		status: "waiting",
		checkpoint: {
			prompt: "Approve the plan?",
			schema: { type: "object" },
			headless: "block",
		},
	});

	it("composes the confirmation from the checkpoint prompt and the parsed decision", () => {
		expect(decideConsequence(checkpointTask, { proceed: true })).toBe(
			'Checkpoint review/approve: Approve the plan?\nDecision: {"proceed":true}\nThe decision is recorded once, immutably, and the run continues from it.',
		);
		expect(
			decideConsequence(task({ id: "task_report", key: "report" }), "ship"),
		).toBe(
			'Checkpoint report: (no checkpoint request)\nDecision: "ship"\nThe decision is recorded once, immutably, and the run continues from it.',
		);
	});

	it("acts only when availableActions offers decide and never derives the approver from arguments", async () => {
		const decide = vi.fn(async () => view("running"));
		const service = fakeService({ decide });
		const parked = summary("waiting", { availableActions: ["stop", "wait"] });
		await expect(
			performRunAction(service, {
				action: "decide",
				run: parked,
				taskId: "task_approve",
				decision: { proceed: true },
			}),
		).rejects.toThrow("decide is unavailable while the run is waiting.");
		expect(decide).not.toHaveBeenCalled();
		const run = summary("waiting", {
			availableActions: ["stop", "wait", "decide"],
		});
		await expect(
			performRunAction(service, { action: "decide", run }),
		).rejects.toThrow(DECIDE_USAGE_MESSAGE);
		// A missing decision with no form to collect one records nothing.
		await expect(
			performRunAction(service, {
				action: "decide",
				run,
				taskId: "task_approve",
			}),
		).rejects.toThrow(DECIDE_USAGE_MESSAGE);
		expect(decide).not.toHaveBeenCalled();
		await expect(
			performRunAction(service, {
				action: "decide",
				run,
				taskId: "task_approve",
				taskKey: "review/approve",
				decision: { proceed: true, approver: "mallory" },
				reason: "approver: mallory",
			}),
		).resolves.toEqual({
			message:
				"decide accepted for workflow_abcdef0123: review/approve decided; run is running.",
			level: "info",
		});
		expect(decide).toHaveBeenLastCalledWith(
			"workflow_abcdef0123",
			"task_approve",
			{
				decision: { proceed: true, approver: "mallory" },
				approver: DEFAULT_DECIDE_APPROVER,
				reason: "approver: mallory",
			},
		);
		await performRunAction(service, {
			action: "decide",
			run,
			taskId: "task_approve",
			decision: false,
			approver: "session-user",
		});
		expect(decide).toHaveBeenLastCalledWith(
			"workflow_abcdef0123",
			"task_approve",
			{ decision: false, approver: "session-user" },
		);
		// Service refusals pass through verbatim.
		const refusing = fakeService({
			decide: vi.fn(async () => {
				throw new Error("Checkpoint decision does not match its schema.");
			}),
		});
		await expect(
			performRunAction(refusing, {
				action: "decide",
				run,
				taskId: "task_approve",
				decision: 1,
			}),
		).rejects.toThrow("Checkpoint decision does not match its schema.");
	});

	it("hands a decide without a decision to the injected guided form", async () => {
		const decide = vi.fn(async () => view("running"));
		const service = fakeService({ decide });
		const run = summary("waiting", {
			availableActions: ["stop", "wait", "decide"],
			pendingCheckpointCount: 1,
		});
		const request = {
			action: "decide",
			run,
			taskId: "task_approve",
			taskKey: "review/approve",
		} as const;
		// The form asks the session user and records the decision itself, so
		// the dispatcher never calls `decide` a second time.
		const collectDecision = vi.fn(
			async () => ({ view: { status: "running" } }) as const,
		);
		await expect(
			performRunAction(service, request, { collectDecision }),
		).resolves.toEqual({
			message:
				"decide accepted for workflow_abcdef0123: review/approve decided; run is running.",
			level: "info",
		});
		expect(collectDecision).toHaveBeenCalledTimes(1);
		expect(decide).not.toHaveBeenCalled();
		// A dismissed dialog or a declined confirm records nothing.
		const dismissed = vi.fn(async () => undefined);
		await expect(
			performRunAction(service, request, { collectDecision: dismissed }),
		).resolves.toEqual({
			message: CHECKPOINT_DECISION_CANCELLED_MESSAGE,
			level: "info",
		});
		expect(CHECKPOINT_DECISION_CANCELLED_MESSAGE).toBe("No decision recorded.");
		expect(decide).not.toHaveBeenCalled();
		// Legality is still read from availableActions, before the form opens.
		await expect(
			performRunAction(
				service,
				{ ...request, run: summary("waiting", { availableActions: ["wait"] }) },
				{ collectDecision },
			),
		).rejects.toThrow("decide is unavailable while the run is waiting.");
		expect(collectDecision).toHaveBeenCalledTimes(1);
		// With `<json>` the path is unchanged: the form is never consulted.
		await expect(
			performRunAction(
				service,
				{ ...request, decision: { proceed: true } },
				{ collectDecision },
			),
		).resolves.toEqual({
			message:
				"decide accepted for workflow_abcdef0123: review/approve decided; run is running.",
			level: "info",
		});
		expect(collectDecision).toHaveBeenCalledTimes(1);
		expect(decide).toHaveBeenLastCalledWith(
			"workflow_abcdef0123",
			"task_approve",
			{
				decision: { proceed: true },
				approver: DEFAULT_DECIDE_APPROVER,
			},
		);
		// An explicitly undefined decision is no decision: no JSON document
		// produces one, so the form answers that too.
		await expect(
			performRunAction(
				service,
				{ ...request, decision: undefined },
				{ collectDecision },
			),
		).resolves.toEqual({
			message:
				"decide accepted for workflow_abcdef0123: review/approve decided; run is running.",
			level: "info",
		});
		expect(collectDecision).toHaveBeenCalledTimes(2);
		expect(decide).toHaveBeenCalledTimes(1);
	});
});

describe("dynamic source decision dispatch", () => {
	const ref = `dynamic:${"c".repeat(64)}` as const;
	const approver = {
		kind: "human",
		via: "/workflow approve",
		sessionId: "session-1",
	} as const;

	it("refuses a decided proposal from the view and records approve or reject", async () => {
		const decided = {
			ref,
			decision: {
				decision: "approved" as const,
				approver,
				approvedAt: "2026-09-15T00:00:00.000Z",
				approvalSha256: "d".repeat(64),
			},
		};
		expect(sourceDecisionUnavailableMessage("reject", decided)).toBe(
			`reject is unavailable: ${ref} is already approved.`,
		);
		const decideSource = vi.fn(async () => ({ ref, runnable: true }));
		const service = { decideSource } as unknown as WorkflowService;
		await expect(
			performSourceDecision(service, {
				kind: "reject",
				view: decided,
				approver,
			}),
		).rejects.toThrow(`reject is unavailable: ${ref} is already approved.`);
		expect(decideSource).not.toHaveBeenCalled();
		await expect(
			performSourceDecision(service, {
				kind: "approve",
				view: { ref },
				approver,
				reason: "reviewed",
			}),
		).resolves.toEqual({
			message: `Approved ${ref}. Run it with workflow_run or /workflow run ${ref}.`,
			level: "info",
		});
		expect(decideSource).toHaveBeenLastCalledWith(ref, {
			decision: "approved",
			approver,
			reason: "reviewed",
		});
		const rejecter = { kind: "human", via: "/workflow reject" } as const;
		await expect(
			performSourceDecision(service, {
				kind: "reject",
				view: { ref },
				approver: rejecter,
			}),
		).resolves.toEqual({
			message: `Rejected ${ref}. This source cannot be approved again; a changed source gets a new digest.`,
			level: "info",
		});
		expect(decideSource).toHaveBeenLastCalledWith(ref, {
			decision: "rejected",
			approver: rejecter,
		});
		const stale = {
			decideSource: vi.fn(async () => ({ ref, runnable: false })),
		} as unknown as WorkflowService;
		await expect(
			performSourceDecision(stale, {
				kind: "approve",
				view: { ref },
				approver,
			}),
		).resolves.toEqual({
			message: `Approved ${ref}, but it is not runnable under the current host API; propose the source again.`,
			level: "warning",
		});
		const refusing = {
			decideSource: vi.fn(async () => {
				throw new Error("Dynamic workflow source was rejected.");
			}),
		} as unknown as WorkflowService;
		await expect(
			performSourceDecision(refusing, {
				kind: "approve",
				view: { ref },
				approver,
			}),
		).rejects.toThrow("Dynamic workflow source was rejected.");
	});
});

// ---------------------------------------------------------------------------
// Real service
// ---------------------------------------------------------------------------

const CLIENT_METHODS = [
	"preflight",
	"launch",
	"findByOperation",
	"status",
	"listRuns",
	"logs",
	"wait",
	"interrupt",
	"steer",
	"followUp",
	"retry",
	"resume",
	"reconcile",
	"release",
	"abandon",
	"pin",
	"unpin",
	"exportArtifact",
] as const;

/** Neither fixture delegates: every subagent call is a failure. */
function provider(): WorkflowSubagentProvider {
	return {
		bind: vi.fn(async (runId: string) => {
			const methods: Record<string, unknown> = {};
			for (const method of CLIENT_METHODS) {
				methods[method] = vi.fn(async () => {
					throw new Error(`unexpected subagent call: ${method}`);
				});
			}
			return {
				workflowRunId: runId,
				ownerId: `pi-workflow:${runId}`,
				client: methods as unknown as SubagentClient,
			} satisfies WorkflowSubagentBinding;
		}),
	};
}

const CHECKPOINT_DEFINITION = `export default {
  schema: "pi-workflow-definition",
  meta: { name: "ui-decide", description: "Checkpoint workflow", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 600000, concurrency: 1 },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  async run(ctx) {
    ctx.phase("review");
    const approve = ctx.checkpoint("approve", { schema: { type: "object", properties: { proceed: { type: "boolean" } }, required: ["proceed"], additionalProperties: false }, prompt: "Approve the plan?", headless: "block", timeoutMs: 60000 });
    const decision = await ctx.result(approve);
    return { answer: decision.proceed ? "approved" : "declined" };
  }
};
`;

const DYNAMIC_SOURCE = `import { defineWorkflow } from "@vegardx/pi-workflow";

export default defineWorkflow({
	meta: { name: "ui-approve", description: "Approval fixture", version: 1, budget: { cost: 10, childRuntimeMs: 600000 }, timeoutMs: 600000, concurrency: 1 },
	inputSchema: { type: "object", properties: {}, additionalProperties: false },
	outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
	async run(ctx) {
		ctx.phase("answer");
		return { answer: "fixed" };
	},
});
`;

async function realService(
	name: string,
	options: Partial<WorkflowServiceOptions> = {},
): Promise<WorkflowService> {
	const base = path.resolve(
		".pi",
		"test-ui-commands",
		`${name}-${randomUUID()}`,
	);
	const cwd = path.join(base, "project");
	const agentDir = path.join(base, "agent");
	await mkdir(path.join(cwd, "workflows"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		path.join(cwd, "workflows", "ui-decide.workflow.ts"),
		CHECKPOINT_DEFINITION,
	);
	return createWorkflowService({
		cwd,
		agentDir,
		storeRoot: path.join(cwd, ".pi", "workflow"),
		projectTrusted: () => true,
		subagents: provider(),
		...options,
	});
}

async function summaryOf(
	service: WorkflowService,
	runId: string,
): Promise<WorkflowRunSummary> {
	return resolveRunPrefix(service, runId);
}

describe("decide through a real service", () => {
	it("drives a parked run to completion with the session approver", async () => {
		const service = await realService("decide");
		try {
			const receipt = await service.run("ui-decide", {});
			const parked = await service.wait(receipt.runId);
			expect(parked).toMatchObject({ status: "waiting", parked: true });
			const run = await summaryOf(service, receipt.runId);
			expect(run.availableActions).toContain("decide");
			const inspection = await service.inspect(receipt.runId, {
				include: ["tasks"],
			});
			const checkpoint = resolveTaskKey(inspection.tasks ?? [], "approve");
			expect(checkpoint.kind).toBe("checkpoint");
			// A decision the schema refuses is surfaced verbatim and records nothing.
			await expect(
				performRunAction(service, {
					action: "decide",
					run,
					taskId: checkpoint.id,
					taskKey: "approve",
					decision: { proceed: "yes" },
				}),
			).rejects.toThrow("Checkpoint decision does not match its schema.");
			const outcome = await performRunAction(service, {
				action: "decide",
				run,
				taskId: checkpoint.id,
				taskKey: "approve",
				decision: { proceed: true },
				reason: "Reviewed the plan.",
			});
			expect(outcome.level).toBe("info");
			expect(outcome.message).toMatch(
				new RegExp(
					`^decide accepted for ${receipt.runId}: approve decided; run is (waiting|running|finalizing|completed)\\.$`,
				),
			);
			const final = await service.wait(receipt.runId);
			expect(final).toMatchObject({
				status: "completed",
				output: { answer: "approved" },
			});
			const decided = final.tasks?.find((entry) => entry.id === checkpoint.id);
			expect(decided?.checkpoint?.decision).toMatchObject({
				source: "operator",
				decidedBy: DEFAULT_DECIDE_APPROVER,
				reason: "Reviewed the plan.",
				value: { proceed: true },
			});
			const done = await summaryOf(service, receipt.runId);
			expect(done.availableActions).not.toContain("decide");
			await expect(
				performRunAction(service, {
					action: "decide",
					run: done,
					taskId: checkpoint.id,
					decision: { proceed: true },
				}),
			).rejects.toThrow("decide is unavailable while the run is completed.");
		} finally {
			await service.shutdown();
		}
	});
});

describe("approve and reject through a real service", () => {
	it("records the human decision once and refuses a second one", async () => {
		const service = await realService("approve", {
			// Source-mode workers boot slowly under full-suite load.
			dynamic: { bootTimeoutMs: 60_000 },
		});
		try {
			const proposed = await service.propose(DYNAMIC_SOURCE, {
				proposer: { kind: "api", via: "test" },
			});
			expect(proposed.decision).toBeUndefined();
			expect(proposed.runnable).toBe(false);
			const inspected = await service.inspectProposal(proposed.ref);
			const approver = {
				kind: "human",
				via: sourceDecisionVia("approve"),
				sessionId: "session-42",
			} as const;
			await expect(
				performSourceDecision(service, {
					kind: "approve",
					view: inspected,
					approver,
					reason: "Read every line.",
				}),
			).resolves.toEqual({
				message: `Approved ${proposed.ref}. Run it with workflow_run or /workflow run ${proposed.ref}.`,
				level: "info",
			});
			const approved = await service.inspectProposal(proposed.ref);
			expect(approved.runnable).toBe(true);
			expect(approved.decision).toMatchObject({
				decision: "approved",
				approver,
				reason: "Read every line.",
			});
			// The view's decision state refuses before the service is asked;
			// the service refuses the same request verbatim on its own.
			await expect(
				performSourceDecision(service, {
					kind: "reject",
					view: approved,
					approver: { kind: "human", via: sourceDecisionVia("reject") },
				}),
			).rejects.toThrow(
				`reject is unavailable: ${proposed.ref} is already approved.`,
			);
			await expect(
				performSourceDecision(service, {
					kind: "reject",
					view: { ref: approved.ref },
					approver: { kind: "human", via: sourceDecisionVia("reject") },
				}),
			).rejects.toThrow("Dynamic workflow source is already approved.");
			const { workflow } = await service.validate(proposed.ref, {});
			expect(workflow.name).toBe("ui-approve");

			const other = await service.propose(`${DYNAMIC_SOURCE}\n// v2\n`, {
				proposer: { kind: "api", via: "test" },
			});
			expect(other.ref).not.toBe(proposed.ref);
			await expect(
				performSourceDecision(service, {
					kind: "reject",
					view: other,
					approver: { kind: "human", via: sourceDecisionVia("reject") },
					reason: "Not needed.",
				}),
			).resolves.toEqual({
				message: `Rejected ${other.ref}. This source cannot be approved again; a changed source gets a new digest.`,
				level: "info",
			});
			const rejected = await service.inspectProposal(other.ref);
			expect(rejected.decision).toMatchObject({
				decision: "rejected",
				approver: { kind: "human", via: "/workflow reject" },
				reason: "Not needed.",
			});
			expect(rejected.runnable).toBe(false);
			await expect(service.validate(other.ref, {})).rejects.toThrow(
				"Dynamic workflow source was rejected.",
			);
			// A model approver never passes the service.
			await expect(
				performSourceDecision(service, {
					kind: "approve",
					view: { ref: other.ref },
					approver: { kind: "model", via: "tool" } as never,
				}),
			).rejects.toThrow("Invalid dynamic workflow approver.");
		} finally {
			await service.shutdown();
		}
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

	it("loads pi-tui only from the lazily imported TUI modules", async () => {
		const runtimeImport =
			/^import\s+(?!type\b)[^;]*?from\s+"@earendil-works\/pi-tui"/m;
		const anyImport = /from\s+"@earendil-works\/pi-tui"/;
		for (const file of [
			"src/ui/format.ts",
			"src/ui/widget.ts",
			"src/extension.ts",
		]) {
			const source = await readFile(path.resolve(file), "utf8");
			expect(source, file).not.toMatch(anyImport);
		}
		// Type-only imports are erased and load nothing.
		const commands = await readFile(path.resolve("src/ui/commands.ts"), "utf8");
		expect(commands).not.toMatch(runtimeImport);
		// The extension reaches pi-tui only through dynamic imports.
		const extension = await readFile(path.resolve("src/extension.ts"), "utf8");
		expect(extension).toMatch(/import\("\.\/ui\/inspector\.js"\)/);
		expect(extension).toMatch(/import\("\.\/ui\/tool-render\.js"\)/);
		for (const file of ["src/ui/inspector.ts", "src/ui/tool-render.ts"]) {
			const source = await readFile(path.resolve(file), "utf8");
			expect(source, file).toMatch(runtimeImport);
		}
	});
});
