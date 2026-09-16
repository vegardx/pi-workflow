import { type Static, type TSchema, Type } from "typebox";

/*
 * The half of the workflow contracts that depends on nothing but TypeBox.
 * `contracts.ts` re-exports everything here and adds the schemas bound to
 * pi-subagent's contracts (agent requests, subagent evidence, handoff
 * descriptors, the runtime contract). The dynamic-workflow worker
 * (`dynamic/worker.ts`) and every module it loads before `ready` import this
 * module directly so a VM boot never pays for the pi-subagent module graph;
 * `test/dynamic-vm-host.test.ts` pins that import boundary.
 */

export const WORKFLOW_CONTRACT_REVISION = 18 as const;
/** Upper bound of one imported handoff; equals the artifact byte bound. */
export const MAX_WORKFLOW_HANDOFF_BYTES = 16 * 1024 * 1024;
/** Generations per task: the initial execution plus re-executions after invalidation. */
export const MAX_TASK_EXECUTION_GENERATIONS = 16;
// Initial attempt plus up to 10 retries and up to 10 resumes (pi-subagent caps).
export const MAX_TASK_ATTEMPTS = 21;
export const DEFAULT_WORKFLOW_CONCURRENCY = 4;
export const MAX_WORKFLOW_CONCURRENCY = 16;
export const MAX_NESTED_WORKFLOW_DEPTH = 4;
export const MAX_NESTED_WORKFLOW_TASKS = 64;
export const MAX_WORKFLOW_DURATION_MS = 365 * 24 * 60 * 60 * 1_000;

export const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const JsonPrimitiveSchema = Type.Union([
	Type.Null(),
	Type.Boolean(),
	Type.Number(),
	Type.String(),
]);
/*
 * JSON values nested up to 16 levels: at every level a primitive, an array
 * of the level below, or a record of it. The TypeBox constructors walk their
 * arguments as a tree on every call, so composing the levels through
 * `Type.Union` again costs 2^16 traversals (about 400 ms per process and
 * per VM boot). Each level is therefore built once as a template whose
 * child slots are then rebound to the shared level below; `test/contracts.test.ts`
 * pins the result to the composed schema.
 */
const JSON_VALUE_DEPTH = 16;
const jsonArrayTemplate = Type.Array(JsonPrimitiveSchema as TSchema);
const jsonRecordTemplate = Type.Record(
	Type.String(),
	JsonPrimitiveSchema as TSchema,
);
const jsonLevelTemplate = Type.Union([
	JsonPrimitiveSchema,
	jsonArrayTemplate,
	jsonRecordTemplate,
]);
const jsonDocumentTemplate = Type.Record(
	Type.String(),
	JsonPrimitiveSchema as TSchema,
	{ additionalProperties: false },
);

/** `template` with every pattern-property value replaced by `value`. */
function recordOf<T extends { patternProperties: Record<string, TSchema> }>(
	template: T,
	value: TSchema,
): T {
	const patternProperties: Record<string, TSchema> = {};
	for (const pattern of Object.keys(template.patternProperties)) {
		patternProperties[pattern] = value;
	}
	return { ...template, patternProperties };
}

let JsonValueSchema: TSchema = JsonPrimitiveSchema;
for (let depth = 0; depth < JSON_VALUE_DEPTH; depth++) {
	JsonValueSchema = {
		...jsonLevelTemplate,
		anyOf: [
			JsonPrimitiveSchema,
			{ ...jsonArrayTemplate, items: JsonValueSchema },
			recordOf(jsonRecordTemplate, JsonValueSchema),
		],
	};
}
export const JsonSchemaDocumentSchema = recordOf(
	jsonDocumentTemplate,
	JsonValueSchema,
);
export const ResourceNameSchema = Type.String({
	pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
	minLength: 1,
	maxLength: 128,
});

export const WorkflowBudgetSchema = Type.Object(
	{
		cost: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		totalTokens: Type.Optional(
			Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		),
		childRuntimeMs: Type.Integer({
			minimum: 1_000,
			maximum: MAX_WORKFLOW_DURATION_MS,
		}),
	},
	{ additionalProperties: false },
);
export type WorkflowBudget = Static<typeof WorkflowBudgetSchema>;

export const WorkflowDefinitionNameSchema = Type.String({
	pattern: "^[a-z][a-z0-9-]*$",
	minLength: 1,
	maxLength: 128,
});
export type WorkflowDefinitionName = Static<
	typeof WorkflowDefinitionNameSchema
