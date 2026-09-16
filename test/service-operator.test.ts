import { randomUUID } from "node:crypto";
import path from "node:path";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowStateProjection } from "../src/events.js";
import { deriveTaskExecutionId } from "../src/execution.js";
import {
	readWorkflowJournalUnleased,
	type WorkflowJournalEvent,
	WorkflowRunJournal,
} from "../src/persistence/journal.js";
import { acquireWorkflowRunLease } from "../src/persistence/run-lease.js";
import { reduceWorkflowEvents } from "../src/reducer.js";
import { OPERATOR_RESUME_REASON } from "../src/run-actions.js";
import { WorkflowRunRecordStore } from "../src/run-record.js";
import {
	createWorkflowService,
	type WorkflowService,
	WorkflowServiceError,
} from "../src/service.js";
import { WorkflowInvalidationPreviewSchema } from "../src/service-views.js";
import type { WorkflowSubagentProvider } from "../src/subagent-provider.js";
import {
	attemptProvider,
	COMPLETED,
	childFailure,
	INTERRUPTED,
	operatorFixture,
	type Script,
	SHA,
} from "./fixtures/attempt-provider.js";

const REASON = "Operator resumed the interrupted seat.";
const REFUSED = "Subagent refused the attempt.";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

/** Fails fast with a named label instead of hanging the whole suite. */
function bounded<T>(
	promise: Promise<T>,
	label: string,
	ms = 30_000,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`${label} did not settle within ${ms}ms`)),
			ms,
		);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

type Fixture = Awaited<ReturnType<typeof operatorFixture>>;

async function serviceFor(
	fixture: { cwd: string; agentDir: string; storeRoot: string },
	subagents: WorkflowSubagentProvider,
) {
	return createWorkflowService({
		...fixture,
		projectTrusted: () => true,
		subagents,
	});
}

async function journalEvents(
	storeRoot: string,
	runId: string,
): Promise<readonly WorkflowJournalEvent[]> {
	return (await readWorkflowJournalUnleased(storeRoot, runId)).events;
}

async function stateOf(
	storeRoot: string,
	runId: string,
): Promise<WorkflowStateProjection> {
	return reduceWorkflowEvents(await journalEvents(storeRoot, runId));
}

function countOf(events: readonly WorkflowJournalEvent[], type: string) {
	return events.filter((event) => event.type === type).length;
}

function runStatusChanges(events: readonly WorkflowJournalEvent[]) {
	return events
		.filter((event) => event.type === "run-status-changed")
		.map(
			(event) => event.data as { from: string; to: string; reason?: string },
		);
}

function taskStatusChanges(events: readonly WorkflowJournalEvent[]) {
	return events
		.filter((event) => event.type === "task-status-changed")
		.map(
			(event) =>
				event.data as {
					taskId: string;
					from: string;
					to: string;
					reason?: string;
				},
		);
}

function taskIdOf(state: WorkflowStateProjection, key: string): string {
	const task = Object.values(state.tasks).find(
		(candidate) => candidate.task.spec.key === key,
	);
	if (!task) throw new Error(`missing task ${key}`);
	return task.task.id;
}

function executionOf(state: WorkflowStateProjection, taskId: string) {
	const task = state.tasks[taskId];
	const execution = task?.currentExecutionId
		? state.executions[task.currentExecutionId]
		: undefined;
	if (!task || !execution) throw new Error("missing current execution");
	return { task, execution };
}

async function expectServiceError(
	promise: Promise<unknown>,
	code: WorkflowServiceError["code"],
	message: string,
): Promise<void> {
	const outcome = await promise.then(
		(value) => ({ resolved: true as const, value }),
		(error: unknown) => ({ resolved: false as const, error }),
	);
	if (outcome.resolved) {
		throw new Error(
			`expected ${code} "${message}" but the call resolved with ${JSON.stringify(outcome.value)}`,
		);
	}
	expect(outcome.error).toBeInstanceOf(WorkflowServiceError);
	const error = outcome.error as WorkflowServiceError;
	expect({ code: error.code, message: error.message }).toEqual({
		code,
		message,
	});
}

async function shutdownQuietly(service: WorkflowService | undefined) {
	if (!service) return;
	await bounded(service.shutdown(), "shutdown").catch(() => undefined);
}

/** Drives `ref` once with `script` until it settles. */
async function settledRun(fixture: Fixture, ref: string, script: Script) {
	const delegated = attemptProvider(script);
	const service = await serviceFor(fixture, delegated.provider);
	const receipt = await service.run(ref, {});
	const first = await bounded(service.wait(receipt.runId), "first wait");
	const state = await stateOf(fixture.storeRoot, receipt.runId);
	return { service, delegated, runId: receipt.runId, first, state };
}

/** A durably interrupted `attempts` run whose only task carries a resumable failure. */
async function interruptedRun(
	fixture: Fixture,
	script: Script = [INTERRUPTED],
) {
	const run = await settledRun(fixture, "attempts", script);
	expect(run.first.status).toBe("interrupted");
	const taskId = taskIdOf(run.state, "answer");
	expect(run.state.tasks[taskId]?.status).toBe("interrupted");
	return { ...run, taskId };
}

