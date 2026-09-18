import { randomUUID } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunId, WorkflowRunStatus } from "../src/contracts.js";
import {
	PRUNABLE_WORKFLOW_RUN_STATUSES,
	pruneBatchName,
	pruneWorkflowRuns,
	WORKFLOW_TRASH_DIR_NAME,
	WORKFLOW_TRASH_LEASE_FILE_NAME,
	WORKFLOW_TRASH_MANIFEST_FILE_NAME,
	WORKFLOW_TRASH_RUN_DIR_NAME,
	type WorkflowPruneCandidate,
	WorkflowPruneManifestSchema,
} from "../src/persistence/retention.js";
import { acquireWorkflowRunLease } from "../src/persistence/run-lease.js";
import {
	createWorkflowService,
	type WorkflowService,
	WorkflowServiceError,
} from "../src/service.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";

/**
 * `/workflow prune`: store-level retention. Terminal runs and their lease
 * files move to recoverable trash, nothing is deleted, and a run that is
 * still running, still recoverable, or leased by a live process never moves.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function root(name: string): string {
	return path.resolve(".pi", "test-prune", `${name}-${randomUUID()}`);
}

function runId(suffix: string): WorkflowRunId {
	return `workflow_${suffix}` as WorkflowRunId;
}

function candidate(
	suffix: string,
	status: WorkflowRunStatus,
	updatedAt: string,
): WorkflowPruneCandidate {
	return { runId: runId(suffix), status, updatedAt };
}

/**
 * A run directory with recognisable bytes, and the lease record a finished
 * session leaves behind: acquired for real, then released, so the record is
 * canonical and its port is free.
 */
async function seedRun(storeRoot: string, id: WorkflowRunId): Promise<void> {
	const directory = path.join(storeRoot, "runs", id);
	await mkdir(path.join(directory, "tasks"), { recursive: true });
	await writeFile(path.join(directory, "events.jsonl"), `${id} journal\n`);
	await writeFile(path.join(directory, "tasks", "one.json"), `${id} task\n`);
	const lease = await acquireWorkflowRunLease({
		storeRoot,
		runId: id,
		ownerId: `pi-workflow:${id}`,
	});
	await lease.release();
}

async function exists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

function inertProvider(): WorkflowSubagentProvider {
	return {
		bind: vi.fn(
			async (id: string) =>
				({
					workflowRunId: id,
					ownerId: `pi-workflow:${id}`,
					client: {} as WorkflowSubagentBinding["client"],
				}) satisfies WorkflowSubagentBinding,
		),
	};
}

const OUTPUT_SCHEMA =
	'{ type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }';

function definition(name: string, body: string): string {
	return `export default {
  schema: "pi-workflow-definition",
  meta: { name: ${JSON.stringify(name)}, description: "Prune fixture", version: 1, budget: { cost: 10, childRuntimeMs: 1000 }, timeoutMs: 600000, concurrency: 1 },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: ${OUTPUT_SCHEMA},
  run(ctx) {
    ${body}
  }
};
`;
}

const services: WorkflowService[] = [];

async function serviceFixture() {
	const base = root("service");
	const cwd = path.join(base, "project");
	const storeRoot = path.join(cwd, "state");
	const workflows = path.join(cwd, "workflows");
	await mkdir(workflows, { recursive: true });
	await writeFile(
		path.join(workflows, "done.workflow.ts"),
		definition("done", 'return { answer: "done" };'),
	);
	await writeFile(
		path.join(workflows, "boom.workflow.ts"),
		definition("boom", 'throw new Error("boom");'),
	);
	const service = await createWorkflowService({
		cwd,
		agentDir: path.join(base, "agent"),
		storeRoot,
		projectTrusted: () => true,
		subagents: inertProvider(),
	});
	services.push(service);
	return { service, storeRoot };
}

afterEach(async () => {
	while (services.length > 0) await services.pop()?.shutdown();
});

