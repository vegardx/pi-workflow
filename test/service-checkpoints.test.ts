import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SubagentClient } from "@vegardx/pi-subagent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	canonicalArtifactJson,
	WorkflowArtifactStore,
} from "../src/artifact-store.js";
import { CHECKPOINT_DECIDE_INSTRUCTION } from "../src/checkpoint-render.js";
import {
	WORKFLOW_CONTRACT_REVISION,
	type WorkflowArtifactRef,
} from "../src/contracts.js";
import {
	deriveDecisionBindingSha256,
	type WorkflowDecisionBinding,
	type WorkflowDecisionRecord,
	WorkflowDecisionRecordStore,
} from "../src/decision-store.js";
import type {
	TaskExecutionProjection,
	WorkflowStateProjection,
	WorkflowTaskProjection,
} from "../src/events.js";
import {
	deriveCheckpointEffectSha256,
	deriveJsonValueSha256,
} from "../src/execution.js";
import {
	type WorkflowJournalEvent,
	WorkflowRunJournal,
} from "../src/persistence/journal.js";
import { acquireWorkflowRunLease } from "../src/persistence/run-lease.js";
import { reduceWorkflowEvents } from "../src/reducer.js";
import {
	createWorkflowService,
	type WorkflowService,
	WorkflowServiceError,
	type WorkflowServiceOptions,
} from "../src/service.js";
import type {
	WorkflowServiceRunView,
	WorkflowServiceTaskView,
} from "../src/service-views.js";
import { WorkflowPendingCheckpointViewSchema } from "../src/service-views.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";
import {
	defineSupportTask,
	type SupportTaskExecutionContext,
} from "../src/support.js";

const TOOLS_MODULE = "@vegardx/workflow-tools";
const ANSWER_SCHEMA = Type.Object({ answer: Type.String() });
const EMPTY_SCHEMA = Type.Object({});
type EmptyContext = SupportTaskExecutionContext<Static<typeof EMPTY_SCHEMA>>;
type UpperContext = SupportTaskExecutionContext<{ value: string }>;

const upper = defineSupportTask({
	name: `${TOOLS_MODULE}/upper`,
	moduleSpecifier: TOOLS_MODULE,
	revision: 1,
	implementationSha256: "a".repeat(64),
	parametersSchema: Type.Object({ value: Type.String() }),
	outputSchema: ANSWER_SCHEMA,
});
const slow = defineSupportTask({
	name: `${TOOLS_MODULE}/slow`,
	moduleSpecifier: TOOLS_MODULE,
	revision: 1,
	implementationSha256: "b".repeat(64),
	parametersSchema: EMPTY_SCHEMA,
	outputSchema: ANSWER_SCHEMA,
});
const HELPERS = { slow, upper } as const;

const upperExecute = ({ parameters }: UpperContext) => ({
	answer: parameters.value.toUpperCase(),
});

const DECISION_SCHEMA_SOURCE = `{ type: "object", properties: { proceed: { type: "boolean" }, note: { type: "string" } }, required: ["proceed"], additionalProperties: false }`;
const APPROVE = { proceed: true, note: "ship it" };
const RUN_AWAITS_REASON = "Workflow run awaits a checkpoint decision.";
const ROOT_ONLY_MESSAGE =
	"Nested workflow runs are decided through their parent run.";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

function root(name: string): string {
	return path.resolve(
		".pi",
		"test-service-checkpoints",
		`${name}-${randomUUID()}`,
	);
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
] as const;

/** Checkpoint workflows never reach pi-subagent; every call is a failure. */
function client(): SubagentClient {
	const methods: Record<string, unknown> = {};
	for (const method of CLIENT_METHODS) {
		methods[method] = vi.fn(async () => {
			throw new Error(`unexpected subagent call: ${method}`);
		});
	}
	return methods as unknown as SubagentClient;
}

function provider(): WorkflowSubagentProvider {
	return {
		bind: vi.fn(
			async (runId: string) =>
				({
					workflowRunId: runId,
					ownerId: `pi-workflow:${runId}`,
					client: client(),
				}) satisfies WorkflowSubagentBinding,
		),
	};
}

function toolsModuleSource(): string {
	const exported = Object.entries(HELPERS).map(([exportName, helper]) => {
		const identity = JSON.stringify({
			implementation: helper.implementation,
			moduleSpecifier: helper.moduleSpecifier,
			revision: helper.revision,
			implementationSha256: helper.implementationSha256,
			parametersSchema: helper.parametersSchema,
			outputSchema: helper.outputSchema,
		});
		return `export function ${exportName}(call) { return descriptor(${identity}, call); }`;
	});
	return `function descriptor(identity, call) {
  return Object.freeze({
    schema: "pi-workflow-support-task-descriptor",
    ...identity,
    parameters: call.parameters,
    ...(call.inputs ? { inputs: call.inputs } : {}),
    ...(call.disposition ? { disposition: call.disposition } : {}),
  });
}
${exported.join("\n")}
`;
}

interface CheckpointSourceOptions {
	readonly headless?: "block" | "use-explicit-default";
	readonly timeoutMs?: number;
	readonly withDefault?: boolean;
	readonly disposition?: "required" | "optional";
	readonly inputs?: string;
}

/** Source text of a `ctx.checkpoint` request; `timeoutMs: 0` omits the timeout. */
function checkpointSource(options: CheckpointSourceOptions = {}): string {
	const timeoutMs = options.timeoutMs ?? 60_000;
	return `{ schema: ${DECISION_SCHEMA_SOURCE}, prompt: "Approve the plan?", headless: ${JSON.stringify(options.headless ?? "block")}${timeoutMs === 0 ? "" : `, timeoutMs: ${timeoutMs}`}${options.withDefault ? ", default: { proceed: false }" : ""}${options.disposition ? `, disposition: ${JSON.stringify(options.disposition)}` : ""}${options.inputs ? `, inputs: ${options.inputs}` : ""} }`;
}

interface DefinitionOptions {
	readonly timeoutMs?: number;
	readonly concurrency?: number;
	readonly imports?: string;
}

function definition(
	name: string,
	body: string,
	options: DefinitionOptions = {},
): string {
	return `${options.imports ?? ""}export default {
  schema: "pi-workflow-definition",
  meta: { name: ${JSON.stringify(name)}, description: "Checkpoint workflow", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: ${options.timeoutMs ?? 600_000}, concurrency: ${options.concurrency ?? 1} },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  async run(ctx) {
    ${body}
  }
};
`;
}

/** Parks at `approve` and answers from the decision. */
function decideBody(checkpoint: string, prologue = ""): string {
	return `${prologue}const approve = ctx.checkpoint("approve", ${checkpoint});
    const decision = await ctx.result(approve);
    return { answer: decision.proceed ? "approved" : "declined" };`;
}

/** Observes an optional checkpoint through a settled barrier. */
function settledBody(checkpoint: string): string {
	return `const approve = ctx.checkpoint("approve", ${checkpoint});
    const [settled] = await ctx.settled([approve]);
    return { answer: settled.status === "fulfilled" ? "approved" : settled.failure.code };`;
}

const SUPPORT_IMPORTS = `import { slow, upper } from ${JSON.stringify(TOOLS_MODULE)};\n`;

interface Fixture {
	readonly cwd: string;
	readonly agentDir: string;
	readonly storeRoot: string;
}

async function fixture(
	name: string,
	definitions: Readonly<Record<string, string>>,
): Promise<Fixture> {
	const base = root(name);
	const cwd = path.join(base, "project");
	const agentDir = path.join(base, "agent");
	const storeRoot = path.join(cwd, ".pi", "workflow");
	const packageDir = path.join(cwd, "node_modules", ...TOOLS_MODULE.split("/"));
	await mkdir(path.join(cwd, "workflows"), { recursive: true });
	await mkdir(packageDir, { recursive: true });
	await writeFile(
		path.join(packageDir, "package.json"),
		JSON.stringify({ name: TOOLS_MODULE, type: "module", main: "index.js" }),
	);
	await writeFile(path.join(packageDir, "index.js"), toolsModuleSource());
	for (const [definitionName, source] of Object.entries(definitions)) {
		await writeFile(
			path.join(cwd, "workflows", `${definitionName}.workflow.ts`),
			source,
		);
	}
	return { cwd, agentDir, storeRoot };
}

async function serviceFor(
	fx: Fixture,
	options: Partial<WorkflowServiceOptions> = {},
): Promise<WorkflowService> {
	return createWorkflowService({
		...fx,
		projectTrusted: () => true,
		subagents: provider(),
		supportTasks: [upper.registration(upperExecute)],
		...options,
	});
}

