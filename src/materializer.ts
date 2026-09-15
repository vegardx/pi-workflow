import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Ajv } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import * as addFormatsModule from "ajv-formats";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	type AgentTaskRequest,
	AgentTaskRequestSchema,
	type AgentTaskSpec,
	MAX_NESTED_WORKFLOW_TASKS,
	type MaterializedAgentTask,
	MaterializedAgentTaskSchema,
	type MaterializedNestedWorkflowTask,
	MaterializedNestedWorkflowTaskSchema,
	type MaterializedSupportTask,
	MaterializedSupportTaskSchema,
	type MaterializedWorkflowTask,
	type NestedWorkflowTaskRequest,
	NestedWorkflowTaskRequestSchema,
	type NestedWorkflowTaskSpec,
	type ReplayPolicy,
	type SupportTaskRequest,
	SupportTaskRequestSchema,
	type SupportTaskSpec,
	type TaskDisposition,
	type TaskKey,
	TaskKeySchema,
	type TaskRef,
	type TaskRole,
	WORKFLOW_CONTRACT_REVISION,
	type WorkflowArtifactHandleRef,
	type WorkflowRunId,
} from "./contracts.js";
import {
	type AgentTaskAuthoringRequest,
	type AgentTaskHandle,
	createTaskHandle,
	type FinalizerKind,
	type TaskHandle,
	type TaskInputHandle,
	validateJsonSchemaDocument,
	type WorkspaceAuthoringRequest,
} from "./definition.js";
import {
	MAX_WORKFLOW_EVENT_INPUT_BYTES,
	MAX_WORKFLOW_STATE_BYTES,
	type WorkflowBarrierProjection,
	type WorkflowEventInput,
	WorkflowEventInputSchema,
	type WorkflowStateProjection,
	WorkflowStateProjectionSchema,
	type WorkflowTaskProjection,
} from "./events.js";
import { deriveJsonValueSha256 } from "./execution.js";
import type { SupportTaskDescriptor } from "./support.js";

const addFormats = (addFormatsModule.default ??
	addFormatsModule) as unknown as FormatsPlugin;
const MAX_MATERIALIZED_TASKS = 256;
const MAX_MATERIALIZATION_EPOCHS = 4096;

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, child]) => [key, canonicalValue(child)]),
	);
}

function canonicalJson(value: unknown): string {
	const json = JSON.stringify(canonicalValue(value));
	if (json === undefined) throw new Error("materialized value is not JSON");
	return json;
}

function sha256(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function deriveWorkflowTaskId(
	runId: WorkflowRunId,
	namespace: readonly TaskKey[],
	key: TaskKey,
): string {
	return `task_${sha256({ runId, namespaceKey: [...namespace, key].join("\u0000") })}`;
}

export function deriveAgentTaskIdentity(value: {
	readonly definitionIdentitySha256: string;
	readonly inputSha256: string;
	readonly namespace: readonly TaskKey[];
	readonly spec: Omit<AgentTaskSpec, "identitySha256">;
}): string {
	return sha256({
		contractRevision: WORKFLOW_CONTRACT_REVISION,
		definitionIdentitySha256: value.definitionIdentitySha256,
		inputSha256: value.inputSha256,
		namespace: value.namespace,
		...value.spec,
	});
}

export function deriveSupportTaskIdentity(value: {
	readonly definitionIdentitySha256: string;
	readonly inputSha256: string;
	readonly namespace: readonly TaskKey[];
	readonly spec: Omit<SupportTaskSpec, "identitySha256">;
}): string {
	return sha256({
		contractRevision: WORKFLOW_CONTRACT_REVISION,
		definitionIdentitySha256: value.definitionIdentitySha256,
		inputSha256: value.inputSha256,
		namespace: value.namespace,
		...value.spec,
	});
}

export function deriveNestedWorkflowTaskIdentity(value: {
	readonly definitionIdentitySha256: string;
	readonly inputSha256: string;
	readonly namespace: readonly TaskKey[];
	readonly spec: Omit<NestedWorkflowTaskSpec, "identitySha256">;
}): string {
	return sha256({
		contractRevision: WORKFLOW_CONTRACT_REVISION,
		definitionIdentitySha256: value.definitionIdentitySha256,
		inputSha256: value.inputSha256,
		namespace: value.namespace,
		...value.spec,
	});
}

function cloneFrozen<T>(value: T): T {
	const cloned = JSON.parse(canonicalJson(value)) as T;
	const freeze = (entry: unknown): void => {
		if (typeof entry !== "object" || entry === null || Object.isFrozen(entry)) {
			return;
		}
		for (const child of Object.values(entry)) freeze(child);
		Object.freeze(entry);
	};
	freeze(cloned);
	return cloned;
}

export class WorkflowMaterializationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowMaterializationError";
	}
}

