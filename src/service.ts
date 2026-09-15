import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Ajv } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import * as addFormatsModule from "ajv-formats";
import { Value } from "typebox/value";
import { WorkflowArtifactStore } from "./artifact-store.js";
import {
	MAX_WORKFLOW_CONCURRENCY,
	type NestedWorkflowInputArtifacts,
	WORKFLOW_CONTRACT_REVISION,
	type WorkflowRunId,
	WorkflowRunIdSchema,
	type WorkflowRunStatus,
	type WorkflowTaskId,
	WorkflowTaskIdSchema,
	type WorkflowTaskStatus,
} from "./contracts.js";
import {
	validateJsonSchemaDocument,
	type WorkflowBudget,
} from "./definition.js";
import type { WorkflowStateProjection } from "./events.js";
import {
	WorkflowNestedRunError,
	type WorkflowNestedRunLaunch,
	type WorkflowNestedRunProvider,
	type WorkflowNestedRunSettlement,
} from "./nested-run-executor.js";
import { WorkflowRunJournal } from "./persistence/journal.js";
import {
	acquireWorkflowRunLease,
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
	type WorkflowRunRecord,
	WorkflowRunRecordError,
	WorkflowRunRecordStore,
} from "./run-record.js";
import {
	createWorkflowSequentialScheduler,
	type WorkflowSequentialScheduler,
} from "./scheduler.js";
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

export type WorkflowServiceTaskView = {
	readonly id: WorkflowTaskId;
	readonly namespace: readonly string[];
	readonly key: string;
	readonly kind: "agent" | "support" | "workflow";
	readonly status: WorkflowTaskStatus;
	/** Generation of the task's current execution; 0 when it has none. */
	readonly generation: number;
	/** Declared in an abandoned epoch and not readopted by the current path. */
	readonly abandoned?: true;
};

export type WorkflowServiceRunView = WorkflowServiceRunReceipt & {
	readonly definitionName: string;
	readonly createdAt: string;
	/** Absolute deadline fixed at run creation. */
	readonly deadlineAt: string;
	readonly depth: number;
	readonly parent?: {
		readonly runId: WorkflowRunId;
		readonly taskId: string;
		readonly inputArtifacts: NestedWorkflowInputArtifacts;
	};
	readonly output?: unknown;
	readonly outputArtifactId?: string;
	/** Every declared task in materialization order; absent until events exist. */
	readonly tasks?: readonly WorkflowServiceTaskView[];
};

