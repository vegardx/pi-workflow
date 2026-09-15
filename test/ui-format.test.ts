import { describe, expect, it } from "vitest";
import type {
	WorkflowLogEntry,
	WorkflowRunSummary,
	WorkflowServiceTaskView,
} from "../src/service-views.js";
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
	TASK_STATUS_ICON,
	TERMINAL_RUN_STATUSES,
	taskLine,
	taskPath,
} from "../src/ui/format.js";

const NOW = Date.parse("2026-09-15T12:05:00.000Z");

function summary(
	status: WorkflowRunSummary["status"],
	overrides: Partial<WorkflowRunSummary> = {},
): WorkflowRunSummary {
	return {
		runId: "workflow_formatfixture01",
		definitionName: "release",
		status,
		createdAt: "2026-09-15T12:00:00.000Z",
		updatedAt: "2026-09-15T12:04:00.000Z",
		deadlineAt: "2026-09-15T13:00:00.000Z",
		depth: 0,
		lastSequence: 7,
		taskCounts: {
			pending: 0,
			ready: 0,
			running: 0,
			waiting: 0,
			completed: 1,
			failed: 0,
			interrupted: 0,
			blocked: 0,
			cancelling: 0,
			cancelled: 0,
			"cleanup-blocked": 0,
			invalidated: 0,
			abandoned: 0,
			total: 1,
		},
		ownership: "inactive",
		leasedElsewhere: false,
		requiresAttention: false,
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
		...overrides,
	};
}

describe("format helpers", () => {
	it("covers every run and task status with an icon", () => {
		const runStatuses = new Set([
			...NONTERMINAL_RUN_STATUSES,
			...ATTENTION_RUN_STATUSES,
			...TERMINAL_RUN_STATUSES,
		]);
		expect(Object.keys(RUN_STATUS_ICON).sort()).toEqual(
			[...runStatuses].sort(),
		);
		expect(Object.keys(TASK_STATUS_ICON)).toHaveLength(12);
		expect(isNonterminalRunStatus("running")).toBe(true);
		expect(isNonterminalRunStatus("failed")).toBe(false);
	});

	it("formats ages, deadlines, tokens, cost, and durations", () => {
		expect(formatAge("2026-09-15T12:04:48.000Z", NOW)).toBe("12s");
		expect(formatAge("2026-09-15T12:01:00.000Z", NOW)).toBe("4m");
		expect(formatAge("2026-09-15T09:05:00.000Z", NOW)).toBe("3h");
		expect(formatAge("2026-09-13T12:05:00.000Z", NOW)).toBe("2d");
		expect(formatAge("2026-09-15T12:06:00.000Z", NOW)).toBe("0s");
		expect(formatAge("not a date", NOW)).toBe("?");
		expect(formatUntil("2026-09-15T12:09:00.000Z", NOW)).toBe("in 4m");
		expect(formatUntil("2026-09-15T12:05:00.000Z", NOW)).toBe("passed");
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1234)).toBe("1.2k");
		expect(formatTokens(35_000)).toBe("35k");
		expect(formatCost(0.12345)).toBe("$0.1235");
		expect(formatDurationMs(850)).toBe("850 ms");
		expect(formatDurationMs(12_400)).toBe("12.4 s");
		expect(formatDurationMs(185_000)).toBe("3m 05s");
		expect(formatDurationMs(7_620_000)).toBe("2h 07m");
	});

	it("shortens ids and normalizes task keys", () => {
		expect(shortId("workflow_short")).toBe("workflow_short");
		expect(shortId("workflow_abcdefghijklmnop")).toBe("workflow_abc…");
		expect(taskPath({ namespace: ["phase-1"], key: "report" })).toBe(
			"phase-1/report",
		);
		expect(taskPath({ namespace: [], key: "report" })).toBe("report");
		expect(normalizeTaskKey(" /phase-1/report ")).toBe("phase-1/report");
		expect(normalizeTaskKey("report")).toBe("report");
	});

	it("shows the generation only after the first re-execution", () => {
		expect(formatGeneration(0)).toBe("");
		expect(formatGeneration(1)).toBe("");
		expect(formatGeneration(3)).toBe("gen 3/16");
	});

	it("labels ownership without deriving legality", () => {
		expect(ownershipLabel({ ownership: "owned" })).toBe("owned");
		expect(ownershipLabel({ ownership: "leased-elsewhere" })).toBe(
			"leased elsewhere",
		);
		expect(ownershipLabel({ ownership: "inactive" })).toBe("inactive");
	});

	it("renders run lines with the lease marker, depth, and actions", () => {
		expect(
			runLine(summary("running", { availableActions: ["stop", "wait"] })),
		).toBe(
			"  ▶ running            workflow_formatfixture01 release [stop, wait]",
		);
		expect(
			runLine(
				summary("waiting", {
					depth: 1,
					ownership: "leased-elsewhere",
					leasedElsewhere: true,
				}),
			),
		).toBe(
			"⇄ ◔ waiting            workflow_formatfixture01 release (depth 1) []",
		);
	});

	it("renders task lines with role, disposition, generation, and abandonment", () => {
		expect(taskLine(task())).toBe(
			"✓ completed       report                   agent",
		);
		expect(
			taskLine(
				task({
					id: "task_summary",
					namespace: ["phase-1"],
					key: "summary",
					kind: "support",
					role: "finalizer",
					disposition: "optional",
					status: "failed",
					generation: 3,
					attempts: 2,
					settlement: {
						attemptOrdinal: 2,
						status: "failed",
						failureCode: "provider-error",
						failureRetry: "manual",
						usageComplete: true,
					},
					abandoned: true,
				}),
			),
		).toBe(
			"● failed          phase-1/summary          support finalizer optional gen 3/16 · 2 attempt(s) · provider-error · abandoned",
		);
	});

	it("renders log lines with the normalized task key and abandonment", () => {
		const entry: WorkflowLogEntry = {
			sequence: 42,
			timestamp: "2026-09-15T12:03:00.000Z",
			kind: "task",
			taskId: "task_report",
			taskKey: "/report",
			message: "Task /report changed from running to failed.",
			status: "failed",
			abandoned: true,
		};
		expect(logLine(entry)).toBe(
			"   42 2026-09-15T12:03:00.000Z task         report Task /report changed from running to failed. (abandoned)",
		);
		expect(
			logLine({
				sequence: 1,
				timestamp: "2026-09-15T12:00:00.000Z",
				kind: "run",
				message: "Run status changed from created to running.",
			}),
		).toBe(
			"    1 2026-09-15T12:00:00.000Z run          Run status changed from created to running.",
		);
	});
});