/** Fails fast with a named label instead of hanging the whole suite. */
function bounded<T>(
	promise: Promise<T>,
	label: string,
	ms = 30_000,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`${label} did not settle within ${ms}ms`)),
			ms,
		);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

/**
 * Resolves with the first journal observation of `runId` that reaches one of
 * `statuses`; event-driven through `subscribe`, never polled.
 */
function untilStatus(
	service: WorkflowService,
	runId: string,
	statuses: readonly string[],
	label: string,
): Promise<string> {
	return bounded(
		new Promise<string>((resolve) => {
			const unsubscribe = service.subscribe((observation) => {
				if (
					observation.runId === runId &&
					statuses.includes(observation.status)
				) {
					unsubscribe();
					resolve(observation.status);
				}
			});
		}),
		label,
		20_000,
	);
}

async function journalEvents(
	storeRoot: string,
	runId: string,
): Promise<WorkflowJournalEvent[]> {
	const journal = await readFile(
		path.join(storeRoot, "runs", runId, "events.jsonl"),
		"utf8",
	);
	const complete = journal.endsWith("\n")
		? journal
		: journal.slice(0, journal.lastIndexOf("\n") + 1);
	return complete
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as WorkflowJournalEvent);
}

async function stateOf(
	storeRoot: string,
	runId: string,
): Promise<WorkflowStateProjection> {
	return reduceWorkflowEvents(await journalEvents(storeRoot, runId));
}

function runStatuses(events: readonly WorkflowJournalEvent[]): string[] {
	return events
		.filter((event) => event.type === "run-status-changed")
		.map((event) => (event.data as { to: string }).to);
}

function checkpointOf(state: WorkflowStateProjection): {
	task: WorkflowTaskProjection;
	execution: TaskExecutionProjection;
	schema: unknown;
} {
	const task = Object.values(state.tasks).find(
		(candidate) =>
			candidate.abandoned !== true && candidate.task.spec.kind === "checkpoint",
	);
	if (task?.task.spec.kind !== "checkpoint") {
		throw new Error("missing checkpoint task");
	}
	const execution = task.currentExecutionId
		? state.executions[task.currentExecutionId]
		: undefined;
	if (!execution) throw new Error("missing checkpoint execution");
	return { task, execution, schema: task.task.spec.request.schema };
}

function checkpointView(view: WorkflowServiceRunView): WorkflowServiceTaskView {
	const task = (view.tasks ?? []).find((entry) => entry.kind === "checkpoint");
	if (!task) throw new Error("missing checkpoint task view");
	return task;
}

function bindingOf(
	state: WorkflowStateProjection,
	runId: string,
): WorkflowDecisionBinding {
	const { task, execution } = checkpointOf(state);
	const request = execution.checkpointRequest;
	if (!request) throw new Error("checkpoint has no durable request");
	return {
		kind: "checkpoint",
		runId,
		taskId: task.task.id,
		executionId: execution.execution.id,
		effectSha256: deriveCheckpointEffectSha256({
			taskIdentitySha256: task.task.spec.identitySha256,
			inputsSha256: request.inputsSha256,
		}),
	};
}

async function readRecord(
	storeRoot: string,
	runId: string,
	binding: WorkflowDecisionBinding,
): Promise<WorkflowDecisionRecord> {
	return JSON.parse(
		await readFile(
			path.join(
				storeRoot,
				"runs",
				runId,
				"decisions",
				`${deriveDecisionBindingSha256(binding)}.json`,
			),
			"utf8",
		),
	) as WorkflowDecisionRecord;
}

/** The stores of a run no service owns, held on a test lease. */
async function reopenRun(storeRoot: string, runId: string) {
	const lease = await acquireWorkflowRunLease({
		storeRoot,
		runId,
		ownerId: "service-checkpoints-test",
	});
	const journal = await WorkflowRunJournal.open(storeRoot, runId, lease);
	const artifacts = await WorkflowArtifactStore.open({ journal });
	const decisions = await WorkflowDecisionRecordStore.open({ journal });
	return {
		journal,
		artifacts,
		decisions,
		state: async () => reduceWorkflowEvents(await journal.readEvents()),
		release: () => lease.release(),
	};
}

type ReopenedRun = Awaited<ReturnType<typeof reopenRun>>;

/** A decision record persisted directly: a crash before its event. */
async function writeRecord(
	run: ReopenedRun,
	runId: string,
	value: unknown,
	reason?: string,
): Promise<WorkflowDecisionRecord> {
	const state = await run.state();
	return run.decisions.put({
		schema: "pi-workflow-decision",
		contractRevision: WORKFLOW_CONTRACT_REVISION,
		binding: bindingOf(state, runId),
		source: "operator",
		decidedBy: "vegard",
		...(reason === undefined ? {} : { reason }),
		decidedAt: new Date().toISOString(),
		valueSchemaSha256: deriveJsonValueSha256(checkpointOf(state).schema),
		valueSha256: deriveJsonValueSha256(value),
		value,
	});
}

async function writeArtifact(
	run: ReopenedRun,
	runId: string,
	value: unknown,
): Promise<WorkflowArtifactRef> {
	const state = await run.state();
	const { task, execution, schema } = checkpointOf(state);
	const artifact = await run.artifacts.putJson(value, {
		runId,
		producerTaskId: task.task.id,
		producerExecutionId: execution.execution.id,
		output: "result",
		schemaSha256: deriveJsonValueSha256(schema),
	});
	await run.journal.append("artifact-declared", { artifact });
	return artifact;
}

async function writeDecided(
	run: ReopenedRun,
	artifact: WorkflowArtifactRef,
	record: WorkflowDecisionRecord,
): Promise<void> {
	const { execution } = checkpointOf(await run.state());
	await run.journal.append("task-execution-checkpoint-decided", {
		executionId: execution.execution.id,
		artifactId: artifact.id,
		decisionSha256: artifact.sha256,
		source: "operator",
		decidedAt: record.decidedAt,
		decidedBy: "vegard",
		...(record.reason === undefined ? {} : { reason: record.reason }),
	});
}

