import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { WORKFLOW_CONTRACT_REVISION } from "../src/contracts.js";
import {
	deriveDecisionBindingSha256,
	deriveDecisionRecordSha256,
	type WorkflowDecisionRecord,
	WorkflowDecisionRecordSchema,
} from "../src/decision-store.js";
import {
	assertDynamicSourceRunnable,
	createSourceApprovalRecord,
	DynamicWorkflowApprovalError,
	decideDynamicSource,
	isDynamicSourceApprovalRecord,
	readSourceApproval,
	sourceApprovalBinding,
	toDynamicWorkflowProposalView,
} from "../src/dynamic/approval.js";
import {
	DYNAMIC_SOURCE_APPROVAL_SCHEMA_SHA256,
	DynamicSourceApprovalSchema,
} from "../src/dynamic/contracts.js";
import {
	deriveDynamicDefinitionIdentitySha256,
	deriveDynamicHostApiSha256,
} from "../src/dynamic/identity.js";
import {
	canonicalDynamicDocument,
	createDynamicWorkflowProposalRecord,
	DynamicWorkflowProposalStore,
} from "../src/dynamic/proposal-store.js";
import {
	readRunDefinitionCopy,
	verifyRunDefinitionCopy,
	writeRunDefinitionCopy,
} from "../src/dynamic/run-definition.js";
import { deriveDynamicSourceSha256 } from "../src/dynamic/source.js";
import { deriveJsonValueSha256 } from "../src/execution.js";

const cwd = "/projects/demo";
const importPolicySha256 = "c".repeat(64);
const hostApiSha256 = deriveDynamicHostApiSha256();
const approver = { kind: "human", via: "/workflow approve" } as const;
const source = `import { defineWorkflow } from "@vegardx/pi-workflow";
export default defineWorkflow({} as never);
`;
const manifest = {
	meta: {
		name: "approve-me",
		description: "A dynamic workflow awaiting approval",
		version: 1,
		budget: { cost: 5, childRuntimeMs: 1_800_000 },
		timeoutMs: 3_600_000,
		concurrency: 4,
	},
	inputSchema: { type: "object", additionalProperties: false },
	outputSchema: { type: "string" },
};

let clock = 0;
function now(): string {
	clock += 1;
	return `2026-09-15T10:00:${String(clock).padStart(2, "0")}.000Z`;
}

async function fixture(overrides: { projectRoot?: string } = {}) {
	const storeRoot = path.resolve(".pi", "test-dynamic-approval", randomUUID());
	const store = await DynamicWorkflowProposalStore.open({ storeRoot });
	const record = createDynamicWorkflowProposalRecord({
		sourceSha256: deriveDynamicSourceSha256(source),
		sourceBytes: Buffer.byteLength(source, "utf8"),
		manifest,
		importPolicySha256,
		proposer: { kind: "tool", via: "workflow_propose" },
		proposedAt: "2026-09-15T09:00:00.000Z",
		projectRoot: overrides.projectRoot ?? cwd,
	});
	const { proposal } = await store.put({ source, record });
	return { storeRoot, store, record, proposal, sha: record.sourceSha256 };
}

function decide(
	context: Awaited<ReturnType<typeof fixture>>,
	options: Partial<Parameters<typeof decideDynamicSource>[0]> = {},
) {
	return decideDynamicSource({
		store: context.store,
		sourceSha256: context.sha,
		decision: "approved",
		approver,
		cwd,
		hostApiSha256,
		importPolicySha256,
		now,
		...options,
	});
}

async function rejection(
	promise: Promise<unknown>,
): Promise<DynamicWorkflowApprovalError> {
	const error = await promise.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(DynamicWorkflowApprovalError);
	return error as DynamicWorkflowApprovalError;
}

