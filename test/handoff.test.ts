import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { HANDOFF_EXPORT_MEDIA_TYPE } from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { WorkflowArtifactStore } from "../src/artifact-store.js";
import {
	type AgentTaskExecutionRecord,
	type HandoffPolicy,
	type MaterializedAgentTask,
	type SubagentHandoffEvidence,
	type SubagentTerminalEvidence,
	WORKFLOW_HANDOFF_FORMAT_SHA256,
	type WorkflowArtifactRef,
	type WorkflowTaskId,
} from "../src/contracts.js";
import type {
	WorkflowEventInput,
	WorkflowStateProjection,
} from "../src/events.js";
import {
	deriveJsonValueSha256,
	deriveSubagentOperationId,
	deriveTaskExecutionId,
	deriveWorkflowArtifactId,
} from "../src/execution.js";
import {
	type VerifiedWorkflowHandoff,
	verifyWorkflowHandoffEvidence,
	WORKFLOW_HANDOFF_UNVERIFIED_MESSAGE,
	WORKFLOW_HANDOFF_VERIFICATION_MESSAGES,
	WorkflowHandoffVerificationError,
	type WorkflowHandoffVerificationReason,
} from "../src/handoff.js";
import {
	type MaterializationCommit,
	WorkflowTaskMaterializer,
} from "../src/materializer.js";
import {
	type WorkflowJournalEvent,
	WorkflowRunJournal,
} from "../src/persistence/journal.js";
import {
	acquireWorkflowRunLease,
	type WorkflowRunLease,
} from "../src/persistence/run-lease.js";
import { reduceWorkflowEvents } from "../src/reducer.js";

// Expectations follow the revision 17 handoff-adoption spec, section 5
// (replay identity) and D8/D10 (attempts and generations).

const RUN_ID = "workflow_handoff" as const;
const definitionIdentitySha256 = "a".repeat(64);
const inputSha256 = "b".repeat(64);
const planIdentitySha256 = "c".repeat(64);
const resultSha256 = "d".repeat(64);
const structuredOutputSha256 = "e".repeat(64);
const workspaceBaselineSha256 = "f".repeat(64);
const BASELINE_HEAD = "0123456789abcdef0123456789abcdef01234567";
const HANDOFF_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";
const OTHER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
const OTHER_BASELINE = "76543210fedcba9876543210fedcba9876543210";
const outputSchema = Type.Object({ answer: Type.String() });
const leases = new Set<WorkflowRunLease>();
const fixtureRoot = path.resolve(
	".pi",
	"test-handoff",
	`session-${randomUUID()}`,
);

afterEach(async () => {
	await Promise.all([...leases].map((lease) => lease.release()));
	leases.clear();
});

afterAll(async () => {
	await rm(fixtureRoot, { recursive: true, force: true });
});

async function store(): Promise<WorkflowArtifactStore> {
	const root = path.join(fixtureRoot, `run-${randomUUID()}`);
	const lease = await acquireWorkflowRunLease({
		storeRoot: root,
		runId: RUN_ID,
		ownerId: "handoff-test",
	});
	leases.add(lease);
	const journal = await WorkflowRunJournal.open(root, RUN_ID, lease);
	return WorkflowArtifactStore.open({ journal });
}

/** A single-commit `git format-patch` rendering with git's fixed mbox date. */
function patch(commit: string): Buffer {
	return Buffer.from(
		[
			`From ${commit} Mon Sep 17 00:00:00 2001`,
			"From: Writer <writer@example.com>",
			"Date: Tue, 15 Sep 2026 00:00:00 +0000",
			"Subject: [PATCH] Write the change",
			"",
			"---",
			"diff --git a/file.txt b/file.txt",
			"--- a/file.txt",
			"+++ b/file.txt",
			"@@ -1 +1 @@",
			"-before",
			"+after",
			"",
		].join("\n"),
		"utf8",
	);
}

