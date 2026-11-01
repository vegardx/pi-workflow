import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentLaunchPlan,
	canonicalSha256,
	DEFAULT_MEMORY_BYTES,
	discoverAgents,
	SUBAGENT_RUNTIME_CONTRACT,
	type SubagentClient,
	type SubagentRequest,
} from "@vegardx/pi-subagent";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CompiledStageDocumentSchema,
	envelope,
	MAX_REVIEW_LENSES,
	ReviewsRecordSchema,
	WORKTREE_MEMORY_BYTES,
} from "../src/components/index.js";
import { WorkflowRunRecordStore } from "../src/run-record.js";
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
import {
	OTHER_FAMILY_ID,
	routedModel,
	testModelRouting,
} from "./fixtures/routing.js";

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
/**
 * The host session's model, as the provider these tests install answers it.
 * `plan-to-ship` declares `needs.sessionModel: true`, so a run is refused
 * without one, and every role that inherits carries THIS model exactly.
 */
const SESSION_MODEL = {
	provider: "placeholder",
	id: "same-family",
	thinking: "high",
} as const;

/**
 * The exact model a request carries. pi-subagent 0.15.0 admits the literal
 * `"inherit"` on a `SubagentRequest`, and pi-workflow NEVER sends it: it
 * resolves the session model once at run start and lowers the exact answer.
 * Asserting that here means no test can accidentally accept the literal.
 */
function exactModel(request: SubagentRequest) {
	expect(request.model).not.toBe("inherit");
	return request.model === "inherit" ? undefined : request.model;
}

/** The compiler's own input types, so a fixture cannot drift from the schema. */
type PlanInput = Parameters<typeof compileStages>[0];
/** One journal line, as far as these tests read it. */
type JournalLine = {
	readonly type: string;
	readonly data: Record<string, unknown>;
};
type PolicyInput = NonNullable<Parameters<typeof compileStages>[1]>;

interface PlanOptions {
	readonly deliverables?: number;
	readonly lensesPerDeliverable?: readonly string[];
	readonly diverse?: boolean;
	readonly pinnedModel?: string;
	readonly tier?: "fast" | "light" | "normal" | "frontier";
	readonly policy?: PolicyInput;
	readonly after?: boolean;
}

/** A plan schema v8 document: tasks are work, reviews are the lens list. */
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

