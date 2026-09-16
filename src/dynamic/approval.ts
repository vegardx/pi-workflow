import { Value } from "typebox/value";
import { WORKFLOW_CONTRACT_REVISION } from "../contracts.js";
import {
	deriveDecisionRecordSha256,
	type SourceApprovalDecisionBinding,
	type WorkflowDecisionRecord,
	WorkflowDecisionRecordError,
	WorkflowDecisionRecordStore,
} from "../decision-store.js";
import { deriveJsonValueSha256 } from "../execution.js";
import {
	DYNAMIC_SOURCE_APPROVAL_SCHEMA_SHA256,
	type DynamicSourceApproval,
	DynamicSourceApprovalSchema,
	type DynamicSourceApprover,
	DynamicSourceApproverSchema,
	type DynamicSourceDecision,
	DynamicSourceDecisionSchema,
	type DynamicTransformerIdentity,
	type DynamicWorkflowManifest,
	type DynamicWorkflowProposalRecord,
	type DynamicWorkflowProposer,
} from "./contracts.js";
import type {
	DynamicWorkflowProposal,
	DynamicWorkflowProposalStore,
} from "./proposal-store.js";
import { dynamicRef } from "./source.js";

/**
 * An approval-track refusal. `code` is the WorkflowServiceError code the
 * service rethrows it under; `message` is final.
 */
export class DynamicWorkflowApprovalError extends Error {
	constructor(
		readonly code: "validation" | "not-found" | "conflict" | "persistence",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "DynamicWorkflowApprovalError";
	}
}

/** A decision record whose `value` is a verified source approval. */
export type DynamicSourceApprovalRecord = WorkflowDecisionRecord & {
	readonly binding: SourceApprovalDecisionBinding;
	readonly value: DynamicSourceApproval;
};

export type DynamicWorkflowProposalView = {
	readonly ref: `dynamic:${string}`;
	readonly sourceSha256: string;
	readonly sourceBytes: number;
	readonly manifest: DynamicWorkflowManifest;
	readonly manifestSha256: string;
	readonly hostApiSha256: string;
	readonly importPolicySha256: string;
	readonly definitionIdentitySha256: string;
	readonly transformer: DynamicTransformerIdentity;
	readonly proposer: DynamicWorkflowProposer;
	readonly proposedAt: string;
	readonly decision?: {
		readonly decision: DynamicSourceDecision;
		readonly approver: DynamicSourceApprover;
		readonly approvedAt: string;
		readonly approvalSha256: string;
		readonly reason?: string;
	};
	/** true iff decision is "approved" and both digests equal the current ones. */
	readonly runnable: boolean;
	/** `<storeRoot>/dynamic/<sha>/source.workflow.ts` */
	readonly path: string;
};

export const MSG_PROPOSAL_NOT_FOUND = (sha: string): string =>
	`Dynamic workflow proposal not found: ${dynamicRef(sha)}`;
export const MSG_PROPOSAL_STALE_HOST_API =
	"Dynamic workflow proposal predates the current host API; propose the source again.";
export const MSG_PROPOSAL_STALE_IMPORT_POLICY =
	"Dynamic workflow import policy changed since the proposal; propose the source again.";
export const MSG_PROPOSAL_OTHER_PROJECT =
	"Dynamic workflow proposal belongs to another project.";
export const MSG_ALREADY_APPROVED =
	"Dynamic workflow source is already approved.";
export const MSG_REJECTED = "Dynamic workflow source was rejected.";
export const MSG_APPROVAL_INVALID =
	"Dynamic workflow approval record is invalid.";
export const MSG_NOT_APPROVED =
	"Dynamic workflow source is not approved for the current host API.";
export const MSG_APPROVAL_OTHER_PROJECT =
	"Dynamic workflow approval belongs to another project.";
export const MSG_APPROVAL_MISMATCH =
	"Dynamic workflow approval does not match the proposal.";
export const MSG_IMPORT_POLICY_CHANGED_SINCE_APPROVAL =
	"Dynamic workflow import policy changed since approval.";

/** Binding of every decision about one proposal identity. */
export function sourceApprovalBinding(proposal: {
	readonly definitionIdentitySha256: string;
	readonly sourceSha256: string;
}): SourceApprovalDecisionBinding {
	return Object.freeze({
		kind: "source-approval",
		definitionIdentitySha256: proposal.definitionIdentitySha256,
		sourceSha256: proposal.sourceSha256,
		contractRevision: WORKFLOW_CONTRACT_REVISION,
	});
}

export function isDynamicSourceApprovalRecord(
	record: WorkflowDecisionRecord,
): record is DynamicSourceApprovalRecord {
	return (
		record.binding.kind === "source-approval" &&
		Value.Check(DynamicSourceApprovalSchema, record.value) &&
		record.valueSchemaSha256 === DYNAMIC_SOURCE_APPROVAL_SCHEMA_SHA256 &&
		record.value.sourceSha256 === record.binding.sourceSha256 &&
		record.value.definitionIdentitySha256 ===
			record.binding.definitionIdentitySha256
	);
}

