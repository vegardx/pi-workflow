import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type {
	AgentTaskExecutionRecord,
	MaterializedAgentTask,
	MaterializedWorkflowTask,
	SubagentTerminalEvidence,
	WorkflowArtifactRef,
	WorkflowRunStatus,
	WorkflowTaskId,
	WorkflowTaskStatus,
} from "../src/contracts.js";
import {
	type WorkflowEventInput,
	type WorkflowStateProjection,
	WorkflowStateProjectionSchema,
} from "../src/events.js";
import {
	deriveJsonValueSha256,
	deriveSubagentOperationId,
	deriveTaskExecutionId,
	deriveWorkflowArtifactId,
} from "../src/execution.js";
import {
	deriveAgentTaskIdentity,
	type MaterializationCommit,
	WorkflowTaskMaterializer,
} from "../src/materializer.js";
import type { WorkflowJournalEvent } from "../src/persistence/journal.js";
import { invalidationClosure, reduceWorkflowEvents } from "../src/reducer.js";

// Expectations below follow the revision 16 spec (sections 1, 2.4, 3.1-3.3),
// not the reducer implementation.

const RUN_ID = "workflow_revision16" as const;
const definitionIdentitySha256 = "a".repeat(64);
const inputSha256 = "b".repeat(64);
const planIdentitySha256 = "c".repeat(64);
const resultSha256 = "d".repeat(64);
const structuredOutputSha256 = "e".repeat(64);
const outputSchema = Type.Object({ answer: Type.String() });
const INTERRUPTED_REASON =
	"Interrupted child retained for recovery; no release performed.";
const OPERATOR_REASON = "Operator resumed the interrupted seat.";

function request(
	goal = "Answer",
	policies: { resume?: { attempts: number } } = {},
) {
	return {
		agent: "researcher",
		task: { goal, context: [], instructions: ["Return structured output."] },
		contextMode: "fresh" as const,
		tools: ["read"],
		preloadSkills: [],
		contextScopes: ["project" as const],
		workspace: { mode: "read-only" as const, cwd: "/repo" },
		outputSchema,
		limits: {
			cumulativeRuntimeMs: 300_000,
			attemptTimeoutMs: 300_000,
			totalTokens: 1_000_000,
			cost: 100,
			outputBytes: 1_048_576,
			workspaceWriteBytes: 0,
			retries: 1,
			resumes: 1,
		},
		...policies,
	};
}

function records(
	inputs: readonly WorkflowEventInput[],
): WorkflowJournalEvent[] {
	return inputs.map((input, index) => ({
		schema: "pi-workflow-event",
		contractRevision: 19,
		sequence: index + 1,
		eventId: `event-${index + 1}`,
		timestamp: "2026-09-15T00:00:00.000Z",
		runId: RUN_ID,
		ownerId: "test",
		leaseId: "lease-test",
		fencingGeneration: 1,
		type: input.type,
		data: input.data,
	}));
}

function reduce(
	inputs: readonly WorkflowEventInput[],
): WorkflowStateProjection {
	return reduceWorkflowEvents(records(inputs));
}

function materializer(): WorkflowTaskMaterializer {
	return new WorkflowTaskMaterializer({
		runId: RUN_ID,
		definitionIdentitySha256,
		inputSha256,
	});
}

function declaration(
	commit: MaterializationCommit,
	taskId: WorkflowTaskId,
): MaterializedWorkflowTask {
	for (const event of commit.events) {
		if (event.type === "task-declared" && event.data.task.id === taskId) {
			return event.data.task;
		}
	}
	throw new Error(`missing declaration for ${taskId}`);
}

function declarationEvent(
	commit: MaterializationCommit,
	taskId: WorkflowTaskId,
): WorkflowEventInput {
	for (const event of commit.events) {
		if (event.type === "task-declared" && event.data.task.id === taskId) {
			return structuredClone(event);
		}
	}
	throw new Error(`missing declaration event for ${taskId}`);
}

function runCreated(): WorkflowEventInput {
	return {
		type: "run-created",
		data: { definitionIdentitySha256, inputSha256 },
	};
}

function runStatus(
	from: WorkflowRunStatus,
	to: WorkflowRunStatus,
	reason?: string,
): WorkflowEventInput {
	return {
		type: "run-status-changed",
		data: { from, to, ...(reason === undefined ? {} : { reason }) },
	};
}

function taskStatus(
	taskId: WorkflowTaskId,
	from: WorkflowTaskStatus,
	to: WorkflowTaskStatus,
	reason?: string,
): WorkflowEventInput {
	return {
		type: "task-status-changed",
		data: { taskId, from, to, ...(reason === undefined ? {} : { reason }) },
	};
}

function invalidated(
	causeTaskId: WorkflowTaskId,
	taskIds: readonly WorkflowTaskId[],
	abandonedEpochs: readonly number[],
): WorkflowEventInput {
	return {
		type: "task-invalidated",
		data: {
			causeTaskId,
			taskIds: [...taskIds],
			abandonedEpochs: [...abandonedEpochs],
			reason: "re-execute",
		},
	};
}

function agentExecution(
	task: MaterializedWorkflowTask,
	generation: number,
): AgentTaskExecutionRecord {
	return {
		kind: "agent",
		id: deriveTaskExecutionId(RUN_ID, task.id, generation),
		runId: RUN_ID,
		taskId: task.id,
		generation,
		taskIdentitySha256: task.spec.identitySha256,
		operationId: deriveSubagentOperationId(RUN_ID, task.id, generation),
	};
}

function executionCreated(
	execution: AgentTaskExecutionRecord,
): WorkflowEventInput {
	return { type: "task-execution-created", data: { execution } };
}

function resultArtifact(
	taskId: WorkflowTaskId,
	producerExecutionId: string,
): WorkflowArtifactRef {
	const input = {
		runId: RUN_ID,
		producerTaskId: taskId,
		producerExecutionId,
		output: "result" as const,
		sha256: structuredOutputSha256,
		schemaSha256: deriveJsonValueSha256(outputSchema),
	};
	return {
		id: deriveWorkflowArtifactId(input),
		...input,
		bytes: 18,
		mediaType: "application/json",
	};
}

function runOutputArtifact(): WorkflowArtifactRef {
	const input = {
		runId: RUN_ID,
		sha256: "9".repeat(64),
		schemaSha256: "8".repeat(64),
	};
	return {
		id: deriveWorkflowArtifactId(input),
		...input,
		bytes: 2,
		mediaType: "application/json",
	};
}

