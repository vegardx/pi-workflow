import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { describe, expect, it, vi } from "vitest";
import { settledAgentUsage } from "../src/attempts.js";
import {
	budgetExceededReason,
	reservedWorkflowUsage,
	settledWorkflowUsage,
} from "../src/budget.js";
import type {
	MaterializedAgentTask,
	MaterializedNestedWorkflowTask,
	SubagentTerminalEvidence,
	WorkflowBudget,
	WorkflowTaskStatus,
} from "../src/contracts.js";
import type {
	TaskExecutionProjection,
	WorkflowStateProjection,
} from "../src/events.js";
import {
	deriveNestedWorkflowRunId,
	deriveSubagentOperationId,
	deriveTaskExecutionId,
} from "../src/execution.js";
import type { WorkflowJournalEvent } from "../src/persistence/journal.js";
import { reduceWorkflowEvents } from "../src/reducer.js";
import type { WorkflowRunRecord } from "../src/run-record.js";
import { createWorkflowService } from "../src/service.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";

// ---------------------------------------------------------------------------
// Hand-built projections
// ---------------------------------------------------------------------------

const RUN_ID = "workflow_budgetfixture";
const SHA = "a".repeat(64);

function agentTask(
	key: string,
	sequence: number,
	limits: { cost: number; totalTokens?: number; cumulativeRuntimeMs: number },
): MaterializedAgentTask {
	return {
		id: `task_${key}`,
		runId: RUN_ID,
		namespace: [],
		spec: {
			key,
			kind: "agent",
			role: "task",
			disposition: "required",
			after: [],
			inputs: {},
			replay: "auto",
			request: {
				agent: "researcher",
				task: { goal: "Answer", context: [], instructions: ["Return output."] },
				contextMode: "fresh",
				tools: ["read"],
				preloadSkills: [],
				contextScopes: ["project"],
				workspace: { mode: "read-only", cwd: "/repo" },
				outputSchema: { type: "object" },
				limits: {
					cumulativeRuntimeMs: limits.cumulativeRuntimeMs,
					attemptTimeoutMs: 300_000,
					...(limits.totalTokens === undefined
						? {}
						: { totalTokens: limits.totalTokens }),
					cost: limits.cost,
					outputBytes: 1024,
					workspaceWriteBytes: 0,
					retries: 0,
					resumes: 0,
				},
			},
			identitySha256: SHA,
		},
		definitionIdentitySha256: SHA,
		materializationSequence: sequence,
		materializationEpoch: 1,
		epochPosition: sequence,
	};
}

function nestedTask(
	key: string,
	sequence: number,
	budget: WorkflowBudget,
): MaterializedNestedWorkflowTask {
	return {
		id: `task_${key}`,
		runId: RUN_ID,
		namespace: [],
		spec: {
			key,
			kind: "workflow",
			role: "task",
			disposition: "required",
			after: [],
			inputs: {},
			replay: "auto",
			request: {
				definitionName: "child",
				definitionIdentitySha256: SHA,
				definitionSourceSha256: SHA,
				definitionVersion: 1,
				input: {},
				inputSha256: SHA,
				inputSchema: { type: "object" },
				outputSchema: { type: "object" },
				budget,
				timeoutMs: 600_000,
				concurrency: 2,
			},
			identitySha256: SHA,
		},
		definitionIdentitySha256: SHA,
		materializationSequence: sequence,
		materializationEpoch: 1,
		epochPosition: sequence,
	};
}

interface UsageShape {
	readonly cost: number;
	readonly totalTokens: number;
	readonly runtimeMs: number;
	readonly usageComplete?: boolean;
	readonly attemptOrdinal?: number;
}

function evidence(shape: UsageShape): SubagentTerminalEvidence {
	return {
		kind: "subagent",
		attemptOrdinal: shape.attemptOrdinal ?? 1,
		resultSha256: SHA,
		status: "completed",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: shape.totalTokens,
			cost: shape.cost,
		},
		usageComplete: shape.usageComplete ?? true,
		runtimeMs: shape.runtimeMs,
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
	};
}

