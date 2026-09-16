import vm from "node:vm";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type {
	CheckpointTaskSpec,
	NestedWorkflowTaskRequest,
} from "../src/contracts.js";
import {
	type CheckpointRequest,
	createTaskHandle,
	isHandoffHandle,
} from "../src/definition.js";
import type { WorkflowEventInput } from "../src/events.js";
import { deriveJsonValueSha256 } from "../src/execution.js";
import {
	deriveAgentTaskIdentity,
	deriveCheckpointTaskIdentity,
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
		contractRevision: 19,
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

	it("accepts declarations whose values were created in another realm", () => {
		// Dynamic sources run in a `vm` context: their objects have foreign
		// prototypes but must be accepted like same-realm plain JSON.
		const foreign = vm.runInNewContext(
			`(${JSON.stringify({
				agent: request("Answer from the sandbox"),
				parameters: { strict: true },
				fallback: { proceed: false },
				input: { value: "yes" },
			})})`,
		) as {
			agent: ReturnType<typeof request>;
			parameters: { strict: boolean };
			fallback: { proceed: boolean };
			input: { value: string };
		};
		expect(Object.getPrototypeOf(foreign.agent)).not.toBe(Object.prototype);
		const runtime = materializer();
		const first = runtime.agent("first", foreign.agent);
		const parse = runtime.support(
			"parse",
			supportHelper({ parameters: foreign.parameters }),
		);
		const approve = runtime.checkpoint("approve", {
			schema: Type.Object({ proceed: Type.Boolean() }),
			prompt: "Approve?",
			headless: "use-explicit-default",
			default: foreign.fallback,
		});
		const child = runtime.workflow("child", {
			request: nestedRequest(foreign.input),
		});
		const commit = runtime.closeEpoch("final", [first, parse, approve, child]);
		const specs = commit.events.flatMap((event) =>
			event.type === "task-declared" ? [event.data.task.spec] : [],
		);
		expect(specs.map((spec) => spec.kind)).toEqual([
			"agent",
			"support",
			"checkpoint",
			"workflow",
		]);
		expect(specs[0]).toMatchObject({
			request: { task: { goal: "Answer from the sandbox" } },
		});
		expect(specs[1]).toMatchObject({
			request: { parameters: { strict: true } },
		});
		expect(specs[2]).toMatchObject({
			request: { default: { proceed: false } },
		});
		expect(specs[3]).toMatchObject({ request: { input: { value: "yes" } } });
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
			role: "task",
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

function worktreeRequest(goal = "Edit") {
	const base = request(goal);
	return {
		...base,
		tools: ["read", "edit", "write"],
		workspace: { mode: "worktree" as const, cwd: "/repo" },
		limits: { ...base.limits, workspaceWriteBytes: 1_048_576 },
	};
}

describe("worktree agent task materialization", () => {
	it("lowers worktree requests with a default handoff policy and a handoff handle", () => {
		const runtime = materializer();
		const writer = runtime.agent("writer", worktreeRequest());
		const optional = runtime.agent("optional", {
			...worktreeRequest("Optional"),
			handoff: "optional",
		});
		const reader = runtime.agent("reader", request());
		expect(writer.handoff.ref).toEqual({
			runId: "workflow_materializer",
			producerTaskId: writer.ref.taskId,
			output: "handoff",
		});
		expect(writer.output.ref).toEqual({
			runId: "workflow_materializer",
			producerTaskId: writer.ref.taskId,
			output: "result",
		});
		expect(isHandoffHandle(writer.handoff)).toBe(true);
		expect(isHandoffHandle(optional.handoff)).toBe(true);
		expect(Object.hasOwn(reader, "handoff")).toBe(false);
		const commit = runtime.closeEpoch("final", [writer, optional, reader]);
		const [first, second, third] = commit.events.flatMap((event) =>
			event.type === "task-declared" ? [event.data.task] : [],
		);
		if (
			first?.spec.kind !== "agent" ||
			second?.spec.kind !== "agent" ||
			third?.spec.kind !== "agent"
		) {
			throw new Error("missing agent declarations");
		}
		expect(first.spec.request.workspace).toEqual({
			mode: "worktree",
			cwd: "/repo",
		});
		expect(first.spec.request.handoff).toBe("required");
		expect(first.spec.request.limits.workspaceWriteBytes).toBe(1_048_576);
		expect(second.spec.request.handoff).toBe("optional");
		expect(third.spec.request.workspace).toEqual({
			mode: "read-only",
			cwd: "/repo",
		});
		expect(Object.hasOwn(third.spec.request, "handoff")).toBe(false);
		const projected = reduceWorkflowEvents(records(commit.events));
		expect(projected.tasks[first.id]?.task).toEqual(first);
		expect(projected.tasks[second.id]?.task).toEqual(second);
		expect(projected.tasks[third.id]?.task).toEqual(third);
	});

	// Revision 19: the guest memory grant. The ceiling lives in the agent
	// definition, which the workflow cannot read; the materializer only proves
	// the value is well formed and that it reaches the spec unchanged.
	it("admits a well-formed memoryBytes and carries it into task identity", () => {
		const runtime = materializer();
		const granted = runtime.agent("granted", {
			...request(),
			memoryBytes: 2 * 1024 * 1024 * 1024,
		});
		const omitted = runtime.agent("omitted", request());
		const commit = runtime.closeEpoch("final", [granted, omitted]);
		const [withGrant, withoutGrant] = commit.events.flatMap((event) =>
			event.type === "task-declared" ? [event.data.task] : [],
		);
		if (
			withGrant?.spec.kind !== "agent" ||
			withoutGrant?.spec.kind !== "agent"
		) {
			throw new Error("missing agent declarations");
		}
		expect(withGrant.spec.request.memoryBytes).toBe(2 * 1024 * 1024 * 1024);
		// Absent, not undefined: the lowered request must not carry the key.
		expect(Object.hasOwn(withoutGrant.spec.request, "memoryBytes")).toBe(false);
		// The grant is part of the request, so it is part of task identity.
		// (`taskId` is derived from the key; the request digest is
		// `spec.identitySha256`, which is what invalidation compares.)
		expect(withGrant.spec.identitySha256).not.toBe(
			withoutGrant.spec.identitySha256,
		);
		const other = materializer();
		const raised = other.agent("granted", {
			...request(),
			memoryBytes: 4 * 1024 * 1024 * 1024,
		});
		const [rebuilt] = other
			.closeEpoch("final", [raised])
			.events.flatMap((event) =>
				event.type === "task-declared" ? [event.data.task] : [],
			);
		expect(rebuilt?.spec.identitySha256).not.toBe(
			withGrant.spec.identitySha256,
		);
	});

	it("rejects a memoryBytes that is not a 64 MiB multiple within 4 GiB", () => {
		const message =
			"agent memoryBytes must be a positive multiple of 64 MiB and at most 4 GiB";
		for (const memoryBytes of [
			0,
			-(64 * 1024 * 1024),
			100 * 1024 * 1024,
			5 * 1024 * 1024 * 1024,
			64 * 1024 * 1024 + 1,
			1.5 * 64 * 1024 * 1024,
		]) {
			const runtime = materializer();
			expect(() =>
				runtime.agent("memory", { ...request(), memoryBytes }),
			).toThrow(message);
		}
		// The bounds themselves are admitted.
		for (const memoryBytes of [64 * 1024 * 1024, 4 * 1024 * 1024 * 1024]) {
			const runtime = materializer();
			expect(() =>
				runtime.agent("memory", { ...request(), memoryBytes }),
			).not.toThrow();
		}
	});

	it("rejects the fixed worktree and handoff request errors", () => {
		const runtime = materializer();
		expect(() =>
			runtime.agent("policy", { ...request(), handoff: "required" }),
		).toThrow("handoff policy requires a worktree workspace");
		expect(() =>
			runtime.agent("optional-policy", { ...request(), handoff: "optional" }),
		).toThrow("handoff policy requires a worktree workspace");
		expect(() =>
			runtime.agent("bytes", {
				...worktreeRequest(),
				limits: { ...worktreeRequest().limits, workspaceWriteBytes: 0 },
			}),
		).toThrow(
			"worktree workspace requires a positive workspaceWriteBytes limit",
		);
		expect(() =>
			runtime.agent("invalid-policy", {
				...worktreeRequest(),
				handoff: "sometimes" as never,
			}),
		).toThrow("invalid agent task request");
		expect(() =>
			runtime.agent("invalid-mode", {
				...request(),
				workspace: { mode: "shared" as never, cwd: "/repo" },
			}),
		).toThrow("invalid agent task request");
		expect(() =>
			runtime.agent("invalid-extra", {
				...worktreeRequest(),
				workspace: {
					mode: "worktree" as const,
					cwd: "/repo",
					branch: "main",
				} as never,
			}),
		).toThrow("invalid agent task request");
		const reader = runtime.agent("reader", request());
		const forgedAgent = createTaskHandle(
			{ runId: "workflow_materializer", taskId: reader.ref.taskId },
			reader.output.ref,
			{
				runId: "workflow_materializer",
				producerTaskId: reader.ref.taskId,
				output: "handoff",
			},
		);
		const message = "handoff input producer is not a worktree agent task";
		expect(() =>
			runtime.agent("consumer", {
				...request("Consume"),
				inputs: { patch: forgedAgent.handoff },
			}),
		).toThrow(message);
		const summary = runtime.support(
			"summary",
			supportHelper({ parameters: { strict: true } }),
		);
		const forgedSupport = createTaskHandle(
			{ runId: "workflow_materializer", taskId: summary.ref.taskId },
			summary.output.ref,
			{
				runId: "workflow_materializer",
				producerTaskId: summary.ref.taskId,
				output: "handoff",
			},
		);
		expect(() =>
			runtime.workflow("child", {
				request: nestedRequest({}),
				inputs: { patch: forgedSupport.handoff },
			}),
		).toThrow(message);
		const unknown = createTaskHandle(
			{ runId: "workflow_materializer", taskId: "task_unknown" },
			{
				runId: "workflow_materializer",
				producerTaskId: "task_unknown",
				output: "result",
			},
			{
				runId: "workflow_materializer",
				producerTaskId: "task_unknown",
				output: "handoff",
			},
		);
		expect(() =>
			runtime.agent("unknown", {
				...request("Consume"),
				inputs: { patch: unknown.handoff },
			}),
		).toThrow(
			"task data dependency is invalid, unknown, or belongs to another run",
		);
		expect(runtime.closeEpoch("final", []).events).toHaveLength(3);
	});

	it("binds the handoff policy to identity and replays exact worktree prefixes", () => {
		const initial = materializer();
		const writer = initial.agent("writer", worktreeRequest());
		const commit = initial.closeEpoch("result", [writer]);
		const declaration = commit.events[0];
		if (declaration?.type !== "task-declared") {
			throw new Error("missing declaration");
		}
		const task = declaration.data.task;
		if (task.spec.kind !== "agent") throw new Error("wrong task kind");
		const { identitySha256, ...specWithoutIdentity } = task.spec;
		const identity = (spec: typeof specWithoutIdentity) =>
			deriveAgentTaskIdentity({
				definitionIdentitySha256,
				inputSha256,
				namespace: [],
				spec,
			});
		expect(identitySha256).toBe(identity(specWithoutIdentity));
		expect(
			identity({
				...specWithoutIdentity,
				request: { ...specWithoutIdentity.request, handoff: "optional" },
			}),
		).not.toBe(identitySha256);
		const explicit = materializer();
		const explicitWriter = explicit.agent("writer", {
			...worktreeRequest(),
			handoff: "required",
		});
		expect(explicit.closeEpoch("result", [explicitWriter]).events).toEqual(
			commit.events,
		);
		const previousState = reduceWorkflowEvents(records(commit.events));
		const replay = materializer(previousState);
		const replayed = replay.agent("writer", worktreeRequest());
		expect(replayed.ref).toEqual(writer.ref);
		expect(replayed.handoff.ref).toEqual(writer.handoff.ref);
		expect(replay.closeEpoch("result", [replayed]).events).toEqual([]);
		const drifted = materializer(previousState);
		expect(() =>
			drifted.agent("writer", { ...worktreeRequest(), handoff: "optional" }),
		).toThrow("task declaration does not match the persisted ordered prefix");
		const degraded = materializer(previousState);
		expect(() =>
			degraded.agent("writer", {
				...worktreeRequest(),
				workspace: { mode: "read-only" as const, cwd: "/repo" },
			}),
		).toThrow("task declaration does not match the persisted ordered prefix");
	});

	it("accepts handoff inputs from worktree producers and orders after them", () => {
		const runtime = materializer();
		const writer = runtime.agent("writer", worktreeRequest());
		const reviewer = runtime.agent("reviewer", {
			...request("Review"),
			inputs: { patch: writer.handoff, answer: writer.output },
		});
		const child = runtime.workflow("child", {
			request: nestedRequest({}),
			inputs: { patch: writer.handoff },
		});
		const commit = runtime.closeEpoch("final", [reviewer, child]);
		const declarations = commit.events.flatMap((event) =>
			event.type === "task-declared" ? [event.data.task] : [],
		);
		expect(declarations).toHaveLength(3);
		const [, reviewerTask, childTask] = declarations;
		if (reviewerTask?.spec.kind !== "agent") {
			throw new Error("missing reviewer declaration");
		}
		if (childTask?.spec.kind !== "workflow") {
			throw new Error("missing child declaration");
		}
		expect(reviewerTask.spec.inputs).toEqual({
			answer: writer.output.ref,
			patch: writer.handoff.ref,
		});
		expect(Object.keys(reviewerTask.spec.inputs)).toEqual(["answer", "patch"]);
		expect(reviewerTask.spec.after).toEqual([writer.ref]);
		expect(childTask.spec.inputs).toEqual({ patch: writer.handoff.ref });
		expect(childTask.spec.after).toEqual([writer.ref]);
		const projected = reduceWorkflowEvents(records(commit.events));
		expect(projected.tasks[reviewerTask.id]?.task).toEqual(reviewerTask);
		expect(projected.tasks[childTask.id]?.task).toEqual(childTask);
		const plain = materializer();
		plain.agent("writer", worktreeRequest());
		const plainReviewer = plain.agent("reviewer", request("Review"));
		const plainDeclaration = plain
			.closeEpoch("final", [plainReviewer])
			.events.filter((event) => event.type === "task-declared")[1];
		if (plainDeclaration?.type !== "task-declared") {
			throw new Error("missing declaration");
		}
		expect(plainDeclaration.data.task.spec.after).toEqual([]);
		expect(plainDeclaration.data.task.spec.identitySha256).not.toBe(
			reviewerTask.spec.identitySha256,
		);
	});
});

describe("checkpoint task materialization", () => {
	const decisionSchema = Type.Object(
		{ proceed: Type.Boolean(), note: Type.Optional(Type.String()) },
		{ additionalProperties: false },
	);
	const decisionSchemaJson = JSON.parse(JSON.stringify(decisionSchema));
	const MAX_WORKFLOW_DURATION_MS = 365 * 24 * 60 * 60 * 1_000;

	function checkpointRequest(
		overrides: Record<string, unknown> = {},
	): CheckpointRequest<typeof decisionSchema> {
		return {
			schema: decisionSchema,
			prompt: "Approve the plan?",
			headless: "block",
			...overrides,
		} as CheckpointRequest<typeof decisionSchema>;
	}

	function declared(events: readonly WorkflowEventInput[]) {
		return events.flatMap((event) =>
			event.type === "task-declared" ? [event.data.task] : [],
		);
	}

	function identity(spec: Omit<CheckpointTaskSpec, "identitySha256">) {
		return deriveCheckpointTaskIdentity({
			definitionIdentitySha256,
			inputSha256,
			namespace: [],
			spec,
		});
	}

	it("declares a checkpoint with a stable id, a lowered request, and a result-only handle", () => {
		const runtime = materializer();
		const plan = runtime.agent("plan", request("Plan"));
		const approve = runtime.checkpoint("approve", {
			schema: decisionSchema,
			prompt: "Approve the plan?",
			headless: "use-explicit-default",
			default: { proceed: false },
			timeoutMs: 3_600_000,
			inputs: { plan: plan.output },
		});
		expect(approve.ref).toEqual({
			runId: "workflow_materializer",
			taskId: deriveWorkflowTaskId("workflow_materializer", [], "approve"),
		});
		expect(approve.output.ref).toEqual({
			runId: "workflow_materializer",
			producerTaskId: approve.ref.taskId,
			output: "result",
		});
		expect(Object.hasOwn(approve, "handoff")).toBe(false);
		expect(isHandoffHandle(approve.output)).toBe(false);
		expect(Object.isFrozen(approve)).toBe(true);
		const commit = runtime.closeEpoch("result", [approve]);
		expect(commit.events.map((event) => event.type)).toEqual([
			"task-declared",
			"task-declared",
			"barrier-reached",
		]);
		const [, task] = declared(commit.events);
		if (task?.spec.kind !== "checkpoint") {
			throw new Error("missing checkpoint declaration");
		}
		expect(task.id).toBe(approve.ref.taskId);
		expect(task.runId).toBe("workflow_materializer");
		expect(task.namespace).toEqual([]);
		expect(task.materializationEpoch).toBe(1);
		expect(task.epochPosition).toBe(2);
		expect(task.materializationSequence).toBe(2);
		const { identitySha256, ...specWithoutIdentity } = task.spec;
		expect(specWithoutIdentity).toEqual({
			key: "approve",
			kind: "checkpoint",
			role: "task",
			disposition: "required",
			after: [plan.ref],
			inputs: { plan: plan.output.ref },
			replay: "read-only",
			request: {
				schema: decisionSchemaJson,
				prompt: "Approve the plan?",
				headless: "use-explicit-default",
				default: { proceed: false },
				timeoutMs: 3_600_000,
			},
		});
		expect(identitySha256).toBe(identity(specWithoutIdentity));
		expect(Object.isFrozen(task.spec.request.schema)).toBe(true);
		expect(Object.isFrozen(task.spec.request.default)).toBe(true);
		const projected = reduceWorkflowEvents(records(commit.events));
		expect(projected.tasks[task.id]?.task).toEqual(task);
		expect(projected.tasks[task.id]?.status).toBe("pending");
	});

	it("omits absent default and timeout from the lowered request", () => {
		const runtime = materializer();
		const approve = runtime.checkpoint("approve", checkpointRequest());
		const [task] = declared(runtime.closeEpoch("final", [approve]).events);
		if (task?.spec.kind !== "checkpoint") {
			throw new Error("missing checkpoint declaration");
		}
		expect(task.spec.request).toEqual({
			schema: decisionSchemaJson,
			prompt: "Approve the plan?",
			headless: "block",
		});
		expect(Object.hasOwn(task.spec.request, "default")).toBe(false);
		expect(Object.hasOwn(task.spec.request, "timeoutMs")).toBe(false);
		expect(task.spec.after).toEqual([]);
		expect(task.spec.inputs).toEqual({});
		expect(task.spec.disposition).toBe("required");
		expect(task.spec.replay).toBe("read-only");
	});

	it("binds identity to prompt, schema, default, headless policy, timeout, role, and disposition", () => {
		const runtime = materializer();
		const approve = runtime.checkpoint(
			"approve",
			checkpointRequest({ default: { proceed: true }, timeoutMs: 60_000 }),
		);
		const commit = runtime.closeEpoch("final", [approve]);
		const [task] = declared(commit.events);
		if (task?.spec.kind !== "checkpoint") {
			throw new Error("missing checkpoint declaration");
		}
		const { identitySha256, ...base } = task.spec;
		expect(identity(base)).toBe(identitySha256);
		const variants = [
			{ ...base, request: { ...base.request, prompt: "Approve the plan!" } },
			{
				...base,
				request: {
					...base.request,
					schema: JSON.parse(
						JSON.stringify(Type.Object({ proceed: Type.Boolean() })),
					),
				},
			},
			{ ...base, request: { ...base.request, default: { proceed: false } } },
			{
				...base,
				request: { ...base.request, headless: "use-explicit-default" as const },
			},
			{ ...base, request: { ...base.request, timeoutMs: 60_001 } },
			{ ...base, role: "finalizer" as const },
			{ ...base, disposition: "optional" as const },
			{ ...base, replay: "off" as const },
		];
		const identities = variants.map((variant) => identity(variant));
		for (const candidate of identities) {
			expect(candidate).not.toBe(identitySha256);
		}
		expect(new Set(identities).size).toBe(variants.length);
		const { default: _omitted, ...withoutDefault } = base.request;
		expect(identity({ ...base, request: withoutDefault })).not.toBe(
			identitySha256,
		);
		const same = materializer();
		const repeated = same.checkpoint("approve", {
			schema: JSON.parse(JSON.stringify(decisionSchema)),
			prompt: "Approve the plan?",
			headless: "block",
			default: { proceed: true },
			timeoutMs: 60_000,
		});
		expect(same.closeEpoch("final", [repeated]).events).toEqual(commit.events);
	});

	it("replays an exact checkpoint epoch without events and rejects prefix drift", () => {
		const initial = materializer();
		const approve = initial.checkpoint(
			"approve",
			checkpointRequest({ timeoutMs: 60_000 }),
		);
		const commit = initial.closeEpoch("result", [approve]);
		const previousState = reduceWorkflowEvents(records(commit.events));
		const replay = materializer(previousState);
		const replayed = replay.checkpoint(
			"approve",
			checkpointRequest({ timeoutMs: 60_000 }),
		);
		expect(replayed.ref).toEqual(approve.ref);
		expect(replayed.output.ref).toEqual(approve.output.ref);
		expect(replay.closeEpoch("result", [replayed]).events).toEqual([]);
		for (const drift of [
			{ prompt: "Approve now?" },
			{ timeoutMs: 60_001 },
			{ headless: "use-explicit-default", default: { proceed: true } },
			{ default: { proceed: true } },
			{ schema: Type.Object({ proceed: Type.Boolean() }) },
			{ disposition: "optional" },
		]) {
			const drifted = materializer(previousState);
			expect(() =>
				drifted.checkpoint(
					"approve",
					checkpointRequest({ timeoutMs: 60_000, ...drift }),
				),
			).toThrow("task declaration does not match the persisted ordered prefix");
		}
		const changedKind = materializer(previousState);
		expect(() => changedKind.agent("approve", request())).toThrow(
			"task declaration does not match the persisted ordered prefix",
		);
	});

	it("rejects the fixed checkpoint request errors in order", () => {
		const runtime = materializer();
		expect(() =>
			runtime.checkpoint("bad", checkpointRequest({ schema: () => true })),
		).toThrow(
			"checkpoint decision schema must be a bounded JSON-serializable schema",
		);
		expect(() =>
			runtime.checkpoint(
				"bad",
				checkpointRequest({ schema: { type: "not-a-schema-type" } }),
			),
		).toThrow("checkpoint decision schema is not a valid JSON Schema");
		for (const prompt of ["", "x".repeat(4097), 12, undefined]) {
			expect(() =>
				runtime.checkpoint("bad", checkpointRequest({ prompt })),
			).toThrow("invalid checkpoint prompt");
		}
		expect(() =>
			runtime.checkpoint(
				"ok-prompt",
				checkpointRequest({ prompt: "x".repeat(4096) }),
			),
		).not.toThrow();
		for (const headless of ["sometimes", undefined, true]) {
			expect(() =>
				runtime.checkpoint("bad", checkpointRequest({ headless })),
			).toThrow("invalid checkpoint headless policy");
		}
		for (const timeoutMs of [
			999,
			1_000.5,
			MAX_WORKFLOW_DURATION_MS + 1,
			Number.NaN,
			"60000",
		]) {
			expect(() =>
				runtime.checkpoint("bad", checkpointRequest({ timeoutMs })),
			).toThrow("invalid checkpoint timeout");
		}
		expect(() =>
			runtime.checkpoint("ok-timeout", checkpointRequest({ timeoutMs: 1_000 })),
		).not.toThrow();
		expect(() =>
			runtime.checkpoint("bad", checkpointRequest({ default: () => true })),
		).toThrow("checkpoint default is not JSON");
		expect(() =>
			runtime.checkpoint("bad", checkpointRequest({ default: 1n })),
		).toThrow("checkpoint default is not JSON");
		expect(() =>
			runtime.checkpoint(
				"bad",
				checkpointRequest({ default: { proceed: "yes" } }),
			),
		).toThrow("checkpoint default does not match its schema");
		expect(() =>
			runtime.checkpoint(
				"bad",
				checkpointRequest({ default: { proceed: true, extra: 1 } }),
			),
		).toThrow("checkpoint default does not match its schema");
		expect(() =>
			runtime.checkpoint(
				"bad",
				checkpointRequest({ headless: "use-explicit-default" }),
			),
		).toThrow("checkpoint headless default requires an explicit default");
		expect(() =>
			runtime.checkpoint(
				"bad",
				checkpointRequest({
					headless: "use-explicit-default",
					default: undefined,
				}),
			),
		).toThrow("checkpoint headless default requires an explicit default");
		// The schema is validated before the prompt, the prompt before the
		// policy, the policy before the timeout, and the timeout before the
		// default.
		expect(() =>
			runtime.checkpoint(
				"bad",
				checkpointRequest({ schema: { type: "nope" }, prompt: "" }),
			),
		).toThrow("checkpoint decision schema is not a valid JSON Schema");
		expect(() =>
			runtime.checkpoint(
				"bad",
				checkpointRequest({ prompt: "", headless: "sometimes" }),
			),
		).toThrow("invalid checkpoint prompt");
		expect(() =>
			runtime.checkpoint(
				"bad",
				checkpointRequest({ headless: "sometimes", timeoutMs: 1 }),
			),
		).toThrow("invalid checkpoint headless policy");
		expect(() =>
			runtime.checkpoint(
				"bad",
				checkpointRequest({ timeoutMs: 1, default: { proceed: "yes" } }),
			),
		).toThrow("invalid checkpoint timeout");
		expect(() =>
			runtime.checkpoint(
				"bad",
				checkpointRequest({
					headless: "use-explicit-default",
					default: { proceed: "yes" },
				}),
			),
		).toThrow("checkpoint default does not match its schema");
		// Nothing above was declared.
		expect(() => runtime.checkpoint("bad", checkpointRequest())).not.toThrow();
		expect(() => runtime.checkpoint("bad", checkpointRequest())).toThrow(
			"duplicate task key in namespace",
		);
		expect(() => runtime.checkpoint("Bad Key", checkpointRequest())).toThrow(
			"invalid task key",
		);
		expect(() =>
			runtime.checkpoint(
				"unknown-after",
				checkpointRequest({
					after: [
						{
							runId: "workflow_materializer",
							taskId: `task_${"e".repeat(64)}`,
						},
					],
				}),
			),
		).toThrow("task order dependency is unknown or belongs to another run");
		const foreign = createTaskHandle<unknown>(
			{ runId: "workflow_other", taskId: `task_${"e".repeat(64)}` },
			{
				runId: "workflow_other",
				producerTaskId: `task_${"e".repeat(64)}`,
				output: "result",
			},
		);
		expect(() =>
			runtime.checkpoint(
				"foreign-input",
				checkpointRequest({ inputs: { other: foreign.output } }),
			),
		).toThrow(
			"task data dependency is invalid, unknown, or belongs to another run",
		);
	});

	it("rejects a materialized checkpoint that exceeds the spec bounds", () => {
		const runtime = materializer();
		const plan = runtime.agent("plan", request("Plan"));
		const inputs = Object.fromEntries(
			Array.from({ length: 65 }, (_, index) => [`input-${index}`, plan.output]),
		);
		expect(() =>
			runtime.checkpoint("approve", checkpointRequest({ inputs })),
		).toThrow("invalid materialized checkpoint task");
		const bounded = Object.fromEntries(
			Array.from({ length: 64 }, (_, index) => [`input-${index}`, plan.output]),
		);
		expect(() =>
			runtime.checkpoint("approve", checkpointRequest({ inputs: bounded })),
		).not.toThrow();
	});

	it("cannot be declared as a finalizer", () => {
		const runtime = materializer();
		expect(() =>
			runtime.finalizer("approve", {
				kind: "required",
				checkpoint: checkpointRequest(),
			} as never),
		).toThrow("finalizer requires exactly one of support, agent, or workflow");
		const internal = runtime as unknown as {
			declareCheckpoint(
				key: string,
				request: CheckpointRequest<typeof decisionSchema>,
				role: "task" | "finalizer",
			): unknown;
		};
		expect(() =>
			internal.declareCheckpoint("approve", checkpointRequest(), "finalizer"),
		).toThrow("a checkpoint cannot be a finalizer");
		// The role check precedes request validation.
		expect(() =>
			internal.declareCheckpoint(
				"approve",
				checkpointRequest({ schema: { type: "nope" } }),
				"finalizer",
			),
		).toThrow("a checkpoint cannot be a finalizer");
		expect(() =>
			internal.declareCheckpoint("approve", checkpointRequest(), "task"),
		).not.toThrow();
		const [task] = declared(runtime.closeEpoch("final", []).events);
		expect(task?.spec.role).toBe("task");
	});

	it("is a legal barrier target and finalizer dependency", () => {
		for (const kind of ["result", "results", "settled"] as const) {
			const runtime = materializer();
			const approve = runtime.checkpoint("approve", checkpointRequest());
			const commit = runtime.closeEpoch(kind, [approve]);
			expect(commit.events.at(-1)).toEqual({
				type: "barrier-reached",
				data: { epoch: 1, kind, taskIds: [approve.ref.taskId] },
			});
			const follower = runtime.agent("follower", request("Follow"));
			const [followerTask] = declared(
				runtime.closeEpoch("final", [follower]).events,
			);
			expect(followerTask?.spec.after).toEqual([approve.ref]);
		}
		const runtime = materializer();
		const approve = runtime.checkpoint("approve", checkpointRequest());
		const writer = runtime.agent("writer", {
			...worktreeRequest(),
			after: [approve.ref],
		});
		const finalizer = runtime.finalizer("cleanup", {
			kind: "required",
			support: supportHelper({
				parameters: { strict: true },
				after: [approve.ref],
				inputs: { decision: approve.output },
			}),
		});
		expect(() =>
			runtime.checkpoint("late", checkpointRequest({ after: [finalizer.ref] })),
		).toThrow("ordinary task may not depend on a finalizer");
		expect(() => runtime.closeEpoch("final", [finalizer])).toThrow(
			"a finalizer cannot be a barrier target",
		);
		const commit = runtime.closeEpoch("final", [writer, approve]);
		const [, writerTask, finalizerTask] = declared(commit.events);
		expect(writerTask?.spec.after).toEqual([approve.ref]);
		if (finalizerTask?.spec.kind !== "support") {
			throw new Error("missing finalizer declaration");
		}
		expect(finalizerTask.spec.role).toBe("finalizer");
		expect(finalizerTask.spec.after).toEqual([approve.ref]);
		expect(finalizerTask.spec.inputs).toEqual({ decision: approve.output.ref });
		const projected = reduceWorkflowEvents(records(commit.events));
		expect(projected.tasks[finalizerTask.id]?.task).toEqual(finalizerTask);
	});

	it("accepts handoff inputs from worktree producers and refuses others", () => {
		const runtime = materializer();
		const writer = runtime.agent("writer", worktreeRequest());
		const reader = runtime.agent("reader", request());
		const review = runtime.checkpoint("review", {
			schema: decisionSchema,
			prompt: "Accept the handoff?",
			headless: "block",
			inputs: {
				patch: writer.handoff,
				answer: writer.output,
				reader: reader.output,
			},
		});
		const commit = runtime.closeEpoch("final", [review]);
		const [, , reviewTask] = declared(commit.events);
		if (reviewTask?.spec.kind !== "checkpoint") {
			throw new Error("missing checkpoint declaration");
		}
		expect(reviewTask.spec.inputs).toEqual({
			answer: writer.output.ref,
			patch: writer.handoff.ref,
			reader: reader.output.ref,
		});
		expect(Object.keys(reviewTask.spec.inputs)).toEqual([
			"answer",
			"patch",
			"reader",
		]);
		expect(reviewTask.spec.after).toEqual(
			[reader.ref, writer.ref].sort((left, right) =>
				left.taskId < right.taskId ? -1 : 1,
			),
		);
		const projected = reduceWorkflowEvents(records(commit.events));
		expect(projected.tasks[reviewTask.id]?.task).toEqual(reviewTask);
		const plain = materializer();
		const plainReader = plain.agent("reader", request());
		const forged = createTaskHandle<unknown>(
			plainReader.ref,
			plainReader.output.ref,
			{
				runId: "workflow_materializer",
				producerTaskId: plainReader.ref.taskId,
				output: "handoff",
			},
		);
		expect(() =>
			plain.checkpoint(
				"review",
				checkpointRequest({ inputs: { patch: forged.handoff } }),
			),
		).toThrow("handoff input producer is not a worktree agent task");
		const gated = materializer();
		const approve = gated.checkpoint("approve", checkpointRequest());
		expect(() =>
			gated.checkpoint(
				"second",
				checkpointRequest({
					inputs: {
						patch: createTaskHandle<unknown>(approve.ref, approve.output.ref, {
							runId: "workflow_materializer",
							producerTaskId: approve.ref.taskId,
							output: "handoff",
						}).handoff,
					},
				}),
			),
		).toThrow("handoff input producer is not a worktree agent task");
	});
});
