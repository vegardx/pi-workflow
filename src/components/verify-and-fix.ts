import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type {
	TaskDisposition,
	TaskKey,
	WorkflowBudget,
} from "../contracts-core.js";
import { MAX_TASK_KEY_LENGTH, TaskKeySchema } from "../contracts-core.js";
import type {
	AgentTaskAuthoringRequest,
	TaskHandle,
	TaskInputHandle,
	WorkflowContext,
	WorkspaceAuthoringRequest,
	WorktreeTaskHandle,
} from "../definition.js";
import { isHandoffHandle, isTaskHandle } from "../definition.js";
import {
	assertBudgetAdmits,
	type BudgetShare,
	EFFORTS,
	type Effort,
	envelope,
	WORKSPACE_WRITE_BYTES,
} from "./envelope.js";
import { WorkflowComponentError } from "./errors.js";

/**
 * `verifyAndFix` — a bounded verify-then-fix loop over one implementer's
 * worktree handoff, unrolled at declaration into named tasks.
 *
 * Pattern: `skills/workflow-authoring/SKILL.md` § "A bounded loop with a
 * barrier per round". The rules it encodes live under "Barriers and replay",
 * "`after` versus `inputs`" and "Budgets and admission".
 *
 * Lowering, and nothing else:
 *
 * ```text
 * round 1   ctx.agent(`<key>-verify-1`, …)   the check, reported honestly
 *           await ctx.result(verify-1)        barrier
 *           ctx.agent(`<key>-fix-1`, …)       worktree, handoff "required"
 * round 2   ctx.agent(`<key>-verify-2`, …)
 *           await ctx.result(verify-2)        barrier
 * ```
 *
 * It **does not lower through a generic `loopUntil`** (spec §2.3, §7): that
 * component is deferred until the replay-cost measurement lands, and this one
 * is a fixed unrolled loop with a hard cap instead.
 *
 * ## Keys
 *
 * `<key>-verify-<n>` and `<key>-fix-<n>`, `n` from 1 — a pure function of the
 * caller's `key` and the round ordinal, and of nothing else (replay law 1).
 * The spec writes these as `<key>/verify-<n>`, i.e. the round tasks sitting in
 * a namespace named for the loop. `WorkflowContext` opens a namespace only
 * through `fanOut` and `pipeline`, and neither admits a barrier between its
 * members — a `pipeline` build function is synchronous and a `fanOut` declares
 * its items in one epoch — so the namespace would have to be faked with a
 * one-item fan-out per round, which is not what a hand-written loop looks
 * like. The keys are flattened into the same path with `-` instead, which is
 * how `workflows/plan-to-ship.workflow.ts` already names `implement-<id>` and
 * `summary-<id>`. Same purity, same determinism, one namespace level fewer.
 *
 * ## Rounds, and why the last round never fixes
 *
 * `maxRounds` bounds the **verify** rounds, so at most `maxRounds - 1` fix
 * rounds follow: the component never returns a fix nobody checked. The shapes
 * are therefore
 *
 * - `maxRounds: 0` — declares nothing at all. The implementer's own patch is
 *   the result and `rounds` is 0. That is "unverified", which is not the same
 *   as "failed", and the caller's gate has to say so.
 * - `maxRounds: 1` — `verify-1`. A failing check is evidence at the gate, not
 *   a fix round.
 * - `maxRounds: 2` — `verify-1`, `fix-1`, `verify-2`.
 * - `maxRounds: 3` — `verify-1`, `fix-1`, `verify-2`, `fix-2`, `verify-3`.
 *
 * The cap is 3 VERIFY rounds, which is 2 FIX rounds — the plan vocabulary's
 * own `maxFixRounds: 0 | 1 | 2` (spec §2.1), compiled as `maxRounds =
 * maxFixRounds + 1` by `workflows/plan-to-ship.workflow.ts` so that a fix is
 * never left unchecked. It is measured rather than assumed: `docs/research.md`
 * "Replay cost of a bounded loop", with `test/replay-cost.test.ts` behind it,
 * finds **3 the highest cap that is still comfortable** (a worst-case resume of
 * 6.5 s at 25 % of the projection bound, against agents that cost minutes) and
 * an unbounded `loopUntil` not affordable at all, which is why that component
 * stays deferred. Past 4 the resume cost doubles every two rounds while the
 * marginal value of another fix round falls, so raising the cap again is a
 * decision for the spec and for a new measurement, not for this module.
 *
 * ## The replay cost this cap is paying for
 *
 * Every round awaits a `result` barrier, and a barrier is where a run can be
 * interrupted and resumed. A resume **re-executes the definition's source from
 * the top** and re-declares every task of every epoch already crossed, matching
 * each one against the persisted path before the run may append anything new
 * (`src/materializer.ts`, "barrier does not match the persisted ordered
 * epoch"). So the replay work of a resume grows with the number of barriers the
 * source has crossed, while the delegated work does not: a 2-round loop that
 * resumes inside round 2 replays `verify-1` and `fix-1` before it does anything.
 * That is cheap at two rounds and is exactly the cost `loopUntil` cannot bound,
 * which is why the generic component is deferred and this one is unrolled.
 *
 * A second consequence of the same rule: everything this component declares
 * before a barrier must be deterministic, so the model, thinking level and
 * limits of every round come from `envelope` — a table keyed by `(effort,
 * stage)` and the round's position in the ladder — and never from the barrier
 * value it just read.
 *
 * ## Effort, and the one rung of escalation
 *
 * A verifier always runs at `envelope(effort, "verify")`: its job is to run a
 * command and report what happened, and thinking harder does not change the
 * exit code. A fixer is a **retry** of an implementer that already failed its
 * own check, so with `escalate: "thinking"` it runs one rung up the effort
 * ladder — `envelope(nextRung(effort), "fix")` — and with `escalate: "none"`
 * (the default) at `envelope(effort, "fix")`. There is no rung above `deep`, so
 * asking to escalate from `deep` is refused rather than silently ignored.
 *
 * ## `checkRan: false` is a human's problem, not a fix round
 *
 * The check runs inside the agent's own VM today, which has one CPU and a
 * bounded memory grant, so an install or a build can be killed before the check
 * command ever completes. The agent reports that honestly as `checkRan: false`
 * (`workflows/plan-to-ship.workflow.ts`'s implementer contract). That is
 * **unverified**, not **broken**: fixing code nobody proved was broken is how a
 * loop burns a budget on a machine problem. The component therefore stops on
 * `checkRan: false`, declares no fixer, logs why, and returns
 * `{passed: false, checkRan: false}` for the caller's gate to put in front of a
 * person — exactly as the spec requires ("`checkRan: false` escalates to a
 * human, never counts as green").
 *
 * ## What the component owns, and what the caller owns
 *
 * The caller owns every word of prose, the tools, the workspace and the agent
 * name; the component owns the keys, the output schema of a verifier, the model
 * and limits of both roles, the fixer's `handoff: "required"`, and the input
 * wiring that makes the rounds depend on each other. A request that declares
 * one of the component's own fields is refused rather than overwritten. One
 * field is a default rather than an owned one: a worktree verifier that names
 * no `handoff` policy gets `"optional"`, because a verifier is not a producer
 * and one that changed nothing must not fail on "handoff absent". A worktree
 * verifier also takes the `WORKSPACE_WRITE_BYTES` grant the `implement` and
 * `fix` rows carry, because the `verify` row of the table is a read-only row
 * and the runtime refuses a worktree with no write grant.
 *
 * The dependency between rounds is a **data** dependency, never a bare `after`:
 * `verify-<n>` names the current patch's handoff handle in its `inputs`, and
 * `fix-<n>` names that handoff plus the failing verifier's report. The runtime
 * never applies a handoff to a worktree (`docs/authority.md`), so what a task
 * receives is the descriptor — baseline, commit, digest, size, and the durable
 * `refs/pi-subagent/handoffs/<runId>/<attemptId>` ref — and the caller's prose
 * is what tells the fixer to apply it. The component does not pretend
 * otherwise.
 */

