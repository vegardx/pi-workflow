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
 * 3. Limit and budget choices are table lookups keyed by the stage, and a model
 *    is either an exact one the definition pinned or `"inherit"`, which the
 *    runtime resolved once at run start. Never a clock or a measurement.
 *
 * This entry point imports no UI, no service, and no filesystem: it is the
 * authoring half of the package and is safe to load from a definition module.
 */

export {
	continuationMessageFits,
	MAX_CONTINUATION_MESSAGE_BYTES,
	renderContinuationMessage,
} from "../continuation.js";
export {
	COMPILED_ID_PATTERN,
	COMPILED_STAGE_KINDS,
	CompiledCheckStageSchema,
	type CompiledDeliverable,
	CompiledDeliverableSchema,
	CompiledGateStageSchema,
	CompiledGatesSchema,
	CompiledImplementStageSchema,
	CompiledLensSchema,
	CompiledNormalizeStageSchema,
	CompiledResumeStageSchema,
	CompiledReviewFanOutStageSchema,
	type CompiledReviewTier,
	CompiledReviewTierSchema,
	type CompiledStage,
	type CompiledStageDocument,
	CompiledStageDocumentSchema,
	type CompiledStageKind,
	CompiledStageSchema,
	MAX_COMPILED_DELIVERABLES,
	MAX_COMPILED_LENSES,
	MAX_COMPILED_STAGES,
} from "./compiled-stages.js";
export {
	assertBudgetAdmits,
	type BudgetShare,
	budgetAdmits,
	DIVERSE_MODEL_ID,
	ENVELOPE_STAGES,
	ENVELOPE_TIERS,
	type Envelope,
	type EnvelopeTier,
	envelope,
	GATE_TIMEOUT_MS,
	MODEL_ID,
	MODEL_PROVIDER,
	type StageName,
	sumBudgetShares,
	THINKING_BY_TIER,
	type ThinkingLevel,
	tierModel,
	WORKSPACE_WRITE_BYTES,
	WORKTREE_MEMORY_BYTES,
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
	AUTHORED_REVIEW_TIERS,
	type AuthoredReviewTier,
	MAX_REVIEW_LENSES,
	REVIEW_TIER_REFUSALS,
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
	reviewTierRefusal,
} from "./review-fan-out.js";
export {
	type LensTaskRequest,
	type ReviewLensesOptions,
	type ReviewLensesResult,
	reviewLenses,
} from "./review-lenses.js";
export {
	applyModelMerges,
	CLUSTER_LINE_WINDOW,
	checkDispositions,
	checkResumeReport,
	clusterFindings,
	DISPOSITION_KINDS,
	type Disposition,
	type DispositionKind,
	DispositionSchema,
	type ImplementerView,
	ImplementerViewSchema,
	implementerView,
	LENS_SEVERITIES,
	type LensFinding,
	LensFindingSchema,
	type LensLocation,
	LensLocationSchema,
	type LensReport,
	LensReportSchema,
	type LensSeverity,
	MAX_CLAIM_LENGTH,
	MAX_EVIDENCE_LENGTH,
	MAX_LENS_FINDINGS,
	MAX_LOCATION_FILE_LENGTH,
	MAX_REASONING_LENGTH,
	MAX_REVIEW_CLUSTERS,
	MAX_SUGGESTION_LENGTH,
	type MergeOutcome,
	NORMALIZER_MODES,
	type NormalizeCandidate,
	type NormalizeMerges,
	NormalizeMergesSchema,
	type Normalizer,
	type NormalizerMode,
	NormalizerSchema,
	normalizeCandidates,
	normalizeMergesSchema,
	promptDigest,
	type ResumeDisposition,
	type ResumeReport,
	ResumeReportSchema,
	type ReviewCluster,
	ReviewClusterSchema,
	type ReviewCounts,
	type ReviewerEntry,
	ReviewerEntrySchema,
	type ReviewerInput,
	type ReviewsRecord,
	ReviewsRecordSchema,
	resumeReportSchema,
	reviewCounts,
	reviewerEntries,
	reviewerKey,
	reviewersReported,
	withDispositions,
} from "./review-record.js";
export {
	type CheckReport,
	CheckReportSchema,
	DEFAULT_PATCH_INPUT,
	MAX_CHECK_TAIL_LENGTH,
	type VerifyCheck,
	type VerifyContext,
	type VerifyHandoffOptions,
	type VerifyTaskRequest,
	verifyHandoff,
} from "./verify.js";
