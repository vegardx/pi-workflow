import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { envelope, WORKSPACE_WRITE_BYTES } from "../src/components/envelope.js";
import { WorkflowComponentError } from "../src/components/errors.js";
import {
	type CheckReport,
	CheckReportSchema,
	MAX_VERIFY_ROUNDS,
	nextRung,
	projectVerifyAndFixBudget,
	type VerifyAndFixContext,
	type VerifyAndFixOptions,
	verifyAndFix,
} from "../src/components/verify-and-fix.js";
import type { TaskKey, WorkflowBudget } from "../src/contracts-core.js";
import type {
	AgentTaskAuthoringRequest,
	TaskHandle,
	WorktreeTaskHandle,
} from "../src/definition.js";
import type { WorkflowEventInput } from "../src/events.js";
import { WorkflowTaskMaterializer } from "../src/materializer.js";

// W1-COMP-C acceptance. Every expectation below is the plan-loop spec
// (sections 2.3, 5 and 6) or the replay laws of
// `composition-and-plan-loop-analysis.md`, not the component's implementation.
// The lowering assertions drive the REAL materializer with scripted barrier
// outcomes: a round the component declares must be byte-identical to the
// hand-written `ctx.agent` + `ctx.result` it claims to be, task identities
// included.

const RUN_ID = "workflow_components";
const DEFINITION_IDENTITY = "a".repeat(64);
const INPUT_DIGEST = "b".repeat(64);

const FixSchema = Type.Object(
	{ summary: Type.String() },
	{ additionalProperties: false },
);

/** The implementer whose handoff the loop verifies. */
function implementRequest(): AgentTaskAuthoringRequest<
	typeof FixSchema,
	{ readonly mode: "worktree"; readonly cwd: string }
> {
	return {
		agent: "implementer",
		task: {
			goal: "Implement the deliverable",
			context: [],
			instructions: ["Leave the change in the working tree."],
		},
		contextMode: "fresh",
		tools: ["read", "edit", "write", "bash"],
		preloadSkills: [],
		contextScopes: ["project"],
		workspace: { mode: "worktree", cwd: "/repo" },
		handoff: "required",
		outputSchema: FixSchema,
		limits: envelope("standard", "implement").limits,
		model: envelope("standard", "implement").model,
		retry: { attempts: 1, on: ["backoff"] },
	};
}

/** What a caller writes for a verifier: prose, tools, workspace. No dials. */
function verifyRequest(round: number) {
	return {
		agent: "verifier",
		task: {
			goal: `Run \`npm run check\` over the patch, round ${round}`,
			context: [],
			instructions: [
				"Apply the `patch` input's handoff ref, then run the check.",
				"Report the check truthfully; `checkRan` is true only if it completed.",
			],
		},
		contextMode: "fresh" as const,
		tools: ["read", "grep", "find", "ls", "bash"],
		preloadSkills: [],
		contextScopes: ["project" as const],
		workspace: { mode: "worktree" as const, cwd: "/repo" },
		retry: { attempts: 1, on: ["backoff" as const] },
	};
}

/** What a caller writes for a fixer. Worktree, prose, no model and no limits. */
function fixRequest(round: number) {
	return {
		agent: "implementer",
		task: {
			goal: `Fix what the check reported, round ${round}`,
			context: [],
			instructions: [
				"Apply the `patch` input's handoff ref, read `check`, then fix it.",
			],
		},
		contextMode: "fresh" as const,
		tools: ["read", "edit", "write", "bash"],
		preloadSkills: [],
		contextScopes: ["project" as const],
		workspace: { mode: "worktree" as const, cwd: "/repo" },
		outputSchema: FixSchema,
		retry: { attempts: 1, on: ["backoff" as const] },
	};
}

/** The `verify` row is read-only; a worktree verifier takes the write grant. */
function verifyWorktreeLimits() {
	return {
		...envelope("standard", "verify").limits,
		workspaceWriteBytes: WORKSPACE_WRITE_BYTES,
	};
}

function report(overrides: Partial<CheckReport> = {}): CheckReport {
	return {
		summary: "Ran the repository check.",
		checkCommand: "npm run check",
		checkRan: true,
		checkPassed: true,
		checkTail: "",
		...overrides,
	};
}

