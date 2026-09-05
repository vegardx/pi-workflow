import { randomUUID } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	canonicalArtifactJson,
	WorkflowArtifactStore,
	WorkflowArtifactStoreError,
} from "../src/artifact-store.js";
import { WorkflowRunJournal } from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
	type WorkflowRunLease,
	WorkflowRunLeaseFencedError,
} from "../src/persistence/run-lease.js";

const leases = new Set<WorkflowRunLease>();
const hash = "a".repeat(64);

async function fixture() {
	const root = path.resolve(".pi", "test-artifacts", `run-${randomUUID()}`);
	const lease = await acquireWorkflowRunLease({
		storeRoot: root,
		runId: "workflow_artifacts",
		ownerId: "artifact-test",
	});
	leases.add(lease);
	const journal = await WorkflowRunJournal.open(
		root,
		"workflow_artifacts",
		lease,
	);
	await journal.append("run-created", {
		definitionIdentitySha256: hash,
		inputSha256: hash,
	});
	return { root, lease, journal };
}

afterEach(async () => {
	await Promise.all([...leases].map((lease) => lease.release()));
	leases.clear();
});

describe("workflow artifact store", () => {
	it("stores canonical content-addressed JSON idempotently", async () => {
		const { journal } = await fixture();
		const store = await WorkflowArtifactStore.open({ journal });
		const metadata = {
			runId: "workflow_artifacts" as const,
			producerTaskId: "task_result" as const,
			output: "result" as const,
			schemaSha256: hash,
		};
		const first = await store.putJson({ z: 1, a: [true, "value"] }, metadata);
		const second = await store.putJson({ a: [true, "value"], z: 1 }, metadata);
		expect(second).toEqual(first);
		expect(await store.readJson(first)).toEqual({ a: [true, "value"], z: 1 });
		expect(
			await readFile(path.join(store.root, `${first.sha256}.json`)),
		).toEqual(canonicalArtifactJson({ a: [true, "value"], z: 1 }));
	});

	it("rejects non-JSON values and artifact bounds", async () => {
		const { journal } = await fixture();
		const store = await WorkflowArtifactStore.open({
			journal,
			maxArtifactBytes: 8,
			maxTotalBytes: 8,
		});
		const metadata = {
			runId: "workflow_artifacts" as const,
			producerTaskId: "task_result" as const,
			output: "result" as const,
			schemaSha256: hash,
		};
		await expect(
			store.putJson({ answer: "too large" }, metadata),
		).rejects.toThrow("byte limit");
		expect(() => canonicalArtifactJson({ value: undefined })).toThrow(
			WorkflowArtifactStoreError,
		);
		const cyclic: unknown[] = [];
		cyclic.push(cyclic);
		expect(() => canonicalArtifactJson(cyclic)).toThrow("cycle");
	});

	it("detects content corruption on read", async () => {
		const { journal } = await fixture();
		const store = await WorkflowArtifactStore.open({ journal });
		const ref = await store.putJson(
			{ answer: "yes" },
			{
				runId: "workflow_artifacts",
				producerTaskId: "task_result",
				output: "result",
				schemaSha256: hash,
			},
		);
		await writeFile(path.join(store.root, `${ref.sha256}.json`), "corrupt");
		await expect(store.readJson(ref)).rejects.toThrow("metadata mismatch");
	});

	it("rejects an artifact-directory symlink", async () => {
		const { journal } = await fixture();
		const outside = path.join(journal.directory, "outside");
		await mkdir(outside);
		await symlink(outside, path.join(journal.directory, "artifacts"));
		await expect(WorkflowArtifactStore.open({ journal })).rejects.toThrow(
			"escapes its run",
		);
	});

	it("fences writes after lease replacement", async () => {
		const { root, lease, journal } = await fixture();
		const store = await WorkflowArtifactStore.open({ journal });
		await lease.release();
		leases.delete(lease);
		const replacement = await acquireWorkflowRunLease({
			storeRoot: root,
			runId: "workflow_artifacts",
			ownerId: "replacement",
		});
		leases.add(replacement);
		await expect(
			store.putJson(
				{ answer: "no" },
				{
					runId: "workflow_artifacts",
					producerTaskId: "task_result",
					output: "result",
					schemaSha256: hash,
				},
			),
		).rejects.toBeInstanceOf(WorkflowRunLeaseFencedError);
	});
});
