# Threat model

## Protected properties

- Untrusted project workflows do not execute before Pi project trust.
- The scheduler executes only committed, validated task declarations.
- Dynamic code cannot directly access extension internals, credentials, stores,
  filesystem, process, environment, modules, network, scheduler, or service.
- Workflow state does not claim child launch or completion without subagent
  receipts.
- Uncertain launch recovery does not duplicate a child operation.
- Replay never applies a result to a different effective task identity.
- Required artifact import, cleanup, and finalizers cannot be hidden by a
  successful model result.
- Missing, duplicate, or incompatible service providers fail before work starts.
- Support implementations run only after durable intent and exact registry
  resolution; a completed support result replays from its digest-verified
  artifact and is never recomputed under a drifted implementation.
- Support tasks never launch a subagent, VM, worktree, model, or web request.
- A nested workflow runs only a definition resolved through the parent's
  discovery pass and trust gate, at exactly the identity and source digest
  captured in the parent's task identity, under a budget and deadline no larger
  than the parent's; nesting depth, per-run workflow task count, and recursion
  along the ancestor chain are bounded at declaration.
- Child output reaches the parent only as verified bytes copied into the
  parent store; no cross-run artifact reference exists.

## Trust boundaries

| Boundary | Assumption |
| --- | --- |
| Installed package workflow | Trusted installed code |
| User-global static workflow | Trusted user code |
| Project static workflow/helper | Untrusted until Pi project trust |
| Dynamic workflow script | Untrusted orchestration input constrained by host operations |
| Pi process event bus | Trusted extension-composition mechanism, not authorization |
| SubagentService | Trusted execution service with independent authority checks |
| Model output/external content | Untrusted data |
| Support implementation | Trusted registered package code executing in the host process with extension-process authority; not sandboxed |
| Support constructor registry | Trusted embedder composition; authoritative for implementation identity, never persisted, resolved again on every restart |
| Linked child workflow run | Trusted static workflow of the same provenance class as its parent; a separate durable run with its own journal, lease, store, and owner binding, bounded by the parent's reservation and deadline |

A JavaScript or TypeScript worker-thread VM is not an OS security boundary.
Dynamic safety comes from withholding direct capabilities and validating every
host operation. Static workflows and support implementations execute with
extension-process authority and must be trusted by source.

The support purity contract (deterministic for identical parameters and inputs,
side-effect free outside the return value, bounded, cooperative with
`AbortSignal`, and free of network, publication, Git mutation, process
administration, and credential access) is an obligation on trusted code. The
runtime verifies identity digests, schemas, size bounds, and abort timing; it
does not and cannot verify determinism or the absence of side effects, and a
recomputation after a crash relies on that contract.

The primary operational threat is accidental destructive or inconsistent
behavior: duplicate launch after crash, stale scheduler writes, implicit data
flow, replay under changed identity, or cleanup reported as success. The design
does not claim protection from malicious installed extensions sharing the host
process.

## Handles and materialization

Task and artifact handles are scoped to one run. Foreign, stale, unknown, or
ambiguous handles fail closed. A declaration is persisted before scheduler
readiness. Stable keys are necessary but not sufficient for replay; full
request, dependency, source, schema, runtime, and resource identity must match.

Result-dependent workflow branches may reveal the graph incrementally. The
runtime never claims that undiscovered branches were validated or approved.

Nested workflows are bounded resource consumers, not a recursion facility:
`MAX_NESTED_WORKFLOW_DEPTH = 4` limits runs to depth 0 through 3, each run may
declare at most 64 workflow tasks, and a child whose definition identity is
already on the ancestor chain is rejected at declaration. Unbounded recursion
remains a non-goal. A child can never spend beyond its parent's reservation or
outlive its parent's deadline, and a child run directory that does not match
the parent's durable intent is never adopted.

## Service provider

The pi-subagent provider is discovered over Pi's event bus. Any installed
extension is already trusted host code and could participate in that bus.
Duplicate responses therefore fail rather than selecting by load order. The
workflow validates the exact runtime contract and binds an owner client before
preflight. Run IDs are not bearer credentials.

## Artifacts

Artifacts may contain source code, prompts, external content, or secrets read by
a child. Stores are private, bounded, and redacted where possible. Artifact
references include digest and source ownership. Import from subagent storage
copies verified bytes into workflow-owned storage before independent subagent
retention may remove them.

## Publication

Workflow results grant no push, pull-request, merge, release, deployment, or
other publication authority. Those operations belong to a separate downstream
interactive decision boundary.