/**
 * The hard cap on verify rounds; spec §2.3 and §7 R6, widened to 3 by the
 * wave-2 decision of 2026-09-16. Three verify rounds are two fix rounds, which
 * is the plan vocabulary's own `maxFixRounds: 0 | 1 | 2`, and `docs/research.md`
 * measures 3 as the highest cap that is still comfortable.
 */
export const MAX_VERIFY_ROUNDS = 3;
/** Rounds declared when the caller names none. */
export const DEFAULT_VERIFY_ROUNDS = 1;
/** The longest check tail a report may carry, as `plan-to-ship` already bounds it. */
export const MAX_CHECK_TAIL_LENGTH = 4096;
/** The input name the current patch's handoff descriptor arrives under. */
export const DEFAULT_PATCH_INPUT = "patch" as TaskKey;
/** The input name the failing verifier's report arrives under, for a fixer. */
export const DEFAULT_REPORT_INPUT = "check" as TaskKey;

/**
 * What a verifier reports, verbatim from the implementer contract in
 * `workflows/plan-to-ship.workflow.ts`: exactly what was attempted, whether it
 * ran, whether it passed, and the tail of its output. The fields are separate
 * on purpose - "did not run" and "ran and failed" are different answers and
 * only one of them is a reason to fix anything.
 */
