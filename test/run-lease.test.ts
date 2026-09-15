import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowRunJournal } from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
	WorkflowPersistenceCorruptionError,
	WorkflowRunLeaseFencedError,
	type WorkflowRunLeaseRecord,
	WorkflowRunLeaseUnavailableError,
} from "../src/persistence/run-lease.js";

const children = new Set<ChildProcess>();

function root(name: string): string {
	return path.resolve(".pi", "test-run-leases", `${name}-${randomUUID()}`);
}

function worker(leaseRoot: string, runId: string): ChildProcess {
	const child = spawn(
		process.execPath,
		["--import", "tsx", "test/fixtures/run-lease-worker.ts", leaseRoot, runId],
		{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
	);
	children.add(child);
	child.once("exit", () => children.delete(child));
	return child;
}

function record(child: ChildProcess): Promise<WorkflowRunLeaseRecord> {
	return new Promise((resolve, reject) => {
		let output = "";
		// The worker spawns a tsx child process; under full-suite load its 20 s
		// allowance fired (a third load-related failure in this repository) while
		// the isolated run takes about 3 s, so it shares the suite-wide bound.
		const timeout = setTimeout(() => reject(new Error(output)), 60_000);
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code) reject(new Error(`worker exited ${code}: ${output}`));
		});
		child.stdout?.on("data", (chunk) => {
			output += chunk.toString();
			const newline = output.indexOf("\n");
			if (newline < 0) return;
			clearTimeout(timeout);
			resolve(JSON.parse(output.slice(0, newline)) as WorkflowRunLeaseRecord);
		});
		child.stderr?.on("data", (chunk) => {
			output += chunk.toString();
		});
	});
}

function exited(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => child.once("exit", () => resolve()));
}

afterEach(async () => {
	const exits = [...children].map(exited);
	for (const child of children) child.kill("SIGKILL");
	await Promise.all(exits);
});

describe("workflow run leases", () => {
	it("excludes another process and increments after owner death", async () => {
		const leaseRoot = root("crash");
		const child = worker(leaseRoot, "workflow_crash");
		const first = await record(child);
		await expect(
			acquireWorkflowRunLease({
				storeRoot: leaseRoot,
				runId: "workflow_crash",
				ownerId: "replacement",
			}),
		).rejects.toBeInstanceOf(WorkflowRunLeaseUnavailableError);
		const exit = exited(child);
		child.kill("SIGKILL");
		await exit;
		const replacement = await acquireWorkflowRunLease({
			storeRoot: leaseRoot,
			runId: "workflow_crash",
			ownerId: "replacement",
		});
		expect(replacement.record.generation).toBe(first.generation + 1);
		await replacement.release();
	});

	it("fences a released writer after replacement", async () => {
		const leaseRoot = root("fence");
		const first = await acquireWorkflowRunLease({
			storeRoot: leaseRoot,
			runId: "workflow_fence",
			ownerId: "first",
		});
		await first.release();
		const second = await acquireWorkflowRunLease({
			storeRoot: leaseRoot,
			runId: "workflow_fence",
			ownerId: "second",
		});
		await expect(first.assertCurrent()).rejects.toBeInstanceOf(
			WorkflowRunLeaseFencedError,
		);
		await second.assertCurrent();
		await second.release();
	});

	it("drains active mutations before releasing ownership", async () => {
		const storeRoot = root("drain");
		const first = await acquireWorkflowRunLease({
			storeRoot,
			runId: "workflow_drain",
			ownerId: "first",
		});
		let unblock = () => {};
		const blocked = new Promise<void>((resolve) => {
			unblock = resolve;
		});
		const mutation = first.withCurrent(() => blocked);
		const release = first.release();
		await expect(
			acquireWorkflowRunLease({
				storeRoot,
				runId: "workflow_drain",
				ownerId: "replacement",
			}),
		).rejects.toBeInstanceOf(WorkflowRunLeaseUnavailableError);
		unblock();
		await mutation;
		await release;
		const replacement = await acquireWorkflowRunLease({
			storeRoot,
			runId: "workflow_drain",
			ownerId: "replacement",
		});
		expect(replacement.record.generation).toBe(2);
		await replacement.release();
	});

	it("prevents a fenced journal from appending", async () => {
		const base = root("journal");
		const first = await acquireWorkflowRunLease({
			storeRoot: base,
			runId: "workflow_journal",
			ownerId: "first",
		});
		const journal = await WorkflowRunJournal.open(
			base,
			"workflow_journal",
			first,
		);
		const runCreated = {
			definitionIdentitySha256: "a".repeat(64),
			inputSha256: "b".repeat(64),
		};
		await journal.append("run-created", runCreated);
		await first.release();
		const second = await acquireWorkflowRunLease({
			storeRoot: base,
			runId: "workflow_journal",
			ownerId: "second",
		});
		await expect(
			journal.append("run-created", runCreated),
		).rejects.toBeInstanceOf(WorkflowRunLeaseFencedError);
		const adopted = await WorkflowRunJournal.open(
			base,
			"workflow_journal",
			second,
		);
		expect(
			(
				await adopted.append("run-status-changed", {
					from: "created",
					to: "running",
				})
			).sequence,
		).toBe(2);
		await second.release();
	});
});

