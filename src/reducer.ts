import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import {
	currentSubagentAttempt,
	currentSubagentAttemptId,
} from "./attempts.js";
import {
	type AgentTaskExecutionRecord,
	type AgentTaskSpec,
	MAX_NESTED_WORKFLOW_TASKS,
	MAX_TASK_ATTEMPTS,
	MAX_TASK_EXECUTION_GENERATIONS,
	type NestedWorkflowTaskExecutionRecord,
	type NestedWorkflowTaskSpec,
	type SubagentTerminalEvidence,
	type SupportTaskExecutionRecord,
	type SupportTaskSpec,
	type TaskExecutionId,
	type TaskExecutionOutcome,
	type WorkflowArtifactRef,
	type WorkflowTaskId,
} from "./contracts.js";
import {
	MAX_WORKFLOW_STATE_BYTES,
	type TaskExecutionProjection,
	type WorkflowEventInput,
	WorkflowEventInputSchema,
	type WorkflowStateProjection,
	WorkflowStateProjectionSchema,
	type WorkflowTaskProjection,
} from "./events.js";
import {
	deriveJsonValueSha256,
	deriveNestedWorkflowRunId,
	deriveSubagentOperationId,
	deriveSupportImplementationIdentitySha256,
	deriveTaskExecutionId,
	deriveWorkflowArtifactId,
	deriveWorkflowFailureSha256,
} from "./execution.js";
import {
	transitionWorkflowRunStatus,
	transitionWorkflowTaskStatus,
} from "./lifecycle.js";
import {
	deriveAgentTaskIdentity,
	deriveNestedWorkflowTaskIdentity,
	deriveSupportTaskIdentity,
	deriveWorkflowTaskId,
} from "./materializer.js";
import type {
	WorkflowJournalEvent,
	WorkflowRunJournal,
	WorkflowRunSnapshot,
} from "./persistence/journal.js";

export class WorkflowEventReductionError extends Error {
	constructor(
		message: string,
		readonly sequence: number,
	) {
		super(`${message} at workflow event sequence ${sequence}`);
		this.name = "WorkflowEventReductionError";
	}
}

function fail(message: string, sequence: number): never {
	throw new WorkflowEventReductionError(message, sequence);
}

function taskNamespaceKey(
	task: WorkflowStateProjection["tasks"][string]["task"],
): string {
	return [...task.namespace, task.spec.key].join("\u0000");
}

function dependencies(
	state: WorkflowStateProjection,
	taskId: WorkflowTaskId,
): Set<WorkflowTaskId> {
	const task = state.tasks[taskId]?.task;
	if (!task) return new Set();
	return new Set([
		...task.spec.after.map((dependency) => dependency.taskId),
		...Object.values(task.spec.inputs).map((input) => input.producerTaskId),
	]);
}

function transitiveDependents(
	state: WorkflowStateProjection,
	causeTaskId: WorkflowTaskId,
): Set<WorkflowTaskId> {
	const selected = new Set<WorkflowTaskId>([causeTaskId]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const taskId of Object.keys(state.tasks) as WorkflowTaskId[]) {
			if (selected.has(taskId)) continue;
			if ([...dependencies(state, taskId)].some((id) => selected.has(id))) {
				selected.add(taskId);
				changed = true;
			}
		}
	}
	return selected;
}

function isOnPath(task: WorkflowTaskProjection): boolean {
	return task.abandoned !== true;
}

function pathTasks(state: WorkflowStateProjection): WorkflowTaskProjection[] {
	return Object.values(state.tasks).filter(isOnPath);
}

function isFinalizer(task: WorkflowTaskProjection): boolean {
	return task.task.spec.role === "finalizer";
}

/** An operator resume intent that has neither been receipted nor declined. */
function hasOpenOperatorIntent(state: WorkflowStateProjection): boolean {
	return pathTasks(state).some((task) => {
		const execution = task.currentExecutionId
			? state.executions[task.currentExecutionId]
			: undefined;
		const open = execution?.attempts?.at(-1);
		return (
			execution?.phase === "attempt-intended" &&
			open?.origin === "operator" &&
			open.receiptSequence === undefined &&
			open.declinedSequence === undefined
		);
	});
}

function pathBarriers(
	state: WorkflowStateProjection,
): WorkflowStateProjection["barriers"][number][] {
	return state.barriers.filter((barrier) => barrier.abandoned !== true);
}

function hasPathFinalBarrier(state: WorkflowStateProjection): boolean {
	return pathBarriers(state).some((barrier) => barrier.kind === "final");
}

function maxMaterializationSequence(state: WorkflowStateProjection): number {
	return Object.values(state.tasks).reduce(
		(max, task) => Math.max(max, task.task.materializationSequence),
		0,
	);
}

function currentExecutionIsActive(
	state: WorkflowStateProjection,
	task: WorkflowTaskProjection,
): boolean {
	const execution = task.currentExecutionId
		? state.executions[task.currentExecutionId]
		: undefined;
	return execution !== undefined && execution.phase !== "terminal";
}

/** The result artifact produced by the task's current execution, if any. */
function currentResultArtifact(
	state: WorkflowStateProjection,
	taskId: WorkflowTaskId,
): WorkflowArtifactRef | undefined {
	const task = state.tasks[taskId];
	if (!task?.currentExecutionId) return undefined;
	return Object.values(state.artifacts).find(
		(artifact) =>
			artifact.producerTaskId === taskId &&
			artifact.output === "result" &&
			artifact.producerExecutionId === task.currentExecutionId,
	);
}

export interface WorkflowInvalidationClosure {
	readonly taskIds: WorkflowTaskId[];
	readonly abandonedEpochs: number[];
}

/**
 * The exact invalidation closure for a cause task: the cause plus every
 * transitive dependent that is not already invalidated, and the on-path
 * epochs after the first on-path barrier exposing any closure task.
 */
export function invalidationClosure(
	state: WorkflowStateProjection,
	causeTaskId: WorkflowTaskId,
): WorkflowInvalidationClosure {
	const cause = state.tasks[causeTaskId];
	if (!cause) throw new Error("invalidation cause task is unknown");
	if (cause.status === "invalidated") {
		throw new Error("invalidation cause is already invalidated");
	}
	const closure = new Set(
		[...transitiveDependents(state, causeTaskId)].filter(
			(taskId) => state.tasks[taskId]?.status !== "invalidated",
		),
	);
	for (const taskId of closure) {
		const generations = Object.values(state.executions).filter(
			(execution) => execution.execution.taskId === taskId,
		).length;
		if (generations >= MAX_TASK_EXECUTION_GENERATIONS) {
			throw new Error("task execution generation bound exceeded");
		}
	}
	const exposing = pathBarriers(state).find((barrier) =>
		barrier.taskIds.some((taskId) => closure.has(taskId)),
	);
	const abandonedEpochs = exposing
		? pathBarriers(state)
				.filter((barrier) => barrier.epoch > exposing.epoch)
				.map((barrier) => barrier.epoch)
		: [];
	return {
		taskIds: [...closure].sort(),
		abandonedEpochs: abandonedEpochs.sort((left, right) => left - right),
	};
}

function executionProjection(
	state: WorkflowStateProjection,
	executionId: TaskExecutionId,
	sequence: number,
) {
	const execution = state.executions[executionId];
	if (!execution) fail("task execution is unknown", sequence);
	return execution;
}

type AgentExecutionProjection = TaskExecutionProjection & {
	execution: AgentTaskExecutionRecord;
};

type SupportExecutionProjection = TaskExecutionProjection & {
	execution: SupportTaskExecutionRecord;
};

type NestedExecutionProjection = TaskExecutionProjection & {
	execution: NestedWorkflowTaskExecutionRecord;
};

function describeKind(kind: "agent" | "support" | "workflow"): string {
	return kind === "agent" ? "an agent" : `a ${kind}`;
}

function isAgentExecution(
	projection: TaskExecutionProjection,
): projection is AgentExecutionProjection {
	return projection.execution.kind === "agent";
}

function isSupportExecution(
	projection: TaskExecutionProjection,
): projection is SupportExecutionProjection {
	return projection.execution.kind === "support";
}

function isNestedExecution(
	projection: TaskExecutionProjection,
): projection is NestedExecutionProjection {
	return projection.execution.kind === "workflow";
}

function agentExecutionProjection(
	state: WorkflowStateProjection,
	executionId: TaskExecutionId,
	sequence: number,
): AgentExecutionProjection {
	const projection = executionProjection(state, executionId, sequence);
	if (!isAgentExecution(projection)) {
		fail(
			`subagent execution event targets ${describeKind(projection.execution.kind)} execution`,
			sequence,
		);
	}
	return projection;
}

function supportExecutionProjection(
	state: WorkflowStateProjection,
	executionId: TaskExecutionId,
	sequence: number,
): SupportExecutionProjection {
	const projection = executionProjection(state, executionId, sequence);
	if (!isSupportExecution(projection)) {
		fail(
			`support execution event targets ${describeKind(projection.execution.kind)} execution`,
			sequence,
		);
	}
	return projection;
}

function nestedExecutionProjection(
	state: WorkflowStateProjection,
	executionId: TaskExecutionId,
	sequence: number,
): NestedExecutionProjection {
	const projection = executionProjection(state, executionId, sequence);
	if (!isNestedExecution(projection)) {
		fail(
			`nested workflow execution event targets ${describeKind(projection.execution.kind)} execution`,
			sequence,
		);
	}
	return projection;
}

