import { SUBAGENT_RUNTIME_CONTRACT } from "@vegardx/pi-subagent";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	AgentTaskSpecSchema,
	isCompatibleSubagentContract,
	isWorkflowRuntimeContract,
	MAX_NESTED_WORKFLOW_DEPTH,
	MAX_NESTED_WORKFLOW_TASKS,
	MaterializedAgentTaskSchema,
	MaterializedWorkflowTaskSchema,
	NestedWorkflowTaskSpecSchema,
	NestedWorkflowTerminalEvidenceSchema,
	SupportTaskTerminalEvidenceSchema,
	TaskExecutionRecordSchema,
	TaskExecutionTerminalEvidenceSchema,
	WORKFLOW_CONTRACT_REVISION,
	WORKFLOW_RUNTIME_CONTRACT,
	WorkflowBudgetSchema,
	WorkflowExecutionFailureEvidenceSchema,
} from "../src/contracts.js";
import { WorkflowBudgetSchema as DefinitionBudgetSchema } from "../src/definition.js";
import {
	WorkflowJournalEventSchema,
	WorkflowRunSnapshotSchema,
} from "../src/persistence/journal.js";

const sha = "a".repeat(64);

function artifactRef() {
	return {
		id: `artifact_${sha}`,
		runId: "workflow_abc123",
		producerTaskId: "task_abc123",
		output: "result" as const,
		sha256: sha,
		bytes: 2,
		mediaType: "application/json",
		schemaSha256: sha,
	};
}

function agentTaskSpec() {
	return {
		key: "answer",
		kind: "agent" as const,
		disposition: "required" as const,
		after: [],
		inputs: {},
		replay: "read-only" as const,
		request: {
			agent: "researcher",
			task: {
				goal: "Answer",
				context: [],
				instructions: ["Return a structured answer."],
			},
			contextMode: "fresh" as const,
			tools: ["read", "grep", "find", "ls"],
			preloadSkills: [],
			contextScopes: ["project" as const],
			workspace: { mode: "read-only" as const, cwd: "/repo" },
			outputSchema: { type: "object" },
			limits: {
				cumulativeRuntimeMs: 300_000,
				attemptTimeoutMs: 300_000,
				totalTokens: 1_000_000,
				cost: 100,
				outputBytes: 1_048_576,
				workspaceWriteBytes: 0,
				retries: 1,
				resumes: 1,
			},
		},
		identitySha256: sha,
	};
}

function nestedTaskSpec() {
	return {
		key: "child",
		kind: "workflow" as const,
		disposition: "required" as const,
		after: [],
		inputs: {},
		replay: "read-only" as const,
		request: {
			definitionName: "child",
			definitionIdentitySha256: sha,
			definitionSourceSha256: sha,
			definitionVersion: 1,
			input: { topic: "nested" },
			inputSha256: sha,
			inputSchema: { type: "object" },
			outputSchema: { type: "object" },
			budget: { cost: 10, childRuntimeMs: 60_000 },
			timeoutMs: 60_000,
			concurrency: 2,
		},
		identitySha256: sha,
	};
}

