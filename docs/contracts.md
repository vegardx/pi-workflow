# Contracts

The examples in this document are design contracts, not implemented APIs.

## Canonical static module

A saved workflow default-exports one object produced by `defineWorkflow`:

```ts
export default defineWorkflow({
	meta: {
		name: "example",
		description: "Example workflow",
		version: 1,
	},
	async run(ctx) {
		return await ctx.agent("answer", {
			agent: { name: "researcher" },
			task: { goal: "Answer", context: [], instructions: [] },
			contextMode: "fresh",
			execution: "foreground",
			workspace: { mode: "shared" },
			limits: { timeoutMs: 300_000 },
			outputSchema: AnswerSchema,
		});
	},
});
```

```ts
interface WorkflowDefinition<TInput = unknown, TOutput = unknown> {
	meta: { name: string; description: string; version: number };
	run(ctx: WorkflowContext<TInput>): Promise<TOutput>;
}
```

## Durable execution model

Static workflows are **re-executed from their entry point** after restart. The
context is an effect interpreter:

1. every effect has a mandatory stable key;
2. before executing an effect, the interpreter queries the journal;
3. a completed matching effect replays its validated result;
4. an active effect is reconciled or reattached;
5. a missing, changed, or invalidated effect executes live;
6. previously recorded effects not observed on the new path are retained as
   abandoned history and never silently applied.

The runtime does not persist JavaScript continuations. Workflow source identity,
effect inputs, and observed effect order are part of compatibility checks.
Nondeterministic workflows must disable replay for affected effects. Source
changes require an explicit resume policy and cannot reinterpret prior human
decisions automatically.

## Workflow context

```ts
interface WorkflowContext<TInput> {
	readonly input: TInput;
	readonly runId: string;
	readonly signal: AbortSignal;
	phase(name: string, options?: PhaseOptions): void;
	log(message: string): void;
	agent<T>(key: string, request: AgentTask<T>): Promise<T>;
	parallel<T>(tasks: readonly (() => Promise<T>)[], options?: ParallelOptions): Promise<T[]>;
	pipeline<T>(key: string, items: readonly T[], ...stages: PipelineStage[]): Promise<unknown[]>;
	workflow<T>(key: string, name: string, input: unknown): Promise<T>;
	support<T>(key: string, task: SupportTask<T>): Promise<T>;
	checkpoint<T>(key: string, request: CheckpointRequest<T>): Promise<T>;
	artifact<T>(key: string, value: T, schema?: JsonSchema): Promise<ArtifactRef>;
	finalize(key: string, finalizer: Finalizer): void;
}
```

`phase` is a progress label, not a schedulable stage. Tasks are effects created
by `agent`, `support`, nested `workflow`, checkpoint, pipeline materialization,
and finalizers.

Ordinary `await` creates a data dependency when a result is consumed. Explicit
artifact references make persisted data dependencies inspectable. An order-only
dependency uses `after` on the task request without supplying the dependency's
artifact.

```ts
interface TaskRequestBase {
	after?: TaskRef[];
	inputs?: ArtifactRef[];
	replay?: "auto" | "off" | "read-only";
}
```

## Agent task mapping

```ts
interface AgentTask<T> extends TaskRequestBase {
	agent: AgentSelector;
	task: DelegatedTask;
	contextMode: "fresh" | "fork";
	execution: "foreground" | "background";
	model?: ExactModelRequest;
	tools?: string[];
	extensions?: string[];
	skills?: string[];
	workspace: WorkspaceRequest;
	outputSchema?: JsonSchema<T>;
	limits: TaskLimits;
}
```

Workflow derives a deterministic subagent `operationId` from workflow run ID,
task execution ID, and attempt generation. It calls subagent preflight, persists
the resolved plan identity, then invokes `launch` with the preflight ID, expected
identity digest, workflow owner, operation ID, and current workflow fencing
generation. After a crash it uses `findByOperation` before creating another
child.

