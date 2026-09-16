import {
	type CheckpointPromptTask,
	checkpointSchemaSummary,
	checkpointTaskKey,
	MAX_CHECKPOINT_FLAT_PROPERTIES,
	renderCheckpointPrompt,
} from "../checkpoint-render.js";
import type { WorkflowRunId, WorkflowTaskId } from "../contracts.js";
import type { WorkflowService } from "../service.js";
import type {
	WorkflowCheckpointTaskView,
	WorkflowServiceRunView,
} from "../service-views.js";
import {
	CHECKPOINT_DECISION_INVALID_JSON_MESSAGE,
	DEFAULT_DECIDE_APPROVER,
} from "./commands.js";

/**
 * The guided checkpoint form: the session user answers a parked checkpoint
 * through Pi's own dialog primitives, one field at a time, and the answer is
 * recorded by `service.decide` under the session approver.
 *
 * Two rules shape everything here:
 *
 * - **The form never validates.** It shapes a value and hands it to the
 *   service; the executor's Ajv check is the only validator. A decision
 *   refusal comes back as the next dialog's title.
 * - **Dismiss records nothing.** Every field dialog returns `undefined` when
 *   the user escapes, and the whole form then returns `undefined` having
 *   called nothing. The final `confirm` is the only place where `false` is a
 *   deliberate "record nothing", which is why no field uses `confirm`
 *   (`confirm` cannot tell "No" from "escaped").
 *
 * IO is the injected `CheckpointFormUi` port, structurally Pi's
 * `ExtensionUIContext`, so this module never imports pi-tui or the extension
 * API and a test passes a fake.
 */

/** Pi's `ExtensionUIDialogOptions`; `timeout` renders the expiry countdown. */
export interface CheckpointDialogOptions {
	readonly signal?: AbortSignal;
	readonly timeout?: number;
}

/**
 * The dialog primitives the form uses, structurally compatible with Pi's
 * `ExtensionUIContext`. `editor` takes no options: the JSON path checks the
 * expiry itself before opening one.
 */
export interface CheckpointFormUi {
	select(
		title: string,
		options: string[],
		opts?: CheckpointDialogOptions,
	): Promise<string | undefined>;
	confirm(
		title: string,
		message: string,
		opts?: CheckpointDialogOptions,
	): Promise<boolean>;
	input(
		title: string,
		placeholder?: string,
		opts?: CheckpointDialogOptions,
	): Promise<string | undefined>;
	editor(title: string, prefill?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Structurally an `ExtensionContext`; only `ui` is ever read. */
export interface CheckpointFormContext {
	readonly ui: CheckpointFormUi;
}

/** A checkpoint task view whose checkpoint request is present. */
export interface CheckpointFormTask extends CheckpointPromptTask {
	readonly id: WorkflowTaskId;
	readonly checkpoint: Pick<
		WorkflowCheckpointTaskView,
		"prompt" | "schema" | "expiresAt" | "inputs" | "default"
	>;
}

export interface CheckpointFormRun {
	readonly runId: WorkflowRunId;
}

export interface CheckpointFormOptions {
	/** The one validator: the service records and refuses the decision. */
	readonly service: Pick<WorkflowService, "decide">;
	/** Defaults to `DEFAULT_DECIDE_APPROVER`; never a command argument. */
	readonly approver?: string;
	readonly reason?: string;
	/** Aborts every open dialog when the checkpoint stops being pending. */
	readonly signal?: AbortSignal;
	/** Injectable clock; the expiry countdown and deadline read it. */
	readonly now?: () => number;
}

export interface CheckpointDecisionOutcome {
	/** The recorded decision, exactly as the service accepted it. */
	readonly decision: unknown;
	/** The run view `decide` returned. */
	readonly view: WorkflowServiceRunView;
	readonly taskKey: string;
}

/**
 * The form calls `service.decide` at most this many times. Each validation
 * refusal re-asks with the service's message as the dialog title; the last
 * one is reported as a warning and records nothing.
 */
export const MAX_CHECKPOINT_FORM_ATTEMPTS = 3;

/**
 * The executor's decision refusals: the value was shaped wrongly, so asking
 * again can fix it. Every other refusal ("Checkpoint has expired.",
 * "Checkpoint is already decided.", …) ends the form.
 */
export const CHECKPOINT_DECISION_REFUSALS: ReadonlySet<string> = new Set([
	"Checkpoint decision does not match its schema.",
	"Checkpoint decision is not losslessly JSON serializable.",
	"Checkpoint decision exceeds the workflow artifact bound.",
]);

/** The executor's own wording, applied before an `editor` that takes no timeout. */
export const CHECKPOINT_EXPIRED_MESSAGE = "Checkpoint has expired.";

/** Shown in an optional field's title; an empty answer omits the property. */
export const CHECKPOINT_OPTIONAL_HINT = "(optional — leave empty to skip)";

/** The extra `select` option that omits an optional non-text property. */
export const CHECKPOINT_SKIP_OPTION = "(skip — leave unset)";

const CHECKPOINT_CONSEQUENCE =
	"The decision is recorded once, immutably, and the run continues from it.";

type JsonRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): JsonRecord | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;
}

