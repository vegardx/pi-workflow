import { randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { HANDOFF_EXPORT_MEDIA_TYPE } from "@vegardx/pi-subagent";
import { Ajv } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import * as addFormatsModule from "ajv-formats";
import { Value } from "typebox/value";
import {
	readWorkflowArtifactInputs,
	WorkflowArtifactInputError,
} from "./artifact-input.js";
import { WorkflowArtifactStore } from "./artifact-store.js";
import {
	currentSubagentAttempt,
	currentSubagentAttemptId,
} from "./attempts.js";
import { settledWorkflowUsage } from "./budget.js";
import { WorkflowCheckpointExecutionError } from "./checkpoint-executor.js";
import {
	MAX_WORKFLOW_CONCURRENCY,
	WORKFLOW_CONTRACT_REVISION,
	type WorkflowHandoffDescriptor,
	type WorkflowRunId,
	WorkflowRunIdSchema,
	type WorkflowRunStatus,
	type WorkflowTaskId,
	WorkflowTaskIdSchema,
} from "./contracts.js";
import {
	deriveDecisionRecordSha256,
	type WorkflowDecisionBinding,
	type WorkflowDecisionRecord,
	WorkflowDecisionRecordError,
	WorkflowDecisionRecordStore,
} from "./decision-store.js";
import {
	type AgentTaskAuthoringRequest,
	createTaskHandle,
	type FinalizeRequest,
	type NestedWorkflowRequest,
	type TaskHandle,
	validateJsonSchemaDocument,
	type WorkflowBudget,
	type WorkflowContext,
	type WorkflowDefinition,
} from "./definition.js";
import {
	assertDynamicSourceRunnable,
	type DynamicSourceApprovalRecord,
	DynamicWorkflowApprovalError,
	type DynamicWorkflowProposalView,
	decideDynamicSource,
	MSG_APPROVAL_INVALID,
	MSG_PROPOSAL_NOT_FOUND,
	readSourceApproval,
	toDynamicWorkflowProposalView,
} from "./dynamic/approval.js";
import { MAX_DYNAMIC_PROPOSALS } from "./dynamic/constants.js";
import {
	type DynamicSourceApprover,
	type DynamicSourceDecision,
	type DynamicSupportHelperSpec,
	type DynamicWorkflowProposer,
	DynamicWorkflowProposerSchema,
} from "./dynamic/contracts.js";
import {
	createDynamicDiscoveredWorkflow,
	dynamicWorkflowForRecord,
} from "./dynamic/definition.js";
import { DynamicWorkflowExecutionError } from "./dynamic/execution-error.js";
import {
	deriveDynamicHostApiSha256,
	deriveDynamicImportPolicySha256,
} from "./dynamic/identity.js";
import {
	createDynamicWorkflowProposalRecord,
	type DynamicWorkflowProposal,
	DynamicWorkflowProposalStore,
	WorkflowDynamicStoreError,
	WorkflowDynamicStoreFullError,
} from "./dynamic/proposal-store.js";
import {
	DynamicRunDefinitionError,
	writeRunDefinitionCopy,
} from "./dynamic/run-definition.js";
import {
	assertDynamicSourceIntake,
	DynamicSourceIntakeError,
	dynamicRef,
	isDynamicRef,
	parseDynamicRef,
} from "./dynamic/source.js";
import { assertDynamicTransformerVersion } from "./dynamic/transformer-identity.js";
import {
	type DynamicVmBridgeOverrides,
	extractDynamicWorkflowManifest,
} from "./dynamic/vm-host.js";
import type {
	TaskExecutionProjection,
	WorkflowRunOrigin,
	WorkflowStateProjection,
} from "./events.js";
import {
	deriveCheckpointEffectSha256,
	deriveWorkflowHandoffDescriptor,
} from "./execution.js";
import {
	verifyWorkflowHandoffEvidence,
	WORKFLOW_HANDOFF_UNVERIFIED_MESSAGE,
} from "./handoff.js";
import { narrationSummary, taskNarration } from "./narration.js";
import {
	WorkflowNestedRunError,
	type WorkflowNestedRunLaunch,
	type WorkflowNestedRunProvider,
	type WorkflowNestedRunSettlement,
} from "./nested-run-executor.js";
import {
	readWorkflowJournalUnleased,
	type WorkflowJournalEvent,
	WorkflowRunJournal,
	type WorkflowRunJournalOpenOptions,
} from "./persistence/journal.js";
import {
	pruneWorkflowRuns,
	type WorkflowPruneCandidate,
	type WorkflowPruneReport,
} from "./persistence/retention.js";
import {
	acquireWorkflowRunLease,
	probeWorkflowRunLease,
	WorkflowPersistenceCorruptionError,
	type WorkflowRunLease,
	WorkflowRunLeaseUnavailableError,
} from "./persistence/run-lease.js";
import {
	invalidationClosure,
	reduceWorkflowEvents,
	WorkflowEventReductionError,
	type WorkflowInvalidationClosure,
} from "./reducer.js";
import type { DiscoveredWorkflow, WorkflowRoot } from "./registry.js";
import { discoverWorkflows } from "./registry.js";
import {
	admitsInvalidation,
	awaitsRecovery,
	deadlinePassed,
	hasOpenOperatorIntent,
	isNestedRun,
	isTerminalWorkflowRunStatus,
	OPERATOR_RESUME_REASON,
	resumableTasks,
	resumeRefusal,
	retryableTasks,
	type WorkflowRunOwnership,
} from "./run-actions.js";
import {
	compareRunSummaries,
	DEFAULT_INSPECT_SECTIONS,
	decodeWorkflowRunCursor,
	encodeWorkflowRunCursor,
	invalidationPreview,
	isCompletedWorktreeTask,
	pendingCheckpointViews,
	runInspection,
	runLogs,
	runSummary,
	taskViews,
} from "./run-projection.js";
import {
	type WorkflowRunRecord,
	WorkflowRunRecordError,
	WorkflowRunRecordStore,
} from "./run-record.js";
import type { ModelRoutingPort } from "./runtime/model-routing.js";
import {
	createWorkflowSequentialScheduler,
	WorkflowSchedulerError,
	type WorkflowSequentialScheduler,
} from "./scheduler.js";
import {
	MAX_WORKFLOW_RUN_LIST_ISSUES,
	MAX_WORKFLOW_RUN_PAGE_SIZE,
	type WorkflowBudgetProjection,
	type WorkflowDecideOptions,
	WorkflowDecideOptionsSchema,
	type WorkflowInspectOptions,
	WorkflowInspectOptionsSchema,
	type WorkflowInspectSection,
	type WorkflowInvalidationPreview,
	type WorkflowLogOptions,
	WorkflowLogOptionsSchema,
	type WorkflowLogPage,
	type WorkflowPruneOptions,
	WorkflowPruneOptionsSchema,
	type WorkflowReconciledExecution,
	type WorkflowReconcileOptions,
	type WorkflowResumeOptions,
	WorkflowResumeOptionsSchema,
	type WorkflowRunInspection,
	type WorkflowRunListIssue,
	type WorkflowRunObservation,
	type WorkflowRunPage,
	type WorkflowRunQuery,
	WorkflowRunQuerySchema,
	type WorkflowRunSummary,
	type WorkflowServiceReconcileView,
	type WorkflowServiceRunView,
	type WorkflowServiceTaskView,
	type WorkflowServiceWaitView,
	type WorkflowWaitOptions,
	WorkflowWaitOptionsSchema,
} from "./service-views.js";
import {
	createStaticWorkflowRuntime,
	isStaticWorkflowParked,
	type StaticWorkflowParkedResult,
} from "./static-runtime.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "./subagent-provider.js";
import {
	isValidSupportExportName,
	SUPPORT_EXPORT_NAME_INVALID_MESSAGE,
	type SupportTaskRegistration,
	supportRegistrationIdentity,
} from "./support.js";
import {
	createWorkflowTaskFinalizer,
	type WorkflowTaskFinalizer,
} from "./task-finalizer.js";
import { createWorkflowTaskLauncher } from "./task-launcher.js";

const addFormats = (addFormatsModule.default ??
	addFormatsModule) as unknown as FormatsPlugin;
export const DEFAULT_MAX_WORKFLOW_COST = 1_000;
export type WorkflowDefinitionSummary = {
	readonly name: string;
	readonly description: string;
	readonly version: number;
	readonly concurrency: number;
	readonly budget: WorkflowBudget;
	readonly timeoutMs: number;
	readonly scope: DiscoveredWorkflow["scope"];
	readonly source: string;
	readonly path: string;
	readonly identitySha256: string;
};

export type WorkflowValidationResult = {
	readonly valid: true;
	readonly workflow: WorkflowDefinitionSummary;
};

export type WorkflowServiceRunReceipt = {
	readonly runId: WorkflowRunId;
	readonly status: WorkflowRunStatus;
};

export type { DynamicWorkflowProposalView } from "./dynamic/approval.js";
export type {
	WorkflowServiceRunView,
	WorkflowServiceTaskView,
} from "./service-views.js";

export type DynamicWorkflowProposeOptions = {
	readonly proposer: DynamicWorkflowProposer;
};

/**
 * A human decision about a proposal. The service knows nothing about the UI:
 * `approver.kind` is `"human"` by schema and `via` names the command that
 * confirmed the decision; the record is written as `decidedBy: "human:<via>"`.
 */
export type DynamicSourceDecisionOptions = {
	readonly decision: DynamicSourceDecision;
	readonly approver: DynamicSourceApprover;
	readonly reason?: string;
};

/** `inspectProposal` is the only surface that returns the source text. */
export type DynamicWorkflowProposalInspection = DynamicWorkflowProposalView & {
	readonly source: string;
};

export type DynamicWorkflowProposalListing =
	| DynamicWorkflowProposalView
	| { readonly ref: `dynamic:${string}`; readonly issue: string };

export const DYNAMIC_TRUST_REQUIRED_MESSAGE =
	"Dynamic workflows require project trust.";
export const DYNAMIC_REF_INVALID_MESSAGE =
	"Invalid dynamic workflow reference.";
export const DYNAMIC_STORE_FULL_MESSAGE =
	"Dynamic workflow proposal store is full.";
export const DYNAMIC_STORE_CORRUPT_MESSAGE =
	"Dynamic workflow proposal store is corrupt.";

export type WorkflowRunListener = (observation: WorkflowRunObservation) => void;

export type WorkflowServiceHandoffExport = {
	readonly descriptor: WorkflowHandoffDescriptor;
	/** The verified `git format-patch` bytes the descriptor names. */
	readonly content: Buffer;
};

const NO_HANDOFF_ARTIFACT_MESSAGE = "Workflow task has no handoff artifact.";

/**
 * The one refusal a lease-free inspection raises for a decision record that
 * cannot be read, or whose value disagrees with the journalled digest.
 */
const CHECKPOINT_DECISION_UNVERIFIED_MESSAGE =
	"Checkpoint decision could not be read and verified.";

/**
 * The options `run` takes beyond the reference and the input. `origin` is
 * provenance only: it names a start the runtime can tell apart from an
 * ordinary `workflow_run` tool call or `/workflow run` command, and is
 * journalled on `run-created`. It changes nothing about how the run executes.
 */
export interface WorkflowServiceRunOptions {
	readonly origin?: WorkflowRunOrigin;
}

export interface WorkflowService {
	registerRoot(root: WorkflowRoot): Promise<void>;
	list(): Promise<readonly WorkflowDefinitionSummary[]>;
	validate(ref: string, input?: unknown): Promise<WorkflowValidationResult>;
	/**
	 * Lease-free budget projection of `ref` against `input` (spec 2.4): the
	 * definition is dry-materialized - its `run(ctx)` walks a context that
	 * declares nothing durable - and the declared reservations are summed and
	 * compared to the run's effective budget. No run, no lease, no journal
	 * append, so it is safe while other runs are live. Static refs only: a
	 * dynamic proposal's source is VM code and is never executed here.
	 */
	project(ref: string, input: unknown): Promise<WorkflowBudgetProjection>;
	/**
	 * Creates a durable run and returns its id; it does not drive it. With
	 * `options.origin`, the caller names how the start was decided and the
	 * value is recorded on `run-created` (see {@link WorkflowServiceRunOptions}).
	 */
	run(
		ref: string,
		input: unknown,
		options?: WorkflowServiceRunOptions,
	): Promise<WorkflowServiceRunReceipt>;
	status(runId: WorkflowRunId): Promise<WorkflowServiceRunView>;
	/**
	 * Drives the run to a durable terminal state. With `timeoutMs`, returns
	 * the current view marked `timedOut` when the drive outlives the timeout
	 * and leaves the drive running.
	 */
	wait(
		runId: WorkflowRunId,
		options?: WorkflowWaitOptions,
	): Promise<WorkflowServiceWaitView>;
	stop(runId: WorkflowRunId, reason: string): Promise<WorkflowServiceRunView>;
	/**
	 * Records an immutable operator decision for a checkpoint awaiting one and
	 * restarts the parked drive; the decision record is the durable evidence,
	 * the journal converges on it. Refused on nested runs and once the run's
	 * deadline has passed.
	 */
	decide(
		runId: WorkflowRunId,
		taskId: string,
		options: WorkflowDecideOptions,
	): Promise<WorkflowServiceRunView>;
	/**
	 * Invalidates a settled task and its transitive dependents on a durably
	 * failed or interrupted run, then restarts the drive so the invalidated
	 * work re-executes as new generations.
	 */
	invalidate(
		runId: WorkflowRunId,
		causeTaskId: string,
		reason: string,
	): Promise<WorkflowServiceRunView>;
	/**
	 * Reopens a run after restart or interruption and reconciles cleanup-blocked
	 * tasks: every on-path one in materialization order, or only `taskId`.
	 */
	reconcile(
		runId: WorkflowRunId,
		options?: WorkflowReconcileOptions,
	): Promise<WorkflowServiceReconcileView>;
	/**
	 * Exports the digest-verified handoff of a completed worktree agent task
	 * together with its descriptor. The workflow never applies, pushes, or
	 * merges the bytes; the caller owns what happens to them.
	 */
	exportHandoff(
		runId: WorkflowRunId,
		taskId: string,
	): Promise<WorkflowServiceHandoffExport>;
	/**
	 * Invalidation restricted to a cause task whose current execution ended
	 * failed or interrupted: the task and its dependents re-execute as new
	 * generations and the drive restarts.
	 */
	retry(
		runId: WorkflowRunId,
		taskId: WorkflowTaskId,
		reason: string,
	): Promise<WorkflowServiceRunView>;
	/**
	 * Re-attempts an interrupted agent task on its existing subagent run
	 * without invalidating dependents: journals an operator resume intent,
	 * reopens the interrupted run, and restarts the drive that performs it.
	 * Without `taskId` the run's single resumable task is selected.
	 */
	resume(
		runId: WorkflowRunId,
		reason: string,
		options?: WorkflowResumeOptions,
	): Promise<WorkflowServiceRunView>;
	shutdown(): Promise<void>;
	/**
	 * Proposes dynamic workflow TypeScript source: intake gate, manifest
	 * extraction in a manifest-only VM, and a proposal keyed by the source
	 * digest. Idempotent for a known digest; nothing is approved here.
	 */
	propose(
		source: string,
		options: DynamicWorkflowProposeOptions,
	): Promise<DynamicWorkflowProposalView>;
	/** One proposal with its source text; never a tool surface. */
	inspectProposal(ref: string): Promise<DynamicWorkflowProposalInspection>;
	/** Bounded scan of the proposal store; `list()` stays static-only. */
	proposals(): Promise<readonly DynamicWorkflowProposalListing[]>;
	/**
	 * Records the immutable human decision about a proposal bound to its
	 * definition identity. Refused once decided; a rejected digest can never
	 * be approved, only a changed source (new digest) can.
	 */
	decideSource(
		ref: string,
		options: DynamicSourceDecisionOptions,
	): Promise<DynamicWorkflowProposalView>;
	/** Lease-free scan of every durable run in the store, newest first. */
	listRuns(query?: WorkflowRunQuery): Promise<WorkflowRunPage>;
	/**
	 * Store-level retention, not a run action: moves every terminal, settled
	 * run (`completed`, `completed-degraded`, `failed`, `cancelled`) and its
	 * lease file into recoverable trash under `trash/<yyyymmdd-hhmmss>/`, so
	 * `listRuns` stops reporting it. Nothing is deleted and no journal is
	 * appended to; a run another live process leases is always refused, as is
	 * one still recoverable (`interrupted`, `cleanup-blocked`) or running.
	 * `dryRun` defaults to true and reports the selection without moving it.
	 */
	prune(options?: WorkflowPruneOptions): Promise<WorkflowPruneReport>;
	/** Lease-free bounded projection of one run; the `run` section always fits. */
	inspect(
		runId: WorkflowRunId,
		options?: WorkflowInspectOptions,
	): Promise<WorkflowRunInspection>;
	/** Lease-free redacted lifecycle log derived from the journal. */
	logs(
		runId: WorkflowRunId,
		options?: WorkflowLogOptions,
	): Promise<WorkflowLogPage>;
	/**
	 * Lease-free preview of `invalidate(runId, causeTaskId, …)`: the exact
	 * closure the reducer would admit, or the same reducer refusal invalidate
	 * would raise for the cause. Never appends and never judges the run's
	 * status, nesting, or deadline; that legality is `availableActions`.
	 */
	previewInvalidation(
		runId: WorkflowRunId,
		causeTaskId: WorkflowTaskId,
	): Promise<WorkflowInvalidationPreview>;
	/**
	 * Observes every append this service makes to an owned run's journal, in
	 * sequence order per run. Runs leased elsewhere never notify. Returns an
	 * idempotent unsubscribe.
	 */
	subscribe(listener: WorkflowRunListener): () => void;
}

export interface WorkflowServiceOptions {
	readonly cwd: string;
	readonly agentDir: string;
	readonly storeRoot: string;
	readonly projectTrusted: () => boolean;
	readonly subagents: WorkflowSubagentProvider;
	/**
	 * Package-provided definition roots present from the first discovery, the
	 * constructor form of `registerRoot`. Each root must use `package` or
	 * `builtin` scope; those roots are trusted by their installation source and
	 * load without Pi project trust. Unlike `registerRoot` this does not
	 * discover eagerly, so an embedder can register its own definitions without
	 * a trust prompt for the project's roots.
	 */
	readonly registeredRoots?: readonly WorkflowRoot[];
	readonly maxConcurrency?: number;
	readonly maxWorkflowCost?: number;
	readonly maxWorkflowTotalTokens?: number;
	readonly maxWorkflowChildRuntimeMs?: number;
	readonly maxWorkflowTimeoutMs?: number;
	readonly supportTasks?: readonly SupportTaskRegistration[];
	/**
	 * The host's router; a `modelRole` declaration resolves through it before
	 * hashing; without a router such a declaration fails materialization with
	 * "No model routing is installed; declare an exact model."
	 * `staticModelRouting(table)` from the runtime entry is the constant-table
	 * stand-in.
	 */
	readonly modelRouting?: ModelRoutingPort;
	/**
	 * Checkpoint policy: with `headless`, `use-explicit-default` checkpoints
	 * are decided from their default immediately and never park; `block`
	 * checkpoints park regardless. Default `{ headless: false }`.
	 */
	readonly checkpoints?: { readonly headless?: boolean };
	/**
	 * Dynamic VM watchdogs: lengthens the boot watchdog (manifest extraction
	 * and every run drive) and the compute watchdog for embedders and tests on
	 * slow hosts. Positive integers up to 2 147 483 647 ms; defaults to the
	 * production constants. Does not change `hostApiSha256`.
	 */
	readonly dynamic?: {
		readonly bootTimeoutMs?: number;
		readonly computeTimeoutMs?: number;
	};
}

const DYNAMIC_OPTIONS_INVALID_MESSAGE =
	"Workflow service dynamic options are invalid.";
/** `setTimeout`'s largest delay; the watchdogs are host timers. */
const MAX_DYNAMIC_WATCHDOG_MS = 2_147_483_647;
const DYNAMIC_OPTION_KEYS: ReadonlySet<string> = new Set([
	"bootTimeoutMs",
	"computeTimeoutMs",
]);

/**
 * Closed validation of the `dynamic` service option: only the two watchdog
 * fields pass, so `resourceLimits`, `syncWaitMs`, and `workerEntry` can never
 * reach the VM host through the service.
 */
function validateDynamicOptions(
	dynamic: WorkflowServiceOptions["dynamic"],
): DynamicVmBridgeOverrides | undefined {
	if (dynamic === undefined) return undefined;
	const invalid = new WorkflowServiceError(
		"validation",
		DYNAMIC_OPTIONS_INVALID_MESSAGE,
	);
	if (
		typeof dynamic !== "object" ||
		dynamic === null ||
		Array.isArray(dynamic) ||
		Object.keys(dynamic).some((key) => !DYNAMIC_OPTION_KEYS.has(key))
	) {
		throw invalid;
	}
	const overrides: {
		bootTimeoutMs?: number;
		computeTimeoutMs?: number;
	} = {};
	for (const key of ["bootTimeoutMs", "computeTimeoutMs"] as const) {
		const value = dynamic[key];
		if (value === undefined) continue;
		if (
			!Number.isSafeInteger(value) ||
			value < 1 ||
			value > MAX_DYNAMIC_WATCHDOG_MS
		) {
			throw invalid;
		}
		overrides[key] = value;
	}
	return Object.freeze(overrides);
}

export class WorkflowServiceError extends Error {
	constructor(
		readonly code:
			| "validation"
			| "not-found"
			| "conflict"
			| "persistence"
			| "execution",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "WorkflowServiceError";
	}
}

type OwnedRun = {
	record: WorkflowRunRecord;
	lease: WorkflowRunLease;
	journal: WorkflowRunJournal;
	artifacts: WorkflowArtifactStore;
	decisions: WorkflowDecisionRecordStore;
	binding: WorkflowSubagentBinding;
	scheduler: WorkflowSequentialScheduler;
	finalizer: WorkflowTaskFinalizer;
	drive: Promise<void>;
	/** Starts a new drive when the run is settled; otherwise the live drive. */
	restart(): Promise<void>;
	settled: boolean;
	view?: WorkflowServiceRunView;
	failure?: Error;
	/** Set while the last drive settled parked at one or more checkpoints. */
	parked?: StaticWorkflowParkedResult;
	/** Re-drives a parked run at its earliest checkpoint expiry or deadline. */
	watchdog?: NodeJS.Timeout;
	/** Resolves when the run next starts a drive or is stopped while parked. */
	nextChange(): Promise<void>;
	wake(): void;
};

function summary(workflow: DiscoveredWorkflow): WorkflowDefinitionSummary {
	return Object.freeze({
		name: workflow.definition.meta.name,
		description: workflow.definition.meta.description,
		version: workflow.definition.meta.version,
		concurrency: workflow.definition.meta.concurrency,
		budget: Object.freeze({ ...workflow.definition.meta.budget }),
		timeoutMs: workflow.definition.meta.timeoutMs,
		scope: workflow.scope,
		source: workflow.source,
		path: workflow.path,
		identitySha256: workflow.identity.identitySha256,
	});
}

function validateInput(workflow: DiscoveredWorkflow, input: unknown): void {
	const ajv = new Ajv({ allErrors: true, strict: true, validateSchema: true });
	addFormats(ajv);
	let valid: boolean;
	try {
		valid = ajv.validate(workflow.definition.inputSchema, input);
	} catch (error) {
		throw new WorkflowServiceError(
			"validation",
			"Workflow input schema could not be evaluated.",
			{ cause: error },
		);
	}
	if (!valid) {
		throw new WorkflowServiceError(
			"validation",
			"Workflow input does not match its schema.",
		);
	}
	try {
		const json = JSON.stringify(input);
		if (
			json === undefined ||
			Buffer.byteLength(json) > 900 * 1024 ||
			!isDeepStrictEqual(input, JSON.parse(json))
		) {
			throw new Error("input is not lossless JSON");
		}
	} catch (error) {
		throw new WorkflowServiceError(
			"validation",
			"Workflow input is not bounded JSON.",
			{ cause: error },
		);
	}
}

/**
 * Names the pending recovery that blocks a new operator action on a durably
 * failed or interrupted run: invalidated on-path work, or (when no such work
 * exists) an operator resume intent the next drive still has to perform.
 */
function recoveryRefusal(state: WorkflowStateProjection): WorkflowServiceError {
	const invalidated = Object.values(state.tasks).some(
		(task) => task.status === "invalidated" && task.abandoned !== true,
	);
	return new WorkflowServiceError(
		"validation",
		invalidated || !hasOpenOperatorIntent(state)
			? "Workflow run already awaits recovery of invalidated work."
			: "Workflow run already awaits recovery of an operator resume.",
	);
}

function runId(): WorkflowRunId {
	return `workflow_${randomUUID().replaceAll("-", "")}`;
}

const DECISION_PERSISTENCE_MESSAGE =
	"Checkpoint decision could not be recorded.";

/**
 * Maps a `decide` failure to the service surface. Executor refusals at the
 * validation and decision stages are `validation` with the executor's own
 * message; its input and persistence stages keep their fixed message under
 * `persistence`; store corruption passes through; everything else (a decision
 * record that fails verification, a reducer rejection, a fenced lease, an
 * unexpected error) is `persistence` with one fixed message and the cause.
 */
function decisionRejection(error: unknown): unknown {
	if (
		error instanceof WorkflowServiceError ||
		error instanceof WorkflowPersistenceCorruptionError
	) {
		return error;
	}
	if (error instanceof WorkflowCheckpointExecutionError) {
		return new WorkflowServiceError(
			error.stage === "validation" || error.stage === "decision"
				? "validation"
				: "persistence",
			error.message,
			{ cause: error },
		);
	}
	if (error instanceof WorkflowSchedulerError && error.stage === "validation") {
		return new WorkflowServiceError("validation", error.message, {
			cause: error,
		});
	}
	return new WorkflowServiceError("persistence", DECISION_PERSISTENCE_MESSAGE, {
		cause: error,
	});
}

/**
 * Surfaces a reducer or closure failure as a validation error carrying the
 * reducer's own message. The journal wraps reducer failures as the cause of an
 * invariant error, so that wrapper is unwrapped first.
 */
function reducerRejection(error: unknown): WorkflowServiceError {
	const cause =
		error instanceof Error && error.cause instanceof WorkflowEventReductionError
			? error.cause
			: error;
	if (cause instanceof Error) {
		return new WorkflowServiceError("validation", cause.message, { cause });
	}
	return new WorkflowServiceError(
		"validation",
		"Workflow operator action was rejected.",
		{ cause },
	);
}

/** Appends an operator event and surfaces a reducer refusal as validation. */
async function appendOperatorEvent(
	journal: WorkflowRunJournal,
	input: Parameters<WorkflowRunJournal["appendEvent"]>[0],
): Promise<void> {
	try {
		await journal.appendEvent(input);
	} catch (error) {
		if (
			error instanceof Error &&
			error.cause instanceof WorkflowEventReductionError
		) {
			throw reducerRejection(error);
		}
		throw error;
	}
}

function assertReason(
	reason: unknown,
	message: string,
): asserts reason is string {
	if (typeof reason !== "string" || reason.length < 1 || reason.length > 4096) {
		throw new WorkflowServiceError("validation", message);
	}
}

function assertRunId(runIdValue: unknown): asserts runIdValue is WorkflowRunId {
	if (!Value.Check(WorkflowRunIdSchema, runIdValue)) {
		throw new WorkflowServiceError("validation", "Invalid workflow run ID.");
	}
}

function assertTaskId(taskId: unknown): asserts taskId is WorkflowTaskId {
	if (!Value.Check(WorkflowTaskIdSchema, taskId)) {
		throw new WorkflowServiceError("validation", "Invalid workflow task ID.");
	}
}

export async function createWorkflowService(
	options: WorkflowServiceOptions,
): Promise<WorkflowService> {
	const maxConcurrency = options.maxConcurrency ?? MAX_WORKFLOW_CONCURRENCY;
	if (
		!Number.isSafeInteger(maxConcurrency) ||
		maxConcurrency < 1 ||
		maxConcurrency > MAX_WORKFLOW_CONCURRENCY
	) {
		throw new WorkflowServiceError(
			"validation",
			"Workflow service concurrency limit is invalid.",
		);
	}
	const maxWorkflowCost = options.maxWorkflowCost ?? DEFAULT_MAX_WORKFLOW_COST;
	const maxWorkflowTotalTokens = options.maxWorkflowTotalTokens;
	const maxWorkflowChildRuntimeMs = options.maxWorkflowChildRuntimeMs;
	const maxWorkflowTimeoutMs = options.maxWorkflowTimeoutMs;
	if (!Number.isFinite(maxWorkflowCost) || maxWorkflowCost < 0) {
		throw new WorkflowServiceError(
			"validation",
			"Workflow service cost limit is invalid.",
		);
	}
	for (const [name, value, minimum] of [
		["total-token", maxWorkflowTotalTokens, 1],
		["child-runtime", maxWorkflowChildRuntimeMs, 1_000],
		["timeout", maxWorkflowTimeoutMs, 1_000],
	] as const) {
		if (
			value !== undefined &&
			(!Number.isSafeInteger(value) || value < minimum)
		) {
			throw new WorkflowServiceError(
				"validation",
				`Workflow service ${name} limit is invalid.`,
			);
		}
	}
	assertDynamicTransformerVersion();
	const supportTasks = new Map<string, SupportTaskRegistration>();
	const supportExports = new Set<string>();
	if (
		options.checkpoints !== undefined &&
		(typeof options.checkpoints !== "object" ||
			options.checkpoints === null ||
			(options.checkpoints.headless !== undefined &&
				typeof options.checkpoints.headless !== "boolean"))
	) {
		throw new WorkflowServiceError(
			"validation",
			"Workflow service checkpoint options are invalid.",
		);
	}
	const headless = options.checkpoints?.headless ?? false;
	const dynamicOverrides = validateDynamicOptions(options.dynamic);
	for (const registration of options.supportTasks ?? []) {
		if (typeof registration.execute !== "function") {
			throw new WorkflowServiceError(
				"validation",
				"Support task implementation is not executable.",
			);
		}
		supportRegistrationIdentity(registration);
		if (supportTasks.has(registration.name)) {
			throw new WorkflowServiceError(
				"conflict",
				`Duplicate support task implementation: ${registration.name}`,
			);
		}
		if (registration.exportName !== undefined) {
			if (
				typeof registration.exportName !== "string" ||
				!isValidSupportExportName(registration.exportName)
			) {
				throw new WorkflowServiceError(
					"validation",
					SUPPORT_EXPORT_NAME_INVALID_MESSAGE,
				);
			}
			const exported = `${registration.moduleSpecifier}#${registration.exportName}`;
			if (supportExports.has(exported)) {
				throw new WorkflowServiceError(
					"conflict",
					`Duplicate support task export name: ${exported}`,
				);
			}
			supportExports.add(exported);
		}
		supportTasks.set(
			registration.name,
			Object.freeze({
				...registration,
				parametersSchema: validateJsonSchemaDocument(
					registration.parametersSchema,
					"support registration parameters schema",
				),
				outputSchema: validateJsonSchemaDocument(
					registration.outputSchema,
					"support registration output schema",
				),
			}),
		);
	}
	/**
	 * The registered helpers dynamic sources may import (spec 10): frozen,
	 * structured-clone-safe, sorted by module specifier and export name so the
	 * import policy digest is order-independent of registration order.
	 */
	const supportHelpers: readonly DynamicSupportHelperSpec[] = Object.freeze(
		[...supportTasks.values()]
			.filter(
				(
					registration,
				): registration is SupportTaskRegistration & {
					readonly exportName: string;
				} => registration.exportName !== undefined,
			)
			.map(
				(registration) =>
					Object.freeze({
						name: registration.name,
						moduleSpecifier: registration.moduleSpecifier,
						revision: registration.revision,
						implementationSha256: registration.implementationSha256,
						parametersSchema: structuredClone(registration.parametersSchema),
						outputSchema: structuredClone(registration.outputSchema),
						exportName: registration.exportName,
					}) as DynamicSupportHelperSpec,
			)
			.sort((a, b) =>
				`${a.moduleSpecifier} ${a.exportName}`.localeCompare(
					`${b.moduleSpecifier} ${b.exportName}`,
				),
			),
	);
	const cwd = await realpath(options.cwd);
	const storeRoot = path.resolve(options.storeRoot);
	let proposalStore: Promise<DynamicWorkflowProposalStore> | undefined;
	const roots: WorkflowRoot[] = [];
	for (const root of options.registeredRoots ?? []) {
		if (root.scope !== "package" && root.scope !== "builtin") {
			throw new WorkflowServiceError(
				"validation",
				"Registered roots must be package or builtin scope.",
			);
		}
		roots.push(Object.freeze({ ...root }));
	}
	const owned = new Map<WorkflowRunId, OwnedRun>();
	const instanceId = randomUUID();
	const listeners = new Set<WorkflowRunListener>();
	let closed = false;
	let tail = Promise.resolve();

	function emit(observation: WorkflowRunObservation): void {
		for (const listener of [...listeners]) {
			try {
				listener(observation);
			} catch {
				// A listener failure never reaches the journal or other listeners.
			}
		}
	}

	function journalOptions(
		runIdValue: WorkflowRunId,
	): WorkflowRunJournalOpenOptions {
		return {
			onAppended: ({ event, status, task }) =>
				emit(
					Object.freeze({
						runId: runIdValue,
						status,
						sequence: event.sequence,
						// Present only on the append that settled a task. The narration
						// is derived from the key, so it reads no file and the
						// observation stays a synchronous notice in sequence order; the
						// summary of the task's result is artifact-backed and belongs to
						// `inspect(runId, {include: [..., "output"]})`.
						...(task
							? {
									task: Object.freeze({
										taskId: task.taskId as WorkflowTaskId,
										status: task.status,
										...(task.outcome === undefined
											? {}
											: { outcome: task.outcome }),
										narration: taskNarration({
											namespace: task.namespace,
											key: task.key,
											kind: task.kind,
											...(task.cause === undefined
												? {}
												: { cause: task.cause }),
										}),
									}),
								}
							: {}),
					}),
				),
		};
	}

	function exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const result = tail.then(operation);
		tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	function assertOpen(): void {
		if (closed) {
			throw new WorkflowServiceError("conflict", "Workflow service is closed.");
		}
	}

	/** D10: dynamic source is untrusted orchestration input in a trusted process. */
	function assertDynamicTrusted(): void {
		if (!options.projectTrusted()) {
			throw new WorkflowServiceError(
				"validation",
				DYNAMIC_TRUST_REQUIRED_MESSAGE,
			);
		}
	}

	/** Opened on first dynamic use; a failed open is retried by the next call. */
	function openProposalStore(): Promise<DynamicWorkflowProposalStore> {
		proposalStore ??= DynamicWorkflowProposalStore.open({ storeRoot }).catch(
			(error: unknown) => {
				proposalStore = undefined;
				throw error;
			},
		);
		return proposalStore;
	}

	/**
	 * Maps the dynamic modules' refusals to service errors: intake, approval,
	 * and run-copy errors carry their own code and final message; a full store
	 * is a conflict; any other store failure is corruption.
	 */
	function dynamicFailure(error: unknown): unknown {
		if (
			error instanceof DynamicSourceIntakeError ||
			error instanceof DynamicWorkflowApprovalError ||
			error instanceof DynamicRunDefinitionError
		) {
			return new WorkflowServiceError(error.code, error.message, {
				cause: error,
			});
		}
		if (error instanceof WorkflowDynamicStoreFullError) {
			return new WorkflowServiceError("conflict", DYNAMIC_STORE_FULL_MESSAGE, {
				cause: error,
			});
		}
		if (error instanceof WorkflowDynamicStoreError) {
			return new WorkflowServiceError(
				"persistence",
				DYNAMIC_STORE_CORRUPT_MESSAGE,
				{ cause: error },
			);
		}
		if (error instanceof WorkflowDecisionRecordError) {
			return new WorkflowServiceError("persistence", MSG_APPROVAL_INVALID, {
				cause: error,
			});
		}
		return error;
	}

	function parseDynamicReference(ref: string): string {
		const sourceSha256 = parseDynamicRef(ref);
		if (sourceSha256 === undefined) {
			throw new WorkflowServiceError("validation", DYNAMIC_REF_INVALID_MESSAGE);
		}
		return sourceSha256;
	}

	async function readProposal(
		sourceSha256: string,
	): Promise<DynamicWorkflowProposal> {
		const proposal = await (await openProposalStore()).read(sourceSha256);
		if (proposal === undefined) {
			throw new WorkflowServiceError(
				"not-found",
				MSG_PROPOSAL_NOT_FOUND(sourceSha256),
			);
		}
		return proposal;
	}

	function proposalView(
		proposal: DynamicWorkflowProposal,
		approval: DynamicSourceApprovalRecord | undefined,
	): DynamicWorkflowProposalView {
		return toDynamicWorkflowProposalView({
			proposal,
			approval,
			hostApiSha256: deriveDynamicHostApiSha256(),
			importPolicySha256: deriveDynamicImportPolicySha256(supportHelpers),
		});
	}

	/**
	 * `run`/`validate` steps 1-5 for a `dynamic:` reference: the proposal must
	 * be current for this project and carry an approval that matches it.
	 */
	async function dynamicRunnable(ref: string): Promise<{
		readonly proposal: DynamicWorkflowProposal;
		readonly approval: DynamicSourceApprovalRecord;
		readonly hostApiSha256: string;
	}> {
		assertDynamicTrusted();
		const sourceSha256 = parseDynamicReference(ref);
		try {
			const proposal = await readProposal(sourceSha256);
			const hostApiSha256 = deriveDynamicHostApiSha256();
			const approval = assertDynamicSourceRunnable({
				proposal: proposal.record,
				approval: await readSourceApproval(proposal),
				cwd,
				hostApiSha256,
				importPolicySha256: deriveDynamicImportPolicySha256(supportHelpers),
			});
			return { proposal, approval, hostApiSha256 };
		} catch (error) {
			throw dynamicFailure(error);
		}
	}

	/** The `DiscoveredWorkflow` of a runnable proposal (spec 5.4). */
	function dynamicWorkflow(
		proposal: DynamicWorkflowProposal,
		createdAt: string,
	): DiscoveredWorkflow {
		return createDynamicDiscoveredWorkflow({
			proposal: proposal.record,
			source: proposal.source,
			supportHelpers,
			createdAt,
			path: proposal.path,
			...(dynamicOverrides === undefined ? {} : { bridge: dynamicOverrides }),
		});
	}

	async function discover(): Promise<readonly DiscoveredWorkflow[]> {
		assertOpen();
		return discoverWorkflows({
			cwd,
			agentDir: options.agentDir,
			projectTrusted: options.projectTrusted(),
			registeredRoots: roots,
			allowedSupportImports: [
				...new Set(
					[...supportTasks.values()].map(
						(registration) => registration.moduleSpecifier,
					),
				),
			],
		});
	}

	async function resolve(ref: string): Promise<DiscoveredWorkflow> {
		return resolveAmong(await discover(), ref);
	}

	/** `ref` (a workflow name or definition path) among one discovery's result. */
	function resolveAmong(
		workflows: readonly DiscoveredWorkflow[],
		ref: string,
	): DiscoveredWorkflow {
		if (!ref || ref.length > 4096) {
			throw new WorkflowServiceError(
				"validation",
				"Invalid workflow reference.",
			);
		}
		const matches = workflows.filter(
			(workflow) =>
				workflow.definition.meta.name === ref || workflow.path === ref,
		);
		if (matches.length !== 1) {
			throw new WorkflowServiceError(
				matches.length === 0 ? "not-found" : "conflict",
				matches.length === 0
					? `Workflow not found: ${ref}`
					: `Workflow reference is ambiguous: ${ref}`,
			);
		}
		return matches[0] as DiscoveredWorkflow;
	}

	function effectiveLimits(workflow: DiscoveredWorkflow): {
		declaredBudget: WorkflowBudget;
		effectiveBudget: WorkflowBudget;
		declaredTimeoutMs: number;
		effectiveTimeoutMs: number;
	} {
		const declared = workflow.definition.meta.budget;
		const effectiveTotalTokens =
			declared.totalTokens === undefined
				? maxWorkflowTotalTokens
				: maxWorkflowTotalTokens === undefined
					? declared.totalTokens
					: Math.min(declared.totalTokens, maxWorkflowTotalTokens);
		return {
			declaredBudget: structuredClone(declared),
			effectiveBudget: {
				cost: Math.min(declared.cost, maxWorkflowCost),
				childRuntimeMs: Math.min(
					declared.childRuntimeMs,
					maxWorkflowChildRuntimeMs ?? declared.childRuntimeMs,
				),
				...(effectiveTotalTokens === undefined
					? {}
					: { totalTokens: effectiveTotalTokens }),
			},
			declaredTimeoutMs: workflow.definition.meta.timeoutMs,
			effectiveTimeoutMs: Math.min(
				workflow.definition.meta.timeoutMs,
				maxWorkflowTimeoutMs ?? workflow.definition.meta.timeoutMs,
			),
		};
	}

	/**
	 * `discovered` is the discovery that resolved `workflow` (or, for a dynamic
	 * run, the one made for it): nested runs resolve their definitions by name
	 * from it, so one `run`, `resume`, or nested launch discovers once.
	 */
	/**
	 * The agent definitions that travel with a definition's root: `<root>/agents`
	 * when it exists and is a real directory. A root holds `*.workflow.*`
	 * definitions only, so the templates a definition names live beside them and
	 * reach pi-subagent as the request's own agent roots instead of having to be
	 * copied into a host's agent directory first. Project roots are included on
	 * the same terms, and a project's own `.pi/agents` still wins: pi-subagent
	 * consults a request root only for a name its own discovery does not define.
	 */
	async function agentRootsFor(
		workflow: DiscoveredWorkflow,
	): Promise<readonly string[]> {
		// A dynamic definition's root is the proposal store, not a definition
		// root a package or project curates; it ships no templates.
		if (workflow.scope === "dynamic") return [];
		if (!path.isAbsolute(workflow.root)) return [];
		const directory = path.join(workflow.root, "agents");
		try {
			if (!(await lstat(directory)).isDirectory()) return [];
			return [await realpath(directory)];
		} catch {
			return [];
		}
	}

	async function compose(
		record: WorkflowRunRecord,
		workflow: DiscoveredWorkflow,
		lease: WorkflowRunLease,
		binding: WorkflowSubagentBinding,
		discovered: readonly DiscoveredWorkflow[],
		origin?: WorkflowRunOrigin,
	): Promise<OwnedRun> {
		const journal = await WorkflowRunJournal.open(
			storeRoot,
			record.runId,
			lease,
			journalOptions(record.runId),
		);
		const artifacts = await WorkflowArtifactStore.open({ journal });
		const decisions = await WorkflowDecisionRecordStore.open({ journal });
		const byName = new Map(
			discovered.map((candidate) => [
				candidate.definition.meta.name,
				candidate,
			]),
		);
		const nesting = Object.freeze({
			depth: record.depth,
			ancestorDefinitionIdentities: Object.freeze([
				...(record.parent?.ancestorDefinitionIdentities ?? []),
			]),
			definitionIdentitySha256: record.definitionIdentitySha256,
			deadlineAt: record.deadlineAt,
		});
		const agentRoots = await agentRootsFor(workflow);
		const launcher = createWorkflowTaskLauncher({
			journal,
			binding,
			artifacts,
			...(agentRoots.length === 0 ? {} : { agentRoots }),
		});
		const finalizer = createWorkflowTaskFinalizer({
			journal,
			binding,
			artifacts,
		});
		const scheduler = createWorkflowSequentialScheduler({
			journal,
			binding,
			launcher,
			finalizer,
			artifacts,
			supportTasks,
			decisions,
			checkpoints: { headless },
			nestedRuns: nestedProvider,
			nesting,
			concurrency: record.concurrency,
			budget: record.effectiveBudget,
		});
		const waiters = new Set<() => void>();
		const ownedRun: OwnedRun = {
			record,
			lease,
			journal,
			artifacts,
			decisions,
			binding,
			scheduler,
			finalizer,
			drive: Promise.resolve(),
			restart: async () => undefined,
			settled: false,
			nextChange: () =>
				new Promise<void>((resolve) => {
					waiters.add(resolve);
				}),
			wake: () => {
				const pending = [...waiters];
				waiters.clear();
				for (const resolve of pending) resolve();
			},
		};
		const startDrive = () => {
			ownedRun.settled = false;
			delete ownedRun.failure;
			delete ownedRun.view;
			delete ownedRun.parked;
			if (ownedRun.watchdog) clearTimeout(ownedRun.watchdog);
			delete ownedRun.watchdog;
			ownedRun.wake();
			const controller = new AbortController();
			// Durable stop intent (explicit stop, shutdown, or deadline) aborts the
			// workflow signal so trusted source awaiting ctx.signal can unwind.
			const onStop = () => {
				if (!controller.signal.aborted) {
					controller.abort(new Error("Workflow stop requested."));
				}
			};
			if (scheduler.stopSignal.aborted) onStop();
			else
				scheduler.stopSignal.addEventListener("abort", onStop, { once: true });
			const runtime = createStaticWorkflowRuntime({
				definition: workflow.definition,
				definitionIdentitySha256: workflow.identity.identitySha256,
				input: record.input,
				cwd: record.cwd,
				journal,
				artifacts,
				scheduler,
				signal: controller.signal,
				...(origin === undefined ? {} : { origin }),
				...(options.modelRouting === undefined
					? {}
					: { modelRouting: options.modelRouting }),
				nesting: {
					depth: nesting.depth,
					ancestorDefinitionIdentities: nesting.ancestorDefinitionIdentities,
					resolveWorkflow: (name: string) => byName.get(name),
				},
			});
			let deadlineTimer: NodeJS.Timeout | undefined;
			let deadlineSettled = false;
			const deadline = new Promise<void>((resolve, reject) => {
				const check = () => {
					const remaining = Date.parse(record.deadlineAt) - Date.now();
					if (remaining > 0) {
						deadlineTimer = setTimeout(
							check,
							Math.min(remaining, 2_147_483_647),
						);
						deadlineTimer.unref();
						return;
					}
					void scheduler.stop("Workflow deadline exceeded.").then(
						() => {
							controller.abort(new Error("Workflow deadline exceeded."));
							deadlineSettled = true;
							resolve();
						},
						(error: unknown) => {
							controller.abort(error);
							deadlineSettled = true;
							reject(error);
						},
					);
				};
				check();
			});
			const execution = Promise.resolve()
				.then(() => runtime.drive())
				.then((result) => {
					// Parking is a resolved drive result, never a failure: the run
					// stays `waiting` with its lease held until decided, expired,
					// stopped, or resumed elsewhere after shutdown.
					if (isStaticWorkflowParked(result)) ownedRun.parked = result;
				});
			void execution.catch(() => undefined);
			ownedRun.drive = Promise.race([execution, deadline])
				.catch((error: unknown) => {
					ownedRun.failure =
						error instanceof Error
							? error
							: new Error("unknown workflow failure");
				})
				.finally(async () => {
					scheduler.stopSignal.removeEventListener("abort", onStop);
					if (deadlineTimer) clearTimeout(deadlineTimer);
					if (!deadlineSettled) controller.abort();
					try {
						ownedRun.view = await viewFrom(record, journal, artifacts);
					} catch (error) {
						ownedRun.failure ??=
							error instanceof Error
								? error
								: new Error("workflow projection failed");
					} finally {
						ownedRun.settled = true;
					}
					if (ownedRun.parked && !closed) {
						if ((ownedRun.view?.pendingCheckpoints ?? []).length === 0) {
							// The park was decided from under the drive (a decision landed
							// while another lane was busy): nothing waits, so re-drive.
							void ownedRun.restart();
						} else {
							armParkedWatchdog(ownedRun);
						}
					}
				});
			return ownedRun.drive;
		};
		ownedRun.restart = () => (ownedRun.settled ? startDrive() : ownedRun.drive);
		startDrive();
		return ownedRun;
	}

	/**
	 * A parked run re-drives itself at the earliest pending checkpoint expiry
	 * or at the run deadline, whichever comes first: the restarted drive's
	 * sweep expires or defaults the checkpoint, and the deadline race stops the
	 * run. Bounded to the timer maximum; cleared by every restart and stop.
	 */
	function armParkedWatchdog(run: OwnedRun): void {
		const pending = run.parked?.pendingCheckpoints ?? [];
		const at = Math.min(
			Date.parse(run.record.deadlineAt),
			...pending.flatMap((checkpoint) =>
				checkpoint.expiresAt ? [Date.parse(checkpoint.expiresAt)] : [],
			),
		);
		const delay = Math.min(Math.max(0, at - Date.now()), 2_147_483_647);
		run.watchdog = setTimeout(() => {
			delete run.watchdog;
			if (!closed && run.settled && run.parked) void run.restart();
		}, delay);
		run.watchdog.unref();
	}

	/** A parked run whose deadline or a pending checkpoint expiry has passed. */
	function parkExpired(run: OwnedRun, now: number): boolean {
		if (!run.parked) return false;
		return (
			deadlinePassed(run.record.deadlineAt, now) ||
			run.parked.pendingCheckpoints.some(
				(checkpoint) =>
					checkpoint.expiresAt !== undefined &&
					Date.parse(checkpoint.expiresAt) <= now,
			)
		);
	}

	/**
	 * Stops a settled parked run in place: the scheduler cancels its open
	 * checkpoints and lands `cancelled`; a stop the scheduler left non-terminal
	 * is drained by a restarted drive. Waiters on the run are woken.
	 */
	async function stopParked(run: OwnedRun, reason: string): Promise<void> {
		if (run.watchdog) clearTimeout(run.watchdog);
		delete run.watchdog;
		await run.scheduler.stop(reason);
		delete run.view;
		const state = await run.journal.readState();
		if (!isTerminalWorkflowRunStatus(state.status)) {
			await run.restart();
			return;
		}
		delete run.parked;
		run.wake();
	}

	async function workflowForRecord(
		record: WorkflowRunRecord,
		journal: WorkflowRunJournal,
		discovered: readonly DiscoveredWorkflow[],
	): Promise<DiscoveredWorkflow> {
		if (record.definitionKind === "dynamic") {
			// The run directory copy is the only evidence consulted; the proposal
			// and decision stores are never read on resume (spec 5.4).
			assertDynamicTrusted();
			if (
				record.approvalSha256 === undefined ||
				record.hostApiSha256 === undefined
			) {
				throw new WorkflowServiceError(
					"persistence",
					"Workflow run record is invalid.",
				);
			}
			try {
				return await dynamicWorkflowForRecord({
					record: {
						cwd: record.cwd,
						createdAt: record.createdAt,
						definitionPath: record.definitionPath,
						definitionIdentitySha256: record.definitionIdentitySha256,
						definitionSourceSha256: record.definitionSourceSha256,
						approvalSha256: record.approvalSha256,
						hostApiSha256: record.hostApiSha256,
					},
					journal,
					cwd,
					supportHelpers,
					...(dynamicOverrides === undefined
						? {}
						: { bridge: dynamicOverrides }),
				});
			} catch (error) {
				throw dynamicFailure(error);
			}
		}
		const workflow = resolveAmong(discovered, record.definitionPath);
		if (
			workflow.definition.meta.name !== record.definitionName ||
			workflow.identity.identitySha256 !== record.definitionIdentitySha256 ||
			workflow.identity.sourceSha256 !== record.definitionSourceSha256 ||
			workflow.path !== record.definitionPath ||
			!isDeepStrictEqual(
				workflow.definition.meta.budget,
				record.declaredBudget,
			) ||
			workflow.definition.meta.timeoutMs !== record.declaredTimeoutMs ||
			cwd !== record.cwd
		) {
			throw new WorkflowServiceError(
				"validation",
				"Workflow definition, source, or project identity changed.",
			);
		}
		return workflow;
	}

	async function openInactive(runIdValue: WorkflowRunId): Promise<{
		lease: WorkflowRunLease;
		journal: WorkflowRunJournal;
		record: WorkflowRunRecord;
	}> {
		const directory = path.join(storeRoot, "runs", runIdValue);
		try {
			const metadata = await lstat(directory);
			if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
				throw new WorkflowServiceError(
					"persistence",
					"Workflow run directory is invalid.",
				);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new WorkflowServiceError(
					"not-found",
					`Workflow run not found: ${runIdValue}`,
				);
			}
			throw error;
		}
		let lease: WorkflowRunLease;
		try {
			lease = await acquireWorkflowRunLease({
				storeRoot,
				runId: runIdValue,
				ownerId: `pi-workflow-service:${instanceId}`,
			});
		} catch (error) {
			if (error instanceof WorkflowRunLeaseUnavailableError) {
				throw new WorkflowServiceError(
					"conflict",
					"Workflow run is owned by another live service.",
					{ cause: error },
				);
			}
			if (error instanceof WorkflowPersistenceCorruptionError) throw error;
			throw new WorkflowServiceError(
				"persistence",
				"Workflow run lease could not be acquired.",
				{ cause: error },
			);
		}
		try {
			const journal = await WorkflowRunJournal.open(
				storeRoot,
				runIdValue,
				lease,
			);
			const record = await WorkflowRunRecordStore.open(journal).read();
			return { lease, journal, record };
		} catch (error) {
			await lease.release();
			throw error;
		}
	}

	/**
	 * The durable state of a run, `undefined` before its first event. The
	 * journal file is read and verified on every call; the projection resumes
	 * from the journal's last reduction instead of replaying every event.
	 */
	async function stateFrom(
		journal: WorkflowRunJournal,
	): Promise<WorkflowStateProjection | undefined> {
		return (await journal.readProjected()).state;
	}

	async function viewFrom(
		record: WorkflowRunRecord,
		journal: WorkflowRunJournal,
		artifacts?: WorkflowArtifactStore,
	): Promise<WorkflowServiceRunView> {
		return viewFromState(record, await stateFrom(journal), artifacts);
	}

	async function viewFromState(
		record: WorkflowRunRecord,
		state: WorkflowStateProjection | undefined,
		artifacts?: WorkflowArtifactStore,
	): Promise<WorkflowServiceRunView> {
		if (state === undefined) {
			return Object.freeze({
				runId: record.runId,
				status: "created" as const,
				definitionName: record.definitionName,
				createdAt: record.createdAt,
				deadlineAt: record.deadlineAt,
				depth: record.depth,
				...lineageOf(record),
				...dynamicOf(record),
			});
		}
		let output: unknown;
		if (state.outputArtifactId && artifacts) {
			const artifact = state.artifacts[state.outputArtifactId];
			if (!artifact) {
				throw new WorkflowServiceError(
					"persistence",
					"Workflow output artifact metadata is missing.",
				);
			}
			output = await artifacts.readJson(artifact);
		}
		const tasks = artifacts
			? await checkpointBackedTaskViews(state, artifacts)
			: taskViews(state);
		return Object.freeze({
			runId: record.runId,
			status: state.status,
			definitionName: record.definitionName,
			createdAt: record.createdAt,
			deadlineAt: record.deadlineAt,
			depth: record.depth,
			...lineageOf(record),
			...dynamicOf(record),
			...(state.outputArtifactId
				? { outputArtifactId: state.outputArtifactId }
				: {}),
			...(output === undefined ? {} : { output }),
			tasks,
			pendingCheckpoints: pendingCheckpointViews(state, {
				inputs: checkpointInputsByTask(tasks),
			}),
		});
	}

	/**
	 * The verified checkpoint inputs the artifact-backed task views carry, by
	 * task id, so the pending-checkpoint views render the same values the
	 * approver reads. Lease-free views carry none and the map stays empty.
	 */
	function checkpointInputsByTask(
		tasks: readonly WorkflowServiceTaskView[],
	): ReadonlyMap<WorkflowTaskId, Readonly<Record<string, unknown>>> {
		const inputs = new Map<WorkflowTaskId, Readonly<Record<string, unknown>>>();
		for (const task of tasks) {
			if (task.checkpoint?.inputs) inputs.set(task.id, task.checkpoint.inputs);
		}
		return inputs;
	}

	/**
	 * Task views with the artifact-backed checkpoint facts (C13): the verified
	 * input values the approver sees and the recorded decision value. Handoff
	 * inputs appear as descriptors; lease-free views omit both.
	 */
	async function checkpointBackedTaskViews(
		state: WorkflowStateProjection,
		artifacts: WorkflowArtifactStore,
	): Promise<readonly WorkflowServiceTaskView[]> {
		const views = taskViews(state);
		if (!views.some((view) => view.checkpoint)) return views;
		return Object.freeze(
			await Promise.all(
				views.map(async (view) => {
					const projected = state.tasks[view.id];
					const execution = projected?.currentExecutionId
						? state.executions[projected.currentExecutionId]
						: undefined;
					if (
						!view.checkpoint ||
						!projected ||
						projected.abandoned === true ||
						execution?.checkpointRequest === undefined
					) {
						return view;
					}
					let inputs: Readonly<Record<string, unknown>>;
					try {
						inputs = await readWorkflowArtifactInputs({
							task: projected.task,
							state,
							artifacts,
						});
					} catch (error) {
						if (!(error instanceof WorkflowArtifactInputError)) throw error;
						throw new WorkflowServiceError(
							"persistence",
							"Checkpoint inputs could not be read and verified.",
							{ cause: error },
						);
					}
					const decision = execution.checkpointDecision;
					const decisionArtifact = decision
						? state.artifacts[decision.artifactId]
						: undefined;
					if (decision && !decisionArtifact) {
						throw new WorkflowServiceError(
							"persistence",
							"Checkpoint decision artifact metadata is missing.",
						);
					}
					const value = decisionArtifact
						? await artifacts.readJson(decisionArtifact)
						: undefined;
					return Object.freeze({
						...view,
						checkpoint: Object.freeze({
							...view.checkpoint,
							inputs,
							...(view.checkpoint.decision
								? {
										decision: Object.freeze({
											...view.checkpoint.decision,
											value,
										}),
									}
								: {}),
						}),
					});
				}),
			),
		);
	}

	/**
	 * Selects the current execution's handoff artifact of a completed worktree
	 * task and verifies it exactly as replay does (spec 5, D8) before any byte
	 * leaves the store. A verification failure is durable-state corruption.
	 */
	async function exportHandoffFrom(
		journal: WorkflowRunJournal,
		artifacts: WorkflowArtifactStore,
		taskId: string,
	): Promise<WorkflowServiceHandoffExport> {
		const state = await stateFrom(journal);
		const task = state?.tasks[taskId];
		if (!state || !task) {
			throw new WorkflowServiceError(
				"not-found",
				`Workflow task not found: ${taskId}`,
			);
		}
		if (!isCompletedWorktreeTask(task)) {
			throw new WorkflowServiceError("validation", NO_HANDOFF_ARTIFACT_MESSAGE);
		}
		try {
			const verified = await verifyWorkflowHandoffEvidence(
				state,
				task,
				artifacts,
			);
			if (verified.status === "absent") {
				throw new WorkflowServiceError(
					"validation",
					NO_HANDOFF_ARTIFACT_MESSAGE,
				);
			}
			return Object.freeze({
				descriptor: Object.freeze(
					deriveWorkflowHandoffDescriptor(
						verified.artifact,
						verified.execution,
					),
				),
				content: verified.content,
			});
		} catch (error) {
			if (error instanceof WorkflowServiceError) throw error;
			throw new WorkflowServiceError(
				"persistence",
				WORKFLOW_HANDOFF_UNVERIFIED_MESSAGE,
				{ cause: error },
			);
		}
	}

	/** Spec 5.2: present iff the record is a dynamic run. */
	function dynamicOf(record: WorkflowRunRecord): {
		dynamic?: NonNullable<WorkflowServiceRunView["dynamic"]>;
	} {
		if (
			record.definitionKind !== "dynamic" ||
			record.approvalSha256 === undefined ||
			record.hostApiSha256 === undefined
		) {
			return {};
		}
		return {
			dynamic: Object.freeze({
				ref: dynamicRef(record.definitionSourceSha256),
				sourceSha256: record.definitionSourceSha256,
				approvalSha256: record.approvalSha256,
				hostApiSha256: record.hostApiSha256,
			}),
		};
	}

	function lineageOf(record: WorkflowRunRecord): {
		parent?: NonNullable<WorkflowServiceRunView["parent"]>;
	} {
		return record.parent
			? {
					parent: Object.freeze({
						runId: record.parent.runId,
						taskId: record.parent.taskId,
						inputArtifacts: Object.freeze(
							structuredClone(record.parent.inputArtifacts),
						),
					}),
				}
			: {};
	}

	function assertLineage(
		record: WorkflowRunRecord,
		request: WorkflowNestedRunLaunch,
	): void {
		if (
			record.depth !== request.parent.depth ||
			record.parent?.runId !== request.parent.runId ||
			record.parent.taskId !== request.parent.taskId ||
			record.parent.executionId !== request.parent.executionId ||
			record.definitionIdentitySha256 !== request.definitionIdentitySha256 ||
			record.definitionSourceSha256 !== request.definitionSourceSha256 ||
			!isDeepStrictEqual(record.input, request.input) ||
			!isDeepStrictEqual(record.parent.inputArtifacts, request.inputArtifacts)
		) {
			throw new WorkflowNestedRunError(
				"launch",
				"Existing nested workflow run does not match its launch intent.",
			);
		}
	}

	async function nestedSettlementFrom(
		record: WorkflowRunRecord,
		journal: WorkflowRunJournal,
	): Promise<WorkflowNestedRunSettlement | undefined> {
		const state = await journal.readState();
		if (
			state.status !== "completed" &&
			state.status !== "completed-degraded" &&
			state.status !== "failed" &&
			state.status !== "cancelled" &&
			state.status !== "interrupted" &&
			state.status !== "cleanup-blocked"
		) {
			return undefined;
		}
		const { cost, totalTokens, childRuntimeMs, usageComplete } =
			settledWorkflowUsage(state);
		const outputArtifact = state.outputArtifactId
			? state.artifacts[state.outputArtifactId]
			: undefined;
		if (record.runId !== state.runId) {
			throw new WorkflowNestedRunError(
				"persistence",
				"Nested workflow journal does not match its run record.",
			);
		}
		return Object.freeze({
			status: state.status,
			usage: Object.freeze({ cost, totalTokens, childRuntimeMs }),
			usageComplete,
			...(outputArtifact ? { outputArtifact } : {}),
		});
	}

	async function runDirectoryExists(
		runIdValue: WorkflowRunId,
	): Promise<boolean> {
		try {
			const metadata = await lstat(path.join(storeRoot, "runs", runIdValue));
			return metadata.isDirectory() && !metadata.isSymbolicLink();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	const nestedProvider: WorkflowNestedRunProvider = Object.freeze({
		async launch(request: WorkflowNestedRunLaunch): Promise<void> {
			if (closed) {
				throw new WorkflowNestedRunError(
					"launch",
					"Workflow service is closed.",
				);
			}
			const existing = owned.get(request.childRunId);
			if (existing) {
				assertLineage(existing.record, request);
				return;
			}
			if (await runDirectoryExists(request.childRunId)) {
				let resumed: OwnedRun | undefined;
				try {
					resumed = await resume(request.childRunId);
				} catch (error) {
					// A directory without a record means the atomic record write
					// never happened; the launch is retried under the same id.
					if (
						!(error instanceof WorkflowRunRecordError) ||
						error.message !== "workflow run record is missing"
					) {
						throw error;
					}
				}
				if (resumed) {
					assertLineage(resumed.record, request);
					return;
				}
			}
			const discovered = await discover();
			const workflow = discovered.find(
				(candidate) =>
					candidate.definition.meta.name === request.definitionName,
			);
			if (
				!workflow ||
				workflow.identity.identitySha256 !== request.definitionIdentitySha256 ||
				workflow.identity.sourceSha256 !== request.definitionSourceSha256
			) {
				throw new WorkflowNestedRunError(
					"resolution",
					"Nested workflow definition could not be resolved exactly.",
				);
			}
			validateInput(workflow, request.input);
			const binding = await options.subagents.bind(request.childRunId);
			let lease: WorkflowRunLease;
			try {
				lease = await acquireWorkflowRunLease({
					storeRoot,
					runId: request.childRunId,
					ownerId: `pi-workflow-service:${instanceId}`,
				});
			} catch (error) {
				throw new WorkflowNestedRunError(
					"launch",
					"Nested workflow run lease could not be acquired.",
					{ cause: error },
				);
			}
			try {
				const journal = await WorkflowRunJournal.open(
					storeRoot,
					request.childRunId,
					lease,
					journalOptions(request.childRunId),
				);
				const limits = effectiveLimits(workflow);
				const createdAt = new Date();
				const remainingMs =
					Date.parse(request.deadlineAt) - createdAt.getTime();
				const effectiveTimeoutMs = Math.min(
					limits.effectiveTimeoutMs,
					remainingMs,
				);
				if (
					!Number.isFinite(effectiveTimeoutMs) ||
					effectiveTimeoutMs < 1_000
				) {
					throw new WorkflowNestedRunError(
						"launch",
						"Nested workflow has no remaining time before the parent deadline.",
					);
				}
				const effectiveBudget: WorkflowBudget = {
					cost: Math.min(limits.effectiveBudget.cost, request.budget.cost),
					childRuntimeMs: Math.min(
						limits.effectiveBudget.childRuntimeMs,
						request.budget.childRuntimeMs,
					),
					...(limits.effectiveBudget.totalTokens === undefined &&
					request.budget.totalTokens === undefined
						? {}
						: {
								totalTokens: Math.min(
									limits.effectiveBudget.totalTokens ?? Number.MAX_SAFE_INTEGER,
									request.budget.totalTokens ?? Number.MAX_SAFE_INTEGER,
								),
							}),
				};
				const record: WorkflowRunRecord = {
					schema: "pi-workflow-run",
					contractRevision: WORKFLOW_CONTRACT_REVISION,
					runId: request.childRunId,
					definitionName: workflow.definition.meta.name,
					definitionPath: workflow.path,
					definitionIdentitySha256: workflow.identity.identitySha256,
					definitionSourceSha256: workflow.identity.sourceSha256,
					definitionKind: "static",
					concurrency: Math.min(
						workflow.definition.meta.concurrency,
						maxConcurrency,
						request.concurrency,
					),
					declaredBudget: limits.declaredBudget,
					effectiveBudget,
					declaredTimeoutMs: limits.declaredTimeoutMs,
					effectiveTimeoutMs,
					deadlineAt: new Date(
						createdAt.getTime() + effectiveTimeoutMs,
					).toISOString(),
					cwd,
					input: JSON.parse(JSON.stringify(request.input)) as unknown,
					createdAt: createdAt.toISOString(),
					depth: request.parent.depth,
					parent: {
						runId: request.parent.runId,
						taskId: request.parent.taskId,
						executionId: request.parent.executionId,
						ancestorDefinitionIdentities: [
							...request.parent.ancestorDefinitionIdentities,
						],
						inputArtifacts: structuredClone(request.inputArtifacts),
					},
					...(options.modelRouting?.id
						? { modelRouting: { router: options.modelRouting.id } }
						: {}),
				};
				await WorkflowRunRecordStore.open(journal).create(record);
				const run = await compose(record, workflow, lease, binding, discovered);
				owned.set(request.childRunId, run);
			} catch (error) {
				await lease.release();
				if (error instanceof WorkflowNestedRunError) throw error;
				throw new WorkflowNestedRunError(
					"launch",
					"Nested workflow run could not be created.",
					{ cause: error },
				);
			}
		},
		async wait(
			childRunId: WorkflowRunId,
		): Promise<WorkflowNestedRunSettlement> {
			const run = owned.get(childRunId) ?? (await resume(childRunId));
			// A parked child holds the parent's lane: the parent keeps running
			// while the child waits, and continues once the child's checkpoint
			// is decided, expired, or cancelled and its drive re-settles.
			for (;;) {
				await run.drive;
				const settlement = await nestedSettlementFrom(run.record, run.journal);
				if (settlement) return settlement;
				if (run.parked && !closed) {
					await run.nextChange();
					continue;
				}
				throw new WorkflowNestedRunError(
					"persistence",
					"Nested workflow run ended without durable terminal state.",
					{ cause: run.failure },
				);
			}
		},
		async readOutput(childRunId: WorkflowRunId, artifactId: string) {
			const current = owned.get(childRunId);
			if (current) {
				const state = await current.journal.readState();
				const artifact = state.artifacts[artifactId];
				if (!artifact || state.outputArtifactId !== artifactId) {
					throw new WorkflowNestedRunError(
						"import",
						"Nested workflow output artifact is not declared.",
					);
				}
				return { artifact, value: await current.artifacts.readJson(artifact) };
			}
			const opened = await openInactive(childRunId);
			try {
				const artifacts = await WorkflowArtifactStore.open({
					journal: opened.journal,
				});
				const state = await opened.journal.readState();
				const artifact = state.artifacts[artifactId];
				if (!artifact || state.outputArtifactId !== artifactId) {
					throw new WorkflowNestedRunError(
						"import",
						"Nested workflow output artifact is not declared.",
					);
				}
				return { artifact, value: await artifacts.readJson(artifact) };
			} finally {
				await opened.lease.release();
			}
		},
		async stop(childRunId: WorkflowRunId, reason: string): Promise<void> {
			if (!(await runDirectoryExists(childRunId))) return;
			const run = owned.get(childRunId) ?? (await resume(childRunId));
			if (run.settled) {
				if (run.parked) await stopParked(run, reason).catch(() => undefined);
				return;
			}
			await run.scheduler.stop(reason).catch(() => undefined);
			await run.drive;
		},
		async reconcile(childRunId: WorkflowRunId): Promise<void> {
			await reconcileCurrent(childRunId);
		},
	});

	async function statusCurrent(
		runIdValue: WorkflowRunId,
	): Promise<WorkflowServiceRunView> {
		return (await snapshotCurrent(runIdValue)).view;
	}

	/**
	 * The run view together with the state it was projected from; operator
	 * preconditions read recovery evidence (invalidated work, open operator
	 * intents) from the state, which the lean view does not carry.
	 */
	async function snapshotCurrent(runIdValue: WorkflowRunId): Promise<{
		view: WorkflowServiceRunView;
		state: WorkflowStateProjection | undefined;
	}> {
		assertRunId(runIdValue);
		const current = owned.get(runIdValue);
		if (current) {
			const state = await stateFrom(current.journal);
			const view =
				current.settled && current.view
					? current.view
					: await viewFromState(current.record, state, current.artifacts);
			return { view, state };
		}
		const opened = await openInactive(runIdValue);
		try {
			const artifacts = await WorkflowArtifactStore.open({
				journal: opened.journal,
			});
			const state = await stateFrom(opened.journal);
			return {
				view: await viewFromState(opened.record, state, artifacts),
				state,
			};
		} finally {
			await opened.lease.release();
		}
	}

	async function resume(runIdValue: WorkflowRunId): Promise<OwnedRun> {
		const existing = owned.get(runIdValue);
		if (existing && !existing.settled) return existing;
		const opened = await openInactive(runIdValue);
		try {
			const discovered = await discover();
			const workflow = await workflowForRecord(
				opened.record,
				opened.journal,
				discovered,
			);
			const binding = await options.subagents.bind(runIdValue);
			const run = await compose(
				opened.record,
				workflow,
				opened.lease,
				binding,
				discovered,
			);
			owned.set(runIdValue, run);
			return run;
		} catch (error) {
			await opened.lease.release();
			throw error;
		}
	}

	// Named rather than returned inline so a store-level operation can reuse
	// the service's own read surface: `prune` selects from `listRuns`, the
	// same projection the operator and the widget see.
	const service: WorkflowService = Object.freeze({
		registerRoot(root: WorkflowRoot) {
			return exclusive(async () => {
				assertOpen();
				if (root.scope !== "package" && root.scope !== "builtin") {
					throw new WorkflowServiceError(
						"validation",
						"Registered roots must be package or builtin scope.",
					);
				}
				roots.push(Object.freeze({ ...root }));
				try {
					await discover();
				} catch (error) {
					roots.pop();
					throw error;
				}
			});
		},
		async list() {
			return Object.freeze((await discover()).map(summary));
		},
		async validate(ref: string, input?: unknown) {
			assertOpen();
			const workflow = isDynamicRef(ref)
				? dynamicWorkflow(
						(await dynamicRunnable(ref)).proposal,
						new Date().toISOString(),
					)
				: await resolve(ref);
			if (input !== undefined) validateInput(workflow, input);
			return Object.freeze({
				valid: true as const,
				workflow: summary(workflow),
			});
		},
		async project(ref: string, input: unknown) {
			assertOpen();
			if (isDynamicRef(ref)) {
				throw new WorkflowServiceError(
					"validation",
					WORKFLOW_PROJECTION_DYNAMIC_MESSAGE,
				);
			}
			const discovered = await discover();
			const workflow = resolveAmong(discovered, ref);
			validateInput(workflow, input);
			const byName = new Map(
				discovered.map((candidate) => [
					candidate.definition.meta.name,
					candidate.definition.meta.budget,
				]),
			);
			const projection = await projectWorkflowGraph(
				workflow.definition,
				input,
				{ cwd, childBudget: (name) => byName.get(name) },
			);
			const budget = effectiveLimits(workflow).effectiveBudget;
			return Object.freeze({
				cost: projection.cost,
				totalTokens: projection.totalTokens,
				childRuntimeMs: projection.childRuntimeMs,
				tasks: projection.tasks,
				budget: Object.freeze({ ...budget }),
				fits: projectionFits(projection, budget),
			});
		},
		run(ref: string, input: unknown, runOptions?: WorkflowServiceRunOptions) {
			return exclusive(async () => {
				assertOpen();
				// The run's `createdAt` fixes the dynamic VM clock, so it is chosen
				// before the definition is built; the record carries the same value.
				const createdAt = new Date();
				const dynamic = isDynamicRef(ref)
					? await dynamicRunnable(ref)
					: undefined;
				const discovered = await discover();
				const workflow = dynamic
					? dynamicWorkflow(dynamic.proposal, createdAt.toISOString())
					: resolveAmong(discovered, ref);
				validateInput(workflow, input);
				const id = runId();
				const binding = await options.subagents.bind(id);
				const lease = await acquireWorkflowRunLease({
					storeRoot,
					runId: id,
					ownerId: `pi-workflow-service:${instanceId}`,
				});
				try {
					const journal = await WorkflowRunJournal.open(
						storeRoot,
						id,
						lease,
						journalOptions(id),
					);
					const limits = effectiveLimits(workflow);
					if (dynamic) {
						// Spec 4.4: the copies exist before the record does, so a run
						// record implies the evidence resume verifies is on disk.
						try {
							await writeRunDefinitionCopy(journal.directory, {
								source: dynamic.proposal.source,
								manifest: dynamic.proposal.record.manifest,
								proposal: dynamic.proposal.record,
								approval: dynamic.approval,
							});
						} catch (error) {
							throw dynamicFailure(error);
						}
					}
					const record: WorkflowRunRecord = {
						schema: "pi-workflow-run",
						contractRevision: WORKFLOW_CONTRACT_REVISION,
						runId: id,
						depth: 0,
						definitionName: workflow.definition.meta.name,
						definitionPath: workflow.path,
						definitionIdentitySha256: workflow.identity.identitySha256,
						definitionSourceSha256: workflow.identity.sourceSha256,
						...(dynamic
							? {
									definitionKind: "dynamic" as const,
									approvalSha256: deriveDecisionRecordSha256(dynamic.approval),
									hostApiSha256: dynamic.hostApiSha256,
								}
							: { definitionKind: "static" as const }),
						concurrency: Math.min(
							workflow.definition.meta.concurrency,
							maxConcurrency,
						),
						...limits,
						deadlineAt: new Date(
							createdAt.getTime() + limits.effectiveTimeoutMs,
						).toISOString(),
						cwd,
						input: JSON.parse(JSON.stringify(input)) as unknown,
						createdAt: createdAt.toISOString(),
						...(options.modelRouting?.id
							? { modelRouting: { router: options.modelRouting.id } }
							: {}),
					};
					await WorkflowRunRecordStore.open(journal).create(record);
					const run = await compose(
						record,
						workflow,
						lease,
						binding,
						discovered,
						runOptions?.origin,
					);
					owned.set(id, run);
					return { runId: id, status: "created" as const };
				} catch (error) {
					await lease.release();
					throw error;
				}
			});
		},
		status(runIdValue: WorkflowRunId) {
			assertOpen();
			return statusCurrent(runIdValue);
		},
		async wait(runIdValue: WorkflowRunId, options: WorkflowWaitOptions = {}) {
			assertOpen();
			if (!Value.Check(WorkflowWaitOptionsSchema, options)) {
				throw new WorkflowServiceError(
					"validation",
					"Invalid workflow wait timeout.",
				);
			}
			let run = owned.get(runIdValue);
			if (!run) {
				const { view, state } = await snapshotCurrent(runIdValue);
				if (
					isTerminalWorkflowRunStatus(view.status) &&
					!(state !== undefined && awaitsRecovery(state))
				) {
					return view;
				}
				run = await resume(runIdValue);
			}
			const until =
				options.timeoutMs === undefined
					? undefined
					: Date.now() + options.timeoutMs;
			// A drive that settles and is re-driven at once (a park swept for
			// expiry, or one decided from under a live drive) is followed until
			// the run is settled for good or the timeout elapses.
			for (;;) {
				if (!run.settled) {
					const remaining =
						until === undefined ? undefined : Math.max(1, until - Date.now());
					const timedOut = await outlives(run.drive, remaining);
					if (timedOut) {
						return Object.freeze({
							...(await statusCurrent(runIdValue)),
							timedOut: true as const,
						});
					}
				}
				// A parked run is settled without failure and returns its `waiting`
				// view at once; a park whose expiry or deadline has passed is swept
				// by one re-drive first (which expires, defaults, or stops it).
				if (run.settled && parkExpired(run, Date.now())) {
					await run.restart();
				}
				if (run.settled) break;
			}
			const view = await statusCurrent(runIdValue);
			if (run.failure && !isTerminalWorkflowRunStatus(view.status)) {
				throw new WorkflowServiceError(
					"execution",
					"Workflow drive ended without durable terminal state.",
					{ cause: run.failure },
				);
			}
			if (run.settled && run.parked) {
				return Object.freeze({ ...view, parked: true as const });
			}
			return view;
		},
		async stop(runIdValue: WorkflowRunId, reason: string) {
			assertOpen();
			const current = await statusCurrent(runIdValue);
			if (isTerminalWorkflowRunStatus(current.status)) return current;
			// A settled owned run still holds its lease; reuse it as invalidate
			// and reconcile do instead of colliding with our own lease.
			const run = owned.get(runIdValue) ?? (await resume(runIdValue));
			const idle = run.settled;
			if (run.watchdog) clearTimeout(run.watchdog);
			delete run.watchdog;
			await run.scheduler.stop(reason);
			await run.drive;
			// Stopping a settled run appends after its cached view was taken.
			delete run.view;
			let view = await statusCurrent(runIdValue);
			// With no drive running, nothing drains a stop the scheduler left
			// non-terminal (support or several agent tasks still active); restart
			// the drive and await it, as reconcile does.
			if (idle && !isTerminalWorkflowRunStatus(view.status)) {
				await run.restart();
				view = await statusCurrent(runIdValue);
			}
			if (isTerminalWorkflowRunStatus(view.status)) {
				delete run.parked;
				run.wake();
			}
			return view;
		},
		decide(
			runIdValue: WorkflowRunId,
			taskId: string,
			decideOptions: WorkflowDecideOptions,
		) {
			return exclusive(async () => {
				assertOpen();
				if (!Value.Check(WorkflowRunIdSchema, runIdValue)) {
					throw new WorkflowServiceError(
						"validation",
						"Invalid workflow run ID.",
					);
				}
				if (!Value.Check(WorkflowTaskIdSchema, taskId)) {
					throw new WorkflowServiceError(
						"validation",
						"Invalid workflow task ID.",
					);
				}
				if (typeof decideOptions !== "object" || decideOptions === null) {
					throw new WorkflowServiceError(
						"validation",
						"Invalid checkpoint decision options.",
					);
				}
				const { approver, reason } = decideOptions as {
					readonly approver?: unknown;
					readonly reason?: unknown;
				};
				if (
					typeof approver !== "string" ||
					approver.length < 1 ||
					approver.length > 256
				) {
					throw new WorkflowServiceError(
						"validation",
						"Invalid checkpoint approver.",
					);
				}
				if (
					reason !== undefined &&
					(typeof reason !== "string" ||
						reason.length < 1 ||
						reason.length > 4096)
				) {
					throw new WorkflowServiceError(
						"validation",
						"Invalid checkpoint decision reason.",
					);
				}
				if (!Value.Check(WorkflowDecideOptionsSchema, decideOptions)) {
					throw new WorkflowServiceError(
						"validation",
						"Invalid checkpoint decision options.",
					);
				}
				const current = await statusCurrent(runIdValue);
				// The same facts as the `decide` legality predicate: a root run that
				// is running or waiting, before its deadline, with the named task
				// awaiting a decision.
				if (isNestedRun(current)) {
					throw new WorkflowServiceError(
						"validation",
						"Nested workflow runs are decided through their parent run.",
					);
				}
				if (current.status !== "running" && current.status !== "waiting") {
					throw new WorkflowServiceError(
						"validation",
						"Workflow run status does not admit a checkpoint decision.",
					);
				}
				const task = knownTask(current, taskId);
				if (task.kind !== "checkpoint") {
					throw new WorkflowServiceError(
						"validation",
						"Workflow task is not a checkpoint task.",
					);
				}
				if (
					task.status !== "waiting" ||
					!task.checkpoint ||
					task.checkpoint.decision
				) {
					throw new WorkflowServiceError(
						"validation",
						"Checkpoint is not awaiting a decision.",
					);
				}
				if (deadlinePassed(current.deadlineAt, Date.now())) {
					throw new WorkflowServiceError(
						"validation",
						"Workflow run deadline has passed.",
					);
				}
				// A settled owned run still holds its lease and is reused; an
				// inactive run is composed, and its initial drive re-parks while
				// the decision is recorded under the scheduler lock.
				const run = owned.get(runIdValue) ?? (await resume(runIdValue));
				try {
					await run.scheduler.decide(taskId, {
						value: decideOptions.decision,
						decidedBy: approver,
						...(reason === undefined ? {} : { reason }),
					});
				} catch (error) {
					throw decisionRejection(error);
				}
				// The decision was appended after any cached view was taken.
				delete run.view;
				if (run.settled) {
					// The decision wakes the parked run; the restarted drive is not
					// awaited here, wait() observes it.
					void run.restart();
				} else {
					// A live drive that parks on a lane outcome older than the
					// decision leaves the decided task unlisted or still listed as
					// pending; either way nothing waits for it, so re-drive.
					void run.drive.then(() => {
						if (!closed && run.settled && run.parked) {
							const decided = !(run.view?.pendingCheckpoints ?? []).some(
								(checkpoint) => checkpoint.taskId === taskId,
							);
							if (decided) void run.restart();
						}
					});
				}
				return statusCurrent(runIdValue);
			});
		},
		invalidate(runIdValue: WorkflowRunId, causeTaskId: string, reason: string) {
			return exclusive(async () => {
				assertOpen();
				assertRunId(runIdValue);
				assertTaskId(causeTaskId);
				assertReason(reason, "Invalid workflow invalidation reason.");
				return invalidateCurrent(runIdValue, causeTaskId, reason);
			});
		},
		retry(runIdValue: WorkflowRunId, taskId: WorkflowTaskId, reason: string) {
			return exclusive(async () => {
				assertOpen();
				assertRunId(runIdValue);
				assertTaskId(taskId);
				assertReason(reason, "Invalid workflow retry reason.");
				return invalidateCurrent(runIdValue, taskId, reason, (state) => {
					if (!retryableTasks(state).includes(taskId)) {
						throw new WorkflowServiceError(
							"validation",
							"Workflow retry requires a failed or interrupted task.",
						);
					}
				});
			});
		},
		resume(
			runIdValue: WorkflowRunId,
			reason: string,
			options: WorkflowResumeOptions = {},
		) {
			return exclusive(async () => {
				assertOpen();
				assertRunId(runIdValue);
				assertReason(reason, "Invalid workflow resume reason.");
				if (
					!Value.Check(WorkflowResumeOptionsSchema, options) ||
					(options.taskId !== undefined &&
						!Value.Check(WorkflowTaskIdSchema, options.taskId))
				) {
					throw new WorkflowServiceError(
						"validation",
						"Invalid workflow task ID.",
					);
				}
				const { view: current, state: durable } =
					await snapshotCurrent(runIdValue);
				const active = owned.get(runIdValue);
				if (active && !active.settled) {
					throw new WorkflowServiceError(
						"conflict",
						"Workflow run is still being driven.",
					);
				}
				const refuseStatus = () =>
					new WorkflowServiceError(
						"validation",
						"Workflow run status does not admit resume.",
					);
				if (current.status !== "interrupted") throw refuseStatus();
				if (isNestedRun(current)) {
					throw new WorkflowServiceError(
						"validation",
						"Nested workflow runs are resumed through their parent run.",
					);
				}
				if (durable !== undefined && awaitsRecovery(durable)) {
					throw recoveryRefusal(durable);
				}
				// Checked before the run is composed, as invalidate does: resuming
				// an expired run would only let its deadline cancel it.
				if (deadlinePassed(current.deadlineAt, Date.now())) {
					throw new WorkflowServiceError(
						"validation",
						"Workflow run deadline has passed.",
					);
				}
				const run = active ?? (await resume(runIdValue));
				await run.drive;
				const state = await run.journal.readState();
				if (state.status !== "interrupted") throw refuseStatus();
				let taskId: WorkflowTaskId;
				if (options.taskId === undefined) {
					const candidates = resumableTasks(state);
					if (candidates.length === 0) {
						throw new WorkflowServiceError(
							"validation",
							"Workflow run has no resumable task.",
						);
					}
					if (candidates.length > 1) {
						throw new WorkflowServiceError(
							"validation",
							"Workflow run has multiple resumable tasks; specify taskId.",
						);
					}
					taskId = candidates[0] as WorkflowTaskId;
				} else {
					taskId = options.taskId;
					let refusal: string | undefined;
					try {
						refusal = resumeRefusal(state, taskId);
					} catch (error) {
						throw reducerRejection(error);
					}
					if (refusal !== undefined) {
						throw new WorkflowServiceError("validation", refusal);
					}
				}
				const task = state.tasks[taskId];
				const execution = task?.currentExecutionId
					? state.executions[task.currentExecutionId]
					: undefined;
				const failure = execution?.settlement?.evidence.failure;
				const previousAttemptId = execution
					? currentSubagentAttemptId(execution)
					: undefined;
				const subagentRunId = execution?.launchReceipt?.subagentRunId;
				if (
					!execution ||
					!failure ||
					previousAttemptId === undefined ||
					subagentRunId === undefined
				) {
					throw new WorkflowServiceError(
						"validation",
						"Workflow resume requires an interrupted task with a resumable failure.",
					);
				}
				// The intent is durable before the run reopens: a crash here leaves
				// an open operator intent, and the next drive performs the same
				// `interrupted -> running` transition before attempting it.
				await appendOperatorEvent(run.journal, {
					type: "task-execution-attempt-intended",
					data: {
						executionId: execution.execution.id,
						subagentRunId,
						kind: "resume",
						ordinal: 2 + (execution.attempts?.length ?? 0),
						previousAttemptId,
						failureCode: failure.code,
						failureRetry: "resume",
						origin: "operator",
						reason,
					},
				});
				await appendOperatorEvent(run.journal, {
					type: "run-status-changed",
					data: {
						from: "interrupted",
						to: "running",
						reason: OPERATOR_RESUME_REASON,
					},
				});
				// The restarted drive is not awaited here; wait() observes it.
				void run.restart();
				return statusCurrent(runIdValue);
			});
		},
		async reconcile(
			runIdValue: WorkflowRunId,
			options: WorkflowReconcileOptions = {},
		) {
			assertOpen();
			if (
				options.taskId !== undefined &&
				!Value.Check(WorkflowTaskIdSchema, options.taskId)
			) {
				throw new WorkflowServiceError(
					"validation",
					"Invalid workflow task ID.",
				);
			}
			return reconcileCurrent(runIdValue, options.taskId);
		},
		async exportHandoff(runIdValue: WorkflowRunId, taskId: string) {
			assertOpen();
			if (!Value.Check(WorkflowRunIdSchema, runIdValue)) {
				throw new WorkflowServiceError(
					"validation",
					"Invalid workflow run ID.",
				);
			}
			if (!Value.Check(WorkflowTaskIdSchema, taskId)) {
				throw new WorkflowServiceError(
					"validation",
					"Invalid workflow task ID.",
				);
			}
			// An owned run keeps its lease and store; the journal is read as it
			// stands, so a task completed on a still-driving run is exportable.
			const current = owned.get(runIdValue);
			if (current) {
				return exportHandoffFrom(current.journal, current.artifacts, taskId);
			}
			const opened = await openInactive(runIdValue);
			try {
				const artifacts = await WorkflowArtifactStore.open({
					journal: opened.journal,
				});
				return await exportHandoffFrom(opened.journal, artifacts, taskId);
			} finally {
				await opened.lease.release();
			}
		},
		propose(source: string, proposeOptions: DynamicWorkflowProposeOptions) {
			return exclusive(async () => {
				assertOpen();
				assertDynamicTrusted();
				try {
					const identity = assertDynamicSourceIntake(source, {
						allowedSupportImports: [...supportTasks.values()].map(
							(registration) => registration.moduleSpecifier,
						),
					});
					const proposer = (
						proposeOptions as Partial<DynamicWorkflowProposeOptions> | undefined
					)?.proposer;
					if (!Value.Check(DynamicWorkflowProposerSchema, proposer)) {
						throw new WorkflowServiceError(
							"validation",
							"Invalid dynamic workflow proposer.",
						);
					}
					const store = await openProposalStore();
					// The cap is checked before a VM boots; `put` re-checks under the
					// store's mutation lock for the race.
					if (
						(await store.read(identity.sourceSha256)) === undefined &&
						(await store.count()) >= MAX_DYNAMIC_PROPOSALS
					) {
						throw new WorkflowDynamicStoreFullError();
					}
					let manifest: Awaited<
						ReturnType<typeof extractDynamicWorkflowManifest>
					>;
					try {
						manifest = await extractDynamicWorkflowManifest({
							source,
							sourceSha256: identity.sourceSha256,
							supportHelpers,
							...(dynamicOverrides === undefined
								? {}
								: { overrides: dynamicOverrides }),
						});
					} catch (error) {
						if (!(error instanceof DynamicWorkflowExecutionError)) throw error;
						throw new WorkflowServiceError(
							"validation",
							`Dynamic workflow manifest extraction failed: ${error.message}`,
							{ cause: error },
						);
					}
					const record = createDynamicWorkflowProposalRecord({
						sourceSha256: identity.sourceSha256,
						sourceBytes: identity.sourceBytes,
						manifest,
						importPolicySha256: deriveDynamicImportPolicySha256(supportHelpers),
						proposer,
						proposedAt: new Date().toISOString(),
						projectRoot: cwd,
					});
					const { proposal } = await store.put({ source, record });
					return proposalView(proposal, await readSourceApproval(proposal));
				} catch (error) {
					throw dynamicFailure(error);
				}
			});
		},
		async inspectProposal(ref: string) {
			assertOpen();
			assertDynamicTrusted();
			const sourceSha256 = parseDynamicReference(ref);
			try {
				const proposal = await readProposal(sourceSha256);
				return Object.freeze({
					...proposalView(proposal, await readSourceApproval(proposal)),
					source: proposal.source,
				});
			} catch (error) {
				throw dynamicFailure(error);
			}
		},
		async proposals() {
			assertOpen();
			assertDynamicTrusted();
			let listings: Awaited<ReturnType<DynamicWorkflowProposalStore["list"]>>;
			try {
				listings = await (await openProposalStore()).list();
			} catch (error) {
				throw dynamicFailure(error);
			}
			const views: DynamicWorkflowProposalListing[] = [];
			for (const listing of listings) {
				if ("issue" in listing) {
					views.push(Object.freeze({ ref: listing.ref, issue: listing.issue }));
					continue;
				}
				// One proposal's unreadable approval never fails the listing.
				try {
					views.push(
						proposalView(
							listing.proposal,
							await readSourceApproval(listing.proposal),
						),
					);
				} catch (error) {
					const mapped = dynamicFailure(error);
					if (!(mapped instanceof WorkflowServiceError)) throw error;
					views.push(
						Object.freeze({ ref: listing.ref, issue: mapped.message }),
					);
				}
			}
			return Object.freeze(views);
		},
		decideSource(ref: string, decisionOptions: DynamicSourceDecisionOptions) {
			return exclusive(async () => {
				assertOpen();
				assertDynamicTrusted();
				const sourceSha256 = parseDynamicReference(ref);
				const { decision, approver, reason } =
					(decisionOptions as Partial<DynamicSourceDecisionOptions> | null) ??
					{};
				try {
					const decided = await decideDynamicSource({
						store: await openProposalStore(),
						sourceSha256,
						decision: decision as DynamicSourceDecision,
						approver: approver as DynamicSourceApprover,
						...(reason === undefined ? {} : { reason }),
						cwd,
						hostApiSha256: deriveDynamicHostApiSha256(),
						importPolicySha256: deriveDynamicImportPolicySha256(supportHelpers),
					});
					return proposalView(decided.proposal, decided.approval);
				} catch (error) {
					throw dynamicFailure(error);
				}
			});
		},
		shutdown() {
			return exclusive(async () => {
				if (closed) return;
				closed = true;
				const runs = [...owned.values()].sort(
					(left, right) => left.record.depth - right.record.depth,
				);
				const depths = [...new Set(runs.map((run) => run.record.depth))];
				// A parked run is settled and never stopped: its lease is released
				// and a later session resumes it through wait, decide, or stop.
				for (const run of runs) {
					if (run.watchdog) clearTimeout(run.watchdog);
					delete run.watchdog;
				}
				for (const depth of depths) {
					await Promise.all(
						runs
							.filter((run) => run.record.depth === depth)
							.map(async (run) => {
								if (!run.settled) {
									await run.scheduler
										.stop("Pi workflow session is shutting down.")
										.catch(() => undefined);
									await run.drive;
								}
							}),
					);
				}
				await Promise.all(runs.map((run) => run.lease.release()));
				listeners.clear();
			});
		},
		async listRuns(query: WorkflowRunQuery = {}) {
			assertOpen();
			if (!Value.Check(WorkflowRunQuerySchema, query)) {
				throw new WorkflowServiceError(
					"validation",
					"Invalid workflow run query.",
				);
			}
			const cursor =
				query.cursor === undefined
					? undefined
					: decodeWorkflowRunCursor(query.cursor);
			if (query.cursor !== undefined && cursor === undefined) {
				throw new WorkflowServiceError(
					"validation",
					"Invalid workflow run cursor.",
				);
			}
			const generatedAt = new Date();
			const now = generatedAt.getTime();
			const runsRoot = path.join(storeRoot, "runs");
			let entries: Dirent[];
			try {
				entries = await readdir(runsRoot, { withFileTypes: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				entries = [];
			}
			const issues: WorkflowRunListIssue[] = [];
			const summaries: WorkflowRunSummary[] = [];
			const pending: WorkflowRunId[] = [];
			for (const entry of entries) {
				if (
					!entry.isDirectory() ||
					entry.isSymbolicLink() ||
					!Value.Check(WorkflowRunIdSchema, entry.name)
				) {
					issues.push({
						directory: entry.name,
						kind: "invalid-directory",
						message: "Workflow run directory is invalid.",
					});
					continue;
				}
				pending.push(entry.name);
			}
			type Issue = (
				kind: WorkflowRunListIssue["kind"],
				message: string,
			) => void;
			const summarize = async (
				runIdValue: WorkflowRunId,
				issue: Issue,
			): Promise<WorkflowRunSummary | undefined> => {
				let record: WorkflowRunRecord;
				let events: readonly WorkflowJournalEvent[];
				let ownership: WorkflowRunOwnership;
				let driving: boolean;
				const current = owned.get(runIdValue);
				if (current) {
					record = current.record;
					events = await current.journal.readEvents();
					ownership = "owned";
					driving = !current.settled;
				} else {
					try {
						record = await WorkflowRunRecordStore.readFrom(
							path.join(runsRoot, runIdValue),
							runIdValue,
						);
					} catch (error) {
						if (!(error instanceof WorkflowRunRecordError)) throw error;
						if (error.message === "workflow run record is missing") {
							issue("missing-record", "Workflow run record is missing.");
						} else {
							issue("invalid-record", "Workflow run record is invalid.");
						}
						return undefined;
					}
					const read = await readWorkflowJournalUnleased(storeRoot, runIdValue);
					events = read.events;
					if (read.tornTailBytes > 0) {
						issue(
							"torn-tail",
							"Workflow run journal has a torn tail record; the complete prefix was used.",
						);
					}
					ownership = await ownershipOf(runIdValue);
					driving = false;
				}
				let state: WorkflowStateProjection | undefined;
				try {
					state = events.length > 0 ? reduceWorkflowEvents(events) : undefined;
				} catch (error) {
					if (!(error instanceof WorkflowEventReductionError)) throw error;
					issue(
						"invalid-projection",
						"Workflow run journal violates run invariants.",
					);
					return undefined;
				}
				return runSummary(record, state, events, ownership, driving, now);
			};
			// One run's problem never fails the listing: a corrupt journal (owned
			// or not) is reported as such, anything else as unreadable.
			const scan = async (runIdValue: WorkflowRunId): Promise<void> => {
				const issue: Issue = (kind, message) => {
					issues.push({
						runId: runIdValue,
						directory: runIdValue,
						kind,
						message,
					});
				};
				let summary: WorkflowRunSummary | undefined;
				try {
					summary = await summarize(runIdValue, issue);
				} catch (error) {
					if (error instanceof WorkflowPersistenceCorruptionError) {
						issue("corrupt-journal", "Workflow run journal is corrupt.");
					} else {
						issue("unreadable", "Workflow run could not be read.");
					}
					return;
				}
				if (summary) summaries.push(summary);
			};
			await Promise.all(
				Array.from({ length: Math.min(8, pending.length) }, async () => {
					for (;;) {
						const next = pending.shift();
						if (next === undefined) return;
						await scan(next);
					}
				}),
			);
			const includeChildren = query.includeChildren ?? false;
			const statuses = query.statuses;
			const matching = summaries
				.filter((summary) => includeChildren || summary.depth === 0)
				.filter(
					(summary) =>
						statuses === undefined || statuses.includes(summary.status),
				)
				.sort(compareRunSummaries);
			const afterCursor = cursor
				? matching.filter((summary) => compareRunSummaries(summary, cursor) > 0)
				: matching;
			const limit = query.limit ?? 20;
			const page = afterCursor.slice(0, limit);
			const last = page.at(-1);
			issues.sort((left, right) =>
				left.directory === right.directory
					? left.kind < right.kind
						? -1
						: left.kind > right.kind
							? 1
							: 0
					: left.directory < right.directory
						? -1
						: 1,
			);
			return Object.freeze({
				runs: Object.freeze(page),
				...(last && afterCursor.length > page.length
					? { nextCursor: encodeWorkflowRunCursor(last) }
					: {}),
				total: matching.length,
				issues: Object.freeze(
					issues
						.slice(0, MAX_WORKFLOW_RUN_LIST_ISSUES)
						.map((issue) => Object.freeze(issue)),
				),
				issuesTruncated: Math.max(
					0,
					issues.length - MAX_WORKFLOW_RUN_LIST_ISSUES,
				),
				generatedAt: generatedAt.toISOString(),
			});
		},
		async inspect(
			runIdValue: WorkflowRunId,
			options: WorkflowInspectOptions = {},
		) {
			assertOpen();
			if (!Value.Check(WorkflowRunIdSchema, runIdValue)) {
				throw new WorkflowServiceError(
					"validation",
					"Invalid workflow run ID.",
				);
			}
			const { taskId, ...selector } = options;
			if (!Value.Check(WorkflowInspectOptionsSchema, selector)) {
				throw new WorkflowServiceError(
					"validation",
					"Invalid workflow inspection selector.",
				);
			}
			if (taskId !== undefined && !Value.Check(WorkflowTaskIdSchema, taskId)) {
				throw new WorkflowServiceError(
					"validation",
					"Invalid workflow task ID.",
				);
			}
			const source = await readCurrent(runIdValue);
			const include = selector.include ?? DEFAULT_INSPECT_SECTIONS;
			const evidence = await inspectionEvidence(
				runIdValue,
				source.state,
				include,
			);
			return runInspection(
				source.record,
				source.state,
				source.events,
				source.ownership,
				source.driving,
				Date.now(),
				{
					...(selector.include ? { include: selector.include } : {}),
					...(taskId === undefined ? {} : { taskId }),
					...evidence,
				},
			);
		},
		async logs(runIdValue: WorkflowRunId, options: WorkflowLogOptions = {}) {
			assertOpen();
			if (!Value.Check(WorkflowRunIdSchema, runIdValue)) {
				throw new WorkflowServiceError(
					"validation",
					"Invalid workflow run ID.",
				);
			}
			if (!Value.Check(WorkflowLogOptionsSchema, options)) {
				throw new WorkflowServiceError(
					"validation",
					"Invalid workflow log query.",
				);
			}
			const source = await readCurrent(runIdValue);
			return runLogs(source.events, source.state, options, runIdValue);
		},
		async previewInvalidation(
			runIdValue: WorkflowRunId,
			causeTaskId: WorkflowTaskId,
		) {
			assertOpen();
			assertRunId(runIdValue);
			assertTaskId(causeTaskId);
			const source = await readCurrent(runIdValue);
			if (!source.state) {
				throw new WorkflowServiceError(
					"validation",
					"Workflow run has no tasks to invalidate.",
				);
			}
			try {
				return invalidationPreview(source.state, causeTaskId);
			} catch (error) {
				throw reducerRejection(error);
			}
		},
		async prune(pruneOptions: WorkflowPruneOptions = {}) {
			assertOpen();
			if (!Value.Check(WorkflowPruneOptionsSchema, pruneOptions)) {
				throw new WorkflowServiceError(
					"validation",
					"Invalid workflow prune options.",
				);
			}
			const { olderThanMs } = pruneOptions;
			const dryRun = pruneOptions.dryRun ?? true;
			// Exclusive for the whole selection and move: no drive of this
			// service can open a run between reading its status and renaming
			// its directory away.
			return exclusive(async () => {
				assertOpen();
				const candidates: WorkflowPruneCandidate[] = [];
				let cursor: string | undefined;
				do {
					const page = await service.listRuns({
						includeChildren: true,
						limit: MAX_WORKFLOW_RUN_PAGE_SIZE,
						...(cursor === undefined ? {} : { cursor }),
					});
					for (const summary of page.runs) {
						const current = owned.get(summary.runId);
						candidates.push({
							runId: summary.runId,
							status: summary.status,
							updatedAt: summary.updatedAt,
							// This process keeps the lease of every run it drove,
							// settled or not. A settled drive is idle, so our own
							// listener is not the live process a prune refuses; the
							// lease is released below, immediately before the move.
							...(current?.settled === true ? { heldHere: true } : {}),
						});
					}
					cursor = page.nextCursor;
				} while (cursor !== undefined);
				return pruneWorkflowRuns({
					storeRoot,
					candidates,
					dryRun,
					...(olderThanMs === undefined ? {} : { olderThanMs }),
					async releaseLocalLease(runIdValue) {
						const current = owned.get(runIdValue);
						if (!current) return;
						owned.delete(runIdValue);
						if (current.watchdog) clearTimeout(current.watchdog);
						delete current.watchdog;
						await current.lease.release();
					},
				});
			});
		},
		subscribe(listener: WorkflowRunListener) {
			assertOpen();
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	});
	return service;

	/**
	 * Resolves the drive to false or a timer to true, whichever settles first.
	 * Without a timeout the drive is awaited as before.
	 */
	async function outlives(
		drive: Promise<void>,
		timeoutMs: number | undefined,
	): Promise<boolean> {
		if (timeoutMs === undefined) {
			await drive;
			return false;
		}
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<true>((resolve) => {
			timer = setTimeout(() => resolve(true), timeoutMs);
			timer.unref();
		});
		try {
			return await Promise.race([drive.then(() => false as const), timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/** A lease-free ownership probe; an unidentifiable occupant fails safe. */
	async function ownershipOf(
		runIdValue: WorkflowRunId,
	): Promise<WorkflowRunOwnership> {
		let probe: Awaited<ReturnType<typeof probeWorkflowRunLease>>;
		try {
			probe = await probeWorkflowRunLease({ storeRoot, runId: runIdValue });
		} catch (error) {
			// A lease record that cannot be read fails acquisition too, so no
			// action on the run could succeed: report it as held elsewhere.
			if (error instanceof WorkflowPersistenceCorruptionError) {
				return "leased-elsewhere";
			}
			throw error;
		}
		return probe.state === "free" ? "inactive" : "leased-elsewhere";
	}

	/**
	 * The artifact and decision stores of a run for a lease-free read: an
	 * owned run's own stores, or read-only ones opened over its durable
	 * directory. Neither can write.
	 */
	async function readOnlyStores(runIdValue: WorkflowRunId): Promise<{
		artifacts: WorkflowArtifactStore;
		decisions: WorkflowDecisionRecordStore;
	}> {
		const current = owned.get(runIdValue);
		if (current) {
			return { artifacts: current.artifacts, decisions: current.decisions };
		}
		return {
			artifacts: await WorkflowArtifactStore.openUnleased({
				storeRoot,
				runId: runIdValue,
			}),
			decisions: await WorkflowDecisionRecordStore.openUnleased({
				storeRoot,
				runId: runIdValue,
			}),
		};
	}

	/**
	 * The three durable values the lease-free inspection cannot project from the
	 * journal alone: a terminal run's committed output and a bounded summary of
	 * every settled task's own result (both only when `include` asks for
	 * `"output"`), and the decided value of every on-path checkpoint (whenever
	 * `tasks` are projected). All are read through the read-only stores and
	 * verified against the journal before they are shown; nothing is read when
	 * the run has none of them.
	 */
	async function inspectionEvidence(
		runIdValue: WorkflowRunId,
		state: WorkflowStateProjection | undefined,
		include: readonly WorkflowInspectSection[],
	): Promise<{
		output?: unknown;
		decisionValues?: ReadonlyMap<WorkflowTaskId, unknown>;
		taskSummaries?: ReadonlyMap<WorkflowTaskId, string>;
	}> {
		if (!state) return {};
		const wantsOutput =
			include.includes("output") &&
			state.outputArtifactId !== undefined &&
			isTerminalWorkflowRunStatus(state.status);
		const wantsSummaries =
			include.includes("output") && include.includes("tasks");
		const decided = include.includes("tasks") ? decidedCheckpoints(state) : [];
		if (!wantsOutput && !wantsSummaries && decided.length === 0) return {};
		const stores = await readOnlyStores(runIdValue);
		return {
			...(wantsOutput
				? { output: await committedOutput(state, stores.artifacts) }
				: {}),
			...(decided.length > 0
				? {
						decisionValues: await decidedValues(decided, stores.decisions),
					}
				: {}),
			...(wantsSummaries
				? { taskSummaries: await taskResultSummaries(state, stores.artifacts) }
				: {}),
		};
	}

	/**
	 * A bounded human summary of every task's committed `result` artifact, so a
	 * host can post "what this task said" without reading an artifact itself and
	 * without a second call per task.
	 *
	 * Only `output: "result"` artifacts are read - a handoff artifact is a patch,
	 * and the descriptor of it is already on the task view - and only for on-path
	 * tasks. A read or digest check that fails leaves that one task without a
	 * summary rather than failing the whole inspection: the summary is narration,
	 * and the journal already carries the facts a decision rests on.
	 */
	async function taskResultSummaries(
		state: WorkflowStateProjection,
		artifacts: WorkflowArtifactStore,
	): Promise<ReadonlyMap<WorkflowTaskId, string>> {
		const summaries = new Map<WorkflowTaskId, string>();
		for (const artifact of Object.values(state.artifacts)) {
			if (artifact.output !== "result" || !artifact.producerTaskId) continue;
			const task = state.tasks[artifact.producerTaskId];
			if (!task || task.abandoned === true) continue;
			try {
				const summary = narrationSummary(await artifacts.readJson(artifact));
				if (summary !== undefined) {
					summaries.set(artifact.producerTaskId, summary);
				}
			} catch {
				// A narration nobody can read is one task without a summary, never a
				// failed inspection.
			}
		}
		return summaries;
	}

	/** The run's committed output value, digest-verified by the store. */
	async function committedOutput(
		state: WorkflowStateProjection,
		artifacts: WorkflowArtifactStore,
	): Promise<unknown> {
		const artifact = state.outputArtifactId
			? state.artifacts[state.outputArtifactId]
			: undefined;
		if (!artifact) {
			throw new WorkflowServiceError(
				"persistence",
				"Workflow output artifact metadata is missing.",
			);
		}
		try {
			return await artifacts.readJson(artifact);
		} catch (error) {
			throw new WorkflowServiceError(
				"persistence",
				"Workflow output could not be read and verified.",
				{ cause: error },
			);
		}
	}

	/**
	 * Every on-path checkpoint task whose current execution carries a durable
	 * request and decision, with the binding its decision record is filed
	 * under.
	 */
	function decidedCheckpoints(state: WorkflowStateProjection): readonly {
		taskId: WorkflowTaskId;
		decisionSha256: string;
		binding: WorkflowDecisionBinding;
	}[] {
		const decided: {
			taskId: WorkflowTaskId;
			decisionSha256: string;
			binding: WorkflowDecisionBinding;
		}[] = [];
		for (const task of Object.values(state.tasks)) {
			const spec = task.task.spec;
			if (spec.kind !== "checkpoint" || task.abandoned === true) continue;
			const execution = task.currentExecutionId
				? state.executions[task.currentExecutionId]
				: undefined;
			const request = execution?.checkpointRequest;
			const decision = execution?.checkpointDecision;
			if (!execution || !request || !decision) continue;
			decided.push({
				taskId: task.task.id,
				decisionSha256: decision.decisionSha256,
				binding: {
					kind: "checkpoint",
					runId: state.runId,
					taskId: task.task.id,
					executionId: execution.execution.id,
					effectSha256: deriveCheckpointEffectSha256({
						taskIdentitySha256: spec.identitySha256,
						inputsSha256: request.inputsSha256,
					}),
				},
			});
		}
		return decided;
	}

	/**
	 * The decided value of each checkpoint, from its durable decision record.
	 * The journal is authoritative: a record whose value digest differs from
	 * the journalled decision digest is refused rather than shown, and a run
	 * that has no record for a binding simply carries no value.
	 */
	async function decidedValues(
		decided: ReturnType<typeof decidedCheckpoints>,
		decisions: WorkflowDecisionRecordStore,
	): Promise<ReadonlyMap<WorkflowTaskId, unknown>> {
		const values = new Map<WorkflowTaskId, unknown>();
		for (const checkpoint of decided) {
			let record: WorkflowDecisionRecord | undefined;
			try {
				record = await decisions.read(checkpoint.binding);
			} catch (error) {
				throw new WorkflowServiceError(
					"persistence",
					CHECKPOINT_DECISION_UNVERIFIED_MESSAGE,
					{ cause: error },
				);
			}
			if (!record) continue;
			if (record.valueSha256 !== checkpoint.decisionSha256) {
				throw new WorkflowServiceError(
					"persistence",
					CHECKPOINT_DECISION_UNVERIFIED_MESSAGE,
				);
			}
			values.set(checkpoint.taskId, record.value);
		}
		return values;
	}

	/**
	 * The run's record, complete journal prefix, and reduction without taking
	 * a lease: owned runs read through their own journal, every other run
	 * through the unleased readers.
	 */
	async function readCurrent(runIdValue: WorkflowRunId): Promise<{
		record: WorkflowRunRecord;
		events: readonly WorkflowJournalEvent[];
		state: WorkflowStateProjection | undefined;
		ownership: WorkflowRunOwnership;
		driving: boolean;
	}> {
		const current = owned.get(runIdValue);
		if (current) {
			let read: Awaited<ReturnType<WorkflowRunJournal["readProjected"]>>;
			try {
				read = await current.journal.readProjected();
			} catch (error) {
				if (error instanceof WorkflowPersistenceCorruptionError) {
					throw new WorkflowServiceError(
						"persistence",
						"Workflow run journal is corrupt.",
						{ cause: error },
					);
				}
				throw error;
			}
			return {
				record: current.record,
				events: read.events,
				state: read.state,
				ownership: "owned",
				driving: !current.settled,
			};
		}
		const directory = path.join(storeRoot, "runs", runIdValue);
		const notFound = () =>
			new WorkflowServiceError(
				"not-found",
				`Workflow run not found: ${runIdValue}`,
			);
		let metadata: Stats;
		try {
			metadata = await lstat(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notFound();
			throw error;
		}
		// An entry that is not a run directory (a file or a symlink) is "no such
		// run" to a reader, exactly like a missing entry.
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw notFound();
		let record: WorkflowRunRecord;
		try {
			record = await WorkflowRunRecordStore.readFrom(directory, runIdValue);
		} catch (error) {
			if (error instanceof WorkflowRunRecordError) {
				throw new WorkflowServiceError(
					"persistence",
					"Workflow run record is invalid.",
					{ cause: error },
				);
			}
			throw error;
		}
		let events: readonly WorkflowJournalEvent[];
		let state: WorkflowStateProjection | undefined;
		try {
			events = (await readWorkflowJournalUnleased(storeRoot, runIdValue))
				.events;
			try {
				state = events.length > 0 ? reduceWorkflowEvents(events) : undefined;
			} catch (error) {
				if (!(error instanceof WorkflowEventReductionError)) throw error;
				throw new WorkflowPersistenceCorruptionError(
					"workflow journal violates run invariants",
					{ cause: error },
				);
			}
		} catch (error) {
			if (error instanceof WorkflowPersistenceCorruptionError) {
				throw new WorkflowServiceError(
					"persistence",
					"Workflow run journal is corrupt.",
					{ cause: error },
				);
			}
			throw error;
		}
		return {
			record,
			events,
			state,
			ownership: await ownershipOf(runIdValue),
			driving: false,
		};
	}

	/**
	 * The shared invalidation flow behind `invalidate` and `retry`: the
	 * precondition block in its normative order, the drive settle, `guard` on
	 * the reduced state, then the closure, `task-invalidated`, the recovery
	 * transition, and the restarted drive.
	 */
	async function invalidateCurrent(
		runIdValue: WorkflowRunId,
		causeTaskId: WorkflowTaskId,
		reason: string,
		guard?: (state: WorkflowStateProjection) => void,
	): Promise<WorkflowServiceRunView> {
		const { view: current, state: durable } = await snapshotCurrent(runIdValue);
		const active = owned.get(runIdValue);
		if (active && !active.settled) {
			throw new WorkflowServiceError(
				"conflict",
				"Workflow run is still being driven.",
			);
		}
		if (!admitsInvalidation(current.status)) {
			throw new WorkflowServiceError(
				"validation",
				"Workflow run status does not admit invalidation.",
			);
		}
		if (isNestedRun(current)) {
			throw new WorkflowServiceError(
				"validation",
				"Nested workflow runs are invalidated through their parent run.",
			);
		}
		if (durable !== undefined && awaitsRecovery(durable)) {
			throw recoveryRefusal(durable);
		}
		// Checked before the run is composed: resuming an expired run starts
		// a drive that immediately stops on its deadline and cancels the run,
		// consuming the only recovery path the operator has left.
		if (deadlinePassed(current.deadlineAt, Date.now())) {
			throw new WorkflowServiceError(
				"validation",
				"Workflow run deadline has passed.",
			);
		}
		// A settled owned run still holds its lease, so it is reused rather
		// than resumed; an inactive run is composed, and its initial drive of
		// a failed or interrupted run settles before anything is appended.
		const run = active ?? (await resume(runIdValue));
		await run.drive;
		const state = await run.journal.readState();
		if (!admitsInvalidation(state.status)) {
			throw new WorkflowServiceError(
				"validation",
				"Workflow run status does not admit invalidation.",
			);
		}
		guard?.(state);
		let closure: WorkflowInvalidationClosure;
		try {
			closure = invalidationClosure(state, causeTaskId);
		} catch (error) {
			throw reducerRejection(error);
		}
		await appendOperatorEvent(run.journal, {
			type: "task-invalidated",
			data: {
				causeTaskId,
				taskIds: closure.taskIds,
				abandonedEpochs: closure.abandonedEpochs,
				reason,
			},
		});
		// The recovery transition is appended here so the returned view is
		// already running; a crash before it is repaired by the runtime,
		// which performs the same transition when it finds invalidated work.
		await appendOperatorEvent(run.journal, {
			type: "run-status-changed",
			data: {
				from: state.status,
				to: "running",
				reason: "Explicit invalidation re-executes invalidated tasks.",
			},
		});
		// The restarted drive is not awaited here; wait() observes it.
		void run.restart();
		return statusCurrent(runIdValue);
	}

	function reconcileSide(
		execution: TaskExecutionProjection,
	): WorkflowReconciledExecution["before"] {
		const childStatus =
			execution.settlement?.evidence.status ??
			execution.nestedSettlement?.status ??
			execution.observation?.status ??
			currentSubagentAttempt(execution)?.status;
		return Object.freeze({
			phase: execution.phase,
			...(execution.terminal ? { outcome: execution.terminal.outcome } : {}),
			...(childStatus === undefined ? {} : { childStatus }),
		});
	}

	function knownTask(
		view: WorkflowServiceRunView,
		taskId: WorkflowTaskId,
	): WorkflowServiceTaskView {
		const task = (view.tasks ?? []).find(
			(candidate) => candidate.id === taskId && candidate.abandoned !== true,
		);
		if (!task) {
			throw new WorkflowServiceError("validation", "Unknown workflow task.");
		}
		return task;
	}

	function assertReconcilable(
		view: WorkflowServiceRunView,
		taskId: WorkflowTaskId,
	): void {
		const task = knownTask(view, taskId);
		if (task.status !== "cleanup-blocked") {
			throw new WorkflowServiceError(
				"validation",
				"Workflow task is not cleanup-blocked.",
			);
		}
	}

	async function reconcileCurrent(
		runIdValue: WorkflowRunId,
		taskId?: WorkflowTaskId,
	): Promise<WorkflowServiceReconcileView> {
		const current = await statusCurrent(runIdValue);
		// A named task is refused against the durable view before any lease or
		// drive is touched: an unknown task always, a task that is not
		// cleanup-blocked only when the run is not already completed (a
		// completed run has nothing to reconcile and reports an empty list).
		// The check repeats after the drive settles because the drive itself
		// may have resolved the task.
		if (taskId !== undefined) knownTask(current, taskId);
		if (
			current.status === "completed" ||
			current.status === "completed-degraded"
		) {
			return Object.freeze({ ...current, reconciled: Object.freeze([]) });
		}
		if (taskId !== undefined) assertReconcilable(current, taskId);
		// A settled owned run still holds its lease, so it is reused rather than
		// resumed, exactly as invalidate does.
		const run = owned.get(runIdValue) ?? (await resume(runIdValue));
		await run.drive;
		let view = await statusCurrent(runIdValue);
		if (taskId !== undefined) assertReconcilable(view, taskId);
		const reconciled: WorkflowReconciledExecution[] = [];
		const attempted = new Set<WorkflowTaskId>();
		// One pass per on-path task at most: each iteration reconciles a task
		// that no earlier iteration touched, so the loop is bounded by the
		// task count even when the run stays cleanup-blocked.
		const bound = (view.tasks ?? []).length;
		for (let round = 0; round < bound; round++) {
			if (view.status !== "cleanup-blocked") break;
			const state = await run.journal.readState();
			const task = Object.values(state.tasks)
				.filter(
					(candidate) =>
						candidate.abandoned !== true &&
						candidate.status === "cleanup-blocked" &&
						!attempted.has(candidate.task.id) &&
						(taskId === undefined || candidate.task.id === taskId),
				)
				.sort(
					(left, right) =>
						left.task.materializationSequence -
						right.task.materializationSequence,
				)[0];
			if (!task) {
				if (reconciled.length === 0) {
					throw new WorkflowServiceError(
						"execution",
						"Cleanup-blocked workflow has no blocked task.",
					);
				}
				break;
			}
			attempted.add(task.task.id);
			const execution = task.currentExecutionId
				? state.executions[task.currentExecutionId]
				: undefined;
			if (!execution) {
				throw new WorkflowServiceError(
					"execution",
					"Cleanup-blocked task has no reconcilable execution evidence.",
				);
			}
			const before = reconcileSide(execution);
			let subagent: WorkflowReconciledExecution["subagent"];
			if (
				execution.phase === "terminal" &&
				execution.terminal?.outcome === "cleanup-blocked"
			) {
				const outcome = await run.scheduler.reconcile(task.task.id);
				if (outcome.subagent) {
					subagent = Object.freeze({
						sandboxProcess: outcome.subagent.sandboxProcess,
						workspace: outcome.subagent.workspace,
					});
				}
			} else if (execution.settlement) {
				await run.finalizer.finalize(task.task.id);
			} else {
				throw new WorkflowServiceError(
					"execution",
					"Cleanup-blocked task has no reconcilable execution evidence.",
				);
			}
			// The settled drive cached its view before these appends.
			delete run.view;
			const afterState = await run.journal.readState();
			const afterExecution =
				afterState.executions[execution.execution.id] ?? execution;
			reconciled.push(
				Object.freeze({
					taskId: task.task.id,
					executionId: execution.execution.id,
					before,
					after: reconcileSide(afterExecution),
					...(subagent ? { subagent } : {}),
				}),
			);
			view = await statusCurrent(runIdValue);
			if (taskId !== undefined) break;
		}
		if (view.status === "running" || view.status === "waiting") {
			await run.restart();
			view = await statusCurrent(runIdValue);
		}
		if (run.failure && !isTerminalWorkflowRunStatus(view.status)) {
			throw new WorkflowServiceError(
				"execution",
				"Workflow reconciliation ended without durable terminal state.",
				{ cause: run.failure },
			);
		}
		return Object.freeze({ ...view, reconciled: Object.freeze(reconciled) });
	}
}

/**
 * W1-PROVIDER (spec 2.4): the lease-free dry materialization behind
 * `WorkflowService.project`.
 *
 * A definition's graph is a function of its input, so the only honest way to
 * answer "what does this run reserve?" before starting it is to run the
 * definition's `run(ctx)` against a context that declares nothing durable.
 * Every `ctx` member here records the declaration and returns immediately:
 * no journal, no lease, no task identity, no subagent, no filesystem. A
 * barrier (`result`, `results`, `settled`, `handoff`) resolves with a value
 * synthesized from the declared output schema so the definition walks its own
 * graph to the end instead of stopping at the first await.
 *
 * The projection is therefore a *worst case*: a boolean decision synthesizes
 * as `true`, which is the branch that declares the most work (an approval
 * gate that is answered "no" declares nothing after it). Nothing outside this
 * module observes the synthesized values.
 */
const PROJECTION_RUN_ID = "workflow_projection" as WorkflowRunId;
const MAX_PROJECTED_TASKS = 1_024;
const MAX_PROJECTION_DEPTH = 12;
const MAX_PROJECTED_ARRAY_ITEMS = 16;
const PROJECTION_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export const WORKFLOW_PROJECTION_TOO_LARGE_MESSAGE = `Workflow projection exceeded ${MAX_PROJECTED_TASKS} declared tasks.`;
export const WORKFLOW_PROJECTION_DYNAMIC_MESSAGE =
	"Workflow projection is static-definition only; a dynamic proposal is not projected.";
export const WORKFLOW_PROJECTION_FAILED_MESSAGE =
	"Workflow definition could not be projected for this input.";

/** The stand-in a projected worktree task's handoff barrier resolves to. */
const PROJECTION_HANDOFF: WorkflowHandoffDescriptor = Object.freeze({
	artifactId: `artifact_${"0".repeat(64)}`,
	runId: PROJECTION_RUN_ID,
	producerTaskId: "task_projection",
	producerExecutionId: "exec_projection",
	subagentRunId: "run_projection",
	subagentAttemptId: "attempt_projection",
	baselineHead: "0".repeat(40),
	handoffCommit: "0".repeat(40),
	format: "git-format-patch",
	mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
	sha256: "0".repeat(64),
	bytes: 1,
});

/**
 * A deterministic value for a JSON Schema document, used only to unblock a
 * projected barrier. It never validates and never leaves this module: it
 * exists so `run(ctx)` can read `.checkRan` or `.findings` without throwing.
 */
function synthesizeValue(schema: unknown, depth = 0): unknown {
	if (
		depth > MAX_PROJECTION_DEPTH ||
		typeof schema !== "object" ||
		schema === null
	) {
		return {};
	}
	const node = schema as Record<string, unknown>;
	if ("const" in node) return node.const;
	if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		const branches = node[key];
		if (Array.isArray(branches) && branches.length > 0) {
			return synthesizeValue(branches[0], depth + 1);
		}
	}
	const type = Array.isArray(node.type) ? node.type[0] : node.type;
	switch (type) {
		case "boolean":
			return true;
		case "integer":
		case "number": {
			const minimum = typeof node.minimum === "number" ? node.minimum : 0;
			const maximum = typeof node.maximum === "number" ? node.maximum : minimum;
			return Math.min(minimum, maximum);
		}
		case "string": {
			if (node.format === "date-time") return PROJECTION_TIMESTAMP;
			const minLength = typeof node.minLength === "number" ? node.minLength : 0;
			return "x".repeat(Math.min(Math.max(minLength, 0), 64));
		}
		case "array": {
			const minItems = typeof node.minItems === "number" ? node.minItems : 0;
			const count = Math.min(Math.max(minItems, 0), MAX_PROJECTED_ARRAY_ITEMS);
			return Array.from({ length: count }, () =>
				synthesizeValue(node.items, depth + 1),
			);
		}
		case "null":
			return null;
		case "object": {
			const properties = node.properties;
			if (typeof properties !== "object" || properties === null) return {};
			const value: Record<string, unknown> = {};
			for (const [name, child] of Object.entries(
				properties as Record<string, unknown>,
			)) {
				value[name] = synthesizeValue(child, depth + 1);
			}
			return value;
		}
		default:
			return {};
	}
}

/** Everything one dry materialization observed about a declared graph. */
export interface WorkflowGraphProjection {
	readonly cost: number;
	readonly totalTokens: number;
	readonly childRuntimeMs: number;
	/** Declared tasks, finalizers included. */
	readonly tasks: number;
	/** Declared `ctx.checkpoint` tasks. */
	readonly checkpoints: number;
	/** Declared agent tasks whose workspace is a worktree. */
	readonly worktrees: number;
	/** Declared agent tasks that capture a handoff. */
	readonly handoffs: number;
}

export interface WorkflowGraphProjectionOptions {
	readonly cwd?: string;
	/** The `meta.budget` a nested workflow reserves, by definition name. */
	readonly childBudget?: (workflow: string) => WorkflowBudget | undefined;
}

/**
 * Dry-materializes `definition` against `input` and sums what the declared
 * graph reserves, by the same rule the scheduler reserves with
 * (`src/budget.ts`): an agent task reserves its `limits`, a nested workflow
 * task reserves the child definition's `meta.budget`, and a checkpoint or
 * support task reserves nothing.
 */
export async function projectWorkflowGraph(
	definition: WorkflowDefinition,
	input: unknown,
	options: WorkflowGraphProjectionOptions = {},
): Promise<WorkflowGraphProjection> {
	let cost = 0;
	let totalTokens = 0;
	let childRuntimeMs = 0;
	let tasks = 0;
	let checkpoints = 0;
	let worktrees = 0;
	let handoffs = 0;
	const schemas = new Map<string, unknown>();

	function nextTaskId(): string {
		tasks += 1;
		if (tasks > MAX_PROJECTED_TASKS) {
			throw new WorkflowServiceError(
				"validation",
				WORKFLOW_PROJECTION_TOO_LARGE_MESSAGE,
			);
		}
		return `task_p${tasks}`;
	}

	function handleFor(
		taskId: string,
		outputSchema: unknown,
		worktree: boolean,
	): TaskHandle<unknown> {
		schemas.set(taskId, outputSchema);
		const ref = { runId: PROJECTION_RUN_ID, taskId: taskId as WorkflowTaskId };
		const outputRef = {
			runId: PROJECTION_RUN_ID,
			producerTaskId: taskId as WorkflowTaskId,
			output: "result" as const,
		};
		return worktree
			? createTaskHandle(ref, outputRef, {
					runId: PROJECTION_RUN_ID,
					producerTaskId: taskId as WorkflowTaskId,
					output: "handoff" as const,
				})
			: createTaskHandle(ref, outputRef);
	}

	function declareAgent(
		request: AgentTaskAuthoringRequest<never>,
	): TaskHandle<unknown> {
		const taskId = nextTaskId();
		const limits = request.limits;
		cost += limits.cost;
		totalTokens += limits.totalTokens ?? 0;
		childRuntimeMs += limits.cumulativeRuntimeMs;
		const worktree = request.workspace?.mode === "worktree";
		if (worktree) worktrees += 1;
		if (worktree || request.handoff !== undefined) handoffs += 1;
		return handleFor(taskId, request.outputSchema, worktree);
	}

	function declareNested(request: NestedWorkflowRequest): TaskHandle<unknown> {
		const taskId = nextTaskId();
		const budget = options.childBudget?.(request.workflow);
		if (budget) {
			cost += budget.cost;
			totalTokens += budget.totalTokens ?? 0;
			childRuntimeMs += budget.childRuntimeMs;
		}
		return handleFor(taskId, undefined, false);
	}

	async function resolve(task: TaskHandle<unknown>): Promise<unknown> {
		return synthesizeValue(schemas.get(task.ref.taskId));
	}

	const context = {
		input,
		runId: PROJECTION_RUN_ID,
		cwd: options.cwd ?? process.cwd(),
		signal: new AbortController().signal,
		phase: () => undefined,
		log: () => undefined,
		agent: (_key: string, request: AgentTaskAuthoringRequest<never>) =>
			declareAgent(request),
		support: (_key: string, descriptor: { outputSchema?: unknown }) =>
			handleFor(nextTaskId(), descriptor.outputSchema, false),
		workflow: (_key: string, request: NestedWorkflowRequest) =>
			declareNested(request),
		checkpoint: (_key: string, request: { schema: unknown }) => {
			checkpoints += 1;
			return handleFor(nextTaskId(), request.schema, false);
		},
		fanOut: (
			_namespace: string,
			items: readonly unknown[],
			fanOptions: {
				task: (
					item: unknown,
					index: number,
				) => AgentTaskAuthoringRequest<never>;
			},
		) => items.map((item, index) => declareAgent(fanOptions.task(item, index))),
		fanIn: (
			_key: string,
			_sources: readonly TaskHandle<unknown>[],
			fanOptions: { task: AgentTaskAuthoringRequest<never> },
		) => declareAgent(fanOptions.task),
		pipeline: (
			_namespace: string,
			build: (stage: {
				agent: (
					key: string,
					request: AgentTaskAuthoringRequest<never>,
				) => TaskHandle<unknown>;
			}) => TaskHandle<unknown>,
		) => build({ agent: (_key, request) => declareAgent(request) }),
		finalize: (_key: string, request: FinalizeRequest<never>) => {
			if (request.agent) {
				return declareAgent(
					request.agent as unknown as AgentTaskAuthoringRequest<never>,
				);
			}
			if (request.workflow) return declareNested(request.workflow);
			return handleFor(nextTaskId(), request.support?.outputSchema, false);
		},
		result: resolve,
		results: (handles: readonly TaskHandle<unknown>[]) =>
			Promise.all(handles.map(resolve)),
		settled: async (handles: readonly TaskHandle<unknown>[]) =>
			Promise.all(
				handles.map(async (handle) => ({
					status: "fulfilled" as const,
					value: await resolve(handle),
				})),
			),
		handoff: async (task: TaskHandle<unknown>) =>
			task.handoff === undefined ? undefined : PROJECTION_HANDOFF,
	} as unknown as WorkflowContext<unknown>;

	try {
		await definition.run(context);
	} catch (error) {
		if (error instanceof WorkflowServiceError) throw error;
		throw new WorkflowServiceError(
			"validation",
			error instanceof Error
				? error.message
				: WORKFLOW_PROJECTION_FAILED_MESSAGE,
			{ cause: error },
		);
	}
	return Object.freeze({
		cost,
		totalTokens,
		childRuntimeMs,
		tasks,
		checkpoints,
		worktrees,
		handoffs,
	});
}

/** True when the projected totals stay inside `budget`. */
export function projectionFits(
	projection: WorkflowGraphProjection,
	budget: WorkflowBudget,
): boolean {
	if (projection.cost > budget.cost) return false;
	if (projection.childRuntimeMs > budget.childRuntimeMs) return false;
	if (
		budget.totalTokens !== undefined &&
		projection.totalTokens > budget.totalTokens
	) {
		return false;
	}
	return true;
}