function nestedTaskSpec(
	state: WorkflowStateProjection,
	projection: NestedExecutionProjection,
	sequence: number,
): NestedWorkflowTaskSpec {
	const spec = state.tasks[projection.execution.taskId]?.task.spec;
	if (spec?.kind !== "workflow") {
		fail("nested workflow execution target is not a workflow task", sequence);
	}
	return spec;
}

function agentTaskSpec(
	state: WorkflowStateProjection,
	projection: AgentExecutionProjection,
	sequence: number,
): AgentTaskSpec {
	const spec = state.tasks[projection.execution.taskId]?.task.spec;
	if (spec?.kind !== "agent") {
		fail("subagent execution target is not an agent task", sequence);
	}
	return spec;
}

function receiptedAttempts(
	projection: TaskExecutionProjection,
	kind?: "retry" | "resume",
): number {
	return (projection.attempts ?? []).filter(
		(attempt) =>
			attempt.receiptSequence !== undefined &&
			(kind === undefined || attempt.kind === kind),
	).length;
}

function isTerminalRunStatus(status: string): boolean {
	return (
		status === "completed" ||
		status === "completed-degraded" ||
		status === "failed" ||
		status === "cancelled" ||
		status === "interrupted" ||
		status === "cleanup-blocked"
	);
}

function isCompletedRunStatus(status: string): boolean {
	return status === "completed" || status === "completed-degraded";
}

function nestedOutcome(status: string): TaskExecutionOutcome | undefined {
	switch (status) {
		case "completed":
		case "completed-degraded":
			return "completed";
		case "failed":
		case "cancelled":
		case "interrupted":
		case "cleanup-blocked":
			return status;
		default:
			return undefined;
	}
}

function isLaunchedNestedPhase(
	phase: TaskExecutionProjection["phase"],
): boolean {
	return (
		phase === "nested-launched" ||
		phase === "nested-settled" ||
		phase === "nested-output-imported"
	);
}

function supportTaskSpec(
	state: WorkflowStateProjection,
	projection: SupportExecutionProjection,
	sequence: number,
): SupportTaskSpec {
	const spec = state.tasks[projection.execution.taskId]?.task.spec;
	if (spec?.kind !== "support") {
		fail("support execution target is not a support task", sequence);
	}
	return spec;
}

function taskInputsSha256(
	state: WorkflowStateProjection,
	spec: SupportTaskSpec | NestedWorkflowTaskSpec,
	sequence: number,
): string {
	const inputs: Record<string, string> = {};
	for (const [name, input] of Object.entries(spec.inputs)) {
		const artifact = currentResultArtifact(state, input.producerTaskId);
		if (!artifact) {
			fail(
				`${spec.kind === "support" ? "support" : "workflow"} task input artifact is missing or ambiguous`,
				sequence,
			);
		}
		inputs[name] = artifact.sha256;
	}
	return deriveJsonValueSha256(inputs);
}

function isTerminalSubagentStatus(status: string): boolean {
	return (
		status === "completed" ||
		status === "failed" ||
		status === "cancelled" ||
		status === "abandoned" ||
		status === "interrupted" ||
		status === "cleanup-blocked"
	);
}

function cleanupProved(value: "proved" | "not-needed" | string): boolean {
	return value === "proved" || value === "not-needed";
}

function observedStatusCanFollow(previous: string, next: string): boolean {
	if (previous === next || isTerminalSubagentStatus(previous)) return false;
	if (previous === "queued") return true;
	if (previous === "active") return next !== "queued";
	if (previous === "stopping") {
		return next === "cancelled" || next === "cleanup-blocked";
	}
	return false;
}

function validSubagentSettlement(evidence: SubagentTerminalEvidence): boolean {
	const cleanupIsProved =
		cleanupProved(evidence.sandboxCleanup) &&
		cleanupProved(evidence.workspaceCleanup);
	if (evidence.status === "completed") {
		return (
			cleanupIsProved &&
			evidence.failure === undefined &&
			evidence.structuredOutputSha256 !== undefined
		);
	}
	if (!evidence.failure) return false;
	if (evidence.status === "cleanup-blocked") return !cleanupIsProved;
	if (evidence.status === "abandoned") {
		return (
			cleanupIsProved &&
			evidence.failure.code === "operator-abandoned" &&
			evidence.failure.origin === "operator" &&
			evidence.failure.retry === "never" &&
			evidence.output === undefined &&
			evidence.structuredOutputSha256 === undefined
		);
	}
	return cleanupIsProved;
}

function isSupportFailureStage(stage: string): boolean {
	return (
		stage === "support-resolution" ||
		stage === "support-input" ||
		stage === "support-execution" ||
		stage === "support-output"
	);
}

function isNestedFailureStage(stage: string): boolean {
	return (
		stage === "nested-resolution" ||
		stage === "nested-launch" ||
		stage === "nested-import" ||
		stage === "nested-input"
	);
}

function subagentOutcome(status: string): TaskExecutionOutcome | undefined {
	switch (status) {
		case "completed":
		case "failed":
		case "cancelled":
		case "interrupted":
		case "cleanup-blocked":
			return status;
		case "abandoned":
			return "cancelled";
		default:
			return undefined;
	}
}

