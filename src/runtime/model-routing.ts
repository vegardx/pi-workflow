import type { ExactModelRequest } from "@vegardx/pi-subagent";

/**
 * The model-routing seam.
 *
 * A definition may declare `modelRole: { persona, tier?, effort?, family? }`
 * instead of an exact `model`, and the materializer resolves it to an exact
 * `{ provider, id, thinking }` **before hashing**, so `AgentTaskRequestSchema`,
 * task identity, and pi-subagent's contract are unchanged.
 *
 * pi-workflow depends on this PORT, never on a router package. The shipped
 * implementation of routing is `@vegardx/pi-models`, which the *host* adapts to
 * this interface and passes in through `WorkflowServiceOptions.modelRouting`;
 * nothing in this repo imports it, so the tier tables that a router owns can
 * change without touching the runtime.
 *
 * Synchronous on purpose. Resolution happens inside `declareAgent`, on the
 * declaration path a replay must reproduce exactly; a port that went to the
 * network per candidate would make the graph's shape depend on how a host
 * happened to answer that second.
 *
 * **No port installed is not a default.** With no `modelRouting`, a `modelRole`
 * declaration fails materialization with
 * {@link MODEL_ROUTING_MISSING_MESSAGE} — the runtime never guesses a model.
 * {@link staticModelRouting} is the one-line stand-in a test or an embedder
 * installs when it wants routing without a router.
 */

/**
 * Thinking levels the routing vocabulary speaks. It is pi-maestro's ladder,
 * which has one rung pi-subagent does not: `max`. {@link exactThinkingLevel}
 * is the only place that mapping lives.
 */
export const MODEL_ROLE_THINKING_LEVELS = Object.freeze([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const);
export type ModelRoleThinkingLevel =
	(typeof MODEL_ROLE_THINKING_LEVELS)[number];

/** The three tiers with fixed meanings: sweeps, daily drivers, deep review. */
export const MODEL_ROLE_TIERS = Object.freeze([
	"light",
	"standard",
	"heavy",
] as const);
export type ModelRoleTier = (typeof MODEL_ROLE_TIERS)[number];

/**
 * How a task asks for a model without naming one. `persona` is free text — the
 * router owns which personas exist and what tiers each may reach.
 * `family: "other"` is the diversity request a reviewer makes so it never marks
 * its own homework.
 */
export interface ModelRoleRequest {
	readonly persona: string;
	readonly tier?: ModelRoleTier;
	readonly effort?: ModelRoleThinkingLevel;
	readonly family?: "same" | "other";
}

/**
 * What a router answers with: an exact model plus why it is that model.
 * Serializable, and every field is evidence — `source` and `fallbackReason`
 * are how a degraded resolution stays visible instead of looking like a choice.
 */
export interface ModelResolution {
	readonly provider: string;
	readonly id: string;
	readonly thinking: ModelRoleThinkingLevel;
	/**
	 * How the model was reached: the caller's own model, a tier walk, or the
	 * seat after everything the tier named was unavailable.
	 */
	readonly source: "inherit" | "tier" | "fallback" | "static";
	/** The persona the router answered for, echoed back. */
	readonly persona?: string;
	readonly tier?: ModelRoleTier;
	/** The diversity axis the resolved model belongs to. */
	readonly family?: string;
	/** The logical model within the family, when the router names one. */
	readonly alias?: string;
	/** Present whenever resolution degraded. Never omitted to look tidy. */
	readonly fallbackReason?: string;
}

/** An exact model as identity carries it, before the thinking mapping. */
export interface ExactModel {
	readonly provider: string;
	readonly id: string;
}

/**
 * The seam. `resolve` is the whole contract a host must implement;
 * `authorized` is the optional replay revalidation (§2.5): a stored resolution
 * is re-used verbatim on every replay and only re-authorized, so a resume on a
 * host that lost the model fails the task by name rather than rerouting it into
 * a different identity.
 */
export interface ModelRoutingPort {
	resolve(role: ModelRoleRequest): ModelResolution;
	authorized?(model: ExactModel): boolean;
	/**
	 * How this router identifies itself in run evidence (`WorkflowRunRecord
	 * .modelRouting.router`). 1..128 characters; absent records nothing.
	 */
	readonly id?: string;
}

export class ModelRoutingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelRoutingError";
	}
}

/** The materialization refusal when a `modelRole` meets no installed router. */
export const MODEL_ROUTING_MISSING_MESSAGE =
	"No model routing is installed; declare an exact model.";

