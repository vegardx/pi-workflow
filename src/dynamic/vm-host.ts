import { type ResourceLimits, Worker } from "node:worker_threads";
import { Value } from "typebox/value";
import type { TaskKey } from "../contracts.js";
import type {
	ArtifactHandle,
	HandoffHandle,
	TaskHandle,
	WorkflowContext,
	WorktreeTaskHandle,
} from "../definition.js";
import {
	isStaticWorkflowParkSignal,
	type WorkflowHostBridge,
	workflowHostBridge,
} from "../static-runtime.js";
import {
	DYNAMIC_VM_ABORT_GRACE_MS,
	DYNAMIC_VM_BOOT_TIMEOUT_MS,
	DYNAMIC_VM_COMPUTE_TIMEOUT_MS,
	DYNAMIC_VM_MANIFEST_TIMEOUT_MS,
	DYNAMIC_VM_RESOURCE_LIMITS,
} from "./constants.js";
import type {
	DynamicSupportHelperSpec,
	DynamicWorkflowManifest,
} from "./contracts.js";
import {
	DYNAMIC_ABORT_ERROR_NAME,
	DYNAMIC_BOOT_ERROR_NAME,
	DYNAMIC_SYNC_WAIT_ARGV_PREFIX,
	DynamicWorkflowExecutionError,
} from "./execution-error.js";
import {
	answerDynamicCallSync,
	boundDynamicReply,
	checkDynamicCallArgs,
	createDynamicSyncChannel,
	createDynamicVmMessageGuard,
	DynamicArtifactHandleRefSchema,
	type DynamicAwaitMessage,
	type DynamicCallMessage,
	type DynamicDoneResult,
	type DynamicHostMessage,
	type DynamicReplyMessage,
	type DynamicStartMessage,
	type DynamicTaskHandleRef,
	DynamicTaskHandleRefSchema,
	type DynamicVmError,
	type DynamicWorkerData,
	DynamicWorkflowHostError,
	fromDynamicVmError,
	MSG_CALL_ARGS_INVALID,
	MSG_RETURNED_UNKNOWN_TASK_HANDLE,
	MSG_STOP_REQUESTED,
	MSG_UNKNOWN_TASK_HANDLE,
	MSG_VM_INVALID_MESSAGE,
	toDynamicTaskHandleRef,
	toDynamicVmError,
	WorkflowDynamicProtocolError,
} from "./rpc.js";
import { deriveDynamicSourceSha256 } from "./source.js";

/*
 * Host side of the VM (spec sections 6 and 8): spawns `worker.ts`, admits its
 * messages through the RPC guard, serves declarations synchronously and
 * barriers asynchronously from the static-runtime context, mirrors abort in
 * both directions, runs the watchdogs, and always terminates the worker.
 */

const MAX_FAILURE_REASON_CHARS = 4096;
const OUT_OF_MEMORY_CODE = "ERR_WORKER_OUT_OF_MEMORY";

/** Manifest-mode `start` values (spec 7.4). */
export const DYNAMIC_MANIFEST_RUN_ID = "workflow_manifest";
export const DYNAMIC_MANIFEST_SEED = "0".repeat(64);

export const MSG_BRIDGE_REQUIRES_STATIC_CONTEXT =
	"Dynamic workflow bridge requires the static runtime context.";
export const MSG_EXECUTION_ABORTED = "Dynamic workflow execution was aborted.";
export const MSG_MANIFEST_CHANGED =
	"Dynamic workflow manifest changed since approval.";
export const MSG_VM_OUT_OF_MEMORY =
	"Dynamic workflow VM exceeded its memory limit.";
export const MSG_VM_ALREADY_RAN = "Dynamic workflow VM has already run.";
/**
 * Fixed reason for a worker `error` event or a host fault outside the bridge:
 * such messages can carry file system paths (`ERR_MODULE_NOT_FOUND`, fs
 * errors), which never reach the journal; the cause stays on the thrown error.
 */
