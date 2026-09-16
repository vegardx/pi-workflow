import type { TSchema } from "typebox";
import type {
	TaskDisposition,
	TaskKey,
	WorkflowBudget,
} from "../contracts-core.js";
import type {
	AgentTaskAuthoringRequest,
	AgentTaskHandle,
	WorkflowContext,
	WorkspaceAuthoringRequest,
} from "../definition.js";
import { WorkflowComponentError } from "./errors.js";

/**
 * `forEach` — one worker per item, keyed by a caller-supplied stable id.
 *
 * Pattern: **Fan-out over a stable id** (`skills/workflow-authoring/SKILL.md`,
 * the "Patterns" section added by W3-SKILL; the rules it encodes are "Keys,
 * namespaces, and handles" and "Barriers and replay" today).
 *
 * Lowering: exactly one `ctx.fanOut(namespace, items, { key, task })`. After
 * materialization the declarations are indistinguishable from the hand-written
 * call — same namespace, same keys, same requests, same order — so this adds
 * no contract, no runtime behaviour and no identity of its own.
 *
 * ## The three replay laws, and which half of each is checkable
 *
 * 1. **Keys are a pure function of (namespace, declaration ordinal, a
 *    caller-supplied stable id).** `key(item) = idOf(item)`. The checkable
 *    half is enforced: `idOf` is called twice per item and a second, different
 *    answer is refused at declaration, which catches a counter, a clock, a
 *    `Math.random`, and a hash of something mutable. The uncheckable half —
 *    that the id names a **required** field of the workflow input rather than
 *    an incidental one — is stated law: an id that can be absent produces a
 *    different key on the next materialization and invalidates the run.
 * 2. **The items must originate in `ctx.input` or in a value a barrier has
 *    already returned.** There is no checkable rule for this: a component
 *    receives an array, not its provenance, and any test of the caller's
 *    closure would be a guess. It is documented law, and the exact-prefix
 *    replay test is what enforces it in practice — an array built from
 *    anything else changes between materializations and fails there, loudly.
 * 3. **Effort, model and budget choices are table lookups keyed by
 *    `ctx.input`.** `forEach` chooses none of them; it only projects the
 *    worst case of what the caller's table produced and refuses up front
 *    rather than blocking admission mid-run.
 *
 * ## Refusals, all at declaration time
 *
 * - more than 64 items (the runtime's fan-out bound, named here by the
 *   component so the message points at the plan and not at the engine);
 * - an id that is not a task key (`^[a-z][a-z0-9-]*$`, at most 128 chars);
 * - an unstable id (two calls, two answers);
 * - a duplicate id;
 * - a projected worst case that does not fit the run's `meta.budget`, when the
 *   caller passes that budget.
 */

/** The runtime's own fan-out bound; the component refuses before it is hit. */
export const MAX_FOR_EACH_ITEMS = 64;
const TASK_KEY_RE = /^[a-z][a-z0-9-]*$/;
const MAX_TASK_KEY_LENGTH = 128;

export interface ForEachOptions<
	TItem,
	TOutputSchema extends TSchema,
	TWorkspace extends WorkspaceAuthoringRequest = WorkspaceAuthoringRequest,
> {
	/**
	 * The stable id of an item: its task key inside `namespace`. It must be a
	 * pure function of the item, and the field it reads must be one the
	 * workflow's input schema **requires**.
	 */
	readonly idOf: (item: TItem, ordinal: number) => string;
	/** The declaration for one item, by item, stable id, and 0-based ordinal. */
	readonly task: (
		item: TItem,
		id: TaskKey,
		ordinal: number,
	) => AgentTaskAuthoringRequest<TOutputSchema, TWorkspace>;
	/** Default disposition; a request that names its own keeps it. */
	readonly disposition?: TaskDisposition;
	/**
	 * The run's `meta.budget`. Given, the component sums the declared limits of
	 * every item exactly as the scheduler reserves them (`src/budget.ts`) and
	 * refuses a fan-out whose worst case cannot fit.
	 */
	readonly budget?: WorkflowBudget;
}

function assertTaskKey(
	value: string,
	namespace: string,
	ordinal: number,
): asserts value is TaskKey {
	if (
		typeof value !== "string" ||
		value.length > MAX_TASK_KEY_LENGTH ||
		!TASK_KEY_RE.test(value)
	) {
		throw new WorkflowComponentError(
			"forEach",
			`forEach("${namespace}") got the invalid id ${JSON.stringify(value)} for item ${ordinal}; a fan-out key must match ^[a-z][a-z0-9-]*$, be at most ${MAX_TASK_KEY_LENGTH} characters, and read a required field of the workflow input.`,
		);
	}
}

/**
 * The worst case this fan-out would reserve: the sum of the declared limits
 * over every item, mapped onto the budget the way `workflowUsage` maps a
 * reservation (`limits.cost`, `limits.totalTokens`, `limits.cumulativeRuntimeMs`).
 */
