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
import type {
	CheckpointHeadlessPolicy,
	WorkflowHandoffDescriptor,
} from "./contracts.js";
import {
	type AgentRetryClass,
	DEFAULT_WORKFLOW_CONCURRENCY,
	type HandoffPolicy,
	JsonSchemaDocumentSchema,
	MAX_WORKFLOW_CONCURRENCY,
	type ReplayPolicy,
	type TaskDisposition,
	type TaskKey,
	type TaskRef,
	type WorkflowArtifactHandleRef,
	type WorkflowBudget,
	WorkflowBudgetSchema,
	type WorkflowRunId,
	type WorkflowTaskId,
	type WorkflowTaskStatus,
} from "./contracts-core.js";
import type { ModelRoleRequest } from "./runtime/model-routing.js";
import type { SupportTaskDescriptor } from "./support.js";

const addFormats = (addFormatsModule.default ??
	addFormatsModule) as unknown as FormatsPlugin;
const MAX_WORKFLOW_DURATION_MS = 365 * 24 * 60 * 60 * 1_000;
const taskHandleBrand: unique symbol = Symbol("pi-workflow-task-handle");
const artifactHandleBrand: unique symbol = Symbol(
	"pi-workflow-artifact-handle",
);
const handoffHandleBrand: unique symbol = Symbol("pi-workflow-handoff-handle");

export { type WorkflowBudget, WorkflowBudgetSchema };

const WorkflowMetaInputSchema = Type.Object(
	{
		name: Type.String({
			pattern: "^[a-z][a-z0-9-]*$",
			minLength: 1,
			maxLength: 128,
		}),
		description: Type.String({ minLength: 1, maxLength: 1024 }),
		version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		budget: WorkflowBudgetSchema,
		timeoutMs: Type.Integer({
			minimum: 1_000,
			maximum: MAX_WORKFLOW_DURATION_MS,
		}),
		concurrency: Type.Optional(
			Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_CONCURRENCY }),
		),
	},
	{ additionalProperties: false },
);

export const WorkflowMetaSchema = Type.Object(
	{
		...WorkflowMetaInputSchema.properties,
		concurrency: Type.Integer({
			minimum: 1,
			maximum: MAX_WORKFLOW_CONCURRENCY,
		}),
	},
	{ additionalProperties: false },
);
export type WorkflowMetaInput = Static<typeof WorkflowMetaInputSchema>;
export type WorkflowMeta = Static<typeof WorkflowMetaSchema>;

export interface ArtifactHandle<T> {
	readonly ref: WorkflowArtifactHandleRef;
	readonly [artifactHandleBrand]: T;
}

/** The handle reference of a worktree task's handoff artifact. */
export type HandoffHandleRef = WorkflowArtifactHandleRef & {
	readonly output: "handoff";
};

/**
 * Names the workflow-owned handoff artifact of a worktree agent task. It
 * resolves to a `WorkflowHandoffDescriptor`, never to patch bytes.
 */
export interface HandoffHandle {
	readonly ref: HandoffHandleRef;
	readonly [handoffHandleBrand]: true;
}

export interface TaskHandle<T> {
	readonly ref: TaskRef;
	readonly output: ArtifactHandle<T>;
	/** Present only on worktree agent tasks. */
	readonly handoff?: HandoffHandle;
	readonly [taskHandleBrand]: T;
}

export type WorktreeTaskHandle<T> = TaskHandle<T> & {
	readonly handoff: HandoffHandle;
};

export type WorkspaceAuthoringRequest =
	| { readonly mode: "read-only"; readonly cwd: string }
	| { readonly mode: "worktree"; readonly cwd: string };

/**
 * The handle an agent declaration returns: a worktree handle when the request
 * literal names a worktree workspace, otherwise an ordinary task handle. The
 * runtime always decides from the materialized spec; this only types the
 * author's view of it.
 */
export type AgentTaskHandle<
	TOutputSchema extends TSchema,
	TWorkspace extends WorkspaceAuthoringRequest,
> = TWorkspace extends { readonly mode: "worktree" }
	? WorktreeTaskHandle<Static<TOutputSchema>>
	: TaskHandle<Static<TOutputSchema>>;

