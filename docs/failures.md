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
| Invalidation | Service `invalidate` on a run still being driven, whose status is not `failed` or `interrupted`, that is a nested child run ("Nested workflow runs are invalidated through their parent run."), that already holds on-path invalidated work ("Workflow run already awaits recovery of invalidated work."), or whose deadline has passed ("Workflow run deadline has passed."); a `task-invalidated` event while a current execution is non-terminal ("workflow run has active task executions"), under a run status outside `running`, `waiting`, `failed`, and `interrupted` ("workflow run status does not admit invalidation"), for an unknown or already-invalidated cause, for a closure task that already holds 16 generations ("task execution generation bound exceeded"), or with a closure or abandoned-epoch set other than the computed one; a declaration beyond the on-path prefix reusing an abandoned key with a different identity ("abandoned task key re-declared with a changed request"); an execution created for an abandoned task, out of contiguous order, beyond generation 16, or while the task still has a current execution (active, or terminal and not yet detached by re-materialization); a closure task whose status admits no `invalidated` transition (for example `cleanup-blocked`) | Service rejection (`conflict` or `validation`) without a journal change; reducer rejection fails the append closed; the materialization error fails the run closed; abandoned work is never scheduled |
| Structured output | Terminating schema repair exhausted | Task failure |
| Support task | Unregistered or drifted implementation (`support-resolution`); missing input evidence, input digest mismatch, unreadable inputs, or parameters failing the registered schema (`support-input`); implementation exception (`support-execution`); non-JSON, oversized, schema-invalid, or conflicting output (`support-output`) | Task failure with a fixed message; a required task fails the run |
| Nested workflow | Undiscovered name, depth bound, recursion, schema-invalid input without artifact inputs, non-object authored input or an authored key colliding with an input name when artifact inputs are declared, or an unknown, foreign, or undeclared input producer at declaration (materialization failure); missing or ambiguous producer artifact, unreadable or unverifiable input, or a merged input that is not lossless JSON, exceeds 900 KiB, or fails the child schema at launch (`nested-input`); child not resolvable by exact identity and source at launch (`nested-resolution`); no remaining time before the parent deadline, lease or record creation failure, or an existing child run whose lineage, definition, merged input, or injected artifacts do not match the intent (`nested-launch`); child output unreadable, unverifiable, or schema-invalid (`nested-import`) | Declaration failures fail the run closed; `nested-input`, `nested-resolution`, and `nested-launch` fail the task; `nested-import` leaves the task `cleanup-blocked` until reconciliation; a required task propagates to the run |
| Checkpoint | No approver, expired, headless block | Waiting or blocked |
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
`interrupted`; no service surface appends them in revision 16.

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
