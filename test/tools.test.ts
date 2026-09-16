import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_DYNAMIC_SOURCE_BYTES } from "../src/dynamic/constants.js";
import { DynamicWorkflowProposerSchema } from "../src/dynamic/contracts.js";
import { deriveDynamicSourceSha256 } from "../src/dynamic/source.js";
import { encodeWorkflowRunCursor } from "../src/run-projection.js";
import {
	createWorkflowService,
	type WorkflowService,
	WorkflowServiceError,
} from "../src/service.js";
import {
	DynamicWorkflowProposalViewSchema,
	type WorkflowLogPage,
	type WorkflowRunInspection,
	type WorkflowRunPage,
	WorkflowServiceRunViewSchema,
} from "../src/service-views.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";
import {
	MAX_TOOL_OUTPUT_BYTES,
	WORKFLOW_TOOL_DECLARATIONS,
	type WorkflowToolName,
	workflowToolText,
} from "../src/tools.js";
import {
	attemptProvider,
	COMPLETED,
	childFailure,
	client,
	INTERRUPTED,
	operatorFixture,
} from "./fixtures/attempt-provider.js";

function provider(): WorkflowSubagentProvider {
	return {
		bind: vi.fn(
			async (runId: string) =>
				({
					workflowRunId: runId,
					ownerId: `pi-workflow:${runId}`,
					client: client(),
				}) satisfies WorkflowSubagentBinding,
		),
	};
}

async function fixture() {
	const base = path.resolve(".pi", "test-tools", randomUUID());
	const cwd = path.join(base, "project");
	const agentDir = path.join(base, "agent");
	const storeRoot = path.join(cwd, ".pi", "workflow");
	await mkdir(path.join(cwd, "workflows"), { recursive: true });
	await writeFile(
		path.join(cwd, "workflows", "example.workflow.ts"),
		`export default {
  schema: "pi-workflow-definition",
  meta: { name: "example", description: "Tool workflow", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 3600000, concurrency: 4 },
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  run(ctx) { return { answer: ctx.input.value }; }
};\n`,
	);
	await writeFile(
		path.join(cwd, "workflows", "stoppable.workflow.ts"),
		`export default {
  schema: "pi-workflow-definition",
  meta: { name: "stoppable", description: "Stoppable workflow", version: 1, budget: { cost: 10, childRuntimeMs: 60000 }, timeoutMs: 3600000, concurrency: 1 },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  run(ctx) { return new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve({ answer: "late" }), { once: true })); }
};\n`,
	);
	// The unavailable client fails the agent task at preflight, so the run
	// ends failed with one settled task: the shape workflow_invalidate needs.
	await writeFile(
		path.join(cwd, "workflows", "delegating.workflow.ts"),
		`export default {
  schema: "pi-workflow-definition",
  meta: { name: "delegating", description: "Delegating workflow", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 3600000, concurrency: 4 },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  run(ctx) {
    return ctx.agent("answer", {
      agent: "researcher",
      task: { goal: "Answer", context: [], instructions: ["Return structured output."] },
      contextMode: "fresh",
      tools: ["read"],
      preloadSkills: [],
      contextScopes: ["project"],
      workspace: { mode: "read-only", cwd: ctx.cwd },
      outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
      limits: { cumulativeRuntimeMs: 300000, attemptTimeoutMs: 300000, totalTokens: 1000000, cost: 10, outputBytes: 1024, workspaceWriteBytes: 0, retries: 0, resumes: 0 }
    });
  }
};\n`,
	);
	// Parks at its checkpoint until a human decides: exercises the parked
	// workflow_wait view. No tool decides a checkpoint; the service does.
	await writeFile(
		path.join(cwd, "workflows", "gated.workflow.ts"),
		`export default {
  schema: "pi-workflow-definition",
  meta: { name: "gated", description: "Gated workflow", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 3600000, concurrency: 4 },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  async run(ctx) {
    const approve = ctx.checkpoint("approve", {
      schema: { type: "object", properties: { proceed: { type: "boolean" } }, required: ["proceed"], additionalProperties: false },
      prompt: "Approve the plan?",
      headless: "block"
    });
    const decision = await ctx.result(approve);
    return { answer: decision.proceed ? "approved" : "declined" };
  }
};\n`,
	);
	return { cwd, agentDir, storeRoot };
}

