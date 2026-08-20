import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, realpath, rename, stat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	WORKFLOW_CONTRACT_REVISION,
	type WorkflowRunId,
	WorkflowRunIdSchema,
} from "../contracts.js";
import {
	WorkflowPersistenceCorruptionError,
	type WorkflowRunLease,
} from "./run-lease.js";

const MAX_EVENT_BYTES = 64 * 1024;
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;

export const WorkflowJournalEventSchema = Type.Object(
	{
		schema: Type.Literal("pi-workflow-event"),
		contractRevision: Type.Literal(WORKFLOW_CONTRACT_REVISION),
		sequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		eventId: Type.String({ minLength: 1, maxLength: 128 }),
		timestamp: Type.String({ format: "date-time" }),
		runId: WorkflowRunIdSchema,
		ownerId: Type.String({ minLength: 1, maxLength: 256 }),
		leaseId: Type.String({ minLength: 1, maxLength: 128 }),
		fencingGeneration: Type.Integer({
			minimum: 1,
			maximum: Number.MAX_SAFE_INTEGER,
		}),
		type: Type.String({ minLength: 1, maxLength: 128 }),
		data: Type.Unknown(),
	},
	{ additionalProperties: false },
);
export type WorkflowJournalEvent = Static<typeof WorkflowJournalEventSchema>;

export const WorkflowRunSnapshotSchema = Type.Object(
	{
		schema: Type.Literal("pi-workflow-snapshot"),
		contractRevision: Type.Literal(WORKFLOW_CONTRACT_REVISION),
		runId: WorkflowRunIdSchema,
		ownerId: Type.String({ minLength: 1, maxLength: 256 }),
		leaseId: Type.String({ minLength: 1, maxLength: 128 }),
		fencingGeneration: Type.Integer({
			minimum: 1,
			maximum: Number.MAX_SAFE_INTEGER,
		}),
		lastSequence: Type.Integer({
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER,
		}),
		state: Type.Unknown(),
	},
	{ additionalProperties: false },
);
export type WorkflowRunSnapshot = Static<typeof WorkflowRunSnapshotSchema>;

type JournalCoordinator = {
	leaseId: string;
	sequence: number;
	tail: Promise<void>;
	uncertain: boolean;
};

const coordinators = new Map<string, JournalCoordinator>();
let openTail = Promise.resolve();

async function serializedOpen<T>(operation: () => Promise<T>): Promise<T> {
	const previous = openTail;
	let release = () => {};
	openTail = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		return await operation();
	} finally {
		release();
	}
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function jsonRoundTrip<T>(value: T, label: string): { json: string; value: T } {
	try {
		const json = JSON.stringify(value);
		if (json === undefined) throw new Error(`${label} serialized to undefined`);
		const parsed = JSON.parse(json) as T;
		if (!isDeepStrictEqual(value, parsed)) {
			throw new Error(`${label} changes during JSON serialization`);
		}
		return { json, value: parsed };
	} catch (error) {
		throw new Error(`${label} is not losslessly JSON-serializable`, {
			cause: error,
		});
	}
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
	if (Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES) {
		throw new Error("workflow run snapshot exceeds size limit");
	}
	const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporary, filePath);
	await syncDirectory(path.dirname(filePath));
}

