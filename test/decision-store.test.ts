import { randomUUID } from "node:crypto";
import {
	mkdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalArtifactJson } from "../src/artifact-store.js";
import { WORKFLOW_CONTRACT_REVISION } from "../src/contracts.js";
import {
	CheckpointDecisionBindingSchema,
	deriveDecisionBindingSha256,
	deriveDecisionRecordSha256,
	MAX_WORKFLOW_DECISION_RECORD_BYTES,
	SourceApprovalDecisionBindingSchema,
	type WorkflowDecisionBinding,
	WorkflowDecisionBindingSchema,
	type WorkflowDecisionRecord,
	WorkflowDecisionRecordError,
	WorkflowDecisionRecordSchema,
	WorkflowDecisionRecordStore,
} from "../src/decision-store.js";
import {
	DYNAMIC_SOURCE_APPROVAL_SCHEMA_SHA256,
	type DynamicSourceApproval,
} from "../src/dynamic/contracts.js";
import { deriveJsonValueSha256 } from "../src/execution.js";
import { WorkflowRunJournal } from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
	type WorkflowRunLease,
	WorkflowRunLeaseFencedError,
} from "../src/persistence/run-lease.js";

const leases = new Set<WorkflowRunLease>();
const runId = "workflow_decisions" as const;
const hash = "a".repeat(64);
const binding: WorkflowDecisionBinding = {
	kind: "checkpoint",
	runId,
	taskId: `task_${"b".repeat(64)}`,
	executionId: `execution_${"c".repeat(64)}`,
	effectSha256: "d".repeat(64),
};
const value = { proceed: true, note: "ship it" };
const record: WorkflowDecisionRecord = {
	schema: "pi-workflow-decision",
	contractRevision: WORKFLOW_CONTRACT_REVISION,
	binding,
	source: "operator",
	decidedBy: "vegard",
	reason: "Plan looks right.",
	decidedAt: "2026-09-15T10:00:00.000Z",
	valueSchemaSha256: hash,
	valueSha256: deriveJsonValueSha256(value),
	value,
};

function recordWith(
	overrides: Record<string, unknown>,
): WorkflowDecisionRecord {
	return { ...record, ...overrides } as WorkflowDecisionRecord;
}

function withValue(next: unknown): WorkflowDecisionRecord {
	return recordWith({ value: next, valueSha256: deriveJsonValueSha256(next) });
}

function targetOf(root: string, target: WorkflowDecisionBinding): string {
	return path.join(root, `${deriveDecisionBindingSha256(target)}.json`);
}

async function fixture() {
	const root = path.resolve(".pi", "test-decisions", `run-${randomUUID()}`);
	const lease = await acquireWorkflowRunLease({
		storeRoot: root,
		runId,
		ownerId: "decision-test",
	});
	leases.add(lease);
	const journal = await WorkflowRunJournal.open(root, runId, lease);
	await journal.append("run-created", {
		definitionIdentitySha256: hash,
		inputSha256: hash,
	});
	return { root, lease, journal };
}

async function openStore() {
	const context = await fixture();
	const store = await WorkflowDecisionRecordStore.open({
		journal: context.journal,
	});
	return { ...context, store };
}

afterEach(async () => {
	await Promise.all([...leases].map((lease) => lease.release()));
	leases.clear();
});

