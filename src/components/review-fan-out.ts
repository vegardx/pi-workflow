import type { ExactModelRequest } from "@vegardx/pi-subagent";
import type { Static } from "typebox";
import type { TaskDisposition, TaskKey } from "../contracts-core.js";
import type {
	AgentTaskAuthoringRequest,
	SettledTaskFailure,
	TaskHandle,
	TaskInputHandle,
	WorkflowContext,
	WorkspaceAuthoringRequest,
} from "../definition.js";
import { WorkflowComponentError } from "./errors.js";
import {
	type Finding,
	mergeReviewReports,
	type ReportedReview,
	type ReviewCoverageEntry,
	ReviewReportSchema,
	type ReviewSynthesis,
	ReviewSynthesisSchema,
	type ReviewVerdict,
} from "./finding.js";

/**
 * `reviewFanOut` — one read-only reviewer per lens over one reviewed subject,
 * a deterministic merge of what came back, and an optional synthesis reducer.
 *
 * Pattern: `skills/workflow-authoring/SKILL.md` § "Review fan-out with lens
 * diversity and a degrading synthesis". The rules it encodes live under "Keys,
 * namespaces, and handles", "`after` versus `inputs`" and "Failure semantics
 * for authors".
 *
 * Lowering, and nothing else:
 *
 * ```text
 * ctx.fanOut(ns, lenses, { key, task })   one read-only agent per lens,
 *                                          disposition "optional"
 * await ctx.settled(reviewers)             one barrier, per-lens outcomes
 * ctx.fanIn(`${ns}-synthesis`, reported)   only when a synthesis is asked for
 *                                          AND at least one lens reported
 * ```
 *
 * ## Keys
 *
 * `key = lens.id`. A lens id repeated in the list takes `-2`, `-3`, … **by
 * declaration ordinal** — never by a counter over runtime data — so the keys
 * of a lens list are a pure function of that list, and reordering distinct
 * lenses moves the tasks without renaming any of them. A suffix that would
 * collide with an id the caller also declared is refused rather than resolved.
 *
 * ## The optional-reviewer rule this component exists to encode
 *
 * Reviewers are declared `disposition: "optional"`, so one flaky lens does not
 * fail an approved implementation. But **a data dependency on a failed
 * optional task blocks its dependents** (`plan-to-ship.workflow.ts` states the
 * same limitation): naming a dead reviewer's output in a downstream task's
 * `inputs` would park the very gate the review was meant to inform. Therefore
 * this component:
 *
 * - reads outcomes through `ctx.settled`, never `ctx.results`;
 * - computes the verdict and the findings from the lenses that **reported**,
 *   on a deterministic rail (`mergeReviewReports`), so a missing reviewer
 *   subtracts coverage rather than blocking the run;
 * - builds the synthesis reducer's `inputs` from the reporting reviewers only;
 * - returns `coverage`, so the caller can show "3 of 4 lenses reported"
 *   instead of quietly presenting a thinner review as a complete one.
 *
 * A caller that puts a review handle into a checkpoint's `inputs` must apply
 * the same rule: only a lens whose `reported` is true may be named there.
 *
 * ## Diversity
 *
 * `lens.diverse` asks for a reviewer of a different model family. The routing
 * port now exists (`ModelRoutingPort`, `runtime/model-routing.ts`), but this
 * component has not been moved onto it, so today that is still expressed as
 * the exact `model` the caller supplies through `diversity` — the stand-in the
 * library ships is `envelope.ts`'s `DIVERSE_MODEL_ID` — and the component
 * logs once that the answer is a stand-in. DELETE THE SEAM: `diversity`
 * becomes `modelRole: { family: "other" }` and the resolution moves behind
 * `ModelRoutingPort`, which a host installs as
 * `WorkflowServiceOptions.modelRouting`. A `diverse` lens with neither a pinned
 * `model` nor a configured seam is refused at declaration — the component
 * never silently reviews with the same model twice and calls it diverse.
 */

/** Both builtin review workflows bound their lens list at 16. */
export const MAX_REVIEW_LENSES = 16;
const TASK_KEY_RE = /^[a-z][a-z0-9-]*$/;

export type ReviewTier = "light" | "standard" | "heavy";

