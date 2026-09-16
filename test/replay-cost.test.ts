import { randomUUID } from "node:crypto";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { RunResult } from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { WorkflowArtifactStore } from "../src/artifact-store.js";
import type { WorkflowRunId } from "../src/contracts.js";
import { defineWorkflow, type WorkflowContext } from "../src/definition.js";
import { MAX_WORKFLOW_STATE_BYTES } from "../src/events.js";
import {
	deriveJsonValueSha256,
	deriveSubagentOperationId,
	deriveSubagentResultSha256,
	deriveTaskExecutionId,
} from "../src/execution.js";
import { WorkflowRunJournal } from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
	type WorkflowRunLease,
} from "../src/persistence/run-lease.js";
import type {
	WorkflowSchedulerOutcome,
	WorkflowSequentialScheduler,
} from "../src/scheduler.js";
import {
	createStaticWorkflowRuntime,
	isStaticWorkflowParked,
} from "../src/static-runtime.js";

// ---------------------------------------------------------------------------
// W0-MEASURE: the replay cost of a plan-shaped graph.
//
// `docs/contracts.md` states exact-prefix replay: every drive re-executes the
// definition's `run` from entry and every already-crossed barrier re-awaits
// against the journal. A generic `loopUntil` would add barriers without bound,
// so the question this file answers with numbers is how a drive's cost grows
// with the number of barriers a run has already crossed.
//
// The measurement is deliberately IO-real: a real `WorkflowRunJournal` (fsync
// per append), a real `WorkflowArtifactStore`, and the fake-scheduler harness
// the runtime tests use. Only the subagent is fake, because agent latency is
// the one cost a round cap cannot change.
//
// Heavy configurations are gated behind `RUN_REPLAY_COST=1` (see §7 R6 of the
// plan-loop spec); CI runs the small configuration, which exercises every code
// path the heavy ones do. `REPLAY_COST_REPEATS` overrides the sample count.
// Every measurement also carries a wall-clock budget, so a slow machine
// degrades to fewer samples rather than to a timeout, and every row reports
// the sample count it actually took. Findings: `docs/research.md`.
// ---------------------------------------------------------------------------

const HEAVY = process.env.RUN_REPLAY_COST === "1";
const heavy = it.skipIf(!HEAVY);
const OWNER = "replay-cost-test";
const REPEATS = Number(process.env.REPLAY_COST_REPEATS ?? "3");
const definitionIdentitySha256 = "a".repeat(64);
const planIdentitySha256 = "c".repeat(64);
const fixtureRoot = path.resolve(".pi", "test-replay-cost");
const leases = new Set<WorkflowRunLease>();
const report: string[] = [];

/** One measured graph shape: deliverables x fix rounds x review lenses. */
interface Shape {
	readonly deliverables: number;
	readonly rounds: number;
	readonly lenses: number;
}

function shapeName(shape: Shape): string {
	return `D${shape.deliverables}-R${shape.rounds}-L${shape.lenses}`;
}

/**
 * Barriers a shape crosses: one root `approve-plan` gate, per deliverable one
 * `implement` result plus two per fix round plus one settled review fan-out
 * plus one synthesis result, one root `ship` gate, and the runtime's own
 * closing `final` barrier.
 */
function expectedBarriers(shape: Shape): number {
	return 2 + shape.deliverables * (3 + 2 * shape.rounds) + 1;
}

/** Tasks a shape declares: two gates plus the per-deliverable ladder. */
function expectedTasks(shape: Shape): number {
	return 2 + shape.deliverables * (2 + 2 * shape.rounds + shape.lenses);
}

// ---------------------------------------------------------------------------
// The synthetic definition
// ---------------------------------------------------------------------------

const decisionSchema = Type.Object({ proceed: Type.Boolean() });
const answerSchema = Type.Object({ answer: Type.String() });

function request(goal: string) {
	return {
		agent: "worker",
		task: { goal, context: [], instructions: ["Return structured output."] },
		contextMode: "fresh" as const,
		tools: ["read"],
		preloadSkills: [],
		contextScopes: ["project" as const],
		workspace: { mode: "read-only" as const, cwd: "/repo" },
		outputSchema: answerSchema,
		limits: {
			cumulativeRuntimeMs: 300_000,
			attemptTimeoutMs: 300_000,
			totalTokens: 100_000,
			cost: 1,
			outputBytes: 1024,
			workspaceWriteBytes: 0,
			retries: 0,
			resumes: 0,
		},
	};
}

/**
 * The compiled shape of a `plan-to-ship` run: gates at the root, and per
 * deliverable `implement` -> `maxFixRounds` verify/fix rounds -> a review
 * fan-out settled together -> synthesis. Every round is taken, so the graph is
 * the worst case `verifyAndFix` admits budget for.
 */
