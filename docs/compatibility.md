# Compatibility matrix

The machine-readable source of this table is [`compatibility.json`](../compatibility.json)
at the repository root. `test/package.test.ts` checks every value against
`package.json`, `src/contracts.ts`, and `.github/workflows/ci.yml`, and
`scripts/check-pack.mjs` checks the packed `WORKFLOW_RUNTIME_CONTRACT` against
the packed pi-subagent `SUBAGENT_RUNTIME_CONTRACT`, the `piWorkflow.api` block
against the packed manifest, and the packed `.` and `./runtime` entry points
against the pinned export lists under `test/fixtures/public-api/`. Update the
JSON first; the checks fail when this document, the manifest, or the constants
disagree.

## Versions and contracts

| Component | Value | Source |
| --- | --- | --- |
| `@vegardx/pi-workflow` | 2.0.0 | `package.json` `version` |
| API version | 2.0.0 | `compatibility.json` `piWorkflow.api.version`; 2.0.0 is a major because contract revision 19 refuses revision-18 persisted state (see the `WORKFLOW_CONTRACT_REVISION` row). No frozen export was removed, renamed, or retyped: `AgentTaskRequestSchema` only gained the optional `memoryBytes`. The unreleased release is a major for the same reason: revision 20 refuses revision-19 persisted state and reads a different root |
| Frozen surfaces | authoring, service, contract, extension | [`docs/contracts.md` "Public API and stability"](contracts.md#public-api-and-stability); `compatibility.json` `piWorkflow.api.frozenSurfaces` |
| Entry points | `.` frozen, `./extension` frozen, `./runtime` unfrozen (engine internals; may change in any minor release), `./components` unfrozen (the component library; frozen from a later minor), `./service-provider` unfrozen (the service-provider seam; frozen from a later minor); `./package.json` is the manifest, not an API surface | `package.json` `exports`; `compatibility.json` `piWorkflow.api.entryPoints` |
| Pinned export lists | `.`: 184 value exports, `./runtime`: 138 value exports; the two sets are disjoint and deep `dist/` paths are not importable | `test/fixtures/public-api/root-exports.json`, `runtime-exports.json` (`test/public-api.test.ts`, `scripts/check-pack.mjs`) |
| TypeScript module resolution | `node16`, `nodenext`, or `bundler` (types are resolved through the `exports` map; no `typesVersions`; the package itself compiles with `module`/`moduleResolution` `NodeNext`, and `engines.node >=23.6.0` excludes toolchains that need `node10` fallbacks) | `package.json` `exports`, `tsconfig.json` |
| `WORKFLOW_CONTRACT_REVISION` | 20 | `src/contracts-core.ts` (re-exported by `src/contracts.ts`); 2.0.0 raised it from 18 to 19 for the pi-subagent revision-7 handshake and the optional `memoryBytes` in agent task identity. The unreleased release raises it to 20 because run state moves: runs, leases, prune trash, and dynamic proposals are keyed under `<agentDir>/workflow/<projectKey>` instead of `<cwd>/.pi/workflow`, and the location of persisted state is part of the contract ([docs/persistence.md](persistence.md#where-state-lives)). No record shape changes with it. The revision is an input to `hostApiSha256` by construction, so the dynamic host API digest rotates and every existing dynamic source approval is invalidated; nothing else derives identity from it. Revision-20 stores refuse revision-19 leases, journals, snapshots, run records, decision records, and dynamic proposals; state left under the old root is not seen, and there is no migration, no fallback root, and no dual-root reader |
| `WORKFLOW_HANDOFF_FORMAT.revision` | 7 | `src/contracts.ts`; the pi-subagent revision that defines the handoff rendering. It is an input to `WORKFLOW_HANDOFF_FORMAT_SHA256`, the `schemaSha256` of every handoff artifact, so revision-18 handoff artifacts do not verify under revision 19 |
| Agent task `memoryBytes` | optional; a positive multiple of 64 MiB up to 4 GiB | `AgentTaskRequestSchema` (pi-subagent `MemoryBytesSchema`); omitted means the agent definition's own ceiling |
| `WORKFLOW_RUNTIME_CONTRACT.features.checkpoints` | `true` | `src/contracts.ts` |
| `WORKFLOW_RUNTIME_CONTRACT.features.dynamicWorkflows` | `true` (proposed `dynamic:<sha256>` sources run only after a human approval bound to their digest, manifest, host API, and import policy) | `src/contracts.ts` |
| Required `@vegardx/pi-subagent` | `0.12.0` (exact; raised from `0.11.0` by request-supplied agent roots) | `package.json` `peerDependencies` |
| Required pi-subagent contract revision | 7 | `WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.contractRevision` |
| pi-subagent commit built in CI | `8d0c344ce4e86831567b5831fb9eb490d7adde73` | `.github/workflows/ci.yml` |
| Pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-server`, `@earendil-works/pi-tui`) | `>=0.85.0 <0.86` | `package.json` `peerDependencies` |
| Node.js engines | `>=23.6.0` | `package.json` `engines` |
| Node.js in CI | 24.16.0 | `.github/workflows/ci.yml` |
| `typebox` | `>=1.3.14 <2` | `package.json` `peerDependencies` |
| Dynamic source transformer (`amaro`) | `1.2.0` (exact) | `package.json` `dependencies`, `DYNAMIC_TRANSFORMER_VERSION` |
| Builtin workflow root | `workflows/` in the tarball, registered by the shipped extension as scope `builtin`, source `package`; trusted package code that loads without Pi project trust | `package.json` `files` and `pi.workflows`, `src/extension.ts`, `scripts/check-pack.mjs` |

## Required pi-subagent features

`isCompatibleSubagentContract` accepts a pi-subagent runtime contract only when
it is revision 7 and every feature below has exactly this value.

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
| `vmMemoryCeiling` | `true` |
| `workspaceBudgetRefusal` | `true` |
| `publicNetworkEgress` | `true` |
| `explicitResources` | `true` |
| `ambientExtensionsControl` | `true` |
| `hostBrokeredTools` | `true` |

## Host qualification

| Host | Status | What was exercised |
| --- | --- | --- |
| macOS arm64 | Qualified | Real Pi 0.85.0 print-mode sessions on Node.js 24.16.0 loaded the packed extension and ran trusted workflows through pi-subagent Gondolin VMs: single agent task, artifact pipeline, parallel barrier, settled results, fan-out, fan-in, and the pipeline builder. Evidence: the reports under [`docs/qualification/`](qualification/). Those reports record pi-subagent commit `55e84bd731e2017510ee85b2df898e7f2d3679f2`; the current CI pin `8d0c344ce4e86831567b5831fb9eb490d7adde73` (pi-subagent 0.12.0, contract revision 7) has been verified only by the packed contract check, not by a new host run. 1.0.0 packed tarball qualification: see [`docs/qualification.md`](qualification.md), which records its own status; an unchecked item there is not a claim. |
| Linux x64 | Build-only | GitHub Actions `ubuntu-latest` on Node.js 24.16.0 builds the pinned pi-subagent commit, then runs `npm run check` (Biome, `tsc`, build, Vitest with fake subagent clients, pack check) and `npm audit --audit-level=low`. No real Pi session, model, or Gondolin VM is exercised. |
| Other platforms | Not built | Nothing else is built, tested, or qualified. |

Behaviour covered by unit and packed-contract tests only, with no host run for
1.0.0, is listed under "Unit-tested only" in
[`docs/qualification.md`](qualification.md) (worktree agent tasks and handoff
import among them: no worktree task has been run against a packed pi-subagent
on any host). That list, not this table, is the authoritative statement of
what has not been exercised by hand.
