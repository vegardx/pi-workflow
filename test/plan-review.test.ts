import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentLaunchPlan,
	canonicalSha256,
	discoverAgents,
	SUBAGENT_RUNTIME_CONTRACT,
	type SubagentClient,
	type SubagentRequest,
} from "@vegardx/pi-subagent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { envelope } from "../src/components/index.js";
import type { WorkflowDefinition } from "../src/definition.js";
import { discoverWorkflows } from "../src/registry.js";
import { createWorkflowService, type WorkflowService } from "../src/service.js";
import { headlessBuiltinViolations } from "../src/service-provider.js";
import type {
	WorkflowServiceRunView,
	WorkflowServiceTaskView,
} from "../src/service-views.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";

// W2-PLANREVIEW acceptance: the builtin `plan-review` definition driven through
// the real service with a scripted subagent. Every expectation below is the
// plan-loop spec (sections 1.2, 2.2, 2.4 and 5) or a component's documented
// rule, never the definition's implementation:
//
//   - the allowlist's SAFETY PROPERTY, structurally: no checkpoint, no
//     worktree, no handoff, which is the whole reason `runBuiltin` may start
//     this and nothing else;
//   - blindness, structurally: `contextMode: "fresh"` and NO context scopes,
//     so pi-subagent projects no `AGENTS.md` and no project context file;
//   - the five preloaded reference skills;
//   - validate and project through the service;
//   - a fake-agent run that reports `ready`, and one that reports `blocked`
//     with a patch that mechanically applies to the plan it points into.

const BUILTIN_ROOT = fileURLToPath(new URL("../workflows", import.meta.url));
const AGENT_TEMPLATES = fileURLToPath(
	new URL("../workflows/agents", import.meta.url),
);
const REVIEWER_AGENT = "plan-reviewer";
const EFFORTS = ["cheap", "standard", "deep"] as const;

/** Spec 2.2, verbatim and in order. */
const PRELOAD_SKILLS = [
	"workflows",
	"subagents",
	"workflow-authoring",
	"plan-schema",
	"workflow-components",
];

type Effort = (typeof EFFORTS)[number];

interface Finding {
	readonly id: string;
	readonly severity: "blocking" | "major" | "minor";
	readonly kind: "gap" | "graph" | "budget" | "risk" | "ambiguity";
	readonly where: string;
	readonly what: string;
	readonly patch?: { op: string; path: string; value?: unknown };
}

interface Report {
	readonly verdict: "ready" | "gaps" | "blocked";
	readonly findings: readonly Finding[];
	readonly notes?: string;
}

/** The spec's own example plan at plan schema v5: tasks are work, reviews list. */
function planFixture(): Record<string, unknown> {
	return {
		slug: "compose-catalogue",
		title: "Component catalogue",
		repos: [{ key: "wf", path: "/repos/pi-workflow" }],
		policy: {
			effort: "standard",
			gates: "ship",
			maxFixRounds: 1,
			publish: { mode: "pr", base: "main" },
		},
		deliverables: [
			{
				id: "catalogue",
				title: "Ship the component catalogue",
				after: [],
				reads: [],
				tasks: [{ id: "impl", title: "Write the components" }],
				reviews: [{ lens: "contracts", tier: "heavy", diverse: true }],
			},
		],
	};
}

function compiledFixture(): Record<string, unknown> {
	return {
		deliverables: [
			{
				id: "catalogue",
				stages: [
					{ use: "implement", id: "implement" },
					{
						// Plan fix rounds + 1: the component counts VERIFY rounds.
						use: "verify-and-fix",
						id: "verify",
						maxRounds: 2,
					},
					{
						use: "review-fan-out",
						id: "review",
						synthesis: "optional",
						lenses: [{ id: "contracts", tier: "heavy", diverse: true }],
					},
				],
			},
		],
		effort: "standard",
		gates: "ship",
	};
}

