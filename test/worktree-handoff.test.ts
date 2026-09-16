import { createHash, randomUUID } from "node:crypto";
import {
	access,
	cp,
	mkdir,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
	createEventBus,
	type EventBus,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentLaunchPlan,
	canonicalSha256,
	type RunResult,
	SUBAGENT_RUNTIME_CONTRACT,
	type SubagentClient,
	type SubagentRequest,
	type SubagentService,
	type WorktreeRecord,
} from "@vegardx/pi-subagent";
import { registerSubagentServiceProvider } from "@vegardx/pi-subagent/service-provider";
import { type Static, Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
	WORKFLOW_HANDOFF_FORMAT_SHA256,
	type WorkflowArtifactRef,
	type WorkflowHandoffDescriptor,
} from "../src/contracts.js";
import type {
	TaskExecutionProjection,
	WorkflowStateProjection,
	WorkflowTaskProjection,
} from "../src/events.js";
import { deriveTaskExecutionId } from "../src/execution.js";
import type { WorkflowJournalEvent } from "../src/persistence/journal.js";
import { acquireWorkflowRunLease } from "../src/persistence/run-lease.js";
import { reduceWorkflowEvents } from "../src/reducer.js";
import { createWorkflowService, type WorkflowService } from "../src/service.js";
import {
	createWorkflowSubagentProvider,
	type WorkflowSubagentBinding,
	type WorkflowSubagentProvider,
} from "../src/subagent-provider.js";
import {
	defineSupportTask,
	type SupportTaskExecutionContext,
} from "../src/support.js";

// Spec constants (handoff-adoption-spec.md D4, D7, 1.1, 4.4, 5). Literal on
// purpose: the tests derive expectations from the spec, not from src.
const PATCH_MEDIA_TYPE = "application/x-git-format-patch" as const;
const HANDOFF_BOUND_BYTES = 16 * 1024 * 1024;
const HANDOFF_ABSENT_MESSAGE = "Completed worktree task captured no handoff.";
const HANDOFF_BOUND_MESSAGE = "Workflow handoff exceeds the import bound.";
/** pi-subagent's fixed `WorktreeError` for an export above the bound (D7). */
const HANDOFF_EXPORT_REFUSAL = "handoff export exceeds byte limit";
const HANDOFF_UNVERIFIED_MESSAGE =
	"Completed worktree task has no verified handoff artifact.";
const BASELINE_HEAD = "b".repeat(40);
/** pi-subagent private worktree facts that must never reach the journal or state (D5). */
const PRIVATE_REPO = "/private/repo";
const PRIVATE_MARKERS = [
	PRIVATE_REPO,
	".pi/worktrees",
	"pi-subagent/reservations",
	"refs/pi-subagent",
	"session.jsonl",
] as const;

const WORKTREE_SUCCESS_LADDER = [
	"task-execution-child-settled",
	"artifact-declared",
	"task-execution-artifact-imported",
	"artifact-declared",
	"task-execution-handoff-imported",
	"task-execution-release-intended",
	"task-execution-released",
	"task-execution-terminal",
	"task-status-changed",
] as const;

function root(name: string): string {
	return path.resolve(
		".pi",
		"test-worktree-handoff",
		`${name}-${randomUUID()}`,
	);
}

function sha256(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

/** One distinct handoff commit per attempt, so generations and retries never collide. */
function commitFor(attemptId: string): string {
	return createHash("sha1").update(attemptId).digest("hex");
}

/** git's fixed mbox separator followed by a single rendered commit (spec 4.4 step 6). */
function patchFor(commit: string): Buffer {
	return Buffer.from(
		`From ${commit} Mon Sep 17 00:00:00 2001\nFrom: Agent <agent@example.com>\nSubject: [PATCH] change\n\n---\n a.txt | 1 +\n`,
	);
}

function unavailableClient(): SubagentClient {
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
		exportHandoff: unavailable,
	} as unknown as SubagentClient;
}

type ChildFailure = NonNullable<RunResult["failure"]>;

/** The refusal pi-subagent throws when the handoff is larger than `maxBytes`. */
function boundRefusal(): Error {
	const refusal = new Error(HANDOFF_EXPORT_REFUSAL);
	refusal.name = "WorktreeError";
	return refusal;
}

function backoffFailure(): ChildFailure {
	return {
		code: "provider-transient",
		origin: "provider",
		retry: "backoff",
		message: "provider hiccup",
		guidance: "Try again later.",
	};
}

interface ChildOutcome {
	readonly status: RunResult["status"];
	readonly failure?: ChildFailure;
	/** "captured": the worktree record names a handoff commit; "none": a record without one; absent: read-only child. */
	readonly handoff?: "captured" | "none";
}

interface FakeChild {
	readonly runId: string;
	readonly attemptId: string;
}

function childIds(nonce: string, launch: number): FakeChild {
	return {
		runId: `run_child${nonce}${launch}`,
		attemptId: `attempt_child${nonce}${launch}`,
	};
}

/** pi-subagent's private worktree record for a child attempt; only its identity may be persisted (D5). */
function worktreeRecord(child: FakeChild, captured: boolean): WorktreeRecord {
	return {
		schema: "pi-subagent-worktree",
		contractRevision: 6,
		runId: child.runId,
		attemptId: child.attemptId,
		repositoryRoot: PRIVATE_REPO,
		worktreePath: `${PRIVATE_REPO}/.pi/worktrees/${child.runId}`,
		recordPath: `${PRIVATE_REPO}/.pi/worktrees/${child.runId}.json`,
		branch: `pi-subagent/reservations/${child.runId}`,
		baselineHead: BASELINE_HEAD,
		createdAt: "2026-01-01T00:00:00.000Z",
		...(captured
			? {
					handoffCommit: commitFor(child.attemptId),
					handoffRef: `refs/pi-subagent/handoffs/${child.runId}/${child.attemptId}`,
				}
			: {}),
	} as WorktreeRecord;
}

function childResult(outcome: ChildOutcome, child: FakeChild) {
	const completed = outcome.status === "completed";
	const result: RunResult = {
		runId: child.runId,
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
		workspaceCleanup: outcome.handoff === undefined ? "not-needed" : "proved",
		truncated: false,
	};
	return {
		result,
		output: completed ? "from child" : "",
		sessionFile: `${PRIVATE_REPO}/session.jsonl`,
		handoff:
			outcome.handoff === undefined
				? undefined
				: worktreeRecord(child, outcome.handoff === "captured"),
		structuredOutput: result.structuredOutput,
		error: outcome.failure?.message,
	};
}

interface WorktreeProviderOptions {
	/** Per launch, the successive `wait` outcomes (the last one repeats). */
	readonly launches: readonly (readonly ChildOutcome[])[];
	/** Rejections `exportHandoff` throws, in order, before it starts succeeding. */
	readonly exportFailures?: readonly Error[];
	/** Children journaled by an earlier provider, adopted after a simulated crash. */
	readonly children?: Map<string, string>;
	/** What an adopted child's `wait` re-observes; the finalizer re-reads the exact result before importing. */
	readonly resettle?: ChildOutcome;
}

/**
 * Owner client for worktree children: nonce-based ids so a provider created
 * after a restart never re-mints a journaled id, a per-launch script of wait
 * outcomes, `retry` handing out fresh attempt ids, `release`/`reconcile`
 * echoing the current attempt of the named child, and `exportHandoff`
 * rendering the current attempt's single-commit patch.
 */