const attemptUsage = {
	input: 20,
	output: 4,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 24,
	cost: 0.02,
};

function completedEvidence(attemptOrdinal = 1): SubagentTerminalEvidence {
	return {
		kind: "subagent",
		attemptOrdinal,
		resultSha256,
		status: "completed",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: 0.01,
		},
		usageComplete: true,
		runtimeMs: 1000,
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
		structuredOutputSha256,
	};
}

function failedEvidence(attemptOrdinal = 1): SubagentTerminalEvidence {
	return {
		kind: "subagent",
		attemptOrdinal,
		resultSha256: "6".repeat(64),
		status: "failed",
		usage: attemptUsage,
		usageComplete: true,
		runtimeMs: 500,
		failure: {
			code: "provider-transient",
			origin: "provider",
			retry: "backoff",
			message: "Provider timed out.",
			guidance: "Retry later.",
		},
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
	};
}

function interruptedEvidence(attemptOrdinal = 1): SubagentTerminalEvidence {
	return {
		kind: "subagent",
		attemptOrdinal,
		resultSha256: "7".repeat(64),
		status: "interrupted",
		usage: attemptUsage,
		usageComplete: false,
		runtimeMs: 700,
		failure: {
			code: "seat-interruption",
			origin: "service",
			retry: "resume",
			message: "Seat exited.",
			guidance: "Resume the run.",
		},
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
	};
}

function childIds(execution: AgentTaskExecutionRecord): {
	subagentRunId: string;
	subagentAttemptId: string;
} {
	const stem = `${execution.taskId.slice(5, 13)}g${execution.generation}`;
	return { subagentRunId: `run_${stem}`, subagentAttemptId: `attempt_${stem}` };
}

function attemptId(execution: AgentTaskExecutionRecord, ordinal: number) {
	return `${childIds(execution).subagentAttemptId}r${ordinal}`;
}

/** Preflight, launch intent, launch receipt, and the `ready -> running` step. */
function launchLadder(
	execution: AgentTaskExecutionRecord,
): WorkflowEventInput[] {
	const child = childIds(execution);
	return [
		{
			type: "task-execution-preflighted",
			data: {
				executionId: execution.id,
				operationId: execution.operationId,
				preflightId: `preflight-${execution.generation}`,
				workspaceMode: "read-only" as const,
				workspaceBaselineSha256: "c".repeat(64),
				planIdentitySha256,
				plannedSubagentRunId: child.subagentRunId,
				plannedSubagentAttemptId: child.subagentAttemptId,
				expiresAt: "2026-09-15T01:00:00.000Z",
			},
		},
		{
			type: "task-execution-launch-intended",
			data: {
				executionId: execution.id,
				operationId: execution.operationId,
				preflightId: `preflight-${execution.generation}`,
				planIdentitySha256,
			},
		},
		{
			type: "task-execution-launch-receipted",
			data: {
				executionId: execution.id,
				operationId: execution.operationId,
				subagentRunId: child.subagentRunId,
				subagentAttemptId: child.subagentAttemptId,
				status: "active",
			},
		},
		taskStatus(execution.taskId, "ready", "running"),
	];
}

function observed(
	execution: AgentTaskExecutionRecord,
	status: "active" | "completed" | "failed" | "interrupted",
	subagentAttemptId = childIds(execution).subagentAttemptId,
): WorkflowEventInput {
	return {
		type: "task-execution-child-observed",
		data: {
			executionId: execution.id,
			subagentRunId: childIds(execution).subagentRunId,
			subagentAttemptId,
			status,
		},
	};
}

function settled(
	execution: AgentTaskExecutionRecord,
	evidence: SubagentTerminalEvidence,
): WorkflowEventInput {
	return {
		type: "task-execution-child-settled",
		data: { executionId: execution.id, evidence },
	};
}

function releaseIntended(
	execution: AgentTaskExecutionRecord,
): WorkflowEventInput {
	return {
		type: "task-execution-release-intended",
		data: {
			executionId: execution.id,
			subagentRunId: childIds(execution).subagentRunId,
		},
	};
}

function released(
	execution: AgentTaskExecutionRecord,
	status: "completed" | "failed",
): WorkflowEventInput {
	return {
		type: "task-execution-released",
		data: {
			executionId: execution.id,
			subagentRunId: childIds(execution).subagentRunId,
			status,
		},
	};
}

function terminal(
	execution: AgentTaskExecutionRecord,
	outcome: "completed" | "failed" | "interrupted",
	evidence: SubagentTerminalEvidence,
): WorkflowEventInput {
	return {
		type: "task-execution-terminal",
		data: { executionId: execution.id, outcome, evidence },
	};
}

/** Observed, settled (interrupted): the execution is at phase `settled`. */
function interruptedSettlement(
	execution: AgentTaskExecutionRecord,
	attemptOrdinal = 1,
	subagentAttemptId = childIds(execution).subagentAttemptId,
): WorkflowEventInput[] {
	return [
		observed(execution, "interrupted", subagentAttemptId),
		settled(execution, interruptedEvidence(attemptOrdinal)),
	];
}

/**
 * The agent execution ladder from a `created` execution on a `ready` task
 * through `task-execution-terminal` and the matching task status change.
 */
function executionLadder(
	execution: AgentTaskExecutionRecord,
	outcome: "completed" | "failed",
): WorkflowEventInput[] {
	const child = childIds(execution);
	const evidence =
		outcome === "completed" ? completedEvidence() : failedEvidence();
	const output = resultArtifact(execution.taskId, execution.id);
	const imported: WorkflowEventInput[] =
		outcome === "completed"
			? [
					{ type: "artifact-declared", data: { artifact: output } },
					{
						type: "task-execution-artifact-imported",
						data: {
							executionId: execution.id,
							subagentRunId: child.subagentRunId,
							artifactId: output.id,
							sourceResultSha256: resultSha256,
						},
					},
				]
			: [];
	return [
		...launchLadder(execution),
		observed(execution, outcome),
		settled(execution, evidence),
		...imported,
		releaseIntended(execution),
		released(execution, outcome),
		terminal(execution, outcome, evidence),
		taskStatus(execution.taskId, "running", outcome),
	];
}

