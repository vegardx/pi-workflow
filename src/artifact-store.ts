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
import { Value } from "typebox/value";
import {
	type WorkflowArtifactRef,
	WorkflowArtifactRefSchema,
} from "./contracts.js";
import { deriveWorkflowArtifactId } from "./execution.js";
import type { WorkflowRunJournal } from "./persistence/journal.js";

export const MAX_WORKFLOW_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_WORKFLOW_ARTIFACT_STORE_BYTES = 256 * 1024 * 1024;

const artifactMutations = new Map<string, Promise<void>>();

export class WorkflowArtifactStoreError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkflowArtifactStoreError";
	}
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

	private async totalBytes(): Promise<number> {
		let total = 0;
		for (const entry of await readdir(this.root)) {
			if (!entry.endsWith(".json")) {
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

	putJson(
		value: unknown,
		metadata: {
			runId: WorkflowArtifactRef["runId"];
			producerTaskId: NonNullable<WorkflowArtifactRef["producerTaskId"]>;
			output: "result";
			schemaSha256: string;
		},
	): Promise<WorkflowArtifactRef> {
		const content = canonicalArtifactJson(value);
		const predecessor = artifactMutations.get(this.root) ?? Promise.resolve();
		const operation = predecessor.then(() =>
			this.journal.withCurrent(async () => {
				if (content.byteLength > this.maxArtifactBytes) {
					throw new WorkflowArtifactStoreError(
						"workflow artifact exceeds byte limit",
					);
				}
				const digest = sha256(content);
				const ref: WorkflowArtifactRef = {
					id: deriveWorkflowArtifactId({ ...metadata, sha256: digest }),
					runId: metadata.runId,
					producerTaskId: metadata.producerTaskId,
					output: metadata.output,
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
				const target = path.join(this.root, `${digest}.json`);
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
					return ref;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				if (
					(await this.totalBytes()) + content.byteLength >
					this.maxTotalBytes
				) {
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
				return ref;
			}),
		);
		const settled = operation.then(
			() => undefined,
			() => undefined,
		);
		artifactMutations.set(this.root, settled);
		void settled.then(() => {
			if (artifactMutations.get(this.root) === settled) {
				artifactMutations.delete(this.root);
			}
		});
		return operation;
	}

	async readJson(ref: WorkflowArtifactRef): Promise<unknown> {
		if (
			!Value.Check(WorkflowArtifactRefSchema, ref) ||
			ref.runId !== this.journal.runId ||
			ref.producerTaskId === undefined ||
			ref.output !== "result" ||
			ref.id !==
				deriveWorkflowArtifactId({
					runId: ref.runId,
					producerTaskId: ref.producerTaskId,
					output: ref.output,
					schemaSha256: ref.schemaSha256,
					sha256: ref.sha256,
				}) ||
			ref.mediaType !== "application/json"
		) {
			throw new WorkflowArtifactStoreError(
				"invalid workflow artifact reference",
			);
		}
		if (ref.bytes > this.maxArtifactBytes) {
			throw new WorkflowArtifactStoreError(
				"workflow artifact read exceeds byte limit",
			);
		}
		const target = path.join(this.root, `${ref.sha256}.json`);
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
}