describe("store-level prune", () => {
	it("selects only terminal statuses and moves nothing on a dry run", async () => {
		const storeRoot = root("dry");
		const now = new Date("2026-03-04T05:06:07.000Z");
		const stale = new Date(now.getTime() - DAY_MS).toISOString();
		const candidates = [
			candidate("completed", "completed", stale),
			candidate("degraded", "completed-degraded", stale),
			candidate("failed", "failed", stale),
			candidate("cancelled", "cancelled", stale),
			candidate("running", "running", stale),
			candidate("waiting", "waiting", stale),
			candidate("stopping", "stopping", stale),
			candidate("interrupted", "interrupted", stale),
			candidate("blocked", "cleanup-blocked", stale),
		];
		for (const entry of candidates) await seedRun(storeRoot, entry.runId);
		const report = await pruneWorkflowRuns({
			storeRoot,
			candidates,
			dryRun: true,
			now,
		});
		expect(report.dryRun).toBe(true);
		expect(report.batch).toBe("20260304-050607");
		expect(report.selected.map((run) => run.status).sort()).toEqual(
			[...PRUNABLE_WORKFLOW_RUN_STATUSES].sort(),
		);
		expect(report.selected.every((run) => run.trashPath === undefined)).toBe(
			true,
		);
		expect(report.skipped.map((run) => run.status).sort()).toEqual([
			"cleanup-blocked",
			"interrupted",
			"running",
			"stopping",
			"waiting",
		]);
		expect(report.skipped.every((run) => run.reason === "not-terminal")).toBe(
			true,
		);
		// A dry run creates nothing and moves nothing.
		expect(await exists(path.join(storeRoot, WORKFLOW_TRASH_DIR_NAME))).toBe(
			false,
		);
		for (const entry of candidates) {
			expect(await exists(path.join(storeRoot, "runs", entry.runId))).toBe(
				true,
			);
			expect(
				await exists(
					path.join(storeRoot, "leases", `${entry.runId}.lease.json`),
				),
			).toBe(true);
		}
	});

	it("moves the run directory, the lease, and a manifest into trash", async () => {
		const storeRoot = root("apply");
		const now = new Date("2026-03-04T05:06:07.000Z");
		const kept = candidate(
			"kept",
			"waiting",
			new Date(now.getTime() - DAY_MS).toISOString(),
		);
		const moved = candidate(
			"moved",
			"failed",
			new Date(now.getTime() - DAY_MS).toISOString(),
		);
		for (const entry of [kept, moved]) await seedRun(storeRoot, entry.runId);
		const report = await pruneWorkflowRuns({
			storeRoot,
			candidates: [kept, moved],
			dryRun: false,
			now,
		});
		expect(report.dryRun).toBe(false);
		expect(report.selected).toHaveLength(1);
		const [selection] = report.selected;
		const trashPath = path.join(
			storeRoot,
			WORKFLOW_TRASH_DIR_NAME,
			"20260304-050607",
			moved.runId,
		);
		expect(selection?.trashPath).toBe(trashPath);
		expect((await readdir(trashPath)).sort()).toEqual([
			WORKFLOW_TRASH_LEASE_FILE_NAME,
			WORKFLOW_TRASH_MANIFEST_FILE_NAME,
			WORKFLOW_TRASH_RUN_DIR_NAME,
		]);
		const manifest = JSON.parse(
			await readFile(
				path.join(trashPath, WORKFLOW_TRASH_MANIFEST_FILE_NAME),
				"utf8",
			),
		) as unknown;
		expect(Value.Check(WorkflowPruneManifestSchema, manifest)).toBe(true);
		expect(manifest).toMatchObject({
			schema: "pi-workflow-prune",
			runId: moved.runId,
			status: "failed",
			prunedAt: now.toISOString(),
		});
		expect((manifest as { reason: string }).reason).toContain("prune");
		// Nothing was deleted: the journal, the tasks, and the lease bytes are
		// all under the trash entry, and the live directories no longer hold them.
		expect(
			await readFile(
				path.join(trashPath, WORKFLOW_TRASH_RUN_DIR_NAME, "events.jsonl"),
				"utf8",
			),
		).toBe(`${moved.runId} journal\n`);
		expect(
			await readFile(
				path.join(trashPath, WORKFLOW_TRASH_RUN_DIR_NAME, "tasks", "one.json"),
				"utf8",
			),
		).toBe(`${moved.runId} task\n`);
		expect(
			JSON.parse(
				await readFile(
					path.join(trashPath, WORKFLOW_TRASH_LEASE_FILE_NAME),
					"utf8",
				),
			),
		).toMatchObject({ schema: "pi-workflow-run-lease", runId: moved.runId });
		expect(await exists(path.join(storeRoot, "runs", moved.runId))).toBe(false);
		expect(
			await exists(path.join(storeRoot, "leases", `${moved.runId}.lease.json`)),
		).toBe(false);
		// The run that was not terminal is untouched.
		expect(await exists(path.join(storeRoot, "runs", kept.runId))).toBe(true);
		expect(
			await exists(path.join(storeRoot, "leases", `${kept.runId}.lease.json`)),
		).toBe(true);
	});

	it("keeps runs inside the --older-than bound", async () => {
		const storeRoot = root("age");
		const now = new Date("2026-03-04T05:06:07.000Z");
		const old = candidate(
			"old",
			"completed",
			new Date(now.getTime() - 48 * HOUR_MS).toISOString(),
		);
		const recent = candidate(
			"recent",
			"completed",
			new Date(now.getTime() - HOUR_MS).toISOString(),
		);
		const exact = candidate(
			"exact",
			"completed",
			new Date(now.getTime() - 24 * HOUR_MS).toISOString(),
		);
		for (const entry of [old, recent, exact]) {
			await seedRun(storeRoot, entry.runId);
		}
		const report = await pruneWorkflowRuns({
			storeRoot,
			candidates: [old, recent, exact],
			dryRun: false,
			olderThanMs: 24 * HOUR_MS,
			now,
		});
		expect(report.olderThanMs).toBe(24 * HOUR_MS);
		expect(report.reason).toContain(`${24 * HOUR_MS} ms`);
		expect(report.selected.map((run) => run.runId).sort()).toEqual(
			[old.runId, exact.runId].sort(),
		);
		expect(report.skipped).toEqual([
			{ runId: recent.runId, status: "completed", reason: "too-recent" },
		]);
		expect(await exists(path.join(storeRoot, "runs", recent.runId))).toBe(true);
	});

	it("refuses a terminal run whose lease a live process holds", async () => {
		const storeRoot = root("lease");
		const live = candidate("live", "completed", "2026-03-04T00:00:00.000Z");
		const free = candidate("free", "completed", "2026-03-04T00:00:00.000Z");
		for (const entry of [live, free]) await seedRun(storeRoot, entry.runId);
		// A real lease: the acquirer binds the port a probe reads, so the refusal
		// is the same evidence another Pi process would present.
		const lease = await acquireWorkflowRunLease({
			storeRoot,
			runId: live.runId,
			ownerId: "pi-workflow:test",
		});
		try {
			const report = await pruneWorkflowRuns({
				storeRoot,
				candidates: [live, free],
				dryRun: false,
			});
			expect(report.skipped).toEqual([
				{ runId: live.runId, status: "completed", reason: "lease-held" },
			]);
			expect(report.selected.map((run) => run.runId)).toEqual([free.runId]);
			expect(await exists(path.join(storeRoot, "runs", live.runId))).toBe(true);
			expect(await exists(path.join(storeRoot, "runs", free.runId))).toBe(
				false,
			);
		} finally {
			await lease.release();
		}
		// Once the lease is released the same run prunes.
		const after = await pruneWorkflowRuns({
			storeRoot,
			candidates: [live],
			dryRun: false,
		});
		expect(after.selected.map((run) => run.runId)).toEqual([live.runId]);
		expect(after.skipped).toEqual([]);
	});

	it("names the batch directory by the UTC second", () => {
		expect(pruneBatchName(new Date("2026-12-31T23:59:59.999Z"))).toBe(
			"20261231-235959",
		);
	});

	it("refuses a duplicate or malformed candidate", async () => {
		const storeRoot = root("invalid");
		const one = candidate("one", "completed", "2026-03-04T00:00:00.000Z");
		await expect(
			pruneWorkflowRuns({ storeRoot, candidates: [one, one], dryRun: true }),
		).rejects.toThrow("invalid workflow prune candidate");
		await expect(
			pruneWorkflowRuns({
				storeRoot,
				candidates: [
					{
						runId: "../escape" as WorkflowRunId,
						status: "completed",
						updatedAt: "2026-03-04T00:00:00.000Z",
					},
				],
				dryRun: true,
			}),
		).rejects.toThrow("invalid workflow prune candidate");
	});
});