/** Starts a run and returns once its drive has parked. */
async function parked(service: WorkflowService, name: string) {
	const receipt = await service.run(name, {});
	const view = await bounded(service.wait(receipt.runId), "park");
	expect(view).toMatchObject({ status: "waiting", parked: true });
	return { runId: receipt.runId, view };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("checkpoint parking", () => {
	it("parks a required block checkpoint and exposes the pending decision", async () => {
		const fx = await fixture("park", {
			park: definition("park", decideBody(checkpointSource())),
		});
		const service = await serviceFor(fx);
		try {
			const receipt = await service.run("park", {});
			const started = Date.now();
			const view = await bounded(service.wait(receipt.runId), "wait");
			expect(view).toMatchObject({
				status: "waiting",
				parked: true,
				definitionName: "park",
			});
			expect(view.timedOut).toBeUndefined();
			expect(view.output).toBeUndefined();
			const task = checkpointView(view);
			expect(task).toMatchObject({
				kind: "checkpoint",
				key: "approve",
				role: "task",
				disposition: "required",
				status: "waiting",
				generation: 1,
				checkpoint: {
					prompt: "Approve the plan?",
					headless: "block",
					timeoutMs: 60_000,
					inputs: {},
				},
			});
			expect(task.checkpoint?.requestedAt).toEqual(expect.any(String));
			expect(task.checkpoint?.decision).toBeUndefined();
			// The expiry is computed from the clock just before the request event
			// is stamped: at most `timeoutMs` after `requestedAt` (reducer C4).
			const lead =
				Date.parse(task.checkpoint?.expiresAt ?? "") -
				Date.parse(task.checkpoint?.requestedAt ?? "");
			expect(lead).toBeLessThanOrEqual(60_000);
			expect(lead).toBeGreaterThan(59_000);
			expect(view.pendingCheckpoints).toEqual([
				{
					taskId: task.id,
					namespace: [],
					key: "approve",
					executionId: task.executionId,
					requestedAt: task.checkpoint?.requestedAt,
					expiresAt: task.checkpoint?.expiresAt,
					taskKey: "approve",
					prompt: "Approve the plan?",
					schemaSummary: "{ proceed: boolean, note?: string }",
					instruction: CHECKPOINT_DECIDE_INSTRUCTION,
				},
			]);
			// The checkpoint declares no inputs, so there is nothing to render.
			expect(view.pendingCheckpoints?.[0]).not.toHaveProperty("inputsSummary");
			for (const pending of view.pendingCheckpoints ?? []) {
				expect(Value.Check(WorkflowPendingCheckpointViewSchema, pending)).toBe(
					true,
				);
			}
			// A second wait does not block on the human: the parked view returns
			// at once, without a timeout marker.
			const again = await bounded(
				service.wait(receipt.runId, { timeoutMs: 10_000 }),
				"wait again",
				5_000,
			);
			expect(again).toMatchObject({ status: "waiting", parked: true });
			expect(again.timedOut).toBeUndefined();
			expect(Date.now() - started).toBeLessThan(5_000);
			expect(await service.status(receipt.runId)).toMatchObject({
				status: "waiting",
			});
			const events = await journalEvents(fx.storeRoot, receipt.runId);
			const types = events.map((event) => event.type);
			const requested = types.indexOf("task-execution-checkpoint-requested");
			expect(requested).toBeGreaterThan(0);
			expect(types.slice(requested)).toEqual([
				"task-execution-checkpoint-requested",
				"task-status-changed",
				"run-status-changed",
			]);
			expect(events.at(-2)?.data).toMatchObject({
				from: "ready",
				to: "waiting",
				reason: "Checkpoint awaits a decision.",
			});
			expect(events.at(-1)?.data).toEqual({
				from: "running",
				to: "waiting",
				reason: RUN_AWAITS_REASON,
			});
			const page = await service.listRuns();
			expect(page.runs).toHaveLength(1);
			expect(page.runs[0]).toMatchObject({
				runId: receipt.runId,
				status: "waiting",
				ownership: "owned",
				pendingCheckpointCount: 1,
				requiresAttention: true,
			});
			expect(page.runs[0]?.availableActions).toContain("decide");
			expect(page.runs[0]?.availableActions).not.toContain("invalidate");
			const inspection = await service.inspect(receipt.runId);
			expect(inspection.run).toMatchObject({ status: "waiting" });
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("reads verified support inputs into the checkpoint view", async () => {
		const fx = await fixture("inputs", {
			inputs: definition(
				"inputs",
				decideBody(
					checkpointSource({ inputs: "{ plan: plan.output }" }),
					`const plan = ctx.support("plan", upper({ parameters: { value: "plan" } }));\n    `,
				),
				{ imports: SUPPORT_IMPORTS, concurrency: 2 },
			),
		});
		const service = await serviceFor(fx);
		try {
			const { runId, view } = await parked(service, "inputs");
			expect(checkpointView(view).checkpoint?.inputs).toEqual({
				plan: { answer: "PLAN" },
			});
			// The artifact-backed view renders the same verified inputs the
			// approver reads, so a parked run is answerable from one call.
			const pending = view.pendingCheckpoints?.[0];
			expect(pending).toMatchObject({
				taskKey: "approve",
				prompt: "Approve the plan?",
				schemaSummary: "{ proceed: boolean, note?: string }",
				inputsSummary: ["plan:", "  {", '    "answer": "PLAN"', "  }"].join(
					"\n",
				),
				instruction: CHECKPOINT_DECIDE_INSTRUCTION,
			});
			expect(Value.Check(WorkflowPendingCheckpointViewSchema, pending)).toBe(
				true,
			);
			const support = (view.tasks ?? []).find(
				(task) => task.kind === "support",
			);
			expect(support?.status).toBe("completed");
			// The lease-free inspection never reads artifacts.
			const inspection = await service.inspect(runId, {
				include: ["tasks"],
			});
			const inspected = inspection.tasks?.find(
				(task) => task.kind === "checkpoint",
			);
			expect(inspected?.checkpoint?.inputs).toBeUndefined();
			// The lease-free inspection carries no pending checkpoint views at
			// all, so it can carry no rendered inputs either.
			expect(inspection).not.toHaveProperty("pendingCheckpoints");
			await expect(
				service.decide(runId, support?.id ?? "", {
					decision: APPROVE,
					approver: "vegard",
				}),
			).rejects.toMatchObject({
				code: "validation",
				message: "Workflow task is not a checkpoint task.",
			});
			await expect(service.wait(runId)).resolves.toMatchObject({
				status: "waiting",
				parked: true,
			});
			await service.decide(runId, checkpointView(view).id, {
				decision: APPROVE,
				approver: "vegard",
			});
			await expect(bounded(service.wait(runId), "wait")).resolves.toMatchObject(
				{ status: "completed", output: { answer: "approved" } },
			);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});
});

describe("checkpoint decisions", () => {
	it("records the decision, restarts the drive, and completes the run", async () => {
		const fx = await fixture("decide", {
			decide: definition("decide", decideBody(checkpointSource())),
		});
		const service = await serviceFor(fx);
		try {
			const observed: string[] = [];
			const receipt = await service.run("decide", {});
			service.subscribe((observation) => {
				if (observation.runId === receipt.runId) {
					observed.push(observation.status);
				}
			});
			const view = await bounded(service.wait(receipt.runId), "park");
			expect(view.status).toBe("waiting");
			const task = checkpointView(view);
			const before = (await journalEvents(fx.storeRoot, receipt.runId)).length;
			const decided = await service.decide(receipt.runId, task.id, {
				decision: APPROVE,
				approver: "vegard",
				reason: "Reviewed the plan.",
			});
			expect(["waiting", "running", "finalizing", "completed"]).toContain(
				decided.status,
			);
			const final = await bounded(service.wait(receipt.runId), "wait");
			expect(final).toMatchObject({
				status: "completed",
				output: { answer: "approved" },
			});
			expect(final.parked).toBeUndefined();
			expect(final.pendingCheckpoints).toEqual([]);
			const completed = checkpointView(final);
			expect(completed).toMatchObject({
				status: "completed",
				outcome: "completed",
				checkpoint: {
					decision: {
						source: "operator",
						decidedBy: "vegard",
						reason: "Reviewed the plan.",
						sha256: deriveJsonValueSha256(APPROVE),
						value: APPROVE,
					},
				},
			});
			expect(completed.checkpoint?.decision?.decidedAt).toEqual(
				expect.any(String),
			);

			const events = await journalEvents(fx.storeRoot, receipt.runId);
			const state = reduceWorkflowEvents(events);
			const appended = events.slice(before).map((event) => event.type);
			expect(appended.slice(0, 4)).toEqual([
				"artifact-declared",
				"task-execution-checkpoint-decided",
				"task-execution-terminal",
				"task-status-changed",
			]);
			expect(events[before + 3]?.data).toMatchObject({
				from: "waiting",
				to: "completed",
				reason: "Checkpoint decided.",
			});
			// The restarted drive resumes the run before anything else runs.
			expect(
				events
					.slice(before)
					.filter((event) => event.type === "run-status-changed")
					.map((event) => event.data),
			).toEqual([
				{ from: "waiting", to: "running" },
				{ from: "running", to: "finalizing" },
				{ from: "finalizing", to: "completed" },
			]);
			const binding = bindingOf(state, receipt.runId);
			const record = await readRecord(fx.storeRoot, receipt.runId, binding);
			expect(record).toEqual({
				schema: "pi-workflow-decision",
				contractRevision: WORKFLOW_CONTRACT_REVISION,
				binding,
				source: "operator",
				decidedBy: "vegard",
				reason: "Reviewed the plan.",
				decidedAt: expect.any(String),
				valueSchemaSha256: deriveJsonValueSha256(checkpointOf(state).schema),
				valueSha256: deriveJsonValueSha256(APPROVE),
				value: APPROVE,
			});
			expect(checkpointOf(state).execution.terminal?.evidence).toEqual({
				kind: "checkpoint",
				artifactId: expect.stringMatching(/^artifact_/),
				decisionSha256: deriveJsonValueSha256(APPROVE),
				source: "operator",
				decidedBy: "vegard",
			});
			// Every transition of the parked and decided run was observed.
			expect(observed).toContain("waiting");
			expect(observed).toContain("running");
			expect(observed.at(-1)).toBe("completed");

			await expect(
				service.decide(receipt.runId, task.id, {
					decision: APPROVE,
					approver: "vegard",
				}),
			).rejects.toMatchObject({
				code: "validation",
				message: "Workflow run status does not admit a checkpoint decision.",
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("shows the decided value on the lease-free inspection, from the decision record", async () => {
		const fx = await fixture("inspect-decision", {
			"inspect-decision": definition(
				"inspect-decision",
				decideBody(checkpointSource()),
			),
		});
		const service = await serviceFor(fx);
		let runId = "";
		try {
			const parkedRun = await parked(service, "inspect-decision");
			runId = parkedRun.runId;
			// Before the decision the inspection carries none.
			const undecided = await service.inspect(runId, { include: ["tasks"] });
			expect(
				undecided.tasks?.find((task) => task.kind === "checkpoint")?.checkpoint,
			).not.toHaveProperty("decision");

			await service.decide(runId, checkpointView(parkedRun.view).id, {
				decision: APPROVE,
				approver: "vegard",
				reason: "Reviewed the plan.",
			});
			const final = await bounded(service.wait(runId), "wait");
			expect(final.status).toBe("completed");

			const inspection = await service.inspect(runId, { include: ["tasks"] });
			const inspected = inspection.tasks?.find(
				(task) => task.kind === "checkpoint",
			);
			expect(inspected?.checkpoint?.decision).toEqual({
				source: "operator",
				decidedBy: "vegard",
				reason: "Reviewed the plan.",
				decidedAt: expect.any(String),
				sha256: deriveJsonValueSha256(APPROVE),
				value: APPROVE,
			});
			// The value came from the decision record, not from an artifact:
			// the lease-free inspection still reads no verified inputs.
			expect(inspected?.checkpoint?.inputs).toBeUndefined();
			// The artifact-backed path is unchanged and agrees.
			expect(checkpointView(final).checkpoint?.decision).toEqual(
				inspected?.checkpoint?.decision,
			);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}

		// The same run read lease-free by a service that never owned it.
		const reader = await serviceFor(fx);
		try {
			const inspection = await reader.inspect(runId, { include: ["tasks"] });
			expect(inspection.run.ownership).toBe("inactive");
			expect(
				inspection.tasks?.find((task) => task.kind === "checkpoint")?.checkpoint
					?.decision?.value,
			).toEqual(APPROVE);
		} finally {
			await bounded(reader.shutdown(), "reader shutdown");
		}

		// The journal stays authoritative: a record that disagrees with the
		// journalled decision digest is refused, never shown.
		const state = await stateOf(fx.storeRoot, runId);
		const decisionBinding = bindingOf(state, runId);
		const tampered = {
			...(await readRecord(fx.storeRoot, runId, decisionBinding)),
			value: { proceed: false },
			valueSha256: deriveJsonValueSha256({ proceed: false }),
		};
		await writeFile(
			path.join(
				fx.storeRoot,
				"runs",
				runId,
				"decisions",
				`${deriveDecisionBindingSha256(decisionBinding)}.json`,
			),
			canonicalArtifactJson(tampered),
		);
		const refusing = await serviceFor(fx);
		try {
			await expect(
				refusing.inspect(runId, { include: ["tasks"] }),
			).rejects.toMatchObject({
				code: "persistence",
				message: "Checkpoint decision could not be read and verified.",
			});
			// Sections that do not project tasks still read.
			await expect(
				refusing.inspect(runId, { include: ["run"] }),
			).resolves.toMatchObject({ run: { status: "completed" } });
		} finally {
			await bounded(refusing.shutdown(), "refusing shutdown");
		}
	});

	it("refuses invalid, misdirected, and repeated decisions with exact messages", async () => {
		const fx = await fixture("refuse", {
			refuse: definition("refuse", decideBody(checkpointSource())),
		});
		const service = await serviceFor(fx);
		try {
			const { runId, view } = await parked(service, "refuse");
			const task = checkpointView(view);
			const refusal = async (
				operation: Promise<unknown>,
				code: WorkflowServiceError["code"],
				message: string,
			) => {
				await expect(operation).rejects.toSatisfy(
					(error: unknown) =>
						error instanceof WorkflowServiceError &&
						error.code === code &&
						error.message === message,
				);
			};
			await refusal(
				service.decide("nope", task.id, { decision: APPROVE, approver: "v" }),
				"validation",
				"Invalid workflow run ID.",
			);
			await refusal(
				service.decide(runId, "nope", { decision: APPROVE, approver: "v" }),
				"validation",
				"Invalid workflow task ID.",
			);
			await refusal(
				service.decide(`workflow_${"0".repeat(32)}`, task.id, {
					decision: APPROVE,
					approver: "v",
				}),
				"not-found",
				`Workflow run not found: workflow_${"0".repeat(32)}`,
			);
			await refusal(
				service.decide(runId, task.id, {
					decision: APPROVE,
				} as never),
				"validation",
				"Invalid checkpoint approver.",
			);
			await refusal(
				service.decide(runId, task.id, {
					decision: APPROVE,
					approver: "x".repeat(257),
				}),
				"validation",
				"Invalid checkpoint approver.",
			);
			await refusal(
				service.decide(runId, task.id, {
					decision: APPROVE,
					approver: "vegard",
					reason: "",
				}),
				"validation",
				"Invalid checkpoint decision reason.",
			);
			await refusal(
				service.decide(runId, task.id, {
					approver: "vegard",
				} as never),
				"validation",
				"Invalid checkpoint decision options.",
			);
			await refusal(
				service.decide(runId, task.id, {
					decision: APPROVE,
					approver: "vegard",
					extra: true,
				} as never),
				"validation",
				"Invalid checkpoint decision options.",
			);
			await refusal(
				service.decide(runId, `task_${"0".repeat(32)}`, {
					decision: APPROVE,
					approver: "vegard",
				}),
				"validation",
				"Unknown workflow task.",
			);
			await refusal(
				service.decide(runId, task.id, {
					decision: { proceed: "yes" },
					approver: "vegard",
				}),
				"validation",
				"Checkpoint decision does not match its schema.",
			);
			await refusal(
				service.decide(runId, task.id, {
					decision: { proceed: true, note: "x".repeat(17 * 1024 * 1024) },
					approver: "vegard",
				}),
				"validation",
				"Checkpoint decision exceeds the workflow artifact bound.",
			);
			await refusal(
				service.invalidate(runId, task.id, "Try again."),
				"validation",
				"Workflow run status does not admit invalidation.",
			);
			// Nothing above touched the run: it is still parked, undecided.
			const state = await stateOf(fx.storeRoot, runId);
			expect(state.status).toBe("waiting");
			expect(checkpointOf(state).execution.phase).toBe("checkpoint-requested");
			await expect(service.wait(runId)).resolves.toMatchObject({
				status: "waiting",
				parked: true,
			});

			await service.decide(runId, task.id, {
				decision: { proceed: false },
				approver: "vegard",
			});
			await refusal(
				service.decide(runId, task.id, {
					decision: APPROVE,
					approver: "someone-else",
				}),
				"validation",
				"Checkpoint is not awaiting a decision.",
			);
			await expect(bounded(service.wait(runId), "wait")).resolves.toMatchObject(
				{ status: "completed", output: { answer: "declined" } },
			);
			const decided = await stateOf(fx.storeRoot, runId);
			expect(checkpointOf(decided).execution.checkpointDecision).toMatchObject({
				decidedBy: "vegard",
				decisionSha256: deriveJsonValueSha256({ proceed: false }),
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("surfaces a decision record that fails verification as a persistence error", async () => {
		const fx = await fixture("corrupt-record", {
			corrupt: definition("corrupt", decideBody(checkpointSource())),
		});
		const service = await serviceFor(fx);
		try {
			const { runId, view } = await parked(service, "corrupt");
			const state = await stateOf(fx.storeRoot, runId);
			// A record at the binding's address that is not canonical JSON: the
			// executor's stored-decision read refuses it before any append.
			await writeFile(
				path.join(
					fx.storeRoot,
					"runs",
					runId,
					"decisions",
					`${deriveDecisionBindingSha256(bindingOf(state, runId))}.json`,
				),
				"{ not a record",
			);
			const before = (await journalEvents(fx.storeRoot, runId)).length;
			await expect(
				service.decide(runId, checkpointView(view).id, {
					decision: APPROVE,
					approver: "vegard",
				}),
			).rejects.toSatisfy(
				(error: unknown) =>
					error instanceof WorkflowServiceError &&
					error.code === "persistence" &&
					error.message === "Checkpoint decision could not be recorded." &&
					error.cause instanceof Error &&
					error.cause.name === "WorkflowDecisionRecordError",
			);
			// The refusal appended nothing and left the run parked.
			expect((await journalEvents(fx.storeRoot, runId)).length).toBe(before);
			await expect(service.wait(runId)).resolves.toMatchObject({
				status: "waiting",
				parked: true,
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("accepts a decision against a live drive whose other lane is busy", async () => {
		const fx = await fixture("live", {
			live: definition(
				"live",
				`const gate = ctx.support("gate", slow({ parameters: {} }));
    const approve = ctx.checkpoint("approve", ${checkpointSource()});
    const [decision, gated] = await Promise.all([ctx.result(approve), ctx.result(gate)]);
    return { answer: decision.proceed ? gated.answer : "declined" };`,
				{ imports: SUPPORT_IMPORTS, concurrency: 2 },
			),
		});
		const gate = deferred<void>();
		const entered = deferred<void>();
		const slowExecute = vi.fn(async (_context: EmptyContext) => {
			entered.resolve();
			await gate.promise;
			return { answer: "gated" };
		});
		const service = await serviceFor(fx, {
			supportTasks: [
				upper.registration(upperExecute),
				slow.registration(slowExecute),
			],
		});
		try {
			const receipt = await service.run("live", {});
			await bounded(entered.promise, "support entered");
			await untilStatus(service, receipt.runId, ["waiting"], "waiting");
			const timedOut = await service.wait(receipt.runId, { timeoutMs: 50 });
			expect(timedOut).toMatchObject({ status: "waiting", timedOut: true });
			expect(timedOut.parked).toBeUndefined();
			const task = checkpointView(timedOut);
			expect(task.status).toBe("waiting");
			const decided = await service.decide(receipt.runId, task.id, {
				decision: APPROVE,
				approver: "vegard",
			});
			expect(checkpointView(decided).status).toBe("completed");
			gate.resolve();
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({
				status: "completed",
				output: { answer: "gated" },
			});
			expect(slowExecute).toHaveBeenCalledOnce();
		} finally {
			gate.resolve();
			await bounded(service.shutdown(), "shutdown");
		}
	});
});

describe("checkpoint lanes", () => {
	it("keeps idle lanes from flapping the run status around a park and a working lane", async () => {
		const fx = await fixture("lanes", {
			lanes: definition(
				"lanes",
				`const approve = ctx.checkpoint("approve", ${checkpointSource()});
    const decision = await ctx.result(approve);
    const after = ctx.support("after", upper({ parameters: { value: decision.proceed ? "approved" : "declined" } }));
    return { answer: (await ctx.result(after)).answer };`,
				{ imports: SUPPORT_IMPORTS, concurrency: 4 },
			),
		});
		const service = await serviceFor(fx);
		try {
			const { runId, view } = await parked(service, "lanes");
			// Three lanes found the fourth's park and appended nothing.
			const parkedEvents = await journalEvents(fx.storeRoot, runId);
			expect(runStatuses(parkedEvents)).toEqual(["running", "waiting"]);
			await service.decide(runId, checkpointView(view).id, {
				decision: APPROVE,
				approver: "vegard",
			});
			await expect(bounded(service.wait(runId), "wait")).resolves.toMatchObject(
				{ status: "completed", output: { answer: "APPROVED" } },
			);
			// One resume selects the support task; the first idle lane beside it
			// reports that nothing else is ready (once), the other idle lanes
			// append nothing, and the runtime resumes the run for finalization.
			const events = await journalEvents(fx.storeRoot, runId);
			expect(runStatuses(events)).toEqual([
				"running",
				"waiting",
				"running",
				"waiting",
				"running",
				"finalizing",
				"completed",
			]);
			expect(
				events
					.filter((event) => event.type === "run-status-changed")
					.map((event) => (event.data as { reason?: string }).reason)
					.filter((reason) => reason !== undefined),
			).toEqual([
				RUN_AWAITS_REASON,
				"No committed workflow task is currently ready.",
			]);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});
});

describe("checkpoint expiry", () => {
	it("fails a required block checkpoint and completes an optional one at expiry", async () => {
		const fx = await fixture("expiry", {
			required: definition("required", decideBody(checkpointSource())),
			optional: definition(
				"optional",
				settledBody(checkpointSource({ disposition: "optional" })),
			),
		});
		const service = await serviceFor(fx);
		// Only the wall clock is faked: the sweep compares `expiresAt` against
		// `Date.now()`; timers, fsync, and the drive stay real.
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const required = await parked(service, "required");
			const optional = await parked(service, "optional");
			const expiresAt = checkpointView(required.view).checkpoint?.expiresAt;
			vi.setSystemTime(Date.parse(expiresAt ?? "") + 1);

			const failed = await bounded(service.wait(required.runId), "required");
			expect(failed).toMatchObject({ status: "failed" });
			expect(failed.parked).toBeUndefined();
			expect(checkpointView(failed)).toMatchObject({
				status: "failed",
				outcome: "failed",
			});
			const requiredState = await stateOf(fx.storeRoot, required.runId);
			expect(checkpointOf(requiredState).execution.terminal).toMatchObject({
				outcome: "failed",
				evidence: {
					kind: "workflow",
					stage: "checkpoint-expired",
					message: "Checkpoint expired without a decision.",
				},
			});
			const requiredEvents = await journalEvents(fx.storeRoot, required.runId);
			// The re-drive's sweep expires the checkpoint before any lane has work,
			// so the run fails from `waiting` without a resume in between.
			expect(requiredEvents.at(-1)?.data).toMatchObject({
				from: "waiting",
				to: "failed",
				reason: "A required workflow task did not complete.",
			});
			expect(runStatuses(requiredEvents)).toEqual([
				"running",
				"waiting",
				"failed",
			]);

			// An expired optional checkpoint degrades the run instead of failing it.
			const completed = await bounded(service.wait(optional.runId), "optional");
			expect(completed).toMatchObject({
				status: "completed-degraded",
				output: { answer: "checkpoint-expired" },
			});
			expect(checkpointView(completed).status).toBe("failed");
			const optionalEvents = await journalEvents(fx.storeRoot, optional.runId);
			expect(runStatuses(optionalEvents).slice(0, 3)).toEqual([
				"running",
				"waiting",
				"running",
			]);
			expect(runStatuses(optionalEvents).at(-1)).toBe("completed-degraded");
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("continues a use-explicit-default checkpoint with its default at expiry", async () => {
		const fx = await fixture("default-expiry", {
			defaulted: definition(
				"defaulted",
				decideBody(
					checkpointSource({
						headless: "use-explicit-default",
						withDefault: true,
					}),
				),
			),
		});
		const service = await serviceFor(fx);
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const { runId, view } = await parked(service, "defaulted");
			expect(checkpointView(view).checkpoint).toMatchObject({
				headless: "use-explicit-default",
				default: { proceed: false },
			});
			vi.setSystemTime(
				Date.parse(checkpointView(view).checkpoint?.expiresAt ?? "") + 1,
			);
			const completed = await bounded(service.wait(runId), "wait");
			expect(completed).toMatchObject({
				status: "completed",
				output: { answer: "declined" },
			});
			expect(checkpointView(completed).checkpoint?.decision).toEqual({
				source: "default",
				decidedAt: expect.any(String),
				sha256: deriveJsonValueSha256({ proceed: false }),
				value: { proceed: false },
			});
			const state = await stateOf(fx.storeRoot, runId);
			const binding = bindingOf(state, runId);
			expect(await readRecord(fx.storeRoot, runId, binding)).toMatchObject({
				binding,
				source: "default",
				value: { proceed: false },
			});
			expect(
				(await readRecord(fx.storeRoot, runId, binding)).decidedBy,
			).toBeUndefined();
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("re-drives a parked run from the watchdog at its checkpoint expiry", async () => {
		const fx = await fixture("watchdog", {
			watchdog: definition(
				"watchdog",
				decideBody(checkpointSource({ timeoutMs: 1_000 })),
			),
		});
		const service = await serviceFor(fx);
		// Only the wall clock is faked, and frozen before the run starts: the
		// 1 s expiry cannot pass before the park is observed however slowly the
		// drive runs. With a real clock it did under full-suite load (run
		// 35099072360) and `wait` swept the park to `failed` instead of
		// returning it. The watchdog armed at the park keeps its real 1 s
		// timer; the clock is moved past `expiresAt` so its re-drive's sweep
		// expires the checkpoint.
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const { runId, view: park } = await parked(service, "watchdog");
			// No wait, decide, or reconcile touches the run from here on: only
			// the watchdog can re-drive it.
			vi.setSystemTime(
				Date.parse(checkpointView(park).checkpoint?.expiresAt ?? "") + 1,
			);
			const status = await untilStatus(
				service,
				runId,
				["failed", "completed", "cancelled"],
				"watchdog expiry",
			);
			expect(status).toBe("failed");
			const view = await service.status(runId);
			expect(view.status).toBe("failed");
			expect(
				checkpointOf(await stateOf(fx.storeRoot, runId)).execution.terminal,
			).toMatchObject({
				evidence: { stage: "checkpoint-expired" },
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("refuses a decision that races the watchdog re-drive without disturbing it", async () => {
		const fx = await fixture("race", {
			race: definition(
				"race",
				decideBody(checkpointSource({ timeoutMs: 1_000 })),
			),
		});
		const service = await serviceFor(fx);
		// Only the wall clock is faked, and frozen before the run starts, so the
		// park is observed before its 1 s expiry however slowly the drive runs
		// (with a real clock `wait` swept it to `failed` under full-suite load,
		// run 35099072360). The clock then passes `expiresAt` and the watchdog's
		// real timer is the only thing that re-drives the run.
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const { runId, view } = await parked(service, "race");
			const parkedAt = (await journalEvents(fx.storeRoot, runId)).length;
			vi.setSystemTime(
				Date.parse(checkpointView(view).checkpoint?.expiresAt ?? "") + 1,
			);
			// The watchdog's re-drive is live from its first append (the expiry
			// sweep); the decision is issued at that instant.
			const redriven = bounded(
				new Promise<void>((resolve) => {
					const unsubscribe = service.subscribe((observation) => {
						if (
							observation.runId === runId &&
							observation.sequence > parkedAt
						) {
							unsubscribe();
							resolve();
						}
					});
				}),
				"watchdog re-drive",
				20_000,
			);
			await redriven;
			await expect(
				service.decide(runId, checkpointView(view).id, {
					decision: APPROVE,
					approver: "vegard",
				}),
			).rejects.toSatisfy(
				(error: unknown) =>
					error instanceof WorkflowServiceError &&
					error.code === "validation" &&
					[
						"Checkpoint has expired.",
						"Checkpoint is already decided.",
						"Checkpoint is not awaiting a decision.",
						"Workflow run status does not admit a checkpoint decision.",
					].includes(error.message),
			);
			// The single re-drive ran to the end on its own lease: one terminal,
			// the expiry, and a failed run.
			const final = await bounded(service.wait(runId), "wait");
			expect(final.status).toBe("failed");
			const events = await journalEvents(fx.storeRoot, runId);
			expect(
				events.filter((event) => event.type === "task-execution-terminal"),
			).toHaveLength(1);
			expect(
				checkpointOf(reduceWorkflowEvents(events)).execution.terminal,
			).toMatchObject({ evidence: { stage: "checkpoint-expired" } });
			expect(runStatuses(events).at(-1)).toBe("failed");
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("completes a run decided just before expiry although the re-drive sweeps after it", async () => {
		const fx = await fixture("late-decision", {
			late: definition(
				"late",
				decideBody(checkpointSource({ timeoutMs: 1_000 })),
			),
		});
		const service = await serviceFor(fx);
		// Only the wall clock is faked, and frozen before the run starts: the
		// park is observed before its 1 s expiry however slowly the drive runs
		// (frozen only after the park, the expiry had already passed under
		// full-suite load and `wait` swept it to `failed`, run 35099072360).
		// The decision then lands 30 ms before the expiry, and the clock passes
		// it before the restarted drive sweeps.
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const { runId, view } = await parked(service, "late");
			const expiresAt = Date.parse(
				checkpointView(view).checkpoint?.expiresAt ?? "",
			);
			vi.setSystemTime(expiresAt - 30);
			const decided = await service.decide(runId, checkpointView(view).id, {
				decision: APPROVE,
				approver: "vegard",
			});
			expect(checkpointView(decided).status).toBe("completed");
			vi.setSystemTime(expiresAt + 1);
			await expect(bounded(service.wait(runId), "wait")).resolves.toMatchObject(
				{ status: "completed", output: { answer: "approved" } },
			);
			const events = await journalEvents(fx.storeRoot, runId);
			const types = events.map((event) => event.type);
			expect(
				types.filter((type) => type === "task-execution-checkpoint-requested"),
			).toHaveLength(1);
			expect(
				types.filter((type) => type === "task-execution-terminal"),
			).toHaveLength(1);
			expect(
				checkpointOf(reduceWorkflowEvents(events)).execution.terminal,
			).toMatchObject({
				outcome: "completed",
				evidence: { kind: "checkpoint", decidedBy: "vegard" },
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("commits a decision recorded before expiry when the resumed drive sweeps after it", async () => {
		const fx = await fixture("late-prefix", {
			late: definition(
				"late",
				decideBody(checkpointSource({ timeoutMs: 1_000 })),
			),
		});
		// The clock is frozen before the run starts, so the request, the record,
		// and the decided event all precede `expiresAt` however slowly they land.
		vi.useFakeTimers({ toFake: ["Date"] });
		const first = await serviceFor(fx);
		const { runId, view } = await parked(first, "late");
		await bounded(first.shutdown(), "shutdown");
		const expiresAt = Date.parse(
			checkpointView(view).checkpoint?.expiresAt ?? "",
		);
		const run = await reopenRun(fx.storeRoot, runId);
		const record = await writeRecord(run, runId, APPROVE);
		const artifact = await writeArtifact(run, runId, APPROVE);
		await writeDecided(run, artifact, record);
		await run.release();
		vi.setSystemTime(expiresAt + 1);
		const service = await serviceFor(fx);
		try {
			// The sweep meets a decided execution past its expiry: it commits the
			// decision instead of expiring it, and asks nobody again.
			await expect(bounded(service.wait(runId), "wait")).resolves.toMatchObject(
				{ status: "completed", output: { answer: "approved" } },
			);
			const events = await journalEvents(fx.storeRoot, runId);
			const types = events.map((event) => event.type);
			expect(
				types.filter((type) => type === "task-execution-checkpoint-requested"),
			).toHaveLength(1);
			expect(
				types.filter((type) => type === "task-execution-checkpoint-decided"),
			).toHaveLength(1);
			expect(
				types.filter((type) => type === "task-execution-terminal"),
			).toHaveLength(1);
			expect(
				checkpointOf(reduceWorkflowEvents(events)).execution.terminal,
			).toMatchObject({
				outcome: "completed",
				evidence: { kind: "checkpoint", decidedBy: "vegard" },
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("re-drives a parked run at the deadline and cancels the checkpoint", async () => {
		const fx = await fixture("deadline", {
			deadline: definition(
				"deadline",
				decideBody(checkpointSource({ timeoutMs: 0 })),
				{ timeoutMs: 1_000 },
			),
		});
		const service = await serviceFor(fx);
		// Only the wall clock is faked, and frozen before the run starts: the
		// drive's deadline race re-reads `Date.now()` each time its real timer
		// fires and re-arms while time remains, so the park is observed before
		// the deadline however slowly the drive runs. With a real clock the 1 s
		// deadline passed before the park under full-suite load and `wait`
		// returned `cancelled`. The watchdog armed at the park fires after the
		// deadline's real 1 s; the clock is then past the deadline, so its
		// re-drive stops the run instead of re-parking it.
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const { runId, view } = await parked(service, "deadline");
			expect(checkpointView(view).checkpoint?.expiresAt).toBeUndefined();
			// No wait, decide, or reconcile touches the run from here on: only
			// the watchdog can re-drive it.
			vi.setSystemTime(Date.parse(view.deadlineAt) + 1);
			const status = await untilStatus(
				service,
				runId,
				["failed", "completed", "cancelled"],
				"deadline",
			);
			expect(status).toBe("cancelled");
			const state = await stateOf(fx.storeRoot, runId);
			const { task, execution } = checkpointOf(state);
			expect(task.status).toBe("cancelled");
			expect(execution.terminal).toMatchObject({
				outcome: "cancelled",
				evidence: { stage: "stop", message: "Workflow deadline exceeded." },
			});
			await expect(
				service.decide(runId, task.task.id, {
					decision: APPROVE,
					approver: "vegard",
				}),
			).rejects.toMatchObject({
				message: "Workflow run status does not admit a checkpoint decision.",
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("refuses a decision once the run deadline has passed", async () => {
		const fx = await fixture("late", {
			late: definition("late", decideBody(checkpointSource({ timeoutMs: 0 })), {
				timeoutMs: 60_000,
			}),
		});
		const service = await serviceFor(fx);
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const { runId, view } = await parked(service, "late");
			vi.setSystemTime(Date.parse(view.deadlineAt) + 1);
			await expect(
				service.decide(runId, checkpointView(view).id, {
					decision: APPROVE,
					approver: "vegard",
				}),
			).rejects.toMatchObject({
				code: "validation",
				message: "Workflow run deadline has passed.",
			});
			// The next wait sweeps the park: the re-drive stops at the deadline,
			// cancelling the checkpoint before the run lands cancelled.
			const cancelled = await bounded(service.wait(runId), "wait");
			expect(cancelled).toMatchObject({ status: "cancelled" });
			expect(cancelled.parked).toBeUndefined();
			const state = await stateOf(fx.storeRoot, runId);
			const { task, execution } = checkpointOf(state);
			expect(task.status).toBe("cancelled");
			expect(execution.terminal).toMatchObject({
				outcome: "cancelled",
				evidence: { stage: "stop", message: "Workflow deadline exceeded." },
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});
});

describe("checkpoint headless mode", () => {
	it("decides use-explicit-default checkpoints immediately and still parks block ones", async () => {
		const fx = await fixture("headless", {
			defaulted: definition(
				"defaulted",
				decideBody(
					checkpointSource({
						headless: "use-explicit-default",
						withDefault: true,
					}),
				),
			),
			blocking: definition("blocking", decideBody(checkpointSource())),
		});
		const service = await serviceFor(fx, { checkpoints: { headless: true } });
		try {
			const receipt = await service.run("defaulted", {});
			const view = await bounded(service.wait(receipt.runId), "wait");
			expect(view).toMatchObject({
				status: "completed",
				output: { answer: "declined" },
			});
			expect(view.parked).toBeUndefined();
			const events = await journalEvents(fx.storeRoot, receipt.runId);
			// The run never parked at the checkpoint (an idle `waiting` while no
			// task is ready is the scheduler's ordinary quiescence, not a park).
			expect(
				events
					.filter((event) => event.type === "run-status-changed")
					.map((event) => (event.data as { reason?: string }).reason),
			).not.toContain(RUN_AWAITS_REASON);
			const taskStatuses = events
				.filter((event) => event.type === "task-status-changed")
				.map((event) => (event.data as { to: string }).to);
			expect(taskStatuses).toEqual(["ready", "completed"]);
			const types = events.map((event) => event.type);
			expect(types.indexOf("task-execution-checkpoint-decided")).toBe(
				types.indexOf("task-execution-checkpoint-requested") + 2,
			);
			expect(checkpointView(view).checkpoint?.decision).toMatchObject({
				source: "default",
				value: { proceed: false },
			});
			const blocking = await parked(service, "blocking");
			expect(checkpointView(blocking.view).status).toBe("waiting");
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("rejects invalid checkpoint options", async () => {
		const fx = await fixture("options", {
			options: definition("options", decideBody(checkpointSource())),
		});
		await expect(
			serviceFor(fx, {
				checkpoints: { headless: "yes" as unknown as boolean },
			}),
		).rejects.toMatchObject({
			code: "validation",
			message: "Workflow service checkpoint options are invalid.",
		});
	});
});

describe("stopping parked runs", () => {
	it("cancels the open checkpoint before the run lands cancelled", async () => {
		const fx = await fixture("stop", {
			stop: definition("stop", decideBody(checkpointSource())),
		});
		const service = await serviceFor(fx);
		try {
			const { runId, view } = await parked(service, "stop");
			const before = (await journalEvents(fx.storeRoot, runId)).length;
			const stopped = await bounded(
				service.stop(runId, "Operator stopped the run."),
				"stop",
			);
			expect(stopped.status).toBe("cancelled");
			expect(checkpointView(stopped)).toMatchObject({
				status: "cancelled",
				outcome: "cancelled",
			});
			const events = await journalEvents(fx.storeRoot, runId);
			const appended = events.slice(before);
			expect(appended.map((event) => event.type)).toEqual([
				"run-status-changed",
				"task-execution-terminal",
				"task-status-changed",
				"run-status-changed",
			]);
			expect(appended[0]?.data).toMatchObject({
				from: "waiting",
				to: "stopping",
			});
			expect(appended[1]?.data).toMatchObject({
				outcome: "cancelled",
				evidence: { stage: "stop", message: "Operator stopped the run." },
			});
			expect(appended[2]?.data).toMatchObject({
				taskId: checkpointView(view).id,
				from: "waiting",
				to: "cancelled",
			});
			expect(appended[3]?.data).toMatchObject({
				from: "stopping",
				to: "cancelled",
			});
			await expect(service.wait(runId)).resolves.toMatchObject({
				status: "cancelled",
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("leaves a parked run resumable across services after shutdown", async () => {
		const fx = await fixture("resumable", {
			resumable: definition("resumable", decideBody(checkpointSource())),
		});
		const first = await serviceFor(fx);
		const { runId, view } = await parked(first, "resumable");
		await bounded(first.shutdown(), "shutdown");
		const afterShutdown = await stateOf(fx.storeRoot, runId);
		expect(afterShutdown.status).toBe("waiting");

		const second = await serviceFor(fx);
		try {
			const page = await second.listRuns();
			expect(page.runs[0]).toMatchObject({
				runId,
				status: "waiting",
				ownership: "inactive",
				pendingCheckpointCount: 1,
			});
			expect(page.runs[0]?.availableActions).toContain("decide");
			const reparked = await bounded(second.wait(runId), "wait");
			expect(reparked).toMatchObject({ status: "waiting", parked: true });
			// The re-drive asked nothing new: one execution, one request.
			const types = (await journalEvents(fx.storeRoot, runId)).map(
				(event) => event.type,
			);
			expect(
				types.filter((type) => type === "task-execution-checkpoint-requested"),
			).toHaveLength(1);
			await second.decide(runId, checkpointView(view).id, {
				decision: APPROVE,
				approver: "vegard",
			});
			await expect(bounded(second.wait(runId), "wait")).resolves.toMatchObject({
				status: "completed",
				output: { answer: "approved" },
			});
		} finally {
			await bounded(second.shutdown(), "shutdown");
		}
	});

	it("re-parks a parked run through reconcile", async () => {
		const fx = await fixture("reconcile", {
			reconcile: definition("reconcile", decideBody(checkpointSource())),
		});
		const service = await serviceFor(fx);
		try {
			const { runId } = await parked(service, "reconcile");
			const reconciled = await bounded(service.reconcile(runId), "reconcile");
			expect(reconciled).toMatchObject({ status: "waiting", reconciled: [] });
			await expect(service.wait(runId)).resolves.toMatchObject({
				status: "waiting",
				parked: true,
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});
});

describe("checkpoint crash prefixes", () => {
	async function parkAndShutdown(name: string) {
		const fx = await fixture(name, {
			[name]: definition(name, decideBody(checkpointSource())),
		});
		const service = await serviceFor(fx);
		const { runId, view } = await parked(service, name);
		await bounded(service.shutdown(), "shutdown");
		return { fx, runId, taskId: checkpointView(view).id };
	}

	async function expectConverged(
		fx: Fixture,
		runId: string,
		reason: string | undefined,
		service?: WorkflowService,
	) {
		service ??= await serviceFor(fx);
		try {
			const view = await bounded(service.wait(runId), "wait");
			expect(view).toMatchObject({
				status: "completed",
				output: { answer: "approved" },
			});
			const decision = checkpointView(view).checkpoint?.decision;
			expect(decision).toMatchObject({
				source: "operator",
				decidedBy: "vegard",
				sha256: deriveJsonValueSha256(APPROVE),
				value: APPROVE,
			});
			expect(decision?.reason).toBe(reason);
			const events = await journalEvents(fx.storeRoot, runId);
			const types = events.map((event) => event.type);
			expect(
				types.filter((type) => type === "task-execution-checkpoint-requested"),
			).toHaveLength(1);
			expect(
				types.filter((type) => type === "task-execution-checkpoint-decided"),
			).toHaveLength(1);
			expect(types.filter((type) => type === "artifact-declared")).toHaveLength(
				2,
			);
			const state = reduceWorkflowEvents(events);
			const { execution } = checkpointOf(state);
			expect(execution.checkpointDecision?.decisionSha256).toBe(
				deriveJsonValueSha256(APPROVE),
			);
			const record = await readRecord(
				fx.storeRoot,
				runId,
				bindingOf(state, runId),
			);
			expect(record.valueSha256).toBe(deriveJsonValueSha256(APPROVE));
			return service;
		} catch (error) {
			await bounded(service.shutdown(), "shutdown");
			throw error;
		}
	}

	it("converges from a decision record persisted before its events", async () => {
		const { fx, runId, taskId } = await parkAndShutdown("record-only");
		const run = await reopenRun(fx.storeRoot, runId);
		await writeRecord(run, runId, APPROVE, "Recorded before the crash.");
		await run.release();
		// The human is never asked twice: a decision against the replayed
		// record is refused as already decided, and the run converges.
		const service = await serviceFor(fx);
		try {
			await expect(
				service.decide(runId, taskId, {
					decision: { proceed: false },
					approver: "someone-else",
				}),
			).rejects.toMatchObject({
				code: "validation",
				message: "Checkpoint is already decided.",
			});
		} catch (error) {
			await bounded(service.shutdown(), "shutdown");
			throw error;
		}
		const converged = await expectConverged(
			fx,
			runId,
			"Recorded before the crash.",
			service,
		);
		await bounded(converged.shutdown(), "shutdown");
	});

	it("converges from a record and a declared artifact without the decided event", async () => {
		const { fx, runId } = await parkAndShutdown("record-artifact");
		const run = await reopenRun(fx.storeRoot, runId);
		await writeRecord(run, runId, APPROVE);
		await writeArtifact(run, runId, APPROVE);
		await run.release();
		const service = await expectConverged(fx, runId, undefined);
		await bounded(service.shutdown(), "shutdown");
	});

	it("converges from a record, artifact, and decided event without the terminal", async () => {
		const { fx, runId } = await parkAndShutdown("record-decided");
		const run = await reopenRun(fx.storeRoot, runId);
		const record = await writeRecord(run, runId, APPROVE, "Almost landed.");
		const artifact = await writeArtifact(run, runId, APPROVE);
		await writeDecided(run, artifact, record);
		await run.release();
		const service = await expectConverged(fx, runId, "Almost landed.");
		await bounded(service.shutdown(), "shutdown");
	});
});

describe("checkpoint crash prefixes with a failing source", () => {
	const THROW_FLAG = "__piWorkflowTestThrowBeforeBarrier";
	const flags = globalThis as unknown as Record<string, boolean | undefined>;

	it("commits the decided checkpoint before failing closed when the source throws before its first barrier", async () => {
		const fx = await fixture("decided-throw", {
			throwing: definition(
				"throwing",
				decideBody(
					checkpointSource(),
					`if (globalThis.${THROW_FLAG}) throw new Error("boom");\n    `,
				),
			),
		});
		const first = await serviceFor(fx);
		const { runId, view } = await parked(first, "throwing");
		const taskId = checkpointView(view).id;
		await bounded(first.shutdown(), "shutdown");
		// Crash prefix: record, artifact, and decided event, no terminal.
		const run = await reopenRun(fx.storeRoot, runId);
		const record = await writeRecord(run, runId, APPROVE, "Almost landed.");
		const artifact = await writeArtifact(run, runId, APPROVE);
		await writeDecided(run, artifact, record);
		await run.release();
		const decidedAt = (await journalEvents(fx.storeRoot, runId)).length;
		flags[THROW_FLAG] = true;
		const service = await serviceFor(fx);
		try {
			const failed = await bounded(service.wait(runId), "wait");
			expect(failed.status).toBe("failed");
			const events = await journalEvents(fx.storeRoot, runId);
			const tail = events.slice(decidedAt);
			// The run-ending path commits the decided execution from its durable
			// evidence before the run fails: no cancel, no second request.
			expect(tail.map((event) => event.type)).toEqual([
				"task-execution-terminal",
				"task-status-changed",
				"run-status-changed",
			]);
			expect(tail[0]?.data).toMatchObject({
				outcome: "completed",
				evidence: {
					kind: "checkpoint",
					artifactId: artifact.id,
					decisionSha256: artifact.sha256,
					source: "operator",
					decidedBy: "vegard",
				},
			});
			expect(tail[1]?.data).toMatchObject({
				taskId,
				from: "waiting",
				to: "completed",
				reason: "Checkpoint decided.",
			});
			expect(tail[2]?.data).toMatchObject({
				from: "waiting",
				to: "failed",
				reason: "Static workflow source execution failed.",
			});
			expect(checkpointView(failed)).toMatchObject({
				status: "completed",
				checkpoint: {
					decision: { decidedBy: "vegard", reason: "Almost landed." },
				},
			});
			// The failed run still admits recovery through the completed checkpoint.
			delete flags[THROW_FLAG];
			await expect(
				service.invalidate(runId, taskId, "Ask again."),
			).resolves.toMatchObject({ status: "running" });
			await expect(
				bounded(service.wait(runId), "re-park"),
			).resolves.toMatchObject({ status: "waiting", parked: true });
		} finally {
			delete flags[THROW_FLAG];
			await bounded(service.shutdown(), "shutdown");
		}
	});
});

describe("nested checkpoints", () => {
	const PARENT = `return ctx.workflow("child", { workflow: "child", input: {} });`;

	/** Runs the parent and resolves with the child's run id once the child parks. */
	async function parkedChild(
		service: WorkflowService,
	): Promise<{ parentRunId: string; childRunId: string }> {
		const childParked = deferred<string>();
		let parentRunId = "";
		const unsubscribe = service.subscribe((observation) => {
			if (
				parentRunId !== "" &&
				observation.runId !== parentRunId &&
				observation.status === "waiting"
			) {
				childParked.resolve(observation.runId);
			}
		});
		try {
			const receipt = await service.run("parent", {});
			parentRunId = receipt.runId;
			const childRunId = await bounded(childParked.promise, "child park");
			// The child's drive settles parked shortly after the transition.
			await bounded(service.wait(childRunId), "child wait");
			return { parentRunId, childRunId };
		} finally {
			unsubscribe();
		}
	}

	it("holds the parent lane while the child waits and continues on its default", async () => {
		const fx = await fixture("nested-default", {
			parent: definition("parent", PARENT, { concurrency: 2 }),
			child: definition(
				"child",
				decideBody(
					checkpointSource({
						headless: "use-explicit-default",
						withDefault: true,
						timeoutMs: 1_000,
					}),
				),
			),
		});
		const service = await serviceFor(fx);
		// Only the wall clock is faked, and frozen before the runs start: the
		// child's 1 s checkpoint cannot be defaulted before its park is listed
		// and its decision refused, however slowly the two drives run (with a
		// real clock the child had already completed under full-suite load,
		// run 35099072360). The child's watchdog keeps its real 1 s timer.
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const { parentRunId, childRunId } = await parkedChild(service);
			const receipt = { runId: parentRunId };
			const partial = await bounded(
				service.wait(receipt.runId, { timeoutMs: 50 }),
				"partial wait",
			);
			// The parent's drive stays live (its lane waits on the child) and its
			// run status reflects that wait; it is never parked itself.
			expect(partial.timedOut).toBe(true);
			expect(partial.parked).toBeUndefined();
			expect(["running", "waiting"]).toContain(partial.status);
			expect(partial.pendingCheckpoints).toEqual([]);
			const page = await service.listRuns({ includeChildren: true });
			const child = page.runs.find((run) => run.runId === childRunId);
			expect(child).toMatchObject({
				depth: 1,
				status: "waiting",
				pendingCheckpointCount: 1,
				parent: { runId: receipt.runId },
			});
			expect(child?.availableActions).not.toContain("decide");
			const childView = await service.status(child?.runId ?? "");
			await expect(
				service.decide(child?.runId ?? "", checkpointView(childView).id, {
					decision: APPROVE,
					approver: "vegard",
				}),
			).rejects.toMatchObject({
				code: "validation",
				message: ROOT_ONLY_MESSAGE,
			});
			// Past the expiry, the child's watchdog re-drive defaults the
			// checkpoint; the parent completes.
			vi.setSystemTime(
				Date.parse(checkpointView(childView).checkpoint?.expiresAt ?? "") + 1,
			);
			const final = await bounded(service.wait(receipt.runId), "wait");
			expect(final).toMatchObject({
				status: "completed",
				output: { answer: "declined" },
			});
			expect(await service.status(child?.runId ?? "")).toMatchObject({
				status: "completed",
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("stops a parent whose child is parked by cancelling the child's checkpoint", async () => {
		const fx = await fixture("nested-stop", {
			parent: definition("parent", PARENT, { concurrency: 2 }),
			child: definition("child", decideBody(checkpointSource())),
		});
		const service = await serviceFor(fx);
		try {
			const { parentRunId, childRunId } = await parkedChild(service);
			const receipt = { runId: parentRunId };
			const partial = await bounded(
				service.wait(receipt.runId, { timeoutMs: 50 }),
				"partial wait",
			);
			expect(partial.timedOut).toBe(true);
			expect(partial.parked).toBeUndefined();
			const child = (
				await service.listRuns({ includeChildren: true })
			).runs.find((run) => run.runId === childRunId);
			expect(child?.status).toBe("waiting");
			const stopped = await bounded(
				service.stop(receipt.runId, "Operator stopped the parent."),
				"stop",
			);
			expect(stopped.status).toBe("cancelled");
			const childState = await stateOf(fx.storeRoot, child?.runId ?? "");
			expect(childState.status).toBe("cancelled");
			const { task, execution } = checkpointOf(childState);
			expect(task.status).toBe("cancelled");
			expect(execution.terminal).toMatchObject({
				outcome: "cancelled",
				evidence: { stage: "stop" },
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});
});