/**
 * Real results for the operator attempt tools. The scripted owner client
 * settles children so both paths complete: launch 1 is interrupted with a
 * resumable failure and completes once resumed on its existing child run;
 * launch 2 fails and its retry, generation 2 on launch 3, completes.
 */
async function operatorResults() {
	const delegated = attemptProvider((launch) =>
		launch === 1
			? [INTERRUPTED, COMPLETED]
			: launch === 2
				? [{ status: "failed", failure: childFailure("manual") }]
				: [COMPLETED],
	);
	const service = await createWorkflowService({
		...(await operatorFixture()),
		projectTrusted: () => true,
		subagents: delegated.provider,
	});
	try {
		const interrupted = await service.run("attempts", {});
		expect(await service.wait(interrupted.runId)).toMatchObject({
			status: "interrupted",
		});
		const resumed = await declaration("workflow_resume").execute(service, {
			runId: interrupted.runId,
			reason: "tool schema test",
		});
		expect(await service.wait(interrupted.runId)).toMatchObject({
			status: "completed",
			tasks: [expect.objectContaining({ generation: 1, attempts: 1 })],
		});
		const failed = await service.run("attempts", {});
		const failedView = await service.wait(failed.runId);
		expect(failedView.status).toBe("failed");
		const taskId = failedView.tasks?.[0]?.id;
		if (!taskId) throw new Error("failed run has no task");
		const retried = await declaration("workflow_retry").execute(service, {
			runId: failed.runId,
			taskId,
			reason: "tool schema test",
		});
		expect(await service.wait(failed.runId)).toMatchObject({
			status: "completed",
			tasks: [expect.objectContaining({ id: taskId, generation: 2 })],
		});
		expect(delegated.ownerClient.resume).toHaveBeenCalledOnce();
		expect(delegated.ownerClient.retry).not.toHaveBeenCalled();
		expect(delegated.ownerClient.launch).toHaveBeenCalledTimes(3);
		return {
			interruptedRunId: interrupted.runId,
			failedRunId: failed.runId,
			workflow_retry: retried,
			workflow_resume: resumed,
		};
	} finally {
		await service.shutdown();
	}
}
/** A valid dynamic source: what a model would hand to workflow_propose. */
const DYNAMIC_SOURCE = `import { defineWorkflow } from "@vegardx/pi-workflow";
export default defineWorkflow({
	meta: { name: "proposed", description: "Proposed workflow", version: 1, budget: { cost: 1, childRuntimeMs: 60000 }, timeoutMs: 60000 },
	inputSchema: { type: "object", properties: {}, additionalProperties: false },
	outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
	async run() { return { ok: true }; },
});
`;
const DYNAMIC_REF = `dynamic:${deriveDynamicSourceSha256(DYNAMIC_SOURCE)}`;

/** A value an earlier test in the describe produced; a named failure when it did not. */
function ready<T>(value: T | undefined, label: string): T {
	if (value === undefined) {
		throw new Error(`${label} is unavailable: an earlier step failed`);
	}
	return value;
}

function declaration(name: WorkflowToolName) {
	const found = WORKFLOW_TOOL_DECLARATIONS.find(
		(candidate) => candidate.name === name,
	);
	if (!found) throw new Error(`missing tool declaration ${name}`);
	return found;
}

const TOOL_NAMES: readonly WorkflowToolName[] = [
	"workflow_list",
	"workflow_validate",
	"workflow_run",
	"workflow_status",
	"workflow_wait",
	"workflow_stop",
	"workflow_reconcile",
	"workflow_runs",
	"workflow_inspect",
	"workflow_logs",
	"workflow_invalidate",
	"workflow_retry",
	"workflow_resume",
	"workflow_propose",
];

