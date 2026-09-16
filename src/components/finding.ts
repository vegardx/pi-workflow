import { type Static, Type } from "typebox";

/**
 * The shared review vocabulary: one `Finding` shape for every reviewer in
 * every workflow, and the deterministic rails that merge a fan-out of them
 * into one verdict.
 *
 * Pattern: **A reviewed subject reports findings, not prose**
 * (`skills/workflow-authoring/SKILL.md`, the "Patterns" section added by
 * W3-SKILL; the rules it encodes live today under "Agent requests" and
 * "Barriers and replay").
 *
 * Nothing here touches `ctx`. These are pure functions over JSON values, so
 * they are legal on either side of a barrier and identical on replay: the
 * merge is a table, not a model call, which is why a synthesis agent may be
 * absent without changing the verdict a run records.
 */

/** A finding id: stable, lowercase, and safe to use as a map key. */
export const FINDING_ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";
const FINDING_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Most severe first. The order IS the severity ordering; nothing else ranks. */
export const FINDING_SEVERITIES = Object.freeze([
	"blocking",
	"major",
	"minor",
] as const);
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export const FINDING_KINDS = Object.freeze([
	"gap",
	"graph",
	"budget",
	"risk",
	"ambiguity",
] as const);
export type FindingKind = (typeof FINDING_KINDS)[number];
/** The bound both builtin review workflows declare on their findings array. */
export const MAX_FINDINGS = 64;
export const MAX_FINDING_WHAT_LENGTH = 2048;
export const MAX_FINDING_WHERE_LENGTH = 512;
export const MAX_REVIEW_SYNTHESIS_LENGTH = 8192;

/**
 * RFC 6902-shaped so that accepting a finding is a mechanical apply against
 * the document it points into, followed by that document's own validation —
 * never a re-prompt. Optional: a code reviewer reports `where`/`what` only.
 */
export const FindingPatchSchema = Type.Object(
	{
		op: Type.Union([
			Type.Literal("add"),
			Type.Literal("replace"),
			Type.Literal("remove"),
		]),
		path: Type.String({ minLength: 1, maxLength: 1024 }),
		value: Type.Optional(Type.Unknown()),
	},
	{ additionalProperties: false },
);
export type FindingPatch = Static<typeof FindingPatchSchema>;

/** `where` is an RFC 6901 pointer into the reviewed document. */
export const FindingSchema = Type.Object(
	{
		id: Type.String({ pattern: FINDING_ID_PATTERN }),
		severity: Type.Union([
			Type.Literal("blocking"),
			Type.Literal("major"),
			Type.Literal("minor"),
		]),
		kind: Type.Union([
			Type.Literal("gap"),
			Type.Literal("graph"),
			Type.Literal("budget"),
			Type.Literal("risk"),
			Type.Literal("ambiguity"),
		]),
		where: Type.String({ minLength: 1, maxLength: MAX_FINDING_WHERE_LENGTH }),
		what: Type.String({ minLength: 1, maxLength: MAX_FINDING_WHAT_LENGTH }),
		patch: Type.Optional(FindingPatchSchema),
	},
	{ additionalProperties: false },
);
export type Finding = Static<typeof FindingSchema>;

export const ReviewVerdictSchema = Type.Union([
	Type.Literal("approve"),
	Type.Literal("request-changes"),
]);
export type ReviewVerdict = Static<typeof ReviewVerdictSchema>;

/**
 * What one lens returns. Every reviewer a component declares reports exactly
 * this, so a caller never parses prose and a lens that reports nothing is
 * visibly missing rather than silently empty.
 */
export const ReviewReportSchema = Type.Object(
	{
		verdict: ReviewVerdictSchema,
		findings: Type.Array(FindingSchema, { maxItems: MAX_FINDINGS }),
	},
	{ additionalProperties: false },
);
export type ReviewReport = Static<typeof ReviewReportSchema>;

/** What a synthesis reducer returns: prose only; the verdict is computed. */
export const ReviewSynthesisSchema = Type.Object(
	{
		synthesis: Type.String({
			minLength: 1,
			maxLength: MAX_REVIEW_SYNTHESIS_LENGTH,
		}),
	},
	{ additionalProperties: false },
);
export type ReviewSynthesis = Static<typeof ReviewSynthesisSchema>;

/** One row of "did this lens report?", the honest half of a degraded fan-out. */
export const ReviewCoverageEntrySchema = Type.Object(
	{
		lens: Type.String({ minLength: 1, maxLength: 128 }),
		reported: Type.Boolean(),
		verdict: Type.Optional(ReviewVerdictSchema),
	},
	{ additionalProperties: false },
);
export type ReviewCoverageEntry = Static<typeof ReviewCoverageEntrySchema>;

/** A finding as reported, carrying who reported it and in which ordinal. */
export interface ReportedFinding {
	/** The lens key that reported it; used only for tie-breaking and ids. */
	readonly lens: string;
	/** The lens's declaration ordinal, 0-based. Never a runtime counter. */
	readonly ordinal: number;
	readonly finding: Finding;
}

