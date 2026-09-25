import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentLaunchPlan,
	canonicalSha256,
	type DiscoveredAgent,
	discoverAgents,
	SUBAGENT_RUNTIME_CONTRACT,
	type SubagentClient,
	type SubagentRequest,
} from "@vegardx/pi-subagent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DIVERSE_MODEL_ID,
	envelope,
	MAX_REVIEW_LENSES,
	MODEL_ID,
} from "../src/components/index.js";
import { discoverWorkflows } from "../src/registry.js";
import { createWorkflowService, type WorkflowService } from "../src/service.js";
import type {
	WorkflowServiceRunView,
	WorkflowServiceTaskView,
} from "../src/service-views.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";

// W1-DEEPREVIEW acceptance: the builtin `deep-review` definition driven
// through the real service with a scripted subagent, and the agent template it
// names held to the requests it actually makes. Every expectation below is the
// plan-loop spec (sections 2.2, 2.3 and 5) or a component's documented rule,
// not the definition's implementation.

const BUILTIN_ROOT = fileURLToPath(new URL("../workflows", import.meta.url));
const AGENT_TEMPLATES = fileURLToPath(
	new URL("../workflows/agents", import.meta.url),
);
const REVIEWER_AGENT = "lens-reviewer";
const EFFORTS = ["cheap", "standard", "deep"] as const;

type Effort = (typeof EFFORTS)[number];

interface Lens {
	readonly id: string;
	readonly tier?: "light" | "standard" | "heavy";
	readonly diverse?: boolean;
	readonly skill?: string;
	readonly model?: string;
	readonly brief?: string;
}

function treeSubject() {
	return {
		kind: "tree" as const,
		title: "The component library",
		summary: "src/components/*.ts as it stands on this branch.",
	};
}

function handoffSubject() {
	return {
		kind: "worktree-handoff" as const,
		title: "Deliverable d0",
		summary: "One patch, exported from a worktree.",
		handoff: {
			artifactId: `artifact_${"e".repeat(64)}`,
			runId: "workflow_deepreview",
			producerTaskId: `task_${"f".repeat(16)}`,
			producerExecutionId: `execution_${"a".repeat(16)}`,
			subagentRunId: "run_child1",
			subagentAttemptId: "attempt_child1",
			baselineHead: "b".repeat(40),
			handoffCommit: "c".repeat(40),
			format: "git-format-patch" as const,
			mediaType: "application/x-git-format-patch" as const,
			sha256: "d".repeat(64),
			bytes: 512,
		},
	};
}

function input(
	options: {
		readonly lenses?: readonly Lens[];
		readonly effort?: Effort;
		readonly synthesis?: "required" | "optional" | "none";
		readonly maxFindings?: number;
		readonly subject?: unknown;
	} = {},
) {
	return {
		subject: options.subject ?? treeSubject(),
		...(options.lenses ? { lenses: options.lenses } : {}),
		effort: options.effort ?? "standard",
		...(options.synthesis ? { synthesis: options.synthesis } : {}),
		...(options.maxFindings === undefined
			? {}
			: { maxFindings: options.maxFindings }),
	};
}

/** The lens a goal names: `Review "<subject>" through the "<lens>" lens.` */
function lensOf(request: SubagentRequest): string | undefined {
	return /through the "([a-z0-9-]+)" lens/.exec(request.task.goal)?.[1];
}

function isSynthesis(request: SubagentRequest): boolean {
	return request.task.goal.startsWith("Synthesize the review");
}

/**
 * The scripted child's structured output. Two lenses raise the SAME finding in
 * different words and casing, so the merge has something to de-duplicate.
 */
