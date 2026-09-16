import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	TaskExecutionProjection,
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
import { reduceWorkflowEvents } from "../src/reducer.js";
import { createWorkflowService, type WorkflowService } from "../src/service.js";
import type { WorkflowSubagentProvider } from "../src/subagent-provider.js";

const INTERRUPTED_REASON =
	"Interrupted child retained for recovery; no release performed.";
const RUN_INTERRUPTED_REASON = "A required workflow task was interrupted.";
const REPAIR_REASON = "Repair terminal task projection after restart.";
const DRAINED_REASON = "Workflow stop drained all child work.";

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
		"test-interrupted-finalization",
		`${name}-${randomUUID()}`,
	);
}

async function until(predicate: () => boolean | Promise<boolean>) {
	while (!(await predicate())) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
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

async function shutdownQuietly(service: WorkflowService | undefined) {
	if (!service) return;
	await bounded(service.shutdown(), "shutdown").catch(() => undefined);
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

function strictClient(calls: string[]): SubagentClient {
	const client: Record<string, unknown> = {};
	for (const method of CLIENT_METHODS) {
		client[method] = vi.fn(async () => {
			calls.push(method);
			throw new Error(`unexpected subagent call: ${method}`);
		});
	}
	return client as unknown as SubagentClient;
}

interface AgentWorkflowOptions {
	readonly resume?: { attempts: number };
	/** Declares the agent task optional and returns a fallback output instead. */
	readonly optional?: boolean;
}

async function agentWorkflowFixture(
	name: string,
	options: AgentWorkflowOptions = {},
) {
	const base = root(name);
	const cwd = path.join(base, "project");
	const agentDir = path.join(base, "agent");
	const storeRoot = path.join(cwd, ".pi", "workflow");
	await mkdir(path.join(cwd, "workflows"), { recursive: true });
	const definitionPath = path.join(cwd, "workflows", `${name}.workflow.ts`);
	const request = `{
      agent: "researcher",
      task: { goal: "Answer", context: [], instructions: ["Return structured output."] },
      contextMode: "fresh",
      tools: ["read"],
      preloadSkills: [],
      contextScopes: ["project"],
      workspace: { mode: "read-only", cwd: ctx.cwd },
      outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
      ${options.resume ? `resume: ${JSON.stringify(options.resume)},` : ""}
      ${options.optional ? `disposition: "optional",` : ""}
      limits: { cumulativeRuntimeMs: 300000, attemptTimeoutMs: 300000, totalTokens: 1000000, cost: 10, outputBytes: 1024, workspaceWriteBytes: 0, retries: 0, resumes: ${options.resume?.attempts ?? 0} }
    }`;
	const body = options.optional
		? `ctx.agent("answer", ${request});
    return { answer: "fallback" };`
		: `return ctx.agent("answer", ${request});`;
	await writeFile(
		definitionPath,
		`export default {
  schema: "pi-workflow-definition",
  meta: { name: ${JSON.stringify(name)}, description: "Interrupted child workflow", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 3600000, concurrency: 1 },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  run(ctx) {
    ${body}
  }
};\n`,
	);
	return { cwd, agentDir, storeRoot, definitionPath };
}

type Fixture = Awaited<ReturnType<typeof agentWorkflowFixture>>;

type ChildFailure = NonNullable<RunResult["failure"]>;

function childFailure(retry: ChildFailure["retry"]): ChildFailure {
	return {
		code: "seat-interruption",
		origin: "provider",
		retry,
		message: "seat lost",
		guidance: "Resume when a seat is available.",
	};
}

interface ChildOutcome {
	readonly status: RunResult["status"];
	readonly failure?: ChildFailure;
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
			cost: 0,
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

function childIds(nonce: string, launch: number) {
	return {
		runId: `run_child${nonce}${launch}`,
		attemptId: `attempt_child${nonce}${launch}`,
	};
}

/**
 * Owner client for one fake agent child per launch. Successive `wait` calls
 * return `outcomes` in order (the last one repeats); `retry`/`resume` hand out
 * fresh attempt ids that `release` echoes back. Every method the runtime is
 * not expected to call records itself in `calls` and rejects.
 */
function childProvider(outcomes: readonly ChildOutcome[]) {
	const nonce = randomUUID().replaceAll("-", "").slice(0, 8);
	const child = { launches: 0, ...childIds(nonce, 0) };
	const calls: string[] = [];
	let ownerId = "";
	let waits = 0;
	let attempts = 1;
	const preflight = vi.fn(async (request: SubagentRequest) => {
		const planned = childIds(nonce, child.launches + 1);
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
				memoryBytes: request.memoryBytes ?? 536_870_912,
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
		const plan = { ...draft, ownerId };
		return {
			preflightId: "preflight-interrupted",
			identitySha256: canonicalSha256(plan),
			expiresAt: "2099-01-01T00:00:00.000Z",
			launchPlan: { ...plan, identitySha256: canonicalSha256(plan) },
		};
	});
	const nextAttempt = async (): Promise<RunReceipt> => {
		attempts += 1;
		child.attemptId = `${childIds(nonce, child.launches).attemptId}x${attempts}`;
		return { runId: child.runId, attemptId: child.attemptId, status: "active" };
	};
	const ownerClient = {
		...strictClient(calls),
		preflight,
		launch: vi.fn(async () => {
			child.launches += 1;
			Object.assign(child, childIds(nonce, child.launches));
			return {
				runId: child.runId,
				attemptId: child.attemptId,
				status: "active" as const,
			};
		}),
		wait: vi.fn(async () => {
			const outcome = outcomes[Math.min(waits, outcomes.length - 1)];
			if (!outcome) throw new Error("no child outcome scripted");
			waits += 1;
			return childResult(outcome, child.runId);
		}),
		release: vi.fn(async () => ({
			runId: child.runId,
			attemptId: child.attemptId,
			status: "completed" as const,
		})),
		retry: vi.fn(nextAttempt),
		resume: vi.fn(nextAttempt),
		interrupt: vi.fn(async () => {
			throw new Error("unexpected interrupt");
		}),
		abandon: vi.fn(async () => {
			throw new Error("unexpected abandon");
		}),
	} as unknown as SubagentClient;
	const bind = vi.fn(async (runId: string) => {
		ownerId = `pi-workflow:${runId}`;
		return { workflowRunId: runId, ownerId, client: ownerClient };
	});
	return {
		provider: { bind } as WorkflowSubagentProvider,
		ownerClient,
		child,
		calls,
	};
}

type Delegated = ReturnType<typeof childProvider>;

async function serviceFor(
	fx: Fixture,
	delegated: Delegated,
): Promise<WorkflowService> {
	return createWorkflowService({
		...fx,
		projectTrusted: () => true,
		subagents: delegated.provider,
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

async function stateOf(
	storeRoot: string,
	runId: string,
): Promise<WorkflowStateProjection> {
	return reduceWorkflowEvents(await journalEvents(storeRoot, runId));
}

function countOf(types: readonly string[], type: string): number {
	return types.filter((candidate) => candidate === type).length;
}

function runStatusChanges(events: readonly WorkflowJournalEvent[]) {
	return events
		.filter((event) => event.type === "run-status-changed")
		.map(
			(event) => event.data as { from: string; to: string; reason?: string },
		);
}

function taskStatusChanges(events: readonly WorkflowJournalEvent[]) {
	return events
		.filter((event) => event.type === "task-status-changed")
		.map(
			(event) =>
				event.data as {
					taskId: string;
					from: string;
					to: string;
					reason?: string;
				},
		);
}

function executionsCreated(events: readonly WorkflowJournalEvent[]) {
	return events
		.filter((event) => event.type === "task-execution-created")
		.map(
			(event) =>
				(
					event.data as {
						execution: { id: string; taskId: string; generation: number };
					}
				).execution,
		);
}

function agentTaskOf(state: WorkflowStateProjection): WorkflowTaskProjection {
	const task = Object.values(state.tasks).find(
		(candidate) => candidate.task.spec.kind === "agent" && !candidate.abandoned,
	);
	if (!task) throw new Error("missing agent task");
	return task;
}

function currentExecutionOf(
	state: WorkflowStateProjection,
	task: WorkflowTaskProjection,
): TaskExecutionProjection {
	const execution = task.currentExecutionId
		? state.executions[task.currentExecutionId]
		: undefined;
	if (!execution)
		throw new Error(`missing execution for ${task.task.spec.key}`);
	return execution;
}

/** The release/abandon side effects the retained child must never receive. */
function expectChildRetained(delegated: Delegated): void {
	expect(delegated.ownerClient.release).not.toHaveBeenCalled();
	expect(delegated.ownerClient.abandon).not.toHaveBeenCalled();
	expect(delegated.calls).toEqual([]);
}

/**
 * Asserts the execution ended `interrupted` straight from its settlement: a
 * terminal with the settlement as evidence, no release intent, and no release.
 */
function expectInterruptedWithoutRelease(
	events: readonly WorkflowJournalEvent[],
	execution: TaskExecutionProjection,
): void {
	expect(execution.phase).toBe("terminal");
	expect(execution.terminal).toMatchObject({
		outcome: "interrupted",
		evidence: { kind: "subagent", status: "interrupted" },
	});
	expect(execution.terminal?.evidence).toEqual(execution.settlement?.evidence);
	expect(execution.releaseIntent).toBeUndefined();
	expect(execution.release).toBeUndefined();
	const types = events
		.filter(
			(event) =>
				(event.data as { executionId?: string }).executionId ===
				execution.execution.id,
		)
		.map((event) => event.type);
	expect(countOf(types, "task-execution-release-intended")).toBe(0);
	expect(countOf(types, "task-execution-released")).toBe(0);
	const settled = types.lastIndexOf("task-execution-child-settled");
	const terminal = types.lastIndexOf("task-execution-terminal");
	expect(settled).toBeGreaterThanOrEqual(0);
	expect(terminal).toBeGreaterThan(settled);
	// Nothing but a declined or receipted attempt may sit between the settlement
	// and the terminal; in particular no release ladder.
	expect(
		types
			.slice(settled + 1, terminal)
			.every((type) => type.startsWith("task-execution-attempt-")),
	).toBe(true);
}

/** Drives the required agent workflow until its child is retained interrupted. */
async function interruptedRun(name: string) {
	const fx = await agentWorkflowFixture(name);
	const delegated = childProvider([
		{ status: "interrupted", failure: childFailure("resume") },
		{ status: "completed" },
	]);
	const service = await serviceFor(fx, delegated);
	const receipt = await service.run(name, {});
	const first = await bounded(service.wait(receipt.runId), "first wait");
	const state = await stateOf(fx.storeRoot, receipt.runId);
	const task = agentTaskOf(state);
	return {
		fx,
		delegated,
		service,
		runId: receipt.runId,
		taskId: task.task.id,
		first,
		state,
	};
}

/**
 * Simulates a process crash whose journal ends after event `keep - 1`: the
 * durable run directory is copied into a fresh store root, the journal is cut
 * to its first `keep` records, and the snapshot (which would otherwise cover
 * records the cut removed) is dropped.
 */
async function cutJournal(
	fx: { cwd: string; storeRoot: string },
	runId: string,
	keep: number,
): Promise<string> {
	const storeRoot = path.join(fx.cwd, ".pi", `workflow-${randomUUID()}`);
	const setup = await acquireWorkflowRunLease({
		storeRoot,
		runId,
		ownerId: "setup",
	});
	await setup.release();
	await mkdir(path.join(storeRoot, "runs"), { recursive: true, mode: 0o700 });
	const target = path.join(storeRoot, "runs", runId);
	await cp(path.join(fx.storeRoot, "runs", runId), target, {
		recursive: true,
	});
	const lines = (await readFile(path.join(target, "events.jsonl"), "utf8"))
		.split("\n")
		.filter((line) => line.length > 0);
	if (keep < 1 || keep > lines.length) {
		throw new Error(`cannot keep ${keep} of ${lines.length} journal records`);
	}
	await writeFile(
		path.join(target, "events.jsonl"),
		`${lines.slice(0, keep).join("\n")}\n`,
	);
	await rm(path.join(target, "run.json"), { force: true });
	return storeRoot;
}

/** Appends one event through the validating journal of an idle run. */
async function appendDirectly(
	storeRoot: string,
	runId: string,
	type: WorkflowJournalEvent["type"],
	data: unknown,
): Promise<unknown> {
	const lease = await acquireWorkflowRunLease({
		storeRoot,
		runId,
		ownerId: "operator",
	});
	try {
		const journal = await WorkflowRunJournal.open(storeRoot, runId, lease);
		return await journal.appendEvent({ type, data } as never).then(
			() => undefined,
			(error: unknown) => error,
		);
	} finally {
		await lease.release();
	}
}

describe("interrupted child finalization", () => {
	it("retains an interrupted required child without release and recovers through invalidation", async () => {
		const run = await interruptedRun("required-interrupted");
		const { fx, delegated, service, runId, taskId } = run;
		try {
			// The drive ends in a durable terminal state, so `wait` resolves.
			expect(run.first.status).toBe("interrupted");
			expect(run.first.tasks).toEqual([
				expect.objectContaining({
					id: taskId,
					kind: "agent",
					role: "task",
					status: "interrupted",
					generation: 1,
				}),
			]);
			const events = await journalEvents(fx.storeRoot, runId);
			const state = reduceWorkflowEvents(events);
			expect(state.status).toBe("interrupted");
			const task = state.tasks[taskId];
			expect(task?.status).toBe("interrupted");
			const execution = currentExecutionOf(state, agentTaskOf(state));
			expect(execution.execution.id).toBe(
				deriveTaskExecutionId(runId, taskId, 1),
			);
			expectInterruptedWithoutRelease(events, execution);
			expect(execution.attempts ?? []).toHaveLength(0);
			expect(execution.terminal?.evidence).toMatchObject({
				attemptOrdinal: 1,
				failure: { retry: "resume" },
			});

			const types = events.map((event) => event.type);
			expect(countOf(types, "task-execution-attempt-intended")).toBe(0);
			const taskChanges = taskStatusChanges(events).filter(
				(change) => change.taskId === taskId,
			);
			expect(taskChanges.at(-1)).toMatchObject({
				to: "interrupted",
				reason: INTERRUPTED_REASON,
			});
			expect(["running", "waiting"]).toContain(taskChanges.at(-1)?.from);
			expect(runStatusChanges(events).at(-1)).toMatchObject({
				to: "interrupted",
				reason: RUN_INTERRUPTED_REASON,
			});
			expect(["running", "waiting"]).toContain(
				runStatusChanges(events).at(-1)?.from,
			);
			expectChildRetained(delegated);
			expect(delegated.ownerClient.resume).not.toHaveBeenCalled();
			expect(delegated.ownerClient.retry).not.toHaveBeenCalled();
			expect(delegated.ownerClient.interrupt).not.toHaveBeenCalled();
			expect(delegated.ownerClient.launch).toHaveBeenCalledOnce();
			const firstChild = delegated.child.runId;
			expect(execution.launchReceipt?.subagentRunId).toBe(firstChild);

			// Recovery: invalidation re-executes the task as a fresh generation.
			const invalidated = await bounded(
				service.invalidate(runId, taskId, "operator re-run"),
				"invalidate",
			);
			expect(invalidated.status).not.toBe("interrupted");
			const finished = await bounded(service.wait(runId), "wait");
			expect(finished).toMatchObject({
				status: "completed",
				output: { answer: "from child" },
			});
			const recovered = await journalEvents(fx.storeRoot, runId);
			expect(runStatusChanges(recovered)).toContainEqual(
				expect.objectContaining({ from: "interrupted", to: "running" }),
			);
			expect(executionsCreated(recovered).map((e) => e.generation)).toEqual([
				1, 2,
			]);
			expect(delegated.ownerClient.launch).toHaveBeenCalledTimes(2);
			expect(
				vi
					.mocked(delegated.ownerClient.preflight)
					.mock.calls.map(([request]) => request.operationId),
			).toEqual([
				deriveSubagentOperationId(runId, taskId, 1),
				deriveSubagentOperationId(runId, taskId, 2),
			]);
			const secondChild = delegated.child.runId;
			expect(secondChild).not.toBe(firstChild);
			// Only the fresh child is ever released; the interrupted one is
			// neither released nor abandoned.
			expect(vi.mocked(delegated.ownerClient.release).mock.calls).toEqual([
				[secondChild],
			]);
			expect(delegated.ownerClient.abandon).not.toHaveBeenCalled();
			expect(delegated.ownerClient.resume).not.toHaveBeenCalled();
			expect(delegated.calls).toEqual([]);
			const recoveredState = reduceWorkflowEvents(recovered);
			const generation1 =
				recoveredState.executions[deriveTaskExecutionId(runId, taskId, 1)];
			expect(generation1).toBeDefined();
			expectInterruptedWithoutRelease(
				recovered,
				generation1 as TaskExecutionProjection,
			);
			expect(generation1?.launchReceipt?.subagentRunId).toBe(firstChild);
			const generation2 =
				recoveredState.executions[deriveTaskExecutionId(runId, taskId, 2)];
			expect(generation2).toMatchObject({
				phase: "terminal",
				terminal: { outcome: "completed" },
			});
			expect(generation2?.launchReceipt?.subagentRunId).toBe(secondChild);
			expect(finished.tasks).toEqual([
				expect.objectContaining({
					id: taskId,
					status: "completed",
					generation: 2,
				}),
			]);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("keeps an interrupted optional child without release and completes the run degraded", async () => {
		const fx = await agentWorkflowFixture("optional-interrupted", {
			optional: true,
		});
		const delegated = childProvider([
			{ status: "interrupted", failure: childFailure("resume") },
		]);
		const service = await serviceFor(fx, delegated);
		try {
			const receipt = await service.run("optional-interrupted", {});
			const finished = await bounded(service.wait(receipt.runId), "wait");
			expect(finished).toMatchObject({
				status: "completed-degraded",
				output: { answer: "fallback" },
			});
			const events = await journalEvents(fx.storeRoot, receipt.runId);
			const state = reduceWorkflowEvents(events);
			const task = agentTaskOf(state);
			expect(task.task.spec.disposition).toBe("optional");
			expect(task.status).toBe("interrupted");
			expectInterruptedWithoutRelease(events, currentExecutionOf(state, task));
			expect(taskStatusChanges(events).at(-1)).toMatchObject({
				taskId: task.task.id,
				to: "interrupted",
				reason: INTERRUPTED_REASON,
			});
			// An optional interruption never changes the run status on its own.
			const changes = runStatusChanges(events);
			expect(changes.some((change) => change.to === "interrupted")).toBe(false);
			expect(changes.some((change) => change.to === "failed")).toBe(false);
			expect(changes.at(-1)).toEqual({
				from: "finalizing",
				to: "completed-degraded",
			});
			expectChildRetained(delegated);
			expect(delegated.ownerClient.resume).not.toHaveBeenCalled();
			expect(finished.tasks).toEqual([
				expect.objectContaining({
					id: task.task.id,
					role: "task",
					status: "interrupted",
					generation: 1,
				}),
			]);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("retains the child after the resume policy is exhausted", async () => {
		const fx = await agentWorkflowFixture("resume-exhausted", {
			resume: { attempts: 1 },
		});
		const delegated = childProvider([
			{ status: "interrupted", failure: childFailure("resume") },
			{ status: "interrupted", failure: childFailure("resume") },
		]);
		const service = await serviceFor(fx, delegated);
		try {
			const receipt = await service.run("resume-exhausted", {});
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({ status: "interrupted" });
			expect(delegated.ownerClient.launch).toHaveBeenCalledOnce();
			expect(delegated.ownerClient.resume).toHaveBeenCalledOnce();
			expect(delegated.ownerClient.resume).toHaveBeenCalledWith(
				delegated.child.runId,
			);
			expect(delegated.ownerClient.retry).not.toHaveBeenCalled();
			expect(delegated.ownerClient.wait).toHaveBeenCalledTimes(2);
			expectChildRetained(delegated);

			const events = await journalEvents(fx.storeRoot, receipt.runId);
			const types = events.map((event) => event.type);
			expect(countOf(types, "task-execution-child-settled")).toBe(2);
			expect(countOf(types, "task-execution-attempt-intended")).toBe(1);
			expect(countOf(types, "task-execution-attempt-receipted")).toBe(1);
			expect(countOf(types, "task-execution-attempt-declined")).toBe(0);
			const intent = events.find(
				(event) => event.type === "task-execution-attempt-intended",
			);
			expect(intent?.data).toMatchObject({
				kind: "resume",
				ordinal: 2,
				failureRetry: "resume",
				origin: "policy",
			});
			expect(intent?.data).not.toHaveProperty("reason");

			const state = reduceWorkflowEvents(events);
			const task = agentTaskOf(state);
			expect(task.status).toBe("interrupted");
			const execution = currentExecutionOf(state, task);
			expectInterruptedWithoutRelease(events, execution);
			expect(execution.attempts).toHaveLength(1);
			expect(execution.attempts?.[0]).toMatchObject({
				kind: "resume",
				ordinal: 2,
				origin: "policy",
				receiptSequence: expect.any(Number),
			});
			expect(execution.attempts?.[0]).not.toHaveProperty("reason");
			expect(execution.priorSettlements).toHaveLength(1);
			expect(execution.priorSettlements?.[0]?.evidence).toMatchObject({
				status: "interrupted",
				attemptOrdinal: 1,
			});
			expect(execution.terminal?.evidence).toMatchObject({
				status: "interrupted",
				attemptOrdinal: 2,
			});
			expect(taskStatusChanges(events).at(-1)).toMatchObject({
				to: "interrupted",
				reason: INTERRUPTED_REASON,
			});
			expect(runStatusChanges(events).at(-1)).toMatchObject({
				to: "interrupted",
				reason: RUN_INTERRUPTED_REASON,
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("drains a stop to cancelled when the interrupted child is retained", async () => {
		const fx = await agentWorkflowFixture("stop-interrupted");
		const delegated = childProvider([
			{ status: "interrupted", failure: childFailure("never") },
		]);
		const entered = deferred<void>();
		const terminal = deferred<void>();
		const scripted = vi
			.mocked(delegated.ownerClient.wait)
			.getMockImplementation();
		vi.mocked(delegated.ownerClient.wait).mockImplementation(
			async (...args) => {
				entered.resolve();
				await terminal.promise;
				if (!scripted) throw new Error("missing scripted child wait");
				return scripted(...args);
			},
		);
		// The interrupt races a child that is already ending `interrupted`: the
		// receipt still reports the launched status (so no `stopping` observation
		// is recorded, which could only be followed by `cancelled`) and the next
		// wait settles the child as interrupted.
		vi.mocked(delegated.ownerClient.interrupt).mockImplementation(async () => ({
			runId: delegated.child.runId,
			attemptId: delegated.child.attemptId,
			status: "active" as const,
		}));
		const service = await serviceFor(fx, delegated);
		try {
			const receipt = await service.run("stop-interrupted", {});
			await bounded(entered.promise, "child wait entered");
			const stopping = bounded(
				service.stop(receipt.runId, "operator stop"),
				"stop",
			);
			await until(
				() => vi.mocked(delegated.ownerClient.interrupt).mock.calls.length > 0,
			);
			terminal.resolve();
			await expect(stopping).resolves.toMatchObject({ status: "cancelled" });
			expect(delegated.ownerClient.interrupt).toHaveBeenCalledOnce();
			expect(delegated.ownerClient.interrupt).toHaveBeenCalledWith(
				delegated.child.runId,
			);
			expectChildRetained(delegated);

			const events = await journalEvents(fx.storeRoot, receipt.runId);
			const state = reduceWorkflowEvents(events);
			expect(state.status).toBe("cancelled");
			const task = agentTaskOf(state);
			expect(task.status).toBe("interrupted");
			expectInterruptedWithoutRelease(events, currentExecutionOf(state, task));
			const changes = runStatusChanges(events);
			expect(changes).toContainEqual(
				expect.objectContaining({ to: "stopping", reason: "operator stop" }),
			);
			expect(changes.at(-1)).toMatchObject({
				from: "stopping",
				to: "cancelled",
			});
			expect([DRAINED_REASON, "operator stop"]).toContain(
				changes.at(-1)?.reason,
			);
			const taskChanges = taskStatusChanges(events).filter(
				(change) => change.taskId === task.task.id,
			);
			expect(taskChanges.at(-2)).toMatchObject({ to: "cancelling" });
			expect(taskChanges.at(-1)).toMatchObject({
				from: "cancelling",
				to: "interrupted",
				reason: INTERRUPTED_REASON,
			});
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({ status: "cancelled" });
			await expect(service.status(receipt.runId)).resolves.toMatchObject({
				status: "cancelled",
				tasks: [expect.objectContaining({ status: "interrupted" })],
			});
		} finally {
			terminal.resolve();
			await shutdownQuietly(service);
		}
	});

	it("repairs the interrupted task projection after a restart between the terminal and status events", async () => {
		const run = await interruptedRun("restart-repair");
		const { fx, runId, taskId } = run;
		expect(run.first.status).toBe("interrupted");
		await bounded(run.service.shutdown(), "first shutdown");
		const events = await journalEvents(fx.storeRoot, runId);
		const terminal = events.findLastIndex(
			(event) => event.type === "task-execution-terminal",
		);
		expect(terminal).toBeGreaterThan(0);
		expect(events.slice(terminal + 1).map((event) => event.type)).toEqual([
			"task-status-changed",
			"run-status-changed",
		]);
		const storeRoot = await cutJournal(fx, runId, terminal + 1);
		const cut = await stateOf(storeRoot, runId);
		expect(["running", "waiting"]).toContain(cut.status);
		const cutTask = cut.tasks[taskId];
		expect(["running", "waiting"]).toContain(cutTask?.status);
		expect(
			cutTask ? currentExecutionOf(cut, cutTask) : undefined,
		).toMatchObject({
			phase: "terminal",
			terminal: { outcome: "interrupted" },
		});

		const second = childProvider([]);
		const service = await createWorkflowService({
			...fx,
			storeRoot,
			projectTrusted: () => true,
			subagents: second.provider,
		});
		try {
			const finished = await bounded(service.wait(runId), "wait");
			expect(finished.status).toBe("interrupted");
			expect(finished.tasks).toEqual([
				expect.objectContaining({
					id: taskId,
					status: "interrupted",
					generation: 1,
				}),
			]);
			// Repair is a projection fix: no subagent call of any kind.
			expect(second.ownerClient.preflight).not.toHaveBeenCalled();
			expect(second.ownerClient.launch).not.toHaveBeenCalled();
			expect(second.ownerClient.wait).not.toHaveBeenCalled();
			expect(second.ownerClient.resume).not.toHaveBeenCalled();
			expectChildRetained(second);
			const recovered = await journalEvents(storeRoot, runId);
			const appended = recovered.slice(terminal + 1);
			expect(appended.map((event) => event.type)).toContain(
				"task-status-changed",
			);
			expect(taskStatusChanges(appended)).toContainEqual({
				taskId,
				from: cutTask?.status,
				to: "interrupted",
				reason: REPAIR_REASON,
			});
			expect(runStatusChanges(recovered).at(-1)).toMatchObject({
				to: "interrupted",
				reason: RUN_INTERRUPTED_REASON,
			});
			const state = reduceWorkflowEvents(recovered);
			expect(state.status).toBe("interrupted");
			expectInterruptedWithoutRelease(
				recovered,
				currentExecutionOf(state, agentTaskOf(state)),
			);
			expect(
				countOf(
					recovered.map((e) => e.type),
					"task-execution-terminal",
				),
			).toBe(1);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("rejects a hand-appended release intent on the interrupted execution", async () => {
		const run = await interruptedRun("release-rejected");
		const { fx, runId, taskId } = run;
		expect(run.first.status).toBe("interrupted");
		await bounded(run.service.shutdown(), "first shutdown");
		const events = await journalEvents(fx.storeRoot, runId);
		const execution = currentExecutionOf(run.state, agentTaskOf(run.state));
		const subagentRunId = execution.launchReceipt?.subagentRunId;
		expect(subagentRunId).toBe(run.delegated.child.runId);
		const intent = {
			executionId: deriveTaskExecutionId(runId, taskId, 1),
			subagentRunId,
		};

		// At phase `settled` (a crash right after the interrupted settlement) the
		// release rule itself refuses the interrupted child.
		const settledIndex = events.findLastIndex(
			(event) => event.type === "task-execution-child-settled",
		);
		expect(settledIndex).toBeGreaterThan(0);
		const settledRoot = await cutJournal(fx, runId, settledIndex + 1);
		const settled = await stateOf(settledRoot, runId);
		expect(currentExecutionOf(settled, agentTaskOf(settled))).toMatchObject({
			phase: "settled",
			settlement: { evidence: { status: "interrupted" } },
		});
		const settledRejection = await appendDirectly(
			settledRoot,
			runId,
			"task-execution-release-intended",
			intent,
		);
		expect(settledRejection).toBeInstanceOf(Error);
		expect((settledRejection as Error).message).toBe(
			"workflow journal event violates run invariants",
		);
		expect((settledRejection as Error).cause).toBeInstanceOf(Error);
		expect(((settledRejection as Error).cause as Error).message).toMatch(
			/^interrupted child is not releasable( at workflow event sequence \d+)?$/,
		);
		expect(await journalEvents(settledRoot, runId)).toHaveLength(
			settledIndex + 1,
		);

		// Once terminalized `interrupted`, the execution admits no release intent
		// either; the journal stays exactly as the finalizer left it.
		const terminalRejection = await appendDirectly(
			fx.storeRoot,
			runId,
			"task-execution-release-intended",
			intent,
		);
		expect(terminalRejection).toBeInstanceOf(Error);
		expect((terminalRejection as Error).message).toBe(
			"workflow journal event violates run invariants",
		);
		expect(await journalEvents(fx.storeRoot, runId)).toEqual(events);
		expect((await stateOf(fx.storeRoot, runId)).status).toBe("interrupted");
		expectChildRetained(run.delegated);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});
