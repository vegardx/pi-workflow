import { createHash, randomUUID } from "node:crypto";
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
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CompiledStageDocumentSchema,
	DIVERSE_MODEL_ID,
	envelope,
	MAX_REVIEW_LENSES,
	MAX_VERIFY_ROUNDS,
	MODEL_ID,
} from "../src/components/index.js";
import { createWorkflowService, type WorkflowService } from "../src/service.js";
import type {
	WorkflowRunObservation,
	WorkflowServiceRunView,
	WorkflowServiceTaskView,
} from "../src/service-views.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";
import {
	compileStageDocument,
	compileStages,
} from "../workflows/plan-to-ship.workflow.js";

// W2-PTS acceptance: the builtin plan-to-ship definition, a COMPILER over
// `plan.deliverables` and `plan.policy` that DERIVES every stage, driven
// through the real service with a scripted subagent. Every expectation below is the plan-loop
// spec (sections 1.3, 2.1, 2.3 and 5), the plan-to-ship spec, experiment W1's
// verdict, or a component's documented rule — never the definition's
// implementation.

const BUILTIN_ROOT = fileURLToPath(new URL("../workflows", import.meta.url));
const AGENT_TEMPLATES = fileURLToPath(
	new URL("../workflows/agents", import.meta.url),
);
const PATCH_MEDIA_TYPE = "application/x-git-format-patch";
const BASELINE_HEAD = "b".repeat(40);
const PLAN_DIGEST = "a".repeat(64);
/** W1's mandatory floors for an implementer. */
const W1 = {
	workspaceWriteBytes: 2 * 1024 * 1024 * 1024,
	attemptTimeoutMs: 1_500_000,
	cumulativeRuntimeMs: 1_800_000,
} as const;
const CACHE_MARKER = "npm_config_cache=/tmp/npm-cache";

/** The compiler's own input types, so a fixture cannot drift from the schema. */
type PlanInput = Parameters<typeof compileStages>[0];
type PolicyInput = NonNullable<Parameters<typeof compileStages>[1]>;

interface PlanOptions {
	readonly deliverables?: number;
	readonly lensesPerDeliverable?: readonly string[];
	readonly diverse?: boolean;
	readonly pinnedModel?: string;
	readonly tier?: "light" | "standard" | "heavy";
	readonly policy?: PolicyInput;
	readonly after?: boolean;
}

/** A plan schema v5 document: tasks are work, reviews are the lens list. */
function plan(options: PlanOptions = {}): PlanInput {
	const count = options.deliverables ?? 1;
	const lenses = options.lensesPerDeliverable ?? ["correctness"];
	return {
		slug: "sample-plan",
		title: "Sample plan",
		deliverables: Array.from({ length: count }, (_unused, index) => ({
			id: `d${index}`,
			title: `Deliverable ${index}`,
			after: options.after && index > 0 ? [`d${index - 1}`] : [],
			reads: [],
			tasks: [{ id: `w${index}`, title: "Write the code" }],
			...(lenses.length > 0
				? {
						reviews: lenses.map((lens) => ({
							lens,
							...(options.diverse === undefined
								? {}
								: { diverse: options.diverse }),
							...(options.tier ? { tier: options.tier } : {}),
							...(options.pinnedModel ? { model: options.pinnedModel } : {}),
						})),
					}
				: {}),
		})),
		repos: [{ key: "main", path: "/repo" }],
		...(options.policy ? { policy: options.policy } : {}),
	};
}

/** The same plan with a plan schema v4 `stages` block on its first deliverable. */
function withStages(document: PlanInput, stages: unknown): PlanInput {
	const [first, ...rest] = document.deliverables;
	if (!first) throw new Error("fixture has no deliverable");
	return { ...document, deliverables: [{ ...first, stages }, ...rest] };
}

/** The same plan with a refused routing key on its first deliverable's task. */
function withTaskKey(
	document: PlanInput,
	key: "review" | "by",
	value: unknown,
): PlanInput {
	const [first, ...rest] = document.deliverables;
	const [task, ...others] = first?.tasks ?? [];
	if (!first || !task) throw new Error("fixture has no task");
	return {
		...document,
		deliverables: [
			{ ...first, tasks: [{ ...task, [key]: value }, ...others] },
			...rest,
		],
	};
}

function input(options: PlanOptions & { effort?: string } = {}) {
	return {
		plan: plan(options),
		planDigest: PLAN_DIGEST,
		...(options.effort === undefined ? {} : { effort: options.effort }),
	};
}

function sha256(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function commitFor(attemptId: string): string {
	return createHash("sha1").update(attemptId).digest("hex");
}

function patchFor(commit: string): Buffer {
	return Buffer.from(
		`From ${commit} Mon Sep 17 00:00:00 2001\nFrom: Agent <agent@example.com>\nSubject: [PATCH] change\n\n---\n a.txt | 1 +\n`,
	);
}

/** How a scripted verifier answers, per round. */
type CheckScript = "pass" | "fail-then-pass" | "fail" | "not-run";

function implementation(summary: string) {
	return {
		summary,
		files: ["a.txt"],
		checkCommand: "npm run check",
		checkRan: true,
		checkPassed: true,
		checkTail: "ok",
	};
}

function checkReport(script: CheckScript, round: number) {
	if (script === "not-run") {
		return {
			summary: "The install was killed before the check ran.",
			checkCommand: "npm run check",
			checkRan: false,
			checkPassed: false,
			checkTail: "",
		};
	}
	const passed =
		script === "pass" || (script === "fail-then-pass" && round >= 2);
	return {
		summary: passed ? "The check passed." : "The check failed.",
		checkCommand: "npm run check",
		checkRan: true,
		checkPassed: passed,
		checkTail: passed ? "ok" : "1 test failed",
	};
}

/** The structured output a scripted child returns, keyed by what it was asked. */
function outputFor(
	request: SubagentRequest,
	script: CheckScript,
	minorOnly = false,
): unknown {
	const goal = request.task.goal;
	if (goal.startsWith("Refine the authored plan")) {
		return {
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
	}
	if (goal.startsWith("Implement deliverable"))
		return implementation("Edited a.txt");
	if (goal.startsWith("Fix what the check reported")) {
		return implementation("Fixed what the check reported");
	}
	if (goal.startsWith("Verify deliverable")) {
		const round = Number(/round (\d+)/.exec(goal)?.[1] ?? "1");
		return checkReport(script, round);
	}
	if (goal.startsWith("Review deliverable")) {
		return {
			verdict: "request-changes",
			findings: [
				{
					id: "missing-test",
					severity: "blocking",
					kind: "gap",
					where: "/deliverables/0",
					what: "Missing a test.",
				},
			],
		};
	}
	if (goal.startsWith("Normalize the review findings")) {
		if (minorOnly) {
			return {
				findings: [
					{
						id: "naming",
						severity: "minor",
						lens: "correctness",
						where: "/deliverables/0",
						summary: "The helper could be named better.",
					},
				],
				verdict: "Nothing blocking; one naming nit.",
			};
		}
		return {
			findings: [
				{
					id: "missing-test",
					severity: "blocking",
					lens: "correctness",
					where: "/deliverables/0",
					summary: "Missing a test.",
					suggestion: "Add one next to the change.",
				},
				{
					id: "naming",
					severity: "minor",
					lens: "correctness",
					where: "/deliverables/0",
					summary: "The helper could be named better.",
				},
			],
			verdict: "One lens asked for a test; nothing else is blocking.",
		};
	}
	if (goal.startsWith("Address the review findings")) {
		return {
			findings: [{ id: "missing-test", outcome: "addressed" }],
			checkPassed: true,
		};
	}
	if (goal.startsWith("Record the plan-to-ship receipt")) {
		return { recorded: true, refs: [] };
	}
	throw new Error(`no scripted output for goal: ${goal}`);
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
 * A scripted owner client: every preflight is remembered, every launch mints a
 * child, and every child answers with the structured output its goal calls for.
 * Worktree children capture a handoff; read-only children never do.
 */
function scripted(
	options: {
		readonly failReview?: boolean;
		/** Fail only the lens whose name the goal names; the rest report. */
		readonly failLens?: string;
		readonly check?: CheckScript;
		/** The synthesis normalizes to minor findings only, so nothing is fixed. */
		readonly minorOnly?: boolean;
	} = {},
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
			// The real preflight states the ceiling it compiled under.
			...(request.ceiling === undefined
				? {}
				: { ceiling: structuredClone(request.ceiling) }),
		} satisfies Omit<AgentLaunchPlan, "identitySha256">;
		const identitySha256 = canonicalSha256(launchPlan);
		return {
			preflightId,
			identitySha256,
			expiresAt: "2099-01-01T00:00:00.000Z",
			launchPlan: { ...launchPlan, identitySha256 },
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
		const child = childOf(runId);
		const worktree = child.request.workspace.mode === "worktree";
		const goal = child.request.task.goal;
		const failed =
			goal.startsWith("Review deliverable") &&
			(options.failReview === true ||
				(options.failLens !== undefined &&
					goal.includes(`"${options.failLens}" lens`)));
		const result = {
			runId,
			status: failed ? ("failed" as const) : ("completed" as const),
			...(failed
				? {}
				: {
						structuredOutput: outputFor(
							child.request,
							options.check ?? "pass",
							options.minorOnly === true,
						),
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
							message: "reviewer produced nothing",
							guidance: "Do not retry; report it.",
						},
					}
				: {}),
			sandboxCleanup: "proved" as const,
			workspaceCleanup: worktree
				? ("proved" as const)
				: ("not-needed" as const),
			truncated: false,
		};
		statuses.set(runId, result.status);
		return {
			result,
			output: "",
			sessionFile: "/private/repo/session.jsonl",
			handoff: worktree
				? {
						schema: "pi-subagent-worktree",
						contractRevision: 8,
						runId,
						attemptId: child.attemptId,
						repositoryRoot: "/private/repo",
						worktreePath: `/private/repo/.pi/worktrees/${runId}`,
						recordPath: `/private/repo/.pi/worktrees/${runId}.json`,
						branch: `pi-subagent/reservations/${runId}`,
						baselineHead: BASELINE_HEAD,
						createdAt: "2026-01-01T00:00:00.000Z",
						handoffCommit: commitFor(child.attemptId),
						handoffRef: `refs/pi-subagent/handoffs/${runId}/${child.attemptId}`,
					}
				: undefined,
			structuredOutput: result.structuredOutput,
			error: failed ? "reviewer produced nothing" : undefined,
		};
	});

	// A release receipt reports the status the child actually settled with.
	const release = vi.fn(async (runId: string) => ({
		runId,
		attemptId: childOf(runId).attemptId,
		status: statuses.get(runId) ?? ("completed" as const),
	}));

	const exportHandoff = vi.fn(async (runId: string) => {
		const child = childOf(runId);
		const handoffCommit = commitFor(child.attemptId);
		const content = patchFor(handoffCommit);
		return {
			ref: {
				runId,
				attemptId: child.attemptId,
				baselineHead: BASELINE_HEAD,
				handoffCommit,
				format: "git-format-patch" as const,
				sha256: sha256(content),
				bytes: content.byteLength,
				mediaType: PATCH_MEDIA_TYPE,
			},
			content,
		};
	});

	const client = {
		...unavailableClient(),
		preflight,
		launch,
		wait,
		release,
		exportHandoff,
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
		children,
		launch,
		/** Every request for one agent, in declaration order. */
		requestsFor(agent: string) {
			return requests.filter((request) => request.agent === agent);
		},
		/** Every request whose goal starts with `prefix`, in declaration order. */
		requestsGoal(prefix: string) {
			return requests.filter((request) => request.task.goal.startsWith(prefix));
		},
		childFor(goalPrefix: string): Child {
			for (const child of children.values()) {
				if (child.request.task.goal.startsWith(goalPrefix)) return child;
			}
			throw new Error(`no child for ${goalPrefix}`);
		},
	};
}