/** The definition-level decision store of one proposal. */
export function openSourceApprovalStore(
	proposal: DynamicWorkflowProposal,
): Promise<WorkflowDecisionRecordStore> {
	return WorkflowDecisionRecordStore.openRoot({
		directory: proposal.decisionsDirectory,
	});
}

/**
 * Lease-free verified read of the proposal's approval; `undefined` when no
 * decision exists. Any store failure or a record that is not a source
 * approval is [persistence] "Dynamic workflow approval record is invalid.".
 */
export async function readSourceApproval(
	proposal: DynamicWorkflowProposal,
): Promise<DynamicSourceApprovalRecord | undefined> {
	let record: WorkflowDecisionRecord | undefined;
	try {
		const decisions = await openSourceApprovalStore(proposal);
		record = await decisions.read(sourceApprovalBinding(proposal.record));
	} catch (error) {
		throw new DynamicWorkflowApprovalError(
			"persistence",
			MSG_APPROVAL_INVALID,
			{ cause: error },
		);
	}
	if (record === undefined) return undefined;
	if (!isDynamicSourceApprovalRecord(record)) {
		throw new DynamicWorkflowApprovalError("persistence", MSG_APPROVAL_INVALID);
	}
	return record;
}

/** The decision record `decideDynamicSource` writes, built without I/O. */
export function createSourceApprovalRecord(input: {
	readonly proposal: DynamicWorkflowProposalRecord;
	readonly decision: DynamicSourceDecision;
	readonly approver: DynamicSourceApprover;
	readonly approvedAt: string;
	readonly projectRoot: string;
	readonly reason?: string;
}): DynamicSourceApprovalRecord {
	const { proposal } = input;
	const value: DynamicSourceApproval = {
		schema: "pi-workflow-source-approval",
		sourceSha256: proposal.sourceSha256,
		manifestSha256: proposal.manifestSha256,
		hostApiSha256: proposal.hostApiSha256,
		importPolicySha256: proposal.importPolicySha256,
		definitionIdentitySha256: proposal.definitionIdentitySha256,
		decision: input.decision,
		approver: { ...input.approver },
		approvedAt: input.approvedAt,
		projectRoot: input.projectRoot,
		...(input.reason === undefined ? {} : { reason: input.reason }),
	};
	return {
		schema: "pi-workflow-decision",
		contractRevision: WORKFLOW_CONTRACT_REVISION,
		binding: sourceApprovalBinding(proposal),
		source: "operator",
		decidedBy: `human:${input.approver.via}`,
		...(input.reason === undefined ? {} : { reason: input.reason }),
		decidedAt: value.approvedAt,
		valueSchemaSha256: DYNAMIC_SOURCE_APPROVAL_SCHEMA_SHA256,
		valueSha256: deriveJsonValueSha256(value),
		value,
	};
}

/**
 * `decideSource` step 3: a proposal can only be decided against the current
 * host API and import policy, in its own project.
 */
export function assertProposalDecidable(input: {
	readonly proposal: DynamicWorkflowProposalRecord;
	readonly cwd: string;
	readonly hostApiSha256: string;
	readonly importPolicySha256: string;
}): void {
	if (input.proposal.hostApiSha256 !== input.hostApiSha256) {
		throw new DynamicWorkflowApprovalError(
			"validation",
			MSG_PROPOSAL_STALE_HOST_API,
		);
	}
	if (input.proposal.importPolicySha256 !== input.importPolicySha256) {
		throw new DynamicWorkflowApprovalError(
			"validation",
			MSG_PROPOSAL_STALE_IMPORT_POLICY,
		);
	}
	if (input.proposal.projectRoot !== input.cwd) {
		throw new DynamicWorkflowApprovalError(
			"validation",
			MSG_PROPOSAL_OTHER_PROJECT,
		);
	}
}

/** `decideSource` step 4: an existing decision is final. */
export function assertUndecided(
	existing: DynamicSourceApprovalRecord | undefined,
): void {
	if (existing === undefined) return;
	throw new DynamicWorkflowApprovalError(
		"conflict",
		existing.value.decision === "approved"
			? MSG_ALREADY_APPROVED
			: MSG_REJECTED,
	);
}

/**
 * `service.decideSource` after trust and reference parsing: validates the
 * options, requires a current proposal of this project, refuses to decide
 * twice, and writes the immutable decision record. Human-only by schema.
 */
