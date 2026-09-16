import { type Static, Type } from "typebox";
import { deriveJsonValueSha256 } from "../digest.js";

/**
 * Schemas of the `source-approval` decision value. Kept apart from
 * `./contracts.js` so `decision-store.ts` depends on nothing that imports the
 * definition module.
 */

/** Same pattern as the private `Sha256Schema` in contracts.ts. */
export const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });

export const DynamicSourceApproverSchema = Type.Object(
	{
		kind: Type.Literal("human"),
		via: Type.String({ minLength: 1, maxLength: 128 }),
		sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	},
	{ additionalProperties: false },
);
export type DynamicSourceApprover = Static<typeof DynamicSourceApproverSchema>;

export const DynamicSourceDecisionSchema = Type.Union([
	Type.Literal("approved"),
	Type.Literal("rejected"),
]);
export type DynamicSourceDecision = Static<typeof DynamicSourceDecisionSchema>;

/** The decision record `value` of a `source-approval` binding. */
export const DynamicSourceApprovalSchema = Type.Object(
	{
		schema: Type.Literal("pi-workflow-source-approval"),
		sourceSha256: Sha256Schema,
		manifestSha256: Sha256Schema,
		hostApiSha256: Sha256Schema,
		importPolicySha256: Sha256Schema,
		definitionIdentitySha256: Sha256Schema,
		decision: DynamicSourceDecisionSchema,
		approver: DynamicSourceApproverSchema,
		approvedAt: Type.String({ format: "date-time" }),
		projectRoot: Type.String({ minLength: 1, maxLength: 4096 }),
		reason: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
	},
	{ additionalProperties: false },
);
export type DynamicSourceApproval = Static<typeof DynamicSourceApprovalSchema>;
export const DYNAMIC_SOURCE_APPROVAL_SCHEMA_SHA256 = deriveJsonValueSha256(
	DynamicSourceApprovalSchema,
);