type Scripted = ReturnType<typeof scripted>;

const services: WorkflowService[] = [];

afterEach(async () => {
	while (services.length > 0) await services.pop()?.shutdown();
});

async function serviceFor(delegated: Scripted): Promise<WorkflowService> {
	const base = path.resolve(".pi", "test-plan-to-ship", randomUUID());
	const cwd = path.join(base, "project");
	await mkdir(cwd, { recursive: true });
	const service = await createWorkflowService({
		cwd,
		agentDir: path.join(base, "agent"),
		storeRoot: path.join(cwd, "state"),
		// The builtin root needs no project trust: that is the point of F1.
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

function taskByKey(
	view: WorkflowServiceRunView,
	key: string,
): WorkflowServiceTaskView {
	const task = (view.tasks ?? []).find(
		(entry) => [...(entry.namespace ?? []), entry.key].join("/") === key,
	);
	if (!task) throw new Error(`missing task ${key}`);
	return task;
}

/** Every task's `${namespace}/${key}` path, in declaration order. */
function taskPaths(view: WorkflowServiceRunView): readonly string[] {
	return (view.tasks ?? []).map((task) =>
		[...(task.namespace ?? []), task.key].join("/"),
	);
}

/** Parks at a checkpoint and answers it; returns the view it parked with. */
async function park(
	service: WorkflowService,
	runId: string,
	key: string,
): Promise<WorkflowServiceRunView> {
	const view = await bounded(service.wait(runId), `park at ${key}`);
	expect(view).toMatchObject({ status: "waiting", parked: true });
	expect(
		(view.pendingCheckpoints ?? []).map((checkpoint) => checkpoint.key),
	).toEqual([key]);
	return view;
}

async function decide(
	service: WorkflowService,
	view: WorkflowServiceRunView,
	key: string,
	decision: unknown,
): Promise<void> {
	await service.decide(view.runId, taskByKey(view, key).id, {
		decision,
		approver: "vegard",
	});
}

/** The example plan of plan-loop spec 2.1, in the shipped vocabulary. */
function examplePlan(): PlanInput {
	return {
		slug: "compose-catalogue",
		title: "Component catalogue",
		repos: [{ key: "wf", path: "/repo" }],
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
				tasks: [{ id: "impl", title: "Write src/components/*.ts" }],
				reviews: [
					{ lens: "contracts", tier: "heavy", diverse: true },
					{ lens: "replay", tier: "standard" },
				],
			},
		],
	};
}

describe("plan-to-ship: the compiled stage document", () => {
	// The plan-facing view of the SAME compilation the run walks: what
	// a host's plan check reads and what pi-maestro
	// derives for itself from the stored plan. It must therefore be exactly the
	// derived stage list of spec 2.1 - no task keys, no policy gates, and
	// `maxRounds` in the component's VERIFY rounds.
	function check(document: unknown): void {
		const errors = [...Value.Errors(CompiledStageDocumentSchema, document)];
		expect(errors.map((error) => error.message)).toEqual([]);
		expect(Value.Check(CompiledStageDocumentSchema, document)).toBe(true);
	}

	it("derives the stage list pi-maestro derives, from `reviews` and `policy`", () => {
		const document = compileStageDocument(plan());
		check(document);
		expect(document).toEqual({
			effort: "standard",
			gates: "ship",
			deliverables: [
				{
					id: "d0",
					stages: [
						{ use: "implement", id: "implement" },
						// The plan counts one FIX round; a compiled document records
						// the two VERIFY rounds the component was asked for.
						{ use: "verify-and-fix", id: "check", maxRounds: 2 },
						{
							use: "review-fan-out",
							id: "review",
							lenses: [{ id: "correctness", tier: "standard", diverse: false }],
							// The fan-out declares no reducer of its own: the
							// normalization the fixer reads is its own stage.
							synthesis: "none",
						},
						{ use: "synthesis", id: "synthesis" },
						// The fix stage draws on the deliverable's WHOLE fix-round
						// pool, the same one the check stage spends from.
						{ use: "fix", id: "fix", maxRounds: 1 },
					],
				},
			],
		});
	});

	it("derives the spec's own example plan", () => {
		const document = compileStageDocument(examplePlan());
		check(document);
		expect(document).toEqual({
			effort: "standard",
			gates: "ship",
			deliverables: [
				{
					id: "catalogue",
					stages: [
						{ use: "implement", id: "implement" },
						{ use: "verify-and-fix", id: "check", maxRounds: 2 },
						{
							use: "review-fan-out",
							id: "review",
							synthesis: "none",
							lenses: [
								{ id: "contracts", tier: "heavy", diverse: true },
								{ id: "replay", tier: "standard", diverse: false },
							],
						},
						{ use: "synthesis", id: "synthesis" },
						{ use: "fix", id: "fix", maxRounds: 1 },
					],
				},
			],
		});
	});

	it.each(["ship", "every-deliverable"] as const)(
		"carries the gate policy %s without inventing a stage for it",
		(gates) => {
			const document = compileStageDocument(plan({ deliverables: 3 }), {
				gates,
			});
			check(document);
			expect(document.gates).toBe(gates);
			// A gate the POLICY adds is not a stage of the plan: `gates` already
			// says where a person is asked, and pi-maestro's own derivation of this
			// document has no way to know the compiler's gate keys.
			for (const deliverable of document.deliverables) {
				expect(deliverable.stages.map((stage) => stage.use)).toEqual([
					"implement",
					"verify-and-fix",
					"review-fan-out",
					"synthesis",
					"fix",
				]);
			}
			// The lowering, from the same compilation, is where the gates are named.
			expect(compileStages(plan({ deliverables: 3 }), { gates }).gates).toEqual(
				gates === "ship" ? ["ship"] : ["approve-d0", "approve-d1", "ship"],
			);
		},
	);

	it("omits the review, synthesis and fix stages when the deliverable lists no review", () => {
		const document = compileStageDocument(plan({ lensesPerDeliverable: [] }));
		check(document);
		expect(document.deliverables[0]?.stages.map((stage) => stage.use)).toEqual([
			"implement",
			"verify-and-fix",
		]);
	});

	it("refuses what the lowering refuses, from the same compilation", () => {
		expect(() =>
			compileStageDocument(withStages(plan(), [{ use: "implement", id: "x" }])),
		).toThrow("plan schema v5 does not author stages");
	});
});

describe("plan-to-ship: the compiler", () => {
	it("compiles a plan with no `policy` to the derived stage list", () => {
		// Spec 2.1: a plan that sets no policy is valid and gets the defaults,
		// and the stage list is derived, never authored.
		const document = compileStages(plan());
		expect(document.effort).toBe("standard");
		expect(document.gates).toEqual(["ship"]);
		expect(document.deliverables).toEqual([
			{
				id: "d0",
				stages: [
					{
						use: "implement",
						id: "implement",
						key: "implement-d0",
						tasks: ["implement-d0"],
					},
					{
						use: "verify-and-fix",
						id: "check",
						key: "check-d0",
						// `standard` pays for one FIX round, which is two VERIFY rounds.
						fixRounds: 1,
						verifyRounds: 2,
						tasks: ["check-d0-verify-1", "check-d0-fix-1", "check-d0-verify-2"],
					},
					{
						use: "review-fan-out",
						id: "review",
						key: "review-d0",
						// Seeded from `reviews`, with the policy's review defaults.
						lenses: [{ id: "correctness", tier: "standard", diverse: false }],
						synthesis: "none",
						tasks: ["review-d0/correctness"],
					},
					{
						use: "synthesis",
						id: "synthesis",
						key: "synthesis-d0",
						tasks: ["synthesis-d0"],
					},
					{
						use: "fix",
						id: "fix",
						key: "fix-d0",
						// The SHARED pool, the same number the check stage reports.
						fixRounds: 1,
						tasks: ["fix-d0"],
					},
				],
			},
		]);
	});

	it("omits the review, synthesis and fix stages when the deliverable lists no review", () => {
		const document = compileStages(plan({ lensesPerDeliverable: [] }));
		expect(document.deliverables[0]?.stages.map((stage) => stage.use)).toEqual([
			"implement",
			"verify-and-fix",
		]);
	});

	it("derives the five stage keys of a reviewed deliverable, in order", () => {
		// The documented key list; a host names a task by these and a finding
		// points at one, so they are pinned here rather than implied.
		const document = compileStages(plan());
		expect(
			document.deliverables[0]?.stages.map((stage) => [stage.id, stage.key]),
		).toEqual([
			["implement", "implement-d0"],
			["check", "check-d0"],
			["review", "review-d0"],
			["synthesis", "synthesis-d0"],
			["fix", "fix-d0"],
		]);
	});

	it.each([
		["cheap", 0, 1, ["check-d0-verify-1"]],
		[
			"standard",
			1,
			2,
			["check-d0-verify-1", "check-d0-fix-1", "check-d0-verify-2"],
		],
		[
			"deep",
			2,
			3,
			[
				"check-d0-verify-1",
				"check-d0-fix-1",
				"check-d0-verify-2",
				"check-d0-fix-2",
				"check-d0-verify-3",
			],
		],
	] as const)(
		"maps %s to %i fix round(s) and %i verify round(s)",
		(effort, fixRounds, verifyRounds, tasks) => {
			const document = compileStages(plan(), { effort });
			const verify = document.deliverables[0]?.stages[1];
			expect(verify).toMatchObject({ fixRounds, verifyRounds, tasks });
		},
	);

	it("honours `policy.maxFixRounds` over the effort column's default", () => {
		// `maxFixRounds: 2` is the plan vocabulary's maximum and compiles to the
		// component's cap of 3 VERIFY rounds: a fix is never left unchecked.
		const document = compileStages(plan(), {
			effort: "cheap",
			maxFixRounds: 2,
		});
		expect(document.deliverables[0]?.stages[1]).toMatchObject({
			key: "check-d0",
			fixRounds: 2,
			verifyRounds: MAX_VERIFY_ROUNDS,
			tasks: [
				"check-d0-verify-1",
				"check-d0-fix-1",
				"check-d0-verify-2",
				"check-d0-fix-2",
				"check-d0-verify-3",
			],
		});
	});

	it.each([
		["ship", ["ship"]],
		["every-deliverable", ["approve-d0", "approve-d1", "ship"]],
	] as const)("compiles the gate policy %s", (gates, expected) => {
		const document = compileStages(plan({ deliverables: 3 }), { gates });
		// Three deliverables, and still exactly the gates the policy names.
		expect(document.gates).toEqual(expected);
		// A per-deliverable gate is a stage of the deliverable it follows; the
		// ship gate is a run-level gate over every handoff.
		const perDeliverable = document.deliverables.map((deliverable) =>
			deliverable.stages
				.filter((stage) => stage.use === "gate")
				.map((stage) => stage.key),
		);
		expect(perDeliverable).toEqual(
			gates === "every-deliverable"
				? [["approve-d0"], ["approve-d1"], []]
				: [[], [], []],
		);
	});

	it.each(["approve-plan", "approve-plan+ship"] as const)(
		"refuses the removed gate policy %s by name",
		(gates) => {
			// The start of the run IS the approval, so the up-front gate is gone
			// and its two policies are refused rather than silently remapped.
			expect(() => compileStages(plan(), { gates })).toThrow(
				`plan-to-ship: \`policy.gates\` is "${gates}", which was removed because the start of the run IS the approval — the plan-mode exit's yes, or a deliberate \`/plan run\` — so ask for "ship", one decision after all the work and before publication, or "every-deliverable", which adds one after each deliverable.`,
			);
			// The plan-facing document comes out of the same compilation, so it
			// refuses the same value rather than showing a gate that is gone.
			expect(() => compileStageDocument(plan(), { gates })).toThrow(
				"which was removed because the start of the run IS the approval",
			);
		},
	);

	it("seeds review lenses from `deliverables[].reviews` and resolves tier and diversity from the policy", () => {
		const document = compileStages(plan({ lensesPerDeliverable: ["a", "b"] }), {
			reviewDefault: { tier: "heavy", diverse: true },
		});
		expect(document.deliverables[0]?.stages[2]).toMatchObject({
			lenses: [
				{ id: "a", tier: "heavy", diverse: true },
				{ id: "b", tier: "heavy", diverse: true },
			],
		});
		// A lens that says it for itself outranks the policy.
		const pinned = compileStages(
			plan({ lensesPerDeliverable: ["a"], tier: "light", diverse: false }),
			{ reviewDefault: { tier: "heavy", diverse: true } },
		);
		expect(pinned.deliverables[0]?.stages[2]).toMatchObject({
			lenses: [{ id: "a", tier: "light", diverse: false }],
		});
	});

	// Plan schema v5 moved review routing off the task and deleted authored
	// stages. There is no migration from v3 or v4, so each key is admitted by
	// the input schema ONLY so the compiler can refuse it by name: refused by
	// TypeBox a person would read "unexpected property" and could not act on
	// it. The schema/compiler split is asserted in "the input contract".
	it.each([
		[
			"a task carrying plan schema v4's `review`",
			() => withTaskKey(plan(), "review", { lens: "correctness" }),
			'deliverable "d0" task "w0" carries `review`: plan schema v5 moved review routing to `deliverables[].reviews`; a task is work only, so move it to the deliverable\'s `reviews` list and store the plan at `schemaVersion: 5`.',
		],
		[
			"a task carrying plan schema v3's `by`",
			() => withTaskKey(plan(), "by", { lens: "correctness" }),
			'deliverable "d0" task "w0" carries `by`, plan schema v3\'s name for a task review: plan schema v5 moved review routing to `deliverables[].reviews`; a task is work only, so move it to the deliverable\'s `reviews` list and store the plan at `schemaVersion: 5`.',
		],
		[
			"a deliverable that authors `stages`",
			() =>
				withStages(plan(), [
					{ use: "implement", id: "build" },
					{ use: "verify-and-fix", id: "green" },
				]),
			'deliverable "d0" declares `stages`: plan schema v5 does not author stages; the compiler derives them from `reviews` and `policy`, so drop the block and store the plan at `schemaVersion: 5`.',
		],
	])(
		"refuses %s by name, and compiles the same plan without it",
		(_name, document, message) => {
			expect(() => compileStages(document())).toThrow(message);
			// The refusal is the compiler's, not the schema's, and it is the ONLY
			// thing wrong with this plan: the same document without the key compiles.
			expect(() => compileStages(plan())).not.toThrow();
		},
	);

	it("names the key even when its value is the empty object the model wrote", () => {
		// The seat model answered "remove `review` from work tasks" with
		// `review: {lens: ""}`. A value-shaped refusal would have missed it; the
		// compiler refuses the KEY, whatever it carries.
		expect(() => compileStages(withTaskKey(plan(), "review", {}))).toThrow(
			"a task is work only",
		);
		expect(() => compileStages(withStages(plan(), []))).toThrow(
			"plan schema v5 does not author stages",
		);
	});

	it("de-duplicates repeated lens ids by declaration ordinal", () => {
		const document = compileStages(
			plan({ lensesPerDeliverable: ["risk", "risk", "risk"] }),
		);
		expect(document.deliverables[0]?.stages[2]?.tasks).toEqual([
			"review-d0/risk",
			"review-d0/risk-2",
			"review-d0/risk-3",
		]);
		// The synthesis is its own stage, so the fan-out's task list is the
		// lenses and nothing else.
		expect(document.deliverables[0]?.stages[3]?.tasks).toEqual([
			"synthesis-d0",
		]);
	});

	it("refuses more reviews than a fan-out admits", () => {
		expect(() =>
			compileStages(
				plan({
					lensesPerDeliverable: Array.from(
						{ length: MAX_REVIEW_LENSES + 1 },
						(_x, index) => `lens${index}`,
					),
				}),
			),
		).toThrow(`at most ${MAX_REVIEW_LENSES} fan out at once`);
	});

	it("refuses a `reads` edge, because a handoff is never applied to another worktree", () => {
		const document = plan();
		const first = document.deliverables[0];
		if (!first) throw new Error("no deliverable");
		expect(() =>
			compileStages({
				...document,
				deliverables: [{ ...first, reads: ["dx"] }],
			}),
		).toThrow(/cannot build on another's code/);
	});

	it("refuses an `after` edge that points forwards", () => {
		const document = plan({ deliverables: 2 });
		expect(() =>
			compileStages({
				...document,
				deliverables: [
					{ ...document.deliverables[0], after: ["d1"] },
					document.deliverables[1],
				],
			} as never),
		).toThrow(/is not declared before it/);
	});
});

describe("plan-to-ship: the start is the approval", () => {
	// A run exists because a person said yes to the plan it carries:
	// pi-maestro's plan-mode exit agrees the description, shows the compiled
	// document, has it blind-reviewed and asks "Start the run?" before calling
	// `startBuiltin`, and `/plan run` is that same yes said deliberately. So
	// there is no gate before the work, and no approve-plan task at all.
	it("declares no approve task and makes the first task ready at once", async () => {
		const delegated = scripted();
		const service = await serviceFor(delegated);
		const run = await service.run("plan-to-ship", input());

		// The first task the run declares is runnable at once: nothing waits on a
		// person between `run-created` and the first work task, so no scan of the
		// run ever sees a pending checkpoint before that task exists.
		const created = await bounded(
			(async () => {
				for (;;) {
					const view = await service.status(run.runId);
					expect(view.pendingCheckpoints ?? []).toEqual([]);
					const first = (view.tasks ?? [])[0];
					if (first && first.status !== "pending") return view;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
			})(),
			"the first task",
		);
		expect(taskPaths(created)[0]).toBe("refine");
		const refine = taskByKey(created, "refine");
		expect(refine.dependsOn ?? []).toEqual([]);
		expect(["ready", "running", "completed"]).toContain(refine.status);

		// The FIRST park is the ship gate, so every deliverable ran without a
		// second person-facing decision.
		const ship = await park(service, run.runId, "ship");
		expect(taskPaths(ship)).not.toContain("approve-plan");
		expect(taskByKey(ship, "implement-d0").status).toBe("completed");

		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(run.runId), "wait");
		expect(finished.status).toBe("completed");
		// The only checkpoint the default policy declares, over the whole run.
		expect(
			(finished.tasks ?? [])
				.filter((task) => task.kind === "checkpoint")
				.map((task) => task.key),
		).toEqual(["ship"]);
		expect(finished.output).toMatchObject({ approved: true, shipped: true });
	});
});

describe("plan-to-ship: the stage walk", () => {
	async function walkToShip(options: PlanOptions & { effort?: string } = {}) {
		const delegated = scripted();
		const service = await serviceFor(delegated);
		const receipt = await service.run("plan-to-ship", input(options));
		const ship = await park(service, receipt.runId, "ship");
		return { delegated, service, runId: receipt.runId, ship };
	}

	it("lowers the derived stage list to the compiled keys, in order", async () => {
		const { ship } = await walkToShip();
		// Exactly `compileStages`' own task list, plus the run-level ship gate.
		expect(taskPaths(ship)).toEqual([
			"refine",
			"implement-d0",
			"check-d0-verify-1",
			"review-d0/correctness",
			"synthesis-d0",
			"fix-d0",
			"ship",
		]);
	});

	it("declares every deliverable's implementer up front when no gate can stop the walk", async () => {
		const { ship } = await walkToShip({
			deliverables: 2,
			lensesPerDeliverable: [],
		});
		expect(taskPaths(ship)).toEqual([
			"refine",
			"implement-d0",
			"implement-d1",
			"check-d0-verify-1",
			"check-d1-verify-1",
			"ship",
		]);
	});

	it("launches the implementer with W1's limits and the cache instruction", async () => {
		const { delegated } = await walkToShip();
		const [implement] = delegated.requestsFor("implementer");
		if (!implement) throw new Error("no implementer request");

		expect(implement.workspace).toEqual({
			mode: "worktree",
			cwd: expect.any(String),
		});
		expect(implement.limits.workspaceWriteBytes).toBeGreaterThanOrEqual(
			W1.workspaceWriteBytes,
		);
		expect(implement.limits.attemptTimeoutMs).toBeGreaterThanOrEqual(
			W1.attemptTimeoutMs,
		);
		expect(implement.limits.cumulativeRuntimeMs).toBeGreaterThanOrEqual(
			W1.cumulativeRuntimeMs,
		);
		expect(implement.tools).toContain("bash");

		const instructions = implement.task.instructions.join("\n");
		// W1: a cache inside the worktree lands in the handoff and breaches its bound.
		expect(instructions).toContain(CACHE_MARKER);
		expect(instructions).toMatch(/npm ci/);
		expect(instructions).toMatch(/checkRan/);
		expect(instructions).toMatch(/checkTail/);
		// The check may never be the reason a handoff is missing.
		expect(instructions).toMatch(/never a reason to leave the tree unchanged/i);
	});

	it("verifies the implementer's own patch and takes the verify envelope", async () => {
		const { delegated } = await walkToShip();
		const [verify] = delegated.requestsGoal("Verify deliverable");
		if (!verify) throw new Error("no verifier request");
		expect(verify.agent).toBe("implementer");
		// A verifier has to apply the handoff before it can run the check, so it
		// runs in a worktree — with the `verify` row's model and the write grant.
		expect(verify.workspace.mode).toBe("worktree");
		expect(verify.model).toEqual(envelope("standard", "verify").model);
		expect(verify.limits.workspaceWriteBytes).toBeGreaterThanOrEqual(
			W1.workspaceWriteBytes,
		);
		expect(verify.task.instructions.join("\n")).toMatch(
			/Apply that ref in your worktree/,
		);
	});

	it("fixes what a failing check reported and reviews the fixer's patch", async () => {
		const delegated = scripted({ check: "fail-then-pass" });
		const service = await serviceFor(delegated);
		const run = await service.run("plan-to-ship", input());
		const ship = await park(service, run.runId, "ship");

		// The check spent the ONE fix round `standard` pays for, so the review's
		// fixer has none left and is not declared: total fix rounds per
		// deliverable never exceed `policy.maxFixRounds`.
		expect(taskPaths(ship)).toEqual([
			"refine",
			"implement-d0",
			"check-d0-verify-1",
			"check-d0-fix-1",
			"check-d0-verify-2",
			"review-d0/correctness",
			"synthesis-d0",
			"ship",
		]);
		const [fix] = delegated.requestsGoal("Fix what the check reported");
		expect(fix?.model).toEqual(envelope("standard", "fix").model);
		// The reviewer judges the FIXER's patch, not the implementer's.
		const fixChild = delegated.childFor("Fix what the check reported");
		const [review] = delegated.requestsFor("reviewer");
		expect((review?.task.context ?? []).join("\n")).toContain(
			commitFor(fixChild.attemptId),
		);
		const status = await service.status(run.runId);
		expect(taskByKey(status, "check-d0-fix-1").handoff).toMatchObject({
			handoffCommit: commitFor(fixChild.attemptId),
		});
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(run.runId), "wait");
		expect(finished.output).toMatchObject({
			deliverables: [
				{ id: "d0", checkRan: true, checkPassed: true, verifyRounds: 2 },
			],
		});
	});

	it("stops the loop on a check that did not run and says the change is unverified", async () => {
		const delegated = scripted({ check: "not-run" });
		const service = await serviceFor(delegated);
		const run = await service.run("plan-to-ship", input());
		const ship = await park(service, run.runId, "ship");
		// `checkRan: false` escalates to a human; it never declares a fixer.
		expect(taskPaths(ship)).not.toContain("check-d0-fix-1");
		// The review's fixer still runs - the findings are real, and it has the
		// whole fix-round pool - and it reports the check passing after its edits.
		// That is the fixer's OWN word, and it is not the separate verification a
		// check that never ran is missing, so the deliverable stays unverified.
		expect(taskPaths(ship)).toContain("fix-d0");
		expect(
			taskByKey(ship, "ship").checkpoint?.inputs?.["fix-d0"],
		).toMatchObject({ checkPassed: true });
		await decide(service, ship, "ship", { ship: false });
		const finished = await bounded(service.wait(run.runId), "wait");
		expect(finished.output).toMatchObject({
			deliverables: [{ id: "d0", checkRan: false, checkPassed: false }],
		});
	});

	it("normalizes every lens's findings and fixes the blocking ones", async () => {
		const delegated = scripted();
		const service = await serviceFor(delegated);
		const run = await service.run(
			"plan-to-ship",
			input({ lensesPerDeliverable: ["a", "b"] }),
		);
		const ship = await park(service, run.runId, "ship");

		// The synthesis is a fan-in over the lenses that reported, and both of
		// them are its inputs by lens key. `inputs` is an inspection-only field.
		const inspected = await service.inspect(run.runId, {
			include: ["run", "tasks"],
		});
		const synthesis = (inspected.tasks ?? []).find(
			(task) => task.key === "synthesis-d0",
		);
		expect(Object.keys(synthesis?.inputs ?? {}).sort()).toEqual(["a", "b"]);
		const [normalize] = delegated.requestsGoal("Normalize the review findings");
		expect(normalize?.agent).toBe("reviewer");
		expect(normalize?.workspace.mode).toBe("read-only");
		expect(normalize?.model).toEqual(envelope("standard", "synthesis").model);
		expect(normalize?.task.instructions.join("\n")).toMatch(
			/de-duplicated|ONE list/,
		);

		// The fixer reads the normalized list and the patch, in a worktree, at the
		// `fix` envelope, and it is told to answer every finding by id.
		const [fix] = delegated.requestsGoal("Address the review findings");
		expect(fix?.agent).toBe("implementer");
		expect(fix?.workspace.mode).toBe("worktree");
		expect(fix?.model).toEqual(envelope("standard", "fix").model);
		const instructions = fix?.task.instructions.join("\n") ?? "";
		expect(instructions).toContain("Address EVERY blocking and major finding");
		// Only the blocking finding of the scripted synthesis is actionable; the
		// minor one is the fixer's to judge.
		expect(instructions).toContain("1 of them");
		expect(instructions).toMatch(/a note is REQUIRED/);
		// No re-review: nothing reads the fixer's patch again.
		expect(
			taskPaths(ship).filter((path) => path.startsWith("review-d0/")).length,
		).toBe(2);
		expect(taskPaths(ship)).toEqual([
			"refine",
			"implement-d0",
			"check-d0-verify-1",
			"review-d0/a",
			"review-d0/b",
			"synthesis-d0",
			"fix-d0",
			"ship",
		]);
		// The patch that ships is the FIXER's, not the implementer's.
		const fixChild = delegated.childFor("Address the review findings");
		const status = await service.status(run.runId);
		expect(taskByKey(status, "fix-d0").handoff).toMatchObject({
			handoffCommit: commitFor(fixChild.attemptId),
		});
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(run.runId), "wait");
		expect(finished.output).toMatchObject({
			shipped: true,
			receipt: {
				refs: [
					`refs/pi-subagent/handoffs/${fixChild.runId}/${fixChild.attemptId}`,
				],
			},
		});
	});

	it("skips the fixer, and says why, when nothing is blocking or major", async () => {
		const delegated = scripted({ minorOnly: true });
		const service = await serviceFor(delegated);
		const run = await service.run("plan-to-ship", input());
		const ship = await park(service, run.runId, "ship");
		expect(taskPaths(ship)).not.toContain("fix-d0");
		expect(taskByKey(ship, "ship").checkpoint?.prompt).toContain(
			"Fixes: 0 of 1 deliverable(s) ran a fixer",
		);
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(run.runId), "wait");
		// The reason is recorded in the journal, not only in the prompt.
		const logs = await service.logs(run.runId, { limit: 500 });
		expect(
			logs.entries.some((entry) =>
				entry.message.includes(
					'no fixer for deliverable "d0": the synthesis reported no blocking or major finding',
				),
			),
		).toBe(true);
		expect(finished.status).toBe("completed");
	});

	it("skips the fixer, and says why, when the check spent the whole fix budget", async () => {
		const delegated = scripted({ check: "fail-then-pass" });
		const service = await serviceFor(delegated);
		const run = await service.run("plan-to-ship", input());
		const ship = await park(service, run.runId, "ship");
		expect(taskPaths(ship)).not.toContain("fix-d0");
		const logs = await service.logs(run.runId, { limit: 500 });
		expect(
			logs.entries.some((entry) =>
				entry.message.includes(
					'no fixer for deliverable "d0": no fix round remains in the shared budget (1 of 1 fix round(s) spent on the check)',
				),
			),
		).toBe(true);
		await decide(service, ship, "ship", { ship: true });
		await bounded(service.wait(run.runId), "wait");
	});

	it("imports the handoff and hands its descriptor to the reviewer", async () => {
		const { delegated, service, runId, ship } = await walkToShip();
		const child = delegated.childFor("Implement deliverable");
		const patch = patchFor(commitFor(child.attemptId));

		const status = await service.status(runId);
		expect(taskByKey(status, "implement-d0").handoff).toMatchObject({
			subagentRunId: child.runId,
			subagentAttemptId: child.attemptId,
			baselineHead: BASELINE_HEAD,
			handoffCommit: commitFor(child.attemptId),
			mediaType: PATCH_MEDIA_TYPE,
			sha256: sha256(patch),
			bytes: patch.byteLength,
		});

		// The reviewer receives the handoff as a descriptor input, never bytes.
		const [review] = delegated.requestsFor("reviewer");
		const projected = (review?.task.context ?? []).join("\n");
		expect(projected).toContain('"content":"descriptor"');
		expect(projected).toContain(commitFor(child.attemptId));
		expect(projected).not.toContain("From: Agent");
		expect(review?.workspace.mode).toBe("read-only");

		// The ship gate shows the summaries, the normalized findings and the fix
		// report, keyed by deliverable id rather than by an ordinal nobody can
		// look up.
		const gate = taskByKey(ship, "ship").checkpoint;
		expect(Object.keys(gate?.inputs ?? {}).sort()).toEqual([
			"findings-d0",
			"fix-d0",
			"plan",
			"summary-d0",
		]);
		expect(gate?.inputs).toMatchObject({
			"summary-d0": { checkRan: true, checkPassed: true, files: ["a.txt"] },
			"findings-d0": {
				findings: [
					{
						id: "missing-test",
						severity: "blocking",
						lens: "correctness",
						where: "/deliverables/0",
						summary: "Missing a test.",
						suggestion: "Add one next to the change.",
					},
					{ id: "naming", severity: "minor" },
				],
				verdict: "One lens asked for a test; nothing else is blocking.",
			},
			"fix-d0": {
				findings: [{ id: "missing-test", outcome: "addressed" }],
				checkPassed: true,
			},
		});
		expect(gate?.prompt).toContain("1 blocking finding(s)");
		expect(gate?.prompt).toContain("nothing re-reviewed a fixed patch");
	});

	it("records a receipt naming the handoff ref, its digest, and the plan digest", async () => {
		const { delegated, service, runId, ship } = await walkToShip();
		// The patch that ships is the last worktree task's: the fixer that
		// answered the review findings.
		const child = delegated.childFor("Address the review findings");
		await decide(service, ship, "ship", { ship: true, note: "cherry-picked" });
		const finished = await bounded(service.wait(runId), "wait");

		const ref = `refs/pi-subagent/handoffs/${child.runId}/${child.attemptId}`;
		expect(finished.status).toBe("completed");
		expect(finished.output).toMatchObject({
			approved: true,
			shipped: true,
			deliverables: [
				{
					id: "d0",
					checkRan: true,
					checkPassed: true,
					verifyRounds: 1,
					handoff: { sha256: sha256(patchFor(commitFor(child.attemptId))) },
				},
			],
			reviews: [
				{
					deliverable: "d0",
					lens: "correctness",
					verdict: "request-changes",
					blocking: true,
				},
			],
			findings: [{ id: "missing-test", severity: "blocking", kind: "gap" }],
			receipt: { planDigest: PLAN_DIGEST, refs: [ref] },
		});
		// The required finalizer ran after the output was committed, and could
		// not have changed it.
		const record = taskByKey(finished, "receipt");
		expect(record).toMatchObject({ role: "finalizer", status: "completed" });
		const [recording] = delegated
			.requestsFor("planner")
			.filter((request) =>
				request.task.goal.startsWith("Record the plan-to-ship receipt"),
			);
		expect(recording?.task.context.join("\n")).toContain(ref);
	});

	it("completes with shipped: false and no refs when the ship gate says no", async () => {
		const { service, runId, ship } = await walkToShip();
		await decide(service, ship, "ship", {
			ship: false,
			note: "patch is wrong",
		});
		const finished = await bounded(service.wait(runId), "wait");
		expect(finished.status).toBe("completed");
		expect(finished.output).toMatchObject({
			approved: true,
			shipped: false,
			receipt: { planDigest: PLAN_DIGEST, refs: [] },
		});
		// Nothing was pushed, merged, or published; the patch simply stays where
		// the runtime imported it.
		expect(
			(finished.output as { deliverables: unknown[] }).deliverables,
		).toHaveLength(1);
	});
});

