/**
 * `@vegardx/pi-workflow/service-provider` - the seam another Pi extension
 * acquires the workflow runtime through (spec 1.1 and 2.4).
 *
 * Structurally identical to `pi-subagent/src/service-provider.ts`: a lazy,
 * frozen `{contract, acquire(context)}` answering a request event on a
 * versioned channel, discovered twice so a provider swapped during
 * acquisition is refused rather than used.
 *
 * ## Narration
 *
 * A host that shows a run to a person needs more than a status: it posts each
 * task completion into the conversation and gives the model a turn on the
 * interesting ones. Two of the client's methods carry that, and between them
 * they are the whole narration surface:
 *
 * - `observe` fires once per durable append. The append that moved a task to a
 *   terminal status carries `task: {taskId, status, outcome?, narration}`, and
 *   `narration` is `{stage, taskKind, deliverable?, cause?}` — the stage key as
 *   one string, the kind a narrator branches on
 *   (`implement | check | review | synthesis | fix | gate | refine | other`),
 *   the deliverable the key names, and for a task that did not complete a
 *   sanitized cause composed from the journalled failure codes, never from the
 *   child's own prose. It carries no `summary`: an observation is a synchronous
 *   notice in sequence order and reads no file, and a summary is an artifact.
 * - `inspect(runId, {include: ["run", "tasks", "output"]})` carries the same
 *   `narration` on every projected task, with `narration.summary` filled in —
 *   the agent's own `summary`/`verdict`/`answer`/`synthesis` when its result has
 *   one, else a bounded rendering of the structured result. That is what a host
 *   hands the model when it wants a turn on a synthesis result or a fix report.
 *
 * Everything in `narration` is DERIVED from durable state, so it is additive
 * and moves no contract revision.
 *
 * What crosses the seam is deliberately narrow. The client is **read,
 * validate, project, observe, and start one allowlisted builtin**: no
 * `decide`, `stop`, `invalidate`, or general `run`. Starting a workflow that
 * writes stays the model's own `workflow_run` call, in the open, in the
 * transcript (`docs/authority.md`).
 *
 * `startBuiltin` is the one exception, and it is a narrow one. The decision it
 * carries is a person's, taken in the host's own dialog - "Start the run?" -
 * and a decision a human already made does not become safer by being routed
 * back through the model to make it call `workflow_run`. So the harness
 * executes it: `startBuiltin` creates the durable run and returns, never
 * awaiting and never observing. Its allowlist,
 * `BUILTIN_STARTABLE_WORKFLOWS`, belongs to the runtime rather than to the
 * caller, and it holds a workflow that DOES park on a checkpoint, take a
 * worktree and produce a handoff - the opposite of what a run nobody can be
 * asked to decide looks like. The run is an ordinary run in every other
 * respect: the same journal, the same checkpoints, visible in `/workflow` and
 * the widget, decided with `/workflow decide`. What marks it is provenance, not
 * behaviour - `run-created` records `origin: "service-provider"`, because no
 * model turn and no `/workflow` command is in the transcript to show where the
 * run came from.
 *
 * There is no headless start. `runBuiltin` and `BUILTIN_HEADLESS_WORKFLOWS`
 * existed for one definition, the blind plan reviewer, and the plan check is a
 * one-shot subagent in pi-maestro now: a host that wants one read-only opinion
 * does not need a durable run, a journal, a lease or an allowlist in this
 * package to get it.
 *
 * This entry point is **unfrozen** until a later minor pins it
 * (`docs/compatibility.md`).
 */

