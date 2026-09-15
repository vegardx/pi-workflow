import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	type AgentLaunchPlan,
	canonicalSha256,
	type RunReceipt,
	type RunResult,
	SUBAGENT_RUNTIME_CONTRACT,
	type SubagentClient,
	type SubagentRequest,
} from "@vegardx/pi-subagent";
import { type Static, Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type {
	WorkflowStateProjection,
	WorkflowTaskProjection,
} from "../src/events.js";
import {
	deriveSubagentOperationId,
	deriveTaskExecutionId,
} from "../src/execution.js";
import {
	type WorkflowJournalEvent,
	WorkflowRunJournal,
} from "../src/persistence/journal.js";
import { acquireWorkflowRunLease } from "../src/persistence/run-lease.js";
import { invalidationClosure, reduceWorkflowEvents } from "../src/reducer.js";
import {
	type WorkflowRunRecord,
	WorkflowRunRecordStore,
} from "../src/run-record.js";
import {
	createWorkflowService,
	type WorkflowService,
	WorkflowServiceError,
} from "../src/service.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";
import {
	defineSupportTask,
	type SupportTaskExecutionContext,
} from "../src/support.js";

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
		"test-service-invalidation",
		`${name}-${randomUUID()}`,
	);
}

function client(): SubagentClient {
	const unavailable = vi.fn(async () => {
		throw new Error("unexpected subagent call");
	});
	return {
		preflight: unavailable,
		launch: unavailable,
		findByOperation: unavailable,
		status: unavailable,
		listRuns: unavailable,
		logs: unavailable,
		wait: unavailable,
		interrupt: unavailable,
		steer: unavailable,
		followUp: unavailable,
		retry: unavailable,
		resume: unavailable,
		reconcile: unavailable,
		release: unavailable,
		abandon: unavailable,
		pin: unavailable,
		unpin: unavailable,
		exportArtifact: unavailable,
	} as unknown as SubagentClient;
}

