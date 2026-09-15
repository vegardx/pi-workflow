import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SubagentClient } from "@vegardx/pi-subagent";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { createWorkflowService } from "../src/service.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";
import {
	WORKFLOW_TOOL_DECLARATIONS,
	WorkflowServiceRunViewSchema,
	type WorkflowToolName,
} from "../src/tools.js";

function unavailableClient(): SubagentClient {
	const unavailable = vi.fn(async () => {
		throw new Error("unexpected subagent call");
	});
	return {
		preflight: unavailable,
		launch: unavailable,
		findByOperation: unavailable,
		status: unavailable,
		listRuns: unavailable,
		logs: unavailable,
		wait: unavailable,
		interrupt: unavailable,
		steer: unavailable,
		followUp: unavailable,
		retry: unavailable,
		resume: unavailable,
		reconcile: unavailable,
		release: unavailable,
		abandon: unavailable,
		pin: unavailable,
		unpin: unavailable,
		exportArtifact: unavailable,
	} as unknown as SubagentClient;
}

function provider(): WorkflowSubagentProvider {
	return {
		bind: vi.fn(
			async (runId: string) =>
				({
					workflowRunId: runId,
					ownerId: `pi-workflow:${runId}`,
					client: unavailableClient(),
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
	return { cwd, agentDir, storeRoot };
}

function declaration(name: WorkflowToolName) {
	const found = WORKFLOW_TOOL_DECLARATIONS.find(
		(candidate) => candidate.name === name,
	);
	if (!found) throw new Error(`missing tool declaration ${name}`);
	return found;
}

describe("workflow tool declarations", () => {
	it("declares seven uniquely named frozen tools with closed parameter schemas", () => {
		const names = WORKFLOW_TOOL_DECLARATIONS.map((tool) => tool.name);
		expect(names).toEqual([
			"workflow_list",
			"workflow_validate",
			"workflow_run",
			"workflow_status",
			"workflow_wait",
			"workflow_stop",
			"workflow_reconcile",
		]);
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
				}),
				workflow_stop: await declaration("workflow_stop").execute(service, {
					runId: (stoppable as { runId: string }).runId,
					reason: "tool schema test",
				}),
				workflow_reconcile: await declaration("workflow_reconcile").execute(
					service,
					{ runId },
				),
			};
			for (const tool of WORKFLOW_TOOL_DECLARATIONS) {
				const value = results[tool.name];
				expect(
					[...Value.Errors(tool.output, value)].map(
						(error) => `${tool.name} ${error.instancePath}: ${error.message}`,
					),
				).toEqual([]);
			}
			expect(results.workflow_list).toMatchObject([
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
			expect(results.workflow_stop).toMatchObject({ status: "cancelled" });
			expect(results.workflow_reconcile).toMatchObject({
				status: "completed",
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
		expect(
			Value.Check(WorkflowServiceRunViewSchema, {
				...view,
				depth: 4,
			}),
		).toBe(false);
	});
});
