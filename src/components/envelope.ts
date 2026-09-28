import type { ExactModelRequest, RunLimits } from "@vegardx/pi-subagent";
import type { WorkflowBudget } from "../contracts-core.js";
import { WorkflowComponentError } from "./errors.js";

/**
 * `envelope` — one fixed row per stage: the thinking level, limits and budget
 * share a stage that does not inherit the session model runs at.
 *
 * Pattern: `skills/workflow-authoring/SKILL.md` § "An envelope: one row per stage, and a model per role".
 * The rules it encodes live under "Budgets and admission" (the
 * scheduler admits a task only while `settled + reserved + candidate <=
 * meta.budget`, and a run with a token budget needs `limits.totalTokens` on
 * every agent task) and "Barriers and replay" (everything declared before a
 * barrier must be deterministic).
 *
 * THERE IS NO EFFORT DIAL. A workflow used to read `cheap | standard | deep`
 * from its input and every model, limit and budget share was a lookup on that
 * column. The dial is gone: the numbers here are what its `standard` column
 * measured, and a role that wants a different model says so per role — an exact
 * `{provider, id, thinking}`, or `model: "inherit"` for the host session's own
 * model and thinking level, which pi-workflow resolves once at run start and
 * records on the run (`WorkflowRunRecord.sessionModel`).
 *
 * Replay law 3: every thinking level, limit and budget share is a table lookup
 * keyed by `stage` alone - never by a clock, an environment variable, a
 * measurement, or anything observed at run time. `envelope` takes no `ctx`: it
 * cannot read one. `inherit` does not break that law, because it resolves to
 * the run record's own frozen value rather than to whatever the host would
 * answer now.
 *
 * What it lowers to: `limits` and `model` go on an agent request verbatim, and
 * `budgetShare` is the same task's reservation, so summing the shares of the
 * declared graph gives the `meta.budget` the run needs
 * (`workflowBudgetFor`) and comparing them to a declared budget is the
 * over-allocation check `forEach` and `verifyAndFix` make at declaration
 * (`assertBudgetAdmits`).
 *
 * DELETE WHEN ROUTING LANDS. `MODEL_PROVIDER`/`MODEL_ID`/`DIVERSE_MODEL_ID`
 * are the stand-in for host routing: today a task names one exact
 * `{provider, id, thinking}`, so "a heavy reviewer from another family" has to
 * be written as a second literal model. When `modelRole` and the routing port
 * land (spec 2.5), `Envelope.model` becomes a `modelRole` request, `tier`
 * replaces the thinking column, and `DIVERSE_MODEL_ID` becomes
 * `family: "other"`. The table's shape - one row per stage - does not change,
 * which is the point of keeping it in one place.
 */

/**
 * The stages the library declares. `implement` and `fix` write in a worktree;
 * every other stage is read-only and writes nothing.
 */
export const ENVELOPE_STAGES = Object.freeze([
	"refine",
	"implement",
	"verify",
	"fix",
	"review",
	"synthesis",
	"record",
] as const);
export type StageName = (typeof ENVELOPE_STAGES)[number];

export type ThinkingLevel = ExactModelRequest["thinking"];

/** A review tier: the one dial a review still has, and reviews only. */
export type EnvelopeTier = "light" | "standard" | "heavy";

/** The three tiers, in order, for a schema or a message that lists them. */
export const ENVELOPE_TIERS = Object.freeze([
	"light",
	"standard",
	"heavy",
] as const);

/** DELETE WHEN ROUTING LANDS: the host's routing decides these three. */
export const MODEL_PROVIDER = "github-copilot";
export const MODEL_ID = "gpt-5.6-sol";
/** The "different family" stand-in a diverse reviewer resolves to. */
export const DIVERSE_MODEL_ID = "gpt-5.6-luna";

/** What a review tier means as a thinking level; DELETE WHEN ROUTING LANDS. */
export const THINKING_BY_TIER: Readonly<Record<EnvelopeTier, ThinkingLevel>> =
	Object.freeze({
		light: "low",
		standard: "medium",
		heavy: "high",
	});

/**
 * The exact model a review tier resolves to, in one place: the stand-in
 * provider and id, with the tier's thinking level, and the other-family id
 * when the lens asked not to mark its own homework.
 * DELETE WHEN ROUTING LANDS: this becomes `modelRole: { tier, family }`.
 */