/** The materialization refusal when `model` and `modelRole` are both present. */
export const MODEL_ROLE_EXCLUSIVE_MESSAGE =
	"agent task declares both model and modelRole; they are mutually exclusive";

/**
 * pi-maestro's `max` is pi-subagent's `xhigh`: the top rung of a seven-level
 * ladder mapped onto a six-level one. Everything else passes through. This is
 * the single home of that mapping — the materializer calls it, nothing else
 * translates a thinking level.
 */
export function exactThinkingLevel(
	level: ModelRoleThinkingLevel,
): ExactModelRequest["thinking"] {
	return level === "max" ? "xhigh" : level;
}

/**
 * The resolution as the identity-bearing request carries it. Only the three
 * fields `AgentTaskRequestSchema` knows survive: the rest of the resolution is
 * evidence, and evidence must not enter a hash, or two hosts that agreed on the
 * model but disagreed on why would produce two identities for one task.
 */
export function exactModelRequest(
	resolution: ModelResolution,
): ExactModelRequest {
	return {
		provider: resolution.provider,
		id: resolution.id,
		thinking: exactThinkingLevel(resolution.thinking),
	};
}

/** Whether a value is shaped like a resolution a router may return. */
export function isModelResolution(value: unknown): value is ModelResolution {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ModelResolution>;
	return (
		typeof candidate.provider === "string" &&
		candidate.provider.length > 0 &&
		typeof candidate.id === "string" &&
		candidate.id.length > 0 &&
		typeof candidate.thinking === "string" &&
		(MODEL_ROLE_THINKING_LEVELS as readonly string[]).includes(
			candidate.thinking,
		)
	);
}

/**
 * One row per tier plus one default: the whole table a stand-in router needs.
 * This is the shape `src/components/envelope.ts`'s `MODEL_PROVIDER`,
 * `MODEL_ID`, `DIVERSE_MODEL_ID` and `THINKING_BY_TIER` constants already have.
 * The constants stay where they are — a table with two homes is a table that
 * will disagree with itself — and a caller passes them in.
 */
export interface StaticModelRoutingTable {
	readonly provider: string;
	readonly id: string;
	/** What `family: "other"` resolves to; absent means the request cannot be met. */
	readonly otherFamily?: ExactModel;
	/** The thinking level per tier. */
	readonly thinking: Readonly<Record<ModelRoleTier, ModelRoleThinkingLevel>>;
	/** The thinking level for a request that names no tier. */
	readonly defaultThinking: ModelRoleThinkingLevel;
	/**
	 * The personas this table answers. Absent answers every persona; a list
	 * makes a request outside it unresolvable, which is what a real router would
	 * do with a persona it has no allowance for.
	 */
	readonly personas?: readonly string[];
}

/**
 * A port over one constant table: a `modelRole` resolves to the same exact
 * model every time, so a run routed through it replays identically on any host.
 * It is a stand-in, not routing — every resolution reports
 * `source: "static"` and a `fallbackReason` saying so, because a table that
 * answers every tier with one model is exactly the thing a reader must not
 * mistake for a tier walk.
 */
export function staticModelRouting(
	table: StaticModelRoutingTable,
): ModelRoutingPort {
	const allowed = table.personas ? new Set(table.personas) : undefined;
	const reason =
		"resolved from a constant table, not a model router: the tier and family " +
		"were recorded but did not select the model";
	return Object.freeze({
		id: "static-table",
		resolve(role: ModelRoleRequest): ModelResolution {
			if (allowed && !allowed.has(role.persona)) {
				throw new ModelRoutingError(
					`static model routing has no row for persona ${JSON.stringify(role.persona)}; it answers ${[...allowed].join(", ")}`,
				);
			}
			const exact =
				role.family === "other"
					? table.otherFamily
					: { provider: table.provider, id: table.id };
			if (!exact) {
				throw new ModelRoutingError(
					'static model routing has no other-family row; declare an exact model or install a router that can answer family: "other"',
				);
			}
			return Object.freeze({
				provider: exact.provider,
				id: exact.id,
				thinking:
					role.effort ??
					(role.tier ? table.thinking[role.tier] : table.defaultThinking),
				source: "static" as const,
				persona: role.persona,
				...(role.tier ? { tier: role.tier } : {}),
				fallbackReason: reason,
			});
		},
		// A constant table cannot become unauthorized: the models it names are the
		// models it names, and a host that lost one finds out at preflight.
		authorized: () => true,
	});
}
