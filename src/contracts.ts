import {
	ContextScopeSchema,
	DelegatedTaskSchema,
	ExactModelRequestSchema,
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

export const WORKFLOW_CONTRACT_REVISION = 1 as const;

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
	maximum: Number.MAX_SAFE_INTEGER,
});
export type TaskExecutionGeneration = Static<
	typeof TaskExecutionGenerationSchema
>;

export const SubagentOperationIdSchema = Type.String({
	pattern: "^workflow-op_[a-f0-9]{64}$",
});
export type SubagentOperationId = Static<typeof SubagentOperationIdSchema>;

export const TaskKeySchema = Type.String({
	pattern: "^[a-z][a-z0-9-]*$",
	minLength: 1,
	maxLength: 128,
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

export const WorkflowArtifactHandleRefSchema = Type.Object(
	{
		runId: WorkflowRunIdSchema,
		producerTaskId: WorkflowTaskIdSchema,
		output: Type.Literal("result"),
	},
	{ additionalProperties: false },
);
export type WorkflowArtifactHandleRef = Static<
	typeof WorkflowArtifactHandleRefSchema
>;

export const WorkflowArtifactRefSchema = Type.Object(
	{
		id: Type.String({ pattern: "^artifact_[a-f0-9]{64}$" }),
		runId: WorkflowRunIdSchema,
		producerTaskId: Type.Optional(WorkflowTaskIdSchema),
		output: Type.Optional(Type.Literal("result")),
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
		workspace: Type.Object(
			{
				mode: Type.Literal("read-only"),
				cwd: Type.String({ minLength: 1, maxLength: 4096 }),
			},
			{ additionalProperties: false },
		),
		outputSchema: JsonSchemaDocumentSchema,
		limits: RunLimitsSchema,
	},
	{ additionalProperties: false },
);
export type AgentTaskRequest = Static<typeof AgentTaskRequestSchema>;

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

export const MaterializedAgentTaskSchema = Type.Object(
	{
		id: WorkflowTaskIdSchema,
		runId: WorkflowRunIdSchema,
		namespace: Type.Array(TaskKeySchema, { maxItems: 32 }),
		spec: AgentTaskSpecSchema,
		definitionIdentitySha256: Sha256Schema,
		materializationSequence: Type.Integer({ minimum: 1 }),
		materializationEpoch: Type.Integer({ minimum: 1 }),
		epochPosition: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);
export type MaterializedAgentTask = Static<typeof MaterializedAgentTaskSchema>;

export const TaskExecutionRecordSchema = Type.Object(
	{
		id: TaskExecutionIdSchema,
		runId: WorkflowRunIdSchema,
		taskId: WorkflowTaskIdSchema,
		generation: TaskExecutionGenerationSchema,
		taskIdentitySha256: Sha256Schema,
		operationId: SubagentOperationIdSchema,
	},
	{ additionalProperties: false },
);
export type TaskExecutionRecord = Static<typeof TaskExecutionRecordSchema>;

export const SubagentTerminalEvidenceSchema = Type.Object(
	{
		kind: Type.Literal("subagent"),
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
		]),
		failureSha256: Sha256Schema,
		message: Type.String({ minLength: 1, maxLength: 4096 }),
	},
	{ additionalProperties: false },
);
export type WorkflowExecutionFailureEvidence = Static<
	typeof WorkflowExecutionFailureEvidenceSchema
>;

export const TaskExecutionTerminalEvidenceSchema = Type.Union([
	SubagentTerminalEvidenceSchema,
	WorkflowExecutionFailureEvidenceSchema,
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

export {
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
				pipelines: Type.Boolean(),
				resume: Type.Boolean(),
				replay: Type.Boolean(),
				worktrees: Type.Boolean(),
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
	contractRevision: 4,
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
		retryBackoff: true,
		deepReconciliation: true,
		worktrees: true,
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
			staticWorkflows: false,
			dynamicWorkflows: false,
			durableRuns: false,
			parallel: false,
			pipelines: false,
			resume: false,
			replay: false,
			worktrees: false,
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
