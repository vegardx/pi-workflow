# Authority model

## Principles

- Workflow definitions request capabilities; they do not implement authority.
- The scheduler executes only persisted, validated task declarations.
- Subagent authority is bounded by the selected agent definition and workflow
  task grant.
- Project workflows are trusted code only after Pi project trust.
- Dynamic workflow code is never trusted merely because it runs in a VM.
- Support tasks are trusted registered code executed in the host process; they
  are bundle-contained and never sandboxed.
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
incompatible providers fail before a run starts. The upstream provider is also
revalidated after asynchronous acquisition. The binding exposes a
capability-restricted wrapper containing exactly the owner-client methods, so
extra provider properties such as shutdown cannot cross the adapter. Workflow
cannot shut down or replace the provider, access its
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

Support implementations are registered by trusted embedding code when the
workflow service is constructed. The registry is immutable, never persisted,
and authoritative: a persisted descriptor executes only when a registration
matches its exact canonical identity over name, module specifier, revision,
implementation digest, parameters schema, and output schema. A close match is a
mismatch and fails the execution at `support-resolution`. Implementations are
bundle-contained: they ship with the package that registers them and are never
loaded from a workflow file, a run directory, or a dynamic import. That
implementation identity is part of task and replay identity.

Support implementations execute in the host process with extension-process
authority. Nothing about them is sandboxed and the runtime claims no isolation.
They never receive or launch a subagent, VM, worktree, model, or web request;
the execution context exposes only `parameters`, `inputs`, and `signal`.

Because the runtime recomputes an intended but unfinished support task after a
crash, every implementation must honour the purity contract:

- deterministic: identical parameters and inputs yield an identical output;
- side-effect free outside the return value;
- bounded in time and output size, and cooperative with the supplied
  `AbortSignal`;
- no network access, publication, Git mutation, process administration, or
  credential access.

The runtime verifies identity digests, schemas, size bounds, and abort timing.
It cannot verify determinism or the absence of side effects; those remain trust
obligations of the registering package.
