import {
	defineWorkflow,
	type TaskInputHandle,
	type WorkflowHandoffDescriptor,
	WorkflowHandoffDescriptorSchema,
	type WorktreeTaskHandle,
} from "@vegardx/pi-workflow";
import { type Static, Type } from "typebox";

/**
 * The builtin `plan -> approve -> implement -> ship` pipeline.
 *
 * This file is the package-provided (`builtin` scope) definition registered by
 * the shipped extension; it needs no Pi project trust and is discovered from
 * the installed package, not from the user's project. The schemas are the ones
 * the plan-to-ship spec fixes ("Schemas"): a pi-maestro plan by value, its
 * sha256 digest, and the effort dial in; a receipt of what was approved,
 * implemented, reviewed, and handed off out.
 *
 * The stage graph (spec sections 2 and 5, milestone 1):
 *
 *   (a) refine        one read-only planner agent turns the authored plan into
 *                     an executable one (goal, files, acceptance, risks).
 *   (b) approve-plan  a human checkpoint (`headless: "block"`). THE approval
 *                     record. `{ proceed: false }` returns `approved: false`
 *                     and touches no tree.
 *   (c) implement-<id> one worktree agent per deliverable, `handoff:
 *                     "required"`, gated on (b).
 *   (d) verification is inside (c): the implementer attempts the repository's
 *                     install and check command in its own worktree and reports
 *                     `checkRan`/`checkPassed`/`checkTail` honestly. Experiment
 *                     W1 settled this: the guest is 512 MiB and one CPU today,
 *                     so the check is evidence, not a gate; the human verifying
 *                     the exported patch at (g) is the gate.
 *   (e) review/lens-N read-only reviewers over the plan's review tasks, each
 *                     fed the implementer's summary and its handoff DESCRIPTOR.
 *   (f) no automated fix round in milestone 1 (the spec makes it optional):
 *                     blocking findings are carried to (g) for the human.
 *   (g) ship          the second human checkpoint, shown the summaries, the
 *                     check results, and the review verdicts.
 *   (h) receipt       a required finalizer that records what shipped. The run's
 *                     own output carries the receipt; a finalizer may only
 *                     record it, never change it.
 *
 * What "ship" means here: a cherry-pickable handoff, not a publication. The
 * runtime imports each implementer's handoff as a workflow-owned
 * `git-format-patch` artifact, and the durable ref
 * `refs/pi-subagent/handoffs/<subagentRunId>/<subagentAttemptId>` survives the
 * child's release. The workflow never applies, pushes, merges, or opens a pull
 * request; a person runs `git cherry-pick` afterwards.
 *
 * Known milestone-1 limitations, stated rather than hidden:
 *
 * - Deliverables never build on each other. Every worktree branches from the
 *   same baseline and a handoff is never applied, so N deliverables produce N
 *   independent patches. `after` is honoured as ORDER only, and `reads` is not
 *   mapped to inputs at all.
 * - A reviewer that fails does not fail the run by itself (reviewers are
 *   `disposition: "optional"`), but the runtime blocks every task that depends
 *   on a failed one, so a dead reviewer does block the ship gate. That is why
 *   reviewers are cheap, retried once, and read with `ctx.settled`.
 * - Nested per-repository runs are deferred: a checkpoint cannot be decided
 *   inside a nested child run, so both gates live in this root run and only
 *   `ctx.cwd` is worked in.
 *
 * Three agent definitions must be installed for a run to leave preflight:
 * `planner`, `implementer`, and `reviewer`. The package ships them as
 * templates under `workflows/agents/`; see the README.
 */

const IDENTIFIER = "^[a-z0-9][a-z0-9-]{0,63}$";

/**
 * The stand-in for pi-maestro's roster/allowance routing
 * (`packages/contracts/src/catalog.ts`). Today a task names one exact
 * `{provider, id, thinking}`, so "a heavy reviewer from another family" has to
 * be written as a second literal model. DELETE THIS when routing lands: the
 * effort table below becomes a tier request and `diverse` becomes the
 * `other-family` selector.
 */
const MODEL_PROVIDER = "github-copilot";
const MODEL_ID = "gpt-5.6-sol";
/** The "different family" stand-in a `by.diverse` review task resolves to. */
const DIVERSE_MODEL_ID = "gpt-5.6-luna";

/** The three agents this definition names; all three must be installed. */
const PLANNER_AGENT = "planner";
const IMPLEMENTER_AGENT = "implementer";
const REVIEWER_AGENT = "reviewer";