export function projectFanOutBudget(
	requests: readonly {
		readonly limits: AgentTaskAuthoringRequest<TSchema>["limits"];
	}[],
): { cost: number; totalTokens: number; childRuntimeMs: number } {
	let cost = 0;
	let totalTokens = 0;
	let childRuntimeMs = 0;
	for (const request of requests) {
		cost += request.limits.cost;
		totalTokens += request.limits.totalTokens ?? 0;
		childRuntimeMs += request.limits.cumulativeRuntimeMs;
	}
	return { cost, totalTokens, childRuntimeMs };
}

export function forEach<
	TItem,
	TOutputSchema extends TSchema,
	TWorkspace extends WorkspaceAuthoringRequest = WorkspaceAuthoringRequest,
>(
	ctx: WorkflowContext<unknown>,
	namespace: TaskKey,
	items: readonly TItem[],
	options: ForEachOptions<TItem, TOutputSchema, TWorkspace>,
): readonly AgentTaskHandle<TOutputSchema, TWorkspace>[] {
	if (typeof namespace !== "string" || !TASK_KEY_RE.test(namespace)) {
		throw new WorkflowComponentError(
			"forEach",
			`forEach namespace ${JSON.stringify(namespace)} must match ^[a-z][a-z0-9-]*$.`,
		);
	}
	if (!Array.isArray(items)) {
		throw new WorkflowComponentError(
			"forEach",
			`forEach("${namespace}") requires an array of items.`,
		);
	}
	if (
		typeof options?.idOf !== "function" ||
		typeof options?.task !== "function"
	) {
		throw new WorkflowComponentError(
			"forEach",
			`forEach("${namespace}") requires an \`idOf\` and a \`task\` function.`,
		);
	}
	if (items.length > MAX_FOR_EACH_ITEMS) {
		throw new WorkflowComponentError(
			"forEach",
			`forEach("${namespace}") declares ${items.length} items; a fan-out admits at most ${MAX_FOR_EACH_ITEMS}.`,
		);
	}

	const ids: TaskKey[] = [];
	const owners = new Map<string, number>();
	items.forEach((item, ordinal) => {
		const id = options.idOf(item, ordinal);
		// Law 1, the checkable half: a key that answers differently the second
		// time answers differently on replay too, and the run is invalidated
		// after the work has been paid for. Refuse it now instead.
		const again = options.idOf(item, ordinal);
		if (id !== again) {
			throw new WorkflowComponentError(
				"forEach",
				`forEach("${namespace}") got the unstable id ${JSON.stringify(id)} then ${JSON.stringify(again)} for item ${ordinal}; a fan-out key must be a pure function of the item.`,
			);
		}
		assertTaskKey(id, namespace, ordinal);
		const owner = owners.get(id);
		if (owner !== undefined) {
			throw new WorkflowComponentError(
				"forEach",
				`forEach("${namespace}") got the duplicate id ${JSON.stringify(id)} for items ${owner} and ${ordinal}; every fan-out key must be unique in its namespace.`,
			);
		}
		owners.set(id, ordinal);
		ids.push(id);
	});

	const requests = items.map((item, ordinal) => {
		const id = ids[ordinal] as TaskKey;
		const request = options.task(item, id, ordinal);
		if (request === null || typeof request !== "object") {
			throw new WorkflowComponentError(
				"forEach",
				`forEach("${namespace}") task ${JSON.stringify(id)} is not a declaration.`,
			);
		}
		return options.disposition === undefined ||
			request.disposition !== undefined
			? request
			: { ...request, disposition: options.disposition };
	});

	const budget = options.budget;
	if (budget) {
		const projected = projectFanOutBudget(requests);
		if (projected.cost > budget.cost) {
			throw new WorkflowComponentError(
				"forEach",
				`forEach("${namespace}") projects ${projected.cost} cost over ${items.length} item(s), which exceeds the run budget of ${budget.cost}.`,
			);
		}
		if (
			budget.totalTokens !== undefined &&
			projected.totalTokens > budget.totalTokens
		) {
			throw new WorkflowComponentError(
				"forEach",
				`forEach("${namespace}") projects ${projected.totalTokens} total tokens over ${items.length} item(s), which exceeds the run budget of ${budget.totalTokens}.`,
			);
		}
		if (projected.childRuntimeMs > budget.childRuntimeMs) {
			throw new WorkflowComponentError(
				"forEach",
				`forEach("${namespace}") projects ${projected.childRuntimeMs} ms of child runtime over ${items.length} item(s), which exceeds the run budget of ${budget.childRuntimeMs}.`,
			);
		}
	}

	if (items.length === 0) return Object.freeze([]);
	return ctx.fanOut(namespace, items, {
		key: (_item, index) => ids[index] as TaskKey,
		task: (_item, index) =>
			requests[index] as AgentTaskAuthoringRequest<TOutputSchema, TWorkspace>,
	});
}