describe("workflow tool declarations", () => {
	it("declares fourteen uniquely named frozen tools with closed parameter schemas", () => {
		const names = WORKFLOW_TOOL_DECLARATIONS.map((tool) => tool.name);
		expect(names).toEqual(TOOL_NAMES);
		expect(new Set(names).size).toBe(names.length);
		expect(Object.isFrozen(WORKFLOW_TOOL_DECLARATIONS)).toBe(true);
		for (const tool of WORKFLOW_TOOL_DECLARATIONS) {
			expect(Object.isFrozen(tool)).toBe(true);
			expect(Object.isFrozen(tool.promptGuidelines)).toBe(true);
			expect(tool.label.length).toBeGreaterThan(0);
			expect(tool.description.length).toBeGreaterThan(0);
			expect(tool.parameters).toMatchObject({
				type: "object",
				additionalProperties: false,
			});
			expect(tool.output).toHaveProperty("type");
		}
		const runId = "workflow_toolparams";
		const wait = declaration("workflow_wait").parameters;
		expect(Value.Check(wait, { runId })).toBe(true);
		expect(Value.Check(wait, { runId, timeoutMs: 1_000 })).toBe(true);
		expect(Value.Check(wait, { runId, timeoutMs: 999 })).toBe(false);
		expect(Value.Check(wait, { runId, timeoutMs: 3_600_001 })).toBe(false);
		const reconcile = declaration("workflow_reconcile").parameters;
		expect(Value.Check(reconcile, { runId })).toBe(true);
		expect(Value.Check(reconcile, { runId, taskId: "task_abcdef" })).toBe(true);
		expect(Value.Check(reconcile, { runId, taskId: "bad" })).toBe(false);
		expect(Value.Check(reconcile, { runId, extra: true })).toBe(false);
		const inspect = declaration("workflow_inspect").parameters;
		expect(
			Value.Check(inspect, {
				runId,
				include: ["run", "tasks"],
				taskId: "task_a",
			}),
		).toBe(true);
		expect(Value.Check(inspect, { runId, include: [] })).toBe(false);
		expect(Value.Check(inspect, { runId, include: ["prompts"] })).toBe(false);
		const logs = declaration("workflow_logs").parameters;
		expect(Value.Check(logs, { runId, afterSequence: 0, limit: 500 })).toBe(
			true,
		);
		expect(Value.Check(logs, { runId, limit: 501 })).toBe(false);
		const runs = declaration("workflow_runs").parameters;
		expect(Value.Check(runs, {})).toBe(true);
		expect(
			Value.Check(runs, {
				statuses: ["failed"],
				includeChildren: true,
				limit: 100,
			}),
		).toBe(true);
		expect(Value.Check(runs, { statuses: [] })).toBe(false);
		expect(Value.Check(runs, { limit: 101 })).toBe(false);
		const invalidate = declaration("workflow_invalidate").parameters;
		expect(
			Value.Check(invalidate, { runId, taskId: "task_abcdef", reason: "why" }),
		).toBe(true);
		expect(Value.Check(invalidate, { runId, taskId: "task_abcdef" })).toBe(
			false,
		);
		const retry = declaration("workflow_retry");
		expect(
			Value.Check(retry.parameters, {
				runId,
				taskId: "task_abcdef",
				reason: "why",
			}),
		).toBe(true);
		expect(Value.Check(retry.parameters, { runId, reason: "why" })).toBe(false);
		expect(
			retry.summarizeCall({ runId, taskId: "task_abcdef", reason: "why" }),
		).toBe(`${runId} · task_abcdef`);
		const resume = declaration("workflow_resume");
		expect(Value.Check(resume.parameters, { runId, reason: "why" })).toBe(true);
		expect(
			Value.Check(resume.parameters, {
				runId,
				reason: "why",
				taskId: "task_abcdef",
			}),
		).toBe(true);
		expect(Value.Check(resume.parameters, { runId, reason: "" })).toBe(false);
		expect(
			Value.Check(resume.parameters, { runId, taskId: "task_abcdef" }),
		).toBe(false);
		expect(resume.summarizeCall({ runId, reason: "why" })).toBe(runId);
		expect(
			resume.summarizeCall({ runId, reason: "why", taskId: "task_abcdef" }),
		).toBe(`${runId} · task_abcdef`);
		const propose = declaration("workflow_propose").parameters;
		expect(propose).toEqual({
			type: "object",
			properties: {
				source: {
					type: "string",
					minLength: 1,
					maxLength: MAX_DYNAMIC_SOURCE_BYTES,
				},
			},
			required: ["source"],
			additionalProperties: false,
		});
		expect(Value.Check(propose, { source: "x" })).toBe(true);
		expect(
			Value.Check(propose, { source: "x".repeat(MAX_DYNAMIC_SOURCE_BYTES) }),
		).toBe(true);
		expect(Value.Check(propose, { source: "" })).toBe(false);
		expect(
			Value.Check(propose, {
				source: "x".repeat(MAX_DYNAMIC_SOURCE_BYTES + 1),
			}),
		).toBe(false);
		expect(Value.Check(propose, {})).toBe(false);
		expect(Value.Check(propose, { source: 1 })).toBe(false);
		expect(
			Value.Check(propose, {
				source: "x",
				proposer: { kind: "tool", via: "workflow_propose" },
			}),
		).toBe(false);
	});

	describe("real service results", () => {
		// One service, its runs, and its proposal are shared by the three
		// sweeps below: the same work as one sweep over every tool, but each
		// test carries a bounded share of it under the per-test budget.
		let service: WorkflowService | undefined;
		let runs:
			| { runId: string; delegatingRunId: string; failedTaskId: string }
			| undefined;
		const checkedResults = new Map<WorkflowToolName, unknown>();

		beforeAll(async () => {
			service = await createWorkflowService({
				...(await fixture()),
				projectTrusted: () => true,
				subagents: provider(),
				// Source-mode workers boot slowly under full-suite load.
				dynamic: { bootTimeoutMs: 60_000 },
			});
		});

		afterAll(async () => {
			await service?.shutdown();
		});

		/** A real result checked against the tool's declared output schema and text block. */
		function checked<T>(name: WorkflowToolName, value: T): T {
			const tool = declaration(name);
			expect(
				[...Value.Errors(tool.output, value)].map(
					(error) => `${tool.name} ${error.instancePath}: ${error.message}`,
				),
			).toEqual([]);
			// The text block is the checked value as bounded JSON.
			expect(JSON.parse(workflowToolText(tool, value))).toEqual(
				JSON.parse(JSON.stringify(value)),
			);
			checkedResults.set(name, value);
			return value;
		}

		it("validates lifecycle and operator tool results", async () => {
			const live = ready(service, "service");
			const receipt = checked(
				"workflow_run",
				await declaration("workflow_run").execute(live, {
					ref: "example",
					input: { value: "yes" },
				}),
			);
			const runId = (receipt as { runId: string }).runId;
			const stoppable = await declaration("workflow_run").execute(live, {
				ref: "stoppable",
				input: {},
			});
			const delegating = await declaration("workflow_run").execute(live, {
				ref: "delegating",
				input: {},
			});
			const delegatingRunId = (delegating as { runId: string }).runId;
			const failed = await declaration("workflow_wait").execute(live, {
				runId: delegatingRunId,
			});
			expect(failed).toMatchObject({ status: "failed" });
			const failedTaskId = (failed as { tasks: { id: string }[] }).tasks[0]?.id;
			if (!failedTaskId) throw new Error("delegating run has no task");
			const invalidated = checked(
				"workflow_invalidate",
				await declaration("workflow_invalidate").execute(live, {
					runId: delegatingRunId,
					taskId: failedTaskId,
					reason: "tool schema test",
				}),
			);
			await live.wait(delegatingRunId);
			const operator = await operatorResults();
			const retried = checked("workflow_retry", operator.workflow_retry);
			const resumed = checked("workflow_resume", operator.workflow_resume);
			const gated = await declaration("workflow_run").execute(live, {
				ref: "gated",
				input: {},
			});
			const gatedRunId = (gated as { runId: string }).runId;
			const parked = await declaration("workflow_wait").execute(live, {
				runId: gatedRunId,
			});
			expect(parked).toMatchObject({ status: "waiting", parked: true });
			const pending = (parked as { pendingCheckpoints?: { taskId: string }[] })
				.pendingCheckpoints;
			const checkpointTaskId = pending?.[0]?.taskId;
			if (!checkpointTaskId) throw new Error("gated run has no checkpoint");
			expect(pending).toHaveLength(1);
			// The parked view is a legal wait result; the decision itself is
			// human-only and reaches the service through the operator surface.
			expect([
				...Value.Errors(declaration("workflow_wait").output, parked),
			]).toEqual([]);
			await live.decide(gatedRunId, checkpointTaskId, {
				decision: { proceed: true },
				approver: "vegard",
				reason: "tool schema test",
			});
			await expect(live.wait(gatedRunId)).resolves.toMatchObject({
				status: "completed",
				output: { answer: "approved" },
			});
			const waited = checked(
				"workflow_wait",
				await declaration("workflow_wait").execute(live, {
					runId,
					timeoutMs: 60_000,
				}),
			);
			const stopped = checked(
				"workflow_stop",
				await declaration("workflow_stop").execute(live, {
					runId: (stoppable as { runId: string }).runId,
					reason: "tool schema test",
				}),
			);
			const reconciled = checked(
				"workflow_reconcile",
				await declaration("workflow_reconcile").execute(live, { runId }),
			);
			expect(waited).toMatchObject({
				runId,
				status: "completed",
				definitionName: "example",
				depth: 0,
				output: { answer: "yes" },
				tasks: [],
			});
			expect(waited).not.toHaveProperty("timedOut");
			expect(stopped).toMatchObject({ status: "cancelled" });
			expect(reconciled).toMatchObject({
				status: "completed",
				reconciled: [],
			});
			expect(invalidated).toMatchObject({ runId: delegatingRunId });
			expect(retried).toMatchObject({
				runId: operator.failedRunId,
				definitionName: "attempts",
			});
			expect(retried).not.toMatchObject({ status: "failed" });
			expect(resumed).toMatchObject({
				runId: operator.interruptedRunId,
				definitionName: "attempts",
			});
			expect(resumed).not.toMatchObject({ status: "interrupted" });
			runs = { runId, delegatingRunId, failedTaskId };
		});

		it("validates read tool results", async () => {
			const live = ready(service, "service");
			const { runId, delegatingRunId, failedTaskId } = ready(
				runs,
				"lifecycle runs",
			);
			const listed = checked(
				"workflow_list",
				await declaration("workflow_list").execute(live, {}),
			);
			const validated = checked(
				"workflow_validate",
				await declaration("workflow_validate").execute(live, {
					ref: "example",
					input: { value: "yes" },
				}),
			);
			checked(
				"workflow_status",
				await declaration("workflow_status").execute(live, { runId }),
			);
			const page = checked(
				"workflow_runs",
				await declaration("workflow_runs").execute(live, { limit: 10 }),
			) as WorkflowRunPage;
			const inspection = checked(
				"workflow_inspect",
				await declaration("workflow_inspect").execute(live, {
					runId: delegatingRunId,
					include: [
						"run",
						"budget",
						"tasks",
						"executions",
						"effects",
						"barriers",
						"artifacts",
					],
				}),
			) as WorkflowRunInspection;
			const logs = checked(
				"workflow_logs",
				await declaration("workflow_logs").execute(live, {
					runId: delegatingRunId,
					afterSequence: 0,
					limit: 100,
				}),
			) as WorkflowLogPage;
			expect(listed).toMatchObject([
				{ name: "delegating", scope: "project" },
				{ name: "example", scope: "project" },
				{ name: "gated", scope: "project" },
				{ name: "stoppable", scope: "project" },
			]);
			expect(validated).toMatchObject({
				valid: true,
				workflow: { name: "example" },
			});
			expect(page.total).toBe(4);
			expect(page.runs.map((run) => run.runId)).toContain(runId);
			expect(page.issues).toEqual([]);
			expect(inspection.run.runId).toBe(delegatingRunId);
			expect(inspection.tasks?.[0]).toMatchObject({
				id: failedTaskId,
				kind: "agent",
				role: "task",
				generation: 2,
			});
			expect(inspection.executions).toHaveLength(2);
			expect(logs.runId).toBe(delegatingRunId);
			expect(logs.entries.some((entry) => entry.kind === "invalidation")).toBe(
				true,
			);
		});

		it("validates the dynamic proposal result", async () => {
			const live = ready(service, "service");
			const proposed = checked(
				"workflow_propose",
				await declaration("workflow_propose").execute(live, {
					source: DYNAMIC_SOURCE,
				}),
			);
			// The proposal is pending and not runnable: proposing never approves.
			expect(proposed).toMatchObject({
				ref: DYNAMIC_REF,
				sourceBytes: Buffer.byteLength(DYNAMIC_SOURCE, "utf8"),
				manifest: { meta: { name: "proposed" } },
				proposer: { kind: "tool", via: "workflow_propose" },
				runnable: false,
			});
			expect(proposed).not.toHaveProperty("decision");
			expect((await live.proposals()).map((entry) => entry.ref)).toEqual([
				DYNAMIC_REF,
			]);
			await expect(live.validate(DYNAMIC_REF)).rejects.toMatchObject({
				code: "validation",
				message:
					"Dynamic workflow source is not approved for the current host API.",
			});
			const listed = checked(
				"workflow_list",
				await declaration("workflow_list").execute(live, {}),
			);
			expect(listed).not.toContainEqual(
				expect.objectContaining({ scope: "dynamic" }),
			);
			// Across the three sweeps, every declared tool had a real result checked.
			expect([...checkedResults.keys()].sort()).toEqual([...TOOL_NAMES].sort());
		});
	});

	describe("workflow_propose", () => {
		const tool = declaration("workflow_propose");

		it("carries the spec's description, guidelines, and output schema", () => {
			expect(tool.label).toBe("Propose Dynamic Workflow");
			expect(tool.description).toBe(
				"Propose dynamic workflow TypeScript source for human approval. Returns the proposal as dynamic:<sha256>; a human must approve it with /workflow approve before workflow_run or workflow_validate accept that reference. The model cannot approve.",
			);
			expect(tool.promptGuidelines).toEqual([
				"Author the source exactly like a static *.workflow.ts definition (workflow-authoring skill): default-export one defineWorkflow call; import only @vegardx/pi-workflow, typebox, and registered support modules.",
				"Never state or assume a proposal is approved; approval is a human decision outside the tool surface.",
			]);
			expect(tool.promptSnippet).toBeUndefined();
			expect(tool.output).toBe(DynamicWorkflowProposalViewSchema);
			expect(tool.output).toMatchObject({
				type: "object",
				additionalProperties: false,
			});
			expect(
				(tool.output as { properties: { ref: { pattern: string } } }).properties
					.ref.pattern,
			).toBe("^dynamic:[a-f0-9]{64}$");
			expect((tool.output as { required: string[] }).required.sort()).toEqual(
				[
					"definitionIdentitySha256",
					"hostApiSha256",
					"importPolicySha256",
					"manifest",
					"manifestSha256",
					"path",
					"proposedAt",
					"proposer",
					"ref",
					"runnable",
					"sourceBytes",
					"sourceSha256",
					"transformer",
				].sort(),
			);
			for (const tool of WORKFLOW_TOOL_DECLARATIONS) {
				if (tool.name === "workflow_validate" || tool.name === "workflow_run") {
					expect(tool.description).toMatch(
						/ Accepts dynamic:<sha256> for an approved dynamic workflow proposal\.$/,
					);
				} else {
					expect(tool.description).not.toContain("dynamic:<sha256> for");
				}
			}
		});

		it("proposes as the tool and never decides", async () => {
			const propose = vi.fn(async () => {
				throw new WorkflowServiceError(
					"conflict",
					"Dynamic workflow proposal store is full.",
				);
			});
			const decideSource = vi.fn();
			const service = { propose, decideSource } as unknown as WorkflowService;
			await expect(
				tool.execute(service, { source: DYNAMIC_SOURCE }),
			).rejects.toMatchObject({
				name: "WorkflowServiceError",
				code: "conflict",
				message: "Dynamic workflow proposal store is full.",
			});
			expect(propose).toHaveBeenCalledTimes(1);
			expect(propose).toHaveBeenCalledWith(DYNAMIC_SOURCE, {
				proposer: { kind: "tool", via: "workflow_propose" },
			});
			const [, options] = propose.mock.calls[0] as unknown as [
				string,
				{ proposer: unknown },
			];
			expect(Value.Check(DynamicWorkflowProposerSchema, options.proposer)).toBe(
				true,
			);
			expect(
				Value.Check(DynamicWorkflowProposerSchema, {
					kind: "model",
					via: "workflow_propose",
				}),
			).toBe(false);
			expect(decideSource).not.toHaveBeenCalled();
			// No tool declaration reaches the human decision surface at all.
			const module = await readFile(
				new URL("../src/tools.ts", import.meta.url),
				"utf8",
			);
			expect(module).not.toContain("decideSource");
			expect(module).not.toContain("inspectProposal");
			expect(module).not.toMatch(/workflow_(approve|reject|proposals)/);
			expect(WORKFLOW_TOOL_DECLARATIONS.map((tool) => tool.name)).not.toContain(
				expect.stringMatching(/approve|reject|proposals/),
			);
		});

		it("surfaces the service's validation refusals unchanged", async () => {
			const untrusted = await createWorkflowService({
				...(await fixture()),
				projectTrusted: () => false,
				subagents: provider(),
			});
			try {
				await expect(
					tool.execute(untrusted, { source: DYNAMIC_SOURCE }),
				).rejects.toMatchObject({
					name: "WorkflowServiceError",
					code: "validation",
					message: "Dynamic workflows require project trust.",
				});
			} finally {
				await untrusted.shutdown();
			}
			const service = await createWorkflowService({
				...(await fixture()),
				projectTrusted: () => true,
				subagents: provider(),
				// Source-mode workers boot slowly under full-suite load.
				dynamic: { bootTimeoutMs: 60_000 },
			});
			try {
				await expect(
					tool.execute(service, {
						source: `export const leak = 1;\n${DYNAMIC_SOURCE}`,
					}),
				).rejects.toMatchObject({
					name: "WorkflowServiceError",
					code: "validation",
					message:
						"dynamic workflow source must have exactly one default export and no named exports",
				});
				await expect(
					tool.execute(service, {
						source: `import fs from "node:fs";\n${DYNAMIC_SOURCE}`,
					}),
				).rejects.toMatchObject({
					name: "WorkflowServiceError",
					code: "validation",
					message: expect.stringContaining("node:fs"),
				});
				await expect(
					tool.execute(service, { source: "export default 1;\n" }),
				).rejects.toMatchObject({
					name: "WorkflowServiceError",
					code: "validation",
					message: expect.stringMatching(
						/^Dynamic workflow manifest extraction failed: /,
					),
				});
				await expect(service.proposals()).resolves.toEqual([]);
				// Idempotent: the same source proposed twice is one proposal.
				const first = await tool.execute(service, { source: DYNAMIC_SOURCE });
				const second = await tool.execute(service, { source: DYNAMIC_SOURCE });
				expect(second).toEqual(first);
				expect(JSON.parse(workflowToolText(tool, first))).toEqual(
					JSON.parse(JSON.stringify(first)),
				);
			} finally {
				await service.shutdown();
			}
		});
	});

	it("rejects run views that leave the declared shape", () => {
		const view = {
			runId: "workflow_abcdefghij",
			status: "completed",
			definitionName: "example",
			createdAt: "2026-09-15T00:00:00.000Z",
			deadlineAt: "2026-09-15T01:00:00.000Z",
			depth: 0,
			tasks: [],
		};
		expect(Value.Check(WorkflowServiceRunViewSchema, view)).toBe(true);
		expect(
			Value.Check(WorkflowServiceRunViewSchema, { ...view, extra: true }),
		).toBe(false);
		expect(
			Value.Check(WorkflowServiceRunViewSchema, { ...view, status: "done" }),
		).toBe(false);
		expect(
			Value.Check(WorkflowServiceRunViewSchema, {
				...view,
				tasks: [{ id: "task_x", key: "a" }],
			}),
		).toBe(false);
		const finalizer = {
			id: "task_abcdef",
			namespace: [],
			key: "cleanup",
			kind: "support",
			role: "finalizer",
			disposition: "required",
			status: "completed",
			generation: 1,
		};
		const { role: _role, ...roleless } = finalizer;
		expect(
			Value.Check(WorkflowServiceRunViewSchema, {
				...view,
				tasks: [finalizer],
			}),
		).toBe(true);
		expect(
			Value.Check(WorkflowServiceRunViewSchema, { ...view, tasks: [roleless] }),
		).toBe(false);
		expect(
			Value.Check(WorkflowServiceRunViewSchema, {
				...view,
				tasks: [{ ...finalizer, role: "cleanup" }],
			}),
		).toBe(false);
		expect(() =>
			workflowToolText(declaration("workflow_status"), {
				...view,
				extra: true,
			}),
		).toThrow("workflow tool output violates its schema");
	});

	describe("text bounding", () => {
		const createdAt = "2026-09-15T00:00:00.000Z";
		function summary(index: number) {
			return {
				runId: `workflow_${index.toString(36).padStart(12, "0")}`,
				definitionName: "example",
				status: "completed" as const,
				createdAt,
				updatedAt: createdAt,
				deadlineAt: "2026-09-15T01:00:00.000Z",
				depth: 0,
				lastSequence: 4,
				taskCounts: {
					pending: 0,
					ready: 0,
					running: 0,
					waiting: 0,
					completed: 0,
					failed: 0,
					interrupted: 0,
					blocked: 0,
					cancelling: 0,
					cancelled: 0,
					"cleanup-blocked": 0,
					invalidated: 0,
					abandoned: 0,
					total: 0,
				},
				ownership: "inactive" as const,
				leasedElsewhere: false,
				availableActions: [],
				requiresAttention: false,
				pendingCheckpointCount: 0,
			};
		}

		it("shrinks an oversized run page and re-cursors at the last kept run", () => {
			const runs = Array.from({ length: 100 }, (_, index) => summary(index));
			const page: WorkflowRunPage = {
				runs,
				total: 250,
				issues: [],
				issuesTruncated: 0,
				generatedAt: createdAt,
			};
			const text = workflowToolText(declaration("workflow_runs"), page);
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
				MAX_TOOL_OUTPUT_BYTES,
			);
			const bounded = JSON.parse(text) as WorkflowRunPage;
			expect(bounded.runs.length).toBeGreaterThan(0);
			expect(bounded.runs.length).toBeLessThan(runs.length);
			expect(bounded.runs).toEqual(runs.slice(0, bounded.runs.length));
			expect(bounded.total).toBe(250);
			const last = bounded.runs.at(-1);
			if (!last) throw new Error("no runs kept");
			expect(bounded.nextCursor).toBe(encodeWorkflowRunCursor(last));
			const small = { ...page, runs: runs.slice(0, 2) };
			expect(
				JSON.parse(workflowToolText(declaration("workflow_runs"), small)),
			).toEqual(small);
		});

		it("shrinks an oversized log page and re-cursors at the last kept sequence", () => {
			const entries = Array.from({ length: 500 }, (_, index) => ({
				sequence: index + 1,
				timestamp: createdAt,
				kind: "log" as const,
				message: "x".repeat(200),
			}));
			const page: WorkflowLogPage = {
				runId: "workflow_abcdefghij",
				entries,
				lastSequence: 900,
			};
			const text = workflowToolText(declaration("workflow_logs"), page);
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
				MAX_TOOL_OUTPUT_BYTES,
			);
			const bounded = JSON.parse(text) as WorkflowLogPage;
			expect(bounded.entries.length).toBeGreaterThan(0);
			expect(bounded.entries.length).toBeLessThan(entries.length);
			expect(bounded.entries).toEqual(entries.slice(0, bounded.entries.length));
			expect(bounded.nextAfterSequence).toBe(bounded.entries.at(-1)?.sequence);
			expect(bounded.lastSequence).toBe(900);
		});

		it("refuses an oversized inspection instead of cutting it", () => {
			const inspection: WorkflowRunInspection = {
				run: summary(1),
				effects: Array.from({ length: 256 }, (_, index) => ({
					ordinal: index + 1,
					kind: "log" as const,
					value: "y".repeat(400),
					sequence: index + 1,
				})),
				truncated: {},
			};
			expect(() =>
				workflowToolText(declaration("workflow_inspect"), inspection),
			).toThrow(
				"Workflow inspection exceeds the tool output bound; narrow include or pass taskId.",
			);
			const small = { ...inspection, effects: [] };
			expect(
				JSON.parse(workflowToolText(declaration("workflow_inspect"), small)),
			).toEqual(small);
		});

		it("omits an oversized run output and truncates the legacy list", () => {
			const view = {
				runId: "workflow_abcdefghij",
				status: "completed",
				definitionName: "example",
				createdAt,
				deadlineAt: "2026-09-15T01:00:00.000Z",
				depth: 0,
				output: { blob: "z".repeat(MAX_TOOL_OUTPUT_BYTES) },
				tasks: [],
			};
			const text = workflowToolText(declaration("workflow_status"), view);
			expect(text).toContain("[Workflow output omitted from tool context");
			expect(JSON.parse(text.split("\n\n")[0] ?? "")).toEqual({
				...view,
				output: undefined,
			});
			const list = Array.from({ length: 256 }, (_, index) => ({
				name: `workflow-${index}`,
				description: "d".repeat(1024),
				version: 1,
				concurrency: 4,
				budget: { cost: 1, childRuntimeMs: 60_000 },
				timeoutMs: 60_000,
				scope: "project" as const,
				source: "project",
				path: "/workflows/x.workflow.ts",
				identitySha256: "a".repeat(64),
			}));
			const listText = workflowToolText(declaration("workflow_list"), list);
			expect(Buffer.byteLength(listText)).toBeLessThanOrEqual(
				MAX_TOOL_OUTPUT_BYTES,
			);
			const bounded = JSON.parse(listText) as unknown[];
			expect(bounded.at(-1)).toEqual({ truncated: true, totalItems: 256 });
			expect(bounded.length).toBeLessThan(257);
		});
	});
});