export interface WorkflowTaskMaterializerOptions {
	readonly runId: WorkflowRunId;
	readonly definitionIdentitySha256: string;
	readonly inputSha256: string;
	readonly namespace?: readonly TaskKey[];
	readonly previousState?: WorkflowStateProjection;
}

export interface NestedWorkflowDeclaration {
	readonly request: NestedWorkflowTaskRequest;
	readonly disposition?: TaskDisposition;
	readonly after?: readonly TaskRef[];
	readonly inputs?: Readonly<Record<TaskKey, TaskInputHandle>>;
	readonly replay?: ReplayPolicy;
}

export interface FinalizerDeclaration<
	TOutputSchema extends TSchema,
	TWorkspace extends WorkspaceAuthoringRequest = WorkspaceAuthoringRequest,
> {
	readonly kind: FinalizerKind;
	readonly support?: SupportTaskDescriptor<TOutputSchema>;
	readonly agent?: AgentTaskAuthoringRequest<TOutputSchema, TWorkspace>;
	readonly workflow?: NestedWorkflowDeclaration;
}

export interface MaterializationCommit {
	readonly epoch: number;
	readonly events: readonly WorkflowEventInput[];
}

const REMATERIALIZATION_REASON = "Explicit invalidation re-executes the task.";
const FINALIZER_MEMBER_MESSAGE =
	"finalizer requires exactly one of support, agent, or workflow";

function taskNamespaceKey(namespace: readonly TaskKey[], key: TaskKey): string {
	return [...namespace, key].join("\u0000");
}

/** Position fields assigned to the next declaration of the current replay. */
interface DeclarationPosition {
	readonly expected: MaterializedWorkflowTask | undefined;
	readonly materializationSequence: number;
	readonly materializationEpoch: number;
	readonly epochPosition: number;
}

export class WorkflowTaskMaterializer {
	private readonly definitionIdentitySha256: string;
	/** Non-abandoned persisted barriers ordered by epoch, indexed by path position. */
	private readonly expectedBarriers: readonly WorkflowBarrierProjection[];
	/** Non-abandoned persisted tasks ordered by materialization sequence. */
	private readonly expectedTasks: readonly MaterializedWorkflowTask[];
	/** Abandoned persisted tasks by namespace key, awaiting readoption. */
	private readonly abandonedByKey: Map<string, WorkflowTaskProjection>;
	private readonly inputSha256: string;
	private readonly namespace: readonly TaskKey[];
	private readonly runId: WorkflowRunId;
	private readonly seen = new Map<string, MaterializedWorkflowTask>();
	private projectedState: WorkflowStateProjection;
	private readonly replayOnly: boolean;
	private readonly uncommitted: MaterializedWorkflowTask[] = [];
	private readonly controlAfter = new Map<string, TaskRef>();
	/** The epoch number the first epoch beyond the persisted path receives. */
	private readonly nextPathEpoch: number;
	/** Path position of the epoch currently being materialized (0-based). */
	private epochIndex = 0;
	private finalClosed = false;
	/** Highest materialization sequence across every persisted or declared task. */
	private maxSequence: number;
	/** Number of declarations replayed or appended on the current path. */
	private sequence = 0;

	constructor(options: WorkflowTaskMaterializerOptions) {
		this.runId = options.runId;
		this.definitionIdentitySha256 = options.definitionIdentitySha256;
		this.inputSha256 = options.inputSha256;
		this.namespace = Object.freeze([...(options.namespace ?? [])]);
		if (
			!this.definitionIdentitySha256.match(/^[a-f0-9]{64}$/) ||
			!this.inputSha256.match(/^[a-f0-9]{64}$/) ||
			this.namespace.length > 32 ||
			!this.namespace.every((key) => Value.Check(TaskKeySchema, key))
		) {
			throw new WorkflowMaterializationError("invalid materializer identity");
		}
		const previous = options.previousState;
		if (previous?.status === "cancelled") {
			throw new WorkflowMaterializationError(
				"cancelled workflow run may not materialize tasks",
			);
		}
		if (
			previous &&
			(previous.runId !== this.runId ||
				previous.definitionIdentitySha256 !== this.definitionIdentitySha256 ||
				previous.inputSha256 !== this.inputSha256)
		) {
			throw new WorkflowMaterializationError(
				"previous materialization identity does not match",
			);
		}
		this.replayOnly =
			previous?.status === "completed" ||
			previous?.status === "completed-degraded";
		const previousTasks = previous ? Object.values(previous.tasks) : [];
		this.expectedTasks = previousTasks
			.filter((projection) => projection.abandoned !== true)
			.map((projection) => projection.task)
			.sort(
				(left, right) =>
					left.materializationSequence - right.materializationSequence,
			);
		this.abandonedByKey = new Map(
			previousTasks
				.filter((projection) => projection.abandoned === true)
				.map((projection) => [
					taskNamespaceKey(projection.task.namespace, projection.task.spec.key),
					projection,
				]),
		);
		this.maxSequence = previousTasks.reduce(
			(max, projection) =>
				Math.max(max, projection.task.materializationSequence),
			0,
		);
		this.expectedBarriers = (previous?.barriers ?? [])
			.filter((barrier) => barrier.abandoned !== true)
			.sort((left, right) => left.epoch - right.epoch);
		this.nextPathEpoch = previous?.currentEpoch ?? 1;
		this.projectedState = previous
			? structuredClone(previous)
			: {
					runId: this.runId,
					definitionIdentitySha256: this.definitionIdentitySha256,
					inputSha256: this.inputSha256,
					status: "created",
					currentEpoch: 1,
					effects: [],
					lastSequence: 1,
					tasks: {},
					executions: {},
					artifacts: {},
					barriers: [],
				};
	}

