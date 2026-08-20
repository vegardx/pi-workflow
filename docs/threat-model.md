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
| Support helper | Trusted bundle-contained code with extension-process authority |

A JavaScript or TypeScript worker-thread VM is not an OS security boundary.
Dynamic safety comes from withholding direct capabilities and validating every
host operation. Static workflows and support helpers execute with
extension-process authority and must be trusted by source.

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
