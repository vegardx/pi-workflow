import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { parse } from "@babel/parser";
import { Type } from "typebox";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { WorkflowArtifactStore } from "../src/artifact-store.js";
import { DEFAULT_WORKFLOW_CONCURRENCY } from "../src/contracts.js";
import {
	createTaskHandle,
	defineWorkflow,
	type TaskHandle,
	type WorkflowContext,
} from "../src/definition.js";
import {
	DYNAMIC_VM_BOOT_TIMEOUT_MS,
	DYNAMIC_VM_COMPUTE_TIMEOUT_MS,
	MAX_DYNAMIC_RPC_MESSAGE_BYTES,
} from "../src/dynamic/constants.js";
import {
	DYNAMIC_ABORT_ERROR_NAME,
	DYNAMIC_BOOT_ERROR_NAME,
	DYNAMIC_SYNC_WAIT_ARGV_PREFIX,
	DynamicWorkflowExecutionError,
	syncWaitMsFromArgv,
} from "../src/dynamic/execution-error.js";
import {
	createDynamicSyncChannel,
	type DynamicAwaitMessage,
	type DynamicCallMessage,
	type DynamicVmMessage,
	type DynamicWorkerData,
	MSG_BARRIER_RESULT_TOO_LARGE,
	MSG_CALL_ARGS_INVALID,
	MSG_RETURNED_UNKNOWN_TASK_HANDLE,
	MSG_STOP_REQUESTED,
	MSG_UNKNOWN_TASK_HANDLE,
	MSG_VM_INVALID_MESSAGE,
	MSG_VM_MESSAGE_TOO_LARGE,
	MSG_VM_REQUEST_IDS_NOT_CONTIGUOUS,
	MSG_VM_TOO_MANY_MESSAGES,
} from "../src/dynamic/rpc.js";
import { deriveDynamicSourceSha256 } from "../src/dynamic/source.js";
import {
	abortReasonOf,
	bootTimeoutMessage,
	computeTimeoutMessage,
	createDynamicHostDispatcher,
	createDynamicVm,
	type DynamicVmBridgeOverrides,
	executionErrorFromVmFailure,
	extractDynamicWorkflowManifest,
	MSG_BRIDGE_REQUIRES_STATIC_CONTEXT,
	MSG_EXECUTION_ABORTED,
	MSG_VM_CRASHED,
	MSG_VM_OUT_OF_MEMORY,
	resolveDynamicWorkerEntry,
} from "../src/dynamic/vm-host.js";
import {
	deriveJsonValueSha256,
	deriveTaskExecutionId,
} from "../src/execution.js";
import { WorkflowRunJournal } from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
	type WorkflowRunLease,
} from "../src/persistence/run-lease.js";
import { reduceWorkflowEvents } from "../src/reducer.js";
import type {
	WorkflowSchedulerOutcome,
	WorkflowSequentialScheduler,
} from "../src/scheduler.js";
import {
	createStaticWorkflowRuntime,
	isStaticWorkflowParked,
	type WorkflowHostBridge,
	workflowHostBridge,
} from "../src/static-runtime.js";

const runId = "workflow_vmhost0001";
const cwd = "/repo";
const seed = "7".repeat(64);
const epochMs = 1_700_000_000_000;
const ROGUE_ENTRY = new URL(
	"./fixtures/dynamic-rogue-worker.ts",
	import.meta.url,
);
/**
 * Boot allowance for tests that do not assert the boot watchdog: a cold tsx
 * worker takes seconds under full-suite load (the production constants are
 * asserted through `bootTimeoutMessage`), so timeouts stay safety nets.
 */
const BOOT_ALLOWANCE: DynamicVmBridgeOverrides = { bootTimeoutMs: 60_000 };

function taskRef(taskId: string) {
	return { runId, taskId };
}
function artifactRef(taskId: string, output: "result" | "handoff" = "result") {
	return { runId, producerTaskId: taskId, output };
}
function handleOf(taskId: string, worktree = false): TaskHandle<unknown> {
	return worktree
		? createTaskHandle(taskRef(taskId), artifactRef(taskId), {
				runId,
				producerTaskId: taskId,
				output: "handoff",
			})
		: createTaskHandle(taskRef(taskId), artifactRef(taskId));
}
function named(name: string, message: string): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

type Recorded = { readonly method: string; readonly args: readonly unknown[] };

/**
 * A stand-in for the static-runtime context: declarations return branded
 * handles (worktree handles when the request names a worktree workspace),
 * barriers resolve through `barrier`, and the host bridge is present unless
 * `bridge: false`. Validation mirrors only what the tests assert on.
 */
function fakeContext(
	options: {
		readonly input?: unknown;
		readonly signal?: AbortSignal;
		readonly bridge?: boolean;
		readonly barrier?: (
			method: string,
			targets: readonly TaskHandle<unknown>[],
		) => unknown;
		readonly fail?: (method: string) => Error | undefined;
	} = {},
) {
	const calls: Recorded[] = [];
	const created: TaskHandle<unknown>[] = [];
	let counter = 0;
	const declare =
		(method: string) =>
		(key: string, request: unknown): TaskHandle<unknown> => {
			calls.push({ method, args: [key, request] });
			const failure = options.fail?.(method);
			if (failure) throw failure;
			counter += 1;
			const worktree =
				typeof request === "object" &&
				request !== null &&
				(request as { workspace?: { mode?: string } }).workspace?.mode ===
					"worktree";
			const handle = handleOf(`task_${method}${counter}`, worktree);
			created.push(handle);
			return handle;
		};
	const barrier =
		(method: string) =>
		async (...targets: readonly TaskHandle<unknown>[]): Promise<unknown> => {
			calls.push({ method, args: targets });
			const failure = options.fail?.(method);
			if (failure) throw failure;
			if (options.barrier) return options.barrier(method, targets);
			switch (method) {
				case "result":
					return { from: targets[0]?.ref.taskId };
				case "handoff":
					return undefined;
				case "settled":
					return targets.map((target) => ({
						status: "fulfilled",
						value: { from: target.ref.taskId },
					}));
				default:
					return targets.map((target) => ({ from: target.ref.taskId }));
			}
		};
	const members = {
		input: options.input ?? { topic: "alpha" },
		runId,
		cwd,
		signal: options.signal ?? new AbortController().signal,
		phase(name: string) {
			calls.push({ method: "phase", args: [name] });
			if (name.length < 1 || name.length > 128) {
				throw named(
					"StaticWorkflowRuntimeError",
					"Workflow phase must contain 1 to 128 characters.",
				);
			}
		},
		log(message: string) {
			calls.push({ method: "log", args: [message] });
			if (message.length < 1 || message.length > 4096) {
				throw named(
					"StaticWorkflowRuntimeError",
					"Workflow log must contain 1 to 4096 characters.",
				);
			}
		},
		agent: declare("agent"),
		support: declare("support"),
		workflow: declare("workflow"),
		checkpoint: declare("checkpoint"),
		finalize: declare("finalize"),
		fanOut() {
			throw new Error("fanOut is lowered in the shim");
		},
		fanIn() {
			throw new Error("fanIn is lowered in the shim");
		},
		pipeline() {
			throw new Error("pipeline is lowered in the shim");
		},
		result: (task: TaskHandle<unknown>) => barrier("result")(task),
		results: (tasks: readonly TaskHandle<unknown>[]) =>
			barrier("results")(...tasks),
		settled: (tasks: readonly TaskHandle<unknown>[]) =>
			barrier("settled")(...tasks),
		handoff: (task: TaskHandle<unknown>) => barrier("handoff")(task),
	};
	const bridge: WorkflowHostBridge = {
		agentInNamespace(namespace, key, request) {
			calls.push({
				method: "agentInNamespace",
				args: [namespace, key, request],
			});
			counter += 1;
			const handle = handleOf(`task_ns${counter}`);
			created.push(handle);
			return handle;
		},
	};
	if (options.bridge !== false) {
		Object.defineProperty(members, workflowHostBridge, {
			value: bridge,
			enumerable: false,
		});
	}
	return {
		context: Object.freeze(members) as unknown as WorkflowContext<unknown>,
		bridge,
		calls,
		created,
	};
}

