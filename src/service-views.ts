import { type Static, type TSchema, Type } from "typebox";
import {
	NestedWorkflowInputArtifactsSchema,
	SubagentOperationIdSchema,
	SubagentRunStatusSchema,
	TaskDispositionSchema,
	TaskExecutionIdSchema,
	TaskExecutionOutcomeSchema,
	TaskKeySchema,
	TaskRoleSchema,
	WorkflowArtifactIdSchema,
	WorkflowBudgetSchema,
	WorkflowDefinitionNameSchema,
	WorkflowRunIdSchema,
	WorkflowRunStatusSchema,
	WorkflowTaskIdSchema,
	WorkflowTaskStatusSchema,
} from "./contracts.js";
import { TaskExecutionProjectionSchema } from "./events.js";

/**
 * Every view that crosses the tool boundary is defined once, as a TypeBox
 * schema; the TypeScript types are derived from the schemas so a projection
 * cannot drift from what the tool layer validates.
 */
type DeepReadonly<T> = T extends readonly (infer U)[]
	? readonly DeepReadonly<U>[]
	: T extends object
		? { readonly [K in keyof T]: DeepReadonly<T[K]> }
		: T;
type View<T extends TSchema> = DeepReadonly<Static<T>>;

const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const SequenceSchema = Type.Integer({ minimum: 1 });
const CountSchema = Type.Integer({ minimum: 0 });
const TimestampSchema = Type.String({ format: "date-time" });
const FixedStringSchema = Type.String({ minLength: 1, maxLength: 4096 });
const TaskKindSchema = Type.Union([
	Type.Literal("agent"),
	Type.Literal("support"),
	Type.Literal("workflow"),
]);

export const MAX_WORKFLOW_RUN_PAGE_SIZE = 100;
export const MAX_WORKFLOW_RUN_LIST_ISSUES = 16;
export const MAX_WORKFLOW_INSPECTION_ITEMS = 256;
export const MAX_WORKFLOW_LOG_PAGE_SIZE = 500;
export const MAX_WORKFLOW_WAIT_TIMEOUT_MS = 2_147_483_647;

export const WorkflowRunActionSchema = Type.Union([
	Type.Literal("stop"),
	Type.Literal("wait"),
	Type.Literal("reconcile"),
	Type.Literal("invalidate"),
	Type.Literal("retry"),
	Type.Literal("resume"),
	Type.Literal("decide"),
]);

export const WorkflowRunOwnershipSchema = Type.Union([
	Type.Literal("owned"),
	Type.Literal("leased-elsewhere"),
	Type.Literal("inactive"),
]);

export const WorkflowTaskCountsSchema = Type.Object(
	{
		pending: CountSchema,
		ready: CountSchema,
		running: CountSchema,
		waiting: CountSchema,
		completed: CountSchema,
		failed: CountSchema,
		interrupted: CountSchema,
		blocked: CountSchema,
		cancelling: CountSchema,
		cancelled: CountSchema,
		"cleanup-blocked": CountSchema,
		invalidated: CountSchema,
		abandoned: CountSchema,
		total: CountSchema,
	},
	{ additionalProperties: false },
);
export type WorkflowTaskCounts = View<typeof WorkflowTaskCountsSchema>;

const RunParentSchema = Type.Object(
	{
		runId: WorkflowRunIdSchema,
		taskId: WorkflowTaskIdSchema,
		inputArtifacts: NestedWorkflowInputArtifactsSchema,
	},
	{ additionalProperties: false },
);

export const WorkflowRunSummarySchema = Type.Object(
	{
		runId: WorkflowRunIdSchema,
		definitionName: WorkflowDefinitionNameSchema,
		status: WorkflowRunStatusSchema,
		createdAt: TimestampSchema,
		/** Timestamp of the last complete journal event; `createdAt` when the journal is empty. */
		updatedAt: TimestampSchema,
		deadlineAt: TimestampSchema,
		depth: CountSchema,
		parent: Type.Optional(RunParentSchema),
		lastSequence: CountSchema,
		taskCounts: WorkflowTaskCountsSchema,
		ownership: WorkflowRunOwnershipSchema,
		leasedElsewhere: Type.Boolean(),
		availableActions: Type.Array(WorkflowRunActionSchema, {
			maxItems: 7,
			uniqueItems: true,
		}),
		requiresAttention: Type.Boolean(),
		outputArtifactId: Type.Optional(WorkflowArtifactIdSchema),
	},
	{ additionalProperties: false },
);
export type WorkflowRunSummary = View<typeof WorkflowRunSummarySchema>;

