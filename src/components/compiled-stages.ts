import { type Static, Type } from "typebox";
import {
	MODEL_ROLE_TIERS,
	type ModelRoleTier,
} from "../runtime/model-routing.js";

/**
 * The compiled stage document: what `plan-to-ship` compiles a plan into, and
 * what a person is shown before the run starts (plan-loop spec 2.1 and 2.2).
 *
 * It lives here, in the component library, rather than in the definition that
 * produces it, because it is a SHARED shape: `plan-to-ship` produces it, a host
 * derives the same document from the stored plan to show it and to check the
 * run against it, and whatever checks the plan reads it. A shape owned by the
 * producer would make every reader's contract a copy, and a copy is what
 * drifts.
 *
 * This is the **graph, not prose**. It says which stages each deliverable
 * compiled into, in order, with the identifiers the workflow namespaces are
 * derived from - so "every deliverable was compiled", "the lenses were seeded
 * from `deliverables[].reviews`" and "the gates the policy asked for are
 * present" are questions a reader answers by comparing two documents, not by
 * trusting a summary.
 *
 * Vocabulary note (decision D4). `use` names a **plan stage kind**, not a
 * component: the plan's vocabulary and the library that lowers it are allowed
 * to diverge. Two of pi-maestro's five kinds cannot appear in a COMPILED
 * document and are therefore absent from this union rather than admitted and
 * ignored:
 *
 * - `dynamic` is reserved in the plan schema and refused by the compiler with
 *   "dynamic stages are not compiled yet", so it never reaches a compiled
 *   document.
 * - `sub-workflow` is out of this slice entirely (owner decision, 2026-09-16):
 *   there is no `subWorkflow` component and no `sub-workflow` stage kind.
 *
 * Closed on purpose (`additionalProperties: false` throughout): this document
 * is produced by this package's own compiler, so a field nobody honours is a
 * bug to refuse at `workflow_validate`, not a field to carry.
 */

/** A stage id, a deliverable id, a lens id: all become workflow namespaces. */
export const COMPILED_ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";

/** What a compiled document may contain. See the vocabulary note above. */
export const COMPILED_STAGE_KINDS = Object.freeze([
	"implement",
	"check",
	"review-fan-out",
	"normalize",
	"resume",
	"gate",
] as const);
export type CompiledStageKind = (typeof COMPILED_STAGE_KINDS)[number];

/** `plan-to-ship`'s own deliverable bound, repeated as the document's. */
export const MAX_COMPILED_DELIVERABLES = 16;
/** implement, check, review, normalize, resume, recheck - and room to spare. */
export const MAX_COMPILED_STAGES = 8;
/** `reviewFanOut`'s bound, so a compiled fan-out cannot describe an illegal one. */
export const MAX_COMPILED_LENSES = 16;

const CompiledStageIdSchema = Type.String({ pattern: COMPILED_ID_PATTERN });

/**
 * The small closed vocabulary that sits at the BOTTOM of this
 * document's deepest path - `deliverables -> stages -> <union> -> lenses ->
 * lens -> tier` - written as a pattern-constrained string rather than as a union
 * of literals.
 *
 * The reason is a hard runtime bound, not taste. A workflow schema document
 * must be JSON nested at most 17 levels deep
 * (`JsonSchemaDocumentSchema`/`validateJsonSchemaDocument`), and TypeBox lowers
 * a three-literal union to `{anyOf: [{const, type}, …]}`, which costs three
 * levels where `{type: "string", pattern: "^(a|b|c)$"}` costs one. Two levels
 * here are two levels a caller gets to spend embedding this document in its own
 * schema - a reader that embeds it needs them. `Type.Unsafe` keeps the
 * narrow TypeScript type; the pattern is exactly as strict as the union.
 *
 * Every vocabulary NOT on that path (`use`, `gates`) stays a readable union.
 */
export type CompiledReviewTier = ModelRoleTier;
export const CompiledReviewTierSchema = Type.Unsafe<CompiledReviewTier>({
	type: "string",
	pattern: `^(${MODEL_ROLE_TIERS.join("|")})$`,
});

/** The deliverable's own work: one worktree, one handoff. Exactly one. */
export const CompiledImplementStageSchema = Type.Object(
	{
		use: Type.Literal("implement"),
		id: CompiledStageIdSchema,
		/** Tool NAMES, which is the only thing a stage may say about tools. */
		tools: Type.Optional(
			Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }), {
				maxItems: 32,
			}),
		),
	},
	{ additionalProperties: false },
);

/**
 * The repository's own check over the deliverable's hand-off, verify only.
 * `id` is `check` for the check of the implementer's hand-off and `recheck`
 * for the check of what a resumed implementer handed back, which runs only
 * when the resume changed something.
 */
