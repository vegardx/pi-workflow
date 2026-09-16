import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import {
	deriveDecisionRecordSha256,
	MAX_WORKFLOW_DECISION_RECORD_BYTES,
	type WorkflowDecisionRecord,
	WorkflowDecisionRecordSchema,
} from "../decision-store.js";
import { deriveJsonValueSha256 } from "../execution.js";
import {
	isDynamicSourceApprovalRecord,
	MSG_IMPORT_POLICY_CHANGED_SINCE_APPROVAL,
} from "./approval.js";
import {
	MAX_DYNAMIC_MANIFEST_BYTES,
	MAX_DYNAMIC_PROPOSAL_RECORD_BYTES,
	MAX_DYNAMIC_SOURCE_BYTES,
} from "./constants.js";
import {
	type DynamicWorkflowManifest,
	DynamicWorkflowManifestSchema,
	type DynamicWorkflowProposalRecord,
	DynamicWorkflowProposalRecordSchema,
} from "./contracts.js";
import { deriveDynamicDefinitionIdentitySha256 } from "./identity.js";
import {
	canonicalDynamicDocument,
	DYNAMIC_MANIFEST_FILE,
	DYNAMIC_PROPOSAL_FILE,
	DYNAMIC_SOURCE_FILE,
} from "./proposal-store.js";
import { deriveDynamicSourceSha256 } from "./source.js";

export const DYNAMIC_RUN_DEFINITION_DIRECTORY = "definition";
export const DYNAMIC_APPROVAL_FILE = "approval.json";

export const MSG_COPY_EXISTS = "Workflow run definition copy already exists.";
export const MSG_COPY_CORRUPT =
	"Workflow run definition copy is missing or corrupt.";
export const MSG_SOURCE_CHANGED =
	"Dynamic workflow source changed since the run was created.";
export const MSG_APPROVAL_CHANGED =
	"Dynamic workflow approval record changed since the run was created.";
export const MSG_HOST_API_CHANGED =
	"Dynamic workflow host API changed since the run was created.";
export const MSG_MANIFEST_CHANGED =
	"Dynamic workflow manifest changed since approval.";
export const MSG_PROJECT_CHANGED =
	"Workflow definition, source, or project identity changed.";

export class DynamicRunDefinitionError extends Error {
	constructor(
		readonly code: "validation" | "persistence",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "DynamicRunDefinitionError";
	}
}

/** What `run()` copies into `<run dir>/definition/`. */
export interface DynamicRunDefinitionInput {
	readonly source: string;
	readonly manifest: DynamicWorkflowManifest;
	readonly proposal: DynamicWorkflowProposalRecord;
	readonly approval: WorkflowDecisionRecord;
}

/** The copy as read back on resume; `manifest` and `approval` are unverified. */
export interface DynamicRunDefinitionCopy {
	readonly source: string;
	readonly manifest: unknown;
	readonly proposal: DynamicWorkflowProposalRecord;
	readonly approval: unknown;
}

