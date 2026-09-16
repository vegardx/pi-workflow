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
| `@vegardx/pi-workflow` | 1.1.0 | `package.json` `version` |
| API version | 1.1.0 | `compatibility.json` `piWorkflow.api.version`; 1.1.0 is additive over 1.0.0: the optional checkpoint prompt view fields, the optional `WorkflowServiceOptions.registeredRoots`, and the package's own builtin workflow root |
| Frozen surfaces | authoring, service, contract, extension | [`docs/contracts.md` "Public API and stability"](contracts.md#public-api-and-stability); `compatibility.json` `piWorkflow.api.frozenSurfaces` |
| Entry points | `.` frozen, `./extension` frozen, `./runtime` unfrozen (engine internals; may change in any minor release); `./package.json` is the manifest, not an API surface | `package.json` `exports`; `compatibility.json` `piWorkflow.api.entryPoints` |
| Pinned export lists | `.`: 182 value exports, `./runtime`: 127 value exports; the two sets are disjoint and deep `dist/` paths are not importable | `test/fixtures/public-api/root-exports.json`, `runtime-exports.json` (`test/public-api.test.ts`, `scripts/check-pack.mjs`) |
| TypeScript module resolution | `node16`, `nodenext`, or `bundler` (types are resolved through the `exports` map; no `typesVersions`; the package itself compiles with `module`/`moduleResolution` `NodeNext`, and `engines.node >=23.6.0` excludes toolchains that need `node10` fallbacks) | `package.json` `exports`, `tsconfig.json` |
| `WORKFLOW_CONTRACT_REVISION` | 18 | `src/contracts-core.ts` (re-exported by `src/contracts.ts`); unchanged by 1.0.0 and 1.1.0: neither the freeze, the checkpoint prompt, nor the builtin root changes a schema, event, identity, or handshake (1.1.0 adds optional view fields only) |
| `WORKFLOW_RUNTIME_CONTRACT.features.checkpoints` | `true` | `src/contracts.ts` |
| `WORKFLOW_RUNTIME_CONTRACT.features.dynamicWorkflows` | `true` (proposed `dynamic:<sha256>` sources run only after a human approval bound to their digest, manifest, host API, and import policy) | `src/contracts.ts` |
| Required `@vegardx/pi-subagent` | `0.10.0` (exact; unchanged by 1.0.0 and 1.1.0) | `package.json` `peerDependencies` |
| Required pi-subagent contract revision | 6 | `WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.contractRevision` |
| pi-subagent commit built in CI | `172bd5eb73d4f2a6bf2ed13a65ac8b9c46ea6faf` | `.github/workflows/ci.yml` |
| Pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-server`, `@earendil-works/pi-tui`) | `>=0.85.0 <0.86` | `package.json` `peerDependencies` |
| Node.js engines | `>=23.6.0` | `package.json` `engines` |
| Node.js in CI | 24.16.0 | `.github/workflows/ci.yml` |
| `typebox` | `>=1.3.14 <2` | `package.json` `peerDependencies` |
| Dynamic source transformer (`amaro`) | `1.2.0` (exact) | `package.json` `dependencies`, `DYNAMIC_TRANSFORMER_VERSION` |
| Builtin workflow root | `workflows/` in the tarball, registered by the shipped extension as scope `builtin`, source `package`; trusted package code that loads without Pi project trust | `package.json` `files` and `pi.workflows`, `src/extension.ts`, `scripts/check-pack.mjs` |

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
| macOS arm64 | Qualified | Real Pi 0.85.0 print-mode sessions on Node.js 24.16.0 loaded the packed extension and ran trusted workflows through pi-subagent Gondolin VMs: single agent task, artifact pipeline, parallel barrier, settled results, fan-out, fan-in, and the pipeline builder. Evidence: the reports under [`docs/qualification/`](qualification/). Those reports record pi-subagent commit `55e84bd731e2017510ee85b2df898e7f2d3679f2`; the current CI pin `172bd5eb73d4f2a6bf2ed13a65ac8b9c46ea6faf` (pi-subagent 0.10.0, contract revision 6) has been verified only by the packed contract check, not by a new host run. 1.0.0 packed tarball qualification: see [`docs/qualification.md`](qualification.md), which records its own status; an unchecked item there is not a claim. |
| Linux x64 | Build-only | GitHub Actions `ubuntu-latest` on Node.js 24.16.0 builds the pinned pi-subagent commit, then runs `npm run check` (Biome, `tsc`, build, Vitest with fake subagent clients, pack check) and `npm audit --audit-level=low`. No real Pi session, model, or Gondolin VM is exercised. |
| Other platforms | Not built | Nothing else is built, tested, or qualified. |

Behaviour covered by unit and packed-contract tests only, with no host run for
1.0.0, is listed under "Unit-tested only" in
[`docs/qualification.md`](qualification.md) (worktree agent tasks and handoff
import among them: no worktree task has been run against a packed pi-subagent
on any host). That list, not this table, is the authoritative statement of
what has not been exercised by hand.
