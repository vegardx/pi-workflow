import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createEventBus,
	type EventBus,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentLaunchPlan,
	canonicalSha256,
	SUBAGENT_RUNTIME_CONTRACT,
	type SubagentClient,
	type SubagentRequest,
} from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	WORKFLOW_RUNTIME_CONTRACT,
	type WorkflowRunId,
} from "../src/contracts.js";
import { defineWorkflow, type WorkflowDefinition } from "../src/definition.js";
import { readWorkflowJournalUnleased } from "../src/persistence/journal.js";
import {
	createWorkflowService,
	type WorkflowService,
	WorkflowServiceError,
} from "../src/service.js";
import {
	acquireWorkflowService,
	BUILTIN_STARTABLE_WORKFLOWS,
	createWorkflowReadClient,
	foreignRunRefusalMessage,
	headlessBuiltinViolations,
	isCompatibleWorkflowProvider,
	registerWorkflowServiceProvider,
	START_EFFORT_REFUSAL_MESSAGE,
	startableRefusalMessage,
	WORKFLOW_SERVICE_FAILURE_MESSAGE,
	type WorkflowReadClient,
	type WorkflowRunObservation,
	WorkflowServiceProviderError,
} from "../src/service-provider.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";

// W1-PROVIDER (spec 2.4, D2, D3): the seam pi-maestro acquires the runtime
// through. Every expectation below is the spec's, not the implementation's:
// the channel, the four provider error codes, the narrowed operation list,
// the error mapping, the runtime-owned startable allowlist and the structural
// property that makes it the opposite of a run nobody is asked about, and the
// lease-free projection.

const BUILTIN_ROOT = fileURLToPath(new URL("../workflows", import.meta.url));
const CONTEXT = {} as ExtensionContext;

const bases: string[] = [];
const services: WorkflowService[] = [];
/** Where `realService` put each service's durable state, for journal reads. */
const storeRoots = new WeakMap<WorkflowService, string>();

