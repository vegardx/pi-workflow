import {
	MessageChannel,
	type MessagePort,
	receiveMessageOnPort,
} from "node:worker_threads";
import {
	type Static,
	type TLiteral,
	type TSchema,
	type TUnion,
	Type,
} from "typebox";
import { Value } from "typebox/value";
import {
	Sha256Schema,
	TaskKeySchema,
	TaskRefSchema,
	WorkflowArtifactHandleRefSchema,
	WorkflowRunIdSchema,
	WorkflowTaskIdSchema,
} from "../contracts-core.js";
import {
	type ArtifactHandle,
	type HandoffHandle,
	isHandoffHandle,
	type TaskHandle,
} from "../definition.js";
import {
	DYNAMIC_ASYNC_METHODS,
	DYNAMIC_RPC_MESSAGE_TYPES,
	DYNAMIC_SYNC_METHODS,
	DYNAMIC_VM_SYNC_WAIT_MS,
	MAX_DYNAMIC_HANDLE_REFS,
	MAX_DYNAMIC_RPC_ARGS,
	MAX_DYNAMIC_RPC_MESSAGE_BYTES,
	MAX_DYNAMIC_RPC_MESSAGES,
	MAX_DYNAMIC_VM_ERROR_CHARS,
} from "./constants.js";
import {
	DynamicSupportHelperSpecSchema,
	DynamicWorkflowManifestSchema,
} from "./contracts.js";

export { DYNAMIC_RPC_MESSAGE_TYPES };

/*
 * Message schemas (spec section 6). VM -> host traffic and asynchronous
 * host -> VM traffic travel on the worker's main channel; only `reply`
 * messages answering `call` requests travel on the synchronous port.
 */

export type DynamicSyncMethod = (typeof DYNAMIC_SYNC_METHODS)[number];
export type DynamicAsyncMethod = (typeof DYNAMIC_ASYNC_METHODS)[number];

type LiteralTuple<T extends readonly string[]> = {
	-readonly [K in keyof T]: TLiteral<T[K]>;
};

/** A union of string literals that keeps the tuple's static type. */
function literalUnion<const T extends readonly string[]>(
	values: T,
): TUnion<LiteralTuple<T> extends TSchema[] ? LiteralTuple<T> : never> {
	return Type.Union(
		values.map((value) => Type.Literal(value)) as unknown as TSchema[],
	) as never;
}

/** Bounds of a serialized VM error beyond the message limit. */
export const DYNAMIC_VM_ERROR_NAME_CHARS = 128;
export const DYNAMIC_VM_ERROR_STACK_CHARS = 8192;

export const DynamicHandoffHandleRefSchema = Type.Object(
	{
		runId: WorkflowRunIdSchema,
		producerTaskId: WorkflowTaskIdSchema,
		output: Type.Literal("handoff"),
	},
	{ additionalProperties: false },
);
export type DynamicHandoffHandleRef = Static<
	typeof DynamicHandoffHandleRefSchema
>;

/**
 * How a task handle crosses the RPC: refs only, never the branded object.
 * `handoff` is present exactly when the real handle is a worktree handle.
 */
export const DynamicTaskHandleRefSchema = Type.Object(
	{
		kind: Type.Literal("task-handle"),
		ref: TaskRefSchema,
		output: WorkflowArtifactHandleRefSchema,
		handoff: Type.Optional(DynamicHandoffHandleRefSchema),
	},
	{ additionalProperties: false },
);
export type DynamicTaskHandleRef = Static<typeof DynamicTaskHandleRefSchema>;

/** A result or handoff artifact handle; the host resolves it by `ref.output`. */
export const DynamicArtifactHandleRefSchema = Type.Object(
	{
		kind: Type.Literal("artifact-handle"),
		ref: WorkflowArtifactHandleRefSchema,
	},
	{ additionalProperties: false },
);
export type DynamicArtifactHandleRef = Static<
	typeof DynamicArtifactHandleRefSchema
>;

