# Contracts

The examples in this document are design contracts, not implemented APIs.

## Static definition

A saved workflow uses a `.workflow.ts`, `.workflow.mts`, `.workflow.js`, or
`.workflow.mjs` filename and default-exports one object produced by
`defineWorkflow`:

```ts
export default defineWorkflow({
	meta: {
		name: "example",
		description: "Example workflow",
		version: 1,
	},
	inputSchema: InputSchema,
	outputSchema: OutputSchema,
	async run(ctx) {
		const answer = ctx.agent("answer", {
			agent: "researcher",
			task: {
				goal: "Answer the question",
				context: [ctx.input.question],
				instructions: ["Return only supported conclusions."],
			},
			contextMode: "fresh",
			tools: ["read", "grep", "find", "ls"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: ctx.cwd },
			limits: limits.readOnly,
			outputSchema: AnswerSchema,
		});
		return answer;
	},
});
```

```ts
interface WorkflowDefinition<TInput, TOutput> {
	meta: { name: string; description: string; version: number };
	inputSchema: JsonSchema<TInput>;
	outputSchema: JsonSchema<TOutput>;
	run(
		ctx: WorkflowContext<TInput>,
	): WorkflowReturn<TOutput> | Promise<WorkflowReturn<TOutput>>;
}

type WorkflowReturn<T> = T | TaskHandle<T> | ArtifactHandle<T>;
```

Inputs are validated before a run is created. The final value is validated and
committed as a workflow-owned artifact before the run completes.

Contract revision 1 identities cover the complete definition module but not a
helper dependency graph. Static imports are limited to
`@vegardx/pi-workflow` and `typebox`; every other static import, dynamic import,
CommonJS require, and TypeScript import assignment is rejected rather than
silently omitted from source identity. Bundle-contained helper provenance is
added before support tasks or multi-file definitions ship.

## Authoring handles

TypeScript is the authoring frontend. Effect calls synchronously declare
validated nodes and return opaque, non-thenable handles. They do not return
model results directly.

```ts
interface TaskHandle<T> {
	readonly ref: TaskRef;
	readonly output: ArtifactHandle<T>;
}

interface ArtifactHandle<T> {
	readonly ref: {
		runId: WorkflowRunId;
		producerTaskId: WorkflowTaskId;
		output: "result";
	};
}
```

Concrete values cross an explicit execution barrier:

```ts
const review = ctx.agent("review", reviewRequest);
const decision = await ctx.result(review);

if (!decision.approved) {
	return ctx.agent("fix", fixRequest);
}
return review;
```

`ctx.result(handle)` persists all currently materialized nodes, allows the
scheduler to run until the selected task settles, revalidates its artifact, and
returns the concrete value. `ctx.results(handles)` is the bounded multi-task
barrier. Merely constructing a handle never starts work synchronously in the
workflow function.

## Workflow context

```ts
interface WorkflowContext<TInput> {
	readonly input: TInput;
	readonly runId: WorkflowRunId;
	readonly cwd: string;
	readonly signal: AbortSignal;
	phase(name: string): void;
	log(message: string): void;
	agent<T>(key: string, request: AgentTask<T>): TaskHandle<T>;
	support<T>(key: string, request: SupportTask<T>): TaskHandle<T>;
	workflow<T>(key: string, request: NestedWorkflowTask<T>): TaskHandle<T>;
	checkpoint<T>(key: string, request: CheckpointRequest<T>): TaskHandle<T>;
	artifact<T>(
		key: string,
		value: T,
		schema: JsonSchema<T>,
	): ArtifactHandle<T>;
	result<T>(task: TaskHandle<T>): Promise<T>;
	results<const T extends readonly TaskHandle<unknown>[]>(
		tasks: T,
	): Promise<ResultTuple<T>>;
	finalize(key: string, finalizer: Finalizer): void;
}
```

Pipelines, fan-out, fan-in, and settled-parallel are typed authoring helpers
that materialize ordinary task nodes and dependencies. They are not separate
execution runtimes.

## Materialized task graph

The effect interpreter lowers handles into a declarative durable graph. The
scheduler consumes only validated records, never workflow closures.

```ts
interface TaskSpecBase {
	key: string;
	kind: "agent" | "support" | "workflow" | "checkpoint";
	disposition: "required" | "optional";
	after: TaskRef[];
	inputs: Record<string, ArtifactRef>;
	replay: "auto" | "off" | "read-only";
	identitySha256: string;
}

interface MaterializedTask {
	id: WorkflowTaskId;
	namespace: string[];
	spec: TaskSpec;
	definitionIdentity: string;
	materializationSequence: number;
	materializationEpoch: number;
	epochPosition: number;
}
```

Keys are unique within a workflow namespace. Nested workflows, pipelines, and
fan-out create explicit child namespaces. Order dependencies use `after`; data
dependencies use named artifact `inputs`. Consuming an artifact implies order,
but order alone never grants data access.

