import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import type { WorkflowTaskId } from "./contracts.js";
import {
	MAX_WORKFLOW_STATE_BYTES,
	type WorkflowEventInput,
	WorkflowEventInputSchema,
	type WorkflowStateProjection,
	WorkflowStateProjectionSchema,
} from "./events.js";
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

function applyEvent(
	state: WorkflowStateProjection,
	event: WorkflowJournalEvent,
	input: WorkflowEventInput,
): void {
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