const PASSED = report();
const FAILED = report({
	checkPassed: false,
	checkTail: "1 test failed",
	summary: "The check failed.",
});
const NOT_RUN = report({
	checkRan: false,
	checkPassed: false,
	checkTail: "",
	summary: "The install was killed before the check ran.",
});

interface Harness {
	readonly ctx: VerifyAndFixContext;
	readonly materializer: WorkflowTaskMaterializer;
	readonly logs: readonly string[];
	/** Closes a `result` epoch by hand, as `ctx.result` does for the component. */
	barrier(tasks: readonly TaskHandle<unknown>[]): void;
	/** Closes the final epoch and returns every `task-declared` event. */
	finish(final: readonly TaskHandle<unknown>[]): readonly WorkflowEventInput[];
}

/**
 * A context whose declarations go through the real `WorkflowTaskMaterializer`
 * exactly as `src/static-runtime.ts` lowers them, with scripted `ctx.result`
 * outcomes. Same run id and same digests in every harness, so two runs that
 * declare the same graph produce byte-identical events and identities.
 */
function harness(reports: readonly CheckReport[] = []): Harness {
	const materializer = new WorkflowTaskMaterializer({
		runId: RUN_ID,
		definitionIdentitySha256: DEFINITION_IDENTITY,
		inputSha256: INPUT_DIGEST,
	});
	const events: WorkflowEventInput[] = [];
	const logs: string[] = [];
	let next = 0;
	const ctx = {
		log(message: string) {
			logs.push(message);
		},
		agent(key: string, request: AgentTaskAuthoringRequest<typeof FixSchema>) {
			return materializer.agent(key, request);
		},
		async result(task: TaskHandle<unknown>) {
			events.push(...materializer.closeEpoch("result", [task]).events);
			const scripted = reports[next];
			next += 1;
			if (!scripted) throw new Error(`no scripted report for barrier ${next}`);
			return scripted;
		},
	} as unknown as VerifyAndFixContext;
	return {
		ctx,
		materializer,
		logs,
		barrier(tasks) {
			events.push(...materializer.closeEpoch("result", tasks).events);
		},
		finish(final) {
			events.push(...materializer.closeEpoch("final", final).events);
			return events.filter((event) => event.type === "task-declared");
		},
	};
}

function implementation(h: Harness): WorktreeTaskHandle<unknown> {
	return h.materializer.agent(
		"implement",
		implementRequest(),
	) as WorktreeTaskHandle<unknown>;
}

function options(
	impl: WorktreeTaskHandle<unknown>,
	overrides: Partial<VerifyAndFixOptions<typeof FixSchema>> = {},
): VerifyAndFixOptions<typeof FixSchema> {
	return {
		implementation: impl,
		check: { command: "npm run check", install: "npm ci" },
		effort: "standard",
		maxRounds: 2,
		verify: (round) => verifyRequest(round),
		agent: (round) => fixRequest(round),
		...overrides,
	};
}

function keys(events: readonly WorkflowEventInput[]): readonly string[] {
	return events.flatMap((event) =>
		event.type === "task-declared" ? [event.data.task.spec.key] : [],
	);
}

