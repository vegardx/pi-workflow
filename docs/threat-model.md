# Threat model

## Protected properties

- Untrusted project workflows do not execute before Pi project trust.
- Dynamic code cannot directly access extension internals, credentials, stores,
  filesystem, process, environment, modules, or network.
- Workflow state does not claim child launch/completion without subagent
  receipts.
- Replay never applies a result to a different effective task identity.
- Required cleanup/finalizers cannot be hidden by a successful model result.

## Trust boundaries

| Boundary | Assumption |
| --- | --- |
| Installed package workflow | Trusted installed code |
| User-global static workflow | Trusted user code |
| Project static workflow/helper | Untrusted until Pi project trust |
| Dynamic workflow script | Untrusted orchestration input constrained by host operations |
| SubagentService | Trusted execution service with independent authority checks |
| Model output/external content | Untrusted data |
| Support helper | Trusted bundle-contained code with extension-process authority |

A JavaScript/TypeScript VM is not an OS security boundary. Dynamic safety comes
from the narrow host API and host-side validation. Static workflows and support
helpers execute with extension-process authority and must be trusted by source.

## Artifacts

Artifacts may contain source code, prompts, external content, or secrets read by
a child. Stores are private, bounded, and redacted where possible. Artifact
references include digest and source-run ownership. Import from subagent storage
copies or pins verified bytes into workflow-owned storage before the subagent
retention policy may delete them.

## Publication

Workflow results do not grant push, PR, merge, release, or deployment authority.
Those are downstream interactive-seat decisions.
