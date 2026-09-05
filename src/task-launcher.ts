import { isDeepStrictEqual } from "node:util";
import {
	AgentLaunchPlanSchema,
	AttemptIdSchema,
	RunIdSchema,
	type RunReceipt,
	RunStatusSchema,
	type SubagentPreflight,
	SubagentRequestSchema,
	verifyLaunchPlanIdentity,
} from "@vegardx/pi-subagent";
import { Value } from "typebox/value";
import {
	type MaterializedAgentTask,
	type TaskExecutionRecord,
	type WorkflowTaskId,
	WorkflowTaskIdSchema,
} from "./contracts.js";
import type {
	TaskExecutionProjection,
	WorkflowEventInput,
	WorkflowStateProjection,
} from "./events.js";
import {
	deriveSubagentOperationId,
	deriveTaskExecutionId,
	deriveWorkflowFailureSha256,
} from "./execution.js";
import type { WorkflowRunJournal } from "./persistence/journal.js";
import { reduceWorkflowEvents } from "./reducer.js";
import type { WorkflowSubagentBinding } from "./subagent-provider.js";

export type WorkflowTaskLaunchOutcome =
	| {
			readonly state: "launched" | "already-launched";
			readonly executionId: string;
			readonly receipt: RunReceipt;
	  }
	| {
			readonly state: "absent" | "terminal";
			readonly executionId: string;
	  };

export class WorkflowTaskLaunchError extends Error {
	constructor(
		readonly stage: "validation" | "preflight" | "launch" | "reconciliation",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "WorkflowTaskLaunchError";
	}
}

export interface WorkflowTaskLauncher {
	launch(taskId: WorkflowTaskId): Promise<WorkflowTaskLaunchOutcome>;
}

export interface WorkflowTaskLauncherOptions {
	readonly journal: WorkflowRunJournal;
	readonly binding: WorkflowSubagentBinding;
}

function launchReceipt(
	projection: TaskExecutionProjection,
): RunReceipt | undefined {
	const receipt = projection.launchReceipt;
	if (!receipt) return undefined;
	return {
		runId: receipt.subagentRunId,
		attemptId: receipt.subagentAttemptId,
		status: receipt.status,
	};
}

function isRunReceipt(value: unknown): value is RunReceipt {
	if (typeof value !== "object" || value === null) return false;
	const receipt = value as Partial<RunReceipt>;
	return (
		Value.Check(RunIdSchema, receipt.runId) &&
		Value.Check(AttemptIdSchema, receipt.attemptId) &&
		Value.Check(RunStatusSchema, receipt.status) &&
		Object.keys(receipt).every((key) =>
			["runId", "attemptId", "status"].includes(key),
		)
	);
}

function validatePreflight(
	preflight: SubagentPreflight,
	request: ReturnType<typeof lowerRequest>,
	ownerId: string,
): void {
	if (
		typeof preflight !== "object" ||
		preflight === null ||
		typeof preflight.preflightId !== "string" ||
		preflight.preflightId.length < 1 ||
		preflight.preflightId.length > 128 ||
		!preflight.identitySha256.match(/^[a-f0-9]{64}$/) ||
		!Number.isFinite(Date.parse(preflight.expiresAt)) ||
		Date.parse(preflight.expiresAt) <= Date.now() ||
		!Value.Check(AgentLaunchPlanSchema, preflight.launchPlan) ||
		!verifyLaunchPlanIdentity(preflight.launchPlan) ||
		preflight.identitySha256 !== preflight.launchPlan.identitySha256 ||
		preflight.launchPlan.operationId !== request.operationId ||
		preflight.launchPlan.ownerId !== ownerId ||
		preflight.launchPlan.agent !== request.agent ||
		!isDeepStrictEqual(preflight.launchPlan.task, request.task) ||
		preflight.launchPlan.contextMode !== request.contextMode ||
		!isDeepStrictEqual(preflight.launchPlan.tools, request.tools) ||
		!isDeepStrictEqual(
			preflight.launchPlan.preloadSkills,
			request.preloadSkills,
		) ||
		!isDeepStrictEqual(
			preflight.launchPlan.contextScopes,
			request.contextScopes,
		) ||
		preflight.launchPlan.workspace.mode !== request.workspace.mode ||
		!isDeepStrictEqual(
			preflight.launchPlan.outputSchema,
			request.outputSchema,
		) ||
		!isDeepStrictEqual(preflight.launchPlan.limits, request.limits) ||
		(request.model !== undefined &&
			!isDeepStrictEqual(preflight.launchPlan.model, request.model))
	) {
		throw new WorkflowTaskLaunchError(
			"preflight",
			"Subagent preflight response does not match the workflow task.",
		);
	}
}

