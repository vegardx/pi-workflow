import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readFile,
	realpath,
	rename,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { canonicalArtifactJson } from "./artifact-store.js";
import {
	CheckpointDecisionSourceSchema,
	TaskExecutionIdSchema,
	WORKFLOW_CONTRACT_REVISION,
	WorkflowRunIdSchema,
	WorkflowTaskIdSchema,
} from "./contracts.js";
import {
	DYNAMIC_SOURCE_APPROVAL_SCHEMA_SHA256,
	DynamicSourceApprovalSchema,
} from "./dynamic/decision-contracts.js";
import { deriveJsonValueSha256 } from "./execution.js";
import type { WorkflowRunJournal } from "./persistence/journal.js";

export const MAX_WORKFLOW_DECISION_RECORD_BYTES = 1024 * 1024;

/** Same pattern as the private `Sha256Schema` in contracts.ts. */
const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });

const decisionMutations = new Map<string, Promise<void>>();

export const CheckpointDecisionBindingSchema = Type.Object(
	{
		kind: Type.Literal("checkpoint"),
		runId: WorkflowRunIdSchema,
		taskId: WorkflowTaskIdSchema,
		executionId: TaskExecutionIdSchema,
		effectSha256: Sha256Schema,
	},
	{ additionalProperties: false },
);
export type CheckpointDecisionBinding = Static<
	typeof CheckpointDecisionBindingSchema
>;

/**
 * Definition-level binding of a human decision about dynamic source. The
 * identity digest carries the manifest and host API digests, so a package
 * upgrade rebinds and requires a fresh approval of the same source.
 */
export const SourceApprovalDecisionBindingSchema = Type.Object(
	{
		kind: Type.Literal("source-approval"),
		definitionIdentitySha256: Sha256Schema,
		sourceSha256: Sha256Schema,
		contractRevision: Type.Literal(WORKFLOW_CONTRACT_REVISION),
	},
	{ additionalProperties: false },
);
export type SourceApprovalDecisionBinding = Static<
	typeof SourceApprovalDecisionBindingSchema
>;

/** Discriminated by `kind`. */
export const WorkflowDecisionBindingSchema = Type.Union([
	CheckpointDecisionBindingSchema,
	SourceApprovalDecisionBindingSchema,
]);
export type WorkflowDecisionBinding = Static<
	typeof WorkflowDecisionBindingSchema
>;

export const WorkflowDecisionRecordSchema = Type.Object(
	{
		schema: Type.Literal("pi-workflow-decision"),
		contractRevision: Type.Literal(WORKFLOW_CONTRACT_REVISION),
		binding: WorkflowDecisionBindingSchema,
		source: CheckpointDecisionSourceSchema,
		decidedBy: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		reason: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
		decidedAt: Type.String({ format: "date-time" }),
		valueSchemaSha256: Sha256Schema,
		valueSha256: Sha256Schema,
		value: Type.Unknown(),
	},
	{ additionalProperties: false },
);
export type WorkflowDecisionRecord = Static<
	typeof WorkflowDecisionRecordSchema
>;

export class WorkflowDecisionRecordError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkflowDecisionRecordError";
	}
}

/** The file name stem of a record: records are addressed only by binding. */
export function deriveDecisionBindingSha256(
	binding: WorkflowDecisionBinding,
): string {
	return deriveJsonValueSha256(binding);
}

/** Digest of the whole canonical record; the `approvalSha256` of a run. */
export function deriveDecisionRecordSha256(
	record: WorkflowDecisionRecord,
): string {
	return deriveJsonValueSha256(record);
}

function invalidRecord(cause?: unknown): WorkflowDecisionRecordError {
	return new WorkflowDecisionRecordError(
		"invalid workflow decision record",
		cause === undefined ? undefined : { cause },
	);
}

/** `source: "default"` never names an approver; `source: "operator"` always does. */
function hasConsistentProvenance(record: WorkflowDecisionRecord): boolean {
	return record.source === "default"
		? record.decidedBy === undefined
		: record.decidedBy !== undefined;
}

/**
 * A source approval is always an operator decision by a human whose value is
 * the approval document bound to the same source and identity digests.
 */