function planShapedDefinition(shape: Shape) {
	return defineWorkflow({
		meta: {
			name: "replay-cost",
			description: "Replay-cost measurement graph",
			version: 1,
			budget: {
				cost: 100_000,
				totalTokens: 100_000_000,
				childRuntimeMs: 3_600_000,
			},
			timeoutMs: 3_600_000,
		},
		inputSchema: Type.Object({}),
		outputSchema: Type.Object({ done: Type.Boolean() }),
		async run(ctx: WorkflowContext<Record<string, never>>) {
			const approve = ctx.checkpoint("approve-plan", {
				schema: decisionSchema,
				prompt: "Approve the compiled plan?",
				headless: "block" as const,
			});
			await ctx.result(approve);
			for (let index = 0; index < shape.deliverables; index += 1) {
				const namespace = `d${index}`;
				const implement = ctx.agent(
					`${namespace}-implement`,
					request(`Implement deliverable ${index}`),
				);
				await ctx.result(implement);
				for (let round = 1; round <= shape.rounds; round += 1) {
					const verify = ctx.agent(
						`${namespace}-verify-${round}`,
						request(`Verify deliverable ${index} round ${round}`),
					);
					await ctx.result(verify);
					const fix = ctx.agent(
						`${namespace}-fix-${round}`,
						request(`Fix deliverable ${index} round ${round}`),
					);
					await ctx.result(fix);
				}
				const lenses = Array.from({ length: shape.lenses }, (_, lens) =>
					ctx.agent(
						`${namespace}-lens-${lens}`,
						request(`Review deliverable ${index} lens ${lens}`),
					),
				);
				await ctx.settled(lenses);
				const synthesis = ctx.agent(
					`${namespace}-synthesis`,
					request(`Synthesise deliverable ${index}`),
				);
				await ctx.result(synthesis);
			}
			const ship = ctx.checkpoint("ship", {
				schema: decisionSchema,
				prompt: "Ship the reviewed deliverables?",
				headless: "block" as const,
			});
			const shipped = await ctx.result(ship);
			return { done: shipped.proceed };
		},
	});
}

// ---------------------------------------------------------------------------
// The fake scheduler: settles agent tasks and decides checkpoints
// ---------------------------------------------------------------------------

function completedResult(runId: string, value: unknown): RunResult {
	return {
		runId,
		status: "completed",
		structuredOutput: value,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: 0,
		},
		usageComplete: true,
		runtimeMs: 10,
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
	};
}

/**
 * Settles the first committed, not-yet-completed task in materialization
 * order: an agent task through the full launch/settle/import ladder, a
 * checkpoint through request-and-decide so the run never parks.
 */
