import { readdir, readFile } from "node:fs/promises";
import { parse } from "@babel/parser";
import { ExactModelRequestSchema, RunLimitsSchema } from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	assertBudgetAdmits,
	budgetAdmits,
	DIVERSE_MODEL_ID,
	ENVELOPE_STAGES,
	ENVELOPE_TIERS,
	envelope,
	GATE_TIMEOUT_MS,
	MODEL_ID,
	MODEL_PROVIDER,
	type StageName,
	sumBudgetShares,
	THINKING_BY_TIER,
	tierModel,
	WORKSPACE_WRITE_BYTES,
	WORKTREE_MEMORY_BYTES,
	workflowBudgetFor,
} from "../src/components/envelope.js";
import { WorkflowComponentError } from "../src/components/errors.js";
import type { WorkflowEventInput } from "../src/events.js";
import { WorkflowTaskMaterializer } from "../src/materializer.js";

const definitionIdentitySha256 = "a".repeat(64);
const inputSha256 = "b".repeat(64);
const runId = "workflow_components";

function materializer() {
	return new WorkflowTaskMaterializer({
		runId,
		definitionIdentitySha256,
		inputSha256,
	});
}

function declarations(commit: { events: readonly WorkflowEventInput[] }) {
	return commit.events.flatMap((event) =>
		event.type === "task-declared" ? [event.data.task] : [],
	);
}

const WORKFLOWS_ROOT = new URL("../workflows/", import.meta.url);

/** Every `.ts` file under a root, recursively; the sweep's own input. */
async function sourceFiles(root: URL): Promise<URL[]> {
	const found: URL[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const child = new URL(
			entry.isDirectory() ? `${entry.name}/` : entry.name,
			root,
		);
		if (entry.isDirectory()) found.push(...(await sourceFiles(child)));
		else if (entry.name.endsWith(".ts")) found.push(child);
	}
	return found;
}

const REVIEW_OUTPUT = Type.Object(
	{ verdict: Type.String() },
	{ additionalProperties: false },
);

