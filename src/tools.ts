import { type Static, type TSchema, Type } from "typebox";
import {
	MAX_NESTED_WORKFLOW_DEPTH,
	MAX_TASK_EXECUTION_GENERATIONS,
	MAX_WORKFLOW_CONCURRENCY,
	NestedWorkflowInputArtifactsSchema,
	TaskKeySchema,
	WorkflowArtifactIdSchema,
	WorkflowBudgetSchema,
	WorkflowDefinitionNameSchema,
	WorkflowRunIdSchema,
	WorkflowRunStatusSchema,
	WorkflowTaskIdSchema,
	WorkflowTaskStatusSchema,
} from "./contracts.js";
import type { WorkflowService } from "./service.js";

export type WorkflowToolName =
	| "workflow_list"
	| "workflow_validate"
	| "workflow_run"
	| "workflow_status"
	| "workflow_wait"
	| "workflow_stop"
	| "workflow_reconcile";

type DeepReadonly<T> = T extends readonly (infer U)[]
	? readonly DeepReadonly<U>[]
	: T extends object
		? { readonly [K in keyof T]: DeepReadonly<T[K]> }
		: T;

/** The service value a tool returns; it validates against the declared output schema. */
export type WorkflowToolOutput<TOutput extends TSchema> = DeepReadonly<
	Static<TOutput>
>;

export interface WorkflowToolDeclaration<
	TParams extends TSchema = TSchema,
	TOutput extends TSchema = TSchema,
> {
	readonly name: WorkflowToolName;
	readonly label: string;
	readonly description: string;
	readonly promptSnippet?: string;
	readonly promptGuidelines: readonly string[];
	readonly parameters: TParams;
	readonly output: TOutput;
	execute(
		service: WorkflowService,
		params: Static<TParams>,
	): Promise<WorkflowToolOutput<TOutput>>;
}

const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const TimestampSchema = Type.String({ format: "date-time" });

export const WorkflowRootScopeSchema = Type.Union([
	Type.Literal("project"),
	Type.Literal("global"),
	Type.Literal("package"),
	Type.Literal("builtin"),
]);

export const WorkflowDefinitionSummarySchema = Type.Object(
	{
		name: WorkflowDefinitionNameSchema,
		description: Type.String({ minLength: 1, maxLength: 1024 }),
		version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		concurrency: Type.Integer({
			minimum: 1,
			maximum: MAX_WORKFLOW_CONCURRENCY,
		}),
		budget: WorkflowBudgetSchema,
		timeoutMs: Type.Integer({
			minimum: 1_000,
			maximum: Number.MAX_SAFE_INTEGER,
		}),
		scope: WorkflowRootScopeSchema,
		source: Type.String({ minLength: 1, maxLength: 1024 }),
		path: Type.String({ minLength: 1, maxLength: 4096 }),
		identitySha256: Sha256Schema,
	},
	{ additionalProperties: false },
);

/** Discovery loads at most 256 definitions. */
export const WorkflowDefinitionSummaryListSchema = Type.Array(
	WorkflowDefinitionSummarySchema,
	{ maxItems: 256 },
);

export const WorkflowValidationResultSchema = Type.Object(
	{
		valid: Type.Literal(true),
		workflow: WorkflowDefinitionSummarySchema,
	},
	{ additionalProperties: false },
);

export const WorkflowServiceRunReceiptSchema = Type.Object(
	{
		runId: WorkflowRunIdSchema,
		status: WorkflowRunStatusSchema,
	},
	{ additionalProperties: false },
);

export const WorkflowServiceTaskViewSchema = Type.Object(
	{
		id: WorkflowTaskIdSchema,
		namespace: Type.Array(TaskKeySchema, { maxItems: 32 }),
		key: TaskKeySchema,
		kind: Type.Union([
			Type.Literal("agent"),
			Type.Literal("support"),
			Type.Literal("workflow"),
		]),
		status: WorkflowTaskStatusSchema,
		/** Generation of the task's current execution; 0 when it has none. */
		generation: Type.Integer({
			minimum: 0,
			maximum: MAX_TASK_EXECUTION_GENERATIONS,
		}),
		abandoned: Type.Optional(Type.Literal(true)),
	},
	{ additionalProperties: false },
);

