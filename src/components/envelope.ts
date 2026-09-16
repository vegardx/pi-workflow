import type { ExactModelRequest, RunLimits } from "@vegardx/pi-subagent";
import type { WorkflowBudget } from "../contracts-core.js";
import { WorkflowComponentError } from "./errors.js";

/**
 * `envelope` — the effort dial, as one constant table.
 *
 * Pattern: `skills/workflow-authoring/SKILL.md` § "An envelope: effort as one
 * table". The rules it encodes live under "Budgets and admission" (the
 * scheduler admits a task only while `settled + reserved + candidate <=
 * meta.budget`, and a run with a token budget needs `limits.totalTokens` on
 * every agent task) and "Barriers and replay" (everything declared before a
 * barrier must be deterministic).
 *
 * Replay law 3: every model, thinking level, limit and budget share is a table
 * lookup keyed by `(effort, stage)` alone - never by a clock, an environment
 * variable, a measurement, or anything observed at run time. `envelope` takes
 * no `ctx`: it cannot read one. A definition reads `effort` from `ctx.input`
 * and the whole graph's shape follows from the input, which is what makes a
 * re-execution declare the identical requests.
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
 * `family: "other"`. The table's shape - one row per `(effort, stage)` - does
 * not change, which is the point of keeping it in one place.
 */

export const EFFORTS = Object.freeze(["cheap", "standard", "deep"] as const);
export type Effort = (typeof EFFORTS)[number];

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

/** A review tier, when a lens asks for more or less than its effort column. */
export type EnvelopeTier = "light" | "standard" | "heavy";

/** DELETE WHEN ROUTING LANDS: the host's routing decides these three. */
export const MODEL_PROVIDER = "github-copilot";
export const MODEL_ID = "gpt-5.6-sol";
/** The "different family" stand-in a diverse reviewer resolves to. */
export const DIVERSE_MODEL_ID = "gpt-5.6-luna";

/** A tier outranks the effort column; DELETE WHEN ROUTING LANDS. */
export const THINKING_BY_TIER: Readonly<Record<EnvelopeTier, ThinkingLevel>> =
	Object.freeze({
		light: "low",
		standard: "medium",
		heavy: "high",
	});

/**
 * W1 measured a real `npm ci` plus build in the guest: anything smaller fails
 * the install rather than the task, which reads as a model failure and is not
 * one.
 */
export const WORKSPACE_WRITE_BYTES = 2 * 1024 * 1024 * 1024;

/** What one task reserves against `meta.budget`, in the budget's own units. */
export interface BudgetShare {
	readonly cost: number;
	readonly totalTokens: number;
	readonly childRuntimeMs: number;
}

