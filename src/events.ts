import { type Static, Type } from "typebox";
import {
	MAX_TASK_ATTEMPTS,
	MAX_WORKFLOW_CONCURRENCY,
	MaterializedWorkflowTaskSchema,
	NestedWorkflowUsageSchema,
	SubagentAttemptIdSchema,
	SubagentOperationIdSchema,
	SubagentRunIdSchema,
	SubagentRunStatusSchema,
	SubagentTerminalEvidenceSchema,
	TaskExecutionIdSchema,
	TaskExecutionOutcomeSchema,
	TaskExecutionRecordSchema,
	TaskExecutionTerminalEvidenceSchema,
	WorkflowArtifactIdSchema,
	WorkflowArtifactRefSchema,
	WorkflowBudgetSchema,
	WorkflowRunIdSchema,
	WorkflowRunStatusSchema,
	WorkflowTaskIdSchema,
	WorkflowTaskStatusSchema,
} from "./contracts.js";

export const MAX_WORKFLOW_EVENT_INPUT_BYTES = 60 * 1024;
export const MAX_WORKFLOW_STATE_BYTES = 900 * 1024;

const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });

const RunCreatedEventSchema = Type.Object(
	{
		type: Type.Literal("run-created"),
		data: Type.Object(
			{
				definitionIdentitySha256: Sha256Schema,
				inputSha256: Sha256Schema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const WorkflowEffectEventSchema = Type.Object(
	{
		type: Type.Literal("workflow-effect"),
		data: Type.Object(
			{
				ordinal: Type.Integer({ minimum: 1, maximum: 4096 }),
				kind: Type.Union([Type.Literal("phase"), Type.Literal("log")]),
				value: Type.String({ minLength: 1, maxLength: 4096 }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskDeclaredEventSchema = Type.Object(
	{
		type: Type.Literal("task-declared"),
		data: Type.Object(
			{ task: MaterializedWorkflowTaskSchema },
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const ArtifactDeclaredEventSchema = Type.Object(
	{
		type: Type.Literal("artifact-declared"),
		data: Type.Object(
			{ artifact: WorkflowArtifactRefSchema },
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const BarrierReachedEventSchema = Type.Object(
	{
		type: Type.Literal("barrier-reached"),
		data: Type.Object(
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
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskExecutionCreatedEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-created"),
		data: Type.Object(
			{ execution: TaskExecutionRecordSchema },
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskExecutionPreflightedEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-preflighted"),
		data: Type.Object(
			{
				executionId: TaskExecutionIdSchema,
				operationId: SubagentOperationIdSchema,
				preflightId: Type.String({ minLength: 1, maxLength: 128 }),
				planIdentitySha256: Sha256Schema,
				plannedSubagentRunId: SubagentRunIdSchema,
				plannedSubagentAttemptId: SubagentAttemptIdSchema,
				expiresAt: Type.String({ format: "date-time" }),
				supersedesPreflightId: Type.Optional(
					Type.String({ minLength: 1, maxLength: 128 }),
				),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskExecutionLaunchIntendedEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-launch-intended"),
		data: Type.Object(
			{
				executionId: TaskExecutionIdSchema,
				operationId: SubagentOperationIdSchema,
				preflightId: Type.String({ minLength: 1, maxLength: 128 }),
				planIdentitySha256: Sha256Schema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskExecutionLaunchUncertainEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-launch-uncertain"),
		data: Type.Object(
			{
				executionId: TaskExecutionIdSchema,
				operationId: SubagentOperationIdSchema,
				reason: Type.String({ minLength: 1, maxLength: 4096 }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskExecutionLaunchAbsentEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-launch-absent"),
		data: Type.Object(
			{
				executionId: TaskExecutionIdSchema,
				operationId: SubagentOperationIdSchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskExecutionLaunchReceiptedEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-launch-receipted"),
		data: Type.Object(
			{
				executionId: TaskExecutionIdSchema,
				operationId: SubagentOperationIdSchema,
				subagentRunId: SubagentRunIdSchema,
				subagentAttemptId: SubagentAttemptIdSchema,
				status: SubagentRunStatusSchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskExecutionChildObservedEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-child-observed"),
		data: Type.Object(
			{
				executionId: TaskExecutionIdSchema,
				subagentRunId: SubagentRunIdSchema,
				subagentAttemptId: SubagentAttemptIdSchema,
				status: SubagentRunStatusSchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskExecutionChildSettledEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-child-settled"),
		data: Type.Object(
			{
				executionId: TaskExecutionIdSchema,
				evidence: SubagentTerminalEvidenceSchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskAttemptKindSchema = Type.Union([
	Type.Literal("retry"),
	Type.Literal("resume"),
]);

const TaskAttemptOrdinalSchema = Type.Integer({
	minimum: 2,
	maximum: MAX_TASK_ATTEMPTS,
});

const TaskAttemptFailureRetrySchema = Type.Union([
	Type.Literal("backoff"),
	Type.Literal("manual"),
	Type.Literal("resume"),
]);

const TaskExecutionAttemptIntendedEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-attempt-intended"),
		data: Type.Object(
			{
				executionId: TaskExecutionIdSchema,
				subagentRunId: SubagentRunIdSchema,
				kind: TaskAttemptKindSchema,
				ordinal: TaskAttemptOrdinalSchema,
				previousAttemptId: SubagentAttemptIdSchema,
				failureCode: Type.String({ minLength: 1, maxLength: 128 }),
				failureRetry: TaskAttemptFailureRetrySchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskExecutionAttemptReceiptedEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-attempt-receipted"),
		data: Type.Object(
			{
				executionId: TaskExecutionIdSchema,
				subagentRunId: SubagentRunIdSchema,
				ordinal: TaskAttemptOrdinalSchema,
				subagentAttemptId: SubagentAttemptIdSchema,
				status: SubagentRunStatusSchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskExecutionAttemptDeclinedEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-attempt-declined"),
		data: Type.Object(
			{
				executionId: TaskExecutionIdSchema,
				subagentRunId: SubagentRunIdSchema,
				ordinal: TaskAttemptOrdinalSchema,
				reason: Type.String({ minLength: 1, maxLength: 4096 }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskExecutionArtifactImportedEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-artifact-imported"),
		data: Type.Object(
			{
				executionId: TaskExecutionIdSchema,
				subagentRunId: SubagentRunIdSchema,
				artifactId: Type.String({ pattern: "^artifact_[a-f0-9]{64}$" }),
				sourceResultSha256: Sha256Schema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskExecutionReleaseIntendedEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-release-intended"),
		data: Type.Object(
			{
				executionId: TaskExecutionIdSchema,
				subagentRunId: SubagentRunIdSchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskExecutionReleasedEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-released"),
		data: Type.Object(
			{
				executionId: TaskExecutionIdSchema,
				subagentRunId: SubagentRunIdSchema,
				status: SubagentRunStatusSchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskExecutionSupportIntendedEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-support-intended"),
		data: Type.Object(
			{
				executionId: TaskExecutionIdSchema,
				implementationIdentitySha256: Sha256Schema,
				parametersSha256: Sha256Schema,
				inputsSha256: Sha256Schema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskExecutionSupportOutputCommittedEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-support-output-committed"),
		data: Type.Object(
			{
				executionId: TaskExecutionIdSchema,
				artifactId: WorkflowArtifactIdSchema,
				outputSha256: Sha256Schema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const NestedTimeoutMsSchema = Type.Integer({
	minimum: 1_000,
	maximum: 365 * 24 * 60 * 60 * 1_000,
});

const NestedConcurrencySchema = Type.Integer({
	minimum: 1,
	maximum: MAX_WORKFLOW_CONCURRENCY,
});

const TaskExecutionNestedIntendedEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-nested-intended"),
		data: Type.Object(
			{
				executionId: TaskExecutionIdSchema,
				childRunId: WorkflowRunIdSchema,
				definitionIdentitySha256: Sha256Schema,
				inputSha256: Sha256Schema,
				inputsSha256: Sha256Schema,
				resolvedInputSha256: Sha256Schema,
				budget: WorkflowBudgetSchema,
				timeoutMs: NestedTimeoutMsSchema,
				deadlineAt: Type.String({ format: "date-time" }),
				concurrency: NestedConcurrencySchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskExecutionNestedLaunchedEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-nested-launched"),
		data: Type.Object(
			{
				executionId: TaskExecutionIdSchema,
				childRunId: WorkflowRunIdSchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskExecutionNestedSettledEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-nested-settled"),
		data: Type.Object(
			{
				executionId: TaskExecutionIdSchema,
				childRunId: WorkflowRunIdSchema,
				status: WorkflowRunStatusSchema,
				usage: NestedWorkflowUsageSchema,
				usageComplete: Type.Boolean(),
				outputArtifactId: Type.Optional(WorkflowArtifactIdSchema),
				outputSha256: Type.Optional(Sha256Schema),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskExecutionNestedOutputImportedEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-nested-output-imported"),
		data: Type.Object(
			{
				executionId: TaskExecutionIdSchema,
				childRunId: WorkflowRunIdSchema,
				artifactId: WorkflowArtifactIdSchema,
				sourceArtifactId: WorkflowArtifactIdSchema,
				sourceSha256: Sha256Schema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskExecutionTerminalEventSchema = Type.Object(
	{
		type: Type.Literal("task-execution-terminal"),
		data: Type.Object(
			{
				executionId: TaskExecutionIdSchema,
				outcome: TaskExecutionOutcomeSchema,
				evidence: TaskExecutionTerminalEvidenceSchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskStatusChangedEventSchema = Type.Object(
	{
		type: Type.Literal("task-status-changed"),
		data: Type.Object(
			{
				taskId: WorkflowTaskIdSchema,
				from: WorkflowTaskStatusSchema,
				to: WorkflowTaskStatusSchema,
				reason: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const TaskInvalidatedEventSchema = Type.Object(
	{
		type: Type.Literal("task-invalidated"),
		data: Type.Object(
			{
				causeTaskId: WorkflowTaskIdSchema,
				taskIds: Type.Array(WorkflowTaskIdSchema, {
					minItems: 1,
					maxItems: 256,
					uniqueItems: true,
				}),
				/** Ascending on-path epochs abandoned by this invalidation; may be empty. */
				abandonedEpochs: Type.Array(Type.Integer({ minimum: 1 }), {
					maxItems: 4096,
					uniqueItems: true,
				}),
				reason: Type.String({ minLength: 1, maxLength: 4096 }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const RunOutputCommittedEventSchema = Type.Object(
	{
		type: Type.Literal("run-output-committed"),
		data: Type.Object(
			{ artifactId: Type.String({ pattern: "^artifact_[a-f0-9]{64}$" }) },
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const RunStatusChangedEventSchema = Type.Object(
	{
		type: Type.Literal("run-status-changed"),
		data: Type.Object(
			{
				from: WorkflowRunStatusSchema,
				to: WorkflowRunStatusSchema,
				reason: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const WorkflowEventInputSchema = Type.Union([
	RunCreatedEventSchema,
	WorkflowEffectEventSchema,
	TaskDeclaredEventSchema,
	ArtifactDeclaredEventSchema,
	BarrierReachedEventSchema,
	TaskExecutionCreatedEventSchema,
	TaskExecutionPreflightedEventSchema,
	TaskExecutionLaunchIntendedEventSchema,
	TaskExecutionLaunchUncertainEventSchema,
	TaskExecutionLaunchAbsentEventSchema,
	TaskExecutionLaunchReceiptedEventSchema,
	TaskExecutionChildObservedEventSchema,
	TaskExecutionChildSettledEventSchema,
	TaskExecutionAttemptIntendedEventSchema,
	TaskExecutionAttemptReceiptedEventSchema,
	TaskExecutionAttemptDeclinedEventSchema,
	TaskExecutionArtifactImportedEventSchema,
	TaskExecutionReleaseIntendedEventSchema,
	TaskExecutionReleasedEventSchema,
	TaskExecutionSupportIntendedEventSchema,
	TaskExecutionSupportOutputCommittedEventSchema,
	TaskExecutionNestedIntendedEventSchema,
	TaskExecutionNestedLaunchedEventSchema,
	TaskExecutionNestedSettledEventSchema,
	TaskExecutionNestedOutputImportedEventSchema,
	TaskExecutionTerminalEventSchema,
	TaskStatusChangedEventSchema,
	TaskInvalidatedEventSchema,
	RunOutputCommittedEventSchema,
	RunStatusChangedEventSchema,
]);
export type WorkflowEventInput = Static<typeof WorkflowEventInputSchema>;
export type WorkflowEventType = WorkflowEventInput["type"];

export const WorkflowTaskProjectionSchema = Type.Object(
	{
		task: MaterializedWorkflowTaskSchema,
		status: WorkflowTaskStatusSchema,
		committed: Type.Boolean(),
		currentExecutionId: Type.Optional(TaskExecutionIdSchema),
		/** Declared in an abandoned epoch and not readopted by the current path. */
		abandoned: Type.Optional(Type.Literal(true)),
	},
	{ additionalProperties: false },
);
export type WorkflowTaskProjection = Static<
	typeof WorkflowTaskProjectionSchema
>;

const TaskExecutionPhaseSchema = Type.Union([
	Type.Literal("created"),
	Type.Literal("preflighted"),
	Type.Literal("launch-intended"),
	Type.Literal("launch-uncertain"),
	Type.Literal("launch-absent"),
	Type.Literal("launched"),
	Type.Literal("observed"),
	Type.Literal("settled"),
	Type.Literal("attempt-intended"),
	Type.Literal("artifact-imported"),
	Type.Literal("release-intended"),
	Type.Literal("released"),
	Type.Literal("support-intended"),
	Type.Literal("support-output-committed"),
	Type.Literal("nested-intended"),
	Type.Literal("nested-launched"),
	Type.Literal("nested-settled"),
	Type.Literal("nested-output-imported"),
	Type.Literal("terminal"),
]);

const SequencedPreflightSchema = Type.Object(
	{
		operationId: SubagentOperationIdSchema,
		preflightId: Type.String({ minLength: 1, maxLength: 128 }),
		planIdentitySha256: Sha256Schema,
		plannedSubagentRunId: SubagentRunIdSchema,
		plannedSubagentAttemptId: SubagentAttemptIdSchema,
		expiresAt: Type.String({ format: "date-time" }),
		supersedesPreflightId: Type.Optional(
			Type.String({ minLength: 1, maxLength: 128 }),
		),
		fencingGeneration: Type.Integer({
			minimum: 1,
			maximum: Number.MAX_SAFE_INTEGER,
		}),
		sequence: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const SequencedLaunchIntentSchema = Type.Object(
	{
		operationId: SubagentOperationIdSchema,
		preflightId: Type.String({ minLength: 1, maxLength: 128 }),
		planIdentitySha256: Sha256Schema,
		sequence: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const SequencedLaunchUncertainSchema = Type.Object(
	{
		operationId: SubagentOperationIdSchema,
		reason: Type.String({ minLength: 1, maxLength: 4096 }),
		sequence: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const SequencedLaunchAbsentSchema = Type.Object(
	{
		operationId: SubagentOperationIdSchema,
		sequence: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const SequencedLaunchReceiptSchema = Type.Object(
	{
		operationId: SubagentOperationIdSchema,
		subagentRunId: SubagentRunIdSchema,
		subagentAttemptId: SubagentAttemptIdSchema,
		status: SubagentRunStatusSchema,
		sequence: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const SequencedChildObservationSchema = Type.Object(
	{
		subagentRunId: SubagentRunIdSchema,
		subagentAttemptId: SubagentAttemptIdSchema,
		status: SubagentRunStatusSchema,
		sequence: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const SequencedSettlementSchema = Type.Object(
	{
		evidence: SubagentTerminalEvidenceSchema,
		sequence: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const SequencedAttemptSchema = Type.Object(
	{
		kind: TaskAttemptKindSchema,
		ordinal: TaskAttemptOrdinalSchema,
		previousAttemptId: SubagentAttemptIdSchema,
		subagentAttemptId: Type.Optional(SubagentAttemptIdSchema),
		status: Type.Optional(SubagentRunStatusSchema),
		intentSequence: Type.Integer({ minimum: 1 }),
		receiptSequence: Type.Optional(Type.Integer({ minimum: 1 })),
		declinedSequence: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);
export type TaskExecutionAttemptProjection = Static<
	typeof SequencedAttemptSchema
>;

const SequencedArtifactImportSchema = Type.Object(
	{
		subagentRunId: SubagentRunIdSchema,
		artifactId: Type.String({ pattern: "^artifact_[a-f0-9]{64}$" }),
		sourceResultSha256: Sha256Schema,
		sequence: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const SequencedReleaseIntentSchema = Type.Object(
	{
		subagentRunId: SubagentRunIdSchema,
		sequence: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const SequencedReleaseSchema = Type.Object(
	{
		subagentRunId: SubagentRunIdSchema,
		status: SubagentRunStatusSchema,
		sequence: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const SequencedSupportIntentSchema = Type.Object(
	{
		implementationIdentitySha256: Sha256Schema,
		parametersSha256: Sha256Schema,
		inputsSha256: Sha256Schema,
		sequence: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const SequencedSupportOutputSchema = Type.Object(
	{
		artifactId: WorkflowArtifactIdSchema,
		outputSha256: Sha256Schema,
		sequence: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const SequencedNestedIntentSchema = Type.Object(
	{
		childRunId: WorkflowRunIdSchema,
		definitionIdentitySha256: Sha256Schema,
		inputSha256: Sha256Schema,
		inputsSha256: Sha256Schema,
		resolvedInputSha256: Sha256Schema,
		budget: WorkflowBudgetSchema,
		timeoutMs: NestedTimeoutMsSchema,
		deadlineAt: Type.String({ format: "date-time" }),
		concurrency: NestedConcurrencySchema,
		sequence: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const SequencedNestedLaunchSchema = Type.Object(
	{
		childRunId: WorkflowRunIdSchema,
		sequence: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const SequencedNestedSettlementSchema = Type.Object(
	{
		childRunId: WorkflowRunIdSchema,
		status: WorkflowRunStatusSchema,
		usage: NestedWorkflowUsageSchema,
		usageComplete: Type.Boolean(),
		outputArtifactId: Type.Optional(WorkflowArtifactIdSchema),
		outputSha256: Type.Optional(Sha256Schema),
		sequence: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const SequencedNestedOutputImportSchema = Type.Object(
	{
		childRunId: WorkflowRunIdSchema,
		artifactId: WorkflowArtifactIdSchema,
		sourceArtifactId: WorkflowArtifactIdSchema,
		sourceSha256: Sha256Schema,
		sequence: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const SequencedTerminalSchema = Type.Object(
	{
		outcome: TaskExecutionOutcomeSchema,
		evidence: TaskExecutionTerminalEvidenceSchema,
		sequence: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

export const TaskExecutionProjectionSchema = Type.Object(
	{
		execution: TaskExecutionRecordSchema,
		phase: TaskExecutionPhaseSchema,
		createdSequence: Type.Integer({ minimum: 1 }),
		preflight: Type.Optional(SequencedPreflightSchema),
		launchIntent: Type.Optional(SequencedLaunchIntentSchema),
		launchUncertain: Type.Optional(SequencedLaunchUncertainSchema),
		launchAbsent: Type.Optional(SequencedLaunchAbsentSchema),
		launchReceipt: Type.Optional(SequencedLaunchReceiptSchema),
		observation: Type.Optional(SequencedChildObservationSchema),
		settlement: Type.Optional(SequencedSettlementSchema),
		attempts: Type.Optional(
			Type.Array(SequencedAttemptSchema, { maxItems: MAX_TASK_ATTEMPTS }),
		),
		priorSettlements: Type.Optional(
			Type.Array(SequencedSettlementSchema, { maxItems: MAX_TASK_ATTEMPTS }),
		),
		attemptsClosed: Type.Optional(Type.Literal(true)),
		artifactImport: Type.Optional(SequencedArtifactImportSchema),
		releaseIntent: Type.Optional(SequencedReleaseIntentSchema),
		release: Type.Optional(SequencedReleaseSchema),
		supportIntent: Type.Optional(SequencedSupportIntentSchema),
		supportOutput: Type.Optional(SequencedSupportOutputSchema),
		nestedIntent: Type.Optional(SequencedNestedIntentSchema),
		nestedLaunch: Type.Optional(SequencedNestedLaunchSchema),
		nestedSettlement: Type.Optional(SequencedNestedSettlementSchema),
		nestedOutputImport: Type.Optional(SequencedNestedOutputImportSchema),
		terminal: Type.Optional(SequencedTerminalSchema),
	},
	{ additionalProperties: false },
);
export type TaskExecutionProjection = Static<
	typeof TaskExecutionProjectionSchema
>;

export const WorkflowBarrierProjectionSchema = Type.Object(
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
		sequence: Type.Integer({ minimum: 1 }),
		abandoned: Type.Optional(Type.Literal(true)),
	},
	{ additionalProperties: false },
);
export type WorkflowBarrierProjection = Static<
	typeof WorkflowBarrierProjectionSchema
>;

const WorkflowEffectProjectionSchema = Type.Object(
	{
		ordinal: Type.Integer({ minimum: 1, maximum: 4096 }),
		kind: Type.Union([Type.Literal("phase"), Type.Literal("log")]),
		value: Type.String({ minLength: 1, maxLength: 4096 }),
		sequence: Type.Integer({ minimum: 1 }),
		abandoned: Type.Optional(Type.Literal(true)),
	},
	{ additionalProperties: false },
);
export type WorkflowEffectProjection = Static<
	typeof WorkflowEffectProjectionSchema
>;

export const WorkflowStateProjectionSchema = Type.Object(
	{
		runId: WorkflowRunIdSchema,
		definitionIdentitySha256: Sha256Schema,
		inputSha256: Sha256Schema,
		status: WorkflowRunStatusSchema,
		currentEpoch: Type.Integer({ minimum: 1 }),
		effects: Type.Array(WorkflowEffectProjectionSchema, { maxItems: 4096 }),
		lastSequence: Type.Integer({ minimum: 1 }),
		tasks: Type.Record(WorkflowTaskIdSchema, WorkflowTaskProjectionSchema, {
			additionalProperties: false,
			maxProperties: 256,
		}),
		executions: Type.Record(
			TaskExecutionIdSchema,
			TaskExecutionProjectionSchema,
			{ additionalProperties: false, maxProperties: 4096 },
		),
		artifacts: Type.Record(
			Type.String({ pattern: "^artifact_[a-f0-9]{64}$" }),
			WorkflowArtifactRefSchema,
			{ additionalProperties: false, maxProperties: 4096 },
		),
		barriers: Type.Array(WorkflowBarrierProjectionSchema, { maxItems: 4096 }),
		outputArtifactId: Type.Optional(
			Type.String({ pattern: "^artifact_[a-f0-9]{64}$" }),
		),
	},
	{ additionalProperties: false },
);
export type WorkflowStateProjection = Static<
	typeof WorkflowStateProjectionSchema
>;
