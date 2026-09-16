import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SubagentClient } from "@vegardx/pi-subagent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowSubagentProvider } from "../src/subagent-provider.js";

// Project discovery loads every workflow file through jiti, so the service
// must discover once per run or resume and never on status reads. The loader
// is wrapped, not replaced: every call still performs the real discovery.
const discoveries = vi.fn();
vi.mock("../src/registry.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/registry.js")>();
	return {
		...actual,
		discoverWorkflows: (
			...args: Parameters<typeof actual.discoverWorkflows>
		) => {
			discoveries(...args);
			return actual.discoverWorkflows(...args);
		},
	};
});

const { createWorkflowService } = await import("../src/service.js");

function definition(name: string, answer: string): string {
	return `export default {
  schema: "pi-workflow-definition",
  meta: { name: ${JSON.stringify(name)}, description: "Discovery workflow", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 3600000, concurrency: 4 },
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  run(ctx) { return { answer: ${JSON.stringify(answer)} + ctx.input.value }; }
};
`;
}

function provider(): WorkflowSubagentProvider {
	const unavailable = async () => {
		throw new Error("unexpected subagent call");
	};
	return {
		async bind(runId: string) {
			return {
				workflowRunId: runId,
				ownerId: `pi-workflow:${runId}`,
				client: new Proxy({} as SubagentClient, { get: () => unavailable }),
			};
		},
	};
}

const services: Array<{ shutdown(): Promise<void> }> = [];

async function recordedSource(
	storeRoot: string,
	runId: string,
): Promise<string> {
	const record = JSON.parse(
		await readFile(path.join(storeRoot, "runs", runId, "service.json"), "utf8"),
	) as { definitionSourceSha256: string };
	return record.definitionSourceSha256;
}

afterEach(async () => {
	await Promise.all(services.map((service) => service.shutdown()));
	services.length = 0;
	discoveries.mockClear();
});

describe("service project discovery", () => {
	it("discovers once per run, never for status or wait, and re-discovers an edited definition", async () => {
		const base = path.resolve(".pi", "test-service-discovery", randomUUID());
		const cwd = path.join(base, "project");
		const agentDir = path.join(base, "agent");
		const definitionPath = path.join(cwd, "workflows", "example.workflow.ts");
		await mkdir(path.join(cwd, "workflows"), { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(definitionPath, definition("example", "first "));
		const storeRoot = path.join(cwd, ".pi", "workflow");
		const service = await createWorkflowService({
			cwd,
			agentDir,
			storeRoot,
			projectTrusted: () => true,
			subagents: provider(),
		});
		services.push(service);
		expect(discoveries).toHaveBeenCalledTimes(0);

		const first = await service.run("example", { value: "x" });
		expect(discoveries).toHaveBeenCalledTimes(1);
		const firstView = await service.wait(first.runId);
		expect(firstView).toMatchObject({
			status: "completed",
			output: { answer: "first x" },
		});
		await service.status(first.runId);
		await service.inspect(first.runId, { include: ["tasks"] });
		expect(discoveries).toHaveBeenCalledTimes(1);

		// Every run resolves and verifies the definition on disk: an edit is
		// what the next run executes and records, with a new source identity.
		await writeFile(definitionPath, definition("example", "second "));
		const second = await service.run("example", { value: "y" });
		expect(discoveries).toHaveBeenCalledTimes(2);
		const secondView = await service.wait(second.runId);
		expect(secondView).toMatchObject({
			status: "completed",
			output: { answer: "second y" },
		});
		expect(await recordedSource(storeRoot, second.runId)).not.toBe(
			await recordedSource(storeRoot, first.runId),
		);
		expect(discoveries).toHaveBeenCalledTimes(2);
	});
});

// F1: a package contributes definitions through the constructor, the form the
// shipped extension uses for the package's own builtin root.
describe("service registered roots", () => {
	it("lists and runs a constructor-registered builtin root without project trust", async () => {
		const base = path.resolve(".pi", "test-service-discovery", randomUUID());
		const cwd = path.join(base, "project");
		const agentDir = path.join(base, "agent");
		const packageRoot = path.join(base, "package", "workflows");
		await mkdir(cwd, { recursive: true });
		await mkdir(packageRoot, { recursive: true });
		await writeFile(
			path.join(packageRoot, "shipped.workflow.ts"),
			definition("shipped", "shipped "),
		);
		const service = await createWorkflowService({
			cwd,
			agentDir,
			storeRoot: path.join(cwd, ".pi", "workflow"),
			projectTrusted: () => false,
			subagents: provider(),
			registeredRoots: [
				{ path: packageRoot, scope: "builtin", source: "package" },
			],
		});
		services.push(service);
		// The constructor registers; it does not discover.
		expect(discoveries).toHaveBeenCalledTimes(0);
		expect(await service.list()).toMatchObject([
			{ name: "shipped", scope: "builtin", source: "package" },
		]);
		const run = await service.run("shipped", { value: "z" });
		expect(await service.wait(run.runId)).toMatchObject({
			status: "completed",
			output: { answer: "shipped z" },
		});
	});

	it("refuses a constructor-registered root outside package or builtin scope", async () => {
		const base = path.resolve(".pi", "test-service-discovery", randomUUID());
		const cwd = path.join(base, "project");
		await mkdir(cwd, { recursive: true });
		await expect(
			createWorkflowService({
				cwd,
				agentDir: path.join(base, "agent"),
				storeRoot: path.join(cwd, ".pi", "workflow"),
				projectTrusted: () => true,
				subagents: provider(),
				registeredRoots: [{ path: cwd, scope: "project", source: "test" }],
			}),
		).rejects.toThrow("Registered roots must be package or builtin scope.");
	});
});
