import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	HANDOFF_EXPORT_MEDIA_TYPE,
	type HandoffRef,
	isRunResult,
	type RunReceipt,
	type RunResult,
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
import { currentSubagentAttemptId } from "./attempts.js";
import {
	CHECKPOINT_RUN_ENDING_REASON,
	cancelOpenWorkflowCheckpoints,
} from "./checkpoint-executor.js";
import {
	HandoffRefSchema,
	MAX_WORKFLOW_HANDOFF_BYTES,
	type SubagentHandoffEvidence,
	type SubagentTerminalEvidence,
	type TaskExecutionOutcome,
	WORKFLOW_HANDOFF_FORMAT_SHA256,
	type WorkflowArtifactRef,
	type WorkflowRunStatus,
	type WorkflowTaskId,
} from "./contracts.js";
import type {
	TaskExecutionProjection,
	WorkflowEventInput,
	WorkflowStateProjection,
	WorkflowTaskProjection,
} from "./events.js";
import {
	deriveJsonValueSha256,
	deriveSubagentSettlementEvidence,
	deriveWorkflowFailureSha256,
} from "./execution.js";
import type { WorkflowRunJournal } from "./persistence/journal.js";
import { hasOpenCheckpoint } from "./reducer.js";
import type { WorkflowSubagentBinding } from "./subagent-provider.js";

const addFormats = (addFormatsModule.default ??
	addFormatsModule) as unknown as FormatsPlugin;
const finalizerMutations = new Map<string, Promise<void>>();
const INTERRUPTED_REASON =
	"Interrupted child retained for recovery; no release performed.";
const HANDOFF_IMPORT_BLOCKED_REASON =
	"Workflow handoff artifact import requires reconciliation.";
const HANDOFF_ABSENT_REQUIRED_MESSAGE =
	"Completed worktree task captured no handoff.";
const HANDOFF_ARTIFACT_MISSING_MESSAGE =
	"Completed worktree task has no durable handoff artifact.";
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
		readonly stage:
			| "validation"
			| "artifact-import"
			| "handoff-import"
			| "release",
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
		attemptId: currentSubagentAttemptId(execution) ?? launch.subagentAttemptId,
		status: execution.settlement?.evidence.status ?? launch.status,
	};
}

function attemptOrdinalOf(execution: TaskExecutionProjection): number {
	return (
		1 +
		(execution.attempts ?? []).filter(
			(attempt) => attempt.subagentAttemptId !== undefined,
		).length
	);
}

function isWorktreeTask(task: WorkflowTaskProjection): boolean {
	return (
		task.task.spec.kind === "agent" &&
		task.task.spec.request.workspace.mode === "worktree"
	);
}