	/**
	 * The epoch number at a path position: persisted path epochs keep their
	 * numbers, and epochs beyond the path continue from the projection's
	 * current epoch (after every persisted barrier, abandoned or not).
	 */
	private epochAt(index: number): number {
		return (
			this.expectedBarriers[index]?.epoch ??
			this.nextPathEpoch + (index - this.expectedBarriers.length)
		);
	}

	private nextPosition(): DeclarationPosition {
		const expected = this.expectedTasks[this.sequence];
		const materializationEpoch = this.epochAt(this.epochIndex);
		return {
			expected,
			materializationSequence:
				expected?.materializationSequence ?? this.maxSequence + 1,
			materializationEpoch,
			epochPosition:
				[...this.seen.values()].filter(
					(task) => task.materializationEpoch === materializationEpoch,
				).length + 1,
		};
	}

	private assertUndeclared(namespace: readonly TaskKey[], key: TaskKey): void {
		const namespaceKey = taskNamespaceKey(namespace, key);
		if (
			[...this.seen.values()].some(
				(task) =>
					taskNamespaceKey(task.namespace, task.spec.key) === namespaceKey,
			)
		) {
			throw new WorkflowMaterializationError("duplicate task key in namespace");
		}
	}

	/**
	 * Replays a candidate against the persisted path prefix or, beyond it,
	 * appends a new declaration; a key matching an abandoned task with the
	 * same identity readopts that task onto the current path.
	 */
	private adopt(
		task: MaterializedWorkflowTask,
		expected: MaterializedWorkflowTask | undefined,
	): MaterializedWorkflowTask {
		if (!expected && this.replayOnly) {
			throw new WorkflowMaterializationError(
				"completed workflow materialization may only replay its exact prefix",
			);
		}
		if (expected && !isDeepStrictEqual(task, expected)) {
			throw new WorkflowMaterializationError(
				"task declaration does not match the persisted ordered prefix",
			);
		}
		const selected = expected ?? task;
		if (!expected) {
			const namespaceKey = taskNamespaceKey(task.namespace, task.spec.key);
			const abandoned = this.abandonedByKey.get(namespaceKey);
			if (abandoned) {
				if (abandoned.task.spec.identitySha256 !== task.spec.identitySha256) {
					throw new WorkflowMaterializationError(
						"abandoned task key re-declared with a changed request",
					);
				}
				this.abandonedByKey.delete(namespaceKey);
			}
			this.maxSequence = task.materializationSequence;
			this.uncommitted.push(task);
		}
		this.sequence += 1;
		this.seen.set(selected.id, selected);
		return selected;
	}

	agent<
		TOutputSchema extends TSchema,
		TWorkspace extends WorkspaceAuthoringRequest = WorkspaceAuthoringRequest,
	>(
		key: TaskKey,
		request: AgentTaskAuthoringRequest<TOutputSchema, TWorkspace>,
	): AgentTaskHandle<TOutputSchema, TWorkspace> {
		return this.agentInNamespace(this.namespace, key, request);
	}

	agentInNamespace<
		TOutputSchema extends TSchema,
		TWorkspace extends WorkspaceAuthoringRequest = WorkspaceAuthoringRequest,
	>(
		namespace: readonly TaskKey[],
		key: TaskKey,
		request: AgentTaskAuthoringRequest<TOutputSchema, TWorkspace>,
	): AgentTaskHandle<TOutputSchema, TWorkspace> {
		return this.declareAgent(namespace, key, request, "task");
	}

	support<TOutputSchema extends TSchema>(
		key: TaskKey,
		descriptor: SupportTaskDescriptor<TOutputSchema>,
	): TaskHandle<Static<TOutputSchema>> {
		return this.declareSupport(key, descriptor, "task");
	}

	workflow<TOutput = unknown>(
		key: TaskKey,
		declaration: NestedWorkflowDeclaration,
	): TaskHandle<TOutput> {
		return this.declareWorkflow<TOutput>(key, declaration, "task");
	}

