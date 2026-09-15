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
- insertion, removal, or reordering inside the on-path materialization-epoch
  prefix fails, while a new suffix after the last on-path barrier is admitted;
- after an invalidation the on-path prefix replays exactly, an invalidated path
  task is re-materialized `invalidated → pending` when its epoch's barrier is
  matched, and a divergent suffix is numbered from the current epoch with
  materialization sequence `max + 1`;
- a declaration beyond the prefix readopts an abandoned task with the same
  `(namespace, key)` and identity digest under its original task ID with fresh
  position fields, the same key with a changed identity fails with "abandoned
  task key re-declared with a changed request", and a path task's key remains
  a duplicate;
- abandoned declarations, barriers, and effects never reappear as active
  results, are never scheduled, and never count as unsettled or required work;
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
  execution (see [Retry and resume attempts](#retry-and-resume-attempts)),
  while explicit invalidation creates a new execution generation with a fresh
  preflight, operation ID, and subagent or child run (see
  [Invalidation and re-execution](#invalidation-and-re-execution));
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

## Retry and resume attempts

- a `failed` child classified `backoff` under a `retry` policy is retried
  through the owner client's `retry` on the same child run, the fresh attempt
  is recorded under the same execution, and a completed retry
  imports its result and completes the task;
- a policy is exhausted after `attempts` receipted attempts of its kind: the
  next settlement of that kind proceeds to release and its terminal outcome
  without another intent;
- a `manual` classification is retried only when `retry.on` lists it; the
  default policy retries `backoff` alone, `never` and `reconcile` are never
  attempted, and an `interrupted` child is resumed only under a `resume`
  policy when its failure is classified `resume`;
- the materializer normalizes and sorts `retry.on`, binds the policies into
  task identity, and rejects `retry.attempts` above `limits.retries` and
  `resume.attempts` above `limits.resumes` with the fixed messages;
- a `RetryBackoffError` is waited out until `retryAt` and the call repeated;
  a `retryAt` at or after the workflow deadline, or a deadline reached before
  the call, declines the intent with the fixed deadline or stop message;
- stop during backoff declines the open intent with the fixed stop message,
  and stop with an open intent declines it before finalization;
- restart after a durable intent repeats the attempt call for that intent, a
  refusal is reconciled through `findByOperation` (a new attempt ID is
  adopted, otherwise the intent is declined), and no second intent is written;
- the reducer enforces ordinal contiguity, the previous attempt ID, the
  classification and policy binding, the per-kind count, no intent while the
  run is `stopping`, receipt clearing the observation and moving the
  settlement to `priorSettlements`, and a decline closing attempts;
- `task-execution-child-settled` carries `attemptOrdinal` equal to one plus
  the receipted attempts, and terminal evidence names the final attempt;
- settled cost, tokens, and runtime are summed across every attempt of an
  execution for admission and the post-settlement overage check, and an
  incomplete settlement in any attempt fails closed;
- the finalizer and scheduler verify, release, and reconcile the current
  attempt (`currentSubagentAttemptId`), not the launch receipt's attempt;
- the runtime contract publishes `retryAttempts: true` and
  `resumeAttempts: true`, and no operator retry surface exists.

## Invalidation and re-execution

- `task-invalidated` carries the exact closure (the cause plus its transitive
  dependents through `after` and `inputs`, abandoned tasks included, minus
  tasks already `invalidated`) and the exact abandoned epochs (every on-path
  epoch after the first on-path barrier exposing the closure); the reducer
  recomputes both with `invalidationClosure` and rejects any other set, an
  unknown cause, or a cause already `invalidated`;
- invalidation is refused while any current execution is non-terminal or while
  the run status is outside `running`, `waiting`, `failed`, and `interrupted`;
- abandoned barriers, tasks, and effects are marked in the projection, keep
  their epoch numbers and sequences, are never scheduled, never counted as
  unsettled or required work, never satisfy or block path dependencies, may
  not execute or change status, and still count their settled usage against
  the budget;
- a `failed` or `interrupted` run moves to `running` only while an on-path
  task is `invalidated`, and re-materialization `invalidated → pending`
  requires the task's current execution to be absent or terminal and detaches
  it;
- generation 2 is rejected while generation 1 is active and admitted after a
  terminal execution plus invalidation; it receives a fresh preflight,
  operation ID, and subagent run or child run, generations are contiguous and
  bounded by `MAX_TASK_EXECUTION_GENERATIONS`, an abandoned task never
  executes, and the prior execution's evidence and artifacts are retained;
- a result artifact binds its producing execution, completion and every
  downstream read select the current execution's artifact, and identical bytes
  from two generations share one blob under distinct references;
- settled usage of every generation counts against the run budget;
- the service `invalidate` call validates the run ID, task ID, and reason,
  rejects a run that is still being driven (`conflict`), not durably
  `failed` or `interrupted`, a nested child run, a run already awaiting
  recovery, or a run past its deadline (`validation`), refuses a closure task
  at the generation bound before anything is appended, appends one
  `task-invalidated`
  event followed by the `failed|interrupted → running` recovery transition,
  restarts the drive without awaiting it, and reports every task's generation
  and abandoned marker in the run view; `wait` drives such a run after a crash
  between the two appends.

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

## Nested workflows

- a parent workflow that declares `ctx.workflow` runs the child as a linked
  child run with its own journal, lease, artifact store, owner binding
  `pi-workflow:<childRunId>`, and run record; no second scheduler class,
  private runtime, or extra subagent service is created, and a child without
  agent tasks completes without any subagent call;
- the parent journal records the workflow-kind execution record with the
  deterministic child run ID, nested intent, nested launch, nested settlement,
  result artifact declaration, nested output import, and nested terminal
  evidence in order before `running → completed`;
- the child's validated output is imported as a parent-owned result artifact,
  the parent returns it as its own output, and a later parent task may consume
  it as an ordinary named input;
- status views report `depth` for every run and
  `parent { runId, taskId, inputArtifacts }` for a child; a child run is
  addressable by its own run ID;
- admission reserves the child's declared budget against the parent's settled
  usage and active reservations, defers or blocks a child that does not fit,
  requires a `totalTokens` declaration under a parent token budget, and settles
  the reservation with the child's summed usage; incomplete child usage fails
  closed;
- the child's effective budget is capped by its declaration, the parent's
  reservation, and service caps; its deadline is the earlier of its own timeout
  and the parent's deadline; under one second remaining fails at
  `nested-launch`;
- a `running` or `cancelling` nested task occupies one parent lane;
- declaration rejects an undiscovered name, a depth-3 run declaring a workflow
  task, more than 64 workflow tasks in one run, a definition already on the
  ancestor chain, and, when no artifact inputs are declared, input that fails
  the child's input schema;
- parent stop marks the task `cancelling`, stops the child, and reaches a
  terminal parent status only after the child's terminal state; the parent
  deadline cascades the same way and the child deadline is never later;
- restart with a launched child resumes that child from its own journal and
  never launches it again; an intent without a child directory relaunches
  under the same child run ID; an existing child whose lineage, definition,
  input, or injected input artifacts differ from the intent fails at
  `nested-launch`;
- child source drift fails replay of the parent as declaration drift while a
  completed nested task still replays from its imported artifact;
- import failure yields `cleanup-blocked` at `nested-import` and parent
  reconciliation retries the import; a child that settled `cleanup-blocked` is
  reconciled through the parent and its replacement settlement drives the
  parent task to a terminal outcome;
- every terminal child status maps to the documented parent task outcome and
  a required task propagates to the parent run;
- session shutdown stops owned runs in ascending depth order so children are
  cancelled through their parents;
- a run without a configured nested run provider blocks workflow tasks with a
  fixed message and fails when the task is required.

### Artifact inputs into nested children

- a nested task declared with `inputs` accepts producers of every kind: an
  agent task, a support task, and a sibling nested workflow task each feed a
  child, the producer is recorded in `after`, and the child is not ready until
  every producer has completed;
- the child's launched input is the authored object with each verified
  artifact value merged in as a top-level key, the merged value is validated
  against the child's input schema and the 900 KiB bound at launch, and the
  child sees it as plain `ctx.input` and persists it in its own run record;
- the nested intent records `inputsSha256` equal to the canonical digest of the
  producer result artifact digests keyed by input name and
  `resolvedInputSha256` equal to the digest of the merged input; the reducer
  rejects an `inputsSha256` that disagrees with journaled artifacts and, for
  empty inputs, a `resolvedInputSha256` that differs from the authored digest;
- the child run record and its service view carry
  `parent.inputArtifacts` with `{ runId, artifactId, sha256 }` per input name;
  a record whose injected artifact names a different run or an invalid key is
  rejected, and a root record carries no lineage;
- restart between intent and launch recomputes the merged input from the same
  artifacts and relaunches exactly once with an input and `inputArtifacts`
  identical to the intent, without a second intent;
- an input that cannot be recomputed to the intended digests after intent is
  thrown as a persistence error, never converted into task failure;
- declaration rejects a non-object authored input and an authored key that
  collides with an input name when artifact inputs are declared, and defers
  child schema validation to launch; with empty inputs the authored input is
  validated at declaration;
- a missing or ambiguous producer artifact, an unverifiable input, or a merged
  input that fails the child schema or bound fails the task at `nested-input`
  with a fixed message and no intent;
- the runtime contract publishes `nestedArtifactInputs: true` and exports
  `NestedWorkflowInputArtifactsSchema`.

## Persistence and recovery

- torn tail, corrupt snapshot, future version, lease loss, and stale running task
  fail closed;
- fencing rejects stale workflow state writes and workflow-owned effects;
- lease reclamation refuses a replacement owner while prior process evidence is
  still live, and stable subagent operation IDs prevent duplicate launch after
  uncertain outcomes;
- after lease rotation, every concurrently active child is reacquired from its
  durable launch receipt without another preflight or launch;
- explicit invalidation is one durable `task-invalidated` event followed by a
  separate recovery transition, transitive, and verified exactly by the
  reducer on every replay;
- a readopted declaration persisted without its barrier is re-materialized by
  the next replay's barrier commit, so a crash inside a readoption commit
  never leaves an on-path task `invalidated`;
- support execution recovery follows the documented crash-prefix ladder, output
  conflict fails closed, and persistence uncertainty is thrown rather than
  converted into task failure;
- nested execution recovery follows the documented crash-prefix ladder, a run
  record with `depth >= 1` requires exact lineage and a root record forbids it,
  and revision-15 stores reject revision 1 through 14 records;
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
