import { isDeepStrictEqual } from "node:util";
import {
	isRunResult,
	type RunReceipt,
	type RunResult,
	RunStatusSchema,
} from "@vegardx/pi-subagent";
import { Value } from "typebox/value";
import type {
	SubagentTerminalEvidence,
	TaskExecutionId,
	WorkflowRunStatus,
	WorkflowTaskId,
	WorkflowTaskStatus,
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
import {
	createWorkflowTaskLauncher,
	type WorkflowTaskLauncher,
} from "./task-launcher.js";

const TERMINAL_CHILD_STATUSES = new Set([
	"completed",
	"failed",
	"cancelled",
	"abandoned",
	"interrupted",
	"cleanup-blocked",
]);
const DEPENDENCY_FAILURE_STATUSES = new Set<WorkflowTaskStatus>([
	"failed",
	"interrupted",
	"blocked",
	"cancelled",
	"cleanup-blocked",
	"invalidated",
]);
const ACTIVE_TASK_STATUSES = new Set<WorkflowTaskStatus>([
	"ready",
	"running",
	"waiting",
	"cancelling",
]);
const schedulerMutations = new Map<string, Promise<void>>();

export type WorkflowSchedulerOutcome =
	| {
			readonly state: "idle" | "stopping" | "terminal";
			readonly runStatus: WorkflowRunStatus;
	  }
	| {
			readonly state: "awaiting-finalization";
			readonly runStatus: WorkflowRunStatus;
			readonly taskId: WorkflowTaskId;
			readonly executionId: TaskExecutionId;
			readonly child: RunReceipt;
			readonly outcome:
				| "completed"
				| "failed"
				| "cancelled"
				| "interrupted"
				| "cleanup-blocked";
	  };

export interface WorkflowSequentialScheduler {
	drive(): Promise<WorkflowSchedulerOutcome>;
	stop(reason: string): Promise<WorkflowSchedulerOutcome>;
}

export interface WorkflowSequentialSchedulerOptions {
	readonly journal: WorkflowRunJournal;
	readonly binding: WorkflowSubagentBinding;
	readonly launcher?: WorkflowTaskLauncher;
}

export class WorkflowSchedulerError extends Error {
	constructor(
		readonly stage: "validation" | "selection" | "observation" | "stop",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "WorkflowSchedulerError";
	}
}

function isTerminalChildStatus(status: string): boolean {
	return TERMINAL_CHILD_STATUSES.has(status);
}

function executionFor(
	state: WorkflowStateProjection,
	task: WorkflowTaskProjection,
): TaskExecutionProjection | undefined {
	return task.currentExecutionId
		? state.executions[task.currentExecutionId]
		: undefined;
}

function receiptFor(
	execution: TaskExecutionProjection,
): RunReceipt | undefined {
	const receipt = execution.launchReceipt;
	if (!receipt) return undefined;
	return {
		runId: receipt.subagentRunId,
		attemptId: receipt.subagentAttemptId,
		status: receipt.status,
	};
}

function dependencies(
	state: WorkflowStateProjection,
	task: WorkflowTaskProjection,
): readonly WorkflowTaskProjection[] {
	const ids = new Set([
		...task.task.spec.after.map((dependency) => dependency.taskId),
		...Object.values(task.task.spec.inputs).map(
			(input) => input.producerTaskId,
		),
	]);
	return [...ids].map((id) => {
		const dependency = state.tasks[id];
		if (!dependency) {
			throw new WorkflowSchedulerError(
				"selection",
				"Committed workflow task has an unknown dependency.",
			);
		}
		return dependency;
	});
}

function orderedTasks(
	state: WorkflowStateProjection,
): readonly WorkflowTaskProjection[] {
	return Object.values(state.tasks)
		.filter((task) => task.committed)
		.sort(
			(left, right) =>
				left.task.materializationSequence - right.task.materializationSequence,
		);
}

function outcomeFromStatus(
	status: string,
): "completed" | "failed" | "cancelled" | "interrupted" | "cleanup-blocked" {
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
	throw new WorkflowSchedulerError(
		"observation",
		"Subagent settlement has a nonterminal status.",
	);
}

function terminalOutcome(result: RunResult) {
	return outcomeFromStatus(result.status);
}

function settlementEvidence(result: RunResult): SubagentTerminalEvidence {
	const evidence: SubagentTerminalEvidence = {
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
	return evidence;
}

function validateReceipt(
	receipt: RunReceipt,
	expected: RunReceipt,
	stage: "observation" | "stop",
): void {
	if (
		receipt.runId !== expected.runId ||
		receipt.attemptId !== expected.attemptId ||
		!Value.Check(RunStatusSchema, receipt.status)
	) {
		throw new WorkflowSchedulerError(
			stage,
			"Subagent receipt does not match the persisted child identity.",
		);
	}
}

export function createWorkflowSequentialScheduler(
	options: WorkflowSequentialSchedulerOptions,
): WorkflowSequentialScheduler {
	const { binding, journal } = options;
	const launcher =
		options.launcher ?? createWorkflowTaskLauncher({ binding, journal });
	const coordinationKey = journal.directory;

	if (
		binding.workflowRunId !== journal.runId ||
		binding.ownerId !== `pi-workflow:${journal.runId}`
	) {
		throw new WorkflowSchedulerError(
			"validation",
			"Subagent owner binding does not match the workflow journal.",
		);
	}

	function mutate<T>(operation: () => Promise<T>): Promise<T> {
		const predecessor =
			schedulerMutations.get(coordinationKey) ?? Promise.resolve();
		const result = predecessor.then(operation);
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		schedulerMutations.set(coordinationKey, settled);
		void settled.then(() => {
			if (schedulerMutations.get(coordinationKey) === settled) {
				schedulerMutations.delete(coordinationKey);
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

	async function changeRun(
		from: WorkflowRunStatus,
		to: WorkflowRunStatus,
		reason?: string,
	): Promise<void> {
		await append({
			type: "run-status-changed",
			data: { from, to, ...(reason ? { reason } : {}) },
		});
	}

	async function changeTask(
		taskId: WorkflowTaskId,
		from: WorkflowTaskStatus,
		to: WorkflowTaskStatus,
		reason?: string,
	): Promise<void> {
		await append({
			type: "task-status-changed",
			data: { taskId, from, to, ...(reason ? { reason } : {}) },
		});
	}

	async function observeReceipt(
		execution: TaskExecutionProjection,
		receipt: RunReceipt,
	): Promise<void> {
		const previous =
			execution.observation?.status ?? execution.launchReceipt?.status;
		if (execution.observation?.status === receipt.status) return;
		if (previous === receipt.status && !isTerminalChildStatus(receipt.status)) {
			return;
		}
		await append({
			type: "task-execution-child-observed",
			data: {
				executionId: execution.execution.id,
				subagentRunId: receipt.runId,
				subagentAttemptId: receipt.attemptId,
				status: receipt.status,
			},
		});
	}

	async function cancelUnlaunchedTask(
		task: WorkflowTaskProjection,
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
		await changeTask(task.task.id, task.status, "cancelled", reason);
	}

	async function normalizeTask(
		task: WorkflowTaskProjection,
		receipt: RunReceipt,
	): Promise<void> {
		if (task.status === "cancelling") return;
		if (receipt.status === "active") {
			if (task.status !== "running") {
				await changeTask(
					task.task.id,
					task.status,
					"running",
					"Subagent child is active.",
				);
			}
			return;
		}
		if (receipt.status === "stopping") {
			const current = await state();
			if (current.status !== "stopping") {
				await changeRun(
					current.status,
					"stopping",
					"Subagent child is stopping.",
				);
			}
			await changeTask(
				task.task.id,
				task.status,
				"cancelling",
				"Subagent child is stopping.",
			);
			return;
		}
		if (task.status !== "waiting") {
			await changeTask(
				task.task.id,
				task.status,
				"waiting",
				isTerminalChildStatus(receipt.status)
					? "Subagent child requires durable finalization."
					: "Subagent child is queued.",
			);
		}
	}

	async function prepare(): Promise<
		| { state: "wait"; taskId: WorkflowTaskId; receipt: RunReceipt }
		| WorkflowSchedulerOutcome
	> {
		let current = await state();
		if (
			current.status === "completed" ||
			current.status === "completed-degraded" ||
			current.status === "failed" ||
			current.status === "cancelled" ||
			current.status === "interrupted" ||
			current.status === "cleanup-blocked"
		) {
			return { state: "terminal", runStatus: current.status };
		}
		if (current.status === "stopping") {
			return { state: "stopping", runStatus: current.status };
		}
		if (current.status === "created" || current.status === "waiting") {
			await changeRun(current.status, "running");
			current = await state();
		}

		for (const task of orderedTasks(current)) {
			if (task.status !== "pending") continue;
			const blockers = dependencies(current, task).filter((dependency) =>
				DEPENDENCY_FAILURE_STATUSES.has(dependency.status),
			);
			if (blockers.length === 0) continue;
			await changeTask(
				task.task.id,
				"pending",
				"blocked",
				"A workflow task dependency did not complete successfully.",
			);
			current = await state();
		}

		const active = orderedTasks(current).filter(
			(task) =>
				ACTIVE_TASK_STATUSES.has(task.status) &&
				executionFor(current, task)?.launchReceipt !== undefined,
		);
		if (active.length > 1) {
			throw new WorkflowSchedulerError(
				"selection",
				"Sequential workflow has more than one launched task.",
			);
		}

		let selected = active[0];
		if (!selected) {
			selected = orderedTasks(current).find((task) => {
				if (task.status === "ready") return true;
				return (
					task.status === "pending" &&
					dependencies(current, task).every(
						(dependency) => dependency.status === "completed",
					)
				);
			});
		}
		if (!selected) {
			if (current.status === "running") {
				await changeRun(
					"running",
					"waiting",
					"No committed workflow task is currently ready.",
				);
			}
			return { state: "idle", runStatus: "waiting" };
		}
		if (selected.status === "pending") {
			await changeTask(
				selected.task.id,
				"pending",
				"ready",
				"All workflow task dependencies completed.",
			);
			current = await state();
			selected = current.tasks[selected.task.id];
		}
		if (!selected) {
			throw new WorkflowSchedulerError(
				"selection",
				"Selected workflow task disappeared.",
			);
		}

		const selectedExecution = executionFor(current, selected);
		if (selectedExecution?.settlement) {
			const receipt = receiptFor(selectedExecution);
			if (!receipt) {
				throw new WorkflowSchedulerError(
					"selection",
					"Settled workflow task has no persisted child receipt.",
				);
			}
			return {
				state: "awaiting-finalization",
				runStatus: current.status,
				taskId: selected.task.id,
				executionId: selectedExecution.execution.id,
				child: {
					...receipt,
					status: selectedExecution.settlement.evidence.status,
				},
				outcome: outcomeFromStatus(
					selectedExecution.settlement.evidence.status,
				),
			};
		}

		let launch: Awaited<ReturnType<WorkflowTaskLauncher["launch"]>>;
		try {
			launch = await launcher.launch(selected.task.id);
		} catch (error) {
			const failed = await state();
			const failedTask = failed.tasks[selected.task.id];
			if (
				failedTask?.task.spec.disposition === "required" &&
				failedTask.status === "failed" &&
				failed.status === "running"
			) {
				await changeRun(
					"running",
					"failed",
					"A required workflow task failed before launch.",
				);
			}
			throw error;
		}
		if (!("receipt" in launch)) {
			const after = await state();
			const projected = after.tasks[selected.task.id];
			if (
				projected?.task.spec.disposition === "required" &&
				projected.status === "failed" &&
				after.status === "running"
			) {
				await changeRun(
					"running",
					"failed",
					"A required workflow task failed before launch.",
				);
				return { state: "terminal", runStatus: "failed" };
			}
			return { state: "idle", runStatus: after.status };
		}

		current = await state();
		const task = current.tasks[selected.task.id];
		const execution = task ? executionFor(current, task) : undefined;
		if (!task || !execution) {
			throw new WorkflowSchedulerError(
				"selection",
				"Launched workflow task has no durable execution.",
			);
		}
		const persistedReceipt = receiptFor(execution);
		if (!persistedReceipt) {
			throw new WorkflowSchedulerError(
				"selection",
				"Launched workflow task has no persisted child receipt.",
			);
		}
		validateReceipt(launch.receipt, persistedReceipt, "observation");
		const observedStatus = execution.observation?.status;
		const effectiveReceipt = observedStatus
			? { ...launch.receipt, status: observedStatus }
			: launch.receipt;
		await normalizeTask(task, effectiveReceipt);
		const normalized = await state();
		const normalizedTask = normalized.tasks[selected.task.id];
		const normalizedExecution = normalizedTask
			? executionFor(normalized, normalizedTask)
			: undefined;
		if (!normalizedExecution) {
			throw new WorkflowSchedulerError(
				"selection",
				"Normalized workflow task has no durable execution.",
			);
		}
		if (isTerminalChildStatus(effectiveReceipt.status)) {
			await observeReceipt(normalizedExecution, effectiveReceipt);
		}
		return { state: "wait", taskId: selected.task.id, receipt: launch.receipt };
	}

	async function settle(
		taskId: WorkflowTaskId,
		expected: RunReceipt,
	): Promise<WorkflowSchedulerOutcome> {
		let executionResult: Awaited<ReturnType<typeof binding.client.wait>>;
		try {
			executionResult = await binding.client.wait(expected.runId);
		} catch (error) {
			throw new WorkflowSchedulerError(
				"observation",
				"Waiting for the subagent child failed; execution remains durable.",
				{ cause: error },
			);
		}
		if (
			!isRunResult(executionResult.result) ||
			executionResult.result.runId !== expected.runId
		) {
			throw new WorkflowSchedulerError(
				"observation",
				"Subagent wait returned an invalid terminal result.",
			);
		}
		if (
			executionResult.result.status === "completed" &&
			executionResult.result.structuredOutput === undefined
		) {
			throw new WorkflowSchedulerError(
				"observation",
				"Completed subagent result has no structured output.",
			);
		}
		const terminalReceipt: RunReceipt = {
			runId: expected.runId,
			attemptId: expected.attemptId,
			status: executionResult.result.status,
		};
		validateReceipt(terminalReceipt, expected, "observation");
		let evidence: SubagentTerminalEvidence;
		try {
			evidence = settlementEvidence(executionResult.result);
		} catch (error) {
			throw new WorkflowSchedulerError(
				"observation",
				"Subagent terminal result cannot be represented as durable evidence.",
				{ cause: error },
			);
		}

		return mutate(async () => {
			let current = await state();
			const task = current.tasks[taskId];
			let execution = task ? executionFor(current, task) : undefined;
			if (!task || !execution) {
				throw new WorkflowSchedulerError(
					"observation",
					"Workflow task disappeared while recording child settlement.",
				);
			}
			const persisted = receiptFor(execution);
			if (!persisted) {
				throw new WorkflowSchedulerError(
					"observation",
					"Workflow task has no persisted child receipt.",
				);
			}
			validateReceipt(terminalReceipt, persisted, "observation");
			if (
				execution.settlement &&
				!isDeepStrictEqual(execution.settlement.evidence, evidence)
			) {
				throw new WorkflowSchedulerError(
					"observation",
					"Subagent terminal result changed after durable settlement.",
				);
			}
			if (execution.phase !== "settled") {
				if (execution.observation?.status !== terminalReceipt.status) {
					await observeReceipt(execution, terminalReceipt);
					current = await state();
					execution = current.executions[execution.execution.id];
				}
				if (!execution) {
					throw new WorkflowSchedulerError(
						"observation",
						"Workflow execution disappeared after child observation.",
					);
				}
				if (!execution.settlement) {
					await append({
						type: "task-execution-child-settled",
						data: { executionId: execution.execution.id, evidence },
					});
				}
			}
			current = await state();
			return {
				state: "awaiting-finalization",
				runStatus: current.status,
				taskId,
				executionId: execution.execution.id,
				child: terminalReceipt,
				outcome: terminalOutcome(executionResult.result),
			};
		});
	}

	async function drive(): Promise<WorkflowSchedulerOutcome> {
		const prepared = await mutate(prepare);
		if (prepared.state === "stopping") {
			return stop("Resume persisted workflow stop intent.");
		}
		if (prepared.state !== "wait") return prepared;
		return settle(prepared.taskId, prepared.receipt);
	}

	async function stop(reason: string): Promise<WorkflowSchedulerOutcome> {
		if (reason.length < 1 || reason.length > 4096) {
			throw new WorkflowSchedulerError(
				"validation",
				"Workflow stop reason must contain 1 to 4096 characters.",
			);
		}
		const prepared = await mutate(async () => {
			let current = await state();
			if (
				current.status === "completed" ||
				current.status === "completed-degraded" ||
				current.status === "failed" ||
				current.status === "cancelled" ||
				current.status === "cleanup-blocked"
			) {
				return { state: "terminal", runStatus: current.status } as const;
			}
			if (current.status === "created") {
				await changeRun("created", "running", "Workflow stop requested.");
				current = await state();
			}
			if (current.status !== "stopping") {
				await changeRun(current.status, "stopping", reason);
				current = await state();
			}

			const active = orderedTasks(current).filter((task) => {
				const execution = executionFor(current, task);
				return (
					execution !== undefined &&
					!execution.settlement &&
					(execution.launchReceipt !== undefined ||
						execution.phase === "launch-intended" ||
						execution.phase === "launch-uncertain" ||
						execution.phase === "launch-absent")
				);
			});
			if (active.length > 1) {
				throw new WorkflowSchedulerError(
					"stop",
					"Sequential workflow has more than one unsettled child.",
				);
			}
			let selected = active[0];
			const pendingFinalization = orderedTasks(current).find(
				(task) => executionFor(current, task)?.settlement,
			);
			for (const task of orderedTasks(current)) {
				if (selected?.task.id === task.task.id) continue;
				if (
					task.status === "pending" ||
					task.status === "ready" ||
					task.status === "blocked"
				) {
					const execution = executionFor(current, task);
					if (execution?.phase === "terminal" && execution.terminal) {
						await changeTask(
							task.task.id,
							task.status,
							execution.terminal.outcome,
							reason,
						);
					} else if (execution && !execution.launchReceipt) {
						await cancelUnlaunchedTask(task, execution, reason);
					} else {
						await changeTask(task.task.id, task.status, "cancelled", reason);
					}
				}
			}
			if (!selected && pendingFinalization) {
				const execution = executionFor(current, pendingFinalization);
				const receipt = execution ? receiptFor(execution) : undefined;
				if (!execution?.settlement || !receipt) {
					throw new WorkflowSchedulerError(
						"stop",
						"Settled workflow task has incomplete child identity.",
					);
				}
				return {
					state: "awaiting-finalization",
					runStatus: "stopping",
					taskId: pendingFinalization.task.id,
					executionId: execution.execution.id,
					child: { ...receipt, status: execution.settlement.evidence.status },
					outcome: outcomeFromStatus(execution.settlement.evidence.status),
				} as const;
			}
			if (!selected) {
				await changeRun("stopping", "cancelled", reason);
				return { state: "terminal", runStatus: "cancelled" } as const;
			}
			let execution = executionFor(current, selected);
			let receipt = execution ? receiptFor(execution) : undefined;
			if (execution && !receipt) {
				const recovered = await launcher.launch(selected.task.id);
				if (!("receipt" in recovered)) {
					await changeRun(
						"stopping",
						"failed",
						"Uncertain child launch could not be recovered during stop.",
					);
					return { state: "terminal", runStatus: "failed" } as const;
				}
				current = await state();
				selected = current.tasks[selected.task.id];
				execution = selected ? executionFor(current, selected) : undefined;
				receipt = execution ? receiptFor(execution) : undefined;
			}
			if (!selected || !execution || !receipt) {
				throw new WorkflowSchedulerError(
					"stop",
					"Stopping workflow task has no persisted child receipt.",
				);
			}
			if (selected.status !== "cancelling") {
				await changeTask(
					selected.task.id,
					selected.status,
					"cancelling",
					reason,
				);
			}
			let interruptReceipt: RunReceipt;
			try {
				interruptReceipt = await binding.client.interrupt(receipt.runId);
			} catch (error) {
				throw new WorkflowSchedulerError(
					"stop",
					"Subagent interrupt failed after durable workflow stop intent.",
					{ cause: error },
				);
			}
			validateReceipt(interruptReceipt, receipt, "stop");
			const refreshed = await state();
			const refreshedExecution = refreshed.executions[execution.execution.id];
			if (!refreshedExecution) {
				throw new WorkflowSchedulerError(
					"stop",
					"Workflow execution disappeared after interrupt.",
				);
			}
			if (interruptReceipt.status !== receipt.status) {
				await observeReceipt(refreshedExecution, interruptReceipt);
			}
			return {
				state: "wait",
				taskId: selected.task.id,
				receipt,
			} as const;
		});
		if (prepared.state !== "wait") return prepared;
		return settle(prepared.taskId, prepared.receipt);
	}

	return Object.freeze({ drive, stop });
}