export const CheckReportSchema = Type.Object(
	{
		summary: Type.String({ minLength: 1, maxLength: 4096 }),
		/** Exactly what was attempted, so `checkRan: false` is still readable. */
		checkCommand: Type.String({ minLength: 1, maxLength: 512 }),
		checkRan: Type.Boolean(),
		checkPassed: Type.Boolean(),
		checkTail: Type.String({ maxLength: MAX_CHECK_TAIL_LENGTH }),
	},
	{ additionalProperties: false },
);
export type CheckReport = Static<typeof CheckReportSchema>;

/** The check the loop is about; the caller's prose must state it verbatim. */
export interface VerifyAndFixCheck {
	/** The command a verifier attempts, for example `npm run check`. */
	readonly command: string;
	/** The install that must succeed first, when the repository needs one. */
	readonly install?: string;
}

/** A worktree fixer's workspace; a fixer that writes nowhere is not a fixer. */
export type WorktreeWorkspaceRequest = {
	readonly mode: "worktree";
	readonly cwd: string;
};

/** The verifier declaration a caller owns: prose, tools, workspace, retries. */
export type VerifyTaskRequest = Omit<
	AgentTaskAuthoringRequest<
		typeof CheckReportSchema,
		WorkspaceAuthoringRequest
	>,
	"outputSchema" | "model" | "limits"
>;

/** The fixer declaration a caller owns; the component owns its handoff policy. */
export type FixTaskRequest<TOutputSchema extends TSchema> = Omit<
	AgentTaskAuthoringRequest<TOutputSchema, WorktreeWorkspaceRequest>,
	"model" | "limits" | "handoff"
>;

/** One verifier and what it said; the fixer of the same round reads this. */
export interface VerifyRoundReport {
	/** 1-based round ordinal; the only ordering input to a key. */
	readonly round: number;
	readonly key: TaskKey;
	readonly verify: TaskHandle<CheckReport>;
	readonly report: CheckReport;
}

/** A completed round: its verifier, and the fixer it declared, if any. */
export interface VerifyRound extends VerifyRoundReport {
	readonly fixKey?: TaskKey;
	readonly fix?: WorktreeTaskHandle<unknown>;
	/** The rung the fixer of this round ran at. */
	readonly fixEffort?: Effort;
}

/** The three `ctx` members the loop uses; nothing else is read. */
export type VerifyAndFixContext = Pick<
	WorkflowContext<unknown>,
	"agent" | "result" | "log"