export const CompiledCheckStageSchema = Type.Object(
	{
		use: Type.Literal("check"),
		id: CompiledStageIdSchema,
	},
	{ additionalProperties: false },
);

/** One point of view in a fan-out; `id` is the fan-out key. */
export const CompiledLensSchema = Type.Object(
	{
		id: Type.String({ pattern: "^[a-z][a-z0-9-]*$", maxLength: 128 }),
		tier: Type.Optional(CompiledReviewTierSchema),
		diverse: Type.Optional(Type.Boolean()),
		skill: Type.Optional(Type.String({ pattern: COMPILED_ID_PATTERN })),
		/** `provider/model`, as pi-maestro writes it; an exact pin. */
		model: Type.Optional(Type.String({ pattern: "^\\S+/\\S+$" })),
	},
	{ additionalProperties: false },
);

/** Independent points of view over the same subject, in parallel. */
export const CompiledReviewFanOutStageSchema = Type.Object(
	{
		use: Type.Literal("review-fan-out"),
		id: CompiledStageIdSchema,
		lenses: Type.Array(CompiledLensSchema, {
			maxItems: MAX_COMPILED_LENSES,
		}),
	},
	{ additionalProperties: false },
);

/** A human decides. Last in its deliverable, because nothing follows a gate. */
export const CompiledGateStageSchema = Type.Object(
	{
		use: Type.Literal("gate"),
		id: CompiledStageIdSchema,
		question: Type.String({ minLength: 1, maxLength: 1024 }),
		/** Earlier sibling stage ids whose results the decision is shown. */
		show: Type.Optional(Type.Array(CompiledStageIdSchema, { maxItems: 8 })),
	},
	{ additionalProperties: false },
);

/**
 * The harness's merge of the lenses' findings: deterministic clustering, then
 * — only when more than one lens reported — a merge-only model call over the
 * remaining clusters. It judges nothing; the record it produces is the
 * `reviews-<deliverable>` artifact.
 */
export const CompiledNormalizeStageSchema = Type.Object(
	{
		use: Type.Literal("normalize"),
		id: CompiledStageIdSchema,
	},
	{ additionalProperties: false },
);

/**
 * The implementer, resumed in its own session at its own hand-off with the
 * check report and the de-biased view of the findings, answering each item
 * `fixed | declined | out-of-scope`. Present only under `policy.resumes: 1`.
 */
export const CompiledResumeStageSchema = Type.Object(
	{
		use: Type.Literal("resume"),
		id: CompiledStageIdSchema,
	},
	{ additionalProperties: false },
);

export const CompiledStageSchema = Type.Union([
	CompiledImplementStageSchema,
	CompiledCheckStageSchema,
	CompiledReviewFanOutStageSchema,
	CompiledNormalizeStageSchema,
	CompiledResumeStageSchema,
	CompiledGateStageSchema,
]);
export type CompiledStage = Static<typeof CompiledStageSchema>;

/** One plan deliverable, as the compiler lowered it. */
export const CompiledDeliverableSchema = Type.Object(
	{
		/** The PLAN's deliverable id, so the two documents line up by key. */
		id: CompiledStageIdSchema,
		stages: Type.Array(CompiledStageSchema, {
			maxItems: MAX_COMPILED_STAGES,
		}),
	},
	{ additionalProperties: false },
);
export type CompiledDeliverable = Static<typeof CompiledDeliverableSchema>;

/**
 * How the run is gated, and where it ends.
 *
 * - `ship` (the default) — one decision after all the work, before anything is
 *   published. A person answers it.
 * - `every-deliverable` — one decision after each deliverable, and the last of
 *   them IS the ship decision.
 * - `none` — no ship gate at all. The run completes when every deliverable is
 *   done and the HOST publishes on completion, on the authority of the yes that
 *   started the run. It is what a person who left plan mode in `auto` mode
 *   asked for: one decision, taken up front.
 */
export const CompiledGatesSchema = Type.Union([
	Type.Literal("ship"),
	Type.Literal("every-deliverable"),
	Type.Literal("none"),
]);

/**
 * The whole compiled graph: every deliverable in plan order with its stages,
 * plus the one resolved policy dial that decides where a person is asked.
 * There is no `effort`: the dial is gone, models are set per role, and what a
 * stage costs is one fixed row per stage (`envelope`).
 */
export const CompiledStageDocumentSchema = Type.Object(
	{
		deliverables: Type.Array(CompiledDeliverableSchema, {
			minItems: 1,
			maxItems: MAX_COMPILED_DELIVERABLES,
		}),
		/** The resolved gates - `policy.gates` with its default applied. */
		gates: CompiledGatesSchema,
	},
	{ additionalProperties: false },
);
export type CompiledStageDocument = Static<typeof CompiledStageDocumentSchema>;
