import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
} from "node:fs/promises";
import path from "node:path";
import { HANDOFF_EXPORT_MEDIA_TYPE } from "@vegardx/pi-subagent";
import { Value } from "typebox/value";
import {
	MAX_WORKFLOW_HANDOFF_BYTES,
	WORKFLOW_HANDOFF_FORMAT_SHA256,
	type WorkflowArtifactRef,
	WorkflowArtifactRefSchema,
} from "./contracts.js";
import { deriveWorkflowArtifactId } from "./execution.js";
import type { WorkflowRunJournal } from "./persistence/journal.js";

export const MAX_WORKFLOW_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_WORKFLOW_ARTIFACT_STORE_BYTES = 256 * 1024 * 1024;

/** git's fixed mbox separator line; the object id is checked by the importer. */
const HANDOFF_PATCH_FIRST_LINE =
	/^From [a-f0-9]{40,64} Mon Sep 17 00:00:00 2001$/;

const artifactMutations = new Map<string, Promise<void>>();

export class WorkflowArtifactStoreError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkflowArtifactStoreError";
	}
}

export interface WorkflowHandoffArtifactMetadata {
	runId: WorkflowArtifactRef["runId"];
	producerTaskId: NonNullable<WorkflowArtifactRef["producerTaskId"]>;
	producerExecutionId: NonNullable<WorkflowArtifactRef["producerExecutionId"]>;
	output: "handoff";
	mediaType: typeof HANDOFF_EXPORT_MEDIA_TYPE;
	schemaSha256: typeof WORKFLOW_HANDOFF_FORMAT_SHA256;
}

function sha256(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function canonicalize(value: unknown, seen: Set<object>): unknown {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new WorkflowArtifactStoreError(
				"artifact contains non-finite number",
			);
		}
		return value;
	}
	if (typeof value !== "object") {
		throw new WorkflowArtifactStoreError("artifact is not JSON-serializable");
	}
	if (seen.has(value)) {
		throw new WorkflowArtifactStoreError("artifact contains a cycle");
	}
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((entry) => canonicalize(entry, seen));
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new WorkflowArtifactStoreError(
				"artifact contains non-plain object",
			);
		}
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => {
					const entry = (value as Record<string, unknown>)[key];
					if (entry === undefined) {
						throw new WorkflowArtifactStoreError(
							"artifact contains undefined field",
						);
					}
					return [key, canonicalize(entry, seen)];
				}),
		);
	} finally {
		seen.delete(value);
	}
}

