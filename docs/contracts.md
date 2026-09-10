# Contracts

This document defines the target contracts. The exported static definition,
materializer, sequential scheduler, task finalizer, artifact store, and static
source runtime implement the current Phase 1 subset; later interfaces remain
design contracts.

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
		budget: { cost: 25, childRuntimeMs: 900_000 },
		timeoutMs: 1_800_000,
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
	meta: {
		name: string;
		description: string;
		version: number;
		budget: {
			cost: number; // provider-reported dollars
			totalTokens?: number; // all model traffic, including cache
			childRuntimeMs: number; // cumulative settled child runtime
		};
		timeoutMs: number; // workflow wall-clock deadline
		concurrency?: number;
	};
	inputSchema: JsonSchema<TInput>;
	outputSchema: JsonSchema<TOutput>;
	run(
		ctx: WorkflowContext<TInput>,
	): WorkflowReturn<TOutput> | Promise<WorkflowReturn<TOutput>>;
}

type WorkflowReturn<T> = T | TaskHandle<T> | ArtifactHandle<T>;
```

Concurrency defaults to 4 and has a hard maximum of 16. The workflow service
may lower the effective value but never raise the definition grant; the
effective value is persisted in the immutable run record before source
execution. Every definition also declares independent cost, cumulative
child-runtime, and wall-clock limits; an all-traffic token guard is optional.
The service defaults to a $1,000 maximum workflow cost. Embedders may lower
cost, total-token, child-runtime, and timeout limits. Declared and effective
limits plus the absolute deadline are persisted before execution. Before each launch, admission
requires:

```text
settled usage + active declared reservations + candidate declared maximum
  <= effective workflow budget
```

A configured workflow token budget therefore requires every admitted task to
declare `totalTokens`. Active reservations defer otherwise admissible work;
settled usage replaces each reservation. Incomplete usage evidence stops further
spending. Provider cost can still overshoot by one in-flight model response, so
a post-settlement overage fails the workflow. Reaching the persisted deadline
runs the normal stop/drain path; uncertain cleanup remains `cleanup-blocked`.

Inputs are validated before a run is created. The final value is validated and
committed as a provenance-bound workflow-owned artifact through a durable
`run-output-committed` event before the run completes. Restart from a persisted
output commit finishes the terminal run transition without reevaluating or
rewriting the output.

Contract revision 9 identities cover the complete definition module but not a
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
scheduler to run until the selected task settles and finalizes, revalidates its
workflow-owned artifact, and returns an immutable concrete value.
`ctx.results(handles)` is the bounded fail-fast multi-task barrier.
`ctx.settled(handles)` is a distinct persisted barrier returning
`{ status: "fulfilled", value }` or
`{ status: "rejected", taskId, outcome, failure? }` in declaration order.
Required-task failure still fails the workflow; rejected settled values are
therefore intended for tasks explicitly declared with optional disposition.
Merely constructing a handle never starts work synchronously in the workflow
function.

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
	fanOut<TItem, T>(
		namespace: string,
		items: readonly TItem[],
		options: {
			key(item: TItem, index: number): string;
			task(item: TItem, index: number): AgentTask<T>;
		},
	): readonly TaskHandle<T>[];
	fanIn<TSource, T>(
		key: string,
		sources: readonly TaskHandle<TSource>[],
		options: {
			inputKey(source: TaskHandle<TSource>, index: number): string;
			task: AgentTask<T>;
		},
	): TaskHandle<T>;
	pipeline<T>(
		namespace: string,
		build: (stage: PipelineStage) => TaskHandle<T>,
	): TaskHandle<T>;
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
	settled<const T extends readonly TaskHandle<unknown>[]>(
		tasks: T,
	): Promise<SettledResultTuple<T>>;
	finalize(key: string, finalizer: Finalizer): void;
}
```

`ctx.fanOut(namespace, items, options)` synchronously materializes at most 64
ordinary agent tasks in the named child namespace. The caller supplies a stable
item key and task factory; returned handles preserve input order. Namespace and
item keys participate in task identity, duplicate keys fail before an execution
barrier, and restart must reproduce the exact declaration prefix.

`ctx.fanIn(key, sources, options)` materializes one ordinary aggregate agent
from 1 to 64 source handles. The input-key callback must return unique stable
names; each source output becomes an explicit named artifact input and therefore
an order dependency. The supplied aggregate request may not define a competing
`inputs` field.

