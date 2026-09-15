import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, realpath, rename } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	WORKFLOW_CONTRACT_REVISION,
	type WorkflowRunId,
	WorkflowRunIdSchema,
} from "../contracts.js";

const MAX_RECORD_BYTES = 16 * 1024;

export const WorkflowRunLeaseRecordSchema = Type.Object(
	{
		schema: Type.Literal("pi-workflow-run-lease"),
		contractRevision: Type.Literal(WORKFLOW_CONTRACT_REVISION),
		runId: WorkflowRunIdSchema,
		storeRootSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		ownerId: Type.String({ minLength: 1, maxLength: 256 }),
		leaseId: Type.String({ minLength: 1, maxLength: 128 }),
		generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		pid: Type.Integer({ minimum: 1 }),
		processStartedAt: Type.Number({ minimum: 0 }),
		port: Type.Integer({ minimum: 1024, maximum: 65_535 }),
		acquiredAt: Type.String({ format: "date-time" }),
	},
	{ additionalProperties: false },
);
export type WorkflowRunLeaseRecord = Static<
	typeof WorkflowRunLeaseRecordSchema
>;

export interface WorkflowRunLease {
	readonly record: WorkflowRunLeaseRecord;
	assertCurrent(): Promise<void>;
	withCurrent<T>(operation: () => Promise<T>): Promise<T>;
	release(): Promise<void>;
}

export class WorkflowRunLeaseUnavailableError extends Error {
	constructor(readonly runId: WorkflowRunId) {
		super(`workflow run lease unavailable: ${runId}`);
		this.name = "WorkflowRunLeaseUnavailableError";
	}
}

export class WorkflowRunLeaseFencedError extends Error {
	constructor(readonly runId: WorkflowRunId) {
		super(`workflow run lease fenced: ${runId}`);
		this.name = "WorkflowRunLeaseFencedError";
	}
}

export class WorkflowPersistenceCorruptionError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkflowPersistenceCorruptionError";
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

const LEASE_PORT_BASE = 20_000;
const LEASE_PORT_SPAN = 20_000;
/** Coprime with the span, so the candidate walk never repeats a port. */
const LEASE_PORT_STRIDE = 7_919;
const LEASE_PORT_CANDIDATES = 64;
const LEASE_BANNER_PREFIX = "pi-workflow-lease/1 ";
const LEASE_PROBE_TIMEOUT_MS = 2_000;

/**
 * Names this lease on the wire. The listener proves which run holds a port,
 * so an unrelated run that hashed to the same port is not mistaken for the
 * live owner of this one.
 */
function leaseIdentity(storeRoot: string, runId: WorkflowRunId): string {
	return sha256(`${storeRoot}\0${runId}`);
}

/**
 * Deterministic ports to try, in order. The port space is far smaller than
 * the identity space, so unrelated runs collide; every acquirer walks the
 * same sequence and skips ports proved to belong to another run.
 */
function leasePortCandidates(
	storeRoot: string,
	runId: WorkflowRunId,
): readonly number[] {
	const value = createHash("sha256")
		.update(storeRoot)
		.update("\0")
		.update(runId)
		.digest()
		.readUInt32BE(0);
	const base = value % LEASE_PORT_SPAN;
	return Array.from(
		{ length: LEASE_PORT_CANDIDATES },
		(_, index) =>
			LEASE_PORT_BASE + ((base + index * LEASE_PORT_STRIDE) % LEASE_PORT_SPAN),
	);
}

/**
 * Reads the banner of whatever holds a port. Returns undefined when the
 * occupant cannot be proved to be another run's lease; callers then fail
 * closed rather than binding a second listener for the same run.
 */
async function probeIdentity(port: number): Promise<string | undefined> {
	return new Promise<string | undefined>((resolve) => {
		const socket = net.connect({ host: "127.0.0.1", port });
		let banner = "";
		const finish = (value: string | undefined) => {
			socket.destroy();
			resolve(value);
		};
		socket.setTimeout(LEASE_PROBE_TIMEOUT_MS, () => finish(undefined));
		socket.once("error", () => finish(undefined));
		socket.on("data", (chunk) => {
			banner += chunk.toString("utf8");
			const end = banner.indexOf("\n");
			if (end < 0) {
				if (banner.length > LEASE_BANNER_PREFIX.length + 64) finish(undefined);
				return;
			}
			const line = banner.slice(0, end);
			finish(
				line.startsWith(LEASE_BANNER_PREFIX)
					? line.slice(LEASE_BANNER_PREFIX.length)
					: undefined,
			);
		});
		socket.once("end", () => finish(undefined));
	});
}

