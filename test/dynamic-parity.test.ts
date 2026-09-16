import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
	type AgentLaunchPlan,
	canonicalSha256,
	type RunReceipt,
	type RunResult,
	SUBAGENT_RUNTIME_CONTRACT,
	type SubagentClient,
	type SubagentRequest,
} from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { afterAll, describe, expect, it } from "vitest";
import type { WorkflowDecisionRecord } from "../src/decision-store.js";
import { deriveDynamicVmSeed } from "../src/dynamic/definition.js";
import {
	DYNAMIC_APPROVAL_FILE,
	DYNAMIC_RUN_DEFINITION_DIRECTORY,
} from "../src/dynamic/run-definition.js";
import { createDynamicVmContext } from "../src/dynamic/shim.js";
import type { WorkflowJournalEvent } from "../src/persistence/journal.js";
import { type DiscoveredWorkflow, discoverWorkflows } from "../src/registry.js";
import {
	createWorkflowService,
	type DynamicWorkflowProposalView,
	type WorkflowService,
} from "../src/service.js";
import type {
	WorkflowRunInspection,
	WorkflowServiceRunView,
} from "../src/service-views.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";
import {
	defineSupportTask,
	type SupportTaskExecutionContext,
} from "../src/support.js";

/*
 * Spec 11.1 parity harness, driven through the real service instead of a
 * fake scheduler: every fixture source is installed as a static project
 * workflow and proposed/approved/run as a dynamic one, and the two runs must
 * produce identical ordered `{ type, data }` journal payloads, result values,
 * artifact digests, and inspection views once run-specific fields are
 * normalised. The one documented exception (D9, decision 8 beyond the brief)
 * is the `-> failed` reason of a throwing source.
 *
 * Identity: the spec's harness drives both sides under the *same*
 * `definitionIdentitySha256` constant; through the service that is impossible
 * by design (D5): the static identity is the registry's path-bearing digest
 * and the dynamic one is `sha256({ contractRevision, hostApiSha256, kind:
 * "dynamic-workflow", manifestSha256, sourceSha256 })`, so the two never
 * collide. Every task `identitySha256` inherits its definition identity
 * (materializer.ts), so identity digests are normalised by first appearance
 * rather than compared literally, and the divergence is asserted explicitly.
 *
 * Budget: every static `run` re-discovers the project, a dynamic drive boots a
 * tsx worker, and each drive is fsync-bound. Each fixture therefore has its
 * own project and service (one workflow file to load) and three tests:
 * propose/approve, static drive, dynamic drive plus comparison.
 *
 * The package shims below resolve to the built `dist/` entry, as the package
 * self-reference does (CI builds before testing). Pointed at `src/index.ts`,
 * jiti cannot import the checkout natively behind the support shim and
 * transpiles the whole tree on every discovery: 3.4 s per static `run` for
 * the fixtures importing the helper, against 20 ms through `dist/`.
 */

const publicEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const parityRoot = path.resolve(".pi", "test-dynamic-parity", randomUUID());

const TOOLS_MODULE = "@vegardx/parity-tools";
const PROPOSER = { kind: "tool", via: "workflow_propose" } as const;
/** `decidedBy` is `human:${approver.via}` (approval.ts), so `via: "test"` yields `human:test`. */
const APPROVER = { kind: "human", via: "test" } as const;
const STATIC_FAILURE_REASON = "Static workflow source execution failed.";
const DYNAMIC_FAILURE_REASON =
	"Dynamic workflow source execution failed: Error: boom";
const PARK_REASON = "Workflow run awaits a checkpoint decision.";

type UpperContext = SupportTaskExecutionContext<{ value: string }>;
const UPPER_OPTIONS = {
	name: `${TOOLS_MODULE}/upper`,
	moduleSpecifier: TOOLS_MODULE,
	revision: 1,
	implementationSha256: "a".repeat(64),
} as const;
const upper = defineSupportTask({
	...UPPER_OPTIONS,
	parametersSchema: Type.Object({ value: Type.String() }),
	outputSchema: Type.Object({ answer: Type.String() }),
});
const upperExecute = ({ parameters }: UpperContext) => ({
	answer: parameters.value.toUpperCase(),
});

/*
 * Fixture sources. Each is one string used byte-for-byte on both sides; the
 * static side gets it as `workflows/<name>.workflow.ts`.
 */

const meta = (
	name: string,
	description: string,
	concurrency?: number,
): string =>
	JSON.stringify({
		name,
		description,
		version: 3,
		budget: { cost: 100, childRuntimeMs: 3_600_000 },
		timeoutMs: 3_600_000,
		...(concurrency === undefined ? {} : { concurrency }),
	});

