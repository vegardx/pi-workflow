import type { Static, TSchema } from "typebox";
import type {
	CheckpointRequest,
	createWorkflowService,
	DynamicSourceDecisionOptions,
	DynamicWorkflowProposalInspection,
	DynamicWorkflowProposalListing,
	DynamicWorkflowProposalView,
	DynamicWorkflowProposeOptions,
	defineSupportTask,
	defineWorkflow,
	SupportTaskHelper,
	SupportTaskHelperOptions,
	WorkflowContext,
	WorkflowDecideOptions,
	WorkflowDefinition,
	WorkflowDefinitionOptions,
	WorkflowDefinitionSummary,
	WorkflowHandoffDescriptor,
	WorkflowInspectOptions,
	WorkflowInvalidationPreview,
	WorkflowLogOptions,
	WorkflowLogPage,
	WorkflowReconcileOptions,
	WorkflowResumeOptions,
	WorkflowRoot,
	WorkflowRunAction,
	WorkflowRunId,
	WorkflowRunInspection,
	WorkflowRunListener,
	WorkflowRunPage,
	WorkflowRunQuery,
	WorkflowService,
	WorkflowServiceError,
	WorkflowServiceHandoffExport,
	WorkflowServiceOptions,
	WorkflowServiceReconcileView,
	WorkflowServiceRunReceipt,
	WorkflowServiceRunView,
	WorkflowServiceRunViewSchema,
	WorkflowServiceWaitView,
	WorkflowTaskId,
	WorkflowToolDeclaration,
	WorkflowToolName,
	WorkflowValidationResult,
	WorkflowWaitOptions,
	WorktreeTaskHandle,
} from "../src/index.js";

// Compile-time pins for the 1.0 API freeze. No runtime: `tsc --noEmit`
// (npm run typecheck) compiles this file through the root tsconfig's `test`
// include. Each `Assert<Equal<…>>` names one frozen TypeScript shape; a change
// to a parameter tuple, a return type, or a key union fails the build. Update
// a pin only together with the version bump docs/contracts.md "Public API and
// stability" requires for that kind of change.

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;
/** The view types are the deep-readonly static shape of their schema. */
type DeepReadonly<T> = T extends readonly (infer U)[]
	? readonly DeepReadonly<U>[]
	: T extends object
		? { readonly [K in keyof T]: DeepReadonly<T[K]> }
		: T;

type Method<K extends keyof WorkflowService> = WorkflowService[K];

