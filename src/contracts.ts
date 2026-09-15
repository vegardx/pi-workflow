import {
	ContextScopeSchema,
	canonicalSha256,
	DelegatedTaskSchema,
	ExactModelRequestSchema,
	HANDOFF_EXPORT_MEDIA_TYPE,
	type HandoffRef,
	HandoffRefSchema,
	RunLimitsSchema,
	ArtifactRefSchema as SubagentArtifactRefSchema,
	AttemptIdSchema as SubagentAttemptIdSchema,
	ClassifiedFailureSchema as SubagentClassifiedFailureSchema,
	CleanupOutcomeSchema as SubagentCleanupOutcomeSchema,
	RunIdSchema as SubagentRunIdSchema,
	RunStatusSchema as SubagentRunStatusSchema,
	type SubagentRuntimeContract,
	SubagentRuntimeContractSchema,
	UsageSchema as SubagentUsageSchema,
} from "@vegardx/pi-subagent";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

export const WORKFLOW_CONTRACT_REVISION = 17 as const;
/** Upper bound of one imported handoff; equals the artifact byte bound. */
export const MAX_WORKFLOW_HANDOFF_BYTES = 16 * 1024 * 1024;
/** Fixed format document whose digest is the schemaSha256 of every handoff artifact. */
export const WORKFLOW_HANDOFF_FORMAT = Object.freeze({
	format: "git-format-patch",
	mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
	/** pi-subagent contract revision that defines the rendering. */
	revision: 6,
});
export const WORKFLOW_HANDOFF_FORMAT_SHA256 = canonicalSha256(
	WORKFLOW_HANDOFF_FORMAT,
);
/** Generations per task: the initial execution plus re-executions after invalidation. */
export const MAX_TASK_EXECUTION_GENERATIONS = 16;
// Initial attempt plus up to 10 retries and up to 10 resumes (pi-subagent caps).
export const MAX_TASK_ATTEMPTS = 21;
export const DEFAULT_WORKFLOW_CONCURRENCY = 4;
export const MAX_WORKFLOW_CONCURRENCY = 16;
export const MAX_NESTED_WORKFLOW_DEPTH = 4;
export const MAX_NESTED_WORKFLOW_TASKS = 64;
const MAX_WORKFLOW_DURATION_MS = 365 * 24 * 60 * 60 * 1_000;