/** Ready, created, and the full ladder for a pending task. */
function runTask(
	execution: AgentTaskExecutionRecord,
	outcome: "completed" | "failed",
): WorkflowEventInput[] {
	return [
		taskStatus(execution.taskId, "pending", "ready"),
		executionCreated(execution),
		...executionLadder(execution, outcome),
	];
}

type AttemptOrigin = "policy" | "operator";

function attemptIntended(
	execution: AgentTaskExecutionRecord,
	origin: AttemptOrigin,
	overrides: Partial<{
		kind: "retry" | "resume";
		ordinal: number;
		previousAttemptId: string;
		failureCode: string;
		failureRetry: "backoff" | "manual" | "resume";
		reason: string;
	}> = {},
): WorkflowEventInput {
	return {
		type: "task-execution-attempt-intended",
		data: {
			executionId: execution.id,
			subagentRunId: childIds(execution).subagentRunId,
			kind: "resume",
			ordinal: 2,
			previousAttemptId: childIds(execution).subagentAttemptId,
			failureCode: "seat-interruption",
			failureRetry: "resume",
			origin,
			...overrides,
		},
	};
}

function operatorIntent(
	execution: AgentTaskExecutionRecord,
	overrides: Parameters<typeof attemptIntended>[2] = {},
): WorkflowEventInput {
	return attemptIntended(execution, "operator", {
		reason: OPERATOR_REASON,
		...overrides,
	});
}

function attemptReceipted(
	execution: AgentTaskExecutionRecord,
	ordinal: number,
): WorkflowEventInput {
	return {
		type: "task-execution-attempt-receipted",
		data: {
			executionId: execution.id,
			subagentRunId: childIds(execution).subagentRunId,
			ordinal,
			subagentAttemptId: attemptId(execution, ordinal),
			status: "active",
		},
	};
}

function attemptDeclined(
	execution: AgentTaskExecutionRecord,
	ordinal: number,
): WorkflowEventInput {
	return {
		type: "task-execution-attempt-declined",
		data: {
			executionId: execution.id,
			subagentRunId: childIds(execution).subagentRunId,
			ordinal,
			reason: "Workflow stop requested before the attempt.",
		},
	};
}

/** One required ordinary agent task under a final barrier, ready with generation 1 created. */
function soloGraph(policies: { resume?: { attempts: number } } = {}) {
	const m = materializer();
	const handle = m.agent("solo", request("Solo", policies));
	const commit = m.closeEpoch("final", [handle]);
	const task = declaration(commit, handle.ref.taskId);
	const execution = agentExecution(task, 1);
	return {
		task,
		execution,
		commit,
		events: [
			runCreated(),
			...commit.events,
			runStatus("created", "running"),
			taskStatus(task.id, "pending", "ready"),
			executionCreated(execution),
		] as WorkflowEventInput[],
	};
}

/** Solo task launched and settled `interrupted` (phase `settled`, task `running`). */
function interruptedSolo(policies: { resume?: { attempts: number } } = {}) {
	const graph = soloGraph(policies);
	return {
		...graph,
		events: [
			...graph.events,
			...launchLadder(graph.execution),
			...interruptedSettlement(graph.execution),
		] as WorkflowEventInput[],
	};
}

/** Solo task terminalized `interrupted` without release; run `interrupted`. */
function interruptedTerminalSolo(
	policies: { resume?: { attempts: number } } = {},
) {
	const graph = interruptedSolo(policies);
	return {
		...graph,
		events: [
			...graph.events,
			terminal(graph.execution, "interrupted", interruptedEvidence()),
			taskStatus(graph.task.id, "running", "interrupted", INTERRUPTED_REASON),
			runStatus(
				"running",
				"interrupted",
				"A required workflow task was interrupted.",
			),
		] as WorkflowEventInput[],
	};
}

interface FinalizerGraphOptions {
	readonly kind: "required" | "advisory";
	/** Declare an optional ordinary task `extra` alongside `report`. */
	readonly optionalOrdinary?: boolean;
	/** Make the finalizer depend on `extra` (requires optionalOrdinary). */
	readonly finalizerAfterExtra?: boolean;
	readonly finalizerPolicies?: { resume?: { attempts: number } };
}

/** `report` (required ordinary) [+ `extra` (optional ordinary)] + `cleanup` finalizer. */
function finalizerGraph(options: FinalizerGraphOptions) {
	const m = materializer();
	const report = m.agent("report", request("Report"));
	const extra = options.optionalOrdinary
		? m.agent("extra", {
				...request("Extra"),
				disposition: "optional" as const,
			})
		: undefined;
	const cleanup = m.finalizer("cleanup", {
		kind: options.kind,
		agent: {
			...request("Cleanup", options.finalizerPolicies ?? {}),
			...(options.finalizerAfterExtra && extra ? { after: [extra.ref] } : {}),
		},
	});
	const commit = m.closeEpoch("final", [report]);
	const reportTask = declaration(commit, report.ref.taskId);
	const cleanupTask = declaration(commit, cleanup.ref.taskId);
	const extraTask = extra ? declaration(commit, extra.ref.taskId) : undefined;
	return {
		commit,
		report: reportTask,
		extra: extraTask,
		cleanup: cleanupTask,
		reportExecution: agentExecution(reportTask, 1),
		extraExecution: extraTask ? agentExecution(extraTask, 1) : undefined,
		cleanupExecution: agentExecution(cleanupTask, 1),
		output: runOutputArtifact(),
		running: [
			runCreated(),
			...commit.events,
			runStatus("created", "running"),
		] as WorkflowEventInput[],
	};
}

/** The output-commit ladder: `running -> finalizing`, output declared, committed. */
function outputCommit(graph: ReturnType<typeof finalizerGraph>) {
	return [
		runStatus("running", "finalizing"),
		{ type: "artifact-declared", data: { artifact: graph.output } },
		{ type: "run-output-committed", data: { artifactId: graph.output.id } },
	] as WorkflowEventInput[];
}

/** Report completed (and extra to `extraOutcome` when declared), output committed. */
function committedFinalizerRun(
	options: FinalizerGraphOptions,
	extraOutcome: "completed" | "failed" = "completed",
) {
	const graph = finalizerGraph(options);
	return {
		...graph,
		events: [
			...graph.running,
			...runTask(graph.reportExecution, "completed"),
			...(graph.extraExecution
				? runTask(graph.extraExecution, extraOutcome)
				: []),
			...outputCommit(graph),
		] as WorkflowEventInput[],
	};
}