function request(mode: "read-only" | "worktree", handoff?: HandoffPolicy) {
	return {
		agent: "writer",
		task: {
			goal: "Write",
			context: [],
			instructions: ["Return structured output."],
		},
		contextMode: "fresh" as const,
		tools: ["read"],
		preloadSkills: [],
		contextScopes: ["project" as const],
		workspace: { mode, cwd: "/repo" },
		...(handoff === undefined ? {} : { handoff }),
		outputSchema,
		limits: {
			cumulativeRuntimeMs: 300_000,
			attemptTimeoutMs: 300_000,
			totalTokens: 1_000_000,
			cost: 100,
			outputBytes: 1_048_576,
			workspaceWriteBytes: mode === "worktree" ? 1_048_576 : 0,
			retries: 0,
			resumes: 0,
		},
	};
}

function records(
	inputs: readonly WorkflowEventInput[],
): WorkflowJournalEvent[] {
	return inputs.map((input, index) => ({
		schema: "pi-workflow-event",
		contractRevision: 18,
		sequence: index + 1,
		eventId: `event-${index + 1}`,
		timestamp: "2026-09-15T00:00:00.000Z",
		runId: RUN_ID,
		ownerId: "test",
		leaseId: "lease-test",
		fencingGeneration: 1,
		type: input.type,
		data: input.data,
	}));
}

function reduce(
	inputs: readonly WorkflowEventInput[],
): WorkflowStateProjection {
	return reduceWorkflowEvents(records(inputs));
}

/** The reducer freezes its projection; hand-built variants mutate a clone. */
function mutated(
	state: WorkflowStateProjection,
	mutate: (clone: WorkflowStateProjection) => void,
): WorkflowStateProjection {
	const clone = structuredClone(state);
	mutate(clone);
	return clone;
}

interface Graph {
	readonly task: MaterializedAgentTask;
	readonly execution: AgentTaskExecutionRecord;
	readonly events: WorkflowEventInput[];
}

function agentDeclaration(
	commit: MaterializationCommit,
	taskId: WorkflowTaskId,
): MaterializedAgentTask {
	for (const event of commit.events) {
		if (
			event.type === "task-declared" &&
			event.data.task.id === taskId &&
			event.data.task.spec.kind === "agent"
		) {
			return event.data.task as MaterializedAgentTask;
		}
	}
	throw new Error(`missing agent declaration for ${taskId}`);
}

/** One task under a final barrier, ready with generation 1 created. */
function graph(mode: "read-only" | "worktree", handoff?: HandoffPolicy): Graph {
	const m = new WorkflowTaskMaterializer({
		runId: RUN_ID,
		definitionIdentitySha256,
		inputSha256,
	});
	const handle = m.agent("writer", request(mode, handoff));
	const commit = m.closeEpoch("final", [handle]);
	const task = agentDeclaration(commit, handle.ref.taskId);
	const execution: AgentTaskExecutionRecord = {
		kind: "agent",
		id: deriveTaskExecutionId(RUN_ID, task.id, 1),
		runId: RUN_ID,
		taskId: task.id,
		generation: 1,
		taskIdentitySha256: task.spec.identitySha256,
		operationId: deriveSubagentOperationId(RUN_ID, task.id, 1),
	};
	return {
		task,
		execution,
		events: [
			{ type: "run-created", data: { definitionIdentitySha256, inputSha256 } },
			...commit.events,
			{ type: "run-status-changed", data: { from: "created", to: "running" } },
			{
				type: "task-status-changed",
				data: { taskId: task.id, from: "pending", to: "ready" },
			},
			{ type: "task-execution-created", data: { execution } },
		],
	};
}

function childIds(execution: AgentTaskExecutionRecord) {
	const stem = `${execution.taskId.slice(5, 13)}g${execution.generation}`;
	return { subagentRunId: `run_${stem}`, subagentAttemptId: `attempt_${stem}` };
}

function handoffEvidence(
	execution: AgentTaskExecutionRecord,
): SubagentHandoffEvidence {
	return {
		attemptId: childIds(execution).subagentAttemptId,
		baselineHead: BASELINE_HEAD,
		handoffCommit: HANDOFF_COMMIT,
	};
}