	/**
	 * Declares a finalizer: a task the runtime drives itself while the run is
	 * finalizing. Its kind lowers to the task disposition (required -> required,
	 * advisory -> optional); everything else follows the ordinary declaration path.
	 */
	finalizer<
		TOutputSchema extends TSchema,
		TWorkspace extends WorkspaceAuthoringRequest = WorkspaceAuthoringRequest,
	>(
		key: TaskKey,
		declaration: FinalizerDeclaration<TOutputSchema, TWorkspace>,
	): AgentTaskHandle<TOutputSchema, TWorkspace> {
		if (declaration.kind !== "required" && declaration.kind !== "advisory") {
			throw new WorkflowMaterializationError("invalid finalizer kind");
		}
		const { support, agent, workflow } = declaration;
		const members = [support, agent, workflow].filter(
			(member) => member !== undefined,
		);
		if (members.length !== 1) {
			throw new WorkflowMaterializationError(FINALIZER_MEMBER_MESSAGE);
		}
		const inner: unknown = members[0];
		if (
			typeof inner === "object" &&
			inner !== null &&
			Object.hasOwn(inner, "disposition")
		) {
			throw new WorkflowMaterializationError(
				"finalizer disposition is its kind",
			);
		}
		const disposition: TaskDisposition =
			declaration.kind === "required" ? "required" : "optional";
		if (support !== undefined) {
			return this.declareSupport(
				key,
				{ ...support, disposition },
				"finalizer",
			) as AgentTaskHandle<TOutputSchema, TWorkspace>;
		}
		if (agent !== undefined) {
			return this.declareAgent(
				this.namespace,
				key,
				{ ...agent, disposition },
				"finalizer",
			);
		}
		if (workflow === undefined) {
			throw new WorkflowMaterializationError(FINALIZER_MEMBER_MESSAGE);
		}
		return this.declareWorkflow<Static<TOutputSchema>>(
			key,
			{ ...workflow, disposition },
			"finalizer",
		) as AgentTaskHandle<TOutputSchema, TWorkspace>;
	}

	/** Ordinary tasks may only depend on ordinary tasks; finalizers may depend on either role. */
	private assertRoleDependencies(
		role: TaskRole,
		after: ReadonlyMap<string, TaskRef>,
	): void {
		if (role !== "task") return;
		for (const taskId of after.keys()) {
			if (this.seen.get(taskId)?.spec.role === "finalizer") {
				throw new WorkflowMaterializationError(
					"ordinary task may not depend on a finalizer",
				);
			}
		}
	}