describe("verifyAndFix lowering", () => {
	it("declares one verifier and stops when the first round is green", async () => {
		const component = harness([PASSED]);
		const impl = implementation(component);
		const result = await verifyAndFix(component.ctx, "green", options(impl));
		const lowered = component.finish([result.handoff]);

		const hand = harness();
		const handImpl = implementation(hand);
		const verifier = hand.materializer.agent("green-verify-1", {
			...verifyRequest(1),
			handoff: "optional",
			outputSchema: CheckReportSchema,
			model: envelope("standard", "verify").model,
			limits: verifyWorktreeLimits(),
			inputs: { patch: handImpl.handoff },
		});
		hand.barrier([verifier]);
		const written = hand.finish([handImpl]);

		expect(keys(lowered)).toEqual(["implement", "green-verify-1"]);
		expect(JSON.stringify(lowered)).toBe(JSON.stringify(written));
		expect(result.rounds).toBe(1);
		expect(result.passed).toBe(true);
		expect(result.checkRan).toBe(true);
		expect(result.handoff).toBe(impl);
	});

	it("declares verify, fix, verify when the first round fails and the second passes", async () => {
		const component = harness([FAILED, PASSED]);
		const impl = implementation(component);
		const result = await verifyAndFix(component.ctx, "green", options(impl));
		const lowered = component.finish([result.handoff]);

		const hand = harness();
		const handImpl = implementation(hand);
		const verifyOne = hand.materializer.agent("green-verify-1", {
			...verifyRequest(1),
			handoff: "optional",
			outputSchema: CheckReportSchema,
			model: envelope("standard", "verify").model,
			limits: verifyWorktreeLimits(),
			inputs: { patch: handImpl.handoff },
		});
		hand.barrier([verifyOne]);
		const fixOne = hand.materializer.agent("green-fix-1", {
			...fixRequest(1),
			model: envelope("standard", "fix").model,
			limits: envelope("standard", "fix").limits,
			handoff: "required",
			inputs: { patch: handImpl.handoff, check: verifyOne.output },
		}) as WorktreeTaskHandle<unknown>;
		const verifyTwo = hand.materializer.agent("green-verify-2", {
			...verifyRequest(2),
			handoff: "optional",
			outputSchema: CheckReportSchema,
			model: envelope("standard", "verify").model,
			limits: verifyWorktreeLimits(),
			inputs: { patch: fixOne.handoff },
		});
		hand.barrier([verifyTwo]);
		const written = hand.finish([fixOne]);

		expect(keys(lowered)).toEqual([
			"implement",
			"green-verify-1",
			"green-fix-1",
			"green-verify-2",
		]);
		expect(JSON.stringify(lowered)).toBe(JSON.stringify(written));
		expect(result.rounds).toBe(2);
		expect(result.passed).toBe(true);
		expect(result.handoff).toBe(result.history[0]?.fix);
		expect(result.history[0]?.fixKey).toBe("green-fix-1");
		expect(result.history[1]?.fixKey).toBeUndefined();
	});

	it("stops at the cap with passed false and declares no fixer it cannot verify", async () => {
		const component = harness([FAILED, FAILED]);
		const impl = implementation(component);
		const result = await verifyAndFix(component.ctx, "green", options(impl));
		const lowered = component.finish([result.handoff]);

		expect(keys(lowered)).toEqual([
			"implement",
			"green-verify-1",
			"green-fix-1",
			"green-verify-2",
		]);
		expect(keys(lowered)).not.toContain("green-fix-2");
		expect(result.rounds).toBe(2);
		expect(result.passed).toBe(false);
		expect(result.checkRan).toBe(true);
		expect(result.lastTail).toBe("1 test failed");
		// The fixer's patch is what a human is handed, still failing.
		expect(result.handoff).toBe(result.history[0]?.fix);
		expect(component.logs.join("\n")).toContain("the cap");
	});

	it("escalates a check that did not run to a human instead of looping", async () => {
		const component = harness([NOT_RUN]);
		const impl = implementation(component);
		const result = await verifyAndFix(component.ctx, "green", options(impl));
		const lowered = component.finish([result.handoff]);

		expect(keys(lowered)).toEqual(["implement", "green-verify-1"]);
		expect(result.rounds).toBe(1);
		expect(result.passed).toBe(false);
		expect(result.checkRan).toBe(false);
		expect(result.handoff).toBe(impl);
		expect(component.logs.join("\n")).toContain("unverified, not broken");
	});

	it("never counts a dishonest checkPassed without checkRan as green", async () => {
		const component = harness([report({ checkRan: false })]);
		const impl = implementation(component);
		const result = await verifyAndFix(component.ctx, "green", options(impl));
		component.finish([result.handoff]);
		expect(result.passed).toBe(false);
	});

	it("declares nothing at all for maxRounds 0", async () => {
		const component = harness();
		const impl = implementation(component);
		const result = await verifyAndFix(
			component.ctx,
			"green",
			options(impl, { maxRounds: 0 }),
		);
		expect(keys(component.finish([impl]))).toEqual(["implement"]);
		expect(result).toEqual({
			rounds: 0,
			passed: false,
			checkRan: false,
			lastTail: "",
			handoff: impl,
			history: [],
		});
	});

	it("verifies once and never fixes at maxRounds 1", async () => {
		const component = harness([FAILED]);
		const impl = implementation(component);
		const result = await verifyAndFix(
			component.ctx,
			"green",
			options(impl, { maxRounds: 1 }),
		);
		expect(keys(component.finish([result.handoff]))).toEqual([
			"implement",
			"green-verify-1",
		]);
		expect(result.passed).toBe(false);
		expect(result.handoff).toBe(impl);
	});

	it("declares two fix rounds at the cap of three verify rounds", async () => {
		// `maxFixRounds: 2` (the plan vocabulary's maximum, spec 2.1) compiles to
		// `maxRounds = 3`: three verifiers, two fixers, and no fix left unchecked.
		const component = harness([FAILED, FAILED, FAILED]);
		const impl = implementation(component);
		const result = await verifyAndFix(
			component.ctx,
			"green",
			options(impl, { maxRounds: MAX_VERIFY_ROUNDS as 3 }),
		);
		expect(keys(component.finish([result.handoff]))).toEqual([
			"implement",
			"green-verify-1",
			"green-fix-1",
			"green-verify-2",
			"green-fix-2",
			"green-verify-3",
		]);
		expect(result.rounds).toBe(3);
		expect(result.passed).toBe(false);
		expect(result.handoff).toBe(result.history[1]?.fix);
		expect(component.logs.join("\n")).toContain("the cap");
	});

	it("applies a default disposition and keeps an explicit one", async () => {
		const component = harness([FAILED, FAILED]);
		const impl = implementation(component);
		const result = await verifyAndFix(
			component.ctx,
			"green",
			options(impl, {
				disposition: "optional",
				agent: (round) => ({
					...fixRequest(round),
					disposition: "required" as const,
				}),
			}),
		);
		const declared = component
			.finish([result.handoff])
			.map((event) =>
				event.type === "task-declared" && event.data.task.spec.kind === "agent"
					? [event.data.task.spec.key, event.data.task.spec.disposition]
					: [],
			);
		expect(declared).toEqual([
			["implement", "required"],
			["green-verify-1", "optional"],
			["green-fix-1", "required"],
			["green-verify-2", "optional"],
		]);
	});
});