function call(
	id: number,
	method: DynamicCallMessage["method"],
	args: unknown[],
): DynamicCallMessage {
	return { type: "call", id, method, args };
}
function awaiting(
	id: number,
	method: DynamicAwaitMessage["method"],
	handles: DynamicAwaitMessage["handles"],
): DynamicAwaitMessage {
	return { type: "await", id, method, handles };
}
function refOf(handle: TaskHandle<unknown>) {
	return {
		kind: "task-handle" as const,
		ref: { ...handle.ref },
		output: { ...handle.output.ref },
		...(handle.handoff ? { handoff: { ...handle.handoff.ref } } : {}),
	};
}

const request = { agent: "researcher", workspace: { mode: "read-only", cwd } };

describe("dynamic host dispatcher: synchronous calls", () => {
	it("dispatches every sync method, remembers handles, and answers with refs", () => {
		const fake = fakeContext();
		const dispatcher = createDynamicHostDispatcher({
			context: fake.context,
			bridge: fake.bridge,
		});
		expect(dispatcher.call(call(1, "phase", ["collect"]))).toEqual({
			type: "reply",
			id: 1,
			ok: true,
			value: null,
			aborted: false,
		});
		expect(dispatcher.call(call(2, "log", ["hello"]))).toMatchObject({
			ok: true,
			value: null,
		});
		const agent = dispatcher.call(call(3, "agent", ["a", request]));
		const worktree = dispatcher.call(
			call(4, "agent", [
				"w",
				{ ...request, workspace: { mode: "worktree", cwd } },
			]),
		);
		const support = dispatcher.call(call(5, "support", ["s", { name: "x" }]));
		const workflow = dispatcher.call(
			call(6, "workflow", ["n", { workflow: "child" }]),
		);
		const checkpoint = dispatcher.call(
			call(7, "checkpoint", ["c", { prompt: "?" }]),
		);
		const finalize = dispatcher.call(
			call(8, "finalize", ["f", { kind: "required" }]),
		);
		const namespaced = dispatcher.call(
			call(9, "agentInNamespace", [["items"], "x", request]),
		);
		const [a, w, s, n, c, f, ns] = fake.created;
		expect(agent).toEqual({
			type: "reply",
			id: 3,
			ok: true,
			value: refOf(a as TaskHandle<unknown>),
			aborted: false,
		});
		expect(
			(worktree as { value: { handoff?: unknown } }).value.handoff,
		).toEqual(w?.handoff?.ref);
		expect((support as { value: unknown }).value).toEqual(
			refOf(s as TaskHandle<unknown>),
		);
		expect((workflow as { value: unknown }).value).toEqual(
			refOf(n as TaskHandle<unknown>),
		);
		expect((checkpoint as { value: unknown }).value).toEqual(
			refOf(c as TaskHandle<unknown>),
		);
		expect((finalize as { value: unknown }).value).toEqual(
			refOf(f as TaskHandle<unknown>),
		);
		expect((namespaced as { value: unknown }).value).toEqual(
			refOf(ns as TaskHandle<unknown>),
		);
		expect(fake.calls.map((recorded) => recorded.method)).toEqual([
			"phase",
			"log",
			"agent",
			"agent",
			"support",
			"workflow",
			"checkpoint",
			"finalize",
			"agentInNamespace",
		]);
		expect(fake.calls[8]?.args).toEqual([["items"], "x", request]);
		expect([...dispatcher.handles.keys()]).toEqual(
			fake.created.map((handle) => handle.ref.taskId),
		);
		for (const handle of fake.created) {
			expect(dispatcher.handles.get(handle.ref.taskId)).toBe(handle);
		}
	});

	it("resolves task and artifact refs inside requests to the real handles", () => {
		const fake = fakeContext();
		const dispatcher = createDynamicHostDispatcher({
			context: fake.context,
			bridge: fake.bridge,
		});
		dispatcher.call(call(1, "agent", ["a", request]));
		dispatcher.call(
			call(2, "agent", [
				"w",
				{ ...request, workspace: { mode: "worktree", cwd } },
			]),
		);
		const [a, w] = fake.created as [TaskHandle<unknown>, TaskHandle<unknown>];
		const reply = dispatcher.call(
			call(3, "finalize", [
				"f",
				{
					kind: "required",
					request: {
						agent: {
							...request,
							inputs: {
								prior: { kind: "artifact-handle", ref: a.output.ref },
								patch: { kind: "artifact-handle", ref: w.handoff?.ref },
							},
							after: [a.ref],
						},
					},
					sources: [refOf(a), refOf(w)],
				},
			]),
		);
		expect(reply.ok).toBe(true);
		const forwarded = fake.calls[2]?.args[1] as {
			request: { agent: { inputs: Record<string, unknown>; after: unknown[] } };
			sources: unknown[];
		};
		expect(forwarded.request.agent.inputs.prior).toBe(a.output);
		expect(forwarded.request.agent.inputs.patch).toBe(w.handoff);
		expect(forwarded.request.agent.after).toEqual([a.ref]);
		expect(forwarded.sources[0]).toBe(a);
		expect(forwarded.sources[1]).toBe(w);
	});

	it("answers unknown or mismatched handle refs with a reply error, not a failure", () => {
		const fake = fakeContext();
		const dispatcher = createDynamicHostDispatcher({
			context: fake.context,
			bridge: fake.bridge,
		});
		dispatcher.call(call(1, "agent", ["a", request]));
		const a = fake.created[0] as TaskHandle<unknown>;
		const unknown = handleOf("task_missing");
		const expectUnknown = (reply: ReturnType<typeof dispatcher.call>) => {
			expect(reply).toEqual({
				type: "reply",
				id: reply.id,
				ok: false,
				error: {
					name: "DynamicWorkflowHostError",
					message: MSG_UNKNOWN_TASK_HANDLE,
				},
				aborted: false,
			});
		};
		expectUnknown(
			dispatcher.call(
				call(2, "agent", ["b", { ...request, inputs: { x: refOf(unknown) } }]),
			),
		);
		expectUnknown(
			dispatcher.call(
				call(3, "agent", [
					"b",
					{
						...request,
						inputs: { x: { kind: "artifact-handle", ref: unknown.output.ref } },
					},
				]),
			),
		);
		// A handoff ref on a task that has no worktree handoff is unknown too.
		expectUnknown(
			dispatcher.call(
				call(4, "agent", [
					"b",
					{
						...request,
						inputs: {
							x: {
								kind: "artifact-handle",
								ref: artifactRef(a.ref.taskId, "handoff"),
							},
						},
					},
				]),
			),
		);
		expectUnknown(
			dispatcher.call(
				call(5, "agent", [
					"b",
					{
						...request,
						inputs: {
							x: { ...refOf(a), handoff: artifactRef(a.ref.taskId, "handoff") },
						},
					},
				]),
			),
		);
		expect(fake.calls).toHaveLength(1);
	});

	it("refuses invalid arguments before dispatch and lets the context validate phase and log lengths", () => {
		const fake = fakeContext();
		const dispatcher = createDynamicHostDispatcher({
			context: fake.context,
			bridge: fake.bridge,
		});
		const invalid = {
			name: "DynamicWorkflowHostError",
			message: MSG_CALL_ARGS_INVALID,
		};
		expect(dispatcher.call(call(1, "agent", [42, request]))).toMatchObject({
			ok: false,
			error: invalid,
		});
		expect(dispatcher.call(call(2, "agent", ["a"]))).toMatchObject({
			ok: false,
			error: invalid,
		});
		expect(
			dispatcher.call(call(3, "agentInNamespace", [[], "a", request])),
		).toMatchObject({ ok: false, error: invalid });
		expect(dispatcher.call(call(4, "phase", [1]))).toMatchObject({
			ok: false,
			error: invalid,
		});
		expect(dispatcher.call(call(5, "log", ["a", "b"]))).toMatchObject({
			ok: false,
			error: invalid,
		});
		expect(fake.calls).toHaveLength(0);
		// Over-long strings reach the context so its exact static message wins.
		expect(dispatcher.call(call(6, "phase", ["p".repeat(129)]))).toMatchObject({
			ok: false,
			error: {
				name: "StaticWorkflowRuntimeError",
				message: "Workflow phase must contain 1 to 128 characters.",
			},
		});
		expect(dispatcher.call(call(7, "log", [""]))).toMatchObject({
			ok: false,
			error: {
				name: "StaticWorkflowRuntimeError",
				message: "Workflow log must contain 1 to 4096 characters.",
			},
		});
		expect(fake.calls.map((recorded) => recorded.method)).toEqual([
			"phase",
			"log",
		]);
	});

	it("preserves the names of errors thrown by the context and mirrors abort", () => {
		const controller = new AbortController();
		const fake = fakeContext({
			signal: controller.signal,
			fail: (method) =>
				method === "agent"
					? named("WorkflowMaterializationError", "duplicate task key")
					: undefined,
		});
		const dispatcher = createDynamicHostDispatcher({
			context: fake.context,
			bridge: fake.bridge,
		});
		expect(dispatcher.call(call(1, "agent", ["a", request]))).toEqual({
			type: "reply",
			id: 1,
			ok: false,
			error: {
				name: "WorkflowMaterializationError",
				message: "duplicate task key",
			},
			aborted: false,
		});
		controller.abort(new Error("stop"));
		expect(dispatcher.call(call(2, "log", ["after abort"]))).toMatchObject({
			ok: true,
			aborted: true,
		});
	});
});

