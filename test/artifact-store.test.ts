import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { HANDOFF_EXPORT_MEDIA_TYPE } from "@vegardx/pi-subagent";
import { afterEach, describe, expect, it } from "vitest";
import {
	canonicalArtifactJson,
	WorkflowArtifactStore,
	WorkflowArtifactStoreError,
	type WorkflowHandoffArtifactMetadata,
} from "../src/artifact-store.js";
import {
	MAX_WORKFLOW_HANDOFF_BYTES,
	WORKFLOW_HANDOFF_FORMAT_SHA256,
} from "../src/contracts.js";
import { WorkflowRunJournal } from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
	type WorkflowRunLease,
	WorkflowRunLeaseFencedError,
} from "../src/persistence/run-lease.js";

const leases = new Set<WorkflowRunLease>();
const hash = "a".repeat(64);
const handoffCommit = "b".repeat(40);
const patch = Buffer.from(
	[
		`From ${handoffCommit} Mon Sep 17 00:00:00 2001`,
		"From: Writer <writer@example.com>",
		"Date: Mon, 1 Jan 2024 00:00:00 +0000",
		"Subject: [PATCH] add note",
		"",
		"---",
		"diff --git a/note.txt b/note.txt",
		"new file mode 100644",
		"index 0000000..3b18e51",
		"--- /dev/null",
		"+++ b/note.txt",
		"@@ -0,0 +1 @@",
		"+hello world",
		"",
	].join("\n"),
	"utf8",
);
const handoffMetadata: WorkflowHandoffArtifactMetadata = {
	runId: "workflow_artifacts",
	producerTaskId: "task_writer",
	producerExecutionId: "execution_writer",
	output: "handoff",
	mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
	schemaSha256: WORKFLOW_HANDOFF_FORMAT_SHA256,
};
const resultMetadata = {
	runId: "workflow_artifacts" as const,
	producerTaskId: "task_result" as const,
	producerExecutionId: "execution_result" as const,
	output: "result" as const,
	schemaSha256: hash,
};

function sha256(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function withMetadata(
	overrides: Record<string, unknown>,
): WorkflowHandoffArtifactMetadata {
	return {
		...handoffMetadata,
		...overrides,
	} as WorkflowHandoffArtifactMetadata;
}

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
			producerExecutionId: "execution_result" as const,
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
			producerExecutionId: "execution_result" as const,
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
				producerExecutionId: "execution_result",
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
					producerExecutionId: "execution_result",
					output: "result",
					schemaSha256: hash,
				},
			),
		).rejects.toBeInstanceOf(WorkflowRunLeaseFencedError);
	});
});

