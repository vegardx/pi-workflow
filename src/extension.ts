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
import { WORKFLOW_TOOL_DECLARATIONS, workflowToolText } from "./tools.js";

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
	// the result `details`, and the text block is the same value, checked
	// against the declared output schema and bounded for the model context.
	// The tool layer forwards parameters and lets service errors propagate;
	// `availableActions` in the views is the only legality signal it exposes.
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
					content: [
						{
							type: "text" as const,
							text: workflowToolText(declaration, value),
						},
					],
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

	pi.registerCommand("workflow-runs", {
		description: "List durable workflow runs",
		handler: async (_args, ctx) => {
			const page = await (await getService(ctx)).listRuns({ limit: 20 });
			ctx.ui.notify(
				page.runs.length === 0
					? "No workflow runs found"
					: page.runs
							.map(
								(run) =>
									`${run.runId} ${run.status} (${run.ownership}) [${run.availableActions.join(", ")}]`,
							)
							.join("\n"),
				"info",
			);
		},
	});
}