export const MSG_VM_CRASHED = "Dynamic workflow VM crashed.";

export function bootTimeoutMessage(ms: number): string {
	return `Dynamic workflow VM did not boot within ${ms} ms.`;
}
export function computeTimeoutMessage(ms: number): string {
	return `Dynamic workflow VM exceeded ${ms} ms of compute between host messages.`;
}
export function unexpectedExitMessage(code: number): string {
	return `Dynamic workflow VM exited unexpectedly with code ${code}.`;
}
export function transformFailureMessage(message: string): string {
	return `Dynamic workflow source failed to transform: ${message}`.slice(
		0,
		MAX_FAILURE_REASON_CHARS,
	);
}
export function bootFailureMessage(message: string): string {
	return `Dynamic workflow VM failed to boot: ${message}`.slice(
		0,
		MAX_FAILURE_REASON_CHARS,
	);
}
export function sourceFailureMessage(error: DynamicVmError): string {
	return `Dynamic workflow source execution failed: ${error.name}: ${error.message}`.slice(
		0,
		MAX_FAILURE_REASON_CHARS,
	);
}

/**
 * Maps a VM `failed` message to its stage (spec 8 step 8). Transform errors
 * keep their own stage; a bootstrap failure before the transform (invalid
 * workerData, missing `start`, transformer version mismatch) is a host defect
 * and reports as stage "boot" rather than blaming the source. A worker that
 * saw the host's `abort` before `ready` reports stage "abort", but only when
 * the host did abort (`options.aborted`); otherwise the name is the source's
 * and maps like any other source failure.
 */
export function executionErrorFromVmFailure(
	error: DynamicVmError,
	options: { readonly aborted?: boolean } = {},
): DynamicWorkflowExecutionError {
	const cause = fromDynamicVmError(error);
	if (error.name === DYNAMIC_ABORT_ERROR_NAME && options.aborted === true) {
		return new DynamicWorkflowExecutionError("abort", MSG_EXECUTION_ABORTED, {
			cause,
		});
	}
	if (error.name === "DynamicTransformError") {
		return new DynamicWorkflowExecutionError(
			"transform",
			transformFailureMessage(error.message),
			{ cause },
		);
	}
	if (error.name === DYNAMIC_BOOT_ERROR_NAME) {
		return new DynamicWorkflowExecutionError(
			"boot",
			bootFailureMessage(error.message),
			{ cause },
		);
	}
	return new DynamicWorkflowExecutionError(
		"source",
		sourceFailureMessage(error),
		{ cause },
	);
}

/** Abort reason forwarded to the VM (spec 6.4), bounded to the schema. */
export function abortReasonOf(signal: AbortSignal): string {
	const reason = signal.reason as { message?: unknown } | undefined;
	const message =
		typeof reason === "object" && reason !== null ? reason.message : undefined;
	const text =
		message === undefined || message === null
			? MSG_STOP_REQUESTED
			: String(message);
	const bounded = text.slice(0, 4096);
	return bounded.length > 0 ? bounded : MSG_STOP_REQUESTED;
}

/*
 * Dispatcher: the pure host half of section 6 over one static context.
 */

export interface DynamicHostDispatcherOptions {
	readonly context: WorkflowContext<unknown>;
	readonly bridge: WorkflowHostBridge;
	/** Read at reply time; defaults to `context.signal.aborted`. */
	readonly aborted?: () => boolean;
}

