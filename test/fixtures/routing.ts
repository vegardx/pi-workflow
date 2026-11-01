import {
	type DiscoveredAgent,
	type ExactModelRequest,
	HOST_MODEL,
	type ModelAdmission,
} from "@vegardx/pi-subagent";
import {
	type ModelRoleTier,
	type StaticModelRoutingTable,
	staticModelRouting,
} from "../../src/runtime/model-routing.js";

/**
 * The router the builtin-workflow tests install. Its two rows are made-up
 * models: the shipped agent templates name none and admit `host`, so a test
 * that checks every request against a template asks the host admission below,
 * not a model the package pretends to know.
 */
export const ROUTING_TABLE: StaticModelRoutingTable = Object.freeze({
	provider: "placeholder",
	id: "same-family",
	alias: "same",
	family: "same-family",
	otherFamily: Object.freeze({
		provider: "placeholder",
		id: "other-family",
		alias: "other",
		family: "other-family",
	}),
	thinking: Object.freeze({
		fast: "minimal",
		light: "low",
		normal: "medium",
		frontier: "high",
	}),
	defaultThinking: "medium",
});

export function testModelRouting() {
	return staticModelRouting(ROUTING_TABLE);
}

/** What the table resolves a tier to, as the request a child receives. */
export function routedModel(
	tier: ModelRoleTier,
	family: "same" | "other" = "same",
): ExactModelRequest {
	const row = family === "other" ? ROUTING_TABLE.otherFamily : ROUTING_TABLE;
	if (!row) throw new Error("the test table has no other-family row");
	const thinking = ROUTING_TABLE.thinking[tier];
	if (thinking === "max") throw new Error("the test table never answers max");
	return { provider: row.provider, id: row.id, thinking };
}

/** The other-family model id, for a diversity assertion. */
export const OTHER_FAMILY_ID = "other-family";
/** The same-family model id. */
export const SAME_FAMILY_ID = "same-family";

/**
 * The host the builtin-workflow tests stand for: it admits the models its own
 * router can answer, both families, at any thinking level, and nothing else.
 */
export function hostAdmits(model: ExactModelRequest): boolean {
	return [ROUTING_TABLE, ROUTING_TABLE.otherFamily].some(
		(row) => row?.provider === model.provider && row.id === model.id,
	);
}

/**
 * pi-subagent 0.21.0's fence for a request that names an exact model: an
 * exact entry admits it outright, otherwise a `host` entry hands it to the
 * host. `undefined` is the refusal a real preflight would raise.
 */
export function admittedBy(
	agent: DiscoveredAgent,
	model: ExactModelRequest,
): ModelAdmission | undefined {
	if (
		agent.allowedModels.includes(
			`${model.provider}/${model.id}:${model.thinking}`,
		)
	) {
		return "exact";
	}
	if (agent.allowedModels.includes(HOST_MODEL) && hostAdmits(model)) {
		return "host";
	}
	return undefined;
}