>;

export interface VerifyAndFixOptions<TFixSchema extends TSchema> {
	/** The worktree implementer whose handoff round 1 verifies. */
	readonly implementation: WorktreeTaskHandle<unknown>;
	readonly check: VerifyAndFixCheck;
	/** The effort dial; every model and limit in the loop is a lookup on it. */
	readonly effort: Effort;
	/** Verify rounds, 0..3. Default 1. At most `maxRounds - 1` fixers follow. */
	readonly maxRounds?: 0 | 1 | 2 | 3;
	/** `"thinking"` runs a fixer one rung up the ladder. Default `"none"`. */
	readonly escalate?: "thinking" | "none";
	/** The verifier of round `n`; `previous` is the round before it, if any. */
	readonly verify: (
		round: number,
		previous: VerifyRound | undefined,
	) => VerifyTaskRequest;
	/** The fixer of round `n`, given the verifier that just failed. */
	readonly agent: (
		round: number,
		previous: VerifyRoundReport,
	) => FixTaskRequest<TFixSchema>;
	/** Default disposition; a request that names its own keeps it. */
	readonly disposition?: TaskDisposition;
	/** The run's `meta.budget`. Given, the worst case is admitted up front. */
	readonly budget?: WorkflowBudget;
	/** Input name for the current patch's handoff. Default `"patch"`. */
	readonly patchInput?: TaskKey;
	/** Input name for a failing verifier's report. Default `"check"`. */
	readonly reportInput?: TaskKey;
}

export interface VerifyAndFixResult {
	/** Verify rounds actually declared; 0 when `maxRounds` is 0. */
	readonly rounds: number;
	/** True only when the last verifier both ran the check and saw it pass. */
	readonly passed: boolean;
	/** The last verifier's `checkRan`; false means unverified, not broken. */
	readonly checkRan: boolean;
	/** The last verifier's `checkTail`; empty when nothing ran. */
	readonly lastTail: string;
	/**
	 * The final worktree handle: the last fixer when one ran, else the
	 * implementer. Downstream consumes `result.handoff.handoff` - the
	 * descriptor of the patch a reviewer judges and a human ships.
	 */
	readonly handoff: WorktreeTaskHandle<unknown>;
	readonly history: readonly VerifyRound[];
}

function refuse(message: string): never {
	throw new WorkflowComponentError("verifyAndFix", message);
}

/** The next rung of the effort ladder, or `undefined` above `deep`. */
export function nextRung(effort: Effort): Effort | undefined {
	const index = EFFORTS.indexOf(effort);
	return index < 0 ? undefined : EFFORTS[index + 1];
}

/**
 * The worst case of a loop that never passes: every verifier plus every fixer
 * the cap allows. Pure - a table lookup on `(effort, escalate, maxRounds)`.
 */
export function projectVerifyAndFixBudget(
	effort: Effort,
	escalate: "thinking" | "none",
	maxRounds: number,
): readonly BudgetShare[] {
	const shares: BudgetShare[] = [];
	const fixEffort =
		escalate === "thinking" ? (nextRung(effort) ?? effort) : effort;
	for (let round = 1; round <= maxRounds; round += 1) {
		shares.push(envelope(effort, "verify").budgetShare);
		if (round < maxRounds) shares.push(envelope(fixEffort, "fix").budgetShare);
	}
	return Object.freeze(shares);
}

function assertRoundKey(key: TaskKey, role: string, round: number): TaskKey {
	const derived = `${key}-${role}-${round}`;
	if (!Value.Check(TaskKeySchema, derived)) {
		refuse(
			`verifyAndFix("${key}") derives the key "${derived}" for round ${round}, which is not a task key; a loop key must leave room for the "-${role}-<n>" suffix within ${MAX_TASK_KEY_LENGTH} characters.`,
		);
	}
	return derived as TaskKey;
}