export async function decideDynamicSource(input: {
	readonly store: DynamicWorkflowProposalStore;
	readonly sourceSha256: string;
	readonly decision: DynamicSourceDecision;
	readonly approver: DynamicSourceApprover;
	readonly reason?: string;
	readonly cwd: string;
	readonly hostApiSha256: string;
	readonly importPolicySha256: string;
	readonly now?: () => string;
}): Promise<{
	readonly proposal: DynamicWorkflowProposal;
	readonly approval: DynamicSourceApprovalRecord;
}> {
	if (!Value.Check(DynamicSourceApproverSchema, input.approver)) {
		throw new DynamicWorkflowApprovalError(
			"validation",
			"Invalid dynamic workflow approver.",
		);
	}
	if (!Value.Check(DynamicSourceDecisionSchema, input.decision)) {
		throw new DynamicWorkflowApprovalError(
			"validation",
			"Invalid dynamic workflow decision.",
		);
	}
	if (
		input.reason !== undefined &&
		(typeof input.reason !== "string" ||
			input.reason.length < 1 ||
			input.reason.length > 4096)
	) {
		throw new DynamicWorkflowApprovalError(
			"validation",
			"Invalid dynamic workflow decision reason.",
		);
	}
	const proposal = await input.store.read(input.sourceSha256);
	if (proposal === undefined) {
		throw new DynamicWorkflowApprovalError(
			"not-found",
			MSG_PROPOSAL_NOT_FOUND(input.sourceSha256),
		);
	}
	assertProposalDecidable({
		proposal: proposal.record,
		cwd: input.cwd,
		hostApiSha256: input.hostApiSha256,
		importPolicySha256: input.importPolicySha256,
	});
	const decisions = await openSourceApprovalStore(proposal);
	assertUndecided(await readSourceApproval(proposal));
	const record = createSourceApprovalRecord({
		proposal: proposal.record,
		decision: input.decision,
		approver: input.approver,
		approvedAt: (input.now ?? (() => new Date().toISOString()))(),
		projectRoot: input.cwd,
		...(input.reason === undefined ? {} : { reason: input.reason }),
	});
	try {
		await decisions.put(record);
	} catch (error) {
		if (
			error instanceof WorkflowDecisionRecordError &&
			error.message === "decision record already exists for this binding"
		) {
			assertUndecided(await readSourceApproval(proposal));
		}
		throw error;
	}
	const approval = await readSourceApproval(proposal);
	if (approval === undefined) {
		throw new DynamicWorkflowApprovalError("persistence", MSG_APPROVAL_INVALID);
	}
	return { proposal, approval };
}

/**
 * `run`/`validate` steps 2-5: the proposal must be current for this project
 * and carry an approval that matches it exactly. Returns the verified
 * approval record.
 */
export function assertDynamicSourceRunnable(input: {
	readonly proposal: DynamicWorkflowProposalRecord;
	readonly approval: DynamicSourceApprovalRecord | undefined;
	readonly cwd: string;
	readonly hostApiSha256: string;
	readonly importPolicySha256: string;
}): DynamicSourceApprovalRecord {
	const { proposal, approval } = input;
	const refuse = (message: string): never => {
		throw new DynamicWorkflowApprovalError("validation", message);
	};
	if (proposal.projectRoot !== input.cwd) refuse(MSG_PROPOSAL_OTHER_PROJECT);
	if (proposal.hostApiSha256 !== input.hostApiSha256) {
		refuse(MSG_PROPOSAL_STALE_HOST_API);
	}
	if (proposal.importPolicySha256 !== input.importPolicySha256) {
		refuse(MSG_IMPORT_POLICY_CHANGED_SINCE_APPROVAL);
	}
	if (approval === undefined) return refuse(MSG_NOT_APPROVED);
	if (approval.value.decision === "rejected") refuse(MSG_REJECTED);
	if (approval.value.projectRoot !== input.cwd) {
		refuse(MSG_APPROVAL_OTHER_PROJECT);
	}
	if (
		approval.value.manifestSha256 !== proposal.manifestSha256 ||
		approval.value.importPolicySha256 !== input.importPolicySha256 ||
		approval.value.hostApiSha256 !== input.hostApiSha256
	) {
		refuse(MSG_APPROVAL_MISMATCH);
	}
	return approval;
}

/** The public projection of a proposal and its (optional) decision. */
export function toDynamicWorkflowProposalView(input: {
	readonly proposal: DynamicWorkflowProposal;
	readonly approval: DynamicSourceApprovalRecord | undefined;
	readonly hostApiSha256: string;
	readonly importPolicySha256: string;
}): DynamicWorkflowProposalView {
	const { record } = input.proposal;
	const approval = input.approval;
	const decision =
		approval === undefined
			? undefined
			: Object.freeze({
					decision: approval.value.decision,
					approver: { ...approval.value.approver },
					approvedAt: approval.value.approvedAt,
					approvalSha256: deriveDecisionRecordSha256(approval),
					...(approval.value.reason === undefined
						? {}
						: { reason: approval.value.reason }),
				});
	return Object.freeze({
		ref: dynamicRef(record.sourceSha256),
		sourceSha256: record.sourceSha256,
		sourceBytes: record.sourceBytes,
		manifest: record.manifest,
		manifestSha256: record.manifestSha256,
		hostApiSha256: record.hostApiSha256,
		importPolicySha256: record.importPolicySha256,
		definitionIdentitySha256: record.definitionIdentitySha256,
		transformer: record.transformer,
		proposer: record.proposer,
		proposedAt: record.proposedAt,
		...(decision === undefined ? {} : { decision }),
		runnable:
			decision?.decision === "approved" &&
			record.hostApiSha256 === input.hostApiSha256 &&
			record.importPolicySha256 === input.importPolicySha256,
		path: input.proposal.path,
	});
}
