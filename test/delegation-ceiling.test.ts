import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DelegationCeiling, SubagentRequest } from "@vegardx/pi-subagent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CEILING_INVALID_MESSAGE,
	ceilingRefusalMessage,
	createWorkflowService,
	DEFAULT_WORKFLOW_NEEDS,
	needsFitCeiling,
	resolveWorkflowNeeds,
	WORKFLOW_CONTRACT_REVISION,
	WORKFLOW_RUNTIME_CONTRACT,
	WORKFLOW_TOOL_DECLARATIONS,
	type WorkflowService,
	WorkflowServiceError,
} from "../src/index.js";
import { WorkflowRunRecordSchema } from "../src/run-record.js";
import { acquireWorkflowService } from "../src/service-provider.js";
import { attemptProvider } from "./fixtures/attempt-provider.js";

// The host's mode bounds every delegation a run makes. Every expectation below
// is the owner's rule, not the implementation's: a definition declares what it
// NEEDS in pi-subagent's own vocabulary, a start above the host's ceiling is
// refused before a run exists, the run records the ceiling it started with, and
// every request it makes carries it so pi-subagent's preflight is the one that
// refuses a launch.

const BUILTIN_ROOT = fileURLToPath(new URL("../workflows", import.meta.url));

const bases: string[] = [];
const services: WorkflowService[] = [];