export type ServiceApiPins = [
	Assert<
		Equal<Parameters<typeof createWorkflowService>, [WorkflowServiceOptions]>
	>,
	Assert<
		Equal<ReturnType<typeof createWorkflowService>, Promise<WorkflowService>>
	>,
	Assert<
		Equal<
			keyof WorkflowServiceOptions,
			| "cwd"
			| "agentDir"
			| "storeRoot"
			| "projectTrusted"
			| "subagents"
			// 1.1.0 (additive): package-provided definition roots.
			| "registeredRoots"
			| "maxConcurrency"
			| "maxWorkflowCost"
			| "maxWorkflowTotalTokens"
			| "maxWorkflowChildRuntimeMs"
			| "maxWorkflowTimeoutMs"
			| "supportTasks"
			// 2.1.0 (additive): the host's model-routing port.
			| "modelRouting"
			| "checkpoints"
			| "dynamic"
		>
	>,
	Assert<
		Equal<
			WorkflowServiceOptions["registeredRoots"],
			readonly WorkflowRoot[] | undefined
		>
	>,
	Assert<
		Equal<
			WorkflowServiceOptions["checkpoints"],
			{ readonly headless?: boolean } | undefined
		>
	>,
	Assert<
		Equal<
			WorkflowServiceOptions["dynamic"],
			| {
					readonly bootTimeoutMs?: number;
					readonly computeTimeoutMs?: number;
			  }
			| undefined
		>
	>,
	Assert<
		Equal<
			keyof WorkflowService,
			| "decide"
			| "decideSource"
			| "exportHandoff"
			| "inspect"
			| "inspectProposal"
			| "invalidate"
			| "list"
			| "listRuns"
			| "logs"
			| "previewInvalidation"
			| "project"
			| "proposals"
			| "propose"
			| "prune"
			| "reconcile"
			| "registerRoot"
			| "resume"
			| "retry"
			| "run"
			| "shutdown"
			| "status"
			| "stop"
			| "subscribe"
			| "validate"
			| "wait"
		>
	>,
	Assert<Equal<Parameters<Method<"registerRoot">>, [WorkflowRoot]>>,
	Assert<Equal<ReturnType<Method<"registerRoot">>, Promise<void>>>,
	Assert<Equal<Parameters<Method<"list">>, []>>,
	Assert<
		Equal<
			ReturnType<Method<"list">>,
			Promise<readonly WorkflowDefinitionSummary[]>
		>
	>,
	Assert<Equal<Parameters<Method<"validate">>, [string, unknown?]>>,
	Assert<
		Equal<ReturnType<Method<"validate">>, Promise<WorkflowValidationResult>>
	>,
	Assert<Equal<Parameters<Method<"run">>, [string, unknown]>>,
	Assert<Equal<ReturnType<Method<"run">>, Promise<WorkflowServiceRunReceipt>>>,
	Assert<Equal<Parameters<Method<"status">>, [WorkflowRunId]>>,
	Assert<Equal<ReturnType<Method<"status">>, Promise<WorkflowServiceRunView>>>,
	Assert<
		Equal<
			Parameters<Method<"wait">>,
			[WorkflowRunId, (WorkflowWaitOptions | undefined)?]
		>
	>,
	Assert<Equal<ReturnType<Method<"wait">>, Promise<WorkflowServiceWaitView>>>,
	Assert<Equal<Parameters<Method<"stop">>, [WorkflowRunId, string]>>,
	Assert<Equal<ReturnType<Method<"stop">>, Promise<WorkflowServiceRunView>>>,
	Assert<
		Equal<
			Parameters<Method<"decide">>,
			[WorkflowRunId, string, WorkflowDecideOptions]
		>
	>,
	Assert<Equal<ReturnType<Method<"decide">>, Promise<WorkflowServiceRunView>>>,
	Assert<
		Equal<Parameters<Method<"invalidate">>, [WorkflowRunId, string, string]>
	>,
	Assert<
		Equal<ReturnType<Method<"invalidate">>, Promise<WorkflowServiceRunView>>
	>,
	Assert<
		Equal<
			Parameters<Method<"reconcile">>,
			[WorkflowRunId, (WorkflowReconcileOptions | undefined)?]
		>
	>,
	Assert<
		Equal<
			ReturnType<Method<"reconcile">>,
			Promise<WorkflowServiceReconcileView>
		>
	>,
	Assert<Equal<Parameters<Method<"exportHandoff">>, [WorkflowRunId, string]>>,
	Assert<
		Equal<
			ReturnType<Method<"exportHandoff">>,
			Promise<WorkflowServiceHandoffExport>
		>
	>,
	Assert<Equal<keyof WorkflowServiceHandoffExport, "descriptor" | "content">>,
	Assert<
		Equal<WorkflowServiceHandoffExport["descriptor"], WorkflowHandoffDescriptor>
	>,
	Assert<
		Equal<Parameters<Method<"retry">>, [WorkflowRunId, WorkflowTaskId, string]>
	>,
	Assert<Equal<ReturnType<Method<"retry">>, Promise<WorkflowServiceRunView>>>,
	Assert<
		Equal<
			Parameters<Method<"resume">>,
			[WorkflowRunId, string, (WorkflowResumeOptions | undefined)?]
		>
	>,
	Assert<Equal<ReturnType<Method<"resume">>, Promise<WorkflowServiceRunView>>>,
	Assert<Equal<Parameters<Method<"shutdown">>, []>>,
	Assert<Equal<ReturnType<Method<"shutdown">>, Promise<void>>>,
	Assert<
		Equal<
			Parameters<Method<"propose">>,
			[string, DynamicWorkflowProposeOptions]
		>
	>,
	Assert<
		Equal<ReturnType<Method<"propose">>, Promise<DynamicWorkflowProposalView>>
	>,
	Assert<Equal<keyof DynamicWorkflowProposeOptions, "proposer">>,
	Assert<Equal<Parameters<Method<"inspectProposal">>, [string]>>,
	Assert<
		Equal<
			ReturnType<Method<"inspectProposal">>,
			Promise<DynamicWorkflowProposalInspection>
		>
	>,
	Assert<Equal<Parameters<Method<"proposals">>, []>>,
	Assert<
		Equal<
			ReturnType<Method<"proposals">>,
			Promise<readonly DynamicWorkflowProposalListing[]>
		>
	>,
	Assert<
		Equal<
			Parameters<Method<"decideSource">>,
			[string, DynamicSourceDecisionOptions]
		>
	>,
	Assert<
		Equal<
			ReturnType<Method<"decideSource">>,
			Promise<DynamicWorkflowProposalView>
		>
	>,
	Assert<
		Equal<
			keyof DynamicSourceDecisionOptions,
			"decision" | "approver" | "reason"
		>
	>,
	Assert<
		Equal<Parameters<Method<"listRuns">>, [(WorkflowRunQuery | undefined)?]>
	>,
	Assert<Equal<ReturnType<Method<"listRuns">>, Promise<WorkflowRunPage>>>,
	Assert<
		Equal<
			Parameters<Method<"inspect">>,
			[WorkflowRunId, (WorkflowInspectOptions | undefined)?]
		>
	>,
	Assert<Equal<ReturnType<Method<"inspect">>, Promise<WorkflowRunInspection>>>,
	Assert<
		Equal<
			Parameters<Method<"logs">>,
			[WorkflowRunId, (WorkflowLogOptions | undefined)?]
		>
	>,
	Assert<Equal<ReturnType<Method<"logs">>, Promise<WorkflowLogPage>>>,
	Assert<
		Equal<
			Parameters<Method<"previewInvalidation">>,
			[WorkflowRunId, WorkflowTaskId]
		>
	>,
	Assert<
		Equal<
			ReturnType<Method<"previewInvalidation">>,
			Promise<WorkflowInvalidationPreview>
		>
	>,
	Assert<Equal<Parameters<Method<"subscribe">>, [WorkflowRunListener]>>,
	Assert<Equal<ReturnType<Method<"subscribe">>, () => void>>,
	Assert<
		Equal<
			WorkflowServiceError["code"],
			"validation" | "not-found" | "conflict" | "persistence" | "execution"
		>
	>,
	Assert<
		Extends<Static<typeof WorkflowServiceRunViewSchema>, WorkflowServiceRunView>
	>,
	Assert<
		Equal<
			WorkflowServiceRunView,
			DeepReadonly<Static<typeof WorkflowServiceRunViewSchema>>
		>
	>,
];