describe("dynamic host dispatcher: barriers and return handling", () => {
	it("dispatches result, results, settled, and handoff to the context", async () => {
		const fake = fakeContext();
		const dispatcher = createDynamicHostDispatcher({
			context: fake.context,
			bridge: fake.bridge,
		});
		dispatcher.call(call(1, "agent", ["a", request]));
		dispatcher.call(
			call(2, "agent", [
				"w",
				{ ...request, workspace: { mode: "worktree", cwd } },
			]),
		);
		const [a, w] = fake.created as [TaskHandle<unknown>, TaskHandle<unknown>];
		await expect(
			dispatcher.await(awaiting(3, "result", [refOf(a)])),
		).resolves.toEqual({
			type: "reply",
			id: 3,
			ok: true,
			value: { from: a.ref.taskId },
			aborted: false,
		});
		await expect(
			dispatcher.await(awaiting(4, "results", [refOf(a), refOf(w)])),
		).resolves.toMatchObject({
			ok: true,
			value: [{ from: a.ref.taskId }, { from: w.ref.taskId }],
		});
		await expect(
			dispatcher.await(awaiting(5, "settled", [refOf(w)])),
		).resolves.toMatchObject({
			ok: true,
			value: [{ status: "fulfilled", value: { from: w.ref.taskId } }],
		});
		const handoff = await dispatcher.await(awaiting(6, "handoff", [refOf(w)]));
		expect(handoff).toMatchObject({ ok: true, aborted: false });
		expect((handoff as { value: unknown }).value).toBeUndefined();
		const barriers = fake.calls.slice(2);
		expect(barriers.map((recorded) => recorded.method)).toEqual([
			"result",
			"results",
			"settled",
			"handoff",
		]);
		expect(barriers[0]?.args[0]).toBe(a);
		expect(barriers[1]?.args).toEqual([a, w]);
		expect(barriers[3]?.args[0]).toBe(w);
	});

	it("answers barrier rejections, unknown handles, and bad arity as reply errors", async () => {
		const controller = new AbortController();
		const fake = fakeContext({
			signal: controller.signal,
			fail: (method) =>
				method === "results"
					? named("WorkflowBarrierError", "task failed")
					: undefined,
		});
		const dispatcher = createDynamicHostDispatcher({
			context: fake.context,
			bridge: fake.bridge,
		});
		dispatcher.call(call(1, "agent", ["a", request]));
		const a = fake.created[0] as TaskHandle<unknown>;
		await expect(
			dispatcher.await(awaiting(2, "results", [refOf(a)])),
		).resolves.toEqual({
			type: "reply",
			id: 2,
			ok: false,
			error: { name: "WorkflowBarrierError", message: "task failed" },
			aborted: false,
		});
		await expect(
			dispatcher.await(awaiting(3, "result", [refOf(handleOf("task_zzz"))])),
		).resolves.toMatchObject({
			ok: false,
			error: {
				name: "DynamicWorkflowHostError",
				message: MSG_UNKNOWN_TASK_HANDLE,
			},
		});
		await expect(
			dispatcher.await(awaiting(4, "result", [refOf(a), refOf(a)])),
		).resolves.toMatchObject({
			ok: false,
			error: {
				name: "DynamicWorkflowHostError",
				message: MSG_CALL_ARGS_INVALID,
			},
		});
		await expect(
			dispatcher.await(awaiting(5, "handoff", [])),
		).resolves.toMatchObject({
			ok: false,
			error: {
				name: "DynamicWorkflowHostError",
				message: MSG_CALL_ARGS_INVALID,
			},
		});
		controller.abort();
		await expect(
			dispatcher.await(awaiting(6, "result", [refOf(a)])),
		).resolves.toMatchObject({
			ok: true,
			aborted: true,
		});
		// Only the well-formed barrier reached the context; the others were
		// refused before dispatch.
		expect(
			fake.calls.filter((recorded) => recorded.method === "result"),
		).toHaveLength(1);
	});

	it("bounds oversized barrier results to a reply error instead of a fatal failure", async () => {
		const fake = fakeContext({
			barrier: () => "x".repeat(MAX_DYNAMIC_RPC_MESSAGE_BYTES),
		});
		const dispatcher = createDynamicHostDispatcher({
			context: fake.context,
			bridge: fake.bridge,
		});
		dispatcher.call(call(1, "agent", ["a", request]));
		const a = fake.created[0] as TaskHandle<unknown>;
		await expect(
			dispatcher.await(awaiting(2, "result", [refOf(a)])),
		).resolves.toEqual({
			type: "reply",
			id: 2,
			ok: false,
			error: {
				name: "DynamicWorkflowHostError",
				message: MSG_BARRIER_RESULT_TOO_LARGE,
			},
			aborted: false,
		});
	});

	it("resolves done results to values and real handles and refuses unknown ones", () => {
		const fake = fakeContext();
		const dispatcher = createDynamicHostDispatcher({
			context: fake.context,
			bridge: fake.bridge,
		});
		dispatcher.call(call(1, "agent", ["a", request]));
		dispatcher.call(
			call(2, "agent", [
				"w",
				{ ...request, workspace: { mode: "worktree", cwd } },
			]),
		);
		const [a, w] = fake.created as [TaskHandle<unknown>, TaskHandle<unknown>];
		expect(dispatcher.done({ kind: "value", value: { answer: 1 } })).toEqual({
			answer: 1,
		});
		expect(dispatcher.done({ kind: "task", ref: a.ref })).toBe(a);
		expect(dispatcher.done({ kind: "artifact", ref: a.output.ref })).toBe(
			a.output,
		);
		expect(
			dispatcher.done({
				kind: "artifact",
				ref: artifactRef(w.ref.taskId, "handoff"),
			}),
		).toBe(w.handoff);
		for (const result of [
			{ kind: "task" as const, ref: taskRef("task_nope") },
			{
				kind: "task" as const,
				ref: { runId: "workflow_other0001", taskId: a.ref.taskId },
			},
			{ kind: "artifact" as const, ref: artifactRef("task_nope") },
			{ kind: "artifact" as const, ref: artifactRef(a.ref.taskId, "handoff") },
		]) {
			let caught: unknown;
			try {
				dispatcher.done(result);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(DynamicWorkflowExecutionError);
			expect(caught).toMatchObject({
				stage: "protocol",
				message: MSG_RETURNED_UNKNOWN_TASK_HANDLE,
			});
		}
	});
});

describe("dynamic host failure mapping", () => {
	it("maps VM failures to stages with the exact reasons", () => {
		const transform = executionErrorFromVmFailure({
			name: "DynamicTransformError",
			message: "Unexpected token",
		});
		expect(transform).toMatchObject({
			name: "DynamicWorkflowExecutionError",
			stage: "transform",
			message: "Dynamic workflow source failed to transform: Unexpected token",
		});
		expect((transform.cause as Error).name).toBe("DynamicTransformError");
		expect(
			executionErrorFromVmFailure({ name: "Error", message: "boom" }),
		).toMatchObject({
			stage: "source",
			message: "Dynamic workflow source execution failed: Error: boom",
		});
		expect(
			executionErrorFromVmFailure({
				name: DYNAMIC_BOOT_ERROR_NAME,
				message: "Dynamic workflow worker data is invalid.",
			}),
		).toMatchObject({
			stage: "boot",
			message:
				"Dynamic workflow VM failed to boot: Dynamic workflow worker data is invalid.",
		});
		expect(
			executionErrorFromVmFailure({ name: "E", message: "m".repeat(5000) })
				.message,
		).toHaveLength(4096);
		expect(bootTimeoutMessage(DYNAMIC_VM_BOOT_TIMEOUT_MS)).toBe(
			"Dynamic workflow VM did not boot within 10000 ms.",
		);
		expect(computeTimeoutMessage(DYNAMIC_VM_COMPUTE_TIMEOUT_MS)).toBe(
			"Dynamic workflow VM exceeded 30000 ms of compute between host messages.",
		);
		expect(MSG_VM_OUT_OF_MEMORY).toBe(
			"Dynamic workflow VM exceeded its memory limit.",
		);
		expect(MSG_EXECUTION_ABORTED).toBe(
			"Dynamic workflow execution was aborted.",
		);
		expect(MSG_VM_CRASHED).toBe("Dynamic workflow VM crashed.");
		// A worker that saw the host's abort before `ready` reports stage
		// "abort" only when the host did abort; otherwise the name is the
		// source's own and cannot spoof the stage.
		const abortedInBoot = { name: DYNAMIC_ABORT_ERROR_NAME, message: "stop" };
		expect(
			executionErrorFromVmFailure(abortedInBoot, { aborted: true }),
		).toMatchObject({ stage: "abort", message: MSG_EXECUTION_ABORTED });
		expect(
			executionErrorFromVmFailure(abortedInBoot, { aborted: false }),
		).toMatchObject({
			stage: "source",
			message: `Dynamic workflow source execution failed: ${DYNAMIC_ABORT_ERROR_NAME}: stop`,
		});
		expect(executionErrorFromVmFailure(abortedInBoot)).toMatchObject({
			stage: "source",
		});
	});

	it("derives the abort reason forwarded to the VM", () => {
		const withMessage = new AbortController();
		withMessage.abort(new Error("Operator stop."));
		expect(abortReasonOf(withMessage.signal)).toBe("Operator stop.");
		const bare = new AbortController();
		bare.abort("plain string reason");
		expect(abortReasonOf(bare.signal)).toBe(MSG_STOP_REQUESTED);
		const empty = new AbortController();
		empty.abort(new Error(""));
		expect(abortReasonOf(empty.signal)).toBe(MSG_STOP_REQUESTED);
		const long = new AbortController();
		long.abort(new Error("x".repeat(5000)));
		expect(abortReasonOf(long.signal)).toHaveLength(4096);
	});

	it("reads the tests-only sync wait override from argv and resolves the worker entry", () => {
		expect(syncWaitMsFromArgv([`${DYNAMIC_SYNC_WAIT_ARGV_PREFIX}200`])).toBe(
			200,
		);
		expect(
			syncWaitMsFromArgv(["node", `${DYNAMIC_SYNC_WAIT_ARGV_PREFIX}abc`]),
		).toBeUndefined();
		expect(syncWaitMsFromArgv([])).toBeUndefined();
		const entry = resolveDynamicWorkerEntry();
		expect(entry.entry.pathname.endsWith("/src/dynamic/worker.ts")).toBe(true);
		expect(entry.execArgv).toEqual(["--import", "tsx"]);
	});

	it("keeps pi-subagent out of the worker's module graph", async () => {
		// Every module the worker loads before `ready` stays on the TypeBox-only
		// half of the contracts (`contracts-core.ts`, `digest.ts`): the
		// pi-subagent graph alone costs about a second per boot (860 ms from
		// dist, 1.3 s from source on an idle host). Value imports are followed;
		// type-only imports are erased and may point anywhere.
		const root = new URL("../src/", import.meta.url);
		const seen = new Set<string>();
		const external = new Set<string>();
		const queue = [new URL("dynamic/worker.ts", root)];
		for (let next = queue.shift(); next; next = queue.shift()) {
			if (seen.has(next.href)) continue;
			seen.add(next.href);
			const ast = parse(await readFile(next, "utf8"), {
				sourceType: "module",
				plugins: ["typescript"],
			});
			for (const node of ast.program.body) {
				let source: string | undefined;
				if (node.type === "ImportDeclaration") {
					if (node.importKind === "type") continue;
					if (
						node.specifiers.length > 0 &&
						node.specifiers.every(
							(specifier) =>
								specifier.type === "ImportSpecifier" &&
								specifier.importKind === "type",
						)
					) {
						continue;
					}
					source = node.source.value;
				} else if (node.type === "ExportNamedDeclaration" && node.source) {
					if (node.exportKind === "type") continue;
					source = node.source.value;
				} else if (node.type === "ExportAllDeclaration") {
					if (node.exportKind === "type") continue;
					source = node.source.value;
				}
				if (source === undefined) continue;
				if (source.startsWith(".")) {
					queue.push(new URL(source.replace(/\.js$/, ".ts"), next));
				} else {
					external.add(source);
				}
			}
		}
		const relative = [...seen]
			.map((href) => href.slice(root.href.length))
			.sort();
		expect(relative).toContain("contracts-core.ts");
		expect(relative).toContain("digest.ts");
		expect(relative).not.toContain("contracts.ts");
		expect(relative).not.toContain("execution.ts");
		expect(relative).not.toContain("static-runtime.ts");
		expect(
			[...external]
				.filter((specifier) => !specifier.startsWith("node:"))
				.sort(),
		).toEqual([
			"@babel/parser",
			"ajv",
			"ajv-formats",
			"amaro",
			"typebox",
			"typebox/value",
		]);
	});
});

/*
 * Real workers from here on.
 */

const META = `{ name: "vm-host", description: "VM host run", version: 1, budget: { cost: 1, childRuntimeMs: 60000 }, timeoutMs: 60000 }`;
const REQUEST_VALUE = {
	agent: "researcher",
	workspace: { mode: "read-only", cwd: "/repo" },
};
const REQUEST = JSON.stringify(REQUEST_VALUE);

function sourceWith(run: string, extra = ""): string {
	return `import { defineWorkflow } from "@vegardx/pi-workflow";
import { Type } from "typebox";
${extra}
export default defineWorkflow({
	meta: ${META},
	inputSchema: Type.Object({ topic: Type.String() }),
	outputSchema: Type.Object({}, { additionalProperties: true }),
	async run(ctx) {
${run}
	},
});
`;
}

function vmFor(
	source: string,
	options: {
		readonly overrides?: DynamicVmBridgeOverrides;
		readonly onBoot?: (info: { threadId: number }) => void;
		readonly onReady?: () => void;
	} = {},
) {
	return createDynamicVm({
		source,
		supportHelpers: [],
		epochMs,
		seed,
		...options,
		overrides: { ...BOOT_ALLOWANCE, ...options.overrides },
	});
}

async function rejection(
	promise: Promise<unknown>,
): Promise<DynamicWorkflowExecutionError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(DynamicWorkflowExecutionError);
		return error as DynamicWorkflowExecutionError;
	}
	throw new Error("expected rejection");
}

