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
| `@vegardx/pi-workflow` | 4.0.0 | `package.json` `version` |
| API version | 4.0.0 | `compatibility.json` `piWorkflow.api.version`; 4.0.0 is a major because revision 23 refuses revision-22 persisted state (see the `WORKFLOW_CONTRACT_REVISION` row); its one schema change is additive, the optional `startAtInput` on `AgentWorkspaceRequestSchema` and `WorkspaceAuthoringRequest`. 3.0.0 is a major because revision 20 refuses revision-19 persisted state and reads a different root (see the `WORKFLOW_CONTRACT_REVISION` row), and because the Pi peer floor rises to 1.4.0. 2.0.0 was a major for the persisted-state reason alone: contract revision 19 refuses revision-18 persisted state, and `AgentTaskRequestSchema` only gained the optional `memoryBytes` |
| Frozen surfaces | authoring, service, contract, extension | [`docs/contracts.md` "Public API and stability"](contracts.md#public-api-and-stability); `compatibility.json` `piWorkflow.api.frozenSurfaces` |
| Entry points | `.` frozen, `./extension` frozen, `./runtime` unfrozen (engine internals; may change in any minor release), `./components` unfrozen (the component library; frozen from a later minor), `./service-provider` unfrozen (the service-provider seam; frozen from a later minor); `./package.json` is the manifest, not an API surface | `package.json` `exports`; `compatibility.json` `piWorkflow.api.entryPoints` |
| Pinned export lists | `.`: 203 value exports, `./runtime`: 138 value exports; the two sets are disjoint and deep `dist/` paths are not importable | `test/fixtures/public-api/root-exports.json`, `runtime-exports.json` (`test/public-api.test.ts`, `scripts/check-pack.mjs`) |
| TypeScript module resolution | `node16`, `nodenext`, or `bundler` (types are resolved through the `exports` map; no `typesVersions`; the package itself compiles with `module`/`moduleResolution` `NodeNext`, and `engines.node >=23.6.0` excludes toolchains that need `node10` fallbacks) | `package.json` `exports`, `tsconfig.json` |
| `WORKFLOW_CONTRACT_REVISION` | 24 | `src/contracts-core.ts` (re-exported by `src/contracts.ts`); 2.0.0 raised it from 18 to 19 for the pi-subagent revision-7 handshake and the optional `memoryBytes` in agent task identity. 3.0.0 raises it to 20 because run state moves: runs, leases, prune trash, and dynamic proposals are keyed under `<agentDir>/workflow/<projectKey>` instead of `<cwd>/.pi/workflow`, and the location of persisted state is part of the contract ([docs/persistence.md](persistence.md#where-state-lives)). No record shape changes with it. It later gained one feature flag, `serviceProviderStart: true`, and one optional persisted event field, `run-created`'s `origin`, both additive within the revision: a journal written without `origin` still validates, the reducer does not read it, and no identity derivation changes, so the revision does not advance again for it. A consumer pins the feature flag, not the field. It then advanced again to 21, because `WorkflowRunRecordSchema` gained the optional `ceiling` - the host delegation ceiling a run started under, recorded at creation and lowered onto every `SubagentRequest` the run makes. That is persisted state a reader must understand: a reader that ignored it would misread every launch the run made, which is what the revision rule counts rather than the shape of the field. The revision is an input to `hostApiSha256` by construction, so the dynamic host API digest rotates and every existing dynamic source approval is invalidated; nothing else derives identity from it. It then advanced again to 22, because `WorkflowRunRecordSchema` gained the optional `sessionModel` - the host session's model and thinking level the run inherited, resolved once at creation and substituted for every `model: "inherit"` declaration the definition makes. That is persisted state a reader must understand: it is the only place that says which model made the run's work, and a reader that ignored it could not tell a run that inherited from one whose models were written by hand. It then advanced again to 23, because the agent task request's `workspace` gained the optional `startAtInput` - the name of one of the task's own handoff inputs, whose imported `handoffCommit` the launcher resolves at launch and sends pi-subagent as `workspace.startAt`. It is part of the persisted task spec and of task identity, and a reader that ignored it would describe a verifier, a fixer or a review lens as running on the repository baseline when it ran on the hand-off. It then advanced again to 24, because the agent task request gained the optional `continueFrom` - the handoff input whose producer's child run the task continues through pi-subagent's resume at hand-off - and the execution projection the `task-execution-continue-intended` event and its `continue-intended` phase. Both are persisted, the request is part of task identity, and a reader that ignored them would describe a resumed implementer as a fresh launch with no preflight. Revision-24 stores refuse revision-23, revision-22, revision-21, revision-20 and revision-19 leases, journals, snapshots, run records, decision records, and dynamic proposals; state left under an older root or revision is not seen, and there is no migration, no fallback root, and no dual-root reader |
| `WORKFLOW_HANDOFF_FORMAT.revision` | 7 | `src/contracts.ts`; the pi-subagent revision that DEFINES the handoff rendering, which is not the same as the revision currently required. pi-subagent 0.15.0 is revision 9 and renders a handoff identically, so this stays 7: it is an input to `WORKFLOW_HANDOFF_FORMAT_SHA256`, the `schemaSha256` of every handoff artifact, and moving it would fail every existing handoff artifact's verification for no change in the bytes |
| Agent task `memoryBytes` | optional; a positive multiple of 64 MiB up to 4 GiB | `AgentTaskRequestSchema` (pi-subagent `MemoryBytesSchema`); omitted means the agent definition's own ceiling |
| `WORKFLOW_RUNTIME_CONTRACT.features.checkpoints` | `true` | `src/contracts.ts` |
| `WORKFLOW_RUNTIME_CONTRACT.features.dynamicWorkflows` | `true` (proposed `dynamic:<sha256>` sources run only after a human approval bound to their digest, manifest, host API, and import policy) | `src/contracts.ts` |
| `WORKFLOW_RUNTIME_CONTRACT.features.serviceProviderStart` | `true` (the service-provider client exposes `startBuiltin`, gated by the frozen `BUILTIN_STARTABLE_WORKFLOWS`, and `run-created` carries the optional `origin: "service-provider"`; there is no `effort` option - the dial is gone and models are set per role) | `src/contracts.ts` |
| `WORKFLOW_RUNTIME_CONTRACT.features.serviceProviderDecide` | `true` (the same client exposes `decide`, `resume` and `stop`, and `inspect` admits the `"checkpoints"` section; a decision taken through it is filed with `source: "service-provider"`) | `src/contracts.ts` |
| Session model a run inherits | `WorkflowRunRecord.sessionModel`, optional; resolved once at run start from `WorkflowServiceOptions.sessionModel` for a definition whose `meta.needs.sessionModel` is true, and substituted for every `model: "inherit"` before hashing. A host with no session model is refused at start: `<name> inherits the session model, and this host has none.` | `src/session-model.ts`, `src/run-record.ts`, `src/materializer.ts` |
| Required `@vegardx/pi-subagent` | `0.18.0` (exact; raised from `0.17.0` by the resume at hand-off; contract revision unchanged at 10) | `package.json` `peerDependencies` |
| Required pi-subagent contract revision | 10 | `WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.contractRevision` |
| pi-subagent commit built in CI | `e137f338cf32a84cbb22ee0428d24285fc8b5c36` | `.github/workflows/ci.yml` |
| Pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) | `>=1.4.0 <2` (Pi 1.2.0 removed `@earendil-works/pi-server`, which nothing here imported) | `package.json` `peerDependencies` |
| Node.js engines | `>=23.6.0` | `package.json` `engines` |
| Node.js in CI | 24.16.0 | `.github/workflows/ci.yml` |
| `typebox` | `>=1.3.14 <2` | `package.json` `peerDependencies` |
| Dynamic source transformer (`amaro`) | `1.2.0` (exact) | `package.json` `dependencies`, `DYNAMIC_TRANSFORMER_VERSION` |
| Builtin workflow root | `workflows/` in the tarball, registered by the shipped extension as scope `builtin`, source `package`; trusted package code that loads without Pi project trust | `package.json` `files` and `pi.workflows`, `src/extension.ts`, `scripts/check-pack.mjs` |

## Required pi-subagent features

`isCompatibleSubagentContract` accepts a pi-subagent runtime contract only when
it is revision 10 and every feature below has exactly this value.

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
| `agentRootsFirst` | `true` |
| `delegationCeiling` | `true` |
| `sessionModelInherit` | `true` |
| `workspaceStartAt` | `true` |
| `resumeAtHandoff` | `true` |

## Host qualification

| Host | Status | What was exercised |
| --- | --- | --- |
| macOS arm64 | Qualified | **On Pi 0.85.0 only; not re-qualified on Pi 1.4.** The supported Pi range is now `>=1.4.0 <2`, which excludes the Pi this host was qualified against, so this row is a record of the earlier qualification, not a claim about the current range; a host run on Pi 1.4.0 with pi-subagent 0.18.0 is pending. Real Pi 0.85.0 print-mode sessions on Node.js 24.16.0 loaded the packed extension and ran trusted workflows through pi-subagent Gondolin VMs: single agent task, artifact pipeline, parallel barrier, settled results, fan-out, fan-in, and the pipeline builder. Evidence: the reports under [`docs/qualification/`](qualification/). Those reports record pi-subagent commit `55e84bd731e2017510ee85b2df898e7f2d3679f2`; the current CI pin `e137f338cf32a84cbb22ee0428d24285fc8b5c36` (pi-subagent 0.18.0 on Pi 1.4.0, contract revision 10) has been verified only by the packed contract check and the fake-client suite, not by a host run. 1.0.0 packed tarball qualification: see [`docs/qualification.md`](qualification.md), which records its own status; an unchecked item there is not a claim. |
| Linux x64 | Build-only | GitHub Actions `ubuntu-latest` on Node.js 24.16.0 builds the pinned pi-subagent commit, then runs `npm run check` (Biome, `tsc`, build, Vitest with fake subagent clients, pack check) and `npm audit --audit-level=low`. No real Pi session, model, or Gondolin VM is exercised. |
| Other platforms | Not built | Nothing else is built, tested, or qualified. |

Behaviour covered by unit and packed-contract tests only, with no host run for
1.0.0, is listed under "Unit-tested only" in
[`docs/qualification.md`](qualification.md) (worktree agent tasks and handoff
import among them: no worktree task has been run against a packed pi-subagent
on any host). That list, not this table, is the authoritative statement of
what has not been exercised by hand.
