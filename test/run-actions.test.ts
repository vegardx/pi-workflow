import { describe, expect, it } from "vitest";
import type {
	MaterializedAgentTask,
	MaterializedCheckpointTask,
	MaterializedSupportTask,
	MaterializedWorkflowTask,
	SubagentTerminalEvidence,
	WorkflowRunStatus,
	WorkflowTaskId,
	WorkflowTaskStatus,
} from "../src/contracts.js";
import type {
	TaskExecutionProjection,
	WorkflowBarrierProjection,
	WorkflowStateProjection,
} from "../src/events.js";
import {
	deriveSubagentOperationId,
	deriveTaskExecutionId,
} from "../src/execution.js";
import {
	admitsInvalidation,
	availableWorkflowRunActions,
	awaitsRecovery,
	deadlinePassed,
	hasOpenOperatorIntent,
	IMPLEMENTED_WORKFLOW_RUN_ACTIONS,
	isNestedRun,
	isReopenedTask,
	isTerminalWorkflowRunStatus,
	pendingCheckpoints,
	requiresAttention,
	resumableTasks,
	resumeRefusal,
	retryableTasks,
	runActionFacts,
	WORKFLOW_RUN_ACTIONS,
	type WorkflowRunAction,
	type WorkflowRunActionFacts,
	type WorkflowRunOwnership,
} from "../src/run-actions.js";
import type { WorkflowRunRecord } from "../src/run-record.js";

// ---------------------------------------------------------------------------
// Fixture builders: hand-built projections shaped exactly like the reducer's.
// ---------------------------------------------------------------------------

const RUN_ID = "workflow_runactionsfixture";
const SHA = "a".repeat(64);
const RUN_STATUSES: readonly WorkflowRunStatus[] = [
	"created",
	"running",
	"waiting",
	"finalizing",
	"stopping",
	"completed",
	"completed-degraded",
	"failed",
	"cancelled",
	"interrupted",
	"cleanup-blocked",
];
const TERMINAL: ReadonlySet<WorkflowRunStatus> = new Set([
	"completed",
	"completed-degraded",
	"failed",
	"cancelled",
	"interrupted",
	"cleanup-blocked",
]);

function agentTask(
	key: string,
	sequence: number,
	options: { after?: readonly WorkflowTaskId[] } = {},
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
			after: (options.after ?? []).map((taskId) => ({ runId: RUN_ID, taskId })),
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
			identitySha256: SHA,
		},
		definitionIdentitySha256: SHA,
		materializationSequence: sequence,
		materializationEpoch: 1,
		epochPosition: sequence,
	};
}

function supportTask(key: string, sequence: number): MaterializedSupportTask {
	return {
		id: `task_${key}`,
		runId: RUN_ID,
		namespace: [],
		spec: {
			key,
			kind: "support",
			role: "task",
			disposition: "required",
			after: [],
			inputs: {},
			replay: "auto",
			request: {
				implementation: {
					name: "tools/echo",
					moduleSpecifier: "tools",
					revision: 1,
					implementationSha256: SHA,
					parametersSchema: { type: "object" },
					outputSchema: { type: "object" },
				},
				parameters: {},
			},
			identitySha256: SHA,
		},
		definitionIdentitySha256: SHA,
		materializationSequence: sequence,
		materializationEpoch: 1,
		epochPosition: sequence,
	};
}

function checkpointTask(
	key: string,
	sequence: number,
	options: { timeoutMs?: number } = {},
): MaterializedCheckpointTask {
	return {
		id: `task_${key}`,
		runId: RUN_ID,
		namespace: [],
		spec: {
			key,
			kind: "checkpoint",
			role: "task",
			disposition: "required",
			after: [],
			inputs: {},
			replay: "read-only",
			request: {
				schema: { type: "object" },
				prompt: "Approve?",
				headless: "block",
				...(options.timeoutMs === undefined
					? {}
					: { timeoutMs: options.timeoutMs }),
			},
			identitySha256: SHA,
		},
		definitionIdentitySha256: SHA,
		materializationSequence: sequence,
		materializationEpoch: 1,
		epochPosition: sequence,
	};
}

type CheckpointShape =
	| "created"
	| "requested"
	| "decided"
	| "completed"
	| "expired"
	| "cancelled";

/** A checkpoint execution at each phase of the checkpoint ladder. */
function checkpointExecution(
	task: MaterializedWorkflowTask,
	generation: number,
	shape: CheckpointShape,
): TaskExecutionProjection {
	const id = deriveTaskExecutionId(RUN_ID, task.id, generation);
	const base: TaskExecutionProjection = {
		execution: {
			kind: "checkpoint",
			id,
			runId: RUN_ID,
			taskId: task.id,
			generation,
			taskIdentitySha256: SHA,
		},
		phase: "created",
		createdSequence: 10 * generation,
	};
	if (shape === "created") return base;
	const requested: TaskExecutionProjection = {
		...base,
		phase: "checkpoint-requested",
		checkpointRequest: {
			inputsSha256: SHA,
			expiresAt: "2099-01-01T01:00:00.000Z",
			requestedAt: "2026-09-15T12:00:00.000Z",
			sequence: 10 * generation + 1,
		},
	};
	if (shape === "requested") return requested;
	if (shape === "expired" || shape === "cancelled") {
		return {
			...requested,
			phase: "terminal",
			terminal: {
				outcome: shape === "expired" ? "failed" : "cancelled",
				evidence: {
					kind: "workflow",
					stage: shape === "expired" ? "checkpoint-expired" : "stop",
					failureSha256: SHA,
					message:
						shape === "expired"
							? "Checkpoint expired without a decision."
							: "Workflow stop requested.",
				},
				sequence: 10 * generation + 2,
			},
		};
	}
	const decided: TaskExecutionProjection = {
		...requested,
		phase: "checkpoint-decided",
		checkpointDecision: {
			artifactId: `artifact_${SHA}`,
			decisionSha256: SHA,
			source: "operator",
			decidedBy: "vegard",
			decidedAt: "2026-09-15T12:01:00.000Z",
			sequence: 10 * generation + 2,
		},
	};
	if (shape === "decided") return decided;
	return {
		...decided,
		phase: "terminal",
		terminal: {
			outcome: "completed",
			evidence: {
				kind: "checkpoint",
				artifactId: `artifact_${SHA}`,
				decisionSha256: SHA,
				source: "operator",
				decidedBy: "vegard",
			},
			sequence: 10 * generation + 3,
		},
	};
}

