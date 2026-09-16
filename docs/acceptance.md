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
- a lease listener proves which run holds its port, so an unrelated run on the
  same candidate port neither refuses nor displaces it, while the same
  identity and unidentifiable occupants fail safe as unavailability;
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
- worktree requests are admitted, and a completed worktree child's handoff is
  imported through pi-subagent's public digest-verified `exportHandoff`
  before release; private paths, branches, or ref names are never used as
  imports.

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
- checkpoint waits can be stopped and resumed (see [Checkpoints](#checkpoints));
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

## Checkpoints

- `ctx.checkpoint(key, { schema, prompt, default?, headless, timeoutMs?,
  disposition?, after?, inputs?, replay? })` lowers to a `kind: "checkpoint"`
  task whose identity covers the request, role, `timeoutMs`, and `default`;
  every materializer refusal fires with its fixed message, `ctx.finalize`
  cannot declare a checkpoint, a checkpoint is admitted as a `result`,
  `settled`, and final barrier target, a finalizer may depend on one, and a
  handoff input is admitted for a worktree producer and refused otherwise;
- a selected checkpoint occupies no lane and reserves no budget; the lane
  returns `awaiting-decision` and appends `running -> waiting` with
  "Workflow run awaits a checkpoint decision."; the run parks only when every
  lane is idle or awaiting and no lane errored; a live drive with a busy lane
  keeps running and accepts a decision;
- `ctx.result`, `ctx.settled`, and the final graph park the drive as a resolved
  `{ parked: true, status: "waiting", pendingCheckpoints }` without
  `-> failed`; source that catches the park signal cannot drive further
  barriers; a source throw during a park cancels the checkpoint before
  `-> failed`;
- `expiresAt` is present iff `timeoutMs` is set, equals
  `min(now + timeoutMs, deadlineAt)`, and the reducer admits
  `expiresAt === timestamp + timeoutMs` and rejects one millisecond later; an
  operator decision at or after `expiresAt` is rejected;
- expiry under `block` fails the execution at `checkpoint-expired`, under
  `use-explicit-default` records the default decision, and is applied by the
  scheduler sweep, by the service watchdog at the earliest expiry or
  deadline, and inside `decide` ("Checkpoint has expired.");
- `checkpoints: { headless: true }` decides `use-explicit-default`
  checkpoints immediately without `waiting` and still parks `block`
  checkpoints;
- the decision record store round-trips, is idempotent for a byte-identical
  put, refuses a different record for the same binding, a non-canonical file,
  a symlink, a digest mismatch, a wrong binding, an oversized record, a record
  for another run, and a revision-17 record;
- `decide` records an operator decision under the scheduler lock, the
  journal converges on the record from every crash prefix without re-asking
  the human, `decisionSha256` equals the result artifact digest and
  `deriveJsonValueSha256(default)`, and the value is readable by dependents
  through the verified input path;
- the service refuses `decide` with the documented messages in order (invalid
  ids, options, approver, reason; nested run; run status; unknown task; not a
  checkpoint; not awaiting; deadline passed) and surfaces executor refusals
  ("Checkpoint is already decided.", schema, JSON, bound, conflict) as
  `validation`;
- `wait` on a parked run returns the `waiting` view marked `parked: true`
  with `pendingCheckpoints`, `availableActions` includes `decide`,
  `requiresAttention` is true, summaries carry `pendingCheckpointCount`, and
  `decide` restarts the drive to completion;
- a `decide` failure outside the executor's validation and decision stages
  (a stored decision record that fails verification, a reducer rejection, a
  fenced lease) surfaces as `persistence` ("Checkpoint decision could not be
  recorded.") with the cause, appends nothing, and leaves the run parked;
- idle lanes never flap the run status: with four lanes one park appends one
  `running -> waiting`, the resume after the decision appends one
  `waiting -> running`, and a re-drive whose sweep expires the checkpoint
  before any lane has work fails the run from `waiting`;
- a decision issued while the watchdog's re-drive is live is refused as
  `validation` and the re-drive ends the run on its own lease with one
  terminal (no fence, no second drive);
- a decision accepted just before `expiresAt` completes the run when the
  restarted drive sweeps after the expiry, both live and from a crash prefix
  (record, artifact, decided event) resumed past the expiry: no cancel, no
  second request;
- a crash prefix ending at the decided event whose source throws before its
  first barrier on re-drive commits the checkpoint (`task-execution-terminal`
  completed with checkpoint evidence, `waiting -> completed` "Checkpoint
  decided.") before `waiting -> failed`, and the failed run then admits
  `invalidate`;
- checkpoint decisions are human-only: `WORKFLOW_TOOL_DECLARATIONS` declares
  no decide tool (fourteen tools, the fourteenth being `workflow_propose`,
  which only proposes) and `decide` is reached only through the service and
  the operator surface;
- `stop` on a parked run cancels the checkpoint (`waiting -> cancelled`) and
  lands `cancelled`; the deadline watchdog does the same; shutdown leaves a
  parked run resumable in a later service through `wait`, `decide`, or
  `stop`; `invalidate` on a parked run is refused;
- every run failure site (support, nested, budget, launch, task finalizer,
  static runtime source and finalization failures) cancels open checkpoints
  with "Workflow run ended before the checkpoint was decided." first, the
  reducer rejects `-> failed | interrupted | cleanup-blocked` with an open
  checkpoint, a cancel that races a decision tolerates the decided execution,
  and `task-invalidated` is refused while a checkpoint is open and admitted
  after cancel;
- checkpoint task views carry the request and decision facts; artifact-backed
  views add verified `inputs` (handoffs as descriptors) and `decision.value`;
  `inspect` omits both and truncates long prompts; log entries never carry the
  value or approver;
- every `pendingCheckpoints` entry additionally carries `taskKey`, the
  `prompt` (truncated with `promptTruncated: true` on the lease-free views),
  `schemaSummary`, `instruction`, and, on artifact-backed views alone,
  `inputsSummary`, all bounded by `MAX_CHECKPOINT_RENDER_BYTES`;
- a parked run this session owns is asked in the session: one guided form per
  checkpoint execution shows the prompt, the declared inputs, and the answer
  shape, asks the decision field by field (JSON editor for shapes no field
  rendering fits), validates only through the service, records nothing on
  dismissal or a declined confirm, and records exactly one decision with the
  session approver otherwise; `/workflow decide` without `<json>` and the
  inspector's decide entry open the same form, and no prompt is opened
  without a dialog-capable UI, for a run leased elsewhere, for a nested
  child, or twice for one execution;
- a parked nested child holds its parent's lane, `decide` on a nested run is
  refused, and the `decide` action is not offered for it;
- the runtime contract publishes `checkpoints: true`; `dynamicWorkflows:
  true` is covered under [Dynamic workflows](#dynamic-workflows).

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
- an `interrupted` child without an admissible resume attempt is terminalized
  `interrupted` from its settlement without a release intent or a release
  call, the task carries the fixed retention reason, a required task moves the
  run to `interrupted` (also from `finalizing`), an optional task leaves the
  run status alone, a release intent on that settlement is rejected, and a
  stop drain counts `interrupted` tasks as settled so `stopping → cancelled`
  may retain them;
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
- the runtime contract publishes `retryAttempts: true`,
  `resumeAttempts: true`, and `operatorAttempts: true`; every attempt intent
  carries `origin`, policy intents reject a `reason`, and the reducer admits
  operator `resume` intents only against the current unreleased interrupted
  execution while the run is `running`, `waiting`, or `interrupted`, reopening
  a terminalized `interrupted` execution and admitting `interrupted → running`
  without invalidated work; the service `resume` method and the
  `workflow_resume` tool are the only surfaces that append them.

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

## Service read surface

- `listRuns` reads every run without taking a lease, reports per-directory
  problems (`invalid-directory`, `missing-record`, `invalid-record`,
  `corrupt-journal`, `invalid-projection`, `torn-tail`, `unreadable`) as at
  most 16 sorted issues plus a truncated count instead of failing (a corrupt
  owned journal and an unreadable record are issues, not errors), filters by
  status and
  depth, orders newest first, and pages through an opaque position cursor
  that rejects foreign values;
- a run leased by another live service, or whose lease port occupant cannot
  identify itself, is `leased-elsewhere` with no available actions; an owned
  run is `owned`; every other run is `inactive`;
- `availableActions` and `requiresAttention` come from the single predicate
  module, and for every action absent from a summary the corresponding
  lifecycle method refuses with its documented message;
- `inspect` returns the requested sections only, never the output value or
  child prose, bounds every list to 256 items with the omitted count in
  `truncated`, returns all of one task's executions when `taskId` is given,
  and refuses malformed selectors and task ids with the documented messages;
- `logs` derives redacted entries in the fixed formats, excludes identities,
  digests, prompts, and child prose, marks abandoned effects, and pages by
  sequence with `nextAfterSequence` present only when more entries exist;
- `subscribe` observes every append to an owned run in sequence order, a
  throwing listener affects neither the append nor other listeners, unsubscribe
  is idempotent, and subscription after shutdown is refused;
- `wait` with `timeoutMs` validates the bound before touching the run, returns
  the current view marked `timedOut` when the drive outlives the timeout, and
  leaves the drive running for a later `wait`;
- `reconcile` with `taskId` refuses unknown and non-cleanup-blocked tasks
  before taking a lease, reconciles only that task, and reports `before`,
  `after`, and the pi-subagent reconcile facts for agent tasks; without
  `taskId` it reconciles every on-path cleanup-blocked task in order;
- every projection output satisfies its `service-views.ts` schema for every
  fixture journal and for a synthetic 256-task state;
- the read tools validate output against those schemas, shrink run and log
  pages to the 48 KiB bound while keeping later pages complete, and refuse an
  oversized inspection with the exact guidance message.

## Worktree tasks and handoffs

- a worktree agent task (`workspace: { mode: "worktree", cwd }`,
  `limits.workspaceWriteBytes >= 1`) completes with a workflow-owned,
  digest-verified `git format-patch` handoff artifact imported from
  pi-subagent's `exportHandoff` before the child is released;
- `task-execution-handoff-imported` precedes `task-execution-release-intended`
  in the journal, and the handoff artifact is declared with
  `output: "handoff"`, `mediaType: "application/x-git-format-patch"`, and
  `schemaSha256 = WORKFLOW_HANDOFF_FORMAT_SHA256` under the same producer
  execution as the result artifact;
- the preflight event carries `workspaceMode` and `workspaceBaselineSha256`,
  the settlement carries `handoff { attemptId, baselineHead, handoffCommit }`
  and nothing else about the worktree, and the import's identity equals the
  settlement's;
- export failure, identity mismatch, unsupported format, digest or size
  mismatch, oversize, or a malformed patch leaves the task and run
  `cleanup-blocked` at stage `handoff-import`, and explicit reconciliation
  reconciles the child and retries the import;
- a completed child that captured no handoff under `handoff: "required"` is
  released and then fails with "Completed worktree task captured no
  handoff."; under `"optional"` it completes and `ctx.handoff` resolves
  `undefined`;
- a retry or resume attempt imports the final attempt's handoff, whose
  `attemptId` equals the current attempt, while prior attempts' handoff
  identities stay in `priorSettlements`;
- generation 2 receives a fresh preflight, baseline, subagent run, and
  worktree; the prior generation's handoff artifact is retained and every
  lookup selects the current execution's artifact;
- every crash prefix of the handoff ladder (no handoff evidence, orphan
  `.patch` blob, declared but not imported, imported or absent, blocked at
  `handoff-import`, released with a required handoff absent) replays to the
  same outcome without a duplicate artifact or event;
- `ctx.handoff` resolves the descriptor, a returned `HandoffHandle` commits the
  descriptor as the workflow output, and a downstream task that names
  `handle.handoff` in `inputs` receives the descriptor envelope, never patch
  bytes; a handoff input whose producer is not a worktree agent task is
  rejected at declaration;
- `WorkflowService.exportHandoff(runId, taskId)` returns the verified bytes and
  descriptor for a completed worktree task and refuses read-only or
  incomplete tasks; the run view lists `handoff` on completed worktree tasks;
- a completed worktree task replays only with a verified handoff artifact (or
  a recorded absence under an optional policy) whose identity equals the
  settlement and import; otherwise "Completed worktree task has no verified
  handoff artifact.";
- private paths, branches, and ref names never appear in the journal or store;
- the workflow never applies, pushes, merges, or checks out a handoff;
- the materializer rejects `handoff` on a read-only request, a worktree
  request without a positive `workspaceWriteBytes`, and a handoff input whose
  producer is not a worktree agent task, with the fixed messages, and the
  launcher never lowers `handoff` into the pi-subagent request;
- the runtime contract publishes `worktrees: true` and requires pi-subagent
  contract revision 6 with `handoffExport: true`.

## Operator surface

- `retry(runId, taskId, reason)` is `invalidate` restricted to a cause task
  whose current execution ended `failed` or `interrupted` ("Workflow retry
  requires a failed or interrupted task."); it shares every invalidation
  refusal, re-executes the task and its dependents as the next generation
  with a fresh child run, and never calls the subagent `retry`;
- `resume(runId, reason, { taskId })` validates the run id, reason, and task
  id before touching the run, refuses a run still being driven (`conflict`), a
  status other than `interrupted`, a nested run, a run awaiting recovery, a
  passed deadline, a run with no resumable task, several resumable tasks
  without `taskId`, a task whose dependents already observed it, and a task
  without a resumable failure, each with its fixed message and no journal
  change; on success it journals the operator `resume` intent, then
  `interrupted → running`, restarts the drive, and the child is resumed on its
  existing subagent run with attempt ordinal 2 and no new launch;
- a resume that pi-subagent refuses declines the attempt with the fixed
  reason, terminalizes the execution `interrupted` again without release, and
  leaves the run resumable; a crash between the intent and the transition
  leaves the run offering only `wait`, whose next drive performs the same
  transition and attempt;
- `workflow_retry` and `workflow_resume` forward to the service, validate
  their run-view output against the schema, and render from the table;
- `previewInvalidation(runId, taskId)` returns exactly the `taskIds` and
  `abandonedEpochs` the subsequent invalidation journals and the task ids it
  marks abandoned, raises the reducer's refusals unchanged, reads a run leased
  elsewhere, and never appends; no UI module computes a closure of its own;
- the unified `/workflow` command, the `pi-workflow` widget, and the `alt+w`
  inspector consume `availableActions`, `requiresAttention`, `ownership`, and
  `leasedElsewhere` from the service; no UI module imports the legality
  predicates, an action the summary does not list is refused before the
  service is called, and the action grammar, completions, and palette derive
  from `IMPLEMENTED_WORKFLOW_RUN_ACTIONS`;
- the widget lists depth-0 runs that are ongoing or need action, hides when
  neither applies, marks runs leased elsewhere, refreshes from `subscribe`,
  and polls only while a listed run is nonterminal or awaits recovery;
- the widget stays at two lines while a run this session owns waits for a
  decision: `waiting for you: <prompt>` cut to the widget width takes the
  first line, the ongoing and attention counts collapse into the second, and
  the prompt is read from one lease-free `inspect` per parked run and cached
  across polls.

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
  and revision-18 stores reject revision 1 through 17 leases, journals,
  snapshots, run records, decision records, and dynamic proposal records;
- source or runtime drift cannot reinterpret prior human or model decisions;
- finalizers are `role: "finalizer"` tasks declared through `ctx.finalize`
  with exactly one of `support`, `agent`, or `workflow`, `kind` lowers to the
  disposition, an inner disposition or an invalid kind is rejected, ordinary
  tasks may not depend on finalizers, and no barrier may target one;
- finalizers run only while the run is `finalizing` after the output commit,
  ordinary tasks only while it is `running` or `waiting`, and the scheduler
  idles in `finalizing` without flipping the run status;
- required finalizer failure prevents success (`finalizing → failed`,
  `finalizing → interrupted`, or the runtime's "Required finalizer did not
  complete: blocked."), an advisory finalizer that fails or is blocked yields
  `completed-degraded`, and invalidation after the output commit may cover
  only finalizers, re-executing them as the next generation against the
  committed output;
- the runtime contract publishes `finalizers: true`;
- bounded private stores redact sensitive metadata.

## Dynamic workflows

Dynamic acceptance (contract revision 18, `dynamicWorkflows: true`) must prove:

### Parity

- the same source loaded through the static loader and through the shim
  yields a deep-equal manifest (`meta` with the concurrency default,
  `inputSchema`, `outputSchema`); every fenced example of the authoring skill
  yields its manifest through `extractDynamicWorkflowManifest`;
- driven under the same `definitionIdentitySha256`, run id, input, and
  deterministic fake outcomes, the static and dynamic frontends produce
  identical `{ type, data }` journal payloads, the same output value, and the
  same output artifact digest, for sources covering `fanOut`, `fanIn`,
  `pipeline`, `settled`, `finalize`, a support helper imported under its
  `exportName`, and a checkpoint; the single exception is the `-> failed`
  reason of a throwing source ("Static workflow source execution failed."
  versus "Dynamic workflow source execution failed: <name>: <message>"),
  which is asserted exactly on both sides;
- a `workflow_propose` output validates against
  `DynamicWorkflowProposalViewSchema` on a real service, no
  `workflow_approve`, `workflow_reject`, or `workflow_proposals` tool exists,
  and the `workflow_validate`/`workflow_run` descriptions name the
  `dynamic:<sha256>` form.

### Fresh-VM recovery

- two agent tasks and a barrier: the first drive completes one task and then
  fails; the second drive boots a worker with a different thread id, replays
  the completed task from its artifact without a new `task-declared`, executes
  the second, and completes;
- a park at a checkpoint resolves `{ parked: true }`, terminates the worker,
  appends no `-> failed`, and after `decide` a fresh VM completes the run;
- invalidation recovery re-drives in a fresh VM and re-executes generation 2;
- a dynamic run never carries VM state across drives: `Date.now()` returns the
  run's `createdAt` and the `Math.random` sequence repeats across two boots of
  the same run id.

### Intake, approval, and tampering

- every intake refusal fires with its fixed message (non-string, empty,
  oversized, non-UTF-8, the registry gate messages verbatim, `import.meta`,
  a named export, a missing default export, an invalid proposer) before a VM
  boots, and manifest extraction failure reports the bridge reason;
- the proposal store lays out `source.workflow.ts`, `current`,
  `records/<version>/manifest.json` and `proposal.json`, and `decisions/`
  with owner-only modes, re-proposing the same bytes is idempotent, a host
  API change stages a new record pair and swaps `current` while the source
  and `decisions/` stay (every crash prefix reads as the old or the new pair,
  a concurrent read never sees a mixed pair, superseded pairs are reaped by
  the next replacement), a dangling pointer or an edited record fails closed
  on read and is rebuilt by `put` of the same bytes while an altered source
  is not, an edited `definitionIdentitySha256` is refused on read, corrupt,
  symlinked, and non-canonical records are refused, the store caps at 1024
  digests, and `proposals()` lists sorted digests with issues for corrupt
  entries while `list()` stays static-only;
- a `source-approval` record round-trips through `openRoot`, the run-scoped
  store refuses it and the definition-level store refuses a `checkpoint`
  binding, a `decidedBy` without the `human:` prefix and a wrong
  `valueSchemaSha256` are refused as invalid records, and an approver with
  `kind: "model"` fails the schema ("Invalid dynamic workflow approver.");
- a second `decideSource` refuses ("Dynamic workflow source is already
  approved."); a rejected digest re-proposed shows `decision.decision ===
  "rejected"` and `runnable: false`, and both `decideSource(approved)` and
  `run` refuse "Dynamic workflow source was rejected.";
- editing `<run>/definition/approval.json` (a flipped decision or a single
  byte), `source.workflow.ts`, or `manifest.json` refuses resume with,
  respectively, "Dynamic workflow approval record changed since the run was
  created.", "Dynamic workflow source changed since the run was created.",
  and "Dynamic workflow manifest changed since approval."; editing
  `proposal.json` refuses resume by the field that drifted (embedded
  manifest, `manifestSha256`, or `definitionIdentitySha256`: the manifest
  message; `sourceSha256`: the source message; `hostApiSha256`: "Dynamic
  workflow host API changed since the run was created."; `importPolicySha256`:
  "Dynamic workflow import policy changed since approval.") and the
  definition is composed from the verified `manifest.json`, never from the
  proposal record's embedded copy;
- a forged store decision with a wrong value digest or binding, or one decided
  by a model, refuses `run` as `persistence` "Dynamic workflow approval record
  is invalid."; an approval or proposal under another project refuses with
  the project messages; a proposal whose host API predates the current one
  refuses `run` and `decideSource` ("Dynamic workflow proposal predates the
  current host API; propose the source again.") and an existing run refuses
  resume ("Dynamic workflow host API changed since the run was created.");
  dropping a published support registration refuses run and resume with
  "Dynamic workflow import policy changed since approval.";
- deleting the store decision after a run was created leaves that run
  resumable from its `definition/` copy while a new `run` refuses "Dynamic
  workflow source is not approved for the current host API.";
- a dynamic definition is never a nested child, and a dynamic run record with
  `depth >= 1`, a `parent`, or missing digests is an invalid run record.

### Bounds, watchdogs, abort, and protocol

- a source that allocates unboundedly under a reduced heap limit ends the run
  `failed` with "Dynamic workflow VM exceeded its memory limit." and stage
  `memory`;
- a source that spins ends with the compute reason interpolating the
  effective limit (the production string is "Dynamic workflow VM exceeded
  30000 ms of compute between host messages."), while a barrier that
  outlives the compute limit completes because the watchdog is paused;
- a worker that never posts `ready` ends with the boot reason interpolating
  the effective limit (production: "Dynamic workflow VM did not boot within
  10000 ms.");
- aborting `ctx.signal` while the VM awaits a barrier makes the VM's
  `ctx.signal.aborted` true, `run()` rejects with stage `abort`, and no
  `-> failed` is appended while the run is `stopping`; a VM that finishes
  within the grace period completes;
- a rogue worker fixture that posts an invalid message, an oversized message,
  more than 65536 messages, non-contiguous ids, or overlapping calls fails
  with each exact protocol message, and exits, crashes, and silence report
  their stages;
- a host that never notifies makes the VM throw "Dynamic workflow host did
  not answer a synchronous declaration within <ms> ms." with the effective
  wait interpolated;
- the context exposes exactly the `WorkflowContext` members, `typeof
  process`, `require`, `fetch`, `setTimeout`, `structuredClone`,
  `TextEncoder`, and `queueMicrotask` are `"undefined"`, `eval` and `new
  Function` throw `EvalError`, `import()` rejects, and a global write throws
  "Cannot add property <name>, object is not extensible";
- the transformer lowers enums, namespaces, parameter properties, and
  `satisfies`, rejects `module Foo {}`, erases `import type` and `type`
  specifiers, rewrites every import form and the default export, is
  byte-stable across calls and workers, and the installed `amaro` version is
  pinned ("dynamic workflow transformer version mismatch");
- `hostApiSha256` is a stable function of the constants, `importPolicySha256`
  is order-independent, and `definitionIdentitySha256` composes the source,
  manifest, and host API digests canonically;
- `exportName` validation ("Support task export name is invalid.") and the
  duplicate export refusal fire at service construction, and `supportHelpers`
  holds exactly the registrations with an `exportName`;
- documentation does not claim the worker-thread VM is an OS security
  boundary.

## Product and distribution

- widget and inspector are projections and recover after reload;
- workflow list, validate, run, status, wait, stop, reconcile, runs,
  inspect, logs, invalidate, retry, and resume work in a fresh
  `PI_CODING_AGENT_DIR` through the tool table and the `/workflow` command;
- `/workflow decide` is offered only while `availableActions` lists
  `decide`, refuses invalid JSON before reaching the service, refuses outside
  an interactive session, records nothing when the confirm is cancelled, and
  records the confirmed decision with the session approver (never an
  argument) so the parked run completes;
- `/workflow approve` and `/workflow reject` refuse outside an interactive
  session, record nothing when the confirm is cancelled, refuse an already
  decided proposal, and write the decision file with the approver's session
  id when it is accepted; the packed `dist/dynamic/worker.js` resolves from
  the packed host and extracts a manifest;
- package contents contain compiled ESM, declarations, license, and bounded docs;
- both bundled skills (`skills/workflow-authoring/`, `skills/workflows/`) are
  packed and declared through `pi.skills`, and the operating skill's tool
  names, `/workflow` subcommands, run statuses, quoted runtime messages, and
  recovery legality table are pinned to the runtime in both directions;
- the root entry exports exactly the pinned frozen list
  (`test/fixtures/public-api/root-exports.json`) and the runtime entry
  exactly the pinned runtime list (`runtime-exports.json`), both asserted
  from the packed tarball by the pack check and from source by
  `test/public-api.test.ts`, and no name is exported from both entries;
- deep `dist/` paths (`@vegardx/pi-workflow/dist/index.js`,
  `@vegardx/pi-workflow/runtime/index.js`) are not importable from the
  packed tarball (Node's `ERR_PACKAGE_PATH_NOT_EXPORTED`), while `.`,
  `./extension`, `./runtime`, and `./package.json` load;
- frozen type shapes (`createWorkflowService`, `WorkflowServiceOptions`,
  `WorkflowService`, `WorkflowContext`, `defineWorkflow`, `defineSupportTask`,
  `CheckpointRequest`, the tool-name and run-action unions) type-check
  against the fixture `test/public-api.types.ts` under `tsc --noEmit`;
- the `WORKFLOW_TOOL_DECLARATIONS` names, the `/workflow` subcommands, the
  widget key, the shortcut, and the `WorkflowService` method names are pinned
  by literal;
- the compatibility matrix records the API version, the frozen surfaces, and
  the entry-point status, and its major matches the package major;
- a qualification note (`docs/qualification.md`) records what was exercised
  by hand for 1.0.0, what CI exercised, what is unit-tested only, and what
  was not exercised, claiming nothing that was not run;
- Ubuntu CI is portability evidence; supported macOS Apple Silicon runtime
  qualification is driven locally;
- publication, push, pull request, merge, release, and deployment authority are
  absent from the package.