describe("workflow decision record schema", () => {
	it("follows the contract revision constant", () => {
		expect(WorkflowDecisionRecordSchema.properties.contractRevision.const).toBe(
			WORKFLOW_CONTRACT_REVISION,
		);
		expect(WORKFLOW_CONTRACT_REVISION).toBe(20);
		expect(WorkflowDecisionRecordSchema.properties.schema.const).toBe(
			"pi-workflow-decision",
		);
	});

	it("is a discriminated binding union over checkpoint and source approval", () => {
		expect(WorkflowDecisionBindingSchema.anyOf).toEqual([
			CheckpointDecisionBindingSchema,
			SourceApprovalDecisionBindingSchema,
		]);
		expect(CheckpointDecisionBindingSchema.properties.kind.const).toBe(
			"checkpoint",
		);
		expect(SourceApprovalDecisionBindingSchema.properties.kind.const).toBe(
			"source-approval",
		);
		expect(
			SourceApprovalDecisionBindingSchema.properties.contractRevision.const,
		).toBe(WORKFLOW_CONTRACT_REVISION);
		expect(
			Value.Check(CheckpointDecisionBindingSchema, { ...binding, extra: 1 }),
		).toBe(false);
		expect(
			Value.Check(WorkflowDecisionRecordSchema, { ...record, extra: 1 }),
		).toBe(false);
		expect(Value.Check(WorkflowDecisionRecordSchema, record)).toBe(true);
	});

	it("derives the binding digest from canonical JSON", () => {
		const reordered = {
			effectSha256: binding.effectSha256,
			executionId: binding.executionId,
			taskId: binding.taskId,
			runId: binding.runId,
			kind: "checkpoint",
		} as WorkflowDecisionBinding;
		expect(deriveDecisionBindingSha256(binding)).toBe(
			deriveJsonValueSha256(binding),
		);
		expect(deriveDecisionBindingSha256(reordered)).toBe(
			deriveDecisionBindingSha256(binding),
		);
		expect(deriveDecisionBindingSha256(binding)).toMatch(/^[a-f0-9]{64}$/);
	});
});

