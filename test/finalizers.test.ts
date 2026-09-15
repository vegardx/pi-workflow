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
import { type Static, type TSchema, Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowArtifactStore } from "../src/artifact-store.js";
import { defineWorkflow } from "../src/definition.js";
import type {
	WorkflowStateProjection,
	WorkflowTaskProjection,
} from "../src/events.js";
import { deriveTaskExecutionId } from "../src/execution.js";
import {
	type WorkflowJournalEvent,
	WorkflowRunJournal,
} from "../src/persistence/journal.js";
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
	createWorkflowService,
	type WorkflowService,
	WorkflowServiceError,
} from "../src/service.js";
import {
	createStaticWorkflowRuntime,
	StaticWorkflowRuntimeError,
} from "../src/static-runtime.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";
import {
	defineSupportTask,
	type SupportTaskExecutionContext,
} from "../src/support.js";

const TOOLS_MODULE = "@vegardx/workflow-tools";
const EMPTY_SCHEMA = Type.Object({});
const ANSWER_SCHEMA = Type.Object({ answer: Type.String() });
type EmptyContext = SupportTaskExecutionContext<Static<typeof EMPTY_SCHEMA>>;
type UpperContext = SupportTaskExecutionContext<{ value: string }>;

const REQUIRED_TASK_REASON = "A required workflow task did not complete.";
const FINALIZATION_FAILED_REASON = "Workflow output finalization failed.";
const DEPENDENCY_BLOCKED_REASON =
	"A workflow task dependency did not complete successfully.";
const SOURCE_FAILED_REASON = "Static workflow source execution failed.";
const REPAIR_REASON = "Repair terminal task projection after restart.";

function tool<TParametersSchema extends TSchema>(
	name: string,
	digit: string,
	parametersSchema: TParametersSchema,
) {
	return defineSupportTask({
		name: `${TOOLS_MODULE}/${name}`,
		moduleSpecifier: TOOLS_MODULE,
		revision: 1,
		implementationSha256: digit.repeat(64),
		parametersSchema,
		outputSchema: ANSWER_SCHEMA,
	});
}

const upper = tool("upper", "a", Type.Object({ value: Type.String() }));
const boom = tool("boom", "c", EMPTY_SCHEMA);
const mark = tool("mark", "e", EMPTY_SCHEMA);
const HELPERS = { boom, mark, upper } as const;

const upperExecute = ({ parameters }: UpperContext) => ({
	answer: parameters.value.toUpperCase(),
});
const markExecute = (_context: EmptyContext) => ({ answer: "cleaned" });
const boomExecute = (_context: EmptyContext): { answer: string } => {
	throw new Error("kaboom");
};