/**
 * W1: a package-manager cache inside the worktree lands in the handoff patch
 * and breaches its 16 MiB bound, which fails the task after the work is done.
 * pi-subagent redirects the usual caches to `/tmp/cache` in the guest by
 * itself, so the instruction is a prohibition on undoing that, plus the
 * explicit export for any manager it does not know.
 */
const CACHE_INSTRUCTION =
	"Keep every package-manager cache OUT of the workspace tree. The guest already points the usual caches at /tmp/cache (`XDG_CACHE_HOME`, `npm_config_cache`, and friends): never point one back into the workspace, and export an explicit out-of-tree path (`npm_config_cache=/tmp/npm-cache`, `YARN_CACHE_FOLDER=/tmp/yarn-cache`, `PNPM_STORE_DIR=/tmp/pnpm-store`, or the equivalent) for any manager the guest does not already redirect. A cache written under the workspace becomes part of the handoff patch and breaches its 16 MiB bound, which fails this task after the work is finished.";

const MAX_DELIVERABLES = 16;
const MAX_REVIEWS = 32;
/** W1's floor for an implementer: a real `npm ci` plus build needs the room. */
const WORKSPACE_WRITE_BYTES = 2 * 1024 * 1024 * 1024;

type Thinking = "low" | "medium" | "high";

/**
 * A review task's delegation, mirroring pi-maestro's `WorkflowDelegation`
 * after F2: `model` is optional and `tier`/`diverse` express the intent a host
 * can route. Closed, so a plan that names a field this runtime cannot honour
 * is refused by `workflow_validate` instead of ignored at run time.
 */
const DelegationSchema = Type.Object(
	{
		lens: Type.String({ minLength: 1, maxLength: 128 }),
		skill: Type.Optional(Type.String({ pattern: IDENTIFIER })),
		model: Type.Optional(Type.String({ pattern: "^\\S+/\\S+$" })),
		tier: Type.Optional(
			Type.Union([
				Type.Literal("light"),
				Type.Literal("standard"),
				Type.Literal("heavy"),
			]),
		),
		diverse: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

const PlanTaskSchema = Type.Object(
	{
		id: Type.String({ pattern: IDENTIFIER }),
		title: Type.String({ minLength: 1 }),
		body: Type.Optional(Type.String()),
		/** Present = this task is a review, not implementation work. */
		by: Type.Optional(DelegationSchema),
	},
	{ additionalProperties: false },
);

const DeliverableSchema = Type.Object(
	{
		id: Type.String({ pattern: IDENTIFIER }),
		title: Type.String({ minLength: 1 }),
		body: Type.Optional(Type.String()),
		after: Type.Optional(Type.Array(Type.String({ pattern: IDENTIFIER }))),
		reads: Type.Optional(Type.Array(Type.String({ pattern: IDENTIFIER }))),
		repo: Type.Optional(Type.String({ pattern: IDENTIFIER })),
		tasks: Type.Optional(Type.Array(PlanTaskSchema)),
	},
	{ additionalProperties: false },
);

const PlanSchema = Type.Object(
	{
		slug: Type.String({ pattern: IDENTIFIER }),
		title: Type.String({ minLength: 1 }),
		deliverables: Type.Array(DeliverableSchema, {
			minItems: 1,
			maxItems: MAX_DELIVERABLES,
		}),
		repos: Type.Optional(
			Type.Array(
				Type.Object(
					{
						key: Type.String({ pattern: IDENTIFIER }),
						path: Type.String({ minLength: 1 }),
					},
					{ additionalProperties: false },
				),
			),
		),
	},
	{ additionalProperties: false },
);

const InputSchema = Type.Object(
	{
		plan: PlanSchema,
		planDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
		effort: Type.Union([
			Type.Literal("cheap"),
			Type.Literal("standard"),
			Type.Literal("deep"),
		]),
	},
	{ additionalProperties: false },
);

/** (a) The executable plan: the run's working contract, and what (b) shows. */
const RefinedPlanSchema = Type.Object(
	{
		summary: Type.String({ minLength: 1, maxLength: 4096 }),
		deliverables: Type.Array(
			Type.Object(
				{
					id: Type.String({ pattern: IDENTIFIER }),
					goal: Type.String({ minLength: 1, maxLength: 4096 }),
					files: Type.Array(Type.String({ maxLength: 512 }), { maxItems: 64 }),
					acceptance: Type.Array(Type.String({ maxLength: 1024 }), {
						maxItems: 32,
					}),
					risks: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 32 }),
				},
				{ additionalProperties: false },
			),
			{ maxItems: MAX_DELIVERABLES },
		),
		/** Why the plan cannot be executed as authored; the approver decides. */
		blockers: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 32 }),
	},
	{ additionalProperties: false },
);

