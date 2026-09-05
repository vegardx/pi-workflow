import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	isRunResult,
	type RunReceipt,
	RunStatusSchema,
} from "@vegardx/pi-subagent";
import { Ajv } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import * as addFormatsModule from "ajv-formats";
import { Value } from "typebox/value";
import {
	type WorkflowArtifactStore,
	WorkflowArtifactStoreError,
} from "./artifact-store.js";
import type {
	SubagentTerminalEvidence,
	TaskExecutionOutcome,
	WorkflowArtifactRef,
	WorkflowRunStatus,
	WorkflowTaskId,
} from "./contracts.js";
import type {
	TaskExecutionProjection,
	WorkflowEventInput,
	WorkflowStateProjection,
	WorkflowTaskProjection,
} from "./events.js";
import {
	deriveJsonValueSha256,
	deriveSubagentResultSha256,
	deriveWorkflowFailureSha256,
} from "./execution.js";
import type { WorkflowRunJournal } from "./persistence/journal.js";
import { reduceWorkflowEvents } from "./reducer.js";
import type { WorkflowSubagentBinding } from "./subagent-provider.js";

const addFormats = (addFormatsModule.default ??
	addFormatsModule) as unknown as FormatsPlugin;
const finalizerMutations = new Map<string, Promise<void>>();
type SettledExecution = TaskExecutionProjection & {
	settlement: NonNullable<TaskExecutionProjection["settlement"]>;
};

export type WorkflowTaskFinalizationOutcome = {
	readonly taskId: WorkflowTaskId;
	readonly executionId: string;
	readonly outcome: TaskExecutionOutcome;
	readonly artifact?: WorkflowArtifactRef;
	readonly runStatus: WorkflowRunStatus;
};

export interface WorkflowTaskFinalizer {
	finalize(taskId: WorkflowTaskId): Promise<WorkflowTaskFinalizationOutcome>;
}

export interface WorkflowTaskFinalizerOptions {
	readonly journal: WorkflowRunJournal;
	readonly binding: WorkflowSubagentBinding;
	readonly artifacts: WorkflowArtifactStore;
}

export class WorkflowTaskFinalizationError extends Error {
	constructor(
		readonly stage: "validation" | "artifact-import" | "release",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "WorkflowTaskFinalizationError";
	}
}

function outcome(status: string): TaskExecutionOutcome {
	if (status === "abandoned") return "cancelled";
	if (
		status === "completed" ||
		status === "failed" ||
		status === "cancelled" ||
		status === "interrupted" ||
		status === "cleanup-blocked"
	) {
		return status;
	}
	throw new WorkflowTaskFinalizationError(
		"validation",
		"Child settlement is not terminal.",
	);
}

function receipt(execution: TaskExecutionProjection): RunReceipt {
	const launch = execution.launchReceipt;
	if (!launch) {
		throw new WorkflowTaskFinalizationError(
			"validation",
			"Task execution has no child launch receipt.",
		);
	}
	return {
		runId: launch.subagentRunId,
		attemptId: launch.subagentAttemptId,
		status: execution.settlement?.evidence.status ?? launch.status,
	};
}

function resultEvidence(
	result: Parameters<typeof deriveSubagentResultSha256>[0],
): SubagentTerminalEvidence {
	return {
		kind: "subagent",
		resultSha256: deriveSubagentResultSha256(result),
		status: result.status,
		usage: structuredClone(result.usage),
		usageComplete: result.usageComplete,
		runtimeMs: result.runtimeMs,
		...(result.failure ? { failure: structuredClone(result.failure) } : {}),
		sandboxCleanup: result.sandboxCleanup,
		workspaceCleanup: result.workspaceCleanup,
		truncated: result.truncated,
		...(result.output ? { output: structuredClone(result.output) } : {}),
		...(result.structuredOutput === undefined
			? {}
			: {
					structuredOutputSha256: deriveJsonValueSha256(
						result.structuredOutput,
					),
				}),
	};
}

function validateReleaseReceipt(value: RunReceipt, expected: RunReceipt): void {
	if (
		value.runId !== expected.runId ||
		value.attemptId !== expected.attemptId ||
		!Value.Check(RunStatusSchema, value.status) ||
		value.status === "queued" ||
		value.status === "active" ||
		value.status === "stopping" ||
		value.status === "interrupted"
	) {
		throw new WorkflowTaskFinalizationError(
			"release",
			"Child release returned an invalid receipt.",
		);
	}
}