describe("plan-to-ship: what a host needs to narrate", () => {
	// pi-maestro observes a run it started and posts each task completion into
	// the person's conversation, then gives the model a turn on the interesting
	// ones. These are the fields it builds against.
	it("names every settled task's stage, kind and deliverable on the observation", async () => {
		const delegated = scripted();
		const service = await serviceFor(delegated);
		const observed: WorkflowRunObservation[] = [];
		const unsubscribe = service.subscribe((observation) => {
			observed.push(observation);
		});
		const run = await service.run("plan-to-ship", input());
		const ship = await park(service, run.runId, "ship");
		await decide(service, ship, "ship", { ship: true });
		await bounded(service.wait(run.runId), "wait");
		unsubscribe();

		const settled = observed.flatMap((observation) =>
			observation.task ? [observation.task] : [],
		);
		// One per task that reached a terminal status, in sequence order, and
		// nothing else: an append that moved no task carries no `task`.
		expect(
			settled.map((task) => [
				task.narration.stage,
				task.narration.taskKind,
				task.narration.deliverable,
				task.status,
			]),
		).toEqual([
			["refine", "refine", undefined, "completed"],
			["implement-d0", "implement", "d0", "completed"],
			["check-d0-verify-1", "check", "d0-verify-1", "completed"],
			["review-d0/correctness", "review", "d0", "completed"],
			["synthesis-d0", "synthesis", "d0", "completed"],
			["fix-d0", "fix", "d0", "completed"],
			["ship", "gate", undefined, "completed"],
			["receipt", "other", undefined, "completed"],
		]);
		for (const task of settled) {
			expect(task.taskId).toMatch(/^task_[a-z0-9]+$/);
			expect(task.outcome).toBe("completed");
			// An observation reads no file, so it never carries a summary.
			expect(task.narration.summary).toBeUndefined();
			expect(task.narration.cause).toBeUndefined();
		}
		// Most appends settle no task, so the field is the filter a host uses.
		expect(observed.length).toBeGreaterThan(settled.length);
	});

	it("carries each task's own summary on the inspection that reads output", async () => {
		const delegated = scripted();
		const service = await serviceFor(delegated);
		const run = await service.run("plan-to-ship", input());
		const ship = await park(service, run.runId, "ship");
		await decide(service, ship, "ship", { ship: true });
		await bounded(service.wait(run.runId), "wait");

		const inspected = await service.inspect(run.runId, {
			include: ["run", "tasks", "output"],
		});
		const narrated = new Map(
			(inspected.tasks ?? []).map((task) => [
				task.narration?.stage,
				task.narration,
			]),
		);
		// The agent's own words where it reported them, and a bounded rendering
		// of the structured result where it did not.
		expect(narrated.get("implement-d0")).toMatchObject({
			taskKind: "implement",
			deliverable: "d0",
			summary: "Edited a.txt",
		});
		expect(narrated.get("review-d0/correctness")?.summary).toContain(
			"request-changes",
		);
		expect(narrated.get("synthesis-d0")?.summary).toBe(
			"One lens asked for a test; nothing else is blocking.",
		);
		// The fix report has no summary field of its own, so the rendering says
		// its structure and its scale — the artifact is canonical JSON, so the
		// field order is the sorted one.
		expect(narrated.get("fix-d0")?.summary).toBe(
			"{checkPassed: true, findings: [1 item(s)]}",
		);
		// Without `output` the narration is still there; the summary is not.
		const lean = await service.inspect(run.runId, {
			include: ["run", "tasks"],
		});
		const implement = (lean.tasks ?? []).find(
			(task) => task.narration?.stage === "implement-d0",
		);
		expect(implement?.narration).toMatchObject({ taskKind: "implement" });
		expect(implement?.narration?.summary).toBeUndefined();
	});

	it("says why a task failed, in a sanitized sentence, on both surfaces", async () => {
		const delegated = scripted({ failReview: true });
		const service = await serviceFor(delegated);
		const observed: WorkflowRunObservation[] = [];
		const unsubscribe = service.subscribe((observation) => {
			observed.push(observation);
		});
		const run = await service.run("plan-to-ship", input());
		const ship = await park(service, run.runId, "ship");
		await decide(service, ship, "ship", { ship: true });
		await bounded(service.wait(run.runId), "wait");
		unsubscribe();

		const failed = observed
			.flatMap((observation) => (observation.task ? [observation.task] : []))
			.filter((task) => task.status === "failed");
		expect(failed.map((task) => task.narration.stage)).toEqual([
			"review-d0/correctness",
		]);
		// Composed from the journalled codes; the reviewer's own words ("reviewer
		// produced nothing") never travel, because a view carries no child prose.
		const cause =
			"The delegated run failed: model-output (origin model, retry never).";
		expect(failed[0]).toMatchObject({
			outcome: "failed",
			narration: { taskKind: "review", deliverable: "d0", cause },
		});
		// The inspection says the same thing, with no artifact read needed.
		const inspected = await service.inspect(run.runId, {
			include: ["run", "tasks"],
		});
		const review = (inspected.tasks ?? []).find(
			(task) => task.narration?.stage === "review-d0/correctness",
		);
		expect(review?.narration?.cause).toBe(cause);
		expect(JSON.stringify(inspected)).not.toContain(
			"reviewer produced nothing",
		);
	});
});

