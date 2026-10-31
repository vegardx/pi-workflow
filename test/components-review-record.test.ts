import type { ExactModelRequest } from "@vegardx/pi-subagent";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	applyModelMerges,
	checkDispositions,
	clusterFindings,
	ImplementerViewSchema,
	implementerView,
	type LensFinding,
	LensReportSchema,
	normalizeCandidates,
	normalizeMergesSchema,
	promptDigest,
	type ReviewerInput,
	type ReviewsRecord,
	ReviewsRecordSchema,
	resumeReportSchema,
	reviewCounts,
	reviewerEntries,
	reviewerKey,
	withDispositions,
} from "../src/components/index.js";

// The review loop's vocabulary, as the plan-to-ship redesign states it: the
// harness merges without judging, a model may only merge, the implementer sees
// claims and evidence only, and it answers every item exactly once.

const SOL = {
	provider: "github-copilot",
	id: "gpt-5.6-sol",
	thinking: "medium",
} as const;
const LUNA = {
	provider: "github-copilot",
	id: "gpt-5.6-luna",
	thinking: "high",
} as const;
const PROMPT = "f".repeat(64);

function finding(
	file: string,
	line: number | undefined,
	claim: string,
	extra: Partial<LensFinding> = {},
): LensFinding {
	return {
		claim,
		location: { file, ...(line === undefined ? {} : { line }) },
		evidence: `evidence for ${claim}`,
		severity: "medium",
		...extra,
	};
}

function reviewer(
	lens: string,
	findings: readonly LensFinding[] | undefined,
	model: ExactModelRequest = SOL,
): ReviewerInput {
	return {
		lens,
		model,
		promptSha256: PROMPT,
		...(findings === undefined
			? {}
			: { attemptId: `attempt_${lens}`, report: { findings: [...findings] } }),
	};
}

describe("lens report", () => {
	it("admits the standardized finding and refuses anything else", () => {
		expect(
			Value.Check(LensReportSchema, {
				findings: [
					finding("src/a.ts", 3, "Off by one.", { suggestion: "Use <=." }),
				],
			}),
		).toBe(true);
		expect(
			Value.Check(LensReportSchema, {
				verdict: "approve",
				findings: [],
			}),
		).toBe(false);
		expect(
			Value.Check(LensReportSchema, {
				findings: [{ ...finding("src/a.ts", 3, "x"), severity: "blocking" }],
			}),
		).toBe(false);
		expect(
			Value.Check(LensReportSchema, {
				findings: Array.from({ length: 65 }, () => finding("a", 1, "x")),
			}),
		).toBe(false);
	});
});

describe("clusterFindings", () => {
	it("merges one lens's findings within two lines of the first, and nothing across lenses", () => {
		const reviewers = [
			reviewer("correctness", [
				finding("src/a.ts", 10, "First claim.", {
					severity: "low",
					suggestion: "S1",
				}),
				finding("src/a.ts", 12, "Second claim.", {
					severity: "high",
					suggestion: "S2",
				}),
				finding("src/a.ts", 13, "Three past the first.", { severity: "low" }),
			]),
			reviewer("security", [finding("src/a.ts", 10, "Same line, other lens.")]),
		];
		const clusters = clusterFindings(reviewers);
		expect(clusters.map((cluster) => cluster.raw)).toEqual([
			[
				{ reviewerIndex: 0, findingIndex: 0 },
				{ reviewerIndex: 0, findingIndex: 1 },
			],
			[{ reviewerIndex: 1, findingIndex: 0 }],
			[{ reviewerIndex: 0, findingIndex: 2 }],
		]);
		const [merged] = clusters;
		expect(merged).toMatchObject({
			id: "c1",
			claim: "First claim.",
			location: { file: "src/a.ts", line: 10 },
			severity: "high",
			suggestions: ["S1", "S2"],
			agreement: { count: 1, of: 2 },
		});
		expect(merged?.reportedBy).toEqual([
			{
				lens: "correctness",
				model: "github-copilot/gpt-5.6-sol",
				thinking: "medium",
				attemptId: "attempt_correctness",
				findingIndex: 0,
			},
			{
				lens: "correctness",
				model: "github-copilot/gpt-5.6-sol",
				thinking: "medium",
				attemptId: "attempt_correctness",
				findingIndex: 1,
			},
		]);
		expect(clusters.map((cluster) => cluster.id)).toEqual(["c1", "c2", "c3"]);
	});

	it("treats file-level findings of one lens as one place, and never as a line", () => {
		const clusters = clusterFindings([
			reviewer("docs", [
				finding("README.md", undefined, "No usage section."),
				finding("README.md", 1, "Title is wrong."),
				finding("README.md", undefined, "No licence line."),
			]),
		]);
		expect(clusters.map((cluster) => cluster.raw.length)).toEqual([2, 1]);
		expect(clusters[0]?.location).toEqual({ file: "README.md" });
	});

	it("counts agreement of the reviewers that reported, not of those declared", () => {
		const clusters = clusterFindings([
			reviewer("a", [finding("x.ts", 1, "x")]),
			reviewer("b", undefined),
			reviewer("c", []),
		]);
		expect(clusters[0]?.agreement).toEqual({ count: 1, of: 2 });
	});

	it("refuses to attribute a finding to an attempt nobody recorded", () => {
		expect(() =>
			clusterFindings([
				{
					lens: "a",
					model: SOL,
					promptSha256: PROMPT,
					report: { findings: [finding("x", 1, "x")] },
				},
			]),
		).toThrow(/without an attempt/);
	});
});