export type AuthoringApiPins = [
	Assert<
		Equal<
			Parameters<typeof defineWorkflow>,
			[WorkflowDefinitionOptions<TSchema, TSchema>]
		>
	>,
	Assert<
		Equal<
			ReturnType<typeof defineWorkflow>,
			WorkflowDefinition<unknown, unknown>
		>
	>,
	Assert<
		Equal<
			keyof WorkflowDefinitionOptions<TSchema, TSchema>,
			"meta" | "inputSchema" | "outputSchema" | "run"
		>
	>,
	Assert<
		Equal<
			keyof WorkflowDefinition,
			"schema" | "meta" | "inputSchema" | "outputSchema" | "run"
		>
	>,
	Assert<Equal<WorkflowDefinition["schema"], "pi-workflow-definition">>,
	Assert<
		Equal<
			Parameters<typeof defineSupportTask>,
			[SupportTaskHelperOptions<TSchema, TSchema>]
		>
	>,
	Assert<
		Equal<
			ReturnType<typeof defineSupportTask>,
			SupportTaskHelper<TSchema, TSchema>
		>
	>,
	Assert<
		Equal<
			keyof SupportTaskHelperOptions<TSchema, TSchema>,
			| "name"
			| "moduleSpecifier"
			| "revision"
			| "implementationSha256"
			| "parametersSchema"
			| "outputSchema"
		>
	>,
	Assert<
		Equal<
			keyof WorkflowContext<unknown>,
			| "cwd"
			| "input"
			| "runId"
			| "signal"
			| "agent"
			| "checkpoint"
			| "fanIn"
			| "fanOut"
			| "finalize"
			| "handoff"
			| "log"
			| "phase"
			| "pipeline"
			| "result"
			| "results"
			| "settled"
			| "support"
			| "workflow"
		>
	>,
	Assert<Equal<WorkflowContext<unknown>["input"], unknown>>,
	Assert<Equal<WorkflowContext<{ a: 1 }>["input"], { a: 1 }>>,
	Assert<Equal<WorkflowContext<unknown>["runId"], WorkflowRunId>>,
	Assert<Equal<WorkflowContext<unknown>["cwd"], string>>,
	Assert<Equal<WorkflowContext<unknown>["signal"], AbortSignal>>,
	Assert<Equal<Parameters<WorkflowContext<unknown>["phase"]>, [string]>>,
	Assert<Equal<ReturnType<WorkflowContext<unknown>["phase"]>, void>>,
	Assert<Equal<Parameters<WorkflowContext<unknown>["log"]>, [string]>>,
	Assert<Equal<ReturnType<WorkflowContext<unknown>["log"]>, void>>,
	Assert<
		Equal<
			Parameters<WorkflowContext<unknown>["handoff"]>,
			[WorktreeTaskHandle<unknown>]
		>
	>,
	Assert<
		Equal<
			ReturnType<WorkflowContext<unknown>["handoff"]>,
			Promise<WorkflowHandoffDescriptor | undefined>
		>
	>,
	Assert<
		Equal<
			keyof CheckpointRequest<TSchema>,
			| "schema"
			| "prompt"
			| "default"
			| "headless"
			| "timeoutMs"
			| "disposition"
			| "after"
			| "inputs"
			| "replay"
		>
	>,
];