function root(name: string): string {
	return path.resolve(".pi", "test-finalizers", `${name}-${randomUUID()}`);
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

/** A provider whose client rejects every call; support-only runs never delegate. */
function inertProvider(calls: string[] = []): WorkflowSubagentProvider {
	return {
		bind: vi.fn(
			async (runId: string) =>
				({
					workflowRunId: runId,
					ownerId: `pi-workflow:${runId}`,
					client: strictClient(calls),
				}) satisfies WorkflowSubagentBinding,
		),
	};
}

type ChildFailure = NonNullable<RunResult["failure"]>;

function childFailure(retry: ChildFailure["retry"]): ChildFailure {
	return {
		code: "provider-transient",
		origin: "provider",
		retry,
		message: "provider hiccup",
		guidance: "Try again later.",
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
 * Owner client for one agent child per launch whose successive `wait` calls
 * return `outcomes` in order (the last one repeats) and whose `retry`/`resume`
 * hand out fresh attempt ids that `release` echoes back.
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
		const plan = { ...draft, ownerId };
		return {
			preflightId: "preflight-finalizers",
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
    ...(call.after ? { after: call.after } : {}),
    ...("disposition" in call ? { disposition: call.disposition } : {}),
  });
}
${exported.join("\n")}
`;
}

function agentRequest(
	options: { retries?: number; extra?: string } = {},
): string {
	return `{
      agent: "researcher",
      task: { goal: "Clean up", context: [], instructions: ["Return structured output."] },
      contextMode: "fresh",
      tools: ["read"],
      preloadSkills: [],
      contextScopes: ["project"],
      workspace: { mode: "read-only", cwd: ctx.cwd },
      outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
      limits: { cumulativeRuntimeMs: 300000, attemptTimeoutMs: 300000, totalTokens: 1000000, cost: 10, outputBytes: 1024, workspaceWriteBytes: 0, retries: ${options.retries ?? 0}, resumes: 0 }${options.extra ?? ""}
    }`;
}

function workflow(
	name: string,
	body: string,
	options: { concurrency?: number } = {},
): string {
	return `import { boom, mark, upper } from ${JSON.stringify(TOOLS_MODULE)};
export default {
  schema: "pi-workflow-definition",
  meta: { name: ${JSON.stringify(name)}, description: "Finalizer workflow", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 600000, concurrency: ${options.concurrency ?? 1} },
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  async run(ctx) {
    ${body}
  }
};
`;
}

/** Logs the declaration rejection durably, then fails the run with it. */
function refusing(name: string, declare: string): string {
	return workflow(
		name,
		`try {
      ${declare}
    } catch (error) {
      ctx.log(error.message);
      throw error;
    }
    return { answer: "unreachable" };`,
	);
}

async function fixture(name: string, source: string) {
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
	const definitionPath = path.join(cwd, "workflows", `${name}.workflow.ts`);
	await writeFile(definitionPath, source);
	return { cwd, agentDir, storeRoot, definitionPath };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const ALL_SUPPORT = () => [
	upper.registration(upperExecute),
	boom.registration(boomExecute),
	mark.registration(markExecute),
];

async function serviceFor(
	fx: Fixture & { storeRoot: string },
	subagents: WorkflowSubagentProvider,
	supportTasks = ALL_SUPPORT(),
): Promise<WorkflowService> {
	return createWorkflowService({
		...fx,
		projectTrusted: () => true,
		subagents,
		supportTasks,
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

async function shutdownQuietly(service: WorkflowService | undefined) {
	if (!service) return;
	await bounded(service.shutdown(), "shutdown").catch(() => undefined);
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

function runReasons(events: readonly WorkflowJournalEvent[]): string[] {
	return runStatusChanges(events).flatMap((change) =>
		change.reason === undefined ? [] : [change.reason],
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
						execution: {
							kind: string;
							id: string;
							taskId: string;
							generation: number;
						};
					}
				).execution,
		);
}

function outputArtifactsDeclared(events: readonly WorkflowJournalEvent[]) {
	return events.filter(
		(event) =>
			event.type === "artifact-declared" &&
			(event.data as { artifact: { producerTaskId?: string } }).artifact
				.producerTaskId === undefined,
	);
}

function logsOf(state: WorkflowStateProjection): readonly string[] {
	return state.effects
		.filter((effect) => effect.kind === "log")
		.map((effect) => effect.value);
}

function taskByKey(
	state: WorkflowStateProjection,
	key: string,
): WorkflowTaskProjection {
	const task = Object.values(state.tasks).find(
		(candidate) => candidate.task.spec.key === key && !candidate.abandoned,
	);
	if (!task) throw new Error(`missing task ${key}`);
	return task;
}

function indexOfEvent(
	events: readonly WorkflowJournalEvent[],
	predicate: (event: WorkflowJournalEvent) => boolean,
	label: string,
): number {
	const index = events.findIndex(predicate);
	if (index < 0) throw new Error(`missing event: ${label}`);
	return index;
}

function isRunStatusChange(
	event: WorkflowJournalEvent,
	from: string,
	to: string,
): boolean {
	if (event.type !== "run-status-changed") return false;
	const data = event.data as { from: string; to: string };
	return data.from === from && data.to === to;
}

/**
 * Condenses a journal event into the tuple the spec's happy-path walk-through
 * names it by: type plus the identifying task key, transition, or outcome.
 */
function summarize(
	state: WorkflowStateProjection,
	event: WorkflowJournalEvent,
): readonly string[] {
	const keyOf = (taskId: string | undefined) =>
		taskId === undefined
			? "output"
			: (state.tasks[taskId]?.task.spec.key ?? "?");
	switch (event.type) {
		case "run-status-changed": {
			const data = event.data as { from: string; to: string };
			return [event.type, data.from, data.to];
		}
		case "task-status-changed": {
			const data = event.data as { taskId: string; from: string; to: string };
			return [event.type, keyOf(data.taskId), data.from, data.to];
		}
		case "artifact-declared": {
			const data = event.data as { artifact: { producerTaskId?: string } };
			return [event.type, keyOf(data.artifact.producerTaskId)];
		}
		case "task-execution-created": {
			const data = event.data as {
				execution: { kind: string; taskId: string };
			};
			return [event.type, data.execution.kind, keyOf(data.execution.taskId)];
		}
		case "task-execution-terminal": {
			const data = event.data as { outcome: string };
			return [event.type, data.outcome];
		}
		default:
			return [event.type];
	}
}

async function expectServiceError(
	promise: Promise<unknown>,
	code: WorkflowServiceError["code"],
	message: string,
): Promise<void> {
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
	expect(error.code).toBe(code);
	// Reducer rejections carry the offending sequence after the rule message.
	const escaped = message.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
	expect(error.message).toMatch(
		new RegExp(`^${escaped}( at workflow event sequence \\d+)?$`),
	);
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

const REPORT = `const report = ctx.support("report", upper({ parameters: { value: ctx.input.value } }));`;

describe("finalizers", () => {
	it("drives a required support finalizer after the output commit in spec order", async () => {
		const fx = await fixture(
			"happy-path",
			workflow(
				"happy-path",
				`${REPORT}
    ctx.finalize("cleanup", { kind: "required", support: mark({ parameters: {} }) });
    return report;`,
			),
		);
		const cleanupExecute = vi.fn(markExecute);
		const reportExecute = vi.fn(upperExecute);
		const service = await serviceFor(fx, inertProvider(), [
			upper.registration(reportExecute),
			mark.registration(cleanupExecute),
		]);
		try {
			const receipt = await service.run("happy-path", { value: "yes" });
			const finished = await bounded(service.wait(receipt.runId), "wait");
			// The finalizer's own result never replaces the committed output.
			expect(finished).toMatchObject({
				status: "completed",
				output: { answer: "YES" },
			});
			expect(reportExecute).toHaveBeenCalledTimes(1);
			expect(cleanupExecute).toHaveBeenCalledTimes(1);

			const events = await journalEvents(fx.storeRoot, receipt.runId);
			const state = reduceWorkflowEvents(events);
			const report = taskByKey(state, "report");
			const cleanup = taskByKey(state, "cleanup");
			expect(report.task.spec).toMatchObject({
				kind: "support",
				role: "task",
				disposition: "required",
			});
			expect(cleanup.task.spec).toMatchObject({
				kind: "support",
				role: "finalizer",
				disposition: "required",
			});
			expect(events.every((event) => event.contractRevision === 17)).toBe(true);

			const finalBarrier = indexOfEvent(
				events,
				(event) =>
					event.type === "barrier-reached" &&
					(event.data as { kind: string }).kind === "final",
				"final barrier",
			);
			const reportCompleted = indexOfEvent(
				events,
				(event) =>
					event.type === "task-status-changed" &&
					(event.data as { taskId: string; to: string }).taskId ===
						report.task.id &&
					(event.data as { to: string }).to === "completed",
				"report completed",
			);
			const outputDeclared = outputArtifactsDeclared(events);
			expect(outputDeclared).toHaveLength(1);
			const outputIndex = events.indexOf(
				outputDeclared[0] as WorkflowJournalEvent,
			);
			expect(finalBarrier).toBeLessThan(reportCompleted);
			expect(reportCompleted).toBeLessThan(outputIndex);
			// Beyond its declaration, no finalizer activity precedes the output
			// artifact, and the final barrier never names the finalizer.
			expect(
				events
					.slice(0, outputIndex)
					.filter((event) => event.type !== "task-declared")
					.some((event) =>
						JSON.stringify(event.data).includes(cleanup.task.id),
					),
			).toBe(false);
			const finalBarrierData = events[finalBarrier]?.data as
				| { taskIds: string[] }
				| undefined;
			expect(finalBarrierData?.taskIds).toEqual([report.task.id]);
			// The scheduler may park the run in `waiting` once the ordinary tasks
			// settle; `finish()` then resumes it (`waiting -> running`, spec 2.8
			// step 3) immediately before `running -> finalizing`. Nothing else may
			// appear between the output artifact and the finalizing transition.
			const tail = events
				.slice(outputIndex)
				.map((event) => summarize(state, event));
			const resumedFromIdle =
				tail[1]?.join(",") === "run-status-changed,waiting,running";
			expect(resumedFromIdle ? [tail[0], ...tail.slice(2)] : tail).toEqual([
				["artifact-declared", "output"],
				["run-status-changed", "running", "finalizing"],
				["run-output-committed"],
				["task-status-changed", "cleanup", "pending", "ready"],
				["task-execution-created", "support", "cleanup"],
				["task-execution-support-intended"],
				["task-status-changed", "cleanup", "ready", "running"],
				["artifact-declared", "cleanup"],
				["task-execution-support-output-committed"],
				["task-execution-terminal", "completed"],
				["task-status-changed", "cleanup", "running", "completed"],
				["run-status-changed", "finalizing", "completed"],
			]);

			expect(finished.tasks).toEqual([
				expect.objectContaining({
					id: report.task.id,
					namespace: [...report.task.namespace],
					key: "report",
					kind: "support",
					role: "task",
					status: "completed",
					generation: 1,
				}),
				expect.objectContaining({
					id: cleanup.task.id,
					namespace: [...cleanup.task.namespace],
					key: "cleanup",
					kind: "support",
					role: "finalizer",
					status: "completed",
					generation: 1,
				}),
			]);
			await expect(service.status(receipt.runId)).resolves.toMatchObject({
				status: "completed",
				output: { answer: "YES" },
				outputArtifactId: state.outputArtifactId,
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("degrades the run when an advisory finalizer fails", async () => {
		const fx = await fixture(
			"advisory-fails",
			workflow(
				"advisory-fails",
				`${REPORT}
    ctx.finalize("notify", { kind: "advisory", support: boom({ parameters: {} }) });
    return report;`,
			),
		);
		const failing = vi.fn(boomExecute);
		const service = await serviceFor(fx, inertProvider(), [
			upper.registration(upperExecute),
			boom.registration(failing),
		]);
		try {
			const receipt = await service.run("advisory-fails", { value: "yes" });
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({
				status: "completed-degraded",
				output: { answer: "YES" },
			});
			expect(failing).toHaveBeenCalledTimes(1);
			const events = await journalEvents(fx.storeRoot, receipt.runId);
			const state = reduceWorkflowEvents(events);
			const notify = taskByKey(state, "notify");
			expect(notify.task.spec).toMatchObject({
				role: "finalizer",
				disposition: "optional",
			});
			expect(notify.status).toBe("failed");
			expect(taskByKey(state, "report").status).toBe("completed");
			const changes = runStatusChanges(events);
			expect(changes.at(-1)).toMatchObject({
				from: "finalizing",
				to: "completed-degraded",
			});
			expect(changes.some((change) => change.to === "failed")).toBe(false);
			const commit = events.findIndex(
				(event) => event.type === "run-output-committed",
			);
			const created = executionsCreated(events).find(
				(execution) => execution.taskId === notify.task.id,
			);
			expect(created).toMatchObject({ kind: "support", generation: 1 });
			expect(
				events.findIndex(
					(event) =>
						event.type === "task-execution-created" &&
						(event.data as { execution: { id: string } }).execution.id ===
							created?.id,
				),
			).toBeGreaterThan(commit);
			await expect(service.status(receipt.runId)).resolves.toMatchObject({
				status: "completed-degraded",
				tasks: [
					expect.objectContaining({ key: "report", role: "task" }),
					expect.objectContaining({
						key: "notify",
						role: "finalizer",
						status: "failed",
					}),
				],
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("blocks an advisory finalizer behind a failed optional task and degrades", async () => {
		const fx = await fixture(
			"advisory-blocked",
			workflow(
				"advisory-blocked",
				`const flaky = ctx.support("flaky", boom({ parameters: {}, disposition: "optional" }));
    ${REPORT}
    ctx.finalize("notify", { kind: "advisory", support: mark({ parameters: {}, after: [flaky.ref] }) });
    return report;`,
			),
		);
		const notifyExecute = vi.fn(markExecute);
		const service = await serviceFor(fx, inertProvider(), [
			upper.registration(upperExecute),
			boom.registration(boomExecute),
			mark.registration(notifyExecute),
		]);
		try {
			const receipt = await service.run("advisory-blocked", { value: "yes" });
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({
				status: "completed-degraded",
				output: { answer: "YES" },
			});
			expect(notifyExecute).not.toHaveBeenCalled();
			const events = await journalEvents(fx.storeRoot, receipt.runId);
			const state = reduceWorkflowEvents(events);
			const notify = taskByKey(state, "notify");
			expect(taskByKey(state, "flaky").status).toBe("failed");
			expect(notify.status).toBe("blocked");
			expect(notify.currentExecutionId).toBeUndefined();
			const commit = events.findIndex(
				(event) => event.type === "run-output-committed",
			);
			const blocked = events.findIndex(
				(event) =>
					event.type === "task-status-changed" &&
					(event.data as { taskId: string }).taskId === notify.task.id &&
					(event.data as { to: string }).to === "blocked",
			);
			expect(blocked).toBeGreaterThan(commit);
			expect(events[blocked]?.data).toEqual({
				taskId: notify.task.id,
				from: "pending",
				to: "blocked",
				reason: DEPENDENCY_BLOCKED_REASON,
			});
			expect(runStatusChanges(events).at(-1)).toMatchObject({
				from: "finalizing",
				to: "completed-degraded",
			});
			await expect(service.status(receipt.runId)).resolves.toMatchObject({
				tasks: expect.arrayContaining([
					expect.objectContaining({
						key: "notify",
						role: "finalizer",
						status: "blocked",
						generation: 0,
					}),
				]),
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("fails the run with the scheduler's reason when a required finalizer fails", async () => {
		const fx = await fixture(
			"required-fails",
			workflow(
				"required-fails",
				`${REPORT}
    ctx.finalize("cleanup", { kind: "required", support: boom({ parameters: {} }) });
    return report;`,
			),
		);
		const service = await serviceFor(fx, inertProvider());
		try {
			const receipt = await service.run("required-fails", { value: "yes" });
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({ status: "failed" });
			const events = await journalEvents(fx.storeRoot, receipt.runId);
			const state = reduceWorkflowEvents(events);
			expect(state.status).toBe("failed");
			expect(taskByKey(state, "report").status).toBe("completed");
			expect(taskByKey(state, "cleanup").status).toBe("failed");
			// The output was committed before the finalizer ran and stays durable.
			expect(state.outputArtifactId).toBeDefined();
			expect(
				countOf(
					events.map((event) => event.type),
					"run-output-committed",
				),
			).toBe(1);
			expect(runStatusChanges(events).at(-1)).toEqual({
				from: "finalizing",
				to: "failed",
				reason: REQUIRED_TASK_REASON,
			});
			await expect(service.status(receipt.runId)).resolves.toMatchObject({
				status: "failed",
				tasks: expect.arrayContaining([
					expect.objectContaining({
						key: "cleanup",
						role: "finalizer",
						status: "failed",
					}),
				]),
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("fails the run through finalization when a required finalizer is blocked", async () => {
		const fx = await fixture(
			"required-blocked",
			workflow(
				"required-blocked",
				`const flaky = ctx.support("flaky", boom({ parameters: {}, disposition: "optional" }));
    ${REPORT}
    ctx.finalize("cleanup", { kind: "required", support: mark({ parameters: {}, after: [flaky.ref] }) });
    return report;`,
			),
		);
		const cleanupExecute = vi.fn(markExecute);
		const service = await serviceFor(fx, inertProvider(), [
			upper.registration(upperExecute),
			boom.registration(boomExecute),
			mark.registration(cleanupExecute),
		]);
		try {
			const receipt = await service.run("required-blocked", { value: "yes" });
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({ status: "failed" });
			expect(cleanupExecute).not.toHaveBeenCalled();
			const events = await journalEvents(fx.storeRoot, receipt.runId);
			const state = reduceWorkflowEvents(events);
			const cleanup = taskByKey(state, "cleanup");
			expect(cleanup.status).toBe("blocked");
			expect(taskStatusChanges(events)).toContainEqual({
				taskId: cleanup.task.id,
				from: "pending",
				to: "blocked",
				reason: DEPENDENCY_BLOCKED_REASON,
			});
			expect(state.outputArtifactId).toBeDefined();
			expect(runStatusChanges(events).at(-1)).toEqual({
				from: "finalizing",
				to: "failed",
				reason: FINALIZATION_FAILED_REASON,
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("surfaces a blocked required finalizer as the runtime's finalization error", async () => {
		const runId = "workflow_finalizerblocked";
		const storeRoot = root("static-blocked");
		const lease: WorkflowRunLease = await acquireWorkflowRunLease({
			storeRoot,
			runId,
			ownerId: "finalizers-test",
		});
		try {
			const journal = await WorkflowRunJournal.open(storeRoot, runId, lease);
			const artifacts = await WorkflowArtifactStore.open({ journal });
			const definition = defineWorkflow({
				meta: {
					name: "static-blocked",
					description: "Blocked required finalizer",
					version: 1,
					budget: { cost: 1000, childRuntimeMs: 3600000 },
					timeoutMs: 3600000,
				},
				inputSchema: Type.Object({}),
				outputSchema: Type.Object({ answer: Type.String() }),
				run(ctx) {
					ctx.finalize("cleanup", {
						kind: "required",
						agent: {
							agent: "researcher",
							task: {
								goal: "Clean up",
								context: [],
								instructions: ["Return structured output."],
							},
							contextMode: "fresh",
							tools: ["read"],
							preloadSkills: [],
							contextScopes: ["project"],
							workspace: { mode: "read-only", cwd: "/repo" },
							outputSchema: Type.Object({ answer: Type.String() }),
							limits: {
								cumulativeRuntimeMs: 300_000,
								attemptTimeoutMs: 300_000,
								totalTokens: 1_000_000,
								cost: 10,
								outputBytes: 1024,
								workspaceWriteBytes: 0,
								retries: 0,
								resumes: 0,
							},
						},
					});
					return { answer: "yes" };
				},
			});
			// A scheduler that, once the run is finalizing, blocks every pending
			// finalizer the way the real blockers loop does for a failed dependency.
			const scheduler: WorkflowSequentialScheduler & { drives: number } = {
				concurrency: 1,
				stopSignal: new AbortController().signal,
				drives: 0,
				async drive(): Promise<WorkflowSchedulerOutcome> {
					scheduler.drives += 1;
					const current = reduceWorkflowEvents(await journal.readEvents());
					if (current.status !== "finalizing") {
						return { state: "idle", runStatus: current.status };
					}
					const pending = Object.values(current.tasks).find(
						(task) =>
							task.task.spec.role === "finalizer" && task.status === "pending",
					);
					if (pending) {
						await journal.append("task-status-changed", {
							taskId: pending.task.id,
							from: "pending",
							to: "blocked",
							reason: DEPENDENCY_BLOCKED_REASON,
						});
					}
					return { state: "idle", runStatus: "finalizing" };
				},
				async reconcile() {
					throw new Error("fake scheduler has no cleanup-blocked task");
				},
				async stop() {
					return { state: "terminal", runStatus: "cancelled" } as const;
				},
			};
			const runtime = createStaticWorkflowRuntime({
				definition,
				definitionIdentitySha256: "a".repeat(64),
				input: {},
				cwd: "/repo",
				journal,
				artifacts,
				scheduler,
			});
			const error: unknown = await runtime.drive().then(
				() => undefined,
				(reason: unknown) => reason,
			);
			expect(error).toBeInstanceOf(StaticWorkflowRuntimeError);
			expect(error).toMatchObject({
				stage: "finalization",
				message: "Required finalizer did not complete: blocked.",
			});
			expect(scheduler.drives).toBe(1);
			const events = await journal.readEvents();
			const state = reduceWorkflowEvents(events);
			expect(state.status).toBe("failed");
			expect(state.outputArtifactId).toBeDefined();
			expect(taskByKey(state, "cleanup").status).toBe("blocked");
			const changes = runStatusChanges(events);
			expect(changes).toContainEqual({ from: "running", to: "finalizing" });
			expect(changes.at(-1)).toEqual({
				from: "finalizing",
				to: "failed",
				reason: FINALIZATION_FAILED_REASON,
			});
			expect(
				countOf(
					events.map((event) => event.type),
					"run-output-committed",
				),
			).toBe(1);
		} finally {
			await lease.release();
		}
	});

	it("re-executes an invalidated required finalizer as generation 2 without recommitting the output", async () => {
		const fx = await fixture(
			"finalizer-recovery",
			workflow(
				"finalizer-recovery",
				`${REPORT}
    ctx.finalize("cleanup", { kind: "required", support: mark({ parameters: {} }) });
    return report;`,
			),
		);
		let cleanups = 0;
		const cleanupExecute = vi.fn((_context: EmptyContext) => {
			cleanups += 1;
			if (cleanups === 1) throw new Error("first cleanup failed");
			return { answer: `cleanup ${cleanups}` };
		});
		const reportExecute = vi.fn(upperExecute);
		const service = await serviceFor(fx, inertProvider(), [
			upper.registration(reportExecute),
			mark.registration(cleanupExecute),
		]);
		try {
			const receipt = await service.run("finalizer-recovery", { value: "yes" });
			const runId = receipt.runId;
			const first = await bounded(service.wait(runId), "first wait");
			expect(first.status).toBe("failed");
			const failedState = await stateOf(fx.storeRoot, runId);
			const cleanupId = taskByKey(failedState, "cleanup").task.id;
			const reportId = taskByKey(failedState, "report").task.id;
			const outputArtifactId = failedState.outputArtifactId;
			expect(outputArtifactId).toBeDefined();
			expect(first.tasks).toEqual([
				expect.objectContaining({
					id: reportId,
					role: "task",
					status: "completed",
					generation: 1,
				}),
				expect.objectContaining({
					id: cleanupId,
					role: "finalizer",
					status: "failed",
					generation: 1,
				}),
			]);

			const invalidated = await bounded(
				service.invalidate(runId, cleanupId, "operator re-run"),
				"invalidate",
			);
			expect(invalidated.status).not.toBe("failed");
			const finished = await bounded(service.wait(runId), "wait");
			expect(finished).toMatchObject({
				status: "completed",
				output: { answer: "YES" },
				outputArtifactId,
			});
			expect(reportExecute).toHaveBeenCalledTimes(1);
			expect(cleanupExecute).toHaveBeenCalledTimes(2);

			const events = await journalEvents(fx.storeRoot, runId);
			const types = events.map((event) => event.type);
			expect(countOf(types, "task-invalidated")).toBe(1);
			const invalidationIndex = types.indexOf("task-invalidated");
			expect(events[invalidationIndex]?.data).toEqual({
				causeTaskId: cleanupId,
				taskIds: [cleanupId],
				abandonedEpochs: [],
				reason: "operator re-run",
			});
			const recoveryIndex = indexOfEvent(
				events,
				(event) => isRunStatusChange(event, "failed", "running"),
				"failed -> running",
			);
			expect(recoveryIndex).toBeGreaterThan(invalidationIndex);
			const rematerialized = events.filter(
				(event) =>
					event.type === "task-status-changed" &&
					(event.data as { from: string; to: string }).from === "invalidated" &&
					(event.data as { to: string }).to === "pending",
			);
			expect(rematerialized).toHaveLength(1);
			expect(rematerialized[0]?.data).toMatchObject({ taskId: cleanupId });
			const rematerializedIndex = events.indexOf(
				rematerialized[0] as WorkflowJournalEvent,
			);
			expect(rematerializedIndex).toBeGreaterThan(recoveryIndex);
			const refinalizing = events.findIndex(
				(event, index) =>
					index > recoveryIndex &&
					isRunStatusChange(event, "running", "finalizing"),
			);
			expect(refinalizing).toBeGreaterThan(rematerializedIndex);
			// The output artifact is matched, never recommitted.
			expect(countOf(types, "run-output-committed")).toBe(1);
			expect(outputArtifactsDeclared(events)).toHaveLength(1);
			expect(types.indexOf("run-output-committed")).toBeLessThan(
				invalidationIndex,
			);
			expect(runStatusChanges(events).at(-1)).toEqual({
				from: "finalizing",
				to: "completed",
			});

			const created = executionsCreated(events);
			expect(created.map((execution) => execution.generation)).toEqual([
				1, 1, 2,
			]);
			expect(created[2]).toMatchObject({
				id: deriveTaskExecutionId(runId, cleanupId, 2),
				taskId: cleanupId,
				generation: 2,
			});
			expect(
				events.indexOf(
					events.find(
						(event) =>
							event.type === "task-execution-created" &&
							(event.data as { execution: { id: string } }).execution.id ===
								created[2]?.id,
					) as WorkflowJournalEvent,
				),
			).toBeGreaterThan(refinalizing);

			const state = reduceWorkflowEvents(events);
			expect(state.status).toBe("completed");
			expect(state.outputArtifactId).toBe(outputArtifactId);
			const cleanup = state.tasks[cleanupId];
			expect(cleanup?.status).toBe("completed");
			expect(cleanup?.abandoned).toBeUndefined();
			expect(cleanup?.currentExecutionId).toBe(
				deriveTaskExecutionId(runId, cleanupId, 2),
			);
			expect(
				state.executions[deriveTaskExecutionId(runId, cleanupId, 1)],
			).toMatchObject({ phase: "terminal", terminal: { outcome: "failed" } });
			expect(state.tasks[reportId]).toMatchObject({
				status: "completed",
				currentExecutionId: deriveTaskExecutionId(runId, reportId, 1),
			});
			expect(finished.tasks).toEqual([
				expect.objectContaining({
					id: reportId,
					role: "task",
					status: "completed",
					generation: 1,
				}),
				expect.objectContaining({
					id: cleanupId,
					role: "finalizer",
					status: "completed",
					generation: 2,
				}),
			]);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("refuses to invalidate an ordinary task once the output is committed", async () => {
		const fx = await fixture(
			"ordinary-invalidation",
			workflow(
				"ordinary-invalidation",
				`${REPORT}
    ctx.finalize("cleanup", { kind: "required", support: boom({ parameters: {} }) });
    return report;`,
			),
		);
		const service = await serviceFor(fx, inertProvider());
		try {
			const receipt = await service.run("ordinary-invalidation", {
				value: "yes",
			});
			const runId = receipt.runId;
			await expect(bounded(service.wait(runId), "wait")).resolves.toMatchObject(
				{ status: "failed" },
			);
			const state = await stateOf(fx.storeRoot, runId);
			expect(state.outputArtifactId).toBeDefined();
			const reportId = taskByKey(state, "report").task.id;
			const before = await journalEvents(fx.storeRoot, runId);
			await expectServiceError(
				service.invalidate(runId, reportId, "ordinary re-run"),
				"validation",
				"invalidation after output commit may only cover finalizers",
			);
			// The refusal leaves the journal untouched and the run failed.
			expect(await journalEvents(fx.storeRoot, runId)).toEqual(before);
			expect(
				countOf(
					before.map((event) => event.type),
					"task-invalidated",
				),
			).toBe(0);
			await expect(service.status(runId)).resolves.toMatchObject({
				status: "failed",
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	const AGENT_FINALIZER = `ctx.finalize("cleanup", { kind: "required", agent: ${agentRequest()} });
    return { answer: ctx.input.value };`;

	it("completes the finalizers after a restart from a journal cut at the output commit", async () => {
		const fx = await fixture(
			"cut-at-commit",
			workflow("cut-at-commit", AGENT_FINALIZER),
		);
		const first = childProvider([{ status: "completed" }]);
		const firstService = await serviceFor(fx, first.provider);
		const receipt = await firstService.run("cut-at-commit", { value: "yes" });
		const runId = receipt.runId;
		await expect(
			bounded(firstService.wait(runId), "first wait"),
		).resolves.toMatchObject({
			status: "completed",
			output: { answer: "yes" },
		});
		await bounded(firstService.shutdown(), "first shutdown");
		expect(first.ownerClient.launch).toHaveBeenCalledOnce();
		const events = await journalEvents(fx.storeRoot, runId);
		const commit = indexOfEvent(
			events,
			(event) => event.type === "run-output-committed",
			"run-output-committed",
		);
		const storeRoot = await cutJournal(fx, runId, commit + 1);
		const cut = await stateOf(storeRoot, runId);
		expect(cut.status).toBe("finalizing");
		expect(cut.outputArtifactId).toBeDefined();
		expect(taskByKey(cut, "cleanup").status).toBe("pending");
		expect(taskByKey(cut, "cleanup").currentExecutionId).toBeUndefined();

		const second = childProvider([{ status: "completed" }]);
		const service = await serviceFor({ ...fx, storeRoot }, second.provider);
		try {
			const finished = await bounded(service.wait(runId), "wait");
			expect(finished).toMatchObject({
				status: "completed",
				output: { answer: "yes" },
				outputArtifactId: cut.outputArtifactId,
			});
			expect(second.ownerClient.preflight).toHaveBeenCalledOnce();
			expect(second.ownerClient.launch).toHaveBeenCalledOnce();
			expect(second.ownerClient.release).toHaveBeenCalledOnce();
			expect(second.calls).toEqual([]);
			const recovered = await journalEvents(storeRoot, runId);
			const types = recovered.map((event) => event.type);
			expect(countOf(types, "run-output-committed")).toBe(1);
			expect(countOf(types, "task-execution-created")).toBe(1);
			expect(outputArtifactsDeclared(recovered)).toHaveLength(1);
			// Nothing between the commit and the finalizer's readiness: the run
			// resumed straight into driving the finalizer.
			expect(recovered[commit + 1]).toMatchObject({
				type: "task-status-changed",
				data: { from: "pending", to: "ready" },
			});
			expect(runStatusChanges(recovered).at(-1)).toEqual({
				from: "finalizing",
				to: "completed",
			});
			expect(finished.tasks).toEqual([
				expect.objectContaining({
					key: "cleanup",
					kind: "agent",
					role: "finalizer",
					status: "completed",
					generation: 1,
				}),
			]);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("recommits the replayed output after a restart from a journal cut before the output commit", async () => {
		const fx = await fixture(
			"cut-before-commit",
			workflow("cut-before-commit", AGENT_FINALIZER),
		);
		const first = childProvider([{ status: "completed" }]);
		const firstService = await serviceFor(fx, first.provider);
		const receipt = await firstService.run("cut-before-commit", {
			value: "yes",
		});
		const runId = receipt.runId;
		await expect(
			bounded(firstService.wait(runId), "first wait"),
		).resolves.toMatchObject({
			status: "completed",
			output: { answer: "yes" },
		});
		await bounded(firstService.shutdown(), "first shutdown");
		const events = await journalEvents(fx.storeRoot, runId);
		const finalizing = indexOfEvent(
			events,
			(event) => isRunStatusChange(event, "running", "finalizing"),
			"running -> finalizing",
		);
		expect(events[finalizing + 1]?.type).toBe("run-output-committed");
		// C12 crash window: finalizing, output artifact declared, not committed.
		const storeRoot = await cutJournal(fx, runId, finalizing + 1);
		const cut = await stateOf(storeRoot, runId);
		expect(cut.status).toBe("finalizing");
		expect(cut.outputArtifactId).toBeUndefined();
		expect(
			outputArtifactsDeclared(events.slice(0, finalizing + 1)),
		).toHaveLength(1);
		expect(taskByKey(cut, "cleanup").status).toBe("pending");
		expect(taskByKey(cut, "cleanup").currentExecutionId).toBeUndefined();

		const second = childProvider([{ status: "completed" }]);
		const service = await serviceFor({ ...fx, storeRoot }, second.provider);
		try {
			const finished = await bounded(service.wait(runId), "wait");
			expect(finished).toMatchObject({
				status: "completed",
				output: { answer: "yes" },
			});
			expect(second.ownerClient.launch).toHaveBeenCalledOnce();
			expect(second.ownerClient.release).toHaveBeenCalledOnce();
			expect(second.calls).toEqual([]);
			const recovered = await journalEvents(storeRoot, runId);
			const state = reduceWorkflowEvents(recovered);
			const types = recovered.map((event) => event.type);
			// The replayed value matches the declared artifact: it is committed once
			// and never redeclared, and nothing else is appended before the commit
			// (the scheduler selects no work while finalizing without an output).
			expect(countOf(types, "run-output-committed")).toBe(1);
			expect(outputArtifactsDeclared(recovered)).toHaveLength(1);
			expect(
				recovered
					.slice(finalizing + 1, finalizing + 3)
					.map((event) => summarize(state, event)),
			).toEqual([
				["run-output-committed"],
				["task-status-changed", "cleanup", "pending", "ready"],
			]);
			expect(
				runStatusChanges(recovered).filter(
					(change) =>
						change.from === "finalizing" || change.to === "finalizing",
				),
			).toEqual([
				{ from: "running", to: "finalizing" },
				{ from: "finalizing", to: "completed" },
			]);
			const declaredOutput = outputArtifactsDeclared(recovered)[0]?.data as
				| { artifact: { id: string } }
				| undefined;
			expect(state.outputArtifactId).toBe(declaredOutput?.artifact.id);
			expect(finished.tasks).toEqual([
				expect.objectContaining({
					key: "cleanup",
					role: "finalizer",
					status: "completed",
					generation: 1,
				}),
			]);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("repairs the finalizer projection after a restart from a journal cut at its terminal event", async () => {
		const fx = await fixture(
			"cut-at-terminal",
			workflow("cut-at-terminal", AGENT_FINALIZER),
		);
		const first = childProvider([{ status: "completed" }]);
		const firstService = await serviceFor(fx, first.provider);
		const receipt = await firstService.run("cut-at-terminal", { value: "yes" });
		const runId = receipt.runId;
		await expect(
			bounded(firstService.wait(runId), "first wait"),
		).resolves.toMatchObject({ status: "completed" });
		await bounded(firstService.shutdown(), "first shutdown");
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
		expect(cut.status).toBe("finalizing");
		const cutTask = taskByKey(cut, "cleanup");
		expect(["running", "waiting"]).toContain(cutTask.status);
		expect(
			cutTask.currentExecutionId
				? cut.executions[cutTask.currentExecutionId]
				: undefined,
		).toMatchObject({ phase: "terminal", terminal: { outcome: "completed" } });

		const second = childProvider([]);
		const service = await serviceFor({ ...fx, storeRoot }, second.provider);
		try {
			const finished = await bounded(service.wait(runId), "wait");
			expect(finished).toMatchObject({
				status: "completed",
				output: { answer: "yes" },
			});
			// The released child is history: repair needs no subagent call.
			expect(second.ownerClient.preflight).not.toHaveBeenCalled();
			expect(second.ownerClient.launch).not.toHaveBeenCalled();
			expect(second.ownerClient.wait).not.toHaveBeenCalled();
			expect(second.ownerClient.release).not.toHaveBeenCalled();
			expect(second.calls).toEqual([]);
			const recovered = await journalEvents(storeRoot, runId);
			expect(recovered.slice(terminal + 1).map((event) => event.type)).toEqual([
				"task-status-changed",
				"run-status-changed",
			]);
			expect(recovered[terminal + 1]?.data).toEqual({
				taskId: cutTask.task.id,
				from: cutTask.status,
				to: "completed",
				reason: REPAIR_REASON,
			});
			expect(runStatusChanges(recovered).at(-1)).toEqual({
				from: "finalizing",
				to: "completed",
			});
			expect(finished.tasks).toEqual([
				expect.objectContaining({
					key: "cleanup",
					role: "finalizer",
					status: "completed",
					generation: 1,
				}),
			]);
		} finally {
			await shutdownQuietly(service);
		}
	});

	const REFUSALS = [
		{
			name: "barrier-target",
			declare: `const cleanup = ctx.finalize("cleanup", { kind: "required", support: mark({ parameters: {} }) });
      await ctx.result(cleanup);`,
			message: "a finalizer cannot be a barrier target",
		},
		{
			name: "ordinary-after-finalizer",
			declare: `const cleanup = ctx.finalize("cleanup", { kind: "required", support: mark({ parameters: {} }) });
      ctx.agent("late", ${agentRequest({ extra: ",\n      after: [cleanup.ref]" })});`,
			message: "ordinary task may not depend on a finalizer",
		},
		{
			name: "inner-disposition",
			declare: `ctx.finalize("cleanup", { kind: "required", support: mark({ parameters: {}, disposition: "required" }) });`,
			message: "finalizer disposition is its kind",
		},
		{
			name: "two-members",
			declare: `ctx.finalize("cleanup", { kind: "required", support: mark({ parameters: {} }), agent: ${agentRequest()} });`,
			message: "finalizer requires exactly one of support, agent, or workflow",
		},
		{
			name: "bad-kind",
			declare: `ctx.finalize("cleanup", { kind: "optional", support: mark({ parameters: {} }) });`,
			message: "invalid finalizer kind",
		},
	] as const;

	for (const refusal of REFUSALS) {
		it(`refuses authoring (${refusal.name}): ${refusal.message}`, async () => {
			const calls: string[] = [];
			const fx = await fixture(
				refusal.name,
				refusing(refusal.name, refusal.declare),
			);
			const service = await serviceFor(fx, inertProvider(calls));
			try {
				const receipt = await service.run(refusal.name, { value: "yes" });
				// A source-level failure is durable as `failed`, so `wait` resolves
				// with the terminal view instead of rejecting.
				await expect(
					bounded(service.wait(receipt.runId), "wait"),
				).resolves.toMatchObject({ status: "failed" });
				const events = await journalEvents(fx.storeRoot, receipt.runId);
				const state = reduceWorkflowEvents(events);
				expect(state.status).toBe("failed");
				expect(logsOf(state)).toEqual([refusal.message]);
				expect(runReasons(events)).toContain(SOURCE_FAILED_REASON);
				expect(runStatusChanges(events).at(-1)).toMatchObject({
					to: "failed",
					reason: SOURCE_FAILED_REASON,
				});
				// The rejection precedes every barrier, so nothing was declared,
				// launched, or committed.
				expect(Object.keys(state.tasks)).toHaveLength(0);
				expect(state.outputArtifactId).toBeUndefined();
				expect(calls).toEqual([]);
			} finally {
				await shutdownQuietly(service);
			}
		});
	}

	it("retries an agent finalizer under its policy while the run is finalizing", async () => {
		const fx = await fixture(
			"finalizer-retry",
			workflow(
				"finalizer-retry",
				`ctx.finalize("cleanup", { kind: "required", agent: ${agentRequest({ retries: 1, extra: ",\n      retry: { attempts: 1 }" })} });
    return { answer: ctx.input.value };`,
			),
		);
		const delegated = childProvider([
			{ status: "failed", failure: childFailure("backoff") },
			{ status: "completed" },
		]);
		const service = await serviceFor(fx, delegated.provider);
		try {
			const receipt = await service.run("finalizer-retry", { value: "yes" });
			const finished = await bounded(service.wait(receipt.runId), "wait");
			expect(finished).toMatchObject({
				status: "completed",
				output: { answer: "yes" },
			});
			expect(delegated.ownerClient.launch).toHaveBeenCalledOnce();
			expect(delegated.ownerClient.retry).toHaveBeenCalledOnce();
			expect(delegated.ownerClient.retry).toHaveBeenCalledWith(
				delegated.child.runId,
			);
			expect(delegated.ownerClient.resume).not.toHaveBeenCalled();
			expect(delegated.calls).toEqual([]);

			const events = await journalEvents(fx.storeRoot, receipt.runId);
			const types = events.map((event) => event.type);
			expect(countOf(types, "task-execution-child-settled")).toBe(2);
			expect(countOf(types, "task-execution-attempt-intended")).toBe(1);
			expect(countOf(types, "task-execution-attempt-receipted")).toBe(1);
			expect(countOf(types, "task-execution-attempt-declined")).toBe(0);
			const commit = types.indexOf("run-output-committed");
			const intent = types.indexOf("task-execution-attempt-intended");
			expect(intent).toBeGreaterThan(commit);
			expect(events[intent]?.data).toMatchObject({
				kind: "retry",
				ordinal: 2,
				failureRetry: "backoff",
				origin: "policy",
			});
			expect(events[intent]?.data).not.toHaveProperty("reason");
			// Amendment 1: the policy attempt is admitted while finalizing; the run
			// status never moves between the output commit and the intent.
			const before = runStatusChanges(events.slice(0, intent));
			expect(before.at(-1)).toMatchObject({ to: "finalizing" });
			expect(
				events
					.slice(commit + 1, intent)
					.some((event) => event.type === "run-status-changed"),
			).toBe(false);
			expect(runStatusChanges(events).at(-1)).toEqual({
				from: "finalizing",
				to: "completed",
			});

			const state = reduceWorkflowEvents(events);
			const cleanup = taskByKey(state, "cleanup");
			expect(cleanup.task.spec.role).toBe("finalizer");
			expect(cleanup.status).toBe("completed");
			const execution = cleanup.currentExecutionId
				? state.executions[cleanup.currentExecutionId]
				: undefined;
			expect(execution?.attempts).toHaveLength(1);
			expect(execution?.attempts?.[0]).toMatchObject({
				kind: "retry",
				ordinal: 2,
				origin: "policy",
				receiptSequence: expect.any(Number),
			});
			expect(execution?.priorSettlements?.[0]?.evidence).toMatchObject({
				status: "failed",
				attemptOrdinal: 1,
			});
			expect(execution?.terminal?.evidence).toMatchObject({
				kind: "subagent",
				status: "completed",
				attemptOrdinal: 2,
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("appends no run-status events between the output commit and completion without finalizers", async () => {
		const fx = await fixture(
			"no-finalizers",
			workflow(
				"no-finalizers",
				`${REPORT}
    return report;`,
				{ concurrency: 2 },
			),
		);
		const service = await serviceFor(fx, inertProvider());
		try {
			const receipt = await service.run("no-finalizers", { value: "yes" });
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({
				status: "completed",
				output: { answer: "YES" },
			});
			const events = await journalEvents(fx.storeRoot, receipt.runId);
			const state = reduceWorkflowEvents(events);
			const types = events.map((event) => event.type);
			expect(countOf(types, "run-output-committed")).toBe(1);
			const commit = types.indexOf("run-output-committed");
			expect(
				events.slice(commit + 1).map((event) => summarize(state, event)),
			).toEqual([["run-status-changed", "finalizing", "completed"]]);
			expect(
				runStatusChanges(events).filter(
					(change) =>
						change.from === "finalizing" || change.to === "finalizing",
				),
			).toEqual([
				{ from: "running", to: "finalizing" },
				{ from: "finalizing", to: "completed" },
			]);
			expect(
				Object.values(state.tasks).every(
					(task) => task.task.spec.role === "task",
				),
			).toBe(true);
		} finally {
			await shutdownQuietly(service);
		}
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});
