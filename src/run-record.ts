import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	WORKFLOW_CONTRACT_REVISION,
	WorkflowRunIdSchema,
} from "./contracts.js";
import type { WorkflowRunJournal } from "./persistence/journal.js";

const MAX_RUN_RECORD_BYTES = 1024 * 1024;

export const WorkflowRunRecordSchema = Type.Object(
	{
		schema: Type.Literal("pi-workflow-run"),
		contractRevision: Type.Literal(WORKFLOW_CONTRACT_REVISION),
		runId: WorkflowRunIdSchema,
		definitionName: Type.String({
			pattern: "^[a-z][a-z0-9-]*$",
			minLength: 1,
			maxLength: 128,
		}),
		definitionPath: Type.String({ minLength: 1, maxLength: 4096 }),
		definitionIdentitySha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		definitionSourceSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		cwd: Type.String({ minLength: 1, maxLength: 4096 }),
		input: Type.Unknown(),
		createdAt: Type.String({ format: "date-time" }),
	},
	{ additionalProperties: false },
);
export type WorkflowRunRecord = Static<typeof WorkflowRunRecordSchema>;

export class WorkflowRunRecordError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkflowRunRecordError";
	}
}

function serialize(record: WorkflowRunRecord): string {
	let json: string;
	try {
		json = JSON.stringify(record);
		const roundTrip = JSON.parse(json) as unknown;
		if (
			!Value.Check(WorkflowRunRecordSchema, roundTrip) ||
			!isDeepStrictEqual(record, roundTrip)
		) {
			throw new Error("record changes during serialization");
		}
	} catch (error) {
		throw new WorkflowRunRecordError(
			"workflow run record is not bounded JSON",
			{ cause: error },
		);
	}
	const content = `${json}\n`;
	if (Buffer.byteLength(content) > MAX_RUN_RECORD_BYTES) {
		throw new WorkflowRunRecordError("workflow run record exceeds size limit");
	}
	return content;
}

async function readFileNoFollow(filePath: string): Promise<Buffer | undefined> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return undefined;
		if (code === "ELOOP") {
			throw new WorkflowRunRecordError(
				"workflow run record may not be a symlink",
			);
		}
		throw error;
	}
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.size > MAX_RUN_RECORD_BYTES) {
			throw new WorkflowRunRecordError("invalid workflow run record file");
		}
		const content = Buffer.alloc(MAX_RUN_RECORD_BYTES + 1);
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
		if (offset > MAX_RUN_RECORD_BYTES) {
			throw new WorkflowRunRecordError(
				"workflow run record exceeds size limit",
			);
		}
		return content.subarray(0, offset);
	} finally {
		await handle.close();
	}
}

export class WorkflowRunRecordStore {
	private constructor(readonly journal: WorkflowRunJournal) {}

	static open(journal: WorkflowRunJournal): WorkflowRunRecordStore {
		return new WorkflowRunRecordStore(journal);
	}

	get path(): string {
		return path.join(this.journal.directory, "service.json");
	}

	async create(record: WorkflowRunRecord): Promise<void> {
		if (
			!Value.Check(WorkflowRunRecordSchema, record) ||
			record.runId !== this.journal.runId ||
			!path.isAbsolute(record.definitionPath) ||
			!path.isAbsolute(record.cwd)
		) {
			throw new WorkflowRunRecordError("invalid workflow run record");
		}
		const content = serialize(record);
		await this.journal.withCurrent(async () => {
			if (await readFileNoFollow(this.path)) {
				throw new WorkflowRunRecordError("workflow run record already exists");
			}
			const temporary = `${this.path}.${process.pid}.tmp`;
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(content, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, this.path);
			const directory = await open(this.journal.directory, "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		});
	}

	async read(): Promise<WorkflowRunRecord> {
		const content = await readFileNoFollow(this.path);
		if (!content) {
			throw new WorkflowRunRecordError("workflow run record is missing");
		}
		let value: unknown;
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
			value = JSON.parse(text);
			if (`${JSON.stringify(value)}\n` !== text) {
				throw new Error("record is not canonical JSON");
			}
		} catch (error) {
			throw new WorkflowRunRecordError("invalid workflow run record JSON", {
				cause: error,
			});
		}
		if (
			!Value.Check(WorkflowRunRecordSchema, value) ||
			value.runId !== this.journal.runId ||
			!path.isAbsolute(value.definitionPath) ||
			!path.isAbsolute(value.cwd)
		) {
			throw new WorkflowRunRecordError("invalid workflow run record schema");
		}
		return Object.freeze(value as WorkflowRunRecord);
	}
}
