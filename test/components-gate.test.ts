import { readFile } from "node:fs/promises";
import { parse } from "@babel/parser";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { MAX_CHECKPOINT_FLAT_PROPERTIES } from "../src/checkpoint-render.js";
import { WorkflowComponentError } from "../src/components/errors.js";
import { gate } from "../src/components/gate.js";
import type { CheckpointTaskSpec } from "../src/contracts.js";
import type { TaskKey } from "../src/contracts-core.js";
import type { WorkflowEventInput } from "../src/events.js";
import { WorkflowTaskMaterializer } from "../src/materializer.js";

// The component is only legitimate while its lowering is indistinguishable
// from the hand-written `ctx.checkpoint` call, so every assertion here runs
// through a real materializer and compares the persisted declarations - the
// `task-declared` events, including the derived task id and identity - rather
// than the arguments the component happened to build.

const definitionIdentitySha256 = "a".repeat(64);
const inputSha256 = "b".repeat(64);
const runId = "workflow_components";

function materializer(namespace: readonly TaskKey[] = []) {
	return new WorkflowTaskMaterializer({
		runId,
		definitionIdentitySha256,
		inputSha256,
		namespace,
	});
}

const DECISION = Type.Object(
	{ proceed: Type.Boolean(), note: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);

function agentRequest(goal = "Draft the plan") {
	return {
		agent: "planner",
		task: { goal, context: [], instructions: ["Return structured output."] },
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
			cost: 10,
			outputBytes: 65_536,
			workspaceWriteBytes: 0,
			retries: 1,
			resumes: 1,
		},
	};
}

function declarations(commit: { events: readonly WorkflowEventInput[] }) {
	return commit.events.flatMap((event) =>
		event.type === "task-declared" ? [event.data.task] : [],
	);
}

function checkpointSpec(task: unknown): CheckpointTaskSpec {
	const spec = (task as { spec: CheckpointTaskSpec }).spec;
	if (spec.kind !== "checkpoint") throw new Error("not a checkpoint task");
	return spec;
}

describe("gate lowering", () => {
	it("declares exactly what the hand-written checkpoint declares", () => {
		const lowered = materializer();
		const producer = lowered.agent("plan", agentRequest());
		const loweredHandle = gate(lowered, "approve-plan", {
			prompt: "Approve the plan before the writer runs?",
			schema: DECISION,
			inputs: { plan: producer.output },
			headless: "block",
			timeoutMs: 3_600_000,
		});

		const authored = materializer();
		const authoredProducer = authored.agent("plan", agentRequest());
		const authoredHandle = authored.checkpoint("approve-plan", {
			schema: DECISION,
			prompt: "Approve the plan before the writer runs?",
			headless: "block",
			timeoutMs: 3_600_000,
			inputs: { plan: authoredProducer.output },
		});

		expect(loweredHandle.ref).toEqual(authoredHandle.ref);
		expect(loweredHandle.output.ref).toEqual(authoredHandle.output.ref);
		expect(declarations(lowered.closeEpoch("final", [loweredHandle]))).toEqual(
			declarations(authored.closeEpoch("final", [authoredHandle])),
		);
	});

	it("passes a headless default and disposition through unchanged", () => {
		const lowered = materializer();
		const loweredHandle = gate(lowered, "ship", {
			prompt: "Ship the reviewed handoff?",
			schema: DECISION,
			headless: "use-explicit-default",
			default: { proceed: false },
			disposition: "optional",
		});
		const authored = materializer();
		const authoredHandle = authored.checkpoint("ship", {
			schema: DECISION,
			prompt: "Ship the reviewed handoff?",
			headless: "use-explicit-default",
			default: { proceed: false },
			disposition: "optional",
		});
		expect(declarations(lowered.closeEpoch("final", [loweredHandle]))).toEqual(
			declarations(authored.closeEpoch("final", [authoredHandle])),
		);
	});

	it("defaults headless to block and declares no optional field it was not given", () => {
		const runtime = materializer();
		const handle = gate(runtime, "approve", {
			prompt: "Approve?",
			schema: DECISION,
		});
		const [task] = declarations(runtime.closeEpoch("final", [handle]));
		const spec = checkpointSpec(task);
		expect(spec.request.headless).toBe("block");
		expect(Object.hasOwn(spec.request, "default")).toBe(false);
		expect(Object.hasOwn(spec.request, "timeoutMs")).toBe(false);
		expect(spec.disposition).toBe("required");
		expect(spec.inputs).toEqual({});
	});

	it("maps inputs onto the artifacts the approver is shown", () => {
		const runtime = materializer();
		const plan = runtime.agent("plan", agentRequest());
		const draft = runtime.agent("draft", agentRequest("Draft the release"));
		const handle = gate(runtime, "approve", {
			prompt: "Approve the draft?",
			schema: DECISION,
			inputs: { plan: plan.output, draft: draft.output },
		});
		const tasks = declarations(runtime.closeEpoch("final", [handle]));
		const spec = checkpointSpec(tasks[2]);
		expect(spec.inputs).toEqual({
			plan: plan.output.ref,
			draft: draft.output.ref,
		});
		// A data dependency is an order dependency too.
		expect(spec.after).toEqual(
			[plan.ref, draft.ref].sort((left, right) =>
				left.taskId < right.taskId ? -1 : 1,
			),
		);
	});
});

