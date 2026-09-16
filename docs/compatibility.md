# Compatibility matrix

The machine-readable source of this table is [`compatibility.json`](../compatibility.json)
at the repository root. `test/package.test.ts` checks every value against
`package.json`, `src/contracts.ts`, and `.github/workflows/ci.yml`, and
`scripts/check-pack.mjs` checks the packed `WORKFLOW_RUNTIME_CONTRACT` against
the packed pi-subagent `SUBAGENT_RUNTIME_CONTRACT`. Update the JSON first; the
checks fail when this document, the manifest, or the constants disagree.

## Versions and contracts

| Component | Value | Source |
| --- | --- | --- |
| `@vegardx/pi-workflow` | 0.1.0 | `package.json` `version` |
| `WORKFLOW_CONTRACT_REVISION` | 18 | `src/contracts-core.ts` (re-exported by `src/contracts.ts`) |
| `WORKFLOW_RUNTIME_CONTRACT.features.checkpoints` | `true` | `src/contracts.ts` |
| `WORKFLOW_RUNTIME_CONTRACT.features.dynamicWorkflows` | `true` (proposed `dynamic:<sha256>` sources run only after a human approval bound to their digest, manifest, host API, and import policy) | `src/contracts.ts` |
| Required `@vegardx/pi-subagent` | `0.10.0` (exact) | `package.json` `peerDependencies` |
| Required pi-subagent contract revision | 6 | `WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.contractRevision` |
| pi-subagent commit built in CI | `172bd5eb73d4f2a6bf2ed13a65ac8b9c46ea6faf` | `.github/workflows/ci.yml` |
| Pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-server`, `@earendil-works/pi-tui`) | `>=0.85.0 <0.86` | `package.json` `peerDependencies` |
| Node.js engines | `>=23.6.0` | `package.json` `engines` |
| Node.js in CI | 24.16.0 | `.github/workflows/ci.yml` |
| `typebox` | `>=1.3.14 <2` | `package.json` `peerDependencies` |
| Dynamic source transformer (`amaro`) | `1.2.0` (exact) | `package.json` `dependencies`, `DYNAMIC_TRANSFORMER_VERSION` |

## Required pi-subagent features

`isCompatibleSubagentContract` accepts a pi-subagent runtime contract only when
it is revision 6 and every feature below has exactly this value.

| Feature | Required value |
| --- | --- |
| `nativeSessionBackend` | `true` |
| `gondolinSandbox` | `true` |
| `background` | `false` |
| `survivesSeatExit` | `false` |
| `steering` | `true` |
| `followUp` | `true` |
| `structuredOutput` | `true` |
| `preflight` | `true` |
| `idempotentLaunch` | `true` |
| `resume` | `true` |
| `classifiedFailures` | `true` |
| `cumulativeRuntimeBudget` | `true` |
| `costFirstBudgets` | `true` |
| `retryBackoff` | `true` |
| `deepReconciliation` | `true` |
| `worktrees` | `true` |
| `handoffExport` | `true` |
| `publicNetworkEgress` | `true` |
| `explicitResources` | `true` |
| `ambientExtensionsControl` | `true` |
| `hostBrokeredTools` | `true` |

## Host qualification

| Host | Status | What was exercised |
| --- | --- | --- |
| macOS arm64 | Qualified | Real Pi 0.85.0 print-mode sessions on Node.js 24.16.0 loaded the packed extension and ran trusted workflows through pi-subagent Gondolin VMs: single agent task, artifact pipeline, parallel barrier, settled results, fan-out, fan-in, and the pipeline builder. Evidence: the reports under [`docs/qualification/`](qualification/). Those reports record pi-subagent commit `55e84bd731e2017510ee85b2df898e7f2d3679f2`; the current CI pin `172bd5eb73d4f2a6bf2ed13a65ac8b9c46ea6faf` (pi-subagent 0.10.0, contract revision 6) has been verified only by the packed contract check, not by a new host run. |
| Linux x64 | Build-only | GitHub Actions `ubuntu-latest` on Node.js 24.16.0 builds the pinned pi-subagent commit, then runs `npm run check` (Biome, `tsc`, build, Vitest with fake subagent clients, pack check) and `npm audit --audit-level=low`. No real Pi session, model, or Gondolin VM is exercised. |
| Other platforms | Not built | Nothing else is built, tested, or qualified. |

Support tasks, nested workflows, retry and resume attempts, invalidation,
finalizers, interrupted-child retention, worktree tasks with handoff import,
and checkpoints with immutable decision records are covered by unit and
packed-contract tests only; no host qualification report exists for them yet. In particular, no worktree task has
been run against a packed pi-subagent on any host.
