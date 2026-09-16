import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { WorkflowRunId, WorkflowTaskId } from "../contracts.js";
import {
	DYNAMIC_REF_PATTERN,
	DYNAMIC_REF_PREFIX,
} from "../dynamic/constants.js";
import type { DynamicSourceApprover } from "../dynamic/contracts.js";
import {
	IMPLEMENTED_WORKFLOW_RUN_ACTIONS,
	WORKFLOW_RUN_ACTIONS,
	type WorkflowRunAction,
} from "../run-actions.js";
import type {
	DynamicWorkflowProposalView,
	WorkflowService,
} from "../service.js";
import type {
	WorkflowInvalidationPreview,
	WorkflowLogEntry,
	WorkflowLogPage,
	WorkflowRunSummary,
	WorkflowServiceTaskView,
} from "../service-views.js";
import { normalizeTaskKey, taskPath } from "./format.js";

/**
 * Pure grammar, resolution, and action dispatch for the `/workflow` command.
 * Nothing here touches a terminal or an extension context, and nothing here
 * decides whether an action is legal: legality is read from
 * `WorkflowRunSummary.availableActions`, which the service owns.
 */

export const WORKFLOW_COMMAND = "workflow";

/**
 * Run actions the grammar offers: every action implemented by this build
 * except `wait` (its own subcommand). Deriving the list from the implemented
 * set means the grammar can never advertise a service method that does not
 * exist. `decide` is a human authority act: it is a command and never a tool.
 */
export const WORKFLOW_ACTION_SUBCOMMANDS: readonly WorkflowRunAction[] =
	Object.freeze(
		WORKFLOW_RUN_ACTIONS.filter(
			(action) =>
				IMPLEMENTED_WORKFLOW_RUN_ACTIONS.has(action) && action !== "wait",
		),
	);

/** Definition-level human decisions about proposed dynamic sources. */
export const SOURCE_DECISION_SUBCOMMANDS = Object.freeze([
	"approve",
	"reject",
] as const);
export type SourceDecisionKind = (typeof SOURCE_DECISION_SUBCOMMANDS)[number];

export const WORKFLOW_SUBCOMMANDS: readonly string[] = Object.freeze([
	"list",
	"runs",
	"validate",
	"run",
	...SOURCE_DECISION_SUBCOMMANDS,
	"show",
	"status",
	"logs",
	"wait",
	...WORKFLOW_ACTION_SUBCOMMANDS,
]);

/** Subcommands whose second token is a run id prefix. */
const RUN_SUBCOMMANDS: ReadonlySet<string> = new Set([
	"show",
	"status",
	"logs",
	"wait",
	...WORKFLOW_ACTION_SUBCOMMANDS,
]);

export const DEFAULT_LOG_TAIL = 20;
export const MIN_LOG_TAIL = 1;
export const MAX_LOG_TAIL = 500;
export const MIN_WAIT_TIMEOUT_MS = 1_000;
export const MAX_WAIT_TIMEOUT_MS = 3_600_000;

export const DEFAULT_STOP_REASON = "Stopped by operator.";
export const DEFAULT_INVALIDATE_REASON = "Invalidated by operator.";
export const DEFAULT_RETRY_REASON = "Retried by operator.";
export const DEFAULT_RESUME_REASON = "Resumed by operator.";
/**
 * The checkpoint approver when the pinned Pi extension API exposes no user
 * identity; never taken from command arguments or a model.
 */
export const DEFAULT_DECIDE_APPROVER = "pi-session";
export const CHECKPOINT_DECISION_INVALID_JSON_MESSAGE =
	"Checkpoint decision is not valid JSON.";
export const DYNAMIC_REF_USAGE_MESSAGE =
	"Dynamic workflow reference must be dynamic:<64 hex characters>.";
export const SOURCE_DECISION_REQUIRES_UI_MESSAGE =
	"Dynamic workflow approval requires an interactive Pi session.";
export const CHECKPOINT_DECISION_REQUIRES_UI_MESSAGE =
	"Checkpoint decisions require an interactive Pi session.";
