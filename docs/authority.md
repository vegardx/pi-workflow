# Authority model

## Principles

- Workflow definitions request capabilities; they do not implement authority.
- The scheduler executes only persisted, validated task declarations.
- Subagent authority is bounded by the selected agent definition and workflow
  task grant.
- Project workflows are trusted code only after Pi project trust.
- Dynamic workflow code is never trusted merely because it runs in a VM.
- Support tasks are trusted local code and must be bundle-contained.
- Worktree and sandbox requirements fail closed.
- Publication, push, pull requests, merge, release, and deployment are outside
  this runtime.

## Effective agent-task grant

```text
workflow definition request
  ∩ workflow runtime policy
  ∩ agent definition ceiling
  ∩ SubagentService capabilities
  ∩ project trust
  = subagent preflight request
```

The workflow runtime persists the exact resolved preflight identity before
idempotent launch. It does not infer authority from prompts, task names, model
output, or tool names after launch.

## Service authority

The `pi-subagent` extension owns service creation and shutdown. `pi-workflow`
acquires it through Pi's process-local event bus and the public typed provider
export. Provider discovery is composition among trusted extensions, not an
authorization boundary.

Workflow binds an owner client to its durable run identity as
`pi-workflow:<workflow-run-id>`. Model input cannot choose that owner. The
session-scoped adapter pins the exact first service object and reacquires before
each binding, so missing, duplicate, removed, replaced, malformed, or
incompatible providers fail before a run starts. The binding exposes only the
owner client. Workflow cannot shut down or replace the provider, access its
private stores, or construct a fallback service.

## Static workflow trust

User-global and package workflows are trusted according to their installation
source. Project workflows load only when Pi marks the project trusted.

Static workflow code executes with extension-process authority. The bounded
`WorkflowContext` reduces coupling but is not a sandbox. Runtime policy and
human checkpoints still apply to dangerous task requests from trusted code.

## Handles and graph validation

Task and artifact handles are opaque capabilities scoped to one workflow run.
The materializer rejects foreign-run handles, unknown producers, duplicate
keys, cycles in the currently known graph, undeclared artifact reads, and
requests exceeding policy limits.

An order dependency grants readiness ordering only. A data dependency must name
a verified artifact handle. The scheduler never passes all predecessor output
implicitly.

## Dynamic workflow host API

Dynamic code receives only bounded operations such as task declaration, result
barriers, phases, artifacts, and checkpoints. Calls cross RPC and are validated
by the same host materializer used by static workflows.

Dynamic code receives no direct filesystem, process, environment, network,
module import, extension, scheduler, store, credential, or `SubagentService`
object. The worker-thread VM is not an OS security boundary.

## Deterministic support tasks

Support helpers are explicit bundle-relative modules with declared input and
output schemas. Their source identity is included in task and replay identity.
They run with extension-process authority and are trusted code, not a sandbox
substitute. Project-local helpers require the same project trust as their
workflow definition.
