import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { SubagentClient } from "@vegardx/pi-subagent";
import { Type } from "typebox";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { WorkflowArtifactStore } from "../src/artifact-store.js";
import { CHECKPOINT_RUN_ENDING_REASON } from "../src/checkpoint-executor.js";
import { WorkflowDecisionRecordStore } from "../src/decision-store.js";
import type {
	DynamicSupportHelperSpec,
	DynamicWorkflowManifest,
} from "../src/dynamic/contracts.js";
import { createDynamicWorkflowDefinition } from "../src/dynamic/definition.js";
import { DynamicWorkflowExecutionError } from "../src/dynamic/execution-error.js";
import { MSG_VM_INVALID_MESSAGE } from "../src/dynamic/rpc.js";
import {
	type DynamicVmBridgeOverrides,
	extractDynamicWorkflowManifest,
	MSG_EXECUTION_ABORTED,
	MSG_VM_OUT_OF_MEMORY,
} from "../src/dynamic/vm-host.js";
import type { WorkflowStateProjection } from "../src/events.js";
import { deriveTaskExecutionId } from "../src/execution.js";
import {
	type WorkflowJournalAppendNotice,
	type WorkflowJournalEvent,
	WorkflowRunJournal,
} from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
	type WorkflowRunLease,
} from "../src/persistence/run-lease.js";
import { invalidationClosure, reduceWorkflowEvents } from "../src/reducer.js";
import {
	createWorkflowSequentialScheduler,
	type WorkflowSequentialScheduler,
} from "../src/scheduler.js";
import {
	createStaticWorkflowRuntime,
	isStaticWorkflowParked,
	type StaticWorkflowDriveResult,
	StaticWorkflowRuntimeError,
} from "../src/static-runtime.js";
import type { WorkflowSubagentBinding } from "../src/subagent-provider.js";
import {
	defineSupportTask,
	type SupportTaskExecutionContext,
	type SupportTaskRegistration,
} from "../src/support.js";

/*
 * Spec 11.2 and 11.4 through the real static runtime and the real sequential
 * scheduler (journal, artifact store, decision store on disk). The VM host
 * itself (dispatcher, watchdogs, OOM, abort mirroring, rogue-worker protocol
 * matrix, determinism aids) is covered by test/dynamic-vm-host.test.ts; this
 * file covers what the journal observes: one VM per drive across a crash, a
 * park/decide cycle and an invalidation recovery, and the D9 `-> failed`
 * reasons with the checkpoint cancel ordering.
 */

const CWD = "/repo";
const CREATED_AT = "2026-09-16T00:00:00.000Z";
const IDENTITY = "d".repeat(64);
const INPUT = { topic: "alpha" };
const RUN_AWAITS_REASON = "Workflow run awaits a checkpoint decision.";
const RECOVERY_REASON = "Explicit invalidation re-executes invalidated tasks.";
const REMATERIALIZATION_REASON = "Explicit invalidation re-executes the task.";
const ROGUE_ENTRY = new URL(
	"./fixtures/dynamic-rogue-worker.ts",
	import.meta.url,
);
/**
 * Boot allowance for tests that do not assert the boot watchdog: a cold tsx
 * worker takes seconds under full-suite load (the production constants are
 * asserted in test/dynamic-vm-host.test.ts), so timeouts stay safety nets.
 */
const BOOT_ALLOWANCE: DynamicVmBridgeOverrides = { bootTimeoutMs: 60_000 };
const testRoot = path.resolve(".pi", `test-dynamic-vm-${randomUUID()}`);
const leases = new Set<WorkflowRunLease>();

/*
 * Support helper the dynamic sources import as `echo` from `@vegardx/vm-tools`.
 * Its implementation is supplied per test; the spec the VM sees is identical
 * for every registration of the same helper (spec 10).
 */