describe("extractDynamicWorkflowManifest", () => {
	it("boots a manifest-mode worker and returns the normalised manifest", async () => {
		const threads: number[] = [];
		const manifest = await extractDynamicWorkflowManifest({
			source: sourceWith("return {};"),
			supportHelpers: [],
			overrides: BOOT_ALLOWANCE,
			onBoot: (info) => threads.push(info.threadId),
		});
		expect(manifest.meta).toEqual({
			name: "vm-host",
			description: "VM host run",
			version: 1,
			budget: { cost: 1, childRuntimeMs: 60000 },
			timeoutMs: 60000,
			concurrency: DEFAULT_WORKFLOW_CONCURRENCY,
		});
		expect(manifest.inputSchema).toEqual(
			JSON.parse(JSON.stringify(Type.Object({ topic: Type.String() }))),
		);
		expect(threads).toHaveLength(1);
		expect(threads[0]).toBeGreaterThan(0);
	});

	it("reports transform failures with the transform stage", async () => {
		const transform = await rejection(
			extractDynamicWorkflowManifest({
				source: "const x: = 1;",
				supportHelpers: [],
				overrides: BOOT_ALLOWANCE,
			}),
		);
		expect(transform.stage).toBe("transform");
		expect(
			transform.message.startsWith(
				"Dynamic workflow source failed to transform: ",
			),
		).toBe(true);
		const missingImport = await rejection(
			extractDynamicWorkflowManifest({
				source: 'import fs from "node:fs"; export default fs;',
				supportHelpers: [],
				overrides: BOOT_ALLOWANCE,
			}),
		);
		expect(missingImport.stage).toBe("transform");
		expect(missingImport.message).toBe(
			"Dynamic workflow source failed to transform: dynamic workflow import node:fs is not available",
		);
	});

	it("reports definition and load failures with the source stage", async () => {
		const definition = await rejection(
			extractDynamicWorkflowManifest({
				source: "export default { nope: true };",
				supportHelpers: [],
				overrides: BOOT_ALLOWANCE,
			}),
		);
		expect(definition).toMatchObject({
			stage: "source",
			message:
				"Dynamic workflow source execution failed: DynamicDefinitionError: workflow module has no valid default definition",
		});
		const thrown = await rejection(
			extractDynamicWorkflowManifest({
				source:
					'export default (() => { throw new TypeError("boom at load"); })();',
				supportHelpers: [],
				overrides: BOOT_ALLOWANCE,
			}),
		);
		expect(thrown).toMatchObject({
			stage: "source",
			message:
				"Dynamic workflow source execution failed: TypeError: boom at load",
		});
	});

	it("enforces the boot watchdog", async () => {
		const error = await rejection(
			extractDynamicWorkflowManifest({
				source: sourceWith("return {};"),
				supportHelpers: [],
				overrides: { bootTimeoutMs: 1 },
			}),
		);
		expect(error).toMatchObject({
			stage: "boot",
			message: "Dynamic workflow VM did not boot within 1 ms.",
		});
	});
});