function worktreeProvider(options: WorktreeProviderOptions) {
	const nonce = randomUUID().replaceAll("-", "").slice(0, 8);
	const children = options.children ?? new Map<string, string>();
	const exportFailures = [...(options.exportFailures ?? [])];
	const calls: string[] = [];
	const exportSnapshots: string[][] = [];
	let launches = 0;
	let waits = 0;
	let attempts = 1;
	let current: FakeChild = childIds(nonce, 0);
	let lastStatus: RunResult["status"] = "completed";
	let taskOwnerId = "";
	const state = {
		children,
		calls,
		exportSnapshots,
		/** Set by a test to sample the durable journal at export time. */
		probe: undefined as (() => Promise<string[]>) | undefined,
		get child() {
			return current;
		},
	};
	const attemptOf = (runId: string) => {
		const attemptId = children.get(runId);
		if (!attemptId) throw new Error(`unknown fake child ${runId}`);
		return attemptId;
	};
	const preflight = vi.fn(async (request: SubagentRequest) => {
		calls.push("preflight");
		const planned = childIds(nonce, launches + 1);
		const draft = {
			schema: "pi-subagent-launch" as const,
			contractRevision: SUBAGENT_RUNTIME_CONTRACT.contractRevision,
			operationId: request.operationId,
			ownerId: "",
			runId: planned.runId,
			attemptId: planned.attemptId,
			agent: request.agent,
			agentDisplayName: "Writer",
			agentPrompt: "Write",
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
				baselineSha256: "c".repeat(64),
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
				workspaceWriteBytes: request.limits.workspaceWriteBytes,
			},
			network: {
				mode: "public-egress" as const,
				blockInternalRanges: true as const,
			},
			outputSchema: structuredClone(request.outputSchema),
			limits: structuredClone(request.limits),
		} satisfies Omit<AgentLaunchPlan, "identitySha256">;
		const plan = { ...draft, ownerId: taskOwnerId };
		return {
			preflightId: "preflight-worktree",
			identitySha256: canonicalSha256(plan),
			expiresAt: "2099-01-01T00:00:00.000Z",
			launchPlan: { ...plan, identitySha256: canonicalSha256(plan) },
		};
	});
	const launch = vi.fn(async () => {
		calls.push("launch");
		launches += 1;
		waits = 0;
		attempts = 1;
		current = childIds(nonce, launches);
		children.set(current.runId, current.attemptId);
		return { ...current, status: "active" as const };
	});
	const wait = vi.fn(async (runId: string) => {
		calls.push("wait");
		if (launches === 0) {
			if (!options.resettle) throw new Error("no child outcome scripted");
			lastStatus = options.resettle.status;
			return childResult(options.resettle, {
				runId,
				attemptId: attemptOf(runId),
			});
		}
		const script = options.launches[launches - 1];
		const outcome = script?.[Math.min(waits, script.length - 1)];
		if (!outcome) throw new Error("no child outcome scripted");
		waits += 1;
		lastStatus = outcome.status;
		return childResult(outcome, current);
	});
	const retry = vi.fn(async () => {
		calls.push("retry");
		attempts += 1;
		current = {
			runId: current.runId,
			attemptId: `${childIds(nonce, launches).attemptId}x${attempts}`,
		};
		children.set(current.runId, current.attemptId);
		return { ...current, status: "active" as const };
	});
	const release = vi.fn(async (runId: string) => {
		calls.push("release");
		return { runId, attemptId: attemptOf(runId), status: lastStatus };
	});
	const reconcile = vi.fn(async (runId: string) => {
		calls.push("reconcile");
		return {
			run: { runId, attemptId: attemptOf(runId), status: lastStatus },
			sandboxProcess: "absent" as const,
			workspace: "retained" as const,
		};
	});
	const exportHandoff = vi.fn(
		async (runId: string, _options: { maxBytes: number }) => {
			calls.push("exportHandoff");
			if (state.probe) exportSnapshots.push(await state.probe());
			const failure = exportFailures.shift();
			if (failure) throw failure;
			const attemptId = attemptOf(runId);
			const handoffCommit = commitFor(attemptId);
			const content = patchFor(handoffCommit);
			return {
				ref: {
					runId,
					attemptId,
					baselineHead: BASELINE_HEAD,
					handoffCommit,
					format: "git-format-patch" as const,
					sha256: sha256(content),
					bytes: content.byteLength,
					mediaType: PATCH_MEDIA_TYPE,
				},
				content,
			};
		},
	);
	const ownerClient = {
		...unavailableClient(),
		preflight,
		launch,
		wait,
		retry,
		release,
		reconcile,
		exportHandoff,
	} as unknown as SubagentClient;
	const bind = vi.fn(async (runId: string) => {
		taskOwnerId = `pi-workflow:${runId}`;
		return {
			workflowRunId: runId,
			ownerId: taskOwnerId,
			client: ownerClient,
		} satisfies WorkflowSubagentBinding;
	});
	return {
		provider: { bind } as WorkflowSubagentProvider,
		bind,
		preflight,
		launch,
		wait,
		retry,
		release,
		reconcile,
		exportHandoff,
		state,
	};
}

type Delegated = ReturnType<typeof worktreeProvider>;

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

function journalPath(storeRoot: string, runId: string): string {
	return path.join(storeRoot, "runs", runId, "events.jsonl");
}

function artifactsDir(storeRoot: string, runId: string): string {
	return path.join(storeRoot, "runs", runId, "artifacts");
}

