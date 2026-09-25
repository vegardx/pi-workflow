import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type {
	TaskDisposition,
	TaskKey,
	WorkflowBudget,
} from "../contracts-core.js";
import { MAX_TASK_KEY_LENGTH, TaskKeySchema } from "../contracts-core.js";
import type {
	AgentTaskAuthoringRequest,
	TaskHandle,
	TaskInputHandle,
	WorkflowContext,
	WorkspaceAuthoringRequest,
	WorktreeTaskHandle,
} from "../definition.js";
import { isHandoffHandle, isTaskHandle } from "../definition.js";
import {
	assertBudgetAdmits,
	EFFORTS,
	type Effort,
	envelope,
} from "./envelope.js";
import { WorkflowComponentError } from "./errors.js";
import {
	FINDING_ID_PATTERN,
	MAX_FINDING_WHAT_LENGTH,
	MAX_FINDING_WHERE_LENGTH,
	MAX_FINDINGS,
	MAX_REVIEW_SYNTHESIS_LENGTH,
	type ReviewReport,
} from "./finding.js";
import type { ReviewOutcome } from "./review-fan-out.js";
import type { WorktreeWorkspaceRequest } from "./verify-and-fix.js";

/**
 * `synthesizeFindings` and `fixFindings` — the two halves of "review, then
 * fix": a structured-output reducer that normalizes every lens's findings into
 * ONE de-duplicated list, and a bounded fixer that the normalized list is
 * handed to.
 *
 * Pattern: `skills/workflow-authoring/SKILL.md` § "Normalize a fan-out's
 * findings, then fix them". The rules it encodes live under "Keys, namespaces,
 * and handles", "`after` versus `inputs`", "Barriers and replay" and "Failure
 * semantics for authors".
 *
 * Lowering, and nothing else:
 *
 * ```text
 * ctx.fanIn(`<key>`, reportingReviewers, …)   the synthesis, one task,
 *                                              disposition "optional"
 * await ctx.settled([synthesis])               one barrier
 * ctx.agent(`<key>`, …)                        the fixer: one worktree agent,
 *                                              handoff "required"
 * ```
 *
 * ## Why a second reducer, and why it is structured
 *
 * `reviewFanOut`'s own synthesis returns PROSE (`ReviewSynthesisSchema`): it
 * exists to explain a verdict a deterministic rail already computed. That is
 * the right shape for a review whose findings go to a person. It is the wrong
 * shape for a review whose findings go to an AGENT, because prose cannot be
 * addressed one finding at a time and cannot be reported back against.
 *
 * So the normalization is its own stage with its own pinned schema
 * ({@link FindingSynthesisSchema}): one list of
 * `{id, severity, lens, where, summary, suggestion?}` plus a one-paragraph
 * verdict. The fixer answers it field for field
 * ({@link FindingFixReportSchema}): one `{id, outcome, note}` per finding, plus
 * whether the project's check passed after the edits.
 *
 * ## The fixer is bounded by a SHARED round budget
 *
 * A deliverable's fix rounds are one pool. `verifyAndFix` spends some of them
 * making the check pass; whatever is left is what this fixer may spend, and the
 * caller passes it as `remainingRounds`. At zero the fixer is NOT declared and
 * the reason is returned rather than swallowed, so the caller can log it and a
 * gate can show it. This is how "total fix rounds per deliverable never exceed
 * `policy.maxFixRounds`" is enforced, and it is enforced HERE rather than in
 * prose an agent may ignore.
 *
 * ## No re-review
 *
 * Nothing re-runs the lenses after a fix. The fixer's report IS the evidence,
 * and a person reads it at the gate beside the findings it answers. A second
 * fan-out would double the most expensive stage of a deliverable to re-confirm
 * what the check already re-ran.
 *
 * ## Replay
 *
 * 1. Both keys are the caller's, unchanged: a pure function of the
 *    deliverable, never of a counter over runtime data.
 * 2. `findings` comes from a value a barrier already returned (the settled
 *    synthesis), which is what makes "declare a fixer only when something is
 *    worth fixing" legal before the next barrier.
 * 3. Model, thinking level and limits are `envelope(effort, "fix")` /
 *    `envelope(effort, "synthesis")` lookups, never anything observed.
 */