function applyEvent(
	state: WorkflowStateProjection,
	event: WorkflowJournalEvent,
	input: WorkflowEventInput,
): void {
	if (
		input.type.startsWith("task-execution-") &&
		(state.status === "completed" ||
			state.status === "completed-degraded" ||
			state.status === "cancelled")
	) {
		fail("terminal workflow run may not change task execution", event.sequence);
	}
	switch (input.type) {
		case "run-created":
			throw new WorkflowEventReductionError(
				"duplicate run-created event",
				event.sequence,
			);
		case "workflow-effect": {
			if (
				state.status === "completed" ||
				state.status === "completed-degraded" ||
				state.status === "cancelled"
			) {
				fail("terminal workflow run may not append effects", event.sequence);
			}
			if (input.data.ordinal !== state.effects.length + 1) {
				fail("workflow effect ordinal is not contiguous", event.sequence);
			}
			if (input.data.kind === "phase" && input.data.value.length > 128) {
				fail("workflow phase exceeds length limit", event.sequence);
			}
			state.effects.push({ ...input.data, sequence: event.sequence });
			break;
		}
		case "task-declared": {
			const task = structuredClone(input.data.task);
			if (
				state.status === "completed" ||
				state.status === "completed-degraded" ||
				state.status === "cancelled"
			) {
				fail("terminal workflow run may not declare tasks", event.sequence);
			}
			if (hasPathFinalBarrier(state)) {
				fail("task declaration follows the final barrier", event.sequence);
			}
			if (task.runId !== state.runId) {
				fail("declared task belongs to another run", event.sequence);
			}
			if (task.definitionIdentitySha256 !== state.definitionIdentitySha256) {
				fail(
					"declared task definition identity does not match",
					event.sequence,
				);
			}
			if (
				task.id !==
				deriveWorkflowTaskId(state.runId, task.namespace, task.spec.key)
			) {
				fail("declared task ID is not deterministic", event.sequence);
			}
			let identitySha256: string;
			let derivedIdentity: string;
			if (task.spec.kind === "agent") {
				const { identitySha256: identity, ...spec } = task.spec;
				identitySha256 = identity;
				derivedIdentity = deriveAgentTaskIdentity({
					definitionIdentitySha256: state.definitionIdentitySha256,
					inputSha256: state.inputSha256,
					namespace: task.namespace,
					spec,
				});
			} else if (task.spec.kind === "support") {
				const { identitySha256: identity, ...spec } = task.spec;
				identitySha256 = identity;
				derivedIdentity = deriveSupportTaskIdentity({
					definitionIdentitySha256: state.definitionIdentitySha256,
					inputSha256: state.inputSha256,
					namespace: task.namespace,
					spec,
				});
			} else {
				const { identitySha256: identity, ...spec } = task.spec;
				identitySha256 = identity;
				derivedIdentity = deriveNestedWorkflowTaskIdentity({
					definitionIdentitySha256: state.definitionIdentitySha256,
					inputSha256: state.inputSha256,
					namespace: task.namespace,
					spec,
				});
				const workflowTaskCount = Object.values(state.tasks).filter(
					(existing) =>
						existing.task.spec.kind === "workflow" &&
						existing.task.id !== task.id,
				).length;
				if (workflowTaskCount + 1 > MAX_NESTED_WORKFLOW_TASKS) {
					fail(
						"workflow task count exceeds the nested workflow bound",
						event.sequence,
					);
				}
				if (
					spec.request.inputSha256 !== deriveJsonValueSha256(spec.request.input)
				) {
					fail(
						"workflow task input digest does not match its input",
						event.sequence,
					);
				}
			}
			if (identitySha256 !== derivedIdentity) {
				fail("declared task identity digest does not match", event.sequence);
			}
			// A declaration for an existing id readopts an abandoned task onto the
			// current path when everything but its position fields is unchanged.
			const readopted = state.tasks[task.id];
			if (readopted) {
				const {
					materializationSequence: _previousSequence,
					materializationEpoch: _previousEpoch,
					epochPosition: _previousPosition,
					...previousRecord
				} = readopted.task;
				const {
					materializationSequence: _sequence,
					materializationEpoch: _epoch,
					epochPosition: _position,
					...nextRecord
				} = task;
				if (
					readopted.abandoned !== true ||
					!isDeepStrictEqual(previousRecord, nextRecord)
				) {
					fail("duplicate workflow task ID", event.sequence);
				}
			}
			if (
				Object.values(state.tasks).some(
					(existing) =>
						existing.task.id !== task.id &&
						taskNamespaceKey(existing.task) === taskNamespaceKey(task),
				)
			) {
				fail("duplicate workflow task namespace and key", event.sequence);
			}
			if (
				task.materializationSequence !==
				maxMaterializationSequence(state) + 1
			) {
				fail("task materialization sequence is not contiguous", event.sequence);
			}
			if (task.materializationEpoch !== state.currentEpoch) {
				fail("task declaration is outside the current epoch", event.sequence);
			}
			const epochTaskCount = Object.values(state.tasks).filter(
				(existing) => existing.task.materializationEpoch === state.currentEpoch,
			).length;
			if (task.epochPosition !== epochTaskCount + 1) {
				fail("task epoch position is not contiguous", event.sequence);
			}
			const orderedDependencies = [...task.spec.after].sort((left, right) =>
				left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0,
			);
			if (!isDeepStrictEqual(task.spec.after, orderedDependencies)) {
				fail("task order dependencies are not canonical", event.sequence);
			}
			const explicitDependencies = new Set(
				task.spec.after.map((dependency) => {
					const target = state.tasks[dependency.taskId];
					if (dependency.runId !== state.runId || !target) {
						fail("task order dependency is unknown", event.sequence);
					}
					if (!isOnPath(target)) {
						fail("task dependency is abandoned", event.sequence);
					}
					if (task.spec.role === "task" && isFinalizer(target)) {
						fail("ordinary task may not depend on a finalizer", event.sequence);
					}
					return dependency.taskId;
				}),
			);
			for (const inputRef of Object.values(task.spec.inputs)) {
				const producer = state.tasks[inputRef.producerTaskId];
				if (inputRef.runId !== state.runId || !producer) {
					fail("task data dependency is unknown", event.sequence);
				}
				if (!isOnPath(producer)) {
					fail("task dependency is abandoned", event.sequence);
				}
				if (task.spec.role === "task" && isFinalizer(producer)) {
					fail("ordinary task may not depend on a finalizer", event.sequence);
				}
				if (!explicitDependencies.has(inputRef.producerTaskId)) {
					fail(
						"task data dependency lacks its order dependency",
						event.sequence,
					);
				}
			}
			if (readopted) {
				readopted.task = task;
				delete readopted.abandoned;
			} else {
				state.tasks[task.id] = { task, status: "pending", committed: false };
			}
			break;
		}
		case "artifact-declared": {
			if (
				state.status === "completed" ||
				state.status === "completed-degraded" ||
				state.status === "cancelled"
			) {
				fail("terminal workflow run may not declare artifacts", event.sequence);
			}
			const artifact = structuredClone(input.data.artifact);
			if (artifact.runId !== state.runId) {
				fail("artifact belongs to another run", event.sequence);
			}
			if (state.artifacts[artifact.id]) {
				fail("duplicate workflow artifact ID", event.sequence);
			}
			if (
				(artifact.producerTaskId === undefined) !==
					(artifact.output === undefined) ||
				(artifact.producerTaskId === undefined) !==
					(artifact.producerExecutionId === undefined)
			) {
				fail(
					"artifact producer, execution, and output identity must appear together",
					event.sequence,
				);
			}
			if (
				artifact.producerTaskId !== undefined &&
				artifact.producerExecutionId !== undefined
			) {
				const producer = state.tasks[artifact.producerTaskId];
				if (!producer) {
					fail("artifact producer is unknown", event.sequence);
				}
				if (!producer.committed) {
					fail("artifact producer is not committed", event.sequence);
				}
				if (
					state.executions[artifact.producerExecutionId]?.execution.taskId !==
					artifact.producerTaskId
				) {
					fail("artifact producer execution does not match", event.sequence);
				}
				if (
					artifact.output !== undefined &&
					artifact.id !==
						deriveWorkflowArtifactId({
							runId: artifact.runId,
							producerTaskId: artifact.producerTaskId,
							producerExecutionId: artifact.producerExecutionId,
							output: artifact.output,
							schemaSha256: artifact.schemaSha256,
							sha256: artifact.sha256,
						})
				) {
					fail("artifact identity is not deterministic", event.sequence);
				}
			} else if (
				artifact.id !==
				deriveWorkflowArtifactId({
					runId: artifact.runId,
					schemaSha256: artifact.schemaSha256,
					sha256: artifact.sha256,
				})
			) {
				fail("artifact identity is not deterministic", event.sequence);
			}
			if (
				artifact.producerTaskId !== undefined &&
				Object.values(state.artifacts).some(
					(existing) =>
						existing.producerTaskId === artifact.producerTaskId &&
						existing.producerExecutionId === artifact.producerExecutionId &&
						existing.output === artifact.output,
				)
			) {
				fail("artifact output identity is ambiguous", event.sequence);
			}
			state.artifacts[artifact.id] = artifact;
			break;
		}
		case "barrier-reached": {
			if (
				state.status === "completed" ||
				state.status === "completed-degraded" ||
				state.status === "cancelled"
			) {
				fail("terminal workflow run may not reach a barrier", event.sequence);
			}
			if (input.data.epoch !== state.currentEpoch) {
				fail("barrier does not close the current epoch", event.sequence);
			}
			if (hasPathFinalBarrier(state)) {
				fail(
					"an event follows the final materialization barrier",
					event.sequence,
				);
			}
			for (const taskId of input.data.taskIds) {
				const target = state.tasks[taskId];
				if (!target) {
					fail("barrier references an unknown task", event.sequence);
				}
				if (!isOnPath(target)) {
					fail("barrier references an abandoned task", event.sequence);
				}
				if (isFinalizer(target)) {
					fail("a finalizer cannot be a barrier target", event.sequence);
				}
			}
			for (const task of Object.values(state.tasks)) {
				if (task.task.materializationEpoch === state.currentEpoch) {
					task.committed = true;
				}
			}
			state.barriers.push({
				...input.data,
				taskIds: [...input.data.taskIds],
				sequence: event.sequence,
			});
			state.currentEpoch += 1;
			break;
		}
		case "task-execution-created": {
			const execution = structuredClone(input.data.execution);
			const task = state.tasks[execution.taskId];
			if (!task?.committed) {
				fail("task execution target is unknown or uncommitted", event.sequence);
			}
			if (task.status !== "ready") {
				fail("task execution requires a ready task", event.sequence);
			}
			if (isFinalizer(task)) {
				if (
					state.status !== "finalizing" ||
					state.outputArtifactId === undefined
				) {
					fail(
						"finalizer execution requires a finalizing workflow run",
						event.sequence,
					);
				}
			} else if (state.status !== "running" && state.status !== "waiting") {
				fail("task execution requires a running workflow run", event.sequence);
			}
			if (!isOnPath(task)) {
				fail("abandoned task may not execute", event.sequence);
			}
			if (
				execution.runId !== state.runId ||
				execution.taskIdentitySha256 !== task.task.spec.identitySha256
			) {
				fail("task execution identity does not match its task", event.sequence);
			}
			const previousGenerations = Object.values(state.executions).filter(
				(candidate) => candidate.execution.taskId === execution.taskId,
			);
			if (execution.generation !== previousGenerations.length + 1) {
				fail("task execution generation is not contiguous", event.sequence);
			}
			if (execution.generation > MAX_TASK_EXECUTION_GENERATIONS) {
				fail("task execution generation bound exceeded", event.sequence);
			}
			if (currentExecutionIsActive(state, task)) {
				fail("task execution supersedes an active execution", event.sequence);
			}
			// Re-materialization clears the current execution pointer; a terminal
			// execution still current here is a crash window awaiting repair.
			if (task.currentExecutionId) {
				fail("task execution is duplicate or already current", event.sequence);
			}
			if (
				execution.id !==
				deriveTaskExecutionId(
					state.runId,
					execution.taskId,
					execution.generation,
				)
			) {
				fail(
					"task execution identifiers are not deterministic",
					event.sequence,
				);
			}
			if (task.task.spec.kind === "agent") {
				if (execution.kind !== "agent") {
					fail("task execution kind does not match its task", event.sequence);
				}
				if (
					execution.operationId !==
					deriveSubagentOperationId(
						state.runId,
						execution.taskId,
						execution.generation,
					)
				) {
					fail(
						"task execution identifiers are not deterministic",
						event.sequence,
					);
				}
			} else if (task.task.spec.kind === "support") {
				if (execution.kind !== "support") {
					fail("task execution kind does not match its task", event.sequence);
				}
				if (
					execution.implementationIdentitySha256 !==
					deriveSupportImplementationIdentitySha256(
						task.task.spec.request.implementation,
					)
				) {
					fail(
						"support task execution implementation identity does not match",
						event.sequence,
					);
				}
			} else {
				if (execution.kind !== "workflow") {
					fail("task execution kind does not match its task", event.sequence);
				}
				if (
					execution.childRunId !==
					deriveNestedWorkflowRunId(
						state.runId,
						execution.taskId,
						execution.generation,
					)
				) {
					fail(
						"task execution identifiers are not deterministic",
						event.sequence,
					);
				}
			}
			if (state.executions[execution.id]) {
				fail("task execution is duplicate or already current", event.sequence);
			}
			state.executions[execution.id] = {
				execution,
				phase: "created",
				createdSequence: event.sequence,
			};
			task.currentExecutionId = execution.id;
			break;
		}
		case "task-execution-preflighted": {
			const projection = agentExecutionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			const previousPreflight = projection.preflight;
			const replacesPreflight = projection.phase === "preflighted";
			if (
				(projection.phase !== "created" && !replacesPreflight) ||
				input.data.operationId !== projection.execution.operationId ||
				(!replacesPreflight &&
					input.data.supersedesPreflightId !== undefined) ||
				(replacesPreflight &&
					(!previousPreflight ||
						input.data.supersedesPreflightId !==
							previousPreflight.preflightId ||
						(Date.parse(previousPreflight.expiresAt) >
							Date.parse(event.timestamp) &&
							event.fencingGeneration <= previousPreflight.fencingGeneration)))
			) {
				fail("task execution preflight is out of order", event.sequence);
			}
			const { executionId: _executionId, ...preflight } = input.data;
			projection.preflight = {
				...preflight,
				fencingGeneration: event.fencingGeneration,
				sequence: event.sequence,
			};
			projection.phase = "preflighted";
			break;
		}
		case "task-execution-launch-intended": {
			const projection = agentExecutionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			const preflight = projection.preflight;
			if (
				projection.phase !== "preflighted" ||
				!preflight ||
				input.data.operationId !== projection.execution.operationId ||
				input.data.preflightId !== preflight.preflightId ||
				input.data.planIdentitySha256 !== preflight.planIdentitySha256 ||
				Date.parse(preflight.expiresAt) <= Date.parse(event.timestamp)
			) {
				fail("task execution launch intent is out of order", event.sequence);
			}
			const { executionId: _executionId, ...launchIntent } = input.data;
			projection.launchIntent = { ...launchIntent, sequence: event.sequence };
			projection.phase = "launch-intended";
			break;
		}
		case "task-execution-launch-uncertain": {
			const projection = agentExecutionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			if (
				projection.phase !== "launch-intended" ||
				input.data.operationId !== projection.execution.operationId
			) {
				fail("uncertain task launch is out of order", event.sequence);
			}
			const { executionId: _executionId, ...launchUncertain } = input.data;
			projection.launchUncertain = {
				...launchUncertain,
				sequence: event.sequence,
			};
			projection.phase = "launch-uncertain";
			break;
		}
		case "task-execution-launch-absent": {
			const projection = agentExecutionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			if (
				projection.phase !== "launch-uncertain" ||
				input.data.operationId !== projection.execution.operationId
			) {
				fail("absent task launch evidence is out of order", event.sequence);
			}
			const { executionId: _executionId, ...launchAbsent } = input.data;
			projection.launchAbsent = { ...launchAbsent, sequence: event.sequence };
			projection.phase = "launch-absent";
			break;
		}
		case "task-execution-launch-receipted": {
			const projection = agentExecutionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			if (
				(projection.phase !== "launch-intended" &&
					projection.phase !== "launch-uncertain") ||
				input.data.operationId !== projection.execution.operationId ||
				input.data.subagentRunId !==
					projection.preflight?.plannedSubagentRunId ||
				input.data.subagentAttemptId !==
					projection.preflight?.plannedSubagentAttemptId ||
				Object.values(state.executions).some(
					(candidate) =>
						candidate.execution.id !== projection.execution.id &&
						candidate.launchReceipt?.subagentRunId === input.data.subagentRunId,
				)
			) {
				fail("task execution launch receipt is out of order", event.sequence);
			}
			const { executionId: _executionId, ...launchReceipt } = input.data;
			projection.launchReceipt = { ...launchReceipt, sequence: event.sequence };
			projection.phase = "launched";
			break;
		}
		case "task-execution-child-observed": {
			const projection = agentExecutionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			const receipt = projection.launchReceipt;
			const attempt = currentSubagentAttempt(projection);
			const previousObservation = projection.observation;
			const previousStatus = previousObservation?.status ?? attempt?.status;
			const reconcilesCleanup =
				projection.phase === "terminal" &&
				projection.terminal?.outcome === "cleanup-blocked" &&
				previousStatus === "cleanup-blocked" &&
				isTerminalSubagentStatus(input.data.status) &&
				input.data.status !== "cleanup-blocked";
			const reconcilesRelease =
				projection.phase === "released" &&
				previousStatus === "cleanup-blocked" &&
				projection.release?.status === input.data.status &&
				isTerminalSubagentStatus(input.data.status) &&
				input.data.status !== "cleanup-blocked";
			if (
				(projection.phase !== "launched" &&
					projection.phase !== "observed" &&
					!reconcilesCleanup &&
					!reconcilesRelease) ||
				!receipt ||
				!attempt ||
				input.data.subagentRunId !== receipt.subagentRunId ||
				input.data.subagentAttemptId !== attempt.subagentAttemptId ||
				!previousStatus ||
				(!reconcilesCleanup &&
					!reconcilesRelease &&
					(previousObservation
						? !observedStatusCanFollow(previousStatus, input.data.status)
						: input.data.status !== previousStatus &&
							!observedStatusCanFollow(previousStatus, input.data.status)))
			) {
				fail("task execution child observation is invalid", event.sequence);
			}
			if (reconcilesCleanup) delete projection.terminal;
			const { executionId: _executionId, ...observation } = input.data;
			projection.observation = { ...observation, sequence: event.sequence };
			projection.phase = "observed";
			break;
		}
		case "task-execution-child-settled": {
			const projection = agentExecutionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			const observation = projection.observation;
			const evidence = structuredClone(input.data.evidence);
			if (
				projection.phase !== "observed" ||
				!observation ||
				!isTerminalSubagentStatus(observation.status) ||
				observation.status !== evidence.status ||
				!validSubagentSettlement(evidence)
			) {
				fail("task execution child settlement is invalid", event.sequence);
			}
			if (evidence.attemptOrdinal !== 1 + receiptedAttempts(projection)) {
				fail(
					"task execution child settlement attempt ordinal does not match",
					event.sequence,
				);
			}
			projection.settlement = { evidence, sequence: event.sequence };
			projection.phase =
				projection.release?.status === evidence.status ? "released" : "settled";
			break;
		}
		case "task-execution-attempt-intended": {
			const projection = agentExecutionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			const spec = agentTaskSpec(state, projection, event.sequence);
			const receipt = projection.launchReceipt;
			const settlement = projection.settlement;
			const attempts = projection.attempts ?? [];
			const task = state.tasks[projection.execution.taskId];
			const origin = input.data.origin;
			// An operator may reopen an interrupted execution that was terminalized
			// without release; the terminal record is dropped when the intent lands.
			const reopens =
				projection.phase === "terminal" &&
				projection.terminal?.outcome === "interrupted" &&
				projection.terminal.evidence.kind === "subagent";
			if (origin === "policy") {
				if (input.data.reason !== undefined) {
					fail("policy attempt intent may not carry a reason", event.sequence);
				}
				if (projection.attemptsClosed) {
					fail("task execution attempt intents are closed", event.sequence);
				}
				if (
					projection.phase !== "settled" ||
					!receipt ||
					!settlement ||
					projection.releaseIntent !== undefined
				) {
					fail("task execution attempt intent is out of order", event.sequence);
				}
				// Finalizer tasks settle while the run is finalizing; their
				// declared policies apply there like anywhere else.
				if (
					state.status !== "running" &&
					state.status !== "waiting" &&
					state.status !== "finalizing"
				) {
					fail(
						"task execution attempt intent requires a running workflow run",
						event.sequence,
					);
				}
			} else {
				if (input.data.kind !== "resume") {
					fail("operator attempt intent requires a resume", event.sequence);
				}
				if (
					(projection.phase !== "settled" && !reopens) ||
					!receipt ||
					!settlement ||
					projection.releaseIntent !== undefined ||
					projection.release !== undefined
				) {
					fail(
						"operator attempt intent requires an unreleased interrupted execution",
						event.sequence,
					);
				}
				if (
					!task ||
					task.currentExecutionId !== projection.execution.id ||
					!isOnPath(task) ||
					task.status === "invalidated"
				) {
					fail(
						"operator attempt intent targets a superseded execution",
						event.sequence,
					);
				}
				if (
					state.status !== "running" &&
					state.status !== "waiting" &&
					state.status !== "interrupted"
				) {
					fail(
						"operator attempt intent requires a running or interrupted workflow run",
						event.sequence,
					);
				}
			}
			if (
				input.data.subagentRunId !== receipt.subagentRunId ||
				input.data.previousAttemptId !== currentSubagentAttemptId(projection)
			) {
				fail(
					"task execution attempt intent does not match the current attempt",
					event.sequence,
				);
			}
			if (
				input.data.ordinal !== 2 + attempts.length ||
				input.data.ordinal > MAX_TASK_ATTEMPTS
			) {
				fail(
					"task execution attempt ordinal is not contiguous",
					event.sequence,
				);
			}
			const failure = settlement.evidence.failure;
			if (input.data.kind === "retry") {
				const retryClass = failure?.retry;
				if (
					settlement.evidence.status !== "failed" ||
					!failure ||
					(retryClass !== "backoff" && retryClass !== "manual")
				) {
					fail(
						"task execution retry intent requires a retryable failed settlement",
						event.sequence,
					);
				}
				if (
					input.data.failureCode !== failure.code ||
					input.data.failureRetry !== retryClass
				) {
					fail(
						"task execution attempt intent does not match the settled failure",
						event.sequence,
					);
				}
				const policy = spec.request.retry;
				if (!policy) {
					fail(
						"task execution retry intent lacks a retry policy",
						event.sequence,
					);
				}
				if (!policy.on.includes(retryClass)) {
					fail(
						"task execution retry intent failure class is not covered by the retry policy",
						event.sequence,
					);
				}
				if (receiptedAttempts(projection, "retry") >= policy.attempts) {
					fail(
						"task execution retry intent exceeds the retry policy",
						event.sequence,
					);
				}
			} else {
				if (
					settlement.evidence.status !== "interrupted" ||
					!failure ||
					failure.retry !== "resume"
				) {
					fail(
						"task execution resume intent requires a resumable interrupted settlement",
						event.sequence,
					);
				}
				if (
					input.data.failureCode !== failure.code ||
					input.data.failureRetry !== "resume"
				) {
					fail(
						"task execution attempt intent does not match the settled failure",
						event.sequence,
					);
				}
				// Operator intents carry their own evidence and are not bounded by
				// the authored resume policy.
				if (origin === "policy") {
					const policy = spec.request.resume;
					if (!policy) {
						fail(
							"task execution resume intent lacks a resume policy",
							event.sequence,
						);
					}
					if (receiptedAttempts(projection, "resume") >= policy.attempts) {
						fail(
							"task execution resume intent exceeds the resume policy",
							event.sequence,
						);
					}
				}
			}
			if (reopens) delete projection.terminal;
			projection.attempts = [
				...attempts,
				{
					kind: input.data.kind,
					ordinal: input.data.ordinal,
					previousAttemptId: input.data.previousAttemptId,
					origin,
					...(input.data.reason === undefined
						? {}
						: { reason: input.data.reason }),
					intentSequence: event.sequence,
				},
			];
			projection.phase = "attempt-intended";
			break;
		}
		case "task-execution-attempt-receipted": {
			const projection = agentExecutionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			const receipt = projection.launchReceipt;
			const settlement = projection.settlement;
			const attempts = projection.attempts ?? [];
			const open = attempts.at(-1);
			if (
				projection.phase !== "attempt-intended" ||
				!receipt ||
				!settlement ||
				!open ||
				open.receiptSequence !== undefined ||
				open.declinedSequence !== undefined
			) {
				fail("task execution attempt receipt is out of order", event.sequence);
			}
			if (
				input.data.ordinal !== open.ordinal ||
				input.data.subagentRunId !== receipt.subagentRunId
			) {
				fail(
					"task execution attempt receipt does not match its intent",
					event.sequence,
				);
			}
			if (
				input.data.subagentAttemptId === open.previousAttemptId ||
				input.data.subagentAttemptId === receipt.subagentAttemptId ||
				attempts.some(
					(attempt) =>
						attempt.subagentAttemptId === input.data.subagentAttemptId,
				)
			) {
				fail(
					"task execution attempt receipt reuses a subagent attempt identity",
					event.sequence,
				);
			}
			open.subagentAttemptId = input.data.subagentAttemptId;
			open.status = input.data.status;
			open.receiptSequence = event.sequence;
			projection.priorSettlements = [
				...(projection.priorSettlements ?? []),
				settlement,
			];
			delete projection.observation;
			delete projection.settlement;
			projection.phase = "launched";
			break;
		}
		case "task-execution-attempt-declined": {
			const projection = agentExecutionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			const receipt = projection.launchReceipt;
			const open = projection.attempts?.at(-1);
			if (
				projection.phase !== "attempt-intended" ||
				!receipt ||
				!projection.settlement ||
				!open ||
				open.receiptSequence !== undefined ||
				open.declinedSequence !== undefined
			) {
				fail("task execution attempt decline is out of order", event.sequence);
			}
			if (
				input.data.ordinal !== open.ordinal ||
				input.data.subagentRunId !== receipt.subagentRunId
			) {
				fail(
					"task execution attempt decline does not match its intent",
					event.sequence,
				);
			}
			open.declinedSequence = event.sequence;
			projection.attemptsClosed = true;
			projection.phase = "settled";
			break;
		}
		case "task-execution-artifact-imported": {
			const projection = agentExecutionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			const observation = projection.observation;
			const artifact = state.artifacts[input.data.artifactId];
			const recoversArtifactImport =
				projection.phase === "terminal" &&
				projection.terminal?.outcome === "cleanup-blocked" &&
				projection.terminal.evidence.kind === "workflow" &&
				projection.terminal.evidence.stage === "artifact-import";
			if (
				(projection.phase !== "settled" && !recoversArtifactImport) ||
				!observation ||
				observation.status !== "completed" ||
				input.data.subagentRunId !== observation.subagentRunId ||
				!artifact ||
				artifact.producerTaskId !== projection.execution.taskId ||
				artifact.producerExecutionId !== projection.execution.id ||
				artifact.output !== "result"
			) {
				fail("task execution artifact import is invalid", event.sequence);
			}
			if (recoversArtifactImport) delete projection.terminal;
			const { executionId: _executionId, ...artifactImport } = input.data;
			projection.artifactImport = {
				...artifactImport,
				sequence: event.sequence,
			};
			projection.phase = "artifact-imported";
			break;
		}
		case "task-execution-release-intended": {
			const projection = agentExecutionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			const receipt = projection.launchReceipt;
			const observation = projection.observation;
			const recoversRelease =
				projection.phase === "terminal" &&
				projection.terminal?.outcome === "cleanup-blocked" &&
				projection.terminal.evidence.kind === "workflow" &&
				projection.terminal.evidence.stage === "release";
			const expectedPhase =
				observation?.status === "completed" ? "artifact-imported" : "settled";
			if (
				(projection.phase !== expectedPhase && !recoversRelease) ||
				!receipt ||
				!observation ||
				input.data.subagentRunId !== receipt.subagentRunId ||
				!isTerminalSubagentStatus(observation.status)
			) {
				fail("task execution release intent is invalid", event.sequence);
			}
			if (observation.status === "interrupted") {
				fail("interrupted child is not releasable", event.sequence);
			}
			if (recoversRelease) delete projection.terminal;
			const { executionId: _executionId, ...releaseIntent } = input.data;
			projection.releaseIntent = {
				...releaseIntent,
				sequence: event.sequence,
			};
			projection.phase = "release-intended";
			break;
		}
		case "task-execution-released": {
			const projection = agentExecutionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			const intent = projection.releaseIntent;
			const observation = projection.observation;
			if (
				projection.phase !== "release-intended" ||
				!intent ||
				!observation ||
				input.data.subagentRunId !== intent.subagentRunId ||
				(input.data.status !== observation.status &&
					(observation.status !== "cleanup-blocked" ||
						input.data.status === "cleanup-blocked")) ||
				!isTerminalSubagentStatus(input.data.status)
			) {
				fail("task execution release is invalid", event.sequence);
			}
			const { executionId: _executionId, ...release } = input.data;
			projection.release = { ...release, sequence: event.sequence };
			projection.phase = "released";
			break;
		}
		case "task-execution-support-intended": {
			const projection = supportExecutionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			const spec = supportTaskSpec(state, projection, event.sequence);
			if (projection.phase !== "created") {
				fail("support task intent is out of order", event.sequence);
			}
			if (
				input.data.implementationIdentitySha256 !==
					projection.execution.implementationIdentitySha256 ||
				input.data.implementationIdentitySha256 !==
					deriveSupportImplementationIdentitySha256(
						spec.request.implementation,
					) ||
				input.data.parametersSha256 !==
					deriveJsonValueSha256(spec.request.parameters) ||
				input.data.inputsSha256 !==
					taskInputsSha256(state, spec, event.sequence)
			) {
				fail("support task intent does not match its task", event.sequence);
			}
			const { executionId: _executionId, ...supportIntent } = input.data;
			projection.supportIntent = { ...supportIntent, sequence: event.sequence };
			projection.phase = "support-intended";
			break;
		}
		case "task-execution-support-output-committed": {
			const projection = supportExecutionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			const spec = supportTaskSpec(state, projection, event.sequence);
			if (projection.phase !== "support-intended") {
				fail("support task output commit is out of order", event.sequence);
			}
			const artifact = state.artifacts[input.data.artifactId];
			if (
				!artifact ||
				artifact.runId !== state.runId ||
				artifact.producerTaskId !== projection.execution.taskId ||
				artifact.producerExecutionId !== projection.execution.id ||
				artifact.output !== "result" ||
				artifact.sha256 !== input.data.outputSha256 ||
				artifact.mediaType !== "application/json" ||
				artifact.schemaSha256 !==
					deriveJsonValueSha256(spec.request.implementation.outputSchema)
			) {
				fail("support task output artifact does not match", event.sequence);
			}
			const { executionId: _executionId, ...supportOutput } = input.data;
			projection.supportOutput = { ...supportOutput, sequence: event.sequence };
			projection.phase = "support-output-committed";
			break;
		}
		case "task-execution-nested-intended": {
			const projection = nestedExecutionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			const spec = nestedTaskSpec(state, projection, event.sequence);
			if (projection.phase !== "created") {
				fail("nested workflow intent is out of order", event.sequence);
			}
			if (input.data.childRunId !== projection.execution.childRunId) {
				fail(
					"nested workflow intent does not match its execution",
					event.sequence,
				);
			}
			if (
				input.data.definitionIdentitySha256 !==
					spec.request.definitionIdentitySha256 ||
				input.data.inputSha256 !== spec.request.inputSha256
			) {
				fail("nested workflow intent does not match its task", event.sequence);
			}
			if (
				input.data.inputsSha256 !==
				taskInputsSha256(state, spec, event.sequence)
			) {
				fail(
					"nested workflow intent input artifacts do not match its task",
					event.sequence,
				);
			}
			// Without artifact inputs the launched child input is the authored
			// input, so its digest must equal the declared inputSha256. With
			// artifact inputs the launched input is the authored input merged
			// with artifact contents that are stored outside the journal, so the
			// reducer cannot recompute the merged digest; the executor re-derives
			// and re-verifies it against this intent before launch.
			if (
				Object.keys(spec.inputs).length === 0 &&
				input.data.resolvedInputSha256 !== spec.request.inputSha256
			) {
				fail(
					"nested workflow intent resolved input does not match its declared input",
					event.sequence,
				);
			}
			const declared = spec.request.budget;
			const intended = input.data.budget;
			if (
				intended.cost > declared.cost ||
				intended.childRuntimeMs > declared.childRuntimeMs ||
				(declared.totalTokens !== undefined &&
					(intended.totalTokens === undefined ||
						intended.totalTokens > declared.totalTokens))
			) {
				fail(
					"nested workflow intent exceeds its declared budget",
					event.sequence,
				);
			}
			if (
				input.data.timeoutMs > spec.request.timeoutMs ||
				input.data.concurrency > spec.request.concurrency
			) {
				fail(
					"nested workflow intent exceeds its declared limits",
					event.sequence,
				);
			}
			const deadlineAt = Date.parse(input.data.deadlineAt);
			if (
				!Number.isFinite(deadlineAt) ||
				deadlineAt > Date.parse(event.timestamp) + input.data.timeoutMs
			) {
				fail("nested workflow intent deadline is invalid", event.sequence);
			}
			const { executionId: _executionId, ...nestedIntent } = input.data;
			projection.nestedIntent = {
				...structuredClone(nestedIntent),
				sequence: event.sequence,
			};
			projection.phase = "nested-intended";
			break;
		}
		case "task-execution-nested-launched": {
			const projection = nestedExecutionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			if (projection.phase !== "nested-intended" || !projection.nestedIntent) {
				fail("nested workflow launch is out of order", event.sequence);
			}
			if (input.data.childRunId !== projection.execution.childRunId) {
				fail(
					"nested workflow launch does not match its execution",
					event.sequence,
				);
			}
			const { executionId: _executionId, ...nestedLaunch } = input.data;
			projection.nestedLaunch = { ...nestedLaunch, sequence: event.sequence };
			projection.phase = "nested-launched";
			break;
		}
		case "task-execution-nested-settled": {
			const projection = nestedExecutionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			const previous = projection.nestedSettlement;
			const reconciles =
				previous?.status === "cleanup-blocked" &&
				input.data.status !== "cleanup-blocked" &&
				(projection.phase === "nested-settled" ||
					(projection.phase === "terminal" &&
						projection.terminal?.outcome === "cleanup-blocked" &&
						projection.terminal.evidence.kind === "nested-workflow"));
			if (
				(projection.phase !== "nested-launched" && !reconciles) ||
				!projection.nestedLaunch
			) {
				fail("nested workflow settlement is out of order", event.sequence);
			}
			if (input.data.childRunId !== projection.execution.childRunId) {
				fail(
					"nested workflow settlement does not match its execution",
					event.sequence,
				);
			}
			if (!isTerminalRunStatus(input.data.status)) {
				fail(
					"nested workflow settlement status is not terminal",
					event.sequence,
				);
			}
			const completedChild = isCompletedRunStatus(input.data.status);
			if (
				(input.data.outputArtifactId !== undefined) !== completedChild ||
				(input.data.outputSha256 !== undefined) !== completedChild
			) {
				fail(
					"nested workflow settlement output is inconsistent",
					event.sequence,
				);
			}
			if (reconciles) delete projection.terminal;
			const { executionId: _executionId, ...nestedSettlement } = input.data;
			projection.nestedSettlement = {
				...structuredClone(nestedSettlement),
				sequence: event.sequence,
			};
			projection.phase = "nested-settled";
			break;
		}
		case "task-execution-nested-output-imported": {
			const projection = nestedExecutionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			const spec = nestedTaskSpec(state, projection, event.sequence);
			const settlement = projection.nestedSettlement;
			const recoversImport =
				projection.phase === "terminal" &&
				projection.terminal?.outcome === "cleanup-blocked" &&
				projection.terminal.evidence.kind === "workflow" &&
				projection.terminal.evidence.stage === "nested-import";
			if (
				(projection.phase !== "nested-settled" && !recoversImport) ||
				!settlement
			) {
				fail("nested workflow output import is out of order", event.sequence);
			}
			if (!isCompletedRunStatus(settlement.status)) {
				fail(
					"nested workflow output import requires a completed child",
					event.sequence,
				);
			}
			if (input.data.childRunId !== projection.execution.childRunId) {
				fail(
					"nested workflow output import does not match its execution",
					event.sequence,
				);
			}
			const artifact = state.artifacts[input.data.artifactId];
			if (
				!artifact ||
				artifact.runId !== state.runId ||
				artifact.producerTaskId !== projection.execution.taskId ||
				artifact.producerExecutionId !== projection.execution.id ||
				artifact.output !== "result" ||
				artifact.mediaType !== "application/json" ||
				artifact.sha256 !== input.data.sourceSha256 ||
				artifact.schemaSha256 !==
					deriveJsonValueSha256(spec.request.outputSchema) ||
				input.data.sourceSha256 !== settlement.outputSha256 ||
				input.data.sourceArtifactId !== settlement.outputArtifactId
			) {
				fail("nested workflow output artifact does not match", event.sequence);
			}
			if (recoversImport) delete projection.terminal;
			const { executionId: _executionId, ...nestedOutputImport } = input.data;
			projection.nestedOutputImport = {
				...nestedOutputImport,
				sequence: event.sequence,
			};
			projection.phase = "nested-output-imported";
			break;
		}
		case "task-execution-terminal": {
			const projection = executionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			if (projection.phase === "terminal") {
				fail("task execution terminal evidence is duplicate", event.sequence);
			}
			const task = state.tasks[projection.execution.taskId];
			if (
				!task ||
				task.currentExecutionId !== projection.execution.id ||
				task.status === "completed" ||
				task.status === "failed" ||
				task.status === "cancelled" ||
				task.status === "invalidated"
			) {
				fail("task execution terminal target is not active", event.sequence);
			}
			const evidence = structuredClone(input.data.evidence);
			if (evidence.kind === "subagent") {
				if (task.task.spec.kind !== "agent") {
					fail(
						`${task.task.spec.kind} task has subagent terminal evidence`,
						event.sequence,
					);
				}
				const observation = projection.observation;
				const expectedOutcome = subagentOutcome(evidence.status);
				const importedArtifact = projection.artifactImport
					? state.artifacts[projection.artifactImport.artifactId]
					: undefined;
				// Interrupted children are retained for recovery: their terminal
				// evidence is the settlement itself and no release ever happens.
				const interruptedSettlement = evidence.status === "interrupted";
				if (interruptedSettlement) {
					if (
						projection.phase !== "settled" ||
						projection.releaseIntent !== undefined ||
						projection.release !== undefined
					) {
						fail(
							"interrupted terminal evidence requires an unreleased settled execution",
							event.sequence,
						);
					}
				} else if (projection.phase !== "released") {
					fail("subagent terminal evidence precedes release", event.sequence);
				}
				if (!observation || observation.status !== evidence.status) {
					fail("subagent terminal observation does not match", event.sequence);
				}
				if (
					!projection.settlement ||
					!isDeepStrictEqual(projection.settlement.evidence, evidence)
				) {
					fail("subagent terminal settlement does not match", event.sequence);
				}
				if (!expectedOutcome || expectedOutcome !== input.data.outcome) {
					fail("subagent terminal outcome does not match", event.sequence);
				}
				if (
					!interruptedSettlement &&
					projection.release?.status !== evidence.status
				) {
					fail("subagent terminal release does not match", event.sequence);
				}
				if (
					evidence.status === "completed" &&
					(projection.artifactImport === undefined ||
						importedArtifact?.sha256 !== evidence.structuredOutputSha256 ||
						importedArtifact?.schemaSha256 !==
							deriveJsonValueSha256(task.task.spec.request.outputSchema) ||
						projection.artifactImport.sourceResultSha256 !==
							evidence.resultSha256)
				) {
					fail("subagent terminal artifact does not match", event.sequence);
				}
			} else if (evidence.kind === "support") {
				if (task.task.spec.kind !== "support") {
					fail(
						`${task.task.spec.kind} task has support terminal evidence`,
						event.sequence,
					);
				}
				if (projection.phase !== "support-output-committed") {
					fail(
						"support terminal evidence precedes output commit",
						event.sequence,
					);
				}
				if (input.data.outcome !== "completed") {
					fail("support terminal outcome is not completed", event.sequence);
				}
				const intent = projection.supportIntent;
				const output = projection.supportOutput;
				if (
					!intent ||
					evidence.implementationIdentitySha256 !==
						intent.implementationIdentitySha256 ||
					evidence.parametersSha256 !== intent.parametersSha256 ||
					evidence.inputsSha256 !== intent.inputsSha256
				) {
					fail("support terminal intent does not match", event.sequence);
				}
				if (
					!output ||
					evidence.outputSha256 !== output.outputSha256 ||
					evidence.artifactId !== output.artifactId
				) {
					fail("support terminal output does not match", event.sequence);
				}
			} else if (evidence.kind === "nested-workflow") {
				if (task.task.spec.kind !== "workflow") {
					fail(
						`${task.task.spec.kind} task has nested workflow terminal evidence`,
						event.sequence,
					);
				}
				const settlement = projection.nestedSettlement;
				if (
					!settlement ||
					!isNestedExecution(projection) ||
					evidence.childRunId !== projection.execution.childRunId ||
					evidence.childRunId !== settlement.childRunId ||
					evidence.status !== settlement.status ||
					evidence.usageComplete !== settlement.usageComplete ||
					!isDeepStrictEqual(evidence.usage, settlement.usage)
				) {
					fail(
						"nested workflow terminal settlement does not match",
						event.sequence,
					);
				}
				const expectedOutcome = nestedOutcome(evidence.status);
				if (!expectedOutcome || expectedOutcome !== input.data.outcome) {
					fail(
						"nested workflow terminal outcome does not match",
						event.sequence,
					);
				}
				if (expectedOutcome === "completed") {
					const nestedImport = projection.nestedOutputImport;
					if (projection.phase !== "nested-output-imported") {
						fail(
							"nested workflow terminal evidence precedes output import",
							event.sequence,
						);
					}
					if (
						!nestedImport ||
						evidence.artifactId !== nestedImport.artifactId ||
						evidence.outputSha256 !== nestedImport.sourceSha256
					) {
						fail(
							"nested workflow terminal artifact does not match",
							event.sequence,
						);
					}
				} else if (
					projection.phase !== "nested-settled" ||
					evidence.artifactId !== undefined ||
					evidence.outputSha256 !== undefined
				) {
					fail(
						"nested workflow terminal evidence is inconsistent",
						event.sequence,
					);
				}
			} else if (task.task.spec.kind === "workflow") {
				const resolutionPhase =
					projection.phase === "created" ||
					projection.phase === "nested-intended";
				const importPhase =
					projection.phase === "nested-settled" &&
					projection.nestedSettlement !== undefined &&
					isCompletedRunStatus(projection.nestedSettlement.status);
				if (
					evidence.failureSha256 !==
						deriveWorkflowFailureSha256(evidence.stage, evidence.message) ||
					(input.data.outcome === "failed" &&
						((evidence.stage !== "nested-resolution" &&
							evidence.stage !== "nested-launch" &&
							evidence.stage !== "nested-input") ||
							!resolutionPhase)) ||
					(input.data.outcome === "cleanup-blocked" &&
						(evidence.stage !== "nested-import" || !importPhase)) ||
					(input.data.outcome === "cancelled" &&
						(evidence.stage !== "stop" || !resolutionPhase)) ||
					(input.data.outcome !== "failed" &&
						input.data.outcome !== "cancelled" &&
						input.data.outcome !== "cleanup-blocked")
				) {
					fail("workflow terminal evidence is inconsistent", event.sequence);
				}
			} else if (task.task.spec.kind === "support") {
				const failurePhase =
					projection.phase === "created" ||
					projection.phase === "support-intended" ||
					projection.phase === "support-output-committed";
				const stopPhase =
					projection.phase === "created" ||
					projection.phase === "support-intended";
				if (
					evidence.failureSha256 !==
						deriveWorkflowFailureSha256(evidence.stage, evidence.message) ||
					(input.data.outcome === "failed" &&
						(!isSupportFailureStage(evidence.stage) || !failurePhase)) ||
					(input.data.outcome === "cancelled" &&
						(evidence.stage !== "stop" || !stopPhase)) ||
					(input.data.outcome !== "failed" &&
						input.data.outcome !== "cancelled")
				) {
					fail("workflow terminal evidence is inconsistent", event.sequence);
				}
			} else {
				if (
					isSupportFailureStage(evidence.stage) ||
					isNestedFailureStage(evidence.stage)
				) {
					fail("workflow terminal evidence is inconsistent", event.sequence);
				}
				if (
					evidence.failureSha256 !==
						deriveWorkflowFailureSha256(evidence.stage, evidence.message) ||
					(input.data.outcome === "cleanup-blocked" &&
						evidence.stage !== "artifact-import" &&
						evidence.stage !== "release") ||
					(input.data.outcome === "cancelled" && evidence.stage !== "stop") ||
					(input.data.outcome === "failed" &&
						(evidence.stage === "stop" ||
							evidence.stage === "artifact-import" ||
							evidence.stage === "release")) ||
					(input.data.outcome !== "failed" &&
						input.data.outcome !== "cancelled" &&
						input.data.outcome !== "cleanup-blocked") ||
					(evidence.stage === "preflight" &&
						projection.phase !== "created" &&
						projection.phase !== "preflighted") ||
					(evidence.stage === "launch" &&
						projection.phase !== "preflighted" &&
						projection.phase !== "launch-intended") ||
					(evidence.stage === "reconciliation" &&
						projection.phase !== "launch-absent") ||
					(evidence.stage === "stop" &&
						projection.phase !== "created" &&
						projection.phase !== "preflighted") ||
					(evidence.stage === "artifact-import" &&
						projection.phase !== "settled") ||
					(evidence.stage === "release" &&
						projection.phase !== "release-intended")
				) {
					fail("workflow terminal evidence is inconsistent", event.sequence);
				}
			}
			projection.terminal = {
				outcome: input.data.outcome,
				evidence,
				sequence: event.sequence,
			};
			projection.phase = "terminal";
			break;
		}
		case "task-status-changed": {
			if (
				state.status === "completed" ||
				state.status === "completed-degraded" ||
				state.status === "cancelled"
			) {
				fail(
					"terminal workflow run may not change task status",
					event.sequence,
				);
			}
			const task = state.tasks[input.data.taskId];
			if (!task) fail("task status target is unknown", event.sequence);
			if (!task.committed) {
				fail("uncommitted task may not change status", event.sequence);
			}
			if (task.status !== input.data.from) {
				fail("task status source does not match projection", event.sequence);
			}
			if (!isOnPath(task)) {
				fail("abandoned task may not change status", event.sequence);
			}
			const execution = task.currentExecutionId
				? state.executions[task.currentExecutionId]
				: undefined;
			if (
				input.data.to === "pending" &&
				(input.data.from !== "invalidated" ||
					(execution !== undefined && execution.phase !== "terminal"))
			) {
				fail(
					"re-materialization requires a terminal execution",
					event.sequence,
				);
			}
			const supportTask = task.task.spec.kind === "support";
			const workflowTask = task.task.spec.kind === "workflow";
			if (input.data.to === "running" && supportTask) {
				if (execution?.phase !== "support-intended") {
					fail(
						"support task became running without persisted intent",
						event.sequence,
					);
				}
			} else if (input.data.to === "running" && workflowTask) {
				if (!execution || !isLaunchedNestedPhase(execution.phase)) {
					fail(
						"workflow task became running without a launched child run",
						event.sequence,
					);
				}
			} else if (input.data.to === "running") {
				const childStatus =
					execution?.observation?.status ??
					(execution ? currentSubagentAttempt(execution)?.status : undefined);
				if (!execution || childStatus !== "active") {
					fail(
						"task became running without an active execution",
						event.sequence,
					);
				}
			}
			if (input.data.to === "waiting" && supportTask) {
				fail("support task may not wait", event.sequence);
			}
			if (input.data.to === "waiting" && workflowTask) {
				fail("workflow task may not wait", event.sequence);
			}
			if (input.data.to === "waiting" && !execution?.launchReceipt) {
				fail(
					"task became waiting without a launched execution",
					event.sequence,
				);
			}
			if (input.data.to === "cancelling" && supportTask) {
				fail("support task may not enter cancelling", event.sequence);
			}
			if (
				input.data.to === "cancelling" &&
				workflowTask &&
				(state.status !== "stopping" ||
					!execution ||
					!isLaunchedNestedPhase(execution.phase))
			) {
				fail(
					"workflow task began cancellation without stop intent and a launched child run",
					event.sequence,
				);
			}
			if (
				input.data.to === "cancelling" &&
				!workflowTask &&
				(state.status !== "stopping" || !execution?.launchReceipt)
			) {
				fail(
					"task began cancellation without stop intent and a launched execution",
					event.sequence,
				);
			}
			const terminalOutcome =
				input.data.to === "completed" ||
				input.data.to === "failed" ||
				input.data.to === "cancelled" ||
				input.data.to === "interrupted" ||
				input.data.to === "cleanup-blocked"
					? input.data.to
					: undefined;
			if (
				terminalOutcome &&
				(input.data.to !== "cancelled" || execution) &&
				execution?.terminal?.outcome !== terminalOutcome
			) {
				fail(
					"task terminal status lacks matching execution evidence",
					event.sequence,
				);
			}
			if (input.data.to === "ready" && isFinalizer(task)) {
				if (
					state.status !== "finalizing" ||
					state.outputArtifactId === undefined
				) {
					fail("finalizer became ready outside finalizing", event.sequence);
				}
			} else if (
				input.data.to === "ready" &&
				state.status !== "running" &&
				state.status !== "waiting"
			) {
				fail(
					"task became ready outside a running workflow run",
					event.sequence,
				);
			}
			if (
				input.data.to === "ready" &&
				[...dependencies(state, input.data.taskId)].some(
					(dependencyId) => state.tasks[dependencyId]?.status !== "completed",
				)
			) {
				fail(
					"task became ready before its dependencies completed",
					event.sequence,
				);
			}
			if (
				input.data.to === "completed" &&
				!currentResultArtifact(state, input.data.taskId)
			) {
				fail(
					"task completed without its declared result artifact",
					event.sequence,
				);
			}
			try {
				task.status = transitionWorkflowTaskStatus(
					input.data.from,
					input.data.to,
				);
			} catch (error) {
				throw new WorkflowEventReductionError(
					(error as Error).message,
					event.sequence,
				);
			}
			// Re-materialization detaches the superseded execution: it stays in
			// the projection as history, and the next generation becomes current
			// when it is created.
			if (input.data.to === "pending") delete task.currentExecutionId;
			break;
		}
		case "task-invalidated": {
			if (
				state.status !== "running" &&
				state.status !== "waiting" &&
				state.status !== "failed" &&
				state.status !== "interrupted"
			) {
				fail("workflow run status does not admit invalidation", event.sequence);
			}
			if (
				Object.values(state.tasks).some((task) =>
					currentExecutionIsActive(state, task),
				)
			) {
				fail("workflow run has active task executions", event.sequence);
			}
			let closure: WorkflowInvalidationClosure;
			try {
				closure = invalidationClosure(state, input.data.causeTaskId);
			} catch (error) {
				fail((error as Error).message, event.sequence);
			}
			const actual = [...input.data.taskIds].sort();
			if (!isDeepStrictEqual(actual, closure.taskIds)) {
				fail(
					"invalidation does not cover the exact dependent closure",
					event.sequence,
				);
			}
			if (
				!isDeepStrictEqual(
					[...input.data.abandonedEpochs],
					closure.abandonedEpochs,
				)
			) {
				fail(
					"invalidation does not cover the exact abandoned epochs",
					event.sequence,
				);
			}
			// The output is never recommitted, so re-executing an ordinary task
			// after the commit could not change it; only finalizers may rerun.
			if (
				state.outputArtifactId !== undefined &&
				closure.taskIds.some(
					(taskId) => state.tasks[taskId]?.task.spec.role === "task",
				)
			) {
				fail(
					"invalidation after output commit may only cover finalizers",
					event.sequence,
				);
			}
			for (const taskId of actual) {
				const task = state.tasks[taskId];
				if (!task) fail("invalidation target is unknown", event.sequence);
				if (!task.committed) {
					fail("uncommitted task may not be invalidated", event.sequence);
				}
				try {
					task.status = transitionWorkflowTaskStatus(
						task.status,
						"invalidated",
					);
				} catch (error) {
					throw new WorkflowEventReductionError(
						(error as Error).message,
						event.sequence,
					);
				}
			}
			// Everything after the first on-path barrier exposing the closure is
			// abandoned history: later on-path epochs (barriers and their tasks)
			// and every effect recorded after that barrier, even when no later
			// epoch exists.
			const abandonedEpochs = new Set(closure.abandonedEpochs);
			const exposing = pathBarriers(state).find((barrier) =>
				barrier.taskIds.some((taskId) => actual.includes(taskId)),
			);
			for (const barrier of state.barriers) {
				if (abandonedEpochs.has(barrier.epoch)) barrier.abandoned = true;
			}
			for (const task of Object.values(state.tasks)) {
				if (abandonedEpochs.has(task.task.materializationEpoch)) {
					task.abandoned = true;
				}
			}
			if (exposing) {
				for (const effect of state.effects) {
					if (effect.sequence > exposing.sequence) effect.abandoned = true;
				}
			}
			break;
		}
		case "run-output-committed": {
			const artifact = state.artifacts[input.data.artifactId];
			if (
				state.status !== "finalizing" ||
				state.outputArtifactId !== undefined ||
				!artifact ||
				artifact.producerTaskId !== undefined ||
				artifact.output !== undefined
			) {
				fail("workflow output commit is invalid", event.sequence);
			}
			state.outputArtifactId = artifact.id;
			break;
		}
		case "run-status-changed": {
			if (state.status !== input.data.from) {
				fail("run status source does not match projection", event.sequence);
			}
			let nextStatus: WorkflowStateProjection["status"];
			try {
				nextStatus = transitionWorkflowRunStatus(
					input.data.from,
					input.data.to,
				);
			} catch (error) {
				throw new WorkflowEventReductionError(
					(error as Error).message,
					event.sequence,
				);
			}
			if (
				input.data.to === "running" &&
				(input.data.from === "failed" || input.data.from === "interrupted") &&
				!pathTasks(state).some((task) => task.status === "invalidated") &&
				!(input.data.from === "interrupted" && hasOpenOperatorIntent(state))
			) {
				fail("recovery requires invalidated work", event.sequence);
			}
			const liveTasks = pathTasks(state);
			if (
				input.data.to === "finalizing" &&
				(!hasPathFinalBarrier(state) ||
					liveTasks.some(
						(task) =>
							!isFinalizer(task) &&
							task.task.spec.disposition === "required" &&
							task.status !== "completed",
					))
			) {
				fail(
					"run finalized before its required work completed",
					event.sequence,
				);
			}
			// Ordinary tasks are unschedulable once finalizing, so any still active
			// (an optional one, given the check above) could never settle.
			if (
				input.data.to === "finalizing" &&
				liveTasks.some(
					(task) =>
						!isFinalizer(task) &&
						(task.status === "pending" ||
							task.status === "ready" ||
							task.status === "running" ||
							task.status === "waiting" ||
							task.status === "cancelling"),
				)
			) {
				fail(
					"run finalized while ordinary tasks remain active",
					event.sequence,
				);
			}
			if (
				(input.data.to === "completed" ||
					input.data.to === "completed-degraded") &&
				(!hasPathFinalBarrier(state) || state.outputArtifactId === undefined)
			) {
				fail(
					"run completed without a final barrier and output",
					event.sequence,
				);
			}
			// A blocked task is settled for completion (an advisory finalizer behind
			// a failed optional task degrades the run instead of stalling it).
			// Interrupted children finalize without release and are retained for
			// recovery, so an interrupted optional task or advisory finalizer is
			// settled work that degrades completion rather than preventing it.
			const unsettledTasks = liveTasks.some(
				(task) =>
					task.status !== "completed" &&
					task.status !== "failed" &&
					task.status !== "cancelled" &&
					task.status !== "blocked" &&
					task.status !== "interrupted",
			);
			// Interrupted children are retained without release, so a stopping
			// drain counts them as drained.
			const uncancelledTasks = liveTasks.some(
				(task) =>
					task.status !== "completed" &&
					task.status !== "failed" &&
					task.status !== "cancelled" &&
					task.status !== "invalidated" &&
					task.status !== "interrupted",
			);
			if (
				(input.data.to === "completed" ||
					input.data.to === "completed-degraded") &&
				unsettledTasks
			) {
				fail("run completed while tasks remain unsettled", event.sequence);
			}
			if (input.data.to === "cancelled" && uncancelledTasks) {
				fail("run cancelled while tasks remain unsettled", event.sequence);
			}
			if (
				(input.data.to === "completed" ||
					input.data.to === "completed-degraded") &&
				liveTasks.some(
					(task) =>
						task.task.spec.disposition === "required" &&
						task.status !== "completed",
				)
			) {
				fail("run completed before required tasks completed", event.sequence);
			}
			const degradedOptionalTask = liveTasks.some(
				(task) =>
					task.task.spec.disposition === "optional" &&
					task.status !== "completed",
			);
			if (input.data.to === "completed" && degradedOptionalTask) {
				fail(
					"non-successful optional task requires degraded completion",
					event.sequence,
				);
			}
			if (input.data.to === "completed-degraded" && !degradedOptionalTask) {
				fail(
					"degraded completion requires degraded optional work",
					event.sequence,
				);
			}
			state.status = nextStatus;
			break;
		}
		default: {
			const _exhaustive: never = input;
			fail(
				`unknown workflow event ${String((_exhaustive as { type: string }).type)}`,
				event.sequence,
			);
		}
	}
	state.lastSequence = event.sequence;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

function assertValidState(
	state: WorkflowStateProjection,
	sequence: number,
): void {
	if (!Value.Check(WorkflowStateProjectionSchema, state)) {
		fail("reduced workflow state is invalid", sequence);
	}
	if (Buffer.byteLength(JSON.stringify(state)) > MAX_WORKFLOW_STATE_BYTES) {
		fail("reduced workflow state exceeds snapshot bound", sequence);
	}
}

export function reduceWorkflowEvents(
	events: readonly WorkflowJournalEvent[],
): WorkflowStateProjection {
	const first = events[0];
	if (!first)
		throw new WorkflowEventReductionError("missing run-created event", 0);
	if (first.sequence !== 1) {
		throw new WorkflowEventReductionError("first event sequence is not 1", 1);
	}
	const firstInput = { type: first.type, data: first.data };
	if (
		!Value.Check(WorkflowEventInputSchema, firstInput) ||
		firstInput.type !== "run-created"
	) {
		throw new WorkflowEventReductionError("first event is not run-created", 1);
	}
	const state: WorkflowStateProjection = {
		runId: first.runId,
		definitionIdentitySha256: firstInput.data.definitionIdentitySha256,
		inputSha256: firstInput.data.inputSha256,
		status: "created",
		currentEpoch: 1,
		effects: [],
		lastSequence: 1,
		tasks: {},
		executions: {},
		artifacts: {},
		barriers: [],
	};
	assertValidState(state, 1);
	let previousTimestamp = Date.parse(first.timestamp);
	if (!Number.isFinite(previousTimestamp)) {
		fail("first event timestamp is invalid", 1);
	}
	for (const event of events.slice(1)) {
		const timestamp = Date.parse(event.timestamp);
		if (
			event.runId !== state.runId ||
			event.sequence !== state.lastSequence + 1 ||
			!Number.isFinite(timestamp) ||
			timestamp < previousTimestamp
		) {
			fail(
				"event run identity, sequence, or timestamp does not match projection",
				event.sequence,
			);
		}
		const input = { type: event.type, data: event.data };
		if (!Value.Check(WorkflowEventInputSchema, input)) {
			fail(
				"event payload does not match a known workflow event",
				event.sequence,
			);
		}
		applyEvent(state, event, input as WorkflowEventInput);
		assertValidState(state, event.sequence);
		previousTimestamp = timestamp;
	}
	return deepFreeze(state);
}

export async function rebuildWorkflowSnapshot(
	journal: WorkflowRunJournal,
): Promise<WorkflowRunSnapshot> {
	const state = reduceWorkflowEvents(await journal.readEvents());
	return journal.writeSnapshot(state);
}
