import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type Static, Type } from "typebox";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { SupportImplementation } from "../src/contracts.js";
import { deriveSupportImplementationIdentitySha256 } from "../src/execution.js";
import { WorkflowTaskMaterializer } from "../src/materializer.js";
import { createWorkflowService, WorkflowServiceError } from "../src/service.js";
import type { WorkflowSubagentProvider } from "../src/subagent-provider.js";
import {
	defineSupportTask,
	type SupportTaskExecutionContext,
	type SupportTaskRegistration,
	supportRegistrationIdentity,
} from "../src/support.js";

const hash = "a".repeat(64);
const parametersSchema = Type.Object({ strict: Type.Boolean() });
const outputSchema = Type.Object({ value: Type.String() });
const options = {
	name: "@vegardx/workflow-tools/json-parse",
	moduleSpecifier: "@vegardx/workflow-tools",
	revision: 1,
	implementationSha256: hash,
	parametersSchema,
	outputSchema,
} as const;
const helper = defineSupportTask(options);

function execute({
	parameters,
}: SupportTaskExecutionContext<{ strict: boolean }>) {
	return { value: parameters.strict ? "strict" : "loose" };
}

async function serviceWith(supportTasks: readonly SupportTaskRegistration[]) {
	const base = path.resolve(".pi", "test-support", `service-${randomUUID()}`);
	const cwd = path.join(base, "project");
	await mkdir(cwd, { recursive: true });
	const subagents: WorkflowSubagentProvider = {
		bind: vi.fn(async () => {
			throw new Error("unexpected provider binding");
		}),
	};
	return createWorkflowService({
		cwd,
		agentDir: path.join(base, "agent"),
		storeRoot: path.join(cwd, ".pi", "workflow"),
		projectTrusted: () => true,
		subagents,
		supportTasks,
	});
}

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
		expect(Object.isFrozen(descriptor.parameters)).toBe(true);
		expect(Object.isFrozen(descriptor.parametersSchema)).toBe(true);
		expect(Object.isFrozen(descriptor.outputSchema)).toBe(true);
		expect(() => helper({ parameters: { strict: "yes" } as never })).toThrow(
			"parameters do not match",
		);
		expect(() =>
			helper({ parameters: { strict: true, extra: 1 } as never }),
		).not.toThrow();
		expect(Object.isFrozen(helper.registration(execute))).toBe(true);
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
		const drifts: Record<string, Partial<SupportImplementation>> = {
			digest: { implementationSha256: "b".repeat(64) },
			module: { moduleSpecifier: "@vegardx/other-tools" },
			name: { name: "@vegardx/workflow-tools/json-stringify" },
			outputSchema: {
				outputSchema: {
					type: "object",
					properties: { value: { type: "integer" } },
					required: ["value"],
				},
			},
			parametersSchema: {
				parametersSchema: {
					type: "object",
					properties: { strict: { type: "integer" } },
					required: ["strict"],
				},
			},
			revision: { revision: 2 },
		};
		const drifted = Object.entries(drifts).map(([label, change]) => [
			label,
			deriveSupportImplementationIdentitySha256({
				...implementation,
				...change,
			}),
			supportRegistrationIdentity({
				...registration,
				...change,
			} as SupportTaskRegistration),
		]);
		for (const [label, persisted, registered] of drifted) {
			expect(persisted, label).not.toBe(identity);
			expect(registered, label).toBe(persisted);
		}
		expect(new Set(drifted.map(([, digest]) => digest)).size).toBe(
			drifted.length,
		);
	});

	it("infers parameters and output types from the schemas", () => {
		const registration = helper.registration((context) => {
			expectTypeOf(context.parameters).toEqualTypeOf<{ strict: boolean }>();
			expectTypeOf(context.inputs).toEqualTypeOf<
				Readonly<Record<string, unknown>>
			>();
			expectTypeOf(context.signal).toEqualTypeOf<AbortSignal>();
			return { value: String(context.parameters.strict) };
		});
		expectTypeOf(registration.execute).returns.toEqualTypeOf<
			Promise<{ value: string }> | { value: string }
		>();
		expectTypeOf(helper).parameter(0).toHaveProperty("parameters");
		expectTypeOf<Parameters<typeof helper>[0]["parameters"]>().toEqualTypeOf<{
			strict: boolean;
		}>();
		expectTypeOf(
			helper({ parameters: { strict: false } }).outputSchema,
		).toEqualTypeOf<typeof outputSchema>();
		expectTypeOf<Static<typeof helper.outputSchema>>().toEqualTypeOf<{
			value: string;
		}>();
		// @ts-expect-error parameters must match the parameters schema
		helper.registration((_context: SupportTaskExecutionContext<number>) => ({
			value: "x",
		}));
		// @ts-expect-error the returned value must match the output schema
		helper.registration(() => ({ value: 1 }));
		expect(registration.name).toBe(options.name);
	});

	it("rejects malformed identity and schemas at definition time", () => {
		expect(() =>
			defineSupportTask({ ...options, implementationSha256: "A".repeat(64) }),
		).toThrow("invalid support task implementation identity");
		expect(() =>
			defineSupportTask({ ...options, implementationSha256: "abc" }),
		).toThrow("invalid support task implementation identity");
		expect(() => defineSupportTask({ ...options, revision: 0 })).toThrow(
			"invalid support task implementation identity",
		);
		expect(() => defineSupportTask({ ...options, revision: 1.5 })).toThrow(
			"invalid support task implementation identity",
		);
		expect(() =>
			defineSupportTask({ ...options, name: "bad name with spaces" }),
		).toThrow("invalid support task implementation identity");
		expect(() =>
			defineSupportTask({ ...options, moduleSpecifier: "" }),
		).toThrow("invalid support task implementation identity");
		expect(() =>
			defineSupportTask({
				...options,
				parametersSchema: { type: "nope" } as never,
			}),
		).toThrow("support task parameters schema");
		expect(() =>
			defineSupportTask({
				...options,
				outputSchema: { type: "object", minimum: "x" } as never,
			}),
		).toThrow("support task output schema");
		expect(() =>
			supportRegistrationIdentity({
				...helper.registration(execute),
				outputSchema: { type: "nope" } as never,
			}),
		).toThrow("support registration output schema");
	});

	it("accepts a valid registration in the service constructor", async () => {
		const registration = helper.registration(execute);
		const service = await serviceWith([registration]);
		await expect(service.list()).resolves.toEqual([]);
		await service.shutdown();
	});

	it("rejects duplicate implementation names in the service constructor", async () => {
		const registration = helper.registration(execute);
		const sibling = defineSupportTask({
			...options,
			implementationSha256: "b".repeat(64),
		}).registration(execute);
		const error: unknown = await serviceWith([registration, sibling]).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(WorkflowServiceError);
		expect(error).toMatchObject({
			code: "conflict",
			message: `Duplicate support task implementation: ${options.name}`,
		});
	});

	it("rejects registrations that are not executable or drift from the schema contract", async () => {
		const registration = helper.registration(execute);
		await expect(
			serviceWith([{ ...registration, execute: "nope" as never }]),
		).rejects.toMatchObject({
			name: "WorkflowServiceError",
			code: "validation",
			message: "Support task implementation is not executable.",
		});
		await expect(
			serviceWith([{ ...registration, implementationSha256: "abc" }]),
		).rejects.toThrow("invalid support task implementation identity");
		await expect(
			serviceWith([
				{ ...registration, parametersSchema: { type: "nope" } as never },
			]),
		).rejects.toThrow("support registration parameters schema");
	});
});