/**
 * Fixture 1: the shim parity source (fanOut/pipeline/fanIn/results/settled/
 * result). Sequential like the spec's fake scheduler: at the default
 * concurrency the two fanned-out tasks execute concurrently and the journal
 * interleaving of their execution events is timing-dependent (it differed
 * between the two sides at the fanOut stage), which is scheduler
 * nondeterminism, not a definition-kind difference.
 */
const GRAPH_SOURCE = `import { defineWorkflow } from "@vegardx/pi-workflow";
import { Type } from "typebox";

const Answer = Type.Object({ answer: Type.String() });
type Goal = string;
enum Mode { Research = "research" }

function request(goal: Goal, cwd: string) {
	return {
		agent: "researcher",
		task: { goal, context: [], instructions: ["Return structured output."] },
		contextMode: "fresh" as const,
		tools: ["read"],
		preloadSkills: [],
		contextScopes: ["project" as const],
		workspace: { mode: "read-only" as const, cwd },
		outputSchema: Answer,
		limits: {
			cumulativeRuntimeMs: 300_000,
			attemptTimeoutMs: 300_000,
			totalTokens: 1_000_000,
			cost: 10,
			outputBytes: 1024,
			workspaceWriteBytes: 0,
			retries: 0,
			resumes: 0,
		},
	};
}

export default defineWorkflow({
	meta: ${meta("parity-graph", "Parity fixture: task graph", 1)},
	inputSchema: Type.Object({ topics: Type.Array(Type.String()) }),
	outputSchema: Type.Object({ answers: Type.Array(Type.String()) }),
	async run(ctx) {
		ctx.phase(Mode.Research);
		const first = ctx.agent("first", request("Answer " + ctx.input.topics[0], ctx.cwd));
		const fanned = ctx.fanOut("topics", ctx.input.topics, {
			key: (topic: string) => topic,
			task: (topic: string) => ({ ...request("Cover " + topic, ctx.cwd), inputs: { first: first.output } }),
		});
		const merged = ctx.fanIn("merge", fanned, {
			inputKey: (_source, index) => "topic-" + index,
			task: request("Merge", ctx.cwd),
		});
		const reviewed = ctx.pipeline("chain", (stage) => {
			const draft = stage.agent("draft", request("Draft", ctx.cwd));
			return stage.agent("review", { ...request("Review", ctx.cwd), inputs: { draft: draft.output } });
		});
		ctx.log("declared " + fanned.length + " topics");
		const [one, two] = await ctx.results([first, merged]);
		const settled = await ctx.settled([reviewed]);
		const last = await ctx.result(reviewed);
		return {
			answers: [one.answer, two.answer, last.answer, settled[0].status] satisfies string[],
		};
	},
});
`;

/**
 * Fixture 2: a registered support helper imported under its `exportName`.
 * Sequential like the spec's fake scheduler: at the default concurrency the
 * two support tasks execute concurrently and the journal interleaving of
 * their execution events is timing-dependent (it differed between the two
 * sides under full-suite load), which is scheduler nondeterminism, not a
 * definition-kind difference.
 */
const SUPPORT_SOURCE = `import { defineWorkflow } from "@vegardx/pi-workflow";
import { upper } from "@vegardx/parity-tools";
import { Type } from "typebox";

type Shouted = { answer: string };

export default defineWorkflow({
	meta: ${meta("parity-support", "Parity fixture: support helper", 1)},
	inputSchema: Type.Object({ value: Type.String() }),
	outputSchema: Type.Object({ shouted: Type.String(), twice: Type.String() }),
	async run(ctx) {
		ctx.phase("shout");
		const first = ctx.support("first", upper({ parameters: { value: ctx.input.value } }));
		const second = ctx.support("second", upper({
			parameters: { value: ctx.input.value + "!" },
			inputs: { prior: first.output },
		}));
		const [one, two]: Shouted[] = await ctx.results([first, second]);
		return { shouted: one.answer, twice: two.answer };
	},
});
`;