function input(options: PlanOptions = {}) {
	return {
		plan: plan(options),
		planDigest: PLAN_DIGEST,
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

/**
 * How a scripted verifier answers: the first check, then the recheck of what
 * the resumed implementer handed back.
 */
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

/** One standard lens finding. */
function lensFinding(
	file: string,
	line: number | undefined,
	claim: string,
	severity: "high" | "medium" | "low" = "high",
	suggestion?: string,
) {
	return {
		claim,
		location: { file, ...(line === undefined ? {} : { line }) },
		evidence: `Seen at ${file}${line === undefined ? "" : `:${line}`}.`,
		severity,
		...(suggestion === undefined ? {} : { suggestion }),
	};
}

/** What every scripted lens reports unless a test says otherwise. */
const DEFAULT_FINDINGS = [
	lensFinding(
		"a.txt",
		1,
		"Missing a test.",
		"high",
		"Add one next to the change.",
	),
];

/** The ids a resume message shows, in the order it shows them. */
function shownIds(message: string): string[] {
	return [...message.matchAll(/"id":"(c[0-9]+)"/g)].map(
		(match) => match[1] as string,
	);
}

interface ScriptOptions {
	readonly check?: CheckScript;
	/** Per lens id, the findings it reports; `DEFAULT_FINDINGS` otherwise. */
	readonly findings?: Readonly<Record<string, readonly unknown[]>>;
	/** The normalize model's answer, given the ids it was offered. */
	readonly merges?: (ids: readonly string[]) => unknown;
	/** The resumed implementer's dispositions, given the ids it was shown. */
	readonly dispositions?: (ids: readonly string[]) => unknown[];
	/** The adjudicator's answer, given the contested ids it was shown. */
	readonly verdicts?: (ids: readonly string[]) => unknown;
}

/** The structured output a scripted child returns, keyed by what it was asked. */
function outputFor(
	request: SubagentRequest,
	options: ScriptOptions,
	message?: string,
): unknown {
	if (message !== undefined) {
		const ids = shownIds(message);
		return {
			...implementation("Answered the check and the review"),
			dispositions:
				options.dispositions?.(ids) ??
				ids.map((id, index) => ({
					id,
					kind: index === 0 ? "fixed" : "declined",
					reasoning:
						index === 0 ? "Added the test." : "The behaviour is intended.",
				})),
		};
	}
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
	if (goal.startsWith("Verify deliverable")) {
		const round = goal.includes("resumed implementer") ? 2 : 1;
		return checkReport(options.check ?? "pass", round);
	}
	if (goal.startsWith("Review deliverable")) {
		const lens = /through the "([^"]+)" lens/.exec(goal)?.[1] ?? "";
		return { findings: options.findings?.[lens] ?? DEFAULT_FINDINGS };
	}
	if (goal.startsWith("Find the clusters")) {
		const ids = [
			...request.task.context.join("\n").matchAll(/"id":"(c[0-9]+)"/g),
		].map((match) => match[1] as string);
		return options.merges?.(ids) ?? { merges: [] };
	}
	if (goal.startsWith("Record the plan-to-ship receipt")) {
		return { recorded: true, refs: [] };
	}
	if (goal.startsWith("Adjudicate what the implementer")) {
		const ids = [
			...request.task.context.join("\n").matchAll(/"id":"(c[0-9]+)"/g),
		].map((match) => match[1] as string);
		return (
			options.verdicts?.(ids) ?? {
				verdicts: ids.map((id) => ({
					id,
					verdict: "upheld",
					reasoning: "The claim holds in the tree.",
				})),
			}
		);
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
	/** A resumed attempt: the message it was continued with. */
	readonly message?: string;
	/** A resumed attempt: the attempt whose hand-off it continued from. */
	readonly previousAttemptId?: string;
}

/**
 * A scripted owner client: every preflight is remembered, every launch mints a
 * child, and every child answers with the structured output its goal calls for.
 * Worktree children capture a handoff; read-only children never do.
 */
function scripted(
	options: ScriptOptions & {
		readonly failReview?: boolean;
		/** Fail only the lens whose name the goal names; the rest report. */
		readonly failLens?: string;
		/** The normalize call fails. */
		readonly failNormalize?: boolean;
		/** The adjudication fails. */
		readonly failAdjudicate?: boolean;
		/** pi-subagent refuses to resume the run. */
		readonly refuseResume?: boolean;
		/** The resumed attempt changes nothing, so the run keeps its hand-off. */
		readonly resumeChangesNothing?: boolean;
		/**
		 * Every verifier attempt ends the way the 2026-10-31 verifier did: the
		 * service killed it at its runtime limit, its usage is incomplete, and
		 * its worktree is retained.
		 */
		readonly failVerify?: boolean;
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
			// pi-workflow resolves `inherit` itself and sends an exact model, so a
			// launch plan never sees the literal; `exactModel` is where that is
			// asserted for every request the scripted client records.
			model: exactModel(request) ?? {
				provider: "test",
				id: "model",
				thinking: "low" as const,
			},
			// Revision 9: where the launch's model came from. pi-workflow always
			// states one, so a plan it produced is never `"inherited"`.
			modelSource: request.model === undefined ? "template" : "request",
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
				// The real preflight echoes the commit it checked the workspace out at.
				...(request.workspace.startAt === undefined
					? {}
					: { startAt: request.workspace.startAt }),
			},
			sandbox: {
				backend: "gondolin" as const,
				packageVersion: "0.12.0",
				imageSha256: "a".repeat(64),
				mountPolicySha256: "a".repeat(64),
				networkPolicySha256: "a".repeat(64),
				capacityPolicySha256: "a".repeat(64),
				rootfsPolicySha256: "a".repeat(64),
				memoryBytes: request.memoryBytes ?? DEFAULT_MEMORY_BYTES,
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

	/** The attempt whose hand-off a child's run carries. */
	const handoffAttempt = (child: Child): string =>
		child.message !== undefined && options.resumeChangesNothing === true
			? (child.previousAttemptId as string)
			: child.attemptId;
	const resumes: { runId: string; message: string }[] = [];
	const resume = vi.fn(
		async (
			runId: string,
			resumeInput?: { continueFromHandoff: true; message: string },
		) => {
			const child = childOf(runId);
			if (!resumeInput || options.refuseResume === true) {
				throw new Error("resume at hand-off refused: spent resumes");
			}
			resumes.push({ runId, message: resumeInput.message });
			const next: Child = {
				runId,
				attemptId: `${child.attemptId}r`,
				request: child.request,
				message: resumeInput.message,
				previousAttemptId: handoffAttempt(child),
			};
			children.set(runId, next);
			statuses.delete(runId);
			return { runId, attemptId: next.attemptId, status: "active" };
		},
	);
	const findByOperation = vi.fn(async (operationId: string) => {
		for (const child of children.values()) {
			if (child.request.operationId === operationId) {
				return {
					runId: child.runId,
					attemptId: child.attemptId,
					status: statuses.get(child.runId) ?? "completed",
				};
			}
		}
		return undefined;
	});

	const wait = vi.fn(async (runId: string) => {
		const child = childOf(runId);
		const worktree = child.request.workspace.mode === "worktree";
		const goal = child.request.task.goal;
		const failed =
			(child.message === undefined &&
				goal.startsWith("Review deliverable") &&
				(options.failReview === true ||
					(options.failLens !== undefined &&
						goal.includes(`"${options.failLens}" lens`)))) ||
			(options.failNormalize === true &&
				goal.startsWith("Find the clusters")) ||
			(options.failAdjudicate === true &&
				goal.startsWith("Adjudicate what the implementer"));
		const timedOut =
			options.failVerify === true && goal.startsWith("Verify deliverable");
		if (timedOut) {
			const result = {
				runId,
				status: "failed" as const,
				usage: {
					input: 18,
					output: 893,
					cacheRead: 30930,
					cacheWrite: 7541,
					totalTokens: 39382,
					cost: 0.068009,
				},
				usageComplete: false,
				runtimeMs: 907912,
				failure: {
					code: "timeout",
					origin: "service",
					retry: "manual",
					message: "Attempt runtime limit exceeded",
					guidance:
						"Inspect partial output and explicitly retry only if repeating the task is safe.",
				},
				sandboxCleanup: "proved" as const,
				workspaceCleanup: "retained" as const,
				truncated: false,
			};
			statuses.set(runId, result.status);
			return {
				result,
				output: "",
				sessionFile: "/private/repo/session.jsonl",
				error: "Attempt runtime limit exceeded",
			};
		}
		const result = {
			runId,
			status: failed ? ("failed" as const) : ("completed" as const),
			...(failed
				? {}
				: {
						structuredOutput: outputFor(child.request, options, child.message),
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
						attemptId: handoffAttempt(child),
						repositoryRoot: "/private/repo",
						worktreePath: `/private/repo/.pi/worktrees/${runId}`,
						recordPath: `/private/repo/.pi/worktrees/${runId}.json`,
						branch: `pi-subagent/reservations/${runId}`,
						baselineHead: BASELINE_HEAD,
						createdAt: "2026-01-01T00:00:00.000Z",
						handoffCommit: commitFor(handoffAttempt(child)),
						handoffRef: `refs/pi-subagent/handoffs/${runId}/${handoffAttempt(child)}`,
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
		const attemptId = handoffAttempt(child);
		const handoffCommit = commitFor(attemptId);
		const content = patchFor(handoffCommit);
		return {
			ref: {
				runId,
				attemptId,
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
		resume,
		findByOperation,
	} as unknown as SubagentClient;

	return {
		provider: {
			bind: vi.fn(async (runId: string) => {
				ownerId = `pi-workflow:${runId}`;
				return {
					workflowRunId: runId,
					ownerId,
					client,
					maxSlots: 16,
				} satisfies WorkflowSubagentBinding;
			}),
		} as WorkflowSubagentProvider,
		requests,
		children,
		launch,
		resume,
		/** Every resume message, in order. */
		resumes,
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

/** Where a service created by `serviceFor` keeps one run's record. */
const storeRoots = new Map<WorkflowService, string>();
function runDirectory(service: WorkflowService, runId: string): string {
	const root = storeRoots.get(service);
	if (!root) throw new Error("no store root for this service");
	return path.join(root, "runs", runId);
}

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
		sessionModel: () => SESSION_MODEL,
		modelRouting: testModelRouting,
	});
	storeRoots.set(service, path.join(cwd, "state"));
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
			gates: "ship",
			resumes: 1,
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
					{ lens: "contracts", tier: "light", diverse: true },
					{ lens: "replay", tier: "normal" },
				],
			},
		],
	};
}

/** The exact model a lens with no tier and no pin runs at, as the record names it. */
const MODEL_PROVIDER_ID = `${routedModel("normal").provider}/${routedModel("normal").id}`;

/** The run's journal, line by line. */
async function journal(
	service: WorkflowService,
	runId: string,
): Promise<JournalLine[]> {
	return (
		await readFile(
			path.join(runDirectory(service, runId), "events.jsonl"),
			"utf8",
		)
	)
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as JournalLine);
}

/** The full stage list a reviewed, resumed deliverable compiles to. */
const REVIEWED_STAGES = [
	{ use: "implement", id: "implement" },
	{ use: "check", id: "check" },
	{
		use: "review-fan-out",
		id: "review",
		lenses: [{ id: "correctness", tier: "normal", diverse: false }],
	},
	{ use: "normalize", id: "normalize" },
	{ use: "resume", id: "resume" },
	{ use: "check", id: "recheck" },
	{ use: "adjudicate", id: "adjudicate" },
];

describe("plan-to-ship: the compiled stage document", () => {
	// The plan-facing view of the SAME compilation the run walks: what a host's
	// plan check reads and what pi-maestro derives for itself from the stored
	// plan. No task keys, no policy gates.
	function check(document: unknown): void {
		const errors = [...Value.Errors(CompiledStageDocumentSchema, document)];
		expect(errors.map((error) => error.message)).toEqual([]);
		expect(Value.Check(CompiledStageDocumentSchema, document)).toBe(true);
	}

	it("derives implement, check, review, normalize, resume and recheck from `reviews` and `policy`", () => {
		const document = compileStageDocument(plan());
		check(document);
		expect(document).toEqual({
			gates: "ship",
			deliverables: [{ id: "d0", stages: REVIEWED_STAGES }],
		});
	});

	it("derives the spec's own example plan", () => {
		const document = compileStageDocument(examplePlan());
		check(document);
		expect(document.deliverables[0]?.stages).toEqual([
			{ use: "implement", id: "implement" },
			{ use: "check", id: "check" },
			{
				use: "review-fan-out",
				id: "review",
				lenses: [
					{ id: "contracts", tier: "light", diverse: true },
					{ id: "replay", tier: "normal", diverse: false },
				],
			},
			{ use: "normalize", id: "normalize" },
			{ use: "resume", id: "resume" },
			{ use: "check", id: "recheck" },
			{ use: "adjudicate", id: "adjudicate" },
		]);
	});

	it.each(["ship", "every-deliverable"] as const)(
		"carries the gate policy %s without inventing a stage for it",
		(gates) => {
			const document = compileStageDocument(plan({ deliverables: 3 }), {
				gates,
			});
			check(document);
			expect(document.gates).toBe(gates);
			for (const deliverable of document.deliverables) {
				expect(deliverable.stages).toEqual(REVIEWED_STAGES);
			}
			expect(compileStages(plan({ deliverables: 3 }), { gates }).gates).toEqual(
				gates === "ship" ? ["ship"] : ["approve-d0", "approve-d1", "ship"],
			);
		},
	);

	it("omits review and normalize when the deliverable lists no review, and keeps the resume", () => {
		// A failing check is something to answer even with no reviewer.
		const document = compileStageDocument(plan({ lensesPerDeliverable: [] }));
		check(document);
		expect(document.deliverables[0]?.stages).toEqual([
			{ use: "implement", id: "implement" },
			{ use: "check", id: "check" },
			{ use: "resume", id: "resume" },
			{ use: "check", id: "recheck" },
		]);
	});

	it("omits resume and recheck under `policy.resumes: 0`", () => {
		const document = compileStageDocument(plan(), { resumes: 0 });
		check(document);
		expect(document.deliverables[0]?.stages.map((stage) => stage.use)).toEqual([
			"implement",
			"check",
			"review-fan-out",
			"normalize",
		]);
	});

	it("carries exactly `deliverables` and `gates`", () => {
		expect(Object.keys(compileStageDocument(plan())).sort()).toEqual([
			"deliverables",
			"gates",
		]);
		expect(Object.keys(CompiledStageDocumentSchema.properties).sort()).toEqual([
			"deliverables",
			"gates",
		]);
	});

	it("refuses what the lowering refuses, from the same compilation", () => {
		expect(() =>
			compileStageDocument(withStages(plan(), [{ use: "implement", id: "x" }])),
		).toThrow("plan schema v8 does not author stages");
	});
});

describe("plan-to-ship: the compiler", () => {
	it("compiles a plan with no `policy` to every key the run may declare", () => {
		const document = compileStages(plan());
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
					{ use: "check", id: "check", key: "check-d0", tasks: ["check-d0"] },
					{
						use: "review-fan-out",
						id: "review",
						key: "review-d0",
						lenses: [{ id: "correctness", tier: "normal", diverse: false }],
						tasks: ["review-d0/correctness"],
					},
					{
						use: "normalize",
						id: "normalize",
						key: "normalize-d0",
						// The model call, worst case, then the record.
						tasks: ["normalize-d0", "reviews-d0"],
					},
					{
						use: "resume",
						id: "resume",
						key: "resume-d0",
						tasks: ["resume-d0"],
					},
					{
						use: "check",
						id: "recheck",
						key: "recheck-d0",
						tasks: ["recheck-d0"],
					},
					{
						use: "adjudicate",
						id: "adjudicate",
						key: "adjudicate-d0",
						tasks: ["adjudicate-d0"],
					},
				],
			},
		]);
	});

	it("names no stage with a suffix a reader would take for the deliverable id", () => {
		// The defect this replaced: `check-d0-verify-1` narrated as deliverable
		// `d0-verify-1`. Every key is `<stage id>-<deliverable id>`, exactly.
		const document = compileStages(
			plan({ deliverables: 2, lensesPerDeliverable: ["a"] }),
		);
		for (const deliverable of document.deliverables) {
			for (const stage of deliverable.stages) {
				expect(stage.key).toBe(`${stage.id}-${deliverable.id}`);
			}
		}
	});

	it.each([
		["ship", ["ship"]],
		["every-deliverable", ["approve-d0", "approve-d1", "ship"]],
	] as const)("compiles the gate policy %s", (gates, expected) => {
		const document = compileStages(plan({ deliverables: 3 }), { gates });
		expect(document.gates).toEqual(expected);
		expect(
			document.deliverables.map((deliverable) =>
				deliverable.stages
					.filter((stage) => stage.use === "gate")
					.map((stage) => stage.key),
			),
		).toEqual(
			gates === "every-deliverable"
				? [["approve-d0"], ["approve-d1"], []]
				: [[], [], []],
		);
	});

	it.each(["approve-plan", "approve-plan+ship"] as const)(
		"refuses the removed gate policy %s by name",
		(gates) => {
			expect(() => compileStages(plan(), { gates })).toThrow(
				`plan-to-ship: \`policy.gates\` is "${gates}", which was removed because the start of the run IS the approval — the plan-mode exit's yes, or a deliberate \`/plan run\` — so ask for "ship", one decision after all the work and before publication, or "every-deliverable", which adds one after each deliverable.`,
			);
			expect(() => compileStageDocument(plan(), { gates })).toThrow(
				"which was removed because the start of the run IS the approval",
			);
		},
	);

	it("refuses the removed `policy.maxFixRounds` by name, whatever it carries", () => {
		for (const maxFixRounds of [0, 1, 2]) {
			expect(() =>
				compileStages(plan(), { maxFixRounds } as unknown as PolicyInput),
			).toThrow(
				"plan-to-ship: `policy.maxFixRounds` was removed with the fixer: the implementer is resumed once with the check report and the review instead, so set `policy.resumes` to 1 (the default) or 0.",
			);
		}
	});

	it("defaults `policy.resumes` to 1", () => {
		expect(
			compileStages(plan()).deliverables[0]?.stages.map((stage) => stage.key),
		).toContain("resume-d0");
		expect(
			compileStages(plan(), { resumes: 0 }).deliverables[0]?.stages.map(
				(stage) => stage.key,
			),
		).toEqual(["implement-d0", "check-d0", "review-d0", "normalize-d0"]);
	});

	it("seeds review lenses from `deliverables[].reviews` and resolves tier and diversity from the policy", () => {
		const document = compileStages(plan({ lensesPerDeliverable: ["a", "b"] }), {
			reviewDefault: { tier: "light", diverse: true },
		});
		expect(document.deliverables[0]?.stages[2]).toMatchObject({
			lenses: [
				{ id: "a", tier: "light", diverse: true },
				{ id: "b", tier: "light", diverse: true },
			],
		});
		const pinned = compileStages(
			plan({ lensesPerDeliverable: ["a"], tier: "normal", diverse: false }),
			{ reviewDefault: { tier: "light", diverse: true } },
		);
		expect(pinned.deliverables[0]?.stages[2]).toMatchObject({
			lenses: [{ id: "a", tier: "normal", diverse: false }],
		});
	});

	it("defaults an untiered lens to the normal tier", () => {
		const document = compileStages(plan({ lensesPerDeliverable: ["a"] }));
		expect(document.deliverables[0]?.stages[2]).toMatchObject({
			lenses: [{ id: "a", tier: "normal", diverse: false }],
		});
	});

	it.each([
		[
			"frontier",
			'plan-to-ship: deliverable "d0" review "a" is at tier "frontier": frontier is never a review lens; author it at light or normal.',
		],
		[
			"fast",
			'plan-to-ship: deliverable "d0" review "a" is at tier "fast": fast runs only as a standing sweep; author it at light or normal.',
		],
	] as const)("refuses a %s review by name", (tier, message) => {
		expect(() =>
			compileStages(plan({ lensesPerDeliverable: ["a"], tier })),
		).toThrow(message);
		expect(() =>
			compileStageDocument(plan({ lensesPerDeliverable: ["a"], tier })),
		).toThrow(message);
	});

	it.each([
		[
			"frontier",
			'plan-to-ship: `policy.reviewDefault.tier` is "frontier": frontier is never a review lens; author reviews at light or normal.',
		],
		[
			"fast",
			'plan-to-ship: `policy.reviewDefault.tier` is "fast": fast runs only as a standing sweep; author reviews at light or normal.',
		],
	] as const)("refuses a %s review default by name", (tier, message) => {
		expect(() => compileStages(plan(), { reviewDefault: { tier } })).toThrow(
			message,
		);
	});

	it.each(["standard", "heavy"])(
		"refuses the removed tier %s at validate, like any unknown value",
		async (tier) => {
			const service = await serviceFor(scripted());
			const document = plan({ lensesPerDeliverable: ["a"] });
			const value = {
				...input(),
				plan: {
					...document,
					deliverables: document.deliverables.map((deliverable) => ({
						...deliverable,
						reviews: [{ lens: "a", tier }],
					})),
				},
			};
			await expect(service.validate("plan-to-ship", value)).rejects.toThrow(
				"Workflow input does not match its schema.",
			);
			await expect(
				service.validate("plan-to-ship", {
					...input(),
					plan: { ...plan(), policy: { reviewDefault: { tier } } },
				}),
			).rejects.toThrow("Workflow input does not match its schema.");
		},
	);

	it.each([
		[
			"a task carrying plan schema v4's `review`",
			() => withTaskKey(plan(), "review", { lens: "correctness" }),
			'deliverable "d0" task "w0" carries `review`: plan schema v8 moved review routing to `deliverables[].reviews`; a task is work only, so move it to the deliverable\'s `reviews` list and store the plan at `schemaVersion: 8`.',
		],
		[
			"a task carrying plan schema v3's `by`",
			() => withTaskKey(plan(), "by", { lens: "correctness" }),
			'deliverable "d0" task "w0" carries `by`, plan schema v3\'s name for a task review: plan schema v8 moved review routing to `deliverables[].reviews`; a task is work only, so move it to the deliverable\'s `reviews` list and store the plan at `schemaVersion: 8`.',
		],
		[
			"a deliverable that authors `stages`",
			() => withStages(plan(), [{ use: "implement", id: "build" }]),
			'deliverable "d0" declares `stages`: plan schema v8 does not author stages; the compiler derives them from `reviews` and `policy`, so drop the block and store the plan at `schemaVersion: 8`.',
		],
	])(
		"refuses %s by name, and compiles the same plan without it",
		(_name, document, message) => {
			expect(() => compileStages(document())).toThrow(message);
			expect(() => compileStages(plan())).not.toThrow();
		},
	);

	it("de-duplicates repeated lens ids by declaration ordinal", () => {
		const document = compileStages(
			plan({ lensesPerDeliverable: ["risk", "risk", "risk"] }),
		);
		expect(document.deliverables[0]?.stages[2]?.tasks).toEqual([
			"review-d0/risk",
			"review-d0/risk-2",
			"review-d0/risk-3",
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
	it("declares no approve task and makes the first task ready at once", async () => {
		const delegated = scripted();
		const service = await serviceFor(delegated);
		const run = await service.run("plan-to-ship", input());
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
		expect(taskByKey(created, "refine").dependsOn ?? []).toEqual([]);
		const ship = await park(service, run.runId, "ship");
		expect(taskPaths(ship)).not.toContain("approve-plan");
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(run.runId), "wait");
		expect(finished.status).toBe("completed");
		expect(
			(finished.tasks ?? [])
				.filter((task) => task.kind === "checkpoint")
				.map((task) => task.key),
		).toEqual(["ship"]);
		expect(finished.output).toMatchObject({ approved: true, shipped: true });
	});
});

/** Runs to the ship gate, with the script and the plan options given. */
async function runToShip(
	options: PlanOptions = {},
	script: Parameters<typeof scripted>[0] = {},
) {
	const delegated = scripted(script);
	const service = await serviceFor(delegated);
	const receipt = await service.run("plan-to-ship", input(options));
	const ship = await park(service, receipt.runId, "ship");
	return { delegated, service, runId: receipt.runId, ship };
}

/** The ship gate's `reviews-<d>` input, as the record it must be. */
function recordOf(ship: WorkflowServiceRunView, deliverable = "d0") {
	const record = taskByKey(ship, "ship").checkpoint?.inputs?.[
		`reviews-${deliverable}`
	];
	expect(Value.Check(ReviewsRecordSchema, record)).toBe(true);
	return record as Static<typeof ReviewsRecordSchema>;
}

/** The pi-subagent child behind one workflow task, by its journalled receipt. */
async function childOf(
	service: WorkflowService,
	runId: string,
	key: string,
): Promise<{ runId: string; attemptId: string }> {
	const events = await journal(service, runId);
	const view = await service.status(runId);
	const taskId = taskByKey(view, key).id;
	const created = events.find(
		(event) =>
			event.type === "task-execution-created" &&
			(event.data.execution as { taskId: string }).taskId === taskId,
	);
	if (!created) throw new Error(`no execution for ${key}`);
	const executionId = (created.data.execution as { id: string }).id;
	const receipt = events.find(
		(event) =>
			event.type === "task-execution-launch-receipted" &&
			event.data.executionId === executionId,
	);
	if (!receipt) throw new Error(`no receipt for ${key}`);
	return {
		runId: receipt.data.subagentRunId as string,
		attemptId: receipt.data.subagentAttemptId as string,
	};
}

describe("plan-to-ship: the review loop, one deliverable", () => {
	it("walks implement, check beside the lenses, resume, recheck and the record, in that order", async () => {
		const { ship } = await runToShip();
		expect(taskPaths(ship)).toEqual([
			"refine",
			"implement-d0",
			"check-d0",
			"review-d0/correctness",
			"resume-d0",
			"recheck-d0",
			"reviews-d0",
			"ship",
		]);
	});

	it("launches the implementer with W1's limits and the cache instruction", async () => {
		const { delegated } = await runToShip();
		const [implement] = delegated.requestsGoal("Implement deliverable");
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
		const instructions = implement.task.instructions.join("\n");
		expect(instructions).toContain("npm_config_cache=/tmp/npm-cache");
		expect(instructions).toMatch(/checkRan/);
		expect(instructions).toMatch(/never a reason to leave the tree unchanged/i);
	});

	it("verifies at the session model and never tells an agent to apply a ref", async () => {
		const { delegated } = await runToShip();
		const [verify] = delegated.requestsGoal("Verify deliverable");
		expect(verify?.agent).toBe("implementer");
		expect(verify?.workspace.mode).toBe("worktree");
		expect(verify?.model).toEqual(SESSION_MODEL);
		const instructions = verify?.task.instructions.join("\n") ?? "";
		expect(instructions).toMatch(/already contains the change under test/);
		expect(instructions).toMatch(/You are verifying, not fixing/);
		for (const request of delegated.requests) {
			expect(request.task.instructions.join("\n")).not.toMatch(
				/apply (that|the) (ref|patch|handoff)/i,
			);
		}
		for (const { message } of delegated.resumes) {
			expect(message).not.toMatch(/apply (that|the) (ref|patch|handoff)/i);
		}
	});

	it("imports the hand-off and hands its descriptor, never its bytes, to every lens", async () => {
		const { delegated, service, runId } = await runToShip();
		const child = await childOf(service, runId, "implement-d0");
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
		const [review] = delegated.requestsFor("reviewer");
		const projected = (review?.task.context ?? []).join("\n");
		expect(projected).toContain('"content":"descriptor"');
		expect(projected).toContain(commitFor(child.attemptId));
		expect(projected).not.toContain("From: Agent");
	});

	it("runs the check and the lenses in parallel: both are declared before either is awaited", async () => {
		const { service, runId, ship } = await runToShip({
			lensesPerDeliverable: ["a", "b"],
		});
		const events = await journal(service, runId);
		const idOf = (key: string) => taskByKey(ship, key).id;
		const declared = (key: string) =>
			events.findIndex(
				(event) =>
					event.type === "task-declared" &&
					(event.data.task as { id: string }).id === idOf(key),
			);
		const firstBarrierOver = (key: string) =>
			events.findIndex(
				(event) =>
					event.type === "barrier-reached" &&
					(event.data.taskIds as string[]).includes(idOf(key)),
			);
		const barrier = Math.min(
			firstBarrierOver("check-d0"),
			firstBarrierOver("review-d0/a"),
		);
		for (const key of ["check-d0", "review-d0/a", "review-d0/b"]) {
			expect(declared(key)).toBeGreaterThan(-1);
			expect(declared(key)).toBeLessThan(barrier);
		}
	});

	it("starts the check and every lens at H1, resumes the implementer's own run, and rechecks H2", async () => {
		const { delegated, service, runId } = await runToShip();
		const implementer = await childOf(service, runId, "implement-d0");
		const h1 = commitFor(implementer.attemptId);
		const [check, recheck] = delegated.requestsGoal("Verify deliverable");
		expect(check?.workspace).toMatchObject({ mode: "worktree", startAt: h1 });
		expect(delegated.requestsGoal("Review deliverable")[0]?.workspace).toEqual({
			mode: "read-only",
			cwd: expect.any(String),
			startAt: h1,
		});
		// The resume is NOT a launch: no preflight, one `resume` of the
		// implementer's run, at its hand-off, with one message.
		expect(delegated.requestsGoal("Answer the check")).toHaveLength(0);
		expect(delegated.resume).toHaveBeenCalledOnce();
		expect(delegated.resume.mock.calls[0]?.[0]).toBe(implementer.runId);
		expect(delegated.resume.mock.calls[0]?.[1]).toMatchObject({
			continueFromHandoff: true,
		});
		const resumed = await childOf(service, runId, "resume-d0");
		expect(resumed.runId).toBe(implementer.runId);
		expect(resumed.attemptId).not.toBe(implementer.attemptId);
		expect(recheck?.workspace).toMatchObject({
			mode: "worktree",
			startAt: commitFor(resumed.attemptId),
		});
		for (const goal of ["Refine the authored plan", "Implement deliverable"]) {
			expect(delegated.requestsGoal(goal)[0]?.workspace).not.toHaveProperty(
				"startAt",
			);
		}
		for (const request of delegated.requests) {
			expect(request.workspace).not.toHaveProperty("startAtInput");
			expect(request).not.toHaveProperty("continueFrom");
		}
	});

	it("hands the resumed implementer the check report and claims, locations and evidence only, by file and line", async () => {
		const { delegated } = await runToShip(
			{ lensesPerDeliverable: ["correctness", "security"] },
			{
				findings: {
					correctness: [
						lensFinding("src/b.ts", 9, "B nine.", "high", "Rename it."),
						lensFinding("src/a.ts", 40, "A forty.", "low"),
					],
					security: [lensFinding("src/a.ts", 2, "A two.", "medium")],
				},
			},
		);
		const message = delegated.resumes[0]?.message ?? "";
		expect(message).toContain("Check report:\n{");
		expect(message).toContain('"summary":"The check passed."');
		expect(shownIds(message)).toHaveLength(3);
		const claims = [...message.matchAll(/"claim":"([^"]+)"/g)].map(
			(match) => match[1],
		);
		expect(claims).toEqual(["A two.", "A forty.", "B nine."]);
		for (const withheld of [
			'"severity"',
			'"lens"',
			'"model"',
			'"agreement"',
			'"suggestion"',
			"Rename it.",
			"correctness",
			"security",
			"same-family",
			"other-family",
		]) {
			expect(message).not.toContain(withheld);
		}
		expect(message).toContain('"evidence":"Seen at src/a.ts:2."');
	});

	it("commits the harness's record with attribution, agreement and dispositions", async () => {
		const { ship, service, runId } = await runToShip();
		const lens = await childOf(service, runId, "review-d0/correctness");
		const implementer = await childOf(service, runId, "implement-d0");
		const record = recordOf(ship);
		expect(record).toEqual({
			deliverable: "d0",
			handoffCommit: commitFor(implementer.attemptId),
			reviewers: [
				{
					reviewerKey: expect.stringMatching(/^[0-9a-f]{64}$/),
					lens: "correctness",
					model: MODEL_PROVIDER_ID,
					thinking: "medium",
					// What the router said, carried from the journal.
					alias: "same",
					tier: "normal",
					family: "same-family",
					attemptId: lens.attemptId,
					status: "reported",
					findings: 1,
				},
			],
			clusters: [
				{
					id: "c1",
					claim: "Missing a test.",
					location: { file: "a.txt", line: 1 },
					severity: "high",
					reportedBy: [
						{
							lens: "correctness",
							model: MODEL_PROVIDER_ID,
							thinking: "medium",
							alias: "same",
							tier: "normal",
							family: "same-family",
							attemptId: lens.attemptId,
							findingIndex: 0,
						},
					],
					agreement: { count: 1, of: 1 },
					suggestions: ["Add one next to the change."],
					raw: [{ reviewerIndex: 0, findingIndex: 0 }],
					disposition: { kind: "fixed", reasoning: "Added the test." },
				},
			],
			// One reviewer: nothing for a model to merge, so none was asked.
			normalizer: { mode: "deterministic" },
		});
		expect(taskPaths(ship)).not.toContain("normalize-d0");
	});

	it("shows the gate counts, the record and the last check, and ships the resumed hand-off", async () => {
		const { ship, service, runId } = await runToShip(
			{},
			{
				check: "fail-then-pass",
			},
		);
		const gate = taskByKey(ship, "ship").checkpoint;
		expect(Object.keys(gate?.inputs ?? {}).sort()).toEqual([
			"check-d0",
			"plan",
			"reviews-d0",
			"summary-d0",
		]);
		// The last check is the recheck of H2, and the summary is the resumed
		// implementer's.
		expect(gate?.inputs?.["check-d0"]).toMatchObject({
			checkRan: true,
			checkPassed: true,
		});
		expect(gate?.inputs?.["summary-d0"]).toMatchObject({
			summary: "Answered the check and the review",
		});
		expect(gate?.prompt).toContain(
			"1 handoff patch(es); the last repository check ran for 1 of 1 and passed for 1.",
		);
		expect(gate?.prompt).toContain(
			"Reviews: 1 of 1 reviewer(s) reported; 1 cluster(s), 0 raised by two or more reviewers; 0 contested (0 upheld, 0 overruled, 0 undecidable).",
		);
		expect(gate?.prompt).toContain(
			"Resumes: 1 of 1 deliverable(s) resumed the implementer; 1 fixed, 0 declined, 0 out of scope, 0 unanswered.",
		);
		// The FIRST check ran and failed; the resume saw it.
		const first = taskByKey(ship, "check-d0");
		expect(first.status).toBe("completed");
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(runId), "wait");
		const resumed = await childOf(service, runId, "resume-d0");
		const ref = `refs/pi-subagent/handoffs/${resumed.runId}/${resumed.attemptId}`;
		expect(finished.output).toMatchObject({
			shipped: true,
			deliverables: [
				{
					id: "d0",
					checkRan: true,
					checkPassed: true,
					resumed: true,
					handoff: { handoffCommit: commitFor(resumed.attemptId) },
				},
			],
			receipt: { planDigest: PLAN_DIGEST, refs: [ref] },
		});
		const output = finished.output as { reviews: unknown[] };
		expect(output.reviews).toHaveLength(1);
		expect(Value.Check(ReviewsRecordSchema, output.reviews[0])).toBe(true);
	});

	it("records a receipt with the counts, and the record as a finalizer input", async () => {
		const { delegated, service, runId, ship } = await runToShip();
		await decide(service, ship, "ship", { ship: true, note: "cherry-picked" });
		const finished = await bounded(service.wait(runId), "wait");
		expect(taskByKey(finished, "receipt")).toMatchObject({
			role: "finalizer",
			status: "completed",
		});
		const [recording] = delegated.requestsGoal(
			"Record the plan-to-ship receipt",
		);
		const context = JSON.parse(recording?.task.context[0] ?? "{}");
		expect(context.deliverables[0]).toMatchObject({
			id: "d0",
			resumed: true,
			reviews: {
				reviewers: 1,
				reported: 1,
				clusters: 1,
				agreed: 0,
				fixed: 1,
				declined: 0,
				outOfScope: 0,
				unanswered: 0,
			},
		});
		const projected = recording?.task.context.join("\n") ?? "";
		expect(projected).toContain('"reviews-d0"');
	});
});