describe("plan-to-ship: the gate policies", () => {
	it("asks one decision — the ship gate — when the policy is the default", async () => {
		const delegated = scripted();
		const service = await serviceFor(delegated);
		const run = await service.run(
			"plan-to-ship",
			input({ deliverables: 2, lensesPerDeliverable: [] }),
		);
		// `ship` is the default, so every deliverable is done before the one
		// person-facing decision, and both summaries are in front of it.
		const ship = await park(service, run.runId, "ship");
		expect(
			Object.keys(taskByKey(ship, "ship").checkpoint?.inputs ?? {}),
		).toEqual(["plan", "summary-d0", "summary-d1"]);
		// The refined plan is one of them, so the refiner's `blockers` are read
		// by the person who decides rather than by nobody.
		expect(taskByKey(ship, "ship").checkpoint?.inputs).toMatchObject({
			plan: { summary: "Refined.", blockers: [] },
		});
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(run.runId), "wait");

		expect(finished.status).toBe("completed");
		expect(taskPaths(finished)).toEqual([
			"refine",
			"implement-d0",
			"implement-d1",
			"check-d0-verify-1",
			"check-d1-verify-1",
			"ship",
			"receipt",
		]);
		// The ship decision is the durable one a receipt is checked against.
		expect(finished.output).toMatchObject({
			approved: true,
			shipped: true,
			deliverables: [
				{ id: "d0", handoff: { mediaType: PATCH_MEDIA_TYPE } },
				{ id: "d1", handoff: { mediaType: PATCH_MEDIA_TYPE } },
			],
		});
		expect(
			(finished.output as { receipt: { refs: string[] } }).receipt.refs,
		).toHaveLength(2);
	});

	it("gates after every deliverable but the last, whose gate is the ship gate", async () => {
		const delegated = scripted();
		const service = await serviceFor(delegated);
		const run = await service.run(
			"plan-to-ship",
			input({
				deliverables: 2,
				lensesPerDeliverable: [],
				policy: { gates: "every-deliverable" },
			}),
		);
		const first = await park(service, run.runId, "approve-d0");
		// A per-deliverable gate is walked strictly in order: the second
		// deliverable is not implemented until a person allowed the first.
		expect(taskPaths(first)).toEqual([
			"refine",
			"implement-d0",
			"check-d0-verify-1",
			"approve-d0",
		]);
		await decide(service, first, "approve-d0", { proceed: true });
		const ship = await park(service, run.runId, "ship");
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(run.runId), "wait");
		expect(finished.status).toBe("completed");
		expect(taskPaths(finished)).toEqual([
			"refine",
			"implement-d0",
			"check-d0-verify-1",
			"approve-d0",
			"implement-d1",
			"check-d1-verify-1",
			"ship",
			"receipt",
		]);
	});

	it("stops at a per-deliverable gate and declares nothing after it", async () => {
		const delegated = scripted();
		const service = await serviceFor(delegated);
		const run = await service.run(
			"plan-to-ship",
			input({
				deliverables: 2,
				lensesPerDeliverable: [],
				policy: { gates: "every-deliverable" },
			}),
		);
		const first = await park(service, run.runId, "approve-d0");
		await decide(service, first, "approve-d0", {
			proceed: false,
			note: "wrong direction",
		});
		const finished = await bounded(service.wait(run.runId), "wait");

		expect(finished.status).toBe("completed");
		expect(taskPaths(finished)).not.toContain("implement-d1");
		expect(taskPaths(finished)).not.toContain("ship");
		expect(finished.output).toMatchObject({
			approved: true,
			shipped: false,
			deliverables: [{ id: "d0" }],
		});
		expect(
			(finished.output as { receipt: { note: string } }).receipt.note,
		).toContain("stopped at gate approve-d0");
	});
});

