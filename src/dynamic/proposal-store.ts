import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	open,
	opendir,
	realpath,
	rename,
	rm,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import { canonicalArtifactJson } from "../artifact-store.js";
import { WORKFLOW_CONTRACT_REVISION } from "../contracts.js";
import { validateJsonSchemaDocument } from "../definition.js";
import { deriveJsonValueSha256 } from "../execution.js";
import {
	DYNAMIC_TRANSFORMER,
	MAX_DYNAMIC_MANIFEST_BYTES,
	MAX_DYNAMIC_PROPOSAL_RECORD_BYTES,
	MAX_DYNAMIC_PROPOSALS,
	MAX_DYNAMIC_SOURCE_BYTES,
} from "./constants.js";
import {
	type DynamicTransformerIdentity,
	type DynamicWorkflowManifest,
	DynamicWorkflowManifestSchema,
	type DynamicWorkflowProposalRecord,
	DynamicWorkflowProposalRecordSchema,
	type DynamicWorkflowProposer,
} from "./contracts.js";
import {
	deriveDynamicDefinitionIdentitySha256,
	deriveDynamicHostApiSha256,
} from "./identity.js";
import {
	DynamicSourceIntakeError,
	deriveDynamicSourceSha256,
	dynamicRef,
} from "./source.js";

export const DYNAMIC_SOURCE_FILE = "source.workflow.ts";
export const DYNAMIC_MANIFEST_FILE = "manifest.json";
export const DYNAMIC_PROPOSAL_FILE = "proposal.json";
export const DYNAMIC_DECISIONS_DIRECTORY = "decisions";
/** `<sha>/records/<version>/` holds one `manifest.json` + `proposal.json` pair. */
export const DYNAMIC_RECORDS_DIRECTORY = "records";
/** `<sha>/current`: the version name of the active pair, plus "\n". */
export const DYNAMIC_CURRENT_RECORDS_FILE = "current";

const DIGEST_NAME = /^[a-f0-9]{64}$/;
const RECORDS_VERSION_NAME = /^[a-f0-9]{32}$/;
const MAX_CURRENT_RECORDS_BYTES = 33;
const proposalMutations = new Map<string, Promise<void>>();

export class WorkflowDynamicStoreError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkflowDynamicStoreError";
	}
}

/** The store holds MAX_DYNAMIC_PROPOSALS digests and this one is new. */
export class WorkflowDynamicStoreFullError extends WorkflowDynamicStoreError {
	constructor() {
		super("dynamic workflow proposal store is full");
		this.name = "WorkflowDynamicStoreFullError";
	}
}

export interface DynamicWorkflowProposal {
	readonly record: DynamicWorkflowProposalRecord;
	/** Exact proposed source text. */
	readonly source: string;
	/** `<storeRoot>/dynamic/<sourceSha256>` */
	readonly directory: string;
	/** `<storeRoot>/dynamic/<sourceSha256>/source.workflow.ts` */
	readonly path: string;
	/** `<storeRoot>/dynamic/<sourceSha256>/decisions` */
	readonly decisionsDirectory: string;
	/** `<storeRoot>/dynamic/<sourceSha256>/records/<version>`: the active pair. */
	readonly recordsDirectory: string;
}

export type DynamicWorkflowProposalListing =
	| {
			readonly ref: `dynamic:${string}`;
			readonly proposal: DynamicWorkflowProposal;
	  }
	| { readonly ref: `dynamic:${string}`; readonly issue: string };

export interface DynamicWorkflowProposalPutResult {
	readonly proposal: DynamicWorkflowProposal;
	/** A new directory was created for the digest. */
	readonly created: boolean;
	/**
	 * The record pair was replaced: the host API changed, or the stored pair
	 * was inconsistent and rebuilt from this record.
	 */
	readonly replaced: boolean;
}

/** `canonicalArtifactJson(value) + "\n"`: the on-disk form of every record. */
export function canonicalDynamicDocument(value: unknown): Buffer {
	return Buffer.concat([canonicalArtifactJson(value), Buffer.from("\n")]);
}

function jsonClone<T>(value: T): T {
	return JSON.parse(canonicalArtifactJson(value).toString("utf8")) as T;
}

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const entry of Object.values(value)) deepFreeze(entry);
	}
	return value;
}

