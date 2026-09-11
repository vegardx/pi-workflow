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
| Checkpoint | No approver, expired, headless block | Waiting or blocked |
| Budget | Cost, optional total-token, or cumulative child-runtime cap reached | Reserve before launch; block inadmissible task; fail post-settlement overage |
| Deadline | Persisted workflow wall deadline reached | Stop and drain; abort in-process support work; cleanup uncertainty remains cleanup-blocked |
| Lease loss | Scheduler ownership lost | Interrupt and reconcile |
| Persistence | Journal, snapshot, intent, receipt, or artifact durability failure | Fail closed |
| Resource/source drift | Workflow, helper, tool, skill, model, or service changed | Invalidate or refuse resume; registry drift fails non-terminal support executions at `support-resolution` |
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