export interface WorkflowService {
	registerRoot(root: WorkflowRoot): Promise<void>;
	list(): Promise<readonly WorkflowDefinitionSummary[]>;
	validate(ref: string, input?: unknown): Promise<WorkflowValidationResult>;
	run(ref: string, input: unknown): Promise<WorkflowServiceRunReceipt>;
	status(runId: WorkflowRunId): Promise<WorkflowServiceRunView>;
	wait(runId: WorkflowRunId): Promise<WorkflowServiceRunView>;
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
	reconcile(runId: WorkflowRunId): Promise<WorkflowServiceRunView>;
	shutdown(): Promise<void>;
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

function isTerminalStatus(status: WorkflowRunStatus): boolean {
	return (
		status === "completed" ||
		status === "completed-degraded" ||
		status === "failed" ||
		status === "cancelled" ||
		status === "interrupted" ||
		status === "cleanup-blocked"
	);
}

function runId(): WorkflowRunId {
	return `workflow_${randomUUID().replaceAll("-", "")}`;
}

/**
 * A durably failed or interrupted run whose on-path work was invalidated is
 * not final: the next drive performs the explicit recovery.
 */
function awaitsRecovery(view: WorkflowServiceRunView): boolean {
	return (
		(view.status === "failed" || view.status === "interrupted") &&
		(view.tasks ?? []).some(
			(task) => task.status === "invalidated" && task.abandoned !== true,
		)
	);
}

function admitsInvalidation(status: WorkflowRunStatus): boolean {
	return status === "failed" || status === "interrupted";
}

function taskViews(
	state: WorkflowStateProjection,
): readonly WorkflowServiceTaskView[] {
	return Object.freeze(
		Object.values(state.tasks)
			.sort(
				(left, right) =>
					left.task.materializationSequence -
					right.task.materializationSequence,
			)
			.map((task) => {
				const generation = Object.values(state.executions).reduce(
					(highest, execution) =>
						execution.execution.taskId === task.task.id
							? Math.max(highest, execution.execution.generation)
							: highest,
					0,
				);
				return Object.freeze({
					id: task.task.id,
					namespace: Object.freeze([...task.task.namespace]),
					key: task.task.spec.key,
					kind: task.task.spec.kind,
					status: task.status,
					generation,
					...(task.abandoned === true ? { abandoned: true as const } : {}),
				});
			}),
	);
}

/**
 * Surfaces a reducer or closure failure as a validation error carrying the
 * reducer's own message. The journal wraps reducer failures as the cause of an
 * invariant error, so that wrapper is unwrapped first.
 */
function invalidationRejection(error: unknown): WorkflowServiceError {
	const cause =
		error instanceof Error && error.cause instanceof WorkflowEventReductionError
			? error.cause
			: error;
	if (cause instanceof Error) {
		return new WorkflowServiceError("validation", cause.message, { cause });
	}
	return new WorkflowServiceError(
		"validation",
		"Workflow invalidation was rejected.",
		{ cause },
	);
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
	let closed = false;
	let tail = Promise.resolve();

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
		if (events.length === 0) {
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
		const state = reduceWorkflowEvents(events);
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
		let cost = 0;
		let totalTokens = 0;
		let childRuntimeMs = 0;
		let usageComplete = true;
		for (const execution of Object.values(state.executions)) {
			if (execution.settlement) {
				cost += execution.settlement.evidence.usage.cost;
				totalTokens += execution.settlement.evidence.usage.totalTokens;
				childRuntimeMs += execution.settlement.evidence.runtimeMs;
				usageComplete &&= execution.settlement.evidence.usageComplete;
			}
			if (execution.nestedSettlement) {
				cost += execution.nestedSettlement.usage.cost;
				totalTokens += execution.nestedSettlement.usage.totalTokens;
				childRuntimeMs += execution.nestedSettlement.usage.childRuntimeMs;
				usageComplete &&= execution.nestedSettlement.usageComplete;
			}
		}
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
		if (!Value.Check(WorkflowRunIdSchema, runIdValue)) {
			throw new WorkflowServiceError("validation", "Invalid workflow run ID.");
		}
		const current = owned.get(runIdValue);
		if (current) {
			if (current.settled && current.view) return current.view;
			return viewFrom(current.record, current.journal, current.artifacts);
		}
		const opened = await openInactive(runIdValue);
		try {
			const artifacts = await WorkflowArtifactStore.open({
				journal: opened.journal,
			});
			return await viewFrom(opened.record, opened.journal, artifacts);
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
					const journal = await WorkflowRunJournal.open(storeRoot, id, lease);
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
		async wait(runIdValue: WorkflowRunId) {
			assertOpen();
			let run = owned.get(runIdValue);
			if (!run) {
				const current = await statusCurrent(runIdValue);
				if (isTerminalStatus(current.status) && !awaitsRecovery(current)) {
					return current;
				}
				run = await resume(runIdValue);
			}
			if (!run.settled) await run.drive;
			const view = await statusCurrent(runIdValue);
			if (run.failure && !isTerminalStatus(view.status)) {
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
			if (isTerminalStatus(current.status)) return current;
			const run = await resume(runIdValue);
			await run.scheduler.stop(reason);
			await run.drive;
			return statusCurrent(runIdValue);
		},
		invalidate(runIdValue: WorkflowRunId, causeTaskId: string, reason: string) {
			return exclusive(async () => {
				assertOpen();
				if (!Value.Check(WorkflowRunIdSchema, runIdValue)) {
					throw new WorkflowServiceError(
						"validation",
						"Invalid workflow run ID.",
					);
				}
				if (!Value.Check(WorkflowTaskIdSchema, causeTaskId)) {
					throw new WorkflowServiceError(
						"validation",
						"Invalid workflow task ID.",
					);
				}
				if (
					typeof reason !== "string" ||
					reason.length < 1 ||
					reason.length > 4096
				) {
					throw new WorkflowServiceError(
						"validation",
						"Invalid workflow invalidation reason.",
					);
				}
				const current = await statusCurrent(runIdValue);
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
				if (current.parent) {
					throw new WorkflowServiceError(
						"validation",
						"Nested workflow runs are invalidated through their parent run.",
					);
				}
				if (awaitsRecovery(current)) {
					throw new WorkflowServiceError(
						"validation",
						"Workflow run already awaits recovery of invalidated work.",
					);
				}
				// Checked before the run is composed: resuming an expired run starts
				// a drive that immediately stops on its deadline and cancels the run,
				// consuming the only recovery path the operator has left.
				if (Date.parse(current.deadlineAt) <= Date.now()) {
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
				let closure: WorkflowInvalidationClosure;
				try {
					closure = invalidationClosure(state, causeTaskId);
				} catch (error) {
					throw invalidationRejection(error);
				}
				try {
					await run.journal.appendEvent({
						type: "task-invalidated",
						data: {
							causeTaskId,
							taskIds: closure.taskIds,
							abandonedEpochs: closure.abandonedEpochs,
							reason,
						},
					});
				} catch (error) {
					if (
						error instanceof Error &&
						error.cause instanceof WorkflowEventReductionError
					) {
						throw invalidationRejection(error);
					}
					throw error;
				}
				// The recovery transition is appended here so the returned view is
				// already running; a crash before it is repaired by the runtime,
				// which performs the same transition when it finds invalidated work.
				await run.journal.appendEvent({
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
			});
		},
		async reconcile(runIdValue: WorkflowRunId) {
			assertOpen();
			return reconcileCurrent(runIdValue);
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
			});
		},
	});

	async function reconcileCurrent(
		runIdValue: WorkflowRunId,
	): Promise<WorkflowServiceRunView> {
		{
			const current = await statusCurrent(runIdValue);
			if (
				current.status === "completed" ||
				current.status === "completed-degraded"
			) {
				return current;
			}
			const run = await resume(runIdValue);
			await run.drive;
			let view = await statusCurrent(runIdValue);
			if (view.status === "cleanup-blocked") {
				const state = reduceWorkflowEvents(await run.journal.readEvents());
				const task = Object.values(state.tasks).find(
					(candidate) =>
						candidate.abandoned !== true &&
						candidate.status === "cleanup-blocked",
				);
				if (!task) {
					throw new WorkflowServiceError(
						"execution",
						"Cleanup-blocked workflow has no blocked task.",
					);
				}
				const execution = task.currentExecutionId
					? state.executions[task.currentExecutionId]
					: undefined;
				if (
					execution?.phase === "terminal" &&
					execution.terminal?.outcome === "cleanup-blocked"
				) {
					await run.scheduler.reconcile(task.task.id);
				} else if (execution?.settlement) {
					await run.finalizer.finalize(task.task.id);
				} else {
					throw new WorkflowServiceError(
						"execution",
						"Cleanup-blocked task has no reconcilable execution evidence.",
					);
				}
				view = await statusCurrent(runIdValue);
				if (view.status === "running" || view.status === "waiting") {
					await run.restart();
					view = await statusCurrent(runIdValue);
				}
			}
			if (run.failure && !isTerminalStatus(view.status)) {
				throw new WorkflowServiceError(
					"execution",
					"Workflow reconciliation ended without durable terminal state.",
					{ cause: run.failure },
				);
			}
			return view;
		}
	}
}
