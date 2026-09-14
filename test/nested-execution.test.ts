import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	type AgentLaunchPlan,
	canonicalSha256,
	SUBAGENT_RUNTIME_CONTRACT,
	type SubagentClient,
	type SubagentRequest,
} from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowRunId } from "../src/contracts.js";
import type {
	TaskExecutionProjection,
	WorkflowStateProjection,
	WorkflowTaskProjection,
} from "../src/events.js";
import {
	deriveJsonValueSha256,
	deriveNestedWorkflowRunId,
} from "../src/execution.js";
import type { WorkflowJournalEvent } from "../src/persistence/journal.js";
import { acquireWorkflowRunLease } from "../src/persistence/run-lease.js";
import { reduceWorkflowEvents } from "../src/reducer.js";
import type { WorkflowRunRecord } from "../src/run-record.js";
import { createWorkflowService } from "../src/service.js";
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
type EmptyContext = SupportTaskExecutionContext<Record<string, never>>;

const slow = defineSupportTask({
	name: `${TOOLS_MODULE}/slow`,
	moduleSpecifier: TOOLS_MODULE,
	revision: 1,
	implementationSha256: "d".repeat(64),
	parametersSchema: EMPTY_SCHEMA,
	outputSchema: Type.Object({ answer: Type.String() }),
});

