# Failure taxonomy

| Class | Examples | Default effect |
| --- | --- | --- |
| Definition | Invalid module, duplicate workflow name, invalid schemas | Fail before run |
| Trust | Untrusted project workflow or helper | Block for trust decision |
| Materialization | Duplicate task key, foreign handle, invalid dependency, incompatible declaration | Fail run closed |
| Validation | Invalid input, output, task request, or artifact | Fail task or run by policy |
| Dependency | Required predecessor failed or artifact missing | Block dependent task |
| Service provider | Missing, duplicate, or incompatible pi-subagent provider | Fail before run |
| Subagent preflight | Missing feature, tool, model, trust, workspace | Fail task before launch |
| Subagent launch/runtime | Child startup, provider, tool, timeout | Terminal settlement with a classified failure; the task's attempt policy decides whether a fresh attempt follows |
| Retry and resume attempts | `failed` child classified `backoff` or `manual` under a `retry` policy that lists that class; `interrupted` child classified `resume` under a `resume` policy; `never` and `reconcile` classifications, an unlisted class, an exhausted policy, or a declined earlier attempt | Fresh pi-subagent attempt on the same child run under the same task execution; pi-subagent enforces backoff through `RetryBackoffError.retryAt`, which the runtime waits out under the stop signal and workflow deadline; stop or deadline declines with a fixed message; a refusal is reconciled by operation ID and declined when no new attempt exists; an execution without an admissible attempt proceeds to release and its settled outcome, or, when interrupted, to `interrupted` without release |
| Lease port occupied | A deterministic candidate port is held by another process | A banner proving a different run advances to the next candidate; the same identity or an occupant that cannot identify itself fails safe as `WorkflowRunLeaseUnavailableError`; a recorded port outside the candidate walk is lease-record corruption |
| Invalidation | Service `invalidate` on a run still being driven, whose status is not `failed` or `interrupted`, that is a nested child run ("Nested workflow runs are invalidated through their parent run."), that already holds on-path invalidated work ("Workflow run already awaits recovery of invalidated work.") or an operator resume intent the next drive still performs ("Workflow run already awaits recovery of an operator resume."), or whose deadline has passed ("Workflow run deadline has passed."); a `task-invalidated` event while a current execution is non-terminal ("workflow run has active task executions"), under a run status outside `running`, `waiting`, `failed`, and `interrupted` ("workflow run status does not admit invalidation"), for an unknown or already-invalidated cause, for a closure task that already holds 16 generations ("task execution generation bound exceeded"), or with a closure or abandoned-epoch set other than the computed one; a declaration beyond the on-path prefix reusing an abandoned key with a different identity ("abandoned task key re-declared with a changed request"); an execution created for an abandoned task, out of contiguous order, beyond generation 16, or while the task still has a current execution (active, or terminal and not yet detached by re-materialization); a closure task whose status admits no `invalidated` transition (for example `cleanup-blocked`) | Service rejection (`conflict` or `validation`) without a journal change; reducer rejection fails the append closed; the materialization error fails the run closed; abandoned work is never scheduled |
| Operator retry and resume | Service `retry` on a cause task whose current execution did not end `failed` or `interrupted` ("Workflow retry requires a failed or interrupted task."), or under any invalidation refusal; service `resume` on a run still being driven ("Workflow run is still being driven."), whose status is not `interrupted` ("Workflow run status does not admit resume."), that is a nested child run ("Nested workflow runs are resumed through their parent run."), that awaits recovery, whose deadline has passed, with no resumable task ("Workflow run has no resumable task."), with several resumable tasks and no `taskId` ("Workflow run has multiple resumable tasks; specify taskId."), or naming a task without a resumable failure ("Workflow resume requires an interrupted task with a resumable failure."); a subagent that refuses the resume | Service rejection (`conflict` or `validation`) without a journal change; a refused subagent resume declines the attempt with "Subagent refused the attempt.", terminalizes the execution `interrupted` again without release, and leaves the run resumable |
| Structured output | Terminating schema repair exhausted | Task failure |
| Service read | `listRuns` query or cursor malformed ("Invalid workflow run query.", "Invalid workflow run cursor."); `inspect` selector or task id malformed ("Invalid workflow inspection selector.", "Invalid workflow task ID."); `logs` query malformed ("Invalid workflow log query."); a run directory that does not exist or is not a directory (`not-found`); an unreadable record or a corrupt journal, owned or not, including one that violates run invariants ("Workflow run record is invalid.", "Workflow run journal is corrupt."); `subscribe` after shutdown ("Workflow service is closed.") | `validation`, `not-found`, `persistence`, or `conflict` without touching a lease; `listRuns` reports per-run problems as bounded issues (`unreadable` for any failure outside the named kinds) and never fails for one run; a torn tail is measured and reported, never repaired by a reader |
| Wait and reconcile options | `wait` with a `timeoutMs` outside 1..2 147 483 647 ("Invalid workflow wait timeout."); `reconcile` with a malformed task id ("Invalid workflow task ID."), an unknown or abandoned task ("Unknown workflow task."), or a task that is not on-path `cleanup-blocked` ("Workflow task is not cleanup-blocked.") | `validation` before any lease or drive; a timed-out `wait` returns the current view marked `timedOut` and leaves the drive running |
| Tool output bound | A validated view that fails its schema ("workflow tool output violates its schema"); an inspection larger than 48 KiB ("Workflow inspection exceeds the tool output bound; narrow include or pass taskId.") | The schema failure is a bug and is never masked; pages shrink and re-cursor; the inspection is refused with guidance, and `include: ["run"]` always fits |
| Support task | Unregistered or drifted implementation (`support-resolution`); missing input evidence, input digest mismatch, unreadable inputs, or parameters failing the registered schema (`support-input`); implementation exception (`support-execution`); non-JSON, oversized, schema-invalid, or conflicting output (`support-output`) | Task failure with a fixed message; a required task fails the run |
| Nested workflow | Undiscovered name, depth bound, recursion, schema-invalid input without artifact inputs, non-object authored input or an authored key colliding with an input name when artifact inputs are declared, or an unknown, foreign, or undeclared input producer at declaration (materialization failure); missing or ambiguous producer artifact, unreadable or unverifiable input, or a merged input that is not lossless JSON, exceeds 900 KiB, or fails the child schema at launch (`nested-input`); child not resolvable by exact identity and source at launch (`nested-resolution`); no remaining time before the parent deadline, lease or record creation failure, or an existing child run whose lineage, definition, merged input, or injected artifacts do not match the intent (`nested-launch`); child output unreadable, unverifiable, or schema-invalid (`nested-import`) | Declaration failures fail the run closed; `nested-input`, `nested-resolution`, and `nested-launch` fail the task; `nested-import` leaves the task `cleanup-blocked` until reconciliation; a required task propagates to the run |
| Handoff import | Owner client `exportHandoff` rejection, an invalid `HandoffRef`, an identity that differs from the settled `{ attemptId, baselineHead, handoffCommit }`, an unsupported format, a digest or size mismatch, bytes above `MAX_WORKFLOW_HANDOFF_BYTES` (16 MiB), or bytes that are not a single-commit `git format-patch`; a completed worktree child that captured no handoff under `handoff: "required"` | Import failures terminalize the execution `cleanup-blocked` at stage `handoff-import` before any release intent; the task and run become `cleanup-blocked` until `workflow_reconcile` reconciles the child and retries the import. The no-handoff case is released normally and then `failed` at stage `handoff-import` with "Completed worktree task captured no handoff."; under `handoff: "optional"` it completes without a handoff |
| Checkpoint | Declaration errors (a checkpoint as a finalizer, invalid prompt, headless policy, timeout, default, or schema); missing, ambiguous, or unverifiable inputs before the request (`checkpoint-input`, "Checkpoint input artifact evidence is incomplete.", "Checkpoint inputs could not be read and verified."); no approver before `expiresAt` under `headless: "block"` (`checkpoint-expired`, "Checkpoint expired without a decision."); expiry under `use-explicit-default` (the default decision is recorded, `source: "default"`); stop, deadline, or a run failure while the checkpoint is open (cancelled at stage `stop`, "Workflow run ended before the checkpoint was decided." from `CHECKPOINT_RUN_ENDING_REASON` when the run fails, or the stop reason); a `decide` that conflicts with existing evidence ("Checkpoint decision conflicts with existing decision evidence."), repeats a decision ("Checkpoint is already decided."), arrives after expiry ("Checkpoint has expired."), fails the schema ("Checkpoint decision does not match its schema."), is not lossless JSON ("Checkpoint decision is not losslessly JSON serializable."), or exceeds the artifact bound ("Checkpoint decision exceeds the workflow artifact bound."); inputs that no longer hash to the durable request ("Checkpoint inputs do not match durable intent.") | Declaration errors fail the run closed; the run parks (`waiting`, `wait` returns `parked: true`) until decided, expired, stopped, or the run ends; a required checkpoint that fails or is cancelled fails the run; `decide` refusals are `validation` without a journal change; the input digest mismatch is `persistence` with its message, and any other decision failure (a stored record that fails verification, a reducer rejection, a fenced lease) is `persistence` ("Checkpoint decision could not be recorded.") carrying the cause; a run never reaches `failed`, `interrupted`, or `cleanup-blocked` with an open checkpoint |
| Dynamic workflow | Intake refusal: a non-string, empty, oversized (`MAX_DYNAMIC_SOURCE_BYTES` = 262144), or non-UTF-8 source ("Dynamic workflow source must be a string.", "Dynamic workflow source is empty.", "Dynamic workflow source exceeds 262144 bytes.", "Dynamic workflow source is not valid UTF-8."), the static import gate's messages verbatim, `import.meta` ("dynamic workflow source may not use import.meta"), any export shape but one default export ("dynamic workflow source must have exactly one default export and no named exports"), a malformed proposer ("Invalid dynamic workflow proposer."), a full store ("Dynamic workflow proposal store is full."), or a corrupt store ("Dynamic workflow proposal store is corrupt."); manifest extraction failure ("Dynamic workflow manifest extraction failed: <bridge reason>", "Dynamic workflow manifest is invalid."); a proposal that is unapproved ("Dynamic workflow source is not approved for the current host API."), rejected ("Dynamic workflow source was rejected."), stale ("Dynamic workflow proposal predates the current host API; propose the source again.", "Dynamic workflow import policy changed since the proposal; propose the source again.", "Dynamic workflow import policy changed since approval."), from another project ("Dynamic workflow proposal belongs to another project.", "Dynamic workflow approval belongs to another project."), or whose approval disagrees with it ("Dynamic workflow approval does not match the proposal.", "Dynamic workflow approval record is invalid."); a second decision ("Dynamic workflow source is already approved."); run-copy tampering on resume ("Workflow run definition copy is missing or corrupt.", "Dynamic workflow source changed since the run was created.", "Dynamic workflow approval record changed since the run was created.", "Dynamic workflow host API changed since the run was created.", "Dynamic workflow manifest changed since approval."); VM boot, transform, protocol, compute, memory, and exit failures and a source exception (the exact reasons under [Dynamic workflow failure reasons](#dynamic-workflow-failure-reasons)) | Intake, approval, and stale-proposal refusals are service rejections (`validation`, `conflict`, `not-found`, or `persistence`) before a run exists; run-copy refusals refuse to resume without a journal change; VM failures end the run `failed` with the exact VM reason as the `run-status-changed` reason, after open checkpoints are cancelled; a checkpoint park terminates the VM without `-> failed`; an abort while the run is already `stopping` appends nothing |
| Budget | Cost, optional total-token, or cumulative child-runtime cap reached; a nested child's declared budget does not fit the parent's remaining budget | Reserve before launch; block inadmissible task; fail post-settlement overage; incomplete child usage fails closed |
| Deadline | Persisted workflow wall deadline reached | Stop and drain; abort in-process support work; stop linked child runs through their parent tasks; cleanup uncertainty remains cleanup-blocked |
| Lease loss | Scheduler ownership lost | Interrupt and reconcile |
| Persistence | Journal, snapshot, intent, receipt, or artifact durability failure; a nested input that cannot be recomputed to the intended digests after intent | Fail closed |
| Resource/source drift | Workflow, helper, tool, skill, model, or service changed | Invalidate or refuse resume; registry drift fails non-terminal support executions at `support-resolution`; child source drift fails replay of the parent as declaration drift |
| Finalizer | Required finalizer task failed, interrupted, or blocked by a failed dependency; advisory finalizer failed or blocked; a finalizer named as a barrier target or as an ordinary task's dependency | Required: run `failed` or `interrupted` from `finalizing`; advisory: `completed-degraded`; declaration errors fail the run closed |
| Unknown | Unclassified or unprovable state | Interrupt and reconcile |

