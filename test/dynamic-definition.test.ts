import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { WorkflowArtifactStore } from "../src/artifact-store.js";
import { deriveDecisionRecordSha256 } from "../src/decision-store.js";
import {
	isWorkflowDefinition,
	type WorkflowContext,
	type WorkflowDefinition,
} from "../src/definition.js";
import { createSourceApprovalRecord } from "../src/dynamic/approval.js";
import type { DynamicWorkflowManifest } from "../src/dynamic/contracts.js";
import {
	createDynamicDiscoveredWorkflow,
	createDynamicWorkflowDefinition,
	DYNAMIC_WORKFLOW_SOURCE,
	type DynamicVmFactory,
	deriveDynamicVmSeed,
	dynamicWorkflowForRecord,
} from "../src/dynamic/definition.js";
import { DynamicWorkflowExecutionError } from "../src/dynamic/execution-error.js";
import {
	deriveDynamicDefinitionIdentitySha256,
	deriveDynamicHostApiSha256,
	deriveDynamicImportPolicySha256,
} from "../src/dynamic/identity.js";
import {
	canonicalDynamicDocument,
	createDynamicWorkflowProposalRecord,
} from "../src/dynamic/proposal-store.js";
import { writeRunDefinitionCopy } from "../src/dynamic/run-definition.js";
import { deriveDynamicSourceSha256 } from "../src/dynamic/source.js";
import {
	type DynamicVm,
	type DynamicVmOptions,
	MSG_BRIDGE_REQUIRES_STATIC_CONTEXT,
	MSG_EXECUTION_ABORTED,
	MSG_MANIFEST_CHANGED,
	MSG_VM_CRASHED,
} from "../src/dynamic/vm-host.js";
import {
	deriveJsonValueSha256,
	deriveTaskExecutionId,
} from "../src/execution.js";
import { WorkflowRunJournal } from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
	type WorkflowRunLease,
} from "../src/persistence/run-lease.js";
import { reduceWorkflowEvents } from "../src/reducer.js";
import type {
	WorkflowSchedulerOutcome,
	WorkflowSequentialScheduler,
} from "../src/scheduler.js";
import {
	createStaticWorkflowRuntime,
	isStaticWorkflowParked,
	isStaticWorkflowParkSignal,
	StaticWorkflowRuntimeError,
	type WorkflowHostBridge,
	workflowHostBridge,
} from "../src/static-runtime.js";

const CHECKPOINT_AWAITS_REASON = "Checkpoint awaits a decision.";
const RUN_AWAITS_REASON = "Workflow run awaits a checkpoint decision.";
const cwd = "/projects/demo";
const createdAt = "2026-09-15T10:00:00.000Z";
const source = `import { defineWorkflow } from "@vegardx/pi-workflow";
export default defineWorkflow({} as never);
`;
const sourceSha256 = deriveDynamicSourceSha256(source);
const manifest: DynamicWorkflowManifest = {
	meta: {
		name: "dynamic-bridge",
		description: "A dynamic workflow driven through the bridge",
		version: 3,
		budget: { cost: 5, childRuntimeMs: 1_800_000 },
		timeoutMs: 3_600_000,
		concurrency: 2,
	},
	inputSchema: {
		type: "object",
		properties: { value: { type: "string" } },
		required: ["value"],
		additionalProperties: false,
	},
	outputSchema: {
		type: "object",
		properties: { answer: { type: "string" } },
		required: ["answer"],
		additionalProperties: false,
	},
};
const input = { value: "hello" };
const testRoot = path.resolve(".pi", `test-dynamic-definition-${randomUUID()}`);
const leases = new Set<WorkflowRunLease>();

afterEach(async () => {
	await Promise.all([...leases].map((lease) => lease.release()));
	leases.clear();
});

afterAll(async () => {
	await rm(testRoot, { recursive: true, force: true });
});

type HostRun = (
	ctx: WorkflowContext<unknown>,
	options: DynamicVmOptions,
) => Promise<unknown>;

/** A fake VM host: records boots, the contexts handed to `run`, and terminations. */
function fakeHost(run: HostRun) {
	const boots: DynamicVmOptions[] = [];
	const contexts: WorkflowContext<unknown>[] = [];
	const rejections: unknown[] = [];
	const state = {
		boots,
		contexts,
		rejections,
		terminated: 0,
		terminatedBeforeRunSettled: 0,
		createVm: ((options) => {
			boots.push(options);
			let settled = false;
			const host: DynamicVm = {
				async run(ctx) {
					contexts.push(ctx);
					try {
						return await run(ctx, options);
					} catch (error) {
						rejections.push(error);
						throw error;
					} finally {
						settled = true;
					}
				},
				async terminate() {
					state.terminated += 1;
					if (!settled) state.terminatedBeforeRunSettled += 1;
				},
			};
			return host;
		}) as DynamicVmFactory,
	};
	return state;
}