describe("createDynamicVm run", () => {
	const runSource = sourceWith(`
		ctx.phase("collect");
		ctx.log("input " + ctx.input.topic);
		const a = ctx.agent("a", ${REQUEST});
		const b = ctx.agent("b", { ...${REQUEST}, inputs: { prior: a.output }, after: [a.ref] });
		const fan = ctx.fanOut("items", ["x", "y"], { key: (item) => item, task: () => (${REQUEST}) });
		const chain = ctx.pipeline("chain", (stage) => stage.agent("last", ${REQUEST}));
		const merged = ctx.fanIn("merge", fan, { inputKey: (_, index) => "s" + index, task: ${REQUEST} });
		const [ra, rb] = await ctx.results([a, b]);
		const fanned = await ctx.settled(fan);
		const last = await ctx.result(chain);
		return {
			ra, rb, fanned, last,
			now: Date.now(), rand: [Math.random(), Math.random()],
			probes: [typeof process, typeof require, typeof fetch, typeof setTimeout],
			runId: ctx.runId, cwd: ctx.cwd, mergedKey: merged.ref.taskId,
		};`);

	it("drives declarations and barriers through the context and returns the value", async () => {
		const fake = fakeContext();
		const threads: number[] = [];
		const vm = vmFor(runSource, {
			onBoot: (info) => threads.push(info.threadId),
		});
		const value = (await vm.run(fake.context)) as Record<string, unknown>;
		const [a, b, x, y, last, merged] = fake.created as TaskHandle<unknown>[];
		expect(value).toMatchObject({
			ra: { from: a?.ref.taskId },
			rb: { from: b?.ref.taskId },
			fanned: [
				{ status: "fulfilled", value: { from: x?.ref.taskId } },
				{ status: "fulfilled", value: { from: y?.ref.taskId } },
			],
			last: { from: last?.ref.taskId },
			now: epochMs,
			probes: ["undefined", "undefined", "undefined", "undefined"],
			runId,
			cwd,
			mergedKey: merged?.ref.taskId,
		});
		expect(fake.calls.map((recorded) => recorded.method)).toEqual([
			"phase",
			"log",
			"agent",
			"agent",
			"agentInNamespace",
			"agentInNamespace",
			"agentInNamespace",
			"agent",
			"results",
			"settled",
			"result",
		]);
		expect(fake.calls[1]?.args).toEqual(["input alpha"]);
		const bRequest = fake.calls[3]?.args[1] as {
			inputs: { prior: unknown };
			after: unknown[];
		};
		expect(bRequest.inputs.prior).toBe(a?.output);
		expect(bRequest.after).toEqual([a?.ref]);
		expect(fake.calls[4]?.args).toEqual([["items"], "x", REQUEST_VALUE]);
		expect(fake.calls[6]?.args.slice(0, 2)).toEqual([["chain"], "last"]);
		const mergeRequest = fake.calls[7]?.args[1] as {
			inputs: Record<string, unknown>;
		};
		expect(mergeRequest.inputs).toEqual({ s0: x?.output, s1: y?.output });
		expect(fake.calls[8]?.args).toEqual([a, b]);
		expect(threads).toHaveLength(1);
	});

	it("yields the same random stream for the same seed on a fresh worker", async () => {
		// Determinism aids: every drive boots its own worker, and the seed alone
		// decides the `Math.random` stream.
		const threads: number[] = [];
		const first = (await vmFor(runSource, {
			onBoot: (info) => threads.push(info.threadId),
		}).run(fakeContext().context)) as Record<string, unknown>;
		const second = (await vmFor(runSource, {
			onBoot: (info) => threads.push(info.threadId),
		}).run(fakeContext().context)) as Record<string, unknown>;
		expect(second.rand).toEqual(first.rand);
		expect(threads).toHaveLength(2);
		expect(threads[1]).not.toBe(threads[0]);
	});

	it("yields a different random stream for a different seed", async () => {
		const value = (await vmFor(runSource).run(fakeContext().context)) as Record<
			string,
			unknown
		>;
		const otherSeed = (await createDynamicVm({
			source: runSource,
			supportHelpers: [],
			epochMs,
			seed: "8".repeat(64),
			overrides: BOOT_ALLOWANCE,
		}).run(fakeContext().context)) as Record<string, unknown>;
		expect(otherSeed.rand).not.toEqual(value.rand);
	});

	it("resolves returned task and artifact handles to the host's real handles", async () => {
		const taskFake = fakeContext();
		const task = await vmFor(
			sourceWith(`return ctx.agent("a", ${REQUEST});`),
		).run(taskFake.context);
		expect(task).toBe(taskFake.created[0]);
		const artifactFake = fakeContext();
		const artifact = await vmFor(
			sourceWith(`return ctx.agent("a", ${REQUEST}).output;`),
		).run(artifactFake.context);
		expect(artifact).toBe(artifactFake.created[0]?.output);
	});

	it("fails with the source stage when the source throws and refuses non-JSON returns", async () => {
		const thrown = await rejection(
			vmFor(
				sourceWith(`ctx.agent("a", ${REQUEST}); throw new Error("boom");`),
			).run(fakeContext().context),
		);
		expect(thrown).toMatchObject({
			stage: "source",
			message: "Dynamic workflow source execution failed: Error: boom",
		});
		const nonJson = await rejection(
			vmFor(sourceWith("return () => 1;")).run(fakeContext().context),
		);
		expect(nonJson).toMatchObject({
			stage: "source",
			message:
				"Dynamic workflow source execution failed: Error: Dynamic workflow return value is not JSON.",
		});
	});

	it("surfaces host reply errors inside the source with the static message", async () => {
		const staticMessage = await rejection(
			vmFor(sourceWith(`ctx.phase("p".repeat(129)); return {};`)).run(
				fakeContext().context,
			),
		);
		expect(staticMessage.message).toBe(
			"Dynamic workflow source execution failed: StaticWorkflowRuntimeError: Workflow phase must contain 1 to 128 characters.",
		);
	});

	it("fails the run when onReady rejects the manifest", async () => {
		const error = await rejection(
			vmFor(sourceWith("return {};"), {
				onReady() {
					throw new DynamicWorkflowExecutionError(
						"manifest",
						"Dynamic workflow manifest changed since approval.",
					);
				},
			}).run(fakeContext().context),
		);
		expect(error).toMatchObject({
			stage: "manifest",
			message: "Dynamic workflow manifest changed since approval.",
		});
	});

	it("requires the static runtime context and runs at most once", async () => {
		const withoutBridge = fakeContext({ bridge: false });
		const vm = vmFor(sourceWith("return {};"));
		const error = await rejection(vm.run(withoutBridge.context));
		expect(error).toMatchObject({
			stage: "protocol",
			message: MSG_BRIDGE_REQUIRES_STATIC_CONTEXT,
		});
		await expect(vm.run(fakeContext().context)).rejects.toThrow(
			"Dynamic workflow VM has already run.",
		);
		const controller = new AbortController();
		controller.abort();
		const booted: number[] = [];
		const aborted = await rejection(
			vmFor(sourceWith("return {};"), {
				onBoot: (info) => booted.push(info.threadId),
			}).run(fakeContext({ signal: controller.signal }).context),
		);
		expect(aborted).toMatchObject({
			stage: "abort",
			message: MSG_EXECUTION_ABORTED,
		});
		expect(booted).toHaveLength(0);
		await expect(vm.terminate()).resolves.toBeUndefined();
	});
});

