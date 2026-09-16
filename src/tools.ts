import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { CHECKPOINT_DECIDE_INSTRUCTION } from "./checkpoint-render.js";
import {
	MAX_WORKFLOW_CONCURRENCY,
	WorkflowBudgetSchema,
	WorkflowDefinitionNameSchema,
	WorkflowRunIdSchema,
	WorkflowRunStatusSchema,
	WorkflowTaskIdSchema,
} from "./contracts.js";
import { MAX_DYNAMIC_SOURCE_BYTES } from "./dynamic/constants.js";
import { encodeWorkflowRunCursor } from "./run-projection.js";
import type { WorkflowService } from "./service.js";
import {
	DynamicWorkflowProposalViewSchema,
	WorkflowInspectOptionsSchema,
	WorkflowLogOptionsSchema,
	WorkflowLogPageSchema,
	WorkflowReconcileOptionsSchema,
	WorkflowRunInspectionSchema,
	WorkflowRunPageSchema,
	WorkflowRunQuerySchema,
	WorkflowServiceReconcileViewSchema,
	WorkflowServiceRunViewSchema,
	WorkflowServiceWaitViewSchema,
} from "./service-views.js";

export type WorkflowToolName =
	| "workflow_list"
	| "workflow_validate"
	| "workflow_run"
	| "workflow_status"
	| "workflow_wait"
	| "workflow_stop"
	| "workflow_reconcile"
	| "workflow_runs"
	| "workflow_inspect"
	| "workflow_logs"
	| "workflow_invalidate"
	| "workflow_retry"
	| "workflow_resume"
	| "workflow_propose";

type DeepReadonly<T> = T extends readonly (infer U)[]
	? readonly DeepReadonly<U>[]
	: T extends object
		? { readonly [K in keyof T]: DeepReadonly<T[K]> }
		: T;

/** The service value a tool returns; it validates against the declared output schema. */
export type WorkflowToolOutput<TOutput extends TSchema> = DeepReadonly<
	Static<TOutput>
>;

export interface WorkflowToolDeclaration<
	TParams extends TSchema = TSchema,
	TOutput extends TSchema = TSchema,
> {
	readonly name: WorkflowToolName;
	readonly label: string;
	readonly description: string;
	readonly promptSnippet?: string;
	readonly promptGuidelines: readonly string[];
	readonly parameters: TParams;
	readonly output: TOutput;
	execute(
		service: WorkflowService,
		params: Static<TParams>,
	): Promise<WorkflowToolOutput<TOutput>>;
	/**
	 * Renders a schema-valid value as bounded JSON for the model context.
	 * Absent for tools that use the shared rule (see `workflowToolText`).
	 */
	text?(value: WorkflowToolOutput<TOutput>): string;
	/** One line shown next to the tool name while the call renders. */
	summarizeCall(params: Static<TParams>): string;
	/** One line shown for the collapsed result; the value is the typed result `details`. */
	summarizeResult(value: WorkflowToolOutput<TOutput>): string;
}

/** Every tool text block fits this many bytes of pretty-printed JSON. */
export const MAX_TOOL_OUTPUT_BYTES = 48 * 1024;