function root(name: string): string {
	return path.resolve(
		".pi",
		"test-nested-execution",
		`${name}-${randomUUID()}`,
	);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

async function until(predicate: () => boolean | Promise<boolean>) {
	while (!(await predicate())) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Fails fast instead of hanging the whole suite when a drain never settles. */
// Fails fast with a named label instead of the suite timeout; the bound
// follows the suite-wide allowance in vitest.config.ts because stop cascades
// are fsync-bound and exceeded 3 s under Ubuntu CI load (run 34821692078).
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
];

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

function provider(calls: string[], bound: string[]): WorkflowSubagentProvider {
	return {
		bind: vi.fn(async (runId: string) => {
			bound.push(runId);
			return {
				workflowRunId: runId,
				ownerId: `pi-workflow:${runId}`,
				client: strictClient(calls),
			} satisfies WorkflowSubagentBinding;
		}),
	};
}

/**
 * Like `provider`, but `bind` for the nth run id awaits the gate. The service
 * binds a child's owner inside `nestedProvider.launch`, after the parent's
 * `task-execution-nested-intended` is durable and before
 * `task-execution-nested-launched`, so a blocked bind parks the parent
 * exactly between intent and launch.
 */
function gatedProvider(
	bound: string[],
	blockedOrdinal: number,
	gate: Promise<void>,
): { provider: WorkflowSubagentProvider; blocked: string[] } {
	const blocked: string[] = [];
	return {
		blocked,
		provider: {
			bind: vi.fn(async (runId: string) => {
				bound.push(runId);
				if (bound.length === blockedOrdinal) {
					blocked.push(runId);
					await gate;
				}
				return {
					workflowRunId: runId,
					ownerId: `pi-workflow:${runId}`,
					client: strictClient([]),
				} satisfies WorkflowSubagentBinding;
			}),
		},
	};
}

const CHILD_USAGE = Object.freeze({
	input: 3,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 5,
	cost: 0.25,
});
const CHILD_RUNTIME_MS = 10;

/**
 * A fake delegated child bound per workflow run id: each run gets its own
 * owner client whose launch plan carries `pi-workflow:<runId>`.
 */
function agentProvider() {
	const clients = new Map<string, SubagentClient>();
	const bound: string[] = [];
	function clientFor(ownerId: string): SubagentClient {
		const preflight = vi.fn(async (request: SubagentRequest) => {
			const draft = {
				schema: "pi-subagent-launch" as const,
				contractRevision: SUBAGENT_RUNTIME_CONTRACT.contractRevision,
				operationId: request.operationId,
				ownerId,
				runId: "run_nestedchild",
				attemptId: "attempt_nestedchild",
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
			return {
				preflightId: "preflight-nested",
				identitySha256: canonicalSha256(draft),
				expiresAt: "2099-01-01T00:00:00.000Z",
				launchPlan: { ...draft, identitySha256: canonicalSha256(draft) },
			};
		});
		return {
			...strictClient([]),
			preflight,
			launch: vi.fn(async () => ({
				runId: "run_nestedchild",
				attemptId: "attempt_nestedchild",
				status: "active" as const,
			})),
			wait: vi.fn(async () => ({
				result: {
					runId: "run_nestedchild",
					status: "completed" as const,
					structuredOutput: { answer: "from child" },
					usage: { ...CHILD_USAGE },
					usageComplete: true,
					runtimeMs: CHILD_RUNTIME_MS,
					sandboxCleanup: "proved" as const,
					workspaceCleanup: "not-needed" as const,
					truncated: false,
				},
				output: "from child",
				sessionFile: undefined,
				handoff: undefined,
				structuredOutput: { answer: "from child" },
				error: undefined,
			})),
			release: vi.fn(async () => ({
				runId: "run_nestedchild",
				attemptId: "attempt_nestedchild",
				status: "completed" as const,
			})),
		} as unknown as SubagentClient;
	}
	const bind = vi.fn(async (runId: string) => {
		bound.push(runId);
		const ownerId = `pi-workflow:${runId}`;
		const client = clientFor(ownerId);
		clients.set(runId, client);
		return { workflowRunId: runId, ownerId, client };
	});
	return { provider: { bind } as WorkflowSubagentProvider, clients, bound };
}

function toolsModuleSource(): string {
	const identity = JSON.stringify({
		implementation: slow.implementation,
		moduleSpecifier: slow.moduleSpecifier,
		revision: slow.revision,
		implementationSha256: slow.implementationSha256,
		parametersSchema: slow.parametersSchema,
		outputSchema: slow.outputSchema,
	});
	return `export function slow(call) {
  return Object.freeze({
    schema: "pi-workflow-support-task-descriptor",
    ...${identity},
    parameters: call.parameters,
  });
}
`;
}

const VALUE_SCHEMA =
	'{ type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }';
const ANSWER_SCHEMA =
	'{ type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }';
const DEFAULT_BUDGET = "{ cost: 100, childRuntimeMs: 3600000 }";

interface DefinitionOptions {
	readonly budget?: string;
	readonly timeoutMs?: number;
	readonly concurrency?: number;
	readonly imports?: string;
	readonly description?: string;
}

function definition(
	name: string,
	body: string,
	options: DefinitionOptions = {},
): string {
	return `${options.imports ?? ""}export default {
  schema: "pi-workflow-definition",
  meta: { name: ${JSON.stringify(name)}, description: ${JSON.stringify(options.description ?? "Nested")}, version: 1, budget: ${options.budget ?? DEFAULT_BUDGET}, timeoutMs: ${options.timeoutMs ?? 600000}, concurrency: ${options.concurrency ?? 2} },
  inputSchema: ${VALUE_SCHEMA},
  outputSchema: ${ANSWER_SCHEMA},
  run(ctx) {
    ${body}
  }
};
`;
}

const ECHO_BODY = `ctx.phase("child"); return { answer: ctx.input.value.toUpperCase() };`;

/** Returns the child's output as this definition's output. */
function nester(
	name: string,
	child: string,
	options: DefinitionOptions = {},
): string {
	return definition(
		name,
		`return ctx.workflow("child", { workflow: ${JSON.stringify(child)}, input: { value: ctx.input.value } });`,
		options,
	);
}

/** Surfaces a declaration rejection as this definition's output. */
function probe(name: string, child: string, input: string): string {
	return definition(
		name,
		`try {
      ctx.workflow("child", { workflow: ${JSON.stringify(child)}, input: ${input} });
    } catch (error) {
      return { answer: error.message };
    }
    return { answer: "declared" };`,
	);
}

/** Logs the declaration rejection durably, then fails the run with it. */
function logging(name: string, declare: string): string {
	return definition(
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

const AGENT_REQUEST = `{
      agent: "researcher",
      task: { goal: "Answer", context: [], instructions: ["Return structured output."] },
      contextMode: "fresh",
      tools: ["read"],
      preloadSkills: [],
      contextScopes: ["project"],
      workspace: { mode: "read-only", cwd: ctx.cwd },
      outputSchema: ${ANSWER_SCHEMA},
      limits: { cumulativeRuntimeMs: 300000, attemptTimeoutMs: 300000, totalTokens: 1000000, cost: 10, outputBytes: 1024, workspaceWriteBytes: 0, retries: 0, resumes: 0 }
    }`;

const AGENT_BODY = `return ctx.agent("answer", ${AGENT_REQUEST});`;

const BLOCKING_BODY = `return new Promise((resolve) => {
      ctx.signal.addEventListener("abort", () => resolve({ answer: "aborted" }), { once: true });
    });`;

const CONSUMER_CHILD = `export default {
  schema: "pi-workflow-definition",
  meta: { name: "consumer-child", description: "Consumes an injected artifact", version: 1, budget: ${DEFAULT_BUDGET}, timeoutMs: 600000, concurrency: 2 },
  inputSchema: { type: "object", properties: { prefix: { type: "string" }, doc: ${ANSWER_SCHEMA} }, required: ["prefix", "doc"], additionalProperties: false },
  outputSchema: ${ANSWER_SCHEMA},
  run(ctx) { return { answer: ctx.input.prefix + ctx.input.doc.answer + ">" }; }
};
`;

/** Like `consumer-child`, but its schema also requires `doc.extra`, which no producer emits. */
const STRICT_CONSUMER_CHILD = `export default {
  schema: "pi-workflow-definition",
  meta: { name: "strict-consumer-child", description: "Requires a field no producer emits", version: 1, budget: ${DEFAULT_BUDGET}, timeoutMs: 600000, concurrency: 2 },
  inputSchema: { type: "object", properties: { prefix: { type: "string" }, doc: { type: "object", properties: { answer: { type: "string" }, extra: { type: "string" } }, required: ["answer", "extra"], additionalProperties: false } }, required: ["prefix", "doc"], additionalProperties: false },
  outputSchema: ${ANSWER_SCHEMA},
  run(ctx) { return { answer: ctx.input.prefix + ctx.input.doc.answer + ctx.input.doc.extra }; }
};
`;

const FIRST_ECHO = `const first = ctx.workflow("first", { workflow: "echo-child", input: { value: ctx.input.value } });`;

const INPUT_PARENT_BODY = `${FIRST_ECHO}
    return ctx.workflow("second", { workflow: "consumer-child", input: { prefix: "<" }, inputs: { doc: first.output } });`;

const AGENT_INPUT_PARENT_BODY = `const answer = ctx.agent("answer", ${AGENT_REQUEST});
    return ctx.workflow("second", { workflow: "consumer-child", input: { prefix: "<" }, inputs: { doc: answer.output } });`;

const SUPPORT_INPUT_PARENT_BODY = `const doc = ctx.support("doc", slow({ parameters: {} }));
    return ctx.workflow("second", { workflow: "consumer-child", input: { prefix: "<" }, inputs: { doc: doc.output } });`;

const CHAIN_PARENT_BODY = `${FIRST_ECHO}
    const second = ctx.workflow("second", { workflow: "consumer-child", input: { prefix: "<" }, inputs: { doc: first.output } });
    return ctx.workflow("third", { workflow: "consumer-child", input: { prefix: "[" }, inputs: { doc: second.output } });`;

const FOREIGN_HANDLE = `{ ref: { runId: "workflow_other", producerTaskId: first.output.ref.producerTaskId, output: "result" } }`;

const DEFINITIONS = {
	"echo-child": definition("echo-child", ECHO_BODY),
	"consumer-child": CONSUMER_CHILD,
	"input-parent": definition("input-parent", INPUT_PARENT_BODY),
	// The scheduler reserves the consumer child's full declared budget (cost
	// 100, child runtime 3 600 000 ms) against what remains after the agent
	// task settled its own cost and runtime, so the parent declares headroom
	// for both on each axis.
	"agent-input-parent": definition(
		"agent-input-parent",
		AGENT_INPUT_PARENT_BODY,
		{ budget: "{ cost: 200, childRuntimeMs: 7200000 }" },
	),
	"support-input-parent": definition(
		"support-input-parent",
		SUPPORT_INPUT_PARENT_BODY,
		{ imports: `import { slow } from ${JSON.stringify(TOOLS_MODULE)};\n` },
	),
	"chain-parent": definition("chain-parent", CHAIN_PARENT_BODY),
	"non-object-parent": logging(
		"non-object-parent",
		`${FIRST_ECHO}
      ctx.workflow("second", { workflow: "consumer-child", input: "text", inputs: { doc: first.output } });`,
	),
	"collision-parent": logging(
		"collision-parent",
		`${FIRST_ECHO}
      ctx.workflow("second", { workflow: "consumer-child", input: { prefix: "<", doc: { answer: "authored" } }, inputs: { doc: first.output } });`,
	),
	"foreign-parent": logging(
		"foreign-parent",
		`${FIRST_ECHO}
      ctx.workflow("second", { workflow: "consumer-child", input: { prefix: "<" }, inputs: { doc: ${FOREIGN_HANDLE} } });`,
	),
	"strict-consumer-child": STRICT_CONSUMER_CHILD,
	"strict-input-parent": definition(
		"strict-input-parent",
		`${FIRST_ECHO}
    return ctx.workflow("second", { workflow: "strict-consumer-child", input: { prefix: "<" }, inputs: { doc: first.output } });`,
	),
	"lenient-input-parent": definition(
		"lenient-input-parent",
		`${FIRST_ECHO}
    ctx.workflow("second", { workflow: "strict-consumer-child", input: { prefix: "<" }, inputs: { doc: first.output }, disposition: "optional" });
    return { answer: "fallback" };`,
	),
	"nest-parent": nester("nest-parent", "echo-child"),
	mid: nester("mid", "echo-child"),
	top: nester("top", "mid"),
	"depth-3": logging(
		"depth-3",
		`ctx.workflow("child", { workflow: "echo-child", input: { value: ctx.input.value } });`,
	),
	"depth-2": nester("depth-2", "depth-3"),
	"depth-1": nester("depth-1", "depth-2"),
	"depth-0": nester("depth-0", "depth-1"),
	selfish: logging(
		"selfish",
		`ctx.workflow("child", { workflow: "selfish", input: { value: ctx.input.value } });`,
	),
	"cycle-a": nester("cycle-a", "cycle-b"),
	"cycle-b": probe("cycle-b", "cycle-a", "{ value: ctx.input.value }"),
	many: logging(
		"many",
		`for (let index = 0; index < 65; index += 1) {
        ctx.workflow("child-" + index, { workflow: "echo-child", input: { value: ctx.input.value } });
      }`,
	),
	"unknown-parent": probe(
		"unknown-parent",
		"no-such-workflow",
		"{ value: ctx.input.value }",
	),
	"bad-input-parent": probe("bad-input-parent", "echo-child", "{ value: 42 }"),
	"agent-child": definition("agent-child", AGENT_BODY),
	"agent-parent": nester("agent-parent", "agent-child"),
	"bad-output-child": definition("bad-output-child", `return { answer: 42 };`),
	"strict-parent": nester("strict-parent", "bad-output-child"),
	"lenient-parent": definition(
		"lenient-parent",
		`ctx.workflow("child", { workflow: "bad-output-child", input: { value: ctx.input.value }, disposition: "optional" });
    return { answer: "fallback" };`,
	),
	"blocking-child": definition("blocking-child", BLOCKING_BODY),
	"blocking-parent": nester("blocking-parent", "blocking-child"),
	"deadline-parent": definition(
		"deadline-parent",
		`return ctx.workflow("child", { workflow: "blocking-child", input: { value: ctx.input.value } });`,
		{ timeoutMs: 3_000 },
	),
	"slow-child": definition(
		"slow-child",
		`return ctx.support("slow", slow({ parameters: {} }));`,
		{ imports: `import { slow } from ${JSON.stringify(TOOLS_MODULE)};\n` },
	),
	"restart-parent": nester("restart-parent", "slow-child"),
} as const;

type DefinitionName = keyof typeof DEFINITIONS;

async function fixture(name: string, names: readonly DefinitionName[]) {
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
	for (const definitionName of names) {
		await writeFile(
			path.join(cwd, "workflows", `${definitionName}.workflow.ts`),
			DEFINITIONS[definitionName],
		);
	}
	return { cwd, agentDir, storeRoot };
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
	// The service may be appending while a test polls; only newline-terminated
	// records are complete, so a torn trailing line is ignored here exactly as
	// the journal reader treats it.
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

async function recordOf(
	storeRoot: string,
	runId: string,
): Promise<WorkflowRunRecord> {
	return JSON.parse(
		await readFile(path.join(storeRoot, "runs", runId, "service.json"), "utf8"),
	) as WorkflowRunRecord;
}

function taskByKey(
	state: WorkflowStateProjection,
	key: string,
): WorkflowTaskProjection {
	const task = Object.values(state.tasks).find(
		(candidate) => candidate.task.spec.key === key,
	);
	if (!task) throw new Error(`missing task ${key}`);
	return task;
}

function executionOf(
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

/** The task's verified `result` artifact as declared in the parent journal. */
function resultArtifactOf(
	state: WorkflowStateProjection,
	task: WorkflowTaskProjection,
): { id: string; sha256: string } {
	const matches = Object.values(state.artifacts).filter(
		(artifact) =>
			artifact.producerTaskId === task.task.id && artifact.output === "result",
	);
	const artifact = matches[0];
	if (matches.length !== 1 || !artifact) {
		throw new Error(`missing result artifact for ${task.task.spec.key}`);
	}
	return { id: artifact.id, sha256: artifact.sha256 };
}

function childRunIdOf(
	parentRunId: WorkflowRunId,
	task: WorkflowTaskProjection,
): WorkflowRunId {
	return deriveNestedWorkflowRunId(parentRunId, task.task.id, 1);
}

/** Journal sequences of events matching the predicate, in journal order. */
function sequencesOf(
	events: readonly WorkflowJournalEvent[],
	type: WorkflowJournalEvent["type"],
	predicate: (data: Record<string, unknown>) => boolean,
): number[] {
	return events
		.filter(
			(event) =>
				event.type === type &&
				predicate(event.data as unknown as Record<string, unknown>),
		)
		.map((event) => event.sequence);
}

function nestedTaskOf(state: WorkflowStateProjection): WorkflowTaskProjection {
	const task = Object.values(state.tasks).find(
		(candidate) => candidate.task.spec.kind === "workflow",
	);
	if (!task) throw new Error("missing nested workflow task");
	return task;
}

function terminalOf(
	state: WorkflowStateProjection,
	task: WorkflowTaskProjection,
): NonNullable<TaskExecutionProjection["terminal"]> {
	const execution = task.currentExecutionId
		? state.executions[task.currentExecutionId]
		: undefined;
	if (!execution?.terminal) {
		throw new Error(`missing terminal evidence for ${task.task.spec.key}`);
	}
	return execution.terminal;
}

function runReasons(events: readonly WorkflowJournalEvent[]): string[] {
	return events.flatMap((event) => {
		if (event.type !== "run-status-changed") return [];
		const reason = (event.data as { reason?: string }).reason;
		return reason === undefined ? [] : [reason];
	});
}

function logsOf(state: WorkflowStateProjection): readonly string[] {
	return state.effects
		.filter((effect) => effect.kind === "log")
		.map((effect) => effect.value);
}

/** Waits until the parent has durably declared its nested task and returns the child run id. */
async function childOf(
	storeRoot: string,
	parentRunId: WorkflowRunId,
): Promise<{ taskId: string; childRunId: WorkflowRunId }> {
	let taskId: string | undefined;
	await until(async () => {
		const state = await stateOf(storeRoot, parentRunId).catch(() => undefined);
		const task = state
			? Object.values(state.tasks).find(
					(candidate) => candidate.task.spec.kind === "workflow",
				)
			: undefined;
		taskId = task?.task.id;
		return taskId !== undefined;
	});
	return {
		taskId: taskId as string,
		childRunId: deriveNestedWorkflowRunId(parentRunId, taskId as string, 1),
	};
}

/** Waits until the parent durably launched the child and the child run is readable. */
async function untilChildLaunched(
	service: Awaited<ReturnType<typeof createWorkflowService>>,
	storeRoot: string,
	parentRunId: WorkflowRunId,
	childRunId: WorkflowRunId,
): Promise<void> {
	await until(async () =>
		(await eventTypes(storeRoot, parentRunId)).includes(
			"task-execution-nested-launched",
		),
	);
	await until(async () => {
		const view = await service.status(childRunId).catch(() => undefined);
		return view !== undefined;
	});
}

/**
 * Simulates a process crash: the parent and child run directories are copied
 * into a fresh store root while the first service is still blocked inside the
 * child's support implementation.
 */
async function crashSnapshot(
	fx: { cwd: string; storeRoot: string },
	runIds: readonly WorkflowRunId[],
): Promise<string> {
	const storeRoot = path.join(fx.cwd, ".pi", `workflow-${randomUUID()}`);
	// Leases live under `<storeRoot>/leases`, so seed one per copied run: the
	// next acquisition then fences at a higher generation than the copied
	// journal tail written by the first service.
	for (const runId of runIds) {
		const setup = await acquireWorkflowRunLease({
			storeRoot,
			runId,
			ownerId: "setup",
		});
		await setup.release();
	}
	await mkdir(path.join(storeRoot, "runs"), { recursive: true, mode: 0o700 });
	for (const runId of runIds) {
		await cp(
			path.join(fx.storeRoot, "runs", runId),
			path.join(storeRoot, "runs", runId),
			{ recursive: true },
		);
	}
	return storeRoot;
}

async function blockedNestedRun(name: string) {
	const gate = deferred<void>();
	const execute = vi.fn(async ({ signal }: EmptyContext) => {
		await gate.promise;
		return { answer: signal.aborted ? "aborted" : "first" };
	});
	const fx = await fixture(name, ["slow-child", "restart-parent"]);
	const bound: string[] = [];
	const service = await createWorkflowService({
		...fx,
		projectTrusted: () => true,
		subagents: provider([], bound),
		supportTasks: [slow.registration(execute)],
	});
	const receipt = await service.run("restart-parent", { value: "yes" });
	const child = await childOf(fx.storeRoot, receipt.runId);
	await until(() => execute.mock.calls.length > 0);
	const storeRoot = await crashSnapshot(fx, [receipt.runId, child.childRunId]);
	return {
		execute,
		fx,
		gate,
		parentRunId: receipt.runId,
		childRunId: child.childRunId,
		service,
		storeRoot,
	};
}

describe("nested workflow execution", () => {
	it("injects a sibling child's verified output as an artifact input", async () => {
		const calls: string[] = [];
		const bound: string[] = [];
		const fx = await fixture("artifact-input", [
			"echo-child",
			"consumer-child",
			"input-parent",
		]);
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider(calls, bound),
		});
		const receipt = await service.run("input-parent", { value: "yes" });
		await expect(service.wait(receipt.runId)).resolves.toMatchObject({
			status: "completed",
			output: { answer: "<YES>" },
		});
		expect(calls).toEqual([]);
		const parentState = await stateOf(fx.storeRoot, receipt.runId);
		const firstTask = Object.values(parentState.tasks).find(
			(task) => task.task.spec.key === "first",
		);
		const secondTask = Object.values(parentState.tasks).find(
			(task) => task.task.spec.key === "second",
		);
		expect(firstTask?.status).toBe("completed");
		expect(secondTask?.task.spec.kind).toBe("workflow");
		expect(secondTask?.task.spec.after).toEqual([
			{ runId: receipt.runId, taskId: firstTask?.task.id },
		]);
		const firstArtifact = Object.values(parentState.artifacts).find(
			(artifact) =>
				artifact.producerTaskId === firstTask?.task.id &&
				artifact.output === "result",
		);
		const secondExecution = secondTask?.currentExecutionId
			? parentState.executions[secondTask.currentExecutionId]
			: undefined;
		expect(secondExecution?.nestedIntent).toMatchObject({
			inputsSha256: deriveJsonValueSha256({ doc: firstArtifact?.sha256 }),
			resolvedInputSha256: deriveJsonValueSha256({
				prefix: "<",
				doc: { answer: "YES" },
			}),
		});
		const childRunId = deriveNestedWorkflowRunId(
			receipt.runId,
			secondTask?.task.id ?? "",
			1,
		);
		await expect(service.status(childRunId)).resolves.toMatchObject({
			status: "completed",
			depth: 1,
			parent: {
				runId: receipt.runId,
				taskId: secondTask?.task.id,
				inputArtifacts: {
					doc: {
						runId: receipt.runId,
						artifactId: firstArtifact?.id,
						sha256: firstArtifact?.sha256,
					},
				},
			},
			output: { answer: "<YES>" },
		});
		const childRecord = JSON.parse(
			await readFile(
				path.join(fx.storeRoot, "runs", childRunId, "service.json"),
				"utf8",
			),
		) as { input: unknown };
		expect(childRecord.input).toEqual({ prefix: "<", doc: { answer: "YES" } });
		await service.shutdown();
	});

	it("feeds a parent agent task's verified output into a consumer child", async () => {
		const fx = await fixture("agent-input", [
			"consumer-child",
			"agent-input-parent",
		]);
		const delegated = agentProvider();
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		const receipt = await service.run("agent-input-parent", { value: "yes" });
		await expect(service.wait(receipt.runId)).resolves.toMatchObject({
			status: "completed",
			output: { answer: "<from child>" },
		});
		const parentState = await stateOf(fx.storeRoot, receipt.runId);
		const answerTask = taskByKey(parentState, "answer");
		const secondTask = taskByKey(parentState, "second");
		expect(answerTask.task.spec.kind).toBe("agent");
		expect(answerTask.status).toBe("completed");
		expect(secondTask.task.spec.after).toEqual([
			{ runId: receipt.runId, taskId: answerTask.task.id },
		]);
		const artifact = resultArtifactOf(parentState, answerTask);
		const childRunId = childRunIdOf(receipt.runId, secondTask);
		expect(delegated.bound).toEqual([receipt.runId, childRunId]);
		const parentClient = delegated.clients.get(receipt.runId);
		const childClient = delegated.clients.get(childRunId);
		if (!parentClient || !childClient) throw new Error("missing clients");
		expect(parentClient.preflight).toHaveBeenCalledOnce();
		const preflight = vi.mocked(parentClient.preflight).mock.results[0];
		if (preflight?.type !== "return") throw new Error("preflight failed");
		expect((await preflight.value).launchPlan.ownerId).toBe(
			`pi-workflow:${receipt.runId}`,
		);
		for (const method of ["preflight", "launch", "wait", "release"] as const) {
			expect(childClient[method]).not.toHaveBeenCalled();
		}
		const childRecord = await recordOf(fx.storeRoot, childRunId);
		expect(childRecord.input).toEqual({
			prefix: "<",
			doc: { answer: "from child" },
		});
		expect(childRecord.parent?.inputArtifacts).toEqual({
			doc: {
				runId: receipt.runId,
				artifactId: artifact.id,
				sha256: artifact.sha256,
			},
		});
		expect(artifact.sha256).toBe(
			deriveJsonValueSha256({ answer: "from child" }),
		);
		await expect(service.status(childRunId)).resolves.toMatchObject({
			status: "completed",
			definitionName: "consumer-child",
			depth: 1,
			parent: { runId: receipt.runId, taskId: secondTask.task.id },
			output: { answer: "<from child>" },
		});
		await service.shutdown();
	});

	it("feeds a parent support task's verified output into a consumer child", async () => {
		const execute = vi.fn((_context: EmptyContext) => ({
			answer: "from support",
		}));
		const calls: string[] = [];
		const bound: string[] = [];
		const fx = await fixture("support-input", [
			"consumer-child",
			"support-input-parent",
		]);
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider(calls, bound),
			supportTasks: [slow.registration(execute)],
		});
		const receipt = await service.run("support-input-parent", { value: "yes" });
		await expect(service.wait(receipt.runId)).resolves.toMatchObject({
			status: "completed",
			output: { answer: "<from support>" },
		});
		expect(calls).toEqual([]);
		expect(execute).toHaveBeenCalledOnce();
		const parentState = await stateOf(fx.storeRoot, receipt.runId);
		const docTask = taskByKey(parentState, "doc");
		const secondTask = taskByKey(parentState, "second");
		expect(docTask.task.spec.kind).toBe("support");
		expect(docTask.status).toBe("completed");
		expect(secondTask.task.spec.after).toEqual([
			{ runId: receipt.runId, taskId: docTask.task.id },
		]);
		const artifact = resultArtifactOf(parentState, docTask);
		const childRunId = childRunIdOf(receipt.runId, secondTask);
		expect(bound).toEqual([receipt.runId, childRunId]);
		const childRecord = await recordOf(fx.storeRoot, childRunId);
		expect(childRecord.input).toEqual({
			prefix: "<",
			doc: { answer: "from support" },
		});
		expect(childRecord.parent?.inputArtifacts).toEqual({
			doc: {
				runId: receipt.runId,
				artifactId: artifact.id,
				sha256: artifact.sha256,
			},
		});
		await expect(service.status(childRunId)).resolves.toMatchObject({
			status: "completed",
			definitionName: "consumer-child",
			depth: 1,
			parent: {
				runId: receipt.runId,
				taskId: secondTask.task.id,
				inputArtifacts: { doc: { artifactId: artifact.id } },
			},
			output: { answer: "<from support>" },
		});
		await service.shutdown();
	});

	it("chains three nested children, each consuming the previous child's imported result", async () => {
		const bound: string[] = [];
		const fx = await fixture("chain", [
			"echo-child",
			"consumer-child",
			"chain-parent",
		]);
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider([], bound),
		});
		const receipt = await service.run("chain-parent", { value: "yes" });
		await expect(service.wait(receipt.runId)).resolves.toMatchObject({
			status: "completed",
			output: { answer: "[<YES>>" },
		});
		const parentState = await stateOf(fx.storeRoot, receipt.runId);
		const first = taskByKey(parentState, "first");
		const second = taskByKey(parentState, "second");
		const third = taskByKey(parentState, "third");
		for (const task of [first, second, third]) {
			expect(task.task.spec.kind).toBe("workflow");
			expect(task.status).toBe("completed");
		}
		expect(second.task.spec.after).toEqual([
			{ runId: receipt.runId, taskId: first.task.id },
		]);
		expect(third.task.spec.after).toEqual([
			{ runId: receipt.runId, taskId: second.task.id },
		]);
		const firstArtifact = resultArtifactOf(parentState, first);
		const secondArtifact = resultArtifactOf(parentState, second);
		expect(bound).toEqual([
			receipt.runId,
			childRunIdOf(receipt.runId, first),
			childRunIdOf(receipt.runId, second),
			childRunIdOf(receipt.runId, third),
		]);
		const secondRecord = await recordOf(
			fx.storeRoot,
			childRunIdOf(receipt.runId, second),
		);
		expect(secondRecord.input).toEqual({ prefix: "<", doc: { answer: "YES" } });
		expect(secondRecord.parent?.inputArtifacts).toEqual({
			doc: {
				runId: receipt.runId,
				artifactId: firstArtifact.id,
				sha256: firstArtifact.sha256,
			},
		});
		const thirdRecord = await recordOf(
			fx.storeRoot,
			childRunIdOf(receipt.runId, third),
		);
		expect(thirdRecord.input).toEqual({
			prefix: "[",
			doc: { answer: "<YES>" },
		});
		expect(thirdRecord.parent?.inputArtifacts).toEqual({
			doc: {
				runId: receipt.runId,
				artifactId: secondArtifact.id,
				sha256: secondArtifact.sha256,
			},
		});
		// The imported result of each stage is exactly what the next stage consumed.
		expect(secondArtifact.sha256).toBe(
			deriveJsonValueSha256({ answer: "<YES>" }),
		);
		expect(executionOf(parentState, third).nestedIntent).toMatchObject({
			inputsSha256: deriveJsonValueSha256({ doc: secondArtifact.sha256 }),
			resolvedInputSha256: deriveJsonValueSha256(thirdRecord.input),
		});
		await service.shutdown();
	});

	it("rejects malformed artifact input declarations before anything is declared", async () => {
		const bound: string[] = [];
		const fx = await fixture("input-declaration-errors", [
			"echo-child",
			"consumer-child",
			"non-object-parent",
			"collision-parent",
			"foreign-parent",
		]);
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider([], bound),
		});
		const cases = [
			[
				"non-object-parent",
				"Nested workflow artifact inputs require an object input.",
			],
			[
				"collision-parent",
				"Nested workflow input name collides with the authored input.",
			],
			[
				"foreign-parent",
				"task data dependency is invalid, unknown, or belongs to another run",
			],
		] as const;
		for (const [name, message] of cases) {
			const receipt = await service.run(name, { value: "yes" });
			await expect(service.wait(receipt.runId)).resolves.toMatchObject({
				status: "failed",
			});
			const state = await stateOf(fx.storeRoot, receipt.runId);
			expect(logsOf(state)).toEqual([message]);
			expect(
				runReasons(await journalEvents(fx.storeRoot, receipt.runId)),
			).toContain("Static workflow source execution failed.");
			// The rejection precedes the first barrier, so neither the producer
			// nor the consumer was persisted and no child run was bound.
			expect(Object.keys(state.tasks)).toHaveLength(0);
			expect(bound.at(-1)).toBe(receipt.runId);
		}
		expect(bound).toHaveLength(cases.length);
		await service.shutdown();
	});

	it("fails the consumer at launch when the merged input misses the child schema", async () => {
		const bound: string[] = [];
		const fx = await fixture("launch-schema", [
			"echo-child",
			"strict-consumer-child",
			"strict-input-parent",
			"lenient-input-parent",
		]);
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider([], bound),
		});
		const strict = await service.run("strict-input-parent", { value: "yes" });
		await expect(service.wait(strict.runId)).resolves.toMatchObject({
			status: "failed",
		});
		const strictState = await stateOf(fx.storeRoot, strict.runId);
		const strictFirst = taskByKey(strictState, "first");
		const strictSecond = taskByKey(strictState, "second");
		expect(strictFirst.status).toBe("completed");
		expect(strictSecond.status).toBe("failed");
		expect(strictSecond.task.spec.disposition).toBe("required");
		expect(terminalOf(strictState, strictSecond)).toMatchObject({
			outcome: "failed",
			evidence: {
				kind: "workflow",
				stage: "nested-input",
				message: "Nested workflow input does not match its schema.",
			},
		});
		// The failure precedes intent, so no child run was bound or created.
		expect(executionOf(strictState, strictSecond).nestedIntent).toBeUndefined();
		expect(bound).toEqual([
			strict.runId,
			childRunIdOf(strict.runId, strictFirst),
		]);
		await expect(
			service.status(childRunIdOf(strict.runId, strictSecond)),
		).rejects.toThrow();
		expect(
			runReasons(await journalEvents(fx.storeRoot, strict.runId)),
		).toContain("A required workflow task did not complete.");

		const lenient = await service.run("lenient-input-parent", { value: "yes" });
		await expect(service.wait(lenient.runId)).resolves.toMatchObject({
			status: "completed-degraded",
			output: { answer: "fallback" },
		});
		const lenientState = await stateOf(fx.storeRoot, lenient.runId);
		const lenientSecond = taskByKey(lenientState, "second");
		expect(lenientSecond.task.spec.disposition).toBe("optional");
		expect(lenientSecond.status).toBe("failed");
		expect(terminalOf(lenientState, lenientSecond)).toMatchObject({
			outcome: "failed",
			evidence: {
				kind: "workflow",
				stage: "nested-input",
				message: "Nested workflow input does not match its schema.",
			},
		});
		expect(bound).toHaveLength(4);
		await service.shutdown();
	});

	it("launches the consumer exactly once after a restart between intent and launch", async () => {
		const gate = deferred<void>();
		const fx = await fixture("restart-intent", [
			"echo-child",
			"consumer-child",
			"input-parent",
		]);
		const firstBound: string[] = [];
		// Binds arrive as parent, producer child, consumer child; the third
		// bind parks the parent between the consumer's intent and its launch.
		const gated = gatedProvider(firstBound, 3, gate.promise);
		const first = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: gated.provider,
		});
		const receipt = await first.run("input-parent", { value: "yes" });
		await until(() => gated.blocked.length > 0);
		const parentState = await stateOf(fx.storeRoot, receipt.runId);
		const producer = taskByKey(parentState, "first");
		const consumer = taskByKey(parentState, "second");
		const producerRunId = childRunIdOf(receipt.runId, producer);
		const consumerRunId = childRunIdOf(receipt.runId, consumer);
		expect(gated.blocked).toEqual([consumerRunId]);
		expect(producer.status).toBe("completed");
		const consumerExecution = executionOf(parentState, consumer);
		expect(consumerExecution.phase).toBe("nested-intended");
		expect(consumerExecution.nestedLaunch).toBeUndefined();
		const storeRoot = await crashSnapshot(fx, [receipt.runId, producerRunId]);
		const isConsumer = (data: Record<string, unknown>) =>
			data.executionId === consumerExecution.execution.id;
		expect(
			sequencesOf(
				await journalEvents(storeRoot, receipt.runId),
				"task-execution-nested-intended",
				isConsumer,
			),
		).toHaveLength(1);

		const bound: string[] = [];
		const service = await createWorkflowService({
			...fx,
			storeRoot,
			projectTrusted: () => true,
			subagents: provider([], bound),
		});
		try {
			await expect(
				bounded(service.wait(receipt.runId), "parent wait"),
			).resolves.toMatchObject({
				status: "completed",
				output: { answer: "<YES>" },
			});
			expect(bound.filter((runId) => runId === consumerRunId)).toHaveLength(1);
			const events = await journalEvents(storeRoot, receipt.runId);
			expect(
				sequencesOf(events, "task-execution-nested-intended", isConsumer),
			).toHaveLength(1);
			expect(
				sequencesOf(events, "task-execution-nested-launched", isConsumer),
			).toHaveLength(1);
			expect(
				(await eventTypes(storeRoot, consumerRunId)).filter(
					(type) => type === "run-created",
				),
			).toHaveLength(1);
			const resumedState = await stateOf(storeRoot, receipt.runId);
			const artifact = resultArtifactOf(resumedState, producer);
			const childRecord = await recordOf(storeRoot, consumerRunId);
			expect(childRecord.input).toEqual({
				prefix: "<",
				doc: { answer: "YES" },
			});
			expect(deriveJsonValueSha256(childRecord.input)).toBe(
				consumerExecution.nestedIntent?.resolvedInputSha256,
			);
			expect(childRecord.parent?.inputArtifacts).toEqual({
				doc: {
					runId: receipt.runId,
					artifactId: artifact.id,
					sha256: artifact.sha256,
				},
			});
			await expect(service.status(consumerRunId)).resolves.toMatchObject({
				status: "completed",
				depth: 1,
				parent: { runId: receipt.runId, taskId: consumer.task.id },
				output: { answer: "<YES>" },
			});
		} finally {
			await bounded(service.shutdown(), "shutdown").catch(() => undefined);
			gate.resolve();
			await bounded(first.shutdown(), "first shutdown").catch(() => undefined);
		}
	});

	it("exposes injected artifact identities under the child's lineage view", async () => {
		const fx = await fixture("input-lineage", [
			"echo-child",
			"consumer-child",
			"input-parent",
		]);
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider([], []),
		});
		const receipt = await service.run("input-parent", { value: "yes" });
		await service.wait(receipt.runId);
		const parentState = await stateOf(fx.storeRoot, receipt.runId);
		const producer = taskByKey(parentState, "first");
		const consumer = taskByKey(parentState, "second");
		const artifact = resultArtifactOf(parentState, producer);
		const consumerRunId = childRunIdOf(receipt.runId, consumer);
		const expected = {
			runId: receipt.runId,
			taskId: consumer.task.id,
			inputArtifacts: {
				doc: {
					runId: receipt.runId,
					artifactId: artifact.id,
					sha256: artifact.sha256,
				},
			},
		};
		const view = await service.status(consumerRunId);
		expect(view.parent).toEqual(expected);
		expect(Object.keys(view.parent?.inputArtifacts.doc ?? {}).sort()).toEqual([
			"artifactId",
			"runId",
			"sha256",
		]);
		// The producer child injected nothing and says so explicitly.
		await expect(
			service.status(childRunIdOf(receipt.runId, producer)),
		).resolves.toMatchObject({
			parent: { runId: receipt.runId, inputArtifacts: {} },
		});
		await service.shutdown();
		// `workflow_status` is `service.status` on a fresh instance: the same
		// lineage must come back from durable state alone.
		const reopened = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider([], []),
		});
		const reread = await reopened.status(consumerRunId);
		expect(reread.parent).toEqual(expected);
		expect(reread).toMatchObject({
			status: "completed",
			depth: 1,
			output: { answer: "<YES>" },
		});
		await reopened.shutdown();
	});

	it("does not launch the consumer before its producer completes", async () => {
		const bound: string[] = [];
		const fx = await fixture("input-readiness", [
			"echo-child",
			"consumer-child",
			"input-parent",
		]);
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider([], bound),
		});
		const receipt = await service.run("input-parent", { value: "yes" });
		await expect(service.wait(receipt.runId)).resolves.toMatchObject({
			status: "completed",
		});
		const state = await stateOf(fx.storeRoot, receipt.runId);
		const producer = taskByKey(state, "first");
		const consumer = taskByKey(state, "second");
		const consumerExecutionId = executionOf(state, consumer).execution.id;
		const events = await journalEvents(fx.storeRoot, receipt.runId);
		const producerCompleted = sequencesOf(
			events,
			"task-status-changed",
			(data) => data.taskId === producer.task.id && data.to === "completed",
		);
		expect(producerCompleted).toHaveLength(1);
		const isConsumer = (data: Record<string, unknown>) =>
			data.executionId === consumerExecutionId;
		const [consumerCreated] = sequencesOf(
			events,
			"task-execution-created",
			(data) =>
				(data.execution as { id?: string } | undefined)?.id ===
				consumerExecutionId,
		);
		const [consumerIntended] = sequencesOf(
			events,
			"task-execution-nested-intended",
			isConsumer,
		);
		const [consumerLaunched] = sequencesOf(
			events,
			"task-execution-nested-launched",
			isConsumer,
		);
		const completedAt = producerCompleted[0] as number;
		expect(consumerCreated).toBeGreaterThan(completedAt);
		expect(consumerIntended).toBeGreaterThan(completedAt);
		expect(consumerLaunched).toBeGreaterThan(consumerIntended as number);
		// Child runs were bound in dependency order.
		expect(bound).toEqual([
			receipt.runId,
			childRunIdOf(receipt.runId, producer),
			childRunIdOf(receipt.runId, consumer),
		]);
		await service.shutdown();
	});

	it("runs a child workflow as a linked run and returns its output", async () => {
		const calls: string[] = [];
		const bound: string[] = [];
		const fx = await fixture("parent-child", ["echo-child", "nest-parent"]);
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider(calls, bound),
		});
		const receipt = await service.run("nest-parent", { value: "yes" });
		const view = await service.wait(receipt.runId);
		expect(view).toMatchObject({
			status: "completed",
			output: { answer: "YES" },
			depth: 0,
		});
		expect(view.parent).toBeUndefined();
		expect(calls).toEqual([]);
		expect(bound).toHaveLength(2);
		expect(bound[0]).toBe(receipt.runId);
		const childRunId = bound[1] as string;
		await expect(service.status(childRunId)).resolves.toMatchObject({
			status: "completed",
			definitionName: "echo-child",
			depth: 1,
			parent: { runId: receipt.runId },
			output: { answer: "YES" },
		});
		const types = await eventTypes(fx.storeRoot, receipt.runId);
		const nested = types.filter((type) =>
			[
				"task-execution-created",
				"task-execution-nested-intended",
				"task-execution-nested-launched",
				"task-execution-nested-settled",
				"artifact-declared",
				"task-execution-nested-output-imported",
				"task-execution-terminal",
			].includes(type),
		);
		expect(nested).toEqual([
			"task-execution-created",
			"task-execution-nested-intended",
			"task-execution-nested-launched",
			"task-execution-nested-settled",
			"artifact-declared",
			"task-execution-nested-output-imported",
			"task-execution-terminal",
			"artifact-declared",
		]);
		await service.shutdown();
	});

	it("nests three levels and flows the leaf output up through each run", async () => {
		const calls: string[] = [];
		const bound: string[] = [];
		const fx = await fixture("three-level", ["echo-child", "mid", "top"]);
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider(calls, bound),
		});
		const receipt = await service.run("top", { value: "deep" });
		await expect(service.wait(receipt.runId)).resolves.toMatchObject({
			status: "completed",
			output: { answer: "DEEP" },
			depth: 0,
			definitionName: "top",
		});
		expect(calls).toEqual([]);
		expect(bound).toHaveLength(3);
		expect(new Set(bound).size).toBe(3);
		expect(bound[0]).toBe(receipt.runId);
		const [rootRunId, childRunId, grandchildRunId] = bound as [
			WorkflowRunId,
			WorkflowRunId,
			WorkflowRunId,
		];
		const rootTask = nestedTaskOf(await stateOf(fx.storeRoot, rootRunId));
		expect(childRunId).toBe(
			deriveNestedWorkflowRunId(rootRunId, rootTask.task.id, 1),
		);
		const childTask = nestedTaskOf(await stateOf(fx.storeRoot, childRunId));
		expect(grandchildRunId).toBe(
			deriveNestedWorkflowRunId(childRunId, childTask.task.id, 1),
		);
		await expect(service.status(childRunId)).resolves.toMatchObject({
			status: "completed",
			definitionName: "mid",
			depth: 1,
			parent: { runId: rootRunId, taskId: rootTask.task.id },
			output: { answer: "DEEP" },
		});
		await expect(service.status(grandchildRunId)).resolves.toMatchObject({
			status: "completed",
			definitionName: "echo-child",
			depth: 2,
			parent: { runId: childRunId, taskId: childTask.task.id },
			output: { answer: "DEEP" },
		});
		expect(
			(await recordOf(fx.storeRoot, grandchildRunId)).parent
				?.ancestorDefinitionIdentities,
		).toHaveLength(2);
		await service.shutdown();
	});

	it("rejects a declaration that would exceed the depth bound and fails every ancestor", async () => {
		const bound: string[] = [];
		const fx = await fixture("depth-bound", [
			"echo-child",
			"depth-3",
			"depth-2",
			"depth-1",
			"depth-0",
		]);
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider([], bound),
		});
		const receipt = await service.run("depth-0", { value: "yes" });
		// A source-level failure is durable as `failed`, so `wait` resolves with
		// the terminal view instead of rejecting.
		await expect(service.wait(receipt.runId)).resolves.toMatchObject({
			status: "failed",
			depth: 0,
		});
		// Root plus three linked descendants; the depth-3 run never launched one.
		expect(bound).toHaveLength(4);
		const deepest = bound[3] as WorkflowRunId;
		await expect(service.status(deepest)).resolves.toMatchObject({
			status: "failed",
			definitionName: "depth-3",
			depth: 3,
		});
		const deepestState = await stateOf(fx.storeRoot, deepest);
		expect(Object.keys(deepestState.tasks)).toHaveLength(0);
		expect(logsOf(deepestState)).toEqual([
			"Nested workflow depth bound exceeded.",
		]);
		expect(runReasons(await journalEvents(fx.storeRoot, deepest))).toContain(
			"Static workflow source execution failed.",
		);
		for (const [index, runId] of bound.slice(0, 3).entries()) {
			const state = await stateOf(fx.storeRoot, runId as WorkflowRunId);
			expect(state.status).toBe("failed");
			const task = nestedTaskOf(state);
			expect(task.status).toBe("failed");
			expect(terminalOf(state, task)).toMatchObject({
				outcome: "failed",
				evidence: {
					kind: "nested-workflow",
					childRunId: bound[index + 1],
					status: "failed",
				},
			});
		}
		await service.shutdown();
	});

	it("rejects direct recursion and a two-definition cycle at the recursive declaration", async () => {
		const bound: string[] = [];
		const fx = await fixture("recursion", ["selfish", "cycle-a", "cycle-b"]);
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider([], bound),
		});
		const direct = await service.run("selfish", { value: "yes" });
		await expect(service.wait(direct.runId)).resolves.toMatchObject({
			status: "failed",
		});
		const directState = await stateOf(fx.storeRoot, direct.runId);
		expect(Object.keys(directState.tasks)).toHaveLength(0);
		expect(logsOf(directState)).toEqual([
			"Nested workflow recursion is not allowed.",
		]);
		expect(bound).toEqual([direct.runId]);

		const cycle = await service.run("cycle-a", { value: "yes" });
		await expect(service.wait(cycle.runId)).resolves.toMatchObject({
			status: "completed",
			output: { answer: "Nested workflow recursion is not allowed." },
		});
		expect(bound).toHaveLength(3);
		const cycleChild = bound[2] as WorkflowRunId;
		await expect(service.status(cycleChild)).resolves.toMatchObject({
			status: "completed",
			definitionName: "cycle-b",
			depth: 1,
			parent: { runId: cycle.runId },
		});
		expect(
			Object.keys((await stateOf(fx.storeRoot, cycleChild)).tasks),
		).toHaveLength(0);
		await service.shutdown();
	});

	it("rejects the 65th nested workflow task and fails the run", async () => {
		const bound: string[] = [];
		const fx = await fixture("task-bound", ["echo-child", "many"]);
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider([], bound),
		});
		const receipt = await service.run("many", { value: "yes" });
		await expect(service.wait(receipt.runId)).resolves.toMatchObject({
			status: "failed",
		});
		const state = await stateOf(fx.storeRoot, receipt.runId);
		expect(logsOf(state)).toEqual(["nested workflow task bound exceeded"]);
		// The rejection precedes the first barrier, so nothing was declared or launched.
		expect(Object.keys(state.tasks)).toHaveLength(0);
		expect(bound).toEqual([receipt.runId]);
		await service.shutdown();
	});

	it("rejects an unknown child name and a child input that fails the child schema", async () => {
		const bound: string[] = [];
		const fx = await fixture("declaration-errors", [
			"echo-child",
			"unknown-parent",
			"bad-input-parent",
		]);
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider([], bound),
		});
		const unknown = await service.run("unknown-parent", { value: "yes" });
		await expect(service.wait(unknown.runId)).resolves.toMatchObject({
			status: "completed",
			output: { answer: "Nested workflow definition is not discovered." },
		});
		const badInput = await service.run("bad-input-parent", { value: "yes" });
		await expect(service.wait(badInput.runId)).resolves.toMatchObject({
			status: "completed",
			output: { answer: "Nested workflow input does not match its schema." },
		});
		expect(bound).toEqual([unknown.runId, badInput.runId]);
		for (const runId of bound) {
			expect(
				Object.keys(
					(await stateOf(fx.storeRoot, runId as WorkflowRunId)).tasks,
				),
			).toHaveLength(0);
		}
		await service.shutdown();
	});

	it("runs a child with a delegated agent task under the child's owner and settles its usage", async () => {
		const fx = await fixture("agent-child", ["agent-child", "agent-parent"]);
		const delegated = agentProvider();
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		const receipt = await service.run("agent-parent", { value: "yes" });
		await expect(service.wait(receipt.runId)).resolves.toMatchObject({
			status: "completed",
			output: { answer: "from child" },
		});
		expect(delegated.bound).toHaveLength(2);
		const childRunId = delegated.bound[1] as WorkflowRunId;
		const parentClient = delegated.clients.get(receipt.runId);
		const childClient = delegated.clients.get(childRunId);
		if (!parentClient || !childClient) throw new Error("missing clients");
		for (const method of ["preflight", "launch", "wait", "release"] as const) {
			expect(parentClient[method]).not.toHaveBeenCalled();
			expect(childClient[method]).toHaveBeenCalled();
		}
		for (const method of ["preflight", "launch", "release"] as const) {
			expect(childClient[method]).toHaveBeenCalledOnce();
		}
		const preflight = vi.mocked(childClient.preflight).mock.results[0];
		if (preflight?.type !== "return") throw new Error("preflight failed");
		expect((await preflight.value).launchPlan.ownerId).toBe(
			`pi-workflow:${childRunId}`,
		);
		await expect(service.status(childRunId)).resolves.toMatchObject({
			status: "completed",
			definitionName: "agent-child",
			depth: 1,
			parent: { runId: receipt.runId },
			output: { answer: "from child" },
		});
		const parentState = await stateOf(fx.storeRoot, receipt.runId);
		const task = nestedTaskOf(parentState);
		expect(task.status).toBe("completed");
		expect(terminalOf(parentState, task)).toMatchObject({
			outcome: "completed",
			evidence: {
				kind: "nested-workflow",
				childRunId,
				status: "completed",
				usage: {
					cost: CHILD_USAGE.cost,
					totalTokens: CHILD_USAGE.totalTokens,
					childRuntimeMs: CHILD_RUNTIME_MS,
				},
				usageComplete: true,
			},
		});
		await service.shutdown();
	});

	it("propagates a child failure to the parent by disposition", async () => {
		const bound: string[] = [];
		const fx = await fixture("child-failure", [
			"bad-output-child",
			"strict-parent",
			"lenient-parent",
		]);
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider([], bound),
		});
		const strict = await service.run("strict-parent", { value: "yes" });
		await expect(service.wait(strict.runId)).resolves.toMatchObject({
			status: "failed",
		});
		const strictChild = bound[1] as WorkflowRunId;
		await expect(service.status(strictChild)).resolves.toMatchObject({
			status: "failed",
			definitionName: "bad-output-child",
		});
		expect(
			runReasons(await journalEvents(fx.storeRoot, strictChild)),
		).toContain("Workflow output finalization failed.");
		const strictState = await stateOf(fx.storeRoot, strict.runId);
		const strictTask = nestedTaskOf(strictState);
		expect(strictTask.status).toBe("failed");
		expect(strictTask.task.spec.disposition).toBe("required");
		expect(terminalOf(strictState, strictTask)).toMatchObject({
			outcome: "failed",
			evidence: { kind: "nested-workflow", status: "failed" },
		});
		expect(
			runReasons(await journalEvents(fx.storeRoot, strict.runId)),
		).toContain("A required workflow task did not complete.");

		const lenient = await service.run("lenient-parent", { value: "yes" });
		await expect(service.wait(lenient.runId)).resolves.toMatchObject({
			status: "completed-degraded",
			output: { answer: "fallback" },
		});
		const lenientChild = bound[3] as WorkflowRunId;
		await expect(service.status(lenientChild)).resolves.toMatchObject({
			status: "failed",
		});
		const lenientState = await stateOf(fx.storeRoot, lenient.runId);
		const lenientTask = nestedTaskOf(lenientState);
		expect(lenientTask.task.spec.disposition).toBe("optional");
		expect(lenientTask.status).toBe("failed");
		await service.shutdown();
	});

	it("cascades an explicit parent stop into the child run", async () => {
		const fx = await fixture("stop-cascade", [
			"blocking-child",
			"blocking-parent",
		]);
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider([], []),
		});
		const receipt = await service.run("blocking-parent", { value: "yes" });
		const { taskId, childRunId } = await childOf(fx.storeRoot, receipt.runId);
		await untilChildLaunched(service, fx.storeRoot, receipt.runId, childRunId);
		try {
			await expect(
				bounded(service.stop(receipt.runId, "operator stop"), "parent stop"),
			).resolves.toMatchObject({ status: "cancelled" });
			await expect(service.status(childRunId)).resolves.toMatchObject({
				status: "cancelled",
				depth: 1,
				parent: { runId: receipt.runId, taskId },
			});
			const parentState = await stateOf(fx.storeRoot, receipt.runId);
			const task = nestedTaskOf(parentState);
			expect(task.status).toBe("cancelled");
			expect(terminalOf(parentState, task)).toMatchObject({
				outcome: "cancelled",
				evidence: { kind: "nested-workflow", childRunId, status: "cancelled" },
			});
			await expect(
				bounded(service.wait(receipt.runId), "parent wait"),
			).resolves.toMatchObject({ status: "cancelled" });
		} finally {
			await bounded(service.shutdown(), "shutdown").catch(() => undefined);
		}
	});

	it("cascades the parent deadline into the child run", async () => {
		const fx = await fixture("deadline-cascade", [
			"blocking-child",
			"deadline-parent",
		]);
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider([], []),
		});
		const receipt = await service.run("deadline-parent", { value: "yes" });
		const { childRunId } = await childOf(fx.storeRoot, receipt.runId);
		await untilChildLaunched(service, fx.storeRoot, receipt.runId, childRunId);
		try {
			const parentRecord = await recordOf(fx.storeRoot, receipt.runId);
			const childRecord = await recordOf(fx.storeRoot, childRunId);
			expect(parentRecord.effectiveTimeoutMs).toBe(3_000);
			expect(childRecord.effectiveTimeoutMs).toBeLessThanOrEqual(3_000);
			expect(Date.parse(childRecord.deadlineAt)).toBeLessThanOrEqual(
				Date.parse(parentRecord.deadlineAt),
			);
			await expect(
				bounded(service.wait(receipt.runId), "parent wait"),
			).resolves.toMatchObject({ status: "cancelled" });
			await expect(service.status(childRunId)).resolves.toMatchObject({
				status: "cancelled",
			});
			const parentState = await stateOf(fx.storeRoot, receipt.runId);
			expect(
				runReasons(await journalEvents(fx.storeRoot, receipt.runId)),
			).toContain("Workflow deadline exceeded.");
			const task = nestedTaskOf(parentState);
			expect(task.status).toBe("cancelled");
			expect(terminalOf(parentState, task)).toMatchObject({
				outcome: "cancelled",
				evidence: { kind: "nested-workflow", childRunId, status: "cancelled" },
			});
		} finally {
			await bounded(service.shutdown(), "shutdown").catch(() => undefined);
		}
	});

	it("resumes a launched child after restart instead of recreating it", async () => {
		const run = await blockedNestedRun("restart-resume");
		const second = vi.fn((_context: EmptyContext) => ({ answer: "second" }));
		const bound: string[] = [];
		const service = await createWorkflowService({
			...run.fx,
			storeRoot: run.storeRoot,
			projectTrusted: () => true,
			subagents: provider([], bound),
			supportTasks: [slow.registration(second)],
		});
		await expect(service.wait(run.parentRunId)).resolves.toMatchObject({
			status: "completed",
			output: { answer: "second" },
		});
		expect(second).toHaveBeenCalledTimes(1);
		expect(run.execute).toHaveBeenCalledTimes(1);
		expect(bound.sort()).toEqual([run.parentRunId, run.childRunId].sort());
		await expect(service.status(run.childRunId)).resolves.toMatchObject({
			status: "completed",
			depth: 1,
			parent: { runId: run.parentRunId },
			output: { answer: "second" },
		});
		const parentTypes = await eventTypes(run.storeRoot, run.parentRunId);
		expect(
			parentTypes.filter((type) => type === "task-execution-nested-launched"),
		).toHaveLength(1);
		expect(
			parentTypes.filter((type) => type === "task-execution-created"),
		).toHaveLength(1);
		const childTypes = await eventTypes(run.storeRoot, run.childRunId);
		expect(childTypes.filter((type) => type === "run-created")).toHaveLength(1);
		expect(
			childTypes.filter((type) => type === "task-execution-created"),
		).toHaveLength(1);
		await service.shutdown();
		await run.service.shutdown();
		run.gate.resolve();
	});

	it("rejects resuming a launched child whose definition drifted", async () => {
		const run = await blockedNestedRun("restart-drift");
		await writeFile(
			path.join(run.fx.cwd, "workflows", "slow-child.workflow.ts"),
			definition(
				"slow-child",
				`return ctx.support("slow", slow({ parameters: {} }));`,
				{
					imports: `import { slow } from ${JSON.stringify(TOOLS_MODULE)};\n`,
					description: "Drifted",
				},
			),
		);
		const second = vi.fn((_context: EmptyContext) => ({ answer: "second" }));
		const service = await createWorkflowService({
			...run.fx,
			storeRoot: run.storeRoot,
			projectTrusted: () => true,
			subagents: provider([], []),
			supportTasks: [slow.registration(second)],
		});
		// The parent replays its source first: `ctx.workflow` now resolves the
		// drifted child identity, so the persisted task prefix no longer matches
		// and the parent fails at source execution before any nested launch.
		await expect(service.wait(run.parentRunId)).resolves.toMatchObject({
			status: "failed",
		});
		expect(second).not.toHaveBeenCalled();
		const parentState = await stateOf(run.storeRoot, run.parentRunId);
		expect(
			runReasons(await journalEvents(run.storeRoot, run.parentRunId)),
		).toContain("Static workflow source execution failed.");
		const task = nestedTaskOf(parentState);
		expect(task.status).toBe("running");
		expect(
			(await eventTypes(run.storeRoot, run.parentRunId)).filter(
				(type) => type === "task-execution-nested-launched",
			),
		).toHaveLength(1);
		const childView = await service.status(run.childRunId);
		expect(["running", "waiting"]).toContain(childView.status);
		expect(childView).toMatchObject({
			depth: 1,
			parent: { runId: run.parentRunId },
		});
		await service.shutdown();
		await run.service.shutdown();
		run.gate.resolve();
	});

	it("stops the root before the child on shutdown and cancels both", async () => {
		const fx = await fixture("shutdown-cascade", [
			"blocking-child",
			"blocking-parent",
		]);
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider([], []),
		});
		const receipt = await service.run("blocking-parent", { value: "yes" });
		const { childRunId } = await childOf(fx.storeRoot, receipt.runId);
		await untilChildLaunched(service, fx.storeRoot, receipt.runId, childRunId);
		await bounded(service.shutdown(), "shutdown");
		const parentState = await stateOf(fx.storeRoot, receipt.runId);
		const childState = await stateOf(fx.storeRoot, childRunId);
		expect(parentState.status).toBe("cancelled");
		expect(childState.status).toBe("cancelled");
		expect(
			runReasons(await journalEvents(fx.storeRoot, receipt.runId)),
		).toContain("Pi workflow session is shutting down.");
		const task = nestedTaskOf(parentState);
		expect(task.status).toBe("cancelled");
		expect(terminalOf(parentState, task)).toMatchObject({
			outcome: "cancelled",
			evidence: { kind: "nested-workflow", childRunId, status: "cancelled" },
		});
	});

	it("reports the child's lineage from its own run id", async () => {
		const bound: string[] = [];
		const fx = await fixture("lineage", ["echo-child", "nest-parent"]);
		const service = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider([], bound),
		});
		const receipt = await service.run("nest-parent", { value: "yes" });
		await service.wait(receipt.runId);
		const { taskId, childRunId } = await childOf(fx.storeRoot, receipt.runId);
		expect(bound[1]).toBe(childRunId);
		const view = await service.status(childRunId);
		expect(view).toMatchObject({
			runId: childRunId,
			depth: 1,
			parent: { runId: receipt.runId, taskId },
		});
		expect(Object.keys(view.parent ?? {}).sort()).toEqual([
			"inputArtifacts",
			"runId",
			"taskId",
		]);
		const record = await recordOf(fx.storeRoot, childRunId);
		expect(record.parent).toMatchObject({ runId: receipt.runId, taskId });
		expect(record.parent?.ancestorDefinitionIdentities).toEqual([
			(await recordOf(fx.storeRoot, receipt.runId)).definitionIdentitySha256,
		]);
		await service.shutdown();
		// A fresh service reads the same lineage from durable state alone.
		const reopened = await createWorkflowService({
			...fx,
			projectTrusted: () => true,
			subagents: provider([], []),
		});
		await expect(reopened.status(childRunId)).resolves.toMatchObject({
			status: "completed",
			depth: 1,
			parent: { runId: receipt.runId, taskId },
		});
		await reopened.shutdown();
	});
});