describe("plan-to-ship: replay", () => {
	it("re-declares the identical prefix on every drive, including after a restart", async () => {
		// Every decision re-executes the definition from the top and re-declares
		// every task of every epoch already crossed; a prefix that did not match
		// fails materialization with "barrier does not match the persisted ordered
		// epoch". This run crosses four gates, so the prefix is re-derived four
		// times — the last of them from a service that never saw the earlier ones.
		const delegated = scripted({ check: "fail-then-pass" });
		const service = await serviceFor(delegated);
		const base = path.resolve(".pi", "test-plan-to-ship", randomUUID());
		const cwd = path.join(base, "project");
		await mkdir(cwd, { recursive: true });
		const options = {
			cwd,
			agentDir: path.join(base, "agent"),
			storeRoot: path.join(cwd, "state"),
			projectTrusted: () => false,
			subagents: delegated.provider,
			registeredRoots: [
				{ path: BUILTIN_ROOT, scope: "builtin" as const, source: "package" },
			],
		};
		const first = await createWorkflowService(options);
		services.push(first);
		const run = await first.run(
			"plan-to-ship",
			input({ deliverables: 2, policy: { gates: "every-deliverable" } }),
		);
		const gateOne = await park(first, run.runId, "approve-d0");
		const prefix = taskPaths(gateOne);
		await decide(first, gateOne, "approve-d0", { proceed: true });
		const ship = await park(first, run.runId, "ship");
		expect(taskPaths(ship).slice(0, prefix.length)).toEqual(prefix);

		// A restart: a second service over the same store finishes the run.
		await first.shutdown();
		services.splice(services.indexOf(first), 1);
		const second = await createWorkflowService(options);
		services.push(second);
		const reopened = await second.status(run.runId);
		expect(taskPaths(reopened).slice(0, prefix.length)).toEqual(prefix);
		await decide(second, reopened, "ship", { ship: true });
		const finished = await bounded(second.wait(run.runId), "wait");
		expect(finished.status).toBe("completed");
		expect(taskPaths(finished).slice(0, prefix.length)).toEqual(prefix);
		expect(taskPaths(finished)).toEqual([
			"refine",
			"implement-d0",
			"check-d0-verify-1",
			"check-d0-fix-1",
			"check-d0-verify-2",
			"review-d0/correctness",
			"synthesis-d0",
			"approve-d0",
			"implement-d1",
			"check-d1-verify-1",
			"check-d1-fix-1",
			"check-d1-verify-2",
			"review-d1/correctness",
			"synthesis-d1",
			"ship",
			"receipt",
		]);
		expect(service).toBeDefined();
	});
});