describe("service prune", () => {
	it("lists terminal runs on a dry run and moves them on an apply", async () => {
		const { service, storeRoot } = await serviceFixture();
		const first = await service.run("done", {});
		const second = await service.run("done", {});
		const failing = await service.run("boom", {});
		for (const receipt of [first, second, failing]) {
			await service.wait(receipt.runId, { timeoutMs: 30_000 });
		}
		const before = await service.listRuns({ limit: 50 });
		expect(before.runs).toHaveLength(3);
		expect(before.runs.map((run) => run.status).sort()).toEqual([
			"completed",
			"completed",
			"failed",
		]);

		const dry = await service.prune();
		expect(dry.dryRun).toBe(true);
		expect(dry.selected).toHaveLength(3);
		expect(dry.selected.every((run) => run.trashPath === undefined)).toBe(true);
		expect(await exists(path.join(storeRoot, WORKFLOW_TRASH_DIR_NAME))).toBe(
			false,
		);
		expect((await service.listRuns({ limit: 50 })).runs).toHaveLength(3);

		const applied = await service.prune({ dryRun: false });
		expect(applied.dryRun).toBe(false);
		expect(applied.selected).toHaveLength(3);
		expect(applied.skipped).toEqual([]);
		// A pruned run leaves the listing entirely.
		const after = await service.listRuns({ limit: 50 });
		expect(after.runs).toEqual([]);
		expect(after.total).toBe(0);
		expect(after.issues).toEqual([]);
		const batches = await readdir(
			path.join(storeRoot, WORKFLOW_TRASH_DIR_NAME),
		);
		expect(batches).toHaveLength(1);
		for (const run of applied.selected) {
			expect((await readdir(run.trashPath ?? "")).sort()).toEqual([
				WORKFLOW_TRASH_LEASE_FILE_NAME,
				WORKFLOW_TRASH_MANIFEST_FILE_NAME,
				WORKFLOW_TRASH_RUN_DIR_NAME,
			]);
			const manifest = JSON.parse(
				await readFile(
					path.join(run.trashPath ?? "", WORKFLOW_TRASH_MANIFEST_FILE_NAME),
					"utf8",
				),
			) as unknown;
			expect(Value.Check(WorkflowPruneManifestSchema, manifest)).toBe(true);
			// The evidence is recoverable by hand: the journal is still there.
			expect(
				await exists(
					path.join(
						run.trashPath ?? "",
						WORKFLOW_TRASH_RUN_DIR_NAME,
						"events.jsonl",
					),
				),
			).toBe(true);
		}
		// A second prune has nothing left to move.
		const again = await service.prune({ dryRun: false });
		expect(again.selected).toEqual([]);
	});

	it("keeps a run inside the --older-than bound", async () => {
		const { service, storeRoot } = await serviceFixture();
		const receipt = await service.run("done", {});
		await service.wait(receipt.runId, { timeoutMs: 30_000 });
		const bounded = await service.prune({ dryRun: false, olderThanMs: DAY_MS });
		expect(bounded.selected).toEqual([]);
		expect(bounded.skipped.map((run) => run.reason)).toEqual(["too-recent"]);
		expect((await service.listRuns({ limit: 50 })).runs).toHaveLength(1);
		expect(await exists(path.join(storeRoot, "runs", receipt.runId))).toBe(
			true,
		);
	});

	it("refuses an invalid prune option", async () => {
		const { service } = await serviceFixture();
		await expect(
			service.prune({ olderThanMs: 0 } as never),
		).rejects.toBeInstanceOf(WorkflowServiceError);
		await expect(service.prune({ unknown: true } as never)).rejects.toThrow(
			"Invalid workflow prune options.",
		);
	});
});

afterEach(async () => {
	await rm(path.resolve(".pi", "test-prune"), {
		recursive: true,
		force: true,
	}).catch(() => undefined);
});
