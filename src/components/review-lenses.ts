import type { ExactModelRequest } from "@vegardx/pi-subagent";
import type { TaskKey } from "../contracts-core.js";
import type {
	AgentTaskAuthoringRequest,
	TaskInputHandle,
	WorkflowContext,
	WorkspaceAuthoringRequest,
} from "../definition.js";
import { isHandoffHandle } from "../definition.js";
import { WorkflowComponentError } from "./errors.js";
import {
	MAX_REVIEW_LENSES,
	type ResolvedReviewLens,
	type ReviewLens,
	resolveReviewKeys,
} from "./review-fan-out.js";
import {
	type LensReport,
	LensReportSchema,
	promptDigest,
	type ReviewerInput,
} from "./review-record.js";
import { startAtHandoff } from "./workspace.js";

/**
 * `reviewLenses` — one read-only reviewer per lens over one hand-off, each
 * reporting `LensReportSchema`, and the settled outcomes as the
 * `ReviewerInput`s the review record is built from.
 *
 * Pattern: `skills/workflow-authoring/SKILL.md` § "Reviewers report, the
 * harness clusters, the implementer answers".
 *
 * Lowering, and nothing else:
 *
 * ```text
 * ctx.fanOut(ns, lenses, { key, task })   one read-only agent per lens at the
 *                                          subject's hand-off, "optional"
 * await ctx.settled(reviewers)             one barrier
 * ```
 *
 * Keys are `reviewFanOut`'s: the lens id, `-2`, `-3`, … by declaration
 * ordinal. Every lens must resolve to an EXACT model — the lens's pin, else
 * the caller's — because the record names the model a finding came from and
 * the component will not write a model it cannot name. Attribution is stamped
 * from what was declared and from the journal (`SettledTaskResult.attempt`),
 * never from what a reviewer wrote. A lens that failed is a `ReviewerInput`
 * with no report: it subtracts coverage and blocks nothing.
 */

/** The reviewer declaration a caller owns: prose, tools, workspace. */
export type LensTaskRequest = Omit<
	AgentTaskAuthoringRequest<typeof LensReportSchema, WorkspaceAuthoringRequest>,
	"outputSchema" | "disposition" | "model"
>;

export interface ReviewLensesOptions {
	/** The hand-off and the artifacts every lens reads; exactly one hand-off. */
	readonly subject: Readonly<Record<TaskKey, TaskInputHandle>>;
	readonly review: (lens: ResolvedReviewLens) => LensTaskRequest;
	/** The model of a lens that pins none. */
	readonly model?: ExactModelRequest;
}

export interface ReviewLensesResult {
	readonly lenses: readonly ResolvedReviewLens[];
	/** One per lens, in declaration order. */
	readonly reviewers: readonly ReviewerInput[];
}

function refuse(message: string): never {
	throw new WorkflowComponentError("reviewLenses", message);
}

export async function reviewLenses(
	ctx: Pick<WorkflowContext<unknown>, "fanOut" | "settled">,
	namespace: TaskKey,
	lenses: readonly ReviewLens[],
	options: ReviewLensesOptions,
): Promise<ReviewLensesResult> {
	if (typeof namespace !== "string" || !/^[a-z][a-z0-9-]*$/.test(namespace)) {
		refuse(
			`reviewLenses namespace ${JSON.stringify(namespace)} must match ^[a-z][a-z0-9-]*$.`,
		);
	}
	if (!Array.isArray(lenses) || lenses.length > MAX_REVIEW_LENSES) {
		refuse(
			`reviewLenses("${namespace}") takes an array of at most ${MAX_REVIEW_LENSES} lenses.`,
		);
	}
	if (typeof options?.review !== "function" || !options.subject) {
		refuse(
			`reviewLenses("${namespace}") requires a \`subject\` and a \`review\` function.`,
		);
	}
	const handoffs = Object.entries(options.subject)
		.filter(([, handle]) => isHandoffHandle(handle))
		.map(([name]) => name as TaskKey);
	const handoff = handoffs[0];
	if (handoffs.length !== 1 || handoff === undefined) {
		refuse(
			`reviewLenses("${namespace}") subject carries ${handoffs.length} hand-offs; a review reads exactly one tree.`,
		);
	}
	const keys = resolveReviewKeys(namespace, lenses);
	const resolved: ResolvedReviewLens[] = lenses.map((lens, ordinal) => {
		const model = lens.model ?? options.model;
		if (model === undefined) {
			refuse(
				`reviewLenses("${namespace}") lens ${JSON.stringify(lens.id)} resolves to no exact model; pin one on the lens or pass \`model\`, because the record names the model behind every finding.`,
			);
		}
		return Object.freeze({
			lens,
			ordinal,
			key: keys[ordinal] as TaskKey,
			model,
			diverseStandIn: false,
		});
	});
	const requests = resolved.map((entry) => {
		const request = options.review(entry);
		if (request === null || typeof request !== "object") {
			refuse(
				`reviewLenses("${namespace}") lens ${JSON.stringify(entry.key)} is not a declaration.`,
			);
		}
		if (request.workspace?.mode !== "read-only") {
			refuse(
				`reviewLenses("${namespace}") lens ${JSON.stringify(entry.key)} must review read-only; declare { mode: "read-only", cwd }.`,
			);
		}
		for (const name of Object.keys(request.inputs ?? {})) {
			if (Object.hasOwn(options.subject, name)) {
				refuse(
					`reviewLenses("${namespace}") lens ${JSON.stringify(entry.key)} declares the input ${JSON.stringify(name)}, which the subject already provides.`,
				);
			}
		}
		return {
			...request,
			workspace: startAtHandoff(
				"reviewLenses",
				`reviewLenses("${namespace}") lens ${JSON.stringify(entry.key)}`,
				request.workspace,
				handoff,
			),
			model: entry.model as ExactModelRequest,
			outputSchema: LensReportSchema,
			disposition: "optional" as const,
			inputs: { ...(request.inputs ?? {}), ...options.subject },
		} satisfies AgentTaskAuthoringRequest<
			typeof LensReportSchema,
			WorkspaceAuthoringRequest
		>;
	});
	const handles =
		resolved.length === 0
			? []
			: ctx.fanOut(namespace, resolved, {
					key: (entry) => entry.key,
					task: (_entry, index) =>
						requests[index] as AgentTaskAuthoringRequest<
							typeof LensReportSchema,
							WorkspaceAuthoringRequest
						>,
				});
	const settled = handles.length === 0 ? [] : await ctx.settled(handles);
	const reviewers: ReviewerInput[] = resolved.map((entry, index) => {
		const outcome = settled[index];
		const request = requests[index];
		const attemptId = outcome?.attempt?.subagentAttemptId;
		return Object.freeze({
			lens: entry.key,
			model: entry.model as ExactModelRequest,
			promptSha256: promptDigest(
				request?.task ?? { goal: "", context: [], instructions: [] },
			),
			...(attemptId === undefined ? {} : { attemptId }),
			...(outcome?.status === "fulfilled"
				? { report: outcome.value as LensReport }
				: {}),
		});
	});
	return Object.freeze({
		lenses: Object.freeze(resolved),
		reviewers: Object.freeze(reviewers),
	});
}