function assertComponentOwned(
	what: string,
	request: object,
	owned: readonly string[],
	because: string,
): void {
	for (const field of owned) {
		if (Object.hasOwn(request, field)) {
			refuse(
				`${what} declares \`${field}\`, which verifyAndFix owns: ${because}.`,
			);
		}
	}
}

function mergeInputs(
	what: string,
	declared: Readonly<Record<TaskKey, TaskInputHandle>> | undefined,
	wired: Readonly<Record<TaskKey, TaskInputHandle>>,
): Readonly<Record<TaskKey, TaskInputHandle>> {
	for (const name of Object.keys(wired)) {
		if (declared && Object.hasOwn(declared, name)) {
			refuse(
				`${what} declares the input ${JSON.stringify(name)}, which the loop already wires; rename it or pass a different \`patchInput\`/\`reportInput\`.`,
			);
		}
	}
	return { ...(declared ?? {}), ...wired };
}

/**
 * Declares the loop and returns what the gate downstream has to show.
 *
 * Refuses at declaration when:
 * - `key` is not a task key, or a derived round key would not be one;
 * - `maxRounds` is outside 0..3 (the cap the replay cost pays for);
 * - `check.command` is missing or blank - a loop with nothing to run is not a
 *   verification, and its "green" would be a guess;
 * - `implementation` is not a worktree task handle, so there is no handoff to
 *   verify or to hand a fixer;
 * - `escalate: "thinking"` is asked for at `deep`, where the ladder ends;
 * - a verifier or fixer factory is missing for the rounds asked for;
 * - a returned declaration is not an object, declares a field the component
 *   owns, names an input the loop wires, or - for a fixer - is not a worktree
 *   task;
 * - the worst case (`maxRounds` verifiers plus `maxRounds - 1` fixers) does not
 *   fit the run's `meta.budget`, when the caller passes it.
 */