describe("verifyAndFix keys", () => {
	it("names every round from the key and the ordinal alone", async () => {
		const component = harness([FAILED, FAILED]);
		const impl = implementation(component);
		const result = await verifyAndFix(
			component.ctx,
			"loop-catalogue",
			options(impl),
		);
		expect(keys(component.finish([result.handoff]))).toEqual([
			"implement",
			"loop-catalogue-verify-1",
			"loop-catalogue-fix-1",
			"loop-catalogue-verify-2",
		]);
	});

	it("declares identical tasks and identities across materializations", async () => {
		const declare = async () => {
			const h = harness([FAILED, FAILED]);
			const impl = implementation(h);
			const result = await verifyAndFix(h.ctx, "green", options(impl));
			return h.finish([result.handoff]);
		};
		expect(JSON.stringify(await declare())).toBe(
			JSON.stringify(await declare()),
		);
	});

	it("keeps the keys when the prose of a round changes", async () => {
		const component = harness([FAILED, PASSED]);
		const impl = implementation(component);
		const result = await verifyAndFix(
			component.ctx,
			"green",
			options(impl, {
				verify: (round, previous) => ({
					...verifyRequest(round),
					task: {
						goal: `Round ${round} after ${previous?.report.checkTail ?? "nothing"}`,
						context: [],
						instructions: ["Report the check truthfully."],
					},
				}),
			}),
		);
		expect(keys(component.finish([result.handoff]))).toEqual([
			"implement",
			"green-verify-1",
			"green-fix-1",
			"green-verify-2",
		]);
	});
});