function graphScheduler(
	journal: WorkflowRunJournal,
	artifacts: WorkflowArtifactStore,
): WorkflowSequentialScheduler & { calls: number } {
	const scheduler = {
		concurrency: 1,
		stopSignal: new AbortController().signal,
		calls: 0,
		async drive(): Promise<WorkflowSchedulerOutcome> {
			scheduler.calls += 1;
			let current = await journal.readState();
			if (current.status === "created" || current.status === "waiting") {
				await journal.append("run-status-changed", {
					from: current.status,
					to: "running",
				});
				current = await journal.readState();
			}
			const task = Object.values(current.tasks)
				.filter((candidate) => candidate.committed)
				.sort(
					(left, right) =>
						left.task.materializationSequence -
						right.task.materializationSequence,
				)
				.find((candidate) => candidate.status !== "completed");
			if (!task) return { state: "idle", runStatus: current.status };
			const spec = task.task.spec;
			const taskId = task.task.id;
			const executionId = deriveTaskExecutionId(current.runId, taskId, 1);
			if (task.status === "pending") {
				await journal.append("task-status-changed", {
					taskId,
					from: "pending",
					to: "ready",
				});
			}
			if (spec.kind === "checkpoint") {
				if (!current.executions[executionId]) {
					await journal.append("task-execution-created", {
						execution: {
							kind: "checkpoint",
							id: executionId,
							runId: current.runId,
							taskId,
							generation: 1,
							taskIdentitySha256: spec.identitySha256,
						},
					});
					await journal.append("task-execution-checkpoint-requested", {
						executionId,
						inputsSha256: deriveJsonValueSha256({}),
					});
					await journal.append("task-status-changed", {
						taskId,
						from: "ready",
						to: "waiting",
						reason: "Checkpoint awaits a decision.",
					});
					current = await journal.readState();
				}
				const decision = { proceed: true };
				const artifact = await artifacts.putJson(decision, {
					runId: current.runId,
					producerTaskId: taskId,
					producerExecutionId: executionId,
					output: "result",
					schemaSha256: deriveJsonValueSha256(spec.request.schema),
				});
				if (!current.artifacts[artifact.id]) {
					await journal.append("artifact-declared", { artifact });
				}
				await journal.append("task-execution-checkpoint-decided", {
					executionId,
					artifactId: artifact.id,
					decisionSha256: artifact.sha256,
					source: "operator",
					decidedAt: new Date().toISOString(),
					decidedBy: "tester",
				});
				await journal.append("task-execution-terminal", {
					executionId,
					outcome: "completed",
					evidence: {
						kind: "checkpoint",
						artifactId: artifact.id,
						decisionSha256: artifact.sha256,
						source: "operator",
						decidedBy: "tester",
					},
				});
				await journal.append("task-status-changed", {
					taskId,
					from: "waiting",
					to: "completed",
					reason: "Checkpoint decided.",
				});
				return { state: "idle", runStatus: "running" };
			}
			if (spec.kind !== "agent") {
				throw new Error(`replay-cost scheduler cannot run ${spec.kind}`);
			}
			const operationId = deriveSubagentOperationId(current.runId, taskId, 1);
			const childKey = spec.key.replaceAll("-", "");
			const childRunId = `run_${childKey}`;
			const childAttemptId = `attempt_${childKey}`;
			await journal.append("task-execution-created", {
				execution: {
					kind: "agent",
					id: executionId,
					runId: current.runId,
					taskId,
					generation: 1,
					taskIdentitySha256: spec.identitySha256,
					operationId,
				},
			});
			await journal.append("task-execution-preflighted", {
				executionId,
				operationId,
				preflightId: `preflight-${spec.key}`,
				workspaceMode: "read-only" as const,
				workspaceBaselineSha256: "c".repeat(64),
				planIdentitySha256,
				plannedSubagentRunId: childRunId,
				plannedSubagentAttemptId: childAttemptId,
				expiresAt: "2099-01-01T00:00:00.000Z",
			});
			await journal.append("task-execution-launch-intended", {
				executionId,
				operationId,
				preflightId: `preflight-${spec.key}`,
				planIdentitySha256,
			});
			await journal.append("task-execution-launch-receipted", {
				executionId,
				operationId,
				subagentRunId: childRunId,
				subagentAttemptId: childAttemptId,
				status: "completed",
			});
			await journal.append("task-status-changed", {
				taskId,
				from: "ready",
				to: "waiting",
			});
			await journal.append("task-execution-child-observed", {
				executionId,
				subagentRunId: childRunId,
				subagentAttemptId: childAttemptId,
				status: "completed",
			});
			const output = { answer: spec.key };
			const result = completedResult(childRunId, output);
			const evidence = {
				kind: "subagent" as const,
				attemptOrdinal: 1,
				resultSha256: deriveSubagentResultSha256(result),
				status: "completed" as const,
				usage: result.usage,
				usageComplete: true,
				runtimeMs: 10,
				sandboxCleanup: "proved" as const,
				workspaceCleanup: "not-needed" as const,
				truncated: false,
				structuredOutputSha256: deriveJsonValueSha256(output),
			};
			await journal.append("task-execution-child-settled", {
				executionId,
				evidence,
			});
			const artifact = await artifacts.putJson(output, {
				runId: current.runId,
				producerTaskId: taskId,
				producerExecutionId: executionId,
				output: "result",
				schemaSha256: deriveJsonValueSha256(spec.request.outputSchema),
			});
			await journal.append("artifact-declared", { artifact });
			await journal.append("task-execution-artifact-imported", {
				executionId,
				subagentRunId: childRunId,
				artifactId: artifact.id,
				sourceResultSha256: evidence.resultSha256,
			});
			await journal.append("task-execution-release-intended", {
				executionId,
				subagentRunId: childRunId,
			});
			await journal.append("task-execution-released", {
				executionId,
				subagentRunId: childRunId,
				status: "completed",
			});
			await journal.append("task-execution-terminal", {
				executionId,
				outcome: "completed",
				evidence,
			});
			await journal.append("task-status-changed", {
				taskId,
				from: "waiting",
				to: "completed",
			});
			return {
				state: "awaiting-finalization",
				runStatus: "running",
				taskId,
				executionId,
				child: {
					runId: childRunId,
					attemptId: childAttemptId,
					status: "completed",
				},
				outcome: "completed",
			};
		},
		async reconcile() {
			throw new Error("replay-cost graph has no cleanup-blocked task");
		},
		async decide() {
			throw new Error("replay-cost scheduler records no decisions");
		},
		async stop() {
			return { state: "terminal", runStatus: "cancelled" } as const;
		},
	};
	return scheduler;
}

