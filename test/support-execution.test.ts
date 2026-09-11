import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SubagentClient } from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createWorkflowService } from "../src/service.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";
import { defineSupportTask } from "../src/support.js";

const TOOLS_MODULE = "@vegardx/workflow-tools";
const UPPER_NAME = `${TOOLS_MODULE}/upper`;
const UPPER_SHA256 = "a".repeat(64);
const PARAMETERS_SCHEMA = {
	type: "object",
	properties: { value: { type: "string" } },
	required: ["value"],
};
const OUTPUT_SCHEMA = {
	type: "object",
	properties: { answer: { type: "string" } },
	required: ["answer"],
};

const upper = defineSupportTask({
	name: UPPER_NAME,
	moduleSpecifier: TOOLS_MODULE,
	revision: 1,
	implementationSha256: UPPER_SHA256,
	parametersSchema: Type.Object({ value: Type.String() }),
	outputSchema: Type.Object({ answer: Type.String() }),
});

function root(name: string): string {
	return path.resolve(
		".pi",
		"test-support-execution",
		`${name}-${randomUUID()}`,
	);
}

function strictClient(calls: string[]): SubagentClient {
	const methods = [
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
	const client: Record<string, unknown> = {};
	for (const method of methods) {
		client[method] = vi.fn(async () => {
			calls.push(method);
			throw new Error(`unexpected subagent call: ${method}`);
		});
	}
	return client as unknown as SubagentClient;
}

function provider(calls: string[]): WorkflowSubagentProvider {
	return {
		bind: vi.fn(
			async (runId: string) =>
				({
					workflowRunId: runId,
					ownerId: `pi-workflow:${runId}`,
					client: strictClient(calls),
				}) satisfies WorkflowSubagentBinding,
		),
	};
}

async function fixture(name: string, source: string) {
	const base = root(name);
	const cwd = path.join(base, "project");
	const agentDir = path.join(base, "agent");
	const storeRoot = path.join(cwd, ".pi", "workflow");
	const packageDir = path.join(cwd, "node_modules", ...TOOLS_MODULE.split("/"));
	await mkdir(path.join(cwd, "workflows"), { recursive: true });
	await mkdir(packageDir, { recursive: true });
	await writeFile(
		path.join(packageDir, "package.json"),
		JSON.stringify({ name: TOOLS_MODULE, type: "module", main: "index.js" }),
	);
	await writeFile(
		path.join(packageDir, "index.js"),
		`export function upper(call) {
  return Object.freeze({
    schema: "pi-workflow-support-task-descriptor",
    implementation: ${JSON.stringify(UPPER_NAME)},
    moduleSpecifier: ${JSON.stringify(TOOLS_MODULE)},
    revision: 1,
    implementationSha256: ${JSON.stringify(UPPER_SHA256)},
    parameters: call.parameters,
    parametersSchema: ${JSON.stringify(PARAMETERS_SCHEMA)},
    outputSchema: ${JSON.stringify(OUTPUT_SCHEMA)},
    ...(call.inputs ? { inputs: call.inputs } : {}),
    ...(call.disposition ? { disposition: call.disposition } : {}),
  });
}
`,
	);
	const definitionPath = path.join(cwd, "workflows", `${name}.workflow.ts`);
	await writeFile(definitionPath, source);
	return { cwd, agentDir, storeRoot, definitionPath };
}

const SUPPORT_ONLY = `import { upper } from "@vegardx/workflow-tools";
export default {
  schema: "pi-workflow-definition",
  meta: { name: "support-only", description: "Support only", version: 1, budget: { cost: 1, childRuntimeMs: 60000 }, timeoutMs: 600000, concurrency: 2 },
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  run(ctx) { return ctx.support("shout", upper({ parameters: { value: ctx.input.value } })); }
};
`;

describe("support task execution", () => {
	it("completes a support-only workflow without any subagent call", async () => {
		const calls: string[] = [];
		const fx = await fixture("support-only", SUPPORT_ONLY);
		const execute = vi.fn(
			({ parameters }: { parameters: { value: string } }) => ({
				answer: parameters.value.toUpperCase(),
			}),
		);
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider(calls),
			supportTasks: [upper.registration(execute)],
		});
		const receipt = await service.run("support-only", { value: "yes" });
		await expect(service.wait(receipt.runId)).resolves.toMatchObject({
			status: "completed",
			output: { answer: "YES" },
		});
		expect(calls).toEqual([]);
		expect(execute).toHaveBeenCalledTimes(1);
		const journal = await readFile(
			path.join(fx.storeRoot, "runs", receipt.runId, "events.jsonl"),
			"utf8",
		);
		const types = journal
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as { type: string }).type);
		const supportSequence = types.filter((type) =>
			[
				"task-execution-created",
				"task-execution-support-intended",
				"artifact-declared",
				"task-execution-support-output-committed",
				"task-execution-terminal",
			].includes(type),
		);
		expect(supportSequence).toEqual([
			"task-execution-created",
			"task-execution-support-intended",
			"artifact-declared",
			"task-execution-support-output-committed",
			"task-execution-terminal",
			"artifact-declared",
		]);
		await service.shutdown();
	});
});
