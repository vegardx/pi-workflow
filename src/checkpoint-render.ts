import type { WorkflowCheckpointTaskView } from "./service-views.js";
import { formatUntil, shortId } from "./ui/format.js";

/**
 * One bounded rendering of a pending checkpoint, shared by every surface that
 * shows one: the session dialog (`src/ui/checkpoint-form.ts`), the operator
 * text (`src/ui/format.ts`), and the control-plane views
 * (`src/run-projection.ts`). Everything here is pure - no service call, no
 * pi-tui, no filesystem - and every result is bounded by construction, in the
 * cut-and-notice style `renderDynamicProposal` uses.
 *
 * This module sits below `src/ui`: it borrows two pure formatters from
 * `src/ui/format.ts` and never evaluates them at module scope, so an importing
 * `src/ui/format.ts` would still load cleanly.
 */

/** Every rendered checkpoint body fits this many bytes. */
export const MAX_CHECKPOINT_RENDER_BYTES = 16 * 1024;

/** The one-line answer shape fits this many characters. */
export const MAX_CHECKPOINT_SCHEMA_SUMMARY_LENGTH = 512;

/**
 * A decision schema with at most this many leaf properties is summarized (and
 * asked) field by field; anything larger is answered as JSON.
 */
export const MAX_CHECKPOINT_FLAT_PROPERTIES = 8;

/** The answer shape of a schema no field-by-field rendering fits. */
export const CHECKPOINT_JSON_ANSWER_SHAPE = "JSON matching the schema";

/** What a model reading a parked run must do: surface the question and stop. */
export const CHECKPOINT_DECIDE_INSTRUCTION =
	"A person must answer this checkpoint. Pi prompts them in the session; surface the question and stop. Never decide it yourself, and do not poll the run.";

type JsonRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): JsonRecord | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;
}

function literal(value: unknown): string {
	return JSON.stringify(value) ?? "null";
}

/** `["a", "b", "…"]` once the list is longer than `limit`. */
function capped(values: readonly string[], limit: number): string[] {
	return values.length <= limit
		? [...values]
		: [...values.slice(0, limit), "…"];
}

/**
 * The literals a schema accepts, from `const`, `enum`, or an `anyOf`/`oneOf`
 * whose every member is itself a literal; `undefined` for anything else.
 */
function literalsOf(schema: JsonRecord): readonly string[] | undefined {
	if ("const" in schema) return [literal(schema.const)];
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		return schema.enum.map(literal);
	}
	const union = Array.isArray(schema.anyOf)
		? schema.anyOf
		: Array.isArray(schema.oneOf)
			? schema.oneOf
			: undefined;
	if (!union || union.length === 0) return undefined;
	const literals: string[] = [];
	for (const member of union) {
		const record = asRecord(member);
		const values = record ? literalsOf(record) : undefined;
		if (!values || values.length === 0) return undefined;
		literals.push(...values);
	}
	return literals;
}

/** `boolean`, `string`, `number`, `integer`, or `"a" | "b"`; leaves only. */
function leafShape(schema: JsonRecord): string | undefined {
	const literals = literalsOf(schema);
	if (literals) return capped(literals, 4).join(" | ");
	const type = schema.type;
	return type === "boolean" ||
		type === "string" ||
		type === "number" ||
		type === "integer"
		? type
		: undefined;
}

function numberShape(type: "number" | "integer", schema: JsonRecord): string {
	const noun = type === "integer" ? "a whole number" : "a number";
	const minimum =
		typeof schema.minimum === "number" ? schema.minimum : undefined;
	const maximum =
		typeof schema.maximum === "number" ? schema.maximum : undefined;
	if (minimum !== undefined && maximum !== undefined) {
		return `${noun} between ${minimum} and ${maximum}`;
	}
	if (minimum !== undefined) return `${noun}, at least ${minimum}`;
	if (maximum !== undefined) return `${noun}, at most ${maximum}`;
	return noun;
}

/**
 * `{ proceed: boolean, note?: string }`; only small, flat objects. Required
 * properties come first, in the order the guided form asks them, so the shape
 * does not depend on how the persisted schema happens to order its keys.
 */
function objectShape(schema: JsonRecord): string | undefined {
	const properties = asRecord(schema.properties);
	if (!properties) return undefined;
	const names = Object.keys(properties);
	if (names.length === 0 || names.length > MAX_CHECKPOINT_FLAT_PROPERTIES) {
		return undefined;
	}
	const required = new Set(
		(Array.isArray(schema.required) ? schema.required : []).filter(
			(name): name is string => typeof name === "string",
		),
	);
	const fields: string[] = [];
	for (const name of [
		...names.filter((name) => required.has(name)),
		...names.filter((name) => !required.has(name)),
	]) {
		const property = asRecord(properties[name]);
		const shape = property ? leafShape(property) : undefined;
		if (!shape) return undefined;
		fields.push(`${name}${required.has(name) ? "" : "?"}: ${shape}`);
	}
	return `{ ${fields.join(", ")} }`;
}

function answerShape(schema: JsonRecord): string | undefined {
	const literals = literalsOf(schema);
	if (literals) return `one of: ${capped(literals, 12).join(", ")}`;
	switch (schema.type) {
		case "boolean":
			return "true or false";
		case "string":
			return "text";
		case "integer":
			return numberShape("integer", schema);
		case "number":
			return numberShape("number", schema);
		case "object":
			return objectShape(schema);
		default:
			return undefined;
	}
}

/** One line: whitespace collapsed and cut to the summary bound. */
function oneLine(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length <= MAX_CHECKPOINT_SCHEMA_SUMMARY_LENGTH
		? collapsed
		: `${collapsed.slice(0, MAX_CHECKPOINT_SCHEMA_SUMMARY_LENGTH - 1)}…`;
}