export const DynamicVmErrorSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: DYNAMIC_VM_ERROR_NAME_CHARS }),
		message: Type.String({ maxLength: MAX_DYNAMIC_VM_ERROR_CHARS }),
		stack: Type.Optional(
			Type.String({ maxLength: DYNAMIC_VM_ERROR_STACK_CHARS }),
		),
	},
	{ additionalProperties: false },
);
export type DynamicVmError = Static<typeof DynamicVmErrorSchema>;

export const DynamicRequestIdSchema = Type.Integer({
	minimum: 1,
	maximum: MAX_DYNAMIC_RPC_MESSAGES,
});

export const DynamicReadyMessageSchema = Type.Object(
	{ type: Type.Literal("ready"), manifest: DynamicWorkflowManifestSchema },
	{ additionalProperties: false },
);
export const DynamicCallMessageSchema = Type.Object(
	{
		type: Type.Literal("call"),
		id: DynamicRequestIdSchema,
		method: literalUnion(DYNAMIC_SYNC_METHODS),
		args: Type.Array(Type.Unknown(), { maxItems: MAX_DYNAMIC_RPC_ARGS }),
	},
	{ additionalProperties: false },
);
export const DynamicAwaitMessageSchema = Type.Object(
	{
		type: Type.Literal("await"),
		id: DynamicRequestIdSchema,
		method: literalUnion(DYNAMIC_ASYNC_METHODS),
		handles: Type.Array(DynamicTaskHandleRefSchema, {
			maxItems: MAX_DYNAMIC_HANDLE_REFS,
		}),
	},
	{ additionalProperties: false },
);
export const DynamicDoneResultSchema = Type.Union([
	Type.Object(
		{ kind: Type.Literal("value"), value: Type.Unknown() },
		{ additionalProperties: false },
	),
	Type.Object(
		{ kind: Type.Literal("task"), ref: TaskRefSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{ kind: Type.Literal("artifact"), ref: WorkflowArtifactHandleRefSchema },
		{ additionalProperties: false },
	),
]);
export const DynamicDoneMessageSchema = Type.Object(
	{ type: Type.Literal("done"), result: DynamicDoneResultSchema },
	{ additionalProperties: false },
);
export const DynamicFailedMessageSchema = Type.Object(
	{ type: Type.Literal("failed"), error: DynamicVmErrorSchema },
	{ additionalProperties: false },
);

/** VM -> host. */
export const DynamicVmMessageSchema = Type.Union([
	DynamicReadyMessageSchema,
	DynamicCallMessageSchema,
	DynamicAwaitMessageSchema,
	DynamicDoneMessageSchema,
	DynamicFailedMessageSchema,
]);
export type DynamicVmMessage = Static<typeof DynamicVmMessageSchema>;
export type DynamicReadyMessage = Static<typeof DynamicReadyMessageSchema>;
export type DynamicCallMessage = Static<typeof DynamicCallMessageSchema>;
export type DynamicAwaitMessage = Static<typeof DynamicAwaitMessageSchema>;
export type DynamicDoneMessage = Static<typeof DynamicDoneMessageSchema>;
export type DynamicDoneResult = Static<typeof DynamicDoneResultSchema>;
export type DynamicFailedMessage = Static<typeof DynamicFailedMessageSchema>;

export const DynamicStartMessageSchema = Type.Object(
	{
		type: Type.Literal("start"),
		input: Type.Unknown(),
		runId: WorkflowRunIdSchema,
		cwd: Type.String({ minLength: 1, maxLength: 4096 }),
		seed: Sha256Schema,
		epochMs: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export const DynamicReplyMessageSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("reply"),
			id: DynamicRequestIdSchema,
			ok: Type.Literal(true),
			value: Type.Unknown(),
			aborted: Type.Boolean(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("reply"),
			id: DynamicRequestIdSchema,
			ok: Type.Literal(false),
			error: DynamicVmErrorSchema,
			aborted: Type.Boolean(),
		},
		{ additionalProperties: false },
	),
]);
export const DynamicAbortMessageSchema = Type.Object(
	{
		type: Type.Literal("abort"),
		reason: Type.String({ minLength: 1, maxLength: 4096 }),
	},
	{ additionalProperties: false },
);