export function tierModel(
	tier: EnvelopeTier,
	diverse = false,
): ExactModelRequest {
	return Object.freeze({
		provider: MODEL_PROVIDER,
		id: diverse ? DIVERSE_MODEL_ID : MODEL_ID,
		thinking: THINKING_BY_TIER[tier],
	});
}

/**
 * W1 measured a real `npm ci` plus build in the guest: anything smaller fails
 * the install rather than the task, which reads as a model failure and is not
 * one.
 */
export const WORKSPACE_WRITE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Guest VM memory for a worktree stage. It is not part of an `Envelope`: it is
 * a pi-subagent request field rather than a workflow limit, and what it narrows
 * is the implementer agent's own 4 GiB ceiling. W1 measured 512 MiB (the
 * default when nothing narrows the ceiling) killing a real `npm ci`.
 */
export const WORKTREE_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * How long a gate waits for a person before it expires. One number: a decision
 * a person has to take does not get shorter because the work was cheaper.
 */
export const GATE_TIMEOUT_MS = 86_400_000;

/** What one task reserves against `meta.budget`, in the budget's own units. */
export interface BudgetShare {
	readonly cost: number;
	readonly totalTokens: number;
	readonly childRuntimeMs: number;
}

/** One row of the table: everything a stage's declaration needs. */
export interface Envelope {
	readonly stage: StageName;
	readonly thinking: ThinkingLevel;
	/** DELETE WHEN ROUTING LANDS: becomes a `modelRole` request. */
	readonly model: ExactModelRequest;
	readonly limits: RunLimits;
	readonly budgetShare: BudgetShare;
}

interface StageShape {
	readonly thinking: ThinkingLevel;
	readonly cumulativeRuntimeMs: number;
	readonly attemptTimeoutMs: number;
	readonly totalTokens: number;
	readonly cost: number;
	readonly outputBytes: number;
	readonly write: "none" | "worktree";
}

function readOnly(
	thinking: ThinkingLevel,
	cumulativeRuntimeMs: number,
	totalTokens: number,
	cost: number,
	outputBytes = 65_536,
): StageShape {
	return {
		thinking,
		cumulativeRuntimeMs,
		attemptTimeoutMs: cumulativeRuntimeMs,
		totalTokens,
		cost,
		outputBytes,
		write: "none",
	};
}

function worktree(
	thinking: ThinkingLevel,
	cumulativeRuntimeMs: number,
	attemptTimeoutMs: number,
	totalTokens: number,
	cost: number,
): StageShape {
	return {
		thinking,
		cumulativeRuntimeMs,
		attemptTimeoutMs,
		totalTokens,
		cost,
		outputBytes: 65_536,
		write: "worktree",
	};
}

/**
 * THE TABLE. One row per stage, and these are the numbers the effort dial's
 * `standard` column measured:
 *
 * | refine | implement | verify | fix    | review | synthesis | record |
 * | ------ | --------- | ------ | ------ | ------ | --------- | ------ |
 * | medium | medium    | low    | medium | medium | medium    | low    |
 *
 * The thinking level applies to a stage that names no model of its own and does
 * not inherit; a stage that inherits takes the session's level instead, and a
 * review takes its tier's.
 *
 * W1 floors for a worktree stage: >= 2 GiB of workspace writes, >= 1_500_000 ms
 * per attempt, >= 1_800_000 ms cumulative. Every worktree row clears them.
 */
const STAGE_TABLE: Readonly<Record<StageName, StageShape>> = {
	refine: readOnly("medium", 900_000, 1_000_000, 4, 262_144),
	implement: worktree("medium", 2_400_000, 1_800_000, 2_000_000, 12),
	verify: readOnly("low", 900_000, 600_000, 2),
	fix: worktree("medium", 2_400_000, 1_800_000, 2_000_000, 12),
	review: readOnly("medium", 900_000, 1_000_000, 3),
	synthesis: readOnly("medium", 600_000, 600_000, 2),
	record: readOnly("low", 300_000, 200_000, 1),
};

