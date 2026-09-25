import { randomUUID } from "node:crypto";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	type DiscoveredWorkflow,
	type DiscoveredWorkflowProblem,
	discoverWorkflows,
	WorkflowDefinitionLoadError,
	WorkflowDefinitionTrustError,
	type WorkflowRootScope,
} from "../src/registry.js";

function fixture(name: string): string {
	return path.resolve(".pi", "test-definitions", `${name}-${randomUUID()}`);
}

/**
 * A project root OUTSIDE this checkout, where `@vegardx/pi-workflow` resolves to
 * nothing: inside the repository the package self-references through its own
 * `exports`, so the stale-link failure this isolates cannot be reproduced there.
 */
async function externalFixture(name: string): Promise<string> {
	return realpath(
		await mkdtemp(path.join(os.tmpdir(), `pi-workflow-${name}-`)),
	);
}

/**
 * A problem carries the class of the cause and the definition file's own path
 * relative to its root — never a host path, a URL, a newline, or stack text.
 */
function expectSanitized(
	problems: readonly DiscoveredWorkflowProblem[],
	root: string,
): void {
	expect(problems.length).toBeGreaterThan(0);
	for (const entry of problems) {
		expect(entry.problem).not.toMatch(/[\r\n\t]/);
		expect(entry.problem).not.toMatch(/(^|[\s(<"'])[/~]/);
		expect(entry.problem).not.toMatch(/[a-z][a-z0-9+.-]*:\/\//i);
		expect(entry.problem).not.toMatch(/\bat\s+\S*\s*\(/);
		expect(entry.problem).not.toContain(root);
		expect(entry.problem).not.toContain(os.tmpdir());
		expect(entry.path).not.toMatch(/^([/~]|\.\.)/);
	}
}

function moduleSource(name: string, extra = ""): string {
	return `${extra}\nexport default {
  schema: "pi-workflow-definition",
  meta: { name: ${JSON.stringify(name)}, description: "Test workflow", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 3600000, concurrency: 4 },
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

		const { workflows, problems } = await discoverWorkflows({
			cwd,
			agentDir,
			projectTrusted: true,
		});
		// Roots are visited most-trusted first, so the agent directory precedes a
		// project's own and the first file to claim a name keeps it.
		expect(workflows.map((entry) => entry.definition.meta.name)).toEqual([
			"global",
			"project-a",
			"project-b",
		]);
		expect(workflows.map((entry) => entry.scope)).toEqual([
			"global",
			"project",
			"project",
		]);
		expect(problems).toEqual([]);
		expect(
			workflows.every((entry) => entry.identity.identitySha256.length === 64),
		).toBe(true);
		expect(Object.isFrozen(workflows[0])).toBe(true);
		expect(Object.isFrozen(workflows)).toBe(true);
		expect(Object.isFrozen(problems)).toBe(true);
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

	it("keeps the first file to claim a name and makes the later one a problem", async () => {
		const root = fixture("duplicate");
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await mkdir(path.join(cwd, "workflows"), { recursive: true });
		await writeFile(
			path.join(cwd, "workflows", "one.workflow.ts"),
			moduleSource("duplicate"),
		);
		await writeFile(
			path.join(cwd, "workflows", "two.workflow.ts"),
			moduleSource("duplicate"),
		);
		const { workflows, problems } = await discoverWorkflows({
			cwd,
			agentDir,
			projectTrusted: true,
		});
		expect(workflows.map((entry) => entry.path)).toEqual([
			path.join(await realpath(path.join(cwd, "workflows")), "one.workflow.ts"),
		]);
		expect(problems).toEqual([
			expect.objectContaining({
				path: "two.workflow.ts",
				problem:
					"duplicate workflow name duplicate, also defined by one.workflow.ts",
			}),
		]);
		expectSanitized(problems, root);
	});

	// A project is trusted code, but it is the least trusted root: a builtin the
	// host registered is loaded first, so a project file cannot take its name and
	// quietly become the definition that runs.
	it("never lets a project shadow a builtin name", async () => {
		const root = fixture("shadow");
		const cwd = path.join(root, "project");
		const builtin = fileURLToPath(new URL("../workflows", import.meta.url));
		await mkdir(path.join(cwd, "workflows"), { recursive: true });
		await writeFile(
			path.join(cwd, "workflows", "shadow.workflow.ts"),
			moduleSource("plan-to-ship"),
		);
		const { workflows, problems } = await discoverWorkflows({
			cwd,
			agentDir: path.join(root, "agent"),
			projectTrusted: true,
			registeredRoots: [{ path: builtin, scope: "builtin", source: "package" }],
		});
		const planToShip = workflows.filter(
			(entry) => entry.definition.meta.name === "plan-to-ship",
		);
		expect(planToShip.map((entry) => entry.scope)).toEqual(["builtin"]);
		expect(problems).toEqual([
			expect.objectContaining({
				path: "shadow.workflow.ts",
				scope: "project",
				problem:
					"duplicate workflow name plan-to-ship, also defined by plan-to-ship.workflow.ts",
			}),
		]);
	});

	// The defect this isolates: a project definition whose own
	// `@vegardx/pi-workflow` import resolves to nothing (a stale link) used to
	// fail discovery, and with it every other ref, behind one generic sentence.
	it("isolates a definition that cannot resolve a module it imports", async () => {
		const root = await externalFixture("unresolvable");
		try {
			const cwd = path.join(root, "project");
			await mkdir(path.join(cwd, "workflows"), { recursive: true });
			await writeFile(
				path.join(cwd, "workflows", "gated-answer.workflow.ts"),
				moduleSource(
					"gated-answer",
					'import { defineWorkflow } from "@vegardx/pi-workflow";\nvoid defineWorkflow;',
				),
			);
			await writeFile(
				path.join(cwd, "workflows", "good.workflow.ts"),
				moduleSource("good"),
			);
			const { workflows, problems } = await discoverWorkflows({
				cwd,
				agentDir: path.join(root, "agent"),
				projectTrusted: true,
			});
			expect(workflows.map((entry) => entry.definition.meta.name)).toEqual([
				"good",
			]);
			expect(problems).toEqual([
				expect.objectContaining({
					path: "gated-answer.workflow.ts",
					problem:
						"cannot resolve module '@vegardx/pi-workflow' from gated-answer.workflow.ts — the project must be able to resolve pi-workflow, for example through a dependency or link",
				}),
			]);
			expectSanitized(problems, root);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("isolates a definition that does not parse and one with no definition", async () => {
		const root = fixture("unparsed");
		const cwd = path.join(root, "project");
		await mkdir(path.join(cwd, "workflows"), { recursive: true });
		await writeFile(
			path.join(cwd, "workflows", "broken.workflow.ts"),
			"export default {\n",
		);
		await writeFile(
			path.join(cwd, "workflows", "empty.workflow.ts"),
			"export const value = 1;\n",
		);
		await writeFile(
			path.join(cwd, "workflows", "good.workflow.ts"),
			moduleSource("good"),
		);
		const { workflows, problems } = await discoverWorkflows({
			cwd,
			agentDir: path.join(root, "agent"),
			projectTrusted: true,
		});
		expect(workflows.map((entry) => entry.definition.meta.name)).toEqual([
			"good",
		]);
		expect(problems.map((entry) => entry.path)).toEqual([
			"broken.workflow.ts",
			"empty.workflow.ts",
		]);
		expect(problems[0]?.problem).toMatch(/^does not parse: \S/);
		expect(problems[1]?.problem).toBe("has no valid default definition");
		expectSanitized(problems, root);
	});

	it("names the class of any other evaluation failure", async () => {
		const root = fixture("throws");
		const cwd = path.join(root, "project");
		await mkdir(path.join(cwd, "workflows"), { recursive: true });
		await writeFile(
			path.join(cwd, "workflows", "throws.workflow.ts"),
			'throw new TypeError("boom");\n',
		);
		const { workflows, problems } = await discoverWorkflows({
			cwd,
			agentDir: path.join(root, "agent"),
			projectTrusted: true,
		});
		expect(workflows).toEqual([]);
		expect(problems).toEqual([
			expect.objectContaining({
				path: "throws.workflow.ts",
				problem: "failed to load: TypeError",
			}),
		]);
		expectSanitized(problems, root);
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

	it("admits the components subpath and still refuses the runtime subpath", async () => {
		const root = fixture("component-imports");
		const cwd = path.join(root, "project");
		await mkdir(path.join(cwd, "workflows"), { recursive: true });
		await writeFile(
			path.join(cwd, "workflows", "components.workflow.ts"),
			`import { gate } from "@vegardx/pi-workflow/components";\nvoid gate;\n${moduleSource("components")}`,
		);
		const discovered = await discoverWorkflows({
			cwd,
			agentDir: path.join(root, "agent"),
			projectTrusted: true,
		});
		expect(
			discovered.workflows.map((entry) => entry.definition.meta.name),
		).toContain("components");
		await writeFile(
			path.join(cwd, "workflows", "components.workflow.ts"),
			`import { reduceWorkflowEvents } from "@vegardx/pi-workflow/runtime";\nvoid reduceWorkflowEvents;\n${moduleSource("components")}`,
		);
		await expect(
			discoverWorkflows({
				cwd,
				agentDir: path.join(root, "agent"),
				projectTrusted: true,
			}),
		).rejects.toThrow(
			/workflow import @vegardx\/pi-workflow\/runtime is not identity-bound/,
		);
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
		).resolves.toMatchObject({ workflows: { length: 1 }, problems: [] });
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
		expect(second.workflows[0]?.identity.identitySha256).not.toBe(
			first.workflows[0]?.identity.identitySha256,
		);
	});

	// F1: the package ships its own definitions under workflows/ and the
	// extension registers that directory as a builtin root.
	it("discovers the package's builtin root without project trust", async () => {
		const root = fixture("builtin-root");
		const cwd = path.join(root, "project");
		await mkdir(cwd, { recursive: true });
		const builtin = fileURLToPath(new URL("../workflows", import.meta.url));
		const { workflows, problems } = await discoverWorkflows({
			cwd,
			agentDir: path.join(root, "agent"),
			projectTrusted: false,
			registeredRoots: [{ path: builtin, scope: "builtin", source: "package" }],
		});
		expect(problems).toEqual([]);
		const planToShip = workflows.find(
			(entry) => entry.definition.meta.name === "plan-to-ship",
		);
		if (!planToShip) throw new Error("plan-to-ship was not discovered");
		expect(planToShip.scope).toBe("builtin");
		expect(planToShip.source).toBe("package");
		expect(planToShip.root).toBe(await realpath(builtin));
		expect(path.dirname(planToShip.path)).toBe(await realpath(builtin));
		// Every shipped definition loads: the whole root is the extension's.
		expect(workflows.every((entry) => entry.scope === "builtin")).toBe(true);
		// The agent templates live under the same root and are ignored by
		// discovery: only `*.workflow.*` files are definitions.
		expect(
			workflows.every((entry) => entry.path.endsWith(".workflow.ts")),
		).toBe(true);
	});

	it("names the dynamic scope without discovering it", async () => {
		expectTypeOf<"dynamic">().toMatchTypeOf<WorkflowRootScope>();
		expectTypeOf<DiscoveredWorkflow["scope"]>().toEqualTypeOf<
			"project" | "global" | "package" | "builtin" | "dynamic"
		>();
		const root = fixture("dynamic-scope");
		const cwd = path.join(root, "project");
		const dynamicRoot = path.join(root, "dynamic");
		await mkdir(cwd, { recursive: true });
		await mkdir(dynamicRoot, { recursive: true });
		await writeFile(
			path.join(dynamicRoot, "proposed.workflow.ts"),
			moduleSource("proposed"),
		);
		await expect(
			discoverWorkflows({
				cwd,
				agentDir: path.join(root, "agent"),
				projectTrusted: true,
				registeredRoots: [
					{ path: dynamicRoot, scope: "dynamic", source: "proposal" },
				],
			}),
		).rejects.toMatchObject({
			name: "WorkflowDefinitionLoadError",
			message: "registered workflow roots must use package or builtin scope",
			definitionPath: dynamicRoot,
		});
		const { workflows } = await discoverWorkflows({
			cwd,
			agentDir: path.join(root, "agent"),
			projectTrusted: true,
		});
		expect(workflows.some((entry) => entry.scope === "dynamic")).toBe(false);
	});
});