// ---------------------------------------------------------------------------
// Instrumentation: what the runtime asks the journal for
// ---------------------------------------------------------------------------

interface JournalCounts {
	readState: number;
	readStateMs: number;
	readEvents: number;
	appends: number;
	appendMs: number;
}

function newCounts(): JournalCounts {
	return {
		readState: 0,
		readStateMs: 0,
		readEvents: 0,
		appends: 0,
		appendMs: 0,
	};
}

function addCounts(left: JournalCounts, right: JournalCounts): JournalCounts {
	return {
		readState: left.readState + right.readState,
		readStateMs: left.readStateMs + right.readStateMs,
		readEvents: left.readEvents + right.readEvents,
		appends: left.appends + right.appends,
		appendMs: left.appendMs + right.appendMs,
	};
}

/**
 * A pass-through view of the journal that counts and times reads and appends.
 * The runtime and the scheduler get one each, so a drive's wall time splits
 * into durable appends (fsync-bound execution), state reads, and the rest —
 * the materializer's own replay work.
 */
function countingJournal(
	journal: WorkflowRunJournal,
	counts: JournalCounts,
): WorkflowRunJournal {
	function timed<T>(
		method: (...args: unknown[]) => unknown,
		args: unknown[],
		record: (elapsed: number) => void,
	): Promise<T> {
		const started = performance.now();
		return (method.apply(journal, args) as Promise<T>).finally(() => {
			record(performance.now() - started);
		});
	}
	return new Proxy(journal, {
		get(target, property): unknown {
			const value = Reflect.get(target, property, target) as unknown;
			if (typeof value !== "function") return value;
			const method = value as (...args: unknown[]) => unknown;
			if (property === "readState") {
				return (...args: unknown[]) => {
					counts.readState += 1;
					return timed(method, args, (ms) => {
						counts.readStateMs += ms;
					});
				};
			}
			if (property === "readEvents") {
				return (...args: unknown[]) => {
					counts.readEvents += 1;
					return method.apply(target, args);
				};
			}
			if (property === "append" || property === "appendEvent") {
				return (...args: unknown[]) => {
					counts.appends += 1;
					return timed(method, args, (ms) => {
						counts.appendMs += ms;
					});
				};
			}
			return method.bind(target);
		},
	});
}

// ---------------------------------------------------------------------------
// Fixtures, recording, and crash simulation
// ---------------------------------------------------------------------------

const runId = "workflow_replaycost" as WorkflowRunId;

async function freshLease(root: string): Promise<WorkflowRunLease> {
	const lease = await acquireWorkflowRunLease({
		storeRoot: root,
		runId,
		ownerId: OWNER,
	});
	leases.add(lease);
	return lease;
}

/**
 * A lease over a copied store whose journal already carries generation-1
 * fencing evidence: acquiring and releasing once bumps the persisted
 * generation, so the resuming lease fences the crashed writer.
 */
async function resumeLease(root: string): Promise<WorkflowRunLease> {
	const first = await acquireWorkflowRunLease({
		storeRoot: root,
		runId,
		ownerId: OWNER,
	});
	await first.release();
	return freshLease(root);
}

interface Recording {
	readonly root: string;
	readonly events: number;
	readonly barriers: number;
	readonly tasks: number;
	readonly bytes: number;
	/** Canonical size of the final projection, against `MAX_WORKFLOW_STATE_BYTES`. */
	readonly stateBytes: number;
	/** Journal record counts at 25/50/75/100 % of the run's task completions. */
	readonly crashPoints: readonly number[];
	readonly driveMs: number;
	readonly counts: JournalCounts;
	readonly schedulerCounts: JournalCounts;
}

