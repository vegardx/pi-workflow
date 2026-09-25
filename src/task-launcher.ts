import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	AgentLaunchPlanSchema,
	AttemptIdSchema,
	type DelegationCeiling,
	RunIdSchema,
	type RunReceipt,
	RunStatusSchema,
	type SubagentPreflight,
	type SubagentRequest,
	SubagentRequestSchema,
	verifyLaunchPlanIdentity,
} from "@vegardx/pi-subagent";
import { Value } from "typebox/value";
import {
	projectWorkflowArtifactInputs,
	validateWorkflowTaskContext,
} from "./artifact-input.js";
import { WorkflowArtifactStore } from "./artifact-store.js";
import { currentSubagentAttempt } from "./attempts.js";
import {
	type MaterializedAgentTask,
	type SubagentOperationId,
	type TaskExecutionGeneration,
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
	readonly artifacts?: WorkflowArtifactStore;
	/**
	 * Absolute directories of agent definitions that travel with the running
	 * definition's root, lowered onto every request this launcher makes. They
	 * are the run's, not the task's: pi-subagent consults them only for a name
	 * its own discovery does not define, so a host's global definition and a
	 * trusted project's `.pi/agents` still win.
	 */
	readonly agentRoots?: readonly string[];
	/**
	 * The host's delegation ceiling this run started under, from the run record,
	 * lowered onto every request this launcher makes. It is the RUN's, not the
	 * task's: a task spec that carried it would put a host mode into task
	 * identity, and a run keeps the ceiling it started with either way.
	 *
	 * Absent means no bound, which is what a host that registered no provider
	 * means. A request above the ceiling is refused by pi-subagent's preflight
	 * ("workspace mode exceeds host ceiling: …", "tool exceeds host ceiling: …"),
	 * which the launcher relays unchanged as the task's failure.
	 */
	readonly ceiling?: DelegationCeiling;
}