function lowerRequest(task: MaterializedAgentTask, operationId: string) {
	if (Object.keys(task.spec.inputs).length > 0) {
		throw new WorkflowTaskLaunchError(
			"validation",
			"Artifact-backed task inputs are unavailable until workflow artifact projection ships.",
		);
	}
	const request = {
		operationId,
		agent: task.spec.request.agent,
		task: structuredClone(task.spec.request.task),
		contextMode: task.spec.request.contextMode,
		...(task.spec.request.model === undefined
			? {}
			: { model: structuredClone(task.spec.request.model) }),
		tools: [...task.spec.request.tools],
		preloadSkills: [...task.spec.request.preloadSkills],
		contextScopes: [...task.spec.request.contextScopes],
		workspace: structuredClone(task.spec.request.workspace),
		outputSchema: structuredClone(task.spec.request.outputSchema),
		limits: structuredClone(task.spec.request.limits),
	};
	if (!Value.Check(SubagentRequestSchema, request)) {
		throw new WorkflowTaskLaunchError(
			"validation",
			"Workflow task cannot be lowered to a subagent request.",
		);
	}
	return request;
}

function executionRecord(
	state: WorkflowStateProjection,
	task: MaterializedAgentTask,
): TaskExecutionRecord {
	const generation = 1;
	return {
		id: deriveTaskExecutionId(state.runId, task.id, generation),
		runId: state.runId,
		taskId: task.id,
		generation,
		taskIdentitySha256: task.spec.identitySha256,
		operationId: deriveSubagentOperationId(state.runId, task.id, generation),
	};
}

async function state(
	journal: WorkflowRunJournal,
): Promise<WorkflowStateProjection> {
	return reduceWorkflowEvents(await journal.readEvents());
}

async function append(
	journal: WorkflowRunJournal,
	input: WorkflowEventInput,
): Promise<void> {
	await journal.appendEvent(input);
}