describe("verifyAndFix effort", () => {
	it("runs a verifier at the effort's verify row and a fixer at its fix row", async () => {
		const component = harness([FAILED, PASSED]);
		const impl = implementation(component);
		const result = await verifyAndFix(component.ctx, "green", options(impl));
		const byKey = new Map(
			component
				.finish([result.handoff])
				.flatMap((event) =>
					event.type === "task-declared" &&
					event.data.task.spec.kind === "agent"
						? [[event.data.task.spec.key, event.data.task.spec.request]]
						: [],
				),
		);
		expect(byKey.get("green-verify-1")?.model).toEqual(
			envelope("standard", "verify").model,
		);
		expect(byKey.get("green-fix-1")?.model).toEqual(
			envelope("standard", "fix").model,
		);
		expect(byKey.get("green-fix-1")?.limits).toEqual(
			envelope("standard", "fix").limits,
		);
	});

	it("escalates a fixer exactly one rung when asked, and never the verifier", async () => {
		const component = harness([FAILED, PASSED]);
		const impl = implementation(component);
		const result = await verifyAndFix(
			component.ctx,
			"green",
			options(impl, { escalate: "thinking" }),
		);
		const byKey = new Map(
			component
				.finish([result.handoff])
				.flatMap((event) =>
					event.type === "task-declared" &&
					event.data.task.spec.kind === "agent"
						? [[event.data.task.spec.key, event.data.task.spec.request]]
						: [],
				),
		);
		expect(byKey.get("green-fix-1")?.model).toEqual(
			envelope("deep", "fix").model,
		);
		expect(byKey.get("green-fix-1")?.limits).toEqual(
			envelope("deep", "fix").limits,
		);
		expect(byKey.get("green-verify-1")?.model).toEqual(
			envelope("standard", "verify").model,
		);
		expect(result.history[0]?.fixEffort).toBe("deep");
	});

	it("is a pure ladder lookup", () => {
		expect(nextRung("cheap")).toBe("standard");
		expect(nextRung("standard")).toBe("deep");
		expect(nextRung("deep")).toBeUndefined();
		expect(projectVerifyAndFixBudget("standard", "none", 2)).toEqual(
			projectVerifyAndFixBudget("standard", "none", 2),
		);
	});
});

describe("verifyAndFix budget", () => {
	it("projects the worst case as every verifier plus every fixer", () => {
		expect(projectVerifyAndFixBudget("standard", "none", 0)).toEqual([]);
		expect(projectVerifyAndFixBudget("standard", "none", 1)).toEqual([
			envelope("standard", "verify").budgetShare,
		]);
		expect(projectVerifyAndFixBudget("standard", "thinking", 2)).toEqual([
			envelope("standard", "verify").budgetShare,
			envelope("deep", "fix").budgetShare,
			envelope("standard", "verify").budgetShare,
		]);
	});

	it("admits a worst case that fits", async () => {
		const shares = projectVerifyAndFixBudget("standard", "none", 2);
		const budget: WorkflowBudget = {
			cost: shares.reduce((sum, share) => sum + share.cost, 0),
			totalTokens: shares.reduce((sum, share) => sum + share.totalTokens, 0),
			childRuntimeMs: shares.reduce(
				(sum, share) => sum + share.childRuntimeMs,
				0,
			),
		};
		const component = harness([FAILED, PASSED]);
		const impl = implementation(component);
		const result = await verifyAndFix(
			component.ctx,
			"green",
			options(impl, { budget }),
		);
		expect(result.rounds).toBe(2);
	});

	it("refuses a worst case one unit over the run budget", async () => {
		const shares = projectVerifyAndFixBudget("standard", "none", 2);
		const budget: WorkflowBudget = {
			cost: shares.reduce((sum, share) => sum + share.cost, 0) - 1,
			totalTokens: shares.reduce((sum, share) => sum + share.totalTokens, 0),
			childRuntimeMs: shares.reduce(
				(sum, share) => sum + share.childRuntimeMs,
				0,
			),
		};
		const component = harness([]);
		const impl = implementation(component);
		await expect(
			verifyAndFix(component.ctx, "green", options(impl, { budget })),
		).rejects.toThrow(/exceeds the run budget/);
		// Nothing was declared: the refusal lands before the first verifier.
		expect(keys(component.finish([impl]))).toEqual(["implement"]);
	});
});