/** Fixture 3: parks at a block checkpoint, then works after the decision. */
const CHECKPOINT_SOURCE = `import { defineWorkflow } from "@vegardx/pi-workflow";
import { upper } from "@vegardx/parity-tools";
import { Type } from "typebox";

export default defineWorkflow({
	meta: ${meta("parity-checkpoint", "Parity fixture: checkpoint")},
	inputSchema: Type.Object({ value: Type.String() }),
	outputSchema: Type.Object({ answer: Type.String() }),
	async run(ctx) {
		ctx.phase("review");
		const approve = ctx.checkpoint("approve", {
			schema: Type.Object({ proceed: Type.Boolean() }),
			prompt: "Approve " + ctx.input.value + "?",
			headless: "block",
			timeoutMs: 300_000,
		});
		const decision = await ctx.result(approve);
		const after = ctx.support("after", upper({
			parameters: { value: decision.proceed ? "approved" : "declined" },
		}));
		return { answer: (await ctx.result(after)).answer };
	},
});
`;

/** Fixture 4: throws after one declaration (D9). */
const THROWING_SOURCE = `import { defineWorkflow } from "@vegardx/pi-workflow";
import { upper } from "@vegardx/parity-tools";
import { Type } from "typebox";

export default defineWorkflow({
	meta: ${meta("parity-throwing", "Parity fixture: throwing source")},
	inputSchema: Type.Object({ value: Type.String() }),
	outputSchema: Type.Object({ answer: Type.String() }),
	async run(ctx) {
		ctx.phase("boom");
		ctx.support("orphan", upper({ parameters: { value: ctx.input.value } }));
		throw new Error("boom");
	},
});
`;

/** Fixture 5: determinism aids observed before a checkpoint, replayed by the second drive. */
const DETERMINISM_SOURCE = `import { defineWorkflow } from "@vegardx/pi-workflow";
import { Type } from "typebox";

export default defineWorkflow({
	meta: ${meta("parity-determinism", "Parity fixture: determinism aids")},
	inputSchema: Type.Object({ value: Type.String() }),
	outputSchema: Type.Object({ proceed: Type.Boolean() }),
	async run(ctx) {
		const stamp = Date.now();
		const roll = Math.random();
		ctx.log("now=" + stamp + " roll=" + roll);
		const approve = ctx.checkpoint("approve", {
			schema: Type.Object({ proceed: Type.Boolean() }),
			prompt: "Approve " + ctx.input.value + "?",
			headless: "block",
			timeoutMs: 300_000,
		});
		const decision = await ctx.result(approve);
		return { proceed: decision.proceed };
	},
});
`;

/*
 * Fake subagent runtime: every agent task completes with `{ answer: <goal> }`.
 * Child ids derive from the goal so both sides see identical receipts and the
 * events need no normalisation for them.
 */

function childKey(request: SubagentRequest): string {
	return createHash("sha256")
		.update(request.task.goal)
		.digest("hex")
		.slice(0, 16);
}

function completedResult(runId: string, answer: string): RunResult {
	return {
		runId,
		status: "completed",
		structuredOutput: { answer },
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
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
	};
}

function agentProvider(): WorkflowSubagentProvider {
	const planned = new Map<string, RunReceipt>();
	const answers = new Map<string, string>();
	const unavailable = (method: string) => async () => {
		throw new Error(`unexpected subagent call: ${method}`);
	};
	const bind = async (
		workflowRunId: string,
	): Promise<WorkflowSubagentBinding> => {
		const ownerId = `pi-workflow:${workflowRunId}`;
		const client = {
			findByOperation: unavailable("findByOperation"),
			status: unavailable("status"),
			listRuns: unavailable("listRuns"),
			logs: unavailable("logs"),
			interrupt: unavailable("interrupt"),
			steer: unavailable("steer"),
			followUp: unavailable("followUp"),
			retry: unavailable("retry"),
			resume: unavailable("resume"),
			reconcile: unavailable("reconcile"),
			abandon: unavailable("abandon"),
			pin: unavailable("pin"),
			unpin: unavailable("unpin"),
			exportArtifact: unavailable("exportArtifact"),
			async preflight(request: SubagentRequest) {
				const key = childKey(request);
				const receipt: RunReceipt = {
					runId: `run_${key}`,
					attemptId: `attempt_${key}`,
					status: "active",
				};
				const preflightId = `preflight-${key}`;
				planned.set(preflightId, receipt);
				answers.set(receipt.runId, request.task.goal);
				const draft = {
					schema: "pi-subagent-launch" as const,
					contractRevision: SUBAGENT_RUNTIME_CONTRACT.contractRevision,
					operationId: request.operationId,
					ownerId,
					runId: receipt.runId,
					attemptId: receipt.attemptId,
					agent: request.agent,
					agentDisplayName: "Researcher",
					agentPrompt: "Research",
					agentSource: "/agent.md",
					agentSha256: "a".repeat(64),
					agentScope: "global" as const,
					task: structuredClone(request.task),
					contextMode: request.contextMode,
					model: { provider: "test", id: "model", thinking: "low" as const },
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
						baselineSha256: "a".repeat(64),
					},
					sandbox: {
						backend: "gondolin" as const,
						packageVersion: "0.12.0",
						imageSha256: "a".repeat(64),
						mountPolicySha256: "a".repeat(64),
						networkPolicySha256: "a".repeat(64),
						capacityPolicySha256: "a".repeat(64),
						memoryBytes: 536870912,
						guestDiskBytes: 1024,
						workspaceWriteBytes: 0,
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
					identitySha256: canonicalSha256(draft),
					expiresAt: "2099-01-01T00:00:00.000Z",
					launchPlan: { ...draft, identitySha256: canonicalSha256(draft) },
				};
			},
			async launch(preflightId: string) {
				const receipt = planned.get(preflightId);
				if (!receipt) throw new Error(`unknown preflight ${preflightId}`);
				return receipt;
			},
			async wait(runId: string) {
				const answer = answers.get(runId);
				if (answer === undefined) throw new Error(`unknown child ${runId}`);
				const result = completedResult(runId, answer);
				return {
					result,
					output: answer,
					sessionFile: undefined,
					handoff: undefined,
					structuredOutput: result.structuredOutput,
					error: undefined,
				};
			},
			async release(runId: string) {
				const receipt = [...planned.values()].find(
					(candidate) => candidate.runId === runId,
				);
				if (!receipt) throw new Error(`unknown child ${runId}`);
				return { ...receipt, status: "completed" as const };
			},
		} as unknown as SubagentClient;
		return { workflowRunId, ownerId, client };
	};
	return { bind };
}

