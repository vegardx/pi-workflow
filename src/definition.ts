import type {
	ContextScope,
	DelegatedTask,
	ExactModelRequest,
	RunLimits,
} from "@vegardx/pi-subagent";
import { Ajv } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import * as addFormatsModule from "ajv-formats";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import {
	JsonSchemaDocumentSchema,
	type ReplayPolicy,
	type TaskDisposition,
	type TaskKey,
	type TaskRef,
	type WorkflowArtifactHandleRef,
	type WorkflowRunId,
} from "./contracts.js";

const addFormats = (addFormatsModule.default ??
	addFormatsModule) as unknown as FormatsPlugin;
const taskHandleBrand: unique symbol = Symbol("pi-workflow-task-handle");
const artifactHandleBrand: unique symbol = Symbol(
	"pi-workflow-artifact-handle",
);

const WorkflowMetaSchema = Type.Object(
	{
		name: Type.String({
			pattern: "^[a-z][a-z0-9-]*$",
			minLength: 1,
			maxLength: 128,
		}),
		description: Type.String({ minLength: 1, maxLength: 1024 }),
		version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	},
	{ additionalProperties: false },
);
export type WorkflowMeta = Static<typeof WorkflowMetaSchema>;

export interface ArtifactHandle<T> {
	readonly ref: WorkflowArtifactHandleRef;
	readonly [artifactHandleBrand]: T;
}

export interface TaskHandle<T> {
	readonly ref: TaskRef;
	readonly output: ArtifactHandle<T>;
	readonly [taskHandleBrand]: T;
}

export function createTaskHandle<T>(
	ref: TaskRef,
	outputRef: WorkflowArtifactHandleRef,
): TaskHandle<T> {
	const output = Object.freeze({
		ref: Object.freeze({ ...outputRef }),
		[artifactHandleBrand]: undefined as T,
	});
	return Object.freeze({
		ref: Object.freeze({ ...ref }),
		output,
		[taskHandleBrand]: undefined as T,
	});
}

export interface AgentTaskAuthoringRequest<TOutputSchema extends TSchema> {
	readonly agent: string;
	readonly task: DelegatedTask;
	readonly contextMode: "fresh";
	readonly model?: ExactModelRequest;
	readonly tools: readonly string[];
	readonly preloadSkills: readonly string[];
	readonly contextScopes: readonly ContextScope[];
	readonly workspace: { readonly mode: "read-only"; readonly cwd: string };
	readonly outputSchema: TOutputSchema;
	readonly limits: RunLimits;
	readonly disposition?: TaskDisposition;
	readonly after?: readonly TaskRef[];
	readonly inputs?: Readonly<Record<TaskKey, ArtifactHandle<unknown>>>;
	readonly replay?: ReplayPolicy;
}

export interface WorkflowContext<TInput> {
	readonly input: TInput;
	readonly runId: WorkflowRunId;
	readonly cwd: string;
	readonly signal: AbortSignal;
	phase(name: string): void;
	log(message: string): void;
	agent<TOutputSchema extends TSchema>(
		key: TaskKey,
		request: AgentTaskAuthoringRequest<TOutputSchema>,
	): TaskHandle<Static<TOutputSchema>>;
	result<T>(task: TaskHandle<T>): Promise<T>;
	results<const T extends readonly TaskHandle<unknown>[]>(
		tasks: T,
	): Promise<{ [K in keyof T]: T[K] extends TaskHandle<infer V> ? V : never }>;
}

export type WorkflowReturn<T> =
	| T
	| TaskHandle<T>
	| ArtifactHandle<T>
	| Promise<T | TaskHandle<T> | ArtifactHandle<T>>;

export interface WorkflowDefinition<TInput = unknown, TOutput = unknown> {
	readonly schema: "pi-workflow-definition";
	readonly meta: WorkflowMeta;
	readonly inputSchema: TSchema;
	readonly outputSchema: TSchema;
	run(ctx: WorkflowContext<TInput>): WorkflowReturn<TOutput>;
}

export interface WorkflowDefinitionOptions<
	TInputSchema extends TSchema,
	TOutputSchema extends TSchema,
> {
	readonly meta: WorkflowMeta;
	readonly inputSchema: TInputSchema;
	readonly outputSchema: TOutputSchema;
	run(
		ctx: WorkflowContext<Static<TInputSchema>>,
	): WorkflowReturn<Static<TOutputSchema>>;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

export function validateJsonSchemaDocument(
	value: unknown,
	label: string,
): TSchema {
	if (!Value.Check(JsonSchemaDocumentSchema, value)) {
		throw new Error(`${label} must be a bounded JSON-serializable schema`);
	}
	const json = JSON.stringify(value);
	if (json === undefined) {
		throw new Error(`${label} must be losslessly JSON-serializable`);
	}
	const cloned = JSON.parse(json) as TSchema;
	if (JSON.stringify(cloned) !== json) {
		throw new Error(`${label} must be losslessly JSON-serializable`);
	}
	try {
		const ajv = new Ajv({ strictSchema: true, validateSchema: true });
		addFormats(ajv);
		if (!ajv.validateSchema(cloned)) {
			throw new Error(ajv.errorsText(ajv.errors));
		}
		ajv.compile(cloned);
	} catch (error) {
		throw new Error(`${label} is not a valid JSON Schema`, { cause: error });
	}
	return deepFreeze(cloned);
}

export function defineWorkflow<
	TInputSchema extends TSchema,
	TOutputSchema extends TSchema,
>(
	options: WorkflowDefinitionOptions<TInputSchema, TOutputSchema>,
): WorkflowDefinition<Static<TInputSchema>, Static<TOutputSchema>> {
	if (!Value.Check(WorkflowMetaSchema, options.meta)) {
		throw new Error("invalid workflow metadata");
	}
	const inputSchema = validateJsonSchemaDocument(
		options.inputSchema,
		"workflow input schema",
	);
	const outputSchema = validateJsonSchemaDocument(
		options.outputSchema,
		"workflow output schema",
	);
	if (typeof options.run !== "function") {
		throw new Error("workflow run must be a function");
	}
	return Object.freeze({
		schema: "pi-workflow-definition" as const,
		meta: Object.freeze({ ...options.meta }),
		inputSchema,
		outputSchema,
		run: options.run,
	});
}

export function isWorkflowDefinition(
	value: unknown,
): value is WorkflowDefinition {
	if (typeof value !== "object" || value === null) return false;
	const definition = value as Partial<WorkflowDefinition>;
	if (
		definition.schema !== "pi-workflow-definition" ||
		!Value.Check(WorkflowMetaSchema, definition.meta) ||
		typeof definition.run !== "function"
	) {
		return false;
	}
	try {
		validateJsonSchemaDocument(definition.inputSchema, "workflow input schema");
		validateJsonSchemaDocument(
			definition.outputSchema,
			"workflow output schema",
		);
		return true;
	} catch {
		return false;
	}
}