`ctx.pipeline(namespace, build)` invokes a synchronous namespace-scoped builder
that may declare at most 64 ordinary agent stages. Stages use explicit handles
and artifact inputs rather than implicit previous-result injection. The builder
must return one handle it created; that handle becomes the pipeline result.
Pipeline namespace and stage keys participate in ordinary task identity and
exact-prefix replay.

Settled-parallel is a typed authoring helper that materializes ordinary task
nodes and dependencies. They are not separate
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

JavaScript continuations are never serialized. The static runtime invokes the
workflow function from entry on every drive, matches phase/log effects and
materialization barriers against their persisted ordered prefix, and replays
completed result artifacts as concrete immutable values. Version 1 refuses
resume when the workflow source identity changed. More selective source-change policies
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
Before agent preflight, workflow resolves each named input from its own store,
requires the producer task to be complete, revalidates run and producer
provenance, schema identity, canonical encoding, size, content digest, and the
concrete value against the producer output schema. Inputs are sorted by name and
appended after author-supplied context as deterministic canonical JSON
envelopes containing the input name, `application/json` media type, digest,
untrusted-data handling marker, and value. Each context entry is at most 16 KiB;
the complete delegated context is at most 64 entries and 512 KiB. Projection
failure is durably terminalized before subagent preflight. The resulting
concrete `DelegatedTask` participates in the subagent launch-plan identity.
Unsupported media types or values exceeding the projection limit fail before
child launch. Future file or directory mounts require a new explicit subagent
contract and cannot silently use this projection.

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
4. calls preflight, validates tools, skills, and context scopes as canonical
   unique grants rather than order-sensitive arrays, and persists the resolved
   launch-plan identity plus planned subagent run and initial-attempt identities;
5. persists launch intent;
6. launches with the exact preflight identity;
7. persists the launch receipt.

The bounded scheduler selects committed tasks in materialization order and
persists readiness before calling the launcher. Independent tasks may run up to
the immutable effective run concurrency. Launch registration and journal
mutation remain serialized, while child waits run outside the mutation queue and
may settle in any order. One scheduler instance claims each active child once to
avoid duplicate waits; restart reconstructs active work from launch receipts.
Active children map tasks to `running`; queued or terminal children awaiting
required finalization map tasks to `waiting`; durable workflow stop intent maps
active tasks to `cancelling` before interruption and drains them without
exceeding the same durable lifecycle. Failed dependencies map pending dependents
to `blocked`.

The journal stores bounded child-settlement evidence and a digest of the complete
child result, not model output, structured values, session paths, or
subagent-private store paths. Imported structured output is represented by a canonical JSON workflow-owned
artifact. Its artifact identity binds the workflow run, producer task, output
name, schema digest, and content digest, so equal JSON from different producers
does not alias provenance. Child settlement alone does not complete a task:
completed children still require artifact import, and every terminal child
requires release before terminal execution and task events may be committed. Task lifecycle transitions remain separate events and may consume
terminal execution evidence only after that evidence is durable.

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

Stop writes run and task cancellation intent before calling the owner client's
`interrupt`. A restart that finds `stopping` retries the idempotent interruption
and waits for terminal child evidence; it never infers cancellation from a lost
in-memory wait. A task execution that was created or preflighted but has no
launch intent is terminalized as cancelled without launching. An uncertain
launch is reconciled through its operation ID before interruption.

`cleanup-blocked` remains until explicit workflow reconciliation calls the
owner client's subagent reconciliation, persists any replacement child
observation and settlement, and repeats release against that exact result.
A cleanup reconciliation that yields `interrupted` remains action-required
because Phase 1 does not authorize automatic child resume or abandonment; it
cannot be reported as success or ordinary failure. Release itself is an idempotent external effect with durable intent and receipt.
A crash after release intent retries release; a crash after its receipt resumes
from the receipt. If release proves cleanup and changes `cleanup-blocked` to a
terminal primary status, workflow persists the release receipt before replacing
its child observation and settlement evidence. Workflow does not infer a hidden
primary status from a subagent `cleanup-blocked` result.

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

The current extension exposes list, validate, run, status, wait, stop, and
reconcile. `run` validates trust, definition, input, and the shared subagent
provider before creating durable state, then returns a run ID immediately.
`status` is a journal projection, `wait` reconstructs nonterminal work after
restart, and `stop` persists run/task intent before delegated interruption.
Retry, explicit interrupted-run resume, logs, and polished inspection remain
later contract work.

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
