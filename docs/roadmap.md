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
  contract revision 16);
- checkpoints and immutable decisions: `ctx.checkpoint` declarations lowered
  into `kind: "checkpoint"` tasks that hold no lane and no budget, a parked
  `waiting` drive that `wait` returns at once with `parked: true` and
  `pendingCheckpoints`, relative `timeoutMs` capped by the run deadline with
  `block` and `use-explicit-default` expiry policies, the service
  `checkpoints.headless` option, `WorkflowService.decide` with the `decide`
  action, a run-scoped immutable binding-addressed decision record store
  (`decisions/`) whose records the journal converges on, and fail-closed run
  failure while a checkpoint is open (runtime contract feature
  `checkpoints: true`, contract revision 18, checkpoints half; the revision
  is shared with the dynamic-workflows half);
- operator-triggered retry and resume over the service: `retry(runId,
  taskId, reason)` as invalidation restricted to a failed or interrupted
  cause task, and `resume(runId, reason, { taskId })` appending the operator
  `resume` intent the reducer admits since revision 16 and re-attempting the
  interrupted child on its existing subagent run, both exposed as
  `workflow_retry` and `workflow_resume` and advertised through
  `availableActions`.

Remaining:

- richer logs and reconciliation controls;
- retention and pin coordination.

## Phase 4 — product surface

Delivered:

- tool declaration table with output schemas: `WORKFLOW_TOOL_DECLARATIONS`
  binds all fourteen tools (including `workflow_propose`) to typed service
  results, the extension registers from it, every declared output schema is
  validated against a real service result, and each entry carries its
  one-line call and result rendering;
- complete workflow command surface: the unified `/workflow` command, the
  `pi-workflow` widget below the editor, and the `alt+w` inspector as
  projections of the service read surface (`availableActions`,
  `requiresAttention`, ownership), with the read tools `workflow_runs`,
  `workflow_inspect`, `workflow_logs`, the operator tools
  `workflow_invalidate`, `workflow_retry`, `workflow_resume`, and the
  proposal tool `workflow_propose`;
- workflow authoring skill shipped under `skills/` and declared through
  `pi.skills`, with loader-tested examples;
- workflow operating skill (`skills/workflows/`) shipped alongside it,
  describing the tool table, the `/workflow` surface, and the recovery
  legality rules, pinned bidirectionally to the runtime by
  `test/skill-operating.test.ts`;
- compatibility matrix (`compatibility.json`, `docs/compatibility.md`) checked
  against the manifest, the contract constants, CI, and the packed
  pi-subagent contract;
- 1.0.0 API freeze: root entry frozen (authoring, service, contract layer,
  extension entry), engine moved to `@vegardx/pi-workflow/runtime`
  (unfrozen), `./package.json` exported, export lists pinned by test and pack
  check (`test/fixtures/public-api/`), semver and contract-revision rule in
  `docs/contracts.md` "Public API and stability", `CHANGELOG.md`, and the
  manual qualification note (`docs/qualification.md`);
- the human-only `/workflow decide <run-prefix> <task-key> <json>
  [reason…]` command over `WorkflowService.decide` (interactive session and
  explicit confirm required; approver: the Pi session identity, never an
  argument); there is no model-callable decide tool, by design;
- the human-only `/workflow approve dynamic:<sha256> [reason…]` and
  `/workflow reject dynamic:<sha256> [reason…]` commands over
  `WorkflowService.decideSource` (interactive session, rendered proposal,
  explicit `ctx.ui.confirm`, approver `{ kind: "human", via, sessionId? }`);
  there is no model-callable approve, reject, or proposals tool, by design.

Remaining after 1.0 (additive under the freeze: each is a minor version
unless it changes a frozen shape):

- a handoff export tool over `WorkflowService.exportHandoff` that writes the
  handoff bytes to a caller path; deferred because a tool result of up to
  16 MiB returned to a model is wrong and writing caller paths needs its own
  authority text;
- a by-hand host run of worktree agent tasks with handoff import and of the
  other paths `docs/qualification.md` lists as unit-tested only for 1.0.0;
- a decision path for a checkpoint inside a nested child run (`decide`
  refuses nested runs today; see `docs/qualification.md`);
- the Phase 3 remainder above (richer logs and reconciliation controls,
  retention and pin coordination).

## Phase 5 — dynamic workflows

Delivered (revision 18, dynamic-workflows half; runtime contract feature
`dynamicWorkflows: true`, sharing the revision with the checkpoints half,
whose generic decision record store holds the source approvals):

- worker-thread VM and bounded RPC host API: one worker per drive, full
  TypeScript through the pinned `amaro` 1.2.0 transformer, synchronous
  declarations over an `Atomics.wait` bridge, asynchronous barriers, message,
  size, compute, memory, and boot bounds, abort mirroring, and exact failure
  reasons;
- shared TaskSpec materializer: the VM exposes `WorkflowContext` verbatim and
  every declaration, including dynamic `ctx.support` declarations from helpers
  published with `exportName`, lowers into the same task specs, constructor
  registry, scheduler, and executors as static source;
- generated-source review and approval: `service.propose` /
  `workflow_propose` (proposal only), the digest-keyed proposal store with a
  manifest-only VM, `service.decideSource` writing an immutable
  `source-approval` decision record, and `run`/`validate` accepting
  `dynamic:<sha256>` only for an approved proposal;
- human approval bound to source and host-API identity: the binding covers the
  source digest, manifest, `hostApiSha256`, and `importPolicySha256`, so a
  changed source, package upgrade, or support registry refuses to run or
  resume until a human approves again, and a rejection is final;
- stable key, dependency, and budget enforcement through the unchanged host
  materializer and scheduler;
- incremental graph materialization from concrete results across async
  barriers;
- fresh-VM recovery through source re-execution and effect replay on every
  restart, checkpoint park, and invalidation recovery, verified from the run
  directory's `definition/` copy alone.

Remaining:

- none beyond Phase 4; the `/workflow approve|reject` Pi commands are
  delivered there, embedders without Pi call `service.decideSource` directly,
  and no model surface can approve.

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
