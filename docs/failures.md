# Failure taxonomy

| Class | Examples | Default effect |
| --- | --- | --- |
| Definition | Invalid module, duplicate name/key, unsupported source change | Fail before run |
| Trust | Untrusted project workflow/helper | Block for trust decision |
| Validation | Invalid input, output schema, task request | Fail task/run by policy |
| Dependency | Required predecessor failed or artifact missing | Block dependent task |
| Subagent preflight | Missing feature, tool, model, trust, workspace | Fail before launch |
| Subagent launch/runtime | Child startup, provider, tool, timeout | Classified retry policy |
| Structured output | Repair exhausted | Task failure |
| Support task | Helper exception or invalid output | Task failure |
| Checkpoint | No approver, expired, headless block | Waiting/blocked |
| Budget | Run/task/token/cost/time cap reached | Stop new work; explicit terminal result |
| Lease loss | Scheduler ownership lost | Interrupt and reconcile |
| Persistence | Journal/snapshot/artifact durability failure | Fail closed |
| Resource/source drift | Workflow/helper/tool/skill changed | Invalidate or require explicit restart |
| Finalizer | Required cleanup/import failed | Cleanup-blocked or failed |
| Unknown | Unclassified or unprovable state | Interrupt and reconcile |

Retryability is a stable code-level property plus workflow policy, not string
matching. Retry and resume preserve prior attempts, usage, artifacts, and budget
consumption.
