import { performance } from "node:perf_hooks";
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
	type MaterializedSupportTask,
	type TaskExecutionOutcome,
	type WorkflowArtifactRef,
	type WorkflowRunStatus,
	type WorkflowTaskId,
	WorkflowTaskIdSchema,
	type WorkflowTaskStatus,
} from "./contracts.js";
import type {
	TaskExecutionProjection,
	WorkflowEventInput,
	WorkflowStateProjection,
	WorkflowTaskProjection,
} from "./events.js";
import {
	deriveJsonValueSha256,
	deriveSupportImplementationIdentitySha256,
	deriveTaskExecutionId,
	deriveWorkflowFailureSha256,
} from "./execution.js";
import type { WorkflowRunJournal } from "./persistence/journal.js";
import { reduceWorkflowEvents } from "./reducer.js";
import {
	type SupportTaskRegistration,
	supportRegistrationIdentity,
} from "./support.js";

const addFormats = (addFormatsModule.default ??
	addFormatsModule) as unknown as FormatsPlugin;

export type WorkflowSupportFailureStage =
	| "support-resolution"
	| "support-input"
	| "support-execution"
	| "support-output";

export type WorkflowSupportTaskOutcome = Extract<
	TaskExecutionOutcome,
	"completed" | "failed" | "cancelled"
>;

export interface WorkflowSupportIntentOutcome {
	readonly taskId: WorkflowTaskId;
	readonly executionId: TaskExecutionProjection["execution"]["id"];
	readonly state: "intended" | "terminal";
	readonly outcome?: WorkflowSupportTaskOutcome;
	readonly runStatus: WorkflowRunStatus;
}

export interface WorkflowSupportExecutionResult {
	readonly taskId: WorkflowTaskId;
	readonly executionId: TaskExecutionProjection["execution"]["id"];
	readonly outcome: WorkflowSupportTaskOutcome;
	readonly runStatus: WorkflowRunStatus;
}

export interface WorkflowSupportTaskExecutor {
	/**
	 * Persists generation-1 execution, exact registry resolution, durable
	 * support intent, and the `running` transition. Must be called under the
	 * scheduler mutation lock so lane accounting is durable before it returns.
	 */
	intend(taskId: WorkflowTaskId): Promise<WorkflowSupportIntentOutcome>;
	/**
	 * Runs or repairs one intended support execution to terminal evidence and
	 * task status. Safe to call outside the scheduler lock; per-task serialized.
	 */
	execute(taskId: WorkflowTaskId): Promise<WorkflowSupportExecutionResult>;
	/**
	 * Terminalizes an intended-but-not-executing support task as cancelled, or
	 * repairs it to completed when output evidence is already durable.
	 */
	cancel(
		taskId: WorkflowTaskId,
		reason: string,
	): Promise<WorkflowSupportExecutionResult>;
}

export interface WorkflowSupportTaskExecutorOptions {
	readonly journal: WorkflowRunJournal;
	readonly artifacts: WorkflowArtifactStore;
	readonly registrations: ReadonlyMap<string, SupportTaskRegistration>;
	readonly signal: () => AbortSignal;
}

export class WorkflowSupportExecutionError extends Error {
	constructor(
		readonly stage:
			| "validation"
			| "resolution"
			| "input"
			| "execution"
			| "output"
			| "persistence",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "WorkflowSupportExecutionError";
	}
}

const MESSAGES = Object.freeze({
	unregistered: "Support task implementation is not registered.",
	drifted:
		"Support task implementation does not match the constructor registry.",
	inputArtifact: "Support task input artifact evidence is incomplete.",
	inputIdentity: "Support task inputs do not match durable intent.",
	inputRead: "Support task inputs could not be read and verified.",
	parameters: "Support task parameters do not match the registered schema.",
	threw: "Support task implementation failed.",
	nonJson: "Support task output is not losslessly JSON serializable.",
	oversized: "Support task output exceeds the workflow artifact bound.",
	schema: "Support task output does not match its output schema.",
	conflict: "Support task output conflicts with existing artifact evidence.",
});

interface SupportSelection {
	readonly task: WorkflowTaskProjection & {
		readonly task: MaterializedSupportTask;
	};
	readonly execution: TaskExecutionProjection | undefined;
}