/** A normalized finding's severity; the fixer must address the first two. */
export const NORMALIZED_FINDING_SEVERITIES = Object.freeze([
	"blocking",
	"major",
	"minor",
] as const);
export type NormalizedFindingSeverity =
	(typeof NORMALIZED_FINDING_SEVERITIES)[number];

/** The severities a fixer may not skip. */
export const ACTIONABLE_FINDING_SEVERITIES = Object.freeze([
	"blocking",
	"major",
] as const);

/**
 * ONE finding, after normalization: which lens raised it, where, what it says
 * in one summary, and - when the lens had one - what to do about it.
 *
 * It is deliberately NOT `FindingSchema`. A `Finding` carries `kind` and
 * `what` and no lens, because it is the shape a single reviewer reports. This
 * is the shape a MERGE reports: `lens` is now meaningful (it says who raised
 * the surviving copy), `summary` replaces `what` because it is one sentence
 * over possibly several lenses' wording, and `suggestion` is the actionable
 * half the fixer reads first.
 */
export const NormalizedFindingSchema = Type.Object(
	{
		id: Type.String({ pattern: FINDING_ID_PATTERN }),
		severity: Type.Union([
			Type.Literal("blocking"),
			Type.Literal("major"),
			Type.Literal("minor"),
		]),
		/** The lens that raised the surviving copy of this finding. */
		lens: Type.String({ minLength: 1, maxLength: 128 }),
		where: Type.String({ minLength: 1, maxLength: MAX_FINDING_WHERE_LENGTH }),
		summary: Type.String({ minLength: 1, maxLength: MAX_FINDING_WHAT_LENGTH }),
		suggestion: Type.Optional(
			Type.String({ minLength: 1, maxLength: MAX_FINDING_WHAT_LENGTH }),
		),
	},
	{ additionalProperties: false },
);
export type NormalizedFinding = Static<typeof NormalizedFindingSchema>;

/**
 * What the synthesis returns: the de-duplicated findings of every lens that
 * reported, and one paragraph a person reads first.
 */
export const FindingSynthesisSchema = Type.Object(
	{
		findings: Type.Array(NormalizedFindingSchema, { maxItems: MAX_FINDINGS }),
		/** One paragraph: what the lenses agree on, and where they disagree. */
		verdict: Type.String({
			minLength: 1,
			maxLength: MAX_REVIEW_SYNTHESIS_LENGTH,
		}),
	},
	{ additionalProperties: false },
);
export type FindingSynthesis = Static<typeof FindingSynthesisSchema>;

export const FIX_OUTCOMES = Object.freeze([
	"addressed",
	"disputed",
	"out-of-scope",
] as const);
export type FixOutcome = (typeof FIX_OUTCOMES)[number];

/** The longest note a fixer may write about one finding. */
export const MAX_FIX_NOTE_LENGTH = 2048;

/**
 * One finding, answered. `disputed` REQUIRES a note - the schema itself says
 * so, as a two-branch union, so a disputed finding with no reason is refused
 * by structured output rather than noticed by a reader at the gate.
 */