function completedEvidence(
	handoff?: SubagentHandoffEvidence,
): SubagentTerminalEvidence {
	return {
		kind: "subagent",
		attemptOrdinal: 1,
		resultSha256,
		status: "completed",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: 0.01,
		},
		usageComplete: true,
		runtimeMs: 1000,
		sandboxCleanup: "proved",
		workspaceCleanup: "proved",
		truncated: false,
		structuredOutputSha256,
		...(handoff === undefined ? {} : { handoff }),
	};
}

function resultArtifact(graph: Graph): WorkflowArtifactRef {
	const input = {
		runId: RUN_ID,
		producerTaskId: graph.task.id,
		producerExecutionId: graph.execution.id,
		output: "result" as const,
		sha256: structuredOutputSha256,
		schemaSha256: deriveJsonValueSha256(outputSchema),
	};
	return {
		id: deriveWorkflowArtifactId(input),
		...input,
		bytes: 18,
		mediaType: "application/json",
	};
}

/** A handoff ref that was never stored: its digest names no blob. */
function unstoredHandoffArtifact(graph: Graph): WorkflowArtifactRef {
	const input = {
		runId: RUN_ID,
		producerTaskId: graph.task.id,
		producerExecutionId: graph.execution.id,
		output: "handoff" as const,
		sha256: "1".repeat(64),
		schemaSha256: WORKFLOW_HANDOFF_FORMAT_SHA256,
	};
	return {
		id: deriveWorkflowArtifactId(input),
		...input,
		bytes: 4096,
		mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
	};
}

async function storedHandoffArtifact(
	artifacts: WorkflowArtifactStore,
	graph: Graph,
	commit = HANDOFF_COMMIT,
): Promise<WorkflowArtifactRef> {
	return artifacts.putBytes(patch(commit), {
		runId: RUN_ID,
		producerTaskId: graph.task.id,
		producerExecutionId: graph.execution.id,
		output: "handoff",
		mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
		schemaSha256: WORKFLOW_HANDOFF_FORMAT_SHA256,
	});
}

/** Launch through result import at phase `artifact-imported`. */
function importedResult(
	graph: Graph,
	evidence: SubagentTerminalEvidence,
): WorkflowEventInput[] {
	const execution = graph.execution;
	const child = childIds(execution);
	const result = resultArtifact(graph);
	return [
		{
			type: "task-execution-preflighted",
			data: {
				executionId: execution.id,
				operationId: execution.operationId,
				preflightId: "preflight-1",
				planIdentitySha256,
				plannedSubagentRunId: child.subagentRunId,
				plannedSubagentAttemptId: child.subagentAttemptId,
				expiresAt: "2027-01-01T00:00:00.000Z",
				workspaceMode: graph.task.spec.request.workspace.mode,
				workspaceBaselineSha256,
			},
		},
		{
			type: "task-execution-launch-intended",
			data: {
				executionId: execution.id,
				operationId: execution.operationId,
				preflightId: "preflight-1",
				planIdentitySha256,
			},
		},
		{
			type: "task-execution-launch-receipted",
			data: {
				executionId: execution.id,
				operationId: execution.operationId,
				...child,
				status: "active",
			},
		},
		{
			type: "task-status-changed",
			data: { taskId: graph.task.id, from: "ready", to: "running" },
		},
		{
			type: "task-execution-child-observed",
			data: { executionId: execution.id, ...child, status: "completed" },
		},
		{
			type: "task-execution-child-settled",
			data: { executionId: execution.id, evidence },
		},
		{ type: "artifact-declared", data: { artifact: result } },
		{
			type: "task-execution-artifact-imported",
			data: {
				executionId: execution.id,
				subagentRunId: child.subagentRunId,
				artifactId: result.id,
				sourceResultSha256: resultSha256,
			},
		},
	];
}