function agentExecution(
	task: MaterializedAgentTask,
	generation: number,
	shape: {
		receipt?: boolean;
		settlements?: readonly UsageShape[];
	},
): TaskExecutionProjection {
	const id = deriveTaskExecutionId(RUN_ID, task.id, generation);
	const operationId = deriveSubagentOperationId(RUN_ID, task.id, generation);
	const settlements = (shape.settlements ?? []).map((usage, index) => ({
		evidence: evidence({ ...usage, attemptOrdinal: index + 1 }),
		sequence: 100 * generation + 2 + index,
	}));
	const current = settlements.at(-1);
	return {
		execution: {
			kind: "agent",
			id,
			runId: RUN_ID,
			taskId: task.id,
			generation,
			taskIdentitySha256: SHA,
			operationId,
		},
		phase: current
			? "terminal"
			: shape.receipt === false
				? "created"
				: "launched",
		createdSequence: 100 * generation,
		...(shape.receipt === false
			? {}
			: {
					launchReceipt: {
						operationId,
						subagentRunId: `run_child${generation}`,
						subagentAttemptId: `attempt_child${generation}`,
						status: "active",
						sequence: 100 * generation + 1,
					},
				}),
		...(current
			? {
					settlement: current,
					...(settlements.length > 1
						? { priorSettlements: settlements.slice(0, -1) }
						: {}),
					terminal: {
						outcome: "completed",
						evidence: current.evidence,
						sequence: 100 * generation + 50,
					},
				}
			: {}),
	};
}

function nestedExecution(
	task: MaterializedNestedWorkflowTask,
	shape: {
		launched?: boolean;
		settled?: {
			cost: number;
			totalTokens: number;
			childRuntimeMs: number;
			usageComplete?: boolean;
		};
	},
): TaskExecutionProjection {
	const id = deriveTaskExecutionId(RUN_ID, task.id, 1);
	const childRunId = deriveNestedWorkflowRunId(RUN_ID, task.id, 1);
	return {
		execution: {
			kind: "workflow",
			id,
			runId: RUN_ID,
			taskId: task.id,
			generation: 1,
			taskIdentitySha256: SHA,
			childRunId,
		},
		phase: shape.settled
			? "nested-settled"
			: shape.launched === false
				? "nested-intended"
				: "nested-launched",
		createdSequence: 200,
		nestedIntent: {
			childRunId,
			definitionIdentitySha256: SHA,
			inputSha256: SHA,
			inputsSha256: SHA,
			resolvedInputSha256: SHA,
			budget: task.spec.request.budget,
			timeoutMs: 600_000,
			deadlineAt: "2099-01-01T00:00:00.000Z",
			concurrency: 2,
			sequence: 201,
		},
		...(shape.launched === false
			? {}
			: { nestedLaunch: { childRunId, sequence: 202 } }),
		...(shape.settled
			? {
					nestedSettlement: {
						childRunId,
						status: "completed",
						usage: {
							cost: shape.settled.cost,
							totalTokens: shape.settled.totalTokens,
							childRuntimeMs: shape.settled.childRuntimeMs,
						},
						usageComplete: shape.settled.usageComplete ?? true,
						sequence: 203,
					},
				}
			: {}),
	};
}

function stateOf(
	entries: readonly {
		task: MaterializedAgentTask | MaterializedNestedWorkflowTask;
		status: WorkflowTaskStatus;
		executions: readonly TaskExecutionProjection[];
	}[],
): WorkflowStateProjection {
	const tasks: WorkflowStateProjection["tasks"] = {};
	const executions: WorkflowStateProjection["executions"] = {};
	for (const entry of entries) {
		const current = entry.executions.at(-1);
		tasks[entry.task.id] = {
			task: entry.task,
			status: entry.status,
			committed: false,
			...(current ? { currentExecutionId: current.execution.id } : {}),
		};
		for (const execution of entry.executions) {
			executions[execution.execution.id] = execution;
		}
	}
	return {
		runId: RUN_ID,
		definitionIdentitySha256: SHA,
		inputSha256: SHA,
		status: "running",
		currentEpoch: 1,
		effects: [],
		lastSequence: 999,
		tasks,
		executions,
		artifacts: {},
		barriers: [],
	};
}

