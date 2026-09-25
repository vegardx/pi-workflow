import { type Static, type TSchema, Type } from "typebox";
import {
	MAX_CHECKPOINT_RENDER_BYTES,
	MAX_CHECKPOINT_SCHEMA_SUMMARY_LENGTH,
} from "./checkpoint-render.js";
import {
	CheckpointDecisionSourceSchema,
	CheckpointHeadlessPolicySchema,
	JsonSchemaDocumentSchema,
	MAX_TASK_KEY_LENGTH,
	MAX_TASK_NAMESPACE_DEPTH,
	NestedWorkflowInputArtifactsSchema,
	SubagentOperationIdSchema,
	SubagentRunStatusSchema,
	TaskDispositionSchema,
	TaskExecutionIdSchema,
	TaskExecutionOutcomeSchema,
	TaskKeySchema,
	TaskRoleSchema,
	WorkflowArtifactIdSchema,
	WorkflowArtifactOutputSchema,
	WorkflowBudgetSchema,
	WorkflowDefinitionNameSchema,
	WorkflowHandoffDescriptorSchema,
	WorkflowRunIdSchema,
	WorkflowRunStatusSchema,
	WorkflowTaskIdSchema,
	WorkflowTaskStatusSchema,
} from "./contracts.js";
import {
	DynamicSourceApproverSchema,
	DynamicSourceDecisionSchema,
	DynamicTransformerIdentitySchema,
	DynamicWorkflowManifestSchema,
	DynamicWorkflowProposerSchema,
} from "./dynamic/contracts.js";
import { TaskExecutionProjectionSchema } from "./events.js";
import { MAX_NARRATION_SUMMARY_LENGTH } from "./narration.js";

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
	Type.Literal("checkpoint"),
]);
const ApproverSchema = Type.String({ minLength: 1, maxLength: 256 });
const DynamicRefSchema = Type.String({ pattern: "^dynamic:[a-f0-9]{64}$" });

export const MAX_WORKFLOW_RUN_PAGE_SIZE = 100;
export const MAX_WORKFLOW_RUN_LIST_ISSUES = 16;
export const MAX_WORKFLOW_INSPECTION_ITEMS = 256;
export const MAX_WORKFLOW_LOG_PAGE_SIZE = 500;
export const MAX_WORKFLOW_WAIT_TIMEOUT_MS = 2_147_483_647;
/**
 * Checkpoint prompts shown by the lease-free inspection are cut to this many
 * characters and marked `promptTruncated`; artifact-backed views (status,
 * wait, decide) carry the whole contract-bounded prompt.
 */
export const MAX_WORKFLOW_INSPECTION_PROMPT_LENGTH = 256;
/** Bound of the fixed `instruction` a pending checkpoint view carries. */
const MAX_CHECKPOINT_INSTRUCTION_LENGTH = 512;
/**
 * `${namespace.join("/")}/${key}` at the contract bounds: every namespace
 * entry is followed by "/" and the key closes the path (4256).
 */
export const MAX_WORKFLOW_TASK_KEY_LENGTH =
	MAX_TASK_NAMESPACE_DEPTH * (MAX_TASK_KEY_LENGTH + 1) + MAX_TASK_KEY_LENGTH;
/** Longest task status name (`cleanup-blocked`). */
const MAX_TASK_STATUS_LENGTH = Math.max(
	...WorkflowTaskStatusSchema.anyOf.map((status) => status.const.length),
);
/**
 * The longest log message is `Task ${taskKey} changed from ${from} to ${to}.`:
 * its fixed text, a maximal task key, and two task status names (4310).
 * Every other message embeds only fixed words, ordinals, and journaled
 * strings already bounded to 4096 characters.
 */
export const MAX_WORKFLOW_LOG_MESSAGE_LENGTH =
	"Task  changed from  to .".length +
	MAX_WORKFLOW_TASK_KEY_LENGTH +
	2 * MAX_TASK_STATUS_LENGTH;

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
		/** On-path checkpoints awaiting a decision; `decide` is offered while it is positive. */
		pendingCheckpointCount: CountSchema,
		outputArtifactId: Type.Optional(WorkflowArtifactIdSchema),
		/**
		 * The run's committed output value, read and digest-verified from the
		 * output artifact. Present only on an inspection whose `include`
		 * carries `"output"`, and only once the run is terminal and has
		 * committed one; `listRuns` never carries it. Bounded by the artifact
		 * bound `MAX_WORKFLOW_ARTIFACT_BYTES` (16 MiB), which the store
		 * enforces on the write and re-checks on the read.
		 */
		output: Type.Optional(Type.Unknown()),
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
	/** Reading the run failed for a reason other than the kinds above (e.g. permissions); `"Workflow run could not be read."` */
	Type.Literal("unreadable"),
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