export function createWorkflowTaskFinalizer(
	options: WorkflowTaskFinalizerOptions,
): WorkflowTaskFinalizer {
	const { artifacts, binding, journal } = options;
	const coordinationKey = journal.directory;
	if (
		binding.workflowRunId !== journal.runId ||
		binding.ownerId !== `pi-workflow:${journal.runId}` ||
		artifacts.runId !== journal.runId ||
		path.dirname(artifacts.root) !== journal.directory
	) {
		throw new WorkflowTaskFinalizationError(
			"validation",
			"Finalizer binding or artifact store does not match the workflow journal.",
		);
	}

	function mutate<T>(operation: () => Promise<T>): Promise<T> {
		const predecessor =
			finalizerMutations.get(coordinationKey) ?? Promise.resolve();
		const result = predecessor.then(operation);
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		finalizerMutations.set(coordinationKey, settled);
		void settled.then(() => {
			if (finalizerMutations.get(coordinationKey) === settled) {
				finalizerMutations.delete(coordinationKey);
			}
		});
		return result;
	}

	async function state(): Promise<WorkflowStateProjection> {
		return reduceWorkflowEvents(await journal.readEvents());
	}

	async function append(input: WorkflowEventInput): Promise<void> {
		await journal.appendEvent(input);
	}

	function selected(
		current: WorkflowStateProjection,
		taskId: WorkflowTaskId,
	): { task: WorkflowTaskProjection; execution: SettledExecution } {
		const task = current.tasks[taskId];
		const execution = task?.currentExecutionId
			? current.executions[task.currentExecutionId]
			: undefined;
		if (!task?.committed || !execution?.settlement) {
			throw new WorkflowTaskFinalizationError(
				"validation",
				"Workflow task has no durable child settlement.",
			);
		}
		return { task, execution: execution as SettledExecution };
	}

	async function waitForExactResult(execution: TaskExecutionProjection) {
		const child = receipt(execution);
		const waited = await binding.client.wait(child.runId);
		if (!isRunResult(waited.result) || waited.result.runId !== child.runId) {
			throw new WorkflowTaskFinalizationError(
				"validation",
				"Child result is unavailable or invalid during finalization.",
			);
		}
		const evidence = resultEvidence(waited.result);
		if (!isDeepStrictEqual(evidence, execution.settlement?.evidence)) {
			throw new WorkflowTaskFinalizationError(
				"validation",
				"Child result does not match durable settlement evidence.",
			);
		}
		return waited.result;
	}

	async function blockArtifactImport(
		task: WorkflowTaskProjection,
		execution: TaskExecutionProjection,
	): Promise<void> {
		const message = "Workflow result artifact import requires reconciliation.";
		const current = await state();
		const projected = current.executions[execution.execution.id];
		if (projected?.phase !== "terminal") {
			await append({
				type: "task-execution-terminal",
				data: {
					executionId: execution.execution.id,
					outcome: "cleanup-blocked",
					evidence: {
						kind: "workflow",
						stage: "artifact-import",
						failureSha256: deriveWorkflowFailureSha256(
							"artifact-import",
							message,
						),
						message,
					},
				},
			});
		}
		const after = await state();
		const projectedTask = after.tasks[task.task.id];
		if (projectedTask && projectedTask.status !== "cleanup-blocked") {
			await append({
				type: "task-status-changed",
				data: {
					taskId: task.task.id,
					from: projectedTask.status,
					to: "cleanup-blocked",
					reason: message,
				},
			});
		}
	}

	async function importArtifact(
		task: WorkflowTaskProjection,
		execution: TaskExecutionProjection,
		structuredOutput: unknown,
	): Promise<WorkflowArtifactRef> {
		const schemaSha256 = deriveJsonValueSha256(
			task.task.spec.request.outputSchema,
		);
		const ajv = new Ajv({
			allErrors: true,
			strict: true,
			validateSchema: true,
		});
		addFormats(ajv);
		let valid: boolean;
		try {
			valid = ajv.validate(
				task.task.spec.request.outputSchema,
				structuredOutput,
			);
		} catch (error) {
			throw new WorkflowTaskFinalizationError(
				"artifact-import",
				"Task output schema could not validate the settled result.",
				{ cause: error },
			);
		}
		if (!valid) {
			throw new WorkflowTaskFinalizationError(
				"artifact-import",
				"Settled structured output does not match the task schema.",
			);
		}
		const ref = await artifacts.putJson(structuredOutput, {
			runId: journal.runId,
			producerTaskId: task.task.id,
			output: "result",
			schemaSha256,
		});
		const current = await state();
		const existing = current.artifacts[ref.id];
		if (existing && !isDeepStrictEqual(existing, ref)) {
			throw new WorkflowTaskFinalizationError(
				"artifact-import",
				"Workflow artifact identity conflicts with durable metadata.",
			);
		}
		if (!existing) {
			await append({ type: "artifact-declared", data: { artifact: ref } });
		}
		const afterDeclaration = await state();
		const projected = afterDeclaration.executions[execution.execution.id];
		if (!projected?.artifactImport) {
			await append({
				type: "task-execution-artifact-imported",
				data: {
					executionId: execution.execution.id,
					subagentRunId: receipt(execution).runId,
					artifactId: ref.id,
					sourceResultSha256: execution.settlement?.evidence.resultSha256 ?? "",
				},
			});
		}
		return ref;
	}

	async function reconcileReleasedStatus(
		taskId: WorkflowTaskId,
		execution: SettledExecution,
		child: RunReceipt,
	): Promise<{ task: WorkflowTaskProjection; execution: SettledExecution }> {
		const releasedStatus = execution.release?.status;
		if (
			!releasedStatus ||
			releasedStatus === execution.settlement.evidence.status
		) {
			const current = await state();
			return selected(current, taskId);
		}
		const updated = await binding.client.wait(child.runId);
		if (!isRunResult(updated.result) || updated.result.runId !== child.runId) {
			throw new WorkflowTaskFinalizationError(
				"release",
				"Released child result is unavailable or invalid.",
			);
		}
		const evidence = resultEvidence(updated.result);
		if (evidence.status !== releasedStatus) {
			throw new WorkflowTaskFinalizationError(
				"release",
				"Released child result does not match the release receipt.",
			);
		}
		await append({
			type: "task-execution-child-observed",
			data: {
				executionId: execution.execution.id,
				subagentRunId: child.runId,
				subagentAttemptId: child.attemptId,
				status: releasedStatus,
			},
		});
		await append({
			type: "task-execution-child-settled",
			data: { executionId: execution.execution.id, evidence },
		});
		return selected(await state(), taskId);
	}

	async function updateRunAfterTask(
		task: WorkflowTaskProjection,
		terminalOutcome: TaskExecutionOutcome,
	): Promise<void> {
		const current = await state();
		if (
			current.status === "completed" ||
			current.status === "completed-degraded" ||
			current.status === "failed" ||
			current.status === "cancelled" ||
			current.status === "interrupted" ||
			current.status === "cleanup-blocked"
		) {
			return;
		}
		if (terminalOutcome === "cleanup-blocked") {
			await append({
				type: "run-status-changed",
				data: {
					from: current.status,
					to: "cleanup-blocked",
					reason: "Child cleanup requires reconciliation.",
				},
			});
			return;
		}
		if (
			task.task.spec.disposition === "required" &&
			(terminalOutcome === "failed" || terminalOutcome === "cancelled") &&
			current.status !== "stopping"
		) {
			await append({
				type: "run-status-changed",
				data: {
					from: current.status,
					to: "failed",
					reason: "A required workflow task did not complete.",
				},
			});
			return;
		}
		if (
			task.task.spec.disposition === "required" &&
			terminalOutcome === "interrupted" &&
			current.status !== "stopping"
		) {
			await append({
				type: "run-status-changed",
				data: {
					from: current.status,
					to: "interrupted",
					reason: "A required workflow task was interrupted.",
				},
			});
			return;
		}
		if (current.status === "stopping") {
			const unsettled = Object.values(current.tasks).some(
				(candidate) =>
					candidate.status !== "completed" &&
					candidate.status !== "failed" &&
					candidate.status !== "cancelled" &&
					candidate.status !== "invalidated",
			);
			if (!unsettled) {
				await append({
					type: "run-status-changed",
					data: {
						from: "stopping",
						to: "cancelled",
						reason: "Workflow stop drained all child work.",
					},
				});
			}
		}
	}

	async function finalizeCurrent(
		taskId: WorkflowTaskId,
	): Promise<WorkflowTaskFinalizationOutcome> {
		let current = await state();
		let { task, execution } = selected(current, taskId);
		if (
			execution.phase === "terminal" &&
			execution.terminal?.evidence.kind === "subagent"
		) {
			if (task.status !== execution.terminal.outcome) {
				await append({
					type: "task-status-changed",
					data: {
						taskId,
						from: task.status,
						to: execution.terminal.outcome,
						reason: "Repair terminal task projection after restart.",
					},
				});
			}
			const repaired = await state();
			const repairedArtifact = execution.artifactImport
				? repaired.artifacts[execution.artifactImport.artifactId]
				: undefined;
			if (execution.terminal.outcome === "completed") {
				if (!repairedArtifact) {
					throw new WorkflowTaskFinalizationError(
						"artifact-import",
						"Completed task has no durable workflow artifact.",
					);
				}
				await artifacts.readJson(repairedArtifact);
			}
			await updateRunAfterTask(task, execution.terminal.outcome);
			const finalState = await state();
			return {
				taskId,
				executionId: execution.execution.id,
				outcome: execution.terminal.outcome,
				...(repairedArtifact ? { artifact: repairedArtifact } : {}),
				runStatus: finalState.status,
			};
		}

		let artifact: WorkflowArtifactRef | undefined;
		if (execution.settlement.evidence.status === "completed") {
			const result = await waitForExactResult(execution);
			try {
				artifact = await importArtifact(
					task,
					execution,
					result.structuredOutput,
				);
			} catch (error) {
				await blockArtifactImport(task, execution);
				if (
					error instanceof WorkflowArtifactStoreError ||
					error instanceof WorkflowTaskFinalizationError
				) {
					throw error;
				}
				throw new WorkflowTaskFinalizationError(
					"artifact-import",
					"Workflow result artifact import failed.",
					{ cause: error },
				);
			}
			current = await state();
			({ task, execution } = selected(current, taskId));
		}

		const child = receipt(execution);
		if (!execution.releaseIntent) {
			await append({
				type: "task-execution-release-intended",
				data: {
					executionId: execution.execution.id,
					subagentRunId: child.runId,
				},
			});
			current = await state();
			({ task, execution } = selected(current, taskId));
		}
		if (!execution.release) {
			let released: RunReceipt;
			try {
				released = await binding.client.release(child.runId);
			} catch (error) {
				throw new WorkflowTaskFinalizationError(
					"release",
					"Child release outcome is uncertain; durable intent remains.",
					{ cause: error },
				);
			}
			validateReleaseReceipt(released, child);
			await append({
				type: "task-execution-released",
				data: {
					executionId: execution.execution.id,
					subagentRunId: child.runId,
					status: released.status,
				},
			});
			current = await state();
			({ task, execution } = selected(current, taskId));
		}
		if (
			execution.release &&
			execution.release.status !== execution.settlement.evidence.status
		) {
			({ task, execution } = await reconcileReleasedStatus(
				taskId,
				execution,
				child,
			));
		}

		const terminalOutcome = outcome(execution.settlement.evidence.status);
		if (execution.phase !== "terminal") {
			await append({
				type: "task-execution-terminal",
				data: {
					executionId: execution.execution.id,
					outcome: terminalOutcome,
					evidence: execution.settlement.evidence,
				},
			});
			current = await state();
			({ task, execution } = selected(current, taskId));
		}
		if (task.status !== terminalOutcome) {
			await append({
				type: "task-status-changed",
				data: {
					taskId,
					from: task.status,
					to: terminalOutcome,
					reason: "Child result imported and release settled.",
				},
			});
		}
		await updateRunAfterTask(task, terminalOutcome);
		const finalized = await state();
		return {
			taskId,
			executionId: execution.execution.id,
			outcome: terminalOutcome,
			...(artifact ? { artifact } : {}),
			runStatus: finalized.status,
		};
	}

	return Object.freeze({
		finalize(taskId: WorkflowTaskId) {
			return mutate(() => finalizeCurrent(taskId));
		},
	});
}