function launchReceipt(
	projection: TaskExecutionProjection,
): RunReceipt | undefined {
	const receipt = projection.launchReceipt;
	if (!receipt) return undefined;
	// A retry or resume attempt supersedes the launch attempt; the receipt
	// handed back after restart must name the current attempt.
	const attempt = currentSubagentAttempt(projection);
	return {
		runId: receipt.subagentRunId,
		attemptId: attempt?.subagentAttemptId ?? receipt.subagentAttemptId,
		status: attempt?.status ?? receipt.status,
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

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** Fixed prefix of every pre-launch preflight failure. */
const PREFLIGHT_FAILURE_MESSAGE = "Subagent preflight failed before launch.";
/**
 * How much of a relayed pi-subagent refusal is journaled. The evidence message
 * is bounded at 4096 characters and pi-subagent's own messages share that
 * bound, so the relay is cut rather than allowed to fail the append.
 */
const MAX_RELAYED_REFUSAL_CHARS = 1024;

/**
 * Fixed prefix of a mismatch the workflow itself found in a preflight
 * response pi-subagent already accepted. The condition that failed is named
 * after it: nothing else reaches the journal, and "it did not match" without
 * saying WHAT did not match is an account nobody can act on.
 */
const PREFLIGHT_MISMATCH_MESSAGE =
	"Subagent preflight response does not match the workflow task";

/** The mismatch sentence for one named condition. */
function preflightMismatchMessage(reason: string): string {
	return `${PREFLIGHT_MISMATCH_MESSAGE}: ${reason.slice(0, MAX_RELAYED_REFUSAL_CHARS)}.`;
}

/**
 * The preflight failure message for a refusal raised by pi-subagent itself.
 * The refusal text is relayed unchanged after the fixed prefix; a refusal with
 * no message degrades to the prefix alone.
 */
function preflightFailureMessage(error: unknown): string {
	const relayed = error instanceof Error ? error.message.trim() : "";
	if (relayed.length === 0) return PREFLIGHT_FAILURE_MESSAGE;
	return `${PREFLIGHT_FAILURE_MESSAGE} ${relayed.slice(0, MAX_RELAYED_REFUSAL_CHARS)}`;
}

function sameStringSet(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return isDeepStrictEqual([...left].sort(), [...right].sort());
}

/**
 * Whether `plan` carries every value `request` selected. The launch plan may
 * hold MORE than the request asked for, because pi-subagent unions the agent
 * definition's own requirements into it; it may never hold less.
 */
function covers(plan: readonly string[], request: readonly string[]): boolean {
	return request.every((value) => plan.includes(value));
}

/** One set, rendered for a mismatch reason: sorted, deduplicated, bracketed. */
function renderSet(values: readonly string[]): string {
	return `[${[...new Set(values)].sort().join(" ")}]`;
}

/**
 * The ceiling condition, named. The plan states the bound it was compiled
 * under, and pi-subagent records each of its lists sorted, so the comparison
 * is over SETS: a host that stated `["write", "read"]` bounds the same run as
 * one that stated `["read", "write"]`, and an order-sensitive comparison would
 * refuse every launch of the first host's runs.
 */
function ceilingMismatch(
	plan: DelegationCeiling | undefined,
	requested: DelegationCeiling | undefined,
): string | undefined {
	if (plan === undefined || requested === undefined) {
		if (plan === requested) return undefined;
		return `ceiling: plan ${plan === undefined ? "none" : "present"} != request ${requested === undefined ? "none" : "present"}`;
	}
	for (const field of ["workspaceModes", "tools"] as const) {
		const planned = plan[field];
		const asked = requested[field];
		if (planned === undefined || asked === undefined) {
			if (planned === asked) continue;
			return `ceiling ${field}: plan ${planned === undefined ? "none" : renderSet(planned)} != request ${asked === undefined ? "none" : renderSet(asked)}`;
		}
		if (!sameStringSet(planned, asked)) {
			return `ceiling ${field}: plan ${renderSet(planned)} != request ${renderSet(asked)}`;
		}
	}
	return undefined;
}

/**
 * The FIRST condition a preflight response fails, named, or `undefined` when
 * the response is the plan this task asked for.
 *
 * Every reason is built from field names and from the tool, skill, scope and
 * mode names the workflow itself put in the request. None of it carries a
 * path, a digest, or a word the child wrote, which is what makes the reason
 * safe to journal and to show a person: the launch never happened, so the
 * mismatch is the only account of why the task failed.
 */
function preflightMismatch(
	preflight: SubagentPreflight,
	request: SubagentRequest,
	ownerId: string,
): string | undefined {
	if (typeof preflight !== "object" || preflight === null) {
		return "preflight response shape";
	}
	if (
		typeof preflight.preflightId !== "string" ||
		preflight.preflightId.length < 1 ||
		preflight.preflightId.length > 128
	) {
		return "preflight identity";
	}
	if (!SHA256_PATTERN.test(preflight.identitySha256)) {
		return "preflight digest";
	}
	if (
		!Number.isFinite(Date.parse(preflight.expiresAt)) ||
		Date.parse(preflight.expiresAt) <= Date.now()
	) {
		return "expired";
	}
	if (!Value.Check(AgentLaunchPlanSchema, preflight.launchPlan)) {
		// The instance path of the first violation names the field and nothing
		// else: TypeBox reports where, never the value it found there.
		const [first] = [
			...Value.Errors(AgentLaunchPlanSchema, preflight.launchPlan),
		];
		return `launch plan schema${first ? `: ${first.instancePath || "/"}` : ""}`;
	}
	const plan = preflight.launchPlan;
	if (
		!verifyLaunchPlanIdentity(plan) ||
		preflight.identitySha256 !== plan.identitySha256
	) {
		return "launch plan identity";
	}
	if (plan.operationId !== request.operationId) return "operation id";
	if (plan.ownerId !== ownerId) return "owner id";
	if (plan.agent !== request.agent) return "agent";
	if (!isDeepStrictEqual(plan.task, request.task)) return "task";
	if (plan.contextMode !== request.contextMode) return "context mode";
	// Tools are a sorted copy of the request's own list: pi-subagent bounds them
	// by the agent definition rather than adding to them, so this is equality.
	if (!sameStringSet(plan.tools, request.tools)) {
		return `tools: plan ${renderSet(plan.tools)} != request ${renderSet(request.tools)}`;
	}
	// Skills and context scopes are UNIONS of what the agent definition requires
	// with what the task selected (pi-subagent's `compileLaunchPlan`), so the
	// plan may add to them - the `reviewer` template requires the `project`
	// scope, and a task that selected none still gets it. What a plan may never
	// do is drop something the task asked for.
	if (!covers(plan.preloadSkills, request.preloadSkills)) {
		return `preload skills: plan ${renderSet(plan.preloadSkills)} does not cover request ${renderSet(request.preloadSkills)}`;
	}
	if (!covers(plan.contextScopes, request.contextScopes)) {
		return `context scopes: plan ${renderSet(plan.contextScopes)} does not cover request ${renderSet(request.contextScopes)}`;
	}
	if (plan.workspace.mode !== request.workspace.mode) {
		return "workspace mode";
	}
	// The baseline digest is persisted as replay identity on the preflight
	// event; a plan without a well-formed digest cannot be journaled. The launch
	// plan schema already bounds it, and this states the workflow's own need of
	// it rather than inheriting one.
	if (!SHA256_PATTERN.test(plan.workspace.baselineSha256)) {
		return "workspace baseline digest";
	}
	if (!isDeepStrictEqual(plan.outputSchema, request.outputSchema)) {
		return "output schema";
	}
	if (!isDeepStrictEqual(plan.limits, request.limits)) return "limits";
	// The plan always carries a resolved grant. A request that named one
	// must get exactly it; a request that named none inherits the agent
	// definition's ceiling, which the workflow cannot predict.
	if (
		request.memoryBytes !== undefined &&
		plan.sandbox.memoryBytes !== request.memoryBytes
	) {
		return "sandbox memory grant";
	}
	if (
		request.model !== undefined &&
		!isDeepStrictEqual(plan.model, request.model)
	) {
		return "model";
	}
	// A plan that dropped or widened the run's ceiling would tell the workflow a
	// bound was applied that was not.
	return ceilingMismatch(plan.ceiling, request.ceiling);
}

async function lowerRequest(
	task: MaterializedAgentTask,
	operationId: string,
	current: WorkflowStateProjection,
	artifacts?: WorkflowArtifactStore,
	agentRoots: readonly string[] = [],
	ceiling?: DelegationCeiling,
): Promise<SubagentRequest> {
	const hasInputs = Object.keys(task.spec.inputs).length > 0;
	if (hasInputs && !artifacts) {
		throw new WorkflowTaskLaunchError(
			"validation",
			"Workflow artifact store is unavailable for task input projection.",
		);
	}
	const projected =
		hasInputs && artifacts
			? await projectWorkflowArtifactInputs({ task, state: current, artifacts })
			: [];
	const context = [...task.spec.request.task.context, ...projected];
	validateWorkflowTaskContext(context);
	// Fields are lowered explicitly: the workflow-only handoff policy
	// (task.spec.request.handoff) is never sent to pi-subagent.
	const request = {
		operationId,
		agent: task.spec.request.agent,
		// The definition root's own templates. Not part of the persisted task
		// spec: which directory a definition was loaded from is a property of
		// this run's registry, not of the task's identity.
		...(agentRoots.length === 0 ? {} : { agentRoots: [...agentRoots] }),
		task: {
			...structuredClone(task.spec.request.task),
			context,
		},
		contextMode: task.spec.request.contextMode,
		...(task.spec.request.model === undefined
			? {}
			: { model: structuredClone(task.spec.request.model) }),
		tools: [...task.spec.request.tools],
		preloadSkills: [...task.spec.request.preloadSkills],
		contextScopes: [...task.spec.request.contextScopes],
		workspace: structuredClone(task.spec.request.workspace),
		...(task.spec.request.memoryBytes === undefined
			? {}
			: { memoryBytes: task.spec.request.memoryBytes }),
		outputSchema: structuredClone(task.spec.request.outputSchema),
		limits: structuredClone(task.spec.request.limits),
		// The run's ceiling, not the task's. Not part of the persisted task spec:
		// which bound the host was under is a property of the run, and putting it
		// into task identity would make the same graph hash differently per mode.
		...(ceiling === undefined ? {} : { ceiling: structuredClone(ceiling) }),
	};
	if (!Value.Check(SubagentRequestSchema, request)) {
		throw new WorkflowTaskLaunchError(
			"validation",
			"Workflow task cannot be lowered to a subagent request.",
		);
	}
	return request;
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

function executionRecord(
	state: WorkflowStateProjection,
	task: MaterializedAgentTask,
): TaskExecutionRecord {
	const generation = nextGeneration(state, task.id);
	return {
		kind: "agent",
		id: deriveTaskExecutionId(state.runId, task.id, generation),
		runId: state.runId,
		taskId: task.id,
		generation,
		taskIdentitySha256: task.spec.identitySha256,
		operationId: deriveSubagentOperationId(state.runId, task.id, generation),
	};
}

function agentOperationId(
	execution: TaskExecutionProjection,
): SubagentOperationId {
	if (execution.execution.kind !== "agent") {
		throw new WorkflowTaskLaunchError(
			"validation",
			"Workflow task execution is not an agent execution.",
		);
	}
	return execution.execution.operationId;
}

async function state(
	journal: WorkflowRunJournal,
): Promise<WorkflowStateProjection> {
	return journal.readState();
}

async function append(
	journal: WorkflowRunJournal,
	input: WorkflowEventInput,
): Promise<void> {
	await journal.appendEvent(input);
}

async function failTask(
	journal: WorkflowRunJournal,
	execution: TaskExecutionProjection,
	message: string,
): Promise<void> {
	const current = await state(journal);
	const task = current.tasks[execution.execution.taskId];
	if (!task) {
		throw new WorkflowTaskLaunchError(
			"validation",
			"Workflow task disappeared while terminalizing launch failure.",
		);
	}
	if (task.status === "failed") return;
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
	await failTask(journal, execution, message);
}

export function createWorkflowTaskLauncher(
	options: WorkflowTaskLauncherOptions,
): WorkflowTaskLauncher {
	const { binding, journal } = options;
	const configuredArtifacts = options.artifacts;
	if (
		configuredArtifacts &&
		(configuredArtifacts.runId !== journal.runId ||
			path.dirname(configuredArtifacts.root) !== journal.directory)
	) {
		throw new WorkflowTaskLaunchError(
			"validation",
			"Workflow artifact store does not match the workflow journal.",
		);
	}
	let artifactStore: Promise<WorkflowArtifactStore> | undefined;
	let tail = Promise.resolve();

	function artifactsFor(task: MaterializedAgentTask) {
		if (Object.keys(task.spec.inputs).length === 0) return undefined;
		if (configuredArtifacts) return Promise.resolve(configuredArtifacts);
		artifactStore ??= WorkflowArtifactStore.open({ journal });
		return artifactStore;
	}

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
				operationId: agentOperationId(execution),
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
				agentOperationId(execution),
			);
		} catch (error) {
			throw new WorkflowTaskLaunchError(
				"reconciliation",
				"Subagent operation lookup failed; launch remains uncertain.",
				{ cause: error },
			);
		}
		if (receipt) {
			try {
				return await persistReceipt(execution, receipt);
			} catch (error) {
				throw new WorkflowTaskLaunchError(
					"reconciliation",
					"Recovered subagent launch receipt is invalid or could not be persisted.",
					{ cause: error },
				);
			}
		}

		await append(journal, {
			type: "task-execution-launch-absent",
			data: {
				executionId: execution.execution.id,
				operationId: agentOperationId(execution),
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
		if (!task?.committed) {
			throw new WorkflowTaskLaunchError(
				"validation",
				"Workflow task is not committed for launch.",
			);
		}
		if (task.task.spec.kind !== "agent") {
			throw new WorkflowTaskLaunchError(
				"validation",
				"Workflow task is not an agent task.",
			);
		}
		const agentTask = task.task as MaterializedAgentTask;

		let execution = task.currentExecutionId
			? current.executions[task.currentExecutionId]
			: undefined;
		const existingReceipt = execution ? launchReceipt(execution) : undefined;
		if (execution && existingReceipt) {
			return {
				state: "already-launched",
				executionId: execution.execution.id,
				receipt: existingReceipt,
			};
		}
		if (execution?.phase === "launch-absent") {
			const message =
				"No subagent run exists for the persisted launch operation.";
			await terminalizeWorkflowFailure(
				journal,
				execution,
				"reconciliation",
				message,
			);
			return { state: "absent", executionId: execution.execution.id };
		}
		if (execution?.phase === "terminal") {
			if (
				execution.terminal?.outcome === "failed" &&
				task.status !== "failed"
			) {
				const evidence = execution.terminal.evidence;
				await failTask(
					journal,
					execution,
					evidence.kind === "workflow"
						? evidence.message
						: "Subagent execution failed.",
				);
			}
			return { state: "terminal", executionId: execution.execution.id };
		}
		if (task.status !== "ready") {
			throw new WorkflowTaskLaunchError(
				"validation",
				"Workflow task is not ready for launch.",
			);
		}
		if (!execution) {
			const record = executionRecord(current, agentTask);
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
		if (execution.phase === "launch-intended") {
			await append(journal, {
				type: "task-execution-launch-uncertain",
				data: {
					executionId: execution.execution.id,
					operationId: agentOperationId(execution),
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

		let request: SubagentRequest;
		try {
			request = await lowerRequest(
				agentTask,
				agentOperationId(execution),
				current,
				await artifactsFor(agentTask),
				options.agentRoots ?? [],
				options.ceiling,
			);
		} catch (error) {
			const message =
				"Workflow task input projection failed before subagent preflight.";
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
		let preflightId = execution.preflight?.preflightId;
		let planIdentitySha256 = execution.preflight?.planIdentitySha256;
		let freshPreflight: SubagentPreflight | undefined;
		const preflightIsReusable =
			execution.preflight !== undefined &&
			execution.preflight.fencingGeneration === journal.fencingGeneration &&
			Date.parse(execution.preflight.expiresAt) > Date.now();
		if (!preflightIsReusable) {
			let resolved: SubagentPreflight;
			try {
				resolved = await binding.client.preflight(request);
			} catch (error) {
				// pi-subagent's refusal is the only account of why the plan was
				// refused (an over-ceiling `memoryBytes` reads "memory request
				// exceeds agent ceiling"), and the workflow cannot restate it:
				// agent frontmatter is not readable from here. Relay it verbatim
				// after the fixed prefix so an operator sees the cause.
				const message = preflightFailureMessage(error);
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
			// pi-subagent accepted the request, so a mismatch here is the
			// workflow's own finding about the plan it was handed back. The failed
			// condition travels in the message rather than in a `cause` nobody
			// reads: the journal and the task's failure reason are all a person
			// gets, and the launch never happened.
			const mismatch = preflightMismatch(resolved, request, binding.ownerId);
			if (mismatch !== undefined) {
				const message = preflightMismatchMessage(mismatch);
				await terminalizeWorkflowFailure(
					journal,
					execution,
					"preflight",
					message,
				);
				throw new WorkflowTaskLaunchError("preflight", message);
			}
			freshPreflight = resolved;
			await append(journal, {
				type: "task-execution-preflighted",
				data: {
					executionId: execution.execution.id,
					operationId: agentOperationId(execution),
					preflightId: freshPreflight.preflightId,
					planIdentitySha256: freshPreflight.identitySha256,
					plannedSubagentRunId: freshPreflight.launchPlan.runId,
					plannedSubagentAttemptId: freshPreflight.launchPlan.attemptId,
					expiresAt: freshPreflight.expiresAt,
					workspaceMode: freshPreflight.launchPlan.workspace.mode,
					workspaceBaselineSha256:
						freshPreflight.launchPlan.workspace.baselineSha256,
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
				operationId: agentOperationId(execution),
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
					operationId: agentOperationId(execution),
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