/** An artifact a task may consume: a result handle or a worktree handoff handle. */
export type TaskInputHandle = ArtifactHandle<unknown> | HandoffHandle;

export function isTaskHandle(value: unknown): value is TaskHandle<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.hasOwn(value, taskHandleBrand)
	);
}

export function isArtifactHandle(
	value: unknown,
): value is ArtifactHandle<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.hasOwn(value, artifactHandleBrand)
	);
}

export function isHandoffHandle(value: unknown): value is HandoffHandle {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.hasOwn(value, handoffHandleBrand)
	);
}

/** Creates a task handle; `handoff` is present iff `handoffRef` is given. */
export function createTaskHandle<T>(
	ref: TaskRef,
	outputRef: WorkflowArtifactHandleRef,
): TaskHandle<T>;
export function createTaskHandle<T>(
	ref: TaskRef,
	outputRef: WorkflowArtifactHandleRef,
	handoffRef: HandoffHandleRef,
): WorktreeTaskHandle<T>;
export function createTaskHandle<T>(
	ref: TaskRef,
	outputRef: WorkflowArtifactHandleRef,
	handoffRef?: HandoffHandleRef,
): TaskHandle<T>;
export function createTaskHandle<T>(
	ref: TaskRef,
	outputRef: WorkflowArtifactHandleRef,
	handoffRef?: HandoffHandleRef,
): TaskHandle<T> {
	const output = Object.freeze({
		ref: Object.freeze({ ...outputRef }),
		[artifactHandleBrand]: undefined as T,
	});
	if (handoffRef === undefined) {
		return Object.freeze({
			ref: Object.freeze({ ...ref }),
			output,
			[taskHandleBrand]: undefined as T,
		});
	}
	const handoff: HandoffHandle = Object.freeze({
		ref: Object.freeze({ ...handoffRef, output: "handoff" as const }),
		[handoffHandleBrand]: true as const,
	});
	return Object.freeze({
		ref: Object.freeze({ ...ref }),
		output,
		handoff,
		[taskHandleBrand]: undefined as T,
	});
}

export interface AgentRetryPolicyRequest {
	readonly attempts: number;
	readonly on?: readonly AgentRetryClass[];
}

export interface AgentResumePolicyRequest {
	readonly attempts: number;
}

export interface AgentTaskAuthoringRequest<
	TOutputSchema extends TSchema,
	TWorkspace extends WorkspaceAuthoringRequest = WorkspaceAuthoringRequest,
> {
	readonly agent: string;
	readonly task: DelegatedTask;
	readonly contextMode: "fresh";
	readonly model?: ExactModelRequest;
	/**
	 * Ask the host's router for a model instead of naming one. Mutually
	 * exclusive with `model`: declaring both fails materialization with
	 * {@link MODEL_ROLE_EXCLUSIVE_MESSAGE}.
	 *
	 * The materializer resolves this to an exact `{ provider, id, thinking }`
	 * **before hashing**, so the materialized `AgentTaskRequestSchema` — and
	 * therefore task identity and pi-subagent's contract — is unchanged: two
	 * definitions differing only in how they asked for a model, but resolving
	 * alike, produce the same task identity. The resolution is persisted with
	 * the task and re-used on every replay (only re-authorized), because
	 * resolution is host-dependent and re-rolling it would change identity
	 * mid-run.
	 *
	 * With no `WorkflowServiceOptions.modelRouting` installed this fails with
	 * {@link MODEL_ROUTING_MISSING_MESSAGE}: the runtime never guesses a model.
	 */
	readonly modelRole?: ModelRoleRequest;
	readonly tools: readonly string[];
	readonly preloadSkills: readonly string[];
	readonly contextScopes: readonly ContextScope[];
	readonly workspace: TWorkspace;
	/**
	 * Guest VM memory grant in bytes: a positive multiple of 64 MiB, at most
	 * 4 GiB, lowered unchanged to pi-subagent. Omitted means the agent
	 * definition's own ceiling. A request above that ceiling is refused by
	 * pi-subagent preflight ("memory request exceeds agent ceiling"), which the
	 * launcher relays unchanged.
	 */
	readonly memoryBytes?: number;
	/**
	 * Worktree tasks only. "required" (default): a completed child must have
	 * captured a handoff. Never sent to pi-subagent.
	 */
	readonly handoff?: HandoffPolicy;
	readonly outputSchema: TOutputSchema;
	readonly limits: RunLimits;
	readonly retry?: AgentRetryPolicyRequest;
	readonly resume?: AgentResumePolicyRequest;
	readonly disposition?: TaskDisposition;
	readonly after?: readonly TaskRef[];
	readonly inputs?: Readonly<Record<TaskKey, TaskInputHandle>>;
	readonly replay?: ReplayPolicy;
}

