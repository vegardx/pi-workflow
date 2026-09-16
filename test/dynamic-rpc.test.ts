import { receiveMessageOnPort, Worker } from "node:worker_threads";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskHandle } from "../src/definition.js";
import {
	DYNAMIC_ASYNC_METHODS,
	DYNAMIC_RPC_MESSAGE_TYPES,
	DYNAMIC_SYNC_METHODS,
	MAX_DYNAMIC_HANDLE_REFS,
	MAX_DYNAMIC_RPC_ARGS,
	MAX_DYNAMIC_RPC_MESSAGE_BYTES,
	MAX_DYNAMIC_RPC_MESSAGES,
	MAX_DYNAMIC_VM_ERROR_CHARS,
} from "../src/dynamic/constants.js";
import {
	answerDynamicCallSync,
	boundDynamicReply,
	checkDynamicCallArgs,
	createDynamicSyncChannel,
	createDynamicVmMessageGuard,
	DYNAMIC_SYNC_BUFFER_BYTES,
	DYNAMIC_SYNC_FLAG_ANSWERED,
	DYNAMIC_SYNC_FLAG_INDEX,
	DYNAMIC_SYNC_FLAG_PENDING,
	type DynamicCallMessage,
	DynamicHostMessageSchema,
	type DynamicReplyMessage,
	DynamicReplyMessageSchema,
	type DynamicSyncChannel,
	type DynamicTaskHandleRef,
	DynamicTaskHandleRefSchema,
	DynamicVmErrorSchema,
	type DynamicVmMessage,
	DynamicVmMessageSchema,
	fromDynamicVmError,
	hostSyncTimeoutMessage,
	isDynamicWorkerData,
	MSG_BARRIER_RESULT_TOO_LARGE,
	MSG_HOST_WRONG_SYNC_REPLY,
	MSG_VM_INVALID_MESSAGE,
	MSG_VM_MESSAGE_TOO_LARGE,
	MSG_VM_OVERLAPPING_CALLS,
	MSG_VM_REQUEST_IDS_NOT_CONTIGUOUS,
	MSG_VM_TOO_MANY_MESSAGES,
	measureDynamicMessageBytes,
	DYNAMIC_RPC_MESSAGE_TYPES as REEXPORTED_MESSAGE_TYPES,
	toDynamicArtifactHandleRef,
	toDynamicTaskHandleRef,
	toDynamicVmError,
	WorkflowDynamicProtocolError,
} from "../src/dynamic/rpc.js";

const runId = "workflow_rpc0001";
const sha = "a".repeat(64);
const taskRef = { runId, taskId: "task_a1" };
const outputRef = {
	runId,
	producerTaskId: "task_a1",
	output: "result" as const,
};
const handoffRef = {
	runId,
	producerTaskId: "task_a1",
	output: "handoff" as const,
};
const taskHandleRef: DynamicTaskHandleRef = {
	kind: "task-handle",
	ref: taskRef,
	output: outputRef,
};
const manifest = {
	meta: {
		name: "demo",
		description: "Demo",
		version: 1,
		budget: { cost: 1, childRuntimeMs: 60_000 },
		timeoutMs: 60_000,
		concurrency: 1,
	},
	inputSchema: { type: "object", additionalProperties: false },
	outputSchema: { type: "object", additionalProperties: false },
};
const vmError = { name: "Error", message: "boom" };

const vmSamples: Record<string, DynamicVmMessage> = {
	ready: { type: "ready", manifest },
	call: { type: "call", id: 1, method: "agent", args: ["key", { agent: "r" }] },
	await: { type: "await", id: 2, method: "results", handles: [taskHandleRef] },
	done: { type: "done", result: { kind: "value", value: { ok: true } } },
	failed: { type: "failed", error: vmError },
};
const hostSamples = {
	start: {
		type: "start",
		input: { topic: "x" },
		runId,
		cwd: "/repo",
		seed: sha,
		epochMs: 1_700_000_000_000,
	},
	reply: {
		type: "reply",
		id: 1,
		ok: true,
		value: taskHandleRef,
		aborted: false,
	},
	abort: { type: "abort", reason: "Workflow stop requested." },
};

