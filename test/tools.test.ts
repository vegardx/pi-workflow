import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { encodeWorkflowRunCursor } from "../src/run-projection.js";
import { createWorkflowService } from "../src/service.js";
import {
	type WorkflowLogPage,
	type WorkflowRunInspection,
	type WorkflowRunPage,
	WorkflowServiceRunViewSchema,
} from "../src/service-views.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";
import {
	MAX_TOOL_OUTPUT_BYTES,
	WORKFLOW_TOOL_DECLARATIONS,
	type WorkflowToolName,
	workflowToolText,
} from "../src/tools.js";
import {
	attemptProvider,
	COMPLETED,
	childFailure,
	client,
	INTERRUPTED,
	operatorFixture,
} from "./fixtures/attempt-provider.js";

function provider(): WorkflowSubagentProvider {
	return {
		bind: vi.fn(
			async (runId: string) =>
				({
					workflowRunId: runId,
					ownerId: `pi-workflow:${runId}`,
					client: client(),
				}) satisfies WorkflowSubagentBinding,
		),
	};
}

async function fixture() {
	const base = path.resolve(".pi", "test-tools", randomUUID());
	const cwd = path.join(base, "project");
	const agentDir = path.join(base, "agent");
	const storeRoot = path.join(cwd, ".pi", "workflow");
	await mkdir(path.join(cwd, "workflows"), { recursive: true });
	await writeFile(
		path.join(cwd, "workflows", "example.workflow.ts"),
		`export default {
  schema: "pi-workflow-definition",
  meta: { name: "example", description: "Tool workflow", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 3600000, concurrency: 4 },
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  run(ctx) { return { answer: ctx.input.value }; }
};\n`,
	);
	await writeFile(
		path.join(cwd, "workflows", "stoppable.workflow.ts"),
		`export default {
  schema: "pi-workflow-definition",
  meta: { name: "stoppable", description: "Stoppable workflow", version: 1, budget: { cost: 10, childRuntimeMs: 60000 }, timeoutMs: 3600000, concurrency: 1 },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  run(ctx) { return new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve({ answer: "late" }), { once: true })); }
};\n`,
	);
	// The unavailable client fails the agent task at preflight, so the run
	// ends failed with one settled task: the shape workflow_invalidate needs.
	await writeFile(
		path.join(cwd, "workflows", "delegating.workflow.ts"),
		`export default {
  schema: "pi-workflow-definition",
  meta: { name: "delegating", description: "Delegating workflow", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 3600000, concurrency: 4 },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  run(ctx) {
    return ctx.agent("answer", {
      agent: "researcher",
      task: { goal: "Answer", context: [], instructions: ["Return structured output."] },
      contextMode: "fresh",
      tools: ["read"],
      preloadSkills: [],
      contextScopes: ["project"],
      workspace: { mode: "read-only", cwd: ctx.cwd },
      outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
      limits: { cumulativeRuntimeMs: 300000, attemptTimeoutMs: 300000, totalTokens: 1000000, cost: 10, outputBytes: 1024, workspaceWriteBytes: 0, retries: 0, resumes: 0 }
    });
  }
};\n`,
	);
	return { cwd, agentDir, storeRoot };
}

/**
 * Real results for the operator attempt tools. The scripted owner client
 * settles children so both paths complete: launch 1 is interrupted with a
 * resumable failure and completes once resumed on its existing child run;
 * launch 2 fails and its retry, generation 2 on launch 3, completes.
 */
async function operatorResults() {
	const delegated = attemptProvider((launch) =>
		launch === 1
			? [INTERRUPTED, COMPLETED]
			: launch === 2
				? [{ status: "failed", failure: childFailure("manual") }]
				: [COMPLETED],
	);
	const service = await createWorkflowService({
		...(await operatorFixture()),
		projectTrusted: () => true,
		subagents: delegated.provider,
	});
	try {
		const interrupted = await service.run("attempts", {});
		expect(await service.wait(interrupted.runId)).toMatchObject({
			status: "interrupted",
		});
		const resumed = await declaration("workflow_resume").execute(service, {
			runId: interrupted.runId,
			reason: "tool schema test",
		});
		expect(await service.wait(interrupted.runId)).toMatchObject({
			status: "completed",
			tasks: [expect.objectContaining({ generation: 1, attempts: 1 })],
		});
		const failed = await service.run("attempts", {});
		const failedView = await service.wait(failed.runId);
		expect(failedView.status).toBe("failed");
		const taskId = failedView.tasks?.[0]?.id;
		if (!taskId) throw new Error("failed run has no task");
		const retried = await declaration("workflow_retry").execute(service, {
			runId: failed.runId,
			taskId,
			reason: "tool schema test",
		});
		expect(await service.wait(failed.runId)).toMatchObject({
			status: "completed",
			tasks: [expect.objectContaining({ id: taskId, generation: 2 })],
		});
		expect(delegated.ownerClient.resume).toHaveBeenCalledOnce();
		expect(delegated.ownerClient.retry).not.toHaveBeenCalled();
		expect(delegated.ownerClient.launch).toHaveBeenCalledTimes(3);
		return {
			interruptedRunId: interrupted.runId,
			failedRunId: failed.runId,
			workflow_retry: retried,
			workflow_resume: resumed,
		};
	} finally {
		await service.shutdown();
	}
}