describe("plan-to-ship: a reviewer that dies", () => {
	// The spec wants an optional reviewer to degrade the run rather than kill an
	// approved implementation, and `reviewFanOut` declares them `optional` and
	// reads `ctx.settled` for exactly that. The runtime blocks every task
	// declared after a barrier that closed over a failed one, though, so the
	// cost is recorded here rather than claimed away; see the definition's
	// header and `deep-review`'s.
	it("still asks the ship gate when every lens died, and names no review there", async () => {
		const delegated = scripted({ failReview: true });
		const service = await serviceFor(delegated);
		const run = await service.run("plan-to-ship", input());
		const ship = await park(service, run.runId, "ship");

		// No lens reported, so `synthesis: "optional"` declared no reducer and the
		// gate names only what exists. A dead reviewer subtracts coverage; it does
		// not park the gate it was meant to inform.
		expect(
			Object.keys(taskByKey(ship, "ship").checkpoint?.inputs ?? {}),
		).toEqual(["plan", "summary-d0"]);
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(run.runId), "wait");

		// Degraded, not failed: the implementation was approved and its handoff is
		// imported and shipped; what is missing is the review, and the output says
		// so by reporting no verdicts.
		expect(finished.status).toBe("completed-degraded");
		expect(taskByKey(finished, "implement-d0")).toMatchObject({
			status: "completed",
			handoff: { mediaType: PATCH_MEDIA_TYPE },
		});
		expect(taskByKey(finished, "review-d0/correctness").status).toBe("failed");
		expect(finished.output).toMatchObject({
			shipped: true,
			reviews: [],
			findings: [],
		});
	});

	it("records what a half-dead fan-out costs the synthesis declared after it", async () => {
		// The honest half: a barrier's control edge covers every task it closed
		// over, so the reducer declared after `ctx.settled` is blocked when one
		// lens failed - even though its `inputs` name only the lens that reported.
		// `deep-review` records the same cost. The verdict and the findings are
		// computed on the deterministic rail either way.
		const delegated = scripted({ failLens: "b" });
		const service = await serviceFor(delegated);
		const run = await service.run(
			"plan-to-ship",
			input({ lensesPerDeliverable: ["a", "b"] }),
		);
		const ship = await park(service, run.runId, "ship");
		expect(taskByKey(ship, "review-d0/a").status).toBe("completed");
		expect(taskByKey(ship, "review-d0/b").status).toBe("failed");
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(run.runId), "wait");
		expect(finished.status).toBe("completed-degraded");
		expect(finished.output).toMatchObject({
			shipped: true,
			reviews: [{ deliverable: "d0", lens: "a", blocking: true }],
		});
	});
});