export interface ReviewLens {
	/** The lens's stable id; becomes its task key inside the namespace. */
	readonly id: string;
	/**
	 * How much reviewer to spend. The component carries it to the `review`
	 * factory, which resolves it through the caller's effort table (`envelope`);
	 * it never picks a model from a tier itself, because that table is keyed by
	 * `ctx.input` and belongs to the workflow. The routing port will read this
	 * field directly as `modelRole.tier`.
	 */
	readonly tier?: ReviewTier;
	/** Ask for a reviewer of another model family; see `diversity`. */
	readonly diverse?: boolean;
	/** A skill name for the reviewer; carried to the `review` factory. */
	readonly skill?: string;
	/** An exact pin. It outranks both `diverse` and the caller's default. */
	readonly model?: ExactModelRequest;
	/** A one-line brief for this lens; carried to the `review` factory. */
	readonly brief?: string;
}

export interface ResolvedReviewLens {
	readonly lens: ReviewLens;
	/** 0-based declaration ordinal; the only ordering input to a key. */
	readonly ordinal: number;
	/** `lens.id`, or `lens.id-2`, `lens.id-3`, … by declaration ordinal. */
	readonly key: TaskKey;
	/** The resolved model: the lens's pin, else the seam, else the default. */
	readonly model?: ExactModelRequest;
	/** True when `model` came from the diversity stand-in rather than routing. */
	readonly diverseStandIn: boolean;
}

/** What is under review, and the handles that carry it to every lens. */
export interface ReviewSubject {
	readonly title: string;
	/**
	 * The artifact each reviewer reads, as `inputs`: typically an implementer's
	 * result handle and its worktree `handoff` handle, which delivers the
	 * patch's identity and never its bytes.
	 */
	readonly inputs?: Readonly<Record<TaskKey, TaskInputHandle>>;
}

/** The seam the routing port replaces. */
export interface ReviewDiversitySeam {
	/** The "other family" model a `diverse` lens resolves to today. */
	readonly model: ExactModelRequest;
	/** Logged once with the stand-in disclosure; a default is used when absent. */
	readonly note?: string;
}

/** The reviewer declaration a caller owns: prose, tools, limits. */
export type ReviewTaskRequest = Omit<
	AgentTaskAuthoringRequest<
		typeof ReviewReportSchema,
		WorkspaceAuthoringRequest
	>,
	"outputSchema" | "disposition"
>;

/** The synthesis declaration a caller owns; `ctx.fanIn` owns its `inputs`. */
export type ReviewSynthesisTaskRequest = Omit<
	AgentTaskAuthoringRequest<
		typeof ReviewSynthesisSchema,
		WorkspaceAuthoringRequest
	>,
	"outputSchema" | "inputs"
>;

export interface ReviewOutcome {
	readonly lens: ResolvedReviewLens;
	readonly reported: boolean;
	readonly review?: Static<typeof ReviewReportSchema>;
	readonly failure?: SettledTaskFailure;
}

/** What the caller needs to write the synthesis prose; all of it is data. */
export interface ReviewSynthesisBrief {
	readonly verdict: ReviewVerdict;
	readonly findings: readonly Finding[];
	readonly coverage: readonly ReviewCoverageEntry[];
	readonly reviews: readonly ReportedReview[];
}

export interface ReviewFanOutOptions {
	readonly subject: ReviewSubject;
	/** The reviewer declaration for one lens. */
	readonly review: (lens: ResolvedReviewLens) => ReviewTaskRequest;
	/** The model of a lens that pins none and asks for no diversity. */
	readonly model?: ExactModelRequest;
	readonly diversity?: ReviewDiversitySeam;
	/** "optional" (default) declares a reducer only when a lens reported. */
	readonly synthesis?: "required" | "optional" | "none";
	readonly synthesize?: (
		brief: ReviewSynthesisBrief,
	) => ReviewSynthesisTaskRequest;
	/** Reviewer disposition; "optional" by default, and for a reason. */
	readonly disposition?: TaskDisposition;
	/** Cap on merged findings; 64 by default. */
	readonly maxFindings?: number;
}

export interface ReviewFanOutResult {
	readonly lenses: readonly ResolvedReviewLens[];
	readonly reviews: readonly ReviewOutcome[];
	readonly coverage: readonly ReviewCoverageEntry[];
	readonly verdict: ReviewVerdict;
	readonly findings: readonly Finding[];
	/** The reducer's handle, when one was declared. Await it if you need it. */
	readonly synthesis?: TaskHandle<ReviewSynthesis>;
}

/**
 * `id`, `id-2`, `id-3`, … by declaration ordinal, refusing a suffix that
 * collides with an id the caller declared as well.
 */