export interface NestedWorkflowRequest<TInput = unknown> {
	readonly workflow: string;
	readonly input: TInput;
	readonly disposition?: TaskDisposition;
	readonly after?: readonly TaskRef[];
	readonly inputs?: Readonly<Record<TaskKey, TaskInputHandle>>;
	readonly replay?: ReplayPolicy;
}

/**
 * A human decision the run waits for. The decision value is validated against
 * `schema` and becomes the task's JSON result; `default` is required (and
 * validated) for the "use-explicit-default" headless policy. `timeoutMs` is
 * relative to the request and capped by the run deadline. A checkpoint can
 * never be a finalizer.
 */
export interface CheckpointRequest<TDecisionSchema extends TSchema> {
	readonly schema: TDecisionSchema;
	readonly prompt: string;
	readonly default?: Static<TDecisionSchema>;
	readonly headless: CheckpointHeadlessPolicy;
	readonly timeoutMs?: number;
	readonly disposition?: TaskDisposition;
	readonly after?: readonly TaskRef[];
	readonly inputs?: Readonly<Record<TaskKey, TaskInputHandle>>;
	readonly replay?: ReplayPolicy;
}

export type FinalizerKind = "required" | "advisory";

export interface FinalizeRequest<
	TOutputSchema extends TSchema,
	TWorkspace extends WorkspaceAuthoringRequest = WorkspaceAuthoringRequest,
> {
	readonly kind: FinalizerKind;
	readonly support?: SupportTaskDescriptor<TOutputSchema>;
	readonly agent?: AgentTaskAuthoringRequest<TOutputSchema, TWorkspace>;
	readonly workflow?: NestedWorkflowRequest;
}

export type SettledTaskFailure = Readonly<{
	message: string;
	code?: string;
	origin?: string;
	retry?: string;
	guidance?: string;
}>;

export type SettledTaskResult<T> =
	| Readonly<{ status: "fulfilled"; value: T }>
	| Readonly<{
			status: "rejected";
			taskId: WorkflowTaskId;
			outcome: Exclude<
				WorkflowTaskStatus,
				"pending" | "ready" | "running" | "waiting" | "cancelling" | "completed"
			>;
			failure?: SettledTaskFailure;
	  }>;

export interface FanOutOptions<
	TItem,
	TOutputSchema extends TSchema,
	TWorkspace extends WorkspaceAuthoringRequest = WorkspaceAuthoringRequest,
> {
	readonly key: (item: TItem, index: number) => TaskKey;
	readonly task: (
		item: TItem,
		index: number,
	) => AgentTaskAuthoringRequest<TOutputSchema, TWorkspace>;
}

export interface FanInOptions<
	TSource,
	TOutputSchema extends TSchema,
	TWorkspace extends WorkspaceAuthoringRequest = WorkspaceAuthoringRequest,
> {
	readonly inputKey: (source: TaskHandle<TSource>, index: number) => TaskKey;
	readonly task: Omit<
		AgentTaskAuthoringRequest<TOutputSchema, TWorkspace>,
		"inputs"
	>;
}

export interface PipelineStage {
	agent<
		TOutputSchema extends TSchema,
		TWorkspace extends WorkspaceAuthoringRequest = WorkspaceAuthoringRequest,
	>(
		key: TaskKey,
		request: AgentTaskAuthoringRequest<TOutputSchema, TWorkspace>,
	): AgentTaskHandle<TOutputSchema, TWorkspace>;
}