/**
 * Host-side validation of a manifest returned by the manifest VM; returns a
 * canonical frozen copy.
 */
export function validateDynamicWorkflowManifest(
	manifest: unknown,
): DynamicWorkflowManifest {
	const invalid = (cause?: unknown): DynamicSourceIntakeError =>
		new DynamicSourceIntakeError(
			"validation",
			"Dynamic workflow manifest is invalid.",
			cause === undefined ? undefined : { cause },
		);
	if (!Value.Check(DynamicWorkflowManifestSchema, manifest)) throw invalid();
	try {
		validateJsonSchemaDocument(manifest.inputSchema, "workflow input schema");
		validateJsonSchemaDocument(manifest.outputSchema, "workflow output schema");
	} catch (error) {
		throw invalid(error);
	}
	let canonical: Buffer;
	try {
		canonical = canonicalArtifactJson(manifest);
	} catch (error) {
		throw invalid(error);
	}
	if (canonical.byteLength > MAX_DYNAMIC_MANIFEST_BYTES) throw invalid();
	return deepFreeze(
		JSON.parse(canonical.toString("utf8")) as DynamicWorkflowManifest,
	);
}

/** The transformer identity as it is persisted in proposal records. */
export function dynamicTransformerIdentity(): DynamicTransformerIdentity {
	return jsonClone(DYNAMIC_TRANSFORMER) as DynamicTransformerIdentity;
}

/**
 * Builds the proposal record for a validated manifest; digests are derived
 * here so the record is consistent by construction.
 */
export function createDynamicWorkflowProposalRecord(input: {
	readonly sourceSha256: string;
	readonly sourceBytes: number;
	readonly manifest: DynamicWorkflowManifest;
	readonly importPolicySha256: string;
	readonly proposer: DynamicWorkflowProposer;
	readonly proposedAt: string;
	readonly projectRoot: string;
}): DynamicWorkflowProposalRecord {
	const manifest = validateDynamicWorkflowManifest(input.manifest);
	const manifestSha256 = deriveJsonValueSha256(manifest);
	const hostApiSha256 = deriveDynamicHostApiSha256();
	return deepFreeze({
		schema: "pi-workflow-dynamic-proposal",
		contractRevision: WORKFLOW_CONTRACT_REVISION,
		sourceSha256: input.sourceSha256,
		sourceBytes: input.sourceBytes,
		manifest,
		manifestSha256,
		hostApiSha256,
		importPolicySha256: input.importPolicySha256,
		definitionIdentitySha256: deriveDynamicDefinitionIdentitySha256({
			sourceSha256: input.sourceSha256,
			manifestSha256,
			hostApiSha256,
		}),
		transformer: dynamicTransformerIdentity(),
		proposer: jsonClone(input.proposer),
		proposedAt: input.proposedAt,
		projectRoot: input.projectRoot,
	});
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
	const handle = await open(filePath, "wx", 0o600);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** Bounded, symlink-refusing read; `undefined` when absent. */
async function readFileNoFollow(
	filePath: string,
	limit: number,
): Promise<Buffer | undefined> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return undefined;
		if (code === "ELOOP") {
			throw new WorkflowDynamicStoreError(
				"dynamic workflow record may not be a symlink",
			);
		}
		throw error;
	}
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile()) {
			throw new WorkflowDynamicStoreError("invalid dynamic workflow record");
		}
		if (metadata.size > limit) {
			throw new WorkflowDynamicStoreError(
				"dynamic workflow record exceeds size limit",
			);
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
			throw new WorkflowDynamicStoreError(
				"dynamic workflow record exceeds size limit",
			);
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
		throw new WorkflowDynamicStoreError(
			"dynamic workflow record is not valid UTF-8",
			{ cause: error },
		);
	}
}

function parseCanonicalDocument(content: Buffer): unknown {
	const text = decodeUtf8(content);
	let value: unknown;
	try {
		value = JSON.parse(text);
		if (!canonicalDynamicDocument(value).equals(content)) {
			throw new Error("record bytes differ from their canonical form");
		}
	} catch (error) {
		throw new WorkflowDynamicStoreError(
			"dynamic workflow record is not canonical",
			{ cause: error },
		);
	}
	return value;
}