export function canonicalArtifactJson(value: unknown): Buffer {
	return Buffer.from(JSON.stringify(canonicalize(value, new Set())), "utf8");
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function producerFieldsAppearTogether(metadata: {
	producerTaskId?: unknown;
	producerExecutionId?: unknown;
	output?: unknown;
}): boolean {
	return (
		(metadata.producerTaskId === undefined) ===
			(metadata.output === undefined) &&
		(metadata.producerTaskId === undefined) ===
			(metadata.producerExecutionId === undefined)
	);
}

export class WorkflowArtifactStore {
	readonly root: string;
	readonly runId: WorkflowArtifactRef["runId"];
	readonly maxArtifactBytes: number;
	readonly maxTotalBytes: number;
	private readonly journal: WorkflowRunJournal;

	private constructor(
		root: string,
		maxArtifactBytes: number,
		maxTotalBytes: number,
		journal: WorkflowRunJournal,
	) {
		this.root = root;
		this.runId = journal.runId;
		this.maxArtifactBytes = maxArtifactBytes;
		this.maxTotalBytes = maxTotalBytes;
		this.journal = journal;
	}

	static async open(options: {
		journal: WorkflowRunJournal;
		maxArtifactBytes?: number;
		maxTotalBytes?: number;
	}): Promise<WorkflowArtifactStore> {
		const maxArtifactBytes =
			options.maxArtifactBytes ?? MAX_WORKFLOW_ARTIFACT_BYTES;
		const maxTotalBytes =
			options.maxTotalBytes ?? MAX_WORKFLOW_ARTIFACT_STORE_BYTES;
		if (
			!Number.isSafeInteger(maxArtifactBytes) ||
			maxArtifactBytes < 0 ||
			!Number.isSafeInteger(maxTotalBytes) ||
			maxTotalBytes < maxArtifactBytes
		) {
			throw new WorkflowArtifactStoreError("invalid workflow artifact bounds");
		}
		return options.journal.withCurrent(async () => {
			const expected = path.join(options.journal.directory, "artifacts");
			await mkdir(expected, { recursive: true, mode: 0o700 });
			const root = await realpath(expected);
			if (
				path.dirname(root) !== options.journal.directory ||
				path.basename(root) !== "artifacts"
			) {
				throw new WorkflowArtifactStoreError(
					"workflow artifact directory escapes its run",
				);
			}
			await chmod(root, 0o700);
			return new WorkflowArtifactStore(
				root,
				maxArtifactBytes,
				maxTotalBytes,
				options.journal,
			);
		});
	}

	/** The per-blob bound of a handoff: the store bound capped by the contract bound. */
	private get maxHandoffBytes(): number {
		return Math.min(this.maxArtifactBytes, MAX_WORKFLOW_HANDOFF_BYTES);
	}

	private async totalBytes(): Promise<number> {
		let total = 0;
		for (const entry of await readdir(this.root)) {
			if (!entry.endsWith(".json") && !entry.endsWith(".patch")) {
				throw new WorkflowArtifactStoreError(
					`invalid workflow artifact entry: ${entry}`,
				);
			}
			const metadata = await lstat(path.join(this.root, entry));
			if (!metadata.isFile() || metadata.isSymbolicLink()) {
				throw new WorkflowArtifactStoreError(
					`invalid workflow artifact entry: ${entry}`,
				);
			}
			total += metadata.size;
			if (total > this.maxTotalBytes) {
				throw new WorkflowArtifactStoreError(
					"workflow artifact store exceeds total limit",
				);
			}
		}
		return total;
	}

	/**
	 * Serializes a store mutation behind every earlier mutation of the same
	 * directory (process-wide) and fences it on the current lease.
	 */
	private mutate<T>(operation: () => Promise<T>): Promise<T> {
		const predecessor = artifactMutations.get(this.root) ?? Promise.resolve();
		const result = predecessor.then(() => this.journal.withCurrent(operation));
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		artifactMutations.set(this.root, settled);
		void settled.then(() => {
			if (artifactMutations.get(this.root) === settled) {
				artifactMutations.delete(this.root);
			}
		});
		return result;
	}

	/**
	 * Writes a content-addressed blob unless an identical one already exists.
	 * Must run inside {@link mutate}.
	 */
	private async persist(
		content: Buffer,
		digest: string,
		extension: ".json" | ".patch",
	): Promise<void> {
		const target = path.join(this.root, `${digest}${extension}`);
		try {
			const existing = await lstat(target);
			if (
				!existing.isFile() ||
				existing.isSymbolicLink() ||
				existing.size !== content.byteLength ||
				sha256(await readFile(target)) !== digest
			) {
				throw new WorkflowArtifactStoreError(
					"existing workflow artifact does not match its digest",
				);
			}
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if ((await this.totalBytes()) + content.byteLength > this.maxTotalBytes) {
			throw new WorkflowArtifactStoreError(
				"workflow artifact store total limit exceeded",
			);
		}
		const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(content);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, target);
		await syncDirectory(this.root);
	}

	putJson(
		value: unknown,
		metadata: {
			runId: WorkflowArtifactRef["runId"];
			producerTaskId?: NonNullable<WorkflowArtifactRef["producerTaskId"]>;
			producerExecutionId?: NonNullable<
				WorkflowArtifactRef["producerExecutionId"]
			>;
			output?: "result";
			schemaSha256: string;
		},
	): Promise<WorkflowArtifactRef> {
		if (!producerFieldsAppearTogether(metadata)) {
			throw new WorkflowArtifactStoreError(
				"artifact producer, execution, and output must appear together",
			);
		}
		const content = canonicalArtifactJson(value);
		return this.mutate(async () => {
			if (content.byteLength > this.maxArtifactBytes) {
				throw new WorkflowArtifactStoreError(
					"workflow artifact exceeds byte limit",
				);
			}
			const digest = sha256(content);
			const ref: WorkflowArtifactRef = {
				id: deriveWorkflowArtifactId({ ...metadata, sha256: digest }),
				runId: metadata.runId,
				...(metadata.producerTaskId === undefined
					? {}
					: {
							producerTaskId: metadata.producerTaskId,
							producerExecutionId: metadata.producerExecutionId,
							output: metadata.output,
						}),
				sha256: digest,
				bytes: content.byteLength,
				mediaType: "application/json",
				schemaSha256: metadata.schemaSha256,
			};
			if (!Value.Check(WorkflowArtifactRefSchema, ref)) {
				throw new WorkflowArtifactStoreError(
					"invalid workflow artifact metadata",
				);
			}
			await this.persist(content, digest, ".json");
			return ref;
		});
	}

	/**
	 * Stores an exported pi-subagent handoff as a content-addressed `.patch`
	 * blob. The store verifies bounds and metadata only; the importer proves
	 * the patch identity before calling this.
	 */
	async putBytes(
		content: Buffer,
		metadata: WorkflowHandoffArtifactMetadata,
	): Promise<WorkflowArtifactRef> {
		if (!producerFieldsAppearTogether(metadata)) {
			throw new WorkflowArtifactStoreError(
				"artifact producer, execution, and output must appear together",
			);
		}
		if (
			metadata.producerTaskId === undefined ||
			metadata.producerExecutionId === undefined ||
			metadata.output !== "handoff" ||
			metadata.mediaType !== HANDOFF_EXPORT_MEDIA_TYPE ||
			metadata.schemaSha256 !== WORKFLOW_HANDOFF_FORMAT_SHA256
		) {
			throw new WorkflowArtifactStoreError(
				"invalid workflow handoff artifact metadata",
			);
		}
		if (content.byteLength < 1) {
			throw new WorkflowArtifactStoreError(
				"workflow handoff artifact is empty",
			);
		}
		if (content.byteLength > this.maxHandoffBytes) {
			throw new WorkflowArtifactStoreError(
				"workflow handoff artifact exceeds byte limit",
			);
		}
		return this.mutate(async () => {
			const digest = sha256(content);
			const ref: WorkflowArtifactRef = {
				id: deriveWorkflowArtifactId({
					runId: metadata.runId,
					producerTaskId: metadata.producerTaskId,
					producerExecutionId: metadata.producerExecutionId,
					output: metadata.output,
					schemaSha256: metadata.schemaSha256,
					sha256: digest,
				}),
				runId: metadata.runId,
				producerTaskId: metadata.producerTaskId,
				producerExecutionId: metadata.producerExecutionId,
				output: metadata.output,
				sha256: digest,
				bytes: content.byteLength,
				mediaType: metadata.mediaType,
				schemaSha256: metadata.schemaSha256,
			};
			if (!Value.Check(WorkflowArtifactRefSchema, ref)) {
				throw new WorkflowArtifactStoreError(
					"invalid workflow handoff artifact metadata",
				);
			}
			await this.persist(content, digest, ".patch");
			return ref;
		});
	}

	/** Schema, run, and deterministic-id checks shared by every reader. */
	private isOwnReference(ref: WorkflowArtifactRef): boolean {
		return (
			Value.Check(WorkflowArtifactRefSchema, ref) &&
			ref.runId === this.journal.runId &&
			ref.id ===
				deriveWorkflowArtifactId({
					runId: ref.runId,
					...(ref.producerTaskId === undefined
						? {}
						: {
								producerTaskId: ref.producerTaskId,
								producerExecutionId: ref.producerExecutionId,
								output: ref.output,
							}),
					schemaSha256: ref.schemaSha256,
					sha256: ref.sha256,
				})
		);
	}

	/** lstat regular-file/non-symlink/size and sha256 verification of a blob. */
	private async readVerified(
		ref: WorkflowArtifactRef,
		extension: ".json" | ".patch",
	): Promise<Buffer> {
		const target = path.join(this.root, `${ref.sha256}${extension}`);
		const metadata = await lstat(target);
		if (
			!metadata.isFile() ||
			metadata.isSymbolicLink() ||
			metadata.size !== ref.bytes
		) {
			throw new WorkflowArtifactStoreError(
				"workflow artifact metadata mismatch",
			);
		}
		const content = await readFile(target);
		if (sha256(content) !== ref.sha256) {
			throw new WorkflowArtifactStoreError("workflow artifact digest mismatch");
		}
		return content;
	}

	async readJson(ref: WorkflowArtifactRef): Promise<unknown> {
		if (!this.isOwnReference(ref) || ref.mediaType !== "application/json") {
			throw new WorkflowArtifactStoreError(
				"invalid workflow artifact reference",
			);
		}
		if (ref.bytes > this.maxArtifactBytes) {
			throw new WorkflowArtifactStoreError(
				"workflow artifact read exceeds byte limit",
			);
		}
		const content = await this.readVerified(ref, ".json");
		let value: unknown;
		try {
			value = JSON.parse(content.toString("utf8"));
		} catch (error) {
			throw new WorkflowArtifactStoreError(
				"workflow artifact JSON is invalid",
				{
					cause: error,
				},
			);
		}
		if (!canonicalArtifactJson(value).equals(content)) {
			throw new WorkflowArtifactStoreError(
				"workflow artifact JSON is not canonical",
			);
		}
		return value;
	}

	/**
	 * Reads a handoff blob and verifies its digest and git-format-patch shape.
	 * The embedded object id is compared to the settled handoff by the caller.
	 */
	async readBytes(ref: WorkflowArtifactRef): Promise<Buffer> {
		if (
			!this.isOwnReference(ref) ||
			ref.producerTaskId === undefined ||
			ref.output !== "handoff" ||
			ref.mediaType !== HANDOFF_EXPORT_MEDIA_TYPE ||
			ref.schemaSha256 !== WORKFLOW_HANDOFF_FORMAT_SHA256 ||
			ref.bytes < 1 ||
			ref.bytes > this.maxHandoffBytes
		) {
			throw new WorkflowArtifactStoreError(
				"invalid workflow artifact reference",
			);
		}
		const content = await this.readVerified(ref, ".patch");
		const newline = content.indexOf(0x0a);
		if (
			newline === -1 ||
			!HANDOFF_PATCH_FIRST_LINE.test(
				content.subarray(0, newline).toString("utf8"),
			)
		) {
			throw new WorkflowArtifactStoreError(
				"workflow handoff artifact is not a git-format-patch",
			);
		}
		return content;
	}
}