describe("verifyAndFix refusals", () => {
	async function refusal(
		overrides: Partial<VerifyAndFixOptions<typeof FixSchema>>,
		key: TaskKey = "green",
		reports: readonly CheckReport[] = [],
	) {
		const component = harness(reports);
		const impl = implementation(component);
		return verifyAndFix(component.ctx, key, options(impl, overrides));
	}

	it("refuses a key that is not a task key", async () => {
		await expect(refusal({}, "Green" as TaskKey)).rejects.toBeInstanceOf(
			WorkflowComponentError,
		);
	});

	it("refuses maxRounds outside 0..3", async () => {
		await expect(refusal({ maxRounds: 4 as 0 | 1 | 2 | 3 })).rejects.toThrow(
			new RegExp(`runs 0\\.\\.${MAX_VERIFY_ROUNDS} verify rounds`),
		);
		await expect(refusal({ maxRounds: -1 as 0 | 1 | 2 | 3 })).rejects.toThrow(
			/verify rounds/,
		);
		await expect(refusal({ maxRounds: 1.5 as 0 | 1 | 2 | 3 })).rejects.toThrow(
			/verify rounds/,
		);
	});

	it("refuses a missing check command", async () => {
		await expect(refusal({ check: { command: "  " } })).rejects.toThrow(
			/declares no check command/,
		);
		await expect(
			refusal({ check: undefined as unknown as { command: string } }),
		).rejects.toThrow(/declares no check command/);
	});

	it("refuses a non-worktree implementation", async () => {
		const component = harness();
		const readOnly = component.materializer.agent("implement", {
			...implementRequest(),
			workspace: { mode: "read-only", cwd: "/repo" },
			handoff: undefined,
			limits: envelope("standard", "verify").limits,
		} as unknown as AgentTaskAuthoringRequest<typeof FixSchema>);
		await expect(
			verifyAndFix(
				component.ctx,
				"green",
				options(readOnly as WorktreeTaskHandle<unknown>),
			),
		).rejects.toThrow(/needs a worktree implementation handle/);
	});

	it("refuses an escalation above deep", async () => {
		await expect(
			refusal({ effort: "deep", escalate: "thinking" }),
		).rejects.toThrow(/where the effort ladder ends/);
	});

	it("refuses an unknown effort and an unknown escalation", async () => {
		await expect(refusal({ effort: "thorough" as never })).rejects.toThrow(
			/unknown effort/,
		);
		await expect(refusal({ escalate: "more" as never })).rejects.toThrow(
			/unknown escalation/,
		);
	});

	it("refuses a missing factory for the rounds asked for", async () => {
		await expect(
			refusal({ verify: undefined as never, maxRounds: 1 }),
		).rejects.toThrow(/requires a `verify` function/);
		await expect(refusal({ agent: undefined as never })).rejects.toThrow(
			/requires an `agent` function/,
		);
	});

	it("refuses a declaration that sets a dial the component owns", async () => {
		await expect(
			refusal(
				{
					verify: (round) => ({
						...verifyRequest(round),
						model: envelope("deep", "verify").model,
					}),
				},
				"green",
				[PASSED],
			),
		).rejects.toThrow(/declares `model`, which verifyAndFix owns/);
		await expect(
			refusal(
				{
					verify: (round) => ({
						...verifyRequest(round),
						outputSchema: FixSchema,
					}),
				},
				"green",
				[PASSED],
			),
		).rejects.toThrow(/declares `outputSchema`, which verifyAndFix owns/);
		await expect(
			refusal(
				{
					agent: (round) => ({
						...fixRequest(round),
						handoff: "optional" as const,
					}),
				},
				"green",
				[FAILED, PASSED],
			),
		).rejects.toThrow(/declares `handoff`, which verifyAndFix owns/);
	});

	it("refuses a fixer that is not a worktree task", async () => {
		await expect(
			refusal(
				{
					agent: ((round: number) => ({
						...fixRequest(round),
						workspace: { mode: "read-only" as const, cwd: "/repo" },
					})) as never,
				},
				"green",
				[FAILED, PASSED],
			),
		).rejects.toThrow(/must run in a worktree/);
	});

	it("refuses a declaration that claims an input the loop wires", async () => {
		await expect(
			refusal(
				{
					verify: (round) => ({
						...verifyRequest(round),
						inputs: {
							patch: foreignArtifactHandle(),
						},
					}),
				},
				"green",
				[PASSED],
			),
		).rejects.toThrow(/which the loop already wires/);
	});

	it("refuses one input name for two different artifacts", async () => {
		await expect(
			refusal({
				patchInput: "same" as TaskKey,
				reportInput: "same" as TaskKey,
			}),
		).rejects.toThrow(/two different artifacts/);
	});

	it("refuses a round key that would not be a task key", async () => {
		await expect(refusal({}, "g".repeat(126) as TaskKey)).rejects.toThrow(
			/is not a task key/,
		);
	});

	it("refuses a factory that returns something that is not a declaration", async () => {
		await expect(
			refusal({ verify: (() => null) as never }, "green", [PASSED]),
		).rejects.toThrow(/is not a declaration/);
	});
});

/** A result handle the caller might pass, used only to collide with a wired input. */
function foreignArtifactHandle() {
	const h = harness();
	return implementation(h).output;
}