export const SOURCE_DECISION_CANCELLED_MESSAGE = "No decision recorded.";

export type ParsedWorkflowCommand =
	| { kind: "inspector" }
	| { kind: "list" }
	| { kind: "runs"; includeChildren: boolean }
	| { kind: "validate"; ref: string; input?: unknown }
	| { kind: "run"; ref: string; input?: unknown }
	| { kind: "show"; runPrefix: string }
	| { kind: "logs"; runPrefix: string; tail: number }
	| { kind: "wait"; runPrefix: string; timeoutMs?: number }
	| { kind: "stop"; runPrefix: string; reason?: string }
	| { kind: "reconcile"; runPrefix: string; taskKey?: string }
	| { kind: "invalidate"; runPrefix: string; taskKey: string; reason?: string }
	| { kind: "retry"; runPrefix: string; taskKey: string; reason?: string }
	| { kind: "resume"; runPrefix: string; taskKey?: string }
	| {
			kind: "decide";
			runPrefix: string;
			taskKey: string;
			decision: unknown;
			reason?: string;
	  }
	| { kind: SourceDecisionKind; ref: string; reason?: string };

/** An operator mistake (grammar, addressing, legality); shown as a warning. */
export class WorkflowCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowCommandError";
	}
}

function usage(text: string): never {
	throw new WorkflowCommandError(text);
}

function unexpected(subcommand: string): never {
	throw new WorkflowCommandError(`Unexpected arguments for ${subcommand}.`);
}

function unknownCommand(subcommand: string): never {
	throw new WorkflowCommandError(
		`Unknown workflow command: ${subcommand}. Expected one of ${WORKFLOW_SUBCOMMANDS.join(", ")}.`,
	);
}

/** JSON input for `validate`/`run`; the only accepted input syntax. */
export function parseWorkflowInput(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new WorkflowCommandError("Workflow input is not valid JSON.");
	}
}

/**
 * Splits on whitespace, except that a token opening with `'`, `"`, `{`, or
 * `[` runs to its closing quote or matching bracket (JSON string literals and
 * their escapes are honoured inside brackets), so a JSON decision with spaces
 * travels as one token. Quotes stay in the token; `parseCheckpointDecision`
 * strips a wrapping pair.
 */
export function splitQuoted(text: string): string[] {
	const tokens: string[] = [];
	let index = 0;
	while (index < text.length) {
		const start = text[index] ?? "";
		if (/\s/.test(start)) {
			index += 1;
			continue;
		}
		let end = index;
		if (start === "'" || start === '"') {
			end = closingQuote(text, index, start);
		} else if (start === "{" || start === "[") {
			end = closingBracket(text, index);
		}
		// A quote or bracket left open, or a plain word, runs to the next space.
		if (end <= index) {
			end = index;
			while (end < text.length && !/\s/.test(text[end] ?? "")) end += 1;
		}
		tokens.push(text.slice(index, end));
		index = end;
	}
	return tokens;
}

/** Index after the quote closing the one at `open`; `-1` when it never closes. */
function closingQuote(text: string, open: number, quote: string): number {
	for (let index = open + 1; index < text.length; index += 1) {
		const character = text[index];
		if (character === "\\" && quote === '"') {
			index += 1;
		} else if (character === quote) {
			return index + 1;
		}
	}
	return -1;
}

/** Index after the bracket matching the one at `open`; `-1` when unbalanced. */
function closingBracket(text: string, open: number): number {
	let depth = 0;
	for (let index = open; index < text.length; index += 1) {
		const character = text[index];
		if (character === '"') {
			const end = closingQuote(text, index, '"');
			if (end < 0) return -1;
			index = end - 1;
		} else if (character === "{" || character === "[") {
			depth += 1;
		} else if (character === "}" || character === "]") {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
	}
	return -1;
}

/**
 * The `<json>` token of `decide`: the token itself, or its content when a
 * wrapping quote pair only groups it (`'{"proceed": true}'`). A JSON string
 * literal (`"ship"`) still parses as the string.
 */
export function parseCheckpointDecision(token: string): unknown {
	const candidates = [token];
	const first = token[0];
	if (
		token.length >= 2 &&
		(first === "'" || first === '"') &&
		token.endsWith(first)
	) {
		candidates.unshift(token.slice(1, -1));
	}
	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate);
		} catch {}
	}
	throw new WorkflowCommandError(CHECKPOINT_DECISION_INVALID_JSON_MESSAGE);
}