export interface WorkflowContext<TInput> {
	readonly input: TInput;
	readonly runId: WorkflowRunId;
	readonly cwd: string;
	readonly signal: AbortSignal;
	phase(name: string): void;
	log(message: string): void;
	agent<
		TOutputSchema extends TSchema,
		TWorkspace extends WorkspaceAuthoringRequest = WorkspaceAuthoringRequest,
	>(
		key: TaskKey,
		request: AgentTaskAuthoringRequest<TOutputSchema, TWorkspace>,
	): AgentTaskHandle<TOutputSchema, TWorkspace>;
	support<TOutputSchema extends TSchema>(
		key: TaskKey,
		descriptor: SupportTaskDescriptor<TOutputSchema>,
	): TaskHandle<Static<TOutputSchema>>;
	workflow<TOutput = unknown>(
		key: TaskKey,
		request: NestedWorkflowRequest,
	): TaskHandle<TOutput>;
	/**
	 * Declares a checkpoint: the run parks until an operator decides (or the
	 * headless default applies). The handle resolves to the decision and never
	 * carries a handoff.
	 */
	checkpoint<TDecisionSchema extends TSchema>(
		key: TaskKey,
		request: CheckpointRequest<TDecisionSchema>,
	): TaskHandle<Static<TDecisionSchema>>;
	fanOut<
		TItem,
		TOutputSchema extends TSchema,
		TWorkspace extends WorkspaceAuthoringRequest = WorkspaceAuthoringRequest,
	>(
		namespace: TaskKey,
		items: readonly TItem[],
		options: FanOutOptions<TItem, TOutputSchema, TWorkspace>,
	): readonly AgentTaskHandle<TOutputSchema, TWorkspace>[];
	fanIn<
		TSource,
		TOutputSchema extends TSchema,
		TWorkspace extends WorkspaceAuthoringRequest = WorkspaceAuthoringRequest,
	>(
		key: TaskKey,
		sources: readonly TaskHandle<TSource>[],
		options: FanInOptions<TSource, TOutputSchema, TWorkspace>,
	): AgentTaskHandle<TOutputSchema, TWorkspace>;
	pipeline<T>(
		namespace: TaskKey,
		build: (stage: PipelineStage) => TaskHandle<T>,
	): TaskHandle<T>;
	finalize<
		TOutputSchema extends TSchema,
		TWorkspace extends WorkspaceAuthoringRequest = WorkspaceAuthoringRequest,
	>(
		key: TaskKey,
		request: FinalizeRequest<TOutputSchema, TWorkspace>,
	): AgentTaskHandle<TOutputSchema, TWorkspace>;
	result<T>(task: TaskHandle<T>): Promise<T>;
	results<const T extends readonly TaskHandle<unknown>[]>(
		tasks: T,
	): Promise<{ [K in keyof T]: T[K] extends TaskHandle<infer V> ? V : never }>;
	settled<const T extends readonly TaskHandle<unknown>[]>(
		tasks: T,
	): Promise<{
		[K in keyof T]: T[K] extends TaskHandle<infer V>
			? SettledTaskResult<V>
			: never;
	}>;
	/**
	 * Waits for a worktree task (a persisted "result" barrier) and resolves its
	 * handoff descriptor, or `undefined` only when the task's handoff policy is
	 * "optional" and the completed child captured no handoff.
	 */
	handoff<T>(
		task: WorktreeTaskHandle<T>,
	): Promise<WorkflowHandoffDescriptor | undefined>;
}

export type WorkflowReturn<T> =
	| T
	| TaskHandle<T>
	| ArtifactHandle<T>
	| HandoffHandle
	| Promise<T | TaskHandle<T> | ArtifactHandle<T> | HandoffHandle>;

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
	readonly meta: WorkflowMetaInput;
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
	if (!Value.Check(WorkflowMetaInputSchema, options.meta)) {
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
		meta: deepFreeze({
			...options.meta,
			budget: { ...options.meta.budget },
			concurrency: options.meta.concurrency ?? DEFAULT_WORKFLOW_CONCURRENCY,
		}),
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
