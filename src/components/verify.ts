import { type Static, Type } from "typebox";
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
	isModelRequest,
	type ModelAuthoringRequest,
} from "../session-model.js";
import {
	assertBudgetAdmits,
	envelope,
	WORKSPACE_WRITE_BYTES,
} from "./envelope.js";
import { WorkflowComponentError } from "./errors.js";
import { startAtHandoff } from "./workspace.js";

/**
 * `verifyHandoff` — one verifier that runs the repository's own check over a
 * worktree hand-off and reports it honestly. It verifies; it never fixes.
 *
 * Pattern: `skills/workflow-authoring/SKILL.md` § "Verify a hand-off, never
 * fix it". The rules it encodes live under "`after` versus `inputs`" and
 * "Budgets and admission".
 *
 * Lowering, and nothing else:
 *
 * ```text
 * ctx.agent(<key>, …)   the check, at the hand-off, reported honestly
 * ```
 *
 * The component DECLARES and returns the handle; it crosses no barrier. A
 * caller that wants the check to run beside something else — `plan-to-ship`
 * runs it beside the review lenses — declares both before it awaits either.
 *
 * Fixing is not a verifier's job, and no longer a separate fixer's: the agent
 * that wrote the change is resumed with the check report and answers it
 * (`plan-to-ship`'s resume), and a second `verifyHandoff` under another key
 * checks what it handed back. That is why there are no rounds here.
 *
 * ## `checkRan: false` is a human's problem
 *
 * The check runs inside the agent's own VM, which has one CPU and a bounded
 * memory grant, so an install or a build can be killed before the check ever
 * completes. The verifier reports that as `checkRan: false`: unverified, not
 * broken. It never counts as green, and nothing should be "fixed" because of
 * it.
 *
 * ## What the component owns, and what the caller owns
 *
 * The caller owns the prose, the tools, the workspace and the agent name; the
 * component owns the key, the output schema, the model and the limits, and
 * the input wiring: the hand-off arrives under `patchInput` (default
 * `"patch"`) and the workspace starts at it, so the change under test is in
 * the tree. A request that declares a component-owned field is refused rather
 * than overwritten. A worktree verifier gets `handoff: "optional"` unless it
 * names one — it is not a producer — and the `WORKSPACE_WRITE_BYTES` grant,
 * because the install and the check write to the tree.
 */

/** The longest check tail a report may carry. */
export const MAX_CHECK_TAIL_LENGTH = 4096;
/** The input name the verified hand-off's descriptor arrives under. */
export const DEFAULT_PATCH_INPUT = "patch" as TaskKey;

/**
 * What a verifier reports: exactly what was attempted, whether it ran, whether
 * it passed, and the tail of its output. "Did not run" and "ran and failed"
 * are different answers.
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

/** The check the verifier runs; the caller's prose must state it verbatim. */
export interface VerifyCheck {
	/** The command a verifier attempts, for example `npm run check`. */
	readonly command: string;
	/** The install that must succeed first, when the repository needs one. */
	readonly install?: string;
}

/** The verifier declaration a caller owns: prose, tools, workspace, retries. */
export type VerifyTaskRequest = Omit<
	AgentTaskAuthoringRequest<
		typeof CheckReportSchema,
		WorkspaceAuthoringRequest
	>,
	"outputSchema" | "model" | "limits"
>;

/** The one `ctx` member the component uses. */
export type VerifyContext = Pick<WorkflowContext<unknown>, "agent">;

export interface VerifyHandoffOptions {
	/** The worktree task whose hand-off is verified. */
	readonly handoff: WorktreeTaskHandle<unknown>;
	readonly check: VerifyCheck;
	/** An exact `{provider, id, thinking}`, or `"inherit"`. */
	readonly model: ModelAuthoringRequest;
	readonly request: VerifyTaskRequest;
	readonly disposition?: TaskDisposition;
	/** The run's `meta.budget`. Given, the verifier is admitted up front. */
	readonly budget?: WorkflowBudget;
	/** Input name for the hand-off. Default `"patch"`. */
	readonly patchInput?: TaskKey;
}