describe("plan-to-ship: the effort dial", () => {
	it("reads every model and limit from the envelope table", async () => {
		const runs: Record<string, Scripted> = {};
		for (const effort of ["cheap", "deep"] as const) {
			const delegated = scripted();
			const service = await serviceFor(delegated);
			const run = await service.run(
				"plan-to-ship",
				input({ effort, lensesPerDeliverable: ["a", "b"] }),
			);
			await park(service, run.runId, "ship");
			runs[effort] = delegated;
		}
		const cheap = runs.cheap as Scripted;
		const deep = runs.deep as Scripted;

		// The lens list is the PLAN's, not the effort column's: both efforts run
		// every lens the deliverable asked for, exactly once.
		expect(cheap.requestsFor("reviewer")).toHaveLength(3); // two lenses + synthesis
		expect(deep.requestsFor("reviewer")).toHaveLength(3);

		expect(cheap.requestsFor("implementer")[0]?.model).toEqual(
			envelope("cheap", "implement").model,
		);
		expect(deep.requestsFor("implementer")[0]?.model).toEqual(
			envelope("deep", "implement").model,
		);
		expect(
			cheap.requestsFor("implementer")[0]?.limits.cumulativeRuntimeMs,
		).toBeLessThan(
			deep.requestsFor("implementer")[0]?.limits.cumulativeRuntimeMs ?? 0,
		);
		// `cheap` pays for no fix round, so it verifies once; `deep` pays for two.
		expect(cheap.requestsGoal("Verify deliverable")).toHaveLength(1);
	});

	it("resolves a diverse lens to the other-family stand-in and says so", async () => {
		const delegated = scripted();
		const service = await serviceFor(delegated);
		const run = await service.run(
			"plan-to-ship",
			input({ lensesPerDeliverable: ["a"], diverse: true }),
		);
		await park(service, run.runId, "ship");
		const [review] = delegated.requestsFor("reviewer");
		expect(review?.model?.id).toBe(DIVERSE_MODEL_ID);
	});

	it("honours a review task's tier and its exact model pin", async () => {
		const delegated = scripted();
		const service = await serviceFor(delegated);
		const run = await service.run(
			"plan-to-ship",
			input({
				effort: "cheap",
				lensesPerDeliverable: ["security"],
				tier: "heavy",
				pinnedModel: "github-copilot/gpt-5.6-luna",
			}),
		);
		await park(service, run.runId, "ship");
		expect(delegated.requestsFor("reviewer")[0]?.model).toEqual({
			provider: "github-copilot",
			id: "gpt-5.6-luna",
			// `heavy` outranks the cheap column's `low`.
			thinking: "high",
		});
	});
});

