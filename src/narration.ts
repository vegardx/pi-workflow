/**
 * What a host needs to NARRATE a run: the derivation behind `narration` on a
 * projected task view and on a run observation.
 *
 * A host — pi-maestro is the one this exists for — watches a run it started and
 * posts each task completion into the person's conversation, then gives the
 * model a turn on the interesting ones: a synthesis result, a fix report, a
 * failure, the ship gate. To do that from the outside it needs four things per
 * completed task that the durable facts alone do not spell out:
 *
 * - **the stage key**, as one string (`${namespace}/${key}`), because that is
 *   what a definition's documentation names and what a person can be shown;
 * - **the task kind**, in a vocabulary a narrator can branch on, not in the
 *   runtime's four execution kinds (`agent | support | workflow | checkpoint`),
 *   which say nothing about what the task was for;
 * - **the deliverable**, when the stage key names one;
 * - **a short human summary**, and for a failure **a sanitized cause**.
 *
 * ## This is a VIEW, and it is derived from the key alone
 *
 * Nothing here is persisted, nothing here is authored, and no definition
 * declares it. `taskNarration` is a pure function of `(namespace, key, kind)`,
 * so it costs a run nothing and cannot drift from what a run recorded: the
 * runtime still knows only tasks and keys.
 *
 * The vocabulary is therefore a CONVENTION over stage keys, and it is the
 * convention `workflows/plan-to-ship.workflow.ts` documents: a stage key is
 * `<stage id>-<deliverable id>`, and a fan-out member is
 * `<stage id>-<deliverable id>/<member>`. A leading segment this module knows
 * (`implement`, `check`, `review`, `synthesis`, `fix`, `refine`) names the kind
 * and the rest of that segment names the deliverable; a checkpoint is `gate`
 * whatever it is called; anything else is `other`, which is an honest answer
 * and not a failure. A project definition that names its tasks differently gets
 * `other` and its own key, which is exactly as much as this package can
 * truthfully say about it.
 *
 * The alternative — a `narration` block a definition authors — would put plan
 * vocabulary into the persisted task spec and into task identity, for a string
 * a reader could have derived. `docs/authority.md` and `AGENTS.md` both say the
 * runtime carries no plan policy; a derivation carries none either.
 */

import type { TaskExecutionOutcome, WorkflowTaskStatus } from "./contracts.js";

/**
 * The kinds a narrator branches on. `other` is the honest answer for a task
 * whose key this convention does not name, never an error.
 */
export const NARRATED_TASK_KINDS = Object.freeze([
	"implement",
	"check",
	"review",
	"synthesis",
	"fix",
	"gate",
	"refine",
	"other",
] as const);
export type NarratedTaskKind = (typeof NARRATED_TASK_KINDS)[number];

/**
 * The stage ids this convention knows, mapped to the kind they narrate as.
 * The left column is `plan-to-ship`'s documented stage id list; a definition
 * that reuses one of these ids gets the same narration, which is the point.
 */
const KIND_BY_STAGE_ID: Readonly<Record<string, NarratedTaskKind>> =
	Object.freeze({
		implement: "implement",
		check: "check",
		review: "review",
		synthesis: "synthesis",
		fix: "fix",
		refine: "refine",
	});

/** The longest summary a narration carries; one paragraph, never a report. */
export const MAX_NARRATION_SUMMARY_LENGTH = 1024;

export interface TaskNarration {
	/** `${namespace.join("/")}/${key}`: the stage key, as one string. */
	readonly stage: string;
	readonly taskKind: NarratedTaskKind;
	/** The deliverable the stage key names, when it names one. */
	readonly deliverable?: string;
	/** The agent's own summary, or a bounded rendering of its result. */
	readonly summary?: string;
	/** For a task that did not complete: why, in a sanitized sentence. */
	readonly cause?: string;
}

const DELIVERABLE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The kind and the deliverable a stage key names.
 *
 * The first segment of the path is the stage key; a fan-out member's own key
 * (`review-d0/correctness`) narrates as its namespace's kind, because a lens is
 * a review. Splitting `<stage id>-<deliverable id>` takes the SHORTEST leading
 * run that is a known stage id, so `check-d0` is `check` of `d0` and
 * `fix-my-thing` is `fix` of `my-thing`. A key that is exactly a known stage id
 * (`refine`) names no deliverable.
 */
function classify(stage: string): {
	kind: NarratedTaskKind;
	deliverable?: string;
} {
	const known = KIND_BY_STAGE_ID[stage];
	if (known) return { kind: known };
	// Walk the split points left to right, so the SHORTEST known stage id wins
	// and a stage id with a hyphen in it is still found before giving up.
	for (
		let cut = stage.indexOf("-");
		cut > 0;
		cut = stage.indexOf("-", cut + 1)
	) {
		const kind = KIND_BY_STAGE_ID[stage.slice(0, cut)];
		const tail = stage.slice(cut + 1);
		if (kind && DELIVERABLE_ID_RE.test(tail)) {
			return { kind, deliverable: tail };
		}
	}
	return { kind: "other" };
}

