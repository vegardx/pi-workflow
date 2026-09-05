import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	type AgentLaunchPlan,
	canonicalSha256,
	SUBAGENT_RUNTIME_CONTRACT,
	type SubagentClient,
	type SubagentRequest,
} from "@vegardx/pi-subagent";
import { describe, expect, it, vi } from "vitest";
import { deriveJsonValueSha256 } from "../src/execution.js";
import { WorkflowRunJournal } from "../src/persistence/journal.js";
import { acquireWorkflowRunLease } from "../src/persistence/run-lease.js";
import { discoverWorkflows } from "../src/registry.js";
import { WorkflowRunRecordStore } from "../src/run-record.js";
import { createWorkflowService, WorkflowServiceError } from "../src/service.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
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
  meta: { name: ${JSON.stringify(name)}, description: "Service workflow", version: 1 },
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
  meta: { name: "agent-task", description: "Agent task workflow", version: 1 },
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
      limits: { runtimeMs: 300000, attemptRuntimeMs: 300000, tokens: 1000000, cost: 10, outputBytes: 1024, workspaceWriteBytes: 0, retries: 0, resumes: 0 }
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
		});
		expect(await service.list()).toMatchObject([
			{ name: "example", scope: "project" },
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
			contractRevision: 1,
			runId,
			definitionName: "pending",
			definitionPath: workflow.path,
			definitionIdentitySha256: workflow.identity.identitySha256,
			definitionSourceSha256: workflow.identity.sourceSha256,
			cwd: fixture.cwd,
			input,
			createdAt: "2026-09-01T00:00:00.000Z",
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
