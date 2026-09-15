import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	type AgentTaskAuthoringRequest,
	createTaskHandle,
	defineWorkflow,
	isWorkflowDefinition,
	type NestedWorkflowRequest,
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
