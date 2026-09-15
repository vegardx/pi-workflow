import path from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { WorkflowRunId } from "./contracts.js";
import { createWorkflowService, type WorkflowService } from "./service.js";
import type {
	WorkflowRunSummary,
	WorkflowServiceTaskView,
} from "./service-views.js";
import { createWorkflowSubagentProvider } from "./subagent-provider.js";
import { WORKFLOW_TOOL_DECLARATIONS, workflowToolText } from "./tools.js";
import {
	ACTION_CONSEQUENCES,
	type ActionRequest,
	actionUnavailableMessage,
	CONFIRMED_ACTIONS,
	collectLogTail,
	type InvalidationPreviewLike,
	invalidateConsequence,
	type OperatorAction,
	type ParsedWorkflowCommand,
	parseWorkflowCommand,
	parseWorkflowInput,
	performRunAction,
	previewInvalidationIfAvailable,
	resolveRunPrefix,
	resolveTaskKey,
	WORKFLOW_COMMAND,
	WorkflowCommandError,
	workflowArgumentCompletions,
} from "./ui/commands.js";
import { logLine, shortId, taskPath } from "./ui/format.js";
import type { InspectorIntent, InspectorState } from "./ui/inspector.js";
import {
	createWidgetController,
	type WidgetController,
	WORKFLOW_WIDGET_KEY,
	WORKFLOW_WIDGET_SHORTCUT,
} from "./ui/widget.js";

type InspectorInitialState = Partial<InspectorState>;

type RunActionCommand = Extract<
	ParsedWorkflowCommand,
	{ kind: "wait" | "stop" | "reconcile" | "invalidate" | "retry" | "resume" }
>;

/**
 * The inspector is TUI-only and loaded on first use so print/rpc/json
 * sessions never pull in the interactive component.
 */
function loadInspector() {
	return import("./ui/inspector.js");
}

function operatorOutput(
	ctx: ExtensionContext,
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	if (ctx.mode === "print") console.log(message);
	else ctx.ui.notify(message, level);
}

function consequenceFor(
	action: OperatorAction,
	task: WorkflowServiceTaskView | undefined,
	preview: InvalidationPreviewLike | undefined,
): string {
	switch (action) {
		case "invalidate":
			return invalidateConsequence(task ? taskPath(task) : "The task", preview);
		case "stop":
		case "retry":
		case "resume":
			return ACTION_CONSEQUENCES[action];
		default:
			return "";
	}
}