/** One row of the table: everything a stage's declaration needs. */
export interface Envelope {
	readonly effort: Effort;
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
 * THE EFFORT DIAL. The `refine`, `implement`, `review` and `record` columns are
 * `workflows/plan-to-ship.workflow.ts`'s measured table, moved here verbatim;
 * `verify`, `fix` and `synthesis` extend it for the verify-and-fix loop and the
 * shared review stage.
 *
 * | effort   | refine | implement | verify | fix    | review | synthesis |
 * | -------- | ------ | --------- | ------ | ------ | ------ | --------- |
 * | cheap    | low    | low       | low    | low    | low    | low       |
 * | standard | medium | medium    | low    | medium | medium | medium    |
 * | deep     | high   | high      | medium | high   | high   | high      |
 *
 * W1 floors for a worktree stage: >= 2 GiB of workspace writes, >= 1_500_000 ms
 * per attempt, >= 1_800_000 ms cumulative. The cheap column sits exactly on
 * them.
 */
const STAGE_TABLE: Readonly<
	Record<Effort, Readonly<Record<StageName, StageShape>>>
> = {
	cheap: {
		refine: readOnly("low", 600_000, 400_000, 2, 262_144),
		implement: worktree("low", 1_800_000, 1_500_000, 1_000_000, 8),
		verify: readOnly("low", 600_000, 400_000, 2),
		fix: worktree("low", 1_800_000, 1_500_000, 1_000_000, 8),
		review: readOnly("low", 600_000, 400_000, 2),
		synthesis: readOnly("low", 300_000, 200_000, 1),
		record: readOnly("low", 300_000, 200_000, 1),
	},
	standard: {
		refine: readOnly("medium", 900_000, 1_000_000, 4, 262_144),
		implement: worktree("medium", 2_400_000, 1_800_000, 2_000_000, 12),
		verify: readOnly("low", 900_000, 600_000, 2),
		fix: worktree("medium", 2_400_000, 1_800_000, 2_000_000, 12),
		review: readOnly("medium", 900_000, 1_000_000, 3),
		synthesis: readOnly("medium", 600_000, 600_000, 2),
		record: readOnly("low", 300_000, 200_000, 1),
	},
	deep: {
		refine: readOnly("high", 1_200_000, 2_000_000, 6, 262_144),
		implement: worktree("high", 3_600_000, 2_400_000, 4_000_000, 20),
		verify: readOnly("medium", 1_200_000, 1_000_000, 3),
		fix: worktree("high", 3_600_000, 2_400_000, 4_000_000, 20),
		review: readOnly("high", 1_200_000, 2_000_000, 5),
		synthesis: readOnly("high", 900_000, 1_000_000, 3),
		record: readOnly("low", 300_000, 200_000, 1),
	},
};

/** How long a gate waits for a person before it expires, by effort. */
const GATE_TIMEOUT_MS: Readonly<Record<Effort, number>> = Object.freeze({
	cheap: 14_400_000,
	standard: 86_400_000,
	deep: 172_800_000,
});

function buildEnvelope(
	effort: Effort,
	stage: StageName,
	shape: StageShape,
): Envelope {
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
		effort,
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

/** One frozen envelope per cell, built once: the lookup allocates nothing. */
const ENVELOPE_TABLE: Readonly<
	Record<Effort, Readonly<Record<StageName, Envelope>>>
> = Object.freeze(
	Object.fromEntries(
		EFFORTS.map((effort) => [
			effort,
			Object.freeze(
				Object.fromEntries(
					ENVELOPE_STAGES.map((stage) => [
						stage,
						buildEnvelope(effort, stage, STAGE_TABLE[effort][stage]),
					]),
				),
			),
		]),
	) as Record<Effort, Record<StageName, Envelope>>,
);

function isEffort(value: unknown): value is Effort {
	return (EFFORTS as readonly unknown[]).includes(value);
}

function isStageName(value: unknown): value is StageName {
	return (ENVELOPE_STAGES as readonly unknown[]).includes(value);
}

/**
 * The model, thinking level, limits and budget share of one stage at one
 * effort. Pure: the same `(effort, stage)` always returns the same frozen
 * value, and nothing else is read.
 */
export function envelope(effort: Effort, stage: StageName): Envelope {
	if (!isEffort(effort)) {
		throw new WorkflowComponentError(
			"envelope",
			`unknown effort ${JSON.stringify(effort)}; the effort dial is one of ${EFFORTS.join(", ")}.`,
		);
	}
	if (!isStageName(stage)) {
		throw new WorkflowComponentError(
			"envelope",
			`unknown envelope stage ${JSON.stringify(stage)}; the table covers ${ENVELOPE_STAGES.join(", ")}.`,
		);
	}
	return ENVELOPE_TABLE[effort][stage];
}

/** How long a gate at this effort waits for a person; a table, like the rest. */
export function gateTimeoutMs(effort: Effort): number {
	if (!isEffort(effort)) {
		throw new WorkflowComponentError(
			"envelope",
			`unknown effort ${JSON.stringify(effort)}; the effort dial is one of ${EFFORTS.join(", ")}.`,
		);
	}
	return GATE_TIMEOUT_MS[effort];
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