function projectionFixture(fits = true): Record<string, unknown> {
	return {
		cost: fits ? 40 : 4_000,
		totalTokens: 5_000_000,
		childRuntimeMs: 6_000_000,
		tasks: 6,
		budget: { cost: 900, childRuntimeMs: 172_800_000 },
		fits,
	};
}

function input(
	options: {
		readonly effort?: Effort;
		readonly plan?: unknown;
		readonly compiled?: unknown;
		readonly projection?: unknown;
		readonly intent?: string;
	} = {},
) {
	return {
		plan: options.plan ?? planFixture(),
		planDigest: "a".repeat(64),
		intent:
			options.intent ??
			"Extract the component catalogue so both builtins share one review stage.",
		compiled: options.compiled ?? compiledFixture(),
		projection: options.projection ?? projectionFixture(),
		effort: options.effort ?? "standard",
	};
}

/** A minimal RFC 6902 apply, so "the patch applies" is a fact, not a claim. */
function applyPatch(
	document: unknown,
	patch: { op: string; path: string; value?: unknown },
): unknown {
	const clone = structuredClone(document) as Record<string, unknown>;
	const tokens = patch.path
		.split("/")
		.slice(1)
		.map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
	const last = tokens.pop();
	if (last === undefined) throw new Error(`not a pointer: ${patch.path}`);
	let target: unknown = clone;
	for (const token of tokens) {
		target = Array.isArray(target)
			? target[Number(token)]
			: (target as Record<string, unknown>)[token];
		if (target === undefined) throw new Error(`no such path: ${patch.path}`);
	}
	if (Array.isArray(target)) {
		const at = last === "-" ? target.length : Number(last);
		if (patch.op === "add") target.splice(at, 0, patch.value);
		else if (patch.op === "replace") target[at] = patch.value;
		else if (patch.op === "remove") target.splice(at, 1);
		else throw new Error(`unknown op: ${patch.op}`);
		return clone;
	}
	const object = target as Record<string, unknown>;
	if (patch.op === "remove") delete object[last];
	else object[last] = patch.value;
	return clone;
}