export const WorkflowCheckpointDecisionViewSchema = Type.Object(
	{
		source: CheckpointDecisionSourceSchema,
		decidedBy: Type.Optional(ApproverSchema),
		decidedAt: TimestampSchema,
		reason: Type.Optional(FixedStringSchema),
		/** Canonical digest of the decision value (the result artifact's `sha256`). */
		sha256: Sha256Schema,
		/**
		 * The verified decision value. Artifact-backed views (status, wait,
		 * decide) read it from the decision result artifact; the lease-free
		 * inspection reads it from the durable decision record and shows it
		 * only when the record's `valueSha256` equals the journalled
		 * `sha256`, so the journal stays authoritative either way.
		 */
		value: Type.Optional(Type.Unknown()),
	},
	{ additionalProperties: false },
);
export type WorkflowCheckpointDecisionView = View<
	typeof WorkflowCheckpointDecisionViewSchema
>;

/**
 * A checkpoint task's request and, once the execution has them, its durable
 * request and decision facts. Everything here is derived from the persisted
 * task spec and the execution projection; the decision store is never read.
 */
export const WorkflowCheckpointTaskViewSchema = Type.Object(
	{
		prompt: FixedStringSchema,
		/** The prompt was cut to `MAX_WORKFLOW_INSPECTION_PROMPT_LENGTH` characters. */
		promptTruncated: Type.Optional(Type.Literal(true)),
		schema: JsonSchemaDocumentSchema,
		headless: CheckpointHeadlessPolicySchema,
		default: Type.Optional(Type.Unknown()),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000 })),
		/** Present once the request is durable. */
		requestedAt: Type.Optional(TimestampSchema),
		expiresAt: Type.Optional(TimestampSchema),
		/** Verified input values shown to the approver; artifact-backed views only. */
		inputs: Type.Optional(
			Type.Record(TaskKeySchema, Type.Unknown(), {
				additionalProperties: false,
				maxProperties: 64,
			}),
		),
		decision: Type.Optional(WorkflowCheckpointDecisionViewSchema),
	},
	{ additionalProperties: false },
);
export type WorkflowCheckpointTaskView = View<
	typeof WorkflowCheckpointTaskViewSchema
>;

/**
 * The task kinds a HOST narrates in, derived from the stage key (`narration.ts`)
 * and never authored or persisted. It is not the runtime's execution kind: that
 * says `agent` where a reader needs `implement` or `review`.
 */
export const WorkflowNarratedTaskKindSchema = Type.Union([
	Type.Literal("implement"),
	Type.Literal("check"),
	Type.Literal("review"),
	Type.Literal("synthesis"),
	Type.Literal("fix"),
	Type.Literal("gate"),
	Type.Literal("refine"),
	/** The honest answer for a key this convention does not name. */
	Type.Literal("other"),
]);
export type WorkflowNarratedTaskKind = Static<
	typeof WorkflowNarratedTaskKindSchema
>;

/**
 * What a host needs to narrate ONE task: the stage key as one string, the kind
 * it narrates as, the deliverable the key names, a bounded human summary, and
 * for a task that did not complete a sanitized cause.
 *
 * Everything here is DERIVED, so it is additive and costs a run nothing.
 * `summary` is artifact-backed and therefore present only on a view that reads
 * artifacts: the inspection with `include` carrying `"output"`, and the
 * artifact-backed status, wait and decide views. `cause` is journal-derived and
 * present on every view whenever the task did not complete.
 */
export const WorkflowTaskNarrationSchema = Type.Object(
	{
		/** `${namespace.join("/")}/${key}`. */
		stage: Type.String({
			minLength: 1,
			maxLength: MAX_WORKFLOW_TASK_KEY_LENGTH,
		}),
		taskKind: WorkflowNarratedTaskKindSchema,
		deliverable: Type.Optional(TaskKeySchema),
		summary: Type.Optional(
			Type.String({ minLength: 1, maxLength: MAX_NARRATION_SUMMARY_LENGTH }),
		),
		cause: Type.Optional(FixedStringSchema),
	},
	{ additionalProperties: false },
);
export type WorkflowTaskNarration = View<typeof WorkflowTaskNarrationSchema>;

