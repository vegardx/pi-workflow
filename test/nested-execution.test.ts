import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SubagentClient } from "@vegardx/pi-subagent";
import { describe, expect, it, vi } from "vitest";
import { createWorkflowService } from "../src/service.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";

function root(name: string): string {
	return path.resolve(
		".pi",
		"test-nested-execution",
		`${name}-${randomUUID()}`,
	);
}

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
];

function strictClient(calls: string[]): SubagentClient {
	const client: Record<string, unknown> = {};
	for (const method of CLIENT_METHODS) {
		client[method] = vi.fn(async () => {
			calls.push(method);
			throw new Error(`unexpected subagent call: ${method}`);
		});
	}
	return client as unknown as SubagentClient;
}

function provider(calls: string[], bound: string[]): WorkflowSubagentProvider {
	return {
		bind: vi.fn(async (runId: string) => {
			bound.push(runId);
			return {
				workflowRunId: runId,
				ownerId: `pi-workflow:${runId}`,
				client: strictClient(calls),
			} satisfies WorkflowSubagentBinding;
		}),
	};
}

const CHILD = `export default {
  schema: "pi-workflow-definition",
  meta: { name: "echo-child", description: "Child", version: 1, budget: { cost: 1, childRuntimeMs: 60000 }, timeoutMs: 600000, concurrency: 2 },
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  run(ctx) { ctx.phase("child"); return { answer: ctx.input.value.toUpperCase() }; }
};
`;

const PARENT = `export default {
  schema: "pi-workflow-definition",
  meta: { name: "nest-parent", description: "Parent", version: 1, budget: { cost: 5, childRuntimeMs: 120000 }, timeoutMs: 600000, concurrency: 2 },
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  run(ctx) { return ctx.workflow("child", { workflow: "echo-child", input: { value: ctx.input.value } }); }
};
`;

async function fixture(name: string, definitions: Record<string, string>) {
	const base = root(name);
	const cwd = path.join(base, "project");
	const agentDir = path.join(base, "agent");
	const storeRoot = path.join(cwd, ".pi", "workflow");
	await mkdir(path.join(cwd, "workflows"), { recursive: true });
	for (const [file, source] of Object.entries(definitions)) {
		await writeFile(path.join(cwd, "workflows", `${file}.workflow.ts`), source);
	}
	return { cwd, agentDir, storeRoot };
}

async function eventTypes(storeRoot: string, runId: string) {
	const journal = await readFile(
		path.join(storeRoot, "runs", runId, "events.jsonl"),
		"utf8",
	);
	return journal
		.trim()
		.split("\n")
		.map((line) => (JSON.parse(line) as { type: string }).type);
}

describe("nested workflow execution", { timeout: 15_000 }, () => {
	it("runs a child workflow as a linked run and returns its output", async () => {
		const calls: string[] = [];
		const bound: string[] = [];
		const fx = await fixture("parent-child", { child: CHILD, parent: PARENT });
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider(calls, bound),
		});
		const receipt = await service.run("nest-parent", { value: "yes" });
		const view = await service.wait(receipt.runId);
		expect(view).toMatchObject({
			status: "completed",
			output: { answer: "YES" },
			depth: 0,
		});
		expect(calls).toEqual([]);
		expect(bound).toHaveLength(2);
		expect(bound[0]).toBe(receipt.runId);
		const childRunId = bound[1] as string;
		await expect(service.status(childRunId)).resolves.toMatchObject({
			status: "completed",
			definitionName: "echo-child",
			depth: 1,
			parent: { runId: receipt.runId },
			output: { answer: "YES" },
		});
		const types = await eventTypes(fx.storeRoot, receipt.runId);
		const nested = types.filter((type) =>
			[
				"task-execution-created",
				"task-execution-nested-intended",
				"task-execution-nested-launched",
				"task-execution-nested-settled",
				"artifact-declared",
				"task-execution-nested-output-imported",
				"task-execution-terminal",
			].includes(type),
		);
		expect(nested).toEqual([
			"task-execution-created",
			"task-execution-nested-intended",
			"task-execution-nested-launched",
			"task-execution-nested-settled",
			"artifact-declared",
			"task-execution-nested-output-imported",
			"task-execution-terminal",
			"artifact-declared",
		]);
		await service.shutdown();
	});
});