describe("dynamic RPC schemas", () => {
	it("re-exports the message type list and covers every type", () => {
		expect(REEXPORTED_MESSAGE_TYPES).toBe(DYNAMIC_RPC_MESSAGE_TYPES);
		const covered = [
			...Object.keys(vmSamples),
			...Object.keys(hostSamples),
		].sort();
		expect(covered).toEqual([...DYNAMIC_RPC_MESSAGE_TYPES].sort());
	});

	it("round-trips every VM message through structured clone", () => {
		for (const message of Object.values(vmSamples)) {
			expect(Value.Check(DynamicVmMessageSchema, message)).toBe(true);
			const cloned = structuredClone(message);
			expect(cloned).toEqual(message);
			expect(Value.Check(DynamicVmMessageSchema, cloned)).toBe(true);
			expect(Value.Check(DynamicHostMessageSchema, message)).toBe(false);
		}
	});

	it("round-trips every host message and both reply shapes", () => {
		const errorReply = {
			type: "reply",
			id: 3,
			ok: false,
			error: vmError,
			aborted: true,
		};
		for (const message of [...Object.values(hostSamples), errorReply]) {
			expect(Value.Check(DynamicHostMessageSchema, message)).toBe(true);
			expect(
				Value.Check(DynamicHostMessageSchema, structuredClone(message)),
			).toBe(true);
			expect(Value.Check(DynamicVmMessageSchema, message)).toBe(false);
		}
		expect(Value.Check(DynamicReplyMessageSchema, hostSamples.reply)).toBe(
			true,
		);
		expect(Value.Check(DynamicReplyMessageSchema, errorReply)).toBe(true);
		expect(Value.Check(DynamicReplyMessageSchema, hostSamples.abort)).toBe(
			false,
		);
	});

	it("accepts every sync method in call and every async method in await", () => {
		for (const method of DYNAMIC_SYNC_METHODS) {
			expect(
				Value.Check(DynamicVmMessageSchema, { ...vmSamples.call, method }),
			).toBe(true);
			expect(
				Value.Check(DynamicVmMessageSchema, { ...vmSamples.await, method }),
			).toBe(false);
		}
		for (const method of DYNAMIC_ASYNC_METHODS) {
			expect(
				Value.Check(DynamicVmMessageSchema, { ...vmSamples.await, method }),
			).toBe(true);
			expect(
				Value.Check(DynamicVmMessageSchema, { ...vmSamples.call, method }),
			).toBe(false);
		}
		expect(DYNAMIC_ASYNC_METHODS).toContain("handoff");
	});

	it("rejects malformed VM messages", () => {
		const rejected: unknown[] = [
			{ type: "nope" },
			{ ...vmSamples.call, method: "fanOut" },
			{ ...vmSamples.call, id: 0 },
			{ ...vmSamples.call, id: MAX_DYNAMIC_RPC_MESSAGES + 1 },
			{ ...vmSamples.call, id: 1.5 },
			{ ...vmSamples.call, args: new Array(MAX_DYNAMIC_RPC_ARGS + 1).fill(0) },
			{ ...vmSamples.call, extra: 1 },
			{ ...vmSamples.await, method: "agent" },
			{
				...vmSamples.await,
				handles: new Array(MAX_DYNAMIC_HANDLE_REFS + 1).fill(taskHandleRef),
			},
			{
				...vmSamples.await,
				handles: [{ ...taskHandleRef, kind: "artifact-handle" }],
			},
			{
				...vmSamples.await,
				handles: [{ ...taskHandleRef, handoff: outputRef }],
			},
			{ type: "done", result: { kind: "nope" } },
			{ type: "done", result: { kind: "task", ref: outputRef } },
			{ type: "done", result: { kind: "artifact", ref: taskRef } },
			{ type: "failed", error: { name: "", message: "x" } },
			{
				type: "failed",
				error: {
					name: "Error",
					message: "x".repeat(MAX_DYNAMIC_VM_ERROR_CHARS + 1),
				},
			},
			{
				type: "ready",
				manifest: {
					...manifest,
					meta: { ...manifest.meta, concurrency: undefined },
				},
			},
			{ type: "ready" },
		];
		for (const message of rejected) {
			expect(Value.Check(DynamicVmMessageSchema, message)).toBe(false);
		}
		expect(
			Value.Check(DynamicVmMessageSchema, {
				...vmSamples.await,
				handles: [{ ...taskHandleRef, handoff: handoffRef }],
			}),
		).toBe(true);
	});

	it("rejects malformed host messages", () => {
		const rejected: unknown[] = [
			{ ...hostSamples.start, seed: "zz" },
			{ ...hostSamples.start, runId: "run_1" },
			{ ...hostSamples.start, cwd: "" },
			{ ...hostSamples.start, epochMs: -1 },
			{ type: "start", input: null, runId, cwd: "/repo", seed: sha },
			{ type: "reply", id: 1, ok: true, value: 1 },
			{ type: "reply", id: 1, ok: true, error: vmError, aborted: false },
			{ type: "reply", id: 1, ok: false, value: 1, aborted: false },
			{ type: "reply", id: 1, ok: false, error: { name: "E" }, aborted: false },
			{ type: "abort", reason: "" },
			{ type: "abort", reason: "x".repeat(4097) },
			{ type: "call", id: 1, method: "agent", args: [] },
		];
		for (const message of rejected) {
			expect(Value.Check(DynamicHostMessageSchema, message)).toBe(false);
		}
	});

	it("checks per-method call arguments", () => {
		const request = { agent: "r" };
		const accepted: [DynamicCallMessage["method"], unknown[]][] = [
			["phase", ["plan"]],
			["log", ["x".repeat(4096)]],
			["agent", ["key", request]],
			["agentInNamespace", [["ns"], "key", request]],
			["support", ["key", request]],
			["workflow", ["key", request]],
			["checkpoint", ["key", request]],
			["finalize", ["key", request]],
		];
		for (const [method, args] of accepted) {
			expect(checkDynamicCallArgs(method, args)).toBe(true);
		}
		const rejected: [DynamicCallMessage["method"], unknown[]][] = [
			["phase", [""]],
			["phase", ["x".repeat(129)]],
			["phase", ["plan", "extra"]],
			["log", [""]],
			["log", ["x".repeat(4097)]],
			["agent", ["Key", request]],
			["agent", ["key"]],
			["agentInNamespace", [[], "key", request]],
			["agentInNamespace", [new Array(33).fill("ns"), "key", request]],
			["agentInNamespace", ["ns", "key", request]],
			["support", ["-key", request]],
			["workflow", ["key", request, 1]],
			["checkpoint", []],
			["finalize", [1, request]],
		];
		for (const [method, args] of rejected) {
			expect(checkDynamicCallArgs(method, args)).toBe(false);
		}
	});
});