function refuse(message: string): never {
	throw new WorkflowComponentError("verifyHandoff", message);
}

const OWNED = ["outputSchema", "model", "limits"] as const;

/**
 * Declares the verifier and returns its handle.
 *
 * Refuses at declaration when `key` is not a task key; `check.command` is
 * missing or blank; `handoff` is not a worktree task handle; `model` is
 * neither `"inherit"` nor an exact model; the request is not an object,
 * declares a component-owned field, names the input the component wires, or
 * starts its workspace elsewhere; or the verifier does not fit `budget`.
 */
export function verifyHandoff(
	ctx: VerifyContext,
	key: TaskKey,
	options: VerifyHandoffOptions,
): TaskHandle<CheckReport> {
	if (!Value.Check(TaskKeySchema, key)) {
		refuse(
			`verifyHandoff key ${JSON.stringify(key)} is not a task key; a key is a caller-supplied stable id matching ^[a-z][a-z0-9-]*$, 1..${MAX_TASK_KEY_LENGTH} characters.`,
		);
	}
	if (options === null || typeof options !== "object") {
		refuse(`verifyHandoff("${key}") requires a declaration.`);
	}
	const command = options.check?.command;
	if (typeof command !== "string" || command.trim().length === 0) {
		refuse(
			`verifyHandoff("${key}") declares no check command; a verifier with nothing to run cannot report an honest \`checkPassed\`.`,
		);
	}
	const source = options.handoff;
	if (!isTaskHandle(source) || !isHandoffHandle(source.handoff)) {
		refuse(
			`verifyHandoff("${key}") needs a worktree task handle; a read-only task produces no hand-off to verify.`,
		);
	}
	if (!isModelRequest(options.model)) {
		refuse(
			`verifyHandoff("${key}") got ${JSON.stringify(options.model)} as its model; declare an exact {provider, id, thinking} or "inherit".`,
		);
	}
	const patchInput = options.patchInput ?? DEFAULT_PATCH_INPUT;
	if (!Value.Check(TaskKeySchema, patchInput)) {
		refuse(
			`verifyHandoff("${key}") patchInput ${JSON.stringify(patchInput)} is not a task key.`,
		);
	}
	const declared = options.request;
	if (declared === null || typeof declared !== "object") {
		refuse(`verifyHandoff("${key}") request is not a declaration.`);
	}
	for (const field of OWNED) {
		if (Object.hasOwn(declared, field)) {
			refuse(
				`verifyHandoff("${key}") request declares \`${field}\`, which the component owns: a verifier reports the check report schema at envelope("verify") and runs at the component's model.`,
			);
		}
	}
	if (declared.inputs && Object.hasOwn(declared.inputs, patchInput)) {
		refuse(
			`verifyHandoff("${key}") request declares the input ${JSON.stringify(patchInput)}, which the component wires; rename it or pass a different \`patchInput\`.`,
		);
	}
	if (options.budget) {
		assertBudgetAdmits(
			options.budget,
			[envelope("verify").budgetShare],
			`verifyHandoff("${key}")`,
		);
	}
	const verifyEnvelope = envelope("verify");
	const worktree = declared.workspace?.mode === "worktree";
	const inputs: Record<TaskKey, TaskInputHandle> = {
		...(declared.inputs ?? {}),
		[patchInput]: source.handoff,
	};
	return ctx.agent(key, {
		...declared,
		...(options.disposition !== undefined && declared.disposition === undefined
			? { disposition: options.disposition }
			: {}),
		...(worktree && declared.handoff === undefined
			? { handoff: "optional" as const }
			: {}),
		workspace: startAtHandoff(
			"verifyHandoff",
			`verifyHandoff("${key}") verifier`,
			declared.workspace,
			patchInput,
		),
		outputSchema: CheckReportSchema,
		model: options.model,
		limits: worktree
			? { ...verifyEnvelope.limits, workspaceWriteBytes: WORKSPACE_WRITE_BYTES }
			: verifyEnvelope.limits,
		inputs,
	}) as TaskHandle<CheckReport>;
}