/** host -> VM. */
export const DynamicHostMessageSchema = Type.Union([
	DynamicStartMessageSchema,
	...DynamicReplyMessageSchema.anyOf,
	DynamicAbortMessageSchema,
]);
export type DynamicHostMessage = Static<typeof DynamicHostMessageSchema>;
export type DynamicStartMessage = Static<typeof DynamicStartMessageSchema>;
export type DynamicReplyMessage = Static<typeof DynamicReplyMessageSchema>;
export type DynamicAbortMessage = Static<typeof DynamicAbortMessageSchema>;

/**
 * Per-method `args` schemas, checked by the host before dispatch. A failure
 * is a reply error (`MSG_CALL_ARGS_INVALID`), never fatal. Handles inside
 * request objects travel as `DynamicTaskHandleRef`/`DynamicArtifactHandleRef`.
 */
export const DYNAMIC_SYNC_CALL_ARGS_SCHEMAS: Readonly<
	Record<DynamicSyncMethod, TSchema>
> = Object.freeze({
	phase: Type.Tuple([Type.String({ minLength: 1, maxLength: 128 })]),
	log: Type.Tuple([Type.String({ minLength: 1, maxLength: 4096 })]),
	agent: Type.Tuple([TaskKeySchema, Type.Unknown()]),
	agentInNamespace: Type.Tuple([
		Type.Array(TaskKeySchema, { minItems: 1, maxItems: 32 }),
		TaskKeySchema,
		Type.Unknown(),
	]),
	support: Type.Tuple([TaskKeySchema, Type.Unknown()]),
	workflow: Type.Tuple([TaskKeySchema, Type.Unknown()]),
	checkpoint: Type.Tuple([TaskKeySchema, Type.Unknown()]),
	finalize: Type.Tuple([TaskKeySchema, Type.Unknown()]),
});

export function checkDynamicCallArgs(
	method: DynamicSyncMethod,
	args: readonly unknown[],
): boolean {
	return Value.Check(DYNAMIC_SYNC_CALL_ARGS_SCHEMAS[method], args);
}

/**
 * The non-transferable half of `workerData` (spec 7.2); `syncBuffer` and
 * `syncPort` are checked structurally by {@link isDynamicWorkerData}.
 */
export const DynamicWorkerDataSchema = Type.Object(
	{
		mode: Type.Union([Type.Literal("manifest"), Type.Literal("run")]),
		source: Type.String({ minLength: 1 }),
		sourceSha256: Sha256Schema,
		filename: Type.String({ minLength: 1, maxLength: 4096 }),
		supportHelpers: Type.Array(DynamicSupportHelperSpecSchema),
	},
	{ additionalProperties: false },
);
export type DynamicWorkerData = Static<typeof DynamicWorkerDataSchema> & {
	readonly syncBuffer: SharedArrayBuffer;
	readonly syncPort: MessagePort;
};

export function isDynamicWorkerData(
	value: unknown,
): value is DynamicWorkerData {
	if (typeof value !== "object" || value === null) return false;
	const { syncBuffer, syncPort, ...rest } = value as Record<string, unknown>;
	return (
		syncBuffer instanceof SharedArrayBuffer &&
		syncBuffer.byteLength === DYNAMIC_SYNC_BUFFER_BYTES &&
		typeof syncPort === "object" &&
		syncPort !== null &&
		typeof (syncPort as MessagePort).postMessage === "function" &&
		Value.Check(DynamicWorkerDataSchema, rest)
	);
}

/*
 * Exact messages. Host-side protocol violations are fatal to the drive
 * (`WorkflowDynamicProtocolError`); reply errors are returned to the source;
 * VM-side host errors are thrown into the source as `DynamicWorkflowHostError`.
 */

