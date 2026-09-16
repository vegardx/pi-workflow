import { createHash, randomUUID } from "node:crypto";
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	type AgentLaunchPlan,
	canonicalSha256,
	HANDOFF_EXPORT_MEDIA_TYPE,
	type HandoffRef,
	RetryBackoffError,
	type RunReceipt,
	type RunResult,
	SUBAGENT_RUNTIME_CONTRACT,
	type SubagentClient,
	type SubagentRequest,
	type WorktreeRecord,
} from "@vegardx/pi-subagent";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { WorkflowHandoffDescriptorSchema } from "../src/contracts.js";
import type { WorkflowStateProjection } from "../src/events.js";
import { deriveJsonValueSha256 } from "../src/execution.js";
import {
	type WorkflowJournalEvent,
	WorkflowRunJournal,
} from "../src/persistence/journal.js";
import { acquireWorkflowRunLease } from "../src/persistence/run-lease.js";
import { reduceWorkflowEvents } from "../src/reducer.js";
import { discoverWorkflows } from "../src/registry.js";
import { WorkflowRunRecordStore } from "../src/run-record.js";
import {
	createWorkflowService,
	type WorkflowService,
	WorkflowServiceError,
} from "../src/service.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function root(name: string): string {
	return path.resolve(".pi", "test-service", `${name}-${randomUUID()}`);
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

