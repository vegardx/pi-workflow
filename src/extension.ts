import path from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { resolveDelegationCeiling } from "@vegardx/pi-subagent/ceiling-provider";
import type { WorkflowRunId, WorkflowTaskId } from "./contracts.js";
import type { DynamicSourceApprover } from "./dynamic/contracts.js";
import { workflowStateRoot } from "./persistence/state-root.js";
import type { WorkflowRoot } from "./registry.js";
import { createWorkflowService, type WorkflowService } from "./service.js";
import { registerWorkflowServiceProvider } from "./service-provider.js";
import type {
	WorkflowRunSummary,
	WorkflowServiceTaskView,
} from "./service-views.js";
import { createWorkflowSubagentProvider } from "./subagent-provider.js";
import { supportTaskRegistrations } from "./support-registry.js";
import { WORKFLOW_TOOL_DECLARATIONS, workflowToolText } from "./tools.js";
import {
	type CheckpointDecisionOutcome,
	collectCheckpointDecision,
} from "./ui/checkpoint-form.js";
import {
	ACTION_CONSEQUENCES,
	type ActionRequest,
	actionUnavailableMessage,
	CONFIRMED_ACTIONS,
	checkpointDecisionMode,
	collectLogTail,
	DEFAULT_DECIDE_APPROVER,
	decideConsequence,
	invalidateConsequence,
	type OperatorAction,
	type ParsedWorkflowCommand,
	PRUNE_CANCELLED_MESSAGE,
	parseWorkflowCommand,
	parseWorkflowInput,
	performRunAction,
	performSourceDecision,
	pruneConsequence,
	pruneReportText,
	resolveRunPrefix,
	resolveTaskKey,
	SOURCE_DECISION_CANCELLED_MESSAGE,
	SOURCE_DECISION_REQUIRES_UI_MESSAGE,
	type SourceDecisionKind,
	sourceDecisionUnavailableMessage,
	sourceDecisionVia,
	WORKFLOW_COMMAND,
	WorkflowCommandError,
	workflowArgumentCompletions,
} from "./ui/commands.js";
import {
	logLine,
	renderDynamicProposal,
	shortId,
	taskPath,
} from "./ui/format.js";
import type { InspectorIntent, InspectorState } from "./ui/inspector.js";
import {
	createParkedRunObserver,
	type ParkedObserverContext,
	type ParkedRunObserver,
} from "./ui/parked-observer.js";
import {
	createWidgetController,
	type WidgetController,
	WORKFLOW_WIDGET_KEY,
	WORKFLOW_WIDGET_SHORTCUT,
} from "./ui/widget.js";

type InspectorInitialState = Partial<InspectorState>;

type RunActionCommand = Extract<
	ParsedWorkflowCommand,
	{
		kind:
			| "wait"
			| "stop"
			| "reconcile"
			| "invalidate"
			| "retry"
			| "resume"
			| "decide";
	}
>;

type SourceDecisionCommand = Extract<
	ParsedWorkflowCommand,
	{ kind: SourceDecisionKind }
>;

/**
 * The inspector is TUI-only and loaded on first use so print/rpc/json
 * sessions never pull in the interactive component.
 */
function loadInspector() {
	return import("./ui/inspector.js");
}

/** The structural shape of a pi-tui component; pi-tui itself is never imported here. */
interface TextComponent {
	render(width: number): string[];
	invalidate(): void;
}

let textComponent: ((text: string) => TextComponent) | undefined;

/** Loads pi-tui's `Text` for tool rendering; a TUI session does this at start. */
async function loadTextComponent(): Promise<void> {
	textComponent ??= (await import("./ui/tool-render.js")).textComponent;
}

/**
 * Wraps rendered tool text in pi-tui's `Text` once the TUI module is loaded;
 * until then (or outside the TUI) the lines are returned as they are.
 */
function renderText(text: string): TextComponent {
	if (textComponent) return textComponent(text);
	const lines = text.split("\n");
	return {
		render: () => lines,
		invalidate() {},
	};
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
	request: ActionRequest,
	task: WorkflowServiceTaskView | undefined,
): string {
	switch (request.action) {
		case "invalidate":
			return request.preview ? invalidateConsequence(request.preview) : "";
		case "decide":
			return task ? decideConsequence(task, request.decision) : "";
		case "stop":
		case "retry":
		case "resume":
			return ACTION_CONSEQUENCES[request.action];
		default:
			return "";
	}
}

/**
 * The identity a checkpoint decision is recorded under. The pinned Pi
 * extension API exposes no user identity, so the fixed session literal is
 * used; the approver never comes from command arguments or a model.
 */
function checkpointApprover(_ctx: ExtensionContext): string {
	return DEFAULT_DECIDE_APPROVER;
}

