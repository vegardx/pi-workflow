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
	type WorkflowRunRecord,
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
			contractRevision: 19 as const,
			runId: "workflow_record" as const,
			depth: 0,
			definitionName: "example",
			definitionPath: "/repo/workflows/example.workflow.ts",
			definitionIdentitySha256: hash,
			definitionSourceSha256: hash,
			definitionKind: "static" as const,
			concurrency: 4,
			declaredBudget: { cost: 1000, childRuntimeMs: 3600000 },
			effectiveBudget: { cost: 1000, childRuntimeMs: 3600000 },
			declaredTimeoutMs: 3600000,
			effectiveTimeoutMs: 3600000,
			deadlineAt: "2026-09-01T01:00:00.000Z",
			cwd: "/repo",
			input: { question: "why" },
			createdAt: "2026-09-01T00:00:00.000Z",
		};
		await store.create(record);
		expect(await store.read()).toEqual(record);
		await expect(store.create(record)).rejects.toThrow("already exists");
	});

	it("requires lineage exactly when the run is nested", async () => {
		const { store } = await fixture();
		const root = {
			schema: "pi-workflow-run" as const,
			contractRevision: 19 as const,
			runId: "workflow_record" as const,
			depth: 0,
			definitionName: "example",
			definitionPath: "/repo/workflows/example.workflow.ts",
			definitionIdentitySha256: hash,
			definitionSourceSha256: hash,
			definitionKind: "static" as const,
			concurrency: 4,
			declaredBudget: { cost: 1000, childRuntimeMs: 3600000 },
			effectiveBudget: { cost: 1000, childRuntimeMs: 3600000 },
			declaredTimeoutMs: 3600000,
			effectiveTimeoutMs: 3600000,
			deadlineAt: "2026-09-01T01:00:00.000Z",
			cwd: "/repo",
			input: { question: "why" },
			createdAt: "2026-09-01T00:00:00.000Z",
		};
		const parent = {
			runId: "workflow_parent",
			taskId: `task_${"b".repeat(64)}`,
			executionId: `execution_${"c".repeat(64)}`,
			ancestorDefinitionIdentities: ["d".repeat(64)],
			inputArtifacts: {},
		};
		await expect(store.create({ ...root, depth: 1 })).rejects.toThrow(
			"invalid workflow run record",
		);
		await expect(store.create({ ...root, parent })).rejects.toThrow(
			"invalid workflow run record",
		);
		await expect(store.create({ ...root, depth: 2, parent })).rejects.toThrow(
			"invalid workflow run record",
		);
		await expect(
			store.create({
				...root,
				depth: 1,
				parent: { ...parent, runId: "workflow_record" },
			}),
		).rejects.toThrow("invalid workflow run record");
		await expect(
			store.create({
				...root,
				depth: 4,
				parent: {
					...parent,
					ancestorDefinitionIdentities: [
						"d".repeat(64),
						"e".repeat(64),
						"f".repeat(64),
						"1".repeat(64),
					],
				},
			}),
		).rejects.toThrow("invalid workflow run record");
		await expect(
			store.create({ ...root, contractRevision: 18 as unknown as 19 }),
		).rejects.toThrow("invalid workflow run record");
		const nested = { ...root, depth: 1, parent };
		await store.create(nested);
		expect(await store.read()).toEqual(nested);
	});

	it("binds injected input artifacts to the parent run", async () => {
		const { store } = await fixture();
		const parent = {
			runId: "workflow_parent",
			taskId: `task_${"b".repeat(64)}`,
			executionId: `execution_${"c".repeat(64)}`,
			ancestorDefinitionIdentities: ["d".repeat(64)],
			inputArtifacts: {},
		};
		const nested = {
			schema: "pi-workflow-run" as const,
			contractRevision: 19 as const,
			runId: "workflow_record" as const,
			depth: 1,
			parent,
			definitionName: "example",
			definitionPath: "/repo/workflows/example.workflow.ts",
			definitionIdentitySha256: hash,
			definitionSourceSha256: hash,
			definitionKind: "static" as const,
			concurrency: 4,
			declaredBudget: { cost: 1000, childRuntimeMs: 3600000 },
			effectiveBudget: { cost: 1000, childRuntimeMs: 3600000 },
			declaredTimeoutMs: 3600000,
			effectiveTimeoutMs: 3600000,
			deadlineAt: "2026-09-01T01:00:00.000Z",
			cwd: "/repo",
			input: { question: "why", answer: { value: "because" } },
			createdAt: "2026-09-01T00:00:00.000Z",
		};
		const artifact = {
			runId: "workflow_parent",
			artifactId: `artifact_${"e".repeat(64)}`,
			sha256: "f".repeat(64),
		};
		const { inputArtifacts: _omitted, ...withoutInputArtifacts } = parent;
		await expect(
			store.create({
				...nested,
				parent: withoutInputArtifacts as unknown as typeof parent,
			}),
		).rejects.toThrow("invalid workflow run record");
		await expect(
			store.create({
				...nested,
				parent: {
					...parent,
					inputArtifacts: {
						answer: { ...artifact, runId: "workflow_other" },
					},
				},
			}),
		).rejects.toThrow("invalid workflow run record");
		await expect(
			store.create({
				...nested,
				parent: {
					...parent,
					inputArtifacts: {
						answer: { ...artifact, runId: "workflow_record" },
					},
				},
			}),
		).rejects.toThrow("invalid workflow run record");
		await expect(
			store.create({
				...nested,
				parent: {
					...parent,
					inputArtifacts: { "Answer 1": artifact },
				},
			}),
		).rejects.toThrow("invalid workflow run record");
		const injected = {
			...nested,
			parent: { ...parent, inputArtifacts: { answer: artifact } },
		};
		await store.create(injected);
		expect(await store.read()).toEqual(injected);
	});

	it("rejects corruption and oversized input", async () => {
		const { store } = await fixture();
		await writeFile(store.path, "not-json\n");
		await expect(store.read()).rejects.toBeInstanceOf(WorkflowRunRecordError);
		await expect(
			store.create({
				schema: "pi-workflow-run",
				contractRevision: 19,
				runId: "workflow_record",
				depth: 0,
				definitionName: "example",
				definitionPath: "/repo/example.workflow.ts",
				definitionIdentitySha256: hash,
				definitionSourceSha256: hash,
				definitionKind: "static" as const,
				concurrency: 4,
				declaredBudget: { cost: 1000, childRuntimeMs: 3600000 },
				effectiveBudget: { cost: 1000, childRuntimeMs: 3600000 },
				declaredTimeoutMs: 3600000,
				effectiveTimeoutMs: 3600000,
				deadlineAt: "2026-09-01T01:00:00.000Z",
				cwd: "/repo",
				input: { value: "x".repeat(1024 * 1024) },
				createdAt: "2026-09-01T00:00:00.000Z",
			}),
		).rejects.toThrow();
	});

	it("requires the dynamic digests exactly when the definition is dynamic", async () => {
		const { store } = await fixture();
		const base = {
			schema: "pi-workflow-run" as const,
			contractRevision: 19 as const,
			runId: "workflow_record" as const,
			depth: 0,
			definitionName: "example",
			definitionPath: "/repo/.pi/workflow/dynamic/abc/source.workflow.ts",
			definitionIdentitySha256: hash,
			definitionSourceSha256: hash,
			concurrency: 4,
			declaredBudget: { cost: 1000, childRuntimeMs: 3600000 },
			effectiveBudget: { cost: 1000, childRuntimeMs: 3600000 },
			declaredTimeoutMs: 3600000,
			effectiveTimeoutMs: 3600000,
			deadlineAt: "2026-09-01T01:00:00.000Z",
			cwd: "/repo",
			input: { question: "why" },
			createdAt: "2026-09-01T00:00:00.000Z",
		};
		const approvalSha256 = "b".repeat(64);
		const hostApiSha256 = "c".repeat(64);
		const parent = {
			runId: "workflow_parent",
			taskId: `task_${"b".repeat(64)}`,
			executionId: `execution_${"c".repeat(64)}`,
			ancestorDefinitionIdentities: ["d".repeat(64)],
			inputArtifacts: {},
		};
		const invalid: WorkflowRunRecord[] = [
			// dynamic without digests
			{ ...base, definitionKind: "dynamic" },
			// dynamic with only one digest
			{ ...base, definitionKind: "dynamic", approvalSha256 },
			{ ...base, definitionKind: "dynamic", hostApiSha256 },
			// static with digests
			{ ...base, definitionKind: "static", approvalSha256, hostApiSha256 },
			{ ...base, definitionKind: "static", approvalSha256 },
			{ ...base, definitionKind: "static", hostApiSha256 },
			// dynamic nested child
			{
				...base,
				definitionKind: "dynamic",
				approvalSha256,
				hostApiSha256,
				depth: 1,
				parent,
			},
		];
		for (const record of invalid) {
			await expect(store.create(record)).rejects.toThrow(
				"invalid workflow run record",
			);
		}
		// unknown kinds and malformed digests fail the closed schema
		await expect(
			store.create({ ...base, definitionKind: "vm" as unknown as "static" }),
		).rejects.toThrow("invalid workflow run record");
		await expect(
			store.create({
				...base,
				definitionKind: "dynamic",
				approvalSha256: "B".repeat(64),
				hostApiSha256,
			}),
		).rejects.toThrow("invalid workflow run record");
		await expect(
			store.create({
				...base,
				definitionKind: "static",
				extra: true,
			} as unknown as WorkflowRunRecord),
		).rejects.toThrow("invalid workflow run record");

		const dynamic: WorkflowRunRecord = {
			...base,
			definitionKind: "dynamic",
			approvalSha256,
			hostApiSha256,
		};
		await store.create(dynamic);
		const read = await store.read();
		expect(read).toEqual(dynamic);
		expect(Object.isFrozen(read)).toBe(true);
		expect(
			await WorkflowRunRecordStore.readFrom(
				store.journal.directory,
				"workflow_record",
			),
		).toEqual(dynamic);
	});

	it("rejects persisted records whose kind and digests disagree", async () => {
		const { store } = await fixture();
		const persisted = {
			schema: "pi-workflow-run",
			contractRevision: 19,
			runId: "workflow_record",
			depth: 0,
			definitionName: "example",
			definitionPath: "/repo/workflows/example.workflow.ts",
			definitionIdentitySha256: hash,
			definitionSourceSha256: hash,
			definitionKind: "dynamic",
			concurrency: 4,
			declaredBudget: { cost: 1000, childRuntimeMs: 3600000 },
			effectiveBudget: { cost: 1000, childRuntimeMs: 3600000 },
			declaredTimeoutMs: 3600000,
			effectiveTimeoutMs: 3600000,
			deadlineAt: "2026-09-01T01:00:00.000Z",
			cwd: "/repo",
			input: { question: "why" },
			createdAt: "2026-09-01T00:00:00.000Z",
		};
		await writeFile(store.path, `${JSON.stringify(persisted)}\n`);
		await expect(store.read()).rejects.toThrow(
			"invalid workflow run record schema",
		);
		const { definitionKind: _dynamic, ...withoutKind } = persisted;
		await writeFile(store.path, `${JSON.stringify(withoutKind)}\n`);
		await expect(store.read()).rejects.toThrow(
			"invalid workflow run record schema",
		);
		await writeFile(
			store.path,
			`${JSON.stringify({
				...persisted,
				definitionKind: "static",
				hostApiSha256: "c".repeat(64),
			})}\n`,
		);
		await expect(store.read()).rejects.toThrow(
			"invalid workflow run record schema",
		);
		await writeFile(
			store.path,
			`${JSON.stringify({ ...persisted, definitionKind: "static" })}\n`,
		);
		await expect(store.read()).resolves.toMatchObject({
			definitionKind: "static",
		});
	});
});