export const WorkflowServiceTaskViewSchema = Type.Object(
	{
		id: WorkflowTaskIdSchema,
		namespace: Type.Array(TaskKeySchema, {
			maxItems: MAX_TASK_NAMESPACE_DEPTH,
		}),
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
		/**
		 * The imported handoff of a completed worktree agent task, derived from
		 * durable state alone; absent for read-only tasks and for a completed
		 * worktree task that recorded no handoff under the optional policy.
		 */
		handoff: Type.Optional(WorkflowHandoffDescriptorSchema),
		/** Present for every checkpoint task. */
		checkpoint: Type.Optional(WorkflowCheckpointTaskViewSchema),
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
		/**
		 * What a host needs to narrate this task; present on every projected
		 * task. `narration.summary` needs an artifact read, so it appears on the
		 * artifact-backed views and on an inspection whose `include` carries
		 * `"output"`.
		 */
		narration: Type.Optional(WorkflowTaskNarrationSchema),
	},
	{ additionalProperties: false },
);
export type WorkflowServiceTaskView = View<
	typeof WorkflowServiceTaskViewSchema
>;

/**
 * A checkpoint awaiting a decision. The identity fields are always present;
 * the six optional fields below carry everything an approver needs to answer
 * without a second call, and are additive under the 1.0 API freeze.
 */
export const WorkflowPendingCheckpointViewSchema = Type.Object(
	{
		taskId: WorkflowTaskIdSchema,
		namespace: Type.Array(TaskKeySchema, {
			maxItems: MAX_TASK_NAMESPACE_DEPTH,
		}),
		key: TaskKeySchema,
		executionId: TaskExecutionIdSchema,
		requestedAt: TimestampSchema,
		expiresAt: Type.Optional(TimestampSchema),
		/** `${namespace}/${key}`: the token `/workflow decide` accepts. */
		taskKey: Type.Optional(
			Type.String({ minLength: 1, maxLength: MAX_WORKFLOW_TASK_KEY_LENGTH }),
		),
		/** The checkpoint prompt, cut on the lease-free views. */
		prompt: Type.Optional(FixedStringSchema),
		/** The prompt was cut to `MAX_WORKFLOW_INSPECTION_PROMPT_LENGTH` characters. */
		promptTruncated: Type.Optional(Type.Literal(true)),
		/** One-line answer shape derived from the decision schema. */
		schemaSummary: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: MAX_CHECKPOINT_SCHEMA_SUMMARY_LENGTH,
			}),
		),
		/** The declared inputs as rendered text; artifact-backed views only. */
		inputsSummary: Type.Optional(
			Type.String({ minLength: 1, maxLength: MAX_CHECKPOINT_RENDER_BYTES }),
		),
		/** `CHECKPOINT_DECIDE_INSTRUCTION`: a person answers, a model does not. */
		instruction: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: MAX_CHECKPOINT_INSTRUCTION_LENGTH,
			}),
		),
	},
	{ additionalProperties: false },
);
export type WorkflowPendingCheckpointView = View<
	typeof WorkflowPendingCheckpointViewSchema
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
	/**
	 * On-path checkpoints awaiting a decision, in materialization order;
	 * present whenever `tasks` is, empty unless a checkpoint waits.
	 */
	pendingCheckpoints: Type.Optional(
		Type.Array(WorkflowPendingCheckpointViewSchema, {
			maxItems: MAX_WORKFLOW_INSPECTION_ITEMS,
		}),
	),
	/** Present iff the run executes an approved dynamic proposal (`definitionKind: "dynamic"`). */
	dynamic: Type.Optional(
		Type.Object(
			{
				ref: DynamicRefSchema,
				sourceSha256: Sha256Schema,
				/** Digest of the copied approval record the run was created under. */
				approvalSha256: Sha256Schema,
				hostApiSha256: Sha256Schema,
			},
			{ additionalProperties: false },
		),
	),
};

export const WorkflowServiceRunViewSchema = Type.Object(RunViewProperties, {
	additionalProperties: false,
});
export type WorkflowServiceRunView = View<typeof WorkflowServiceRunViewSchema>;