describe("workflow contracts", () => {
	it("binds the exact current subagent runtime contract", () => {
		expect(WORKFLOW_RUNTIME_CONTRACT.requiredSubagent).toEqual(
			SUBAGENT_RUNTIME_CONTRACT,
		);
		expect(isWorkflowRuntimeContract(WORKFLOW_RUNTIME_CONTRACT)).toBe(true);
		expect(WORKFLOW_RUNTIME_CONTRACT.features).toMatchObject({
			staticWorkflows: true,
			durableRuns: true,
			parallel: true,
			settledResults: true,
			fanOut: true,
			fanIn: true,
			pipelines: true,
			replay: true,
			resume: false,
		});
	});

	it("publishes revision 12 and rejects revision 11 durable records", () => {
		expect(WORKFLOW_CONTRACT_REVISION).toBe(12);
		expect(WORKFLOW_RUNTIME_CONTRACT.contractRevision).toBe(12);
		expect(WORKFLOW_RUNTIME_CONTRACT.features.supportTaskExecution).toBe(true);
		expect(WORKFLOW_RUNTIME_CONTRACT.features.nestedWorkflows).toBe(true);
		const event = {
			schema: "pi-workflow-event",
			contractRevision: 12,
			sequence: 1,
			eventId: "event-1",
			timestamp: "2026-09-01T00:00:00.000Z",
			runId: "workflow_abc123",
			ownerId: "test",
			leaseId: "lease-test",
			fencingGeneration: 1,
			type: "run-created",
			data: { definitionIdentitySha256: sha, inputSha256: sha },
		};
		expect(Value.Check(WorkflowJournalEventSchema, event)).toBe(true);
		expect(
			Value.Check(WorkflowJournalEventSchema, {
				...event,
				contractRevision: 11,
			}),
		).toBe(false);
		const snapshot = {
			schema: "pi-workflow-snapshot",
			contractRevision: 12,
			runId: "workflow_abc123",
			ownerId: "test",
			leaseId: "lease-test",
			fencingGeneration: 1,
			lastSequence: 1,
			state: {
				runId: "workflow_abc123",
				definitionIdentitySha256: sha,
				inputSha256: sha,
				status: "created",
				currentEpoch: 1,
				effects: [],
				lastSequence: 1,
				tasks: {},
				executions: {},
				artifacts: {},
				barriers: [],
			},
		};
		expect(Value.Check(WorkflowRunSnapshotSchema, snapshot)).toBe(true);
		expect(
			Value.Check(WorkflowRunSnapshotSchema, {
				...snapshot,
				contractRevision: 11,
			}),
		).toBe(false);
	});

	it("discriminates execution records and terminal evidence by kind", () => {
		const base = {
			id: `execution_${sha}`,
			runId: "workflow_abc123",
			taskId: "task_abc123",
			generation: 1,
			taskIdentitySha256: sha,
		};
		const operationId = `workflow-op_${sha}`;
		expect(
			Value.Check(TaskExecutionRecordSchema, {
				kind: "agent",
				...base,
				operationId,
			}),
		).toBe(true);
		expect(
			Value.Check(TaskExecutionRecordSchema, {
				kind: "support",
				...base,
				implementationIdentitySha256: sha,
			}),
		).toBe(true);
		expect(
			Value.Check(TaskExecutionRecordSchema, { ...base, operationId }),
		).toBe(false);
		expect(
			Value.Check(TaskExecutionRecordSchema, {
				kind: "support",
				...base,
				operationId,
			}),
		).toBe(false);
		expect(
			Value.Check(TaskExecutionRecordSchema, {
				kind: "agent",
				...base,
				implementationIdentitySha256: sha,
			}),
		).toBe(false);
		const evidence = {
			kind: "support",
			implementationIdentitySha256: sha,
			parametersSha256: sha,
			inputsSha256: sha,
			outputSha256: sha,
			artifactId: `artifact_${sha}`,
			durationMs: 5,
		};
		expect(Value.Check(SupportTaskTerminalEvidenceSchema, evidence)).toBe(true);
		expect(
			Value.Check(SupportTaskTerminalEvidenceSchema, {
				...evidence,
				durationMs: -1,
			}),
		).toBe(false);
		expect(
			Value.Check(SupportTaskTerminalEvidenceSchema, {
				...evidence,
				extra: true,
			}),
		).toBe(false);
		for (const stage of [
			"support-resolution",
			"support-input",
			"support-execution",
			"support-output",
		]) {
			expect(
				Value.Check(WorkflowExecutionFailureEvidenceSchema, {
					kind: "workflow",
					stage,
					failureSha256: sha,
					message: "failed",
				}),
			).toBe(true);
		}
	});

	it("publishes the bounded nested workflow feature", () => {
		expect(WORKFLOW_RUNTIME_CONTRACT.features.nestedWorkflows).toBe(true);
		expect(MAX_NESTED_WORKFLOW_DEPTH).toBe(4);
		expect(MAX_NESTED_WORKFLOW_TASKS).toBe(64);
		expect(DefinitionBudgetSchema).toBe(WorkflowBudgetSchema);
		expect(
			isWorkflowRuntimeContract({
				...WORKFLOW_RUNTIME_CONTRACT,
				features: {
					...WORKFLOW_RUNTIME_CONTRACT.features,
					nestedWorkflows: undefined,
				},
			}),
		).toBe(false);
	});

	it("validates nested workflow task specs, records, and evidence", () => {
		const spec = nestedTaskSpec();
		expect(Value.Check(NestedWorkflowTaskSpecSchema, spec)).toBe(true);
		expect(
			Value.Check(MaterializedWorkflowTaskSchema, {
				id: "task_abc123",
				runId: "workflow_abc123",
				namespace: [],
				spec,
				definitionIdentitySha256: sha,
				materializationSequence: 1,
				materializationEpoch: 1,
				epochPosition: 1,
			}),
		).toBe(true);
		expect(
			Value.Check(NestedWorkflowTaskSpecSchema, {
				...spec,
				inputs: { answer: artifactRef() },
			}),
		).toBe(false);
		expect(
			Value.Check(NestedWorkflowTaskSpecSchema, {
				...spec,
				request: { ...spec.request, concurrency: 17 },
			}),
		).toBe(false);
		expect(
			Value.Check(NestedWorkflowTaskSpecSchema, {
				...spec,
				request: { ...spec.request, definitionName: "Child" },
			}),
		).toBe(false);
		const base = {
			id: `execution_${sha}`,
			runId: "workflow_abc123",
			taskId: "task_abc123",
			generation: 1,
			taskIdentitySha256: sha,
		};
		expect(
			Value.Check(TaskExecutionRecordSchema, {
				kind: "workflow",
				...base,
				childRunId: "workflow_child",
			}),
		).toBe(true);
		expect(
			Value.Check(TaskExecutionRecordSchema, {
				kind: "workflow",
				...base,
				operationId: `workflow-op_${sha}`,
			}),
		).toBe(false);
		const evidence = {
			kind: "nested-workflow",
			childRunId: "workflow_child",
			status: "completed",
			usage: { cost: 0.5, totalTokens: 10, childRuntimeMs: 5 },
			usageComplete: true,
			outputSha256: sha,
			artifactId: `artifact_${sha}`,
		};
		expect(Value.Check(NestedWorkflowTerminalEvidenceSchema, evidence)).toBe(
			true,
		);
		expect(Value.Check(TaskExecutionTerminalEvidenceSchema, evidence)).toBe(
			true,
		);
		expect(
			Value.Check(NestedWorkflowTerminalEvidenceSchema, {
				...evidence,
				usage: { cost: -1, totalTokens: 10, childRuntimeMs: 5 },
			}),
		).toBe(false);
		expect(
			Value.Check(NestedWorkflowTerminalEvidenceSchema, {
				...evidence,
				extra: true,
			}),
		).toBe(false);
		for (const stage of [
			"nested-resolution",
			"nested-launch",
			"nested-import",
		]) {
			expect(
				Value.Check(WorkflowExecutionFailureEvidenceSchema, {
					kind: "workflow",
					stage,
					failureSha256: sha,
					message: "failed",
				}),
			).toBe(true);
		}
	});

	it("keeps the compatibility baseline immutable", () => {
		expect(() => {
			WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.features.structuredOutput = false;
		}).toThrow(TypeError);
		expect(
			WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.features.structuredOutput,
		).toBe(true);
	});

	it("rejects a workflow contract with reduced subagent features", () => {
		const incompatible = structuredClone(WORKFLOW_RUNTIME_CONTRACT);
		incompatible.requiredSubagent.features.structuredOutput = false;
		expect(isWorkflowRuntimeContract(incompatible)).toBe(true);
		expect(isCompatibleSubagentContract(incompatible.requiredSubagent)).toBe(
			false,
		);
	});

	it("validates one materialized read-only agent task", () => {
		const task = {
			id: "task_abc123",
			runId: "workflow_abc123",
			namespace: [],
			spec: agentTaskSpec(),
			definitionIdentitySha256: sha,
			materializationSequence: 1,
			materializationEpoch: 1,
			epochPosition: 1,
		};
		expect(Value.Check(MaterializedAgentTaskSchema, task)).toBe(true);
	});

	it("rejects undeclared task fields", () => {
		expect(
			Value.Check(AgentTaskSpecSchema, {
				...agentTaskSpec(),
				execution: "background",
			}),
		).toBe(false);
	});

	it("rejects invalid stable keys", () => {
		expect(
			Value.Check(AgentTaskSpecSchema, {
				...agentTaskSpec(),
				key: "Answer 1",
			}),
		).toBe(false);
	});

	it("rejects duplicate order dependencies", () => {
		const spec = agentTaskSpec();
		const dependency = {
			runId: "workflow_abc123",
			taskId: "task_abc123",
		};
		expect(
			Value.Check(AgentTaskSpecSchema, {
				...spec,
				after: [dependency, dependency],
			}),
		).toBe(false);
	});

	it("rejects invalid named input keys", () => {
		expect(
			Value.Check(AgentTaskSpecSchema, {
				...agentTaskSpec(),
				inputs: { "Answer 1": artifactRef() },
			}),
		).toBe(false);
	});

	it("rejects fork context until durable parent authorization ships", () => {
		const spec = agentTaskSpec();
		expect(
			Value.Check(AgentTaskSpecSchema, {
				...spec,
				request: { ...spec.request, contextMode: "fork" },
			}),
		).toBe(false);
	});

	it("rejects worktree requests while the capability is unavailable", () => {
		const spec = agentTaskSpec();
		expect(
			Value.Check(AgentTaskSpecSchema, {
				...spec,
				request: {
					...spec.request,
					workspace: { mode: "worktree", cwd: "/repo" },
				},
			}),
		).toBe(false);
	});

	it("rejects non-JSON output schemas", () => {
		const spec = agentTaskSpec();
		expect(
			Value.Check(AgentTaskSpecSchema, {
				...spec,
				request: { ...spec.request, outputSchema: () => undefined },
			}),
		).toBe(false);
	});
});
