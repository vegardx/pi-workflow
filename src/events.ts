import { type Static, Type } from "typebox";
import {
	MaterializedAgentTaskSchema,
	SubagentAttemptIdSchema,
	SubagentOperationIdSchema,
	SubagentRunIdSchema,
	SubagentRunStatusSchema,
	TaskExecutionIdSchema,
	TaskExecutionOutcomeSchema,
	TaskExecutionRecordSchema,
	TaskExecutionTerminalEvidenceSchema,
	WorkflowArtifactRefSchema,
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

const TaskDeclaredEventSchema = Type.Object(
	{
		type: Type.Literal("task-declared"),
		data: Type.Object(
			{ task: MaterializedAgentTaskSchema },
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
				expiresAt: Type.String({ format: "date-time" }),
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
				reason: Type.String({ minLength: 1, maxLength: 4096 }),
			},
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
	TaskExecutionArtifactImportedEventSchema,
	TaskExecutionReleaseIntendedEventSchema,
	TaskExecutionReleasedEventSchema,
	TaskExecutionTerminalEventSchema,
	TaskStatusChangedEventSchema,
	TaskInvalidatedEventSchema,
	RunStatusChangedEventSchema,
]);
export type WorkflowEventInput = Static<typeof WorkflowEventInputSchema>;
export type WorkflowEventType = WorkflowEventInput["type"];

export const WorkflowTaskProjectionSchema = Type.Object(
	{
		task: MaterializedAgentTaskSchema,
		status: WorkflowTaskStatusSchema,
		committed: Type.Boolean(),
		currentExecutionId: Type.Optional(TaskExecutionIdSchema),
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
	Type.Literal("artifact-imported"),
	Type.Literal("release-intended"),
	Type.Literal("released"),
	Type.Literal("terminal"),
]);

const SequencedPreflightSchema = Type.Object(
	{
		operationId: SubagentOperationIdSchema,
		preflightId: Type.String({ minLength: 1, maxLength: 128 }),
		planIdentitySha256: Sha256Schema,
		expiresAt: Type.String({ format: "date-time" }),
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
		artifactImport: Type.Optional(SequencedArtifactImportSchema),
		releaseIntent: Type.Optional(SequencedReleaseIntentSchema),
		release: Type.Optional(SequencedReleaseSchema),
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
			Type.Literal("final"),
		]),
		taskIds: Type.Array(WorkflowTaskIdSchema, {
			maxItems: 256,
			uniqueItems: true,
		}),
		sequence: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);
export type WorkflowBarrierProjection = Static<
	typeof WorkflowBarrierProjectionSchema
>;

export const WorkflowStateProjectionSchema = Type.Object(
	{
		runId: WorkflowRunIdSchema,
		definitionIdentitySha256: Sha256Schema,
		inputSha256: Sha256Schema,
		status: WorkflowRunStatusSchema,
		currentEpoch: Type.Integer({ minimum: 1 }),
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
	},
	{ additionalProperties: false },
);
export type WorkflowStateProjection = Static<
	typeof WorkflowStateProjectionSchema
>;