function compareNames(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function resultArtifacts(
	state: WorkflowStateProjection,
	producerTaskId: WorkflowTaskId,
): readonly WorkflowArtifactRef[] {
	return Object.values(state.artifacts).filter(
		(artifact) =>
			artifact.producerTaskId === producerTaskId &&
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

function raceAbort<T>(
	operation: () => Promise<T> | T,
	signal: AbortSignal,
): Promise<{ kind: "value"; value: T } | { kind: "aborted" }> {
	const pending = Promise.resolve().then(operation);
	// Consume late settlement so an implementation that ignores abort can never
	// surface an unhandled rejection after the workflow moved on.
	void pending.catch(() => undefined);
	if (signal.aborted) return Promise.resolve({ kind: "aborted" });
	return new Promise((resolve, reject) => {
		const onAbort = () => resolve({ kind: "aborted" });
		signal.addEventListener("abort", onAbort, { once: true });
		pending.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve({ kind: "value", value });
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export function createWorkflowSupportTaskExecutor(
	options: WorkflowSupportTaskExecutorOptions,
): WorkflowSupportTaskExecutor {
	const { journal, artifacts, registrations } = options;
	if (artifacts.runId !== journal.runId) {
		throw new WorkflowSupportExecutionError(
			"validation",
			"Support task executor artifacts do not belong to the workflow journal.",
		);
	}
	const chains = new Map<WorkflowTaskId, Promise<unknown>>();
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
	): SupportSelection {
		if (!Value.Check(WorkflowTaskIdSchema, taskId)) {
			throw new WorkflowSupportExecutionError(
				"validation",
				"Workflow task id is invalid.",
			);
		}
		const task = current.tasks[taskId];
		if (!task?.committed) {
			throw new WorkflowSupportExecutionError(
				"validation",
				"Workflow task is not committed.",
			);
		}
		if (task.task.spec.kind !== "support") {
			throw new WorkflowSupportExecutionError(
				"validation",
				"Workflow task is not a support task.",
			);
		}
		const execution = task.currentExecutionId
			? current.executions[task.currentExecutionId]
			: undefined;
		return {
			task: task as SupportSelection["task"],
			execution,
		};
	}

	function resolve(task: MaterializedSupportTask): SupportTaskRegistration {
		const implementation = task.spec.request.implementation;
		const registration = registrations.get(implementation.name);
		if (!registration) {
			throw new WorkflowSupportExecutionError(
				"resolution",
				MESSAGES.unregistered,
			);
		}
		if (
			supportRegistrationIdentity(registration) !==
				deriveSupportImplementationIdentitySha256(implementation) ||
			typeof registration.execute !== "function"
		) {
			throw new WorkflowSupportExecutionError("resolution", MESSAGES.drifted);
		}
		return registration;
	}

	function inputsSha256(
		current: WorkflowStateProjection,
		task: MaterializedSupportTask,
	): string {
		const map: Record<string, string> = {};
		for (const [name, input] of Object.entries(task.spec.inputs).sort(
			([left], [right]) => compareNames(left, right),
		)) {
			const matches = resultArtifacts(current, input.producerTaskId);
			if (matches.length !== 1 || !matches[0]) {
				throw new WorkflowSupportExecutionError(
					"input",
					MESSAGES.inputArtifact,
				);
			}
			map[name] = matches[0].sha256;
		}
		return deriveJsonValueSha256(map);
	}

	async function changeTask(
		taskId: WorkflowTaskId,
		to: WorkflowTaskStatus,
		reason: string,
	): Promise<void> {
		const current = await state();
		const task = current.tasks[taskId];
		if (!task) {
			throw new WorkflowSupportExecutionError(
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
		stage: WorkflowSupportFailureStage,
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
	): Promise<WorkflowSupportTaskOutcome> {
		const terminal = execution.terminal;
		if (!terminal) {
			throw new WorkflowSupportExecutionError(
				"validation",
				"Support task execution is not terminal.",
			);
		}
		if (
			terminal.outcome !== "completed" &&
			terminal.outcome !== "failed" &&
			terminal.outcome !== "cancelled"
		) {
			throw new WorkflowSupportExecutionError(
				"validation",
				"Support task execution has a non-support terminal outcome.",
			);
		}
		await changeTask(
			execution.execution.taskId,
			terminal.outcome,
			terminal.evidence.kind === "workflow"
				? terminal.evidence.message
				: "Support task completed.",
		);
		return terminal.outcome;
	}

	async function verifyResultArtifact(
		task: MaterializedSupportTask,
		artifact: WorkflowArtifactRef,
	): Promise<void> {
		const outputSchema = task.spec.request.implementation.outputSchema;
		if (
			artifact.runId !== journal.runId ||
			artifact.producerTaskId !== task.id ||
			artifact.output !== "result" ||
			artifact.mediaType !== "application/json" ||
			artifact.schemaSha256 !== deriveJsonValueSha256(outputSchema)
		) {
			throw new WorkflowSupportExecutionError(
				"persistence",
				"Support task result artifact provenance is invalid.",
			);
		}
		let value: unknown;
		try {
			value = await artifacts.readJson(artifact);
		} catch (error) {
			throw new WorkflowSupportExecutionError(
				"persistence",
				"Support task result artifact could not be read and verified.",
				{ cause: error },
			);
		}
		if (!schemaValidator(outputSchema)(value)) {
			throw new WorkflowSupportExecutionError(
				"persistence",
				"Support task result artifact does not match its output schema.",
			);
		}
	}

	async function commitFromArtifact(
		selection: SupportSelection,
		artifact: WorkflowArtifactRef,
		durationMs: number,
	): Promise<void> {
		const execution = selection.execution;
		if (!execution?.supportIntent) {
			throw new WorkflowSupportExecutionError(
				"validation",
				"Support task execution has no durable intent.",
			);
		}
		if (execution.phase === "support-intended") {
			await append({
				type: "task-execution-support-output-committed",
				data: {
					executionId: execution.execution.id,
					artifactId: artifact.id,
					outputSha256: artifact.sha256,
				},
			});
		} else if (execution.phase === "support-output-committed") {
			if (
				execution.supportOutput?.artifactId !== artifact.id ||
				execution.supportOutput.outputSha256 !== artifact.sha256
			) {
				throw new WorkflowSupportExecutionError(
					"persistence",
					MESSAGES.conflict,
				);
			}
		} else {
			throw new WorkflowSupportExecutionError(
				"validation",
				"Support task execution cannot commit output from its phase.",
			);
		}
		await append({
			type: "task-execution-terminal",
			data: {
				executionId: execution.execution.id,
				outcome: "completed",
				evidence: {
					kind: "support",
					implementationIdentitySha256:
						execution.supportIntent.implementationIdentitySha256,
					parametersSha256: execution.supportIntent.parametersSha256,
					inputsSha256: execution.supportIntent.inputsSha256,
					outputSha256: artifact.sha256,
					artifactId: artifact.id,
					durationMs,
				},
			},
		});
		await changeTask(
			selection.task.task.id,
			"completed",
			"Support task completed.",
		);
	}

	async function intendCurrent(
		taskId: WorkflowTaskId,
	): Promise<WorkflowSupportIntentOutcome> {
		let current = await state();
		let selection = select(current, taskId);
		if (selection.execution?.phase === "terminal") {
			const outcome = await repairTerminalStatus(selection.execution);
			return {
				taskId,
				executionId: selection.execution.execution.id,
				state: "terminal",
				outcome,
				runStatus: (await state()).status,
			};
		}
		if (
			selection.task.status !== "ready" &&
			selection.task.status !== "running"
		) {
			throw new WorkflowSupportExecutionError(
				"validation",
				"Support task is not ready or running.",
			);
		}
		const spec = selection.task.task.spec;
		if (!selection.execution) {
			await append({
				type: "task-execution-created",
				data: {
					execution: {
						kind: "support",
						id: deriveTaskExecutionId(journal.runId, taskId, 1),
						runId: journal.runId,
						taskId,
						generation: 1,
						taskIdentitySha256: spec.identitySha256,
						implementationIdentitySha256:
							deriveSupportImplementationIdentitySha256(
								spec.request.implementation,
							),
					},
				},
			});
			current = await state();
			selection = select(current, taskId);
		}
		const execution = selection.execution;
		if (!execution) {
			throw new WorkflowSupportExecutionError(
				"persistence",
				"Support task execution was not durably created.",
			);
		}
		try {
			resolve(selection.task.task);
		} catch (error) {
			if (
				error instanceof WorkflowSupportExecutionError &&
				error.stage === "resolution"
			) {
				await terminalizeFailure(
					execution,
					"support-resolution",
					error.message,
				);
				return {
					taskId,
					executionId: execution.execution.id,
					state: "terminal",
					outcome: "failed",
					runStatus: (await state()).status,
				};
			}
			throw error;
		}
		if (options.signal().aborted) {
			await terminalizeCancelled(execution, "Workflow stop requested.");
			return {
				taskId,
				executionId: execution.execution.id,
				state: "terminal",
				outcome: "cancelled",
				runStatus: (await state()).status,
			};
		}
		if (execution.phase === "created") {
			let inputs: string;
			try {
				inputs = inputsSha256(current, selection.task.task);
			} catch (error) {
				if (
					error instanceof WorkflowSupportExecutionError &&
					error.stage === "input"
				) {
					await terminalizeFailure(execution, "support-input", error.message);
					return {
						taskId,
						executionId: execution.execution.id,
						state: "terminal",
						outcome: "failed",
						runStatus: (await state()).status,
					};
				}
				throw error;
			}
			await append({
				type: "task-execution-support-intended",
				data: {
					executionId: execution.execution.id,
					implementationIdentitySha256:
						execution.execution.kind === "support"
							? execution.execution.implementationIdentitySha256
							: deriveSupportImplementationIdentitySha256(
									spec.request.implementation,
								),
					parametersSha256: deriveJsonValueSha256(spec.request.parameters),
					inputsSha256: inputs,
				},
			});
		}
		if (selection.task.status === "ready") {
			await changeTask(taskId, "running", "Support task execution started.");
		}
		return {
			taskId,
			executionId: execution.execution.id,
			state: "intended",
			runStatus: (await state()).status,
		};
	}

	async function executeCurrent(
		taskId: WorkflowTaskId,
	): Promise<WorkflowSupportExecutionResult> {
		const current = await state();
		const selection = select(current, taskId);
		const execution = selection.execution;
		if (!execution) {
			throw new WorkflowSupportExecutionError(
				"validation",
				"Support task has no durable execution.",
			);
		}
		const result = async (
			outcome: WorkflowSupportTaskOutcome,
		): Promise<WorkflowSupportExecutionResult> => ({
			taskId,
			executionId: execution.execution.id,
			outcome,
			runStatus: (await state()).status,
		});
		if (execution.phase === "terminal") {
			return result(await repairTerminalStatus(execution));
		}
		let registration: SupportTaskRegistration;
		try {
			registration = resolve(selection.task.task);
		} catch (error) {
			if (
				error instanceof WorkflowSupportExecutionError &&
				error.stage === "resolution"
			) {
				await terminalizeFailure(
					execution,
					"support-resolution",
					error.message,
				);
				return result("failed");
			}
			throw error;
		}
		const task = selection.task.task;
		const declared = resultArtifacts(current, task.id);
		if (declared.length > 1) {
			throw new WorkflowSupportExecutionError("persistence", MESSAGES.conflict);
		}
		const existing = declared[0];
		if (execution.phase === "support-output-committed") {
			if (!existing) {
				throw new WorkflowSupportExecutionError(
					"persistence",
					"Support task output commit has no declared artifact.",
				);
			}
			await verifyResultArtifact(task, existing);
			await commitFromArtifact(selection, existing, 0);
			return result("completed");
		}
		if (execution.phase !== "support-intended" || !execution.supportIntent) {
			throw new WorkflowSupportExecutionError(
				"validation",
				"Support task execution has no durable intent.",
			);
		}
		if (existing) {
			await verifyResultArtifact(task, existing);
			await commitFromArtifact(selection, existing, 0);
			return result("completed");
		}
		const signal = options.signal();
		if (signal.aborted) {
			await terminalizeCancelled(execution, "Workflow stop requested.");
			return result("cancelled");
		}

		let inputs: Readonly<Record<string, unknown>>;
		try {
			if (
				inputsSha256(current, task) !== execution.supportIntent.inputsSha256
			) {
				throw new WorkflowSupportExecutionError(
					"input",
					MESSAGES.inputIdentity,
				);
			}
			inputs = await readWorkflowArtifactInputs({
				task,
				state: current,
				artifacts,
			});
		} catch (error) {
			const message =
				error instanceof WorkflowSupportExecutionError &&
				error.stage === "input"
					? error.message
					: error instanceof WorkflowArtifactInputError
						? MESSAGES.inputRead
						: undefined;
			if (message === undefined) throw error;
			await terminalizeFailure(execution, "support-input", message);
			return result("failed");
		}
		const parameters = task.spec.request.parameters;
		if (
			!schemaValidator(registration.parametersSchema)(parameters) ||
			deriveJsonValueSha256(parameters) !==
				execution.supportIntent.parametersSha256
		) {
			await terminalizeFailure(execution, "support-input", MESSAGES.parameters);
			return result("failed");
		}

		const started = performance.now();
		let raced: Awaited<ReturnType<typeof raceAbort<unknown>>>;
		try {
			raced = await raceAbort(
				() =>
					registration.execute({
						parameters,
						inputs,
						signal,
					}),
				signal,
			);
		} catch {
			await terminalizeFailure(execution, "support-execution", MESSAGES.threw);
			return result("failed");
		}
		const durationMs = Math.max(0, Math.round(performance.now() - started));
		if (raced.kind === "aborted") {
			await terminalizeCancelled(execution, "Workflow stop requested.");
			return result("cancelled");
		}
		const value = raced.value;
		if (!losslessJson(value)) {
			await terminalizeFailure(execution, "support-output", MESSAGES.nonJson);
			return result("failed");
		}
		let content: Buffer;
		try {
			content = canonicalArtifactJson(value);
		} catch {
			await terminalizeFailure(execution, "support-output", MESSAGES.nonJson);
			return result("failed");
		}
		if (content.byteLength > artifacts.maxArtifactBytes) {
			await terminalizeFailure(execution, "support-output", MESSAGES.oversized);
			return result("failed");
		}
		const outputSchema = task.spec.request.implementation.outputSchema;
		if (
			!schemaValidator(outputSchema)(value) ||
			!schemaValidator(registration.outputSchema)(value)
		) {
			await terminalizeFailure(execution, "support-output", MESSAGES.schema);
			return result("failed");
		}
		const artifact = await artifacts.putJson(value, {
			runId: journal.runId,
			producerTaskId: task.id,
			output: "result",
			schemaSha256: deriveJsonValueSha256(outputSchema),
		});
		const refreshed = await state();
		const refreshedSelection = select(refreshed, taskId);
		const conflicting = resultArtifacts(refreshed, task.id).find(
			(candidate) => candidate.id !== artifact.id,
		);
		if (conflicting) {
			await terminalizeFailure(
				refreshedSelection.execution ?? execution,
				"support-output",
				MESSAGES.conflict,
			);
			return result("failed");
		}
		if (!refreshed.artifacts[artifact.id]) {
			await append({ type: "artifact-declared", data: { artifact } });
		}
		const committing = select(await state(), taskId);
		await commitFromArtifact(committing, artifact, durationMs);
		return result("completed");
	}

	async function cancelCurrent(
		taskId: WorkflowTaskId,
		reason: string,
	): Promise<WorkflowSupportExecutionResult> {
		const current = await state();
		const selection = select(current, taskId);
		const execution = selection.execution;
		if (!execution) {
			throw new WorkflowSupportExecutionError(
				"validation",
				"Support task has no durable execution.",
			);
		}
		const result = async (
			outcome: WorkflowSupportTaskOutcome,
		): Promise<WorkflowSupportExecutionResult> => ({
			taskId,
			executionId: execution.execution.id,
			outcome,
			runStatus: (await state()).status,
		});
		if (execution.phase === "terminal") {
			return result(await repairTerminalStatus(execution));
		}
		if (execution.phase === "support-output-committed") {
			const existing = resultArtifacts(current, selection.task.task.id)[0];
			if (!existing) {
				throw new WorkflowSupportExecutionError(
					"persistence",
					"Support task output commit has no declared artifact.",
				);
			}
			await verifyResultArtifact(selection.task.task, existing);
			await commitFromArtifact(selection, existing, 0);
			return result("completed");
		}
		await terminalizeCancelled(execution, reason);
		return result("cancelled");
	}

	function serialized<T>(
		taskId: WorkflowTaskId,
		operation: () => Promise<T>,
	): Promise<T> {
		const predecessor = chains.get(taskId) ?? Promise.resolve();
		const next = predecessor.then(operation, operation);
		const settled = next.then(
			() => undefined,
			() => undefined,
		);
		chains.set(taskId, settled);
		void settled.then(() => {
			if (chains.get(taskId) === settled) chains.delete(taskId);
		});
		return next;
	}

	return Object.freeze({
		intend: (taskId: WorkflowTaskId) =>
			serialized(taskId, () => intendCurrent(taskId)),
		execute: (taskId: WorkflowTaskId) =>
			serialized(taskId, () => executeCurrent(taskId)),
		cancel: (taskId: WorkflowTaskId, reason: string) =>
			serialized(taskId, () => cancelCurrent(taskId, reason)),
	});
}
