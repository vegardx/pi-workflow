# pi-workflow

Custom workflow runtime for [Pi](https://pi.dev).

This repository is in the implementation-ready contract phase. It does not yet
ship a working extension.

## Goal

Provide one reusable workflow engine with:

- trusted TypeScript workflow authoring and a later bounded dynamic frontend;
- typed task/artifact handles that materialize a declarative durable graph;
- stable tasks, explicit order/data dependencies, parallelism, pipelines, and
  bounded fan-out/fan-in;
- schema-validated agent results and deterministic support tasks;
- append-only lifecycle state, leases, fencing, resume, retry, replay, and
  reconciliation;
- fail-closed persistence, required finalizers, and bounded UI;
- physical child execution delegated to the exact extension-owned
  `SubagentService`.

```text
TypeScript effects
      ↓
validated TaskSpec graph
      ↓
journal + scheduler + recovery
      ↓
shared pi-subagent service
```

Workflows without result-dependent branches can materialize their complete DAG
before execution. Data-dependent workflows materialize the same graph
incrementally across explicit result barriers.

`pi-workflow` owns orchestration. It does not spawn private child runtimes or
own publication, push, pull-request, merge, release, or deployment policy.

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
agent run and attempt. Its extension registers a lazy provider on Pi's event bus.
Workflow acquires that exact service through the public typed provider export,
checks the exact runtime contract, and never constructs or shuts down a second
execution service.

## Development

Until `@vegardx/pi-subagent` is published, development resolves it from the
sibling `../pi-subagent` checkout. CI checks out the exact qualified commit and
builds it before running:

```text
npm run check
```

## License

MIT
