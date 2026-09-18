import {
	ContextScopeSchema,
	canonicalSha256,
	DelegatedTaskSchema,
	ExactModelRequestSchema,
	HANDOFF_EXPORT_MEDIA_TYPE,
	type HandoffRef,
	HandoffRefSchema,
	MemoryBytesSchema,
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
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	AgentResumePolicySchema,
	AgentRetryPolicySchema,
	AgentWorkspaceRequestSchema,
	GitObjectIdSchema,
	HandoffPolicySchema,
	JsonSchemaDocumentSchema,
	MAX_TASK_ATTEMPTS,
	MAX_TASK_NAMESPACE_DEPTH,
	MAX_WORKFLOW_CONCURRENCY,
	MAX_WORKFLOW_DURATION_MS,
	MAX_WORKFLOW_HANDOFF_BYTES,
	ReplayPolicySchema,
	ResourceNameSchema,
	Sha256Schema,
	SubagentOperationIdSchema,
	SupportTaskRequestSchema,
	TaskDispositionSchema,
	TaskExecutionGenerationSchema,
	TaskExecutionIdSchema,
	TaskKeySchema,
	TaskRefSchema,
	TaskRoleSchema,
	WORKFLOW_CONTRACT_REVISION,
	WorkflowArtifactHandleRefSchema,
	WorkflowArtifactIdSchema,
	WorkflowBudgetSchema,
	WorkflowDefinitionNameSchema,
	WorkflowRunIdSchema,
	WorkflowRunStatusSchema,
	WorkflowTaskIdSchema,
} from "./contracts-core.js";

export * from "./contracts-core.js";

/** Fixed format document whose digest is the schemaSha256 of every handoff artifact. */
export const WORKFLOW_HANDOFF_FORMAT = Object.freeze({
	format: "git-format-patch",
	mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
	/** pi-subagent contract revision that defines the rendering. */
	revision: 7,
});
export const WORKFLOW_HANDOFF_FORMAT_SHA256 = canonicalSha256(
	WORKFLOW_HANDOFF_FORMAT,
);
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
		/**
		 * Guest VM memory grant, lowered unchanged to pi-subagent. Optional and
		 * additive under revision 19: when absent the agent definition's own
		 * ceiling applies. A value above that ceiling is refused by pi-subagent
		 * preflight, not here; the workflow cannot read agent frontmatter.
		 */
		memoryBytes: Type.Optional(MemoryBytesSchema),
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

export const CheckpointHeadlessPolicySchema = Type.Union([
	Type.Literal("block"),
	Type.Literal("use-explicit-default"),
]);
export type CheckpointHeadlessPolicy = Static<
	typeof CheckpointHeadlessPolicySchema
>;

export const CheckpointTaskRequestSchema = Type.Object(
	{
		schema: JsonSchemaDocumentSchema,
		prompt: Type.String({ minLength: 1, maxLength: 4096 }),
		default: Type.Optional(Type.Unknown()),
		headless: CheckpointHeadlessPolicySchema,
		timeoutMs: Type.Optional(
			Type.Integer({ minimum: 1_000, maximum: MAX_WORKFLOW_DURATION_MS }),
		),
	},
	{ additionalProperties: false },
);
export type CheckpointTaskRequest = Static<typeof CheckpointTaskRequestSchema>;

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

export const CheckpointTaskSpecSchema = Type.Object(
	{
		key: TaskKeySchema,
		kind: Type.Literal("checkpoint"),
		role: TaskRoleSchema,
		disposition: TaskDispositionSchema,
		after: Type.Array(TaskRefSchema, {
			maxItems: 256,
			uniqueItems: true,
		}),
		inputs: TaskInputsSchema,
		replay: ReplayPolicySchema,
		request: CheckpointTaskRequestSchema,
		identitySha256: Sha256Schema,
	},
	{ additionalProperties: false },
);
export type CheckpointTaskSpec = Static<typeof CheckpointTaskSpecSchema>;

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

export const MaterializedCheckpointTaskSchema = Type.Object(
	{
		id: WorkflowTaskIdSchema,
		runId: WorkflowRunIdSchema,
		namespace: Type.Array(TaskKeySchema, {
			maxItems: MAX_TASK_NAMESPACE_DEPTH,
		}),
		spec: CheckpointTaskSpecSchema,
		definitionIdentitySha256: Sha256Schema,
		materializationSequence: Type.Integer({ minimum: 1 }),
		materializationEpoch: Type.Integer({ minimum: 1 }),
		epochPosition: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);
export type MaterializedCheckpointTask = Static<
	typeof MaterializedCheckpointTaskSchema
>;

export const MaterializedWorkflowTaskSchema = Type.Union([
	MaterializedAgentTaskSchema,
	MaterializedSupportTaskSchema,
	MaterializedNestedWorkflowTaskSchema,
	MaterializedCheckpointTaskSchema,
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

export const CheckpointTaskExecutionRecordSchema = Type.Object(
	{
		kind: Type.Literal("checkpoint"),
		id: TaskExecutionIdSchema,
		runId: WorkflowRunIdSchema,
		taskId: WorkflowTaskIdSchema,
		generation: TaskExecutionGenerationSchema,
		taskIdentitySha256: Sha256Schema,
	},
	{ additionalProperties: false },
);
export type CheckpointTaskExecutionRecord = Static<
	typeof CheckpointTaskExecutionRecordSchema
>;

export const TaskExecutionRecordSchema = Type.Union([
	AgentTaskExecutionRecordSchema,
	SupportTaskExecutionRecordSchema,
	NestedWorkflowTaskExecutionRecordSchema,
	CheckpointTaskExecutionRecordSchema,
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
			Type.Literal("checkpoint-expired"),
			Type.Literal("checkpoint-input"),
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

export const CheckpointDecisionSourceSchema = Type.Union([
	Type.Literal("operator"),
	Type.Literal("default"),
]);
export type CheckpointDecisionSource = Static<
	typeof CheckpointDecisionSourceSchema
>;

export const CheckpointTerminalEvidenceSchema = Type.Object(
	{
		kind: Type.Literal("checkpoint"),
		artifactId: WorkflowArtifactIdSchema,
		decisionSha256: Sha256Schema,
		source: CheckpointDecisionSourceSchema,
		decidedBy: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	},
	{ additionalProperties: false },
);
export type CheckpointTerminalEvidence = Static<
	typeof CheckpointTerminalEvidenceSchema
>;

export const TaskExecutionTerminalEvidenceSchema = Type.Union([
	SubagentTerminalEvidenceSchema,
	WorkflowExecutionFailureEvidenceSchema,
	SupportTaskTerminalEvidenceSchema,
	NestedWorkflowTerminalEvidenceSchema,
	CheckpointTerminalEvidenceSchema,
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
				checkpoints: Type.Boolean(),
				serviceProviderStart: Type.Boolean(),
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
	contractRevision: 7,
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
		vmMemoryCeiling: true,
		workspaceBudgetRefusal: true,
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
			dynamicWorkflows: true,
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
			checkpoints: true,
			serviceProviderStart: true,
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