const TOOLS_MODULE = "@vegardx/vm-tools";
const echo = defineSupportTask({
	name: `${TOOLS_MODULE}/echo`,
	moduleSpecifier: TOOLS_MODULE,
	revision: 1,
	implementationSha256: "e".repeat(64),
	parametersSchema: Type.Object({ value: Type.String() }),
	outputSchema: Type.Object({ answer: Type.String() }),
});
type EchoContext = SupportTaskExecutionContext<{ value: string }>;
type EchoExecute = (context: EchoContext) => Promise<unknown> | unknown;

function registry(
	execute: EchoExecute,
): ReadonlyMap<string, SupportTaskRegistration> {
	const registration = echo.registration(
		execute as SupportTaskRegistration<
			typeof echo.parametersSchema,
			typeof echo.outputSchema
		>["execute"],
		{ exportName: "echo" },
	);
	return new Map([[registration.name, registration]]);
}
const ECHO_SPEC: DynamicSupportHelperSpec = (() => {
	const registration = echo.registration(() => ({ answer: "" }), {
		exportName: "echo",
	});
	return {
		name: registration.name,
		moduleSpecifier: registration.moduleSpecifier,
		revision: registration.revision,
		implementationSha256: registration.implementationSha256,
		parametersSchema: structuredClone(registration.parametersSchema),
		outputSchema: structuredClone(registration.outputSchema),
		exportName: "echo",
	} as unknown as DynamicSupportHelperSpec;
})();
const upper = ({ parameters }: EchoContext) => ({
	answer: parameters.value.toUpperCase(),
});

const META = `{ name: "dynamic-vm", description: "Fresh-VM recovery", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 3600000 }`;
const DECISION_SCHEMA = "Type.Object({ proceed: Type.Boolean() })";

function sourceWith(run: string): string {
	return `import { defineWorkflow } from "@vegardx/pi-workflow";
import { Type } from "typebox";
import { echo } from "${TOOLS_MODULE}";
export default defineWorkflow({
	meta: ${META},
	inputSchema: Type.Object({ topic: Type.String() }),
	outputSchema: Type.Object({}, { additionalProperties: true }),
	async run(ctx) {
${run}
	},
});
`;
}

/** Two support tasks joined by a data dependency and one barrier. */
const PAIR_SOURCE = sourceWith(`
		const a = ctx.support("a", echo({ parameters: { value: "alpha" } }));
		const b = ctx.support("b", echo({ parameters: { value: "beta" }, inputs: { prior: a.output } }));
		const [ra, rb] = await ctx.results([a, b]);
		return { ra, rb };`);

/** A support task, a checkpoint over its output, and a task chosen by the decision. */
const GATED_SOURCE = sourceWith(`
		const plan = ctx.support("plan", echo({ parameters: { value: "plan" } }));
		const gate = ctx.checkpoint("gate", { schema: ${DECISION_SCHEMA}, prompt: "Proceed?", headless: "block", inputs: { plan: plan.output } });
		const decision = await ctx.result(gate);
		const finish = ctx.support("finish", echo({ parameters: { value: decision.proceed ? "go" : "halt" } }));
		return { plan: await ctx.result(plan), finish: await ctx.result(finish) };`);

/** Swallows whatever the checkpoint barrier throws. */
const SWALLOWING_SOURCE = sourceWith(`
		const gate = ctx.checkpoint("gate", { schema: ${DECISION_SCHEMA}, prompt: "Proceed?", headless: "block" });
		let decision;
		try {
			decision = await ctx.result(gate);
		} catch (error) {
			decision = { swallowed: String(error) };
		}
		return { decision };`);

/** A blocked support task in one lane while a checkpoint opens in another. */
const ABORT_SOURCE = sourceWith(`
		const slow = ctx.support("slow", echo({ parameters: { value: "slow" } }));
		const gate = ctx.checkpoint("gate", { schema: ${DECISION_SCHEMA}, prompt: "Proceed?", headless: "block" });
		const value = await ctx.result(slow);
		return { value, decision: await ctx.result(gate) };`);

/** The manifest the rogue fixture announces on `ready` (its literal). */
const ROGUE_MANIFEST: DynamicWorkflowManifest = {
	meta: {
		name: "rogue",
		description: "Misbehaving worker",
		version: 1,
		budget: { cost: 1, childRuntimeMs: 60_000 },
		timeoutMs: 60_000,
		concurrency: 1,
	},
	inputSchema: { type: "object", additionalProperties: false },
	outputSchema: { type: "object", additionalProperties: false },
};