function serialize(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function fits(serialized: string): boolean {
	return Buffer.byteLength(serialized) <= MAX_TOOL_OUTPUT_BYTES;
}

/**
 * Control-plane output crosses the tool boundary only after it satisfies its
 * schema; a failure here is a projection bug and is never masked.
 */
function checked<T extends TSchema>(
	schema: T,
	value: unknown,
): WorkflowToolOutput<T> {
	if (!Value.Check(schema, value)) {
		throw new Error("workflow tool output violates its schema");
	}
	return value as WorkflowToolOutput<T>;
}

/**
 * Shared bounding rule: the whole value when it fits; run views omit the
 * output value (the durable artifact remains) when they do not; every other
 * value must fit.
 */
function boundedText(value: unknown): string {
	const serialized = serialize(value);
	if (fits(serialized)) return serialized;
	if (typeof value === "object" && value !== null && "output" in value) {
		const bounded = { ...value, output: undefined };
		return `${serialize(bounded)}\n\n[Workflow output omitted from tool context because it exceeds ${MAX_TOOL_OUTPUT_BYTES} bytes. Use the durable output artifact.]`;
	}
	throw new Error("workflow tool output exceeds context limit");
}

/** Legacy bounding for `workflow_list`, the only tool that returns a bare array. */
function legacyListText(value: readonly unknown[]): string {
	const serialized = serialize(value);
	if (fits(serialized)) return serialized;
	const bounded: unknown[] = [];
	for (const entry of value) {
		const candidate = [
			...bounded,
			entry,
			{ truncated: true, totalItems: value.length },
		];
		if (!fits(serialize(candidate))) break;
		bounded.push(entry);
	}
	bounded.push({ truncated: true, totalItems: value.length });
	return serialize(bounded);
}

/**
 * Pages shrink instead of cutting items: trailing runs are dropped until the
 * page fits and the cursor points at the last kept run, so successive calls
 * stay complete. At least one run is kept.
 */
function runsPageText(
	page: WorkflowToolOutput<typeof WorkflowRunPageSchema>,
): string {
	const runs = [...page.runs];
	for (;;) {
		const last = runs.at(-1);
		const candidate =
			runs.length === page.runs.length || !last
				? page
				: checked(WorkflowRunPageSchema, {
						...page,
						runs,
						nextCursor: encodeWorkflowRunCursor(last),
					});
		const serialized = serialize(candidate);
		if (fits(serialized)) return serialized;
		if (runs.length <= 1) {
			throw new Error("workflow tool output exceeds context limit");
		}
		runs.pop();
	}
}

/** Log pages shrink the same way; the cursor is the last kept sequence. */
function logPageText(
	page: WorkflowToolOutput<typeof WorkflowLogPageSchema>,
): string {
	const entries = [...page.entries];
	for (;;) {
		const last = entries.at(-1);
		const candidate =
			entries.length === page.entries.length || !last
				? page
				: checked(WorkflowLogPageSchema, {
						...page,
						entries,
						nextAfterSequence: last.sequence,
					});
		const serialized = serialize(candidate);
		if (fits(serialized)) return serialized;
		if (entries.length <= 1) {
			throw new Error("workflow tool output exceeds context limit");
		}
		entries.pop();
	}
}

/**
 * The text block for a tool result: the value is checked against the
 * declared output schema, then rendered by the declaration's own bounding
 * or the shared rule.
 */
export function workflowToolText<
	TParams extends TSchema,
	TOutput extends TSchema,
>(
	declaration: WorkflowToolDeclaration<TParams, TOutput>,
	value: unknown,
): string {
	const valid = checked(declaration.output, value);
	return declaration.text ? declaration.text(valid) : boundedText(valid);
}

const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });

export const WorkflowRootScopeSchema = Type.Union([
	Type.Literal("project"),
	Type.Literal("global"),
	Type.Literal("package"),
	Type.Literal("builtin"),
	Type.Literal("dynamic"),
]);

export const WorkflowDefinitionSummarySchema = Type.Object(
	{
		name: WorkflowDefinitionNameSchema,
		description: Type.String({ minLength: 1, maxLength: 1024 }),
		version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		concurrency: Type.Integer({
			minimum: 1,
			maximum: MAX_WORKFLOW_CONCURRENCY,
		}),
		budget: WorkflowBudgetSchema,
		timeoutMs: Type.Integer({
			minimum: 1_000,
			maximum: Number.MAX_SAFE_INTEGER,
		}),
		scope: WorkflowRootScopeSchema,
		source: Type.String({ minLength: 1, maxLength: 1024 }),
		path: Type.String({ minLength: 1, maxLength: 4096 }),
		identitySha256: Sha256Schema,
	},
	{ additionalProperties: false },
);

/** Discovery loads at most 256 definitions. */
export const WorkflowDefinitionSummaryListSchema = Type.Array(
	WorkflowDefinitionSummarySchema,
	{ maxItems: 256 },
);

export const WorkflowValidationResultSchema = Type.Object(
	{
		valid: Type.Literal(true),
		workflow: WorkflowDefinitionSummarySchema,
	},
	{ additionalProperties: false },
);

export const WorkflowServiceRunReceiptSchema = Type.Object(
	{
		runId: WorkflowRunIdSchema,
		status: WorkflowRunStatusSchema,
	},
	{ additionalProperties: false },
);

const WorkflowRefSchema = Type.String({ minLength: 1, maxLength: 4096 });
const RunId = WorkflowRunIdSchema;
const TaskId = WorkflowTaskIdSchema;
const Reason = Type.String({ minLength: 1, maxLength: 4096 });
const RunParametersSchema = Type.Object(
	{ runId: RunId },
	{ additionalProperties: false },
);

/** Shared collapsed-result line for every tool that returns a run view. */
function runStatusSummary(value: {
	readonly runId: string;
	readonly status: string;
}): string {
	return `${value.runId} ${value.status}`;
}

/** A collapsed-result line fits this many characters. */
const MAX_TOOL_SUMMARY_LENGTH = 120;