	private declareAgent<
		TOutputSchema extends TSchema,
		TWorkspace extends WorkspaceAuthoringRequest,
	>(
		namespace: readonly TaskKey[],
		key: TaskKey,
		request: AgentTaskAuthoringRequest<TOutputSchema, TWorkspace>,
		role: TaskRole,
	): AgentTaskHandle<TOutputSchema, TWorkspace> {
		if (
			namespace.length > 32 ||
			namespace.some((entry) => !Value.Check(TaskKeySchema, entry))
		) {
			throw new WorkflowMaterializationError("invalid task namespace");
		}
		if (this.finalClosed) {
			throw new WorkflowMaterializationError(
				"task declaration follows the final materialization barrier",
			);
		}
		if (this.sequence >= MAX_MATERIALIZED_TASKS) {
			throw new WorkflowMaterializationError("workflow task limit exceeded");
		}
		if (!Value.Check(TaskKeySchema, key)) {
			throw new WorkflowMaterializationError("invalid task key");
		}
		this.assertUndeclared(namespace, key);
		const after = new Map<string, TaskRef>(this.controlAfter);
		for (const dependency of request.after ?? []) {
			if (
				dependency.runId !== this.runId ||
				!this.seen.has(dependency.taskId)
			) {
				throw new WorkflowMaterializationError(
					"task order dependency is unknown or belongs to another run",
				);
			}
			after.set(dependency.taskId, dependency);
		}
		const inputs = this.resolveInputs(after, request.inputs);
		this.assertRoleDependencies(role, after);
		const outputSchema = validateJsonSchemaDocument(
			request.outputSchema,
			"agent task output schema",
		);
		const workspace: WorkspaceAuthoringRequest = request.workspace;
		const agentRequest: AgentTaskRequest = {
			agent: request.agent,
			task: request.task,
			contextMode: request.contextMode,
			...(request.model === undefined ? {} : { model: request.model }),
			tools: [...request.tools],
			preloadSkills: [...request.preloadSkills],
			contextScopes: [...request.contextScopes],
			workspace,
			// The policy is workflow-only: persisted for worktree requests
			// (defaulting to "required"), absent for read-only requests, and
			// never lowered to pi-subagent.
			...(workspace.mode === "worktree"
				? { handoff: request.handoff ?? "required" }
				: {}),
			outputSchema: outputSchema as AgentTaskRequest["outputSchema"],
			limits: request.limits,
			...(request.retry === undefined
				? {}
				: {
						retry: {
							attempts: request.retry.attempts,
							on: [...(request.retry.on ?? ["backoff"])].sort(),
						},
					}),
			...(request.resume === undefined
				? {}
				: { resume: { attempts: request.resume.attempts } }),
		};
		if (!Value.Check(AgentTaskRequestSchema, agentRequest)) {
			throw new WorkflowMaterializationError("invalid agent task request");
		}
		if (
			request.handoff !== undefined &&
			agentRequest.workspace.mode !== "worktree"
		) {
			throw new WorkflowMaterializationError(
				"handoff policy requires a worktree workspace",
			);
		}
		if (
			agentRequest.workspace.mode === "worktree" &&
			agentRequest.limits.workspaceWriteBytes < 1
		) {
			throw new WorkflowMaterializationError(
				"worktree workspace requires a positive workspaceWriteBytes limit",
			);
		}
		if (
			agentRequest.retry !== undefined &&
			agentRequest.retry.attempts > agentRequest.limits.retries
		) {
			throw new WorkflowMaterializationError(
				"agent retry policy exceeds the declared retry limit",
			);
		}
		if (
			agentRequest.resume !== undefined &&
			agentRequest.resume.attempts > agentRequest.limits.resumes
		) {
			throw new WorkflowMaterializationError(
				"agent resume policy exceeds the declared resume limit",
			);
		}
		const orderedAfter = [...after.values()].sort((left, right) =>
			left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0,
		);
		const specWithoutIdentity: Omit<AgentTaskSpec, "identitySha256"> = {
			key,
			kind: "agent",
			role,
			disposition: request.disposition ?? "required",
			after: orderedAfter,
			inputs,
			replay: request.replay ?? "read-only",
			request: agentRequest,
		};
		const spec: AgentTaskSpec = {
			key,
			kind: "agent",
			role,
			disposition: request.disposition ?? "required",
			after: orderedAfter,
			inputs,
			replay: request.replay ?? "read-only",
			request: agentRequest,
			identitySha256: deriveAgentTaskIdentity({
				definitionIdentitySha256: this.definitionIdentitySha256,
				inputSha256: this.inputSha256,
				namespace,
				spec: specWithoutIdentity,
			}),
		};
		const id = deriveWorkflowTaskId(this.runId, namespace, key);
		const { expected, ...position } = this.nextPosition();
		const task = cloneFrozen({
			id,
			runId: this.runId,
			namespace,
			spec,
			definitionIdentitySha256: this.definitionIdentitySha256,
			...position,
		}) as MaterializedAgentTask;
		if (!Value.Check(MaterializedAgentTaskSchema, task)) {
			throw new WorkflowMaterializationError("invalid materialized agent task");
		}
		const selected = this.adopt(task, expected);
		const taskRef: TaskRef = { runId: this.runId, taskId: selected.id };
		const outputRef: WorkflowArtifactHandleRef = {
			runId: this.runId,
			producerTaskId: selected.id,
			output: "result",
		};
		// The handoff handle follows the materialized spec, not the request
		// literal: only worktree agent tasks own a handoff artifact.
		const handle =
			selected.spec.kind === "agent" &&
			selected.spec.request.workspace.mode === "worktree"
				? createTaskHandle<Static<TOutputSchema>>(taskRef, outputRef, {
						runId: this.runId,
						producerTaskId: selected.id,
						output: "handoff",
					})
				: createTaskHandle<Static<TOutputSchema>>(taskRef, outputRef);
		return handle as AgentTaskHandle<TOutputSchema, TWorkspace>;
	}

