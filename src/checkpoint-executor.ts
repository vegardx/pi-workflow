import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Ajv } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import * as addFormatsModule from "ajv-formats";
import { Value } from "typebox/value";
import {
	readWorkflowArtifactInputs,
	WorkflowArtifactInputError,
} from "./artifact-input.js";
import {
	canonicalArtifactJson,
	type WorkflowArtifactStore,
} from "./artifact-store.js";
import {
	type CheckpointDecisionSource,
	type CheckpointTaskSpec,
	type MaterializedCheckpointTask,
	type TaskExecutionGeneration,
	type TaskExecutionId,
	type TaskExecutionOutcome,
	WORKFLOW_CONTRACT_REVISION,
	type WorkflowArtifactOutput,
	type WorkflowArtifactRef,
	type WorkflowRunStatus,
	type WorkflowTaskId,
	WorkflowTaskIdSchema,
	type WorkflowTaskStatus,
} from "./contracts.js";
import {
	type WorkflowDecisionBinding,
	type WorkflowDecisionRecord,
	WorkflowDecisionRecordError,
	type WorkflowDecisionRecordStore,
} from "./decision-store.js";
import type {
	TaskExecutionProjection,
	WorkflowEventInput,
	WorkflowStateProjection,
	WorkflowTaskProjection,
} from "./events.js";
import {
	deriveCheckpointEffectSha256,
	deriveJsonValueSha256,
	deriveTaskExecutionId,
	deriveWorkflowFailureSha256,
} from "./execution.js";
import type { WorkflowRunJournal } from "./persistence/journal.js";
import {
	isWorkflowReductionRejection,
	reduceWorkflowEvents,
} from "./reducer.js";

const addFormats = (addFormatsModule.default ??
	addFormatsModule) as unknown as FormatsPlugin;

export type WorkflowCheckpointFailureStage =
	| "checkpoint-input"
	| "checkpoint-expired";

export type WorkflowCheckpointTaskOutcome = Extract<
	TaskExecutionOutcome,
	"completed" | "failed" | "cancelled"
>;

export interface WorkflowCheckpointRequestOutcome {
	readonly taskId: WorkflowTaskId;
	readonly executionId: TaskExecutionId;
	readonly state: "requested" | "terminal";
	readonly outcome?: WorkflowCheckpointTaskOutcome;
	readonly expiresAt?: string;
	readonly runStatus: WorkflowRunStatus;
}

export interface WorkflowCheckpointExecutionResult {
	readonly taskId: WorkflowTaskId;
	readonly executionId: TaskExecutionId;
	readonly outcome: WorkflowCheckpointTaskOutcome;
	readonly runStatus: WorkflowRunStatus;
}

export interface WorkflowCheckpointDecisionInput {
	readonly value: unknown;
	readonly decidedBy: string;
	readonly reason?: string;
}

export interface WorkflowCheckpointTaskExecutor {
	/**
	 * Under the scheduler lock: next-generation execution, durable request,
	 * `ready -> waiting` (or the immediate headless default).
	 */
	request(taskId: WorkflowTaskId): Promise<WorkflowCheckpointRequestOutcome>;
	/** Records an immutable operator decision and completes the task. */
	decide(
		taskId: WorkflowTaskId,
		decision: WorkflowCheckpointDecisionInput,
	): Promise<WorkflowCheckpointExecutionResult>;
	/**
	 * Applies expiry and crash repair to every on-path checkpoint; returns the
	 * tasks it settled.
	 */
	sweep(now?: number): Promise<readonly WorkflowCheckpointExecutionResult[]>;
	/**
	 * Terminalizes an open checkpoint as cancelled, or repairs a decided one to
	 * completed.
	 */
	cancel(
		taskId: WorkflowTaskId,
		reason: string,
	): Promise<WorkflowCheckpointExecutionResult>;
}

export interface WorkflowCheckpointTaskExecutorOptions {
	readonly journal: WorkflowRunJournal;
	readonly artifacts: WorkflowArtifactStore;
	readonly decisions: WorkflowDecisionRecordStore;
	readonly signal: () => AbortSignal;
	readonly deadlineAt?: string;
	/** Decide `use-explicit-default` checkpoints immediately. Default false. */
	readonly headless?: boolean;
}

export class WorkflowCheckpointExecutionError extends Error {
	constructor(
		readonly stage: "validation" | "input" | "decision" | "persistence",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "WorkflowCheckpointExecutionError";
	}
}

export const CHECKPOINT_RUN_ENDING_REASON =
	"Workflow run ended before the checkpoint was decided.";

