import path from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	createWorkflowService,
	type WorkflowService,
	type WorkflowServiceRunView,
} from "./service.js";
import { createWorkflowSubagentProvider } from "./subagent-provider.js";
import { WORKFLOW_TOOL_DECLARATIONS } from "./tools.js";

const MAX_TOOL_OUTPUT_BYTES = 48 * 1024;

function text(value: unknown): string {
	const serialized = JSON.stringify(value, null, 2);
	if (Buffer.byteLength(serialized) <= MAX_TOOL_OUTPUT_BYTES) return serialized;
	if (Array.isArray(value)) {
		const bounded: unknown[] = [];
		for (const entry of value) {
			const candidate = [
				...bounded,
				entry,
				{ truncated: true, totalItems: value.length },
			];
			if (
				Buffer.byteLength(JSON.stringify(candidate, null, 2)) >
				MAX_TOOL_OUTPUT_BYTES
			) {
				break;
			}
			bounded.push(entry);
		}
		bounded.push({ truncated: true, totalItems: value.length });
		return JSON.stringify(bounded, null, 2);
	}
	if (typeof value === "object" && value !== null && "output" in value) {
		const bounded = { ...value, output: undefined };
		return `${JSON.stringify(bounded, null, 2)}\n\n[Workflow output omitted from tool context because it exceeds ${MAX_TOOL_OUTPUT_BYTES} bytes. Use the durable output artifact.]`;
	}
	throw new Error("workflow tool output exceeds context limit");
}

export default function workflowExtension(pi: ExtensionAPI): void {
	let service: WorkflowService | undefined;
	let serviceCwd: string | undefined;

	async function getService(ctx: ExtensionContext): Promise<WorkflowService> {
		if (service && serviceCwd === ctx.cwd) return service;
		if (service) await service.shutdown();
		serviceCwd = ctx.cwd;
		service = await createWorkflowService({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			storeRoot: path.join(ctx.cwd, CONFIG_DIR_NAME, "workflow"),
			projectTrusted: () => ctx.isProjectTrusted(),
			subagents: createWorkflowSubagentProvider(pi.events, ctx),
		});
		return service;
	}

	pi.on("session_shutdown", async () => {
		const active = service;
		service = undefined;
		serviceCwd = undefined;
		await active?.shutdown();
	});

	// Every tool comes from the declaration table: the typed service value is
	// the result `details`, and the text block is the same value as bounded
	// JSON for the model context.
	for (const declaration of WORKFLOW_TOOL_DECLARATIONS) {
		pi.registerTool({
			name: declaration.name,
			label: declaration.label,
			description: declaration.description,
			...(declaration.promptSnippet === undefined
				? {}
				: { promptSnippet: declaration.promptSnippet }),
			...(declaration.promptGuidelines.length === 0
				? {}
				: { promptGuidelines: [...declaration.promptGuidelines] }),
			parameters: declaration.parameters,
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const value = await declaration.execute(await getService(ctx), params);
				return {
					content: [{ type: "text" as const, text: text(value) }],
					details: value,
				};
			},
		});
	}

	pi.registerCommand("workflows", {
		description: "List trusted static workflows",
		handler: async (_args, ctx) => {
			const workflows = await (await getService(ctx)).list();
			ctx.ui.notify(
				workflows.length === 0
					? "No workflows found"
					: workflows.map((workflow) => workflow.name).join(", "),
				"info",
			);
		},
	});

	pi.registerCommand("workflow-status", {
		description: "Show durable workflow status",
		handler: async (args, ctx) => {
			const runId = args.trim();
			if (!runId) {
				ctx.ui.notify("Usage: /workflow-status <run-id>", "warning");
				return;
			}
			const view: WorkflowServiceRunView = await (await getService(ctx)).status(
				runId,
			);
			ctx.ui.notify(`${view.runId}: ${view.status}`, "info");
		},
	});
}