describe("plan-to-ship: the review loop, two deliverables", () => {
	it("runs the whole loop for each deliverable, in plan order", async () => {
		const { ship } = await runToShip({ deliverables: 2 });
		expect(taskPaths(ship)).toEqual([
			"refine",
			"implement-d0",
			"implement-d1",
			"check-d0",
			"review-d0/correctness",
			"resume-d0",
			"recheck-d0",
			"reviews-d0",
			"check-d1",
			"review-d1/correctness",
			"resume-d1",
			"recheck-d1",
			"reviews-d1",
			"ship",
		]);
		const gate = taskByKey(ship, "ship").checkpoint;
		expect(Object.keys(gate?.inputs ?? {}).sort()).toEqual([
			"check-d0",
			"check-d1",
			"plan",
			"reviews-d0",
			"reviews-d1",
			"summary-d0",
			"summary-d1",
		]);
		expect(recordOf(ship, "d1").deliverable).toBe("d1");
	});
});

describe("plan-to-ship: normalizing across lenses", () => {
	const SAME_PLACE = {
		a: [lensFinding("src/x.ts", 10, "Input is never validated.", "medium")],
		b: [
			lensFinding(
				"src/x.ts",
				30,
				"Unchecked input reaches the parser.",
				"high",
			),
		],
	};

	it("asks the normalize model only to merge, and records what it merged", async () => {
		const { delegated, ship } = await runToShip(
			{ lensesPerDeliverable: ["a", "b"] },
			{ findings: SAME_PLACE, merges: (ids) => ({ merges: [ids] }) },
		);
		expect(taskPaths(ship)).toContain("normalize-d0");
		const [normalize] = delegated.requestsGoal("Find the clusters");
		expect(normalize?.agent).toBe("reviewer");
		expect(normalize?.workspace).toEqual({
			mode: "read-only",
			cwd: expect.any(String),
		});
		expect(normalize?.tools).toEqual([]);
		// A light `codebase-research` model, asked of the router.
		expect(normalize?.model).toEqual(routedModel("light"));
		expect(normalize?.task.instructions.join("\n")).toContain(
			"You may only merge.",
		);
		const record = recordOf(ship);
		expect(record.normalizer).toEqual({
			mode: "model",
			model: `${routedModel("light").provider}/${routedModel("light").id}`,
			alias: "same",
			tier: "light",
			family: "same-family",
			promptDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(record.clusters).toHaveLength(1);
		expect(record.clusters[0]).toMatchObject({
			id: "c1",
			// The first reporter's claim, verbatim; the severity the highest.
			claim: "Input is never validated.",
			severity: "high",
			agreement: { count: 2, of: 2 },
		});
		expect(taskByKey(ship, "ship").checkpoint?.prompt).toContain(
			"1 cluster(s), 1 raised by two or more reviewers",
		);
	});

	it.each([
		["names a cluster it was not offered", { merges: [["c1", "c9"]] }],
		["rewrites a claim", { merges: [["c1", "c2"]], claims: { c1: "x" } }],
	])(
		"ignores an answer that %s, and keeps the deterministic clusters",
		async (_label, answer) => {
			// The scripted client hands the answer through; pi-subagent would have
			// refused it against the task's schema, and the harness refuses it too.
			const { ship, service, runId } = await runToShip(
				{ lensesPerDeliverable: ["a", "b"] },
				{ findings: SAME_PLACE, merges: () => answer },
			);
			const record = recordOf(ship);
			expect(record.normalizer).toEqual({ mode: "deterministic" });
			expect(record.clusters.map((cluster) => cluster.agreement)).toEqual([
				{ count: 1, of: 2 },
				{ count: 1, of: 2 },
			]);
			await decide(service, ship, "ship", { ship: true });
			await bounded(service.wait(runId), "wait");
		},
	);

	it("falls back to the deterministic clusters when the normalize call fails, and blocks nothing", async () => {
		const { ship, service, runId } = await runToShip(
			{ lensesPerDeliverable: ["a", "b"] },
			{ findings: SAME_PLACE, failNormalize: true },
		);
		expect(taskByKey(ship, "normalize-d0").status).toBe("failed");
		expect(taskByKey(ship, "resume-d0").status).toBe("completed");
		expect(recordOf(ship).normalizer).toEqual({ mode: "deterministic" });
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(runId), "wait");
		expect(finished.status).toBe("completed-degraded");
		const logs = await service.logs(runId, { limit: 500 });
		expect(
			logs.entries.some((entry) =>
				entry.message.includes(
					'the normalize call for "d0" did not complete; the deterministic clusters stand.',
				),
			),
		).toBe(true);
	});
});

describe("plan-to-ship: adjudication", () => {
	/** Three clusters, answered fixed, declined and out of scope, in that order. */
	const THREE = {
		findings: {
			a: [
				lensFinding("a.ts", 1, "One."),
				lensFinding("b.ts", 1, "Two."),
				lensFinding("c.ts", 1, "Three."),
			],
		},
		dispositions: (ids: readonly string[]) =>
			ids.map((id, index) => ({
				id,
				kind: (["fixed", "declined", "out-of-scope"] as const)[index % 3],
				reasoning: `Answer ${index}.`,
			})),
	};

	it("rules on the declined and out-of-scope clusters only, at a frontier model of another family", async () => {
		const { delegated, ship, service, runId } = await runToShip(
			{ lensesPerDeliverable: ["a"] },
			{
				...THREE,
				verdicts: (ids) => ({
					verdicts: ids.map((id, index) => ({
						id,
						verdict: index === 0 ? "upheld" : "overruled",
						reasoning: `Ruling on ${id}.`,
					})),
				}),
			},
		);
		const [adjudicate] = delegated.requestsGoal(
			"Adjudicate what the implementer",
		);
		expect(
			delegated.requestsGoal("Adjudicate what the implementer"),
		).toHaveLength(1);
		expect(adjudicate?.agent).toBe("adjudicator");
		expect(exactModel(adjudicate as SubagentRequest)).toEqual(
			routedModel("frontier", "other"),
		);
		// Read-only, at the resumed hand-off.
		expect(adjudicate?.workspace).toMatchObject({ mode: "read-only" });
		const context = adjudicate?.task.context ?? [];
		// The change first, then the contested items and nothing else.
		expect(context[0]).toMatch(/^The change: the hand-off below/);
		expect(shownIds(context.slice(1).join("\n"))).toEqual(["c2", "c3"]);
		const items = context.slice(1).join("\n");
		expect(items).toContain('"disposition":{"kind":"declined"');
		expect(items).toContain('"disposition":{"kind":"out-of-scope"');
		// The order is fixed: id, claim, location, evidence, then the answer.
		expect(items).toContain(
			'{"id":"c2","claim":"Two.","location":{"file":"b.ts","line":1},"evidence":"Seen at b.ts:1.","disposition":{"kind":"declined","reasoning":"Answer 1."}}',
		);
		for (const withheld of ['"severity"', '"lens"', '"model"', "same-family"]) {
			expect(items).not.toContain(withheld);
		}

		const record = recordOf(ship);
		expect(
			record.clusters.map((cluster) => cluster.adjudication?.verdict),
		).toEqual([undefined, "upheld", "overruled"]);
		expect(record.clusters[1]?.adjudication).toMatchObject({
			reasoning: "Ruling on c2.",
			model: `placeholder/${OTHER_FAMILY_ID}`,
			thinking: "high",
			alias: "other",
			tier: "frontier",
			family: "other-family",
		});
		expect(record.adjudicator).toMatchObject({
			model: `placeholder/${OTHER_FAMILY_ID}`,
			thinking: "high",
			tier: "frontier",
			promptDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		const prompt = taskByKey(ship, "ship").checkpoint?.prompt ?? "";
		expect(prompt).toContain(
			"; 2 contested (1 upheld, 1 overruled, 0 undecidable).",
		);
		// Two of three clusters contested: the spec is the likely problem.
		expect(prompt).toContain(
			'Deliverable "d0": 2 of 3 clusters were contested, so its spec is the likely problem, not its implementation.',
		);
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(runId), "wait");
		// No ruling holds the run.
		expect(finished.status).toBe("completed");
		const note = (finished.output as { receipt: { note: string } }).receipt
			.note;
		expect(note).toContain(
			"3 review cluster(s), 1 declined, 2 contested, 1 upheld",
		);
		expect(note).toContain("its spec is the likely problem");
	});

	it("skips the stage with a log line when nothing was contested", async () => {
		// One cluster, answered fixed.
		const { ship, service, runId } = await runToShip();
		expect(taskPaths(ship)).not.toContain("adjudicate-d0");
		const logs = await service.logs(runId, { limit: 500 });
		expect(
			logs.entries.some((entry) =>
				entry.message.includes(
					'the implementer of "d0" contested nothing, so there is nothing to adjudicate',
				),
			),
		).toBe(true);
		expect(recordOf(ship)).not.toHaveProperty("adjudicator");
		expect(taskByKey(ship, "ship").checkpoint?.prompt).not.toContain(
			"spec is the likely problem",
		);
	});

	it.each([
		[
			// Within the schema's count and ids, so only the harness can see it.
			"repeats an id",
			(ids: readonly string[]) => ({
				verdicts: ids.map((id, index) => ({
					id: ids[0] ?? id,
					verdict: "upheld",
					reasoning: `Twice ${index}.`,
				})),
			}),
			"it answers c2 more than once",
		],
	])(
		"refuses an answer that %s, logs it, and holds nothing",
		async (_name, verdicts, problem) => {
			const { delegated, ship, service, runId } = await runToShip(
				{ lensesPerDeliverable: ["a"] },
				{ ...THREE, verdicts },
			);
			// Refused whole, and never retried.
			expect(
				delegated.requestsGoal("Adjudicate what the implementer"),
			).toHaveLength(1);
			const logs = await service.logs(runId, { limit: 500 });
			expect(
				logs.entries.some((entry) =>
					entry.message.includes(
						`the adjudication of "d0" was refused: ${problem}; its contested clusters stay unadjudicated`,
					),
				),
			).toBe(true);
			const record = recordOf(ship);
			expect(record.clusters.every((cluster) => !cluster.adjudication)).toBe(
				true,
			);
			expect(record).not.toHaveProperty("adjudicator");
			expect(taskByKey(ship, "ship").checkpoint?.prompt).toContain(
				"; 2 contested (0 upheld, 0 overruled, 0 undecidable).",
			);
			await decide(service, ship, "ship", { ship: true });
			expect((await bounded(service.wait(runId), "wait")).status).toMatch(
				/^completed/,
			);
		},
	);

	// An answer outside the task's own schema - a missing or an invented id -
	// never completes the task: pi-subagent refuses it against the schema, so
	// the run sees a judge that failed. That is this case; `checkVerdicts`'s
	// own wording for both is pinned in components-review-record.test.ts.
	it("leaves the clusters unadjudicated when the judge fails, and still reaches the gate", async () => {
		const { ship, service, runId } = await runToShip(
			{ lensesPerDeliverable: ["a"] },
			{ ...THREE, failAdjudicate: true },
		);
		expect(taskByKey(ship, "adjudicate-d0").status).toBe("failed");
		const logs = await service.logs(runId, { limit: 500 });
		expect(
			logs.entries.some((entry) =>
				entry.message.includes(
					'the adjudication of "d0" was refused: it did not complete',
				),
			),
		).toBe(true);
		expect(recordOf(ship)).not.toHaveProperty("adjudicator");
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(runId), "wait");
		expect(finished.status).toBe("completed-degraded");
	});

	it("says nothing about the spec under half, or with a single contested cluster", async () => {
		const one = await runToShip(
			{ lensesPerDeliverable: ["a"] },
			{
				findings: {
					a: [lensFinding("a.ts", 1, "One."), lensFinding("b.ts", 1, "Two.")],
				},
				dispositions: (ids) =>
					ids.map((id, index) => ({
						id,
						kind: index === 0 ? "fixed" : "declined",
						reasoning: "Answered.",
					})),
			},
		);
		// One of two is half, but a single contested cluster is no pattern.
		expect(taskByKey(one.ship, "ship").checkpoint?.prompt).toContain(
			"; 1 contested (1 upheld, 0 overruled, 0 undecidable).",
		);
		expect(taskByKey(one.ship, "ship").checkpoint?.prompt).not.toContain(
			"spec is the likely problem",
		);
	});

	it("puts the counts and the spec sentence on the per-deliverable gate and the ship summary", async () => {
		const gated = scripted(THREE);
		const service = await serviceFor(gated);
		const run = await service.run(
			"plan-to-ship",
			input({
				deliverables: 2,
				lensesPerDeliverable: ["a"],
				policy: { gates: "every-deliverable" },
			}),
		);
		const gateOne = await park(service, run.runId, "approve-d0");
		const prompt = taskByKey(gateOne, "approve-d0").checkpoint?.prompt ?? "";
		expect(prompt).toContain(
			"; 2 contested (2 upheld, 0 overruled, 0 undecidable).",
		);
		expect(prompt).toContain(
			'Deliverable "d0": 2 of 3 clusters were contested, so its spec is the likely problem, not its implementation.',
		);

		const auto = scripted(THREE);
		const autoService = await serviceFor(auto);
		const autoRun = await autoService.run(
			"plan-to-ship",
			input({ lensesPerDeliverable: ["a"], policy: { gates: "none" } }),
		);
		const finished = await bounded(autoService.wait(autoRun.runId), "wait");
		const summary = (
			finished.output as {
				shipSummary?: { deliverables: readonly { contested?: unknown }[] };
			}
		).shipSummary;
		expect(summary?.deliverables[0]?.contested).toEqual({
			contested: 2,
			upheld: 2,
			overruled: 0,
			undecidable: 0,
			note: 'Deliverable "d0": 2 of 3 clusters were contested, so its spec is the likely problem, not its implementation.',
		});
	});

	it("is compiled only with reviews and a resume", () => {
		const keys = (options: PlanOptions, policy?: PolicyInput) =>
			compileStages(plan(options), policy).deliverables[0]?.stages.map(
				(stage) => stage.key,
			);
		expect(keys({})).toContain("adjudicate-d0");
		expect(keys({ lensesPerDeliverable: [] })).not.toContain("adjudicate-d0");
		expect(keys({}, { resumes: 0 })).not.toContain("adjudicate-d0");
	});
});

describe("plan-to-ship: dispositions", () => {
	it("never holds the run on a decline", async () => {
		const { ship, service, runId } = await runToShip(
			{},
			{
				dispositions: (ids) =>
					ids.map((id) => ({
						id,
						kind: "declined",
						reasoning: "The reviewer misread the contract.",
					})),
			},
		);
		expect(recordOf(ship).clusters[0]?.disposition).toEqual({
			kind: "declined",
			reasoning: "The reviewer misread the contract.",
		});
		expect(taskByKey(ship, "ship").checkpoint?.prompt).toContain(
			"0 fixed, 1 declined, 0 out of scope, 0 unanswered. A decline is the implementer's reasoned answer, not a failure.",
		);
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(runId), "wait");
		expect(finished.status).toBe("completed");
		expect(finished.output).toMatchObject({
			shipped: true,
			deliverables: [{ id: "d0", resumed: true }],
		});
	});

	it("refuses an answer that skips an item, and ships the first hand-off with nothing answered", async () => {
		const { ship, service, runId } = await runToShip(
			{ lensesPerDeliverable: ["a"] },
			{
				findings: {
					a: [lensFinding("a.ts", 1, "One."), lensFinding("b.ts", 1, "Two.")],
				},
				dispositions: (ids) => [
					{ id: ids[0], kind: "fixed", reasoning: "Done." },
				],
			},
		);
		// The child answered; the harness refused the answer, because it does
		// not name every shown id exactly once.
		expect(taskByKey(ship, "resume-d0").status).toBe("completed");
		expect(taskPaths(ship)).not.toContain("recheck-d0");
		const logs = await service.logs(runId, { limit: 500 });
		expect(
			logs.entries.some((entry) =>
				entry.message.includes(
					'the resume was refused: it leaves c2 unanswered for "d0"',
				),
			),
		).toBe(true);
		const record = recordOf(ship);
		expect(record.clusters.map((cluster) => cluster.disposition)).toEqual([
			undefined,
			undefined,
		]);
		expect(taskByKey(ship, "ship").checkpoint?.prompt).toContain(
			"0 fixed, 0 declined, 0 out of scope, 2 unanswered",
		);
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(runId), "wait");
		const implementer = await childOf(service, runId, "implement-d0");
		expect(finished.output).toMatchObject({
			deliverables: [
				{
					id: "d0",
					resumed: false,
					handoff: { handoffCommit: commitFor(implementer.attemptId) },
				},
			],
		});
	});

	it("keeps H1 and skips the recheck when the resume changed nothing", async () => {
		const { ship, service, runId } = await runToShip(
			{},
			{
				resumeChangesNothing: true,
			},
		);
		expect(taskPaths(ship)).toContain("resume-d0");
		expect(taskPaths(ship)).not.toContain("recheck-d0");
		const implementer = await childOf(service, runId, "implement-d0");
		// The continuation's hand-off is the run's latest export, which is still
		// the implementer's: same commit, same attempt.
		expect(taskByKey(ship, "resume-d0").handoff).toMatchObject({
			handoffCommit: commitFor(implementer.attemptId),
			subagentAttemptId: implementer.attemptId,
		});
		expect(recordOf(ship).clusters[0]?.disposition?.kind).toBe("fixed");
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(runId), "wait");
		expect(finished.status).toBe("completed");
		expect(
			(finished.output as { receipt: { refs: string[] } }).receipt.refs,
		).toEqual([
			`refs/pi-subagent/handoffs/${implementer.runId}/${implementer.attemptId}`,
		]);
	});

	it("fails the resume by name when pi-subagent will not resume, and ships H1", async () => {
		const { ship, service, runId } = await runToShip(
			{},
			{
				refuseResume: true,
			},
		);
		const resume = taskByKey(ship, "resume-d0");
		expect(resume.status).toBe("failed");
		expect(resume.narration).toMatchObject({
			taskKind: "resume",
			deliverable: "d0",
		});
		expect(JSON.stringify(ship)).not.toContain("spent resumes");
		const events = await journal(service, runId);
		expect(
			events.some(
				(event) =>
					event.type === "task-execution-terminal" &&
					(event.data.evidence as { message?: string }).message ===
						"Subagent did not resume the producer's run at its hand-off.",
			),
		).toBe(true);
		// The record still commits: nothing hangs off the failed resume.
		expect(taskByKey(ship, "reviews-d0").status).toBe("completed");
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(runId), "wait");
		expect(finished.status).toBe("completed-degraded");
		expect(finished.output).toMatchObject({
			deliverables: [{ id: "d0", resumed: false }],
		});
	});
});