/**
 * Appends the operator resume intent directly to the durable journal, as the
 * service does, without the run transition or a drive: the run is left
 * exactly as a crash between the intent and `interrupted -> running` would.
 */
async function appendOperatorIntentDirectly(
	storeRoot: string,
	runId: string,
	taskId: string,
	reason: string,
) {
	const lease = await acquireWorkflowRunLease({
		storeRoot,
		runId,
		ownerId: "operator",
	});
	try {
		const journal = await WorkflowRunJournal.open(storeRoot, runId, lease);
		const state = reduceWorkflowEvents(await journal.readEvents());
		const { execution } = executionOf(state, taskId);
		const failure = execution.settlement?.evidence.failure;
		const receipt = execution.launchReceipt;
		if (!failure || !receipt) throw new Error("run is not resumable");
		await journal.append("task-execution-attempt-intended", {
			executionId: execution.execution.id,
			subagentRunId: receipt.subagentRunId,
			kind: "resume",
			ordinal: 2 + (execution.attempts?.length ?? 0),
			previousAttemptId: receipt.subagentAttemptId,
			failureCode: failure.code,
			failureRetry: "resume",
			origin: "operator",
			reason,
		});
	} finally {
		await lease.release();
	}
}

/**
 * Replays an interrupted run into a fresh store root under a record that
 * declares a parent run, so the copy is a nested run with the same journal.
 */