function boundedInteger(
	raw: string | undefined,
	minimum: number,
	maximum: number,
): number | undefined {
	if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
	const value = Number(raw);
	return value >= minimum && value <= maximum ? value : undefined;
}

/**
 * Parses the argument string of `/workflow`. Tokens split on whitespace; the
 * JSON input of `validate`/`run` is the raw remainder after the ref.
 */
export function parseWorkflowCommand(args: string): ParsedWorkflowCommand {
	const trimmed = args.trim();
	const [subcommand, second, ...rest] = trimmed.split(/\s+/).filter(Boolean);
	if (!subcommand) return { kind: "inspector" };
	if (!WORKFLOW_SUBCOMMANDS.includes(subcommand)) unknownCommand(subcommand);
	switch (subcommand) {
		case "list":
			if (second !== undefined) unexpected(subcommand);
			return { kind: "list" };
		case "runs":
			if ((second !== undefined && second !== "--all") || rest.length > 0) {
				usage("Usage: /workflow runs [--all]");
			}
			return { kind: "runs", includeChildren: second === "--all" };
		case "validate":
		case "run": {
			if (!second) usage(`Usage: /workflow ${subcommand} <ref> [json-input]`);
			const remainder = trimmed
				.slice(trimmed.indexOf(second, subcommand.length) + second.length)
				.trim();
			return remainder
				? {
						kind: subcommand,
						ref: second,
						input: parseWorkflowInput(remainder),
					}
				: { kind: subcommand, ref: second };
		}
		case "approve":
		case "reject": {
			if (!second) {
				usage(`Usage: /workflow ${subcommand} dynamic:<sha256> [reason]`);
			}
			if (!DYNAMIC_REF_PATTERN.test(second)) usage(DYNAMIC_REF_USAGE_MESSAGE);
			return rest.length > 0
				? { kind: subcommand, ref: second, reason: rest.join(" ") }
				: { kind: subcommand, ref: second };
		}
	}
	if (!second) {
		throw new WorkflowCommandError(`Run prefix required for ${subcommand}.`);
	}
	const runPrefix = second;
	switch (subcommand) {
		case "show":
		case "status":
			if (rest.length > 0) unexpected(subcommand);
			return { kind: "show", runPrefix };
		case "logs": {
			if (rest.length === 0) {
				return { kind: "logs", runPrefix, tail: DEFAULT_LOG_TAIL };
			}
			const tail =
				rest[0] === "--tail" && rest.length === 2
					? boundedInteger(rest[1], MIN_LOG_TAIL, MAX_LOG_TAIL)
					: undefined;
			if (tail === undefined) {
				usage(
					`Usage: /workflow logs <run-prefix> [--tail <${MIN_LOG_TAIL}..${MAX_LOG_TAIL}>]`,
				);
			}
			return { kind: "logs", runPrefix, tail };
		}
		case "wait": {
			if (rest.length === 0) return { kind: "wait", runPrefix };
			const timeoutMs =
				rest[0] === "--timeout" && rest.length === 2
					? boundedInteger(rest[1], MIN_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS)
					: undefined;
			if (timeoutMs === undefined) {
				usage(
					`Usage: /workflow wait <run-prefix> [--timeout <${MIN_WAIT_TIMEOUT_MS}..${MAX_WAIT_TIMEOUT_MS}>]`,
				);
			}
			return { kind: "wait", runPrefix, timeoutMs };
		}
		case "stop":
			return rest.length > 0
				? { kind: "stop", runPrefix, reason: rest.join(" ") }
				: { kind: "stop", runPrefix };
		case "reconcile":
		case "resume": {
			// resume without a task key lets the service pick the single
			// resumable task; reconcile without one covers every blocked task.
			if (rest.length > 1) unexpected(subcommand);
			const taskKey = rest[0];
			return taskKey
				? { kind: subcommand, runPrefix, taskKey }
				: { kind: subcommand, runPrefix };
		}
		case "invalidate":
		case "retry": {
			const [taskKey, ...reason] = rest;
			if (!taskKey) {
				usage(
					`Usage: /workflow ${subcommand} <run-prefix> <task-key> [reason]`,
				);
			}
			return reason.length > 0
				? { kind: subcommand, runPrefix, taskKey, reason: reason.join(" ") }
				: { kind: subcommand, runPrefix, taskKey };
		}
		case "decide": {
			// Re-tokenised with quoting so the JSON decision is one token; the
			// decision is parsed here, before any run is resolved.
			const [, , taskKey, json, ...reason] = splitQuoted(trimmed);
			if (!taskKey || !json) {
				usage(
					"Usage: /workflow decide <run-prefix> <task-key> <json> [reason]",
				);
			}
			const decision = parseCheckpointDecision(json);
			return reason.length > 0
				? {
						kind: "decide",
						runPrefix,
						taskKey,
						decision,
						reason: reason.join(" "),
					}
				: { kind: "decide", runPrefix, taskKey, decision };
		}
	}
	return unknownCommand(subcommand);
}

