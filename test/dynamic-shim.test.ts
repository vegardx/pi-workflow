import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import type { RunResult } from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WorkflowArtifactStore } from "../src/artifact-store.js";
import {
	createTaskHandle,
	defineWorkflow,
	isTaskHandle,
	type NestedWorkflowRequest,
	type TaskHandle,
	type WorkflowContext,
	type WorkflowDefinition,
} from "../src/definition.js";
import {
	DYNAMIC_CONTEXT_METHODS,
	DYNAMIC_CONTEXT_PROPERTIES,
	DYNAMIC_SHIM_EXPORTS,
} from "../src/dynamic/constants.js";
import {
	answerDynamicCallSync,
	createDynamicSyncChannel,
	createDynamicVmMessageGuard,
	type DynamicAwaitMessage,
	type DynamicCallMessage,
	type DynamicStartMessage,
	type DynamicSyncChannel,
	type DynamicTaskHandleRef,
	type DynamicVmMessage,
	MSG_BARRIER_TARGET_NOT_HANDLE,
	MSG_HOST_INVALID_MESSAGE,
	MSG_HOST_UNKNOWN_REQUEST,
	MSG_REQUEST_CONTAINS_FUNCTION,
	MSG_RETURN_NOT_JSON,
	MSG_SOURCE_MAY_NOT_REGISTER,
	MSG_STOP_REQUESTED,
	toDynamicTaskHandleRef,
	toDynamicVmError,
} from "../src/dynamic/rpc.js";
import {
	createDynamicModules,
	createDynamicVmContext,
	createVmWorkflowContext,
	type DynamicShimTransport,
	type DynamicVmSession,
	dynamicDefineSupportTask,
	dynamicManifestOf,
	evaluateDynamicSource,
	MSG_NO_DEFAULT_DEFINITION,
	normalizeDynamicDefinition,
	serializeDynamicRequest,
	serializeDynamicReturn,
} from "../src/dynamic/shim.js";
import { transformDynamicSource } from "../src/dynamic/transformer.js";
import {
	deriveJsonValueSha256,
	deriveSubagentOperationId,
	deriveSubagentResultSha256,
	deriveTaskExecutionId,
} from "../src/execution.js";
import { WorkflowRunJournal } from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
	type WorkflowRunLease,
} from "../src/persistence/run-lease.js";
import { discoverWorkflows } from "../src/registry.js";
import type {
	WorkflowSchedulerOutcome,
	WorkflowSequentialScheduler,
} from "../src/scheduler.js";
import {
	createStaticWorkflowRuntime,
	isStaticWorkflowParked,
} from "../src/static-runtime.js";

const runId = "workflow_shim0001";
const sha = "1".repeat(64);
const start: DynamicStartMessage = {
	type: "start",
	input: { topics: ["alpha", "beta"], nested: { deep: [1, 2] } },
	runId,
	cwd: "/repo",
	seed: sha,
	epochMs: 1_700_000_000_000,
};

function request(goal = "Answer") {
	return {
		agent: "researcher",
		task: { goal, context: [], instructions: ["Return structured output."] },
		contextMode: "fresh" as const,
		tools: ["read"],
		preloadSkills: [],
		contextScopes: ["project" as const],
		workspace: { mode: "read-only" as const, cwd: "/repo" },
		outputSchema: Type.Object({ answer: Type.String() }),
		limits: {
			cumulativeRuntimeMs: 300_000,
			attemptTimeoutMs: 300_000,
			totalTokens: 1_000_000,
			cost: 10,
			outputBytes: 1024,
			workspaceWriteBytes: 0,
			retries: 0,
			resumes: 0,
		},
	};
}

function fakeHandleRef(
	index: number,
	options: { handoff?: boolean } = {},
): DynamicTaskHandleRef {
	const taskId = `task_${index}`;
	return {
		kind: "task-handle",
		ref: { runId, taskId },
		output: { runId, producerTaskId: taskId, output: "result" },
		...(options.handoff
			? { handoff: { runId, producerTaskId: taskId, output: "handoff" } }
			: {}),
	};
}

/**
 * An in-thread host: `call` messages are answered synchronously (before the
 * shim even reaches `Atomics.wait`), `await` messages asynchronously on the
 * main channel, and every VM message is recorded and admitted through the
 * real guard.
 */
function fakeHost(handlers: {
	dispatch?: (message: DynamicCallMessage) => unknown;
	onAwait?: (message: DynamicAwaitMessage) => Promise<unknown>;
	aborted?: () => boolean;
}) {
	const channel: DynamicSyncChannel = createDynamicSyncChannel();
	const stream: DynamicVmMessage[] = [];
	const guard = createDynamicVmMessageGuard();
	let session: DynamicVmSession | undefined;
	let settle: ((message: DynamicVmMessage) => void) | undefined;
	const finished = new Promise<DynamicVmMessage>((resolve) => {
		settle = resolve;
	});
	let declared = 0;
	const dispatch =
		handlers.dispatch ??
		((message: DynamicCallMessage) => {
			if (message.method === "phase" || message.method === "log") return null;
			declared += 1;
			return fakeHandleRef(declared);
		});
	const onAwait =
		handlers.onAwait ??
		(async (message: DynamicAwaitMessage) =>
			message.handles.map((handle) => ({ from: handle.ref.taskId })));
	const transport: DynamicShimTransport = {
		syncBuffer: channel.syncBuffer,
		syncPort: channel.workerPort,
		post(message) {
			stream.push(message);
			const accepted = guard.accept(message);
			const aborted = handlers.aborted?.() ?? false;
			switch (accepted.type) {
				case "call": {
					let value: unknown;
					try {
						value = dispatch(accepted);
					} catch (error) {
						answerDynamicCallSync(channel, {
							type: "reply",
							id: accepted.id,
							ok: false,
							error: toDynamicVmError(error),
							aborted,
						});
						guard.answered(accepted.id);
						return;
					}
					answerDynamicCallSync(channel, {
						type: "reply",
						id: accepted.id,
						ok: true,
						value,
						aborted,
					});
					guard.answered(accepted.id);
					return;
				}
				case "await":
					onAwait(accepted).then(
						(value) =>
							session?.deliver({
								type: "reply",
								id: accepted.id,
								ok: true,
								value,
								aborted: handlers.aborted?.() ?? false,
							}),
						(error: unknown) =>
							session?.deliver({
								type: "reply",
								id: accepted.id,
								ok: false,
								error: toDynamicVmError(error),
								aborted: handlers.aborted?.() ?? false,
							}),
					);
					return;
				case "done":
				case "failed":
					settle?.(accepted);
					return;
				case "ready":
					return;
			}
		},
	};
	return {
		channel,
		stream,
		guard,
		transport,
		finished,
		open(message: DynamicStartMessage = start): DynamicVmSession {
			session = createVmWorkflowContext(message, transport);
			return session;
		},
		close() {
			channel.hostPort.close();
			channel.workerPort.close();
		},
	};
}

