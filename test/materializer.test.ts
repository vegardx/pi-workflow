import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { NestedWorkflowTaskRequest } from "../src/contracts.js";
import { createTaskHandle } from "../src/definition.js";
import type { WorkflowEventInput } from "../src/events.js";
import { deriveJsonValueSha256 } from "../src/execution.js";
import {
	deriveAgentTaskIdentity,
	deriveNestedWorkflowTaskIdentity,
	deriveWorkflowTaskId,
	WorkflowMaterializationError,
	WorkflowTaskMaterializer,
} from "../src/materializer.js";
import type { WorkflowJournalEvent } from "../src/persistence/journal.js";
import { reduceWorkflowEvents } from "../src/reducer.js";
import { defineSupportTask } from "../src/support.js";

const definitionIdentitySha256 = "a".repeat(64);
const inputSha256 = "b".repeat(64);
const childIdentitySha256 = "c".repeat(64);
const childSourceSha256 = "d".repeat(64);
const supportHelper = defineSupportTask({
	name: "@vegardx/workflow-tools/summarize",
	moduleSpecifier: "@vegardx/workflow-tools",
	revision: 1,
	implementationSha256: "f".repeat(64),
	parametersSchema: Type.Object({ strict: Type.Boolean() }),
	outputSchema: Type.Object({ value: Type.String() }),
});

function nestedRequest(
	input: unknown = { value: "yes" },
	overrides: Partial<NestedWorkflowTaskRequest> = {},
): NestedWorkflowTaskRequest {
	return {
		definitionName: "child",
		definitionIdentitySha256: childIdentitySha256,
		definitionSourceSha256: childSourceSha256,
		definitionVersion: 1,
		input,
		inputSha256: deriveJsonValueSha256(input),
		inputSchema: {
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			properties: { answer: { type: "string" } },
			required: ["answer"],
			additionalProperties: false,
		},
		budget: { cost: 10, totalTokens: 100_000, childRuntimeMs: 600_000 },
		timeoutMs: 600_000,
		concurrency: 2,
		...overrides,
	};
}

function request(goal = "Answer") {
	return {
		agent: "researcher",
		task: {
			goal,
			context: [],
			instructions: ["Return structured output."],
		},
		contextMode: "fresh" as const,
		tools: ["read", "grep", "find", "ls"],
		preloadSkills: [],
		contextScopes: ["project" as const],
		workspace: { mode: "read-only" as const, cwd: "/repo" },
		outputSchema: Type.Object({ answer: Type.String() }),
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
	};
}

function materializer(previousState?: ReturnType<typeof reduceWorkflowEvents>) {
	return new WorkflowTaskMaterializer({
		runId: "workflow_materializer",
		definitionIdentitySha256,
		inputSha256,
		...(previousState === undefined ? {} : { previousState }),
	});
}

function records(
	events: readonly WorkflowEventInput[],
): WorkflowJournalEvent[] {
	const all: WorkflowEventInput[] = [
		{
			type: "run-created",
			data: { definitionIdentitySha256, inputSha256 },
		},
		...events,
	];
	return all.map((event, index) => ({
		schema: "pi-workflow-event",
		contractRevision: 14,
		sequence: index + 1,
		eventId: `event-${index + 1}`,
		timestamp: "2026-08-20T00:00:00.000Z",
		runId: "workflow_materializer",
		ownerId: "test",
		leaseId: "lease-test",
		fencingGeneration: 1,
		type: event.type,
		data: event.data,
	}));
}