export interface DynamicHostDispatcher {
	/** Every handle returned to the VM, by task id (spec 8 step 5). */
	readonly handles: ReadonlyMap<string, TaskHandle<unknown>>;
	/**
	 * Answers a `call` synchronously: validation, ref resolution, and the
	 * context method all run inside this call (deadlock rule R1). Thrown
	 * errors become reply errors with their names preserved.
	 */
	call(message: DynamicCallMessage): DynamicReplyMessage;
	/**
	 * Answers an `await`: resolves to the bounded reply (ok or error). It
	 * rejects only with the static runtime's park signal, which the caller
	 * must not forward to the VM (spec 8 step 7).
	 */
	await(message: DynamicAwaitMessage): Promise<DynamicReplyMessage>;
	/** Resolves `done.result` to the value `run()` returns (spec 6.3). */
	done(result: DynamicDoneResult): unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Argument admission before dispatch. `phase` and `log` are admitted on type
 * alone so the static context produces its own exact validation messages
 * (`Workflow phase must contain 1 to 128 characters.`, `Workflow log must
 * contain 1 to 4096 characters.`): the per-method schema of section 6 would
 * otherwise answer an over-long string with `MSG_CALL_ARGS_INVALID` and break
 * the one-message parity the shim documents. Every other method is checked
 * against `DYNAMIC_SYNC_CALL_ARGS_SCHEMAS` exactly.
 */
function admitsCallArgs(message: DynamicCallMessage): boolean {
	if (message.method === "phase" || message.method === "log") {
		return message.args.length === 1 && typeof message.args[0] === "string";
	}
	return checkDynamicCallArgs(message.method, message.args);
}

export function createDynamicHostDispatcher(
	options: DynamicHostDispatcherOptions,
): DynamicHostDispatcher {
	const { context, bridge } = options;
	const aborted = options.aborted ?? (() => context.signal.aborted);
	const handles = new Map<string, TaskHandle<unknown>>();

	function remember(handle: TaskHandle<unknown>): DynamicTaskHandleRef {
		handles.set(handle.ref.taskId, handle);
		return toDynamicTaskHandleRef(handle);
	}

	function unknownHandle(): never {
		throw new DynamicWorkflowHostError(MSG_UNKNOWN_TASK_HANDLE);
	}

	function resolveTaskHandle(ref: DynamicTaskHandleRef): TaskHandle<unknown> {
		const handle = handles.get(ref.ref.taskId);
		if (
			!handle ||
			handle.ref.runId !== ref.ref.runId ||
			handle.output.ref.producerTaskId !== ref.output.producerTaskId ||
			(ref.handoff !== undefined && handle.handoff === undefined)
		) {
			return unknownHandle();
		}
		return handle;
	}

	function resolveArtifactHandle(ref: {
		readonly runId: string;
		readonly producerTaskId: string;
		readonly output: "result" | "handoff";
	}): ArtifactHandle<unknown> | HandoffHandle {
		const handle = handles.get(ref.producerTaskId);
		if (!handle || handle.ref.runId !== ref.runId) return unknownHandle();
		if (ref.output === "handoff") {
			return handle.handoff === undefined ? unknownHandle() : handle.handoff;
		}
		return handle.output;
	}

	/** Walks plain objects and arrays replacing wire refs with real handles. */
	function resolveRefs(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(resolveRefs);
		if (!isPlainObject(value)) return value;
		if (Value.Check(DynamicTaskHandleRefSchema, value)) {
			return resolveTaskHandle(value);
		}
		if (Value.Check(DynamicArtifactHandleRefSchema, value)) {
			return resolveArtifactHandle(value.ref);
		}
		const copy: Record<string, unknown> = {};
		for (const key of Object.keys(value)) copy[key] = resolveRefs(value[key]);
		return copy;
	}

	function dispatchCall(message: DynamicCallMessage): unknown {
		if (!admitsCallArgs(message)) {
			throw new DynamicWorkflowHostError(MSG_CALL_ARGS_INVALID);
		}
		const [first, second, third] = message.args;
		switch (message.method) {
			case "phase":
				context.phase(first as string);
				return null;
			case "log":
				context.log(first as string);
				return null;
			case "agent":
				return remember(
					context.agent(first as TaskKey, resolveRefs(second) as never),
				);
			case "agentInNamespace":
				return remember(
					bridge.agentInNamespace(
						first as readonly TaskKey[],
						second as TaskKey,
						resolveRefs(third) as never,
					),
				);
			case "support":
				return remember(
					context.support(first as TaskKey, resolveRefs(second) as never),
				);
			case "workflow":
				return remember(
					context.workflow(first as TaskKey, resolveRefs(second) as never),
				);
			case "checkpoint":
				return remember(
					context.checkpoint(first as TaskKey, resolveRefs(second) as never),
				);
			case "finalize":
				return remember(
					context.finalize(first as TaskKey, resolveRefs(second) as never),
				);
		}
	}

	/** Reply errors carry `name` and `message` only; host stacks stay host-side. */
	function errorReply(id: number, error: unknown): DynamicReplyMessage {
		const { name, message } = toDynamicVmError(error);
		return {
			type: "reply",
			id,
			ok: false,
			error: { name, message },
			aborted: aborted(),
		};
	}

	async function dispatchAwait(message: DynamicAwaitMessage): Promise<unknown> {
		const targets = message.handles.map(resolveTaskHandle);
		switch (message.method) {
			case "result": {
				if (targets.length !== 1) {
					throw new DynamicWorkflowHostError(MSG_CALL_ARGS_INVALID);
				}
				return context.result(targets[0] as TaskHandle<unknown>);
			}
			case "handoff": {
				if (targets.length !== 1) {
					throw new DynamicWorkflowHostError(MSG_CALL_ARGS_INVALID);
				}
				return context.handoff(targets[0] as WorktreeTaskHandle<unknown>);
			}
			case "results":
				return context.results(targets);
			case "settled":
				return context.settled(targets);
		}
	}

	return Object.freeze({
		handles,
		call(message: DynamicCallMessage): DynamicReplyMessage {
			let value: unknown;
			try {
				value = dispatchCall(message);
			} catch (error) {
				return errorReply(message.id, error);
			}
			return boundDynamicReply({
				type: "reply",
				id: message.id,
				ok: true,
				value,
				aborted: aborted(),
			});
		},
		async await(message: DynamicAwaitMessage): Promise<DynamicReplyMessage> {
			let value: unknown;
			try {
				value = await dispatchAwait(message);
			} catch (error) {
				if (isStaticWorkflowParkSignal(error)) throw error;
				return errorReply(message.id, error);
			}
			return boundDynamicReply({
				type: "reply",
				id: message.id,
				ok: true,
				value,
				aborted: aborted(),
			});
		},
		done(result: DynamicDoneResult): unknown {
			const unknownReturn = (): never => {
				throw new DynamicWorkflowExecutionError(
					"protocol",
					MSG_RETURNED_UNKNOWN_TASK_HANDLE,
				);
			};
			switch (result.kind) {
				case "value":
					return result.value;
				case "task": {
					const handle = handles.get(result.ref.taskId);
					if (!handle || handle.ref.runId !== result.ref.runId) {
						return unknownReturn();
					}
					return handle;
				}
				case "artifact": {
					const handle = handles.get(result.ref.producerTaskId);
					if (!handle || handle.ref.runId !== result.ref.runId) {
						return unknownReturn();
					}
					if (result.ref.output === "handoff") {
						return handle.handoff === undefined
							? unknownReturn()
							: handle.handoff;
					}
					return handle.output;
				}
			}
		},
	});
}

/*
 * Worker plumbing.
 */

/**
 * `bootTimeoutMs` and `computeTimeoutMs` are set from the service's `dynamic`
 * option; `resourceLimits`, `syncWaitMs`, and `workerEntry` are tests only and
 * never set by the service (spec 8).
 */
export interface DynamicVmBridgeOverrides {
	readonly resourceLimits?: ResourceLimits;
	/** Boot watchdog for manifest extraction and every run drive. */
	readonly bootTimeoutMs?: number;
	readonly computeTimeoutMs?: number;
	readonly syncWaitMs?: number;
	/** Alternative worker entry (protocol tests boot a rogue worker). */
	readonly workerEntry?: URL;
}

/** Worker entry resolution (spec 7.1): source checkouts run `worker.ts` under tsx. */
export function resolveDynamicWorkerEntry(): {
	readonly entry: URL;
	readonly execArgv: readonly string[];
} {
	const compiled = new URL("./worker.js", import.meta.url);
	if (import.meta.url.endsWith(".ts") || compiled.pathname.endsWith(".ts")) {
		return {
			entry: new URL("./worker.ts", import.meta.url),
			execArgv: ["--import", "tsx"],
		};
	}
	return { entry: compiled, execArgv: [] };
}

interface SpawnOptions {
	readonly mode: DynamicWorkerData["mode"];
	readonly source: string;
	readonly sourceSha256: string;
	readonly supportHelpers: readonly DynamicSupportHelperSpec[];
	readonly overrides: DynamicVmBridgeOverrides | undefined;
}

function spawnDynamicWorker(options: SpawnOptions): {
	readonly worker: Worker;
	readonly channel: ReturnType<typeof createDynamicSyncChannel>;
} {
	const channel = createDynamicSyncChannel();
	const resolved = resolveDynamicWorkerEntry();
	const entry = options.overrides?.workerEntry ?? resolved.entry;
	const execArgv = entry.pathname.endsWith(".ts")
		? ["--import", "tsx"]
		: resolved.execArgv;
	const data: DynamicWorkerData = {
		mode: options.mode,
		source: options.source,
		sourceSha256: options.sourceSha256,
		filename: `dynamic:${options.sourceSha256}.workflow.ts`,
		supportHelpers: options.supportHelpers.map((helper) => ({ ...helper })),
		syncBuffer: channel.syncBuffer,
		syncPort: channel.workerPort,
	};
	const syncWaitMs = options.overrides?.syncWaitMs;
	const worker = new Worker(entry, {
		workerData: data,
		transferList: [channel.workerPort],
		resourceLimits: {
			...(options.overrides?.resourceLimits ?? DYNAMIC_VM_RESOURCE_LIMITS),
		},
		stdout: true,
		stderr: true,
		env: {},
		execArgv: [...execArgv],
		...(syncWaitMs === undefined
			? {}
			: { argv: [`${DYNAMIC_SYNC_WAIT_ARGV_PREFIX}${syncWaitMs}`] }),
		name: `pi-workflow-dynamic:${options.sourceSha256.slice(0, 12)}`,
	});
	// Captured output is drained and discarded: VM output never reaches the
	// Pi terminal (spec 7.2).
	worker.stdout.resume();
	worker.stderr.resume();
	channel.hostPort.unref();
	return { worker, channel };
}

interface DriveOptions extends SpawnOptions {
	readonly start: DynamicStartMessage;
	readonly bootTimeoutMs: number;
	readonly computeTimeoutMs: number;
	/** Absent in manifest mode: the drive settles on `ready`. */
	readonly session?: {
		readonly context: WorkflowContext<unknown>;
		readonly dispatcher: DynamicHostDispatcher;
	};
	readonly onBoot?: ((info: { readonly threadId: number }) => void) | undefined;
	readonly onReady?: ((manifest: DynamicWorkflowManifest) => void) | undefined;
}

interface Drive<T> {
	readonly settled: Promise<T>;
	terminate(): Promise<void>;
}

/**
 * One worker lifetime: spawn, `start`, message loop, watchdogs, abort
 * mirroring. `settled` never resolves before every timer is cleared; the
 * caller terminates the worker in its own `finally`.
 */
function driveDynamicWorker<T>(options: DriveOptions): Drive<T> {
	let settled = false;
	let terminating: Promise<void> | undefined;
	const timers = new Set<NodeJS.Timeout>();
	let resolveDrive!: (value: T) => void;
	let rejectDrive!: (error: unknown) => void;
	const drive = new Promise<T>((resolve, reject) => {
		resolveDrive = resolve;
		rejectDrive = reject;
	});

	const { worker, channel } = spawnDynamicWorker(options);
	const signal = options.session?.context.signal;

	function clearTimers(): void {
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
	}
	function arm(ms: number, fire: () => void): NodeJS.Timeout {
		const timer = setTimeout(() => {
			timers.delete(timer);
			fire();
		}, ms);
		timer.unref();
		timers.add(timer);
		return timer;
	}
	function settle(outcome: () => void): void {
		if (settled) return;
		settled = true;
		clearTimers();
		signal?.removeEventListener("abort", onAbort);
		outcome();
	}
	const fail = (error: unknown): void => settle(() => rejectDrive(error));
	const succeed = (value: T): void => settle(() => resolveDrive(value));

	function terminate(): Promise<void> {
		terminating ??= (async () => {
			clearTimers();
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			try {
				await worker.terminate();
			} finally {
				channel.hostPort.close();
			}
		})();
		return terminating;
	}

	// Watchdogs (spec 6.5).
	let bootTimer: NodeJS.Timeout | undefined = arm(options.bootTimeoutMs, () =>
		fail(
			new DynamicWorkflowExecutionError(
				"boot",
				bootTimeoutMessage(options.bootTimeoutMs),
			),
		),
	);
	let computeTimer: NodeJS.Timeout | undefined;
	let owed = 0;
	function clearCompute(): void {
		if (computeTimer === undefined) return;
		clearTimeout(computeTimer);
		timers.delete(computeTimer);
		computeTimer = undefined;
	}
	function armCompute(): void {
		clearCompute();
		if (settled || owed > 0) return;
		computeTimer = arm(options.computeTimeoutMs, () => {
			computeTimer = undefined;
			fail(
				new DynamicWorkflowExecutionError(
					"watchdog",
					computeTimeoutMessage(options.computeTimeoutMs),
				),
			);
		});
	}

	// Abort mirroring (spec 6.4).
	function onAbort(): void {
		if (settled) return;
		post({ type: "abort", reason: abortReasonOf(signal as AbortSignal) });
		arm(DYNAMIC_VM_ABORT_GRACE_MS, () =>
			fail(new DynamicWorkflowExecutionError("abort", MSG_EXECUTION_ABORTED)),
		);
	}
	signal?.addEventListener("abort", onAbort, { once: true });

	function post(message: DynamicHostMessage): void {
		if (settled) return;
		worker.postMessage(message);
	}

	const guard = createDynamicVmMessageGuard();
	let ready = false;

	function onMessage(raw: unknown): void {
		if (settled) return;
		clearCompute();
		let message: ReturnType<typeof guard.accept>;
		try {
			message = guard.accept(raw);
		} catch (error) {
			fail(protocolError(error));
			return;
		}
		if (
			message.type === "ready" ? ready : message.type !== "failed" && !ready
		) {
			// A second `ready`, or anything but `failed` before `ready`, is out
			// of protocol.
			fail(
				new DynamicWorkflowExecutionError("protocol", MSG_VM_INVALID_MESSAGE),
			);
			return;
		}
		switch (message.type) {
			case "ready": {
				ready = true;
				if (bootTimer !== undefined) {
					clearTimeout(bootTimer);
					timers.delete(bootTimer);
					bootTimer = undefined;
				}
				try {
					options.onReady?.(message.manifest);
				} catch (error) {
					fail(error);
					return;
				}
				if (!options.session) {
					succeed(message.manifest as T);
					return;
				}
				armCompute();
				return;
			}
			case "call": {
				const session = options.session as NonNullable<DriveOptions["session"]>;
				// R1: answered synchronously inside the handler, no awaits.
				const reply = session.dispatcher.call(message);
				answerDynamicCallSync(channel, reply);
				guard.answered(message.id);
				armCompute();
				return;
			}
			case "await": {
				const session = options.session as NonNullable<DriveOptions["session"]>;
				owed += 1;
				session.dispatcher.await(message).then(
					(reply) => {
						owed -= 1;
						if (settled) return;
						post(reply);
						armCompute();
					},
					(error: unknown) => {
						owed -= 1;
						// Only the park signal reaches here: stop answering, end the
						// worker, and let the static runtime park the run.
						fail(error);
					},
				);
				return;
			}
			case "done": {
				const session = options.session as NonNullable<DriveOptions["session"]>;
				try {
					succeed(session.dispatcher.done(message.result) as T);
				} catch (error) {
					fail(error);
				}
				return;
			}
			case "failed":
				fail(
					executionErrorFromVmFailure(message.error, {
						aborted: signal?.aborted === true,
					}),
				);
				return;
		}
	}

	worker.on("message", onMessage);
	worker.on("messageerror", () =>
		fail(new DynamicWorkflowExecutionError("protocol", MSG_VM_INVALID_MESSAGE)),
	);
	worker.on("error", (error: Error & { code?: unknown }) => {
		if (error.code === OUT_OF_MEMORY_CODE) {
			fail(
				new DynamicWorkflowExecutionError("memory", MSG_VM_OUT_OF_MEMORY, {
					cause: error,
				}),
			);
			return;
		}
		fail(
			new DynamicWorkflowExecutionError("exit", MSG_VM_CRASHED, {
				cause: error,
			}),
		);
	});
	worker.on("exit", (code) => {
		fail(
			new DynamicWorkflowExecutionError("exit", unexpectedExitMessage(code)),
		);
	});

	options.onBoot?.({ threadId: worker.threadId });
	post(options.start);

	return { settled: drive, terminate };
}

function protocolError(error: unknown): DynamicWorkflowExecutionError {
	if (error instanceof WorkflowDynamicProtocolError) {
		return new DynamicWorkflowExecutionError("protocol", error.message, {
			cause: error,
		});
	}
	return new DynamicWorkflowExecutionError("protocol", MSG_VM_INVALID_MESSAGE, {
		cause: error,
	});
}

function hostBridgeOf(
	context: WorkflowContext<unknown>,
): WorkflowHostBridge | undefined {
	const bridge = (
		context as Partial<Record<typeof workflowHostBridge, unknown>>
	)[workflowHostBridge];
	if (
		typeof bridge !== "object" ||
		bridge === null ||
		typeof (bridge as WorkflowHostBridge).agentInNamespace !== "function"
	) {
		return undefined;
	}
	return bridge as WorkflowHostBridge;
}

export interface DynamicVmOptions {
	readonly source: string;
	/** Derived from `source` when omitted. */
	readonly sourceSha256?: string;
	readonly supportHelpers: readonly DynamicSupportHelperSpec[];
	/** `Date.parse(record.createdAt)` (spec 7.4). */
	readonly epochMs: number;
	/** `deriveJsonValueSha256({ kind: "dynamic-vm-seed", runId })` (spec 7.4). */
	readonly seed: string;
	readonly overrides?: DynamicVmBridgeOverrides;
	/** Called once the worker exists (tests: a fresh worker per drive). */
	readonly onBoot?: (info: { readonly threadId: number }) => void;
	/**
	 * Called on `ready` with the VM's manifest; throwing fails the run with the
	 * thrown error (the definition bridge raises `MSG_MANIFEST_CHANGED` here).
	 */
	readonly onReady?: (manifest: DynamicWorkflowManifest) => void;
}

export interface DynamicVm {
	/**
	 * Boots one run-mode worker, posts `start` from `context` (`input`,
	 * `runId`, `cwd`) and the options (`seed`, `epochMs`), drives it against
	 * `context` (the static-runtime context carrying `workflowHostBridge`), and
	 * resolves with the source's return value resolved per spec 6.3. Rejects
	 * with a `DynamicWorkflowExecutionError` for every VM failure class, or
	 * with the static runtime's park signal unchanged. The worker is always
	 * terminated before settlement. May be called once.
	 */
	run(context: WorkflowContext<unknown>): Promise<unknown>;
	/** Ends the worker now (idempotent, safe before and after `run`). */
	terminate(): Promise<void>;
}

async function settleDrive<T>(current: Drive<T>): Promise<T> {
	try {
		return await current.settled;
	} finally {
		await current.terminate();
	}
}

/** Spec 7.1 `createDynamicVm`: the host of one run-mode worker (one per drive). */
export function createDynamicVm(options: DynamicVmOptions): DynamicVm {
	const sourceSha256 =
		options.sourceSha256 ?? deriveDynamicSourceSha256(options.source);
	let drive: Drive<unknown> | undefined;
	let ran = false;
	let closed = false;
	return Object.freeze({
		async run(context: WorkflowContext<unknown>): Promise<unknown> {
			if (ran) throw new Error(MSG_VM_ALREADY_RAN);
			ran = true;
			if (context.signal.aborted) {
				throw new DynamicWorkflowExecutionError("abort", MSG_EXECUTION_ABORTED);
			}
			const bridge = hostBridgeOf(context);
			if (!bridge) {
				throw new DynamicWorkflowExecutionError(
					"protocol",
					MSG_BRIDGE_REQUIRES_STATIC_CONTEXT,
				);
			}
			if (closed) {
				throw new DynamicWorkflowExecutionError("abort", MSG_EXECUTION_ABORTED);
			}
			const dispatcher = createDynamicHostDispatcher({ context, bridge });
			const current = driveDynamicWorker<unknown>({
				mode: "run",
				source: options.source,
				sourceSha256,
				supportHelpers: options.supportHelpers,
				overrides: options.overrides,
				start: {
					type: "start",
					input: context.input,
					runId: context.runId,
					cwd: context.cwd,
					seed: options.seed,
					epochMs: options.epochMs,
				},
				bootTimeoutMs:
					options.overrides?.bootTimeoutMs ?? DYNAMIC_VM_BOOT_TIMEOUT_MS,
				computeTimeoutMs:
					options.overrides?.computeTimeoutMs ?? DYNAMIC_VM_COMPUTE_TIMEOUT_MS,
				session: { context, dispatcher },
				onBoot: options.onBoot,
				onReady: options.onReady,
			});
			drive = current;
			return settleDrive(current);
		},
		async terminate(): Promise<void> {
			closed = true;
			await drive?.terminate();
		},
	});
}

export interface ExtractDynamicWorkflowManifestOptions {
	readonly source: string;
	readonly supportHelpers: readonly DynamicSupportHelperSpec[];
	/** Defaults to the SHA-256 of the UTF-8 source bytes. */
	readonly sourceSha256?: string;
	readonly overrides?: DynamicVmBridgeOverrides;
	readonly onBoot?: (info: { readonly threadId: number }) => void;
}

/**
 * Propose path (spec 3.2 step 7): boots a manifest-mode worker to `ready`
 * (boot watchdog `DYNAMIC_VM_MANIFEST_TIMEOUT_MS` unless `overrides` lengthen
 * it) and returns its manifest;
 * every failure is a `DynamicWorkflowExecutionError` whose message is the
 * bridge reason. The worker is always terminated before settlement.
 */
export function extractDynamicWorkflowManifest(
	options: ExtractDynamicWorkflowManifestOptions,
): Promise<DynamicWorkflowManifest> {
	const sourceSha256 =
		options.sourceSha256 ?? deriveDynamicSourceSha256(options.source);
	return settleDrive(
		driveDynamicWorker<DynamicWorkflowManifest>({
			mode: "manifest",
			source: options.source,
			sourceSha256,
			supportHelpers: options.supportHelpers,
			overrides: options.overrides,
			start: {
				type: "start",
				input: null,
				runId: DYNAMIC_MANIFEST_RUN_ID,
				cwd: "/",
				seed: DYNAMIC_MANIFEST_SEED,
				epochMs: 0,
			},
			bootTimeoutMs:
				options.overrides?.bootTimeoutMs ?? DYNAMIC_VM_MANIFEST_TIMEOUT_MS,
			computeTimeoutMs:
				options.overrides?.computeTimeoutMs ?? DYNAMIC_VM_COMPUTE_TIMEOUT_MS,
			onBoot: options.onBoot,
		}),
	);
}