>;

export const WorkflowRunIdSchema = Type.String({
	pattern: "^workflow_[a-z0-9]+$",
	minLength: 10,
	maxLength: 128,
});
export type WorkflowRunId = Static<typeof WorkflowRunIdSchema>;

export const WorkflowTaskIdSchema = Type.String({
	pattern: "^task_[a-z0-9]+$",
	minLength: 6,
	maxLength: 128,
});
export type WorkflowTaskId = Static<typeof WorkflowTaskIdSchema>;

export const TaskExecutionIdSchema = Type.String({
	pattern: "^execution_[a-z0-9]+$",
	minLength: 11,
	maxLength: 128,
});
export type TaskExecutionId = Static<typeof TaskExecutionIdSchema>;

export const TaskExecutionGenerationSchema = Type.Integer({
	minimum: 1,
	maximum: MAX_TASK_EXECUTION_GENERATIONS,
});
export type TaskExecutionGeneration = Static<
	typeof TaskExecutionGenerationSchema
>;

export const SubagentOperationIdSchema = Type.String({
	pattern: "^workflow-op_[a-f0-9]{64}$",
});
export type SubagentOperationId = Static<typeof SubagentOperationIdSchema>;

/** Longest task key; namespace entries are task keys too. */
export const MAX_TASK_KEY_LENGTH = 128;
/** Deepest task namespace. */
export const MAX_TASK_NAMESPACE_DEPTH = 32;

export const TaskKeySchema = Type.String({
	pattern: "^[a-z][a-z0-9-]*$",
	minLength: 1,
	maxLength: MAX_TASK_KEY_LENGTH,
});
export type TaskKey = Static<typeof TaskKeySchema>;

export const WorkflowRunStatusSchema = Type.Union([
	Type.Literal("created"),
	Type.Literal("running"),
	Type.Literal("waiting"),
	Type.Literal("finalizing"),
	Type.Literal("stopping"),
	Type.Literal("completed"),
	Type.Literal("completed-degraded"),
	Type.Literal("failed"),
	Type.Literal("cancelled"),
	Type.Literal("interrupted"),
	Type.Literal("cleanup-blocked"),
]);
export type WorkflowRunStatus = Static<typeof WorkflowRunStatusSchema>;

export const WorkflowTaskStatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("ready"),
	Type.Literal("running"),
	Type.Literal("waiting"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("interrupted"),
	Type.Literal("blocked"),
	Type.Literal("cancelling"),
	Type.Literal("cancelled"),
	Type.Literal("cleanup-blocked"),
	Type.Literal("invalidated"),
]);
export type WorkflowTaskStatus = Static<typeof WorkflowTaskStatusSchema>;

export const TaskDispositionSchema = Type.Union([
	Type.Literal("required"),
	Type.Literal("optional"),
]);
export type TaskDisposition = Static<typeof TaskDispositionSchema>;

export const TaskRoleSchema = Type.Union([
	Type.Literal("task"),
	Type.Literal("finalizer"),
]);
export type TaskRole = Static<typeof TaskRoleSchema>;

export const ReplayPolicySchema = Type.Union([
	Type.Literal("auto"),
	Type.Literal("off"),
	Type.Literal("read-only"),
]);
export type ReplayPolicy = Static<typeof ReplayPolicySchema>;

export const TaskRefSchema = Type.Object(
	{
		runId: WorkflowRunIdSchema,
		taskId: WorkflowTaskIdSchema,
	},
	{ additionalProperties: false },
);
export type TaskRef = Static<typeof TaskRefSchema>;

export const WorkflowArtifactOutputSchema = Type.Union([
	Type.Literal("result"),
	Type.Literal("handoff"),
]);
export type WorkflowArtifactOutput = Static<
	typeof WorkflowArtifactOutputSchema
>;

export const WorkflowArtifactHandleRefSchema = Type.Object(
	{
		runId: WorkflowRunIdSchema,
		producerTaskId: WorkflowTaskIdSchema,
		output: WorkflowArtifactOutputSchema,
	},
	{ additionalProperties: false },
);
export type WorkflowArtifactHandleRef = Static<
	typeof WorkflowArtifactHandleRefSchema
>;

export const WorkflowArtifactIdSchema = Type.String({
	pattern: "^artifact_[a-f0-9]{64}$",
});
export type WorkflowArtifactId = Static<typeof WorkflowArtifactIdSchema>;

