import { lstat, mkdir, open, rename } from "node:fs/promises";
import path from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	WORKFLOW_CONTRACT_REVISION,
	type WorkflowRunId,
	WorkflowRunIdSchema,
	type WorkflowRunStatus,
	WorkflowRunStatusSchema,
} from "../contracts.js";
import {
	probeWorkflowRunLease,
	WorkflowPersistenceCorruptionError,
} from "./run-lease.js";

/**
 * Store-level retention: moving a terminal run's durable state out of the
 * store's live directories and into recoverable trash. This is an operator
 * action on the store, not a run action: it appends nothing to any journal,
 * it is never derived per run from `availableActions`, and it is never a
 * model-callable tool.
 *
 * Nothing is ever deleted. A pruned run's directory and its lease file are
 * renamed under `trash/<yyyymmdd-hhmmss>/<run-id>/` beside a manifest naming
 * what was moved; recovery is moving the two entries back by hand.
 */

/** The store directory pruned state is moved into; never scanned by a reader. */
export const WORKFLOW_TRASH_DIR_NAME = "trash";

/**
 * Run statuses a prune may move. Terminal and settled for good: no drive can
 * resume them on its own. `interrupted` and `cleanup-blocked` are terminal
 * statuses too but still admit recovery (`resume`, `reconcile`, `invalidate`),
 * so they are never pruned; nonterminal statuses never are either.
 */
export const PRUNABLE_WORKFLOW_RUN_STATUSES: readonly WorkflowRunStatus[] =
	Object.freeze(["completed", "completed-degraded", "failed", "cancelled"]);

export function isPrunableWorkflowRunStatus(
	status: WorkflowRunStatus,
): boolean {
	return PRUNABLE_WORKFLOW_RUN_STATUSES.includes(status);
}

/** The run directory as it is named inside a trash entry. */
export const WORKFLOW_TRASH_RUN_DIR_NAME = "run";
/** The lease file as it is named inside a trash entry. */
export const WORKFLOW_TRASH_LEASE_FILE_NAME = "lease.json";
export const WORKFLOW_TRASH_MANIFEST_FILE_NAME = "manifest.json";

export const WorkflowPruneManifestSchema = Type.Object(
	{
		schema: Type.Literal("pi-workflow-prune"),
		contractRevision: Type.Literal(WORKFLOW_CONTRACT_REVISION),
		runId: WorkflowRunIdSchema,
		status: WorkflowRunStatusSchema,
		prunedAt: Type.String({ format: "date-time" }),
		reason: Type.String({ minLength: 1, maxLength: 512 }),
	},
	{ additionalProperties: false },
);
export type WorkflowPruneManifest = Static<typeof WorkflowPruneManifestSchema>;

/** One run the caller offers for pruning, as `listRuns` already projected it. */
export interface WorkflowPruneCandidate {
	readonly runId: WorkflowRunId;
	readonly status: WorkflowRunStatus;
	/** The run's last durable journal timestamp; the `--older-than` basis. */
	readonly updatedAt: string;
	/**
	 * Set when this process holds the run's lease for a drive that has settled.
	 * The lease probe would answer "held" for our own listener, so the caller
	 * states it instead and releases the lease through `releaseLocalLease`
	 * before the move.
	 */
	readonly heldHere?: boolean;
}

export type WorkflowPruneSkipReason =
	/** Not a terminal, unrecoverable status. */
	| "not-terminal"
	/** Inside the `--older-than` bound. */
	| "too-recent"
	/** A live process holds the run's lease, or the occupant did not identify itself. */
	| "lease-held";

export interface WorkflowPruneSelection {
	readonly runId: WorkflowRunId;
	readonly status: WorkflowRunStatus;
	readonly updatedAt: string;
	/** The trash entry the run was moved into; absent on a dry run. */
	readonly trashPath?: string;
}

export interface WorkflowPruneSkipped {
	readonly runId: WorkflowRunId;
	readonly status: WorkflowRunStatus;
	readonly reason: WorkflowPruneSkipReason;
}