describe("plan-to-ship: policy.resumes 0", () => {
	it("sends the findings to the gate with no resume, no recheck and no dispositions", async () => {
		const { ship, delegated, service, runId } = await runToShip({
			policy: { resumes: 0 },
		});
		expect(taskPaths(ship)).toEqual([
			"refine",
			"implement-d0",
			"check-d0",
			"review-d0/correctness",
			"reviews-d0",
			"ship",
		]);
		expect(delegated.resume).not.toHaveBeenCalled();
		const record = recordOf(ship);
		expect(record.clusters).toHaveLength(1);
		expect(record.clusters[0]).not.toHaveProperty("disposition");
		expect(taskByKey(ship, "ship").checkpoint?.prompt).toContain(
			"Resumes: none, because `policy.resumes` is 0; 1 cluster(s) are unanswered.",
		);
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(runId), "wait");
		expect(finished.output).toMatchObject({
			deliverables: [{ id: "d0", resumed: false }],
		});
	});
});

describe("plan-to-ship: when there is nothing to answer", () => {
	it("skips the resume when no lens found anything and the check passed", async () => {
		const { ship } = await runToShip({}, { findings: { correctness: [] } });
		expect(taskPaths(ship)).toEqual([
			"refine",
			"implement-d0",
			"check-d0",
			"review-d0/correctness",
			"reviews-d0",
			"ship",
		]);
	});

	it("resumes on a failing check with no reviewer, and rechecks", async () => {
		const { ship, delegated } = await runToShip(
			{ lensesPerDeliverable: [] },
			{ check: "fail-then-pass" },
		);
		expect(taskPaths(ship)).toEqual([
			"refine",
			"implement-d0",
			"check-d0",
			"resume-d0",
			"recheck-d0",
			"ship",
		]);
		expect(shownIds(delegated.resumes[0]?.message ?? "")).toEqual([]);
		expect(
			Object.keys(taskByKey(ship, "ship").checkpoint?.inputs ?? {}).sort(),
		).toEqual(["check-d0", "plan", "summary-d0"]);
	});

	it("does not resume on a check that did not run, and says the change is unverified", async () => {
		const { ship, service, runId } = await runToShip(
			{ lensesPerDeliverable: [] },
			{ check: "not-run" },
		);
		expect(taskPaths(ship)).not.toContain("resume-d0");
		await decide(service, ship, "ship", { ship: false });
		const finished = await bounded(service.wait(runId), "wait");
		expect(finished.output).toMatchObject({
			deliverables: [{ id: "d0", checkRan: false, checkPassed: false }],
		});
	});
});

