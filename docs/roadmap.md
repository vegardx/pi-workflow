# Roadmap

## Phase 0 — implementation-ready contracts

- TypeScript handle authoring API;
- declarative materialized task records;
- complete versus incremental DAG semantics;
- workflow/run/task/execution identity;
- shared pi-subagent service-provider boundary;
- authority and project trust;
- run/task state machines;
- journal, lease, fencing, replay, and failure contracts;
- first-slice acceptance inventory.

## Phase 1 — durable static vertical slice

The first executable workflow is durable. Unit development uses a fake
`SubagentService`; packed acceptance uses the provider exported by a compatible
pi-subagent release.

- package, build, lint, test, and pack scaffolding;
- public schemas and versioned runtime contract;
- trusted TypeScript definition and schema discovery;
- deterministic definition and input identity;
- append-only run journal and snapshot reducer;
- single-writer lease and fencing generation;
- one stable-keyed read-only structured-output agent task;
- task handle, materialization, and explicit result barrier;
- shared service acquisition and exact compatibility check;
- owner binding, preflight, persisted launch intent, and idempotent launch;
- status, wait, stop, and reconciliation;
- workflow-owned artifact import and required subagent release;
- process-restart recovery and effect replay;
- packed local macOS Apple Silicon qualification.

## Phase 2 — static orchestration

Delivered:

- workflow-owned artifact projection between sequential read-only tasks;
- complete DAG materialization through handles;
- parallel and settled result barriers;
- bounded fan-out and fan-in;
- pipeline authoring helpers;
- phases and structured progress events;
- run/task concurrency, token, cost, and time budgets;
- deterministic bundle-contained support tasks: typed descriptor frontend,
  constructor registry, durable intent, in-process execution, artifact commit,
  crash-prefix recovery, and stop/deadline abort (runtime contract feature
  `supportTaskExecution: true`);
- nested static workflows with bounded depth: `ctx.workflow` declarations
  lowered into `kind: "workflow"` tasks, linked child runs with their own
  journal, lease, store, and owner binding, budget reservation and deadline
  capping from the parent, verified output import, stop/deadline cascades,
  restart resume, and reconciliation (runtime contract feature
  `nestedWorkflows: true`, depth 0 through 3, at most 64 workflow tasks per
  run, recursion rejected);
- artifact inputs into nested children: `ctx.workflow` accepts `inputs` from
  agent, support, and nested producers, values are read through the verified
  input path at launch and merged into the authored input, the merged input is
  validated against the child schema and bound, and intent carries the
  artifact digest map and merged-input digest (runtime contract feature
  `nestedArtifactInputs: true`);
- cross-run artifact references as provenance: the child run record and view
  carry `parent.inputArtifacts` identifying the exact parent artifacts merged
  into its input, re-verified on resume; these are provenance records, not a
  read path, and no live cross-run artifact read exists;
- worktree agent tasks with workflow-owned handoff artifacts: `workspace:
  { mode: "worktree", cwd }` requests with a workflow-only `handoff` policy,
  pi-subagent contract revision 6 `exportHandoff` imported as a
  digest-verified `git format-patch` artifact before release, `ctx.handoff`,
  handoff descriptors as downstream inputs, and
  `WorkflowService.exportHandoff` (runtime contract feature `worktrees: true`,
  contract revision 17).

## Phase 3 — durable control

Delivered:

- retry and resume attempts under one execution: declarative `retry` and
  `resume` policies on agent requests, durable attempt intent, receipt, and
  decline events, backoff waited under the stop signal and deadline, settled
  usage summed across attempts (runtime contract features
  `retryAttempts: true` and `resumeAttempts: true`, contract revision 14);
- interrupted-child resume through the `resume` policy;
- task-execution generations 2 and later: contiguous generations bounded by
  `MAX_TASK_EXECUTION_GENERATIONS = 16`, each with fresh derived execution,
  operation, and child run identities, result artifacts bound to their
  producing execution, and settled usage summed across generations (runtime
  contract feature `executionGenerations: true`, contract revision 15);
- replay identity and transactional invalidation: `invalidationClosure`, the
  exact-closure and exact-abandoned-epoch `task-invalidated` event, abandoned
  history, exact on-path prefix replay with a divergent suffix and readoption,
  and the service `invalidate` trigger on settled failed or interrupted runs
  (runtime contract feature `transactionalInvalidation: true`, contract
  revision 15);
- required and advisory finalizers: `ctx.finalize` declarations lowered into
  `role: "finalizer"` agent, support, or nested workflow tasks, driven only
  while the run is `finalizing` after the output commit, never barrier
  targets, with required failure blocking success and advisory failure
  degrading it (runtime contract feature `finalizers: true`, contract
  revision 16);
- interrupted children retained without release: an `interrupted` settlement
  with no admissible resume terminalizes the execution directly, and the
  reducer admits operator `resume` intents (`origin: "operator"`) that reopen
  such an execution (runtime contract feature `operatorAttempts: true`,
  contract revision 16).

Remaining:

- operator-triggered retry and resume surface over the service (the reducer
  admits operator resume intents since revision 16; no service method or
  tool appends them yet);
- checkpoints and immutable decisions;
- richer logs and reconciliation controls;
- retention and pin coordination.

## Phase 4 — product surface

Delivered:

- tool declaration table with output schemas: `WORKFLOW_TOOL_DECLARATIONS`
  binds the seven existing tools to typed service results, the extension
  registers from it, and every declared output schema is validated against a
  real service result;
- workflow authoring skill shipped under `skills/` and declared through
  `pi.skills`, with loader-tested examples;
- compatibility matrix (`compatibility.json`, `docs/compatibility.md`) checked
  against the manifest, the contract constants, CI, and the packed
  pi-subagent contract.

Remaining:

- persistent widget and inspector;
- complete workflow command/tool surface, including operator-triggered retry
  and invalidate tools over the service;
- a handoff export tool over `WorkflowService.exportHandoff` that writes the
  handoff bytes to a caller path; deferred because a tool result of up to
  16 MiB returned to a model is wrong and writing caller paths needs its own
  authority text;
- first stable static-workflow API.

## Phase 5 — dynamic workflows

- worker-thread VM and bounded RPC host API;
- shared TaskSpec materializer, including dynamic `ctx.support` declarations
  that lower into the same `SupportTaskSpec` and constructor registry;
- generated-source review and approval;
- stable key, dependency, and budget enforcement;
- incremental graph materialization from concrete results;
- fresh-VM recovery through source re-execution and effect replay.

## Non-goals

- private or fallback subagent runtime;
- publication, push, pull-request, merge, release, or deployment policy;
- generated web wrappers or web-source caching;
- schedules;
- unbounded recursive workflows;
- arbitrary dynamic imports;
- distributed or cross-machine workers;
- worker-thread VM security-boundary claims;
- multiple public authoring frontends in the initial release.
