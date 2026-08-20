import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	discoverWorkflows,
	WorkflowDefinitionLoadError,
	WorkflowDefinitionTrustError,
} from "../src/registry.js";

function fixture(name: string): string {
	return path.resolve(".pi", "test-definitions", `${name}-${randomUUID()}`);
}

function moduleSource(name: string, extra = ""): string {
	return `${extra}\nexport default {
  schema: "pi-workflow-definition",
  meta: { name: ${JSON.stringify(name)}, description: "Test workflow", version: 1 },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: {}, additionalProperties: false },
  async run() { return {}; }
};\n`;
}

describe("workflow registry", () => {
	it("discovers trusted project and global workflows deterministically", async () => {
		const root = fixture("discover");
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await mkdir(path.join(cwd, "workflows"), { recursive: true });
		await mkdir(path.join(agentDir, "workflows"), { recursive: true });
		await writeFile(
			path.join(cwd, "workflows", "b.workflow.ts"),
			moduleSource("project-b"),
		);
		await writeFile(
			path.join(cwd, "workflows", "a.workflow.ts"),
			moduleSource("project-a"),
		);
		await writeFile(
			path.join(agentDir, "workflows", "global.workflow.ts"),
			moduleSource("global"),
		);

		const workflows = await discoverWorkflows({
			cwd,
			agentDir,
			projectTrusted: true,
		});
		expect(workflows.map((entry) => entry.definition.meta.name)).toEqual([
			"project-a",
			"project-b",
			"global",
		]);
		expect(workflows.map((entry) => entry.scope)).toEqual([
			"project",
			"project",
			"global",
		]);
		expect(
			workflows.every((entry) => entry.identity.identitySha256.length === 64),
		).toBe(true);
		expect(Object.isFrozen(workflows[0])).toBe(true);
		expect(Object.isFrozen(workflows)).toBe(true);
		expect(Object.isFrozen(workflows[0]?.definition)).toBe(true);
	});

	it("does not execute untrusted project workflows", async () => {
		const root = fixture("trust");
		const cwd = path.join(root, "project");
		const marker = path.join(root, "executed");
		await mkdir(path.join(cwd, "workflows"), { recursive: true });
		await writeFile(
			path.join(cwd, "workflows", "unsafe.workflow.ts"),
			moduleSource(
				"unsafe",
				`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");`,
			),
		);
		await expect(
			discoverWorkflows({
				cwd,
				agentDir: path.join(root, "agent"),
				projectTrusted: false,
			}),
		).rejects.toBeInstanceOf(WorkflowDefinitionTrustError);
		await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects duplicate names across roots", async () => {
		const root = fixture("duplicate");
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await mkdir(path.join(cwd, "workflows"), { recursive: true });
		await mkdir(path.join(agentDir, "workflows"), { recursive: true });
		await writeFile(
			path.join(cwd, "workflows", "one.workflow.ts"),
			moduleSource("duplicate"),
		);
		await writeFile(
			path.join(agentDir, "workflows", "two.workflow.ts"),
			moduleSource("duplicate"),
		);
		await expect(
			discoverWorkflows({ cwd, agentDir, projectTrusted: true }),
		).rejects.toThrow("duplicate workflow name");
	});

	it("rejects relative imports until helper provenance is supported", async () => {
		const root = fixture("imports");
		const cwd = path.join(root, "project");
		await mkdir(path.join(cwd, "workflows"), { recursive: true });
		await writeFile(
			path.join(cwd, "workflows", "helper.ts"),
			"export const value = 1;\n",
		);
		await writeFile(
			path.join(cwd, "workflows", "imports.workflow.ts"),
			`import "./helper.ts";\n${moduleSource("imports")}`,
		);
		await expect(
			discoverWorkflows({
				cwd,
				agentDir: path.join(root, "agent"),
				projectTrusted: true,
			}),
		).rejects.toBeInstanceOf(WorkflowDefinitionLoadError);
	});

	it("allows import-like text in strings and comments", async () => {
		const root = fixture("import-text");
		const cwd = path.join(root, "project");
		await mkdir(path.join(cwd, "workflows"), { recursive: true });
		await writeFile(
			path.join(cwd, "workflows", "text.workflow.ts"),
			moduleSource(
				"text",
				'const text = \'require("./not-a-helper.js")\'; // import("./also-text.js")\nvoid text;',
			),
		);
		await expect(
			discoverWorkflows({
				cwd,
				agentDir: path.join(root, "agent"),
				projectTrusted: true,
			}),
		).resolves.toHaveLength(1);
	});

	it("changes identity when source changes", async () => {
		const root = fixture("identity");
		const cwd = path.join(root, "project");
		const file = path.join(cwd, "workflows", "identity.workflow.ts");
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, moduleSource("identity"));
		const first = await discoverWorkflows({
			cwd,
			agentDir: path.join(root, "agent"),
			projectTrusted: true,
		});
		await writeFile(file, `${await readFile(file, "utf8")}\n`);
		const second = await discoverWorkflows({
			cwd,
			agentDir: path.join(root, "agent"),
			projectTrusted: true,
		});
		expect(second[0]?.identity.identitySha256).not.toBe(
			first[0]?.identity.identitySha256,
		);
	});
});
