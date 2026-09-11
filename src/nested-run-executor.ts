import { Ajv } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import * as addFormatsModule from "ajv-formats";
import { Value } from "typebox/value";
import type { WorkflowArtifactStore } from "./artifact-store.js";
import {
	type MaterializedNestedWorkflowTask,
	type NestedWorkflowUsage,
	type TaskExecutionOutcome,
	type WorkflowArtifactId,
	type WorkflowArtifactRef,
	type WorkflowBudget,
	type WorkflowRunId,
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
	deriveNestedWorkflowRunId,
	deriveTaskExecutionId,
	deriveWorkflowFailureSha256,
} from "./execution.js";
import type { WorkflowRunJournal } from "./persistence/journal.js";
import { reduceWorkflowEvents } from "./reducer.js";

const addFormats = (addFormatsModule.default ??
	addFormatsModule) as unknown as FormatsPlugin;

export type NestedWorkflowTerminalStatus = Extract<
	WorkflowRunStatus,
	| "completed"
	| "completed-degraded"
	| "failed"
	| "cancelled"
	| "interrupted"
	| "cleanup-blocked"
>;

export interface WorkflowNestedRunLaunch {
	readonly childRunId: WorkflowRunId;
	readonly parent: {
		readonly runId: WorkflowRunId;
		readonly taskId: WorkflowTaskId;
		readonly executionId: TaskExecutionProjection["execution"]["id"];
		readonly depth: number;
		readonly ancestorDefinitionIdentities: readonly string[];
	};
	readonly definitionName: string;
	readonly definitionIdentitySha256: string;
	readonly definitionSourceSha256: string;
	readonly input: unknown;
	readonly budget: WorkflowBudget;
	readonly deadlineAt: string;
	readonly concurrency: number;
}

export interface WorkflowNestedRunSettlement {
	readonly status: NestedWorkflowTerminalStatus;
	readonly usage: NestedWorkflowUsage;
	readonly usageComplete: boolean;
	readonly outputArtifact?: WorkflowArtifactRef;
}

export interface WorkflowNestedRunProvider {
	launch(request: WorkflowNestedRunLaunch): Promise<void>;
	wait(childRunId: WorkflowRunId): Promise<WorkflowNestedRunSettlement>;
	/** Reads the child's declared output artifact by id with full verification. */
	readOutput(
		childRunId: WorkflowRunId,
		artifactId: WorkflowArtifactId,
	): Promise<{
		readonly artifact: WorkflowArtifactRef;
		readonly value: unknown;
	}>;
	stop(childRunId: WorkflowRunId, reason: string): Promise<void>;
	reconcile(childRunId: WorkflowRunId): Promise<void>;
}

export class WorkflowNestedRunError extends Error {
	constructor(
		readonly stage:
			| "validation"
			| "resolution"
			| "launch"
			| "import"
			| "persistence",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "WorkflowNestedRunError";
	}
}

export type WorkflowNestedTaskOutcome = Extract<
	TaskExecutionOutcome,
	"completed" | "failed" | "cancelled" | "interrupted" | "cleanup-blocked"
>;

export interface WorkflowNestedLaunchOutcome {
	readonly taskId: WorkflowTaskId;
	readonly executionId: TaskExecutionProjection["execution"]["id"];
	readonly state: "launched" | "terminal";
	readonly outcome?: WorkflowNestedTaskOutcome;
	readonly runStatus: WorkflowRunStatus;
}

export interface WorkflowNestedExecutionResult {
	readonly taskId: WorkflowTaskId;
	readonly executionId: TaskExecutionProjection["execution"]["id"];
	readonly outcome: WorkflowNestedTaskOutcome;
	readonly runStatus: WorkflowRunStatus;
}

export interface WorkflowNestedRunExecutor {
	/** Record, intent, child launch, and `running`; call under the scheduler lock. */
	launch(taskId: WorkflowTaskId): Promise<WorkflowNestedLaunchOutcome>;
	/** Waits for the child, settles, imports output, terminalizes; per-task serialized. */
	wait(taskId: WorkflowTaskId): Promise<WorkflowNestedExecutionResult>;
	/** Stops the child (or cancels before launch) and drains to terminal state. */
	stop(
		taskId: WorkflowTaskId,
		reason: string,
	): Promise<WorkflowNestedExecutionResult>;
	/** Reconciles a cleanup-blocked child and drains to terminal state. */
	reconcile(taskId: WorkflowTaskId): Promise<WorkflowNestedExecutionResult>;
}