Retryability is a stable code-level property combined with explicit workflow
policy, never string matching: the subagent settlement carries a failure `code`
and a `retry` classification, and the task's `retry.on` and `resume` policies
decide whether an attempt is admissible. Retry and resume preserve prior
executions, usage, artifacts, and budget consumption; every attempt's
settlement evidence is retained and settled usage sums across attempts.

A task result cannot override persistence, lease, cleanup, or artifact-import
failure. An advisory observation failure cannot replace an otherwise valid
required result, but remains visible as degradation evidence when policy permits.

## Agent attempt sequences

An admissible attempt keeps the task `running` or `waiting`; it never passes
through `failed` or `interrupted`. Its journal sequences are:

```text
attempt:  task-execution-child-settled (status failed, failure.retry
          backoff | manual, or status interrupted, failure.retry resume)
          → task-execution-attempt-intended (kind retry | resume)
          → task-execution-attempt-receipted
          → task-execution-child-observed
          → task-execution-child-settled (next attemptOrdinal)
          → another attempt, or release and terminal outcome

decline:  task-execution-attempt-intended
          → task-execution-attempt-declined (fixed reason)
          → release and the retained settlement's terminal outcome
          (an interrupted settlement: terminal outcome interrupted, no release)

no attempt (interrupted):
          task-execution-child-settled (status interrupted)
          → task-execution-terminal (outcome interrupted, evidence = settlement)
          → task-status-changed (running | waiting | cancelling → interrupted,
            "Interrupted child retained for recovery; no release performed.")
          → run-status-changed (→ interrupted) for a required task

operator: task-execution-terminal (outcome interrupted)
          → task-execution-attempt-intended (kind resume, origin operator,
            optional reason; reopens the execution)
          → receipt or decline as above
```