function provider(
	bind = vi.fn(),
): WorkflowSubagentProvider & { bind: typeof bind } {
	bind.mockImplementation(
		async (runId: string) =>
			({
				workflowRunId: runId,
				ownerId: `pi-workflow:${runId}`,
				client: client(),
			}) satisfies WorkflowSubagentBinding,
	);
	return { bind };
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

async function taskWorkflowFixture() {
	const fixture = await workflowFixture("agent-task");
	await writeFile(
		fixture.definitionPath,
		`export default {
  schema: "pi-workflow-definition",
  meta: { name: "agent-task", description: "Agent task workflow", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 3600000, concurrency: 4 },
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
      limits: { cumulativeRuntimeMs: 300000, attemptTimeoutMs: 300000, totalTokens: 1000000, cost: 10, outputBytes: 1024, workspaceWriteBytes: 0, retries: 0, resumes: 0 }
    });
  }
};\n`,
	);
	return fixture;
}

function taskProvider() {
	const preflight = vi.fn(async (request: SubagentRequest) => {
		const draft = {
			schema: "pi-subagent-launch" as const,
			contractRevision: SUBAGENT_RUNTIME_CONTRACT.contractRevision,
			operationId: request.operationId,
			ownerId: "",
			runId: "run_servicechild",
			attemptId: "attempt_servicechild",
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
		launch: vi.fn(async () => ({
			runId: "run_servicechild",
			attemptId: "attempt_servicechild",
			status: "active" as const,
		})),
		wait: vi.fn(async () => ({
			result: {
				runId: "run_servicechild",
				status: "completed" as const,
				structuredOutput: { answer: "from child" },
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
			runId: "run_servicechild",
			attemptId: "attempt_servicechild",
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
	return { provider: { bind } as WorkflowSubagentProvider, ownerClient };
}

describe("workflow service", () => {
	it("lists, validates, runs, waits, and reads durable output", async () => {
		const fixture = await workflowFixture();
		const subagents = provider();
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents,
			maxConcurrency: 2,
			maxWorkflowCost: 750,
			maxWorkflowTotalTokens: 2_000_000,
			maxWorkflowChildRuntimeMs: 1_800_000,
			maxWorkflowTimeoutMs: 900_000,
		});
		expect(await service.list()).toMatchObject([
			{ name: "example", concurrency: 4, scope: "project" },
		]);
		await expect(
			service.validate("example", { value: "yes" }),
		).resolves.toMatchObject({
			valid: true,
		});
		await expect(
			service.validate("example", { value: 42 }),
		).rejects.toBeInstanceOf(WorkflowServiceError);
		await expect(service.run("example", { value: 42 })).rejects.toMatchObject({
			code: "validation",
		});
		expect(subagents.bind).not.toHaveBeenCalled();
		const receipt = await service.run("example", { value: "yes" });
		expect(receipt.status).toBe("created");
		const record = JSON.parse(
			await readFile(
				path.join(fixture.storeRoot, "runs", receipt.runId, "service.json"),
				"utf8",
			),
		) as {
			concurrency: number;
			declaredBudget: unknown;
			effectiveBudget: unknown;
			declaredTimeoutMs: number;
			effectiveTimeoutMs: number;
			createdAt: string;
			deadlineAt: string;
		};
		expect(record).toMatchObject({
			concurrency: 2,
			declaredBudget: { cost: 1_000, childRuntimeMs: 3_600_000 },
			effectiveBudget: {
				cost: 750,
				totalTokens: 2_000_000,
				childRuntimeMs: 1_800_000,
			},
			declaredTimeoutMs: 3_600_000,
			effectiveTimeoutMs: 900_000,
		});
		expect(Date.parse(record.deadlineAt) - Date.parse(record.createdAt)).toBe(
			900_000,
		);
		const immediate = await service.status(receipt.runId);
		expect(["created", "running", "finalizing", "completed"]).toContain(
			immediate.status,
		);
		await expect(service.wait(receipt.runId)).resolves.toMatchObject({
			status: "completed",
			definitionName: "example",
			output: { answer: "yes" },
			outputArtifactId: expect.stringMatching(/^artifact_/),
		});
		expect(subagents.bind).toHaveBeenCalledWith(receipt.runId);
		await service.shutdown();
	});

	it("terminalizes an expired workflow deadline", async () => {
		const fixture = await workflowFixture("deadline");
		await writeFile(
			fixture.definitionPath,
			`export default {
  schema: "pi-workflow-definition",
  meta: { name: "deadline", description: "Deadline workflow", version: 1, budget: { cost: 10, childRuntimeMs: 10000 }, timeoutMs: 1000, concurrency: 1 },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  run(ctx) { return new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve({ answer: "late" }), { once: true })); }
};\n`,
		);
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: provider(),
		});
		const receipt = await service.run("deadline", {});
		await expect(service.wait(receipt.runId)).resolves.toMatchObject({
			status: "cancelled",
		});
		await service.shutdown();
	}, 5_000);

	it("composes the full delegated task runtime through the owner client", async () => {
		const fixture = await taskWorkflowFixture();
		const delegated = taskProvider();
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		const receipt = await service.run("agent-task", {});
		await expect(service.wait(receipt.runId)).resolves.toMatchObject({
			status: "completed",
			output: { answer: "from child" },
		});
		expect(delegated.ownerClient.preflight).toHaveBeenCalledOnce();
		expect(delegated.ownerClient.launch).toHaveBeenCalledOnce();
		expect(delegated.ownerClient.release).toHaveBeenCalledOnce();
		await service.shutdown();
	});

	it("persists stop intent and drains an active delegated task", async () => {
		const fixture = await taskWorkflowFixture();
		const delegated = taskProvider();
		const terminal = deferred<Awaited<ReturnType<SubagentClient["wait"]>>>();
		vi.mocked(delegated.ownerClient.wait).mockImplementation(
			async () => terminal.promise,
		);
		vi.mocked(delegated.ownerClient.interrupt).mockResolvedValue({
			runId: "run_servicechild",
			attemptId: "attempt_servicechild",
			status: "stopping",
		});
		vi.mocked(delegated.ownerClient.release).mockResolvedValue({
			runId: "run_servicechild",
			attemptId: "attempt_servicechild",
			status: "cancelled",
		});
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		const receipt = await service.run("agent-task", {});
		while (vi.mocked(delegated.ownerClient.wait).mock.calls.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		const stopping = service.stop(receipt.runId, "operator stop");
		while (vi.mocked(delegated.ownerClient.interrupt).mock.calls.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		terminal.resolve({
			result: {
				runId: "run_servicechild",
				status: "cancelled",
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
				failure: {
					code: "cancellation",
					origin: "operator",
					retry: "never",
					message: "cancelled",
					guidance: "Start another run if needed.",
				},
				sandboxCleanup: "proved",
				workspaceCleanup: "not-needed",
				truncated: false,
			},
			output: "",
			sessionFile: undefined,
			handoff: undefined,
			structuredOutput: undefined,
			error: "cancelled",
		});
		await expect(stopping).resolves.toMatchObject({ status: "cancelled" });
		expect(delegated.ownerClient.interrupt).toHaveBeenCalledOnce();
		await service.shutdown();
	});

	it("restarts the drive when a stop on a settled run leaves it non-terminal", async () => {
		// A settled owned run that is durably `stopping`: the drive's child
		// observation fails after an operator stop persisted stop intent and is
		// still draining the child, so the runtime settles without terminal
		// state. A second stop then finds no drive to drain what the scheduler
		// left non-terminal and restarts one before returning the view.
		const fixture = await taskWorkflowFixture();
		const delegated = taskProvider();
		type ChildWait = Awaited<ReturnType<SubagentClient["wait"]>>;
		const observed = deferred<ChildWait>();
		const drained = deferred<ChildWait>();
		let waits = 0;
		vi.mocked(delegated.ownerClient.wait).mockImplementation(async () => {
			waits += 1;
			return waits === 1 ? observed.promise : drained.promise;
		});
		vi.mocked(delegated.ownerClient.interrupt).mockResolvedValue({
			runId: "run_servicechild",
			attemptId: "attempt_servicechild",
			status: "stopping",
		});
		vi.mocked(delegated.ownerClient.release).mockResolvedValue({
			runId: "run_servicechild",
			attemptId: "attempt_servicechild",
			status: "cancelled",
		});
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		try {
			const receipt = await service.run("agent-task", {});
			await until(() => waits === 1);
			const firstStop = service.stop(receipt.runId, "operator stop");
			// The stop interrupted the child and now awaits its terminal result.
			await until(() => waits === 2);
			observed.reject(new Error("child observation lost"));
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).rejects.toMatchObject({
				code: "execution",
				message: "Workflow drive ended without durable terminal state.",
			});
			await expect(service.status(receipt.runId)).resolves.toMatchObject({
				status: "stopping",
			});
			// The settled run's second stop reaches the scheduler, which reports
			// the still-draining task as non-terminal; the restarted drive settles
			// again and the view is returned instead of hanging or throwing.
			const secondStop = await bounded(
				service.stop(receipt.runId, "operator stop again"),
				"second stop",
			);
			expect(secondStop.status).toBe("stopping");
			expect(delegated.ownerClient.interrupt).toHaveBeenCalledOnce();
			drained.resolve({
				result: {
					runId: "run_servicechild",
					status: "cancelled",
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
					failure: {
						code: "cancellation",
						origin: "operator",
						retry: "never",
						message: "cancelled",
						guidance: "Start another run if needed.",
					},
					sandboxCleanup: "proved",
					workspaceCleanup: "not-needed",
					truncated: false,
				},
				output: "",
				sessionFile: undefined,
				handoff: undefined,
				structuredOutput: undefined,
				error: "cancelled",
			});
			await expect(bounded(firstStop, "first stop")).resolves.toMatchObject({
				status: "cancelled",
			});
			await expect(
				bounded(service.wait(receipt.runId), "final wait"),
			).resolves.toMatchObject({ status: "cancelled" });
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("reconstructs and reconciles a completed run after service restart", async () => {
		const fixture = await workflowFixture("restart");
		const first = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: provider(),
		});
		const receipt = await first.run("restart", { value: "durable" });
		await first.wait(receipt.runId);
		await first.shutdown();

		const secondProvider = provider();
		const second = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: secondProvider,
		});
		await expect(second.status(receipt.runId)).resolves.toMatchObject({
			status: "completed",
			output: { answer: "durable" },
		});
		await expect(second.reconcile(receipt.runId)).resolves.toMatchObject({
			status: "completed",
		});
		expect(secondProvider.bind).not.toHaveBeenCalled();
		await second.shutdown();
	});

	it("resumes a nonterminal durable run when wait is called after restart", async () => {
		const fixture = await workflowFixture("pending");
		const [workflow] = await discoverWorkflows({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			projectTrusted: true,
		});
		if (!workflow) throw new Error("missing workflow");
		const runId = "workflow_pendingresume";
		const lease = await acquireWorkflowRunLease({
			storeRoot: fixture.storeRoot,
			runId,
			ownerId: "setup",
		});
		const journal = await WorkflowRunJournal.open(
			fixture.storeRoot,
			runId,
			lease,
		);
		const input = { value: "resumed" };
		await WorkflowRunRecordStore.open(journal).create({
			schema: "pi-workflow-run",
			contractRevision: 18,
			runId,
			depth: 0,
			definitionName: "pending",
			definitionPath: workflow.path,
			definitionIdentitySha256: workflow.identity.identitySha256,
			definitionSourceSha256: workflow.identity.sourceSha256,
			definitionKind: "static",
			concurrency: 4,
			declaredBudget: { cost: 1_000, childRuntimeMs: 3_600_000 },
			effectiveBudget: { cost: 1_000, childRuntimeMs: 3_600_000 },
			declaredTimeoutMs: 3_600_000,
			effectiveTimeoutMs: 3_600_000,
			deadlineAt: "2099-09-01T01:00:00.000Z",
			cwd: fixture.cwd,
			input,
			createdAt: "2099-09-01T00:00:00.000Z",
		});
		await journal.append("run-created", {
			definitionIdentitySha256: workflow.identity.identitySha256,
			inputSha256: deriveJsonValueSha256(input),
		});
		await lease.release();

		const subagents = provider();
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents,
		});
		await expect(service.wait(runId)).resolves.toMatchObject({
			status: "completed",
			output: { answer: "resumed" },
		});
		expect(subagents.bind).toHaveBeenCalledWith(runId);
		await service.shutdown();
	});

	it("fails before run creation when provider binding fails", async () => {
		const fixture = await workflowFixture("provider-failure");
		const subagents: WorkflowSubagentProvider = {
			bind: vi.fn(async () => {
				throw new Error("provider missing");
			}),
		};
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents,
		});
		await expect(
			service.run("provider-failure", { value: "no" }),
		).rejects.toThrow("provider missing");
		await expect(access(fixture.storeRoot)).rejects.toMatchObject({
			code: "ENOENT",
		});
		await service.shutdown();
	});

	it("enforces project trust and rejects unknown run IDs without creating them", async () => {
		const fixture = await workflowFixture("trust");
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => false,
			subagents: provider(),
		});
		await expect(service.list()).rejects.toThrow("project trust");
		await expect(service.status("workflow_missing")).rejects.toMatchObject({
			code: "not-found",
		});
		await expect(
			access(path.join(fixture.storeRoot, "runs", "workflow_missing")),
		).rejects.toMatchObject({ code: "ENOENT" });
		await service.shutdown();
	});
});

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