function sha256(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

/**
 * git's fixed mbox separator: a single-commit `git format-patch` opens with
 * the rendered commit's object id and the magic date.
 */
function handoffFirstLineMatches(
	content: Buffer,
	handoffCommit: string,
): boolean {
	const newline = content.indexOf(0x0a);
	if (newline === -1) return false;
	return (
		content.subarray(0, newline).toString("utf8") ===
		`From ${handoffCommit} Mon Sep 17 00:00:00 2001`
	);
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
		return journal.readState();
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

	/**
	 * The shared derivation keeps finalizer evidence byte-identical to the
	 * scheduler's settlement; a malformed handoff record cannot match it.
	 */
	function evidenceOf(
		waited: { result: RunResult; handoff?: unknown },
		execution: TaskExecutionProjection,
		stage: "validation" | "release",
		message: string,
	): SubagentTerminalEvidence {
		try {
			return deriveSubagentSettlementEvidence(
				waited,
				attemptOrdinalOf(execution),
			);
		} catch (error) {
			throw new WorkflowTaskFinalizationError(stage, message, { cause: error });
		}
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
		const evidence = evidenceOf(
			waited,
			execution,
			"validation",
			"Child result does not match durable settlement evidence.",
		);
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
		await blockExecution(
			task,
			execution,
			"artifact-import",
			"Workflow result artifact import requires reconciliation.",
		);
	}

	/**
	 * Records durable cleanup-blocked evidence so ordinary scheduling stops and
	 * only explicit reconciliation may advance the task.
	 */
	async function blockExecution(
		task: WorkflowTaskProjection,
		execution: TaskExecutionProjection,
		stage: "artifact-import" | "handoff-import" | "release",
		message: string,
	): Promise<void> {
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
						stage,
						failureSha256: deriveWorkflowFailureSha256(stage, message),
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
		if (task.task.spec.kind !== "agent") {
			throw new WorkflowTaskFinalizationError(
				"artifact-import",
				"Subagent finalizer cannot import support-task output.",
			);
		}
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
			producerExecutionId: execution.execution.id,
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

	function handoffImportError(message: string, cause?: unknown) {
		return new WorkflowTaskFinalizationError(
			"handoff-import",
			message,
			cause === undefined ? undefined : { cause },
		);
	}

	/**
	 * Exports the current attempt's handoff from pi-subagent and proves it is
	 * the settled handoff before any byte reaches the workflow store.
	 */
	async function exportVerifiedHandoff(
		execution: SettledExecution,
		settled: SubagentHandoffEvidence,
		child: RunReceipt,
	): Promise<{ ref: HandoffRef; content: Buffer }> {
		let exported: unknown;
		try {
			exported = await binding.client.exportHandoff(child.runId, {
				maxBytes: MAX_WORKFLOW_HANDOFF_BYTES,
			});
		} catch (error) {
			throw handoffImportError("Subagent handoff export failed.", error);
		}
		const candidate = exported as { ref?: unknown; content?: unknown } | null;
		if (
			typeof candidate !== "object" ||
			candidate === null ||
			!Value.Check(HandoffRefSchema, candidate.ref) ||
			!Buffer.isBuffer(candidate.content)
		) {
			throw handoffImportError(
				"Subagent handoff export returned an invalid reference.",
			);
		}
		const ref = candidate.ref;
		const content = candidate.content;
		const attemptId = currentSubagentAttemptId(execution);
		if (
			ref.runId !== child.runId ||
			ref.attemptId !== attemptId ||
			ref.attemptId !== settled.attemptId ||
			ref.baselineHead !== settled.baselineHead ||
			ref.handoffCommit !== settled.handoffCommit ||
			ref.handoffCommit === ref.baselineHead
		) {
			throw handoffImportError(
				"Exported handoff does not match the settled handoff identity.",
			);
		}
		if (
			ref.format !== "git-format-patch" ||
			ref.mediaType !== HANDOFF_EXPORT_MEDIA_TYPE
		) {
			throw handoffImportError("Exported handoff has an unsupported format.");
		}
		if (content.byteLength !== ref.bytes || sha256(content) !== ref.sha256) {
			throw handoffImportError(
				"Exported handoff digest or size does not match its reference.",
			);
		}
		if (ref.bytes < 1 || ref.bytes > MAX_WORKFLOW_HANDOFF_BYTES) {
			throw handoffImportError(
				"Exported handoff exceeds the workflow handoff bound.",
			);
		}
		if (!handoffFirstLineMatches(content, ref.handoffCommit)) {
			throw handoffImportError(
				"Exported handoff is not a single-commit git-format-patch.",
			);
		}
		return { ref, content };
	}

	/**
	 * Imports the settled handoff as a workflow-owned artifact. A handoff
	 * artifact already declared for this execution is verified and imported
	 * without another export; otherwise the export is verified, stored, and
	 * declared. Every step is idempotent on the durable prefix.
	 */
	async function importHandoff(
		task: WorkflowTaskProjection,
		execution: SettledExecution,
	): Promise<WorkflowArtifactRef> {
		const settled = execution.settlement.evidence.handoff;
		if (!settled) {
			throw handoffImportError("Settled child captured no handoff to import.");
		}
		const child = receipt(execution);
		let current = await state();
		let ref = Object.values(current.artifacts).find(
			(candidate) =>
				candidate.producerTaskId === task.task.id &&
				candidate.producerExecutionId === execution.execution.id &&
				candidate.output === "handoff",
		);
		if (ref) {
			let content: Buffer;
			try {
				content = await artifacts.readBytes(ref);
			} catch (error) {
				throw handoffImportError(HANDOFF_ARTIFACT_MISSING_MESSAGE, error);
			}
			if (!handoffFirstLineMatches(content, settled.handoffCommit)) {
				throw handoffImportError(HANDOFF_ARTIFACT_MISSING_MESSAGE);
			}
		} else {
			const exported = await exportVerifiedHandoff(execution, settled, child);
			ref = await artifacts.putBytes(exported.content, {
				runId: journal.runId,
				producerTaskId: task.task.id,
				producerExecutionId: execution.execution.id,
				output: "handoff",
				mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
				schemaSha256: WORKFLOW_HANDOFF_FORMAT_SHA256,
			});
			current = await state();
			const existing = current.artifacts[ref.id];
			if (existing && !isDeepStrictEqual(existing, ref)) {
				throw handoffImportError(
					"Workflow artifact identity conflicts with durable metadata.",
				);
			}
			if (!existing) {
				await append({ type: "artifact-declared", data: { artifact: ref } });
			}
		}
		const afterDeclaration = await state();
		const projected = afterDeclaration.executions[execution.execution.id];
		if (!projected?.handoffImport) {
			await append({
				type: "task-execution-handoff-imported",
				data: {
					executionId: execution.execution.id,
					subagentRunId: child.runId,
					subagentAttemptId: child.attemptId,
					artifactId: ref.id,
					handoffCommit: settled.handoffCommit,
					baselineHead: settled.baselineHead,
					sha256: ref.sha256,
					bytes: ref.bytes,
				},
			});
		}
		return ref;
	}

	/** Terminal already persisted: the durable handoff blob must still verify. */
	async function verifyRepairedHandoff(
		task: WorkflowTaskProjection,
		execution: SettledExecution,
		repaired: WorkflowStateProjection,
	): Promise<void> {
		const handoffImport = execution.handoffImport;
		if (!handoffImport) {
			if (
				execution.handoffAbsent &&
				task.task.spec.kind === "agent" &&
				task.task.spec.request.handoff === "optional"
			) {
				return;
			}
			throw handoffImportError(HANDOFF_ARTIFACT_MISSING_MESSAGE);
		}
		const handoffArtifact = repaired.artifacts[handoffImport.artifactId];
		if (!handoffArtifact) {
			throw handoffImportError(HANDOFF_ARTIFACT_MISSING_MESSAGE);
		}
		let content: Buffer;
		try {
			content = await artifacts.readBytes(handoffArtifact);
		} catch (error) {
			throw handoffImportError(HANDOFF_ARTIFACT_MISSING_MESSAGE, error);
		}
		if (!handoffFirstLineMatches(content, handoffImport.handoffCommit)) {
			throw handoffImportError(HANDOFF_ARTIFACT_MISSING_MESSAGE);
		}
	}

	/**
	 * A completed worktree child under a required handoff policy that captured
	 * nothing is released first, then fails on workflow evidence.
	 */
	async function failAbsentRequiredHandoff(
		taskId: WorkflowTaskId,
		task: WorkflowTaskProjection,
		execution: SettledExecution,
	): Promise<WorkflowTaskFinalizationOutcome> {
		if (execution.phase !== "terminal") {
			await append({
				type: "task-execution-terminal",
				data: {
					executionId: execution.execution.id,
					outcome: "failed",
					evidence: {
						kind: "workflow",
						stage: "handoff-import",
						failureSha256: deriveWorkflowFailureSha256(
							"handoff-import",
							HANDOFF_ABSENT_REQUIRED_MESSAGE,
						),
						message: HANDOFF_ABSENT_REQUIRED_MESSAGE,
					},
				},
			});
		}
		const current = await state();
		const projectedTask = current.tasks[taskId];
		if (projectedTask && projectedTask.status !== "failed") {
			await append({
				type: "task-status-changed",
				data: {
					taskId,
					from: projectedTask.status,
					to: "failed",
					reason: HANDOFF_ABSENT_REQUIRED_MESSAGE,
				},
			});
		}
		await updateRunAfterTask(task, "failed");
		const finalized = await state();
		return {
			taskId,
			executionId: execution.execution.id,
			outcome: "failed",
			runStatus: finalized.status,
		};
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
		const evidence = evidenceOf(
			updated,
			execution,
			"release",
			"Released child result is unavailable or invalid.",
		);
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

	/**
	 * A run may not fail, interrupt, or block while a checkpoint is open: the
	 * reducer rejects the transition, so every failure path cancels first.
	 * Without an open checkpoint nothing is awaited, so the `from` status read
	 * a moment ago stays current against concurrently driving lanes; after a
	 * cancel the status is re-read for the same reason.
	 */
	async function cancelOpenCheckpoints(
		current: WorkflowStateProjection,
	): Promise<WorkflowRunStatus> {
		if (!hasOpenCheckpoint(current)) return current.status;
		await cancelOpenWorkflowCheckpoints(journal, CHECKPOINT_RUN_ENDING_REASON);
		return (await state()).status;
	}

	async function updateRunAfterTask(
		task: WorkflowTaskProjection,
		terminalOutcome: TaskExecutionOutcome,
	): Promise<void> {
		const current = await state();
		if (current.status === "cleanup-blocked") {
			if (terminalOutcome === "cleanup-blocked") return;
			const recoveredStatus =
				terminalOutcome === "completed"
					? "running"
					: terminalOutcome === "interrupted"
						? "interrupted"
						: "failed";
			if (recoveredStatus !== "running") {
				await cancelOpenCheckpoints(current);
			}
			await append({
				type: "run-status-changed",
				data: {
					from: "cleanup-blocked",
					to: recoveredStatus,
					reason: "Child cleanup reconciliation produced terminal evidence.",
				},
			});
			return;
		}
		if (
			current.status === "completed" ||
			current.status === "completed-degraded" ||
			current.status === "failed" ||
			current.status === "cancelled" ||
			current.status === "interrupted"
		) {
			return;
		}
		if (terminalOutcome === "cleanup-blocked") {
			const from = await cancelOpenCheckpoints(current);
			await append({
				type: "run-status-changed",
				data: {
					from,
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
			const from = await cancelOpenCheckpoints(current);
			await append({
				type: "run-status-changed",
				data: {
					from,
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
			const from = await cancelOpenCheckpoints(current);
			await append({
				type: "run-status-changed",
				data: {
					from,
					to: "interrupted",
					reason: "A required workflow task was interrupted.",
				},
			});
			return;
		}
		if (current.status === "stopping") {
			// Abandoned tasks are history: they never count as work to drain.
			const unsettled = Object.values(current.tasks).some(
				(candidate) =>
					candidate.abandoned !== true &&
					candidate.status !== "completed" &&
					candidate.status !== "failed" &&
					candidate.status !== "cancelled" &&
					candidate.status !== "invalidated" &&
					candidate.status !== "interrupted",
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
		const absentRequiredTerminal =
			execution.terminal?.outcome === "failed" &&
			execution.terminal.evidence.kind === "workflow" &&
			execution.terminal.evidence.stage === "handoff-import";
		if (
			execution.phase === "terminal" &&
			execution.terminal &&
			(execution.terminal.evidence.kind === "subagent" ||
				absentRequiredTerminal)
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
				if (isWorktreeTask(task)) {
					await verifyRepairedHandoff(task, execution, repaired);
				}
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

		if (
			isWorktreeTask(task) &&
			execution.settlement.evidence.status === "completed" &&
			!execution.handoffImport &&
			!execution.handoffAbsent
		) {
			const child = receipt(execution);
			if (execution.settlement.evidence.handoff === undefined) {
				await append({
					type: "task-execution-handoff-absent",
					data: {
						executionId: execution.execution.id,
						subagentRunId: child.runId,
						subagentAttemptId: child.attemptId,
					},
				});
			} else {
				try {
					await importHandoff(task, execution);
				} catch (error) {
					await blockExecution(
						task,
						execution,
						"handoff-import",
						HANDOFF_IMPORT_BLOCKED_REASON,
					);
					await updateRunAfterTask(task, "cleanup-blocked");
					if (
						error instanceof WorkflowTaskFinalizationError &&
						error.stage === "handoff-import"
					) {
						throw error;
					}
					throw handoffImportError(
						"Workflow handoff artifact import failed.",
						error,
					);
				}
			}
			current = await state();
			({ task, execution } = selected(current, taskId));
		}

		if (execution.settlement.evidence.status === "interrupted") {
			if (execution.phase !== "terminal") {
				await append({
					type: "task-execution-terminal",
					data: {
						executionId: execution.execution.id,
						outcome: "interrupted",
						evidence: execution.settlement.evidence,
					},
				});
				current = await state();
				({ task, execution } = selected(current, taskId));
			}
			if (task.status !== "interrupted") {
				await append({
					type: "task-status-changed",
					data: {
						taskId,
						from: task.status,
						to: "interrupted",
						reason: INTERRUPTED_REASON,
					},
				});
			}
			await updateRunAfterTask(task, "interrupted");
			const finalized = await state();
			return {
				taskId,
				executionId: execution.execution.id,
				outcome: "interrupted",
				runStatus: finalized.status,
			};
		}

		let child = receipt(execution);
		if (
			execution.phase === "released" &&
			execution.release?.status !== execution.settlement.evidence.status
		) {
			({ task, execution } = await reconcileReleasedStatus(
				taskId,
				execution,
				child,
			));
			child = receipt(execution);
		}
		const replaceRelease =
			execution.release !== undefined &&
			execution.release.status !== execution.settlement.evidence.status;
		const releaseRequired = !execution.release || replaceRelease;
		if (!execution.releaseIntent || replaceRelease) {
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
		if (releaseRequired) {
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
			try {
				validateReleaseReceipt(released, child);
			} catch (error) {
				await blockExecution(
					task,
					execution,
					"release",
					"Child release returned an invalid receipt; reconciliation is required.",
				);
				throw error;
			}
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

		if (
			isWorktreeTask(task) &&
			execution.handoffAbsent &&
			task.task.spec.kind === "agent" &&
			task.task.spec.request.handoff === "required"
		) {
			return failAbsentRequiredHandoff(taskId, task, execution);
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
