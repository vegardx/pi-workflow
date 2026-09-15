# Contracts

This document defines the target contracts. The exported static definition,
materializer, sequential scheduler, task finalizer, support task executor,
nested run executor, artifact store, and static source runtime implement the
current subset; later interfaces remain design contracts. The runtime contract
is revision 16 and declares the feature flags `supportTaskExecution: true`,
`nestedWorkflows: true`, `nestedArtifactInputs: true`, `retryAttempts: true`,
`resumeAttempts: true`, `executionGenerations: true`,
`transactionalInvalidation: true`, `finalizers: true`, and
`operatorAttempts: true`.

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

Contract revision 15 identities cover the complete definition module but not a
helper dependency graph. Static imports are limited to `@vegardx/pi-workflow`,
`typebox`, and the module specifiers present in the constructor-injected
support registry; every other static import, dynamic import, CommonJS require,
and TypeScript import assignment is rejected rather than silently omitted from
source identity. A support implementation is identified by its registered
explicit implementation digest, not by tracing its dependency graph.
Multi-file definition provenance remains future work.

## Support-task descriptors

Trusted packages define typed descriptor helpers and register the matching
implementation when constructing the workflow service:

```ts
export const jsonParse = defineSupportTask({
	name: "@vegardx/workflow-tools/json-parse",
	moduleSpecifier: "@vegardx/workflow-tools",
	revision: 1,
	implementationSha256: "<build-produced sha256>",
	parametersSchema: JsonParseParameters,
	outputSchema: ParsedValue,
});

export const jsonParseRegistration = jsonParse.registration(
	({ parameters, inputs, signal }) => parse(parameters, inputs, signal),
);

const parsed = ctx.support(
	"parse",
	jsonParse({
		parameters: { strict: true },
		inputs: { source: fetched.output },
	}),
);
```

The helper only creates a frozen declarative descriptor. It does not execute the
implementation. Materialization binds the implementation name, module
specifier, revision, explicit implementation digest, parameter/output schemas,
parameters, dependencies, and replay policy into task identity. Static workflow
imports remain denied unless their exact module specifier is present in the
constructor-injected support registry.

`ctx.support(key, descriptor)` is the only authoring surface. There is no
string-addressed API and no inline callback: the implementation is referenced
by descriptor identity and resolved at execution time from the registry. A
future dynamic frontend lowers the same descriptor into the same
`SupportTaskSpec`; the scheduler and executor never distinguish the frontend.

## Support-task execution

Declared support tasks are schedulable. The scheduler routes on
`task.spec.kind`; a support task skips budget admission and is prepared by the
support task executor, which runs the registered implementation in the host
process. No subagent, VM, worktree, model, or web request is involved. When no
executor is configured for the run, the task becomes `blocked` with the message
"Support task execution is not configured for this workflow run." and a
required task fails the run.

### Registry and identity

Implementations are supplied as `createWorkflowService({ supportTasks })`
registrations produced by `helper.registration(execute)`. The service validates
each registration, rejects duplicate names, and freezes the map. The registry
is authoritative and immutable, never persisted, and resolved again on every
restart. Resolution compares one canonical digest,
`deriveSupportImplementationIdentitySha256(spec.request.implementation)`,
with `supportRegistrationIdentity(registration)`; both hash the sorted-key
value of name, module specifier, revision, implementation digest, parameters
schema, and output schema. A close match is a mismatch. Resolution runs at
intent and again before execution or repair; failure at either point is a
terminal `support-resolution` failure, including during recovery.

### Purity contract

The implementation receives `{ parameters, inputs, signal }` and returns a
value. Because the runtime may recompute an intended execution after a crash,
every registered implementation must be:

- deterministic for identical parameters and inputs;
- side-effect free outside the return value;
- bounded in time and output size;
- cooperative with the supplied `AbortSignal`;
- free of network access, publication, Git mutation, process administration,
  and credential access.

The runtime verifies digests, schemas, bounds, and abort timing; it cannot
verify determinism or the absence of side effects.

### Execution record and evidence

```ts
type TaskExecutionRecord =
	| {
			kind: "agent";
			id: TaskExecutionId;
			runId: WorkflowRunId;
			taskId: WorkflowTaskId;
			generation: number;
			taskIdentitySha256: string;
			operationId: SubagentOperationId;
	  }
	| {
			kind: "support";
			id: TaskExecutionId;
			runId: WorkflowRunId;
			taskId: WorkflowTaskId;
			generation: number;
			taskIdentitySha256: string;
			implementationIdentitySha256: string;
	  }
	| {
			kind: "workflow";
			id: TaskExecutionId;
			runId: WorkflowRunId;
			taskId: WorkflowTaskId;
			generation: number;
			taskIdentitySha256: string;
			childRunId: WorkflowRunId;
	  };

interface SupportTaskTerminalEvidence {
	kind: "support";
	implementationIdentitySha256: string;
	parametersSha256: string;
	inputsSha256: string;
	outputSha256: string;
	artifactId: WorkflowArtifactId;
	durationMs: number; // diagnostic only
}
```