function json(value: unknown): string {
	return JSON.stringify(value) ?? "null";
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Schema to dialog plan
// ---------------------------------------------------------------------------

type LeafPlan =
	| { readonly kind: "boolean" }
	| { readonly kind: "literals"; readonly literals: readonly unknown[] }
	| { readonly kind: "string" }
	| { readonly kind: "number"; readonly integer: boolean };

interface PlannedField {
	readonly name?: string;
	readonly required: boolean;
	readonly leaf: LeafPlan;
	readonly schema: JsonRecord;
}

type FormPlan =
	| { readonly kind: "fields"; readonly fields: readonly PlannedField[] }
	/** Arrays, nested objects, literal unions of objects, > 8 properties. */
	| { readonly kind: "json" };

/**
 * The literals a schema accepts, from `const`, `enum`, or an `anyOf`/`oneOf`
 * whose every member is a literal; `undefined` for anything else.
 */
function literalsOf(schema: JsonRecord): readonly unknown[] | undefined {
	if ("const" in schema) return [schema.const];
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		return [...schema.enum];
	}
	const union = Array.isArray(schema.anyOf)
		? schema.anyOf
		: Array.isArray(schema.oneOf)
			? schema.oneOf
			: undefined;
	if (!union || union.length === 0) return undefined;
	const literals: unknown[] = [];
	for (const member of union) {
		const record = asRecord(member);
		const values = record ? literalsOf(record) : undefined;
		if (!values || values.length === 0) return undefined;
		literals.push(...values);
	}
	return literals;
}

/** One dialog's worth of schema, or `undefined` when only JSON will do. */
function leafPlan(schema: JsonRecord): LeafPlan | undefined {
	const literals = literalsOf(schema);
	if (literals) return { kind: "literals", literals };
	switch (schema.type) {
		case "boolean":
			return { kind: "boolean" };
		case "string":
			return { kind: "string" };
		case "integer":
			return { kind: "number", integer: true };
		case "number":
			return { kind: "number", integer: false };
		default:
			return undefined;
	}
}

/**
 * The field sequence of a decision schema: one leaf, or a flat object of at
 * most `MAX_CHECKPOINT_FLAT_PROPERTIES` leaves asked required-first; anything
 * else is answered as JSON in one editor.
 */
export function planCheckpointFields(schema: unknown): FormPlan {
	const record = asRecord(schema);
	if (!record) return { kind: "json" };
	const leaf = leafPlan(record);
	if (leaf) {
		return {
			kind: "fields",
			fields: [{ required: true, leaf, schema: record }],
		};
	}
	if (record.type !== "object") return { kind: "json" };
	const properties = asRecord(record.properties);
	if (!properties) return { kind: "json" };
	const names = Object.keys(properties);
	if (names.length === 0 || names.length > MAX_CHECKPOINT_FLAT_PROPERTIES) {
		return { kind: "json" };
	}
	const required = new Set(
		(Array.isArray(record.required) ? record.required : []).filter(
			(name): name is string => typeof name === "string",
		),
	);
	const fields: PlannedField[] = [];
	for (const name of [
		...names.filter((name) => required.has(name)),
		...names.filter((name) => !required.has(name)),
	]) {
		const property = asRecord(properties[name]);
		const plan = property ? leafPlan(property) : undefined;
		if (!property || !plan) return { kind: "json" };
		fields.push({
			name,
			required: required.has(name),
			leaf: plan,
			schema: property,
		});
	}
	return { kind: "fields", fields };
}