let MANIFEST: DynamicWorkflowManifest;

beforeAll(async () => {
	// One manifest-mode boot: every real source in this file shares META and
	// the schemas, so the approved manifest is the same for all of them.
	MANIFEST = await extractDynamicWorkflowManifest({
		source: sourceWith("return {};"),
		supportHelpers: [ECHO_SPEC],
		overrides: BOOT_ALLOWANCE,
	});
});

afterEach(async () => {
	await Promise.all([...leases].map((lease) => lease.release()));
	leases.clear();
});

afterAll(async () => {
	await rm(testRoot, { recursive: true, force: true });
});

/*
 * Harness.
 */

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	return { promise, resolve, reject };
}

/** Event-driven journal observation through `onAppended`; never polled. */
function appendGate() {
	const waiters = new Set<{
		readonly predicate: (notice: WorkflowJournalAppendNotice) => boolean;
		readonly resolve: (notice: WorkflowJournalAppendNotice) => void;
	}>();
	return {
		onAppended(notice: WorkflowJournalAppendNotice): void {
			for (const waiter of waiters) {
				if (waiter.predicate(notice)) {
					waiters.delete(waiter);
					waiter.resolve(notice);
				}
			}
		},
		/** Register before the append that should satisfy `predicate` can happen. */
		until(
			predicate: (notice: WorkflowJournalAppendNotice) => boolean,
		): Promise<WorkflowJournalAppendNotice> {
			const gate = deferred<WorkflowJournalAppendNotice>();
			waiters.add({ predicate, resolve: gate.resolve });
			return gate.promise;
		},
	};
}

const CLIENT_METHODS = [
	"preflight",
	"launch",
	"findByOperation",
	"status",
	"listRuns",
	"logs",
	"wait",
	"interrupt",
	"steer",
	"followUp",
	"retry",
	"resume",
	"reconcile",
	"release",
	"abandon",
	"pin",
	"unpin",
	"exportArtifact",
	"exportHandoff",
] as const;

/** Support and checkpoint tasks never reach pi-subagent; every call is a failure. */
function binding(runId: string): WorkflowSubagentBinding {
	const methods: Record<string, unknown> = {};
	for (const method of CLIENT_METHODS) {
		methods[method] = vi.fn(async () => {
			throw new Error(`unexpected subagent call: ${method}`);
		});
	}
	return {
		workflowRunId: runId,
		ownerId: `pi-workflow:${runId}`,
		client: methods as unknown as SubagentClient,
	};
}

interface OpenRun {
	readonly storeRoot: string;
	readonly runId: string;
	readonly lease: WorkflowRunLease;
	readonly journal: WorkflowRunJournal;
	readonly artifacts: WorkflowArtifactStore;
	readonly scheduler: WorkflowSequentialScheduler;
	readonly gate: ReturnType<typeof appendGate>;
	events(): Promise<WorkflowJournalEvent[]>;
	state(): Promise<WorkflowStateProjection>;
}

let runOrdinal = 0;
function freshRunId(): string {
	runOrdinal += 1;
	return `workflow_dynvm${String(runOrdinal).padStart(4, "0")}`;
}

/**
 * The stores and scheduler of one run, exactly as `compose` wires them: the
 * scheduler is created once per ownership, the static runtime once per drive.
 */