/** Drives a shape to completion in a fresh store and measures the drive. */
async function record(shape: Shape): Promise<Recording> {
	const root = path.join(fixtureRoot, `record-${randomUUID()}`);
	const lease = await freshLease(root);
	const journal = await WorkflowRunJournal.open(root, runId, lease);
	const artifacts = await WorkflowArtifactStore.open({ journal });
	const counts = newCounts();
	const schedulerCounts = newCounts();
	const runtime = createStaticWorkflowRuntime({
		definition: planShapedDefinition(shape),
		definitionIdentitySha256,
		input: {},
		cwd: "/repo",
		journal: countingJournal(journal, counts),
		artifacts,
		scheduler: graphScheduler(
			countingJournal(journal, schedulerCounts),
			artifacts,
		),
	});
	const started = performance.now();
	const result = await runtime.drive();
	const driveMs = performance.now() - started;
	if (isStaticWorkflowParked(result)) throw new Error("recording parked");
	const state = await journal.readState();
	const journalPath = path.join(root, "runs", runId, "events.jsonl");
	const content = await readFile(journalPath, "utf8");
	const lines = content.split("\n").filter((line) => line.length > 0);
	const completions = lines.flatMap((line, index) => {
		const event = JSON.parse(line) as {
			type: string;
			data: { to?: string };
		};
		return event.type === "task-status-changed" && event.data.to === "completed"
			? [index + 1]
			: [];
	});
	const crashPoints = [0.25, 0.5, 0.75, 1].map((fraction) => {
		const ordinal = Math.max(
			1,
			Math.round(fraction * completions.length) - (fraction === 1 ? 0 : 0),
		);
		const records = completions[Math.min(ordinal, completions.length) - 1];
		if (records === undefined) throw new Error("no task completion recorded");
		return records;
	});
	await lease.release();
	leases.delete(lease);
	return {
		root,
		events: state.lastSequence,
		barriers: state.barriers.length,
		tasks: Object.keys(state.tasks).length,
		bytes: Buffer.byteLength(content),
		stateBytes: Buffer.byteLength(JSON.stringify(state)),
		crashPoints,
		driveMs,
		counts,
		schedulerCounts,
	};
}

interface Resume {
	readonly openMs: number;
	readonly driveMs: number;
	readonly counts: JournalCounts;
	readonly schedulerCounts: JournalCounts;
	readonly schedulerCalls: number;
}

/**
 * Copies a recorded run, truncates its journal to `records` complete records —
 * a crash with no torn tail — and measures the resume: opening the journal
 * cold, then one drive that replays the source from entry and re-awaits every
 * crossed barrier before finishing the remaining work.
 */
async function resumeFrom(
	recording: Recording,
	shape: Shape,
	records: number,
): Promise<Resume> {
	const root = path.join(fixtureRoot, `resume-${randomUUID()}`);
	await cp(
		path.join(recording.root, "runs", runId),
		path.join(root, "runs", runId),
		{ recursive: true },
	);
	const journalPath = path.join(root, "runs", runId, "events.jsonl");
	const lines = (await readFile(journalPath, "utf8"))
		.split("\n")
		.filter((line) => line.length > 0);
	await writeFile(journalPath, `${lines.slice(0, records).join("\n")}\n`);
	const lease = await resumeLease(root);
	const openStarted = performance.now();
	const journal = await WorkflowRunJournal.open(root, runId, lease);
	const artifacts = await WorkflowArtifactStore.open({ journal });
	const openMs = performance.now() - openStarted;
	const counts = newCounts();
	const schedulerCounts = newCounts();
	const scheduler = graphScheduler(
		countingJournal(journal, schedulerCounts),
		artifacts,
	);
	const runtime = createStaticWorkflowRuntime({
		definition: planShapedDefinition(shape),
		definitionIdentitySha256,
		input: {},
		cwd: "/repo",
		journal: countingJournal(journal, counts),
		artifacts,
		scheduler,
	});
	const started = performance.now();
	const result = await runtime.drive();
	const driveMs = performance.now() - started;
	if (isStaticWorkflowParked(result)) throw new Error("resume parked");
	await lease.release();
	leases.delete(lease);
	await rm(root, { recursive: true, force: true });
	return {
		openMs,
		driveMs,
		counts,
		schedulerCounts,
		schedulerCalls: scheduler.calls,
	};
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	const low = sorted[middle - 1];
	const high = sorted[middle];
	if (high === undefined) throw new Error("median of an empty sample");
	return sorted.length % 2 === 0 && low !== undefined ? (low + high) / 2 : high;
}

/** Least squares over a Vandermonde system; returns coefficients low to high. */
function leastSquares(
	xs: readonly number[],
	ys: readonly number[],
	degree: number,
): number[] {
	const size = degree + 1;
	const matrix: number[][] = Array.from({ length: size }, () =>
		new Array<number>(size + 1).fill(0),
	);
	for (let row = 0; row < size; row += 1) {
		const target = matrix[row];
		if (!target) throw new Error("matrix row missing");
		for (let column = 0; column < size; column += 1) {
			target[column] = xs.reduce((sum, x) => sum + x ** (row + column), 0);
		}
		target[size] = xs.reduce(
			(sum, x, index) => sum + x ** row * (ys[index] ?? 0),
			0,
		);
	}
	for (let pivot = 0; pivot < size; pivot += 1) {
		let best = pivot;
		for (let row = pivot + 1; row < size; row += 1) {
			if (
				Math.abs(matrix[row]?.[pivot] ?? 0) >
				Math.abs(matrix[best]?.[pivot] ?? 0)
			) {
				best = row;
			}
		}
		const bestRow = matrix[best];
		const pivotRow = matrix[pivot];
		if (!bestRow || !pivotRow) throw new Error("matrix row missing");
		matrix[best] = pivotRow;
		matrix[pivot] = bestRow;
		const head = bestRow[pivot] ?? 0;
		if (head === 0) throw new Error("singular least-squares system");
		for (let column = pivot; column <= size; column += 1) {
			bestRow[column] = (bestRow[column] ?? 0) / head;
		}
		for (let row = 0; row < size; row += 1) {
			if (row === pivot) continue;
			const other = matrix[row];
			if (!other) throw new Error("matrix row missing");
			const factor = other[pivot] ?? 0;
			if (factor === 0) continue;
			for (let column = pivot; column <= size; column += 1) {
				other[column] = (other[column] ?? 0) - factor * (bestRow[column] ?? 0);
			}
		}
	}
	return matrix.map((row) => row[size] ?? 0);
}