/**
 * The JSON editor's prefill: the request's default, else a value shaped like
 * the schema. Recursion is bounded; anything unrecognized becomes `{}`.
 */
export function checkpointSkeleton(schema: unknown, depth = 0): unknown {
	const record = asRecord(schema);
	if (!record || depth > 5) return {};
	if ("default" in record) return record.default;
	if ("const" in record) return record.const;
	if (Array.isArray(record.enum) && record.enum.length > 0) {
		return record.enum[0];
	}
	const union = Array.isArray(record.anyOf)
		? record.anyOf
		: Array.isArray(record.oneOf)
			? record.oneOf
			: undefined;
	if (union && union.length > 0) return checkpointSkeleton(union[0], depth + 1);
	switch (record.type) {
		case "object": {
			const properties = asRecord(record.properties);
			if (!properties) return {};
			const required = new Set(
				(Array.isArray(record.required) ? record.required : []).filter(
					(name): name is string => typeof name === "string",
				),
			);
			const shaped: Record<string, unknown> = {};
			for (const name of Object.keys(properties).slice(
				0,
				MAX_CHECKPOINT_FLAT_PROPERTIES,
			)) {
				if (required.size > 0 && !required.has(name)) continue;
				shaped[name] = checkpointSkeleton(properties[name], depth + 1);
			}
			return shaped;
		}
		case "array":
			return [];
		case "boolean":
			return false;
		case "string":
			return "";
		case "integer":
		case "number":
			return 0;
		case "null":
			return null;
		default:
			return {};
	}
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/** Non-empty sections joined by a blank line; `select` has no message body. */
function title(...sections: (string | undefined)[]): string {
	return sections.filter((section) => section).join("\n\n");
}

function defaultOf(
	field: PlannedField,
	requestDefault: unknown,
): unknown | undefined {
	if ("default" in field.schema) return field.schema.default;
	if (field.name === undefined) return requestDefault;
	const record = asRecord(requestDefault);
	return record && field.name in record ? record[field.name] : undefined;
}

/** `name (optional — leave empty to skip)` plus the one-line answer shape. */
function fieldTitle(
	field: PlannedField,
	taskKey: string,
	fallback: unknown,
): string {
	const head =
		field.name === undefined
			? `Decide ${taskKey}`
			: `${field.name}${field.required ? "" : ` ${CHECKPOINT_OPTIONAL_HINT}`}`;
	const shape = checkpointSchemaSummary(field.schema);
	const value = defaultOf(field, fallback);
	const suffix = value === undefined ? "" : `\nDefault: ${json(value)}`;
	return `${head}\n${shape}${suffix}`;
}

/** Each option is its JSON literal plus a gloss; the default is listed first. */
function selectOptions(
	literals: readonly unknown[],
	boolean: boolean,
	fallback: unknown,
): Map<string, unknown> {
	const ordered = [
		...literals.filter((value) => json(value) === json(fallback)),
		...literals.filter((value) => json(value) !== json(fallback)),
	];
	const options = new Map<string, unknown>();
	for (const value of ordered) {
		const gloss = boolean
			? value === true
				? " — yes"
				: " — no"
			: json(value) === json(fallback)
				? " — default"
				: "";
		const label = `${json(value)}${gloss}`;
		if (!options.has(label)) options.set(label, value);
	}
	return options;
}

/** The parse and bound check that turns text into a number at all. */
function parseNumber(
	text: string,
	integer: boolean,
	schema: JsonRecord,
): { value: number } | { error: string } {
	const trimmed = text.trim();
	const value = Number(trimmed);
	if (trimmed === "" || !Number.isFinite(value)) {
		return { error: `Enter ${integer ? "a whole number" : "a number"}.` };
	}
	if (integer && !Number.isInteger(value)) {
		return { error: "Enter a whole number." };
	}
	if (typeof schema.minimum === "number" && value < schema.minimum) {
		return { error: `Enter a number of at least ${schema.minimum}.` };
	}
	if (typeof schema.maximum === "number" && value > schema.maximum) {
		return { error: `Enter a number of at most ${schema.maximum}.` };
	}
	const step = schema.multipleOf;
	if (typeof step === "number" && step > 0 && value % step !== 0) {
		return { error: `Enter a multiple of ${step}.` };
	}
	return { value };
}

/** `skip` omits an optional property; `abort` is a dismissed dialog. */
type FieldAnswer =
	| { readonly kind: "value"; readonly value: unknown }
	| { readonly kind: "skip" }
	| { readonly kind: "abort" };

interface AskContext {
	readonly ui: CheckpointFormUi;
	readonly taskKey: string;
	readonly requestDefault: unknown;
	readonly opts: () => CheckpointDialogOptions | undefined;
}

async function askField(
	context: AskContext,
	field: PlannedField,
	lead: string | undefined,
): Promise<FieldAnswer> {
	const fallback = defaultOf(field, context.requestDefault);
	const heading = fieldTitle(field, context.taskKey, context.requestDefault);
	if (field.leaf.kind === "boolean" || field.leaf.kind === "literals") {
		const options = selectOptions(
			field.leaf.kind === "boolean" ? [true, false] : field.leaf.literals,
			field.leaf.kind === "boolean",
			fallback,
		);
		const labels = [...options.keys()];
		if (!field.required) labels.push(CHECKPOINT_SKIP_OPTION);
		const answer = await context.ui.select(
			title(lead, heading),
			labels,
			context.opts(),
		);
		if (answer === undefined) return { kind: "abort" };
		if (answer === CHECKPOINT_SKIP_OPTION && !field.required) {
			return { kind: "skip" };
		}
		return options.has(answer)
			? { kind: "value", value: options.get(answer) }
			: { kind: "abort" };
	}
	// `input` ignores its placeholder in the TUI, so every hint is in the title.
	let reason: string | undefined;
	for (let attempt = 0; attempt < MAX_CHECKPOINT_FORM_ATTEMPTS; attempt += 1) {
		const answer = await context.ui.input(
			title(lead, reason, heading),
			undefined,
			context.opts(),
		);
		if (answer === undefined) return { kind: "abort" };
		if (answer.trim() === "" && !field.required) return { kind: "skip" };
		if (field.leaf.kind === "string") return { kind: "value", value: answer };
		const parsed = parseNumber(answer, field.leaf.integer, field.schema);
		if ("value" in parsed) return { kind: "value", value: parsed.value };
		reason = parsed.error;
	}
	context.ui.notify(reason ?? "No decision recorded.", "warning");
	return { kind: "abort" };
}

/**
 * The sequential field pass: one dialog per field, the shared body carried by
 * the first one. `undefined` means the user dismissed a dialog.
 */
async function askFields(
	context: AskContext,
	fields: readonly PlannedField[],
	lead: string | undefined,
): Promise<{ value: unknown } | undefined> {
	const [only] = fields;
	if (fields.length === 1 && only && only.name === undefined) {
		const answer = await askField(context, only, lead);
		return answer.kind === "value" ? { value: answer.value } : undefined;
	}
	let carried = lead;
	const shaped: Record<string, unknown> = {};
	for (const field of fields) {
		const answer = await askField(context, field, carried);
		carried = undefined;
		if (answer.kind === "abort") return undefined;
		if (answer.kind === "skip" || field.name === undefined) continue;
		shaped[field.name] = answer.value;
	}
	return { value: shaped };
}

/** The JSON path: one editor, prefilled, re-asked while the text will not parse. */
async function askJson(
	context: AskContext,
	task: CheckpointFormTask,
	lead: string | undefined,
	prefill: unknown,
	expired: () => boolean,
): Promise<{ value: unknown } | undefined> {
	let text = JSON.stringify(
		prefill === undefined
			? checkpointSkeleton(task.checkpoint.schema)
			: prefill,
		null,
		2,
	);
	let reason: string | undefined;
	let carried = lead;
	for (let attempt = 0; attempt < MAX_CHECKPOINT_FORM_ATTEMPTS; attempt += 1) {
		// `editor` takes neither a timeout nor a signal, so the deadline is
		// checked here instead; afterwards the service's refusal is authority.
		if (expired()) {
			context.ui.notify(CHECKPOINT_EXPIRED_MESSAGE, "warning");
			return undefined;
		}
		const answer = await context.ui.editor(
			title(carried, reason, `Decide ${context.taskKey} (JSON)`),
			text ?? "{}",
		);
		carried = undefined;
		if (answer === undefined) return undefined;
		try {
			return { value: JSON.parse(answer) as unknown };
		} catch {
			reason = CHECKPOINT_DECISION_INVALID_JSON_MESSAGE;
			text = answer;
		}
	}
	context.ui.notify(CHECKPOINT_DECISION_INVALID_JSON_MESSAGE, "warning");
	return undefined;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Asks the session user to decide one parked checkpoint and records the
 * answer through `service.decide`.
 *
 * Returns the recorded decision, or `undefined` when the user dismissed a
 * dialog, declined the final confirm, or the service refused in a way the
 * form cannot fix - in every one of which nothing was recorded.
 *
 * This is the one entry point every session decide path uses: the parked-run
 * observer, `/workflow decide <run> <task>` without JSON, and the inspector's
 * decide intent.
 */
export async function collectCheckpointDecision(
	ctx: CheckpointFormContext,
	task: CheckpointFormTask,
	run: CheckpointFormRun,
	options: CheckpointFormOptions,
): Promise<CheckpointDecisionOutcome | undefined> {
	const { ui } = ctx;
	const now = options.now ?? (() => Date.now());
	const taskKey = checkpointTaskKey(task);
	const deadline = task.checkpoint.expiresAt
		? Date.parse(task.checkpoint.expiresAt)
		: undefined;
	const expired = () =>
		deadline !== undefined && Number.isFinite(deadline) && deadline <= now();
	const opts = (): CheckpointDialogOptions | undefined => {
		const remaining =
			deadline !== undefined && Number.isFinite(deadline)
				? deadline - now()
				: undefined;
		const dialog: { signal?: AbortSignal; timeout?: number } = {};
		if (remaining !== undefined && remaining > 0) dialog.timeout = remaining;
		if (options.signal) dialog.signal = options.signal;
		return Object.keys(dialog).length === 0 ? undefined : dialog;
	};
	const plan = planCheckpointFields(task.checkpoint.schema);
	const context: AskContext = {
		ui,
		taskKey,
		requestDefault: task.checkpoint.default,
		opts,
	};

	let refusal: string | undefined;
	let rejected: unknown;
	for (let attempt = 0; attempt < MAX_CHECKPOINT_FORM_ATTEMPTS; attempt += 1) {
		const body = renderCheckpointPrompt(task, run, now());
		// A refused value is asked again the same way, the service's message
		// leading the first dialog; the JSON editor is prefilled with it.
		const collected =
			plan.kind === "fields"
				? await askFields(context, plan.fields, title(refusal, body))
				: await askJson(
						context,
						task,
						title(refusal, body),
						attempt === 0 ? task.checkpoint.default : rejected,
						expired,
					);
		if (collected === undefined) return undefined;
		const { value } = collected;
		const confirmed = await ui.confirm(
			`Decide ${taskKey}?`,
			`${body}\nDecision: ${json(value)}\n${CHECKPOINT_CONSEQUENCE}`,
			opts(),
		);
		if (!confirmed) return undefined;
		try {
			const view = await options.service.decide(run.runId, task.id, {
				decision: value,
				approver: options.approver ?? DEFAULT_DECIDE_APPROVER,
				...(options.reason ? { reason: options.reason } : {}),
			});
			return { decision: value, view, taskKey };
		} catch (error) {
			const message = messageOf(error);
			if (
				!CHECKPOINT_DECISION_REFUSALS.has(message) ||
				attempt + 1 >= MAX_CHECKPOINT_FORM_ATTEMPTS
			) {
				ui.notify(message, "warning");
				return undefined;
			}
			refusal = message;
			rejected = value;
		}
	}
	return undefined;
}
