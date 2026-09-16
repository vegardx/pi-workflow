# pi-workflow

Custom workflow runtime for [Pi](https://pi.dev).

This repository contains the durable static execution core and Pi extension for
trusted agent workflows with read-only and worktree agent tasks, durable
deterministic support-task execution, bounded nested static workflows executed
as linked child runs, declarative required and advisory finalizers
(`ctx.finalize`), human checkpoints with immutable decisions
(`ctx.checkpoint`), dynamic workflows (proposed TypeScript source that runs
in a worker-thread VM against the same runtime only after a human has
approved its exact digest), and an operator surface (`/workflow`, the
`pi-workflow` widget, the `alt+w` inspector, and the
`workflow_retry`/`workflow_resume` tools) that projects the service's read
views. Version 1.1.0; runtime contract revision 18 with the feature flags
`checkpoints: true` and `dynamicWorkflows: true` alongside the earlier flags,
and it requires pi-subagent contract revision 6 (`handoffExport: true`). The
human-only `/workflow decide` and `/workflow approve|reject` commands are part
of the operator surface; a Pi tool for handoff export remains unavailable.

## Goal

Provide one reusable workflow engine with:

- trusted static TypeScript workflow authoring and a human-approved dynamic
  frontend that runs the same authoring surface in a worker-thread VM;
- typed task/artifact handles that materialize a declarative durable graph;
- stable tasks, explicit order/data dependencies, parallelism, pipelines,
  bounded fan-out/fan-in, and bounded nested workflows;
- schema-validated agent results and deterministic support tasks;
- declared cost/runtime budgets, optional total-token guards, and durable
  wall-clock deadlines;
- append-only lifecycle state, leases, fencing, resume, retry, replay, and
  reconciliation;
- fail-closed persistence, required and advisory finalizers declared with
  `ctx.finalize`, and bounded UI;
- physical child execution delegated to the exact extension-owned
  `SubagentService`.

```text
TypeScript effects
  (trusted static source in-process; approved dynamic source in a
   worker-thread VM, declarations crossing a bounded RPC bridge)
      ↓
validated TaskSpec graph
      ↓
journal + scheduler + recovery
      ↓
shared pi-subagent service (agent tasks)
in-process support executor (support tasks)
linked child workflow run (nested workflow tasks)
```

Workflows without result-dependent branches can materialize their complete DAG
before execution. Data-dependent workflows materialize the same graph
incrementally across explicit result barriers.

`pi-workflow` owns orchestration. It does not spawn private child runtimes or
own publication, push, pull-request, merge, release, or deployment policy.

## Stability

`@vegardx/pi-workflow` 1.0.0 freezes four surfaces: the authoring API
(`defineWorkflow`, `defineSupportTask`, `WorkflowContext`, the handle and
request types), the service API (`createWorkflowService`,
`WorkflowServiceOptions`, every `WorkflowService` method and the views it
returns), the contract layer (the revision-18 schemas, constants, and
compatibility predicates), and the extension entry (the default export of
`@vegardx/pi-workflow/extension`, the fourteen `WORKFLOW_TOOL_DECLARATIONS`
tools, the `/workflow` grammar, the `pi-workflow` widget, and the `alt+w`
inspector). A breaking change to any of them is a new major version; adding
an export, an optional option or view field, a tool, or a `/workflow`
subcommand is a minor version; see
[Contracts](docs/contracts.md#public-api-and-stability) for the rule and
[CHANGELOG.md](CHANGELOG.md) for the record. 1.1.0 is such a minor release:
it adds the optional `WorkflowServiceOptions.registeredRoots` and the
package's own builtin workflow root, and changes nothing frozen.

Import from the package root for anything that declares a shape or drives
the two APIs:

```ts
import { createWorkflowService, defineWorkflow } from "@vegardx/pi-workflow";
```

The engine (reducer, scheduler, executors, static runtime, materializer,
registry discovery, stores, projections, predicates, identity derivations,
and the dynamic VM host) lives at `@vegardx/pi-workflow/runtime`. That
subpath is exported but **not frozen**: its names may change in any minor
release, no name is exported from both entries, and the import gate refuses
it from a workflow definition. Embedders that import it accept that cost:

```ts
import { WorkflowRunJournal, reduceWorkflowEvents } from "@vegardx/pi-workflow/runtime";
```

`@vegardx/pi-workflow/package.json` is exported so an embedder can read the
installed `version` without knowing the install path
(`import("@vegardx/pi-workflow/package.json", { with: { type: "json" } })`).
Deep `dist/` paths are not exported. The exact root and runtime export lists
are pinned in `test/fixtures/public-api/root-exports.json` and
`runtime-exports.json`; the pack check and `test/public-api.test.ts` fail
when the package deviates from them.

## Documentation

- [Glossary](docs/glossary.md)
- [Architecture](docs/architecture.md)
- [Contracts](docs/contracts.md)
- [Authority model](docs/authority.md)
- [Persistence and recovery](docs/persistence.md)
- [Failure taxonomy](docs/failures.md)
- [Threat model](docs/threat-model.md)
- [Acceptance inventory](docs/acceptance.md)
- [Implementation research](docs/research.md)
- [Research source ledger](docs/research-sources.md)
- [Roadmap](docs/roadmap.md)
- [Compatibility matrix](docs/compatibility.md)
- [Changelog](CHANGELOG.md)
- [Workflow authoring skill](skills/workflow-authoring/SKILL.md)
- [Workflow operating skill](skills/workflows/SKILL.md)
- [1.0.0 qualification](docs/qualification.md)
- [macOS arm64 Phase 1 qualification](docs/qualification/macos-arm64-phase1.md)
- [macOS arm64 artifact pipeline qualification](docs/qualification/macos-arm64-artifact-pipeline.md)
- [macOS arm64 bounded parallel qualification](docs/qualification/macos-arm64-parallel.md)
- [macOS arm64 settled-result qualification](docs/qualification/macos-arm64-settled.md)
- [macOS arm64 bounded fan-out qualification](docs/qualification/macos-arm64-fan-out.md)
- [macOS arm64 bounded fan-in qualification](docs/qualification/macos-arm64-fan-in.md)
- [macOS arm64 pipeline builder qualification](docs/qualification/macos-arm64-pipeline.md)

## Dependency

[`pi-subagent`](https://github.com/vegardx/pi-subagent) owns every physical
agent run and attempt. Its extension registers a lazy provider on Pi's event bus.
Workflow acquires that exact service through the public typed provider export,
checks the exact runtime contract, and never constructs or shuts down a second
execution service. The required pi-subagent version, contract revision, and
feature values, together with the Pi, Node.js, and typebox ranges and the host
qualification status, are recorded in
[`compatibility.json`](compatibility.json) and explained in the
[compatibility matrix](docs/compatibility.md); tests and the pack check keep
them in step with `package.json`, `src/contracts.ts`, and CI.

## Pi tools

The packaged extension registers every entry of the exported
`WORKFLOW_TOOL_DECLARATIONS` table, which carries each tool's parameter
schema, output schema, and service binding:

| Tool | Parameters | Output schema |
| --- | --- | --- |
| `workflow_list` | none | `WorkflowDefinitionSummaryListSchema` |
| `workflow_validate` | `ref`, optional `input` | `WorkflowValidationResultSchema` |
| `workflow_run` | `ref`, `input` | `WorkflowServiceRunReceiptSchema` |
| `workflow_status` | `runId` | `WorkflowServiceRunViewSchema` |
| `workflow_wait` | `runId`, optional `timeoutMs` | `WorkflowServiceWaitViewSchema` |
| `workflow_stop` | `runId`, `reason` | `WorkflowServiceRunViewSchema` |
| `workflow_reconcile` | `runId`, optional `taskId` | `WorkflowServiceReconcileViewSchema` |
| `workflow_runs` | optional `statuses`, `includeChildren`, `limit`, `cursor` | `WorkflowRunPageSchema` |
| `workflow_inspect` | `runId`, optional `include`, `taskId` | `WorkflowRunInspectionSchema` |
| `workflow_logs` | `runId`, optional `afterSequence`, `limit` | `WorkflowLogPageSchema` |
| `workflow_invalidate` | `runId`, `taskId`, `reason` | `WorkflowServiceRunViewSchema` |
| `workflow_retry` | `runId`, `taskId`, `reason` | `WorkflowServiceRunViewSchema` |
| `workflow_resume` | `runId`, `reason`, optional `taskId` | `WorkflowServiceRunViewSchema` |
| `workflow_propose` | `source` | `DynamicWorkflowProposalViewSchema` |

Each tool result carries the typed service value as `details` and the same
value, checked against its output schema, as JSON text bounded to 48 KiB
(`workflowToolText`): run and log pages shrink to the bound and re-cursor so
later pages stay complete, an oversized inspection is refused with guidance to
narrow `include` or pass `taskId`, an oversized run `output` is omitted in
favor of the durable output artifact, and the `workflow_list` array is
truncated with a marker. `workflow_run` returns a durable run ID immediately.
Use `workflow_wait` for the bounded result (with `timeoutMs`, the current view
marked `timedOut` while the run keeps driving) or `workflow_stop` to persist
stop intent, abort in-process support work, and drain active child work.
`workflow_reconcile` takes `runId` and an optional `taskId` (forwarded
unchanged to `reconcile(runId, { taskId })`) to reconcile one cleanup-blocked
task instead of every blocked task in order. `workflow_runs`,
`workflow_inspect`, and `workflow_logs` read without taking a run lease;
`workflow_invalidate` re-executes a settled task and its dependents on a
failed or interrupted run; `workflow_retry` is the same restricted to a task
whose current execution failed or was interrupted, and `workflow_resume`
re-attempts an interrupted agent task on its existing subagent run and
attempt, preserving the child session. Both act only on durably failed or
interrupted root runs; `availableActions` in `workflow_runs` and
`workflow_inspect` lists them when they are legal. Every tool renders a
one-line call and collapsed result in the TUI from the table's
`summarizeCall`/`summarizeResult`.

`workflow_wait` on a run parked at a checkpoint returns its `waiting` view
immediately, marked `parked: true` and listing `pendingCheckpoints` — each
with the prompt, the task key, the answer shape, the declared inputs, and the
instruction to surface the question and stop; do not poll it. Checkpoint
decisions are human-only: there is no model-callable decide tool, by design,
and a model must never decide a checkpoint. A parked run is surfaced to the
operator: in a session with UI, Pi asks the person itself with a guided form
(the prompt, the inputs, and one dialog per decision field), and `/workflow
decide <run> <task> [json] [reason…]` and the inspector's decide entry open
the same form; passing `<json>` keeps the direct path. Every route requires an
interactive Pi session and an explicit confirmation, records the Pi session
identity as approver (never an argument), and is the pass-through for
`service.decide(runId, taskId, { decision, approver, reason? })`.
`workflow_propose` submits dynamic workflow TypeScript source and returns its
proposal as `dynamic:<sha256>`; it only proposes. Approval is human-only and
never a tool: there is no `workflow_approve`, `workflow_reject`, or
`workflow_proposals` tool, and `workflow_validate` and `workflow_run` accept a
`dynamic:<sha256>` reference only after a human approved it (see
[Dynamic workflows](#dynamic-workflows)).

### Operator surface

The extension registers one command, one shortcut, and one widget, all of
which are projections of the service's read surface: they consume
`availableActions`, `requiresAttention`, `ownership`, and `leasedElsewhere`
from run summaries and never decide legality themselves.

```
/workflow                                   inspector (TUI) or run list (print, rpc, json)
/workflow list                              trusted definitions
/workflow runs [--all]                      durable runs; --all includes nested children
/workflow validate <ref> [json]
/workflow run <ref> [json]                  TUI without json opens an editor
/workflow show|status <run-prefix>
/workflow logs <run-prefix> [--tail <n>]    n: 1..500, default 20
/workflow wait <run-prefix> [--timeout <ms>] ms: 1000..3600000
/workflow stop <run-prefix> [reason…]
/workflow reconcile <run-prefix> [task-key]
/workflow invalidate <run-prefix> <task-key> [reason…]
/workflow retry <run-prefix> <task-key> [reason…]
/workflow resume <run-prefix> [task-key]
```

Run prefixes resolve through `listRuns` (children included) and an ambiguous
prefix is refused with the candidates; task keys are paths
(`phase-1/report`) or full task ids and never address abandoned tasks. The
action subcommands are derived from `IMPLEMENTED_WORKFLOW_RUN_ACTIONS`, so
the grammar, completions, and inspector palette only ever offer service
methods that exist; `decide`
(`/workflow decide <run-prefix> <task-key> [json] [reason…]`, which prompts
for the decision when `json` is omitted), `approve`, and `reject` follow as
human-only subcommands. `stop`, `invalidate`, `retry`, and `resume` ask for
confirmation when a UI is present; `print` mode executes directly and writes
to stdout. `alt+w` opens the inspector without interrupting input. In the
TUI a two-line `pi-workflow` widget below the editor shows
`workflows ongoing: …` and `workflows need action: …`, is hidden when neither
applies, marks runs leased by another Pi process as `(n elsewhere)`, refreshes
from `subscribe`, and polls only while nonterminal runs exist. While a run
this session owns waits for a decision, its first line becomes
`waiting for you: <prompt>` and the counts collapse into the second.

## Bundled skills

The package ships the model-invoked `workflow-authoring` skill under
`skills/` (declared through `pi.skills`). It documents definition roots and
trust, the import allow-list, `defineWorkflow`, the `ctx` API with the bounds
and error messages the runtime throws, agent request limits, budgets, support
tasks, nested workflows, checkpoints, dynamic workflows (the same source
proposed through `workflow_propose`), failure semantics, invalidation, and the
validate-run-inspect loop, with examples that a test loads through the real
definition loader and through the dynamic manifest VM.

The companion `workflows` skill under `skills/workflows/` covers the other
side: operating existing runs — the fourteen `workflow_*` tools and their
bounds, the run statuses, why a parked run is surfaced to the human instead
of polled, the human-only approval and decision acts, the `/workflow` command
grammar, and the `availableActions` legality table — pinned to the runtime in
both directions by `test/skill-operating.test.ts`.

## Builtin workflows

The package ships its own definitions in `workflows/` (in the tarball, and
declared by the `pi.workflows` manifest key). The extension registers that
directory when it creates the service:

```ts
createWorkflowService({
	/* … */
	registeredRoots: [{ path: "<package>/workflows", scope: "builtin", source: "package" }],
});
```

Builtin definitions are **trusted package code**: they are trusted by their
installation source, so they are listed by `workflow_list` with
`scope: "builtin"`, `source: "package"`, and validate and run in any project
without Pi project trust — the project trust gate covers `<cwd>/workflows` and
`<cwd>/.pi/workflows` only. They buy discovery, not authority: a builtin
definition's task requests pass through the same grant intersection, runtime
policy, and human checkpoints as a project definition's.

They are loaded from source by the same loader as any other definition, so
their imports resolve from their own location inside the installed package
(`@vegardx/pi-workflow` resolves to the package itself, `typebox` to the peer
the consumer installed). The pack check installs the tarball and asserts that
`workflow_list` finds them there. An embedder ships its own definitions the
same way: `registeredRoots` at construction, or `service.registerRoot` later,
with `scope: "package"` or `"builtin"`. Discovery loads only `*.workflow.*`
files, so `workflows/agents/*.md` travels in the same directory without being
mistaken for a definition.

### `plan-to-ship`

`workflows/plan-to-ship.workflow.ts` is the current builtin: **plan ->
approve -> implement -> ship**, with two human gates and no publication at the
end. Its input is a pi-maestro plan document by value, the sha256 digest of
that document's canonical JSON, and an effort dial:

```text
workflow_run { ref: "plan-to-ship", input: { plan, planDigest, effort } }
```

The stages, in order:

1. **`refine`** — one read-only planner agent turns the authored plan into an
   executable one: per deliverable a goal, the files it touches, acceptance
   checks, risks, and the blockers that make the plan unexecutable as written.
2. **`approve-plan`** — a checkpoint (`headless: "block"`). It is *the*
   approval record: immutable, binding-addressed, stored in the run's
   `decisions/`. A person answers
   `/workflow decide <run> <task> '{"proceed":true}'`; a model never decides a
   checkpoint. `{"proceed":false}` returns `{ approved: false }` and no
   worktree task is ever declared, so no tree is touched.
3. **`implement-<id>`** — one worktree agent per deliverable, `handoff:
   "required"`, gated on the approval. Each starts from the same baseline:
   deliverables never build on each other, `after` is honoured as order only,
   and `reads` is not mapped to inputs.
4. **verification inside the implementer** — it attempts the repository's own
   install and check command in its worktree and reports `checkRan`,
   `checkPassed`, and a bounded `checkTail` truthfully. The guest is small, so
   a check that could not run is a normal, reportable outcome; the check is
   evidence, never the gate.
5. **`review/lens-N`** — read-only reviewers over the plan's review tasks, each
   given the implementer's summary and its handoff **descriptor** (identity,
   digest, size — never patch bytes). There is no automatic fix round in
   milestone 1: blocking findings travel to the ship gate.
6. **`ship`** — the second checkpoint, shown the implementer summaries, the
   check results, and the review verdicts as its inputs.
7. **`receipt`** — a required finalizer that records what shipped, after the
   output is committed and unable to change it.

**What "ship" means.** Nothing is pushed, merged, published, or turned into a
pull request — the runtime never applies a handoff. Shipping is a receipt: for
each deliverable the workflow-owned `git-format-patch` artifact and the durable
ref `refs/pi-subagent/handoffs/<subagentRunId>/<subagentAttemptId>`, which
survives the child's release, plus the `planDigest` that was approved. A person
takes it from there with `git cherry-pick <handoffCommit>`.

**The effort dial.** `effort` is `cheap`, `standard`, or `deep`; a constant
table in the definition maps it to a per-stage model, thinking level, token,
cost and runtime budget, how many review lenses run (the first one, all of
them, or all of them twice), and how long each gate waits. The model ids in
that table are a marked stand-in until roster/allowance routing lands; a review
task's `by.tier` and `by.diverse` are honoured through it, and `by.model` pins
an exact route.

**The three agents.** The definition names `planner`, `implementer`, and
`reviewer`. pi-subagent discovers agents only from `<agentDir>/agents/*.md` and
a trusted project's `.pi/agents/*.md`, so a builtin workflow **cannot** install
them; a run whose host lacks one fails that task at preflight. The package
ships them as templates:

```sh
cp node_modules/@vegardx/pi-workflow/workflows/agents/*.md ~/.config/pi/agent/agents/
# or, for one trusted project only:
cp node_modules/@vegardx/pi-workflow/workflows/agents/*.md .pi/agents/
```

Each template is an authority **ceiling** a task may narrow but never widen:
the implementer is the only one with `edit`/`write`/`bash`, the only one
allowed `workspaceModes: [worktree]`, and carries a 2 GiB
`workspaceWriteBytes` ceiling so a real install and build fit. Pinning
`by.model` to a route outside a template's `allowedModels` fails preflight with
`model exceeds ceiling`; add the route to the template you copied.

## Support tasks

Trusted packages define typed descriptor helpers with `defineSupportTask` and
pass the matching `helper.registration(execute)` objects to
`createWorkflowService({ supportTasks })`. Workflows declare them with
`ctx.support(key, helper({ parameters, inputs }))`. The runtime resolves each
persisted descriptor against that constructor registry by exact implementation
identity, runs the implementation in the host process without a subagent,
model, VM, or worktree, and commits the output as a workflow-owned artifact.
The root exports are `defineSupportTask`, `SupportTaskExecutionRecordSchema`,
and `SupportTaskTerminalEvidenceSchema`; the engine pieces
`createWorkflowSupportTaskExecutor`, `supportRegistrationIdentity`, and
`deriveSupportImplementationIdentitySha256` are exported from
`@vegardx/pi-workflow/runtime`; see
[Contracts](docs/contracts.md#support-task-execution).

## Nested workflows

A workflow can run another discovered workflow as a linked child run:

```ts
export default defineWorkflow({
	meta: {
		name: "nest-parent",
		description: "Parent",
		version: 1,
		budget: { cost: 5, childRuntimeMs: 120_000 },
		timeoutMs: 600_000,
	},
	inputSchema: InputSchema,
	outputSchema: OutputSchema,
	run(ctx) {
		const task = ctx.agent("draft", {
			agent: "researcher",
			task: { goal: "Draft the document", context: [], instructions: [] },
			contextMode: "fresh",
			tools: ["read"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: ctx.cwd },
			limits: limits.readOnly,
			outputSchema: DocSchema,
		});
		return ctx.workflow("child", {
			workflow: "echo-child",
			input: { value: ctx.input.value },
			inputs: { doc: task.output },
		});
	},
});
```

The child is resolved by name from the same discovery pass and trust gate as
the parent. Its identity, source digest, schemas, budget, timeout, and
concurrency are captured at declaration together with the authored `input`
and any named artifact `inputs`, and the task is lowered into a
`kind: "workflow"` record. Artifact inputs follow the merged-input rule: each
producer becomes an order dependency, the authored `input` must be an object
without a key equal to an input name, and at launch every verified artifact
value is merged into it as a top-level key (`{ value, doc }` above), validated
against the child's input schema and the 900 KiB bound, and launched as the
child's plain `ctx.input`. Without artifact inputs the authored input is
validated at declaration. Execution launches a separate durable run with its
own journal, lease, artifact store, and subagent owner binding; the parent
reserves the child's declared budget, caps the child's deadline at its own,
records the injected artifact identities in the child's run record, and
imports the child's verified output as a parent-owned artifact before the task
completes. Depth is bounded at 0 through 3, a run may declare at most 64
workflow tasks, and recursion along the ancestor chain is rejected. The root
exports are `NestedWorkflowTaskSpecSchema`,
`NestedWorkflowInputArtifactsSchema`, `NestedWorkflowTerminalEvidenceSchema`,
and `MAX_NESTED_WORKFLOW_DEPTH`; `createWorkflowNestedRunExecutor` and
`deriveNestedWorkflowRunId` are exported from `@vegardx/pi-workflow/runtime`;
see [Contracts](docs/contracts.md#nested-workflow-tasks).

## Retry and resume

An agent request may declare how many fresh pi-subagent attempts the runtime
may make on the same child run after a classified failure:

```ts
const draft = ctx.agent("draft", {
	agent: "researcher",
	task: { goal: "Draft the document", context: [], instructions: [] },
	contextMode: "fresh",
	tools: ["read"],
	preloadSkills: [],
	contextScopes: ["project"],
	workspace: { mode: "read-only", cwd: ctx.cwd },
	limits: { ...limits.readOnly, retries: 3, resumes: 1 },
	outputSchema: DocSchema,
	retry: { attempts: 2, on: ["backoff", "manual"] },
	resume: { attempts: 1 },
});
```

`retry` applies to a `failed` child whose failure is classified `backoff` or
`manual` (`on` defaults to `["backoff"]`); `resume` applies to an `interrupted`
child whose failure is classified `resume`. Each `attempts` value is 1 through
10 and may not exceed the request's own `limits.retries` or `limits.resumes`.
Every attempt is recorded under the same task execution: intent is persisted
before the owner client's `retry` or `resume` call, the receipt after it, and
each attempt's settlement evidence is retained so budget usage sums across
attempts. pi-subagent enforces backoff; the runtime waits until `retryAt`,
bounded by the workflow deadline and stop signal, and declines the attempt when
either arrives first. Failures classified `never` or `reconcile` are never
retried by policy; an operator may still re-execute the task through
`workflow_retry` or, for an interrupted child classified `resume`, re-attempt
it through `workflow_resume`. The root exports are `AgentRetryPolicySchema`
and `AgentResumePolicySchema`; `createWorkflowTaskRetrier`,
`settledAgentUsage`, and `currentSubagentAttemptId` are exported from
`@vegardx/pi-workflow/runtime`; see
[Contracts](docs/contracts.md#retry-and-resume-attempts).

## Worktree tasks and handoffs

An agent request with `workspace: { mode: "worktree", cwd }` runs the child in
a pi-subagent worktree and must declare `limits.workspaceWriteBytes >= 1`. The
workflow-only `handoff` policy (`"required"` by default, or `"optional"`) is
part of task identity and is never sent to pi-subagent:

```ts
const implement = ctx.agent("implement", {
	agent: "implementer",
	task: { goal: "Implement the change", context: [], instructions: [] },
	contextMode: "fresh",
	tools: ["read", "grep", "edit", "write"],
	preloadSkills: [],
	contextScopes: ["project"],
	workspace: { mode: "worktree", cwd: ctx.cwd },
	handoff: "required",
	limits: { ...limits.readOnly, workspaceWriteBytes: 64 * 1024 * 1024 },
	outputSchema: SummarySchema,
});
const handoff = await ctx.handoff(implement); // WorkflowHandoffDescriptor
```

When the child completes, the task finalizer imports its structured output,
then calls pi-subagent's `exportHandoff`, verifies the returned reference
against the settled `{ attemptId, baselineHead, handoffCommit }` identity, its
format, digest, size (at most `MAX_WORKFLOW_HANDOFF_BYTES` = 16 MiB), and the
single-commit `git format-patch` shape, stores the bytes as a
content-addressed `.patch` artifact (`output: "handoff"`), and records
`task-execution-handoff-imported` before it persists release intent. Import
failure leaves the task `cleanup-blocked` at stage `handoff-import` until
reconciliation, except a handoff above the bound: that refusal is permanent,
so the task fails at stage `handoff-import` with "Workflow handoff exceeds the
import bound." and the child is left unreleased for the operator. A completed
child that captured no handoff completes under `"optional"` and fails after
release under `"required"`. The handle's
`handoff` may be named in a later task's `inputs` (the child receives the
descriptor, not patch bytes) or returned as the workflow output;
`WorkflowService.exportHandoff(runId, taskId)` returns the descriptor and the
verified bytes. The workflow never applies, pushes, merges, or checks out a
handoff. The root exports are `WorkflowHandoffDescriptorSchema`,
`HandoffPolicySchema`, `AgentWorkspaceRequestSchema`,
`SubagentHandoffEvidenceSchema`, `MAX_WORKFLOW_HANDOFF_BYTES`,
`WORKFLOW_HANDOFF_FORMAT_SHA256`, and `isHandoffHandle`;
`deriveSubagentSettlementEvidence` and `deriveWorkflowHandoffDescriptor` are
exported from `@vegardx/pi-workflow/runtime`; see
[Contracts](docs/contracts.md#worktree-tasks-and-handoffs).

## Checkpoints

A checkpoint is a human decision the run parks on:

```ts
const plan = ctx.agent("plan", { /* read-only request */ });
const approve = ctx.checkpoint("approve", {
	schema: Type.Object({ proceed: Type.Boolean() }, { additionalProperties: false }),
	prompt: "Approve the plan before the writer runs?",
	headless: "block",
	timeoutMs: 3_600_000,
	inputs: { plan: plan.output },
});
const decision = await ctx.result(approve); // parks here until decided
```

`ctx.checkpoint(key, { schema, prompt, default?, headless, timeoutMs?,
disposition?, after?, inputs?, replay? })` lowers to a `kind: "checkpoint"`
task that holds no concurrency lane and reserves no budget. When a lane has
nothing else to do and a checkpoint awaits a decision, the run moves
`running -> waiting` and the drive parks: `service.wait` returns the
non-terminal `waiting` view at once with `parked: true` and
`pendingCheckpoints`, and `availableActions` includes `decide`.
`service.decide(runId, taskId, { decision, approver, reason? })` validates the
value against the request schema, writes one immutable decision record under
the run's `decisions/` directory (bound to run, task, execution, and the exact
input artifacts the approver saw), stores the value as the task's JSON result
artifact, completes the task with "Checkpoint decided.", and restarts the
drive; a decision is never asked twice for one execution, and a second
decision for the same binding is refused. `timeoutMs` is relative to the
request and capped by the run deadline: an expired `headless: "block"`
checkpoint fails at stage `checkpoint-expired`, an expired
`headless: "use-explicit-default"` checkpoint records its validated `default`,
and `createWorkflowService({ checkpoints: { headless: true } })` decides
`use-explicit-default` checkpoints immediately without parking. A run never
reaches `failed`, `interrupted`, or `cleanup-blocked` with an open checkpoint:
`stop`, the deadline, and every failure path cancel it first
("Workflow run ended before the checkpoint was decided."). A checkpoint can
never be a finalizer. The root exports are `CheckpointTaskSpecSchema`,
`CheckpointTaskRequestSchema`, `CheckpointTerminalEvidenceSchema`,
`WorkflowDecisionRecordSchema`, `WorkflowDecideOptionsSchema`, and
`deriveDecisionRecordSha256`; `createWorkflowCheckpointTaskExecutor`,
`CHECKPOINT_RUN_ENDING_REASON`, `WorkflowDecisionRecordStore`,
`deriveCheckpointEffectSha256`, and `isStaticWorkflowParked` are exported
from `@vegardx/pi-workflow/runtime`; see
[Contracts](docs/contracts.md#checkpoints) and
[Persistence and recovery](docs/persistence.md#decision-records).

## Dynamic workflows

A dynamic workflow is the same `defineWorkflow` source a static definition
would hold, proposed as text instead of discovered from a file, and executed
in a worker-thread VM only after a human approved it:

```text
model or embedder            human                             runtime
workflow_propose(source)  →  /workflow approve dynamic:<sha>  →  workflow_run("dynamic:<sha>", input)
service.propose              service.decideSource                service.run / service.validate
```

`service.propose(source, { proposer })` requires Pi project trust, applies
the static import gate (`@vegardx/pi-workflow`, `typebox`, and registered
support module specifiers only) plus two dynamic-only rules (no
`import.meta`; exactly one default export and no named exports), extracts
the manifest (`meta`, `inputSchema`, `outputSchema`) in a manifest-only VM,
and stores the proposal under `<cwd>/.pi/workflow/dynamic/<sha256>/` keyed by
the SHA-256 of the source bytes. Proposals are derived data: re-proposing the
same bytes returns the existing proposal. Approval is human-only, through a
Pi command with an explicit `ctx.ui.confirm`, never through a model-callable
tool; `service.decideSource(ref, { decision, approver, reason? })` writes one
immutable definition-level decision record (`source-approval` binding) whose
identity covers the source digest, the manifest, `hostApiSha256` (the VM
host API, the `amaro` 1.2.0 transformer, and every bound), and
`importPolicySha256` (the registered support helpers). A rejection is as
final as an approval; only a changed source (a new digest) can be approved,
and a package upgrade that changes `hostApiSha256` requires a fresh approval
of the same source. `service.run("dynamic:<sha>", input)` copies the source,
manifest, proposal, and approval record into the run's `definition/`
directory before the run record exists, records `definitionKind: "dynamic"`
with `approvalSha256` and `hostApiSha256`, and resumes only from that copy.

Every drive boots a fresh worker (one VM per drive): declarations are
synchronous RPC calls served by the ordinary static-runtime context, barriers
are asynchronous replies, and restart, park at a checkpoint, and invalidation
recovery all re-execute the source from entry in a new VM. The VM patches
`Date`, `Math.random`, and `console`, disables `eval`/`new Function`/wasm,
seals its global, and exposes no `process`, `require`, `fetch`, timers, or
`import()`; these are determinism aids, and the worker-thread VM is a
determinism and API boundary, not an OS security boundary. A VM failure ends
the run `failed` with an exact reason (for example
"Dynamic workflow VM exceeded its memory limit."); a source that throws
appends "Dynamic workflow source execution failed: <name>: <message>". A
dynamic run is always a root run: it may declare nested static children, but
a dynamic definition is never a nested child, and `service.list()` stays
static-only (`service.proposals()` lists proposals). The root exports are
`DynamicWorkflowProposalRecordSchema`, `DynamicWorkflowProposalViewSchema`,
`SourceApprovalDecisionBindingSchema`, and the intake, approval, reference,
transformer, and watchdog constants (`DYNAMIC_REF_PREFIX`,
`DYNAMIC_REF_PATTERN`, `DYNAMIC_HOST_API_REVISION`, `DYNAMIC_TRANSFORMER`,
`DYNAMIC_TRANSFORMER_VERSION`, `DYNAMIC_BUILTIN_MODULES`,
`DYNAMIC_VM_BOOT_TIMEOUT_MS`, `DYNAMIC_VM_COMPUTE_TIMEOUT_MS`,
`DYNAMIC_VM_MANIFEST_TIMEOUT_MS`, `MAX_DYNAMIC_SOURCE_BYTES`,
`MAX_DYNAMIC_MANIFEST_BYTES`, `MAX_DYNAMIC_PROPOSALS`,
`MAX_DYNAMIC_PROPOSAL_RECORD_BYTES`, `MAX_DYNAMIC_APPROVAL_RENDER_BYTES`);
`createDynamicWorkflowDefinition`, `createDynamicDiscoveredWorkflow`,
`extractDynamicWorkflowManifest`, `deriveDynamicHostApiSha256`,
`deriveDynamicImportPolicySha256`, `deriveDynamicDefinitionIdentitySha256`,
`DynamicWorkflowExecutionError`, and the VM and RPC bounds are exported from
`@vegardx/pi-workflow/runtime`; see
[Contracts](docs/contracts.md#dynamic-workflows),
[Persistence and recovery](docs/persistence.md#dynamic-proposals-and-run-definition-copies),
and [Authority model](docs/authority.md#dynamic-workflow-host-api).

## Invalidation and re-execution

A durably `failed` or `interrupted` run can be re-driven from a chosen task
with `service.invalidate(runId, causeTaskId, reason)`. One `task-invalidated`
event records the cause, its exact transitive dependents, and the epochs
abandoned after the barrier that exposed them; the restarted drive replays the
on-path prefix exactly, re-materializes the invalidated tasks, and executes
each as a new task-execution generation with a fresh preflight, operation ID,
and subagent or child run. Abandoned declarations stay as history and are never
scheduled, a later declaration may readopt an abandoned key with an unchanged
request, result artifacts bind to the execution that produced them, and every
generation's settled usage counts against the budget. The root export is
`MAX_TASK_EXECUTION_GENERATIONS`; `invalidationClosure` is exported from
`@vegardx/pi-workflow/runtime`; the run view
lists every task with its generation and abandoned marker, and there is no Pi
tool for invalidation yet; see
[Contracts](docs/contracts.md#durable-effect-interpretation).

## Development

Until `@vegardx/pi-subagent` is published, development resolves it from the
sibling `../pi-subagent` checkout. CI checks out the exact qualified commit and
builds it before running:

```text
npm run check
```

## License

MIT
