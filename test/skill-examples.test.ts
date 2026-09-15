import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverWorkflows } from "../src/registry.js";

const skillUrl = new URL(
	"../skills/workflow-authoring/SKILL.md",
	import.meta.url,
);
const examplesUrl = new URL(
	"../skills/workflow-authoring/references/examples.md",
	import.meta.url,
);
const publicEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const EXPECTED_EXAMPLE_NAMES = [
	"linear-answer",
	"implement-review",
	"review-branch",
	"summarize-items",
	"analysis-pipeline",
	"digest-support",
	"nested-parent",
	"nested-child",
	"resilient-draft",
];

function fencedTypeScript(markdown: string): string[] {
	return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map(
		(match) => match[1] ?? "",
	);
}

async function projectWithExamples(examples: readonly string[]) {
	const root = path.resolve(".pi", "test-skill-examples", randomUUID());
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await mkdir(path.join(cwd, "workflows"), { recursive: true });
	// The examples import the published package name. Resolve it to this
	// checkout's source so the examples exercise the current public API.
	const shim = path.join(cwd, "node_modules", "@vegardx", "pi-workflow");
	await mkdir(shim, { recursive: true });
	await writeFile(
		path.join(shim, "package.json"),
		'{"name":"@vegardx/pi-workflow","type":"module","main":"./index.js"}\n',
	);
	await writeFile(
		path.join(shim, "index.js"),
		`export * from ${JSON.stringify(publicEntry)};\n`,
	);
	await Promise.all(
		examples.map((source, index) =>
			writeFile(
				path.join(cwd, "workflows", `example-${index}.workflow.ts`),
				source,
			),
		),
	);
	return { cwd, agentDir };
}

describe("workflow authoring skill", () => {
	it("declares a model-invoked skill with the required frontmatter", async () => {
		const skill = await readFile(skillUrl, "utf8");
		const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
		expect(frontmatter?.[1]).toContain("name: workflow-authoring");
		expect(frontmatter?.[1]).toContain(
			"description: Use when creating, modifying, validating, or debugging a static pi-workflow *.workflow.ts definition; not for operating runs.",
		);
		expect(skill).toContain("references/examples.md");
		for (const unavailable of [
			"`ctx.checkpoint`",
			"`ctx.artifact`",
			"`ctx.finalize`",
		]) {
			expect(skill).toContain(unavailable);
		}
		for (const tool of [
			"workflow_list",
			"workflow_validate",
			"workflow_run",
			"workflow_status",
			"workflow_wait",
			"workflow_stop",
			"workflow_reconcile",
		]) {
			expect(skill).toContain(tool);
		}
	});

	it("loads every fenced example through the real definition loader", async () => {
		const examples = fencedTypeScript(await readFile(examplesUrl, "utf8"));
		expect(examples.length).toBe(EXPECTED_EXAMPLE_NAMES.length);
		for (const example of examples) {
			expect(example).toContain('from "@vegardx/pi-workflow"');
			expect(example).toContain("export default defineWorkflow({");
		}
		const project = await projectWithExamples(examples);
		const workflows = await discoverWorkflows({
			...project,
			projectTrusted: true,
		});
		expect(workflows.map((workflow) => workflow.definition.meta.name)).toEqual(
			EXPECTED_EXAMPLE_NAMES,
		);
		for (const workflow of workflows) {
			expect(workflow.scope).toBe("project");
			expect(workflow.definition.schema).toBe("pi-workflow-definition");
			expect(workflow.definition.meta.concurrency).toBeGreaterThanOrEqual(1);
			expect(workflow.identity.identitySha256).toMatch(/^[a-f0-9]{64}$/);
		}
		const child = workflows.find(
			(workflow) => workflow.definition.meta.name === "nested-child",
		);
		expect(child?.definition.inputSchema).toMatchObject({
			type: "object",
			required: ["topic", "doc"],
		});
	});

	it("refuses an example that imports outside the allow-list", async () => {
		const [example] = fencedTypeScript(await readFile(examplesUrl, "utf8"));
		if (!example) throw new Error("no examples");
		const project = await projectWithExamples([
			`import { readFileSync } from "node:fs";\nvoid readFileSync;\n${example}`,
		]);
		await expect(
			discoverWorkflows({ ...project, projectTrusted: true }),
		).rejects.toThrow(
			"workflow import node:fs is not identity-bound by contract revision 15",
		);
	});
});