export interface WorkflowPruneReport {
	readonly dryRun: boolean;
	/** `<store-root>/trash`. */
	readonly trashRoot: string;
	/** The `yyyymmdd-hhmmss` batch directory this prune writes into. */
	readonly batch: string;
	/** The reason recorded in every manifest of this batch. */
	readonly reason: string;
	readonly olderThanMs?: number;
	/** Runs moved, or - on a dry run - the runs an apply would move. */
	readonly selected: readonly WorkflowPruneSelection[];
	readonly skipped: readonly WorkflowPruneSkipped[];
	readonly generatedAt: string;
}

export interface WorkflowPruneRunsOptions {
	readonly storeRoot: string;
	readonly candidates: readonly WorkflowPruneCandidate[];
	/** A dry run selects and reports; it creates and moves nothing. */
	readonly dryRun: boolean;
	/** Keeps runs whose `updatedAt` is younger than this many milliseconds. */
	readonly olderThanMs?: number;
	readonly now?: Date;
	/** Releases this process's own lease on a selected `heldHere` candidate. */
	readonly releaseLocalLease?: (runId: WorkflowRunId) => Promise<void>;
	/** Injectable for tests; production probes the real lease record. */
	readonly probeLease?: typeof probeWorkflowRunLease;
}

/** `yyyymmdd-hhmmss` in UTC; the batch directory name. */
export function pruneBatchName(now: Date): string {
	const iso = now.toISOString();
	return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(
		11,
		13,
	)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

/** The manifest `reason`: why this batch selected what it selected. */
export function pruneReason(olderThanMs?: number): string {
	return olderThanMs === undefined
		? "Operator prune of a terminal workflow run."
		: `Operator prune of a terminal workflow run older than ${olderThanMs} ms.`;
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writeDurable(filePath: string, content: string): Promise<void> {
	const handle = await open(filePath, "wx", 0o600);
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function entryKind(
	target: string,
): Promise<"directory" | "file" | "other" | "absent"> {
	try {
		const metadata = await lstat(target);
		if (metadata.isSymbolicLink()) return "other";
		if (metadata.isDirectory()) return "directory";
		return metadata.isFile() ? "file" : "other";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
		throw error;
	}
}

/**
 * Selects the terminal candidates a prune may move and, unless `dryRun`,
 * moves each one's run directory and lease file into its own trash entry.
 *
 * A candidate is refused whenever its status is not terminal-and-settled,
 * whenever it is younger than the `--older-than` bound, and whenever a live
 * process answers its lease port - including an occupant that will not
 * identify itself, and a lease record too corrupt to read. Selection reads
 * the same lease evidence an acquirer would, so a run another Pi process is
 * driving is never moved out from under it.
 *
 * The manifest is written before anything moves: an interrupted prune leaves
 * a trash entry naming the run, with whichever of the two entries had already
 * been renamed, and never a half-moved run directory.
 */
export async function pruneWorkflowRuns(
	options: WorkflowPruneRunsOptions,
): Promise<WorkflowPruneReport> {
	const { olderThanMs } = options;
	if (
		olderThanMs !== undefined &&
		(!Number.isSafeInteger(olderThanMs) || olderThanMs < 0)
	) {
		throw new Error("invalid workflow prune age bound");
	}
	const now = options.now ?? new Date();
	if (!Number.isFinite(now.getTime())) {
		throw new Error("invalid workflow prune clock");
	}
	const storeRoot = path.resolve(options.storeRoot);
	const trashRoot = path.join(storeRoot, WORKFLOW_TRASH_DIR_NAME);
	const batch = pruneBatchName(now);
	const reason = pruneReason(olderThanMs);
	const probe = options.probeLease ?? probeWorkflowRunLease;
	const seen = new Set<string>();
	const selected: WorkflowPruneSelection[] = [];
	const skipped: WorkflowPruneSkipped[] = [];
	for (const candidate of options.candidates) {
		if (
			!Value.Check(WorkflowRunIdSchema, candidate.runId) ||
			!Value.Check(WorkflowRunStatusSchema, candidate.status) ||
			seen.has(candidate.runId)
		) {
			throw new Error("invalid workflow prune candidate");
		}
		seen.add(candidate.runId);
		if (!isPrunableWorkflowRunStatus(candidate.status)) {
			skipped.push({
				runId: candidate.runId,
				status: candidate.status,
				reason: "not-terminal",
			});
			continue;
		}
		if (olderThanMs !== undefined) {
			const updated = Date.parse(candidate.updatedAt);
			// An unreadable timestamp is treated as the present: a bounded
			// prune never moves a run it cannot prove is old enough.
			const age = Number.isFinite(updated) ? now.getTime() - updated : 0;
			if (age < olderThanMs) {
				skipped.push({
					runId: candidate.runId,
					status: candidate.status,
					reason: "too-recent",
				});
				continue;
			}
		}
		if (!candidate.heldHere) {
			let live = true;
			try {
				live =
					(await probe({ storeRoot, runId: candidate.runId })).state !== "free";
			} catch (error) {
				// A lease record no acquirer could read fails every action on the
				// run; it is never evidence that the run is free.
				if (!(error instanceof WorkflowPersistenceCorruptionError)) throw error;
			}
			if (live) {
				skipped.push({
					runId: candidate.runId,
					status: candidate.status,
					reason: "lease-held",
				});
				continue;
			}
		}
		selected.push({
			runId: candidate.runId,
			status: candidate.status,
			updatedAt: candidate.updatedAt,
		});
	}
	if (options.dryRun) {
		return Object.freeze({
			dryRun: true,
			trashRoot,
			batch,
			reason,
			...(olderThanMs === undefined ? {} : { olderThanMs }),
			selected: Object.freeze(selected.map((run) => Object.freeze(run))),
			skipped: Object.freeze(skipped.map((run) => Object.freeze(run))),
			generatedAt: new Date().toISOString(),
		});
	}
	const heldHere = new Set(
		options.candidates
			.filter((candidate) => candidate.heldHere)
			.map((candidate) => candidate.runId),
	);
	const moved: WorkflowPruneSelection[] = [];
	for (const run of selected) {
		if (heldHere.has(run.runId)) await options.releaseLocalLease?.(run.runId);
		const trashPath = path.join(trashRoot, batch, run.runId);
		await mkdir(trashPath, { recursive: true, mode: 0o700 });
		const manifest: WorkflowPruneManifest = {
			schema: "pi-workflow-prune",
			contractRevision: WORKFLOW_CONTRACT_REVISION,
			runId: run.runId,
			status: run.status,
			prunedAt: now.toISOString(),
			reason,
		};
		await writeDurable(
			path.join(trashPath, WORKFLOW_TRASH_MANIFEST_FILE_NAME),
			`${JSON.stringify(manifest, null, 2)}\n`,
		);
		await syncDirectory(trashPath);
		const runDirectory = path.join(storeRoot, "runs", run.runId);
		if ((await entryKind(runDirectory)) === "directory") {
			await rename(
				runDirectory,
				path.join(trashPath, WORKFLOW_TRASH_RUN_DIR_NAME),
			);
			await syncDirectory(path.dirname(runDirectory));
			await syncDirectory(trashPath);
		}
		const leaseFile = path.join(storeRoot, "leases", `${run.runId}.lease.json`);
		if ((await entryKind(leaseFile)) === "file") {
			await rename(
				leaseFile,
				path.join(trashPath, WORKFLOW_TRASH_LEASE_FILE_NAME),
			);
			await syncDirectory(path.dirname(leaseFile));
			await syncDirectory(trashPath);
		}
		moved.push(Object.freeze({ ...run, trashPath }));
	}
	return Object.freeze({
		dryRun: false,
		trashRoot,
		batch,
		reason,
		...(olderThanMs === undefined ? {} : { olderThanMs }),
		selected: Object.freeze(moved),
		skipped: Object.freeze(skipped.map((run) => Object.freeze(run))),
		generatedAt: new Date().toISOString(),
	});
}
