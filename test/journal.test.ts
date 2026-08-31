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
import { rebuildWorkflowSnapshot } from "../src/reducer.js";

function fixtureRoot(name: string): string {
	return path.resolve(".pi", "test-journal", `${name}-${randomUUID()}`);
}

const leases = new Set<WorkflowRunLease>();
const runCreated = {
	definitionIdentitySha256: "a".repeat(64),
	inputSha256: "b".repeat(64),
};

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
		const inputs = [
			{ type: "run-created", data: runCreated },
			{
				type: "run-status-changed",
				data: { from: "created", to: "running" },
			},
			...Array.from({ length: 8 }, (_, index) => ({
				type: "run-status-changed" as const,
				data:
					index % 2 === 0
						? ({ from: "running", to: "waiting" } as const)
						: ({ from: "waiting", to: "running" } as const),
			})),
		] as const;
		const events = await Promise.all(
			inputs.map((input) => journal.appendEvent(input)),
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
			first.journal.append("run-created", runCreated),
			second.append("run-status-changed", {
				from: "created",
				to: "running",
			}),
		]);
		expect(events.map((event) => event.sequence)).toEqual([1, 2]);
		expect(await first.journal.readEvents()).toHaveLength(2);
	});

	it("repairs one torn tail and rejects interior corruption", async () => {
		const root = fixtureRoot("torn");
		const first = await openJournal(root, "workflow_torn");
		await first.journal.append("run-created", runCreated);
		await appendFile(first.journal.journalPath, Buffer.from([0xe2]));
		await first.lease.release();
		leases.delete(first.lease);

		const recovered = await openJournal(root, "workflow_torn");
		expect(await recovered.journal.readEvents()).toHaveLength(1);
		expect(
			(
				await recovered.journal.append("run-status-changed", {
					from: "created",
					to: "running",
				})
			).sequence,
		).toBe(2);
		await appendFile(recovered.journal.journalPath, "{broken}\n");
		await recovered.lease.release();
		leases.delete(recovered.lease);
		await expect(openJournal(root, "workflow_torn")).rejects.toBeInstanceOf(
			WorkflowPersistenceCorruptionError,
		);
	});

	it("rejects a complete read while a valid UTF-8 tail is incomplete", async () => {
		const { journal } = await openJournal(
			fixtureRoot("active-tail"),
			"workflow_activetail",
		);
		await journal.append("run-created", runCreated);
		await appendFile(journal.journalPath, '{"schema"');
		await expect(journal.readEvents()).rejects.toThrow(
			"incomplete trailing record",
		);
	});

	it("does not repair a tail before validating journal fencing", async () => {
		const root = fixtureRoot("repair-fencing");
		const first = await openJournal(root, "workflow_repairfencing");
		const event = await first.journal.append("run-created", runCreated);
		const newer = {
			...event,
			sequence: 2,
			eventId: randomUUID(),
			fencingGeneration: event.fencingGeneration + 1,
			type: "run-status-changed",
			data: { from: "created", to: "running" },
		};
		await appendFile(
			first.journal.journalPath,
			`${JSON.stringify(newer)}\n{"partial"`,
		);
		const before = (await stat(first.journal.journalPath)).size;
		await expect(
			WorkflowRunJournal.open(root, "workflow_repairfencing", first.lease),
		).rejects.toThrow("older than journal fencing evidence");
		expect((await stat(first.journal.journalPath)).size).toBe(before);
	});

	it("rejects owner changes without a new fencing generation", async () => {
		const root = fixtureRoot("fencing");
		const first = await openJournal(root, "workflow_fencing");
		const event = await first.journal.append("run-created", runCreated);
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
		await journal.append("run-created", runCreated);
		await rebuildWorkflowSnapshot(journal);
		const snapshot = await journal.readSnapshot();
		expect(snapshot).toMatchObject({
			runId: "workflow_snapshot",
			lastSequence: 1,
			state: { status: "created", currentEpoch: 1 },
		});
		if (!snapshot) throw new Error("missing snapshot");
		await expect(
			journal.writeSnapshot({
				...structuredClone(snapshot.state),
				status: "running",
			}),
		).rejects.toThrow("does not match journal reduction");
		const invalid = JSON.parse(
			await readFile(journal.snapshotPath, "utf8"),
		) as { contractRevision: number };
		invalid.contractRevision += 1;
		await writeFile(journal.snapshotPath, JSON.stringify(invalid));
		await expect(journal.readSnapshot()).rejects.toBeInstanceOf(
			WorkflowPersistenceCorruptionError,
		);
	});

	it("does not return a snapshot that omits the durable journal tail", async () => {
		const { journal } = await openJournal(
			fixtureRoot("stale-snapshot"),
			"workflow_stalesnapshot",
		);
		await journal.append("run-created", runCreated);
		await rebuildWorkflowSnapshot(journal);
		await journal.append("run-status-changed", {
			from: "created",
			to: "running",
		});
		expect(await journal.readSnapshot()).toBeUndefined();
	});

	it("rejects snapshots claiming events from a newer lease generation", async () => {
		const root = fixtureRoot("snapshot-fence");
		const first = await openJournal(root, "workflow_snapshotfence");
		await first.journal.append("run-created", runCreated);
		await rebuildWorkflowSnapshot(first.journal);
		await first.lease.release();
		leases.delete(first.lease);
		const second = await openJournal(root, "workflow_snapshotfence");
		await second.journal.append("run-status-changed", {
			from: "created",
			to: "running",
		});
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
		await expect(
			journal.append("run-created", undefined as never),
		).rejects.toThrow("invalid workflow journal event");
		await expect(journal.writeSnapshot(undefined as never)).rejects.toThrow(
			"invalid workflow run snapshot",
		);
		await expect(
			journal.append("run-created", { omitted: undefined } as never),
		).rejects.toThrow("invalid workflow journal event");
		await expect(
			journal.append("run-created", {
				...runCreated,
				value: "x".repeat(70 * 1024),
			} as never),
		).rejects.toThrow("invalid workflow journal event");
		expect(await journal.readEvents()).toEqual([]);
	});
});