export function resolveReviewKeys(
	namespace: string,
	lenses: readonly ReviewLens[],
): readonly TaskKey[] {
	const declared = new Set<string>();
	for (const lens of lenses) declared.add(lens.id);
	const seen = new Map<string, number>();
	const taken = new Set<string>();
	return Object.freeze(
		lenses.map((lens, ordinal) => {
			if (
				typeof lens?.id !== "string" ||
				lens.id.length > 128 ||
				!TASK_KEY_RE.test(lens.id)
			) {
				throw new WorkflowComponentError(
					"reviewFanOut",
					`reviewFanOut("${namespace}") got the invalid lens id ${JSON.stringify(lens?.id)} at ordinal ${ordinal}; a lens id must match ^[a-z][a-z0-9-]*$.`,
				);
			}
			const count = (seen.get(lens.id) ?? 0) + 1;
			seen.set(lens.id, count);
			const key = count === 1 ? lens.id : `${lens.id}-${count}`;
			if (taken.has(key) || (count > 1 && declared.has(key))) {
				throw new WorkflowComponentError(
					"reviewFanOut",
					`reviewFanOut("${namespace}") lens ${JSON.stringify(lens.id)} de-duplicates to ${JSON.stringify(key)}, which another lens already claims; rename the lens.`,
				);
			}
			taken.add(key);
			return key as TaskKey;
		}),
	);
}

function resolveModel(
	namespace: string,
	lens: ReviewLens,
	options: ReviewFanOutOptions,
): { model?: ExactModelRequest; diverseStandIn: boolean } {
	if (lens.model) return { model: lens.model, diverseStandIn: false };
	if (lens.diverse === true) {
		if (!options.diversity) {
			throw new WorkflowComponentError(
				"reviewFanOut",
				`reviewFanOut("${namespace}") lens ${JSON.stringify(lens.id)} asks for another model family, but no diverse model is configured; pin an exact \`model\` on the lens or pass \`diversity\`.`,
			);
		}
		return { model: options.diversity.model, diverseStandIn: true };
	}
	return options.model === undefined
		? { diverseStandIn: false }
		: { model: options.model, diverseStandIn: false };
}