/*
 * Normalisation. Run-specific fields per spec 11.1 and D5: run ids and every
 * id digested from one (task, execution, artifact, operation), timestamps,
 * and identity digests (definition, task, launch plan). Each category is
 * renamed by first appearance per side so equal values stay equal and
 * distinct values stay distinct; anything else is compared literally.
 */

const RUN_DERIVED_ID =
	/^(workflow-op|workflow|task|execution|artifact)_[a-f0-9]{32,64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const IDENTITY_KEYS = new Set([
	"definitionIdentitySha256",
	"identitySha256",
	"taskIdentitySha256",
	"planIdentitySha256",
]);
/**
 * Lists the materializer and inspection sort by task id (`orderedAfter`,
 * "Sorted `after` dependency ids"): their order follows the id digests, which
 * follow the run id, so it is canonicalised after aliasing.
 */
const ID_SORTED_KEYS = new Set(["after", "dependsOn"]);

function createNormalizer(): (value: unknown) => unknown {
	const aliases = new Map<string, string>();
	const counters = new Map<string, number>();
	const alias = (category: string, value: string): string => {
		const key = `${category} ${value}`;
		const existing = aliases.get(key);
		if (existing !== undefined) return existing;
		const ordinal = (counters.get(category) ?? 0) + 1;
		counters.set(category, ordinal);
		const created = `<${category}#${ordinal}>`;
		aliases.set(key, created);
		return created;
	};
	const walk = (value: unknown, key?: string): unknown => {
		if (Array.isArray(value)) {
			const entries = value.map((entry) => walk(entry));
			if (key !== undefined && ID_SORTED_KEYS.has(key)) {
				return entries
					.map((entry) => [JSON.stringify(entry), entry] as const)
					.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
					.map(([, entry]) => entry);
			}
			return entries;
		}
		if (value !== null && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(
					([entryKey, entry]) => [entryKey, walk(entry, entryKey)],
				),
			);
		}
		if (typeof value === "string") {
			if (key !== undefined && IDENTITY_KEYS.has(key)) {
				return alias("identity", value);
			}
			const id = RUN_DERIVED_ID.exec(value);
			if (id?.[1]) return alias(id[1], value);
			if (TIMESTAMP.test(value)) return "<timestamp>";
		}
		return value;
	};
	return walk;
}

type EventPayload = { readonly type: string; readonly data: unknown };

async function journalPayloads(
	storeRoot: string,
	runId: string,
): Promise<EventPayload[]> {
	const journal = await readFile(
		path.join(storeRoot, "runs", runId, "events.jsonl"),
		"utf8",
	);
	return journal
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as WorkflowJournalEvent)
		.map(({ type, data }) => ({ type, data }));
}