Support records carry no subagent operation ID; the workflow-kind record is
described under [Nested workflow tasks](#nested-workflow-tasks).
`parametersSha256` is the
canonical digest of `spec.request.parameters`; `inputsSha256` is the canonical
digest of `{ [inputName]: <sha256 of the producer's unique result artifact> }`
over `spec.inputs` (empty inputs hash `{}`); `outputSha256` is the result
artifact digest. The reducer recomputes each digest from journaled state and
rejects an event that disagrees.

### Event sequence

```text
task-execution-created (kind support)
→ task-execution-support-intended
    { implementationIdentitySha256, parametersSha256, inputsSha256 }
→ task-status-changed ready→running
→ artifact-declared (producerTaskId = task, output = "result",
    schemaSha256 = sha256 of implementation.outputSchema)
→ task-execution-support-output-committed { artifactId, outputSha256 }
→ task-execution-terminal (outcome completed, evidence kind support)
→ task-status-changed running→completed
```

The execution phases are `created → support-intended →
support-output-committed → terminal`. Intent is persisted under the scheduler
mutation lock before the `running` transition; the implementation runs outside
the lock, serialized per task. Before it runs, the executor recomputes
`inputsSha256` against the intent, reads every named input from the workflow
artifact store with provenance, digest, canonical-encoding, and producer-schema
revalidation, and revalidates `parameters` against the registered schema and
the intent digest. The returned value must be losslessly JSON serializable,
canonical bytes must not exceed the artifact bound, and the value must satisfy
both the persisted and the registered output schema. The output is written as
a content-addressed canonical JSON result artifact (idempotent), declared unless
already declared, committed, and terminalized.

Failure terminalizes with `evidence.kind === "workflow"` and a stage of
`support-resolution` (unregistered or drifted implementation),
`support-input` (missing input evidence, input digest mismatch, unreadable
inputs, or parameters failing the registered schema), `support-execution`
(the implementation threw; the persisted message is fixed and never contains
raw error text), or `support-output` (non-JSON, oversized, schema-invalid, or
conflicting output), followed by `running|ready → failed`. Failure stages are
accepted from phases `created`, `support-intended`, and
`support-output-committed`; agent stages are rejected on support executions
and support stages on agent executions. Cancellation terminalizes with stage
`stop` from `created` or `support-intended`, followed by `→ cancelled`. Support
tasks never enter `waiting` or `cancelling`, and `running → cancelled` is a
valid support transition. Persistence, journal, and lease errors are thrown,
never converted into task failure.

### Cost and concurrency

Support tasks invent no model usage: they reserve no cost, tokens, or child
runtime and settle no usage. A `running` support task occupies one concurrency
lane, exactly as an agent task with a launch receipt does. `durationMs` in the
terminal evidence is measured wall time (0 on repair) and is diagnostic only;
it participates in no budget or identity.

### Stop and deadline

Stop persists `stopping`, then aborts the scheduler stop signal, which is the
`signal` the implementation receives. A `running` support task that is not
executing in this process (for example after restart) is cancelled directly
through the executor. When a support task is still executing in this process,
the executor races the implementation against the signal, terminalizes the
task as `cancelled` at stage `stop` when abort wins, and discards a late result
from an implementation that ignores abort. Stop waits only for that bounded
executor drain, never for the implementation itself, and then continues to
cancel remaining tasks and reach a terminal run status. Ready or pending
support tasks with an execution record but no output are cancelled without
running. The service deadline calls the same stop path. Agent stop, interrupt,
subagent cleanup, and `cleanup-blocked` behavior are unchanged.

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
	support<TOutputSchema extends TSchema>(
		key: string,
		descriptor: SupportTaskDescriptor<TOutputSchema>,
	): TaskHandle<Static<TOutputSchema>>;
	workflow<TOutput = unknown>(
		key: TaskKey,
		request: NestedWorkflowRequest,
	): TaskHandle<TOutput>;
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
	finalize<TOutputSchema extends TSchema>(
		key: TaskKey,
		request: FinalizeRequest<TOutputSchema>,
	): TaskHandle<Static<TOutputSchema>>;
}

type FinalizerKind = "required" | "advisory";