	private declareSupport<TOutputSchema extends TSchema>(
		key: TaskKey,
		descriptor: SupportTaskDescriptor<TOutputSchema>,
		role: TaskRole,
	): TaskHandle<Static<TOutputSchema>> {
		if (this.finalClosed) {
			throw new WorkflowMaterializationError(
				"task declaration follows the final materialization barrier",
			);
		}
		if (this.sequence >= MAX_MATERIALIZED_TASKS) {
			throw new WorkflowMaterializationError("workflow task limit exceeded");
		}
		if (!Value.Check(TaskKeySchema, key)) {
			throw new WorkflowMaterializationError("invalid task key");
		}
		this.assertUndeclared(this.namespace, key);
		if (descriptor.schema !== "pi-workflow-support-task-descriptor") {
			throw new WorkflowMaterializationError("invalid support task descriptor");
		}
		const after = new Map<string, TaskRef>(this.controlAfter);
		for (const dependency of descriptor.after ?? []) {
			if (
				dependency.runId !== this.runId ||
				!this.seen.has(dependency.taskId)
			) {
				throw new WorkflowMaterializationError(
					"task order dependency is unknown or belongs to another run",
				);
			}
			after.set(dependency.taskId, dependency);
		}
		const inputs = this.resolveInputs(after, descriptor.inputs);
		this.assertRoleDependencies(role, after);
		const parametersSchema = validateJsonSchemaDocument(
			descriptor.parametersSchema,
			"support task parameters schema",
		);
		const outputSchema = validateJsonSchemaDocument(
			descriptor.outputSchema,
			"support task output schema",
		);
		const request: SupportTaskRequest = {
			implementation: {
				name: descriptor.implementation,
				moduleSpecifier: descriptor.moduleSpecifier,
				revision: descriptor.revision,
				implementationSha256: descriptor.implementationSha256,
				parametersSchema:
					parametersSchema as SupportTaskRequest["implementation"]["parametersSchema"],
				outputSchema:
					outputSchema as SupportTaskRequest["implementation"]["outputSchema"],
			},
			parameters: descriptor.parameters,
		};
		if (!Value.Check(SupportTaskRequestSchema, request)) {
			throw new WorkflowMaterializationError("invalid support task request");
		}
		const ajv = new Ajv({
			allErrors: true,
			strict: true,
			validateSchema: true,
		});
		addFormats(ajv);
		if (!ajv.validate(parametersSchema, request.parameters)) {
			throw new WorkflowMaterializationError(
				"support task parameters do not match their schema",
			);
		}
		const orderedAfter = [...after.values()].sort((left, right) =>
			left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0,
		);
		const specWithoutIdentity: Omit<SupportTaskSpec, "identitySha256"> = {
			key,
			kind: "support",
			role,
			disposition: descriptor.disposition ?? "required",
			after: orderedAfter,
			inputs,
			replay: descriptor.replay ?? "read-only",
			request,
		};
		const spec: SupportTaskSpec = {
			...specWithoutIdentity,
			identitySha256: deriveSupportTaskIdentity({
				definitionIdentitySha256: this.definitionIdentitySha256,
				inputSha256: this.inputSha256,
				namespace: this.namespace,
				spec: specWithoutIdentity,
			}),
		};
		const id = deriveWorkflowTaskId(this.runId, this.namespace, key);
		const { expected, ...position } = this.nextPosition();
		const task = cloneFrozen({
			id,
			runId: this.runId,
			namespace: this.namespace,
			spec,
			definitionIdentitySha256: this.definitionIdentitySha256,
			...position,
		}) as MaterializedSupportTask;
		if (!Value.Check(MaterializedSupportTaskSchema, task)) {
			throw new WorkflowMaterializationError(
				"invalid materialized support task",
			);
		}
		const selected = this.adopt(task, expected);
		return createTaskHandle<Static<TOutputSchema>>(
			{ runId: this.runId, taskId: selected.id },
			{
				runId: this.runId,
				producerTaskId: selected.id,
				output: "result",
			},
		);
	}

	private declareWorkflow<TOutput = unknown>(
		key: TaskKey,
		declaration: NestedWorkflowDeclaration,
		role: TaskRole,
	): TaskHandle<TOutput> {
		if (this.finalClosed) {
			throw new WorkflowMaterializationError(
				"task declaration follows the final materialization barrier",
			);
		}
		if (this.sequence >= MAX_MATERIALIZED_TASKS) {
			throw new WorkflowMaterializationError("workflow task limit exceeded");
		}
		if (!Value.Check(TaskKeySchema, key)) {
			throw new WorkflowMaterializationError("invalid task key");
		}
		this.assertUndeclared(this.namespace, key);
		const after = new Map<string, TaskRef>(this.controlAfter);
		for (const dependency of declaration.after ?? []) {
			if (
				dependency.runId !== this.runId ||
				!this.seen.has(dependency.taskId)
			) {
				throw new WorkflowMaterializationError(
					"task order dependency is unknown or belongs to another run",
				);
			}
			after.set(dependency.taskId, dependency);
		}
		const inputs = this.resolveInputs(after, declaration.inputs);
		this.assertRoleDependencies(role, after);
		const request = declaration.request;
		if (!Value.Check(NestedWorkflowTaskRequestSchema, request)) {
			throw new WorkflowMaterializationError(
				"invalid nested workflow task request",
			);
		}
		if (request.inputSha256 !== deriveJsonValueSha256(request.input)) {
			throw new WorkflowMaterializationError(
				"nested workflow request input digest does not match its input",
			);
		}
		const declaredWorkflows = [...this.seen.values()].filter(
			(task) => task.spec.kind === "workflow",
		).length;
		if (declaredWorkflows >= MAX_NESTED_WORKFLOW_TASKS) {
			throw new WorkflowMaterializationError(
				"nested workflow task bound exceeded",
			);
		}
		const orderedAfter = [...after.values()].sort((left, right) =>
			left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0,
		);
		const specWithoutIdentity: Omit<NestedWorkflowTaskSpec, "identitySha256"> =
			{
				key,
				kind: "workflow",
				role,
				disposition: declaration.disposition ?? "required",
				after: orderedAfter,
				inputs,
				replay: declaration.replay ?? "read-only",
				request,
			};
		const spec: NestedWorkflowTaskSpec = {
			...specWithoutIdentity,
			identitySha256: deriveNestedWorkflowTaskIdentity({
				definitionIdentitySha256: this.definitionIdentitySha256,
				inputSha256: this.inputSha256,
				namespace: this.namespace,
				spec: specWithoutIdentity,
			}),
		};
		const id = deriveWorkflowTaskId(this.runId, this.namespace, key);
		const { expected, ...position } = this.nextPosition();
		const task = cloneFrozen({
			id,
			runId: this.runId,
			namespace: this.namespace,
			spec,
			definitionIdentitySha256: this.definitionIdentitySha256,
			...position,
		}) as MaterializedNestedWorkflowTask;
		if (!Value.Check(MaterializedNestedWorkflowTaskSchema, task)) {
			throw new WorkflowMaterializationError(
				"invalid materialized nested workflow task",
			);
		}
		const selected = this.adopt(task, expected);
		return createTaskHandle<TOutput>(
			{ runId: this.runId, taskId: selected.id },
			{
				runId: this.runId,
				producerTaskId: selected.id,
				output: "result",
			},
		);
	}