function agentExecutionOf(state: WorkflowStateProjection) {
	const task = Object.values(state.tasks).find(
		(candidate) => candidate.task.spec.kind === "agent",
	);
	if (!task) throw new Error("missing agent task");
	const execution = task.currentExecutionId
		? state.executions[task.currentExecutionId]
		: undefined;
	if (!execution) throw new Error("missing agent execution");
	return { task, execution };
}

/**
 * Simulates a process crash: the run directory is copied into a fresh store
 * root while the first service is still blocked inside a child call.
 */
async function crashSnapshot(
	fx: { cwd: string; storeRoot: string },
	runId: string,
): Promise<string> {
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
	return storeRoot;
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

function childResult(outcome: ChildOutcome) {
	const completed = outcome.status === "completed";
	const result: RunResult = {
		runId: "run_servicechild",
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
	let attemptId = "attempt_servicechild";
	let attempts = 1;
	let waits = 0;
	let lastStatus: RunResult["status"] = "completed";
	const nextAttempt = async (): Promise<RunReceipt> => {
		attempts += 1;
		attemptId = `attempt_servicechild${attempts}`;
		return { runId: "run_servicechild", attemptId, status: "active" };
	};
	vi.mocked(delegated.ownerClient.wait).mockImplementation(async () => {
		const outcome = outcomes[Math.min(waits, outcomes.length - 1)];
		if (!outcome) throw new Error("no child outcome scripted");
		waits += 1;
		lastStatus = outcome.status;
		return childResult(outcome);
	});
	vi.mocked(delegated.ownerClient.release).mockImplementation(async () => ({
		runId: "run_servicechild",
		attemptId,
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

const ATTEMPT_ID = /^attempt_[a-z0-9]+$/;

function countOf(types: readonly string[], type: string): number {
	return types.filter((candidate) => candidate === type).length;
}

describe("retry and resume attempts", () => {
	it("retries a backoff failure under the same execution and completes", async () => {
		const fixture = await attemptWorkflowFixture({ retry: { attempts: 1 } });
		const delegated = attemptProvider([
			{ status: "failed", failure: childFailure("backoff") },
			{ status: "completed" },
		]);
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		try {
			const receipt = await service.run("attempts", {});
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({
				status: "completed",
				output: { answer: "from child" },
			});
			expect(delegated.ownerClient.launch).toHaveBeenCalledOnce();
			expect(delegated.ownerClient.retry).toHaveBeenCalledOnce();
			expect(delegated.ownerClient.retry).toHaveBeenCalledWith(
				"run_servicechild",
			);
			expect(delegated.ownerClient.resume).not.toHaveBeenCalled();
			const types = await eventTypes(fixture.storeRoot, receipt.runId);
			expect(countOf(types, "task-execution-child-settled")).toBe(2);
			expect(countOf(types, "task-execution-attempt-intended")).toBe(1);
			expect(countOf(types, "task-execution-attempt-receipted")).toBe(1);
			expect(countOf(types, "task-execution-attempt-declined")).toBe(0);
			const { task, execution } = agentExecutionOf(
				await stateOf(fixture.storeRoot, receipt.runId),
			);
			expect(task.status).toBe("completed");
			expect(execution.attempts).toHaveLength(1);
			expect(execution.attempts?.[0]).toMatchObject({
				kind: "retry",
				ordinal: 2,
				previousAttemptId: expect.stringMatching(ATTEMPT_ID),
				subagentAttemptId: expect.stringMatching(ATTEMPT_ID),
			});
			expect(execution.attempts?.[0]?.subagentAttemptId).not.toBe(
				execution.attempts?.[0]?.previousAttemptId,
			);
			expect(execution.priorSettlements?.[0]?.evidence).toMatchObject({
				status: "failed",
				attemptOrdinal: 1,
			});
			expect(execution.terminal?.evidence).toMatchObject({
				kind: "subagent",
				attemptOrdinal: 2,
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("fails the run once the retry policy is exhausted", async () => {
		const fixture = await attemptWorkflowFixture({ retry: { attempts: 1 } });
		const delegated = attemptProvider([
			{ status: "failed", failure: childFailure("backoff") },
			{ status: "failed", failure: childFailure("backoff") },
		]);
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		try {
			const receipt = await service.run("attempts", {});
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({ status: "failed" });
			expect(delegated.ownerClient.retry).toHaveBeenCalledOnce();
			const types = await eventTypes(fixture.storeRoot, receipt.runId);
			expect(countOf(types, "task-execution-child-settled")).toBe(2);
			expect(countOf(types, "task-execution-attempt-intended")).toBe(1);
			expect(countOf(types, "task-execution-attempt-receipted")).toBe(1);
			const { task, execution } = agentExecutionOf(
				await stateOf(fixture.storeRoot, receipt.runId),
			);
			expect(task.status).toBe("failed");
			expect(execution.terminal?.evidence).toMatchObject({
				kind: "subagent",
				attemptOrdinal: 2,
				status: "failed",
			});
			expect(execution.priorSettlements).toHaveLength(1);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("does not retry a manual classification under the default policy", async () => {
		const fixture = await attemptWorkflowFixture({ retry: { attempts: 1 } });
		const delegated = attemptProvider([
			{ status: "failed", failure: childFailure("manual") },
			{ status: "completed" },
		]);
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		try {
			const receipt = await service.run("attempts", {});
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({ status: "failed" });
			expect(delegated.ownerClient.retry).not.toHaveBeenCalled();
			const types = await eventTypes(fixture.storeRoot, receipt.runId);
			expect(countOf(types, "task-execution-child-settled")).toBe(1);
			expect(countOf(types, "task-execution-attempt-intended")).toBe(0);
			const { execution } = agentExecutionOf(
				await stateOf(fixture.storeRoot, receipt.runId),
			);
			expect(execution.terminal?.evidence).toMatchObject({
				kind: "subagent",
				attemptOrdinal: 1,
				status: "failed",
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("retries a manual classification when the policy opts in", async () => {
		const fixture = await attemptWorkflowFixture({
			retry: { attempts: 1, on: ["manual"] },
		});
		const delegated = attemptProvider([
			{ status: "failed", failure: childFailure("manual") },
			{ status: "completed" },
		]);
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		try {
			const receipt = await service.run("attempts", {});
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({
				status: "completed",
				output: { answer: "from child" },
			});
			expect(delegated.ownerClient.retry).toHaveBeenCalledOnce();
			const { execution } = agentExecutionOf(
				await stateOf(fixture.storeRoot, receipt.runId),
			);
			expect(execution.attempts?.[0]).toMatchObject({
				kind: "retry",
				ordinal: 2,
			});
			expect(execution.terminal?.evidence).toMatchObject({
				attemptOrdinal: 2,
				status: "completed",
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("resumes an interrupted child under the resume policy", async () => {
		const fixture = await attemptWorkflowFixture({ resume: { attempts: 1 } });
		const delegated = attemptProvider([
			{ status: "interrupted", failure: childFailure("resume") },
			{ status: "completed" },
		]);
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		try {
			const receipt = await service.run("attempts", {});
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({
				status: "completed",
				output: { answer: "from child" },
			});
			expect(delegated.ownerClient.resume).toHaveBeenCalledOnce();
			expect(delegated.ownerClient.resume).toHaveBeenCalledWith(
				"run_servicechild",
			);
			expect(delegated.ownerClient.retry).not.toHaveBeenCalled();
			expect(delegated.ownerClient.launch).toHaveBeenCalledOnce();
			const types = await eventTypes(fixture.storeRoot, receipt.runId);
			expect(countOf(types, "task-execution-attempt-intended")).toBe(1);
			expect(countOf(types, "task-execution-attempt-receipted")).toBe(1);
			const { task, execution } = agentExecutionOf(
				await stateOf(fixture.storeRoot, receipt.runId),
			);
			expect(task.status).toBe("completed");
			expect(execution.attempts?.[0]).toMatchObject({
				kind: "resume",
				ordinal: 2,
				subagentAttemptId: expect.stringMatching(ATTEMPT_ID),
			});
			expect(execution.priorSettlements?.[0]?.evidence).toMatchObject({
				status: "interrupted",
				attemptOrdinal: 1,
			});
			expect(execution.terminal?.evidence).toMatchObject({
				attemptOrdinal: 2,
				status: "completed",
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("declines a backoff that would outlast the workflow deadline", async () => {
		const fixture = await attemptWorkflowFixture({
			retry: { attempts: 1 },
			timeoutMs: 3_000,
		});
		const delegated = attemptProvider([
			{ status: "failed", failure: childFailure("backoff") },
			{ status: "completed" },
		]);
		vi.mocked(delegated.ownerClient.retry).mockImplementation(async () => {
			throw new RetryBackoffError(new Date(Date.now() + 60_000).toISOString());
		});
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		// Freeze only the wall clock: this tests retryAt versus the persisted
		// deadline, not whether fsync and finalization finish within real time.
		// Timers, including bounded(), remain real.
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const receipt = await service.run("attempts", {});
			// The attempt is declined immediately because `retryAt` lies past the
			// deadline. Finalization must preserve the settled failure rather
			// than waiting for that future deadline to cancel the run.
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({ status: "failed" });
			expect(delegated.ownerClient.retry).toHaveBeenCalledOnce();
			const events = await journalEvents(fixture.storeRoot, receipt.runId);
			const types = events.map((event) => event.type);
			expect(countOf(types, "task-execution-child-settled")).toBe(1);
			expect(countOf(types, "task-execution-attempt-intended")).toBe(1);
			expect(countOf(types, "task-execution-attempt-receipted")).toBe(0);
			expect(countOf(types, "task-execution-attempt-declined")).toBe(1);
			const { task, execution } = agentExecutionOf(
				reduceWorkflowEvents(events),
			);
			expect(task.status).toBe("failed");
			expect(execution.attemptsClosed).toBe(true);
			expect(execution.attempts?.[0]).toMatchObject({
				kind: "retry",
				ordinal: 2,
				declinedSequence: expect.any(Number),
			});
			expect(execution.attempts?.[0]?.subagentAttemptId).toBeUndefined();
			expect(execution.terminal?.evidence).toMatchObject({
				attemptOrdinal: 1,
				status: "failed",
			});
		} finally {
			try {
				await bounded(service.shutdown(), "shutdown");
			} finally {
				vi.useRealTimers();
			}
		}
	});

	it("waits out a backoff that ends before the workflow deadline", async () => {
		const fixture = await attemptWorkflowFixture({
			retry: { attempts: 1 },
			timeoutMs: 30_000,
		});
		const delegated = attemptProvider([
			{ status: "failed", failure: childFailure("backoff") },
			{ status: "completed" },
		]);
		let backoffs = 0;
		let retryAt = 0;
		vi.mocked(delegated.ownerClient.retry).mockImplementation(async () => {
			if (backoffs === 0) {
				backoffs += 1;
				retryAt = Date.now() + 200;
				throw new RetryBackoffError(new Date(retryAt).toISOString());
			}
			return delegated.nextAttempt();
		});
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		try {
			const receipt = await service.run("attempts", {});
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({
				status: "completed",
				output: { answer: "from child" },
			});
			expect(Date.now()).toBeGreaterThanOrEqual(retryAt);
			expect(delegated.ownerClient.retry).toHaveBeenCalledTimes(2);
			const types = await eventTypes(fixture.storeRoot, receipt.runId);
			expect(countOf(types, "task-execution-child-settled")).toBe(2);
			expect(countOf(types, "task-execution-attempt-intended")).toBe(1);
			expect(countOf(types, "task-execution-attempt-receipted")).toBe(1);
			expect(countOf(types, "task-execution-attempt-declined")).toBe(0);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("declines the open attempt and cancels the run on an explicit stop during backoff", async () => {
		const fixture = await attemptWorkflowFixture({ retry: { attempts: 1 } });
		const delegated = attemptProvider([
			{ status: "failed", failure: childFailure("backoff") },
			{ status: "completed" },
		]);
		vi.mocked(delegated.ownerClient.retry).mockImplementation(async () => {
			throw new RetryBackoffError(
				new Date(Date.now() + 10 * 60_000).toISOString(),
			);
		});
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		try {
			const receipt = await service.run("attempts", {});
			await until(
				() => vi.mocked(delegated.ownerClient.retry).mock.calls.length > 0,
			);
			await expect(
				bounded(service.stop(receipt.runId, "operator stop"), "stop"),
			).resolves.toMatchObject({ status: "cancelled" });
			expect(delegated.ownerClient.retry).toHaveBeenCalledOnce();
			expect(delegated.ownerClient.interrupt).not.toHaveBeenCalled();
			const events = await journalEvents(fixture.storeRoot, receipt.runId);
			const types = events.map((event) => event.type);
			expect(countOf(types, "task-execution-attempt-intended")).toBe(1);
			expect(countOf(types, "task-execution-attempt-receipted")).toBe(0);
			expect(countOf(types, "task-execution-attempt-declined")).toBe(1);
			const { execution } = agentExecutionOf(reduceWorkflowEvents(events));
			expect(execution.attemptsClosed).toBe(true);
			expect(execution.attempts?.[0]?.subagentAttemptId).toBeUndefined();
			await expect(service.status(receipt.runId)).resolves.toMatchObject({
				status: "cancelled",
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("recovers an open attempt intent after a crash and records one receipt", async () => {
		const fixture = await attemptWorkflowFixture({ retry: { attempts: 1 } });
		const first = attemptProvider([
			{ status: "failed", failure: childFailure("backoff") },
			{ status: "completed" },
		]);
		const stuck = deferred<void>();
		vi.mocked(first.ownerClient.retry).mockImplementation(async () => {
			await stuck.promise;
			return first.nextAttempt();
		});
		const firstService = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: first.provider,
		});
		const receipt = await firstService.run("attempts", {});
		await until(() => vi.mocked(first.ownerClient.retry).mock.calls.length > 0);
		await until(async () =>
			(await eventTypes(fixture.storeRoot, receipt.runId)).includes(
				"task-execution-attempt-intended",
			),
		);
		const storeRoot = await crashSnapshot(fixture, receipt.runId);
		const snapshot = await eventTypes(storeRoot, receipt.runId);
		expect(countOf(snapshot, "task-execution-attempt-intended")).toBe(1);
		expect(countOf(snapshot, "task-execution-attempt-receipted")).toBe(0);

		const second = attemptProvider([{ status: "completed" }]);
		const service = await createWorkflowService({
			...fixture,
			storeRoot,
			projectTrusted: () => true,
			subagents: second.provider,
		});
		try {
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({
				status: "completed",
				output: { answer: "from child" },
			});
			expect(second.ownerClient.launch).not.toHaveBeenCalled();
			expect(second.ownerClient.retry).toHaveBeenCalledOnce();
			const types = await eventTypes(storeRoot, receipt.runId);
			expect(countOf(types, "task-execution-child-settled")).toBe(2);
			expect(countOf(types, "task-execution-attempt-intended")).toBe(1);
			expect(countOf(types, "task-execution-attempt-receipted")).toBe(1);
			expect(countOf(types, "task-execution-attempt-declined")).toBe(0);
			const { task, execution } = agentExecutionOf(
				await stateOf(storeRoot, receipt.runId),
			);
			expect(task.status).toBe("completed");
			expect(execution.attempts?.[0]).toMatchObject({
				kind: "retry",
				ordinal: 2,
				subagentAttemptId: expect.stringMatching(ATTEMPT_ID),
			});
			expect(execution.terminal?.evidence).toMatchObject({
				attemptOrdinal: 2,
				status: "completed",
			});
		} finally {
			await bounded(service.shutdown(), "shutdown").catch(() => undefined);
			stuck.resolve();
			await bounded(firstService.shutdown(), "first shutdown").catch(
				() => undefined,
			);
		}
	});

	it("charges every attempt against the workflow budget", async () => {
		const fixture = await attemptWorkflowFixture({
			retry: { attempts: 1 },
			budgetCost: 0.015,
			limitCost: 0.01,
		});
		const delegated = attemptProvider([
			{ status: "failed", failure: childFailure("backoff"), cost: 0.01 },
			{ status: "completed", cost: 0.01 },
		]);
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		try {
			const receipt = await service.run("attempts", {});
			// Reservations are per task (declared limits are cumulative), so the
			// retry is admitted; the summed settlement of both attempts then
			// exceeds the budget after finalization.
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({ status: "failed" });
			expect(delegated.ownerClient.retry).toHaveBeenCalledOnce();
			const events = await journalEvents(fixture.storeRoot, receipt.runId);
			expect(
				countOf(
					events.map((event) => event.type),
					"task-execution-child-settled",
				),
			).toBe(2);
			const reasons = events
				.filter((event) => event.type === "run-status-changed")
				.map((event) => (event.data as { reason?: string }).reason);
			expect(reasons).toContain("Workflow cost budget was exceeded.");
			const { task, execution } = agentExecutionOf(
				reduceWorkflowEvents(events),
			);
			expect(task.status).toBe("completed");
			expect(execution.settlement?.evidence.usage.cost).toBe(0.01);
			expect(execution.priorSettlements?.[0]?.evidence.usage.cost).toBe(0.01);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("fails closed when release reports the superseded attempt", async () => {
		const fixture = await attemptWorkflowFixture({ retry: { attempts: 1 } });
		const delegated = attemptProvider([
			{ status: "failed", failure: childFailure("backoff") },
			{ status: "completed" },
		]);
		vi.mocked(delegated.ownerClient.release).mockResolvedValue({
			runId: "run_servicechild",
			attemptId: "attempt_servicechild",
			status: "completed",
		});
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		try {
			const receipt = await service.run("attempts", {});
			const settled = await bounded(
				service.wait(receipt.runId).then(
					(view) => ({ outcome: "resolved" as const, status: view.status }),
					(error: unknown) => ({ outcome: "rejected" as const, error }),
				),
				"wait",
				10_000,
			);
			expect(
				settled.outcome === "rejected" || settled.status === "failed",
			).toBe(true);
			expect(
				vi.mocked(delegated.ownerClient.release).mock.calls.length,
			).toBeLessThanOrEqual(2);
		} finally {
			await bounded(service.shutdown(), "shutdown").catch(() => undefined);
		}
	});

	it("keeps the task non-failed while an attempt is pending", async () => {
		const fixture = await attemptWorkflowFixture({ retry: { attempts: 1 } });
		const delegated = attemptProvider([
			{ status: "failed", failure: childFailure("backoff") },
			{ status: "completed" },
		]);
		const gate = deferred<void>();
		vi.mocked(delegated.ownerClient.retry).mockImplementation(async () => {
			await gate.promise;
			return delegated.nextAttempt();
		});
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		try {
			const receipt = await service.run("attempts", {});
			await until(
				() => vi.mocked(delegated.ownerClient.retry).mock.calls.length > 0,
			);
			const view = await service.status(receipt.runId);
			expect(["running", "waiting"]).toContain(view.status);
			const events = await journalEvents(fixture.storeRoot, receipt.runId);
			const { task, execution } = agentExecutionOf(
				reduceWorkflowEvents(events),
			);
			expect(["running", "waiting"]).toContain(task.status);
			expect(execution.phase).toBe("attempt-intended");
			expect(execution.settlement?.evidence.status).toBe("failed");
			const taskStatuses = events
				.filter((event) => event.type === "task-status-changed")
				.map((event) => (event.data as { to: string }).to);
			expect(taskStatuses).not.toContain("failed");
			gate.resolve();
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({ status: "completed" });
			const finalStatuses = (
				await journalEvents(fixture.storeRoot, receipt.runId)
			)
				.filter((event) => event.type === "task-status-changed")
				.map((event) => (event.data as { to: string }).to);
			expect(finalStatuses).not.toContain("failed");
			expect(finalStatuses.at(-1)).toBe("completed");
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});
});

describe("reconciliation of runs this service owns", () => {
	it("refuses task ids against the durable view of an owned failed run without re-leasing it", async () => {
		const fixture = await attemptWorkflowFixture();
		const delegated = attemptProvider([
			{ status: "failed", failure: childFailure("manual") },
		]);
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		try {
			const receipt = await service.run("attempts", {});
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({ status: "failed" });
			const { task } = agentExecutionOf(
				await stateOf(fixture.storeRoot, receipt.runId),
			);
			await expect(
				service.reconcile(receipt.runId, { taskId: "task_unknownzz" }),
			).rejects.toMatchObject({
				code: "validation",
				message: "Unknown workflow task.",
			});
			await expect(
				service.reconcile(receipt.runId, { taskId: task.task.id }),
			).rejects.toMatchObject({
				code: "validation",
				message: "Workflow task is not cleanup-blocked.",
			});
			// The settled run still holds its lease; reconcile reuses it instead
			// of colliding with it, and a failed run has nothing to reconcile.
			const view = await bounded(service.reconcile(receipt.runId), "reconcile");
			expect(view).toMatchObject({ status: "failed", reconciled: [] });
			expect(Object.isFrozen(view.reconciled)).toBe(true);
			await expect(
				service.stop(receipt.runId, "already failed"),
			).resolves.toMatchObject({ status: "failed" });
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("reconciles an owned cleanup-blocked run and reports the child facts", async () => {
		const fixture = await attemptWorkflowFixture();
		const delegated = attemptProvider([
			{ status: "failed", failure: childFailure("never") },
		]);
		// The first settlement is cleanup-blocked with unproved sandbox cleanup;
		// the reconciled child then settles as failed, and release echoes each.
		const blocked = childResult({
			status: "cleanup-blocked",
			failure: {
				code: "sandbox-cleanup",
				origin: "sandbox",
				retry: "reconcile",
				message: "cleanup blocked",
				guidance: "Reconcile the child.",
			},
		});
		vi.mocked(delegated.ownerClient.wait)
			.mockResolvedValueOnce({
				...blocked,
				result: { ...blocked.result, sandboxCleanup: "blocked" },
			})
			.mockResolvedValueOnce(
				childResult({ status: "failed", failure: childFailure("never") }),
			);
		vi.mocked(delegated.ownerClient.release)
			.mockResolvedValueOnce({
				runId: "run_servicechild",
				attemptId: "attempt_servicechild",
				status: "cleanup-blocked",
			})
			.mockResolvedValueOnce({
				runId: "run_servicechild",
				attemptId: "attempt_servicechild",
				status: "failed",
			});
		const ownerClient = delegated.ownerClient as unknown as Record<
			string,
			unknown
		>;
		const reconcile = vi.fn(async () => ({
			run: {
				runId: "run_servicechild",
				attemptId: "attempt_servicechild",
				status: "failed" as const,
			},
			sandboxProcess: "absent" as const,
			workspace: "not-needed" as const,
		}));
		ownerClient.reconcile = reconcile;
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		try {
			const receipt = await service.run("attempts", {});
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({ status: "cleanup-blocked" });
			const { task, execution } = agentExecutionOf(
				await stateOf(fixture.storeRoot, receipt.runId),
			);
			expect(task.status).toBe("cleanup-blocked");
			const view = await bounded(service.reconcile(receipt.runId), "reconcile");
			expect(view.status).toBe("failed");
			expect(view.reconciled).toEqual([
				{
					taskId: task.task.id,
					executionId: execution.execution.id,
					before: {
						phase: "terminal",
						outcome: "cleanup-blocked",
						childStatus: "cleanup-blocked",
					},
					after: {
						phase: "terminal",
						outcome: "failed",
						childStatus: "failed",
					},
					subagent: { sandboxProcess: "absent", workspace: "not-needed" },
				},
			]);
			expect(reconcile).toHaveBeenCalledOnce();
			await expect(
				service.reconcile(receipt.runId, { taskId: task.task.id }),
			).rejects.toMatchObject({
				code: "validation",
				message: "Workflow task is not cleanup-blocked.",
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});
});

const HANDOFF_BASELINE_HEAD = "b".repeat(40);
const HANDOFF_COMMIT = "d".repeat(40);
const HANDOFF_MBOX_DATE = "Mon Sep 17 00:00:00 2001";

function sha256Of(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function handoffPatch(commit = HANDOFF_COMMIT): Buffer {
	return Buffer.from(
		`From ${commit} ${HANDOFF_MBOX_DATE}\nFrom: Agent <agent@example.com>\nSubject: [PATCH] change\n\n---\n a.txt | 1 +\n`,
	);
}

/** pi-subagent's private worktree record; only its identity may be persisted. */
function worktreeRecord(handoffCommit?: string): WorktreeRecord {
	return {
		schema: "pi-subagent-worktree",
		contractRevision: 6,
		runId: "run_servicechild",
		attemptId: "attempt_servicechild",
		repositoryRoot: "/private/repo",
		worktreePath: "/private/repo/.pi/worktrees/run_servicechild",
		recordPath: "/private/repo/.pi/worktrees/run_servicechild.json",
		branch: "pi-subagent/reservations/run_servicechild",
		baselineHead: HANDOFF_BASELINE_HEAD,
		createdAt: "2026-01-01T00:00:00.000Z",
		...(handoffCommit === undefined
			? {}
			: {
					handoffCommit,
					handoffRef: `refs/pi-subagent/handoffs/run_servicechild/attempt_servicechild`,
				}),
	};
}

function handoffRefOf(content: Buffer): HandoffRef {
	return {
		runId: "run_servicechild",
		attemptId: "attempt_servicechild",
		baselineHead: HANDOFF_BASELINE_HEAD,
		handoffCommit: HANDOFF_COMMIT,
		format: "git-format-patch",
		sha256: sha256Of(content),
		bytes: content.byteLength,
		mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
	};
}

async function worktreeWorkflowFixture(policy?: "required" | "optional") {
	const fixture = await workflowFixture("worktree-task");
	await writeFile(
		fixture.definitionPath,
		`export default {
  schema: "pi-workflow-definition",
  meta: { name: "worktree-task", description: "Worktree task workflow", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 3600000, concurrency: 4 },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  run(ctx) {
    return ctx.agent("write", {
      agent: "writer",
      task: { goal: "Change", context: [], instructions: ["Edit and return structured output."] },
      contextMode: "fresh",
      tools: ["read", "write"],
      preloadSkills: [],
      contextScopes: ["project"],
      workspace: { mode: "worktree", cwd: ctx.cwd },
      ${policy ? `handoff: ${JSON.stringify(policy)},` : ""}
      outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
      limits: { cumulativeRuntimeMs: 300000, attemptTimeoutMs: 300000, totalTokens: 1000000, cost: 10, outputBytes: 1024, workspaceWriteBytes: 1024, retries: 0, resumes: 0 }
    });
  }
};\n`,
	);
	return fixture;
}

/**
 * Owner client whose completed child settles with a worktree record and whose
 * `exportHandoff` renders that record's commit as a single-commit patch.
 */
function worktreeProvider(content = handoffPatch()) {
	const delegated = taskProvider();
	vi.mocked(delegated.ownerClient.wait).mockImplementation(async () => ({
		...childResult({ status: "completed" }),
		handoff: worktreeRecord(HANDOFF_COMMIT),
	}));
	const exportHandoff = vi.fn(async () => ({
		ref: handoffRefOf(content),
		content,
	}));
	(delegated.ownerClient as unknown as Record<string, unknown>).exportHandoff =
		exportHandoff;
	return { ...delegated, exportHandoff, content };
}

function worktreeTaskOf(view: Awaited<ReturnType<WorkflowService["status"]>>) {
	const task = view.tasks?.find((candidate) => candidate.kind === "agent");
	if (!task) throw new Error("missing agent task view");
	return task;
}

describe("worktree handoffs", () => {
	it("imports the handoff before release, exposes it on the view, and exports verified bytes", async () => {
		const fixture = await worktreeWorkflowFixture();
		const delegated = worktreeProvider();
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		let runId: string | undefined;
		try {
			const receipt = await service.run("worktree-task", {});
			runId = receipt.runId;
			const view = await bounded(service.wait(receipt.runId), "wait");
			expect(view).toMatchObject({
				status: "completed",
				output: { answer: "from child" },
			});
			expect(delegated.exportHandoff).toHaveBeenCalledExactlyOnceWith(
				"run_servicechild",
				{ maxBytes: 16 * 1024 * 1024 },
			);
			const types = await eventTypes(fixture.storeRoot, receipt.runId);
			expect(countOf(types, "task-execution-handoff-imported")).toBe(1);
			expect(countOf(types, "task-execution-handoff-absent")).toBe(0);
			expect(types.indexOf("task-execution-handoff-imported")).toBeGreaterThan(
				types.indexOf("task-execution-artifact-imported"),
			);
			expect(types.indexOf("task-execution-handoff-imported")).toBeLessThan(
				types.indexOf("task-execution-release-intended"),
			);
			const task = worktreeTaskOf(view);
			const { execution } = agentExecutionOf(
				await stateOf(fixture.storeRoot, receipt.runId),
			);
			const expectedDescriptor = {
				artifactId: expect.stringMatching(/^artifact_/),
				runId: receipt.runId,
				producerTaskId: task.id,
				producerExecutionId: execution.execution.id,
				subagentRunId: "run_servicechild",
				subagentAttemptId: "attempt_servicechild",
				baselineHead: HANDOFF_BASELINE_HEAD,
				handoffCommit: HANDOFF_COMMIT,
				format: "git-format-patch",
				mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
				sha256: sha256Of(delegated.content),
				bytes: delegated.content.byteLength,
			};
			expect(task.status).toBe("completed");
			expect(task.handoff).toEqual(expectedDescriptor);
			expect(Value.Check(WorkflowHandoffDescriptorSchema, task.handoff)).toBe(
				true,
			);
			// The descriptor is the only JSON face of a handoff: no private paths.
			expect(JSON.stringify(task.handoff)).not.toMatch(
				/private|worktrees|refs\//,
			);

			const exported = await service.exportHandoff(receipt.runId, task.id);
			expect(exported.descriptor).toEqual(task.handoff);
			expect(Buffer.isBuffer(exported.content)).toBe(true);
			expect(exported.content.equals(delegated.content)).toBe(true);
			expect(sha256Of(exported.content)).toBe(exported.descriptor.sha256);
			expect(exported.content.byteLength).toBe(exported.descriptor.bytes);
			expect(exported.content.toString("utf8").split("\n")[0]).toBe(
				`From ${HANDOFF_COMMIT} ${HANDOFF_MBOX_DATE}`,
			);
			// The export re-verifies the durable artifact; pi-subagent is not
			// asked again.
			expect(delegated.exportHandoff).toHaveBeenCalledOnce();
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
		if (!runId) throw new Error("run did not start");

		// The inactive-open path serves the same descriptor and bytes without
		// acquiring a subagent binding.
		const restarted = provider();
		const second = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: restarted,
		});
		try {
			const view = await second.status(runId);
			const task = worktreeTaskOf(view);
			expect(task.handoff).toMatchObject({
				handoffCommit: HANDOFF_COMMIT,
				sha256: sha256Of(delegated.content),
			});
			const exported = await second.exportHandoff(runId, task.id);
			expect(exported.descriptor).toEqual(task.handoff);
			expect(exported.content.equals(delegated.content)).toBe(true);
			expect(restarted.bind).not.toHaveBeenCalled();
			await expect(second.exportHandoff("bad", task.id)).rejects.toMatchObject({
				code: "validation",
				message: "Invalid workflow run ID.",
			});
			await expect(second.exportHandoff(runId, "bad")).rejects.toMatchObject({
				code: "validation",
				message: "Invalid workflow task ID.",
			});
			await expect(
				second.exportHandoff(runId, "task_missing"),
			).rejects.toMatchObject({ code: "not-found" });
		} finally {
			await bounded(second.shutdown(), "shutdown");
		}
	});

	it("refuses to export a handoff for a read-only task", async () => {
		const fixture = await taskWorkflowFixture();
		const delegated = taskProvider();
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		try {
			const receipt = await service.run("agent-task", {});
			const view = await bounded(service.wait(receipt.runId), "wait");
			expect(view.status).toBe("completed");
			const task = worktreeTaskOf(view);
			expect(task.status).toBe("completed");
			expect(task).not.toHaveProperty("handoff");
			await expect(
				service.exportHandoff(receipt.runId, task.id),
			).rejects.toMatchObject({
				code: "validation",
				message: "Workflow task has no handoff artifact.",
			});
			const types = await eventTypes(fixture.storeRoot, receipt.runId);
			expect(countOf(types, "task-execution-handoff-imported")).toBe(0);
			expect(countOf(types, "task-execution-handoff-absent")).toBe(0);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("refuses to export a handoff while the worktree task is incomplete", async () => {
		const fixture = await worktreeWorkflowFixture();
		const delegated = worktreeProvider();
		const terminal = deferred<Awaited<ReturnType<SubagentClient["wait"]>>>();
		vi.mocked(delegated.ownerClient.wait).mockImplementation(
			async () => terminal.promise,
		);
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		try {
			const receipt = await service.run("worktree-task", {});
			await until(
				() => vi.mocked(delegated.ownerClient.wait).mock.calls.length > 0,
			);
			const view = await service.status(receipt.runId);
			const task = worktreeTaskOf(view);
			expect(task.status).not.toBe("completed");
			expect(task).not.toHaveProperty("handoff");
			await expect(
				service.exportHandoff(receipt.runId, task.id),
			).rejects.toMatchObject({
				code: "validation",
				message: "Workflow task has no handoff artifact.",
			});
			expect(delegated.exportHandoff).not.toHaveBeenCalled();
			terminal.resolve({
				...childResult({ status: "completed" }),
				handoff: worktreeRecord(HANDOFF_COMMIT),
			});
			const completed = await bounded(service.wait(receipt.runId), "wait");
			expect(completed.status).toBe("completed");
			expect(worktreeTaskOf(completed).handoff).toMatchObject({
				handoffCommit: HANDOFF_COMMIT,
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("surfaces a corrupt handoff blob as a persistence failure while the view stays metadata-only", async () => {
		const fixture = await worktreeWorkflowFixture();
		const delegated = worktreeProvider();
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: delegated.provider,
		});
		try {
			const receipt = await service.run("worktree-task", {});
			const view = await bounded(service.wait(receipt.runId), "wait");
			expect(view.status).toBe("completed");
			const task = worktreeTaskOf(view);
			const descriptor = task.handoff;
			if (!descriptor) throw new Error("missing handoff descriptor");
			const blob = path.join(
				fixture.storeRoot,
				"runs",
				receipt.runId,
				"artifacts",
				`${descriptor.sha256}.patch`,
			);
			// Same length and first line, different bytes: only the digest tells.
			const forged = Buffer.from(delegated.content);
			forged[forged.byteLength - 1] = 0x21;
			expect(forged.equals(delegated.content)).toBe(false);
			await writeFile(blob, forged);
			await expect(
				service.exportHandoff(receipt.runId, task.id),
			).rejects.toMatchObject({
				code: "persistence",
				message: "Completed worktree task has no verified handoff artifact.",
			});
			// The status view derives the descriptor from durable state alone.
			expect(
				worktreeTaskOf(await service.status(receipt.runId)).handoff,
			).toEqual(descriptor);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});
});