export async function reviewFanOut(
	ctx: WorkflowContext<unknown>,
	namespace: TaskKey,
	lenses: readonly ReviewLens[],
	options: ReviewFanOutOptions,
): Promise<ReviewFanOutResult> {
	if (typeof namespace !== "string" || !TASK_KEY_RE.test(namespace)) {
		throw new WorkflowComponentError(
			"reviewFanOut",
			`reviewFanOut namespace ${JSON.stringify(namespace)} must match ^[a-z][a-z0-9-]*$.`,
		);
	}
	if (!Array.isArray(lenses)) {
		throw new WorkflowComponentError(
			"reviewFanOut",
			`reviewFanOut("${namespace}") requires an array of lenses.`,
		);
	}
	if (typeof options?.review !== "function" || !options?.subject) {
		throw new WorkflowComponentError(
			"reviewFanOut",
			`reviewFanOut("${namespace}") requires a \`subject\` and a \`review\` function.`,
		);
	}
	if (lenses.length > MAX_REVIEW_LENSES) {
		throw new WorkflowComponentError(
			"reviewFanOut",
			`reviewFanOut("${namespace}") declares ${lenses.length} lenses; at most ${MAX_REVIEW_LENSES} are allowed.`,
		);
	}
	const synthesis = options.synthesis ?? "optional";
	if (synthesis !== "none" && typeof options.synthesize !== "function") {
		throw new WorkflowComponentError(
			"reviewFanOut",
			`reviewFanOut("${namespace}") asks for a ${synthesis} synthesis but declares no \`synthesize\` function.`,
		);
	}

	const keys = resolveReviewKeys(namespace, lenses);
	const resolved: ResolvedReviewLens[] = lenses.map((lens, ordinal) => {
		const model = resolveModel(namespace, lens, options);
		return Object.freeze({
			lens,
			ordinal,
			key: keys[ordinal] as TaskKey,
			...(model.model === undefined ? {} : { model: model.model }),
			diverseStandIn: model.diverseStandIn,
		});
	});

	const subjectInputs = options.subject.inputs ?? {};
	const requests = resolved.map((entry) => {
		const request = options.review(entry);
		if (request === null || typeof request !== "object") {
			throw new WorkflowComponentError(
				"reviewFanOut",
				`reviewFanOut("${namespace}") lens ${JSON.stringify(entry.key)} is not a declaration.`,
			);
		}
		if (request.workspace?.mode !== "read-only") {
			throw new WorkflowComponentError(
				"reviewFanOut",
				`reviewFanOut("${namespace}") lens ${JSON.stringify(entry.key)} must review read-only; declare { mode: "read-only", cwd }.`,
			);
		}
		for (const name of Object.keys(request.inputs ?? {})) {
			if (Object.hasOwn(subjectInputs, name)) {
				throw new WorkflowComponentError(
					"reviewFanOut",
					`reviewFanOut("${namespace}") lens ${JSON.stringify(entry.key)} declares the input ${JSON.stringify(name)}, which the reviewed subject already provides.`,
				);
			}
		}
		return {
			...request,
			...(entry.model === undefined ? {} : { model: entry.model }),
			outputSchema: ReviewReportSchema,
			disposition: options.disposition ?? "optional",
			inputs: { ...(request.inputs ?? {}), ...subjectInputs },
		} satisfies AgentTaskAuthoringRequest<
			typeof ReviewReportSchema,
			WorkspaceAuthoringRequest
		>;
	});

	const standIns = resolved.filter((entry) => entry.diverseStandIn).length;
	if (standIns > 0) {
		ctx.log(
			options.diversity?.note ??
				`reviewFanOut("${namespace}"): ${standIns} lens(es) resolve a different model family through a configured stand-in; model routing is not installed yet.`,
		);
	}

	const reviewers =
		resolved.length === 0
			? []
			: ctx.fanOut(namespace, resolved, {
					key: (entry) => entry.key,
					task: (_entry, index) =>
						requests[index] as AgentTaskAuthoringRequest<
							typeof ReviewReportSchema,
							WorkspaceAuthoringRequest
						>,
				});

	// The barrier. Everything below reads settled outcomes, so a lens that
	// failed subtracts coverage instead of blocking what comes next.
	const settled = reviewers.length === 0 ? [] : await ctx.settled(reviewers);
	const outcomes: ReviewOutcome[] = resolved.map((entry, index) => {
		const outcome = settled[index];
		if (outcome?.status === "fulfilled") {
			return Object.freeze({
				lens: entry,
				reported: true,
				review: outcome.value,
			});
		}
		return Object.freeze({
			lens: entry,
			reported: false,
			...(outcome?.status === "rejected" && outcome.failure
				? { failure: outcome.failure }
				: {}),
		});
	});

	const reported: ReportedReview[] = outcomes.flatMap((outcome) =>
		outcome.review
			? [
					{
						lens: outcome.lens.key,
						ordinal: outcome.lens.ordinal,
						report: outcome.review,
					},
				]
			: [],
	);
	const merged = mergeReviewReports(reported, {
		...(options.maxFindings === undefined ? {} : { max: options.maxFindings }),
	});
	const coverage: readonly ReviewCoverageEntry[] = Object.freeze(
		outcomes.map((outcome) =>
			Object.freeze({
				lens: outcome.lens.key,
				reported: outcome.reported,
				...(outcome.review ? { verdict: outcome.review.verdict } : {}),
			}),
		),
	);

	let synthesisHandle: TaskHandle<ReviewSynthesis> | undefined;
	if (synthesis !== "none" && options.synthesize) {
		const sources = outcomes.flatMap((outcome, index) =>
			outcome.reported && reviewers[index] ? [{ outcome, index }] : [],
		);
		if (sources.length === 0) {
			if (synthesis === "required") {
				throw new WorkflowComponentError(
					"reviewFanOut",
					`reviewFanOut("${namespace}") requires a synthesis, but no lens reported.`,
				);
			}
		} else {
			const request = options.synthesize({
				verdict: merged.verdict,
				findings: merged.findings,
				coverage,
				reviews: reported,
			});
			if (request === null || typeof request !== "object") {
				throw new WorkflowComponentError(
					"reviewFanOut",
					`reviewFanOut("${namespace}") synthesis is not a declaration.`,
				);
			}
			if (Object.hasOwn(request, "inputs")) {
				throw new WorkflowComponentError(
					"reviewFanOut",
					`reviewFanOut("${namespace}") synthesis may not declare \`inputs\`; the reporting lenses are its inputs.`,
				);
			}
			synthesisHandle = ctx.fanIn(
				`${namespace}-synthesis` as TaskKey,
				sources.map(
					(source) =>
						reviewers[source.index] as TaskHandle<
							Static<typeof ReviewReportSchema>
						>,
				),
				{
					inputKey: (_source, index) =>
						sources[index]?.outcome.lens.key as TaskKey,
					task: { ...request, outputSchema: ReviewSynthesisSchema },
				},
			) as TaskHandle<ReviewSynthesis>;
		}
	}

	return Object.freeze({
		lenses: Object.freeze(resolved),
		reviews: Object.freeze(outcomes),
		coverage,
		verdict: merged.verdict,
		findings: merged.findings,
		...(synthesisHandle === undefined ? {} : { synthesis: synthesisHandle }),
	});
}