const MESSAGES = Object.freeze({
	notCheckpoint: "Workflow task is not a checkpoint task.",
	notReady: "Checkpoint task is not ready or waiting.",
	noExecution: "Checkpoint task has no durable execution.",
	inputArtifact: "Checkpoint input artifact evidence is incomplete.",
	inputRead: "Checkpoint inputs could not be read and verified.",
	inputIdentity: "Checkpoint inputs do not match durable intent.",
	expired: "Checkpoint expired without a decision.",
	hasExpired: "Checkpoint has expired.",
	notAwaiting: "Checkpoint is not awaiting a decision.",
	alreadyDecided: "Checkpoint is already decided.",
	approver: "Invalid checkpoint approver.",
	reason: "Invalid checkpoint decision reason.",
	schema: "Checkpoint decision does not match its schema.",
	nonJson: "Checkpoint decision is not losslessly JSON serializable.",
	oversized: "Checkpoint decision exceeds the workflow artifact bound.",
	conflict: "Checkpoint decision conflicts with existing decision evidence.",
	awaiting: "Checkpoint awaits a decision.",
	decided: "Checkpoint decided.",
	stopped: "Workflow stop requested.",
});

const DECISION_RECORD_CONFLICT =
	"decision record already exists for this binding";

/** Serialization key reserved for `sweep`; never a valid task id. */
const SWEEP_KEY = "\u0000sweep";

interface CheckpointSelection {
	readonly task: WorkflowTaskProjection & {
		readonly task: MaterializedCheckpointTask;
	};
	readonly execution: TaskExecutionProjection | undefined;
}

/** The recorded decision an execution is completed from. */
interface DecisionEvidence {
	readonly value: unknown;
	readonly source: CheckpointDecisionSource;
	/** The decision record's own time, taken before the record was fsynced. */
	readonly decidedAt: string;
	readonly decidedBy?: string;
	readonly reason?: string;
}

function compareNames(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isCheckpointTask(task: WorkflowTaskProjection): boolean {
	return task.task.spec.kind === "checkpoint";
}

function isOpenPhase(phase: TaskExecutionProjection["phase"]): boolean {
	return phase === "created" || phase === "checkpoint-requested";
}

/** On-path checkpoint tasks in materialization order. */
function pathCheckpoints(
	state: WorkflowStateProjection,
): readonly WorkflowTaskProjection[] {
	return Object.values(state.tasks)
		.filter((task) => task.abandoned !== true && isCheckpointTask(task))
		.sort(
			(left, right) =>
				left.task.materializationSequence - right.task.materializationSequence,
		);
}

function currentExecution(
	state: WorkflowStateProjection,
	task: WorkflowTaskProjection,
): TaskExecutionProjection | undefined {
	return task.currentExecutionId
		? state.executions[task.currentExecutionId]
		: undefined;
}

/** The next generation for a task: one past every execution persisted for it. */
function nextGeneration(
	state: WorkflowStateProjection,
	taskId: WorkflowTaskId,
): TaskExecutionGeneration {
	return (
		1 +
		Object.values(state.executions).filter(
			(execution) => execution.execution.taskId === taskId,
		).length
	);
}

/**
 * Artifacts of one output bound to the producer's current execution.
 * Artifacts of superseded generations remain durable history and never
 * satisfy a lookup.
 */
function outputArtifacts(
	state: WorkflowStateProjection,
	producerTaskId: WorkflowTaskId,
	output: WorkflowArtifactOutput,
): readonly WorkflowArtifactRef[] {
	const executionId = state.tasks[producerTaskId]?.currentExecutionId;
	if (executionId === undefined) return [];
	return Object.values(state.artifacts).filter(
		(artifact) =>
			artifact.producerTaskId === producerTaskId &&
			artifact.producerExecutionId === executionId &&
			artifact.output === output,
	);
}

/** The result artifacts bound to exactly this execution. */
function executionResultArtifacts(
	state: WorkflowStateProjection,
	execution: TaskExecutionProjection,
): readonly WorkflowArtifactRef[] {
	return Object.values(state.artifacts).filter(
		(artifact) =>
			artifact.producerTaskId === execution.execution.taskId &&
			artifact.producerExecutionId === execution.execution.id &&
			artifact.output === "result",
	);
}

function compileSchema(schema: unknown): (value: unknown) => boolean {
	const ajv = new Ajv({ allErrors: true, strict: true, validateSchema: true });
	addFormats(ajv);
	const validate = ajv.compile(schema as object);
	return (value) => validate(value) === true;
}

function losslessJson(value: unknown): boolean {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		return false;
	}
	if (typeof serialized !== "string") return false;
	return isDeepStrictEqual(JSON.parse(serialized), value);
}

/**
 * The digest of a checkpoint's inputs as shown to the approver: each input
 * resolves to the producer's current-execution artifact of the referenced
 * output (a result digest or a handoff digest), keyed by input name.
 */
function checkpointInputsSha256(
	state: WorkflowStateProjection,
	spec: CheckpointTaskSpec,
): string {
	const map: Record<string, string> = {};
	for (const [name, input] of Object.entries(spec.inputs).sort(
		([left], [right]) => compareNames(left, right),
	)) {
		const matches = outputArtifacts(state, input.producerTaskId, input.output);
		if (matches.length !== 1 || !matches[0]) {
			throw new WorkflowCheckpointExecutionError(
				"input",
				MESSAGES.inputArtifact,
			);
		}
		map[name] = matches[0].sha256;
	}
	return deriveJsonValueSha256(map);
}