describe("model merges", () => {
	const reviewers = [
		reviewer("correctness", [
			finding("src/a.ts", 10, "Null is not handled.", {
				severity: "low",
				suggestion: "Guard it.",
			}),
		]),
		reviewer(
			"security",
			[
				finding("src/a.ts", 30, "Unchecked input reaches the parser.", {
					severity: "high",
				}),
				finding("src/b.ts", 1, "Unrelated."),
			],
			LUNA,
		),
	];
	const clusters = clusterFindings(reviewers);

	it("offers every cluster when two lenses reported, and nothing otherwise", () => {
		expect(
			normalizeCandidates(reviewers, clusters)?.map((entry) => entry.id),
		).toEqual(["c1", "c2", "c3"]);
		const one = [
			reviewers[0] as ReviewerInput,
			reviewer("security", undefined),
		];
		expect(normalizeCandidates(one, clusterFindings(one))).toBeUndefined();
		const sameLens = [reviewers[0] as ReviewerInput, reviewer("quiet", [])];
		expect(
			normalizeCandidates(sameLens, clusterFindings(sameLens)),
		).toBeUndefined();
	});

	it("merges under the first reporter's id, claim and location", () => {
		const outcome = applyModelMerges(clusters, reviewers, {
			merges: [["c2", "c1"]],
		});
		expect(outcome.applied).toBe(true);
		expect(outcome.clusters.map((cluster) => cluster.id)).toEqual(["c1", "c3"]);
		expect(outcome.clusters[0]).toMatchObject({
			id: "c1",
			claim: "Null is not handled.",
			location: { file: "src/a.ts", line: 10 },
			severity: "high",
			agreement: { count: 2, of: 2 },
			suggestions: ["Guard it."],
			raw: [
				{ reviewerIndex: 0, findingIndex: 0 },
				{ reviewerIndex: 1, findingIndex: 0 },
			],
		});
		expect(outcome.clusters[0]?.reportedBy.map((entry) => entry.model)).toEqual(
			["github-copilot/gpt-5.6-sol", "github-copilot/gpt-5.6-luna"],
		);
	});

	it.each([
		["an unknown cluster", { merges: [["c1", "c9"]] }],
		[
			"a cluster twice",
			{
				merges: [
					["c1", "c2"],
					["c2", "c3"],
				],
			},
		],
		["a group of one", { merges: [["c1"]] }],
		[
			"a rewritten claim",
			{ merges: [["c1", "c2"]], claims: { c1: "Rewritten." } },
		],
		["a dropped list", { merges: [["c1", "c2"]], drop: ["c3"] }],
		["anything but merges", { clusters: [] }],
	])(
		"ignores an answer that names %s, keeping every deterministic cluster",
		(_label, answer) => {
			const outcome = applyModelMerges(clusters, reviewers, answer);
			expect(outcome.applied).toBe(false);
			expect(outcome.clusters).toBe(clusters);
		},
	);

	it("pins the answer schema to the offered ids", () => {
		const schema = normalizeMergesSchema(["c1", "c2", "c3"]);
		expect(Value.Check(schema, { merges: [["c1", "c2"]] })).toBe(true);
		expect(Value.Check(schema, { merges: [["c1", "c4"]] })).toBe(false);
		expect(Value.Check(schema, { merges: [], note: "x" })).toBe(false);
	});
});

describe("implementerView", () => {
	it("carries id, claim, location and evidence only, ordered by file then line", () => {
		const reviewers = [
			reviewer("correctness", [
				finding("src/b.ts", 4, "B four.", {
					severity: "high",
					suggestion: "fix",
				}),
				finding("src/a.ts", 40, "A forty."),
			]),
			reviewer("security", [
				finding("src/a.ts", 2, "A two."),
				finding("src/a.ts", undefined, "A file-level."),
			]),
		];
		const view = implementerView(clusterFindings(reviewers), reviewers);
		expect(Value.Check(ImplementerViewSchema, view)).toBe(true);
		expect(view.items.map((item) => item.claim)).toEqual([
			"A file-level.",
			"A two.",
			"A forty.",
			"B four.",
		]);
		for (const item of view.items) {
			expect(Object.keys(item).sort()).toEqual([
				"claim",
				"evidence",
				"id",
				"location",
			]);
		}
		const text = JSON.stringify(view);
		for (const withheld of [
			"severity",
			"lens",
			"model",
			"agreement",
			"suggestion",
			"correctness",
			"gpt-5.6",
			"high",
			'fix"',
		]) {
			expect(text).not.toContain(withheld);
		}
		expect(view.items[3]?.evidence).toBe("evidence for B four.");
	});
});