/**
 * What a run view carrying a parked checkpoint says, told once and shared by
 * `workflow_status` and `workflow_wait`: the question the person must answer.
 */
const PENDING_CHECKPOINTS_GUIDELINE =
	"A parked run (parked: true, or status waiting) returns pendingCheckpoints[], each with the checkpoint prompt, its taskKey, the answer shape (schemaSummary), the declared inputs (inputsSummary), and instruction; show the prompt and its inputs summary to the person and stop.";

/** The two guidelines every tool that can return a parked run view carries. */
const PARKED_RUN_GUIDELINES: readonly string[] = [
	PENDING_CHECKPOINTS_GUIDELINE,
	CHECKPOINT_DECIDE_INSTRUCTION,
];

/** Appended to the description of every tool that can return a parked run. */
const PARKED_RUN_DESCRIPTION =
	"A run parked at a checkpoint returns pendingCheckpoints with the prompt, task key, answer shape, and inputs summary; Pi asks the person in the session, so surface the question and stop.";

/**
 * The collapsed-result line of a parked run view: the question, not the
 * status. Absent for every other view.
 */
function parkedCheckpointSummary(value: {
	readonly status: string;
	readonly parked?: true | undefined;
	readonly pendingCheckpoints?:
		| readonly { readonly prompt?: string | undefined }[]
		| undefined;
}): string | undefined {
	if (value.parked !== true && value.status !== "waiting") return undefined;
	const prompt = value.pendingCheckpoints?.find(
		(checkpoint) => checkpoint.prompt !== undefined,
	)?.prompt;
	if (prompt === undefined) return undefined;
	const line = `waiting for you: ${prompt.replace(/\s+/g, " ").trim()}`;
	return line.length <= MAX_TOOL_SUMMARY_LENGTH
		? line
		: `${line.slice(0, MAX_TOOL_SUMMARY_LENGTH - 1)}…`;
}

function declare<TParams extends TSchema, TOutput extends TSchema>(
	declaration: WorkflowToolDeclaration<TParams, TOutput>,
): WorkflowToolDeclaration<TParams, TOutput> {
	return Object.freeze({
		...declaration,
		promptGuidelines: Object.freeze([...declaration.promptGuidelines]),
	});
}