describe("workflow decision record store", () => {
	it("opens <run dir>/decisions with owner-only permissions", async () => {
		const { journal, store } = await openStore();
		expect(store.root).toBe(path.join(journal.directory, "decisions"));
		const metadata = await stat(store.root);
		expect(metadata.isDirectory()).toBe(true);
		expect(metadata.mode & 0o777).toBe(0o700);
		const again = await WorkflowDecisionRecordStore.open({ journal });
		expect(again.root).toBe(store.root);
	});

	it("rejects a decisions directory that escapes its run", async () => {
		const { journal } = await fixture();
		const outside = path.join(journal.directory, "outside");
		await mkdir(outside);
		await symlink(outside, path.join(journal.directory, "decisions"));
		await expect(WorkflowDecisionRecordStore.open({ journal })).rejects.toThrow(
			"workflow decision directory escapes its run",
		);
	});

	it("round-trips a record addressed by its binding digest", async () => {
		const { store } = await openStore();
		expect(await store.read(binding)).toBeUndefined();
		expect(await store.put(record)).toEqual(record);
		const stored = await store.read(binding);
		expect(stored).toEqual(record);
		expect(Object.isFrozen(stored)).toBe(true);
		expect(Object.isFrozen(stored?.binding)).toBe(true);
		expect(Object.isFrozen(stored?.value)).toBe(true);
		const target = targetOf(store.root, binding);
		expect(await readFile(target)).toEqual(canonicalArtifactJson(record));
		expect((await stat(target)).mode & 0o777).toBe(0o600);
	});

	it("treats a byte-identical re-put as idempotent", async () => {
		const { store } = await openStore();
		await store.put(record);
		const reordered = {
			value: { note: "ship it", proceed: true },
			valueSha256: record.valueSha256,
			valueSchemaSha256: record.valueSchemaSha256,
			decidedAt: record.decidedAt,
			reason: record.reason,
			decidedBy: record.decidedBy,
			source: record.source,
			binding: { ...binding },
			contractRevision: record.contractRevision,
			schema: record.schema,
		} as WorkflowDecisionRecord;
		expect(await store.put(reordered)).toEqual(record);
		expect(await store.read(binding)).toEqual(record);
	});

	it("rejects a different record for the same binding", async () => {
		const { store } = await openStore();
		await store.put(record);
		await expect(store.put(withValue({ proceed: false }))).rejects.toThrow(
			"decision record already exists for this binding",
		);
		await expect(
			store.put(recordWith({ decidedBy: "someone-else" })),
		).rejects.toThrow("decision record already exists for this binding");
		await expect(
			store.put(recordWith({ decidedAt: "2026-09-15T11:00:00.000Z" })),
		).rejects.toThrow("decision record already exists for this binding");
		expect(await store.read(binding)).toEqual(record);
	});

	it("keeps bindings apart", async () => {
		const { store } = await openStore();
		const other: WorkflowDecisionBinding = {
			...binding,
			executionId: `execution_${"e".repeat(64)}`,
		};
		await store.put(record);
		await store.put(
			recordWith({
				binding: other,
				value: { proceed: false },
				valueSha256: deriveJsonValueSha256({ proceed: false }),
			}),
		);
		expect((await store.read(binding))?.value).toEqual(value);
		expect((await store.read(other))?.value).toEqual({ proceed: false });
	});

	it("rejects records that are not valid decision records", async () => {
		const { store } = await openStore();
		const invalid = "invalid workflow decision record";
		await expect(
			store.put(recordWith({ contractRevision: 18 })),
		).rejects.toThrow(invalid);
		await expect(
			store.put(recordWith({ schema: "pi-workflow-run" })),
		).rejects.toThrow(invalid);
		await expect(
			store.put(recordWith({ valueSha256: "0".repeat(64) })),
		).rejects.toThrow(invalid);
		await expect(store.put(recordWith({ extra: true }))).rejects.toThrow(
			invalid,
		);
		await expect(store.put(recordWith({ source: "default" }))).rejects.toThrow(
			invalid,
		);
		await expect(
			store.put(recordWith({ source: "operator", decidedBy: undefined })),
		).rejects.toThrow(invalid);
		await expect(store.put(recordWith({ decidedBy: "" }))).rejects.toThrow(
			invalid,
		);
		await expect(
			store.put(recordWith({ reason: "x".repeat(4097) })),
		).rejects.toThrow(invalid);
		await expect(
			store.put(
				recordWith({ binding: { ...binding, kind: "source-approval" } }),
			),
		).rejects.toThrow(invalid);
		await expect(
			store.put(
				recordWith({
					value: { nested: { value: undefined } },
					valueSha256: hash,
				}),
			),
		).rejects.toThrow(invalid);
		await expect(store.put(recordWith({ value: undefined }))).rejects.toThrow(
			invalid,
		);
		expect(await store.read(binding)).toBeUndefined();
	});

	it("accepts a default decision without an approver", async () => {
		const { store } = await openStore();
		const defaulted = recordWith({
			source: "default",
			decidedBy: undefined,
			reason: undefined,
		});
		const { decidedBy: _by, reason: _reason, ...expected } = defaulted;
		await store.put(expected as WorkflowDecisionRecord);
		expect(await store.read(binding)).toEqual(expected);
	});

	it("rejects records and bindings that belong to another run", async () => {
		const { store } = await openStore();
		const foreign: WorkflowDecisionBinding = {
			...binding,
			runId: "workflow_elsewhere",
		};
		await expect(store.put(recordWith({ binding: foreign }))).rejects.toThrow(
			"workflow decision record belongs to another run",
		);
		await expect(store.read(foreign)).rejects.toThrow(
			"workflow decision record belongs to another run",
		);
		await expect(
			store.read({ ...binding, effectSha256: "nope" }),
		).rejects.toThrow("invalid workflow decision binding");
	});

	it("bounds record size on write and read", async () => {
		const { store } = await openStore();
		const oversized = withValue({
			blob: "x".repeat(MAX_WORKFLOW_DECISION_RECORD_BYTES),
		});
		await expect(store.put(oversized)).rejects.toThrow(
			"workflow decision record exceeds size limit",
		);
		expect(await store.read(binding)).toBeUndefined();
		await writeFile(
			targetOf(store.root, binding),
			Buffer.alloc(MAX_WORKFLOW_DECISION_RECORD_BYTES + 1, 0x20),
		);
		await expect(store.read(binding)).rejects.toThrow(
			"workflow decision record exceeds size limit",
		);
	});

	it("rejects a stored record whose bytes are not canonical", async () => {
		const { store } = await openStore();
		await store.put(record);
		const target = targetOf(store.root, binding);
		await writeFile(target, JSON.stringify(record, null, 2));
		await expect(store.read(binding)).rejects.toThrow(
			"workflow decision record is not canonical",
		);
		await writeFile(target, `${canonicalArtifactJson(record).toString()}\n`);
		await expect(store.read(binding)).rejects.toThrow(
			"workflow decision record is not canonical",
		);
		await writeFile(target, Buffer.from([0xff, 0xfe, 0x7b, 0x7d]));
		await expect(store.read(binding)).rejects.toThrow(
			"workflow decision record is not canonical",
		);
		await writeFile(target, "not json");
		await expect(store.read(binding)).rejects.toThrow(
			"workflow decision record is not canonical",
		);
	});

	it("rejects a stored record whose digest or schema was tampered with", async () => {
		const { store } = await openStore();
		await store.put(record);
		const target = targetOf(store.root, binding);
		await writeFile(
			target,
			canonicalArtifactJson({ ...record, value: { proceed: false } }),
		);
		await expect(store.read(binding)).rejects.toThrow(
			"workflow decision record digest mismatch",
		);
		await writeFile(
			target,
			canonicalArtifactJson({ ...record, contractRevision: 18 }),
		);
		await expect(store.read(binding)).rejects.toThrow(
			"invalid workflow decision record",
		);
		await writeFile(
			target,
			canonicalArtifactJson({ ...record, source: "default" }),
		);
		await expect(store.read(binding)).rejects.toThrow(
			"invalid workflow decision record",
		);
	});

	it("rejects a stored record that names another binding", async () => {
		const { store } = await openStore();
		const other: WorkflowDecisionBinding = {
			...binding,
			effectSha256: "e".repeat(64),
		};
		await store.put(record);
		await writeFile(
			targetOf(store.root, binding),
			canonicalArtifactJson({ ...record, binding: other }),
		);
		await expect(store.read(binding)).rejects.toThrow(
			"workflow decision record does not match its binding",
		);
		await expect(store.put(record)).rejects.toThrow(
			"decision record already exists for this binding",
		);
	});

	it("refuses symlinked records", async () => {
		const { store, journal } = await openStore();
		const elsewhere = path.join(journal.directory, "elsewhere.json");
		await writeFile(elsewhere, canonicalArtifactJson(record));
		const target = targetOf(store.root, binding);
		await symlink(elsewhere, target);
		await expect(store.read(binding)).rejects.toThrow(
			"workflow decision record may not be a symlink",
		);
		await expect(store.put(record)).rejects.toThrow(
			"decision record already exists for this binding",
		);
		await rm(target);
		await mkdir(target);
		await expect(store.read(binding)).rejects.toThrow(
			"invalid workflow decision record",
		);
	});

	it("never scans the directory", async () => {
		const { store } = await openStore();
		await writeFile(path.join(store.root, "garbage.json"), "garbage");
		await writeFile(path.join(store.root, `${"0".repeat(64)}.json`), "{}");
		await symlink("/nonexistent", path.join(store.root, "dangling.json"));
		await store.put(record);
		expect(await store.read(binding)).toEqual(record);
	});

	it("serializes concurrent puts for one binding", async () => {
		const { store } = await openStore();
		const results = await Promise.allSettled([
			store.put(record),
			store.put(withValue({ proceed: false })),
			store.put(record),
		]);
		expect(results.map((result) => result.status)).toEqual([
			"fulfilled",
			"rejected",
			"fulfilled",
		]);
		expect(await store.read(binding)).toEqual(record);
	});

	it("fences writes after lease replacement", async () => {
		const { root, lease, journal, store } = await openStore();
		await store.put(record);
		await lease.release();
		leases.delete(lease);
		const replacement = await acquireWorkflowRunLease({
			storeRoot: root,
			runId,
			ownerId: "replacement",
		});
		leases.add(replacement);
		const other: WorkflowDecisionBinding = {
			...binding,
			executionId: `execution_${"e".repeat(64)}`,
		};
		await expect(
			store.put(recordWith({ binding: other })),
		).rejects.toBeInstanceOf(WorkflowRunLeaseFencedError);
		await expect(store.put(record)).rejects.toBeInstanceOf(
			WorkflowRunLeaseFencedError,
		);
		await expect(
			WorkflowDecisionRecordStore.open({ journal }),
		).rejects.toBeInstanceOf(WorkflowRunLeaseFencedError);
		expect(await store.read(other)).toBeUndefined();
		expect(await store.read(binding)).toEqual(record);
	});

	it("reads a record without the run's lease and never writes one", async () => {
		const { root, lease, store } = await openStore();
		await store.put(record);
		await lease.release();
		leases.delete(lease);

		const reader = await WorkflowDecisionRecordStore.openUnleased({
			storeRoot: root,
			runId,
		});
		expect(reader.root).toBe(store.root);
		expect(await reader.read(binding)).toEqual(record);
		const other: WorkflowDecisionBinding = {
			...binding,
			executionId: `execution_${"e".repeat(64)}`,
		};
		expect(await reader.read(other)).toBeUndefined();
		// A read-only store is still run-scoped: it writes nothing and it
		// answers for no other run and for no definition-level binding.
		await expect(reader.put(recordWith({ binding: other }))).rejects.toThrow(
			"read-only",
		);
		expect(await reader.read(other)).toBeUndefined();
		await expect(
			reader.read({ ...binding, runId: `workflow_${"f".repeat(32)}` }),
		).rejects.toThrow("belongs to another run");
		await expect(
			WorkflowDecisionRecordStore.openUnleased({
				storeRoot: root,
				runId: "no",
			}),
		).rejects.toThrow("invalid workflow run ID");
	});

	it("rejects a lease-free decisions directory that escapes its run", async () => {
		const { root, journal } = await fixture();
		const outside = path.join(journal.directory, "outside");
		await mkdir(outside);
		await symlink(outside, path.join(journal.directory, "decisions"));
		await expect(
			WorkflowDecisionRecordStore.openUnleased({ storeRoot: root, runId }),
		).rejects.toThrow("escapes its run");
	});

	it("names its errors", async () => {
		const { store } = await openStore();
		const error = await store
			.put(recordWith({ contractRevision: 18 }))
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(WorkflowDecisionRecordError);
		expect((error as Error).name).toBe("WorkflowDecisionRecordError");
	});
});