describe("workflow task materializer", () => {
	it("materializes dependencies and closes a committed epoch", () => {
		const runtime = materializer();
		const first = runtime.agent("first", request());
		const second = runtime.agent("second", {
			...request("Review"),
			inputs: { first: first.output },
		});
		const commit = runtime.closeEpoch("final", [second]);
		expect(commit.epoch).toBe(1);
		expect(commit.events.map((event) => event.type)).toEqual([
			"task-declared",
			"task-declared",
			"barrier-reached",
		]);
		const declarations = commit.events.filter(
			(event) => event.type === "task-declared",
		);
		if (
			declarations[0]?.type !== "task-declared" ||
			declarations[1]?.type !== "task-declared"
		) {
			throw new Error("missing declarations");
		}
		expect(declarations[1].data.task.spec.after).toEqual([first.ref]);
		expect(declarations[1].data.task.spec.inputs.first).toEqual(
			first.output.ref,
		);
		expect(first.output.ref).toEqual({
			runId: "workflow_materializer",
			producerTaskId: first.ref.taskId,
			output: "result",
		});
		expect(Object.isFrozen(commit.events)).toBe(true);
	});

	it("adds result-barrier control dependencies to the next epoch", () => {
		const runtime = materializer();
		const first = runtime.agent("first", request());
		runtime.closeEpoch("result", [first]);
		const second = runtime.agent("second", request("Continue"));
		const commit = runtime.closeEpoch("final", [second]);
		const declaration = commit.events[0];
		if (declaration?.type !== "task-declared") {
			throw new Error("missing declaration");
		}
		expect(declaration.data.task.spec.after).toEqual([first.ref]);
	});

	it("retains control dependencies across an empty barrier", () => {
		const runtime = materializer();
		const first = runtime.agent("first", request());
		runtime.closeEpoch("result", [first]);
		runtime.closeEpoch("results", []);
		const second = runtime.agent("second", request("Continue"));
		const commit = runtime.closeEpoch("final", [second]);
		const declaration = commit.events[0];
		if (declaration?.type !== "task-declared") {
			throw new Error("missing declaration");
		}
		expect(declaration.data.task.spec.after).toEqual([first.ref]);
	});

	it("replays an exact ordered epoch without producing new events", () => {
		const initial = materializer();
		const answer = initial.agent("answer", request());
		const commit = initial.closeEpoch("result", [answer]);
		const previousState = reduceWorkflowEvents(records(commit.events));
		const replay = materializer(previousState);
		const replayed = replay.agent("answer", request());
		expect(replayed.ref).toEqual(answer.ref);
		expect(replay.closeEpoch("result", [replayed]).events).toEqual([]);
	});

	it("does not commit a partial persisted epoch with omitted declarations", () => {
		const initial = materializer();
		initial.agent("first", request());
		initial.agent("second", request("Second"));
		const pending = initial
			.closeEpoch("final", [])
			.events.filter((event) => event.type === "task-declared");
		const previousState = reduceWorkflowEvents(records(pending));
		const replay = materializer(previousState);
		replay.agent("first", request());
		expect(() => replay.closeEpoch("final", [])).toThrow("omits declarations");
	});

	it("enforces task bounds and rejects declarations after final", () => {
		const runtime = materializer();
		Array.from({ length: 256 }, (_, index) =>
			runtime.agent(`task-${index}` as `task-${number}`, request()),
		);
		expect(() => runtime.agent("overflow", request())).toThrow(
			"task limit exceeded",
		);
		const finalRuntime = materializer();
		const answer = finalRuntime.agent("answer", request());
		finalRuntime.closeEpoch("final", [answer]);
		expect(() => finalRuntime.agent("later", request())).toThrow(
			"final materialization barrier",
		);
	});

	it("rejects an epoch that cannot fit in the durable projection", () => {
		const runtime = materializer();
		const largeRequest = {
			...request(),
			workspace: {
				mode: "read-only" as const,
				cwd: `/${"x".repeat(4095)}`,
			},
		};
		for (let index = 0; index < 256; index += 1) {
			runtime.agent(`task-${index}` as `task-${number}`, largeRequest);
		}
		expect(() => runtime.closeEpoch("final", [])).toThrow(
			"durable state bounds",
		);
	});

	it("does not resume materialization for a cancelled run", () => {
		const terminal = reduceWorkflowEvents(
			records([
				{
					type: "run-status-changed",
					data: { from: "created", to: "running" },
				},
				{
					type: "run-status-changed",
					data: { from: "running", to: "stopping" },
				},
				{
					type: "run-status-changed",
					data: { from: "stopping", to: "cancelled" },
				},
			]),
		);
		expect(() => materializer(terminal)).toThrow(
			"cancelled workflow run may not materialize",
		);
	});

	it("fails closed on changed or duplicate declarations", () => {
		const initial = materializer();
		const answer = initial.agent("answer", request());
		const previousState = reduceWorkflowEvents(
			records(initial.closeEpoch("result", [answer]).events),
		);
		const replay = materializer(previousState);
		expect(() => replay.agent("answer", request("Changed"))).toThrow(
			WorkflowMaterializationError,
		);
		const duplicate = materializer();
		duplicate.agent("answer", request());
		expect(() => duplicate.agent("answer", request())).toThrow(
			"duplicate task key",
		);
	});
});