/**
 * Argument completions for `/workflow`: subcommands on the first token; on
 * the second token, known run ids (from the widget's last page, TUI only) for
 * run-addressed subcommands, `--all` for `runs`, and undecided proposal refs
 * (or the `dynamic:` prefix) for `approve`/`reject`. Pi replaces the whole
 * argument text with `value`, so second-token values carry the subcommand.
 */
export function workflowArgumentCompletions(
	prefix: string,
	knownRunIds: readonly string[],
	knownProposalRefs: readonly string[] = [],
): AutocompleteItem[] | null {
	const tokens = prefix.trimStart().split(/\s+/);
	const [subcommand = "", partial] = tokens;
	if (tokens.length === 1) {
		const items = WORKFLOW_SUBCOMMANDS.filter((candidate) =>
			candidate.startsWith(subcommand),
		).map((candidate) => ({ value: candidate, label: candidate }));
		return items.length > 0 ? items : null;
	}
	if (tokens.length !== 2 || partial === undefined) return null;
	if (subcommand === "runs") {
		return "--all".startsWith(partial)
			? [{ value: "runs --all", label: "--all" }]
			: null;
	}
	if (subcommand === "approve" || subcommand === "reject") {
		const refs = knownProposalRefs.filter((ref) => ref.startsWith(partial));
		if (refs.length > 0) {
			return refs.map((ref) => ({ value: `${subcommand} ${ref}`, label: ref }));
		}
		return DYNAMIC_REF_PREFIX.startsWith(partial) &&
			partial !== DYNAMIC_REF_PREFIX
			? [
					{
						value: `${subcommand} ${DYNAMIC_REF_PREFIX}`,
						label: DYNAMIC_REF_PREFIX,
					},
				]
			: null;
	}
	if (!RUN_SUBCOMMANDS.has(subcommand)) return null;
	const items = knownRunIds
		.filter((runId) => runId.startsWith(partial))
		.map((runId) => ({ value: `${subcommand} ${runId}`, label: runId }));
	return items.length > 0 ? items : null;
}

/**
 * Resolves a run id prefix through `listRuns` (children included) until two
 * matches or the last page; an exact id wins over prefix ambiguity.
 */
export async function resolveRunPrefix(
	service: Pick<WorkflowService, "listRuns">,
	prefix: string,
): Promise<WorkflowRunSummary> {
	const matches: WorkflowRunSummary[] = [];
	let cursor: string | undefined;
	do {
		const page = await service.listRuns({
			includeChildren: true,
			limit: 100,
			...(cursor ? { cursor } : {}),
		});
		matches.push(...page.runs.filter((run) => run.runId.startsWith(prefix)));
		cursor = page.nextCursor;
	} while (cursor && matches.length < 2);
	const exact = matches.find((run) => run.runId === prefix);
	if (exact) return exact;
	if (matches.length > 1) {
		throw new WorkflowCommandError(
			`Run prefix is ambiguous: ${prefix} (${matches
				.slice(0, 5)
				.map((run) => run.runId)
				.join(", ")})`,
		);
	}
	const [only] = matches;
	if (!only) throw new WorkflowCommandError(`Run not found: ${prefix}`);
	return only;
}