export const NestedWorkflowInputArtifactSchema = Type.Object(
	{
		runId: WorkflowRunIdSchema,
		artifactId: WorkflowArtifactIdSchema,
		sha256: Sha256Schema,
	},
	{ additionalProperties: false },
);
export type NestedWorkflowInputArtifact = Static<
	typeof NestedWorkflowInputArtifactSchema
>;

export const NestedWorkflowInputArtifactsSchema = Type.Record(
	TaskKeySchema,
	NestedWorkflowInputArtifactSchema,
	{
		additionalProperties: false,
		maxProperties: 64,
	},
);
export type NestedWorkflowInputArtifacts = Static<
	typeof NestedWorkflowInputArtifactsSchema
>;

export const WorkflowArtifactRefSchema = Type.Object(
	{
		id: WorkflowArtifactIdSchema,
		runId: WorkflowRunIdSchema,
		producerTaskId: Type.Optional(WorkflowTaskIdSchema),
		/** The producing task execution; present iff producerTaskId is present. */
		producerExecutionId: Type.Optional(TaskExecutionIdSchema),
		output: Type.Optional(WorkflowArtifactOutputSchema),
		sha256: Sha256Schema,
		bytes: Type.Integer({ minimum: 0, maximum: 16 * 1024 * 1024 }),
		mediaType: Type.String({
			pattern:
				"^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$",
			maxLength: 256,
		}),
		schemaSha256: Sha256Schema,
	},
	{ additionalProperties: false },
);
export type WorkflowArtifactRef = Static<typeof WorkflowArtifactRefSchema>;

export const SupportImplementationSchema = Type.Object(
	{
		name: Type.String({
			pattern: "^[a-zA-Z0-9@][a-zA-Z0-9@._/-]{0,255}$",
		}),
		moduleSpecifier: Type.String({
			pattern: "^[a-zA-Z0-9@][a-zA-Z0-9@._/-]{0,255}$",
		}),
		revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		implementationSha256: Sha256Schema,
		parametersSchema: JsonSchemaDocumentSchema,
		outputSchema: JsonSchemaDocumentSchema,
	},
	{ additionalProperties: false },
);
export type SupportImplementation = Static<typeof SupportImplementationSchema>;

export const SupportTaskRequestSchema = Type.Object(
	{
		implementation: SupportImplementationSchema,
		parameters: Type.Unknown(),
	},
	{ additionalProperties: false },
);
export type SupportTaskRequest = Static<typeof SupportTaskRequestSchema>;

export const AgentRetryClassSchema = Type.Union([
	Type.Literal("backoff"),
	Type.Literal("manual"),
]);
export type AgentRetryClass = Static<typeof AgentRetryClassSchema>;

export const AgentRetryPolicySchema = Type.Object(
	{
		attempts: Type.Integer({ minimum: 1, maximum: 10 }),
		on: Type.Array(AgentRetryClassSchema, {
			minItems: 1,
			maxItems: 2,
			uniqueItems: true,
		}),
	},
	{ additionalProperties: false },
);
export type AgentRetryPolicy = Static<typeof AgentRetryPolicySchema>;

export const AgentResumePolicySchema = Type.Object(
	{
		attempts: Type.Integer({ minimum: 1, maximum: 10 }),
	},
	{ additionalProperties: false },
);
export type AgentResumePolicy = Static<typeof AgentResumePolicySchema>;

/** Same pattern as pi-subagent's HandoffRefSchema object ids. */
export const GitObjectIdSchema = Type.String({ pattern: "^[a-f0-9]{40,64}$" });
export type GitObjectId = Static<typeof GitObjectIdSchema>;

export const HandoffPolicySchema = Type.Union([
	Type.Literal("required"),
	Type.Literal("optional"),
]);
export type HandoffPolicy = Static<typeof HandoffPolicySchema>;

export const AgentWorkspaceRequestSchema = Type.Union([
	Type.Object(
		{
			mode: Type.Literal("read-only"),
			cwd: Type.String({ minLength: 1, maxLength: 4096 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			mode: Type.Literal("worktree"),
			cwd: Type.String({ minLength: 1, maxLength: 4096 }),
		},
		{ additionalProperties: false },
	),
]);
export type AgentWorkspaceRequest = Static<typeof AgentWorkspaceRequestSchema>;