const hosts = new Set<ReturnType<typeof fakeHost>>();
function host(
	handlers: Parameters<typeof fakeHost>[0] = {},
): ReturnType<typeof fakeHost> {
	const created = fakeHost(handlers);
	hosts.add(created);
	return created;
}

afterEach(() => {
	for (const created of hosts) created.close();
	hosts.clear();
});

function calls(stream: readonly DynamicVmMessage[]) {
	return stream.flatMap((message) =>
		message.type === "call"
			? [{ id: message.id, method: message.method, args: message.args }]
			: [],
	);
}

describe("dynamic shim modules", () => {
	it("exposes exactly the shim exports from the real definition module", async () => {
		const modules = createDynamicModules([]);
		expect(Object.keys(modules).sort()).toEqual([
			"@vegardx/pi-workflow",
			"typebox",
		]);
		const workflow = modules["@vegardx/pi-workflow"];
		if (!workflow) throw new Error("missing workflow module");
		expect(Object.keys(workflow).sort()).toEqual([...DYNAMIC_SHIM_EXPORTS]);
		expect(Object.isFrozen(modules)).toBe(true);
		expect(Object.isFrozen(workflow)).toBe(true);
		expect(workflow.defineWorkflow).toBe(defineWorkflow);
		expect(workflow.isTaskHandle).toBe(isTaskHandle);
		expect(workflow.defineSupportTask).toBe(dynamicDefineSupportTask);
		const typebox = modules.typebox;
		if (!typebox) throw new Error("missing typebox module");
		expect(Object.isFrozen(typebox)).toBe(true);
		expect(typebox.Type).toBe((await import("typebox")).Type);
	});

	it("wraps defineSupportTask so registration is refused but everything else is real", () => {
		const helper = dynamicDefineSupportTask({
			name: "@vegardx/tools/summarize",
			moduleSpecifier: "@vegardx/tools",
			revision: 2,
			implementationSha256: "f".repeat(64),
			parametersSchema: Type.Object({ strict: Type.Boolean() }),
			outputSchema: Type.Object({ value: Type.String() }),
		});
		expect(Object.isFrozen(helper)).toBe(true);
		expect(helper.implementation).toBe("@vegardx/tools/summarize");
		expect(helper.moduleSpecifier).toBe("@vegardx/tools");
		expect(helper.revision).toBe(2);
		expect(helper.implementationSha256).toBe("f".repeat(64));
		expect(helper.parametersSchema).toEqual({
			type: "object",
			required: ["strict"],
			properties: { strict: { type: "boolean" } },
		});
		const descriptor = helper({ parameters: { strict: true } });
		expect(descriptor.schema).toBe("pi-workflow-support-task-descriptor");
		expect(descriptor.implementation).toBe("@vegardx/tools/summarize");
		expect(() => helper({ parameters: { strict: "no" } as never })).toThrow(
			"support task parameters do not match their schema",
		);
		expect(() => helper.registration(async () => ({ value: "x" }))).toThrow(
			MSG_SOURCE_MAY_NOT_REGISTER,
		);
		expect(MSG_SOURCE_MAY_NOT_REGISTER).toBe(
			"Dynamic workflow source may not register support implementations.",
		);
		expect(() =>
			dynamicDefineSupportTask({
				name: "bad name",
				moduleSpecifier: "@vegardx/tools",
				revision: 1,
				implementationSha256: "f".repeat(64),
				parametersSchema: Type.Object({}),
				outputSchema: Type.Object({}),
			}),
		).toThrow("invalid support task implementation identity");
	});

	it("publishes support helpers under their module specifier and export name", () => {
		const spec = {
			name: "@vegardx/tools/summarize",
			moduleSpecifier: "@vegardx/tools",
			revision: 1,
			implementationSha256: "f".repeat(64),
			parametersSchema: { type: "object", additionalProperties: false },
			outputSchema: { type: "object", additionalProperties: false },
		};
		const modules = createDynamicModules([
			{ ...spec, exportName: "summarize" },
			{ ...spec, name: "@vegardx/tools/lint", exportName: "lint" },
			{
				...spec,
				moduleSpecifier: "@vegardx/other",
				name: "@vegardx/other/x",
				exportName: "x",
			},
		]);
		expect(Object.keys(modules).sort()).toEqual([
			"@vegardx/other",
			"@vegardx/pi-workflow",
			"@vegardx/tools",
			"typebox",
		]);
		const tools = modules["@vegardx/tools"];
		if (!tools) throw new Error("missing tools module");
		expect(Object.keys(tools).sort()).toEqual(["lint", "summarize"]);
		expect(Object.isFrozen(tools)).toBe(true);
		const summarize = tools.summarize as ReturnType<
			typeof dynamicDefineSupportTask
		>;
		expect(summarize({ parameters: {} }).implementation).toBe(
			"@vegardx/tools/summarize",
		);
		expect(() => summarize.registration(async () => ({}))).toThrow(
			MSG_SOURCE_MAY_NOT_REGISTER,
		);
	});
});