function evidence(
	status: SubagentTerminalEvidence["status"],
	failure?: SubagentTerminalEvidence["failure"],
): SubagentTerminalEvidence {
	return {
		kind: "subagent",
		attemptOrdinal: 1,
		resultSha256: SHA,
		status,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: 0.01,
		},
		usageComplete: true,
		runtimeMs: 10,
		...(failure ? { failure } : {}),
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
	};
}

type AgentOutcome = "completed" | "failed" | "interrupted" | "cleanup-blocked";

function agentExecution(
	task: MaterializedWorkflowTask,
	generation: number,
	shape: {
		outcome?: AgentOutcome;
		failureRetry?: "never" | "manual" | "backoff" | "resume";
		attempts?: number;
	} = {},
): TaskExecutionProjection {
	const id = deriveTaskExecutionId(RUN_ID, task.id, generation);
	const base: TaskExecutionProjection = {
		execution: {
			kind: "agent",
			id,
			runId: RUN_ID,
			taskId: task.id,
			generation,
			taskIdentitySha256: SHA,
			operationId: deriveSubagentOperationId(RUN_ID, task.id, generation),
		},
		phase: "launched",
		createdSequence: 10 * generation,
		launchReceipt: {
			operationId: deriveSubagentOperationId(RUN_ID, task.id, generation),
			subagentRunId: `run_child${generation}`,
			subagentAttemptId: `attempt_child${generation}`,
			status: "active",
			sequence: 10 * generation + 1,
		},
	};
	if (!shape.outcome) return base;
	const failure =
		shape.outcome === "completed"
			? undefined
			: {
					code: "provider-transient" as const,
					origin: "provider" as const,
					retry: shape.failureRetry ?? ("never" as const),
					message: "provider hiccup",
					guidance: "Try again later.",
				};
	const settled = evidence(shape.outcome, failure);
	return {
		...base,
		phase: "terminal",
		settlement: { evidence: settled, sequence: 10 * generation + 2 },
		...(shape.attempts
			? {
					attempts: Array.from({ length: shape.attempts }, (_, index) => ({
						kind: "resume" as const,
						ordinal: index + 2,
						previousAttemptId: `attempt_child${generation}`,
						origin: "policy" as const,
						subagentAttemptId: `attempt_child${generation}x${index + 2}`,
						status: "interrupted" as const,
						intentSequence: 10 * generation + 3,
						receiptSequence: 10 * generation + 4,
					})),
				}
			: {}),
		terminal: {
			outcome: shape.outcome,
			evidence: settled,
			sequence: 10 * generation + 5,
		},
	};
}

/** An interrupted execution reopened by an operator resume intent that is still open. */
function reopenedExecution(
	task: MaterializedWorkflowTask,
): TaskExecutionProjection {
	const settled = agentExecution(task, 1, {
		outcome: "interrupted",
		failureRetry: "resume",
	});
	const { terminal: _terminal, ...reopened } = settled;
	return {
		...reopened,
		phase: "attempt-intended",
		attempts: [
			{
				kind: "resume",
				ordinal: 2,
				previousAttemptId: "attempt_child1",
				origin: "operator",
				reason: "Operator resumed the seat.",
				intentSequence: 60,
			},
		],
	};
}

interface TaskEntry {
	readonly task: MaterializedWorkflowTask;
	readonly status: WorkflowTaskStatus;
	readonly execution?: TaskExecutionProjection;
	readonly abandoned?: true;
}

function stateOf(
	status: WorkflowRunStatus,
	entries: readonly TaskEntry[],
	barriers: readonly WorkflowBarrierProjection[] = [],
): WorkflowStateProjection {
	const tasks: WorkflowStateProjection["tasks"] = {};
	const executions: WorkflowStateProjection["executions"] = {};
	for (const entry of entries) {
		tasks[entry.task.id] = {
			task: entry.task,
			status: entry.status,
			committed: false,
			...(entry.execution
				? { currentExecutionId: entry.execution.execution.id }
				: {}),
			...(entry.abandoned ? { abandoned: true } : {}),
		};
		if (entry.execution)
			executions[entry.execution.execution.id] = entry.execution;
	}
	return {
		runId: RUN_ID,
		definitionIdentitySha256: SHA,
		inputSha256: SHA,
		status,
		currentEpoch: 1,
		effects: [],
		lastSequence: 99,
		tasks,
		executions,
		artifacts: {},
		barriers: [...barriers],
	};
}

function facts(
	overrides: Partial<WorkflowRunActionFacts> = {},
): WorkflowRunActionFacts {
	return {
		status: "running",
		ownership: "inactive",
		driving: false,
		nested: false,
		deadlinePassed: false,
		awaitsRecovery: false,
		hasCleanupBlockedTask: false,
		retryableTaskCount: 0,
		resumableTaskCount: 0,
		pendingCheckpointCount: 0,
		...overrides,
	};
}

const rootRecord: Pick<WorkflowRunRecord, "deadlineAt" | "parent"> = {
	deadlineAt: "2099-01-01T00:00:00.000Z",
};
const nestedRecord = {
	deadlineAt: "2099-01-01T00:00:00.000Z",
	parent: {
		runId: "workflow_parentrun",
		taskId: "task_parent",
		executionId: deriveTaskExecutionId("workflow_parentrun", "task_parent", 1),
		ancestorDefinitionIdentities: [SHA],
		inputArtifacts: {},
	},
};

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

