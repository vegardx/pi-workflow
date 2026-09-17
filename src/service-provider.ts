/**
 * `@vegardx/pi-workflow/service-provider` - the seam another Pi extension
 * acquires the workflow runtime through (spec 1.1 and 2.4).
 *
 * Structurally identical to `pi-subagent/src/service-provider.ts`: a lazy,
 * frozen `{contract, acquire(context)}` answering a request event on a
 * versioned channel, discovered twice so a provider swapped during
 * acquisition is refused rather than used.
 *
 * What crosses the seam is deliberately narrow. The client is **read,
 * validate, project, observe, and start-a-builtin-headless-run**: no
 * `decide`, `stop`, `invalidate`, or general `run`. Starting a workflow that
 * writes stays the model's own `workflow_run` call, in the open, in the
 * transcript (`docs/authority.md`). The one exception is `runBuiltin`, gated
 * by this package's own frozen `BUILTIN_HEADLESS_WORKFLOWS` allowlist: a
 * blind reviewer reached through a model turn would have read the planning
 * conversation and would not be blind. The allowlist belongs to the runtime,
 * not to the caller, and every name on it must declare no checkpoint, no
 * worktree and no handoff - a structural property `workflow_validate` cannot
 * check but `headlessBuiltinViolations` can.
 *
 * This entry point is **unfrozen** until a later minor pins it
 * (`docs/compatibility.md`).
 */

import type {
	EventBus,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
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
	type WorkflowServiceRunReceipt,
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
	WorkflowServiceRunReceipt,
	WorkflowValidationResult,
} from "./service.js";
export type {
	WorkflowBudgetProjection,
	WorkflowCheckpointDecisionView,
	WorkflowCheckpointTaskView,
	WorkflowInspectOptions,
	WorkflowInspectSection,
	WorkflowRunInspection,
	WorkflowRunObservation,
	WorkflowRunPage,
	WorkflowRunQuery,
	WorkflowRunSummary,
	WorkflowServiceTaskView,
	WorkflowServiceWaitView,
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
 * The workflows a service consumer may start headlessly, frozen here in the
 * runtime. `plan-review` is the blind plan reviewer of spec 2.2: one
 * read-only agent, `contextMode: "fresh"`, no checkpoint, no worktree, no
 * handoff.
 */
export const BUILTIN_HEADLESS_WORKFLOWS = Object.freeze([
	"plan-review",
] as const);
export type BuiltinHeadlessWorkflow =
	(typeof BUILTIN_HEADLESS_WORKFLOWS)[number];

/** The one refusal `runBuiltin` raises for a ref outside the allowlist. */
export function headlessRefusalMessage(ref: string): string {
	return `Workflow ${ref} may not be started by a service consumer; use workflow_run.`;
}

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
	 */
	inspect(
		runId: WorkflowRunId,
		options?: WorkflowInspectOptions,
	): Promise<WorkflowRunInspection>;
	/** Lease-free scan of the durable run store, newest first. */
	runs(query?: WorkflowRunQuery): Promise<WorkflowRunPage>;
	/** Every append this service makes to an owned run; idempotent unsubscribe. */
	observe(listener: (observation: WorkflowRunObservation) => void): () => void;
	/** Starts an allowlisted headless builtin; refuses every other ref. */
	runBuiltin(ref: string, input: unknown): Promise<WorkflowServiceRunReceipt>;
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
		runBuiltin: (ref: string, input: unknown) =>
			delegate(async () => {
				if (!(BUILTIN_HEADLESS_WORKFLOWS as readonly string[]).includes(ref)) {
					throw new WorkflowServiceError(
						"validation",
						headlessRefusalMessage(ref),
					);
				}
				// The allowlist names a definition this package ships; a project
				// definition that took the same name is not it.
				const resolved = await service.validate(ref, input);
				if (resolved.workflow.scope !== "builtin") {
					throw new WorkflowServiceError(
						"validation",
						headlessRefusalMessage(ref),
					);
				}
				const receipt = await service.run(ref, input);
				started.add(receipt.runId);
				return receipt;
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

/** What makes a definition illegal on the headless allowlist. */
export type HeadlessBuiltinViolation = "checkpoint" | "worktree" | "handoff";

/**
 * The allowlist's safety property, as a check (spec R2). `runBuiltin` starts a
 * run with no human on the other end, so an allowlisted definition may not
 * park on a decision, may not take a worktree, and may not produce a handoff.
 * The dry materialization of `project` is what makes this observable without
 * running anything.
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