export const WorkflowServiceWaitViewSchema = Type.Object(
	{
		...RunViewProperties,
		timedOut: Type.Optional(Type.Literal(true)),
		/** The drive settled at a checkpoint; `decide` restarts it. */
		parked: Type.Optional(Type.Literal(true)),
	},
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

export const WorkflowDecideOptionsSchema = Type.Object(
	{
		/** The decision value; validated against the checkpoint's schema by the executor. */
		decision: Type.Unknown(),
		approver: ApproverSchema,
		reason: Type.Optional(FixedStringSchema),
	},
	{ additionalProperties: false },
);
export type WorkflowDecideOptions = View<typeof WorkflowDecideOptionsSchema>;

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
	/** The completed run's output value, on `run.output`. */
	Type.Literal("output"),
]);
export type WorkflowInspectSection = Static<
	typeof WorkflowInspectSectionSchema
>;

export const WorkflowInspectOptionsSchema = Type.Object(
	{
		include: Type.Optional(
			Type.Array(WorkflowInspectSectionSchema, {
				minItems: 1,
				maxItems: 8,
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

export const WorkflowResumeOptionsSchema = Type.Object(
	{ taskId: Type.Optional(WorkflowTaskIdSchema) },
	{ additionalProperties: false },
);
export type WorkflowResumeOptions = View<typeof WorkflowResumeOptionsSchema>;

/** The `--older-than` ceiling a prune may be bounded by: 365 days. */
export const MAX_WORKFLOW_PRUNE_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Store-level prune options. `dryRun` defaults to true: the safe answer to an
 * unqualified call is a listing, never a move.
 */
export const WorkflowPruneOptionsSchema = Type.Object(
	{
		dryRun: Type.Optional(Type.Boolean()),
		olderThanMs: Type.Optional(
			Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_PRUNE_AGE_MS }),
		),
	},
	{ additionalProperties: false },
);
export type WorkflowPruneOptions = View<typeof WorkflowPruneOptionsSchema>;

export const WorkflowExecutionAttemptViewSchema = Type.Object(
	{
		kind: Type.Union([Type.Literal("retry"), Type.Literal("resume")]),
		ordinal: Type.Integer({ minimum: 2 }),
		/** Who intended the attempt: the authored policy or an operator. */
		origin: Type.Optional(
			Type.Union([Type.Literal("policy"), Type.Literal("operator")]),
		),
		/** Operator-authored reason journaled with an operator intent. */
		reason: Type.Optional(FixedStringSchema),
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
		output: Type.Optional(WorkflowArtifactOutputSchema),
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
	Type.Literal("checkpoint"),
]);
export type WorkflowLogKind = Static<typeof WorkflowLogKindSchema>;

export const WorkflowLogEntrySchema = Type.Object(
	{
		sequence: SequenceSchema,
		timestamp: TimestampSchema,
		kind: WorkflowLogKindSchema,
		taskId: Type.Optional(WorkflowTaskIdSchema),
		/** `${namespace.join("/")}/${key}` when `taskId` is present and known. */
		taskKey: Type.Optional(
			Type.String({ minLength: 1, maxLength: MAX_WORKFLOW_TASK_KEY_LENGTH }),
		),
		message: Type.String({
			minLength: 1,
			maxLength: MAX_WORKFLOW_LOG_MESSAGE_LENGTH,
		}),
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

/**
 * The task a single append settled, on the observation that carries it.
 *
 * A host narrating a run posts one message per task completion, so it needs to
 * know WHICH task settled and how — without a second call, and without
 * re-reading the journal on every append. `status` is the task status the append
 * produced and `outcome` its execution's, so a completion and a failure are
 * distinguishable; `narration` is the derived stage key, kind, deliverable and,
 * for a failure, the sanitized cause.
 *
 * `narration.summary` is NOT here, and cannot be: a summary is the task's
 * committed result, which lives in an artifact, and an observation is a
 * synchronous notice on a durable append that reads no file and must stay in
 * sequence order. A host that wants the summary reads
 * `inspect(runId, {include: ["run", "tasks", "output"]})` once it has been told
 * which task to look at.
 */
export const WorkflowObservedTaskSchema = Type.Object(
	{
		taskId: WorkflowTaskIdSchema,
		status: WorkflowTaskStatusSchema,
		/** The current execution's outcome, when it had one. */
		outcome: Type.Optional(TaskExecutionOutcomeSchema),
		narration: WorkflowTaskNarrationSchema,
	},
	{ additionalProperties: false },
);
export type WorkflowObservedTask = View<typeof WorkflowObservedTaskSchema>;

export const WorkflowRunObservationSchema = Type.Object(
	{
		runId: WorkflowRunIdSchema,
		status: WorkflowRunStatusSchema,
		sequence: SequenceSchema,
		/**
		 * Present on the append that moved a task to a terminal status, and only
		 * then: an observation is one notice per append, so a host narrating
		 * completions filters on this field rather than on the event type it
		 * cannot see.
		 */
		task: Type.Optional(WorkflowObservedTaskSchema),
	},
	{ additionalProperties: false },
);
export type WorkflowRunObservation = View<typeof WorkflowRunObservationSchema>;

export const WorkflowInvalidationPreviewSchema = Type.Object(
	{
		runId: WorkflowRunIdSchema,
		causeTaskId: WorkflowTaskIdSchema,
		/** The closure in reducer order: the cause and its live transitive dependents. */
		taskIds: Type.Array(WorkflowTaskIdSchema, {
			maxItems: MAX_WORKFLOW_INSPECTION_ITEMS,
			uniqueItems: true,
		}),
		/** `${namespace.join("/")}/${key}` per closure task, same order. */
		taskKeys: Type.Array(
			Type.String({ minLength: 1, maxLength: MAX_WORKFLOW_TASK_KEY_LENGTH }),
			{ maxItems: MAX_WORKFLOW_INSPECTION_ITEMS },
		),
		/** Ascending on-path epochs after the exposing barrier. */
		abandonedEpochs: Type.Array(Type.Integer({ minimum: 1 }), {
			maxItems: 4096,
			uniqueItems: true,
		}),
		/** On-path tasks declared in an abandoned epoch, in materialization order. */
		abandonedTaskIds: Type.Array(WorkflowTaskIdSchema, {
			maxItems: MAX_WORKFLOW_INSPECTION_ITEMS,
			uniqueItems: true,
		}),
	},
	{ additionalProperties: false },
);
export type WorkflowInvalidationPreview = View<
	typeof WorkflowInvalidationPreviewSchema
>;
/**
 * Mirrors the service's `DynamicWorkflowProposalView` (dynamic-workflow spec
 * 3.5): what `workflow_propose` returns. The source text is never part of it.
 */
export const DynamicWorkflowProposalViewSchema = Type.Object(
	{
		ref: DynamicRefSchema,
		sourceSha256: Sha256Schema,
		sourceBytes: Type.Integer({ minimum: 1 }),
		manifest: DynamicWorkflowManifestSchema,
		manifestSha256: Sha256Schema,
		hostApiSha256: Sha256Schema,
		importPolicySha256: Sha256Schema,
		definitionIdentitySha256: Sha256Schema,
		transformer: DynamicTransformerIdentitySchema,
		proposer: DynamicWorkflowProposerSchema,
		proposedAt: TimestampSchema,
		decision: Type.Optional(
			Type.Object(
				{
					decision: DynamicSourceDecisionSchema,
					approver: DynamicSourceApproverSchema,
					approvedAt: TimestampSchema,
					approvalSha256: Sha256Schema,
					reason: Type.Optional(FixedStringSchema),
				},
				{ additionalProperties: false },
			),
		),
		/** true iff decision is "approved" and both digests equal the current ones. */
		runnable: Type.Boolean(),
		/** `<storeRoot>/dynamic/<sha>/source.workflow.ts` */
		path: Type.String({ minLength: 1, maxLength: 4096 }),
	},
	{ additionalProperties: false },
);

/**
 * W1-PROVIDER (spec 2.4): the lease-free budget projection of a definition
 * against one input. It is a compile-time answer - "would this graph fit?" -
 * and never touches a run, a lease, or the journal.
 *
 * `cost`, `totalTokens` and `childRuntimeMs` are the sum of the declared
 * reservations of every task the definition declares for this input, in the
 * same units and by the same rule the scheduler reserves with
 * (`src/budget.ts`): an agent task reserves its `limits`, a nested workflow
 * task reserves the child definition's `meta.budget`, and a checkpoint or
 * support task reserves nothing. `budget` is the run's effective budget (the
 * definition's `meta.budget` clamped by the service's own maxima) and `fits`
 * is true when the whole projection stays inside it.
 */
export const WorkflowBudgetProjectionSchema = Type.Object(
	{
		cost: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		totalTokens: CountSchema,
		childRuntimeMs: CountSchema,
		/** Declared tasks, finalizers included. */
		tasks: CountSchema,
		budget: WorkflowBudgetSchema,
		fits: Type.Boolean(),
	},
	{ additionalProperties: false },
);
export type WorkflowBudgetProjection = View<
	typeof WorkflowBudgetProjectionSchema
>;
