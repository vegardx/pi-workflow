import { SUBAGENT_RUNTIME_CONTRACT } from "@vegardx/pi-subagent";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	AgentTaskSpecSchema,
	isCompatibleSubagentContract,
	isWorkflowRuntimeContract,
	MaterializedAgentTaskSchema,
	WORKFLOW_RUNTIME_CONTRACT,
} from "../src/contracts.js";

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
				runtimeMs: 300_000,
				attemptRuntimeMs: 300_000,
				tokens: 1_000_000,
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

describe("workflow contracts", () => {
	it("binds the exact current subagent runtime contract", () => {
		expect(WORKFLOW_RUNTIME_CONTRACT.requiredSubagent).toEqual(
			SUBAGENT_RUNTIME_CONTRACT,
		);
		expect(isWorkflowRuntimeContract(WORKFLOW_RUNTIME_CONTRACT)).toBe(true);
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