describe("revision 16 A: interrupted children finalize without release", () => {
	it("accepts interrupted terminal evidence at phase settled with no release intent", () => {
		const run = interruptedTerminalSolo();
		const state = reduce(run.events);
		const projection = state.executions[run.execution.id];
		expect(projection).toMatchObject({
			phase: "terminal",
			terminal: {
				outcome: "interrupted",
				evidence: { kind: "subagent", status: "interrupted" },
			},
			settlement: { evidence: interruptedEvidence() },
		});
		expect(projection?.releaseIntent).toBeUndefined();
		expect(projection?.release).toBeUndefined();
		expect(state.tasks[run.task.id]?.status).toBe("interrupted");
		expect(state.status).toBe("interrupted");
	});

	it("rejects a release intent after an interrupted observation", () => {
		const run = interruptedSolo();
		expect(() =>
			reduce([...run.events, releaseIntended(run.execution)]),
		).toThrow("interrupted child is not releasable");
	});

	it("rejects interrupted terminal evidence once a release intent exists", () => {
		const graph = soloGraph();
		const events: WorkflowEventInput[] = [
			...graph.events,
			...launchLadder(graph.execution),
			observed(graph.execution, "failed"),
			settled(graph.execution, failedEvidence()),
			releaseIntended(graph.execution),
		];
		expect(() =>
			reduce([
				...events,
				terminal(graph.execution, "interrupted", interruptedEvidence()),
			]),
		).toThrow(
			"interrupted terminal evidence requires an unreleased settled execution",
		);
		expect(() =>
			reduce([
				...events,
				released(graph.execution, "failed"),
				terminal(graph.execution, "interrupted", interruptedEvidence()),
			]),
		).toThrow(
			"interrupted terminal evidence requires an unreleased settled execution",
		);
	});

	it("still rejects failed terminal evidence at phase settled", () => {
		const graph = soloGraph();
		expect(() =>
			reduce([
				...graph.events,
				...launchLadder(graph.execution),
				observed(graph.execution, "failed"),
				settled(graph.execution, failedEvidence()),
				terminal(graph.execution, "failed", failedEvidence()),
			]),
		).toThrow("subagent terminal evidence precedes release");
	});

	it("accepts cancelling -> interrupted and drains stopping -> cancelled over an interrupted task (C1)", () => {
		const graph = soloGraph();
		const events: WorkflowEventInput[] = [
			...graph.events,
			...launchLadder(graph.execution),
			runStatus("running", "stopping", "Operator requested stop."),
			taskStatus(graph.task.id, "running", "cancelling"),
			...interruptedSettlement(graph.execution),
			terminal(graph.execution, "interrupted", interruptedEvidence()),
			taskStatus(
				graph.task.id,
				"cancelling",
				"interrupted",
				INTERRUPTED_REASON,
			),
		];
		const interrupted = reduce(events);
		expect(interrupted.tasks[graph.task.id]?.status).toBe("interrupted");
		expect(interrupted.status).toBe("stopping");
		const cancelled = reduce([
			...events,
			runStatus(
				"stopping",
				"cancelled",
				"Workflow stop drained all child work.",
			),
		]);
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.tasks[graph.task.id]?.status).toBe("interrupted");
		expect(cancelled.executions[graph.execution.id]?.release).toBeUndefined();
	});

	it("still rejects stopping -> cancelled while a task is running", () => {
		const graph = soloGraph();
		expect(() =>
			reduce([
				...graph.events,
				...launchLadder(graph.execution),
				runStatus("running", "stopping"),
				runStatus("stopping", "cancelled"),
			]),
		).toThrow("run cancelled while tasks remain unsettled");
	});

	it("accepts finalizing -> interrupted after a required finalizer is interrupted", () => {
		const run = committedFinalizerRun({ kind: "required" });
		const state = reduce([
			...run.events,
			taskStatus(run.cleanup.id, "pending", "ready"),
			executionCreated(run.cleanupExecution),
			...launchLadder(run.cleanupExecution),
			...interruptedSettlement(run.cleanupExecution),
			terminal(run.cleanupExecution, "interrupted", interruptedEvidence()),
			taskStatus(run.cleanup.id, "running", "interrupted", INTERRUPTED_REASON),
			runStatus(
				"finalizing",
				"interrupted",
				"A required workflow task was interrupted.",
			),
		]);
		expect(state.status).toBe("interrupted");
		expect(state.tasks[run.cleanup.id]?.status).toBe("interrupted");
		expect(state.outputArtifactId).toBe(run.output.id);
	});
});

