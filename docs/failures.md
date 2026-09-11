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
| Subagent launch/runtime | Child startup, provider, tool, timeout | Classified retry policy |
| Structured output | Terminating schema repair exhausted | Task failure |
| Support task | Unregistered or drifted implementation (`support-resolution`); missing input evidence, input digest mismatch, unreadable inputs, or parameters failing the registered schema (`support-input`); implementation exception (`support-execution`); non-JSON, oversized, schema-invalid, or conflicting output (`support-output`) | Task failure with a fixed message; a required task fails the run |
| Nested workflow | Undiscovered name, depth bound, recursion, or schema-invalid input at declaration (materialization failure); child not resolvable by exact identity and source at launch (`nested-resolution`); no remaining time before the parent deadline, lease or record creation failure, or an existing child run that does not match the intent (`nested-launch`); child output unreadable, unverifiable, or schema-invalid (`nested-import`) | Declaration failures fail the run closed; `nested-resolution` and `nested-launch` fail the task; `nested-import` leaves the task `cleanup-blocked` until reconciliation; a required task propagates to the run |
| Checkpoint | No approver, expired, headless block | Waiting or blocked |
| Budget | Cost, optional total-token, or cumulative child-runtime cap reached; a nested child's declared budget does not fit the parent's remaining budget | Reserve before launch; block inadmissible task; fail post-settlement overage; incomplete child usage fails closed |
| Deadline | Persisted workflow wall deadline reached | Stop and drain; abort in-process support work; stop linked child runs through their parent tasks; cleanup uncertainty remains cleanup-blocked |
| Lease loss | Scheduler ownership lost | Interrupt and reconcile |
| Persistence | Journal, snapshot, intent, receipt, or artifact durability failure | Fail closed |
| Resource/source drift | Workflow, helper, tool, skill, model, or service changed | Invalidate or refuse resume; registry drift fails non-terminal support executions at `support-resolution`; child source drift fails replay of the parent as declaration drift |
| Finalizer | Required artifact import, cleanup, or release failed | Cleanup-blocked or failed |
| Unknown | Unclassified or unprovable state | Interrupt and reconcile |

Retryability is a stable code-level property combined with explicit workflow
policy, never string matching. Retry and resume preserve prior executions,
usage, artifacts, and budget consumption.

A task result cannot override persistence, lease, cleanup, or artifact-import
failure. An advisory observation failure cannot replace an otherwise valid
required result, but remains visible as degradation evidence when policy permits.

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
          stage nested-resolution | nested-launch)
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

Import failure yields `cleanup-blocked` at stage `nested-import`; explicit
parent reconciliation retries the import. A child that itself settled
`cleanup-blocked` is reconciled through parent reconciliation, which
reconciles the child run, waits for its new terminal status, and appends a
replacement settlement. Failure messages are fixed strings. Journal, lease, and
artifact-store uncertainty is thrown rather than converted into task failure.
See the recovery ladder in
[Persistence and recovery](persistence.md#nested-execution-recovery).
