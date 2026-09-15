import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Ajv } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import * as addFormatsModule from "ajv-formats";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { WorkflowArtifactStore } from "./artifact-store.js";
import type {
	NestedWorkflowTaskRequest,
	WorkflowArtifactRef,
	WorkflowHandoffDescriptor,
	WorkflowRunId,
	WorkflowTaskId,
} from "./contracts.js";
import {
	MAX_NESTED_WORKFLOW_DEPTH,
	TaskKeySchema,
	WorkflowDefinitionNameSchema,
} from "./contracts.js";
import {
	type AgentTaskAuthoringRequest,
	type AgentTaskHandle,
	isArtifactHandle,
	isHandoffHandle,
	isTaskHandle,
	isWorkflowDefinition,
	type NestedWorkflowRequest,
	type PipelineStage,
	type SettledTaskResult,
	type TaskHandle,
	validateJsonSchemaDocument,
	type WorkflowContext,
	type WorkflowDefinition,
	type WorkspaceAuthoringRequest,
	type WorktreeTaskHandle,
} from "./definition.js";
import type {
	WorkflowStateProjection,
	WorkflowTaskProjection,
} from "./events.js";
import {
	deriveJsonValueSha256,
	deriveWorkflowHandoffDescriptor,
} from "./execution.js";
import {
	type VerifiedWorkflowHandoff,
	verifyWorkflowHandoffEvidence,
	WORKFLOW_HANDOFF_UNVERIFIED_MESSAGE,
} from "./handoff.js";
import {
	type NestedWorkflowDeclaration,
	WorkflowTaskMaterializer,
} from "./materializer.js";
import type { WorkflowRunJournal } from "./persistence/journal.js";
import { reduceWorkflowEvents } from "./reducer.js";
import type { DiscoveredWorkflow } from "./registry.js";
import {
	hasOpenOperatorIntent,
	isReopenedTask,
	OPERATOR_RESUME_REASON,
} from "./run-actions.js";
import type { WorkflowSequentialScheduler } from "./scheduler.js";

const addFormats = (addFormatsModule.default ??
	addFormatsModule) as unknown as FormatsPlugin;
const runtimeDrives = new Map<string, Promise<void>>();
const SETTLED_TASK_STATUSES = new Set([
	"completed",
	"failed",
	"cancelled",
	"interrupted",
	"blocked",
	"cleanup-blocked",
	"invalidated",
]);

/**
 * A task holds settled evidence unless an operator resume reopened it: such a
 * task is `interrupted` by status while its execution is being re-attempted,
 * and the barrier keeps driving it instead of reading the interruption.
 */
function isSettledTask(
	state: WorkflowStateProjection,
	task: WorkflowTaskProjection | undefined,
): boolean {
	if (!task) return false;
	return SETTLED_TASK_STATUSES.has(task.status) && !isReopenedTask(state, task);
}

export type StaticWorkflowRunResult<T> = {
	readonly runId: WorkflowRunId;
	readonly status: "completed" | "completed-degraded";
	readonly value: T;
	readonly artifact: WorkflowArtifactRef;
};

export interface StaticWorkflowRuntime<TOutput> {
	drive(): Promise<StaticWorkflowRunResult<TOutput>>;
}

export interface StaticWorkflowRuntimeOptions<TInput, TOutput> {
	readonly definition: WorkflowDefinition<TInput, TOutput>;
	readonly definitionIdentitySha256: string;
	readonly input: TInput;
	readonly cwd: string;
	readonly journal: WorkflowRunJournal;
	readonly artifacts: WorkflowArtifactStore;
	readonly scheduler: WorkflowSequentialScheduler;
	readonly signal?: AbortSignal;
	readonly nesting?: {
		readonly depth: number;
		readonly ancestorDefinitionIdentities: readonly string[];
		readonly resolveWorkflow: (name: string) => DiscoveredWorkflow | undefined;
	};
}

export class StaticWorkflowRuntimeError extends Error {
	constructor(
		readonly stage:
			| "validation"
			| "materialization"
			| "execution"
			| "result"
			| "finalization",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "StaticWorkflowRuntimeError";
	}
}

/** The runtime decides worktree handling from the materialized spec only. */
function isWorktreeTask(task: WorkflowTaskProjection): boolean {
	const spec = task.task.spec;
	return spec.kind === "agent" && spec.request.workspace.mode === "worktree";
}

function validator(schema: TSchema): (value: unknown) => boolean {
	const ajv = new Ajv({ allErrors: true, strict: true, validateSchema: true });
	addFormats(ajv);
	return ajv.compile(schema);
}