/** The Pi session id when the context carries a session manager. */
function sessionIdOf(ctx: ExtensionContext): string | undefined {
	const manager = (ctx as Partial<ExtensionContext>).sessionManager;
	const sessionId =
		typeof manager?.getSessionId === "function"
			? manager.getSessionId()
			: undefined;
	return typeof sessionId === "string" && sessionId.length > 0
		? sessionId
		: undefined;
}

/**
 * The package's own definitions, shipped in the tarball next to `dist/` and
 * registered as a `builtin` root. It is trusted package code: the definitions
 * install with the package, load without Pi project trust, and resolve their
 * `@vegardx/pi-workflow` and `typebox` imports from their own location inside
 * the installed package.
 */
const BUILTIN_WORKFLOW_ROOT = path.resolve(
	import.meta.dirname,
	"..",
	"workflows",
);

/**
 * The builtin root, unless this checkout *is* the project being worked in
 * (developing pi-workflow itself). There the same directory is already
 * `<cwd>/workflows`, and discovery refuses two roots that resolve to one
 * path; the project root wins and the definitions load under `project` scope
 * with the usual trust gate.
 */
function builtinRoots(cwd: string, agentDir: string): readonly WorkflowRoot[] {
	const shadowed = [
		path.join(cwd, "workflows"),
		path.join(cwd, CONFIG_DIR_NAME, "workflows"),
		path.join(agentDir, "workflows"),
	].some((root) => path.resolve(root) === BUILTIN_WORKFLOW_ROOT);
	return shadowed
		? []
		: [
				Object.freeze({
					path: BUILTIN_WORKFLOW_ROOT,
					scope: "builtin",
					source: "package",
				} as const),
			];
}