export interface WorkflowNestedRunExecutorOptions {
	readonly journal: WorkflowRunJournal;
	readonly artifacts: WorkflowArtifactStore;
	readonly provider: WorkflowNestedRunProvider;
	readonly nesting: {
		readonly depth: number;
		readonly ancestorDefinitionIdentities: readonly string[];
		readonly definitionIdentitySha256: string;
		readonly deadlineAt: string;
	};
}

const MESSAGES = Object.freeze({
	noTime: "Nested workflow has no remaining time before the parent deadline.",
	resolution: "Nested workflow definition could not be resolved exactly.",
	launch: "Nested workflow run could not be launched.",
	import: "Nested workflow output could not be imported.",
	outputSchema: "Nested workflow output does not match its output schema.",
});

interface NestedSelection {
	readonly task: WorkflowTaskProjection & {
		readonly task: MaterializedNestedWorkflowTask;
	};
	readonly execution: TaskExecutionProjection | undefined;
}

function outcomeFor(
	status: NestedWorkflowTerminalStatus,
): WorkflowNestedTaskOutcome {
	if (status === "completed" || status === "completed-degraded") {
		return "completed";
	}
	return status;
}

function terminalStatusOf(
	status: WorkflowRunStatus,
): NestedWorkflowTerminalStatus {
	if (
		status === "completed" ||
		status === "completed-degraded" ||
		status === "failed" ||
		status === "cancelled" ||
		status === "interrupted" ||
		status === "cleanup-blocked"
	) {
		return status;
	}
	throw new WorkflowNestedRunError(
		"persistence",
		"Nested workflow settlement status is not terminal.",
	);
}

function validatorFor(schema: unknown): (value: unknown) => boolean {
	const ajv = new Ajv({ allErrors: true, strict: true, validateSchema: true });
	addFormats(ajv);
	const validate = ajv.compile(schema as object);
	return (value) => validate(value) === true;
}