/**
 * Resolves a task by path (`[...namespace, key].join("/")`, optionally with a
 * leading `/` as log entries render it) or by full task id. Only on-path
 * tasks are actionable; an abandoned-only match is refused explicitly.
 */
export function resolveTaskKey(
	tasks: readonly WorkflowServiceTaskView[],
	input: string,
): WorkflowServiceTaskView {
	const key = normalizeTaskKey(input);
	const matches = tasks.filter(
		(task) => task.id === key || taskPath(task) === key,
	);
	const live = matches.filter((task) => task.abandoned !== true);
	if (live.length > 1) {
		throw new WorkflowCommandError(`Task key is ambiguous: ${key}`);
	}
	const [only] = live;
	if (only) return only;
	if (matches.length > 0) {
		throw new WorkflowCommandError(
			`Task ${key} is abandoned and cannot be acted on.`,
		);
	}
	throw new WorkflowCommandError(`Task not found: ${key}`);
}

/** The last `tail` log entries of a run, paged through `logs` at 500 a page. */
export async function collectLogTail(
	service: Pick<WorkflowService, "logs">,
	runId: WorkflowRunId,
	tail: number,
): Promise<WorkflowLogPage> {
	let entries: WorkflowLogEntry[] = [];
	let afterSequence: number | undefined;
	let lastSequence = 0;
	for (;;) {
		const page = await service.logs(runId, {
			limit: MAX_LOG_TAIL,
			...(afterSequence === undefined ? {} : { afterSequence }),
		});
		entries.push(...page.entries);
		if (entries.length > tail) entries = entries.slice(-tail);
		lastSequence = page.lastSequence;
		const next = page.nextAfterSequence;
		if (next === undefined || next <= (afterSequence ?? 0)) break;
		afterSequence = next;
	}
	return { runId, entries, lastSequence };
}

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

/** Actions an operator can request from the command line. */
export type OperatorAction = WorkflowRunAction;

export const ACTION_LABELS: Record<OperatorAction, string> = {
	stop: "Stop run",
	wait: "Wait for terminal state",
	reconcile: "Reconcile cleanup-blocked work",
	invalidate: "Invalidate a task and its dependents",
	retry: "Retry failed work",
	resume: "Resume interrupted child",
	decide: "Decide a checkpoint",
};

/**
 * Fixed confirmation texts; invalidate's is composed by `invalidateConsequence`
 * and decide's by `decideConsequence`.
 */
export const ACTION_CONSEQUENCES: Record<"stop" | "retry" | "resume", string> =
	{
		stop: "Stop intent is persisted, active delegated work is interrupted, and terminal evidence is drained. The run ends cancelled.",
		retry:
			"A new attempt for each failed or interrupted execution consumes remaining workflow budget.",
		resume:
			"The interrupted child continues as a new attempt and consumes remaining workflow budget.",
	};

/**
 * Actions that ask for confirmation when a UI is available; reconcile and
 * wait never do. `decide` additionally refuses without a UI: a checkpoint
 * decision is a human act and is never recorded unconfirmed.
 */
export const CONFIRMED_ACTIONS: ReadonlySet<OperatorAction> =
	new Set<OperatorAction>(["stop", "invalidate", "retry", "resume", "decide"]);

/** The confirmation text for `invalidate`, from the service's preview only. */
export function invalidateConsequence(
	preview: WorkflowInvalidationPreview,
): string {
	const keys = preview.taskKeys.map(normalizeTaskKey);
	const more = keys.length - 6;
	return `${preview.taskIds.length} task(s) re-execute as new generations: ${keys
		.slice(0, 6)
		.join(", ")}${more > 0 ? `, +${more} more` : ""}. ${
		preview.abandonedEpochs.length
	} epoch(s) after the exposing barrier are abandoned, retiring ${
		preview.abandonedTaskIds.length
	} declaration(s). Effects after that barrier are marked abandoned.`;
}