async function openRun(options: {
	readonly storeRoot?: string;
	readonly runId?: string;
	readonly supportTasks: ReadonlyMap<string, SupportTaskRegistration>;
	readonly concurrency?: number;
}): Promise<OpenRun> {
	const storeRoot = options.storeRoot ?? path.join(testRoot, randomUUID());
	const runId = options.runId ?? freshRunId();
	const lease = await acquireWorkflowRunLease({
		storeRoot,
		runId,
		ownerId: "dynamic-vm-test",
	});
	leases.add(lease);
	const gate = appendGate();
	const journal = await WorkflowRunJournal.open(storeRoot, runId, lease, {
		onAppended: gate.onAppended,
	});
	const artifacts = await WorkflowArtifactStore.open({ journal });
	const decisions = await WorkflowDecisionRecordStore.open({ journal });
	const scheduler = createWorkflowSequentialScheduler({
		journal,
		binding: binding(runId),
		artifacts,
		supportTasks: options.supportTasks,
		decisions,
		checkpoints: { headless: false },
		...(options.concurrency === undefined
			? {}
			: { concurrency: options.concurrency }),
	});
	return {
		storeRoot,
		runId,
		lease,
		journal,
		artifacts,
		scheduler,
		gate,
		events: () => journal.readEvents(),
		state: async () => reduceWorkflowEvents(await journal.readEvents()),
	};
}

interface DefinitionOptions {
	readonly boots: number[];
	readonly overrides?: DynamicVmBridgeOverrides;
	readonly manifest?: DynamicWorkflowManifest;
}

function definitionFor(source: string, options: DefinitionOptions) {
	return createDynamicWorkflowDefinition({
		manifest: options.manifest ?? MANIFEST,
		source,
		supportHelpers: [ECHO_SPEC],
		createdAt: CREATED_AT,
		overrides: { ...BOOT_ALLOWANCE, ...options.overrides },
		onBoot: (info) => options.boots.push(info.threadId),
	});
}

function drive(
	run: OpenRun,
	definition: ReturnType<typeof definitionFor>,
	options: { readonly signal?: AbortSignal; readonly input?: unknown } = {},
): Promise<StaticWorkflowDriveResult<unknown>> {
	return createStaticWorkflowRuntime({
		definition,
		definitionIdentitySha256: IDENTITY,
		input: options.input ?? INPUT,
		cwd: CWD,
		journal: run.journal,
		artifacts: run.artifacts,
		scheduler: run.scheduler,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	}).drive();
}

async function failure(
	promise: Promise<unknown>,
): Promise<StaticWorkflowRuntimeError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(StaticWorkflowRuntimeError);
		return error as StaticWorkflowRuntimeError;
	}
	throw new Error("expected the drive to fail");
}

function completed<T>(result: StaticWorkflowDriveResult<T>) {
	if (isStaticWorkflowParked(result)) {
		throw new Error("workflow run parked unexpectedly");
	}
	return result;
}

type StatusChange = { from: string; to: string; reason?: string };
function statusChanges(
	events: readonly WorkflowJournalEvent[],
): StatusChange[] {
	return events
		.filter((event) => event.type === "run-status-changed")
		.map((event) => event.data as StatusChange);
}
function declaredTaskIds(events: readonly WorkflowJournalEvent[]): string[] {
	return events
		.filter((event) => event.type === "task-declared")
		.map((event) => (event.data as { task: { id: string } }).task.id);
}
function taskByKey(state: WorkflowStateProjection, key: string) {
	const task = Object.values(state.tasks).find(
		(candidate) => candidate.task.spec.key === key,
	);
	if (!task) throw new Error(`missing task ${key}`);
	return task;
}
/** `[taskId, identitySha256]` pairs in materialization order. */
function identities(state: WorkflowStateProjection): [string, string][] {
	return Object.values(state.tasks)
		.sort(
			(left, right) =>
				left.task.materializationSequence - right.task.materializationSequence,
		)
		.map((task) => [task.task.id, task.task.spec.identitySha256]);
}
function distinct(values: readonly number[]): boolean {
	return new Set(values).size === values.length;
}

/*
 * 11.2 Fresh-VM recovery.
 */

