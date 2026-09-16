import vm from "node:vm";
import { type TSchema, Type } from "typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	type WorkflowHandoffDescriptor,
	WorkflowHandoffDescriptorSchema,
} from "../src/contracts.js";
import {
	type AgentTaskAuthoringRequest,
	type CheckpointRequest,
	createTaskHandle,
	defineWorkflow,
	type FinalizeRequest,
	isArtifactHandle,
	isHandoffHandle,
	isTaskHandle,
	isWorkflowDefinition,
	type NestedWorkflowRequest,
	type TaskHandle,
	type WorktreeTaskHandle,
} from "../src/definition.js";

describe("workflow definitions", () => {
	it("exposes typed nested workflow requests on the workflow context", () => {
		const producerTaskId = `task_${"b".repeat(64)}`;
		const producer = createTaskHandle<string>(
			{ runId: "workflow_definition", taskId: producerTaskId },
			{
				runId: "workflow_definition",
				producerTaskId,
				output: "result",
			},
		);
		const request: NestedWorkflowRequest<{ value: string }> = {
			workflow: "child",
			input: { value: "yes" },
			disposition: "optional",
			after: [],
			inputs: { detail: producer.output },
			replay: "read-only",
		};
		expect(request.inputs?.detail?.ref).toEqual({
			runId: "workflow_definition",
			producerTaskId,
			output: "result",
		});
		const definition = defineWorkflow({
			meta: {
				name: "parent",
				description: "Parent",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({}),
			outputSchema: Type.Object({ answer: Type.String() }),
			run(ctx) {
				return ctx.workflow<{ answer: string }>("child", request);
			},
		});
		expect(isWorkflowDefinition(definition)).toBe(true);
		const taskId = `task_${"a".repeat(64)}`;
		const handle = createTaskHandle<{ answer: string }>(
			{ runId: "workflow_definition", taskId },
			{
				runId: "workflow_definition",
				producerTaskId: taskId,
				output: "result",
			},
		);
		const declared: Array<{ key: string; request: NestedWorkflowRequest }> = [];
		const context = {
			workflow(key: string, nested: NestedWorkflowRequest) {
				declared.push({ key, request: nested });
				return handle;
			},
		} as unknown as Parameters<typeof definition.run>[0];
		expect(definition.run(context)).toBe(handle);
		expect(declared).toEqual([{ key: "child", request }]);
	});

	it("exposes typed checkpoint requests on the workflow context", async () => {
		const runId = "workflow_definition";
		const planTaskId = `task_${"b".repeat(64)}`;
		const plan = createTaskHandle<{ answer: string }>(
			{ runId, taskId: planTaskId },
			{ runId, producerTaskId: planTaskId, output: "result" },
		);
		const schema = Type.Object({
			proceed: Type.Boolean(),
			note: Type.Optional(Type.String()),
		});
		const request: CheckpointRequest<typeof schema> = {
			schema,
			prompt: "Approve the plan?",
			headless: "use-explicit-default",
			default: { proceed: false },
			timeoutMs: 3_600_000,
			disposition: "required",
			after: [plan.ref],
			inputs: { plan: plan.output },
			replay: "read-only",
		};
		expect(request.default).toEqual({ proceed: false });
		const minimal: CheckpointRequest<typeof schema> = {
			schema,
			prompt: "Approve?",
			headless: "block",
		};
		expect(minimal.default).toBeUndefined();
		expect(minimal.timeoutMs).toBeUndefined();
		// Compile-time only: the default is typed by the decision schema, and a
		// finalizer has no checkpoint member.
		const rejectDefault = (): CheckpointRequest<typeof schema> => ({
			schema,
			prompt: "Approve?",
			headless: "block",
			// @ts-expect-error the default must satisfy the decision schema
			default: { proceed: "yes" },
		});
		expect(typeof rejectDefault).toBe("function");
		const rejectFinalizer = (): FinalizeRequest<typeof schema> => ({
			kind: "required",
			// @ts-expect-error a checkpoint cannot be a finalizer
			checkpoint: minimal,
		});
		expect(typeof rejectFinalizer).toBe("function");
		const approveTaskId = `task_${"a".repeat(64)}`;
		const approveHandle = createTaskHandle<{ proceed: boolean; note?: string }>(
			{ runId, taskId: approveTaskId },
			{ runId, producerTaskId: approveTaskId, output: "result" },
		);
		expect(Object.hasOwn(approveHandle, "handoff")).toBe(false);
		expect(isHandoffHandle(approveHandle.output)).toBe(false);
		const definition = defineWorkflow({
			meta: {
				name: "checkpointed",
				description: "Checkpoint",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({}),
			outputSchema: schema,
			async run(ctx) {
				const approve = ctx.checkpoint("approve", request);
				expectTypeOf(approve).toEqualTypeOf<
					TaskHandle<{ proceed: boolean; note?: string }>
				>();
				// Compile-time only: a checkpoint handle never carries a handoff.
				const rejectHandoff = () =>
					// @ts-expect-error TaskHandle is not a WorktreeTaskHandle
					ctx.handoff(approve);
				expect(typeof rejectHandoff).toBe("function");
				const decision = await ctx.result(approve);
				expectTypeOf(decision).toEqualTypeOf<{
					proceed: boolean;
					note?: string;
				}>();
				return decision;
			},
		});
		expect(isWorkflowDefinition(definition)).toBe(true);
		const declared: Array<{
			key: string;
			request: CheckpointRequest<typeof schema>;
		}> = [];
		const context = {
			checkpoint(key: string, checkpoint: CheckpointRequest<typeof schema>) {
				declared.push({ key, request: checkpoint });
				return approveHandle;
			},
			async result(task: TaskHandle<unknown>) {
				expect(task).toBe(approveHandle);
				return { proceed: true };
			},
		} as unknown as Parameters<typeof definition.run>[0];
		await expect(definition.run(context)).resolves.toEqual({ proceed: true });
		expect(declared).toEqual([{ key: "approve", request }]);
		expect(declared[0]?.request.inputs).toEqual({ plan: plan.output });
	});

	it("carries agent attempt policies through the authoring context", () => {
		const outputSchema = Type.Object({ answer: Type.String() });
		const request: AgentTaskAuthoringRequest<typeof outputSchema> = {
			agent: "researcher",
			task: { goal: "Answer", context: [], instructions: ["Answer."] },
			contextMode: "fresh",
			tools: ["read"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: "/repo" },
			outputSchema,
			limits: {
				cumulativeRuntimeMs: 300_000,
				attemptTimeoutMs: 300_000,
				cost: 100,
				outputBytes: 1_048_576,
				workspaceWriteBytes: 0,
				retries: 2,
				resumes: 1,
			},
			retry: { attempts: 2, on: ["backoff", "manual"] },
			resume: { attempts: 1 },
		};
		const defaulted: AgentTaskAuthoringRequest<typeof outputSchema> = {
			...request,
			retry: { attempts: 1 },
		};
		expect(defaulted.retry?.on).toBeUndefined();
		const definition = defineWorkflow({
			meta: {
				name: "attempts",
				description: "Attempt policies",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({}),
			outputSchema,
			run(ctx) {
				ctx.agent("first", defaulted);
				return ctx.agent("answer", request);
			},
		});
		const taskId = `task_${"a".repeat(64)}`;
		const handle = createTaskHandle<{ answer: string }>(
			{ runId: "workflow_definition", taskId },
			{
				runId: "workflow_definition",
				producerTaskId: taskId,
				output: "result",
			},
		);
		const declared: Array<{
			key: string;
			request: AgentTaskAuthoringRequest<typeof outputSchema>;
		}> = [];
		const context = {
			agent(
				key: string,
				agent: AgentTaskAuthoringRequest<typeof outputSchema>,
			) {
				declared.push({ key, request: agent });
				return handle;
			},
		} as unknown as Parameters<typeof definition.run>[0];
		expect(definition.run(context)).toBe(handle);
		expect(declared).toEqual([
			{ key: "first", request: defaulted },
			{ key: "answer", request },
		]);
		expect(declared[1]?.request.retry).toEqual({
			attempts: 2,
			on: ["backoff", "manual"],
		});
		expect(declared[1]?.request.resume).toEqual({ attempts: 1 });
	});

	it("creates an immutable typed definition", () => {
		const definition = defineWorkflow({
			meta: {
				name: "example",
				description: "Example workflow",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({ question: Type.String() }),
			outputSchema: Type.Object({ answer: Type.String() }),
			run(ctx) {
				return { answer: ctx.input.question };
			},
		});
		expect(isWorkflowDefinition(definition)).toBe(true);
		expect(Object.isFrozen(definition)).toBe(true);
		expect(Object.isFrozen(definition.meta)).toBe(true);
		expect(Object.isFrozen(definition.meta.budget)).toBe(true);
		expect(definition.meta.concurrency).toBe(4);
		expect(Object.isFrozen(definition.inputSchema)).toBe(true);
		expect(Object.isFrozen(definition.outputSchema)).toBe(true);
	});

	it("accepts metadata and schemas created in another realm", () => {
		const foreign = vm.runInNewContext(
			`(${JSON.stringify({
				meta: {
					name: "foreign",
					description: "Defined inside a vm context",
					version: 1,
					budget: { cost: 1000, childRuntimeMs: 3600000 },
					timeoutMs: 3600000,
				},
				inputSchema: Type.Object({ question: Type.String() }),
				outputSchema: Type.Object({ answer: Type.String() }),
			})})`,
		) as {
			meta: Parameters<typeof defineWorkflow>[0]["meta"];
			inputSchema: TSchema;
			outputSchema: TSchema;
		};
		expect(Object.getPrototypeOf(foreign.meta)).not.toBe(Object.prototype);
		const definition = defineWorkflow({
			meta: foreign.meta,
			inputSchema: foreign.inputSchema,
			outputSchema: foreign.outputSchema,
			run() {
				return { answer: "yes" };
			},
		});
		expect(isWorkflowDefinition(definition)).toBe(true);
		expect(definition.meta).toMatchObject({ name: "foreign", concurrency: 4 });
		expect(definition.inputSchema).toEqual(
			JSON.parse(JSON.stringify(Type.Object({ question: Type.String() }))),
		);
		expect(Object.getPrototypeOf(definition.inputSchema)).toBe(
			Object.prototype,
		);
	});

	it("validates repeated schema IDs without shared validator state", () => {
		const create = () =>
			defineWorkflow({
				meta: {
					name: "schema-id",
					description: "Schema ID",
					version: 1,
					budget: { cost: 1000, childRuntimeMs: 3600000 },
					timeoutMs: 3600000,
				},
				inputSchema: { $id: "urn:test:input", type: "object" },
				outputSchema: { $id: "urn:test:output", type: "object" },
				run() {
					return {};
				},
			});
		expect(isWorkflowDefinition(create())).toBe(true);
		expect(isWorkflowDefinition(create())).toBe(true);
	});

	it("rejects invalid metadata and non-JSON schemas", () => {
		expect(
			defineWorkflow({
				meta: {
					name: "bounded",
					description: "Bounded",
					version: 1,
					budget: { cost: 1000, childRuntimeMs: 3600000 },
					timeoutMs: 3600000,
					concurrency: 16,
				},
				inputSchema: Type.Object({}),
				outputSchema: Type.Object({}),
				run() {
					return {};
				},
			}).meta.concurrency,
		).toBe(16);
		expect(() =>
			defineWorkflow({
				meta: {
					name: "too-concurrent",
					description: "Invalid",
					version: 1,
					budget: { cost: 1000, childRuntimeMs: 3600000 },
					timeoutMs: 3600000,
					concurrency: 17,
				},
				inputSchema: Type.Object({}),
				outputSchema: Type.Object({}),
				run() {
					return {};
				},
			}),
		).toThrow("invalid workflow metadata");
		expect(() =>
			defineWorkflow({
				meta: {
					name: "Invalid Name",
					description: "Invalid",
					version: 1,
					budget: { cost: 1000, childRuntimeMs: 3600000 },
					timeoutMs: 3600000,
				},
				inputSchema: Type.Object({}),
				outputSchema: Type.Object({}),
				run() {
					return {};
				},
			}),
		).toThrow("invalid workflow metadata");
		expect(() =>
			defineWorkflow({
				meta: {
					name: "invalid",
					description: "Invalid",
					version: 1,
					budget: { cost: 1000, childRuntimeMs: 3600000 },
					timeoutMs: 3600000,
				},
				inputSchema: { type: "not-a-schema-type" },
				outputSchema: Type.Object({}),
				run() {
					return {};
				},
			}),
		).toThrow("not a valid JSON Schema");
		expect(() =>
			defineWorkflow({
				meta: {
					name: "missing-ref",
					description: "Invalid",
					version: 1,
					budget: { cost: 1000, childRuntimeMs: 3600000 },
					timeoutMs: 3600000,
				},
				inputSchema: { $ref: "#/missing" },
				outputSchema: Type.Object({}),
				run() {
					return {};
				},
			}),
		).toThrow("not a valid JSON Schema");
		expect(
			isWorkflowDefinition({
				schema: "pi-workflow-definition",
				meta: {
					name: "invalid",
					description: "Invalid",
					version: 1,
					budget: { cost: 1000, childRuntimeMs: 3600000 },
					timeoutMs: 3600000,
				},
				inputSchema: () => undefined,
				outputSchema: {},
				run() {},
			}),
		).toBe(false);
	});
});

describe("worktree handoff handles", () => {
	const runId = "workflow_definition";
	const writerTaskId = `task_${"c".repeat(64)}`;
	const readerTaskId = `task_${"d".repeat(64)}`;
	const resultRef = {
		runId,
		producerTaskId: writerTaskId,
		output: "result" as const,
	};
	const handoffRef = {
		runId,
		producerTaskId: writerTaskId,
		output: "handoff" as const,
	};
	const outputSchema = Type.Object({ answer: Type.String() });
	const base = {
		agent: "writer",
		task: { goal: "Edit", context: [], instructions: ["Edit."] },
		contextMode: "fresh" as const,
		tools: ["read", "edit"],
		preloadSkills: [],
		contextScopes: ["project" as const],
		outputSchema,
		limits: {
			cumulativeRuntimeMs: 300_000,
			attemptTimeoutMs: 300_000,
			cost: 100,
			outputBytes: 1_048_576,
			workspaceWriteBytes: 1_048_576,
			retries: 0,
			resumes: 0,
		},
	};

	it("carries a branded handoff handle only when a handoff reference is given", () => {
		const plain = createTaskHandle<{ answer: string }>(
			{ runId, taskId: writerTaskId },
			resultRef,
		);
		expect(Object.hasOwn(plain, "handoff")).toBe(false);
		expect(plain.handoff).toBeUndefined();
		expect(isTaskHandle(plain)).toBe(true);
		expect(isHandoffHandle(plain)).toBe(false);
		expect(isHandoffHandle(plain.output)).toBe(false);
		const worktree = createTaskHandle<{ answer: string }>(
			{ runId, taskId: writerTaskId },
			resultRef,
			handoffRef,
		);
		expectTypeOf(worktree).toEqualTypeOf<
			WorktreeTaskHandle<{ answer: string }>
		>();
		expect(worktree.ref).toEqual({ runId, taskId: writerTaskId });
		expect(worktree.output.ref).toEqual(resultRef);
		expect(worktree.handoff.ref).toEqual(handoffRef);
		expect(isTaskHandle(worktree)).toBe(true);
		expect(isHandoffHandle(worktree.handoff)).toBe(true);
		expect(isArtifactHandle(worktree.handoff)).toBe(false);
		expect(isTaskHandle(worktree.handoff)).toBe(false);
		expect(isArtifactHandle(worktree.output)).toBe(true);
		expect(isHandoffHandle(worktree.output)).toBe(false);
		expect(Object.isFrozen(worktree)).toBe(true);
		expect(Object.isFrozen(worktree.handoff)).toBe(true);
		expect(Object.isFrozen(worktree.handoff.ref)).toBe(true);
		expect(isHandoffHandle({ ref: handoffRef })).toBe(false);
		expect(isHandoffHandle(handoffRef)).toBe(false);
		expect(isHandoffHandle(null)).toBe(false);
		expect(isHandoffHandle(undefined)).toBe(false);
	});

	it("types worktree declarations, handoff inputs, ctx.handoff, and handoff returns", async () => {
		const worktreeRequest: AgentTaskAuthoringRequest<
			typeof outputSchema,
			{ mode: "worktree"; cwd: string }
		> = {
			...base,
			workspace: { mode: "worktree", cwd: "/repo" },
			handoff: "optional",
		};
		expect(worktreeRequest.handoff).toBe("optional");
		const readOnlyRequest: AgentTaskAuthoringRequest<typeof outputSchema> = {
			...base,
			workspace: { mode: "read-only", cwd: "/repo" },
		};
		expect(readOnlyRequest.handoff).toBeUndefined();
		const resolved: unknown[] = [];
		const definition = defineWorkflow({
			meta: {
				name: "handoff",
				description: "Worktree handoff",
				version: 1,
				budget: { cost: 1000, childRuntimeMs: 3600000 },
				timeoutMs: 3600000,
			},
			inputSchema: Type.Object({}),
			outputSchema: WorkflowHandoffDescriptorSchema,
			async run(ctx) {
				const writer = ctx.agent("writer", {
					...base,
					workspace: { mode: "worktree", cwd: "/repo" },
				});
				expectTypeOf(writer).toEqualTypeOf<
					WorktreeTaskHandle<{ answer: string }>
				>();
				const reader = ctx.agent("reader", {
					...base,
					workspace: { mode: "read-only", cwd: "/repo" },
					inputs: { patch: writer.handoff, answer: writer.output },
				});
				expectTypeOf(reader).toEqualTypeOf<TaskHandle<{ answer: string }>>();
				// Compile-time only: a read-only handle has no guaranteed handoff.
				const rejectReadOnly = () =>
					// @ts-expect-error TaskHandle is not a WorktreeTaskHandle
					ctx.handoff(reader);
				expect(typeof rejectReadOnly).toBe("function");
				resolved.push(await ctx.handoff(writer));
				return writer.handoff;
			},
		});
		expect(isWorkflowDefinition(definition)).toBe(true);
		const writerHandle = createTaskHandle<{ answer: string }>(
			{ runId, taskId: writerTaskId },
			resultRef,
			handoffRef,
		);
		const readerHandle = createTaskHandle<{ answer: string }>(
			{ runId, taskId: readerTaskId },
			{ runId, producerTaskId: readerTaskId, output: "result" },
		);
		const descriptor: WorkflowHandoffDescriptor = {
			artifactId: `artifact_${"1".repeat(64)}`,
			runId,
			producerTaskId: writerTaskId,
			producerExecutionId: `execution_${"2".repeat(64)}`,
			subagentRunId: "run-1",
			subagentAttemptId: "attempt-1",
			baselineHead: "3".repeat(40),
			handoffCommit: "4".repeat(40),
			format: "git-format-patch",
			mediaType: "application/x-git-format-patch",
			sha256: "5".repeat(64),
			bytes: 512,
		};
		const declared: Array<{
			key: string;
			request: AgentTaskAuthoringRequest<typeof outputSchema>;
		}> = [];
		const barriers: unknown[] = [];
		const context = {
			agent(
				key: string,
				request: AgentTaskAuthoringRequest<typeof outputSchema>,
			) {
				declared.push({ key, request });
				return request.workspace.mode === "worktree"
					? writerHandle
					: readerHandle;
			},
			async handoff(task: WorktreeTaskHandle<unknown>) {
				barriers.push(task);
				return descriptor;
			},
		} as unknown as Parameters<typeof definition.run>[0];
		await expect(definition.run(context)).resolves.toBe(writerHandle.handoff);
		expect(declared.map((entry) => entry.key)).toEqual(["writer", "reader"]);
		expect(declared[0]?.request.workspace).toEqual({
			mode: "worktree",
			cwd: "/repo",
		});
		expect(declared[0]?.request.handoff).toBeUndefined();
		expect(declared[1]?.request.inputs).toEqual({
			patch: writerHandle.handoff,
			answer: writerHandle.output,
		});
		expect(barriers).toEqual([writerHandle]);
		expect(resolved).toEqual([descriptor]);
	});
});