describe("source approval binding", () => {
	it("binds the definition identity and source digest under the revision", () => {
		const binding = sourceApprovalBinding({
			definitionIdentitySha256: "1".repeat(64),
			sourceSha256: "2".repeat(64),
		});
		expect(binding).toEqual({
			kind: "source-approval",
			definitionIdentitySha256: "1".repeat(64),
			sourceSha256: "2".repeat(64),
			contractRevision: WORKFLOW_CONTRACT_REVISION,
		});
		expect(Object.isFrozen(binding)).toBe(true);
	});

	it("builds a human-only operator decision record", () => {
		const record = createSourceApprovalRecord({
			proposal: createDynamicWorkflowProposalRecord({
				sourceSha256: deriveDynamicSourceSha256(source),
				sourceBytes: Buffer.byteLength(source, "utf8"),
				manifest,
				importPolicySha256,
				proposer: { kind: "api", via: "embedder" },
				proposedAt: "2026-09-15T09:00:00.000Z",
				projectRoot: cwd,
			}),
			decision: "rejected",
			approver: { ...approver, sessionId: "session-1" },
			approvedAt: "2026-09-15T10:00:00.000Z",
			projectRoot: cwd,
			reason: "Too broad.",
		});
		expect(Value.Check(WorkflowDecisionRecordSchema, record)).toBe(true);
		expect(Value.Check(DynamicSourceApprovalSchema, record.value)).toBe(true);
		expect(isDynamicSourceApprovalRecord(record)).toBe(true);
		expect(record.source).toBe("operator");
		expect(record.decidedBy).toBe("human:/workflow approve");
		expect(record.reason).toBe("Too broad.");
		expect(record.decidedAt).toBe(record.value.approvedAt);
		expect(record.valueSchemaSha256).toBe(
			DYNAMIC_SOURCE_APPROVAL_SCHEMA_SHA256,
		);
		expect(record.valueSha256).toBe(deriveJsonValueSha256(record.value));
		expect(record.value).toMatchObject({
			schema: "pi-workflow-source-approval",
			decision: "rejected",
			approver: {
				kind: "human",
				via: "/workflow approve",
				sessionId: "session-1",
			},
			projectRoot: cwd,
			reason: "Too broad.",
			hostApiSha256,
			importPolicySha256,
		});
		expect(deriveDecisionRecordSha256(record)).toBe(
			deriveJsonValueSha256(record),
		);
	});
});