describe("revision 16 B: operator attempt intents", () => {
	it("reopens a terminal interrupted execution with an operator resume intent", () => {
		const run = interruptedTerminalSolo();
		const events = [...run.events, operatorIntent(run.execution)];
		const state = reduce(events);
		const projection = state.executions[run.execution.id];
		if (!projection) throw new Error("missing projection");
		expect(projection.phase).toBe("attempt-intended");
		expect(projection.terminal).toBeUndefined();
		expect(projection.attempts?.at(-1)).toMatchObject({
			kind: "resume",
			ordinal: 2,
			previousAttemptId: childIds(run.execution).subagentAttemptId,
			origin: "operator",
			reason: OPERATOR_REASON,
			intentSequence: events.length,
		});
		expect(projection.attempts?.at(-1)?.receiptSequence).toBeUndefined();
		expect(projection.attempts?.at(-1)?.declinedSequence).toBeUndefined();
		expect(state.tasks[run.task.id]?.status).toBe("interrupted");
		expect(state.status).toBe("interrupted");
	});

	it("admits interrupted -> running with an open operator intent and no invalidated work", () => {
		const run = interruptedTerminalSolo();
		const state = reduce([
			...run.events,
			operatorIntent(run.execution),
			runStatus("interrupted", "running"),
		]);
		expect(state.status).toBe("running");
		expect(
			Object.values(state.tasks).some((task) => task.status === "invalidated"),
		).toBe(false);
	});

	it("rejects interrupted -> running without an operator intent or invalidated work", () => {
		const run = interruptedTerminalSolo();
		expect(() =>
			reduce([...run.events, runStatus("interrupted", "running")]),
		).toThrow("recovery requires invalidated work");
	});

	it("rejects interrupted -> running once the operator intent is receipted or declined", () => {
		const run = interruptedTerminalSolo();
		expect(() =>
			reduce([
				...run.events,
				operatorIntent(run.execution),
				attemptReceipted(run.execution, 2),
				runStatus("interrupted", "running"),
			]),
		).toThrow("recovery requires invalidated work");
		expect(() =>
			reduce([
				...run.events,
				operatorIntent(run.execution),
				attemptDeclined(run.execution, 2),
				runStatus("interrupted", "running"),
			]),
		).toThrow("recovery requires invalidated work");
	});

	it("rejects an operator intent of kind retry", () => {
		const run = interruptedTerminalSolo();
		expect(() =>
			reduce([
				...run.events,
				operatorIntent(run.execution, {
					kind: "retry",
					failureRetry: "backoff",
				}),
			]),
		).toThrow("operator attempt intent requires a resume");
	});

	it("rejects an operator intent on a released or release-intended execution", () => {
		const graph = soloGraph();
		const settledFailed: WorkflowEventInput[] = [
			...graph.events,
			...launchLadder(graph.execution),
			observed(graph.execution, "failed"),
			settled(graph.execution, failedEvidence()),
		];
		expect(() =>
			reduce([
				...settledFailed,
				releaseIntended(graph.execution),
				operatorIntent(graph.execution),
			]),
		).toThrow(
			"operator attempt intent requires an unreleased interrupted execution",
		);
		expect(() =>
			reduce([
				...settledFailed,
				releaseIntended(graph.execution),
				released(graph.execution, "failed"),
				operatorIntent(graph.execution),
			]),
		).toThrow(
			"operator attempt intent requires an unreleased interrupted execution",
		);
		// A terminal execution whose outcome is not interrupted cannot be reopened.
		expect(() =>
			reduce([
				...graph.events,
				...executionLadder(graph.execution, "failed"),
				operatorIntent(graph.execution),
			]),
		).toThrow(
			"operator attempt intent requires an unreleased interrupted execution",
		);
	});

	it("rejects an operator intent on a superseded execution after invalidation and re-materialization", () => {
		const run = interruptedTerminalSolo();
		const closure = invalidationClosure(reduce(run.events), run.task.id);
		expect(closure).toEqual({ taskIds: [run.task.id], abandonedEpochs: [] });
		const invalidatedEvents: WorkflowEventInput[] = [
			...run.events,
			invalidated(run.task.id, closure.taskIds, closure.abandonedEpochs),
		];
		expect(() =>
			reduce([...invalidatedEvents, operatorIntent(run.execution)]),
		).toThrow("operator attempt intent targets a superseded execution");
		expect(() =>
			reduce([
				...invalidatedEvents,
				taskStatus(run.task.id, "invalidated", "pending"),
				operatorIntent(run.execution),
			]),
		).toThrow("operator attempt intent targets a superseded execution");
	});

	it("rejects an operator intent while the run is failed or stopping", () => {
		const run = interruptedSolo();
		expect(() =>
			reduce([
				...run.events,
				runStatus("running", "failed", "Workflow failed."),
				operatorIntent(run.execution),
			]),
		).toThrow(
			"operator attempt intent requires a running or interrupted workflow run",
		);
		expect(() =>
			reduce([
				...run.events,
				runStatus("running", "stopping", "Operator requested stop."),
				operatorIntent(run.execution),
			]),
		).toThrow(
			"operator attempt intent requires a running or interrupted workflow run",
		);
	});

	it("rejects a policy intent that carries a reason", () => {
		const run = interruptedSolo({ resume: { attempts: 1 } });
		expect(() =>
			reduce([
				...run.events,
				attemptIntended(run.execution, "policy", {
					reason: "Policy reasons are not evidence.",
				}),
			]),
		).toThrow("policy attempt intent may not carry a reason");
	});

	it("rejects an operator intent that skips an ordinal", () => {
		const run = interruptedTerminalSolo();
		expect(() =>
			reduce([...run.events, operatorIntent(run.execution, { ordinal: 3 })]),
		).toThrow("task execution attempt ordinal is not contiguous");
	});

	it("rejects attempt 22 after twenty operator resumes", () => {
		const run = interruptedSolo();
		const events: WorkflowEventInput[] = [...run.events];
		for (let ordinal = 2; ordinal <= 21; ordinal += 1) {
			const previousAttemptId =
				ordinal === 2
					? childIds(run.execution).subagentAttemptId
					: attemptId(run.execution, ordinal - 1);
			events.push(
				operatorIntent(run.execution, { ordinal, previousAttemptId }),
				attemptReceipted(run.execution, ordinal),
				...interruptedSettlement(
					run.execution,
					ordinal,
					attemptId(run.execution, ordinal),
				),
			);
		}
		const state = reduce(events);
		const projection = state.executions[run.execution.id];
		expect(projection?.attempts).toHaveLength(20);
		expect(
			projection?.attempts?.every((attempt) => attempt.origin === "operator"),
		).toBe(true);
		expect(projection?.phase).toBe("settled");
		expect(() =>
			reduce([
				...events,
				operatorIntent(run.execution, {
					ordinal: 22,
					previousAttemptId: attemptId(run.execution, 21),
				}),
			]),
		).toThrow("event payload does not match a known workflow event");
	});

	it("admits an operator intent on a spec without a resume policy", () => {
		const run = interruptedSolo();
		expect(
			run.task.spec.kind === "agent" && run.task.spec.request.resume,
		).toBeUndefined();
		// The policy path still needs the policy.
		expect(() =>
			reduce([...run.events, attemptIntended(run.execution, "policy")]),
		).toThrow("task execution resume intent lacks a resume policy");
		const state = reduce([...run.events, operatorIntent(run.execution)]);
		expect(state.executions[run.execution.id]).toMatchObject({
			phase: "attempt-intended",
			attempts: [{ kind: "resume", ordinal: 2, origin: "operator" }],
		});
	});

	it("admits an operator intent after policy attempts were closed", () => {
		const run = interruptedSolo({ resume: { attempts: 1 } });
		const closed: WorkflowEventInput[] = [
			...run.events,
			attemptIntended(run.execution, "policy"),
			attemptDeclined(run.execution, 2),
		];
		const before = reduce(closed).executions[run.execution.id];
		expect(before).toMatchObject({ phase: "settled", attemptsClosed: true });
		expect(() =>
			reduce([
				...closed,
				attemptIntended(run.execution, "policy", { ordinal: 3 }),
			]),
		).toThrow("task execution attempt intents are closed");
		const state = reduce([
			...closed,
			operatorIntent(run.execution, { ordinal: 3 }),
		]);
		const projection = state.executions[run.execution.id];
		expect(projection?.phase).toBe("attempt-intended");
		expect(projection?.attempts?.at(-1)).toMatchObject({
			kind: "resume",
			ordinal: 3,
			origin: "operator",
			reason: OPERATOR_REASON,
		});
	});

	it("keeps every revision-15 check on policy intents", () => {
		const run = interruptedSolo({ resume: { attempts: 1 } });
		const state = reduce([
			...run.events,
			attemptIntended(run.execution, "policy"),
		]);
		const projection = state.executions[run.execution.id];
		expect(projection?.phase).toBe("attempt-intended");
		expect(projection?.attempts?.at(-1)).toMatchObject({
			kind: "resume",
			ordinal: 2,
			origin: "policy",
		});
		expect(projection?.attempts?.at(-1)?.reason).toBeUndefined();
		// A policy intent never reopens a terminal interrupted execution.
		const terminalRun = interruptedTerminalSolo({ resume: { attempts: 1 } });
		expect(() =>
			reduce([
				...terminalRun.events,
				attemptIntended(terminalRun.execution, "policy"),
			]),
		).toThrow("task execution attempt intent is out of order");
		// A policy intent still requires a running workflow run.
		expect(() =>
			reduce([
				...run.events,
				runStatus("running", "stopping"),
				attemptIntended(run.execution, "policy"),
			]),
		).toThrow("task execution attempt intent requires a running workflow run");
		// The resume policy cap still applies to policy intents.
		expect(() =>
			reduce([
				...run.events,
				attemptIntended(run.execution, "policy"),
				attemptReceipted(run.execution, 2),
				...interruptedSettlement(run.execution, 2, attemptId(run.execution, 2)),
				attemptIntended(run.execution, "policy", {
					ordinal: 3,
					previousAttemptId: attemptId(run.execution, 2),
				}),
			]),
		).toThrow("task execution resume intent exceeds the resume policy");
	});
});