export function createWorkflowNestedRunExecutor(
	options: WorkflowNestedRunExecutorOptions,
): WorkflowNestedRunExecutor {
	const { journal, artifacts, provider, nesting } = options;
	if (artifacts.runId !== journal.runId) {
		throw new WorkflowNestedRunError(
			"validation",
			"Nested run executor artifacts do not belong to the workflow journal.",
		);
	}
	if (
		!Number.isSafeInteger(nesting.depth) ||
		nesting.depth < 0 ||
		nesting.ancestorDefinitionIdentities.length !== nesting.depth ||
		!/^[a-f0-9]{64}$/.test(nesting.definitionIdentitySha256) ||
		Number.isNaN(Date.parse(nesting.deadlineAt))
	) {
		throw new WorkflowNestedRunError(
			"validation",
			"Nested run executor nesting context is invalid.",
		);
	}
	const chains = new Map<WorkflowTaskId, Promise<unknown>>();
	const validators = new Map<string, (value: unknown) => boolean>();

	function outputValidator(schema: unknown): (value: unknown) => boolean {
		const key = deriveJsonValueSha256(schema);
		let validator = validators.get(key);
		if (!validator) {
			validator = validatorFor(schema);
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
	): NestedSelection {
		if (!Value.Check(WorkflowTaskIdSchema, taskId)) {
			throw new WorkflowNestedRunError(
				"validation",
				"Workflow task id is invalid.",
			);
		}
		const task = current.tasks[taskId];
		if (!task?.committed) {
			throw new WorkflowNestedRunError(
				"validation",
				"Workflow task is not committed.",
			);
		}
		if (task.task.spec.kind !== "workflow") {
			throw new WorkflowNestedRunError(
				"validation",
				"Workflow task is not a nested workflow task.",
			);
		}
		const execution = task.currentExecutionId
			? current.executions[task.currentExecutionId]
			: undefined;
		return { task: task as NestedSelection["task"], execution };
	}

	function childRunIdOf(execution: TaskExecutionProjection): WorkflowRunId {
		if (execution.execution.kind !== "workflow") {
			throw new WorkflowNestedRunError(
				"validation",
				"Task execution is not a nested workflow execution.",
			);
		}
		return execution.execution.childRunId;
	}

	async function changeTask(
		taskId: WorkflowTaskId,
		to: WorkflowTaskStatus,
		reason: string,
	): Promise<void> {
		const current = await state();
		const task = current.tasks[taskId];
		if (!task) {
			throw new WorkflowNestedRunError(
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

	async function terminalizeWorkflowFailure(
		execution: TaskExecutionProjection,
		outcome: "failed" | "cancelled" | "cleanup-blocked",
		stage: "nested-resolution" | "nested-launch" | "nested-import" | "stop",
		message: string,
	): Promise<void> {
		await append({
			type: "task-execution-terminal",
			data: {
				executionId: execution.execution.id,
				outcome,
				evidence: {
					kind: "workflow",
					stage,
					failureSha256: deriveWorkflowFailureSha256(stage, message),
					message,
				},
			},
		});
		await changeTask(execution.execution.taskId, outcome, message);
	}

	async function repairTerminalStatus(
		execution: TaskExecutionProjection,
	): Promise<WorkflowNestedTaskOutcome> {
		const terminal = execution.terminal;
		if (!terminal) {
			throw new WorkflowNestedRunError(
				"validation",
				"Nested workflow execution is not terminal.",
			);
		}
		await changeTask(
			execution.execution.taskId,
			terminal.outcome,
			terminal.evidence.kind === "workflow"
				? terminal.evidence.message
				: `Nested workflow run ${terminal.outcome}.`,
		);
		return terminal.outcome;
	}

	async function launchCurrent(
		taskId: WorkflowTaskId,
	): Promise<WorkflowNestedLaunchOutcome> {
		let current = await state();
		let selection = select(current, taskId);
		const done = async (
			execution: TaskExecutionProjection,
			state_: "launched" | "terminal",
			outcome?: WorkflowNestedTaskOutcome,
		): Promise<WorkflowNestedLaunchOutcome> => ({
			taskId,
			executionId: execution.execution.id,
			state: state_,
			...(outcome ? { outcome } : {}),
			runStatus: (await state()).status,
		});
		if (selection.execution?.phase === "terminal") {
			const outcome = await repairTerminalStatus(selection.execution);
			return done(selection.execution, "terminal", outcome);
		}
		if (
			selection.task.status !== "ready" &&
			selection.task.status !== "running" &&
			selection.task.status !== "cancelling"
		) {
			throw new WorkflowNestedRunError(
				"validation",
				"Nested workflow task is not ready or running.",
			);
		}
		const spec = selection.task.task.spec;
		if (!selection.execution) {
			await append({
				type: "task-execution-created",
				data: {
					execution: {
						kind: "workflow",
						id: deriveTaskExecutionId(journal.runId, taskId, 1),
						runId: journal.runId,
						taskId,
						generation: 1,
						taskIdentitySha256: spec.identitySha256,
						childRunId: deriveNestedWorkflowRunId(journal.runId, taskId, 1),
					},
				},
			});
			current = await state();
			selection = select(current, taskId);
		}
		let execution = selection.execution;
		if (!execution) {
			throw new WorkflowNestedRunError(
				"persistence",
				"Nested workflow execution was not durably created.",
			);
		}
		const childRunId = childRunIdOf(execution);
		if (execution.phase === "created") {
			const now = Date.now();
			const remaining = Date.parse(nesting.deadlineAt) - now;
			const timeoutMs = Math.min(spec.request.timeoutMs, remaining);
			if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
				await terminalizeWorkflowFailure(
					execution,
					"failed",
					"nested-launch",
					MESSAGES.noTime,
				);
				return done(execution, "terminal", "failed");
			}
			await append({
				type: "task-execution-nested-intended",
				data: {
					executionId: execution.execution.id,
					childRunId,
					definitionIdentitySha256: spec.request.definitionIdentitySha256,
					inputSha256: spec.request.inputSha256,
					budget: structuredClone(spec.request.budget),
					timeoutMs,
					deadlineAt: new Date(now + timeoutMs).toISOString(),
					concurrency: spec.request.concurrency,
				},
			});
			current = await state();
			selection = select(current, taskId);
			execution = selection.execution ?? execution;
		}
		if (execution.phase === "nested-intended") {
			const intent = execution.nestedIntent;
			if (!intent) {
				throw new WorkflowNestedRunError(
					"persistence",
					"Nested workflow intent is missing from the projection.",
				);
			}
			try {
				await provider.launch({
					childRunId,
					parent: {
						runId: journal.runId,
						taskId,
						executionId: execution.execution.id,
						depth: nesting.depth + 1,
						ancestorDefinitionIdentities: [
							...nesting.ancestorDefinitionIdentities,
							nesting.definitionIdentitySha256,
						],
					},
					definitionName: spec.request.definitionName,
					definitionIdentitySha256: spec.request.definitionIdentitySha256,
					definitionSourceSha256: spec.request.definitionSourceSha256,
					input: spec.request.input,
					budget: intent.budget,
					deadlineAt: intent.deadlineAt,
					concurrency: intent.concurrency,
				});
			} catch (error) {
				if (
					error instanceof WorkflowNestedRunError &&
					(error.stage === "resolution" || error.stage === "launch")
				) {
					await terminalizeWorkflowFailure(
						execution,
						"failed",
						error.stage === "resolution"
							? "nested-resolution"
							: "nested-launch",
						error.stage === "resolution"
							? MESSAGES.resolution
							: MESSAGES.launch,
					);
					return done(execution, "terminal", "failed");
				}
				throw error;
			}
			await append({
				type: "task-execution-nested-launched",
				data: { executionId: execution.execution.id, childRunId },
			});
		}
		if (selection.task.status === "ready") {
			await changeTask(taskId, "running", "Nested workflow run is active.");
		}
		return done(execution, "launched");
	}

	async function settleCurrent(
		taskId: WorkflowTaskId,
	): Promise<WorkflowNestedExecutionResult> {
		let current = await state();
		let selection = select(current, taskId);
		let execution = selection.execution;
		if (!execution) {
			throw new WorkflowNestedRunError(
				"validation",
				"Nested workflow task has no durable execution.",
			);
		}
		const executionId = execution.execution.id;
		const result = async (
			outcome: WorkflowNestedTaskOutcome,
		): Promise<WorkflowNestedExecutionResult> => ({
			taskId,
			executionId,
			outcome,
			runStatus: (await state()).status,
		});
		if (execution.phase === "terminal") {
			return result(await repairTerminalStatus(execution));
		}
		const childRunId = childRunIdOf(execution);
		if (
			execution.phase === "created" ||
			execution.phase === "nested-intended"
		) {
			throw new WorkflowNestedRunError(
				"validation",
				"Nested workflow run has not been launched.",
			);
		}
		if (execution.phase === "nested-launched") {
			const settlement = await provider.wait(childRunId);
			const completed =
				settlement.status === "completed" ||
				settlement.status === "completed-degraded";
			if (completed && !settlement.outputArtifact) {
				throw new WorkflowNestedRunError(
					"persistence",
					"Completed nested workflow run has no output artifact.",
				);
			}
			await append({
				type: "task-execution-nested-settled",
				data: {
					executionId: execution.execution.id,
					childRunId,
					status: settlement.status,
					usage: structuredClone(settlement.usage),
					usageComplete: settlement.usageComplete,
					...(completed && settlement.outputArtifact
						? {
								outputArtifactId: settlement.outputArtifact.id,
								outputSha256: settlement.outputArtifact.sha256,
							}
						: {}),
				},
			});
			current = await state();
			selection = select(current, taskId);
			execution = selection.execution ?? execution;
		}
		if (execution.phase === "nested-settled") {
			const settlement = execution.nestedSettlement;
			if (!settlement) {
				throw new WorkflowNestedRunError(
					"persistence",
					"Nested workflow settlement is missing from the projection.",
				);
			}
			const status = terminalStatusOf(settlement.status);
			const completed =
				status === "completed" || status === "completed-degraded";
			if (!completed) {
				await append({
					type: "task-execution-terminal",
					data: {
						executionId: execution.execution.id,
						outcome: outcomeFor(status),
						evidence: {
							kind: "nested-workflow",
							childRunId,
							status,
							usage: structuredClone(settlement.usage),
							usageComplete: settlement.usageComplete,
						},
					},
				});
				await changeTask(
					taskId,
					outcomeFor(status),
					`Nested workflow run ${status}.`,
				);
				return result(outcomeFor(status));
			}
			const imported = await importOutput(selection, execution, childRunId);
			if (!imported) return result("cleanup-blocked");
			current = await state();
			selection = select(current, taskId);
			execution = selection.execution ?? execution;
		}
		if (execution.phase === "nested-output-imported") {
			const settlement = execution.nestedSettlement;
			const imported = execution.nestedOutputImport;
			if (!settlement || !imported) {
				throw new WorkflowNestedRunError(
					"persistence",
					"Nested workflow import evidence is missing from the projection.",
				);
			}
			await append({
				type: "task-execution-terminal",
				data: {
					executionId: execution.execution.id,
					outcome: "completed",
					evidence: {
						kind: "nested-workflow",
						childRunId,
						status: settlement.status,
						usage: structuredClone(settlement.usage),
						usageComplete: settlement.usageComplete,
						outputSha256: imported.sourceSha256,
						artifactId: imported.artifactId,
					},
				},
			});
			await changeTask(taskId, "completed", "Nested workflow run completed.");
			return result("completed");
		}
		throw new WorkflowNestedRunError(
			"validation",
			"Nested workflow execution phase cannot be settled.",
		);
	}

	/**
	 * A first import failure terminalizes as cleanup-blocked; a failed retry
	 * from that terminal state leaves the durable evidence as it is.
	 */
	async function blockImport(
		execution: TaskExecutionProjection,
		message: string,
	): Promise<void> {
		if (execution.phase === "terminal") return;
		await terminalizeWorkflowFailure(
			execution,
			"cleanup-blocked",
			"nested-import",
			message,
		);
	}

	async function importOutput(
		selection: NestedSelection,
		execution: TaskExecutionProjection,
		childRunId: WorkflowRunId,
	): Promise<boolean> {
		const settlement = execution.nestedSettlement;
		if (!settlement?.outputArtifactId || !settlement.outputSha256) {
			throw new WorkflowNestedRunError(
				"persistence",
				"Nested workflow settlement has no output identity.",
			);
		}
		const spec = selection.task.task.spec;
		const schemaSha256 = deriveJsonValueSha256(spec.request.outputSchema);
		let value: unknown;
		try {
			const source = await provider.readOutput(
				childRunId,
				settlement.outputArtifactId,
			);
			if (
				source.artifact.runId !== childRunId ||
				source.artifact.sha256 !== settlement.outputSha256 ||
				source.artifact.mediaType !== "application/json" ||
				source.artifact.schemaSha256 !== schemaSha256
			) {
				throw new WorkflowNestedRunError("import", MESSAGES.import);
			}
			value = source.value;
			if (!outputValidator(spec.request.outputSchema)(value)) {
				throw new WorkflowNestedRunError("import", MESSAGES.outputSchema);
			}
		} catch (error) {
			if (
				error instanceof WorkflowNestedRunError &&
				error.stage === "persistence"
			) {
				throw error;
			}
			await blockImport(
				execution,
				error instanceof WorkflowNestedRunError && error.stage === "import"
					? error.message
					: MESSAGES.import,
			);
			return false;
		}
		const artifact = await artifacts.putJson(value, {
			runId: journal.runId,
			producerTaskId: selection.task.task.id,
			output: "result",
			schemaSha256,
		});
		if (artifact.sha256 !== settlement.outputSha256) {
			await blockImport(execution, MESSAGES.import);
			return false;
		}
		const refreshed = await state();
		if (!refreshed.artifacts[artifact.id]) {
			await append({ type: "artifact-declared", data: { artifact } });
		}
		await append({
			type: "task-execution-nested-output-imported",
			data: {
				executionId: execution.execution.id,
				childRunId,
				artifactId: artifact.id,
				sourceArtifactId: settlement.outputArtifactId,
				sourceSha256: settlement.outputSha256,
			},
		});
		return true;
	}

	/**
	 * Runs outside the per-task chain so a child stop is never queued behind
	 * an in-flight wait on that same child.
	 */
	async function requestStop(
		taskId: WorkflowTaskId,
		reason: string,
	): Promise<void> {
		const current = await state();
		const selection = select(current, taskId);
		const execution = selection.execution;
		if (execution?.phase !== "nested-launched") return;
		if (selection.task.status === "running") {
			try {
				await changeTask(taskId, "cancelling", reason);
			} catch (error) {
				const refreshed = (await state()).tasks[taskId];
				if (refreshed?.status === "running") throw error;
			}
		}
		await provider.stop(childRunIdOf(execution), reason);
	}

	async function stopCurrent(
		taskId: WorkflowTaskId,
		reason: string,
	): Promise<WorkflowNestedExecutionResult> {
		const current = await state();
		const selection = select(current, taskId);
		const execution = selection.execution;
		if (!execution) {
			throw new WorkflowNestedRunError(
				"validation",
				"Nested workflow task has no durable execution.",
			);
		}
		if (execution.phase === "terminal") {
			const outcome = await repairTerminalStatus(execution);
			return {
				taskId,
				executionId: execution.execution.id,
				outcome,
				runStatus: (await state()).status,
			};
		}
		if (
			execution.phase === "created" ||
			execution.phase === "nested-intended"
		) {
			await terminalizeWorkflowFailure(execution, "cancelled", "stop", reason);
			return {
				taskId,
				executionId: execution.execution.id,
				outcome: "cancelled",
				runStatus: (await state()).status,
			};
		}
		return settleCurrent(taskId);
	}

	async function reconcileCurrent(
		taskId: WorkflowTaskId,
	): Promise<WorkflowNestedExecutionResult> {
		const current = await state();
		const selection = select(current, taskId);
		const execution = selection.execution;
		if (
			execution?.phase !== "terminal" ||
			execution.terminal?.outcome !== "cleanup-blocked"
		) {
			throw new WorkflowNestedRunError(
				"validation",
				"Nested workflow task is not cleanup-blocked.",
			);
		}
		const childRunId = childRunIdOf(execution);
		const settlement = execution.nestedSettlement;
		if (settlement?.status === "cleanup-blocked") {
			await provider.reconcile(childRunId);
			const next = await provider.wait(childRunId);
			if (next.status === "cleanup-blocked") {
				return {
					taskId,
					executionId: execution.execution.id,
					outcome: "cleanup-blocked",
					runStatus: (await state()).status,
				};
			}
			const completed =
				next.status === "completed" || next.status === "completed-degraded";
			await append({
				type: "task-execution-nested-settled",
				data: {
					executionId: execution.execution.id,
					childRunId,
					status: next.status,
					usage: structuredClone(next.usage),
					usageComplete: next.usageComplete,
					...(completed && next.outputArtifact
						? {
								outputArtifactId: next.outputArtifact.id,
								outputSha256: next.outputArtifact.sha256,
							}
						: {}),
				},
			});
			return settleCurrent(taskId);
		}
		// Import-stage cleanup-blocked: the child completed durably; retry the
		// import from the terminal state (the reducer recovers the phase).
		const imported = await importOutput(selection, execution, childRunId);
		if (!imported) {
			return {
				taskId,
				executionId: execution.execution.id,
				outcome: "cleanup-blocked",
				runStatus: (await state()).status,
			};
		}
		return settleCurrent(taskId);
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
		launch: (taskId: WorkflowTaskId) =>
			serialized(taskId, () => launchCurrent(taskId)),
		wait: (taskId: WorkflowTaskId) =>
			serialized(taskId, () => settleCurrent(taskId)),
		stop: async (taskId: WorkflowTaskId, reason: string) => {
			await requestStop(taskId, reason);
			return serialized(taskId, () => stopCurrent(taskId, reason));
		},
		reconcile: (taskId: WorkflowTaskId) =>
			serialized(taskId, () => reconcileCurrent(taskId)),
	});
}