describe("dynamic RPC bounds", () => {
	it("measures JSON size and reports non-JSON values as unmeasurable", () => {
		expect(measureDynamicMessageBytes({ a: "é" })).toBe(
			Buffer.byteLength('{"a":"é"}'),
		);
		expect(measureDynamicMessageBytes(undefined)).toBeUndefined();
		expect(measureDynamicMessageBytes({ a: 1n })).toBeUndefined();
	});

	it("serializes thrown values within the wire bounds", () => {
		const error = new RangeError("x".repeat(MAX_DYNAMIC_VM_ERROR_CHARS + 10));
		const wire = toDynamicVmError(error);
		expect(wire.name).toBe("RangeError");
		expect(wire.message).toHaveLength(MAX_DYNAMIC_VM_ERROR_CHARS);
		expect(wire.stack?.startsWith("RangeError")).toBe(true);
		expect(Value.Check(DynamicVmErrorSchema, wire)).toBe(true);
		expect(toDynamicVmError("boom")).toEqual({
			name: "Error",
			message: "boom",
		});
		expect(toDynamicVmError({ name: "", message: 4 })).toEqual({
			name: "Error",
			message: "[object Object]",
		});
		expect(toDynamicVmError({ name: "N".repeat(200), message: "m" })).toEqual({
			name: "N".repeat(128),
			message: "m",
		});
		expect(toDynamicVmError(null)).toEqual({ name: "Error", message: "null" });
		const rebuilt = fromDynamicVmError({
			name: "WorkflowMaterializationError",
			message: "dup",
		});
		expect(rebuilt).toBeInstanceOf(Error);
		expect(rebuilt.name).toBe("WorkflowMaterializationError");
		expect(rebuilt.message).toBe("dup");
	});

	it("converts handles to refs, including worktree handoffs", () => {
		const plain = createTaskHandle(taskRef, outputRef);
		expect(toDynamicTaskHandleRef(plain)).toEqual(taskHandleRef);
		const worktree = createTaskHandle(taskRef, outputRef, handoffRef);
		const ref = toDynamicTaskHandleRef(worktree);
		expect(ref).toEqual({ ...taskHandleRef, handoff: handoffRef });
		expect(Value.Check(DynamicTaskHandleRefSchema, ref)).toBe(true);
		expect(toDynamicArtifactHandleRef(plain.output)).toEqual({
			kind: "artifact-handle",
			ref: outputRef,
		});
		expect(toDynamicArtifactHandleRef(worktree.handoff)).toEqual({
			kind: "artifact-handle",
			ref: handoffRef,
		});
	});

	it("turns an oversized barrier reply into a reply error", () => {
		const small: DynamicReplyMessage = {
			type: "reply",
			id: 4,
			ok: true,
			value: [1, 2, 3],
			aborted: false,
		};
		expect(boundDynamicReply(small)).toBe(small);
		const large: DynamicReplyMessage = {
			type: "reply",
			id: 5,
			ok: true,
			value: "x".repeat(MAX_DYNAMIC_RPC_MESSAGE_BYTES),
			aborted: true,
		};
		expect(boundDynamicReply(large)).toEqual({
			type: "reply",
			id: 5,
			ok: false,
			error: {
				name: "DynamicWorkflowHostError",
				message: MSG_BARRIER_RESULT_TOO_LARGE,
			},
			aborted: true,
		});
		expect(MSG_BARRIER_RESULT_TOO_LARGE).toBe(
			"Dynamic workflow barrier result exceeds 17825792 bytes.",
		);
	});

	it("recognises worker data with a real sync channel", () => {
		const channel = createDynamicSyncChannel();
		const data = {
			mode: "run",
			source: "export default 1;",
			sourceSha256: sha,
			filename: `dynamic:${sha}.workflow.ts`,
			supportHelpers: [],
			syncBuffer: channel.syncBuffer,
			syncPort: channel.workerPort,
		};
		expect(isDynamicWorkerData(data)).toBe(true);
		expect(isDynamicWorkerData({ ...data, mode: "watch" })).toBe(false);
		expect(
			isDynamicWorkerData({ ...data, syncBuffer: new SharedArrayBuffer(8) }),
		).toBe(false);
		expect(isDynamicWorkerData({ ...data, syncPort: {} })).toBe(false);
		expect(isDynamicWorkerData({ ...data, extra: 1 })).toBe(false);
		expect(channel.syncBuffer.byteLength).toBe(DYNAMIC_SYNC_BUFFER_BYTES);
		channel.hostPort.close();
		channel.workerPort.close();
	});
});

