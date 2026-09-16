// `modelRole` through the service seam (spec 2.5).
//
// test/model-role.test.ts proves the materializer's half. This proves the
// wiring: the port a host hands `createWorkflowService` reaches the
// materializer every run makes, the exact model it resolved is what the child
// is launched with, the router that answered is recorded in the run record,
// and a service constructed without the option refuses a `modelRole` run with
// the one fixed message instead of guessing a model.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	type AgentLaunchPlan,
	canonicalSha256,
	type ExactModelRequest,
	SUBAGENT_RUNTIME_CONTRACT,
	type SubagentClient,
	type SubagentRequest,
} from "@vegardx/pi-subagent";
import { describe, expect, it, vi } from "vitest";
import {
	MODEL_ROUTING_MISSING_MESSAGE,
	type StaticModelRoutingTable,
	staticModelRouting,
} from "../src/runtime/model-routing.js";
import { createWorkflowService } from "../src/service.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";

const TABLE: StaticModelRoutingTable = {
	provider: "github-copilot",
	id: "gpt-5.6-sol",
	otherFamily: { provider: "github-copilot", id: "gpt-5.6-luna" },
	thinking: { light: "low", standard: "medium", heavy: "high" },
	defaultThinking: "medium",
};

/** What TABLE resolves `{ persona: "code-review", tier: "heavy" }` to. */
const RESOLVED: ExactModelRequest = {
	provider: "github-copilot",
	id: "gpt-5.6-sol",
	thinking: "high",
};

/**
 * A definition that asks for a model by role. `guarded` wraps the declaration
 * in the definition's own try/catch, which is how a materialization refusal
 * becomes observable as output instead of a run that merely failed.
 */
async function roleWorkflowFixture(guarded = false) {
	const base = path.resolve(".pi", "test-model-role", randomUUID());
	const cwd = path.join(base, "project");
	const agentDir = path.join(base, "agent");
	const storeRoot = path.join(cwd, ".pi", "workflow");
	await mkdir(path.join(cwd, "workflows"), { recursive: true });
	const declaration = `ctx.agent("review", {
      agent: "researcher",
      task: { goal: "Answer", context: [], instructions: ["Return structured output."] },
      contextMode: "fresh",
      modelRole: { persona: "code-review", tier: "heavy" },
      tools: ["read"],
      preloadSkills: [],
      contextScopes: ["project"],
      workspace: { mode: "read-only", cwd: ctx.cwd },
      outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
      limits: { cumulativeRuntimeMs: 300000, attemptTimeoutMs: 300000, totalTokens: 1000000, cost: 10, outputBytes: 1024, workspaceWriteBytes: 0, retries: 0, resumes: 0 }
    })`;
	const body = guarded
		? `try { return ${declaration}; } catch (error) { return { answer: error.message }; }`
		: `return ${declaration};`;
	await writeFile(
		path.join(cwd, "workflows", "role.workflow.ts"),
		`export default {
  schema: "pi-workflow-definition",
  meta: { name: "role", description: "Model role workflow", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 3600000, concurrency: 4 },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  run(ctx) {
    ${body}
  }
};\n`,
	);
	return { cwd, agentDir, storeRoot };
}

