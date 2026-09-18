import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractDynamicWorkflowManifest } from "../src/dynamic/vm-host.js";
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
	"worktree-implement",
	"finalized-report",
	"approved-implement",
	"dynamic-triage",
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
				// Zero-padded so discovery's name sort keeps the authoring order.
				path.join(
					cwd,
					"workflows",
					`example-${String(index).padStart(2, "0")}.workflow.ts`,
				),
				source,
			),
		),
	);
	return { cwd, agentDir };
}

/** `items` mapped in order with at most `limit` calls in flight. */
async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	map: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	async function lane(): Promise<void> {
		for (let index = next++; index < items.length; index = next++) {
			results[index] = await map(items[index] as T);
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, () => lane()),
	);
	return results;
}

describe("workflow authoring skill", () => {
	it("declares a model-invoked skill with the required frontmatter", async () => {
		const skill = await readFile(skillUrl, "utf8");
		const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
		expect(frontmatter?.[1]).toContain("name: workflow-authoring");
		expect(frontmatter?.[1]).toContain(
			"description: Use when creating, modifying, validating, or debugging a pi-workflow *.workflow.ts definition, static or proposed as a dynamic workflow through workflow_propose; not for operating runs.",
		);
		expect(skill).toContain("references/examples.md");
		const unavailable = skill
			.match(
				/Not available in revision 20:([\s\S]*?)\. Do not author against/,
			)?.[1]
			?.replace(/\s+/g, " ");
		if (!unavailable) throw new Error("no unavailable-API statement");
		for (const api of [
			"`ctx.artifact`",
			"a Pi tool for handoff export",
			"approve, reject, or proposals tool",
		]) {
			expect(unavailable).toContain(api);
		}
		// Dynamic workflows are available since revision 18 (dynamic half).
		expect(unavailable).not.toContain("dynamic workflows");
		expect(skill).toContain("## Dynamic workflows");
		expect(skill).toContain("`workflow_propose { source }`");
		for (const message of [
			"dynamic workflow source may not use import.meta",
			"dynamic workflow source must have exactly one default export and no named exports",
			"Dynamic workflow source is not approved for the current host API.",
			"Dynamic workflow source was rejected.",
			"Dynamic workflow source is already approved.",
			"Dynamic workflow proposal predates the current host API; propose the source again.",
			"Dynamic workflow import policy changed since approval.",
			"Dynamic workflow source execution failed:",
			"Dynamic workflow source may not register support implementations.",
			"Workflow request contains a function.",
		]) {
			expect(skill).toContain(message);
		}
		// Revision 19: the guest memory grant and the bound that is never retried.
		expect(skill).toContain("memory request exceeds agent ceiling");
		expect(skill).toContain(
			"agent memoryBytes must be a positive multiple of 64 MiB and at most 4 GiB",
		);
		expect(skill).toContain("| `memoryBytes` |");
		expect(skill).toContain("`workspace-budget`");
		expect(skill).toContain(
			"a determinism and API boundary, not an OS security boundary",
		);
		expect(skill).toContain("never state or assume a proposal is approved");
		// Invalidation, retry, and resume have Pi tools and writer (worktree)
		// agent tasks are available since revision 17.
		expect(unavailable).not.toContain("invalidation");
		expect(unavailable).not.toContain("writer");
		expect(unavailable).not.toContain("worktree");
		expect(unavailable).not.toContain("retry");
		expect(unavailable).not.toContain("resume");
		// Checkpoints are available since revision 18.
		expect(unavailable).not.toContain("ctx.checkpoint");
		expect(skill).toContain("## Checkpoints");
		expect(skill).toContain(
			"`ctx.checkpoint(key, { schema, prompt, default?, headless, timeoutMs?, disposition?, after?, inputs?, replay? })`",
		);
		for (const message of [
			"a checkpoint cannot be a finalizer",
			"invalid checkpoint prompt",
			"invalid checkpoint headless policy",
			"invalid checkpoint timeout",
			"checkpoint default is not JSON",
			"checkpoint default does not match its schema",
			"checkpoint headless default requires an explicit default",
			"Workflow checkpoint request is invalid.",
			"Checkpoint awaits a decision.",
			"Checkpoint decided.",
			"Checkpoint expired without a decision.",
			"Workflow run ended before the checkpoint was decided.",
			"Checkpoint is already decided.",
			"Checkpoint has expired.",
			"Checkpoint decision does not match its schema.",
		]) {
			expect(skill).toContain(message);
		}
		expect(skill).toContain("Do not poll; wait returns immediately when");
		expect(skill).toContain("`parked: true`");
		expect(skill).toContain("a model must never decide a checkpoint");
		expect(unavailable).toContain("model-callable checkpoint decide tool");
		expect(skill).toContain("`workflow_invalidate { runId, taskId, reason }`");
		expect(skill).toContain("`workflow_retry { runId, taskId, reason }`");
		expect(skill).toContain("`workflow_resume { runId, reason, taskId? }`");
		expect(skill).not.toContain("There is no operator resume tool");
		expect(skill).toContain("`workflow_wait { runId, timeoutMs? }`");
		expect(skill).toContain("`workflow_reconcile { runId, taskId? }`");
		expect(unavailable).not.toContain("ctx.finalize");
		expect(skill).toContain("## Worktree tasks and handoffs");
		for (const message of [
			"handoff policy requires a worktree workspace",
			"worktree workspace requires a positive workspaceWriteBytes limit",
			"handoff input producer is not a worktree agent task",
			"Completed worktree task captured no handoff.",
		]) {
			expect(skill).toContain(message);
		}
		expect(skill).toContain("## Finalizers");
		expect(skill).toContain(
			"`ctx.finalize(key, { kind, support | agent | workflow })`",
		);
		for (const message of [
			"invalid finalizer kind",
			"finalizer requires exactly one of support, agent, or workflow",
			"finalizer disposition is its kind",
			"ordinary task may not depend on a finalizer",
			"a finalizer cannot be a barrier target",
			"Required finalizer did not complete:",
			"invalidation after output commit may only cover finalizers",
			"Interrupted child retained for recovery; no release performed.",
		]) {
			expect(skill).toContain(message);
		}
		for (const tool of [
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
			"workflow_propose",
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
		const dynamic = examples.at(-1);
		expect(dynamic).toContain('name: "dynamic-triage"');
		expect(dynamic).toContain("await ctx.result(triage)");
		const worktree = examples.at(-4);
		expect(worktree).toContain('workspace: { mode: "worktree", cwd: ctx.cwd }');
		expect(worktree).toContain('handoff: "required"');
		expect(worktree).toContain("await ctx.handoff(implement)");
		expect(worktree).toContain("handoff: implement.handoff");
		expect(examples.at(-3)).toContain('ctx.finalize("record", {');
		expect(examples.at(-3)).toContain('ctx.finalize("announce", {');
		const checkpoint = examples.at(-2);
		expect(checkpoint).toContain('ctx.checkpoint("approve", {');
		expect(checkpoint).toContain('headless: "block"');
		expect(checkpoint).toContain('headless: "use-explicit-default"');
		expect(checkpoint).toContain("await ctx.result(approve)");
		expect(checkpoint).toContain("after: [approve.ref]");
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

	it("yields the loader's manifest for every example through the dynamic manifest VM", async () => {
		const examples = fencedTypeScript(await readFile(examplesUrl, "utf8"));
		const project = await projectWithExamples(examples);
		const workflows = await discoverWorkflows({
			...project,
			projectTrusted: true,
		});
		expect(workflows).toHaveLength(examples.length);
		// Each extraction boots one worker under its own watchdog. The boots
		// share nothing, so a few run at a time: enough to overlap the
		// per-worker module load, few enough that a loaded 4 vCPU CI runner
		// still boots every worker well inside the lengthened watchdog (the
		// production 5 s manifest watchdog assumes an idle host).
		const manifests = await mapWithConcurrency(examples, 4, (source) =>
			extractDynamicWorkflowManifest({
				source,
				supportHelpers: [],
				overrides: { bootTimeoutMs: 60_000 },
			}),
		);
		for (const [index, manifest] of manifests.entries()) {
			const loaded = workflows[index];
			if (!loaded) throw new Error(`no loaded example ${index}`);
			expect(manifest).toEqual({
				meta: loaded.definition.meta,
				inputSchema: loaded.definition.inputSchema,
				outputSchema: loaded.definition.outputSchema,
			});
		}
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
			"workflow import node:fs is not identity-bound by contract revision 20",
		);
	});
});

/**
 * The Patterns section is the primary artifact and the component library is
 * its executable form (spec §2.3), so the two are pinned to each other here:
 * every pattern pointer in a component resolves to a heading that exists, and
 * every builtin definition the package ships is named in the skills that tell
 * a reader which workflows exist. A drift in either direction fails here
 * rather than in a session.
 */

const COMPONENT_DIR = new URL("../src/components/", import.meta.url);
const BUILTIN_DIR = new URL("../workflows/", import.meta.url);

/**
 * The modules that encode a pattern. A module that adds a schema or a helper
 * without encoding one (for example the compiled stage document) is not
 * listed, but any pointer it does carry is still resolved below.
 */
const PATTERN_MODULES = [
	"envelope.ts",
	"finding.ts",
	"for-each.ts",
	"gate.ts",
	"index.ts",
	"review-fan-out.ts",
	"verify-and-fix.ts",
] as const;

/** `SKILL.md` § "…", with the doc comment's line prefixes folded away. */
function patternPointers(source: string): string[] {
	const flattened = source.replace(/\n\s*\*\s?/g, " ").replace(/\s+/g, " ");
	return [
		...flattened.matchAll(/workflow-authoring\/SKILL\.md` § "([^"]+)"/g),
	].map((match) => match[1] ?? "");
}

/** The `meta.name` a shipped definition declares. */
function definitionName(source: string): string {
	const name = source.match(
		/meta:\s*\{[\s\S]*?name:\s*"([a-z][a-z0-9-]*)"/,
	)?.[1];
	if (!name) throw new Error("no meta.name in a builtin definition");
	return name;
}

describe("workflow authoring skill patterns", () => {
	it("resolves every component's pattern pointer to a heading", async () => {
		const skill = await readFile(skillUrl, "utf8");
		expect(skill).toContain("\n## Patterns\n");
		const files = (await readdir(COMPONENT_DIR))
			.filter((file) => file.endsWith(".ts"))
			.sort();
		expect(files.length).toBeGreaterThanOrEqual(PATTERN_MODULES.length);
		const carried: string[] = [];
		for (const file of files) {
			const source = await readFile(new URL(file, COMPONENT_DIR), "utf8");
			const pointers = patternPointers(source);
			if (PATTERN_MODULES.includes(file as (typeof PATTERN_MODULES)[number])) {
				expect(pointers, `${file} names no pattern`).not.toHaveLength(0);
				carried.push(file);
			}
			for (const heading of pointers) {
				expect(
					skill.includes(`\n### ${heading}\n`) ||
						skill.includes(`\n## ${heading}\n`),
					`${file} points at the missing heading "${heading}"`,
				).toBe(true);
			}
		}
		expect(carried).toEqual([...PATTERN_MODULES]);
	});

	it("names every shipped builtin in both skills' tables", async () => {
		const authoring = await readFile(skillUrl, "utf8");
		const operating = await readFile(
			new URL("../skills/workflows/SKILL.md", import.meta.url),
			"utf8",
		);
		expect(authoring).toContain("\n## Builtin workflows\n");
		expect(operating).toContain("\n## The builtin workflows\n");
		const definitions = (await readdir(BUILTIN_DIR)).filter((file) =>
			file.endsWith(".workflow.ts"),
		);
		expect(definitions.length).toBeGreaterThan(0);
		for (const file of definitions) {
			const name = definitionName(
				await readFile(new URL(file, BUILTIN_DIR), "utf8"),
			);
			// The row form both tables use; a mention in prose is not enough,
			// because the table is what states the input and the output.
			expect(
				authoring,
				`${name} is not a row of the authoring table`,
			).toContain(`| \`${name}\` |`);
			expect(
				operating,
				`${name} is not a row of the operating table`,
			).toContain(`| \`${name}\` |`);
		}
	});
});
