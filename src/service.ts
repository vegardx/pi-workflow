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
	WORKFLOW_CONTRACT_REVISION,
	type WorkflowRunId,
	WorkflowRunIdSchema,
	type WorkflowRunStatus,
} from "./contracts.js";
import { WorkflowRunJournal } from "./persistence/journal.js";
import {
	acquireWorkflowRunLease,
	WorkflowPersistenceCorruptionError,
	type WorkflowRunLease,
	WorkflowRunLeaseUnavailableError,
} from "./persistence/run-lease.js";
import { reduceWorkflowEvents } from "./reducer.js";
import type { DiscoveredWorkflow, WorkflowRoot } from "./registry.js";
import { discoverWorkflows } from "./registry.js";
import {
	type WorkflowRunRecord,
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
import { createWorkflowTaskFinalizer } from "./task-finalizer.js";
import { createWorkflowTaskLauncher } from "./task-launcher.js";

const addFormats = (addFormatsModule.default ??
	addFormatsModule) as unknown as FormatsPlugin;
export type WorkflowDefinitionSummary = {
	readonly name: string;
	readonly description: string;
	readonly version: number;
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

export type WorkflowServiceRunView = WorkflowServiceRunReceipt & {
	readonly definitionName: string;
	readonly createdAt: string;
	readonly output?: unknown;
	readonly outputArtifactId?: string;
};

export interface WorkflowService {
	registerRoot(root: WorkflowRoot): Promise<void>;
	list(): Promise<readonly WorkflowDefinitionSummary[]>;
	validate(ref: string, input?: unknown): Promise<WorkflowValidationResult>;
	run(ref: string, input: unknown): Promise<WorkflowServiceRunReceipt>;
	status(runId: WorkflowRunId): Promise<WorkflowServiceRunView>;
	wait(runId: WorkflowRunId): Promise<WorkflowServiceRunView>;
	stop(runId: WorkflowRunId, reason: string): Promise<WorkflowServiceRunView>;
	reconcile(runId: WorkflowRunId): Promise<WorkflowServiceRunView>;
	shutdown(): Promise<void>;
}

export interface WorkflowServiceOptions {
	readonly cwd: string;
	readonly agentDir: string;
	readonly storeRoot: string;
	readonly projectTrusted: () => boolean;
	readonly subagents: WorkflowSubagentProvider;
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
	drive: Promise<void>;
	settled: boolean;
	view?: WorkflowServiceRunView;
	failure?: Error;
};

function summary(workflow: DiscoveredWorkflow): WorkflowDefinitionSummary {
	return Object.freeze({
		name: workflow.definition.meta.name,
		description: workflow.definition.meta.description,
		version: workflow.definition.meta.version,
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

export async function createWorkflowService(
	options: WorkflowServiceOptions,
): Promise<WorkflowService> {
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
		const launcher = createWorkflowTaskLauncher({ journal, binding });
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
		});
		const runtime = createStaticWorkflowRuntime({
			definition: workflow.definition,
			definitionIdentitySha256: workflow.identity.identitySha256,
			input: record.input,
			cwd: record.cwd,
			journal,
			artifacts,
			scheduler,
		});
		const ownedRun: OwnedRun = {
			record,
			lease,
			journal,
			artifacts,
			binding,
			scheduler,
			drive: Promise.resolve(),
			settled: false,
		};
		ownedRun.drive = Promise.resolve()
			.then(() => runtime.drive())
			.then(() => undefined)
			.catch((error: unknown) => {
				ownedRun.failure =
					error instanceof Error
						? error
						: new Error("unknown workflow failure");
			})
			.finally(async () => {
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
			...(state.outputArtifactId
				? { outputArtifactId: state.outputArtifactId }
				: {}),
			...(output === undefined ? {} : { output }),
		});
	}

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
					const record: WorkflowRunRecord = {
						schema: "pi-workflow-run",
						contractRevision: WORKFLOW_CONTRACT_REVISION,
						runId: id,
						definitionName: workflow.definition.meta.name,
						definitionPath: workflow.path,
						definitionIdentitySha256: workflow.identity.identitySha256,
						definitionSourceSha256: workflow.identity.sourceSha256,
						cwd,
						input: JSON.parse(JSON.stringify(input)) as unknown,
						createdAt: new Date().toISOString(),
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
				if (isTerminalStatus(current.status)) return current;
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
		async reconcile(runIdValue: WorkflowRunId) {
			assertOpen();
			const current = await statusCurrent(runIdValue);
			if (
				current.status === "completed" ||
				current.status === "completed-degraded"
			) {
				return current;
			}
			const run = await resume(runIdValue);
			await run.drive;
			const view = await statusCurrent(runIdValue);
			if (run.failure && !isTerminalStatus(view.status)) {
				throw new WorkflowServiceError(
					"execution",
					"Workflow reconciliation ended without durable terminal state.",
					{ cause: run.failure },
				);
			}
			return view;
		},
		shutdown() {
			return exclusive(async () => {
				if (closed) return;
				closed = true;
				await Promise.all(
					[...owned.values()].map(async (run) => {
						if (!run.settled) {
							await run.scheduler
								.stop("Pi workflow session is shutting down.")
								.catch(() => undefined);
							await run.drive;
						}
						await run.lease.release();
					}),
				);
			});
		},
	});
}