describe("gate keys", () => {
	it("is a pure function of namespace and the caller's stable id", () => {
		const first = materializer();
		const second = materializer();
		const options = {
			prompt: "Approve the plan?",
			schema: DECISION,
		} as const;
		expect(gate(first, "approve", options).ref).toEqual(
			gate(second, "approve", options).ref,
		);
		// Namespace-aware: the same key under a fan-out namespace is a
		// different task, and the component derives nothing of its own.
		const namespaced = materializer(["review"]);
		expect(gate(namespaced, "approve", options).ref.taskId).not.toBe(
			gate(materializer(), "approve", options).ref.taskId,
		);
	});

	it("refuses a key that is not a stable task key", () => {
		const runtime = materializer();
		expect(() =>
			gate(runtime, "Approve Plan" as TaskKey, {
				prompt: "Approve?",
				schema: DECISION,
			}),
		).toThrow(
			'gate key "Approve Plan" is not a task key; a gate key is a caller-supplied stable id matching ^[a-z][a-z0-9-]*$, 1..128 characters.',
		);
	});

	it("leaves the duplicate-key rule to the materializer", () => {
		const runtime = materializer();
		const options = { prompt: "Approve?", schema: DECISION } as const;
		gate(runtime, "approve", options);
		expect(() => gate(runtime, "approve", options)).toThrow(
			"duplicate task key in namespace",
		);
	});
});