function evaluate(coefficients: readonly number[], x: number): number {
	return coefficients.reduce(
		(sum, coefficient, power) => sum + coefficient * x ** power,
		0,
	);
}

function rSquared(
	xs: readonly number[],
	ys: readonly number[],
	coefficients: readonly number[],
): number {
	const mean = ys.reduce((sum, y) => sum + y, 0) / ys.length;
	const residual = ys.reduce(
		(sum, y, index) => sum + (y - evaluate(coefficients, xs[index] ?? 0)) ** 2,
		0,
	);
	const total = ys.reduce((sum, y) => sum + (y - mean) ** 2, 0);
	return total === 0 ? 1 : 1 - residual / total;
}

function round(value: number, digits = 1): number {
	const scale = 10 ** digits;
	return Math.round(value * scale) / scale;
}

// ---------------------------------------------------------------------------
// The measurements
// ---------------------------------------------------------------------------

/**
 * Takes up to `limit` samples and stops early once `budgetMs` has elapsed, so
 * a heavy shape degrades to fewer samples instead of a timeout. The reported
 * sample count is part of every row.
 */
async function samples<T>(
	limit: number,
	budgetMs: number,
	take: () => Promise<T>,
): Promise<T[]> {
	const started = performance.now();
	const taken: T[] = [];
	for (let index = 0; index < limit; index += 1) {
		taken.push(await take());
		if (performance.now() - started > budgetMs) break;
	}
	return taken;
}

/**
 * Recordings are expensive to build (a full drive) but cheap to reuse: every
 * resume runs against a private copy, so one shape's journals are recorded
 * once and shared by the tests that measure resumes from them.
 */
const recorded = new Map<string, Recording[]>();

async function recordingsFor(
	shape: Shape,
	limit: number,
	budgetMs = 40_000,
): Promise<readonly Recording[]> {
	const name = shapeName(shape);
	const existing = recorded.get(name) ?? [];
	recorded.set(name, existing);
	if (existing.length >= limit) return existing;
	const more = await samples(limit - existing.length, budgetMs, () =>
		record(shape),
	);
	existing.push(...more);
	return existing;
}

function emit(lines: readonly string[]): void {
	report.push(...lines);
	// Straight to the terminal: the runner buffers `console.log` for passing
	// tests, and a measurement nobody reads is not a measurement.
	process.stderr.write(`${lines.join("\n")}\n`);
}

function header(shape: Shape, recording: Recording): string {
	return `### ${shapeName(shape)} — ${recording.tasks} tasks, ${recording.barriers} barriers, ${recording.events} events, ${round(recording.bytes / 1024)} KiB journal, ${round(recording.stateBytes / 1024)} KiB projection (bound ${MAX_WORKFLOW_STATE_BYTES / 1024} KiB)`;
}

