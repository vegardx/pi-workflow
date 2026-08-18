# Acceptance inventory

## Definition and discovery

- uses `getAgentDir()` and project trust correctly;
- package roots register through the service;
- precedence and name collisions are deterministic;
- malformed or changed definitions fail with stable diagnostics;
- static module identity and helper provenance are recorded.

## Effect runtime

- restart re-executes from entry and replays matching stable-keyed effects;
- inserted, removed, reordered, duplicated, and changed keys follow documented
  compatibility rules;
- abandoned effects never reappear as active results;
- nondeterministic/replay-off effects execute live;
- nested workflow and pipeline task namespaces are collision-free.

## Subagent boundary

- required service features are checked before run start;
- preflight grant is persisted before idempotent launch;
- crash after child launch is recovered by operation ID without duplication;
- every subagent terminal/cleanup outcome maps to a workflow task outcome;
- imported artifacts are digest-verified and retention-safe.

## Scheduling and control

- sequential, parallel, settled-parallel, pipeline, and bounded fan-out preserve
  stable results and limits;
- fatal cancellation cancels siblings and drains to terminal evidence;
- checkpoint waits can be stopped and resumed;
- retry/resume create explicit task execution generations;
- run/task budgets survive restart and retry.

## Structured output and support tasks

- schema tool is terminating and repair is bounded;
- invalid/replayed structured values are rejected;
- support helpers are bundle-contained, trust-gated, and schema-validated;
- required artifact inputs are verified before execution.

## Persistence and recovery

- torn tail, corrupt snapshot, future version, lease loss, and stale running task
  fail closed;
- fencing rejects stale scheduler writes;
- dependency invalidation is crash-safe and transitive;
- required finalizer failure prevents success;
- bounded private stores redact sensitive metadata.

## Product and distribution

- widget/inspector are projections and recover after reload;
- packed package integrates with a packed compatible pi-subagent;
- workflow list/run/status/logs/wait/stop/retry/resume work in a fresh
  `PI_CODING_AGENT_DIR`;
- user-defined workflow can use explicitly granted normal web tools without
  ambient distro extensions.