describe("decideDynamicSource", () => {
	it("records an approval once and exposes it on the view", async () => {
		const context = await fixture();
		expect(await readSourceApproval(context.proposal)).toBeUndefined();
		const { proposal, approval } = await decide(context, {
			approver: { ...approver, sessionId: "session-9" },
		});
		expect(proposal).toEqual(context.proposal);
		expect(approval.binding).toEqual(sourceApprovalBinding(context.record));
		expect(approval.value.decision).toBe("approved");
		expect(approval.value.approver).toEqual({
			...approver,
			sessionId: "session-9",
		});
		expect(approval.value.projectRoot).toBe(cwd);
		expect(approval.value.manifestSha256).toBe(context.record.manifestSha256);
		expect(approval.value.definitionIdentitySha256).toBe(
			context.record.definitionIdentitySha256,
		);
		expect(approval.decidedBy).toBe("human:/workflow approve");
		expect(approval.reason).toBeUndefined();
		const target = path.join(
			context.proposal.decisionsDirectory,
			`${deriveDecisionBindingSha256(approval.binding)}.json`,
		);
		expect((await stat(context.proposal.decisionsDirectory)).mode & 0o777).toBe(
			0o700,
		);
		expect((await stat(target)).mode & 0o777).toBe(0o600);
		expect(await readFile(target)).toEqual(
			canonicalDynamicDocument(approval).subarray(
				0,
				canonicalDynamicDocument(approval).byteLength - 1,
			),
		);
		expect(await readSourceApproval(context.proposal)).toEqual(approval);
		const view = toDynamicWorkflowProposalView({
			proposal: context.proposal,
			approval,
			hostApiSha256,
			importPolicySha256,
		});
		expect(view.ref).toBe(`dynamic:${context.sha}`);
		expect(view.runnable).toBe(true);
		expect(view.path).toBe(context.proposal.path);
		expect(view.decision).toEqual({
			decision: "approved",
			approver: { ...approver, sessionId: "session-9" },
			approvedAt: approval.value.approvedAt,
			approvalSha256: deriveDecisionRecordSha256(approval),
		});
		expect(view).not.toHaveProperty("source");
		expect(
			toDynamicWorkflowProposalView({
				proposal: context.proposal,
				approval,
				hostApiSha256: "0".repeat(64),
				importPolicySha256,
			}).runnable,
		).toBe(false);
		expect(
			toDynamicWorkflowProposalView({
				proposal: context.proposal,
				approval,
				hostApiSha256,
				importPolicySha256: "0".repeat(64),
			}).runnable,
		).toBe(false);
		const pending = toDynamicWorkflowProposalView({
			proposal: context.proposal,
			approval: undefined,
			hostApiSha256,
			importPolicySha256,
		});
		expect(pending.runnable).toBe(false);
		expect(pending).not.toHaveProperty("decision");
	});

	it("is immutable: no second decision for the same identity", async () => {
		const context = await fixture();
		await decide(context);
		let error = await rejection(decide(context));
		expect(error.code).toBe("conflict");
		expect(error.message).toBe("Dynamic workflow source is already approved.");
		error = await rejection(decide(context, { decision: "rejected" }));
		expect(error.message).toBe("Dynamic workflow source is already approved.");
	});

	it("keeps a rejection final and unrunnable", async () => {
		const context = await fixture();
		const { approval } = await decide(context, {
			decision: "rejected",
			reason: "Not now.",
		});
		expect(approval.value.decision).toBe("rejected");
		expect(approval.value.reason).toBe("Not now.");
		expect(approval.reason).toBe("Not now.");
		const error = await rejection(decide(context));
		expect(error.code).toBe("conflict");
		expect(error.message).toBe("Dynamic workflow source was rejected.");
		const view = toDynamicWorkflowProposalView({
			proposal: context.proposal,
			approval,
			hostApiSha256,
			importPolicySha256,
		});
		expect(view.runnable).toBe(false);
		expect(view.decision?.decision).toBe("rejected");
		expect(view.decision?.reason).toBe("Not now.");
		expect(() =>
			assertDynamicSourceRunnable({
				proposal: context.record,
				approval,
				cwd,
				hostApiSha256,
				importPolicySha256,
			}),
		).toThrow("Dynamic workflow source was rejected.");
	});

	it("validates the decision options", async () => {
		const context = await fixture();
		let error = await rejection(
			decide(context, { approver: { kind: "model", via: "tool" } as never }),
		);
		expect(error.code).toBe("validation");
		expect(error.message).toBe("Invalid dynamic workflow approver.");
		error = await rejection(
			decide(context, { approver: { ...approver, extra: 1 } as never }),
		);
		expect(error.message).toBe("Invalid dynamic workflow approver.");
		error = await rejection(decide(context, { decision: "maybe" as never }));
		expect(error.message).toBe("Invalid dynamic workflow decision.");
		error = await rejection(decide(context, { reason: "" }));
		expect(error.message).toBe("Invalid dynamic workflow decision reason.");
		error = await rejection(decide(context, { reason: "x".repeat(4097) }));
		expect(error.message).toBe("Invalid dynamic workflow decision reason.");
		expect(await readSourceApproval(context.proposal)).toBeUndefined();
	});

	it("requires a current proposal of this project", async () => {
		const context = await fixture();
		let error = await rejection(
			decide(context, { sourceSha256: "f".repeat(64) }),
		);
		expect(error.code).toBe("not-found");
		expect(error.message).toBe(
			`Dynamic workflow proposal not found: dynamic:${"f".repeat(64)}`,
		);
		error = await rejection(decide(context, { hostApiSha256: "0".repeat(64) }));
		expect(error.code).toBe("validation");
		expect(error.message).toBe(
			"Dynamic workflow proposal predates the current host API; propose the source again.",
		);
		error = await rejection(
			decide(context, { importPolicySha256: "0".repeat(64) }),
		);
		expect(error.message).toBe(
			"Dynamic workflow import policy changed since the proposal; propose the source again.",
		);
		error = await rejection(decide(context, { cwd: "/projects/other" }));
		expect(error.message).toBe(
			"Dynamic workflow proposal belongs to another project.",
		);
		expect(await readSourceApproval(context.proposal)).toBeUndefined();
	});

	it("rejects a tampered approval record as invalid", async () => {
		const context = await fixture();
		const { approval } = await decide(context);
		const target = path.join(
			context.proposal.decisionsDirectory,
			`${deriveDecisionBindingSha256(approval.binding)}.json`,
		);
		const original = await readFile(target);
		const flipped = {
			...approval,
			value: { ...approval.value, decision: "rejected" },
		};
		await writeFile(
			target,
			canonicalDynamicDocument(flipped).subarray(
				0,
				canonicalDynamicDocument(flipped).byteLength - 1,
			),
		);
		let error = await rejection(readSourceApproval(context.proposal));
		expect(error.code).toBe("persistence");
		expect(error.message).toBe("Dynamic workflow approval record is invalid.");
		const forged = {
			...flipped,
			valueSha256: deriveJsonValueSha256(flipped.value),
			decidedBy: "model:workflow_propose",
		};
		await writeFile(
			target,
			canonicalDynamicDocument(forged).subarray(
				0,
				canonicalDynamicDocument(forged).byteLength - 1,
			),
		);
		error = await rejection(readSourceApproval(context.proposal));
		expect(error.message).toBe("Dynamic workflow approval record is invalid.");
		const byte = Buffer.from(original);
		const index = byte.indexOf(Buffer.from('"approvedAt":"2026'), 0) + 20;
		byte[index] = (byte[index] ?? 0) ^ 0x01;
		await writeFile(target, byte);
		error = await rejection(readSourceApproval(context.proposal));
		expect(error.message).toBe("Dynamic workflow approval record is invalid.");
		await writeFile(target, original);
		expect(await readSourceApproval(context.proposal)).toEqual(approval);
	});
});