async function nestedCopy(fixture: Fixture, runId: string): Promise<string> {
	const sourceLease = await acquireWorkflowRunLease({
		storeRoot: fixture.storeRoot,
		runId,
		ownerId: "replay",
	});
	let record: Awaited<ReturnType<WorkflowRunRecordStore["read"]>>;
	let events: readonly WorkflowJournalEvent[];
	try {
		const source = await WorkflowRunJournal.open(
			fixture.storeRoot,
			runId,
			sourceLease,
		);
		record = await WorkflowRunRecordStore.open(source).read();
		events = await source.readEvents();
	} finally {
		await sourceLease.release();
	}
	const storeRoot = path.join(fixture.cwd, ".pi", `workflow-${randomUUID()}`);
	const lease = await acquireWorkflowRunLease({
		storeRoot,
		runId,
		ownerId: "replay",
	});
	try {
		const journal = await WorkflowRunJournal.open(storeRoot, runId, lease);
		const parentRunId = `workflow_${"b".repeat(32)}`;
		await WorkflowRunRecordStore.open(journal).create({
			...record,
			depth: 1,
			parent: {
				runId: parentRunId,
				taskId: "task_parent",
				executionId: deriveTaskExecutionId(parentRunId, "task_parent", 1),
				ancestorDefinitionIdentities: [SHA],
				inputArtifacts: {},
			},
		});
		for (const event of events) {
			await journal.appendEvent({
				type: event.type,
				data: event.data,
			} as never);
		}
	} finally {
		await lease.release();
	}
	return storeRoot;
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

describe("operator resume", () => {
	it("re-attempts a durably interrupted task on the operator's intent and completes", async () => {
		const fixture = await operatorFixture();
		const { service, delegated, runId, taskId } = await interruptedRun(
			fixture,
			[INTERRUPTED, COMPLETED],
		);
		try {
			const before = await service.inspect(runId);
			expect(before.run.availableActions).toEqual([
				"invalidate",
				"retry",
				"resume",
			]);
			expect(before.run.requiresAttention).toBe(true);
			expect(before.tasks?.[0]).toMatchObject({
				id: taskId,
				role: "task",
				status: "interrupted",
				attempts: 0,
				outcome: "interrupted",
				settlement: { status: "interrupted", failureRetry: "resume" },
			});

			const resumed = await bounded(service.resume(runId, REASON), "resume");
			expect(["running", "waiting", "finalizing", "completed"]).toContain(
				resumed.status,
			);
			const finished = await bounded(service.wait(runId), "wait");
			expect(finished).toMatchObject({
				status: "completed",
				output: { answer: "from child" },
				tasks: [
					expect.objectContaining({
						id: taskId,
						status: "completed",
						generation: 1,
						attempts: 1,
					}),
				],
			});

			// The existing child was resumed; nothing was launched anew.
			expect(delegated.ownerClient.resume).toHaveBeenCalledOnce();
			expect(delegated.ownerClient.resume).toHaveBeenCalledWith(
				delegated.childRunId(1),
			);
			expect(delegated.ownerClient.launch).toHaveBeenCalledOnce();
			expect(delegated.ownerClient.retry).not.toHaveBeenCalled();

			const events = await journalEvents(fixture.storeRoot, runId);
			expect(countOf(events, "task-execution-created")).toBe(1);
			expect(countOf(events, "task-execution-attempt-intended")).toBe(1);
			expect(countOf(events, "task-execution-attempt-receipted")).toBe(1);
			expect(countOf(events, "task-execution-attempt-declined")).toBe(0);
			expect(countOf(events, "task-invalidated")).toBe(0);
			const intent = events.find(
				(event) => event.type === "task-execution-attempt-intended",
			);
			expect(intent?.data).toMatchObject({
				kind: "resume",
				ordinal: 2,
				origin: "operator",
				reason: REASON,
				failureCode: "provider-transient",
				failureRetry: "resume",
			});
			expect(runStatusChanges(events)).toContainEqual({
				from: "interrupted",
				to: "running",
				reason: OPERATOR_RESUME_REASON,
			});
			expect(taskStatusChanges(events)).toContainEqual({
				taskId,
				from: "interrupted",
				to: "running",
				reason: OPERATOR_RESUME_REASON,
			});
			// The intent precedes the run transition, which precedes the receipt.
			const order = events.map((event) => event.type);
			const intentAt = order.indexOf("task-execution-attempt-intended");
			const reopenAt = order.findIndex(
				(type, index) =>
					type === "run-status-changed" &&
					runStatusChanges([events[index] as WorkflowJournalEvent])[0]?.from ===
						"interrupted",
			);
			expect(intentAt).toBeGreaterThan(0);
			expect(reopenAt).toBeGreaterThan(intentAt);
			expect(order.indexOf("task-execution-attempt-receipted")).toBeGreaterThan(
				reopenAt,
			);

			const { task, execution } = executionOf(
				await stateOf(fixture.storeRoot, runId),
				taskId,
			);
			expect(task.status).toBe("completed");
			expect(execution.attempts?.[0]).toMatchObject({
				kind: "resume",
				ordinal: 2,
				origin: "operator",
				reason: REASON,
				status: "active",
				subagentAttemptId: expect.stringMatching(/^attempt_[a-z0-9]+x2$/),
			});
			expect(execution.priorSettlements?.[0]?.evidence).toMatchObject({
				status: "interrupted",
				attemptOrdinal: 1,
			});
			expect(execution.terminal?.evidence).toMatchObject({
				status: "completed",
				attemptOrdinal: 2,
			});

			// The read surface exposes the operator's attempt and its reason.
			const inspection = await service.inspect(runId, {
				include: ["run", "executions"],
			});
			expect(inspection.run.availableActions).toEqual([]);
			expect(inspection.executions?.[0]?.attempts).toEqual([
				expect.objectContaining({
					kind: "resume",
					ordinal: 2,
					origin: "operator",
					reason: REASON,
					state: "receipted",
				}),
			]);
			const logs = await service.logs(runId);
			expect(logs.entries).toContainEqual(
				expect.objectContaining({
					kind: "attempt",
					taskId,
					reason: REASON,
					failureCode: "provider-transient",
					message:
						"Attempt 2 (resume) intended after provider-transient by operator.",
				}),
			);
			expect(logs.entries).toContainEqual(
				expect.objectContaining({
					kind: "run",
					status: "running",
					reason: OPERATOR_RESUME_REASON,
				}),
			);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("returns the run to interrupted when pi-subagent refuses the resume", async () => {
		const fixture = await operatorFixture();
		const { service, delegated, runId, taskId } = await interruptedRun(fixture);
		try {
			vi.mocked(delegated.ownerClient.resume).mockImplementation(async () => {
				throw new Error("seat is not resumable");
			});
			const resumed = await bounded(service.resume(runId, REASON), "resume");
			expect(["running", "waiting", "interrupted"]).toContain(resumed.status);
			const finished = await bounded(service.wait(runId), "wait");
			expect(finished).toMatchObject({
				status: "interrupted",
				tasks: [
					expect.objectContaining({
						id: taskId,
						status: "interrupted",
						generation: 1,
						attempts: 1,
						outcome: "interrupted",
					}),
				],
			});
			expect(delegated.ownerClient.resume).toHaveBeenCalledOnce();
			expect(delegated.ownerClient.findByOperation).toHaveBeenCalledOnce();
			expect(delegated.ownerClient.release).not.toHaveBeenCalled();
			expect(delegated.ownerClient.launch).toHaveBeenCalledOnce();

			const events = await journalEvents(fixture.storeRoot, runId);
			expect(countOf(events, "task-execution-attempt-intended")).toBe(1);
			expect(countOf(events, "task-execution-attempt-receipted")).toBe(0);
			expect(countOf(events, "task-execution-attempt-declined")).toBe(1);
			// The interrupted settlement is terminalized again without release.
			expect(countOf(events, "task-execution-terminal")).toBe(2);
			expect(countOf(events, "task-execution-release-intended")).toBe(0);
			const changes = runStatusChanges(events);
			expect(changes).toContainEqual({
				from: "interrupted",
				to: "running",
				reason: OPERATOR_RESUME_REASON,
			});
			expect(changes.at(-1)).toMatchObject({
				to: "interrupted",
				reason: "A required workflow task was interrupted.",
			});
			expect(
				changes.indexOf(
					changes.find((change) => change.from === "interrupted") as never,
				),
			).toBeLessThan(changes.length - 1);
			expect(
				taskStatusChanges(events).filter((c) => c.to === "running"),
			).toEqual([expect.objectContaining({ from: "ready", to: "running" })]);
			const { execution } = executionOf(
				await stateOf(fixture.storeRoot, runId),
				taskId,
			);
			expect(execution.phase).toBe("terminal");
			expect(execution.attemptsClosed).toBe(true);
			expect(execution.attempts?.[0]).toMatchObject({
				kind: "resume",
				ordinal: 2,
				origin: "operator",
				reason: REASON,
			});
			expect(execution.attempts?.[0]?.declinedSequence).toBeTypeOf("number");

			// The refusal is visible with its fixed reason, and never the child's prose.
			const logs = await service.logs(runId);
			expect(logs.entries).toContainEqual(
				expect.objectContaining({
					kind: "attempt",
					taskId,
					reason: REFUSED,
					message: "Attempt 2 declined.",
				}),
			);
			expect(JSON.stringify(logs)).not.toContain("seat is not resumable");
			expect(JSON.stringify(logs)).not.toContain("provider hiccup");

			// The run is durably interrupted again and the operator may retry
			// the resume; the attempt bound still has headroom.
			const inspection = await service.inspect(runId, {
				include: ["run", "executions"],
			});
			expect(inspection.run).toMatchObject({
				status: "interrupted",
				availableActions: ["invalidate", "retry", "resume"],
				requiresAttention: true,
			});
			expect(inspection.executions?.[0]?.attempts).toEqual([
				expect.objectContaining({
					origin: "operator",
					state: "declined",
					declinedReason: REFUSED,
				}),
			]);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("refuses an already-terminal re-attempt receipt with its own message", async () => {
		const fixture = await operatorFixture();
		const { service, delegated, runId, taskId } = await interruptedRun(fixture);
		try {
			// pi-subagent hands back a receipt for an attempt that has already
			// ended: no task transition from `interrupted` admits it.
			vi.mocked(delegated.ownerClient.resume).mockImplementation(
				async (childRunId: string) => ({
					runId: childRunId,
					attemptId: "attempt_alreadydone",
					status: "completed" as const,
				}),
			);
			await bounded(service.resume(runId, REASON), "resume");
			// The drive fails closed: the run ends `failed` durably and the
			// refusal is its recorded reason, never a lifecycle error.
			const view = await bounded(service.wait(runId), "wait");
			expect(view.status).toBe("failed");
			const logs = await service.logs(runId);
			const runEntries = logs.entries.filter((entry) => entry.kind === "run");
			expect(runEntries.at(-1)).toMatchObject({
				kind: "run",
				status: "failed",
				reason:
					"Operator re-attempt receipt is already completed; an interrupted task re-enters running only through an active or queued attempt.",
			});
			expect(JSON.stringify(logs)).not.toMatch(/lifecycle|transition/i);

			// The refusal happened before any task transition: the task is still
			// interrupted with its receipted attempt, and nothing was finalized.
			const state = await stateOf(fixture.storeRoot, runId);
			expect(state.tasks[taskId]?.status).toBe("interrupted");
			const events = await journalEvents(fixture.storeRoot, runId);
			expect(countOf(events, "task-execution-attempt-receipted")).toBe(1);
			expect(
				taskStatusChanges(events).filter((c) => c.from === "interrupted"),
			).toEqual([]);
			expect(countOf(events, "task-execution-terminal")).toBe(1);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("validates the run id, reason, and task id before touching the run", async () => {
		const fixture = await operatorFixture();
		const { service, runId } = await interruptedRun(fixture);
		try {
			const before = await journalEvents(fixture.storeRoot, runId);
			await expectServiceError(
				service.resume("not-a-run", REASON),
				"validation",
				"Invalid workflow run ID.",
			);
			await expectServiceError(
				service.resume(runId, ""),
				"validation",
				"Invalid workflow resume reason.",
			);
			await expectServiceError(
				service.resume(runId, "x".repeat(4097)),
				"validation",
				"Invalid workflow resume reason.",
			);
			await expectServiceError(
				service.resume(runId, REASON, { taskId: "not a task" }),
				"validation",
				"Invalid workflow task ID.",
			);
			await expectServiceError(
				service.resume(`workflow_${"c".repeat(32)}`, REASON),
				"not-found",
				`Workflow run not found: workflow_${"c".repeat(32)}`,
			);
			expect(await journalEvents(fixture.storeRoot, runId)).toEqual(before);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("refuses resume while the run is still being driven", async () => {
		const fixture = await operatorFixture();
		const delegated = attemptProvider([COMPLETED]);
		const gate = deferred<void>();
		const entered = deferred<void>();
		const scripted = vi
			.mocked(delegated.ownerClient.wait)
			.getMockImplementation();
		vi.mocked(delegated.ownerClient.wait).mockImplementation(
			async (...args) => {
				entered.resolve();
				await gate.promise;
				if (!scripted) throw new Error("missing scripted child wait");
				return scripted(...args);
			},
		);
		const service = await serviceFor(fixture, delegated.provider);
		try {
			const receipt = await service.run("attempts", {});
			await bounded(entered.promise, "child wait entered");
			await expectServiceError(
				service.resume(receipt.runId, REASON),
				"conflict",
				"Workflow run is still being driven.",
			);
			await expectServiceError(
				service.retry(receipt.runId, "task_any", REASON),
				"conflict",
				"Workflow run is still being driven.",
			);
			gate.resolve();
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({ status: "completed" });
		} finally {
			gate.resolve();
			await shutdownQuietly(service);
		}
	});

	it("refuses resume of runs whose status does not admit it", async () => {
		const fixture = await operatorFixture();
		const completed = await settledRun(fixture, "attempts", [COMPLETED]);
		try {
			expect(completed.first.status).toBe("completed");
			await expectServiceError(
				completed.service.resume(completed.runId, REASON),
				"validation",
				"Workflow run status does not admit resume.",
			);
		} finally {
			await shutdownQuietly(completed.service);
		}
		const failed = await settledRun(fixture, "attempts", [
			{ status: "failed", failure: childFailure("manual") },
		]);
		try {
			expect(failed.first.status).toBe("failed");
			await expectServiceError(
				failed.service.resume(failed.runId, REASON),
				"validation",
				"Workflow run status does not admit resume.",
			);
			const inspection = await failed.service.inspect(failed.runId);
			expect(inspection.run.availableActions).toEqual(["invalidate", "retry"]);
		} finally {
			await shutdownQuietly(failed.service);
		}
	});

	it("refuses resume of a nested run through its parent", async () => {
		const fixture = await operatorFixture();
		const first = await interruptedRun(fixture);
		await shutdownQuietly(first.service);
		const storeRoot = await nestedCopy(fixture, first.runId);
		const service = await serviceFor(
			{ ...fixture, storeRoot },
			attemptProvider([COMPLETED]).provider,
		);
		try {
			await expect(service.status(first.runId)).resolves.toMatchObject({
				status: "interrupted",
				depth: 1,
				parent: expect.objectContaining({ taskId: "task_parent" }),
			});
			await expectServiceError(
				service.resume(first.runId, REASON),
				"validation",
				"Nested workflow runs are resumed through their parent run.",
			);
			await expectServiceError(
				service.retry(first.runId, first.taskId, REASON),
				"validation",
				"Nested workflow runs are invalidated through their parent run.",
			);
			const inspection = await service.inspect(first.runId);
			expect(inspection.run.availableActions).toEqual([]);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("refuses resume while the run already awaits recovery and recovers through wait", async () => {
		const fixture = await operatorFixture();
		const first = await interruptedRun(fixture, [INTERRUPTED, COMPLETED]);
		await shutdownQuietly(first.service);
		const { runId, taskId } = first;
		// A crash between the intent and `interrupted -> running` leaves the
		// run durably interrupted with an open operator intent.
		await appendOperatorIntentDirectly(
			fixture.storeRoot,
			runId,
			taskId,
			REASON,
		);
		const durable = await stateOf(fixture.storeRoot, runId);
		expect(durable.status).toBe("interrupted");
		expect(durable.tasks[taskId]?.status).toBe("interrupted");
		expect(executionOf(durable, taskId).execution.phase).toBe(
			"attempt-intended",
		);

		const second = attemptProvider([COMPLETED]);
		const service = await serviceFor(fixture, second.provider);
		try {
			// The open intent is pending recovery: only wait is offered.
			const listed = await service.listRuns();
			expect(listed.runs[0]).toMatchObject({
				runId,
				status: "interrupted",
				availableActions: ["wait"],
				requiresAttention: false,
			});
			// The refusal names what is pending: the operator's resume, not
			// invalidated work (none exists on this run).
			await expectServiceError(
				service.resume(runId, REASON),
				"validation",
				"Workflow run already awaits recovery of an operator resume.",
			);
			await expectServiceError(
				service.retry(runId, taskId, REASON),
				"validation",
				"Workflow run already awaits recovery of an operator resume.",
			);
			await expectServiceError(
				service.invalidate(runId, taskId, REASON),
				"validation",
				"Workflow run already awaits recovery of an operator resume.",
			);
			const untouched = await journalEvents(fixture.storeRoot, runId);
			expect(countOf(untouched, "task-execution-attempt-intended")).toBe(1);
			expect(runStatusChanges(untouched)).not.toContainEqual(
				expect.objectContaining({ from: "interrupted", to: "running" }),
			);

			// The pending recovery is performed by the next wait: the runtime
			// reopens the run on the operator's evidence and the attempt runs.
			const finished = await bounded(service.wait(runId), "wait");
			expect(finished).toMatchObject({
				status: "completed",
				output: { answer: "from child" },
				tasks: [expect.objectContaining({ id: taskId, status: "completed" })],
			});
			expect(second.ownerClient.launch).not.toHaveBeenCalled();
			expect(second.ownerClient.resume).toHaveBeenCalledOnce();
			expect(second.ownerClient.resume).toHaveBeenCalledWith(
				first.delegated.childRunId(1),
			);
			const events = await journalEvents(fixture.storeRoot, runId);
			expect(countOf(events, "task-execution-attempt-intended")).toBe(1);
			expect(countOf(events, "task-execution-attempt-receipted")).toBe(1);
			expect(countOf(events, "task-execution-attempt-declined")).toBe(0);
			expect(countOf(events, "task-execution-created")).toBe(1);
			expect(runStatusChanges(events)).toContainEqual({
				from: "interrupted",
				to: "running",
				reason: OPERATOR_RESUME_REASON,
			});
			expect(taskStatusChanges(events)).toContainEqual(
				expect.objectContaining({
					taskId,
					from: "interrupted",
					to: "running",
				}),
			);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("refuses resume once the run deadline has passed", {
		timeout: 20_000,
	}, async () => {
		const fixture = await operatorFixture();
		const { service, runId } = await settledRun(fixture, "brief", [
			INTERRUPTED,
		]);
		try {
			const view = await service.status(runId);
			expect(view.status).toBe("interrupted");
			const remaining = Date.parse(view.deadlineAt) - Date.now();
			if (remaining > 0) {
				await new Promise((resolve) => setTimeout(resolve, remaining + 50));
			}
			await expectServiceError(
				service.resume(runId, REASON),
				"validation",
				"Workflow run deadline has passed.",
			);
			const inspection = await service.inspect(runId);
			expect(inspection.run.availableActions).toEqual([]);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("refuses resume when no task is resumable and names the refusal for a task", async () => {
		const fixture = await operatorFixture();
		const { service, runId, taskId } = await interruptedRun(fixture, [
			{ status: "interrupted", failure: childFailure("never") },
		]);
		try {
			await expectServiceError(
				service.resume(runId, REASON),
				"validation",
				"Workflow run has no resumable task.",
			);
			await expectServiceError(
				service.resume(runId, REASON, { taskId }),
				"validation",
				"Workflow resume requires an interrupted task with a resumable failure.",
			);
			await expectServiceError(
				service.resume(runId, REASON, { taskId: "task_unknown0000" }),
				"validation",
				"Unknown workflow task.",
			);
			const inspection = await service.inspect(runId);
			expect(inspection.run.availableActions).toEqual(["invalidate", "retry"]);
			const events = await journalEvents(fixture.storeRoot, runId);
			expect(countOf(events, "task-execution-attempt-intended")).toBe(0);
			await expect(service.status(runId)).resolves.toMatchObject({
				status: "interrupted",
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("requires taskId when several tasks are resumable; the rest recover through retry", async () => {
		const fixture = await operatorFixture();
		const run = await settledRun(fixture, "pair", (launch) =>
			launch === 1
				? [INTERRUPTED, COMPLETED]
				: launch === 2
					? [INTERRUPTED]
					: [COMPLETED],
		);
		const { service, delegated, runId, state } = run;
		try {
			expect(run.first.status).toBe("interrupted");
			const a = taskIdOf(state, "a");
			const b = taskIdOf(state, "b");
			expect(state.tasks[a]?.status).toBe("interrupted");
			expect(state.tasks[b]?.status).toBe("interrupted");
			await expectServiceError(
				service.resume(runId, REASON),
				"validation",
				"Workflow run has multiple resumable tasks; specify taskId.",
			);
			const resumed = await bounded(
				service.resume(runId, REASON, { taskId: a }),
				"resume a",
			);
			expect(resumed.status).not.toBe("interrupted");
			// The chosen task re-attempts and completes; the result barrier then
			// reads the other task's interruption and the run ends durably.
			const afterResume = await bounded(service.wait(runId), "wait");
			expect(afterResume.status).toBe("failed");
			expect(afterResume.tasks?.find((task) => task.id === a)).toMatchObject({
				status: "completed",
				generation: 1,
				attempts: 1,
			});
			expect(afterResume.tasks?.find((task) => task.id === b)).toMatchObject({
				status: "interrupted",
				generation: 1,
				attempts: 0,
			});
			expect(delegated.ownerClient.resume).toHaveBeenCalledOnce();
			expect(delegated.ownerClient.resume).toHaveBeenCalledWith(
				delegated.childRunId(1),
			);
			const inspection = await service.inspect(runId);
			expect(inspection.run.availableActions).toEqual(["invalidate", "retry"]);

			// The remaining interrupted task recovers as a new generation.
			await bounded(service.retry(runId, b, "operator re-run"), "retry b");
			const finished = await bounded(service.wait(runId), "wait");
			expect(finished).toMatchObject({
				status: "completed",
				output: { answer: "from child" },
			});
			expect(finished.tasks?.find((task) => task.id === a)).toMatchObject({
				status: "completed",
				generation: 1,
			});
			expect(finished.tasks?.find((task) => task.id === b)).toMatchObject({
				status: "completed",
				generation: 2,
			});
			expect(delegated.ownerClient.launch).toHaveBeenCalledTimes(3);
			expect(delegated.ownerClient.resume).toHaveBeenCalledOnce();
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("refuses resume of a task whose dependents already observed it", async () => {
		const fixture = await operatorFixture();
		const run = await settledRun(fixture, "chain", (launch) =>
			launch === 1 ? [INTERRUPTED] : [COMPLETED],
		);
		const { service, delegated, runId, state } = run;
		try {
			expect(run.first.status).toBe("interrupted");
			const a = taskIdOf(state, "a");
			expect(state.tasks[a]?.status).toBe("interrupted");
			// The workflow observed `a` through the settled barrier and went on to
			// a later epoch: resuming `a` would silently change what it acted on.
			expect(state.barriers.map((barrier) => barrier.epoch)).toEqual([1, 2]);
			await expectServiceError(
				service.resume(runId, REASON, { taskId: a }),
				"validation",
				"Use workflow_invalidate; dependents already observed this task.",
			);
			await expectServiceError(
				service.resume(runId, REASON),
				"validation",
				"Workflow run has no resumable task.",
			);
			const inspection = await service.inspect(runId);
			expect(inspection.run.availableActions).toEqual(["invalidate", "retry"]);
			expect(delegated.ownerClient.resume).not.toHaveBeenCalled();

			// The advertised alternative re-executes the task and abandons the
			// epoch that observed it.
			await bounded(service.retry(runId, a, "operator re-run"), "retry");
			const finished = await bounded(service.wait(runId), "wait");
			expect(finished).toMatchObject({
				status: "completed",
				output: { answer: "settled" },
				tasks: [
					expect.objectContaining({
						id: a,
						status: "completed",
						generation: 2,
					}),
				],
			});
			const events = await journalEvents(fixture.storeRoot, runId);
			const invalidated = events.find(
				(event) => event.type === "task-invalidated",
			);
			expect(invalidated?.data).toMatchObject({
				causeTaskId: a,
				taskIds: [a],
				abandonedEpochs: [2],
			});
			expect(delegated.ownerClient.launch).toHaveBeenCalledTimes(2);
			expect(delegated.ownerClient.resume).not.toHaveBeenCalled();
		} finally {
			await shutdownQuietly(service);
		}
	});
});

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------

describe("operator retry", () => {
	it("re-executes a failed task as generation 2 and completes", async () => {
		const fixture = await operatorFixture();
		const run = await settledRun(fixture, "attempts", (launch) =>
			launch === 1
				? [{ status: "failed", failure: childFailure("manual") }]
				: [COMPLETED],
		);
		const { service, delegated, runId, state } = run;
		try {
			expect(run.first.status).toBe("failed");
			const taskId = taskIdOf(state, "answer");
			const inspection = await service.inspect(runId);
			expect(inspection.run.availableActions).toEqual(["invalidate", "retry"]);
			const retried = await bounded(
				service.retry(runId, taskId, "operator re-run"),
				"retry",
			);
			expect(retried.status).not.toBe("failed");
			const finished = await bounded(service.wait(runId), "wait");
			expect(finished).toMatchObject({
				status: "completed",
				output: { answer: "from child" },
				tasks: [
					expect.objectContaining({
						id: taskId,
						status: "completed",
						generation: 2,
					}),
				],
			});
			const events = await journalEvents(fixture.storeRoot, runId);
			const invalidated = events.find(
				(event) => event.type === "task-invalidated",
			);
			expect(invalidated?.data).toMatchObject({
				causeTaskId: taskId,
				taskIds: [taskId],
				abandonedEpochs: [],
				reason: "operator re-run",
			});
			expect(runStatusChanges(events)).toContainEqual({
				from: "failed",
				to: "running",
				reason: "Explicit invalidation re-executes invalidated tasks.",
			});
			expect(
				events
					.filter((event) => event.type === "task-execution-created")
					.map(
						(event) =>
							(event.data as { execution: { generation: number } }).execution
								.generation,
					),
			).toEqual([1, 2]);
			expect(delegated.ownerClient.launch).toHaveBeenCalledTimes(2);
			expect(delegated.ownerClient.retry).not.toHaveBeenCalled();
			expect(delegated.ownerClient.resume).not.toHaveBeenCalled();
			const final = await service.inspect(runId);
			expect(final.run.availableActions).toEqual([]);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("re-executes an interrupted task as generation 2 without resuming the child", async () => {
		const fixture = await operatorFixture();
		const run = await interruptedRun(fixture, (launch) =>
			launch === 1 ? [INTERRUPTED] : [COMPLETED],
		);
		const { service, delegated, runId, taskId } = run;
		try {
			await bounded(service.retry(runId, taskId, "operator re-run"), "retry");
			const finished = await bounded(service.wait(runId), "wait");
			expect(finished).toMatchObject({
				status: "completed",
				tasks: [
					expect.objectContaining({
						id: taskId,
						status: "completed",
						generation: 2,
					}),
				],
			});
			expect(delegated.ownerClient.launch).toHaveBeenCalledTimes(2);
			expect(delegated.ownerClient.resume).not.toHaveBeenCalled();
			const events = await journalEvents(fixture.storeRoot, runId);
			expect(countOf(events, "task-execution-attempt-intended")).toBe(0);
			expect(runStatusChanges(events)).toContainEqual(
				expect.objectContaining({ from: "interrupted", to: "running" }),
			);
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("validates its arguments and requires a failed or interrupted cause task", async () => {
		const fixture = await operatorFixture();
		const failed = await settledRun(fixture, "attempts", [
			{ status: "failed", failure: childFailure("manual") },
		]);
		try {
			expect(failed.first.status).toBe("failed");
			const taskId = taskIdOf(failed.state, "answer");
			await expectServiceError(
				failed.service.retry("nope", taskId, "r"),
				"validation",
				"Invalid workflow run ID.",
			);
			await expectServiceError(
				failed.service.retry(failed.runId, "not a task", "r"),
				"validation",
				"Invalid workflow task ID.",
			);
			await expectServiceError(
				failed.service.retry(failed.runId, taskId, ""),
				"validation",
				"Invalid workflow retry reason.",
			);
			await expectServiceError(
				failed.service.retry(failed.runId, "task_unknown0000", "r"),
				"validation",
				"Workflow retry requires a failed or interrupted task.",
			);
			const events = await journalEvents(fixture.storeRoot, failed.runId);
			expect(countOf(events, "task-invalidated")).toBe(0);
			await expect(failed.service.status(failed.runId)).resolves.toMatchObject({
				status: "failed",
			});
		} finally {
			await shutdownQuietly(failed.service);
		}
		const completed = await settledRun(fixture, "attempts", [COMPLETED]);
		try {
			await expectServiceError(
				completed.service.retry(
					completed.runId,
					taskIdOf(completed.state, "answer"),
					"r",
				),
				"validation",
				"Workflow run status does not admit invalidation.",
			);
		} finally {
			await shutdownQuietly(completed.service);
		}
		// A settled task that did not fail is not a retry cause even on a
		// run that admits invalidation.
		const pair = await settledRun(fixture, "pair", (launch) =>
			launch === 1 ? [INTERRUPTED] : [COMPLETED],
		);
		try {
			expect(pair.first.status).toBe("interrupted");
			const b = taskIdOf(pair.state, "b");
			expect(pair.state.tasks[b]?.status).toBe("completed");
			await expectServiceError(
				pair.service.retry(pair.runId, b, "r"),
				"validation",
				"Workflow retry requires a failed or interrupted task.",
			);
			const events = await journalEvents(fixture.storeRoot, pair.runId);
			expect(countOf(events, "task-invalidated")).toBe(0);
		} finally {
			await shutdownQuietly(pair.service);
		}
	});
});

// ---------------------------------------------------------------------------
// previewInvalidation
// ---------------------------------------------------------------------------

describe("invalidation preview", () => {
	it("reports the closure the reducer journals and the declarations it retires", async () => {
		const fixture = await operatorFixture();
		const run = await settledRun(fixture, "chain", (launch) =>
			launch === 1 ? [INTERRUPTED] : [COMPLETED],
		);
		const { service, runId, state } = run;
		try {
			expect(run.first.status).toBe("interrupted");
			const a = taskIdOf(state, "a");
			const preview = await service.previewInvalidation(runId, a);
			expect(Value.Check(WorkflowInvalidationPreviewSchema, preview)).toBe(
				true,
			);
			expect(preview).toEqual({
				runId,
				causeTaskId: a,
				taskIds: [a],
				taskKeys: ["/a"],
				abandonedEpochs: [2],
				abandonedTaskIds: [],
			});
			// A preview appends nothing and changes no status.
			const before = await journalEvents(fixture.storeRoot, runId);
			expect(countOf(before, "task-invalidated")).toBe(0);
			await expect(service.status(runId)).resolves.toMatchObject({
				status: "interrupted",
			});

			// The subsequent invalidation journals exactly the previewed closure
			// and abandons exactly the previewed declarations.
			await bounded(service.retry(runId, a, "operator re-run"), "retry");
			await bounded(service.wait(runId), "wait");
			const events = await journalEvents(fixture.storeRoot, runId);
			const invalidated = events.find(
				(event) => event.type === "task-invalidated",
			);
			expect(invalidated?.data).toMatchObject({
				causeTaskId: a,
				taskIds: preview.taskIds,
				abandonedEpochs: preview.abandonedEpochs,
			});
			const after = await stateOf(fixture.storeRoot, runId);
			expect(
				Object.values(after.tasks)
					.filter(
						(task) =>
							task.abandoned === true &&
							state.tasks[task.task.id]?.abandoned !== true,
					)
					.map((task) => task.task.id),
			).toEqual(preview.abandonedTaskIds);

			// Legality is not the preview's concern: the completed run still
			// previews (availableActions decides whether invalidate is offered),
			// and the re-executed source readopted the epoch after the barrier.
			const inspection = await service.inspect(runId);
			expect(inspection.run.availableActions).toEqual([]);
			await expect(service.previewInvalidation(runId, a)).resolves.toEqual({
				runId,
				causeTaskId: a,
				taskIds: [a],
				taskKeys: ["/a"],
				abandonedEpochs: after.barriers
					.filter((barrier) => barrier.abandoned !== true && barrier.epoch > 1)
					.map((barrier) => barrier.epoch),
				abandonedTaskIds: [],
			});
		} finally {
			await shutdownQuietly(service);
		}
	});

	it("validates its arguments and raises the reducer's refusals", async () => {
		const fixture = await operatorFixture();
		const run = await settledRun(fixture, "attempts", [
			{ status: "failed", failure: childFailure("manual") },
		]);
		const { service, runId, state } = run;
		try {
			const taskId = taskIdOf(state, "answer");
			await expectServiceError(
				service.previewInvalidation("nope", taskId),
				"validation",
				"Invalid workflow run ID.",
			);
			await expectServiceError(
				service.previewInvalidation(runId, "not a task"),
				"validation",
				"Invalid workflow task ID.",
			);
			await expectServiceError(
				service.previewInvalidation(runId, "task_unknown0000"),
				"validation",
				"invalidation cause task is unknown",
			);
			await expectServiceError(
				service.previewInvalidation(`workflow_${"c".repeat(32)}`, taskId),
				"not-found",
				`Workflow run not found: workflow_${"c".repeat(32)}`,
			);
			await expect(
				service.previewInvalidation(runId, taskId),
			).resolves.toMatchObject({ taskIds: [taskId], abandonedEpochs: [] });
			await bounded(service.shutdown(), "shutdown");
			await expectServiceError(
				service.previewInvalidation(runId, taskId),
				"conflict",
				"Workflow service is closed.",
			);
		} finally {
			await shutdownQuietly(service);
		}
	});
});