const CLIENT_METHODS = [
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

function unavailableClient(): SubagentClient {
	const methods: Record<string, unknown> = {};
	for (const method of CLIENT_METHODS) {
		methods[method] = vi.fn(async () => {
			throw new Error(`unexpected subagent call: ${method}`);
		});
	}
	return methods as unknown as SubagentClient;
}

interface Child {
	readonly runId: string;
	readonly attemptId: string;
	readonly request: SubagentRequest;
}

/**
 * A scripted owner client: one preflight, one launch, one child, and whatever
 * report the case handed it. `fail: true` kills the reviewer instead.
 */
function scripted(
	options: { readonly report?: Report; readonly fail?: boolean } = {},
) {
	const nonce = randomUUID().replaceAll("-", "").slice(0, 8);
	const pending = new Map<string, Child>();
	const children = new Map<string, Child>();
	const statuses = new Map<string, "completed" | "failed">();
	const requests: SubagentRequest[] = [];
	let preflights = 0;
	let ownerId = "";

	const preflight = vi.fn(async (request: SubagentRequest) => {
		preflights += 1;
		const preflightId = `preflight-${nonce}-${preflights}`;
		const runId = `run_child${nonce}${preflights}`;
		const attemptId = `attempt_child${nonce}${preflights}`;
		pending.set(preflightId, { runId, attemptId, request });
		requests.push(request);
		const plan = {
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
		const identitySha256 = canonicalSha256(plan);
		return {
			preflightId,
			identitySha256,
			expiresAt: "2099-01-01T00:00:00.000Z",
			launchPlan: { ...plan, identitySha256 },
		};
	});

	const launch = vi.fn(async (preflightId: string) => {
		const child = pending.get(preflightId);
		if (!child) throw new Error(`unknown preflight ${preflightId}`);
		children.set(child.runId, child);
		return { runId: child.runId, attemptId: child.attemptId, status: "active" };
	});

	const childOf = (runId: string): Child => {
		const child = children.get(runId);
		if (!child) throw new Error(`unknown child ${runId}`);
		return child;
	};

	const wait = vi.fn(async (runId: string) => {
		childOf(runId);
		const failed = options.fail === true;
		const result = {
			runId,
			status: failed ? ("failed" as const) : ("completed" as const),
			...(failed
				? {}
				: {
						structuredOutput: (options.report ?? {
							verdict: "ready",
							findings: [],
						}) as unknown,
					}),
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
			...(failed
				? {
						failure: {
							code: "model-output",
							origin: "model",
							retry: "never",
							message: "the reviewer produced nothing",
							guidance: "Do not retry; report it.",
						},
					}
				: {}),
			sandboxCleanup: "proved" as const,
			workspaceCleanup: "not-needed" as const,
			truncated: false,
		};
		statuses.set(runId, result.status);
		return {
			result,
			output: "",
			sessionFile: "/private/repo/session.jsonl",
			handoff: undefined,
			structuredOutput: result.structuredOutput,
			error: failed ? "the reviewer produced nothing" : undefined,
		};
	});

	const release = vi.fn(async (runId: string) => ({
		runId,
		attemptId: childOf(runId).attemptId,
		status: statuses.get(runId) ?? ("completed" as const),
	}));

	const client = {
		...unavailableClient(),
		preflight,
		launch,
		wait,
		release,
	} as unknown as SubagentClient;

	return {
		provider: {
			bind: vi.fn(async (runId: string) => {
				ownerId = `pi-workflow:${runId}`;
				return {
					workflowRunId: runId,
					ownerId,
					client,
				} satisfies WorkflowSubagentBinding;
			}),
		} as WorkflowSubagentProvider,
		requests,
		reviewRequest(): SubagentRequest {
			const [request] = requests;
			if (!request) throw new Error("the reviewer was never requested");
			return request;
		},
	};
}

type Scripted = ReturnType<typeof scripted>;

const services: WorkflowService[] = [];

afterEach(async () => {
	while (services.length > 0) await services.pop()?.shutdown();
});

async function serviceFor(delegated: Scripted): Promise<WorkflowService> {
	const base = path.resolve(".pi", "test-plan-review", randomUUID());
	const cwd = path.join(base, "project");
	await mkdir(cwd, { recursive: true });
	const service = await createWorkflowService({
		cwd,
		agentDir: path.join(base, "agent"),
		storeRoot: path.join(cwd, "state"),
		// The builtin root needs no project trust.
		projectTrusted: () => false,
		subagents: delegated.provider,
		registeredRoots: [
			{ path: BUILTIN_ROOT, scope: "builtin", source: "package" },
		],
	});
	services.push(service);
	return service;
}

function bounded<T>(promise: Promise<T>, label: string, ms = 30_000) {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`${label} did not settle within ${ms}ms`)),
			ms,
		);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function taskPaths(view: WorkflowServiceRunView): string[] {
	return (view.tasks ?? []).map((task) =>
		[...task.namespace, task.key].join("/"),
	);
}

function onlyTask(view: WorkflowServiceRunView): WorkflowServiceTaskView {
	const [task, ...rest] = view.tasks ?? [];
	if (!task || rest.length > 0) {
		throw new Error(`expected exactly one task, saw ${taskPaths(view).length}`);
	}
	return task;
}

async function runPlanReview(
	options: Parameters<typeof input>[0] & {
		readonly report?: Report;
		readonly fail?: boolean;
	} = {},
) {
	const delegated = scripted({
		...(options.report ? { report: options.report } : {}),
		...(options.fail ? { fail: true } : {}),
	});
	const service = await serviceFor(delegated);
	const receipt = await service.run("plan-review", input(options));
	const finished = await bounded(service.wait(receipt.runId), "plan-review");
	return { delegated, service, runId: receipt.runId, finished };
}