describe("run action predicates", () => {
	it("exposes the seven-action vocabulary and the implemented gate", () => {
		expect([...WORKFLOW_RUN_ACTIONS]).toEqual([
			"stop",
			"wait",
			"reconcile",
			"invalidate",
			"retry",
			"resume",
			"decide",
		]);
		expect(Object.isFrozen(WORKFLOW_RUN_ACTIONS)).toBe(true);
		expect([...IMPLEMENTED_WORKFLOW_RUN_ACTIONS].sort()).toEqual([
			"decide",
			"invalidate",
			"reconcile",
			"resume",
			"retry",
			"stop",
			"wait",
		]);
	});

	it("classifies exactly the six terminal run statuses", () => {
		for (const status of RUN_STATUSES) {
			expect(isTerminalWorkflowRunStatus(status), status).toBe(
				TERMINAL.has(status),
			);
		}
	});

	it("admits invalidation only for failed and interrupted runs", () => {
		for (const status of RUN_STATUSES) {
			expect(admitsInvalidation(status), status).toBe(
				status === "failed" || status === "interrupted",
			);
		}
	});

	it("detects awaited recovery from an on-path invalidated task", () => {
		expect(
			awaitsRecovery({
				status: "failed",
				tasks: [{ status: "invalidated" }],
			}),
		).toBe(true);
		expect(
			awaitsRecovery({
				status: "interrupted",
				tasks: [{ status: "completed" }, { status: "invalidated" }],
			}),
		).toBe(true);
		expect(
			awaitsRecovery({
				status: "failed",
				tasks: [{ status: "invalidated", abandoned: true }],
			}),
		).toBe(false);
		expect(
			awaitsRecovery({ status: "failed", tasks: [{ status: "failed" }] }),
		).toBe(false);
		expect(awaitsRecovery({ status: "failed" })).toBe(false);
		for (const status of RUN_STATUSES) {
			if (status === "failed" || status === "interrupted") continue;
			expect(
				awaitsRecovery({ status, tasks: [{ status: "invalidated" }] }),
				status,
			).toBe(false);
		}
	});

	it("detects awaited recovery from an open operator resume intent", () => {
		const task = agentTask("reopened", 1);
		const reopened = reopenedExecution(task);
		const intent = reopened.attempts?.[0];
		if (!intent) throw new Error("reopened execution has no intent");
		const open = stateOf("interrupted", [
			{ task, status: "interrupted", execution: reopened },
		]);
		expect(hasOpenOperatorIntent(open)).toBe(true);
		expect(awaitsRecovery(open)).toBe(true);
		expect(isReopenedTask(open, open.tasks[task.id] as never)).toBe(true);
		// A run view carries no executions and cannot expose the intent.
		expect(
			awaitsRecovery({
				status: "interrupted",
				tasks: [{ status: "interrupted" }],
			}),
		).toBe(false);
		// Only an interrupted run reopens on an operator intent.
		expect(awaitsRecovery({ ...open, status: "failed" })).toBe(false);
		// A receipted or declined intent is no longer open, but the task stays
		// reopened until its execution terminalizes again.
		for (const closed of [
			{ receiptSequence: 61 },
			{ declinedSequence: 61 },
		] as const) {
			const execution: TaskExecutionProjection = {
				...reopened,
				phase: "receiptSequence" in closed ? "launched" : "settled",
				attempts: [{ ...intent, ...closed }],
			};
			const state = stateOf("interrupted", [
				{ task, status: "interrupted", execution },
			]);
			expect(hasOpenOperatorIntent(state)).toBe(false);
			expect(awaitsRecovery(state)).toBe(false);
			expect(isReopenedTask(state, state.tasks[task.id] as never)).toBe(true);
		}
		// A policy intent never counts as operator recovery.
		const policy = stateOf("interrupted", [
			{
				task,
				status: "interrupted",
				execution: {
					...reopened,
					attempts: [{ ...intent, origin: "policy" }],
				},
			},
		]);
		expect(hasOpenOperatorIntent(policy)).toBe(false);
		// An abandoned task's intent is history.
		const abandoned = stateOf("interrupted", [
			{ task, status: "interrupted", execution: reopened, abandoned: true },
		]);
		expect(hasOpenOperatorIntent(abandoned)).toBe(false);
		expect(isReopenedTask(abandoned, abandoned.tasks[task.id] as never)).toBe(
			false,
		);
		// Terminal interrupted evidence is settled, not reopened.
		const terminal = stateOf("interrupted", [
			{
				task,
				status: "interrupted",
				execution: agentExecution(task, 1, {
					outcome: "interrupted",
					failureRetry: "resume",
				}),
			},
		]);
		expect(isReopenedTask(terminal, terminal.tasks[task.id] as never)).toBe(
			false,
		);
	});

	it("treats a deadline at or before now as passed", () => {
		const now = Date.parse("2026-09-15T12:00:00.000Z");
		expect(deadlinePassed("2026-09-15T12:00:00.000Z", now)).toBe(true);
		expect(deadlinePassed("2026-09-15T11:59:59.999Z", now)).toBe(true);
		expect(deadlinePassed("2026-09-15T12:00:00.001Z", now)).toBe(false);
	});

	it("recognizes nested runs by their parent lineage", () => {
		expect(isNestedRun(nestedRecord)).toBe(true);
		expect(isNestedRun(rootRecord)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Task-level cause sets
// ---------------------------------------------------------------------------

describe("retryable and resumable task sets", () => {
	it("lists on-path tasks whose current execution ended failed or interrupted", () => {
		const failed = agentTask("failed", 1);
		const interrupted = agentTask("interrupted", 2);
		const completed = agentTask("completed", 3);
		const pending = agentTask("pending", 4);
		const abandoned = agentTask("abandoned", 5);
		const state = stateOf("failed", [
			{
				task: interrupted,
				status: "interrupted",
				execution: agentExecution(interrupted, 1, {
					outcome: "interrupted",
					failureRetry: "resume",
				}),
			},
			{
				task: failed,
				status: "failed",
				execution: agentExecution(failed, 2, { outcome: "failed" }),
			},
			{
				task: completed,
				status: "completed",
				execution: agentExecution(completed, 1, { outcome: "completed" }),
			},
			{ task: pending, status: "pending" },
			{
				task: abandoned,
				status: "failed",
				abandoned: true,
				execution: agentExecution(abandoned, 1, { outcome: "failed" }),
			},
		]);
		expect(retryableTasks(state)).toEqual([failed.id, interrupted.id]);
		expect(Object.isFrozen(retryableTasks(state))).toBe(true);
		expect(resumableTasks(state)).toEqual([interrupted.id]);
	});

	it("does not treat a launched or merely settled execution as retryable", () => {
		const launched = agentTask("launched", 1);
		const settled = agentTask("settled", 2);
		const settledExecution: TaskExecutionProjection = {
			...agentExecution(settled, 1, { outcome: "failed" }),
			phase: "settled",
		};
		delete (settledExecution as { terminal?: unknown }).terminal;
		const state = stateOf("running", [
			{
				task: launched,
				status: "running",
				execution: agentExecution(launched, 1),
			},
			{ task: settled, status: "running", execution: settledExecution },
		]);
		expect(retryableTasks(state)).toEqual([]);
		expect(resumableTasks(state)).toEqual([]);
	});

	it("returns the first applicable resume refusal in the specified order", () => {
		const support = supportTask("support", 1);
		const failed = agentTask("failed", 2);
		const interruptedNever = agentTask("never", 3);
		const resumable = agentTask("resumable", 4);
		const exhausted = agentTask("exhausted", 5);
		const abandoned = agentTask("abandoned", 6);
		const state = stateOf("interrupted", [
			{ task: support, status: "completed" },
			{
				task: failed,
				status: "failed",
				execution: agentExecution(failed, 1, { outcome: "failed" }),
			},
			{
				task: interruptedNever,
				status: "interrupted",
				execution: agentExecution(interruptedNever, 1, {
					outcome: "interrupted",
					failureRetry: "never",
				}),
			},
			{
				task: resumable,
				status: "interrupted",
				execution: agentExecution(resumable, 1, {
					outcome: "interrupted",
					failureRetry: "resume",
					attempts: 19,
				}),
			},
			{
				task: exhausted,
				status: "interrupted",
				execution: agentExecution(exhausted, 1, {
					outcome: "interrupted",
					failureRetry: "resume",
					attempts: 20,
				}),
			},
			{
				task: abandoned,
				status: "interrupted",
				abandoned: true,
				execution: agentExecution(abandoned, 1, {
					outcome: "interrupted",
					failureRetry: "resume",
				}),
			},
		]);
		expect(resumeRefusal(state, "task_unknown")).toBe("Unknown workflow task.");
		expect(resumeRefusal(state, abandoned.id)).toBe("Unknown workflow task.");
		expect(resumeRefusal(state, support.id)).toBe(
			"Workflow resume requires an agent task.",
		);
		expect(resumeRefusal(state, failed.id)).toBe(
			"Workflow resume requires an interrupted task with a resumable failure.",
		);
		expect(resumeRefusal(state, interruptedNever.id)).toBe(
			"Workflow resume requires an interrupted task with a resumable failure.",
		);
		// 19 attempts + the initial attempt + this resume = 21 = MAX_TASK_ATTEMPTS.
		expect(resumeRefusal(state, resumable.id)).toBeUndefined();
		expect(resumeRefusal(state, exhausted.id)).toBe(
			"Workflow task attempt bound exceeded.",
		);
		expect(resumableTasks(state)).toEqual([resumable.id]);
	});

	it("refuses resume once a dependent already observed the task", () => {
		const cause = agentTask("cause", 1);
		const dependent = agentTask("dependent", 2, { after: [cause.id] });
		const observed = stateOf("interrupted", [
			{
				task: cause,
				status: "interrupted",
				execution: agentExecution(cause, 1, {
					outcome: "interrupted",
					failureRetry: "resume",
				}),
			},
			{
				task: dependent,
				status: "interrupted",
				execution: agentExecution(dependent, 1),
			},
		]);
		expect(resumeRefusal(observed, cause.id)).toBe(
			"Use workflow_invalidate; dependents already observed this task.",
		);
		expect(resumableTasks(observed)).toEqual([]);

		const unobserved = stateOf("interrupted", [
			{
				task: cause,
				status: "interrupted",
				execution: agentExecution(cause, 1, {
					outcome: "interrupted",
					failureRetry: "resume",
				}),
			},
			{ task: dependent, status: "pending" },
		]);
		expect(resumeRefusal(unobserved, cause.id)).toBeUndefined();
		expect(resumableTasks(unobserved)).toEqual([cause.id]);
	});

	it("refuses resume when a later epoch would be abandoned", () => {
		const cause = agentTask("cause", 1);
		const later = agentTask("later", 2);
		const state = stateOf(
			"interrupted",
			[
				{
					task: cause,
					status: "interrupted",
					execution: agentExecution(cause, 1, {
						outcome: "interrupted",
						failureRetry: "resume",
					}),
				},
				{ task: later, status: "pending" },
			],
			[
				{ epoch: 1, kind: "result", taskIds: [cause.id], sequence: 20 },
				{
					epoch: 2,
					kind: "final",
					taskIds: [cause.id, later.id],
					sequence: 30,
				},
			],
		);
		expect(resumeRefusal(state, cause.id)).toBe(
			"Use workflow_invalidate; dependents already observed this task.",
		);
	});
});

// ---------------------------------------------------------------------------
// Pending checkpoints
// ---------------------------------------------------------------------------

describe("pendingCheckpoints", () => {
	it("selects on-path waiting checkpoints whose request is durable and undecided", () => {
		const created = checkpointTask("created", 1);
		const requested = checkpointTask("requested", 2);
		const readyRequested = checkpointTask("ready-requested", 3);
		const decided = checkpointTask("decided", 4);
		const completed = checkpointTask("completed", 5);
		const expired = checkpointTask("expired", 6);
		const cancelled = checkpointTask("cancelled", 7);
		const abandoned = checkpointTask("abandoned", 8);
		const fresh = checkpointTask("fresh", 9);
		const queued = agentTask("queued", 10);
		const later = checkpointTask("later", 11);
		const state = stateOf("waiting", [
			{
				task: created,
				status: "ready",
				execution: checkpointExecution(created, 1, "created"),
			},
			{
				task: requested,
				status: "waiting",
				execution: checkpointExecution(requested, 1, "requested"),
			},
			// Crash between the request event and `ready -> waiting`: the sweep repairs it.
			{
				task: readyRequested,
				status: "ready",
				execution: checkpointExecution(readyRequested, 1, "requested"),
			},
			{
				task: decided,
				status: "waiting",
				execution: checkpointExecution(decided, 1, "decided"),
			},
			{
				task: completed,
				status: "completed",
				execution: checkpointExecution(completed, 2, "completed"),
			},
			{
				task: expired,
				status: "failed",
				execution: checkpointExecution(expired, 1, "expired"),
			},
			{
				task: cancelled,
				status: "cancelled",
				execution: checkpointExecution(cancelled, 1, "cancelled"),
			},
			{
				task: abandoned,
				status: "waiting",
				abandoned: true,
				execution: checkpointExecution(abandoned, 1, "requested"),
			},
			{ task: fresh, status: "pending" },
			// A queued agent task is `waiting` too, but it is no checkpoint.
			{ task: queued, status: "waiting", execution: agentExecution(queued, 1) },
			{
				task: later,
				status: "waiting",
				execution: checkpointExecution(later, 3, "requested"),
			},
		]);
		expect(pendingCheckpoints(state)).toEqual([requested.id, later.id]);
		expect(Object.isFrozen(pendingCheckpoints(state))).toBe(true);
		expect(
			runActionFacts({
				record: rootRecord,
				state,
				ownership: "inactive",
				driving: false,
				now: Date.parse("2026-09-15T12:00:00.000Z"),
			}).pendingCheckpointCount,
		).toBe(2);
	});

	it("counts nothing for a run without checkpoints", () => {
		const task = agentTask("plain", 1);
		const state = stateOf("running", [
			{ task, status: "running", execution: agentExecution(task, 1) },
		]);
		expect(pendingCheckpoints(state)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

describe("runActionFacts", () => {
	const now = Date.parse("2026-09-15T12:00:00.000Z");

	it("reports a created run when the journal is empty", () => {
		expect(
			runActionFacts({
				record: rootRecord,
				state: undefined,
				ownership: "inactive",
				driving: false,
				now,
			}),
		).toEqual({
			status: "created",
			ownership: "inactive",
			driving: false,
			nested: false,
			deadlinePassed: false,
			awaitsRecovery: false,
			hasCleanupBlockedTask: false,
			retryableTaskCount: 0,
			resumableTaskCount: 0,
			pendingCheckpointCount: 0,
		});
	});

	it("derives nesting, deadline, recovery, cleanup, and cause counts from state", () => {
		const failed = agentTask("failed", 1);
		const blocked = agentTask("blocked", 2);
		const invalidated = agentTask("invalidated", 3);
		const state = stateOf("failed", [
			{
				task: failed,
				status: "failed",
				execution: agentExecution(failed, 1, { outcome: "failed" }),
			},
			{
				task: blocked,
				status: "cleanup-blocked",
				execution: agentExecution(blocked, 1, { outcome: "cleanup-blocked" }),
			},
			{ task: invalidated, status: "invalidated" },
		]);
		expect(
			runActionFacts({
				record: { ...nestedRecord, deadlineAt: "2026-09-15T12:00:00.000Z" },
				state,
				ownership: "owned",
				driving: true,
				now,
			}),
		).toEqual({
			status: "failed",
			ownership: "owned",
			driving: true,
			nested: true,
			deadlinePassed: true,
			awaitsRecovery: true,
			hasCleanupBlockedTask: true,
			retryableTaskCount: 1,
			resumableTaskCount: 0,
			pendingCheckpointCount: 0,
		});
	});

	it("ignores abandoned tasks for recovery and cleanup facts", () => {
		const invalidated = agentTask("invalidated", 1);
		const blocked = agentTask("blocked", 2);
		const state = stateOf("interrupted", [
			{ task: invalidated, status: "invalidated", abandoned: true },
			{ task: blocked, status: "cleanup-blocked", abandoned: true },
		]);
		expect(
			runActionFacts({
				record: rootRecord,
				state,
				ownership: "inactive",
				driving: false,
				now,
			}),
		).toMatchObject({
			status: "interrupted",
			awaitsRecovery: false,
			hasCleanupBlockedTask: false,
		});
	});
});

// ---------------------------------------------------------------------------
// Legality table
// ---------------------------------------------------------------------------

describe("availableWorkflowRunActions", () => {
	it("offers stop, wait, and reconcile for an inactive non-terminal run", () => {
		for (const status of [
			"created",
			"running",
			"waiting",
			"finalizing",
			"stopping",
		] as const) {
			expect(availableWorkflowRunActions(facts({ status })), status).toEqual([
				"stop",
				"wait",
				"reconcile",
			]);
		}
	});

	it("offers stop and wait but not reconcile for an owned non-terminal run", () => {
		for (const driving of [false, true]) {
			expect(
				availableWorkflowRunActions(
					facts({ status: "running", ownership: "owned", driving }),
				),
				`driving=${driving}`,
			).toEqual(["stop", "wait"]);
		}
	});

	it("offers nothing for completed, degraded, and cancelled runs", () => {
		for (const status of [
			"completed",
			"completed-degraded",
			"cancelled",
		] as const) {
			for (const ownership of ["owned", "inactive"] as const) {
				expect(
					availableWorkflowRunActions(facts({ status, ownership })),
					`${status}/${ownership}`,
				).toEqual([]);
			}
		}
	});

	it("offers invalidate, retry, and resume for a settled failed or interrupted root run by cause set", () => {
		for (const status of ["failed", "interrupted"] as const) {
			for (const ownership of ["owned", "inactive"] as const) {
				expect(
					availableWorkflowRunActions(
						facts({
							status,
							ownership,
							retryableTaskCount: 1,
							resumableTaskCount: 1,
						}),
					),
					`${status}/${ownership}`,
				).toEqual(
					status === "interrupted"
						? ["invalidate", "retry", "resume"]
						: ["invalidate", "retry"],
				);
				expect(
					availableWorkflowRunActions(facts({ status, ownership })),
					`${status}/${ownership} without causes`,
				).toEqual(["invalidate"]);
			}
		}
		// A failed run never resumes, whatever the predicate counts.
		expect(
			availableWorkflowRunActions(
				facts({ status: "failed", resumableTaskCount: 1 }),
			),
		).toEqual(["invalidate"]);
	});

	it("emits retry, resume, and decide once their preconditions pass", () => {
		const emitted = new Set<WorkflowRunAction>();
		for (const status of RUN_STATUSES) {
			for (const ownership of ["owned", "inactive"] as const) {
				for (const action of availableWorkflowRunActions(
					facts({
						status,
						ownership,
						retryableTaskCount: 3,
						resumableTaskCount: 3,
						pendingCheckpointCount: 3,
					}),
				)) {
					emitted.add(action);
				}
			}
		}
		expect(emitted.has("retry")).toBe(true);
		expect(emitted.has("resume")).toBe(true);
		expect(emitted.has("decide")).toBe(true);
	});

	describe("decide", () => {
		it("is offered only while a running or waiting root run has a pending checkpoint", () => {
			for (const status of RUN_STATUSES) {
				for (const ownership of ["owned", "inactive"] as const) {
					const offered = availableWorkflowRunActions(
						facts({ status, ownership, pendingCheckpointCount: 1 }),
					).includes("decide");
					expect(offered, `${status}/${ownership}`).toBe(
						status === "running" || status === "waiting",
					);
				}
			}
		});

		it("follows the pending checkpoint count, not the waiting status alone", () => {
			expect(availableWorkflowRunActions(facts({ status: "waiting" }))).toEqual(
				["stop", "wait", "reconcile"],
			);
			expect(
				availableWorkflowRunActions(
					facts({ status: "waiting", pendingCheckpointCount: 1 }),
				),
			).toEqual(["stop", "wait", "reconcile", "decide"]);
			expect(
				availableWorkflowRunActions(
					facts({ status: "waiting", pendingCheckpointCount: 300 }),
				),
			).toContain("decide");
		});

		it("stays available against a live drive but never while leased elsewhere", () => {
			for (const driving of [false, true]) {
				expect(
					availableWorkflowRunActions(
						facts({
							status: "running",
							ownership: "owned",
							driving,
							pendingCheckpointCount: 1,
						}),
					),
					`driving=${driving}`,
				).toEqual(["stop", "wait", "decide"]);
			}
			expect(
				availableWorkflowRunActions(
					facts({
						status: "waiting",
						ownership: "leased-elsewhere",
						pendingCheckpointCount: 1,
					}),
				),
			).toEqual([]);
		});

		it("is withheld from nested runs and once the deadline has passed", () => {
			expect(
				availableWorkflowRunActions(
					facts({ status: "waiting", nested: true, pendingCheckpointCount: 1 }),
				),
			).toEqual(["stop", "wait", "reconcile"]);
			expect(
				availableWorkflowRunActions(
					facts({
						status: "waiting",
						deadlinePassed: true,
						pendingCheckpointCount: 1,
					}),
				),
			).toEqual(["stop", "wait", "reconcile"]);
		});

		it("keeps stop while waiting and never unlocks retry, resume, or invalidate there", () => {
			const offered = availableWorkflowRunActions(
				facts({
					status: "waiting",
					pendingCheckpointCount: 1,
					retryableTaskCount: 1,
					resumableTaskCount: 1,
				}),
			);
			expect(offered).toContain("stop");
			expect(offered).not.toContain("invalidate");
			expect(offered).not.toContain("retry");
			expect(offered).not.toContain("resume");
		});

		it("is derived from durable state: a parked run offers decide, its recovery states do not", () => {
			const approve = checkpointTask("approve", 1, { timeoutMs: 60_000 });
			const now = Date.parse("2026-09-15T12:00:00.000Z");
			const parked = stateOf("waiting", [
				{
					task: approve,
					status: "waiting",
					execution: checkpointExecution(approve, 1, "requested"),
				},
			]);
			const parkedFacts = runActionFacts({
				record: rootRecord,
				state: parked,
				ownership: "inactive",
				driving: false,
				now,
			});
			expect(parkedFacts.pendingCheckpointCount).toBe(1);
			expect(availableWorkflowRunActions(parkedFacts)).toEqual([
				"stop",
				"wait",
				"reconcile",
				"decide",
			]);
			expect(requiresAttention(parkedFacts)).toBe(true);
			expect(
				availableWorkflowRunActions(
					runActionFacts({
						record: nestedRecord,
						state: parked,
						ownership: "inactive",
						driving: false,
						now,
					}),
				),
			).toEqual(["stop", "wait", "reconcile"]);
			// Every failure transition cancels open checkpoints first (C1), so an
			// operator resume intent never coexists with a pending checkpoint;
			// the interrupted status alone withholds decide.
			const resumed = agentTask("resumed", 2);
			const intent: TaskExecutionProjection = {
				...agentExecution(resumed, 1, {
					outcome: "interrupted",
					failureRetry: "resume",
				}),
				phase: "attempt-intended",
				attempts: [
					{
						kind: "resume",
						ordinal: 2,
						previousAttemptId: "attempt_child1",
						origin: "operator",
						intentSequence: 50,
					},
				],
			};
			delete (intent as { terminal?: unknown }).terminal;
			const recovering = stateOf("interrupted", [
				{
					task: approve,
					status: "cancelled",
					execution: checkpointExecution(approve, 1, "cancelled"),
				},
				{ task: resumed, status: "interrupted", execution: intent },
			]);
			const recoveringFacts = runActionFacts({
				record: rootRecord,
				state: recovering,
				ownership: "inactive",
				driving: false,
				now,
			});
			expect(recoveringFacts.pendingCheckpointCount).toBe(0);
			expect(availableWorkflowRunActions(recoveringFacts)).not.toContain(
				"decide",
			);
		});
	});

	it("offers only reconcile for a cleanup-blocked run regardless of ownership", () => {
		for (const ownership of ["owned", "inactive"] as const) {
			expect(
				availableWorkflowRunActions(
					facts({
						status: "cleanup-blocked",
						ownership,
						hasCleanupBlockedTask: true,
					}),
				),
				ownership,
			).toEqual(["reconcile"]);
		}
	});

	it("offers nothing when the run is leased elsewhere", () => {
		for (const status of RUN_STATUSES) {
			expect(
				availableWorkflowRunActions(
					facts({
						status,
						ownership: "leased-elsewhere",
						awaitsRecovery: status === "failed",
						hasCleanupBlockedTask: status === "cleanup-blocked",
						retryableTaskCount: 1,
						resumableTaskCount: 1,
					}),
				),
				status,
			).toEqual([]);
		}
	});

	it("withholds invalidate from nested runs but keeps the drive actions", () => {
		expect(
			availableWorkflowRunActions(facts({ status: "failed", nested: true })),
		).toEqual([]);
		expect(
			availableWorkflowRunActions(
				facts({ status: "interrupted", nested: true, resumableTaskCount: 1 }),
			),
		).toEqual([]);
		expect(
			availableWorkflowRunActions(facts({ status: "running", nested: true })),
		).toEqual(["stop", "wait", "reconcile"]);
	});

	it("withholds invalidate once the deadline has passed", () => {
		expect(
			availableWorkflowRunActions(
				facts({ status: "failed", deadlinePassed: true }),
			),
		).toEqual([]);
		expect(
			availableWorkflowRunActions(
				facts({ status: "running", deadlinePassed: true }),
			),
		).toEqual(["stop", "wait", "reconcile"]);
	});

	it("offers only wait while a failed or interrupted run awaits recovery", () => {
		for (const status of ["failed", "interrupted"] as const) {
			expect(
				availableWorkflowRunActions(
					facts({ status, awaitsRecovery: true, retryableTaskCount: 1 }),
				),
				status,
			).toEqual(["wait"]);
		}
	});

	it("withholds invalidate while the owned run is still being driven", () => {
		expect(
			availableWorkflowRunActions(
				facts({ status: "failed", ownership: "owned", driving: true }),
			),
		).toEqual([]);
		expect(
			availableWorkflowRunActions(
				facts({ status: "failed", ownership: "owned", driving: false }),
			),
		).toEqual(["invalidate"]);
	});

	it("returns a frozen list in the canonical action order", () => {
		const actions = availableWorkflowRunActions(facts({ status: "running" }));
		expect(Object.isFrozen(actions)).toBe(true);
		const order = actions.map((action) => WORKFLOW_RUN_ACTIONS.indexOf(action));
		expect(order).toEqual([...order].sort((left, right) => left - right));
	});
});

describe("requiresAttention", () => {
	it("flags cleanup-blocked runs and unrecovered failures independent of ownership", () => {
		for (const ownership of [
			"owned",
			"inactive",
			"leased-elsewhere",
		] as const satisfies readonly WorkflowRunOwnership[]) {
			expect(
				requiresAttention(facts({ status: "cleanup-blocked", ownership })),
			).toBe(true);
			expect(requiresAttention(facts({ status: "failed", ownership }))).toBe(
				true,
			);
			expect(
				requiresAttention(facts({ status: "interrupted", ownership })),
			).toBe(true);
			expect(
				requiresAttention(
					facts({ status: "failed", ownership, awaitsRecovery: true }),
				),
			).toBe(false);
			expect(
				requiresAttention(
					facts({ status: "interrupted", ownership, awaitsRecovery: true }),
				),
			).toBe(false);
		}
		for (const status of [
			"created",
			"running",
			"waiting",
			"finalizing",
			"stopping",
			"completed",
			"completed-degraded",
			"cancelled",
		] as const) {
			expect(requiresAttention(facts({ status })), status).toBe(false);
		}
	});

	it("flags a run with a checkpoint awaiting a decision regardless of ownership", () => {
		for (const ownership of [
			"owned",
			"inactive",
			"leased-elsewhere",
		] as const satisfies readonly WorkflowRunOwnership[]) {
			for (const status of ["running", "waiting"] as const) {
				expect(
					requiresAttention(
						facts({ status, ownership, pendingCheckpointCount: 1 }),
					),
					`${status}/${ownership}`,
				).toBe(true);
			}
		}
		expect(requiresAttention(facts({ status: "waiting" }))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// "No second table": the service precondition blocks and the predicate agree.
// ---------------------------------------------------------------------------

/**
 * The service's `invalidate` precondition block, in its normative order
 * (spec §2.1 mirrors the existing `invalidate` body). Returns the first
 * refusal message, or undefined when every check passes.
 */
function invalidateRefusal(state: WorkflowRunActionFacts): string | undefined {
	if (state.ownership === "leased-elsewhere") {
		return "Workflow run is owned by another live service.";
	}
	if (state.driving) return "Workflow run is still being driven.";
	if (!admitsInvalidation(state.status)) {
		return "Workflow run status does not admit invalidation.";
	}
	if (state.nested) {
		return "Nested workflow runs are invalidated through their parent run.";
	}
	if (state.awaitsRecovery) {
		// The service names the pending recovery (invalidated work or an
		// operator resume); the facts only carry that one is pending.
		return "Workflow run already awaits recovery.";
	}
	if (state.deadlinePassed) return "Workflow run deadline has passed.";
	return undefined;
}

/**
 * The service's `decide` precondition block (spec 2.11): a leasable run whose
 * status admits a checkpoint decision, a root run, before the deadline, with
 * a checkpoint awaiting a decision. Driving does not matter: a live drive
 * accepts decisions too.
 */
function decideRefusal(state: WorkflowRunActionFacts): string | undefined {
	if (state.ownership === "leased-elsewhere") {
		return "Workflow run is owned by another live service.";
	}
	if (state.status !== "running" && state.status !== "waiting") {
		return "Workflow run status does not admit a checkpoint decision.";
	}
	if (state.nested) {
		return "Nested workflow runs are decided through their parent run.";
	}
	if (state.deadlinePassed) return "Workflow run deadline has passed.";
	if (state.pendingCheckpointCount === 0) {
		return "Checkpoint is not awaiting a decision.";
	}
	return undefined;
}

/** `stop` acts only on a non-terminal run it can lease. */
function stopActs(state: WorkflowRunActionFacts): boolean {
	if (state.ownership === "leased-elsewhere") return false;
	return !isTerminalWorkflowRunStatus(state.status);
}

/** `wait` drives a run unless it is terminal and does not await recovery. */
function waitActs(state: WorkflowRunActionFacts): boolean {
	if (state.ownership === "leased-elsewhere") return false;
	return !isTerminalWorkflowRunStatus(state.status) || state.awaitsRecovery;
}

/**
 * `reconcile` reconciles a cleanup-blocked run, or reopens a non-terminal run
 * no live service drives; an owned run is already driven and a completed run
 * returns unchanged.
 */
function reconcileActs(state: WorkflowRunActionFacts): boolean {
	if (state.ownership === "leased-elsewhere") return false;
	if (state.status === "cleanup-blocked") return true;
	return (
		!isTerminalWorkflowRunStatus(state.status) && state.ownership === "inactive"
	);
}

/**
 * `retry` is the invalidate block followed by the cause-task guard; the
 * guard's refusal is what an empty retryable set stands for here.
 */
function retryRefusal(state: WorkflowRunActionFacts): string | undefined {
	const invalidate = invalidateRefusal(state);
	if (invalidate !== undefined) return invalidate;
	if (state.retryableTaskCount === 0) {
		return "Workflow retry requires a failed or interrupted task.";
	}
	return undefined;
}

/** The service's `resume` precondition block in its normative order (spec §2.2). */
function resumeRefusalOf(state: WorkflowRunActionFacts): string | undefined {
	if (state.ownership === "leased-elsewhere") {
		return "Workflow run is owned by another live service.";
	}
	if (state.driving) return "Workflow run is still being driven.";
	if (state.status !== "interrupted") {
		return "Workflow run status does not admit resume.";
	}
	if (state.nested) {
		return "Nested workflow runs are resumed through their parent run.";
	}
	if (state.awaitsRecovery) {
		// The service names the pending recovery (invalidated work or an
		// operator resume); the facts only carry that one is pending.
		return "Workflow run already awaits recovery.";
	}
	if (state.deadlinePassed) return "Workflow run deadline has passed.";
	if (state.resumableTaskCount === 0) {
		return "Workflow run has no resumable task.";
	}
	return undefined;
}

function* enumerateFacts(): Generator<WorkflowRunActionFacts> {
	for (const status of RUN_STATUSES) {
		for (const ownership of [
			"owned",
			"inactive",
			"leased-elsewhere",
		] as const) {
			for (const driving of ownership === "owned" ? [false, true] : [false]) {
				for (const nested of [false, true]) {
					for (const deadline of [false, true]) {
						const recoveries =
							status === "failed" || status === "interrupted"
								? [false, true]
								: [false];
						for (const recovery of recoveries) {
							for (const retryable of [0, 1]) {
								for (const resumable of [0, 1]) {
									for (const pending of [0, 1]) {
										yield facts({
											status,
											ownership,
											driving,
											nested,
											deadlinePassed: deadline,
											awaitsRecovery: recovery,
											hasCleanupBlockedTask: status === "cleanup-blocked",
											retryableTaskCount: retryable,
											resumableTaskCount: resumable,
											pendingCheckpointCount: pending,
										});
									}
								}
							}
						}
					}
				}
			}
		}
	}
}

describe("legality and service preconditions agree", () => {
	it("offers invalidate exactly when the invalidate precondition block passes", () => {
		let cases = 0;
		for (const candidate of enumerateFacts()) {
			cases += 1;
			const offered =
				availableWorkflowRunActions(candidate).includes("invalidate");
			expect(offered, JSON.stringify(candidate)).toBe(
				invalidateRefusal(candidate) === undefined,
			);
		}
		expect(cases).toBeGreaterThan(200);
	});

	it("offers stop, wait, and reconcile exactly when their methods would act", () => {
		for (const candidate of enumerateFacts()) {
			const offered = availableWorkflowRunActions(candidate);
			const label = JSON.stringify(candidate);
			expect(offered.includes("stop"), label).toBe(stopActs(candidate));
			expect(offered.includes("wait"), label).toBe(waitActs(candidate));
			expect(offered.includes("reconcile"), label).toBe(
				reconcileActs(candidate),
			);
		}
	});

	it("offers retry and resume exactly when their precondition blocks pass", () => {
		for (const candidate of enumerateFacts()) {
			const offered = availableWorkflowRunActions(candidate);
			const label = JSON.stringify(candidate);
			expect(offered.includes("retry"), label).toBe(
				retryRefusal(candidate) === undefined,
			);
			expect(offered.includes("resume"), label).toBe(
				resumeRefusalOf(candidate) === undefined,
			);
		}
	});

	it("offers decide exactly when the decide precondition block passes", () => {
		let offeredCount = 0;
		for (const candidate of enumerateFacts()) {
			const offered = availableWorkflowRunActions(candidate).includes("decide");
			if (offered) offeredCount += 1;
			expect(offered, JSON.stringify(candidate)).toBe(
				decideRefusal(candidate) === undefined,
			);
		}
		expect(offeredCount).toBeGreaterThan(0);
	});

	it("never offers an action outside the implemented gate", () => {
		for (const candidate of enumerateFacts()) {
			for (const action of availableWorkflowRunActions(candidate)) {
				expect(IMPLEMENTED_WORKFLOW_RUN_ACTIONS.has(action)).toBe(true);
			}
		}
	});
});