describe("plan-to-ship: what a host needs to narrate", () => {
	it("names every settled task's stage, kind and deliverable, and the deliverable is the plan's id", async () => {
		const delegated = scripted({
			findings: {
				a: [lensFinding("x.ts", 1, "One.")],
				b: [lensFinding("y.ts", 1, "Two.")],
			},
		});
		const service = await serviceFor(delegated);
		const observed: WorkflowRunObservation[] = [];
		const unsubscribe = service.subscribe((observation) => {
			observed.push(observation);
		});
		const run = await service.run(
			"plan-to-ship",
			input({ lensesPerDeliverable: ["a", "b"] }),
		);
		const ship = await park(service, run.runId, "ship");
		await decide(service, ship, "ship", { ship: true });
		await bounded(service.wait(run.runId), "wait");
		unsubscribe();
		const settled = observed.flatMap((observation) =>
			observation.task ? [observation.task] : [],
		);
		expect(
			settled
				.map((task) => [
					task.narration.stage,
					task.narration.taskKind,
					task.narration.deliverable,
					task.status,
				])
				.sort(([left], [right]) => String(left).localeCompare(String(right))),
		).toEqual(
			[
				["refine", "refine", undefined, "completed"],
				["implement-d0", "implement", "d0", "completed"],
				["check-d0", "check", "d0", "completed"],
				["review-d0/a", "review", "d0", "completed"],
				["review-d0/b", "review", "d0", "completed"],
				["normalize-d0", "normalize", "d0", "completed"],
				["resume-d0", "resume", "d0", "completed"],
				["recheck-d0", "check", "d0", "completed"],
				["adjudicate-d0", "adjudicate", "d0", "completed"],
				["reviews-d0", "other", undefined, "completed"],
				["ship", "gate", undefined, "completed"],
				["receipt", "other", undefined, "completed"],
			].sort(([left], [right]) => String(left).localeCompare(String(right))),
		);
		for (const task of settled) {
			expect(task.narration.summary).toBeUndefined();
			expect(task.narration.cause).toBeUndefined();
			if (task.narration.deliverable !== undefined) {
				expect(task.narration.deliverable).toBe("d0");
			}
		}
	});

	it("carries each task's own summary on the inspection that reads output", async () => {
		const { service, runId, ship } = await runToShip();
		await decide(service, ship, "ship", { ship: true });
		await bounded(service.wait(runId), "wait");
		const inspected = await service.inspect(runId, {
			include: ["run", "tasks", "output"],
		});
		const narrated = new Map(
			(inspected.tasks ?? []).map((task) => [
				task.narration?.stage,
				task.narration,
			]),
		);
		expect(narrated.get("implement-d0")?.summary).toBe("Edited a.txt");
		expect(narrated.get("resume-d0")).toMatchObject({
			taskKind: "resume",
			deliverable: "d0",
			summary: "Answered the check and the review",
		});
		expect(narrated.get("recheck-d0")).toMatchObject({
			taskKind: "check",
			deliverable: "d0",
			summary: "The check passed.",
		});
	});

	it("says why a lens failed, in a sanitized sentence", async () => {
		const { ship } = await runToShip({}, { failReview: true });
		const review = taskByKey(ship, "review-d0/correctness");
		expect(review.narration).toMatchObject({
			taskKind: "review",
			deliverable: "d0",
			cause:
				"The delegated run failed: model-output (origin model, retry never).",
		});
		expect(JSON.stringify(ship)).not.toContain("reviewer produced nothing");
	});
});