export const WorkflowRunListIssueKindSchema = Type.Union([
	Type.Literal("invalid-directory"),
	Type.Literal("missing-record"),
	Type.Literal("invalid-record"),
	Type.Literal("corrupt-journal"),
	Type.Literal("invalid-projection"),
	Type.Literal("torn-tail"),
]);

export const WorkflowRunListIssueSchema = Type.Object(
	{
		runId: Type.Optional(WorkflowRunIdSchema),
		/** Basename only, never a full path. */
		directory: Type.String({ minLength: 1, maxLength: 255 }),
		kind: WorkflowRunListIssueKindSchema,
		message: FixedStringSchema,
	},
	{ additionalProperties: false },
);
export type WorkflowRunListIssue = View<typeof WorkflowRunListIssueSchema>;

export const WorkflowRunPageSchema = Type.Object(
	{
		runs: Type.Array(WorkflowRunSummarySchema, {
			maxItems: MAX_WORKFLOW_RUN_PAGE_SIZE,
		}),
		nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
		/** Matching runs after filters, before pagination. */
		total: CountSchema,
		issues: Type.Array(WorkflowRunListIssueSchema, {
			maxItems: MAX_WORKFLOW_RUN_LIST_ISSUES,
		}),
		issuesTruncated: CountSchema,
		generatedAt: TimestampSchema,
	},
	{ additionalProperties: false },
);
export type WorkflowRunPage = View<typeof WorkflowRunPageSchema>;

export const WorkflowRunQuerySchema = Type.Object(
	{
		statuses: Type.Optional(
			Type.Array(WorkflowRunStatusSchema, {
				minItems: 1,
				maxItems: 11,
				uniqueItems: true,
			}),
		),
		includeChildren: Type.Optional(Type.Boolean()),
		limit: Type.Optional(
			Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_RUN_PAGE_SIZE }),
		),
		cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
	},
	{ additionalProperties: false },
);
export type WorkflowRunQuery = View<typeof WorkflowRunQuerySchema>;

export const WorkflowSettlementViewSchema = Type.Object(
	{
		/** 1 for nested executions. */
		attemptOrdinal: Type.Integer({ minimum: 1 }),
		/** Subagent run status (agent) or terminal run status (nested). */
		status: Type.String({ minLength: 1, maxLength: 64 }),
		failureCode: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		failureRetry: Type.Optional(
			Type.Union([
				Type.Literal("never"),
				Type.Literal("manual"),
				Type.Literal("backoff"),
				Type.Literal("resume"),
				Type.Literal("reconcile"),
			]),
		),
		usageComplete: Type.Boolean(),
	},
	{ additionalProperties: false },
);
export type WorkflowSettlementView = View<typeof WorkflowSettlementViewSchema>;

export const WorkflowServiceTaskViewSchema = Type.Object(
	{
		id: WorkflowTaskIdSchema,
		namespace: Type.Array(TaskKeySchema, { maxItems: 32 }),
		key: TaskKeySchema,
		kind: TaskKindSchema,
		role: TaskRoleSchema,
		disposition: TaskDispositionSchema,
		status: WorkflowTaskStatusSchema,
		/** Highest generation recorded for the task; 0 when it has none. */
		generation: CountSchema,
		/** The task's current execution. */
		executionId: Type.Optional(TaskExecutionIdSchema),
		/** Current execution's attempt count; agent executions only. */
		attempts: Type.Optional(CountSchema),
		settlement: Type.Optional(WorkflowSettlementViewSchema),
		outcome: Type.Optional(TaskExecutionOutcomeSchema),
		/** Declared in an abandoned epoch and not readopted by the current path. */
		abandoned: Type.Optional(Type.Literal(true)),
		/** Sorted `after` dependency ids; inspection only. */
		dependsOn: Type.Optional(
			Type.Array(WorkflowTaskIdSchema, { maxItems: 256, uniqueItems: true }),
		),
		/** Input name to producer task id; inspection only. */
		inputs: Type.Optional(
			Type.Record(TaskKeySchema, WorkflowTaskIdSchema, {
				additionalProperties: false,
				maxProperties: 64,
			}),
		),
	},
	{ additionalProperties: false },
);
export type WorkflowServiceTaskView = View<
	typeof WorkflowServiceTaskViewSchema
>;

