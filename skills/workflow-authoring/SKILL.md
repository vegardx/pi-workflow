---
name: workflow-authoring
description: Use when creating, modifying, validating, or debugging a pi-workflow *.workflow.ts definition, static or proposed as a dynamic workflow through workflow_propose; not for operating runs.
---

# Authoring pi-workflow definitions

This skill covers `@vegardx/pi-workflow` 2.0.0, contract revision 20. Every
rule below is taken from the runtime source (`src/registry.ts`, `src/definition.ts`,
`src/materializer.ts`, `src/static-runtime.ts`, `src/contracts.ts`,
`src/support.ts`, `src/service.ts`, `src/dynamic/*`, and the pi-subagent
launch contracts). Quoted strings are the exact messages the runtime throws.
Worked examples that load through the real definition loader and through the
dynamic manifest VM are in [references/examples.md](references/examples.md).

Not available in revision 20: `ctx.artifact`, fork context, a Pi tool for
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
revision 20 (see [Checkpoints](#checkpoints) and
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
   `pendingCheckpoints[]`, whose entries carry `taskKey`, the checkpoint
   `prompt`, the answer shape (`schemaSummary`), the declared inputs
   (`inputsSummary`, artifact-backed views only), and `instruction`: show the
   person the question and stop.
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
   at a checkpoint is surfaced to the operator (Pi prompts the session user
   itself; the `/workflow` widget shows `waiting for you: <prompt>` and the
   inspector offers the decide entry); only a human decides it, through
   `/workflow decide <run> <task> [json] [reason…]` or the prompt. There is no
   decide tool: a model must never decide a checkpoint.
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
| `<pi-workflow>/workflows` (shipped in the package) | `builtin` | nothing extra |
| roots registered by the embedder | `package` or `builtin` | embedder registration |

The pi-workflow extension registers the package's own `workflows/`
directory as a `builtin` root, so the definitions the package ships are
listed and runnable in any project without project trust: they are
trusted package code, installed with the package, and their imports
resolve from inside the installed package. Do not add a definition there
for one project; use a project root for that.

The shipped builtin that writes is `plan-to-ship`, and it is a **compiler**:
`refine` (read-only agent) -> `approve-plan` (checkpoint, `headless: "block"`)
-> each deliverable's derived stages, in plan order -> `ship` (checkpoint) -> a
required `receipt` finalizer. A plan authors no stages: the compiler derives
them from the deliverable's `reviews` list and the plan's `policy`, and each
lowers onto the component library — `implement` to one worktree agent
(`implement-<deliverable>`, `handoff: "required"`), `verify-and-fix` to
`verifyAndFix`'s bounded `-verify-<n>`/`-fix-<n>` rounds, `review-fan-out` to
`reviewFanOut` (omitted when `reviews` is empty), and every gate to `gate`.
`policy.gates` decides which gates exist and nothing else does. It takes a pi-maestro plan by value with its
sha256 digest and an effort dial, and returns a receipt naming each durable
handoff ref plus the approved digest; it never pushes, merges, or applies
anything. Read it as the worked example of compiling a document into a graph:
checkpoints, worktree handoffs, a bounded loop, fan-out and finalizers in one
definition, with `compileStageDocument` and `compileStages` showing the whole
graph as data — the plan's view and the runtime's — before a task is declared.
It names the
agents `planner`, `implementer`, and `reviewer`, which the package ships under
`workflows/agents/*.md`: a run composed from a root that has an `agents/`
directory carries it to pi-subagent as the request's `agentRoots`, so those
definitions resolve in any project. A host's `<agentDir>/agents` or a trusted
project's `.pi/agents` still wins for a name it defines, and a name no source
defines fails the task at pi-subagent preflight.

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
contract revision 20". Relative imports of helper files are therefore
rejected. `import()`, `require()`, and `import x = require()` fail with
"dynamic workflow imports are not supported by contract revision 20",
"dynamic imports and CommonJS require are not supported by contract revision
18", and "TypeScript import assignment is not supported by contract revision
18". Import-like text inside strings and comments is fine. The
`@vegardx/pi-workflow/runtime` subpath is not importable from a definition and
is not part of the authoring API; definitions import from
`@vegardx/pi-workflow` only, and the gate refuses the subpath with
"workflow import @vegardx/pi-workflow/runtime is not identity-bound by contract revision 20".
The loader resolves imports from the definition file's location, so
`@vegardx/pi-workflow` and `typebox` must be resolvable there.

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
| `modelRole` | Optional `{ persona, tier?, effort?, family? }` — ask the host's router instead of naming a model. Mutually exclusive with `model` ("agent task declares both model and modelRole; they are mutually exclusive"). `tier` is `light \| standard \| heavy`, `effort` the thinking ladder plus `max` (mapped to `xhigh`), `family` is `same \| other`. Resolved to an exact `{ provider, id, thinking }` BEFORE hashing, so a role that resolves to the model a hand-written task named has the identical task identity; the resolution is persisted with the task and re-used on every replay. With no router installed: "No model routing is installed; declare an exact model." |
| `tools` | 0..64 unique resource names, brokered by pi-subagent. |
| `preloadSkills` | 0..64 unique skill names. |
| `contextScopes` | Unique subset of `"global"`, `"project"`. |
| `workspace` | `{ mode: "read-only", cwd }` or `{ mode: "worktree", cwd }`, `cwd` 1..4096 characters; use `ctx.cwd`. A worktree runs the child in an isolated pi-subagent worktree and produces a handoff. |
| `memoryBytes` | Optional guest VM memory grant: a positive multiple of 64 MiB, at most 4 GiB. Omitted takes the agent definition's own ceiling; a value above that ceiling is refused at preflight ("memory request exceeds agent ceiling"). A malformed value fails with "agent memoryBytes must be a positive multiple of 64 MiB and at most 4 GiB". Part of task identity; lowered unchanged to pi-subagent. |
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
retried, `workspace-budget` among them: an exhausted `limits.workspaceWriteBytes`
is a declared bound, not a transient error, so raise the bound or shrink the
change instead of retrying. Every attempt runs on the same child run under the same task
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

Write it so a person can answer it without leaving the session; Pi shows the
prompt, the declared inputs, and the answer shape in one dialog and asks the
decision field by field:

- **The prompt is a question**, in full words, that the declared `inputs`
  alone are enough to answer ("Approve this plan before the writer runs?",
  "Which tone should the summary use?"). Not a label ("approval"), not an
  instruction to go read something else. It is the only text the approver is
  guaranteed to see.
- **Declare `inputs` for every artifact the decider must read**: the draft,
  the diff summary, the handoff descriptor. The approver sees the verified
  values, so an input is how the material reaches them; without it the
  question is unanswerable in the dialog.
- **Keep the decision schema small and flat**: a boolean, an enum of short
  literals, a string, a bounded number, or an object of at most eight such
  properties. Those are asked one dialog per field; arrays, nested objects,
  and unions of objects fall back to a single JSON editor, which asks the
  person to hand-write JSON.
- **Name the options the way the person thinks about them.** An enum of
  `"ship" | "hold"` reads better in the dialog than `0 | 1`, and required
  properties are asked before optional ones.

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
- Only a human decides. In a session with UI, Pi asks the person as soon as
  the run parks: one guided form showing the prompt, the declared inputs, and
  the answer shape, then a dialog per decision field and a final confirm.
  Dismissing it records nothing and leaves the run parked; the `/workflow`
  widget (`waiting for you: <prompt>`), the inspector's decide entry, and
  `/workflow decide <run> <task> [json] [reason…]` (an explicit confirmation
  in an interactive Pi session) keep offering it. The approver is always the
  Pi session identity; embedders call `service.decide(runId, taskId,
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

The package's `workflows/deep-review.workflow.ts` is the shipped worked example
of those last two rules together. It declares one optional read-only reviewer
per lens over one subject, closes them with `ctx.settled`, computes the verdict
and the de-duplicated findings from the lenses that reported, and reports a
`coverage` row per lens so a review that lost one reads as three of four rather
than as a complete one. Its reducer is optional and read through `ctx.settled`
as well, because a barrier's control edge covers **every** task the barrier
closed over: anything declared after `ctx.settled` is `blocked` when any of
those tasks failed, however carefully its `inputs` avoid the dead one. Declare
such a follow-on task optional and a lost lens degrades the run
(`completed-degraded`) instead of failing it.

## Patterns

Five shapes — a gate, an effort envelope, a fan-out, a review fan-out, a
bounded loop — cover nearly every definition in this package, and a sixth
entry below is the vocabulary a review reports in. Each is first a rule about
keys, barriers, and budgets, and only then a function.
`@vegardx/pi-workflow/components` ships the executable form, and after
materialization a component is indistinguishable from the hand-written
declarations beside it: same namespace, same keys, same requests, same order,
no contract revision, no frozen-shape change, nothing in the runtime.
**The pattern is the artifact; the component is its tested shortcut.** A
component that cannot express your graph is never a reason to bend the graph
— hand-write the pattern and keep the laws.

```ts
import {
	DIVERSE_MODEL_ID, envelope, forEach, gate, gateTimeoutMs,
	mergeReviewReports, MODEL_PROVIDER, reviewFanOut, verifyAndFix,
	workflowBudgetFor,
} from "@vegardx/pi-workflow/components";
```

The entry point imports no UI, no service, and no filesystem, so it is safe
to load from a definition module and legal under the dynamic import policy
([Imports](#imports)).

### The three replay laws

Every pattern obeys these, because the source re-executes from its entry
point on every drive ([Barriers and replay](#barriers-and-replay)).

| # | Law | Why | Checkable? |
| --- | --- | --- | --- |
| 1 | A key is a pure function of (namespace, declaration ordinal, a caller-supplied stable id). Never a clock, a random value, a counter over runtime data, a hash of prose, or an index into data that post-dates a barrier. | Task identity is derived from run id, namespace, and key. A key that moves re-declares a task the journal already holds: "task declaration does not match the persisted ordered prefix". | Half. `forEach` calls `idOf` twice per item and refuses a second, different answer; that the id reads a **required** input field is stated law, not a check. |
| 2 | Data a pattern fans out over originates in `ctx.input` or in a value a barrier has already returned. | An array built from anything else is a different array next drive, and the fan-out declares different keys. | No. A component receives an array, not its provenance. Exact-prefix replay is what catches it, loudly, at resume. |
| 3 | Effort, model, limits, and budget shares are table lookups keyed by `ctx.input` and, inside a bounded loop, the round ordinal. | Everything declared before a barrier must be deterministic, and a model or limit chosen from a measurement changes the request on replay. | By construction. `envelope(effort, stage)` takes no `ctx` and can read nothing else. |

A component refuses at **declaration** time, throwing `WorkflowComponentError`
while the source builds its requests — before the materializer sees anything,
so a misuse never becomes a persisted task and never reaches a replay. The
runtime's own refusals keep their own type and messages; a component's
messages name a library rule the runtime cannot check, such as "a gate the
session cannot ask field by field". Every component that admits a `budget`
takes the run's declared `meta.budget`, projects the worst case it would
reserve, and refuses up front rather than letting the scheduler block that
work mid-run ([Budgets and admission](#budgets-and-admission)).

### A gate: one human decision

| | |
| --- | --- |
| Intent | Park the run for exactly one human decision, and carry the answer forward. |
| Lowers to | one `ctx.checkpoint(key, …)`, then `await ctx.result(handle)`. |
| Keying | the caller's literal `key`; nothing is derived. A gate inside a `fanOut` or `pipeline` namespace is namespaced by the materializer exactly as a hand-written checkpoint is. |
| Replay laws | Law 3: pick `timeoutMs` from a table (`gateTimeoutMs(effort)`), never from a clock. The prompt and schema are declared before the barrier, so build them from `ctx.input` or an earlier barrier's value. |
| Refuses | a `key` that is not `^[a-z][a-z0-9-]*$`, 1..128; a `prompt` that is not a question ending in `?`; a `schema` that is not an object, or is not flat enough for the session to ask field by field (nested, empty, or over `MAX_CHECKPOINT_FLAT_PROPERTIES` = 8 leaves), so no gate silently degrades to a raw JSON editor; an input that is a task handle rather than `handle.output` or `handle.handoff`; `headless: "use-explicit-default"` with no `default`. |
| Budget | none. A checkpoint reserves nothing against `meta.budget`; it spends the run's `timeoutMs` instead. |
| Hand-write when | the answer shape is genuinely deep and the JSON editor is the intended surface, or the prompt is not a question. |

```ts
// Hand-written
const approve = ctx.checkpoint("approve-plan", {
	schema: DecisionSchema,
	prompt: "Approve this plan before the writer runs?",
	headless: "block",
	timeoutMs: 86_400_000,
	inputs: { plan: refine.output },
});
const decision = await ctx.result(approve);

// With the component
const approve = gate(ctx, "approve-plan", {
	prompt: "Approve this plan before the writer runs?",
	schema: DecisionSchema,
	inputs: { plan: refine.output },
	timeoutMs: gateTimeoutMs(ctx.input.effort),
});
const decision = await ctx.result(approve);
```

### An envelope: effort as one table

| | |
| --- | --- |
| Intent | One dial on the workflow input decides every model, thinking level, limit, and reservation in the graph. |
| Lowers to | nothing on its own. `envelope(effort, stage).model` and `.limits` go on an agent request verbatim; `.budgetShare` is that task's reservation, and `workflowBudgetFor(shares)` is the `meta.budget` the graph needs. |
| Keying | not a keyed declaration. The table is keyed by `(effort, stage)` — `cheap \| standard \| deep` against `refine`, `implement`, `verify`, `fix`, `review`, `synthesis`, `record`. |
| Replay laws | Law 3, in pure form: `envelope` takes no `ctx` and cannot read one, so a re-execution declares identical requests. |
| Refuses | an unknown effort or stage. |
| Budget | `meta.budget` is static, so declare it at module scope as the worst case the input schema admits — the `deep` column over the largest fan-out — and let each task reserve its own row. |
| Hand-write when | one stage genuinely needs a model the table does not have. Pin `model` on that request; keep every other stage on the table. |

```ts
// Hand-written: a literal per task, repeated per effort branch
const reviewer = ctx.agent("review", {
	agent: "reviewer", contextMode: "fresh",
	model: { provider: "github-copilot", id: "gpt-5.6-sol", thinking: "high" },
	limits: {
		cumulativeRuntimeMs: 1_200_000, attemptTimeoutMs: 1_200_000,
		totalTokens: 2_000_000, cost: 5, outputBytes: 65_536,
		workspaceWriteBytes: 0, retries: 1, resumes: 1,
	},
	/* task, tools, preloadSkills, contextScopes, workspace, outputSchema */
});

// With the component
const shape = envelope(ctx.input.effort, "review");
const reviewer = ctx.agent("review", {
	agent: "reviewer", contextMode: "fresh",
	model: shape.model,
	limits: shape.limits,
	/* task, tools, preloadSkills, contextScopes, workspace, outputSchema */
});
// at module scope, where meta.budget is declared:
const BUDGET = workflowBudgetFor([envelope("deep", "review").budgetShare]);
```

`MODEL_PROVIDER`, `MODEL_ID`, and `DIVERSE_MODEL_ID` are a stand-in for host
routing and carry a `DELETE WHEN ROUTING LANDS` marker. When `modelRole` is
installed ([Agent requests](#agent-requests)), the table emits a role and the
thinking column becomes a tier; its shape — one row per `(effort, stage)` —
does not change.

### Fan-out over a stable id

| | |
| --- | --- |
| Intent | One worker per item of a list the input already carries. |
| Lowers to | exactly one `ctx.fanOut(namespace, items, { key, task })`. |
| Keying | `key(item) = idOf(item)`, and `idOf` may read only a field the workflow's input schema **requires**. An optional field that is absent next drive produces a different key and invalidates the run. Never the loop index: reordering the input would rename every task. |
| Replay laws | Law 2 is the one to watch — the items must come from `ctx.input` or from a barrier value, never from a directory listing, a glob, or a model's prose. Law 1 is half-checked (`idOf` is called twice). |
| Refuses | more than 64 items (the runtime's own fan-out bound, named at the plan rather than at the engine); an id that is not a task key; an unstable id (two calls, two answers); a duplicate id; a projected worst case that does not fit the `budget` passed in. |
| Budget | `projectFanOutBudget` sums each declared request's `limits` exactly as the scheduler reserves them, and `budget` turns an over-allocated fan-out into a declaration-time refusal instead of a mid-run block. |
| Hand-write when | the per-item declaration is not one agent task — a fan-out of gates, of support tasks, or of pipelines. `forEach` declares agent tasks only. |

```ts
// Hand-written
const work = ctx.fanOut("implement", ctx.input.plan.deliverables, {
	key: (deliverable) => deliverable.id as TaskKey,
	task: (deliverable) => implementRequest(deliverable),
});

// With the component
const work = forEach(ctx, "implement", ctx.input.plan.deliverables, {
	idOf: (deliverable) => deliverable.id,
	task: (deliverable) => implementRequest(deliverable),
	budget: BUDGET,
});
```

### Review fan-out with lens diversity and a degrading synthesis

| | |
| --- | --- |
| Intent | Several read-only reviewers over one subject at once, merged on a deterministic rail, with an honest coverage row per lens. |
| Lowers to | `ctx.fanOut(ns, lenses, …)` with `disposition: "optional"`, one `await ctx.settled(reviewers)`, and one `ctx.fanIn` into `<ns>-synthesis`, declared only when a synthesis is asked for **and** at least one lens reported. |
| Keying | `key = lens.id`. A repeated id takes `-2`, `-3`, … **by declaration ordinal**, never by a counter over runtime data, so reordering distinct lenses moves tasks without renaming any. A suffix that collides with an id the caller also declared is refused, not resolved. |
| Replay laws | Law 1 by ordinal; law 2 — the lens list comes from `ctx.input`; law 3 — the reviewer's tier is carried to the caller's `envelope` lookup, and the component never picks a model from a tier itself. |
| Refuses | more than 16 lenses; an invalid or colliding lens id; a lens that is not `workspace: { mode: "read-only", cwd }`; a lens input the subject already provides; a `diverse` lens with neither a pinned `model` nor a configured `diversity` seam (it never reviews with the same model twice and calls that diverse); `synthesis: "required"` with no reporting lens; a synthesis that declares its own `inputs`. |
| Budget | the caller's, through `envelope(effort, "review")` per lens plus `envelope(effort, "synthesis")`. Size `meta.budget` for the largest lens list the input schema admits. |
| Hand-write when | the lenses are not peers — a two-stage review where the second reads the first — or a lens must be `required`. |

The optional-reviewer rule this pattern exists to encode: reviewers are
`disposition: "optional"` so one flaky lens does not fail an approved
implementation, but **a data dependency on a failed optional task blocks its
dependents**, and a barrier's control edge covers every task it closed over
([Failure semantics for authors](#failure-semantics-for-authors)). So read
outcomes through `ctx.settled`, never `ctx.results`; compute the verdict from
the lenses that reported; wire the synthesis reducer's `inputs` from the
reporting lenses only; and report `coverage`, so a review that lost a lens
reads as three of four instead of as a complete one.

```ts
// Hand-written
const reviewers = ctx.fanOut("review", lenses, {
	key: (lens) => lens.id as TaskKey,
	task: (lens) => ({ ...reviewRequest(lens), disposition: "optional" as const }),
});
const settled = await ctx.settled(reviewers);
const reported = settled.flatMap((outcome, index) =>
	outcome.status === "fulfilled" ? [{ index, value: outcome.value }] : []);
const merged = mergeReviewReports(/* … */);
// …then fanIn over `reported` only, and only when it is non-empty.

// With the component
const review = await reviewFanOut(ctx, "review", ctx.input.lenses, {
	subject: { title, inputs: { patch: implement.handoff } },
	review: (lens) => reviewRequest(lens, envelope(effort, "review")),
	diversity: { model: { provider: MODEL_PROVIDER, id: DIVERSE_MODEL_ID, thinking: "high" } },
	synthesis: "optional",
	synthesize: (brief) => synthesisRequest(brief),
});
// review.verdict, review.findings, review.coverage, review.synthesis?
```

### A reviewed subject reports findings, not prose

| | |
| --- | --- |
| Intent | Every reviewer in every workflow returns the same `Finding` shape, so a fan-out of reviews merges into one verdict without a model in the middle. |
| Lowers to | nothing. `FindingSchema`, `ReviewReportSchema`, `mergeReviewReports`, and `dedupeFindings` are pure functions over JSON values — legal on either side of a barrier, identical on replay. |
| Keying | a finding id is `^[a-z0-9][a-z0-9-]{0,63}$`; `where` is an RFC 6901 pointer into the reviewed document, or a `path:line`. |
| Replay laws | law 3 in spirit: the merge is a table, not a model call, which is why a synthesis agent may be absent without changing the verdict the run records. |
| Refuses | nothing at declaration; the schemas refuse at the task boundary, where an agent result is validated. |
| Budget | none. |
| Hand-write when | never, for a review a second workflow will read. A bespoke finding shape is a merge nobody else can perform. |

`severity` is `blocking \| major \| minor` (the array order **is** the
ordering), `kind` is `gap \| graph \| budget \| risk \| ambiguity`, and the
optional `patch` is RFC 6902-shaped so that accepting a finding is a
mechanical apply followed by the document's own validation, never a
re-prompt. Ask for findings in the reviewer's own prose too: an agent told to
"report findings, not prose" fills the schema; one told to "review carefully"
writes an essay into `what`.

### A bounded loop with a barrier per round

| | |
| --- | --- |
| Intent | Run the repository's own check against a worktree patch, hand a failing check back to a fixer, and stop at a cap — with the last word always a check nobody skipped. |
| Lowers to | per round: one `ctx.agent` verifier, one `await ctx.result` barrier, then one `ctx.agent` fixer in a worktree with `handoff: "required"`. No generic `loopUntil` — that component stays deferred. |
| Keying | `<key>-verify-<n>` and `<key>-fix-<n>`, `n` from 1: a pure function of the caller's key and the round ordinal, and of nothing else. The keys are flat because no `ctx` member opens a namespace that admits a barrier between its members. |
| Replay laws | Law 3 with the round ordinal: every model and limit comes from `envelope(effort, "verify" \| "fix")` and from the escalation rung, never from the barrier value the loop just read. |
| Refuses | `maxRounds` outside 0..3; a missing or blank `check.command`; an `implementation` that is not a worktree handle (a read-only task produces no handoff); `escalate: "thinking"` at `deep`, where the ladder ends; a fixer that is not a worktree task; a request that declares `model`, `limits`, `outputSchema`, or the fixer's `handoff` — all component-owned; an input name the loop already wires; a worst case that does not fit `budget`. |
| Budget | `projectVerifyAndFixBudget(effort, escalate, maxRounds)` — every verifier plus every fixer the cap allows, at the escalated rung. |
| Hand-write when | the loop is not verify-then-fix: a research loop, a negotiation, anything whose next round is a different kind of task. Keep the cap and the per-round keys. |

`maxRounds` bounds the **verify** rounds, so at most `maxRounds - 1` fixers
follow and the component never returns a fix nobody checked. `0` declares
nothing — the implementer's own patch stands, which is *unverified*, not
*failed*, and the gate downstream must say so. `1` is `verify-1` alone: a
failing check is evidence at the gate, not a fix round. `3` is
`verify-1, fix-1, verify-2, fix-2, verify-3`. A compiler that speaks in fix
rounds maps `maxRounds = fixRounds + 1`.

**The cap is 3, and it is measured rather than assumed.**
[`docs/research.md`](../../docs/research.md), "Replay cost of a bounded loop",
with `test/replay-cost.test.ts` behind it, finds that replay cost grows
**quadratically** in the barriers a source has already crossed
(`replay ≈ 122 µs × barriers × journal events`), because every drive
re-executes the definition from the top and re-declares every task of every
epoch already crossed. On a four-deliverable plan a worst-case resume is
2.6 s at one fix round, 4.4 s at two, and 6.5 s at three — still under a
quarter of the runtime's projection bound — while at six rounds it is 15.6 s
and a single plan spends a third of that bound on fix rounds nobody reviewed.
**Three verify rounds is the highest comfortable cap**; an unbounded
`loopUntil` is not affordable at all, which is why it stays deferred and this
loop is unrolled at declaration.

`checkRan: false` is the other rule the measurement does not cover but the
pattern must: a check killed before it completed is *unverified*, not
*broken*. Fixing code nobody proved was broken is how a loop burns a budget
on a machine problem, so the loop stops, declares no fixer, and hands the
decision to a person. It never counts as green.

```ts
// Hand-written
let patch = implement;
for (let round = 1; round <= maxRounds; round += 1) {
	const verifier = ctx.agent(`check-verify-${round}` as TaskKey, {
		...verifyRequest(round), outputSchema: CheckReportSchema,
		model: envelope(effort, "verify").model,
		limits: envelope(effort, "verify").limits,
		inputs: { patch: patch.handoff },
	});
	const report = await ctx.result(verifier); // the barrier
	if (!report.checkRan || report.checkPassed || round === maxRounds) break;
	patch = ctx.agent(`check-fix-${round}` as TaskKey, {
		...fixRequest(round), handoff: "required",
		model: envelope(effort, "fix").model,
		limits: envelope(effort, "fix").limits,
		inputs: { patch: patch.handoff, check: verifier.output },
	}) as WorktreeTaskHandle<unknown>;
}

// With the component
const loop = await verifyAndFix(ctx, "check", {
	implementation: implement,
	check: { command: "npm run check", install: "npm ci" },
	effort: ctx.input.effort,
	maxRounds: 2,            // verify rounds, 0..3; one fix round follows
	escalate: "thinking",    // a fixer runs one rung up the ladder
	verify: (round, previous) => verifyRequest(round, previous),
	agent: (round, previous) => fixRequest(round, previous),
	budget: BUDGET,
});
// loop.passed, loop.checkRan, loop.lastTail, loop.handoff, loop.rounds
```

The dependency between rounds is a **data** dependency, never a bare `after`:
a verifier names the current patch's handoff handle in its `inputs`, and a
fixer names that handoff plus the failing verifier's report. The runtime
never applies a handoff to a worktree, so what the task receives is the
descriptor — baseline, commit, digest, size, and the durable ref — and the
caller's prose is what tells the fixer to apply it
([Worktree tasks and handoffs](#worktree-tasks-and-handoffs)).

## Builtin workflows

The package ships these under its own `builtin` root, runnable in any project
without project trust. They are the worked examples of the patterns above.

| Ref | In | Out | Parks for a human? |
| --- | --- | --- | --- |
| `plan-to-ship` | `{plan, planDigest, effort}` — a pi-maestro plan by value with its sha256 digest and the effort dial | `{approved, shipped, deliverables[], reviews[], receipt}`; the receipt names each durable handoff ref and the approved plan digest | Yes: the `approve-plan` and `ship` gates, both `headless: "block"` |
| `deep-review` | `{subject, effort, lenses?, synthesis?, maxFindings?}` — one `worktree-handoff`, `tree`, or `document` subject | `{verdict, findings (≤64), coverage[], synthesis?}` | No gate, no worktree, no handoff |
| `plan-review` | `{plan, planDigest, intent, compiled, projection, effort}` | `{verdict: ready \| gaps \| blocked, findings (≤32), notes?}` | No. Exactly one read-only agent, and the one definition a host may start headlessly |
| `deep-research` | `{question, depth, sources?}` — one question, the depth dial doubling as the thread count, and up to 16 `path`/`url`/`note` sources | `{answer, claims[], crossChecks[], coverage[]}`; a coverage row per thread says which one did not report | No gate, no worktree, no handoff — structurally headless, but **not** on the headless allowlist |

`plan-to-ship` never pushes, merges, or applies anything; it records a
receipt. `plan-review` is deliberately blind — `contextMode: "fresh"`,
`contextScopes: []`, and no planning conversation — because a reviewer that
inherits the conversation only ever agrees with it. `deep-research` is the
opposite: its threads read the project's own context files, and the
independence it needs is between the threads, which `contextMode: "fresh"`
delivers. All four name agents the package ships under
`workflows/agents/*.md`, which the run carries to pi-subagent as the request's
`agentRoots`; `<agentDir>/agents` or a trusted project's `.pi/agents` overrides
a name it defines.

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
   explicit confirmation in an interactive Pi session; an embedder without
   Pi calls `service.decideSource`). There is no approve, reject, or proposals tool,
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
