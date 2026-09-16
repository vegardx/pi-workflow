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
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowService, type WorkflowService } from "../src/service.js";
import type {
	WorkflowServiceRunView,
	WorkflowServiceTaskView,
} from "../src/service-views.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";

// W2/W3 acceptance: the builtin plan-to-ship definition driven through the
// real service with a scripted subagent, and the agent templates it names held
// to the requests it actually makes. Every expectation below is the
// plan-to-ship spec (sections 2 and 5) or experiment W1's verdict, not the
// definition's implementation.

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

interface PlanOptions {
	readonly deliverables?: number;
	readonly lensesPerDeliverable?: readonly string[];
	readonly diverse?: boolean;
	readonly pinnedModel?: string;
}

function plan(options: PlanOptions = {}) {
	const count = options.deliverables ?? 1;
	const lenses = options.lensesPerDeliverable ?? ["correctness"];
	return {
		slug: "sample-plan",
		title: "Sample plan",
		deliverables: Array.from({ length: count }, (_unused, index) => ({
			id: `d${index}`,
			title: `Deliverable ${index}`,
			after: [],
			reads: [],
			tasks: [
				{ id: `w${index}`, title: "Write the code" },
				...lenses.map((lens, lensIndex) => ({
					id: `r${index}-${lensIndex}`,
					title: `Review: ${lens}`,
					by: {
						lens,
						...(options.diverse ? { diverse: true } : {}),
						...(options.pinnedModel ? { model: options.pinnedModel } : {}),
					},
				})),
			],
		})),
		repos: [{ key: "main", path: "/repo" }],
	};
}