export const MSG_VM_INVALID_MESSAGE =
	"Dynamic workflow VM sent an invalid message.";
export const MSG_VM_MESSAGE_TOO_LARGE = `Dynamic workflow VM message exceeds ${MAX_DYNAMIC_RPC_MESSAGE_BYTES} bytes.`;
export const MSG_VM_TOO_MANY_MESSAGES = `Dynamic workflow VM exceeded ${MAX_DYNAMIC_RPC_MESSAGES} messages.`;
export const MSG_VM_REQUEST_IDS_NOT_CONTIGUOUS =
	"Dynamic workflow VM request ids are not contiguous.";
export const MSG_VM_OVERLAPPING_CALLS =
	"Dynamic workflow VM issued overlapping synchronous calls.";
export const MSG_CALL_ARGS_INVALID =
	"Dynamic workflow call arguments are invalid.";
export const MSG_UNKNOWN_TASK_HANDLE =
	"Dynamic workflow referenced an unknown task handle.";
export const MSG_BARRIER_RESULT_TOO_LARGE = `Dynamic workflow barrier result exceeds ${MAX_DYNAMIC_RPC_MESSAGE_BYTES} bytes.`;
export const MSG_RETURNED_UNKNOWN_TASK_HANDLE =
	"Dynamic workflow returned an unknown task handle.";
export const MSG_HOST_WRONG_SYNC_REPLY =
	"Dynamic workflow host answered the wrong synchronous call.";
export const MSG_HOST_UNKNOWN_REQUEST =
	"Dynamic workflow host answered an unknown request.";
export const MSG_HOST_INVALID_MESSAGE =
	"Dynamic workflow host sent an invalid message.";
export const MSG_HOST_INVALID_HANDLE =
	"Dynamic workflow host returned an invalid task handle.";
export const MSG_RETURN_NOT_JSON = "Dynamic workflow return value is not JSON.";
export const MSG_SOURCE_MAY_NOT_REGISTER =
	"Dynamic workflow source may not register support implementations.";
export const MSG_REQUEST_CONTAINS_FUNCTION =
	"Workflow request contains a function.";
export const MSG_BARRIER_TARGET_NOT_HANDLE =
	"Workflow barrier target is not a task handle.";
export const MSG_STOP_REQUESTED = "Workflow stop requested.";

export function hostSyncTimeoutMessage(waitMs: number): string {
	return `Dynamic workflow host did not answer a synchronous declaration within ${waitMs} ms.`;
}

export type DynamicProtocolViolation =
	| "invalid-message"
	| "message-size"
	| "message-count"
	| "request-id"
	| "overlapping-call";

/** A fatal VM -> host protocol violation; the host terminates the worker. */
export class WorkflowDynamicProtocolError extends Error {
	constructor(
		readonly violation: DynamicProtocolViolation,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "WorkflowDynamicProtocolError";
	}
}

/** Thrown into dynamic source when the host misbehaves on the bridge. */
export class DynamicWorkflowHostError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DynamicWorkflowHostError";
	}
}

/*
 * Bounds and conversions shared by both ends.
 */

/** UTF-8 size of the JSON form, or `undefined` when it has none. */
export function measureDynamicMessageBytes(
	message: unknown,
): number | undefined {
	let json: string | undefined;
	try {
		json = JSON.stringify(message);
	} catch {
		return undefined;
	}
	return json === undefined ? undefined : Buffer.byteLength(json, "utf8");
}

export function isDynamicMessageWithinBounds(message: unknown): boolean {
	const bytes = measureDynamicMessageBytes(message);
	return bytes !== undefined && bytes <= MAX_DYNAMIC_RPC_MESSAGE_BYTES;
}

function bounded(value: unknown, limit: number): string {
	return String(value).slice(0, limit);
}

