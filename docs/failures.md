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
| Support task | Helper exception or invalid output | Task failure |
| Checkpoint | No approver, expired, headless block | Waiting or blocked |
| Budget | Run/task/token/cost/time cap reached | Stop new work; explicit terminal result |
| Lease loss | Scheduler ownership lost | Interrupt and reconcile |
| Persistence | Journal, snapshot, intent, receipt, or artifact durability failure | Fail closed |
| Resource/source drift | Workflow, helper, tool, skill, model, or service changed | Invalidate or refuse resume |
| Finalizer | Required artifact import, cleanup, or release failed | Cleanup-blocked or failed |
| Unknown | Unclassified or unprovable state | Interrupt and reconcile |

Retryability is a stable code-level property combined with explicit workflow
policy, never string matching. Retry and resume preserve prior executions,
usage, artifacts, and budget consumption.

A task result cannot override persistence, lease, cleanup, or artifact-import
failure. An advisory observation failure cannot replace an otherwise valid
required result, but remains visible as degradation evidence when policy permits.