afterEach(async () => {
	for (const service of services.splice(0)) await service.shutdown();
	for (const base of bases.splice(0)) {
		await rm(base, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

/** A read-only agent task, so a `read-only` ceiling admits the whole graph. */
const READ_ONLY_DEFINITION = (needs?: string) => `export default {
  schema: "pi-workflow-definition",
  meta: {
    name: "read-only-example",
    description: "One read-only agent task.",
    version: 1,
    budget: { cost: 100, childRuntimeMs: 600000 },
    timeoutMs: 600000,
    concurrency: 1${needs ? `,\n    needs: { workspace: ${JSON.stringify(needs)} }` : ""}
  },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  async run(ctx) {
    const task = ctx.agent("answer", {
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
    return await ctx.result(task);
  }
};
`;

interface Fixture {
	readonly service: WorkflowService;
	readonly storeRoot: string;
	readonly requests: readonly SubagentRequest[];
}

async function fixture(
	options: {
		readonly needs?: string;
		readonly declareNeeds?: boolean;
		readonly ceiling?: () => DelegationCeiling | undefined;
	} = {},
): Promise<Fixture> {
	const base = await mkdtemp(path.join(os.tmpdir(), "pi-workflow-ceiling-"));
	bases.push(base);
	const cwd = path.join(base, "project");
	await mkdir(path.join(cwd, "workflows"), { recursive: true });
	await writeFile(
		path.join(cwd, "workflows", "read-only.workflow.ts"),
		READ_ONLY_DEFINITION(
			options.declareNeeds === false
				? undefined
				: (options.needs ?? "read-only"),
		),
	);
	const delegated = attemptProvider([{ status: "completed" }]);
	const storeRoot = path.join(cwd, "state");
	const service = await createWorkflowService({
		cwd,
		agentDir: path.join(base, "agent"),
		storeRoot,
		projectTrusted: () => true,
		subagents: delegated.provider,
		registeredRoots: [
			{ path: BUILTIN_ROOT, scope: "builtin", source: "package" },
		],
		...(options.ceiling ? { delegationCeiling: options.ceiling } : {}),
	});
	services.push(service);
	const preflight = delegated.ownerClient.preflight as unknown as {
		mock: { calls: readonly [SubagentRequest][] };
	};
	return {
		service,
		storeRoot,
		get requests() {
			return preflight.mock.calls.map(([request]) => request);
		},
	};
}

function declaration(name: string) {
	const found = WORKFLOW_TOOL_DECLARATIONS.find((tool) => tool.name === name);
	if (!found) throw new Error(`no tool ${name}`);
	return found;
}

const READ_ONLY: DelegationCeiling = Object.freeze({
	workspaceModes: ["read-only"],
});

describe("what a definition needs", () => {
	it("reports the builtins' own declarations through list and validate", async () => {
		const { service } = await fixture();
		const byName = new Map(
			(await service.list()).map((summary) => [summary.name, summary.needs]),
		);
		// The three the package ships: the pipeline that writes needs a worktree;
		// the two reviewers do not.
		expect(byName.get("plan-to-ship")).toEqual({
			workspace: "worktree",
			declared: true,
		});
		expect(byName.get("deep-review")).toEqual({
			workspace: "read-only",
			declared: true,
		});
		expect(byName.get("deep-research")).toEqual({
			workspace: "read-only",
			declared: true,
		});
		await expect(service.validate("plan-to-ship")).resolves.toMatchObject({
			workflow: { needs: { workspace: "worktree", declared: true } },
		});
	});

	it("reads silence as needing a worktree, and says the reading is not the definition's", async () => {
		// The conservative reading: a definition that writes and says nothing must
		// not slip under a read-only ceiling. `declared: false` is what tells a
		// reader this was an assumption.
		const { service } = await fixture({ declareNeeds: false });
		const validated = await service.validate("read-only-example");
		expect(validated.workflow.needs).toEqual({
			workspace: "worktree",
			declared: false,
		});
		expect(DEFAULT_WORKFLOW_NEEDS).toEqual({ workspace: "worktree" });
		expect(resolveWorkflowNeeds({})).toEqual({
			workspace: "worktree",
			declared: false,
		});
		// And `workflow_validate` says so in the line a person reads.
		expect(declaration("workflow_validate").summarizeResult(validated)).toBe(
			"valid: read-only-example v1; needs a worktree workspace (assumed: the definition declares no needs)",
		);
	});

	it("says what a declared need is, without the assumption", async () => {
		const { service } = await fixture({ needs: "read-only" });
		const validated = await service.validate("read-only-example");
		expect(declaration("workflow_validate").summarizeResult(validated)).toBe(
			"valid: read-only-example v1; needs a read-only workspace",
		);
	});

	it("compares only the workspace axis, because that is the only one it states", () => {
		expect(needsFitCeiling("read-only", READ_ONLY)).toBe(true);
		expect(needsFitCeiling("worktree", READ_ONLY)).toBe(false);
		expect(needsFitCeiling("worktree", { workspaceModes: ["worktree"] })).toBe(
			true,
		);
		// No bound at all, and a bound on tools only, admit everything.
		expect(needsFitCeiling("worktree", undefined)).toBe(true);
		expect(needsFitCeiling("worktree", { tools: ["read"] })).toBe(true);
	});
});

describe("workflow_run under the host's ceiling", () => {
	it("refuses a definition whose needs exceed the ceiling, before any run exists", async () => {
		const { service, storeRoot } = await fixture({
			needs: "worktree",
			ceiling: () => READ_ONLY,
		});
		const error = await declaration("workflow_run")
			.execute(service, { ref: "read-only-example", input: {} })
			.catch((value: unknown) => value);
		expect(error).toBeInstanceOf(WorkflowServiceError);
		expect((error as WorkflowServiceError).code).toBe("validation");
		expect((error as Error).message).toBe(
			"read-only-example needs a worktree workspace; the host ceiling allows read-only.",
		);
		expect((error as Error).message).toBe(
			ceilingRefusalMessage("read-only-example", "worktree", READ_ONLY),
		);
		// Nothing durable happened: no run, and no directory under the store.
		await expect(service.listRuns()).resolves.toMatchObject({ total: 0 });
		await expect(
			rm(path.join(storeRoot, "runs"), { recursive: true }),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses a definition that declared nothing under a read-only ceiling", async () => {
		// Silence reads as `worktree`, so the conservative reading is what refuses.
		const { service } = await fixture({
			declareNeeds: false,
			ceiling: () => READ_ONLY,
		});
		await expect(
			declaration("workflow_run").execute(service, {
				ref: "read-only-example",
				input: {},
			}),
		).rejects.toThrow(
			"read-only-example needs a worktree workspace; the host ceiling allows read-only.",
		);
	});

	it("starts, records the ceiling, and carries it on every request", async () => {
		const harness = await fixture({
			needs: "read-only",
			ceiling: () => READ_ONLY,
		});
		const receipt = (await declaration("workflow_run").execute(
			harness.service,
			{ ref: "read-only-example", input: {} },
		)) as { runId: string };
		await harness.service.wait(receipt.runId as never, { timeoutMs: 30_000 });
		expect(harness.requests).toHaveLength(1);
		expect(harness.requests[0]?.ceiling).toEqual({
			workspaceModes: ["read-only"],
		});
	});

	it("passes no ceiling when no provider is installed", async () => {
		const harness = await fixture({ needs: "read-only" });
		expect(harness.service.hostDelegationCeiling()).toBeUndefined();
		const receipt = (await declaration("workflow_run").execute(
			harness.service,
			{ ref: "read-only-example", input: {} },
		)) as { runId: string };
		await harness.service.wait(receipt.runId as never, { timeoutMs: 30_000 });
		// A run with no ceiling behaves exactly as before: the field is absent
		// from the request rather than present and empty.
		expect(harness.requests).toHaveLength(1);
		expect("ceiling" in (harness.requests[0] ?? {})).toBe(false);
	});

	it("refuses a ceiling that is not a ceiling rather than launching unbounded", async () => {
		const { service } = await fixture({
			ceiling: () => ({ workspaceModes: [] }) as unknown as DelegationCeiling,
		});
		expect(() => service.hostDelegationCeiling()).toThrow(
			CEILING_INVALID_MESSAGE,
		);
	});
});

describe("startBuiltin under an explicit ceiling", () => {
	/** The provider seam, over a service that starts `plan-to-ship` for real. */
	async function client(ceiling?: () => DelegationCeiling | undefined) {
		const harness = await fixture(ceiling ? { ceiling } : {});
		const events = {
			listeners: new Map<string, ((value: unknown) => void)[]>(),
			on(channel: string, listener: (value: unknown) => void) {
				const list = this.listeners.get(channel) ?? [];
				list.push(listener);
				this.listeners.set(channel, list);
				return () => undefined;
			},
			emit(channel: string, value: unknown) {
				for (const listener of this.listeners.get(channel) ?? []) {
					listener(value);
				}
			},
		};
		const { registerWorkflowServiceProvider } = await import(
			"../src/service-provider.js"
		);
		registerWorkflowServiceProvider(
			events as never,
			async () => harness.service,
		);
		return {
			harness,
			read: await acquireWorkflowService(events as never, {} as never),
		};
	}

	function planInput() {
		return {
			plan: {
				slug: "sample-plan",
				title: "Sample plan",
				repos: [{ key: "main", path: "/repo" }],
				deliverables: [
					{
						id: "d0",
						title: "Deliverable 0",
						after: [],
						reads: [],
						tasks: [{ id: "w0", title: "Write the code" }],
						reviews: [],
					},
				],
			},
			planDigest: "a".repeat(64),
			effort: "cheap",
		};
	}

	it("refuses the start when the plan's needs exceed the ceiling it was given", async () => {
		const { read } = await client();
		const error = await read
			.startBuiltin("plan-to-ship", {
				input: planInput(),
				ceiling: READ_ONLY,
			})
			.catch((value: unknown) => value);
		expect(error).toBeInstanceOf(WorkflowServiceError);
		expect((error as Error).message).toBe(
			"plan-to-ship needs a worktree workspace; the host ceiling allows read-only.",
		);
	});

	it("records the explicit ceiling and forwards it into every request", async () => {
		const worktreeOnly: DelegationCeiling = { workspaceModes: ["worktree"] };
		const { harness, read } = await client();
		const { runId } = await read.startBuiltin("plan-to-ship", {
			input: planInput(),
			ceiling: worktreeOnly,
		});
		// The first task is declared at once, so one request is enough to prove
		// the run carries the bound; the run is not driven to completion here.
		await read.awaitRun(runId, { timeoutMs: 30_000 }).catch(() => undefined);
		expect(harness.requests.length).toBeGreaterThan(0);
		for (const request of harness.requests) {
			expect(request.ceiling).toEqual(worktreeOnly);
		}
	});

	it("does not read the host's provider: the host is switching modes", async () => {
		// `hostCeiling` exists so a host can SHOW the bound, and `startBuiltin`
		// takes its own, because the provider still answers for the mode the host
		// is leaving.
		const { harness, read } = await client(() => READ_ONLY);
		expect(read.hostCeiling()).toEqual(READ_ONLY);
		const { runId } = await read.startBuiltin("plan-to-ship", {
			input: planInput(),
		});
		await read.awaitRun(runId, { timeoutMs: 30_000 }).catch(() => undefined);
		// No ceiling was passed, so none was applied - the read-only provider did
		// not silently bound a run it was never asked about.
		expect(harness.requests.length).toBeGreaterThan(0);
		for (const request of harness.requests) {
			expect("ceiling" in request).toBe(false);
		}
	});
});

describe("the contract revision", () => {
	it("is 21, and the run record carries an optional ceiling", () => {
		expect(WORKFLOW_CONTRACT_REVISION).toBe(21);
		expect(WORKFLOW_RUNTIME_CONTRACT.contractRevision).toBe(21);
		// The persisted field the revision moved for.
		expect(Object.keys(WorkflowRunRecordSchema.properties)).toContain(
			"ceiling",
		);
	});

	it("requires pi-subagent revision 8 with the delegation ceiling", () => {
		expect(WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.contractRevision).toBe(8);
		expect(
			WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.features.delegationCeiling,
		).toBe(true);
	});
});