A materialization epoch validates keys, dependency ownership, schemas, limits,
and authority before appending ordered `task-declared` events followed by one
`barrier-reached` commit marker. A scheduler may execute only declarations in
an epoch closed by that marker. A crash between declarations and the marker
leaves a replayable but non-executable prefix.

## Complete and incremental DAGs

A workflow that declares tasks through handles before requesting values can
materialize its complete reachable DAG before execution:

```ts
const implementation = ctx.agent("implement", implementRequest);
const review = ctx.agent("review", {
	...reviewRequest,
	after: [implementation.ref],
	inputs: { implementation: implementation.output },
});
return review;
```

A workflow that branches on a concrete result materializes incrementally:

```text
declare review
→ persist declaration
→ execute review
→ replay validated review result into the workflow
→ evaluate branch
→ declare fix when required
```

Both forms produce the same task records. A complete graph is not claimed
before data-dependent control flow has been evaluated.

## Durable effect interpretation

Static workflows are re-executed from their entry point after restart:

1. validate the persisted definition, input, and runtime identities;
2. invoke `run` from the beginning;
3. compare each stable-keyed declaration with journaled materialization;
4. replay a matching completed effect or reconcile an active effect;
5. persist and schedule a new matching-path effect when absent;
6. retain invalidated downstream effects not observed on the new path as
   abandoned history;
7. reject duplicate, ambiguous, reordered-incompatible, or changed effects.

Version 1 compares declarations by ordered materialization epoch. An epoch is
the declarations between entry/result barriers. Re-execution must reproduce the
same ordered `(namespace, key, identity)` prefix through every still-valid
barrier. Insertion, removal, or reordering inside that prefix fails closed. A
new suffix is allowed after the last previously reached barrier. When explicit
invalidation re-executes an upstream task and replaces its concrete result, the
runtime first invalidates every transitively dependent downstream epoch; the
newly evaluated branch may then materialize a different suffix while the old
suffix remains abandoned history. Duplicate keys and changed requests for an
existing key always fail.

JavaScript continuations are never serialized. Version 1 refuses resume when
the workflow source identity changed. More selective source-change policies
require a later explicit contract.

## Agent tasks

The initial agent-task request is explicitly lowered into the current public
`pi-subagent` request. Phase 1 accepts only fresh context. Fork context remains
unavailable until workflow persists and replays the authorized parent session
identity required by the subagent owner contract. Workflow-only dependency, disposition, and replay fields
are consumed by the materializer; the adapter derives the required operation ID
and concrete delegated context. It does not forward unknown fields or invent
background execution or arbitrary child extensions unsupported by the service.

```ts
interface AgentTask<T> extends TaskRequestBase {
	agent: string;
	task: DelegatedTask;
	contextMode: "fresh";
	model?: ExactModelRequest;
	tools: string[];
	preloadSkills: string[];
	contextScopes: Array<"global" | "project">;
	workspace: WorkspaceRequest;
	outputSchema: JsonSchema<T>;
	limits: RunLimits;
}

interface TaskRequestBase {
	disposition?: "required" | "optional";
	after?: TaskRef[];
	inputs?: Record<string, ArtifactHandle<unknown>>;
	replay?: "auto" | "off" | "read-only";
}
```

Disposition defaults to `required` and participates in task identity. Failure
of an optional task is observable but does not block unrelated required tasks.
A run may become `completed-degraded` only after every required task and
required finalizer succeeds while an optional task or advisory finalizer failed.

`pi-subagent` accepts delegated context strings, not workflow artifact handles.
Before agent preflight, workflow exports each declared input from its own store,
revalidates its schema and digest, and appends a deterministic bounded context
entry containing the input name, media type, digest, and canonical JSON or text
value. The resulting concrete `DelegatedTask` is part of preflight and replay
identity. Unsupported media types or values exceeding the projection limit fail
before child launch. Future file or directory mounts require a new explicit
subagent contract and cannot silently use this projection.

Workflow derives deterministic task-execution and subagent operation IDs from
workflow run ID, task ID, and task-execution generation. Generation 1 is the
only executable generation in the initial slice; later generations require the
transactional invalidation contract. One agent task execution corresponds to
one subagent run and may contain multiple subagent attempts. Before its initial
launch it:

1. acquires the extension-owned service from
   `@vegardx/pi-subagent/service-provider`;
2. checks the exact runtime contract revision and required feature values;
3. binds an owner client to the workflow run;
4. calls preflight and persists the resolved launch-plan identity;
5. persists launch intent;
6. launches with the exact preflight identity;
7. persists the launch receipt.

The journal stores bounded terminal evidence and a digest of the complete child
result, not model output, structured values, session paths, or subagent-private
store paths. Imported structured output is represented by a workflow-owned
artifact and its digest. Task lifecycle transitions remain separate events and
may consume terminal execution evidence only after that evidence is durable.

