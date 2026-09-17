# Contracts

This document defines the target contracts. The static definition,
materializer, sequential scheduler, task finalizer, support task executor,
nested run executor, artifact store, and static source runtime (exported from
`@vegardx/pi-workflow/runtime`) implement the current subset; later
interfaces remain design contracts. Version 1.0.0 freezes the public surfaces
listed under [Public API and stability](#public-api-and-stability). The
runtime contract is revision 19 and declares the feature flags `supportTaskExecution: true`,
`nestedWorkflows: true`, `nestedArtifactInputs: true`, `retryAttempts: true`,
`resumeAttempts: true`, `executionGenerations: true`,
`transactionalInvalidation: true`, `finalizers: true`,
`operatorAttempts: true`, `worktrees: true`, `checkpoints: true`, and
`dynamicWorkflows: true`. Revision 18 bundled two halves under one contract
revision: checkpoints and dynamic workflows, both described in this document.
Revision 19 adds no feature flag. It advances the pi-subagent handshake to
contract revision 7, whose features include `handoffExport: true`,
`vmMemoryCeiling: true`, and `workspaceBudgetRefusal: true`, and admits the
optional `memoryBytes` on an agent task request, which enters task identity.
`WORKFLOW_HANDOFF_FORMAT.revision` becomes 7 with it, so every handoff
artifact's `schemaSha256` changes. Revision-19 stores refuse revision-18
leases, journals, snapshots, run records, decision records, and dynamic
proposals; there is no migration.

## Public API and stability

`@vegardx/pi-workflow` 1.0.0 freezes four surfaces. A frozen surface is a set
of exported names whose TypeScript shape (parameters, return types, property
names, union members, schema fields) and documented behaviour do not change
except as described here.

1. **Authoring API** — `defineWorkflow`, `defineSupportTask`,
   `WorkflowContext` and every handle and request type, and the handle
   predicates, imported from `@vegardx/pi-workflow`.
2. **Service API** — `createWorkflowService`, `WorkflowServiceOptions`, every
   method of `WorkflowService`, `WorkflowServiceError`, and the view types and
   schemas those methods return.
3. **Contract layer** — the revision-19 request, spec, record, evidence,
   event, projection, and view schemas, the identity and bound constants,
   `WORKFLOW_RUNTIME_CONTRACT`, and the compatibility predicates.
4. **Extension entry** — the default export of
   `@vegardx/pi-workflow/extension`, the fourteen tools of
   `WORKFLOW_TOOL_DECLARATIONS` with their parameter and output schemas, the
   `/workflow` command grammar, the `pi-workflow` widget, and the `alt+w`
   inspector.

The complete list of frozen exports is
`test/fixtures/public-api/root-exports.json`; the pack check and
`test/public-api.test.ts` fail when the package deviates from it.

**Semantic versioning.** A change that removes or renames a frozen export,
narrows an accepted input, widens a returned union, removes a schema field,
changes a fixed message a caller is told to match, or changes a tool's name,
parameters, or output schema is breaking and requires a new major version.
Adding an export, an optional option, an optional view field, a tool, or a
`/workflow` subcommand is a minor version. Everything else is a patch.

**Runtime entry.** `@vegardx/pi-workflow/runtime` exports the engine:
reducer, scheduler, executors, static runtime, materializer, registry
discovery, stores, projections, predicates, identity derivations, and the
dynamic VM host. It is not frozen: its exports may change in any minor release
without notice beyond this document and the changelog. Authored workflows
cannot import it (the import gate accepts exactly `@vegardx/pi-workflow`,
`@vegardx/pi-workflow/components`, `typebox`, and registered support
modules). Embedders that import it accept that cost.

**Contract revision.** `WORKFLOW_CONTRACT_REVISION` is independent of the
package version. It increments when persisted records, event data, identity
derivations, the pi-subagent handshake, or the dynamic host API change in a
way an older revision must refuse; each revision is described in this document
and in `docs/compatibility.md`. A revision bump is a minor version when it
only adds optional fields, feature flags, or event types and every frozen
shape still type-checks; it is a major version when it changes or removes any
frozen shape. A frozen schema may therefore gain optional fields under a new
revision; it may not lose or retype fields under the same major.

**Persisted state.** Runs journaled by revision 18 are readable by every 1.x
release; a release that cannot read them is a major. Revision 19 cannot read
them, which is why the release that carries it is 2.0.0 and not 1.2.0. Runs
journaled by revision 19 are readable by every 2.x release under the same
rule.

**1.1.0.** Additive only: `WorkflowServiceOptions` gains the optional
`registeredRoots`, and the package ships its own `workflows/` directory, which
the extension registers as a `builtin` root (see
[Definition roots](#definition-roots)). No frozen export, shape, schema,
message, tool, or contract revision changed; `WORKFLOW_CONTRACT_REVISION`
stays 18.

**2.0.0.** `WORKFLOW_CONTRACT_REVISION` becomes 19 for the pi-subagent
revision-7 handshake, and `WORKFLOW_HANDOFF_FORMAT.revision` becomes 7 with
it. The major is decided by the persisted-state rule above and by nothing
else: revision-19 stores refuse revision-18 records and no migration is
offered, so a 1.x run directory cannot be read. Every frozen surface is
otherwise unchanged. The one schema change is additive and permitted under the
freeze: `AgentTaskRequestSchema` and `AgentTaskAuthoringRequest` gain the
optional `memoryBytes`, which is lowered unchanged to pi-subagent and enters
agent task identity. No export was removed, renamed, or retyped, no returned
union widened, and no tool name, parameter, or output schema changed.

**2.1.0 (unreleased).** Additive only; `WORKFLOW_CONTRACT_REVISION` stays 19.
Two entry points are added, both **unfrozen** until a later minor pins them:
`@vegardx/pi-workflow/components`, the component library, which the definition
import gate now accepts alongside `@vegardx/pi-workflow` and `typebox`; and
`@vegardx/pi-workflow/service-provider`, the seam another extension acquires a
narrowed read client through. Neither export list is pinned, and both are
checked to be disjoint from the two pinned lists. `WorkflowServiceOptions`
gains the optional `modelRouting` port; `AgentTaskAuthoringRequest` gains the
optional `modelRole`, which is resolved to an exact model before hashing so no
identity derivation and no `AgentTaskRequestSchema` field changes;
`WorkflowRunRecordSchema` gains the optional `modelRouting`, which is
revision-19 additive (every record written before it still validates, a reader
that does not know the field ignores it, and nothing derives identity from it).
The package ships three more builtin workflows, `deep-review`, `plan-review`
and `deep-research`, from the same `workflows/` builtin root; `plan-review` is
the only name on `BUILTIN_HEADLESS_WORKFLOWS`, and declares no checkpoint,
worktree or handoff. `deep-research` declares none of the three either, but is
not on the allowlist: the structural property and a reason to start without a
model turn are different things.
The lease-free `inspect` gains two additive reads: `WorkflowInspectSection`
gains the member `"output"`, which puts a terminal run's committed output on
`run.output` (`WorkflowRunSummarySchema` gains the optional `output`, bounded
by `MAX_WORKFLOW_ARTIFACT_BYTES`), and `WorkflowCheckpointDecisionView.value`
is now also filled from the run's durable decision record, so a decided
checkpoint's value is visible without the decision artifact. Both are
additive: an `include` that was valid stays valid, an inspection that
validated still validates, and nothing persisted changed. No frozen export was
removed, renamed, or retyped, no returned union widened, and no tool name, no
tool output schema, and no accepted tool parameter was narrowed or removed.

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

type WorkflowReturn<T> = T | TaskHandle<T> | ArtifactHandle<T> | HandoffHandle;
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

Contract revision 17 identities cover the complete definition module but not a
helper dependency graph. Static imports are limited to `@vegardx/pi-workflow`,
`@vegardx/pi-workflow/components`, `typebox`, and the module specifiers present
in the constructor-injected support registry; every other static import, dynamic import, CommonJS require,
and TypeScript import assignment is rejected rather than silently omitted from
source identity. The `@vegardx/pi-workflow/components` subpath is an allowed
import (trusted package code, the same trade the root import makes); the
`@vegardx/pi-workflow/runtime` subpath is not: the gate matches specifiers
exactly, so a definition that imports it fails with
"workflow import @vegardx/pi-workflow/runtime is not identity-bound by contract revision 19". A support implementation is identified by its registered
explicit implementation digest, not by tracing its dependency graph.
Multi-file definition provenance remains future work. The same import gate,
with the same messages, applies to dynamic workflow source proposed through
`service.propose`; dynamic source additionally may not use `import.meta`
("dynamic workflow source may not use import.meta") and must have exactly
one default export and no named or re-exports ("dynamic workflow source must
have exactly one default export and no named exports"). See
[Dynamic workflows](#dynamic-workflows).

### Definition roots

Discovery visits `<cwd>/workflows` and `<cwd>/.pi/workflows` (scope
`project`), `<agentDir>/workflows` (scope `global`), and then every root the
embedder registered (scope `package` or `builtin`, in that order, each sorted
by path). A registered root of any other scope is rejected ("registered
workflow roots must use package or builtin scope"); a directory reachable
through two roots is rejected ("duplicate workflow root …"); names are unique
across all roots.

Project roots require Pi project trust and otherwise fail closed with
`WorkflowDefinitionTrustError` before any module is evaluated. Registered
`package` and `builtin` roots do not: they are trusted by their installation
source, exactly like `<agentDir>/workflows`. The gate is the install, not the
project.

pi-workflow itself ships definitions in `workflows/` inside the tarball
(declared by `files` and by the `pi.workflows` manifest key) and its extension
registers that directory as `{ scope: "builtin", source: "package" }` when it
creates the service, so those definitions are listed, validated, and runnable
in any project without a trust prompt. They are trusted package code and are
held to the same review as `src/`. They are loaded from source by the same
jiti loader as any other definition, so imports resolve from the definition's
own location — inside the installed package, where `@vegardx/pi-workflow`
resolves to the package itself and `typebox` to the peer the consumer
installed. No compiled copy under `dist/` is involved. When the project being
worked in *is* the pi-workflow checkout, that directory is already
`<cwd>/workflows`; the extension then omits the builtin root and the
definitions load under `project` scope with the usual trust gate.

The shipped builtin that writes is `plan-to-ship` (`plan -> approve -> stages
-> ship`), a compiler over the plan's `deliverables[].stages` and `policy`:
`refine` (read-only agent) -> `approve-plan` (checkpoint, `headless: "block"`)
-> per deliverable, in plan order, `implement` (one worktree agent
`<stage>-<deliverable>` with `handoff: "required"`), `verify-and-fix` (the
bounded `-verify-<n>`/`-fix-<n>` loop), `review-fan-out` (optional read-only
reviewers keyed by lens id, each fed a handoff descriptor) and an optional
`gate` -> `ship` (checkpoint, `headless: "block"`, declared for every
`policy.gates` but `approve-plan`) -> `receipt` (required finalizer). A
deliverable that declares no `stages` gets the default list derived from
`policy`, so a plan written before stages existed compiles to the same graph. Its input is a
pi-maestro plan by value, that plan's sha256 digest, and an effort dial; its
output is a receipt naming, per deliverable, the imported handoff descriptor
and the durable ref `refs/pi-subagent/handoffs/<subagentRunId>/<attemptId>`,
plus the approved `planDigest`. The workflow never pushes, merges, publishes,
or applies a handoff: shipping is a cherry-pickable ref and a patch artifact.

A root loads `*.workflow.ts|mts|js|mjs` only, so other files may live under
one. `workflows/agents/*.md` uses that: the agent definitions a builtin names
travel with the package beside the definitions that name them. A run composed
from a root with an `agents/` directory lowers that directory's canonical path
onto every subagent request it makes, as `SubagentRequest.agentRoots`, and
pi-subagent resolves the named definition from it under `package` scope. The
roots are the run's, not the task's: they are not part of a task spec's
identity, because which directory a definition was loaded from belongs to this
run's registry. A request root is consulted only for a name pi-subagent's own
discovery does not define, so `<agentDir>/agents` and a trusted
`<cwd>/.pi/agents` still win for their own names; a name no source defines
still fails that task at pi-subagent preflight.

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

`ctx.support(key, descriptor)` is the only authoring surface. The descriptor's
`inputs` accept result handles (`handle.output`) and worktree handoff handles
(`handle.handoff`); a handoff input delivers the `WorkflowHandoffDescriptor`
to the implementation under its input name, never patch bytes. There is no
string-addressed API and no inline callback: the implementation is referenced
by descriptor identity and resolved at execution time from the registry. The
dynamic frontend lowers the same descriptor into the same `SupportTaskSpec`:
a registration made with `helper.registration(execute, { exportName })` is
published to dynamic sources as the named export `exportName` of its
`moduleSpecifier`, wrapped so that `registration()` throws ("Dynamic workflow
source may not register support implementations."); the scheduler and
executor never distinguish the frontend.

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
registrations produced by `helper.registration(execute, { exportName? })`. The service validates
each registration, rejects duplicate names, and freezes the map. An
`exportName` must match `^[A-Za-z_$][A-Za-z0-9_$]{0,127}$` and may not be
`default` ("Support task export name is invalid."); two registrations with
the same `moduleSpecifier` and `exportName` are refused ("Duplicate support
task export name: <moduleSpecifier>#<exportName>"). Registrations with an
`exportName` form the frozen `supportHelpers` list handed to every dynamic
VM and hashed into `importPolicySha256`; a registration without one is not
importable by dynamic sources. The registry
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
	readonly handoff?: HandoffHandle; // present only on worktree agent tasks
}

interface ArtifactHandle<T> {
	readonly ref: {
		runId: WorkflowRunId;
		producerTaskId: WorkflowTaskId;
		output: "result";
	};
}

interface HandoffHandle {
	readonly ref: {
		runId: WorkflowRunId;
		producerTaskId: WorkflowTaskId;
		output: "handoff";
	};
}

type WorktreeTaskHandle<T> = TaskHandle<T> & { readonly handoff: HandoffHandle };
```

`WorkflowArtifactHandleRef.output` is `"result" | "handoff"`
(`WorkflowArtifactOutputSchema`). An agent declaration whose request literal
has `workspace.mode === "worktree"` is typed `WorktreeTaskHandle`; at runtime
`createTaskHandle` attaches `handoff` exactly when the materialized spec is a
worktree agent task. A `HandoffHandle` (`isHandoffHandle`) may be named in
`inputs`, where the consumer receives the handoff descriptor and never patch
bytes, and may be returned as the workflow value, in which case the output
schema must accept a `WorkflowHandoffDescriptor`.

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
	checkpoint<TDecisionSchema extends TSchema>(
		key: TaskKey,
		request: CheckpointRequest<TDecisionSchema>,
	): TaskHandle<Static<TDecisionSchema>>;
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
	handoff<T>(
		task: WorktreeTaskHandle<T>,
	): Promise<WorkflowHandoffDescriptor | undefined>;
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

A dynamic workflow VM exposes this interface verbatim: the same members with
the same validation messages (`DYNAMIC_CONTEXT_PROPERTIES` = `cwd`, `input`,
`runId`, `signal`; `DYNAMIC_CONTEXT_METHODS` = `agent`, `checkpoint`,
`fanIn`, `fanOut`, `finalize`, `handoff`, `log`, `phase`, `pipeline`,
`result`, `results`, `settled`, `support`, `workflow`, and nothing more).
`ctx.artifact` is not available in revision 19 on either frontend. In the VM
declarations are synchronous RPC calls answered by the static-runtime context
and barriers are asynchronous replies; see [Dynamic workflows](#dynamic-workflows).

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

`ctx.handoff(handle)` is a persisted `"result"`-kind barrier on a worktree
task; there is no separate barrier kind. It runs the scheduler until the task
completes and finalizes, verifies the task's handoff evidence, and resolves the
`WorkflowHandoffDescriptor`, or `undefined` only when the task's `handoff`
policy is `"optional"` and `task-execution-handoff-absent` was recorded. A
finalizer handle is rejected exactly like `ctx.result` ("a finalizer cannot be
a barrier target"). See [Worktree tasks and handoffs](#worktree-tasks-and-handoffs).

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
	kind: "agent" | "support" | "workflow" | "checkpoint";
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

`kind` is `"agent" | "support" | "workflow" | "checkpoint"` in revision 19;
a checkpoint task (`ctx.checkpoint`) lowers to `CheckpointTaskSpec`, whose
`request` is the `CheckpointTaskRequest` described in
[Checkpoints](#checkpoints). `role` is `"task"` for every ordinary
declaration (`ctx.agent`, `ctx.support`, `ctx.workflow`, `ctx.checkpoint`,
fan-out, fan-in, and pipelines) and `"finalizer"` for `ctx.finalize`; it
participates in task identity. A checkpoint is never a finalizer
("a checkpoint cannot be a finalizer"). An ordinary task may not depend on a finalizer through `after` or
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
the runtime's `invalidationClosure` helper (`@vegardx/pi-workflow/runtime`)
and rejects any other set. The
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
	memoryBytes?: number; // guest VM memory grant; lowered to pi-subagent
	handoff?: HandoffPolicy; // worktree tasks only; workflow-only
	outputSchema: JsonSchema<T>;
	limits: RunLimits;
	retry?: { attempts: number; on?: readonly ("backoff" | "manual")[] };
	resume?: { attempts: number };
}

type WorkspaceRequest =
	| { mode: "read-only"; cwd: string }
	| { mode: "worktree"; cwd: string };

type HandoffPolicy = "required" | "optional";

interface TaskRequestBase {
	disposition?: "required" | "optional";
	after?: TaskRef[];
	inputs?: Record<string, ArtifactHandle<unknown> | HandoffHandle>;
	replay?: "auto" | "off" | "read-only";
}
```

Disposition defaults to `required` and participates in task identity. Failure
of an optional task is observable but does not block unrelated required tasks.
A run may become `completed-degraded` only after every required task and
required finalizer succeeds while an optional task or advisory finalizer failed.
An optional task or advisory finalizer left `blocked` by a failed dependency
counts as settled for completion and degrades the run the same way.

`memoryBytes` (revision 19) is the guest VM memory grant: a positive integer
multiple of 64 MiB, at most 4 GiB, validated against pi-subagent's
`MemoryBytesSchema` and lowered unchanged. It is a request to narrow, never to
widen: the agent definition declares the ceiling, an omitted request takes that
ceiling, and pi-subagent refuses a request above it at preflight with
`memory request exceeds agent ceiling`. The workflow cannot read agent
frontmatter, so it neither predicts nor restates that refusal: the launcher
relays pi-subagent's message unchanged after the fixed prefix
`Subagent preflight failed before launch.`, in the terminal evidence and in the
task failure reason. `memoryBytes` participates in agent task identity like
every other request field, and the launcher requires the resolved
`sandbox.memoryBytes` of the returned launch plan to equal a value the request
named; a request that named none inherits whatever ceiling the plan resolved.
Memory is not a workflow budget: there is no run-level total and the workflow
never sums grants across tasks.

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
agent children or in-process support tasks. A lane that has nothing else to do
while a checkpoint awaits a decision also moves the run `running -> waiting`
(reason "Workflow run awaits a checkpoint decision."); see
[Checkpoints](#checkpoints). A `waiting` run resumes (`waiting -> running`,
no reason) only when a lane has selected work for it or the runtime enters
finalization; a lane that finds the run already `waiting` and has nothing to
select appends nothing, so idle lanes of a parked or barrier-blocked run never
flap the status, and a re-drive whose sweep expires or defaults the checkpoint
before any lane has work ends the run from `waiting`.

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

### Worktree tasks and handoffs

`workspace: { mode: "worktree", cwd }` requests an isolated pi-subagent
worktree for the child (`AgentWorkspaceRequestSchema`). The materializer
additionally requires `limits.workspaceWriteBytes >= 1` ("worktree workspace
requires a positive workspaceWriteBytes limit") and normalizes the
workflow-only `handoff` policy (`HandoffPolicySchema`) to
`request.handoff ?? "required"`; the normalized value is part of the persisted
request and therefore of task identity, so a changed policy is a changed
request. `handoff` on a read-only request is rejected ("handoff policy
requires a worktree workspace"), read-only requests persist no `handoff`
field, and the launcher lowers request fields explicitly and never sends
`handoff` to pi-subagent. `workspaceWriteBytes: 0` on read-only tasks is not
newly enforced.

The preflight event persists the launch plan's `workspaceMode` and
`workspaceBaselineSha256` (pi-subagent's digest of the clean checkout
baseline, opaque to the workflow, which never recomputes it from git). The
reducer rejects a preflight whose mode differs from the task request ("task
execution preflight workspace does not match its task"); a superseding
preflight may carry a different baseline digest, and the preflight named by
`launch-intended` is authoritative.

A settled worktree attempt may carry handoff identity in its evidence:
`SubagentTerminalEvidence.handoff = { attemptId, baselineHead, handoffCommit }`
(`SubagentHandoffEvidenceSchema`, object ids `^[a-f0-9]{40,64}$`), projected
by the shared `deriveSubagentSettlementEvidence` from pi-subagent's worktree
record when the record names a handoff commit that differs from the baseline;
a record without a handoff commit yields no `handoff` field, and any other
malformed record is an observation error. Repository root, worktree path,
record path, branch, ref names, and timestamps are never persisted. A
read-only task whose settlement carries a handoff is rejected ("read-only task
settlement carries a handoff"), a handoff naming an attempt other than the
current one is rejected ("settlement handoff names another attempt"), and an
`abandoned` settlement may not carry one.

The agent execution ladder for a completed worktree child is `settled →
artifact-imported → handoff-resolved → release-intended → released →
terminal`; read-only children are unchanged. After the structured-output
import and before release intent the finalizer either imports the handoff or
records its absence:

- with settlement handoff evidence it calls the owner client's
  `exportHandoff(childRunId, { maxBytes: MAX_WORKFLOW_HANDOFF_BYTES })`,
  requires the returned `HandoffRef` to name the child run, the current
  attempt (`currentSubagentAttemptId`), and the settled `baselineHead` and
  `handoffCommit` (which must differ), requires `format: "git-format-patch"`
  and `mediaType: "application/x-git-format-patch"`, verifies byte length and
  SHA-256 against the reference, requires 1 to `MAX_WORKFLOW_HANDOFF_BYTES`
  (16 MiB) bytes beginning with the single-commit
  `From <handoffCommit> Mon Sep 17 00:00:00 2001` separator, writes the bytes
  through `artifacts.putBytes` as a content-addressed `<sha256>.patch` blob
  with `output: "handoff"`, `mediaType: "application/x-git-format-patch"`, and
  `schemaSha256 = WORKFLOW_HANDOFF_FORMAT_SHA256`, declares the artifact
  unless an equal reference exists, and appends
  `task-execution-handoff-imported { executionId, subagentRunId,
  subagentAttemptId, artifactId, handoffCommit, baselineHead, sha256, bytes }`;
- without settlement handoff evidence it appends
  `task-execution-handoff-absent { executionId, subagentRunId,
  subagentAttemptId }`.

Import precedes release because pi-subagent requires a handoff to be exported
or pinned before ordinary retention selects its run, and because the workflow
must hold workflow-owned evidence before it declares the child disposable, the
same rule that already orders artifact import before release. Release after
import is safe: pi-subagent's handoff ref keeps the commit reachable. The
reducer accepts the import only on a worktree task ("handoff import requires a
worktree task") from phase `artifact-imported`, or from a `cleanup-blocked`
terminal at stage `handoff-import` during recovery ("task execution handoff
import is invalid"), requires the event identity to equal the settlement's
("handoff import does not match the settlement handoff") and the declared
artifact to match the producer execution, output, media type, format digest,
digest, and size ("handoff import artifact does not match"); absence is
accepted only from `artifact-imported` and only when the settlement carries no
handoff ("handoff absence contradicts a captured handoff"). Release intent on a
completed worktree child requires phase `handoff-resolved`. A handoff artifact
declaration requires a worktree producer ("handoff artifact requires a
worktree producer") and the fixed media type and format digest ("handoff
artifact format is invalid"); one result and one handoff artifact coexist per
execution.

Any reference, identity, format, digest, or store failure during the import,
and any export rejection that is not a bound refusal, terminalizes the
execution `cleanup-blocked` with workflow evidence at stage `handoff-import`
(message "Workflow handoff artifact import requires reconciliation."), the
task and run become `cleanup-blocked`, and explicit reconciliation reconciles
the child and retries the import exactly as for `artifact-import`.

A handoff larger than `MAX_WORKFLOW_HANDOFF_BYTES` is different: pi-subagent
refuses the export with its fixed byte-limit error, or returns a reference
whose proved length exceeds the bound, and neither fact changes on a re-drive.
That refusal is a deterministic, permanent failure of the execution, not a
cleanup problem. The finalizer terminalizes the execution `failed` with
workflow evidence at stage `handoff-import` and the fixed message "Workflow
handoff exceeds the import bound." under either handoff policy, and the task
fails with the same reason; a required task fails the run, an optional one
degrades it. The reducer admits that evidence only on a worktree task whose
current execution is at phase `artifact-imported` (or holds the
`cleanup-blocked` handoff-import terminal it supersedes), whose settlement is
`completed` and carries a handoff, and which has neither handoff evidence nor
a release intent or receipt; a superseding terminal replaces the blocked one
in place so a re-drive of an already blocked execution converges instead of
looping ("task execution terminal evidence is duplicate" for every other
replacement, "workflow terminal evidence is inconsistent" otherwise). The
child is deliberately **not** released: an unreleased worktree run is never an
ordinary pi-subagent retention candidate, so its worktree, reservation branch,
and handoff ref stay protected and the operator can still export, pin, or
release the handoff through pi-subagent's own surface. Releasing it would make
the run ordinary prune history with an unexported handoff, which is the one
outcome that loses the work. Once the run is `failed`, `retry` and
`invalidate` are legal again (see [Action legality](#action-legality)), and a
new generation gets a fresh worktree.

A completed child that captured no handoff is released normally; under
`handoff: "required"` it is then terminalized `failed` at stage
`handoff-import` with the fixed message "Completed worktree task captured no
handoff." (admitted only from phase `released` with absence recorded), while
under `"optional"` it completes and `ctx.handoff` resolves `undefined`.
Terminal `completed` evidence for a worktree task requires the imported
handoff artifact to match the settlement handoff ("subagent terminal handoff
does not match").

The workflow exposes a handoff only as identity:

```ts
interface WorkflowHandoffDescriptor {
	artifactId: WorkflowArtifactId;
	runId: WorkflowRunId;
	producerTaskId: WorkflowTaskId;
	producerExecutionId: TaskExecutionId;
	subagentRunId: SubagentRunId;
	subagentAttemptId: SubagentAttemptId;
	baselineHead: GitObjectId; // ^[a-f0-9]{40,64}$
	handoffCommit: GitObjectId;
	format: "git-format-patch";
	mediaType: "application/x-git-format-patch";
	sha256: string;
	bytes: number; // 1 .. MAX_WORKFLOW_HANDOFF_BYTES
}
```

The descriptor (`WorkflowHandoffDescriptorSchema`, derived by
`deriveWorkflowHandoffDescriptor` from the declared artifact and the
execution's handoff import) is what `ctx.handoff` resolves, what a returned
`HandoffHandle` commits as the ordinary JSON output artifact (the binary
artifact is never the run output), and what a downstream task receives when it
names `handle.handoff` in `inputs`: the delegated-context envelope keeps the
artifact's `application/x-git-format-patch` media type and marks
`content: "descriptor"`, so the child model receives identity, not bytes;
support implementations and child workflows receive the same descriptor JSON.
A handoff input whose producer is not a worktree agent task is rejected at
declaration ("handoff input producer is not a worktree agent task") and by the
reducer ("task input names a handoff of a non-worktree task"); input digests
select the artifact whose `output` matches the reference, so result inputs
hash exactly as before. The workflow declares, retains, verifies, and exposes
the handoff and exports its bytes through `WorkflowService.exportHandoff`; it
never applies, pushes, merges, or checks out a handoff, and it never reads
subagent-private paths or branches. Chaining a second writer task on top of a
handoff would need a pi-subagent workspace-input contract that does not exist;
the workflow does not apply a patch into a downstream worktree.

Retry and resume attempts on a worktree child follow the rules in the next
section: same execution, same generation, no new preflight. pi-subagent
creates a fresh worktree per attempt from the revalidated baseline, each
attempt's settlement evidence may carry its own `handoff`, and only the
current (final) attempt's handoff is exported and imported; its `attemptId`
must equal `currentSubagentAttemptId(execution)`, and prior attempts' handoff
identities stay in `priorSettlements` as evidence. An interrupted worktree
child is retained without release exactly like a read-only one, and its
uncaptured writes stay in pi-subagent. A later execution generation receives a
fresh preflight (new `workspaceBaselineSha256`), operation ID, subagent run,
and worktree; the prior generation's handoff artifact stays declared under its
own `producerExecutionId`, every lookup selects the current execution's
artifact, and identical bytes across generations share one `.patch` blob
under distinct references. A worktree finalizer re-executed after
invalidation gets a new worktree as its next generation.

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
attempt intent may not carry a reason"). The reducer additionally admits
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
open without invalidated work. The service `resume` method (and the
`workflow_resume` tool over it) is the only surface that appends operator
intents; see [Lifecycle methods](#lifecycle-methods).

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
      Task execution generation (kind agent | support | workflow | checkpoint)
        Subagent run (agent tasks only)
          Subagent attempt
          Imported result artifact
          Imported handoff artifact (worktree tasks only)
        Support computation (support tasks only)
          Result artifact
        Child workflow run (workflow tasks only; depth + 1)
          Workflow task ... (same hierarchy)
          Imported result artifact
        Decision record (checkpoint tasks only; one per execution binding)
          Result artifact (the decision value)

Dynamic workflow definition (dynamic:<sourceSha256>)
  Proposal (per source digest; manifest, hostApiSha256, importPolicySha256)
    Source approval decision record (one per definition identity)
      Workflow run (depth 0 only; copies of source, manifest, proposal, and
        approval in its definition/ directory)
```

A dynamic definition's identity is path-free:
`definitionIdentitySha256 = deriveJsonValueSha256({ contractRevision: 18,
hostApiSha256, kind: "dynamic-workflow", manifestSha256, sourceSha256 })`
(`deriveDynamicDefinitionIdentitySha256`), so it never collides with a
static identity, and every task identity in a dynamic run inherits it through
the ordinary materializer derivation. The source approval binds that
identity, so a changed host API rebinds the same source.

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
agent execution and add no level to the hierarchy above. An operator-triggered
`retry` is an invalidation restricted to a failed or interrupted cause task,
not a subagent retry. Re-execution after explicit invalidation is neither
retry nor resume: it creates a new task-execution generation and a new
preflight, idempotent operation ID, and subagent run, support computation, or
child workflow run. A result or handoff artifact binds to the execution that
produced it: `WorkflowArtifactRef.producerExecutionId` is required exactly
when `producerTaskId` is present, participates in `deriveWorkflowArtifactId`
together with `output` (`"result"` or `"handoff"`), and must name an execution
of the producer task. Every lookup of a task's artifact (completion,
`taskInputsSha256`, delegated-context projection, nested input resolution,
`ctx.handoff`, and `exportHandoff`) selects the artifact whose
`producerExecutionId` equals the task's `currentExecutionId` and whose
`output` matches the reference; artifacts of prior generations remain history
and valid provenance. One result and one handoff artifact may coexist per
execution; a second artifact for the same `(producerTaskId,
producerExecutionId, output)` is ambiguous. Every identity and relationship is
persisted explicitly.

Subagent terminal outcomes map using both primary status and cleanup evidence:

| Subagent evidence | Workflow task outcome |
| --- | --- |
| `completed` and required artifacts imported, with cleanup proved/not-needed | `completed` |
| `completed` worktree child with its handoff imported, or its absence recorded under an `optional` policy, with cleanup proved/not-needed | `completed` |
| `completed` worktree child released after recording handoff absence under a `required` policy | `failed` (workflow evidence, stage `handoff-import`) |
| `completed` worktree child whose handoff export, identity, format, or digest verification failed | `cleanup-blocked` at stage `handoff-import`; reconciliation retries the import |
| `completed` worktree child whose handoff exceeds `MAX_WORKFLOW_HANDOFF_BYTES` (refused by pi-subagent or proved oversize) | `failed` (workflow evidence, stage `handoff-import`, "Workflow handoff exceeds the import bound."); the child is not released |
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
interface WorkflowService {
	registerRoot(root: WorkflowRoot): Promise<void>;
	list(): Promise<readonly WorkflowDefinitionSummary[]>;
	validate(ref: string, input?: unknown): Promise<WorkflowValidationResult>;
	run(ref: string, input: unknown): Promise<WorkflowServiceRunReceipt>;
	status(runId: WorkflowRunId): Promise<WorkflowServiceRunView>;
	wait(runId: WorkflowRunId, options?: { timeoutMs?: number }): Promise<WorkflowServiceWaitView>;
	stop(runId: WorkflowRunId, reason: string): Promise<WorkflowServiceRunView>;
	decide(runId: WorkflowRunId, taskId: string, options: { decision: unknown; approver: string; reason?: string }): Promise<WorkflowServiceRunView>;
	invalidate(runId: WorkflowRunId, causeTaskId: string, reason: string): Promise<WorkflowServiceRunView>;
	retry(runId: WorkflowRunId, taskId: WorkflowTaskId, reason: string): Promise<WorkflowServiceRunView>;
	resume(runId: WorkflowRunId, reason: string, options?: WorkflowResumeOptions): Promise<WorkflowServiceRunView>;
	reconcile(runId: WorkflowRunId, options?: { taskId?: WorkflowTaskId }): Promise<WorkflowServiceReconcileView>;
	listRuns(query?: WorkflowRunQuery): Promise<WorkflowRunPage>;
	inspect(runId: WorkflowRunId, options?: WorkflowInspectOptions): Promise<WorkflowRunInspection>;
	logs(runId: WorkflowRunId, options?: WorkflowLogOptions): Promise<WorkflowLogPage>;
	previewInvalidation(runId: WorkflowRunId, causeTaskId: WorkflowTaskId): Promise<WorkflowInvalidationPreview>;
	subscribe(listener: (observation: WorkflowRunObservation) => void): () => void;
	exportHandoff(runId: WorkflowRunId, taskId: string): Promise<WorkflowServiceHandoffExport>;
	propose(source: string, options: { proposer: DynamicWorkflowProposer }): Promise<DynamicWorkflowProposalView>;
	inspectProposal(ref: string): Promise<DynamicWorkflowProposalView & { source: string }>;
	proposals(): Promise<readonly (DynamicWorkflowProposalView | { ref: `dynamic:${string}`; issue: string })[]>;
	decideSource(ref: string, options: { decision: "approved" | "rejected"; approver: DynamicSourceApprover; reason?: string }): Promise<DynamicWorkflowProposalView>;
	shutdown(): Promise<void>;
}
```

This interface is frozen at 1.0.0: the twenty-three methods above are the
`WorkflowService` of `src/service.ts`, pinned by name in
`test/public-api.test.ts` and by signature in `test/public-api.types.ts`.

`validate` and `run` accept a `dynamic:<sha256>` reference for an approved
dynamic proposal in addition to a static definition name or path; `list()`
stays static-only and proposals are discovered through `proposals()`. The
four dynamic methods are specified under
[Dynamic workflows](#dynamic-workflows).

Every value a method returns is defined once as a TypeBox schema in
`service-views.ts`; the TypeScript view types derive from those schemas, the
Pi tools validate their output against them before serialization, and a
failed check is a bug (`Error("workflow tool output violates its schema")`),
never masked. Views are frozen and carry only fixed workflow strings,
operator-authored reasons (1..4096 characters, already journaled), codes,
digests, ids, statuses, ordinals, counts, and timestamps: no prompts,
artifact values, child model prose (`failure.message`, `guidance`), session or
store paths, or credential-shaped metadata.

### Lifecycle methods

`run` validates trust, definition, input, and the shared subagent provider
before creating durable state, then returns a run ID immediately. `status` is
a journal projection, `wait` reconstructs nonterminal work after restart and
drives a durably `failed` or `interrupted` run whose on-path tasks are
`invalidated` (that run awaits explicit recovery), and `stop` persists
run/task intent before delegated interruption, support abort, and child-run
stop. Every run view carries `depth` and, for a linked child run,
`parent: { runId, taskId, inputArtifacts }`, where `inputArtifacts` is the
record's injected artifact identity map; a child run is addressable by its own
run ID for status, wait, stop, reconcile, inspect, and logs.
`createWorkflowService` accepts an optional `registeredRoots` list of
`package`/`builtin` roots (the constructor form of `registerRoot`, validated
the same way and reported as `validation` "Registered roots must be package or
builtin scope."; unlike `registerRoot` it does not discover eagerly, so a
package can contribute definitions without forcing a project-trust decision at
service creation), an optional `supportTasks` registration list
that becomes the frozen constructor registry and supplies the nested run
provider to every run it composes, and an optional
`checkpoints: { headless?: boolean }` policy (default `{ headless: false }`;
anything else is `validation` "Workflow service checkpoint options are
invalid.") described in [Checkpoints](#checkpoints). It also accepts an
optional `dynamic: { bootTimeoutMs?: number; computeTimeoutMs?: number }`
(each an integer 1 through 2 147 483 647; anything else, including unknown
keys, is `validation` "Workflow service dynamic options are invalid.") that
exists so embedders and tests on slow hosts can lengthen the dynamic VM boot
watchdog (manifest extraction and every run drive) and compute watchdog; it
does not change `hostApiSha256`.

`wait(runId, { timeoutMs })` validates `timeoutMs` as an integer 1 through
2 147 483 647 (`validation`, "Invalid workflow wait timeout.") before touching
the run. When the drive outlives the timeout the method returns the current
view with `timedOut: true` and leaves the drive running; a later `wait`
observes it. Without a timeout the behaviour is unchanged. A run parked at a
checkpoint is settled without failure: `wait` returns its non-terminal
`waiting` view immediately, marked `parked: true` and listing
`pendingCheckpoints`, instead of blocking until the decision. Callers must not
poll; a later `wait` after `decide` follows the restarted drive. A parked run
whose pending expiry or deadline has already passed is re-driven once before
`wait` answers, so the returned view reflects the expiry, default, or stop.
`parked` is emitted only on the wait view.

`invalidate(runId, causeTaskId, reason)` is the trigger for re-execution
(`retry` below is its restricted form) and is exposed by the
`workflow_invalidate` tool as a pure pass-through. It
validates the run ID, the task ID pattern, and a reason of 1 through 4096
characters, rejects with `conflict` ("Workflow run is still being driven.")
while an owned run's drive has not settled and with `validation` ("Workflow
run status does not admit invalidation.") unless the run is durably `failed`
or `interrupted`, refuses nested child runs, runs that already await recovery
(of on-path invalidated work, or of an open operator resume intent, each named
in its message), and runs whose deadline has passed (each
`validation`), then computes `invalidationClosure`, appends one
`task-invalidated` event carrying the exact closure and abandoned epochs,
appends the recovery transition `failed|interrupted → running` (reason
"Explicit invalidation re-executes invalidated tasks."), restarts the drive
without awaiting it (`wait` observes it), and returns the current view, whose
status is already `running`; reducer rejections surface as `validation`. If
the process crashes between the two appends, the restarted static runtime
repairs the gap by appending the same transition when it finds a `failed` or
`interrupted` run with at least one on-path `invalidated` task; otherwise the
existing explicit-recovery refusal stands.

`retry(runId, taskId, reason)` is `invalidate` restricted to a cause task
whose current execution is terminal `failed` or `interrupted`
(`retryableTasks`); any other task is refused with `validation` "Workflow
retry requires a failed or interrupted task." (a bad reason with "Invalid
workflow retry reason."), and every invalidation refusal applies unchanged.
The task and its dependents re-execute as new generations with a fresh
preflight, operation ID, and subagent run; the owner client's `retry` is never
called. The `workflow_retry` tool is a pure pass-through.

`resume(runId, reason, { taskId })` re-attempts an interrupted agent task on
its existing subagent run without invalidating anything. It validates the run
ID, a reason of 1 through 4096 characters ("Invalid workflow resume
reason."), and the optional task ID ("Invalid workflow task ID.") before
touching the run; rejects with `conflict` "Workflow run is still being
driven." while an owned drive has not settled; and refuses with `validation`
a status other than `interrupted` ("Workflow run status does not admit
resume."), a nested child run ("Nested workflow runs are resumed through their
parent run."), a run awaiting recovery ("Workflow run already awaits recovery
of invalidated work.", or "Workflow run already awaits recovery of an operator
resume." when the pending recovery is an open operator intent rather than
invalidated work), and a passed deadline ("Workflow run deadline has
passed."). Without `taskId` the run's single resumable task is selected
("Workflow run has no resumable task.", "Workflow run has multiple resumable
tasks; specify taskId."); with `taskId` the task must pass `resumeRefusal`:
an on-path agent task ("Unknown workflow task.", "Workflow resume requires an
agent task.") whose current execution is terminal `interrupted` with a
`resume`-classified failure ("Workflow resume requires an interrupted task
with a resumable failure."), headroom under the attempt bound ("Workflow task
attempt bound exceeded."), and no dependent that already observed it ("Use
workflow_invalidate; dependents already observed this task."). It then
appends one `task-execution-attempt-intended` event (`kind: "resume"`,
`origin: "operator"`, the operator's `reason`, the next ordinal, and the
current attempt as `previousAttemptId`), appends `interrupted → running`
(reason "Operator resume re-attempts the interrupted task."), restarts the
drive without awaiting it (`wait` observes it), and returns the current view.
The drive performs the attempt through the owner client's `resume`; a refusal
declines the attempt with the fixed reason "Subagent refused the attempt.",
terminalizes the execution `interrupted` again without release, and returns
the run to `interrupted`, still resumable. A crash between the two appends
leaves an open operator intent: the run then offers only `wait`, and the
restarted static runtime performs the same transition before attempting. The
`workflow_resume` tool is a pure pass-through.

`reconcile(runId, { taskId })` returns a run view plus `reconciled`, one
entry per reconciled execution with `taskId`, `executionId`, `before` and
`after` (`phase`, `outcome`, `childStatus` captured from the reduced state
around the call), and, for agent tasks, the pi-subagent facts
`subagent: { sandboxProcess, workspace }` returned by the owner client's
reconciliation. Without `taskId`, once the drive settles and while the run is
`cleanup-blocked`, the service reconciles on-path `cleanup-blocked` tasks in
materialization order one at a time (bounded by the task count) and restarts
the drive when the run returns to `running` or `waiting`. With `taskId`, a
malformed id is `validation` "Invalid workflow task ID.", an unknown or
abandoned task is "Unknown workflow task.", a task that is not on-path
`cleanup-blocked` is "Workflow task is not cleanup-blocked." (checked against
the durable view before any lease is taken and again after the drive), and
only that task is reconciled. `reconciled` is empty when the run was already
completed or not cleanup-blocked; a completed run returns that empty list for
any known `taskId` and refuses only an unknown one. The `workflow_reconcile`
tool accepts `runId` and the optional `taskId` and forwards them unchanged. A settled run this service still owns is
reused rather than re-leased.

### Action legality

`run-actions.ts` is the single predicate module for operator actions: the
terminal, invalidation-admission, recovery, deadline, and nesting predicates,
`runActionFacts`, `availableWorkflowRunActions`, and `requiresAttention`.
Lifecycle methods refuse through the same predicates, and every summary
carries `availableActions`: the subset of `stop`, `wait`, `reconcile`,
`invalidate`, `retry`, `resume`, `decide` that is legal for the run's facts,
filtered by the actions implemented in this build (`stop`, `wait`,
`reconcile`, `invalidate`, `retry`, `resume`, `decide`) and returned in that
fixed order. A run leased by another live service has no available actions.
`requiresAttention` is `cleanup-blocked`, `failed`/`interrupted` without
invalidated work awaiting recovery, or at least one checkpoint awaiting a
decision (`pendingCheckpointCount > 0`). `pendingCheckpoints(state)` is the
one predicate behind the `decide` action, the service's `decide`
precondition, the run view's `pendingCheckpoints`, and the summary's
`pendingCheckpointCount`: on-path checkpoint tasks whose status is `waiting`
and whose current execution is in phase `checkpoint-requested`. Tools and
widgets consume `availableActions`; nothing recomputes it.

| Action | Legal iff |
| --- | --- |
| any | `ownership !== "leased-elsewhere"` |
| `stop` | run status is not terminal |
| `wait` | run status is not terminal, or the run awaits recovery |
| `reconcile` | run is `cleanup-blocked`, or not terminal and not owned by any live service |
| `invalidate` | `failed` or `interrupted`, not nested, not awaiting recovery, deadline not passed, not being driven |
| `retry` | `invalidate` is legal and a task's current execution is terminal `failed` or `interrupted` |
| `resume` | `interrupted`, not nested, not awaiting recovery, deadline not passed, not being driven, and a task passes `resumeRefusal` |
| `decide` | run is `running` or `waiting`, not nested, deadline not passed, at least one checkpoint awaiting a decision (not gated on `driving`: a live drive with another lane busy accepts a decision) |

### Read surface

Reads never acquire a run lease. `listRuns`, `inspect`, and `logs` read runs
this service owns through their own journals and every other run through the
lease-free readers `WorkflowRunRecordStore.readFrom` and
`readWorkflowJournalUnleased` (complete-record prefix; a torn tail is measured,
never repaired). The two durable values `inspect` cannot project from the
journal alone - a settled run's output and a decided checkpoint's value - are
read the same way: an owned run through its own stores, every other run
through `WorkflowArtifactStore.openUnleased` and
`WorkflowDecisionRecordStore.openUnleased`, which verify what an owned store
verifies and refuse every write. Ownership is `owned`, `leased-elsewhere` (the recorded lease
port answers with this run's identity, or an occupant that cannot identify
itself, matching acquisition's fail-safe), or `inactive`. `status()` keeps
leasing as before.

`listRuns(query)` accepts `statuses` (1..11 unique), `includeChildren`
(default `false`: depth 0 only), `limit` (1..100, default 20), and an opaque
`cursor`; a malformed query is `validation` "Invalid workflow run query." and
a foreign cursor "Invalid workflow run cursor.". It scans `<store>/runs`,
reports per-directory problems as `issues` (`invalid-directory`,
`missing-record`, `invalid-record`, `corrupt-journal`, `invalid-projection`,
`torn-tail`, and `unreadable` ("Workflow run could not be read.") for any
other failure while reading one run, such as a permission error; basename
only, fixed messages, at most 16 sorted by directory with the rest counted in
`issuesTruncated`) instead of failing, and returns
summaries newest first (`createdAt` descending, `runId` descending). The
cursor encodes the last returned position, so runs created between pages
appear only on a fresh first page. A summary carries `runId`,
`definitionName`, `status` (`created` for an empty journal), `createdAt`,
`updatedAt` (last complete event), `deadlineAt`, `depth`, `parent`,
`lastSequence`, `taskCounts` (on-path tasks per status, zero-filled, plus
`abandoned` and `total`), `ownership`, `leasedElsewhere`, `availableActions`,
`requiresAttention`, `pendingCheckpointCount`, and `outputArtifactId`; never
the output value (`WorkflowRunSummarySchema`'s optional `output` is filled
only by `inspect(runId, { include: [..., "output"] })`).

`inspect(runId, { include, taskId })` returns `run` (the same summary) plus
the requested sections, default `run`, `budget`, `tasks`: `budget` (declared
and effective budgets, settled and reserved usage from `budget.ts`, and the
scheduler's fixed `exceeded` string when settled usage exceeds the effective
budget or evidence is incomplete), `tasks` (the enriched task view with
`dependsOn` and `inputs`), `executions` (ordered by task then newest
generation; identities, phases, attempts with fixed declined reasons,
settlement, terminal outcome with failure code and stage, produced artifact
ids), `effects`, `barriers`, `artifacts` (metadata and digests only), and
`output`. `output` is not a section of its own: it puts the run's committed
output value on `run.output`, read through
`WorkflowArtifactStore.openUnleased` and verified against the digest and size
the journal records. It is absent unless the run is terminal and committed an
output, and absent from every inspection that did not ask for it, so the
default selection still reads no artifact. Its bound is the artifact bound,
`MAX_WORKFLOW_ARTIFACT_BYTES` (16 MiB), enforced on the write and re-checked
on the read; an unreadable output is `persistence` "Workflow output could not
be read and verified." and missing metadata "Workflow output artifact
metadata is missing.".
Bounded sections keep 256 items (`executions` the first 256 in order, or all
of one task's when `taskId` is given; the others the newest 256) and record
the omitted count in `truncated`. Refusals: "Invalid workflow run ID.",
"Invalid workflow inspection selector.", "Invalid workflow task ID."
(`validation`); `not-found` for a missing run; `persistence` "Workflow run
record is invalid." and "Workflow run journal is corrupt." (interior
corruption, or a journal that violates run invariants).

`logs(runId, { afterSequence, limit })` (`afterSequence` ≥ 0, `limit` 1..500
default 100; otherwise "Invalid workflow log query.") derives one entry per
`workflow-effect`, `run-status-changed`, `task-status-changed`, attempt
intent/receipt/decline, `task-execution-terminal`,
`task-execution-checkpoint-requested` (kind `checkpoint`, status `requested`,
"Checkpoint requested."), `task-execution-checkpoint-decided` (kind
`checkpoint`, status `decided`, `Checkpoint decided by ${source}.` with the
journaled `source` (`operator` or `default`) and `reason`; never the decision
value or the approver), and `task-invalidated`
event with fixed message formats, `status`, journaled `reason`, and
`failureCode` (subagent code or workflow stage); abandoned effects are marked,
not dropped. Declarations, barriers, artifact and identity events, digests,
`output`, and child prose never appear. Entries ascend by sequence;
`nextAfterSequence` is present only when later qualifying entries exist.

`previewInvalidation(runId, causeTaskId)` is the lease-free preview of
`invalidate`: it validates the ids ("Invalid workflow run ID.", "Invalid
workflow task ID."), reads the run as `inspect` does ("Workflow run has no
tasks to invalidate." for an empty journal), and runs the reducer's own
`invalidationClosure` over the projection, returning `runId`, `causeTaskId`,
`taskIds` (the cause and its live transitive dependents), `taskKeys`,
`abandonedEpochs`, and `abandonedTaskIds` (the on-path tasks declared in those
epochs, which the reducer marks abandoned when the invalidation is applied).
It raises the reducer's refusal as `validation` with the reducer's message
("invalidation cause task is unknown", "invalidation cause is already
invalidated", "task execution generation bound exceeded"), never appends, and
never judges the run's status, nesting, deadline, or ownership: whether
`invalidate` is legal is `availableActions`. The command line and the
inspector confirmation take their closure from this method only.

`prune(options?)` is store-level retention, not a run action. It moves every
terminal, settled run (`completed`, `completed-degraded`, `failed`,
`cancelled`) and its lease file from `runs/<run-id>` and
`leases/<run-id>.lease.json` into `trash/<yyyymmdd-hhmmss>/<run-id>/` as
`run/` and `lease.json`, beside a `manifest.json` carrying `schema`
(`"pi-workflow-prune"`), `contractRevision`, `runId`, `status`, `prunedAt`,
and `reason`. The manifest is written before anything is renamed. It appends
no journal event, changes no run's status, and deletes nothing; `listRuns`
stops reporting a pruned run because it scans `runs/` alone, and the evidence
is recoverable from trash by hand. `dryRun` defaults to true and reports the
same selection an apply performs without creating or moving anything.
`olderThanMs` (1 ms to 365 days) keeps runs whose `updatedAt` is younger than
the bound. A run that is not terminal-and-settled is skipped `not-terminal`,
one inside the bound `too-recent`, and one whose lease a live process holds
`lease-held` - the ordinary read-only lease probe, failing closed on an
unidentified occupant and on a lease record too corrupt to read. A run this
service itself drove and settled is the exception: its own lease is released
immediately before the move. It refuses after shutdown (`conflict`) and
refuses an unknown option or an out-of-range bound (`validation`, "Invalid
workflow prune options.").

`subscribe(listener)` observes every append this service makes to an owned
run's journal as `{ runId, status, sequence }`, delivered from the journal's
post-append microtask in sequence order per run without coalescing; a
listener that throws affects nothing. It refuses after shutdown (`conflict`,
"Workflow service is closed."), returns an idempotent unsubscribe, and never
notifies for runs leased elsewhere, which the widget must poll through
`listRuns`.

### Operator surface

The Pi extension's `/workflow` command, `alt+w` inspector, and `pi-workflow`
widget are projections of the read surface. They act only on
`availableActions`, `requiresAttention`, `ownership`, and `leasedElsewhere`
from run summaries; no UI module imports the legality predicates (only the
`WORKFLOW_RUN_ACTIONS` and `IMPLEMENTED_WORKFLOW_RUN_ACTIONS` constants), and
an action the summary does not list is refused before the service is called
(`<action> is unavailable while the run is <status>.` or
`<action> is unavailable: <runId> is leased by another Pi process.`). The
grammar (`list`, `runs [--all]`, `prune`, `validate`, `run`, `show|status`,
`logs`, `wait`, then the run actions) derives its action subcommands from
`IMPLEMENTED_WORKFLOW_RUN_ACTIONS` minus `wait` and `decide` (`stop`,
`reconcile`, `invalidate`, `retry`, `resume` in this build), so an action
appears only in builds whose service implements it, and a build
that lists an action without its method fails with
`<action> is not implemented by this workflow service.` Run prefixes resolve
through `listRuns({ includeChildren: true })` with an exact id winning over an
ambiguous prefix; task keys are `[...namespace, key].join("/")` (a leading
`/` as log entries render it is accepted) or full task ids, and abandoned
tasks are never actionable. `prune` is the one subcommand that is not a run
action: it takes no run prefix, is not derived from
`IMPLEMENTED_WORKFLOW_RUN_ACTIONS`, is absent from the inspector's per-run
palette (which is `availableActions` and nothing else), and is not a tool. It
forwards to `service.prune`, defaults to a dry run, confirms before an apply
when a UI is present, and accepts `--older-than <n><s|m|h|d|w>` up to 365 days. The widget lists depth-0 runs in the nonterminal
and attention statuses, shows at most two lines, hides when both are empty,
refreshes from `subscribe`, and polls (unref'd, 5 s) only while a listed run
is nonterminal or awaits recovery. The attention line names `/workflow prune`
exactly when every run it counts is terminal, prunable, and not leased
elsewhere; attention itself is unchanged, so a terminal failed run needs
action until it is pruned. While a listed run this session owns waits
for a decision it may record (`status: "waiting"`, `ownership: "owned"`,
`pendingCheckpointCount > 0`, `decide` in `availableActions`), the first line
becomes `waiting for you: <prompt>` cut to `WORKFLOW_WIDGET_WIDTH` (80)
columns and the ongoing and attention counts collapse into the second; the
prompt is read from one lease-free `inspect(runId, { include: ["tasks"] })`
per parked (run, execution) and cached, so polling never re-inspects. Widget and inspector recover from durable
state after reload; they own no lifecycle authority.

### Task view

Every run view carries `tasks` once events exist: one frozen entry per
declared task in materialization order with `id`, `namespace`, `key`, `kind`,
`role` (`task` or `finalizer`), `disposition`, `status`, `generation` (the
highest generation recorded for the task, or 0), the current execution's `executionId`, `attempts` (agent
executions: the attempt count), `settlement` (`attemptOrdinal`, `status`,
`failureCode`, `failureRetry`, `usageComplete` from the agent or nested
settlement), `outcome` (the terminal outcome), `abandoned: true` for abandoned
history, for a completed worktree task, `handoff` (its
`WorkflowHandoffDescriptor`; status views need no subagent acquisition), and,
for every checkpoint task, `checkpoint` (see
[Checkpoint views](#checkpoint-views)). Every run view that carries `tasks`
also carries `pendingCheckpoints`: the on-path checkpoints awaiting a decision
in materialization order, each `{ taskId, namespace, key, executionId,
requestedAt, expiresAt?, taskKey?, prompt?, promptTruncated?, schemaSummary?,
inputsSummary?, instruction? }` (see
[Checkpoint views](#checkpoint-views)), empty unless a checkpoint waits.
`inspect` adds `dependsOn` and `inputs`.

### Dynamic run view

A run view carries `dynamic: { ref, sourceSha256, approvalSha256,
hostApiSha256 }` exactly when the run record's `definitionKind` is
`"dynamic"`; static run views carry no `dynamic` member. `approvalSha256` is
the digest of the approval record copied into the run directory when the run
was created (`deriveDecisionRecordSha256`).

### Handoff export

`exportHandoff(runId, taskId)` opens the run through the same inactive-open
path as status, requires the task to be `completed`, selects the current
execution's handoff artifact, verifies it (`verifyWorkflowHandoffEvidence`:
preflight mode, artifact provenance, digest, format, embedded commit, and
identity equal to the settlement and import), and returns a
`WorkflowServiceHandoffExport` (`descriptor` with the verified `content` bytes
read through `readBytes`). A task without a handoff artifact is rejected with
`validation` ("Workflow task has no handoff artifact."); a verification failure
is a `persistence` error. No Pi tool exports handoffs.
Declarative retry and resume attempts run under task policy without a service
call. Operator-triggered `retry` and interrupted-run `resume` are the service
methods described under [Lifecycle methods](#lifecycle-methods), advertised
through `availableActions` and exposed as `workflow_retry` and
`workflow_resume`.

## Dynamic workflows

A dynamic workflow is `defineWorkflow` source proposed as text and executed in
a worker-thread VM against the ordinary static runtime after a human approved
it. The runtime contract publishes `dynamicWorkflows: true`. Nothing below
runs without Pi project trust: every dynamic service method first refuses
with `validation` "Dynamic workflows require project trust." when the project
is untrusted (D10: the source is untrusted orchestration input executing in a
determinism boundary inside a trusted process, and a run writes under
`<cwd>/.pi/workflow`). The user-fixed rules of the design are: approval is
human-only through a Pi command with an explicit `ctx.ui.confirm`, never a
model tool; approval records are definition-level (per source digest) and
copied into every run directory; dynamic runs are root runs (depth 0) that
may declare nested static children, and a dynamic definition is never a
nested child; the source language is full TypeScript through a bundled
transformer whose identity is part of `hostApiSha256`; one VM per drive;
declarations are synchronous in the VM so it exposes `WorkflowContext`
exactly, and barriers are asynchronous replies.

### Reference and intake

A dynamic reference is `dynamic:<sourceSha256>` (`DYNAMIC_REF_PATTERN` =
`^dynamic:[a-f0-9]{64}$`), where `sourceSha256` is the SHA-256 of the UTF-8
bytes of the source exactly as proposed. A string that starts with `dynamic:`
but does not match is `validation` "Invalid dynamic workflow reference.";
`dynamic:` references never reach static discovery.

`propose(source, { proposer })` runs under the service lock and refuses, in
this order, each a `WorkflowServiceError` (code in brackets):

1. trust: [validation] "Dynamic workflows require project trust.";
2. bounds: "Dynamic workflow source must be a string.", "Dynamic workflow
   source is empty.", "Dynamic workflow source exceeds 262144 bytes."
   (`MAX_DYNAMIC_SOURCE_BYTES`), and "Dynamic workflow source is not valid
   UTF-8." (a lone surrogate or a NUL byte) [validation];
3. the import gate of static definitions with its messages verbatim
   ("workflow import <specifier> is not identity-bound by contract revision
   19", "dynamic workflow imports are not supported by contract revision 19",
   "dynamic imports and CommonJS require are not supported by contract
   revision 19", "TypeScript import assignment is not supported by contract
   revision 19", "workflow definition syntax is invalid"); the allow-list is
   `@vegardx/pi-workflow`, `typebox`, and the module specifiers of the
   registered support tasks [validation];
4. the dynamic-only rules: "dynamic workflow source may not use import.meta"
   and "dynamic workflow source must have exactly one default export and no
   named exports" (a re-export of an allowed module counts as a named
   export; top-level `await` is permitted) [validation];
5. the proposer: `{ kind: "tool" | "command" | "api", via }` else "Invalid
   dynamic workflow proposer." [validation];
6. the store cap: a new digest while the store already holds
   `MAX_DYNAMIC_PROPOSALS` (1024) proposals is [conflict] "Dynamic workflow
   proposal store is full.";
7. manifest extraction in a manifest-only VM (below): any VM failure is
   [validation] "Dynamic workflow manifest extraction failed: <reason>" with
   the bridge reason from the failure table; a manifest that fails
   `DynamicWorkflowManifestSchema`, whose schemas fail
   `validateJsonSchemaDocument`, or whose canonical bytes exceed
   `MAX_DYNAMIC_MANIFEST_BYTES` (512 KiB) is "Dynamic workflow manifest is
   invalid.";
8. the write to the proposal store: a known digest under the same
   `hostApiSha256` returns the existing proposal (idempotent; a differing
   manifest for the same bytes is store corruption), a known digest under a
   different `hostApiSha256` has its derived records rewritten atomically
   while the source bytes are never rewritten, and any other store failure is
   [persistence] "Dynamic workflow proposal store is corrupt.".

The returned `DynamicWorkflowProposalView` (`DynamicWorkflowProposalViewSchema`,
the `workflow_propose` output) is `{ ref, sourceSha256, sourceBytes,
manifest, manifestSha256, hostApiSha256, importPolicySha256,
definitionIdentitySha256, transformer, proposer, proposedAt, decision?,
runnable, path }`, where `decision` is `{ decision, approver, approvedAt,
approvalSha256, reason? }` once a human decided and `runnable` is true iff the
decision is `approved` and both `hostApiSha256` and `importPolicySha256`
equal the current ones. `inspectProposal(ref)` returns the same view plus
`source`; it is the only surface that returns the source text and is not a
tool. `proposals()` is a bounded lease-free scan of the proposal store
(sorted by digest, at most 1024 entries); a corrupt entry or an unreadable
approval is reported as `{ ref, issue }` instead of failing the listing. An
unknown digest is [not-found] "Dynamic workflow proposal not found:
dynamic:<sha>".

### Proposal store and manifest VM

Proposals are derived data keyed by source digest under
`<storeRoot>/dynamic/<sourceSha256>/` (`source.workflow.ts` with the exact
bytes, the active `manifest.json` + `proposal.json` pair under
`records/<version>/` named by the pointer file `current`, and the
definition-level `decisions/` store), written through a temporary directory
and one atomic rename with the same `wx`, fsync, mode `0600`/`0700`,
symlink-refusing, and canonical-bytes discipline as the artifact and decision
stores; a host API change stages a new pair and swaps `current` in one
rename, so readers never see a mixed pair; see
[Persistence and recovery](persistence.md#dynamic-proposals-and-run-definition-copies).
The `proposal.json` record (`DynamicWorkflowProposalRecordSchema`) carries
`schema: "pi-workflow-dynamic-proposal"`, `contractRevision`, `sourceSha256`,
`sourceBytes`, `manifest`, `manifestSha256`, `hostApiSha256`,
`importPolicySha256`, `definitionIdentitySha256`, `transformer` (`{ name:
"amaro", version: "1.2.0", mode: "transform", options }`), `proposer`,
`proposedAt`, and `projectRoot`.

The manifest is `{ meta, inputSchema, outputSchema }` of the source's default
export, normalised through the same `defineWorkflow` the registry uses, so a
proposal's manifest equals what static discovery would compute for the same
source (`concurrency` defaults to 4). It is extracted by booting a
manifest-only worker (`extractDynamicWorkflowManifest`): the worker
transforms and evaluates the module with `runId: "workflow_manifest"`, `cwd:
"/"`, `input: null`, a zero seed and epoch, posts `ready { manifest }`, and
exits; the boot watchdog is `DYNAMIC_VM_MANIFEST_TIMEOUT_MS` (5000 ms). The
module is evaluated but `run` is never called during extraction.

### Approval

Approval is a human decision and never a model tool. There is no
`workflow_approve`, `workflow_reject`, or `workflow_proposals` tool;
`workflow_propose` only proposes, and its output tells the model that a human
must approve with `/workflow approve`. The Pi commands `/workflow approve
dynamic:<sha256> [reason…]` and `/workflow reject dynamic:<sha256>
[reason…]` (`src/ui/commands.ts`, `src/extension.ts`) refuse outside an
interactive session ("Dynamic workflow approval requires an interactive Pi
session."), render the proposal through `renderDynamicProposal` (name,
budget, proposer, current decision, runnability, digests, schemas, and the
numbered source, cut at `MAX_DYNAMIC_APPROVAL_RENDER_BYTES` = 64 KiB with a
pointer to the stored source file), require an explicit `ctx.ui.confirm`,
record nothing when the confirm is cancelled ("No decision recorded."),
refuse an already decided proposal from the view's decision state, and call
`decideSource` with `approver: { kind: "human", via: "/workflow approve" |
"/workflow reject", sessionId? }` (the session id when the context carries
one). Every service refusal is surfaced verbatim. Embedders without Pi call
`decideSource` directly; no model surface can.

`decideSource(ref, { decision, approver, reason? })` runs under the service
lock and refuses, in this order: trust; the reference ("Invalid dynamic
workflow reference."); the approver, which must be `{ kind: "human", via,
sessionId? }` ("Invalid dynamic workflow approver."; a `kind: "model"`
approver fails the schema); the decision, `"approved"` or `"rejected"`
("Invalid dynamic workflow decision."); a `reason` outside 1..4096
characters ("Invalid dynamic workflow decision reason."); an unknown digest
([not-found] "Dynamic workflow proposal not found: dynamic:<sha>"); a
proposal whose `hostApiSha256` is not the current one ("Dynamic workflow
proposal predates the current host API; propose the source again."), whose
`importPolicySha256` is not the current one ("Dynamic workflow import policy
changed since the proposal; propose the source again."), or whose
`projectRoot` is not this project ("Dynamic workflow proposal belongs to
another project."); and an existing decision ([conflict] "Dynamic workflow
source is already approved." or "Dynamic workflow source was rejected.").

The decision is one `WorkflowDecisionRecord` in the proposal's `decisions/`
store, opened with `WorkflowDecisionRecordStore.openRoot` (definition-level:
no run, no journal, no lease fence). Its binding is
`{ kind: "source-approval", definitionIdentitySha256, sourceSha256,
contractRevision: 18 }` (`SourceApprovalDecisionBindingSchema`), its
`source` is `"operator"`, `decidedBy` is `human:<approver.via>`, and its
`value` (`DynamicSourceApprovalSchema`, `valueSchemaSha256 =
DYNAMIC_SOURCE_APPROVAL_SCHEMA_SHA256`) is `{ schema:
"pi-workflow-source-approval", sourceSha256, manifestSha256, hostApiSha256,
importPolicySha256, definitionIdentitySha256, decision, approver,
approvedAt, projectRoot, reason? }`. The store enforces the human-only rule on
write and read: a `source-approval` record must be an operator decision
whose `decidedBy` starts with `human:` and whose value digests equal the
binding, else "invalid workflow decision record"; the run-scoped store
refuses `source-approval` bindings ("workflow decision record binding does
not belong to a run") and the definition-level store refuses `checkpoint`
bindings ("workflow decision record binding does not belong to a definition
store"). One record exists per binding ("decision record already exists for
this binding"), there is no revoke, and a rejection is as immutable as an
approval: re-proposing a rejected digest returns the proposal with
`decision.decision === "rejected"` and `runnable: false`, and only a changed
source (a new digest) can be approved. Because the binding carries
`definitionIdentitySha256`, which contains `hostApiSha256`, a package upgrade
(a new `DYNAMIC_HOST_API_REVISION`, transformer, bound, or shim export)
rebinds the same source and requires a fresh human approval; the earlier
record stays on disk and simply no longer matches. `importPolicySha256` is
separate from the host API because it depends on the embedder's support
registry, not the package; the approval captures it and `run`, `validate`,
and resume refuse when the current registry digest differs.

### Running

`run("dynamic:<sha>", input)` and `validate("dynamic:<sha>", input?)` replace
static resolution with these checks, in this order, before anything durable
is created: trust; the reference; the proposal ([not-found] as above);
`validation` "Dynamic workflow proposal belongs to another project.",
"Dynamic workflow proposal predates the current host API; propose the source
again.", "Dynamic workflow import policy changed since approval."; then the
approval: an unreadable or non-approval record is [persistence] "Dynamic
workflow approval record is invalid.", no record is "Dynamic workflow source
is not approved for the current host API.", a rejection is "Dynamic workflow
source was rejected.", another project's approval is "Dynamic workflow
approval belongs to another project.", and an approval whose manifest, import
policy, or host API digest disagrees with the proposal is "Dynamic workflow
approval does not match the proposal.". Input validation then follows the
static path. `validate` returns `{ valid: true, workflow }` with `scope:
"dynamic"`, `source: "proposal"`, `path` = the stored
`source.workflow.ts`, and `identitySha256` = `definitionIdentitySha256`;
`WorkflowRootScope` gains `"dynamic"` while discovery still registers only
`package` and `builtin` roots.

`run` chooses `createdAt` first (it fixes the VM clock), builds the dynamic
`DiscoveredWorkflow` (`createDynamicDiscoveredWorkflow`: the definition from
the manifest, the proposal's path-free identity, `scope: "dynamic"`, `source:
"proposal"`), binds the subagent owner, takes the lease, opens the journal,
writes the run's `definition/` copy (source, manifest, proposal record, and
approval record, each written exclusively; an existing file is [persistence]
"Workflow run definition copy already exists."), and only then creates the
run record, so a run record implies the copies exist. The record carries
`definitionKind: "dynamic"`, `definitionPath` (the stored source path),
`definitionName` from the manifest, `definitionIdentitySha256`,
`definitionSourceSha256`, `approvalSha256 =
deriveDecisionRecordSha256(approval)`, and `hostApiSha256`. Static root and
nested child records carry `definitionKind: "static"` and neither digest;
`definitionKind === "dynamic"` requires both digests, `depth: 0`, and no
`parent`, otherwise the record is rejected as an invalid run record.
`compose` is unchanged, and `ctx.workflow` from dynamic source resolves only
discovered static definitions, so a dynamic definition can never be a child.

### Resume verification

On resume (`wait`, `stop`, `reconcile`, `invalidate`, and every other
inactive open) a dynamic record is rebuilt from the run directory alone
(`dynamicWorkflowForRecord`); the proposal store and the definition-level
decision store are never consulted. The `definition/` copy is read with the
store discipline (`O_NOFOLLOW`, size bounds, fatal UTF-8, canonical bytes)
and verified in this order, each refusal a `WorkflowServiceError`:

1. a missing, oversized, non-canonical, or schema-invalid copy is
   [persistence] "Workflow run definition copy is missing or corrupt."; a
   record without both dynamic digests is "Workflow run record is invalid.";
2. `sha256(copied source) !== record.definitionSourceSha256`: [validation]
   "Dynamic workflow source changed since the run was created.";
3. the copied approval fails `WorkflowDecisionRecordSchema`, its record digest
   differs from `record.approvalSha256`, it is not a `source-approval` record
   for `record.definitionIdentitySha256`, or its decision is not `approved`
   (a single flipped byte suffices): "Dynamic workflow approval record
   changed since the run was created.";
4. `deriveDynamicHostApiSha256() !== record.hostApiSha256`: "Dynamic workflow
   host API changed since the run was created.";
5. the current `importPolicySha256` differs from the approval's: "Dynamic
   workflow import policy changed since approval.";
6. the copied manifest's digest differs from the approval's, or the copied
   proposal's identity differs from the record's: "Dynamic workflow manifest
   changed since approval.";
7. `cwd !== record.cwd`: "Workflow definition, source, or project identity
   changed.".

Deleting the store decision after a run was created leaves that run
resumable (the copy is the evidence) while a new `run` refuses "Dynamic
workflow source is not approved for the current host API.".

### Host API and import policy digests

`deriveDynamicHostApiSha256()` is a build-time constant: the canonical digest
of `contractRevision`, `DYNAMIC_HOST_API_REVISION` (1), the sorted
`DYNAMIC_BUILTIN_MODULES`, `DYNAMIC_SHIM_EXPORTS`,
`DYNAMIC_CONTEXT_PROPERTIES`, `DYNAMIC_CONTEXT_METHODS`, the RPC method and
message-type lists, the patched globals (`Date`, `Math.random`, `console`),
`DYNAMIC_VM_CODE_GENERATION`, every VM limit (`MAX_DYNAMIC_SOURCE_BYTES`,
`MAX_DYNAMIC_MANIFEST_BYTES`, `MAX_DYNAMIC_RPC_MESSAGES`,
`MAX_DYNAMIC_RPC_MESSAGE_BYTES`, `MAX_DYNAMIC_RPC_ARGS`,
`MAX_DYNAMIC_HANDLE_REFS`, `MAX_DYNAMIC_VM_ERROR_CHARS`, the boot, manifest,
compute, sync-wait, and abort-grace timeouts, and
`DYNAMIC_VM_RESOURCE_LIMITS`), and the `DYNAMIC_TRANSFORMER` identity
(`amaro` 1.2.0, `mode: "transform"`, Node's own transform options).
`MAX_DYNAMIC_PROPOSALS`, `MAX_DYNAMIC_PROPOSAL_RECORD_BYTES`, and
`MAX_DYNAMIC_APPROVAL_RENDER_BYTES` are store and UI caps outside it. Review
rule: a behavioural change to the shim, the bridge, or the prelude that no
constant captures must bump `DYNAMIC_HOST_API_REVISION`, because changing the
digest is what invalidates every recorded approval.

`deriveDynamicImportPolicySha256(supportHelpers)` is registry-derived and
order-independent: the sorted built-in modules plus, per published helper,
`{ moduleSpecifier, exportName, implementationIdentitySha256 }`. The service
computes it from the registrations that carry an `exportName`, and the same
`supportHelpers` list travels to the worker as the module table of importable
helpers. The installed transformer must be exactly `DYNAMIC_TRANSFORMER_VERSION`
("dynamic workflow transformer version mismatch" at service construction and
in the worker); `compatibility.json` records `transformer: { package:
"amaro", version: "1.2.0" }`.

### The VM

Each drive spawns one `node:worker_threads` worker
(`resourceLimits: DYNAMIC_VM_RESOURCE_LIMITS` = 256 MiB old generation, 32 MiB
young generation, 16 MiB code range, 4 MiB stack; `env: {}`; captured and
discarded stdout/stderr; named `pi-workflow-dynamic:<first 12 hex of the
digest>`) with `workerData` `{ mode: "manifest" | "run", source,
sourceSha256, filename: "dynamic:<sha>.workflow.ts", supportHelpers,
syncBuffer, syncPort }`. The worker pins the transformer version, waits for
`start { input, runId, cwd, seed, epochMs }`, transforms the source with
`amaro` in transform mode (full TypeScript: enums, parameter properties,
`satisfies`, namespaces; `module Foo {}` is an error; `import type` and
`type` specifiers are erased), rewrites the surviving value imports into
`__import`/`__importNamespace` calls over a frozen module table and the
default export into `__exports.default`, wraps the body in one async function
(top-level `await` is permitted, as in the static loader), evaluates it with
`vm.Script` in a context created with `codeGeneration: { strings: false, wasm:
false }`, normalises the default export through the real `defineWorkflow`
("workflow module has no valid default definition" otherwise), and posts
`ready { manifest }`. The transform is a pure function of the bytes, the
options, and the amaro version; it is recomputed on every boot and never
persisted. The module table is `@vegardx/pi-workflow` (the real
`DEFAULT_WORKFLOW_CONCURRENCY`, `MAX_WORKFLOW_CONCURRENCY`,
`WORKFLOW_CONTRACT_REVISION`, `defineWorkflow`, `isArtifactHandle`,
`isTaskHandle`, `isWorkflowDefinition`, and `defineSupportTask` wrapped so
`registration()` throws "Dynamic workflow source may not register support
implementations."), `typebox` (a frozen copy of the namespace), and each
published support helper under `moduleSpecifier` and `exportName`. An import
the table does not hold fails the transform ("dynamic workflow import
<specifier> is not available"); a missing export fails evaluation ("Dynamic
workflow import "<specifier>" has no export "<name>"."). Module objects are
worker-realm objects exposed into the context, so `instanceof` against
context intrinsics is not guaranteed.

Determinism aids, all part of `hostApiSha256` and explicitly not security:
the prelude fixes `Date`'s zero-argument forms and `Date.now()` to the run's
`createdAt` (`epochMs`), seeds `Math.random` with xorshift128+ from the first
16 bytes of `seed = deriveJsonValueSha256({ kind: "dynamic-vm-seed", runId })`
so two boots of the same run see the same sequence, replaces `console` with
frozen no-ops, and then seals the global: the contextified global cannot be
frozen, so it is a proxy that refuses every definition, assignment, and
deletion after the prelude with the message a frozen object gives
("Cannot add property <name>, object is not extensible"). Nothing else is
exposed: `typeof process`, `require`, `fetch`, `setTimeout`,
`structuredClone`, `TextEncoder`, and `queueMicrotask` are all `"undefined"`
in the context, `eval` and `new Function` throw `EvalError`, and `import()`
rejects because the script has no dynamic-import callback. The worker
thread's own realm still has `process` (with an empty environment); the VM
context does not. The worker-thread VM is a determinism and API boundary,
not an OS security boundary.

### RPC bridge

All VM→host traffic and asynchronous host→VM traffic travel on the worker's
main channel; only `reply` messages answering `call` requests travel on a
dedicated `syncPort`. VM→host messages (`DynamicVmMessageSchema`) are `ready
{ manifest }`, `call { id, method, args }` for the synchronous methods
(`DYNAMIC_SYNC_METHODS` = `agent`, `agentInNamespace`, `checkpoint`,
`finalize`, `log`, `phase`, `support`, `workflow`), `await { id, method,
handles }` for the asynchronous barriers (`DYNAMIC_ASYNC_METHODS` = `handoff`,
`result`, `results`, `settled`; at most `MAX_DYNAMIC_HANDLE_REFS` = 256
handles), `done { result }` (`{ kind: "value", value }`, `{ kind: "task",
ref }`, or `{ kind: "artifact", ref }`), and `failed { error }` (`{ name,
message, stack? }`, bounded to 128, 1024, and 8192 characters). Host→VM
messages are `start`, `reply { id, ok: true, value, aborted }` or `reply {
id, ok: false, error, aborted }`, and `abort { reason }`. Request ids are
contiguous integers from 1 to `MAX_DYNAMIC_RPC_MESSAGES`. Handles never cross
as objects: a task handle travels as `{ kind: "task-handle", ref, output,
handoff? }` (`handoff` present exactly when the real handle is a worktree
handle) and a result or handoff artifact handle as `{ kind:
"artifact-handle", ref }`; the host resolves refs against the handles it
issued in this drive and answers an unknown one with the reply error
"Dynamic workflow referenced an unknown task handle.", while the shim
rebuilds a returned ref into a real, frozen, worker-realm `TaskHandle`
("Dynamic workflow host returned an invalid task handle." otherwise).

Every VM message is admitted by a guard, and each violation is fatal to the
drive (stage `protocol`): a message outside the schema ("Dynamic workflow VM
sent an invalid message."), a message whose JSON exceeds
`MAX_DYNAMIC_RPC_MESSAGE_BYTES` (17 MiB, above the 16 MiB artifact bound
plus envelope: "Dynamic workflow VM message exceeds 17825792 bytes."), more
than `MAX_DYNAMIC_RPC_MESSAGES` messages ("Dynamic workflow VM exceeded
65536 messages."), a request id that is not the previous one plus one
("Dynamic workflow VM request ids are not contiguous."), a `call` while
another `call` is unanswered ("Dynamic workflow VM issued overlapping
synchronous calls."), a second `ready`, or anything but `failed` before
`ready`. The host checks `call` arguments before dispatch
(`DYNAMIC_SYNC_CALL_ARGS_SCHEMAS`: a task key and a request object for the
declarations, a namespace of 1..32 keys plus key and request for
`agentInNamespace`, one string for `phase` and `log`); a failure is the
non-fatal reply error "Dynamic workflow call arguments are invalid.", and
`phase`/`log` are admitted on type alone so the static context produces its
own length messages ("Workflow phase must contain 1 to 128 characters.",
"Workflow log must contain 1 to 4096 characters."). The same size bound
applies to replies: an oversized barrier result becomes the reply error
"Dynamic workflow barrier result exceeds 17825792 bytes." rather than a
failure. Reply errors carry `name` and `message` only (host stacks stay
host-side) and are rethrown into the source with the names preserved
(`WorkflowMaterializationError`, `StaticWorkflowRuntimeError`, plain
`Error`, `DynamicWorkflowHostError`).

Synchronous declarations: the shim's `syncCall` posts `call`, then blocks in
`Atomics.wait` on a 4-byte shared flag for at most `DYNAMIC_VM_SYNC_WAIT_MS`
(30000 ms; "Dynamic workflow host did not answer a synchronous declaration
within 30000 ms." names the effective wait) and reads the reply with
`receiveMessageOnPort` ("Dynamic workflow host answered the wrong
synchronous call." if it is missing or names another id). The host answers a
`call` synchronously inside its message handler by invoking the static
context method (`phase`, `log`, `agent`, `support`, `workflow`, `checkpoint`,
`finalize`) or, for `agentInNamespace`, the non-enumerable symbol-keyed host
bridge on the context (`workflowHostBridge`, which does what `fanOut`'s
per-item body does and is not exported from the package), then posts the
reply on `syncPort`, stores the flag, and notifies. `fanOut`, `fanIn`, and
`pipeline` are lowered in the shim with the static runtime's validations and
messages verbatim ("Workflow fan-out namespace is invalid.", "Workflow
fan-out exceeds 64 items.", "Workflow fan-out options are invalid.",
"Workflow fan-in requires 1 to 64 sources.", "Workflow fan-in options are
invalid.", "Workflow fan-in input keys must be unique.", "Workflow pipeline
definition is invalid.", "Workflow pipeline exceeds 64 stages.", "Workflow
pipeline must return one of its stage handles."), thrown with the name
`StaticWorkflowRuntimeError`; a request that contains a function is refused
before the call ("Workflow request contains a function."). The deadlock rule
is normative and tested: (R1) the host answers a `call` synchronously within
the message handler, with no `await` on that path; (R2) the VM has at most
one outstanding `call` and blocks until it is answered; (R3) the host never
sends the VM a message that requires a VM reply (`start`, `reply`, and
`abort` are one-way); (R4) `await` requests are answered on the main channel
and the shim awaits a promise, so barrier drives of any duration cannot
deadlock the VM; (R5) the `Atomics.wait` timeout is a fail-safe for a hung
host, not a scheduling mechanism.

Asynchronous barriers: `ctx.result`, `ctx.results`, `ctx.settled`, and
`ctx.handoff` post `await` ("Workflow barrier target is not a task handle."
for a non-handle; `ctx.handoff` requires a worktree handle, "Workflow handoff
barrier requires a worktree task handle.") and return a promise settled by
the main-channel reply; several may be outstanding. The host resolves the
refs and runs the ordinary `ctx.result`/`results`/`settled`/`handoff`, which
prepare the barrier and drive the scheduler exactly as for static source;
values are deep-frozen in the VM before they are returned. A `results` or
`result` barrier that rejects becomes a reply error, except the static
runtime's park signal (a checkpoint awaiting a decision): the bridge stops
answering, terminates the worker, and rethrows the very same signal so the
static runtime parks the run `waiting` with no `-> failed`; the next drive
boots a fresh VM. `done` resolves `run()`: a JSON value (the shim
round-trips it; "Dynamic workflow return value is not JSON." otherwise), a
real task handle, or a real result or handoff artifact handle looked up in
the host's handle map ("Dynamic workflow returned an unknown task handle."
for one the host never issued); the static runtime then performs the final
barrier and output commit as for static source.

Abort mirroring: when the host `ctx.signal` aborts, the host posts `abort {
reason }` (the signal reason's message, or "Workflow stop requested.") and
every later reply carries `aborted: true`; the shim aborts its own
`AbortController` on either, so the VM's `ctx.signal.aborted` becomes true.
The host then waits `DYNAMIC_VM_ABORT_GRACE_MS` (1000 ms) for `done` or
`failed`; otherwise it terminates the worker and `run()` rejects with stage
`abort` ("Dynamic workflow execution was aborted."). A context already
aborted before boot is refused with the same reason without spawning.

Termination and watchdogs: the worker is always terminated before the drive
settles (success, failure, park, abort, and a terminate failure never replaces
the primary outcome). Host timers are `unref`'d: the boot watchdog runs from
spawn to `ready` (`DYNAMIC_VM_BOOT_TIMEOUT_MS` = 10000 ms in run mode, 5000
ms in manifest mode); the compute watchdog is armed after `ready` and
re-armed after every answered request while no `await` is outstanding,
cleared on any VM message, and paused while a barrier is outstanding
(`DYNAMIC_VM_COMPUTE_TIMEOUT_MS` = 30000 ms); the message-count bound is the
guard's; a worker `error` with `ERR_WORKER_OUT_OF_MEMORY` is the memory
failure; an `exit` before `done`/`failed` and any other `error` are exit
failures. A `DynamicVm` runs once ("Dynamic workflow VM has already run.").

### Definition, failure reasons, and parity

`createDynamicWorkflowDefinition({ manifest, source, supportHelpers,
createdAt })` returns an ordinary `WorkflowDefinition` whose `meta` and
schemas come from the approved manifest and whose `run(ctx)` requires the
static-runtime context (`protocol` "Dynamic workflow bridge requires the
static runtime context." otherwise), boots one VM per call with `start`
taken from the context (`input`, `runId`, `cwd`) and the run (`seed`,
`epochMs = Date.parse(createdAt)`), fails a `ready` manifest that differs
from the approved one (`manifest` "Dynamic workflow manifest changed since
approval."), and always terminates the worker. Because `startDrive` creates
a new static runtime per drive and the worker is spawned inside `run`, every
restart, park, and invalidation recovery re-executes the source from entry in
a fresh worker and replays the persisted prefix exactly as static source does.
Of the `DynamicVmBridgeOverrides`, the service sets only `bootTimeoutMs` and
`computeTimeoutMs`, from its `dynamic` option; `resourceLimits`, `syncWaitMs`,
and `workerEntry` are test-only and never set by the service.

Every failure is a `DynamicWorkflowExecutionError` with a `stage` (`boot`,
`transform`, `manifest`, `source`, `protocol`, `watchdog`, `memory`, `exit`,
`abort`) and a fixed message; the static runtime recognises the error by name
and appends `run-status-changed <status> -> failed` with that exact message
as the reason (after cancelling open checkpoints), where the static path
appends "Static workflow source execution failed.". A source that throws
appends "Dynamic workflow source execution failed: <name>: <message>"
(bounded). The complete table is in
[Failure taxonomy](failures.md#dynamic-workflow-failure-reasons).

Parity: the same source loaded statically and through the shim yields the
same manifest, and driven under the same definition identity, run id, and
input it yields identical `{ type, data }` journal payloads, the same output
value, and the same output artifact digest. The single documented exception
is the `-> failed` reason for a throwing source (the two fixed reasons above).

## Checkpoints

A checkpoint is a human decision that a run parks on. It is an ordinary
declarative task of `kind: "checkpoint"` whose result is the decision value,
validated against the request's JSON Schema and stored as the execution's JSON
`result` artifact, so dependents consume it through the same verified input
path as any other result. Nothing in the runtime, and no model-callable tool,
can approve a checkpoint on a human's behalf: a decision enters the run only
through `WorkflowService.decide`.

### Authoring

```ts
interface CheckpointRequest<TDecisionSchema extends TSchema> {
	readonly schema: TDecisionSchema;
	readonly prompt: string;
	readonly default?: Static<TDecisionSchema>;
	readonly headless: "block" | "use-explicit-default";
	readonly timeoutMs?: number;
	readonly disposition?: "required" | "optional";
	readonly after?: readonly TaskRef[];
	readonly inputs?: Readonly<Record<TaskKey, ArtifactHandle<unknown> | HandoffHandle>>;
	readonly replay?: "auto" | "off" | "read-only";
}

checkpoint<TDecisionSchema extends TSchema>(
	key: TaskKey,
	request: CheckpointRequest<TDecisionSchema>,
): TaskHandle<Static<TDecisionSchema>>;
```

`ctx.checkpoint(key, request)` returns an ordinary `TaskHandle` typed by the
decision schema: `handle.ref` is usable in `after`, `handle.output` (output
`result`) in later `inputs`, and the handle is a legal target of
`ctx.result`, `ctx.results`, `ctx.settled`, and the final return. A
checkpoint handle never carries a `handoff`. `after` gates the checkpoint on
earlier tasks; `inputs` name the result or handoff artifacts the approver is
shown (a handoff input appears as its `WorkflowHandoffDescriptor`, never as
patch bytes, and its producer must be a worktree agent task: "task input names
a handoff of a non-worktree task"). `disposition` defaults to `"required"` and
`replay` to `"read-only"`.

The static runtime rejects a request that is not an object with
`StaticWorkflowRuntimeError("validation", "Workflow checkpoint request is
invalid.")`. The materializer then validates, after the shared prologue
(final barrier, task limit, key, duplicate key, `after` resolution, input
resolution, role dependencies), in this order, each a
`WorkflowMaterializationError`:

1. role `finalizer` → "a checkpoint cannot be a finalizer" (`FinalizeRequest`
   has no `checkpoint` member, so `ctx.finalize` reaches
   "finalizer requires exactly one of support, agent, or workflow" first);
2. `schema` must be a bounded JSON-serializable JSON Schema that compiles
   under Ajv strict mode (the same checks as an agent output schema, named
   "checkpoint decision schema");
3. `prompt` is a string of 1..4096 characters → "invalid checkpoint prompt";
4. `headless` is `"block"` or `"use-explicit-default"` →
   "invalid checkpoint headless policy";
5. `timeoutMs`, when present, is a safe integer of 1_000..365 days →
   "invalid checkpoint timeout";
6. `default`, when present, must be lossless JSON ("checkpoint default is not
   JSON") and satisfy `schema` ("checkpoint default does not match its
   schema");
7. `headless: "use-explicit-default"` requires a `default` →
   "checkpoint headless default requires an explicit default";
8. the lowered `CheckpointTaskRequest` must satisfy
   `CheckpointTaskRequestSchema` ("invalid checkpoint task request") and the
   lowered task `MaterializedCheckpointTaskSchema`
   ("invalid materialized checkpoint task").

The lowered spec is `CheckpointTaskSpec { key, kind: "checkpoint", role,
disposition, after, inputs, replay, request: { schema, prompt, headless,
default?, timeoutMs? }, identitySha256 }`; `deriveCheckpointTaskIdentity`
covers the request (including `default` and `timeoutMs`), the role, and the
definition and input identities, like the support identity. The reducer
repeats the two structural rules on `task-declared` ("a checkpoint cannot be
a finalizer", "checkpoint headless default requires an explicit default").
Finalizers may depend on checkpoints.

### Execution and expiry

A checkpoint execution is a `CheckpointTaskExecutionRecord { kind:
"checkpoint", id, runId, taskId, generation, taskIdentitySha256 }` and passes
through the phases `created -> checkpoint-requested -> checkpoint-decided ->
terminal`. Its events are:

- `task-execution-checkpoint-requested { executionId, inputsSha256,
  expiresAt? }`: `inputsSha256` binds the exact artifacts shown to the
  approver (result digests, or handoff digests); `expiresAt` is present iff
  the request has `timeoutMs`, computed by the executor as
  `min(now + timeoutMs, run deadlineAt)` and reducer-checked to be a finite
  timestamp no later than `event.timestamp + timeoutMs`. Without `timeoutMs`
  the run deadline is the only bound.
- `task-execution-checkpoint-decided { executionId, artifactId,
  decisionSha256, source: "operator" | "default", decidedAt, decidedBy?,
  reason? }`: `decisionSha256` equals the canonical digest of the `result`
  artifact (`sha256`), which must belong to this execution with media type
  `application/json` and `schemaSha256` equal to the digest of the request
  schema. `decidedAt` is the decision record's own time, taken before the
  record was fsynced; it must be a finite timestamp no later than the event's
  `timestamp` ("checkpoint decision time is invalid"). A default decision must
  equal the request's `default` and names no approver; an operator decision
  names one and its `decidedAt` must precede `expiresAt` ("checkpoint decision
  follows its expiry"). Timeliness is judged by the decision time, never by
  the append time, so a record persisted just before the expiry replays after
  the watchdog fired without asking the approver again.
- `task-execution-terminal` with `CheckpointTerminalEvidence { kind:
  "checkpoint", artifactId, decisionSha256, source, decidedBy? }`, outcome
  `completed`, matching the decision; or `WorkflowExecutionFailureEvidence`
  with stage `checkpoint-input` (outcome `failed`, phase `created`),
  `checkpoint-expired` (outcome `failed`, phase `checkpoint-requested`), or
  `stop` (outcome `cancelled`, either open phase).

Checkpoints occupy no concurrency lane and reserve no budget: the scheduler
routes a selected checkpoint to the checkpoint executor before admission, and
a requested checkpoint holds nothing while it waits. Task statuses are
`pending`, `ready`, `waiting`, `completed`, `failed`, `cancelled`, `blocked`,
and `invalidated`, never `running`, `cancelling`, `interrupted`, or
`cleanup-blocked`; the lifecycle gains `waiting -> cancelled`, admitted only
for checkpoints. Fixed task reasons: "Checkpoint awaits a decision."
(`ready -> waiting`), "Checkpoint decided." (`-> completed`), "Checkpoint
expired without a decision." (`-> failed` at `checkpoint-expired`),
"Workflow run ended before the checkpoint was decided."
(`CHECKPOINT_RUN_ENDING_REASON`, `-> cancelled` when the run leaves `running`
or `waiting` for a failure state), and "Workflow stop requested." (an abort
observed before the request is durable).

Expiry policy (`headless` on the request): an expired `block` checkpoint fails
its execution at stage `checkpoint-expired`; an expired
`use-explicit-default` checkpoint records the default decision (`source:
"default"`) and completes. Expiry is applied by the scheduler's sweep on every
`prepare()`, by the service watchdog that re-drives a parked run at its
earliest expiry, and inside `decide`, which expires an overdue checkpoint
instead of accepting the operator's value ("Checkpoint has expired."). A
required checkpoint that fails or is cancelled fails the run ("A required
workflow task did not complete."); an optional one is visible degradation and
`settled` reports `{ status: "rejected", outcome: "failed", failure: {
message: "Checkpoint expired without a decision.", code: "checkpoint-expired"
} }`.

Headless mode (`createWorkflowService({ checkpoints: { headless: true } })`)
short-circuits only `use-explicit-default`: such a checkpoint is decided from
its default immediately after the request event (`ready -> completed`, never
`waiting`). A `block` checkpoint parks in headless mode too; an API caller may
still decide it, and `timeoutMs` or the deadline bounds it.

Input failures before the request (a missing or ambiguous producer artifact,
"Checkpoint input artifact evidence is incomplete."; an input that cannot be
read and verified, "Checkpoint inputs could not be read and verified.")
terminalize the execution `failed` at stage `checkpoint-input`.

### Parking

A lane whose scheduler pass finds nothing selectable while at least one
checkpoint is `waiting` returns the outcome `awaiting-decision` (appending
`running -> waiting`, "Workflow run awaits a checkpoint decision.", when the
run was `running`). The static runtime parks the drive when a batch's outcomes
are all `idle` or `awaiting-decision`, at least one is `awaiting-decision`,
and the batch produced no errors: `drive()` resolves to a
`StaticWorkflowParkedResult { runId, status: "waiting", parked: true,
pendingCheckpoints: [{ taskId, executionId, expiresAt? }] }`
(`isStaticWorkflowParked`) and never appends `-> failed`. Parking is
signalled through the barrier promise by a private sentinel; trusted source
that catches it cannot un-park the run, because every later barrier rethrows
it and the drive still resolves parked. A live drive whose other lane is busy
keeps running, and `decide` works against it as well.

The service keeps a parked run's lease and marks it settled: `wait` returns
the `waiting` view with `parked: true` at once (see
[Lifecycle methods](#lifecycle-methods)); `status` reads the projection; a
watchdog re-drives the run at the earliest pending `expiresAt` or at
`deadlineAt`, whichever is first (bounded to the timer maximum), so expiry
and the deadline stop are applied without a caller; `stop` cancels the open
checkpoints (`waiting -> cancelled` at stage `stop` with the operator's
reason) and lands `cancelled`; `reconcile` re-parks; `shutdown` releases the
lease without stopping a parked run, and a later session resumes it through
`wait`, `decide`, or `stop`. `invalidate` is refused while the run is
`waiting` ("Workflow run status does not admit invalidation."), and the
reducer refuses `task-invalidated` while a checkpoint execution is open
("workflow run has active task executions"). No operator `retry` or `resume`
exists in this build.

Every failure transition fails closed on an open checkpoint: the reducer
rejects `run-status-changed` to `failed`, `interrupted`, or `cleanup-blocked`
while an on-path checkpoint's current execution is not terminal (phase
`created`, `checkpoint-requested`, or `checkpoint-decided`; "run failure
leaves a checkpoint open"), and every failure site (scheduler, task
finalizer, and the static runtime's source and finalization failures) first
settles them through `cancelOpenWorkflowCheckpoints(journal,
CHECKPOINT_RUN_ENDING_REASON)`: an undecided execution is cancelled, and a
decided one whose terminal never landed is committed from its projection
(terminal `completed` with the decision's `CheckpointTerminalEvidence`, then
"Checkpoint decided."), so a failed run never retains an active execution
that would block `invalidate`. A
cancel that loses the race against a concurrent decision is tolerated: the
decided execution is left alone.

A parked nested child run holds its parent's lane: the parent task stays
`running` and continues once the child's checkpoint is decided, expired, or
cancelled and the child's drive re-settles. `decide` refuses a nested run
("Nested workflow runs are decided through their parent run.") and the
`decide` action is never offered for one; no path decides a nested child's
checkpoint yet.

### Decisions

A decision is immutable once recorded. Its durable record is the
`WorkflowDecisionRecord` in the run's `decisions/` store (see
[Persistence and recovery](persistence.md#decision-records)), bound to
`{ kind: "checkpoint", runId, taskId, executionId, effectSha256 }`, where
`effectSha256 = deriveCheckpointEffectSha256({ taskIdentitySha256,
inputsSha256 })` is the checkpoint's effect identity: the task identity
(definition identity, request, role, inputs by name) plus the exact artifact
digests the approver saw. One record exists per binding: a byte-identical
re-put is idempotent and a different record is a conflict, so a second
decision for the same execution is refused ("Checkpoint decision conflicts
with existing decision evidence."). The decision value is additionally the
execution's JSON `result` artifact (never a `.patch`), and the journal
(`checkpoint-decided`, terminal evidence, `-> completed`) is a projection of
the record: after a crash at any prefix the executor converges on the same
`decisionSha256` without asking the human again. A new execution generation
(after invalidation) has a new execution id and therefore a new binding, and
is asked again; a completed checkpoint outside the invalidation closure
replays from its result artifact, validated against the request schema, and
is not re-asked.

`WorkflowService.decide(runId, taskId, { decision, approver, reason? })`
records an operator decision and restarts the parked drive. Under the service
lock it refuses, in this order, each a `WorkflowServiceError("validation",
…)`:

1. "Invalid workflow run ID." and "Invalid workflow task ID.";
2. "Invalid checkpoint decision options." (options not an object, or a
   property outside `decision`, `approver`, `reason`);
3. "Invalid checkpoint approver." (`approver` not a string of 1..256
   characters) and "Invalid checkpoint decision reason." (`reason` present
   but not a string of 1..4096 characters);
4. "Nested workflow runs are decided through their parent run.";
5. "Workflow run status does not admit a checkpoint decision." (run not
   `running` or `waiting`);
6. "Unknown workflow task." (missing or abandoned) and "Workflow task is not
   a checkpoint task.";
7. "Checkpoint is not awaiting a decision." (task not `waiting`, no durable
   request, or already decided);
8. "Workflow run deadline has passed.".

The scheduler then records the decision under its lock through the checkpoint
executor; executor refusals of stage `validation` or `decision` surface as
`validation` with the executor's message: "Checkpoint is already decided."
(a repeated decision; a decided-but-uncommitted execution is committed
first), "Checkpoint is not awaiting a decision." (no durable request yet),
"Checkpoint has expired." (the checkpoint is expired first, per its policy),
"Checkpoint decision does not match its schema.", "Checkpoint decision is not
losslessly JSON serializable.", "Checkpoint decision exceeds the workflow
artifact bound.", and "Checkpoint decision conflicts with existing decision
evidence.". Inputs that no longer hash to the durable `inputsSha256` are a
`persistence` error ("Checkpoint inputs do not match durable intent."), never
a decision. On success the settled drive is restarted without being awaited
(`wait` observes it); a live drive continues and is re-driven if it parks on
an outcome older than the decision. The method returns the current run view.

### Checkpoint views

Every checkpoint task's view carries `checkpoint: { prompt, promptTruncated?,
schema, headless, default?, timeoutMs?, requestedAt?, expiresAt?, inputs?,
decision? }`, with `decision: { source, decidedBy?, decidedAt, reason?,
sha256, value? }`; `requestedAt` copies the request event's timestamp and
`decidedAt` copies the decided event's `decidedAt` (the decision record's
time, not the append time).
Artifact-backed views (`status`, `wait`, `stop`, `decide`, `reconcile`) read
the verified input values into `inputs` (handoff inputs as descriptors) and
the recorded decision into `decision.value`; a read failure is `persistence`
"Checkpoint inputs could not be read and verified." or "Checkpoint decision
artifact metadata is missing.". The lease-free `inspect` omits `inputs` but
does carry `decision.value`, read from the run's durable decision record
through `WorkflowDecisionRecordStore.openUnleased` instead of from the
decision artifact. The journal stays authoritative: the value is shown only
when the record's `valueSha256` equals the `sha256` the journalled decision
names, and a record that cannot be read or that disagrees is `persistence`
"Checkpoint decision could not be read and verified."; a binding with no
record at all simply carries no value. `listRuns` carries no checkpoint view
at all, and `inspect` cuts prompts longer than
`MAX_WORKFLOW_INSPECTION_PROMPT_LENGTH` (256) characters, marking them
`promptTruncated: true`. Log entries never carry the value or the approver.

Each `pendingCheckpoints` entry carries, besides its identity fields
(`taskId`, `namespace`, `key`, `executionId`, `requestedAt`, `expiresAt?`),
six optional fields that say what answering it takes: `taskKey`
(`[...namespace, key].join("/")`, the token `/workflow decide` accepts),
`prompt` with `promptTruncated: true` when it was cut (the same rule as the
checkpoint task view: whole on the artifact-backed views, cut at
`MAX_WORKFLOW_INSPECTION_PROMPT_LENGTH` on `inspect` and `listRuns`),
`schemaSummary` (`checkpointSchemaSummary`: the one-line answer shape),
`inputsSummary` (`renderCheckpointInputs` of the verified inputs;
artifact-backed views only, and omitted when a run parks on so many
checkpoints that each share of `MAX_CHECKPOINT_RENDER_BYTES` would be
unreadable), and `instruction` (`CHECKPOINT_DECIDE_INSTRUCTION`: a person
answers the checkpoint, a model surfaces it and stops). They are optional and
additive: nothing reads them to decide legality.

### Operator surface

`decide` is a service method, and checkpoint decisions are human-only. There
is no model-callable decide tool, by design: a model must never decide a
checkpoint, and `WORKFLOW_TOOL_DECLARATIONS` declares none. The extension
command `/workflow decide <run-prefix> <task-key> [json] [reason…]`
(`src/ui/commands.ts`) is the pass-through to `decide(runId, taskId,
{ decision, approver, reason })`: it is offered only while `availableActions`
lists `decide`, parses `<json>`, when given, as one (optionally quoted) token
and refuses invalid JSON ("Checkpoint decision is not valid JSON.") before
reaching the service, requires an interactive session ("Checkpoint decisions
require an interactive Pi session.") and an explicit confirm that shows the
checkpoint prompt and the parsed decision, and records `approver` as the Pi
session identity (`"pi-session"`; the pinned extension API exposes no user
name), never an argument. Embedders without Pi call the service directly.

The operator does not have to type JSON. When a run this session owns parks in
a session with dialog-capable UI, the extension asks the session user itself,
once per checkpoint execution: a guided form (`src/ui/checkpoint-form.ts`,
driven by `src/ui/parked-observer.ts`) shows the prompt, the run, the expiry,
the declared inputs, and the answer shape, then asks the decision field by
field from the decision schema (a boolean, an enum, a string, a number, or a
small flat object) and falls back to one JSON editor for anything larger. The
service is the only validator: a refusal it raises re-opens the last dialog
with the service's message. Dismissing any dialog, or declining the final
confirm, records nothing and leaves the run parked; answering records exactly
one decision with `approver: "pi-session"`. The same form backs `/workflow
decide` without `<json>` and the inspector's `Decide a checkpoint` palette
entry, which the palette offers only while `availableActions` lists `decide`.
Nothing here is a new authority: every path ends in the one human-only
`decide` call.

A parked run is surfaced to the operator, never polled by a model: `wait`
returns immediately with `parked: true` and `pendingCheckpoints` (prompt, task
key, answer shape, inputs summary, and the fixed decide instruction), the
`/workflow` widget shows `waiting for you: <prompt>` on its first line, and
the inspector shows the pending checkpoints.

### Reducer rules

The reducer enforces, with these exact messages: "checkpoint execution target
is not a checkpoint task"; "checkpoint request is out of order"; "checkpoint
request requires a running workflow run" (the run must be `running` or
`waiting`); "checkpoint request does not match its task" (`inputsSha256`);
"checkpoint request expiry is invalid"; "checkpoint decision is out of
order"; "checkpoint decision requires a running workflow run"; "checkpoint
decision artifact does not match"; "checkpoint default decision requires the
headless default"; "checkpoint default decision may not name an approver";
"checkpoint operator decision requires an approver"; "checkpoint decision
follows its expiry"; "checkpoint terminal evidence precedes its decision";
"checkpoint terminal outcome is not completed"; "checkpoint terminal decision
does not match"; kind mismatches such as "support task has checkpoint
terminal evidence" and "checkpoint task has subagent terminal evidence";
"workflow terminal evidence is inconsistent" for any stage or phase
combination outside the three admitted above (so `handoff-import` is never
admitted on a checkpoint, and `checkpoint-expired` or `checkpoint-input` never
on another kind); "checkpoint task may not run"; "checkpoint task became
waiting without a persisted request"; "checkpoint task may not enter
cancelling"; "checkpoint task may not be interrupted"; "checkpoint task may
not be cleanup-blocked"; "only a checkpoint task may be cancelled while
waiting"; "checkpoint task input artifact is missing or ambiguous";
"checkpoint decision time is invalid"; and "run failure leaves a checkpoint
open". The reducer verifies digests and
provenance but never validates a value against the JSON Schema; the
materializer validates `default` and the executor validates operator values.

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

pi-subagent contract revision 7 exports a completed worktree attempt's handoff
as bounded `git format-patch` bytes with a digest-bearing `HandoffRef`
(`exportHandoff`, feature `handoffExport`). Workflow imports that export into
its own store, verifies identity, format, digest, and size, and records
`task-execution-handoff-imported` before it persists release intent; the
rules are in [Worktree tasks and handoffs](#worktree-tasks-and-handoffs).
Workflow never substitutes direct reads of subagent-private paths or branches.

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
`interrupted`, and `cleanup-blocked` but never `waiting`. Checkpoint tasks
use `pending`, `ready`, `waiting`, `completed`, `failed`, `cancelled`,
`blocked`, and `invalidated`; `waiting -> cancelled` exists since revision 18
and is admitted only for a checkpoint ("only a checkpoint task may be
cancelled while waiting"). A run leaves `running` or `waiting` for `failed`,
`interrupted`, or `cleanup-blocked` only after every non-terminal checkpoint
has been cancelled or, if already decided, committed ("run failure leaves a
checkpoint open").
`completed-degraded` requires every required task and required finalizer to
succeed while one or more optional tasks or advisory finalizers failed; all
degradations remain visible. Completion (`finalizing -> completed` or
`completed-degraded`) treats `completed`, `failed`, `cancelled`, `blocked`, and
`interrupted` tasks as settled, so an interrupted optional task or advisory
finalizer degrades completion rather than preventing it; `stopping ->
cancelled` likewise treats `interrupted` tasks as drained. The transitions `finalizing -> interrupted`
(a required finalizer's child was interrupted) and `cancelling -> interrupted`
(a task being stopped whose child settled `interrupted` and is retained
without release) exist since revision 16.

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