describe("dispositions", () => {
	const view = {
		items: [
			{ id: "c1", claim: "x", location: { file: "a" }, evidence: "e" },
			{ id: "c2", claim: "y", location: { file: "b" }, evidence: "e" },
		],
	};

	it("accepts every item exactly once", () => {
		expect(
			checkDispositions(view, [{ id: "c2" }, { id: "c1" }]),
		).toBeUndefined();
	});

	it.each([
		["a missing item", [{ id: "c1" }], /c2 unanswered/],
		[
			"a repeated item",
			[{ id: "c1" }, { id: "c1" }, { id: "c2" }],
			/c1 more than once/,
		],
		[
			"an item it was not shown",
			[{ id: "c1" }, { id: "c2" }, { id: "c3" }],
			/"c3"/,
		],
	])("refuses %s", (_label, dispositions, message) => {
		expect(checkDispositions(view, dispositions)).toMatch(message);
	});

	it("pins the resume answer to the shown ids, one entry each", () => {
		const schema = resumeReportSchema(["c1", "c2"]);
		const base = {
			summary: "Answered.",
			files: [],
			checkCommand: "npm run check",
			checkRan: true,
			checkPassed: true,
			checkTail: "ok",
		};
		const answer = (ids: string[]) => ({
			...base,
			dispositions: ids.map((id) => ({
				id,
				kind: "fixed",
				reasoning: "Done.",
			})),
		});
		expect(Value.Check(schema, answer(["c1", "c2"]))).toBe(true);
		expect(Value.Check(schema, answer(["c1"]))).toBe(false);
		expect(Value.Check(schema, answer(["c1", "c3"]))).toBe(false);
		expect(Value.Check(resumeReportSchema([]), answer([]))).toBe(true);
	});
});

describe("the record", () => {
	const reviewers = [
		reviewer("correctness", [
			finding("src/a.ts", 1, "One."),
			finding("src/b.ts", 1, "Two."),
		]),
		reviewer("security", undefined, LUNA),
	];
	const record: ReviewsRecord = {
		deliverable: "d0",
		handoffCommit: "a".repeat(40),
		reviewers: [...reviewerEntries(reviewers)],
		clusters: [...clusterFindings(reviewers)],
		normalizer: { mode: "deterministic" },
	};

	it("stamps attribution from the declared launch and validates", () => {
		expect(Value.Check(ReviewsRecordSchema, record)).toBe(true);
		expect(record.reviewers).toEqual([
			{
				reviewerKey: reviewerKey({
					lens: "correctness",
					promptSha256: PROMPT,
					model: SOL,
				}),
				lens: "correctness",
				model: "github-copilot/gpt-5.6-sol",
				thinking: "medium",
				attemptId: "attempt_correctness",
				status: "reported",
				findings: 2,
			},
			{
				reviewerKey: reviewerKey({
					lens: "security",
					promptSha256: PROMPT,
					model: LUNA,
				}),
				lens: "security",
				model: "github-copilot/gpt-5.6-luna",
				thinking: "high",
				status: "failed",
				findings: 0,
			},
		]);
	});

	it("keys a reviewer by lens, prompt, model and thinking", () => {
		const key = reviewerKey({ lens: "a", promptSha256: PROMPT, model: SOL });
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		expect(reviewerKey({ lens: "a", promptSha256: PROMPT, model: SOL })).toBe(
			key,
		);
		expect(
			reviewerKey({ lens: "b", promptSha256: PROMPT, model: SOL }),
		).not.toBe(key);
		expect(
			reviewerKey({
				lens: "a",
				promptSha256: PROMPT,
				model: { ...SOL, thinking: "high" },
			}),
		).not.toBe(key);
		expect(
			reviewerKey({
				lens: "a",
				promptSha256: promptDigest({ goal: "g" }),
				model: SOL,
			}),
		).not.toBe(key);
	});

	it("records dispositions and counts them, declines included", () => {
		const answered = withDispositions(record, [
			{ id: "c1", kind: "fixed", reasoning: "Done." },
			{ id: "c2", kind: "declined", reasoning: "Intended behaviour." },
		]);
		expect(Value.Check(ReviewsRecordSchema, answered)).toBe(true);
		expect(answered.clusters[1]?.disposition).toEqual({
			kind: "declined",
			reasoning: "Intended behaviour.",
		});
		expect(reviewCounts(answered)).toEqual({
			reviewers: 2,
			reported: 1,
			clusters: 2,
			agreed: 0,
			fixed: 1,
			declined: 1,
			outOfScope: 0,
			unanswered: 0,
		});
		expect(reviewCounts(record).unanswered).toBe(2);
	});
});