async function shippedDefinition(): Promise<WorkflowDefinition> {
	const root = path.resolve(".pi", "test-plan-review", randomUUID());
	const cwd = path.join(root, "project");
	await mkdir(cwd, { recursive: true });
	const workflows = await discoverWorkflows({
		cwd,
		agentDir: path.join(root, "agent"),
		projectTrusted: false,
		registeredRoots: [
			{ path: BUILTIN_ROOT, scope: "builtin", source: "package" },
		],
	});
	const found = workflows.find(
		(entry) => entry.definition.meta.name === "plan-review",
	);
	if (!found) throw new Error("plan-review was not discovered");
	return found.definition;
}

describe("plan-review: discovery", () => {
	it("is discovered under the builtin root with scope builtin", async () => {
		const root = path.resolve(".pi", "test-plan-review", randomUUID());
		const cwd = path.join(root, "project");
		await mkdir(cwd, { recursive: true });
		const workflows = await discoverWorkflows({
			cwd,
			agentDir: path.join(root, "agent"),
			projectTrusted: false,
			registeredRoots: [
				{ path: BUILTIN_ROOT, scope: "builtin", source: "package" },
			],
		});
		const found = workflows.find(
			(entry) => entry.definition.meta.name === "plan-review",
		);
		if (!found) throw new Error("plan-review was not discovered");
		expect(found.scope).toBe("builtin");
		expect(found.source).toBe("package");
		expect(path.basename(found.path)).toBe("plan-review.workflow.ts");
		// Spec 2.2: a SMALL budget. One read-only review at the deep column is
		// the whole graph, so the budget is exactly that and nothing more.
		expect(found.definition.meta.budget).toEqual({
			cost: envelope("deep", "review").budgetShare.cost,
			totalTokens: envelope("deep", "review").budgetShare.totalTokens,
			childRuntimeMs: envelope("deep", "review").budgetShare.childRuntimeMs,
		});
	});
});

describe("plan-review: the headless allowlist's safety property", () => {
	// Spec R2 and 2.4: this is WHY `runBuiltin` may start this definition. The
	// check is structural, over a dry materialization of the real graph, because
	// `workflow_validate` cannot see any of the three.
	it("declares no checkpoint, no worktree and no handoff", async () => {
		const definition = await shippedDefinition();
		for (const effort of EFFORTS) {
			await expect(
				headlessBuiltinViolations(definition, input({ effort })),
			).resolves.toEqual([]);
		}
	});
});