function isWellFormedSourceApproval(record: WorkflowDecisionRecord): boolean {
	if (record.binding.kind !== "source-approval") return true;
	return (
		record.source === "operator" &&
		record.decidedBy !== undefined &&
		record.decidedBy.startsWith("human:") &&
		record.valueSchemaSha256 === DYNAMIC_SOURCE_APPROVAL_SCHEMA_SHA256 &&
		Value.Check(DynamicSourceApprovalSchema, record.value) &&
		record.value.sourceSha256 === record.binding.sourceSha256 &&
		record.value.definitionIdentitySha256 ===
			record.binding.definitionIdentitySha256
	);
}

function valueDigest(value: unknown): string {
	try {
		return deriveJsonValueSha256(value);
	} catch (error) {
		throw invalidRecord(error);
	}
}

function canonicalBytes(record: WorkflowDecisionRecord): Buffer {
	let content: Buffer;
	try {
		content = canonicalArtifactJson(record);
	} catch (error) {
		throw invalidRecord(error);
	}
	if (content.byteLength > MAX_WORKFLOW_DECISION_RECORD_BYTES) {
		throw new WorkflowDecisionRecordError(
			"workflow decision record exceeds size limit",
		);
	}
	return content;
}

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const entry of Object.values(value)) deepFreeze(entry);
	}
	return value;
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * Bounded, symlink-refusing read of a record file. `undefined` when absent.
 */
async function readFileNoFollow(filePath: string): Promise<Buffer | undefined> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return undefined;
		if (code === "ELOOP") {
			throw new WorkflowDecisionRecordError(
				"workflow decision record may not be a symlink",
			);
		}
		throw error;
	}
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile()) throw invalidRecord();
		if (metadata.size > MAX_WORKFLOW_DECISION_RECORD_BYTES) {
			throw new WorkflowDecisionRecordError(
				"workflow decision record exceeds size limit",
			);
		}
		const content = Buffer.alloc(MAX_WORKFLOW_DECISION_RECORD_BYTES + 1);
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
		if (offset > MAX_WORKFLOW_DECISION_RECORD_BYTES) {
			throw new WorkflowDecisionRecordError(
				"workflow decision record exceeds size limit",
			);
		}
		return content.subarray(0, offset);
	} finally {
		await handle.close();
	}
}

/**
 * Immutable, binding-addressed decision records under
 * `<run dir>/decisions/<bindingSha256>.json`. One canonical JSON record per
 * binding: a byte-identical re-put is idempotent, a different record for the
 * same binding is a conflict. Not artifact-store-backed: artifacts are
 * content-addressed by value and cannot express "exactly one decision per
 * binding" or carry approver, source, and timestamp evidence.
 *
 * Two scopes share the format: the run-scoped store opened by
 * {@link WorkflowDecisionRecordStore.open} is fenced on the run lease and
 * admits only `checkpoint` bindings that name its own run; the
 * definition-level store opened by {@link WorkflowDecisionRecordStore.openRoot}
 * lives outside any run, has no lease, and admits only `source-approval`
 * bindings.
 */
export class WorkflowDecisionRecordStore {
	readonly root: string;
	/** Absent for a definition-level store. */
	private readonly journal: WorkflowRunJournal | undefined;

	private constructor(root: string, journal: WorkflowRunJournal | undefined) {
		this.root = root;
		this.journal = journal;
	}

	static async open(options: {
		journal: WorkflowRunJournal;
	}): Promise<WorkflowDecisionRecordStore> {
		return options.journal.withCurrent(async () => {
			const expected = path.join(options.journal.directory, "decisions");
			await mkdir(expected, { recursive: true, mode: 0o700 });
			const root = await realpath(expected);
			if (
				path.dirname(root) !== options.journal.directory ||
				path.basename(root) !== "decisions"
			) {
				throw new WorkflowDecisionRecordError(
					"workflow decision directory escapes its run",
				);
			}
			await chmod(root, 0o700);
			return new WorkflowDecisionRecordStore(root, options.journal);
		});
	}