interface FinalizeRequest<TOutputSchema extends TSchema> {
	readonly kind: FinalizerKind;
	readonly support?: SupportTaskDescriptor<TOutputSchema>;
	readonly agent?: AgentTaskAuthoringRequest<TOutputSchema>;
	readonly workflow?: NestedWorkflowRequest;
}
```

`ctx.finalize(key, request)` declares a finalizer task: exactly one of
`support`, `agent`, or `workflow` names the work, and `kind` lowers into the
task disposition (`required` → `required`, `advisory` → `optional`). The inner
request may not carry its own `disposition` ("finalizer disposition is its
kind"); a `kind` outside the two values is rejected ("invalid finalizer
kind"); naming zero or several of `support`, `agent`, and `workflow` is
rejected ("finalizer requires exactly one of support, agent, or workflow").
The returned handle exists so other finalizers may depend on it through
`after` or `inputs`; it is never a barrier target and never awaited by the
author. See [Finalizers](#finalizers).

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

`ctx.workflow(key, request)` declares a nested workflow task that runs another
discovered definition as a linked child run:

```ts
interface NestedWorkflowRequest<TInput = unknown> {
	readonly workflow: string; // child definition name
	readonly input: TInput; // authored JSON value
	readonly inputs?: Record<TaskKey, ArtifactHandle<unknown>>; // ≤ 64
	readonly disposition?: "required" | "optional";
	readonly after?: readonly TaskRef[];
	readonly replay?: "auto" | "off" | "read-only";
}
```

The child is resolved by name from the same discovery pass and trust gate as
the parent. The returned handle's `output` is an ordinary parent-owned result
artifact that later parent tasks may consume as a named input. `inputs` names
parent artifact handles exactly as agent and support requests do: each
producer must belong to the same run and already be declared, and each becomes
an order dependency. When `inputs` is empty, `input` is validated against the
child's input schema at declaration. When it is not, `input` must be a JSON
object with no key equal to an input name, and the verified artifact values
are merged into it as top-level keys at launch, where the merged object is
validated instead; see [Nested workflow tasks](#nested-workflow-tasks).

Settled-parallel is a typed authoring helper that materializes ordinary task
nodes and dependencies. They are not separate
execution runtimes.

## Materialized task graph

The effect interpreter lowers handles into a declarative durable graph. The
scheduler consumes only validated records, never workflow closures.

```ts
interface TaskSpecBase {
	key: string;
	kind: "agent" | "support" | "workflow";
	role: "task" | "finalizer";
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

`kind` is `"agent" | "support" | "workflow"` in revision 16; a checkpoint task
kind remains a design contract. `role` is `"task"` for every ordinary
declaration (`ctx.agent`, `ctx.support`, `ctx.workflow`, fan-out, fan-in, and
pipelines) and `"finalizer"` for `ctx.finalize`; it participates in task
identity. An ordinary task may not depend on a finalizer through `after` or
`inputs` ("ordinary task may not depend on a finalizer"); a finalizer may
depend on any declared task of either role. Keys are unique within a workflow
namespace.
Pipelines and fan-out create explicit child namespaces; a nested workflow task
is one node in its parent's namespace whose child run owns a separate graph.
Order dependencies use `after`; data dependencies use named artifact `inputs`.
Consuming an artifact implies order, but order alone never grants data access.

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
6. retain declarations, barriers, and effects abandoned by an invalidation as
   history that is never scheduled;
7. reject duplicate, ambiguous, reordered-incompatible, or changed effects.

Version 1 compares declarations by ordered materialization epoch. An epoch is
the declarations between entry/result barriers. Re-execution must reproduce the
same ordered `(namespace, key, identity)` prefix through every on-path
barrier. Insertion, removal, or reordering inside that prefix fails closed. A
new suffix is allowed after the last on-path barrier. Duplicate keys and
changed requests for an existing on-path key always fail.

Explicit invalidation (`task-invalidated`) names a cause task and carries the
exact closure and the exact abandoned epochs; the reducer recomputes both with
the exported `invalidationClosure` helper and rejects any other set. The
closure is the cause plus every transitive dependent through `after` and
`inputs`, abandoned tasks included, minus tasks already `invalidated`; the
cause itself must not already be `invalidated`. The exposing barrier is the
first on-path barrier whose `taskIds` intersect the closure. Every on-path
barrier with a higher epoch is abandoned together with every task declared in
those epochs and every effect sequenced after the exposing barrier; when no
on-path barrier exposes the closure, nothing is abandoned. Abandoned records
stay in the projection as history: they are never scheduled, never count as
unsettled or required work, never satisfy or block dependencies of path tasks,
and their settled usage still counts against the budget.

After an invalidation the on-path prefix (non-abandoned tasks in
materialization order, non-abandoned barriers in epoch order) must replay
exactly; an invalidated path task is re-materialized (`task-status-changed`
`invalidated → pending`, reason "Explicit invalidation re-executes the task.")
when its epoch's barrier is matched. Beyond the prefix the new path may declare
a divergent suffix. Abandoned epochs keep their numbers; new epochs are
numbered from the run's current epoch upward, after every persisted barrier,
and a new declaration takes materialization sequence `max + 1` over every
persisted task. A new declaration whose `(namespace, key)` matches an
abandoned task with an equal `identitySha256` readopts that task: the
`task-declared` event re-declares the same task ID with fresh sequence, epoch,
and position fields, keeps its status, commit, and current execution, and
re-materializes it in the same commit when it was `invalidated`. A matching
key with a different identity fails closed with "abandoned task key
re-declared with a changed request". Keys of path tasks remain duplicates.

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
	retry?: { attempts: number; on?: readonly ("backoff" | "manual")[] };
	resume?: { attempts: number };
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
An optional task or advisory finalizer left `blocked` by a failed dependency
counts as settled for completion and degrades the run the same way.

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
workflow run ID, task ID, and task-execution generation. Generations are
contiguous: `task-execution-created` accepts `generation = 1 + (executions
already recorded for the task)` up to `MAX_TASK_EXECUTION_GENERATIONS = 16`,
requires the task `ready` and on-path, and requires the task to have no
current execution: re-materialization detaches the terminal previous
execution, and the new execution becomes `currentExecutionId` when it is
created. Prior executions and their evidence are retained.
Generation 2 and later exist only for a task re-materialized after explicit
invalidation. One agent task execution corresponds to one subagent run
and may contain multiple subagent attempts: the initial attempt plus the retry
and resume attempts described under
[Retry and resume attempts](#retry-and-resume-attempts). Before its initial
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
to `blocked`. Run status `waiting` means no committed task is currently
selectable by the lane that observed it; other lanes may still be executing
agent children or in-process support tasks.

The journal stores bounded child-settlement evidence and a digest of the complete
child result, not model output, structured values, session paths, or
subagent-private store paths. Imported structured output is represented by a canonical JSON workflow-owned
artifact. Its artifact identity binds the workflow run, producer task, producer
execution, output name, schema digest, and content digest, so equal JSON from
different producers or generations does not alias provenance. Child settlement
alone does not complete a task:
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

### Retry and resume attempts

An agent request may declare attempt policies:

```ts
interface AgentRetryPolicy {
	attempts: number; // 1..10, at most limits.retries
	on: Array<"backoff" | "manual">; // defaults to ["backoff"], sorted
}

interface AgentResumePolicy {
	attempts: number; // 1..10, at most limits.resumes
}
```

The materializer normalizes `retry.on` to `["backoff"]` when omitted and sorts
it, rejects `retry.attempts > limits.retries` with "agent retry policy exceeds
the declared retry limit", and rejects `resume.attempts > limits.resumes` with
"agent resume policy exceeds the declared resume limit". The normalized
policies are part of the persisted request and therefore of task identity; a
changed policy is a changed request. The public schemas are
`AgentRetryPolicySchema` and `AgentResumePolicySchema`.

A retry is a fresh pi-subagent attempt on the same child run obtained through
the owner client's `retry(runId)`; a resume is the same through
`resume(runId)` for an `interrupted` child. Both are recorded under the same
task execution: the generation is unchanged, and no new preflight, operation
ID, or subagent run is created. A retry requires a durable `failed` settlement
whose
classified failure is `backoff` or `manual` and listed in `retry.on`; a resume
requires a durable `interrupted` settlement whose classified failure is
`resume`. Failures classified `never` or `reconcile` never enter the attempt
path. Attempts happen after the settlement and before release; the task stays
`running` or `waiting` and never becomes `failed` or `interrupted` between
attempts.

Three events extend the agent execution ladder:

```text
task-execution-attempt-intended
    { executionId, subagentRunId, kind: "retry" | "resume", ordinal,
      previousAttemptId, failureCode, failureRetry }
task-execution-attempt-receipted
    { executionId, subagentRunId, ordinal, subagentAttemptId, status }
task-execution-attempt-declined
    { executionId, subagentRunId, ordinal, reason }
```

`ordinal` numbers attempts from 2 (the initial attempt is 1) up to
`MAX_TASK_ATTEMPTS = 21`. The execution phase `attempt-intended` follows
`settled`; a receipt returns the execution to `launched`, and a decline returns
it to `settled`. The projection gains `attempts` (one entry per intent with
`kind`, `ordinal`, `previousAttemptId`, and, once known, `subagentAttemptId`,
`status`, and the intent, receipt, and declined sequences), `priorSettlements`
(the superseded attempts' settlement evidence in order), and `attemptsClosed`
(set by a decline; no further intents are accepted). `SubagentTerminalEvidence`
carries the required `attemptOrdinal` of the settlement it describes, so
terminal evidence for a completed or failed agent execution names the final
attempt. `currentSubagentAttemptId(execution)` is the last receipted attempt's
ID, else the launch receipt's attempt ID; the scheduler and finalizer wait on
and release that attempt.

The reducer accepts an intent only when the execution is an agent execution in
phase `settled`, `attemptsClosed` is unset, the run is `running` or `waiting`
(never `stopping`), `subagentRunId` equals the launch receipt's run,
`previousAttemptId` equals the current attempt ID, `ordinal` equals
`2 + attempts.length` and does not exceed `MAX_TASK_ATTEMPTS`, the settlement
status and classification match the kind, `failureCode` and `failureRetry`
equal the settlement's failure, the task spec carries the matching policy with
`failureRetry` listed in `retry.on` for a retry, and the number of receipted
attempts of that kind is below `policy.attempts`. A receipt must match the open
attempt's ordinal and run, and its `subagentAttemptId` must differ from
`previousAttemptId` and from every earlier attempt; it moves the current
settlement to `priorSettlements`, clears the observation, and records the new
attempt as current. A decline must match the open attempt's ordinal; it sets
`attemptsClosed` and keeps the settlement. A `task-execution-child-observed`
event must name the current attempt, a `task-execution-child-settled` event
must carry `attemptOrdinal === 1 + receipted attempts`, and an execution in
`attempt-intended` cannot be released.

Budget treats one execution as one reservation: declared limits are
cumulative, every attempt's settlement evidence is retained, and settled usage
is `settledAgentUsage(execution)`, the sum of cost, total tokens, and runtime
over `priorSettlements` and `settlement`, complete only when every settlement
is complete. Admission and the post-settlement overage check both use that
sum.

The task retrier (`createWorkflowTaskRetrier({ journal, binding, signal,
deadlineAt? })`) drives attempts. After a durable settlement the scheduler
asks it to `consider` the task: it persists the intent, calls `retry` or
`resume` on the owner client, persists the receipt, and the scheduler waits on
the new attempt exactly like the initial launch. Backoff is enforced by
pi-subagent: a `RetryBackoffError` carries `retryAt`, and the retrier waits
until then, bounded by the scheduler stop signal and the workflow deadline,
before calling again. A stop signal or deadline before the call declines the
intent with "Workflow stop requested before the attempt." or "Workflow
deadline passed before the attempt."; a backoff that would end at or after the
deadline is declined the same way. Any other rejection is reconciled through
`findByOperation`: a receipt whose attempt ID differs from `previousAttemptId`
is adopted, otherwise the intent is declined with "Subagent refused the
attempt." (or "Attempt call ended without a durable receipt." when the call
returned nothing). A reconciliation error is thrown, never converted into a
decline. Stop declines any open intent before finalization.

Every attempt intent carries `origin`. The retrier writes `origin: "policy"`
and no `reason`; a policy intent that carries a `reason` is rejected ("policy
attempt intent may not carry a reason"). Revision 16 additionally admits
`origin: "operator"` intents in the reducer: they must be `resume` intents
("operator attempt intent requires a resume") against the task's current,
on-path, non-invalidated execution ("operator attempt intent targets a
superseded execution") whose settlement is `interrupted` with `retry:
"resume"` and which has no release intent or receipt ("operator attempt intent
requires an unreleased interrupted execution"), while the run is `running`,
`waiting`, or `interrupted` ("operator attempt intent requires a running or
interrupted workflow run"). An operator intent may reopen an execution already
terminalized `interrupted`, may carry a `reason`, and is not bound by the
task's `resume` policy or by a prior decline; ordinal contiguity and the
previous attempt ID still apply. The attempt projection records `origin` and
`reason`, and `interrupted -> running` is admitted while such an intent is
open without invalidated work. No service method or tool appends operator
intents in revision 16; that operator resume surface arrives later.

## Nested workflow tasks

A nested workflow task (`kind: "workflow"`) runs another discovered definition
as a **linked child run**: a separate durable workflow run with its own
journal, lease, artifact store, subagent owner binding
`pi-workflow:<childRunId>`, budget, and deadline. The parent scheduler routes
the task by kind to the nested run executor, which launches, waits for, and
imports from the child through the service's nested run provider. There is no
second scheduler class and no persisted continuation: the child re-executes its
own trusted source from entry exactly like a root run.

### Authoring and declaration

`ctx.workflow(key, { workflow, input, inputs?, disposition?, after?, replay? })`
resolves the child by name from the same discovery pass and trust gate as the
parent. At declaration the runtime captures the child's identity, source
digest, version, input and output schemas, declared budget, timeout, and
concurrency, resolves every named artifact input to its producer, and lowers
everything into the persisted spec:

```ts
interface NestedWorkflowTaskSpec {
	key: string;
	kind: "workflow";
	disposition: "required" | "optional";
	after: TaskRef[];
	inputs: Record<string, ArtifactRef>; // ≤ 64 named parent artifacts
	replay: "auto" | "off" | "read-only";
	request: {
		definitionName: string;
		definitionIdentitySha256: string;
		definitionSourceSha256: string;
		definitionVersion: number;
		input: unknown; // authored input only
		inputSha256: string; // canonical digest of the authored input
		inputSchema: JsonSchemaDocument;
		outputSchema: JsonSchemaDocument;
		budget: WorkflowBudget; // the child's declared meta.budget
		timeoutMs: number;
		concurrency: number;
	};
	identitySha256: string;
}
```

Task identity hashes the same canonical envelope as support tasks (contract
revision, parent definition identity, parent input digest, namespace, and the
spec without its identity); the reducer re-derives it on `task-declared` and
requires `inputSha256` to equal the digest of the authored `input`. The nested
result is an ordinary parent-owned artifact and may be consumed by later parent
tasks as a named input. Because the child's identity and source digest are
part of the task identity, child source drift fails replay of the parent as
declaration drift.

`inputs` follows the same rules as agent and support inputs: at most 64 names,
each a valid task key, each producer a task of the same run declared before
the nested task, and each producer added to `after` as an order dependency.
The reducer applies the generic input checks on `task-declared` (the producer
exists in the run and every data dependency has its order dependency).
Declaration-time validation depends on whether `inputs` is empty:

- empty `inputs`: the authored `input` is validated against the child's input
  schema at declaration, unchanged from earlier revisions;
- non-empty `inputs`: the authored `input` must be a JSON object
  ("Nested workflow artifact inputs require an object input.") and no authored
  key may equal an input name ("Nested workflow input name collides with the
  authored input."); validation against the child's input schema is deferred to
  launch because the artifact values are not known at declaration.

### Launch-time input resolution

At launch the nested run executor resolves the child input before persisting
intent. For every declared input it locates the producer's unique `result`
artifact in the parent journal, reads the value through the same verified path
as agent and support inputs (`readWorkflowArtifactInputs`: provenance, digest,
canonical encoding, and producer-schema revalidation from the parent-owned
store), and merges the values into the authored input as top-level keys
(`{ ...input, [name]: value }`). The merged object must be losslessly JSON
serializable, must not exceed the 900 KiB nested input bound, and must satisfy
`request.inputSchema`. The child is launched with the merged value and sees it
as plain `ctx.input`; it has no handle to, and no read path into, the parent
store. When `inputs` is empty the authored input is launched unchanged.

Bounds are fixed: `MAX_NESTED_WORKFLOW_DEPTH = 4`, so runs exist at depth 0
through 3 and a run at depth 3 may not declare workflow tasks;
`MAX_NESTED_WORKFLOW_TASKS = 64` workflow tasks per run, enforced by the
materializer and the reducer; and a child whose definition identity equals the
declaring workflow or any ancestor on the chain is rejected at declaration as
recursion. Unbounded recursion remains a non-goal.

### Execution record, events, and phases

The execution record is `kind: "workflow"` with a deterministic
`childRunId = deriveNestedWorkflowRunId(parentRunId, taskId, generation)`,
which the reducer verifies on `task-execution-created`. Four
`task-execution-nested-*` events extend the execution ladder:

```text
task-execution-created (kind workflow, childRunId)
→ task-execution-nested-intended
    { childRunId, definitionIdentitySha256, inputSha256, inputsSha256,
      resolvedInputSha256, budget, timeoutMs, deadlineAt, concurrency }
→ task-execution-nested-launched { childRunId }   // child record durable
→ task-status-changed ready→running
→ task-execution-nested-settled
    { childRunId, status, usage, usageComplete, outputArtifactId?, outputSha256? }
→ artifact-declared (producerTaskId = task, output = "result",
    schemaSha256 = sha256 of request.outputSchema)
→ task-execution-nested-output-imported
    { childRunId, artifactId, sourceArtifactId, sourceSha256 }
→ task-execution-terminal (outcome completed, evidence kind nested-workflow)
→ task-status-changed running→completed
```

Phases are `created → nested-intended → nested-launched → nested-settled →
nested-output-imported → terminal`. Intent and launch happen under the
scheduler mutation lock; the wait, settlement, and import run outside it,
serialized per task. The intent's budget, timeout, and concurrency may not
exceed the declaration, and `deadlineAt` must be within `timeoutMs` of the
event timestamp. `inputSha256` is the digest of the authored input and must
equal the declaration; `inputsSha256` is the canonical digest of
`{ [inputName]: <sha256 of the producer's unique result artifact> }` over
`spec.inputs` (empty inputs hash `{}`), which the reducer recomputes from
journaled artifact state and rejects on disagreement; `resolvedInputSha256` is
the canonical digest of the merged input actually launched. When `inputs` is
empty the reducer requires `resolvedInputSha256 === inputSha256`; when it is
not, the reducer accepts any well-formed digest because artifact contents are
not journaled and the merged value cannot be recomputed from events alone. The
executor, not the reducer, re-verifies that digest on resume. `outputArtifactId` and `outputSha256` are present exactly when
the child status is `completed` or `completed-degraded`; the import event
requires a parent-owned `application/json` artifact whose digest equals the
settlement's `outputSha256` and whose schema digest equals the digest of
`request.outputSchema`.

### Terminal evidence and outcome mapping

```ts
interface NestedWorkflowTerminalEvidence {
	kind: "nested-workflow";
	childRunId: WorkflowRunId;
	status: WorkflowRunStatus; // terminal only
	usage: { cost: number; totalTokens: number; childRuntimeMs: number };
	usageComplete: boolean;
	outputSha256?: string; // present iff status is completed*
	artifactId?: WorkflowArtifactId; // parent-owned import, iff completed*
}
```

`usage` is the sum of the child's subagent settlements and its own nested
settlements; `usageComplete` is false when any of them was incomplete. The
reducer requires the evidence to equal the settlement and, for completion, the
import.

| Child run status | Parent task outcome |
| --- | --- |
| `completed` or `completed-degraded`, output imported | `completed` |
| `failed` | `failed` |
| `cancelled` | `cancelled` |
| `interrupted` | `interrupted` |
| `cleanup-blocked` | `cleanup-blocked` |

Failure evidence of kind `workflow` on a workflow task uses stage
`nested-input` (an input's producer artifact is missing or ambiguous, the
authored input is not an object or collides with an input name, an input could
not be read and verified, or the merged input is not lossless JSON, exceeds
the 900 KiB bound, or fails the child's input schema; accepted from phases
`created` and `nested-intended`), `nested-resolution` (the child could not be
resolved exactly by name, identity, and source digest at launch),
`nested-launch` (no remaining time before the parent deadline, lease or record
creation failure, or an existing child run whose lineage, definition, input,
or injected input artifacts do not match the intent), or `nested-import` (the
child completed but its output could not be read, verified, validated, or
stored; outcome `cleanup-blocked`). Cancellation before launch uses stage
`stop`. Agent and support stages are rejected on workflow
tasks and vice versa. A required task that ends `failed` or `cancelled` fails
the run, `interrupted` interrupts it, and `cleanup-blocked` marks the run
`cleanup-blocked`.

### Budget, deadline, and concurrency

The child declares its own budget. Parent admission treats that declaration as
the candidate maximum: it must fit within the parent's effective budget after
settled usage and active reservations, and a parent token budget requires the
child to declare `totalTokens`. While the child runs (launched, not settled)
the parent reserves the intent budget; settlement replaces the reservation with
the child's summed usage. Incomplete child usage fails closed and stops further
spending. The child's effective budget is the minimum of its declaration, the
parent's reservation, and service caps; its effective concurrency is the
minimum of its declaration, the intent, and the service maximum. Because the
child's full declared budget is reserved at admission, a parent that performs
any agent or support work before launching a child must declare headroom above
the child's declared budget, or the child is deferred or blocked.

The child's deadline is the earlier of its own timeout and the parent's
deadline. The executor computes intent `timeoutMs` as the minimum of the
declared timeout and the time remaining before the parent deadline, and the
provider recomputes it at record creation; under one second at either point
fails the task at `nested-launch`. A `running` or `cancelling` nested task
occupies one parent concurrency lane.

### Stop, deadline, reconciliation, and recovery

Parent stop marks a launched nested task `cancelling`, stops the child run
through the provider, and waits for the child's terminal state through the same
settlement path before the parent reaches its own terminal status. The parent
deadline uses the same stop path, and the child deadline is never later than
the parent's. A task whose execution is `created` or `nested-intended` at stop
is terminalized `cancelled` at stage `stop` without launching.

Import failure yields `cleanup-blocked` at stage `nested-import`; explicit
parent reconciliation retries the import. A child that itself settled
`cleanup-blocked` is reconciled through parent reconciliation, which reconciles
the child run, waits for its new terminal status, appends a replacement
`task-execution-nested-settled` (accepted only from a `cleanup-blocked`
settlement), and continues as an ordinary settlement. Restart resumes a
launched child from its own durable state without launching again; the
recovery ladder is in
[Persistence and recovery](persistence.md#nested-execution-recovery).

Without a configured nested run provider, workflow tasks become `blocked` with
"Nested workflow execution is not configured for this workflow run." and a
required task fails the run. Nested tasks use `pending`, `ready`, `blocked`,
`running`, `cancelling`, `completed`, `failed`, `cancelled`, `interrupted`,
and `cleanup-blocked`; they never enter `waiting`.

## Identity hierarchy

```text
Workflow definition
  Workflow run (depth 0..3)
    Workflow task
      Task execution generation (kind agent | support | workflow)
        Subagent run (agent tasks only)
          Subagent attempt
        Support computation (support tasks only)
          Result artifact
        Child workflow run (workflow tasks only; depth + 1)
          Workflow task ... (same hierarchy)
          Imported result artifact
```

A workflow task of kind `workflow` owns one task execution whose deterministic
`childRunId` names the linked child run. The child run record persists `depth`
and `parent { runId, taskId, executionId, ancestorDefinitionIdentities,
inputArtifacts }`, so the lineage is recoverable from either side.
`inputArtifacts` maps each injected input name to
`{ runId, artifactId, sha256 }` of the parent artifact whose verified value
was merged into the child input (`{}` when none); every `runId` must equal
`parent.runId`. On resume an existing child record must match the launch's
`inputArtifacts` exactly, in addition to its lineage, definition identity,
source digest, and merged input. These identities are provenance records,
not references the child can dereference.

Retry calls the owner client's `retry` on the same subagent run and records
the fresh attempt under the same task execution; resume behaves likewise
through subagent `resume`. Both attempts sit under the subagent run of one
agent execution and add no level to the hierarchy above. Operator-triggered
retry remains later work. Re-execution after explicit invalidation is neither
retry nor resume: it creates a new task-execution generation and a new
preflight, idempotent operation ID, and subagent run, support computation, or
child workflow run. A result artifact binds to the execution that produced it:
`WorkflowArtifactRef.producerExecutionId` is required exactly when
`producerTaskId` is present, participates in `deriveWorkflowArtifactId`, and
must name an execution of the producer task. Every lookup of a task's result
artifact (completion, `taskInputsSha256`, delegated-context projection, and
nested input resolution) selects the artifact whose `producerExecutionId`
equals the task's `currentExecutionId`; artifacts of prior generations remain
history and valid provenance. Every identity and relationship is persisted
explicitly.

Subagent terminal outcomes map using both primary status and cleanup evidence:

| Subagent evidence | Workflow task outcome |
| --- | --- |
| `completed` and required artifacts imported, with cleanup proved/not-needed | `completed` |
| `failed` with cleanup proved/not-needed | `failed` |
| `cancelled` with cleanup proved/not-needed | `cancelled` |
| `interrupted` with cleanup proved/not-needed | `interrupted` |
| any retained, blocked, or unknown required cleanup | `cleanup-blocked`; preserve the observed subagent status/failure as evidence, block dependents, and mark the run cleanup-blocked |

Stop writes run and task cancellation intent before calling the owner client's
`interrupt` and before aborting in-process support work. A restart that finds `stopping` retries the idempotent interruption
and waits for terminal child evidence; it never infers cancellation from a lost
in-memory wait. A task execution that was created or preflighted but has no
launch intent is terminalized as cancelled without launching. An uncertain
launch is reconciled through its operation ID before interruption.

`cleanup-blocked` remains until explicit workflow reconciliation calls the
owner client's subagent reconciliation, persists any replacement child
observation and settlement, and repeats release against that exact result.
A cleanup reconciliation that yields `interrupted` remains action-required
because Phase 1 does not authorize automatic child resume or abandonment; it
cannot be reported as success or ordinary failure. An agent execution whose
settlement is `interrupted` and that admits no further attempt is never
released: the finalizer appends the `interrupted` terminal outcome directly
from the settled phase, moves the task to `interrupted` with reason
"Interrupted child retained for recovery; no release performed.", and moves
the run from `running`, `waiting`, or `finalizing` to `interrupted` when the
task is required (an optional task leaves the run alone). The child remains
recoverable in pi-subagent. A release intent on an `interrupted` settlement is
rejected ("interrupted child is not releasable"), and `interrupted` terminal
evidence requires the settled, unreleased execution ("interrupted terminal
evidence requires an unreleased settled execution"). Under stop, a
`cancelling` task whose child settles `interrupted` moves to `interrupted` and
counts as drained, so `stopping -> cancelled` may leave `interrupted` tasks
behind. Release itself is an idempotent external effect with durable intent and receipt.
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
	invalidate(
		runId: WorkflowRunId,
		causeTaskId: WorkflowTaskId,
		reason: string,
	): Promise<WorkflowStatus>;
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
restart and drives a durably `failed` or `interrupted` run whose on-path tasks
are `invalidated` (that run awaits explicit recovery), and `stop` persists
run/task intent before delegated interruption,
support abort, and child-run stop. Every run view carries `depth` and, for a
linked child run, `parent: { runId, taskId, inputArtifacts }`, where
`inputArtifacts` is the record's injected artifact identity map; a child run
is addressable by its own run ID for status, wait, stop, and reconcile. `createWorkflowService`
accepts an optional `supportTasks` registration list that becomes the frozen
constructor registry and supplies the nested run provider to every run it
composes.

`invalidate(runId, causeTaskId, reason)` is the only trigger for re-execution
and is exposed by the service, not yet by a Pi tool. It validates the run ID,
the task ID pattern, and a reason of 1 through 4096 characters, rejects with
`conflict` ("Workflow run is still being driven.") while an owned run's drive
has not settled and with `validation` ("Workflow run status does not admit
invalidation.") unless the run is durably `failed` or `interrupted`, refuses
nested child runs, runs that already hold on-path invalidated work awaiting
recovery, and runs whose deadline has passed (each `validation`), then
computes `invalidationClosure`, appends one `task-invalidated` event carrying
the exact closure and abandoned epochs, appends the recovery transition
`failed|interrupted → running` (reason "Explicit invalidation re-executes
invalidated tasks."), restarts the drive without awaiting it (`wait` observes
it), and returns the current view, whose status is already `running`; reducer
rejections surface as `validation`. If the process crashes between the two
appends, the restarted static runtime repairs the gap by appending the same
transition when it finds a `failed` or `interrupted` run with at least one
on-path `invalidated` task; otherwise the existing explicit-recovery refusal
stands. Every
run view carries `tasks` once events exist: one entry per declared task in
materialization order with `id`, `namespace`, `key`, `kind`, `status`,
`generation` (the highest generation recorded for the task, or 0), and
`abandoned: true` for abandoned history.
Declarative retry and resume attempts run under task policy without a service
call. Operator-triggered `retry`, explicit interrupted-run `resume`, logs, and
polished inspection remain later contract work.

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

Finalizers are ordinary declarative tasks with `role: "finalizer"`, declared
through `ctx.finalize(key, { kind, support | agent | workflow })` and lowered
into the same `AgentTaskSpec`, `SupportTaskSpec`, or `NestedWorkflowTaskSpec`
records as ordinary tasks, so they share the materializer's key, namespace,
limit, schema, and authority validation, identity derivation, exact-prefix
replay, budgets, concurrency lanes, and execution ladders. `kind: "required"`
lowers to `disposition: "required"` and `kind: "advisory"` to
`disposition: "optional"`; the request may not set its own disposition.

Finalizers are never barrier targets: `ctx.result`, `ctx.results`,
`ctx.settled`, and the final barrier reject a finalizer handle ("a finalizer
cannot be a barrier target"), and the reducer rejects a `barrier-reached`
naming one. Ordinary tasks may not depend on finalizers; finalizers may depend
on ordinary tasks and on other finalizers.

The runtime drives finalizers itself, after the ordinary graph. Once the final
barrier's ordinary work has settled, the run moves `running -> finalizing`
(rejected while an ordinary required task is incomplete or any ordinary task
is still `pending`, `ready`, `running`, `waiting`, or `cancelling`: "run
finalized while ordinary tasks remain active") and commits the workflow
output (`run-output-committed`). Only then may a finalizer become `ready` and
receive an execution ("finalizer became ready outside finalizing", "finalizer
execution requires a finalizing workflow run"); ordinary tasks may become
`ready` or receive an execution only while the run is `running` or `waiting`
("task became ready outside a running workflow run", "task execution requires
a running workflow run"). The scheduler selects only finalizers while the run
is `finalizing`, never flips `finalizing` to `waiting`, and reports
`{ state: "idle", runStatus: "finalizing" }` when none is selectable; a
finalizer whose dependency failed becomes `blocked`.

When every finalizer is settled the run moves `finalizing -> completed`, or
`finalizing -> completed-degraded` when any optional task or advisory
finalizer did not complete (a `blocked` advisory finalizer included). A
required finalizer that fails moves the run `finalizing -> failed`; one that
is interrupted moves it `finalizing -> interrupted`; one left `blocked` fails
the run through the static runtime ("Required finalizer did not complete:
blocked."). After the output commit, `task-invalidated` may cover only
finalizers ("invalidation after output commit may only cover finalizers"),
because the output is never recommitted; recovery of a failed or interrupted
finalizer invalidates it, re-materializes it at the final barrier, matches the
existing output artifact, re-enters `finalizing`, and re-executes the
finalizer as its next generation.

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
proved terminal outcome. It is never degraded success. Support tasks use only
`pending`, `ready`, `blocked`, `running`, `completed`, `failed`, and
`cancelled`. Nested workflow tasks additionally use `cancelling`,
`interrupted`, and `cleanup-blocked` but never `waiting`.
`completed-degraded` requires every required task and required finalizer to
succeed while one or more optional tasks or advisory finalizers failed; all
degradations remain visible. Completion (`finalizing -> completed` or
`completed-degraded`) treats `completed`, `failed`, `cancelled`, `blocked`, and
`interrupted` tasks as settled, so an interrupted optional task or advisory
finalizer degrades completion rather than preventing it; `stopping ->
cancelled` likewise treats `interrupted` tasks as drained. Revision 16 adds the transitions `finalizing -> interrupted`
(a required finalizer's child was interrupted) and `cancelling -> interrupted`
(a task being stopped whose child settled `interrupted` and is retained
without release).

`invalidated` leaves only to `pending`, through the re-materialization event
appended when the task's epoch barrier is matched; that transition requires
the task's current execution to be absent or `terminal` and detaches it, so
the re-materialized task has no current execution until its next generation
is created. A run
leaves `failed` or `interrupted` for `running` only while at least one
on-path task is `invalidated` ("recovery requires invalidated work"); the
service's `invalidate` appends that transition, with reason "Explicit
invalidation re-executes invalidated tasks.", immediately after
`task-invalidated`, and the static runtime appends the same transition before
materialization replay only when it finds the run still `failed` or
`interrupted` with on-path invalidated work. Abandoned
tasks carry `abandoned: true` in the projection, keep their last status, and
may neither change status nor execute.