describe("dynamic shim context", () => {
	it("is a frozen WorkflowContext with exactly the declared members", () => {
		const { context } = host().open();
		expect(Object.isFrozen(context)).toBe(true);
		expect(Object.keys(context).sort()).toEqual(
			[...DYNAMIC_CONTEXT_PROPERTIES, ...DYNAMIC_CONTEXT_METHODS].sort(),
		);
		for (const method of DYNAMIC_CONTEXT_METHODS) {
			expect(typeof context[method]).toBe("function");
		}
		expect(context.runId).toBe(runId);
		expect(context.cwd).toBe("/repo");
		expect(context.signal.aborted).toBe(false);
		expect(context.input).toEqual(start.input);
		expect(context.input).not.toBe(start.input);
		expect(Object.isFrozen(context.input)).toBe(true);
		expect(
			Object.isFrozen(
				(context.input as { nested: { deep: number[] } }).nested.deep,
			),
		).toBe(true);
	});

	it("lowers every declaration to a synchronous call with serialized handles", () => {
		const fake = host();
		const { context: ctx } = fake.open();
		const support = dynamicDefineSupportTask({
			name: "@vegardx/tools/summarize",
			moduleSpecifier: "@vegardx/tools",
			revision: 1,
			implementationSha256: "f".repeat(64),
			parametersSchema: Type.Object({ strict: Type.Boolean() }),
			outputSchema: Type.Object({ value: Type.String() }),
		});
		ctx.phase("plan");
		ctx.log("hello");
		const first = ctx.agent("first", request("First"));
		expect(isTaskHandle(first)).toBe(true);
		expect(Object.isFrozen(first)).toBe(true);
		expect(first.ref).toEqual({ runId, taskId: "task_1" });
		expect(first.output.ref).toEqual({
			runId,
			producerTaskId: "task_1",
			output: "result",
		});
		const second = ctx.agent("second", {
			...request("Second"),
			after: [first.ref],
			inputs: { first: first.output },
		});
		const summary = ctx.support(
			"summary",
			support({
				parameters: { strict: true },
				inputs: { second: second.output },
			}),
		);
		const child = ctx.workflow("child", {
			workflow: "child",
			input: { value: "x" },
			// An explicit undefined must survive lowering (static-runtime finalize rule).
			disposition: undefined,
			inputs: { summary: summary.output },
		} as unknown as NestedWorkflowRequest);
		const gate = ctx.checkpoint("gate", {
			schema: Type.Object({ go: Type.Boolean() }),
			prompt: "Continue?",
			headless: "block",
			after: [child.ref],
		});
		const wrap = ctx.finalize("wrap", {
			kind: "required",
			agent: { ...request("Wrap"), inputs: { gate: gate.output } },
		});
		const fanned = ctx.fanOut("topics", ["alpha", "beta"], {
			key: (item) => item,
			task: (item, index) => ({
				...request(`Cover ${item}`),
				inputs: index === 0 ? { first: first.output } : {},
			}),
		});
		expect(Object.isFrozen(fanned)).toBe(true);
		expect(fanned.map((handle) => handle.ref.taskId)).toEqual([
			"task_7",
			"task_8",
		]);
		const merged = ctx.fanIn("merge", fanned, {
			inputKey: (_source, index) => `topic-${index}`,
			task: request("Merge"),
		});
		const reviewed = ctx.pipeline("chain", (stage) => {
			const draft = stage.agent("draft", request("Draft"));
			return stage.agent("review", {
				...request("Review"),
				inputs: { draft: draft.output, wrap: wrap.output },
			});
		});
		expect(reviewed.ref.taskId).toBe("task_11");
		expect(merged.ref.taskId).toBe("task_9");

		const recorded = calls(fake.stream);
		expect(recorded.map((call) => call.id)).toEqual(
			recorded.map((_call, index) => index + 1),
		);
		expect(recorded.map((call) => call.method)).toEqual([
			"phase",
			"log",
			"agent",
			"agent",
			"support",
			"workflow",
			"checkpoint",
			"finalize",
			"agentInNamespace",
			"agentInNamespace",
			"agent",
			"agentInNamespace",
			"agentInNamespace",
		]);
		expect(recorded[0]?.args).toEqual(["plan"]);
		expect(recorded[1]?.args).toEqual(["hello"]);
		expect(recorded[2]?.args).toEqual(["first", request("First")]);
		expect(recorded[3]?.args).toEqual([
			"second",
			{
				...request("Second"),
				after: [{ runId, taskId: "task_1" }],
				inputs: {
					first: {
						kind: "artifact-handle",
						ref: { runId, producerTaskId: "task_1", output: "result" },
					},
				},
			},
		]);
		const supportArgs = recorded[4]?.args as [string, Record<string, unknown>];
		expect(supportArgs[0]).toBe("summary");
		expect(supportArgs[1].implementation).toBe("@vegardx/tools/summarize");
		expect(supportArgs[1].inputs).toEqual({
			second: {
				kind: "artifact-handle",
				ref: { runId, producerTaskId: "task_2", output: "result" },
			},
		});
		const workflowArgs = recorded[5]?.args as [string, Record<string, unknown>];
		expect(Object.hasOwn(workflowArgs[1], "disposition")).toBe(true);
		expect(workflowArgs[1].disposition).toBeUndefined();
		expect(recorded[6]?.args).toEqual([
			"gate",
			{
				schema: Type.Object({ go: Type.Boolean() }),
				prompt: "Continue?",
				headless: "block",
				after: [{ runId, taskId: "task_4" }],
			},
		]);
		expect(recorded[8]?.args).toEqual([
			["topics"],
			"alpha",
			{
				...request("Cover alpha"),
				inputs: {
					first: {
						kind: "artifact-handle",
						ref: { runId, producerTaskId: "task_1", output: "result" },
					},
				},
			},
		]);
		expect(recorded[9]?.args).toEqual([
			["topics"],
			"beta",
			{ ...request("Cover beta"), inputs: {} },
		]);
		expect(recorded[10]?.args).toEqual([
			"merge",
			{
				...request("Merge"),
				inputs: {
					"topic-0": {
						kind: "artifact-handle",
						ref: { runId, producerTaskId: "task_7", output: "result" },
					},
					"topic-1": {
						kind: "artifact-handle",
						ref: { runId, producerTaskId: "task_8", output: "result" },
					},
				},
			},
		]);
		expect(recorded[11]?.args).toEqual([["chain"], "draft", request("Draft")]);
		expect(recorded[12]?.args?.[0]).toEqual(["chain"]);
		expect(fake.guard.pendingCallId).toBeUndefined();
	});

	it("rebuilds worktree handles with their handoff and refuses invalid host handles", () => {
		const fake = host({
			dispatch: (message) =>
				message.method === "agent"
					? fakeHandleRef(1, { handoff: true })
					: { kind: "task-handle", ref: { runId } },
		});
		const { context: ctx } = fake.open();
		const worktree = ctx.agent("writer", {
			...request("Write"),
			workspace: { mode: "worktree", cwd: "/repo" },
		});
		expect(isTaskHandle(worktree)).toBe(true);
		expect(worktree.handoff.ref).toEqual({
			runId,
			producerTaskId: "task_1",
			output: "handoff",
		});
		expect(
			serializeDynamicRequest({ inputs: { h: worktree.handoff } }),
		).toEqual({
			inputs: {
				h: {
					kind: "artifact-handle",
					ref: { runId, producerTaskId: "task_1", output: "handoff" },
				},
			},
		});
		expect(() => ctx.support("bad", request() as never)).toThrow(
			"Dynamic workflow host returned an invalid task handle.",
		);
	});

	it("refuses functions in requests before calling the host", () => {
		const fake = host();
		const { context: ctx } = fake.open();
		expect(() =>
			ctx.agent("first", { ...request(), task: { goal: () => "x" } } as never),
		).toThrow(MSG_REQUEST_CONTAINS_FUNCTION);
		expect(MSG_REQUEST_CONTAINS_FUNCTION).toBe(
			"Workflow request contains a function.",
		);
		expect(fake.stream).toEqual([]);
	});

	it("rethrows host reply errors with their name and message", () => {
		const fake = host({
			dispatch: () => {
				const error = new Error(
					"Workflow phase must contain 1 to 128 characters.",
				);
				error.name = "StaticWorkflowRuntimeError";
				throw error;
			},
		});
		const { context: ctx } = fake.open();
		let caught: unknown;
		try {
			ctx.phase("");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).name).toBe("StaticWorkflowRuntimeError");
		expect((caught as Error).message).toBe(
			"Workflow phase must contain 1 to 128 characters.",
		);
	});

	it("applies the static runtime's lowering validations verbatim", () => {
		const fake = host();
		const { context: ctx } = fake.open();
		const cases: [() => unknown, string][] = [
			[
				() => ctx.fanOut("Bad", [], { key: () => "a", task: () => request() }),
				"Workflow fan-out namespace is invalid.",
			],
			[
				() =>
					ctx.fanOut("ok", new Array(65).fill("x"), {
						key: () => "a",
						task: () => request(),
					}),
				"Workflow fan-out exceeds 64 items.",
			],
			[
				() => ctx.fanOut("ok", [], { key: "a" } as never),
				"Workflow fan-out options are invalid.",
			],
			[
				() => ctx.fanIn("merge", [], { inputKey: () => "a", task: request() }),
				"Workflow fan-in requires 1 to 64 sources.",
			],
			[
				() =>
					ctx.fanIn(
						"merge",
						[
							createTaskHandle(
								{ runId, taskId: "task_x" },
								{ runId, producerTaskId: "task_x", output: "result" },
							),
						],
						{
							inputKey: () => "a",
							task: { ...request(), inputs: {} } as never,
						},
					),
				"Workflow fan-in options are invalid.",
			],
			[
				() =>
					ctx.fanIn(
						"merge",
						[
							createTaskHandle(
								{ runId, taskId: "task_x" },
								{ runId, producerTaskId: "task_x", output: "result" },
							),
							createTaskHandle(
								{ runId, taskId: "task_y" },
								{ runId, producerTaskId: "task_y", output: "result" },
							),
						],
						{ inputKey: () => "same", task: request() },
					),
				"Workflow fan-in input keys must be unique.",
			],
			[
				() => ctx.pipeline("Bad", () => undefined as never),
				"Workflow pipeline definition is invalid.",
			],
			[
				() => ctx.pipeline("chain", "nope" as never),
				"Workflow pipeline definition is invalid.",
			],
			[
				() =>
					ctx.pipeline("chain", (stage) => {
						let last: TaskHandle<unknown> | undefined;
						for (let index = 0; index < 65; index += 1) {
							last = stage.agent(`s${index}`, request());
						}
						return last as TaskHandle<unknown>;
					}),
				"Workflow pipeline exceeds 64 stages.",
			],
			[
				() =>
					ctx.pipeline("chain", () =>
						createTaskHandle(
							{ runId, taskId: "task_z" },
							{ runId, producerTaskId: "task_z", output: "result" },
						),
					),
				"Workflow pipeline must return one of its stage handles.",
			],
			[
				() => ctx.handoff(ctx.agent("plain", request()) as never),
				"Workflow handoff barrier requires a worktree task handle.",
			],
		];
		for (const [action, message] of cases) {
			let caught: unknown;
			try {
				action();
			} catch (error) {
				caught = error;
			}
			expect(caught, message).toBeInstanceOf(Error);
			expect((caught as Error).name).toBe("StaticWorkflowRuntimeError");
			expect((caught as Error).message).toBe(message);
		}
		expect(() => ctx.result({} as never)).toThrow(
			MSG_BARRIER_TARGET_NOT_HANDLE,
		);
		expect(() =>
			ctx.results([ctx.agent("real", request()), 1 as never]),
		).toThrow(MSG_BARRIER_TARGET_NOT_HANDLE);
		expect(MSG_BARRIER_TARGET_NOT_HANDLE).toBe(
			"Workflow barrier target is not a task handle.",
		);
	});
});

