import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import type {
	TaskExecutionId,
	TaskExecutionOutcome,
	WorkflowTaskId,
} from "./contracts.js";
import {
	MAX_WORKFLOW_STATE_BYTES,
	type WorkflowEventInput,
	WorkflowEventInputSchema,
	type WorkflowStateProjection,
	WorkflowStateProjectionSchema,
} from "./events.js";
import {
	deriveSubagentOperationId,
	deriveTaskExecutionId,
} from "./execution.js";
import {
	transitionWorkflowRunStatus,
	transitionWorkflowTaskStatus,
} from "./lifecycle.js";
import {
	deriveAgentTaskIdentity,
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

function executionProjection(
	state: WorkflowStateProjection,
	executionId: TaskExecutionId,
	sequence: number,
) {
	const execution = state.executions[executionId];
	if (!execution) fail("task execution is unknown", sequence);
	return execution;
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
		case "task-declared": {
			const task = structuredClone(input.data.task);
			if (
				state.status === "completed" ||
				state.status === "completed-degraded" ||
				state.status === "cancelled"
			) {
				fail("terminal workflow run may not declare tasks", event.sequence);
			}
			if (state.barriers.some((barrier) => barrier.kind === "final")) {
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
			const { identitySha256, ...specWithoutIdentity } = task.spec;
			if (
				identitySha256 !==
				deriveAgentTaskIdentity({
					definitionIdentitySha256: state.definitionIdentitySha256,
					inputSha256: state.inputSha256,
					namespace: task.namespace,
					spec: specWithoutIdentity,
				})
			) {
				fail("declared task identity digest does not match", event.sequence);
			}
			if (state.tasks[task.id]) {
				fail("duplicate workflow task ID", event.sequence);
			}
			if (
				Object.values(state.tasks).some(
					(existing) =>
						taskNamespaceKey(existing.task) === taskNamespaceKey(task),
				)
			) {
				fail("duplicate workflow task namespace and key", event.sequence);
			}
			if (
				task.materializationSequence !==
				Object.keys(state.tasks).length + 1
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
					if (
						dependency.runId !== state.runId ||
						!state.tasks[dependency.taskId]
					) {
						fail("task order dependency is unknown", event.sequence);
					}
					return dependency.taskId;
				}),
			);
			for (const inputRef of Object.values(task.spec.inputs)) {
				if (
					inputRef.runId !== state.runId ||
					!state.tasks[inputRef.producerTaskId]
				) {
					fail("task data dependency is unknown", event.sequence);
				}
				if (!explicitDependencies.has(inputRef.producerTaskId)) {
					fail(
						"task data dependency lacks its order dependency",
						event.sequence,
					);
				}
			}
			state.tasks[task.id] = { task, status: "pending", committed: false };
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
				(artifact.output === undefined)
			) {
				fail(
					"artifact producer and output identity must appear together",
					event.sequence,
				);
			}
			if (artifact.producerTaskId !== undefined) {
				const producer = state.tasks[artifact.producerTaskId];
				if (!producer) {
					fail("artifact producer is unknown", event.sequence);
				}
				if (!producer.committed) {
					fail("artifact producer is not committed", event.sequence);
				}
			}
			if (
				artifact.producerTaskId !== undefined &&
				Object.values(state.artifacts).some(
					(existing) =>
						existing.producerTaskId === artifact.producerTaskId &&
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
			if (state.barriers.some((barrier) => barrier.kind === "final")) {
				fail(
					"an event follows the final materialization barrier",
					event.sequence,
				);
			}
			for (const taskId of input.data.taskIds) {
				if (!state.tasks[taskId]) {
					fail("barrier references an unknown task", event.sequence);
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
			if (
				execution.runId !== state.runId ||
				execution.taskIdentitySha256 !== task.task.spec.identitySha256
			) {
				fail("task execution identity does not match its task", event.sequence);
			}
			const previousGenerations = Object.values(state.executions).filter(
				(candidate) => candidate.execution.taskId === execution.taskId,
			);
			const expectedGeneration = previousGenerations.length + 1;
			if (
				execution.generation !== expectedGeneration ||
				execution.generation !== 1
			) {
				fail(
					"task execution generation is unavailable or not contiguous",
					event.sequence,
				);
			}
			if (
				execution.id !==
					deriveTaskExecutionId(
						state.runId,
						execution.taskId,
						execution.generation,
					) ||
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
			if (state.executions[execution.id] || task.currentExecutionId) {
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
			const projection = executionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			if (
				projection.phase !== "created" ||
				input.data.operationId !== projection.execution.operationId
			) {
				fail("task execution preflight is out of order", event.sequence);
			}
			const { executionId: _executionId, ...preflight } = input.data;
			projection.preflight = { ...preflight, sequence: event.sequence };
			projection.phase = "preflighted";
			break;
		}
		case "task-execution-launch-intended": {
			const projection = executionProjection(
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
				input.data.planIdentitySha256 !== preflight.planIdentitySha256
			) {
				fail("task execution launch intent is out of order", event.sequence);
			}
			const { executionId: _executionId, ...launchIntent } = input.data;
			projection.launchIntent = { ...launchIntent, sequence: event.sequence };
			projection.phase = "launch-intended";
			break;
		}
		case "task-execution-launch-uncertain": {
			const projection = executionProjection(
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
		case "task-execution-launch-receipted": {
			const projection = executionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			if (
				(projection.phase !== "launch-intended" &&
					projection.phase !== "launch-uncertain") ||
				input.data.operationId !== projection.execution.operationId
			) {
				fail("task execution launch receipt is out of order", event.sequence);
			}
			const { executionId: _executionId, ...launchReceipt } = input.data;
			projection.launchReceipt = { ...launchReceipt, sequence: event.sequence };
			projection.phase = "launched";
			break;
		}
		case "task-execution-child-observed": {
			const projection = executionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			const receipt = projection.launchReceipt;
			const previousObservation = projection.observation;
			const previousStatus = previousObservation?.status ?? receipt?.status;
			if (
				(projection.phase !== "launched" && projection.phase !== "observed") ||
				!receipt ||
				input.data.subagentRunId !== receipt.subagentRunId ||
				input.data.subagentAttemptId !== receipt.subagentAttemptId ||
				!previousStatus ||
				(previousObservation
					? !observedStatusCanFollow(previousStatus, input.data.status)
					: input.data.status !== previousStatus &&
						!observedStatusCanFollow(previousStatus, input.data.status))
			) {
				fail("task execution child observation is invalid", event.sequence);
			}
			const { executionId: _executionId, ...observation } = input.data;
			projection.observation = { ...observation, sequence: event.sequence };
			projection.phase = "observed";
			break;
		}
		case "task-execution-artifact-imported": {
			const projection = executionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			const observation = projection.observation;
			const artifact = state.artifacts[input.data.artifactId];
			if (
				projection.phase !== "observed" ||
				!observation ||
				observation.status !== "completed" ||
				input.data.subagentRunId !== observation.subagentRunId ||
				!artifact ||
				artifact.producerTaskId !== projection.execution.taskId ||
				artifact.output !== "result"
			) {
				fail("task execution artifact import is invalid", event.sequence);
			}
			const { executionId: _executionId, ...artifactImport } = input.data;
			projection.artifactImport = {
				...artifactImport,
				sequence: event.sequence,
			};
			projection.phase = "artifact-imported";
			break;
		}
		case "task-execution-released": {
			const projection = executionProjection(
				state,
				input.data.executionId,
				event.sequence,
			);
			const receipt = projection.launchReceipt;
			if (
				(projection.phase !== "observed" &&
					projection.phase !== "artifact-imported") ||
				!receipt ||
				input.data.subagentRunId !== receipt.subagentRunId ||
				!isTerminalSubagentStatus(input.data.status)
			) {
				fail("task execution release is invalid", event.sequence);
			}
			const { executionId: _executionId, ...release } = input.data;
			projection.release = { ...release, sequence: event.sequence };
			projection.phase = "released";
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
				const observation = projection.observation;
				const expectedOutcome = subagentOutcome(evidence.status);
				const cleanupIsProved =
					cleanupProved(evidence.sandboxCleanup) &&
					cleanupProved(evidence.workspaceCleanup);
				if (
					!observation ||
					observation.status !== evidence.status ||
					!expectedOutcome ||
					expectedOutcome !== input.data.outcome ||
					(evidence.status === "completed" &&
						(!cleanupIsProved ||
							evidence.failure !== undefined ||
							evidence.structuredOutputSha256 === undefined ||
							projection.artifactImport === undefined ||
							projection.release?.status !== "completed" ||
							projection.artifactImport.sourceResultSha256 !==
								evidence.resultSha256)) ||
					(evidence.status === "cleanup-blocked" &&
						(cleanupIsProved || evidence.failure === undefined)) ||
					(evidence.status !== "completed" &&
						evidence.status !== "cleanup-blocked" &&
						(!cleanupIsProved || evidence.failure === undefined)) ||
					(evidence.status === "abandoned" &&
						(evidence.failure?.code !== "operator-abandoned" ||
							evidence.failure.origin !== "operator" ||
							evidence.failure.retry !== "never" ||
							evidence.output !== undefined ||
							evidence.structuredOutputSha256 !== undefined))
				) {
					fail("subagent terminal evidence is inconsistent", event.sequence);
				}
			} else {
				if (
					(input.data.outcome !== "failed" &&
						input.data.outcome !== "cleanup-blocked") ||
					(evidence.stage === "preflight" && projection.phase !== "created") ||
					(evidence.stage === "launch" &&
						projection.phase !== "preflighted" &&
						projection.phase !== "launch-intended") ||
					(evidence.stage === "reconciliation" &&
						projection.phase !== "launch-uncertain" &&
						projection.phase !== "launched" &&
						projection.phase !== "observed") ||
					(evidence.stage === "artifact-import" &&
						projection.phase !== "observed") ||
					(evidence.stage === "release" &&
						projection.phase !== "observed" &&
						projection.phase !== "artifact-imported" &&
						projection.phase !== "released")
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
			const execution = task.currentExecutionId
				? state.executions[task.currentExecutionId]
				: undefined;
			if (input.data.to === "running") {
				const childStatus =
					execution?.observation?.status ?? execution?.launchReceipt?.status;
				if (!execution || childStatus !== "active") {
					fail(
						"task became running without an active execution",
						event.sequence,
					);
				}
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
				!Object.values(state.artifacts).some(
					(artifact) =>
						artifact.producerTaskId === input.data.taskId &&
						artifact.output === "result",
				)
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
			break;
		}
		case "task-invalidated": {
			if (
				state.status === "completed" ||
				state.status === "completed-degraded" ||
				state.status === "cancelled"
			) {
				fail("terminal workflow run may not invalidate tasks", event.sequence);
			}
			if (!state.tasks[input.data.causeTaskId]) {
				fail("invalidation cause task is unknown", event.sequence);
			}
			const expected = [
				...transitiveDependents(state, input.data.causeTaskId),
			].sort();
			const actual = [...input.data.taskIds].sort();
			if (!isDeepStrictEqual(actual, expected)) {
				fail(
					"invalidation does not cover the exact dependent closure",
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
				input.data.to === "finalizing" &&
				(!state.barriers.some((barrier) => barrier.kind === "final") ||
					Object.values(state.tasks).some(
						(task) =>
							task.task.spec.disposition === "required" &&
							task.status !== "completed",
					))
			) {
				fail(
					"run finalized before its required work completed",
					event.sequence,
				);
			}
			if (
				(input.data.to === "completed" ||
					input.data.to === "completed-degraded") &&
				!state.barriers.some((barrier) => barrier.kind === "final")
			) {
				fail("run completed without a final barrier", event.sequence);
			}
			if (
				(input.data.to === "completed" ||
					input.data.to === "completed-degraded") &&
				Object.values(state.tasks).some(
					(task) =>
						task.task.spec.disposition === "required" &&
						task.status !== "completed",
				)
			) {
				fail("run completed before required tasks completed", event.sequence);
			}
			const unsettledTasks = Object.values(state.tasks).some(
				(task) =>
					task.status !== "completed" &&
					task.status !== "failed" &&
					task.status !== "cancelled",
			);
			const uncancelledTasks = Object.values(state.tasks).some(
				(task) =>
					task.status !== "completed" &&
					task.status !== "failed" &&
					task.status !== "cancelled" &&
					task.status !== "invalidated",
			);
			if (input.data.to === "cancelled" && uncancelledTasks) {
				fail("run cancelled while tasks remain unsettled", event.sequence);
			}
			if (
				(input.data.to === "completed" ||
					input.data.to === "completed-degraded") &&
				unsettledTasks
			) {
				fail("run completed while tasks remain unsettled", event.sequence);
			}
			const degradedOptionalTask = Object.values(state.tasks).some(
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
		lastSequence: 1,
		tasks: {},
		executions: {},
		artifacts: {},
		barriers: [],
	};
	assertValidState(state, 1);
	for (const event of events.slice(1)) {
		if (
			event.runId !== state.runId ||
			event.sequence !== state.lastSequence + 1
		) {
			fail(
				"event run identity or sequence does not match projection",
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
	}
	return deepFreeze(state);
}

export async function rebuildWorkflowSnapshot(
	journal: WorkflowRunJournal,
): Promise<WorkflowRunSnapshot> {
	const state = reduceWorkflowEvents(await journal.readEvents());
	return journal.writeSnapshot(state);
}
