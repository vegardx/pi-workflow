import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_DYNAMIC_APPROVAL_RENDER_BYTES } from "../src/dynamic/constants.js";
import type { DynamicWorkflowProposalInspection } from "../src/service.js";
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
	renderDynamicProposal,
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
		pendingCheckpointCount: 0,
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

function proposal(
	overrides: Partial<DynamicWorkflowProposalInspection> = {},
): DynamicWorkflowProposalInspection {
	return {
		ref: `dynamic:${"a".repeat(64)}`,
		sourceSha256: "a".repeat(64),
		sourceBytes: 42,
		manifest: {
			meta: {
				name: "triage",
				description: "Sorts issues",
				version: 2,
				budget: { cost: 1.5, childRuntimeMs: 185_000, totalTokens: 35_000 },
				timeoutMs: 7_620_000,
				concurrency: 3,
			},
			inputSchema: { type: "object", properties: { b: {}, a: {} } },
			outputSchema: { type: "object" },
		},
		manifestSha256: "b".repeat(64),
		hostApiSha256: "c".repeat(64),
		importPolicySha256: "d".repeat(64),
		definitionIdentitySha256: "e".repeat(64),
		transformer: { name: "amaro", version: "1.0.0" },
		proposer: { kind: "tool", via: "workflow_propose" },
		proposedAt: "2026-09-15T12:00:00.000Z",
		runnable: false,
		path: "/store/dynamic/aaa/source.workflow.ts",
		source: 'export default 1;\nconst x = "two";\n',
		...overrides,
	} as DynamicWorkflowProposalInspection;
}

describe("renderDynamicProposal", () => {
	it("renders identity, budget, decision state, canonical schemas, and the numbered source", () => {
		expect(renderDynamicProposal(proposal()).split("\n")).toEqual([
			`Dynamic workflow dynamic:${"a".repeat(64)}`,
			"name: triage v2 · concurrency 3 · budget $1.5000 · 35k tok · 3m 05s child runtime · timeout 2h 07m",
			"description: Sorts issues",
			"proposed: 2026-09-15T12:00:00.000Z by tool:workflow_propose",
			"decision: none (awaiting a human decision)",
			"runnable: no",
			`host API: ${"c".repeat(64)}`,
			`import policy: ${"d".repeat(64)}`,
			`identity: ${"e".repeat(64)}`,
			'input schema: {"properties":{"a":{},"b":{}},"type":"object"}',
			'output schema: {"type":"object"}',
			`source (42 bytes, sha256 ${"a".repeat(64)}):`,
			"   1 │ export default 1;",
			'   2 │ const x = "two";',
			"   3 │ ",
		]);
		const decided = renderDynamicProposal(
			proposal({
				runnable: true,
				manifest: {
					...proposal().manifest,
					meta: {
						...proposal().manifest.meta,
						budget: { cost: 10, childRuntimeMs: 600_000 },
					},
				},
				decision: {
					decision: "approved",
					approver: {
						kind: "human",
						via: "/workflow approve",
						sessionId: "s1",
					},
					approvedAt: "2026-09-15T12:30:00.000Z",
					approvalSha256: "f".repeat(64),
					reason: "Reviewed.",
				},
			}),
		).split("\n");
		expect(decided[1]).toBe(
			"name: triage v2 · concurrency 3 · budget $10.0000 · 10m 00s child runtime · timeout 2h 07m",
		);
		expect(decided[4]).toBe(
			"decision: approved at 2026-09-15T12:30:00.000Z by human:/workflow approve (Reviewed.)",
		);
		expect(decided[5]).toBe("runnable: yes");
	});

	it("cuts the source to the render bound and points at the stored file", () => {
		const line = `const padding = "${"x".repeat(60)}";`;
		const lines = 2_000;
		const source = Array.from({ length: lines }, () => line).join("\n");
		const rendered = renderDynamicProposal(
			proposal({ source, sourceBytes: Buffer.byteLength(source) }),
		);
		expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(
			MAX_DYNAMIC_APPROVAL_RENDER_BYTES,
		);
		const renderedLines = rendered.split("\n");
		expect(renderedLines.at(-1)).toBe(
			`… source truncated at ${MAX_DYNAMIC_APPROVAL_RENDER_BYTES} bytes; read /store/dynamic/aaa/source.workflow.ts before approving.`,
		);
		const kept = renderedLines.filter((entry) => entry.includes(" │ "));
		expect(kept.length).toBeGreaterThan(100);
		expect(kept.length).toBeLessThan(lines);
		expect(kept[0]).toBe(`   1 │ ${line}`);
		expect(kept.at(-1)).toBe(`${String(kept.length).padStart(4)} │ ${line}`);
		// One more source line would cross the bound.
		expect(
			Buffer.byteLength(rendered) + Buffer.byteLength(`\n${kept[0]}`),
		).toBeGreaterThan(MAX_DYNAMIC_APPROVAL_RENDER_BYTES);
		// A body exactly within the bound is never cut.
		expect(renderDynamicProposal(proposal())).not.toContain("truncated");
	});

	it("stays pure: no pi-tui import and no service call", async () => {
		const source = await readFile(path.resolve("src/ui/format.ts"), "utf8");
		expect(source).not.toMatch(/@earendil-works\/pi-tui/);
		// Only a type reaches the service module; nothing is loaded from it.
		expect(source).not.toMatch(
			/^import\s+(?!type\b)[^;]*?from\s+"\.\.\/service\.js"/m,
		);
		expect(source).toMatch(
			/import type \{ DynamicWorkflowProposalInspection \}/,
		);
	});
});
