/**
 * `@vegardx/pi-workflow/components` — the component library.
 *
 * Pure TypeScript functions over `WorkflowContext` that declare only existing
 * primitives. After materialization a component is indistinguishable from
 * hand-written authoring: **no contract revision, no frozen-shape change,
 * nothing in the runtime**. That is what keeps the freeze intact while the
 * library evolves.
 *
 * Each component's doc comment names the pattern it encodes by its exact
 * heading in `skills/workflow-authoring/SKILL.md` § "Patterns", and
 * `test/skill-examples.test.ts` fails a pointer that names no such heading.
 * **The patterns are the primary artifact; a component is their executable
 * form.** Read the pattern first: a definition that declares the same primitives by hand is equally
 * correct, and a component that cannot express a graph is not a reason to
 * bend the graph.
 *
 * Every component obeys the three replay laws, so the exact-prefix contract
 * ("Barriers and replay") holds for the graphs they declare:
 *
 * 1. Keys are a pure function of (namespace, declaration ordinal, a
 *    caller-supplied stable id) - never a clock, a hash of prose, an index
 *    into data that post-dates a barrier, or a random value.
 * 2. Data a component fans out over originates in `ctx.input` or in a value a
 *    barrier already returned.
 * 3. Effort, model and budget choices are table lookups keyed by `ctx.input`
 *    (and, in a bounded loop, the round ordinal).
 *
 * This entry point imports no UI, no service, and no filesystem: it is the
 * authoring half of the package and is safe to load from a definition module.
 */

export {
	COMPILED_ID_PATTERN,
	COMPILED_STAGE_KINDS,
	type CompiledDeliverable,
	CompiledDeliverableSchema,
	CompiledEffortSchema,
	type CompiledEscalation,
	CompiledEscalationSchema,
	CompiledGateStageSchema,
	CompiledGatesSchema,
	CompiledImplementStageSchema,
	CompiledLensSchema,
	CompiledReviewFanOutStageSchema,
	type CompiledReviewTier,
	CompiledReviewTierSchema,
	type CompiledStage,
	type CompiledStageDocument,
	CompiledStageDocumentSchema,
	type CompiledStageKind,
	CompiledStageSchema,
	type CompiledSynthesis,
	CompiledSynthesisSchema,
	CompiledVerifyAndFixStageSchema,
	MAX_COMPILED_DELIVERABLES,
	MAX_COMPILED_LENSES,
	MAX_COMPILED_STAGES,
} from "./compiled-stages.js";
export {
	assertBudgetAdmits,
	type BudgetShare,
	budgetAdmits,
	DIVERSE_MODEL_ID,
	EFFORTS,
	type Effort,
	ENVELOPE_STAGES,
	type Envelope,
	type EnvelopeTier,
	envelope,
	gateTimeoutMs,
	MODEL_ID,
	MODEL_PROVIDER,
	type StageName,
	sumBudgetShares,
	THINKING_BY_TIER,
	type ThinkingLevel,
	WORKSPACE_WRITE_BYTES,
	workflowBudgetFor,
} from "./envelope.js";
export { WorkflowComponentError } from "./errors.js";
export {
	dedupeFindings,
	FINDING_ID_PATTERN,
	FINDING_KINDS,
	FINDING_SEVERITIES,
	type Finding,
	type FindingKind,
	type FindingMergeOptions,
	type FindingPatch,
	FindingPatchSchema,
	FindingSchema,
	type FindingSeverity,
	findingSeverityRank,
	isFindingId,
	MAX_FINDING_WHAT_LENGTH,
	MAX_FINDING_WHERE_LENGTH,
	MAX_FINDINGS,
	MAX_REVIEW_SYNTHESIS_LENGTH,
	type MergedReview,
	mergeReviewReports,
	type ReportedFinding,
	type ReportedReview,
	type ReviewCoverageEntry,
	ReviewCoverageEntrySchema,
	type ReviewReport,
	ReviewReportSchema,
	type ReviewSynthesis,
	ReviewSynthesisSchema,
	type ReviewVerdict,
	ReviewVerdictSchema,
} from "./finding.js";
export {
	type ForEachOptions,
	forEach,
	MAX_FOR_EACH_ITEMS,
	projectFanOutBudget,
} from "./for-each.js";
export { type GateContext, type GateRequest, gate } from "./gate.js";
export {
	MAX_REVIEW_LENSES,
	type ResolvedReviewLens,
	type ReviewDiversitySeam,
	type ReviewFanOutOptions,
	type ReviewFanOutResult,
	type ReviewLens,
	type ReviewOutcome,
	type ReviewSubject,
	type ReviewSynthesisBrief,
	type ReviewSynthesisTaskRequest,
	type ReviewTaskRequest,
	type ReviewTier,
	resolveReviewKeys,
	reviewFanOut,
} from "./review-fan-out.js";
export {
	type CheckReport,
	CheckReportSchema,
	DEFAULT_PATCH_INPUT,
	DEFAULT_REPORT_INPUT,
	DEFAULT_VERIFY_ROUNDS,
	type FixTaskRequest,
	MAX_CHECK_TAIL_LENGTH,
	MAX_VERIFY_ROUNDS,
	nextRung,
	projectVerifyAndFixBudget,
	type VerifyAndFixCheck,
	type VerifyAndFixContext,
	type VerifyAndFixOptions,
	type VerifyAndFixResult,
	type VerifyRound,
	type VerifyRoundReport,
	type VerifyTaskRequest,
	verifyAndFix,
	type WorktreeWorkspaceRequest,
} from "./verify-and-fix.js";