export interface TaskNarrationInput {
	readonly namespace: readonly string[];
	readonly key: string;
	/** The runtime's execution kind; a checkpoint always narrates as `gate`. */
	readonly kind: "agent" | "support" | "workflow" | "checkpoint";
	readonly summary?: string;
	readonly cause?: string;
}

/**
 * The narration of one task. Pure: the same `(namespace, key, kind)` always
 * answers the same way, and nothing is read.
 */
export function taskNarration(task: TaskNarrationInput): TaskNarration {
	const stage = [...task.namespace, task.key].join("/");
	const root = task.namespace[0] ?? task.key;
	const classified =
		task.kind === "checkpoint" ? { kind: "gate" as const } : classify(root);
	return Object.freeze({
		stage,
		taskKind: classified.kind,
		...("deliverable" in classified && classified.deliverable !== undefined
			? { deliverable: classified.deliverable }
			: {}),
		...(task.summary === undefined ? {} : { summary: task.summary }),
		...(task.cause === undefined ? {} : { cause: task.cause }),
	});
}

/** One line, whitespace collapsed, cut to the narration bound. */
function oneLine(text: string): string {
	const collapsed = text.replace(/\s+/gu, " ").trim();
	return collapsed.length <= MAX_NARRATION_SUMMARY_LENGTH
		? collapsed
		: `${collapsed.slice(0, MAX_NARRATION_SUMMARY_LENGTH - 1)}…`;
}

/** The string fields a result may carry its own summary in, most specific first. */
const SUMMARY_FIELDS = Object.freeze([
	"summary",
	"verdict",
	"answer",
	"synthesis",
] as const);

/**
 * A bounded human summary of one task's committed result.
 *
 * The agent's own words win: a result with a `summary` (the shape every
 * implementer, verifier and refiner in this package's builtins reports) is
 * summarized by it, and a reducer's `verdict`, `answer` or `synthesis` is the
 * same thing under another name. Anything else is rendered — a compact
 * one-line JSON of the value, with array lengths in place of long arrays — so a
 * structured result a narrator has never seen still reads as something rather
 * than as nothing.
 *
 * Returns `undefined` for a value with no readable content, so a view carries
 * no empty field.
 */
export function narrationSummary(value: unknown): string | undefined {
	if (typeof value === "string") {
		const line = oneLine(value);
		return line.length > 0 ? line : undefined;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (value === null || typeof value !== "object") return undefined;
	if (Array.isArray(value)) {
		return value.length === 0 ? undefined : oneLine(render(value));
	}
	const record = value as Record<string, unknown>;
	for (const field of SUMMARY_FIELDS) {
		const candidate = record[field];
		if (typeof candidate === "string" && candidate.trim().length > 0) {
			return oneLine(candidate);
		}
	}
	const rendered = render(record);
	// `{}` is a shape, not a summary: a view carries no field rather than a
	// sentence that says nothing.
	return rendered.length > 0 && rendered !== "{}"
		? oneLine(rendered)
		: undefined;
}

/** `{a: 1, items: [3 items]}` — structure and scale, never the whole value. */
function render(value: unknown, depth = 0): string {
	if (value === null) return "null";
	if (typeof value === "string") {
		return JSON.stringify(
			value.length > 120 ? `${value.slice(0, 119)}…` : value,
		);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		if (depth >= 1) return `[${value.length} item(s)]`;
		return value.length > 3
			? `[${value.length} item(s)]`
			: `[${value.map((item) => render(item, depth + 1)).join(", ")}]`;
	}
	if (typeof value !== "object") return "";
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length === 0) return "{}";
	if (depth >= 2) return `{${entries.length} field(s)}`;
	return `{${entries
		.slice(0, 8)
		.map(([name, item]) => `${name}: ${render(item, depth + 1)}`)
		.join(", ")}${entries.length > 8 ? ", …" : ""}}`;
}

/** True when the task reached a terminal status a narrator reports. */
export function isNarratedTerminalStatus(status: WorkflowTaskStatus): boolean {
	return (
		status === "completed" ||
		status === "failed" ||
		status === "cancelled" ||
		status === "interrupted" ||
		status === "invalidated" ||
		status === "blocked" ||
		status === "cleanup-blocked"
	);
}

/** True when the execution outcome is one a narrator calls a failure. */
export function isNarratedFailure(
	outcome: TaskExecutionOutcome | undefined,
): boolean {
	return outcome !== undefined && outcome !== "completed";
}