/** (c) + (d) One deliverable's patch, and the truth about its check. */
const ImplementationSchema = Type.Object(
	{
		summary: Type.String({ minLength: 1, maxLength: 4096 }),
		files: Type.Array(Type.String({ maxLength: 512 }), { maxItems: 128 }),
		/** Exactly what was attempted, so `checkRan: false` is still readable. */
		checkCommand: Type.String({ maxLength: 512 }),
		checkRan: Type.Boolean(),
		checkPassed: Type.Boolean(),
		checkTail: Type.String({ maxLength: 4096 }),
	},
	{ additionalProperties: false },
);

/** (e) One lens's verdict over one deliverable's handoff. */
const ReviewSchema = Type.Object(
	{
		verdict: Type.Union([
			Type.Literal("approve"),
			Type.Literal("request-changes"),
		]),
		findings: Type.Array(
			Type.Object(
				{
					severity: Type.Union([
						Type.Literal("blocking"),
						Type.Literal("major"),
						Type.Literal("minor"),
					]),
					summary: Type.String({ minLength: 1, maxLength: 1024 }),
				},
				{ additionalProperties: false },
			),
			{ maxItems: 32 },
		),
	},
	{ additionalProperties: false },
);

const ApprovalSchema = Type.Object(
	{ proceed: Type.Boolean(), note: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);

const ShipSchema = Type.Object(
	{ ship: Type.Boolean(), note: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);

/** (h) What the required finalizer reports having recorded. */
const ReceiptRecordSchema = Type.Object(
	{
		recorded: Type.Boolean(),
		refs: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
			maxItems: MAX_DELIVERABLES,
		}),
	},
	{ additionalProperties: false },
);