/**
 * The confirmation text for `decide`: the checkpoint's prompt from the task
 * view and the parsed decision, exactly as it will be recorded.
 */
export function decideConsequence(
	task: Pick<WorkflowServiceTaskView, "namespace" | "key" | "checkpoint">,
	decision: unknown,
): string {
	const prompt = task.checkpoint?.prompt ?? "(no checkpoint request)";
	return `Checkpoint ${taskPath(task)}: ${prompt}\nDecision: ${JSON.stringify(decision)}\nThe decision is recorded once, immutably, and the run continues from it.`;
}

export function actionUnavailableMessage(
	action: OperatorAction,
	run: Pick<WorkflowRunSummary, "runId" | "status" | "leasedElsewhere">,
): string {
	return run.leasedElsewhere
		? `${action} is unavailable: ${run.runId} is leased by another Pi process.`
		: `${action} is unavailable while the run is ${run.status}.`;
}

export interface ActionRequest {
	readonly action: OperatorAction;
	readonly run: WorkflowRunSummary;
	readonly taskId?: WorkflowTaskId;
	/** Display path of `taskId`; defaults to the id in messages. */
	readonly taskKey?: string;
	readonly reason?: string;
	readonly timeoutMs?: number;
	/** Closure already fetched for the confirmation dialog. */
	readonly preview?: WorkflowInvalidationPreview;
	/** The parsed checkpoint decision (`decide`). */
	readonly decision?: unknown;
	/** The session identity recording a decision; never an argument. */
	readonly approver?: string;
}

export interface ActionOutcome {
	readonly message: string;
	readonly level: "info" | "warning";
}

/** A service method that a build may not ship, looked up at call time. */
function implemented(service: object, name: string): boolean {
	return typeof (service as Record<string, unknown>)[name] === "function";
}

/**
 * Performs one operator action after re-reading legality from the summary's
 * `availableActions` (the service refuses independently). `wait` on a run
 * that does not offer it reports the current status instead.
 */
