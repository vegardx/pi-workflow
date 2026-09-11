import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { deriveSupportImplementationIdentitySha256 } from "../src/execution.js";
import { WorkflowTaskMaterializer } from "../src/materializer.js";
import {
	defineSupportTask,
	supportRegistrationIdentity,
} from "../src/support.js";

const hash = "a".repeat(64);
const helper = defineSupportTask({
	name: "@vegardx/workflow-tools/json-parse",
	moduleSpecifier: "@vegardx/workflow-tools",
	revision: 1,
	implementationSha256: hash,
	parametersSchema: Type.Object({ strict: Type.Boolean() }),
	outputSchema: Type.Object({ value: Type.String() }),
});

describe("typed support tasks", () => {
	it("creates immutable typed descriptors and validates parameters", () => {
		const descriptor = helper({ parameters: { strict: true } });
		expect(descriptor).toMatchObject({
			schema: "pi-workflow-support-task-descriptor",
			implementation: "@vegardx/workflow-tools/json-parse",
			revision: 1,
			parameters: { strict: true },
		});
		expect(Object.isFrozen(helper)).toBe(true);
		expect(Object.isFrozen(descriptor)).toBe(true);
		expect(() => helper({ parameters: { strict: "yes" } as never })).toThrow(
			"parameters do not match",
		);
	});

	it("materializes the descriptor into a durable support task", () => {
		const materializer = new WorkflowTaskMaterializer({
			runId: "workflow_support",
			definitionIdentitySha256: hash,
			inputSha256: hash,
		});
		const task = materializer.support(
			"parse",
			helper({ parameters: { strict: true } }),
		);
		const commit = materializer.closeEpoch("final", [task]);
		const declaration = commit.events.find(
			(event) => event.type === "task-declared",
		);
		expect(declaration).toMatchObject({
			data: {
				task: {
					spec: {
						kind: "support",
						request: {
							implementation: {
								name: "@vegardx/workflow-tools/json-parse",
								implementationSha256: hash,
							},
							parameters: { strict: true },
						},
					},
				},
			},
		});
	});

	it("binds registrations to explicit identity and schemas", () => {
		const registration = helper.registration(({ parameters }) => ({
			value: parameters.strict ? "strict" : "loose",
		}));
		const identity = supportRegistrationIdentity(registration);
		expect(identity).toMatch(/^[a-f0-9]{64}$/);
		const materializer = new WorkflowTaskMaterializer({
			runId: "workflow_support",
			definitionIdentitySha256: hash,
			inputSha256: hash,
		});
		const task = materializer.support(
			"parse",
			helper({ parameters: { strict: true } }),
		);
		const declaration = materializer
			.closeEpoch("final", [task])
			.events.find((event) => event.type === "task-declared");
		if (
			declaration?.type !== "task-declared" ||
			declaration.data.task.spec.kind !== "support"
		) {
			throw new Error("missing support task declaration");
		}
		const implementation = declaration.data.task.spec.request.implementation;
		expect(deriveSupportImplementationIdentitySha256(implementation)).toBe(
			identity,
		);
		expect(
			deriveSupportImplementationIdentitySha256({
				...implementation,
				outputSchema: Object.fromEntries(
					Object.entries(implementation.outputSchema).reverse(),
				),
			}),
		).toBe(identity);
		expect(
			deriveSupportImplementationIdentitySha256({
				...implementation,
				revision: 2,
			}),
		).not.toBe(identity);
	});
});