After uncertain launch outcome it calls `findByOperation` before any new launch.
The same recovery runs when restart finds durable launch intent without a
receipt. A recovered receipt is persisted without calling launch again. A
terminal no-child failure requires durable operation-absence evidence; an
uncertain launch alone can never terminalize the execution. Preflight grants
may be reused only within their unexpired workflow fencing generation, because
the subagent service intentionally keeps grants in process memory. Structured output
remains subagent-owned at execution time. Workflow accepts
only JSON-serializable output-schema documents within the runtime's bounded
16-level schema-value depth, then revalidates and imports the value and every
downstream artifact into workflow-owned storage before task completion.

## Identity hierarchy

```text
Workflow definition
  Workflow run
    Workflow task
      Task execution generation
        Subagent run (agent tasks only)
          Subagent attempt
```

Phase 3 retry control will call the owner client's `retry` on the same subagent
run and record the fresh attempt and VM under the same task execution. Resume
will behave likewise through subagent `resume`. Re-execution after dependency
invalidation is neither retry nor
resume: it creates a new task-execution generation and a new preflight,
idempotent operation ID, and subagent run. Every identity and relationship is
persisted explicitly.

Subagent terminal outcomes map using both primary status and cleanup evidence:

| Subagent evidence | Workflow task outcome |
| --- | --- |
| `completed` and required artifacts imported, with cleanup proved/not-needed | `completed` |
| `failed` with cleanup proved/not-needed | `failed` |
| `cancelled` with cleanup proved/not-needed | `cancelled` |
| `interrupted` with cleanup proved/not-needed | `interrupted` |
| any retained, blocked, or unknown required cleanup | `cleanup-blocked`; preserve the observed subagent status/failure as evidence, block dependents, and mark the run cleanup-blocked |

`cleanup-blocked` remains until subagent reconciliation/release proves cleanup
and returns a new result that can be mapped normally. Release itself is an
idempotent external effect with durable intent and receipt. Workflow does not infer a
hidden primary status from a subagent `cleanup-blocked` result.

## Workflow service

```ts
interface WorkflowServiceV1 {
	readonly contract: WorkflowRuntimeContractV1;
	registerRoot(root: WorkflowRoot): Promise<void>;
	list(options?: ListOptions): Promise<WorkflowSummary[]>;
	validate(ref: string): Promise<ValidationResult>;
	run(ref: string, input: unknown, options?: RunOptions): Promise<RunReceipt>;
	status(runId: WorkflowRunId): Promise<WorkflowStatus>;
	logs(runId: WorkflowRunId, options?: LogOptions): Promise<WorkflowLogs>;
	wait(runId: WorkflowRunId, options?: WaitOptions): Promise<WorkflowResult>;
	stop(runId: WorkflowRunId, reason: string): Promise<StopReceipt>;
	retry(
		runId: WorkflowRunId,
		taskKey: string,
		options?: RetryOptions,
	): Promise<RunReceipt>;
	resume(runId: WorkflowRunId, options?: ResumeOptions): Promise<RunReceipt>;
	reconcile(runId: WorkflowRunId): Promise<ReconcileResult>;
}
```

The first vertical slice may expose only list, validate, run, status, wait, stop,
and reconcile, but their persisted semantics must already match this contract.

## Checkpoints

```ts
interface CheckpointRequest<T> extends TaskRequestBase {
	schema: JsonSchema<T>;
	prompt: string;
	default?: T;
	headless: "block" | "use-explicit-default";
	expiresAt?: string;
}
```

Checkpoint decisions are immutable, schema-validated, and bound to workflow run,
task, definition, and effect identity. Headless execution blocks unless the
definition contains an explicit permitted default. Checkpoints are not part of
the first vertical slice.

## Finalizers

```ts
interface Finalizer {
	kind: "required" | "advisory";
	run(ctx: FinalizerContext): Promise<void>;
}
```

Finalizers are stable-keyed effects. Required finalizers settle before success.
Physical process and worktree cleanup remain subagent-owned. Workflow verifies
or imports required handoff evidence and invokes the subagent service's
idempotent release operation rather than manipulating a child worktree.

The current pi-subagent service exports output artifacts but not portable
worktree handoff content. The first workflow slice therefore accepts only
read-only agent workspaces. Worktree tasks remain unavailable until a later
subagent contract exposes a bounded, digest-verified handoff export that
workflow can import before release. Workflow never substitutes direct reads of
subagent-private paths or branches.

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
	| "cleanup-blocked"
	| "invalidated";
```

`cleanup-blocked` is an action-required blocked state: ordinary scheduling has
stopped, and only explicit reconciliation or release may transition it to a
proved terminal outcome. It is never degraded success.
`completed-degraded` requires every required task and required finalizer to
succeed while one or more optional tasks or advisory finalizers failed; all
degradations remain visible.