export const WorkflowServiceRunViewSchema = Type.Object(
	{
		runId: WorkflowRunIdSchema,
		status: WorkflowRunStatusSchema,
		definitionName: WorkflowDefinitionNameSchema,
		createdAt: TimestampSchema,
		deadlineAt: TimestampSchema,
		depth: Type.Integer({ minimum: 0, maximum: MAX_NESTED_WORKFLOW_DEPTH - 1 }),
		parent: Type.Optional(
			Type.Object(
				{
					runId: WorkflowRunIdSchema,
					taskId: WorkflowTaskIdSchema,
					inputArtifacts: NestedWorkflowInputArtifactsSchema,
				},
				{ additionalProperties: false },
			),
		),
		output: Type.Optional(Type.Unknown()),
		outputArtifactId: Type.Optional(WorkflowArtifactIdSchema),
		/** Every declared task in materialization order; absent until events exist. */
		tasks: Type.Optional(
			Type.Array(WorkflowServiceTaskViewSchema, { maxItems: 256 }),
		),
	},
	{ additionalProperties: false },
);

const WorkflowRefSchema = Type.String({ minLength: 1, maxLength: 4096 });
const RunIdParameterSchema = Type.String({ pattern: "^workflow_[a-z0-9]+$" });
const RunParametersSchema = Type.Object(
	{ runId: RunIdParameterSchema },
	{ additionalProperties: false },
);

function declare<TParams extends TSchema, TOutput extends TSchema>(
	declaration: WorkflowToolDeclaration<TParams, TOutput>,
): WorkflowToolDeclaration<TParams, TOutput> {
	return Object.freeze({
		...declaration,
		promptGuidelines: Object.freeze([...declaration.promptGuidelines]),
	});
}

export const WORKFLOW_TOOL_DECLARATIONS: readonly WorkflowToolDeclaration[] =
	Object.freeze([
		declare({
			name: "workflow_list",
			label: "List Workflows",
			description:
				"List trusted static workflows available in the current project context.",
			promptSnippet: "List trusted durable workflows",
			promptGuidelines: [
				"Use workflow_list before workflow_run when the available workflow name is unknown.",
			],
			parameters: Type.Object({}, { additionalProperties: false }),
			output: WorkflowDefinitionSummaryListSchema,
			execute(service) {
				return service.list();
			},
		}),
		declare({
			name: "workflow_validate",
			label: "Validate Workflow",
			description:
				"Validate a trusted static workflow reference and optionally its JSON input without creating a run.",
			promptGuidelines: [],
			parameters: Type.Object(
				{
					ref: WorkflowRefSchema,
					input: Type.Optional(Type.Unknown()),
				},
				{ additionalProperties: false },
			),
			output: WorkflowValidationResultSchema,
			execute(service, params) {
				return params.input === undefined
					? service.validate(params.ref)
					: service.validate(params.ref, params.input);
			},
		}),
		declare({
			name: "workflow_run",
			label: "Run Workflow",
			description:
				"Start a trusted durable static workflow. Returns a run ID immediately; use workflow_wait or workflow_status to observe it.",
			promptGuidelines: [],
			parameters: Type.Object(
				{
					ref: WorkflowRefSchema,
					input: Type.Unknown(),
				},
				{ additionalProperties: false },
			),
			output: WorkflowServiceRunReceiptSchema,
			execute(service, params) {
				return service.run(params.ref, params.input);
			},
		}),
		declare({
			name: "workflow_status",
			label: "Workflow Status",
			description: "Read durable status for a workflow run.",
			promptGuidelines: [],
			parameters: RunParametersSchema,
			output: WorkflowServiceRunViewSchema,
			execute(service, params) {
				return service.status(params.runId);
			},
		}),
		declare({
			name: "workflow_wait",
			label: "Wait for Workflow",
			description:
				"Wait for an active workflow run and return its durable terminal status and bounded output.",
			promptGuidelines: [],
			parameters: RunParametersSchema,
			output: WorkflowServiceRunViewSchema,
			execute(service, params) {
				return service.wait(params.runId);
			},
		}),
		declare({
			name: "workflow_stop",
			label: "Stop Workflow",
			description:
				"Persist stop intent, interrupt active delegated work, and drain durable terminal evidence.",
			promptGuidelines: [],
			parameters: Type.Object(
				{
					runId: RunIdParameterSchema,
					reason: Type.String({ minLength: 1, maxLength: 4096 }),
				},
				{ additionalProperties: false },
			),
			output: WorkflowServiceRunViewSchema,
			execute(service, params) {
				return service.stop(params.runId, params.reason);
			},
		}),
		declare({
			name: "workflow_reconcile",
			label: "Reconcile Workflow",
			description:
				"Reopen and reconcile a durable workflow run after restart or interruption.",
			promptGuidelines: [],
			parameters: RunParametersSchema,
			output: WorkflowServiceRunViewSchema,
			execute(service, params) {
				return service.reconcile(params.runId);
			},
		}),
	]);
