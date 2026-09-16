# Changelog

`@vegardx/pi-workflow` follows semantic versioning over the four frozen
surfaces described in
[docs/contracts.md "Public API and stability"](docs/contracts.md#public-api-and-stability).
`WORKFLOW_CONTRACT_REVISION` is tracked independently in
[docs/compatibility.md](docs/compatibility.md).

## Unreleased

Additive since 2.0.0, so the next release is the minor 2.1.0: a fourth entry
point carrying a component library, and a support-task wiring fix in the
extension. No frozen export, shape, schema, message, or tool changed;
`WORKFLOW_CONTRACT_REVISION` stays 19 and the required pi-subagent contract
stays revision 7 (`0.11.0`).

### Added

- **`@vegardx/pi-workflow/components`.** A fourth entry point exporting the
  component library: `gate`, `envelope`, `forEach`, and `reviewFanOut`, with
  their error and finding types. Adding an entry point and its exports is a
  minor release under the stability policy. The entry is **unfrozen** — its
  exports may change in any minor release — and it is recorded as such in
  `compatibility.json` `piWorkflow.api.entryPoints` and
  [docs/compatibility.md](docs/compatibility.md). Its export list is not
  pinned, but it is checked to be disjoint from the two pinned lists, so no
  frozen surface moves with it.
- **Authored definitions may import `@vegardx/pi-workflow/components`.** The
  definition import gate now accepts that specifier alongside
  `@vegardx/pi-workflow`, `typebox`, and registered support modules. It is
  trusted package code and makes the same identity trade the root import
  already makes: a definition's source identity covers its own bytes, not the
  package's. `@vegardx/pi-workflow/runtime` remains rejected.

### Fixed

- **Support task registrations reach the workflow service.** The extension
  built its service without passing `supportTasks`, so the host-process
  support implementations in `src/support-registry.ts` were never registered
  and their module specifiers were never admitted to the definition import
  gate. The extension now passes them, which is the constructor form the
  contract's `supportTaskExecution` feature promises.

## 2.0.0

Major release. The only reason it is a major is the stability policy's
persisted-state rule in
[docs/contracts.md "Public API and stability"](docs/contracts.md#public-api-and-stability):
"Runs journaled by revision 18 are readable by every 1.x release; a release
that cannot read them is a major." `WORKFLOW_CONTRACT_REVISION` becomes 19 and
revision-19 stores refuse revision-18 leases, journals, snapshots, run
records, decision records, and dynamic proposal records. No migration is
offered. A 1.1.0 run directory cannot be read by this release, so 1.2.0 was
not available; the rule that would have allowed a minor ("a revision bump is a
minor version when it only adds optional fields, feature flags, or event types
and every frozen shape still type-checks") is subordinate to the
persisted-state rule, which this bump breaks.

No frozen export was removed, renamed, or retyped, no returned union widened,
and no tool name, parameter, or output schema changed. The single schema
change is additive and explicitly permitted under the freeze ("A frozen schema
may therefore gain optional fields under a new revision").

### Breaking

- **`WORKFLOW_CONTRACT_REVISION` is 19.** Runs journaled by 1.x are not
  readable. Finish or abandon in-flight runs before upgrading; there is no
  migration and none is planned.
- **Handoff artifact digests changed.** `WORKFLOW_HANDOFF_FORMAT.revision` is
  7, so `WORKFLOW_HANDOFF_FORMAT_SHA256` — the `schemaSha256` of every handoff
  artifact — changed with it. A handoff artifact written by 1.x does not
  verify here.
- **`@vegardx/pi-subagent` `0.11.0` (exact) is required**, up from `0.10.0`.
  `REQUIRED_SUBAGENT_CONTRACT` is contract revision 7 and additionally
  requires `vmMemoryCeiling: true` and `workspaceBudgetRefusal: true`;
  `isCompatibleSubagentContract` refuses revision 6 and refuses a revision-7
  contract missing either flag.

### Added

- **Agent task `memoryBytes`.** `AgentTaskAuthoringRequest` and
  `AgentTaskRequestSchema` gain an optional `memoryBytes`: the guest VM memory
  grant, validated against pi-subagent's `MemoryBytesSchema` (a positive
  integer multiple of 64 MiB, at most 4 GiB) and lowered unchanged to
  pi-subagent. It is a request to narrow, never to widen: the agent definition
  declares the ceiling, an omitted request takes it, and a request above it is
  refused at preflight. The materializer refuses a malformed value with
  "agent memoryBytes must be a positive multiple of 64 MiB and at most
  4 GiB". `memoryBytes` participates in agent task identity, which the
  revision bump covers.
- **The preflight refusal is relayed unchanged.** A refusal raised by
  pi-subagent itself — "memory request exceeds agent ceiling" among them — now
  follows the fixed prefix "Subagent preflight failed before launch." in the
  terminal evidence and the task failure reason, instead of being replaced by
  that prefix alone. A mismatch the launcher detects locally still records the
  prefix by itself, so the prefix remains a stable match for callers.
- **`workspace-budget` is never retried.** pi-subagent classifies an exhausted
  `workspaceWriteBytes` as `workspace-budget` with `retry: "never"`; the
  workflow retrier declines it with or without a declared retry policy and
  journals no retry intent. Covered by a regression test.
- **Builtin workflow memory dial.** `workflows/agents/implementer.md` raises
  its `memoryBytes` ceiling to 4 GiB, and `plan-to-ship` requests 1 GiB at
  `cheap`, 2 GiB at `standard`, and 4 GiB at `deep`. The implementer's
  instruction now names the memory its own stage was granted instead of a
  fixed 512 MiB.

### Changed

- The CI pi-subagent pin is `e42cd28f2f970872a1a460079efc1a992c0bd7c9`
  (0.11.0, contract revision 7) in both checkout steps, and
  `compatibility.json` records it as `piSubagent.ciCommit` and as the
  `linux-x64` host's `piSubagentCommit`. The macOS arm64 host still records
  the commit that actually ran, `55e84bd…`.

## 1.1.0

Additive minor release: guided checkpoint prompts, the package's own builtin
workflow root with the `plan-to-ship` pipeline, and a handoff-bound fix. No
frozen export, shape, schema, message, or tool changed;
`WORKFLOW_CONTRACT_REVISION` stays 18 and the required pi-subagent contract
stays revision 6 (`0.10.0`).

### Added

- **Pi asks the session user.** When a run this session owns parks at a
  checkpoint in a session with dialog-capable UI, the extension opens a
  guided form once per checkpoint execution: the prompt in full, the run, the
  expiry countdown, the declared `inputs`, and the answer shape, then one
  dialog per decision field (boolean, enum, string, number, or a small flat
  object; a JSON editor for anything larger). The service remains the only
  validator, dismissing records nothing and leaves the run parked, and an
  answer records exactly one decision with `approver: "pi-session"`. There is
  still no model-callable decide tool.
- **`/workflow decide <run> <task> [json] [reason…]`.** The `<json>` argument
  is now optional: without it, the command opens the guided form. With it,
  the existing path and its confirmation are unchanged.
- **Inspector decide entry.** The `alt+w` inspector's palette gains "Decide a
  checkpoint", offered only while `availableActions` lists `decide`; it opens
  the same form.
- **Widget line.** While a run this session owns waits for a decision, the
  `pi-workflow` widget's first line becomes `waiting for you: <prompt>` (cut
  to the widget width) and the ongoing and attention counts collapse into the
  second. The widget still shows at most two lines and still takes no lease:
  the prompt comes from one cached, lease-free `inspect` per parked run.
- **Pending-checkpoint view fields.** Every `pendingCheckpoints` entry of
  every run view gains six optional fields: `taskKey`, `prompt` with
  `promptTruncated`, `schemaSummary`, `inputsSummary` (artifact-backed views
  only), and `instruction`. Adding optional view fields is a minor release
  under the 1.0 policy; existing readers are unaffected.
- **Model guideline.** `workflow_wait` and `workflow_status` now state, in
  their descriptions and `promptGuidelines`, that a parked result carries the
  checkpoint prompt and its inputs summary, that a person answers it in the
  session, and that the model surfaces the question and stops instead of
  deciding or polling. Their collapsed result line for a parked run reads
  `waiting for you: <prompt>`.
- **Service API**: `WorkflowServiceOptions.registeredRoots`, an optional list
  of `package`/`builtin` definition roots present from the first discovery.
  It is the constructor form of `registerRoot`, validated the same way, and it
  does not discover eagerly, so registering a package root never forces a
  project-trust decision at service creation.
- **Builtin workflows**: the package ships a `workflows/` directory (in the
  tarball, declared by `files` and the `pi.workflows` manifest key) and the
  extension registers it as `{ scope: "builtin", source: "package" }`. Its
  definitions are trusted package code: `workflow_list`, `workflow_validate`,
  and `workflow_run` reach them in any project without Pi project trust, and
  their imports resolve from inside the installed package. When the project
  being worked in is the pi-workflow checkout itself, the directory is already
  `<cwd>/workflows` and the extension omits the builtin root.
- `workflows/plan-to-ship.workflow.ts`: the `plan -> approve -> implement ->
  ship` pipeline. A read-only `refine` agent, the `approve-plan` checkpoint
  (`headless: "block"`, and the only approval record), one `implement-<id>`
  worktree agent per deliverable with `handoff: "required"` that attempts the
  repository's install and check in its own worktree and reports
  `checkRan`/`checkPassed`/`checkTail` honestly, optional reviewers over the
  plan's review tasks fed each handoff's descriptor, the `ship` checkpoint, and
  a required `receipt` finalizer. Input is a pi-maestro plan by value with its
  sha256 digest and a `cheap|standard|deep` effort dial; output is a receipt
  naming each durable handoff ref and the approved `planDigest`. Nothing is
  pushed, merged, published, or applied: shipping is a cherry-pickable ref plus
  the imported patch artifact.
- `workflows/agents/{planner,implementer,reviewer}.md`: the three agent
  definitions `plan-to-ship` names, shipped as templates a person copies into
  `<agentDir>/agents` or a trusted project's `.pi/agents`. pi-subagent
  discovers agents from those two places only, so a builtin workflow cannot
  install them; a missing one fails its task at pi-subagent preflight.
- The pack check installs the tarball and asserts that the packed extension's
  `workflow_list` and `workflow_validate` discover the builtin definition, and
  that the packed agent templates parse through the packed pi-subagent's own
  `discoverAgents`.

### Fixed

- **Oversized handoff fails closed.** A worktree handoff above
  `MAX_WORKFLOW_HANDOFF_BYTES` (or refused by pi-subagent's export bound) now
  terminalizes the execution as `failed` at stage `handoff-import` with
  `Workflow handoff exceeds the import bound.` instead of leaving the run
  `cleanup-blocked` with an unsatisfiable `reconcile`; the child's worktree
  stays unreleased and protected on the pi-subagent side, and a run already
  wedged in the old shape converges to `failed` on its next `reconcile`. No
  persisted schema changed; the reducer admits one new terminal shape, so a
  journal written after such a failure is rejected by pre-1.1 readers of
  revision 18.

### Documentation

- `docs/contracts.md` (checkpoint views, operator surface, widget),
  `README.md`, `docs/acceptance.md`, `docs/qualification.md` (the rewritten
  "Checkpoint decide" item), and the `workflow-authoring` skill, which now
  tells authors to write prompts as answerable questions, declare `inputs`
  for everything the decider must read, and keep decision schemas small and
  flat.
- The builtin root and `plan-to-ship` in `README.md`, `docs/contracts.md`,
  `docs/architecture.md`, `docs/authority.md`, `docs/acceptance.md`,
  `docs/compatibility.md`, and the `workflow-authoring` skill.

## 1.0.0

First stable release. No runtime behaviour, schema, event, identity, or
handshake changed relative to 0.1.0; `WORKFLOW_CONTRACT_REVISION` stays 18
and the required pi-subagent contract stays revision 6 (`0.10.0`).

### Frozen surfaces

- **Authoring API** (`@vegardx/pi-workflow`): `defineWorkflow`,
  `defineSupportTask`, `WorkflowContext`, every handle and request type
  (`TaskHandle`, `AgentTaskHandle`, `WorktreeTaskHandle`, `ArtifactHandle`,
  `HandoffHandle`, `TaskInputHandle`, `AgentTaskAuthoringRequest`,
  `NestedWorkflowRequest`, `CheckpointRequest`, `FinalizeRequest`, ...), and
  the predicates `isTaskHandle`, `isArtifactHandle`, `isHandoffHandle`,
  `isWorkflowDefinition`.
- **Service API** (`@vegardx/pi-workflow`): `createWorkflowService`,
  `WorkflowServiceOptions`, every `WorkflowService` method (`registerRoot`,
  `list`, `validate`, `run`, `status`, `wait`, `stop`, `decide`,
  `invalidate`, `retry`, `resume`, `reconcile`, `listRuns`, `inspect`,
  `logs`, `previewInvalidation`, `subscribe`, `exportHandoff`, `propose`,
  `inspectProposal`, `proposals`, `decideSource`, `shutdown`),
  `WorkflowServiceError`, `createWorkflowSubagentProvider`, and the view
  types and schemas the methods return.
- **Contract layer** (`@vegardx/pi-workflow`): the revision-18 request, spec,
  record, evidence, event, projection, and view schemas; the identity and
  bound constants (`MAX_*`, `DEFAULT_*`, the root `DYNAMIC_*` constants,
  `WORKFLOW_HANDOFF_FORMAT_SHA256`); `WORKFLOW_CONTRACT_REVISION`,
  `WORKFLOW_RUNTIME_CONTRACT`, `isCompatibleSubagentContract`,
  `isWorkflowRuntimeContract`; the decision-record schemas with
  `deriveDecisionBindingSha256`, `deriveDecisionRecordSha256`, and
  `deriveJsonValueSha256`; `WORKFLOW_RUN_ACTIONS`,
  `IMPLEMENTED_WORKFLOW_RUN_ACTIONS`, `isTerminalWorkflowRunStatus`,
  `DEFAULT_INSPECT_SECTIONS`.
- **Extension entry** (`@vegardx/pi-workflow/extension`): the default export,
  the fourteen tools of `WORKFLOW_TOOL_DECLARATIONS` (with `workflowToolText`
  and `MAX_TOOL_OUTPUT_BYTES` at the root), the `/workflow` command grammar
  (sixteen subcommands), the `pi-workflow` widget, and the `alt+w` inspector.

The exact root export list is `test/fixtures/public-api/root-exports.json`;
the pack check and `test/public-api.test.ts` fail when the package deviates
from it.

### Package layout

- New subpath `@vegardx/pi-workflow/runtime` (`dist/runtime/index.js`): the
  engine, explicitly **not frozen**. Its names may change in any minor
  release; no name is exported from both entries; the workflow import gate
  refuses it from a definition.
- New subpath `@vegardx/pi-workflow/package.json` so an embedder can read the
  installed `version` without knowing the install path.
- Deep `dist/` paths remain unexported.
- Consumers need TypeScript `moduleResolution` `node16`, `nodenext`, or
  `bundler` (exports map; no `typesVersions`).

### Moved to `@vegardx/pi-workflow/runtime`

These names were exported from the root in 0.1.0 and are exported only from
the runtime entry in 1.0.0. Embedders that imported them change the specifier
to `@vegardx/pi-workflow/runtime`; authored workflows are unaffected (they
import root names only). The complete list is
`test/fixtures/public-api/runtime-exports.json`; by module:

- `artifact-input`: `projectWorkflowArtifactInputs`,
  `readWorkflowArtifactInputs`, `verifyWorkflowArtifactInputs`,
  `validateWorkflowTaskContext`, `WorkflowArtifactInputError`.
- `artifact-store`: `WorkflowArtifactStore`, `WorkflowArtifactStoreError`,
  `canonicalArtifactJson`.
- `attempts`: `currentSubagentAttempt`, `currentSubagentAttemptId`,
  `settledAgentUsage`.
- `budget`: `budgetExceededReason`, `reservedWorkflowUsage`,
  `settledWorkflowUsage`, `workflowUsage`.
- `checkpoint-executor`: `CHECKPOINT_RUN_ENDING_REASON`,
  `cancelOpenWorkflowCheckpoints`, `createWorkflowCheckpointTaskExecutor`,
  `WorkflowCheckpointExecutionError`.
- `decision-store`: `WorkflowDecisionRecordStore`,
  `WorkflowDecisionRecordError` (the record and binding schemas stay at the
  root).
- `dynamic/constants` (VM and RPC internals): `DYNAMIC_ASYNC_METHODS`,
  `DYNAMIC_SYNC_METHODS`, `DYNAMIC_CONTEXT_METHODS`,
  `DYNAMIC_CONTEXT_PROPERTIES`, `DYNAMIC_RPC_MESSAGE_TYPES`,
  `DYNAMIC_SHIM_EXPORTS`, `DYNAMIC_VM_ABORT_GRACE_MS`,
  `DYNAMIC_VM_CODE_GENERATION`, `DYNAMIC_VM_RESOURCE_LIMITS`,
  `DYNAMIC_VM_SYNC_WAIT_MS`, `MAX_DYNAMIC_HANDLE_REFS`,
  `MAX_DYNAMIC_RPC_ARGS`, `MAX_DYNAMIC_RPC_MESSAGES`,
  `MAX_DYNAMIC_RPC_MESSAGE_BYTES`, `MAX_DYNAMIC_VM_ERROR_CHARS` (the intake,
  approval, reference, transformer, and watchdog constants stay at the root).
- `dynamic/definition`, `dynamic/execution-error`, `dynamic/identity`,
  `dynamic/proposal-store`, `dynamic/vm-host`:
  `createDynamicWorkflowDefinition`, `createDynamicDiscoveredWorkflow`,
  `DynamicWorkflowExecutionError`, `isDynamicWorkflowExecutionError`,
  `deriveDynamicDefinitionIdentitySha256`, `deriveDynamicHostApiSha256`,
  `deriveDynamicImportPolicySha256`, `WorkflowDynamicStoreError`,
  `extractDynamicWorkflowManifest`.
- `execution` (run-internal identity derivations): `deriveTaskExecutionId`,
  `deriveSubagentOperationId`, `deriveSubagentResultSha256`,
  `deriveSubagentSettlementEvidence`, `deriveWorkflowArtifactId`,
  `deriveWorkflowFailureSha256`, `deriveWorkflowHandoffDescriptor`,
  `deriveNestedWorkflowRunId`, `deriveCheckpointEffectSha256`,
  `deriveSupportImplementationIdentitySha256` (`deriveJsonValueSha256` stays
  at the root).
- `handoff`: `verifyWorkflowHandoffEvidence`,
  `WorkflowHandoffVerificationError`, `WORKFLOW_HANDOFF_UNVERIFIED_MESSAGE`,
  `WORKFLOW_HANDOFF_VERIFICATION_MESSAGES`.
- `lifecycle`: `transitionWorkflowRunStatus`, `transitionWorkflowTaskStatus`,
  `InvalidWorkflowRunTransitionError`, `InvalidWorkflowTaskTransitionError`.
- `materializer`: `WorkflowTaskMaterializer`, `WorkflowMaterializationError`,
  `deriveWorkflowTaskId`, `deriveAgentTaskIdentity`,
  `deriveSupportTaskIdentity`, `deriveNestedWorkflowTaskIdentity`,
  `deriveCheckpointTaskIdentity`.
- `nested-run-executor`: `createWorkflowNestedRunExecutor`,
  `WorkflowNestedRunError`.
- `persistence/journal`: `WorkflowRunJournal`, `readWorkflowJournalUnleased`,
  `WorkflowJournalEventSchema`, `WorkflowRunSnapshotSchema`.
- `persistence/run-lease`: `acquireWorkflowRunLease`, `probeWorkflowRunLease`,
  `WorkflowRunLeaseRecordSchema`, `WorkflowRunLeaseFencedError`,
  `WorkflowRunLeaseUnavailableError`, `WorkflowPersistenceCorruptionError`.
- `reducer`: `reduceWorkflowEvents`, `rebuildWorkflowSnapshot`,
  `invalidationClosure`, `WorkflowEventReductionError`.
- `registry`: `discoverWorkflows` (`WorkflowDefinitionLoadError` and
  `WorkflowDefinitionTrustError` stay at the root).
- `run-actions` (legality predicates): `admitsInvalidation`,
  `availableWorkflowRunActions`, `awaitsRecovery`, `deadlinePassed`,
  `hasOpenOperatorIntent`, `isNestedRun`, `isReopenedTask`,
  `pendingCheckpoints`, `requiresAttention`, `resumableTasks`,
  `resumeRefusal`, `retryableTasks`, `runActionFacts`,
  `OPERATOR_RESUME_REASON`.
- `run-projection`: `runSummary`, `runInspection`, `runLogs`, `taskViews`,
  `pendingCheckpointViews`, `invalidationPreview`, `compareRunSummaries`,
  `encodeWorkflowRunCursor`, `decodeWorkflowRunCursor`.
- `run-record`: `WorkflowRunRecordStore`, `WorkflowRunRecordSchema`,
  `WorkflowRunRecordError`.
- `scheduler`: `createWorkflowSequentialScheduler`, `WorkflowSchedulerError`.
- `static-runtime`: `createStaticWorkflowRuntime`, `isStaticWorkflowParked`,
  `StaticWorkflowRuntimeError`.
- `support`: `supportRegistrationIdentity`.
- `support-executor`: `createWorkflowSupportTaskExecutor`,
  `WorkflowSupportExecutionError`.
- `task-finalizer`: `createWorkflowTaskFinalizer`,
  `WorkflowTaskFinalizationError`.
- `task-launcher`: `createWorkflowTaskLauncher`, `WorkflowTaskLaunchError`.
- `task-retrier`: `createWorkflowTaskRetrier`, `WorkflowAttemptError`.

The type-only exports of the same modules (executor, scheduler, runtime,
journal, lease, materializer, and projection option and result types) moved
with them.

### Contract revision 18 (unchanged, carried into 1.0.0)

Revision 18 bundles two halves under one contract revision, both already in
0.1.0 and both frozen here:

- human checkpoints: `ctx.checkpoint`, `kind: "checkpoint"` tasks that park
  the run `running -> waiting`, `WorkflowService.decide`, immutable decision
  records in the run's `decisions/` store, `headless: "block"` and
  `headless: "use-explicit-default"` expiry policies, the human-only
  `/workflow decide` command, and `pendingCheckpoints` / `parked: true` in
  the wait view (feature `checkpoints: true`);
- dynamic workflows: `WorkflowService.propose` / `workflow_propose`,
  digest-keyed proposals under `.pi/workflow/dynamic/<sha256>/`, the
  manifest-only VM, `decideSource` writing a `source-approval` decision record
  bound to the source digest, manifest, `hostApiSha256`, and
  `importPolicySha256`, `dynamic:<sha256>` references accepted by `validate`
  and `run` only after approval, one worker-thread VM per drive, and the
  human-only `/workflow approve` and `/workflow reject` commands (feature
  `dynamicWorkflows: true`).

Earlier revisions (support-task execution, nested workflows and artifact
inputs, retry and resume attempts, execution generations, transactional
invalidation, finalizers, operator attempts, worktree tasks with handoff
import) are described in `docs/contracts.md` and `docs/roadmap.md`.

## 0.1.0

Development releases before the API freeze; not published. The history is in
the git log and `docs/roadmap.md`.