import type {
	EventBus,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { Effort } from "./components/envelope.js";
import {
	WORKFLOW_RUNTIME_CONTRACT,
	type WorkflowRunId,
	type WorkflowRuntimeContract,
	WorkflowRuntimeContractSchema,
} from "./contracts.js";
import type { WorkflowDefinition } from "./definition.js";
import { withSanitizedCause } from "./sanitized-cause.js";
import {
	projectWorkflowGraph,
	type WorkflowDefinitionSummary,
	type WorkflowService,
	WorkflowServiceError,
	type WorkflowValidationResult,
} from "./service.js";
import type {
	WorkflowBudgetProjection,
	WorkflowInspectOptions,
	WorkflowRunInspection,
	WorkflowRunObservation,
	WorkflowRunPage,
	WorkflowRunQuery,
	WorkflowServiceWaitView,
	WorkflowWaitOptions,
} from "./service-views.js";

export type {
	WorkflowDefinitionSummary,
	WorkflowValidationResult,
} from "./service.js";
export type {
	WorkflowBudgetProjection,
	WorkflowCheckpointDecisionView,
	WorkflowCheckpointTaskView,
	WorkflowInspectOptions,
	WorkflowInspectSection,
	WorkflowNarratedTaskKind,
	WorkflowObservedTask,
	WorkflowRunInspection,
	WorkflowRunObservation,
	WorkflowRunPage,
	WorkflowRunQuery,
	WorkflowRunSummary,
	WorkflowServiceTaskView,
	WorkflowServiceWaitView,
	WorkflowTaskNarration,
	WorkflowWaitOptions,
} from "./service-views.js";

const SERVICE_REQUEST_CHANNEL =
	"@vegardx/pi-workflow/service-provider/request/v1";

const SERVICE_REQUEST_SCHEMA = "pi-workflow-service-request-v1";

type ServiceRequest = {
	schema: typeof SERVICE_REQUEST_SCHEMA;
	respond(provider: unknown): void;
};

/**
 * The workflows a host may start on a person's behalf, frozen here in the
 * runtime. `plan-to-ship` is the builtin pipeline pi-maestro's plan mode exits
 * into: the person has already answered "Start the run?" in the host's dialog,
 * and the harness, not the model, carries that answer across.
 *
 * Nothing about the definition qualifies it - a startable builtin parks, writes
 * and hands off, which is exactly what `headlessBuiltinViolations` reports on.
 * What qualifies it is that a person decided, in the open, one dialog ago.
 */
export const BUILTIN_STARTABLE_WORKFLOWS = Object.freeze([
	"plan-to-ship",
] as const);
export type BuiltinStartableWorkflow =
	(typeof BUILTIN_STARTABLE_WORKFLOWS)[number];

/** The one refusal `startBuiltin` raises for a ref outside its allowlist. */
export function startableRefusalMessage(ref: string): string {
	return `Workflow ${ref} is not a builtin a service consumer may start; use workflow_run.`;
}

/**
 * The refusal `startBuiltin` raises when `effort` is given and the input
 * cannot carry it. The dial is a field of the definition's input, so it is
 * merged into the input object; a non-object input has nowhere to put it.
 */
export const START_EFFORT_REFUSAL_MESSAGE =
	"Workflow input must be a JSON object to carry an effort.";

/** The refusal `awaitRun` raises for a run this client did not start. */
export function foreignRunRefusalMessage(runId: string): string {
	return `Workflow run ${runId} was not started by this service consumer; use workflow_wait.`;
}

/**
 * The fixed message every non-`WorkflowServiceError` failure becomes, so a
 * consumer never sees an internal error string and never sees a stack.
 */
export const WORKFLOW_SERVICE_FAILURE_MESSAGE =
	"The workflow service could not complete the request.";

/**
 * What `startBuiltin` takes beyond the reference. `input` is validated against
 * the definition\'s `inputSchema` exactly as `workflow_run` validates its own,
 * with the same refusals and no run created by a refused one. `effort` is the
 * dial the builtin pipelines read from their input: given, it is written onto
 * the input object as `effort` (replacing any the caller already put there)
 * and then validated with the rest, so an unknown value is refused by the
 * definition\'s schema and not by a second list here.
 */
export interface WorkflowStartBuiltinOptions {
	readonly input: unknown;
	readonly effort?: Effort;
}

/** The narrowed client a consumer receives; see the module comment. */
export interface WorkflowReadClient {
	/** Every discovered static definition. */
	list(): Promise<readonly WorkflowDefinitionSummary[]>;
	/** Resolves `ref` and, with an input, validates it against `inputSchema`. */
	validate(ref: string, input?: unknown): Promise<WorkflowValidationResult>;
	/** Lease-free budget projection (spec 2.4); static refs only. */
	project(ref: string, input: unknown): Promise<WorkflowBudgetProjection>;
	/**
	 * Lease-free bounded projection of one run. `include: ["output"]` adds a
	 * terminal run's committed output at `run.output`, and every projected
	 * checkpoint task carries its decided value at
	 * `tasks[].checkpoint.decision.value` once the decision is durable - so a
	 * consumer can read a run's result and prove a decision without a lease
	 * and without `decide`.
	 *
	 * Every projected task also carries `tasks[].narration`, and with `"output"`
	 * and `"tasks"` both included it carries `narration.summary` too: the one
	 * call a host makes when it wants to narrate what a task said.
	 */
	inspect(
		runId: WorkflowRunId,
		options?: WorkflowInspectOptions,
	): Promise<WorkflowRunInspection>;
	/** Lease-free scan of the durable run store, newest first. */
	runs(query?: WorkflowRunQuery): Promise<WorkflowRunPage>;
	/**
	 * Every append this service makes to an owned run; idempotent unsubscribe.
	 *
	 * The append that settled a task carries `observation.task` — see
	 * **Narration** in this module's header — so a host narrating completions
	 * filters on that field rather than re-reading the journal per append.
	 */
	observe(listener: (observation: WorkflowRunObservation) => void): () => void;
	/**
	 * Creates a durable run of an allowlisted startable builtin and returns
	 * its id; refuses every other ref.
	 *
	 * It returns as soon as the run exists: no drive is awaited and no
	 * observation is opened. The run is an ordinary run - same journal, same
	 * checkpoints, same `/workflow` and widget visibility, decided with
	 * `/workflow decide` - marked only by `origin: "service-provider"` on
	 * `run-created`. `awaitRun` is permitted on it, because this client
	 * started it.
	 */
	startBuiltin(
		ref: string,
		options: WorkflowStartBuiltinOptions,
	): Promise<{ runId: WorkflowRunId }>;
	/** Drives a run this client started to a durable terminal state. */
	awaitRun(
		runId: WorkflowRunId,
		options?: WorkflowWaitOptions,
	): Promise<WorkflowServiceWaitView>;
}

export type WorkflowServiceProvider = {
	readonly contract: WorkflowRuntimeContract;
	acquire(context: ExtensionContext): Promise<WorkflowReadClient>;
};

export class WorkflowServiceProviderError extends Error {
	constructor(
		readonly code: "missing" | "duplicate" | "incompatible" | "replaced",
		message: string,
	) {
		super(message);
		this.name = "WorkflowServiceProviderError";
	}
}

function isServiceRequest(value: unknown): value is ServiceRequest {
	if (typeof value !== "object" || value === null) return false;
	const request = value as Partial<ServiceRequest>;
	return (
		request.schema === SERVICE_REQUEST_SCHEMA &&
		typeof request.respond === "function"
	);
}

/**
 * The consumer-side compatibility check, the same three that pi-workflow
 * makes of pi-subagent's provider: `acquire` is a function, the contract
 * validates against the schema, and **every** feature key equals this
 * build's - including the nested `requiredSubagent` contract, because a
 * runtime that needs a different pi-subagent revision is a different runtime.
 * A contract-revision bump therefore fails discovery loudly instead of
 * mis-calling.
 */
export function isCompatibleWorkflowProvider(
	value: unknown,
): value is WorkflowServiceProvider {
	if (typeof value !== "object" || value === null) return false;
	try {
		const provider = value as Partial<WorkflowServiceProvider>;
		const acquire = provider.acquire;
		const contract = provider.contract;
		if (
			typeof acquire !== "function" ||
			!Value.Check(WorkflowRuntimeContractSchema, contract)
		) {
			return false;
		}
		if (
			contract.contractRevision !== WORKFLOW_RUNTIME_CONTRACT.contractRevision
		) {
			return false;
		}
		for (const feature of Object.keys(
			WORKFLOW_RUNTIME_CONTRACT.features,
		) as Array<keyof WorkflowRuntimeContract["features"]>) {
			if (
				contract.features[feature] !==
				WORKFLOW_RUNTIME_CONTRACT.features[feature]
			) {
				return false;
			}
		}
		const required = WORKFLOW_RUNTIME_CONTRACT.requiredSubagent;
		if (
			contract.requiredSubagent.contractRevision !== required.contractRevision
		) {
			return false;
		}
		for (const feature of Object.keys(required.features) as Array<
			keyof typeof required.features
		>) {
			if (
				contract.requiredSubagent.features[feature] !==
				required.features[feature]
			) {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * `WorkflowServiceError` passes through with its code intact; anything else
 * becomes one fixed message, so no internal failure text crosses the seam.
 *
 * When the cause is itself a fixed, sanitized message - this package's own
 * provider errors, or pi-subagent's - it is appended to that message
 * (`sanitized-cause.ts`). The consumer is another extension's operator
 * notice, and a notice that cannot name the failure sends a human looking in
 * the wrong runtime.
 */
function mapFailure(error: unknown): unknown {
	if (error instanceof WorkflowServiceError) return error;
	return new WorkflowServiceError(
		"execution",
		withSanitizedCause(WORKFLOW_SERVICE_FAILURE_MESSAGE, error),
		{ cause: error },
	);
}

async function delegate<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		throw mapFailure(error);
	}
}

/**
 * Writes `effort` onto the input the definition validates. The dial is an
 * ordinary input field, so there is one schema and one refusal; a non-object
 * input has nowhere to carry it and is refused before a run exists.
 */
function withEffort(input: unknown, effort: Effort | undefined): unknown {
	if (effort === undefined) return input;
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new WorkflowServiceError("validation", START_EFFORT_REFUSAL_MESSAGE);
	}
	return { ...(input as Record<string, unknown>), effort };
}

/**
 * Narrows a full `WorkflowService` to the client the seam exposes. The
 * allowlist and the started-run ledger live here, on the producer side: a
 * consumer cannot widen either by handing back a different object.
 */
export function createWorkflowReadClient(
	service: WorkflowService,
): WorkflowReadClient {
	const started = new Set<string>();
	return Object.freeze({
		list: () => delegate(() => service.list()),
		validate: (ref: string, input?: unknown) =>
			delegate(() => service.validate(ref, input)),
		project: (ref: string, input: unknown) =>
			delegate(() => service.project(ref, input)),
		inspect: (runId: WorkflowRunId, options?: WorkflowInspectOptions) =>
			delegate(() => service.inspect(runId, options)),
		runs: (query?: WorkflowRunQuery) => delegate(() => service.listRuns(query)),
		observe: (listener: (observation: WorkflowRunObservation) => void) => {
			try {
				return service.subscribe(listener);
			} catch (error) {
				throw mapFailure(error);
			}
		},
		startBuiltin: (ref: string, options: WorkflowStartBuiltinOptions) =>
			delegate(async () => {
				if (!(BUILTIN_STARTABLE_WORKFLOWS as readonly string[]).includes(ref)) {
					throw new WorkflowServiceError(
						"validation",
						startableRefusalMessage(ref),
					);
				}
				const input = withEffort(options.input, options.effort);
				// The allowlist names a definition this package ships; a project
				// definition that took the same name is not it.
				const resolved = await service.validate(ref, input);
				if (resolved.workflow.scope !== "builtin") {
					throw new WorkflowServiceError(
						"validation",
						startableRefusalMessage(ref),
					);
				}
				const receipt = await service.run(ref, input, {
					origin: "service-provider",
				});
				started.add(receipt.runId);
				return { runId: receipt.runId };
			}),
		awaitRun: (runId: WorkflowRunId, options?: WorkflowWaitOptions) =>
			delegate(() => {
				if (!started.has(runId)) {
					throw new WorkflowServiceError(
						"validation",
						foreignRunRefusalMessage(runId),
					);
				}
				return service.wait(runId, options);
			}),
	});
}

/**
 * Registers the provider on Pi's event bus. `acquire` hands back the full
 * service; the narrowing to `WorkflowReadClient` happens here, so the
 * capability boundary is this package's and not the extension's.
 */
export function registerWorkflowServiceProvider(
	events: EventBus,
	acquire: (context: ExtensionContext) => Promise<WorkflowService>,
): () => void {
	const provider: WorkflowServiceProvider = Object.freeze({
		contract: WORKFLOW_RUNTIME_CONTRACT,
		async acquire(context: ExtensionContext) {
			return createWorkflowReadClient(await acquire(context));
		},
	});
	return events.on(SERVICE_REQUEST_CHANNEL, (value) => {
		if (!isServiceRequest(value)) return;
		value.respond(provider);
	});
}

function discoverProvider(events: EventBus): WorkflowServiceProvider {
	const providers: unknown[] = [];
	const request: ServiceRequest = {
		schema: SERVICE_REQUEST_SCHEMA,
		respond(provider) {
			providers.push(provider);
		},
	};
	events.emit(SERVICE_REQUEST_CHANNEL, request);
	if (providers.length === 0) {
		throw new WorkflowServiceProviderError(
			"missing",
			"No pi-workflow service provider is registered.",
		);
	}
	if (providers.length !== 1) {
		throw new WorkflowServiceProviderError(
			"duplicate",
			`Expected one pi-workflow service provider, received ${providers.length}.`,
		);
	}
	const provider = providers[0];
	if (!isCompatibleWorkflowProvider(provider)) {
		throw new WorkflowServiceProviderError(
			"incompatible",
			"The registered pi-workflow service provider is incompatible.",
		);
	}
	return provider;
}

export async function acquireWorkflowService(
	events: EventBus,
	context: ExtensionContext,
): Promise<WorkflowReadClient> {
	const provider = discoverProvider(events);
	const client = await provider.acquire(context);
	if (discoverProvider(events) !== provider) {
		throw new WorkflowServiceProviderError(
			"replaced",
			"The pi-workflow service provider changed during acquisition.",
		);
	}
	return client;
}

/** What stops a definition from being a run nobody has to be asked about. */
export type HeadlessBuiltinViolation = "checkpoint" | "worktree" | "handoff";

/**
 * Whether a definition would park on a decision, take a worktree, or produce a
 * handoff, for one input - the three things that make a run need a person.
 *
 * It answers a STRUCTURAL question `workflow_validate` cannot: the dry
 * materialization of `project` walks the graph without running anything. Two
 * kinds of caller need it. A definition that claims to be structurally headless
 * (`deep-review`, `deep-research`) asserts it against the shipped file rather
 * than in prose; and `BUILTIN_STARTABLE_WORKFLOWS` is the opposite list, whose
 * one name violates all three on purpose, because a person already decided.
 */
export async function headlessBuiltinViolations(
	definition: WorkflowDefinition,
	input: unknown,
): Promise<readonly HeadlessBuiltinViolation[]> {
	const projection = await projectWorkflowGraph(definition, input);
	const violations: HeadlessBuiltinViolation[] = [];
	if (projection.checkpoints > 0) violations.push("checkpoint");
	if (projection.worktrees > 0) violations.push("worktree");
	if (projection.handoffs > 0) violations.push("handoff");
	return Object.freeze(violations);
}