function outputFor(request: SubagentRequest): unknown {
	if (isSynthesis(request)) {
		return { synthesis: "Both lenses agree the barrier is missing." };
	}
	const lens = lensOf(request);
	if (lens === undefined) {
		throw new Error(`no scripted output for goal: ${request.task.goal}`);
	}
	if (lens === "contracts") {
		return {
			verdict: "approve",
			findings: [
				{
					id: "missing-barrier",
					severity: "blocking",
					kind: "graph",
					where: "/run/review",
					// The same finding as `correctness` raises, normalized away:
					// case, inner whitespace and the trailing stop are not
					// differences.
					what: "the   fan-out has no barrier.",
				},
			],
		};
	}
	return {
		verdict: "request-changes",
		findings: [
			{
				id: `${lens}-1`,
				severity: "blocking",
				kind: "graph",
				where: "/run/review",
				what: "The fan-out has no barrier",
			},
			{
				id: `${lens}-2`,
				severity: "minor",
				kind: "ambiguity",
				where: `/run/${lens}`,
				what: `The ${lens} lens found a small thing.`,
			},
		],
	};
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
 * pi-subagent's own resolution on a host whose agent discovery is empty: the
 * definition must come from the roots the request carried, or preflight fails
 * with the refusal the service raises.
 */
async function resolveLikeSubagent(
	request: SubagentRequest,
): Promise<DiscoveredAgent> {
	const agents = await discoverAgents(
		(request.agentRoots ?? []).map((directory) => ({
			scope: "package" as const,
			directory,
			trusted: true,
		})),
	);
	const agent = agents.get(request.agent);
	if (!agent) throw new Error(`agent not found: ${request.agent}`);
	return agent;
}

/**
 * A scripted owner client: every preflight is remembered, every launch mints a
 * child, and every child answers with the structured output its goal calls
 * for. `failLenses` kills exactly those lenses, which is how a degraded
 * fan-out is exercised.
 */
function scripted(
	options: {
		readonly failLenses?: readonly string[];
		/**
		 * Resolve each request's agent the way pi-subagent does on a host that
		 * discovers none of its own: from the roots the request carried, or the
		 * refusal the service raises.
		 */
		readonly resolveAgents?: boolean;
	} = {},
) {
	const nonce = randomUUID().replaceAll("-", "").slice(0, 8);
	const pending = new Map<string, Child>();
	const children = new Map<string, Child>();
	const statuses = new Map<string, "completed" | "failed">();
	const requests: SubagentRequest[] = [];
	const resolvedAgents: DiscoveredAgent[] = [];
	let preflights = 0;
	let ownerId = "";

	const preflight = vi.fn(async (request: SubagentRequest) => {
		const resolved = options.resolveAgents
			? await resolveLikeSubagent(request)
			: undefined;
		if (resolved) resolvedAgents.push(resolved);
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
			agentPrompt: resolved?.prompt ?? "prompt",
			agentSource: resolved?.source ?? "/agent.md",
			agentSha256: resolved?.sha256 ?? "a".repeat(64),
			agentScope: resolved?.scope ?? ("global" as const),
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
		const lens = lensOf(child.request);
		const failed =
			lens !== undefined && (options.failLenses ?? []).includes(lens);
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
			error: failed ? "reviewer produced nothing" : undefined,
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
		resolvedAgents,
		/** Every lens request, in declaration order. */
		lensRequests(): SubagentRequest[] {
			return requests.filter((request) => lensOf(request) !== undefined);
		},
		synthesisRequest(): SubagentRequest | undefined {
			return requests.find((request) => isSynthesis(request));
		},
	};
}

type Scripted = ReturnType<typeof scripted>;

const services: WorkflowService[] = [];

afterEach(async () => {
	while (services.length > 0) await services.pop()?.shutdown();
});

async function serviceFor(delegated: Scripted): Promise<WorkflowService> {
	const base = path.resolve(".pi", "test-deep-review", randomUUID());
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

/** A task by its full `${namespace}/${key}` path. */
function taskByPath(
	view: WorkflowServiceRunView,
	full: string,
): WorkflowServiceTaskView {
	const task = (view.tasks ?? []).find(
		(entry) => [...entry.namespace, entry.key].join("/") === full,
	);
	if (!task) throw new Error(`missing task ${full}`);
	return task;
}

function taskPaths(view: WorkflowServiceRunView): string[] {
	return (view.tasks ?? []).map((task) =>
		[...task.namespace, task.key].join("/"),
	);
}

async function runDeepReview(
	options: Parameters<typeof input>[0] & {
		readonly failLenses?: readonly string[];
	} = {},
) {
	const delegated = scripted(
		options.failLenses ? { failLenses: options.failLenses } : {},
	);
	const service = await serviceFor(delegated);
	const receipt = await service.run("deep-review", input(options));
	const finished = await bounded(service.wait(receipt.runId), "deep-review");
	return { delegated, service, runId: receipt.runId, finished };
}

describe("deep-review: discovery", () => {
	it("is discovered under the builtin root with scope builtin", async () => {
		const root = path.resolve(".pi", "test-deep-review", randomUUID());
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
		const found = workflows.workflows.find(
			(entry) => entry.definition.meta.name === "deep-review",
		);
		if (!found) throw new Error("deep-review was not discovered");
		expect(found.scope).toBe("builtin");
		expect(found.source).toBe("package");
		expect(path.basename(found.path)).toBe("deep-review.workflow.ts");
		// No gate, no worktree: the definition promises a read-only review, and
		// the budget covers the worst case the input schema admits.
		expect(found.definition.meta.budget.cost).toBeGreaterThanOrEqual(
			MAX_REVIEW_LENSES * envelope("deep", "review").budgetShare.cost,
		);
	});
});

describe("deep-review: the lowered graph", () => {
	it("declares one optional reviewer per lens over the subject and a synthesis fan-in", async () => {
		const { delegated, finished } = await runDeepReview({
			lenses: [{ id: "correctness" }, { id: "contracts" }, { id: "risk" }],
			subject: handoffSubject(),
		});

		expect(finished.status).toBe("completed");
		// `key = lens.id` inside the `review` namespace; the reducer is
		// `<ns>-synthesis` at the root.
		expect(taskPaths(finished).sort()).toEqual([
			"review-synthesis",
			"review/contracts",
			"review/correctness",
			"review/risk",
		]);
		for (const lens of ["correctness", "contracts", "risk"]) {
			const task = taskByPath(finished, `review/${lens}`);
			// One flaky lens must not fail an otherwise complete review.
			expect(task.disposition).toBe("optional");
			expect(task.status).toBe("completed");
		}

		// Every lens reviews the same subject, read-only, through the one agent.
		const lensRequests = delegated.lensRequests();
		expect(lensRequests).toHaveLength(3);
		expect(lensRequests.map((request) => lensOf(request))).toEqual([
			"correctness",
			"contracts",
			"risk",
		]);
		for (const request of lensRequests) {
			expect(request.agent).toBe(REVIEWER_AGENT);
			expect(request.workspace.mode).toBe("read-only");
			expect(request.tools).toEqual(["read", "grep", "find", "ls"]);
			const context = request.task.context.join("\n");
			expect(context).toContain("Deliverable d0");
			// The handoff travels as identity, never as patch bytes.
			expect(context).toContain("c".repeat(40));
			expect(context).not.toContain("From: Agent");
			expect(request.task.instructions.join("\n")).toContain(
				"the patch's IDENTITY",
			);
		}

		// The reducer's inputs are the lenses that reported, named by lens key.
		const synthesis = delegated.synthesisRequest();
		if (!synthesis) throw new Error("no synthesis request");
		expect(synthesis.tools).toEqual([]);
		const reduced = synthesis.task.context.join("\n");
		for (const lens of ["correctness", "contracts", "risk"]) {
			expect(reduced).toContain(`"name":"${lens}"`);
		}
	});

	it("declares no reducer when synthesis is none", async () => {
		const { finished } = await runDeepReview({
			lenses: [{ id: "correctness" }],
			synthesis: "none",
		});
		expect(finished.status).toBe("completed");
		expect(taskPaths(finished)).toEqual(["review/correctness"]);
		expect(finished.output).not.toHaveProperty("synthesis");
	});
});

describe("deep-review: the merged report", () => {
	it("completes with a merged verdict, de-duplicated findings, and a synthesis", async () => {
		const { finished } = await runDeepReview({
			lenses: [{ id: "correctness" }, { id: "contracts" }],
		});
		expect(finished.status).toBe("completed");
		const output = finished.output as {
			verdict: string;
			findings: { id: string; severity: string; what: string }[];
			coverage: { lens: string; reported: boolean; verdict?: string }[];
			synthesis?: string;
		};
		// A blocking finding forces the verdict even though `contracts` approved.
		expect(output.verdict).toBe("request-changes");
		// Both lenses raised the same barrier finding in different words; it
		// survives once, owned by the lens with the lower declaration ordinal.
		expect(
			output.findings.filter((finding) =>
				finding.what.toLowerCase().includes("barrier"),
			),
		).toHaveLength(1);
		expect(output.findings[0]).toMatchObject({
			id: "correctness-1",
			severity: "blocking",
		});
		expect(output.coverage).toEqual([
			{ lens: "correctness", reported: true, verdict: "request-changes" },
			{ lens: "contracts", reported: true, verdict: "approve" },
		]);
		expect(output.synthesis).toBe("Both lenses agree the barrier is missing.");
	});

	it("honours maxFindings by dropping the tail of the severity order", async () => {
		const { finished } = await runDeepReview({
			lenses: [{ id: "correctness" }, { id: "contracts" }],
			maxFindings: 1,
		});
		const output = finished.output as { findings: { severity: string }[] };
		expect(output.findings).toHaveLength(1);
		expect(output.findings[0]?.severity).toBe("blocking");
	});
});

describe("deep-review: a lens that dies", () => {
	it("degrades coverage instead of failing the run", async () => {
		const { delegated, finished } = await runDeepReview({
			lenses: [{ id: "correctness" }, { id: "contracts" }, { id: "risk" }],
			failLenses: ["risk"],
		});

		// The run does NOT fail: the reviewers are optional and the barrier is
		// `ctx.settled`, so a dead lens subtracts coverage and the verdict, the
		// findings and the coverage are all still committed as the run's output.
		// It completes DEGRADED, which is the honest status for a review that
		// lost a lens.
		expect(finished.status).toBe("completed-degraded");
		expect(taskByPath(finished, "review/risk").status).toBe("failed");
		const output = finished.output as {
			verdict: string;
			findings: unknown[];
			coverage: { lens: string; reported: boolean; verdict?: string }[];
			synthesis?: string;
		};
		expect(output.verdict).toBe("request-changes");
		expect(output.findings.length).toBeGreaterThan(0);
		expect(output.coverage).toEqual([
			{ lens: "correctness", reported: true, verdict: "request-changes" },
			{ lens: "contracts", reported: true, verdict: "approve" },
			{ lens: "risk", reported: false },
		]);

		// The reducer named only the lenses that reported, and was blocked by the
		// barrier's control edge rather than by a data dependency on the dead
		// lens: the limitation this definition's header states.
		expect(taskByPath(finished, "review-synthesis")).toMatchObject({
			disposition: "optional",
			status: "blocked",
		});
		expect(output.synthesis).toBeUndefined();
		expect(delegated.synthesisRequest()).toBeUndefined();
	});
});

describe("deep-review: the effort dial and diversity", () => {
	it("selects a different model id for a diverse lens", async () => {
		const { delegated, finished } = await runDeepReview({
			lenses: [{ id: "correctness" }, { id: "risk", diverse: true }],
		});
		expect(finished.status).toBe("completed");
		const byLens = new Map(
			delegated
				.lensRequests()
				.map((request) => [lensOf(request), request.model]),
		);
		expect(byLens.get("correctness")?.id).toBe(MODEL_ID);
		expect(byLens.get("risk")?.id).toBe(DIVERSE_MODEL_ID);
		expect(byLens.get("risk")?.id).not.toBe(byLens.get("correctness")?.id);
	});

	it("lets a tier outrank the effort column and an exact pin outrank both", async () => {
		const { delegated } = await runDeepReview({
			effort: "cheap",
			lenses: [
				{ id: "correctness" },
				{ id: "contracts", tier: "heavy" },
				{ id: "risk", model: "github-copilot/gpt-5.6-luna", tier: "light" },
			],
		});
		const byLens = new Map(
			delegated
				.lensRequests()
				.map((request) => [lensOf(request), request.model]),
		);
		// The cheap column is `low`; the tier moves only this lens.
		expect(byLens.get("correctness")?.thinking).toBe(
			envelope("cheap", "review").thinking,
		);
		expect(byLens.get("contracts")?.thinking).toBe("high");
		expect(byLens.get("risk")).toEqual({
			provider: "github-copilot",
			id: "gpt-5.6-luna",
			thinking: "low",
		});
	});

	it("spends the effort table's review and synthesis rows", async () => {
		for (const effort of EFFORTS) {
			const { delegated, finished } = await runDeepReview({
				effort,
				lenses: [{ id: "correctness" }],
			});
			expect(finished.status).toBe("completed");
			const review = envelope(effort, "review");
			const synthesis = envelope(effort, "synthesis");
			const [lens] = delegated.lensRequests();
			expect(lens?.model?.thinking).toBe(review.thinking);
			expect(lens?.limits).toEqual(review.limits);
			expect(delegated.synthesisRequest()?.limits).toEqual(synthesis.limits);
			// Read-only at every effort: nothing here may write.
			for (const request of delegated.requests) {
				expect(request.workspace.mode).toBe("read-only");
				expect(request.limits.workspaceWriteBytes).toBe(0);
			}
		}
	});
});

describe("deep-review: the input contract", () => {
	it("accepts every subject kind and refuses a malformed input", async () => {
		const service = await serviceFor(scripted());
		for (const subject of [treeSubject(), handoffSubject()]) {
			await expect(
				service.validate("deep-review", input({ subject })),
			).resolves.toMatchObject({ valid: true });
		}
		await expect(
			service.validate(
				"deep-review",
				input({
					subject: {
						kind: "document",
						title: "A spec",
						summary: "The spec under review.",
						document: "# Spec\n",
					},
				}),
			),
		).resolves.toMatchObject({ valid: true });
		// Lenses are optional; a caller with no opinion gets the defaults.
		await expect(
			service.validate("deep-review", {
				subject: treeSubject(),
				effort: "deep",
			}),
		).resolves.toMatchObject({ valid: true });

		for (const bad of [
			// A handoff subject with no handoff: refused, not discovered by a
			// reviewer with nothing to read.
			{
				...input(),
				subject: { ...handoffSubject(), handoff: undefined },
			},
			// A document subject carrying no document.
			{
				...input(),
				subject: {
					kind: "document",
					title: "A spec",
					summary: "The spec under review.",
				},
			},
			{ ...input(), effort: "standrd" },
			{ ...input(), extra: true },
			{ ...input({ lenses: [{ id: "Correctness" }] }) },
			{ ...input({ lenses: [] }) },
			{
				...input({
					lenses: Array.from(
						{ length: MAX_REVIEW_LENSES + 1 },
						(_unused, index) => ({ id: `lens-${index}` }),
					),
				}),
			},
			{ ...input(), maxFindings: 0 },
			{ ...input(), synthesis: "maybe" },
		]) {
			await expect(service.validate("deep-review", bad)).rejects.toMatchObject({
				code: "validation",
				message: "Workflow input does not match its schema.",
			});
		}
	});

	it("reviews the default lenses when the input names none", async () => {
		const { delegated, finished } = await runDeepReview();
		expect(finished.status).toBe("completed");
		expect(delegated.lensRequests().map((request) => lensOf(request))).toEqual([
			"correctness",
			"contracts",
			"risk",
		]);
	});
});

describe("deep-review: the agent template", () => {
	it("parses through pi-subagent's own discovery", async () => {
		const agents = await discoverAgents([
			{ scope: "package", directory: AGENT_TEMPLATES, trusted: true },
		]);
		const reviewer = agents.get(REVIEWER_AGENT);
		if (!reviewer) throw new Error("no lens-reviewer template");
		expect(reviewer.workspaceModes).toEqual(["read-only"]);
		expect(reviewer.tools).toEqual(["read", "grep", "find", "ls"]);
		// A reviewer never writes, at any effort.
		expect(reviewer.limitCeiling.workspaceWriteBytes).toBe(0);
		// Both families: a lens may ask for one other than the default.
		for (const id of [MODEL_ID, DIVERSE_MODEL_ID]) {
			for (const thinking of ["low", "medium", "high"]) {
				expect(reviewer.allowedModels).toContain(
					`github-copilot/${id}:${thinking}`,
				);
			}
		}
	});

	it("covers every request the definition makes at every effort", async () => {
		const agents = await discoverAgents([
			{ scope: "package", directory: AGENT_TEMPLATES, trusted: true },
		]);
		for (const effort of EFFORTS) {
			const { delegated, finished } = await runDeepReview({
				effort,
				lenses: [
					{ id: "correctness" },
					{ id: "contracts", tier: "heavy" },
					{ id: "risk", diverse: true },
				],
			});
			expect(finished.status).toBe("completed");
			expect(delegated.requests.length).toBe(4);
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
				expect(request.memoryBytes).toBeUndefined();
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

describe("deep-review: the templates a run carries", () => {
	it("hands a project that has no agents of its own the builtin templates", async () => {
		const delegated = scripted();
		const base = path.resolve(".pi", "test-deep-review", randomUUID());
		const cwd = path.join(base, "project");
		await mkdir(cwd, { recursive: true });
		const service = await createWorkflowService({
			cwd,
			agentDir: path.join(base, "agent"),
			storeRoot: path.join(cwd, "state"),
			projectTrusted: () => false,
			subagents: delegated.provider,
			registeredRoots: [
				{ path: BUILTIN_ROOT, scope: "builtin", source: "package" },
			],
		});
		services.push(service);
		// The reported symptom's shape: an arbitrary project cwd with neither a
		// `.pi/agents` of its own nor a host agent directory holding the
		// definitions this builtin names.
		await expect(stat(path.join(cwd, ".pi", "agents"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(
			stat(path.join(base, "agent", "agents")),
		).rejects.toMatchObject({ code: "ENOENT" });
		const receipt = await service.run("deep-review", input());
		const finished = await bounded(service.wait(receipt.runId), "deep-review");
		expect(finished.status).toBe("completed");
		expect(delegated.requests.length).toBeGreaterThan(0);
		const templates = await realpath(AGENT_TEMPLATES);
		for (const request of delegated.requests) {
			// Every request names the directory the definition's own root ships,
			// so the template travels with the run instead of being copied into
			// the host's agent directory first.
			expect(request.agentRoots).toEqual([templates]);
		}
	});

	it("preflights lens-reviewer from the templates the request carries", async () => {
		const delegated = scripted({ resolveAgents: true });
		const service = await serviceFor(delegated);
		const receipt = await service.run("deep-review", input());
		const finished = await bounded(service.wait(receipt.runId), "deep-review");
		expect(finished.status).toBe("completed");
		const templates = await realpath(AGENT_TEMPLATES);
		const reviewer = delegated.resolvedAgents.find(
			(agent) => agent.name === REVIEWER_AGENT,
		);
		if (!reviewer) throw new Error("lens-reviewer did not resolve");
		// Resolved from the package's own template file, under package scope,
		// which is what the host's empty discovery could not do.
		expect(reviewer.source).toBe(path.join(templates, `${REVIEWER_AGENT}.md`));
		expect(reviewer.scope).toBe("package");
		expect(delegated.resolvedAgents).toHaveLength(delegated.requests.length);
	});
});