/** A provider whose client rejects every call; support-only runs never delegate. */
function inertProvider(): WorkflowSubagentProvider {
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

async function workflowFixture(name = "example") {
	const base = root(name);
	const cwd = path.join(base, "project");
	const agentDir = path.join(base, "agent");
	const storeRoot = path.join(cwd, ".pi", "workflow");
	await mkdir(path.join(cwd, "workflows"), { recursive: true });
	const definitionPath = path.join(cwd, "workflows", `${name}.workflow.ts`);
	await writeFile(
		definitionPath,
		`export default {
  schema: "pi-workflow-definition",
  meta: { name: ${JSON.stringify(name)}, description: "Service workflow", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 3600000, concurrency: 4 },
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  run(ctx) { return { answer: ctx.input.value }; }
};\n`,
	);
	return { cwd, agentDir, storeRoot, definitionPath };
}

/** The fake child currently owned by the provider: one subagent run per launch. */
interface FakeChild {
	/** Per-provider nonce so a provider created after a restart never re-mints a journaled id. */
	nonce: string;
	launches: number;
	runId: string;
	attemptId: string;
}

function childIds(nonce: string, launch: number) {
	return {
		runId: `run_child${nonce}${launch}`,
		attemptId: `attempt_child${nonce}${launch}`,
	};
}

function taskProvider() {
	const nonce = randomUUID().replaceAll("-", "").slice(0, 8);
	const child: FakeChild = { nonce, launches: 0, ...childIds(nonce, 0) };
	const preflight = vi.fn(async (request: SubagentRequest) => {
		// The plan names the run and attempt the next launch will hand out.
		const planned = childIds(child.nonce, child.launches + 1);
		const draft = {
			schema: "pi-subagent-launch" as const,
			contractRevision: SUBAGENT_RUNTIME_CONTRACT.contractRevision,
			operationId: request.operationId,
			ownerId: "",
			runId: planned.runId,
			attemptId: planned.attemptId,
			agent: request.agent,
			agentDisplayName: "Researcher",
			agentPrompt: "Research",
			agentSource: "/agent.md",
			agentSha256: "a".repeat(64),
			agentScope: "global" as const,
			task: structuredClone(request.task),
			contextMode: request.contextMode,
			model: { provider: "test", id: "model", thinking: "low" as const },
			cwd: "/workspace" as const,
			tools: [...request.tools],
			preloadSkills: [...request.preloadSkills],
			contextScopes: [...request.contextScopes],
			resources: [
				{
					kind: "agent" as const,
					name: request.agent,
					source: "/agent.md",
					sha256: "a".repeat(64),
				},
			],
			workspace: {
				mode: request.workspace.mode,
				hostPathSha256: "a".repeat(64),
				baselineSha256: "a".repeat(64),
			},
			sandbox: {
				backend: "gondolin" as const,
				packageVersion: "0.12.0",
				imageSha256: "a".repeat(64),
				mountPolicySha256: "a".repeat(64),
				networkPolicySha256: "a".repeat(64),
				capacityPolicySha256: "a".repeat(64),
				memoryBytes: 536870912,
				guestDiskBytes: 1024,
				workspaceWriteBytes: 0,
			},
			network: {
				mode: "public-egress" as const,
				blockInternalRanges: true as const,
			},
			outputSchema: structuredClone(request.outputSchema),
			limits: structuredClone(request.limits),
		} satisfies Omit<AgentLaunchPlan, "identitySha256">;
		const ownerId = taskOwnerId;
		const plan = { ...draft, ownerId };
		return {
			preflightId: "preflight-service",
			identitySha256: canonicalSha256(plan),
			expiresAt: "2099-01-01T00:00:00.000Z",
			launchPlan: { ...plan, identitySha256: canonicalSha256(plan) },
		};
	});
	let taskOwnerId = "";
	const ownerClient = {
		...client(),
		preflight,
		launch: vi.fn(async () => {
			child.launches += 1;
			Object.assign(child, childIds(child.nonce, child.launches));
			return {
				runId: child.runId,
				attemptId: child.attemptId,
				status: "active" as const,
			};
		}),
		wait: vi.fn(async () => childResult({ status: "completed" }, child.runId)),
		release: vi.fn(async () => ({
			runId: child.runId,
			attemptId: child.attemptId,
			status: "completed" as const,
		})),
	} as unknown as SubagentClient;
	const bind = vi.fn(async (runId: string) => {
		taskOwnerId = `pi-workflow:${runId}`;
		return {
			workflowRunId: runId,
			ownerId: taskOwnerId,
			client: ownerClient,
		};
	});
	return { provider: { bind } as WorkflowSubagentProvider, ownerClient, child };
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

async function journalEvents(
	storeRoot: string,
	runId: string,
): Promise<WorkflowJournalEvent[]> {
	let journal: string;
	try {
		journal = await readFile(
			path.join(storeRoot, "runs", runId, "events.jsonl"),
			"utf8",
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	// Only newline-terminated records are complete while the service appends.
	const complete = journal.endsWith("\n")
		? journal
		: journal.slice(0, journal.lastIndexOf("\n") + 1);
	return complete
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as WorkflowJournalEvent);
}

async function eventTypes(storeRoot: string, runId: string) {
	return (await journalEvents(storeRoot, runId)).map((event) => event.type);
}

async function stateOf(
	storeRoot: string,
	runId: string,
): Promise<WorkflowStateProjection> {
	return reduceWorkflowEvents(await journalEvents(storeRoot, runId));
}

function countOf(types: readonly string[], type: string): number {
	return types.filter((candidate) => candidate === type).length;
}

interface AttemptWorkflowOptions {
	readonly retry?: { attempts: number; on?: readonly ("backoff" | "manual")[] };
	readonly resume?: { attempts: number };
	readonly budgetCost?: number;
	readonly timeoutMs?: number;
	readonly limitCost?: number;
}

async function attemptWorkflowFixture(options: AttemptWorkflowOptions = {}) {
	const fixture = await workflowFixture("attempts");
	const policies = [
		options.retry ? `retry: ${JSON.stringify(options.retry)},` : "",
		options.resume ? `resume: ${JSON.stringify(options.resume)},` : "",
	].join("\n      ");
	await writeFile(
		fixture.definitionPath,
		`export default {
  schema: "pi-workflow-definition",
  meta: { name: "attempts", description: "Attempt policy workflow", version: 1, budget: { cost: ${options.budgetCost ?? 1000}, childRuntimeMs: 3600000 }, timeoutMs: ${options.timeoutMs ?? 3600000}, concurrency: 4 },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  run(ctx) {
    return ctx.agent("answer", {
      agent: "researcher",
      task: { goal: "Answer", context: [], instructions: ["Return structured output."] },
      contextMode: "fresh",
      tools: ["read"],
      preloadSkills: [],
      contextScopes: ["project"],
      workspace: { mode: "read-only", cwd: ctx.cwd },
      outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
      ${policies}
      limits: { cumulativeRuntimeMs: 300000, attemptTimeoutMs: 300000, totalTokens: 1000000, cost: ${options.limitCost ?? 10}, outputBytes: 1024, workspaceWriteBytes: 0, retries: ${options.retry?.attempts ?? 0}, resumes: ${options.resume?.attempts ?? 0} }
    });
  }
};\n`,
	);
	return fixture;
}

type ChildFailure = NonNullable<RunResult["failure"]>;

function childFailure(
	retry: ChildFailure["retry"],
	retryAfterMs?: number,
): ChildFailure {
	return {
		code: "provider-transient",
		origin: "provider",
		retry,
		message: "provider hiccup",
		guidance: "Try again later.",
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
	};
}

interface ChildOutcome {
	readonly status: RunResult["status"];
	readonly failure?: ChildFailure;
	readonly cost?: number;
}

function childResult(outcome: ChildOutcome, runId: string) {
	const completed = outcome.status === "completed";
	const result: RunResult = {
		runId,
		status: outcome.status,
		...(completed ? { structuredOutput: { answer: "from child" } } : {}),
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: outcome.cost ?? 0,
		},
		usageComplete: true,
		runtimeMs: 10,
		...(outcome.failure ? { failure: outcome.failure } : {}),
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
	};
	return {
		result,
		output: completed ? "from child" : "",
		sessionFile: undefined,
		handoff: undefined,
		structuredOutput: result.structuredOutput,
		error: outcome.failure?.message,
	};
}

/**
 * Owner client whose successive `wait` calls return `outcomes` in order (the
 * last one repeats) and whose `retry`/`resume` hand out fresh attempt ids
 * that `release` then echoes back for the current attempt.
 */
function attemptProvider(outcomes: readonly ChildOutcome[]) {
	const delegated = taskProvider();
	const { child } = delegated;
	let attempts = 1;
	let waits = 0;
	let lastStatus: RunResult["status"] = "completed";
	const nextAttempt = async (): Promise<RunReceipt> => {
		attempts += 1;
		child.attemptId = `${childIds(child.nonce, child.launches).attemptId}x${attempts}`;
		return { runId: child.runId, attemptId: child.attemptId, status: "active" };
	};
	vi.mocked(delegated.ownerClient.wait).mockImplementation(async () => {
		const outcome = outcomes[Math.min(waits, outcomes.length - 1)];
		if (!outcome) throw new Error("no child outcome scripted");
		waits += 1;
		lastStatus = outcome.status;
		return childResult(outcome, child.runId);
	});
	vi.mocked(delegated.ownerClient.release).mockImplementation(async () => ({
		runId: child.runId,
		attemptId: child.attemptId,
		status: lastStatus,
	}));
	// `client()` shares one rejecting mock across every method, so the
	// attempt calls need their own mocks to be counted separately.
	const ownerClient = delegated.ownerClient as unknown as Record<
		string,
		unknown
	>;
	ownerClient.retry = vi.fn(nextAttempt);
	ownerClient.resume = vi.fn(nextAttempt);
	ownerClient.interrupt = vi.fn(async () => {
		throw new Error("unexpected interrupt");
	});
	return { ...delegated, nextAttempt };
}

const EXECUTION_ID = /^execution_[a-z0-9]+$/;

function agentTaskOf(state: WorkflowStateProjection): WorkflowTaskProjection {
	const task = Object.values(state.tasks).find(
		(candidate) => candidate.task.spec.kind === "agent",
	);
	if (!task) throw new Error("missing agent task");
	return task;
}

function runStatusChanges(events: readonly WorkflowJournalEvent[]) {
	return events
		.filter((event) => event.type === "run-status-changed")
		.map(
			(event) => event.data as { from: string; to: string; reason?: string },
		);
}

function executionsCreated(events: readonly WorkflowJournalEvent[]) {
	return events
		.filter((event) => event.type === "task-execution-created")
		.map(
			(event) =>
				(
					event.data as {
						execution: {
							id: string;
							taskId: string;
							generation: number;
							operationId?: string;
						};
					}
				).execution,
		);
}

function operationIdsPreflighted(client: SubagentClient): string[] {
	return vi
		.mocked(client.preflight)
		.mock.calls.map(([request]) => (request as SubagentRequest).operationId);
}

async function expectServiceError(
	promise: Promise<unknown>,
	code: WorkflowServiceError["code"],
	message?: string,
): Promise<WorkflowServiceError> {
	const outcome = await promise.then(
		(value) => ({ resolved: true as const, value }),
		(error: unknown) => ({ resolved: false as const, error }),
	);
	if (outcome.resolved) {
		throw new Error(
			`expected a ${code} WorkflowServiceError but the call resolved with ${JSON.stringify(outcome.value)}`,
		);
	}
	expect(outcome.error).toBeInstanceOf(WorkflowServiceError);
	const error = outcome.error as WorkflowServiceError;
	expect({ code: error.code, message: error.message }).toEqual({
		code,
		message: message ?? error.message,
	});
	return error;
}

/** Drives the attempts workflow once with `outcomes` until it settles. */
async function settledAttemptRun(
	fixture: Awaited<ReturnType<typeof attemptWorkflowFixture>>,
	outcomes: readonly ChildOutcome[],
) {
	const delegated = attemptProvider(outcomes);
	const service = await createWorkflowService({
		...fixture,
		projectTrusted: () => true,
		subagents: delegated.provider,
	});
	const receipt = await service.run("attempts", {});
	const first = await bounded(service.wait(receipt.runId), "first wait");
	const task = agentTaskOf(await stateOf(fixture.storeRoot, receipt.runId));
	return {
		service,
		delegated,
		runId: receipt.runId,
		taskId: task.task.id,
		first,
	};
}

const TOOLS_MODULE = "@vegardx/workflow-tools";
const EMPTY_SCHEMA = Type.Object({});
const ANSWER_SCHEMA = Type.Object({ answer: Type.String() });
type EmptyContext = SupportTaskExecutionContext<Static<typeof EMPTY_SCHEMA>>;

const flaky = defineSupportTask({
	name: `${TOOLS_MODULE}/flaky`,
	moduleSpecifier: TOOLS_MODULE,
	revision: 1,
	implementationSha256: "f".repeat(64),
	parametersSchema: EMPTY_SCHEMA,
	outputSchema: ANSWER_SCHEMA,
});

function supportToolsModuleSource(): string {
	const identity = JSON.stringify({
		implementation: flaky.implementation,
		moduleSpecifier: flaky.moduleSpecifier,
		revision: flaky.revision,
		implementationSha256: flaky.implementationSha256,
		parametersSchema: flaky.parametersSchema,
		outputSchema: flaky.outputSchema,
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
export function flaky(call) { return descriptor(${identity}, call); }
`;
}

async function supportWorkflowFixture(name: string) {
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
	await writeFile(
		path.join(packageDir, "index.js"),
		supportToolsModuleSource(),
	);
	const definitionPath = path.join(cwd, "workflows", `${name}.workflow.ts`);
	await writeFile(
		definitionPath,
		`import { flaky } from ${JSON.stringify(TOOLS_MODULE)};
export default {
  schema: "pi-workflow-definition",
  meta: { name: ${JSON.stringify(name)}, description: "Support invalidation", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 600000, concurrency: 2 },
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  run(ctx) {
    return ctx.support("flaky", flaky({ parameters: {} }));
  }
};
`,
	);
	return { cwd, agentDir, storeRoot, definitionPath };
}

/**
 * Appends `task-invalidated` for `causeTaskId` directly to the durable
 * journal, as the service would, without restarting any drive: the run is
 * left exactly as a crash between invalidation and recovery would leave it.
 */
async function appendInvalidationDirectly(
	storeRoot: string,
	runId: string,
	causeTaskId: string,
	reason: string,
) {
	const lease = await acquireWorkflowRunLease({
		storeRoot,
		runId,
		ownerId: "operator",
	});
	try {
		const journal = await WorkflowRunJournal.open(storeRoot, runId, lease);
		const state = reduceWorkflowEvents(await journal.readEvents());
		const closure = invalidationClosure(state, causeTaskId);
		await journal.append("task-invalidated", {
			causeTaskId,
			taskIds: closure.taskIds,
			abandonedEpochs: closure.abandonedEpochs,
			reason,
		});
	} finally {
		await lease.release();
	}
}

async function shutdownQuietly(service: WorkflowService | undefined) {
	if (!service) return;
	await bounded(service.shutdown(), "shutdown").catch(() => undefined);
}

type ReplayInput = { type: WorkflowJournalEvent["type"]; data: unknown };

/**
 * Rewrites one durable event of a failed agent-task run into the event the
 * same run would have persisted had the child ended `interrupted` instead,
 * or `undefined` to drop it. The child evidence keeps its retry class
 * "never", so no resume policy could ever apply to it. An interrupted
 * settlement is terminalized without release, so the failed run's release
 * intent and receipt are dropped from the replay.
 */
function interruptedVariant(
	event: WorkflowJournalEvent,
	dropIndex: number,
	index: number,
): ReplayInput | undefined {
	if (index === dropIndex) return undefined;
	const data = structuredClone(event.data) as Record<string, unknown>;
	const interruptedEvidence = (evidence: Record<string, unknown>) => ({
		...evidence,
		status: "interrupted",
		failure: { ...childFailure("never"), retry: "never" },
	});
	switch (event.type) {
		case "task-execution-release-intended":
		case "task-execution-released":
			return undefined;
		case "task-execution-child-observed":
			return { type: event.type, data: { ...data, status: "interrupted" } };
		case "task-execution-child-settled":
			return {
				type: event.type,
				data: {
					...data,
					evidence: interruptedEvidence(
						data.evidence as Record<string, unknown>,
					),
				},
			};
		case "task-execution-terminal":
			return {
				type: event.type,
				data: {
					...data,
					outcome: "interrupted",
					evidence: interruptedEvidence(
						data.evidence as Record<string, unknown>,
					),
				},
			};
		case "task-status-changed":
			return data.to === "failed"
				? { type: event.type, data: { ...data, to: "interrupted" } }
				: { type: event.type, data };
		case "run-status-changed":
			return data.to === "failed"
				? {
						type: event.type,
						data: {
							from: "running",
							to: "interrupted",
							reason: "A required workflow task was interrupted.",
						},
					}
				: { type: event.type, data };
		default:
			return { type: event.type, data };
	}
}

/**
 * Builds a durably `interrupted` run by replaying a real failed run through
 * the validating journal into a fresh store root with its child evidence
 * rewritten to `interrupted` and its release events dropped. Every replayed
 * event still passes the reducer, so the result is a legitimate projection.
 */
async function replayedInterruptedRun(
	fixture: Awaited<ReturnType<typeof attemptWorkflowFixture>>,
) {
	const failed = await settledAttemptRun(fixture, [
		{ status: "failed", failure: childFailure("manual") },
	]);
	expect(failed.first.status).toBe("failed");
	await bounded(failed.service.shutdown(), "first shutdown");
	const { runId, taskId } = failed;

	let record: WorkflowRunRecord;
	let events: WorkflowJournalEvent[];
	const sourceLease = await acquireWorkflowRunLease({
		storeRoot: fixture.storeRoot,
		runId,
		ownerId: "replay",
	});
	try {
		const source = await WorkflowRunJournal.open(
			fixture.storeRoot,
			runId,
			sourceLease,
		);
		record = await WorkflowRunRecordStore.open(source).read();
		events = await source.readEvents();
	} finally {
		await sourceLease.release();
	}

	// The run must be `running` when the child settles: `interrupted` is only
	// reachable from `running`, so the idle-lane `waiting` hop that directly
	// precedes the child observation is dropped from the replay.
	const observedAt = events.findIndex(
		(event) => event.type === "task-execution-child-observed",
	);
	if (observedAt < 0) throw new Error("failed run has no child observation");
	let statusBeforeObservation = "created";
	let lastRunStatusIndex = -1;
	events.slice(0, observedAt).forEach((event, index) => {
		if (event.type !== "run-status-changed") return;
		statusBeforeObservation = (event.data as { to: string }).to;
		lastRunStatusIndex = index;
	});
	const dropIndex =
		statusBeforeObservation === "waiting" ? lastRunStatusIndex : -1;

	const storeRoot = path.join(fixture.cwd, ".pi", `workflow-${randomUUID()}`);
	const lease = await acquireWorkflowRunLease({
		storeRoot,
		runId,
		ownerId: "replay",
	});
	try {
		const journal = await WorkflowRunJournal.open(storeRoot, runId, lease);
		await WorkflowRunRecordStore.open(journal).create(record);
		for (const [index, event] of events.entries()) {
			const replayed = interruptedVariant(event, dropIndex, index);
			if (!replayed) continue;
			await journal.appendEvent(replayed as never);
		}
	} finally {
		await lease.release();
	}
	const state = await stateOf(storeRoot, runId);
	expect(state.status).toBe("interrupted");
	expect(state.tasks[taskId]?.status).toBe("interrupted");
	return { storeRoot, runId, taskId };
}

describe("invalidation and re-execution", () => {
	it("re-executes a failed required agent task as generation 2 after invalidation", async () => {
		const fixture = await attemptWorkflowFixture();
		const { service, delegated, runId, taskId, first } =
			await settledAttemptRun(fixture, [
				{ status: "failed", failure: childFailure("manual") },
				{ status: "completed" },
			]);
		try {
			expect(first.status).toBe("failed");
			const firstView = await service.status(runId);
			expect(firstView.tasks).toEqual([
				expect.objectContaining({
					id: taskId,
					status: "failed",
					generation: 1,
				}),
			]);
			const generation1 = deriveTaskExecutionId(runId, taskId, 1);
			const generation2 = deriveTaskExecutionId(runId, taskId, 2);
			const operation2 = deriveSubagentOperationId(runId, taskId, 2);
			const beforeInvalidation = await eventTypes(fixture.storeRoot, runId);
			expect(countOf(beforeInvalidation, "task-execution-created")).toBe(1);

			const invalidated = await bounded(
				service.invalidate(runId, taskId, "operator re-run"),
				"invalidate",
			);
			expect(["running", "waiting"]).toContain(invalidated.status);

			const finished = await bounded(service.wait(runId), "wait");
			expect(finished).toMatchObject({
				status: "completed",
				output: { answer: "from child" },
			});

			const events = await journalEvents(fixture.storeRoot, runId);
			const types = events.map((event) => event.type);
			expect(countOf(types, "task-invalidated")).toBe(1);
			const invalidation = events.find(
				(event) => event.type === "task-invalidated",
			);
			expect(invalidation?.data).toEqual({
				causeTaskId: taskId,
				taskIds: [taskId],
				abandonedEpochs: [],
				reason: "operator re-run",
			});
			expect(runStatusChanges(events)).toContainEqual(
				expect.objectContaining({ from: "failed", to: "running" }),
			);
			const invalidationIndex = types.indexOf("task-invalidated");
			const recoveryIndex = events.findIndex(
				(event) =>
					event.type === "run-status-changed" &&
					(event.data as { from: string }).from === "failed" &&
					(event.data as { to: string }).to === "running",
			);
			expect(recoveryIndex).toBeGreaterThan(invalidationIndex);
			const rematerialized = events.filter(
				(event) =>
					event.type === "task-status-changed" &&
					(event.data as { from: string; to: string }).from === "invalidated" &&
					(event.data as { to: string }).to === "pending",
			);
			expect(rematerialized).toHaveLength(1);
			expect(
				events.indexOf(rematerialized[0] as WorkflowJournalEvent),
			).toBeGreaterThan(recoveryIndex);

			const created = executionsCreated(events);
			expect(created).toHaveLength(2);
			expect(created[0]).toMatchObject({
				id: generation1,
				taskId,
				generation: 1,
			});
			expect(created[1]).toMatchObject({
				id: generation2,
				taskId,
				generation: 2,
				operationId: operation2,
			});
			expect(created[1]?.operationId).not.toBe(created[0]?.operationId);

			// The second generation is a fresh launch, not an attempt on the old
			// child run.
			expect(operationIdsPreflighted(delegated.ownerClient)).toEqual([
				deriveSubagentOperationId(runId, taskId, 1),
				operation2,
			]);
			expect(delegated.ownerClient.launch).toHaveBeenCalledTimes(2);
			expect(delegated.ownerClient.retry).not.toHaveBeenCalled();
			expect(delegated.ownerClient.resume).not.toHaveBeenCalled();
			expect(countOf(types, "task-execution-child-settled")).toBe(2);

			const state = reduceWorkflowEvents(events);
			expect(state.status).toBe("completed");
			const task = agentTaskOf(state);
			expect(task.status).toBe("completed");
			expect(task.abandoned).toBeUndefined();
			expect(task.currentExecutionId).toBe(generation2);
			const results = Object.values(state.artifacts).filter(
				(artifact) =>
					artifact.producerTaskId === taskId && artifact.output === "result",
			);
			expect(results).toHaveLength(1);
			expect(results[0]?.producerExecutionId).toBe(generation2);
			// Generation 1 and its terminal evidence stay as history.
			const previous = state.executions[generation1];
			expect(previous).toBeDefined();
			expect(previous?.execution.generation).toBe(1);
			expect(previous?.phase).toBe("terminal");
			expect(previous?.terminal?.evidence).toMatchObject({
				kind: "subagent",
				status: "failed",
			});
			expect(state.executions[generation2]).toMatchObject({
				phase: "terminal",
				terminal: { outcome: "completed" },
			});
			// One subagent run per task execution: generation 2 ran a different
			// child than generation 1 did.
			const firstChild = previous?.launchReceipt?.subagentRunId;
			const secondChild =
				state.executions[generation2]?.launchReceipt?.subagentRunId;
			expect(firstChild).toMatch(/^run_[a-z0-9]+$/);
			expect(secondChild).toMatch(/^run_[a-z0-9]+$/);
			expect(secondChild).not.toBe(firstChild);
			expect(secondChild).toBe(delegated.child.runId);

			const view = await service.status(runId);
			expect(view.tasks).toEqual([
				{
					id: taskId,
					namespace: expect.any(Array),
					key: "answer",
					kind: "agent",
					role: "task",
					status: "completed",
					generation: 2,
				},
			]);
			expect(view.tasks?.some((entry) => entry.abandoned)).toBe(false);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("refuses invalidation while the run is still being driven", async () => {
		const fixture = await attemptWorkflowFixture();
		const delegated = attemptProvider([{ status: "completed" }]);
		const gate = deferred<void>();
		const entered = deferred<void>();
		const scripted = vi
			.mocked(delegated.ownerClient.wait)
			.getMockImplementation();
		vi.mocked(delegated.ownerClient.wait).mockImplementation(
			async (...args) => {
				entered.resolve();
				await gate.promise;
				if (!scripted) throw new Error("missing scripted child wait");
				return scripted(...args);
			},
		);
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		try {
			const receipt = await service.run("attempts", {});
			await bounded(entered.promise, "child wait entered");
			expect(delegated.ownerClient.wait).toHaveBeenCalled();
			const taskId = agentTaskOf(
				await stateOf(fixture.storeRoot, receipt.runId),
			).task.id;
			await expectServiceError(
				service.invalidate(receipt.runId, taskId, "too early"),
				"conflict",
				"Workflow run is still being driven.",
			);
			gate.resolve();
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({ status: "completed" });
			expect(
				(await eventTypes(fixture.storeRoot, receipt.runId)).includes(
					"task-invalidated",
				),
			).toBe(false);
		} finally {
			gate.resolve();
			await shutdownQuietly(service);
		}
	});

	it("refuses invalidation of a completed run", async () => {
		const fixture = await attemptWorkflowFixture();
		const { service, runId, taskId, first } = await settledAttemptRun(fixture, [
			{ status: "completed" },
		]);
		try {
			expect(first.status).toBe("completed");
			await expectServiceError(
				service.invalidate(runId, taskId, "already done"),
				"validation",
				"Workflow run status does not admit invalidation.",
			);
			const types = await eventTypes(fixture.storeRoot, runId);
			expect(countOf(types, "task-invalidated")).toBe(0);
			expect(countOf(types, "task-execution-created")).toBe(1);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("validates the run id, task id, and reason before touching the run", async () => {
		const fixture = await attemptWorkflowFixture();
		const { service, runId, taskId, first } = await settledAttemptRun(fixture, [
			{ status: "failed", failure: childFailure("manual") },
		]);
		try {
			expect(first.status).toBe("failed");
			await expectServiceError(
				service.invalidate("workflow_doesnotexist", taskId, "missing"),
				"not-found",
			);
			await expectServiceError(
				service.invalidate(runId, "not-a-task-id", "malformed"),
				"validation",
			);
			await expectServiceError(
				service.invalidate(runId, taskId, ""),
				"validation",
			);
			await expectServiceError(
				service.invalidate(runId, taskId, "x".repeat(4097)),
				"validation",
			);
			await expectServiceError(
				service.invalidate(runId, "task_unknown0000", "unknown cause"),
				"validation",
				"invalidation cause task is unknown",
			);
			// None of the rejected calls may have left durable traces or restarted
			// the drive: the run is still failed and untouched.
			const types = await eventTypes(fixture.storeRoot, runId);
			expect(countOf(types, "task-invalidated")).toBe(0);
			expect(countOf(types, "task-execution-created")).toBe(1);
			await expect(service.status(runId)).resolves.toMatchObject({
				status: "failed",
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("re-executes an interrupted run after invalidation", async () => {
		const fixture = await attemptWorkflowFixture();
		const { storeRoot, runId, taskId } = await replayedInterruptedRun(fixture);
		const delegated = attemptProvider([{ status: "completed" }]);
		const service = await createWorkflowService({
			...fixture,
			storeRoot,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		try {
			await expect(service.status(runId)).resolves.toMatchObject({
				status: "interrupted",
				tasks: [
					expect.objectContaining({
						id: taskId,
						status: "interrupted",
						generation: 1,
					}),
				],
			});
			const invalidated = await bounded(
				service.invalidate(runId, taskId, "operator re-run"),
				"invalidate",
			);
			expect(["running", "waiting"]).toContain(invalidated.status);
			await expect(bounded(service.wait(runId), "wait")).resolves.toMatchObject(
				{ status: "completed", output: { answer: "from child" } },
			);
			const events = await journalEvents(storeRoot, runId);
			expect(runStatusChanges(events)).toContainEqual(
				expect.objectContaining({ from: "interrupted", to: "running" }),
			);
			expect(executionsCreated(events).map((e) => e.generation)).toEqual([
				1, 2,
			]);
			// Generation 2 is a fresh launch by this service; the interrupted
			// child is never resumed.
			expect(delegated.ownerClient.launch).toHaveBeenCalledOnce();
			expect(operationIdsPreflighted(delegated.ownerClient)).toEqual([
				deriveSubagentOperationId(runId, taskId, 2),
			]);
			expect(delegated.ownerClient.resume).not.toHaveBeenCalled();
			expect(delegated.ownerClient.retry).not.toHaveBeenCalled();
			const state = reduceWorkflowEvents(events);
			const task = agentTaskOf(state);
			expect(task.status).toBe("completed");
			expect(task.currentExecutionId).toBe(
				deriveTaskExecutionId(runId, taskId, 2),
			);
			expect(
				state.executions[deriveTaskExecutionId(runId, taskId, 1)]?.terminal
					?.evidence,
			).toMatchObject({ status: "interrupted" });
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("admits the re-execution when the cumulative budget still covers it", async () => {
		// Admission reserves the task's declared cost limit on top of every
		// settled generation: 0.01 settled + 0.01 reserved fits under 0.025 and
		// the two settlements together (0.02) stay under it after finalization.
		const fixture = await attemptWorkflowFixture({
			budgetCost: 0.025,
			limitCost: 0.01,
		});
		const { service, runId, taskId, first } = await settledAttemptRun(fixture, [
			{ status: "failed", failure: childFailure("manual"), cost: 0.01 },
			{ status: "completed", cost: 0.01 },
		]);
		try {
			expect(first.status).toBe("failed");
			await bounded(
				service.invalidate(runId, taskId, "retry within budget"),
				"invalidate",
			);
			await expect(bounded(service.wait(runId), "wait")).resolves.toMatchObject(
				{ status: "completed", output: { answer: "from child" } },
			);
			const events = await journalEvents(fixture.storeRoot, runId);
			const reasons = runStatusChanges(events).map((change) => change.reason);
			expect(reasons).not.toContain("Workflow cost budget is exhausted.");
			expect(reasons).not.toContain("Workflow cost budget was exceeded.");
			const state = reduceWorkflowEvents(events);
			const generation1 =
				state.executions[deriveTaskExecutionId(runId, taskId, 1)];
			const generation2 =
				state.executions[deriveTaskExecutionId(runId, taskId, 2)];
			expect(generation1?.settlement?.evidence.usage.cost).toBe(0.01);
			expect(generation2?.settlement?.evidence.usage.cost).toBe(0.01);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("blocks the re-execution when the failed generation already spent the budget", async () => {
		// 0.01 settled by the failed generation + a 0.01 reservation exceeds a
		// 0.015 budget, so the scheduler must refuse to launch generation 2.
		const fixture = await attemptWorkflowFixture({
			budgetCost: 0.015,
			limitCost: 0.01,
		});
		const { service, delegated, runId, taskId, first } =
			await settledAttemptRun(fixture, [
				{ status: "failed", failure: childFailure("manual"), cost: 0.01 },
				{ status: "completed", cost: 0.01 },
			]);
		try {
			expect(first.status).toBe("failed");
			await bounded(
				service.invalidate(runId, taskId, "retry over budget"),
				"invalidate",
			);
			const finished = await bounded(service.wait(runId), "wait");
			expect(finished.status).toBe("failed");
			const events = await journalEvents(fixture.storeRoot, runId);
			const changes = runStatusChanges(events);
			expect(changes).toContainEqual(
				expect.objectContaining({ from: "failed", to: "running" }),
			);
			expect(changes.at(-1)).toMatchObject({
				to: "failed",
				reason: "Workflow cost budget is exhausted.",
			});
			expect(executionsCreated(events).map((e) => e.generation)).toEqual([1]);
			expect(delegated.ownerClient.launch).toHaveBeenCalledOnce();
			const state = reduceWorkflowEvents(events);
			const task = agentTaskOf(state);
			expect(task.status).toBe("blocked");
			// Re-materialization cleared the current execution; no generation 2
			// was ever created, and generation 1 stays as history with its
			// terminal evidence and settled usage.
			expect(task.currentExecutionId).toBeUndefined();
			const generation1 =
				state.executions[deriveTaskExecutionId(runId, taskId, 1)];
			expect(generation1).toMatchObject({
				phase: "terminal",
				terminal: { outcome: "failed" },
			});
			expect(generation1?.settlement?.evidence.usage.cost).toBe(0.01);
			expect(
				Object.values(state.executions).filter(
					(execution) => execution.execution.taskId === taskId,
				),
			).toHaveLength(1);
			const view = await service.status(runId);
			expect(view.tasks?.[0]).toMatchObject({
				id: taskId,
				status: "blocked",
				generation: 1,
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("recovers through wait after a crash between invalidation and restart", async () => {
		const fixture = await attemptWorkflowFixture();
		const firstRun = await settledAttemptRun(fixture, [
			{ status: "failed", failure: childFailure("manual") },
		]);
		const { runId, taskId } = firstRun;
		expect(firstRun.first.status).toBe("failed");
		await bounded(firstRun.service.shutdown(), "first shutdown");
		expect(firstRun.delegated.ownerClient.launch).toHaveBeenCalledOnce();

		await appendInvalidationDirectly(
			fixture.storeRoot,
			runId,
			taskId,
			"invalidated before the crash",
		);
		const durable = await stateOf(fixture.storeRoot, runId);
		expect(durable.status).toBe("failed");
		expect(durable.tasks[taskId]?.status).toBe("invalidated");

		const second = attemptProvider([{ status: "completed" }]);
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: second.provider,
		});
		try {
			const finished = await bounded(service.wait(runId), "wait");
			expect(finished).toMatchObject({
				status: "completed",
				output: { answer: "from child" },
			});
			const events = await journalEvents(fixture.storeRoot, runId);
			expect(runStatusChanges(events)).toContainEqual(
				expect.objectContaining({ from: "failed", to: "running" }),
			);
			expect(executionsCreated(events).map((e) => e.generation)).toEqual([
				1, 2,
			]);
			expect(second.ownerClient.launch).toHaveBeenCalledOnce();
			expect(second.ownerClient.retry).not.toHaveBeenCalled();
			expect(operationIdsPreflighted(second.ownerClient)).toEqual([
				deriveSubagentOperationId(runId, taskId, 2),
			]);
			// The recovered generation ran a different subagent run than the one
			// the pre-crash generation used.
			const recovered = reduceWorkflowEvents(events);
			const firstChild =
				recovered.executions[deriveTaskExecutionId(runId, taskId, 1)]
					?.launchReceipt?.subagentRunId;
			const secondChild =
				recovered.executions[deriveTaskExecutionId(runId, taskId, 2)]
					?.launchReceipt?.subagentRunId;
			expect(firstChild).toMatch(/^run_[a-z0-9]+$/);
			expect(secondChild).toBe(second.child.runId);
			expect(secondChild).not.toBe(firstChild);
			expect(finished.tasks?.[0]).toMatchObject({
				id: taskId,
				status: "completed",
				generation: 2,
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("recovers through reconcile after a crash between invalidation and restart", async () => {
		const fixture = await attemptWorkflowFixture();
		const firstRun = await settledAttemptRun(fixture, [
			{ status: "failed", failure: childFailure("manual") },
		]);
		const { runId, taskId } = firstRun;
		expect(firstRun.first.status).toBe("failed");
		await bounded(firstRun.service.shutdown(), "first shutdown");

		await appendInvalidationDirectly(
			fixture.storeRoot,
			runId,
			taskId,
			"invalidated before the crash",
		);

		const second = attemptProvider([{ status: "completed" }]);
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: second.provider,
		});
		try {
			const reconciled = await bounded(service.reconcile(runId), "reconcile");
			expect(reconciled).toMatchObject({
				status: "completed",
				output: { answer: "from child" },
			});
			const events = await journalEvents(fixture.storeRoot, runId);
			expect(runStatusChanges(events)).toContainEqual(
				expect.objectContaining({ from: "failed", to: "running" }),
			);
			expect(executionsCreated(events).map((e) => e.generation)).toEqual([
				1, 2,
			]);
			expect(second.ownerClient.launch).toHaveBeenCalledOnce();
			expect(reconciled.tasks?.[0]).toMatchObject({
				id: taskId,
				status: "completed",
				generation: 2,
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("refuses a second invalidation once the recovery has completed", async () => {
		const fixture = await attemptWorkflowFixture();
		const { service, runId, taskId, first } = await settledAttemptRun(fixture, [
			{ status: "failed", failure: childFailure("manual") },
			{ status: "completed" },
		]);
		try {
			expect(first.status).toBe("failed");
			await bounded(service.invalidate(runId, taskId, "first"), "invalidate");
			await expect(bounded(service.wait(runId), "wait")).resolves.toMatchObject(
				{ status: "completed" },
			);
			await expectServiceError(
				service.invalidate(runId, taskId, "second"),
				"validation",
				"Workflow run status does not admit invalidation.",
			);
			const types = await eventTypes(fixture.storeRoot, runId);
			expect(countOf(types, "task-invalidated")).toBe(1);
			expect(countOf(types, "task-execution-created")).toBe(2);
			await expect(service.status(runId)).resolves.toMatchObject({
				status: "completed",
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("refuses invalidation while the run already awaits recovery of invalidated work", async () => {
		const fixture = await attemptWorkflowFixture();
		const firstRun = await settledAttemptRun(fixture, [
			{ status: "failed", failure: childFailure("manual") },
		]);
		const { runId, taskId } = firstRun;
		expect(firstRun.first.status).toBe("failed");
		await bounded(firstRun.service.shutdown(), "first shutdown");

		// A crash between `task-invalidated` and the recovery transition leaves
		// the run durably failed with on-path invalidated work.
		await appendInvalidationDirectly(
			fixture.storeRoot,
			runId,
			taskId,
			"invalidated before the crash",
		);
		const second = attemptProvider([{ status: "completed" }]);
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: second.provider,
		});
		try {
			await expect(service.status(runId)).resolves.toMatchObject({
				status: "failed",
				tasks: [
					expect.objectContaining({
						id: taskId,
						status: "invalidated",
						generation: 1,
					}),
				],
			});
			await expectServiceError(
				service.invalidate(runId, taskId, "second operator"),
				"validation",
				"Workflow run already awaits recovery of invalidated work.",
			);
			// The refusal neither appends nor restarts anything: the crash state
			// is exactly as it was, with the recovery still pending.
			const untouched = await journalEvents(fixture.storeRoot, runId);
			expect(
				countOf(
					untouched.map((e) => e.type),
					"task-invalidated",
				),
			).toBe(1);
			expect(runStatusChanges(untouched)).not.toContainEqual(
				expect.objectContaining({ from: "failed", to: "running" }),
			);
			expect(executionsCreated(untouched).map((e) => e.generation)).toEqual([
				1,
			]);
			expect(second.ownerClient.launch).not.toHaveBeenCalled();
			await expect(service.status(runId)).resolves.toMatchObject({
				status: "failed",
			});

			// The pending recovery is still performed by the next wait.
			const finished = await bounded(service.wait(runId), "wait");
			expect(finished).toMatchObject({
				status: "completed",
				output: { answer: "from child" },
			});
			const events = await journalEvents(fixture.storeRoot, runId);
			expect(
				countOf(
					events.map((e) => e.type),
					"task-invalidated",
				),
			).toBe(1);
			expect(runStatusChanges(events)).toContainEqual(
				expect.objectContaining({ from: "failed", to: "running" }),
			);
			expect(executionsCreated(events).map((e) => e.generation)).toEqual([
				1, 2,
			]);
			expect(second.ownerClient.launch).toHaveBeenCalledOnce();
			expect(finished.tasks?.[0]).toMatchObject({
				id: taskId,
				status: "completed",
				generation: 2,
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("refuses invalidation once the workflow deadline has passed", async () => {
		const fixture = await attemptWorkflowFixture();
		const { service, delegated, runId, taskId, first } =
			await settledAttemptRun(fixture, [
				{ status: "failed", failure: childFailure("manual") },
				{ status: "completed" },
			]);
		let resumed: WorkflowService | undefined;
		try {
			// The task failed on its own, inside the deadline.
			expect(first.status).toBe("failed");
			expect(first.tasks?.[0]).toMatchObject({ id: taskId, status: "failed" });
			const record = JSON.parse(
				await readFile(
					path.join(fixture.storeRoot, "runs", runId, "service.json"),
					"utf8",
				),
			) as WorkflowRunRecord;
			const deadlineAt = Date.parse(record.deadlineAt);
			expect(deadlineAt).toBeGreaterThan(Date.now());
			// Only the wall clock moves past the deadline. Real timers keep the
			// service, the test bounds, and fsync latency out of the assertion,
			// so a slow machine cannot turn this into a deadline cancellation.
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(deadlineAt + 1_000);

			// Owned and settled: the deadline is checked before anything is
			// appended, so the journal never gains a `task-invalidated`.
			await expectServiceError(
				service.invalidate(runId, taskId, "too late"),
				"validation",
				"Workflow run deadline has passed.",
			);
			const afterOwned = await eventTypes(fixture.storeRoot, runId);
			expect(countOf(afterOwned, "task-invalidated")).toBe(0);
			expect(countOf(afterOwned, "task-execution-created")).toBe(1);
			expect(delegated.ownerClient.launch).toHaveBeenCalledOnce();
			await expect(service.status(runId)).resolves.toMatchObject({
				status: "failed",
			});

			// Resumed by a fresh service: the run is composed and its initial
			// drive settles, then the same refusal applies.
			await bounded(service.shutdown(), "shutdown");
			const second = attemptProvider([{ status: "completed" }]);
			resumed = await createWorkflowService({
				...fixture,
				projectTrusted: () => true,
				subagents: second.provider,
			});
			await expectServiceError(
				resumed.invalidate(runId, taskId, "still too late"),
				"validation",
				"Workflow run deadline has passed.",
			);
			const afterResumed = await journalEvents(fixture.storeRoot, runId);
			expect(
				countOf(
					afterResumed.map((e) => e.type),
					"task-invalidated",
				),
			).toBe(0);
			expect(executionsCreated(afterResumed).map((e) => e.generation)).toEqual([
				1,
			]);
			expect(runStatusChanges(afterResumed)).not.toContainEqual(
				expect.objectContaining({ to: "running", from: "failed" }),
			);
			expect(second.ownerClient.launch).not.toHaveBeenCalled();
			await expect(
				bounded(resumed.wait(runId), "resumed wait"),
			).resolves.toMatchObject({ status: "failed" });
		} finally {
			vi.useRealTimers();
			await shutdownQuietly(service);
			await shutdownQuietly(resumed);
		}
	});

	it("refuses invalidation of a nested run", async () => {
		const fixture = await attemptWorkflowFixture();
		const failed = await settledAttemptRun(fixture, [
			{ status: "failed", failure: childFailure("manual") },
		]);
		expect(failed.first.status).toBe("failed");
		await bounded(failed.service.shutdown(), "first shutdown");
		const { runId, taskId } = failed;

		// The failed run is replayed into a fresh store root under a
		// child-shaped run record: depth 1 with a parent lineage block.
		let record: WorkflowRunRecord;
		let events: WorkflowJournalEvent[];
		const sourceLease = await acquireWorkflowRunLease({
			storeRoot: fixture.storeRoot,
			runId,
			ownerId: "replay",
		});
		try {
			const source = await WorkflowRunJournal.open(
				fixture.storeRoot,
				runId,
				sourceLease,
			);
			record = await WorkflowRunRecordStore.open(source).read();
			events = await source.readEvents();
		} finally {
			await sourceLease.release();
		}
		const parentRunId = `workflow_${randomUUID().replaceAll("-", "")}`;
		const parentTaskId = "task_parentnested";
		const nested: WorkflowRunRecord = {
			...record,
			depth: 1,
			parent: {
				runId: parentRunId,
				taskId: parentTaskId,
				executionId: deriveTaskExecutionId(parentRunId, parentTaskId, 1),
				ancestorDefinitionIdentities: ["9".repeat(64)],
				inputArtifacts: {},
			},
		};
		const storeRoot = path.join(fixture.cwd, ".pi", `workflow-${randomUUID()}`);
		const lease = await acquireWorkflowRunLease({
			storeRoot,
			runId,
			ownerId: "replay",
		});
		try {
			const journal = await WorkflowRunJournal.open(storeRoot, runId, lease);
			await WorkflowRunRecordStore.open(journal).create(nested);
			for (const event of events) {
				await journal.appendEvent({
					type: event.type,
					data: event.data,
				} as never);
			}
		} finally {
			await lease.release();
		}
		const durable = await stateOf(storeRoot, runId);
		expect(durable.status).toBe("failed");
		expect(durable.tasks[taskId]?.status).toBe("failed");

		const delegated = attemptProvider([{ status: "completed" }]);
		const service = await createWorkflowService({
			...fixture,
			storeRoot,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		try {
			await expect(service.status(runId)).resolves.toMatchObject({
				status: "failed",
				depth: 1,
				parent: { runId: parentRunId, taskId: parentTaskId },
				tasks: [expect.objectContaining({ id: taskId, status: "failed" })],
			});
			await expectServiceError(
				service.invalidate(runId, taskId, "operator re-run"),
				"validation",
				"Nested workflow runs are invalidated through their parent run.",
			);
			const types = await eventTypes(storeRoot, runId);
			expect(countOf(types, "task-invalidated")).toBe(0);
			expect(countOf(types, "task-execution-created")).toBe(1);
			expect(delegated.ownerClient.launch).not.toHaveBeenCalled();
			await expect(service.status(runId)).resolves.toMatchObject({
				status: "failed",
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("refuses a second invalidation while the restarted drive is still running", async () => {
		const fixture = await attemptWorkflowFixture();
		const delegated = attemptProvider([
			{ status: "failed", failure: childFailure("manual") },
			{ status: "completed" },
		]);
		const gate = deferred<void>();
		const entered = deferred<void>();
		const scripted = vi
			.mocked(delegated.ownerClient.wait)
			.getMockImplementation();
		let childWaits = 0;
		vi.mocked(delegated.ownerClient.wait).mockImplementation(
			async (...args) => {
				childWaits += 1;
				// The second generation's child blocks until the test releases it.
				if (childWaits === 2) {
					entered.resolve();
					await gate.promise;
				}
				if (!scripted) throw new Error("missing scripted child wait");
				return scripted(...args);
			},
		);
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		try {
			const receipt = await service.run("attempts", {});
			const runId = receipt.runId;
			await expect(
				bounded(service.wait(runId), "first wait"),
			).resolves.toMatchObject({ status: "failed" });
			const taskId = agentTaskOf(await stateOf(fixture.storeRoot, runId)).task
				.id;
			await bounded(service.invalidate(runId, taskId, "first"), "invalidate");
			await bounded(entered.promise, "second child wait entered");
			expect(childWaits).toBe(2);
			await expectServiceError(
				service.invalidate(runId, taskId, "second"),
				"conflict",
				"Workflow run is still being driven.",
			);
			gate.resolve();
			await expect(bounded(service.wait(runId), "wait")).resolves.toMatchObject(
				{ status: "completed" },
			);
			const types = await eventTypes(fixture.storeRoot, runId);
			expect(countOf(types, "task-invalidated")).toBe(1);
			expect(countOf(types, "task-execution-created")).toBe(2);
		} finally {
			gate.resolve();
			await shutdownQuietly(service);
		}
	});

	it("exposes frozen task views in materialization order across generations", async () => {
		const fixture = await attemptWorkflowFixture();
		const { service, runId, taskId, first } = await settledAttemptRun(fixture, [
			{ status: "failed", failure: childFailure("manual") },
			{ status: "completed" },
		]);
		try {
			expect(first.status).toBe("failed");
			const namespace = agentTaskOf(await stateOf(fixture.storeRoot, runId))
				.task.namespace;
			const failedView = await service.status(runId);
			expect(failedView.tasks).toEqual([
				{
					id: taskId,
					namespace: [...namespace],
					key: "answer",
					kind: "agent",
					role: "task",
					status: "failed",
					generation: 1,
				},
			]);
			expect(Object.isFrozen(failedView)).toBe(true);
			expect(Object.isFrozen(failedView.tasks)).toBe(true);
			expect(Object.isFrozen(failedView.tasks?.[0])).toBe(true);
			expect(Object.isFrozen(failedView.tasks?.[0]?.namespace)).toBe(true);
			expect(Object.keys(failedView.tasks?.[0] ?? {}).sort()).toEqual([
				"generation",
				"id",
				"key",
				"kind",
				"namespace",
				"role",
				"status",
			]);

			const invalidated = await bounded(
				service.invalidate(runId, taskId, "view check"),
				"invalidate",
			);
			expect(invalidated.tasks).toHaveLength(1);
			expect(invalidated.tasks?.[0]).toMatchObject({ id: taskId });
			expect(Object.isFrozen(invalidated.tasks)).toBe(true);

			const finished = await bounded(service.wait(runId), "wait");
			expect(finished.tasks).toEqual([
				{
					id: taskId,
					namespace: [...namespace],
					key: "answer",
					kind: "agent",
					role: "task",
					status: "completed",
					generation: 2,
				},
			]);
			expect(Object.keys(finished.tasks?.[0] ?? {})).not.toContain("abandoned");
			expect(Object.isFrozen(finished.tasks?.[0])).toBe(true);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("re-executes a failed required support task as generation 2 after invalidation", async () => {
		const fixture = await supportWorkflowFixture("support-invalidation");
		let executions = 0;
		const execute = vi.fn((_context: EmptyContext): { answer: string } => {
			executions += 1;
			if (executions === 1) throw new Error("first support attempt failed");
			return { answer: `support attempt ${executions}` };
		});
		const subagents = inertProvider();
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents,
			supportTasks: [flaky.registration(execute)],
		});
		try {
			const receipt = await service.run("support-invalidation", {
				value: "yes",
			});
			const runId = receipt.runId;
			const first = await bounded(service.wait(runId), "first wait");
			expect(first.status).toBe("failed");
			expect(execute).toHaveBeenCalledOnce();
			const failedState = await stateOf(fixture.storeRoot, runId);
			const supportTask = Object.values(failedState.tasks).find(
				(candidate) => candidate.task.spec.kind === "support",
			);
			if (!supportTask) throw new Error("missing support task");
			const taskId = supportTask.task.id;
			expect(supportTask.status).toBe("failed");
			expect(first.tasks?.[0]).toMatchObject({
				id: taskId,
				kind: "support",
				status: "failed",
				generation: 1,
			});

			const invalidated = await bounded(
				service.invalidate(runId, taskId, "support re-run"),
				"invalidate",
			);
			expect(["running", "waiting"]).toContain(invalidated.status);
			const finished = await bounded(service.wait(runId), "wait");
			expect(finished).toMatchObject({
				status: "completed",
				output: { answer: "support attempt 2" },
			});
			expect(execute).toHaveBeenCalledTimes(2);

			const events = await journalEvents(fixture.storeRoot, runId);
			expect(runStatusChanges(events)).toContainEqual(
				expect.objectContaining({ from: "failed", to: "running" }),
			);
			const created = executionsCreated(events);
			expect(created.map((e) => e.generation)).toEqual([1, 2]);
			expect(created[1]?.id).toBe(deriveTaskExecutionId(runId, taskId, 2));
			const state = reduceWorkflowEvents(events);
			const task = state.tasks[taskId];
			expect(task?.status).toBe("completed");
			expect(task?.currentExecutionId).toBe(
				deriveTaskExecutionId(runId, taskId, 2),
			);
			expect(task?.currentExecutionId).toMatch(EXECUTION_ID);
			const results = Object.values(state.artifacts).filter(
				(artifact) =>
					artifact.producerTaskId === taskId && artifact.output === "result",
			);
			expect(results).toHaveLength(1);
			expect(results[0]?.producerExecutionId).toBe(
				deriveTaskExecutionId(runId, taskId, 2),
			);
			expect(
				state.executions[deriveTaskExecutionId(runId, taskId, 1)]?.terminal,
			).toMatchObject({ outcome: "failed" });
			expect(finished.tasks).toEqual([
				expect.objectContaining({
					id: taskId,
					kind: "support",
					status: "completed",
					generation: 2,
				}),
			]);
		} finally {
			await shutdownQuietly(service);
		}
	});
});
