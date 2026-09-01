import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	type AgentTaskRequest,
	AgentTaskRequestSchema,
	type AgentTaskSpec,
	type MaterializedAgentTask,
	MaterializedAgentTaskSchema,
	type TaskKey,
	TaskKeySchema,
	type TaskRef,
	WORKFLOW_CONTRACT_REVISION,
	type WorkflowRunId,
} from "./contracts.js";
import {
	type AgentTaskAuthoringRequest,
	createTaskHandle,
	type TaskHandle,
	validateJsonSchemaDocument,
} from "./definition.js";
import {
	MAX_WORKFLOW_EVENT_INPUT_BYTES,
	MAX_WORKFLOW_STATE_BYTES,
	type WorkflowBarrierProjection,
	type WorkflowEventInput,
	WorkflowEventInputSchema,
	type WorkflowStateProjection,
	WorkflowStateProjectionSchema,
} from "./events.js";

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

export interface MaterializationCommit {
	readonly epoch: number;
	readonly events: readonly WorkflowEventInput[];
}

export class WorkflowTaskMaterializer {
	private readonly definitionIdentitySha256: string;
	private readonly expectedBarriers: ReadonlyMap<
		number,
		WorkflowBarrierProjection
	>;
	private readonly expectedTasks: readonly MaterializedAgentTask[];
	private readonly inputSha256: string;
	private readonly namespace: readonly TaskKey[];
	private readonly runId: WorkflowRunId;
	private readonly seen = new Map<string, MaterializedAgentTask>();
	private projectedState: WorkflowStateProjection;
	private readonly uncommitted: MaterializedAgentTask[] = [];
	private readonly controlAfter = new Map<string, TaskRef>();
	private epoch = 1;
	private finalClosed = false;
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
		if (
			previous &&
			(previous.status === "completed" ||
				previous.status === "completed-degraded" ||
				previous.status === "cancelled")
		) {
			throw new WorkflowMaterializationError(
				"terminal workflow run may not materialize tasks",
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
		if (
			previous &&
			Object.values(previous.tasks).some(
				(projection) => projection.status === "invalidated",
			)
		) {
			throw new WorkflowMaterializationError(
				"invalidated materialization requires execution-generation support",
			);
		}
		this.expectedTasks = previous
			? Object.values(previous.tasks)
					.map((projection) => projection.task)
					.sort(
						(left, right) =>
							left.materializationSequence - right.materializationSequence,
					)
			: [];
		this.expectedBarriers = new Map(
			(previous?.barriers ?? []).map((barrier) => [barrier.epoch, barrier]),
		);
		this.projectedState = previous
			? structuredClone(previous)
			: {
					runId: this.runId,
					definitionIdentitySha256: this.definitionIdentitySha256,
					inputSha256: this.inputSha256,
					status: "created",
					currentEpoch: 1,
					lastSequence: 1,
					tasks: {},
					artifacts: {},
					barriers: [],
				};
	}

	agent<TOutputSchema extends TSchema>(
		key: TaskKey,
		request: AgentTaskAuthoringRequest<TOutputSchema>,
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
		const namespaceKey = [...this.namespace, key].join("\u0000");
		if (
			[...this.seen.values()].some(
				(task) =>
					[...task.namespace, task.spec.key].join("\u0000") === namespaceKey,
			)
		) {
			throw new WorkflowMaterializationError("duplicate task key in namespace");
		}
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
		const inputs = Object.fromEntries(
			Object.entries(request.inputs ?? {})
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([name, handle]) => {
					const ref = handle.ref;
					if (
						!Value.Check(TaskKeySchema, name) ||
						ref.runId !== this.runId ||
						!this.seen.has(ref.producerTaskId)
					) {
						throw new WorkflowMaterializationError(
							"task data dependency is invalid, unknown, or belongs to another run",
						);
					}
					after.set(ref.producerTaskId, {
						runId: this.runId,
						taskId: ref.producerTaskId,
					});
					return [name, ref];
				}),
		);
		const outputSchema = validateJsonSchemaDocument(
			request.outputSchema,
			"agent task output schema",
		);
		const agentRequest: AgentTaskRequest = {
			agent: request.agent,
			task: request.task,
			contextMode: request.contextMode,
			...(request.model === undefined ? {} : { model: request.model }),
			tools: [...request.tools],
			preloadSkills: [...request.preloadSkills],
			contextScopes: [...request.contextScopes],
			workspace: request.workspace,
			outputSchema: outputSchema as AgentTaskRequest["outputSchema"],
			limits: request.limits,
		};
		if (!Value.Check(AgentTaskRequestSchema, agentRequest)) {
			throw new WorkflowMaterializationError("invalid agent task request");
		}
		const orderedAfter = [...after.values()].sort((left, right) =>
			left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0,
		);
		const specWithoutIdentity: Omit<AgentTaskSpec, "identitySha256"> = {
			key,
			kind: "agent",
			disposition: request.disposition ?? "required",
			after: orderedAfter,
			inputs,
			replay: request.replay ?? "read-only",
			request: agentRequest,
		};
		const spec: AgentTaskSpec = {
			key,
			kind: "agent",
			disposition: request.disposition ?? "required",
			after: orderedAfter,
			inputs,
			replay: request.replay ?? "read-only",
			request: agentRequest,
			identitySha256: deriveAgentTaskIdentity({
				definitionIdentitySha256: this.definitionIdentitySha256,
				inputSha256: this.inputSha256,
				namespace: this.namespace,
				spec: specWithoutIdentity,
			}),
		};
		const id = deriveWorkflowTaskId(this.runId, this.namespace, key);
		const position =
			[...this.seen.values()].filter(
				(task) => task.materializationEpoch === this.epoch,
			).length + 1;
		const task = cloneFrozen({
			id,
			runId: this.runId,
			namespace: this.namespace,
			spec,
			definitionIdentitySha256: this.definitionIdentitySha256,
			materializationSequence: this.sequence + 1,
			materializationEpoch: this.epoch,
			epochPosition: position,
		}) as MaterializedAgentTask;
		if (!Value.Check(MaterializedAgentTaskSchema, task)) {
			throw new WorkflowMaterializationError("invalid materialized agent task");
		}
		const expected = this.expectedTasks[this.sequence];
		if (expected && !isDeepStrictEqual(task, expected)) {
			throw new WorkflowMaterializationError(
				"task declaration does not match the persisted ordered prefix",
			);
		}
		this.sequence += 1;
		const selected = expected ?? task;
		this.seen.set(selected.id, selected);
		if (!expected) this.uncommitted.push(selected);
		return createTaskHandle<Static<TOutputSchema>>(
			{ runId: this.runId, taskId: selected.id },
			{
				runId: this.runId,
				producerTaskId: selected.id,
				output: "result",
			},
		);
	}