describe("dynamic VM message guard", () => {
	function expectViolation(
		action: () => unknown,
		violation: WorkflowDynamicProtocolError["violation"],
		message: string,
	): void {
		let caught: unknown;
		try {
			action();
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(WorkflowDynamicProtocolError);
		const error = caught as WorkflowDynamicProtocolError;
		expect(error.name).toBe("WorkflowDynamicProtocolError");
		expect(error.violation).toBe(violation);
		expect(error.message).toBe(message);
	}

	it("refuses invalid messages", () => {
		const guard = createDynamicVmMessageGuard();
		expectViolation(
			() => guard.accept({ type: "call", id: 1, method: "fanOut", args: [] }),
			"invalid-message",
			MSG_VM_INVALID_MESSAGE,
		);
		expect(MSG_VM_INVALID_MESSAGE).toBe(
			"Dynamic workflow VM sent an invalid message.",
		);
	});

	it("refuses oversized and non-JSON messages", () => {
		const guard = createDynamicVmMessageGuard();
		expectViolation(
			() =>
				guard.accept({
					type: "call",
					id: 1,
					method: "log",
					args: ["x".repeat(MAX_DYNAMIC_RPC_MESSAGE_BYTES)],
				}),
			"message-size",
			MSG_VM_MESSAGE_TOO_LARGE,
		);
		expectViolation(
			() => guard.accept({ type: "call", id: 1, method: "log", args: [1n] }),
			"message-size",
			MSG_VM_MESSAGE_TOO_LARGE,
		);
		expect(MSG_VM_MESSAGE_TOO_LARGE).toBe(
			"Dynamic workflow VM message exceeds 17825792 bytes.",
		);
	});

	it("refuses the message after the count bound", () => {
		const guard = createDynamicVmMessageGuard();
		const message = { type: "failed", error: vmError };
		for (let index = 0; index < MAX_DYNAMIC_RPC_MESSAGES; index += 1) {
			guard.accept(message);
		}
		expect(guard.count).toBe(MAX_DYNAMIC_RPC_MESSAGES);
		expectViolation(
			() => guard.accept(message),
			"message-count",
			MSG_VM_TOO_MANY_MESSAGES,
		);
		expect(MSG_VM_TOO_MANY_MESSAGES).toBe(
			"Dynamic workflow VM exceeded 65536 messages.",
		);
	});

	it("requires contiguous request ids across calls and awaits", () => {
		const guard = createDynamicVmMessageGuard();
		expectViolation(
			() => guard.accept({ ...vmSamples.call, id: 2 }),
			"request-id",
			MSG_VM_REQUEST_IDS_NOT_CONTIGUOUS,
		);
		const fresh = createDynamicVmMessageGuard();
		fresh.accept({ ...vmSamples.call, id: 1 });
		fresh.answered(1);
		expectViolation(
			() => fresh.accept({ ...vmSamples.await, id: 3 }),
			"request-id",
			MSG_VM_REQUEST_IDS_NOT_CONTIGUOUS,
		);
		expectViolation(
			() => fresh.accept({ ...vmSamples.call, id: 1 }),
			"request-id",
			MSG_VM_REQUEST_IDS_NOT_CONTIGUOUS,
		);
		expect(fresh.accept({ ...vmSamples.await, id: 2 }).type).toBe("await");
		expect(fresh.accept({ ...vmSamples.call, id: 3 }).type).toBe("call");
		expect(fresh.accept(vmSamples.done).type).toBe("done");
	});

	it("refuses a call while another call is unanswered", () => {
		const guard = createDynamicVmMessageGuard();
		guard.accept({ ...vmSamples.call, id: 1 });
		expect(guard.pendingCallId).toBe(1);
		expectViolation(
			() => guard.accept({ ...vmSamples.call, id: 2 }),
			"overlapping-call",
			MSG_VM_OVERLAPPING_CALLS,
		);
		expect(MSG_VM_OVERLAPPING_CALLS).toBe(
			"Dynamic workflow VM issued overlapping synchronous calls.",
		);
		const fresh = createDynamicVmMessageGuard();
		fresh.accept({ ...vmSamples.call, id: 1 });
		fresh.answered(7);
		expect(fresh.pendingCallId).toBe(1);
		fresh.answered(1);
		expect(fresh.pendingCallId).toBeUndefined();
		expect(fresh.accept({ ...vmSamples.call, id: 2 }).type).toBe("call");
	});
});

describe("dynamic synchronous bridge", () => {
	const workers = new Set<Worker>();
	const channels = new Set<DynamicSyncChannel>();

	afterEach(async () => {
		await Promise.all([...workers].map((worker) => worker.terminate()));
		workers.clear();
		for (const channel of channels) {
			channel.hostPort.close();
			channel.workerPort.close();
		}
		channels.clear();
	});

	type Outcome =
		| { type: "outcome"; reply: DynamicReplyMessage }
		| { type: "outcome"; error: { name: string; message: string } };

	function spawn(
		calls: readonly Omit<DynamicCallMessage, "type">[],
		onCall: (
			message: DynamicCallMessage,
			channel: DynamicSyncChannel,
			received: readonly unknown[],
		) => void,
		waitMs?: number,
	): Promise<{ outcomes: Outcome[]; messages: unknown[] }> {
		const channel = createDynamicSyncChannel();
		channels.add(channel);
		const worker = new Worker(
			new URL("./fixtures/dynamic-rpc-worker.ts", import.meta.url),
			{
				execArgv: ["--import", "tsx"],
				workerData: {
					syncBuffer: channel.syncBuffer,
					syncPort: channel.workerPort,
					calls,
					...(waitMs === undefined ? {} : { waitMs }),
				},
				transferList: [channel.workerPort],
			},
		);
		workers.add(worker);
		const outcomes: Outcome[] = [];
		const messages: unknown[] = [];
		return new Promise((resolve, reject) => {
			worker.on("error", reject);
			worker.on("exit", (code) => {
				if (code !== 0) reject(new Error(`worker exited ${code}`));
			});
			worker.on("message", (message: unknown) => {
				// Nothing may throw out of this listener: it runs outside the
				// test's promise chain, so a throw would become an unhandled
				// error that fails the run without failing a test.
				try {
					messages.push(message);
					const typed = message as { type: string };
					if (typed.type === "call") {
						onCall(message as DynamicCallMessage, channel, messages);
					} else if (typed.type === "outcome") {
						outcomes.push(message as Outcome);
					} else if (typed.type === "finished") {
						resolve({ outcomes, messages });
					}
				} catch (error) {
					reject(error);
				}
			});
		});
	}

	it("posts the reply before it flips the flag for the parked VM", () => {
		const channel = createDynamicSyncChannel();
		channels.add(channel);
		const flag = new Int32Array(channel.syncBuffer);
		const reply: DynamicReplyMessage = {
			type: "reply",
			id: 1,
			ok: true,
			value: { echoed: ["plan"] },
			aborted: false,
		};
		expect(Atomics.load(flag, DYNAMIC_SYNC_FLAG_INDEX)).toBe(
			DYNAMIC_SYNC_FLAG_PENDING,
		);
		answerDynamicCallSync(channel, reply);
		// A woken VM reads the reply off its port after seeing the flag, so the
		// reply must already be there once the flag says answered.
		expect(Atomics.load(flag, DYNAMIC_SYNC_FLAG_INDEX)).toBe(
			DYNAMIC_SYNC_FLAG_ANSWERED,
		);
		expect(receiveMessageOnPort(channel.workerPort)?.message).toEqual(reply);
	});

	it("answers calls synchronously inside the host message handler", async () => {
		const guard = createDynamicVmMessageGuard();
		const seen: string[] = [];
		const acceptedTypes: string[] = [];
		const parkedOnEntry: number[] = [];
		const pendingOnEntry: (number | undefined)[] = [];
		const pendingAfterAnswer: (number | undefined)[] = [];
		const answeredBeforeAwaiting: boolean[] = [];
		const { outcomes } = await spawn(
			[
				{ id: 1, method: "phase", args: ["plan"] },
				{ id: 2, method: "agent", args: ["key", { agent: "r" }] },
			],
			(message, channel) => {
				// Record only; the assertions run in the test body. A microtask
				// scheduled here cannot run before this handler returns, so
				// `answeredBeforeAwaiting` proves the answer preceded any await.
				let microtasksRun = 0;
				queueMicrotask(() => {
					microtasksRun += 1;
				});
				acceptedTypes.push(guard.accept(message).type);
				seen.push(message.method);
				pendingOnEntry.push(guard.pendingCallId);
				// The VM is parked on the flag until this handler answers. Reading
				// the flag *after* answering would race the woken VM, which owns it
				// and resets it to pending for its next call.
				parkedOnEntry.push(
					Atomics.load(
						new Int32Array(channel.syncBuffer),
						DYNAMIC_SYNC_FLAG_INDEX,
					),
				);
				// R1: reply, flag, notify, all before this handler returns.
				answerDynamicCallSync(channel, {
					type: "reply",
					id: message.id,
					ok: message.method !== "agent",
					...(message.method === "agent"
						? {
								error: { name: "WorkflowMaterializationError", message: "dup" },
							}
						: { value: { echoed: message.args } }),
					aborted: false,
				} as DynamicReplyMessage);
				answeredBeforeAwaiting.push(microtasksRun === 0);
				guard.answered(message.id);
				pendingAfterAnswer.push(guard.pendingCallId);
			},
		);
		expect(acceptedTypes).toEqual(["call", "call"]);
		expect(seen).toEqual(["phase", "agent"]);
		expect(pendingOnEntry).toEqual([1, 2]);
		expect(parkedOnEntry).toEqual([
			DYNAMIC_SYNC_FLAG_PENDING,
			DYNAMIC_SYNC_FLAG_PENDING,
		]);
		expect(answeredBeforeAwaiting).toEqual([true, true]);
		expect(pendingAfterAnswer).toEqual([undefined, undefined]);
		expect(outcomes).toEqual([
			{
				type: "outcome",
				reply: {
					type: "reply",
					id: 1,
					ok: true,
					value: { echoed: ["plan"] },
					aborted: false,
				},
			},
			{
				type: "outcome",
				reply: {
					type: "reply",
					id: 2,
					ok: false,
					error: { name: "WorkflowMaterializationError", message: "dup" },
					aborted: false,
				},
			},
		]);
		expect(guard.pendingCallId).toBeUndefined();
	});

	it("blocks the VM until the host answers, one call at a time", async () => {
		let sawOnlyTheCall = false;
		const { outcomes } = await spawn(
			[
				{ id: 1, method: "log", args: ["first"] },
				{ id: 2, method: "log", args: ["second"] },
			],
			(message, channel, received) => {
				if (message.id === 1) {
					// R2: nothing else arrives while the worker is parked in Atomics.wait.
					const before = received.length;
					setTimeout(() => {
						sawOnlyTheCall = received.length === before;
						answerDynamicCallSync(channel, {
							type: "reply",
							id: 1,
							ok: true,
							value: null,
							aborted: false,
						});
					}, 150);
					return;
				}
				answerDynamicCallSync(channel, {
					type: "reply",
					id: message.id,
					ok: true,
					value: null,
					aborted: true,
				});
			},
		);
		expect(sawOnlyTheCall).toBe(true);
		expect(
			outcomes.map((outcome) => "reply" in outcome && outcome.reply.id),
		).toEqual([1, 2]);
		expect(outcomes[1]).toEqual({
			type: "outcome",
			reply: { type: "reply", id: 2, ok: true, value: null, aborted: true },
		});
	});

	it("times out on a host that never notifies", async () => {
		const { outcomes } = await spawn(
			[{ id: 1, method: "phase", args: ["plan"] }],
			() => undefined,
			200,
		);
		expect(outcomes).toEqual([
			{
				type: "outcome",
				error: {
					name: "DynamicWorkflowHostError",
					message: hostSyncTimeoutMessage(200),
				},
			},
		]);
		expect(hostSyncTimeoutMessage(30_000)).toBe(
			"Dynamic workflow host did not answer a synchronous declaration within 30000 ms.",
		);
	});

	it("rejects a reply for another call or a notify without a reply", async () => {
		const { outcomes } = await spawn(
			[
				{ id: 1, method: "phase", args: ["plan"] },
				{ id: 2, method: "phase", args: ["plan"] },
			],
			(message, channel) => {
				if (message.id === 1) {
					answerDynamicCallSync(channel, {
						type: "reply",
						id: 99,
						ok: true,
						value: null,
						aborted: false,
					});
					return;
				}
				const flag = new Int32Array(channel.syncBuffer);
				Atomics.store(
					flag,
					DYNAMIC_SYNC_FLAG_INDEX,
					DYNAMIC_SYNC_FLAG_ANSWERED,
				);
				Atomics.notify(flag, DYNAMIC_SYNC_FLAG_INDEX);
			},
		);
		expect(outcomes).toEqual([
			{
				type: "outcome",
				error: {
					name: "DynamicWorkflowHostError",
					message: MSG_HOST_WRONG_SYNC_REPLY,
				},
			},
			{
				type: "outcome",
				error: {
					name: "DynamicWorkflowHostError",
					message: MSG_HOST_WRONG_SYNC_REPLY,
				},
			},
		]);
		expect(MSG_HOST_WRONG_SYNC_REPLY).toBe(
			"Dynamic workflow host answered the wrong synchronous call.",
		);
	});
});