describe("plan-to-ship: the gate policies", () => {
	it("asks one decision — the ship gate — when the policy is the default", async () => {
		const { ship, service, runId } = await runToShip({
			deliverables: 2,
			lensesPerDeliverable: [],
		});
		expect(
			Object.keys(taskByKey(ship, "ship").checkpoint?.inputs ?? {}),
		).toEqual(
			["plan", "summary-d0", "check-d0", "summary-d1", "check-d1"].sort(),
		);
		expect(taskByKey(ship, "ship").checkpoint?.inputs).toMatchObject({
			plan: { summary: "Refined.", blockers: [] },
		});
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(runId), "wait");
		expect(finished.status).toBe("completed");
		expect(taskPaths(finished)).toEqual([
			"refine",
			"implement-d0",
			"implement-d1",
			"check-d0",
			"check-d1",
			"ship",
			"receipt",
		]);
		expect(
			(finished.output as { receipt: { refs: string[] } }).receipt.refs,
		).toHaveLength(2);
	});

	it("completes with no gate at all when the policy is none, and carries the ship inputs as output", async () => {
		const delegated = scripted();
		const service = await serviceFor(delegated);
		const run = await service.run(
			"plan-to-ship",
			input({
				deliverables: 2,
				lensesPerDeliverable: ["a"],
				policy: { gates: "none" },
			}),
		);
		const finished = await bounded(service.wait(run.runId), "wait");
		expect(finished.status).toBe("completed");
		expect(
			(finished.tasks ?? []).filter((task) => task.kind === "checkpoint"),
		).toEqual([]);
		const output = finished.output as {
			shipped: boolean;
			receipt: { planDigest: string; refs: string[]; note: string };
			shipSummary?: {
				plan: { summary: string };
				deliverables: readonly {
					id: string;
					summary: { summary: string };
					reviews?: unknown;
					check: { checkPassed: boolean };
				}[];
			};
		};
		expect(output.shipped).toBe(true);
		expect(output.receipt.refs).toHaveLength(2);
		expect(output.receipt.note).toContain(
			"no ship gate; the host publishes on completion",
		);
		expect(output.shipSummary?.plan.summary).toBe("Refined.");
		for (const entry of output.shipSummary?.deliverables ?? []) {
			expect(entry.summary.summary).toBe("Answered the check and the review");
			expect(Value.Check(ReviewsRecordSchema, entry.reviews)).toBe(true);
			expect(entry.check.checkPassed).toBe(true);
		}
		expect(
			compileStages(plan({ deliverables: 2 }), { gates: "none" }).gates,
		).toEqual([]);
	});

	it("carries no shipSummary under ship", async () => {
		const { ship, service, runId } = await runToShip({
			lensesPerDeliverable: [],
		});
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(runId), "wait");
		expect(finished.output).not.toHaveProperty("shipSummary");
	});

	it("gates after every deliverable but the last, walking strictly in order", async () => {
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
		expect(taskPaths(first)).toEqual([
			"refine",
			"implement-d0",
			"check-d0",
			"approve-d0",
		]);
		expect(taskByKey(first, "approve-d0").checkpoint?.prompt).toContain(
			"The last check ran and passed.",
		);
		await decide(service, first, "approve-d0", { proceed: true });
		const ship = await park(service, run.runId, "ship");
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(run.runId), "wait");
		expect(taskPaths(finished)).toEqual([
			"refine",
			"implement-d0",
			"check-d0",
			"approve-d0",
			"implement-d1",
			"check-d1",
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
		expect(
			(finished.output as { receipt: { note: string } }).receipt.note,
		).toContain("stopped at gate approve-d0");
	});
});