export const WORKFLOW_TOOL_DECLARATIONS: readonly WorkflowToolDeclaration[] =
	Object.freeze([
		declare({
			name: "workflow_list",
			label: "List Workflows",
			description:
				"List trusted static workflows available in the current project context.",
			promptSnippet: "List trusted durable workflows",
			promptGuidelines: [
				"Use workflow_list before workflow_run when the available workflow name is unknown.",
			],
			parameters: Type.Object({}, { additionalProperties: false }),
			output: WorkflowDefinitionSummaryListSchema,
			execute(service) {
				return service.list();
			},
			text: legacyListText,
			summarizeCall: () => "",
			summarizeResult: (value) => `${value.length} workflow(s)`,
		}),
		declare({
			name: "workflow_validate",
			label: "Validate Workflow",
			description:
				"Validate a trusted static workflow reference and optionally its JSON input without creating a run. Accepts dynamic:<sha256> for an approved dynamic workflow proposal.",
			promptGuidelines: [],
			parameters: Type.Object(
				{
					ref: WorkflowRefSchema,
					input: Type.Optional(Type.Unknown()),
				},
				{ additionalProperties: false },
			),
			output: WorkflowValidationResultSchema,
			execute(service, params) {
				return params.input === undefined
					? service.validate(params.ref)
					: service.validate(params.ref, params.input);
			},
			summarizeCall: (params) => params.ref,
			summarizeResult: (value) =>
				`valid: ${value.workflow.name} v${value.workflow.version}`,
		}),
		declare({
			name: "workflow_run",
			label: "Run Workflow",
			description:
				"Start a trusted durable static workflow. Returns a run ID immediately; use workflow_wait or workflow_status to observe it. Accepts dynamic:<sha256> for an approved dynamic workflow proposal.",
			promptGuidelines: [],
			parameters: Type.Object(
				{
					ref: WorkflowRefSchema,
					input: Type.Unknown(),
				},
				{ additionalProperties: false },
			),
			output: WorkflowServiceRunReceiptSchema,
			execute(service, params) {
				return service.run(params.ref, params.input);
			},
			summarizeCall: (params) => params.ref,
			summarizeResult: runStatusSummary,
		}),
		declare({
			name: "workflow_status",
			label: "Workflow Status",
			description: `Read durable status for a workflow run. ${PARKED_RUN_DESCRIPTION}`,
			promptGuidelines: PARKED_RUN_GUIDELINES,
			parameters: RunParametersSchema,
			output: WorkflowServiceRunViewSchema,
			execute(service, params) {
				return service.status(params.runId);
			},
			summarizeCall: (params) => params.runId,
			summarizeResult: (value) =>
				parkedCheckpointSummary(value) ?? runStatusSummary(value),
		}),
		declare({
			name: "workflow_wait",
			label: "Wait for Workflow",
			description: `Wait for an active workflow run and return its durable terminal status and bounded output. With timeoutMs, return the current view marked timedOut when the run outlives the timeout; the run keeps driving. ${PARKED_RUN_DESCRIPTION} Never poll a parked run: wait returns immediately while it waits for a person.`,
			promptGuidelines: PARKED_RUN_GUIDELINES,
			parameters: Type.Object(
				{
					runId: RunId,
					timeoutMs: Type.Optional(
						Type.Integer({ minimum: 1_000, maximum: 3_600_000 }),
					),
				},
				{ additionalProperties: false },
			),
			output: WorkflowServiceWaitViewSchema,
			execute(service, params) {
				const { runId, ...options } = params;
				return service.wait(runId, options);
			},
			summarizeCall: (params) =>
				params.timeoutMs
					? `${params.runId} · ${params.timeoutMs} ms`
					: params.runId,
			summarizeResult: (value) =>
				parkedCheckpointSummary(value) ??
				`${runStatusSummary(value)}${value.timedOut ? " (timed out)" : ""}`,
		}),
		declare({
			name: "workflow_stop",
			label: "Stop Workflow",
			description:
				"Persist stop intent, interrupt active delegated work, and drain durable terminal evidence.",
			promptGuidelines: [],
			parameters: Type.Object(
				{ runId: RunId, reason: Reason },
				{ additionalProperties: false },
			),
			output: WorkflowServiceRunViewSchema,
			execute(service, params) {
				return service.stop(params.runId, params.reason);
			},
			summarizeCall: (params) => params.runId,
			summarizeResult: runStatusSummary,
		}),
		declare({
			name: "workflow_reconcile",
			label: "Reconcile Workflow",
			description:
				"Reopen and reconcile a durable workflow run after restart or interruption.",
			promptGuidelines: [],
			parameters: Type.Object(
				{ runId: RunId, ...WorkflowReconcileOptionsSchema.properties },
				{ additionalProperties: false },
			),
			output: WorkflowServiceReconcileViewSchema,
			execute(service, params) {
				const { runId, ...options } = params;
				return service.reconcile(runId, options);
			},
			summarizeCall: (params) =>
				params.taskId ? `${params.runId} · ${params.taskId}` : params.runId,
			summarizeResult: (value) =>
				`${runStatusSummary(value)} · ${value.reconciled.length} reconciled`,
		}),
		declare({
			name: "workflow_runs",
			label: "List Workflow Runs",
			description:
				"List durable workflow runs in this project with status, ownership, and the operator actions the service currently permits.",
			promptGuidelines: [],
			parameters: WorkflowRunQuerySchema,
			output: WorkflowRunPageSchema,
			execute(service, params) {
				return service.listRuns(params);
			},
			text: runsPageText,
			summarizeCall: (params) =>
				[
					params.statuses?.join(","),
					params.includeChildren ? "children" : undefined,
					params.cursor ? "page" : undefined,
				]
					.filter(Boolean)
					.join(" · "),
			summarizeResult: (value) =>
				`${value.runs.length} of ${value.total} run(s)${
					value.issues.length ? ` · ${value.issues.length} issue(s)` : ""
				}`,
		}),
		declare({
			name: "workflow_inspect",
			label: "Inspect Workflow Run",
			description:
				"Inspect a workflow run's durable projection: budget, tasks, executions, effects, barriers, artifacts. Use include and taskId to bound the output.",
			promptGuidelines: [],
			parameters: Type.Object(
				{ runId: RunId, ...WorkflowInspectOptionsSchema.properties },
				{ additionalProperties: false },
			),
			output: WorkflowRunInspectionSchema,
			execute(service, params) {
				const { runId, ...options } = params;
				return service.inspect(runId, options);
			},
			/** Never cut: the `run` section alone always fits, so the caller can narrow. */
			text(inspection) {
				const serialized = serialize(inspection);
				if (!fits(serialized)) {
					throw new Error(
						"Workflow inspection exceeds the tool output bound; narrow include or pass taskId.",
					);
				}
				return serialized;
			},
			summarizeCall: (params) =>
				[params.runId, params.include?.join(","), params.taskId]
					.filter(Boolean)
					.join(" · "),
			summarizeResult: (value) =>
				`${runStatusSummary(value.run)} · ${value.run.taskCounts.total} task(s)`,
		}),
		declare({
			name: "workflow_logs",
			label: "Workflow Run Logs",
			description:
				"Read redacted, paginated lifecycle log entries derived from a workflow run's journal.",
			promptGuidelines: [],
			parameters: Type.Object(
				{ runId: RunId, ...WorkflowLogOptionsSchema.properties },
				{ additionalProperties: false },
			),
			output: WorkflowLogPageSchema,
			execute(service, params) {
				const { runId, ...options } = params;
				return service.logs(runId, options);
			},
			text: logPageText,
			summarizeCall: (params) =>
				params.afterSequence
					? `${params.runId} · after ${params.afterSequence}`
					: params.runId,
			summarizeResult: (value) =>
				`${value.entries.length} entr${
					value.entries.length === 1 ? "y" : "ies"
				} · seq ${value.lastSequence}`,
		}),
		declare({
			name: "workflow_invalidate",
			label: "Invalidate Workflow Task",
			description:
				"Invalidate a settled task and its dependents on a failed or interrupted run so they re-execute; returns the run view.",
			promptGuidelines: [],
			parameters: Type.Object(
				{ runId: RunId, taskId: TaskId, reason: Reason },
				{ additionalProperties: false },
			),
			output: WorkflowServiceRunViewSchema,
			execute(service, params) {
				return service.invalidate(params.runId, params.taskId, params.reason);
			},
			summarizeCall: (params) => `${params.runId} · ${params.taskId}`,
			summarizeResult: runStatusSummary,
		}),
		declare({
			name: "workflow_retry",
			label: "Retry Workflow Task",
			description:
				"Re-execute a failed or interrupted task as a fresh generation with a new subagent run. Equivalent to workflow_invalidate with the failed task as cause.",
			promptGuidelines: [
				"Use workflow_retry only on a durably failed or interrupted root run; inspect first with workflow_inspect and name a task whose current execution failed or was interrupted.",
			],
			parameters: Type.Object(
				{ runId: RunId, taskId: TaskId, reason: Reason },
				{ additionalProperties: false },
			),
			output: WorkflowServiceRunViewSchema,
			execute(service, params) {
				return service.retry(params.runId, params.taskId, params.reason);
			},
			summarizeCall: (params) => `${params.runId} · ${params.taskId}`,
			summarizeResult: runStatusSummary,
		}),
		declare({
			name: "workflow_resume",
			label: "Resume Workflow Task",
			description:
				"Resume an interrupted agent task on its existing subagent run and attempt, preserving the child session; use workflow_retry to start over.",
			promptGuidelines: [
				"Use workflow_resume only on a durably interrupted root run; inspect first with workflow_inspect and pass taskId when more than one task is resumable.",
			],
			parameters: Type.Object(
				{ runId: RunId, reason: Reason, taskId: Type.Optional(TaskId) },
				{ additionalProperties: false },
			),
			output: WorkflowServiceRunViewSchema,
			execute(service, params) {
				const { runId, reason, ...options } = params;
				return service.resume(runId, reason, options);
			},
			summarizeCall: (params) =>
				params.taskId ? `${params.runId} · ${params.taskId}` : params.runId,
			summarizeResult: runStatusSummary,
		}),
		declare({
			name: "workflow_propose",
			label: "Propose Dynamic Workflow",
			description:
				"Propose dynamic workflow TypeScript source for human approval. Returns the proposal as dynamic:<sha256>; a human must approve it with /workflow approve before workflow_run or workflow_validate accept that reference. The model cannot approve.",
			promptGuidelines: [
				"Author the source exactly like a static *.workflow.ts definition (workflow-authoring skill): default-export one defineWorkflow call; import only @vegardx/pi-workflow, typebox, and registered support modules.",
				"Never state or assume a proposal is approved; approval is a human decision outside the tool surface.",
			],
			parameters: Type.Object(
				{
					source: Type.String({
						minLength: 1,
						maxLength: MAX_DYNAMIC_SOURCE_BYTES,
					}),
				},
				{ additionalProperties: false },
			),
			output: DynamicWorkflowProposalViewSchema,
			/** Proposes only: the human decision never passes through a tool. */
			execute(service, params) {
				return service.propose(params.source, {
					proposer: { kind: "tool", via: "workflow_propose" },
				});
			},
			summarizeCall: (params) => `${Buffer.byteLength(params.source)} bytes`,
			summarizeResult: (value) =>
				`${value.ref} · ${
					value.runnable
						? "approved"
						: value.decision
							? value.decision.decision
							: "awaiting approval"
				}`,
		}),
	]);