function releaseLadder(graph: Graph): WorkflowEventInput[] {
	const execution = graph.execution;
	const { subagentRunId } = childIds(execution);
	return [
		{
			type: "task-execution-release-intended",
			data: { executionId: execution.id, subagentRunId },
		},
		{
			type: "task-execution-released",
			data: { executionId: execution.id, subagentRunId, status: "completed" },
		},
	];
}

/** Spec 4.5 "worktree success" through `task-status-changed -> completed`. */
function importedHandoffState(
	graph: Graph,
	artifact: WorkflowArtifactRef,
): WorkflowStateProjection {
	const execution = graph.execution;
	const child = childIds(execution);
	const evidence = completedEvidence(handoffEvidence(execution));
	return reduce([
		...graph.events,
		...importedResult(graph, evidence),
		{ type: "artifact-declared", data: { artifact } },
		{
			type: "task-execution-handoff-imported",
			data: {
				executionId: execution.id,
				...child,
				artifactId: artifact.id,
				handoffCommit: HANDOFF_COMMIT,
				baselineHead: BASELINE_HEAD,
				sha256: artifact.sha256,
				bytes: artifact.bytes,
			},
		},
		...releaseLadder(graph),
		{
			type: "task-execution-terminal",
			data: { executionId: execution.id, outcome: "completed", evidence },
		},
		{
			type: "task-status-changed",
			data: { taskId: graph.task.id, from: "running", to: "completed" },
		},
	]);
}

/** Spec 4.5 "no changes": absence recorded and the child released. */
function absentHandoffState(graph: Graph): WorkflowStateProjection {
	const execution = graph.execution;
	return reduce([
		...graph.events,
		...importedResult(graph, completedEvidence()),
		{
			type: "task-execution-handoff-absent",
			data: { executionId: execution.id, ...childIds(execution) },
		},
		...releaseLadder(graph),
	]);
}

function taskOf(state: WorkflowStateProjection, graph: Graph) {
	const task = state.tasks[graph.task.id];
	if (!task) throw new Error("missing task projection");
	return task;
}

async function failure(
	state: WorkflowStateProjection,
	graph: Graph,
	artifacts: WorkflowArtifactStore,
): Promise<WorkflowHandoffVerificationError> {
	const error = await verifyWorkflowHandoffEvidence(
		state,
		taskOf(state, graph),
		artifacts,
	).then(
		() => undefined,
		(reason: unknown) => reason,
	);
	expect(error).toBeInstanceOf(WorkflowHandoffVerificationError);
	return error as WorkflowHandoffVerificationError;
}

async function expectReason(
	state: WorkflowStateProjection,
	graph: Graph,
	artifacts: WorkflowArtifactStore,
	reason: WorkflowHandoffVerificationReason,
): Promise<WorkflowHandoffVerificationError> {
	const error = await failure(state, graph, artifacts);
	expect(error.reason).toBe(reason);
	expect(error.message).toBe(WORKFLOW_HANDOFF_VERIFICATION_MESSAGES[reason]);
	return error;
}

