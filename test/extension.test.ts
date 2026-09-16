import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	createEventBus,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { SubagentService } from "@vegardx/pi-subagent";
import { registerSubagentServiceProvider } from "@vegardx/pi-subagent/service-provider";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import workflowExtension from "../src/extension.js";
import { WORKFLOW_TOOL_DECLARATIONS } from "../src/tools.js";

type Handler = (...args: unknown[]) => unknown;
type Command = {
	description?: string;
	getArgumentCompletions?: (prefix: string) => unknown;
	handler: (args: string, ctx: unknown) => Promise<void>;
};

/**
 * A shared pi-subagent service that never launches anything: checkpoint-only
 * workflows bind an owner client and then never call it.
 */
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

function capture(options: { subagents?: boolean } = {}) {
	const tools: ToolDefinition[] = [];
	const commands = new Map<string, Command>();
	const shortcuts: string[] = [];
	const handlers = new Map<string, Handler>();
	let events: ExtensionAPI["events"];
	if (options.subagents) {
		events = createEventBus();
		registerSubagentServiceProvider(events, async () => idleSubagentService());
	} else {
		events = {
			on: vi.fn(),
			emit: vi.fn(),
		} as unknown as ExtensionAPI["events"];
	}
	const api = {
		events,
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
		registerCommand(name: string, command: Command) {
			commands.set(name, command);
		},
		registerShortcut(shortcut: string) {
			shortcuts.push(shortcut);
		},
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	workflowExtension(api);
	return { api, tools, commands, shortcuts, handlers };
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

function rendered(component: { render(width: number): string[] } | undefined) {
	return component?.render(200).map((line) => line.trimEnd());
}

async function emptyProject(): Promise<string> {
	const cwd = path.resolve(".pi", "test-extension", `empty-${randomUUID()}`);
	await mkdir(cwd, { recursive: true });
	return cwd;
}

describe("workflow Pi extension", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("registers the tool table, the /workflow command, the alt+w shortcut, and session hooks", async () => {
		const { api, tools, commands, shortcuts, handlers } = capture();
		expect(tools.map((tool) => tool.name)).toEqual(
			WORKFLOW_TOOL_DECLARATIONS.map((tool) => tool.name),
		);
		// Checkpoint decisions and source approvals are human-only commands.
		expect(WORKFLOW_TOOL_DECLARATIONS).toHaveLength(14);
		expect(
			tools.filter((tool) => /decide|approve|reject|proposals/.test(tool.name)),
		).toEqual([]);
		expect(tools.map((tool) => tool.name)).toEqual([
			"workflow_list",
			"workflow_validate",
			"workflow_run",
			"workflow_status",
			"workflow_wait",
			"workflow_stop",
			"workflow_reconcile",
			"workflow_runs",
			"workflow_inspect",
			"workflow_logs",
			"workflow_invalidate",
			"workflow_retry",
			"workflow_resume",
			"workflow_propose",
		]);
		for (const tool of tools) {
			const declaration = WORKFLOW_TOOL_DECLARATIONS.find(
				(candidate) => candidate.name === tool.name,
			);
			expect(tool.parameters).toBe(declaration?.parameters);
			expect(tool.label).toBe(declaration?.label);
			expect(tool.description).toBe(declaration?.description);
			expect(typeof tool.renderCall).toBe("function");
			expect(typeof tool.renderResult).toBe("function");
		}
		expect(
			tools.find((tool) => tool.name === "workflow_list")?.promptSnippet,
		).toBe("List trusted durable workflows");
		expect(
			tools.find((tool) => tool.name === "workflow_run")?.promptSnippet,
		).toBeUndefined();
		expect([...commands.keys()]).toEqual(["workflow"]);
		expect(commands.get("workflow")?.description).toBe(
			"List, run, inspect, and control durable workflows",
		);
		expect(shortcuts).toEqual(["alt+w"]);
		expect([...handlers.keys()]).toEqual(["session_start", "session_shutdown"]);
		expect(
			tools.find((tool) => tool.name === "workflow_run")?.description,
		).toContain("run ID immediately");
		expect(
			tools.find((tool) => tool.name === "workflow_stop")?.description,
		).toContain("Persist stop intent");
		const reconcile = tools.find((tool) => tool.name === "workflow_reconcile");
		if (!reconcile) throw new Error("workflow_reconcile missing");
		const runId = "workflow_reconcileparams";
		expect(Value.Check(reconcile.parameters, { runId })).toBe(true);
		expect(
			Value.Check(reconcile.parameters, { runId, taskId: "task_abcdef" }),
		).toBe(true);
		expect(Value.Check(reconcile.parameters, { runId, taskId: "bad" })).toBe(
			false,
		);
		expect(Value.Check(reconcile.parameters, { runId, extra: true })).toBe(
			false,
		);
		expect(Value.Check(reconcile.parameters, { taskId: "task_abcdef" })).toBe(
			false,
		);
		await handlers.get("session_shutdown")?.({}, {});
		expect(api.events.on).not.toHaveBeenCalled();
	});

	it("renders one-line calls and collapsed results from the declaration table", () => {
		const { tools } = capture();
		const tool = (name: string) => {
			const found = tools.find((candidate) => candidate.name === name);
			if (!found) throw new Error(`${name} missing`);
			return found;
		};
		expect(
			rendered(
				tool("workflow_wait").renderCall?.(
					{ runId: "workflow_abc123", timeoutMs: 5000 },
					theme,
					{} as never,
				),
			),
		).toEqual(["workflow_wait workflow_abc123 · 5000 ms"]);
		expect(
			rendered(tool("workflow_list").renderCall?.({}, theme, {} as never)),
		).toEqual(["workflow_list"]);
		expect(
			rendered(
				tool("workflow_runs").renderCall?.(
					{ statuses: ["running", "failed"], includeChildren: true },
					theme,
					{} as never,
				),
			),
		).toEqual(["workflow_runs running,failed · children"]);
		const view = { runId: "workflow_abc123", status: "running" };
		expect(
			rendered(
				tool("workflow_status").renderResult?.(
					{
						content: [{ type: "text", text: JSON.stringify(view, null, 2) }],
						details: view,
					},
					{ expanded: false, isPartial: false },
					theme,
					{} as never,
				),
			),
		).toEqual(["", "workflow_abc123 running"]);
		expect(
			rendered(
				tool("workflow_status").renderResult?.(
					{
						content: [{ type: "text", text: "line one\nline two" }],
						details: view,
					},
					{ expanded: true, isPartial: false },
					theme,
					{} as never,
				),
			),
		).toEqual(["", "line one", "line two"]);
		expect(
			rendered(
				tool("workflow_logs").renderResult?.(
					{
						content: [{ type: "text", text: "{}" }],
						details: { runId: "workflow_x", entries: [{}], lastSequence: 7 },
					},
					{ expanded: false, isPartial: false },
					theme,
					{} as never,
				),
			),
		).toEqual(["", "1 entry · seq 7"]);
		expect(
			rendered(
				tool("workflow_list").renderResult?.(
					{ content: [{ type: "text", text: "[]" }], details: [] },
					{ expanded: false, isPartial: false },
					theme,
					{} as never,
				),
			),
		).toEqual(["", "0 workflow(s)"]);
	});

	it("wraps rendered tool text with pi-tui only after a TUI session loaded it", async () => {
		const { tools, handlers } = capture();
		const runs = tools.find((tool) => tool.name === "workflow_runs");
		if (!runs) throw new Error("workflow_runs missing");
		const call = () =>
			runs.renderCall?.(
				{ statuses: ["running", "failed"], includeChildren: true },
				theme,
				{} as never,
			);
		// Outside the TUI nothing from pi-tui is loaded: lines pass through.
		expect(call()?.render(12)).toEqual([
			"workflow_runs running,failed · children",
		]);
		const context = {
			cwd: await emptyProject(),
			mode: "tui",
			hasUI: true,
			isProjectTrusted: () => true,
			ui: { notify: vi.fn(), setWidget: vi.fn() },
		};
		try {
			await handlers.get("session_start")?.({ reason: "startup" }, context);
			// pi-tui's Text wraps to the viewport width.
			const wrapped = call()?.render(12) ?? [];
			expect(wrapped.length).toBeGreaterThan(1);
			expect(wrapped.every((line) => line.length <= 12)).toBe(true);
			expect(wrapped.join("").replace(/\s+/g, "")).toBe(
				"workflow_runsrunning,failed·children",
			);
		} finally {
			await handlers.get("session_shutdown")?.({ reason: "quit" }, context);
		}
	});

	it("starts the service lazily from tool context and drains on shutdown", async () => {
		const { tools, handlers } = capture();
		const cwd = await emptyProject();
		const context = {
			cwd,
			isProjectTrusted: () => true,
			ui: { notify: vi.fn() },
		};
		const list = tools.find((tool) => tool.name === "workflow_list");
		if (!list) throw new Error("workflow_list missing");
		await expect(
			list.execute(
				"call-1",
				{},
				new AbortController().signal,
				undefined,
				context as never,
			),
		).resolves.toEqual({
			content: [{ type: "text", text: "[]" }],
			details: [],
		});
		await handlers.get("session_shutdown")?.({}, context);
	});

	it("keeps the widget out of non-TUI sessions", async () => {
		const { handlers } = capture();
		const setWidget = vi.fn();
		const context = {
			cwd: await emptyProject(),
			mode: "rpc",
			isProjectTrusted: () => true,
			ui: { notify: vi.fn(), setWidget },
		};
		await handlers.get("session_start")?.({ reason: "startup" }, context);
		expect(setWidget).not.toHaveBeenCalled();
		await handlers.get("session_shutdown")?.({ reason: "quit" }, context);
		expect(setWidget).not.toHaveBeenCalled();
	});

	it("registers a hidden widget on an idle TUI session and clears it on shutdown", async () => {
		const { handlers } = capture();
		const setWidget = vi.fn();
		const context = {
			cwd: await emptyProject(),
			mode: "tui",
			hasUI: true,
			isProjectTrusted: () => true,
			ui: { notify: vi.fn(), setWidget },
		};
		await handlers.get("session_start")?.({ reason: "startup" }, context);
		expect(setWidget).toHaveBeenCalledTimes(1);
		expect(setWidget).toHaveBeenCalledWith("pi-workflow", undefined, {
			placement: "belowEditor",
		});
		await handlers.get("session_shutdown")?.({ reason: "quit" }, context);
		// The controller hides on stop, then the hook clears the key itself.
		expect(setWidget.mock.calls.at(-1)).toEqual(["pi-workflow", undefined]);
		expect(setWidget.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("routes /workflow output through operatorOutput and never rethrows", async () => {
		const { commands, handlers } = capture();
		const command = commands.get("workflow");
		if (!command) throw new Error("/workflow missing");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const notify = vi.fn();
		const cwd = await emptyProject();
		const print = {
			cwd,
			mode: "print",
			hasUI: false,
			isProjectTrusted: () => true,
			ui: { notify },
		};
		await command.handler("list", print);
		expect(log).toHaveBeenCalledWith("No workflows found");
		expect(notify).not.toHaveBeenCalled();

		const rpc = { ...print, mode: "rpc" };
		await command.handler("bogus", rpc);
		expect(notify).toHaveBeenLastCalledWith(
			expect.stringMatching(
				/^Unknown workflow command: bogus\. Expected one of list, runs, validate, run, approve, reject, show, status, logs, wait, stop, reconcile, invalidate, retry, resume, decide\.$/,
			),
			"warning",
		);
		await command.handler("stop", rpc);
		expect(notify).toHaveBeenLastCalledWith(
			"Run prefix required for stop.",
			"warning",
		);
		await command.handler("stop workflow_missing", rpc);
		expect(notify).toHaveBeenLastCalledWith(
			"Run not found: workflow_missing",
			"warning",
		);
		await command.handler("run example", rpc);
		expect(notify).toHaveBeenLastCalledWith(
			"Usage: /workflow run <ref> <json-input>",
			"warning",
		);
		await command.handler("validate missing-workflow", rpc);
		expect(notify.mock.calls.at(-1)?.[1]).toBe("error");
		await expect(command.getArgumentCompletions?.("sh")).resolves.toEqual([
			{ value: "show", label: "show" },
		]);
		await expect(command.getArgumentCompletions?.("show ")).resolves.toBeNull();
		await expect(command.getArgumentCompletions?.("approve ")).resolves.toEqual(
			[{ value: "approve dynamic:", label: "dynamic:" }],
		);
		await handlers.get("session_shutdown")?.({ reason: "quit" }, rpc);
	});

	it("refuses decide, approve, and reject without a dialog-capable session", async () => {
		const { commands, handlers } = capture();
		const command = commands.get("workflow");
		if (!command) throw new Error("/workflow missing");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const notify = vi.fn();
		const confirm = vi.fn(async () => true);
		const cwd = await emptyProject();
		const print = {
			cwd,
			mode: "print",
			hasUI: false,
			isProjectTrusted: () => true,
			ui: { notify, confirm },
		};
		const ref = `dynamic:${"a".repeat(64)}`;
		await command.handler(`approve ${ref}`, print);
		expect(log).toHaveBeenLastCalledWith(
			"Dynamic workflow approval requires an interactive Pi session.",
		);
		await command.handler(`reject ${ref} unsafe`, print);
		expect(log).toHaveBeenLastCalledWith(
			"Dynamic workflow approval requires an interactive Pi session.",
		);
		// Grammar errors come first and name the usage.
		await command.handler("approve nope", print);
		expect(log).toHaveBeenLastCalledWith(
			"Dynamic workflow reference must be dynamic:<64 hex characters>.",
		);
		await command.handler("decide workflow_ab approve {bad", print);
		expect(log).toHaveBeenLastCalledWith(
			"Checkpoint decision is not valid JSON.",
		);
		expect(confirm).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
		await handlers.get("session_shutdown")?.({ reason: "quit" }, print);
	});

	it("records source decisions only after an explicit confirm with the session approver", async () => {
		const { tools, commands, handlers } = capture();
		const command = commands.get("workflow");
		if (!command) throw new Error("/workflow missing");
		const propose = tools.find((tool) => tool.name === "workflow_propose");
		if (!propose) throw new Error("workflow_propose missing");
		const notify = vi.fn();
		const confirm = vi.fn<(title: string, body: string) => Promise<boolean>>();
		const cwd = await emptyProject();
		const context = {
			cwd,
			mode: "tui",
			hasUI: true,
			isProjectTrusted: () => true,
			ui: { notify, confirm, setWidget: vi.fn() },
			sessionManager: { getSessionId: () => "session-7" },
		};
		try {
			const source = `import { defineWorkflow } from "@vegardx/pi-workflow";

export default defineWorkflow({
	meta: { name: "ui-approve", description: "Approval fixture", version: 1, budget: { cost: 10, childRuntimeMs: 600000 }, timeoutMs: 600000, concurrency: 1 },
	inputSchema: { type: "object", properties: {}, additionalProperties: false },
	outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
	async run(ctx) {
		ctx.phase("answer");
		return { answer: "fixed" };
	},
});
`;
			const proposed = await propose.execute(
				"call-1",
				{ source },
				new AbortController().signal,
				undefined,
				context as never,
			);
			const { ref } = proposed.details as { ref: string };
			expect(ref).toMatch(/^dynamic:[a-f0-9]{64}$/);

			// Cancelled: rendered, asked, nothing recorded.
			confirm.mockResolvedValueOnce(false);
			await command.handler(`approve ${ref}`, context);
			expect(confirm).toHaveBeenCalledTimes(1);
			const [title, body] = confirm.mock.calls[0] ?? [];
			expect(title).toBe(`Approve dynamic workflow ${ref.slice(8, 20)}…?`);
			expect(body).toContain(`Dynamic workflow ${ref}`);
			expect(body).toContain("name: ui-approve v1");
			expect(body).toContain("decision: none (awaiting a human decision)");
			expect(body).toContain("   1 │ import { defineWorkflow }");
			expect(notify).toHaveBeenLastCalledWith("No decision recorded.", "info");
			await expect(
				command.getArgumentCompletions?.("approve dyn"),
			).resolves.toEqual([{ value: `approve ${ref}`, label: ref }]);

			// Confirmed: recorded with the session id, never an argument.
			confirm.mockResolvedValueOnce(true);
			await command.handler(`approve ${ref} sessionId: mallory`, context);
			expect(notify).toHaveBeenLastCalledWith(
				`Approved ${ref}. Run it with workflow_run or /workflow run ${ref}.`,
				"info",
			);
			await expect(
				command.getArgumentCompletions?.("approve dyn"),
			).resolves.toEqual([{ value: "approve dynamic:", label: "dynamic:" }]);
			const inspect = tools.find((tool) => tool.name === "workflow_validate");
			if (!inspect) throw new Error("workflow_validate missing");
			await expect(
				inspect.execute(
					"call-2",
					{ ref, input: {} },
					new AbortController().signal,
					undefined,
					context as never,
				),
			).resolves.toMatchObject({
				details: { workflow: { name: "ui-approve" } },
			});

			// Decided: refused from the view before any confirm.
			await command.handler(`reject ${ref}`, context);
			expect(confirm).toHaveBeenCalledTimes(2);
			expect(notify).toHaveBeenLastCalledWith(
				`reject is unavailable: ${ref} is already approved.`,
				"warning",
			);
			// Unknown digest: the service refusal is surfaced verbatim.
			const missing = `dynamic:${"0".repeat(64)}`;
			await command.handler(`approve ${missing}`, context);
			expect(notify).toHaveBeenLastCalledWith(
				`Dynamic workflow proposal not found: ${missing}`,
				"error",
			);
			expect(confirm).toHaveBeenCalledTimes(2);
		} finally {
			await handlers.get("session_shutdown")?.({ reason: "quit" }, context);
		}
	});

	it("decides a parked checkpoint only after an explicit confirm and records the session approver", async () => {
		const { tools, commands, handlers } = capture({ subagents: true });
		const command = commands.get("workflow");
		if (!command) throw new Error("/workflow missing");
		const tool = (name: string) => {
			const found = tools.find((candidate) => candidate.name === name);
			if (!found) throw new Error(`${name} missing`);
			return found;
		};
		const notify = vi.fn();
		const confirm = vi.fn<(title: string, body: string) => Promise<boolean>>();
		const cwd = await emptyProject();
		await mkdir(path.join(cwd, "workflows"), { recursive: true });
		await writeFile(
			path.join(cwd, "workflows", "ui-decide.workflow.ts"),
			`export default {
  schema: "pi-workflow-definition",
  meta: { name: "ui-decide", description: "Checkpoint workflow", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 600000, concurrency: 1 },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  async run(ctx) {
    ctx.phase("review");
    const approve = ctx.checkpoint("approve", { schema: { type: "object", properties: { proceed: { type: "boolean" } }, required: ["proceed"], additionalProperties: false }, prompt: "Approve the plan?", headless: "block", timeoutMs: 60000 });
    const decision = await ctx.result(approve);
    return { answer: decision.proceed ? "approved" : "declined" };
  }
};
`,
		);
		const context = {
			cwd,
			mode: "tui",
			hasUI: true,
			isProjectTrusted: () => true,
			ui: { notify, confirm, setWidget: vi.fn() },
			sessionManager: { getSessionId: () => "session-7" },
		};
		const signal = new AbortController().signal;
		try {
			const started = await tool("workflow_run").execute(
				"call-1",
				{ ref: "ui-decide", input: {} },
				signal,
				undefined,
				context as never,
			);
			const { runId } = started.details as { runId: string };
			const parked = await tool("workflow_wait").execute(
				"call-2",
				{ runId },
				signal,
				undefined,
				context as never,
			);
			expect(parked.details).toMatchObject({ status: "waiting", parked: true });

			// Print mode never records a decision, even for a legal one.
			const print = { ...context, mode: "print", hasUI: false };
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			await command.handler(
				`decide ${runId} approve '{"proceed": true}'`,
				print,
			);
			expect(log).toHaveBeenLastCalledWith(
				"Checkpoint decisions require an interactive Pi session.",
			);
			expect(confirm).not.toHaveBeenCalled();

			// Cancelled: the prompt and the parsed decision were shown; nothing recorded.
			confirm.mockResolvedValueOnce(false);
			await command.handler(
				`decide ${runId.slice(0, 14)} approve '{"proceed": true}' Reviewed the plan`,
				context,
			);
			expect(confirm).toHaveBeenCalledTimes(1);
			expect(confirm.mock.calls[0]).toEqual([
				`decide ${runId.slice(0, 12)}…?`,
				'Checkpoint approve: Approve the plan?\nDecision: {"proceed":true}\nThe decision is recorded once, immutably, and the run continues from it.',
			]);
			expect(notify).not.toHaveBeenCalled();
			const still = await tool("workflow_wait").execute(
				"call-3",
				{ runId },
				signal,
				undefined,
				context as never,
			);
			expect(still.details).toMatchObject({ status: "waiting", parked: true });

			// A missing task and a non-checkpoint refusal are surfaced verbatim.
			await command.handler(`decide ${runId} nope true`, context);
			expect(notify).toHaveBeenLastCalledWith(
				"Task not found: nope",
				"warning",
			);

			// Confirmed: recorded under the session approver, never an argument.
			confirm.mockResolvedValueOnce(true);
			await command.handler(
				`decide ${runId} approve '{"proceed": true}' approver: mallory`,
				context,
			);
			expect(notify.mock.calls.at(-1)?.[0]).toMatch(
				new RegExp(
					`^decide accepted for ${runId}: approve decided; run is (waiting|running|finalizing|completed)\\.$`,
				),
			);
			expect(notify.mock.calls.at(-1)?.[1]).toBe("info");
			const final = await tool("workflow_wait").execute(
				"call-4",
				{ runId },
				signal,
				undefined,
				context as never,
			);
			const view = final.details as {
				status: string;
				output?: unknown;
				tasks?: { key: string; checkpoint?: { decision?: unknown } }[];
			};
			expect(view).toMatchObject({
				status: "completed",
				output: { answer: "approved" },
			});
			expect(
				view.tasks?.find((entry) => entry.key === "approve")?.checkpoint
					?.decision,
			).toMatchObject({
				source: "operator",
				decidedBy: "pi-session",
				reason: "approver: mallory",
				value: { proceed: true },
			});
			// A completed run no longer offers decide.
			await command.handler(`decide ${runId} approve true`, context);
			expect(notify).toHaveBeenLastCalledWith(
				"decide is unavailable while the run is completed.",
				"warning",
			);
			expect(confirm).toHaveBeenCalledTimes(2);
		} finally {
			await handlers.get("session_shutdown")?.({ reason: "quit" }, context);
		}
	});
});
