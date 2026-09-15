import { currentSubagentAttempt } from "./attempts.js";
import {
	budgetExceededReason,
	reservedWorkflowUsage,
	settledWorkflowUsage,
} from "./budget.js";
import type {
	TaskExecutionOutcome,
	WorkflowArtifactId,
	WorkflowRunId,
	WorkflowTaskId,
	WorkflowTaskStatus,
} from "./contracts.js";
import type {
	TaskExecutionProjection,
	WorkflowEventInput,
	WorkflowStateProjection,
	WorkflowTaskProjection,
} from "./events.js";
import type { WorkflowJournalEvent } from "./persistence/journal.js";
import {
	availableWorkflowRunActions,
	requiresAttention,
	runActionFacts,
	type WorkflowRunOwnership,
} from "./run-actions.js";
import type { WorkflowRunRecord } from "./run-record.js";
import {
	MAX_WORKFLOW_INSPECTION_ITEMS,
	type WorkflowArtifactView,
	type WorkflowBarrierView,
	type WorkflowBudgetView,
	type WorkflowEffectView,
	type WorkflowExecutionAttemptView,
	type WorkflowExecutionView,
	type WorkflowInspectSection,
	type WorkflowLogEntry,
	type WorkflowLogPage,
	type WorkflowRunInspection,
	type WorkflowRunSummary,
	type WorkflowServiceTaskView,
	type WorkflowSettlementView,
	type WorkflowTaskCounts,
} from "./service-views.js";

const TASK_STATUSES: readonly WorkflowTaskStatus[] = Object.freeze([
	"pending",
	"ready",
	"running",
	"waiting",
	"completed",
	"failed",
	"interrupted",
	"blocked",
	"cancelling",
	"cancelled",
	"cleanup-blocked",
	"invalidated",
]);

export const DEFAULT_INSPECT_SECTIONS: readonly WorkflowInspectSection[] =
	Object.freeze(["run", "budget", "tasks"]);

