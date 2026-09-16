import vm from "node:vm";
import type { MessagePort } from "node:worker_threads";
import type { Static, TSchema } from "typebox";
import * as typebox from "typebox";
import { Value } from "typebox/value";
import type { WorkflowHandoffDescriptor } from "../contracts.js";
import {
	DEFAULT_WORKFLOW_CONCURRENCY,
	MAX_WORKFLOW_CONCURRENCY,
	type TaskKey,
	TaskKeySchema,
	WORKFLOW_CONTRACT_REVISION,
	type WorkflowTaskId,
} from "../contracts-core.js";
import {
	type AgentTaskAuthoringRequest,
	type AgentTaskHandle,
	type CheckpointRequest,
	createTaskHandle,
	defineWorkflow,
	type FanInOptions,
	type FanOutOptions,
	type FinalizeRequest,
	isArtifactHandle,
	isHandoffHandle,
	isTaskHandle,
	isWorkflowDefinition,
	type NestedWorkflowRequest,
	type PipelineStage,
	type SettledTaskResult,
	type TaskHandle,
	type WorkflowContext,
	type WorkflowDefinition,
	type WorkspaceAuthoringRequest,
	type WorktreeTaskHandle,
} from "../definition.js";
import {
	defineSupportTask,
	type SupportTaskDescriptor,
	type SupportTaskHelper,
	type SupportTaskHelperOptions,
} from "../support.js";
import { DYNAMIC_VM_CODE_GENERATION } from "./constants.js";
import type {
	DynamicSupportHelperSpec,
	DynamicWorkflowManifest,
} from "./contracts.js";
import {
	type DynamicAsyncMethod,
	type DynamicDoneResult,
	DynamicHostMessageSchema,
	type DynamicStartMessage,
	type DynamicSyncMethod,
	type DynamicTaskHandleRef,
	DynamicTaskHandleRefSchema,
	type DynamicVmError,
	type DynamicVmMessage,
	DynamicWorkflowHostError,
	fromDynamicVmError,
	MSG_BARRIER_TARGET_NOT_HANDLE,
	MSG_HOST_INVALID_HANDLE,
	MSG_HOST_INVALID_MESSAGE,
	MSG_HOST_UNKNOWN_REQUEST,
	MSG_REQUEST_CONTAINS_FUNCTION,
	MSG_RETURN_NOT_JSON,
	MSG_SOURCE_MAY_NOT_REGISTER,
	MSG_STOP_REQUESTED,
	requestDynamicCallSync,
	toDynamicArtifactHandleRef,
	toDynamicTaskHandleRef,
	toDynamicVmError,
} from "./rpc.js";
import { createDynamicImporters } from "./transformer.js";

/*
 * The worker-realm side of the VM (spec 7.4, 7.6): the module table dynamic
 * source imports, the determinism prelude, and the `WorkflowContext` whose
 * declarations are synchronous RPC calls and whose barriers are async
 * replies. Everything here is part of `hostApiSha256`; behavioural changes
 * without a constant change must bump `DYNAMIC_HOST_API_REVISION`.
 */

export type DynamicModuleTable = Readonly<
	Record<string, Readonly<Record<string, unknown>>>
>;

/** Registry string (registry.ts) for a module without a valid default export. */
export const MSG_NO_DEFAULT_DEFINITION =
	"workflow module has no valid default definition";

export class DynamicDefinitionError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DynamicDefinitionError";
	}
}