/** Fails fast with a named label instead of hanging the whole suite. */
function bounded<T>(
	promise: Promise<T>,
	label: string,
	ms = 45_000,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`${label} did not settle within ${ms}ms`)),
			ms,
		);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

/** A value an earlier parity step produced; a named failure when it did not. */
function ready<T>(value: T | undefined, label: string): T {
	if (value === undefined) {
		throw new Error(`${label} is unavailable: an earlier parity step failed`);
	}
	return value;
}

function checkpointTaskId(view: WorkflowServiceRunView): string {
	const task = (view.tasks ?? []).find((entry) => entry.kind === "checkpoint");
	if (!task) throw new Error("missing checkpoint task view");
	return task.id;
}

/*
 * One project and service per fixture: the fixture installed statically, the
 * package and support shims resolvable from `workflows/`, the helper
 * registered under `exportName: "upper"`.
 */

async function installPackageShims(cwd: string): Promise<void> {
	const packageShim = path.join(cwd, "node_modules", "@vegardx", "pi-workflow");
	await mkdir(packageShim, { recursive: true });
	await writeFile(
		path.join(packageShim, "package.json"),
		'{"name":"@vegardx/pi-workflow","type":"module","main":"./index.js"}\n',
	);
	await writeFile(
		path.join(packageShim, "index.js"),
		`export * from ${JSON.stringify(publicEntry)};\n`,
	);
	// The fake support package publishes the helper under its export name;
	// identity is by fields, so a second `defineSupportTask` with the same
	// options is the same helper the service registers.
	const toolsShim = path.join(cwd, "node_modules", "@vegardx", "parity-tools");
	await mkdir(toolsShim, { recursive: true });
	await writeFile(
		path.join(toolsShim, "package.json"),
		`{"name":${JSON.stringify(TOOLS_MODULE)},"type":"module","main":"./index.js"}\n`,
	);
	await writeFile(
		path.join(toolsShim, "index.js"),
		`import { defineSupportTask } from ${JSON.stringify(publicEntry)};
export const upper = defineSupportTask({
	...${JSON.stringify(UPPER_OPTIONS)},
	parametersSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
	outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
});
`,
	);
}

interface Project {
	readonly service: WorkflowService;
	readonly storeRoot: string;
	readonly registry: DiscoveredWorkflow;
}

const projects: Project[] = [];

