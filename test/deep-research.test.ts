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
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DIVERSE_MODEL_ID,
	envelope,
	MODEL_ID,
} from "../src/components/index.js";
import type { WorkflowDefinition } from "../src/definition.js";
import { discoverWorkflows } from "../src/registry.js";
import { createWorkflowService, type WorkflowService } from "../src/service.js";
import {
	BUILTIN_HEADLESS_WORKFLOWS,
	headlessBuiltinViolations,
} from "../src/service-provider.js";
import type {
	WorkflowServiceRunView,
	WorkflowServiceTaskView,
} from "../src/service-views.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";

// W3-RESEARCH acceptance: the builtin `deep-research` definition driven through
// the real service with a scripted subagent, and the agent template it names
// held to the requests it actually makes. Every expectation below is the
// plan-loop spec (sections 2.2, 2.3 and 5) or a component's documented rule,
// not the definition's implementation:
//
//   - structural headlessness: no checkpoint, no worktree, no handoff, over a
//     dry materialization of the real graph, and NOT a claim of membership on
//     `BUILTIN_HEADLESS_WORKFLOWS`, which names `plan-review` alone;
//   - the thread count is a pure function of `depth`, or of the sources;
//   - `forEach`'s key rule: the key is the item's own required id, so
//     reordering the sources moves the tasks without renaming any of them;
//   - a dead thread degrades the run instead of failing it, and the coverage
//     rows say which one died.

const BUILTIN_ROOT = fileURLToPath(new URL("../workflows", import.meta.url));
const AGENT_TEMPLATES = fileURLToPath(
	new URL("../workflows/agents", import.meta.url),
);
const RESEARCHER_AGENT = "researcher";
const DEPTHS = ["cheap", "standard", "deep"] as const;

/** The angle table the definition ships, by depth: the expected thread keys. */
const ANGLES_BY_DEPTH: Readonly<Record<Depth, readonly string[]>> =
	Object.freeze({
		cheap: ["evidence", "counterpoint"],
		standard: ["evidence", "counterpoint", "context"],
		deep: ["evidence", "counterpoint", "context", "alternatives", "risk"],
	});

type Depth = (typeof DEPTHS)[number];

interface Source {
	readonly id: string;
	readonly kind: "path" | "url" | "note";
	readonly ref?: string;
	readonly text?: string;
	readonly title?: string;
}

const QUESTION = "How does the component library keep replay deterministic?";

function pathSource(id: string): Source {
	return { id, kind: "path", ref: `src/components/${id}.ts` };
}

function noteSource(id: string): Source {
	return { id, kind: "note", text: `A note about ${id}.`, title: `Note ${id}` };
}

function urlSource(id: string): Source {
	return { id, kind: "url", ref: `https://example.invalid/${id}` };
}

function input(
	options: {
		readonly question?: string;
		readonly depth?: Depth;
		readonly sources?: readonly Source[];
	} = {},
) {
	return {
		question: options.question ?? QUESTION,
		depth: options.depth ?? "standard",
		...(options.sources ? { sources: options.sources } : {}),
	};
}

/** `Research "<question>" as the "<thread>" thread.` */
function researchThreadOf(request: SubagentRequest): string | undefined {
	if (!request.task.goal.startsWith("Research ")) return undefined;
	return / as the "([a-z0-9-]+)" thread\.$/.exec(request.task.goal)?.[1];
}

/** `Cross-check the "<checked>" thread's claims as the "<by>" thread.` */
function crossCheckOf(
	request: SubagentRequest,
): { checked: string; by: string } | undefined {
	const match =
		/^Cross-check the "([a-z0-9-]+)" thread's claims as the "([a-z0-9-]+)" thread\.$/.exec(
			request.task.goal,
		);
	if (!match?.[1] || !match[2]) return undefined;
	return { checked: match[1], by: match[2] };
}

function isSynthesis(request: SubagentRequest): boolean {
	return request.task.goal.startsWith("Answer ");
}

