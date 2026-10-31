import type { ExactModelRequest } from "@vegardx/pi-subagent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { deriveJsonValueSha256 } from "../digest.js";
import { MAX_CHECK_TAIL_LENGTH } from "./verify-and-fix.js";

/**
 * The review loop's vocabulary: what a lens reports, the record the harness
 * builds from every lens of one deliverable, the view the resumed implementer
 * is shown, and the dispositions it answers with.
 *
 * Pattern: `skills/workflow-authoring/SKILL.md` § "Reviewers report, the
 * harness clusters, the implementer answers".
 *
 * The rule this module exists to encode: THE HARNESS MERGES WITHOUT JUDGING.
 * A reviewer reports findings; nothing here ranks, filters or rewrites one.
 * Clustering joins findings that point at the same place, attribution comes
 * from the launch plan the workflow declared (never from a model's words), and
 * the implementer is shown claims and evidence only — no severity, no lens, no
 * model, no agreement count, no suggestion — so it answers the finding rather
 * than the reputation of whoever raised it.
 *
 * Everything here is a pure function over JSON values, legal on either side of
 * a barrier and identical on replay.
 */

export const LENS_SEVERITIES = Object.freeze([
	"high",
	"medium",
	"low",
] as const);
export type LensSeverity = (typeof LENS_SEVERITIES)[number];
export const DISPOSITION_KINDS = Object.freeze([
	"fixed",
	"declined",
	"out-of-scope",
] as const);
export type DispositionKind = (typeof DISPOSITION_KINDS)[number];
export const NORMALIZER_MODES = Object.freeze([
	"deterministic",
	"model",
] as const);
export type NormalizerMode = (typeof NORMALIZER_MODES)[number];

/** One lens reports at most this many findings. */
export const MAX_LENS_FINDINGS = 64;
export const MAX_CLAIM_LENGTH = 1024;
export const MAX_EVIDENCE_LENGTH = 4096;
export const MAX_SUGGESTION_LENGTH = 2048;
export const MAX_LOCATION_FILE_LENGTH = 512;
export const MAX_REASONING_LENGTH = 2048;
/** Every lens of a deliverable, all its findings: the record's cluster bound. */
export const MAX_REVIEW_CLUSTERS = 1024;
/** Two findings of one lens within this many lines are one place. */
export const CLUSTER_LINE_WINDOW = 2;

/**
 * A closed string set as `{type: "string", enum}`: one schema level where a
 * union of literals spends two, because these shapes sit at the bottom of the
 * record and of a workflow output that embeds it, and a schema document is
 * bounded in depth (`validateJsonSchemaDocument`).
 */
function stringEnum<T extends string>(values: readonly T[]) {
	return Type.Unsafe<T>({ type: "string", enum: [...values] });
}

const SeveritySchema = stringEnum(LENS_SEVERITIES);
const ThinkingSchema = stringEnum([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const satisfies readonly ExactModelRequest["thinking"][]);
const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });

export const LensLocationSchema = Type.Object(
	{
		file: Type.String({ minLength: 1, maxLength: MAX_LOCATION_FILE_LENGTH }),
		line: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);
export type LensLocation = Static<typeof LensLocationSchema>;

/** One finding as a reviewer reports it. */
export const LensFindingSchema = Type.Object(
	{
		claim: Type.String({ minLength: 1, maxLength: MAX_CLAIM_LENGTH }),
		location: LensLocationSchema,
		evidence: Type.String({ minLength: 1, maxLength: MAX_EVIDENCE_LENGTH }),
		severity: SeveritySchema,
		suggestion: Type.Optional(
			Type.String({ minLength: 1, maxLength: MAX_SUGGESTION_LENGTH }),
		),
	},
	{ additionalProperties: false },
);
export type LensFinding = Static<typeof LensFindingSchema>;

/** What every reviewer returns. There is no verdict: a reviewer reports. */
export const LensReportSchema = Type.Object(
	{
		findings: Type.Array(LensFindingSchema, { maxItems: MAX_LENS_FINDINGS }),
	},
	{ additionalProperties: false },
);
export type LensReport = Static<typeof LensReportSchema>;

const ModelNameSchema = Type.String({
	pattern: "^\\S+/\\S+$",
	maxLength: 256,
});
const LensIdSchema = Type.String({ minLength: 1, maxLength: 128 });
const AttemptIdSchema = Type.String({ minLength: 1, maxLength: 128 });

export const ReviewerEntrySchema = Type.Object(
	{
		/** sha256 of the lens id, its prompt digest, its model and thinking. */
		reviewerKey: Sha256,
		lens: LensIdSchema,
		model: ModelNameSchema,
		thinking: Type.Optional(ThinkingSchema),
		/** The pi-subagent attempt; absent only for a lens that never ran one. */
		attemptId: Type.Optional(AttemptIdSchema),
		status: stringEnum(["reported", "failed"] as const),
		findings: Type.Integer({ minimum: 0, maximum: MAX_LENS_FINDINGS }),
	},
	{ additionalProperties: false },
);
export type ReviewerEntry = Static<typeof ReviewerEntrySchema>;

export const DispositionSchema = Type.Object(
	{
		kind: stringEnum(DISPOSITION_KINDS),
		reasoning: Type.String({ minLength: 1, maxLength: MAX_REASONING_LENGTH }),
	},
	{ additionalProperties: false },
);
export type Disposition = Static<typeof DispositionSchema>;

export const ReviewClusterSchema = Type.Object(
	{
		id: Type.String({ pattern: "^c[1-9][0-9]{0,3}$" }),
		/** The first reporter's claim, verbatim. */
		claim: Type.String({ minLength: 1, maxLength: MAX_CLAIM_LENGTH }),
		location: LensLocationSchema,
		/** The highest severity any member reported. */
		severity: SeveritySchema,
		reportedBy: Type.Array(
			Type.Object(
				{
					lens: LensIdSchema,
					model: ModelNameSchema,
					thinking: Type.Optional(ThinkingSchema),
					attemptId: AttemptIdSchema,
					findingIndex: Type.Integer({ minimum: 0 }),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
		/** Distinct reviewers in the cluster, of the reviewers that reported. */
		agreement: Type.Object(
			{
				count: Type.Integer({ minimum: 1 }),
				of: Type.Integer({ minimum: 1 }),
			},
			{ additionalProperties: false },
		),
		suggestions: Type.Array(
			Type.String({ minLength: 1, maxLength: MAX_SUGGESTION_LENGTH }),
		),
		raw: Type.Array(
			Type.Object(
				{
					reviewerIndex: Type.Integer({ minimum: 0 }),
					findingIndex: Type.Integer({ minimum: 0 }),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
		disposition: Type.Optional(DispositionSchema),
	},
	{ additionalProperties: false },
);
export type ReviewCluster = Static<typeof ReviewClusterSchema>;

export const NormalizerSchema = Type.Object(
	{
		mode: stringEnum(NORMALIZER_MODES),
		model: Type.Optional(ModelNameSchema),
		promptDigest: Type.Optional(Sha256),
	},
	{ additionalProperties: false },
);
export type Normalizer = Static<typeof NormalizerSchema>;

/**
 * `reviews-<deliverable>`: the harness's record of one deliverable's review.
 * It is a task artifact, a gate input and part of the receipt; a model wrote
 * none of its attribution.
 */
export const ReviewsRecordSchema = Type.Object(
	{
		deliverable: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }),
		handoffCommit: Type.String({ pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" }),
		reviewers: Type.Array(ReviewerEntrySchema, { maxItems: 16 }),
		clusters: Type.Array(ReviewClusterSchema, {
			maxItems: MAX_REVIEW_CLUSTERS,
		}),
		normalizer: NormalizerSchema,
	},
	{ additionalProperties: false },
);
export type ReviewsRecord = Static<typeof ReviewsRecordSchema>;

/**
 * The ONLY thing about the review the resumed implementer receives: claim,
 * location and evidence, ordered by file then line. Severity, lens, model,
 * agreement and suggestion are withheld on purpose.
 */
export const ImplementerViewSchema = Type.Object(
	{
		items: Type.Array(
			Type.Object(
				{
					id: Type.String({ pattern: "^c[1-9][0-9]{0,3}$" }),
					claim: Type.String({ minLength: 1, maxLength: MAX_CLAIM_LENGTH }),
					location: LensLocationSchema,
					evidence: Type.String({
						minLength: 1,
						maxLength: MAX_EVIDENCE_LENGTH,
					}),
				},
				{ additionalProperties: false },
			),
			{ maxItems: MAX_REVIEW_CLUSTERS },
		),
	},
	{ additionalProperties: false },
);
export type ImplementerView = Static<typeof ImplementerViewSchema>;

/** What the normalize model may answer: groups of cluster ids, and nothing else. */
export function normalizeMergesSchema(ids: readonly string[]) {
	return Type.Object(
		{
			merges: Type.Array(
				Type.Array(stringEnum(ids), { minItems: 2, maxItems: ids.length }),
				{ maxItems: Math.max(0, Math.floor(ids.length / 2)) },
			),
		},
		{ additionalProperties: false },
	);
}
/** The same shape over any ids, for validating an answer after the fact. */
export const NormalizeMergesSchema = Type.Object(
	{
		merges: Type.Array(
			Type.Array(Type.String({ pattern: "^c[1-9][0-9]{0,3}$" }), {
				minItems: 2,
			}),
		),
	},
	{ additionalProperties: false },
);
export type NormalizeMerges = Static<typeof NormalizeMergesSchema>;

const ImplementationFields = {
	summary: Type.String({ minLength: 1, maxLength: 4096 }),
	files: Type.Array(Type.String({ maxLength: 512 }), { maxItems: 128 }),
	checkCommand: Type.String({ maxLength: 512 }),
	checkRan: Type.Boolean(),
	checkPassed: Type.Boolean(),
	checkTail: Type.String({ maxLength: MAX_CHECK_TAIL_LENGTH }),
};

/**
 * The resumed implementer's answer, over the item ids it was shown: every id
 * exactly once (`minItems = maxItems = ids.length`, each id from the closed
 * set), and the same report an implementer gives. The schema cannot say
 * "each id once"; `checkDispositions` does.
 */
export function resumeReportSchema(ids: readonly string[]) {
	const id =
		ids.length === 0 ? Type.String({ pattern: "^$" }) : stringEnum([...ids]);
	return Type.Object(
		{
			dispositions: Type.Array(
				Type.Object(
					{
						id,
						kind: stringEnum(DISPOSITION_KINDS),
						reasoning: Type.String({
							minLength: 1,
							maxLength: MAX_REASONING_LENGTH,
						}),
					},
					{ additionalProperties: false },
				),
				{ minItems: ids.length, maxItems: ids.length },
			),
			...ImplementationFields,
		},
		{ additionalProperties: false },
	);
}
/** The same shape over any ids. */
export const ResumeReportSchema = resumeReportSchema([]);
export type ResumeDisposition = {
	readonly id: string;
	readonly kind: DispositionKind;
	readonly reasoning: string;
};
export type ResumeReport = Omit<
	Static<typeof ResumeReportSchema>,
	"dispositions"
> & { readonly dispositions: readonly ResumeDisposition[] };

/** One lens as the harness declared it, and what came back. */
export interface ReviewerInput {
	/** The lens key the fan-out declared. */
	readonly lens: string;
	/** The exact model the lens was launched at. */
	readonly model: ExactModelRequest;
	/** sha256 of the lens's delegated task: goal, context and instructions. */
	readonly promptSha256: string;
	/** The pi-subagent attempt that produced the report, when one ran. */
	readonly attemptId?: string;
	/** Present only for a lens that reported. */
	readonly report?: LensReport;
}

function modelName(model: ExactModelRequest): string {
	return `${model.provider}/${model.id}`;
}

/** The identity of a reviewer, across runs: what it was asked, of which model. */
export function reviewerKey(input: {
	readonly lens: string;
	readonly promptSha256: string;
	readonly model: ExactModelRequest;
}): string {
	return deriveJsonValueSha256({
		lens: input.lens,
		promptSha256: input.promptSha256,
		model: modelName(input.model),
		thinking: input.model.thinking,
	});
}

/** The digest of a delegated task's prose; the input to `reviewerKey`. */
export function promptDigest(task: {
	readonly goal: string;
	readonly context?: readonly string[];
	readonly instructions?: readonly string[];
}): string {
	return deriveJsonValueSha256({
		goal: task.goal,
		context: [...(task.context ?? [])],
		instructions: [...(task.instructions ?? [])],
	});
}

function severityRank(severity: LensSeverity): number {
	return LENS_SEVERITIES.indexOf(severity);
}

/** File, then line (a file-level finding first), then the first raw entry. */
function compareLocation(left: LensLocation, right: LensLocation): number {
	if (left.file !== right.file) return left.file < right.file ? -1 : 1;
	const leftLine = left.line ?? 0;
	const rightLine = right.line ?? 0;
	return leftLine - rightLine;
}

function sameLocation(anchor: LensLocation, other: LensLocation): boolean {
	if (anchor.file !== other.file) return false;
	if (anchor.line === undefined || other.line === undefined) {
		return anchor.line === other.line;
	}
	return Math.abs(anchor.line - other.line) <= CLUSTER_LINE_WINDOW;
}

interface Member {
	readonly reviewerIndex: number;
	readonly findingIndex: number;
	readonly finding: LensFinding;
}

function compareMembers(left: Member, right: Member): number {
	return left.reviewerIndex !== right.reviewerIndex
		? left.reviewerIndex - right.reviewerIndex
		: left.findingIndex - right.findingIndex;
}

/** How many reviewers reported: the `of` of every agreement. */
export function reviewersReported(reviewers: readonly ReviewerInput[]): number {
	return reviewers.filter((reviewer) => reviewer.report !== undefined).length;
}

/** A finding is attributed to the attempt that reported it, never invented. */
function attemptOf(reviewer: ReviewerInput): string {
	if (reviewer.attemptId === undefined) {
		throw new Error(
			`reviewer ${JSON.stringify(reviewer.lens)} reported findings without an attempt`,
		);
	}
	return reviewer.attemptId;
}

function buildCluster(
	id: string,
	members: readonly Member[],
	reviewers: readonly ReviewerInput[],
	of: number,
): ReviewCluster {
	const ordered = [...members].sort(compareMembers);
	const first = ordered[0] as Member;
	let severity: LensSeverity = first.finding.severity;
	const suggestions: string[] = [];
	const distinct = new Set<number>();
	for (const member of ordered) {
		if (severityRank(member.finding.severity) < severityRank(severity)) {
			severity = member.finding.severity;
		}
		const suggestion = member.finding.suggestion;
		if (suggestion !== undefined && !suggestions.includes(suggestion)) {
			suggestions.push(suggestion);
		}
		distinct.add(member.reviewerIndex);
	}
	return {
		id,
		claim: first.finding.claim,
		location: { ...first.finding.location },
		severity,
		reportedBy: ordered.map((member) => {
			const reviewer = reviewers[member.reviewerIndex] as ReviewerInput;
			return {
				lens: reviewer.lens,
				model: modelName(reviewer.model),
				thinking: reviewer.model.thinking,
				attemptId: attemptOf(reviewer),
				findingIndex: member.findingIndex,
			};
		}),
		agreement: { count: distinct.size, of: Math.max(1, of) },
		suggestions,
		raw: ordered.map((member) => ({
			reviewerIndex: member.reviewerIndex,
			findingIndex: member.findingIndex,
		})),
	};
}

/** Clusters ordered by location, then by first reporter; ids `c1..cn`. */
function orderClusters(
	groups: readonly (readonly Member[])[],
): readonly (readonly Member[])[] {
	return [...groups]
		.map((group) => [...group].sort(compareMembers))
		.sort((left, right) => {
			const leftFirst = left[0] as Member;
			const rightFirst = right[0] as Member;
			const byLocation = compareLocation(
				leftFirst.finding.location,
				rightFirst.finding.location,
			);
			return byLocation !== 0
				? byLocation
				: compareMembers(leftFirst, rightFirst);
		});
}

/**
 * THE DETERMINISTIC MERGE: findings of the SAME lens at the same place — the
 * same file, lines within ±2 of the cluster's first finding, or both without a
 * line — are one cluster. Nothing across lenses is merged here; that is a
 * semantic question, and only `applyModelMerges` may answer it.
 */
export function clusterFindings(
	reviewers: readonly ReviewerInput[],
): readonly ReviewCluster[] {
	const groups: Member[][] = [];
	reviewers.forEach((reviewer, reviewerIndex) => {
		const findings = reviewer.report?.findings ?? [];
		const members = findings
			.map((finding, findingIndex) => ({
				reviewerIndex,
				findingIndex,
				finding,
			}))
			.sort((left, right) => {
				const byLocation = compareLocation(
					left.finding.location,
					right.finding.location,
				);
				return byLocation !== 0 ? byLocation : compareMembers(left, right);
			});
		let current: Member[] | undefined;
		for (const member of members) {
			const anchor = current?.[0];
			if (
				current &&
				anchor &&
				sameLocation(anchor.finding.location, member.finding.location)
			) {
				current.push(member);
				continue;
			}
			current = [member];
			groups.push(current);
		}
	});
	const of = reviewersReported(reviewers);
	return Object.freeze(
		orderClusters(groups).map((group, index) =>
			buildCluster(`c${index + 1}`, group, reviewers, of),
		),
	);
}

/** One cluster as the normalize model is shown it. */
export interface NormalizeCandidate {
	readonly id: string;
	readonly lens: string;
	readonly claim: string;
	readonly location: LensLocation;
}

/**
 * What the normalize model is offered, or `undefined` when it has nothing to
 * decide: fewer than two reviewers reported, or every cluster came from one
 * lens, so no two clusters could be the same finding seen twice.
 */
export function normalizeCandidates(
	reviewers: readonly ReviewerInput[],
	clusters: readonly ReviewCluster[],
): readonly NormalizeCandidate[] | undefined {
	if (reviewersReported(reviewers) < 2) return undefined;
	const lenses = new Set(
		clusters.map((cluster) => cluster.raw[0]?.reviewerIndex),
	);
	if (lenses.size < 2) return undefined;
	return Object.freeze(
		clusters.map((cluster) => ({
			id: cluster.id,
			lens: cluster.reportedBy[0]?.lens ?? "",
			claim: cluster.claim,
			location: { ...cluster.location },
		})),
	);
}

export type MergeOutcome =
	| { readonly applied: true; readonly clusters: readonly ReviewCluster[] }
	| {
			readonly applied: false;
			readonly clusters: readonly ReviewCluster[];
			readonly reason: string;
	  };

/**
 * The normalize model's answer, applied — or refused whole.
 *
 * The model may only MERGE: every group names at least two clusters it was
 * offered, no cluster appears twice, and the answer carries nothing but
 * `merges`. Anything else — an unknown id (a cluster it invented), a repeated
 * one, a group of one, an extra field (a rewritten claim, a dropped list) — is
 * not partially honoured: the deterministic clusters stand and the reason is
 * returned. A merged cluster keeps the id, claim and location of its first
 * reporter; the severity is the highest, the suggestions and raw entries the
 * union, and the agreement counts the distinct reviewers.
 */
export function applyModelMerges(
	clusters: readonly ReviewCluster[],
	reviewers: readonly ReviewerInput[],
	answer: unknown,
): MergeOutcome {
	const refuse = (reason: string): MergeOutcome => ({
		applied: false,
		clusters,
		reason,
	});
	if (!Value.Check(NormalizeMergesSchema, answer)) {
		return refuse("the answer is not a list of merges and nothing else");
	}
	const byId = new Map(clusters.map((cluster) => [cluster.id, cluster]));
	const seen = new Set<string>();
	for (const group of answer.merges) {
		for (const id of group) {
			if (!byId.has(id)) return refuse(`it names an unknown cluster ${id}`);
			if (seen.has(id)) return refuse(`it names cluster ${id} twice`);
			seen.add(id);
		}
	}
	const memberOf = (cluster: ReviewCluster): Member[] =>
		cluster.raw.map((entry) => {
			const finding =
				reviewers[entry.reviewerIndex]?.report?.findings[entry.findingIndex];
			if (!finding) throw new Error("cluster names a finding nobody reported");
			return { ...entry, finding };
		});
	const merged = new Map<string, Member[]>();
	for (const group of answer.merges) {
		const members = group.flatMap((id) =>
			memberOf(byId.get(id) as ReviewCluster),
		);
		const first = [...members].sort(compareMembers)[0] as Member;
		const owner = group.find((id) =>
			(byId.get(id) as ReviewCluster).raw.some(
				(entry) =>
					entry.reviewerIndex === first.reviewerIndex &&
					entry.findingIndex === first.findingIndex,
			),
		) as string;
		merged.set(owner, members);
	}
	const of = reviewersReported(reviewers);
	const result: ReviewCluster[] = [];
	for (const cluster of clusters) {
		const members = merged.get(cluster.id);
		if (members) {
			result.push(buildCluster(cluster.id, members, reviewers, of));
		} else if (!seen.has(cluster.id)) {
			result.push(cluster);
		}
	}
	return { applied: true, clusters: Object.freeze(result) };
}

/**
 * The resumed implementer's view: each cluster's id, claim, location and the
 * first reporter's evidence, ordered by file, then line (a file-level item
 * first), then id. Nothing else crosses.
 */
export function implementerView(
	clusters: readonly ReviewCluster[],
	reviewers: readonly ReviewerInput[],
): ImplementerView {
	const items = clusters.map((cluster) => {
		const first = cluster.raw[0];
		const finding =
			first === undefined
				? undefined
				: reviewers[first.reviewerIndex]?.report?.findings[first.findingIndex];
		return {
			id: cluster.id,
			claim: cluster.claim,
			location: {
				file: cluster.location.file,
				...(cluster.location.line === undefined
					? {}
					: { line: cluster.location.line }),
			},
			evidence: finding?.evidence ?? cluster.claim,
		};
	});
	items.sort((left, right) => {
		const byLocation = compareLocation(left.location, right.location);
		if (byLocation !== 0) return byLocation;
		return Number(left.id.slice(1)) - Number(right.id.slice(1));
	});
	return { items };
}

/**
 * Why a resumed implementer's dispositions do not answer the view it was
 * shown, or `undefined` when every item id appears exactly once and nothing
 * else does.
 */
export function checkDispositions(
	view: ImplementerView,
	dispositions: readonly { readonly id: string }[],
): string | undefined {
	const expected = new Set(view.items.map((item) => item.id));
	const seen = new Set<string>();
	for (const disposition of dispositions) {
		if (!expected.has(disposition.id)) {
			return `it answers ${JSON.stringify(disposition.id)}, which it was not shown`;
		}
		if (seen.has(disposition.id)) {
			return `it answers ${disposition.id} more than once`;
		}
		seen.add(disposition.id);
	}
	const missing = [...expected].filter((id) => !seen.has(id));
	return missing.length === 0
		? undefined
		: `it leaves ${missing.join(", ")} unanswered`;
}

/** The reviewers' rows of the record, stamped from the declared launch. */
export function reviewerEntries(
	reviewers: readonly ReviewerInput[],
): readonly ReviewerEntry[] {
	return Object.freeze(
		reviewers.map((reviewer) => ({
			reviewerKey: reviewerKey(reviewer),
			lens: reviewer.lens,
			model: modelName(reviewer.model),
			thinking: reviewer.model.thinking,
			...(reviewer.attemptId === undefined
				? {}
				: { attemptId: reviewer.attemptId }),
			status: reviewer.report ? ("reported" as const) : ("failed" as const),
			findings: reviewer.report?.findings.length ?? 0,
		})),
	);
}

/** The record with each cluster's disposition, by id. */
export function withDispositions(
	record: ReviewsRecord,
	dispositions: readonly ResumeDisposition[],
): ReviewsRecord {
	const byId = new Map(dispositions.map((entry) => [entry.id, entry]));
	return {
		...record,
		clusters: record.clusters.map((cluster) => {
			const disposition = byId.get(cluster.id);
			return disposition
				? {
						...cluster,
						disposition: {
							kind: disposition.kind,
							reasoning: disposition.reasoning,
						},
					}
				: cluster;
		}),
	};
}

/** What a gate and a receipt say about one record: counts, never prose. */
export interface ReviewCounts {
	readonly reviewers: number;
	readonly reported: number;
	readonly clusters: number;
	/** Clusters at least two reviewers raised. */
	readonly agreed: number;
	readonly fixed: number;
	readonly declined: number;
	readonly outOfScope: number;
	/** Clusters with no disposition: no resume ran, or none was asked for. */
	readonly unanswered: number;
}

export function reviewCounts(record: ReviewsRecord): ReviewCounts {
	const count = (kind: DispositionKind) =>
		record.clusters.filter((cluster) => cluster.disposition?.kind === kind)
			.length;
	return Object.freeze({
		reviewers: record.reviewers.length,
		reported: record.reviewers.filter((entry) => entry.status === "reported")
			.length,
		clusters: record.clusters.length,
		agreed: record.clusters.filter((cluster) => cluster.agreement.count >= 2)
			.length,
		fixed: count("fixed"),
		declined: count("declined"),
		outOfScope: count("out-of-scope"),
		unanswered: record.clusters.filter(
			(cluster) => cluster.disposition === undefined,
		).length,
	});
}
