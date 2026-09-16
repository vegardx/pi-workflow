import { isDeepStrictEqual } from "node:util";
import {
	canonicalSha256,
	HANDOFF_EXPORT_MEDIA_TYPE,
	SUBAGENT_RUNTIME_CONTRACT,
} from "@vegardx/pi-subagent";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	AgentResumePolicySchema,
	AgentRetryPolicySchema,
	AgentTaskRequestSchema,
	AgentTaskSpecSchema,
	HandoffPolicySchema,
	isCompatibleSubagentContract,
	isWorkflowRuntimeContract,
	JsonSchemaDocumentSchema,
	MAX_NESTED_WORKFLOW_DEPTH,
	MAX_NESTED_WORKFLOW_TASKS,
	MAX_TASK_ATTEMPTS,
	MAX_WORKFLOW_HANDOFF_BYTES,
	MaterializedAgentTaskSchema,
	MaterializedWorkflowTaskSchema,
	NestedWorkflowInputArtifactSchema,
	NestedWorkflowInputArtifactsSchema,
	NestedWorkflowTaskSpecSchema,
	NestedWorkflowTerminalEvidenceSchema,
	SubagentHandoffEvidenceSchema,
	SubagentTerminalEvidenceSchema,
	SupportTaskTerminalEvidenceSchema,
	TaskExecutionRecordSchema,
	TaskExecutionTerminalEvidenceSchema,
	WORKFLOW_CONTRACT_REVISION,
	WORKFLOW_HANDOFF_FORMAT,
	WORKFLOW_HANDOFF_FORMAT_SHA256,
	WORKFLOW_RUNTIME_CONTRACT,
	WorkflowArtifactOutputSchema,
	WorkflowArtifactRefSchema,
	WorkflowBudgetSchema,
	WorkflowExecutionFailureEvidenceSchema,
	WorkflowHandoffDescriptorSchema,
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
		producerExecutionId: "execution_abc123",
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
		role: "task" as const,
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
		role: "task" as const,
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

	it("publishes revision 19 and rejects revision 18", () => {
		expect(WORKFLOW_CONTRACT_REVISION).toBe(19);
		expect(WORKFLOW_RUNTIME_CONTRACT.contractRevision).toBe(19);
		expect(WORKFLOW_RUNTIME_CONTRACT.features.supportTaskExecution).toBe(true);
		expect(WORKFLOW_RUNTIME_CONTRACT.features.nestedWorkflows).toBe(true);
		expect(WORKFLOW_RUNTIME_CONTRACT.features.nestedArtifactInputs).toBe(true);
		expect(WORKFLOW_RUNTIME_CONTRACT.features.executionGenerations).toBe(true);
		expect(WORKFLOW_RUNTIME_CONTRACT.features.transactionalInvalidation).toBe(
			true,
		);
		expect(WORKFLOW_RUNTIME_CONTRACT.features.finalizers).toBe(true);
		expect(WORKFLOW_RUNTIME_CONTRACT.features.operatorAttempts).toBe(true);
		expect(WORKFLOW_RUNTIME_CONTRACT.features.checkpoints).toBe(true);
		expect(WORKFLOW_RUNTIME_CONTRACT.features.worktrees).toBe(true);
		expect(WORKFLOW_RUNTIME_CONTRACT.features.dynamicWorkflows).toBe(true);
		const event = {
			schema: "pi-workflow-event",
			contractRevision: 19,
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
				contractRevision: 18,
			}),
		).toBe(false);
		const snapshot = {
			schema: "pi-workflow-snapshot",
			contractRevision: 19,
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
				contractRevision: 18,
			}),
		).toBe(false);
		// The persisted-state claim in docs/compatibility.md and
		// docs/acceptance.md: every earlier revision is refused, not just 18,
		// and no migration turns one into a revision-19 record.
		for (let revision = 1; revision <= 18; revision += 1) {
			expect(
				Value.Check(WorkflowJournalEventSchema, {
					...event,
					contractRevision: revision,
				}),
			).toBe(false);
			expect(
				Value.Check(WorkflowRunSnapshotSchema, {
					...snapshot,
					contractRevision: revision,
				}),
			).toBe(false);
		}
	});

	// Revision 19: the optional guest memory grant on the agent task request.
	it("admits an optional memoryBytes bounded by pi-subagent's schema", () => {
		const base = {
			agent: "researcher",
			task: { goal: "Answer", context: [], instructions: ["Report."] },
			contextMode: "fresh",
			tools: [],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: "/repo" },
			outputSchema: { type: "object" },
			limits: {
				cumulativeRuntimeMs: 300_000,
				attemptTimeoutMs: 300_000,
				cost: 1,
				outputBytes: 1024,
				workspaceWriteBytes: 0,
				retries: 0,
				resumes: 0,
			},
		};
		// Optional: the field may be absent entirely.
		expect(Value.Check(AgentTaskRequestSchema, base)).toBe(true);
		for (const memoryBytes of [
			64 * 1024 * 1024,
			512 * 1024 * 1024,
			4 * 1024 * 1024 * 1024,
		]) {
			expect(
				Value.Check(AgentTaskRequestSchema, { ...base, memoryBytes }),
			).toBe(true);
		}
		for (const memoryBytes of [
			0,
			-(64 * 1024 * 1024),
			32 * 1024 * 1024,
			100 * 1024 * 1024,
			4 * 1024 * 1024 * 1024 + 64 * 1024 * 1024,
			"512MiB",
		]) {
			expect(
				Value.Check(AgentTaskRequestSchema, { ...base, memoryBytes }),
			).toBe(false);
		}
	});

	it("binds the handoff format digest to pi-subagent revision 7", () => {
		expect(WORKFLOW_HANDOFF_FORMAT).toEqual({
			format: "git-format-patch",
			mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
			revision: 7,
		});
		expect(WORKFLOW_HANDOFF_FORMAT_SHA256).toBe(
			canonicalSha256(WORKFLOW_HANDOFF_FORMAT),
		);
		// The revision is an input, so a revision-18 handoff artifact's
		// schemaSha256 does not verify here.
		expect(WORKFLOW_HANDOFF_FORMAT_SHA256).not.toBe(
			canonicalSha256({ ...WORKFLOW_HANDOFF_FORMAT, revision: 6 }),
		);
	});

	it("publishes the attempt features, policies, and evidence ordinal", () => {
		expect(WORKFLOW_RUNTIME_CONTRACT.features.retryAttempts).toBe(true);
		expect(WORKFLOW_RUNTIME_CONTRACT.features.resumeAttempts).toBe(true);
		expect(MAX_TASK_ATTEMPTS).toBe(21);
		for (const feature of [
			"retryAttempts",
			"resumeAttempts",
			"executionGenerations",
			"transactionalInvalidation",
			"finalizers",
			"operatorAttempts",
			"checkpoints",
		] as const) {
			expect(
				isWorkflowRuntimeContract({
					...WORKFLOW_RUNTIME_CONTRACT,
					features: {
						...WORKFLOW_RUNTIME_CONTRACT.features,
						[feature]: undefined,
					},
				}),
			).toBe(false);
		}
		expect(
			Value.Check(AgentRetryPolicySchema, { attempts: 1, on: ["backoff"] }),
		).toBe(true);
		expect(
			Value.Check(AgentRetryPolicySchema, {
				attempts: 10,
				on: ["backoff", "manual"],
			}),
		).toBe(true);
		for (const invalid of [
			{ attempts: 0, on: ["backoff"] },
			{ attempts: 11, on: ["backoff"] },
			{ attempts: 1.5, on: ["backoff"] },
			{ attempts: 1, on: [] },
			{ attempts: 1, on: ["backoff", "backoff"] },
			{ attempts: 1, on: ["resume"] },
			{ attempts: 1, on: ["never"] },
			{ attempts: 1 },
			{ attempts: 1, on: ["backoff"], extra: true },
		]) {
			expect(Value.Check(AgentRetryPolicySchema, invalid)).toBe(false);
		}
		expect(Value.Check(AgentResumePolicySchema, { attempts: 1 })).toBe(true);
		expect(Value.Check(AgentResumePolicySchema, { attempts: 10 })).toBe(true);
		for (const invalid of [
			{ attempts: 0 },
			{ attempts: 11 },
			{ attempts: 1, on: ["backoff"] },
			{},
		]) {
			expect(Value.Check(AgentResumePolicySchema, invalid)).toBe(false);
		}
		const spec = agentTaskSpec();
		const withPolicies = {
			...spec.request,
			retry: { attempts: 1, on: ["backoff", "manual"] },
			resume: { attempts: 1 },
		};
		expect(Value.Check(AgentTaskRequestSchema, spec.request)).toBe(true);
		expect(Value.Check(AgentTaskRequestSchema, withPolicies)).toBe(true);
		expect(
			Value.Check(AgentTaskSpecSchema, { ...spec, request: withPolicies }),
		).toBe(true);
		expect(
			Value.Check(AgentTaskRequestSchema, {
				...spec.request,
				retry: { attempts: 1 },
			}),
		).toBe(false);
		expect(
			Value.Check(AgentTaskRequestSchema, {
				...spec.request,
				resume: { attempts: 0 },
			}),
		).toBe(false);
		const evidence = {
			kind: "subagent",
			attemptOrdinal: 1,
			resultSha256: sha,
			status: "completed",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: 0.01,
			},
			usageComplete: true,
			runtimeMs: 10,
			sandboxCleanup: "proved",
			workspaceCleanup: "not-needed",
			truncated: false,
			structuredOutputSha256: sha,
		};
		expect(Value.Check(SubagentTerminalEvidenceSchema, evidence)).toBe(true);
		expect(Value.Check(TaskExecutionTerminalEvidenceSchema, evidence)).toBe(
			true,
		);
		expect(
			Value.Check(SubagentTerminalEvidenceSchema, {
				...evidence,
				attemptOrdinal: MAX_TASK_ATTEMPTS,
			}),
		).toBe(true);
		const { attemptOrdinal: _attemptOrdinal, ...withoutOrdinal } = evidence;
		expect(Value.Check(SubagentTerminalEvidenceSchema, withoutOrdinal)).toBe(
			false,
		);
		for (const attemptOrdinal of [0, MAX_TASK_ATTEMPTS + 1, 1.5]) {
			expect(
				Value.Check(SubagentTerminalEvidenceSchema, {
					...evidence,
					attemptOrdinal,
				}),
			).toBe(false);
		}
	});

	it("publishes the nested artifact input feature and its schemas", () => {
		expect(WORKFLOW_RUNTIME_CONTRACT.features.nestedArtifactInputs).toBe(true);
		expect(
			isWorkflowRuntimeContract({
				...WORKFLOW_RUNTIME_CONTRACT,
				features: {
					...WORKFLOW_RUNTIME_CONTRACT.features,
					nestedArtifactInputs: undefined,
				},
			}),
		).toBe(false);
		const artifact = {
			runId: "workflow_parent",
			artifactId: `artifact_${sha}`,
			sha256: sha,
		};
		expect(Value.Check(NestedWorkflowInputArtifactSchema, artifact)).toBe(true);
		expect(
			Value.Check(NestedWorkflowInputArtifactSchema, {
				...artifact,
				producerTaskId: "task_abc123",
			}),
		).toBe(false);
		expect(
			Value.Check(NestedWorkflowInputArtifactSchema, {
				...artifact,
				artifactId: "artifact_short",
			}),
		).toBe(false);
		expect(Value.Check(NestedWorkflowInputArtifactsSchema, {})).toBe(true);
		expect(
			Value.Check(NestedWorkflowInputArtifactsSchema, { answer: artifact }),
		).toBe(true);
		expect(
			Value.Check(NestedWorkflowInputArtifactsSchema, {
				"Answer 1": artifact,
			}),
		).toBe(false);
		expect(
			Value.Check(WorkflowExecutionFailureEvidenceSchema, {
				kind: "workflow",
				stage: "nested-input",
				failureSha256: sha,
				message: "failed",
			}),
		).toBe(true);
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
				inputs: {
					answer: {
						runId: "workflow_abc123",
						producerTaskId: "task_abc123",
						output: "result",
					},
				},
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
				inputs: {
					"Answer 1": {
						runId: "workflow_abc123",
						producerTaskId: "task_abc123",
						output: "result",
					},
				},
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
			"nested-input",
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

	it("admits worktree requests with a handoff policy", () => {
		const spec = agentTaskSpec();
		const worktree = {
			...spec,
			request: {
				...spec.request,
				workspace: { mode: "worktree", cwd: "/repo" },
			},
		};
		expect(Value.Check(AgentTaskSpecSchema, worktree)).toBe(true);
		for (const handoff of ["required", "optional"]) {
			expect(
				Value.Check(AgentTaskSpecSchema, {
					...worktree,
					request: { ...worktree.request, handoff },
				}),
			).toBe(true);
		}
		expect(
			Value.Check(AgentTaskSpecSchema, {
				...worktree,
				request: { ...worktree.request, handoff: "never" },
			}),
		).toBe(false);
		expect(
			Value.Check(AgentTaskSpecSchema, {
				...spec,
				request: {
					...spec.request,
					workspace: { mode: "shared", cwd: "/repo" },
				},
			}),
		).toBe(false);
		expect(WORKFLOW_RUNTIME_CONTRACT.features.worktrees).toBe(true);
	});

	it("requires pi-subagent revision 7 with handoff export, the memory ceiling, and budget refusal", () => {
		expect(WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.contractRevision).toBe(7);
		expect(
			WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.features.handoffExport,
		).toBe(true);
		expect(
			WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.features.vmMemoryCeiling,
		).toBe(true);
		expect(
			WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.features
				.workspaceBudgetRefusal,
		).toBe(true);
		expect(isCompatibleSubagentContract(SUBAGENT_RUNTIME_CONTRACT)).toBe(true);
		expect(
			isCompatibleSubagentContract({
				...SUBAGENT_RUNTIME_CONTRACT,
				contractRevision: 6,
			}),
		).toBe(false);
		for (const feature of [
			"handoffExport",
			"vmMemoryCeiling",
			"workspaceBudgetRefusal",
		] as const) {
			expect(
				isCompatibleSubagentContract({
					...SUBAGENT_RUNTIME_CONTRACT,
					features: {
						...SUBAGENT_RUNTIME_CONTRACT.features,
						[feature]: false,
					},
				}),
			).toBe(false);
		}
	});

	it("publishes the handoff artifact output, evidence, and descriptor", () => {
		const gitObjectId = "b".repeat(40);
		const handoff = {
			attemptId: "attempt_abc123",
			baselineHead: gitObjectId,
			handoffCommit: "c".repeat(40),
		};
		expect(Value.Check(SubagentHandoffEvidenceSchema, handoff)).toBe(true);
		expect(
			Value.Check(SubagentHandoffEvidenceSchema, {
				...handoff,
				handoffCommit: "refs/heads/main",
			}),
		).toBe(false);
		expect(Value.Check(WorkflowArtifactOutputSchema, "handoff")).toBe(true);
		expect(
			Value.Check(WorkflowArtifactRefSchema, {
				...artifactRef(),
				output: "handoff",
				mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
				schemaSha256: WORKFLOW_HANDOFF_FORMAT_SHA256,
			}),
		).toBe(true);
		expect(Value.Check(HandoffPolicySchema, "required")).toBe(true);
		expect(Value.Check(HandoffPolicySchema, "never")).toBe(false);
		expect(MAX_WORKFLOW_HANDOFF_BYTES).toBe(16 * 1024 * 1024);
		expect(WORKFLOW_HANDOFF_FORMAT_SHA256).toMatch(/^[a-f0-9]{64}$/);
		expect(
			Value.Check(WorkflowExecutionFailureEvidenceSchema, {
				kind: "workflow",
				stage: "handoff-import",
				failureSha256: sha,
				message: "Completed worktree task captured no handoff.",
			}),
		).toBe(true);
		const descriptor = {
			artifactId: `artifact_${sha}`,
			runId: "workflow_abc123",
			producerTaskId: "task_abc123",
			producerExecutionId: "execution_abc123",
			subagentRunId: "run_abc123",
			subagentAttemptId: "attempt_abc123",
			baselineHead: gitObjectId,
			handoffCommit: "c".repeat(40),
			format: "git-format-patch",
			mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
			sha256: sha,
			bytes: 1,
		};
		expect(Value.Check(WorkflowHandoffDescriptorSchema, descriptor)).toBe(true);
		expect(
			Value.Check(WorkflowHandoffDescriptorSchema, {
				...descriptor,
				bytes: MAX_WORKFLOW_HANDOFF_BYTES + 1,
			}),
		).toBe(false);
		expect(
			Value.Check(WorkflowHandoffDescriptorSchema, {
				...descriptor,
				worktreePath: "/private/worktree",
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

describe("JSON schema document contract", () => {
	it("equals the schema composed through the TypeBox constructors", () => {
		// `contracts-core.ts` binds each nesting level to the shared level
		// below instead of composing 16 levels through `Type.Union` (which
		// walks its arguments as a tree, 2^16 traversals). The result must be
		// the composed schema exactly: same keys, same order, same depth.
		const primitive = Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
		]);
		let value: TSchema = primitive;
		for (let depth = 0; depth < 16; depth++) {
			value = Type.Union([
				primitive,
				Type.Array(value),
				Type.Record(Type.String(), value),
			]);
		}
		const composed = Type.Record(Type.String(), value, {
			additionalProperties: false,
		});
		expect(isDeepStrictEqual(JsonSchemaDocumentSchema, composed)).toBe(true);
		expect(Object.keys(JsonSchemaDocumentSchema)).toEqual(
			Object.keys(composed),
		);
	});

	it("accepts JSON nested to the contract depth and refuses deeper values", () => {
		const nest = (depth: number): unknown => {
			let value: unknown = 1;
			for (let level = 0; level < depth; level++) value = [value];
			return value;
		};
		expect(Value.Check(JsonSchemaDocumentSchema, { a: nest(16) })).toBe(true);
		expect(Value.Check(JsonSchemaDocumentSchema, { a: nest(17) })).toBe(false);
		expect(Value.Check(JsonSchemaDocumentSchema, { a: () => 1 })).toBe(false);
		expect(Value.Check(JsonSchemaDocumentSchema, [])).toBe(false);
	});
});
