import { randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Ajv } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import * as addFormatsModule from "ajv-formats";
import { Value } from "typebox/value";
import { WorkflowArtifactStore } from "./artifact-store.js";
import {
	currentSubagentAttempt,
	currentSubagentAttemptId,
} from "./attempts.js";
import { settledWorkflowUsage } from "./budget.js";
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
	validateJsonSchemaDocument,
	type WorkflowBudget,
} from "./definition.js";
import type {
	TaskExecutionProjection,
	WorkflowStateProjection,
} from "./events.js";
import { deriveWorkflowHandoffDescriptor } from "./execution.js";
import {
	verifyWorkflowHandoffEvidence,
	WORKFLOW_HANDOFF_UNVERIFIED_MESSAGE,
} from "./handoff.js";
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
	decodeWorkflowRunCursor,
	encodeWorkflowRunCursor,
	invalidationPreview,
	isCompletedWorktreeTask,
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
import {
	createWorkflowSequentialScheduler,
	type WorkflowSequentialScheduler,
} from "./scheduler.js";
import {
	MAX_WORKFLOW_RUN_LIST_ISSUES,
	type WorkflowInspectOptions,
	WorkflowInspectOptionsSchema,
	type WorkflowInvalidationPreview,
	type WorkflowLogOptions,
	WorkflowLogOptionsSchema,
	type WorkflowLogPage,
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
import { createStaticWorkflowRuntime } from "./static-runtime.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "./subagent-provider.js";
import {
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

export type {
	WorkflowServiceRunView,
	WorkflowServiceTaskView,
} from "./service-views.js";

export type WorkflowRunListener = (observation: WorkflowRunObservation) => void;

export type WorkflowServiceHandoffExport = {
	readonly descriptor: WorkflowHandoffDescriptor;
	/** The verified `git format-patch` bytes the descriptor names. */
	readonly content: Buffer;
};

const NO_HANDOFF_ARTIFACT_MESSAGE = "Workflow task has no handoff artifact.";

export interface WorkflowService {
	registerRoot(root: WorkflowRoot): Promise<void>;
	list(): Promise<readonly WorkflowDefinitionSummary[]>;
	validate(ref: string, input?: unknown): Promise<WorkflowValidationResult>;
	run(ref: string, input: unknown): Promise<WorkflowServiceRunReceipt>;
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
	/** Lease-free scan of every durable run in the store, newest first. */
	listRuns(query?: WorkflowRunQuery): Promise<WorkflowRunPage>;
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
	readonly maxConcurrency?: number;
	readonly maxWorkflowCost?: number;
	readonly maxWorkflowTotalTokens?: number;
	readonly maxWorkflowChildRuntimeMs?: number;
	readonly maxWorkflowTimeoutMs?: number;
	readonly supportTasks?: readonly SupportTaskRegistration[];
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
	binding: WorkflowSubagentBinding;
	scheduler: WorkflowSequentialScheduler;
	finalizer: WorkflowTaskFinalizer;
	drive: Promise<void>;
	restart(): Promise<void>;
	settled: boolean;
	view?: WorkflowServiceRunView;
	failure?: Error;
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
	const supportTasks = new Map<string, SupportTaskRegistration>();
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
	const cwd = await realpath(options.cwd);
	const storeRoot = path.resolve(options.storeRoot);
	const roots: WorkflowRoot[] = [];
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
			onAppended: ({ event, status }) =>
				emit(
					Object.freeze({
						runId: runIdValue,
						status,
						sequence: event.sequence,
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
		if (!ref || ref.length > 4096) {
			throw new WorkflowServiceError(
				"validation",
				"Invalid workflow reference.",
			);
		}
		const workflows = await discover();
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

	async function compose(
		record: WorkflowRunRecord,
		workflow: DiscoveredWorkflow,
		lease: WorkflowRunLease,
		binding: WorkflowSubagentBinding,
	): Promise<OwnedRun> {
		const journal = await WorkflowRunJournal.open(
			storeRoot,
			record.runId,
			lease,
			journalOptions(record.runId),
		);
		const artifacts = await WorkflowArtifactStore.open({ journal });
		const discovered = await discover();
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
		const launcher = createWorkflowTaskLauncher({
			journal,
			binding,
			artifacts,
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
			nestedRuns: nestedProvider,
			nesting,
			concurrency: record.concurrency,
			budget: record.effectiveBudget,
		});
		const ownedRun: OwnedRun = {
			record,
			lease,
			journal,
			artifacts,
			binding,
			scheduler,
			finalizer,
			drive: Promise.resolve(),
			restart: async () => undefined,
			settled: false,
		};
		const startDrive = () => {
			ownedRun.settled = false;
			delete ownedRun.failure;
			delete ownedRun.view;
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
				.then(() => undefined);
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
				});
			return ownedRun.drive;
		};
		ownedRun.restart = startDrive;
		startDrive();
		return ownedRun;
	}

	async function workflowForRecord(
		record: WorkflowRunRecord,
	): Promise<DiscoveredWorkflow> {
		const workflow = await resolve(record.definitionPath);
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

	async function viewFrom(
		record: WorkflowRunRecord,
		journal: WorkflowRunJournal,
		artifacts?: WorkflowArtifactStore,
	): Promise<WorkflowServiceRunView> {
		const events = await journal.readEvents();
		return viewFromState(
			record,
			events.length === 0 ? undefined : reduceWorkflowEvents(events),
			artifacts,
		);
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
		return Object.freeze({
			runId: record.runId,
			status: state.status,
			definitionName: record.definitionName,
			createdAt: record.createdAt,
			deadlineAt: record.deadlineAt,
			depth: record.depth,
			...lineageOf(record),
			...(state.outputArtifactId
				? { outputArtifactId: state.outputArtifactId }
				: {}),
			...(output === undefined ? {} : { output }),
			tasks: taskViews(state),
		});
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
		const events = await journal.readEvents();
		const state =
			events.length === 0 ? undefined : reduceWorkflowEvents(events);
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
		const state = reduceWorkflowEvents(await journal.readEvents());
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
				};
				await WorkflowRunRecordStore.open(journal).create(record);
				const run = await compose(record, workflow, lease, binding);
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
			await run.drive;
			const settlement = await nestedSettlementFrom(run.record, run.journal);
			if (!settlement) {
				throw new WorkflowNestedRunError(
					"persistence",
					"Nested workflow run ended without durable terminal state.",
					{ cause: run.failure },
				);
			}
			return settlement;
		},
		async readOutput(childRunId: WorkflowRunId, artifactId: string) {
			const current = owned.get(childRunId);
			if (current) {
				const state = reduceWorkflowEvents(await current.journal.readEvents());
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
				const state = reduceWorkflowEvents(await opened.journal.readEvents());
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
			if (run.settled) return;
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
			const events = await current.journal.readEvents();
			const state =
				events.length === 0 ? undefined : reduceWorkflowEvents(events);
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
			const events = await opened.journal.readEvents();
			const state =
				events.length === 0 ? undefined : reduceWorkflowEvents(events);
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
			const workflow = await workflowForRecord(opened.record);
			const binding = await options.subagents.bind(runIdValue);
			const run = await compose(opened.record, workflow, opened.lease, binding);
			owned.set(runIdValue, run);
			return run;
		} catch (error) {
			await opened.lease.release();
			throw error;
		}
	}

	return Object.freeze({
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
			const workflow = await resolve(ref);
			if (input !== undefined) validateInput(workflow, input);
			return Object.freeze({
				valid: true as const,
				workflow: summary(workflow),
			});
		},
		run(ref: string, input: unknown) {
			return exclusive(async () => {
				assertOpen();
				const workflow = await resolve(ref);
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
					const createdAt = new Date();
					const record: WorkflowRunRecord = {
						schema: "pi-workflow-run",
						contractRevision: WORKFLOW_CONTRACT_REVISION,
						runId: id,
						depth: 0,
						definitionName: workflow.definition.meta.name,
						definitionPath: workflow.path,
						definitionIdentitySha256: workflow.identity.identitySha256,
						definitionSourceSha256: workflow.identity.sourceSha256,
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
					};
					await WorkflowRunRecordStore.open(journal).create(record);
					const run = await compose(record, workflow, lease, binding);
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
			if (!run.settled) {
				const timedOut = await outlives(run.drive, options.timeoutMs);
				if (timedOut) {
					return Object.freeze({
						...(await statusCurrent(runIdValue)),
						timedOut: true as const,
					});
				}
			}
			const view = await statusCurrent(runIdValue);
			if (run.failure && !isTerminalWorkflowRunStatus(view.status)) {
				throw new WorkflowServiceError(
					"execution",
					"Workflow drive ended without durable terminal state.",
					{ cause: run.failure },
				);
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
			return view;
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
				const state = reduceWorkflowEvents(await run.journal.readEvents());
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
		shutdown() {
			return exclusive(async () => {
				if (closed) return;
				closed = true;
				const runs = [...owned.values()].sort(
					(left, right) => left.record.depth - right.record.depth,
				);
				const depths = [...new Set(runs.map((run) => run.record.depth))];
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
		subscribe(listener: WorkflowRunListener) {
			assertOpen();
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	});

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
			let events: readonly WorkflowJournalEvent[];
			try {
				events = await current.journal.readEvents();
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
				events,
				state: events.length > 0 ? reduceWorkflowEvents(events) : undefined,
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
		const state = reduceWorkflowEvents(await run.journal.readEvents());
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
			const state = reduceWorkflowEvents(await run.journal.readEvents());
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
			const afterState = reduceWorkflowEvents(await run.journal.readEvents());
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