export default function workflowExtension(pi: ExtensionAPI): void {
	let service: WorkflowService | undefined;
	let serviceCwd: string | undefined;
	let widget: WidgetController | undefined;

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

	// The widget lives only in the TUI. `session_start` fires again on reload,
	// new, resume, and fork, so the previous controller is stopped first.
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		widget?.stop();
		widget = undefined;
		try {
			const runtime = await getService(ctx);
			const controller = createWidgetController({
				service: runtime,
				setWidget: (lines) =>
					ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, lines, {
						placement: "belowEditor",
					}),
			});
			widget = controller;
			await controller.start();
		} catch {
			ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, undefined);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		widget?.stop();
		widget = undefined;
		if (ctx?.mode === "tui") ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, undefined);
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
			renderCall(args, theme) {
				return new Text(
					`${theme.fg("toolTitle", theme.bold(declaration.name))} ${theme.fg(
						"muted",
						declaration.summarizeCall(args),
					)}`.trimEnd(),
					0,
					0,
				);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				const text = result.content.find((item) => item.type === "text");
				const content = text?.type === "text" ? text.text : "";
				const display = expanded
					? content
					: declaration.summarizeResult(result.details as never);
				return new Text(
					`\n${theme.fg(isPartial ? "warning" : "success", display)}`,
					0,
					0,
				);
			},
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

	async function inspector(
		ctx: ExtensionContext,
		initialState: InspectorInitialState = {},
	): Promise<void> {
		const runtime = await getService(ctx);
		const { detailText, runsText, showWorkflowInspector } =
			await loadInspector();
		if (ctx.mode !== "tui") {
			const runId = initialState.runStack?.at(-1);
			if (initialState.view === "detail" && runId) {
				operatorOutput(ctx, detailText(await runtime.inspect(runId)));
				return;
			}
			operatorOutput(
				ctx,
				runsText(
					await runtime.listRuns({
						...(initialState.includeChildren ? { includeChildren: true } : {}),
						limit: 20,
					}),
				),
			);
			return;
		}
		// The inspector resolves with an intent and its state; actions are
		// performed here and the inspector reopens where the operator left it.
		let state: InspectorInitialState = initialState;
		for (;;) {
			const intent: InspectorIntent = await showWorkflowInspector(
				ctx,
				runtime,
				{ initialState: state },
			);
			state = intent.state;
			if (intent.type === "close") return;
			try {
				const outcome = await performRunAction(runtime, intent.request);
				ctx.ui.notify(outcome.message, outcome.level);
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		}
	}

	async function resolveTask(
		runtime: WorkflowService,
		runId: WorkflowRunId,
		taskKey: string,
	): Promise<WorkflowServiceTaskView> {
		const inspection = await runtime.inspect(runId, { include: ["tasks"] });
		return resolveTaskKey(inspection.tasks ?? [], taskKey);
	}

	async function runAction(
		ctx: ExtensionContext,
		runtime: WorkflowService,
		parsed: RunActionCommand,
	): Promise<void> {
		const action: OperatorAction = parsed.kind;
		const run: WorkflowRunSummary = await resolveRunPrefix(
			runtime,
			parsed.runPrefix,
		);
		// Legality is the service's `availableActions`; nothing is re-derived
		// here. `wait` on a run without it reports the status instead.
		if (action !== "wait" && !run.availableActions.includes(action)) {
			throw new WorkflowCommandError(actionUnavailableMessage(action, run));
		}
		const taskKey = "taskKey" in parsed ? parsed.taskKey : undefined;
		const task = taskKey
			? await resolveTask(runtime, run.runId, taskKey)
			: undefined;
		const preview =
			action === "invalidate" && task
				? await previewInvalidationIfAvailable(runtime, run.runId, task.id)
				: undefined;
		const request: ActionRequest = {
			action,
			run,
			...(task ? { taskId: task.id, taskKey: taskPath(task) } : {}),
			...("reason" in parsed && parsed.reason ? { reason: parsed.reason } : {}),
			...("timeoutMs" in parsed && parsed.timeoutMs
				? { timeoutMs: parsed.timeoutMs }
				: {}),
			...(preview ? { preview } : {}),
		};
		if (
			ctx.hasUI &&
			CONFIRMED_ACTIONS.has(action) &&
			!(await ctx.ui.confirm(
				`${action} ${shortId(run.runId)}?`,
				consequenceFor(action, task, preview),
			))
		) {
			return;
		}
		const outcome = await performRunAction(runtime, request);
		operatorOutput(ctx, outcome.message, outcome.level);
	}

	async function dispatch(args: string, ctx: ExtensionContext): Promise<void> {
		const parsed = parseWorkflowCommand(args);
		switch (parsed.kind) {
			case "inspector":
				return inspector(ctx);
			case "runs":
				return inspector(ctx, {
					view: "runs",
					includeChildren: parsed.includeChildren,
				});
			case "show": {
				const run = await resolveRunPrefix(
					await getService(ctx),
					parsed.runPrefix,
				);
				return inspector(ctx, { view: "detail", runStack: [run.runId] });
			}
		}
		const runtime = await getService(ctx);
		switch (parsed.kind) {
			case "list": {
				const workflows = await runtime.list();
				operatorOutput(
					ctx,
					workflows.length === 0
						? "No workflows found"
						: workflows
								.map(
									(workflow) =>
										`${workflow.name.padEnd(24)} v${workflow.version} ${workflow.scope.padEnd(8)} ${workflow.description}`,
								)
								.join("\n"),
				);
				return;
			}
			case "validate": {
				const { workflow } =
					parsed.input === undefined
						? await runtime.validate(parsed.ref)
						: await runtime.validate(parsed.ref, parsed.input);
				operatorOutput(
					ctx,
					`Valid: ${workflow.name} v${workflow.version} (${workflow.scope}, ${workflow.path})`,
				);
				return;
			}
			case "run": {
				let input = parsed.input;
				if (input === undefined) {
					if (ctx.mode !== "tui") {
						throw new WorkflowCommandError(
							"Usage: /workflow run <ref> <json-input>",
						);
					}
					const text = await ctx.ui.editor("Workflow input (JSON)", "{}");
					if (text === undefined) return;
					input = parseWorkflowInput(text);
				}
				const receipt = await runtime.run(parsed.ref, input);
				operatorOutput(
					ctx,
					`Started ${receipt.runId} (${receipt.status}). Use /workflow show ${shortId(receipt.runId)} to follow it.`,
				);
				return;
			}
			case "logs": {
				const run = await resolveRunPrefix(runtime, parsed.runPrefix);
				const page = await collectLogTail(runtime, run.runId, parsed.tail);
				operatorOutput(
					ctx,
					page.entries.length === 0
						? "No lifecycle entries."
						: page.entries.map(logLine).join("\n"),
				);
				return;
			}
			default:
				return runAction(ctx, runtime, parsed);
		}
	}

	pi.registerCommand(WORKFLOW_COMMAND, {
		description: "List, run, inspect, and control durable workflows",
		getArgumentCompletions: (prefix) =>
			workflowArgumentCompletions(
				prefix,
				widget?.lastPage?.runs.map((run) => run.runId) ?? [],
			),
		async handler(args, ctx) {
			try {
				await dispatch(args, ctx);
			} catch (error) {
				operatorOutput(
					ctx,
					error instanceof Error ? error.message : String(error),
					error instanceof WorkflowCommandError ? "warning" : "error",
				);
			}
		},
	});

	pi.registerShortcut(WORKFLOW_WIDGET_SHORTCUT, {
		description:
			"Open the workflow inspector without interrupting active input",
		handler: (ctx) => inspector(ctx),
	});
}