	/**
	 * Definition-level store outside any run; `directory` must already be
	 * inside a pi-workflow store root (the proposal's `decisions/`). Created
	 * owner-only if absent; no journal, no lease fence.
	 */
	static async openRoot(options: {
		directory: string;
	}): Promise<WorkflowDecisionRecordStore> {
		const directory = path.resolve(options.directory);
		try {
			await mkdir(directory, { recursive: false, mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const root = await realpath(directory);
		if (
			path.dirname(root) !== (await realpath(path.dirname(directory))) ||
			path.basename(root) !== path.basename(directory) ||
			!(await lstat(root)).isDirectory()
		) {
			throw new WorkflowDecisionRecordError(
				"workflow decision directory escapes its root",
			);
		}
		await chmod(root, 0o700);
		return new WorkflowDecisionRecordStore(root, undefined);
	}

	/** Refuses bindings that this store is not the authority for. */
	private assertOwnBinding(binding: WorkflowDecisionBinding): void {
		if (!Value.Check(WorkflowDecisionBindingSchema, binding)) {
			throw new WorkflowDecisionRecordError(
				"invalid workflow decision binding",
			);
		}
		switch (binding.kind) {
			case "checkpoint":
				if (this.journal === undefined) {
					throw new WorkflowDecisionRecordError(
						"workflow decision record binding does not belong to a definition store",
					);
				}
				if (binding.runId !== this.journal.runId) {
					throw new WorkflowDecisionRecordError(
						"workflow decision record belongs to another run",
					);
				}
				return;
			case "source-approval":
				if (this.journal !== undefined) {
					throw new WorkflowDecisionRecordError(
						"workflow decision record binding does not belong to a run",
					);
				}
				return;
		}
	}

	private targetPath(binding: WorkflowDecisionBinding): string {
		return path.join(this.root, `${deriveDecisionBindingSha256(binding)}.json`);
	}

	/**
	 * Serializes a store mutation behind every earlier mutation of the same
	 * directory (process-wide) and, for a run-scoped store, fences it on the
	 * current lease.
	 */
	private mutate<T>(operation: () => Promise<T>): Promise<T> {
		const journal = this.journal;
		const predecessor = decisionMutations.get(this.root) ?? Promise.resolve();
		const result = predecessor.then(() =>
			journal === undefined ? operation() : journal.withCurrent(operation),
		);
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		decisionMutations.set(this.root, settled);
		void settled.then(() => {
			if (decisionMutations.get(this.root) === settled) {
				decisionMutations.delete(this.root);
			}
		});
		return result;
	}

	/**
	 * Idempotent for byte-identical records; a different record for the same
	 * binding is a conflict.
	 */
	async put(record: WorkflowDecisionRecord): Promise<WorkflowDecisionRecord> {
		if (
			!Value.Check(WorkflowDecisionRecordSchema, record) ||
			!hasConsistentProvenance(record) ||
			record.valueSha256 !== valueDigest(record.value) ||
			!isWellFormedSourceApproval(record)
		) {
			throw invalidRecord();
		}
		this.assertOwnBinding(record.binding);
		const content = canonicalBytes(record);
		const target = this.targetPath(record.binding);
		return this.mutate(async () => {
			try {
				const existing = await lstat(target);
				if (
					existing.isFile() &&
					!existing.isSymbolicLink() &&
					existing.size === content.byteLength &&
					(await readFile(target)).equals(content)
				) {
					return record;
				}
				throw new WorkflowDecisionRecordError(
					"decision record already exists for this binding",
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
			return record;
		});
	}

	/**
	 * Lease-free verified read of the record for `binding`; `undefined` when
	 * no decision has been recorded. Never scans the directory.
	 */
	async read(
		binding: WorkflowDecisionBinding,
	): Promise<WorkflowDecisionRecord | undefined> {
		this.assertOwnBinding(binding);
		const content = await readFileNoFollow(this.targetPath(binding));
		if (content === undefined) return undefined;
		let value: unknown;
		try {
			value = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(content),
			);
			if (!canonicalArtifactJson(value).equals(content)) {
				throw new Error("record bytes differ from their canonical form");
			}
		} catch (error) {
			throw new WorkflowDecisionRecordError(
				"workflow decision record is not canonical",
				{ cause: error },
			);
		}
		if (
			!Value.Check(WorkflowDecisionRecordSchema, value) ||
			!hasConsistentProvenance(value) ||
			!isWellFormedSourceApproval(value)
		) {
			throw invalidRecord();
		}
		if (!isDeepStrictEqual(value.binding, binding)) {
			throw new WorkflowDecisionRecordError(
				"workflow decision record does not match its binding",
			);
		}
		if (value.valueSha256 !== valueDigest(value.value)) {
			throw new WorkflowDecisionRecordError(
				"workflow decision record digest mismatch",
			);
		}
		return deepFreeze(value);
	}
}