const BUDGET: WorkflowBudget = {
	cost: 1,
	totalTokens: 10_000,
	childRuntimeMs: 60_000,
};

// ---------------------------------------------------------------------------
// settledWorkflowUsage
// ---------------------------------------------------------------------------

describe("settledWorkflowUsage", () => {
	it("is empty and complete for a state without settlements", () => {
		const pending = agentTask("pending", 1, {
			cost: 0.5,
			totalTokens: 100,
			cumulativeRuntimeMs: 1_000,
		});
		const state = stateOf([
			{ task: pending, status: "pending", executions: [] },
		]);
		expect(settledWorkflowUsage(state)).toMatchObject({
			cost: 0,
			totalTokens: 0,
			childRuntimeMs: 0,
			usageComplete: true,
		});
	});

	it("sums every attempt of every generation and every nested settlement", () => {
		const retried = agentTask("retried", 1, {
			cost: 1,
			totalTokens: 100,
			cumulativeRuntimeMs: 1_000,
		});
		const regenerated = agentTask("regenerated", 2, {
			cost: 1,
			totalTokens: 100,
			cumulativeRuntimeMs: 1_000,
		});
		const child = nestedTask("child", 3, { cost: 0.5, childRuntimeMs: 5_000 });
		const active = agentTask("active", 4, {
			cost: 1,
			totalTokens: 100,
			cumulativeRuntimeMs: 1_000,
		});
		const generation1 = agentExecution(regenerated, 1, {
			settlements: [{ cost: 0.04, totalTokens: 40, runtimeMs: 400 }],
		});
		const generation2 = agentExecution(regenerated, 2, {
			settlements: [{ cost: 0.08, totalTokens: 80, runtimeMs: 800 }],
		});
		const state = stateOf([
			{
				task: retried,
				status: "completed",
				executions: [
					agentExecution(retried, 1, {
						settlements: [
							{ cost: 0.01, totalTokens: 10, runtimeMs: 100 },
							{ cost: 0.02, totalTokens: 20, runtimeMs: 200 },
						],
					}),
				],
			},
			{
				task: regenerated,
				status: "completed",
				executions: [generation1, generation2],
			},
			{
				task: child,
				status: "completed",
				executions: [
					nestedExecution(child, {
						settled: { cost: 0.16, totalTokens: 160, childRuntimeMs: 1_600 },
					}),
				],
			},
			{
				task: active,
				status: "running",
				executions: [agentExecution(active, 1, {})],
			},
		]);
		const settled = settledWorkflowUsage(state);
		expect(settled.cost).toBeCloseTo(0.31, 10);
		expect(settled.totalTokens).toBe(310);
		expect(settled.childRuntimeMs).toBe(3_100);
		expect(settled.usageComplete).toBe(true);
		// Per-execution agent contributions match the shared attempt summation.
		const agentSum = Object.values(state.executions)
			.filter((execution) => execution.settlement)
			.map(settledAgentUsage)
			.reduce((sum, usage) => sum + usage.cost, 0);
		expect(settled.cost).toBeCloseTo(agentSum + 0.16, 10);
	});

	it("reports incomplete agent evidence", () => {
		const partial = agentTask("partial", 1, {
			cost: 1,
			totalTokens: 100,
			cumulativeRuntimeMs: 1_000,
		});
		const state = stateOf([
			{
				task: partial,
				status: "completed",
				executions: [
					agentExecution(partial, 1, {
						settlements: [
							{
								cost: 0.01,
								totalTokens: 10,
								runtimeMs: 100,
								usageComplete: false,
							},
						],
					}),
				],
			},
		]);
		const settled = settledWorkflowUsage(state);
		expect(settled.usageComplete).toBe(false);
		expect(budgetExceededReason(settled, BUDGET)).toBe(
			"Workflow child usage evidence is incomplete.",
		);
	});

	it("reports incomplete nested evidence", () => {
		const child = nestedTask("child", 1, { cost: 0.5, childRuntimeMs: 5_000 });
		const state = stateOf([
			{
				task: child,
				status: "completed",
				executions: [
					nestedExecution(child, {
						settled: {
							cost: 0.1,
							totalTokens: 10,
							childRuntimeMs: 100,
							usageComplete: false,
						},
					}),
				],
			},
		]);
		const settled = settledWorkflowUsage(state);
		expect(settled.usageComplete).toBe(false);
		expect(budgetExceededReason(settled, BUDGET)).toBe(
			"Nested workflow usage evidence is incomplete.",
		);
	});

	it("marks usage incomplete when any prior attempt was incomplete", () => {
		const retried = agentTask("retried", 1, {
			cost: 1,
			totalTokens: 100,
			cumulativeRuntimeMs: 1_000,
		});
		const state = stateOf([
			{
				task: retried,
				status: "completed",
				executions: [
					agentExecution(retried, 1, {
						settlements: [
							{
								cost: 0.01,
								totalTokens: 10,
								runtimeMs: 100,
								usageComplete: false,
							},
							{ cost: 0.02, totalTokens: 20, runtimeMs: 200 },
						],
					}),
				],
			},
		]);
		expect(settledWorkflowUsage(state).usageComplete).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// reservedWorkflowUsage
// ---------------------------------------------------------------------------

describe("reservedWorkflowUsage", () => {
	it("reserves declared maxima of launched, unsettled agent and nested executions only", () => {
		const launched = agentTask("launched", 1, {
			cost: 0.25,
			totalTokens: 2_500,
			cumulativeRuntimeMs: 25_000,
		});
		const created = agentTask("created", 2, {
			cost: 0.5,
			totalTokens: 5_000,
			cumulativeRuntimeMs: 50_000,
		});
		const settled = agentTask("settled", 3, {
			cost: 0.5,
			totalTokens: 5_000,
			cumulativeRuntimeMs: 50_000,
		});
		const launchedChild = nestedTask("launchedchild", 4, {
			cost: 0.125,
			totalTokens: 1_250,
			childRuntimeMs: 12_500,
		});
		const intendedChild = nestedTask("intendedchild", 5, {
			cost: 0.5,
			totalTokens: 5_000,
			childRuntimeMs: 50_000,
		});
		const settledChild = nestedTask("settledchild", 6, {
			cost: 0.5,
			totalTokens: 5_000,
			childRuntimeMs: 50_000,
		});
		const state = stateOf([
			{
				task: launched,
				status: "running",
				executions: [agentExecution(launched, 1, {})],
			},
			{
				task: created,
				status: "ready",
				executions: [agentExecution(created, 1, { receipt: false })],
			},
			{
				task: settled,
				status: "completed",
				executions: [
					agentExecution(settled, 1, {
						settlements: [{ cost: 0.01, totalTokens: 10, runtimeMs: 100 }],
					}),
				],
			},
			{
				task: launchedChild,
				status: "running",
				executions: [nestedExecution(launchedChild, {})],
			},
			{
				task: intendedChild,
				status: "running",
				executions: [nestedExecution(intendedChild, { launched: false })],
			},
			{
				task: settledChild,
				status: "completed",
				executions: [
					nestedExecution(settledChild, {
						settled: { cost: 0.02, totalTokens: 20, childRuntimeMs: 200 },
					}),
				],
			},
		]);
		const reserved = reservedWorkflowUsage(state, BUDGET);
		expect(reserved.cost).toBeCloseTo(0.375, 10);
		expect(reserved.totalTokens).toBe(3_750);
		expect(reserved.childRuntimeMs).toBe(37_500);
	});

	it("reserves zero tokens for a task without a token maximum under an unbounded budget", () => {
		const launched = agentTask("launched", 1, {
			cost: 0.25,
			cumulativeRuntimeMs: 25_000,
		});
		const state = stateOf([
			{
				task: launched,
				status: "running",
				executions: [agentExecution(launched, 1, {})],
			},
		]);
		expect(
			reservedWorkflowUsage(state, { cost: 1, childRuntimeMs: 60_000 }),
		).toMatchObject({ cost: 0.25, totalTokens: 0, childRuntimeMs: 25_000 });
	});

	it("reserves nothing for a state without launched work", () => {
		const pending = agentTask("pending", 1, {
			cost: 0.25,
			totalTokens: 100,
			cumulativeRuntimeMs: 25_000,
		});
		expect(
			reservedWorkflowUsage(
				stateOf([{ task: pending, status: "pending", executions: [] }]),
				BUDGET,
			),
		).toMatchObject({ cost: 0, totalTokens: 0, childRuntimeMs: 0 });
	});
});

// ---------------------------------------------------------------------------
// budgetExceededReason
// ---------------------------------------------------------------------------

describe("budgetExceededReason", () => {
	const complete = (
		cost: number,
		totalTokens: number,
		childRuntimeMs: number,
	) => ({
		cost,
		totalTokens,
		childRuntimeMs,
		usageComplete: true,
	});

	it("is undefined when settled usage fits the effective budget exactly", () => {
		expect(budgetExceededReason(complete(1, 10_000, 60_000), BUDGET)).toBe(
			undefined,
		);
		expect(budgetExceededReason(complete(0, 0, 0), BUDGET)).toBeUndefined();
	});

	it("checks cost, then total tokens, then child runtime", () => {
		expect(
			budgetExceededReason(complete(1.000001, 20_000, 120_000), BUDGET),
		).toBe("Workflow cost budget was exceeded.");
		expect(budgetExceededReason(complete(1, 10_001, 120_000), BUDGET)).toBe(
			"Workflow total-token budget was exceeded.",
		);
		expect(budgetExceededReason(complete(1, 10_000, 60_001), BUDGET)).toBe(
			"Workflow child-runtime budget was exceeded.",
		);
	});

	it("ignores total tokens when the budget declares no token bound", () => {
		expect(
			budgetExceededReason(complete(0.5, 999_999_999, 1_000), {
				cost: 1,
				childRuntimeMs: 60_000,
			}),
		).toBeUndefined();
	});

	it("reports incomplete evidence before any overshoot", () => {
		expect(
			budgetExceededReason(
				{ cost: 5, totalTokens: 5, childRuntimeMs: 5, usageComplete: false },
				BUDGET,
			),
		).toMatch(/usage evidence is incomplete\.$/);
	});
});

// ---------------------------------------------------------------------------
// Oracle: the scheduler's own admission decision on a real run
// ---------------------------------------------------------------------------

function root(name: string): string {
	return path.resolve(".pi", "test-budget", `${name}-${randomUUID()}`);
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

interface AttemptWorkflowOptions {
	readonly retry?: { attempts: number };
	readonly budgetCost?: number;
	readonly limitCost?: number;
}

async function attemptWorkflowFixture(options: AttemptWorkflowOptions = {}) {
	const base = root("attempts");
	const cwd = path.join(base, "project");
	const agentDir = path.join(base, "agent");
	const storeRoot = path.join(cwd, ".pi", "workflow");
	await mkdir(path.join(cwd, "workflows"), { recursive: true });
	const definitionPath = path.join(cwd, "workflows", "attempts.workflow.ts");
	const policies = options.retry
		? `retry: ${JSON.stringify(options.retry)},`
		: "";
	await writeFile(
		definitionPath,
		`export default {
  schema: "pi-workflow-definition",
  meta: { name: "attempts", description: "Attempt policy workflow", version: 1, budget: { cost: ${options.budgetCost ?? 1000}, childRuntimeMs: 3600000 }, timeoutMs: 3600000, concurrency: 4 },
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
      limits: { cumulativeRuntimeMs: 300000, attemptTimeoutMs: 300000, totalTokens: 1000000, cost: ${options.limitCost ?? 10}, outputBytes: 1024, workspaceWriteBytes: 0, retries: ${options.retry?.attempts ?? 0}, resumes: 0 }
    });
  }
};\n`,
	);
	return { cwd, agentDir, storeRoot, definitionPath };
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

/** Owner client whose successive `wait` calls return `outcomes` in order. */
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
			preflightId: "preflight-budget",
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
	} as unknown as SubagentClient;
	const bind = vi.fn(async (runId: string) => {
		taskOwnerId = `pi-workflow:${runId}`;
		return {
			workflowRunId: runId,
			ownerId: taskOwnerId,
			client: ownerClient,
		} satisfies WorkflowSubagentBinding;
	});
	return { provider: { bind } as WorkflowSubagentProvider, ownerClient };
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

async function journalEvents(
	storeRoot: string,
	runId: string,
): Promise<WorkflowJournalEvent[]> {
	const journal = await readFile(
		path.join(storeRoot, "runs", runId, "events.jsonl"),
		"utf8",
	);
	const complete = journal.endsWith("\n")
		? journal
		: journal.slice(0, journal.lastIndexOf("\n") + 1);
	return complete
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as WorkflowJournalEvent);
}

async function runRecord(storeRoot: string, runId: string) {
	return JSON.parse(
		await readFile(path.join(storeRoot, "runs", runId, "service.json"), "utf8"),
	) as WorkflowRunRecord;
}

describe("budget extraction matches the scheduler's decision", () => {
	it("names the same exceeded reason the scheduler journaled after two charged attempts", async () => {
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
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({ status: "failed" });
			const events = await journalEvents(fixture.storeRoot, receipt.runId);
			const journaled = events
				.filter((event) => event.type === "run-status-changed")
				.map((event) => (event.data as { reason?: string }).reason)
				.find((reason) => reason?.endsWith("was exceeded."));
			expect(journaled).toBe("Workflow cost budget was exceeded.");
			const state = reduceWorkflowEvents(events);
			const record = await runRecord(fixture.storeRoot, receipt.runId);
			const settled = settledWorkflowUsage(state);
			expect(settled.cost).toBeCloseTo(0.02, 10);
			expect(settled.totalTokens).toBe(4);
			expect(settled.childRuntimeMs).toBe(20);
			expect(settled.usageComplete).toBe(true);
			expect(budgetExceededReason(settled, record.effectiveBudget)).toBe(
				journaled,
			);
			// Nothing is still launched, so nothing is reserved.
			expect(
				reservedWorkflowUsage(state, record.effectiveBudget),
			).toMatchObject({ cost: 0, totalTokens: 0, childRuntimeMs: 0 });
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("finds no exceeded reason for a run the scheduler completed within budget", async () => {
		const fixture = await attemptWorkflowFixture({
			retry: { attempts: 1 },
			budgetCost: 0.03,
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
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({ status: "completed" });
			const events = await journalEvents(fixture.storeRoot, receipt.runId);
			const reasons = events
				.filter((event) => event.type === "run-status-changed")
				.map((event) => (event.data as { reason?: string }).reason);
			expect(reasons.some((reason) => reason?.includes("budget"))).toBe(false);
			const state = reduceWorkflowEvents(events);
			const record = await runRecord(fixture.storeRoot, receipt.runId);
			const settled = settledWorkflowUsage(state);
			expect(settled.cost).toBeCloseTo(0.02, 10);
			expect(budgetExceededReason(settled, record.effectiveBudget)).toBe(
				undefined,
			);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});
});