describe("plan-to-ship: replay", () => {
	it("re-declares the identical prefix on every drive, including after a restart", async () => {
		const delegated = scripted({ check: "fail-then-pass" });
		const base = path.resolve(".pi", "test-plan-to-ship", randomUUID());
		const cwd = path.join(base, "project");
		await mkdir(cwd, { recursive: true });
		const options = {
			cwd,
			agentDir: path.join(base, "agent"),
			storeRoot: path.join(cwd, "state"),
			projectTrusted: () => false,
			subagents: delegated.provider,
			sessionModel: () => SESSION_MODEL,
			modelRouting: testModelRouting,
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
		await first.shutdown();
		services.splice(services.indexOf(first), 1);
		const second = await createWorkflowService(options);
		services.push(second);
		const reopened = await second.status(run.runId);
		expect(taskPaths(reopened).slice(0, prefix.length)).toEqual(prefix);
		await decide(second, reopened, "ship", { ship: true });
		const finished = await bounded(second.wait(run.runId), "wait");
		expect(finished.status).toBe("completed");
		expect(taskPaths(finished)).toEqual([
			"refine",
			"implement-d0",
			"check-d0",
			"review-d0/correctness",
			"resume-d0",
			"recheck-d0",
			"reviews-d0",
			"approve-d0",
			"implement-d1",
			"check-d1",
			"review-d1/correctness",
			"resume-d1",
			"recheck-d1",
			"reviews-d1",
			"ship",
			"receipt",
		]);
	});
});

describe("plan-to-ship: a reviewer that dies", () => {
	it("still asks the ship gate when every lens died, and the record says so", async () => {
		const { ship, service, runId } = await runToShip({}, { failReview: true });
		const record = recordOf(ship);
		expect(record.reviewers).toEqual([
			expect.objectContaining({
				lens: "correctness",
				status: "failed",
				findings: 0,
			}),
		]);
		expect(record.clusters).toEqual([]);
		// Nothing to answer: no finding, and the check passed.
		expect(taskPaths(ship)).not.toContain("resume-d0");
		await decide(service, ship, "ship", { ship: true });
		const finished = await bounded(service.wait(runId), "wait");
		expect(finished.status).toBe("completed-degraded");
		expect(finished.output).toMatchObject({ shipped: true });
	});

	it("subtracts a dead lens's coverage and blocks nothing after it", async () => {
		const { ship, service, runId } = await runToShip(
			{ lensesPerDeliverable: ["a", "b"] },
			{ failLens: "b" },
		);
		expect(taskByKey(ship, "review-d0/b").status).toBe("failed");
		// One lens reported, so no model was asked to merge anything.
		expect(taskPaths(ship)).not.toContain("normalize-d0");
		expect(taskByKey(ship, "resume-d0").status).toBe("completed");
		const record = recordOf(ship);
		expect(record.reviewers.map((entry) => entry.status)).toEqual([
			"reported",
			"failed",
		]);
		expect(record.clusters[0]?.agreement).toEqual({ count: 1, of: 1 });
		await decide(service, ship, "ship", { ship: true });
		expect((await bounded(service.wait(runId), "wait")).status).toBe(
			"completed-degraded",
		);
	});
});

describe("plan-to-ship: models per role", () => {
	it("inherits the session model for the work and takes the table's limits", async () => {
		const delegated = scripted();
		const service = await serviceFor(delegated);
		const run = await service.run(
			"plan-to-ship",
			input({ lensesPerDeliverable: ["a", "b"] }),
		);
		await park(service, run.runId, "ship");

		// THE WORK INHERITS. Every task of an inheriting role carries the run's
		// one resolved session model - the literal never reaches a request - and
		// its limits still come from the stage table.
		const refine = delegated.requestsGoal("Refine the authored plan")[0];
		expect(refine?.model).toEqual(SESSION_MODEL);
		expect(refine?.limits).toEqual(envelope("refine").limits);
		const implement = delegated.requestsFor("implementer")[0];
		expect(implement?.model).toEqual(SESSION_MODEL);
		expect(implement?.limits.cumulativeRuntimeMs).toBe(
			envelope("implement").limits.cumulativeRuntimeMs,
		);
		// One model for the whole run: nothing that inherited differs.
		const inherited = [
			...delegated.requestsGoal("Refine the authored plan"),
			...delegated.requestsFor("implementer"),
		];
		expect(inherited.length).toBeGreaterThan(2);
		for (const request of inherited) {
			expect(request.model).toEqual(SESSION_MODEL);
		}

		// The check and the recheck inherit too; the resume reruns the
		// implementer's own plan, so its model is the implementer's.
		for (const verify of delegated.requestsGoal("Verify deliverable")) {
			expect(verify.model).toEqual(SESSION_MODEL);
		}
		// A REVIEW keeps its tier, and the normalize call is pinned.
		expect(delegated.requestsFor("reviewer").length).toBeGreaterThanOrEqual(2);
		for (const review of delegated.requestsFor("reviewer")) {
			expect(review.model).not.toEqual(SESSION_MODEL);
		}
	});

	it("records the resolved session model on the run", async () => {
		const delegated = scripted();
		const service = await serviceFor(delegated);
		const run = await service.run("plan-to-ship", input());
		await park(service, run.runId, "ship");
		const record = await WorkflowRunRecordStore.readFrom(
			runDirectory(service, run.runId),
			run.runId,
		);
		expect(record.sessionModel).toEqual(SESSION_MODEL);
		expect(record.contractRevision).toBe(26);
	});

	it("refuses the start by name when the host has no session model", async () => {
		const delegated = scripted();
		const base = path.resolve(".pi", "test-plan-to-ship", randomUUID());
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
			// No provider at all: exactly what an embedder with no session means.
		});
		services.push(service);
		await expect(service.run("plan-to-ship", input())).rejects.toThrow(
			"plan-to-ship inherits the session model, and this host has none.",
		);
		// Refused BEFORE the run exists: nothing durable, nothing delegated.
		await expect(service.listRuns()).resolves.toMatchObject({ runs: [] });
		expect(delegated.requests).toHaveLength(0);
	});

	it("refuses the start by name when the host has no model router", async () => {
		const delegated = scripted();
		const base = path.resolve(".pi", "test-plan-to-ship", randomUUID());
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
			sessionModel: () => SESSION_MODEL,
			// A provider that answers nothing: no router registered on the bus.
			modelRouting: () => undefined,
		});
		services.push(service);
		await expect(service.run("plan-to-ship", input())).rejects.toThrow(
			"plan-to-ship resolves models through routing, and this host has none.",
		);
		await expect(service.run("plan-to-ship", input())).rejects.toMatchObject({
			code: "validation",
		});
		// Refused BEFORE the run exists: nothing durable, nothing delegated.
		await expect(service.listRuns()).resolves.toMatchObject({ runs: [] });
		expect(delegated.requests).toHaveLength(0);
	});

	it("routes a diverse lens to another family and stamps the router's evidence", async () => {
		const delegated = scripted({
			findings: { a: [lensFinding("x.ts", 1, "One.")] },
		});
		const service = await serviceFor(delegated);
		const run = await service.run(
			"plan-to-ship",
			input({ lensesPerDeliverable: ["a"], diverse: true, tier: "light" }),
		);
		const ship = await park(service, run.runId, "ship");
		const [review] = delegated.requestsFor("reviewer");
		expect(exactModel(review as SubagentRequest)).toEqual(
			routedModel("light", "other"),
		);
		expect(exactModel(review as SubagentRequest)?.id).toBe(OTHER_FAMILY_ID);
		const record = recordOf(ship);
		expect(record.reviewers[0]).toMatchObject({
			lens: "a",
			model: `placeholder/${OTHER_FAMILY_ID}`,
			thinking: "low",
			alias: "other",
			tier: "light",
			family: "other-family",
		});
		expect(record.clusters[0]?.reportedBy[0]).toMatchObject({
			alias: "other",
			tier: "light",
			family: "other-family",
		});
		// No stand-in disclosure survives: the router chose.
		const lines = (await journal(service, run.runId))
			.map((line) => JSON.stringify(line.data))
			.join("\n");
		expect(lines).not.toContain("stand-in");
	});

	it("honours a review's tier and lets an exact pin outrank it", async () => {
		const delegated = scripted();
		const service = await serviceFor(delegated);
		const run = await service.run(
			"plan-to-ship",
			input({
				lensesPerDeliverable: ["security"],
				tier: "light",
				pinnedModel: "placeholder/other-family",
			}),
		);
		await park(service, run.runId, "ship");
		expect(delegated.requestsFor("reviewer")[0]?.model).toEqual({
			provider: "placeholder",
			id: "other-family",
			// A pin names no thinking, so it takes the review stage's row; a
			// tier is a router's choice and a pin is not one.
			thinking: envelope("review").thinking,
		});
		const tiered = scripted();
		const routedService = await serviceFor(tiered);
		const routedRun = await routedService.run(
			"plan-to-ship",
			input({ lensesPerDeliverable: ["security"], tier: "light" }),
		);
		await park(routedService, routedRun.runId, "ship");
		expect(tiered.requestsFor("reviewer")[0]?.model).toEqual(
			routedModel("light"),
		);
	});
});