/** The merged claim ids a cross-check was actually handed, from its context. */
function claimsHandedTo(request: SubagentRequest): { id: string }[] {
	const parts = request.task.context.filter((entry) =>
		entry.startsWith("Claims made by"),
	);
	const json = parts
		.map((entry) => entry.slice(entry.indexOf("\n") + 1))
		.join("");
	return JSON.parse(json) as { id: string }[];
}

/**
 * The scripted child's structured output.
 *
 * Every thread raises a claim under the SAME id, so the merge has ids to make
 * unique; every thread also raises one of its own. A checker agrees with the
 * first claim it was handed and disagrees with the rest, and additionally
 * names a claim it was never handed and repeats one it was — both of which the
 * definition's rail must drop rather than report.
 */
function outputFor(request: SubagentRequest): unknown {
	if (isSynthesis(request)) {
		return {
			answer: "The library keeps replay deterministic by table lookup.",
		};
	}
	const cross = crossCheckOf(request);
	if (cross) {
		const claims = claimsHandedTo(request);
		return {
			checks: [
				...claims.map((claim, index) => ({
					claim: claim.id,
					agrees: index === 0,
					note: `${cross.by} checked ${claim.id}.`,
				})),
				// Never handed to this checker: dropped, not reported.
				{ claim: "ghost-claim", agrees: true, note: "not handed to me" },
				// A repeat of one it was handed: the first row wins.
				...(claims[0]
					? [{ claim: claims[0].id, agrees: false, note: "said twice" }]
					: []),
			],
		};
	}
	const thread = researchThreadOf(request);
	if (thread === undefined) {
		throw new Error(`no scripted output for goal: ${request.task.goal}`);
	}
	return {
		claims: [
			{
				id: "shared-claim",
				statement: `The ${thread} thread reaches the shared claim.`,
				support: [{ source: thread, quote: "a quote" }],
				confidence: "high",
			},
			{
				id: `${thread}-own`,
				statement: `The ${thread} thread found something of its own.`,
				support: [{ source: thread }],
				confidence: "medium",
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
 * A scripted owner client: every preflight is remembered, every launch mints a
 * child, and every child answers with the structured output its goal calls
 * for. `failThreads` kills exactly those research threads, which is how a
 * degraded fan-out is exercised.
 */
function scripted(options: { readonly failThreads?: readonly string[] } = {}) {
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
		const thread = researchThreadOf(child.request);
		const failed =
			thread !== undefined && (options.failThreads ?? []).includes(thread);
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
							message: "the thread produced nothing",
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
			error: failed ? "the thread produced nothing" : undefined,
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
		/** Every research request, in declaration order. */
		researchRequests(): SubagentRequest[] {
			return requests.filter(
				(request) => researchThreadOf(request) !== undefined,
			);
		},
		crossCheckRequests(): SubagentRequest[] {
			return requests.filter((request) => crossCheckOf(request) !== undefined);
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
	const base = path.resolve(".pi", "test-deep-research", randomUUID());
	const cwd = path.join(base, "project");
	await mkdir(cwd, { recursive: true });
	const service = await createWorkflowService({
		cwd,
		agentDir: path.join(base, "agent"),
		storeRoot: path.join(cwd, ".pi", "workflow"),
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

interface ResearchOutput {
	answer: string;
	claims: { id: string; statement: string; confidence: string }[];
	crossChecks: { claim: string; by: string; agrees: boolean; note?: string }[];
	coverage: {
		thread: string;
		reported: boolean;
		claims?: number;
		checkedBy?: string;
	}[];
}

async function runDeepResearch(
	options: Parameters<typeof input>[0] & {
		readonly failThreads?: readonly string[];
	} = {},
) {
	const delegated = scripted(
		options.failThreads ? { failThreads: options.failThreads } : {},
	);
	const service = await serviceFor(delegated);
	const receipt = await service.run("deep-research", input(options));
	const finished = await bounded(service.wait(receipt.runId), "deep-research");
	return {
		delegated,
		service,
		runId: receipt.runId,
		finished,
		output: finished.output as ResearchOutput,
	};
}

async function shippedDefinition(): Promise<WorkflowDefinition> {
	const root = path.resolve(".pi", "test-deep-research", randomUUID());
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
		(entry) => entry.definition.meta.name === "deep-research",
	);
	if (!found) throw new Error("deep-research was not discovered");
	return found.definition;
}

/** Containers, counted the way `JsonSchemaDocumentSchema` bounds them. */
function jsonDepth(value: unknown): number {
	if (Array.isArray(value)) {
		return 1 + Math.max(0, ...value.map((entry) => jsonDepth(entry)));
	}
	if (typeof value === "object" && value !== null) {
		const children = Object.values(value as Record<string, unknown>);
		return (
			1 +
			(children.length === 0
				? 0
				: Math.max(...children.map((entry) => jsonDepth(entry))))
		);
	}
	return 0;
}

describe("deep-research: discovery", () => {
	it("is discovered under the builtin root with scope builtin", async () => {
		const root = path.resolve(".pi", "test-deep-research", randomUUID());
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
			(entry) => entry.definition.meta.name === "deep-research",
		);
		if (!found) throw new Error("deep-research was not discovered");
		expect(found.scope).toBe("builtin");
		expect(found.source).toBe("package");
		expect(path.basename(found.path)).toBe("deep-research.workflow.ts");
		// The worst case the input schema admits: 16 sources, so 16 research
		// threads and 16 cross-checks, plus one reducer, all at the deep column.
		expect(found.definition.meta.budget.cost).toBe(
			16 * envelope("deep", "review").budgetShare.cost +
				16 * envelope("deep", "verify").budgetShare.cost +
				envelope("deep", "synthesis").budgetShare.cost,
		);
	});

	it("keeps both schemas inside the 17-level JSON nesting bound", async () => {
		// `JsonSchemaDocumentSchema` admits a document plus 16 levels of value
		// (`JSON_VALUE_DEPTH`), and `validateJsonSchemaDocument` refuses anything
		// deeper — which discovery above would already have failed on. Measured
		// here so a future field that adds a level fails with a number.
		const definition = await shippedDefinition();
		expect(jsonDepth(definition.inputSchema)).toBeLessThanOrEqual(17);
		expect(jsonDepth(definition.outputSchema)).toBeLessThanOrEqual(17);
	});
});

describe("deep-research: structural headlessness", () => {
	// The same structural property that makes `plan-review` legal on the
	// headless allowlist, asserted here because this definition claims it in its
	// header: nothing it declares parks, writes, or produces a patch.
	it("declares no checkpoint, no worktree and no handoff at any depth", async () => {
		const definition = await shippedDefinition();
		for (const depth of DEPTHS) {
			await expect(
				headlessBuiltinViolations(definition, input({ depth })),
			).resolves.toEqual([]);
			await expect(
				headlessBuiltinViolations(
					definition,
					input({ depth, sources: [pathSource("a"), noteSource("b")] }),
				),
			).resolves.toEqual([]);
		}
	});

	it("is not on the headless allowlist, which names plan-review alone", async () => {
		// Being structurally headless and being startable without a model turn
		// are different things. Only the blind review has a reason to be the
		// second, and the allowlist belongs to the runtime rather than to a
		// definition that would like to join it.
		expect([...BUILTIN_HEADLESS_WORKFLOWS]).toEqual(["plan-review"]);
	});
});

describe("deep-research: the thread count", () => {
	it("is the depth dial's angle table when the caller names no sources", async () => {
		for (const depth of DEPTHS) {
			const { delegated, finished } = await runDeepResearch({ depth });
			expect(finished.status).toBe("completed");
			expect(
				delegated
					.researchRequests()
					.map((request) => researchThreadOf(request)),
			).toEqual([...ANGLES_BY_DEPTH[depth]]);
			// Every angle gets its own brief; five threads must not be one thread
			// five times.
			const briefs = new Set(
				delegated
					.researchRequests()
					.map((request) => request.task.context[1] ?? ""),
			);
			expect(briefs.size).toBe(ANGLES_BY_DEPTH[depth].length);
		}
	});

	it("is the source list when the caller names one, at any depth", async () => {
		const sources = [pathSource("alpha"), noteSource("beta")];
		for (const depth of DEPTHS) {
			const { delegated, finished } = await runDeepResearch({ depth, sources });
			expect(finished.status).toBe("completed");
			expect(
				delegated
					.researchRequests()
					.map((request) => researchThreadOf(request)),
			).toEqual(["alpha", "beta"]);
		}
	});
});

describe("deep-research: the lowered graph", () => {
	it("fans out threads, cross-checks each by a different thread, and reduces", async () => {
		const { delegated, finished, output } = await runDeepResearch({
			depth: "standard",
		});
		expect(finished.status).toBe("completed");
		expect(taskPaths(finished).sort()).toEqual([
			"cross-check/context",
			"cross-check/counterpoint",
			"cross-check/evidence",
			"research/context",
			"research/counterpoint",
			"research/evidence",
			"synthesis",
		]);
		for (const thread of ANGLES_BY_DEPTH.standard) {
			// One flaky thread must not fail an otherwise complete answer.
			expect(taskByPath(finished, `research/${thread}`).disposition).toBe(
				"optional",
			);
			expect(taskByPath(finished, `cross-check/${thread}`).disposition).toBe(
				"optional",
			);
		}
		expect(taskByPath(finished, "synthesis").disposition).toBe("optional");

		// Nobody marks their own homework: the checker of a thread is never that
		// thread, and every reporting thread checks exactly one other.
		const assignments = delegated
			.crossCheckRequests()
			.map((request) => crossCheckOf(request));
		expect(assignments).toEqual([
			{ checked: "evidence", by: "counterpoint" },
			{ checked: "counterpoint", by: "context" },
			{ checked: "context", by: "evidence" },
		]);
		for (const entry of assignments) expect(entry?.checked).not.toBe(entry?.by);
		expect(new Set(assignments.map((entry) => entry?.by)).size).toBe(3);

		// Every task is read-only, and only the reducer is toolless.
		for (const request of delegated.requests) {
			expect(request.agent).toBe(RESEARCHER_AGENT);
			expect(request.workspace.mode).toBe("read-only");
			expect(request.limits.workspaceWriteBytes).toBe(0);
			expect(request.contextMode).toBe("fresh");
		}
		for (const request of [
			...delegated.researchRequests(),
			...delegated.crossCheckRequests(),
		]) {
			expect(request.tools).toEqual(["read", "grep", "find", "ls"]);
			// A researcher reads THIS repository, so it gets the project's own
			// context files — the opposite of `plan-review`, which declares none.
			expect(request.contextScopes).toEqual(["project"]);
		}
		const synthesis = delegated.synthesisRequest();
		if (!synthesis) throw new Error("no synthesis request");
		expect(synthesis.tools).toEqual([]);
		expect(synthesis.contextScopes).toEqual([]);
		// The reducer's inputs are the threads that reported, named by thread key.
		const reduced = synthesis.task.context.join("\n");
		for (const thread of ANGLES_BY_DEPTH.standard) {
			expect(reduced).toContain(thread);
		}

		// The claim rail: nothing de-duplicated (three threads reaching the same
		// claim is corroboration), ids made unique, every claim traceable.
		expect(output.claims).toHaveLength(6);
		expect(output.claims.map((claim) => claim.id)).toEqual([
			"shared-claim",
			"evidence-own",
			"shared-claim-2",
			"counterpoint-own",
			"shared-claim-3",
			"context-own",
		]);
		// One row per claim: the ghost claim and the repeat the checkers reported
		// are dropped rather than passed through.
		expect(output.crossChecks).toHaveLength(6);
		expect(output.crossChecks.map((entry) => entry.claim).sort()).toEqual(
			output.claims.map((claim) => claim.id).sort(),
		);
		expect(
			output.crossChecks.some((entry) => entry.claim === "ghost-claim"),
		).toBe(false);
		expect(
			output.crossChecks.filter((entry) => entry.claim === "shared-claim"),
		).toEqual([
			{
				claim: "shared-claim",
				by: "counterpoint",
				agrees: true,
				note: "counterpoint checked shared-claim.",
			},
		]);
		expect(output.coverage).toEqual([
			{
				thread: "evidence",
				reported: true,
				claims: 2,
				checkedBy: "counterpoint",
			},
			{
				thread: "counterpoint",
				reported: true,
				claims: 2,
				checkedBy: "context",
			},
			{ thread: "context", reported: true, claims: 2, checkedBy: "evidence" },
		]);
	});

	it("cross-checks nothing when only one thread could report", async () => {
		// A claim can only be checked by a thread that is not the one that made
		// it, so a single reporting thread has nobody to ask. That is a missing
		// cross-check, never a failure.
		const { finished, output } = await runDeepResearch({
			depth: "cheap",
			failThreads: ["counterpoint"],
		});
		expect(finished.status).toBe("completed-degraded");
		// No `cross-check/*` task is declared at all — not a blocked one, none:
		// with one reporting thread there is no assignment to declare. The
		// reducer still is, and is blocked by the dead thread's barrier.
		expect(taskPaths(finished).sort()).toEqual([
			"research/counterpoint",
			"research/evidence",
			"synthesis",
		]);
		expect(output.crossChecks).toEqual([]);
		expect(output.claims).toHaveLength(2);
		expect(output.coverage).toEqual([
			{ thread: "evidence", reported: true, claims: 2 },
			{ thread: "counterpoint", reported: false },
		]);
	});
});

describe("deep-research: the key rule", () => {
	it("keys a thread by its source id, stable when the sources are reordered", async () => {
		// `forEach`'s law 1: the key is a pure function of a REQUIRED field of
		// the item. Reordering the sources moves the tasks; it renames none of
		// them, and a run that re-declares the same keys replays.
		const sources = [
			pathSource("alpha"),
			noteSource("beta"),
			urlSource("gamma"),
		];
		const forward = await runDeepResearch({ sources });
		const reversed = await runDeepResearch({ sources: [...sources].reverse() });

		expect(forward.finished.status).toBe("completed");
		expect(reversed.finished.status).toBe("completed");
		const expected = [
			"cross-check/alpha",
			"cross-check/beta",
			"cross-check/gamma",
			"research/alpha",
			"research/beta",
			"research/gamma",
			"synthesis",
		];
		expect(taskPaths(forward.finished).sort()).toEqual(expected);
		expect(taskPaths(reversed.finished).sort()).toEqual(expected);

		// The declaration ORDER follows the input; the keys follow the ids.
		expect(
			forward.delegated
				.researchRequests()
				.map((request) => researchThreadOf(request)),
		).toEqual(["alpha", "beta", "gamma"]);
		expect(
			reversed.delegated
				.researchRequests()
				.map((request) => researchThreadOf(request)),
		).toEqual(["gamma", "beta", "alpha"]);
	});

	it("refuses two sources sharing an id at declaration", async () => {
		// The schema cannot express uniqueness, so `forEach` refuses it when the
		// graph is declared — which `project` reaches without starting a run.
		const service = await serviceFor(scripted());
		await expect(
			service.project(
				"deep-research",
				input({ sources: [pathSource("alpha"), noteSource("alpha")] }),
			),
		).rejects.toMatchObject({
			code: "validation",
			message: expect.stringContaining("duplicate id"),
		});
	});
});

describe("deep-research: a thread that dies", () => {
	it("degrades the run and reports the dead thread in the coverage", async () => {
		const { finished, output } = await runDeepResearch({
			depth: "standard",
			failThreads: ["context"],
		});

		// The run does NOT fail: the threads are optional and the barrier is
		// `ctx.settled`, so a dead thread subtracts coverage and the claims, the
		// cross-checks and the coverage are all still committed as the run's
		// output. It completes DEGRADED, the honest status for an answer that
		// lost a point of view.
		expect(finished.status).toBe("completed-degraded");
		expect(taskByPath(finished, "research/context").status).toBe("failed");
		expect(output.claims).toHaveLength(4);
		expect(output.coverage).toEqual([
			{
				thread: "evidence",
				reported: true,
				claims: 2,
				checkedBy: "counterpoint",
			},
			{
				thread: "counterpoint",
				reported: true,
				claims: 2,
				checkedBy: "evidence",
			},
			{ thread: "context", reported: false },
		]);

		// The cross-checks and the reducer were declared after the barrier the
		// dead thread closed over, so the barrier's control edge blocked them —
		// the limitation this definition's header states. Optional turns that
		// into a degraded completion rather than a failed run, and the answer
		// says what is missing instead of pretending it was written.
		for (const full of ["cross-check/evidence", "cross-check/counterpoint"]) {
			expect(taskByPath(finished, full)).toMatchObject({
				disposition: "optional",
				status: "blocked",
			});
		}
		expect(taskByPath(finished, "synthesis")).toMatchObject({
			disposition: "optional",
			status: "blocked",
		});
		expect(output.crossChecks).toEqual([]);
		expect(output.answer).toContain("No answer was synthesized");
		expect(output.answer).toContain("2 of 3 research thread(s)");
	});
});

describe("deep-research: the output", () => {
	it("validates against the shipped output schema", async () => {
		const definition = await shippedDefinition();
		const { finished, output } = await runDeepResearch({
			sources: [pathSource("alpha"), noteSource("beta")],
		});
		expect(finished.status).toBe("completed");
		expect(
			[...Value.Errors(definition.outputSchema, finished.output)].map(
				(error) => error.message,
			),
		).toEqual([]);
		expect(Value.Check(definition.outputSchema, finished.output)).toBe(true);
		expect(output.answer).toBe(
			"The library keeps replay deterministic by table lookup.",
		);
		// A degraded answer also has to validate: `answer` is required, so the
		// deterministic fallback is part of the contract rather than a blank.
		const degraded = await runDeepResearch({
			depth: "cheap",
			failThreads: ["evidence"],
		});
		expect(Value.Check(definition.outputSchema, degraded.finished.output)).toBe(
			true,
		);
	});
});

describe("deep-research: the effort dial", () => {
	it("spends the review, verify and synthesis rows of the effort table", async () => {
		for (const depth of DEPTHS) {
			const { delegated, finished } = await runDeepResearch({
				depth,
				sources: [pathSource("alpha"), noteSource("beta")],
			});
			expect(finished.status).toBe("completed");
			const research = envelope(depth, "review");
			const check = envelope(depth, "verify");
			const reduce = envelope(depth, "synthesis");
			for (const request of delegated.researchRequests()) {
				expect(request.model?.id).toBe(MODEL_ID);
				expect(request.model?.thinking).toBe(research.thinking);
				expect(request.limits).toEqual(research.limits);
			}
			for (const request of delegated.crossCheckRequests()) {
				// The OTHER family, for the same reason the checker is another
				// thread: a checker that shares everything with the claimant
				// agrees with it for free.
				expect(request.model?.id).toBe(DIVERSE_MODEL_ID);
				expect(request.model?.thinking).toBe(check.thinking);
				expect(request.limits).toEqual(check.limits);
			}
			expect(delegated.synthesisRequest()?.model?.id).toBe(MODEL_ID);
			expect(delegated.synthesisRequest()?.model?.thinking).toBe(
				reduce.thinking,
			);
			expect(delegated.synthesisRequest()?.limits).toEqual(reduce.limits);
		}
	});
});

describe("deep-research: the service surface", () => {
	it("validates and projects the shipped definition", async () => {
		const service = await serviceFor(scripted());
		await expect(
			service.validate("deep-research", input()),
		).resolves.toMatchObject({ valid: true, workflow: { scope: "builtin" } });

		const projection = await service.project("deep-research", input());
		// A dry barrier synthesizes an EMPTY claim set from
		// `ResearchReportSchema`, so the projection stops at the three threads
		// plus the reducer: with no claims there is nothing to cross-check. The
		// projected total is therefore a lower bound on a real run, and
		// `meta.budget` covers the worst case the schema admits rather than this
		// number.
		expect(projection.tasks).toBe(4);
		expect(projection.cost).toBe(
			3 * envelope("standard", "review").limits.cost +
				envelope("standard", "synthesis").limits.cost,
		);
		expect(projection.fits).toBe(true);
		expect(projection.budget.cost).toBe(
			16 * envelope("deep", "review").budgetShare.cost +
				16 * envelope("deep", "verify").budgetShare.cost +
				envelope("deep", "synthesis").budgetShare.cost,
		);
	});

	it("refuses an input the schema does not admit", async () => {
		const service = await serviceFor(scripted());
		for (const bad of [
			// More sources than the spec's bound.
			input({
				sources: Array.from({ length: 17 }, (_unused, index) =>
					pathSource(`s${index}`),
				),
			}),
			// An empty source list is not "no sources": it is a list with no
			// threads in it.
			{ ...input(), sources: [] },
			// Over-long and empty questions.
			{ ...input(), question: "q".repeat(2049) },
			{ ...input(), question: "" },
			// Bad source ids: uppercase, leading digit, and a path separator.
			input({ sources: [{ id: "Alpha", kind: "path", ref: "a.ts" }] }),
			input({ sources: [{ id: "1alpha", kind: "path", ref: "a.ts" }] }),
			input({ sources: [{ id: "a/b", kind: "path", ref: "a.ts" }] }),
			// A note with no text, and a path with no ref: refused here rather
			// than discovered by a researcher with nothing to read.
			input({ sources: [{ id: "alpha", kind: "note" }] }),
			input({ sources: [{ id: "alpha", kind: "path" }] }),
			// A source that carries both.
			input({
				sources: [{ id: "alpha", kind: "path", ref: "a.ts", text: "x" }],
			}),
			{ ...input(), depth: "deeper" },
			{ ...input(), extra: true },
			{ question: QUESTION },
		]) {
			await expect(
				service.validate("deep-research", bad),
			).rejects.toMatchObject({
				code: "validation",
				message: "Workflow input does not match its schema.",
			});
		}
	});
});

describe("deep-research: the agent template", () => {
	it("parses through pi-subagent's own discovery", async () => {
		const agents = await discoverAgents([
			{ scope: "package", directory: AGENT_TEMPLATES, trusted: true },
		]);
		const researcher = agents.get(RESEARCHER_AGENT);
		if (!researcher) throw new Error("no researcher template");
		expect(researcher.workspaceModes).toEqual(["read-only"]);
		expect(researcher.tools).toEqual(["read", "grep", "find", "ls"]);
		// A researcher never writes, at any depth.
		expect(researcher.limitCeiling.workspaceWriteBytes).toBe(0);
		// Both families: a cross-check runs on the one the threads did not.
		for (const id of [MODEL_ID, DIVERSE_MODEL_ID]) {
			for (const thinking of ["low", "medium", "high"]) {
				expect(researcher.allowedModels).toContain(
					`github-copilot/${id}:${thinking}`,
				);
			}
		}
	});

	it("covers every request the definition makes at every depth", async () => {
		const agents = await discoverAgents([
			{ scope: "package", directory: AGENT_TEMPLATES, trusted: true },
		]);
		for (const depth of DEPTHS) {
			const { delegated, finished } = await runDeepResearch({
				depth,
				sources: [pathSource("alpha"), noteSource("beta"), urlSource("gamma")],
			});
			expect(finished.status).toBe("completed");
			// Three threads, three cross-checks, one reducer.
			expect(delegated.requests.length).toBe(7);
			for (const request of delegated.requests) {
				const agent = agents.get(request.agent);
				if (!agent) throw new Error(`no template for agent ${request.agent}`);
				// pi-subagent's preflight rules, applied here so a widened request
				// fails this test instead of a real run.
				for (const tool of request.tools) {
					expect(agent.tools).toContain(tool);
				}
				for (const scope of request.contextScopes) {
					expect(agent.contextScopes).toContain(scope);
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
