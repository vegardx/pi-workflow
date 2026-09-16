# Changelog

`@vegardx/pi-workflow` follows semantic versioning over the four frozen
surfaces described in
[docs/contracts.md "Public API and stability"](docs/contracts.md#public-api-and-stability).
`WORKFLOW_CONTRACT_REVISION` is tracked independently in
[docs/compatibility.md](docs/compatibility.md).

## Unreleased

Additive since 2.0.0, so the next release is the minor 2.1.0: two new entry
points — a component library and a service-provider seam — three more builtin
workflows built out of the first, two short reference skills, a model-routing
port the host installs, a lease-free read of a settled run's output and of a
checkpoint's decided value, and a support-task wiring fix in the extension. No
frozen export, shape or message was removed or retyped, no returned union was
widened, and nothing persisted changed; `WORKFLOW_CONTRACT_REVISION` stays 19
and the required pi-subagent contract stays revision 7 (`0.11.0`).

### Added

- **`@vegardx/pi-workflow/components`.** A fourth entry point exporting the
  component library: `gate`, `envelope`, `forEach`, `reviewFanOut` and
  `verifyAndFix`, with their error and finding types and the compiled stage
  document below. Adding an entry point and its exports is a
  minor release under the stability policy. The entry is **unfrozen** — its
  exports may change in any minor release — and it is recorded as such in
  `compatibility.json` `piWorkflow.api.entryPoints` and
  [docs/compatibility.md](docs/compatibility.md). Its export list is not
  pinned, but it is checked to be disjoint from the two pinned lists, so no
  frozen surface moves with it.
- **The builtin `deep-review` workflow.** `workflows/deep-review.workflow.ts`
  and the `lens-reviewer` agent template it names, discovered from the same
  `workflows/` builtin root as `plan-to-ship` and needing no project trust. It
  reviews one subject — a worktree handoff's descriptor, the working tree, or a
  document — through 1 to 16 read-only lenses at once, merges what came back on
  a deterministic rail, and reports `{ verdict, findings, coverage, synthesis? }`
  with one coverage row per lens. No gate, no worktree, nothing written. It is
  the first definition assembled entirely from the component library
  (`envelope` for the effort dial, `reviewFanOut` for the graph), which is what
  makes it an executable example of the patterns rather than a second
  implementation of them.
- **The builtin `plan-review` workflow.** `workflows/plan-review.workflow.ts`
  and the `plan-reviewer` agent template it names: the **blind reviewer**, and
  the one definition a service consumer may start without a model turn, through
  `runBuiltin` and the frozen `BUILTIN_HEADLESS_WORKFLOWS` allowlist. In:
  `{ plan, planDigest, intent, compiled, projection, effort }` — a pi-maestro
  plan verbatim, the graph it compiled into, and the lease-free projection of
  that graph. Out: `{ verdict: "ready" | "gaps" | "blocked", findings (≤32),
  notes? }` in the shared `Finding` shape, with `patch` RFC 6902-shaped so
  accepting a finding is a mechanical apply against the stored plan rather than
  a re-prompt. The graph is exactly one read-only agent with
  `contextMode: "fresh"` and **no context scopes**, so no `AGENTS.md` and no
  project context file is projected into it — blindness is declared, not asked
  for in prose, and a reviewer that had read the planning conversation would
  only ever agree with it. **No checkpoint, no worktree and no handoff**, which
  is what makes it legal on the allowlist; `headlessBuiltinViolations` checks
  that structurally against the shipped file. The verdict is recomputed from the
  findings' severities and the more severe of the two is recorded, so a blocking
  finding can never be filed under `ready`.
- **The builtin `deep-research` workflow.** `workflows/deep-research.workflow.ts`
  and the `researcher` agent template it names. In: `{ question, depth,
  sources? }`, where `depth` is also the thread count — a caller who names no
  sources gets a fixed per-depth table of two, three or five angles, and a
  caller who names up to 16 `{ id, kind: "path" | "url" | "note", ref | text }`
  gets one thread per source. Out: `{ answer, claims, crossChecks, coverage }`.
  The graph is `forEach` twice around two `ctx.settled` barriers: independent
  read-only threads, then one cross-check per reporting thread briefed as a
  *different* thread and run on the other model family, so no thread marks its
  own homework, then one reducer that writes the answer and nothing else. The
  claims and the cross-checks are computed on a deterministic rail, and
  **nothing is de-duplicated** — unlike a review, two threads reaching the same
  claim from different material is corroboration rather than noise. A dead
  thread subtracts a coverage row instead of failing the run, and a run that
  also loses its reducer still records every claim under a deterministic
  `answer` saying what is missing. No checkpoint, no worktree and no handoff,
  which `headlessBuiltinViolations` asserts structurally — the definition is
  deliberately **not** on `BUILTIN_HEADLESS_WORKFLOWS`, because being
  structurally headless and having a reason to start without a model turn are
  different things.
- **`CompiledStageDocumentSchema`,** exported from
  `@vegardx/pi-workflow/components`. The compiled stage document — `{
  deliverables: [{ id, stages }], effort, gates }` over the `implement`,
  `verify-and-fix`, `review-fan-out` and `gate` kinds — shared by the compiler
  that produces it and the blind reviewer that reads it, so neither builtin has
  to import the other and neither carries a copy that can drift.
- **Two reference skills, `plan-schema` and `workflow-components`.** Short
  tables under `skills/`, each its own directory with a `SKILL.md` because Pi
  discovers a skill only from a directory containing that file. They document
  the pi-maestro plan document and the component library respectively, and
  `plan-review` preloads both by name. A preloaded skill costs a context entry
  rather than bytes, which is why they are tables and not prose.
- **`@vegardx/pi-workflow/service-provider`.** A fifth entry point: the seam
  another Pi extension in the same process acquires the workflow runtime
  through, structurally identical to pi-subagent's — a lazy, frozen
  `{ contract, acquire(context) }` answering a request event on a versioned
  channel, discovered twice so a provider swapped during acquisition is refused
  rather than used. What crosses it is narrowed to a `WorkflowReadClient`:
  `list`, `validate`, `project`, `inspect`, `runs`, `observe`, `runBuiltin`,
  and `awaitRun`. There is no `decide`, `stop`, `invalidate`, or general `run`
  — starting a workflow that writes stays the model's own `workflow_run` call,
  in the open, in the transcript. `runBuiltin` is gated by the frozen
  `BUILTIN_HEADLESS_WORKFLOWS` allowlist, which belongs to the runtime rather
  than the caller and whose members must declare no checkpoint, no worktree and
  no handoff — the property `headlessBuiltinViolations` checks, since
  `workflow_validate` cannot. The extension registers the provider for its own
  lifetime. The entry is **unfrozen** and recorded as such in
  `compatibility.json` and [docs/compatibility.md](docs/compatibility.md).
- **`WorkflowService.project(ref, input)` and `WorkflowBudgetProjection`.** A
  lease-free budget projection: the definition's `run(ctx)` is executed against
  a context that declares nothing durable — no journal, no lease, no task
  identity, no subagent, no filesystem — and the declared reservations of every
  task the graph would declare are summed and compared against the run's
  effective budget. Barriers resolve from values synthesized out of the
  declared output schemas, and a boolean synthesizes as `true`, so the answer
  is the worst-case branch. Adding a service method and a view is a minor
  release under the stability policy.
- **Model roles.** `AgentTaskAuthoringRequest` gains the optional `modelRole`
  (`{ persona, tier?, effort?, family? }`), mutually exclusive with `model`.
  The materializer resolves it to an exact `{ provider, id, thinking }`
  **before hashing**, so `AgentTaskRequestSchema`, task identity, and
  pi-subagent's contract are unchanged, and a role that resolves to the model a
  hand-written task named produces the identical task identity. The resolution
  is persisted with the task and re-used verbatim on every replay, only
  re-authorized. The router is a port — `WorkflowServiceOptions.modelRouting`,
  typed `ModelRoutingPort` — never a dependency: nothing in this package
  imports a router. With no port installed a `modelRole` fails materialization
  with "No model routing is installed; declare an exact model."; the runtime
  never guesses. `staticModelRouting(table)` on
  `@vegardx/pi-workflow/runtime` is the constant-table stand-in, and every
  resolution it returns reports `source: "static"` with a `fallbackReason`
  saying so.
- **`WorkflowRunRecordSchema.modelRouting`.** Optional, revision-19 additive:
  `{ router }`, the id of the routing port the run was created with, so a run
  says which router answered for it. Every record written before this still
  validates, a reader that does not know the field ignores it, and nothing
  derives identity from it.
- **`verifyAndFix`.** A component: a bounded verify-then-fix loop over one
  implementer's worktree handoff, unrolled at declaration into
  `<key>-verify-<n>` and `<key>-fix-<n>` — a pure function of the caller's key
  and the round ordinal. `maxRounds` bounds the **verify** rounds, capped at 3,
  so at most two fix rounds follow and the component never returns a fix nobody
  checked. Three verify rounds are the plan vocabulary's two fix rounds, and
  [docs/research.md](docs/research.md) measures that as the same graph its
  `maxFixRounds: 2` row measured — 4.4 s of worst-case resume at 21 % of the
  projection bound. The cap is a cap on replay: every round awaits a barrier, and a
  resume re-declares every epoch already crossed. A verifier always runs at
  `envelope(effort, "verify")`; a fixer is a retry, so `escalate: "thinking"`
  runs it one rung up the ladder, and escalating from `deep` is refused rather
  than silently ignored. `checkRan: false` stops the loop instead of starting a
  fix round — unverified is not broken — and returns
  `{ passed: false, checkRan: false }` for the caller's gate.
- **`inspect(runId, { include: ["output"] })` carries a settled run's output.**
  A new `include` member puts the run's committed output value on
  `run.output` of the inspection, read from the output artifact and verified
  against the digest the journal records — the same value, through the same
  bound, that the artifact-backed `status` and `wait` views carry. It is
  absent unless the run is terminal *and* committed an output, and absent
  from every inspection that did not ask for it, so the default selection
  reads no artifact at all. The bound is the artifact bound,
  `MAX_WORKFLOW_ARTIFACT_BYTES` (16 MiB): the store refuses to write a larger
  artifact and re-checks the recorded size on the read, so an output that
  would not fit cannot exist. Adding an `include` member widens an accepted
  input and adding an optional view field is additive, so
  `workflow_inspect`'s parameter and output schemas both still accept
  everything they accepted before.
- **Checkpoint decision views carry the decided value without an artifact.**
  `tasks[].checkpoint.decision.value` is now present on the lease-free
  inspection too, read from the run's durable decision record rather than
  from the decision result artifact. The journal stays authoritative: a value
  is shown only when the record's `valueSha256` equals the `sha256` the
  journalled decision names, and a record that disagrees is refused with
  `Checkpoint decision could not be read and verified.` rather than
  displayed. The artifact-backed path (`status`, `wait`, `decide`) is
  unchanged, and the lease-free inspection still reads no checkpoint
  `inputs`. A host can therefore prove a gate's answer — `{ "ship": true }` —
  without taking the run's lease and without `decide`.
- **`WorkflowArtifactStore.openUnleased` and
  `WorkflowDecisionRecordStore.openUnleased`.** Read-only stores over a run's
  `artifacts/` and `decisions/` directories, opened without the run's lease
  for the two reads above. Every reader verifies exactly what an owned
  store's does; every writer refuses with `… is read-only`; neither creates a
  directory. Both are `@vegardx/pi-workflow/runtime` internals, and neither
  entry point's pinned export list changed.
- **Authored definitions may import `@vegardx/pi-workflow/components`.** The
  definition import gate now accepts that specifier alongside
  `@vegardx/pi-workflow`, `typebox`, and registered support modules. It is
  trusted package code and makes the same identity trade the root import
  already makes: a definition's source identity covers its own bytes, not the
  package's. `@vegardx/pi-workflow/runtime` remains rejected.

### Changed

- **`plan-to-ship` compiles a plan's stages.** The builtin is now a compiler
  over `plan.deliverables[].stages` and `plan.policy` rather than a fixed
  five-stage pipeline, lowered entirely onto the component library — `gate` for
  every human decision, `envelope` for the whole effort dial, `verifyAndFix` for
  the bounded check-and-fix loop, `reviewFanOut` for the review stage. A
  deliverable that declares no `stages` gets the default list derived from
  `policy`, so **every plan written before stages existed compiles to what it
  always compiled to** and keeps the task key `implement-<deliverable>`. What is
  new for such a plan is a `verify-and-fix` stage: `policy.maxFixRounds`
  defaults to 0 at `cheap`, 1 at `standard` and 2 at `deep`, and the compiler
  maps a plan's FIX rounds to the component's VERIFY rounds as
  `maxRounds = fixRounds + 1`, so a fix is never left unchecked.
  - `input.effort` is now **optional**, falling back to `plan.policy.effort` and
    then to `standard`; `{ plan, planDigest, effort }` keeps working unchanged.
  - The gates come from `policy.gates` alone: `approve-plan` (no ship gate, so
    nothing ships and the receipt names no ref), `approve-plan+ship` (the
    default), or `every-deliverable` (a gate after each deliverable but the
    last, whose gate is `ship`). A `gate` stage the plan declares is compiled
    where it stands. A gate answered `{"proceed":false}` stops the walk and
    declares nothing after it.
  - The effort dial no longer selects review lenses — it ran the first lens at
    `cheap` and every lens twice at `deep` — because the plan's stages and
    `policy.reviewDefault` now say which lenses run and what each is worth.
    A `deep` run of a two-lens plan therefore declares two reviewers, not four.
  - Reviewers report the shared `Finding` shape (`ReviewReportSchema`) instead
    of the definition's own `{severity, summary}`, so findings merge on the
    component's deterministic rail and reach the output. A dead lens now
    degrades the run instead of blocking the ship gate: the gate names only a
    synthesis that ran.
  - The compilation is available as data in two views from one derivation, so
    they cannot drift. `compileStageDocument(plan, policy)` returns the
    plan-facing `CompiledStageDocument` — the stages each deliverable got, in
    the plan's own vocabulary, which is what `plan-review` validates its
    `compiled` input against and what pi-maestro derives for itself; the
    default stage list it fills in is `defaultStagesFor`'s, field for field,
    and the one translation is `maxRounds`, which a compiled document records
    in VERIFY rounds. `compileStages(plan, policy)` returns the LOWERING
    (`StageLowering`, declared in the definition and deliberately not part of
    the component library): every task key the run will declare, in order, with
    each stage's origin and the gate keys it parks on.
  - Every rule is refused in that one compilation, before the first task is
    declared, including `use: "dynamic"` ("dynamic stages are not compiled
    yet"), `use: "sub-workflow"` ("sub-workflows are not part of this slice"),
    and a non-empty `reads` between deliverables, which was silently dropped
    before.
  - The run output gains `deliverables[].verifyRounds`, `reviews[].deliverable`
    and a merged `findings` array. `meta.version` becomes 2.

### Fixed

- **A handle is recognized across two copies of the package.** The task,
  artifact and handoff handle brands moved from module-local symbols to the
  global registry (`Symbol.for`). A builtin definition imports the component
  library through the package's own `./components` entry while the runtime that
  made the handles may be a second copy of the module; a module-local brand made
  `isTaskHandle` answer false for a handle that is one, so `gate` and
  `verifyAndFix` refused a correct declaration with "pass handle.output … never
  the task handle itself". Nothing about a handle changed, and no frozen shape
  moved.
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