describe("createDynamicVm watchdogs, memory, and abort", () => {
	it("terminates a VM that computes past the compute watchdog", async () => {
		const error = await rejection(
			vmFor(sourceWith("for (;;) {}"), {
				overrides: { computeTimeoutMs: 300 },
			}).run(fakeContext().context),
		);
		expect(error).toMatchObject({
			stage: "watchdog",
			message:
				"Dynamic workflow VM exceeded 300 ms of compute between host messages.",
		});
	});

	it("pauses the compute watchdog while a barrier is outstanding", async () => {
		const fake = fakeContext({
			barrier: (method, targets) =>
				new Promise((resolve) =>
					setTimeout(
						() => resolve({ method, slow: targets[0]?.ref.taskId }),
						800,
					),
				),
		});
		const value = await vmFor(
			sourceWith(
				`const a = ctx.agent("a", ${REQUEST}); return await ctx.result(a);`,
			),
			{ overrides: { computeTimeoutMs: 300 } },
		).run(fake.context);
		expect(value).toEqual({
			method: "result",
			slow: fake.created[0]?.ref.taskId,
		});
	});

	it("fails with the memory stage when the worker exceeds its heap limit", async () => {
		const error = await rejection(
			vmFor(
				sourceWith(
					"const chunks = []; for (;;) chunks.push(new Array(262144).fill(1.5)); return chunks;",
				),
				{
					overrides: {
						resourceLimits: {
							maxOldGenerationSizeMb: 48,
							maxYoungGenerationSizeMb: 8,
							codeRangeSizeMb: 16,
							stackSizeMb: 4,
						},
					},
				},
			).run(fakeContext().context),
		);
		expect(error).toMatchObject({
			stage: "memory",
			message: MSG_VM_OUT_OF_MEMORY,
		});
	});

	it("mirrors abort into the VM and terminates after the grace period", async () => {
		const controller = new AbortController();
		const fake = fakeContext({
			signal: controller.signal,
			barrier: () =>
				new Promise(() => {
					setTimeout(() => controller.abort(new Error("Operator stop.")), 50);
				}),
		});
		const error = await rejection(
			vmFor(
				sourceWith(`
					const a = ctx.agent("a", ${REQUEST});
					ctx.signal.addEventListener("abort", () => ctx.log("aborted:" + ctx.signal.aborted + ":" + ctx.signal.reason.message));
					return await ctx.result(a);`),
			).run(fake.context),
		);
		expect(error).toMatchObject({
			stage: "abort",
			message: MSG_EXECUTION_ABORTED,
		});
		expect(fake.calls.map((recorded) => recorded.method)).toEqual([
			"agent",
			"result",
			"log",
		]);
		expect(fake.calls[2]?.args).toEqual(["aborted:true:Operator stop."]);
	});

	it("lets a VM that finishes within the grace period complete after abort", async () => {
		const controller = new AbortController();
		const fake = fakeContext({
			signal: controller.signal,
			barrier: () =>
				new Promise(() => {
					setTimeout(() => controller.abort(), 50);
				}),
		});
		const value = await vmFor(
			sourceWith(`
				const a = ctx.agent("a", ${REQUEST});
				const stopped = new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve("stopped")));
				return { outcome: await Promise.race([ctx.result(a), stopped]) };`),
		).run(fake.context);
		expect(value).toEqual({ outcome: "stopped" });
	});
});