describe("gate refusals", () => {
	const runtime = () => materializer();

	it("refuses a prompt that is not a question", () => {
		expect(() =>
			gate(runtime(), "approve", { prompt: "approval", schema: DECISION }),
		).toThrow(
			'gate "approve" prompt must be a question ending in "?"; it is the only text the approver is guaranteed to see.',
		);
		// A trailing newline still ends the question.
		expect(() =>
			gate(runtime(), "approve", {
				prompt: "Approve the plan?\n",
				schema: DECISION,
			}),
		).not.toThrow();
	});

	it("refuses a decision schema that is not an object", () => {
		expect(() =>
			gate(runtime(), "approve", {
				prompt: "Approve?",
				schema: Type.Boolean(),
			}),
		).toThrow(
			'gate "approve" decision schema must be an object schema; the session asks a gate property by property.',
		);
	});

	it("refuses a nested schema and a nine-leaf schema", () => {
		const flatMessage = `gate "approve" decision schema must be a flat object of 1..${MAX_CHECKPOINT_FLAT_PROPERTIES} leaf properties; anything larger degrades to a raw JSON editor the approver has to hand-write.`;
		expect(() =>
			gate(runtime(), "approve", {
				prompt: "Approve?",
				schema: Type.Object({
					decision: Type.Object({ proceed: Type.Boolean() }),
				}),
			}),
		).toThrow(flatMessage);
		const nine = Object.fromEntries(
			Array.from({ length: MAX_CHECKPOINT_FLAT_PROPERTIES + 1 }, (_, index) => [
				`field${index}`,
				Type.Boolean(),
			]),
		);
		expect(() =>
			gate(runtime(), "approve", {
				prompt: "Approve?",
				schema: Type.Object(nine),
			}),
		).toThrow(flatMessage);
		// Exactly eight leaves is still asked field by field.
		const eight = Object.fromEntries(
			Array.from({ length: MAX_CHECKPOINT_FLAT_PROPERTIES }, (_, index) => [
				`field${index}`,
				Type.Boolean(),
			]),
		);
		expect(() =>
			gate(runtime(), "approve", {
				prompt: "Approve?",
				schema: Type.Object(eight),
			}),
		).not.toThrow();
	});

	it("refuses an input that is not an artifact the decider can be shown", () => {
		const declaring = materializer();
		const plan = declaring.agent("plan", agentRequest());
		expect(() =>
			gate(declaring, "approve", {
				prompt: "Approve?",
				schema: DECISION,
				// The task handle, not its artifact handle: the common slip.
				inputs: { plan: plan as never },
			}),
		).toThrow(
			'gate "approve" input "plan" is not an artifact handle; pass handle.output or handle.handoff, never the task handle itself.',
		);
	});

	it("refuses a headless default policy without a default", () => {
		expect(() =>
			gate(runtime(), "approve", {
				prompt: "Approve?",
				schema: DECISION,
				headless: "use-explicit-default",
			}),
		).toThrow(
			'gate "approve" is headless "use-explicit-default" and needs an explicit default decision.',
		);
	});

	it("refuses at declaration, as a component error, before any task exists", () => {
		const declaring = materializer();
		let caught: unknown;
		try {
			gate(declaring, "approve", { prompt: "approval", schema: DECISION });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(WorkflowComponentError);
		expect((caught as WorkflowComponentError).component).toBe("gate");
		// Nothing was declared: the refusal never reaches the journal.
		expect(declarations(declaring.closeEpoch("final", []))).toEqual([]);
	});
});

describe("component library purity", () => {
	it("keeps UI, service, and the filesystem out of the entry's module graph", async () => {
		// The library is the authoring half of the package: a definition module
		// loads it, so it must not drag pi-tui, the service, the materializer,
		// or any host I/O into that graph. The pure shared pieces it does load
		// (`checkpoint-render.ts` and the two schema modules under it) decide
		// nothing and touch nothing. Value imports are followed; type-only
		// imports are erased and may point anywhere.
		const root = new URL("../src/", import.meta.url);
		const seen = new Set<string>();
		const external = new Set<string>();
		const queue = [new URL("components/index.ts", root)];
		for (let next = queue.shift(); next; next = queue.shift()) {
			if (seen.has(next.href)) continue;
			seen.add(next.href);
			const ast = parse(await readFile(next, "utf8"), {
				sourceType: "module",
				plugins: ["typescript"],
			});
			for (const node of ast.program.body) {
				let source: string | undefined;
				if (node.type === "ImportDeclaration") {
					if (node.importKind === "type") continue;
					if (
						node.specifiers.length > 0 &&
						node.specifiers.every(
							(specifier) =>
								specifier.type === "ImportSpecifier" &&
								specifier.importKind === "type",
						)
					) {
						continue;
					}
					source = node.source.value;
				} else if (node.type === "ExportNamedDeclaration" && node.source) {
					if (node.exportKind === "type") continue;
					source = node.source.value;
				} else if (node.type === "ExportAllDeclaration") {
					if (node.exportKind === "type") continue;
					source = node.source.value;
				}
				if (source === undefined) continue;
				if (source.startsWith(".")) {
					queue.push(new URL(source.replace(/\.js$/, ".ts"), next));
				} else {
					external.add(source);
				}
			}
		}
		const relative = [...seen]
			.map((href) => href.slice(root.href.length))
			.sort();
		expect(relative).toContain("components/index.ts");
		for (const forbidden of [
			"service.ts",
			"service-views.ts",
			"static-runtime.ts",
			"extension.ts",
			"tools.ts",
			"materializer.ts",
			"scheduler.ts",
			"ui/inspector.ts",
			"ui/checkpoint-form.ts",
		]) {
			expect(relative).not.toContain(forbidden);
		}
		expect(relative.filter((file) => file.startsWith("persistence/"))).toEqual(
			[],
		);
		// No host I/O and no terminal: no node builtin, no pi-tui, no Pi host
		// package at all. `ajv`/`ajv-formats` arrive with `definition.ts` - the
		// same JSON Schema validation the materializer runs.
		expect([...external].sort()).toEqual([
			"@vegardx/pi-subagent",
			"ajv",
			"ajv-formats",
			"typebox",
			"typebox/value",
		]);
	});
});
