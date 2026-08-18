# pi-workflow

Custom workflow runtime for [Pi](https://pi.dev).

This repository is in the contract-definition phase. It does not yet ship a
working extension.

## Goal

Provide one reusable workflow engine with:

- trusted TypeScript workflows and a later bounded dynamic mode;
- explicit stages, stable tasks, parallelism, pipelines, and fan-out/fan-in;
- schema-validated agent results and deterministic support tasks;
- append-only lifecycle state, resume, retry, replay, and reconciliation;
- fail-closed checkpoints, cleanup finalizers, and bounded UI;
- child execution delegated to one typed `SubagentService`.

`pi-workflow` owns orchestration. It does not spawn private child runtimes,
implement publication, or define Maestro delivery policy.

## Documentation

- [Glossary](docs/glossary.md)
- [Architecture](docs/architecture.md)
- [Contracts](docs/contracts.md)
- [Authority model](docs/authority.md)
- [Persistence and recovery](docs/persistence.md)
- [Failure taxonomy](docs/failures.md)
- [Threat model](docs/threat-model.md)
- [Acceptance inventory](docs/acceptance.md)
- [Implementation research](docs/research.md)
- [Research source ledger](docs/research-sources.md)
- [Roadmap](docs/roadmap.md)

## Dependency

[`pi-subagent`](https://github.com/vegardx/pi-subagent) owns every physical
agent run and attempt. Workflow consumes its versioned service capability.

## License

MIT