describe("dynamic shim barriers and abort", () => {
	it("answers barriers asynchronously with frozen values", async () => {
		const awaited: DynamicAwaitMessage[] = [];
		const fake = host({
			onAwait: async (message) => {
				awaited.push(message);
				await new Promise((resolve) => setTimeout(resolve, 5));
				switch (message.method) {
					case "result":
						return { answer: message.handles[0]?.ref.taskId, list: [1] };
					case "results":
						return message.handles.map((handle) => ({
							answer: handle.ref.taskId,
						}));
					case "settled":
						return message.handles.map((handle) => ({
							status: "rejected",
							taskId: handle.ref.taskId,
							outcome: "failed",
						}));
					case "handoff":
						return undefined;
				}
			},
		});
		const { context: ctx } = fake.open();
		const first = ctx.agent("first", request());
		const second = ctx.agent("second", request());
		const [single, both, settled] = await Promise.all([
			ctx.result(first),
			ctx.results([first, second]),
			ctx.settled([second]),
		]);
		expect(single).toEqual({ answer: "task_1", list: [1] });
		expect(Object.isFrozen(single)).toBe(true);
		expect(
			Object.isFrozen((single as unknown as { list: number[] }).list),
		).toBe(true);
		expect(both).toEqual([{ answer: "task_1" }, { answer: "task_2" }]);
		expect(Object.isFrozen(both)).toBe(true);
		expect(settled).toEqual([
			{ status: "rejected", taskId: "task_2", outcome: "failed" },
		]);
		expect(awaited.map((message) => [message.id, message.method])).toEqual([
			[3, "result"],
			[4, "results"],
			[5, "settled"],
		]);
		expect(awaited[1]?.handles).toEqual([fakeHandleRef(1), fakeHandleRef(2)]);
		expect(
			fake.stream.filter((message) => message.type === "await"),
		).toHaveLength(3);
	});

	it("awaits a handoff barrier for worktree handles", async () => {
		const fake = host({
			dispatch: () => fakeHandleRef(1, { handoff: true }),
			onAwait: async () => ({ commit: "abc" }),
		});
		const { context: ctx } = fake.open();
		const writer = ctx.agent("writer", {
			...request(),
			workspace: { mode: "worktree", cwd: "/repo" },
		});
		await expect(ctx.handoff(writer)).resolves.toEqual({ commit: "abc" });
		const awaited = fake.stream.find((message) => message.type === "await");
		expect(awaited).toEqual({
			type: "await",
			id: 2,
			method: "handoff",
			handles: [fakeHandleRef(1, { handoff: true })],
		});
	});

	it("rejects barriers with the host's error and fails on unknown replies", async () => {
		const fake = host({
			onAwait: async () => {
				const error = new Error(
					"Workflow task did not complete successfully: failed.",
				);
				error.name = "StaticWorkflowRuntimeError";
				throw error;
			},
		});
		const session = fake.open();
		const handle = session.context.agent("first", request());
		await expect(session.context.result(handle)).rejects.toMatchObject({
			name: "StaticWorkflowRuntimeError",
			message: "Workflow task did not complete successfully: failed.",
		});
		session.deliver({
			type: "reply",
			id: 42,
			ok: true,
			value: 1,
			aborted: false,
		});
		expect(fake.stream.at(-1)).toEqual({
			type: "failed",
			error: {
				name: "DynamicWorkflowHostError",
				message: MSG_HOST_UNKNOWN_REQUEST,
			},
		});
		expect(MSG_HOST_UNKNOWN_REQUEST).toBe(
			"Dynamic workflow host answered an unknown request.",
		);
		const other = host();
		const otherSession = other.open();
		otherSession.deliver({ type: "reply" });
		expect(other.stream).toEqual([
			{
				type: "failed",
				error: {
					name: "DynamicWorkflowHostError",
					message: MSG_HOST_INVALID_MESSAGE,
				},
			},
		]);
		otherSession.deliver({ type: "abort", reason: "later" });
		expect(other.stream).toHaveLength(1);
	});

	it("mirrors abort from the abort message and from aborted replies", async () => {
		const fake = host();
		const session = fake.open();
		const reasons: string[] = [];
		session.context.signal.addEventListener("abort", () => {
			reasons.push(String((session.context.signal.reason as Error).message));
		});
		session.deliver({
			type: "abort",
			reason: "Workflow stop requested by operator.",
		});
		expect(session.context.signal.aborted).toBe(true);
		expect(session.context.signal.reason).toBeInstanceOf(Error);
		session.deliver({ type: "abort", reason: "again" });
		expect(reasons).toEqual(["Workflow stop requested by operator."]);

		let aborted = false;
		const viaReply = host({ aborted: () => aborted });
		const replySession = viaReply.open();
		replySession.context.phase("plan");
		expect(replySession.context.signal.aborted).toBe(false);
		aborted = true;
		replySession.context.log("still running");
		expect(replySession.context.signal.aborted).toBe(true);
		expect((replySession.context.signal.reason as Error).message).toBe(
			MSG_STOP_REQUESTED,
		);
		const viaAwait = host({ aborted: () => true });
		const awaitSession = viaAwait.open();
		const handle = awaitSession.context.agent("first", request());
		await awaitSession.context.result(handle);
		expect(awaitSession.context.signal.aborted).toBe(true);
	});
});

