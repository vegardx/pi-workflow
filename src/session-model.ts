import type { ExactModelRequest } from "@vegardx/pi-subagent";

/**
 * The session-model seam: `model: "inherit"`.
 *
 * A definition sets a model PER ROLE. It may pin one exactly — an
 * `ExactModelRequest`, `{provider, id, thinking}` — or write the literal
 * {@link INHERIT_MODEL}, which means "the model and thinking level the host
 * session is using right now". There is no effort dial behind either: the
 * `cheap | standard | deep` column that used to decide a task's model is gone,
 * and `src/components/envelope.ts` carries what is left of it as one fixed row
 * per stage.
 *
 * ## Resolved ONCE, at run start
 *
 * `inherit` is resolved when the run record is created, from the provider an
 * embedder installs as `WorkflowServiceOptions.sessionModel` (the shipped
 * extension installs pi-subagent's `resolveSessionModel(pi.events)`), and the
 * exact answer is written on the record as
 * `WorkflowRunRecord.sessionModel`. Every task that inherited is then
 * materialized with THAT value, so:
 *
 * - a run never mixes models: the person switching model mid-run does not
 *   split the run's implementers across two of them;
 * - the journal says which model built the work, because the resolved model is
 *   inside each persisted `AgentTaskRequest` and named once on the record;
 * - replay is deterministic (replay law 3): resolution reads a frozen record
 *   field, never the host's answer of the moment, so a resume on a host whose
 *   session model moved re-declares the identical task identity;
 * - pi-subagent never sees the literal. The launcher forwards the exact
 *   `{provider, id, thinking}` the materializer resolved.
 *
 * ## A host with no session model is refused AT START
 *
 * A definition that inherits declares `meta.needs.sessionModel: true`, so the
 * service can refuse the start before any run exists —
 * {@link sessionModelRefusalMessage} — rather than letting the first task fail
 * minutes and a journal later. A definition that inherits WITHOUT declaring it
 * fails materialization with {@link MODEL_INHERIT_UNAVAILABLE_MESSAGE}: the
 * runtime never guesses a model.
 */

/** The literal a definition writes instead of an exact model. */
export const INHERIT_MODEL = "inherit" as const;
export type InheritModel = typeof INHERIT_MODEL;

/** What a definition may write wherever it can write a model. */
export type ModelAuthoringRequest = ExactModelRequest | InheritModel;

/** The host session's model and thinking level, as the run record keeps it. */
export type SessionModel = ExactModelRequest;

/**
 * The host's session-model provider, read once per run start. Absent means the
 * host has no session model, which is what an embedder that installed nothing
 * means; a definition that inherits is then refused at start.
 */
export type SessionModelProvider = () => SessionModel | undefined;

export function isInheritModel(value: unknown): value is InheritModel {
	return value === INHERIT_MODEL;
}

/** The six thinking levels pi-subagent's `ExactModelRequest` admits. */
const THINKING_LEVELS: readonly string[] = Object.freeze([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);

/**
 * Whether a value is something a role may declare as its model: `"inherit"`, or
 * an exact `{provider, id, thinking}`. Structural, because a component refuses
 * a bad declaration at declaration time, before the schema that would catch it
 * is ever reached.
 */
export function isModelRequest(value: unknown): value is ModelAuthoringRequest {
	if (isInheritModel(value)) return true;
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ExactModelRequest>;
	return (
		typeof candidate.provider === "string" &&
		candidate.provider.length > 0 &&
		typeof candidate.id === "string" &&
		candidate.id.length > 0 &&
		typeof candidate.thinking === "string" &&
		THINKING_LEVELS.includes(candidate.thinking)
	);
}

/**
 * The refusal a start raises when the definition inherits the session model and
 * the host has none. It names the definition, because the person reading it
 * chose that workflow and can choose another.
 */
export function sessionModelRefusalMessage(name: string): string {
	return `${name} inherits the session model, and this host has none.`;
}

/**
 * The materialization refusal when a task asks to inherit and the run resolved
 * no session model — which only happens when the definition did not declare
 * `needs.sessionModel`, because a declaration is refused at start instead.
 */
export const MODEL_INHERIT_UNAVAILABLE_MESSAGE =
	'agent task declares model: "inherit", but the run resolved no session model; declare needs.sessionModel so the start is refused instead';