function orderedTasks(
	state: WorkflowStateProjection,
): readonly WorkflowTaskProjection[] {
	return Object.values(state.tasks).sort(
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

function settlementView(
	execution: TaskExecutionProjection,
): WorkflowSettlementView | undefined {
	if (execution.settlement) {
		const evidence = execution.settlement.evidence;
		return Object.freeze({
			attemptOrdinal: evidence.attemptOrdinal,
			status: evidence.status,
			...(evidence.failure ? { failureCode: evidence.failure.code } : {}),
			...(evidence.failure ? { failureRetry: evidence.failure.retry } : {}),
			usageComplete: evidence.usageComplete,
		});
	}
	if (execution.nestedSettlement) {
		return Object.freeze({
			attemptOrdinal: 1,
			status: execution.nestedSettlement.status,
			usageComplete: execution.nestedSettlement.usageComplete,
		});
	}
	return undefined;
}

export interface TaskViewOptions {
	/** Include `dependsOn` and `inputs`; inspection only. */
	readonly graph?: boolean;
}

export function taskViews(
	state: WorkflowStateProjection,
	options: TaskViewOptions = {},
): readonly WorkflowServiceTaskView[] {
	return Object.freeze(
		orderedTasks(state).map((task) => {
			const generation = Object.values(state.executions).reduce(
				(highest, execution) =>
					execution.execution.taskId === task.task.id
						? Math.max(highest, execution.execution.generation)
						: highest,
				0,
			);
			const execution = currentExecution(state, task);
			const settlement = execution ? settlementView(execution) : undefined;
			const outcome: TaskExecutionOutcome | undefined =
				execution?.terminal?.outcome;
			return Object.freeze({
				id: task.task.id,
				namespace: Object.freeze([...task.task.namespace]),
				key: task.task.spec.key,
				kind: task.task.spec.kind,
				role: task.task.spec.role,
				disposition: task.task.spec.disposition,
				status: task.status,
				generation,
				...(execution ? { executionId: execution.execution.id } : {}),
				...(execution?.execution.kind === "agent"
					? { attempts: execution.attempts?.length ?? 0 }
					: {}),
				...(settlement ? { settlement } : {}),
				...(outcome ? { outcome } : {}),
				...(task.abandoned === true ? { abandoned: true as const } : {}),
				...(options.graph
					? {
							dependsOn: Object.freeze(
								task.task.spec.after.map((ref) => ref.taskId).sort(),
							),
							inputs: Object.freeze(
								Object.fromEntries(
									Object.entries(task.task.spec.inputs).map(([name, ref]) => [
										name,
										ref.producerTaskId,
									]),
								),
							),
						}
					: {}),
			});
		}),
	);
}

function taskCounts(
	state: WorkflowStateProjection | undefined,
): WorkflowTaskCounts {
	const counts = Object.fromEntries(
		TASK_STATUSES.map((status) => [status, 0]),
	) as Record<WorkflowTaskStatus, number>;
	let abandoned = 0;
	let total = 0;
	for (const task of Object.values(state?.tasks ?? {})) {
		total += 1;
		if (task.abandoned === true) {
			abandoned += 1;
			continue;
		}
		counts[task.status] += 1;
	}
	return Object.freeze({ ...counts, abandoned, total });
}

function lineageOf(record: WorkflowRunRecord): {
	parent?: NonNullable<WorkflowRunSummary["parent"]>;
} {
	return record.parent
		? {
				parent: Object.freeze({
					runId: record.parent.runId,
					taskId: record.parent.taskId,
					inputArtifacts: Object.freeze(
						structuredClone(record.parent.inputArtifacts),
					),
				}),
			}
		: {};
}

export function runSummary(
	record: WorkflowRunRecord,
	state: WorkflowStateProjection | undefined,
	events: readonly WorkflowJournalEvent[],
	ownership: WorkflowRunOwnership,
	driving: boolean,
	now: number,
): WorkflowRunSummary {
	const facts = runActionFacts({ record, state, ownership, driving, now });
	const last = events.at(-1);
	return Object.freeze({
		runId: record.runId,
		definitionName: record.definitionName,
		status: facts.status,
		createdAt: record.createdAt,
		updatedAt: last?.timestamp ?? record.createdAt,
		deadlineAt: record.deadlineAt,
		depth: record.depth,
		...lineageOf(record),
		lastSequence: last?.sequence ?? 0,
		taskCounts: taskCounts(state),
		ownership,
		leasedElsewhere: ownership === "leased-elsewhere",
		availableActions: availableWorkflowRunActions(facts),
		requiresAttention: requiresAttention(facts),
		...(state?.outputArtifactId
			? { outputArtifactId: state.outputArtifactId }
			: {}),
	});
}

export interface WorkflowRunCursor {
	readonly createdAt: string;
	readonly runId: WorkflowRunId;
}

export function encodeWorkflowRunCursor(cursor: WorkflowRunCursor): string {
	return Buffer.from(
		JSON.stringify({ v: 1, c: cursor.createdAt, r: cursor.runId }),
		"utf8",
	).toString("base64url");
}

/** Returns undefined for any cursor this build did not produce. */
export function decodeWorkflowRunCursor(
	encoded: string,
): WorkflowRunCursor | undefined {
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const { v, c, r } = value as { v?: unknown; c?: unknown; r?: unknown };
	if (
		v !== 1 ||
		typeof c !== "string" ||
		typeof r !== "string" ||
		Object.keys(value).length !== 3 ||
		!Number.isFinite(Date.parse(c))
	) {
		return undefined;
	}
	return Object.freeze({ createdAt: c, runId: r as WorkflowRunId });
}

/** Newest first: `createdAt` descending, then `runId` descending. */
export function compareRunSummaries(
	left: Pick<WorkflowRunSummary, "createdAt" | "runId">,
	right: Pick<WorkflowRunSummary, "createdAt" | "runId">,
): number {
	if (left.createdAt !== right.createdAt) {
		return left.createdAt < right.createdAt ? 1 : -1;
	}
	if (left.runId !== right.runId) return left.runId < right.runId ? 1 : -1;
	return 0;
}

function budgetView(
	record: WorkflowRunRecord,
	state: WorkflowStateProjection | undefined,
): WorkflowBudgetView {
	const effective = record.effectiveBudget;
	const settled = state
		? settledWorkflowUsage(state)
		: { cost: 0, totalTokens: 0, childRuntimeMs: 0, usageComplete: true };
	const reserved = state
		? reservedWorkflowUsage(state, effective)
		: { cost: 0, totalTokens: 0, childRuntimeMs: 0 };
	const exceeded = budgetExceededReason(settled, effective);
	return Object.freeze({
		declared: Object.freeze(structuredClone(record.declaredBudget)),
		effective: Object.freeze(structuredClone(effective)),
		settled: Object.freeze({
			cost: settled.cost,
			totalTokens: settled.totalTokens,
			childRuntimeMs: settled.childRuntimeMs,
			usageComplete: settled.usageComplete,
		}),
		reserved: Object.freeze({
			cost: reserved.cost,
			totalTokens: reserved.totalTokens,
			childRuntimeMs: reserved.childRuntimeMs,
		}),
		...(exceeded === undefined ? {} : { exceeded }),
	});
}

function eventInput(event: WorkflowJournalEvent): WorkflowEventInput {
	// The journal reader validated every record against WorkflowEventInputSchema.
	return { type: event.type, data: event.data } as WorkflowEventInput;
}

function attemptViews(
	execution: TaskExecutionProjection,
	declinedReasons: ReadonlyMap<number, string>,
): readonly WorkflowExecutionAttemptView[] {
	return Object.freeze(
		(execution.attempts ?? []).map((attempt) => {
			const declinedReason =
				attempt.declinedSequence === undefined
					? undefined
					: declinedReasons.get(attempt.declinedSequence);
			return Object.freeze({
				kind: attempt.kind,
				ordinal: attempt.ordinal,
				...(attempt.status === undefined ? {} : { status: attempt.status }),
				...(attempt.subagentAttemptId === undefined
					? {}
					: { subagentAttemptId: attempt.subagentAttemptId }),
				state:
					attempt.declinedSequence !== undefined
						? ("declined" as const)
						: attempt.receiptSequence !== undefined
							? ("receipted" as const)
							: ("intended" as const),
				...(declinedReason === undefined ? {} : { declinedReason }),
				intentSequence: attempt.intentSequence,
			});
		}),
	);
}

function terminalView(
	execution: TaskExecutionProjection,
): WorkflowExecutionView["terminal"] {
	const terminal = execution.terminal;
	if (!terminal) return undefined;
	const evidence = terminal.evidence;
	const failure =
		evidence.kind === "subagent"
			? evidence.failure
				? Object.freeze({
						code: evidence.failure.code,
						retry: evidence.failure.retry,
					})
				: undefined
			: evidence.kind === "workflow"
				? Object.freeze({ code: evidence.stage, stage: evidence.stage })
				: undefined;
	return Object.freeze({
		outcome: terminal.outcome,
		...(failure ? { failure } : {}),
		sequence: terminal.sequence,
	});
}

function executionView(
	state: WorkflowStateProjection,
	execution: TaskExecutionProjection,
	declinedReasons: ReadonlyMap<number, string>,
	artifactIdsByExecution: ReadonlyMap<string, readonly WorkflowArtifactId[]>,
): WorkflowExecutionView {
	const record = execution.execution;
	const task = state.tasks[record.taskId];
	const settlement = settlementView(execution);
	const terminal = terminalView(execution);
	const attempt = currentSubagentAttempt(execution);
	const childStatus =
		execution.settlement?.evidence.status ??
		execution.observation?.status ??
		attempt?.status;
	return Object.freeze({
		id: record.id,
		taskId: record.taskId,
		generation: record.generation,
		kind: record.kind,
		phase: execution.phase,
		current: task?.currentExecutionId === record.id,
		createdSequence: execution.createdSequence,
		...(record.kind === "agent" && execution.launchReceipt
			? {
					subagent: Object.freeze({
						operationId: record.operationId,
						runId: execution.launchReceipt.subagentRunId,
						...(attempt ? { attemptId: attempt.subagentAttemptId } : {}),
						...(childStatus === undefined ? {} : { status: childStatus }),
					}),
				}
			: {}),
		...(record.kind === "workflow" ? { childRunId: record.childRunId } : {}),
		...(record.kind === "support"
			? {
					support: Object.freeze({
						implementationIdentitySha256: record.implementationIdentitySha256,
					}),
				}
			: {}),
		attempts: attemptViews(execution, declinedReasons),
		...(settlement ? { settlement } : {}),
		...(terminal ? { terminal } : {}),
		artifactIds: artifactIdsByExecution.get(record.id) ?? Object.freeze([]),
	});
}

function lastItems<T>(items: readonly T[]): {
	kept: readonly T[];
	omitted: number;
} {
	const omitted = Math.max(0, items.length - MAX_WORKFLOW_INSPECTION_ITEMS);
	return { kept: Object.freeze(items.slice(omitted)), omitted };
}

export interface RunInspectionOptions {
	/** Sections to include; defaults to `DEFAULT_INSPECT_SECTIONS`. `run` is always present. */
	readonly include?: readonly WorkflowInspectSection[];
	/** Restricts tasks, executions, and artifacts to one task. */
	readonly taskId?: WorkflowTaskId;
}

export function runInspection(
	record: WorkflowRunRecord,
	state: WorkflowStateProjection | undefined,
	events: readonly WorkflowJournalEvent[],
	ownership: WorkflowRunOwnership,
	driving: boolean,
	now: number,
	options: RunInspectionOptions = {},
): WorkflowRunInspection {
	const include = new Set(options.include ?? DEFAULT_INSPECT_SECTIONS);
	const taskId = options.taskId;
	const truncated: {
		executions?: number;
		effects?: number;
		barriers?: number;
		artifacts?: number;
	} = {};
	const inspection: {
		run: WorkflowRunSummary;
		budget?: WorkflowBudgetView;
		tasks?: readonly WorkflowServiceTaskView[];
		executions?: readonly WorkflowExecutionView[];
		effects?: readonly WorkflowEffectView[];
		barriers?: readonly WorkflowBarrierView[];
		artifacts?: readonly WorkflowArtifactView[];
		truncated: typeof truncated;
	} = {
		run: runSummary(record, state, events, ownership, driving, now),
		truncated,
	};
	if (include.has("budget")) inspection.budget = budgetView(record, state);
	if (include.has("tasks")) {
		const views = state ? taskViews(state, { graph: true }) : [];
		inspection.tasks = Object.freeze(
			taskId === undefined ? views : views.filter((task) => task.id === taskId),
		);
	}
	if (include.has("executions")) {
		if (!state) {
			inspection.executions = Object.freeze([]);
		} else {
			const declinedReasons = new Map<number, string>();
			for (const event of events) {
				const input = eventInput(event);
				if (input.type === "task-execution-attempt-declined") {
					declinedReasons.set(event.sequence, input.data.reason);
				}
			}
			const artifactIdsByExecution = new Map<string, WorkflowArtifactId[]>();
			for (const artifact of Object.values(state.artifacts)) {
				if (!artifact.producerExecutionId) continue;
				const ids = artifactIdsByExecution.get(artifact.producerExecutionId);
				if (ids) ids.push(artifact.id);
				else
					artifactIdsByExecution.set(artifact.producerExecutionId, [
						artifact.id,
					]);
			}
			for (const ids of artifactIdsByExecution.values()) ids.sort();
			const sequenceOf = new Map(
				Object.values(state.tasks).map((task) => [
					task.task.id,
					task.task.materializationSequence,
				]),
			);
			const executions = Object.values(state.executions)
				.filter(
					(execution) =>
						taskId === undefined || execution.execution.taskId === taskId,
				)
				.sort((left, right) => {
					const bySequence =
						(sequenceOf.get(left.execution.taskId) ?? 0) -
						(sequenceOf.get(right.execution.taskId) ?? 0);
					if (bySequence !== 0) return bySequence;
					return right.execution.generation - left.execution.generation;
				});
			const kept =
				taskId === undefined
					? executions.slice(0, MAX_WORKFLOW_INSPECTION_ITEMS)
					: executions;
			if (kept.length < executions.length) {
				truncated.executions = executions.length - kept.length;
			}
			inspection.executions = Object.freeze(
				kept.map((execution) =>
					executionView(
						state,
						execution,
						declinedReasons,
						artifactIdsByExecution,
					),
				),
			);
		}
	}
	if (include.has("effects")) {
		const { kept, omitted } = lastItems(state?.effects ?? []);
		if (omitted > 0) truncated.effects = omitted;
		inspection.effects = Object.freeze(
			kept.map((effect) =>
				Object.freeze({
					ordinal: effect.ordinal,
					kind: effect.kind,
					value: effect.value,
					sequence: effect.sequence,
					...(effect.abandoned === true ? { abandoned: true as const } : {}),
				}),
			),
		);
	}
	if (include.has("barriers")) {
		const { kept, omitted } = lastItems(state?.barriers ?? []);
		if (omitted > 0) truncated.barriers = omitted;
		inspection.barriers = Object.freeze(
			kept.map((barrier) =>
				Object.freeze({
					epoch: barrier.epoch,
					kind: barrier.kind,
					taskIds: Object.freeze([...barrier.taskIds]),
					sequence: barrier.sequence,
					...(barrier.abandoned === true ? { abandoned: true as const } : {}),
				}),
			),
		);
	}
	if (include.has("artifacts")) {
		// The reducer inserts artifacts in declaration order, so the record's
		// key order is journal order.
		const artifacts = Object.values(state?.artifacts ?? {}).filter(
			(artifact) => taskId === undefined || artifact.producerTaskId === taskId,
		);
		const { kept, omitted } = lastItems(artifacts);
		if (omitted > 0) truncated.artifacts = omitted;
		inspection.artifacts = Object.freeze(
			kept.map((artifact) =>
				Object.freeze({
					id: artifact.id,
					...(artifact.producerTaskId
						? { producerTaskId: artifact.producerTaskId }
						: {}),
					...(artifact.producerExecutionId
						? { producerExecutionId: artifact.producerExecutionId }
						: {}),
					...(artifact.output ? { output: artifact.output } : {}),
					sha256: artifact.sha256,
					bytes: artifact.bytes,
					mediaType: artifact.mediaType,
					schemaSha256: artifact.schemaSha256,
					isRunOutput: state?.outputArtifactId === artifact.id,
				}),
			),
		);
	}
	inspection.truncated = Object.freeze({ ...truncated });
	return Object.freeze(inspection);
}

export interface RunLogOptions {
	readonly afterSequence?: number | undefined;
	readonly limit?: number | undefined;
}

function taskKeyOf(
	state: WorkflowStateProjection | undefined,
	taskId: WorkflowTaskId,
): { taskId: WorkflowTaskId; taskKey?: string } {
	const task = state?.tasks[taskId];
	return task
		? {
				taskId,
				taskKey: `${task.task.namespace.join("/")}/${task.task.spec.key}`,
			}
		: { taskId };
}

function logEntry(
	event: WorkflowJournalEvent,
	state: WorkflowStateProjection | undefined,
): WorkflowLogEntry | undefined {
	const input = eventInput(event);
	const base = { sequence: event.sequence, timestamp: event.timestamp };
	const taskOfExecution = (executionId: string) => {
		const taskId = state?.executions[executionId]?.execution.taskId;
		return taskId === undefined ? {} : taskKeyOf(state, taskId);
	};
	switch (input.type) {
		case "workflow-effect": {
			const abandoned = state?.effects[input.data.ordinal - 1]?.abandoned;
			return Object.freeze({
				...base,
				kind: input.data.kind,
				message: input.data.value,
				...(abandoned === true ? { abandoned: true as const } : {}),
			});
		}
		case "run-status-changed":
			return Object.freeze({
				...base,
				kind: "run" as const,
				status: input.data.to,
				...(input.data.reason === undefined
					? {}
					: { reason: input.data.reason }),
				message: `Run status changed from ${input.data.from} to ${input.data.to}.`,
			});
		case "task-status-changed": {
			const task = taskKeyOf(state, input.data.taskId);
			return Object.freeze({
				...base,
				kind: "task" as const,
				...task,
				status: input.data.to,
				...(input.data.reason === undefined
					? {}
					: { reason: input.data.reason }),
				message: `Task ${task.taskKey ?? task.taskId} changed from ${input.data.from} to ${input.data.to}.`,
			});
		}
		case "task-execution-attempt-intended":
			return Object.freeze({
				...base,
				kind: "attempt" as const,
				...taskOfExecution(input.data.executionId),
				failureCode: input.data.failureCode,
				message: `Attempt ${input.data.ordinal} (${input.data.kind}) intended after ${input.data.failureCode}.`,
			});
		case "task-execution-attempt-receipted":
			return Object.freeze({
				...base,
				kind: "attempt" as const,
				...taskOfExecution(input.data.executionId),
				status: input.data.status,
				message: `Attempt ${input.data.ordinal} receipted (${input.data.status}).`,
			});
		case "task-execution-attempt-declined":
			return Object.freeze({
				...base,
				kind: "attempt" as const,
				...taskOfExecution(input.data.executionId),
				reason: input.data.reason,
				message: `Attempt ${input.data.ordinal} declined.`,
			});
		case "task-execution-terminal": {
			const evidence = input.data.evidence;
			const failureCode =
				evidence.kind === "subagent"
					? evidence.failure?.code
					: evidence.kind === "workflow"
						? evidence.stage
						: undefined;
			const generation =
				state?.executions[input.data.executionId]?.execution.generation;
			return Object.freeze({
				...base,
				kind: "terminal" as const,
				...taskOfExecution(input.data.executionId),
				status: input.data.outcome,
				...(failureCode === undefined ? {} : { failureCode }),
				message: `Execution generation ${generation ?? "?"} ended ${input.data.outcome}.`,
			});
		}
		case "task-invalidated":
			return Object.freeze({
				...base,
				kind: "invalidation" as const,
				...taskKeyOf(state, input.data.causeTaskId),
				reason: input.data.reason,
				message: `Invalidated ${input.data.taskIds.length} task(s) and abandoned ${input.data.abandonedEpochs.length} epoch(s).`,
			});
		default:
			return undefined;
	}
}

/**
 * Redacted lifecycle entries after `afterSequence`, at most `limit`. The run
 * id comes from the state, the first event, or the explicit argument; an
 * empty journal therefore needs `runId`.
 */
export function runLogs(
	events: readonly WorkflowJournalEvent[],
	state: WorkflowStateProjection | undefined,
	options: RunLogOptions = {},
	runId?: WorkflowRunId,
): WorkflowLogPage {
	const pageRunId = runId ?? state?.runId ?? events[0]?.runId;
	if (pageRunId === undefined) {
		throw new Error("workflow log page requires a run id");
	}
	const afterSequence = options.afterSequence ?? 0;
	const limit = options.limit ?? 100;
	const entries: WorkflowLogEntry[] = [];
	let more = false;
	for (const event of events) {
		if (event.sequence <= afterSequence) continue;
		const entry = logEntry(event, state);
		if (!entry) continue;
		if (entries.length === limit) {
			more = true;
			break;
		}
		entries.push(entry);
	}
	const last = entries.at(-1);
	return Object.freeze({
		runId: pageRunId,
		entries: Object.freeze(entries),
		...(more && last ? { nextAfterSequence: last.sequence } : {}),
		lastSequence: events.at(-1)?.sequence ?? 0,
	});
}