export interface ReportedReview {
	readonly lens: string;
	readonly ordinal: number;
	readonly report: ReviewReport;
}

export interface MergedReview {
	readonly verdict: ReviewVerdict;
	readonly findings: readonly Finding[];
}

export interface FindingMergeOptions {
	/** Keep at most this many findings, least severe dropped first. */
	readonly max?: number;
}

/** 0 for `blocking`, 1 for `major`, 2 for `minor`. Lower is worse. */
export function findingSeverityRank(severity: FindingSeverity): number {
	const rank = FINDING_SEVERITIES.indexOf(severity);
	return rank === -1 ? FINDING_SEVERITIES.length : rank;
}

/**
 * The dedup key: two lenses that say the same thing about the same place say
 * it once. Case, surrounding whitespace, internal runs of whitespace and a
 * trailing sentence mark are not differences; anything else is.
 */
function dedupKey(finding: Finding): string {
	const what = finding.what
		.trim()
		.toLowerCase()
		.replace(/\s+/gu, " ")
		.replace(/[.!]+$/u, "");
	// JSON, not a separator character: no `where` or `what` can forge a key.
	return JSON.stringify([finding.kind, finding.where, what]);
}

/**
 * The total order findings are reported in: severity, then the declaration
 * ordinal of the lens that raised it, then the finding id, then `where`. Every
 * component of it is a declaration-time value, so the order is identical on
 * replay and the `max` cut always drops the same tail.
 */
function compareReported(
	left: ReportedFinding,
	right: ReportedFinding,
): number {
	const bySeverity =
		findingSeverityRank(left.finding.severity) -
		findingSeverityRank(right.finding.severity);
	if (bySeverity !== 0) return bySeverity;
	if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
	if (left.finding.id !== right.finding.id) {
		return left.finding.id < right.finding.id ? -1 : 1;
	}
	if (left.finding.where !== right.finding.where) {
		return left.finding.where < right.finding.where ? -1 : 1;
	}
	return 0;
}

/** `id`, then `id-2`, `id-3`, … in output order; ids stay within the pattern. */
function uniqueId(id: string, used: Map<string, number>): string {
	const seen = used.get(id) ?? 0;
	used.set(id, seen + 1);
	if (seen === 0) return id;
	const suffix = `-${seen + 1}`;
	const base = id.slice(0, 64 - suffix.length);
	return `${base}${suffix}`;
}

/**
 * Collapse duplicate findings and order them.
 *
 * Rules, in force for every component that merges a review fan-out:
 *
 * 1. Two findings are the same finding when their `kind`, their `where` and
 *    their normalized `what` agree.
 * 2. The survivor of a group is its most severe member; ties go to the lens
 *    with the lower declaration ordinal, so the first lens to raise something
 *    owns it.
 * 3. Output order is severity, lens ordinal, id, `where`.
 * 4. Ids are made unique in output order with `-2`, `-3`, … exactly as
 *    duplicate lens keys are, so a reader can cite a finding by id.
 * 5. At most `max` (default 64) survive; the cut takes the tail of rule 3.
 *
 * Neither the input array nor any finding in it is mutated.
 */
export function dedupeFindings(
	reported: readonly ReportedFinding[],
	options: FindingMergeOptions = {},
): readonly Finding[] {
	const max = options.max ?? MAX_FINDINGS;
	const groups = new Map<string, ReportedFinding>();
	for (const entry of reported) {
		const key = dedupKey(entry.finding);
		const current = groups.get(key);
		if (!current || compareReported(entry, current) < 0) {
			groups.set(key, entry);
		}
	}
	const ordered = [...groups.values()].sort(compareReported).slice(0, max);
	const used = new Map<string, number>();
	return Object.freeze(
		ordered.map((entry) =>
			Object.freeze({
				...entry.finding,
				id: uniqueId(entry.finding.id, used),
			}),
		),
	);
}

/**
 * The verdict a run records, computed from the lenses that reported.
 *
 * `request-changes` when any reporting lens asked for changes, or when any
 * surviving finding is `blocking` — a lens that approves while raising a
 * blocking finding does not get to have it both ways. An empty fan-out, or one
 * where every reviewer failed, is `approve` with no findings and is honest
 * about it through the coverage rows the caller reports alongside.
 */
export function mergeReviewReports(
	reviews: readonly ReportedReview[],
	options: FindingMergeOptions = {},
): MergedReview {
	const findings = dedupeFindings(
		reviews.flatMap((entry) =>
			entry.report.findings.map((finding) => ({
				lens: entry.lens,
				ordinal: entry.ordinal,
				finding,
			})),
		),
		options,
	);
	const requested =
		reviews.some((entry) => entry.report.verdict === "request-changes") ||
		findings.some((finding) => finding.severity === "blocking");
	return Object.freeze({
		verdict: requested ? "request-changes" : "approve",
		findings,
	});
}

/** True when `value` is a finding id this vocabulary accepts. */
export function isFindingId(value: string): boolean {
	return FINDING_ID_RE.test(value);
}
