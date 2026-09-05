import path from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	createWorkflowService,
	type WorkflowService,
	type WorkflowServiceRunView,
} from "./service.js";
import { createWorkflowSubagentProvider } from "./subagent-provider.js";

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

function result(value: unknown) {
	return {
		content: [{ type: "text" as const, text: text(value) }],
		details: {},
	};
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

	pi.registerTool({
		name: "workflow_list",
		label: "List Workflows",
		description:
			"List trusted static workflows available in the current project context.",
		promptSnippet: "List trusted durable workflows",
		promptGuidelines: [
			"Use workflow_list before workflow_run when the available workflow name is unknown.",
		],
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			return result(await (await getService(ctx)).list());
		},
	});

	pi.registerTool({
		name: "workflow_validate",
		label: "Validate Workflow",
		description:
			"Validate a trusted static workflow reference and optionally its JSON input without creating a run.",
		parameters: Type.Object(
			{
				ref: Type.String({ minLength: 1, maxLength: 4096 }),
				input: Type.Optional(Type.Unknown()),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const workflowService = await getService(ctx);
			return result(
				params.input === undefined
					? await workflowService.validate(params.ref)
					: await workflowService.validate(params.ref, params.input),
			);
		},
	});

	pi.registerTool({
		name: "workflow_run",
		label: "Run Workflow",
		description:
			"Start a trusted durable static workflow. Returns a run ID immediately; use workflow_wait or workflow_status to observe it.",
		parameters: Type.Object(
			{
				ref: Type.String({ minLength: 1, maxLength: 4096 }),
				input: Type.Unknown(),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return result(
				await (await getService(ctx)).run(params.ref, params.input),
			);
		},
	});

	const RunInput = Type.Object(
		{ runId: Type.String({ pattern: "^workflow_[a-z0-9]+$" }) },
		{ additionalProperties: false },
	);

	pi.registerTool({
		name: "workflow_status",
		label: "Workflow Status",
		description: "Read durable status for a workflow run.",
		parameters: RunInput,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return result(await (await getService(ctx)).status(params.runId));
		},
	});

	pi.registerTool({
		name: "workflow_wait",
		label: "Wait for Workflow",
		description:
			"Wait for an active workflow run and return its durable terminal status and bounded output.",
		parameters: RunInput,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return result(await (await getService(ctx)).wait(params.runId));
		},
	});

	pi.registerTool({
		name: "workflow_stop",
		label: "Stop Workflow",
		description:
			"Persist stop intent, interrupt active delegated work, and drain durable terminal evidence.",
		parameters: Type.Object(
			{
				runId: Type.String({ pattern: "^workflow_[a-z0-9]+$" }),
				reason: Type.String({ minLength: 1, maxLength: 4096 }),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return result(
				await (await getService(ctx)).stop(params.runId, params.reason),
			);
		},
	});

	pi.registerTool({
		name: "workflow_reconcile",
		label: "Reconcile Workflow",
		description:
			"Reopen and reconcile a durable workflow run after restart or interruption.",
		parameters: RunInput,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return result(await (await getService(ctx)).reconcile(params.runId));
		},
	});

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