const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const JsonPrimitiveSchema = Type.Union([
	Type.Null(),
	Type.Boolean(),
	Type.Number(),
	Type.String(),
]);
let JsonValueSchema: TSchema = JsonPrimitiveSchema;
for (let depth = 0; depth < 16; depth++) {
	JsonValueSchema = Type.Union([
		JsonPrimitiveSchema,
		Type.Array(JsonValueSchema),
		Type.Record(Type.String(), JsonValueSchema),
	]);
}
export const JsonSchemaDocumentSchema = Type.Record(
	Type.String(),
	JsonValueSchema,
	{
		additionalProperties: false,
	},
);
const ResourceNameSchema = Type.String({
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

export const AgentTaskRequestSchema = Type.Object(
	{
		agent: ResourceNameSchema,
		task: DelegatedTaskSchema,
		contextMode: Type.Literal("fresh"),
		model: Type.Optional(ExactModelRequestSchema),
		tools: Type.Array(ResourceNameSchema, {
			maxItems: 64,
			uniqueItems: true,
		}),
		preloadSkills: Type.Array(ResourceNameSchema, {
			maxItems: 64,
			uniqueItems: true,
		}),
		contextScopes: Type.Array(ContextScopeSchema, {
			maxItems: 2,
			uniqueItems: true,
		}),
		workspace: AgentWorkspaceRequestSchema,
		/** Worktree tasks only; normalized to "required" by the materializer when omitted. */
		handoff: Type.Optional(HandoffPolicySchema),
		outputSchema: JsonSchemaDocumentSchema,
		limits: RunLimitsSchema,
		retry: Type.Optional(AgentRetryPolicySchema),
		resume: Type.Optional(AgentResumePolicySchema),
	},
	{ additionalProperties: false },
);
export type AgentTaskRequest = Static<typeof AgentTaskRequestSchema>;

export const NestedWorkflowTaskRequestSchema = Type.Object(
	{
		definitionName: WorkflowDefinitionNameSchema,
		definitionIdentitySha256: Sha256Schema,
		definitionSourceSha256: Sha256Schema,
		definitionVersion: Type.Integer({
			minimum: 1,
			maximum: Number.MAX_SAFE_INTEGER,
		}),
		input: Type.Unknown(),
		inputSha256: Sha256Schema,
		inputSchema: JsonSchemaDocumentSchema,
		outputSchema: JsonSchemaDocumentSchema,
		budget: WorkflowBudgetSchema,
		timeoutMs: Type.Integer({
			minimum: 1_000,
			maximum: MAX_WORKFLOW_DURATION_MS,
		}),
		concurrency: Type.Integer({
			minimum: 1,
			maximum: MAX_WORKFLOW_CONCURRENCY,
		}),
	},
	{ additionalProperties: false },
);
export type NestedWorkflowTaskRequest = Static<
	typeof NestedWorkflowTaskRequestSchema
>;

const TaskInputsSchema = Type.Record(
	TaskKeySchema,
	WorkflowArtifactHandleRefSchema,
	{
		additionalProperties: false,
		maxProperties: 64,
	},
);

export const AgentTaskSpecSchema = Type.Object(
	{
		key: TaskKeySchema,
		kind: Type.Literal("agent"),
		role: TaskRoleSchema,
		disposition: TaskDispositionSchema,
		after: Type.Array(TaskRefSchema, {
			maxItems: 256,
			uniqueItems: true,
		}),
		inputs: TaskInputsSchema,
		replay: ReplayPolicySchema,
		request: AgentTaskRequestSchema,
		identitySha256: Sha256Schema,
	},
	{ additionalProperties: false },
);
export type AgentTaskSpec = Static<typeof AgentTaskSpecSchema>;

export const SupportTaskSpecSchema = Type.Object(
	{
		key: TaskKeySchema,
		kind: Type.Literal("support"),
		role: TaskRoleSchema,
		disposition: TaskDispositionSchema,
		after: Type.Array(TaskRefSchema, {
			maxItems: 256,
			uniqueItems: true,
		}),
		inputs: TaskInputsSchema,
		replay: ReplayPolicySchema,
		request: SupportTaskRequestSchema,
		identitySha256: Sha256Schema,
	},
	{ additionalProperties: false },
);
export type SupportTaskSpec = Static<typeof SupportTaskSpecSchema>;

export const NestedWorkflowTaskSpecSchema = Type.Object(
	{
		key: TaskKeySchema,
		kind: Type.Literal("workflow"),
		role: TaskRoleSchema,
		disposition: TaskDispositionSchema,
		after: Type.Array(TaskRefSchema, {
			maxItems: 256,
			uniqueItems: true,
		}),
		inputs: TaskInputsSchema,
		replay: ReplayPolicySchema,
		request: NestedWorkflowTaskRequestSchema,
		identitySha256: Sha256Schema,
	},
	{ additionalProperties: false },
);
export type NestedWorkflowTaskSpec = Static<
	typeof NestedWorkflowTaskSpecSchema
>;

export const MaterializedAgentTaskSchema = Type.Object(
	{
		id: WorkflowTaskIdSchema,
		runId: WorkflowRunIdSchema,
		namespace: Type.Array(TaskKeySchema, {
			maxItems: MAX_TASK_NAMESPACE_DEPTH,
		}),
		spec: AgentTaskSpecSchema,
		definitionIdentitySha256: Sha256Schema,
		materializationSequence: Type.Integer({ minimum: 1 }),
		materializationEpoch: Type.Integer({ minimum: 1 }),
		epochPosition: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);
export type MaterializedAgentTask = Static<typeof MaterializedAgentTaskSchema>;

export const MaterializedSupportTaskSchema = Type.Object(
	{
		id: WorkflowTaskIdSchema,
		runId: WorkflowRunIdSchema,
		namespace: Type.Array(TaskKeySchema, {
			maxItems: MAX_TASK_NAMESPACE_DEPTH,
		}),
		spec: SupportTaskSpecSchema,
		definitionIdentitySha256: Sha256Schema,
		materializationSequence: Type.Integer({ minimum: 1 }),
		materializationEpoch: Type.Integer({ minimum: 1 }),
		epochPosition: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);
export type MaterializedSupportTask = Static<
	typeof MaterializedSupportTaskSchema
>;

export const MaterializedNestedWorkflowTaskSchema = Type.Object(
	{
		id: WorkflowTaskIdSchema,
		runId: WorkflowRunIdSchema,
		namespace: Type.Array(TaskKeySchema, {
			maxItems: MAX_TASK_NAMESPACE_DEPTH,
		}),
		spec: NestedWorkflowTaskSpecSchema,
		definitionIdentitySha256: Sha256Schema,
		materializationSequence: Type.Integer({ minimum: 1 }),
		materializationEpoch: Type.Integer({ minimum: 1 }),
		epochPosition: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);
export type MaterializedNestedWorkflowTask = Static<
	typeof MaterializedNestedWorkflowTaskSchema
>;

export const MaterializedWorkflowTaskSchema = Type.Union([
	MaterializedAgentTaskSchema,
	MaterializedSupportTaskSchema,
	MaterializedNestedWorkflowTaskSchema,
]);
export type MaterializedWorkflowTask = Static<
	typeof MaterializedWorkflowTaskSchema
>;

export const AgentTaskExecutionRecordSchema = Type.Object(
	{
		kind: Type.Literal("agent"),
		id: TaskExecutionIdSchema,
		runId: WorkflowRunIdSchema,
		taskId: WorkflowTaskIdSchema,
		generation: TaskExecutionGenerationSchema,
		taskIdentitySha256: Sha256Schema,
		operationId: SubagentOperationIdSchema,
	},
	{ additionalProperties: false },
);
export type AgentTaskExecutionRecord = Static<
	typeof AgentTaskExecutionRecordSchema
>;

export const SupportTaskExecutionRecordSchema = Type.Object(
	{
		kind: Type.Literal("support"),
		id: TaskExecutionIdSchema,
		runId: WorkflowRunIdSchema,
		taskId: WorkflowTaskIdSchema,
		generation: TaskExecutionGenerationSchema,
		taskIdentitySha256: Sha256Schema,
		implementationIdentitySha256: Sha256Schema,
	},
	{ additionalProperties: false },
);
export type SupportTaskExecutionRecord = Static<
	typeof SupportTaskExecutionRecordSchema
>;

export const NestedWorkflowTaskExecutionRecordSchema = Type.Object(
	{
		kind: Type.Literal("workflow"),
		id: TaskExecutionIdSchema,
		runId: WorkflowRunIdSchema,
		taskId: WorkflowTaskIdSchema,
		generation: TaskExecutionGenerationSchema,
		taskIdentitySha256: Sha256Schema,
		childRunId: WorkflowRunIdSchema,
	},
	{ additionalProperties: false },
);
export type NestedWorkflowTaskExecutionRecord = Static<
	typeof NestedWorkflowTaskExecutionRecordSchema
>;

export const TaskExecutionRecordSchema = Type.Union([
	AgentTaskExecutionRecordSchema,
	SupportTaskExecutionRecordSchema,
	NestedWorkflowTaskExecutionRecordSchema,
]);
export type TaskExecutionRecord = Static<typeof TaskExecutionRecordSchema>;

/** Handoff identity projected from a settled worktree attempt; never paths, branches, or refs. */
export const SubagentHandoffEvidenceSchema = Type.Object(
	{
		attemptId: SubagentAttemptIdSchema,
		baselineHead: GitObjectIdSchema,
		handoffCommit: GitObjectIdSchema,
	},
	{ additionalProperties: false },
);
export type SubagentHandoffEvidence = Static<
	typeof SubagentHandoffEvidenceSchema
>;

export const SubagentTerminalEvidenceSchema = Type.Object(
	{
		kind: Type.Literal("subagent"),
		attemptOrdinal: Type.Integer({ minimum: 1, maximum: MAX_TASK_ATTEMPTS }),
		resultSha256: Sha256Schema,
		status: SubagentRunStatusSchema,
		usage: SubagentUsageSchema,
		usageComplete: Type.Boolean(),
		runtimeMs: Type.Integer({
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER,
		}),
		failure: Type.Optional(SubagentClassifiedFailureSchema),
		sandboxCleanup: SubagentCleanupOutcomeSchema,
		workspaceCleanup: SubagentCleanupOutcomeSchema,
		truncated: Type.Boolean(),
		output: Type.Optional(SubagentArtifactRefSchema),
		structuredOutputSha256: Type.Optional(Sha256Schema),
		handoff: Type.Optional(SubagentHandoffEvidenceSchema),
	},
	{ additionalProperties: false },
);
export type SubagentTerminalEvidence = Static<
	typeof SubagentTerminalEvidenceSchema
>;

export const WorkflowExecutionFailureEvidenceSchema = Type.Object(
	{
		kind: Type.Literal("workflow"),
		stage: Type.Union([
			Type.Literal("preflight"),
			Type.Literal("launch"),
			Type.Literal("reconciliation"),
			Type.Literal("stop"),
			Type.Literal("artifact-import"),
			Type.Literal("release"),
			Type.Literal("support-resolution"),
			Type.Literal("support-input"),
			Type.Literal("support-execution"),
			Type.Literal("support-output"),
			Type.Literal("nested-resolution"),
			Type.Literal("nested-launch"),
			Type.Literal("nested-import"),
			Type.Literal("nested-input"),
			Type.Literal("handoff-import"),
		]),
		failureSha256: Sha256Schema,
		message: Type.String({ minLength: 1, maxLength: 4096 }),
	},
	{ additionalProperties: false },
);
export type WorkflowExecutionFailureEvidence = Static<
	typeof WorkflowExecutionFailureEvidenceSchema
>;

export const SupportTaskTerminalEvidenceSchema = Type.Object(
	{
		kind: Type.Literal("support"),
		implementationIdentitySha256: Sha256Schema,
		parametersSha256: Sha256Schema,
		inputsSha256: Sha256Schema,
		outputSha256: Sha256Schema,
		artifactId: WorkflowArtifactIdSchema,
		durationMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	},
	{ additionalProperties: false },
);
export type SupportTaskTerminalEvidence = Static<
	typeof SupportTaskTerminalEvidenceSchema
>;

export const NestedWorkflowUsageSchema = Type.Object(
	{
		cost: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		totalTokens: Type.Integer({
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER,
		}),
		childRuntimeMs: Type.Integer({
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER,
		}),
	},
	{ additionalProperties: false },
);
export type NestedWorkflowUsage = Static<typeof NestedWorkflowUsageSchema>;

export const NestedWorkflowTerminalEvidenceSchema = Type.Object(
	{
		kind: Type.Literal("nested-workflow"),
		childRunId: WorkflowRunIdSchema,
		status: WorkflowRunStatusSchema,
		usage: NestedWorkflowUsageSchema,
		usageComplete: Type.Boolean(),
		outputSha256: Type.Optional(Sha256Schema),
		artifactId: Type.Optional(WorkflowArtifactIdSchema),
	},
	{ additionalProperties: false },
);
export type NestedWorkflowTerminalEvidence = Static<
	typeof NestedWorkflowTerminalEvidenceSchema
>;

export const TaskExecutionTerminalEvidenceSchema = Type.Union([
	SubagentTerminalEvidenceSchema,
	WorkflowExecutionFailureEvidenceSchema,
	SupportTaskTerminalEvidenceSchema,
	NestedWorkflowTerminalEvidenceSchema,
]);
export type TaskExecutionTerminalEvidence = Static<
	typeof TaskExecutionTerminalEvidenceSchema
>;

export const TaskExecutionOutcomeSchema = Type.Union([
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("cancelled"),
	Type.Literal("interrupted"),
	Type.Literal("cleanup-blocked"),
]);
export type TaskExecutionOutcome = Static<typeof TaskExecutionOutcomeSchema>;

/**
 * The only JSON face of an imported handoff: what ctx.handoff() resolves, what a
 * returned handoff handle commits as workflow output, and what input projection
 * places in delegated context. It carries identity, never paths or branch names.
 */
export const WorkflowHandoffDescriptorSchema = Type.Object(
	{
		artifactId: WorkflowArtifactIdSchema,
		runId: WorkflowRunIdSchema,
		producerTaskId: WorkflowTaskIdSchema,
		producerExecutionId: TaskExecutionIdSchema,
		subagentRunId: SubagentRunIdSchema,
		subagentAttemptId: SubagentAttemptIdSchema,
		baselineHead: GitObjectIdSchema,
		handoffCommit: GitObjectIdSchema,
		format: Type.Literal("git-format-patch"),
		mediaType: Type.Literal(HANDOFF_EXPORT_MEDIA_TYPE),
		sha256: Sha256Schema,
		bytes: Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_HANDOFF_BYTES }),
	},
	{ additionalProperties: false },
);
export type WorkflowHandoffDescriptor = Static<
	typeof WorkflowHandoffDescriptorSchema
>;

export {
	type HandoffRef,
	HandoffRefSchema,
	SubagentAttemptIdSchema,
	SubagentRunIdSchema,
	SubagentRunStatusSchema,
};

export const WorkflowRuntimeContractSchema = Type.Object(
	{
		schema: Type.Literal("pi-workflow-runtime"),
		contractRevision: Type.Literal(WORKFLOW_CONTRACT_REVISION),
		requiredSubagent: SubagentRuntimeContractSchema,
		features: Type.Object(
			{
				staticWorkflows: Type.Boolean(),
				dynamicWorkflows: Type.Boolean(),
				durableRuns: Type.Boolean(),
				parallel: Type.Boolean(),
				settledResults: Type.Boolean(),
				fanOut: Type.Boolean(),
				fanIn: Type.Boolean(),
				pipelines: Type.Boolean(),
				resume: Type.Boolean(),
				replay: Type.Boolean(),
				worktrees: Type.Boolean(),
				supportTaskExecution: Type.Boolean(),
				nestedWorkflows: Type.Boolean(),
				nestedArtifactInputs: Type.Boolean(),
				retryAttempts: Type.Boolean(),
				resumeAttempts: Type.Boolean(),
				executionGenerations: Type.Boolean(),
				transactionalInvalidation: Type.Boolean(),
				finalizers: Type.Boolean(),
				operatorAttempts: Type.Boolean(),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export type WorkflowRuntimeContract = Static<
	typeof WorkflowRuntimeContractSchema
>;

const REQUIRED_SUBAGENT_CONTRACT: SubagentRuntimeContract = Object.freeze({
	schema: "pi-subagent-runtime",
	contractRevision: 6,
	features: Object.freeze({
		nativeSessionBackend: true,
		gondolinSandbox: true,
		background: false,
		survivesSeatExit: false,
		steering: true,
		followUp: true,
		structuredOutput: true,
		preflight: true,
		idempotentLaunch: true,
		resume: true,
		classifiedFailures: true,
		cumulativeRuntimeBudget: true,
		costFirstBudgets: true,
		retryBackoff: true,
		deepReconciliation: true,
		worktrees: true,
		handoffExport: true,
		publicNetworkEgress: true,
		explicitResources: true,
		ambientExtensionsControl: true,
		hostBrokeredTools: true,
	}),
});

export const WORKFLOW_RUNTIME_CONTRACT: WorkflowRuntimeContract = Object.freeze(
	{
		schema: "pi-workflow-runtime",
		contractRevision: WORKFLOW_CONTRACT_REVISION,
		requiredSubagent: REQUIRED_SUBAGENT_CONTRACT,
		features: Object.freeze({
			staticWorkflows: true,
			dynamicWorkflows: false,
			durableRuns: true,
			parallel: true,
			settledResults: true,
			fanOut: true,
			fanIn: true,
			pipelines: true,
			resume: false,
			replay: true,
			worktrees: true,
			supportTaskExecution: true,
			nestedWorkflows: true,
			nestedArtifactInputs: true,
			retryAttempts: true,
			resumeAttempts: true,
			executionGenerations: true,
			transactionalInvalidation: true,
			finalizers: true,
			operatorAttempts: true,
		}),
	},
);

export function isWorkflowRuntimeContract(
	value: unknown,
): value is WorkflowRuntimeContract {
	return Value.Check(WorkflowRuntimeContractSchema, value);
}

export function isCompatibleSubagentContract(
	value: unknown,
): value is SubagentRuntimeContract {
	if (!Value.Check(SubagentRuntimeContractSchema, value)) return false;
	for (const feature of Object.keys(
		REQUIRED_SUBAGENT_CONTRACT.features,
	) as Array<keyof SubagentRuntimeContract["features"]>) {
		if (
			value.features[feature] !== REQUIRED_SUBAGENT_CONTRACT.features[feature]
		) {
			return false;
		}
	}
	return true;
}