describe("worker boot inbox", () => {
	/**
	 * Boots the real run-mode worker directly, posting `messages` at once so
	 * they queue ahead of the worker's bootstrap, and collects what it posts
	 * until `until` matches; the worker is then terminated. With `awaitExit`
	 * the worker's own exit is awaited first: a worker that ends itself right
	 * after posting has its message delivered before its `exit` event, but a
	 * `terminate()` that lands while the thread is still tearing down replaces
	 * the exit code with 1, so the code is only meaningful after the natural
	 * exit.
	 */
	async function bootWorker(
		messages: readonly unknown[],
		until: (message: DynamicVmMessage) => boolean,
		options: { readonly awaitExit?: boolean } = {},
	): Promise<{
		readonly received: DynamicVmMessage[];
		readonly exitCode: number | undefined;
	}> {
		const source = sourceWith(`
			const reason = await new Promise((resolve) =>
				ctx.signal.addEventListener("abort", () => resolve(ctx.signal.reason.message)),
			);
			return { reason };`);
		const channel = createDynamicSyncChannel();
		const resolved = resolveDynamicWorkerEntry();
		const data: DynamicWorkerData = {
			mode: "run",
			source,
			sourceSha256: deriveDynamicSourceSha256(source),
			filename: "dynamic:boot-inbox.workflow.ts",
			supportHelpers: [],
			syncBuffer: channel.syncBuffer,
			syncPort: channel.workerPort,
		};
		const worker = new Worker(resolved.entry, {
			workerData: data,
			transferList: [channel.workerPort],
			execArgv: [...resolved.execArgv],
			stdout: true,
			stderr: true,
			env: {},
		});
		worker.stdout.resume();
		worker.stderr.resume();
		const received: DynamicVmMessage[] = [];
		let exitCode: number | undefined;
		const exited = new Promise<void>((resolve) => {
			worker.on("exit", (code) => {
				exitCode = code;
				resolve();
			});
		});
		const done = new Promise<void>((resolve) => {
			worker.on("message", (message: DynamicVmMessage) => {
				received.push(message);
				if (until(message)) resolve();
			});
		});
		for (const message of messages) worker.postMessage(message);
		try {
			await Promise.race([done, exited]);
			if (options.awaitExit) await exited;
		} finally {
			await worker.terminate();
			channel.hostPort.close();
		}
		await exited;
		return { received, exitCode };
	}

	it("ends cleanly with an abort failure when the host aborts before start", async () => {
		const { received, exitCode } = await bootWorker(
			[{ type: "abort", reason: "Operator stop." }],
			(message) => message.type === "failed",
			{ awaitExit: true },
		);
		expect(received).toEqual([
			{
				type: "failed",
				error: { name: DYNAMIC_ABORT_ERROR_NAME, message: "Operator stop." },
			},
		]);
		expect(exitCode).toBe(0);
		expect(
			executionErrorFromVmFailure(
				(received[0] as { error: { name: string; message: string } }).error,
				{ aborted: true },
			),
		).toMatchObject({ stage: "abort", message: MSG_EXECUTION_ABORTED });
	}, 60_000);

	it("delivers an abort queued during boot to the source instead of dropping it", async () => {
		const { received } = await bootWorker(
			[
				{
					type: "start",
					input: { topic: "alpha" },
					runId,
					cwd,
					seed,
					epochMs,
				},
				{ type: "abort", reason: "Operator stop." },
			],
			(message) => message.type === "done" || message.type === "failed",
		);
		expect(received.map((message) => message.type)).toEqual(["ready", "done"]);
		expect(received[1]).toEqual({
			type: "done",
			result: { kind: "value", value: { reason: "Operator stop." } },
		});
	}, 60_000);
});