describe("dynamic VM fresh-VM recovery", () => {
	it("re-drives after a crash with a fresh VM and an exact-prefix replay", async () => {
		const calls: string[] = [];
		const betaStarted = deferred();
		const processDied = deferred();
		let betaCalls = 0;
		const supportTasks = registry(async ({ parameters, inputs }) => {
			calls.push(parameters.value);
			if (parameters.value !== "beta")
				return upper({ parameters, inputs } as EchoContext);
			betaCalls += 1;
			if (betaCalls === 1) {
				// In flight when the process "dies": by the time it settles the
				// lease is gone, so its result can never reach the journal.
				betaStarted.resolve();
				await processDied.promise;
			}
			const prior = inputs.prior as { answer: string };
			return { answer: `BETA after ${prior.answer}` };
		});
		const boots: number[] = [];
		const definition = definitionFor(PAIR_SOURCE, { boots });

		// Drive 1: task a completes, task b is running when the process dies.
		const first = await openRun({ supportTasks });
		const lost = drive(first, definition);
		await betaStarted.promise;
		const crashed = await first.events();
		const crashedState = reduceWorkflowEvents(crashed);
		expect(taskByKey(crashedState, "a").status).toBe("completed");
		expect(taskByKey(crashedState, "b").status).toBe("running");
		expect(declaredTaskIds(crashed)).toHaveLength(2);
		expect(boots).toHaveLength(1);
		// The crash: the lease lapses first, so nothing drive 1 does afterwards
		// can reach the journal; its in-flight work then runs into the fenced
		// lease, the drive rejects, and the worker is torn down with it. The
		// journal on disk is all that survives.
		leases.delete(first.lease);
		await first.lease.release();
		processDied.resolve();
		await expect(lost).rejects.toBeInstanceOf(Error);

		// Drive 2: fresh ownership, scheduler, runtime, and VM over the same journal.
		const second = await openRun({
			storeRoot: first.storeRoot,
			runId: first.runId,
			supportTasks,
		});
		expect(await second.events()).toEqual(crashed);
		const result = completed(await drive(second, definition));
		expect(result.status).toBe("completed");
		expect(result.value).toEqual({
			ra: { answer: "ALPHA" },
			rb: { answer: "BETA after ALPHA" },
		});
		expect(boots).toHaveLength(2);
		expect(distinct(boots)).toBe(true);

		const events = await second.events();
		const state = reduceWorkflowEvents(events);
		// Exact-prefix replay: the crashed journal is a prefix of the finished one,
		// nothing was declared twice, and every identity is unchanged.
		expect(events.slice(0, crashed.length)).toEqual(crashed);
		expect(declaredTaskIds(events)).toEqual(declaredTaskIds(crashed));
		expect(identities(state)).toEqual(identities(crashedState));
		expect(state.status).toBe("completed");
		// a replayed from its artifact; b's interrupted generation-1 execution
		// was continued rather than re-created.
		expect(calls).toEqual(["alpha", "beta", "beta"]);
		expect(taskByKey(state, "b").currentExecutionId).toBe(
			deriveTaskExecutionId(second.runId, taskByKey(state, "b").task.id, 1),
		);
		expect(statusChanges(events).map((change) => change.to)).not.toContain(
			"failed",
		);
	});

	it("parks at a checkpoint, terminates the VM, and completes on a fresh VM after the decision", async () => {
		const supportTasks = registry(upper);
		const boots: number[] = [];
		const definition = definitionFor(GATED_SOURCE, { boots });
		const run = await openRun({ supportTasks });

		const parked = await drive(run, definition);
		expect(isStaticWorkflowParked(parked)).toBe(true);
		if (!isStaticWorkflowParked(parked)) throw new Error("unreachable");
		const parkedEvents = await run.events();
		const parkedState = reduceWorkflowEvents(parkedEvents);
		const gate = taskByKey(parkedState, "gate");
		expect(parked.pendingCheckpoints).toEqual([
			{
				taskId: gate.task.id,
				executionId: deriveTaskExecutionId(run.runId, gate.task.id, 1),
			},
		]);
		expect(taskByKey(parkedState, "plan").status).toBe("completed");
		expect(gate.status).toBe("waiting");
		expect(statusChanges(parkedEvents)).toEqual([
			{ from: "created", to: "running" },
			{ from: "running", to: "waiting", reason: RUN_AWAITS_REASON },
		]);
		expect(boots).toHaveLength(1);

		// The operator decides through the scheduler; the run stays waiting until driven.
		await run.scheduler.decide(gate.task.id, {
			value: { proceed: true },
			decidedBy: "vegard",
		});
		expect(taskByKey(await run.state(), "gate").status).toBe("completed");
		expect(boots).toHaveLength(1);

		// Drive 2: a fresh runtime boots a fresh worker and re-executes from entry.
		const result = completed(await drive(run, definition));
		expect(result.value).toEqual({
			plan: { answer: "PLAN" },
			finish: { answer: "GO" },
		});
		expect(boots).toHaveLength(2);
		expect(distinct(boots)).toBe(true);
		const events = await run.events();
		const state = reduceWorkflowEvents(events);
		expect(events.slice(0, parkedEvents.length)).toEqual(parkedEvents);
		expect(declaredTaskIds(events)).toHaveLength(3);
		expect(identities(state).slice(0, 2)).toEqual(identities(parkedState));
		// The real scheduler may idle (`-> waiting`) once `finish` completes and
		// nothing else is ready, so only the shape of the sequence is fixed.
		const statuses = statusChanges(events).map((change) => change.to);
		expect(statuses.slice(0, 3)).toEqual(["running", "waiting", "running"]);
		expect(statuses.slice(-2)).toEqual(["finalizing", "completed"]);
		expect(statuses).not.toContain("failed");
	});

	it("re-executes an invalidated completed task as generation 2 on a fresh VM", async () => {
		let alphaCalls = 0;
		let betaCalls = 0;
		const supportTasks = registry(({ parameters, inputs }) => {
			if (parameters.value === "alpha") {
				alphaCalls += 1;
				return { answer: `ALPHA#${alphaCalls}` };
			}
			betaCalls += 1;
			if (betaCalls === 1) throw new Error("beta failed once");
			const prior = inputs.prior as { answer: string };
			return { answer: `BETA after ${prior.answer}` };
		});
		const boots: number[] = [];
		const definition = definitionFor(PAIR_SOURCE, { boots });
		const run = await openRun({ supportTasks });

		// Drive 1: a completes, the required task b fails, the run fails.
		const error = await failure(drive(run, definition));
		expect(error.stage).toBe("execution");
		const failedState = await run.state();
		expect(failedState.status).toBe("failed");
		const a = taskByKey(failedState, "a");
		expect(a.status).toBe("completed");
		expect(taskByKey(failedState, "b").status).toBe("failed");
		expect(boots).toHaveLength(1);

		// Invalidate the completed task; its dependent b is in the closure.
		const closure = invalidationClosure(failedState, a.task.id);
		expect(closure.taskIds).toEqual(
			[a.task.id, taskByKey(failedState, "b").task.id].sort(),
		);
		await run.journal.append("task-invalidated", {
			causeTaskId: a.task.id,
			taskIds: [...closure.taskIds],
			abandonedEpochs: [...closure.abandonedEpochs],
			reason: "operator re-execution",
		});

		// Drive 2: recovery boots a fresh VM and re-executes generation 2.
		const result = completed(await drive(run, definition));
		expect(result.value).toEqual({
			ra: { answer: "ALPHA#2" },
			rb: { answer: "BETA after ALPHA#2" },
		});
		expect(boots).toHaveLength(2);
		expect(distinct(boots)).toBe(true);
		const events = await run.events();
		const state = reduceWorkflowEvents(events);
		expect(state.status).toBe("completed");
		expect(identities(state)).toEqual(identities(failedState));
		expect(new Set(declaredTaskIds(events)).size).toBe(2);
		for (const key of ["a", "b"]) {
			const task = taskByKey(state, key);
			const generation2 = deriveTaskExecutionId(run.runId, task.task.id, 2);
			expect(task.currentExecutionId).toBe(generation2);
			expect(state.executions[generation2]?.execution.generation).toBe(2);
		}
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "run-status-changed",
				data: { from: "failed", to: "running", reason: RECOVERY_REASON },
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "task-status-changed",
				data: {
					taskId: a.task.id,
					from: "invalidated",
					to: "pending",
					reason: REMATERIALIZATION_REASON,
				},
			}),
		);
	});
});

