import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowRunJournal } from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
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
		const timeout = setTimeout(() => reject(new Error(output)), 10_000);
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
	}, 15_000);

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