const LEASE_BANNER_PREFIX = "pi-workflow-lease/1 ";

interface Decoy {
	readonly port: number;
	close(): Promise<void>;
}

/**
 * Stands in for an unrelated process holding a lease candidate port. Two real
 * run IDs cannot be forced to collide, so the occupant is bound directly.
 * `banner` of undefined keeps the connection open and silent.
 */
async function decoy(port: number, banner?: string): Promise<Decoy> {
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.once("close", () => sockets.delete(socket));
		if (banner !== undefined) socket.end(banner);
	});
	server.on("error", () => {});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
			server.off("error", reject);
			resolve();
		});
	});
	return {
		port,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}

/** Reads the identity line a lease listener answers a connection with. */
function readBanner(port: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: "127.0.0.1", port });
		let text = "";
		const settle = (outcome: () => void) => {
			socket.destroy();
			outcome();
		};
		socket.once("error", (error) => settle(() => reject(error)));
		socket.on("data", (chunk) => {
			text += chunk.toString("utf8");
			const end = text.indexOf("\n");
			if (end < 0) return;
			settle(() => resolve(text.slice(0, end + 1)));
		});
		socket.once("end", () =>
			settle(() => reject(new Error(`lease banner truncated: ${text}`))),
		);
	});
}

/** The identity the listener must answer with, over the canonical store root. */
async function leaseIdentity(
	storeRoot: string,
	runId: string,
): Promise<string> {
	const canonical = await realpath(storeRoot);
	return createHash("sha256").update(`${canonical}\0${runId}`).digest("hex");
}

async function recordPath(storeRoot: string, runId: string): Promise<string> {
	return path.join(await realpath(storeRoot), "leases", `${runId}.lease.json`);
}