export interface VerifiedDynamicRunDefinition {
	readonly source: string;
	readonly manifest: DynamicWorkflowManifest;
	readonly proposal: DynamicWorkflowProposalRecord;
	readonly approval: WorkflowDecisionRecord;
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writeExclusive(
	filePath: string,
	content: Buffer,
): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(filePath, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new DynamicRunDefinitionError("persistence", MSG_COPY_EXISTS, {
				cause: error,
			});
		}
		throw error;
	}
	try {
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * Writes `<run dir>/definition/{source.workflow.ts,manifest.json,
 * proposal.json,approval.json}` exclusively, then syncs the definition
 * directory and the run directory. Called by `run()` after the lease and
 * journal are open and before the run record is created, so a run record
 * implies the copies exist. Returns the definition directory.
 */
export async function writeRunDefinitionCopy(
	runDirectory: string,
	input: DynamicRunDefinitionInput,
): Promise<string> {
	const directory = path.join(runDirectory, DYNAMIC_RUN_DEFINITION_DIRECTORY);
	try {
		await mkdir(directory, { recursive: false, mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	await writeExclusive(
		path.join(directory, DYNAMIC_SOURCE_FILE),
		Buffer.from(input.source, "utf8"),
	);
	await writeExclusive(
		path.join(directory, DYNAMIC_MANIFEST_FILE),
		canonicalDynamicDocument(input.manifest),
	);
	await writeExclusive(
		path.join(directory, DYNAMIC_PROPOSAL_FILE),
		canonicalDynamicDocument(input.proposal),
	);
	await writeExclusive(
		path.join(directory, DYNAMIC_APPROVAL_FILE),
		canonicalDynamicDocument(input.approval),
	);
	await syncDirectory(directory);
	await syncDirectory(runDirectory);
	return directory;
}

async function readFileNoFollow(
	filePath: string,
	limit: number,
): Promise<Buffer> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		throw new DynamicRunDefinitionError("persistence", MSG_COPY_CORRUPT, {
			cause: error,
		});
	}
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.size > limit) {
			throw new DynamicRunDefinitionError("persistence", MSG_COPY_CORRUPT);
		}
		const content = Buffer.alloc(limit + 1);
		let offset = 0;
		while (offset < content.byteLength) {
			const result = await handle.read(
				content,
				offset,
				content.byteLength - offset,
				null,
			);
			if (result.bytesRead === 0) break;
			offset += result.bytesRead;
		}
		if (offset > limit) {
			throw new DynamicRunDefinitionError("persistence", MSG_COPY_CORRUPT);
		}
		return content.subarray(0, offset);
	} finally {
		await handle.close();
	}
}

function decodeUtf8(content: Buffer): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch (error) {
		throw new DynamicRunDefinitionError("persistence", MSG_COPY_CORRUPT, {
			cause: error,
		});
	}
}

function parseCanonicalDocument(content: Buffer): unknown {
	const text = decodeUtf8(content);
	try {
		const value: unknown = JSON.parse(text);
		if (!canonicalDynamicDocument(value).equals(content)) {
			throw new Error("record bytes differ from their canonical form");
		}
		return value;
	} catch (error) {
		throw new DynamicRunDefinitionError("persistence", MSG_COPY_CORRUPT, {
			cause: error,
		});
	}
}

/**
 * Reads the run's definition copy with the store's read discipline
 * (`O_NOFOLLOW`, bounds, fatal UTF-8, canonical bytes). The proposal record
 * must be schema-valid; the source, manifest, and approval are returned for
 * {@link verifyRunDefinitionCopy}, whose refusals name what changed.
 */
export async function readRunDefinitionCopy(journal: {
	readonly directory: string;
}): Promise<DynamicRunDefinitionCopy> {
	const directory = path.join(
		journal.directory,
		DYNAMIC_RUN_DEFINITION_DIRECTORY,
	);
	const [sourceBytes, manifestBytes, proposalBytes, approvalBytes] =
		await Promise.all([
			readFileNoFollow(
				path.join(directory, DYNAMIC_SOURCE_FILE),
				MAX_DYNAMIC_SOURCE_BYTES,
			),
			readFileNoFollow(
				path.join(directory, DYNAMIC_MANIFEST_FILE),
				MAX_DYNAMIC_MANIFEST_BYTES,
			),
			readFileNoFollow(
				path.join(directory, DYNAMIC_PROPOSAL_FILE),
				MAX_DYNAMIC_PROPOSAL_RECORD_BYTES,
			),
			readFileNoFollow(
				path.join(directory, DYNAMIC_APPROVAL_FILE),
				MAX_WORKFLOW_DECISION_RECORD_BYTES,
			),
		]);
	const proposal = parseCanonicalDocument(proposalBytes);
	if (!Value.Check(DynamicWorkflowProposalRecordSchema, proposal)) {
		throw new DynamicRunDefinitionError("persistence", MSG_COPY_CORRUPT);
	}
	return Object.freeze({
		source: decodeUtf8(sourceBytes),
		manifest: parseCanonicalDocument(manifestBytes),
		proposal,
		approval: parseCanonicalDocument(approvalBytes),
	});
}

