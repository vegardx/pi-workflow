import type { ExactModelRequest } from "@vegardx/pi-subagent";
import {
	type ModelRoleTier,
	type StaticModelRoutingTable,
	staticModelRouting,
} from "../../src/runtime/model-routing.js";

/**
 * The router the builtin-workflow tests install. Its two rows are the
 * placeholder routes the shipped agent templates admit, so a test that checks
 * every request against a template asserts something true of the templates,
 * not of a model the package pretends to know.
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
