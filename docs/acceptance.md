# Acceptance inventory

These are required behavioral checks, not claims of implemented behavior.

## First durable vertical slice

The first executable release must prove:

- one trusted static TypeScript workflow is discovered with deterministic
  provenance and project trust;
- input and output schemas are enforced;
- task declaration returns an opaque non-thenable handle;
- one sequential read-only structured-output agent task materializes as a
  persisted graph node before launch;
- the extension acquires the exact service registered by pi-subagent and fails
  before run creation for missing, duplicate, or incompatible providers;
- subagent preflight identity and launch intent are durable before launch;
- uncertain launch recovery uses `findByOperation` and never duplicates a child;
- status and wait derive from the journal rather than in-memory promises;
- stop persists intent, interrupts the child, and drains terminal evidence;
- process restart reconstructs state, reconciles the child, re-executes the
  workflow, and replays the matching effect;
- lease fencing rejects stale scheduler writes;
- required artifact import and child release settle before workflow success;
- torn journal tail and interior corruption follow the documented fail-closed
  behavior;
- packed pi-workflow integrates with a packed compatible pi-subagent.

An in-memory-only successful drive does not satisfy the first slice.

## Definition and discovery

- uses `getAgentDir()` and project trust correctly;
- package roots register through the workflow service;
- precedence and name collisions are deterministic;
- malformed or changed definitions fail with stable diagnostics;
- static module, helper, input schema, and output schema identities are recorded;
- workflow source change refuses version-1 resume.

## Materialization

- handles cannot be awaited accidentally or used across runs;
- stable keys are unique within explicit namespaces;
- declarations are committed before scheduling;
- order and data dependencies remain distinct;
- foreign, missing, ambiguous, duplicate, and cyclic dependencies fail closed;
- complete handle graphs materialize before execution when no result barrier is
  encountered;
- result-dependent branches materialize incrementally after validated results;
- restart re-executes from entry and reuses matching declarations;
- insertion, removal, or reordering inside a valid materialization-epoch prefix
  fails, while a new suffix and a branch after transactional invalidation are
  handled as documented;
- abandoned effects never reappear as active results;
- nested workflow, pipeline, and fan-out namespaces are collision-free.

## Subagent boundary

- standalone pi-subagent use remains lazy and does not require pi-workflow;
- service acquisition returns the same instance used by the subagent extension;
- workflow never constructs or shuts down `SubagentService`;
- exact runtime contract and required features are checked before run creation;
- owner binding is fixed by workflow run identity, not model input;
- preflight grant is persisted before idempotent launch;
- crash after child launch is recovered by operation ID without duplication;
- every subagent terminal and cleanup outcome maps to a workflow task outcome;
- imported artifacts are digest-verified and retention-safe;
- worktree requests fail before launch until a compatible public handoff-export
  capability exists; private paths or branch names are never used as imports.

## Scheduling and control

- sequential, parallel, settled-parallel, pipeline, and bounded fan-out preserve
  stable results and limits;
- fatal cancellation cancels siblings and drains to terminal evidence;
- checkpoint waits can be stopped and resumed;
- child retry and resume record fresh attempts under the existing workflow task
  execution, while explicit invalidation creates a new execution generation,
  preflight, operation ID, and child run;
- run/task budgets survive restart and retry;
- optional task disposition is persisted and identity-bound; optional task or
  advisory-finalizer failure is eligible for `completed-degraded` only after all
  required work succeeds;
- no work begins from an uncommitted declaration or stale fencing generation.

## Structured output and support tasks

- every initial agent task uses a terminating output schema;
- invalid or replayed structured values are rejected;
- support helpers are bundle-contained, trust-gated, and schema-validated;
- required artifact inputs are verified before execution;
- model prose is never parsed as control-plane JSON.

## Persistence and recovery

- torn tail, corrupt snapshot, future version, lease loss, and stale running task
  fail closed;
- fencing rejects stale workflow state writes and workflow-owned effects;
- lease reclamation refuses a replacement owner while prior process evidence is
  still live, and stable subagent operation IDs prevent duplicate launch after
  uncertain outcomes;
- dependency invalidation is crash-safe and transitive;
- source or runtime drift cannot reinterpret prior human or model decisions;
- required finalizer failure prevents success;
- bounded private stores redact sensitive metadata.

## Dynamic workflows

Later dynamic acceptance must prove:

- dynamic and static frontends materialize identical task-record contracts;
- dynamic code receives only the bounded RPC host API;
- source and host-API identity bind every replay;
- result-dependent branching resumes by fresh-VM re-execution and effect replay;
- filesystem, environment, process, module, credential, store, scheduler, and
  service objects are absent from the dynamic API;
- documentation does not claim the worker-thread VM is an OS security boundary.

## Product and distribution

- widget and inspector are projections and recover after reload;
- workflow list, validate, run, status, logs, wait, stop, retry, resume, and
  reconcile work in a fresh `PI_CODING_AGENT_DIR` as their phases ship;
- package contents contain compiled ESM, declarations, license, and bounded docs;
- Ubuntu CI is portability evidence; supported macOS Apple Silicon runtime
  qualification is driven locally;
- publication, push, pull request, merge, release, and deployment authority are
  absent from the package.
