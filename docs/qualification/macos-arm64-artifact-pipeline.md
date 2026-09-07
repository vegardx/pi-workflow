# Artifact pipeline qualification — macOS arm64

Date: 2026-09-07

## Environment

| Component | Qualified value |
| --- | --- |
| Host | macOS 26.6.2, arm64 |
| Node.js | 24.16.0 |
| Pi | 0.85.0 |
| Model | `github-copilot/gpt-5.6-luna:low` |
| pi-web | `d747380f97d9785c0d083e756e15dcf8fb8358b1` |
| pi-subagent | `55e84bd731e2017510ee85b2df898e7f2d3679f2` |
| pi-workflow | `641eba7e3007a675fbfaeeb3e36eb63782a07a81` |

The Radical AI extension emitted an unrelated warning that its tested Pi range
ended before 0.85. The selected GitHub Copilot model and owned workflow,
subagent, and web extensions loaded normally.

## Real two-agent pipeline

A fresh Pi print-mode process explicitly loaded the packaged workflow extension.
A trusted project workflow declared a producer and consumer in one complete DAG.
The consumer named the producer result as its `source` input. Both tasks used the
shared extension-owned pi-subagent service and separate Gondolin VMs.

```text
workflow_a4c0c646db514ff78ba6acd45768e6ef
PIPELINE_QUALIFICATION_OK
received: pipeline-token
digest: 1ad40e3e44a474f5e5ec5870b1175558236cc8a1deeaa0e49951e27ef8f69af7
```

The producer returned canonical JSON:

```json
{"value":"pipeline-token"}
```

Its workflow-owned artifact was 26 bytes with the same SHA-256 digest returned
by the consumer. Before the second preflight, workflow resolved the named handle
from its artifact store and projected a canonical untrusted-data envelope into
the concrete delegated context. The consumer returned the expected value and
digest without receiving a workflow store path.

Durable evidence proved:

- two task declarations with an explicit data and order dependency;
- producer readiness, launch receipt, completed settlement, artifact import,
  release, terminal execution, and task completion;
- consumer readiness only after producer completion;
- a distinct consumer launch receipt and Gondolin attempt;
- consumer artifact import, release, terminal execution, and task completion;
- final workflow output artifact commit and `finalizing -> completed`;
- exactly two child launches and no remaining QEMU process.

The producer used 179 total model tokens over 2,717 ms. The consumer used 351
total model tokens over 2,709 ms. Both reported proved sandbox cleanup and no
workspace cleanup requirement.

No API-key, authorization, bearer, Exa-key, or Context7-key marker appeared in
the workflow run record, journal, or workflow-owned artifacts.

## Restart coverage

The launcher test suite also rotates the workflow lease after producer
completion, reopens the journal and artifact store, revalidates the persisted
producer artifact, and proves that the reconstructed consumer preflight receives
the exact projected value. Corrupt, missing, foreign-run, incomplete-producer,
schema-drift, invalid-value, oversized-entry, aggregate-size, ordering, and
multi-input cases fail before subagent preflight.

## Result

Workflow-owned canonical JSON now forms a qualified, bounded, restart-safe data
boundary between sequential read-only agent tasks. File and directory inputs,
writer worktrees, and portable handoff remain unavailable pending an explicit
pi-subagent export contract.
