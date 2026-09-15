import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
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

function capture() {
	const tools: ToolDefinition[] = [];
	const commands = new Map<string, Command>();
	const shortcuts: string[] = [];
	const handlers = new Map<string, Handler>();
	const api = {
		events: { on: vi.fn(), emit: vi.fn() },
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
				/^Unknown workflow command: bogus\. Expected one of list, runs, validate, run, show, status, logs, wait, stop, reconcile, invalidate/,
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
		expect(command.getArgumentCompletions?.("sh")).toEqual([
			{ value: "show", label: "show" },
		]);
		expect(command.getArgumentCompletions?.("show ")).toBeNull();
		await handlers.get("session_shutdown")?.({ reason: "quit" }, rpc);
	});
});