/** The terminal a run-ending site appends for a non-terminal checkpoint execution. */
function runEndingTerminal(
	execution: TaskExecutionProjection,
	reason: string,
): Extract<WorkflowEventInput, { type: "task-execution-terminal" }>["data"] {
	const executionId = execution.execution.id;
	const decision = execution.checkpointDecision;
	if (execution.phase === "checkpoint-decided" && decision) {
		// The reducer verified the artifact's provenance and digest at the
		// decided event; committing from the projection asks nobody again.
		return {
			executionId,
			outcome: "completed",
			evidence: {
				kind: "checkpoint",
				artifactId: decision.artifactId,
				decisionSha256: decision.decisionSha256,
				source: decision.source,
				...(decision.decidedBy === undefined
					? {}
					: { decidedBy: decision.decidedBy }),
			},
		};
	}
	return {
		executionId,
		outcome: "cancelled",
		evidence: {
			kind: "workflow",
			stage: "stop",
			failureSha256: deriveWorkflowFailureSha256("stop", reason),
			message: reason,
		},
	};
}

/**
 * Settles every non-terminal checkpoint before a run leaves `running`; shared
 * by the scheduler, the task finalizer, and the static runtime. An undecided
 * execution (`created`, `checkpoint-requested`) is cancelled with `reason`; a
 * decided one (`checkpoint-decided`: a crash or failure between its decision
 * and its terminal) is committed as `completed` ("Checkpoint decided.") so the
 * failed run stays invalidatable. An append rejected by the reducer is
 * tolerated when the execution has moved on since it was read (a concurrent
 * decision or commit won): a terminal execution is left alone and an advanced
 * phase is settled again from its new state; any other rejection propagates.
 */
export async function cancelOpenWorkflowCheckpoints(
	journal: WorkflowRunJournal,
	reason: string,
): Promise<void> {
	const read = async (): Promise<WorkflowStateProjection> =>
		reduceWorkflowEvents(await journal.readEvents());
	let state = await read();
	for (const task of pathCheckpoints(state)) {
		const taskId = task.task.id;
		const executionId = currentExecution(state, task)?.execution.id;
		if (executionId === undefined) continue;
		for (;;) {
			const current = state.tasks[taskId];
			const execution = current ? currentExecution(state, current) : undefined;
			if (
				!execution ||
				execution.execution.id !== executionId ||
				execution.phase === "terminal"
			) {
				break;
			}
			if (
				!isOpenPhase(execution.phase) &&
				execution.phase !== "checkpoint-decided"
			) {
				break;
			}
			const attempted = execution.phase;
			const terminal = runEndingTerminal(execution, reason);
			try {
				await journal.appendEvent({
					type: "task-execution-terminal",
					data: terminal,
				});
			} catch (error) {
				if (!isWorkflowReductionRejection(error)) throw error;
				state = await read();
				const after = state.tasks[taskId];
				const moved = after ? currentExecution(state, after) : undefined;
				if (
					moved &&
					moved.execution.id === executionId &&
					moved.phase === attempted
				) {
					throw error;
				}
				continue;
			}
			state = await read();
			const refreshed = state.tasks[taskId];
			if (!refreshed || refreshed.status === terminal.outcome) break;
			try {
				await journal.appendEvent({
					type: "task-status-changed",
					data: {
						taskId,
						from: refreshed.status,
						to: terminal.outcome,
						reason:
							terminal.outcome === "completed" ? MESSAGES.decided : reason,
					},
				});
			} catch (error) {
				if (!isWorkflowReductionRejection(error)) throw error;
				state = await read();
				const after = state.tasks[taskId];
				if (after && after.status !== terminal.outcome) throw error;
			}
			state = await read();
			break;
		}
	}
}