export async function verifyAndFix<TFixSchema extends TSchema>(
	ctx: VerifyAndFixContext,
	key: TaskKey,
	options: VerifyAndFixOptions<TFixSchema>,
): Promise<VerifyAndFixResult> {
	if (!Value.Check(TaskKeySchema, key)) {
		refuse(
			`verifyAndFix key ${JSON.stringify(key)} is not a task key; a loop key is a caller-supplied stable id matching ^[a-z][a-z0-9-]*$, 1..${MAX_TASK_KEY_LENGTH} characters.`,
		);
	}
	if (options === null || typeof options !== "object") {
		refuse(`verifyAndFix("${key}") requires a declaration.`);
	}

	const maxRounds = options.maxRounds ?? DEFAULT_VERIFY_ROUNDS;
	if (
		!Number.isInteger(maxRounds) ||
		maxRounds < 0 ||
		maxRounds > MAX_VERIFY_ROUNDS
	) {
		refuse(
			`verifyAndFix("${key}") asks for ${JSON.stringify(options.maxRounds)} rounds; a verify-and-fix loop runs 0..${MAX_VERIFY_ROUNDS} verify rounds, because every round crosses a barrier a resume has to replay.`,
		);
	}

	const command = options.check?.command;
	if (typeof command !== "string" || command.trim().length === 0) {
		refuse(
			`verifyAndFix("${key}") declares no check command; a loop with nothing to run cannot report an honest \`checkPassed\`.`,
		);
	}

	const implementation = options.implementation;
	if (
		!isTaskHandle(implementation) ||
		!isHandoffHandle(implementation.handoff)
	) {
		refuse(
			`verifyAndFix("${key}") needs a worktree implementation handle; a read-only task produces no handoff to verify or to hand a fixer.`,
		);
	}

	const effort = options.effort;
	if (!(EFFORTS as readonly unknown[]).includes(effort)) {
		refuse(
			`verifyAndFix("${key}") got the unknown effort ${JSON.stringify(effort)}; the effort dial is one of ${EFFORTS.join(", ")}.`,
		);
	}

	const escalate = options.escalate ?? "none";
	if (escalate !== "thinking" && escalate !== "none") {
		refuse(
			`verifyAndFix("${key}") got the unknown escalation ${JSON.stringify(options.escalate)}; it is "thinking" or "none".`,
		);
	}
	const escalated = escalate === "thinking" ? nextRung(effort) : effort;
	if (escalated === undefined) {
		refuse(
			`verifyAndFix("${key}") asks to escalate a fixer one rung above "${effort}", where the effort ladder ends (${EFFORTS.join(" -> ")}); drop \`escalate\` or lower the run's effort.`,
		);
	}

	if (maxRounds >= 1 && typeof options.verify !== "function") {
		refuse(`verifyAndFix("${key}") requires a \`verify\` function.`);
	}
	if (maxRounds >= 2 && typeof options.agent !== "function") {
		refuse(
			`verifyAndFix("${key}") runs ${maxRounds} rounds and requires an \`agent\` function for the fixer.`,
		);
	}

	const patchInput = options.patchInput ?? DEFAULT_PATCH_INPUT;
	const reportInput = options.reportInput ?? DEFAULT_REPORT_INPUT;
	for (const [name, value] of [
		["patchInput", patchInput],
		["reportInput", reportInput],
	] as const) {
		if (!Value.Check(TaskKeySchema, value)) {
			refuse(
				`verifyAndFix("${key}") ${name} ${JSON.stringify(value)} is not a task key.`,
			);
		}
	}
	if (patchInput === reportInput) {
		refuse(
			`verifyAndFix("${key}") wires the patch and the check report under the same input name ${JSON.stringify(patchInput)}; they are two different artifacts.`,
		);
	}

	// Every round key, up front: a loop that would refuse in round 2 refuses
	// before it declares round 1 and pays for a verifier nobody can follow.
	for (let round = 1; round <= maxRounds; round += 1) {
		assertRoundKey(key, "verify", round);
		if (round < maxRounds) assertRoundKey(key, "fix", round);
	}

	if (options.budget) {
		assertBudgetAdmits(
			options.budget,
			projectVerifyAndFixBudget(effort, escalate, maxRounds),
			`verifyAndFix("${key}") at "${effort}" effort over ${maxRounds} verify round(s) and ${Math.max(0, maxRounds - 1)} fix round(s)`,
		);
	}

	const verifyEnvelope = envelope(effort, "verify");
	const fixEnvelope = envelope(escalated, "fix");
	// The `verify` row is a read-only row (`workspaceWriteBytes: 0`), but a
	// verifier that has to apply the handoff before it can run the check needs a
	// worktree, and the runtime refuses a worktree with no write grant. The one
	// adjustment is the same constant the `implement` and `fix` rows already
	// carry, so it is still a table lookup keyed by (effort, stage, workspace)
	// and nothing observed at run time.
	const verifyLimits = (mode: string | undefined) =>
		mode === "worktree"
			? { ...verifyEnvelope.limits, workspaceWriteBytes: WORKSPACE_WRITE_BYTES }
			: verifyEnvelope.limits;

	let source: WorktreeTaskHandle<unknown> = implementation;
	const history: VerifyRound[] = [];
	let passed = false;
	let checkRan = false;
	let lastTail = "";

	for (let round = 1; round <= maxRounds; round += 1) {
		const verifyKey = assertRoundKey(key, "verify", round);
		const declared = options.verify(round, history[round - 2]);
		if (declared === null || typeof declared !== "object") {
			refuse(
				`verifyAndFix("${key}") verifier "${verifyKey}" is not a declaration.`,
			);
		}
		assertComponentOwned(
			`verifyAndFix("${key}") verifier "${verifyKey}"`,
			declared,
			["outputSchema", "model", "limits"],
			`a verifier reports the check report schema at envelope(${JSON.stringify(effort)}, "verify"), so the loop replays identically`,
		);
		const verifyRequest = {
			...declared,
			...(options.disposition !== undefined &&
			declared.disposition === undefined
				? { disposition: options.disposition }
				: {}),
			// A verifier is not a producer. When it runs in a worktree - to apply
			// the handoff before running the check - its own patch is not what
			// anyone ships, and a verifier that changed nothing must not fail on
			// "handoff absent". An explicit policy from the caller is kept.
			...(declared.workspace?.mode === "worktree" &&
			declared.handoff === undefined
				? { handoff: "optional" as const }
				: {}),
			outputSchema: CheckReportSchema,
			model: verifyEnvelope.model,
			limits: verifyLimits(declared.workspace?.mode),
			inputs: mergeInputs(
				`verifyAndFix("${key}") verifier "${verifyKey}"`,
				declared.inputs,
				{ [patchInput]: source.handoff },
			),
		} satisfies AgentTaskAuthoringRequest<
			typeof CheckReportSchema,
			WorkspaceAuthoringRequest
		>;
		const verifier = ctx.agent(
			verifyKey,
			verifyRequest,
		) as TaskHandle<CheckReport>;

		// THE BARRIER. Everything after it reads a persisted value, so a resume
		// re-declares this round before it can reach the next one.
		const report = await ctx.result(verifier);
		checkRan = report?.checkRan === true;
		lastTail = typeof report?.checkTail === "string" ? report.checkTail : "";
		const outcome: VerifyRoundReport = Object.freeze({
			round,
			key: verifyKey,
			verify: verifier,
			report,
		});

		if (checkRan && report.checkPassed === true) {
			passed = true;
			history.push(Object.freeze({ ...outcome }));
			break;
		}
		if (!checkRan) {
			// Unverified, not broken. A fixer here would edit code nobody proved
			// was wrong, so the loop stops and a person reads the tail.
			ctx.log(
				`verifyAndFix("${key}"): \`${command}\` did not run to completion in round ${round}; the change is unverified, not broken, so no fix round is declared and the decision goes to a person.`,
			);
			history.push(Object.freeze({ ...outcome }));
			break;
		}
		if (round === maxRounds) {
			ctx.log(
				`verifyAndFix("${key}"): \`${command}\` still fails after ${round} verify round(s), the cap; the patch is handed on failing, with its tail, for a person to decide.`,
			);
			history.push(Object.freeze({ ...outcome }));
			break;
		}

		const fixKey = assertRoundKey(key, "fix", round);
		const declaredFix = options.agent(round, outcome);
		if (declaredFix === null || typeof declaredFix !== "object") {
			refuse(`verifyAndFix("${key}") fixer "${fixKey}" is not a declaration.`);
		}
		assertComponentOwned(
			`verifyAndFix("${key}") fixer "${fixKey}"`,
			declaredFix,
			["model", "limits", "handoff"],
			`a fixer is a retry at envelope(${JSON.stringify(escalated)}, "fix") and its handoff is always required - a worktree with no changes is a failed fix`,
		);
		if (declaredFix.workspace?.mode !== "worktree") {
			refuse(
				`verifyAndFix("${key}") fixer "${fixKey}" must run in a worktree; declare { mode: "worktree", cwd }.`,
			);
		}
		const fix = ctx.agent(fixKey, {
			...declaredFix,
			...(options.disposition !== undefined &&
			declaredFix.disposition === undefined
				? { disposition: options.disposition }
				: {}),
			model: fixEnvelope.model,
			limits: fixEnvelope.limits,
			handoff: "required",
			inputs: mergeInputs(
				`verifyAndFix("${key}") fixer "${fixKey}"`,
				declaredFix.inputs,
				{ [patchInput]: source.handoff, [reportInput]: verifier.output },
			),
		}) as WorktreeTaskHandle<Static<TFixSchema>>;
		history.push(
			Object.freeze({ ...outcome, fixKey, fix, fixEffort: escalated }),
		);
		source = fix;
	}

	return Object.freeze({
		rounds: history.length,
		passed,
		checkRan,
		lastTail,
		handoff: source,
		history: Object.freeze(history.slice()),
	});
}
