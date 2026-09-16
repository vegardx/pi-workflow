import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { SubagentClient } from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { deriveDynamicSourceSha256 } from "../src/dynamic/source.js";
import {
	createWorkflowService,
	type WorkflowServiceOptions,
} from "../src/service.js";
import { DynamicWorkflowProposalViewSchema } from "../src/service-views.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";
import { defineSupportTask } from "../src/support.js";

/*
 * The service's dynamic-path plumbing that test/service-dynamic.test.ts does
 * not cover: option validation at construction, the project-trust gate, and
 * reference parsing. Store, approval, and run-copy behaviour live there.
 */

function provider(): WorkflowSubagentProvider {
	return {
		bind: vi.fn(
			async (runId: string) =>
				({
					workflowRunId: runId,
					ownerId: `pi-workflow:${runId}`,
					client: {} as SubagentClient,
				}) satisfies WorkflowSubagentBinding,
		),
	};
}

async function fixture(trusted: boolean) {
	const base = path.resolve(
		".pi",
		"test-service-dynamic-path",
		`${randomUUID()}`,
	);
	const cwd = path.join(base, "project");
	await mkdir(cwd, { recursive: true });
	const options: WorkflowServiceOptions = {
		cwd,
		agentDir: path.join(base, "agent"),
		storeRoot: path.join(cwd, ".pi", "workflow"),
		projectTrusted: () => trusted,
		subagents: provider(),
		// Source-mode workers boot slowly under full-suite load.
		dynamic: { bootTimeoutMs: 60_000 },
	};
	return options;
}

const echo = defineSupportTask({
	name: "tools/echo",
	moduleSpecifier: "@vegardx/tools",
	revision: 1,
	implementationSha256: "a".repeat(64),
	parametersSchema: Type.Object(
		{ value: Type.String() },
		{ additionalProperties: false },
	),
	outputSchema: Type.Object(
		{ value: Type.String() },
		{ additionalProperties: false },
	),
});
const upper = defineSupportTask({
	name: "tools/upper",
	moduleSpecifier: "@vegardx/tools",
	revision: 1,
	implementationSha256: "b".repeat(64),
	parametersSchema: Type.Object(
		{ value: Type.String() },
		{ additionalProperties: false },
	),
	outputSchema: Type.Object(
		{ value: Type.String() },
		{ additionalProperties: false },
	),
});
const execute = async ({ parameters }: { parameters: { value: string } }) =>
	parameters;

const SOURCE = `import { defineWorkflow } from "@vegardx/pi-workflow";
export default defineWorkflow({
	meta: { name: "dynamic-path", description: "Dynamic path", version: 1, budget: { cost: 1, childRuntimeMs: 60000 }, timeoutMs: 60000 },
	inputSchema: { type: "object", properties: {}, additionalProperties: false },
	outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
	async run() { return { ok: true }; },
});
`;
const REF = `dynamic:${deriveDynamicSourceSha256(SOURCE)}` as const;

