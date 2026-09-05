import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Ajv } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import * as addFormatsModule from "ajv-formats";
import type { TSchema } from "typebox";
import type { WorkflowArtifactStore } from "./artifact-store.js";
import type {
	WorkflowArtifactRef,
	WorkflowRunId,
	WorkflowTaskId,
} from "./contracts.js";
import {
	isArtifactHandle,
	isTaskHandle,
	isWorkflowDefinition,
	type TaskHandle,
	validateJsonSchemaDocument,
	type WorkflowContext,
	type WorkflowDefinition,
} from "./definition.js";
import { deriveJsonValueSha256 } from "./execution.js";
import { WorkflowTaskMaterializer } from "./materializer.js";
import type { WorkflowRunJournal } from "./persistence/journal.js";
import { reduceWorkflowEvents } from "./reducer.js";
import type { WorkflowSequentialScheduler } from "./scheduler.js";

const addFormats = (addFormatsModule.default ??
	addFormatsModule) as unknown as FormatsPlugin;
const runtimeDrives = new Map<string, Promise<void>>();

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
		const artifact = Object.values(current.artifacts).find(
			(candidate) =>
				candidate.producerTaskId === taskId && candidate.output === "result",
		);
		if (!artifact) {
			throw new StaticWorkflowRuntimeError(
				"result",
				"Completed workflow task has no result artifact.",
			);
		}
		const value = await artifacts.readJson(artifact);
		if (!validator(task.task.spec.request.outputSchema)(value)) {
			throw new StaticWorkflowRuntimeError(
				"result",
				"Workflow task artifact no longer matches its output schema.",
			);
		}
		return jsonCloneFrozen(value, "Workflow task result");
	}

	async function driveTasks(taskIds: readonly WorkflowTaskId[]): Promise<void> {
		for (;;) {
			const current = await state();
			const pending = taskIds.filter(
				(taskId) => current.tasks[taskId]?.status !== "completed",
			);
			if (pending.length === 0) return;
			for (const taskId of pending) {
				const status = current.tasks[taskId]?.status;
				if (
					status === "failed" ||
					status === "cancelled" ||
					status === "interrupted" ||
					status === "blocked" ||
					status === "cleanup-blocked" ||
					status === "invalidated"
				) {
					throw new StaticWorkflowRuntimeError(
						"execution",
						`Workflow task cannot produce a result: ${status}.`,
					);
				}
			}
			const outcome = await scheduler.drive();
			if (outcome.state === "idle") {
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
				pending.some(
					(taskId) => afterOutcome.tasks[taskId]?.status !== "completed",
				)
			) {
				throw new StaticWorkflowRuntimeError(
					"execution",
					"Workflow scheduler made no durable progress toward the result barrier.",
				);
			}
			if (outcome.state === "terminal") {
				throw new StaticWorkflowRuntimeError(
					"execution",
					`Workflow run terminated before its result barrier: ${outcome.runStatus}.`,
				);
			}
		}
	}

	async function driveFinalGraph(): Promise<void> {
		for (;;) {
			const current = await state();
			const tasks = Object.values(current.tasks);
			const failedRequired = tasks.find(
				(task) =>
					task.task.spec.disposition === "required" &&
					task.status !== "completed" &&
					(task.status === "failed" ||
						task.status === "cancelled" ||
						task.status === "interrupted" ||
						task.status === "blocked" ||
						task.status === "cleanup-blocked" ||
						task.status === "invalidated"),
			);
			if (failedRequired) {
				throw new StaticWorkflowRuntimeError(
					"execution",
					`Required workflow task did not complete: ${failedRequired.status}.`,
				);
			}
			const unsettled = tasks.some(
				(task) =>
					task.status === "pending" ||
					task.status === "ready" ||
					task.status === "running" ||
					task.status === "waiting" ||
					task.status === "cancelling",
			);
			if (!unsettled) return;
			const before = current.lastSequence;
			const outcome = await scheduler.drive();
			const after = await state();
			if (outcome.state === "terminal" && after.status !== "completed") {
				throw new StaticWorkflowRuntimeError(
					"execution",
					`Workflow run terminated while settling its final graph: ${outcome.runStatus}.`,
				);
			}
			if (after.lastSequence === before) {
				throw new StaticWorkflowRuntimeError(
					"execution",
					"Workflow scheduler made no durable progress on the final graph.",
				);
			}
		}
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
			if (current.status === "finalizing") {
				const degraded = Object.values(current.tasks).some(
					(task) =>
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
				value: jsonCloneFrozen(replayed, "Replayed workflow output") as TOutput,
				artifact: existing,
			};
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
		current = await state();
		const degraded = Object.values(current.tasks).some(
			(task) =>
				task.task.spec.disposition === "optional" &&
				task.status !== "completed",
		);
		const status = degraded ? "completed-degraded" : "completed";
		await journal.append("run-status-changed", {
			from: "finalizing",
			to: status,
		});
		return { runId: journal.runId, status, value: output, artifact: ref };
	}

	async function driveCurrent(): Promise<StaticWorkflowRunResult<TOutput>> {
		if (signal.aborted) {
			throw new StaticWorkflowRuntimeError(
				"execution",
				"Workflow execution was aborted.",
			);
		}
		await initialize();
		const previous = await state();
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
		const expectedEffects = previous.effects;
		let effectOrdinal = 0;
		let effectTail = Promise.resolve();
		let barrierTail = Promise.resolve();

		function prepareBarrier(
			kind: "result" | "results" | "final",
			tasks: readonly TaskHandle<unknown>[],
		): () => Promise<void> {
			const effectPrefix = effectTail;
			const effectCount = effectOrdinal;
			const commit = materializer.closeEpoch(kind, tasks);
			const expectedBarrier = previous.barriers.find(
				(barrier) => barrier.epoch === commit.epoch,
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
			const ordinal = effectOrdinal;
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
			result<T>(task: TaskHandle<T>): Promise<T> {
				const commit = prepareBarrier("result", [task]);
				return barrier(async () => {
					await commit();
					await driveTasks([task.ref.taskId]);
					return (await loadTaskResult(task.ref.taskId)) as T;
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