function definitionWith(host: { createVm: DynamicVmFactory }) {
	return createDynamicWorkflowDefinition({
		manifest,
		source,
		supportHelpers: [],
		createdAt,
		createVm: host.createVm,
	});
}

/** A stand-alone static-like context carrying (or lacking) the host bridge. */
function bareContext(options: {
	readonly bridge?: boolean;
	readonly signal?: AbortSignal;
}): WorkflowContext<unknown> {
	const members = {
		input,
		runId: "workflow_bare",
		cwd,
		signal: options.signal ?? new AbortController().signal,
	} as unknown as WorkflowContext<unknown>;
	if (options.bridge !== false) {
		const bridge: WorkflowHostBridge = {
			agentInNamespace() {
				throw new Error("not used");
			},
		};
		Object.defineProperty(members, workflowHostBridge, {
			value: bridge,
			enumerable: false,
		});
	}
	return Object.freeze(members);
}

async function fixture(runId = "workflow_dynamic") {
	const root = path.join(testRoot, `run-${randomUUID()}`);
	const lease = await acquireWorkflowRunLease({
		storeRoot: root,
		runId,
		ownerId: "dynamic-definition-test",
	});
	leases.add(lease);
	const journal = await WorkflowRunJournal.open(root, runId, lease);
	const artifacts = await WorkflowArtifactStore.open({ journal });
	return { root, lease, journal, artifacts };
}

/**
 * A fake scheduler with no agent support: it marks the run running, and for a
 * committed checkpoint runs the request ladder and parks with
 * `awaiting-decision` (the checkpoint fake of test/static-runtime.test.ts,
 * without the decide path).
 */
function parkingScheduler(
	journal: WorkflowRunJournal,
): WorkflowSequentialScheduler {
	return {
		concurrency: 1,
		stopSignal: new AbortController().signal,
		async drive(): Promise<WorkflowSchedulerOutcome> {
			let current = reduceWorkflowEvents(await journal.readEvents());
			if (current.status === "created" || current.status === "waiting") {
				await journal.append("run-status-changed", {
					from: current.status,
					to: "running",
				});
				current = reduceWorkflowEvents(await journal.readEvents());
			}
			const task = Object.values(current.tasks)
				.filter((candidate) => candidate.committed)
				.sort(
					(left, right) =>
						left.task.materializationSequence -
						right.task.materializationSequence,
				)
				.find((candidate) => candidate.status !== "completed");
			if (!task) return { state: "idle", runStatus: current.status };
			const spec = task.task.spec;
			if (spec.kind !== "checkpoint") {
				throw new Error("parking scheduler only supports checkpoints");
			}
			const taskId = task.task.id;
			const executionId = deriveTaskExecutionId(current.runId, taskId, 1);
			if (task.status === "pending") {
				await journal.append("task-status-changed", {
					taskId,
					from: "pending",
					to: "ready",
				});
				await journal.append("task-execution-created", {
					execution: {
						kind: "checkpoint",
						id: executionId,
						runId: current.runId,
						taskId,
						generation: 1,
						taskIdentitySha256: spec.identitySha256,
					},
				});
				await journal.append("task-execution-checkpoint-requested", {
					executionId,
					inputsSha256: deriveJsonValueSha256({}),
				});
				await journal.append("task-status-changed", {
					taskId,
					from: "ready",
					to: "waiting",
					reason: CHECKPOINT_AWAITS_REASON,
				});
			}
			await journal.append("run-status-changed", {
				from: "running",
				to: "waiting",
				reason: RUN_AWAITS_REASON,
			});
			return {
				state: "awaiting-decision",
				runStatus: "waiting",
				pendingCheckpoints: [{ taskId, executionId }],
			};
		},
		async reconcile() {
			throw new Error("fake workflow has no cleanup-blocked task");
		},
		async decide() {
			throw new Error("fake scheduler records no decisions");
		},
		async stop() {
			return { state: "terminal", runStatus: "cancelled" } as const;
		},
	};
}