describe("plan-to-ship: the input contract", () => {
	it("accepts the v8 shape", async () => {
		const service = await serviceFor(scripted());
		for (const value of [
			input(),
			input({ policy: { gates: "ship" } }),
			input({ policy: { gates: "none" } }),
			input({ policy: { resumes: 0 } }),
			input({ policy: { resumes: 1 } }),
			input({ lensesPerDeliverable: [] }),
			{ ...input(), plan: { ...plan(), body: "Why this plan exists." } },
			input({
				lensesPerDeliverable: ["contracts", "replay"],
				tier: "light",
				diverse: true,
				pinnedModel: "placeholder/same-family",
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
			"plan schema v8 moved review routing to `deliverables[].reviews`",
		],
		[
			"tasks[].by",
			() => withTaskKey(plan(), "by", { lens: "correctness" }),
			"plan schema v3's name for a task review",
		],
		[
			"deliverables[].stages",
			() => withStages(plan(), [{ use: "implement", id: "build" }]),
			"plan schema v8 does not author stages",
		],
		[
			"policy.effort",
			() => ({ ...plan(), policy: { effort: "deep" as unknown as never } }),
			"plan schema v8 removed `policy.effort`; models are set per role and budgets are fixed",
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
		[
			"policy.maxFixRounds",
			() => ({ ...plan(), policy: { maxFixRounds: 1 as unknown as never } }),
			"`policy.maxFixRounds` was removed with the fixer",
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

	it("refuses a bad digest and an unknown plan field", async () => {
		const service = await serviceFor(scripted());
		for (const bad of [
			{ ...input(), planDigest: "not-a-digest" },
			{ ...input(), effort: "standrd" },
			{ ...input(), extra: true },
			{ ...input(), plan: { ...plan(), policy: { gates: "sometimes" } } },
			{ ...input(), plan: { ...plan(), policy: { resumes: 2 } } },
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
	it.each([[WORKTREE_MEMORY_BYTES]])(
		"asks for %i bytes of memory on every worktree task and says so in the instructions",
		async (memoryBytes) => {
			const delegated = scripted();
			const service = await serviceFor(delegated);
			const run = await service.run("plan-to-ship", input());
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

	it("covers every request a run makes", async () => {
		// The widest run: two lenses (so the normalize call runs), a failing
		// check (so the resume runs), and a recheck.
		const delegated = scripted({
			check: "fail",
			findings: {
				a: [lensFinding("x.ts", 1, "One.")],
				b: [lensFinding("y.ts", 1, "Two.")],
			},
		});
		const service = await serviceFor(delegated);
		const run = await service.run(
			"plan-to-ship",
			input({ lensesPerDeliverable: ["a", "b"] }),
		);
		const ship = await park(service, run.runId, "ship");
		await decide(service, ship, "ship", { ship: true });
		await bounded(service.wait(run.runId), "wait");

		const agents = await discoverAgents([
			{ scope: "package", directory: AGENT_TEMPLATES, trusted: true },
		]);
		// The check and the recheck, and the normalize call.
		expect(delegated.requestsGoal("Verify deliverable")).toHaveLength(2);
		expect(delegated.requestsGoal("Find the clusters")).toHaveLength(1);
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
			// pi-workflow sends the RESOLVED exact model, so preflight checks it
			// against the template's exact entries as an ordinary request; the
			// template's `inherit` entry admits a direct delegation, not this.
			const model = exactModel(request);
			if (model) {
				expect(agent.allowedModels).toContain(
					`${model.provider}/${model.id}:${model.thinking}`,
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

describe("plan-to-ship: a verifier that times out", () => {
	it("fails the task by name before the run, and the run says which task and why", async () => {
		// The 2026-10-31 run: the verifier hit its runtime limit, pi-subagent
		// settled it `failed` with its worktree `retained`, the reducer refused
		// that settlement, the task stayed `running`, and the run ended on the
		// generic source-failure reason with nothing failed.
		const delegated = scripted({ failVerify: true });
		const service = await serviceFor(delegated);
		const run = await service.run("plan-to-ship", input());
		const finished = await bounded(service.wait(run.runId), "wait");

		expect(finished.status).toBe("failed");
		const inspected = await service.inspect(run.runId, { include: ["run"] });
		expect(inspected.run.taskCounts.failed).toBe(1);
		const cause =
			"The delegated run failed: timeout (origin service, retry manual).";
		expect(taskByKey(finished, "check-d0")).toMatchObject({
			status: "failed",
			outcome: "failed",
			narration: { taskKind: "check", cause },
		});

		const events = (
			await readFile(
				path.join(runDirectory(service, run.runId), "events.jsonl"),
				"utf8",
			)
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as JournalLine);
		const verifier = taskByKey(finished, "check-d0").id;
		const taskFailed = events.findIndex(
			(event) =>
				event.type === "task-status-changed" &&
				event.data.taskId === verifier &&
				event.data.to === "failed",
		);
		const runFailed = events.findIndex(
			(event) =>
				event.type === "run-status-changed" && event.data.to === "failed",
		);
		expect(taskFailed).toBeGreaterThan(-1);
		expect(runFailed).toBeGreaterThan(taskFailed);
		expect(events[runFailed]?.data.reason).toBe(
			`A required workflow task did not complete: check-d0. ${cause}`,
		);
		// The settlement records the retained worktree, and the release is what
		// proves its cleanup.
		expect(
			events.slice(taskFailed - 5, taskFailed).map((event) => event.type),
		).toEqual([
			"task-execution-child-observed",
			"task-execution-child-settled",
			"task-execution-release-intended",
			"task-execution-released",
			"task-execution-terminal",
		]);
		expect(events[taskFailed - 4]?.data.evidence).toMatchObject({
			status: "failed",
			workspaceCleanup: "retained",
			failure: { code: "timeout" },
		});
	});
});
