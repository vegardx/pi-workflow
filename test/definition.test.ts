import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { defineWorkflow, isWorkflowDefinition } from "../src/definition.js";

describe("workflow definitions", () => {
	it("creates an immutable typed definition", () => {
		const definition = defineWorkflow({
			meta: { name: "example", description: "Example workflow", version: 1 },
			inputSchema: Type.Object({ question: Type.String() }),
			outputSchema: Type.Object({ answer: Type.String() }),
			run(ctx) {
				return { answer: ctx.input.question };
			},
		});
		expect(isWorkflowDefinition(definition)).toBe(true);
		expect(Object.isFrozen(definition)).toBe(true);
		expect(Object.isFrozen(definition.meta)).toBe(true);
		expect(Object.isFrozen(definition.inputSchema)).toBe(true);
		expect(Object.isFrozen(definition.outputSchema)).toBe(true);
	});

	it("validates repeated schema IDs without shared validator state", () => {
		const create = () =>
			defineWorkflow({
				meta: { name: "schema-id", description: "Schema ID", version: 1 },
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
		expect(() =>
			defineWorkflow({
				meta: { name: "Invalid Name", description: "Invalid", version: 1 },
				inputSchema: Type.Object({}),
				outputSchema: Type.Object({}),
				run() {
					return {};
				},
			}),
		).toThrow("invalid workflow metadata");
		expect(() =>
			defineWorkflow({
				meta: { name: "invalid", description: "Invalid", version: 1 },
				inputSchema: { type: "not-a-schema-type" },
				outputSchema: Type.Object({}),
				run() {
					return {};
				},
			}),
		).toThrow("not a valid JSON Schema");
		expect(() =>
			defineWorkflow({
				meta: { name: "missing-ref", description: "Invalid", version: 1 },
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
				meta: { name: "invalid", description: "Invalid", version: 1 },
				inputSchema: () => undefined,
				outputSchema: {},
				run() {},
			}),
		).toBe(false);
	});
});
