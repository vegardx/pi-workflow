import { randomUUID } from "node:crypto";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowRunJournal } from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
	WorkflowPersistenceCorruptionError,
	type WorkflowRunLease,
} from "../src/persistence/run-lease.js";

function fixtureRoot(name: string): string {
	return path.resolve(".pi", "test-journal", `${name}-${randomUUID()}`);
}

const leases = new Set<WorkflowRunLease>();

async function openJournal(root: string, runId: `workflow_${string}`) {
	const lease = await acquireWorkflowRunLease({
		storeRoot: root,
		runId,
		ownerId: "journal-test",
	});
	leases.add(lease);
	return {
		journal: await WorkflowRunJournal.open(root, runId, lease),
		lease,
	};
}

afterEach(async () => {
	await Promise.all([...leases].map((lease) => lease.release()));
	leases.clear();
});

describe("workflow run journal", () => {
	it("serializes appends with owner and fencing evidence", async () => {
		const root = fixtureRoot("append");
		const { journal, lease } = await openJournal(root, "workflow_abc123");
		const events = await Promise.all(
			Array.from({ length: 10 }, (_, index) =>
				journal.append("observed", { index }),
			),
		);
		expect(events.map((event) => event.sequence)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
		]);
		expect(events[0]).toMatchObject({
			ownerId: "journal-test",
			fencingGeneration: lease.record.generation,
		});
		expect((await stat(root)).mode & 0o777).toBe(0o700);
		expect((await stat(journal.journalPath)).mode & 0o777).toBe(0o600);
	});

	it("coordinates appends across instances sharing one lease", async () => {
		const root = fixtureRoot("instances");
		const first = await openJournal(root, "workflow_instances");
		const second = await WorkflowRunJournal.open(
			root,
			"workflow_instances",
			first.lease,
		);
		const events = await Promise.all([
			first.journal.append("first", {}),
			second.append("second", {}),
		]);
		expect(events.map((event) => event.sequence)).toEqual([1, 2]);
		expect(await first.journal.readEvents()).toHaveLength(2);
	});

	it("repairs one torn tail and rejects interior corruption", async () => {
		const root = fixtureRoot("torn");
		const first = await openJournal(root, "workflow_torn");
		await first.journal.append("created", {});
		await appendFile(first.journal.journalPath, Buffer.from([0xe2]));
		await first.lease.release();
		leases.delete(first.lease);

		const recovered = await openJournal(root, "workflow_torn");
		expect(await recovered.journal.readEvents()).toHaveLength(1);
		expect((await recovered.journal.append("continued", {})).sequence).toBe(2);
		await appendFile(recovered.journal.journalPath, "{broken}\n");
		await recovered.lease.release();
		leases.delete(recovered.lease);
		await expect(openJournal(root, "workflow_torn")).rejects.toBeInstanceOf(
			WorkflowPersistenceCorruptionError,
		);
	});

	it("rejects owner changes without a new fencing generation", async () => {
		const root = fixtureRoot("fencing");
		const first = await openJournal(root, "workflow_fencing");
		const event = await first.journal.append("created", {});
		await appendFile(
			first.journal.journalPath,
			`${JSON.stringify({
				...event,
				sequence: 2,
				eventId: randomUUID(),
				ownerId: "different-owner",
			})}\n`,
		);
		await first.lease.release();
		leases.delete(first.lease);
		await expect(openJournal(root, "workflow_fencing")).rejects.toBeInstanceOf(
			WorkflowPersistenceCorruptionError,
		);
	});

	it("writes and validates atomic snapshots", async () => {
		const { journal } = await openJournal(
			fixtureRoot("snapshot"),
			"workflow_snapshot",
		);
		await journal.append("created", {});
		await journal.writeSnapshot({ status: "created" });
		expect(await journal.readSnapshot()).toMatchObject({
			runId: "workflow_snapshot",
			lastSequence: 1,
			state: { status: "created" },
		});
		const invalid = JSON.parse(
			await readFile(journal.snapshotPath, "utf8"),
		) as { contractRevision: number };
		invalid.contractRevision += 1;
		await writeFile(journal.snapshotPath, JSON.stringify(invalid));
		await expect(journal.readSnapshot()).rejects.toBeInstanceOf(
			WorkflowPersistenceCorruptionError,
		);
	});

	it("rejects snapshots claiming events from a newer lease generation", async () => {
		const root = fixtureRoot("snapshot-fence");
		const first = await openJournal(root, "workflow_snapshotfence");
		await first.journal.append("first", {});
		await first.journal.writeSnapshot({ status: "running" });
		await first.lease.release();
		leases.delete(first.lease);
		const second = await openJournal(root, "workflow_snapshotfence");
		await second.journal.append("second", {});
		const snapshot = JSON.parse(
			await readFile(second.journal.snapshotPath, "utf8"),
		) as { lastSequence: number };
		snapshot.lastSequence = 2;
		await writeFile(
			second.journal.snapshotPath,
			`${JSON.stringify(snapshot)}\n`,
		);
		await expect(second.journal.readSnapshot()).rejects.toBeInstanceOf(
			WorkflowPersistenceCorruptionError,
		);
	});

	it("rejects non-serializable and oversized values before writing", async () => {
		const { journal } = await openJournal(
			fixtureRoot("bounds"),
			"workflow_bounds",
		);
		await expect(journal.append("undefined", undefined)).rejects.toThrow(
			"not losslessly JSON-serializable",
		);
		await expect(journal.writeSnapshot(undefined)).rejects.toThrow(
			"not losslessly JSON-serializable",
		);
		await expect(
			journal.append("lossy", { omitted: undefined }),
		).rejects.toThrow("not losslessly JSON-serializable");
		await expect(
			journal.append("large", { value: "x".repeat(70 * 1024) }),
		).rejects.toThrow("workflow journal event exceeds size limit");
		expect(await journal.readEvents()).toEqual([]);
	});
});
