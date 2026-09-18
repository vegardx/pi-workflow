import { type Static, Type } from "typebox";

/**
 * The compiled stage document: what `plan-to-ship` compiles a plan into, and
 * what the blind reviewer (`plan-review`) is shown next to the plan itself
 * (plan-loop spec 2.1 and 2.2).
 *
 * It lives here, in the component library, because two builtins need the same
 * shape and neither may import the other: `plan-to-ship` PRODUCES it and
 * `plan-review` READS it. A shape owned by the producer would make the
 * reviewer's contract a copy, and a copy is what drifts.
 *
 * This is the **graph, not prose**. It says which stages each deliverable
 * compiled into, in order, with the identifiers the workflow namespaces are
 * derived from - so "every deliverable was compiled", "the lenses were seeded
 * from `tasks[].review`" and "the gates the policy asked for are present" are
 * questions a reader answers by comparing two documents, not by trusting a
 * summary.
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
	"verify-and-fix",
	"review-fan-out",
	"gate",
] as const);
export type CompiledStageKind = (typeof COMPILED_STAGE_KINDS)[number];

/** `plan-to-ship`'s own deliverable bound, repeated as the document's. */
export const MAX_COMPILED_DELIVERABLES = 16;
/** A deliverable's stage list: one implement, one verify, one review, a gate. */
export const MAX_COMPILED_STAGES = 8;
/** `reviewFanOut`'s bound, so a compiled fan-out cannot describe an illegal one. */
export const MAX_COMPILED_LENSES = 16;

const CompiledStageIdSchema = Type.String({ pattern: COMPILED_ID_PATTERN });

/**
 * The three small closed vocabularies that sit at the BOTTOM of this
 * document's deepest path - `deliverables -> stages -> <union> -> lenses ->
 * lens -> tier` - written as pattern-constrained strings rather than as unions
 * of literals.
 *
 * The reason is a hard runtime bound, not taste. A workflow schema document
 * must be JSON nested at most 17 levels deep
 * (`JsonSchemaDocumentSchema`/`validateJsonSchemaDocument`), and TypeBox lowers
 * a three-literal union to `{anyOf: [{const, type}, …]}`, which costs three
 * levels where `{type: "string", pattern: "^(a|b|c)$"}` costs one. Two levels
 * here are two levels a caller gets to spend embedding this document in its own
 * schema - `plan-review` needs one of them today. `Type.Unsafe` keeps the
 * narrow TypeScript type; the pattern is exactly as strict as the union.
 *
 * Every vocabulary NOT on that path (`use`, `effort`, `gates`) stays a
 * readable union.
 */
export type CompiledReviewTier = "light" | "standard" | "heavy";
export const CompiledReviewTierSchema = Type.Unsafe<CompiledReviewTier>({
	type: "string",
	pattern: "^(light|standard|heavy)$",
});

export type CompiledSynthesis = "required" | "optional" | "none";
export const CompiledSynthesisSchema = Type.Unsafe<CompiledSynthesis>({
	type: "string",
	pattern: "^(required|optional|none)$",
});

export type CompiledEscalation = "thinking" | "none";
export const CompiledEscalationSchema = Type.Unsafe<CompiledEscalation>({
	type: "string",
	pattern: "^(thinking|none)$",
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
 * The bounded verify-then-fix loop.
 *
 * `maxRounds` counts **VERIFY rounds**, which is `verifyAndFix`'s own unit and
 * not the plan's: a plan's `maxRounds` / `policy.maxFixRounds` counts FIX
 * rounds (0-2), and the compiler maps it to `maxRounds = maxFixRounds + 1`
 * (0-3) so a fix is never left unchecked. The compiled document records what
 * the component was actually asked for.
 */
export const CompiledVerifyAndFixStageSchema = Type.Object(
	{
		use: Type.Literal("verify-and-fix"),
		id: CompiledStageIdSchema,
		maxRounds: Type.Integer({ minimum: 0, maximum: 3 }),
		escalate: Type.Optional(CompiledEscalationSchema),
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
		synthesis: Type.Optional(CompiledSynthesisSchema),
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

export const CompiledStageSchema = Type.Union([
	CompiledImplementStageSchema,
	CompiledVerifyAndFixStageSchema,
	CompiledReviewFanOutStageSchema,
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

export const CompiledEffortSchema = Type.Union([
	Type.Literal("cheap"),
	Type.Literal("standard"),
	Type.Literal("deep"),
]);

/** How the run is gated. `approve-plan` is never optional. */
export const CompiledGatesSchema = Type.Union([
	Type.Literal("approve-plan"),
	Type.Literal("approve-plan+ship"),
	Type.Literal("every-deliverable"),
]);

/**
 * The whole compiled graph: every deliverable in plan order with its stages,
 * plus the two resolved policy dials that decide what those stages cost and
 * where a person is asked.
 */
export const CompiledStageDocumentSchema = Type.Object(
	{
		deliverables: Type.Array(CompiledDeliverableSchema, {
			minItems: 1,
			maxItems: MAX_COMPILED_DELIVERABLES,
		}),
		/** The resolved effort - `policy.effort` with its default applied. */
		effort: CompiledEffortSchema,
		/** The resolved gates - `policy.gates` with its default applied. */
		gates: CompiledGatesSchema,
	},
	{ additionalProperties: false },
);
export type CompiledStageDocument = Static<typeof CompiledStageDocumentSchema>;