export function createWorkflowCheckpointTaskExecutor(
	options: WorkflowCheckpointTaskExecutorOptions,
): WorkflowCheckpointTaskExecutor {
	const { journal, artifacts, decisions } = options;
	const headless = options.headless === true;
	if (artifacts.runId !== journal.runId) {
		throw new WorkflowCheckpointExecutionError(
			"validation",
			"Checkpoint executor artifacts do not belong to the workflow journal.",
		);
	}
	if (path.dirname(decisions.root) !== journal.directory) {
		throw new WorkflowCheckpointExecutionError(
			"validation",
			"Checkpoint executor decisions do not belong to the workflow journal.",
		);
	}
	const deadlineMs =
		options.deadlineAt === undefined
			? Number.POSITIVE_INFINITY
			: Date.parse(options.deadlineAt);
	const chains = new Map<string, Promise<unknown>>();
	// Compiled validators keyed by canonical schema digest; the set of distinct
	// schemas in one run is bounded by its declared tasks.
	const validators = new Map<string, (value: unknown) => boolean>();

	function schemaValidator(schema: unknown): (value: unknown) => boolean {
		const key = deriveJsonValueSha256(schema);
		let validator = validators.get(key);
		if (!validator) {
			validator = compileSchema(schema);
			validators.set(key, validator);
		}
		return validator;
	}

	async function state(): Promise<WorkflowStateProjection> {
		return reduceWorkflowEvents(await journal.readEvents());
	}

	async function append(input: WorkflowEventInput): Promise<void> {
		await journal.appendEvent(input);
	}

	function select(
		current: WorkflowStateProjection,
		taskId: WorkflowTaskId,
	): CheckpointSelection {
		if (!Value.Check(WorkflowTaskIdSchema, taskId)) {
			throw new WorkflowCheckpointExecutionError(
				"validation",
				"Workflow task id is invalid.",
			);
		}
		const task = current.tasks[taskId];
		if (!task?.committed) {
			throw new WorkflowCheckpointExecutionError(
				"validation",
				"Workflow task is not committed.",
			);
		}
		if (task.task.spec.kind !== "checkpoint") {
			throw new WorkflowCheckpointExecutionError(
				"validation",
				MESSAGES.notCheckpoint,
			);
		}
		return {
			task: task as CheckpointSelection["task"],
			execution: currentExecution(current, task),
		};
	}

	function effectSha256(spec: CheckpointTaskSpec, inputsSha256: string) {
		return deriveCheckpointEffectSha256({
			taskIdentitySha256: spec.identitySha256,
			inputsSha256,
		});
	}

	function binding(
		execution: TaskExecutionProjection,
		spec: CheckpointTaskSpec,
		request: { readonly inputsSha256: string },
	): WorkflowDecisionBinding {
		return {
			kind: "checkpoint",
			runId: journal.runId,
			taskId: execution.execution.taskId,
			executionId: execution.execution.id,
			effectSha256: effectSha256(spec, request.inputsSha256),
		};
	}

	function requestBinding(
		execution: TaskExecutionProjection,
		spec: CheckpointTaskSpec,
	): WorkflowDecisionBinding {
		const request = execution.checkpointRequest;
		if (!request) {
			throw new WorkflowCheckpointExecutionError(
				"persistence",
				"Checkpoint execution has no durable request.",
			);
		}
		return binding(execution, spec, request);
	}

	function expiryFor(
		spec: CheckpointTaskSpec,
		now: number,
	): string | undefined {
		const timeoutMs = spec.request.timeoutMs;
		if (timeoutMs === undefined) return undefined;
		return new Date(Math.min(now + timeoutMs, deadlineMs)).toISOString();
	}

	function isExpired(execution: TaskExecutionProjection, now: number): boolean {
		const expiresAt = execution.checkpointRequest?.expiresAt;
		return (
			execution.phase === "checkpoint-requested" &&
			expiresAt !== undefined &&
			Date.parse(expiresAt) <= now
		);
	}

	async function changeTask(
		taskId: WorkflowTaskId,
		to: WorkflowTaskStatus,
		reason: string,
	): Promise<void> {
		const current = await state();
		const task = current.tasks[taskId];
		if (!task) {
			throw new WorkflowCheckpointExecutionError(
				"persistence",
				"Workflow task disappeared while updating its status.",
			);
		}
		if (task.status === to) return;
		await append({
			type: "task-status-changed",
			data: { taskId, from: task.status, to, reason },
		});
	}

	async function terminalizeFailure(
		execution: TaskExecutionProjection,
		stage: WorkflowCheckpointFailureStage,
		message: string,
	): Promise<void> {
		await append({
			type: "task-execution-terminal",
			data: {
				executionId: execution.execution.id,
				outcome: "failed",
				evidence: {
					kind: "workflow",
					stage,
					failureSha256: deriveWorkflowFailureSha256(stage, message),
					message,
				},
			},
		});
		await changeTask(execution.execution.taskId, "failed", message);
	}

	async function terminalizeCancelled(
		execution: TaskExecutionProjection,
		reason: string,
	): Promise<void> {
		await append({
			type: "task-execution-terminal",
			data: {
				executionId: execution.execution.id,
				outcome: "cancelled",
				evidence: {
					kind: "workflow",
					stage: "stop",
					failureSha256: deriveWorkflowFailureSha256("stop", reason),
					message: reason,
				},
			},
		});
		await changeTask(execution.execution.taskId, "cancelled", reason);
	}

	async function repairTerminalStatus(
		execution: TaskExecutionProjection,
	): Promise<WorkflowCheckpointTaskOutcome> {
		const terminal = execution.terminal;
		if (!terminal) {
			throw new WorkflowCheckpointExecutionError(
				"validation",
				"Checkpoint task execution is not terminal.",
			);
		}
		if (
			terminal.outcome !== "completed" &&
			terminal.outcome !== "failed" &&
			terminal.outcome !== "cancelled"
		) {
			throw new WorkflowCheckpointExecutionError(
				"validation",
				"Checkpoint task execution has a non-checkpoint terminal outcome.",
			);
		}
		await changeTask(
			execution.execution.taskId,
			terminal.outcome,
			terminal.evidence.kind === "workflow"
				? terminal.evidence.message
				: MESSAGES.decided,
		);
		return terminal.outcome;
	}

	async function verifyDecisionArtifact(
		spec: CheckpointTaskSpec,
		execution: TaskExecutionProjection,
		artifact: WorkflowArtifactRef,
	): Promise<void> {
		if (
			artifact.runId !== journal.runId ||
			artifact.producerTaskId !== execution.execution.taskId ||
			artifact.producerExecutionId !== execution.execution.id ||
			artifact.output !== "result" ||
			artifact.mediaType !== "application/json" ||
			artifact.schemaSha256 !== deriveJsonValueSha256(spec.request.schema)
		) {
			throw new WorkflowCheckpointExecutionError(
				"persistence",
				"Checkpoint decision artifact provenance is invalid.",
			);
		}
		let value: unknown;
		try {
			value = await artifacts.readJson(artifact);
		} catch (error) {
			throw new WorkflowCheckpointExecutionError(
				"persistence",
				"Checkpoint decision artifact could not be read and verified.",
				{ cause: error },
			);
		}
		if (!schemaValidator(spec.request.schema)(value)) {
			throw new WorkflowCheckpointExecutionError(
				"persistence",
				"Checkpoint decision artifact does not match its schema.",
			);
		}
	}

	/** Phase `checkpoint-decided`: verify the artifact, terminalize, complete. */
	async function commitFromDecision(
		current: WorkflowStateProjection,
		selection: CheckpointSelection,
	): Promise<void> {
		const execution = selection.execution;
		const decision = execution?.checkpointDecision;
		if (execution?.phase !== "checkpoint-decided" || !decision) {
			throw new WorkflowCheckpointExecutionError(
				"validation",
				"Checkpoint task execution has no durable decision.",
			);
		}
		const artifact = current.artifacts[decision.artifactId];
		if (!artifact || artifact.sha256 !== decision.decisionSha256) {
			throw new WorkflowCheckpointExecutionError(
				"persistence",
				"Checkpoint decision artifact provenance is invalid.",
			);
		}
		await verifyDecisionArtifact(selection.task.task.spec, execution, artifact);
		await append({
			type: "task-execution-terminal",
			data: {
				executionId: execution.execution.id,
				outcome: "completed",
				evidence: {
					kind: "checkpoint",
					artifactId: decision.artifactId,
					decisionSha256: decision.decisionSha256,
					source: decision.source,
					...(decision.decidedBy === undefined
						? {}
						: { decidedBy: decision.decidedBy }),
				},
			},
		});
		await changeTask(selection.task.task.id, "completed", MESSAGES.decided);
	}

	/**
	 * Steps 3-5 of recording a decision: the durable record exists; store the
	 * value as the execution's result artifact, declare it, append the decision
	 * event, and commit. Idempotent for every crash prefix past the record.
	 */
	async function applyDecision(
		selection: CheckpointSelection,
		evidence: DecisionEvidence,
	): Promise<void> {
		const execution = selection.execution;
		if (execution?.phase !== "checkpoint-requested") {
			throw new WorkflowCheckpointExecutionError(
				"validation",
				"Checkpoint task execution is not awaiting a decision.",
			);
		}
		const taskId = selection.task.task.id;
		const spec = selection.task.task.spec;
		const artifact = await artifacts.putJson(evidence.value, {
			runId: journal.runId,
			producerTaskId: taskId,
			producerExecutionId: execution.execution.id,
			output: "result",
			schemaSha256: deriveJsonValueSha256(spec.request.schema),
		});
		const refreshed = await state();
		const conflicting = executionResultArtifacts(refreshed, execution).find(
			(candidate) => candidate.id !== artifact.id,
		);
		if (conflicting) {
			throw new WorkflowCheckpointExecutionError(
				"persistence",
				MESSAGES.conflict,
			);
		}
		if (!refreshed.artifacts[artifact.id]) {
			await append({ type: "artifact-declared", data: { artifact } });
		}
		await append({
			type: "task-execution-checkpoint-decided",
			data: {
				executionId: execution.execution.id,
				artifactId: artifact.id,
				decisionSha256: artifact.sha256,
				source: evidence.source,
				decidedAt: evidence.decidedAt,
				...(evidence.decidedBy === undefined
					? {}
					: { decidedBy: evidence.decidedBy }),
				...(evidence.reason === undefined ? {} : { reason: evidence.reason }),
			},
		});
		const committing = await state();
		await commitFromDecision(committing, select(committing, taskId));
	}

	/**
	 * Validates, records (immutably), stores, and commits one decision.
	 * `decidedAt` is the record's own time, taken by the caller before any
	 * durable step, and travels on the decided event so the reducer judges
	 * timeliness by it rather than by the append time.
	 */
	async function recordDecision(
		selection: CheckpointSelection,
		value: unknown,
		source: CheckpointDecisionSource,
		decidedAt: string,
		decidedBy?: string,
		reason?: string,
	): Promise<void> {
		const execution = selection.execution;
		if (execution?.phase !== "checkpoint-requested") {
			throw new WorkflowCheckpointExecutionError(
				"validation",
				"Checkpoint task execution is not awaiting a decision.",
			);
		}
		const spec = selection.task.task.spec;
		const stage = source === "operator" ? "decision" : "persistence";
		if (!losslessJson(value)) {
			throw new WorkflowCheckpointExecutionError(stage, MESSAGES.nonJson);
		}
		if (!schemaValidator(spec.request.schema)(value)) {
			throw new WorkflowCheckpointExecutionError(stage, MESSAGES.schema);
		}
		let content: Buffer;
		try {
			content = canonicalArtifactJson(value);
		} catch (error) {
			throw new WorkflowCheckpointExecutionError(stage, MESSAGES.nonJson, {
				cause: error,
			});
		}
		if (content.byteLength > artifacts.maxArtifactBytes) {
			throw new WorkflowCheckpointExecutionError(stage, MESSAGES.oversized);
		}
		const record: WorkflowDecisionRecord = {
			schema: "pi-workflow-decision",
			contractRevision: WORKFLOW_CONTRACT_REVISION,
			binding: requestBinding(execution, spec),
			source,
			...(decidedBy === undefined ? {} : { decidedBy }),
			...(reason === undefined ? {} : { reason }),
			decidedAt,
			valueSchemaSha256: deriveJsonValueSha256(spec.request.schema),
			valueSha256: deriveJsonValueSha256(value),
			value,
		};
		try {
			await decisions.put(record);
		} catch (error) {
			if (
				error instanceof WorkflowDecisionRecordError &&
				error.message === DECISION_RECORD_CONFLICT
			) {
				throw new WorkflowCheckpointExecutionError(
					"decision",
					MESSAGES.conflict,
					{ cause: error },
				);
			}
			throw error;
		}
		await applyDecision(selection, {
			value,
			source,
			decidedAt,
			...(decidedBy === undefined ? {} : { decidedBy }),
			...(reason === undefined ? {} : { reason }),
		});
	}

	/**
	 * A decision record persisted for the execution's binding before its event
	 * was journaled (a crash between the two). Replaying it never asks again.
	 */
	async function storedDecision(
		selection: CheckpointSelection,
	): Promise<WorkflowDecisionRecord | undefined> {
		const execution = selection.execution;
		if (execution?.phase !== "checkpoint-requested") {
			return undefined;
		}
		const spec = selection.task.task.spec;
		const record = await decisions.read(requestBinding(execution, spec));
		if (!record) return undefined;
		if (
			record.valueSchemaSha256 !== deriveJsonValueSha256(spec.request.schema)
		) {
			throw new WorkflowCheckpointExecutionError(
				"persistence",
				"Checkpoint decision record does not match its schema.",
			);
		}
		return record;
	}

	async function replayDecision(
		selection: CheckpointSelection,
		record: WorkflowDecisionRecord,
	): Promise<void> {
		await applyDecision(selection, {
			value: record.value,
			source: record.source,
			decidedAt: record.decidedAt,
			...(record.decidedBy === undefined
				? {}
				: { decidedBy: record.decidedBy }),
			...(record.reason === undefined ? {} : { reason: record.reason }),
		});
	}

	async function expireCurrent(
		selection: CheckpointSelection,
	): Promise<WorkflowCheckpointTaskOutcome> {
		const execution = selection.execution;
		if (!execution) {
			throw new WorkflowCheckpointExecutionError(
				"validation",
				MESSAGES.noExecution,
			);
		}
		const spec = selection.task.task.spec;
		if (spec.request.headless === "block") {
			await terminalizeFailure(
				execution,
				"checkpoint-expired",
				MESSAGES.expired,
			);
			return "failed";
		}
		await recordDecision(
			selection,
			spec.request.default,
			"default",
			new Date().toISOString(),
		);
		return "completed";
	}

	async function runStatus(): Promise<WorkflowRunStatus> {
		return (await state()).status;
	}

	async function requestCurrent(
		taskId: WorkflowTaskId,
	): Promise<WorkflowCheckpointRequestOutcome> {
		let current = await state();
		let selection = select(current, taskId);
		const terminal = async (
			executionId: TaskExecutionId,
			outcome: WorkflowCheckpointTaskOutcome,
		): Promise<WorkflowCheckpointRequestOutcome> => ({
			taskId,
			executionId,
			state: "terminal",
			outcome,
			runStatus: await runStatus(),
		});
		const existing = selection.execution;
		if (existing?.phase === "terminal") {
			return terminal(
				existing.execution.id,
				await repairTerminalStatus(existing),
			);
		}
		if (existing?.phase === "checkpoint-decided") {
			await commitFromDecision(current, selection);
			return terminal(existing.execution.id, "completed");
		}
		if (existing?.phase === "checkpoint-requested") {
			const record = await storedDecision(selection);
			if (record) {
				await replayDecision(selection, record);
				return terminal(existing.execution.id, "completed");
			}
			if (isExpired(existing, Date.now())) {
				return terminal(existing.execution.id, await expireCurrent(selection));
			}
			if (selection.task.status === "ready") {
				await changeTask(taskId, "waiting", MESSAGES.awaiting);
			}
			const expiresAt = existing.checkpointRequest?.expiresAt;
			return {
				taskId,
				executionId: existing.execution.id,
				state: "requested",
				...(expiresAt === undefined ? {} : { expiresAt }),
				runStatus: await runStatus(),
			};
		}
		if (selection.task.status !== "ready") {
			throw new WorkflowCheckpointExecutionError(
				"validation",
				MESSAGES.notReady,
			);
		}
		const spec = selection.task.task.spec;
		if (!existing) {
			const generation = nextGeneration(current, taskId);
			await append({
				type: "task-execution-created",
				data: {
					execution: {
						kind: "checkpoint",
						id: deriveTaskExecutionId(journal.runId, taskId, generation),
						runId: journal.runId,
						taskId,
						generation,
						taskIdentitySha256: spec.identitySha256,
					},
				},
			});
			current = await state();
			selection = select(current, taskId);
		}
		const execution = selection.execution;
		if (execution?.phase !== "created") {
			throw new WorkflowCheckpointExecutionError(
				"persistence",
				"Checkpoint task execution was not durably created.",
			);
		}
		if (options.signal().aborted) {
			await terminalizeCancelled(execution, MESSAGES.stopped);
			return terminal(execution.execution.id, "cancelled");
		}
		let inputsSha256: string;
		try {
			inputsSha256 = checkpointInputsSha256(current, spec);
			await readWorkflowArtifactInputs({
				task: selection.task.task,
				state: current,
				artifacts,
			});
		} catch (error) {
			const message =
				error instanceof WorkflowCheckpointExecutionError &&
				error.stage === "input"
					? error.message
					: error instanceof WorkflowArtifactInputError
						? MESSAGES.inputRead
						: undefined;
			if (message === undefined) throw error;
			await terminalizeFailure(execution, "checkpoint-input", message);
			return terminal(execution.execution.id, "failed");
		}
		const expiresAt = expiryFor(spec, Date.now());
		await append({
			type: "task-execution-checkpoint-requested",
			data: {
				executionId: execution.execution.id,
				inputsSha256,
				...(expiresAt === undefined ? {} : { expiresAt }),
			},
		});
		if (headless && spec.request.headless === "use-explicit-default") {
			const requested = await state();
			await recordDecision(
				select(requested, taskId),
				spec.request.default,
				"default",
				new Date().toISOString(),
			);
			return terminal(execution.execution.id, "completed");
		}
		await changeTask(taskId, "waiting", MESSAGES.awaiting);
		return {
			taskId,
			executionId: execution.execution.id,
			state: "requested",
			...(expiresAt === undefined ? {} : { expiresAt }),
			runStatus: await runStatus(),
		};
	}

	function validateDecisionInput(decision: WorkflowCheckpointDecisionInput) {
		const { decidedBy, reason } = decision;
		if (
			typeof decidedBy !== "string" ||
			decidedBy.length < 1 ||
			decidedBy.length > 256
		) {
			throw new WorkflowCheckpointExecutionError(
				"validation",
				MESSAGES.approver,
			);
		}
		if (
			reason !== undefined &&
			(typeof reason !== "string" || reason.length < 1 || reason.length > 4096)
		) {
			throw new WorkflowCheckpointExecutionError("validation", MESSAGES.reason);
		}
	}

	async function decideCurrent(
		taskId: WorkflowTaskId,
		decision: WorkflowCheckpointDecisionInput,
	): Promise<WorkflowCheckpointExecutionResult> {
		validateDecisionInput(decision);
		const current = await state();
		const selection = select(current, taskId);
		const execution = selection.execution;
		if (!execution) {
			throw new WorkflowCheckpointExecutionError(
				"validation",
				MESSAGES.noExecution,
			);
		}
		const alreadyDecided = () =>
			new WorkflowCheckpointExecutionError(
				"validation",
				MESSAGES.alreadyDecided,
			);
		if (execution.phase === "terminal") {
			await repairTerminalStatus(execution);
			throw alreadyDecided();
		}
		if (execution.phase === "checkpoint-decided") {
			await commitFromDecision(current, selection);
			throw alreadyDecided();
		}
		if (execution.phase !== "checkpoint-requested") {
			throw new WorkflowCheckpointExecutionError(
				"validation",
				MESSAGES.notAwaiting,
			);
		}
		const request = execution.checkpointRequest;
		if (!request) {
			throw new WorkflowCheckpointExecutionError(
				"persistence",
				"Checkpoint execution has no durable request.",
			);
		}
		const record = await storedDecision(selection);
		if (record) {
			await replayDecision(selection, record);
			throw alreadyDecided();
		}
		// The decision time is taken before the expiry check, so a decision the
		// check admits is timely by the same clock the reducer judges it with.
		const decidedAt = new Date().toISOString();
		if (isExpired(execution, Date.now())) {
			await expireCurrent(selection);
			throw new WorkflowCheckpointExecutionError(
				"validation",
				MESSAGES.hasExpired,
			);
		}
		let recomputed: string | undefined;
		try {
			recomputed = checkpointInputsSha256(current, selection.task.task.spec);
		} catch (error) {
			if (
				!(error instanceof WorkflowCheckpointExecutionError) ||
				error.stage !== "input"
			) {
				throw error;
			}
		}
		if (recomputed !== request.inputsSha256) {
			throw new WorkflowCheckpointExecutionError(
				"persistence",
				MESSAGES.inputIdentity,
			);
		}
		await recordDecision(
			selection,
			decision.value,
			"operator",
			decidedAt,
			decision.decidedBy,
			decision.reason,
		);
		return {
			taskId,
			executionId: execution.execution.id,
			outcome: "completed",
			runStatus: await runStatus(),
		};
	}

	/** One sweep step for one task; undefined when nothing needed settling. */
	async function sweepTask(
		taskId: WorkflowTaskId,
		now: number,
	): Promise<WorkflowCheckpointExecutionResult | undefined> {
		const current = await state();
		const task = current.tasks[taskId];
		if (!task || task.abandoned === true || !isCheckpointTask(task)) {
			return undefined;
		}
		const selection = select(current, taskId);
		const execution = selection.execution;
		if (!execution) return undefined;
		const result = async (
			outcome: WorkflowCheckpointTaskOutcome,
		): Promise<WorkflowCheckpointExecutionResult> => ({
			taskId,
			executionId: execution.execution.id,
			outcome,
			runStatus: await runStatus(),
		});
		if (execution.phase === "terminal") {
			if (task.status === execution.terminal?.outcome) return undefined;
			return result(await repairTerminalStatus(execution));
		}
		if (execution.phase === "checkpoint-decided") {
			await commitFromDecision(current, selection);
			return result("completed");
		}
		if (execution.phase === "checkpoint-requested") {
			const record = await storedDecision(selection);
			if (record) {
				await replayDecision(selection, record);
				return result("completed");
			}
			if (isExpired(execution, now)) {
				return result(await expireCurrent(selection));
			}
		}
		return undefined;
	}

	async function sweepCurrent(
		now: number,
	): Promise<readonly WorkflowCheckpointExecutionResult[]> {
		const current = await state();
		const settled: WorkflowCheckpointExecutionResult[] = [];
		for (const task of pathCheckpoints(current)) {
			if (!task.currentExecutionId) continue;
			const taskId = task.task.id;
			const result = await serialized(taskId, () => sweepTask(taskId, now));
			if (result) settled.push(result);
		}
		return Object.freeze(settled);
	}

	async function cancelCurrent(
		taskId: WorkflowTaskId,
		reason: string,
	): Promise<WorkflowCheckpointExecutionResult> {
		const current = await state();
		const selection = select(current, taskId);
		const execution = selection.execution;
		if (!execution) {
			throw new WorkflowCheckpointExecutionError(
				"validation",
				MESSAGES.noExecution,
			);
		}
		const result = async (
			outcome: WorkflowCheckpointTaskOutcome,
		): Promise<WorkflowCheckpointExecutionResult> => ({
			taskId,
			executionId: execution.execution.id,
			outcome,
			runStatus: await runStatus(),
		});
		if (execution.phase === "terminal") {
			return result(await repairTerminalStatus(execution));
		}
		if (execution.phase === "checkpoint-decided") {
			await commitFromDecision(current, selection);
			return result("completed");
		}
		if (!isOpenPhase(execution.phase)) {
			throw new WorkflowCheckpointExecutionError(
				"validation",
				"Checkpoint task execution cannot be cancelled from its phase.",
			);
		}
		await terminalizeCancelled(execution, reason);
		return result("cancelled");
	}

	function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
		const predecessor = chains.get(key) ?? Promise.resolve();
		const next = predecessor.then(operation, operation);
		const settled = next.then(
			() => undefined,
			() => undefined,
		);
		chains.set(key, settled);
		void settled.then(() => {
			if (chains.get(key) === settled) chains.delete(key);
		});
		return next;
	}

	return Object.freeze({
		request: (taskId: WorkflowTaskId) =>
			serialized(taskId, () => requestCurrent(taskId)),
		decide: (
			taskId: WorkflowTaskId,
			decision: WorkflowCheckpointDecisionInput,
		) => serialized(taskId, () => decideCurrent(taskId, decision)),
		sweep: (now: number = Date.now()) =>
			serialized(SWEEP_KEY, () => sweepCurrent(now)),
		cancel: (taskId: WorkflowTaskId, reason: string) =>
			serialized(taskId, () => cancelCurrent(taskId, reason)),
	});
}