describe("workflow run lease port collisions", () => {
	it("walks past a foreign lease holding the first candidate port", async () => {
		const storeRoot = root("foreign");
		const runId = "workflow_foreign";
		const probe = await acquireWorkflowRunLease({
			storeRoot,
			runId,
			ownerId: "probe",
		});
		const firstCandidate = probe.record.port;
		await probe.release();
		const stranger = await decoy(
			firstCandidate,
			`${LEASE_BANNER_PREFIX}${createHash("sha256").update("unrelated-run").digest("hex")}\n`,
		);
		try {
			const lease = await acquireWorkflowRunLease({
				storeRoot,
				runId,
				ownerId: "owner",
			});
			try {
				expect(lease.record.port).not.toBe(firstCandidate);
				expect(lease.record.port).toBeGreaterThanOrEqual(20_000);
				expect(lease.record.port).toBeLessThanOrEqual(39_999);
				expect(lease.record.generation).toBe(probe.record.generation + 1);
				expect(await readBanner(lease.record.port)).toBe(
					`${LEASE_BANNER_PREFIX}${await leaseIdentity(storeRoot, runId)}\n`,
				);
			} finally {
				await lease.release();
			}
		} finally {
			await stranger.close();
		}
	});

	it("refuses a second acquirer at the port the owner moved to", async () => {
		const storeRoot = root("moved");
		const runId = "workflow_moved";
		const probe = await acquireWorkflowRunLease({
			storeRoot,
			runId,
			ownerId: "probe",
		});
		const firstCandidate = probe.record.port;
		await probe.release();
		const stranger = await decoy(
			firstCandidate,
			`${LEASE_BANNER_PREFIX}${createHash("sha256").update("unrelated-run").digest("hex")}\n`,
		);
		try {
			const owner = await acquireWorkflowRunLease({
				storeRoot,
				runId,
				ownerId: "owner",
			});
			try {
				expect(owner.record.port).not.toBe(firstCandidate);
				await expect(
					acquireWorkflowRunLease({
						storeRoot,
						runId,
						ownerId: "second",
					}),
				).rejects.toBeInstanceOf(WorkflowRunLeaseUnavailableError);
			} finally {
				await owner.release();
			}
		} finally {
			await stranger.close();
		}
	});

	it("fails closed when the occupant never identifies itself", async () => {
		const storeRoot = root("silent");
		const runId = "workflow_silent";
		const probe = await acquireWorkflowRunLease({
			storeRoot,
			runId,
			ownerId: "probe",
		});
		const firstCandidate = probe.record.port;
		await probe.release();
		const silent = await decoy(firstCandidate);
		try {
			await expect(
				acquireWorkflowRunLease({ storeRoot, runId, ownerId: "owner" }),
			).rejects.toBeInstanceOf(WorkflowRunLeaseUnavailableError);
		} finally {
			await silent.close();
		}
	});

	it("fails closed on a malformed occupant banner", async () => {
		const storeRoot = root("malformed");
		const runId = "workflow_malformed";
		const probe = await acquireWorkflowRunLease({
			storeRoot,
			runId,
			ownerId: "probe",
		});
		const firstCandidate = probe.record.port;
		await probe.release();
		const garbled = await decoy(firstCandidate, "garbage\n");
		try {
			await expect(
				acquireWorkflowRunLease({ storeRoot, runId, ownerId: "owner" }),
			).rejects.toBeInstanceOf(WorkflowRunLeaseUnavailableError);
		} finally {
			await garbled.close();
		}
	});

	it("reuses the recorded port after the owner releases it", async () => {
		const storeRoot = root("reuse");
		const runId = "workflow_reuse";
		const first = await acquireWorkflowRunLease({
			storeRoot,
			runId,
			ownerId: "first",
		});
		await first.release();
		const second = await acquireWorkflowRunLease({
			storeRoot,
			runId,
			ownerId: "second",
		});
		try {
			expect(second.record.port).toBe(first.record.port);
			expect(second.record.generation).toBe(first.record.generation + 1);
		} finally {
			await second.release();
		}
	});

	it("rejects a recorded port outside the candidate list", async () => {
		const storeRoot = root("tampered");
		const runId = "workflow_tampered";
		const first = await acquireWorkflowRunLease({
			storeRoot,
			runId,
			ownerId: "first",
		});
		await first.release();
		const file = await recordPath(storeRoot, runId);
		const tampered = {
			...(JSON.parse(await readFile(file, "utf8")) as WorkflowRunLeaseRecord),
			port: 1_500,
		};
		await writeFile(file, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
		await expect(
			acquireWorkflowRunLease({ storeRoot, runId, ownerId: "second" }),
		).rejects.toBeInstanceOf(WorkflowPersistenceCorruptionError);
	});
});
