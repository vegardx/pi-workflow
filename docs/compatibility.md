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
| `@vegardx/pi-workflow` | 8.0.0 | `package.json` `version` |
| API version | 8.0.0 | `compatibility.json` `piWorkflow.api.version`; 8.0.0 is a major because revision 27 refuses revision-26 persisted state (see the `WORKFLOW_CONTRACT_REVISION` row), and because the model tiers become `fast | light | normal | frontier` with the old names refused, the stand-in model constants (`MODEL_PROVIDER`, `MODEL_ID`, `DIVERSE_MODEL_ID`, `THINKING_BY_TIER`, `tierModel`), `Envelope.model` and the review fan-out's `diversity` seam are removed, `WorkflowServiceOptions.modelRouting` becomes a provider function, every builtin declares `needs.modelRouting` and is refused at start on a host with no router, and the review record moves to revision 2 with adjudication; the root gains `registerModelRoutingProvider`, `resolveModelRouting`, `ModelRoutingProviderError`, `modelRoutingRefusalMessage` and `ModelResolutionEvidenceSchema`, and `SettledTaskResult` the optional `model`. 7.0.0 is a major because revision 26 refuses revision-25 persisted state (see the `WORKFLOW_CONTRACT_REVISION` row), and because `WorkflowSubagentBinding` gains the required `maxSlots` (the host's VM slots, which clamp a run's concurrency) and `WORKFLOW_RUNTIME_CONTRACT.requiredSubagent` no longer carries pi-subagent's whole contract shape; `run-created` gains the optional `concurrencyClamp` and `createWorkflowSubagentProvider` an optional agent directory. 6.0.0 is a major because revision 25 refuses revision-24 persisted state (see the `WORKFLOW_CONTRACT_REVISION` row), and because `AgentTaskRequestSchema.memoryBytes` narrows with pi-subagent revision 11 from 64 MiB to a 1 GiB floor and the materializer's malformed-grant message changes with it; no export, tool or other shape changes. 5.0.0 is a major because revision 24 refuses revision-23 persisted state (see the `WORKFLOW_CONTRACT_REVISION` row), and because the component library and the `plan-to-ship` output change shape: `verifyAndFix`, `fixFindings` and `synthesizeFindings` are gone, `verifyHandoff`, `reviewLenses` and the review record replace them, and the root gains `reviewsRecordTask` and `REVIEWS_RECORD_SUPPORT_NAME`; its runtime schema changes are the optional `continueFrom` on `AgentTaskRequestSchema` and the `task-execution-continue-intended` event. 4.0.0 is a major because revision 23 refuses revision-22 persisted state (see the `WORKFLOW_CONTRACT_REVISION` row); its one schema change is additive, the optional `startAtInput` on `AgentWorkspaceRequestSchema` and `WorkspaceAuthoringRequest`. 3.0.0 is a major because revision 20 refuses revision-19 persisted state and reads a different root (see the `WORKFLOW_CONTRACT_REVISION` row), and because the Pi peer floor rises to 1.4.0. 2.0.0 was a major for the persisted-state reason alone: contract revision 19 refuses revision-18 persisted state, and `AgentTaskRequestSchema` only gained the optional `memoryBytes` |
| Frozen surfaces | authoring, service, contract, extension | [`docs/contracts.md` "Public API and stability"](contracts.md#public-api-and-stability); `compatibility.json` `piWorkflow.api.frozenSurfaces` |
| Entry points | `.` frozen, `./extension` frozen, `./runtime` unfrozen (engine internals; may change in any minor release), `./components` unfrozen (the component library; frozen from a later minor), `./service-provider` unfrozen (the service-provider seam; frozen from a later minor); `./package.json` is the manifest, not an API surface | `package.json` `exports`; `compatibility.json` `piWorkflow.api.entryPoints` |
| Pinned export lists | `.`: 210 value exports, `./runtime`: 138 value exports; the two sets are disjoint and deep `dist/` paths are not importable | `test/fixtures/public-api/root-exports.json`, `runtime-exports.json` (`test/public-api.test.ts`, `scripts/check-pack.mjs`) |
| TypeScript module resolution | `node16`, `nodenext`, or `bundler` (types are resolved through the `exports` map; no `typesVersions`; the package itself compiles with `module`/`moduleResolution` `NodeNext`, and `engines.node >=23.6.0` excludes toolchains that need `node10` fallbacks) | `package.json` `exports`, `tsconfig.json` |
| `WORKFLOW_CONTRACT_REVISION` | 27 | `src/contracts-core.ts` (re-exported by `src/contracts.ts`); 2.0.0 raised it from 18 to 19 for the pi-subagent revision-7 handshake and the optional `memoryBytes` in agent task identity. 3.0.0 raises it to 20 because run state moves: runs, leases, prune trash, and dynamic proposals are keyed under `<agentDir>/workflow/<projectKey>` instead of `<cwd>/.pi/workflow`, and the location of persisted state is part of the contract ([docs/persistence.md](persistence.md#where-state-lives)). No record shape changes with it. It later gained one feature flag, `serviceProviderStart: true`, and one optional persisted event field, `run-created`'s `origin`, both additive within the revision: a journal written without `origin` still validates, the reducer does not read it, and no identity derivation changes, so the revision does not advance again for it. A consumer pins the feature flag, not the field. It then advanced again to 21, because `WorkflowRunRecordSchema` gained the optional `ceiling` - the host delegation ceiling a run started under, recorded at creation and lowered onto every `SubagentRequest` the run makes. That is persisted state a reader must understand: a reader that ignored it would misread every launch the run made, which is what the revision rule counts rather than the shape of the field. The revision is an input to `hostApiSha256` by construction, so the dynamic host API digest rotates and every existing dynamic source approval is invalidated; nothing else derives identity from it. It then advanced again to 22, because `WorkflowRunRecordSchema` gained the optional `sessionModel` - the host session's model and thinking level the run inherited, resolved once at creation and substituted for every `model: "inherit"` declaration the definition makes. That is persisted state a reader must understand: it is the only place that says which model made the run's work, and a reader that ignored it could not tell a run that inherited from one whose models were written by hand. It then advanced again to 23, because the agent task request's `workspace` gained the optional `startAtInput` - the name of one of the task's own handoff inputs, whose imported `handoffCommit` the launcher resolves at launch and sends pi-subagent as `workspace.startAt`. It is part of the persisted task spec and of task identity, and a reader that ignored it would describe a verifier, a fixer or a review lens as running on the repository baseline when it ran on the hand-off. It then advanced again to 24, because the agent task request gained the optional `continueFrom` - the handoff input whose producer's child run the task continues through pi-subagent's resume at hand-off - and the execution projection the `task-execution-continue-intended` event and its `continue-intended` phase. Both are persisted, the request is part of task identity, and a reader that ignored them would describe a resumed implementer as a fresh launch with no preflight. It then advanced again to 25, for the pi-subagent revision-11 handshake: pi-subagent's `MemoryBytesSchema`, which `AgentTaskRequestSchema` and so every persisted agent task spec embeds, no longer admits a grant below 1 GiB (a smaller guest never booted). A revision-24 spec that named 64 MiB to 960 MiB would no longer validate, and a revision-24 reader cannot run against the revision-11 pi-subagent; the revision rule counts both. It then advanced again to 26, for the pi-subagent revision-12 handshake: pi-subagent's `ClassifiedFailureSchema`, which every persisted subagent settlement embeds, gains the failure code `capacity` (an attempt that never got a VM slot), which a revision-25 reader cannot validate, and a revision-25 reader cannot run against the revision-12 pi-subagent. The same revision adds the optional `run-created` field `concurrencyClamp`, recorded when a run's concurrency was lowered to the host's VM slots. It then advanced again to 27, because the materialized agent task gained the optional `modelResolution` - the alias, tier and family a model router gave for a `modelRole` declaration, persisted beside the spec and outside task identity, which a replay re-uses instead of asking the router again - and because the runtime contract gains the feature flag `modelRoutingProvider: true`, the bus protocol through which a host hands the run its router. A reader that ignored the field would replay a routed run into a different review record. Revision-27 stores refuse revision-26, revision-25, revision-24, revision-23, revision-22, revision-21, revision-20 and revision-19 leases, journals, snapshots, run records, decision records, and dynamic proposals; state left under an older root or revision is not seen, and there is no migration, no fallback root, and no dual-root reader |
| `WORKFLOW_HANDOFF_FORMAT.revision` | 7 | `src/contracts.ts`; the pi-subagent revision that DEFINES the handoff rendering, which is not the same as the revision currently required. pi-subagent 0.15.0 is revision 9 and renders a handoff identically, so this stays 7: it is an input to `WORKFLOW_HANDOFF_FORMAT_SHA256`, the `schemaSha256` of every handoff artifact, and moving it would fail every existing handoff artifact's verification for no change in the bytes |
| Agent task `memoryBytes` | optional; a multiple of 64 MiB from 1 GiB to 4 GiB (pi-subagent revision 11 raised the floor from 64 MiB) | `AgentTaskRequestSchema` (pi-subagent `MemoryBytesSchema`); omitted means the agent definition's own ceiling |
| `WORKFLOW_RUNTIME_CONTRACT.features.checkpoints` | `true` | `src/contracts.ts` |
| `WORKFLOW_RUNTIME_CONTRACT.features.dynamicWorkflows` | `true` (proposed `dynamic:<sha256>` sources run only after a human approval bound to their digest, manifest, host API, and import policy) | `src/contracts.ts` |
| `WORKFLOW_RUNTIME_CONTRACT.features.serviceProviderStart` | `true` (the service-provider client exposes `startBuiltin`, gated by the frozen `BUILTIN_STARTABLE_WORKFLOWS`, and `run-created` carries the optional `origin: "service-provider"`; there is no `effort` option - the dial is gone and models are set per role) | `src/contracts.ts` |
| `WORKFLOW_RUNTIME_CONTRACT.features.serviceProviderDecide` | `true` (the same client exposes `decide`, `resume` and `stop`, and `inspect` admits the `"checkpoints"` section; a decision taken through it is filed with `source: "service-provider"`) | `src/contracts.ts` |
| `WORKFLOW_RUNTIME_CONTRACT.features.modelRoutingProvider` | `true` (a host hands its router over the `@vegardx/pi-workflow/model-routing-provider/request/v1` bus channel with `registerModelRoutingProvider`; the shipped extension reads it per run with `resolveModelRouting`, and a definition that declares `needs.modelRouting` is refused at start on a host with none) | `src/contracts.ts` |
| Host VM slots | A run's concurrency is clamped at creation to pi-subagent's `capacity.maxSlots` (`maxSlots` in `<agentDir>/subagents/settings.json`, default 16, host-wide), read through `WorkflowSubagentBinding.maxSlots`; a clamp is recorded once on `run-created` as `concurrencyClamp` and shown in the run's log. Not partitioned between a parent and its nested runs: pi-subagent's slot wait serialises the rest | `src/service.ts`, `src/subagent-provider.ts`, `src/events.ts` |
| Session model a run inherits | `WorkflowRunRecord.sessionModel`, optional; resolved once at run start from `WorkflowServiceOptions.sessionModel` for a definition whose `meta.needs.sessionModel` is true, and substituted for every `model: "inherit"` before hashing. A host with no session model is refused at start: `<name> inherits the session model, and this host has none.` | `src/session-model.ts`, `src/run-record.ts`, `src/materializer.ts` |
| Required `@vegardx/pi-subagent` | `0.20.0` (exact; raised from `0.19.0` because 0.20.0 waits for a free VM slot, types a refusal as `capacity`, reports the host's `capacity.maxSlots`, and moves to contract revision 12) | `package.json` `peerDependencies` |
| Required pi-subagent contract revision | 12 | `WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.contractRevision` |
| pi-subagent commit built in CI | `cae442ca5f234ef94ea5bcc1061195c0198c1779` | `.github/workflows/ci.yml` |
| Pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) | `>=1.4.0 <2` (Pi 1.2.0 removed `@earendil-works/pi-server`, which nothing here imported) | `package.json` `peerDependencies` |
| Node.js engines | `>=23.6.0` | `package.json` `engines` |
| Node.js in CI | 24.16.0 | `.github/workflows/ci.yml` |
| `typebox` | `>=1.3.14 <2` | `package.json` `peerDependencies` |
| Dynamic source transformer (`amaro`) | `1.2.0` (exact) | `package.json` `dependencies`, `DYNAMIC_TRANSFORMER_VERSION` |
| Builtin workflow root | `workflows/` in the tarball, registered by the shipped extension as scope `builtin`, source `package`; trusted package code that loads without Pi project trust | `package.json` `files` and `pi.workflows`, `src/extension.ts`, `scripts/check-pack.mjs` |

## Required pi-subagent features

`isCompatibleSubagentContract` accepts a pi-subagent runtime contract only when
it is revision 12 and every feature below has exactly this value. The
contract's `capacity.maxSlots` is the host's setting, not a requirement: it is
not compared, and `requiredSubagent` does not carry it.

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
| `capacityWait` | `true` |

## Host qualification

| Host | Status | What was exercised |
| --- | --- | --- |
| macOS arm64 | Qualified | **On Pi 0.85.0 only; not re-qualified on Pi 1.4.** The supported Pi range is now `>=1.4.0 <2`, which excludes the Pi this host was qualified against, so this row is a record of the earlier qualification, not a claim about the current range; a host run on Pi 1.4.0 with pi-subagent 0.20.0 is pending. Real Pi 0.85.0 print-mode sessions on Node.js 24.16.0 loaded the packed extension and ran trusted workflows through pi-subagent Gondolin VMs: single agent task, artifact pipeline, parallel barrier, settled results, fan-out, fan-in, and the pipeline builder. Evidence: the reports under [`docs/qualification/`](qualification/). Those reports record pi-subagent commit `55e84bd731e2017510ee85b2df898e7f2d3679f2`; the current CI pin `cae442ca5f234ef94ea5bcc1061195c0198c1779` (pi-subagent 0.20.0 on Pi 1.4.0, contract revision 12) has been verified only by the packed contract check and the fake-client suite, not by a host run. 1.0.0 packed tarball qualification: see [`docs/qualification.md`](qualification.md), which records its own status; an unchecked item there is not a claim. |
| Linux x64 | Build-only | GitHub Actions `ubuntu-latest` on Node.js 24.16.0 builds the pinned pi-subagent commit, then runs `npm run check` (Biome, `tsc`, build, Vitest with fake subagent clients, pack check) and `npm audit --audit-level=low`. No real Pi session, model, or Gondolin VM is exercised. |
| Other platforms | Not built | Nothing else is built, tested, or qualified. |

Behaviour covered by unit and packed-contract tests only, with no host run for
1.0.0, is listed under "Unit-tested only" in
[`docs/qualification.md`](qualification.md) (worktree agent tasks and handoff
import among them: no worktree task has been run against a packed pi-subagent
on any host). That list, not this table, is the authoritative statement of
what has not been exercised by hand.