function runStatusChanges(
	events: readonly { readonly type: string; readonly data: unknown }[],
) {
	return events
		.filter((event) => event.type === "run-status-changed")
		.map(
			(event) => event.data as { from: string; to: string; reason?: string },
		);
}

async function driven(
	definition: WorkflowDefinition,
	options: { readonly signal?: AbortSignal; readonly park?: boolean } = {},
) {
	const { journal, artifacts } = await fixture();
	const runtime = createStaticWorkflowRuntime({
		definition,
		definitionIdentitySha256: deriveDynamicDefinitionIdentitySha256({
			sourceSha256,
			manifestSha256: deriveJsonValueSha256(manifest),
			hostApiSha256: deriveDynamicHostApiSha256(),
		}),
		input,
		cwd,
		journal,
		artifacts,
		scheduler: parkingScheduler(journal),
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
	return { journal, runtime };
}

describe("createDynamicWorkflowDefinition", () => {
	it("derives meta and schemas from the manifest", () => {
		const host = fakeHost(async () => ({ answer: "unused" }));
		const definition = definitionWith(host);
		expect(isWorkflowDefinition(definition)).toBe(true);
		expect(definition.schema).toBe("pi-workflow-definition");
		expect(definition.meta).toEqual(manifest.meta);
		expect(definition.inputSchema).toEqual(manifest.inputSchema);
		expect(definition.outputSchema).toEqual(manifest.outputSchema);
		expect(Object.isFrozen(definition)).toBe(true);
		expect(host.boots).toHaveLength(0);
	});

	it("boots one VM per run call with the run's seed and epoch and terminates it", async () => {
		const host = fakeHost(async (ctx) => ({
			answer: `${(ctx.input as { value: string }).value}:${ctx.runId}`,
		}));
		const definition = definitionWith(host);
		const first = bareContext({});
		expect(await definition.run(first)).toEqual({
			answer: "hello:workflow_bare",
		});
		expect(await definition.run(bareContext({}))).toEqual({
			answer: "hello:workflow_bare",
		});
		expect(host.boots).toHaveLength(2);
		expect(host.boots[0]).toMatchObject({
			source,
			sourceSha256,
			supportHelpers: [],
			epochMs: Date.parse(createdAt),
			seed: deriveDynamicVmSeed("workflow_bare"),
		});
		expect(host.boots[0]?.seed).toBe(
			deriveJsonValueSha256({
				kind: "dynamic-vm-seed",
				runId: "workflow_bare",
			}),
		);
		expect(host.boots[0]?.overrides).toBeUndefined();
		expect(host.boots[0]?.onBoot).toBeUndefined();
		expect(host.contexts[0]).toBe(first);
		expect(host.terminated).toBe(2);
		expect(host.terminatedBeforeRunSettled).toBe(0);
	});

	it("passes the sourceSha256, overrides, and onBoot through to the host", () => {
		const host = fakeHost(async () => undefined);
		const onBoot = () => undefined;
		const overrides = { bootTimeoutMs: 1 };
		const definition = createDynamicWorkflowDefinition({
			manifest,
			source,
			sourceSha256: "f".repeat(64),
			supportHelpers: [],
			createdAt,
			overrides,
			onBoot,
			createVm: host.createVm,
		});
		void definition.run(bareContext({}));
		expect(host.boots[0]).toMatchObject({
			sourceSha256: "f".repeat(64),
			overrides,
			onBoot,
		});
	});

	it("accepts the approved manifest on ready and fails any other with the manifest reason", async () => {
		const host = fakeHost(async (_ctx, options) => {
			options.onReady?.(structuredClone(manifest));
			options.onReady?.({
				...manifest,
				meta: { ...manifest.meta, version: manifest.meta.version + 1 },
			});
			return undefined;
		});
		const definition = definitionWith(host);
		await expect(definition.run(bareContext({}))).rejects.toMatchObject({
			name: "DynamicWorkflowExecutionError",
			stage: "manifest",
			message: MSG_MANIFEST_CHANGED,
		});
		expect(host.terminated).toBe(1);
	});

	it("refuses a context without the static-runtime bridge before booting", async () => {
		const host = fakeHost(async () => undefined);
		const definition = definitionWith(host);
		const error = await Promise.resolve()
			.then(() => definition.run(bareContext({ bridge: false })))
			.then(
				() => undefined,
				(caught: unknown) => caught,
			);
		expect(error).toBeInstanceOf(DynamicWorkflowExecutionError);
		expect(error).toMatchObject({
			name: "DynamicWorkflowExecutionError",
			stage: "protocol",
			message: MSG_BRIDGE_REQUIRES_STATIC_CONTEXT,
		});
		expect(host.boots).toHaveLength(0);
	});

	it("refuses an already aborted context before booting", async () => {
		const host = fakeHost(async () => undefined);
		const definition = definitionWith(host);
		const controller = new AbortController();
		controller.abort();
		await expect(
			definition.run(bareContext({ signal: controller.signal })),
		).rejects.toMatchObject({
			name: "DynamicWorkflowExecutionError",
			stage: "abort",
			message: MSG_EXECUTION_ABORTED,
		});
		expect(host.boots).toHaveLength(0);
		expect(host.terminated).toBe(0);
	});

	it("forwards the runtime abort signal through the context it hands the host", async () => {
		const controller = new AbortController();
		let started!: (signal: AbortSignal) => void;
		const observed = new Promise<AbortSignal>((resolve) => {
			started = resolve;
		});
		const host = fakeHost(async (ctx) => {
			started(ctx.signal);
			await new Promise<void>((resolve) =>
				ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			throw new DynamicWorkflowExecutionError("abort", MSG_EXECUTION_ABORTED);
		});
		const { journal, runtime } = await driven(definitionWith(host), {
			signal: controller.signal,
		});
		const drive = runtime.drive();
		const signal = await observed;
		expect(signal.aborted).toBe(false);
		controller.abort(new Error("Workflow stop requested."));
		await expect(drive).rejects.toMatchObject({
			stage: "execution",
			message: MSG_EXECUTION_ABORTED,
		});
		expect(signal.aborted).toBe(true);
		expect(host.terminated).toBe(1);
		expect(host.terminatedBeforeRunSettled).toBe(0);
		// No barrier ran, so the run fails straight from `created`.
		expect(runStatusChanges(await journal.readEvents()).at(-1)).toEqual({
			from: "created",
			to: "failed",
			reason: MSG_EXECUTION_ABORTED,
		});
	});

	it("terminates the host and rethrows the very same park signal so the runtime parks", async () => {
		const host = fakeHost(async (ctx) => {
			const approve = ctx.checkpoint("approve", {
				schema: Type.Object({ proceed: Type.Boolean() }),
				prompt: "Proceed with the plan?",
				headless: "block",
			});
			const decision = await ctx.result(approve);
			return { answer: String(decision.proceed) };
		});
		const inner = definitionWith(host);
		let thrown: unknown;
		const definition: WorkflowDefinition = Object.freeze({
			...inner,
			async run(ctx: WorkflowContext<unknown>) {
				try {
					return await inner.run(ctx);
				} catch (error) {
					thrown = error;
					throw error;
				}
			},
		});
		const { journal, runtime } = await driven(definition);
		const result = await runtime.drive();
		expect(isStaticWorkflowParked(result)).toBe(true);
		expect(result).toMatchObject({ parked: true, status: "waiting" });
		expect(host.rejections).toHaveLength(1);
		expect(isStaticWorkflowParkSignal(host.rejections[0])).toBe(true);
		expect(thrown).toBe(host.rejections[0]);
		expect(host.terminated).toBe(1);
		expect(host.terminatedBeforeRunSettled).toBe(0);
		const changes = runStatusChanges(await journal.readEvents());
		expect(changes.some((change) => change.to === "failed")).toBe(false);
		expect(changes.at(-1)).toEqual({
			from: "running",
			to: "waiting",
			reason: RUN_AWAITS_REASON,
		});
	});

	it("surfaces host failures as the exact -> failed reason in the real static runtime", async () => {
		const reason = "Dynamic workflow VM exceeded its memory limit.";
		const host = fakeHost(async () => {
			throw new DynamicWorkflowExecutionError("memory", reason);
		});
		const { journal, runtime } = await driven(definitionWith(host));
		const error = await runtime.drive().then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(StaticWorkflowRuntimeError);
		expect(error).toMatchObject({ stage: "execution", message: reason });
		expect((error as StaticWorkflowRuntimeError).cause).toBe(
			host.rejections[0],
		);
		expect((error as { cause: { stage: string } }).cause.stage).toBe("memory");
		expect(host.terminated).toBe(1);
		expect(runStatusChanges(await journal.readEvents()).at(-1)).toEqual({
			from: "created",
			to: "failed",
			reason,
		});
	});

	it("reports a host fault that is not a bridge error as a VM crash without its message", async () => {
		// A host fault's own message may carry a file system path (module
		// resolution, fs errors): it travels as the cause and never into the
		// journal, which sees only the fixed reason.
		const fault = new Error(
			"Cannot find module '/Users/someone/project/dist/dynamic/worker.js'",
		);
		const host = fakeHost(async () => {
			throw fault;
		});
		const { journal, runtime } = await driven(definitionWith(host));
		const error = await runtime.drive().then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(MSG_VM_CRASHED).toBe("Dynamic workflow VM crashed.");
		expect(error).toMatchObject({
			stage: "execution",
			message: MSG_VM_CRASHED,
		});
		const cause = (error as { cause: unknown }).cause;
		expect(cause).toBeInstanceOf(DynamicWorkflowExecutionError);
		expect(cause).toMatchObject({ stage: "exit", message: MSG_VM_CRASHED });
		expect((cause as { cause: unknown }).cause).toBe(host.rejections[0]);
		expect(host.terminated).toBe(1);
		const events = await journal.readEvents();
		expect(runStatusChanges(events).at(-1)).toEqual({
			from: "created",
			to: "failed",
			reason: MSG_VM_CRASHED,
		});
		expect(JSON.stringify(events)).not.toContain("/Users/someone");
	});

	it("keeps the primary outcome when terminate itself fails", async () => {
		let terminated = 0;
		const createVm: DynamicVmFactory = () => ({
			run: async () => ({ answer: "ok" }),
			async terminate() {
				terminated += 1;
				throw new Error("already gone");
			},
		});
		const definition = createDynamicWorkflowDefinition({
			manifest,
			source,
			supportHelpers: [],
			createdAt,
			createVm,
		});
		expect(await definition.run(bareContext({}))).toEqual({ answer: "ok" });
		expect(terminated).toBe(1);
	});
});

function proposalRecord() {
	return createDynamicWorkflowProposalRecord({
		sourceSha256,
		sourceBytes: Buffer.byteLength(source, "utf8"),
		manifest,
		importPolicySha256: deriveDynamicImportPolicySha256([]),
		proposer: { kind: "tool", via: "workflow_propose" },
		proposedAt: "2026-09-15T09:00:00.000Z",
		projectRoot: cwd,
	});
}

describe("createDynamicDiscoveredWorkflow", () => {
	it("builds the dynamic DiscoveredWorkflow with the proposal's path-free identity", () => {
		const proposal = proposalRecord();
		const host = fakeHost(async () => undefined);
		const definitionPath = "/store/dynamic/abc/source.workflow.ts";
		const workflow = createDynamicDiscoveredWorkflow({
			proposal,
			source,
			supportHelpers: [],
			createdAt,
			path: definitionPath,
			createVm: host.createVm,
		});
		expect(Object.isFrozen(workflow)).toBe(true);
		expect(Object.isFrozen(workflow.identity)).toBe(true);
		expect(workflow).toMatchObject({
			identity: {
				sourceSha256,
				identitySha256: deriveDynamicDefinitionIdentitySha256({
					sourceSha256,
					manifestSha256: deriveJsonValueSha256(manifest),
					hostApiSha256: deriveDynamicHostApiSha256(),
				}),
			},
			path: definitionPath,
			root: "/store/dynamic/abc",
			scope: "dynamic",
			source: DYNAMIC_WORKFLOW_SOURCE,
		});
		expect(workflow.identity.identitySha256).toBe(
			proposal.definitionIdentitySha256,
		);
		expect(workflow.source).toBe("proposal");
		expect(isWorkflowDefinition(workflow.definition)).toBe(true);
		expect(workflow.definition.meta).toEqual(manifest.meta);
		expect(workflow.definition.inputSchema).toEqual(manifest.inputSchema);
		expect(workflow.definition.outputSchema).toEqual(manifest.outputSchema);
	});

	it("builds the definition from the manifest it is handed, not the proposal's embedded copy", async () => {
		const proposal = proposalRecord();
		const verified: DynamicWorkflowManifest = {
			...manifest,
			meta: { ...manifest.meta, version: 4, concurrency: 1 },
		};
		const workflow = createDynamicDiscoveredWorkflow({
			proposal,
			manifest: verified,
			source,
			supportHelpers: [],
			createdAt,
			path: "/store/dynamic/abc/source.workflow.ts",
			createVm: fakeHost(async () => undefined).createVm,
		});
		expect(workflow.definition.meta).toEqual(verified.meta);
		expect(workflow.definition.meta).not.toEqual(proposal.manifest.meta);
		expect(workflow.identity.identitySha256).toBe(
			proposal.definitionIdentitySha256,
		);
	});

	it("runs its definition through the injected host", async () => {
		const host = fakeHost(async () => ({ answer: "via discovered" }));
		const workflow = createDynamicDiscoveredWorkflow({
			proposal: proposalRecord(),
			source,
			supportHelpers: [],
			createdAt,
			path: "/store/dynamic/abc/source.workflow.ts",
			bridge: { computeTimeoutMs: 500 },
			createVm: host.createVm,
		});
		expect(await workflow.definition.run(bareContext({}))).toEqual({
			answer: "via discovered",
		});
		expect(host.boots[0]).toMatchObject({
			sourceSha256,
			overrides: { computeTimeoutMs: 500 },
		});
		expect(host.terminated).toBe(1);
	});
});

describe("dynamicWorkflowForRecord", () => {
	async function copied() {
		const proposal = proposalRecord();
		const approval = createSourceApprovalRecord({
			proposal,
			decision: "approved",
			approver: { kind: "human", via: "/workflow approve" },
			approvedAt: "2026-09-15T09:30:00.000Z",
			projectRoot: cwd,
		});
		const runDirectory = path.join(testRoot, `record-${randomUUID()}`);
		await mkdir(runDirectory, { recursive: true });
		await writeRunDefinitionCopy(runDirectory, {
			source,
			manifest,
			proposal,
			approval,
		});
		const record = {
			cwd,
			createdAt,
			definitionPath: "/store/dynamic/abc/source.workflow.ts",
			definitionIdentitySha256: proposal.definitionIdentitySha256,
			definitionSourceSha256: sourceSha256,
			approvalSha256: deriveDecisionRecordSha256(approval),
			hostApiSha256: deriveDynamicHostApiSha256(),
		};
		return { proposal, record, journal: { directory: runDirectory } };
	}

	it("rebuilds the discovered workflow from the verified run copy", async () => {
		const { proposal, record, journal } = await copied();
		const host = fakeHost(async () => ({ answer: "resumed" }));
		const workflow = await dynamicWorkflowForRecord({
			record,
			journal,
			cwd,
			supportHelpers: [],
			createVm: host.createVm,
		});
		expect(workflow).toMatchObject({
			identity: {
				sourceSha256,
				identitySha256: proposal.definitionIdentitySha256,
			},
			path: record.definitionPath,
			root: "/store/dynamic/abc",
			scope: "dynamic",
			source: "proposal",
		});
		expect(workflow.definition.meta).toEqual(manifest.meta);
		expect(await workflow.definition.run(bareContext({}))).toEqual({
			answer: "resumed",
		});
		expect(host.boots[0]).toMatchObject({
			source,
			sourceSha256,
			epochMs: Date.parse(createdAt),
		});
	});

	it("refuses with the run-definition messages when the evidence does not match", async () => {
		const { record, journal } = await copied();
		await expect(
			dynamicWorkflowForRecord({
				record,
				journal,
				cwd: "/projects/other",
				supportHelpers: [],
			}),
		).rejects.toThrow(
			"Workflow definition, source, or project identity changed.",
		);
		await expect(
			dynamicWorkflowForRecord({
				record: { ...record, definitionSourceSha256: "0".repeat(64) },
				journal,
				cwd,
				supportHelpers: [],
			}),
		).rejects.toThrow(
			"Dynamic workflow source changed since the run was created.",
		);
		await expect(
			dynamicWorkflowForRecord({
				record,
				journal: { directory: path.join(testRoot, "missing") },
				cwd,
				supportHelpers: [],
			}),
		).rejects.toThrow("Workflow run definition copy is missing or corrupt.");
	});

	it("refuses a proposal record whose embedded manifest was edited instead of composing from it", async () => {
		const { proposal, record, journal } = await copied();
		const tampered = {
			...proposal,
			manifest: {
				...manifest,
				meta: {
					...manifest.meta,
					budget: { cost: 500, childRuntimeMs: 36_000_000 },
				},
			},
		};
		await writeFile(
			path.join(journal.directory, "definition", "proposal.json"),
			canonicalDynamicDocument(tampered),
		);
		const host = fakeHost(async () => ({ answer: "never" }));
		await expect(
			dynamicWorkflowForRecord({
				record,
				journal,
				cwd,
				supportHelpers: [],
				createVm: host.createVm,
			}),
		).rejects.toThrow("Dynamic workflow manifest changed since approval.");
		expect(host.boots).toHaveLength(0);
	});
});
