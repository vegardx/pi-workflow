import { type Static, Type } from "typebox";
import {
	JsonSchemaDocumentSchema,
	SupportImplementationSchema,
	WORKFLOW_CONTRACT_REVISION,
} from "../contracts-core.js";
import { WorkflowMetaSchema } from "../definition.js";
import { MAX_DYNAMIC_SOURCE_BYTES } from "./constants.js";
import {
	DYNAMIC_SOURCE_APPROVAL_SCHEMA_SHA256,
	type DynamicSourceApproval,
	DynamicSourceApprovalSchema,
	type DynamicSourceApprover,
	DynamicSourceApproverSchema,
	type DynamicSourceDecision,
	DynamicSourceDecisionSchema,
	Sha256Schema,
} from "./decision-contracts.js";

export {
	DYNAMIC_SOURCE_APPROVAL_SCHEMA_SHA256,
	type DynamicSourceApproval,
	DynamicSourceApprovalSchema,
	type DynamicSourceApprover,
	DynamicSourceApproverSchema,
	type DynamicSourceDecision,
	DynamicSourceDecisionSchema,
	Sha256Schema,
};

export const DynamicWorkflowManifestSchema = Type.Object(
	{
		meta: WorkflowMetaSchema,
		inputSchema: JsonSchemaDocumentSchema,
		outputSchema: JsonSchemaDocumentSchema,
	},
	{ additionalProperties: false },
);
export type DynamicWorkflowManifest = Static<
	typeof DynamicWorkflowManifestSchema
>;

export const DynamicWorkflowProposerSchema = Type.Object(
	{
		kind: Type.Union([
			Type.Literal("tool"),
			Type.Literal("command"),
			Type.Literal("api"),
		]),
		via: Type.String({ minLength: 1, maxLength: 128 }),
	},
	{ additionalProperties: false },
);
export type DynamicWorkflowProposer = Static<
	typeof DynamicWorkflowProposerSchema
>;

export const DynamicTransformerIdentitySchema = Type.Object(
	{
		name: Type.Literal("amaro"),
		version: Type.String({ minLength: 1, maxLength: 32 }),
		mode: Type.Literal("transform"),
		options: Type.Unknown(),
	},
	{ additionalProperties: false },
);
export type DynamicTransformerIdentity = Static<
	typeof DynamicTransformerIdentitySchema
>;

export const DynamicWorkflowProposalRecordSchema = Type.Object(
	{
		schema: Type.Literal("pi-workflow-dynamic-proposal"),
		contractRevision: Type.Literal(WORKFLOW_CONTRACT_REVISION),
		sourceSha256: Sha256Schema,
		sourceBytes: Type.Integer({
			minimum: 1,
			maximum: MAX_DYNAMIC_SOURCE_BYTES,
		}),
		manifest: DynamicWorkflowManifestSchema,
		manifestSha256: Sha256Schema,
		hostApiSha256: Sha256Schema,
		importPolicySha256: Sha256Schema,
		definitionIdentitySha256: Sha256Schema,
		transformer: DynamicTransformerIdentitySchema,
		proposer: DynamicWorkflowProposerSchema,
		proposedAt: Type.String({ format: "date-time" }),
		projectRoot: Type.String({ minLength: 1, maxLength: 4096 }),
	},
	{ additionalProperties: false },
);
export type DynamicWorkflowProposalRecord = Static<
	typeof DynamicWorkflowProposalRecordSchema
>;

/**
 * A registered support helper that dynamic sources may import: the support
 * implementation identity plus the named export it is published under.
 * Structured-clone-safe; travels as `workerData.supportHelpers`.
 */
export const DynamicSupportHelperSpecSchema = Type.Object(
	{
		...SupportImplementationSchema.properties,
		exportName: Type.String({ pattern: "^[A-Za-z_$][A-Za-z0-9_$]{0,127}$" }),
	},
	{ additionalProperties: false },
);
export type DynamicSupportHelperSpec = Static<
	typeof DynamicSupportHelperSpecSchema
>;
