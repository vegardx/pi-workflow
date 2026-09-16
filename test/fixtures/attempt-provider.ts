import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
import { vi } from "vitest";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../../src/subagent-provider.js";

// Shared operator fixtures: an owner client that mints one child run per
// launch and hands out fresh attempts on `retry`/`resume`, plus the project
// definitions the operator and tool tests drive. Adapted from
// test/service.test.ts and test/service-invalidation.test.ts.

export const SHA = "a".repeat(64);

export const ANSWER_SCHEMA =
	'{ type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }';

export function root(name: string): string {
	return path.resolve(
		".pi",
		"test-service-operator",
		`${name}-${randomUUID()}`,
	);
}

export function client(): SubagentClient {
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

export type ChildFailure = NonNullable<RunResult["failure"]>;

export function childFailure(retry: ChildFailure["retry"]): ChildFailure {
	return {
		code: "provider-transient",
		origin: "provider",
		retry,
		message: "provider hiccup",
		guidance: "Try again later.",
	};
}

export interface ChildOutcome {
	readonly status: RunResult["status"];
	readonly failure?: ChildFailure;
}

export const INTERRUPTED: ChildOutcome = {
	status: "interrupted",
	failure: childFailure("resume"),
};
export const COMPLETED: ChildOutcome = { status: "completed" };

export function childIds(nonce: string, launch: number) {
	return {
		runId: `run_child${nonce}${launch}`,
		attemptId: `attempt_child${nonce}${launch}`,
	};
}

export function childResult(outcome: ChildOutcome, runId: string) {
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

export type Script =
	| readonly ChildOutcome[]
	| ((launch: number) => readonly ChildOutcome[]);

/**
 * Owner client minting one child run per launch. Each child's successive
 * `wait` calls return its scripted outcomes in order (the last one repeats);
 * `retry`/`resume` hand out fresh attempt ids for the named child, which
 * `release` then echoes back with the child's last status.
 */
export function attemptProvider(script: Script) {
	const nonce = randomUUID().replaceAll("-", "").slice(0, 8);
	const outcomesFor = (launch: number) =>
		typeof script === "function" ? script(launch) : script;
	const launchOf = (runId: string) =>
		Number.parseInt(runId.slice(`run_child${nonce}`.length), 10);
	let launches = 0;
	let taskOwnerId = "";
	const attempts = new Map<string, string>();
	const waits = new Map<string, number>();
	const lastStatus = new Map<string, RunResult["status"]>();
	const preflight = vi.fn(async (request: SubagentRequest) => {
		const planned = childIds(nonce, launches + 1);
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
			preflightId: "preflight-service",
			identitySha256: canonicalSha256(draft),
			expiresAt: "2099-01-01T00:00:00.000Z",
			launchPlan: { ...draft, identitySha256: canonicalSha256(draft) },
		};
	});
	const nextAttempt = async (runId: string): Promise<RunReceipt> => {
		const ordinal = (attempts.get(runId)?.split("x").length ?? 1) + 1;
		const attemptId = `${childIds(nonce, launchOf(runId)).attemptId}x${ordinal}`;
		attempts.set(runId, attemptId);
		return { runId, attemptId, status: "active" };
	};
	const ownerClient = {
		...client(),
		preflight,
		launch: vi.fn(async () => {
			launches += 1;
			const ids = childIds(nonce, launches);
			attempts.set(ids.runId, ids.attemptId);
			return { ...ids, status: "active" as const };
		}),
		wait: vi.fn(async (runId: string) => {
			const outcomes = outcomesFor(launchOf(runId));
			const index = waits.get(runId) ?? 0;
			const outcome = outcomes[Math.min(index, outcomes.length - 1)];
			if (!outcome) throw new Error("no child outcome scripted");
			waits.set(runId, index + 1);
			lastStatus.set(runId, outcome.status);
			return childResult(outcome, runId);
		}),
		release: vi.fn(async (runId: string) => ({
			runId,
			attemptId: attempts.get(runId) ?? "",
			status: lastStatus.get(runId) ?? ("completed" as const),
		})),
		retry: vi.fn(nextAttempt),
		resume: vi.fn(nextAttempt),
		findByOperation: vi.fn(async () => undefined),
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
	return {
		provider: { bind } as WorkflowSubagentProvider,
		ownerClient,
		childRunId: (launch: number) => childIds(nonce, launch).runId,
	};
}

export function agentBody(
	key: string,
	options: { readonly disposition?: "optional"; readonly retry?: string } = {},
): string {
	return `ctx.agent(${JSON.stringify(key)}, {
      agent: "researcher",
      task: { goal: "Answer", context: [], instructions: ["Return structured output."] },
      contextMode: "fresh",
      tools: ["read"],
      preloadSkills: [],
      contextScopes: ["project"],
      workspace: { mode: "read-only", cwd: ctx.cwd },
      outputSchema: ${ANSWER_SCHEMA},
      ${options.disposition ? `disposition: ${JSON.stringify(options.disposition)},` : ""}
      ${options.retry ? `retry: ${options.retry},` : ""}
      limits: { cumulativeRuntimeMs: 300000, attemptTimeoutMs: 300000, totalTokens: 1000000, cost: 10, outputBytes: 1024, workspaceWriteBytes: 0, retries: 0, resumes: 0 }
    })`;
}

export function definition(
	name: string,
	body: string,
	timeoutMs = 3_600_000,
): string {
	return `export default {
  schema: "pi-workflow-definition",
  meta: { name: ${JSON.stringify(name)}, description: "Operator surface", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: ${timeoutMs}, concurrency: 4 },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: ${ANSWER_SCHEMA},
  async run(ctx) {
    ${body}
  }
};
`;
}

/**
 * One project with every definition the operator tests drive: `attempts`
 * (one required agent task under a result barrier), `pair` (two required
 * tasks under a results barrier), `chain` (a required task exposed by a
 * settled barrier whose outcome the workflow then acts on in a later
 * epoch), and `brief` (`attempts` with a short deadline).
 */
export async function operatorFixture() {
	const base = root("project");
	const cwd = path.join(base, "project");
	const agentDir = path.join(base, "agent");
	const storeRoot = path.join(cwd, ".pi", "workflow");
	const workflows = path.join(cwd, "workflows");
	await mkdir(workflows, { recursive: true });
	const files: Record<string, string> = {
		attempts: definition("attempts", `return ${agentBody("answer")};`),
		brief: definition("brief", `return ${agentBody("answer")};`, 4_000),
		pair: definition(
			"pair",
			`const a = ${agentBody("a")};
    const b = ${agentBody("b")};
    const [ra] = await ctx.results([a, b]);
    return { answer: ra.answer };`,
		),
		chain: definition(
			"chain",
			`const a = ${agentBody("a")};
    await ctx.settled([a]);
    return { answer: "settled" };`,
		),
	};
	for (const [workflow, source] of Object.entries(files)) {
		await writeFile(path.join(workflows, `${workflow}.workflow.ts`), source);
	}
	return { cwd, agentDir, storeRoot };
}