function decodeUtf8(content: Buffer, label: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch {
		throw new WorkflowPersistenceCorruptionError(`${label} is not valid UTF-8`);
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function readBounded(
	filePath: string,
	maximumBytes: number,
	label: string,
): Promise<Buffer | undefined> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return undefined;
		if (code === "ELOOP") {
			throw new WorkflowPersistenceCorruptionError(
				`${label} may not be a symlink`,
			);
		}
		throw error;
	}
	try {
		const metadata = await handle.stat();
		if (metadata.size > maximumBytes) {
			throw new WorkflowPersistenceCorruptionError(
				`${label} exceeds size limit`,
			);
		}
		if (!metadata.isFile()) {
			throw new WorkflowPersistenceCorruptionError(
				`${label} is not a regular file`,
			);
		}
		const content = Buffer.alloc(maximumBytes + 1);
		let bytesRead = 0;
		while (bytesRead < content.byteLength) {
			const result = await handle.read(
				content,
				bytesRead,
				content.byteLength - bytesRead,
				null,
			);
			if (result.bytesRead === 0) break;
			bytesRead += result.bytesRead;
		}
		if (bytesRead > maximumBytes) {
			throw new WorkflowPersistenceCorruptionError(
				`${label} exceeds size limit`,
			);
		}
		return content.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

async function repairTornTail(
	journalPath: string,
	completeBytes: number,
	totalBytes: number,
): Promise<void> {
	if (completeBytes === totalBytes) return;
	const handle = await open(
		journalPath,
		constants.O_RDWR | constants.O_NOFOLLOW,
	);
	try {
		await handle.truncate(completeBytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function parseJournal(
	content: string,
	runId: WorkflowRunId,
): WorkflowJournalEvent[] {
	const hasTerminalNewline = content.endsWith("\n");
	const lines = content.split("\n");
	if (hasTerminalNewline) lines.pop();
	else lines.pop();
	const events: WorkflowJournalEvent[] = [];
	for (const [index, line] of lines.entries()) {
		if (!line) {
			throw new WorkflowPersistenceCorruptionError(
				`empty interior workflow journal record at line ${index + 1}`,
			);
		}
		if (Buffer.byteLength(`${line}\n`) > MAX_EVENT_BYTES) {
			throw new WorkflowPersistenceCorruptionError(
				`oversized workflow journal record at line ${index + 1}`,
			);
		}
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new WorkflowPersistenceCorruptionError(
				`invalid interior workflow journal record at line ${index + 1}`,
			);
		}
		if (!Value.Check(WorkflowJournalEventSchema, value)) {
			throw new WorkflowPersistenceCorruptionError(
				`invalid workflow journal schema at line ${index + 1}`,
			);
		}
		if (JSON.stringify(value) !== line) {
			throw new WorkflowPersistenceCorruptionError(
				`non-canonical workflow journal record at line ${index + 1}`,
			);
		}
		const event = value as WorkflowJournalEvent;
		if (event.runId !== runId || event.sequence !== events.length + 1) {
			throw new WorkflowPersistenceCorruptionError(
				`workflow journal identity or sequence mismatch at line ${index + 1}`,
			);
		}
		const previous = events.at(-1);
		if (
			previous &&
			(event.fencingGeneration < previous.fencingGeneration ||
				(event.fencingGeneration === previous.fencingGeneration &&
					(event.ownerId !== previous.ownerId ||
						event.leaseId !== previous.leaseId)))
		) {
			throw new WorkflowPersistenceCorruptionError(
				`workflow journal fencing regression at line ${index + 1}`,
			);
		}
		events.push(event);
	}
	return events;
}

export class WorkflowRunJournal {
	readonly runId: WorkflowRunId;
	readonly directory: string;
	readonly journalPath: string;
	readonly snapshotPath: string;
	private readonly coordinator: JournalCoordinator;
	private readonly lease: WorkflowRunLease;

	private constructor(
		directory: string,
		runId: WorkflowRunId,
		coordinator: JournalCoordinator,
		lease: WorkflowRunLease,
	) {
		this.directory = directory;
		this.runId = runId;
		this.journalPath = path.join(directory, "events.jsonl");
		this.snapshotPath = path.join(directory, "run.json");
		this.coordinator = coordinator;
		this.lease = lease;
	}

	static async open(
		storeRootInput: string,
		runId: WorkflowRunId,
		lease: WorkflowRunLease,
	): Promise<WorkflowRunJournal> {
		return lease.withCurrent(() =>
			serializedOpen(async () => {
				if (!Value.Check(WorkflowRunIdSchema, runId)) {
					throw new Error("invalid workflow run ID");
				}
				if (lease.record.runId !== runId) {
					throw new Error("workflow run lease identity mismatch");
				}
				await lease.assertCurrent();
				const storeRoot = await realpath(storeRootInput);
				if (lease.record.storeRootSha256 !== sha256(storeRoot)) {
					throw new Error("workflow run lease store identity mismatch");
				}
				const runsRootPath = path.join(storeRoot, "runs");
				await mkdir(runsRootPath, { recursive: true, mode: 0o700 });
				const runsRoot = await realpath(runsRootPath);
				if (
					path.dirname(runsRoot) !== storeRoot ||
					path.basename(runsRoot) !== "runs"
				) {
					throw new Error("workflow runs directory escapes its store root");
				}
				await chmod(runsRoot, 0o700);
				await syncDirectory(storeRoot);
				await syncDirectory(runsRoot);
				const directoryPath = path.join(runsRoot, runId);
				await mkdir(directoryPath, { recursive: true, mode: 0o700 });
				const directory = await realpath(directoryPath);
				if (
					path.dirname(directory) !== runsRoot ||
					path.basename(directory) !== runId
				) {
					throw new Error("workflow run directory escapes its runs root");
				}
				await chmod(directory, 0o700);
				await syncDirectory(runsRoot);
				await syncDirectory(directory);
				const key = directory;
				let coordinator = coordinators.get(key);
				if (coordinator?.leaseId === lease.record.leaseId) {
					await coordinator.tail;
					if (coordinator.uncertain) {
						throw new WorkflowPersistenceCorruptionError(
							"workflow journal append outcome is uncertain",
						);
					}
				}
				const journalPath = path.join(directory, "events.jsonl");
				let events: WorkflowJournalEvent[] = [];
				const buffer = await readBounded(
					journalPath,
					MAX_JOURNAL_BYTES,
					"workflow journal",
				);
				if (buffer) {
					const completeBytes =
						buffer.at(-1) === 0x0a
							? buffer.byteLength
							: buffer.lastIndexOf(0x0a) + 1;
					if (buffer.byteLength - completeBytes > MAX_EVENT_BYTES) {
						throw new WorkflowPersistenceCorruptionError(
							"torn workflow journal record exceeds size limit",
						);
					}
					const content = decodeUtf8(
						buffer.subarray(0, completeBytes),
						"workflow journal",
					);
					events = parseJournal(content, runId);
					await repairTornTail(journalPath, completeBytes, buffer.byteLength);
					await chmod(journalPath, 0o600);
					const handle = await open(journalPath, "r");
					try {
						await handle.sync();
					} finally {
						await handle.close();
					}
				}
				const latest = events.at(-1);
				if (
					latest &&
					(lease.record.generation < latest.fencingGeneration ||
						(lease.record.generation === latest.fencingGeneration &&
							(lease.record.ownerId !== latest.ownerId ||
								lease.record.leaseId !== latest.leaseId)))
				) {
					throw new WorkflowPersistenceCorruptionError(
						"workflow run lease is older than journal fencing evidence",
					);
				}
				if (coordinator && events.length < coordinator.sequence) {
					throw new WorkflowPersistenceCorruptionError(
						"workflow journal sequence regressed across lease ownership",
					);
				}
				if (coordinator?.leaseId === lease.record.leaseId) {
					if (coordinator.sequence !== events.length) {
						throw new WorkflowPersistenceCorruptionError(
							"workflow journal changed outside its active coordinator",
						);
					}
				} else {
					coordinator = {
						leaseId: lease.record.leaseId,
						sequence: events.length,
						tail: Promise.resolve(),
						uncertain: false,
					};
					coordinators.set(key, coordinator);
				}
				const journal = new WorkflowRunJournal(
					directory,
					runId,
					coordinator,
					lease,
				);
				await journal.readSnapshot();
				return journal;
			}),
		);
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.coordinator.tail.then(async () => {
			if (this.coordinator.uncertain) {
				throw new WorkflowPersistenceCorruptionError(
					"workflow journal append outcome is uncertain",
				);
			}
			return operation();
		});
		this.coordinator.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	append(type: string, data: unknown): Promise<WorkflowJournalEvent> {
		return this.lease.withCurrent(() =>
			this.enqueue(async () => {
				const event: WorkflowJournalEvent = {
					schema: "pi-workflow-event",
					contractRevision: WORKFLOW_CONTRACT_REVISION,
					sequence: this.coordinator.sequence + 1,
					eventId: randomUUID(),
					timestamp: new Date().toISOString(),
					runId: this.runId,
					ownerId: this.lease.record.ownerId,
					leaseId: this.lease.record.leaseId,
					fencingGeneration: this.lease.record.generation,
					type,
					data,
				};
				if (!Value.Check(WorkflowJournalEventSchema, event)) {
					throw new Error("invalid workflow journal event");
				}
				const roundTrip = jsonRoundTrip(event, "workflow journal event");
				if (!Value.Check(WorkflowJournalEventSchema, roundTrip.value)) {
					throw new Error("invalid JSON-roundtripped workflow journal event");
				}
				const line = `${roundTrip.json}\n`;
				const lineBytes = Buffer.byteLength(line);
				if (lineBytes > MAX_EVENT_BYTES) {
					throw new Error("workflow journal event exceeds size limit");
				}
				try {
					const current = await stat(this.journalPath);
					if (current.size + lineBytes > MAX_JOURNAL_BYTES) {
						throw new Error("workflow journal exceeds size limit");
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					if (this.coordinator.sequence > 0) {
						throw new WorkflowPersistenceCorruptionError(
							"workflow journal disappeared before append",
						);
					}
				}
				let handle: Awaited<ReturnType<typeof open>> | undefined;
				try {
					handle = await open(
						this.journalPath,
						constants.O_APPEND |
							constants.O_CREAT |
							constants.O_WRONLY |
							constants.O_NOFOLLOW,
						0o600,
					);
					await handle.writeFile(line, "utf8");
					await handle.sync();
					await handle.close();
					handle = undefined;
					await syncDirectory(this.directory);
				} catch (error) {
					this.coordinator.uncertain = true;
					await handle?.close().catch(() => {});
					throw error;
				}
				this.coordinator.sequence = event.sequence;
				return roundTrip.value;
			}),
		);
	}

	private async readEventsUncoordinated(): Promise<WorkflowJournalEvent[]> {
		if (this.coordinator.uncertain) {
			throw new WorkflowPersistenceCorruptionError(
				"workflow journal append outcome is uncertain",
			);
		}
		const buffer = await readBounded(
			this.journalPath,
			MAX_JOURNAL_BYTES,
			"workflow journal",
		);
		if (!buffer) {
			if (this.coordinator.sequence === 0) return [];
			throw new WorkflowPersistenceCorruptionError(
				"workflow journal disappeared",
			);
		}
		const events = parseJournal(
			decodeUtf8(buffer, "workflow journal"),
			this.runId,
		);
		if (events.length !== this.coordinator.sequence) {
			throw new WorkflowPersistenceCorruptionError(
				"workflow journal sequence regressed",
			);
		}
		return events;
	}

	readEvents(): Promise<WorkflowJournalEvent[]> {
		return this.enqueue(async () => {
			await this.lease.assertCurrent();
			return this.readEventsUncoordinated();
		});
	}

	writeSnapshot(state: unknown): Promise<WorkflowRunSnapshot> {
		return this.lease.withCurrent(() =>
			this.enqueue(async () => {
				const snapshot: WorkflowRunSnapshot = {
					schema: "pi-workflow-snapshot",
					contractRevision: WORKFLOW_CONTRACT_REVISION,
					runId: this.runId,
					ownerId: this.lease.record.ownerId,
					leaseId: this.lease.record.leaseId,
					fencingGeneration: this.lease.record.generation,
					lastSequence: this.coordinator.sequence,
					state,
				};
				if (!Value.Check(WorkflowRunSnapshotSchema, snapshot)) {
					throw new Error("invalid workflow run snapshot");
				}
				const roundTrip = jsonRoundTrip(snapshot, "workflow run snapshot");
				if (!Value.Check(WorkflowRunSnapshotSchema, roundTrip.value)) {
					throw new Error("invalid JSON-roundtripped workflow run snapshot");
				}
				try {
					await writeAtomic(this.snapshotPath, `${roundTrip.json}\n`);
				} catch (error) {
					this.coordinator.uncertain = true;
					throw error;
				}
				return roundTrip.value;
			}),
		);
	}

	private async readSnapshotUncoordinated(): Promise<
		WorkflowRunSnapshot | undefined
	> {
		if (this.coordinator.uncertain) {
			throw new WorkflowPersistenceCorruptionError(
				"workflow journal append outcome is uncertain",
			);
		}
		const buffer = await readBounded(
			this.snapshotPath,
			MAX_SNAPSHOT_BYTES,
			"workflow run snapshot",
		);
		if (!buffer) return undefined;
		try {
			const content = decodeUtf8(buffer, "workflow run snapshot");
			const value = JSON.parse(content) as unknown;
			if (`${JSON.stringify(value)}\n` !== content) {
				throw new WorkflowPersistenceCorruptionError(
					"workflow run snapshot is not canonical JSON",
				);
			}
			if (!Value.Check(WorkflowRunSnapshotSchema, value)) {
				throw new WorkflowPersistenceCorruptionError(
					"invalid workflow run snapshot schema",
				);
			}
			const snapshot = value as WorkflowRunSnapshot;
			const events = await this.readEventsUncoordinated();
			const coveredEvent =
				snapshot.lastSequence === 0
					? undefined
					: events[snapshot.lastSequence - 1];
			if (
				snapshot.runId !== this.runId ||
				snapshot.lastSequence > this.coordinator.sequence ||
				snapshot.fencingGeneration > this.lease.record.generation ||
				(snapshot.fencingGeneration === this.lease.record.generation &&
					(snapshot.ownerId !== this.lease.record.ownerId ||
						snapshot.leaseId !== this.lease.record.leaseId)) ||
				(coveredEvent !== undefined &&
					(coveredEvent.fencingGeneration > snapshot.fencingGeneration ||
						(coveredEvent.fencingGeneration === snapshot.fencingGeneration &&
							(coveredEvent.ownerId !== snapshot.ownerId ||
								coveredEvent.leaseId !== snapshot.leaseId))))
			) {
				throw new WorkflowPersistenceCorruptionError(
					"workflow run snapshot identity, sequence, or fencing mismatch",
				);
			}
			return snapshot;
		} catch (error) {
			if (error instanceof WorkflowPersistenceCorruptionError) throw error;
			throw new WorkflowPersistenceCorruptionError(
				"invalid workflow run snapshot JSON",
			);
		}
	}

	readSnapshot(): Promise<WorkflowRunSnapshot | undefined> {
		return this.enqueue(async () => {
			await this.lease.assertCurrent();
			return this.readSnapshotUncoordinated();
		});
	}
}