/**
 * The plain-language answer shape of a decision schema, in one line:
 * `true or false`, `one of: "ship", "hold"`, `text`, `a whole number between 1
 * and 5`, `{ proceed: boolean, note?: string }`, or
 * `JSON matching the schema` for everything the guided form answers as JSON.
 */
export function checkpointSchemaSummary(schema: unknown): string {
	const record = asRecord(schema);
	const shape = record ? answerShape(record) : undefined;
	return oneLine(shape ?? CHECKPOINT_JSON_ANSWER_SHAPE);
}

export interface CheckpointInputsRenderOptions {
	/** Total byte bound of the rendering; `MAX_CHECKPOINT_RENDER_BYTES`. */
	readonly budget?: number;
	/** The run the cut notice points `/workflow show` at. */
	readonly run?: string;
}

function cutNotice(bytes: number, run: string): string {
	return `… input cut at ${bytes} bytes; /workflow show ${run} for the full artifact.`;
}

/** Text as its own lines; a handoff descriptor and every other value as JSON. */
function valueLines(value: unknown): string[] {
	if (typeof value === "string") return value.split("\n");
	const json = JSON.stringify(value, null, 2);
	return (json ?? String(value)).split("\n");
}

/**
 * Drops trailing lines until the text and a closing notice fit the bound. The
 * notice alone is returned when even that does not fit.
 */
function cutToBudget(text: string, budget: number, run: string): string {
	if (Buffer.byteLength(text) <= budget) return text;
	const notice = cutNotice(budget, run);
	if (Buffer.byteLength(notice) >= budget) return notice;
	const kept: string[] = [];
	let bytes = Buffer.byteLength(notice);
	for (const line of text.split("\n")) {
		const cost = Buffer.byteLength(line) + 1;
		if (bytes + cost > budget) break;
		kept.push(line);
		bytes += cost;
	}
	return [...kept, notice].join("\n");
}

/**
 * One block per declared input: the input name, then its value as text lines
 * or as pretty JSON. Each input gets an equal share of the budget and a cut
 * block ends with the notice; the whole rendering stays within the budget.
 * Empty inputs render as the empty string.
 */
export function renderCheckpointInputs(
	inputs: Readonly<Record<string, unknown>>,
	options: CheckpointInputsRenderOptions = {},
): string {
	const budget = options.budget ?? MAX_CHECKPOINT_RENDER_BYTES;
	const run = options.run ?? "<run>";
	const names = Object.keys(inputs);
	if (names.length === 0) return "";
	const separators = 2 * (names.length - 1);
	const share = Math.max(0, Math.floor((budget - separators) / names.length));
	const blocks = names.map((name) => {
		const header = `${name}:`;
		const lines = valueLines(inputs[name]).map((line) => `  ${line}`);
		const full = [header, ...lines].join("\n");
		if (Buffer.byteLength(full) <= share) return full;
		const notice = `  ${cutNotice(share, run)}`;
		const kept: string[] = [];
		let bytes = Buffer.byteLength([header, notice].join("\n"));
		for (const line of lines) {
			const cost = Buffer.byteLength(line) + 1;
			if (bytes + cost > share) break;
			kept.push(line);
			bytes += cost;
		}
		return [header, ...kept, notice].join("\n");
	});
	return cutToBudget(blocks.join("\n\n"), budget, run);
}

export interface CheckpointPromptTask {
	readonly namespace: readonly string[];
	readonly key: string;
	readonly checkpoint: Pick<
		WorkflowCheckpointTaskView,
		"prompt" | "schema" | "expiresAt" | "inputs"
	>;
}

/** `${namespace}/${key}`: the token `/workflow decide` accepts. */
export function checkpointTaskKey(
	task: Pick<CheckpointPromptTask, "namespace" | "key">,
): string {
	return [...task.namespace, task.key].join("/");
}

/**
 * The body every checkpoint dialog and every checkpoint text block shows: the
 * header, the prompt in full, the declared inputs, and the answer shape. The
 * result never exceeds `MAX_CHECKPOINT_RENDER_BYTES`.
 */
export function renderCheckpointPrompt(
	task: CheckpointPromptTask,
	run: { readonly runId: string },
	now = Date.now(),
): string {
	const { checkpoint } = task;
	const expires = checkpoint.expiresAt
		? ` · expires ${formatUntil(checkpoint.expiresAt, now)}`
		: "";
	const header = `Checkpoint ${checkpointTaskKey(task)} · run ${shortId(run.runId)}${expires}`;
	const answer = `Answer: ${checkpointSchemaSummary(checkpoint.schema)}`;
	const fixed = [header, "", checkpoint.prompt, "", answer];
	const inputs = checkpoint.inputs ?? {};
	if (Object.keys(inputs).length === 0) {
		return cutToBudget(
			fixed.join("\n"),
			MAX_CHECKPOINT_RENDER_BYTES,
			run.runId,
		);
	}
	const around = [header, "", checkpoint.prompt, "", "Inputs:", "", "", answer];
	const budget = Math.max(
		0,
		MAX_CHECKPOINT_RENDER_BYTES - Buffer.byteLength(around.join("\n")),
	);
	const rendered = renderCheckpointInputs(inputs, {
		budget,
		run: run.runId,
	});
	return cutToBudget(
		[header, "", checkpoint.prompt, "", "Inputs:", rendered, "", answer].join(
			"\n",
		),
		MAX_CHECKPOINT_RENDER_BYTES,
		run.runId,
	);
}