describe("dynamic shim return handling", () => {
	function definitionReturning(
		run: (ctx: WorkflowContext<unknown>) => unknown,
	): WorkflowDefinition {
		return defineWorkflow({
			meta: {
				name: "returning",
				description: "Return handling",
				version: 1,
				budget: { cost: 1, childRuntimeMs: 60_000 },
				timeoutMs: 60_000,
			},
			inputSchema: Type.Object({}),
			outputSchema: Type.Unknown(),
			run: run as never,
		});
	}

	it("posts done for JSON values, task handles, and artifact handles", async () => {
		const fake = host();
		const session = fake.open();
		await session.run(
			definitionReturning(() => ({ a: 1, b: undefined, c: [1, "x"] })),
		);
		expect(await fake.finished).toEqual({
			type: "done",
			result: { kind: "value", value: { a: 1, c: [1, "x"] } },
		});

		const task = host();
		const taskSession = task.open();
		await taskSession.run(
			definitionReturning((ctx) =>
				Promise.resolve(ctx.agent("first", request())),
			),
		);
		expect(await task.finished).toEqual({
			type: "done",
			result: { kind: "task", ref: { runId, taskId: "task_1" } },
		});

		const artifact = host();
		const artifactSession = artifact.open();
		await artifactSession.run(
			definitionReturning((ctx) => ctx.agent("first", request()).output),
		);
		expect(await artifact.finished).toEqual({
			type: "done",
			result: {
				kind: "artifact",
				ref: { runId, producerTaskId: "task_1", output: "result" },
			},
		});
		expect(serializeDynamicReturn("plain")).toEqual({
			kind: "value",
			value: "plain",
		});
	});

	it("posts failed for non-JSON returns and thrown errors, once", async () => {
		const fake = host();
		const session = fake.open();
		await session.run(definitionReturning(() => () => 1));
		const notJson = await fake.finished;
		expect(notJson).toMatchObject({
			type: "failed",
			error: { name: "Error", message: MSG_RETURN_NOT_JSON },
		});
		expect(MSG_RETURN_NOT_JSON).toBe(
			"Dynamic workflow return value is not JSON.",
		);
		expect(() => serializeDynamicReturn(undefined)).toThrow(
			MSG_RETURN_NOT_JSON,
		);
		expect(() => serializeDynamicReturn({ n: 1n })).toThrow(
			MSG_RETURN_NOT_JSON,
		);

		const thrown = host();
		const thrownSession = thrown.open();
		await thrownSession.run(
			definitionReturning(() => {
				throw new TypeError("boom");
			}),
		);
		const failed = await thrown.finished;
		expect(failed.type).toBe("failed");
		if (failed.type !== "failed") throw new Error("expected failed");
		expect(failed.error.name).toBe("TypeError");
		expect(failed.error.message).toBe("boom");
		expect(failed.error.stack?.startsWith("TypeError: boom")).toBe(true);
		thrownSession.deliver({
			type: "reply",
			id: 9,
			ok: true,
			value: 1,
			aborted: false,
		});
		expect(
			thrown.stream.filter((message) => message.type === "failed"),
		).toHaveLength(1);
	});
});

