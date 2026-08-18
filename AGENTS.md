# AGENTS.md

`pi-workflow` is a custom workflow engine for Pi. It schedules tasks and owns
workflow state while delegating all physical agent execution to pi-subagent.

## Contract discipline

- Treat the glossary and public contracts as the source of truth for terminology
  and ownership.
- Update contracts, state transitions, authority rules, persistence, and
  acceptance coverage when behavior changes.
- Do not claim behavior that is not implemented and validated.

## Design rules

- Depend only on pi-subagent's versioned public service capability.
- Never create a private second subagent runtime.
- A workflow run, task, and subagent run/attempt are distinct identities.
- Separate order dependencies from data dependencies.
- Static project workflows are trusted code and require Pi project trust.
- Dynamic workflow VMs are determinism boundaries, not security boundaries.
- Persist intent before external side effects; recovery fails closed.
- Explicit worktree/sandbox requirements cannot degrade to shared execution.
- Use schema tools for control-plane output; do not parse JSON from prose.
- Do not add Maestro plans, publication, PR, or distro-specific policy.

## Engineering

- TypeScript strict mode, tabs, double quotes, Biome defaults.
- Test observable behavior and every failure transition.
- Keep public contracts versioned and compatibility explicit.
- Use Conventional Commits.