/** Mirrors the static runtime's validation errors by name; never crosses the RPC. */
class ShimRuntimeError extends Error {
	constructor(
		readonly stage: "validation",
		message: string,
	) {
		super(message);
		this.name = "StaticWorkflowRuntimeError";
	}
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

/**
 * The real `defineSupportTask` (Ajv parameter validation and all its
 * messages) with `registration()` replaced: dynamic source may describe
 * support tasks but never supply implementations.
 */
export function dynamicDefineSupportTask<
	TParametersSchema extends TSchema,
	TOutputSchema extends TSchema,
>(
	options: SupportTaskHelperOptions<TParametersSchema, TOutputSchema>,
): SupportTaskHelper<TParametersSchema, TOutputSchema> {
	const helper = defineSupportTask(options);
	const wrapped = (input: Parameters<typeof helper>[0]) => helper(input);
	return Object.freeze(
		Object.assign(wrapped, helper, {
			registration(): never {
				throw new Error(MSG_SOURCE_MAY_NOT_REGISTER);
			},
		}),
	) as SupportTaskHelper<TParametersSchema, TOutputSchema>;
}

/**
 * `__modules` for the transformer's importers: `@vegardx/pi-workflow` is the
 * real definition module (D3), `typebox` a frozen copy of the namespace, and
 * every support helper spec a `dynamicDefineSupportTask` under its export name.
 */
export function createDynamicModules(
	supportHelpers: readonly DynamicSupportHelperSpec[],
): DynamicModuleTable {
	const modules: Record<string, Readonly<Record<string, unknown>>> = {
		"@vegardx/pi-workflow": Object.freeze({
			DEFAULT_WORKFLOW_CONCURRENCY,
			MAX_WORKFLOW_CONCURRENCY,
			WORKFLOW_CONTRACT_REVISION,
			defineSupportTask: dynamicDefineSupportTask,
			defineWorkflow,
			isArtifactHandle,
			isTaskHandle,
			isWorkflowDefinition,
		}),
		typebox: Object.freeze({ ...typebox }),
	};
	const helpers: Record<string, Record<string, unknown>> = {};
	for (const spec of supportHelpers) {
		const module = helpers[spec.moduleSpecifier] ?? {};
		helpers[spec.moduleSpecifier] = module;
		module[spec.exportName] = dynamicDefineSupportTask({
			name: spec.name,
			moduleSpecifier: spec.moduleSpecifier,
			revision: spec.revision,
			implementationSha256: spec.implementationSha256,
			parametersSchema: spec.parametersSchema as TSchema,
			outputSchema: spec.outputSchema as TSchema,
		});
	}
	for (const [specifier, module] of Object.entries(helpers)) {
		modules[specifier] = Object.freeze(module);
	}
	return Object.freeze(modules);
}

/*
 * Determinism prelude (7.4). Runs inside the context with the run's
 * `epochMs` and `seed`: `Date` fixed for its zero-argument forms and
 * `Date.now()`, `Math.random` an xorshift128+ stream seeded from the first
 * 16 bytes of the seed, `console` a frozen set of no-ops. Not security.
 */
const DYNAMIC_VM_PRELUDE = `(function (epochMs, seed) {
	"use strict";
	const IntrinsicDate = Date;
	const FixedDate = function Date(...args) {
		if (new.target === undefined) return String(new IntrinsicDate(epochMs));
		if (args.length === 0) {
			return Reflect.construct(IntrinsicDate, [epochMs], new.target);
		}
		return Reflect.construct(IntrinsicDate, args, new.target);
	};
	Object.setPrototypeOf(FixedDate, IntrinsicDate);
	Object.defineProperty(FixedDate, "prototype", {
		value: IntrinsicDate.prototype, writable: false, enumerable: false, configurable: false,
	});
	Object.defineProperty(FixedDate, "length", { value: 7, configurable: true });
	Object.defineProperty(FixedDate, "now", {
		value: function now() { return epochMs; }, writable: true, enumerable: false, configurable: true,
	});
	Object.defineProperty(IntrinsicDate.prototype, "constructor", {
		value: FixedDate, writable: true, enumerable: false, configurable: true,
	});
	Object.defineProperty(globalThis, "Date", {
		value: FixedDate, writable: false, enumerable: false, configurable: false,
	});
	const MASK = (1n << 64n) - 1n;
	let s0 = BigInt("0x" + seed.slice(0, 16)) & MASK;
	let s1 = BigInt("0x" + seed.slice(16, 32)) & MASK;
	if (s0 === 0n && s1 === 0n) s1 = 1n;
	Object.defineProperty(Math, "random", {
		value: function random() {
			let x = s0;
			const y = s1;
			s0 = y;
			x ^= (x << 23n) & MASK;
			x ^= x >> 17n;
			x ^= y ^ (y >> 26n);
			s1 = x;
			return Number(((s0 + s1) & MASK) >> 11n) / 9007199254740992;
		},
		writable: true, enumerable: false, configurable: true,
	});
	Object.defineProperty(globalThis, "console", {
		value: Object.freeze({ log() {}, info() {}, warn() {}, error() {}, debug() {} }),
		writable: false, enumerable: false, configurable: false,
	});
})`;

export interface DynamicVmContextOptions {
	readonly filename: string;
	/** `Date.parse(record.createdAt)`; 0 in manifest mode. */
	readonly epochMs: number;
	/** 64 hex chars; `deriveJsonValueSha256({ kind: "dynamic-vm-seed", runId })`. */
	readonly seed: string;
}

/**
 * A context with no host globals, code generation disabled, the prelude
 * applied, and its global sealed: a contextified global cannot be frozen
 * (`Object.freeze(globalThis)` throws "Cannot freeze"), so the sandbox is a
 * proxy that refuses every definition, assignment, and deletion after the
 * prelude, which is what a frozen global observably does in strict code.
 */
export function createDynamicVmContext(
	options: DynamicVmContextOptions,
): vm.Context {
	let sealed = false;
	const refuse = (key: string | symbol): never => {
		throw new TypeError(
			`Cannot add property ${String(key)}, object is not extensible`,
		);
	};
	const sandbox = new Proxy(Object.create(null) as Record<string, unknown>, {
		set(target, key, value, receiver) {
			if (sealed) refuse(key);
			return Reflect.set(target, key, value, receiver);
		},
		defineProperty(target, key, descriptor) {
			if (sealed) refuse(key);
			return Reflect.defineProperty(target, key, descriptor);
		},
		deleteProperty(target, key) {
			if (sealed) refuse(key);
			return Reflect.deleteProperty(target, key);
		},
	});
	const context = vm.createContext(sandbox, {
		codeGeneration: { ...DYNAMIC_VM_CODE_GENERATION },
		name: options.filename,
	});
	const prelude = vm.runInContext(DYNAMIC_VM_PRELUDE, context, {
		filename: `${options.filename}#prelude`,
	}) as (epochMs: number, seed: string) => void;
	prelude(options.epochMs, options.seed);
	sealed = true;
	return context;
}

export interface DynamicSourceEvaluation {
	readonly context: vm.Context;
	/** `transformDynamicSource(...).code`. */
	readonly code: string;
	readonly filename: string;
	readonly modules: DynamicModuleTable;
}

/**
 * Evaluates the wrapped module body (7.3 step 5) and returns its default
 * export. Top-level await is permitted; rejections propagate unchanged.
 */
export async function evaluateDynamicSource(
	options: DynamicSourceEvaluation,
): Promise<unknown> {
	const script = new vm.Script(options.code, { filename: options.filename });
	const factory: unknown = script.runInContext(options.context);
	if (typeof factory !== "function") {
		throw new DynamicDefinitionError(
			"transformed dynamic workflow source is not a module factory",
		);
	}
	const exports: { default?: unknown } = {};
	const { __import, __importNamespace } = createDynamicImporters(
		options.modules,
	);
	await (
		factory as (
			modules: DynamicModuleTable,
			exports: { default?: unknown },
			importValue: typeof __import,
			importNamespace: typeof __importNamespace,
		) => Promise<void>
	)(options.modules, exports, __import, __importNamespace);
	return exports.default;
}

/** registry.ts loader normalisation (7.3 step 6) for the module's default export. */
export function normalizeDynamicDefinition(
	loaded: unknown,
): WorkflowDefinition {
	if (!isWorkflowDefinition(loaded)) {
		throw new DynamicDefinitionError(MSG_NO_DEFAULT_DEFINITION);
	}
	return defineWorkflow({
		meta: loaded.meta,
		inputSchema: loaded.inputSchema,
		outputSchema: loaded.outputSchema,
		run: loaded.run,
	});
}

export function dynamicManifestOf(
	definition: WorkflowDefinition,
): DynamicWorkflowManifest {
	return {
		meta: definition.meta,
		inputSchema:
			definition.inputSchema as DynamicWorkflowManifest["inputSchema"],
		outputSchema:
			definition.outputSchema as DynamicWorkflowManifest["outputSchema"],
	};
}

/*
 * Context and bridge (7.6).
 */

export interface DynamicShimTransport {
	/** Main channel to the host (`parentPort.postMessage`). */
	post(message: DynamicVmMessage): void;
	readonly syncBuffer: SharedArrayBuffer;
	readonly syncPort: MessagePort;
	/** Tests only; defaults to `DYNAMIC_VM_SYNC_WAIT_MS`. */
	readonly syncWaitMs?: number;
}

export interface DynamicVmSession {
	/** Exactly `WorkflowContext`; frozen. */
	readonly context: WorkflowContext<unknown>;
	/** Feed every main-channel host message here. */
	deliver(message: unknown): void;
	/** Runs the definition and posts `done` or `failed` (6.3). */
	run(definition: WorkflowDefinition): Promise<void>;
}

/** Replaces worker-realm handles with refs; refuses functions before the call. */
export function serializeDynamicRequest(value: unknown): unknown {
	if (typeof value === "function") {
		throw new Error(MSG_REQUEST_CONTAINS_FUNCTION);
	}
	if (typeof value !== "object" || value === null) return value;
	if (isTaskHandle(value)) return toDynamicTaskHandleRef(value);
	if (isArtifactHandle(value) || isHandoffHandle(value)) {
		return toDynamicArtifactHandleRef(value);
	}
	if (Array.isArray(value)) return value.map(serializeDynamicRequest);
	const copy: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		copy[key] = serializeDynamicRequest(
			(value as Record<string, unknown>)[key],
		);
	}
	return copy;
}

