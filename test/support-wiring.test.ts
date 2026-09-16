import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	CONFIG_DIR_NAME,
	createEventBus,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { SubagentService } from "@vegardx/pi-subagent";
import { registerSubagentServiceProvider } from "@vegardx/pi-subagent/service-provider";
import { type Static, Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStateProjection } from "../src/events.js";
import workflowExtension from "../src/extension.js";
import type { WorkflowJournalEvent } from "../src/persistence/journal.js";
import { reduceWorkflowEvents } from "../src/reducer.js";
import type { WorkflowServiceOptions } from "../src/service.js";
import {
	defineSupportTask,
	type SupportTaskExecutionContext,
} from "../src/support.js";
import {
	BUILTIN_SUPPORT_TASKS,
	registerSupportTask,
	supportTaskRegistrations,
} from "../src/support-registry.js";

/**
 * Every `createWorkflowService` call the extension makes, so the construction
 * options themselves are observable and not only their effects.
 */
const constructed = vi.hoisted(() => [] as WorkflowServiceOptions[]);

vi.mock("../src/service.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/service.js")>();
	return {
		...actual,
		createWorkflowService: (options: WorkflowServiceOptions) => {
			constructed.push(options);
			return actual.createWorkflowService(options);
		},
	};
});

const TOOLS_MODULE = "@vegardx/workflow-support-wiring";
const ANSWER_SCHEMA = Type.Object({ answer: Type.String() });
const VALUE_SCHEMA = Type.Object({ value: Type.String() });
type ValueContext = SupportTaskExecutionContext<Static<typeof VALUE_SCHEMA>>;

function helper(name: string, digit: string) {
	return defineSupportTask({
		name: `${TOOLS_MODULE}/${name}`,
		moduleSpecifier: TOOLS_MODULE,
		revision: 1,
		implementationSha256: digit.repeat(64),
		parametersSchema: VALUE_SCHEMA,
		outputSchema: ANSWER_SCHEMA,
	});
}

/** Registered in the tests that need it; stands in for a shipped builtin. */
const shout = helper("shout", "a");
/** Never registered: the unresolvable helper of the refusal test. */
const absent = helper("absent", "b");
const shoutExecute = ({ parameters }: ValueContext) => ({
	answer: parameters.value.toUpperCase(),
});

/**
 * The installed package a static definition imports its descriptors from. The
 * service admits exactly the module specifiers of the registered helpers, so
 * this import only resolves because `shout` is registered.
 */
function toolsModuleSource(): string {
	const exported = [shout, absent].map((entry) => {
		const identity = JSON.stringify({
			implementation: entry.implementation,
			moduleSpecifier: entry.moduleSpecifier,
			revision: entry.revision,
			implementationSha256: entry.implementationSha256,
			parametersSchema: entry.parametersSchema,
			outputSchema: entry.outputSchema,
		});
		const exportName = entry.implementation.split("/").at(-1);
		return `export function ${exportName}(call) { return descriptor(${identity}, call); }`;
	});
	return `function descriptor(identity, call) {
  return Object.freeze({
    schema: "pi-workflow-support-task-descriptor",
    ...identity,
    parameters: call.parameters,
  });
}
${exported.join("\n")}
`;
}

function definitionSource(name: string, exportName: string): string {
	return `import { ${exportName} } from ${JSON.stringify(TOOLS_MODULE)};
export default {
  schema: "pi-workflow-definition",
  meta: { name: ${JSON.stringify(name)}, description: "Support wiring", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 600000, concurrency: 1 },
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  run(ctx) {
    return ctx.support("run", ${exportName}({ parameters: { value: ctx.input.value } }));
  }
};
`;
}

/** A project holding the fake tools package and one support-only definition. */
async function project(name: string, exportName: string): Promise<string> {
	const cwd = path.resolve(
		".pi",
		"test-support-wiring",
		`${name}-${randomUUID()}`,
	);
	const packageDir = path.join(cwd, "node_modules", ...TOOLS_MODULE.split("/"));
	await mkdir(path.join(cwd, "workflows"), { recursive: true });
	await mkdir(packageDir, { recursive: true });
	await writeFile(
		path.join(packageDir, "package.json"),
		JSON.stringify({ name: TOOLS_MODULE, type: "module", main: "index.js" }),
	);
	await writeFile(path.join(packageDir, "index.js"), toolsModuleSource());
	await writeFile(
		path.join(cwd, "workflows", `${name}.workflow.ts`),
		definitionSource(name, exportName),
	);
	return cwd;
}

/** A pi-subagent service that never launches anything. */
function idleSubagentService(): SubagentService {
	const refuse = () =>
		vi.fn(async () => {
			throw new Error("unexpected subagent call");
		});
	const client = Object.fromEntries(
		[
			"preflight",
			"launch",
			"findByOperation",
			"status",
			"listRuns",
			"logs",
			"wait",
			"interrupt",
			"steer",
			"followUp",
			"retry",
			"resume",
			"reconcile",
			"release",
			"abandon",
			"pin",
			"unpin",
			"exportArtifact",
			"exportHandoff",
		].map((method) => [method, refuse()]),
	);
	return {
		forOwner: vi.fn(() => client),
		listRuns: refuse(),
		inspectRun: refuse(),
		runLogs: refuse(),
		subscribe: vi.fn(() => () => {}),
		prune: refuse(),
		shutdown: vi.fn(async () => {}),
	} as unknown as SubagentService;
}