describe("definition-level decision store", () => {
	const sourceSha256 = "1".repeat(64);
	const definitionIdentitySha256 = "2".repeat(64);
	const approvalBinding: WorkflowDecisionBinding = {
		kind: "source-approval",
		definitionIdentitySha256,
		sourceSha256,
		contractRevision: WORKFLOW_CONTRACT_REVISION,
	};
	const approval: DynamicSourceApproval = {
		schema: "pi-workflow-source-approval",
		sourceSha256,
		manifestSha256: "3".repeat(64),
		hostApiSha256: "4".repeat(64),
		importPolicySha256: "5".repeat(64),
		definitionIdentitySha256,
		decision: "approved",
		approver: { kind: "human", via: "/workflow approve", sessionId: "s1" },
		approvedAt: "2026-09-15T10:00:00.000Z",
		projectRoot: "/projects/demo",
	};
	const approvalRecord: WorkflowDecisionRecord = {
		schema: "pi-workflow-decision",
		contractRevision: WORKFLOW_CONTRACT_REVISION,
		binding: approvalBinding,
		source: "operator",
		decidedBy: "human:/workflow approve",
		decidedAt: approval.approvedAt,
		valueSchemaSha256: DYNAMIC_SOURCE_APPROVAL_SCHEMA_SHA256,
		valueSha256: deriveJsonValueSha256(approval),
		value: approval,
	};

	function approvalWith(
		overrides: Record<string, unknown>,
		valueOverrides: Record<string, unknown> = {},
	): WorkflowDecisionRecord {
		const next = { ...approval, ...valueOverrides };
		return {
			...approvalRecord,
			...overrides,
			value: next,
			valueSha256: deriveJsonValueSha256(next),
		} as WorkflowDecisionRecord;
	}

	async function rootStore() {
		const base = path.resolve(".pi", "test-decisions", `root-${randomUUID()}`);
		const proposalDirectory = path.join(base, "dynamic", sourceSha256);
		await mkdir(proposalDirectory, { recursive: true });
		const directory = path.join(proposalDirectory, "decisions");
		const store = await WorkflowDecisionRecordStore.openRoot({ directory });
		return { base, directory, store };
	}

	it("opens a decisions directory owner-only without a journal or lease", async () => {
		const { directory, store } = await rootStore();
		expect(store.root).toBe(directory);
		const metadata = await stat(directory);
		expect(metadata.isDirectory()).toBe(true);
		expect(metadata.mode & 0o777).toBe(0o700);
		const again = await WorkflowDecisionRecordStore.openRoot({ directory });
		expect(again.root).toBe(directory);
	});

	it("rejects a decisions directory that escapes its root", async () => {
		const base = path.resolve(".pi", "test-decisions", `root-${randomUUID()}`);
		const outside = path.join(base, "outside");
		await mkdir(outside, { recursive: true });
		const directory = path.join(base, "decisions");
		await symlink(outside, directory);
		await expect(
			WorkflowDecisionRecordStore.openRoot({ directory }),
		).rejects.toThrow("workflow decision directory escapes its root");
		const file = path.join(base, "file");
		await writeFile(file, "");
		await expect(
			WorkflowDecisionRecordStore.openRoot({ directory: file }),
		).rejects.toThrow("workflow decision directory escapes its root");
	});

	it("round-trips a source approval and derives its record digest", async () => {
		const { store } = await rootStore();
		expect(await store.read(approvalBinding)).toBeUndefined();
		expect(await store.put(approvalRecord)).toEqual(approvalRecord);
		const stored = await store.read(approvalBinding);
		expect(stored).toEqual(approvalRecord);
		expect(Object.isFrozen(stored?.value)).toBe(true);
		const target = targetOf(store.root, approvalBinding);
		expect(await readFile(target)).toEqual(
			canonicalArtifactJson(approvalRecord),
		);
		expect((await stat(target)).mode & 0o777).toBe(0o600);
		expect(deriveDecisionRecordSha256(approvalRecord)).toBe(
			deriveJsonValueSha256(approvalRecord),
		);
		expect(deriveDecisionRecordSha256(approvalRecord)).toMatch(
			/^[a-f0-9]{64}$/,
		);
	});

	it("is immutable per binding", async () => {
		const { store } = await rootStore();
		await store.put(approvalRecord);
		expect(await store.put(approvalRecord)).toEqual(approvalRecord);
		await expect(
			store.put(approvalWith({}, { decision: "rejected" })),
		).rejects.toThrow("decision record already exists for this binding");
		await expect(
			store.put(approvalWith({ decidedAt: "2026-09-15T11:00:00.000Z" })),
		).rejects.toThrow("decision record already exists for this binding");
		expect(await store.read(approvalBinding)).toEqual(approvalRecord);
		const rebound: WorkflowDecisionBinding = {
			...approvalBinding,
			definitionIdentitySha256: "9".repeat(64),
		};
		await store.put(
			approvalWith(
				{ binding: rebound },
				{ definitionIdentitySha256: "9".repeat(64), decision: "rejected" },
			),
		);
		expect((await store.read(rebound))?.value).toMatchObject({
			decision: "rejected",
		});
		expect((await store.read(approvalBinding))?.value).toMatchObject({
			decision: "approved",
		});
	});

	it("keeps run-scoped and definition-level bindings apart", async () => {
		const { store: definitionStore } = await rootStore();
		const { store: runStore } = await openStore();
		await expect(runStore.put(approvalRecord)).rejects.toThrow(
			"workflow decision record binding does not belong to a run",
		);
		await expect(runStore.read(approvalBinding)).rejects.toThrow(
			"workflow decision record binding does not belong to a run",
		);
		await expect(definitionStore.put(record)).rejects.toThrow(
			"workflow decision record binding does not belong to a definition store",
		);
		await expect(definitionStore.read(binding)).rejects.toThrow(
			"workflow decision record binding does not belong to a definition store",
		);
		await expect(
			definitionStore.read({ ...approvalBinding, sourceSha256: "nope" }),
		).rejects.toThrow("invalid workflow decision binding");
	});

	it("requires a human operator decision whose value matches the binding", async () => {
		const { store } = await rootStore();
		const invalid = "invalid workflow decision record";
		await expect(
			store.put(approvalWith({ decidedBy: "model:workflow_propose" })),
		).rejects.toThrow(invalid);
		await expect(
			store.put(approvalWith({ decidedBy: "vegard" })),
		).rejects.toThrow(invalid);
		await expect(
			store.put(approvalWith({ source: "default", decidedBy: undefined })),
		).rejects.toThrow(invalid);
		await expect(
			store.put(approvalWith({ valueSchemaSha256: hash })),
		).rejects.toThrow(invalid);
		await expect(
			store.put(approvalWith({}, { sourceSha256: "8".repeat(64) })),
		).rejects.toThrow(invalid);
		await expect(
			store.put(approvalWith({}, { definitionIdentitySha256: "8".repeat(64) })),
		).rejects.toThrow(invalid);
		await expect(
			store.put(approvalWith({}, { approver: { kind: "model", via: "tool" } })),
		).rejects.toThrow(invalid);
		await expect(
			store.put(approvalWith({}, { decision: "maybe" })),
		).rejects.toThrow(invalid);
		await expect(store.put(approvalWith({}, { extra: 1 }))).rejects.toThrow(
			invalid,
		);
		await expect(
			store.put(
				recordWith({ binding: approvalBinding, valueSchemaSha256: hash }),
			),
		).rejects.toThrow(invalid);
		expect(await store.read(approvalBinding)).toBeUndefined();
	});

	it("rejects a stored approval that was tampered with", async () => {
		const { store } = await rootStore();
		await store.put(approvalRecord);
		const target = targetOf(store.root, approvalBinding);
		await writeFile(
			target,
			canonicalArtifactJson({
				...approvalRecord,
				value: { ...approval, decision: "rejected" },
			}),
		);
		await expect(store.read(approvalBinding)).rejects.toThrow(
			"workflow decision record digest mismatch",
		);
		const forged = { ...approval, decision: "rejected" };
		await writeFile(
			target,
			canonicalArtifactJson({
				...approvalRecord,
				value: forged,
				valueSha256: deriveJsonValueSha256(forged),
				decidedBy: "model:workflow_propose",
			}),
		);
		await expect(store.read(approvalBinding)).rejects.toThrow(
			"invalid workflow decision record",
		);
		await writeFile(
			target,
			`${canonicalArtifactJson(approvalRecord).toString()}\n`,
		);
		await expect(store.read(approvalBinding)).rejects.toThrow(
			"workflow decision record is not canonical",
		);
		await writeFile(target, canonicalArtifactJson(approvalRecord));
		expect(await store.read(approvalBinding)).toEqual(approvalRecord);
	});
});