/** `done.result` for a run's return value (6.3); non-JSON values are refused. */
export function serializeDynamicReturn(value: unknown): DynamicDoneResult {
	if (isTaskHandle(value)) return { kind: "task", ref: { ...value.ref } };
	if (isArtifactHandle(value) || isHandoffHandle(value)) {
		return { kind: "artifact", ref: { ...value.ref } };
	}
	let json: string | undefined;
	try {
		json = JSON.stringify(value);
	} catch {
		throw new Error(MSG_RETURN_NOT_JSON);
	}
	if (json === undefined) throw new Error(MSG_RETURN_NOT_JSON);
	return { kind: "value", value: JSON.parse(json) as unknown };
}

function rebuildTaskHandle(value: unknown): TaskHandle<unknown> {
	if (!Value.Check(DynamicTaskHandleRefSchema, value)) {
		throw new DynamicWorkflowHostError(MSG_HOST_INVALID_HANDLE);
	}
	return value.handoff === undefined
		? createTaskHandle(value.ref, value.output)
		: createTaskHandle(value.ref, value.output, value.handoff);
}

function barrierRef(task: unknown): DynamicTaskHandleRef {
	if (!isTaskHandle(task)) throw new Error(MSG_BARRIER_TARGET_NOT_HANDLE);
	return toDynamicTaskHandleRef(task);
}