Policy intents carry `origin: "policy"` and never a `reason`. Operator intents
are admitted by the reducer only as `resume` against the task's current
unreleased interrupted execution while the run is `running`, `waiting`, or
`interrupted`; no service surface appends them yet.

Decline reasons are fixed strings: "Workflow stop requested before the
attempt." when the scheduler stop signal is aborted before the call or while
waiting out backoff, "Workflow deadline passed before the attempt." when the
persisted deadline has passed before the call, "Subagent refused the attempt."
when the owner client rejects the call and `findByOperation` shows no attempt
beyond the previous one, and "Attempt call ended without a durable receipt."
when the call returned nothing and reconciliation found no new attempt. A
backoff whose `retryAt` is at or after the deadline is declined as stopped
rather than waited. A call that created an attempt before failing is adopted
through `findByOperation` rather than duplicated, and a reconciliation error
is thrown as a `WorkflowAttemptError`, never converted into a decline or a
task failure. Explicit stop declines any open intent before finalization.
Once an intent is declined the execution accepts no further intents.

## Worktree handoff sequences

A completed worktree child resolves its handoff after the structured-output
import and before release intent. Its journal sequences are:

```text
success:  task-execution-child-settled (status completed,
          handoff { attemptId, baselineHead, handoffCommit })
          → artifact-declared (output result)
          → task-execution-artifact-imported
          → artifact-declared (output handoff, application/x-git-format-patch)
          → task-execution-handoff-imported
          → task-execution-release-intended
          → task-execution-released
          → task-execution-terminal (outcome completed, evidence kind subagent)
          → task-status-changed running|waiting→completed

no changes, optional policy:
          … → task-execution-artifact-imported
          → task-execution-handoff-absent
          → release intent and receipt
          → task-execution-terminal (outcome completed)
          → task-status-changed → completed

no changes, required policy:
          … → task-execution-artifact-imported
          → task-execution-handoff-absent
          → release intent and receipt
          → task-execution-terminal (outcome failed, evidence kind workflow,
            stage handoff-import,
            "Completed worktree task captured no handoff.")
          → task-status-changed → failed

export failure:
          … → task-execution-artifact-imported
          → task-execution-terminal (outcome cleanup-blocked, evidence kind
            workflow, stage handoff-import)
          → task-status-changed → cleanup-blocked
          → run-status-changed → cleanup-blocked
```