async function terminalizeWorkflowFailure(
	journal: WorkflowRunJournal,
	execution: TaskExecutionProjection,
	stage: "preflight" | "launch" | "reconciliation",
	message: string,
): Promise<void> {
	await append(journal, {
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
	const current = await state(journal);
	const task = current.tasks[execution.execution.taskId];
	if (!task) {
		throw new WorkflowTaskLaunchError(
			stage,
			"Workflow task disappeared while terminalizing launch failure.",
		);
	}
	await append(journal, {
		type: "task-status-changed",
		data: {
			taskId: task.task.id,
			from: task.status,
			to: "failed",
			reason: message,
		},
	});
}

export function createWorkflowTaskLauncher(
	options: WorkflowTaskLauncherOptions,
): WorkflowTaskLauncher {
	const { binding, journal } = options;
	let tail = Promise.resolve();

	async function persistReceipt(
		execution: TaskExecutionProjection,
		receipt: RunReceipt,
		expected?: SubagentPreflight,
	): Promise<WorkflowTaskLaunchOutcome> {
		if (
			!isRunReceipt(receipt) ||
			(expected !== undefined &&
				(receipt.runId !== expected.launchPlan.runId ||
					receipt.attemptId !== expected.launchPlan.attemptId))
		) {
			throw new WorkflowTaskLaunchError(
				"launch",
				"Subagent launch returned an invalid receipt.",
			);
		}
		await append(journal, {
			type: "task-execution-launch-receipted",
			data: {
				executionId: execution.execution.id,
				operationId: execution.execution.operationId,
				subagentRunId: receipt.runId,
				subagentAttemptId: receipt.attemptId,
				status: receipt.status,
			},
		});
		return {
			state: "launched",
			executionId: execution.execution.id,
			receipt,
		};
	}

	async function reconcileUncertain(
		execution: TaskExecutionProjection,
	): Promise<WorkflowTaskLaunchOutcome> {
		let receipt: RunReceipt | undefined;
		try {
			receipt = await binding.client.findByOperation(
				execution.execution.operationId,
			);
		} catch (error) {
			throw new WorkflowTaskLaunchError(
				"reconciliation",
				"Subagent operation lookup failed; launch remains uncertain.",
				{ cause: error },
			);
		}
		if (receipt) return persistReceipt(execution, receipt);

		await append(journal, {
			type: "task-execution-launch-absent",
			data: {
				executionId: execution.execution.id,
				operationId: execution.execution.operationId,
			},
		});
		const message =
			"No subagent run exists for the persisted launch operation.";
		const current = await state(journal);
		const absent = current.executions[execution.execution.id];
		if (!absent) {
			throw new WorkflowTaskLaunchError(
				"reconciliation",
				"Task execution disappeared after operation lookup.",
			);
		}
		await terminalizeWorkflowFailure(
			journal,
			absent,
			"reconciliation",
			message,
		);
		return { state: "absent", executionId: execution.execution.id };
	}

	async function launchCurrent(
		taskId: WorkflowTaskId,
	): Promise<WorkflowTaskLaunchOutcome> {
		if (!Value.Check(WorkflowTaskIdSchema, taskId)) {
			throw new WorkflowTaskLaunchError(
				"validation",
				"Invalid workflow task identity.",
			);
		}
		if (
			binding.workflowRunId !== journal.runId ||
			binding.ownerId !== `pi-workflow:${journal.runId}`
		) {
			throw new WorkflowTaskLaunchError(
				"validation",
				"Subagent owner binding does not match the workflow journal.",
			);
		}

		let current = await state(journal);
		const task = current.tasks[taskId];
		if (!task?.committed || task.status !== "ready") {
			throw new WorkflowTaskLaunchError(
				"validation",
				"Workflow task is not committed and ready for launch.",
			);
		}
		if (task.task.spec.kind !== "agent") {
			throw new WorkflowTaskLaunchError(
				"validation",
				"Workflow task is not an agent task.",
			);
		}

		let execution = task.currentExecutionId
			? current.executions[task.currentExecutionId]
			: undefined;
		if (!execution) {
			const record = executionRecord(current, task.task);
			lowerRequest(task.task, record.operationId);
			await append(journal, {
				type: "task-execution-created",
				data: { execution: record },
			});
			current = await state(journal);
			execution = current.executions[record.id];
		}
		if (!execution) {
			throw new WorkflowTaskLaunchError(
				"validation",
				"Workflow task execution could not be created.",
			);
		}
		const existingReceipt = launchReceipt(execution);
		if (existingReceipt) {
			return {
				state: "already-launched",
				executionId: execution.execution.id,
				receipt: existingReceipt,
			};
		}
		if (execution.phase === "terminal" || execution.phase === "launch-absent") {
			return { state: "terminal", executionId: execution.execution.id };
		}
		if (execution.phase === "launch-intended") {
			await append(journal, {
				type: "task-execution-launch-uncertain",
				data: {
					executionId: execution.execution.id,
					operationId: execution.execution.operationId,
					reason: "Launch intent has no durable receipt after recovery.",
				},
			});
			current = await state(journal);
			execution = current.executions[execution.execution.id];
		}
		if (execution?.phase === "launch-uncertain") {
			return reconcileUncertain(execution);
		}
		if (execution?.phase !== "created" && execution?.phase !== "preflighted") {
			throw new WorkflowTaskLaunchError(
				"validation",
				"Workflow task execution is not launchable.",
			);
		}

		const request = lowerRequest(task.task, execution.execution.operationId);
		let preflightId = execution.preflight?.preflightId;
		let planIdentitySha256 = execution.preflight?.planIdentitySha256;
		let freshPreflight: SubagentPreflight | undefined;
		const preflightIsReusable =
			execution.preflight !== undefined &&
			execution.preflight.fencingGeneration === journal.fencingGeneration &&
			Date.parse(execution.preflight.expiresAt) > Date.now();
		if (!preflightIsReusable) {
			try {
				freshPreflight = await binding.client.preflight(request);
				validatePreflight(freshPreflight, request, binding.ownerId);
			} catch (error) {
				const message = "Subagent preflight failed before launch.";
				await terminalizeWorkflowFailure(
					journal,
					execution,
					"preflight",
					message,
				);
				throw new WorkflowTaskLaunchError("preflight", message, {
					cause: error,
				});
			}
			await append(journal, {
				type: "task-execution-preflighted",
				data: {
					executionId: execution.execution.id,
					operationId: execution.execution.operationId,
					preflightId: freshPreflight.preflightId,
					planIdentitySha256: freshPreflight.identitySha256,
					expiresAt: freshPreflight.expiresAt,
					...(execution.preflight
						? { supersedesPreflightId: execution.preflight.preflightId }
						: {}),
				},
			});
			preflightId = freshPreflight.preflightId;
			planIdentitySha256 = freshPreflight.identitySha256;
		}
		if (!preflightId || !planIdentitySha256) {
			throw new WorkflowTaskLaunchError(
				"preflight",
				"Task execution has no reusable preflight identity.",
			);
		}

		await append(journal, {
			type: "task-execution-launch-intended",
			data: {
				executionId: execution.execution.id,
				operationId: execution.execution.operationId,
				preflightId,
				planIdentitySha256,
			},
		});
		try {
			const receipt = await binding.client.launch(
				preflightId,
				planIdentitySha256,
			);
			return await persistReceipt(execution, receipt, freshPreflight);
		} catch (error) {
			await append(journal, {
				type: "task-execution-launch-uncertain",
				data: {
					executionId: execution.execution.id,
					operationId: execution.execution.operationId,
					reason: "Launch call ended without a durable receipt.",
				},
			});
			const uncertainState = await state(journal);
			const uncertain = uncertainState.executions[execution.execution.id];
			if (!uncertain) {
				throw new WorkflowTaskLaunchError(
					"launch",
					"Task execution disappeared after uncertain launch.",
					{ cause: error },
				);
			}
			return reconcileUncertain(uncertain);
		}
	}

	return Object.freeze({
		launch(taskId: WorkflowTaskId) {
			const result = tail.then(() => launchCurrent(taskId));
			tail = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
	});
}
