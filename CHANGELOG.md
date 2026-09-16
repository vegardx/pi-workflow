# Changelog

`@vegardx/pi-workflow` follows semantic versioning over the four frozen
surfaces described in
[docs/contracts.md "Public API and stability"](docs/contracts.md#public-api-and-stability).
`WORKFLOW_CONTRACT_REVISION` is tracked independently in
[docs/compatibility.md](docs/compatibility.md).

## 1.1.0

- Fix: a worktree handoff above `MAX_WORKFLOW_HANDOFF_BYTES` (or refused by pi-subagent's export bound) now terminalizes the execution as `failed` at stage `handoff-import` with `Workflow handoff exceeds the import bound.` instead of leaving the run `cleanup-blocked` with an unsatisfiable `reconcile`; the child's worktree stays unreleased and protected on the pi-subagent side, and a run already wedged in the old shape converges to `failed` on its next `reconcile`. No persisted schema changed; the reducer admits one new terminal shape, so a journal written after such a failure is rejected by pre-1.1 readers of revision 18.

Guided checkpoint prompts. A parked run now asks the person instead of
handing them a task id and a JSON grammar. Everything is additive under the
1.0 freeze: no frozen name changed, no tool was added, and
`WORKFLOW_CONTRACT_REVISION` stays 18 with the required pi-subagent contract
at revision 6 (`0.10.0`).

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

### Documentation

- `docs/contracts.md` (checkpoint views, operator surface, widget),
  `README.md`, `docs/acceptance.md`, `docs/qualification.md` (the rewritten
  "Checkpoint decide" item), and the `workflow-authoring` skill, which now
  tells authors to write prompts as answerable questions, declare `inputs`
  for everything the decider must read, and keep decision schemas small and
  flat.

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