function capture() {
	const tools: ToolDefinition[] = [];
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const events = createEventBus();
	registerSubagentServiceProvider(events, async () => idleSubagentService());
	const api = {
		events,
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
		registerCommand() {},
		registerShortcut() {},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	workflowExtension(api);
	const tool = (name: string) => {
		const found = tools.find((candidate) => candidate.name === name);
		if (!found) throw new Error(`${name} missing`);
		return found;
	};
	return { handlers, tool };
}

function contextFor(cwd: string) {
	return {
		cwd,
		mode: "print",
		hasUI: false,
		isProjectTrusted: () => true,
		ui: { notify: vi.fn(), confirm: vi.fn(), setWidget: vi.fn() },
		sessionManager: { getSessionId: () => "session-support" },
	} as never;
}

async function stateOf(
	cwd: string,
	runId: string,
): Promise<WorkflowStateProjection> {
	const journal = await readFile(
		path.join(cwd, CONFIG_DIR_NAME, "workflow", "runs", runId, "events.jsonl"),
		"utf8",
	);
	return reduceWorkflowEvents(
		journal
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as WorkflowJournalEvent),
	);
}

function supportTerminal(state: WorkflowStateProjection) {
	const task = Object.values(state.tasks).find(
		(candidate) => candidate.task.spec.kind === "support",
	);
	if (!task?.currentExecutionId) throw new Error("no support task ran");
	return state.executions[task.currentExecutionId]?.terminal;
}

/** Runs `ref` through the extension's own tools and waits for its terminal. */
async function runThroughExtension(cwd: string, ref: string) {
	const { handlers, tool } = capture();
	const context = contextFor(cwd);
	const signal = new AbortController().signal;
	try {
		const started = await tool("workflow_run").execute(
			"call-run",
			{ ref, input: { value: "wired" } },
			signal,
			undefined,
			context,
		);
		const { runId } = started.details as { runId: string };
		const settled = await tool("workflow_wait").execute(
			"call-wait",
			{ runId },
			signal,
			undefined,
			context,
		);
		return {
			runId,
			view: settled.details as { status: string; output?: unknown },
		};
	} finally {
		await handlers.get("session_shutdown")?.({ reason: "quit" }, context);
	}
}

describe("support task wiring", () => {
	afterEach(() => {
		constructed.length = 0;
		vi.restoreAllMocks();
	});

	it("ships no builtin implementation, so the default registry is empty", () => {
		expect(BUILTIN_SUPPORT_TASKS).toEqual([]);
		expect(Object.isFrozen(BUILTIN_SUPPORT_TASKS)).toBe(true);
		expect(supportTaskRegistrations()).toEqual([]);
		expect(Object.isFrozen(supportTaskRegistrations())).toBe(true);
	});

	it("installs host-process registrations by name, sorted and removable", () => {
		const removeAbsent = registerSupportTask(absent.registration(shoutExecute));
		const removeShout = registerSupportTask(shout.registration(shoutExecute));
		try {
			// Sorted by name, so the constructed registry never depends on the
			// order registrations were installed in.
			expect(supportTaskRegistrations().map((entry) => entry.name)).toEqual([
				absent.implementation,
				shout.implementation,
			]);
			expect(() =>
				registerSupportTask(shout.registration(shoutExecute)),
			).toThrow(
				`Duplicate support task implementation: ${shout.implementation}`,
			);
		} finally {
			removeShout();
			removeAbsent();
		}
		expect(supportTaskRegistrations()).toEqual([]);
		// Removal is idempotent and never drops a later registration of the
		// same name.
		removeShout();
		const reinstalled = registerSupportTask(shout.registration(shoutExecute));
		removeShout();
		expect(supportTaskRegistrations()).toHaveLength(1);
		reinstalled();
		expect(supportTaskRegistrations()).toEqual([]);
	});

	it("refuses a registration that cannot run or whose identity is invalid", () => {
		expect(() =>
			registerSupportTask({
				...shout.registration(shoutExecute),
				execute: undefined as never,
			}),
		).toThrow("Support task implementation is not executable.");
		expect(() =>
			registerSupportTask({
				...shout.registration(shoutExecute),
				implementationSha256: "not-a-digest",
			}),
		).toThrow("invalid support task implementation identity");
		expect(supportTaskRegistrations()).toEqual([]);
	});

	it("passes the registrations to the service the extension constructs", async () => {
		const remove = registerSupportTask(shout.registration(shoutExecute));
		try {
			const cwd = await project("wired", "shout");
			await runThroughExtension(cwd, "wired");
			expect(constructed).toHaveLength(1);
			expect(constructed[0]?.supportTasks?.map((entry) => entry.name)).toEqual([
				shout.implementation,
			]);
		} finally {
			remove();
		}
	});

	it("resolves and runs a registered helper end to end through the extension", async () => {
		const execute = vi.fn(shoutExecute);
		const remove = registerSupportTask(shout.registration(execute));
		try {
			const cwd = await project("resolves", "shout");
			const { runId, view } = await runThroughExtension(cwd, "resolves");
			expect(view).toMatchObject({
				status: "completed",
				output: { answer: "WIRED" },
			});
			expect(execute).toHaveBeenCalledTimes(1);
			const state = await stateOf(cwd, runId);
			expect(supportTerminal(state)).toMatchObject({ outcome: "completed" });
		} finally {
			remove();
		}
	});

	it("still fails an unregistered helper at support-resolution", async () => {
		// `shout` is registered only so the definition may import the module at
		// all; the declared helper is `absent`, which no registration provides.
		const remove = registerSupportTask(shout.registration(shoutExecute));
		try {
			const cwd = await project("unresolved", "absent");
			const { runId, view } = await runThroughExtension(cwd, "unresolved");
			expect(view).toMatchObject({ status: "failed" });
			const state = await stateOf(cwd, runId);
			expect(supportTerminal(state)).toMatchObject({
				outcome: "failed",
				evidence: {
					kind: "workflow",
					stage: "support-resolution",
					message: "Support task implementation is not registered.",
				},
			});
		} finally {
			remove();
		}
	});
});
