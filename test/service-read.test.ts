import { createHash, randomUUID } from "node:crypto";
import {
	appendFile,
	chmod,
	mkdir,
	readFile,
	realpath,
	symlink,
	writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
	type ExtensionAPI,
	getAgentDir,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentLaunchPlan,
	canonicalSha256,
	type RunReceipt,
	type RunResult,
	SUBAGENT_RUNTIME_CONTRACT,
	type SubagentClient,
	type SubagentRequest,
} from "@vegardx/pi-subagent";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStateProjection } from "../src/events.js";
import workflowExtension from "../src/extension.js";
import {
	type WorkflowJournalEvent,
	WorkflowRunJournal,
} from "../src/persistence/journal.js";
import {
	WorkflowPersistenceCorruptionError,
	type WorkflowRunLeaseRecord,
} from "../src/persistence/run-lease.js";
import { workflowStateRoot } from "../src/persistence/state-root.js";
import { reduceWorkflowEvents } from "../src/reducer.js";
import {
	createWorkflowService,
	type WorkflowService,
	WorkflowServiceError,
} from "../src/service.js";
import {
	WorkflowLogPageSchema,
	WorkflowRunInspectionSchema,
	WorkflowRunPageSchema,
	WorkflowRunSummarySchema,
	WorkflowServiceReconcileViewSchema,
	WorkflowServiceWaitViewSchema,
} from "../src/service-views.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";
import { useTempAgentDir } from "./fixtures/agent-dir.js";

// ---------------------------------------------------------------------------
// Helpers copied from the service test files
// ---------------------------------------------------------------------------

const SHA = "a".repeat(64);
const LOG_LINES = 20;
const LOG_LINE = "x".repeat(4_000);
const VALUE_SCHEMA =
	'{ type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }';
const ANSWER_SCHEMA =
	'{ type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

function root(name: string): string {
	return path.resolve(".pi", "test-service-read", `${name}-${randomUUID()}`);
}

/**
 * The read tools boot the extension, which derives its store root from
 * `getAgentDir()`; every test gets a throwaway agent directory.
 */
beforeEach(async () => {
	await useTempAgentDir(root("agent"));
});

afterEach(() => {
	vi.unstubAllEnvs();
});

async function until(predicate: () => boolean | Promise<boolean>) {
	while (!(await predicate())) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

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

function definition(
	name: string,
	body: string,
	description = "Read surface",
): string {
	return `export default {
  schema: "pi-workflow-definition",
  meta: { name: ${JSON.stringify(name)}, description: ${JSON.stringify(description)}, version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 3600000, concurrency: 4 },
  inputSchema: ${VALUE_SCHEMA},
  outputSchema: ${ANSWER_SCHEMA},
  run(ctx) {
    ${body}
  }
};
`;
}

const AGENT_BODY = (policies: string, limitCost: number, retries: number) =>
	`return ctx.agent("answer", {
      agent: "researcher",
      task: { goal: "Answer", context: [], instructions: ["Return structured output."] },
      contextMode: "fresh",
      tools: ["read"],
      preloadSkills: [],
      contextScopes: ["project"],
      workspace: { mode: "read-only", cwd: ctx.cwd },
      outputSchema: ${ANSWER_SCHEMA},
      ${policies}
      limits: { cumulativeRuntimeMs: 300000, attemptTimeoutMs: 300000, totalTokens: 1000000, cost: ${limitCost}, outputBytes: 1024, workspaceWriteBytes: 0, retries: ${retries}, resumes: 0 }
    });`;

/**
 * One project with every definition the read surface tests drive:
 * `example` (pure), `logger` (large effects), `nest-parent`/`echo-child`
 * (nested), and `attempts` (one delegated agent task).
 */
async function projectFixture(name = "project") {
	const base = root(name);
	const cwd = path.join(base, "project");
	// The throwaway agent dir this test stubbed: the read tools reach the
	// store through the extension, which derives the root from it.
	const agentDir = getAgentDir();
	const storeRoot = workflowStateRoot(cwd, agentDir);
	const workflows = path.join(cwd, "workflows");
	await mkdir(workflows, { recursive: true });
	const files: Record<string, string> = {
		example: definition("example", "return { answer: ctx.input.value };"),
		logger: definition(
			"logger",
			`ctx.phase("logging");
    for (let index = 0; index < ${LOG_LINES}; index += 1) {
      ctx.log("L" + String(index).padStart(3, "0") + " " + ${JSON.stringify(LOG_LINE)});
    }
    return { answer: "logged" };`,
		),
		"echo-child": definition(
			"echo-child",
			'ctx.phase("child"); return { answer: ctx.input.value.toUpperCase() };',
		),
		"nest-parent": definition(
			"nest-parent",
			'return ctx.workflow("child", { workflow: "echo-child", input: { value: ctx.input.value } });',
		),
		attempts: definition("attempts", AGENT_BODY("", 10, 0)),
	};
	for (const [workflow, source] of Object.entries(files)) {
		await writeFile(path.join(workflows, `${workflow}.workflow.ts`), source);
	}
	return { cwd, agentDir, storeRoot };
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
	readonly cost?: number;
}

function childIds(nonce: string, launch: number) {
	return {
		runId: `run_child${nonce}${launch}`,
		attemptId: `attempt_child${nonce}${launch}`,
	};
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
 * last one repeats); retry/resume hand out fresh attempt ids.
 */
function attemptProvider(outcomes: readonly ChildOutcome[]) {
	const nonce = randomUUID().replaceAll("-", "").slice(0, 8);
	const child = { nonce, launches: 0, ...childIds(nonce, 0) };
	let taskOwnerId = "";
	let attempts = 1;
	let waits = 0;
	let lastStatus: RunResult["status"] = "completed";
	const preflight = vi.fn(async (request: SubagentRequest) => {
		const planned = childIds(child.nonce, child.launches + 1);
		const draft = {
			schema: "pi-subagent-launch" as const,
			contractRevision: SUBAGENT_RUNTIME_CONTRACT.contractRevision,
			operationId: request.operationId,
			ownerId: taskOwnerId,
			runId: planned.runId,
			attemptId: planned.attemptId,
			agent: request.agent,
			agentDisplayName: "Researcher",
			agentPrompt: "Research",
			agentSource: "/agent.md",
			agentSha256: SHA,
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
					sha256: SHA,
				},
			],
			workspace: {
				mode: request.workspace.mode,
				hostPathSha256: SHA,
				baselineSha256: SHA,
			},
			sandbox: {
				backend: "gondolin" as const,
				packageVersion: "0.12.0",
				imageSha256: SHA,
				mountPolicySha256: SHA,
				networkPolicySha256: SHA,
				capacityPolicySha256: SHA,
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
		return {
			preflightId: "preflight-read",
			identitySha256: canonicalSha256(draft),
			expiresAt: "2099-01-01T00:00:00.000Z",
			launchPlan: { ...draft, identitySha256: canonicalSha256(draft) },
		};
	});
	const nextAttempt = async (): Promise<RunReceipt> => {
		attempts += 1;
		child.attemptId = `${childIds(child.nonce, child.launches).attemptId}x${attempts}`;
		return { runId: child.runId, attemptId: child.attemptId, status: "active" };
	};
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
		wait: vi.fn(async () => {
			const outcome = outcomes[Math.min(waits, outcomes.length - 1)];
			if (!outcome) throw new Error("no child outcome scripted");
			waits += 1;
			lastStatus = outcome.status;
			return childResult(outcome, child.runId);
		}),
		release: vi.fn(async () => ({
			runId: child.runId,
			attemptId: child.attemptId,
			status: lastStatus === "interrupted" ? "completed" : lastStatus,
		})),
		retry: vi.fn(nextAttempt),
		resume: vi.fn(nextAttempt),
		interrupt: vi.fn(async () => {
			throw new Error("unexpected interrupt");
		}),
	} as unknown as SubagentClient;
	const bind = vi.fn(async (runId: string) => {
		taskOwnerId = `pi-workflow:${runId}`;
		return {
			workflowRunId: runId,
			ownerId: taskOwnerId,
			client: ownerClient,
		} satisfies WorkflowSubagentBinding;
	});
	return { provider: { bind } as WorkflowSubagentProvider, ownerClient, child };
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

function agentTaskIdOf(state: WorkflowStateProjection): string {
	const task = Object.values(state.tasks).find(
		(candidate) => candidate.task.spec.kind === "agent",
	);
	if (!task) throw new Error("missing agent task");
	return task.task.id;
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

async function shutdownQuietly(
	service: { shutdown(): Promise<void> } | undefined,
) {
	if (!service) return;
	await bounded(service.shutdown(), "shutdown").catch(() => undefined);
}

async function serviceFor(
	fixture: { cwd: string; agentDir: string; storeRoot: string },
	subagents: WorkflowSubagentProvider = inertProvider(),
) {
	return createWorkflowService({
		...fixture,
		projectTrusted: () => true,
		subagents,
	});
}

async function completedRun(
	service: {
		run: WorkflowService["run"];
		wait(runId: string): Promise<{ status: string }>;
	},
	ref: string,
	input: unknown = { value: "durable" },
): Promise<string> {
	const receipt = await service.run(ref, input);
	const view = await bounded(service.wait(receipt.runId), `wait ${ref}`);
	expect(view.status).toBe("completed");
	return receipt.runId;
}

/** Drives the agent-task workflow once with `outcomes` until it settles. */
async function settledAttemptRun(
	fixture: { cwd: string; agentDir: string; storeRoot: string },
	outcomes: readonly ChildOutcome[],
) {
	const delegated = attemptProvider(outcomes);
	const service = await serviceFor(fixture, delegated.provider);
	const receipt = await service.run("attempts", { value: "x" });
	const first = await bounded(service.wait(receipt.runId), "first wait");
	const taskId = agentTaskIdOf(await stateOf(fixture.storeRoot, receipt.runId));
	return { service, delegated, runId: receipt.runId, taskId, first };
}

// Lease decoys (from test/run-lease.test.ts) ----------------------------------

const LEASE_BANNER_PREFIX = "pi-workflow-lease/1 ";

interface Decoy {
	readonly port: number;
	close(): Promise<void>;
}

/** Occupies a lease port; `banner` undefined keeps the connection silent. */
async function decoy(port: number, banner?: string): Promise<Decoy> {
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.once("close", () => sockets.delete(socket));
		if (banner !== undefined) socket.end(banner);
	});
	server.on("error", () => {});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
			server.off("error", reject);
			resolve();
		});
	});
	return {
		port,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}

