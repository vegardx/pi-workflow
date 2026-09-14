import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
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