	closeEpoch(
		kind: "result" | "results" | "final",
		tasks: readonly TaskHandle<unknown>[],
	): MaterializationCommit {
		if (this.finalClosed) {
			throw new WorkflowMaterializationError(
				"materialization barrier follows the final barrier",
			);
		}
		if (this.epoch > MAX_MATERIALIZATION_EPOCHS) {
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
		const unreplayed = this.expectedTasks.some(
			(task) =>
				task.materializationEpoch === this.epoch &&
				task.materializationSequence > this.sequence,
		);
		if (unreplayed) {
			throw new WorkflowMaterializationError(
				"barrier omits declarations from the persisted epoch prefix",
			);
		}
		const expected = this.expectedBarriers.get(this.epoch);
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
			if (taskIds.length > 0) {
				this.controlAfter.clear();
				for (const taskId of taskIds) {
					this.controlAfter.set(taskId, { runId: this.runId, taskId });
				}
			}
			if (kind === "final") this.finalClosed = true;
			const epoch = this.epoch;
			this.epoch += 1;
			return Object.freeze({ epoch, events: Object.freeze([]) });
		}
		if (this.epoch <= this.expectedBarriers.size) {
			throw new WorkflowMaterializationError(
				"materialization barrier removed from persisted prefix",
			);
		}
		const events: WorkflowEventInput[] = this.uncommitted.map((task) => ({
			type: "task-declared",
			data: { task },
		}));
		events.push({
			type: "barrier-reached",
			data: { epoch: this.epoch, kind, taskIds },
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
		if (projected.currentEpoch !== this.epoch) {
			throw new WorkflowMaterializationError(
				"persisted projection epoch does not match materialization replay",
			);
		}
		for (const task of this.uncommitted) {
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
			if (task.task.materializationEpoch === this.epoch) {
				task.committed = true;
			}
		}
		projected.lastSequence += events.length;
		projected.barriers.push({
			epoch: this.epoch,
			kind,
			taskIds: [...taskIds],
			sequence: projected.lastSequence,
		});
		projected.currentEpoch += 1;
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
		const epoch = this.epoch;
		this.epoch += 1;
		return Object.freeze({
			epoch,
			events: Object.freeze(events.map((event) => cloneFrozen(event))),
		});
	}
}
