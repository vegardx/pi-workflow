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
- A nested workflow is a linked child run of a definition resolved through the
  same discovery pass and trust gate as its parent; it never receives more than
  the parent's remaining budget and deadline.
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
`pi-workflow:<workflow-run-id>`; a linked child run binds its own owner client
as `pi-workflow:<childRunId>` and never reuses its parent's binding. Model
input cannot choose that owner. The
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

## Nested workflow runs

A nested workflow task executes a linked child run: a separate durable run
with its own journal, lease, artifact store, subagent owner binding
`pi-workflow:<childRunId>`, and run record carrying `depth` and
`parent { runId, taskId, executionId, ancestorDefinitionIdentities }`. The
child is trusted by the same rule as any static workflow: it is resolved by
name from the parent's discovery pass and trust gate, and its identity and
source digest are captured in the parent's task identity at declaration. At
launch the provider must resolve exactly that identity and source; anything
else fails at `nested-resolution`.

The parent scheduler routes by kind to the nested run executor; the child
composes the same runtime as a root run and re-executes its own trusted source.
There is no second scheduler class, no persisted continuation, and no shared
in-memory state between parent and child. The child receives only the authored
input captured at declaration, merged at launch with verified copies of the
parent artifacts named as its `inputs`, a budget no larger than the parent's
reservation and the service caps, and a deadline no later than the parent's. Depth is
bounded (0 through 3), each run may declare at most 64 workflow tasks, and a
definition already on the ancestor chain is rejected at declaration.

Values cross the run boundary in either direction only as verified copies.
Child output enters the parent only by copying verified bytes into the parent
artifact store, bound to the parent task and the captured output schema, before
the parent task completes. Parent artifacts enter a child only by being read
through the parent's verified input path at launch, merged into the child's
input, validated against the child's input schema, and bound by digest into
the child's run record as `parent.inputArtifacts`. Those identities are
provenance, not capabilities: the child holds no handle into the parent
store, the parent holds none into the child's, and no cross-run read authority
exists in any direction.

## Dynamic workflow host API

Dynamic workflow source is untrusted orchestration input executing inside a
trusted process. It is admitted in three human-gated steps, none of which a
model can complete on its own:

1. Proposal. `service.propose` (and the `workflow_propose` tool, which only
   proposes) requires Pi project trust ("Dynamic workflows require project
   trust."), exactly like project static definitions: a run writes under
   `<cwd>/.pi/workflow`, and the source may declare agent tasks against the
   project. The proposal applies the static import gate and the two
   dynamic-only source rules, extracts the manifest in a manifest-only VM, and
   records nothing that grants execution.
2. Approval. Approval is a human decision recorded through a Pi command with
   an explicit `ctx.ui.confirm` (`/workflow approve dynamic:<sha256>` and
   `/workflow reject dynamic:<sha256> [reason…]`, a follow-up on the
   operator surface), never through a model-callable tool: there is no
   `workflow_approve`, `workflow_reject`, or `workflow_proposals` tool, and the
   service accepts only an approver whose `kind` is `"human"` ("Invalid dynamic
   workflow approver."). The decision is one immutable definition-level
   record with the `source-approval` binding, bound to the source digest, the
   manifest digest, `hostApiSha256` (through the definition identity), and
   `importPolicySha256`. A changed source, a changed host API (package
   upgrade), or a changed support registry therefore refuses to run or resume
   until a human approves again; a rejection is equally final ("Dynamic
   workflow source was rejected.").
3. Run. `service.run` and `service.validate` accept `dynamic:<sha256>` only
   for an approved proposal of this project under the current host API and
   import policy, copy the approval into the run directory, and resume only
   from that copy. `service.list()` stays static-only; proposals are visible
   through `service.proposals()`.

Inside the VM, dynamic code receives exactly the `WorkflowContext` the static
runtime provides: task declaration (`agent`, `support`, `workflow`,
`checkpoint`, `finalize`, fan-out, fan-in, pipelines), phases and logs, and
the result, settled, and handoff barriers. Every declaration crosses the RPC
bridge as a bounded JSON message and is validated by the same host
materializer, scheduler, and executors used for static workflows; handles
cross only as references and are resolved by the host against the handles it
issued in this run. A dynamic definition may declare nested static children,
which are resolved through the ordinary discovery pass and trust gate; a
dynamic definition can never be a nested child. Support tasks are declared
through helpers the embedder published with an `exportName`; the source can
describe a support task but never supply an implementation ("Dynamic workflow
source may not register support implementations.").

Dynamic code receives no direct filesystem, process, environment, network,
module import, extension, scheduler, store, credential, or `SubagentService`
object: the context has no `process`, `require`, `fetch`, timers,
`structuredClone`, or `TextEncoder`, `import()` and `eval`/`new Function`
throw, the imports are limited to `@vegardx/pi-workflow`, `typebox`, and the
published support helpers, and the worker runs with an empty environment,
heap limits, and watchdogs. `Date`, `Math.random`, and `console` are patched
so a re-executed drive replays deterministically. These are determinism aids
and API bounds; the worker-thread VM is a determinism and API boundary, not
an OS security boundary, and dynamic code is never trusted merely because it
runs in a VM. What it may do is bounded by what the human approved and by the
runtime policy, agent definitions, and project trust that bound every static
workflow as well.

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