/*
 * 11.4 D9 failure reasons as the journal records them.
 */

describe("dynamic VM failure reasons in the journal", () => {
	interface FailureCase {
		readonly label: string;
		readonly stage: DynamicWorkflowExecutionError["stage"];
		readonly reason: string;
		readonly source: string;
		readonly overrides?: DynamicVmBridgeOverrides;
		readonly manifest?: DynamicWorkflowManifest;
		readonly input?: unknown;
	}
	const rogue = (
		scenario: string,
		stage: FailureCase["stage"],
		reason: string,
	) =>
		({
			label: `${stage} (rogue ${scenario})`,
			stage,
			reason,
			source: scenario,
			overrides: { workerEntry: ROGUE_ENTRY, computeTimeoutMs: 400 },
			manifest: ROGUE_MANIFEST,
			input: {},
		}) satisfies FailureCase;
	const cases: FailureCase[] = [
		{
			label: "memory",
			stage: "memory",
			reason: MSG_VM_OUT_OF_MEMORY,
			source: sourceWith(
				"const chunks = []; for (;;) chunks.push(new Array(262144).fill(1.5)); return chunks;",
			),
			overrides: {
				resourceLimits: {
					maxOldGenerationSizeMb: 48,
					maxYoungGenerationSizeMb: 8,
					codeRangeSizeMb: 16,
					stackSizeMb: 4,
				},
			},
		},
		{
			label: "watchdog",
			stage: "watchdog",
			reason:
				"Dynamic workflow VM exceeded 300 ms of compute between host messages.",
			source: sourceWith("for (;;) {}"),
			overrides: { computeTimeoutMs: 300 },
		},
		rogue(
			"exit",
			"exit",
			"Dynamic workflow VM exited unexpectedly with code 3.",
		),
		rogue("invalid-message", "protocol", MSG_VM_INVALID_MESSAGE),
	];

	it.each(cases)(
		"records the $label reason as the run-level failure",
		async ({ stage, reason, source, overrides, manifest, input }) => {
			const boots: number[] = [];
			const definition = definitionFor(source, {
				boots,
				...(overrides === undefined ? {} : { overrides }),
				...(manifest === undefined ? {} : { manifest }),
			});
			const run = await openRun({ supportTasks: registry(upper) });
			const error = await failure(
				drive(run, definition, input === undefined ? {} : { input }),
			);
			expect(error.stage).toBe("execution");
			expect(error.message).toBe(reason);
			expect(error.cause).toBeInstanceOf(DynamicWorkflowExecutionError);
			expect(error.cause).toMatchObject({ stage, message: reason });
			const events = await run.events();
			// No barrier ran, so the scheduler never moved the run off `created`.
			expect(statusChanges(events)).toEqual([
				{ from: "created", to: "failed", reason },
			]);
			expect(events.at(-1)?.type).toBe("run-status-changed");
			expect((await run.state()).status).toBe("failed");
			expect(boots).toHaveLength(1);
		},
	);

	it("cancels an open checkpoint before recording an abort through the runtime signal", async () => {
		const slowStarted = deferred();
		const release = deferred();
		const supportTasks = registry(async ({ parameters }) => {
			if (parameters.value === "slow") {
				slowStarted.resolve();
				await release.promise;
			}
			return { answer: parameters.value.toUpperCase() };
		});
		const boots: number[] = [];
		const definition = definitionFor(ABORT_SOURCE, { boots });
		// Two lanes: one executes the blocked support task while the other
		// requests the checkpoint, so a checkpoint is open when the VM aborts.
		const run = await openRun({ supportTasks, concurrency: 2 });
		const awaiting = run.gate.until(
			(notice) =>
				notice.event.type === "run-status-changed" &&
				(notice.event.data as StatusChange).to === "waiting",
		);
		const controller = new AbortController();
		const driving = drive(run, definition, { signal: controller.signal });
		await Promise.all([slowStarted.promise, awaiting]);
		const before = await run.state();
		const gate = taskByKey(before, "gate");
		expect(gate.status).toBe("waiting");
		expect(taskByKey(before, "slow").status).toBe("running");

		controller.abort(new Error("Operator stop."));
		const error = await failure(driving);
		expect(error.message).toBe(MSG_EXECUTION_ABORTED);
		expect(error.cause).toMatchObject({
			stage: "abort",
			message: MSG_EXECUTION_ABORTED,
		});
		const events = await run.events();
		const gateExecutionId = deriveTaskExecutionId(run.runId, gate.task.id, 1);
		const cancelled = events.findIndex(
			(event) =>
				event.type === "task-execution-terminal" &&
				(event.data as { executionId: string; outcome: string }).executionId ===
					gateExecutionId &&
				(event.data as { outcome: string }).outcome === "cancelled",
		);
		const cancelledStatus = events.findIndex(
			(event) =>
				event.type === "task-status-changed" &&
				(event.data as { taskId: string }).taskId === gate.task.id &&
				(event.data as { to: string }).to === "cancelled",
		);
		const failed = events.length - 1;
		// Order: cancel the open checkpoint, then append `-> failed` (spec 8.1).
		expect(cancelled).toBeGreaterThan(-1);
		expect(cancelledStatus).toBeGreaterThan(cancelled);
		expect(failed).toBeGreaterThan(cancelledStatus);
		expect(events[cancelled]?.data).toMatchObject({
			evidence: {
				kind: "workflow",
				stage: "stop",
				message: CHECKPOINT_RUN_ENDING_REASON,
			},
		});
		expect(events[cancelledStatus]?.data).toEqual({
			taskId: gate.task.id,
			from: "waiting",
			to: "cancelled",
			reason: CHECKPOINT_RUN_ENDING_REASON,
		});
		expect(events[failed]).toMatchObject({
			type: "run-status-changed",
			data: { from: "waiting", to: "failed", reason: MSG_EXECUTION_ABORTED },
		});
		expect(boots).toHaveLength(1);

		// The blocked lane settles after the run failed; it must not move the run.
		const slowDone = run.gate.until(
			(notice) =>
				notice.event.type === "task-status-changed" &&
				(notice.event.data as { taskId: string; to: string }).taskId ===
					taskByKey(before, "slow").task.id &&
				(notice.event.data as { to: string }).to === "completed",
		);
		release.resolve();
		await slowDone;
		const after = await run.state();
		expect(after.status).toBe("failed");
		expect(statusChanges(await run.events()).at(-1)).toEqual({
			from: "waiting",
			to: "failed",
			reason: MSG_EXECUTION_ABORTED,
		});
	});
});

