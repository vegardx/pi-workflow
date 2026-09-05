import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowRunJournal } from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
	type WorkflowRunLease,
} from "../src/persistence/run-lease.js";
import {
	WorkflowRunRecordError,
	WorkflowRunRecordStore,
} from "../src/run-record.js";

const leases = new Set<WorkflowRunLease>();
const hash = "a".repeat(64);

async function fixture() {
	const root = path.resolve(".pi", "test-run-record", randomUUID());
	const lease = await acquireWorkflowRunLease({
		storeRoot: root,
		runId: "workflow_record",
		ownerId: "record-test",
	});
	leases.add(lease);
	const journal = await WorkflowRunJournal.open(root, "workflow_record", lease);
	return { lease, journal, store: WorkflowRunRecordStore.open(journal) };
}

afterEach(async () => {
	await Promise.all([...leases].map((lease) => lease.release()));
	leases.clear();
});

describe("workflow run record", () => {
	it("persists immutable definition and input recovery data", async () => {
		const { store } = await fixture();
		const record = {
			schema: "pi-workflow-run" as const,
			contractRevision: 1 as const,
			runId: "workflow_record" as const,
			definitionName: "example",
			definitionPath: "/repo/workflows/example.workflow.ts",
			definitionIdentitySha256: hash,
			definitionSourceSha256: hash,
			cwd: "/repo",
			input: { question: "why" },
			createdAt: "2026-09-01T00:00:00.000Z",
		};
		await store.create(record);
		expect(await store.read()).toEqual(record);
		await expect(store.create(record)).rejects.toThrow("already exists");
	});

	it("rejects corruption and oversized input", async () => {
		const { store } = await fixture();
		await writeFile(store.path, "not-json\n");
		await expect(store.read()).rejects.toBeInstanceOf(WorkflowRunRecordError);
		await expect(
			store.create({
				schema: "pi-workflow-run",
				contractRevision: 1,
				runId: "workflow_record",
				definitionName: "example",
				definitionPath: "/repo/example.workflow.ts",
				definitionIdentitySha256: hash,
				definitionSourceSha256: hash,
				cwd: "/repo",
				input: { value: "x".repeat(1024 * 1024) },
				createdAt: "2026-09-01T00:00:00.000Z",
			}),
		).rejects.toThrow();
	});
});