const DRIVE_TABLE_HEAD = [
	"| Drive | n | median ms | journal open ms | appends | append ms | runtime readState | readState ms | scheduler drives |",
	"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];

function scratchRow(recordings: readonly Recording[]): string {
	const last = recordings.at(-1);
	if (!last) throw new Error("no recording");
	const total = addCounts(last.counts, last.schedulerCounts);
	return `| from scratch | ${recordings.length} | ${round(median(recordings.map((entry) => entry.driveMs)))} | — | ${total.appends} | ${round(total.appendMs)} | ${last.counts.readState} | ${round(last.counts.readStateMs)} | — |`;
}

/** Measures resumes from one crash point and returns its table row. */
async function resumeRow(
	shape: Shape,
	recordings: readonly Recording[],
	point: number,
	label: string,
	limit: number,
	budgetMs: number,
): Promise<{ readonly row: string; readonly ms: number }> {
	let index = 0;
	const taken = await samples(limit, budgetMs, () => {
		const recording = recordings[index++ % recordings.length];
		if (!recording) throw new Error("no recording");
		const records = recording.crashPoints[point];
		if (records === undefined) throw new Error("no crash point");
		return resumeFrom(recording, shape, records);
	});
	const last = taken.at(-1);
	if (!last) throw new Error("no resume sample");
	const total = addCounts(last.counts, last.schedulerCounts);
	const ms = median(taken.map((resume) => resume.driveMs));
	return {
		ms,
		row: `| resume @ ${label} | ${taken.length} | ${round(ms)} | ${round(median(taken.map((resume) => resume.openMs)))} | ${total.appends} | ${round(total.appendMs)} | ${last.counts.readState} | ${round(last.counts.readStateMs)} | ${last.schedulerCalls} |`,
	};
}

const CRASH_LABELS = ["25 %", "50 %", "75 %", "100 %"] as const;

afterEach(async () => {
	await Promise.all([...leases].map((lease) => lease.release()));
	leases.clear();
});

afterAll(async () => {
	if (report.length > 0) {
		process.stderr.write(
			`\n--- replay cost report ---\n${report.join("\n")}\n`,
		);
	}
	await rm(fixtureRoot, { recursive: true, force: true });
});

const SMALL: Shape = { deliverables: 2, rounds: 1, lenses: 2 };
const PLAN: Shape = { deliverables: 4, rounds: 2, lenses: 3 };
const WIDE: Shape = { deliverables: 8, rounds: 2, lenses: 3 };

describe("replay cost of a plan-shaped graph", () => {
	it("crosses one barrier per await and replays every one on resume", async () => {
		const [recording] = await recordingsFor(SMALL, 1);
		if (!recording) throw new Error("no recording");
		expect(recording.barriers).toBe(expectedBarriers(SMALL));
		expect(recording.tasks).toBe(expectedTasks(SMALL));
		// One `readState` per barrier commit is the floor; the drive loop adds
		// its own read per scheduler round.
		expect(recording.counts.readState).toBeGreaterThanOrEqual(
			recording.barriers,
		);

		const crashed = recording.crashPoints.at(-1);
		if (crashed === undefined) throw new Error("no crash point");
		const resume = await resumeFrom(recording, SMALL, crashed);
		// Every task was already complete: the resume runs no work at all and
		// still pays to re-await every barrier.
		expect(resume.counts.readState).toBeGreaterThanOrEqual(recording.barriers);
		expect(resume.schedulerCalls).toBe(0);
		expect(resume.driveMs).toBeLessThan(recording.driveMs);
		// The projection every barrier re-clones is bounded; a loop that adds
		// rounds spends that bound as surely as it spends time.
		expect(recording.stateBytes).toBeLessThan(MAX_WORKFLOW_STATE_BYTES);
		emit([
			"",
			header(SMALL, recording),
			"",
			...DRIVE_TABLE_HEAD,
			scratchRow([recording]),
			`| resume @ 100 % | 1 | ${round(resume.driveMs)} | ${round(resume.openMs)} | ${resume.counts.appends} | ${round(resume.counts.appendMs)} | ${resume.counts.readState} | ${round(resume.counts.readStateMs)} | ${resume.schedulerCalls} |`,
		]);
	});

	heavy(
		"drives the 4-deliverable / 2-round / 3-lens graph from scratch",
		async () => {
			const recordings = await recordingsFor(PLAN, REPEATS, 30_000);
			const last = recordings.at(-1);
			if (!last) throw new Error("no recording");
			expect(last.barriers).toBe(expectedBarriers(PLAN));
			expect(last.tasks).toBe(expectedTasks(PLAN));
			emit([
				"",
				header(PLAN, last),
				"",
				...DRIVE_TABLE_HEAD,
				scratchRow(recordings),
			]);
		},
		55_000,
	);

	heavy(
		"resumes the 4-deliverable graph after a crash at 25 % and 50 %",
		async () => {
			const recordings = await recordingsFor(PLAN, 1, 30_000);
			const rows: string[] = [];
			for (const point of [0, 1]) {
				const { row, ms } = await resumeRow(
					PLAN,
					recordings,
					point,
					CRASH_LABELS[point] ?? "",
					REPEATS,
					10_000,
				);
				expect(ms).toBeGreaterThan(0);
				rows.push(row);
			}
			emit(rows);
		},
		55_000,
	);

	heavy(
		"resumes the 4-deliverable graph after a crash at 75 % and 100 %",
		async () => {
			const recordings = await recordingsFor(PLAN, 1, 30_000);
			const rows: string[] = [];
			const measured: number[] = [];
			for (const point of [2, 3]) {
				const { row, ms } = await resumeRow(
					PLAN,
					recordings,
					point,
					CRASH_LABELS[point] ?? "",
					REPEATS,
					10_000,
				);
				measured.push(ms);
				rows.push(row);
			}
			emit(rows);
			// The later the crash the less work remains, so the resume gets
			// cheaper: replay never overtakes execution.
			const [late, latest] = measured;
			expect(latest ?? 0).toBeLessThan(late ?? 0);
		},
		55_000,
	);

	heavy(
		"drives the 8-deliverable / 2-round / 3-lens graph from scratch",
		async () => {
			const recordings = await recordingsFor(WIDE, 1, 45_000);
			const last = recordings.at(-1);
			if (!last) throw new Error("no recording");
			expect(last.barriers).toBe(expectedBarriers(WIDE));
			expect(last.tasks).toBe(expectedTasks(WIDE));
			emit([
				"",
				header(WIDE, last),
				"",
				...DRIVE_TABLE_HEAD,
				scratchRow(recordings),
			]);
		},
		55_000,
	);

	heavy(
		"resumes the 8-deliverable graph after a crash at 50 % and 100 %",
		async () => {
			const recordings = await recordingsFor(WIDE, 1, 45_000);
			const rows: string[] = [];
			for (const point of [1, 3]) {
				const { row, ms } = await resumeRow(
					WIDE,
					recordings,
					point,
					CRASH_LABELS[point] ?? "",
					REPEATS,
					10_000,
				);
				expect(ms).toBeGreaterThan(0);
				rows.push(row);
			}
			emit(rows);
		},
		55_000,
	);

	heavy(
		"fits pure replay cost against the number of crossed barriers",
		async () => {
			const shapes: readonly Shape[] = [
				{ deliverables: 1, rounds: 2, lenses: 3 },
				{ deliverables: 2, rounds: 2, lenses: 3 },
				PLAN,
				WIDE,
			];
			const barriers: number[] = [];
			const replayMs: number[] = [];
			const rows: string[] = [
				"",
				"### Pure replay — crash after the last task completed, nothing left to run",
				"",
				"| Shape | barriers | events | journal KiB | projection KiB | cold open ms | replay ms | ms / barrier | µs / (barrier × event) |",
				"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
			];
			for (const shape of shapes) {
				const [recording] = await recordingsFor(shape, 1, 45_000);
				if (!recording) throw new Error("no recording");
				const crashed = recording.crashPoints.at(-1);
				if (crashed === undefined) throw new Error("no crash point");
				const taken = await samples(REPEATS, 10_000, () =>
					resumeFrom(recording, shape, crashed),
				);
				const drive = median(taken.map((resume) => resume.driveMs));
				barriers.push(recording.barriers);
				replayMs.push(drive);
				rows.push(
					`| ${shapeName(shape)} | ${recording.barriers} | ${recording.events} | ${round(recording.bytes / 1024)} | ${round(recording.stateBytes / 1024)} | ${round(median(taken.map((resume) => resume.openMs)))} | ${round(drive)} | ${round(drive / recording.barriers, 2)} | ${round((1000 * drive) / (recording.barriers * recording.events), 2)} |`,
				);
			}
			const linear = leastSquares(barriers, replayMs, 1);
			const quadratic = leastSquares(barriers, replayMs, 2);
			const linearR2 = rSquared(barriers, replayMs, linear);
			const quadraticR2 = rSquared(barriers, replayMs, quadratic);
			const widest = barriers.at(-1) ?? 1;
			rows.push(
				"",
				`Linear fit: ms = ${round(linear[0] ?? 0, 2)} + ${round(linear[1] ?? 0, 3)}·B (R² = ${round(linearR2, 4)})`,
				`Quadratic fit: ms = ${round(quadratic[0] ?? 0, 2)} + ${round(quadratic[1] ?? 0, 3)}·B + ${round(quadratic[2] ?? 0, 5)}·B² (R² = ${round(quadraticR2, 4)})`,
				`Quadratic term at the widest point (B = ${widest}): ${round((100 * (quadratic[2] ?? 0) * widest ** 2) / (replayMs.at(-1) ?? 1))} % of the measured replay`,
			);
			emit(rows);
			expect(barriers).toHaveLength(shapes.length);
			expect(quadraticR2).toBeGreaterThanOrEqual(linearR2 - 1e-9);
			// Replay stays far below the cost of the work it replays: a barrier
			// re-await is milliseconds against an agent's seconds to minutes.
			expect((replayMs.at(-1) ?? 0) / widest).toBeLessThan(1_000);
		},
		55_000,
	);
});