describe("revision 16 C: finalizers", () => {
	it("rejects a finalizer becoming ready while the run is running", () => {
		const run = finalizerGraph({ kind: "required" });
		expect(() =>
			reduce([
				...run.running,
				...runTask(run.reportExecution, "completed"),
				taskStatus(run.cleanup.id, "pending", "ready"),
			]),
		).toThrow("finalizer became ready outside finalizing");
	});

	it("rejects a finalizer becoming ready while finalizing before the output commit", () => {
		const run = finalizerGraph({ kind: "required" });
		expect(() =>
			reduce([
				...run.running,
				...runTask(run.reportExecution, "completed"),
				runStatus("running", "finalizing"),
				taskStatus(run.cleanup.id, "pending", "ready"),
			]),
		).toThrow("finalizer became ready outside finalizing");
		expect(() =>
			reduce([
				...run.running,
				...runTask(run.reportExecution, "completed"),
				runStatus("running", "finalizing"),
				{ type: "artifact-declared", data: { artifact: run.output } },
				taskStatus(run.cleanup.id, "pending", "ready"),
			]),
		).toThrow("finalizer became ready outside finalizing");
	});

	it("rejects a finalizer execution outside a finalizing run with a committed output", () => {
		const run = committedFinalizerRun({ kind: "required" });
		// The finalizer became ready legitimately; the run then leaves
		// finalizing through cleanup-blocked and resumes running.
		expect(() =>
			reduce([
				...run.events,
				taskStatus(run.cleanup.id, "pending", "ready"),
				runStatus("finalizing", "cleanup-blocked"),
				runStatus("cleanup-blocked", "running"),
				executionCreated(run.cleanupExecution),
			]),
		).toThrow("finalizer execution requires a finalizing workflow run");
	});

	it("accepts a finalizer becoming ready and executing after the output commit", () => {
		const run = committedFinalizerRun({ kind: "required" });
		const state = reduce([
			...run.events,
			taskStatus(run.cleanup.id, "pending", "ready"),
			executionCreated(run.cleanupExecution),
			...executionLadder(run.cleanupExecution, "completed"),
			runStatus("finalizing", "completed"),
		]);
		expect(state.status).toBe("completed");
		expect(state.tasks[run.cleanup.id]).toMatchObject({
			status: "completed",
			currentExecutionId: run.cleanupExecution.id,
			task: { spec: { role: "finalizer", disposition: "required" } },
		});
		expect(state.tasks[run.report.id]?.task.spec.role).toBe("task");
	});

	it("rejects an ordinary task becoming ready while the run is created", () => {
		const graph = soloGraph();
		expect(() =>
			reduce([
				runCreated(),
				...graph.commit.events,
				taskStatus(graph.task.id, "pending", "ready"),
			]),
		).toThrow("task became ready outside a running workflow run");
	});

	it("rejects an ordinary task declared after a finalizer by order or data dependency", () => {
		const m = materializer();
		const cleanup = m.finalizer("cleanup", {
			kind: "required",
			agent: request("Cleanup"),
		});
		const report = m.agent("report", request("Report"));
		const commit = m.closeEpoch("final", [report]);
		const cleanupDeclared = declarationEvent(commit, cleanup.ref.taskId);
		const reportDeclared = declarationEvent(commit, report.ref.taskId);
		if (reportDeclared.type !== "task-declared") {
			throw new Error("missing agent declaration");
		}
		const task = agentTask(reportDeclared.data.task);
		const withDependency = (
			patch: Partial<Pick<typeof task.spec, "after" | "inputs">>,
		): WorkflowEventInput => {
			const { identitySha256: _identity, ...spec } = task.spec;
			const patched = { ...spec, ...patch };
			return {
				type: "task-declared",
				data: {
					task: {
						...task,
						spec: {
							...patched,
							identitySha256: deriveAgentTaskIdentity({
								definitionIdentitySha256,
								inputSha256,
								namespace: task.namespace,
								spec: patched,
							}),
						},
					},
				},
			};
		};
		expect(() =>
			reduce([
				runCreated(),
				cleanupDeclared,
				withDependency({
					after: [{ runId: RUN_ID, taskId: cleanup.ref.taskId }],
				}),
			]),
		).toThrow("ordinary task may not depend on a finalizer");
		expect(() =>
			reduce([
				runCreated(),
				cleanupDeclared,
				withDependency({
					inputs: {
						cleanup: {
							runId: RUN_ID,
							producerTaskId: cleanup.ref.taskId,
							output: "result",
						},
					},
				}),
			]),
		).toThrow("ordinary task may not depend on a finalizer");
		// The unpatched declaration is accepted as the control.
		expect(() =>
			reduce([runCreated(), cleanupDeclared, reportDeclared]),
		).not.toThrow();
	});

	it("accepts a finalizer depending on an ordinary task and another finalizer", () => {
		const m = materializer();
		const report = m.agent("report", request("Report"));
		const audit = m.finalizer("audit", {
			kind: "advisory",
			agent: request("Audit"),
		});
		const cleanup = m.finalizer("cleanup", {
			kind: "required",
			agent: {
				...request("Cleanup"),
				after: [audit.ref],
				inputs: { report: report.output },
			},
		});
		const commit = m.closeEpoch("final", [report]);
		const state = reduce([runCreated(), ...commit.events]);
		const spec = state.tasks[cleanup.ref.taskId]?.task.spec;
		expect(spec?.role).toBe("finalizer");
		expect(spec?.disposition).toBe("required");
		expect(spec?.after.map((dependency) => dependency.taskId).sort()).toEqual(
			[audit.ref.taskId, report.ref.taskId].sort(),
		);
		expect(state.tasks[audit.ref.taskId]?.task.spec).toMatchObject({
			role: "finalizer",
			disposition: "optional",
		});
	});

	it("rejects a barrier that names a finalizer", () => {
		const m = materializer();
		const report = m.agent("report", request("Report"));
		const cleanup = m.finalizer("cleanup", {
			kind: "required",
			agent: request("Cleanup"),
		});
		const commit = m.closeEpoch("result", [report]);
		const declarations = commit.events.filter(
			(event) => event.type === "task-declared",
		);
		expect(declarations).toHaveLength(2);
		expect(() =>
			reduce([
				runCreated(),
				...declarations,
				{
					type: "barrier-reached",
					data: { epoch: 1, kind: "result", taskIds: [cleanup.ref.taskId] },
				},
			]),
		).toThrow("a finalizer cannot be a barrier target");
		expect(() =>
			reduce([
				runCreated(),
				...declarations,
				{
					type: "barrier-reached",
					data: {
						epoch: 1,
						kind: "final",
						taskIds: [report.ref.taskId, cleanup.ref.taskId],
					},
				},
			]),
		).toThrow("a finalizer cannot be a barrier target");
	});

	it("rejects running -> finalizing while a required ordinary task is incomplete", () => {
		const run = finalizerGraph({ kind: "required" });
		expect(() =>
			reduce([...run.running, runStatus("running", "finalizing")]),
		).toThrow("run finalized before its required work completed");
	});

	it("rejects running -> finalizing while an optional ordinary task is pending", () => {
		const run = finalizerGraph({ kind: "required", optionalOrdinary: true });
		expect(() =>
			reduce([
				...run.running,
				...runTask(run.reportExecution, "completed"),
				runStatus("running", "finalizing"),
			]),
		).toThrow("run finalized while ordinary tasks remain active");
	});

	it("accepts running -> finalizing while a required finalizer is incomplete", () => {
		const run = finalizerGraph({ kind: "required" });
		const state = reduce([
			...run.running,
			...runTask(run.reportExecution, "completed"),
			runStatus("running", "finalizing"),
		]);
		expect(state.status).toBe("finalizing");
		expect(state.tasks[run.cleanup.id]?.status).toBe("pending");
	});

	it("rejects finalizing -> completed while a required finalizer is pending", () => {
		const run = committedFinalizerRun({ kind: "required" });
		expect(() =>
			reduce([...run.events, runStatus("finalizing", "completed")]),
		).toThrow("run completed while tasks remain unsettled");
	});

	it("rejects finalizing -> completed after a required finalizer failed", () => {
		const run = committedFinalizerRun({ kind: "required" });
		expect(() =>
			reduce([
				...run.events,
				taskStatus(run.cleanup.id, "pending", "ready"),
				executionCreated(run.cleanupExecution),
				...executionLadder(run.cleanupExecution, "failed"),
				runStatus("finalizing", "completed"),
			]),
		).toThrow("run completed before required tasks completed");
	});

	it("only admits completed-degraded after an advisory finalizer failed", () => {
		const run = committedFinalizerRun({ kind: "advisory" });
		const events: WorkflowEventInput[] = [
			...run.events,
			taskStatus(run.cleanup.id, "pending", "ready"),
			executionCreated(run.cleanupExecution),
			...executionLadder(run.cleanupExecution, "failed"),
		];
		expect(() =>
			reduce([...events, runStatus("finalizing", "completed")]),
		).toThrow("non-successful optional task requires degraded completion");
		const state = reduce([
			...events,
			runStatus("finalizing", "completed-degraded"),
		]);
		expect(state.status).toBe("completed-degraded");
		expect(state.tasks[run.cleanup.id]).toMatchObject({
			status: "failed",
			task: { spec: { role: "finalizer", disposition: "optional" } },
		});
	});

	it("only admits completed-degraded after an advisory finalizer is blocked (C2)", () => {
		const run = committedFinalizerRun(
			{ kind: "advisory", optionalOrdinary: true, finalizerAfterExtra: true },
			"failed",
		);
		expect(run.extra).toBeDefined();
		const events: WorkflowEventInput[] = [
			...run.events,
			taskStatus(
				run.cleanup.id,
				"pending",
				"blocked",
				"A dependency did not complete.",
			),
		];
		expect(reduce(events).tasks[run.cleanup.id]?.status).toBe("blocked");
		expect(() =>
			reduce([...events, runStatus("finalizing", "completed")]),
		).toThrow("non-successful optional task requires degraded completion");
		const state = reduce([
			...events,
			runStatus("finalizing", "completed-degraded"),
		]);
		expect(state.status).toBe("completed-degraded");
	});

	it("restricts invalidation after the output commit to finalizers", () => {
		const run = committedFinalizerRun({ kind: "required" });
		const failed: WorkflowEventInput[] = [
			...run.events,
			taskStatus(run.cleanup.id, "pending", "ready"),
			executionCreated(run.cleanupExecution),
			...executionLadder(run.cleanupExecution, "failed"),
			runStatus(
				"finalizing",
				"failed",
				"A required workflow task did not complete.",
			),
		];
		const state = reduce(failed);
		expect(state.outputArtifactId).toBe(run.output.id);
		const ordinary = invalidationClosure(state, run.report.id);
		expect(ordinary.taskIds).toEqual([run.report.id]);
		expect(() =>
			reduce([
				...failed,
				invalidated(run.report.id, ordinary.taskIds, ordinary.abandonedEpochs),
			]),
		).toThrow("invalidation after output commit may only cover finalizers");
		const finalizer = invalidationClosure(state, run.cleanup.id);
		expect(finalizer).toEqual({
			taskIds: [run.cleanup.id],
			abandonedEpochs: [],
		});
		const recovered = reduce([
			...failed,
			invalidated(run.cleanup.id, finalizer.taskIds, []),
			runStatus("failed", "running"),
		]);
		expect(recovered.tasks[run.cleanup.id]?.status).toBe("invalidated");
		expect(recovered.tasks[run.report.id]?.status).toBe("completed");
		expect(recovered.barriers.every((barrier) => !barrier.abandoned)).toBe(
			true,
		);
		expect(recovered.status).toBe("running");
	});

	it("makes role part of the task identity", () => {
		const ordinary = declaration(
			(() => {
				const m = materializer();
				const handle = m.agent("same", request("Same"));
				return m.closeEpoch("final", [handle]);
			})(),
			deriveTaskId("same"),
		);
		const m = materializer();
		const finalizer = m.finalizer("same", {
			kind: "required",
			agent: request("Same"),
		});
		const commit = m.closeEpoch("final", []);
		const finalizerTask = declaration(commit, finalizer.ref.taskId);
		expect(finalizerTask.id).toBe(ordinary.id);
		expect(finalizerTask.spec.role).toBe("finalizer");
		expect(ordinary.spec.role).toBe("task");
		expect(finalizerTask.spec.disposition).toBe(ordinary.spec.disposition);
		expect(finalizerTask.spec.identitySha256).not.toBe(
			ordinary.spec.identitySha256,
		);
		const {
			role: _finalizerRole,
			identitySha256: _a,
			...finalizerRest
		} = finalizerTask.spec;
		const {
			role: _ordinaryRole,
			identitySha256: _b,
			...ordinaryRest
		} = ordinary.spec;
		expect(finalizerRest).toEqual(ordinaryRest);
		const mismatched = declarationEvent(commit, finalizer.ref.taskId);
		if (mismatched.type !== "task-declared") {
			throw new Error("missing declaration");
		}
		mismatched.data.task.spec.identitySha256 = ordinary.spec.identitySha256;
		expect(() => reduce([runCreated(), mismatched])).toThrow(
			"declared task identity digest does not match",
		);
	});
});