function declaration(name: WorkflowToolName) {
	const found = WORKFLOW_TOOL_DECLARATIONS.find(
		(candidate) => candidate.name === name,
	);
	if (!found) throw new Error(`missing tool declaration ${name}`);
	return found;
}

const TOOL_NAMES: readonly WorkflowToolName[] = [
	"workflow_list",
	"workflow_validate",
	"workflow_run",
	"workflow_status",
	"workflow_wait",
	"workflow_stop",
	"workflow_reconcile",
	"workflow_runs",
	"workflow_inspect",
	"workflow_logs",
	"workflow_invalidate",
	"workflow_retry",
	"workflow_resume",
];

describe("workflow tool declarations", () => {
	it("declares thirteen uniquely named frozen tools with closed parameter schemas", () => {
		const names = WORKFLOW_TOOL_DECLARATIONS.map((tool) => tool.name);
		expect(names).toEqual(TOOL_NAMES);
		expect(new Set(names).size).toBe(names.length);
		expect(Object.isFrozen(WORKFLOW_TOOL_DECLARATIONS)).toBe(true);
		for (const tool of WORKFLOW_TOOL_DECLARATIONS) {
			expect(Object.isFrozen(tool)).toBe(true);
			expect(Object.isFrozen(tool.promptGuidelines)).toBe(true);
			expect(tool.label.length).toBeGreaterThan(0);
			expect(tool.description.length).toBeGreaterThan(0);
			expect(tool.parameters).toMatchObject({
				type: "object",
				additionalProperties: false,
			});
			expect(tool.output).toHaveProperty("type");
		}
		const runId = "workflow_toolparams";
		const wait = declaration("workflow_wait").parameters;
		expect(Value.Check(wait, { runId })).toBe(true);
		expect(Value.Check(wait, { runId, timeoutMs: 1_000 })).toBe(true);
		expect(Value.Check(wait, { runId, timeoutMs: 999 })).toBe(false);
		expect(Value.Check(wait, { runId, timeoutMs: 3_600_001 })).toBe(false);
		const reconcile = declaration("workflow_reconcile").parameters;
		expect(Value.Check(reconcile, { runId })).toBe(true);
		expect(Value.Check(reconcile, { runId, taskId: "task_abcdef" })).toBe(true);
		expect(Value.Check(reconcile, { runId, taskId: "bad" })).toBe(false);
		expect(Value.Check(reconcile, { runId, extra: true })).toBe(false);
		const inspect = declaration("workflow_inspect").parameters;
		expect(
			Value.Check(inspect, {
				runId,
				include: ["run", "tasks"],
				taskId: "task_a",
			}),
		).toBe(true);
		expect(Value.Check(inspect, { runId, include: [] })).toBe(false);
		expect(Value.Check(inspect, { runId, include: ["prompts"] })).toBe(false);
		const logs = declaration("workflow_logs").parameters;
		expect(Value.Check(logs, { runId, afterSequence: 0, limit: 500 })).toBe(
			true,
		);
		expect(Value.Check(logs, { runId, limit: 501 })).toBe(false);
		const runs = declaration("workflow_runs").parameters;
		expect(Value.Check(runs, {})).toBe(true);
		expect(
			Value.Check(runs, {
				statuses: ["failed"],
				includeChildren: true,
				limit: 100,
			}),
		).toBe(true);
		expect(Value.Check(runs, { statuses: [] })).toBe(false);
		expect(Value.Check(runs, { limit: 101 })).toBe(false);
		const invalidate = declaration("workflow_invalidate").parameters;
		expect(
			Value.Check(invalidate, { runId, taskId: "task_abcdef", reason: "why" }),
		).toBe(true);
		expect(Value.Check(invalidate, { runId, taskId: "task_abcdef" })).toBe(
			false,
		);
		const retry = declaration("workflow_retry");
		expect(
			Value.Check(retry.parameters, {
				runId,
				taskId: "task_abcdef",
				reason: "why",
			}),
		).toBe(true);
		expect(Value.Check(retry.parameters, { runId, reason: "why" })).toBe(false);
		expect(
			retry.summarizeCall({ runId, taskId: "task_abcdef", reason: "why" }),
		).toBe(`${runId} · task_abcdef`);
		const resume = declaration("workflow_resume");
		expect(Value.Check(resume.parameters, { runId, reason: "why" })).toBe(true);
		expect(
			Value.Check(resume.parameters, {
				runId,
				reason: "why",
				taskId: "task_abcdef",
			}),
		).toBe(true);
		expect(Value.Check(resume.parameters, { runId, reason: "" })).toBe(false);
		expect(
			Value.Check(resume.parameters, { runId, taskId: "task_abcdef" }),
		).toBe(false);
		expect(resume.summarizeCall({ runId, reason: "why" })).toBe(runId);
		expect(
			resume.summarizeCall({ runId, reason: "why", taskId: "task_abcdef" }),
		).toBe(`${runId} · task_abcdef`);
	});

	it("validates every real service result against its declared output schema", async () => {
		const service = await createWorkflowService({
			...(await fixture()),
			projectTrusted: () => true,
			subagents: provider(),
		});
		try {
			const receipt = await declaration("workflow_run").execute(service, {
				ref: "example",
				input: { value: "yes" },
			});
			const runId = (receipt as { runId: string }).runId;
			const stoppable = await declaration("workflow_run").execute(service, {
				ref: "stoppable",
				input: {},
			});
			const delegating = await declaration("workflow_run").execute(service, {
				ref: "delegating",
				input: {},
			});
			const delegatingRunId = (delegating as { runId: string }).runId;
			const failed = await declaration("workflow_wait").execute(service, {
				runId: delegatingRunId,
			});
			expect(failed).toMatchObject({ status: "failed" });
			const failedTaskId = (failed as { tasks: { id: string }[] }).tasks[0]?.id;
			if (!failedTaskId) throw new Error("delegating run has no task");
			const invalidated = await declaration("workflow_invalidate").execute(
				service,
				{
					runId: delegatingRunId,
					taskId: failedTaskId,
					reason: "tool schema test",
				},
			);
			await service.wait(delegatingRunId);
			const operator = await operatorResults();
			const results: Record<WorkflowToolName, unknown> = {
				workflow_list: await declaration("workflow_list").execute(service, {}),
				workflow_validate: await declaration("workflow_validate").execute(
					service,
					{ ref: "example", input: { value: "yes" } },
				),
				workflow_run: receipt,
				workflow_status: await declaration("workflow_status").execute(service, {
					runId,
				}),
				workflow_wait: await declaration("workflow_wait").execute(service, {
					runId,
					timeoutMs: 60_000,
				}),
				workflow_stop: await declaration("workflow_stop").execute(service, {
					runId: (stoppable as { runId: string }).runId,
					reason: "tool schema test",
				}),
				workflow_reconcile: await declaration("workflow_reconcile").execute(
					service,
					{ runId },
				),
				workflow_runs: await declaration("workflow_runs").execute(service, {
					limit: 10,
				}),
				workflow_inspect: await declaration("workflow_inspect").execute(
					service,
					{
						runId: delegatingRunId,
						include: [
							"run",
							"budget",
							"tasks",
							"executions",
							"effects",
							"barriers",
							"artifacts",
						],
					},
				),
				workflow_logs: await declaration("workflow_logs").execute(service, {
					runId: delegatingRunId,
					afterSequence: 0,
					limit: 100,
				}),
				workflow_invalidate: invalidated,
				workflow_retry: operator.workflow_retry,
				workflow_resume: operator.workflow_resume,
			};
			for (const tool of WORKFLOW_TOOL_DECLARATIONS) {
				const value = results[tool.name];
				expect(
					[...Value.Errors(tool.output, value)].map(
						(error) => `${tool.name} ${error.instancePath}: ${error.message}`,
					),
				).toEqual([]);
				// The text block is the checked value as bounded JSON.
				expect(JSON.parse(workflowToolText(tool, value))).toEqual(
					JSON.parse(JSON.stringify(value)),
				);
			}
			expect(results.workflow_list).toMatchObject([
				{ name: "delegating", scope: "project" },
				{ name: "example", scope: "project" },
				{ name: "stoppable", scope: "project" },
			]);
			expect(results.workflow_validate).toMatchObject({
				valid: true,
				workflow: { name: "example" },
			});
			expect(results.workflow_wait).toMatchObject({
				runId,
				status: "completed",
				definitionName: "example",
				depth: 0,
				output: { answer: "yes" },
				tasks: [],
			});
			expect(results.workflow_wait).not.toHaveProperty("timedOut");
			expect(results.workflow_stop).toMatchObject({ status: "cancelled" });
			expect(results.workflow_reconcile).toMatchObject({
				status: "completed",
				reconciled: [],
			});
			const page = results.workflow_runs as WorkflowRunPage;
			expect(page.total).toBe(3);
			expect(page.runs.map((run) => run.runId)).toContain(runId);
			expect(page.issues).toEqual([]);
			const inspection = results.workflow_inspect as WorkflowRunInspection;
			expect(inspection.run.runId).toBe(delegatingRunId);
			expect(inspection.tasks?.[0]).toMatchObject({
				id: failedTaskId,
				kind: "agent",
				role: "task",
				generation: 2,
			});
			expect(inspection.executions).toHaveLength(2);
			const logs = results.workflow_logs as WorkflowLogPage;
			expect(logs.runId).toBe(delegatingRunId);
			expect(logs.entries.some((entry) => entry.kind === "invalidation")).toBe(
				true,
			);
			expect(results.workflow_invalidate).toMatchObject({
				runId: delegatingRunId,
			});
			expect(results.workflow_retry).toMatchObject({
				runId: operator.failedRunId,
				definitionName: "attempts",
			});
			expect(results.workflow_retry).not.toMatchObject({ status: "failed" });
			expect(results.workflow_resume).toMatchObject({
				runId: operator.interruptedRunId,
				definitionName: "attempts",
			});
			expect(results.workflow_resume).not.toMatchObject({
				status: "interrupted",
			});
		} finally {
			await service.shutdown();
		}
	});

	it("rejects run views that leave the declared shape", () => {
		const view = {
			runId: "workflow_abcdefghij",
			status: "completed",
			definitionName: "example",
			createdAt: "2026-09-15T00:00:00.000Z",
			deadlineAt: "2026-09-15T01:00:00.000Z",
			depth: 0,
			tasks: [],
		};
		expect(Value.Check(WorkflowServiceRunViewSchema, view)).toBe(true);
		expect(
			Value.Check(WorkflowServiceRunViewSchema, { ...view, extra: true }),
		).toBe(false);
		expect(
			Value.Check(WorkflowServiceRunViewSchema, { ...view, status: "done" }),
		).toBe(false);
		expect(
			Value.Check(WorkflowServiceRunViewSchema, {
				...view,
				tasks: [{ id: "task_x", key: "a" }],
			}),
		).toBe(false);
		const finalizer = {
			id: "task_abcdef",
			namespace: [],
			key: "cleanup",
			kind: "support",
			role: "finalizer",
			disposition: "required",
			status: "completed",
			generation: 1,
		};
		const { role: _role, ...roleless } = finalizer;
		expect(
			Value.Check(WorkflowServiceRunViewSchema, {
				...view,
				tasks: [finalizer],
			}),
		).toBe(true);
		expect(
			Value.Check(WorkflowServiceRunViewSchema, { ...view, tasks: [roleless] }),
		).toBe(false);
		expect(
			Value.Check(WorkflowServiceRunViewSchema, {
				...view,
				tasks: [{ ...finalizer, role: "cleanup" }],
			}),
		).toBe(false);
		expect(() =>
			workflowToolText(declaration("workflow_status"), {
				...view,
				extra: true,
			}),
		).toThrow("workflow tool output violates its schema");
	});

	describe("text bounding", () => {
		const createdAt = "2026-09-15T00:00:00.000Z";
		function summary(index: number) {
			return {
				runId: `workflow_${index.toString(36).padStart(12, "0")}`,
				definitionName: "example",
				status: "completed" as const,
				createdAt,
				updatedAt: createdAt,
				deadlineAt: "2026-09-15T01:00:00.000Z",
				depth: 0,
				lastSequence: 4,
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
				ownership: "inactive" as const,
				leasedElsewhere: false,
				availableActions: [],
				requiresAttention: false,
			};
		}

		it("shrinks an oversized run page and re-cursors at the last kept run", () => {
			const runs = Array.from({ length: 100 }, (_, index) => summary(index));
			const page: WorkflowRunPage = {
				runs,
				total: 250,
				issues: [],
				issuesTruncated: 0,
				generatedAt: createdAt,
			};
			const text = workflowToolText(declaration("workflow_runs"), page);
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
				MAX_TOOL_OUTPUT_BYTES,
			);
			const bounded = JSON.parse(text) as WorkflowRunPage;
			expect(bounded.runs.length).toBeGreaterThan(0);
			expect(bounded.runs.length).toBeLessThan(runs.length);
			expect(bounded.runs).toEqual(runs.slice(0, bounded.runs.length));
			expect(bounded.total).toBe(250);
			const last = bounded.runs.at(-1);
			if (!last) throw new Error("no runs kept");
			expect(bounded.nextCursor).toBe(encodeWorkflowRunCursor(last));
			const small = { ...page, runs: runs.slice(0, 2) };
			expect(
				JSON.parse(workflowToolText(declaration("workflow_runs"), small)),
			).toEqual(small);
		});

		it("shrinks an oversized log page and re-cursors at the last kept sequence", () => {
			const entries = Array.from({ length: 500 }, (_, index) => ({
				sequence: index + 1,
				timestamp: createdAt,
				kind: "log" as const,
				message: "x".repeat(200),
			}));
			const page: WorkflowLogPage = {
				runId: "workflow_abcdefghij",
				entries,
				lastSequence: 900,
			};
			const text = workflowToolText(declaration("workflow_logs"), page);
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
				MAX_TOOL_OUTPUT_BYTES,
			);
			const bounded = JSON.parse(text) as WorkflowLogPage;
			expect(bounded.entries.length).toBeGreaterThan(0);
			expect(bounded.entries.length).toBeLessThan(entries.length);
			expect(bounded.entries).toEqual(entries.slice(0, bounded.entries.length));
			expect(bounded.nextAfterSequence).toBe(bounded.entries.at(-1)?.sequence);
			expect(bounded.lastSequence).toBe(900);
		});

		it("refuses an oversized inspection instead of cutting it", () => {
			const inspection: WorkflowRunInspection = {
				run: summary(1),
				effects: Array.from({ length: 256 }, (_, index) => ({
					ordinal: index + 1,
					kind: "log" as const,
					value: "y".repeat(400),
					sequence: index + 1,
				})),
				truncated: {},
			};
			expect(() =>
				workflowToolText(declaration("workflow_inspect"), inspection),
			).toThrow(
				"Workflow inspection exceeds the tool output bound; narrow include or pass taskId.",
			);
			const small = { ...inspection, effects: [] };
			expect(
				JSON.parse(workflowToolText(declaration("workflow_inspect"), small)),
			).toEqual(small);
		});

		it("omits an oversized run output and truncates the legacy list", () => {
			const view = {
				runId: "workflow_abcdefghij",
				status: "completed",
				definitionName: "example",
				createdAt,
				deadlineAt: "2026-09-15T01:00:00.000Z",
				depth: 0,
				output: { blob: "z".repeat(MAX_TOOL_OUTPUT_BYTES) },
				tasks: [],
			};
			const text = workflowToolText(declaration("workflow_status"), view);
			expect(text).toContain("[Workflow output omitted from tool context");
			expect(JSON.parse(text.split("\n\n")[0] ?? "")).toEqual({
				...view,
				output: undefined,
			});
			const list = Array.from({ length: 256 }, (_, index) => ({
				name: `workflow-${index}`,
				description: "d".repeat(1024),
				version: 1,
				concurrency: 4,
				budget: { cost: 1, childRuntimeMs: 60_000 },
				timeoutMs: 60_000,
				scope: "project" as const,
				source: "project",
				path: "/workflows/x.workflow.ts",
				identitySha256: "a".repeat(64),
			}));
			const listText = workflowToolText(declaration("workflow_list"), list);
			expect(Buffer.byteLength(listText)).toBeLessThanOrEqual(
				MAX_TOOL_OUTPUT_BYTES,
			);
			const bounded = JSON.parse(listText) as unknown[];
			expect(bounded.at(-1)).toEqual({ truncated: true, totalItems: 256 });
			expect(bounded.length).toBeLessThan(257);
		});
	});
});
