---
name: workflow-authoring
description: Use when creating, modifying, validating, or debugging a pi-workflow *.workflow.ts definition, static or proposed as a dynamic workflow through workflow_propose; not for operating runs.
---

# Authoring pi-workflow definitions

This skill covers `@vegardx/pi-workflow` contract revision 18. Every rule
below is taken from the runtime source (`src/registry.ts`, `src/definition.ts`,
`src/materializer.ts`, `src/static-runtime.ts`, `src/contracts.ts`,
`src/support.ts`, `src/service.ts`, `src/dynamic/*`, and the pi-subagent
launch contracts). Quoted strings are the exact messages the runtime throws.
Worked examples that load through the real definition loader and through the
dynamic manifest VM are in [references/examples.md](references/examples.md).

Not available in revision 18: `ctx.artifact`, fork context, a Pi tool for
handoff export, a model-callable checkpoint decide tool (there is none by design: a model must
never decide a checkpoint; only a human decides, through `/workflow decide`),
and a model-callable dynamic-source approve, reject, or proposals tool (none
exists by design: only a human approves a proposal, through
`/workflow approve`). Do not author against them; a definition that calls
them fails when its source runs. `ctx.finalize` is available since revision
16 (see [Finalizers](#finalizers)); worktree agent tasks with `ctx.handoff`
are available since revision 17 (see
[Worktree tasks and handoffs](#worktree-tasks-and-handoffs)); human
checkpoints with `ctx.checkpoint` and dynamic workflows are available since
revision 18 (see [Checkpoints](#checkpoints) and
[Dynamic workflows](#dynamic-workflows)).

The same source is a static definition when it is saved as a `*.workflow.ts`
file in a discovery root, and a dynamic workflow when it is proposed as text
through `workflow_propose` and a human approves it with `/workflow approve
dynamic:<sha256>`. Everything in this skill applies to both; the two
dynamic-only source rules and the VM's determinism aids are under
[Dynamic workflows](#dynamic-workflows).

## Validate, run, inspect

1. Write or edit one `*.workflow.ts` file that default-exports
   `defineWorkflow({ meta, inputSchema, outputSchema, run })`.
2. `workflow_list` lists discovered definitions (`name`, `version`,
   `concurrency`, `budget`, `timeoutMs`, `scope`, `path`, `identitySha256`).
   A definition that fails to load fails the whole listing with a
   `WorkflowDefinitionLoadError` naming the file.
3. `workflow_validate { ref, input? }` resolves `ref` by definition name or
   absolute path ("Workflow not found: …", "Workflow reference is
   ambiguous: …"), or accepts `dynamic:<sha256>` for an approved dynamic
   proposal, and, when `input` is given, validates it against
   `inputSchema` ("Workflow input does not match its schema.") without
   creating a run.
4. `workflow_run { ref, input }` validates the same way, then returns
   `{ runId, status: "created" }` immediately. For a dynamic workflow, first
   `workflow_propose { source }` returns the proposal as `dynamic:<sha256>`
   with `runnable: false`; a human must approve it before `workflow_validate`
   or `workflow_run` accept the reference ("Dynamic workflow source is not approved for the current host API."). Never state or assume a proposal is
   approved (see [Dynamic workflows](#dynamic-workflows)).
5. `workflow_wait { runId, timeoutMs? }` drives the run to a terminal status
   and returns the run view; with `timeoutMs` (1_000..3_600_000) it returns
   the current view marked `timedOut: true` when the run outlives the timeout
   and the run keeps driving. A run parked at a checkpoint is not terminal:
   `workflow_wait` returns its `waiting` view immediately, marked
   `parked: true` and listing `pendingCheckpoints` (see
   [Checkpoints](#checkpoints)). `workflow_status { runId }` reads the durable
   projection at any time. The view carries `status`, `definitionName`,
   `createdAt`, `deadlineAt`, `depth`, `output` and `outputArtifactId` once
   committed, and `tasks[]` (one entry per declared task in materialization
   order with `id`, `namespace`, `key`, `kind`, `role` (`"task"` or
   `"finalizer"`), `disposition`, `status`, `generation`, the current
   `executionId`, `attempts` (agent tasks), `settlement`, `outcome`,
   `abandoned: true` for abandoned history, `handoff` (the handoff
   descriptor) on completed worktree tasks, and `checkpoint` (prompt, schema,
   policy, request and decision facts) on checkpoint tasks), plus
   `pendingCheckpoints[]`.
6. `workflow_runs { statuses?, includeChildren?, limit?, cursor? }` lists
   durable runs newest first with `taskCounts`, `ownership`,
   `availableActions`, and `requiresAttention`; `workflow_inspect { runId,
   include?, taskId? }` returns the run summary plus `budget`, `tasks` (with
   `dependsOn` and `inputs`), `executions`, `effects`, `barriers`, and
   `artifacts` sections; `workflow_logs { runId, afterSequence?, limit? }`
   pages redacted lifecycle entries (effects, status changes, attempts,
   terminal outcomes, invalidations) with `nextAfterSequence`. Reads never
   take a run lease.
7. `workflow_stop { runId, reason }` persists stop intent and drains;
   `workflow_reconcile { runId, taskId? }` re-opens a run after restart,
   interruption, or `cleanup-blocked`, reconciling every blocked task in order
   or only `taskId`; `workflow_invalidate { runId, taskId, reason }`
   re-executes a settled task and its dependents on a `failed` or
   `interrupted` run (see [Invalidation and
   re-execution](#invalidation-and-re-execution));
   `workflow_retry { runId, taskId, reason }` is the same restricted to a
   task whose current execution ended `failed` or `interrupted`, giving it
   a fresh child run as its next generation; `workflow_resume { runId,
   reason, taskId? }` re-attempts an `interrupted` agent task on its
   existing child run and attempt without invalidating anything. Use them
   only on a durably `failed` or `interrupted` root run, after
   `workflow_inspect` shows the action in `availableActions`. A run parked
   at a checkpoint is surfaced to the operator (the `/workflow` widget and
   inspector show its pending checkpoints); only a human decides it, through
   `/workflow decide <run> <task> <json> [reason…]`. There is no decide
   tool: a model must never decide a checkpoint.
8. Fix the definition and repeat. Definition identity covers the file's
   source, path, meta, and schemas; an existing run refuses a changed
   definition ("Workflow definition or input identity changed during
   replay."). Start a new run after editing.

The `/workflow list`, `/workflow show <run-prefix>`, and `/workflow runs`
subcommands are operator shortcuts for steps 2, 5, and 6; `/workflow` alone
(or `alt+w`) opens the inspector.

## Where definitions live and trust

Discovery visits these roots in order and loads every
`*.workflow.ts|mts|js|mjs` file, sorted by name, recursing at most 8 levels:

| Root | Scope | Requires |
| --- | --- | --- |
| `<cwd>/workflows` | `project` | Pi project trust |
| `<cwd>/.pi/workflows` | `project` | Pi project trust |
| `<agentDir>/workflows` | `global` | nothing extra |
| roots registered by the embedder | `package` or `builtin` | embedder registration |

Project definitions are trusted code. When either project root exists and the
project is not trusted, discovery throws `WorkflowDefinitionTrustError`
("project workflow definitions require project trust") before evaluating any
module. Bounds: at most 256 definitions and 4096 directory entries per
discovery, 1 MiB per file, regular files only ("workflow definition must be a
regular file"), valid UTF-8, and no symlinks anywhere under a root ("workflow
definition roots may not contain symlinks"). The same directory reachable
through two roots is rejected ("duplicate workflow root …"). Names must be
unique across all roots ("duplicate workflow name <name>: <path> and <path>").

## Imports

Static imports are limited to `@vegardx/pi-workflow`, `typebox`, and the
module specifiers of support tasks the embedder registered. Anything else
fails before evaluation: "workflow import <specifier> is not identity-bound by
contract revision 18". Relative imports of helper files are therefore
rejected. `import()`, `require()`, and `import x = require()` fail with
"dynamic workflow imports are not supported by contract revision 18",
"dynamic imports and CommonJS require are not supported by contract revision
18", and "TypeScript import assignment is not supported by contract revision
18". Import-like text inside strings and comments is fine. The loader
resolves imports from the definition file's location, so `@vegardx/pi-workflow`
and `typebox` must be resolvable there.

The module must default-export the definition; otherwise "workflow module has
no valid default definition". An exception during module evaluation surfaces
as "workflow definition module failed to load" with the cause attached.

A dynamic source passes the same gate with the same messages and two more
rules: it may not use `import.meta` ("dynamic workflow source may not use import.meta"), and it must have exactly one default export and no named
exports or re-exports ("dynamic workflow source must have exactly one default export and no named exports"). Support helpers are importable in a
dynamic source only when the embedder published them with an `exportName`
(`helper.registration(execute, { exportName })`); import them as
`import { <exportName> } from "<moduleSpecifier>"`.

Import types with `import type` or a `type` specifier: `import {
defineWorkflow, type WorkflowContext } from "@vegardx/pi-workflow"`. Names
such as `WorkflowContext`, `TaskHandle`, and `WorkflowDefinition` are
type-only exports. The static loader erases a plain `import { WorkflowContext }`
of them, but the dynamic VM transforms with `verbatimModuleSyntax` and keeps
it as a value import, so the same source fails at proposal time with
"Dynamic workflow source execution failed: Error: Dynamic workflow import
\"@vegardx/pi-workflow\" has no export \"WorkflowContext\"." (reported through
"Dynamic workflow manifest extraction failed: <reason>"). Write the type
imports the dynamic way in every definition so a static file can be proposed
unchanged.

## `defineWorkflow`

```ts
import { defineWorkflow } from "@vegardx/pi-workflow";
import { Type } from "typebox";

export default defineWorkflow({
	meta: {
		name: "example", // ^[a-z][a-z0-9-]*$, 1..128
		description: "One sentence", // 1..1024
		version: 1, // integer >= 1
		budget: {
			cost: 5, // dollars, >= 0
			totalTokens: 500_000, // optional integer >= 1; all model traffic
			childRuntimeMs: 1_800_000, // integer, 1_000 .. 365 days
		},
		timeoutMs: 3_600_000, // wall-clock deadline, 1_000 .. 365 days
		concurrency: 4, // optional integer 1..16, default 4
	},
	inputSchema: Type.Object({ question: Type.String() }, { additionalProperties: false }),
	outputSchema: Type.Object({ answer: Type.String() }, { additionalProperties: false }),
	run(ctx) {
		/* declare tasks, await barriers, return the output */
	},
});
```

- `meta` outside these bounds fails with "invalid workflow metadata".
- `inputSchema` and `outputSchema` must be JSON-serializable JSON Schema
  documents (nesting depth at most 16) that compile under Ajv strict mode:
  "workflow input schema must be a bounded JSON-serializable schema",
  "workflow input schema is not a valid JSON Schema" (same for `output`).
  TypeBox `Type.*` values are JSON Schema and give `ctx.input` and the return
  type their static types. Use `additionalProperties: false` on objects.
- `run` must be a function ("workflow run must be a function"). It may return
  a plain value, a `TaskHandle`, an `ArtifactHandle` from a task declared in
  this run ("Workflow returned an unknown artifact handle."), a worktree
  task's `handle.handoff` (the output schema must then accept a
  `WorkflowHandoffDescriptor`), or a promise of one. The final value is validated against `outputSchema` ("Workflow return
  value does not match its output schema.") and must be lossless JSON
  ("Workflow output is not losslessly JSON-serializable.").
- Effective limits: the service lowers `budget.cost` to its cap (default
  $1,000), and may lower `totalTokens`, `childRuntimeMs`, `timeoutMs`, and
  `concurrency`; it never raises a definition grant. The run deadline is
  `createdAt + effective timeoutMs` and is fixed at run creation.

## The `ctx` API

`WorkflowContext<TInput>` has exactly these members.

| Member | Behavior |
| --- | --- |
| `ctx.input` | Frozen deep JSON clone of the validated input. |
| `ctx.runId` | `workflow_<hex>`. |
| `ctx.cwd` | Absolute project directory; use it for `workspace.cwd`. |
| `ctx.signal` | Aborted on stop, shutdown, or deadline. |
| `ctx.phase(name)` | Durable progress effect; 1..128 characters ("Workflow phase must contain 1 to 128 characters."). |
| `ctx.log(message)` | Durable log effect; 1..4096 characters ("Workflow log must contain 1 to 4096 characters."). |
| `ctx.agent(key, request)` | Declares an agent task; returns `TaskHandle<Static<outputSchema>>`, or `WorktreeTaskHandle` (same plus `handle.handoff`) when the request's `workspace.mode` is `"worktree"`. |
| `ctx.support(key, descriptor)` | Declares a deterministic in-process support task from a `defineSupportTask` helper call. |
| `ctx.workflow<TOutput>(key, request)` | Declares a nested workflow task that runs another discovered definition as a linked child run. |
| `ctx.checkpoint(key, request)` | Declares a human decision the run parks on; returns `TaskHandle<Static<schema>>` whose value is the recorded decision. See [Checkpoints](#checkpoints). |
| `ctx.fanOut(namespace, items, { key, task })` | Declares at most 64 agent tasks in namespace `[namespace]`; returns handles in item order. "Workflow fan-out namespace is invalid.", "Workflow fan-out exceeds 64 items.", "Workflow fan-out options are invalid." |
| `ctx.fanIn(key, sources, { inputKey, task })` | Declares one agent task whose `inputs` are the 1..64 source outputs under the names `inputKey(source, index)` returns. `task` may not carry its own `inputs`. "Workflow fan-in requires 1 to 64 sources.", "Workflow fan-in options are invalid.", "Workflow fan-in input keys must be unique." |
| `ctx.pipeline(namespace, build)` | Runs a synchronous builder whose `stage.agent(key, request)` declares at most 64 agent tasks in namespace `[namespace]`; the builder must return one of them. "Workflow pipeline definition is invalid.", "Workflow pipeline exceeds 64 stages.", "Workflow pipeline must return one of its stage handles." |
| `ctx.finalize(key, { kind, support \| agent \| workflow })` | Declares a `role: "finalizer"` task that the runtime drives itself after the output commit; `kind` is `"required"` or `"advisory"`. Returns a handle other finalizers may depend on; never a barrier target. See [Finalizers](#finalizers). |
| `await ctx.result(handle)` | Barrier: persists all declarations so far, drives until the task completes, returns its frozen validated value. |
| `await ctx.results([a, b])` | Fail-fast barrier over several handles; returns a tuple in declaration order. |
| `await ctx.settled([a, b])` | Barrier that never throws for task failure; returns `{ status: "fulfilled", value }` or `{ status: "rejected", taskId, outcome, failure? }` per handle. |
| `await ctx.handoff(worktreeHandle)` | Barrier on a worktree task (same persisted barrier kind as `result`); resolves its `WorkflowHandoffDescriptor`, or `undefined` only when the task's `handoff` policy is `"optional"` and the completed child captured no changes. Rejects a finalizer handle ("a finalizer cannot be a barrier target"). |

Declaring a task never starts work. Only barriers and the final return
execute anything. Barriers run one at a time in call order. A `result` or
`results` barrier throws when a selected task ends in any non-completed
status: "Workflow task cannot produce a result: <status>." and "Workflow task
did not complete successfully: <status>.". A stopped or expired run throws
"Workflow run terminated before its result barrier: <status>.". Values are
re-read from the workflow-owned artifact and re-validated against the
producer's output schema before they are returned.

`settled` rejections carry `outcome` (`failed`, `interrupted`, `blocked`,
`cancelled`, `cleanup-blocked`, or `invalidated`) and, when evidence exists,
`failure` with `message` and optionally `code`, `origin`, `retry`, and
`guidance`. For workflow-stage failures `code` is the stage (for example
`preflight`); for a failed child workflow `code` is `nested-workflow` and
`message` is the child status.

## Keys, namespaces, and handles

- Task keys and input names are `TaskKey`s: `^[a-z][a-z0-9-]*$`, 1..128
  characters ("invalid task key"). CamelCase input names are rejected.
- A key is unique within its namespace ("duplicate task key in namespace").
  `fanOut` and `pipeline` create the one-level namespace `[namespace]`;
  everything else is declared in the root namespace.
- Task IDs are derived from run ID, namespace, and key, so the same key on the
  same path always names the same task.
- A run declares at most 256 tasks ("workflow task limit exceeded") and at
  most 64 nested workflow tasks ("nested workflow task bound exceeded").
- `handle.ref` is `{ runId, taskId }` (use it in `after`); `handle.output` is
  the artifact handle `{ runId, producerTaskId, output: "result" }` (use it in
  `inputs`). Handles are frozen, non-thenable, and typed by the producer's
  output schema.
- `handle.handoff` exists only on worktree agent tasks and is the handoff
  handle `{ runId, producerTaskId, output: "handoff" }`; it may be used in
  `inputs`, passed to `ctx.handoff`, or returned as the workflow value.

## `after` versus `inputs`

- `after: [handle.ref, …]` is an order dependency only. The task waits for
  those tasks but receives no data.
- `inputs: { name: handle.output, … }` is a data dependency. Each producer
  becomes an order dependency as well; order alone never grants data. At most
  64 inputs per task.
- `inputs: { name: worktreeHandle.handoff }` names a worktree task's handoff.
  The consumer receives the handoff descriptor (identity, digest, and size),
  never patch bytes. The producer must be a worktree agent task, otherwise
  "handoff input producer is not a worktree agent task".
- Both must name tasks that are already declared in this run: "task order
  dependency is unknown or belongs to another run", "task data dependency is
  invalid, unknown, or belongs to another run".
- Every task declared after a barrier receives an implicit order dependency on
  the tasks that barrier awaited.
- For agent tasks, each input value is verified from the workflow store and
  appended to the delegated `task.context` after the authored context as a
  canonical JSON envelope marked as untrusted data. Each context entry is at
  most 16 KiB, and the complete delegated context is at most 64 entries and
  512 KiB; larger projections fail the task before launch.
- `disposition` defaults to `"required"`; `replay` defaults to `"read-only"`
  (`"auto" | "off" | "read-only"`). Both are persisted in the task spec and
  participate in task identity.

## Barriers and replay

The source function is re-executed from its entry point on `workflow_wait`
after restart, on reconciliation, and after invalidation. Persisted
declarations and barriers are replayed against the new execution, so:

- Everything declared before a barrier must be deterministic: same keys, same
  requests, same order, same `phase`/`log` calls. Do not read the clock,
  random values, the environment, or the filesystem when building requests.
  Branch only on `ctx.input` and on values returned by barriers.
- A declaration that differs from the persisted one fails the run closed:
  "task declaration does not match the persisted ordered prefix". A barrier
  that differs: "barrier does not match the persisted ordered epoch"; a
  barrier that skips persisted declarations: "barrier omits declarations from
  the persisted epoch prefix"; a missing barrier: "materialization barrier
  removed from persisted prefix".
- Effects must replay exactly: "Workflow phase or log effect changed during
  replay.", "Workflow phase or log effect moved across a persisted barrier.",
  "Workflow omitted a persisted phase or log effect during replay.".
- Completed runs only replay: "completed workflow materialization may only
  replay its exact prefix", "completed workflow materialization may not
  append a barrier".
- No declarations after the final barrier (the return): "task declaration
  follows the final materialization barrier".
- After invalidation, tasks beyond the abandoned barrier may be declared
  differently, but a key that matches an abandoned task must carry the
  identical request: "abandoned task key re-declared with a changed request".

## Agent requests

`ctx.agent(key, request)` lowers to `AgentTaskRequestSchema`; an invalid
request fails with "invalid agent task request".

| Field | Rule |
| --- | --- |
| `agent` | Named agent resource, `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`, 1..128; must exist at preflight. |
| `task.goal` | 1..16 KiB string. |
| `task.context` | 0..64 strings, each at most 16 KiB. |
| `task.instructions` | 1..64 strings, each at most 16 KiB. |
| `contextMode` | `"fresh"` only. |
| `model` | Optional `{ provider, id, thinking }`; `thinking` is `off | minimal | low | medium | high | xhigh`. |
| `tools` | 0..64 unique resource names, brokered by pi-subagent. |
| `preloadSkills` | 0..64 unique skill names. |
| `contextScopes` | Unique subset of `"global"`, `"project"`. |
| `workspace` | `{ mode: "read-only", cwd }` or `{ mode: "worktree", cwd }`, `cwd` 1..4096 characters; use `ctx.cwd`. A worktree runs the child in an isolated pi-subagent worktree and produces a handoff. |
| `handoff` | Worktree tasks only: `"required"` (default when omitted) or `"optional"`. On a read-only request: "handoff policy requires a worktree workspace". Part of task identity; never sent to pi-subagent. |
| `outputSchema` | JSON Schema for the structured result; the child must satisfy it. |
| `limits.cumulativeRuntimeMs` | 1_000..3_600_000 across all attempts. |
| `limits.attemptTimeoutMs` | 1_000..3_600_000 per attempt. |
| `limits.totalTokens` | Optional 1..10_000_000; required for every task when the run has a token budget. |
| `limits.cost` | Dollars, >= 0. |
| `limits.outputBytes` | 1..16 MiB. |
| `limits.workspaceWriteBytes` | 0..16 GiB. Read-only tasks use 0; worktree tasks must declare at least 1 ("worktree workspace requires a positive workspaceWriteBytes limit"). |
| `limits.retries`, `limits.resumes` | 0..10 each. |
| `retry` | Optional `{ attempts: 1..10, on?: ["backoff" | "manual"] }`, `on` defaults to `["backoff"]`; `attempts` may not exceed `limits.retries` ("agent retry policy exceeds the declared retry limit"). |
| `resume` | Optional `{ attempts: 1..10 }`; may not exceed `limits.resumes` ("agent resume policy exceeds the declared resume limit"). |

`retry` applies to a `failed` child whose failure is classified `backoff` or
`manual` and listed in `on`; `resume` applies to an `interrupted` child
classified `resume`. Failures classified `never` or `reconcile` are not
retried. Every attempt runs on the same child run under the same task
execution, backoff is waited out under the run deadline and stop signal, and
settled usage across attempts counts against the budget.

## Worktree tasks and handoffs

A worktree agent task (`workspace: { mode: "worktree", cwd: ctx.cwd }`,
`limits.workspaceWriteBytes >= 1`) runs its child in an isolated pi-subagent
worktree. When the child completes, the runtime imports its structured output
and then its handoff: it calls pi-subagent's `exportHandoff`, verifies the
returned reference against the settled `{ attemptId, baselineHead,
handoffCommit }`, its `git-format-patch` format, digest, size (at most 16 MiB),
and single-commit shape, stores the bytes as a workflow-owned
`application/x-git-format-patch` artifact, and records the import before it
releases the child. The workflow never applies, pushes, merges, or checks out
a handoff, and it never reads a worktree path or branch; downstream tasks
cannot run on top of a handoff.

- `handoff: "required"` (the default): a completed child that captured no
  changes is released and then fails at stage `handoff-import` with
  "Completed worktree task captured no handoff."; `ctx.handoff` and
  `ctx.result` on it throw. `handoff: "optional"`: such a child completes and
  `ctx.handoff` resolves `undefined`.
- `await ctx.handoff(handle)` resolves the descriptor:
  `{ artifactId, runId, producerTaskId, producerExecutionId, subagentRunId,
  subagentAttemptId, baselineHead, handoffCommit, format: "git-format-patch",
  mediaType: "application/x-git-format-patch", sha256, bytes }`. It contains
  no paths or branch names. `handle.handoff` in a later task's `inputs`
  delivers the same descriptor in the child's context (the envelope marks
  `content: "descriptor"`), and returning `handle.handoff` commits the
  descriptor as the workflow output.
- Retries and resumes create a fresh worktree per attempt; only the final
  attempt's handoff is imported. Invalidation re-executes the task in a new
  worktree from a new baseline; the previous generation's handoff artifact
  stays in the run as history.
- Failure at stage `handoff-import` before release (export refused, identity,
  format, digest, or size mismatch, or a handoff above 16 MiB) leaves the task
  and run `cleanup-blocked` until `workflow_reconcile` retries the import; an
  oversize handoff stays exportable from pi-subagent by the operator.
- The embedder can read the bytes with
  `service.exportHandoff(runId, taskId)`; there is no Pi tool for it.

## Budgets and admission

- The declared `meta.budget` is the maximum for the run; the effective budget
  is the declared value lowered to the embedder's caps.
- Before each launch the scheduler requires
  `settled usage + active declared reservations + candidate declared maximum
  <= effective budget` for cost, cumulative child runtime, and, when a token
  budget exists, total tokens. A run with a token budget needs
  `limits.totalTokens` on every agent task; otherwise the task is not
  admissible. Inadmissible work waits while reservations are active and blocks
  when nothing can free budget.
- Provider cost can overshoot by one in-flight response; a post-settlement
  overage fails the run.
- Reaching `deadlineAt` runs the stop path: active work is drained and the run
  ends `cancelled` (or `cleanup-blocked` when cleanup cannot be proved).
- A nested child's declared budget must fit the parent's remaining budget and
  its deadline is capped at the parent's.

## Support tasks

A support task is deterministic host-process code identified by an explicit
digest; no model, subagent, VM, or worktree is involved.

```ts
import { defineSupportTask } from "@vegardx/pi-workflow";

const digest = defineSupportTask({
	name: "digest", // ^[a-zA-Z0-9@][a-zA-Z0-9@._/-]{0,255}$
	moduleSpecifier: "@example/workflow-support", // same pattern
	revision: 1, // integer >= 1
	implementationSha256: "<64 hex>", // published by the implementation
	parametersSchema: ParametersSchema,
	outputSchema: OutputSchema,
});

const hashed = ctx.support("hash", digest({ parameters: { algorithm: "sha256" }, inputs: { doc: draft.output } }));
```

- The helper validates `parameters` when it is called ("support task
  parameters do not match their schema") and returns a frozen descriptor that
  also accepts `after`, `inputs`, `disposition`, and `replay`. `inputs` may
  name result handles (`handle.output`) and worktree handoff handles
  (`handle.handoff`); a handoff input gives `execute` the handoff descriptor,
  not patch bytes. Invalid identity fields fail with "invalid support task
  implementation identity".
- The workflow only declares the task. The embedder must register the
  matching implementation with `createWorkflowService({ supportTasks:
  [digest.registration(execute)] })`; the runtime resolves the persisted
  descriptor against that registry by exact identity (name, module specifier,
  revision, digest, and both schemas). An unregistered or drifted
  implementation fails the task at stage `support-resolution`.
- `execute({ parameters, inputs, signal })` receives the verified input values
  under their input names and must return JSON that matches `outputSchema`;
  failures are reported at stages `support-input`, `support-execution`, and
  `support-output` with fixed messages. The output is committed as a
  workflow-owned artifact and can feed later tasks like any other result.

## Nested workflows

`ctx.workflow<TOutput>(key, { workflow, input, inputs?, disposition?, after?,
replay? })` runs another discovered definition as a linked child run.

- `workflow` is the child's `meta.name` ("Nested workflow name is invalid.",
  "Nested workflow definition is not discovered."); the child comes from the
  same discovery pass and trust gate as the parent.
- Depth: a top-level run has depth 0 and children may nest to depth 3
  ("Nested workflow depth bound exceeded."). A child that is the parent or any
  ancestor definition is refused ("Nested workflow recursion is not
  allowed.").
- Merged-input rule: with no `inputs`, `input` is validated against the
  child's `inputSchema` at declaration ("Nested workflow input does not match
  its schema."). With `inputs`, `input` must be a JSON object ("Nested
  workflow artifact inputs require an object input.") with no key equal to an
  input name ("Nested workflow input name collides with the authored
  input."); at launch the verified artifact values are merged in as top-level
  keys and the merged object is validated against the child schema and a 900
  KiB bound, failing the task at stage `nested-input` when it does not fit.
  Design the child's `inputSchema` to include the input names.
- The child's identity, source digest, schemas, budget, timeout, and
  concurrency are captured at declaration. The child's output is imported as a
  parent-owned artifact, so the handle's `output` can feed later parent tasks.
- Child terminal statuses map onto the task: `completed` and
  `completed-degraded` complete it; `failed`, `cancelled`, `interrupted`, and
  `cleanup-blocked` become the same-named task outcome. A nested child run is
  addressable by its own run ID with `workflow_status`; its view carries
  `depth` and `parent: { runId, taskId, inputArtifacts }`.

## Finalizers

`ctx.finalize(key, { kind, support | agent | workflow })` declares a finalizer:
a task with `role: "finalizer"` that the runtime drives itself after the
ordinary graph has settled and the output has been committed, while the run is
`finalizing`. Use it for cleanup, recording, or notification work that must
not influence the output.

- `kind` is `"required"` or `"advisory"` ("invalid finalizer kind").
  `required` lowers to `disposition: "required"`; `advisory` lowers to
  `disposition: "optional"`.
- Exactly one of `support` (a `defineSupportTask` descriptor), `agent` (an
  agent request), or `workflow` (a nested workflow request) names the work
  ("finalizer requires exactly one of support, agent, or workflow"). A request
  that is not an object fails with "Workflow finalizer request is invalid.".
- The inner request may not carry its own `disposition`, even `undefined`
  ("finalizer disposition is its kind"). `after`, `inputs`, and `replay` are
  allowed and follow the ordinary rules.
- A finalizer may depend on ordinary tasks and on other finalizers. An
  ordinary task may not depend on a finalizer through `after` or `inputs`
  ("ordinary task may not depend on a finalizer").
- Finalizers are never barrier targets: do not pass the handle to
  `ctx.result`, `ctx.results`, or `ctx.settled`, and do not return it
  ("a finalizer cannot be a barrier target"). Declare them, then return the
  ordinary output handle or value.
- Finalizers run only while the run is `finalizing`, after `run-output-committed`;
  the output can never be changed by them. They share the run's concurrency
  lanes and budget, are validated, persisted, and replayed exactly like other
  declarations, and appear in the run view with `role: "finalizer"`.
- A required finalizer that ends `failed` or `interrupted` fails the run
  (`finalizing -> failed` or `finalizing -> interrupted`); one left `blocked`
  by a failed dependency fails it with
  "Required finalizer did not complete: blocked.". An advisory finalizer that
  fails or is blocked ends the run `completed-degraded`. Interrupted optional
  work, whether an optional task or an advisory finalizer, degrades completion
  instead of preventing it.
- After the output commit, `workflow_invalidate` (`service.invalidate`) may
  target only finalizers
  ("invalidation after output commit may only cover finalizers"); the
  finalizer re-executes as its next generation against the existing output.

## Checkpoints

Use a checkpoint when a human must decide before the run may continue: to
approve a plan before a worktree writer runs, to accept or reject a handoff,
or to pick between options the workflow cannot choose on its own. Do not use
one for choices a schema-validated agent result or a support task can make; a
checkpoint stops the run until a person answers.

```ts
const approve = ctx.checkpoint("approve", {
	schema: Type.Object({ proceed: Type.Boolean() }, { additionalProperties: false }),
	prompt: "Approve the plan before the writer runs?", // 1..4096 characters
	headless: "block", // or "use-explicit-default" with a `default`
	timeoutMs: 3_600_000, // optional, 1_000 .. 365 days, capped by the run deadline
	inputs: { plan: plan.output }, // what the approver is shown
});
const decision = await ctx.result(approve); // parks here until decided
```

The exact request shape is
`ctx.checkpoint(key, { schema, prompt, default?, headless, timeoutMs?, disposition?, after?, inputs?, replay? })`:

- `schema` is the JSON Schema of the decision value (the same rules as an
  agent `outputSchema`; the message names it "checkpoint decision schema").
  The handle is typed `TaskHandle<Static<typeof schema>>`; `ctx.result`
  returns the recorded decision re-read from its artifact and validated
  against `schema`.
- `prompt` is what the approver reads: 1..4096 characters ("invalid checkpoint prompt").
- `headless` is required: `"block"` waits for a human until `timeoutMs` or
  the run deadline; `"use-explicit-default"` requires `default` ("checkpoint headless default requires an explicit default") and uses it when the
  checkpoint expires or when the embedder runs the service with
  `checkpoints: { headless: true }` (then it never waits). Anything else:
  "invalid checkpoint headless policy".
- `default`, when given, must be lossless JSON ("checkpoint default is not JSON") and satisfy `schema` ("checkpoint default does not match its schema"). It is part of task identity.
- `timeoutMs` is relative to the moment the request is persisted; the
  absolute `expiresAt` is `min(now + timeoutMs, deadlineAt)`. Out of bounds:
  "invalid checkpoint timeout". Without it, only the run deadline bounds the
  wait. An expired `"block"` checkpoint fails at stage `checkpoint-expired`
  with "Checkpoint expired without a decision." (`settled` reports
  `code: "checkpoint-expired"`); an expired `"use-explicit-default"`
  checkpoint completes with its default.
- `after`, `inputs`, `disposition`, and `replay` follow the ordinary rules.
  `inputs` may name result handles and worktree handoff handles; the approver
  sees the verified values (a handoff as its descriptor, never patch bytes).
  Use `after: [approve.ref]` on the task the decision gates.
- A checkpoint handle is a legal target of `ctx.result`, `ctx.results`,
  `ctx.settled`, and the return value. It never has `handle.handoff`.
- A checkpoint cannot be a finalizer: `ctx.finalize` has no `checkpoint`
  member ("finalizer requires exactly one of support, agent, or workflow"),
  and the materializer refuses the role ("a checkpoint cannot be a finalizer"). Finalizers may depend on checkpoints.
- A request that is not an object fails with "Workflow checkpoint request is invalid."; a lowered request or task that fails its schema fails with
  "invalid checkpoint task request" or "invalid materialized checkpoint task".

Examples of `headless` policies:

```ts
// Must be answered by a person; the run fails if nobody answers within an hour.
ctx.checkpoint("release-gate", {
	schema: Type.Object({ proceed: Type.Boolean() }, { additionalProperties: false }),
	prompt: "Publish the digest?",
	headless: "block",
	timeoutMs: 3_600_000,
});

// Asks a person when one is around; unattended runs and expiry take the default.
ctx.checkpoint("tone", {
	schema: Type.Union([Type.Literal("formal"), Type.Literal("casual")]),
	prompt: "Which tone should the summary use?",
	headless: "use-explicit-default",
	default: "formal",
	timeoutMs: 600_000,
});
```

How a checkpoint runs, for authors:

- Declaring it starts nothing. At the barrier that selects it, the runtime
  persists the request with the exact input digests and moves the task
  `ready -> waiting` ("Checkpoint awaits a decision."). It holds no
  concurrency lane and no budget. When no lane has anything else to do the
  run becomes `waiting` ("Workflow run awaits a checkpoint decision.") and
  the drive parks: `workflow_wait` returns immediately with `parked: true`
  and `pendingCheckpoints`. Do not poll; wait returns immediately when
  parked, and nothing changes until a person decides, the checkpoint expires,
  the run is stopped, or the deadline passes.
- Only a human decides. The operator sees the parked run in the `/workflow`
  widget and inspector and answers through `/workflow decide <run> <task>
  <json> [reason…]` (a follow-up in the `/workflow` command), whose approver
  is the Pi session user; embedders call `service.decide(runId, taskId,
  { decision, approver, reason? })`. There is no model-callable decide tool by
  design: a model must never decide a checkpoint, not even its own work.
  Surface the parked run and stop. The decision is
  validated against `schema`, recorded once and immutably, stored as the
  task's result artifact, and the run continues ("Checkpoint decided.").
  A second decision for the same checkpoint is refused ("Checkpoint is already decided."), as is one that arrives after expiry ("Checkpoint has expired.") or fails the schema ("Checkpoint decision does not match its schema.").
- After `workflow_stop`, the deadline, or a failure elsewhere in the run, an
  open checkpoint ends `cancelled` ("Workflow run ended before the checkpoint was decided." when the run fails); a `result` barrier on it then throws
  like any other non-completed task. A required checkpoint that fails or is
  cancelled fails the run; make it `disposition: "optional"` and read it with
  `ctx.settled` when the run should continue without an answer.
- Replay: a decided checkpoint replays from its artifact and the person is
  never asked twice for the same execution. Invalidation that covers the
  checkpoint creates a new generation and asks again.
- Checkpoint tasks use the statuses `pending`, `ready`, `waiting`,
  `completed`, `failed`, `cancelled`, `blocked`, and `invalidated`.

## Failure semantics for authors

- Required task (the default) that ends `failed`, `cancelled`, `interrupted`,
  `blocked`, `cleanup-blocked`, or `invalidated` fails the run: "Required
  workflow task did not complete: <status>." A `result`/`results` barrier on
  it throws first.
- Optional task (`disposition: "optional"`) failure never fails the run. Read
  it through `ctx.settled`. When every required task completed and at least one
  optional task or advisory finalizer did not, the run ends
  `completed-degraded` instead of `completed`.
- Dependents of a failed task become `blocked`.
- An exception thrown by `run` (including a rejected barrier) ends the run
  `failed` with reason "Static workflow source execution failed."; in a
  dynamic workflow the reason is "Dynamic workflow source execution failed:
  <name>: <message>" (the only journal difference between the frontends),
  and a VM bound ends it with the exact VM reason (for example "Dynamic workflow VM exceeded its memory limit."). An output that fails validation
  ends it `failed` with "Workflow output finalization failed.".
- `cleanup-blocked` means a child's cleanup, release, output import, or
  handoff import could not be proved; the run waits for `workflow_reconcile`,
  which retries the import or reconciles the child.
- A worktree task can also end `failed` at stage `handoff-import` after a
  successful child: under `handoff: "required"` a child that captured no
  changes is released and then fails with "Completed worktree task captured no
  handoff." (`settled` reports `code: "handoff-import"`). Use
  `handoff: "optional"` when an unchanged worktree is an acceptable outcome.
- `interrupted` means the run lost its lease or an agent child was interrupted
  without an admissible resume attempt. Such a child is retained in
  pi-subagent without release; the task ends `interrupted` with the reason
  "Interrupted child retained for recovery; no release performed." and the run
  never resumes it on its own. Recover a lost lease with `workflow_reconcile`;
  recover an interrupted task with `workflow_resume { runId, reason, taskId? }`,
  which re-attempts it on its existing child run when the failure is
  classified `resume` (`taskId` is required when several tasks are
  resumable), or with `workflow_retry { runId, taskId, reason }`, which
  re-executes it and its dependents as a new generation with a fresh child
  run. `workflow_invalidate` does the same for any settled task.
- `cancelled` is the result of `workflow_stop`, session shutdown, or the
  deadline. Trusted source awaiting `ctx.signal` should unwind when it aborts.
  A checkpoint open at that moment ends `cancelled` too; session shutdown
  alone leaves a parked run `waiting` and resumable by a later `workflow_wait`.
- `waiting` with `parked: true` on `workflow_wait` means a checkpoint awaits
  a human; the run is not stuck and must not be polled (see
  [Checkpoints](#checkpoints)).
- Run statuses: `created`, `running`, `waiting`, `finalizing`, `stopping`,
  `completed`, `completed-degraded`, `failed`, `cancelled`, `interrupted`,
  `cleanup-blocked`. Task statuses: `pending`, `ready`, `running`, `waiting`,
  `completed`, `failed`, `interrupted`, `blocked`, `cancelling`, `cancelled`,
  `cleanup-blocked`, `invalidated`.

## Dynamic workflows

A dynamic workflow is the same `defineWorkflow` source proposed as text and
executed in a worker-thread VM after a human approved it. Author it exactly
like a static definition, then:

1. `workflow_propose { source }` (1..262144 UTF-8 bytes) applies the import
   gate and the two dynamic-only rules, extracts the manifest (`meta`,
   `inputSchema`, `outputSchema`) in a manifest-only VM, and returns the
   proposal: `{ ref: "dynamic:<sha256>", sourceSha256, sourceBytes, manifest,
   manifestSha256, hostApiSha256, importPolicySha256,
   definitionIdentitySha256, transformer, proposer, proposedAt, decision?,
   runnable, path }`. `ref` is the SHA-256 of the exact source bytes; the
   same bytes always yield the same proposal, and a changed byte is a new
   proposal. Refusals: "Dynamic workflows require project trust.", "Dynamic
   workflow source is empty.", "Dynamic workflow source exceeds 262144 bytes.", "Dynamic workflow source is not valid UTF-8.", the import gate
   messages, "dynamic workflow source may not use import.meta", "dynamic workflow source must have exactly one default export and no named exports", "Dynamic workflow manifest extraction failed: <reason>", and
   "Dynamic workflow proposal store is full.".
2. Stop and surface the `ref`. Approval is a human decision: a person reads
   the source and approves or rejects it with `/workflow approve
   dynamic:<sha256>` or `/workflow reject dynamic:<sha256> [reason…]` (an
   explicit confirmation in an interactive Pi session; these commands are a
   follow-up in the `/workflow` command, and until then the embedder calls
   `service.decideSource`). There is no approve, reject, or proposals tool,
   by design; never state or assume a proposal is approved. A rejection is
   final ("Dynamic workflow source was rejected."): fix the source and
   propose again, which yields a new digest. A second decision is refused
   ("Dynamic workflow source is already approved.").
3. Once `runnable` is true, `workflow_validate` and `workflow_run` accept the
   `ref`; before that they refuse "Dynamic workflow source is not approved for the current host API.". A package upgrade (a changed `hostApiSha256`) or a
   change to the embedder's published support helpers (a changed
   `importPolicySha256`) invalidates the approval: "Dynamic workflow proposal predates the current host API; propose the source again." and "Dynamic workflow import policy changed since approval.". Propose again and ask for
   a new approval.

How the source runs:

- `ctx` is exactly the `WorkflowContext` described above, with the same
  messages. Declarations are synchronous calls to the host; `ctx.result`,
  `ctx.results`, `ctx.settled`, and `ctx.handoff` are the only awaits. A
  request that contains a function is refused before it is sent ("Workflow request contains a function.").
- The VM boots fresh on every drive: after `workflow_wait` following a
  restart, after a checkpoint decision, and after invalidation the source is
  transformed and re-executed from entry in a new worker, and the persisted
  prefix must replay exactly as for static source. Keep everything before a
  barrier deterministic.
- Determinism aids, not security: `Date.now()` and `new Date()` return the
  run's creation time, `Math.random()` is a fixed sequence per run id,
  `console.*` are no-ops, `eval`/`new Function` throw `EvalError`,
  `import()` rejects, and there is no `process`, `require`, `fetch`,
  `setTimeout`, `structuredClone`, or `TextEncoder`; assigning a new global
  throws "Cannot add property <name>, object is not extensible". The
  worker-thread VM is a determinism and API boundary, not an OS security boundary, and dynamic source is admitted only because a human approved it
  under Pi project trust.
- Bounds: full TypeScript through `amaro` 1.2.0 (enums, namespaces,
  parameter properties, and `satisfies` work; `module Foo {}` is refused),
  256 MiB heap, 30 s of compute between host messages (barriers pause the
  clock), 65536 messages and 17 MiB per message per drive, and a 10 s boot.
  A bound ends the run `failed` with its exact reason, for example "Dynamic workflow VM exceeded 30000 ms of compute between host messages." or
  "Dynamic workflow VM exceeded its memory limit.".
- `defineSupportTask` works for describing a support task, but
  `helper.registration()` throws ("Dynamic workflow source may not register support implementations."); implementations always come from the embedder.
- A dynamic run is always a root run. It may declare nested static children
  with `ctx.workflow`; a dynamic definition can never be a nested child.
- `workflow_list` does not list proposals; a run view of a dynamic run
  carries `dynamic: { ref, sourceSha256, approvalSha256, hostApiSha256 }`.

## Invalidation and re-execution

`workflow_invalidate { runId, taskId, reason }` (the pass-through for
`service.invalidate(runId, causeTaskId, reason)`) applies to a run that is
durably `failed` or `interrupted`; `availableActions` in `workflow_runs` and
`workflow_inspect` lists `invalidate` when it is admissible. `workflow_retry`
is the same operation restricted to a cause task whose current execution
ended `failed` or `interrupted` (listed as `retry`). The cause task and its
transitive dependents become `invalidated`, the epochs after the barrier that
exposed them are abandoned, and the run is driven again:

- The source re-executes from the top. The on-path prefix must replay exactly
  (see Barriers and replay).
- Invalidated tasks are re-materialized and executed as a new generation with
  fresh preflight, operation ID, and child run. A task has at most 16
  generations.
- Declarations after the abandoned barrier may differ from history. A key that
  matches an abandoned task must repeat the identical request; new keys are
  fine. Abandoned declarations are never scheduled and stay visible in the
  run view with `abandoned: true`.
- Every generation's settled usage counts against the same budget.

For authors this means: keep declarations deterministic, keep result-dependent
branches after the barrier that produces the data they need, and expect a
task's `generation` in `workflow_status` to grow only through invalidation.