describe("plan-review: the lowered graph", () => {
	it("declares exactly one blind read-only reviewer", async () => {
		const { delegated, finished } = await runPlanReview();
		expect(finished.status).toBe("completed");
		expect(taskPaths(finished)).toEqual(["review"]);
		expect(onlyTask(finished).status).toBe("completed");

		const request = delegated.reviewRequest();
		expect(request.agent).toBe(REVIEWER_AGENT);
		// Spec 2.2: `contextMode: "fresh"` sends only the task — no forked
		// conversation, no transcript.
		expect(request.contextMode).toBe("fresh");
		// BLINDNESS, structurally: no context scopes means pi-subagent projects
		// no `AGENTS.md` and no other project context file into the reviewer.
		expect(request.contextScopes).toEqual([]);
		expect(request.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(request.workspace.mode).toBe("read-only");
		expect(request.limits.workspaceWriteBytes).toBe(0);
	});

	it("preloads exactly the five reference skills of spec 2.2", async () => {
		const { delegated } = await runPlanReview();
		expect([...delegated.reviewRequest().preloadSkills]).toEqual(
			PRELOAD_SKILLS,
		);
	});

	it("shows the reviewer the plan, the graph, the projection and the intent", async () => {
		const { delegated } = await runPlanReview();
		const request = delegated.reviewRequest();
		const context = request.task.context.join("\n");
		expect(context).toContain(
			"Extract the component catalogue so both builtins share one review stage.",
		);
		expect(context).toContain("a".repeat(64));
		// The plan verbatim, and the compiled graph as a graph.
		expect(context).toContain('"slug":"compose-catalogue"');
		expect(context).toContain('"use":"review-fan-out"');
		expect(context).toContain("fits: true");
		// And it is told what it does not have.
		const instructions = request.task.instructions.join("\n");
		expect(instructions).toContain("BLIND");
		expect(instructions).toContain("AGENTS.md");
		expect(instructions).toContain("RFC 6902");
		// The plan mirror is v5: the reviewer checks `deliverables[].reviews`,
		// is told that a task is work only, and is told that `policy` was the
		// person's decision and is not its business.
		expect(context).toContain('"reviews":[{"lens":"contracts"');
		expect(instructions).toContain("every `reviews[]` entry must have seeded");
		expect(instructions).toContain(
			"In plan schema v5 a TASK IS WORK, and only work",
		);
		expect(instructions).toContain(
			"`policy` is OUT OF SCOPE: effort, gates, publication and base were decided by the person in the host's dialogs, so raise no finding whose `where` points into `/policy`.",
		);
	});

	it("spends the effort table's review row and nothing else", async () => {
		for (const effort of EFFORTS) {
			const { delegated, finished } = await runPlanReview({ effort });
			expect(finished.status).toBe("completed");
			expect(delegated.requests).toHaveLength(1);
			const review = envelope(effort, "review");
			const request = delegated.reviewRequest();
			expect(request.model?.thinking).toBe(review.thinking);
			expect(request.limits).toEqual(review.limits);
		}
	});
});

describe("plan-review: the report", () => {
	it("completes ready when the reviewer found nothing", async () => {
		const { finished } = await runPlanReview({
			report: {
				verdict: "ready",
				findings: [],
				notes: "The graph is the plan; the budget has room.",
			},
		});
		expect(finished.status).toBe("completed");
		expect(finished.output).toEqual({
			verdict: "ready",
			findings: [],
			notes: "The graph is the plan; the budget has room.",
		});
	});

	it("completes blocked with a patch that applies to the plan it points into", async () => {
		const patch = {
			op: "add",
			path: "/deliverables/0/reviews/1",
			value: { lens: "replay", tier: "standard" },
		};
		const { finished } = await runPlanReview({
			report: {
				verdict: "blocked",
				findings: [
					{
						id: "unreviewed-replay",
						severity: "blocking",
						kind: "gap",
						where: "/deliverables/0/reviews",
						what: "The intent names replay correctness, and no lens reviews it.",
						patch,
					},
				],
			},
		});
		expect(finished.status).toBe("completed");
		const output = finished.output as {
			verdict: string;
			findings: Finding[];
		};
		expect(output.verdict).toBe("blocked");
		expect(output.findings).toHaveLength(1);
		const reported = output.findings[0];
		expect(reported).toMatchObject({
			id: "unreviewed-replay",
			severity: "blocking",
			kind: "gap",
		});

		// The point of the RFC 6902 shape (spec 2.2): accepting is a MECHANICAL
		// apply against the stored plan, never a re-prompt.
		if (!reported?.patch) throw new Error("the finding carried no patch");
		const patched = applyPatch(planFixture(), reported.patch) as {
			deliverables: { reviews: { lens: string }[] }[];
		};
		expect(
			patched.deliverables[0]?.reviews.map((review) => review.lens),
		).toEqual(["contracts", "replay"]);
	});

	it("recomputes the verdict from the findings and never downgrades it", async () => {
		// A reviewer that files a blocking finding does not get to say `ready`:
		// pi-maestro's findings walk asks per BLOCKING finding, so a `ready`
		// verdict over one would be a loop that asks about nothing.
		const { finished } = await runPlanReview({
			report: {
				verdict: "ready",
				findings: [
					{
						id: "budget-over",
						severity: "blocking",
						kind: "budget",
						where: "/deliverables/0",
						what: "The projection does not fit the run budget.",
					},
					{
						id: "vague-title",
						severity: "minor",
						kind: "ambiguity",
						where: "/deliverables/0/title",
						what: "The title does not say what ships.",
					},
				],
			},
		});
		const output = finished.output as { verdict: string; findings: Finding[] };
		expect(output.verdict).toBe("blocked");
		// Severity order, from the shared merge rail.
		expect(output.findings.map((finding) => finding.severity)).toEqual([
			"blocking",
			"minor",
		]);
	});

	it("keeps a verdict more severe than the findings support", async () => {
		const { finished } = await runPlanReview({
			report: { verdict: "gaps", findings: [] },
		});
		expect((finished.output as { verdict: string }).verdict).toBe("gaps");
	});

	it("fails the run when the one reviewer dies", async () => {
		// One task and no barrier: there is nothing to degrade to, and a review
		// that did not happen must never read as a review that approved.
		const { finished } = await runPlanReview({ fail: true });
		expect(finished.status).toBe("failed");
		expect(finished.output).toBeUndefined();
	});
});

describe("plan-review: the input contract", () => {
	it("validates and projects the spec's input through the service", async () => {
		const service = await serviceFor(scripted());
		await expect(
			service.validate("plan-review", input()),
		).resolves.toMatchObject({ valid: true, workflow: { scope: "builtin" } });

		const projection = await service.project("plan-review", input());
		// One declared task, and it fits the budget the definition declares.
		expect(projection.tasks).toBe(1);
		expect(projection.fits).toBe(true);
		expect(projection.cost).toBe(envelope("standard", "review").limits.cost);
		expect(projection.budget).toEqual({
			cost: envelope("deep", "review").budgetShare.cost,
			totalTokens: envelope("deep", "review").budgetShare.totalTokens,
			childRuntimeMs: envelope("deep", "review").budgetShare.childRuntimeMs,
		});
	});

	it("accepts a plan carrying fields this runtime has never heard of", async () => {
		// Spec 2.2: the reviewer sees the stored plan VERBATIM, and pi-maestro's
		// document is versioned on its own schedule. A plan that grew a field
		// must still be reviewable.
		const service = await serviceFor(scripted());
		const plan = planFixture();
		const deliverables = plan.deliverables as Record<string, unknown>[];
		const first = deliverables[0] as Record<string, unknown>;
		await expect(
			service.validate(
				"plan-review",
				input({
					plan: {
						...plan,
						schemaVersion: 5,
						deliverables: [{ ...first, provenance: "conversation" }],
					},
				}),
			),
		).resolves.toMatchObject({ valid: true });
	});

	it("refuses an input the spec does not admit", async () => {
		const service = await serviceFor(scripted());
		for (const bad of [
			{ ...input(), extra: true },
			{ ...input(), planDigest: "not-a-digest" },
			{ ...input(), intent: "" },
			{ ...input(), intent: "x".repeat(513) },
			{ ...input(), effort: "standrd" },
			// The compiled document is CLOSED: it is this package's own output.
			{ ...input({ compiled: { ...compiledFixture(), extra: true } }) },
			{ ...input({ compiled: { ...compiledFixture(), gates: "none" } }) },
			{ ...input({ compiled: { ...compiledFixture(), deliverables: [] } }) },
			{
				...input({
					compiled: {
						...compiledFixture(),
						deliverables: [
							{ id: "catalogue", stages: [{ use: "dynamic", id: "guess" }] },
						],
					},
				}),
			},
			// The projection is the provider's own shape.
			{ ...input({ projection: { ...projectionFixture(), fits: "yes" } }) },
			{ ...input({ plan: { ...planFixture(), deliverables: [] } }) },
			{ ...input({ plan: { ...planFixture(), slug: "Compose" } }) },
		]) {
			await expect(service.validate("plan-review", bad)).rejects.toMatchObject({
				code: "validation",
				message: "Workflow input does not match its schema.",
			});
		}
	});

	it("reports a budget that does not fit without refusing the review", async () => {
		// `fits: false` is the reviewer's most important input, so the schema
		// must carry it rather than refuse the run that would have reported it.
		const { delegated, finished } = await runPlanReview({
			projection: projectionFixture(false),
			report: {
				verdict: "blocked",
				findings: [
					{
						id: "over-budget",
						severity: "blocking",
						kind: "budget",
						where: "/deliverables/0",
						what: "The compiled graph reserves more than the run budget admits.",
					},
				],
			},
		});
		expect(finished.status).toBe("completed");
		expect(delegated.reviewRequest().task.context.join("\n")).toContain(
			"fits: false",
		);
		expect((finished.output as { verdict: string }).verdict).toBe("blocked");
	});
});

describe("plan-review: the agent template", () => {
	it("parses through pi-subagent's own discovery and stays blind", async () => {
		const agents = await discoverAgents([
			{ scope: "package", directory: AGENT_TEMPLATES, trusted: true },
		]);
		const reviewer = agents.get(REVIEWER_AGENT);
		if (!reviewer) throw new Error("no plan-reviewer template");
		expect(reviewer.workspaceModes).toEqual(["read-only"]);
		expect(reviewer.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(reviewer.limitCeiling.workspaceWriteBytes).toBe(0);
		// pi-subagent UNIONS the agent's context scopes with the request's, so a
		// `project` scope here would hand the blind reviewer `AGENTS.md`.
		expect(reviewer.contextScopes).toEqual([]);
	});

	it("covers every request the definition makes at every effort", async () => {
		const agents = await discoverAgents([
			{ scope: "package", directory: AGENT_TEMPLATES, trusted: true },
		]);
		for (const effort of EFFORTS) {
			const { delegated, finished } = await runPlanReview({ effort });
			expect(finished.status).toBe("completed");
			for (const request of delegated.requests) {
				const agent = agents.get(request.agent);
				if (!agent) throw new Error(`no template for agent ${request.agent}`);
				for (const tool of request.tools) expect(agent.tools).toContain(tool);
				expect(agent.workspaceModes).toContain(request.workspace.mode);
				if (request.model) {
					expect(agent.allowedModels).toContain(
						`${request.model.provider}/${request.model.id}:${request.model.thinking}`,
					);
				}
				expect(request.limits.attemptTimeoutMs).toBeLessThanOrEqual(
					request.limits.cumulativeRuntimeMs,
				);
				for (const key of Object.keys(request.limits) as Array<
					keyof typeof request.limits
				>) {
					const value = request.limits[key];
					const ceiling = agent.limitCeiling[key];
					if (value === undefined || ceiling === undefined) continue;
					expect(value).toBeLessThanOrEqual(ceiling);
				}
			}
		}
	});
});

describe("plan-review: the preloaded reference skills", () => {
	it("ships each preloaded name as a discoverable skill directory", async () => {
		// pi-subagent resolves `preloadSkills` by NAME through Pi's resource
		// loader, which discovers a skill only from a directory containing
		// SKILL.md — a loose `.md` under a subdirectory is not a skill. The two
		// references this definition adds must therefore be directories, or the
		// blind reviewer fails preflight with "preload skill not found".
		const { loadSkillsFromDir } = await import(
			"@earendil-works/pi-coding-agent"
		);
		const skillsRoot = fileURLToPath(new URL("../skills", import.meta.url));
		const { skills } = loadSkillsFromDir({
			dir: skillsRoot,
			source: "@vegardx/pi-workflow",
		});
		const names = skills.map((skill) => skill.name);
		for (const name of ["plan-schema", "workflow-components"]) {
			expect(names).toContain(name);
			const skill = skills.find((entry) => entry.name === name);
			expect(path.basename(skill?.filePath ?? "")).toBe("SKILL.md");
			expect(path.basename(skill?.baseDir ?? "")).toBe(name);
			expect(skill?.description ?? "").not.toBe("");
		}
	});
});