function input(options: PlanOptions & { effort?: string } = {}) {
	return {
		plan: plan(options),
		planDigest: PLAN_DIGEST,
		effort: options.effort ?? "standard",
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

/** The structured output a scripted child returns, keyed by what it was asked. */
function outputFor(request: SubagentRequest): unknown {
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
	if (goal.startsWith("Implement deliverable")) {
		return {
			summary: "Edited a.txt",
			files: ["a.txt"],
			checkCommand: "npm run check",
			checkRan: true,
			checkPassed: true,
			checkTail: "ok",
		};
	}
	if (goal.startsWith("Review deliverable")) {
		return {
			verdict: "request-changes",
			findings: [{ severity: "blocking", summary: "Missing a test." }],
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
function scripted(options: { readonly failReview?: boolean } = {}) {
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
		const child = childOf(runId);
		const worktree = child.request.workspace.mode === "worktree";
		const failed =
			options.failReview === true &&
			child.request.task.goal.startsWith("Review deliverable");
		const result = {
			runId,
			status: failed ? ("failed" as const) : ("completed" as const),
			...(failed ? {} : { structuredOutput: outputFor(child.request) }),
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
						contractRevision: 7,
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
		storeRoot: path.join(cwd, ".pi", "workflow"),
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
	const task = (view.tasks ?? []).find((entry) => entry.key === key);
	if (!task) throw new Error(`missing task ${key}`);
	return task;
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

describe("plan-to-ship: the approval gate", () => {
	it("returns approved: false and launches no implementer when the plan is declined", async () => {
		const delegated = scripted();
		const service = await serviceFor(delegated);
		const receipt = await service.run("plan-to-ship", input());
		const parked = await park(service, receipt.runId, "approve-plan");

		// The approver is shown the refined plan, not the authored one.
		expect(taskByKey(parked, "approve-plan").checkpoint?.inputs).toMatchObject({
			plan: { summary: "Refined." },
		});
		// Only the refiner has run; nothing has been written anywhere.
		expect(delegated.requests).toHaveLength(1);
		expect(delegated.requests[0]?.workspace.mode).toBe("read-only");

		await decide(service, parked, "approve-plan", {
			proceed: false,
			note: "not now",
		});
		const finished = await bounded(service.wait(receipt.runId), "wait");
		expect(finished).toMatchObject({
			status: "completed",
			output: {
				approved: false,
				shipped: false,
				deliverables: [],
				reviews: [],
				receipt: { planDigest: PLAN_DIGEST, refs: [], note: "not now" },
			},
		});
		// No worktree task was ever declared, so no tree was touched.
		expect(
			delegated.requests.some(
				(request) => request.workspace.mode === "worktree",
			),
		).toBe(false);
		expect((finished.tasks ?? []).map((task) => task.key)).toEqual([
			"refine",
			"approve-plan",
		]);
	});
});

describe("plan-to-ship: approved, reviewed, shipped", () => {
	async function approvedRun(options: PlanOptions & { effort?: string } = {}) {
		const delegated = scripted();
		const service = await serviceFor(delegated);
		const receipt = await service.run("plan-to-ship", input(options));
		const approve = await park(service, receipt.runId, "approve-plan");
		await decide(service, approve, "approve-plan", { proceed: true });
		const ship = await park(service, receipt.runId, "ship");
		return { delegated, service, runId: receipt.runId, ship };
	}

	it("launches the implementer with W1's limits and the cache instruction", async () => {
		const { delegated } = await approvedRun();
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

	it("imports the handoff and hands its descriptor to the reviewer", async () => {
		const { delegated, service, runId, ship } = await approvedRun();
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

		// The ship gate shows the summaries, the check results, and the verdicts.
		const gate = taskByKey(ship, "ship").checkpoint;
		expect(gate?.inputs).toMatchObject({
			"summary-0": { checkRan: true, checkPassed: true, files: ["a.txt"] },
			"review-0": { verdict: "request-changes" },
		});
		expect(gate?.prompt).toContain("1 blocking finding(s)");
	});

	it("records a receipt naming the handoff ref, its digest, and the plan digest", async () => {
		const { delegated, service, runId, ship } = await approvedRun();
		const child = delegated.childFor("Implement deliverable");
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
					handoff: { sha256: sha256(patchFor(commitFor(child.attemptId))) },
				},
			],
			reviews: [
				{ lens: "correctness", verdict: "request-changes", blocking: true },
			],
			receipt: { planDigest: PLAN_DIGEST, refs: [ref] },
		});
		// (h) The required finalizer ran after the output was committed, and could
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
		const { service, runId, ship } = await approvedRun();
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

describe("plan-to-ship: a reviewer that dies", () => {
	// The spec wants an optional reviewer to degrade the run rather than kill an
	// approved implementation, and the reviewers are declared `optional` for
	// exactly that. The runtime blocks every task that depends on a failed one
	// regardless of its disposition, though, and the ship gate must depend on
	// the verdicts it shows. This test records what that costs today so a change
	// to either side is visible; see the definition's header.
	it("blocks the ship gate, and the handoff it already imported survives in the run", async () => {
		const delegated = scripted({ failReview: true });
		const service = await serviceFor(delegated);
		const run = await service.run("plan-to-ship", input());
		const approve = await park(service, run.runId, "approve-plan");
		await decide(service, approve, "approve-plan", { proceed: true });
		const finished = await bounded(service.wait(run.runId), "wait");

		expect(finished.status).toBe("failed");
		expect(taskByKey(finished, "implement-d0")).toMatchObject({
			status: "completed",
			handoff: { mediaType: PATCH_MEDIA_TYPE },
		});
		expect(taskByKey(finished, "ship").status).toBe("blocked");
	});
});

describe("plan-to-ship: the effort dial", () => {
	it("spends the cheap column on one lens and the deep column on all of them, twice", async () => {
		const cheap = scripted();
		const cheapService = await serviceFor(cheap);
		const cheapRun = await cheapService.run(
			"plan-to-ship",
			input({ effort: "cheap", lensesPerDeliverable: ["a", "b"] }),
		);
		const cheapGate = await park(cheapService, cheapRun.runId, "approve-plan");
		await decide(cheapService, cheapGate, "approve-plan", { proceed: true });
		await park(cheapService, cheapRun.runId, "ship");

		const deep = scripted();
		const deepService = await serviceFor(deep);
		const deepRun = await deepService.run(
			"plan-to-ship",
			input({ effort: "deep", lensesPerDeliverable: ["a", "b"] }),
		);
		const deepGate = await park(deepService, deepRun.runId, "approve-plan");
		await decide(deepService, deepGate, "approve-plan", { proceed: true });
		await park(deepService, deepRun.runId, "ship");

		// cheap: the first lens only. deep: every lens, twice.
		expect(cheap.requestsFor("reviewer")).toHaveLength(1);
		expect(deep.requestsFor("reviewer")).toHaveLength(4);

		// The thinking level and the budgets come from the table, per stage.
		expect(cheap.requestsFor("implementer")[0]?.model).toMatchObject({
			thinking: "low",
		});
		expect(deep.requestsFor("implementer")[0]?.model).toMatchObject({
			thinking: "high",
		});
		expect(
			cheap.requestsFor("implementer")[0]?.limits.cumulativeRuntimeMs,
		).toBeLessThan(
			deep.requestsFor("implementer")[0]?.limits.cumulativeRuntimeMs ?? 0,
		);

		// deep's second copy of each lens is the other-family pass; today that is
		// a second exact model, the stand-in for real routing.
		const deepModels = deep
			.requestsFor("reviewer")
			.map((request) => request.model?.id);
		expect(new Set(deepModels).size).toBe(2);
	});

	it("honours a review task's tier and its exact model pin", async () => {
		const delegated = scripted();
		const service = await serviceFor(delegated);
		const run = await service.run("plan-to-ship", {
			plan: {
				slug: "pinned",
				title: "Pinned",
				deliverables: [
					{
						id: "d0",
						title: "Deliverable 0",
						after: [],
						reads: [],
						tasks: [
							{
								id: "r0",
								title: "Review",
								by: {
									lens: "security",
									tier: "heavy",
									model: "github-copilot/gpt-5.6-luna",
								},
							},
						],
					},
				],
				repos: [{ key: "main", path: "/repo" }],
			},
			planDigest: PLAN_DIGEST,
			effort: "cheap",
		});
		const gate = await park(service, run.runId, "approve-plan");
		await decide(service, gate, "approve-plan", { proceed: true });
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
	it("refuses a bad digest, a bad effort, and an unknown plan field", async () => {
		const service = await serviceFor(scripted());
		await expect(
			service.validate("plan-to-ship", input()),
		).resolves.toMatchObject({
			valid: true,
		});
		for (const bad of [
			{ ...input(), planDigest: "not-a-digest" },
			{ ...input(), effort: "standrd" },
			{ ...input(), extra: true },
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
							tasks: [{ id: "r0", title: "Review", by: { verdict: "nope" } }],
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
		"asks for %s memory on every implement task and says so in the instructions",
		async (effort, memoryBytes) => {
			const delegated = scripted();
			const service = await serviceFor(delegated);
			const run = await service.run("plan-to-ship", input({ effort }));
			const gate = await park(service, run.runId, "approve-plan");
			await decide(service, gate, "approve-plan", { proceed: true });
			const ship = await park(service, run.runId, "ship");
			await decide(service, ship, "ship", { ship: true });
			await bounded(service.wait(run.runId), "wait");

			const implementers = delegated.requests.filter(
				(request) => request.agent === "implementer",
			);
			expect(implementers.length).toBeGreaterThan(0);
			for (const request of implementers) {
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
				if (request.agent === "implementer") continue;
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
		expect([...agents.keys()].sort()).toEqual([
			"implementer",
			"planner",
			"reviewer",
		]);
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
		const delegated = scripted();
		const service = await serviceFor(delegated);
		const run = await service.run(
			"plan-to-ship",
			input({ effort: "deep", lensesPerDeliverable: ["a", "b"] }),
		);
		const gate = await park(service, run.runId, "approve-plan");
		await decide(service, gate, "approve-plan", { proceed: true });
		const ship = await park(service, run.runId, "ship");
		await decide(service, ship, "ship", { ship: true });
		await bounded(service.wait(run.runId), "wait");

		const agents = await discoverAgents([
			{ scope: "package", directory: AGENT_TEMPLATES, trusted: true },
		]);
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
	});
});
