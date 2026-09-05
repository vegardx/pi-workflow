import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import workflowExtension from "../src/extension.js";

describe("workflow Pi extension", () => {
	it("registers bounded workflow tools and lazy lifecycle cleanup", async () => {
		const tools: ToolDefinition[] = [];
		const commands: string[] = [];
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		const api = {
			events: { on: vi.fn(), emit: vi.fn() },
			registerTool(tool: ToolDefinition) {
				tools.push(tool);
			},
			registerCommand(name: string) {
				commands.push(name);
			},
			on(event: string, handler: (...args: unknown[]) => unknown) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;

		workflowExtension(api);
		expect(tools.map((tool) => tool.name)).toEqual([
			"workflow_list",
			"workflow_validate",
			"workflow_run",
			"workflow_status",
			"workflow_wait",
			"workflow_stop",
			"workflow_reconcile",
		]);
		expect(commands).toEqual(["workflows", "workflow-status"]);
		expect([...handlers.keys()]).toEqual(["session_shutdown"]);
		expect(
			tools.find((tool) => tool.name === "workflow_run")?.description,
		).toContain("run ID immediately");
		expect(
			tools.find((tool) => tool.name === "workflow_stop")?.description,
		).toContain("Persist stop intent");
		await handlers.get("session_shutdown")?.({}, {});
		expect(api.events.on).not.toHaveBeenCalled();
	});

	it("starts the service lazily from tool context and drains on shutdown", async () => {
		const tools: ToolDefinition[] = [];
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		const api = {
			events: { on: vi.fn(), emit: vi.fn() },
			registerTool(tool: ToolDefinition) {
				tools.push(tool);
			},
			registerCommand() {},
			on(event: string, handler: (...args: unknown[]) => unknown) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		workflowExtension(api);
		const cwd = path.resolve(".pi", "test-extension", `empty-${randomUUID()}`);
		await mkdir(cwd, { recursive: true });
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
		).resolves.toMatchObject({
			content: [{ type: "text" }],
		});
		await handlers.get("session_shutdown")?.({}, context);
	});
});