function buildEnvelope(stage: StageName, shape: StageShape): Envelope {
	const limits: RunLimits = Object.freeze({
		cumulativeRuntimeMs: shape.cumulativeRuntimeMs,
		attemptTimeoutMs: shape.attemptTimeoutMs,
		totalTokens: shape.totalTokens,
		cost: shape.cost,
		outputBytes: shape.outputBytes,
		workspaceWriteBytes: shape.write === "worktree" ? WORKSPACE_WRITE_BYTES : 0,
		retries: 1,
		resumes: 1,
	});
	return Object.freeze({
		stage,
		thinking: shape.thinking,
		model: Object.freeze({
			provider: MODEL_PROVIDER,
			id: MODEL_ID,
			thinking: shape.thinking,
		}),
		limits,
		budgetShare: Object.freeze({
			cost: limits.cost,
			totalTokens: shape.totalTokens,
			childRuntimeMs: limits.cumulativeRuntimeMs,
		}),
	});
}

/** One frozen envelope per stage, built once: the lookup allocates nothing. */
const ENVELOPE_TABLE: Readonly<Record<StageName, Envelope>> = Object.freeze(
	Object.fromEntries(
		ENVELOPE_STAGES.map((stage) => [
			stage,
			buildEnvelope(stage, STAGE_TABLE[stage]),
		]),
	) as Record<StageName, Envelope>,
);

function isStageName(value: unknown): value is StageName {
	return (ENVELOPE_STAGES as readonly unknown[]).includes(value);
}

/**
 * The thinking level, model, limits and budget share of one stage. Pure: the
 * same stage always returns the same frozen value, and nothing else is read.
 */
export function envelope(stage: StageName): Envelope {
	if (!isStageName(stage)) {
		throw new WorkflowComponentError(
			"envelope",
			`unknown envelope stage ${JSON.stringify(stage)}; the table covers ${ENVELOPE_STAGES.join(", ")}.`,
		);
	}
	return ENVELOPE_TABLE[stage];
}

/** The reservation of a whole graph: the sum of its tasks' shares. */
export function sumBudgetShares(shares: readonly BudgetShare[]): BudgetShare {
	let cost = 0;
	let totalTokens = 0;
	let childRuntimeMs = 0;
	for (const share of shares) {
		cost += share.cost;
		totalTokens += share.totalTokens;
		childRuntimeMs += share.childRuntimeMs;
	}
	return Object.freeze({ cost, totalTokens, childRuntimeMs });
}

/**
 * The `meta.budget` a graph of these shares needs. `childRuntimeMs` is clamped
 * to the schema's 1_000 ms floor so an empty or tiny graph still declares a
 * legal budget.
 */
export function workflowBudgetFor(
	shares: readonly BudgetShare[],
): WorkflowBudget {
	const total = sumBudgetShares(shares);
	return Object.freeze({
		cost: total.cost,
		totalTokens: Math.max(1, total.totalTokens),
		childRuntimeMs: Math.max(1_000, total.childRuntimeMs),
	});
}

/**
 * Whether a declared budget admits these shares, by the scheduler's own rule:
 * cost, cumulative child runtime, and total tokens when the budget bounds
 * them.
 */
export function budgetAdmits(
	budget: WorkflowBudget,
	shares: readonly BudgetShare[],
): boolean {
	const total = sumBudgetShares(shares);
	if (total.cost > budget.cost) return false;
	if (total.childRuntimeMs > budget.childRuntimeMs) return false;
	return (
		budget.totalTokens === undefined || total.totalTokens <= budget.totalTokens
	);
}

/**
 * Refuses an over-allocated graph at declaration rather than letting it block
 * mid-run at admission. `what` names the declaration in the message, for
 * example `forEach namespace "implement" over 9 items`.
 */
export function assertBudgetAdmits(
	budget: WorkflowBudget,
	shares: readonly BudgetShare[],
	what: string,
): void {
	if (budgetAdmits(budget, shares)) return;
	const total = sumBudgetShares(shares);
	throw new WorkflowComponentError(
		"envelope",
		`${what} reserves cost ${total.cost}, ${total.totalTokens} tokens and ${total.childRuntimeMs} ms of child runtime, which exceeds the run budget (cost ${budget.cost}, ${budget.totalTokens ?? "unbounded"} tokens, ${budget.childRuntimeMs} ms).`,
	);
}