/** Serializes any thrown value (from either realm) to the bounded wire shape. */
export function toDynamicVmError(error: unknown): DynamicVmError {
	if (typeof error !== "object" || error === null) {
		return {
			name: "Error",
			message: bounded(error, MAX_DYNAMIC_VM_ERROR_CHARS),
		};
	}
	const { name, message, stack } = error as {
		name?: unknown;
		message?: unknown;
		stack?: unknown;
	};
	return {
		name:
			typeof name === "string" && name.length > 0
				? bounded(name, DYNAMIC_VM_ERROR_NAME_CHARS)
				: "Error",
		message: bounded(
			typeof message === "string" ? message : String(error),
			MAX_DYNAMIC_VM_ERROR_CHARS,
		),
		...(typeof stack === "string"
			? { stack: bounded(stack, DYNAMIC_VM_ERROR_STACK_CHARS) }
			: {}),
	};
}

/** Rebuilds a thrown error from its wire shape, keeping `name` and `message`. */
export function fromDynamicVmError(error: DynamicVmError): Error {
	const rebuilt = new Error(error.message);
	rebuilt.name = error.name;
	return rebuilt;
}

export function toDynamicTaskHandleRef(
	handle: TaskHandle<unknown>,
): DynamicTaskHandleRef {
	return {
		kind: "task-handle",
		ref: { ...handle.ref },
		output: { ...handle.output.ref },
		...(isHandoffHandle(handle.handoff)
			? { handoff: { ...handle.handoff.ref } }
			: {}),
	};
}

export function toDynamicArtifactHandleRef(
	handle: ArtifactHandle<unknown> | HandoffHandle,
): DynamicArtifactHandleRef {
	return { kind: "artifact-handle", ref: { ...handle.ref } };
}

/**
 * Applies the host -> VM size bound to a reply: an oversized barrier result
 * becomes a reply error instead of a fatal failure.
 */
export function boundDynamicReply(
	reply: DynamicReplyMessage,
): DynamicReplyMessage {
	if (isDynamicMessageWithinBounds(reply)) return reply;
	return {
		type: "reply",
		id: reply.id,
		ok: false,
		error: {
			name: "DynamicWorkflowHostError",
			message: MSG_BARRIER_RESULT_TOO_LARGE,
		},
		aborted: reply.aborted,
	};
}

/*
 * Host-side admission of VM messages (spec section 6 bounds).
 */

export interface DynamicVmMessageGuard {
	/** Messages admitted so far, including the one that failed. */
	readonly count: number;
	/** The `call` awaiting its synchronous reply, if any. */
	readonly pendingCallId: number | undefined;
	/** Validates and admits one VM message or throws a protocol error. */
	accept(message: unknown): DynamicVmMessage;
	/** Records that the host answered the pending `call`. */
	answered(id: number): void;
}

export function createDynamicVmMessageGuard(): DynamicVmMessageGuard {
	let count = 0;
	let lastId = 0;
	let pendingCallId: number | undefined;
	return {
		get count() {
			return count;
		},
		get pendingCallId() {
			return pendingCallId;
		},
		accept(message: unknown): DynamicVmMessage {
			count += 1;
			if (!Value.Check(DynamicVmMessageSchema, message)) {
				throw new WorkflowDynamicProtocolError(
					"invalid-message",
					MSG_VM_INVALID_MESSAGE,
				);
			}
			if (!isDynamicMessageWithinBounds(message)) {
				throw new WorkflowDynamicProtocolError(
					"message-size",
					MSG_VM_MESSAGE_TOO_LARGE,
				);
			}
			if (count > MAX_DYNAMIC_RPC_MESSAGES) {
				throw new WorkflowDynamicProtocolError(
					"message-count",
					MSG_VM_TOO_MANY_MESSAGES,
				);
			}
			if (message.type === "call" || message.type === "await") {
				if (message.id !== lastId + 1) {
					throw new WorkflowDynamicProtocolError(
						"request-id",
						MSG_VM_REQUEST_IDS_NOT_CONTIGUOUS,
					);
				}
				lastId = message.id;
				if (message.type === "call") {
					if (pendingCallId !== undefined) {
						throw new WorkflowDynamicProtocolError(
							"overlapping-call",
							MSG_VM_OVERLAPPING_CALLS,
						);
					}
					pendingCallId = message.id;
				}
			}
			return message;
		},
		answered(id: number): void {
			if (pendingCallId === id) pendingCallId = undefined;
		},
	};
}