function agentTask(task: MaterializedWorkflowTask): MaterializedAgentTask {
	if (task.spec.kind !== "agent") throw new Error("expected an agent task");
	return task as MaterializedAgentTask;
}

function deriveTaskId(key: string): WorkflowTaskId {
	const m = materializer();
	return m.agent(key, request()).ref.taskId;
}

describe("revision 16 D: snapshot round trip", () => {
	it("survives JSON serialization and passes the strict projection schema", () => {
		const m = materializer();
		const side = m.agent("side", {
			...request("Side"),
			disposition: "optional" as const,
		});
		const main = m.agent("main", request("Main", { resume: { attempts: 1 } }));
		const cleanup = m.finalizer("cleanup", {
			kind: "advisory",
			agent: { ...request("Cleanup"), after: [main.ref] },
		});
		const commit = m.closeEpoch("final", [main]);
		const sideTask = declaration(commit, side.ref.taskId);
		const mainTask = declaration(commit, main.ref.taskId);
		const sideExecution = agentExecution(sideTask, 1);
		const mainExecution = agentExecution(mainTask, 1);
		const events: WorkflowEventInput[] = [
			runCreated(),
			...commit.events,
			runStatus("created", "running"),
			// Optional ordinary task: interrupted terminal retained without release.
			taskStatus(sideTask.id, "pending", "ready"),
			executionCreated(sideExecution),
			...launchLadder(sideExecution),
			...interruptedSettlement(sideExecution),
			terminal(sideExecution, "interrupted", interruptedEvidence()),
			taskStatus(sideTask.id, "running", "interrupted", INTERRUPTED_REASON),
			// Required ordinary task: policy resume, interrupted again, then an
			// operator reopen that recovers the run.
			taskStatus(mainTask.id, "pending", "ready"),
			executionCreated(mainExecution),
			...launchLadder(mainExecution),
			...interruptedSettlement(mainExecution),
			attemptIntended(mainExecution, "policy"),
			attemptReceipted(mainExecution, 2),
			...interruptedSettlement(mainExecution, 2, attemptId(mainExecution, 2)),
			terminal(mainExecution, "interrupted", interruptedEvidence(2)),
			taskStatus(mainTask.id, "running", "interrupted", INTERRUPTED_REASON),
			runStatus(
				"running",
				"interrupted",
				"A required workflow task was interrupted.",
			),
			operatorIntent(mainExecution, {
				ordinal: 3,
				previousAttemptId: attemptId(mainExecution, 2),
			}),
			runStatus("interrupted", "running"),
		];
		const state = reduce(events);
		expect(state.status).toBe("running");
		expect(state.tasks[cleanup.ref.taskId]).toMatchObject({
			status: "pending",
			committed: true,
			task: { spec: { role: "finalizer", disposition: "optional" } },
		});
		expect(state.executions[sideExecution.id]?.terminal?.outcome).toBe(
			"interrupted",
		);
		expect(
			state.executions[mainExecution.id]?.attempts?.map(
				(attempt) => attempt.origin,
			),
		).toEqual(["policy", "operator"]);
		expect(state.executions[mainExecution.id]?.attempts?.[1]?.reason).toBe(
			OPERATOR_REASON,
		);
		expect(state.executions[mainExecution.id]?.terminal).toBeUndefined();
		const roundTrip = JSON.parse(JSON.stringify(state)) as unknown;
		expect(roundTrip).toStrictEqual(state);
		expect(Value.Check(WorkflowStateProjectionSchema, roundTrip)).toBe(true);
		expect(Value.Check(WorkflowStateProjectionSchema, state)).toBe(true);
		expect(reduce(structuredClone(events))).toEqual(state);
		for (let length = 1; length <= events.length; length += 1) {
			expect(
				Value.Check(
					WorkflowStateProjectionSchema,
					reduce(events.slice(0, length)),
				),
			).toBe(true);
		}
	});
});