/**
 * `lstat` of a store directory: `"missing"` on ENOENT; a symlink or a
 * non-directory is refused.
 */
async function statStoreDirectory(
	directory: string,
): Promise<"present" | "missing"> {
	let metadata: Awaited<ReturnType<typeof lstat>>;
	try {
		metadata = await lstat(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		throw error;
	}
	if (metadata.isSymbolicLink()) {
		throw new WorkflowDynamicStoreError(
			"dynamic workflow record may not be a symlink",
		);
	}
	if (!metadata.isDirectory()) {
		throw new WorkflowDynamicStoreError(
			"invalid dynamic workflow proposal directory",
		);
	}
	return "present";
}

function newRecordsVersion(): string {
	return randomBytes(16).toString("hex");
}

/**
 * Writes one `manifest.json` + `proposal.json` pair into
 * `<records>/<version>/` through a staged directory (`wx`, fsync, one
 * rename) and returns the version name. The pair is not visible to readers
 * until `writeCurrentRecords` points at it.
 */
async function stageRecords(
	recordsDirectory: string,
	manifestBytes: Buffer,
	recordBytes: Buffer,
): Promise<string> {
	await mkdir(recordsDirectory, { recursive: true, mode: 0o700 });
	const version = newRecordsVersion();
	const temporary = path.join(
		recordsDirectory,
		`.${version}.${process.pid}.${randomUUID()}.tmp`,
	);
	await mkdir(temporary, { recursive: false, mode: 0o700 });
	try {
		await writeExclusive(
			path.join(temporary, DYNAMIC_MANIFEST_FILE),
			manifestBytes,
		);
		await writeExclusive(
			path.join(temporary, DYNAMIC_PROPOSAL_FILE),
			recordBytes,
		);
		await syncDirectory(temporary);
		await rename(temporary, path.join(recordsDirectory, version));
	} catch (error) {
		await rm(temporary, { recursive: true, force: true });
		throw error;
	}
	await syncDirectory(recordsDirectory);
	return version;
}

/**
 * Points `<sha>/current` at a staged pair with one atomic rename: a reader
 * sees the previous pair up to the rename and the new pair from it, never a
 * mix, whatever happens in between.
 */
async function writeCurrentRecords(
	directory: string,
	version: string,
): Promise<void> {
	const target = path.join(directory, DYNAMIC_CURRENT_RECORDS_FILE);
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	await writeExclusive(temporary, Buffer.from(`${version}\n`, "utf8"));
	await rename(temporary, target);
	await syncDirectory(directory);
}

/**
 * Best-effort removal of every superseded pair. Called before a new pair is
 * staged, never right after a swap, so a reader that resolved the previous
 * pointer moments ago still finds its files.
 */
async function reapRecords(
	recordsDirectory: string,
	current: string | undefined,
): Promise<void> {
	let entries: Awaited<ReturnType<typeof opendir>>;
	try {
		entries = await opendir(recordsDirectory);
	} catch {
		return;
	}
	for await (const entry of entries) {
		if (
			!entry.isDirectory() ||
			!RECORDS_VERSION_NAME.test(entry.name) ||
			entry.name === current
		) {
			continue;
		}
		await rm(path.join(recordsDirectory, entry.name), {
			recursive: true,
			force: true,
		}).catch(() => undefined);
	}
}

/**
 * Proposals keyed by source digest under `<storeRoot>/dynamic/<sha>/`:
 * `source.workflow.ts` (exact bytes), `records/<version>/` holding one
 * `manifest.json` + `proposal.json` pair (canonical + "\n"), `current`
 * naming the active version, and `decisions/` (a definition-level decision
 * store). Source bytes are immutable. The record pair is derived data: a host
 * API change stages a new pair and swaps `current` with one rename, so a
 * crash or a concurrent read never sees `manifest.json` and `proposal.json`
 * from different pairs; a pair found inconsistent is rebuilt by the next
 * `put` of the same bytes.
 */
export class DynamicWorkflowProposalStore {
	/** Canonical `<storeRoot>/dynamic`. */
	readonly root: string;

	private constructor(root: string) {
		this.root = root;
	}

	static async open(options: {
		storeRoot: string;
	}): Promise<DynamicWorkflowProposalStore> {
		const storeRoot = path.resolve(options.storeRoot);
		await mkdir(storeRoot, { recursive: true, mode: 0o700 });
		const canonicalStoreRoot = await realpath(storeRoot);
		const expected = path.join(canonicalStoreRoot, "dynamic");
		await mkdir(expected, { recursive: true, mode: 0o700 });
		const root = await realpath(expected);
		if (
			path.dirname(root) !== canonicalStoreRoot ||
			path.basename(root) !== "dynamic"
		) {
			throw new WorkflowDynamicStoreError(
				"dynamic workflow store escapes its root",
			);
		}
		await chmod(root, 0o700);
		return new DynamicWorkflowProposalStore(root);
	}

	directoryFor(sourceSha256: string): string {
		if (!DIGEST_NAME.test(sourceSha256)) {
			throw new WorkflowDynamicStoreError(
				"invalid dynamic workflow source digest",
			);
		}
		return path.join(this.root, sourceSha256);
	}

	sourcePathFor(sourceSha256: string): string {
		return path.join(this.directoryFor(sourceSha256), DYNAMIC_SOURCE_FILE);
	}

	decisionsDirectoryFor(sourceSha256: string): string {
		return path.join(
			this.directoryFor(sourceSha256),
			DYNAMIC_DECISIONS_DIRECTORY,
		);
	}

	/** Serializes mutations of this store root process-wide. */
	private mutate<T>(operation: () => Promise<T>): Promise<T> {
		const predecessor = proposalMutations.get(this.root) ?? Promise.resolve();
		const result = predecessor.then(operation);
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		proposalMutations.set(this.root, settled);
		void settled.then(() => {
			if (proposalMutations.get(this.root) === settled) {
				proposalMutations.delete(this.root);
			}
		});
		return result;
	}

	/** Sorted digests of proposal directories, at most MAX_DYNAMIC_PROPOSALS. */
	private async digests(): Promise<string[]> {
		const names: string[] = [];
		const directory = await opendir(this.root);
		try {
			for await (const entry of directory) {
				if (!DIGEST_NAME.test(entry.name) || !entry.isDirectory()) continue;
				names.push(entry.name);
			}
		} finally {
			// opendir's async iterator closes the handle on completion.
		}
		return names.sort().slice(0, MAX_DYNAMIC_PROPOSALS);
	}

	async count(): Promise<number> {
		return (await this.digests()).length;
	}

	/**
	 * Verified read of one proposal; `undefined` when no directory exists for
	 * the digest. Every failure is a WorkflowDynamicStoreError. The pair named
	 * by `current` is the only one consulted.
	 */
	async read(
		sourceSha256: string,
	): Promise<DynamicWorkflowProposal | undefined> {
		const directory = this.directoryFor(sourceSha256);
		if ((await statStoreDirectory(directory)) === "missing") return undefined;
		const invalid = (): WorkflowDynamicStoreError =>
			new WorkflowDynamicStoreError("invalid dynamic workflow proposal record");
		const [sourceBytes, currentBytes] = await Promise.all([
			readFileNoFollow(
				path.join(directory, DYNAMIC_SOURCE_FILE),
				MAX_DYNAMIC_SOURCE_BYTES,
			),
			readFileNoFollow(
				path.join(directory, DYNAMIC_CURRENT_RECORDS_FILE),
				MAX_CURRENT_RECORDS_BYTES,
			),
		]);
		if (sourceBytes === undefined || currentBytes === undefined) {
			throw invalid();
		}
		const current = decodeUtf8(currentBytes);
		if (!current.endsWith("\n")) throw invalid();
		const version = current.slice(0, -1);
		if (!RECORDS_VERSION_NAME.test(version)) throw invalid();
		const records = path.join(directory, DYNAMIC_RECORDS_DIRECTORY);
		const recordsDirectory = path.join(records, version);
		if (
			(await statStoreDirectory(records)) === "missing" ||
			(await statStoreDirectory(recordsDirectory)) === "missing"
		) {
			throw invalid();
		}
		const [manifestBytes, recordBytes] = await Promise.all([
			readFileNoFollow(
				path.join(recordsDirectory, DYNAMIC_MANIFEST_FILE),
				MAX_DYNAMIC_MANIFEST_BYTES,
			),
			readFileNoFollow(
				path.join(recordsDirectory, DYNAMIC_PROPOSAL_FILE),
				MAX_DYNAMIC_PROPOSAL_RECORD_BYTES,
			),
		]);
		if (manifestBytes === undefined || recordBytes === undefined) {
			throw invalid();
		}
		const source = decodeUtf8(sourceBytes);
		const manifest = parseCanonicalDocument(manifestBytes);
		const record = parseCanonicalDocument(recordBytes);
		if (
			!Value.Check(DynamicWorkflowProposalRecordSchema, record) ||
			record.sourceBytes !== sourceBytes.byteLength
		) {
			throw invalid();
		}
		if (
			deriveDynamicSourceSha256(source) !== record.sourceSha256 ||
			record.sourceSha256 !== sourceSha256
		) {
			throw new WorkflowDynamicStoreError(
				"dynamic workflow source digest mismatch",
			);
		}
		if (
			deriveJsonValueSha256(manifest) !== record.manifestSha256 ||
			deriveJsonValueSha256(record.manifest) !== record.manifestSha256 ||
			deriveDynamicDefinitionIdentitySha256(record) !==
				record.definitionIdentitySha256
		) {
			throw new WorkflowDynamicStoreError(
				"dynamic workflow manifest digest mismatch",
			);
		}
		return deepFreeze({
			record,
			source,
			directory,
			path: path.join(directory, DYNAMIC_SOURCE_FILE),
			decisionsDirectory: path.join(directory, DYNAMIC_DECISIONS_DIRECTORY),
			recordsDirectory,
		});
	}

	/** `read` after a mutation of this store: the directory must exist. */
	private async reread(sourceSha256: string): Promise<DynamicWorkflowProposal> {
		const proposal = await this.read(sourceSha256);
		if (proposal === undefined) {
			throw new WorkflowDynamicStoreError(
				"invalid dynamic workflow proposal record",
			);
		}
		return proposal;
	}

	/**
	 * Whether `<sha>/source.workflow.ts` holds exactly `sourceBytes` (a real
	 * directory, a real file): the precondition for rebuilding an
	 * inconsistent record pair, since source bytes are never rewritten.
	 */
	private async holdsSource(
		directory: string,
		sourceBytes: Buffer,
	): Promise<boolean> {
		try {
			if ((await statStoreDirectory(directory)) === "missing") return false;
			const stored = await readFileNoFollow(
				path.join(directory, DYNAMIC_SOURCE_FILE),
				MAX_DYNAMIC_SOURCE_BYTES,
			);
			return stored?.equals(sourceBytes) ?? false;
		} catch {
			return false;
		}
	}

	/**
	 * Replaces the active pair of an existing digest: superseded pairs are
	 * reaped, the new pair is staged, then `current` is swapped atomically.
	 * `source.workflow.ts` and `decisions/` are untouched.
	 */
	private async replaceRecords(
		directory: string,
		current: string | undefined,
		manifestBytes: Buffer,
		recordBytes: Buffer,
	): Promise<void> {
		const records = path.join(directory, DYNAMIC_RECORDS_DIRECTORY);
		await reapRecords(records, current);
		const version = await stageRecords(records, manifestBytes, recordBytes);
		await writeCurrentRecords(directory, version);
	}

	/**
	 * Creates the proposal directory for a new digest, returns the existing
	 * proposal when the digest is known and its host API is current, replaces
	 * the record pair when the host API changed, or rebuilds the pair when the
	 * stored one is inconsistent but the source bytes are intact. Source bytes
	 * are never rewritten.
	 */
	async put(input: {
		readonly source: string;
		readonly record: DynamicWorkflowProposalRecord;
	}): Promise<DynamicWorkflowProposalPutResult> {
		const { source, record } = input;
		if (!Value.Check(DynamicWorkflowProposalRecordSchema, record)) {
			throw new WorkflowDynamicStoreError(
				"invalid dynamic workflow proposal record",
			);
		}
		if (
			typeof source !== "string" ||
			Buffer.byteLength(source, "utf8") !== record.sourceBytes ||
			deriveDynamicSourceSha256(source) !== record.sourceSha256
		) {
			throw new WorkflowDynamicStoreError(
				"dynamic workflow source digest mismatch",
			);
		}
		if (
			deriveJsonValueSha256(record.manifest) !== record.manifestSha256 ||
			deriveDynamicDefinitionIdentitySha256(record) !==
				record.definitionIdentitySha256
		) {
			throw new WorkflowDynamicStoreError(
				"dynamic workflow manifest digest mismatch",
			);
		}
		const recordBytes = canonicalDynamicDocument(record);
		const manifestBytes = canonicalDynamicDocument(record.manifest);
		if (recordBytes.byteLength > MAX_DYNAMIC_PROPOSAL_RECORD_BYTES) {
			throw new WorkflowDynamicStoreError(
				"dynamic workflow record exceeds size limit",
			);
		}
		const sourceBytes = Buffer.from(source, "utf8");
		const target = this.directoryFor(record.sourceSha256);
		return this.mutate(async () => {
			let existing: DynamicWorkflowProposal | undefined;
			try {
				existing = await this.read(record.sourceSha256);
			} catch (error) {
				// Repair: the immutable source bytes are intact but the record
				// pair is not (a tampered or dangling `current`, an edited
				// record). Anything else fails closed as before.
				if (
					!(error instanceof WorkflowDynamicStoreError) ||
					!(await this.holdsSource(target, sourceBytes))
				) {
					throw error;
				}
				await this.replaceRecords(
					target,
					undefined,
					manifestBytes,
					recordBytes,
				);
				return {
					proposal: await this.reread(record.sourceSha256),
					created: false,
					replaced: true,
				};
			}
			if (existing !== undefined) {
				if (existing.record.hostApiSha256 === record.hostApiSha256) {
					if (!isDeepStrictEqual(existing.record.manifest, record.manifest)) {
						throw new WorkflowDynamicStoreError(
							"dynamic workflow proposal manifest differs from the stored manifest",
						);
					}
					return { proposal: existing, created: false, replaced: false };
				}
				await this.replaceRecords(
					target,
					path.basename(existing.recordsDirectory),
					manifestBytes,
					recordBytes,
				);
				return {
					proposal: await this.reread(record.sourceSha256),
					created: false,
					replaced: true,
				};
			}
			if ((await this.count()) >= MAX_DYNAMIC_PROPOSALS) {
				throw new WorkflowDynamicStoreFullError();
			}
			const temporary = path.join(
				this.root,
				`.${record.sourceSha256}.${process.pid}.${randomUUID()}.tmp`,
			);
			await mkdir(temporary, { recursive: false, mode: 0o700 });
			try {
				await writeExclusive(
					path.join(temporary, DYNAMIC_SOURCE_FILE),
					sourceBytes,
				);
				const version = await stageRecords(
					path.join(temporary, DYNAMIC_RECORDS_DIRECTORY),
					manifestBytes,
					recordBytes,
				);
				await writeCurrentRecords(temporary, version);
				await rename(temporary, target);
			} catch (error) {
				await rm(temporary, { recursive: true, force: true });
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
				return {
					proposal: await this.reread(record.sourceSha256),
					created: false,
					replaced: false,
				};
			}
			await syncDirectory(this.root);
			return {
				proposal: await this.reread(record.sourceSha256),
				created: true,
				replaced: false,
			};
		});
	}

	/**
	 * Bounded directory scan (the only scan in the dynamic track): sorted by
	 * digest, at most MAX_DYNAMIC_PROPOSALS entries; a corrupt entry becomes
	 * `{ ref, issue }` instead of failing the listing.
	 */
	async list(): Promise<readonly DynamicWorkflowProposalListing[]> {
		const listings: DynamicWorkflowProposalListing[] = [];
		for (const digest of await this.digests()) {
			const ref = dynamicRef(digest);
			try {
				const proposal = await this.read(digest);
				if (proposal === undefined) continue;
				listings.push({ ref, proposal });
			} catch (error) {
				if (!(error instanceof WorkflowDynamicStoreError)) throw error;
				listings.push({ ref, issue: error.message });
			}
		}
		return Object.freeze(listings);
	}
}