/*
 * Park signal integrity: the host never forwards the park to the VM.
 */

describe("dynamic VM park signal", () => {
	it("parks even when the source swallows the barrier rejection", async () => {
		const boots: number[] = [];
		const definition = definitionFor(SWALLOWING_SOURCE, { boots });
		const run = await openRun({ supportTasks: registry(upper) });

		const parked = await drive(run, definition);
		expect(isStaticWorkflowParked(parked)).toBe(true);
		const parkedEvents = await run.events();
		const gate = taskByKey(reduceWorkflowEvents(parkedEvents), "gate");
		expect(gate.status).toBe("waiting");
		expect(statusChanges(parkedEvents)).toEqual([
			{ from: "created", to: "running" },
			{ from: "running", to: "waiting", reason: RUN_AWAITS_REASON },
		]);
		expect(boots).toHaveLength(1);

		// The catch block never ran: the decision, not the swallowed error, is
		// what the re-driven source returns.
		await run.scheduler.decide(gate.task.id, {
			value: { proceed: true },
			decidedBy: "vegard",
		});
		const result = completed(await drive(run, definition));
		expect(result.value).toEqual({ decision: { proceed: true } });
		expect(boots).toHaveLength(2);
		expect(distinct(boots)).toBe(true);
		expect(
			statusChanges(await run.events()).map((change) => change.to),
		).toEqual(["running", "waiting", "running", "finalizing", "completed"]);
	});
});