/*
 * Synchronous bridge (spec 6.1). Layout: `syncBuffer` is a 4-byte
 * SharedArrayBuffer viewed as one Int32 flag; 0 = call pending, 1 = answered.
 * Deadlock rule: (R1) the host answers a `call` synchronously inside its
 * message handler; (R2) the VM has at most one outstanding `call` and blocks
 * until answered; (R3) the host never sends a message that needs a VM reply;
 * (R4) `await` requests are answered on the main channel and awaited as
 * promises; (R5) the wait timeout is a fail-safe for a hung host only.
 */

export const DYNAMIC_SYNC_BUFFER_BYTES = 4;
export const DYNAMIC_SYNC_FLAG_INDEX = 0;
export const DYNAMIC_SYNC_FLAG_PENDING = 0;
export const DYNAMIC_SYNC_FLAG_ANSWERED = 1;

export interface DynamicSyncChannel {
	readonly syncBuffer: SharedArrayBuffer;
	/** Host end; `answerDynamicCallSync` posts replies here. */
	readonly hostPort: MessagePort;
	/** Transferred to the worker as `workerData.syncPort`. */
	readonly workerPort: MessagePort;
}

export function createDynamicSyncChannel(): DynamicSyncChannel {
	const { port1, port2 } = new MessageChannel();
	return Object.freeze({
		syncBuffer: new SharedArrayBuffer(DYNAMIC_SYNC_BUFFER_BYTES),
		hostPort: port1,
		workerPort: port2,
	});
}

/** Host: post the reply, then flip the flag and wake the blocked VM. */
export function answerDynamicCallSync(
	channel: Pick<DynamicSyncChannel, "syncBuffer" | "hostPort">,
	reply: DynamicReplyMessage,
): void {
	const flag = new Int32Array(channel.syncBuffer);
	channel.hostPort.postMessage(reply);
	Atomics.store(flag, DYNAMIC_SYNC_FLAG_INDEX, DYNAMIC_SYNC_FLAG_ANSWERED);
	Atomics.notify(flag, DYNAMIC_SYNC_FLAG_INDEX);
}

export interface DynamicSyncRequestOptions {
	readonly syncBuffer: SharedArrayBuffer;
	readonly syncPort: MessagePort;
	/** Posts on the main channel (`parentPort.postMessage`). */
	readonly post: (message: DynamicCallMessage) => void;
	readonly message: DynamicCallMessage;
	readonly waitMs?: number;
}

/**
 * VM: post the `call`, block until the host flips the flag, then read the
 * reply from the synchronous port without touching the event loop.
 */
export function requestDynamicCallSync(
	options: DynamicSyncRequestOptions,
): DynamicReplyMessage {
	const flag = new Int32Array(options.syncBuffer);
	const waitMs = options.waitMs ?? DYNAMIC_VM_SYNC_WAIT_MS;
	Atomics.store(flag, DYNAMIC_SYNC_FLAG_INDEX, DYNAMIC_SYNC_FLAG_PENDING);
	options.post(options.message);
	const outcome = Atomics.wait(
		flag,
		DYNAMIC_SYNC_FLAG_INDEX,
		DYNAMIC_SYNC_FLAG_PENDING,
		waitMs,
	);
	if (outcome === "timed-out") {
		throw new DynamicWorkflowHostError(hostSyncTimeoutMessage(waitMs));
	}
	const reply: unknown = receiveMessageOnPort(options.syncPort)?.message;
	if (
		!Value.Check(DynamicReplyMessageSchema, reply) ||
		reply.id !== options.message.id
	) {
		throw new DynamicWorkflowHostError(MSG_HOST_WRONG_SYNC_REPLY);
	}
	return reply;
}