async function journalText(storeRoot: string, runId: string): Promise<string> {
	try {
		return await readFile(journalPath(storeRoot, runId), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

async function journalEvents(
	storeRoot: string,
	runId: string,
): Promise<WorkflowJournalEvent[]> {
	const journal = await journalText(storeRoot, runId);
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

/** Task-level journal events: the scheduler's waiting/running polling is not part of any ladder. */
function taskEvents(events: readonly WorkflowJournalEvent[]) {
	return events.filter((event) => event.type !== "run-status-changed");
}

function countOf(types: readonly string[], type: string): number {
	return types.filter((candidate) => candidate === type).length;
}

function dataOf<T>(event: WorkflowJournalEvent | undefined): T {
	if (!event) throw new Error("missing journal event");
	return event.data as T;
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

function artifactsOf(
	state: WorkflowStateProjection,
	task: WorkflowTaskProjection,
	output: "result" | "handoff",
): WorkflowArtifactRef[] {
	return Object.values(state.artifacts).filter(
		(artifact) =>
			artifact.producerTaskId === task.task.id &&
			artifact.producerExecutionId === task.currentExecutionId &&
			artifact.output === output,
	);
}

function onlyArtifact(
	state: WorkflowStateProjection,
	task: WorkflowTaskProjection,
	output: "result" | "handoff",
): WorkflowArtifactRef {
	const matches = artifactsOf(state, task, output);
	expect(matches).toHaveLength(1);
	return matches[0] as WorkflowArtifactRef;
}

/** The descriptor spec 1.2 defines, built from durable identity and the fake child. */
function expectedDescriptor(
	state: WorkflowStateProjection,
	task: WorkflowTaskProjection,
	child: FakeChild,
): WorkflowHandoffDescriptor {
	const handoffCommit = commitFor(child.attemptId);
	const content = patchFor(handoffCommit);
	return {
		artifactId: onlyArtifact(state, task, "handoff").id,
		runId: state.runId,
		producerTaskId: task.task.id,
		producerExecutionId: executionOf(state, task).execution.id,
		subagentRunId: child.runId,
		subagentAttemptId: child.attemptId,
		baselineHead: BASELINE_HEAD,
		handoffCommit,
		format: "git-format-patch",
		mediaType: PATCH_MEDIA_TYPE,
		sha256: sha256(content),
		bytes: content.byteLength,
	};
}

/** Every message down the cause chain of an error. */
function messagesOf(error: unknown): string[] {
	const messages: string[] = [];
	let cursor: unknown = error;
	while (cursor instanceof Error) {
		messages.push(cursor.message);
		cursor = cursor.cause;
	}
	return messages;
}

async function shutdownQuietly(service: WorkflowService | undefined) {
	if (!service) return;
	await bounded(service.shutdown(), "shutdown").catch(() => undefined);
}

/**
 * Simulates a process crash: the run directory is copied into a fresh store
 * root and its journal is cut right after the first event `cutAfter` selects.
 * Blobs written before the cut stay, exactly as a crash would leave them.
 */
async function crashImageAfter(
	fx: { cwd: string; storeRoot: string },
	runId: string,
	cutAfter: (event: WorkflowJournalEvent) => boolean,
): Promise<{ storeRoot: string; prefix: WorkflowJournalEvent[] }> {
	const storeRoot = path.join(fx.cwd, ".pi", `workflow-${randomUUID()}`);
	const setup = await acquireWorkflowRunLease({
		storeRoot,
		runId,
		ownerId: "setup",
	});
	await setup.release();
	await mkdir(path.join(storeRoot, "runs"), { recursive: true, mode: 0o700 });
	await cp(
		path.join(fx.storeRoot, "runs", runId),
		path.join(storeRoot, "runs", runId),
		{ recursive: true },
	);
	const events = await journalEvents(storeRoot, runId);
	const index = events.findIndex(cutAfter);
	if (index === -1) throw new Error("journal cut point not found");
	const lines = (await journalText(storeRoot, runId))
		.split("\n")
		.filter((line) => line.length > 0);
	await writeFile(
		journalPath(storeRoot, runId),
		`${lines.slice(0, index + 1).join("\n")}\n`,
	);
	// A snapshot is only ever written for state the journal already holds.
	await rm(path.join(storeRoot, "runs", runId, "run.json"), { force: true });
	return { storeRoot, prefix: events.slice(0, index + 1) };
}

const TOOLS_MODULE = "@vegardx/workflow-tools";
const EMPTY_SCHEMA = Type.Object({});
const ANSWER_SCHEMA = Type.Object({ answer: Type.String() });
type EmptyContext = SupportTaskExecutionContext<Static<typeof EMPTY_SCHEMA>>;

const consume = defineSupportTask({
	name: `${TOOLS_MODULE}/consume`,
	moduleSpecifier: TOOLS_MODULE,
	revision: 1,
	implementationSha256: "f".repeat(64),
	parametersSchema: EMPTY_SCHEMA,
	outputSchema: ANSWER_SCHEMA,
});

function supportToolsModuleSource(): string {
	const identity = JSON.stringify({
		implementation: consume.implementation,
		moduleSpecifier: consume.moduleSpecifier,
		revision: consume.revision,
		implementationSha256: consume.implementationSha256,
		parametersSchema: consume.parametersSchema,
		outputSchema: consume.outputSchema,
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
export function consume(call) { return descriptor(${identity}, call); }
`;
}

const ANSWER_JSON_SCHEMA = JSON.stringify({
	type: "object",
	properties: { answer: { type: "string" } },
	required: ["answer"],
	additionalProperties: false,
});

/** The JSON face of a handoff (spec 1.2) as a workflow output schema. */
const DESCRIPTOR_JSON_SCHEMA = JSON.stringify({
	type: "object",
	properties: {
		artifactId: { type: "string" },
		runId: { type: "string" },
		producerTaskId: { type: "string" },
		producerExecutionId: { type: "string" },
		subagentRunId: { type: "string" },
		subagentAttemptId: { type: "string" },
		baselineHead: { type: "string" },
		handoffCommit: { type: "string" },
		format: { type: "string" },
		mediaType: { type: "string" },
		sha256: { type: "string" },
		bytes: { type: "integer" },
	},
	required: [
		"artifactId",
		"runId",
		"producerTaskId",
		"producerExecutionId",
		"subagentRunId",
		"subagentAttemptId",
		"baselineHead",
		"handoffCommit",
		"format",
		"mediaType",
		"sha256",
		"bytes",
	],
	additionalProperties: false,
});

interface WorktreeWorkflowOptions {
	readonly name: string;
	/** Workflow-only handoff policy (D3); omitted means the "required" default. */
	readonly policy?: "required" | "optional";
	/** Task disposition; omitted means the "required" default. */
	readonly disposition?: "required" | "optional";
	readonly retries?: number;
	readonly inputSchema?: string;
	readonly outputSchema?: string;
	readonly imports?: string;
	/** Body after `const writer = ctx.agent("writer", ...)`. */
	readonly body: string;
}

function worktreeWorkflowSource(options: WorktreeWorkflowOptions): string {
	const retries = options.retries ?? 0;
	return `${options.imports ?? ""}export default {
  schema: "pi-workflow-definition",
  meta: { name: ${JSON.stringify(options.name)}, description: "Worktree handoff workflow", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 3600000, concurrency: 4 },
  inputSchema: ${options.inputSchema ?? '{ type: "object", properties: {}, additionalProperties: false }'},
  outputSchema: ${options.outputSchema ?? ANSWER_JSON_SCHEMA},
  run(ctx) {
    const writer = ctx.agent("writer", {
      agent: "writer",
      task: { goal: "Change the repository", context: [], instructions: ["Edit files and return structured output."] },
      contextMode: "fresh",
      tools: ["read"],
      preloadSkills: [],
      contextScopes: ["project"],
      workspace: { mode: "worktree", cwd: ctx.cwd },
      ${options.disposition ? `disposition: ${JSON.stringify(options.disposition)},` : ""}
      ${options.policy ? `handoff: ${JSON.stringify(options.policy)},` : ""}
      ${retries > 0 ? `retry: { attempts: ${retries} },` : ""}
      outputSchema: ${ANSWER_JSON_SCHEMA},
      limits: { cumulativeRuntimeMs: 300000, attemptTimeoutMs: 300000, totalTokens: 1000000, cost: 10, outputBytes: 1024, workspaceWriteBytes: 1024, retries: ${retries}, resumes: 0 }
    });
    ${options.body}
  }
};
`;
}

async function worktreeFixture(
	options: WorktreeWorkflowOptions & { supportModule?: boolean },
) {
	const base = root(options.name);
	const cwd = path.join(base, "project");
	const agentDir = path.join(base, "agent");
	const storeRoot = path.join(cwd, ".pi", "workflow");
	await mkdir(path.join(cwd, "workflows"), { recursive: true });
	if (options.supportModule) {
		const packageDir = path.join(
			cwd,
			"node_modules",
			...TOOLS_MODULE.split("/"),
		);
		await mkdir(packageDir, { recursive: true });
		await writeFile(
			path.join(packageDir, "package.json"),
			JSON.stringify({ name: TOOLS_MODULE, type: "module", main: "index.js" }),
		);
		await writeFile(
			path.join(packageDir, "index.js"),
			supportToolsModuleSource(),
		);
	}
	const definitionPath = path.join(
		cwd,
		"workflows",
		`${options.name}.workflow.ts`,
	);
	await writeFile(definitionPath, worktreeWorkflowSource(options));
	return { cwd, agentDir, storeRoot, definitionPath };
}

type Fixture = Awaited<ReturnType<typeof worktreeFixture>>;

async function serviceFor(fixture: Fixture, delegated: Delegated) {
	return createWorkflowService({
		...fixture,
		projectTrusted: () => true,
		subagents: delegated.provider,
	});
}

/** Drives the plain "return writer" worktree workflow to completion once. */
async function completedWorktreeRun(name: string) {
	const fixture = await worktreeFixture({ name, body: "return writer;" });
	const delegated = worktreeProvider({
		launches: [[{ status: "completed", handoff: "captured" }]],
	});
	const service = await serviceFor(fixture, delegated);
	const receipt = await service.run(name, {});
	delegated.state.probe = () => eventTypes(fixture.storeRoot, receipt.runId);
	const finished = await bounded(service.wait(receipt.runId), "wait");
	const state = await stateOf(fixture.storeRoot, receipt.runId);
	const writer = taskByKey(state, "writer");
	return {
		fixture,
		delegated,
		service,
		runId: receipt.runId,
		finished,
		state,
		writer,
		child: delegated.state.child,
	};
}

/** Drives the required-policy workflow whose child captures no handoff to its failure. */
async function failedRequiredRun(name: string) {
	const fixture = await worktreeFixture({
		name,
		policy: "required",
		outputSchema: DESCRIPTOR_JSON_SCHEMA,
		body: "return writer.handoff;",
	});
	const delegated = worktreeProvider({
		launches: [
			[{ status: "completed", handoff: "none" }],
			[{ status: "completed", handoff: "captured" }],
		],
	});
	const service = await serviceFor(fixture, delegated);
	const receipt = await service.run(name, {});
	const finished = await bounded(service.wait(receipt.runId), "wait");
	const state = await stateOf(fixture.storeRoot, receipt.runId);
	const writer = taskByKey(state, "writer");
	return {
		fixture,
		delegated,
		service,
		runId: receipt.runId,
		finished,
		state,
		writer,
		child: delegated.state.child,
	};
}

/** The operator legality table for one run, as `listRuns` reports it. */
async function actionsOf(
	service: WorkflowService,
	runId: string,
): Promise<readonly string[]> {
	const page = await service.listRuns();
	const summary = page.runs.find((candidate) => candidate.runId === runId);
	if (!summary) throw new Error(`run ${runId} is not listed`);
	return summary.availableActions;
}

function expectNoPrivateFacts(journal: string, state: WorkflowStateProjection) {
	const projected = JSON.stringify(state);
	for (const marker of PRIVATE_MARKERS) {
		expect(journal).not.toContain(marker);
		expect(projected).not.toContain(marker);
	}
}

describe("worktree agent tasks end to end", () => {
	it("completes a worktree task with a workflow-owned handoff imported before release", async () => {
		const run = await completedWorktreeRun("worktree-success");
		try {
			const { fixture, delegated, runId, state, writer, child } = run;
			expect(run.finished).toMatchObject({
				status: "completed",
				output: { answer: "from child" },
			});
			expect(writer.status).toBe("completed");

			// Spec 4.5: the worktree success ladder in journal order.
			const events = await journalEvents(fixture.storeRoot, runId);
			const types = events.map((event) => event.type);
			const settledIndex = types.indexOf("task-execution-child-settled");
			expect(settledIndex).toBeGreaterThan(-1);
			const ladder = events.slice(
				settledIndex,
				settledIndex + WORKTREE_SUCCESS_LADDER.length,
			);
			expect(ladder.map((event) => event.type)).toEqual([
				...WORKTREE_SUCCESS_LADDER,
			]);
			expect(countOf(types, "task-execution-child-settled")).toBe(1);
			expect(countOf(types, "task-execution-handoff-imported")).toBe(1);
			expect(countOf(types, "task-execution-handoff-absent")).toBe(0);
			expect(types.indexOf("run-output-committed")).toBeGreaterThan(
				settledIndex + WORKTREE_SUCCESS_LADDER.length - 1,
			);
			expect(types.at(-1)).toBe("run-status-changed");
			expect(dataOf<{ to: string }>(events.at(-1)).to).toBe("completed");

			const execution = executionOf(state, writer);
			const handoffCommit = commitFor(child.attemptId);
			const patch = patchFor(handoffCommit);
			expect(
				dataOf<{ evidence: Record<string, unknown> }>(ladder[0]).evidence,
			).toMatchObject({
				kind: "subagent",
				status: "completed",
				handoff: {
					attemptId: child.attemptId,
					baselineHead: BASELINE_HEAD,
					handoffCommit,
				},
			});
			expect(
				dataOf<{ artifact: WorkflowArtifactRef }>(ladder[1]).artifact,
			).toMatchObject({ output: "result", mediaType: "application/json" });
			const handoffArtifact = dataOf<{ artifact: WorkflowArtifactRef }>(
				ladder[3],
			).artifact;
			expect(handoffArtifact).toMatchObject({
				runId,
				producerTaskId: writer.task.id,
				producerExecutionId: execution.execution.id,
				output: "handoff",
				mediaType: PATCH_MEDIA_TYPE,
				schemaSha256: WORKFLOW_HANDOFF_FORMAT_SHA256,
				sha256: sha256(patch),
				bytes: patch.byteLength,
			});
			expect(dataOf(ladder[4])).toEqual({
				executionId: execution.execution.id,
				subagentRunId: child.runId,
				subagentAttemptId: child.attemptId,
				artifactId: handoffArtifact.id,
				handoffCommit,
				baselineHead: BASELINE_HEAD,
				sha256: sha256(patch),
				bytes: patch.byteLength,
			});
			expect(dataOf(ladder[7])).toMatchObject({
				outcome: "completed",
				evidence: { kind: "subagent", status: "completed" },
			});
			expect(dataOf(ladder[8])).toMatchObject({ to: "completed" });
			expect(execution).toMatchObject({
				phase: "terminal",
				preflight: { workspaceMode: "worktree" },
				handoffImport: {
					subagentAttemptId: child.attemptId,
					artifactId: handoffArtifact.id,
					handoffCommit,
					baselineHead: BASELINE_HEAD,
				},
				release: { status: "completed" },
				terminal: { outcome: "completed" },
			});
			expect(execution.handoffAbsent).toBeUndefined();

			// One export, bounded, after the result import and before release.
			expect(delegated.exportHandoff).toHaveBeenCalledExactlyOnceWith(
				child.runId,
				{ maxBytes: HANDOFF_BOUND_BYTES },
			);
			expect(delegated.state.exportSnapshots).toHaveLength(1);
			const atExport = delegated.state.exportSnapshots[0] ?? [];
			expect(atExport).toContain("task-execution-artifact-imported");
			expect(atExport).not.toContain("task-execution-handoff-imported");
			expect(atExport).not.toContain("task-execution-release-intended");
			// The finalizer may re-observe the exact child result before importing;
			// the export still follows the last observation and precedes release.
			const calls = delegated.state.calls;
			expect(calls.filter((call) => call !== "wait")).toEqual([
				"preflight",
				"launch",
				"exportHandoff",
				"release",
			]);
			expect(calls.lastIndexOf("wait")).toBeLessThan(
				calls.indexOf("exportHandoff"),
			);

			// D4: one store, JSON and patch blobs side by side.
			const resultArtifact = onlyArtifact(state, writer, "result");
			const entries = await readdir(artifactsDir(fixture.storeRoot, runId));
			expect(entries).toContain(`${resultArtifact.sha256}.json`);
			expect(entries).toContain(`${handoffArtifact.sha256}.patch`);
			expect(entries.filter((entry) => entry.endsWith(".patch"))).toEqual([
				`${handoffArtifact.sha256}.patch`,
			]);
			expect(
				await readFile(
					path.join(
						artifactsDir(fixture.storeRoot, runId),
						`${handoffArtifact.sha256}.patch`,
					),
				),
			).toEqual(patch);

			// D5: identity only, never pi-subagent's private facts.
			expectNoPrivateFacts(await journalText(fixture.storeRoot, runId), state);

			// D9: the service exports exactly the verified bytes and descriptor.
			await expect(
				run.service.exportHandoff(runId, writer.task.id),
			).resolves.toEqual({
				descriptor: expectedDescriptor(state, writer, child),
				content: patch,
			});
		} finally {
			await shutdownQuietly(run.service);
		}
	});

	it("resolves ctx.handoff to the descriptor and commits a returned handoff handle as the run output", async () => {
		const name = "worktree-descriptor";
		const fixture = await worktreeFixture({
			name,
			inputSchema:
				'{ type: "object", properties: { mode: { type: "string" } }, required: ["mode"], additionalProperties: false }',
			outputSchema: DESCRIPTOR_JSON_SCHEMA,
			body: `if (ctx.input.mode === "handle") return writer.handoff;
    return ctx.handoff(writer).then((descriptor) => descriptor);`,
		});
		const delegated = worktreeProvider({
			launches: [
				[{ status: "completed", handoff: "captured" }],
				[{ status: "completed", handoff: "captured" }],
			],
		});
		const service = await serviceFor(fixture, delegated);
		try {
			const awaited = await service.run(name, { mode: "await" });
			const awaitedView = await bounded(service.wait(awaited.runId), "wait");
			const awaitedState = await stateOf(fixture.storeRoot, awaited.runId);
			const awaitedWriter = taskByKey(awaitedState, "writer");
			const awaitedChild = delegated.state.child;
			const awaitedDescriptor = expectedDescriptor(
				awaitedState,
				awaitedWriter,
				awaitedChild,
			);
			expect(awaitedView.status).toBe("completed");
			expect(awaitedView.output).toEqual(awaitedDescriptor);
			expect(awaitedDescriptor.producerExecutionId).toBe(
				deriveTaskExecutionId(awaited.runId, awaitedWriter.task.id, 1),
			);
			expect(Object.keys(awaitedDescriptor).sort()).toEqual(
				[
					"artifactId",
					"baselineHead",
					"bytes",
					"format",
					"handoffCommit",
					"mediaType",
					"producerExecutionId",
					"producerTaskId",
					"runId",
					"sha256",
					"subagentAttemptId",
					"subagentRunId",
				].sort(),
			);
			expect(awaitedState.outputArtifactId).toBeDefined();
			const outputArtifact = awaitedState.outputArtifactId
				? awaitedState.artifacts[awaitedState.outputArtifactId]
				: undefined;
			expect(outputArtifact).toMatchObject({ mediaType: "application/json" });

			const handle = await service.run(name, { mode: "handle" });
			const handleView = await bounded(service.wait(handle.runId), "wait");
			const handleState = await stateOf(fixture.storeRoot, handle.runId);
			const handleWriter = taskByKey(handleState, "writer");
			expect(handleView.status).toBe("completed");
			expect(handleView.output).toEqual(
				expectedDescriptor(handleState, handleWriter, delegated.state.child),
			);
			expect(handleView.outputArtifactId).toBeDefined();
			expect(handleView.output).not.toEqual(awaitedDescriptor);
			expect(delegated.exportHandoff).toHaveBeenCalledTimes(2);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("feeds a handoff to a read-only agent task as a descriptor envelope and to a support task as descriptor JSON", async () => {
		const name = "worktree-downstream";
		const fixture = await worktreeFixture({
			name,
			supportModule: true,
			imports: `import { consume } from ${JSON.stringify(TOOLS_MODULE)};\n`,
			body: `const reader = ctx.agent("reader", {
      agent: "researcher",
      task: { goal: "Review the change", context: [], instructions: ["Review and return structured output."] },
      contextMode: "fresh",
      tools: ["read"],
      preloadSkills: [],
      contextScopes: ["project"],
      workspace: { mode: "read-only", cwd: ctx.cwd },
      inputs: { patch: writer.handoff },
      outputSchema: ${ANSWER_JSON_SCHEMA},
      limits: { cumulativeRuntimeMs: 300000, attemptTimeoutMs: 300000, totalTokens: 1000000, cost: 10, outputBytes: 1024, workspaceWriteBytes: 0, retries: 0, resumes: 0 }
    });
    const summary = ctx.support("summary", consume({ parameters: {}, inputs: { patch: writer.handoff } }));
    return ctx.results([reader, summary]).then(([review, digest]) => ({ answer: review.answer + "|" + digest.answer }));`,
		});
		const delegated = worktreeProvider({
			launches: [
				[{ status: "completed", handoff: "captured" }],
				[{ status: "completed" }],
			],
		});
		const execute = vi.fn((context: EmptyContext): { answer: string } => {
			const descriptor = context.inputs.patch as WorkflowHandoffDescriptor;
			return { answer: descriptor.handoffCommit };
		});
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
			supportTasks: [consume.registration(execute)],
		});
		try {
			const receipt = await service.run(name, {});
			const finished = await bounded(service.wait(receipt.runId), "wait");
			const state = await stateOf(fixture.storeRoot, receipt.runId);
			const writer = taskByKey(state, "writer");
			// The writer is the only task without dependencies, so it launched first.
			const writerChild = {
				runId: dataOf<{ subagentRunId: string }>(
					(await journalEvents(fixture.storeRoot, receipt.runId)).find(
						(event) => event.type === "task-execution-handoff-imported",
					),
				).subagentRunId,
				attemptId: "",
			};
			writerChild.attemptId = delegated.state.children.get(
				writerChild.runId,
			) as string;
			const descriptor = expectedDescriptor(state, writer, writerChild);
			expect(finished).toMatchObject({
				status: "completed",
				output: { answer: `from child|${descriptor.handoffCommit}` },
			});

			// Spec 6: the child model receives identity, not bytes.
			expect(delegated.preflight).toHaveBeenCalledTimes(2);
			const readerRequest = delegated.preflight.mock.calls[1]?.[0];
			expect(readerRequest?.agent).toBe("researcher");
			expect(readerRequest?.workspace).toEqual({
				mode: "read-only",
				cwd: fixture.cwd,
			});
			expect(readerRequest?.task.context).toHaveLength(1);
			const envelope = JSON.parse(
				readerRequest?.task.context[0] ?? "null",
			) as Record<string, unknown>;
			expect(envelope).toMatchObject({
				content: "descriptor",
				mediaType: PATCH_MEDIA_TYPE,
				name: "patch",
				sha256: descriptor.sha256,
				value: descriptor,
			});
			expect(JSON.stringify(envelope)).not.toContain(
				"Mon Sep 17 00:00:00 2001",
			);
			for (const request of delegated.preflight.mock.calls) {
				expect(request[0]).not.toHaveProperty("handoff");
			}

			// Support implementations receive the descriptor JSON.
			expect(execute).toHaveBeenCalledOnce();
			expect(execute.mock.calls[0]?.[0].inputs).toEqual({ patch: descriptor });
			expect(taskByKey(state, "reader").status).toBe("completed");
			expect(taskByKey(state, "summary").status).toBe("completed");
			expect(delegated.exportHandoff).toHaveBeenCalledOnce();
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("blocks at handoff-import when the export fails and reconciles the import afterwards", async () => {
		const name = "worktree-export-failure";
		const fixture = await worktreeFixture({ name, body: "return writer;" });
		const delegated = worktreeProvider({
			launches: [[{ status: "completed", handoff: "captured" }]],
			exportFailures: [new Error("export pipe burst")],
		});
		const service = await serviceFor(fixture, delegated);
		let recovering: Delegated | undefined;
		let recovery: WorkflowService | undefined;
		try {
			const receipt = await service.run(name, {});
			const blocked = await bounded(service.wait(receipt.runId), "wait");
			expect(blocked.status).toBe("cleanup-blocked");
			expect(blocked.output).toBeUndefined();
			const child = delegated.state.child;
			const blockedState = await stateOf(fixture.storeRoot, receipt.runId);
			const writer = taskByKey(blockedState, "writer");
			expect(writer.status).toBe("cleanup-blocked");
			const execution = executionOf(blockedState, writer);
			expect(execution).toMatchObject({
				phase: "terminal",
				terminal: {
					outcome: "cleanup-blocked",
					evidence: { kind: "workflow", stage: "handoff-import" },
				},
			});
			expect(execution.handoffImport).toBeUndefined();
			expect(execution.release).toBeUndefined();
			const blockedTypes = await eventTypes(fixture.storeRoot, receipt.runId);
			expect(blockedTypes.slice(-4)).toEqual([
				"task-execution-artifact-imported",
				"task-execution-terminal",
				"task-status-changed",
				"run-status-changed",
			]);
			expect(countOf(blockedTypes, "artifact-declared")).toBe(1);
			expect(countOf(blockedTypes, "task-execution-release-intended")).toBe(0);
			expect(delegated.release).not.toHaveBeenCalled();
			expect(delegated.exportHandoff).toHaveBeenCalledOnce();
			const blockedEntries = await readdir(
				artifactsDir(fixture.storeRoot, receipt.runId),
			);
			expect(blockedEntries.some((entry) => entry.endsWith(".patch"))).toBe(
				false,
			);
			expect(await journalText(fixture.storeRoot, receipt.runId)).not.toContain(
				"export pipe burst",
			);

			// Explicit reconciliation by the operator after a restart (spec 4.4).
			await bounded(service.shutdown(), "first shutdown");
			recovering = worktreeProvider({
				launches: [],
				children: delegated.state.children,
				resettle: { status: "completed", handoff: "captured" },
			});
			recovery = await serviceFor(fixture, recovering);
			const reconciled = await bounded(
				recovery.reconcile(receipt.runId),
				"reconcile",
			);
			expect(recovering.reconcile).toHaveBeenCalledExactlyOnceWith(child.runId);
			expect(recovering.exportHandoff).toHaveBeenCalledExactlyOnceWith(
				child.runId,
				{ maxBytes: HANDOFF_BOUND_BYTES },
			);
			expect(delegated.exportHandoff).toHaveBeenCalledOnce();
			expect(recovering.release).toHaveBeenCalledExactlyOnceWith(child.runId);
			expect(delegated.release).not.toHaveBeenCalled();
			expect(recovering.preflight).not.toHaveBeenCalled();
			expect(recovering.launch).not.toHaveBeenCalled();
			expect(delegated.launch).toHaveBeenCalledOnce();
			const events = await journalEvents(fixture.storeRoot, receipt.runId);
			const types = events.map((event) => event.type);
			const blockedTerminal = types.indexOf("task-execution-terminal");
			const recovered = types.slice(blockedTerminal);
			expect(recovered.indexOf("artifact-declared")).toBeGreaterThan(-1);
			expect(
				recovered.indexOf("task-execution-handoff-imported"),
			).toBeGreaterThan(recovered.indexOf("artifact-declared"));
			expect(
				recovered.indexOf("task-execution-release-intended"),
			).toBeGreaterThan(recovered.indexOf("task-execution-handoff-imported"));
			expect(countOf(types, "task-execution-handoff-imported")).toBe(1);
			expect(countOf(types, "task-execution-released")).toBe(1);
			const state = reduceWorkflowEvents(events);
			expect(state.status).toBe("completed");
			const repaired = executionOf(state, taskByKey(state, "writer"));
			expect(repaired).toMatchObject({
				phase: "terminal",
				handoffImport: {
					subagentAttemptId: child.attemptId,
					handoffCommit: commitFor(child.attemptId),
				},
				terminal: {
					outcome: "completed",
					evidence: { kind: "subagent", status: "completed" },
				},
			});
			const entries = await readdir(
				artifactsDir(fixture.storeRoot, receipt.runId),
			);
			expect(entries).toContain(
				`${sha256(patchFor(commitFor(child.attemptId)))}.patch`,
			);
			expect(await journalText(fixture.storeRoot, receipt.runId)).not.toContain(
				"export pipe burst",
			);
			expectNoPrivateFacts(
				await journalText(fixture.storeRoot, receipt.runId),
				state,
			);
			expect(recovering.state.calls.filter((call) => call !== "wait")).toEqual([
				"reconcile",
				"exportHandoff",
				"release",
			]);
			// Spec 4.4: reconciliation retries the import, releases, and the run
			// completes; the returned view reflects that completion.
			expect(countOf(types, "run-output-committed")).toBe(1);
			expect(reconciled).toMatchObject({
				status: "completed",
				output: { answer: "from child" },
			});
		} finally {
			await shutdownQuietly(recovery);
			await shutdownQuietly(service);
		}
	});

	it("reconciles a handoff-import block on the live service that still owns the run", async () => {
		const name = "worktree-export-failure-live";
		const fixture = await worktreeFixture({ name, body: "return writer;" });
		const delegated = worktreeProvider({
			launches: [[{ status: "completed", handoff: "captured" }]],
			exportFailures: [new Error("export pipe burst")],
		});
		const service = await serviceFor(fixture, delegated);
		try {
			const receipt = await service.run(name, {});
			const blocked = await bounded(service.wait(receipt.runId), "wait");
			expect(blocked.status).toBe("cleanup-blocked");
			const child = delegated.state.child;
			// Spec 4.4 ladder: service.reconcile -> scheduler.reconcile ->
			// client.reconcile(child) -> finalizer retries importHandoff.
			const reconciled = await bounded(
				service.reconcile(receipt.runId),
				"reconcile",
			);
			expect(reconciled).toMatchObject({
				status: "completed",
				output: { answer: "from child" },
			});
			expect(delegated.reconcile).toHaveBeenCalledExactlyOnceWith(child.runId);
			expect(delegated.exportHandoff).toHaveBeenCalledTimes(2);
			expect(delegated.exportHandoff).toHaveBeenLastCalledWith(child.runId, {
				maxBytes: HANDOFF_BOUND_BYTES,
			});
			expect(delegated.release).toHaveBeenCalledExactlyOnceWith(child.runId);
			expect(delegated.launch).toHaveBeenCalledOnce();
			const types = await eventTypes(fixture.storeRoot, receipt.runId);
			expect(countOf(types, "task-execution-handoff-imported")).toBe(1);
			expect(countOf(types, "task-execution-released")).toBe(1);
			expect(await journalText(fixture.storeRoot, receipt.runId)).not.toContain(
				"export pipe burst",
			);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("fails a required task whose handoff exceeds the import bound, keeps the child, and recovers on invalidate", async () => {
		const name = "worktree-handoff-bound";
		const fixture = await worktreeFixture({
			name,
			outputSchema: DESCRIPTOR_JSON_SCHEMA,
			body: "return writer.handoff;",
		});
		const delegated = worktreeProvider({
			launches: [
				[{ status: "completed", handoff: "captured" }],
				[{ status: "completed", handoff: "captured" }],
			],
			exportFailures: [boundRefusal()],
		});
		const service = await serviceFor(fixture, delegated);
		try {
			const receipt = await service.run(name, {});
			const failed = await bounded(service.wait(receipt.runId), "wait");
			expect(failed.status).toBe("failed");
			expect(failed.output).toBeUndefined();
			const firstChild = delegated.state.child;
			const events = await journalEvents(fixture.storeRoot, receipt.runId);
			const types = events.map((event) => event.type);
			const settledIndex = types.indexOf("task-execution-child-settled");
			// No release intent and no handoff evidence: the import bound refused
			// the only handoff this execution will ever have.
			expect(types.slice(settledIndex, settledIndex + 6)).toEqual([
				"task-execution-child-settled",
				"artifact-declared",
				"task-execution-artifact-imported",
				"task-execution-terminal",
				"task-status-changed",
				"run-status-changed",
			]);
			expect(dataOf(events[settledIndex + 3])).toMatchObject({
				outcome: "failed",
				evidence: {
					kind: "workflow",
					stage: "handoff-import",
					message: HANDOFF_BOUND_MESSAGE,
				},
			});
			expect(dataOf(events[settledIndex + 4])).toMatchObject({
				to: "failed",
				reason: HANDOFF_BOUND_MESSAGE,
			});
			expect(dataOf(events[settledIndex + 5])).toMatchObject({ to: "failed" });
			expect(countOf(types, "task-execution-handoff-imported")).toBe(0);
			expect(countOf(types, "task-execution-handoff-absent")).toBe(0);
			expect(countOf(types, "task-execution-release-intended")).toBe(0);
			expect(delegated.release).not.toHaveBeenCalled();
			expect(delegated.exportHandoff).toHaveBeenCalledExactlyOnceWith(
				firstChild.runId,
				{ maxBytes: HANDOFF_BOUND_BYTES },
			);
			const blockedState = await stateOf(fixture.storeRoot, receipt.runId);
			const blockedWriter = taskByKey(blockedState, "writer");
			expect(blockedWriter.status).toBe("failed");
			expect(executionOf(blockedState, blockedWriter)).toMatchObject({
				phase: "terminal",
				terminal: { outcome: "failed" },
			});
			expect(
				(await readdir(artifactsDir(fixture.storeRoot, receipt.runId))).some(
					(entry) => entry.endsWith(".patch"),
				),
			).toBe(false);
			// The wedge is gone: the run is failed, so recovery is available.
			expect(await actionsOf(service, receipt.runId)).toEqual([
				"invalidate",
				"retry",
			]);

			const invalidated = await bounded(
				service.invalidate(
					receipt.runId,
					blockedWriter.task.id,
					"export a smaller handoff",
				),
				"invalidate",
			);
			expect(["running", "waiting"]).toContain(invalidated.status);
			const finished = await bounded(service.wait(receipt.runId), "wait");
			expect(finished.status).toBe("completed");
			const state = await stateOf(fixture.storeRoot, receipt.runId);
			const writer = taskByKey(state, "writer");
			expect(writer.status).toBe("completed");
			expect(writer.currentExecutionId).toBe(
				deriveTaskExecutionId(receipt.runId, writer.task.id, 2),
			);
			expect(finished.output).toEqual(
				expectedDescriptor(state, writer, delegated.state.child),
			);
			expect(delegated.release).toHaveBeenCalledOnce();
			expectNoPrivateFacts(
				await journalText(fixture.storeRoot, receipt.runId),
				state,
			);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("degrades the run when an optional task's handoff exceeds the import bound", async () => {
		const name = "worktree-handoff-bound-optional";
		const fixture = await worktreeFixture({
			name,
			disposition: "optional",
			body: 'return { answer: "degraded" };',
		});
		const delegated = worktreeProvider({
			launches: [[{ status: "completed", handoff: "captured" }]],
			exportFailures: [boundRefusal()],
		});
		const service = await serviceFor(fixture, delegated);
		try {
			const receipt = await service.run(name, {});
			const finished = await bounded(service.wait(receipt.runId), "wait");
			expect(finished.status).toBe("completed-degraded");
			expect(finished.output).toEqual({ answer: "degraded" });
			const state = await stateOf(fixture.storeRoot, receipt.runId);
			const writer = taskByKey(state, "writer");
			expect(writer.status).toBe("failed");
			expect(executionOf(state, writer)).toMatchObject({
				phase: "terminal",
				terminal: {
					outcome: "failed",
					evidence: {
						kind: "workflow",
						stage: "handoff-import",
						message: HANDOFF_BOUND_MESSAGE,
					},
				},
			});
			const types = await eventTypes(fixture.storeRoot, receipt.runId);
			expect(countOf(types, "task-execution-release-intended")).toBe(0);
			expect(delegated.release).not.toHaveBeenCalled();
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("converges a wedged handoff-import block to failed when reconcile proves the bound refusal", async () => {
		const name = "worktree-handoff-bound-reconcile";
		const fixture = await worktreeFixture({ name, body: "return writer;" });
		const delegated = worktreeProvider({
			launches: [[{ status: "completed", handoff: "captured" }]],
			exportFailures: [new Error("export pipe burst")],
		});
		const service = await serviceFor(fixture, delegated);
		let recovery: WorkflowService | undefined;
		try {
			const receipt = await service.run(name, {});
			const blocked = await bounded(service.wait(receipt.runId), "wait");
			// The shape this fix recovers: cleanup-blocked at handoff-import with
			// reconcile as the only action.
			expect(blocked.status).toBe("cleanup-blocked");
			expect(await actionsOf(service, receipt.runId)).toEqual(["reconcile"]);
			const child = delegated.state.child;
			await bounded(service.shutdown(), "first shutdown");

			// The export was never transient: every re-drive proves the bound.
			const recovering = worktreeProvider({
				launches: [],
				children: delegated.state.children,
				resettle: { status: "completed", handoff: "captured" },
				exportFailures: [boundRefusal()],
			});
			recovery = await serviceFor(fixture, recovering);
			const reconciled = await bounded(
				recovery.reconcile(receipt.runId),
				"reconcile",
			);
			expect(reconciled.status).toBe("failed");
			expect(reconciled.reconciled).toHaveLength(1);
			expect(reconciled.reconciled[0]).toMatchObject({
				before: { phase: "terminal", outcome: "cleanup-blocked" },
				after: { phase: "terminal", outcome: "failed" },
			});
			expect(recovering.reconcile).toHaveBeenCalledExactlyOnceWith(child.runId);
			expect(recovering.exportHandoff).toHaveBeenCalledExactlyOnceWith(
				child.runId,
				{ maxBytes: HANDOFF_BOUND_BYTES },
			);
			expect(recovering.release).not.toHaveBeenCalled();
			const state = await stateOf(fixture.storeRoot, receipt.runId);
			expect(state.status).toBe("failed");
			const writer = taskByKey(state, "writer");
			expect(writer.status).toBe("failed");
			expect(executionOf(state, writer)).toMatchObject({
				phase: "terminal",
				terminal: {
					outcome: "failed",
					evidence: {
						kind: "workflow",
						stage: "handoff-import",
						message: HANDOFF_BOUND_MESSAGE,
					},
				},
			});
			const types = await eventTypes(fixture.storeRoot, receipt.runId);
			expect(countOf(types, "task-execution-terminal")).toBe(2);
			expect(countOf(types, "task-execution-release-intended")).toBe(0);
			expect(await actionsOf(recovery, receipt.runId)).toEqual([
				"invalidate",
				"retry",
			]);
			// A second reconcile has nothing left to do: the run is no longer
			// cleanup-blocked, so nothing is re-driven and nothing is appended.
			const again = await bounded(
				recovery.reconcile(receipt.runId),
				"second reconcile",
			);
			expect(again).toMatchObject({ status: "failed", reconciled: [] });
			expect(recovering.exportHandoff).toHaveBeenCalledOnce();
			expect(await eventTypes(fixture.storeRoot, receipt.runId)).toEqual(types);
		} finally {
			await shutdownQuietly(recovery);
			await shutdownQuietly(service);
		}
	});

	it("records an absent handoff under the optional policy and completes", async () => {
		const name = "worktree-optional-absent";
		const fixture = await worktreeFixture({
			name,
			policy: "optional",
			body: `return ctx.handoff(writer).then((descriptor) => ({ answer: descriptor === undefined ? "absent" : "present" }));`,
		});
		const delegated = worktreeProvider({
			launches: [[{ status: "completed", handoff: "none" }]],
		});
		const service = await serviceFor(fixture, delegated);
		try {
			const receipt = await service.run(name, {});
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({
				status: "completed",
				output: { answer: "absent" },
			});
			const child = delegated.state.child;
			const events = await journalEvents(fixture.storeRoot, receipt.runId);
			const types = events.map((event) => event.type);
			const settledIndex = types.indexOf("task-execution-child-settled");
			expect(types.slice(settledIndex, settledIndex + 8)).toEqual([
				"task-execution-child-settled",
				"artifact-declared",
				"task-execution-artifact-imported",
				"task-execution-handoff-absent",
				"task-execution-release-intended",
				"task-execution-released",
				"task-execution-terminal",
				"task-status-changed",
			]);
			expect(
				dataOf<{ evidence: Record<string, unknown> }>(events[settledIndex])
					.evidence.handoff,
			).toBeUndefined();
			const state = reduceWorkflowEvents(events);
			const writer = taskByKey(state, "writer");
			const execution = executionOf(state, writer);
			expect(dataOf(events[settledIndex + 3])).toEqual({
				executionId: execution.execution.id,
				subagentRunId: child.runId,
				subagentAttemptId: child.attemptId,
			});
			expect(dataOf(events[settledIndex + 6])).toMatchObject({
				outcome: "completed",
				evidence: { kind: "subagent", status: "completed" },
			});
			expect(writer.status).toBe("completed");
			expect(execution.handoffAbsent).toMatchObject({
				subagentRunId: child.runId,
				subagentAttemptId: child.attemptId,
			});
			expect(execution.handoffImport).toBeUndefined();
			expect(artifactsOf(state, writer, "handoff")).toEqual([]);
			expect(countOf(types, "task-execution-handoff-imported")).toBe(0);
			expect(delegated.exportHandoff).not.toHaveBeenCalled();
			expect(delegated.release).toHaveBeenCalledOnce();
			expectNoPrivateFacts(
				await journalText(fixture.storeRoot, receipt.runId),
				state,
			);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("fails a required-policy task after release when no handoff was captured, then re-executes it as generation 2", async () => {
		const run = await failedRequiredRun("worktree-required-absent");
		const { fixture, delegated, service, runId } = run;
		try {
			expect(run.finished.status).toBe("failed");
			expect(run.finished.output).toBeUndefined();
			const firstChild = run.child;
			expect(run.writer.status).toBe("failed");
			const events = await journalEvents(fixture.storeRoot, runId);
			const types = events.map((event) => event.type);
			const settledIndex = types.indexOf("task-execution-child-settled");
			expect(types.slice(settledIndex, settledIndex + 8)).toEqual([
				"task-execution-child-settled",
				"artifact-declared",
				"task-execution-artifact-imported",
				"task-execution-handoff-absent",
				"task-execution-release-intended",
				"task-execution-released",
				"task-execution-terminal",
				"task-status-changed",
			]);
			expect(dataOf(events[settledIndex + 6])).toMatchObject({
				outcome: "failed",
				evidence: {
					kind: "workflow",
					stage: "handoff-import",
					message: HANDOFF_ABSENT_MESSAGE,
				},
			});
			expect(dataOf(events[settledIndex + 7])).toMatchObject({
				to: "failed",
				reason: HANDOFF_ABSENT_MESSAGE,
			});
			expect(events.at(-1)).toMatchObject({
				type: "run-status-changed",
				data: { to: "failed" },
			});
			const generation1 = executionOf(run.state, run.writer);
			expect(generation1).toMatchObject({
				phase: "terminal",
				release: { status: "completed" },
				terminal: {
					outcome: "failed",
					evidence: { kind: "workflow", stage: "handoff-import" },
				},
			});
			expect(delegated.release).toHaveBeenCalledOnce();
			expect(delegated.exportHandoff).not.toHaveBeenCalled();

			const invalidated = await bounded(
				service.invalidate(runId, run.writer.task.id, "capture the change"),
				"invalidate",
			);
			expect(["running", "waiting"]).toContain(invalidated.status);
			const finished = await bounded(service.wait(runId), "wait");
			const state = await stateOf(fixture.storeRoot, runId);
			const writer = taskByKey(state, "writer");
			const secondChild = delegated.state.child;
			expect(secondChild.runId).not.toBe(firstChild.runId);
			expect(writer.status).toBe("completed");
			expect(writer.currentExecutionId).toBe(
				deriveTaskExecutionId(runId, writer.task.id, 2),
			);
			const descriptor = expectedDescriptor(state, writer, secondChild);
			expect(finished).toMatchObject({ status: "completed" });
			expect(finished.output).toEqual(descriptor);
			expect(descriptor.producerExecutionId).toBe(
				deriveTaskExecutionId(runId, writer.task.id, 2),
			);
			expect(delegated.launch).toHaveBeenCalledTimes(2);
			expect(delegated.exportHandoff).toHaveBeenCalledExactlyOnceWith(
				secondChild.runId,
				{ maxBytes: HANDOFF_BOUND_BYTES },
			);
			expect(delegated.release).toHaveBeenCalledTimes(2);
			const allTypes = await eventTypes(fixture.storeRoot, runId);
			expect(countOf(allTypes, "task-execution-handoff-absent")).toBe(1);
			expect(countOf(allTypes, "task-execution-handoff-imported")).toBe(1);
			// Generation 1 stays as history; every lookup selects generation 2.
			const previous =
				state.executions[deriveTaskExecutionId(runId, writer.task.id, 1)];
			expect(previous).toMatchObject({
				phase: "terminal",
				terminal: { outcome: "failed" },
			});
			expect(
				Object.values(state.artifacts).filter(
					(artifact) => artifact.output === "handoff",
				),
			).toHaveLength(1);
			await expect(
				service.exportHandoff(runId, writer.task.id),
			).resolves.toMatchObject({ descriptor });
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("recovers each handoff crash window idempotently after restart", async () => {
		const success = await completedWorktreeRun("worktree-crash-success");
		await shutdownQuietly(success.service);
		const failed = await failedRequiredRun("worktree-crash-required");
		await shutdownQuietly(failed.service);
		expect(success.finished.status).toBe("completed");
		expect(failed.finished.status).toBe("failed");

		// Window 1: handoff artifact declared, import not yet journaled.
		const declared = await crashImageAfter(
			success.fixture,
			success.runId,
			(event) =>
				event.type === "artifact-declared" &&
				(event.data as { artifact: { output?: string } }).artifact.output ===
					"handoff",
		);
		expect(declared.prefix.map((event) => event.type)).not.toContain(
			"task-execution-handoff-imported",
		);
		const afterDeclared = worktreeProvider({
			launches: [],
			children: success.delegated.state.children,
			resettle: { status: "completed", handoff: "captured" },
		});
		const declaredService = await createWorkflowService({
			...success.fixture,
			storeRoot: declared.storeRoot,
			projectTrusted: () => true,
			subagents: afterDeclared.provider,
		});
		try {
			await expect(
				bounded(declaredService.wait(success.runId), "wait after declaration"),
			).resolves.toMatchObject({
				status: "completed",
				output: { answer: "from child" },
			});
			expect(afterDeclared.exportHandoff).not.toHaveBeenCalled();
			expect(
				afterDeclared.state.calls.filter((call) => call !== "wait"),
			).toEqual(["release"]);
			const events = await journalEvents(declared.storeRoot, success.runId);
			expect(events.slice(0, declared.prefix.length)).toEqual(declared.prefix);
			const appended = taskEvents(events.slice(declared.prefix.length));
			expect(appended.slice(0, 5).map((event) => event.type)).toEqual([
				"task-execution-handoff-imported",
				"task-execution-release-intended",
				"task-execution-released",
				"task-execution-terminal",
				"task-status-changed",
			]);
			const original = (
				await journalEvents(success.fixture.storeRoot, success.runId)
			).find((event) => event.type === "task-execution-handoff-imported");
			expect(appended[0]?.data).toEqual(original?.data);
			expect(events.at(-1)).toMatchObject({
				type: "run-status-changed",
				data: { to: "completed" },
			});
			// The handoff blob was declared once; the restart never re-declared it.
			expect(
				events.filter(
					(event) =>
						event.type === "artifact-declared" &&
						(event.data as { artifact: { output?: string } }).artifact
							.output === "handoff",
				),
			).toHaveLength(1);
			expect(
				countOf(
					events.map((event) => event.type),
					"artifact-declared",
				),
			).toBe(
				countOf(
					await eventTypes(success.fixture.storeRoot, success.runId),
					"artifact-declared",
				),
			);
		} finally {
			await shutdownQuietly(declaredService);
		}

		// Window 2: handoff imported, release intent not yet journaled.
		const imported = await crashImageAfter(
			success.fixture,
			success.runId,
			(event) => event.type === "task-execution-handoff-imported",
		);
		const afterImport = worktreeProvider({
			launches: [],
			children: success.delegated.state.children,
			resettle: { status: "completed", handoff: "captured" },
		});
		const importedService = await createWorkflowService({
			...success.fixture,
			storeRoot: imported.storeRoot,
			projectTrusted: () => true,
			subagents: afterImport.provider,
		});
		try {
			await expect(
				bounded(importedService.wait(success.runId), "wait after import"),
			).resolves.toMatchObject({
				status: "completed",
				output: { answer: "from child" },
			});
			expect(afterImport.exportHandoff).not.toHaveBeenCalled();
			expect(afterImport.release).toHaveBeenCalledExactlyOnceWith(
				success.child.runId,
			);
			expect(afterImport.state.calls.filter((call) => call !== "wait")).toEqual(
				["release"],
			);
			const events = await journalEvents(imported.storeRoot, success.runId);
			expect(events.slice(0, imported.prefix.length)).toEqual(imported.prefix);
			const types = events.map((event) => event.type);
			expect(
				taskEvents(events.slice(imported.prefix.length))
					.slice(0, 4)
					.map((event) => event.type),
			).toEqual([
				"task-execution-release-intended",
				"task-execution-released",
				"task-execution-terminal",
				"task-status-changed",
			]);
			expect(events.at(-1)).toMatchObject({
				type: "run-status-changed",
				data: { to: "completed" },
			});
			expect(countOf(types, "task-execution-handoff-imported")).toBe(1);
			expect(countOf(types, "task-execution-released")).toBe(1);
		} finally {
			await shutdownQuietly(importedService);
		}

		// Window 3: required-policy failed terminal persisted, task status not yet.
		const terminal = await crashImageAfter(
			failed.fixture,
			failed.runId,
			(event) =>
				event.type === "task-execution-terminal" &&
				(event.data as { outcome: string }).outcome === "failed",
		);
		expect(terminal.prefix.at(-1)).toMatchObject({
			type: "task-execution-terminal",
			data: { evidence: { stage: "handoff-import" } },
		});
		const afterTerminal = worktreeProvider({
			launches: [],
			children: failed.delegated.state.children,
		});
		const terminalService = await createWorkflowService({
			...failed.fixture,
			storeRoot: terminal.storeRoot,
			projectTrusted: () => true,
			subagents: afterTerminal.provider,
		});
		try {
			const view = await bounded(
				terminalService.wait(failed.runId),
				"wait after terminal",
			);
			expect(view.status).toBe("failed");
			expect(view.output).toBeUndefined();
			expect(afterTerminal.state.calls).toEqual([]);
			const events = await journalEvents(terminal.storeRoot, failed.runId);
			expect(events.slice(0, terminal.prefix.length)).toEqual(terminal.prefix);
			const appended = events.slice(terminal.prefix.length);
			expect(taskEvents(appended).map((event) => event.type)).toEqual([
				"task-status-changed",
			]);
			expect(taskEvents(appended)[0]?.data).toMatchObject({ to: "failed" });
			expect(events.at(-1)).toMatchObject({
				type: "run-status-changed",
				data: { to: "failed" },
			});
			const state = reduceWorkflowEvents(events);
			expect(state.status).toBe("failed");
			expect(taskByKey(state, "writer").status).toBe("failed");
			expect(
				countOf(
					events.map((event) => event.type),
					"task-execution-terminal",
				),
			).toBe(1);
		} finally {
			await shutdownQuietly(terminalService);
		}
	});

	it("imports only the final attempt's handoff after a retried worktree child", async () => {
		const name = "worktree-retry";
		const fixture = await worktreeFixture({
			name,
			retries: 1,
			body: "return writer;",
		});
		const delegated = worktreeProvider({
			launches: [
				[
					{ status: "failed", failure: backoffFailure() },
					{ status: "completed", handoff: "captured" },
				],
			],
		});
		const service = await serviceFor(fixture, delegated);
		try {
			const receipt = await service.run(name, {});
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({
				status: "completed",
				output: { answer: "from child" },
			});
			const finalChild = delegated.state.child;
			expect(delegated.retry).toHaveBeenCalledOnce();
			expect(delegated.launch).toHaveBeenCalledOnce();
			expect(finalChild.attemptId).not.toBe(
				delegated.launch.mock.results[0]?.value
					? (await delegated.launch.mock.results[0].value).attemptId
					: undefined,
			);
			const state = await stateOf(fixture.storeRoot, receipt.runId);
			const writer = taskByKey(state, "writer");
			const execution = executionOf(state, writer);
			const handoffCommit = commitFor(finalChild.attemptId);
			expect(execution.attempts?.[0]).toMatchObject({
				kind: "retry",
				ordinal: 2,
				subagentAttemptId: finalChild.attemptId,
			});
			expect(execution.settlement?.evidence).toMatchObject({
				attemptOrdinal: 2,
				status: "completed",
				handoff: {
					attemptId: finalChild.attemptId,
					baselineHead: BASELINE_HEAD,
					handoffCommit,
				},
			});
			expect(execution.priorSettlements).toHaveLength(1);
			expect(execution.priorSettlements?.[0]?.evidence).toMatchObject({
				attemptOrdinal: 1,
				status: "failed",
			});
			expect(execution.priorSettlements?.[0]?.evidence.handoff).toBeUndefined();
			expect(delegated.exportHandoff).toHaveBeenCalledExactlyOnceWith(
				finalChild.runId,
				{ maxBytes: HANDOFF_BOUND_BYTES },
			);
			expect(execution.handoffImport).toMatchObject({
				subagentRunId: finalChild.runId,
				subagentAttemptId: finalChild.attemptId,
				baselineHead: BASELINE_HEAD,
				handoffCommit,
			});
			const types = await eventTypes(fixture.storeRoot, receipt.runId);
			expect(countOf(types, "task-execution-child-settled")).toBe(2);
			expect(countOf(types, "task-execution-handoff-imported")).toBe(1);
			expect(
				artifactsOf(state, writer, "handoff").map(
					(artifact) => artifact.sha256,
				),
			).toEqual([sha256(patchFor(handoffCommit))]);
			await expect(
				service.exportHandoff(receipt.runId, writer.task.id),
			).resolves.toMatchObject({
				descriptor: expectedDescriptor(state, writer, finalChild),
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("replays a completed worktree task from its verified handoff artifact and refuses a corrupted one", async () => {
		const success = await completedWorktreeRun("worktree-replay");
		await shutdownQuietly(success.service);
		const cutAtTaskCompletion = (event: WorkflowJournalEvent) =>
			event.type === "task-status-changed" &&
			(event.data as { taskId: string; to: string }).taskId ===
				success.writer.task.id &&
			(event.data as { to: string }).to === "completed";

		// Same store, second wait: the durable completion is served, nothing runs.
		const again = worktreeProvider({ launches: [] });
		const reopened = await createWorkflowService({
			...success.fixture,
			projectTrusted: () => true,
			subagents: again.provider,
		});
		try {
			await expect(
				bounded(reopened.wait(success.runId), "second wait"),
			).resolves.toMatchObject({
				status: "completed",
				output: { answer: "from child" },
			});
			expect(again.state.calls).toEqual([]);
		} finally {
			await shutdownQuietly(reopened);
		}

		// Crash before output commit: the re-executed definition replays the
		// worktree task from the verified handoff artifact, no subagent call.
		const intact = await crashImageAfter(
			success.fixture,
			success.runId,
			cutAtTaskCompletion,
		);
		expect(intact.prefix.map((event) => event.type)).not.toContain(
			"run-output-committed",
		);
		const replaying = worktreeProvider({
			launches: [],
			children: success.delegated.state.children,
		});
		const replayService = await createWorkflowService({
			...success.fixture,
			storeRoot: intact.storeRoot,
			projectTrusted: () => true,
			subagents: replaying.provider,
		});
		try {
			await expect(
				bounded(replayService.wait(success.runId), "replay wait"),
			).resolves.toMatchObject({
				status: "completed",
				output: { answer: "from child" },
			});
			expect(replaying.state.calls).toEqual([]);
			const types = await eventTypes(intact.storeRoot, success.runId);
			expect(countOf(types, "task-execution-created")).toBe(1);
			expect(countOf(types, "task-execution-child-settled")).toBe(1);
			expect(countOf(types, "task-execution-handoff-imported")).toBe(1);
			expect(countOf(types, "run-output-committed")).toBe(1);
			const state = await stateOf(intact.storeRoot, success.runId);
			expect(
				artifactsOf(state, taskByKey(state, "writer"), "handoff"),
			).toHaveLength(1);
		} finally {
			await shutdownQuietly(replayService);
		}

		// Same crash window with a corrupted patch blob: replay fails closed.
		const corrupted = await crashImageAfter(
			success.fixture,
			success.runId,
			cutAtTaskCompletion,
		);
		const handoffArtifact = onlyArtifact(
			success.state,
			success.writer,
			"handoff",
		);
		await writeFile(
			path.join(
				artifactsDir(corrupted.storeRoot, success.runId),
				`${handoffArtifact.sha256}.patch`,
			),
			patchFor("e".repeat(40)),
		);
		const refusing = worktreeProvider({
			launches: [],
			children: success.delegated.state.children,
		});
		const corruptService = await createWorkflowService({
			...success.fixture,
			storeRoot: corrupted.storeRoot,
			projectTrusted: () => true,
			subagents: refusing.provider,
		});
		try {
			const error: unknown = await bounded(
				corruptService.wait(success.runId),
				"corrupt wait",
			).then(
				(view) => new Error(`replay resolved with ${JSON.stringify(view)}`),
				(caught: unknown) => caught,
			);
			expect(messagesOf(error)).toContain(HANDOFF_UNVERIFIED_MESSAGE);
			expect(refusing.state.calls).toEqual([]);
			expect(await journalEvents(corrupted.storeRoot, success.runId)).toEqual(
				corrupted.prefix,
			);
			await expect(corruptService.status(success.runId)).resolves.toMatchObject(
				{ status: reduceWorkflowEvents(corrupted.prefix).status },
			);
		} finally {
			await shutdownQuietly(corruptService);
		}
	});

	it("refuses a pi-subagent client without exportHandoff or a revision-5 contract before run creation", async () => {
		const context = {} as ExtensionContext;
		const subagentService = (ownerClient: SubagentClient): SubagentService =>
			({
				forOwner: vi.fn(() => ownerClient),
				listRuns: vi.fn(),
				inspectRun: vi.fn(),
				runLogs: vi.fn(),
				subscribe: vi.fn(() => () => {}),
				prune: vi.fn(),
				shutdown: vi.fn(),
			}) as unknown as SubagentService;

		// A client that predates handoff export.
		const revisionFiveClient = worktreeProvider({ launches: [] });
		const withoutExport = {
			...(await revisionFiveClient.bind("workflow_probe")).client,
		} as unknown as Record<string, unknown>;
		delete withoutExport.exportHandoff;
		const clientEvents = createEventBus();
		registerSubagentServiceProvider(clientEvents, async () =>
			subagentService(withoutExport as unknown as SubagentClient),
		);
		const clientFixture = await worktreeFixture({
			name: "worktree-gate-client",
			body: "return writer;",
		});
		const clientGate = await createWorkflowService({
			...clientFixture,
			projectTrusted: () => true,
			subagents: createWorkflowSubagentProvider(clientEvents, context),
		});
		try {
			await expect(
				clientGate.run("worktree-gate-client", {}),
			).rejects.toMatchObject({
				code: "incompatible",
				message: "The pi-subagent service returned an invalid owner client.",
			});
			await expect(access(clientFixture.storeRoot)).rejects.toMatchObject({
				code: "ENOENT",
			});
		} finally {
			await shutdownQuietly(clientGate);
		}

		// A provider publishing the revision-5 contract (no handoffExport).
		const revisionFiveEvents: EventBus = {
			on() {
				return () => {};
			},
			emit(_channel, value) {
				const request = value as { respond(provider: unknown): void };
				request.respond({
					contract: {
						...SUBAGENT_RUNTIME_CONTRACT,
						contractRevision: 5,
						features: {
							...SUBAGENT_RUNTIME_CONTRACT.features,
							handoffExport: false,
						},
					},
					acquire: async () =>
						subagentService(
							(await worktreeProvider({ launches: [] }).bind("workflow_probe"))
								.client,
						),
				});
			},
		};
		const contractFixture = await worktreeFixture({
			name: "worktree-gate-contract",
			body: "return writer;",
		});
		const contractGate = await createWorkflowService({
			...contractFixture,
			projectTrusted: () => true,
			subagents: createWorkflowSubagentProvider(revisionFiveEvents, context),
		});
		try {
			await expect(
				contractGate.run("worktree-gate-contract", {}),
			).rejects.toMatchObject({
				code: "incompatible",
				message: "The registered pi-subagent service provider is incompatible.",
			});
			await expect(access(contractFixture.storeRoot)).rejects.toMatchObject({
				code: "ENOENT",
			});
		} finally {
			await shutdownQuietly(contractGate);
		}
	});
});