describe("assertDynamicSourceRunnable", () => {
	it("refuses in verification order with exact messages", async () => {
		const context = await fixture();
		const { approval } = await decide(context);
		const verify = (
			overrides: Partial<Parameters<typeof assertDynamicSourceRunnable>[0]>,
		) =>
			assertDynamicSourceRunnable({
				proposal: context.record,
				approval,
				cwd,
				hostApiSha256,
				importPolicySha256,
				...overrides,
			});
		expect(verify({})).toBe(approval);
		expect(() => verify({ cwd: "/projects/other" })).toThrow(
			"Dynamic workflow proposal belongs to another project.",
		);
		expect(() => verify({ hostApiSha256: "0".repeat(64) })).toThrow(
			"Dynamic workflow proposal predates the current host API; propose the source again.",
		);
		expect(() => verify({ importPolicySha256: "0".repeat(64) })).toThrow(
			"Dynamic workflow import policy changed since approval.",
		);
		expect(() => verify({ approval: undefined })).toThrow(
			"Dynamic workflow source is not approved for the current host API.",
		);
		const foreign = {
			...approval,
			value: { ...approval.value, projectRoot: "/projects/other" },
		} as typeof approval;
		expect(() => verify({ approval: foreign })).toThrow(
			"Dynamic workflow approval belongs to another project.",
		);
		for (const field of [
			"manifestSha256",
			"importPolicySha256",
			"hostApiSha256",
		] as const) {
			const mismatched = {
				...approval,
				value: { ...approval.value, [field]: "0".repeat(64) },
			} as typeof approval;
			expect(() => verify({ approval: mismatched })).toThrow(
				"Dynamic workflow approval does not match the proposal.",
			);
		}
		const error = await Promise.resolve()
			.then(() => verify({ approval: undefined }))
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(DynamicWorkflowApprovalError);
		expect((error as DynamicWorkflowApprovalError).code).toBe("validation");
	});
});