Structured output is owned by `SubagentService`: `outputSchema` requests the
terminating schema tool and returns validated `structuredOutput`. Workflow
revalidates imported values before artifact commit and replay.

## Task execution identity

```text
Workflow task
  Task execution generation
    Subagent run (agent tasks only)
      Subagent attempt
```

Retry creates a new task execution generation and normally a new subagent run.
Resume of a retained child calls subagent `resume` and records the resulting
attempt under the same task execution. Support tasks and checkpoints have their
own execution receipts.

## Service

```ts
interface WorkflowServiceV1 {
	readonly contract: WorkflowRuntimeContractV1;
	registerRoot(root: WorkflowRoot): Promise<void>;
	list(options?: ListOptions): Promise<WorkflowSummary[]>;
	validate(ref: string): Promise<ValidationResult>;
	run(ref: string, input: unknown, options?: RunOptions): Promise<RunReceipt>;
	status(runId: string): Promise<WorkflowStatus>;
	logs(runId: string, options?: LogOptions): Promise<WorkflowLogs>;
	wait(runId: string, options?: WaitOptions): Promise<WorkflowResult>;
	stop(runId: string, reason: string): Promise<StopReceipt>;
	retry(runId: string, taskKey: string, options?: RetryOptions): Promise<RunReceipt>;
	resume(runId: string, options?: ResumeOptions): Promise<RunReceipt>;
	reconcile(runId: string): Promise<ReconcileResult>;
}
```

## Required subagent features

```ts
interface WorkflowRuntimeContractV1 {
	schema: "pi-workflow-runtime-v1";
	apiVersion: 1;
	requiredSubagent: {
		apiVersion: 1;
		features: [
			"preflight",
			"idempotentLaunch",
			"structuredOutput",
			"ambientExtensionsControl",
			"resume",
			"worktrees",
		];
	};
	features: {
		staticWorkflows: boolean;
		dynamicWorkflows: boolean;
		parallel: boolean;
		pipelines: boolean;
		resume: boolean;
		replay: boolean;
		worktrees: boolean;
	};
}
```

## Checkpoints

```ts
interface CheckpointRequest<T> {
	schema: JsonSchema<T>;
	prompt: string;
	default?: T;
	headless: "block" | "use-explicit-default";
	expiresAt?: string;
}

interface CheckpointDecision<T> {
	checkpointId: string;
	workflowRunId: string;
	taskKey: string;
	definitionIdentity: string;
	approver: string;
	decidedAt: string;
	value: T;
}
```

Headless execution blocks unless the definition contains an explicit permitted
default. Decisions are immutable, auditable, schema-validated, and invalidated
when their bound definition/effect identity changes.

## Finalizers

```ts
interface Finalizer {
	kind: "required" | "advisory";
	run(ctx: FinalizerContext): Promise<void>;
}
```

Finalizers are stable-keyed effects. Required finalizers must settle before
success. Physical worktree/process cleanup remains subagent-owned; workflow
finalizers verify/import handoffs and call the service's idempotent `release`
operation rather than manipulating the worktree directly. Retained, blocked, or
unknown cleanup maps to workflow `cleanup-blocked` until release succeeds.

## States

```ts
type WorkflowRunStatus =
	| "created"
	| "running"
	| "waiting"
	| "finalizing"
	| "stopping"
	| "completed"
	| "completed-degraded"
	| "failed"
	| "cancelled"
	| "interrupted"
	| "cleanup-blocked";

type WorkflowTaskStatus =
	| "pending"
	| "ready"
	| "running"
	| "waiting"
	| "completed"
	| "failed"
	| "interrupted"
	| "blocked"
	| "cancelling"
	| "cancelled"
	| "invalidated";
```

Created/waiting/running/finalizing states may stop. Failed and interrupted tasks
may create a new execution generation by explicit policy. Cleanup-blocked is
terminal and never reported as degraded success. `completed-degraded` means all
required tasks/finalizers succeeded while explicitly optional tasks failed; the
result lists every degradation.
