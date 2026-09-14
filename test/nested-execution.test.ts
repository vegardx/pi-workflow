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
import { deriveNestedWorkflowRunId } from "../src/execution.js";
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

const AGENT_BODY = `return ctx.agent("answer", {
      agent: "researcher",
      task: { goal: "Answer", context: [], instructions: ["Return structured output."] },
      contextMode: "fresh",
      tools: ["read"],
      preloadSkills: [],
      contextScopes: ["project"],
      workspace: { mode: "read-only", cwd: ctx.cwd },
      outputSchema: ${ANSWER_SCHEMA},
      limits: { cumulativeRuntimeMs: 300000, attemptTimeoutMs: 300000, totalTokens: 1000000, cost: 10, outputBytes: 1024, workspaceWriteBytes: 0, retries: 0, resumes: 0 }
    });`;

const BLOCKING_BODY = `return new Promise((resolve) => {
      ctx.signal.addEventListener("abort", () => resolve({ answer: "aborted" }), { once: true });
    });`;

const DEFINITIONS = {
	"echo-child": definition("echo-child", ECHO_BODY),
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
	return journal
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
		expect(Object.keys(view.parent ?? {}).sort()).toEqual(["runId", "taskId"]);
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