export async function performRunAction(
	service: WorkflowService,
	request: ActionRequest,
): Promise<ActionOutcome> {
	const { action, run } = request;
	const { runId } = run;
	if (!run.availableActions.includes(action)) {
		if (action === "wait") {
			return { message: `${runId}: ${run.status}`, level: "info" };
		}
		throw new WorkflowCommandError(actionUnavailableMessage(action, run));
	}
	switch (action) {
		case "stop": {
			const view = await service.stop(
				runId,
				request.reason ?? DEFAULT_STOP_REASON,
			);
			return {
				message: `stop accepted for ${runId}: ${view.status}.`,
				level: "info",
			};
		}
		case "wait": {
			const view = await service.wait(
				runId,
				request.timeoutMs ? { timeoutMs: request.timeoutMs } : {},
			);
			return view.timedOut
				? {
						message: `${runId}: ${view.status} (timed out after ${request.timeoutMs} ms; the run keeps driving)`,
						level: "warning",
					}
				: { message: `${runId}: ${view.status}`, level: "info" };
		}
		case "reconcile": {
			const view = await service.reconcile(
				runId,
				request.taskId ? { taskId: request.taskId } : {},
			);
			return {
				message: `reconcile: ${view.reconciled.length} execution(s) reconciled; ${runId} is ${view.status}.`,
				level: "info",
			};
		}
		case "invalidate": {
			if (!request.taskId) {
				usage("Usage: /workflow invalidate <run-prefix> <task-key> [reason]");
			}
			// The service's preview is the only source of the closure; it raises
			// the same refusal invalidate would, before anything is appended.
			const preview =
				request.preview ??
				(await service.previewInvalidation(runId, request.taskId));
			const view = await service.invalidate(
				runId,
				request.taskId,
				request.reason ?? DEFAULT_INVALIDATE_REASON,
			);
			return {
				message: `invalidate accepted for ${runId}: ${request.taskKey ?? request.taskId} and ${Math.max(0, preview.taskIds.length - 1)} dependent(s) re-execute; run is ${view.status}.`,
				level: "info",
			};
		}
		case "retry":
		case "resume": {
			// The grammar only offers these when the implemented set lists them;
			// a build that lists one without its method is the impossible gap.
			if (!implemented(service, action)) {
				throw new WorkflowCommandError(
					`${action} is not implemented by this workflow service.`,
				);
			}
			if (action === "retry") {
				if (!request.taskId) {
					usage("Usage: /workflow retry <run-prefix> <task-key> [reason]");
				}
				const view = await service.retry(
					runId,
					request.taskId,
					request.reason ?? DEFAULT_RETRY_REASON,
				);
				return {
					message: `retry accepted for ${runId}: ${view.status}.`,
					level: "info",
				};
			}
			const view = await service.resume(
				runId,
				request.reason ?? DEFAULT_RESUME_REASON,
				request.taskId ? { taskId: request.taskId } : {},
			);
			return {
				message: `resume accepted for ${runId}: ${view.status}.`,
				level: "info",
			};
		}
		case "decide": {
			if (!request.taskId || !("decision" in request)) {
				usage(
					"Usage: /workflow decide <run-prefix> <task-key> <json> [reason]",
				);
			}
			// The service validates the decision against the checkpoint schema
			// and refuses a task that is not awaiting one; nothing is re-derived.
			const view = await service.decide(runId, request.taskId, {
				decision: request.decision,
				approver: request.approver ?? DEFAULT_DECIDE_APPROVER,
				...(request.reason ? { reason: request.reason } : {}),
			});
			return {
				message: `decide accepted for ${runId}: ${request.taskKey ?? request.taskId} decided; run is ${view.status}.`,
				level: "info",
			};
		}
	}
}

// ---------------------------------------------------------------------------
// Dynamic source decisions
// ---------------------------------------------------------------------------

export interface SourceDecisionRequest {
	readonly kind: SourceDecisionKind;
	/** The proposal as inspected for the confirmation dialog. */
	readonly view: Pick<DynamicWorkflowProposalView, "ref" | "decision">;
	readonly approver: DynamicSourceApprover;
	readonly reason?: string;
}

/** `/workflow approve` or `/workflow reject`: the recorded `via`. */
export function sourceDecisionVia(kind: SourceDecisionKind): string {
	return `/${WORKFLOW_COMMAND} ${kind}`;
}

export function sourceDecisionUnavailableMessage(
	kind: SourceDecisionKind,
	view: Pick<DynamicWorkflowProposalView, "ref" | "decision">,
): string {
	return `${kind} is unavailable: ${view.ref} is already ${view.decision?.decision ?? "decided"}.`;
}

/**
 * Records one human decision about a proposed source after re-reading its
 * decision state from the proposal view (the service refuses independently).
 * The caller has already confirmed; a cancelled confirm never reaches here.
 */
export async function performSourceDecision(
	service: Pick<WorkflowService, "decideSource">,
	request: SourceDecisionRequest,
): Promise<ActionOutcome> {
	const { kind, view } = request;
	if (view.decision) {
		throw new WorkflowCommandError(
			sourceDecisionUnavailableMessage(kind, view),
		);
	}
	const decided = await service.decideSource(view.ref, {
		decision: kind === "approve" ? "approved" : "rejected",
		approver: request.approver,
		...(request.reason ? { reason: request.reason } : {}),
	});
	if (kind === "approve") {
		return {
			message: decided.runnable
				? `Approved ${decided.ref}. Run it with workflow_run or /workflow run ${decided.ref}.`
				: `Approved ${decided.ref}, but it is not runnable under the current host API; propose the source again.`,
			level: decided.runnable ? "info" : "warning",
		};
	}
	return {
		message: `Rejected ${decided.ref}. This source cannot be approved again; a changed source gets a new digest.`,
		level: "info",
	};
}