describe("dynamic workflow service path", () => {
	it("refuses an invalid or reserved support export name at construction", async () => {
		const options = await fixture(true);
		for (const exportName of ["default", "1abc", "has-dash", ""]) {
			const registration = {
				...echo.registration(execute),
				exportName,
			};
			await expect(
				createWorkflowService({ ...options, supportTasks: [registration] }),
			).rejects.toMatchObject({
				name: "WorkflowServiceError",
				code: "validation",
				message: "Support task export name is invalid.",
			});
		}
	});

	it("refuses two helpers published under the same module export", async () => {
		const options = await fixture(true);
		await expect(
			createWorkflowService({
				...options,
				supportTasks: [
					echo.registration(execute, { exportName: "echo" }),
					upper.registration(execute, { exportName: "echo" }),
				],
			}),
		).rejects.toMatchObject({
			name: "WorkflowServiceError",
			code: "conflict",
			message: "Duplicate support task export name: @vegardx/tools#echo",
		});
		// The same export name under another module specifier is distinct.
		const service = await createWorkflowService({
			...options,
			supportTasks: [
				echo.registration(execute, { exportName: "echo" }),
				defineSupportTask({
					name: "other/echo",
					moduleSpecifier: "@vegardx/other",
					revision: 1,
					implementationSha256: "c".repeat(64),
					parametersSchema: echo.parametersSchema,
					outputSchema: echo.outputSchema,
				}).registration(execute, { exportName: "echo" }),
			],
		});
		await service.shutdown();
	});

	it("refuses every dynamic surface without project trust", async () => {
		const service = await createWorkflowService(await fixture(false));
		const refusal = {
			name: "WorkflowServiceError",
			code: "validation",
			message: "Dynamic workflows require project trust.",
		};
		await expect(
			service.propose(SOURCE, {
				proposer: { kind: "tool", via: "workflow_propose" },
			}),
		).rejects.toMatchObject(refusal);
		await expect(service.inspectProposal(REF)).rejects.toMatchObject(refusal);
		await expect(service.proposals()).rejects.toMatchObject(refusal);
		await expect(
			service.decideSource(REF, {
				decision: "approved",
				approver: { kind: "human", via: "/workflow approve" },
			}),
		).rejects.toMatchObject(refusal);
		await expect(service.validate(REF)).rejects.toMatchObject(refusal);
		await expect(service.run(REF, {})).rejects.toMatchObject(refusal);
		// Static references never reach the dynamic gate.
		await expect(service.run("missing", {})).rejects.toMatchObject({
			code: "not-found",
			message: "Workflow not found: missing",
		});
		await service.shutdown();
	});

	it("rejects malformed dynamic references before touching the store", async () => {
		const service = await createWorkflowService(await fixture(true));
		const invalid = {
			name: "WorkflowServiceError",
			code: "validation",
			message: "Invalid dynamic workflow reference.",
		};
		for (const ref of [
			"dynamic:",
			"dynamic:abc",
			`dynamic:${"A".repeat(64)}`,
		]) {
			await expect(service.validate(ref)).rejects.toMatchObject(invalid);
			await expect(service.run(ref, {})).rejects.toMatchObject(invalid);
			await expect(service.inspectProposal(ref)).rejects.toMatchObject(invalid);
			await expect(
				service.decideSource(ref, {
					decision: "rejected",
					approver: { kind: "human", via: "/workflow reject" },
				}),
			).rejects.toMatchObject(invalid);
		}
		await expect(service.inspectProposal(REF)).rejects.toMatchObject({
			code: "not-found",
			message: `Dynamic workflow proposal not found: ${REF}`,
		});
		await expect(service.proposals()).resolves.toEqual([]);
		await expect(
			service.propose(SOURCE, {
				proposer: { kind: "model", via: "x" } as never,
			}),
		).rejects.toMatchObject({
			code: "validation",
			message: "Invalid dynamic workflow proposer.",
		});
		await service.shutdown();
	});

	it("proposes, approves, and runs a dynamic source end to end", async () => {
		const service = await createWorkflowService(await fixture(true));
		const proposed = await service.propose(SOURCE, {
			proposer: { kind: "tool", via: "workflow_propose" },
		});
		expect(Value.Check(DynamicWorkflowProposalViewSchema, proposed)).toBe(true);
		expect(proposed).toMatchObject({
			ref: REF,
			runnable: false,
			manifest: { meta: { name: "dynamic-path", concurrency: 4 } },
		});
		expect(proposed.decision).toBeUndefined();
		await expect(service.validate(REF)).rejects.toMatchObject({
			code: "validation",
			message:
				"Dynamic workflow source is not approved for the current host API.",
		});
		const approved = await service.decideSource(REF, {
			decision: "approved",
			approver: { kind: "human", via: "/workflow approve", sessionId: "s1" },
		});
		expect(approved.runnable).toBe(true);
		expect(approved.decision).toMatchObject({
			decision: "approved",
			approver: { kind: "human", via: "/workflow approve", sessionId: "s1" },
		});
		expect(await service.inspectProposal(REF)).toMatchObject({
			...approved,
			source: SOURCE,
		});
		expect((await service.proposals()).map((entry) => entry.ref)).toEqual([
			REF,
		]);
		expect(await service.validate(REF, {})).toMatchObject({
			valid: true,
			workflow: {
				name: "dynamic-path",
				scope: "dynamic",
				source: "proposal",
				path: approved.path,
				identitySha256: approved.definitionIdentitySha256,
			},
		});
		const receipt = await service.run(REF, {});
		const view = await service.wait(receipt.runId);
		expect(view.status).toBe("completed");
		expect(view.output).toEqual({ ok: true });
		expect(view.dynamic).toEqual({
			ref: REF,
			sourceSha256: approved.sourceSha256,
			approvalSha256: approved.decision?.approvalSha256,
			hostApiSha256: approved.hostApiSha256,
		});
		// Static run views carry no dynamic block; the summary list stays static.
		await expect(service.list()).resolves.toEqual([]);
		await expect(
			service.decideSource(REF, {
				decision: "approved",
				approver: { kind: "human", via: "/workflow approve" },
			}),
		).rejects.toMatchObject({
			code: "conflict",
			message: "Dynamic workflow source is already approved.",
		});
		await service.shutdown();
		await expect(
			service.propose(SOURCE, {
				proposer: { kind: "tool", via: "workflow_propose" },
			}),
		).rejects.toMatchObject({
			name: "WorkflowServiceError",
			code: "conflict",
			message: "Workflow service is closed.",
		});
	});
});