async function openProject(name: string, source: string): Promise<Project> {
	const cwd = path.join(parityRoot, name, "project");
	const agentDir = path.join(parityRoot, name, "agent");
	const storeRoot = path.join(cwd, ".pi", "workflow");
	await mkdir(path.join(cwd, "workflows"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await installPackageShims(cwd);
	await writeFile(path.join(cwd, "workflows", `${name}.workflow.ts`), source);
	const discovered = await discoverWorkflows({
		cwd,
		agentDir,
		projectTrusted: true,
		allowedSupportImports: [TOOLS_MODULE],
	});
	const registry = discovered.find(
		(workflow) => workflow.definition.meta.name === name,
	);
	if (!registry) throw new Error(`registry did not load ${name}`);
	const service = await createWorkflowService({
		cwd,
		agentDir,
		storeRoot,
		projectTrusted: () => true,
		subagents: agentProvider(),
		supportTasks: [upper.registration(upperExecute, { exportName: "upper" })],
		// A cold tsx worker can miss the production 5 s manifest watchdog under
		// full-suite load; the timeout is not part of hostApiSha256.
		dynamic: { bootTimeoutMs: 60_000 },
	});
	const project = { service, storeRoot, registry };
	projects.push(project);
	return project;
}

afterAll(async () => {
	await Promise.all(projects.map((project) => project.service.shutdown()));
	await rm(parityRoot, { recursive: true, force: true });
});

async function proposeApproved(
	project: Project,
	source: string,
): Promise<DynamicWorkflowProposalView> {
	// The first cold tsx worker of a run is the slowest step under load; the
	// bound stays under the 60 s test cap so the failure is named.
	const proposed = await bounded(
		project.service.propose(source, { proposer: PROPOSER }),
		"propose",
		55_000,
	);
	return project.service.decideSource(proposed.ref, {
		decision: "approved",
		approver: APPROVER,
	});
}

interface Driven {
	readonly runId: string;
	/** Checkpoint decisions the drive loop recorded. */
	readonly decisions: number;
	readonly final: WorkflowServiceRunView;
	readonly events: EventPayload[];
	readonly inspection: WorkflowRunInspection;
}

/**
 * Runs `ref` to a terminal state, deciding `{ proceed: true }` at every park.
 * Both sides go through the same path, so the decision itself is parity too.
 */
async function drive(
	project: Project,
	ref: string,
	input: unknown,
): Promise<Driven> {
	const { service, storeRoot } = project;
	const { runId } = await service.run(ref, input);
	// A hung or refused wait reports the journal so far instead of a bare timeout.
	const waitOrExplain = async (label: string) => {
		try {
			return await bounded(service.wait(runId), label);
		} catch (error) {
			const events = await journalPayloads(storeRoot, runId).catch(() => []);
			throw new Error(
				`${label} failed: ${String(error)}\n${JSON.stringify(events, null, 1)}`,
				{ cause: error },
			);
		}
	};
	let view = await waitOrExplain(`wait ${ref}`);
	let decisions = 0;
	while (view.parked) {
		decisions += 1;
		await service.decide(runId, checkpointTaskId(view), {
			decision: { proceed: true },
			approver: "vegard",
		});
		view = await waitOrExplain(`wait ${ref} after decision`);
	}
	return {
		runId,
		decisions,
		final: view,
		events: await journalPayloads(storeRoot, runId),
		inspection: await service.inspect(runId, {
			include: ["tasks", "executions", "effects", "barriers", "artifacts"],
		}),
	};
}

/** Everything the brief compares, normalised per side. */
function comparable(driven: Driven) {
	const normalize = createNormalizer();
	const { run: _run, ...sections } = driven.inspection;
	return {
		events: normalize(driven.events),
		inspection: normalize(sections),
	};
}

function artifactDigests(driven: Driven): string[] {
	return (driven.inspection.artifacts ?? []).map((artifact) => artifact.sha256);
}

const isLog = (event: EventPayload): boolean =>
	event.type === "workflow-effect" &&
	(event.data as { kind: string }).kind === "log";

/** The single `now=<ms> roll=<random>` log effect a determinism drive recorded. */
function observedAids(driven: Driven): { now: number; roll: string } {
	const logs = driven.events.filter(isLog);
	expect(logs).toHaveLength(1);
	const [log] = logs;
	if (!log) throw new Error("log effect not found");
	const match = /^now=(\d+) roll=(\d+(?:\.\d+)?(?:e-\d+)?)$/.exec(
		(log.data as { value: string }).value,
	);
	if (!match?.[1] || !match[2]) throw new Error("log effect not parsed");
	return { now: Number(match[1]), roll: match[2] };
}

function maskObservation(events: readonly EventPayload[]): EventPayload[] {
	return events.map((event) =>
		isLog(event)
			? {
					type: event.type,
					data: { ...(event.data as object), value: "<observed>" },
				}
			: event,
	);
}

function statusChanges(driven: Driven) {
	return driven.events
		.filter((event) => event.type === "run-status-changed")
		.map(
			(event) => event.data as { from: string; to: string; reason?: string },
		);
}

function assertParity(staticSide: Driven, dynamicSide: Driven): void {
	expect(dynamicSide.final.output).toEqual(staticSide.final.output);
	expect(dynamicSide.final.status).toBe(staticSide.final.status);
	expect(artifactDigests(dynamicSide)).toEqual(artifactDigests(staticSide));
	expect(dynamicSide.events.map((event) => event.type)).toEqual(
		staticSide.events.map((event) => event.type),
	);
	expect(comparable(dynamicSide)).toEqual(comparable(staticSide));
}

interface Fixture {
	readonly name: string;
	readonly source: string;
	readonly input: unknown;
	readonly expectStatic: (driven: Driven) => void;
	readonly compare: (
		staticSide: Driven,
		dynamicSide: Driven,
		view: DynamicWorkflowProposalView,
		project: Project,
	) => Promise<void> | void;
}

const FIXTURES: readonly Fixture[] = [
	{
		name: "parity-graph",
		source: GRAPH_SOURCE,
		input: { topics: ["alpha", "beta"] },
		expectStatic(driven) {
			expect(driven.final).toMatchObject({
				status: "completed",
				output: { answers: ["Answer alpha", "Merge", "Review", "fulfilled"] },
			});
			expect(
				driven.events.filter((event) => event.type === "task-declared"),
			).toHaveLength(6);
		},
		compare: assertParity,
	},
	{
		name: "parity-support",
		source: SUPPORT_SOURCE,
		input: { value: "hello" },
		expectStatic(driven) {
			expect(driven.final).toMatchObject({
				status: "completed",
				output: { shouted: "HELLO", twice: "HELLO!" },
			});
			expect(
				driven.events.filter(
					(event) => event.type === "task-execution-support-output-committed",
				),
			).toHaveLength(2);
		},
		async compare(staticSide, dynamicSide, view, project) {
			// The run copy records the human decision exactly as approval.ts writes it.
			const approval = JSON.parse(
				await readFile(
					path.join(
						project.storeRoot,
						"runs",
						dynamicSide.runId,
						DYNAMIC_RUN_DEFINITION_DIRECTORY,
						DYNAMIC_APPROVAL_FILE,
					),
					"utf8",
				),
			) as WorkflowDecisionRecord;
			expect(approval).toMatchObject({
				source: "operator",
				decidedBy: "human:test",
				binding: { kind: "source-approval", sourceSha256: view.sourceSha256 },
				value: { decision: "approved", approver: APPROVER },
			});
			assertParity(staticSide, dynamicSide);
		},
	},
	{
		name: "parity-checkpoint",
		source: CHECKPOINT_SOURCE,
		input: { value: "plan" },
		expectStatic(driven) {
			expect(driven.final).toMatchObject({
				status: "completed",
				output: { answer: "APPROVED" },
			});
			// One decision: the first drive parks, the decision restarts the
			// drive (for the dynamic side, a fresh worker). Idle lanes append no
			// status changes, so the run parks once and resumes once for the
			// decision (plus the idle-lane wait beside the support task); that
			// sequence is compared verbatim between the sides below.
			expect(driven.decisions).toBe(1);
			const changes = statusChanges(driven);
			expect(
				changes.filter((change) => change.reason === PARK_REASON).length,
			).toBeGreaterThanOrEqual(1);
			expect(
				changes.filter((change) => change.to === "running").length,
			).toBeGreaterThanOrEqual(2);
		},
		compare(staticSide, dynamicSide) {
			expect(dynamicSide.decisions).toBe(1);
			expect(statusChanges(dynamicSide)).toEqual(statusChanges(staticSide));
			expect(
				dynamicSide.events.filter(
					(event) => event.type === "task-execution-checkpoint-decided",
				),
			).toHaveLength(1);
			assertParity(staticSide, dynamicSide);
		},
	},
	{
		name: "parity-throwing",
		source: THROWING_SOURCE,
		input: { value: "boom" },
		expectStatic(driven) {
			expect(driven.final.status).toBe("failed");
			expect(statusChanges(driven).at(-1)).toMatchObject({
				to: "failed",
				reason: STATIC_FAILURE_REASON,
			});
		},
		compare(staticSide, dynamicSide) {
			expect(dynamicSide.final.status).toBe("failed");
			const last = (driven: Driven) => {
				const event = driven.events.at(-1);
				if (!event) throw new Error("empty journal");
				return event as {
					type: string;
					data: { from: string; to: string; reason?: string };
				};
			};
			// D9: the one documented parity exception, both reasons exact.
			expect(last(staticSide)).toMatchObject({
				type: "run-status-changed",
				data: { to: "failed", reason: STATIC_FAILURE_REASON },
			});
			expect(last(dynamicSide)).toMatchObject({
				type: "run-status-changed",
				data: { to: "failed", reason: DYNAMIC_FAILURE_REASON },
			});
			expect(last(dynamicSide).data.from).toBe(last(staticSide).data.from);
			// Everything before the final reason is parity; the inspection views
			// never carry the reason, so they are compared whole.
			const withoutReason = (driven: Driven): Driven => ({
				...driven,
				events: driven.events.slice(0, -1),
			});
			expect(artifactDigests(dynamicSide)).toEqual(artifactDigests(staticSide));
			expect(comparable(withoutReason(dynamicSide))).toEqual(
				comparable(withoutReason(staticSide)),
			);
		},
	},
	{
		name: "parity-determinism",
		source: DETERMINISM_SOURCE,
		input: { value: "dice" },
		expectStatic(driven) {
			// Spec 7.4 rationale, observed on the static side: the host clock and
			// Math.random change between the parking drive and the re-drive
			// after the decision, so the replayed log effect no longer matches
			// ("Workflow phase or log effect changed during replay." thrown into
			// the source) and the run fails with the fixed static reason.
			expect(driven.final.status).toBe("failed");
			const changes = statusChanges(driven);
			expect(driven.decisions, JSON.stringify(changes)).toBe(1);
			expect(
				changes.filter((change) => change.reason === PARK_REASON).length,
			).toBeGreaterThanOrEqual(1);
			expect(changes.at(-1)).toMatchObject({
				from: "waiting",
				to: "failed",
				reason: STATIC_FAILURE_REASON,
			});
			expect(driven.events.filter(isLog)).toHaveLength(1);
		},
		compare(staticSide, dynamicSide, view) {
			// The VM's fixed clock and seeded Math.random make the second drive
			// replay the effect exactly, so the dynamic run completes.
			expect(dynamicSide.final).toMatchObject({
				status: "completed",
				output: { proceed: true },
			});
			expect(
				statusChanges(dynamicSide).map((change) => change.to),
			).not.toContain("failed");
			const dynamicValues = observedAids(dynamicSide);
			const staticValues = observedAids(staticSide);
			// Spec 7.4: the VM clock is the run's createdAt and the seed is
			// deriveDynamicVmSeed(runId); the same prelude reproduces the roll.
			const createdAtMs = Date.parse(dynamicSide.final.createdAt);
			expect(dynamicValues.now).toBe(createdAtMs);
			const context = createDynamicVmContext({
				filename: `dynamic:${view.sourceSha256}.workflow.ts`,
				epochMs: createdAtMs,
				seed: deriveDynamicVmSeed(dynamicSide.runId),
			});
			expect(String(vm.runInContext("Math.random()", context))).toBe(
				dynamicValues.roll,
			);
			// The static side observed the host clock and Math.random.
			expect(staticValues.now).toBeGreaterThanOrEqual(
				Date.parse(staticSide.final.createdAt),
			);
			expect(staticValues.now).toBeLessThanOrEqual(Date.now());
			expect(dynamicValues.roll).not.toBe(staticValues.roll);
			// Parity holds for everything the static run journaled before its
			// replay failure: that prefix, with the observed values masked, is
			// the prefix of the dynamic journal, which then runs to completion.
			const staticPrefix = maskObservation(staticSide.events).slice(0, -1);
			const dynamicEvents = maskObservation(dynamicSide.events);
			expect(dynamicEvents.length).toBeGreaterThan(staticPrefix.length);
			expect(
				createNormalizer()(dynamicEvents.slice(0, staticPrefix.length)),
			).toEqual(createNormalizer()(staticPrefix));
			expect(dynamicEvents.at(-1)).toMatchObject({
				type: "run-status-changed",
				data: { to: "completed" },
			});
			const staticDigests = artifactDigests(staticSide);
			expect(
				artifactDigests(dynamicSide).slice(0, staticDigests.length),
			).toEqual(staticDigests);
		},
	},
];

describe.each(FIXTURES)("dynamic parity: $name", (fixture) => {
	let project: Project | undefined;
	let view: DynamicWorkflowProposalView | undefined;
	let staticSide: Driven | undefined;

	it("proposes and approves the source with the registry's manifest and a distinct identity", async () => {
		project = await openProject(fixture.name, fixture.source);
		view = await proposeApproved(project, fixture.source);
		const { registry } = project;
		expect(view).toMatchObject({
			runnable: true,
			decision: { decision: "approved", approver: APPROVER },
		});
		// Spec 11.1 step 3: the manifest is exactly the loader's normalisation.
		expect(view.manifest).toEqual({
			meta: registry.definition.meta,
			inputSchema: registry.definition.inputSchema,
			outputSchema: registry.definition.outputSchema,
		});
		expect(view.sourceSha256).toBe(registry.identity.sourceSha256);
		// D5: path-bearing registry identity versus path-free dynamic identity.
		expect(view.definitionIdentitySha256).not.toBe(
			registry.identity.identitySha256,
		);
	});

	it("drives the static project workflow to the reference outcome", async () => {
		const active = ready(project, "project");
		staticSide = await drive(active, fixture.name, fixture.input);
		fixture.expectStatic(staticSide);
		expect(staticSide.events[0]).toEqual({
			type: "run-created",
			data: expect.objectContaining({
				definitionIdentitySha256: active.registry.identity.identitySha256,
			}),
		});
	});

	it("drives the approved dynamic source to the same journal, output, artifacts, and inspection", async () => {
		const active = ready(project, "project");
		const approved = ready(view, "approved proposal");
		const reference = ready(staticSide, "static drive");
		const dynamicSide = await drive(active, approved.ref, fixture.input);
		expect(dynamicSide.events[0]).toEqual({
			type: "run-created",
			data: expect.objectContaining({
				definitionIdentitySha256: approved.definitionIdentitySha256,
			}),
		});
		expect(dynamicSide.final.dynamic).toMatchObject({
			ref: approved.ref,
			sourceSha256: approved.sourceSha256,
		});
		await fixture.compare(reference, dynamicSide, approved, active);
	});
});