describe("nested workflow task materialization", () => {
	it("declares a workflow task with a stable id and identity", () => {
		const runtime = materializer();
		const handle = runtime.workflow("child", { request: nestedRequest() });
		const commit = runtime.closeEpoch("final", [handle]);
		expect(commit.events.map((event) => event.type)).toEqual([
			"task-declared",
			"barrier-reached",
		]);
		const declaration = commit.events[0];
		if (declaration?.type !== "task-declared") {
			throw new Error("missing declaration");
		}
		const task = declaration.data.task;
		if (task.spec.kind !== "workflow") throw new Error("wrong task kind");
		const { identitySha256, ...specWithoutIdentity } = task.spec;
		expect(task.id).toBe(
			deriveWorkflowTaskId("workflow_materializer", [], "child"),
		);
		expect(handle.ref).toEqual({
			runId: "workflow_materializer",
			taskId: task.id,
		});
		expect(handle.output.ref).toEqual({
			runId: "workflow_materializer",
			producerTaskId: task.id,
			output: "result",
		});
		expect(specWithoutIdentity).toEqual({
			key: "child",
			kind: "workflow",
			disposition: "required",
			after: [],
			inputs: {},
			replay: "read-only",
			request: nestedRequest(),
		});
		expect(identitySha256).toBe(
			deriveNestedWorkflowTaskIdentity({
				definitionIdentitySha256,
				inputSha256,
				namespace: [],
				spec: specWithoutIdentity,
			}),
		);
		expect(Object.isFrozen(task.spec.request)).toBe(true);
		const repeatRuntime = materializer();
		const repeatHandle = repeatRuntime.workflow("child", {
			request: nestedRequest(),
		});
		const repeat = repeatRuntime
			.closeEpoch("final", [repeatHandle])
			.events.find((event) => event.type === "task-declared");
		expect(repeat?.type === "task-declared" && repeat.data.task).toEqual(task);
		const projected = reduceWorkflowEvents(records(commit.events));
		expect(projected.tasks[task.id]?.task).toEqual(task);
	});

	it("changes identity with child input or definition identity", () => {
		const identityOf = (request: NestedWorkflowTaskRequest) => {
			const runtime = materializer();
			const handle = runtime.workflow("child", { request });
			const declaration = runtime.closeEpoch("final", [handle]).events[0];
			if (declaration?.type !== "task-declared") {
				throw new Error("missing declaration");
			}
			return declaration.data.task.spec.identitySha256;
		};
		const base = identityOf(nestedRequest());
		expect(identityOf(nestedRequest({ value: "other" }))).not.toBe(base);
		expect(
			identityOf(
				nestedRequest(undefined, {
					definitionIdentitySha256: "e".repeat(64),
				}),
			),
		).not.toBe(base);
		expect(identityOf(nestedRequest())).toBe(base);
	});

	it("bounds workflow tasks per run and after the final barrier", () => {
		const runtime = materializer();
		for (let index = 0; index < 64; index += 1) {
			runtime.workflow(`child-${index}`, { request: nestedRequest() });
		}
		runtime.agent("agent", request());
		expect(() =>
			runtime.workflow("overflow", { request: nestedRequest() }),
		).toThrow("nested workflow task bound exceeded");
		const closed = materializer();
		closed.closeEpoch("final", []);
		expect(() => closed.workflow("late", { request: nestedRequest() })).toThrow(
			"final materialization barrier",
		);
	});

	it("rejects duplicate keys across agent, support, and workflow tasks", () => {
		const afterAgent = materializer();
		afterAgent.agent("shared", request());
		expect(() =>
			afterAgent.workflow("shared", { request: nestedRequest() }),
		).toThrow("duplicate task key");
		const afterSupport = materializer();
		afterSupport.support(
			"shared",
			supportHelper({ parameters: { strict: true } }),
		);
		expect(() =>
			afterSupport.workflow("shared", { request: nestedRequest() }),
		).toThrow("duplicate task key");
		const afterWorkflow = materializer();
		afterWorkflow.workflow("shared", { request: nestedRequest() });
		expect(() => afterWorkflow.agent("shared", request())).toThrow(
			"duplicate task key",
		);
		expect(() =>
			afterWorkflow.support(
				"shared",
				supportHelper({ parameters: { strict: true } }),
			),
		).toThrow("duplicate task key");
		expect(() =>
			afterWorkflow.workflow("shared", { request: nestedRequest() }),
		).toThrow("duplicate task key");
	});

	it("orders workflow tasks after known dependencies only", () => {
		const runtime = materializer();
		const first = runtime.agent("first", request());
		expect(() =>
			runtime.workflow("unknown", {
				request: nestedRequest(),
				after: [{ runId: "workflow_materializer", taskId: "task_unknown" }],
			}),
		).toThrow("task order dependency is unknown or belongs to another run");
		expect(() =>
			runtime.workflow("foreign", {
				request: nestedRequest(),
				after: [{ runId: "workflow_other", taskId: first.ref.taskId }],
			}),
		).toThrow("task order dependency is unknown or belongs to another run");
		const child = runtime.workflow("child", {
			request: nestedRequest(),
			after: [first.ref],
			disposition: "optional",
			replay: "read-only",
		});
		const declarations = runtime
			.closeEpoch("final", [child])
			.events.filter((event) => event.type === "task-declared");
		const declared = declarations[1];
		if (declared?.type !== "task-declared") {
			throw new Error("missing declaration");
		}
		expect(declared.data.task.spec.after).toEqual([first.ref]);
		expect(declared.data.task.spec.disposition).toBe("optional");
	});

	it("declares artifact inputs from seen producers and orders after them", () => {
		const runtime = materializer();
		const producer = runtime.agent("producer", request());
		const summary = runtime.support(
			"summary",
			supportHelper({ parameters: { strict: true } }),
		);
		const child = runtime.workflow("child", {
			request: nestedRequest({}),
			inputs: { zeta: summary.output, alpha: producer.output },
		});
		const commit = runtime.closeEpoch("final", [child]);
		const declarations = commit.events.filter(
			(event) => event.type === "task-declared",
		);
		expect(declarations).toHaveLength(3);
		const declared = declarations[2];
		if (declared?.type !== "task-declared") {
			throw new Error("missing declaration");
		}
		const task = declared.data.task;
		if (task.spec.kind !== "workflow") throw new Error("wrong task kind");
		expect(task.spec.inputs).toEqual({
			alpha: producer.output.ref,
			zeta: summary.output.ref,
		});
		expect(Object.keys(task.spec.inputs)).toEqual(["alpha", "zeta"]);
		expect(task.spec.after).toEqual(
			[producer.ref, summary.ref].sort((left, right) =>
				left.taskId < right.taskId ? -1 : 1,
			),
		);
		expect(task.spec.request).toEqual(nestedRequest({}));
		const { identitySha256, ...specWithoutIdentity } = task.spec;
		expect(identitySha256).toBe(
			deriveNestedWorkflowTaskIdentity({
				definitionIdentitySha256,
				inputSha256,
				namespace: [],
				spec: specWithoutIdentity,
			}),
		);
		const projected = reduceWorkflowEvents(records(commit.events));
		expect(projected.tasks[task.id]?.task).toEqual(task);
		const plain = materializer();
		plain.agent("producer", request());
		plain.support("summary", supportHelper({ parameters: { strict: true } }));
		const plainChild = plain.workflow("child", { request: nestedRequest({}) });
		const plainDeclaration = plain
			.closeEpoch("final", [plainChild])
			.events.filter((event) => event.type === "task-declared")[2];
		if (plainDeclaration?.type !== "task-declared") {
			throw new Error("missing declaration");
		}
		expect(plainDeclaration.data.task.id).toBe(task.id);
		expect(plainDeclaration.data.task.spec.inputs).toEqual({});
		expect(plainDeclaration.data.task.spec.after).toEqual([]);
		expect(plainDeclaration.data.task.spec.identitySha256).not.toBe(
			identitySha256,
		);
	});

	it("rejects unknown, foreign, or invalidly named artifact inputs", () => {
		const runtime = materializer();
		const producer = runtime.agent("producer", request());
		const message =
			"task data dependency is invalid, unknown, or belongs to another run";
		const unknown = createTaskHandle(
			{ runId: "workflow_materializer", taskId: "task_unknown" },
			{
				runId: "workflow_materializer",
				producerTaskId: "task_unknown",
				output: "result",
			},
		);
		expect(() =>
			runtime.workflow("unknown", {
				request: nestedRequest({}),
				inputs: { value: unknown.output },
			}),
		).toThrow(message);
		const foreign = createTaskHandle(
			{ runId: "workflow_other", taskId: producer.ref.taskId },
			{
				runId: "workflow_other",
				producerTaskId: producer.ref.taskId,
				output: "result",
			},
		);
		expect(() =>
			runtime.workflow("foreign", {
				request: nestedRequest({}),
				inputs: { value: foreign.output },
			}),
		).toThrow(message);
		expect(() =>
			runtime.workflow("named", {
				request: nestedRequest({}),
				inputs: { "Bad Name": producer.output },
			}),
		).toThrow(message);
		expect(runtime.closeEpoch("final", []).events).toHaveLength(2);
	});

	it("rejects replay prefix drift on changed artifact inputs", () => {
		const initial = materializer();
		const producer = initial.agent("producer", request());
		const child = initial.workflow("child", {
			request: nestedRequest({}),
			inputs: { value: producer.output },
		});
		const previousState = reduceWorkflowEvents(
			records(initial.closeEpoch("result", [child]).events),
		);
		const message =
			"task declaration does not match the persisted ordered prefix";
		const dropped = materializer(previousState);
		const droppedProducer = dropped.agent("producer", request());
		expect(() =>
			dropped.workflow("child", {
				request: nestedRequest({}),
				after: [droppedProducer.ref],
			}),
		).toThrow(message);
		const renamed = materializer(previousState);
		const renamedProducer = renamed.agent("producer", request());
		expect(() =>
			renamed.workflow("child", {
				request: nestedRequest({}),
				inputs: { other: renamedProducer.output },
			}),
		).toThrow(message);
		const replay = materializer(previousState);
		const replayedProducer = replay.agent("producer", request());
		const replayed = replay.workflow("child", {
			request: nestedRequest({}),
			inputs: { value: replayedProducer.output },
		});
		expect(replayed.ref).toEqual(child.ref);
		expect(replay.closeEpoch("result", [replayed]).events).toEqual([]);
	});

	it("rejects replay prefix drift on changed child input", () => {
		const initial = materializer();
		const child = initial.workflow("child", { request: nestedRequest() });
		const previousState = reduceWorkflowEvents(
			records(initial.closeEpoch("result", [child]).events),
		);
		const drifted = materializer(previousState);
		expect(() =>
			drifted.workflow("child", { request: nestedRequest({ value: "no" }) }),
		).toThrow("task declaration does not match the persisted ordered prefix");
		const replay = materializer(previousState);
		const replayed = replay.workflow("child", { request: nestedRequest() });
		expect(replayed.ref).toEqual(child.ref);
		expect(replay.closeEpoch("result", [replayed]).events).toEqual([]);
	});

	it("normalizes agent attempt policies and binds them to task identity", () => {
		const runtime = materializer();
		const defaulted = runtime.agent("defaulted", {
			...request(),
			retry: { attempts: 1 },
		});
		const sorted = runtime.agent("sorted", {
			...request(),
			retry: { attempts: 1, on: ["manual", "backoff"] },
			resume: { attempts: 1 },
		});
		const plain = runtime.agent("plain", request());
		const commit = runtime.closeEpoch("final", [defaulted, sorted, plain]);
		const declarations = commit.events.flatMap((event) =>
			event.type === "task-declared" ? [event.data.task] : [],
		);
		const [first, second, third] = declarations;
		if (
			first?.spec.kind !== "agent" ||
			second?.spec.kind !== "agent" ||
			third?.spec.kind !== "agent"
		) {
			throw new Error("missing agent declarations");
		}
		expect(first.spec.request.retry).toEqual({
			attempts: 1,
			on: ["backoff"],
		});
		expect(first.spec.request.resume).toBeUndefined();
		expect(second.spec.request.retry).toEqual({
			attempts: 1,
			on: ["backoff", "manual"],
		});
		expect(second.spec.request.resume).toEqual({ attempts: 1 });
		expect(third.spec.request.retry).toBeUndefined();
		expect(third.spec.request.resume).toBeUndefined();
		expect(Object.isFrozen(first.spec.request.retry)).toBe(true);
		const identity = (
			spec: Parameters<typeof deriveAgentTaskIdentity>[0]["spec"],
		) =>
			deriveAgentTaskIdentity({
				definitionIdentitySha256,
				inputSha256,
				namespace: [],
				spec,
			});
		const { identitySha256: _plainIdentity, ...plainSpec } = third.spec;
		const { identitySha256: _policyIdentity, ...policySpec } = first.spec;
		expect(identity({ ...plainSpec, key: "same" })).not.toBe(
			identity({ ...policySpec, key: "same" }),
		);
		expect(
			identity({
				...plainSpec,
				key: "same",
				request: {
					...plainSpec.request,
					resume: { attempts: 1 },
				},
			}),
		).not.toBe(identity({ ...plainSpec, key: "same" }));
		expect(reduceWorkflowEvents(records(commit.events)).tasks).toBeDefined();
	});

	it("rejects attempt policies that exceed the declared limits", () => {
		const runtime = materializer();
		expect(() =>
			runtime.agent("retry", {
				...request(),
				limits: { ...request().limits, retries: 1 },
				retry: { attempts: 2 },
			}),
		).toThrow("agent retry policy exceeds the declared retry limit");
		expect(() =>
			runtime.agent("resume", {
				...request(),
				limits: { ...request().limits, resumes: 0 },
				resume: { attempts: 1 },
			}),
		).toThrow("agent resume policy exceeds the declared resume limit");
		expect(() =>
			runtime.agent("bounds", {
				...request(),
				limits: { ...request().limits, retries: 10 },
				retry: { attempts: 11 },
			}),
		).toThrow("invalid agent task request");
		expect(() =>
			runtime.agent("duplicate", {
				...request(),
				retry: { attempts: 1, on: ["backoff", "backoff"] },
			}),
		).toThrow("invalid agent task request");
		expect(() =>
			runtime.agent("unknown", {
				...request(),
				retry: { attempts: 1, on: ["resume" as never] },
			}),
		).toThrow("invalid agent task request");
		expect(runtime.closeEpoch("final", []).events).toEqual([
			{
				type: "barrier-reached",
				data: { epoch: 1, kind: "final", taskIds: [] },
			},
		]);
	});

	it("rejects malformed requests and input digest mismatches", () => {
		const runtime = materializer();
		expect(() =>
			runtime.workflow("digest", {
				request: nestedRequest(undefined, { inputSha256: "0".repeat(64) }),
			}),
		).toThrow("nested workflow request input digest does not match its input");
		expect(() =>
			runtime.workflow("invalid", {
				request: nestedRequest(undefined, { concurrency: 0 }),
			}),
		).toThrow("invalid nested workflow task request");
		expect(() =>
			runtime.workflow("Bad Key", { request: nestedRequest() }),
		).toThrow("invalid task key");
		expect(() =>
			runtime.workflow("declared", {
				request: nestedRequest(),
				disposition: "sometimes" as never,
			}),
		).toThrow(WorkflowMaterializationError);
		expect(runtime.closeEpoch("final", []).events).toEqual([
			{
				type: "barrier-reached",
				data: { epoch: 1, kind: "final", taskIds: [] },
			},
		]);
	});
});