const OutputSchema = Type.Object(
	{
		approved: Type.Boolean(),
		shipped: Type.Boolean(),
		deliverables: Type.Array(
			Type.Object(
				{
					id: Type.String({ pattern: IDENTIFIER }),
					handoff: Type.Optional(WorkflowHandoffDescriptorSchema),
					checkRan: Type.Boolean(),
					checkPassed: Type.Boolean(),
				},
				{ additionalProperties: false },
			),
		),
		reviews: Type.Array(
			Type.Object(
				{
					lens: Type.String({ minLength: 1 }),
					verdict: Type.String({ minLength: 1 }),
					blocking: Type.Boolean(),
				},
				{ additionalProperties: false },
			),
		),
		receipt: Type.Object(
			{
				/**
				 * The digest of the plan the human approved at (b). The receipt is
				 * checkable against the stored document precisely because of it, so
				 * it is a named field rather than prose inside `note`.
				 */
				planDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
				refs: Type.Array(Type.String({ minLength: 1 })),
				note: Type.Optional(Type.String()),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

type Plan = Static<typeof PlanSchema>;
type Deliverable = Static<typeof DeliverableSchema>;
type Delegation = Static<typeof DelegationSchema>;
type Implementation = Static<typeof ImplementationSchema>;
type Review = Static<typeof ReviewSchema>;
type Output = Static<typeof OutputSchema>;

interface StageBudget {
	readonly thinking: Thinking;
	readonly cumulativeRuntimeMs: number;
	readonly attemptTimeoutMs: number;
	readonly totalTokens: number;
	readonly cost: number;
	readonly outputBytes: number;
}

interface EffortRow {
	readonly refine: StageBudget;
	readonly implement: StageBudget;
	readonly review: StageBudget;
	readonly record: StageBudget;
	/** How many of the plan's review tasks run: the first one, or all of them. */
	readonly lenses: "first" | "all";
	/** Reviewers per review task; the second one is the other-family pass. */
	readonly copies: 1 | 2;
	/** How long a gate waits for a person before it expires. */
	readonly decisionTimeoutMs: number;
}

/**
 * THE EFFORT DIAL. A constant table keyed by `ctx.input.effort`: deterministic,
 * readable before any barrier, and replayable. The model ids are the stand-in
 * described above; the budgets are real.
 *
 * | effort   | refine | implement | review         | reviewers     |
 * | -------- | ------ | --------- | -------------- | ------------- |
 * | cheap    | low    | low       | low            | first lens    |
 * | standard | medium | medium    | medium         | plan's lenses |
 * | deep     | high   | high      | high + diverse | lenses x2     |
 *
 * Fix rounds are 0 at every effort in milestone 1: stage (f) is deferred, and
 * blocking findings go to the human at the ship gate instead.
 */
const EFFORT_TABLE = {
	cheap: {
		refine: {
			thinking: "low",
			cumulativeRuntimeMs: 600_000,
			attemptTimeoutMs: 600_000,
			totalTokens: 400_000,
			cost: 2,
			outputBytes: 262_144,
		},
		implement: {
			// W1 floors: >= 2 GiB of workspace writes, >= 1_500_000 ms per attempt,
			// >= 1_800_000 ms cumulative. The cheap column sits exactly on them.
			// FOLLOW-UP (pi-subagent revision 7): that release adds a per-agent
			// `memoryBytes` ceiling and a per-request `memoryBytes`. The authoring
			// request is frozen and carries no such field under revision 18, so the
			// column gains a memory entry (2 GiB standard, 4 GiB deep) only when
			// pi-workflow adopts revision 7.
			thinking: "low",
			cumulativeRuntimeMs: 1_800_000,
			attemptTimeoutMs: 1_500_000,
			totalTokens: 1_000_000,
			cost: 8,
			outputBytes: 65_536,
		},
		review: {
			thinking: "low",
			cumulativeRuntimeMs: 600_000,
			attemptTimeoutMs: 600_000,
			totalTokens: 400_000,
			cost: 2,
			outputBytes: 65_536,
		},
		record: {
			thinking: "low",
			cumulativeRuntimeMs: 300_000,
			attemptTimeoutMs: 300_000,
			totalTokens: 200_000,
			cost: 1,
			outputBytes: 65_536,
		},
		lenses: "first",
		copies: 1,
		decisionTimeoutMs: 14_400_000,
	},
	standard: {
		refine: {
			thinking: "medium",
			cumulativeRuntimeMs: 900_000,
			attemptTimeoutMs: 900_000,
			totalTokens: 1_000_000,
			cost: 4,
			outputBytes: 262_144,
		},
		implement: {
			thinking: "medium",
			cumulativeRuntimeMs: 2_400_000,
			attemptTimeoutMs: 1_800_000,
			totalTokens: 2_000_000,
			cost: 12,
			outputBytes: 65_536,
		},
		review: {
			thinking: "medium",
			cumulativeRuntimeMs: 900_000,
			attemptTimeoutMs: 900_000,
			totalTokens: 1_000_000,
			cost: 3,
			outputBytes: 65_536,
		},
		record: {
			thinking: "low",
			cumulativeRuntimeMs: 300_000,
			attemptTimeoutMs: 300_000,
			totalTokens: 200_000,
			cost: 1,
			outputBytes: 65_536,
		},
		lenses: "all",
		copies: 1,
		decisionTimeoutMs: 86_400_000,
	},
	deep: {
		refine: {
			thinking: "high",
			cumulativeRuntimeMs: 1_200_000,
			attemptTimeoutMs: 1_200_000,
			totalTokens: 2_000_000,
			cost: 6,
			outputBytes: 262_144,
		},
		implement: {
			thinking: "high",
			cumulativeRuntimeMs: 3_600_000,
			attemptTimeoutMs: 2_400_000,
			totalTokens: 4_000_000,
			cost: 20,
			outputBytes: 65_536,
		},
		review: {
			thinking: "high",
			cumulativeRuntimeMs: 1_200_000,
			attemptTimeoutMs: 1_200_000,
			totalTokens: 2_000_000,
			cost: 5,
			outputBytes: 65_536,
		},
		record: {
			thinking: "low",
			cumulativeRuntimeMs: 300_000,
			attemptTimeoutMs: 300_000,
			totalTokens: 200_000,
			cost: 1,
			outputBytes: 65_536,
		},
		lenses: "all",
		copies: 2,
		decisionTimeoutMs: 172_800_000,
	},
} as const satisfies Record<string, EffortRow>;

/** Read-only limits for a stage: a read-only task writes nothing, ever. */
function readOnlyLimits(stage: StageBudget) {
	return {
		cumulativeRuntimeMs: stage.cumulativeRuntimeMs,
		attemptTimeoutMs: stage.attemptTimeoutMs,
		totalTokens: stage.totalTokens,
		cost: stage.cost,
		outputBytes: stage.outputBytes,
		workspaceWriteBytes: 0,
		retries: 1,
		resumes: 1,
	};
}

/**
 * Worktree limits. `workspaceWriteBytes` is 2 GiB because W1 measured a real
 * `npm ci` plus build in the guest; anything smaller fails the install rather
 * than the task, which reads as a model failure and is not one.
 */
function worktreeLimits(stage: StageBudget) {
	return {
		...readOnlyLimits(stage),
		workspaceWriteBytes: WORKSPACE_WRITE_BYTES,
	};
}

function model(id: string, thinking: Thinking) {
	return { provider: MODEL_PROVIDER, id, thinking };
}

/** A tier is how much reviewer to spend; it outranks the effort column. */
function tierThinking(tier: Delegation["tier"], fallback: Thinking): Thinking {
	if (tier === "light") return "low";
	if (tier === "standard") return "medium";
	if (tier === "heavy") return "high";
	return fallback;
}

/** A review task's model: the plan's exact pin, else diversity, else the dial. */
function reviewerModel(
	by: Delegation,
	stage: StageBudget,
	diversePass: boolean,
): { provider: string; id: string; thinking: Thinking } {
	const thinking = tierThinking(by.tier, stage.thinking);
	if (by.model) {
		// pi-maestro validates `^\S+/\S+$`; the provider is everything before the
		// first slash, so a model id may itself contain one.
		const slash = by.model.indexOf("/");
		return {
			provider: by.model.slice(0, slash),
			id: by.model.slice(slash + 1),
			thinking,
		};
	}
	return model(
		by.diverse === true || diversePass ? DIVERSE_MODEL_ID : MODEL_ID,
		thinking,
	);
}

interface ReviewItem {
	readonly deliverableId: string;
	readonly taskId: string;
	readonly lens: string;
	readonly by: Delegation;
	/** True for the second copy of a lens at `deep`: the other-family pass. */
	readonly diversePass: boolean;
}

/** Every review task in the plan, expanded by the effort table's reviewer count. */
function reviewItems(plan: Plan, row: EffortRow): ReviewItem[] {
	const authored: ReviewItem[] = [];
	for (const deliverable of plan.deliverables) {
		for (const task of deliverable.tasks ?? []) {
			if (!task.by) continue;
			authored.push({
				deliverableId: deliverable.id,
				taskId: task.id,
				lens: task.by.lens,
				by: task.by,
				diversePass: false,
			});
		}
	}
	const selected = row.lenses === "first" ? authored.slice(0, 1) : authored;
	const expanded =
		row.copies === 2
			? selected.flatMap((item) => [item, { ...item, diversePass: true }])
			: selected;
	return expanded.slice(0, MAX_REVIEWS);
}

/** The durable ref a person cherry-picks; it survives the child's release. */
function handoffRef(descriptor: WorkflowHandoffDescriptor): string {
	return `refs/pi-subagent/handoffs/${descriptor.subagentRunId}/${descriptor.subagentAttemptId}`;
}

/** One deliverable as authored, for an agent's context entry (16 KiB bound). */
function planText(deliverable: Deliverable): string {
	const tasks = (deliverable.tasks ?? [])
		.filter((task) => !task.by)
		.map(
			(task) =>
				`- ${task.id}: ${task.title}${task.body ? ` — ${task.body}` : ""}`,
		);
	return [
		`Deliverable ${deliverable.id}: ${deliverable.title}`,
		deliverable.body ?? "",
		...(tasks.length > 0 ? ["Authored tasks:", ...tasks] : []),
	]
		.filter((line) => line.length > 0)
		.join("\n")
		.slice(0, 16_000);
}

export default defineWorkflow({
	meta: {
		name: "plan-to-ship",
		description:
			"Refine an authored plan, ask a human, implement each deliverable in a worktree, review the handoffs, and ask a human again before recording a receipt.",
		version: 1,
		// Sized for the deep column at the input schema's 16 deliverables: the
		// scheduler admits a task only when its declared maximum still fits.
		budget: { cost: 900, childRuntimeMs: 172_800_000 },
		// The run parks on two human gates, so it outlives any session. Seven
		// days covers a 48-hour wait at each gate with room for the work.
		timeoutMs: 604_800_000,
		concurrency: 4,
	},
	inputSchema: InputSchema,
	outputSchema: OutputSchema,
	async run(ctx): Promise<Output> {
		const plan: Plan = ctx.input.plan;
		const planDigest = ctx.input.planDigest;
		const row: EffortRow = EFFORT_TABLE[ctx.input.effort];
		const repoPath = plan.repos?.[0]?.path;

		ctx.phase("refine");
		const refine = ctx.agent("refine", {
			agent: PLANNER_AGENT,
			task: {
				goal: `Refine the authored plan "${plan.title}" (${plan.slug}) into an executable plan for this repository.`,
				context: plan.deliverables.map((deliverable) => planText(deliverable)),
				instructions: [
					"Read the repository before you answer. Every file you name must exist, or be one the deliverable creates.",
					"Return one entry per deliverable of the authored plan: its id unchanged, a goal a worker can act on, the files it touches, the acceptance checks a reviewer can verify, and the risks.",
					"Deliverables are implemented in separate worktrees from the same baseline and no patch is ever applied to another, so no deliverable may build on another one's code. Record any such dependency in `blockers` rather than planning around it.",
					"List in `blockers` anything that makes the plan unexecutable as authored: a missing file, a contradiction, work that needs a repository you cannot read, or a dependency of the kind above. A human reads this before approving.",
					"Change nothing. You have read-only tools and no workspace.",
				],
			},
			contextMode: "fresh",
			model: model(MODEL_ID, row.refine.thinking),
			tools: ["read", "grep", "find", "ls"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: ctx.cwd },
			outputSchema: RefinedPlanSchema,
			limits: readOnlyLimits(row.refine),
			retry: { attempts: 1, on: ["backoff"] },
		});

		ctx.phase("approve");
		const approve = ctx.checkpoint("approve-plan", {
			schema: ApprovalSchema,
			prompt: [
				`Approve "${plan.title}" (${plan.slug}) for implementation?`,
				`${plan.deliverables.length} deliverable(s), effort ${ctx.input.effort}, plan digest ${planDigest.slice(0, 12)}.`,
				"The `plan` input is the refined executable plan; read its blockers first.",
				"Approving starts one worktree agent per deliverable. Nothing has been written yet.",
				'Answer {"proceed":true} to implement, or {"proceed":false} to stop without touching any tree.',
			].join("\n"),
			headless: "block",
			timeoutMs: row.decisionTimeoutMs,
			inputs: { plan: refine.output },
		});

		const approval = await ctx.result(approve);
		if (!approval.proceed) {
			// Only the refiner and the gate were ever declared, so nothing ran in a
			// worktree and there is nothing to record.
			ctx.log("Plan approval declined; no worktree task was declared.");
			return {
				approved: false,
				shipped: false,
				deliverables: [],
				reviews: [],
				receipt: {
					planDigest,
					refs: [],
					...(approval.note ? { note: approval.note } : {}),
				},
			};
		}

		ctx.phase("implement");
		const implementers: {
			readonly deliverable: Deliverable;
			readonly handle: WorktreeTaskHandle<Implementation>;
		}[] = [];
		for (const deliverable of plan.deliverables) {
			// `after` is ORDER only: a predecessor's patch is never applied, so the
			// successor still starts from the same baseline. An edge must point
			// backwards in plan order, because a task may only depend on one that is
			// already declared. With no edges at all these run as a fan-out.
			const order = [approve.ref];
			for (const predecessorId of deliverable.after ?? []) {
				const predecessor = implementers.find(
					(entry) => entry.deliverable.id === predecessorId,
				);
				if (!predecessor) {
					throw new Error(
						`plan-to-ship: deliverable "${deliverable.id}" waits for "${predecessorId}", which is not declared before it; order the plan's deliverables so every \`after\` names an earlier one.`,
					);
				}
				order.push(predecessor.handle.ref);
			}
			const handle = ctx.agent(`implement-${deliverable.id}`, {
				agent: IMPLEMENTER_AGENT,
				task: {
					goal: `Implement deliverable "${deliverable.id}" of plan "${plan.slug}": ${deliverable.title}`,
					context: [planText(deliverable)],
					instructions: [
						`The \`plan\` input is the refined plan for the whole run. Only the entry whose id is "${deliverable.id}" is yours: implement that one and nothing else.`,
						"You are in your own git worktree. Edit the files in place and leave the changes in the working tree; the runtime captures them as a single handoff patch when your attempt ends. Do not commit, branch, push, merge, or open a pull request.",
						CACHE_INSTRUCTION,
						`Then attempt the repository's own install and check: \`npm ci\` (or the install this repository documents) followed by its check command — \`npm run check\` when the manifest has one, otherwise the command its README or AGENTS.md names.${repoPath ? ` The plan calls this repository ${repoPath}.` : ""}`,
						"The sandbox has 512 MiB of memory and one CPU today, so a heavy install, build, or test run may be killed. That is an expected outcome, not a failure of yours, and never something to work around by reporting a result you did not see.",
						"Report the check truthfully: `checkCommand` is what you actually attempted, `checkRan` is true only if that command ran to completion, `checkPassed` is true only if it exited zero, and `checkTail` is the last 20 lines of its output (empty when it did not run).",
						"A check that did not run, or that failed, is NEVER a reason to leave the tree unchanged or to skip the edit. The handoff is required: a worktree with no changes fails this task. Make the change, then report the check as it happened.",
						"Keep the diff minimal and reviewable, list every file you changed in `files`, and say in `summary` what a reviewer should look at first.",
					],
				},
				contextMode: "fresh",
				model: model(MODEL_ID, row.implement.thinking),
				tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
				preloadSkills: [],
				contextScopes: ["project"],
				workspace: { mode: "worktree", cwd: ctx.cwd },
				handoff: "required",
				outputSchema: ImplementationSchema,
				limits: worktreeLimits(row.implement),
				after: order,
				inputs: { plan: refine.output },
				retry: { attempts: 1, on: ["backoff"] },
			});
			implementers.push({ deliverable, handle });
		}

		ctx.phase("review");
		const items = reviewItems(plan, row);
		const reviewers =
			items.length === 0
				? []
				: ctx.fanOut("review", items, {
						key: (_item, index) => `lens-${index}`,
						task: (item) => {
							const implementer = implementers.find(
								(entry) => entry.deliverable.id === item.deliverableId,
							);
							if (!implementer) {
								throw new Error(
									`plan-to-ship: review task "${item.taskId}" names deliverable "${item.deliverableId}", which the plan does not declare.`,
								);
							}
							return {
								agent: REVIEWER_AGENT,
								task: {
									goal: `Review deliverable "${item.deliverableId}" through the "${item.lens}" lens.`,
									context: [planText(implementer.deliverable)],
									instructions: [
										`Apply exactly one point of view: ${item.lens}. Other reviewers cover the rest.`,
										"The `handoff` input is the patch's identity — baseline, commit, digest, size — not its bytes. Judge the change from the repository and the `summary` input; never claim to have read the patch.",
										"The summary reports whether the repository's check ran and passed. Treat a check that did not run as unverified, not as broken.",
										'Return `verdict: "request-changes"` only when you found something that must change before this patch is cherry-picked, and mark those findings `blocking`. A human reads the findings at the ship gate; there is no automatic fix round.',
										"Change nothing. You have read-only tools and no workspace.",
									],
								},
								contextMode: "fresh",
								model: reviewerModel(item.by, row.review, item.diversePass),
								tools: ["read", "grep", "find", "ls"],
								preloadSkills: item.by.skill ? [item.by.skill] : [],
								contextScopes: ["project"],
								workspace: { mode: "read-only", cwd: ctx.cwd },
								outputSchema: ReviewSchema,
								limits: readOnlyLimits(row.review),
								// One flaky reviewer must not kill an approved implementation.
								disposition: "optional",
								inputs: {
									summary: implementer.handle.output,
									handoff: implementer.handle.handoff,
									plan: refine.output,
								},
								retry: { attempts: 1, on: ["backoff"] },
							};
						},
					});

		const summaries = await ctx.results(
			implementers.map((entry) => entry.handle),
		);
		const descriptors: WorkflowHandoffDescriptor[] = [];
		for (const entry of implementers) {
			const descriptor = await ctx.handoff(entry.handle);
			if (!descriptor) {
				// `handoff: "required"` means the runtime already failed such a task;
				// this is a guard, not a path.
				throw new Error(
					`plan-to-ship: deliverable "${entry.deliverable.id}" completed without a handoff.`,
				);
			}
			descriptors.push(descriptor);
		}

		const settled = reviewers.length === 0 ? [] : await ctx.settled(reviewers);
		const verdicts = items.map((item, index) => {
			const outcome = settled[index];
			const value: Review | undefined =
				outcome?.status === "fulfilled" ? outcome.value : undefined;
			return {
				item,
				value,
				blocking:
					value?.findings.some((finding) => finding.severity === "blocking") ===
					true,
			};
		});
		const reported = verdicts.filter(
			(entry) => entry.value !== undefined,
		).length;
		const blocking = verdicts.filter((entry) => entry.blocking).length;
		const changes = verdicts.filter(
			(entry) => entry.value?.verdict === "request-changes",
		).length;
		const checked = summaries.filter((summary) => summary.checkRan).length;
		const passed = summaries.filter(
			(summary) => summary.checkRan && summary.checkPassed,
		).length;

		ctx.phase("ship");
		const shipInputs: Record<string, TaskInputHandle> = {};
		implementers.forEach((entry, index) => {
			shipInputs[`summary-${index}`] = entry.handle.output;
		});
		verdicts.forEach((entry, index) => {
			// Only a reviewer that reported may be an input: a data dependency on a
			// failed task would block this gate instead of informing it.
			const handle = reviewers[index];
			if (entry.value === undefined || !handle) return;
			shipInputs[`review-${index}`] = handle.output;
		});
		const ship = ctx.checkpoint("ship", {
			schema: ShipSchema,
			prompt: [
				`Ship "${plan.title}" (${plan.slug})?`,
				`${descriptors.length} handoff patch(es); the repository check ran for ${checked} of ${summaries.length} and passed for ${passed}.`,
				`Reviews: ${reported} of ${verdicts.length} reported, ${changes} asked for changes, ${blocking} blocking finding(s).`,
				"The `summary-*` and `review-*` inputs carry the full reports. Verify the exported patch yourself: the in-worktree check is evidence, not a gate.",
				'Answer {"ship":true} to record a receipt naming each handoff ref, or {"ship":false} to end the run without one. Nothing is pushed, merged, or published either way.',
			].join("\n"),
			headless: "block",
			timeoutMs: row.decisionTimeoutMs,
			inputs: shipInputs,
		});
		const decision = await ctx.result(ship);

		const refs = decision.ship ? descriptors.map(handoffRef) : [];
		const note = [
			decision.ship ? "shipped" : "not shipped",
			`plan ${planDigest}`,
			`checks ${passed}/${summaries.length} passed`,
			`${blocking} blocking finding(s)`,
			...(decision.note ? [decision.note] : []),
		].join("; ");
		const receipt = {
			planDigest,
			shipped: decision.ship,
			deliverables: implementers.map((entry, index) => ({
				id: entry.deliverable.id,
				ref: handoffRef(descriptors[index] as WorkflowHandoffDescriptor),
				sha256: descriptors[index]?.sha256,
				bytes: descriptors[index]?.bytes,
				checkRan: summaries[index]?.checkRan === true,
				checkPassed: summaries[index]?.checkPassed === true,
			})),
			refs,
			note,
		};

		ctx.phase("receipt");
		const receiptInputs: Record<string, TaskInputHandle> = {
			decision: ship.output,
		};
		implementers.forEach((entry, index) => {
			receiptInputs[`handoff-${index}`] = entry.handle.handoff;
		});
		// (h) The finalizer may only RECORD: the output is committed before it
		// runs, and nothing it does can change it.
		ctx.finalize("receipt", {
			kind: "required",
			agent: {
				agent: PLANNER_AGENT,
				task: {
					goal: `Record the plan-to-ship receipt for "${plan.slug}".`,
					context: [JSON.stringify(receipt).slice(0, 16_000)],
					instructions: [
						"The context holds the receipt exactly as the run committed it, and the `handoff-*` inputs are the same patches' identities. Record what you were given.",
						"Return `recorded: true` and the same refs, in the same order. Do not add, drop, or reword a ref.",
						"Nothing here is published, pushed, or merged: each ref names a handoff commit a person may cherry-pick.",
					],
				},
				contextMode: "fresh",
				model: model(MODEL_ID, row.record.thinking),
				tools: [],
				preloadSkills: [],
				contextScopes: [],
				workspace: { mode: "read-only", cwd: ctx.cwd },
				outputSchema: ReceiptRecordSchema,
				limits: readOnlyLimits(row.record),
				inputs: receiptInputs,
			},
		});

		return {
			approved: true,
			shipped: decision.ship,
			deliverables: implementers.map((entry, index) => ({
				id: entry.deliverable.id,
				...(descriptors[index] ? { handoff: descriptors[index] } : {}),
				checkRan: summaries[index]?.checkRan === true,
				checkPassed: summaries[index]?.checkPassed === true,
			})),
			reviews: verdicts
				.filter((entry) => entry.value !== undefined)
				.map((entry) => ({
					lens: entry.item.lens,
					verdict: entry.value?.verdict ?? "approve",
					blocking: entry.blocking,
				})),
			receipt: { planDigest, refs, note },
		};
	},
});