describe("createDynamicVm protocol enforcement", () => {
	function rogue(scenario: string) {
		return createDynamicVm({
			source: scenario,
			sourceSha256: "9".repeat(64),
			supportHelpers: [],
			epochMs,
			seed,
			overrides: {
				workerEntry: ROGUE_ENTRY,
				bootTimeoutMs: 60_000,
				computeTimeoutMs: 400,
			},
		}).run(fakeContext().context);
	}

	it.each([
		["invalid-message", MSG_VM_INVALID_MESSAGE],
		["oversized", MSG_VM_MESSAGE_TOO_LARGE],
		["non-contiguous", MSG_VM_REQUEST_IDS_NOT_CONTIGUOUS],
		["before-ready", MSG_VM_INVALID_MESSAGE],
		["double-ready", MSG_VM_INVALID_MESSAGE],
		["unknown-return-task", MSG_RETURNED_UNKNOWN_TASK_HANDLE],
		["unknown-return-artifact", MSG_RETURNED_UNKNOWN_TASK_HANDLE],
	])(
		"terminates on %s with the exact protocol reason",
		async (scenario, message) => {
			const error = await rejection(rogue(scenario));
			expect(error).toMatchObject({ stage: "protocol", message });
		},
	);

	it("terminates once the message budget is exhausted", async () => {
		const error = await rejection(rogue("too-many"));
		expect(error).toMatchObject({
			stage: "protocol",
			message: MSG_VM_TOO_MANY_MESSAGES,
		});
	});

	it("reports unexpected exits and crashes", async () => {
		expect(await rejection(rogue("exit"))).toMatchObject({
			stage: "exit",
			message: "Dynamic workflow VM exited unexpectedly with code 3.",
		});
		const crashed = await rejection(rogue("throw"));
		expect(crashed).toMatchObject({ stage: "exit", message: MSG_VM_CRASHED });
		expect((crashed.cause as Error).message).toBe("kaboom");
	});

	it("reports silence through the compute and boot watchdogs", async () => {
		expect(await rejection(rogue("hang"))).toMatchObject({
			stage: "watchdog",
			message:
				"Dynamic workflow VM exceeded 400 ms of compute between host messages.",
		});
		const noReady = await rejection(
			createDynamicVm({
				source: "no-ready",
				supportHelpers: [],
				epochMs,
				seed,
				overrides: { workerEntry: ROGUE_ENTRY, bootTimeoutMs: 300 },
			}).run(fakeContext().context),
		);
		expect(noReady).toMatchObject({
			stage: "boot",
			message: "Dynamic workflow VM did not boot within 300 ms.",
		});
	});
});

/*
 * Park: a real static runtime whose scheduler parks at a checkpoint. The VM
 * must be torn down without a `-> failed` transition and the drive resolves
 * parked.
 */

const CHECKPOINT_AWAITS_REASON = "Checkpoint awaits a decision.";
const RUN_AWAITS_REASON = "Workflow run awaits a checkpoint decision.";
const parkRoot = path.resolve(".pi", `test-dynamic-vm-host-${randomUUID()}`);
const leases = new Set<WorkflowRunLease>();

afterEach(async () => {
	await Promise.all([...leases].map((lease) => lease.release()));
	leases.clear();
});

afterAll(async () => {
	await rm(parkRoot, { recursive: true, force: true });
});

function parkingScheduler(
	journal: WorkflowRunJournal,
): WorkflowSequentialScheduler {
	return {
		concurrency: 1,
		stopSignal: new AbortController().signal,
		async drive(): Promise<WorkflowSchedulerOutcome> {
			let current = reduceWorkflowEvents(await journal.readEvents());
			if (current.status === "created" || current.status === "waiting") {
				await journal.append("run-status-changed", {
					from: current.status,
					to: "running",
				});
				current = reduceWorkflowEvents(await journal.readEvents());
			}
			const task = Object.values(current.tasks)
				.filter((candidate) => candidate.committed)
				.find((candidate) => candidate.status !== "completed");
			if (!task) return { state: "idle", runStatus: current.status };
			const spec = task.task.spec;
			if (spec.kind !== "checkpoint")
				throw new Error("parking scheduler only supports checkpoints");
			const taskId = task.task.id;
			const executionId = deriveTaskExecutionId(current.runId, taskId, 1);
			if (task.status === "pending") {
				await journal.append("task-status-changed", {
					taskId,
					from: "pending",
					to: "ready",
				});
				await journal.append("task-execution-created", {
					execution: {
						kind: "checkpoint",
						id: executionId,
						runId: current.runId,
						taskId,
						generation: 1,
						taskIdentitySha256: spec.identitySha256,
					},
				});
				await journal.append("task-execution-checkpoint-requested", {
					executionId,
					inputsSha256: deriveJsonValueSha256({}),
				});
				await journal.append("task-status-changed", {
					taskId,
					from: "ready",
					to: "waiting",
					reason: CHECKPOINT_AWAITS_REASON,
				});
			}
			await journal.append("run-status-changed", {
				from: "running",
				to: "waiting",
				reason: RUN_AWAITS_REASON,
			});
			return {
				state: "awaiting-decision",
				runStatus: "waiting",
				pendingCheckpoints: [{ taskId, executionId }],
			};
		},
		async reconcile() {
			throw new Error("fake workflow has no cleanup-blocked task");
		},
		async decide() {
			throw new Error("fake scheduler records no decisions");
		},
		async stop() {
			return { state: "terminal", runStatus: "cancelled" } as const;
		},
	};
}

describe("createDynamicVm park handling", () => {
	it("terminates the VM and rethrows the park signal so the static runtime parks", async () => {
		const source = `import { defineWorkflow } from "@vegardx/pi-workflow";
import { Type } from "typebox";
export default defineWorkflow({
	meta: ${META},
	inputSchema: Type.Object({ topic: Type.String() }),
	outputSchema: Type.Object({ proceed: Type.Boolean() }),
	async run(ctx) {
		const gate = ctx.checkpoint("gate", { schema: Type.Object({ proceed: Type.Boolean() }), prompt: "Proceed?", headless: "block" });
		return await ctx.result(gate);
	},
});
`;
		const threads: number[] = [];
		const definition = defineWorkflow({
			meta: {
				name: "vm-host",
				description: "VM host run",
				version: 1,
				budget: { cost: 1, childRuntimeMs: 60000 },
				timeoutMs: 60000,
			},
			inputSchema: Type.Object({ topic: Type.String() }),
			outputSchema: Type.Object({ proceed: Type.Boolean() }),
			run(ctx) {
				return createDynamicVm({
					source,
					supportHelpers: [],
					epochMs,
					seed,
					overrides: BOOT_ALLOWANCE,
					onBoot: (info) => threads.push(info.threadId),
				}).run(ctx as WorkflowContext<unknown>) as Promise<never>;
			},
		});
		const storeRoot = path.join(parkRoot, randomUUID());
		const parkRunId = "workflow_vmpark0001";
		const lease = await acquireWorkflowRunLease({
			storeRoot,
			runId: parkRunId,
			ownerId: "vm-host-test",
		});
		leases.add(lease);
		const journal = await WorkflowRunJournal.open(storeRoot, parkRunId, lease);
		const artifacts = await WorkflowArtifactStore.open({ journal });
		const runtime = createStaticWorkflowRuntime({
			definition,
			definitionIdentitySha256: "a".repeat(64),
			input: { topic: "alpha" },
			cwd,
			journal,
			artifacts,
			scheduler: parkingScheduler(journal),
		});
		const result = await runtime.drive();
		expect(isStaticWorkflowParked(result)).toBe(true);
		if (!isStaticWorkflowParked(result)) throw new Error("unreachable");
		expect(result.pendingCheckpoints).toHaveLength(1);
		const statuses = (await journal.readEvents())
			.filter((event) => event.type === "run-status-changed")
			.map((event) => (event.data as { to: string }).to);
		expect(statuses).toEqual(["running", "waiting"]);
		expect(threads).toHaveLength(1);
	});
});