function jsonCloneFrozen<T>(value: T, label: string): T {
	let json: string | undefined;
	try {
		json = JSON.stringify(value);
	} catch (error) {
		throw new StaticWorkflowRuntimeError(
			"validation",
			`${label} is not JSON-serializable.`,
			{ cause: error },
		);
	}
	if (json === undefined) {
		throw new StaticWorkflowRuntimeError(
			"validation",
			`${label} is not JSON-serializable.`,
		);
	}
	const cloned = JSON.parse(json) as T;
	if (!isDeepStrictEqual(value, cloned)) {
		throw new StaticWorkflowRuntimeError(
			"validation",
			`${label} is not losslessly JSON-serializable.`,
		);
	}
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

export function createStaticWorkflowRuntime<TInput, TOutput>(
	options: StaticWorkflowRuntimeOptions<TInput, TOutput>,
): StaticWorkflowRuntime<TOutput> {
	const {
		artifacts,
		cwd,
		definition,
		definitionIdentitySha256,
		journal,
		scheduler,
	} = options;
	const signal = options.signal ?? new AbortController().signal;
	if (
		!isWorkflowDefinition(definition) ||
		!definitionIdentitySha256.match(/^[a-f0-9]{64}$/) ||
		!path.isAbsolute(cwd) ||
		cwd.length > 4096 ||
		artifacts.runId !== journal.runId
	) {
		throw new StaticWorkflowRuntimeError(
			"validation",
			"Static workflow runtime identity is invalid.",
		);
	}
	const nesting = options.nesting;
	if (
		nesting !== undefined &&
		(!Number.isInteger(nesting.depth) ||
			nesting.depth < 0 ||
			nesting.depth >= MAX_NESTED_WORKFLOW_DEPTH ||
			!Array.isArray(nesting.ancestorDefinitionIdentities) ||
			nesting.ancestorDefinitionIdentities.length !== nesting.depth ||
			!nesting.ancestorDefinitionIdentities.every(
				(identity) =>
					typeof identity === "string" && /^[a-f0-9]{64}$/.test(identity),
			) ||
			typeof nesting.resolveWorkflow !== "function")
	) {
		throw new StaticWorkflowRuntimeError(
			"validation",
			"Static workflow runtime nesting is invalid.",
		);
	}
	const inputSchema = validateJsonSchemaDocument(
		definition.inputSchema,
		"workflow input schema",
	);
	const outputSchema = validateJsonSchemaDocument(
		definition.outputSchema,
		"workflow output schema",
	);
	const validateInput = validator(inputSchema);
	const validateOutput = validator(outputSchema);
	const input = jsonCloneFrozen(options.input, "Workflow input");
	if (!validateInput(input)) {
		throw new StaticWorkflowRuntimeError(
			"validation",
			"Workflow input does not match its schema.",
		);
	}
	const inputSha256 = deriveJsonValueSha256(input);
	const coordinationKey = journal.directory;

	async function appendEvents(
		events: readonly Parameters<WorkflowRunJournal["appendEvent"]>[0][],
	): Promise<void> {
		for (const event of events) await journal.appendEvent(event);
	}

	async function state() {
		return reduceWorkflowEvents(await journal.readEvents());
	}

	async function initialize(): Promise<void> {
		const events = await journal.readEvents();
		if (events.length === 0) {
			await journal.append("run-created", {
				definitionIdentitySha256,
				inputSha256,
			});
			return;
		}
		const current = reduceWorkflowEvents(events);
		if (
			current.definitionIdentitySha256 !== definitionIdentitySha256 ||
			current.inputSha256 !== inputSha256
		) {
			throw new StaticWorkflowRuntimeError(
				"validation",
				"Workflow definition or input identity changed during replay.",
			);
		}
	}

	async function loadTaskResult(taskId: WorkflowTaskId): Promise<unknown> {
		const current = await state();
		const task = current.tasks[taskId];
		if (!task) {
			throw new StaticWorkflowRuntimeError(
				"result",
				"Workflow result references an unknown task.",
			);
		}
		if (task.status !== "completed") {
			throw new StaticWorkflowRuntimeError(
				"result",
				`Workflow task did not complete successfully: ${task.status}.`,
			);
		}
		// Result artifacts bind to the producing execution; only the current
		// generation's artifact is the task's result.
		const currentExecutionId = task.currentExecutionId;
		const artifact =
			currentExecutionId === undefined
				? undefined
				: Object.values(current.artifacts).find(
						(candidate) =>
							candidate.producerTaskId === taskId &&
							candidate.output === "result" &&
							candidate.producerExecutionId === currentExecutionId,
					);
		if (!artifact) {
			throw new StaticWorkflowRuntimeError(
				"result",
				"Completed workflow task has no result artifact.",
			);
		}
		const value = await artifacts.readJson(artifact);
		const outputSchema =
			task.task.spec.kind === "support"
				? task.task.spec.request.implementation.outputSchema
				: task.task.spec.request.outputSchema;
		if (!validator(outputSchema)(value)) {
			throw new StaticWorkflowRuntimeError(
				"result",
				"Workflow task artifact no longer matches its output schema.",
			);
		}
		// A completed worktree task replays only with verified handoff
		// evidence for its current execution (spec D8).
		if (isWorktreeTask(task)) await verifyHandoff(current, task);
		return jsonCloneFrozen(value, "Workflow task result");
	}

	async function verifyHandoff(
		current: Awaited<ReturnType<typeof state>>,
		task: WorkflowTaskProjection,
	): Promise<VerifiedWorkflowHandoff> {
		try {
			return await verifyWorkflowHandoffEvidence(current, task, artifacts);
		} catch (error) {
			throw new StaticWorkflowRuntimeError(
				"result",
				WORKFLOW_HANDOFF_UNVERIFIED_MESSAGE,
				{ cause: error },
			);
		}
	}

	/**
	 * Resolves the handoff descriptor of a completed worktree task from its
	 * current execution's verified handoff artifact; `undefined` only under
	 * the optional policy when the child captured no handoff.
	 */
	async function loadTaskHandoff(
		taskId: WorkflowTaskId,
	): Promise<WorkflowHandoffDescriptor | undefined> {
		const current = await state();
		const task = current.tasks[taskId];
		if (!task) {
			throw new StaticWorkflowRuntimeError(
				"result",
				"Workflow result references an unknown task.",
			);
		}
		if (task.status !== "completed") {
			throw new StaticWorkflowRuntimeError(
				"result",
				`Workflow task did not complete successfully: ${task.status}.`,
			);
		}
		if (!isWorktreeTask(task)) {
			throw new StaticWorkflowRuntimeError(
				"result",
				"Workflow handoff references a non-worktree task.",
			);
		}
		const verified = await verifyHandoff(current, task);
		if (verified.status === "absent") return undefined;
		let descriptor: WorkflowHandoffDescriptor;
		try {
			descriptor = deriveWorkflowHandoffDescriptor(
				verified.artifact,
				verified.execution,
			);
		} catch (error) {
			throw new StaticWorkflowRuntimeError(
				"result",
				WORKFLOW_HANDOFF_UNVERIFIED_MESSAGE,
				{ cause: error },
			);
		}
		return jsonCloneFrozen(descriptor, "Workflow handoff descriptor");
	}

	async function driveSchedulerBatch() {
		const settled = await Promise.allSettled(
			Array.from({ length: scheduler.concurrency }, () => scheduler.drive()),
		);
		return {
			outcomes: settled.flatMap((result) =>
				result.status === "fulfilled" ? [result.value] : [],
			),
			errors: settled.flatMap((result) =>
				result.status === "rejected" ? [result.reason] : [],
			),
		};
	}

	async function driveTasks(taskIds: readonly WorkflowTaskId[]): Promise<void> {
		for (;;) {
			const current = await state();
			const pending = taskIds.filter(
				(taskId) => current.tasks[taskId]?.status !== "completed",
			);
			if (pending.length === 0) return;
			// The barrier's verdict waits while an operator-reopened task is being
			// re-attempted; once every target holds settled evidence it is final.
			const reopened = pending.some((taskId) => {
				const task = current.tasks[taskId];
				return task !== undefined && isReopenedTask(current, task);
			});
			if (!reopened) {
				for (const taskId of pending) {
					const task = current.tasks[taskId];
					if (isSettledTask(current, task)) {
						throw new StaticWorkflowRuntimeError(
							"execution",
							`Workflow task cannot produce a result: ${task?.status}.`,
						);
					}
				}
			}
			const { outcomes, errors } = await driveSchedulerBatch();
			if (outcomes.every((outcome) => outcome.state === "idle")) {
				const after = await state();
				if (
					pending.every((taskId) => after.tasks[taskId]?.status !== "completed")
				) {
					throw new StaticWorkflowRuntimeError(
						"execution",
						"Workflow scheduler made no progress toward the result barrier.",
					);
				}
			}
			const afterOutcome = await state();
			if (
				afterOutcome.lastSequence === current.lastSequence &&
				errors.length > 0
			) {
				throw errors[0];
			}
			if (
				afterOutcome.lastSequence === current.lastSequence &&
				pending.some(
					(taskId) => afterOutcome.tasks[taskId]?.status !== "completed",
				)
			) {
				throw new StaticWorkflowRuntimeError(
					"execution",
					"Workflow scheduler made no durable progress toward the result barrier.",
				);
			}
			const terminal = outcomes.find((outcome) => outcome.state === "terminal");
			if (terminal?.state === "terminal") {
				throw new StaticWorkflowRuntimeError(
					"execution",
					`Workflow run terminated before its result barrier: ${terminal.runStatus}.`,
				);
			}
		}
	}

	async function driveSettledTasks(
		taskIds: readonly WorkflowTaskId[],
	): Promise<void> {
		for (;;) {
			const current = await state();
			if (
				taskIds.every((taskId) => isSettledTask(current, current.tasks[taskId]))
			) {
				return;
			}
			const before = current.lastSequence;
			const { errors } = await driveSchedulerBatch();
			const after = await state();
			if (after.lastSequence === before && errors.length > 0) {
				throw errors[0];
			}
			if (after.lastSequence === before) {
				throw new StaticWorkflowRuntimeError(
					"execution",
					"Workflow scheduler made no durable progress toward the settled barrier.",
				);
			}
		}
	}

	async function driveFinalGraph(): Promise<void> {
		for (;;) {
			const current = await state();
			const tasks = Object.values(current.tasks).filter(
				(task) => task.abandoned !== true && task.task.spec.role === "task",
			);
			const reopened = tasks.some((task) => isReopenedTask(current, task));
			const failedRequired = tasks.find(
				(task) =>
					task.task.spec.disposition === "required" &&
					task.status !== "completed" &&
					isSettledTask(current, task),
			);
			// As at a result barrier, the verdict waits for a reopened task.
			if (failedRequired && !reopened) {
				throw new StaticWorkflowRuntimeError(
					"execution",
					`Required workflow task did not complete: ${failedRequired.status}.`,
				);
			}
			const unsettled =
				reopened ||
				tasks.some(
					(task) =>
						task.status === "pending" ||
						task.status === "ready" ||
						task.status === "running" ||
						task.status === "waiting" ||
						task.status === "cancelling",
				);
			if (!unsettled) return;
			const before = current.lastSequence;
			const { outcomes, errors } = await driveSchedulerBatch();
			const after = await state();
			const terminal = outcomes.find((outcome) => outcome.state === "terminal");
			if (terminal?.state === "terminal" && after.status !== "completed") {
				throw new StaticWorkflowRuntimeError(
					"execution",
					`Workflow run terminated while settling its final graph: ${terminal.runStatus}.`,
				);
			}
			if (after.lastSequence === before && errors.length > 0) {
				throw errors[0];
			}
			if (after.lastSequence === before) {
				throw new StaticWorkflowRuntimeError(
					"execution",
					"Workflow scheduler made no durable progress on the final graph.",
				);
			}
		}
	}

	async function driveFinalizers(): Promise<void> {
		for (;;) {
			const current = await state();
			if (current.status !== "finalizing") {
				throw new StaticWorkflowRuntimeError(
					"finalization",
					`Workflow run left finalizing while driving finalizers: ${current.status}.`,
				);
			}
			const finalizers = Object.values(current.tasks).filter(
				(task) =>
					task.abandoned !== true && task.task.spec.role === "finalizer",
			);
			const failedRequired = finalizers.find(
				(task) =>
					task.task.spec.disposition === "required" &&
					task.status !== "completed" &&
					isSettledTask(current, task),
			);
			if (failedRequired) {
				throw new StaticWorkflowRuntimeError(
					"finalization",
					`Required finalizer did not complete: ${failedRequired.status}.`,
				);
			}
			if (finalizers.every((task) => isSettledTask(current, task))) {
				return;
			}
			const before = current.lastSequence;
			const { outcomes, errors } = await driveSchedulerBatch();
			const after = await state();
			const terminal = outcomes.find((outcome) => outcome.state === "terminal");
			if (terminal?.state === "terminal") {
				throw new StaticWorkflowRuntimeError(
					"finalization",
					`Workflow run terminated while driving finalizers: ${terminal.runStatus}.`,
				);
			}
			if (after.lastSequence === before && errors.length > 0) {
				throw errors[0];
			}
			if (after.lastSequence === before) {
				throw new StaticWorkflowRuntimeError(
					"finalization",
					"Workflow scheduler made no durable progress on the finalizers.",
				);
			}
		}
	}

	async function completeFinalizing(
		artifact: WorkflowArtifactRef,
		output: TOutput,
	): Promise<StaticWorkflowRunResult<TOutput>> {
		let current = await state();
		// Re-entry after invalidation recovery resumes the run before the
		// finalizers are driven again.
		if (current.status === "waiting") {
			await journal.append("run-status-changed", {
				from: "waiting",
				to: "running",
			});
			current = await state();
		}
		if (current.status === "running") {
			await journal.append("run-status-changed", {
				from: "running",
				to: "finalizing",
			});
			current = await state();
		}
		if (current.status === "finalizing") {
			await driveFinalizers();
			current = await state();
			if (current.status !== "finalizing") {
				throw new StaticWorkflowRuntimeError(
					"finalization",
					`Workflow run left finalizing while driving finalizers: ${current.status}.`,
				);
			}
			const degraded = Object.values(current.tasks).some(
				(task) =>
					task.abandoned !== true &&
					task.task.spec.disposition === "optional" &&
					task.status !== "completed",
			);
			await journal.append("run-status-changed", {
				from: "finalizing",
				to: degraded ? "completed-degraded" : "completed",
			});
			current = await state();
		}
		if (
			current.status !== "completed" &&
			current.status !== "completed-degraded"
		) {
			throw new StaticWorkflowRuntimeError(
				"finalization",
				"Workflow output exists outside final completion state.",
			);
		}
		return {
			runId: journal.runId,
			status: current.status,
			value: output,
			artifact,
		};
	}

	async function finish(
		value: unknown,
	): Promise<StaticWorkflowRunResult<TOutput>> {
		if (!validateOutput(value)) {
			throw new StaticWorkflowRuntimeError(
				"finalization",
				"Workflow return value does not match its output schema.",
			);
		}
		const output = jsonCloneFrozen(value, "Workflow output") as TOutput;
		const schemaSha256 = deriveJsonValueSha256(outputSchema);
		let current = await state();
		if (current.outputArtifactId) {
			const existing = current.artifacts[current.outputArtifactId];
			const replayed = existing
				? await artifacts.readJson(existing)
				: undefined;
			if (
				!existing ||
				existing.schemaSha256 !== schemaSha256 ||
				!isDeepStrictEqual(replayed, output)
			) {
				throw new StaticWorkflowRuntimeError(
					"finalization",
					"Workflow output changed after durable completion.",
				);
			}
			return completeFinalizing(
				existing,
				jsonCloneFrozen(replayed, "Replayed workflow output") as TOutput,
			);
		}
		const ref = await artifacts.putJson(output, {
			runId: journal.runId,
			schemaSha256,
		});
		if (!current.artifacts[ref.id]) {
			await journal.append("artifact-declared", { artifact: ref });
			current = await state();
		}
		if (current.status === "created") {
			await journal.append("run-status-changed", {
				from: "created",
				to: "running",
			});
			current = await state();
		}
		if (current.status === "waiting") {
			await journal.append("run-status-changed", {
				from: "waiting",
				to: "running",
			});
			current = await state();
		}
		if (current.status === "running") {
			await journal.append("run-status-changed", {
				from: "running",
				to: "finalizing",
			});
			current = await state();
		}
		if (current.status !== "finalizing") {
			throw new StaticWorkflowRuntimeError(
				"finalization",
				`Workflow run cannot finalize from ${current.status}.`,
			);
		}
		await journal.append("run-output-committed", { artifactId: ref.id });
		return completeFinalizing(ref, output);
	}

	function nestedDeclaration(
		request: NestedWorkflowRequest,
	): NestedWorkflowDeclaration {
		if (!nesting) {
			throw new StaticWorkflowRuntimeError(
				"validation",
				"Nested workflows are not available in this runtime.",
			);
		}
		if (
			typeof request !== "object" ||
			request === null ||
			!Value.Check(WorkflowDefinitionNameSchema, request.workflow)
		) {
			throw new StaticWorkflowRuntimeError(
				"validation",
				"Nested workflow name is invalid.",
			);
		}
		const child = nesting.resolveWorkflow(request.workflow);
		if (!child || !isWorkflowDefinition(child.definition)) {
			throw new StaticWorkflowRuntimeError(
				"validation",
				"Nested workflow definition is not discovered.",
			);
		}
		if (nesting.depth + 1 >= MAX_NESTED_WORKFLOW_DEPTH) {
			throw new StaticWorkflowRuntimeError(
				"validation",
				"Nested workflow depth bound exceeded.",
			);
		}
		const childIdentity = child.identity.identitySha256;
		if (
			childIdentity === definitionIdentitySha256 ||
			nesting.ancestorDefinitionIdentities.includes(childIdentity)
		) {
			throw new StaticWorkflowRuntimeError(
				"validation",
				"Nested workflow recursion is not allowed.",
			);
		}
		const childInputSchema = validateJsonSchemaDocument(
			child.definition.inputSchema,
			"nested workflow input schema",
		);
		const childOutputSchema = validateJsonSchemaDocument(
			child.definition.outputSchema,
			"nested workflow output schema",
		);
		const childInput = jsonCloneFrozen(request.input, "Nested workflow input");
		const inputNames = Object.keys(request.inputs ?? {});
		if (inputNames.length === 0) {
			if (!validator(childInputSchema)(childInput)) {
				throw new StaticWorkflowRuntimeError(
					"validation",
					"Nested workflow input does not match its schema.",
				);
			}
		} else {
			// Artifact inputs are merged into the authored input at launch,
			// so the merged value is validated against the child schema
			// there; declaration only checks the merge is well-formed.
			if (
				typeof childInput !== "object" ||
				childInput === null ||
				Array.isArray(childInput)
			) {
				throw new StaticWorkflowRuntimeError(
					"validation",
					"Nested workflow artifact inputs require an object input.",
				);
			}
			if (inputNames.some((name) => Object.hasOwn(childInput, name))) {
				throw new StaticWorkflowRuntimeError(
					"validation",
					"Nested workflow input name collides with the authored input.",
				);
			}
		}
		const meta = child.definition.meta;
		const nestedRequest: NestedWorkflowTaskRequest = {
			definitionName: meta.name,
			definitionIdentitySha256: childIdentity,
			definitionSourceSha256: child.identity.sourceSha256,
			definitionVersion: meta.version,
			input: childInput,
			inputSha256: deriveJsonValueSha256(childInput),
			inputSchema: childInputSchema as NestedWorkflowTaskRequest["inputSchema"],
			outputSchema:
				childOutputSchema as NestedWorkflowTaskRequest["outputSchema"],
			budget: structuredClone(meta.budget),
			timeoutMs: meta.timeoutMs,
			concurrency: meta.concurrency,
		};
		return {
			request: nestedRequest,
			...(request.disposition === undefined
				? {}
				: { disposition: request.disposition }),
			...(request.after === undefined ? {} : { after: request.after }),
			...(request.inputs === undefined ? {} : { inputs: request.inputs }),
			...(request.replay === undefined ? {} : { replay: request.replay }),
		};
	}

	async function driveCurrent(): Promise<StaticWorkflowRunResult<TOutput>> {
		if (signal.aborted) {
			throw new StaticWorkflowRuntimeError(
				"execution",
				"Workflow execution was aborted.",
			);
		}
		await initialize();
		let previous = await state();
		if (previous.status === "failed" || previous.status === "interrupted") {
			const invalidated = Object.values(previous.tasks).some(
				(task) => task.abandoned !== true && task.status === "invalidated",
			);
			// Explicit invalidation is the documented recovery: the run resumes
			// so the invalidated tasks can be re-materialized and re-executed. An
			// open operator resume intent counts like invalidated work: the run
			// resumes so the scheduler can perform the operator's attempt.
			if (invalidated) {
				await journal.append("run-status-changed", {
					from: previous.status,
					to: "running",
					reason: "Explicit invalidation re-executes invalidated tasks.",
				});
				previous = await state();
			} else if (
				previous.status === "interrupted" &&
				hasOpenOperatorIntent(previous)
			) {
				await journal.append("run-status-changed", {
					from: "interrupted",
					to: "running",
					reason: OPERATOR_RESUME_REASON,
				});
				previous = await state();
			}
		}
		if (
			previous.status === "failed" ||
			previous.status === "cancelled" ||
			previous.status === "interrupted" ||
			previous.status === "cleanup-blocked"
		) {
			throw new StaticWorkflowRuntimeError(
				"execution",
				`Workflow run requires explicit recovery from ${previous.status}.`,
			);
		}
		const materializer = new WorkflowTaskMaterializer({
			runId: journal.runId,
			definitionIdentitySha256,
			inputSha256,
			previousState: previous,
		});
		const handles = new Map<WorkflowTaskId, TaskHandle<unknown>>();
		// Only on-path effects replay; abandoned effects remain history but
		// still occupy ordinals, so new ordinals continue after every effect.
		const expectedEffects = previous.effects.filter(
			(effect) => effect.abandoned !== true,
		);
		const persistedEffectCount = previous.effects.length;
		let effectOrdinal = 0;
		let appendedEffects = 0;
		let effectTail = Promise.resolve();
		let barrierTail = Promise.resolve();

		function prepareBarrier(
			kind: "result" | "results" | "settled" | "final",
			tasks: readonly TaskHandle<unknown>[],
		): () => Promise<void> {
			const effectPrefix = effectTail;
			const effectCount = effectOrdinal;
			const commit = materializer.closeEpoch(kind, tasks);
			const expectedBarrier = previous.barriers.find(
				(barrier) =>
					barrier.abandoned !== true && barrier.epoch === commit.epoch,
			);
			if (expectedBarrier) {
				const expectedEffectCount = expectedEffects.filter(
					(effect) => effect.sequence < expectedBarrier.sequence,
				).length;
				if (effectCount !== expectedEffectCount) {
					throw new StaticWorkflowRuntimeError(
						"materialization",
						"Workflow phase or log effect moved across a persisted barrier.",
					);
				}
			}
			const persisted = effectPrefix.then(() => appendEvents(commit.events));
			effectTail = persisted;
			return () => persisted;
		}

		function barrier<T>(operation: () => Promise<T>): Promise<T> {
			const result = barrierTail.then(operation);
			barrierTail = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		}

		function recordEffect(kind: "phase" | "log", value: string): void {
			effectOrdinal += 1;
			const expected = expectedEffects[effectOrdinal - 1];
			if (expected) {
				if (expected.kind !== kind || expected.value !== value) {
					throw new StaticWorkflowRuntimeError(
						"materialization",
						"Workflow phase or log effect changed during replay.",
					);
				}
				return;
			}
			appendedEffects += 1;
			const ordinal = persistedEffectCount + appendedEffects;
			effectTail = effectTail.then(async () => {
				await journal.append("workflow-effect", {
					ordinal,
					kind,
					value,
				});
			});
		}

		const context: WorkflowContext<TInput> = Object.freeze({
			input,
			runId: journal.runId,
			cwd,
			signal,
			phase(name: string) {
				if (name.length < 1 || name.length > 128) {
					throw new StaticWorkflowRuntimeError(
						"validation",
						"Workflow phase must contain 1 to 128 characters.",
					);
				}
				recordEffect("phase", name);
			},
			log(message: string) {
				if (message.length < 1 || message.length > 4096) {
					throw new StaticWorkflowRuntimeError(
						"validation",
						"Workflow log must contain 1 to 4096 characters.",
					);
				}
				recordEffect("log", message);
			},
			agent(key, request) {
				const handle = materializer.agent(key, request);
				handles.set(handle.ref.taskId, handle as TaskHandle<unknown>);
				return handle;
			},
			support(key, descriptor) {
				const handle = materializer.support(key, descriptor);
				handles.set(handle.ref.taskId, handle as TaskHandle<unknown>);
				return handle;
			},
			workflow<TOutput = unknown>(
				key: Parameters<typeof materializer.workflow>[0],
				request: NestedWorkflowRequest,
			): TaskHandle<TOutput> {
				const handle = materializer.workflow<TOutput>(
					key,
					nestedDeclaration(request),
				);
				handles.set(handle.ref.taskId, handle as TaskHandle<unknown>);
				return handle;
			},
			fanOut(namespace, items, options) {
				if (!Value.Check(TaskKeySchema, namespace)) {
					throw new StaticWorkflowRuntimeError(
						"validation",
						"Workflow fan-out namespace is invalid.",
					);
				}
				if (items.length > 64) {
					throw new StaticWorkflowRuntimeError(
						"validation",
						"Workflow fan-out exceeds 64 items.",
					);
				}
				if (
					!options ||
					typeof options.key !== "function" ||
					typeof options.task !== "function"
				) {
					throw new StaticWorkflowRuntimeError(
						"validation",
						"Workflow fan-out options are invalid.",
					);
				}
				const created = items.map((item, index) => {
					const handle = materializer.agentInNamespace(
						[namespace],
						options.key(item, index),
						options.task(item, index),
					);
					handles.set(handle.ref.taskId, handle as TaskHandle<unknown>);
					return handle;
				});
				return Object.freeze(created);
			},
			fanIn(key, sources, options) {
				if (sources.length < 1 || sources.length > 64) {
					throw new StaticWorkflowRuntimeError(
						"validation",
						"Workflow fan-in requires 1 to 64 sources.",
					);
				}
				if (
					!options ||
					typeof options.inputKey !== "function" ||
					!options.task ||
					Object.hasOwn(options.task, "inputs")
				) {
					throw new StaticWorkflowRuntimeError(
						"validation",
						"Workflow fan-in options are invalid.",
					);
				}
				const entries = sources.map(
					(source, index) =>
						[options.inputKey(source, index), source.output] as const,
				);
				if (new Set(entries.map(([name]) => name)).size !== entries.length) {
					throw new StaticWorkflowRuntimeError(
						"validation",
						"Workflow fan-in input keys must be unique.",
					);
				}
				const handle = materializer.agent(key, {
					...options.task,
					inputs: Object.fromEntries(entries),
				});
				handles.set(handle.ref.taskId, handle as TaskHandle<unknown>);
				return handle;
			},
			pipeline(namespace, build) {
				if (
					!Value.Check(TaskKeySchema, namespace) ||
					typeof build !== "function"
				) {
					throw new StaticWorkflowRuntimeError(
						"validation",
						"Workflow pipeline definition is invalid.",
					);
				}
				const created = new Set<WorkflowTaskId>();
				const stage: PipelineStage = Object.freeze({
					agent<
						TOutputSchema extends TSchema,
						TWorkspace extends
							WorkspaceAuthoringRequest = WorkspaceAuthoringRequest,
					>(
						key: Parameters<typeof materializer.agent>[0],
						request: AgentTaskAuthoringRequest<TOutputSchema, TWorkspace>,
					): AgentTaskHandle<TOutputSchema, TWorkspace> {
						if (created.size >= 64) {
							throw new StaticWorkflowRuntimeError(
								"validation",
								"Workflow pipeline exceeds 64 stages.",
							);
						}
						const handle = materializer.agentInNamespace(
							[namespace],
							key,
							request,
						);
						created.add(handle.ref.taskId);
						handles.set(handle.ref.taskId, handle as TaskHandle<unknown>);
						return handle;
					},
				});
				const final = build(stage);
				if (!isTaskHandle(final) || !created.has(final.ref.taskId)) {
					throw new StaticWorkflowRuntimeError(
						"validation",
						"Workflow pipeline must return one of its stage handles.",
					);
				}
				return final;
			},
			finalize(key, request) {
				if (request === null || typeof request !== "object") {
					throw new StaticWorkflowRuntimeError(
						"validation",
						"Workflow finalizer request is invalid.",
					);
				}
				// An explicit disposition on the nested request, even undefined,
				// must reach the materializer's "finalizer disposition is its kind"
				// rule rather than being dropped while lowering the request.
				const workflow =
					request.workflow !== undefined
						? {
								...nestedDeclaration(request.workflow),
								...(Object.hasOwn(request.workflow, "disposition")
									? { disposition: request.workflow.disposition }
									: {}),
							}
						: undefined;
				const handle = materializer.finalizer(key, {
					kind: request.kind,
					...(request.support === undefined
						? {}
						: { support: request.support }),
					...(request.agent === undefined ? {} : { agent: request.agent }),
					...(workflow === undefined ? {} : { workflow }),
				});
				handles.set(handle.ref.taskId, handle as TaskHandle<unknown>);
				return handle;
			},
			result<T>(task: TaskHandle<T>): Promise<T> {
				const commit = prepareBarrier("result", [task]);
				return barrier(async () => {
					await commit();
					await driveTasks([task.ref.taskId]);
					return (await loadTaskResult(task.ref.taskId)) as T;
				});
			},
			handoff<T>(
				task: WorktreeTaskHandle<T>,
			): Promise<WorkflowHandoffDescriptor | undefined> {
				if (
					!isTaskHandle(task) ||
					!isHandoffHandle(task.handoff) ||
					task.handoff.ref.producerTaskId !== task.ref.taskId
				) {
					throw new StaticWorkflowRuntimeError(
						"validation",
						"Workflow handoff barrier requires a worktree task handle.",
					);
				}
				// A persisted "result"-kind barrier: no new barrier kind, and the
				// finalizer rule applies exactly as for ctx.result.
				const commit = prepareBarrier("result", [task]);
				return barrier(async () => {
					await commit();
					await driveTasks([task.ref.taskId]);
					return loadTaskHandoff(task.ref.taskId);
				});
			},
			results<const T extends readonly TaskHandle<unknown>[]>(
				tasks: T,
			): Promise<{
				[K in keyof T]: T[K] extends TaskHandle<infer V> ? V : never;
			}> {
				const commit = prepareBarrier("results", tasks);
				return barrier(async () => {
					await commit();
					await driveTasks(tasks.map((task) => task.ref.taskId));
					return Promise.all(
						tasks.map((task) => loadTaskResult(task.ref.taskId)),
					) as Promise<{
						[K in keyof T]: T[K] extends TaskHandle<infer V> ? V : never;
					}>;
				});
			},
			settled<const T extends readonly TaskHandle<unknown>[]>(
				tasks: T,
			): Promise<{
				[K in keyof T]: T[K] extends TaskHandle<infer V>
					? SettledTaskResult<V>
					: never;
			}> {
				const commit = prepareBarrier("settled", tasks);
				return barrier(async () => {
					await commit();
					await driveSettledTasks(tasks.map((task) => task.ref.taskId));
					const current = await state();
					return Promise.all(
						tasks.map(async (task) => {
							const projected = current.tasks[task.ref.taskId];
							if (projected?.status === "completed") {
								return Object.freeze({
									status: "fulfilled" as const,
									value: await loadTaskResult(task.ref.taskId),
								});
							}
							if (!projected) throw new Error("settled task disappeared");
							if (
								projected.status === "pending" ||
								projected.status === "ready" ||
								projected.status === "running" ||
								projected.status === "waiting" ||
								projected.status === "cancelling"
							) {
								throw new Error("settled task remained active");
							}
							const execution = projected.currentExecutionId
								? current.executions[projected.currentExecutionId]
								: undefined;
							const evidence = execution?.terminal?.evidence;
							const failure = evidence
								? evidence.kind === "workflow"
									? { message: evidence.message, code: evidence.stage }
									: evidence.kind === "nested-workflow"
										? { message: evidence.status, code: "nested-workflow" }
										: evidence.kind === "subagent" && evidence.failure
											? structuredClone(evidence.failure)
											: undefined
								: undefined;
							return Object.freeze({
								status: "rejected" as const,
								taskId: task.ref.taskId,
								outcome: projected.status,
								...(failure ? { failure: Object.freeze(failure) } : {}),
							});
						}),
					) as Promise<{
						[K in keyof T]: T[K] extends TaskHandle<infer V>
							? SettledTaskResult<V>
							: never;
					}>;
				});
			},
		});

		let returned: unknown;
		try {
			returned = await definition.run(context);
			await barrierTail;
			await effectTail;
		} catch (error) {
			const failed = await state();
			if (
				failed.status === "created" ||
				failed.status === "running" ||
				failed.status === "waiting" ||
				failed.status === "finalizing"
			) {
				await journal.append("run-status-changed", {
					from: failed.status,
					to: "failed",
					reason: "Static workflow source execution failed.",
				});
			}
			throw new StaticWorkflowRuntimeError(
				"execution",
				"Static workflow source execution failed.",
				{ cause: error },
			);
		}
		if (effectOrdinal < expectedEffects.length) {
			throw new StaticWorkflowRuntimeError(
				"materialization",
				"Workflow omitted a persisted phase or log effect during replay.",
			);
		}
		let value: unknown;
		if (isTaskHandle(returned)) {
			await prepareBarrier("final", [returned])();
			await driveFinalGraph();
			value = await loadTaskResult(returned.ref.taskId);
		} else if (isArtifactHandle(returned)) {
			const handle = handles.get(returned.ref.producerTaskId);
			if (!handle) {
				throw new StaticWorkflowRuntimeError(
					"finalization",
					"Workflow returned an unknown artifact handle.",
				);
			}
			await prepareBarrier("final", [handle])();
			await driveFinalGraph();
			value = await loadTaskResult(handle.ref.taskId);
		} else if (isHandoffHandle(returned)) {
			// The descriptor is the run output; the patch bytes never are.
			const handle = handles.get(returned.ref.producerTaskId);
			if (!handle || !isHandoffHandle(handle.handoff)) {
				throw new StaticWorkflowRuntimeError(
					"finalization",
					"Workflow returned an unknown handoff handle.",
				);
			}
			await prepareBarrier("final", [handle])();
			await driveFinalGraph();
			const descriptor = await loadTaskHandoff(handle.ref.taskId);
			if (descriptor === undefined) {
				throw new StaticWorkflowRuntimeError(
					"finalization",
					"Workflow returned the handoff of a task that captured none.",
				);
			}
			value = descriptor;
		} else {
			await prepareBarrier("final", [])();
			await driveFinalGraph();
			value = returned;
		}
		try {
			return await finish(value);
		} catch (error) {
			const failed = await state();
			if (
				failed.status === "created" ||
				failed.status === "running" ||
				failed.status === "waiting" ||
				failed.status === "finalizing"
			) {
				await journal.append("run-status-changed", {
					from: failed.status,
					to: "failed",
					reason: "Workflow output finalization failed.",
				});
			}
			throw error;
		}
	}

	return Object.freeze({
		drive() {
			const predecessor =
				runtimeDrives.get(coordinationKey) ?? Promise.resolve();
			const result = predecessor.then(driveCurrent);
			const settled = result.then(
				() => undefined,
				() => undefined,
			);
			runtimeDrives.set(coordinationKey, settled);
			void settled.then(() => {
				if (runtimeDrives.get(coordinationKey) === settled) {
					runtimeDrives.delete(coordinationKey);
				}
			});
			return result;
		},
	});
}
