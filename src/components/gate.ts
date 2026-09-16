import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	CHECKPOINT_JSON_ANSWER_SHAPE,
	checkpointSchemaSummary,
	MAX_CHECKPOINT_FLAT_PROPERTIES,
} from "../checkpoint-render.js";
import type { CheckpointHeadlessPolicy } from "../contracts.js";
import type { TaskDisposition, TaskKey, TaskRef } from "../contracts-core.js";
import { TaskKeySchema } from "../contracts-core.js";
import type {
	CheckpointRequest,
	TaskHandle,
	TaskInputHandle,
	WorkflowContext,
} from "../definition.js";
import { isArtifactHandle, isHandoffHandle } from "../definition.js";
import { WorkflowComponentError } from "./errors.js";

/**
 * `gate` — one human decision, lowered to `ctx.checkpoint`.
 *
 * Pattern: `skills/workflow-authoring/SKILL.md` § "A gate: one human
 * decision". The rules it encodes live under "Checkpoints": the prompt is a
 * question, `inputs` carry everything the decider must read, and the decision
 * schema stays small and flat. The patterns are the primary artifact; this
 * function is their executable form and adds no runtime behaviour of its
 * own.
 *
 * Replay law 1 (keys are a pure function of namespace, declaration ordinal and
 * a caller-supplied stable id): `gate` passes `key` through untouched and
 * derives nothing, so the task id stays `(runId, namespace, key)` and a gate
 * declared inside a `fanOut`/`pipeline` namespace is namespaced by the
 * materializer exactly as a hand-written `ctx.checkpoint` would be.
 *
 * What it does NOT do: it never picks the key, never renders the prompt from
 * data, and never supplies a default. Every refusal below is a rule the
 * runtime cannot check and a person would only discover in the session dialog.
 */

/** The single `ctx` member `gate` uses. */
export type GateContext = Pick<WorkflowContext<unknown>, "checkpoint">;

export interface GateRequest<TDecisionSchema extends TSchema> {
	/** The question the approver reads; the only text they are guaranteed to see. */
	readonly prompt: string;
	/** The decision value's schema: a flat object of at most eight leaves. */
	readonly schema: TDecisionSchema;
	/** Artifacts the decider is shown; `handle.output` or `handle.handoff`. */
	readonly inputs?: Readonly<Record<TaskKey, TaskInputHandle>>;
	/** Defaults to `"block"`: a person must answer. */
	readonly headless?: CheckpointHeadlessPolicy;
	readonly timeoutMs?: number;
	readonly default?: Static<TDecisionSchema>;
	readonly disposition?: TaskDisposition;
	readonly after?: readonly TaskRef[];
}

function refuse(message: string): never {
	throw new WorkflowComponentError("gate", message);
}

/**
 * Declares a human decision and returns its handle.
 *
 * Refuses at declaration when:
 * - `key` is not a task key (`^[a-z][a-z0-9-]*$`, 1..128 characters);
 * - `prompt` is not a question ending in `?`;
 * - `schema` is not an object schema, or is not flat enough for the session to
 *   ask field by field (nested, empty, or more than
 *   `MAX_CHECKPOINT_FLAT_PROPERTIES` leaves) - so no gate silently degrades to
 *   a raw JSON editor;
 * - an input is a task handle rather than the artifact handle a decider can be
 *   shown;
 * - `headless: "use-explicit-default"` carries no `default`.
 */
export function gate<TDecisionSchema extends TSchema>(
	ctx: GateContext,
	key: TaskKey,
	request: GateRequest<TDecisionSchema>,
): TaskHandle<Static<TDecisionSchema>> {
	if (!Value.Check(TaskKeySchema, key)) {
		refuse(
			`gate key ${JSON.stringify(key)} is not a task key; a gate key is a caller-supplied stable id matching ^[a-z][a-z0-9-]*$, 1..128 characters.`,
		);
	}
	const prompt = request.prompt;
	if (typeof prompt !== "string" || !prompt.trim().endsWith("?")) {
		refuse(
			`gate "${key}" prompt must be a question ending in "?"; it is the only text the approver is guaranteed to see.`,
		);
	}
	const schemaType = (request.schema as { readonly type?: unknown }).type;
	if (schemaType !== "object") {
		refuse(
			`gate "${key}" decision schema must be an object schema; the session asks a gate property by property.`,
		);
	}
	if (
		checkpointSchemaSummary(request.schema) === CHECKPOINT_JSON_ANSWER_SHAPE
	) {
		refuse(
			`gate "${key}" decision schema must be a flat object of 1..${MAX_CHECKPOINT_FLAT_PROPERTIES} leaf properties; anything larger degrades to a raw JSON editor the approver has to hand-write.`,
		);
	}
	for (const [name, handle] of Object.entries(request.inputs ?? {})) {
		if (!isArtifactHandle(handle) && !isHandoffHandle(handle)) {
			refuse(
				`gate "${key}" input "${name}" is not an artifact handle; pass handle.output or handle.handoff, never the task handle itself.`,
			);
		}
	}
	const headless = request.headless ?? "block";
	const hasDefault =
		Object.hasOwn(request, "default") && request.default !== undefined;
	if (headless === "use-explicit-default" && !hasDefault) {
		refuse(
			`gate "${key}" is headless "use-explicit-default" and needs an explicit default decision.`,
		);
	}
	const checkpoint: CheckpointRequest<TDecisionSchema> = {
		schema: request.schema,
		prompt,
		headless,
		...(hasDefault
			? { default: request.default as Static<TDecisionSchema> }
			: {}),
		...(request.timeoutMs === undefined
			? {}
			: { timeoutMs: request.timeoutMs }),
		...(request.disposition === undefined
			? {}
			: { disposition: request.disposition }),
		...(request.after === undefined ? {} : { after: request.after }),
		...(request.inputs === undefined ? {} : { inputs: request.inputs }),
	};
	return ctx.checkpoint(key, checkpoint);
}