export type ExtensionApiPins = [
	Assert<
		Equal<
			WorkflowToolName,
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
			| "workflow_propose"
		>
	>,
	Assert<
		Equal<
			WorkflowRunAction,
			| "stop"
			| "wait"
			| "reconcile"
			| "invalidate"
			| "retry"
			| "resume"
			| "decide"
		>
	>,
	Assert<
		Equal<
			keyof WorkflowToolDeclaration,
			| "name"
			| "label"
			| "description"
			| "promptSnippet"
			| "promptGuidelines"
			| "parameters"
			| "output"
			| "execute"
			| "text"
			| "summarizeCall"
			| "summarizeResult"
		>
	>,
	Assert<Equal<WorkflowToolDeclaration["name"], WorkflowToolName>>,
	Assert<
		Equal<
			Parameters<WorkflowToolDeclaration["execute"]>,
			[WorkflowService, unknown]
		>
	>,
	Assert<
		Equal<Parameters<WorkflowToolDeclaration["summarizeCall"]>, [unknown]>
	>,
	Assert<Equal<ReturnType<WorkflowToolDeclaration["summarizeCall"]>, string>>,
	Assert<Equal<ReturnType<WorkflowToolDeclaration["summarizeResult"]>, string>>,
];

// Negative control: a deliberately wrong pin must fail, or the fixture proves
// nothing. Removing this directive's error (for example by making `Equal`
// permissive) fails the build with "Unused '@ts-expect-error' directive".
export type NegativeControl = Assert<
	// @ts-expect-error -- WorkflowServiceOptions has thirteen keys, not one.
	Equal<keyof WorkflowServiceOptions, "cwd">
>;