	private resolveInputs(
		after: Map<string, TaskRef>,
		inputs: Readonly<Record<TaskKey, TaskInputHandle>> | undefined,
	): Record<TaskKey, WorkflowArtifactHandleRef> {
		return Object.fromEntries(
			Object.entries(inputs ?? {})
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([name, handle]) => {
					const ref = handle.ref;
					const producer = this.seen.get(ref.producerTaskId);
					if (
						!Value.Check(TaskKeySchema, name) ||
						ref.runId !== this.runId ||
						producer === undefined
					) {
						throw new WorkflowMaterializationError(
							"task data dependency is invalid, unknown, or belongs to another run",
						);
					}
					if (
						ref.output === "handoff" &&
						(producer.spec.kind !== "agent" ||
							producer.spec.request.workspace.mode !== "worktree")
					) {
						throw new WorkflowMaterializationError(
							"handoff input producer is not a worktree agent task",
						);
					}
					after.set(ref.producerTaskId, {
						runId: this.runId,
						taskId: ref.producerTaskId,
					});
					return [name, ref];
				}),
		);
	}

	/** Re-materialization events for invalidated tasks in materialization order. */
	private rematerializationEvents(
		projected: WorkflowStateProjection,
		tasks: readonly MaterializedWorkflowTask[],
	): WorkflowEventInput[] {
		return tasks
			.filter((task) => projected.tasks[task.id]?.status === "invalidated")
			.map((task) => ({
				type: "task-status-changed",
				data: {
					taskId: task.id,
					from: "invalidated",
					to: "pending",
					reason: REMATERIALIZATION_REASON,
				},
			}));
	}

	closeEpoch(
		kind: "result" | "results" | "settled" | "final",
		tasks: readonly TaskHandle<unknown>[],
	): MaterializationCommit {
		if (this.finalClosed) {
			throw new WorkflowMaterializationError(
				"materialization barrier follows the final barrier",
			);
		}
		const epoch = this.epochAt(this.epochIndex);
		if (epoch > MAX_MATERIALIZATION_EPOCHS) {
			throw new WorkflowMaterializationError(
				"workflow materialization epoch limit exceeded",
			);
		}
		const taskIds = tasks.map((task) => task.ref.taskId);
		if (
			new Set(taskIds).size !== taskIds.length ||
			tasks.some(
				(task) =>
					task.ref.runId !== this.runId || !this.seen.has(task.ref.taskId),
			)
		) {
			throw new WorkflowMaterializationError(
				"materialization barrier contains an invalid task handle",
			);
		}
		if (
			taskIds.some((taskId) => this.seen.get(taskId)?.spec.role === "finalizer")
		) {
			throw new WorkflowMaterializationError(
				"a finalizer cannot be a barrier target",
			);
		}
		// Every persisted path task of this epoch precedes the barrier that
		// closes it; the unreplayed remainder of the prefix must not hold any.
		const unreplayed = this.expectedTasks
			.slice(this.sequence)
			.some((task) => task.materializationEpoch === epoch);
		if (unreplayed) {
			throw new WorkflowMaterializationError(
				"barrier omits declarations from the persisted epoch prefix",
			);
		}
		const expected = this.expectedBarriers[this.epochIndex];
		if (expected) {
			if (
				expected.kind !== kind ||
				!isDeepStrictEqual(expected.taskIds, taskIds)
			) {
				throw new WorkflowMaterializationError(
					"barrier does not match the persisted ordered epoch",
				);
			}
			if (this.uncommitted.length > 0) {
				throw new WorkflowMaterializationError(
					"cannot extend an already committed materialization epoch",
				);
			}
			const projected = structuredClone(this.projectedState);
			const events = this.rematerializationEvents(
				projected,
				this.expectedTasks.filter(
					(task) => task.materializationEpoch === expected.epoch,
				),
			);
			for (const event of events) {
				if (event.type !== "task-status-changed") continue;
				const task = projected.tasks[event.data.taskId];
				if (task) task.status = "pending";
			}
			projected.lastSequence += events.length;
			this.projectedState = projected;
			if (taskIds.length > 0) {
				this.controlAfter.clear();
				for (const taskId of taskIds) {
					this.controlAfter.set(taskId, { runId: this.runId, taskId });
				}
			}
			if (kind === "final") this.finalClosed = true;
			this.epochIndex += 1;
			return Object.freeze({
				epoch: expected.epoch,
				events: Object.freeze(events.map((event) => cloneFrozen(event))),
			});
		}
		if (this.epochIndex < this.expectedBarriers.length) {
			throw new WorkflowMaterializationError(
				"materialization barrier removed from persisted prefix",
			);
		}
		if (this.replayOnly) {
			throw new WorkflowMaterializationError(
				"completed workflow materialization may not append a barrier",
			);
		}
		const events: WorkflowEventInput[] = this.uncommitted.map((task) => ({
			type: "task-declared",
			data: { task },
		}));
		events.push({
			type: "barrier-reached",
			data: { epoch, kind, taskIds },
		});
		if (
			events.some(
				(event) =>
					!Value.Check(WorkflowEventInputSchema, event) ||
					Buffer.byteLength(canonicalJson(event)) >
						MAX_WORKFLOW_EVENT_INPUT_BYTES,
			)
		) {
			throw new WorkflowMaterializationError(
				"materialized epoch exceeds event schema or persistence bounds",
			);
		}
		const projected = structuredClone(this.projectedState);
		if (projected.currentEpoch !== epoch) {
			throw new WorkflowMaterializationError(
				"persisted projection epoch does not match materialization replay",
			);
		}
		for (const task of this.uncommitted) {
			const readopted = projected.tasks[task.id];
			if (readopted) {
				// Readoption re-declares an abandoned task with fresh position
				// fields; its status, commitment, and execution are retained.
				readopted.task = structuredClone(task);
				delete readopted.abandoned;
				continue;
			}
			projected.tasks[task.id] = {
				task: structuredClone(task),
				status: "pending",
				committed: false,
			};
		}
		if (
			!Value.Check(WorkflowStateProjectionSchema, projected) ||
			Buffer.byteLength(canonicalJson(projected)) > MAX_WORKFLOW_STATE_BYTES
		) {
			throw new WorkflowMaterializationError(
				"materialized epoch declaration prefix exceeds durable state bounds",
			);
		}
		for (const task of Object.values(projected.tasks)) {
			if (task.task.materializationEpoch === epoch) {
				task.committed = true;
			}
		}
		projected.lastSequence += events.length;
		projected.barriers.push({
			epoch,
			kind,
			taskIds: [...taskIds],
			sequence: projected.lastSequence,
		});
		projected.currentEpoch += 1;
		// Re-materialize from the projected epoch rather than from this drive's
		// declarations: a crash after a readopted declaration but before its
		// barrier leaves that task persisted, on-path, and still invalidated.
		const rematerialized = this.rematerializationEvents(
			projected,
			Object.values(projected.tasks)
				.filter((task) => task.task.materializationEpoch === epoch)
				.map((task) => task.task)
				.sort((left, right) => left.epochPosition - right.epochPosition),
		);
		for (const event of rematerialized) {
			if (event.type !== "task-status-changed") continue;
			const task = projected.tasks[event.data.taskId];
			if (task) task.status = "pending";
		}
		projected.lastSequence += rematerialized.length;
		events.push(...rematerialized);
		if (
			!Value.Check(WorkflowStateProjectionSchema, projected) ||
			Buffer.byteLength(canonicalJson(projected)) > MAX_WORKFLOW_STATE_BYTES
		) {
			throw new WorkflowMaterializationError(
				"materialized epoch exceeds durable state bounds",
			);
		}
		this.projectedState = projected;
		if (taskIds.length > 0) {
			this.controlAfter.clear();
			for (const taskId of taskIds) {
				this.controlAfter.set(taskId, { runId: this.runId, taskId });
			}
		}
		if (kind === "final") this.finalClosed = true;
		this.uncommitted.length = 0;
		this.epochIndex += 1;
		return Object.freeze({
			epoch,
			events: Object.freeze(events.map((event) => cloneFrozen(event))),
		});
	}
}