describe("workflow handoff artifacts", () => {
	it("round-trips a handoff as a content-addressed .patch blob", async () => {
		const { journal } = await fixture();
		const store = await WorkflowArtifactStore.open({ journal });
		const ref = await store.putBytes(patch, handoffMetadata);
		expect(ref).toMatchObject({
			runId: "workflow_artifacts",
			producerTaskId: "task_writer",
			producerExecutionId: "execution_writer",
			output: "handoff",
			mediaType: "application/x-git-format-patch",
			schemaSha256: WORKFLOW_HANDOFF_FORMAT_SHA256,
			sha256: sha256(patch),
			bytes: patch.byteLength,
		});
		expect(await readdir(store.root)).toEqual([`${ref.sha256}.patch`]);
		expect(
			await readFile(path.join(store.root, `${ref.sha256}.patch`)),
		).toEqual(patch);
		const content = await store.readBytes(ref);
		expect(Buffer.isBuffer(content)).toBe(true);
		expect(content.equals(patch)).toBe(true);
	});

	it("deduplicates identical handoff bytes and verifies an existing blob", async () => {
		const { journal } = await fixture();
		const store = await WorkflowArtifactStore.open({ journal });
		const first = await store.putBytes(patch, handoffMetadata);
		const second = await store.putBytes(Buffer.from(patch), handoffMetadata);
		expect(second).toEqual(first);
		const other = await store.putBytes(
			patch,
			withMetadata({ producerExecutionId: "execution_writer2" }),
		);
		expect(other.sha256).toBe(first.sha256);
		expect(other.id).not.toBe(first.id);
		expect(await readdir(store.root)).toEqual([`${first.sha256}.patch`]);

		const forged = Buffer.from(patch);
		forged[forged.byteLength - 2] = 0x21;
		await writeFile(path.join(store.root, `${first.sha256}.patch`), forged);
		await expect(store.putBytes(patch, handoffMetadata)).rejects.toThrow(
			"existing workflow artifact does not match its digest",
		);
	});

	it("rejects empty and oversize handoffs", async () => {
		const { journal } = await fixture();
		const store = await WorkflowArtifactStore.open({ journal });
		await expect(
			store.putBytes(Buffer.alloc(0), handoffMetadata),
		).rejects.toThrow("workflow handoff artifact is empty");
		await expect(
			store.putBytes(
				Buffer.alloc(MAX_WORKFLOW_HANDOFF_BYTES + 1, 0x20),
				handoffMetadata,
			),
		).rejects.toThrow("workflow handoff artifact exceeds byte limit");

		const bounded = await WorkflowArtifactStore.open({
			journal,
			maxArtifactBytes: patch.byteLength - 1,
			maxTotalBytes: patch.byteLength - 1,
		});
		await expect(bounded.putBytes(patch, handoffMetadata)).rejects.toThrow(
			"workflow handoff artifact exceeds byte limit",
		);
		expect(await readdir(store.root)).toEqual([]);
	});

	it("rejects handoff metadata that is not a handoff", async () => {
		const { journal } = await fixture();
		const store = await WorkflowArtifactStore.open({ journal });
		for (const overrides of [
			{ output: "result" },
			{ mediaType: "application/json" },
			{ schemaSha256: hash },
		]) {
			await expect(
				store.putBytes(patch, withMetadata(overrides)),
			).rejects.toThrow("invalid workflow handoff artifact metadata");
		}
		await expect(
			store.putBytes(patch, withMetadata({ producerExecutionId: undefined })),
		).rejects.toThrow(
			"artifact producer, execution, and output must appear together",
		);
		expect(await readdir(store.root)).toEqual([]);
	});

	it("counts .patch blobs against the store total bound", async () => {
		const { journal } = await fixture();
		const store = await WorkflowArtifactStore.open({
			journal,
			maxArtifactBytes: patch.byteLength,
			maxTotalBytes: patch.byteLength + 4,
		});
		await store.putBytes(patch, handoffMetadata);
		await expect(store.putJson({ ok: 1 }, resultMetadata)).rejects.toThrow(
			"workflow artifact store total limit exceeded",
		);
		const reversed = await WorkflowArtifactStore.open({
			journal: (await fixture()).journal,
			maxArtifactBytes: patch.byteLength,
			maxTotalBytes: patch.byteLength + 4,
		});
		await reversed.putJson({ ok: 1 }, resultMetadata);
		await expect(reversed.putBytes(patch, handoffMetadata)).rejects.toThrow(
			"workflow artifact store total limit exceeded",
		);
	});

	it("detects symlink, size, and digest mismatches on read", async () => {
		const { journal } = await fixture();
		const store = await WorkflowArtifactStore.open({ journal });
		const ref = await store.putBytes(patch, handoffMetadata);
		const target = path.join(store.root, `${ref.sha256}.patch`);

		const outside = path.join(journal.directory, "outside.patch");
		await writeFile(outside, patch);
		await rm(target);
		await symlink(outside, target);
		await expect(store.readBytes(ref)).rejects.toThrow(
			"workflow artifact metadata mismatch",
		);

		await rm(target);
		await writeFile(target, Buffer.concat([patch, Buffer.from("\n")]));
		await expect(store.readBytes(ref)).rejects.toThrow(
			"workflow artifact metadata mismatch",
		);

		const corrupt = Buffer.from(patch);
		corrupt[corrupt.byteLength - 2] = 0x21;
		await writeFile(target, corrupt);
		await expect(store.readBytes(ref)).rejects.toThrow(
			"workflow artifact digest mismatch",
		);
	});

	it("rejects stored bytes whose first line is not a git-format-patch separator", async () => {
		const { journal } = await fixture();
		const store = await WorkflowArtifactStore.open({ journal });
		for (const content of [
			Buffer.from("diff --git a/x b/x\n", "utf8"),
			Buffer.from(`From ${handoffCommit} Mon Sep 17 00:00:00 2001`, "utf8"),
			Buffer.from(`From ${handoffCommit} Mon Sep 17 00:00:00 2001\r\n`, "utf8"),
			Buffer.from(`From ${"g".repeat(40)} Mon Sep 17 00:00:00 2001\n`, "utf8"),
			Buffer.from(`From ${"c".repeat(39)} Mon Sep 17 00:00:00 2001\n`, "utf8"),
			Buffer.from(` From ${handoffCommit} Mon Sep 17 00:00:00 2001\n`, "utf8"),
		]) {
			const ref = await store.putBytes(content, handoffMetadata);
			await expect(store.readBytes(ref)).rejects.toThrow(
				"workflow handoff artifact is not a git-format-patch",
			);
		}
		const sha1 = await store.putBytes(
			Buffer.from(`From ${"c".repeat(40)} Mon Sep 17 00:00:00 2001\n`, "utf8"),
			handoffMetadata,
		);
		const sha256Commit = await store.putBytes(
			Buffer.from(`From ${"d".repeat(64)} Mon Sep 17 00:00:00 2001\n`, "utf8"),
			handoffMetadata,
		);
		expect((await store.readBytes(sha1)).byteLength).toBe(sha1.bytes);
		expect((await store.readBytes(sha256Commit)).byteLength).toBe(
			sha256Commit.bytes,
		);
	});

	it("keeps JSON and handoff readers apart", async () => {
		const { journal } = await fixture();
		const store = await WorkflowArtifactStore.open({ journal });
		const handoff = await store.putBytes(patch, handoffMetadata);
		const result = await store.putJson({ answer: "yes" }, resultMetadata);
		await expect(store.readJson(handoff)).rejects.toThrow(
			"invalid workflow artifact reference",
		);
		await expect(store.readBytes(result)).rejects.toThrow(
			"invalid workflow artifact reference",
		);
		for (const forged of [
			{ ...handoff, mediaType: "application/json" },
			{ ...handoff, output: "result" as const },
			{ ...handoff, schemaSha256: hash },
			{ ...handoff, bytes: 0 },
			{ ...handoff, runId: "workflow_other" as const },
			{ ...handoff, id: result.id },
		]) {
			await expect(store.readBytes(forged)).rejects.toThrow(
				"invalid workflow artifact reference",
			);
		}
		await expect(
			store.readBytes({ ...handoff, bytes: handoff.bytes + 1 }),
		).rejects.toThrow("workflow artifact metadata mismatch");
		const bounded = await WorkflowArtifactStore.open({
			journal,
			maxArtifactBytes: patch.byteLength - 1,
			maxTotalBytes: patch.byteLength - 1,
		});
		await expect(bounded.readBytes(handoff)).rejects.toThrow(
			"invalid workflow artifact reference",
		);
	});

	it("accepts a mixed .json/.patch directory and rejects unknown entries", async () => {
		const { journal } = await fixture();
		const store = await WorkflowArtifactStore.open({ journal });
		const handoff = await store.putBytes(patch, handoffMetadata);
		const result = await store.putJson({ answer: "yes" }, resultMetadata);
		const more = await store.putJson({ answer: "again" }, resultMetadata);
		expect((await readdir(store.root)).sort()).toEqual(
			[
				`${handoff.sha256}.patch`,
				`${result.sha256}.json`,
				`${more.sha256}.json`,
			].sort(),
		);
		expect(await store.readJson(result)).toEqual({ answer: "yes" });
		expect((await store.readBytes(handoff)).equals(patch)).toBe(true);

		await writeFile(path.join(store.root, "stray.txt"), "x");
		await expect(
			store.putBytes(Buffer.from(patch).fill(0x20, 0, 1), handoffMetadata),
		).rejects.toThrow("invalid workflow artifact entry: stray.txt");
		await expect(
			store.putJson({ answer: "no" }, resultMetadata),
		).rejects.toThrow("invalid workflow artifact entry: stray.txt");
	});

	it("fences handoff writes after lease replacement", async () => {
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
		await expect(store.putBytes(patch, handoffMetadata)).rejects.toBeInstanceOf(
			WorkflowRunLeaseFencedError,
		);
		expect(await readdir(store.root)).toEqual([]);
	});
});
