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

- multiple sequential task declarations;
- pi-subagent handoff-export contract and workflow-owned worktree artifacts
  before enabling writer tasks;
- complete DAG materialization through handles;
- parallel and settled result barriers;
- bounded fan-out and fan-in;
- pipeline authoring helpers;
- phases and structured progress events;
- run/task concurrency, token, cost, and time budgets;
- deterministic bundle-contained support tasks;
- nested static workflows with bounded depth.

## Phase 3 — durable control

- explicit retry policies and task-execution generations;
- interrupted-child resume;
- replay identity and transitive invalidation;
- required and advisory finalizers;
- checkpoints and immutable decisions;
- richer logs and reconciliation controls;
- retention and pin coordination.

## Phase 4 — product surface

- persistent widget and inspector;
- complete workflow command/tool surface;
- workflow authoring skill;
- packed integration matrix with pi-subagent;
- first stable static-workflow API.

## Phase 5 — dynamic workflows

- worker-thread VM and bounded RPC host API;
- shared TaskSpec materializer;
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