export const FixFindingOutcomeSchema = Type.Union([
	Type.Object(
		{
			id: Type.String({ pattern: FINDING_ID_PATTERN }),
			outcome: Type.Union([
				Type.Literal("addressed"),
				Type.Literal("out-of-scope"),
			]),
			note: Type.Optional(
				Type.String({ minLength: 1, maxLength: MAX_FIX_NOTE_LENGTH }),
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			id: Type.String({ pattern: FINDING_ID_PATTERN }),
			outcome: Type.Literal("disputed"),
			/** Required: a dispute a person cannot read is not a dispute. */
			note: Type.String({ minLength: 1, maxLength: MAX_FIX_NOTE_LENGTH }),
		},
		{ additionalProperties: false },
	),
]);
export type FixFindingOutcome = Static<typeof FixFindingOutcomeSchema>;

/** What the fixer returns: every finding answered, and the check's verdict. */
export const FindingFixReportSchema = Type.Object(
	{
		findings: Type.Array(FixFindingOutcomeSchema, { maxItems: MAX_FINDINGS }),
		/** True only when the project's check ran to completion and exited zero. */
		checkPassed: Type.Boolean(),
	},
	{ additionalProperties: false },
);
export type FindingFixReport = Static<typeof FindingFixReportSchema>;

/** The synthesis declaration a caller owns; the component owns the rest. */
export type FindingSynthesisTaskRequest = Omit<
	AgentTaskAuthoringRequest<
		typeof FindingSynthesisSchema,
		WorkspaceAuthoringRequest
	>,
	"outputSchema" | "inputs" | "model" | "limits"
>;

/** What the caller needs to write the synthesis prose; all of it is data. */
export interface FindingSynthesisBrief {
	/** The lens keys that reported, in declaration order. */
	readonly reported: readonly string[];
	/** The lens keys that did not, in declaration order. */
	readonly missing: readonly string[];
}

export interface SynthesizeFindingsOptions {
	/** `reviewFanOut`'s outcomes, in declaration order. */
	readonly reviews: readonly ReviewOutcome[];
	readonly effort: Effort;
	readonly synthesize: (
		brief: FindingSynthesisBrief,
	) => FindingSynthesisTaskRequest;
	/** Default `"optional"`, and for the reason `reviewFanOut` documents. */
	readonly disposition?: TaskDisposition;
	readonly budget?: WorkflowBudget;
}

function refuse(component: string, message: string): never {
	throw new WorkflowComponentError(component, message);
}

function assertKey(component: string, key: TaskKey): void {
	if (!Value.Check(TaskKeySchema, key)) {
		refuse(
			component,
			`${component} key ${JSON.stringify(key)} is not a task key; it is a caller-supplied stable id matching ^[a-z][a-z0-9-]*$, 1..${MAX_TASK_KEY_LENGTH} characters.`,
		);
	}
}

function assertEffort(component: string, key: TaskKey, effort: Effort): void {
	if (!(EFFORTS as readonly unknown[]).includes(effort)) {
		refuse(
			component,
			`${component}("${key}") got the unknown effort ${JSON.stringify(effort)}; the effort dial is one of ${EFFORTS.join(", ")}.`,
		);
	}
}

function assertOwned(
	what: string,
	component: string,
	request: object,
	owned: readonly string[],
	because: string,
): void {
	for (const field of owned) {
		if (Object.hasOwn(request, field)) {
			refuse(
				component,
				`${what} declares \`${field}\`, which ${component} owns: ${because}.`,
			);
		}
	}
}

/**
 * Declares the normalization reducer over the lenses that REPORTED.
 *
 * Returns `undefined` when no lens reported: there is nothing to normalize,
 * and a reducer over an empty fan-in is a task nobody can complete. The caller
 * reports the coverage it already has instead.
 *
 * The reducer is `disposition: "optional"` by default for the same reason
 * `reviewFanOut`'s is: a materialization barrier's control edge covers every
 * task it closed over, so a half-dead fan-out blocks the reducer declared
 * after it, and a required reducer would turn a degraded review into a failed
 * run.
 */
export function synthesizeFindings(
	ctx: WorkflowContext<unknown>,
	key: TaskKey,
	options: SynthesizeFindingsOptions,
): TaskHandle<FindingSynthesis> | undefined {
	assertKey("synthesizeFindings", key);
	if (options === null || typeof options !== "object") {
		refuse(
			"synthesizeFindings",
			`synthesizeFindings("${key}") requires a declaration.`,
		);
	}
	if (typeof options.synthesize !== "function") {
		refuse(
			"synthesizeFindings",
			`synthesizeFindings("${key}") requires a \`synthesize\` function.`,
		);
	}
	assertEffort("synthesizeFindings", key, options.effort);
	const synthesisEnvelope = envelope(options.effort, "synthesis");
	if (options.budget) {
		assertBudgetAdmits(
			options.budget,
			[synthesisEnvelope.budgetShare],
			`synthesizeFindings("${key}") at "${options.effort}" effort`,
		);
	}

	const reporting = options.reviews.filter(
		(outcome) => outcome.reported && outcome.handle !== undefined,
	);
	if (reporting.length === 0) return undefined;

	const request = options.synthesize({
		reported: Object.freeze(reporting.map((outcome) => outcome.lens.key)),
		missing: Object.freeze(
			options.reviews
				.filter((outcome) => !outcome.reported)
				.map((outcome) => outcome.lens.key),
		),
	});
	if (request === null || typeof request !== "object") {
		refuse(
			"synthesizeFindings",
			`synthesizeFindings("${key}") synthesis is not a declaration.`,
		);
	}
	assertOwned(
		`synthesizeFindings("${key}") synthesis`,
		"synthesizeFindings",
		request,
		["outputSchema", "inputs", "model", "limits"],
		`the reporting lenses are its inputs, it reports ${"`FindingSynthesisSchema`"}, and it runs at envelope(${JSON.stringify(options.effort)}, "synthesis")`,
	);

	return ctx.fanIn(
		key,
		reporting.map(
			(outcome) => outcome.handle as TaskHandle<ReviewReport>,
		) as readonly TaskHandle<ReviewReport>[],
		{
			inputKey: (_source, index) =>
				reporting[index]?.lens.key as unknown as TaskKey,
			task: {
				...request,
				...(options.disposition === undefined
					? { disposition: "optional" as const }
					: { disposition: options.disposition }),
				outputSchema: FindingSynthesisSchema,
				model: synthesisEnvelope.model,
				limits: synthesisEnvelope.limits,
			},
		},
	) as TaskHandle<FindingSynthesis>;
}

/** The input name the normalized findings arrive under, for a fixer. */
export const DEFAULT_FINDINGS_INPUT = "findings" as TaskKey;
/** The input name the current patch's handoff descriptor arrives under. */
export const DEFAULT_FIX_PATCH_INPUT = "patch" as TaskKey;

/** The reason `fixFindings` declared no fixer; a caller records it verbatim. */
export const NO_ACTIONABLE_FINDINGS_REASON =
	"the synthesis reported no blocking or major finding";
/** The reason `fixFindings` declared no fixer when the pool is spent. */
export const NO_FIX_ROUNDS_REASON = "no fix round remains in the shared budget";

/**
 * The fixer declaration a caller owns: prose, tools, workspace, retries. The
 * component owns the output schema, the model, the limits and the handoff
 * policy, so none of them may be declared here.
 */
export type FindingFixTaskRequest = Omit<
	AgentTaskAuthoringRequest<
		typeof FindingFixReportSchema,
		WorktreeWorkspaceRequest
	>,
	"outputSchema" | "model" | "limits" | "handoff"
>;

export interface FixFindingsOptions {
	/** The worktree task whose handoff the fixer is handed. */
	readonly implementation: WorktreeTaskHandle<unknown>;
	/** The normalized findings, from a barrier the caller already crossed. */
	readonly findings: readonly NormalizedFinding[];
	/** The synthesis result handle; the fixer reads the list, not a copy of it. */
	readonly synthesis: TaskInputHandle;
	readonly effort: Effort;
	/**
	 * Fix rounds left in the deliverable's shared pool. At zero no fixer is
	 * declared, whatever the findings say.
	 */
	readonly remainingRounds: number;
	/** The fixer declaration, given the findings it must address. */
	readonly agent: (
		actionable: readonly NormalizedFinding[],
	) => FindingFixTaskRequest;
	readonly disposition?: TaskDisposition;
	readonly budget?: WorkflowBudget;
	readonly patchInput?: TaskKey;
	readonly findingsInput?: TaskKey;
}

export interface FixFindingsResult {
	/** The blocking and major findings; what the fixer was told to address. */
	readonly actionable: readonly NormalizedFinding[];
	/** The fixer, when one was declared. */
	readonly fix?: WorktreeTaskHandle<FindingFixReport>;
	/** Why no fixer was declared; present iff `fix` is absent. */
	readonly skipped?: string;
	/** The fixer when one ran, else the implementation handed in. */
	readonly handoff: WorktreeTaskHandle<unknown>;
	/** Fix rounds left after this stage. */
	readonly remainingRounds: number;
}

/**
 * Declares at most ONE fixer over the normalized findings.
 *
 * Refuses at declaration when:
 * - `key` is not a task key;
 * - `effort` is not on the ladder;
 * - `implementation` is not a worktree handle, so there is no patch to fix;
 * - `remainingRounds` is not a non-negative integer;
 * - the returned declaration is not a worktree task, declares a field the
 *   component owns, or names an input the component wires;
 * - one fixer at this effort does not fit the run's `meta.budget`.
 *
 * Declares nothing, and says why, when no finding is blocking or major, or
 * when the shared fix-round pool is spent.
 */
export function fixFindings(
	ctx: Pick<WorkflowContext<unknown>, "agent">,
	key: TaskKey,
	options: FixFindingsOptions,
): FixFindingsResult {
	assertKey("fixFindings", key);
	if (options === null || typeof options !== "object") {
		refuse("fixFindings", `fixFindings("${key}") requires a declaration.`);
	}
	assertEffort("fixFindings", key, options.effort);
	const implementation = options.implementation;
	if (
		!isTaskHandle(implementation) ||
		!isHandoffHandle(implementation.handoff)
	) {
		refuse(
			"fixFindings",
			`fixFindings("${key}") needs a worktree implementation handle; a read-only task produces no patch to fix.`,
		);
	}
	const remainingRounds = options.remainingRounds;
	if (!Number.isInteger(remainingRounds) || remainingRounds < 0) {
		refuse(
			"fixFindings",
			`fixFindings("${key}") got ${JSON.stringify(options.remainingRounds)} remaining fix round(s); it is a non-negative integer taken from the deliverable's shared pool.`,
		);
	}
	const patchInput = options.patchInput ?? DEFAULT_FIX_PATCH_INPUT;
	const findingsInput = options.findingsInput ?? DEFAULT_FINDINGS_INPUT;
	for (const [name, value] of [
		["patchInput", patchInput],
		["findingsInput", findingsInput],
	] as const) {
		if (!Value.Check(TaskKeySchema, value)) {
			refuse(
				"fixFindings",
				`fixFindings("${key}") ${name} ${JSON.stringify(value)} is not a task key.`,
			);
		}
	}
	if (patchInput === findingsInput) {
		refuse(
			"fixFindings",
			`fixFindings("${key}") wires the patch and the findings under the same input name ${JSON.stringify(patchInput)}; they are two different artifacts.`,
		);
	}

	const actionable = Object.freeze(
		options.findings.filter((finding) =>
			(ACTIONABLE_FINDING_SEVERITIES as readonly string[]).includes(
				finding.severity,
			),
		),
	);
	const skip = (reason: string): FixFindingsResult =>
		Object.freeze({
			actionable,
			skipped: reason,
			handoff: implementation,
			remainingRounds,
		});
	if (actionable.length === 0) return skip(NO_ACTIONABLE_FINDINGS_REASON);
	if (remainingRounds === 0) return skip(NO_FIX_ROUNDS_REASON);

	const fixEnvelope = envelope(options.effort, "fix");
	if (options.budget) {
		assertBudgetAdmits(
			options.budget,
			[fixEnvelope.budgetShare],
			`fixFindings("${key}") at "${options.effort}" effort`,
		);
	}
	if (typeof options.agent !== "function") {
		refuse(
			"fixFindings",
			`fixFindings("${key}") requires an \`agent\` function.`,
		);
	}
	const declared = options.agent(actionable);
	if (declared === null || typeof declared !== "object") {
		refuse("fixFindings", `fixFindings("${key}") fixer is not a declaration.`);
	}
	assertOwned(
		`fixFindings("${key}") fixer`,
		"fixFindings",
		declared,
		["outputSchema", "model", "limits", "handoff"],
		`a fixer reports ${"`FindingFixReportSchema`"} at envelope(${JSON.stringify(options.effort)}, "fix") and its handoff is always required - a worktree with no changes is a failed fix`,
	);
	if (declared.workspace?.mode !== "worktree") {
		refuse(
			"fixFindings",
			`fixFindings("${key}") fixer must run in a worktree; declare { mode: "worktree", cwd }.`,
		);
	}
	for (const name of [patchInput, findingsInput]) {
		if (declared.inputs && Object.hasOwn(declared.inputs, name)) {
			refuse(
				"fixFindings",
				`fixFindings("${key}") fixer declares the input ${JSON.stringify(name)}, which the component already wires; rename it or pass a different \`patchInput\`/\`findingsInput\`.`,
			);
		}
	}

	const fix = ctx.agent(key, {
		...declared,
		...(options.disposition !== undefined && declared.disposition === undefined
			? { disposition: options.disposition }
			: {}),
		outputSchema: FindingFixReportSchema,
		model: fixEnvelope.model,
		limits: fixEnvelope.limits,
		handoff: "required",
		inputs: {
			...(declared.inputs ?? {}),
			[patchInput]: implementation.handoff,
			[findingsInput]: options.synthesis,
		},
	}) as WorktreeTaskHandle<FindingFixReport>;

	return Object.freeze({
		actionable,
		fix,
		handoff: fix,
		remainingRounds: remainingRounds - 1,
	});
}
