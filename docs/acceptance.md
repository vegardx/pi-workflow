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

- `results()` preserves fail-fast typed tuples, while the distinct persisted
  `settled()` barrier returns declaration-ordered fulfilled values or bounded
  rejected task identity, outcome, and failure evidence;
- sequential, parallel, settled-parallel, pipeline, and bounded fan-out preserve
  stable results and limits;
- partial parallel launch failure preserves and settles every already-launched
  sibling before the source runtime propagates the batch failure;
- fatal cancellation and explicit stop drain every concurrently active child to
  terminal settlement and release evidence without duplicate interruption;
- an interrupt failure leaves the run durably `stopping`, preserves sibling
  evidence, and permits explicit stop retry without inventing cancellation;
- checkpoint waits can be stopped and resumed;
- child retry and resume record fresh attempts under the existing workflow task
  execution, while explicit invalidation creates a new execution generation,
  preflight, operation ID, and child run;
- declared and effective workflow budgets plus the absolute deadline survive
  restart;
- task admission reserves declared maxima against settled usage and active
  reservations before launch;
- incomplete usage stops further spending, post-settlement overage fails the
  run, and deadline expiry uses normal stop/drain semantics;
- optional task disposition is persisted and identity-bound; optional task or
  advisory-finalizer failure is eligible for `completed-degraded` only after all
  required work succeeds;
- a `running` support task occupies one concurrency lane and reserves no cost,
  tokens, or child runtime;
- stop and deadline abort the scheduler stop signal, terminalize a running
  support task as `cancelled` at stage `stop` after a bounded executor drain
  that never waits for an implementation that ignores abort, reach a durable
  terminal run status before returning, and cancel a `running` support task
  found after restart directly; subagent cleanup and `cleanup-blocked` semantics are
  unchanged;
- no work begins from an uncommitted declaration or stale fencing generation.

## Structured output and support tasks

- every initial agent task uses a terminating output schema;
- invalid or replayed structured values are rejected;
- support helpers are bundle-contained, trust-gated, and schema-validated;
- required artifact inputs are resolved only from the workflow-owned store,
  revalidated against producer provenance, digest, canonical encoding, and
  output schema, and projected as deterministic bounded untrusted context before
  subagent preflight;
- model prose is never parsed as control-plane JSON.

### Durable support execution

- a support-only workflow completes without any subagent acquisition,
  preflight, launch, or model call;
- support tasks chain in every direction: agent → support, support → agent,
  and support → support inputs resolve only from digest-verified workflow-owned
  artifacts;
- the journal records the support execution record, support intent, result
  artifact declaration, output commit, and support terminal evidence in order
  before `running → completed`;
- every crash prefix (record only, intent only, orphan blob, declared artifact,
  committed output, terminal-only) replays to the same completed result, and
  the implementation never runs again once output evidence exists;
- a registry whose name, module specifier, revision, implementation digest,
  parameters schema, or output schema differs from the persisted descriptor
  fails a non-terminal support task at `support-resolution`, while a completed
  support task still replays from its artifact;
- an unregistered module specifier is rejected at workflow discovery;
- an implementation that throws, returns non-JSON, oversized, or schema-invalid
  output, or conflicts with existing output evidence fails with a fixed message
  and no raw error text;
- stop and deadline abort a running support implementation, discard its late
  result, and terminalize it as `cancelled` at stage `stop`;
- optional support task failure yields `completed-degraded` only after all
  required work succeeds, and required support task failure fails the run;
- a run without a configured executor blocks support tasks with a fixed message
  and fails when the task is required;
- `durationMs` is diagnostic only and never affects budgets or identity.

## Persistence and recovery

- torn tail, corrupt snapshot, future version, lease loss, and stale running task
  fail closed;
- fencing rejects stale workflow state writes and workflow-owned effects;
- lease reclamation refuses a replacement owner while prior process evidence is
  still live, and stable subagent operation IDs prevent duplicate launch after
  uncertain outcomes;
- after lease rotation, every concurrently active child is reacquired from its
  durable launch receipt without another preflight or launch;
- dependency invalidation is crash-safe and transitive;
- support execution recovery follows the documented crash-prefix ladder, output
  conflict fails closed, and persistence uncertainty is thrown rather than
  converted into task failure;
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