describe("plan-to-ship: the input contract", () => {
	it("accepts the v5 shape, with and without `effort`", async () => {
		const service = await serviceFor(scripted());
		for (const value of [
			input(),
			input({ effort: "deep" }),
			input({ policy: { effort: "cheap", gates: "ship" } }),
			input({ lensesPerDeliverable: [] }),
			{ ...input(), plan: { ...plan(), body: "Why this plan exists." } },
			input({
				lensesPerDeliverable: ["contracts", "replay"],
				tier: "heavy",
				diverse: true,
				pinnedModel: "github-copilot/gpt-5.6-sol",
			}),
		]) {
			await expect(
				service.validate("plan-to-ship", value),
			).resolves.toMatchObject({ valid: true });
		}
	});

	it.each([
		[
			"tasks[].review",
			() => withTaskKey(plan(), "review", { lens: "correctness" }),
			"plan schema v5 moved review routing to `deliverables[].reviews`",
		],
		[
			"tasks[].by",
			() => withTaskKey(plan(), "by", { lens: "correctness" }),
			"plan schema v3's name for a task review",
		],
		[
			"deliverables[].stages",
			() => withStages(plan(), [{ use: "implement", id: "build" }]),
			"plan schema v5 does not author stages",
		],
		[
			"policy.gates: approve-plan",
			() => ({ ...plan(), policy: { gates: "approve-plan" as const } }),
			"which was removed because the start of the run IS the approval",
		],
		[
			"policy.gates: approve-plan+ship",
			() => ({ ...plan(), policy: { gates: "approve-plan+ship" as const } }),
			"which was removed because the start of the run IS the approval",
		],
	])(
		"admits %s at validate, so the refusal is the compiler's",
		async (_key, document, message) => {
			// The plan mirror carries the refused keys on purpose: refused by
			// TypeBox they would read as an unexpected property, and a person
			// cannot act on that. They parse, and the compiler then names them.
			const service = await serviceFor(scripted());
			const value = { ...input(), plan: document() };
			await expect(
				service.validate("plan-to-ship", value),
			).resolves.toMatchObject({ valid: true });
			expect(() => compileStages(value.plan)).toThrow(message);
		},
	);

	it("refuses a bad digest, a bad effort, and an unknown plan field", async () => {
		const service = await serviceFor(scripted());
		for (const bad of [
			{ ...input(), planDigest: "not-a-digest" },
			{ ...input(), effort: "standrd" },
			{ ...input(), extra: true },
			{ ...input(), plan: { ...plan(), policy: { gates: "sometimes" } } },
			// A deliverable is work, or it is nothing: `tasks` is required and
			// non-empty, and `reviews` is a closed list of lens entries.
			{
				...input(),
				plan: {
					...plan(),
					deliverables: [
						{ id: "d0", title: "t", after: [], reads: [], tasks: [] },
					],
				},
			},
			{
				...input(),
				plan: {
					...plan(),
					deliverables: [
						{
							id: "d0",
							title: "t",
							after: [],
							reads: [],
							tasks: [{ id: "w0", title: "Write the code" }],
							reviews: [{ lens: "correctness", verdict: "nope" }],
						},
					],
				},
			},
		]) {
			await expect(service.validate("plan-to-ship", bad)).rejects.toMatchObject(
				{
					code: "validation",
					message: "Workflow input does not match its schema.",
				},
			);
		}
	});
});

describe("plan-to-ship: the memory dial", () => {
	it.each([
		["cheap", 1 * 1024 * 1024 * 1024],
		["standard", 2 * 1024 * 1024 * 1024],
		["deep", 4 * 1024 * 1024 * 1024],
	] as const)(
		"asks for %s memory on every worktree task and says so in the instructions",
		async (effort, memoryBytes) => {
			const delegated = scripted();
			const service = await serviceFor(delegated);
			const run = await service.run("plan-to-ship", input({ effort }));
			const ship = await park(service, run.runId, "ship");
			await decide(service, ship, "ship", { ship: true });
			await bounded(service.wait(run.runId), "wait");

			const worktrees = delegated.requests.filter(
				(request) => request.workspace.mode === "worktree",
			);
			expect(worktrees.length).toBeGreaterThan(0);
			for (const request of worktrees) {
				expect(request.memoryBytes).toBe(memoryBytes);
				// The agent is told the same number it was granted; a fixed
				// "512 MiB" line would make it misreport a killed install.
				const said = request.task.instructions.filter((line) =>
					line.includes(`${memoryBytes / 1024 ** 3} GiB of memory`),
				);
				expect(said).toHaveLength(1);
			}
			// Read-only stages never ask for a grant; they take the agent ceiling.
			for (const request of delegated.requests) {
				if (request.workspace.mode === "worktree") continue;
				expect("memoryBytes" in request).toBe(false);
			}
		},
	);
});

describe("plan-to-ship: the agent templates", () => {
	it("parses all three through pi-subagent's own discovery", async () => {
		const agents = await discoverAgents([
			{ scope: "package", directory: AGENT_TEMPLATES, trusted: true },
		]);
		// The templates directory is shared by every builtin definition, so this
		// asserts the three THIS one names are there and parse, not that they are
		// the only templates the package ships.
		for (const name of ["implementer", "planner", "reviewer"]) {
			expect([...agents.keys()]).toContain(name);
		}
		const implementer = agents.get("implementer");
		expect(implementer?.workspaceModes).toEqual(["worktree"]);
		expect(implementer?.tools).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"edit",
			"write",
			"bash",
		]);
		// W1: the implementer must be allowed to install and build.
		expect(
			implementer?.limitCeiling.workspaceWriteBytes,
		).toBeGreaterThanOrEqual(W1.workspaceWriteBytes);
		// Revision 19: the raised memory ceiling, which the deep column spends
		// in full. It is a ceiling, so it must be at least the deepest request.
		expect(implementer?.memoryCeilingBytes).toBe(4 * 1024 * 1024 * 1024);
		expect(agents.get("planner")?.workspaceModes).toEqual(["read-only"]);
		expect(agents.get("reviewer")?.workspaceModes).toEqual(["read-only"]);
	});

	it("covers every request a deep run makes", async () => {
		const delegated = scripted({ check: "fail" });
		const service = await serviceFor(delegated);
		const run = await service.run(
			"plan-to-ship",
			input({ effort: "deep", lensesPerDeliverable: ["a", "b"] }),
		);
		const ship = await park(service, run.runId, "ship");
		await decide(service, ship, "ship", { ship: true });
		await bounded(service.wait(run.runId), "wait");

		const agents = await discoverAgents([
			{ scope: "package", directory: AGENT_TEMPLATES, trusted: true },
		]);
		// The deep column's cap: three verifiers and two fixers.
		expect(delegated.requestsGoal("Verify deliverable")).toHaveLength(
			MAX_VERIFY_ROUNDS,
		);
		expect(delegated.requestsGoal("Fix what the check reported")).toHaveLength(
			MAX_VERIFY_ROUNDS - 1,
		);
		expect(delegated.requests.length).toBeGreaterThan(0);
		for (const request of delegated.requests) {
			const agent = agents.get(request.agent);
			if (!agent) throw new Error(`no template for agent ${request.agent}`);
			// pi-subagent's preflight rules, applied here so a widened request
			// fails this test instead of a real run.
			for (const tool of request.tools) {
				expect(agent.tools).toContain(tool);
			}
			expect(agent.workspaceModes).toContain(request.workspace.mode);
			if (request.model) {
				expect(agent.allowedModels).toContain(
					`${request.model.provider}/${request.model.id}:${request.model.thinking}`,
				);
			}
			expect(request.limits.attemptTimeoutMs).toBeLessThanOrEqual(
				request.limits.cumulativeRuntimeMs,
			);
			// A request may narrow the agent's memory ceiling, never widen it.
			if (request.memoryBytes !== undefined) {
				expect(request.memoryBytes).toBeLessThanOrEqual(
					agent.memoryCeilingBytes,
				);
			}
			for (const key of Object.keys(request.limits) as Array<
				keyof typeof request.limits
			>) {
				const value = request.limits[key];
				const ceiling = agent.limitCeiling[key];
				if (value === undefined || ceiling === undefined) continue;
				expect(value).toBeLessThanOrEqual(ceiling);
			}
		}
		expect(MODEL_ID).toBeDefined();
	});
});
