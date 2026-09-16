import { readFile } from "node:fs/promises";
import { parse } from "@babel/parser";
import { ExactModelRequestSchema, RunLimitsSchema } from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	assertBudgetAdmits,
	budgetAdmits,
	DIVERSE_MODEL_ID,
	EFFORTS,
	type Effort,
	ENVELOPE_STAGES,
	envelope,
	gateTimeoutMs,
	MODEL_ID,
	MODEL_PROVIDER,
	type StageName,
	sumBudgetShares,
	THINKING_BY_TIER,
	WORKSPACE_WRITE_BYTES,
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

const REVIEW_OUTPUT = Type.Object(
	{ verdict: Type.String() },
	{ additionalProperties: false },
);

describe("the effort table", () => {
	it("covers every stage at every effort and is a pure lookup", () => {
		expect([...EFFORTS]).toEqual(["cheap", "standard", "deep"]);
		expect([...ENVELOPE_STAGES]).toEqual([
			"refine",
			"implement",
			"verify",
			"fix",
			"review",
			"synthesis",
			"record",
		]);
		for (const effort of EFFORTS) {
			for (const stage of ENVELOPE_STAGES) {
				const first = envelope(effort, stage);
				const second = envelope(effort, stage);
				// Replay law 3: the lookup reads nothing but its two arguments.
				expect(first).toEqual(second);
				expect(first).toBe(second);
				expect(Object.isFrozen(first)).toBe(true);
				expect(Object.isFrozen(first.limits)).toBe(true);
				expect(first.effort).toBe(effort);
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
		}
	});

	it("gives only the writing stages a worktree write allowance", () => {
		for (const effort of EFFORTS) {
			for (const stage of ENVELOPE_STAGES) {
				const writes = stage === "implement" || stage === "fix";
				expect(envelope(effort, stage).limits.workspaceWriteBytes).toBe(
					writes ? WORKSPACE_WRITE_BYTES : 0,
				);
			}
		}
		// W1's floor for a real `npm ci` plus build in the guest.
		expect(WORKSPACE_WRITE_BYTES).toBe(2 * 1024 * 1024 * 1024);
	});

	it("spends more as the effort rises and never less", () => {
		for (const stage of ENVELOPE_STAGES) {
			const [cheap, standard, deep] = EFFORTS.map(
				(effort) => envelope(effort, stage).budgetShare,
			) as [
				ReturnType<typeof envelope>["budgetShare"],
				ReturnType<typeof envelope>["budgetShare"],
				ReturnType<typeof envelope>["budgetShare"],
			];
			expect(standard.cost).toBeGreaterThanOrEqual(cheap.cost);
			expect(deep.cost).toBeGreaterThanOrEqual(standard.cost);
			expect(standard.totalTokens).toBeGreaterThanOrEqual(cheap.totalTokens);
			expect(deep.totalTokens).toBeGreaterThanOrEqual(standard.totalTokens);
		}
	});

	it("pins the stand-in routing and the gate timeouts", () => {
		// DELETE WHEN ROUTING LANDS: these three literals are the stand-in for
		// host routing, and the tier map is the review dial that outranks the
		// effort column.
		expect(envelope("standard", "review").model).toEqual({
			provider: MODEL_PROVIDER,
			id: MODEL_ID,
			thinking: "medium",
		});
		expect(DIVERSE_MODEL_ID).not.toBe(MODEL_ID);
		expect(THINKING_BY_TIER).toEqual({
			light: "low",
			standard: "medium",
			heavy: "high",
		});
		expect(gateTimeoutMs("cheap")).toBe(14_400_000);
		expect(gateTimeoutMs("standard")).toBe(86_400_000);
		expect(gateTimeoutMs("deep")).toBe(172_800_000);
	});

	it("refuses an effort or a stage the table does not cover", () => {
		expect(() => envelope("thorough" as Effort, "review")).toThrow(
			'unknown effort "thorough"; the effort dial is one of cheap, standard, deep.',
		);
		expect(() => envelope("deep", "publish" as StageName)).toThrow(
			'unknown envelope stage "publish"; the table covers refine, implement, verify, fix, review, synthesis, record.',
		);
		expect(() => gateTimeoutMs("thorough" as Effort)).toThrow(
			WorkflowComponentError,
		);
	});
});

describe("envelope lowering", () => {
	it("declares exactly what the hand-written request declares", () => {
		const lowered = materializer();
		const row = envelope("standard", "review");
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
			const row = envelope("deep", "implement");
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
		envelope("standard", "implement").budgetShare,
		envelope("standard", "review").budgetShare,
		envelope("standard", "review").budgetShare,
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