The import verifies, in order, that the export succeeded, that the returned
reference is a valid `HandoffRef` with binary content, that it names the child
run, the current attempt, and the settled `baselineHead` and `handoffCommit`
(which differ), that its format is `git-format-patch` with media type
`application/x-git-format-patch`, that size and SHA-256 match the reference
and stay within 16 MiB, and that the bytes begin with the single-commit
`From <handoffCommit> Mon Sep 17 00:00:00 2001` separator. Each check fails
with a fixed message ("Subagent handoff export failed.", "Subagent handoff
export returned an invalid reference.", "Exported handoff does not match the
settled handoff identity.", "Exported handoff has an unsupported format.",
"Exported handoff digest or size does not match its reference.", "Exported
handoff exceeds the workflow handoff bound.", "Exported handoff is not a
single-commit git-format-patch."); the persisted terminal message is
"Workflow handoff artifact import requires reconciliation." and raw error
text is never journaled. A handoff above 16 MiB is not importable: the task
stays `cleanup-blocked` and the operator exports or pins it in pi-subagent.
Journal, lease, and artifact-store uncertainty is thrown rather than converted
into task failure. See the recovery ladder in
[Persistence and recovery](persistence.md#worktree-handoff-recovery).

## Checkpoint sequences

A checkpoint execution never enters `running`, `cancelling`, `interrupted`, or
`cleanup-blocked`, holds no lane, and reserves no budget. Its journal
sequences are:

```text
decided:  task-status-changed pending→ready
          → task-execution-created (kind checkpoint)
          → task-execution-checkpoint-requested { inputsSha256, expiresAt? }
          → task-status-changed ready→waiting ("Checkpoint awaits a decision.")
          → run-status-changed running→waiting
            ("Workflow run awaits a checkpoint decision.")   // drive parks
          → [decide] decisions/<bindingSha256>.json written
          → artifact-declared (output result, the decision value)
          → task-execution-checkpoint-decided (source operator, decidedAt from
            the record, decidedBy)
          → task-execution-terminal (outcome completed, evidence kind checkpoint)
          → task-status-changed waiting→completed ("Checkpoint decided.")
          → run-status-changed waiting→running                // restarted drive

expired,  … ready→waiting → [sweep or watchdog at expiresAt]
block:    → task-execution-terminal (outcome failed, evidence kind workflow,
            stage checkpoint-expired, "Checkpoint expired without a decision.")
          → task-status-changed waiting→failed
          → run-status-changed waiting→failed (required task)

expired,  … ready→waiting → [sweep]
default:  → artifact-declared → task-execution-checkpoint-decided
            (source default, no decidedBy)
          → task-execution-terminal (outcome completed)
          → task-status-changed waiting→completed

headless  pending→ready → task-execution-created
default:  → task-execution-checkpoint-requested → artifact-declared
          → task-execution-checkpoint-decided (source default)
          → task-execution-terminal (outcome completed)
          → task-status-changed ready→completed              // never waiting

input:    pending→ready → task-execution-created
          → task-execution-terminal (outcome failed, evidence kind workflow,
            stage checkpoint-input)
          → task-status-changed ready→failed

stop /    run-status-changed waiting→stopping (reason)
deadline: → task-execution-terminal (outcome cancelled, stage stop, reason)
          → task-status-changed waiting→cancelled
          → run-status-changed stopping→cancelled

run       task-execution-terminal (outcome cancelled, stage stop,
failure:    "Workflow run ended before the checkpoint was decided.")
          → task-status-changed waiting→cancelled
          → run-status-changed running|waiting→failed
```

The decision record is the durable evidence; the artifact, decided event,
terminal, and status are repaired from it after a crash at any prefix (see
[Persistence and recovery](persistence.md#checkpoint-execution-recovery)).
Every failure site settles non-terminal checkpoints before it appends
`-> failed`, `-> interrupted`, or `-> cleanup-blocked`: undecided executions
are cancelled and a decided one without its terminal is committed ("Checkpoint
decided."); the reducer rejects the append otherwise ("run failure leaves a
checkpoint open"). A cancel that races a concurrent decision commits the
decided execution instead of cancelling it. Failure messages are
fixed strings; the operator's decision value never appears in a log entry and
raw error text is never persisted.

## Dynamic workflow failure reasons

A dynamic run's source executes in a worker-thread VM; the host maps every
VM failure to a `DynamicWorkflowExecutionError` whose `stage` and `message`
are fixed, and the static runtime appends `run-status-changed <status> ->
failed` with that message as the reason (after cancelling open checkpoints,
like every other failure site). The static path appends the fixed
"Static workflow source execution failed." instead; this is the one
documented parity exception between the two frontends. Raw stacks never
reach the journal: the message carries at most the error `name` and a
bounded `message` (`MAX_DYNAMIC_VM_ERROR_CHARS` = 1024), and the whole
reason is bounded to 4096 characters.

| Stage | Reason | Cause |
| --- | --- | --- |
| `boot` | "Dynamic workflow VM did not boot within 10000 ms." (manifest mode: "Dynamic workflow VM did not boot within 5000 ms.") | no `ready` before `DYNAMIC_VM_BOOT_TIMEOUT_MS` / `DYNAMIC_VM_MANIFEST_TIMEOUT_MS` |
| `boot` | "Dynamic workflow VM failed to boot: <message>" | a worker bootstrap failure before the transform (`DynamicBootError`: "Dynamic workflow worker data is invalid.", "Dynamic workflow worker did not receive start.", "dynamic workflow transformer version mismatch"); a host defect, not a source fault |
| `transform` | "Dynamic workflow source failed to transform: <message>" | `amaro` rejected the TypeScript, the emitted JavaScript does not parse ("transformed dynamic workflow source does not parse"), an import is not in the module table ("dynamic workflow import <specifier> is not available"), or the export shape rule fails after the transform |
| `manifest` | "Dynamic workflow manifest changed since approval." | the booted VM's `ready` manifest differs from the approved one |
| `source` | "Dynamic workflow source execution failed: <name>: <message>" | the module body or `run` threw, the module has no valid default definition ("workflow module has no valid default definition"), the return value is not JSON ("Dynamic workflow return value is not JSON."), or the shim refused a host message ("Dynamic workflow host answered an unknown request.", "Dynamic workflow host sent an invalid message.") |
| `protocol` | "Dynamic workflow VM sent an invalid message.", "Dynamic workflow VM message exceeds 17825792 bytes.", "Dynamic workflow VM exceeded 65536 messages.", "Dynamic workflow VM request ids are not contiguous.", "Dynamic workflow VM issued overlapping synchronous calls.", "Dynamic workflow returned an unknown task handle.", "Dynamic workflow bridge requires the static runtime context." | a VM message that fails the RPC schema or bounds, a second `ready`, anything but `failed` before `ready`, a `messageerror`, a returned handle the host never issued, or a context without the host bridge |
| `watchdog` | "Dynamic workflow VM exceeded 30000 ms of compute between host messages." | no VM message for `DYNAMIC_VM_COMPUTE_TIMEOUT_MS` while no barrier is outstanding |
| `memory` | "Dynamic workflow VM exceeded its memory limit." | the worker died with `ERR_WORKER_OUT_OF_MEMORY` under `DYNAMIC_VM_RESOURCE_LIMITS` |
| `exit` | "Dynamic workflow VM exited unexpectedly with code <code>.", "Dynamic workflow VM crashed." | the worker exited before `done`/`failed`, its `error` event fired, or a host fault outside the bridge escaped; the fault's own message may name file system paths, so it travels only as the error's cause and never into the journal |
| `abort` | "Dynamic workflow execution was aborted." | `ctx.signal` aborted and the VM did not finish within `DYNAMIC_VM_ABORT_GRACE_MS` (1000 ms), the context was already aborted before boot, or the worker saw the host's `abort` before `ready` and ended itself (a `failed` named `DynamicAbortError`, mapped to this stage only when the host did abort); the run is already `stopping`, so no `-> failed` is appended |

Not failures: a host reply error is thrown into the source with its `name`
and `message` preserved (`WorkflowMaterializationError`,
`StaticWorkflowRuntimeError`, or `DynamicWorkflowHostError` for
"Dynamic workflow call arguments are invalid.", "Dynamic workflow referenced
an unknown task handle.", and "Dynamic workflow barrier result exceeds
17825792 bytes."), where the source may catch it exactly as static source
catches a materializer error; and a checkpoint park rejects the barrier with
the static runtime's park signal, which the bridge never forwards: it
terminates the VM and rethrows the same signal so the run parks `waiting`
without a failure. The next drive boots a fresh VM.

## Support task sequences

A support execution never enters `waiting` or `cancelling`. Its journal
sequences are:

```text
success:  task-execution-created (kind support)
          → task-execution-support-intended
          → task-status-changed ready→running
          → artifact-declared
          → task-execution-support-output-committed
          → task-execution-terminal (outcome completed, evidence kind support)
          → task-status-changed running→completed

failure:  task-execution-terminal (outcome failed, evidence kind workflow,
          stage support-resolution | support-input | support-execution
          | support-output)
          → task-status-changed running|ready→failed

cancel:   task-execution-terminal (outcome cancelled, evidence kind workflow,
          stage stop)
          → task-status-changed running|ready|pending→cancelled
```

Failure messages are fixed strings; raw implementation error text is never
persisted. The executor races the implementation against the scheduler stop
signal. When abort wins, the execution is terminalized as `cancelled` at stage
`stop` and a late result from an implementation that ignores the signal is
consumed and discarded. Stop persists intent, aborts the signal, cancels a
`running` support task that is not executing in this process (for example after
restart), and waits only for the bounded executor drain of an in-process
execution, never for an implementation that ignores abort. Subagent cleanup and
`cleanup-blocked` behavior are unchanged.

Support recovery fails closed: a second result artifact for the same producer or
a committed artifact that disagrees with the declared one is an output
conflict, and journal, lease, or artifact-store uncertainty is thrown rather
than converted into task failure. See the recovery ladder in
[Persistence and recovery](persistence.md#support-execution-recovery).

## Nested workflow sequences

A nested workflow execution never enters `waiting`. Its journal sequences in
the parent run are:

```text
success:  task-execution-created (kind workflow, childRunId)
          → task-execution-nested-intended
          → task-execution-nested-launched
          → task-status-changed ready→running
          → task-execution-nested-settled (status completed | completed-degraded)
          → artifact-declared
          → task-execution-nested-output-imported
          → task-execution-terminal (outcome completed,
            evidence kind nested-workflow)
          → task-status-changed running→completed

child     task-execution-nested-settled (status failed | cancelled
ended:      | interrupted | cleanup-blocked)
          → task-execution-terminal (outcome failed | cancelled
            | interrupted | cleanup-blocked, evidence kind nested-workflow)
          → task-status-changed running|cancelling→<outcome>

failure:  task-execution-terminal (outcome failed, evidence kind workflow,
          stage nested-input | nested-resolution | nested-launch)
          → task-status-changed ready|running→failed

import:   task-execution-terminal (outcome cleanup-blocked, evidence kind
          workflow, stage nested-import)
          → task-status-changed running→cleanup-blocked

cancel:   task-execution-terminal (outcome cancelled, evidence kind workflow,
          stage stop)                       // before launch only
          → task-status-changed running|ready|pending→cancelled
```

The child's terminal status maps directly onto the parent task outcome:
`completed` and `completed-degraded` complete the task once its output is
imported, and `failed`, `cancelled`, `interrupted`, and `cleanup-blocked` map
to the same-named outcome. A required task that ends `failed` or `cancelled`
fails the parent run, `interrupted` interrupts it, and `cleanup-blocked` marks
the run `cleanup-blocked`; an optional task's failure is visible degradation.

Parent stop persists `stopping`, marks each launched nested task `cancelling`,
stops the child run, and waits for the child's terminal state through the same
settlement path; the parent does not reach its own terminal status before every
child has. The parent deadline uses the same stop path, and the child's
deadline is the earlier of its own timeout and the parent's, so a child never
outlives its parent's deadline. A child with under one second remaining at
launch fails at `nested-launch` without being created.

Artifact inputs are resolved at launch, before intent. A missing or ambiguous
producer artifact, an authored input that is not an object or collides with an
input name, an input that cannot be read and verified from the parent store,
or a merged input that is not lossless JSON, exceeds the 900 KiB bound, or
fails the child's input schema terminalizes the task as `failed` at stage
`nested-input` with a fixed message before any intent is persisted. Once
intent is durable, the merged input is recomputed from the same immutable
artifacts on every launch attempt; a read failure or a digest that differs
from `inputsSha256` or `resolvedInputSha256` is evidence drift and is thrown
as a persistence error ("Nested workflow resolved input drifted from durable
intent."), never converted into a task failure.

Import failure yields `cleanup-blocked` at stage `nested-import`; explicit
parent reconciliation retries the import. A child that itself settled
`cleanup-blocked` is reconciled through parent reconciliation, which
reconciles the child run, waits for its new terminal status, and appends a
replacement settlement. Failure messages are fixed strings. Journal, lease, and
artifact-store uncertainty is thrown rather than converted into task failure.
See the recovery ladder in
[Persistence and recovery](persistence.md#nested-execution-recovery).