const RunViewProperties = {
	runId: WorkflowRunIdSchema,
	status: WorkflowRunStatusSchema,
	definitionName: WorkflowDefinitionNameSchema,
	createdAt: TimestampSchema,
	/** Absolute deadline fixed at run creation. */
	deadlineAt: TimestampSchema,
	depth: CountSchema,
	parent: Type.Optional(RunParentSchema),
	output: Type.Optional(Type.Unknown()),
	outputArtifactId: Type.Optional(WorkflowArtifactIdSchema),
	/** Every declared task in materialization order; absent until events exist. */
	tasks: Type.Optional(
		Type.Array(WorkflowServiceTaskViewSchema, {
			maxItems: MAX_WORKFLOW_INSPECTION_ITEMS,
		}),
	),
};

export const WorkflowServiceRunViewSchema = Type.Object(RunViewProperties, {
	additionalProperties: false,
});
export type WorkflowServiceRunView = View<typeof WorkflowServiceRunViewSchema>;

export const WorkflowServiceWaitViewSchema = Type.Object(
	{ ...RunViewProperties, timedOut: Type.Optional(Type.Literal(true)) },
	{ additionalProperties: false },
);
export type WorkflowServiceWaitView = View<
	typeof WorkflowServiceWaitViewSchema
>;

export const WorkflowWaitOptionsSchema = Type.Object(
	{
		timeoutMs: Type.Optional(
			Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_WAIT_TIMEOUT_MS }),
		),
	},
	{ additionalProperties: false },
);
export type WorkflowWaitOptions = View<typeof WorkflowWaitOptionsSchema>;

const ExecutionPhaseSchema = TaskExecutionProjectionSchema.properties.phase;

const ReconcileSideSchema = Type.Object(
	{
		phase: ExecutionPhaseSchema,
		outcome: Type.Optional(TaskExecutionOutcomeSchema),
		childStatus: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
	},
	{ additionalProperties: false },
);