/** The identity a live lease listener answers with, over the canonical store root. */
async function leaseIdentity(
	storeRoot: string,
	runId: string,
): Promise<string> {
	const canonical = await realpath(storeRoot);
	return createHash("sha256").update(`${canonical}\0${runId}`).digest("hex");
}

async function leaseRecord(
	storeRoot: string,
	runId: string,
): Promise<WorkflowRunLeaseRecord> {
	return JSON.parse(
		await readFile(
			path.join(await realpath(storeRoot), "leases", `${runId}.lease.json`),
			"utf8",
		),
	) as WorkflowRunLeaseRecord;
}

// Service surface types used by these tests (structural; the module is the
// source of truth) --------------------------------------------------------------

type ReadService = Omit<
	WorkflowService,
	"listRuns" | "inspect" | "logs" | "subscribe" | "wait" | "reconcile"
> & {
	listRuns(query?: unknown): Promise<{
		runs: readonly {
			runId: string;
			status: string;
			depth: number;
			parent?: { runId: string; taskId: string; inputArtifacts: unknown };
			createdAt: string;
			ownership: string;
			leasedElsewhere: boolean;
			availableActions: readonly string[];
			requiresAttention: boolean;
			outputArtifactId?: string;
			taskCounts: Record<string, number>;
		}[];
		nextCursor?: string;
		total: number;
		issues: readonly {
			runId?: string;
			directory: string;
			kind: string;
			message: string;
		}[];
		issuesTruncated: number;
		generatedAt: string;
	}>;
	inspect(
		runId: string,
		options?: unknown,
	): Promise<{
		run: {
			status: string;
			ownership: string;
			availableActions: readonly string[];
			requiresAttention: boolean;
			outputArtifactId?: string;
			output?: unknown;
			parent?: unknown;
		};
		budget?: {
			declared: unknown;
			effective: unknown;
			settled: {
				cost: number;
				totalTokens: number;
				childRuntimeMs: number;
				usageComplete: boolean;
			};
			reserved: { cost: number; totalTokens: number; childRuntimeMs: number };
			exceeded?: string;
		};
		tasks?: readonly Record<string, unknown>[];
		executions?: readonly Record<string, unknown>[];
		effects?: readonly Record<string, unknown>[];
		barriers?: readonly Record<string, unknown>[];
		artifacts?: readonly { id: string; isRunOutput: boolean }[];
		truncated: Record<string, number>;
	}>;
	logs(
		runId: string,
		options?: unknown,
	): Promise<{
		runId: string;
		entries: readonly {
			sequence: number;
			timestamp: string;
			kind: string;
			message: string;
			status?: string;
			reason?: string;
			failureCode?: string;
			taskId?: string;
			taskKey?: string;
		}[];
		nextAfterSequence?: number;
		lastSequence: number;
	}>;
	subscribe(
		listener: (observation: {
			runId: string;
			status: string;
			sequence: number;
		}) => void,
	): () => void;
	wait(
		runId: string,
		options?: { timeoutMs?: unknown },
	): Promise<{ status: string; timedOut?: true }>;
	reconcile(
		runId: string,
		options?: { taskId?: string },
	): Promise<{ status: string; reconciled: readonly unknown[] }>;
};

const asRead = (service: WorkflowService) => service as unknown as ReadService;

const LOG_KINDS = new Set([
	"phase",
	"log",
	"run",
	"task",
	"attempt",
	"terminal",
	"invalidation",
]);

// ---------------------------------------------------------------------------
// listRuns
// ---------------------------------------------------------------------------