/** A subagent that completes every task and records the model it was asked for. */
function roleProvider() {
	const models: ExactModelRequest[] = [];
	let ownerId = "";
	const preflight = vi.fn(async (request: SubagentRequest) => {
		if (request.model !== undefined) models.push(request.model);
		const draft = {
			schema: "pi-subagent-launch" as const,
			contractRevision: SUBAGENT_RUNTIME_CONTRACT.contractRevision,
			operationId: request.operationId,
			ownerId,
			runId: "run_rolechild",
			attemptId: "attempt_rolechild",
			agent: request.agent,
			agentDisplayName: "Researcher",
			agentPrompt: "Research",
			agentSource: "/agent.md",
			agentSha256: "a".repeat(64),
			agentScope: "global" as const,
			task: structuredClone(request.task),
			contextMode: request.contextMode,
			model: request.model ?? {
				provider: "test",
				id: "model",
				thinking: "low" as const,
			},
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
		const identitySha256 = canonicalSha256(draft);
		return {
			preflightId: "preflight-role",
			identitySha256,
			expiresAt: "2099-01-01T00:00:00.000Z",
			launchPlan: { ...draft, identitySha256 },
		};
	});
	const unavailable = vi.fn(async () => {
		throw new Error("unexpected subagent call");
	});
	const client = {
		preflight,
		findByOperation: unavailable,
		status: unavailable,
		listRuns: unavailable,
		logs: unavailable,
		interrupt: unavailable,
		steer: unavailable,
		followUp: unavailable,
		retry: unavailable,
		resume: unavailable,
		reconcile: unavailable,
		abandon: unavailable,
		pin: unavailable,
		unpin: unavailable,
		exportArtifact: unavailable,
		launch: vi.fn(async () => ({
			runId: "run_rolechild",
			attemptId: "attempt_rolechild",
			status: "active" as const,
		})),
		wait: vi.fn(async () => ({
			result: {
				runId: "run_rolechild",
				status: "completed" as const,
				structuredOutput: { answer: "reviewed" },
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
			output: "reviewed",
			sessionFile: undefined,
			handoff: undefined,
			structuredOutput: { answer: "reviewed" },
			error: undefined,
		})),
		release: vi.fn(async () => ({
			runId: "run_rolechild",
			attemptId: "attempt_rolechild",
			status: "completed" as const,
		})),
	} as unknown as SubagentClient;
	const bind = vi.fn(async (runId: string) => {
		ownerId = `pi-workflow:${runId}`;
		return {
			workflowRunId: runId,
			ownerId,
			client,
		} satisfies WorkflowSubagentBinding;
	});
	return { provider: { bind } as WorkflowSubagentProvider, models };
}

async function runRecord(storeRoot: string, runId: string) {
	return JSON.parse(
		await readFile(path.join(storeRoot, "runs", runId, "service.json"), "utf8"),
	) as { modelRouting?: { router: string } };
}

describe("the model routing service option", () => {
	it("runs a modelRole definition end to end and records the router", async () => {
		const fixture = await roleWorkflowFixture();
		const subagents = roleProvider();
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: subagents.provider,
			modelRouting: staticModelRouting(TABLE),
		});
		try {
			const receipt = await service.run("role", {});
			await expect(service.wait(receipt.runId)).resolves.toMatchObject({
				status: "completed",
				output: { answer: "reviewed" },
			});
			// The exact model the router resolved is what the child was launched
			// with: routing happened before the request was hashed and sent.
			expect(subagents.models).toEqual([RESOLVED]);
			expect(await runRecord(fixture.storeRoot, receipt.runId)).toMatchObject({
				modelRouting: { router: "static-table" },
			});
		} finally {
			await service.shutdown();
		}
	});

	it("fails the run when a modelRole meets no installed router", async () => {
		const fixture = await roleWorkflowFixture();
		const subagents = roleProvider();
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: subagents.provider,
		});
		try {
			const receipt = await service.run("role", {});
			await expect(service.wait(receipt.runId)).resolves.toMatchObject({
				status: "failed",
			});
			// It refused rather than guessing: nothing was ever preflighted.
			expect(subagents.models).toEqual([]);
			// A run that routed nothing names no router.
			expect(
				await runRecord(fixture.storeRoot, receipt.runId),
			).not.toHaveProperty("modelRouting");
		} finally {
			await service.shutdown();
		}
	});

	it("refuses with the fixed message the definition can read", async () => {
		// The journal withholds a trusted definition's own error text, so the
		// message is asserted where a definition meets it: at the declaration.
		const fixture = await roleWorkflowFixture(true);
		const subagents = roleProvider();
		const service = await createWorkflowService({
			...fixture,
			projectTrusted: () => true,
			subagents: subagents.provider,
		});
		try {
			const receipt = await service.run("role", {});
			await expect(service.wait(receipt.runId)).resolves.toMatchObject({
				status: "completed",
				output: { answer: MODEL_ROUTING_MISSING_MESSAGE },
			});
			expect(subagents.models).toEqual([]);
		} finally {
			await service.shutdown();
		}
	});
});
