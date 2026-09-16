import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
	type WorkflowRunStatus,
	WorkflowRunStatusSchema,
} from "../src/contracts.js";
import {
	availableWorkflowRunActions,
	isTerminalWorkflowRunStatus,
	WORKFLOW_RUN_ACTIONS,
	type WorkflowRunAction,
	type WorkflowRunActionFacts,
	type WorkflowRunOwnership,
} from "../src/run-actions.js";
import { WORKFLOW_TOOL_DECLARATIONS } from "../src/tools.js";
import { WORKFLOW_SUBCOMMANDS } from "../src/ui/commands.js";

/**
 * The operating skill is bidirectionally pinned to the runtime: every name it
 * documents exists, and every name the runtime declares is documented. A
 * drift in either direction fails here rather than in a user's session.
 */

const skillUrl = new URL("../skills/workflows/SKILL.md", import.meta.url);
const skill = await readFile(skillUrl, "utf8");

const TOOL_NAMES: readonly string[] = WORKFLOW_TOOL_DECLARATIONS.map(
	(declaration) => declaration.name,
);
const RUN_STATUSES = WorkflowRunStatusSchema.anyOf.map(
	(literal) => literal.const,
) as readonly WorkflowRunStatus[];

function unique(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

/** Every `workflow_*` token in the skill, in code spans or prose alike. */
function skillToolNames(): string[] {
	return unique([...skill.matchAll(/\bworkflow_[a-z_]+/g)].map(([m]) => m));
}

/** Every `/workflow <subcommand>` token; a non-word follower is no token. */
function skillSubcommands(): string[] {
	return unique(
		[...skill.matchAll(/\/workflow[ \t]+([a-z][a-z-]*)/g)].map(
			(match) => match[1] ?? "",
		),
	);
}

/** The code-span tokens of the paragraph opening a `## ` section. */
function sectionTokens(heading: string): string[] {
	const start = skill.indexOf(`## ${heading}\n`);
	expect(start, `section "${heading}" is missing`).toBeGreaterThanOrEqual(0);
	const body = skill.slice(start + heading.length + 4);
	const end = body.indexOf("\n\n");
	const paragraph = end < 0 ? body : body.slice(0, end);
	return [...paragraph.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
}

/** Rows of the one markdown table under a `## ` section, as `[cell, cell]`. */
function tableRows(heading: string): Array<readonly [string, string]> {
	const start = skill.indexOf(`## ${heading}\n`);
	expect(start, `section "${heading}" is missing`).toBeGreaterThanOrEqual(0);
	const next = skill.indexOf("\n## ", start + 1);
	const section = skill.slice(start, next < 0 ? undefined : next);
	return [...section.matchAll(/^\| (.+?) \| (.+?) \|$/gm)]
		.map(
			(match) =>
				[match[1] ?? "", match[2] ?? ""] as const satisfies readonly [
					string,
					string,
				],
		)
		.filter(
			([left]) => left !== "Tool" && left !== "Action" && !/^-+$/.test(left),
		);
}

describe("workflows operating skill", () => {
	it("is a skill Pi can load", () => {
		expect(skill.startsWith("---\nname: workflows\ndescription: ")).toBe(true);
		// The authoring skill's frontmatter shape: name and description only.
		const frontmatter = skill.slice(4, skill.indexOf("\n---\n"));
		expect(
			unique(frontmatter.split("\n").map((line) => line.split(":")[0] ?? "")),
		).toEqual(["description", "name"]);
	});

	it("documents every declared tool and invents none", () => {
		expect(skillToolNames()).toEqual(unique([...TOOL_NAMES]));
	});

	it("lists the tool table in declaration order", () => {
		expect(tableRows("The fourteen tools").map(([tool]) => tool)).toEqual(
			TOOL_NAMES.map((name) => `\`${name}\``),
		);
	});

	it("documents every `/workflow` subcommand and invents none", () => {
		expect(skillSubcommands()).toEqual(unique([...WORKFLOW_SUBCOMMANDS]));
	});

	it("quotes exactly the real run statuses", () => {
		expect(unique(sectionTokens("Run statuses"))).toEqual(
			unique([...RUN_STATUSES]),
		);
	});

	it("quotes exactly the terminal run statuses", () => {
		const start = skill.indexOf("\nTerminal: ");
		expect(start).toBeGreaterThanOrEqual(0);
		const paragraph = skill.slice(start + 1, skill.indexOf("\n\n", start));
		const listed = unique(
			[...paragraph.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""),
		);
		expect(listed).toEqual(
			unique(RUN_STATUSES.filter(isTerminalWorkflowRunStatus)),
		);
	});

	it("names no model-callable decide, approve, or reject tool", () => {
		expect(
			TOOL_NAMES.filter((name) => /decide|approve|reject/.test(name)),
		).toEqual([]);
		// The command surface marks each human-only act as such.
		for (const subcommand of ["approve", "reject", "decide"] as const) {
			expect(WORKFLOW_SUBCOMMANDS).toContain(subcommand);
			const line = skill
				.split("\n")
				.find((candidate) => candidate.startsWith(`/workflow ${subcommand} `));
			expect(
				line,
				`${subcommand} is missing from the command block`,
			).toBeDefined();
			expect(line).toMatch(/human-only$/);
		}
		expect(skill.replace(/\s+/g, " ")).toContain(
			"There is no model-callable decide tool by design",
		);
	});
});

// ---------------------------------------------------------------------------
// Legality: the skill's table is evaluated as predicates over a fact matrix
// and compared with `availableWorkflowRunActions`, so a change to either the
// rule or its sentence fails.
// ---------------------------------------------------------------------------

interface SkillRule {
	readonly action: WorkflowRunAction | "any";
	/** The sentence the skill prints for this row, verbatim. */
	readonly rule: string;
	readonly legal: (facts: WorkflowRunActionFacts) => boolean;
}

const terminal = (facts: WorkflowRunActionFacts) =>
	isTerminalWorkflowRunStatus(facts.status);

const invalidatable = (facts: WorkflowRunActionFacts) =>
	(facts.status === "failed" || facts.status === "interrupted") &&
	!facts.nested &&
	!facts.awaitsRecovery &&
	!facts.deadlinePassed &&
	!facts.driving;

const SKILL_RULES: readonly SkillRule[] = [
	{
		action: "any",
		rule: "the run is not leased by another Pi process",
		legal: (facts) => facts.ownership !== "leased-elsewhere",
	},
	{
		action: "stop",
		rule: "status is not terminal",
		legal: (facts) => !terminal(facts),
	},
	{
		action: "wait",
		rule: "status is not terminal, or the run awaits recovery",
		legal: (facts) => !terminal(facts) || facts.awaitsRecovery,
	},
	{
		action: "reconcile",
		rule: "status is `cleanup-blocked`, or not terminal and owned by no live service",
		legal: (facts) =>
			facts.status === "cleanup-blocked" ||
			(!terminal(facts) && facts.ownership === "inactive"),
	},
	{
		action: "invalidate",
		rule: "`failed` or `interrupted`, not nested, not awaiting recovery, deadline not passed, not being driven",
		legal: invalidatable,
	},
	{
		action: "retry",
		rule: "`invalidate` is legal and some task's current execution is terminal `failed` or `interrupted`",
		legal: (facts) => invalidatable(facts) && facts.retryableTaskCount > 0,
	},
	{
		action: "resume",
		rule: "`interrupted`, not nested, not awaiting recovery, deadline not passed, not being driven, and some task is resumable",
		legal: (facts) =>
			facts.status === "interrupted" &&
			!facts.nested &&
			!facts.awaitsRecovery &&
			!facts.deadlinePassed &&
			!facts.driving &&
			facts.resumableTaskCount > 0,
	},
	{
		action: "decide",
		rule: "`running` or `waiting`, not nested, deadline not passed, at least one checkpoint pending (a live drive with another lane busy accepts one too)",
		legal: (facts) =>
			(facts.status === "running" || facts.status === "waiting") &&
			!facts.nested &&
			!facts.deadlinePassed &&
			facts.pendingCheckpointCount > 0,
	},
];

const OWNERSHIPS: readonly WorkflowRunOwnership[] = [
	"owned",
	"leased-elsewhere",
	"inactive",
];

function* factMatrix(): Generator<WorkflowRunActionFacts> {
	for (const status of RUN_STATUSES) {
		for (const ownership of OWNERSHIPS) {
			for (const driving of [false, true]) {
				for (const nested of [false, true]) {
					for (const deadlinePassed of [false, true]) {
						for (const awaitsRecovery of [false, true]) {
							for (const retryableTaskCount of [0, 1]) {
								for (const resumableTaskCount of [0, 1]) {
									for (const pendingCheckpointCount of [0, 1]) {
										yield {
											status,
											ownership,
											driving,
											nested,
											deadlinePassed,
											awaitsRecovery,
											hasCleanupBlockedTask: status === "cleanup-blocked",
											retryableTaskCount,
											resumableTaskCount,
											pendingCheckpointCount,
										};
									}
								}
							}
						}
					}
				}
			}
		}
	}
}

describe("workflows operating skill legality table", () => {
	it("prints one row per action, in the runtime's order", () => {
		const rows = tableRows("Recovery: retry vs resume vs invalidate");
		expect(rows.map(([action]) => action)).toEqual(
			SKILL_RULES.map((entry) => `\`${entry.action}\``),
		);
		expect(rows.map(([, rule]) => rule)).toEqual(
			SKILL_RULES.map((entry) => entry.rule),
		);
		expect(SKILL_RULES.slice(1).map((entry) => entry.action)).toEqual([
			...WORKFLOW_RUN_ACTIONS,
		]);
	});

	it("agrees with availableWorkflowRunActions on every fact combination", () => {
		const [any, ...rules] = SKILL_RULES;
		if (!any) throw new Error("the legality table lost its precondition row");
		let checked = 0;
		for (const facts of factMatrix()) {
			const expected = any.legal(facts)
				? rules
						.filter((rule) => rule.legal(facts))
						.map((rule) => rule.action as WorkflowRunAction)
				: [];
			expect(
				[...availableWorkflowRunActions(facts)],
				JSON.stringify(facts),
			).toEqual(expected);
			checked += 1;
		}
		expect(checked).toBeGreaterThan(1000);
	});
});

// ---------------------------------------------------------------------------
// Quoted runtime messages: the skill puts words in the runtime's mouth only
// when the runtime says them.
// ---------------------------------------------------------------------------

const QUOTED_MESSAGES: ReadonlyArray<readonly [string, string]> = [
	["src/run-actions.ts", "Workflow resume requires an agent task."],
	[
		"src/run-actions.ts",
		"Workflow resume requires an interrupted task with a resumable failure.",
	],
	["src/run-actions.ts", "Workflow task attempt bound exceeded."],
	[
		"src/run-actions.ts",
		"Use workflow_invalidate; dependents already observed this task.",
	],
	[
		"src/tools.ts",
		"Workflow inspection exceeds the tool output bound; narrow include or pass taskId.",
	],
	["src/tools.ts", "The model cannot approve."],
	[
		"src/ui/commands.ts",
		"Checkpoint decisions require an interactive Pi session.",
	],
	[
		"src/ui/commands.ts",
		"Dynamic workflow approval requires an interactive Pi session.",
	],
];

describe("workflows operating skill quotations", () => {
	// The skill wraps quotations across lines; compare on one line.
	const flattened = skill.replace(/\s+/g, " ");
	for (const [file, message] of QUOTED_MESSAGES) {
		it(`quotes ${file}: ${message}`, async () => {
			const source = await readFile(
				new URL(`../${file}`, import.meta.url),
				"utf8",
			);
			expect(source, `not in ${file}`).toContain(message);
			expect(flattened, "not quoted by the skill").toContain(message);
		});
	}
});