export default function workflowExtension(pi: ExtensionAPI): void {
	let service: WorkflowService | undefined;
	let serviceCwd: string | undefined;
	let widget: WidgetController | undefined;
	let observer: ParkedRunObserver | undefined;
	// Each TUI session start supersedes the previous one; a start that lost
	// the race while awaiting the service never installs its controller. The
	// parked-run observer shares the counter: an `ExtensionContext` throws
	// once its session is replaced, so it never outlives its generation.
	let widgetGeneration = 0;

	async function getService(ctx: ExtensionContext): Promise<WorkflowService> {
		if (service && serviceCwd === ctx.cwd) return service;
		if (service) await service.shutdown();
		serviceCwd = ctx.cwd;
		const agentDir = getAgentDir();
		service = await createWorkflowService({
			cwd: ctx.cwd,
			agentDir,
			// Run state is machine-local recovery state, not project content:
			// it lives under the agent dir keyed by this project's path, a
			// sibling of Pi's own sessions directory for the same project
			// (`persistence/state-root.ts`).
			storeRoot: workflowStateRoot(ctx.cwd, agentDir),
			projectTrusted: () => ctx.isProjectTrusted(),
			subagents: createWorkflowSubagentProvider(pi.events, ctx),
			registeredRoots: builtinRoots(ctx.cwd, agentDir),
			// Host-process support implementations, the constructor form the
			// contract's `supportTaskExecution` feature promises. Package and
			// builtin code only (`support-registry.ts`): each registration also
			// admits its module specifier to the definition import gate.
			supportTasks: supportTaskRegistrations(),
			// The host's own bound on every delegation this process makes, read
			// once per `workflow_run`. pi-subagent owns the vocabulary and the
			// registration; this package only carries the answer onto the run
			// record and from there onto every request. A host that registered no
			// provider means no bound, and every run is unbounded as before.
			delegationCeiling: () => resolveDelegationCeiling(pi.events),
		});
		return service;
	}

	// W1-PROVIDER (spec 1.1, 2.4): the workflow runtime answers the discovery
	// request for the whole life of the extension, exactly as pi-subagent does.
	// `getService` is the same lazily-constructed, cwd-pinned service the tools
	// and the observer use, and the provider narrows it to the read client at
	// `acquire`, so a consumer can never reach `run`, `decide`, or `stop`.
	registerWorkflowServiceProvider(pi.events, (ctx) => getService(ctx));

	// The widget lives only in the TUI. `session_start` fires again on reload,
	// new, resume, and fork, so the previous controller is stopped first, and
	// two starts that overlap while the service opens leave exactly one
	// controller subscribed: the later one.
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const generation = ++widgetGeneration;
		widget?.stop();
		widget = undefined;
		observer?.stop();
		observer = undefined;
		try {
			await loadTextComponent();
			const runtime = await getService(ctx);
			if (generation !== widgetGeneration) return;
			const controller = createWidgetController({
				service: runtime,
				setWidget: (lines) =>
					ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, lines, {
						placement: "belowEditor",
					}),
			});
			widget = controller;
			await controller.start();
			// A start that overlapped this one's first refresh already stopped
			// the controller through `widget`; nothing else to release.
			if (generation !== widgetGeneration) return;
			// Asking the session user to decide a parked checkpoint is a
			// session act: the observer only ever sees this generation's
			// context, and a superseded one stops it.
			const parked = createParkedRunObserver({
				service: runtime,
				getContext: () =>
					generation === widgetGeneration
						? (ctx as ParkedObserverContext)
						: undefined,
				onDecided: () => widget?.refresh(),
			});
			observer = parked;
			parked.start();
		} catch {
			if (generation === widgetGeneration) {
				ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, undefined);
			}
		}
	});

	// A dialog opened by Pi or another extension replaces an open one, so the
	// observer defers its own while a foreign prompt is on screen.
	pi.on("ui_prompt_start", () => {
		observer?.notePromptStart();
	});
	pi.on("ui_prompt_end", () => {
		observer?.notePromptEnd();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		widgetGeneration += 1;
		widget?.stop();
		widget = undefined;
		observer?.stop();
		observer = undefined;
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
				return renderText(
					`${theme.fg("toolTitle", theme.bold(declaration.name))} ${theme.fg(
						"muted",
						declaration.summarizeCall(args),
					)}`.trimEnd(),
				);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				const text = result.content.find((item) => item.type === "text");
				const content = text?.type === "text" ? text.text : "";
				const display = expanded
					? content
					: declaration.summarizeResult(result.details as never);
				return renderText(
					`\n${theme.fg(isPartial ? "warning" : "success", display)}`,
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
				// The inspector owns the terminal while it is open and cannot
				// host a dialog, so its decide intent resolves here: the form
				// asks, and the inspector reopens where the operator left it.
				const outcome = await performRunAction(
					runtime,
					intent.request,
					intent.type === "decide"
						? {
								collectDecision: () =>
									collectDecisionFor(ctx, runtime, intent.run, intent.taskId),
							}
						: {},
				);
				ctx.ui.notify(outcome.message, outcome.level);
				if (intent.type === "decide") await widget?.refresh();
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		}
	}

	/**
	 * The guided form bound to one checkpoint: `performRunAction` calls it for
	 * a `decide` that carries no decision, and it records the answer itself.
	 * The task view comes from `status`, the only artifact-backed read that
	 * carries the full prompt and the verified inputs the form shows; nothing
	 * is recorded when it resolves `undefined`.
	 */
	async function collectDecisionFor(
		ctx: ExtensionContext,
		runtime: WorkflowService,
		run: WorkflowRunSummary,
		taskId: WorkflowTaskId,
		reason?: string,
	): Promise<CheckpointDecisionOutcome | undefined> {
		const view = await runtime.status(run.runId);
		const task = view.tasks?.find((candidate) => candidate.id === taskId);
		const pending = (view.pendingCheckpoints ?? []).some(
			(checkpoint) => checkpoint.taskId === taskId,
		);
		if (!task?.checkpoint || !pending) {
			throw new WorkflowCommandError(
				`Checkpoint ${task ? taskPath(task) : taskId} is not awaiting a decision.`,
			);
		}
		return collectCheckpointDecision(
			ctx,
			{
				id: task.id,
				namespace: task.namespace,
				key: task.key,
				checkpoint: task.checkpoint,
			},
			run,
			{
				service: runtime,
				approver: checkpointApprover(ctx),
				...(reason ? { reason } : {}),
			},
		);
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
				? await runtime.previewInvalidation(run.runId, task.id)
				: undefined;
		// A checkpoint decision is a human act: without a dialog nothing is
		// recorded, unlike the other actions in print mode. With `<json>` the
		// fixed confirm still gates it; without one the guided form asks the
		// session user and confirms for itself.
		const decideMode =
			parsed.kind === "decide"
				? checkpointDecisionMode(parsed, ctx.hasUI)
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
			...(parsed.kind === "decide"
				? {
						...(decideMode === "confirm" ? { decision: parsed.decision } : {}),
						approver: checkpointApprover(ctx),
					}
				: {}),
		};
		if (
			ctx.hasUI &&
			CONFIRMED_ACTIONS.has(action) &&
			decideMode !== "form" &&
			!(await ctx.ui.confirm(
				`${action} ${shortId(run.runId)}?`,
				consequenceFor(request, task),
			))
		) {
			return;
		}
		const outcome = await performRunAction(
			runtime,
			request,
			decideMode === "form" && task
				? {
						collectDecision: () =>
							collectDecisionFor(
								ctx,
								runtime,
								run,
								task.id,
								"reason" in parsed ? parsed.reason : undefined,
							),
					}
				: {},
		);
		operatorOutput(ctx, outcome.message, outcome.level);
		if (action === "decide") await widget?.refresh();
	}

	/**
	 * `/workflow prune [--apply] [--older-than <duration>]`: store-level
	 * retention, never a run action. The dry run is the default and the same
	 * selection the apply performs, so what the operator confirms is what the
	 * store moves. With a UI the apply asks first; in print mode it executes
	 * directly, exactly like the other non-decision actions.
	 */
	async function prune(
		ctx: ExtensionContext,
		runtime: WorkflowService,
		parsed: Extract<ParsedWorkflowCommand, { kind: "prune" }>,
	): Promise<void> {
		const bound =
			parsed.olderThanMs === undefined
				? {}
				: { olderThanMs: parsed.olderThanMs };
		const preview = await runtime.prune({ dryRun: true, ...bound });
		if (!parsed.apply || preview.selected.length === 0) {
			operatorOutput(
				ctx,
				pruneReportText(preview),
				!parsed.apply && preview.selected.length > 0 ? "warning" : "info",
			);
			return;
		}
		if (
			ctx.hasUI &&
			!(await ctx.ui.confirm(
				`Prune ${preview.selected.length} terminal workflow run(s)?`,
				pruneConsequence(preview),
			))
		) {
			operatorOutput(ctx, PRUNE_CANCELLED_MESSAGE);
			return;
		}
		const report = await runtime.prune({ dryRun: false, ...bound });
		operatorOutput(ctx, pruneReportText(report));
		await widget?.refresh();
	}

	/**
	 * `/workflow approve|reject dynamic:<sha>`: human-only. Refused without a
	 * dialog, rendered in full before the explicit confirm, and recorded with
	 * the session as approver; a cancelled confirm records nothing.
	 */
	async function sourceDecision(
		ctx: ExtensionContext,
		runtime: WorkflowService,
		parsed: SourceDecisionCommand,
	): Promise<void> {
		if (!ctx.hasUI) {
			throw new WorkflowCommandError(SOURCE_DECISION_REQUIRES_UI_MESSAGE);
		}
		const view = await runtime.inspectProposal(parsed.ref);
		// Legality is the proposal's decision state; a decided source is never
		// rendered for a second decision.
		if (view.decision) {
			throw new WorkflowCommandError(
				sourceDecisionUnavailableMessage(parsed.kind, view),
			);
		}
		const verb = parsed.kind === "approve" ? "Approve" : "Reject";
		const confirmed = await ctx.ui.confirm(
			`${verb} dynamic workflow ${shortId(view.sourceSha256)}?`,
			renderDynamicProposal(view),
		);
		if (!confirmed) {
			operatorOutput(ctx, SOURCE_DECISION_CANCELLED_MESSAGE, "info");
			return;
		}
		const sessionId = sessionIdOf(ctx);
		const approver: DynamicSourceApprover = {
			kind: "human",
			via: sourceDecisionVia(parsed.kind),
			...(sessionId ? { sessionId } : {}),
		};
		const outcome = await performSourceDecision(runtime, {
			kind: parsed.kind,
			view,
			approver,
			...(parsed.reason ? { reason: parsed.reason } : {}),
		});
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
				const { workflows, problems } = await runtime.list();
				const lines =
					workflows.length === 0
						? ["No workflows found"]
						: workflows.map(
								(workflow) =>
									`${workflow.name.padEnd(24)} v${workflow.version} ${workflow.scope.padEnd(8)} ${workflow.description}`,
							);
				// After the table, never instead of it: the definitions that loaded
				// are listed even when a file beside them did not.
				if (problems.length > 0) {
					lines.push(
						"",
						`${problems.length} definition file(s) could not be loaded:`,
						...problems.map(
							(problem) => `  ${problem.path}: ${problem.problem}`,
						),
					);
				}
				operatorOutput(ctx, lines.join("\n"));
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
			case "prune":
				return prune(ctx, runtime, parsed);
			case "approve":
			case "reject":
				return sourceDecision(ctx, runtime, parsed);
			default:
				return runAction(ctx, runtime, parsed);
		}
	}

	/**
	 * Undecided proposal refs for `approve`/`reject` completions, from the
	 * service already opened by this session; nothing is opened for a completion.
	 */
	async function undecidedProposalRefs(prefix: string): Promise<string[]> {
		const [subcommand] = prefix.trimStart().split(/\s+/);
		if ((subcommand !== "approve" && subcommand !== "reject") || !service) {
			return [];
		}
		try {
			return (await service.proposals()).flatMap((listing) =>
				"issue" in listing || listing.decision ? [] : [listing.ref],
			);
		} catch {
			return [];
		}
	}

	pi.registerCommand(WORKFLOW_COMMAND, {
		description: "List, run, inspect, and control durable workflows",
		getArgumentCompletions: async (prefix) =>
			workflowArgumentCompletions(
				prefix,
				widget?.lastPage?.runs.map((run) => run.runId) ?? [],
				await undecidedProposalRefs(prefix),
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