describe("listRuns", () => {
	it("returns an empty page when no run directory exists", async () => {
		const fixture = await projectFixture("empty");
		const service = asRead(await serviceFor(fixture));
		try {
			const page = await service.listRuns();
			expect(page).toMatchObject({
				runs: [],
				total: 0,
				issues: [],
				issuesTruncated: 0,
			});
			expect(page.nextCursor).toBeUndefined();
			expect(Number.isFinite(Date.parse(page.generatedAt))).toBe(true);
			expect(Value.Check(WorkflowRunPageSchema, page)).toBe(true);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("lists runs newest first with status filters and a stable cursor", async () => {
		const fixture = await projectFixture("ordering");
		const service = asRead(await serviceFor(fixture));
		try {
			const created: string[] = [];
			for (const value of ["one", "two", "three"]) {
				created.push(await completedRun(service, "example", { value }));
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			const page = await service.listRuns();
			expect(Value.Check(WorkflowRunPageSchema, page)).toBe(true);
			expect(page.total).toBe(3);
			expect(page.nextCursor).toBeUndefined();
			expect(page.issues).toEqual([]);
			expect(page.runs.map((run) => run.runId)).toEqual([...created].reverse());
			const timestamps = page.runs.map((run) => run.createdAt);
			expect(timestamps).toEqual([...timestamps].sort().reverse());
			for (const run of page.runs) {
				expect(Value.Check(WorkflowRunSummarySchema, run)).toBe(true);
				expect(run).toMatchObject({
					status: "completed",
					depth: 0,
					ownership: "owned",
					leasedElsewhere: false,
					availableActions: [],
					requiresAttention: false,
				});
				expect(run.outputArtifactId).toMatch(/^artifact_/);
				expect(run).not.toHaveProperty("output");
				expect(run).not.toHaveProperty("parent");
			}

			await expect(
				service.listRuns({ statuses: ["failed", "interrupted"] }),
			).resolves.toMatchObject({ runs: [], total: 0 });
			const completed = await service.listRuns({ statuses: ["completed"] });
			expect(completed.runs).toHaveLength(3);
			expect(completed.total).toBe(3);

			const first = await service.listRuns({ limit: 2 });
			expect(first.runs).toHaveLength(2);
			expect(first.total).toBe(3);
			expect(typeof first.nextCursor).toBe("string");
			const second = await service.listRuns({
				limit: 2,
				cursor: first.nextCursor,
			});
			expect(second.runs).toHaveLength(1);
			expect(second.total).toBe(3);
			expect(second.nextCursor).toBeUndefined();
			expect([...first.runs, ...second.runs].map((run) => run.runId)).toEqual(
				page.runs.map((run) => run.runId),
			);
			// A cursor encodes a position, so replaying it yields the same page.
			await expect(
				service.listRuns({ limit: 2, cursor: first.nextCursor }),
			).resolves.toMatchObject({
				runs: second.runs.map((run) => ({ runId: run.runId })),
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("reports inactive ownership for runs a previous service completed", async () => {
		const fixture = await projectFixture("inactive");
		const first = await serviceFor(fixture);
		const runId = await completedRun(first, "example");
		await bounded(first.shutdown(), "shutdown");
		const service = asRead(await serviceFor(fixture));
		try {
			const page = await service.listRuns();
			expect(page.runs).toHaveLength(1);
			expect(page.runs[0]).toMatchObject({
				runId,
				status: "completed",
				ownership: "inactive",
				leasedElsewhere: false,
				availableActions: [],
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("rejects malformed queries and cursors before scanning", async () => {
		const fixture = await projectFixture("query");
		const service = asRead(await serviceFor(fixture));
		try {
			for (const query of [
				{ limit: 0 },
				{ limit: 101 },
				{ limit: 1.5 },
				{ statuses: [] },
				{ statuses: ["completed", "completed"] },
				{ statuses: ["bogus"] },
				{ includeChildren: "yes" },
			]) {
				await expectServiceError(
					service.listRuns(query),
					"validation",
					"Invalid workflow run query.",
				);
			}
			for (const cursor of [
				"not-base64url!",
				Buffer.from(JSON.stringify({ v: 2, c: "x", r: "y" })).toString(
					"base64url",
				),
				Buffer.from(JSON.stringify({ v: 1, c: 5, r: "y" })).toString(
					"base64url",
				),
				Buffer.from("[]").toString("base64url"),
			]) {
				await expectServiceError(
					service.listRuns({ cursor }),
					"validation",
					"Invalid workflow run cursor.",
				);
			}
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("hides nested child runs unless includeChildren is set", async () => {
		const fixture = await projectFixture("nested");
		const service = asRead(await serviceFor(fixture));
		try {
			const parentId = await completedRun(service, "nest-parent", {
				value: "up",
			});
			const roots = await service.listRuns();
			expect(roots.runs.map((run) => run.runId)).toEqual([parentId]);
			expect(roots.total).toBe(1);
			const all = await service.listRuns({ includeChildren: true });
			expect(all.total).toBe(2);
			expect(all.runs).toHaveLength(2);
			const child = all.runs.find((run) => run.runId !== parentId);
			expect(child).toMatchObject({
				status: "completed",
				depth: 1,
				parent: { runId: parentId, inputArtifacts: {} },
				availableActions: [],
			});
			expect(child?.parent?.taskId).toMatch(/^task_/);
			expect(Value.Check(WorkflowRunPageSchema, all)).toBe(true);
			expect(
				(await service.listRuns({ includeChildren: false })).runs.map(
					(run) => run.runId,
				),
			).toEqual([parentId]);
			if (!child) throw new Error("missing child run");
			const inspection = await service.inspect(child.runId);
			expect(inspection.run.parent).toEqual(child.parent);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("marks a run leased by another live process and offers it no actions", async () => {
		const fixture = await projectFixture("leased");
		const first = await serviceFor(fixture);
		const runId = await completedRun(first, "example");
		await bounded(first.shutdown(), "shutdown");
		const record = await leaseRecord(fixture.storeRoot, runId);
		const identity = await leaseIdentity(fixture.storeRoot, runId);
		const holder = await decoy(
			record.port,
			`${LEASE_BANNER_PREFIX}${identity}\n`,
		);
		const service = asRead(await serviceFor(fixture));
		try {
			const page = await service.listRuns();
			expect(page.runs).toHaveLength(1);
			expect(page.runs[0]).toMatchObject({
				runId,
				status: "completed",
				ownership: "leased-elsewhere",
				leasedElsewhere: true,
				availableActions: [],
				requiresAttention: false,
			});
			// Reads never lease, so inspection still works while the run is held.
			const inspection = await service.inspect(runId);
			expect(inspection.run.ownership).toBe("leased-elsewhere");
			expect(inspection.run.availableActions).toEqual([]);
			// The invalidation preview is a read too: it reaches the reducer over
			// the held run's journal instead of failing on the lease.
			await expectServiceError(
				service.previewInvalidation(runId, "task_unknown0000"),
				"validation",
				"invalidation cause task is unknown",
			);
			// The empty action list is honest: lifecycle calls need the lease.
			await expectServiceError(
				service.wait(runId),
				"conflict",
				"Workflow run is owned by another live service.",
			);
			await holder.close();
			await expect(service.listRuns()).resolves.toMatchObject({
				runs: [{ runId, ownership: "inactive", leasedElsewhere: false }],
			});

			const stranger = await decoy(
				record.port,
				`${LEASE_BANNER_PREFIX}${createHash("sha256").update("unrelated").digest("hex")}\n`,
			);
			try {
				await expect(service.listRuns()).resolves.toMatchObject({
					runs: [{ runId, ownership: "inactive" }],
				});
			} finally {
				await stranger.close();
			}

			const silent = await decoy(record.port);
			try {
				await expect(service.listRuns()).resolves.toMatchObject({
					runs: [
						{ runId, ownership: "leased-elsewhere", leasedElsewhere: true },
					],
				});
			} finally {
				await silent.close();
			}
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("reports per-directory issues without failing the listing", async () => {
		const fixture = await projectFixture("issues");
		const first = await serviceFor(fixture);
		const good = await completedRun(first, "example", { value: "good" });
		const corrupt = await completedRun(first, "example", { value: "corrupt" });
		const torn = await completedRun(first, "example", { value: "torn" });
		await bounded(first.shutdown(), "shutdown");
		const runs = path.join(fixture.storeRoot, "runs");
		await appendFile(path.join(runs, corrupt, "events.jsonl"), "{broken}\n");
		await appendFile(path.join(runs, torn, "events.jsonl"), '{"schema"');
		await mkdir(path.join(runs, "not-a-run"));
		await mkdir(path.join(runs, "workflow_missingrecord"));
		await mkdir(path.join(runs, "workflow_badrecord"));
		await writeFile(
			path.join(runs, "workflow_badrecord", "service.json"),
			"garbage\n",
		);
		await symlink(path.join(runs, good), path.join(runs, "workflow_symlinked"));
		await writeFile(path.join(runs, "workflow_plainfile"), "x");
		// Sorted after every run-shaped name so the truncated tail is all noise.
		for (let index = 0; index < 18; index += 1) {
			await mkdir(
				path.join(runs, `zz-bogus-${String(index).padStart(2, "0")}`),
			);
		}
		const service = asRead(await serviceFor(fixture));
		try {
			const page = await service.listRuns();
			expect(Value.Check(WorkflowRunPageSchema, page)).toBe(true);
			expect(page.runs.map((run) => run.runId).sort()).toEqual(
				[good, torn].sort(),
			);
			expect(page.total).toBe(2);
			// 18 bogus + not-a-run + symlink + plain file + missing + bad + corrupt + torn = 25
			expect(page.issues).toHaveLength(16);
			expect(page.issuesTruncated).toBe(9);
			const directories = page.issues.map((issue) => issue.directory);
			expect(directories).toEqual([...directories].sort());
			for (const issue of page.issues) {
				expect(issue.directory).not.toContain("/");
			}
			const bogus = page.issues.filter((issue) =>
				issue.directory.startsWith("zz-bogus-"),
			);
			expect(bogus.length).toBeGreaterThan(0);
			for (const issue of bogus) {
				expect(issue).toEqual({
					directory: issue.directory,
					kind: "invalid-directory",
					message: "Workflow run directory is invalid.",
				});
			}
			for (const directory of [
				"not-a-run",
				"workflow_symlinked",
				"workflow_plainfile",
			]) {
				expect(
					page.issues.find((issue) => issue.directory === directory),
					directory,
				).toEqual({
					directory,
					kind: "invalid-directory",
					message: "Workflow run directory is invalid.",
				});
			}
			expect(page.issues.map((issue) => issue.kind)).toEqual(
				expect.arrayContaining([
					"corrupt-journal",
					"torn-tail",
					"invalid-record",
					"missing-record",
				]),
			);

			await expectServiceError(
				service.inspect(corrupt),
				"persistence",
				"Workflow run journal is corrupt.",
			);
			await expectServiceError(
				service.logs(corrupt),
				"persistence",
				"Workflow run journal is corrupt.",
			);
			await expectServiceError(
				service.inspect("workflow_badrecord"),
				"persistence",
				"Workflow run record is invalid.",
			);
			await expectServiceError(
				service.inspect("workflow_doesnotexist"),
				"not-found",
				"Workflow run not found: workflow_doesnotexist",
			);
			// A file or a symlink where a run directory would be is no run either.
			await expectServiceError(
				service.inspect("workflow_plainfile"),
				"not-found",
				"Workflow run not found: workflow_plainfile",
			);
			await expectServiceError(
				service.logs("workflow_symlinked"),
				"not-found",
				"Workflow run not found: workflow_symlinked",
			);
			// The torn run's complete prefix is used.
			const tornInspection = await service.inspect(torn);
			expect(tornInspection.run.status).toBe("completed");
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("collects run-shaped issues by kind", async () => {
		const fixture = await projectFixture("issue-kinds");
		const first = await serviceFor(fixture);
		const corrupt = await completedRun(first, "example", { value: "corrupt" });
		const torn = await completedRun(first, "example", { value: "torn" });
		await bounded(first.shutdown(), "shutdown");
		const runs = path.join(fixture.storeRoot, "runs");
		await appendFile(path.join(runs, corrupt, "events.jsonl"), "{broken}\n");
		await appendFile(path.join(runs, torn, "events.jsonl"), '{"schema"');
		await mkdir(path.join(runs, "workflow_missingrecord"));
		await mkdir(path.join(runs, "workflow_badrecord"));
		await writeFile(
			path.join(runs, "workflow_badrecord", "service.json"),
			"garbage\n",
		);
		const service = asRead(await serviceFor(fixture));
		try {
			const page = await service.listRuns();
			expect(page.issuesTruncated).toBe(0);
			expect(page.runs.map((run) => run.runId)).toEqual([torn]);
			expect(page.issues).toEqual(
				[
					{
						runId: corrupt,
						directory: corrupt,
						kind: "corrupt-journal",
						message: "Workflow run journal is corrupt.",
					},
					{
						runId: torn,
						directory: torn,
						kind: "torn-tail",
						message:
							"Workflow run journal has a torn tail record; the complete prefix was used.",
					},
					{
						runId: "workflow_badrecord",
						directory: "workflow_badrecord",
						kind: "invalid-record",
						message: "Workflow run record is invalid.",
					},
					{
						runId: "workflow_missingrecord",
						directory: "workflow_missingrecord",
						kind: "missing-record",
						message: "Workflow run record is missing.",
					},
				].sort((left, right) => left.directory.localeCompare(right.directory)),
			);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("reports an unreadable record and a corrupt owned journal as issues, never as failures", async () => {
		const fixture = await projectFixture("unreadable");
		const first = await serviceFor(fixture);
		const unreadable = await completedRun(first, "example", { value: "a" });
		await bounded(first.shutdown(), "first shutdown");
		const raw = await serviceFor(fixture);
		const service = asRead(raw);
		const owned = await completedRun(raw, "example", { value: "b" });
		const record = path.join(
			fixture.storeRoot,
			"runs",
			unreadable,
			"service.json",
		);
		await chmod(record, 0o000);
		// Root reads a mode-000 file, so that half of the check is skipped there.
		const privileged = process.getuid?.() === 0;
		const corruption = () =>
			new WorkflowPersistenceCorruptionError(
				"workflow journal append outcome is uncertain",
			);
		const readEvents = vi.spyOn(WorkflowRunJournal.prototype, "readEvents");
		// inspect and logs read events and state in one coordinated read.
		const readProjected = vi.spyOn(
			WorkflowRunJournal.prototype,
			"readProjected",
		);
		try {
			// Only the owned run reads through its journal object; the unleased
			// reader is a free function, so the rejection lands on the owned run.
			readEvents.mockRejectedValueOnce(corruption());
			const page = await service.listRuns();
			expect(Value.Check(WorkflowRunPageSchema, page)).toBe(true);
			expect(page.issues).toContainEqual({
				runId: owned,
				directory: owned,
				kind: "corrupt-journal",
				message: "Workflow run journal is corrupt.",
			});
			if (privileged) {
				expect(page.runs.map((run) => run.runId)).toEqual([unreadable]);
			} else {
				expect(page.runs).toEqual([]);
				expect(page.issues).toContainEqual({
					runId: unreadable,
					directory: unreadable,
					kind: "unreadable",
					message: "Workflow run could not be read.",
				});
				expect(page.issues).toHaveLength(2);
			}
			// With the record readable and the journal intact, both runs list.
			await chmod(record, 0o600);
			const healthy = await service.listRuns();
			expect(healthy.issues).toEqual([]);
			expect(healthy.runs.map((run) => run.runId).sort()).toEqual(
				[owned, unreadable].sort(),
			);

			readProjected.mockRejectedValueOnce(corruption());
			const inspected = await expectServiceError(
				service.inspect(owned),
				"persistence",
				"Workflow run journal is corrupt.",
			);
			expect(inspected.cause).toBeInstanceOf(
				WorkflowPersistenceCorruptionError,
			);
			readProjected.mockRejectedValueOnce(corruption());
			const logged = await expectServiceError(
				service.logs(owned),
				"persistence",
				"Workflow run journal is corrupt.",
			);
			expect(logged.cause).toBeInstanceOf(WorkflowPersistenceCorruptionError);
			expect((await service.inspect(owned)).run.status).toBe("completed");
		} finally {
			readEvents.mockRestore();
			readProjected.mockRestore();
			await chmod(record, 0o600);
			await shutdownQuietly(service);
		}
	});
});

// ---------------------------------------------------------------------------
// inspect and logs
// ---------------------------------------------------------------------------

describe("inspect and logs", () => {
	it("inspects and logs a completed agent run without leaking prompts or output", async () => {
		const fixture = await projectFixture("completed");
		const {
			service: raw,
			runId,
			taskId,
		} = await settledAttemptRun(fixture, [{ status: "completed", cost: 0.01 }]);
		const service = asRead(raw);
		try {
			const inspection = await service.inspect(runId);
			expect(Value.Check(WorkflowRunInspectionSchema, inspection)).toBe(true);
			expect(Object.keys(inspection).sort()).toEqual([
				"budget",
				"run",
				"tasks",
				"truncated",
			]);
			expect(inspection.truncated).toEqual({});
			expect(inspection.run).toMatchObject({
				status: "completed",
				ownership: "owned",
				availableActions: [],
				requiresAttention: false,
			});
			expect(inspection.run).not.toHaveProperty("output");
			expect(inspection.budget).toMatchObject({
				declared: { cost: 1000, childRuntimeMs: 3_600_000 },
				effective: { cost: 1000, childRuntimeMs: 3_600_000 },
				settled: {
					cost: 0.01,
					totalTokens: 2,
					childRuntimeMs: 10,
					usageComplete: true,
				},
				reserved: { cost: 0, totalTokens: 0, childRuntimeMs: 0 },
			});
			expect(inspection.budget?.exceeded).toBeUndefined();
			expect(inspection.tasks).toEqual([
				{
					id: taskId,
					namespace: [],
					key: "answer",
					kind: "agent",
					role: "task",
					disposition: "required",
					status: "completed",
					generation: 1,
					executionId: expect.stringMatching(/^execution_/),
					attempts: 0,
					settlement: {
						attemptOrdinal: 1,
						status: "completed",
						usageComplete: true,
					},
					outcome: "completed",
					dependsOn: [],
					inputs: {},
					// Derived from the key; this definition names its task its own
					// way, so the kind a host narrates it as is the honest `other`.
					// No `summary`, because `include` does not ask for `output`.
					narration: { stage: "answer", taskKind: "other" },
				},
			]);

			const full = await service.inspect(runId, {
				include: [
					"run",
					"budget",
					"tasks",
					"executions",
					"effects",
					"barriers",
					"artifacts",
				],
			});
			expect(Value.Check(WorkflowRunInspectionSchema, full)).toBe(true);
			expect(full.executions).toHaveLength(1);
			expect(full.executions?.[0]).toMatchObject({
				taskId,
				generation: 1,
				kind: "agent",
				phase: "terminal",
				current: true,
				subagent: {
					operationId: expect.stringMatching(/^workflow-op_/),
					runId: expect.stringMatching(/^run_/),
				},
				attempts: [],
				settlement: { attemptOrdinal: 1, status: "completed" },
				terminal: { outcome: "completed" },
			});
			expect(full.executions?.[0]?.artifactIds).toHaveLength(1);
			expect(full.effects).toEqual([]);
			expect(full.barriers?.length).toBeGreaterThan(0);
			expect(
				full.artifacts?.some(
					(ref) => ref.isRunOutput && ref.id === full.run.outputArtifactId,
				),
			).toBe(true);
			const serialized = JSON.stringify(full);
			expect(serialized).not.toContain("from child");
			expect(serialized).not.toContain("Return structured output.");
			expect(serialized).not.toContain('"goal"');
			expect(serialized).not.toContain(fixture.cwd);

			const logs = await service.logs(runId);
			expect(Value.Check(WorkflowLogPageSchema, logs)).toBe(true);
			expect(logs.runId).toBe(runId);
			const events = await journalEvents(fixture.storeRoot, runId);
			expect(logs.lastSequence).toBe(events.at(-1)?.sequence);
			expect(logs.nextAfterSequence).toBeUndefined();
			const sequences = logs.entries.map((entry) => entry.sequence);
			expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
			for (const entry of logs.entries) {
				expect(LOG_KINDS.has(entry.kind)).toBe(true);
			}
			expect(logs.entries[0]).toMatchObject({
				kind: "run",
				status: "running",
				message: "Run status changed from created to running.",
			});
			expect(logs.entries).toContainEqual(
				expect.objectContaining({
					kind: "terminal",
					taskId,
					taskKey: "/answer",
					status: "completed",
					message: "Execution generation 1 ended completed.",
				}),
			);
			expect(
				logs.entries
					.filter((entry) => entry.kind === "task")
					.every(
						(entry) => entry.taskId === taskId && entry.taskKey === "/answer",
					),
			).toBe(true);
			expect(logs.entries.at(-1)).toMatchObject({
				kind: "run",
				status: "completed",
			});
			expect(JSON.stringify(logs)).not.toContain("from child");

			// Pagination reassembles the full listing.
			const collected: (typeof logs.entries)[number][] = [];
			let afterSequence: number | undefined = 0;
			while (afterSequence !== undefined) {
				const page: Awaited<ReturnType<ReadService["logs"]>> =
					await service.logs(runId, { afterSequence, limit: 3 });
				expect(page.entries.length).toBeLessThanOrEqual(3);
				expect(page.lastSequence).toBe(logs.lastSequence);
				if (page.nextAfterSequence !== undefined) {
					expect(page.nextAfterSequence).toBe(page.entries.at(-1)?.sequence);
				}
				collected.push(...page.entries);
				afterSequence = page.nextAfterSequence;
			}
			expect(collected).toEqual(logs.entries);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("carries a terminal run's output only when include asks for it", async () => {
		const fixture = await projectFixture("output");
		const seed = await serviceFor(fixture);
		const runId = await completedRun(seed, "example", { value: "receipt" });
		const owned = asRead(seed);
		try {
			// The default selection is unchanged: no output, no artifact read.
			const lean = await owned.inspect(runId);
			expect(lean.run).not.toHaveProperty("output");

			const withOutput = await owned.inspect(runId, {
				include: ["run", "output"],
			});
			expect(Value.Check(WorkflowRunInspectionSchema, withOutput)).toBe(true);
			expect(Object.keys(withOutput).sort()).toEqual(["run", "truncated"]);
			expect(withOutput.run.output).toEqual({ answer: "receipt" });
			// The output the inspection carries is the one the artifact-backed
			// wait view carries, read through the same bound.
			const waited = await bounded(owned.wait(runId), "wait");
			expect(withOutput.run.output).toEqual(
				(waited as { output?: unknown }).output,
			);
			expect(withOutput.run.outputArtifactId).toEqual(expect.any(String));
		} finally {
			await shutdownQuietly(owned);
		}

		// The same run, read lease-free by a service that does not own it.
		const reader = asRead(await serviceFor(fixture));
		try {
			const inspection = await reader.inspect(runId, {
				include: ["run", "output"],
			});
			expect(inspection.run.ownership).toBe("inactive");
			expect(inspection.run.output).toEqual({ answer: "receipt" });
		} finally {
			await shutdownQuietly(reader);
		}
	});

	it("omits the output of a run that has not committed one", async () => {
		const fixture = await projectFixture("output-running");
		const delegated = attemptProvider([{ status: "completed" }]);
		const gate = deferred<Awaited<ReturnType<SubagentClient["wait"]>>>();
		vi.mocked(delegated.ownerClient.wait).mockImplementation(
			async () => gate.promise,
		);
		const raw = await serviceFor(fixture, delegated.provider);
		const service = asRead(raw);
		try {
			const receipt = await raw.run("attempts", { value: "x" });
			await until(
				() => vi.mocked(delegated.ownerClient.wait).mock.calls.length > 0,
			);
			const running = await service.inspect(receipt.runId, {
				include: ["run", "output"],
			});
			expect(Value.Check(WorkflowRunInspectionSchema, running)).toBe(true);
			expect(["running", "waiting"]).toContain(running.run.status);
			expect(running.run).not.toHaveProperty("output");
			expect(running.run).not.toHaveProperty("outputArtifactId");

			gate.resolve(childResult({ status: "completed" }, delegated.child.runId));
			await bounded(service.wait(receipt.runId), "wait");
			const completed = await service.inspect(receipt.runId, {
				include: ["run", "output"],
			});
			expect(completed.run.status).toBe("completed");
			expect(completed.run.output).toEqual({ answer: "from child" });
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("validates run ids, selectors, task ids, and log queries", async () => {
		const fixture = await projectFixture("validation");
		const raw = await serviceFor(fixture);
		const service = asRead(raw);
		try {
			const runId = await completedRun(raw, "example");
			await expectServiceError(
				service.inspect("bad"),
				"validation",
				"Invalid workflow run ID.",
			);
			await expectServiceError(
				service.logs("bad"),
				"validation",
				"Invalid workflow run ID.",
			);
			await expectServiceError(
				service.inspect("workflow_doesnotexist"),
				"not-found",
				"Workflow run not found: workflow_doesnotexist",
			);
			await expectServiceError(
				service.logs("workflow_doesnotexist"),
				"not-found",
				"Workflow run not found: workflow_doesnotexist",
			);
			for (const include of [[], ["bogus"], ["run", "run"]]) {
				await expectServiceError(
					service.inspect(runId, { include }),
					"validation",
					"Invalid workflow inspection selector.",
				);
			}
			await expectServiceError(
				service.inspect(runId, { taskId: "bad" }),
				"validation",
				"Invalid workflow task ID.",
			);
			for (const options of [
				{ afterSequence: -1 },
				{ afterSequence: 1.5 },
				{ limit: 0 },
				{ limit: 501 },
			]) {
				await expectServiceError(
					service.logs(runId, options),
					"validation",
					"Invalid workflow log query.",
				);
			}
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("inspects and logs a failed run with codes but no child prose", async () => {
		const fixture = await projectFixture("failed");
		const {
			service: raw,
			runId,
			taskId,
			first,
		} = await settledAttemptRun(fixture, [
			{ status: "failed", failure: childFailure("manual") },
		]);
		const service = asRead(raw);
		try {
			expect(first.status).toBe("failed");
			const inspection = await service.inspect(runId, {
				include: ["run", "tasks", "executions"],
			});
			expect(Value.Check(WorkflowRunInspectionSchema, inspection)).toBe(true);
			expect(inspection.run).toMatchObject({
				status: "failed",
				availableActions: ["invalidate", "retry"],
				requiresAttention: true,
			});
			expect(inspection.tasks?.[0]).toMatchObject({
				id: taskId,
				status: "failed",
				generation: 1,
				attempts: 0,
				settlement: {
					attemptOrdinal: 1,
					status: "failed",
					failureCode: "provider-transient",
					failureRetry: "manual",
					usageComplete: true,
				},
				outcome: "failed",
			});
			expect(inspection.executions?.[0]).toMatchObject({
				current: true,
				terminal: {
					outcome: "failed",
					failure: { code: "provider-transient", retry: "manual" },
				},
			});
			const serialized = JSON.stringify(inspection);
			expect(serialized).not.toContain("provider hiccup");
			expect(serialized).not.toContain("Try again later.");

			const logs = await service.logs(runId);
			expect(logs.entries).toContainEqual(
				expect.objectContaining({
					kind: "terminal",
					taskId,
					status: "failed",
					failureCode: "provider-transient",
					message: "Execution generation 1 ended failed.",
				}),
			);
			const final = logs.entries.at(-1);
			expect(final).toMatchObject({ kind: "run", status: "failed" });
			expect(typeof final?.reason).toBe("string");
			expect(JSON.stringify(logs)).not.toContain("provider hiccup");
			expect(JSON.stringify(logs)).not.toContain("Try again later.");

			// The advertised action is the one the service accepts.
			const listed = await service.listRuns();
			expect(listed.runs[0]).toMatchObject({
				runId,
				availableActions: ["invalidate", "retry"],
				requiresAttention: true,
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("inspects and logs an invalidated-then-recovered run across generations", async () => {
		const fixture = await projectFixture("recovered");
		const {
			service: raw,
			runId,
			taskId,
			first,
		} = await settledAttemptRun(fixture, [
			{ status: "failed", failure: childFailure("manual") },
			{ status: "completed" },
		]);
		const service = asRead(raw);
		try {
			expect(first.status).toBe("failed");
			await bounded(
				raw.invalidate(runId, taskId, "operator re-run"),
				"invalidate",
			);
			await expect(bounded(raw.wait(runId), "wait")).resolves.toMatchObject({
				status: "completed",
			});
			const inspection = await service.inspect(runId, {
				include: ["run", "tasks", "executions", "artifacts"],
			});
			expect(Value.Check(WorkflowRunInspectionSchema, inspection)).toBe(true);
			expect(inspection.run).toMatchObject({
				status: "completed",
				availableActions: [],
				taskCounts: expect.objectContaining({
					completed: 1,
					invalidated: 0,
					abandoned: 0,
					total: 1,
				}),
			});
			expect(inspection.tasks?.[0]).toMatchObject({
				id: taskId,
				status: "completed",
				generation: 2,
				outcome: "completed",
			});
			expect(
				inspection.executions?.map((execution) => execution.generation),
			).toEqual([2, 1]);
			expect(inspection.executions?.[0]).toMatchObject({
				current: true,
				terminal: { outcome: "completed" },
			});
			expect(inspection.executions?.[1]).toMatchObject({
				current: false,
				terminal: {
					outcome: "failed",
					failure: { code: "provider-transient", retry: "manual" },
				},
			});
			expect(inspection.executions?.[0]?.artifactIds).toHaveLength(1);
			expect(inspection.executions?.[1]?.artifactIds).toEqual([]);

			const filtered = await service.inspect(runId, {
				include: ["executions"],
				taskId,
			});
			expect(filtered.executions).toHaveLength(2);
			expect(filtered.tasks).toBeUndefined();

			const logs = await service.logs(runId, { limit: 500 });
			expect(logs.entries).toContainEqual(
				expect.objectContaining({
					kind: "invalidation",
					taskId,
					taskKey: "/answer",
					reason: "operator re-run",
					message: "Invalidated 1 task(s) and abandoned 0 epoch(s).",
				}),
			);
			expect(logs.entries).toContainEqual(
				expect.objectContaining({
					kind: "run",
					status: "running",
					reason: "Explicit invalidation re-executes invalidated tasks.",
					message: "Run status changed from failed to running.",
				}),
			);
			expect(logs.entries).toContainEqual(
				expect.objectContaining({
					kind: "terminal",
					message: "Execution generation 2 ended completed.",
				}),
			);
			expect(logs.entries.some((entry) => entry.kind === "attempt")).toBe(
				false,
			);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("refuses invalidation of a completed run that advertises no actions", async () => {
		const fixture = await projectFixture("consistency");
		const raw = await serviceFor(fixture);
		const service = asRead(raw);
		try {
			const runId = await completedRun(raw, "example");
			const page = await service.listRuns();
			expect(page.runs[0]?.availableActions).toEqual([]);
			await expectServiceError(
				raw.invalidate(runId, "task_abcdef", "retry"),
				"validation",
				"Workflow run status does not admit invalidation.",
			);
		} finally {
			await shutdownQuietly(service);
		}
	});
});

// ---------------------------------------------------------------------------
// subscribe
// ---------------------------------------------------------------------------

describe("subscribe", () => {
	it("delivers one observation per durable append in sequence order until unsubscribed", async () => {
		const fixture = await projectFixture("subscribe");
		const raw = await serviceFor(fixture);
		const service = asRead(raw);
		try {
			const observed: { runId: string; status: string; sequence: number }[] =
				[];
			const unsubscribe = service.subscribe((observation) => {
				observed.push(observation);
			});
			const throwing = vi.fn(() => {
				throw new Error("listener failure");
			});
			const unsubscribeThrowing = service.subscribe(throwing);
			const runId = await completedRun(raw, "example");
			const events = await journalEvents(fixture.storeRoot, runId);
			await bounded(
				until(
					() =>
						observed.filter((entry) => entry.runId === runId).length >=
						events.length,
				),
				"observations",
				5_000,
			);
			const forRun = observed.filter((entry) => entry.runId === runId);
			expect(forRun.map((entry) => entry.sequence)).toEqual(
				events.map((event) => event.sequence),
			);
			expect(forRun.at(-1)?.status).toBe("completed");
			expect(forRun[0]?.status).toBe("created");
			expect(forRun.every((entry) => typeof entry.status === "string")).toBe(
				true,
			);
			expect(throwing).toHaveBeenCalledTimes(events.length);

			unsubscribe();
			unsubscribe();
			unsubscribeThrowing();
			const before = observed.length;
			const second = await completedRun(raw, "example", { value: "again" });
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(observed.length).toBe(before);
			expect(observed.some((entry) => entry.runId === second)).toBe(false);
		} finally {
			await shutdownQuietly(service);
		}
		await expectServiceError(
			Promise.resolve().then(() => service.subscribe(() => undefined)),
			"conflict",
			"Workflow service is closed.",
		);
	});
});

// ---------------------------------------------------------------------------
// wait(timeoutMs)
// ---------------------------------------------------------------------------

describe("wait with a timeout", () => {
	it("returns timedOut on a gated child and the terminal view after release", async () => {
		const fixture = await projectFixture("wait");
		const delegated = attemptProvider([{ status: "completed" }]);
		const gate = deferred<Awaited<ReturnType<SubagentClient["wait"]>>>();
		vi.mocked(delegated.ownerClient.wait).mockImplementation(
			async () => gate.promise,
		);
		const raw = await serviceFor(fixture, delegated.provider);
		const service = asRead(raw);
		try {
			const receipt = await raw.run("attempts", { value: "x" });
			await until(
				() => vi.mocked(delegated.ownerClient.wait).mock.calls.length > 0,
			);
			const timed = await bounded(
				service.wait(receipt.runId, { timeoutMs: 100 }),
				"timed wait",
			);
			expect(timed.timedOut).toBe(true);
			expect(["running", "waiting"]).toContain(timed.status);
			expect(Value.Check(WorkflowServiceWaitViewSchema, timed)).toBe(true);
			gate.resolve(childResult({ status: "completed" }, delegated.child.runId));
			const finished = await bounded(service.wait(receipt.runId), "wait");
			expect(finished.status).toBe("completed");
			expect(finished).not.toHaveProperty("timedOut");
			expect(Value.Check(WorkflowServiceWaitViewSchema, finished)).toBe(true);
			const again = await service.wait(receipt.runId, { timeoutMs: 1_000 });
			expect(again.status).toBe("completed");
			expect(again).not.toHaveProperty("timedOut");
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("rejects an invalid timeout before touching the run", async () => {
		const fixture = await projectFixture("wait-validation");
		const service = asRead(await serviceFor(fixture));
		try {
			for (const timeoutMs of [0, -1, 1.5, "1000", 2_147_483_648]) {
				await expectServiceError(
					service.wait("workflow_doesnotexist", { timeoutMs }),
					"validation",
					"Invalid workflow wait timeout.",
				);
			}
		} finally {
			await shutdownQuietly(service);
		}
	});
});

// ---------------------------------------------------------------------------
// reconcile(taskId)
// ---------------------------------------------------------------------------

describe("reconcile with a task id", () => {
	it("refuses unknown and non-cleanup-blocked tasks", async () => {
		const fixture = await projectFixture("reconcile");
		const settled = await settledAttemptRun(fixture, [
			{ status: "failed", failure: childFailure("manual") },
		]);
		expect(settled.first.status).toBe("failed");
		await bounded(settled.service.shutdown(), "first shutdown");
		const { runId, taskId } = settled;
		const raw = await serviceFor(
			fixture,
			attemptProvider([{ status: "completed" }]).provider,
		);
		const service = asRead(raw);
		try {
			await expectServiceError(
				service.reconcile(runId, { taskId: "bad" }),
				"validation",
				"Invalid workflow task ID.",
			);
			await expectServiceError(
				service.reconcile(runId, { taskId: "task_unknownzz" }),
				"validation",
				"Unknown workflow task.",
			);
			await expectServiceError(
				service.reconcile(runId, { taskId }),
				"validation",
				"Workflow task is not cleanup-blocked.",
			);
			await expect(raw.status(runId)).resolves.toMatchObject({
				status: "failed",
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("returns an empty reconciled list for a completed run", async () => {
		const fixture = await projectFixture("reconcile-completed");
		const raw = await serviceFor(fixture);
		const service = asRead(raw);
		try {
			const runId = await completedRun(raw, "example");
			const view = await service.reconcile(runId);
			expect(view.status).toBe("completed");
			expect(view.reconciled).toEqual([]);
			expect(Value.Check(WorkflowServiceReconcileViewSchema, view)).toBe(true);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("returns an empty reconciled list for a known task on a completed run and refuses an unknown one", async () => {
		const fixture = await projectFixture("reconcile-completed-task");
		const settled = await settledAttemptRun(fixture, [{ status: "completed" }]);
		const service = asRead(settled.service);
		try {
			expect(settled.first.status).toBe("completed");
			const view = await service.reconcile(settled.runId, {
				taskId: settled.taskId,
			});
			expect(view).toMatchObject({ status: "completed", reconciled: [] });
			expect(Value.Check(WorkflowServiceReconcileViewSchema, view)).toBe(true);
			await expectServiceError(
				service.reconcile(settled.runId, { taskId: "task_unknownzz" }),
				"validation",
				"Unknown workflow task.",
			);
		} finally {
			await shutdownQuietly(service);
		}
	});
});

// ---------------------------------------------------------------------------
// Tools through the extension
// ---------------------------------------------------------------------------

function captureExtension() {
	const tools: ToolDefinition[] = [];
	const commands: string[] = [];
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const api = {
		events: { on: vi.fn(), emit: vi.fn() },
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		registerShortcut() {},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	workflowExtension(api);
	const tool = (name: string): ToolDefinition => {
		const found = tools.find((candidate) => candidate.name === name);
		if (!found) throw new Error(`${name} missing`);
		return found;
	};
	return { tools, commands, handlers, tool };
}

async function runTool(
	tool: ToolDefinition,
	params: Record<string, unknown>,
	context: unknown,
): Promise<string> {
	const result = (await tool.execute(
		`call-${randomUUID()}`,
		params as never,
		new AbortController().signal,
		undefined,
		context as never,
	)) as { content: { type: string; text?: string }[] };
	const text = result.content[0]?.text;
	if (typeof text !== "string") throw new Error("tool returned no text");
	return text;
}

const MAX_TOOL_OUTPUT_BYTES = 48 * 1024;

describe("read tools", () => {
	it("registers the read surface tools with their exact descriptions and parameter bounds", () => {
		const { tools, commands, tool } = captureExtension();
		const names = tools.map((candidate) => candidate.name);
		for (const name of [
			"workflow_runs",
			"workflow_inspect",
			"workflow_logs",
			"workflow_wait",
			"workflow_invalidate",
		]) {
			expect(names).toContain(name);
		}
		expect(commands).toEqual(["workflow"]);
		expect(tool("workflow_runs").description).toBe(
			"List durable workflow runs in this project with status, ownership, and the operator actions the service currently permits.",
		);
		expect(tool("workflow_inspect").description).toBe(
			"Inspect a workflow run's durable projection: budget, tasks, executions, effects, barriers, artifacts. Use include and taskId to bound the output.",
		);
		expect(tool("workflow_logs").description).toBe(
			"Read redacted, paginated lifecycle log entries derived from a workflow run's journal.",
		);
		expect(tool("workflow_invalidate").description).toBe(
			"Invalidate a settled task and its dependents on a failed or interrupted run so they re-execute; returns the run view.",
		);

		const runs = tool("workflow_runs").parameters;
		expect(Value.Check(runs, {})).toBe(true);
		expect(
			Value.Check(runs, {
				statuses: ["completed"],
				includeChildren: true,
				limit: 100,
				cursor: "c",
			}),
		).toBe(true);
		expect(Value.Check(runs, { limit: 0 })).toBe(false);
		expect(Value.Check(runs, { limit: 101 })).toBe(false);
		expect(Value.Check(runs, { statuses: [] })).toBe(false);
		expect(Value.Check(runs, { statuses: ["completed", "completed"] })).toBe(
			false,
		);
		expect(Value.Check(runs, { cursor: "" })).toBe(false);
		expect(Value.Check(runs, { extra: true })).toBe(false);

		const inspect = tool("workflow_inspect").parameters;
		expect(Value.Check(inspect, { runId: "workflow_abcdef" })).toBe(true);
		expect(
			Value.Check(inspect, {
				runId: "workflow_abcdef",
				include: ["run", "tasks"],
				taskId: "task_abcdef",
			}),
		).toBe(true);
		expect(Value.Check(inspect, { runId: "bad" })).toBe(false);
		expect(
			Value.Check(inspect, { runId: "workflow_abcdef", include: [] }),
		).toBe(false);
		expect(
			Value.Check(inspect, { runId: "workflow_abcdef", include: ["bogus"] }),
		).toBe(false);
		expect(
			Value.Check(inspect, { runId: "workflow_abcdef", taskId: "x" }),
		).toBe(false);

		const logs = tool("workflow_logs").parameters;
		expect(
			Value.Check(logs, {
				runId: "workflow_abcdef",
				afterSequence: 0,
				limit: 500,
			}),
		).toBe(true);
		expect(
			Value.Check(logs, { runId: "workflow_abcdef", afterSequence: -1 }),
		).toBe(false);
		expect(Value.Check(logs, { runId: "workflow_abcdef", limit: 501 })).toBe(
			false,
		);
		expect(Value.Check(logs, { runId: "workflow_abcdef", limit: 0 })).toBe(
			false,
		);

		const wait = tool("workflow_wait").parameters;
		expect(Value.Check(wait, { runId: "workflow_abcdef" })).toBe(true);
		expect(
			Value.Check(wait, { runId: "workflow_abcdef", timeoutMs: 1_000 }),
		).toBe(true);
		expect(
			Value.Check(wait, { runId: "workflow_abcdef", timeoutMs: 3_600_000 }),
		).toBe(true);
		expect(
			Value.Check(wait, { runId: "workflow_abcdef", timeoutMs: 999 }),
		).toBe(false);
		expect(
			Value.Check(wait, { runId: "workflow_abcdef", timeoutMs: 3_600_001 }),
		).toBe(false);

		const invalidate = tool("workflow_invalidate").parameters;
		expect(
			Value.Check(invalidate, {
				runId: "workflow_abcdef",
				taskId: "task_abcdef",
				reason: "r",
			}),
		).toBe(true);
		expect(
			Value.Check(invalidate, {
				runId: "workflow_abcdef",
				taskId: "task_abcdef",
			}),
		).toBe(false);
		expect(
			Value.Check(invalidate, {
				runId: "workflow_abcdef",
				taskId: "task_abcdef",
				reason: "",
			}),
		).toBe(false);
	});

	it("serves validated read output and bounds it to 48 KiB", async () => {
		const fixture = await projectFixture("tools");
		const seed = await serviceFor(fixture);
		const exampleId = await completedRun(seed, "example");
		const loggerId = await completedRun(seed, "logger");
		await bounded(seed.shutdown(), "seed shutdown");
		const oracle = asRead(await serviceFor(fixture));
		const { tool, handlers } = captureExtension();
		const context = {
			cwd: fixture.cwd,
			isProjectTrusted: () => true,
			ui: { notify: vi.fn() },
		};
		try {
			const runsText = await runTool(tool("workflow_runs"), {}, context);
			const runsPage = JSON.parse(runsText) as { runs: { runId: string }[] };
			expect(Value.Check(WorkflowRunPageSchema, runsPage)).toBe(true);
			expect(runsPage.runs.map((run) => run.runId).sort()).toEqual(
				[exampleId, loggerId].sort(),
			);
			expect(runsText).toBe(JSON.stringify(runsPage, null, 2));

			const inspectText = await runTool(
				tool("workflow_inspect"),
				{ runId: exampleId },
				context,
			);
			const inspection = JSON.parse(inspectText) as { run: { status: string } };
			expect(Value.Check(WorkflowRunInspectionSchema, inspection)).toBe(true);
			expect(inspection.run.status).toBe("completed");

			// The logger run's effects alone exceed the bound.
			const direct = await oracle.inspect(loggerId, { include: ["effects"] });
			expect(
				Buffer.byteLength(JSON.stringify(direct, null, 2)),
			).toBeGreaterThan(MAX_TOOL_OUTPUT_BYTES);
			await expect(
				runTool(
					tool("workflow_inspect"),
					{ runId: loggerId, include: ["effects"] },
					context,
				),
			).rejects.toThrow(
				"Workflow inspection exceeds the tool output bound; narrow include or pass taskId.",
			);
			const runOnly = JSON.parse(
				await runTool(
					tool("workflow_inspect"),
					{ runId: loggerId, include: ["run"] },
					context,
				),
			) as { run: { status: string }; effects?: unknown };
			expect(runOnly.run.status).toBe("completed");
			expect(runOnly.effects).toBeUndefined();
			expect(Value.Check(WorkflowRunInspectionSchema, runOnly)).toBe(true);

			// Log pages shrink and re-cursor instead of cutting entries.
			const full = await oracle.logs(loggerId, { limit: 500 });
			expect(full.entries.length).toBeGreaterThanOrEqual(LOG_LINES);
			expect(full.nextAfterSequence).toBeUndefined();
			expect(Buffer.byteLength(JSON.stringify(full, null, 2))).toBeGreaterThan(
				MAX_TOOL_OUTPUT_BYTES,
			);
			const collected: unknown[] = [];
			let afterSequence: number | undefined = 0;
			let pages = 0;
			while (afterSequence !== undefined) {
				const text: string = await runTool(
					tool("workflow_logs"),
					{ runId: loggerId, afterSequence },
					context,
				);
				expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
					MAX_TOOL_OUTPUT_BYTES,
				);
				const page = JSON.parse(text) as {
					entries: { sequence: number; message: string }[];
					nextAfterSequence?: number;
					lastSequence: number;
				};
				expect(Value.Check(WorkflowLogPageSchema, page)).toBe(true);
				expect(page.lastSequence).toBe(full.lastSequence);
				expect(page.entries.length).toBeGreaterThan(0);
				for (const entry of page.entries) {
					const original = full.entries.find(
						(candidate) => candidate.sequence === entry.sequence,
					);
					expect(entry.message).toBe(original?.message);
				}
				if (page.nextAfterSequence !== undefined) {
					expect(page.nextAfterSequence).toBe(page.entries.at(-1)?.sequence);
				}
				collected.push(...page.entries);
				afterSequence = page.nextAfterSequence;
				pages += 1;
			}
			expect(pages).toBeGreaterThan(1);
			expect(collected).toEqual(full.entries);

			// Pass-through tools forward to the service and propagate refusals.
			await expect(
				runTool(
					tool("workflow_invalidate"),
					{ runId: exampleId, taskId: "task_abcdef", reason: "again" },
					context,
				),
			).rejects.toMatchObject({
				code: "validation",
				message: "Workflow run status does not admit invalidation.",
			});
			const waited = JSON.parse(
				await runTool(
					tool("workflow_wait"),
					{ runId: exampleId, timeoutMs: 1_000 },
					context,
				),
			) as { status: string; timedOut?: true };
			expect(waited.status).toBe("completed");
			expect(waited).not.toHaveProperty("timedOut");
			// workflow_reconcile forwards the optional task id unchanged.
			await expect(
				runTool(
					tool("workflow_reconcile"),
					{ runId: exampleId, taskId: "task_unknownzz" },
					context,
				),
			).rejects.toMatchObject({
				code: "validation",
				message: "Unknown workflow task.",
			});
			const reconciled = JSON.parse(
				await runTool(
					tool("workflow_reconcile"),
					{ runId: exampleId },
					context,
				),
			) as { status: string; reconciled: unknown[] };
			expect(reconciled).toMatchObject({ status: "completed", reconciled: [] });
		} finally {
			await handlers.get("session_shutdown")?.({}, context);
			await shutdownQuietly(oracle);
		}
	});
});