afterEach(async () => {
	for (const service of services.splice(0)) await service.shutdown();
	for (const base of bases.splice(0)) {
		await rm(base, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

/**
 * A service double: every method throws unless the case under test replaced
 * it, so a client operation that reached the wrong method fails loudly.
 */
function serviceDouble(
	overrides: Partial<WorkflowService> = {},
): WorkflowService {
	const unexpected = (name: string) => () => {
		throw new Error(`unexpected service call: ${name}`);
	};
	const names = [
		"registerRoot",
		"list",
		"validate",
		"project",
		"run",
		"status",
		"wait",
		"stop",
		"decide",
		"invalidate",
		"reconcile",
		"exportHandoff",
		"retry",
		"resume",
		"shutdown",
		"propose",
		"inspectProposal",
		"proposals",
		"decideSource",
		"listRuns",
		"inspect",
		"logs",
		"previewInvalidation",
		"subscribe",
	] as const;
	const service = Object.fromEntries(
		names.map((name) => [name, unexpected(name)]),
	) as unknown as WorkflowService;
	return Object.assign(service, overrides);
}

/** Registers a provider that hands back `service`, and acquires the client. */
async function acquire(
	service: WorkflowService,
): Promise<{ events: EventBus; client: WorkflowReadClient }> {
	const events = createEventBus();
	registerWorkflowServiceProvider(events, async () => service);
	return { events, client: await acquireWorkflowService(events, CONTEXT) };
}

async function realService(
	override?: WorkflowSubagentProvider,
): Promise<WorkflowService> {
	const base = await mkdtemp(path.join(os.tmpdir(), "pi-workflow-provider-"));
	bases.push(base);
	const cwd = path.join(base, "project");
	await mkdir(cwd, { recursive: true });
	const subagents: WorkflowSubagentProvider = override ?? {
		bind: async () => {
			throw new Error("the projection must never bind a subagent");
		},
	};
	const storeRoot = path.join(cwd, "state");
	const service = await createWorkflowService({
		cwd,
		agentDir: path.join(base, "agent"),
		storeRoot,
		projectTrusted: () => false,
		subagents,
		registeredRoots: [
			{ path: BUILTIN_ROOT, scope: "builtin", source: "package" },
		],
	});
	services.push(service);
	storeRoots.set(service, storeRoot);
	return service;
}

/** The store root `realService` gave this service. */
function storeRootOf(service: WorkflowService): string {
	const root = storeRoots.get(service);
	if (!root) throw new Error("service was not created by realService");
	return root;
}

/**
 * A project-scope definition whose whole graph is one fan-out, so a projection
 * is a function of the input's length alone: the smallest thing that can
 * over-run a small `meta.budget`.
 */
const FAN_OUT_DEFINITION = `export default {
  schema: "pi-workflow-definition",
  meta: { name: "fan-out-example", description: "One fan-out over the input.", version: 1, budget: { cost: 10, totalTokens: 200000, childRuntimeMs: 900000 }, timeoutMs: 900000, concurrency: 2 },
  inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"], additionalProperties: false },
  outputSchema: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"], additionalProperties: false },
  run(ctx) {
    ctx.fanOut("work", ctx.input.items, {
      key: (_item, index) => "w-" + index,
      task: () => ({
        agent: "reviewer",
        task: { goal: "Review", context: [], instructions: [] },
        contextMode: "fresh",
        tools: ["read"],
        preloadSkills: [],
        contextScopes: [],
        workspace: { mode: "read-only", cwd: ctx.cwd },
        outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
        limits: { cumulativeRuntimeMs: 300000, attemptTimeoutMs: 300000, totalTokens: 100000, cost: 5, outputBytes: 65536, workspaceWriteBytes: 0, retries: 0, resumes: 0 },
      }),
    });
    return { done: true };
  },
};
`;

/** A service over a project root carrying `FAN_OUT_DEFINITION`. */
async function fanOutService(): Promise<WorkflowService> {
	const base = await mkdtemp(path.join(os.tmpdir(), "pi-workflow-fanout-"));
	bases.push(base);
	const cwd = path.join(base, "project");
	await mkdir(path.join(cwd, "workflows"), { recursive: true });
	await writeFile(
		path.join(cwd, "workflows", "fan-out.workflow.ts"),
		FAN_OUT_DEFINITION,
	);
	const service = await createWorkflowService({
		cwd,
		agentDir: path.join(base, "agent"),
		storeRoot: path.join(cwd, "state"),
		projectTrusted: () => true,
		subagents: {
			bind: async () => {
				throw new Error("the projection must never bind a subagent");
			},
		},
	});
	services.push(service);
	return service;
}

/**
 * The smallest shape pi-maestro publishes from: one `ship` gate and a receipt
 * naming the plan digest it was approved against.
 */
const PLAN_DIGEST = "9".repeat(64);
const SHIP_DEFINITION = `export default {
  schema: "pi-workflow-definition",
  meta: { name: "ship-example", description: "One ship gate and a receipt.", version: 1, budget: { cost: 10, childRuntimeMs: 600000 }, timeoutMs: 600000, concurrency: 1 },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: { receipt: { type: "object", properties: { planDigest: { type: "string" } }, required: ["planDigest"], additionalProperties: false } }, required: ["receipt"], additionalProperties: false },
  async run(ctx) {
    const gate = ctx.checkpoint("ship", {
      schema: { type: "object", properties: { ship: { type: "boolean" } }, required: ["ship"], additionalProperties: false },
      prompt: "Ship the approved plan?",
      headless: "block",
      timeoutMs: 600000,
    });
    const decision = await ctx.result(gate);
    if (!decision.ship) throw new Error("not shipped");
    return { receipt: { planDigest: ${JSON.stringify(PLAN_DIGEST)} } };
  },
};
`;

/** A service over a project root carrying `SHIP_DEFINITION`. */
async function shipService(): Promise<WorkflowService> {
	const base = await mkdtemp(path.join(os.tmpdir(), "pi-workflow-ship-"));
	bases.push(base);
	const cwd = path.join(base, "project");
	await mkdir(path.join(cwd, "workflows"), { recursive: true });
	await writeFile(
		path.join(cwd, "workflows", "ship.workflow.ts"),
		SHIP_DEFINITION,
	);
	const service = await createWorkflowService({
		cwd,
		agentDir: path.join(base, "agent"),
		storeRoot: path.join(cwd, "state"),
		projectTrusted: () => true,
		subagents: {
			// A checkpoint workflow launches nothing, so a binding whose every
			// call throws proves no agent task was ever reached.
			bind: async (runId) => ({
				workflowRunId: runId,
				ownerId: `pi-workflow:${runId}`,
				client: new Proxy(
					{},
					{
						get: () => () => {
							throw new Error("unexpected subagent call");
						},
					},
				) as never,
			}),
		},
	});
	services.push(service);
	return service;
}

function plan(deliverables: number, lenses: readonly string[] = ["contracts"]) {
	return {
		slug: "sample-plan",
		title: "Sample plan",
		repos: [{ key: "main", path: "/repo" }],
		deliverables: Array.from({ length: deliverables }, (_unused, index) => ({
			id: `d${index}`,
			title: `Deliverable ${index}`,
			after: [],
			reads: [],
			tasks: [{ id: `w${index}`, title: "Write the code" }],
			reviews: lenses.map((lens) => ({ lens })),
		})),
	};
}

function planInput(deliverables = 1, effort = "standard") {
	return { plan: plan(deliverables), planDigest: "a".repeat(64), effort };
}

describe("registration and discovery", () => {
	it("answers the versioned request channel with a frozen provider", async () => {
		const events = createEventBus();
		registerWorkflowServiceProvider(events, async () => serviceDouble());
		const providers: unknown[] = [];
		events.emit("@vegardx/pi-workflow/service-provider/request/v1", {
			schema: "pi-workflow-service-request-v1",
			respond: (provider: unknown) => providers.push(provider),
		});
		expect(providers).toHaveLength(1);
		expect(Object.isFrozen(providers[0])).toBe(true);
		expect(isCompatibleWorkflowProvider(providers[0])).toBe(true);
		expect((providers[0] as { contract: unknown }).contract).toBe(
			WORKFLOW_RUNTIME_CONTRACT,
		);
	});

	it("ignores a malformed request rather than responding to it", () => {
		const events = createEventBus();
		registerWorkflowServiceProvider(events, async () => serviceDouble());
		const providers: unknown[] = [];
		const respond = (provider: unknown) => providers.push(provider);
		events.emit("@vegardx/pi-workflow/service-provider/request/v1", {
			schema: "pi-subagent-service-request-v1",
			respond,
		});
		events.emit("@vegardx/pi-workflow/service-provider/request/v1", {
			schema: "pi-workflow-service-request-v1",
		});
		events.emit("@vegardx/pi-workflow/service-provider/request/v1", null);
		expect(providers).toEqual([]);
	});

	it("stops answering once the registration is disposed", async () => {
		const events = createEventBus();
		const dispose = registerWorkflowServiceProvider(events, async () =>
			serviceDouble(),
		);
		dispose();
		await expect(acquireWorkflowService(events, CONTEXT)).rejects.toMatchObject(
			{ name: "WorkflowServiceProviderError", code: "missing" },
		);
	});

	it("exposes exactly the spec's narrowed operations", async () => {
		const { client } = await acquire(serviceDouble());
		expect(Object.keys(client).sort()).toEqual([
			"awaitRun",
			"inspect",
			"list",
			"observe",
			"project",
			"runs",
			"startBuiltin",
			"validate",
		]);
		expect(Object.isFrozen(client)).toBe(true);
	});
});

describe("compatibility", () => {
	it("refuses a missing provider", async () => {
		const events = createEventBus();
		await expect(acquireWorkflowService(events, CONTEXT)).rejects.toMatchObject(
			{ code: "missing" },
		);
	});

	it("refuses two registered providers", async () => {
		const events = createEventBus();
		registerWorkflowServiceProvider(events, async () => serviceDouble());
		registerWorkflowServiceProvider(events, async () => serviceDouble());
		await expect(acquireWorkflowService(events, CONTEXT)).rejects.toMatchObject(
			{ code: "duplicate" },
		);
	});

	it.each([
		[
			"a flipped feature",
			{
				...WORKFLOW_RUNTIME_CONTRACT,
				features: { ...WORKFLOW_RUNTIME_CONTRACT.features, worktrees: false },
			},
		],
		[
			"a bumped revision",
			{
				...WORKFLOW_RUNTIME_CONTRACT,
				contractRevision: WORKFLOW_RUNTIME_CONTRACT.contractRevision + 1,
			},
		],
		[
			"a different required pi-subagent revision",
			{
				...WORKFLOW_RUNTIME_CONTRACT,
				requiredSubagent: {
					...WORKFLOW_RUNTIME_CONTRACT.requiredSubagent,
					contractRevision:
						WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.contractRevision + 1,
				},
			},
		],
		[
			"a flipped required pi-subagent feature",
			{
				...WORKFLOW_RUNTIME_CONTRACT,
				requiredSubagent: {
					...WORKFLOW_RUNTIME_CONTRACT.requiredSubagent,
					features: {
						...WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.features,
						handoffExport: false,
					},
				},
			},
		],
	])("refuses %s", async (_label, contract) => {
		const events = createEventBus();
		events.on("@vegardx/pi-workflow/service-provider/request/v1", (value) =>
			(value as { respond(provider: unknown): void }).respond(
				Object.freeze({ contract, acquire: async () => undefined }),
			),
		);
		expect(
			isCompatibleWorkflowProvider({ contract, acquire: () => undefined }),
		).toBe(false);
		await expect(acquireWorkflowService(events, CONTEXT)).rejects.toMatchObject(
			{ code: "incompatible" },
		);
	});

	it("refuses a provider without an acquire function", () => {
		expect(
			isCompatibleWorkflowProvider({
				contract: WORKFLOW_RUNTIME_CONTRACT,
				acquire: "not a function",
			}),
		).toBe(false);
		expect(isCompatibleWorkflowProvider(null)).toBe(false);
		expect(isCompatibleWorkflowProvider({ acquire: () => undefined })).toBe(
			false,
		);
	});

	it("refuses a provider replaced during acquisition", async () => {
		const first = Object.freeze({
			contract: WORKFLOW_RUNTIME_CONTRACT,
			acquire: async () => createWorkflowReadClient(serviceDouble()),
		});
		const second = Object.freeze({
			contract: WORKFLOW_RUNTIME_CONTRACT,
			acquire: async () => createWorkflowReadClient(serviceDouble()),
		});
		let current: unknown = first;
		const events: EventBus = {
			emit(_channel, data) {
				(data as { respond(provider: unknown): void }).respond(current);
				current = second;
			},
			on: () => () => undefined,
		};
		await expect(acquireWorkflowService(events, CONTEXT)).rejects.toMatchObject(
			{ name: "WorkflowServiceProviderError", code: "replaced" },
		);
	});

	it("names every provider error code the consumer must map", () => {
		for (const code of [
			"missing",
			"duplicate",
			"incompatible",
			"replaced",
		] as const) {
			const error = new WorkflowServiceProviderError(code, "why");
			expect(error.code).toBe(code);
			expect(error.name).toBe("WorkflowServiceProviderError");
		}
	});
});

describe("delegation and error mapping", () => {
	it("delegates each read operation to the service", async () => {
		const list = vi.fn(async () => ["summary"]);
		const validate = vi.fn(async () => ({ valid: true }));
		const project = vi.fn(async () => ({ fits: true }));
		const inspect = vi.fn(async () => ({ run: "view" }));
		const listRuns = vi.fn(async () => ({ runs: [] }));
		const { client } = await acquire(
			serviceDouble({
				list,
				validate,
				project,
				inspect,
				listRuns,
			} as unknown as Partial<WorkflowService>),
		);
		await expect(client.list()).resolves.toEqual(["summary"]);
		await expect(client.validate("w", { a: 1 })).resolves.toEqual({
			valid: true,
		});
		expect(validate).toHaveBeenCalledWith("w", { a: 1 });
		await expect(client.project("w", { a: 1 })).resolves.toEqual({
			fits: true,
		});
		expect(project).toHaveBeenCalledWith("w", { a: 1 });
		await expect(
			client.inspect("workflow_1" as WorkflowRunId, { include: ["run"] }),
		).resolves.toEqual({ run: "view" });
		expect(inspect).toHaveBeenCalledWith("workflow_1", { include: ["run"] });
		await expect(client.runs({ limit: 5 })).resolves.toEqual({ runs: [] });
		expect(listRuns).toHaveBeenCalledWith({ limit: 5 });
		expect(list).toHaveBeenCalledTimes(1);
	});

	it("passes a WorkflowServiceError through unchanged", async () => {
		const failure = new WorkflowServiceError("not-found", "no such run");
		const { client } = await acquire(
			serviceDouble({
				inspect: async () => {
					throw failure;
				},
			} as unknown as Partial<WorkflowService>),
		);
		await expect(client.inspect("workflow_1" as WorkflowRunId)).rejects.toBe(
			failure,
		);
	});

	it("maps every other failure to one fixed message", async () => {
		const cause = new Error(
			"ENOENT: /home/someone/.pi/agent/workflow/--repo--/runs",
		);
		const { client } = await acquire(
			serviceDouble({
				list: async () => {
					throw cause;
				},
			} as unknown as Partial<WorkflowService>),
		);
		const error = await client.list().catch((value: unknown) => value);
		expect(error).toBeInstanceOf(WorkflowServiceError);
		expect((error as WorkflowServiceError).code).toBe("execution");
		expect((error as Error).message).toBe(WORKFLOW_SERVICE_FAILURE_MESSAGE);
		expect((error as Error).cause).toBe(cause);
	});

	it("carries a fixed cause message alongside the fixed message", async () => {
		const cause = new Error(
			"Failed to acquire the shared pi-subagent service: run record uses contract revision 6; expected 7. Discard incompatible persisted state before continuing.",
		);
		cause.name = "WorkflowSubagentProviderError";
		const { client } = await acquire(
			serviceDouble({
				list: async () => {
					throw cause;
				},
			} as unknown as Partial<WorkflowService>),
		);

		const error = await client.list().catch((value: unknown) => value);

		expect((error as WorkflowServiceError).code).toBe("execution");
		expect((error as Error).message).toBe(
			`The workflow service could not complete the request: ${cause.message}`,
		);
		expect((error as Error).cause).toBe(cause);
	});

	it("observes through subscribe and unsubscribes", async () => {
		const unsubscribe = vi.fn();
		const subscribe = vi.fn(() => unsubscribe);
		const { client } = await acquire(
			serviceDouble({ subscribe } as unknown as Partial<WorkflowService>),
		);
		const listener = vi.fn();
		const stop = client.observe(listener);
		expect(subscribe).toHaveBeenCalledWith(listener);
		stop();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it("maps a subscribe failure like every other one", async () => {
		const { client } = await acquire(
			serviceDouble({
				subscribe: () => {
					throw new Error("bus closed");
				},
			} as unknown as Partial<WorkflowService>),
		);
		expect(() => client.observe(() => undefined)).toThrow(
			WORKFLOW_SERVICE_FAILURE_MESSAGE,
		);
	});
});

describe("awaitRun", () => {
	it("refuses awaitRun on a run this client did not start", async () => {
		const { client } = await acquire(serviceDouble());
		const error = await client
			.awaitRun("workflow_foreign" as WorkflowRunId)
			.catch((value: unknown) => value);
		expect(error).toBeInstanceOf(WorkflowServiceError);
		expect((error as WorkflowServiceError).code).toBe("validation");
		expect((error as Error).message).toBe(
			foreignRunRefusalMessage("workflow_foreign"),
		);
	});
});

const SUBAGENT_CLIENT_METHODS = [
	"preflight",
	"launch",
	"findByOperation",
	"status",
	"listRuns",
	"logs",
	"wait",
	"interrupt",
	"steer",
	"followUp",
	"retry",
	"resume",
	"reconcile",
	"release",
	"abandon",
	"pin",
	"unpin",
	"exportArtifact",
	"exportHandoff",
] as const;

/**
 * A subagent provider that answers `plan-to-ship`'s refiner and nothing else.
 * The start of a run IS its approval, so there is no gate before the work: the
 * run refines the plan and goes straight on to the first implementer, which
 * this provider has no script for. That is as far as this file needs to look
 * to see that `startBuiltin` made an ordinary run that begins working at once.
 */
function scriptedPlanner(): WorkflowSubagentProvider {
	const nonce = randomUUID().replaceAll("-", "").slice(0, 8);
	const pending = new Map<
		string,
		{ runId: string; attemptId: string; request: SubagentRequest }
	>();
	const children = new Map<
		string,
		{ runId: string; attemptId: string; request: SubagentRequest }
	>();
	let preflights = 0;
	let ownerId = "";

	const methods: Record<string, unknown> = {};
	for (const method of SUBAGENT_CLIENT_METHODS) {
		methods[method] = vi.fn(async () => {
			throw new Error(`unexpected subagent call: ${method}`);
		});
	}

	methods.preflight = vi.fn(async (request: SubagentRequest) => {
		preflights += 1;
		const preflightId = `preflight-${nonce}-${preflights}`;
		const runId = `run_child${nonce}${preflights}`;
		const attemptId = `attempt_child${nonce}${preflights}`;
		pending.set(preflightId, { runId, attemptId, request });
		const launchPlan = {
			schema: "pi-subagent-launch" as const,
			contractRevision: SUBAGENT_RUNTIME_CONTRACT.contractRevision,
			operationId: request.operationId,
			ownerId,
			runId,
			attemptId,
			agent: request.agent,
			agentDisplayName: request.agent,
			agentPrompt: "prompt",
			agentSource: "/agent.md",
			agentSha256: "a".repeat(64),
			agentScope: "global" as const,
			task: structuredClone(request.task),
			contextMode: request.contextMode,
			model: request.model ?? {
				provider: "test",
				id: "model",
				thinking: "low" as const,
			},
			cwd: "/workspace" as const,
			tools: [...request.tools],
			preloadSkills: [...request.preloadSkills],
			contextScopes: [...request.contextScopes],
			resources: [
				{
					kind: "agent" as const,
					name: request.agent,
					source: "/agent.md",
					sha256: "a".repeat(64),
				},
			],
			workspace: {
				mode: request.workspace.mode,
				hostPathSha256: "a".repeat(64),
				baselineSha256: "c".repeat(64),
			},
			sandbox: {
				backend: "gondolin" as const,
				packageVersion: "0.12.0",
				imageSha256: "a".repeat(64),
				mountPolicySha256: "a".repeat(64),
				networkPolicySha256: "a".repeat(64),
				capacityPolicySha256: "a".repeat(64),
				memoryBytes: request.memoryBytes ?? 536_870_912,
				guestDiskBytes: 1024,
				workspaceWriteBytes: request.limits.workspaceWriteBytes,
			},
			network: {
				mode: "public-egress" as const,
				blockInternalRanges: true as const,
			},
			outputSchema: structuredClone(request.outputSchema),
			limits: structuredClone(request.limits),
		} satisfies Omit<AgentLaunchPlan, "identitySha256">;
		return {
			preflightId,
			identitySha256: canonicalSha256(launchPlan),
			expiresAt: "2099-01-01T00:00:00.000Z",
			launchPlan: {
				...launchPlan,
				identitySha256: canonicalSha256(launchPlan),
			},
		};
	});

	methods.launch = vi.fn(async (preflightId: string) => {
		const child = pending.get(preflightId);
		if (!child) throw new Error(`unknown preflight ${preflightId}`);
		children.set(child.runId, child);
		return { runId: child.runId, attemptId: child.attemptId, status: "active" };
	});

	methods.wait = vi.fn(async (runId: string) => {
		const child = children.get(runId);
		if (!child) throw new Error(`unknown child ${runId}`);
		const goal = child.request.task.goal;
		if (!goal.startsWith("Refine the authored plan")) {
			throw new Error(`no scripted output for goal: ${goal}`);
		}
		const structuredOutput = {
			summary: "Refined.",
			deliverables: [
				{
					id: "d0",
					goal: "Do the thing",
					files: ["a.txt"],
					acceptance: ["a.txt exists"],
					risks: [],
				},
			],
			blockers: [],
		};
		return {
			result: {
				runId,
				status: "completed" as const,
				structuredOutput: structuredOutput as unknown,
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
				sandboxCleanup: "proved" as const,
				workspaceCleanup: "not-needed" as const,
				truncated: false,
			},
			output: "",
			sessionFile: "/private/repo/session.jsonl",
			handoff: undefined,
			structuredOutput: structuredOutput as unknown,
			error: undefined,
		};
	});

	methods.release = vi.fn(async (runId: string) => ({
		runId,
		attemptId: children.get(runId)?.attemptId ?? "",
		status: "completed" as const,
	}));

	const client = methods as unknown as SubagentClient;
	return {
		bind: vi.fn(async (runId: string) => {
			ownerId = `pi-workflow:${runId}`;
			return {
				workflowRunId: runId,
				ownerId,
				client,
			} satisfies WorkflowSubagentBinding;
		}),
	} as WorkflowSubagentProvider;
}

/** The `origin` the run's own `run-created` event recorded, if any. */
async function journalledOrigin(
	service: WorkflowService,
	runId: WorkflowRunId,
): Promise<unknown> {
	const read = await readWorkflowJournalUnleased(storeRootOf(service), runId);
	const created = read.events[0];
	expect(created?.type).toBe("run-created");
	return (created?.data as { origin?: unknown } | undefined)?.origin;
}

describe("startBuiltin", () => {
	it("freezes the one startable allowlist", () => {
		expect(Object.isFrozen(BUILTIN_STARTABLE_WORKFLOWS)).toBe(true);
		expect([...BUILTIN_STARTABLE_WORKFLOWS]).toEqual(["plan-to-ship"]);
	});

	it.each([
		"deep-review",
		"deep-research",
		"fan-out",
		`dynamic:${"a".repeat(64)}`,
		"",
		"../plan-to-ship",
	])("refuses to start %j", async (ref) => {
		const { client } = await acquire(serviceDouble());
		const error = await client
			.startBuiltin(ref, { input: {} })
			.catch((value: unknown) => value);
		expect(error).toBeInstanceOf(WorkflowServiceError);
		expect((error as WorkflowServiceError).code).toBe("validation");
		expect((error as Error).message).toBe(startableRefusalMessage(ref));
	});

	it("refuses the startable name resolved outside the builtin root", async () => {
		const run = vi.fn();
		const { client } = await acquire(
			serviceDouble({
				validate: async () => ({
					valid: true,
					workflow: { scope: "project" },
				}),
				run,
			} as unknown as Partial<WorkflowService>),
		);
		await expect(
			client.startBuiltin("plan-to-ship", { input: {} }),
		).rejects.toThrow(startableRefusalMessage("plan-to-ship"));
		expect(run).not.toHaveBeenCalled();
	});

	it("names the service-provider origin and returns only the run id", async () => {
		const run = vi.fn(async () => ({
			runId: "workflow_a1" as WorkflowRunId,
			status: "created" as const,
		}));
		const wait = vi.fn(async () => ({ status: "waiting" }));
		const { client } = await acquire(
			serviceDouble({
				validate: async () => ({
					valid: true,
					workflow: { scope: "builtin" },
				}),
				run,
				wait,
			} as unknown as Partial<WorkflowService>),
		);
		const started = await client.startBuiltin("plan-to-ship", {
			input: { plan: 1 },
			effort: "deep",
		});
		expect(started).toEqual({ runId: "workflow_a1" });
		// The dial is a field of the definition's input, so it is merged into
		// the one input the runtime validates - not a second parameter.
		expect(run).toHaveBeenCalledWith(
			"plan-to-ship",
			{ plan: 1, effort: "deep" },
			{ origin: "service-provider" },
		);
		// This client started it, so it may await it.
		await expect(
			client.awaitRun("workflow_a1" as WorkflowRunId, { timeoutMs: 10 }),
		).resolves.toEqual({ status: "waiting" });
	});

	it("refuses an effort the input cannot carry, before any run", async () => {
		const run = vi.fn();
		const { client } = await acquire(
			serviceDouble({ run } as unknown as Partial<WorkflowService>),
		);
		const error = await client
			.startBuiltin("plan-to-ship", { input: [1, 2], effort: "cheap" })
			.catch((value: unknown) => value);
		expect(error).toBeInstanceOf(WorkflowServiceError);
		expect((error as WorkflowServiceError).code).toBe("validation");
		expect((error as Error).message).toBe(START_EFFORT_REFUSAL_MESSAGE);
		expect(run).not.toHaveBeenCalled();
	});

	it("refuses an input the definition's schema rejects, creating no run", async () => {
		const service = await realService(scriptedPlanner());
		const { client } = await acquire(service);
		await expect(
			client.startBuiltin("plan-to-ship", { input: { plan: "not a plan" } }),
		).rejects.toThrow("Workflow input does not match its schema.");
		await expect(client.runs()).resolves.toMatchObject({ runs: [] });
	});

	it("creates an ordinary plan-to-ship run that starts working at once", async () => {
		const service = await realService(scriptedPlanner());
		const { client } = await acquire(service);
		const { runId } = await client.startBuiltin("plan-to-ship", {
			input: { plan: plan(1), planDigest: "a".repeat(64) },
			effort: "cheap",
		});
		expect(runId).toMatch(/^workflow_[a-z0-9]+$/);

		// An ordinary run the moment it exists: this client's own lease-free
		// scan of the durable store sees it, exactly as `/workflow` does.
		const page = await client.runs();
		expect(page.runs.map((summary) => summary.runId)).toEqual([runId]);

		// `awaitRun` is permitted, because this client started it. No decision is
		// asked for before the work: the refiner runs and the first implementer
		// is declared and executed straight after it, with no checkpoint in
		// between. This provider scripts only the refiner, so the implementer is
		// where the run stops - what matters is that it got that far unattended.
		const view = await client.awaitRun(runId, { timeoutMs: 60_000 });
		expect(view.parked ?? false).toBe(false);
		const tasks = view.tasks ?? [];
		expect(tasks.map((task) => task.key)).toContain("refine");
		expect(tasks.find((task) => task.key === "refine")?.status).toBe(
			"completed",
		);
		expect(tasks.map((task) => task.key)).toContain("implement-d0");
		// The gate the run used to park on before doing anything is gone.
		expect(tasks.filter((task) => task.kind === "checkpoint")).toEqual([]);
		await expect(client.inspect(runId)).resolves.toMatchObject({
			run: { runId, definitionName: "plan-to-ship" },
		});

		// Provenance: the journal, not the caller, says where the run came from.
		await expect(journalledOrigin(service, runId)).resolves.toBe(
			"service-provider",
		);
	}, 90_000);
});

describe("the structural property of a run nobody is asked about", () => {
	const headless = defineWorkflow({
		meta: {
			name: "headless-example",
			description: "A read-only reviewer with no gate and no worktree.",
			version: 1,
			budget: { cost: 10, childRuntimeMs: 600_000 },
			timeoutMs: 600_000,
		},
		inputSchema: Type.Object({ subject: Type.String() }),
		outputSchema: Type.Object({ verdict: Type.String() }),
		async run(ctx) {
			const review = ctx.agent("review", {
				agent: "reviewer",
				task: { goal: "Review", context: [], instructions: [] },
				contextMode: "fresh",
				tools: ["read"],
				preloadSkills: [],
				contextScopes: [],
				workspace: { mode: "read-only", cwd: ctx.cwd },
				outputSchema: Type.Object({ verdict: Type.String() }),
				limits: {
					cumulativeRuntimeMs: 300_000,
					attemptTimeoutMs: 300_000,
					totalTokens: 100_000,
					cost: 5,
					outputBytes: 65_536,
					workspaceWriteBytes: 0,
					retries: 0,
					resumes: 0,
				},
			});
			return await ctx.result(review);
		},
	}) as unknown as WorkflowDefinition;

	const gated = defineWorkflow({
		meta: {
			name: "gated-example",
			description: "A worktree writer behind a human gate.",
			version: 1,
			budget: { cost: 10, childRuntimeMs: 600_000 },
			timeoutMs: 600_000,
		},
		inputSchema: Type.Object({ subject: Type.String() }),
		outputSchema: Type.Object({ done: Type.Boolean() }),
		async run(ctx) {
			const gate = ctx.checkpoint("approve", {
				schema: Type.Object({ proceed: Type.Boolean() }),
				prompt: "Proceed?",
				headless: "block",
			});
			await ctx.result(gate);
			ctx.agent("build", {
				agent: "implementer",
				task: { goal: "Build", context: [], instructions: [] },
				contextMode: "fresh",
				tools: ["edit"],
				preloadSkills: [],
				contextScopes: [],
				workspace: { mode: "worktree", cwd: ctx.cwd },
				handoff: "required",
				outputSchema: Type.Object({ done: Type.Boolean() }),
				limits: {
					cumulativeRuntimeMs: 300_000,
					attemptTimeoutMs: 300_000,
					totalTokens: 100_000,
					cost: 5,
					outputBytes: 65_536,
					workspaceWriteBytes: 1_024,
					retries: 0,
					resumes: 0,
				},
			});
			return { done: true };
		},
	}) as unknown as WorkflowDefinition;

	it("accepts a definition with no gate, no worktree and no handoff", async () => {
		await expect(
			headlessBuiltinViolations(headless, { subject: "x" }),
		).resolves.toEqual([]);
	});

	it("names every violation a gated worktree definition commits", async () => {
		await expect(
			headlessBuiltinViolations(gated, { subject: "x" }),
		).resolves.toEqual(["checkpoint", "worktree", "handoff"]);
	});

	// The startable allowlist is the OPPOSITE list: its one name violates all
	// three on purpose, because a person already decided one dialog ago.
	it("proves plan-to-ship would never be a run nobody is asked about", async () => {
		const service = await realService();
		const projection = await service.project("plan-to-ship", planInput());
		expect(projection.tasks).toBeGreaterThan(0);
		const { workflow } = await service.validate("plan-to-ship");
		const definition = (
			(await import(workflow.path)) as { default: WorkflowDefinition }
		).default;
		await expect(
			headlessBuiltinViolations(definition, planInput()),
		).resolves.toEqual(["checkpoint", "worktree", "handoff"]);
	});
});

describe("inspect through the read client", () => {
	// What pi-maestro's publication reader needs from a settled run, end to
	// end through the real service: the receipt at `run.output`, and the
	// `ship` gate's decided value, with no lease and without `decide`.
	it("reads a settled run's output and a checkpoint's decided value", async () => {
		const service = await shipService();
		const { client } = await acquire(service);
		const receipt = await service.run("ship-example", {});
		const parked = await service.wait(receipt.runId, { timeoutMs: 30_000 });
		expect(parked).toMatchObject({ status: "waiting", parked: true });

		// Before the decision the client sees the gate pending and no output.
		const pending = await client.inspect(receipt.runId, {
			include: ["run", "tasks", "output"],
		});
		expect(pending.run).not.toHaveProperty("output");
		const gate = pending.tasks?.find((task) => task.kind === "checkpoint");
		expect(gate?.checkpoint).not.toHaveProperty("decision");

		// Deciding stays the operator's own call; the client never gets one.
		expect(client).not.toHaveProperty("decide");
		await service.decide(receipt.runId, gate?.id ?? "", {
			decision: { ship: true },
			approver: "human:vegard",
		});
		await expect(
			service.wait(receipt.runId, { timeoutMs: 30_000 }),
		).resolves.toMatchObject({ status: "completed" });

		const inspection = await client.inspect(receipt.runId, {
			include: ["run", "tasks", "output"],
		});
		expect(inspection.run.status).toBe("completed");
		expect(inspection.run.output).toEqual({
			receipt: { planDigest: PLAN_DIGEST },
		});
		const decided = inspection.tasks?.find(
			(task) => task.kind === "checkpoint",
		);
		expect(decided?.checkpoint?.decision).toMatchObject({
			source: "operator",
			decidedBy: "human:vegard",
			value: { ship: true },
		});

		// Every projected task carries what a host needs to narrate it, and with
		// `output` asked for it carries the task's own summary too. This fixture
		// names its tasks its own way, so the kind is the honest `other` and the
		// checkpoint is a `gate` whatever it is called.
		expect(decided?.narration).toMatchObject({
			stage: "ship",
			taskKind: "gate",
		});
		const work = inspection.tasks?.find((task) => task.kind === "agent");
		expect(work?.narration?.taskKind).toBe("other");
		expect(work?.narration?.stage).toBe(work?.key);
		expect(typeof work?.narration?.summary).toBe("string");

		// Asking for neither section leaves both out, so the default read is
		// unchanged for every consumer that does not want them.
		const lean = await client.inspect(receipt.runId, { include: ["run"] });
		expect(lean.run).not.toHaveProperty("output");
		expect(lean).not.toHaveProperty("tasks");
	});

	it("tells an observer which task settled, and how", async () => {
		// The other half of the narration surface: a host posts one message per
		// task completion, so the observation says which task and what happened
		// without a second call. The summary is not here — an observation reads no
		// file — and `inspect` above is where a host gets it.
		const service = await shipService();
		const { client } = await acquire(service);
		const observed: WorkflowRunObservation[] = [];
		const stop = client.observe((observation) => {
			observed.push(observation);
		});
		const receipt = await service.run("ship-example", {});
		await service.wait(receipt.runId, { timeoutMs: 30_000 });
		stop();

		const settled = observed.flatMap((observation) =>
			observation.task ? [observation.task] : [],
		);
		expect(settled.length).toBeGreaterThan(0);
		for (const task of settled) {
			expect(task.narration.stage.length).toBeGreaterThan(0);
			expect(task.narration.summary).toBeUndefined();
		}
		// Most appends settle no task, so `task` is the filter, not the payload.
		expect(observed.length).toBeGreaterThan(settled.length);
	});
});

describe("project", () => {
	it("sums the declared reservations of the whole graph", async () => {
		const service = await realService();
		const projection = await service.project("plan-to-ship", planInput(1));
		// refine + implement + one verifier + one lens + the review synthesis +
		// the receipt finalizer, and the one `ship` gate, which reserves
		// nothing. The verifier is one because a barrier synthesizes a boolean
		// as `true`, so the projected check passes in round 1 and declares no
		// fixer.
		expect(projection.tasks).toBe(7);
		expect(projection.cost).toBeGreaterThan(0);
		expect(projection.totalTokens).toBeGreaterThan(0);
		expect(projection.childRuntimeMs).toBeGreaterThan(0);
		// plan-to-ship's budget is the worst case its input schema admits, with
		// the cost clamped to the service's own ceiling.
		expect(projection.budget).toEqual({
			cost: 1_000,
			childRuntimeMs: 553_500_000,
		});
		expect(projection.fits).toBe(true);
		expect(Object.isFrozen(projection)).toBe(true);
	});

	it("grows with the plan, and the builtin is sized for its own ceiling", async () => {
		const service = await realService();
		const small = await service.project("plan-to-ship", planInput(1));
		const large = await service.project("plan-to-ship", planInput(16, "deep"));
		expect(large.tasks).toBeGreaterThan(small.tasks);
		expect(large.cost).toBeGreaterThan(small.cost);
		// plan-to-ship declares its budget "sized for the deep column at the
		// input schema's 16 deliverables"; the projection is what makes that
		// claim checkable instead of a comment.
		expect(large.fits).toBe(true);
	});

	it("reports fits: false when the declared graph outgrows the budget", async () => {
		const service = await fanOutService();
		const fits = await service.project("fan-out-example", { items: ["a"] });
		expect(fits).toMatchObject({ tasks: 1, cost: 5, fits: true });
		const overruns = await service.project("fan-out-example", {
			items: ["a", "b", "c", "d"],
		});
		expect(overruns).toMatchObject({
			tasks: 4,
			cost: 20,
			totalTokens: 400_000,
			fits: false,
		});
	});

	it("is lease-free: it neither binds a subagent nor opens a run", async () => {
		const service = await realService();
		await service.project("plan-to-ship", planInput(2));
		// The subagent provider throws on `bind`, and the run store stays empty
		// because no lease, journal or record was ever created.
		const runs = await service.listRuns();
		expect(runs.runs).toEqual([]);
	});

	it("validates the input against the definition's schema", async () => {
		const service = await realService();
		const error = await service
			.project("plan-to-ship", { plan: { slug: "x" } })
			.catch((value: unknown) => value);
		expect(error).toBeInstanceOf(WorkflowServiceError);
		expect((error as WorkflowServiceError).code).toBe("validation");
	});

	it("refuses a dynamic ref", async () => {
		const service = await realService();
		const error = await service
			.project(`dynamic:${"a".repeat(64)}`, planInput())
			.catch((value: unknown) => value);
		expect(error).toBeInstanceOf(WorkflowServiceError);
		expect((error as WorkflowServiceError).code).toBe("validation");
		expect((error as Error).message).toContain("static-definition only");
	});

	it("refuses an unknown ref", async () => {
		const service = await realService();
		await expect(
			service.project("no-such-workflow", {}),
		).rejects.toBeInstanceOf(WorkflowServiceError);
	});
});