describe("dynamic VM context determinism aids", () => {
	const filename = `dynamic:${sha}.workflow.ts`;
	function evaluate(context: vm.Context, code: string): unknown {
		return new vm.Script(`(function () { "use strict"; ${code} })()`, {
			filename,
		}).runInContext(context);
	}

	it("fixes Date to the run's epoch while delegating everything else", () => {
		const context = createDynamicVmContext({
			filename,
			epochMs: start.epochMs,
			seed: sha,
		});
		expect(evaluate(context, "return Date.now();")).toBe(start.epochMs);
		expect(evaluate(context, "return new Date().getTime();")).toBe(
			start.epochMs,
		);
		expect(evaluate(context, "return new Date(0).getTime();")).toBe(0);
		expect(
			evaluate(
				context,
				"return new Date('2020-01-02T00:00:00.000Z').toISOString();",
			),
		).toBe("2020-01-02T00:00:00.000Z");
		expect(evaluate(context, "return Date();")).toBe(
			evaluate(context, "return String(new Date(Date.now()));"),
		);
		expect(evaluate(context, "return new Date() instanceof Date;")).toBe(true);
		expect(evaluate(context, "return new Date().constructor === Date;")).toBe(
			true,
		);
		expect(
			evaluate(context, "return Date.parse('1970-01-01T00:00:01.000Z');"),
		).toBe(1000);
		expect(evaluate(context, "return Date.UTC(1970, 0, 1);")).toBe(0);
		expect(evaluate(context, "return Date.name + ':' + Date.length;")).toBe(
			"Date:7",
		);
		expect(
			evaluate(
				context,
				"class Later extends Date {} return new Later().getTime();",
			),
		).toBe(start.epochMs);
	});

	it("seeds Math.random from the run seed", () => {
		const draw = (seed: string) => {
			const context = createDynamicVmContext({ filename, epochMs: 0, seed });
			return evaluate(
				context,
				"return [Math.random(), Math.random(), Math.random()];",
			) as number[];
		};
		const first = draw(sha);
		expect(first).toEqual(draw(sha));
		expect(first).not.toEqual(draw("2".repeat(64)));
		expect(draw("0".repeat(64))).toEqual(draw("0".repeat(64)));
		for (const value of [...first, ...draw("0".repeat(64))]) {
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
		expect(new Set(first).size).toBe(3);
	});

	it("exposes no host globals and refuses code generation, imports, and global writes", async () => {
		const context = createDynamicVmContext({ filename, epochMs: 0, seed: sha });
		expect(
			evaluate(
				context,
				"return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof structuredClone, typeof TextEncoder, typeof queueMicrotask];",
			),
		).toEqual([
			"undefined",
			"undefined",
			"undefined",
			"undefined",
			"undefined",
			"undefined",
			"undefined",
		]);
		expect(
			evaluate(
				context,
				"return Object.isFrozen(console) && Object.keys(console).sort().join(',');",
			),
		).toBe("debug,error,info,log,warn");
		expect(evaluate(context, "return console.log('quiet');")).toBeUndefined();
		expect(
			evaluate(
				context,
				"try { eval('1'); return 'no'; } catch (e) { return e.constructor.name; }",
			),
		).toBe("EvalError");
		expect(
			evaluate(
				context,
				"try { new Function('return 1'); return 'no'; } catch (e) { return e.constructor.name; }",
			),
		).toBe("EvalError");
		expect(
			evaluate(
				context,
				"try { globalThis.x = 1; return 'no'; } catch (e) { return e.message; }",
			),
		).toBe("Cannot add property x, object is not extensible");
		expect(
			evaluate(
				context,
				"try { Date = 1; return 'no'; } catch (e) { return e.message; }",
			),
		).toBe(
			"Cannot assign to read only property 'Date' of object '[object Object]'",
		);
		expect(
			evaluate(
				context,
				"try { delete globalThis.console; return 'no'; } catch (e) { return e.message; }",
			),
		).toBe("Cannot add property console, object is not extensible");
		expect(() =>
			new vm.Script("var leaked = 1;", { filename }).runInContext(context),
		).toThrow("Cannot add property leaked, object is not extensible");
		const imported = new vm.Script(
			"(async () => { try { await import('node:fs'); return 'no'; } catch (e) { return e.code; } })()",
			{ filename },
		).runInContext(context) as Promise<string>;
		expect(await imported).toBe("ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING");
		expect(
			evaluate(
				context,
				"try { new WebAssembly.Module(new Uint8Array(8)); return 'no'; } catch (e) { return e.constructor.name; }",
			),
		).toBe("CompileError");
	});
});

const paritySource = `import { defineWorkflow, type WorkflowContext } from "@vegardx/pi-workflow";
import { Type } from "typebox";

const Answer = Type.Object({ answer: Type.String() });
type Goal = string;
enum Mode { Research = "research" }

function request(goal: Goal) {
	return {
		agent: "researcher",
		task: { goal, context: [], instructions: ["Return structured output."] },
		contextMode: "fresh" as const,
		tools: ["read"],
		preloadSkills: [],
		contextScopes: ["project" as const],
		workspace: { mode: "read-only" as const, cwd: "/repo" },
		outputSchema: Answer,
		limits: {
			cumulativeRuntimeMs: 300_000,
			attemptTimeoutMs: 300_000,
			totalTokens: 1_000_000,
			cost: 10,
			outputBytes: 1024,
			workspaceWriteBytes: 0,
			retries: 0,
			resumes: 0,
		},
	};
}

export default defineWorkflow({
	meta: {
		name: "parity",
		description: "Shim parity fixture",
		version: 3,
		budget: { cost: 100, childRuntimeMs: 3_600_000 },
		timeoutMs: 3_600_000,
	},
	inputSchema: Type.Object({ topics: Type.Array(Type.String()) }),
	outputSchema: Type.Object({ answers: Type.Array(Type.String()) }),
	async run(ctx) {
		ctx.phase(Mode.Research);
		const first = ctx.agent("first", request("Answer " + ctx.input.topics[0]));
		const fanned = ctx.fanOut("topics", ctx.input.topics, {
			key: (topic: string) => topic,
			task: (topic: string) => ({ ...request("Cover " + topic), inputs: { first: first.output } }),
		});
		const merged = ctx.fanIn("merge", fanned, {
			inputKey: (_source, index) => "topic-" + index,
			task: request("Merge"),
		});
		const reviewed = ctx.pipeline("chain", (stage) => {
			const draft = stage.agent("draft", request("Draft"));
			return stage.agent("review", { ...request("Review"), inputs: { draft: draft.output } });
		});
		ctx.log("declared " + fanned.length + " topics");
		const [one, two] = await ctx.results([first, merged]);
		const settled = await ctx.settled([reviewed]);
		const last = await ctx.result(reviewed);
		return {
			answers: [one.answer, two.answer, last.answer, settled[0].status] satisfies string[],
		};
	},
});
`;

const definitionIdentitySha256 = "c".repeat(64);
const planIdentitySha256 = "b".repeat(64);
const parityRoot = path.resolve(".pi", "test-dynamic-shim", randomUUID());
const leases = new Set<WorkflowRunLease>();

function completedResult(childRunId: string, value: unknown): RunResult {
	return {
		runId: childRunId,
		status: "completed",
		structuredOutput: value,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: 0,
		},
		usageComplete: true,
		runtimeMs: 10,
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
	};
}