describe("verifyWorkflowHandoffEvidence", () => {
	it("publishes the fixed runtime message and typed reasons", () => {
		expect(WORKFLOW_HANDOFF_UNVERIFIED_MESSAGE).toBe(
			"Completed worktree task has no verified handoff artifact.",
		);
		const error = new WorkflowHandoffVerificationError("commit-mismatch");
		expect(error.name).toBe("WorkflowHandoffVerificationError");
		expect(error.message).toBe(
			WORKFLOW_HANDOFF_VERIFICATION_MESSAGES["commit-mismatch"],
		);
		expect(Object.isFrozen(WORKFLOW_HANDOFF_VERIFICATION_MESSAGES)).toBe(true);
	});

	it("verifies the current execution's imported handoff against its blob and settlement", async () => {
		const artifacts = await store();
		const g = graph("worktree");
		const artifact = await storedHandoffArtifact(artifacts, g);
		const state = importedHandoffState(g, artifact);
		expect(taskOf(state, g).status).toBe("completed");
		const verified: VerifiedWorkflowHandoff =
			await verifyWorkflowHandoffEvidence(state, taskOf(state, g), artifacts);
		expect(verified.status).toBe("imported");
		if (verified.status !== "imported") throw new Error("unreachable");
		expect(verified.artifact).toEqual(artifact);
		expect(verified.execution.execution.id).toBe(g.execution.id);
		expect(verified.content.equals(patch(HANDOFF_COMMIT))).toBe(true);
		expect(verified.execution.handoffImport).toMatchObject({
			artifactId: artifact.id,
			handoffCommit: HANDOFF_COMMIT,
			baselineHead: BASELINE_HEAD,
		});
	});

	it("rejects a task that is not a worktree agent task", async () => {
		const artifacts = await store();
		const g = graph("read-only");
		const state = reduce([
			...g.events,
			...importedResult(g, completedEvidence()),
		]);
		await expectReason(state, g, artifacts, "not-worktree-task");
	});

	it("rejects a task without a current agent execution", async () => {
		const artifacts = await store();
		const g = graph("worktree");
		const artifact = await storedHandoffArtifact(artifacts, g);
		const state = importedHandoffState(g, artifact);
		await expectReason(
			mutated(state, (clone) => {
				delete clone.tasks[g.task.id]?.currentExecutionId;
			}),
			g,
			artifacts,
			"no-current-execution",
		);
		await expectReason(
			mutated(state, (clone) => {
				const task = clone.tasks[g.task.id];
				if (task) {
					task.currentExecutionId = deriveTaskExecutionId(RUN_ID, g.task.id, 2);
				}
			}),
			g,
			artifacts,
			"no-current-execution",
		);
	});

	it("rejects an execution whose preflight did not plan a worktree", async () => {
		const artifacts = await store();
		const g = graph("worktree");
		const artifact = await storedHandoffArtifact(artifacts, g);
		const state = importedHandoffState(g, artifact);
		await expectReason(
			mutated(state, (clone) => {
				const preflight = clone.executions[g.execution.id]?.preflight;
				if (preflight) preflight.workspaceMode = "read-only";
			}),
			g,
			artifacts,
			"preflight-not-worktree",
		);
		await expectReason(
			mutated(state, (clone) => {
				delete clone.executions[g.execution.id]?.preflight;
			}),
			g,
			artifacts,
			"preflight-not-worktree",
		);
	});

	it("rejects an execution without a completed settlement", async () => {
		const artifacts = await store();
		const g = graph("worktree");
		const state = reduce([
			...g.events,
			...importedResult(g, completedEvidence(handoffEvidence(g.execution))),
		]);
		await expectReason(
			mutated(state, (clone) => {
				delete clone.executions[g.execution.id]?.settlement;
			}),
			g,
			artifacts,
			"no-settlement",
		);
	});

	it("rejects a completed worktree execution that recorded no handoff evidence", async () => {
		const artifacts = await store();
		const g = graph("worktree");
		// Phase artifact-imported: neither import nor absence yet.
		const state = reduce([
			...g.events,
			...importedResult(g, completedEvidence(handoffEvidence(g.execution))),
		]);
		await expectReason(state, g, artifacts, "no-handoff-evidence");
	});

	it("rejects a handoff artifact that is not declared for the current execution", async () => {
		const artifacts = await store();
		const g = graph("worktree");
		const artifact = await storedHandoffArtifact(artifacts, g);
		const state = importedHandoffState(g, artifact);
		const otherExecutionId = deriveTaskExecutionId(RUN_ID, g.task.id, 2);
		await expectReason(
			mutated(state, (clone) => {
				const declared = clone.artifacts[artifact.id];
				if (declared) declared.producerExecutionId = otherExecutionId;
			}),
			g,
			artifacts,
			"artifact-not-current",
		);
		await expectReason(
			mutated(state, (clone) => {
				delete clone.artifacts[artifact.id];
			}),
			g,
			artifacts,
			"artifact-not-current",
		);
		await expectReason(
			mutated(state, (clone) => {
				const declared = clone.artifacts[artifact.id];
				if (declared) declared.output = "result";
			}),
			g,
			artifacts,
			"artifact-not-current",
		);
		await expectReason(
			mutated(state, (clone) => {
				const declared = clone.artifacts[artifact.id];
				if (declared) declared.bytes = artifact.bytes + 1;
			}),
			g,
			artifacts,
			"artifact-not-current",
		);
	});

	it("rejects a handoff blob that is missing or corrupt", async () => {
		const artifacts = await store();
		const g = graph("worktree");
		const missing = unstoredHandoffArtifact(g);
		const missingError = await expectReason(
			importedHandoffState(g, missing),
			g,
			artifacts,
			"artifact-unreadable",
		);
		expect(missingError.cause).toBeInstanceOf(Error);

		const stored = await storedHandoffArtifact(artifacts, g);
		const state = importedHandoffState(g, stored);
		const blob = path.join(artifacts.root, `${stored.sha256}.patch`);
		// Same length, different bytes: the digest no longer matches the ref.
		await writeFile(blob, Buffer.alloc(stored.bytes, 0x78));
		const corruptError = await expectReason(
			state,
			g,
			artifacts,
			"artifact-unreadable",
		);
		expect((corruptError.cause as Error).message).toBe(
			"workflow artifact digest mismatch",
		);
		// Wrong size.
		await writeFile(blob, Buffer.alloc(stored.bytes + 3, 0x78));
		await expectReason(state, g, artifacts, "artifact-unreadable");
	});

	it("rejects a patch whose first line names another commit", async () => {
		const artifacts = await store();
		const g = graph("worktree");
		// The blob renders OTHER_COMMIT; the import and settlement name HANDOFF_COMMIT.
		const artifact = await storedHandoffArtifact(artifacts, g, OTHER_COMMIT);
		const state = importedHandoffState(g, artifact);
		await expectReason(state, g, artifacts, "commit-mismatch");
	});

	it("rejects an import whose identity triple disagrees with the settlement", async () => {
		const artifacts = await store();
		const g = graph("worktree");
		const artifact = await storedHandoffArtifact(artifacts, g);
		const state = importedHandoffState(g, artifact);
		for (const mutate of [
			(clone: WorkflowStateProjection) => {
				const imported = clone.executions[g.execution.id]?.handoffImport;
				if (imported) imported.baselineHead = OTHER_BASELINE;
			},
			(clone: WorkflowStateProjection) => {
				const imported = clone.executions[g.execution.id]?.handoffImport;
				if (imported) imported.handoffCommit = OTHER_COMMIT;
			},
			(clone: WorkflowStateProjection) => {
				const imported = clone.executions[g.execution.id]?.handoffImport;
				if (imported) imported.subagentAttemptId = "attempt_other";
			},
			(clone: WorkflowStateProjection) => {
				const settlement = clone.executions[g.execution.id]?.settlement;
				if (settlement) delete settlement.evidence.handoff;
			},
		]) {
			await expectReason(
				mutated(state, mutate),
				g,
				artifacts,
				"settlement-mismatch",
			);
		}
	});

	it("accepts a recorded absence only under the optional policy", async () => {
		const artifacts = await store();
		const optional = graph("worktree", "optional");
		const state = absentHandoffState(optional);
		await expect(
			verifyWorkflowHandoffEvidence(state, taskOf(state, optional), artifacts),
		).resolves.toEqual({
			status: "absent",
			execution: state.executions[optional.execution.id],
		});

		const required = graph("worktree", "required");
		await expectReason(
			absentHandoffState(required),
			required,
			artifacts,
			"required-absent",
		);
		const defaulted = graph("worktree");
		expect(defaulted.task.spec.request.handoff).toBe("required");
		await expectReason(
			absentHandoffState(defaulted),
			defaulted,
			artifacts,
			"required-absent",
		);
	});
});