export function createVmWorkflowContext(
	start: DynamicStartMessage,
	transport: DynamicShimTransport,
): DynamicVmSession {
	const controller = new AbortController();
	const pending = new Map<
		number,
		{ resolve(value: unknown): void; reject(error: unknown): void }
	>();
	let nextId = 0;
	let finished = false;

	function post(message: DynamicVmMessage): void {
		transport.post(message);
	}

	function fail(error: DynamicVmError): void {
		if (finished) return;
		finished = true;
		post({ type: "failed", error });
	}

	function abortFrom(reason: string): void {
		if (!controller.signal.aborted) controller.abort(new Error(reason));
	}

	function syncCall(method: DynamicSyncMethod, args: unknown[]): unknown {
		nextId += 1;
		const reply = requestDynamicCallSync({
			syncBuffer: transport.syncBuffer,
			syncPort: transport.syncPort,
			post,
			message: { type: "call", id: nextId, method, args },
			...(transport.syncWaitMs === undefined
				? {}
				: { waitMs: transport.syncWaitMs }),
		});
		if (reply.aborted) abortFrom(MSG_STOP_REQUESTED);
		if (reply.ok) return reply.value;
		throw fromDynamicVmError(reply.error);
	}

	function declare(method: DynamicSyncMethod, key: TaskKey, request: unknown) {
		return rebuildTaskHandle(
			syncCall(method, [key, serializeDynamicRequest(request)]),
		);
	}

	function asyncCall(
		method: DynamicAsyncMethod,
		handles: readonly DynamicTaskHandleRef[],
	): Promise<unknown> {
		nextId += 1;
		const id = nextId;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			post({ type: "await", id, method, handles: [...handles] });
		});
	}

	const context: WorkflowContext<unknown> = Object.freeze({
		input: deepFreeze(structuredClone(start.input)),
		runId: start.runId,
		cwd: start.cwd,
		signal: controller.signal,
		phase(name: string): void {
			syncCall("phase", [name]);
		},
		log(message: string): void {
			syncCall("log", [message]);
		},
		agent<
			TOutputSchema extends TSchema,
			TWorkspace extends WorkspaceAuthoringRequest = WorkspaceAuthoringRequest,
		>(
			key: TaskKey,
			request: AgentTaskAuthoringRequest<TOutputSchema, TWorkspace>,
		): AgentTaskHandle<TOutputSchema, TWorkspace> {
			return declare("agent", key, request) as AgentTaskHandle<
				TOutputSchema,
				TWorkspace
			>;
		},
		support<TOutputSchema extends TSchema>(
			key: TaskKey,
			descriptor: SupportTaskDescriptor<TOutputSchema>,
		): TaskHandle<Static<TOutputSchema>> {
			return declare("support", key, descriptor) as TaskHandle<
				Static<TOutputSchema>
			>;
		},
		workflow<TOutput = unknown>(
			key: TaskKey,
			request: NestedWorkflowRequest,
		): TaskHandle<TOutput> {
			return declare("workflow", key, request) as TaskHandle<TOutput>;
		},
		checkpoint<TDecisionSchema extends TSchema>(
			key: TaskKey,
			request: CheckpointRequest<TDecisionSchema>,
		): TaskHandle<Static<TDecisionSchema>> {
			return declare("checkpoint", key, request) as TaskHandle<
				Static<TDecisionSchema>
			>;
		},
		fanOut<
			TItem,
			TOutputSchema extends TSchema,
			TWorkspace extends WorkspaceAuthoringRequest = WorkspaceAuthoringRequest,
		>(
			namespace: TaskKey,
			items: readonly TItem[],
			options: FanOutOptions<TItem, TOutputSchema, TWorkspace>,
		): readonly AgentTaskHandle<TOutputSchema, TWorkspace>[] {
			if (!Value.Check(TaskKeySchema, namespace)) {
				throw new ShimRuntimeError(
					"validation",
					"Workflow fan-out namespace is invalid.",
				);
			}
			if (items.length > 64) {
				throw new ShimRuntimeError(
					"validation",
					"Workflow fan-out exceeds 64 items.",
				);
			}
			if (
				!options ||
				typeof options.key !== "function" ||
				typeof options.task !== "function"
			) {
				throw new ShimRuntimeError(
					"validation",
					"Workflow fan-out options are invalid.",
				);
			}
			const created = items.map(
				(item, index) =>
					rebuildTaskHandle(
						syncCall("agentInNamespace", [
							[namespace],
							options.key(item, index),
							serializeDynamicRequest(options.task(item, index)),
						]),
					) as AgentTaskHandle<TOutputSchema, TWorkspace>,
			);
			return Object.freeze(created);
		},
		fanIn<
			TSource,
			TOutputSchema extends TSchema,
			TWorkspace extends WorkspaceAuthoringRequest = WorkspaceAuthoringRequest,
		>(
			key: TaskKey,
			sources: readonly TaskHandle<TSource>[],
			options: FanInOptions<TSource, TOutputSchema, TWorkspace>,
		): AgentTaskHandle<TOutputSchema, TWorkspace> {
			if (sources.length < 1 || sources.length > 64) {
				throw new ShimRuntimeError(
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
				throw new ShimRuntimeError(
					"validation",
					"Workflow fan-in options are invalid.",
				);
			}
			const entries = sources.map(
				(source, index) =>
					[options.inputKey(source, index), source.output] as const,
			);
			if (new Set(entries.map(([name]) => name)).size !== entries.length) {
				throw new ShimRuntimeError(
					"validation",
					"Workflow fan-in input keys must be unique.",
				);
			}
			return declare("agent", key, {
				...options.task,
				inputs: Object.fromEntries(entries),
			}) as AgentTaskHandle<TOutputSchema, TWorkspace>;
		},
		pipeline<T>(
			namespace: TaskKey,
			build: (stage: PipelineStage) => TaskHandle<T>,
		): TaskHandle<T> {
			if (
				!Value.Check(TaskKeySchema, namespace) ||
				typeof build !== "function"
			) {
				throw new ShimRuntimeError(
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
					key: TaskKey,
					request: AgentTaskAuthoringRequest<TOutputSchema, TWorkspace>,
				): AgentTaskHandle<TOutputSchema, TWorkspace> {
					if (created.size >= 64) {
						throw new ShimRuntimeError(
							"validation",
							"Workflow pipeline exceeds 64 stages.",
						);
					}
					const handle = rebuildTaskHandle(
						syncCall("agentInNamespace", [
							[namespace],
							key,
							serializeDynamicRequest(request),
						]),
					);
					created.add(handle.ref.taskId);
					return handle as AgentTaskHandle<TOutputSchema, TWorkspace>;
				},
			});
			const final = build(stage);
			if (!isTaskHandle(final) || !created.has(final.ref.taskId)) {
				throw new ShimRuntimeError(
					"validation",
					"Workflow pipeline must return one of its stage handles.",
				);
			}
			return final;
		},
		finalize<
			TOutputSchema extends TSchema,
			TWorkspace extends WorkspaceAuthoringRequest = WorkspaceAuthoringRequest,
		>(
			key: TaskKey,
			request: FinalizeRequest<TOutputSchema, TWorkspace>,
		): AgentTaskHandle<TOutputSchema, TWorkspace> {
			return declare("finalize", key, request) as AgentTaskHandle<
				TOutputSchema,
				TWorkspace
			>;
		},
		result<T>(task: TaskHandle<T>): Promise<T> {
			return asyncCall("result", [barrierRef(task)]) as Promise<T>;
		},
		handoff<T>(
			task: WorktreeTaskHandle<T>,
		): Promise<WorkflowHandoffDescriptor | undefined> {
			if (
				!isTaskHandle(task) ||
				!isHandoffHandle(task.handoff) ||
				task.handoff.ref.producerTaskId !== task.ref.taskId
			) {
				throw new ShimRuntimeError(
					"validation",
					"Workflow handoff barrier requires a worktree task handle.",
				);
			}
			return asyncCall("handoff", [toDynamicTaskHandleRef(task)]) as Promise<
				WorkflowHandoffDescriptor | undefined
			>;
		},
		results<const T extends readonly TaskHandle<unknown>[]>(
			tasks: T,
		): Promise<{
			[K in keyof T]: T[K] extends TaskHandle<infer V> ? V : never;
		}> {
			return asyncCall("results", tasks.map(barrierRef)) as Promise<{
				[K in keyof T]: T[K] extends TaskHandle<infer V> ? V : never;
			}>;
		},
		settled<const T extends readonly TaskHandle<unknown>[]>(
			tasks: T,
		): Promise<{
			[K in keyof T]: T[K] extends TaskHandle<infer V>
				? SettledTaskResult<V>
				: never;
		}> {
			return asyncCall("settled", tasks.map(barrierRef)) as Promise<{
				[K in keyof T]: T[K] extends TaskHandle<infer V>
					? SettledTaskResult<V>
					: never;
			}>;
		},
	});

	return Object.freeze({
		context,
		deliver(message: unknown): void {
			if (finished) return;
			if (!Value.Check(DynamicHostMessageSchema, message)) {
				fail({
					name: "DynamicWorkflowHostError",
					message: MSG_HOST_INVALID_MESSAGE,
				});
				return;
			}
			switch (message.type) {
				case "abort":
					abortFrom(message.reason);
					return;
				case "reply": {
					const waiter = pending.get(message.id);
					if (!waiter) {
						fail({
							name: "DynamicWorkflowHostError",
							message: MSG_HOST_UNKNOWN_REQUEST,
						});
						return;
					}
					pending.delete(message.id);
					if (message.aborted) abortFrom(MSG_STOP_REQUESTED);
					if (message.ok) waiter.resolve(deepFreeze(message.value));
					else waiter.reject(fromDynamicVmError(message.error));
					return;
				}
				case "start":
					// One-way and already consumed by the worker bootstrap.
					return;
			}
		},
		async run(definition: WorkflowDefinition): Promise<void> {
			try {
				const returned: unknown = await Promise.resolve().then(() =>
					definition.run(context),
				);
				const result = serializeDynamicReturn(returned);
				if (finished) return;
				finished = true;
				post({ type: "done", result });
			} catch (error) {
				fail(toDynamicVmError(error));
			}
		},
	});
}
