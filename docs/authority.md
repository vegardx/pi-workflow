# Authority model

## Principles

- Workflow definitions request capabilities; they do not implement authority.
- Subagent authority is bounded by the selected agent definition and the
  workflow task grant.
- Project workflows are trusted code only after Pi project trust.
- Dynamic workflow code is never trusted merely because it runs in a VM.
- Support tasks are trusted local code and must be bundle-contained.
- Worktree and sandbox requirements fail closed.
- Publication, pushing, and PR creation are outside this runtime.

## Effective agent-task grant

```text
workflow definition request
  ∩ workflow policy
  ∩ agent definition ceiling
  ∩ SubagentService capabilities
  ∩ project trust
  = subagent request
```

The workflow runtime calls the versioned subagent `preflight` operation and
persists its resolved launch-plan identity before idempotent launch. It does not
infer authority from prompts or tool names after launch.

## Static workflow trust

User-global and package workflows are trusted according to their installation
source. Project workflows load only when Pi marks the project trusted.

A trusted workflow can still make dangerous requests; runtime policy and human
checkpoints remain applicable.

## Dynamic workflow host API

Dynamic code receives only bounded operations such as `agent`, `parallel`,
`phase`, `artifact`, and `checkpoint`. It receives no direct filesystem,
process, environment, network, module import, extension, store, or credential
object.

Host operations validate task limits, stable keys, capabilities, and budget.

## Deterministic support tasks

Support helpers must be explicit bundle-relative modules with declared input and
output schemas. Their source identity is included in task/replay identity. They
run with extension-process authority and are therefore trusted code, not a
sandbox substitute.