async function bind(
	port: number,
	identity: string,
): Promise<net.Server | undefined> {
	const server = net.createServer((socket) => {
		socket.end(`${LEASE_BANNER_PREFIX}${identity}\n`);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: NodeJS.ErrnoException) => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen({ host: "127.0.0.1", port, exclusive: true });
		});
		server.on("error", () => {});
		server.unref();
		return server;
	} catch (error) {
		server.close();
		if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
			return undefined;
		}
		throw error;
	}
}

async function close(server: net.Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function ensureDurableDirectory(input: string): Promise<string> {
	const missing: string[] = [];
	let cursor = path.resolve(input);
	let canonical: string;
	for (;;) {
		try {
			canonical = await realpath(cursor);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = path.dirname(cursor);
			if (parent === cursor) throw error;
			missing.push(path.basename(cursor));
			cursor = parent;
		}
	}
	for (const component of missing.reverse()) {
		const next = path.join(canonical, component);
		try {
			await mkdir(next, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const resolved = await realpath(next);
		if (
			path.dirname(resolved) !== canonical ||
			path.basename(resolved) !== component
		) {
			throw new Error("workflow store directory escaped during creation");
		}
		await chmod(resolved, 0o700);
		await syncDirectory(canonical);
		await syncDirectory(resolved);
		canonical = resolved;
	}
	return canonical;
}

function decodeUtf8(content: Buffer, label: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch {
		throw new WorkflowPersistenceCorruptionError(`${label} is not valid UTF-8`);
	}
}

async function readRecord(
	filePath: string,
): Promise<WorkflowRunLeaseRecord | undefined> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return undefined;
		if (code === "ELOOP") {
			throw new WorkflowPersistenceCorruptionError(
				"workflow run lease record may not be a symlink",
			);
		}
		throw error;
	}
	try {
		const metadata = await handle.stat();
		if (metadata.size > MAX_RECORD_BYTES) {
			throw new WorkflowPersistenceCorruptionError(
				"workflow run lease record exceeds size limit",
			);
		}
		if (!metadata.isFile()) {
			throw new WorkflowPersistenceCorruptionError(
				"workflow run lease record is not a regular file",
			);
		}
		const content = Buffer.alloc(MAX_RECORD_BYTES + 1);
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
		if (bytesRead > MAX_RECORD_BYTES) {
			throw new WorkflowPersistenceCorruptionError(
				"workflow run lease record exceeds size limit",
			);
		}
		const text = decodeUtf8(
			content.subarray(0, bytesRead),
			"workflow run lease record",
		);
		const value = JSON.parse(text) as unknown;
		if (`${JSON.stringify(value, null, 2)}\n` !== text) {
			throw new WorkflowPersistenceCorruptionError(
				"workflow run lease record is not canonical JSON",
			);
		}
		if (!Value.Check(WorkflowRunLeaseRecordSchema, value)) {
			throw new WorkflowPersistenceCorruptionError(
				"invalid workflow run lease record schema",
			);
		}
		return value as WorkflowRunLeaseRecord;
	} catch (error) {
		if (error instanceof WorkflowPersistenceCorruptionError) throw error;
		throw new WorkflowPersistenceCorruptionError(
			"invalid workflow run lease record JSON",
		);
	} finally {
		await handle.close();
	}
}

export async function acquireWorkflowRunLease(options: {
	storeRoot: string;
	runId: WorkflowRunId;
	ownerId: string;
}): Promise<WorkflowRunLease> {
	if (!Value.Check(WorkflowRunIdSchema, options.runId)) {
		throw new Error("invalid workflow run ID");
	}
	if (
		typeof options.ownerId !== "string" ||
		!options.ownerId ||
		options.ownerId.length > 256
	) {
		throw new Error("invalid workflow run owner ID");
	}
	const storeRoot = await ensureDurableDirectory(options.storeRoot);
	await chmod(storeRoot, 0o700);
	await syncDirectory(storeRoot);
	const leaseRoot = path.join(storeRoot, "leases");
	await mkdir(leaseRoot, { recursive: true, mode: 0o700 });
	const canonicalLeaseRoot = await realpath(leaseRoot);
	if (
		path.dirname(canonicalLeaseRoot) !== storeRoot ||
		path.basename(canonicalLeaseRoot) !== "leases"
	) {
		throw new Error("workflow lease directory escapes its store root");
	}
	await chmod(canonicalLeaseRoot, 0o700);
	await syncDirectory(storeRoot);
	await syncDirectory(canonicalLeaseRoot);
	const recordPath = path.join(
		canonicalLeaseRoot,
		`${options.runId}.lease.json`,
	);
	const existing = await readRecord(recordPath);
	const identity = leaseIdentity(storeRoot, options.runId);
	const candidates = leasePortCandidates(storeRoot, options.runId);
	if (
		existing &&
		(existing.storeRootSha256 !== sha256(storeRoot) ||
			existing.runId !== options.runId ||
			!candidates.includes(existing.port))
	) {
		throw new WorkflowPersistenceCorruptionError(
			"workflow run lease identity mismatch",
		);
	}
	// The recorded port is tried first so a later acquirer meets the live
	// owner where it actually listens, then the shared walk covers the rest.
	const ordered =
		existing === undefined
			? candidates
			: [existing.port, ...candidates.filter((c) => c !== existing.port)];
	let server: net.Server | undefined;
	let port = 0;
	for (const candidate of ordered) {
		server = await bind(candidate, identity);
		if (server) {
			port = candidate;
			break;
		}
		const occupant = await probeIdentity(candidate);
		// Held by this very run, or by something that cannot identify itself:
		// either way this process must not become a second writer.
		if (occupant === identity || occupant === undefined) {
			throw new WorkflowRunLeaseUnavailableError(options.runId);
		}
	}
	if (!server) throw new WorkflowRunLeaseUnavailableError(options.runId);
	try {
		if (existing?.generation === Number.MAX_SAFE_INTEGER) {
			throw new WorkflowPersistenceCorruptionError(
				"workflow run lease generation is exhausted",
			);
		}
		const record: WorkflowRunLeaseRecord = Object.freeze({
			schema: "pi-workflow-run-lease",
			contractRevision: WORKFLOW_CONTRACT_REVISION,
			runId: options.runId,
			storeRootSha256: sha256(storeRoot),
			ownerId: options.ownerId,
			leaseId: randomUUID(),
			generation: (existing?.generation ?? 0) + 1,
			pid: process.pid,
			processStartedAt: performance.timeOrigin,
			port,
			acquiredAt: new Date().toISOString(),
		});
		if (!Value.Check(WorkflowRunLeaseRecordSchema, record)) {
			throw new Error("invalid workflow run lease record");
		}
		const temporary = `${recordPath}.${process.pid}.${record.leaseId}.tmp`;
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, recordPath);
		await syncDirectory(canonicalLeaseRoot);

		let tail = Promise.resolve();
		let releaseRequested = false;
		let releasePromise: Promise<void> | undefined;
		const assertCurrent = async () => {
			const current = await readRecord(recordPath);
			if (
				!server.listening ||
				current?.leaseId !== record.leaseId ||
				current.generation !== record.generation
			) {
				throw new WorkflowRunLeaseFencedError(options.runId);
			}
		};
		return {
			record,
			assertCurrent,
			withCurrent<T>(operation: () => Promise<T>): Promise<T> {
				if (releaseRequested) {
					return Promise.reject(new WorkflowRunLeaseFencedError(options.runId));
				}
				const result = tail.then(async () => {
					await assertCurrent();
					return operation();
				});
				tail = result.then(
					() => undefined,
					() => undefined,
				);
				return result;
			},
			release() {
				releaseRequested = true;
				releasePromise ??= tail.then(() => close(server));
				return releasePromise;
			},
		};
	} catch (error) {
		await close(server);
		throw error;
	}
}