/** The static-runtime tests' fake agent scheduler: every agent task completes with `{ answer: key }`. */
function schedulerFor(
	journal: WorkflowRunJournal,
	artifacts: WorkflowArtifactStore,
): WorkflowSequentialScheduler {
	return {
		concurrency: 1,
		stopSignal: new AbortController().signal,
		async drive(): Promise<WorkflowSchedulerOutcome> {
			let current = await journal.readState();
			if (current.status === "created" || current.status === "waiting") {
				await journal.append("run-status-changed", {
					from: current.status,
					to: "running",
				});
				current = await journal.readState();
			}
			const task = Object.values(current.tasks)
				.sort(
					(left, right) =>
						left.task.materializationSequence -
						right.task.materializationSequence,
				)
				.find((candidate) => candidate.status !== "completed");
			if (!task) return { state: "idle", runStatus: current.status };
			if (task.task.spec.kind !== "agent")
				throw new Error("fake scheduler only supports agent tasks");
			const output = { answer: task.task.spec.key };
			if (task.status === "pending") {
				await journal.append("task-status-changed", {
					taskId: task.task.id,
					from: "pending",
					to: "ready",
				});
			}
			const executionId = deriveTaskExecutionId(current.runId, task.task.id, 1);
			const operationId = deriveSubagentOperationId(
				current.runId,
				task.task.id,
				1,
			);
			const childKey = task.task.spec.key.replaceAll("-", "");
			const childRunId = `run_${childKey}`;
			const childAttemptId = `attempt_${childKey}`;
			await journal.append("task-execution-created", {
				execution: {
					kind: "agent",
					id: executionId,
					runId: current.runId,
					taskId: task.task.id,
					generation: 1,
					taskIdentitySha256: task.task.spec.identitySha256,
					operationId,
				},
			});
			await journal.append("task-execution-preflighted", {
				executionId,
				operationId,
				preflightId: `preflight-${task.task.spec.key}`,
				workspaceMode: "read-only",
				workspaceBaselineSha256: "c".repeat(64),
				planIdentitySha256,
				plannedSubagentRunId: childRunId,
				plannedSubagentAttemptId: childAttemptId,
				expiresAt: "2099-01-01T00:00:00.000Z",
			});
			await journal.append("task-execution-launch-intended", {
				executionId,
				operationId,
				preflightId: `preflight-${task.task.spec.key}`,
				planIdentitySha256,
			});
			await journal.append("task-execution-launch-receipted", {
				executionId,
				operationId,
				subagentRunId: childRunId,
				subagentAttemptId: childAttemptId,
				status: "completed",
			});
			await journal.append("task-status-changed", {
				taskId: task.task.id,
				from: "ready",
				to: "waiting",
			});
			await journal.append("task-execution-child-observed", {
				executionId,
				subagentRunId: childRunId,
				subagentAttemptId: childAttemptId,
				status: "completed",
			});
			const result = completedResult(childRunId, output);
			const evidence = {
				kind: "subagent" as const,
				attemptOrdinal: 1,
				resultSha256: deriveSubagentResultSha256(result),
				status: "completed" as const,
				usage: result.usage,
				usageComplete: true,
				runtimeMs: 10,
				sandboxCleanup: "proved" as const,
				workspaceCleanup: "not-needed" as const,
				truncated: false,
				structuredOutputSha256: deriveJsonValueSha256(output),
			};
			await journal.append("task-execution-child-settled", {
				executionId,
				evidence,
			});
			const artifact = await artifacts.putJson(output, {
				runId: current.runId,
				producerTaskId: task.task.id,
				producerExecutionId: executionId,
				output: "result",
				schemaSha256: deriveJsonValueSha256(
					task.task.spec.request.outputSchema,
				),
			});
			await journal.append("artifact-declared", { artifact });
			await journal.append("task-execution-artifact-imported", {
				executionId,
				subagentRunId: childRunId,
				artifactId: artifact.id,
				sourceResultSha256: evidence.resultSha256,
			});
			await journal.append("task-execution-release-intended", {
				executionId,
				subagentRunId: childRunId,
			});
			await journal.append("task-execution-released", {
				executionId,
				subagentRunId: childRunId,
				status: "completed",
			});
			await journal.append("task-execution-terminal", {
				executionId,
				outcome: "completed",
				evidence,
			});
			await journal.append("task-status-changed", {
				taskId: task.task.id,
				from: "waiting",
				to: "completed",
			});
			return {
				state: "awaiting-finalization",
				runStatus: "running",
				taskId: task.task.id,
				executionId,
				child: {
					runId: childRunId,
					attemptId: childAttemptId,
					status: "completed",
				},
				outcome: "completed",
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

async function drive(definition: WorkflowDefinition, label: string) {
	const storeRoot = path.join(parityRoot, label);
	const lease = await acquireWorkflowRunLease({
		storeRoot,
		runId,
		ownerId: `shim-${label}`,
	});
	leases.add(lease);
	const journal = await WorkflowRunJournal.open(storeRoot, runId, lease);
	const artifacts = await WorkflowArtifactStore.open({ journal });
	const runtime = createStaticWorkflowRuntime({
		definition,
		definitionIdentitySha256,
		input: { topics: ["alpha", "beta"] },
		cwd: "/repo",
		journal,
		artifacts,
		scheduler: schedulerFor(journal, artifacts),
	});
	const result = await runtime.drive();
	if (isStaticWorkflowParked(result)) throw new Error("unexpected park");
	const events = (await journal.readEvents()).map(({ type, data }) => ({
		type,
		data,
	}));
	return { result, events };
}

/**
 * The in-thread equivalent of the host bridge: the dynamic definition's
 * `run(ctx)` receives the real static-runtime context and serves the shim's
 * RPC from it. `agentInNamespace` is lowered through a one-stage `pipeline`
 * until the static runtime exposes the host bridge.
 */
function bridgedDefinition(dynamic: WorkflowDefinition): WorkflowDefinition {
	return defineWorkflow({
		meta: dynamic.meta,
		inputSchema: dynamic.inputSchema,
		outputSchema: dynamic.outputSchema,
		run(ctx) {
			const handles = new Map<string, TaskHandle<unknown>>();
			const remember = (handle: TaskHandle<unknown>) => {
				handles.set(handle.ref.taskId, handle);
				return toDynamicTaskHandleRef(handle);
			};
			const resolve = (value: unknown): unknown => {
				if (typeof value !== "object" || value === null) return value;
				if (Array.isArray(value)) return value.map(resolve);
				const record = value as Record<string, unknown>;
				if (record.kind === "task-handle") {
					const ref = record.ref as { taskId: string };
					const handle = handles.get(ref.taskId);
					if (!handle) throw new Error("unknown task handle");
					return handle;
				}
				if (record.kind === "artifact-handle") {
					const ref = record.ref as { producerTaskId: string; output: string };
					const handle = handles.get(ref.producerTaskId);
					if (!handle) throw new Error("unknown task handle");
					return ref.output === "handoff" ? handle.handoff : handle.output;
				}
				return Object.fromEntries(
					Object.keys(record).map((key) => [key, resolve(record[key])]),
				);
			};
			const bridge = fakeHost({
				dispatch(message) {
					const [a0, a1, a2] = message.args;
					switch (message.method) {
						case "phase":
							ctx.phase(a0 as string);
							return null;
						case "log":
							ctx.log(a0 as string);
							return null;
						case "agent":
							return remember(ctx.agent(a0 as string, resolve(a1) as never));
						case "agentInNamespace": {
							const namespace = a0 as string[];
							if (namespace.length !== 1 || namespace[0] === undefined) {
								throw new Error(
									"fake bridge lowers single-level namespaces only",
								);
							}
							return remember(
								ctx.pipeline(namespace[0], (stage) =>
									stage.agent(a1 as string, resolve(a2) as never),
								),
							);
						}
						case "support":
							return remember(ctx.support(a0 as string, resolve(a1) as never));
						case "workflow":
							return remember(ctx.workflow(a0 as string, resolve(a1) as never));
						case "checkpoint":
							return remember(
								ctx.checkpoint(a0 as string, resolve(a1) as never),
							);
						case "finalize":
							return remember(ctx.finalize(a0 as string, resolve(a1) as never));
					}
				},
				onAwait(message) {
					const targets = message.handles.map((handle) => {
						const real = handles.get(handle.ref.taskId);
						if (!real) throw new Error("unknown task handle");
						return real;
					});
					switch (message.method) {
						case "result":
							return ctx.result(targets[0] as TaskHandle<unknown>);
						case "results":
							return ctx.results(targets);
						case "settled":
							return ctx.settled(targets);
						case "handoff":
							return ctx.handoff(targets[0] as never);
					}
				},
				aborted: () => ctx.signal.aborted,
			});
			hosts.add(bridge);
			const session = bridge.open({
				type: "start",
				input: ctx.input,
				runId: ctx.runId,
				cwd: ctx.cwd,
				seed: sha,
				epochMs: start.epochMs,
			});
			void session.run(dynamic);
			return bridge.finished.then((terminal) => {
				if (terminal.type === "failed") {
					const error = new Error(terminal.error.message);
					error.name = terminal.error.name;
					throw error;
				}
				if (terminal.type !== "done")
					throw new Error("unexpected terminal message");
				switch (terminal.result.kind) {
					case "value":
						return terminal.result.value;
					case "task":
						return handles.get(terminal.result.ref.taskId);
					case "artifact":
						return handles.get(terminal.result.ref.producerTaskId)?.output;
				}
			});
		},
	});
}

afterEach(async () => {
	await Promise.all([...leases].map((lease) => lease.release()));
	leases.clear();
});

afterAll(async () => {
	await rm(parityRoot, { recursive: true, force: true });
});

type Driven = Awaited<ReturnType<typeof drive>>;

/** A value an earlier parity step produced; a named failure when it did not. */
function ready<T>(value: T | undefined, label: string): T {
	if (value === undefined) {
		throw new Error(`${label} is unavailable: an earlier parity step failed`);
	}
	return value;
}

describe("dynamic shim parity with the static loader", () => {
	// Measured in isolation on an otherwise loaded 18-core machine: the
	// registry load (jiti transpiling this checkout behind the package shim)
	// takes about 3 s and each drive about 2.5 s for its 102 fsynced journal
	// appends (8 s before the journal resumed its reduction from the last
	// append; the shard-1 runner then timed the static drive out at 60 s).
	// Driving both concurrently saves nothing, the fsyncs serialize, so the
	// cold start is shared here and each drive is its own test with its own
	// budget.
	let viaRegistry: WorkflowDefinition | undefined;
	let viaShim: WorkflowDefinition | undefined;
	let reference: Driven | undefined;

	beforeAll(async () => {
		// Static path: the real registry loader with the published package name
		// resolved to this checkout, exactly as the skill-example tests do.
		const cwd = path.join(parityRoot, "project");
		await mkdir(path.join(cwd, "workflows"), { recursive: true });
		const shimDirectory = path.join(
			cwd,
			"node_modules",
			"@vegardx",
			"pi-workflow",
		);
		await mkdir(shimDirectory, { recursive: true });
		await writeFile(
			path.join(shimDirectory, "package.json"),
			'{"name":"@vegardx/pi-workflow","type":"module","main":"./index.js"}\n',
		);
		await writeFile(
			path.join(shimDirectory, "index.js"),
			`export * from ${JSON.stringify(path.resolve("src/index.ts"))};\n`,
		);
		await writeFile(
			path.join(cwd, "workflows", "parity.workflow.ts"),
			paritySource,
		);
		const discovered = await discoverWorkflows({
			cwd,
			agentDir: path.join(parityRoot, "agent"),
			projectTrusted: true,
		});
		const loaded = discovered.find(
			(workflow) => workflow.definition.meta.name === "parity",
		);
		if (!loaded) throw new Error("registry did not load the parity fixture");
		viaRegistry = loaded.definition;

		// Dynamic path: transformer, sealed context, real definition module.
		const filename = `dynamic:${sha}.workflow.ts`;
		const { code } = transformDynamicSource({ source: paritySource, filename });
		const context = createDynamicVmContext({
			filename,
			epochMs: start.epochMs,
			seed: sha,
		});
		const exported = await evaluateDynamicSource({
			context,
			code,
			filename,
			modules: createDynamicModules([]),
		});
		viaShim = normalizeDynamicDefinition(exported);
	});

	it("loads the same manifest through the registry and through the shim", () => {
		const loaded = ready(viaRegistry, "registry definition");
		const dynamic = ready(viaShim, "shim definition");
		expect(dynamicManifestOf(dynamic)).toEqual({
			meta: loaded.meta,
			inputSchema: loaded.inputSchema,
			outputSchema: loaded.outputSchema,
		});
		expect(dynamic.meta.concurrency).toBe(loaded.meta.concurrency);
	});

	it("drives the registry-loaded definition to the reference outcome", async () => {
		const driven = await drive(
			ready(viaRegistry, "registry definition"),
			"static",
		);
		expect(driven.result.value).toEqual({
			answers: ["first", "merge", "review", "fulfilled"],
		});
		const declared = driven.events.filter(
			(event) => event.type === "task-declared",
		);
		expect(declared).toHaveLength(6);
		expect(driven.events.length).toBeGreaterThan(declared.length);
		reference = driven;
	});

	it("drives the shim-loaded definition identically to the registry-loaded one", async () => {
		const viaStatic = ready(reference, "reference drive");
		const driven = await drive(
			bridgedDefinition(ready(viaShim, "shim definition")),
			"dynamic",
		);
		expect(driven.result.value).toEqual({
			answers: ["first", "merge", "review", "fulfilled"],
		});
		expect(driven.result.value).toEqual(viaStatic.result.value);
		expect(driven.result.artifact.sha256).toBe(
			viaStatic.result.artifact.sha256,
		);
		expect(driven.events.map((event) => event.type)).toEqual(
			viaStatic.events.map((event) => event.type),
		);
		expect(driven.events).toEqual(viaStatic.events);
		const declared = driven.events.filter(
			(event) => event.type === "task-declared",
		);
		expect(declared).toHaveLength(6);
		expect(driven.events.length).toBeGreaterThan(declared.length);
	});

	it("refuses a module whose default export is not a definition", async () => {
		const filename = `dynamic:${sha}.workflow.ts`;
		const { code } = transformDynamicSource({
			source: 'export default { schema: "pi-workflow-definition" };',
			filename,
		});
		const context = createDynamicVmContext({ filename, epochMs: 0, seed: sha });
		const exported = await evaluateDynamicSource({
			context,
			code,
			filename,
			modules: createDynamicModules([]),
		});
		expect(() => normalizeDynamicDefinition(exported)).toThrow(
			MSG_NO_DEFAULT_DEFINITION,
		);
		expect(MSG_NO_DEFAULT_DEFINITION).toBe(
			"workflow module has no valid default definition",
		);
		let caught: unknown;
		try {
			normalizeDynamicDefinition(exported);
		} catch (error) {
			caught = error;
		}
		expect((caught as Error).name).toBe("DynamicDefinitionError");
	});

	it("evaluates source inside the sealed context with the module table", async () => {
		const filename = `dynamic:${sha}.workflow.ts`;
		const source = `import { WORKFLOW_CONTRACT_REVISION, isTaskHandle } from "@vegardx/pi-workflow";
import * as tb from "typebox";
const probe = { revision: WORKFLOW_CONTRACT_REVISION, handle: isTaskHandle({}), typed: tb.Type.String().type, now: Date.now(), leaked: typeof process };
export default probe;
`;
		const { code } = transformDynamicSource({ source, filename });
		const context = createDynamicVmContext({
			filename,
			epochMs: 42,
			seed: sha,
		});
		const exported = await evaluateDynamicSource({
			context,
			code,
			filename,
			modules: createDynamicModules([]),
		});
		expect(exported).toEqual({
			revision: 18,
			handle: false,
			typed: "string",
			now: 42,
			leaked: "undefined",
		});
		expect(
			Value.Check(Type.Object({ revision: Type.Literal(18) }), exported),
		).toBe(true);
		const missing = transformDynamicSource({
			source:
				'import { nope } from "@vegardx/pi-workflow"; export default nope;',
			filename,
		});
		await expect(
			evaluateDynamicSource({
				context,
				code: missing.code,
				filename,
				modules: createDynamicModules([]),
			}),
		).rejects.toThrow(
			'Dynamic workflow import "@vegardx/pi-workflow" has no export "nope".',
		);
	});
});