describe("run definition copy", () => {
	async function copied() {
		const context = await fixture();
		const { approval } = await decide(context);
		const runDirectory = path.join(context.storeRoot, "runs", "workflow_run1");
		await mkdir(runDirectory, { recursive: true });
		const directory = await writeRunDefinitionCopy(runDirectory, {
			source,
			manifest,
			proposal: context.record,
			approval,
		});
		const runRecord = {
			cwd,
			definitionIdentitySha256: context.record.definitionIdentitySha256,
			definitionSourceSha256: context.sha,
			approvalSha256: deriveDecisionRecordSha256(approval),
			hostApiSha256,
		};
		const current = { cwd, hostApiSha256, importPolicySha256 };
		const verify = async (
			recordOverrides: Partial<typeof runRecord> = {},
			currentOverrides: Partial<typeof current> = {},
		) =>
			verifyRunDefinitionCopy({
				copy: await readRunDefinitionCopy({ directory: runDirectory }),
				record: { ...runRecord, ...recordOverrides },
				current: { ...current, ...currentOverrides },
			});
		return {
			...context,
			approval,
			runDirectory,
			directory,
			runRecord,
			verify,
		};
	}

	it("writes the four files exclusively and reads them back verified", async () => {
		const {
			approval,
			record: proposal,
			runDirectory,
			directory,
			verify,
		} = await copied();
		expect(directory).toBe(path.join(runDirectory, "definition"));
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		const expected: readonly [string, Buffer][] = [
			["source.workflow.ts", Buffer.from(source, "utf8")],
			["manifest.json", canonicalDynamicDocument(manifest)],
			["proposal.json", canonicalDynamicDocument(proposal)],
			["approval.json", canonicalDynamicDocument(approval)],
		];
		for (const [file, content] of expected) {
			const target = path.join(directory, file);
			expect(await readFile(target)).toEqual(content);
			expect((await stat(target)).mode & 0o777).toBe(0o600);
		}
		const verified = await verify();
		expect(verified.source).toBe(source);
		expect(verified.manifest).toEqual(manifest);
		// The definition is built from the verified manifest.json, not from the
		// proposal record's embedded copy.
		expect(verified.manifest).not.toBe(verified.proposal.manifest);
		expect(verified.proposal).toEqual(proposal);
		expect(verified.approval).toEqual(approval);
		await expect(
			writeRunDefinitionCopy(runDirectory, {
				source,
				manifest,
				proposal,
				approval,
			}),
		).rejects.toThrow("Workflow run definition copy already exists.");
	});

	it("refuses every tampered or stale copy with the exact reason", async () => {
		const { approval, directory, verify, record: proposal } = await copied();
		const rewrite = (file: string, content: Buffer | string) =>
			writeFile(path.join(directory, file), content);
		const sourcePath = "source.workflow.ts";
		await rewrite(sourcePath, `${source}\n`);
		await expect(verify()).rejects.toThrow(
			"Dynamic workflow source changed since the run was created.",
		);
		await rewrite(sourcePath, source);
		const approvalDocument = (value: unknown) =>
			canonicalDynamicDocument(value);
		await rewrite(
			"approval.json",
			approvalDocument({
				...approval,
				value: { ...approval.value, decision: "rejected" },
			}),
		);
		await expect(verify()).rejects.toThrow(
			"Dynamic workflow approval record changed since the run was created.",
		);
		const flipped = {
			...approval,
			value: { ...approval.value, decision: "rejected" },
		};
		await rewrite(
			"approval.json",
			approvalDocument({
				...flipped,
				valueSha256: deriveJsonValueSha256(flipped.value),
			}),
		);
		await expect(verify()).rejects.toThrow(
			"Dynamic workflow approval record changed since the run was created.",
		);
		await rewrite("approval.json", approvalDocument(approval));
		await expect(verify({ approvalSha256: "0".repeat(64) })).rejects.toThrow(
			"Dynamic workflow approval record changed since the run was created.",
		);
		await expect(verify({}, { hostApiSha256: "0".repeat(64) })).rejects.toThrow(
			"Dynamic workflow host API changed since the run was created.",
		);
		await expect(
			verify({}, { importPolicySha256: "0".repeat(64) }),
		).rejects.toThrow("Dynamic workflow import policy changed since approval.");
		await rewrite(
			"manifest.json",
			canonicalDynamicDocument({
				...manifest,
				meta: { ...manifest.meta, version: 2 },
			}),
		);
		await expect(verify()).rejects.toThrow(
			"Dynamic workflow manifest changed since approval.",
		);
		await rewrite("manifest.json", canonicalDynamicDocument(manifest));
		// proposal.json is verified field by field: an edited embedded manifest
		// or digest is refused by the message naming what drifted, and never
		// reaches the definition.
		const tamperedManifest = {
			...manifest,
			meta: {
				...manifest.meta,
				budget: { cost: 500, childRuntimeMs: 36_000_000 },
			},
		};
		const proposalTampers: readonly [
			Partial<typeof proposal> & Record<string, unknown>,
			string,
		][] = [
			[
				{ manifest: tamperedManifest },
				"Dynamic workflow manifest changed since approval.",
			],
			[
				{
					manifest: tamperedManifest,
					manifestSha256: deriveJsonValueSha256(tamperedManifest),
				},
				"Dynamic workflow manifest changed since approval.",
			],
			[
				{ manifestSha256: "0".repeat(64) },
				"Dynamic workflow manifest changed since approval.",
			],
			[
				{ definitionIdentitySha256: "0".repeat(64) },
				"Dynamic workflow manifest changed since approval.",
			],
			[
				{ sourceSha256: "0".repeat(64) },
				"Dynamic workflow source changed since the run was created.",
			],
			[
				{ hostApiSha256: "0".repeat(64) },
				"Dynamic workflow host API changed since the run was created.",
			],
			[
				{ importPolicySha256: "0".repeat(64) },
				"Dynamic workflow import policy changed since approval.",
			],
		];
		for (const [overrides, message] of proposalTampers) {
			await rewrite(
				"proposal.json",
				canonicalDynamicDocument({ ...proposal, ...overrides }),
			);
			await expect(verify()).rejects.toThrow(message);
		}
		await rewrite("proposal.json", canonicalDynamicDocument(proposal));
		expect((await verify()).proposal).toEqual(proposal);
		await expect(verify({}, { cwd: "/projects/other" })).rejects.toThrow(
			"Workflow definition, source, or project identity changed.",
		);
		const error = await verify({
			definitionIdentitySha256: "0".repeat(64),
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).toBe("DynamicRunDefinitionError");
		expect((error as { code: string }).code).toBe("validation");
		expect((error as Error).message).toBe(
			"Dynamic workflow approval record changed since the run was created.",
		);
	});

	it("treats a missing or non-canonical copy as corrupt", async () => {
		const { directory, verify, storeRoot } = await copied();
		await writeFile(
			path.join(directory, "proposal.json"),
			JSON.stringify({ schema: "pi-workflow-dynamic-proposal" }, null, 2),
		);
		let error = await verify().catch((caught: unknown) => caught);
		expect((error as { code: string }).code).toBe("persistence");
		expect((error as Error).message).toBe(
			"Workflow run definition copy is missing or corrupt.",
		);
		await writeFile(
			path.join(directory, "proposal.json"),
			canonicalDynamicDocument({ schema: "pi-workflow-dynamic-proposal" }),
		);
		error = await verify().catch((caught: unknown) => caught);
		expect((error as Error).message).toBe(
			"Workflow run definition copy is missing or corrupt.",
		);
		error = await readRunDefinitionCopy({
			directory: path.join(storeRoot, "runs", "workflow_missing"),
		}).catch((caught: unknown) => caught);
		expect((error as Error).message).toBe(
			"Workflow run definition copy is missing or corrupt.",
		);
	});

	it("binds the copy to the recorded identity, not to the stores", async () => {
		const { approval, verify, runRecord } = await copied();
		const other = deriveDynamicDefinitionIdentitySha256({
			sourceSha256: runRecord.definitionSourceSha256,
			manifestSha256: "9".repeat(64),
			hostApiSha256,
		});
		expect(other).not.toBe(runRecord.definitionIdentitySha256);
		expect(approval.binding.definitionIdentitySha256).toBe(
			runRecord.definitionIdentitySha256,
		);
		const verified: WorkflowDecisionRecord = (await verify()).approval;
		expect(verified.binding).toEqual(approval.binding);
	});
});