/**
 * `workflowForRecord` for dynamic runs, steps 2-7: the run directory copy is
 * the evidence; the proposal and decision stores are never consulted. Every
 * file of the copy is verified, `proposal.json` included: its digests must
 * agree with the run record and the approval, its embedded manifest must hash
 * to the approved digest, and its identity is recomputed, so an edited
 * proposal record is refused with the message naming what drifted rather
 * than composing a definition from tampered metadata.
 */
export function verifyRunDefinitionCopy(input: {
	readonly copy: DynamicRunDefinitionCopy;
	readonly record: {
		readonly cwd: string;
		readonly definitionIdentitySha256: string;
		readonly definitionSourceSha256: string;
		readonly approvalSha256: string;
		readonly hostApiSha256: string;
	};
	readonly current: {
		readonly cwd: string;
		readonly hostApiSha256: string;
		readonly importPolicySha256: string;
	};
}): VerifiedDynamicRunDefinition {
	const { copy, record, current } = input;
	const { proposal } = copy;
	const refuse = (message: string): never => {
		throw new DynamicRunDefinitionError("validation", message);
	};
	// 2. Source bytes and the proposal's source digest against the record.
	if (
		deriveDynamicSourceSha256(copy.source) !== record.definitionSourceSha256 ||
		proposal.sourceSha256 !== record.definitionSourceSha256
	) {
		refuse(MSG_SOURCE_CHANGED);
	}
	// 3. The approval record, bound to the recorded identity, source, and host API.
	const approval = copy.approval;
	if (
		!Value.Check(WorkflowDecisionRecordSchema, approval) ||
		deriveDecisionRecordSha256(approval) !== record.approvalSha256 ||
		!isDynamicSourceApprovalRecord(approval) ||
		approval.binding.definitionIdentitySha256 !==
			record.definitionIdentitySha256 ||
		approval.binding.sourceSha256 !== record.definitionSourceSha256 ||
		approval.value.hostApiSha256 !== record.hostApiSha256 ||
		approval.value.decision !== "approved"
	) {
		return refuse(MSG_APPROVAL_CHANGED);
	}
	// 4. The current host API and the proposal's against the record.
	if (
		current.hostApiSha256 !== record.hostApiSha256 ||
		proposal.hostApiSha256 !== record.hostApiSha256
	) {
		refuse(MSG_HOST_API_CHANGED);
	}
	// 5. The current import policy and the proposal's against the approval.
	if (
		current.importPolicySha256 !== approval.value.importPolicySha256 ||
		proposal.importPolicySha256 !== approval.value.importPolicySha256
	) {
		refuse(MSG_IMPORT_POLICY_CHANGED_SINCE_APPROVAL);
	}
	// 6. Both manifests and every manifest-bearing digest against the approval
	// and the recorded identity, which is recomputed from the proposal.
	let manifestSha256: string;
	let proposalManifestSha256: string;
	try {
		manifestSha256 = deriveJsonValueSha256(copy.manifest);
		proposalManifestSha256 = deriveJsonValueSha256(proposal.manifest);
	} catch {
		return refuse(MSG_MANIFEST_CHANGED);
	}
	if (
		!Value.Check(DynamicWorkflowManifestSchema, copy.manifest) ||
		manifestSha256 !== approval.value.manifestSha256 ||
		proposal.manifestSha256 !== approval.value.manifestSha256 ||
		proposalManifestSha256 !== approval.value.manifestSha256 ||
		proposal.definitionIdentitySha256 !== record.definitionIdentitySha256 ||
		deriveDynamicDefinitionIdentitySha256(proposal) !==
			record.definitionIdentitySha256
	) {
		return refuse(MSG_MANIFEST_CHANGED);
	}
	// 7. Project.
	if (current.cwd !== record.cwd) refuse(MSG_PROJECT_CHANGED);
	return Object.freeze({
		source: copy.source,
		manifest: copy.manifest,
		proposal,
		approval,
	});
}
