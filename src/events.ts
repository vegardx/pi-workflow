import { type Static, Type } from "typebox";
import {
	MaterializedAgentTaskSchema,
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
	},
	{ additionalProperties: false },
);
export type WorkflowTaskProjection = Static<
	typeof WorkflowTaskProjectionSchema
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