describe("the stage table", () => {
	it("covers every stage and is a pure lookup", () => {
		expect([...ENVELOPE_STAGES]).toEqual([
			"refine",
			"implement",
			"verify",
			"fix",
			"review",
			"synthesis",
			"record",
		]);
		for (const stage of ENVELOPE_STAGES) {
			const first = envelope(stage);
			const second = envelope(stage);
			// Replay law 3: the lookup reads nothing but its one argument.
			expect(first).toEqual(second);
			expect(first).toBe(second);
			expect(Object.isFrozen(first)).toBe(true);
			expect(Object.isFrozen(first.limits)).toBe(true);
			expect(first.stage).toBe(stage);
			expect(Value.Check(RunLimitsSchema, first.limits)).toBe(true);
			expect(Value.Check(ExactModelRequestSchema, first.model)).toBe(true);
			expect(first.model.thinking).toBe(first.thinking);
			expect(first.budgetShare).toEqual({
				cost: first.limits.cost,
				totalTokens: first.limits.totalTokens,
				childRuntimeMs: first.limits.cumulativeRuntimeMs,
			});
			// A run with a token budget needs `limits.totalTokens` on every
			// agent task, so the table always declares one.
			expect(first.limits.totalTokens).toBeGreaterThan(0);
		}
	});

	it("has no effort dial left: one row per stage, and no second argument", () => {
		// The dial is gone. `envelope` is a one-argument lookup, the row is the
		// measured `standard` column, and nothing in the module speaks of cheap,
		// standard or deep as a level of effort.
		expect(envelope).toHaveLength(1);
		expect(
			Object.fromEntries(
				ENVELOPE_STAGES.map((stage) => [stage, envelope(stage).thinking]),
			),
		).toEqual({
			refine: "medium",
			implement: "medium",
			verify: "low",
			fix: "medium",
			review: "medium",
			synthesis: "medium",
			record: "low",
		});
	});

	it("gives only the writing stages a worktree write allowance", () => {
		for (const stage of ENVELOPE_STAGES) {
			const writes = stage === "implement" || stage === "fix";
			expect(envelope(stage).limits.workspaceWriteBytes).toBe(
				writes ? WORKSPACE_WRITE_BYTES : 0,
			);
		}
		// W1's floor for a real `npm ci` plus build in the guest.
		expect(WORKSPACE_WRITE_BYTES).toBe(2 * 1024 * 1024 * 1024);
		// W1 measured 512 MiB killing a real `npm ci`; a worktree stage asks for
		// the same 2 GiB whatever it is doing, because the dial that used to
		// narrow it is gone.
		expect(WORKTREE_MEMORY_BYTES).toBe(2 * 1024 * 1024 * 1024);
	});

	it("clears the W1 floors on every worktree row", () => {
		for (const stage of ["implement", "fix"] as const) {
			const row = envelope(stage);
			expect(row.limits.attemptTimeoutMs).toBeGreaterThanOrEqual(1_500_000);
			expect(row.limits.cumulativeRuntimeMs).toBeGreaterThanOrEqual(1_800_000);
		}
	});

	it("pins the stand-in routing, the tiers and the one gate timeout", () => {
		// DELETE WHEN ROUTING LANDS: these three literals are the stand-in for
		// host routing, and the tier map is the one dial a review still has.
		expect(envelope("review").model).toEqual({
			provider: MODEL_PROVIDER,
			id: MODEL_ID,
			thinking: "medium",
		});
		expect(DIVERSE_MODEL_ID).not.toBe(MODEL_ID);
		expect([...ENVELOPE_TIERS]).toEqual(["light", "standard", "heavy"]);
		expect(THINKING_BY_TIER).toEqual({
			light: "low",
			standard: "medium",
			heavy: "high",
		});
		for (const tier of ENVELOPE_TIERS) {
			expect(tierModel(tier)).toEqual({
				provider: MODEL_PROVIDER,
				id: MODEL_ID,
				thinking: THINKING_BY_TIER[tier],
			});
			expect(tierModel(tier, true)).toEqual({
				provider: MODEL_PROVIDER,
				id: DIVERSE_MODEL_ID,
				thinking: THINKING_BY_TIER[tier],
			});
			expect(Object.isFrozen(tierModel(tier))).toBe(true);
		}
		// One number: a decision a person has to take does not get shorter
		// because the work was cheaper. It is the old `standard` timeout.
		expect(GATE_TIMEOUT_MS).toBe(86_400_000);
	});

	it("refuses a stage the table does not cover", () => {
		expect(() => envelope("publish" as StageName)).toThrow(
			'unknown envelope stage "publish"; the table covers refine, implement, verify, fix, review, synthesis, record.',
		);
		let caught: unknown;
		try {
			envelope("thorough" as StageName);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(WorkflowComponentError);
	});
});

describe("envelope lowering", () => {
	it("declares exactly what the hand-written request declares", () => {
		const lowered = materializer();
		const row = envelope("review");
		const loweredHandle = lowered.agent("review", {
			agent: "reviewer",
			task: {
				goal: "Review the handoff",
				context: [],
				instructions: ["Report findings."],
			},
			contextMode: "fresh",
			model: row.model,
			tools: ["read", "grep", "find", "ls"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: "/repo" },
			outputSchema: REVIEW_OUTPUT,
			limits: row.limits,
		});

		const authored = materializer();
		const authoredHandle = authored.agent("review", {
			agent: "reviewer",
			task: {
				goal: "Review the handoff",
				context: [],
				instructions: ["Report findings."],
			},
			contextMode: "fresh",
			// The hand-written equivalent, literal for literal: this is the
			// table's pin as well as the lowering's.
			model: {
				provider: "github-copilot",
				id: "gpt-5.6-sol",
				thinking: "medium",
			},
			tools: ["read", "grep", "find", "ls"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: "/repo" },
			outputSchema: REVIEW_OUTPUT,
			limits: {
				cumulativeRuntimeMs: 900_000,
				attemptTimeoutMs: 900_000,
				totalTokens: 1_000_000,
				cost: 3,
				outputBytes: 65_536,
				workspaceWriteBytes: 0,
				retries: 1,
				resumes: 1,
			},
		});

		expect(loweredHandle.ref).toEqual(authoredHandle.ref);
		expect(loweredHandle.output.ref).toEqual(authoredHandle.output.ref);
		expect(declarations(lowered.closeEpoch("final", [loweredHandle]))).toEqual(
			declarations(authored.closeEpoch("final", [authoredHandle])),
		);
	});

	it("keeps task identity stable across two materializations", () => {
		const declare = () => {
			const runtime = materializer();
			const row = envelope("implement");
			const handle = runtime.agent("implement", {
				agent: "implementer",
				task: {
					goal: "Implement the deliverable",
					context: [],
					instructions: ["Work in the worktree."],
				},
				contextMode: "fresh",
				model: row.model,
				tools: ["read", "write", "bash"],
				preloadSkills: [],
				contextScopes: ["project"],
				workspace: { mode: "worktree", cwd: "/repo" },
				outputSchema: REVIEW_OUTPUT,
				limits: row.limits,
			});
			return declarations(runtime.closeEpoch("final", [handle]));
		};
		expect(declare()).toEqual(declare());
	});
});

describe("budget accounting", () => {
	const shares = [
		envelope("implement").budgetShare,
		envelope("review").budgetShare,
		envelope("review").budgetShare,
	];

	it("sums the shares of a declared graph", () => {
		expect(sumBudgetShares(shares)).toEqual({
			cost: 12 + 3 + 3,
			totalTokens: 2_000_000 + 1_000_000 + 1_000_000,
			childRuntimeMs: 2_400_000 + 900_000 + 900_000,
		});
		expect(sumBudgetShares([])).toEqual({
			cost: 0,
			totalTokens: 0,
			childRuntimeMs: 0,
		});
	});

	it("derives a meta.budget that admits its own graph", () => {
		const budget = workflowBudgetFor(shares);
		expect(budget).toEqual(sumBudgetShares(shares));
		expect(budgetAdmits(budget, shares)).toBe(true);
		// The empty graph still declares a legal budget.
		expect(workflowBudgetFor([]).childRuntimeMs).toBe(1_000);
	});

	it("admits by cost, child runtime, and tokens only when the budget bounds them", () => {
		const total = sumBudgetShares(shares);
		expect(budgetAdmits({ ...total, cost: total.cost - 1 }, shares)).toBe(
			false,
		);
		expect(
			budgetAdmits(
				{ ...total, childRuntimeMs: total.childRuntimeMs - 1 },
				shares,
			),
		).toBe(false);
		expect(
			budgetAdmits({ ...total, totalTokens: total.totalTokens - 1 }, shares),
		).toBe(false);
		// No token budget: tokens do not decide admission.
		expect(
			budgetAdmits(
				{ cost: total.cost, childRuntimeMs: total.childRuntimeMs },
				shares,
			),
		).toBe(true);
	});

	it("refuses an over-allocated declaration by name and by number", () => {
		const budget = {
			cost: 10,
			totalTokens: 1_000_000,
			childRuntimeMs: 600_000,
		};
		expect(() =>
			assertBudgetAdmits(budget, shares, 'forEach namespace "implement"'),
		).toThrow(
			'forEach namespace "implement" reserves cost 18, 4000000 tokens and 4200000 ms of child runtime, which exceeds the run budget (cost 10, 1000000 tokens, 600000 ms).',
		);
		let caught: unknown;
		try {
			assertBudgetAdmits(budget, shares, "the graph");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(WorkflowComponentError);
		expect((caught as WorkflowComponentError).component).toBe("envelope");
		expect(() =>
			assertBudgetAdmits(workflowBudgetFor(shares), shares, "the graph"),
		).not.toThrow();
	});

	it("names an unbounded token budget in the refusal", () => {
		expect(() =>
			assertBudgetAdmits({ cost: 1, childRuntimeMs: 1_000 }, shares, "the run"),
		).toThrow(
			"which exceeds the run budget (cost 1, unbounded tokens, 1000 ms).",
		);
	});
});

describe("the effort dial is gone from every source file", () => {
	it("mentions cheap, standard and deep nowhere as an effort", async () => {
		// THE GREP. `envelope`'s own tests can pin one table; only a sweep can
		// pin that no definition, component or runtime module still reads a
		// `cheap | standard | deep` dial. Prose that says the dial WAS removed is
		// fine — what is refused is the vocabulary as code: the `Effort` type, the
		// `EFFORTS` list, the string literals, and the table keys.
		const roots = [new URL("../src/", import.meta.url), WORKFLOWS_ROOT];
		const files: URL[] = [];
		for (const root of roots) files.push(...(await sourceFiles(root)));
		expect(files.length).toBeGreaterThan(80);
		const offenders: string[] = [];
		for (const file of files) {
			const text = await readFile(file, "utf8");
			const name = file.pathname;
			for (const [what, pattern] of [
				["the Effort type", /\bEfforts?\b/],
				["the EFFORTS list", /\bEFFORTS\b/],
				['a "cheap" literal', /["']cheap["']/],
				['a "deep" literal', /["']deep["']/],
				["a cheap table row", /^\s*cheap\s*:/m],
				["a deep table row", /^\s*deep\s*:/m],
			] as const) {
				if (pattern.test(text)) offenders.push(`${name}: ${what}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe("envelope purity", () => {
	it("imports nothing but its own refusal type", async () => {
		// The table is a constant: it takes no `ctx`, reads no host, and its
		// module graph is one file plus the library's error type. That is what
		// makes replay law 3 checkable rather than merely intended.
		const root = new URL("../src/", import.meta.url);
		const seen = new Set<string>();
		const external = new Set<string>();
		const queue = [new URL("components/envelope.ts", root)];
		for (let next = queue.shift(); next; next = queue.shift()) {
			if (seen.has(next.href)) continue;
			seen.add(next.href);
			const ast = parse(await readFile(next, "utf8"), {
				sourceType: "module",
				plugins: ["typescript"],
			});
			for (const node of ast.program.body) {
				let source: string | undefined;
				if (node.type === "ImportDeclaration") {
					if (node.importKind === "type") continue;
					if (
						node.specifiers.length > 0 &&
						node.specifiers.every(
							(specifier) =>
								specifier.type === "ImportSpecifier" &&
								specifier.importKind === "type",
						)
					) {
						continue;
					}
					source = node.source.value;
				} else if (node.type === "ExportNamedDeclaration" && node.source) {
					if (node.exportKind === "type") continue;
					source = node.source.value;
				} else if (node.type === "ExportAllDeclaration") {
					if (node.exportKind === "type") continue;
					source = node.source.value;
				}
				if (source === undefined) continue;
				if (source.startsWith(".")) {
					queue.push(new URL(source.replace(/\.js$/, ".ts"), next));
				} else {
					external.add(source);
				}
			}
		}
		expect(
			[...seen].map((href) => href.slice(root.href.length)).sort(),
		).toEqual(["components/envelope.ts", "components/errors.ts"]);
		expect([...external]).toEqual([]);
	});
});