export const WorkflowReconciledExecutionSchema = Type.Object(
	{
		taskId: WorkflowTaskIdSchema,
		executionId: TaskExecutionIdSchema,
		before: ReconcileSideSchema,
		after: ReconcileSideSchema,
		/** pi-subagent reconcile facts for agent tasks; absent for nested reconciliation and finalization. */
		subagent: Type.Optional(
			Type.Object(
				{
					sandboxProcess: Type.Union([
						Type.Literal("absent"),
						Type.Literal("present"),
						Type.Literal("not-started"),
						Type.Literal("unknown"),
					]),
					workspace: Type.Union([
						Type.Literal("not-needed"),
						Type.Literal("retained"),
						Type.Literal("absent"),
						Type.Literal("unknown"),
					]),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);
export type WorkflowReconciledExecution = View<
	typeof WorkflowReconciledExecutionSchema
>;

export const WorkflowServiceReconcileViewSchema = Type.Object(
	{
		...RunViewProperties,
		reconciled: Type.Array(WorkflowReconciledExecutionSchema, {
			maxItems: MAX_WORKFLOW_INSPECTION_ITEMS,
		}),
	},
	{ additionalProperties: false },
);
export type WorkflowServiceReconcileView = View<
	typeof WorkflowServiceReconcileViewSchema
>;

export const WorkflowReconcileOptionsSchema = Type.Object(
	{ taskId: Type.Optional(WorkflowTaskIdSchema) },
	{ additionalProperties: false },
);
export type WorkflowReconcileOptions = View<
	typeof WorkflowReconcileOptionsSchema
>;

export const WorkflowInspectSectionSchema = Type.Union([
	Type.Literal("run"),
	Type.Literal("budget"),
	Type.Literal("tasks"),
	Type.Literal("executions"),
	Type.Literal("effects"),
	Type.Literal("barriers"),
	Type.Literal("artifacts"),
]);
export type WorkflowInspectSection = Static<
	typeof WorkflowInspectSectionSchema
>;

export const WorkflowInspectOptionsSchema = Type.Object(
	{
		include: Type.Optional(
			Type.Array(WorkflowInspectSectionSchema, {
				minItems: 1,
				maxItems: 7,
				uniqueItems: true,
			}),
		),
		taskId: Type.Optional(WorkflowTaskIdSchema),
	},
	{ additionalProperties: false },
);
export type WorkflowInspectOptions = View<typeof WorkflowInspectOptionsSchema>;

const UsageSchema = Type.Object(
	{
		cost: Type.Number({ minimum: 0 }),
		totalTokens: CountSchema,
		childRuntimeMs: CountSchema,
	},
	{ additionalProperties: false },
);

export const WorkflowBudgetViewSchema = Type.Object(
	{
		declared: WorkflowBudgetSchema,
		effective: WorkflowBudgetSchema,
		settled: Type.Object(
			{ ...UsageSchema.properties, usageComplete: Type.Boolean() },
			{ additionalProperties: false },
		),
		reserved: UsageSchema,
		/** Fixed string when settled usage exceeds the effective budget or evidence is incomplete. */
		exceeded: Type.Optional(FixedStringSchema),
	},
	{ additionalProperties: false },
);
export type WorkflowBudgetView = View<typeof WorkflowBudgetViewSchema>;

export const WorkflowExecutionAttemptViewSchema = Type.Object(
	{
		kind: Type.Union([Type.Literal("retry"), Type.Literal("resume")]),
		ordinal: Type.Integer({ minimum: 2 }),
		status: Type.Optional(SubagentRunStatusSchema),
		subagentAttemptId: Type.Optional(Type.String({ minLength: 1 })),
		state: Type.Union([
			Type.Literal("intended"),
			Type.Literal("receipted"),
			Type.Literal("declined"),
		]),
		/** Fixed retrier strings only. */
		declinedReason: Type.Optional(FixedStringSchema),
		intentSequence: SequenceSchema,
	},
	{ additionalProperties: false },
);
export type WorkflowExecutionAttemptView = View<
	typeof WorkflowExecutionAttemptViewSchema
>;

export const WorkflowExecutionViewSchema = Type.Object(
	{
		id: TaskExecutionIdSchema,
		taskId: WorkflowTaskIdSchema,
		generation: Type.Integer({ minimum: 1 }),
		kind: TaskKindSchema,
		phase: ExecutionPhaseSchema,
		/** `task.currentExecutionId === id` */
		current: Type.Boolean(),
		createdSequence: SequenceSchema,
		subagent: Type.Optional(
			Type.Object(
				{
					operationId: SubagentOperationIdSchema,
					runId: Type.Optional(Type.String({ minLength: 1 })),
					attemptId: Type.Optional(Type.String({ minLength: 1 })),
					status: Type.Optional(SubagentRunStatusSchema),
				},
				{ additionalProperties: false },
			),
		),
		childRunId: Type.Optional(WorkflowRunIdSchema),
		support: Type.Optional(
			Type.Object(
				{ implementationIdentitySha256: Sha256Schema },
				{ additionalProperties: false },
			),
		),
		attempts: Type.Array(WorkflowExecutionAttemptViewSchema, { maxItems: 21 }),
		settlement: Type.Optional(WorkflowSettlementViewSchema),
		terminal: Type.Optional(
			Type.Object(
				{
					outcome: TaskExecutionOutcomeSchema,
					failure: Type.Optional(
						Type.Object(
							{
								/** Subagent failure code, or the workflow failure stage. */
								code: Type.String({ minLength: 1, maxLength: 128 }),
								retry: Type.Optional(
									Type.String({ minLength: 1, maxLength: 32 }),
								),
								stage: Type.Optional(
									Type.String({ minLength: 1, maxLength: 64 }),
								),
							},
							{ additionalProperties: false },
						),
					),
					sequence: SequenceSchema,
				},
				{ additionalProperties: false },
			),
		),
		/** Artifacts whose producer execution is this one. */
		artifactIds: Type.Array(WorkflowArtifactIdSchema, {
			maxItems: 4096,
			uniqueItems: true,
		}),
	},
	{ additionalProperties: false },
);
export type WorkflowExecutionView = View<typeof WorkflowExecutionViewSchema>;

export const WorkflowEffectViewSchema = Type.Object(
	{
		ordinal: Type.Integer({ minimum: 1, maximum: 4096 }),
		kind: Type.Union([Type.Literal("phase"), Type.Literal("log")]),
		value: FixedStringSchema,
		sequence: SequenceSchema,
		abandoned: Type.Optional(Type.Literal(true)),
	},
	{ additionalProperties: false },
);
export type WorkflowEffectView = View<typeof WorkflowEffectViewSchema>;

export const WorkflowBarrierViewSchema = Type.Object(
	{
		epoch: Type.Integer({ minimum: 1 }),
		kind: Type.Union([
			Type.Literal("result"),
			Type.Literal("results"),
			Type.Literal("settled"),
			Type.Literal("final"),
		]),
		taskIds: Type.Array(WorkflowTaskIdSchema, {
			maxItems: 256,
			uniqueItems: true,
		}),
		sequence: SequenceSchema,
		abandoned: Type.Optional(Type.Literal(true)),
	},
	{ additionalProperties: false },
);
export type WorkflowBarrierView = View<typeof WorkflowBarrierViewSchema>;

export const WorkflowArtifactViewSchema = Type.Object(
	{
		id: WorkflowArtifactIdSchema,
		producerTaskId: Type.Optional(WorkflowTaskIdSchema),
		producerExecutionId: Type.Optional(TaskExecutionIdSchema),
		output: Type.Optional(Type.Literal("result")),
		sha256: Sha256Schema,
		bytes: CountSchema,
		mediaType: Type.String({ minLength: 1, maxLength: 256 }),
		schemaSha256: Sha256Schema,
		isRunOutput: Type.Boolean(),
	},
	{ additionalProperties: false },
);
export type WorkflowArtifactView = View<typeof WorkflowArtifactViewSchema>;

const bounded = <T extends TSchema>(schema: T) =>
	Type.Array(schema, { maxItems: MAX_WORKFLOW_INSPECTION_ITEMS });

export const WorkflowRunInspectionSchema = Type.Object(
	{
		run: WorkflowRunSummarySchema,
		budget: Type.Optional(WorkflowBudgetViewSchema),
		tasks: Type.Optional(bounded(WorkflowServiceTaskViewSchema)),
		executions: Type.Optional(bounded(WorkflowExecutionViewSchema)),
		effects: Type.Optional(bounded(WorkflowEffectViewSchema)),
		barriers: Type.Optional(bounded(WorkflowBarrierViewSchema)),
		artifacts: Type.Optional(bounded(WorkflowArtifactViewSchema)),
		/** Items omitted from each bounded section. */
		truncated: Type.Object(
			{
				executions: Type.Optional(Type.Integer({ minimum: 1 })),
				effects: Type.Optional(Type.Integer({ minimum: 1 })),
				barriers: Type.Optional(Type.Integer({ minimum: 1 })),
				artifacts: Type.Optional(Type.Integer({ minimum: 1 })),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export type WorkflowRunInspection = View<typeof WorkflowRunInspectionSchema>;

export const WorkflowLogKindSchema = Type.Union([
	Type.Literal("phase"),
	Type.Literal("log"),
	Type.Literal("run"),
	Type.Literal("task"),
	Type.Literal("attempt"),
	Type.Literal("terminal"),
	Type.Literal("invalidation"),
]);
export type WorkflowLogKind = Static<typeof WorkflowLogKindSchema>;

export const WorkflowLogEntrySchema = Type.Object(
	{
		sequence: SequenceSchema,
		timestamp: TimestampSchema,
		kind: WorkflowLogKindSchema,
		taskId: Type.Optional(WorkflowTaskIdSchema),
		/** `${namespace.join("/")}/${key}` when `taskId` is present and known. */
		taskKey: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
		message: Type.String({ minLength: 1, maxLength: 4096 }),
		/** Run status, task status, subagent status, or execution outcome per kind. */
		status: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
		/** Journaled reason: fixed workflow strings or an operator-authored reason. */
		reason: Type.Optional(FixedStringSchema),
		/** Subagent failure code or workflow failure stage. */
		failureCode: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		/** Effects sequenced after an exposing barrier. */
		abandoned: Type.Optional(Type.Literal(true)),
	},
	{ additionalProperties: false },
);
export type WorkflowLogEntry = View<typeof WorkflowLogEntrySchema>;

export const WorkflowLogOptionsSchema = Type.Object(
	{
		afterSequence: Type.Optional(CountSchema),
		limit: Type.Optional(
			Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_LOG_PAGE_SIZE }),
		),
	},
	{ additionalProperties: false },
);
export type WorkflowLogOptions = View<typeof WorkflowLogOptionsSchema>;

export const WorkflowLogPageSchema = Type.Object(
	{
		runId: WorkflowRunIdSchema,
		/** Ascending sequence. */
		entries: Type.Array(WorkflowLogEntrySchema, {
			maxItems: MAX_WORKFLOW_LOG_PAGE_SIZE,
		}),
		/** Present iff more entries exist beyond this page. */
		nextAfterSequence: Type.Optional(SequenceSchema),
		/** The journal's last complete sequence; 0 when empty. */
		lastSequence: CountSchema,
	},
	{ additionalProperties: false },
);
export type WorkflowLogPage = View<typeof WorkflowLogPageSchema>;

export const WorkflowRunObservationSchema = Type.Object(
	{
		runId: WorkflowRunIdSchema,
		status: WorkflowRunStatusSchema,
		sequence: SequenceSchema,
	},
	{ additionalProperties: false },
);
export type WorkflowRunObservation = View<typeof WorkflowRunObservationSchema>;
