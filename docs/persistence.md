# Persistence and recovery

## Storage

```text
<cwd>/.pi/workflow/runs/<run-id>/
  service.json
  run.json
  events.jsonl
  definition/                      dynamic runs only:
    source.workflow.ts               exact proposed source bytes
    manifest.json                    canonical manifest + "\n"
    proposal.json                    canonical proposal record + "\n"
    approval.json                    canonical source-approval decision record + "\n"
  tasks/<task-id>/
  artifacts/
  decisions/                       checkpoint decision records
<cwd>/.pi/workflow/dynamic/<sourceSha256>/
  source.workflow.ts               exact proposed source bytes
  current                          "<version>\n": the active record pair
  records/<version>/               one manifest.json + proposal.json pair
    manifest.json                    canonical manifest + "\n"
    proposal.json                    canonical proposal record + "\n"
  decisions/                       definition-level source-approval record
```

A bounded global pointer index may live under:

```text
<getAgentDir()>/workflow/run-index.json
```

Directories are mode `0700`; sensitive files are mode `0600`. Prompts, logs,
checkpoint values, context, artifacts, and results are bounded. `service.json`
is an immutable bounded private record containing the exact workflow definition
provenance, project root, input, effective concurrency limit, declared and
effective workflow budgets, declared and effective timeout, absolute deadline,
creation identity, nesting `depth`, and (exactly when `depth >= 1`) the
`parent { runId, taskId, executionId, ancestorDefinitionIdentities,
inputArtifacts }` lineage needed for restart reconstruction. For a child run,
`input` is the merged input actually launched and `inputArtifacts` maps each
injected input name to the `{ runId, artifactId, sha256 }` of the parent
artifact whose verified value was merged in (`{}` when none); every such
`runId` must equal `parent.runId` and every name must be a valid task key, or
the record is rejected on read. It is written before workflow source
starts. A linked child workflow run is a peer directory under the same
`runs/` root, named by its deterministic child run ID.
Credential-shaped metadata is redacted. Source-derived sensitive content that
must be retained is stored as private artifact data, not copied into indexes or
ordinary diagnostics.

## Journal and snapshot

Lifecycle events are append-only, versioned, and the source of truth. Revision
18 rejects revision 1 through revision 17 leases, journals, snapshots, run
records, decision records, and dynamic proposal records; no migration or
dual-format reader is provided.
Revision 18 accepts only the declared run, workflow phase/log effect, task,
artifact, barrier, output-commit, and task-execution events. Agent task-execution evidence records
generation creation, the latest preflight before launch intent (carrying the
launch plan's `workspaceMode` and `workspaceBaselineSha256`), uncertain launch
and reconciled absence or a launch receipt, child observation, bounded terminal
child settlement (with `handoff { attemptId, baselineHead, handoffCommit }`
when a worktree attempt captured one), zero or more retry or resume attempts
(each an intent followed by a receipt with the next observation and
settlement, or by a decline), artifact import, for a completed worktree child
either handoff import (`task-execution-handoff-imported`) or recorded absence
(`task-execution-handoff-absent`), release intent and receipt, and terminal
outcome in that order; an `interrupted` settlement that admits no further attempt records the
`interrupted` terminal outcome directly after the settlement, with no release
intent or receipt, and the task moves to `interrupted` with reason
"Interrupted child retained for recovery; no release performed.". Support
task-execution evidence records generation
creation, support intent, output commit, and terminal outcome in that order.
Nested workflow task-execution evidence records generation creation, nested
intent, nested launch, nested settlement, nested output import, and terminal
outcome in that order. Checkpoint task-execution evidence records generation
creation, the durable request (`task-execution-checkpoint-requested`, phase
`checkpoint-requested`), the decision (`task-execution-checkpoint-decided`,
phase `checkpoint-decided`), and terminal outcome in that order. Each event
family is accepted only on an execution of its own kind: subagent-shaped
events are rejected on support, workflow, and checkpoint executions, support
events on agent, workflow, and checkpoint executions, nested events on agent,
support, and checkpoint executions, and checkpoint events on every other kind
("checkpoint execution target is not a checkpoint task"). An
expired preflight may be replaced only before launch intent is persisted. A
preflight from an older workflow fencing generation is also replaced because
pi-subagent preflight grants are intentionally process-local.
`run.json` is a bounded typed projection rebuilt from those events and is returned only when it exactly equals reduction of the
complete current journal. A valid older snapshot is ignored until rebuilt.
Unknown, divergent, corrupt, or future-version records fail closed.
Within a process the journal remembers its last reduction only as a resume
point: every state read still parses the complete journal file, and the
reducer extends the remembered projection only when the file begins with
exactly the events it covered, otherwise it replays from the start. Nothing
about that resume point is persisted or trusted over the events.

Each run has a single-writer lease backed by an OS-owned localhost listener.
Every workflow state write and workflow-owned effect carries its monotonic
fencing generation. The OS releases ownership when the process dies; a live
owner keeps the listener and prevents replacement. The persisted lease record
is observational and supplies the next generation, not proof of liveness.
The listener names its run: it answers every connection with
`pi-workflow-lease/1 <identity>`, the digest of the canonical store root and
run ID. Ports are a far smaller space than run identities, so acquisition
walks 64 deterministic candidates, preferring the port named in the lease
record. An occupied candidate is probed: only a banner proving a different
run releases the acquirer to the next candidate, and the chosen port is then
recorded so later acquirers meet the owner where it listens. The same
identity, or any occupant that cannot identify itself, fails safe as
temporary unavailability.
Subagent calls
use their owner binding and stable operation IDs because the current public
service does not accept a caller fencing token. Every external side effect still
requires durable intent followed by a durable receipt. In particular, child
release cannot run before `task-execution-release-intended` is durable.

Events carry schema version, sequence number, event ID, timestamp, owner, and
fencing generation. Appends and snapshots use crash-safe write, fsync, and
rename rules. Recovery ignores one provably torn tail record, rejects interior
corruption, and isolates unknown future event versions.

## Materialization records

Every effect declaration is persisted before the scheduler may execute it. Its
identity includes:

```text
workflow definition and source digest
workflow input digest
namespace and stable key
effect kind and request digest
order dependency identities
data dependency artifact identities
schema, disposition, and replay policy
runtime contract revision
```

On re-execution, declarations are compared in ordered epochs separated by
result barriers. Bounded phase and log effects are matched by ordinal and
barrier position; changed, inserted, removed, or barrier-crossing replay effects
fail closed. Each declaration records its global materialization sequence,
epoch, and position within that epoch. Materialization rejects epochs whose
individual events or resulting projection exceed persistence bounds before any
of that epoch is appended. The on-path ordered prefix must match exactly. A
new suffix may extend the last on-path barrier. Explicit invalidation
transactionally abandons the downstream epochs before a different branch can
materialize: one `task-invalidated` event records the exact closure and the
exact abandoned epochs (every on-path epoch after the exposing barrier), and
the reducer marks those barriers, the tasks declared in them, and every effect
sequenced after the exposing barrier `abandoned: true`. Abandoned records stay
in the journal and projection as history; they keep their epoch numbers and
sequences and are never scheduled. New epochs are numbered from the current
epoch upward, after every persisted barrier, and a new or readopted
declaration takes materialization sequence `max + 1` over every persisted
task; effect ordinals continue after every persisted effect. A declaration
beyond the prefix whose `(namespace, key)` matches an abandoned task with an
equal identity digest readopts that task ID with fresh sequence, epoch, and
position fields; the same key with a different identity fails closed with
"abandoned task key re-declared with a changed request". Duplicate keys,
ambiguous matches, changed requests, or insertion/removal/reordering inside a
valid prefix fail closed.

## Task execution records

A logical task may have multiple execution generations after explicit
invalidation. Revision 18 admits generations 1 through
`MAX_TASK_EXECUTION_GENERATIONS = 16`. `task-execution-created` requires the
generation to equal one more than the executions already recorded for the
task, the task to be `ready` and on-path, and no current execution:
re-materialization detaches the terminal previous execution, and the new
execution becomes `currentExecutionId` while every prior execution keeps its
evidence. The
execution ID, subagent operation ID, and nested `childRunId` are derived per
generation. The execution record
is discriminated by `kind: "agent" | "support" | "workflow" | "checkpoint"`;
all kinds share the derived execution ID, run, task, generation, and task
identity digest.

An agent execution (`kind: "agent"`) owns one subagent run and contains:

- generation number and task identity;
- budget allocation and cumulative usage baseline;
- one subagent operation ID and preflight identity;
- initial launch intent and receipt;
- the initial child attempt and every retry or resume attempt: its intent,
  its receipt or decline, and the superseded attempt's settlement evidence;
- imported artifacts;
- for a worktree task, the imported handoff artifact identity (`handoffImport`)
  or the recorded absence of a handoff (`handoffAbsent`);
- terminal classification.

A support execution (`kind: "support"`) carries `implementationIdentitySha256`
and no operation ID. It contains:

- generation number and task identity;
- the implementation identity digest derived from the persisted descriptor;
- durable support intent: implementation, parameter, and input digests;
- the output commit: result artifact ID and content digest;
- terminal evidence of kind `support` (the same digests, `artifactId`,
  `outputSha256`, and a diagnostic `durationMs`) or of kind `workflow` with a
  `support-*` or `stop` stage.

The constructor registry that supplies support implementations is never
persisted. Every restart resolves each journaled descriptor against the new
process's registry by exact canonical identity over name, module specifier,
revision, implementation digest, parameters schema, and output schema; a close
match is a mismatch.

A nested workflow execution (`kind: "workflow"`) carries a deterministic
`childRunId = deriveNestedWorkflowRunId(runId, taskId, generation)` and no
operation ID. It contains:

- generation number and task identity;
- durable nested intent: child definition identity, authored input digest
  (`inputSha256`), the digest map of the producer result artifacts named by
  `spec.inputs` (`inputsSha256`, `{}` when none), the digest of the merged
  input actually launched (`resolvedInputSha256`), the budget reserved from
  the parent, effective timeout, absolute deadline, and concurrency; the
  reducer recomputes `inputsSha256` from journaled artifact state and, when
  `spec.inputs` is empty, requires `resolvedInputSha256` to equal
  `inputSha256`, but it cannot recompute the merged contents when inputs
  exist because artifact values are not journaled;
- the nested launch receipt, recorded once the child run record is durable;
- the nested settlement: the child's terminal status, summed usage,
  `usageComplete`, and (for a completed child) the child-owned output artifact
  ID and digest;
- the output import: the parent-owned result artifact and its child source;
- terminal evidence of kind `nested-workflow` or of kind `workflow` with a
  `nested-input`, `nested-resolution`, `nested-launch`, `nested-import`, or
  `stop` stage.

The child run is a separate durable run with its own journal, lease, artifact
store, and run record; the parent journal never embeds child events. The
parent's execution record and the child's run record reference each other by
identity only. The child record additionally carries `parent.inputArtifacts`,
the identities of the parent artifacts whose verified values were merged into
its input; the parent's intent carries the matching digest map.

Revision 17 records subagent retry and resume attempts under the existing
agent task execution. Every attempt intent carries `origin: "policy"` (written
by the retrier, never with a `reason`) or `origin: "operator"` (a `resume`
intent with an optional `reason`, appended only by the service `resume`
method before the `interrupted -> running` transition), and the attempt
projection retains both fields. A new
execution generation, created only after explicit
invalidation re-materialized the task, requires a new preflight, operation ID,
launch intent, and subagent run.

### Agent attempt recovery

An attempt extends the agent ladder after a durable `failed` or `interrupted`
settlement and before release:

```text
task-execution-child-settled (attemptOrdinal n)
→ task-execution-attempt-intended (ordinal n + 1)
→ task-execution-attempt-receipted (ordinal n + 1)
→ task-execution-child-observed (the new attempt)
→ task-execution-child-settled (attemptOrdinal n + 1)
→ another attempt, or release intent, receipt, and terminal outcome

task-execution-child-settled (attemptOrdinal n)
→ task-execution-attempt-intended (ordinal n + 1)
→ task-execution-attempt-declined (ordinal n + 1)
→ release intent, receipt, and terminal outcome
      (or, for an interrupted settlement, the interrupted terminal outcome
       with no release)

task-execution-child-settled (status interrupted, attemptOrdinal n)
→ [no admissible policy attempt, or a declined one]
→ task-execution-terminal (outcome interrupted)
→ task-status-changed (… → interrupted)
→ task-execution-attempt-intended (kind resume, origin operator, ordinal n + 1)
→ run-status-changed (interrupted → running) admitted without invalidated work
→ receipt or decline as above
```

The last ladder is the operator reopen: the intent deletes the retained
terminal outcome and returns the execution to `attempt-intended`; a decline
leaves it settled and the finalizer re-terminalizes it `interrupted`. Only the
reducer side exists in revision 17.

Restart repairs an agent execution with attempt evidence from its durable
prefix:

| Durable prefix | Recovery |
| --- | --- |
| settled, policy allows another attempt | the retrier persists an intent and performs the attempt call |
| attempt intent only | the retrier reconciles the open intent by operation ID by repeating the attempt call for it: a receipt naming a new attempt ID is recorded; a `RetryBackoffError` is waited out under the stop signal and deadline and the call repeated; a refusal is checked through `findByOperation`, adopting a receipt whose attempt ID differs from `previousAttemptId` and declining the intent otherwise |
| attempt receipted | the new attempt is waited on exactly like the initial launch; observation and settlement then describe that attempt |
| attempt declined | the retained settlement proceeds to release and terminal outcome; no further intents are accepted |
| stop with an open intent | the intent is declined before finalization |

An attempt call that fails for any reason other than backoff is reconciled
through the same operation ID before the intent is declined, so a call that
created an attempt before failing is adopted rather than duplicated. A
reconciliation error is thrown, never converted into a decline or task failure.

### Support execution recovery

Restart repairs an interrupted support execution from its durable prefix:

| Durable prefix | Recovery |
| --- | --- |
| no current execution record | ordinary readiness; a fresh record for the task's next generation (1 for a first execution, otherwise one past the executions already recorded) is created |
| `task-execution-created` only | resolve the registry, persist intent, run |
| intent only | resolve the registry, revalidate inputs and parameters against the intent digests, recompute |
| intent and an artifact blob without `artifact-declared` | recompute; an equal output reuses the blob through the content-addressed store |
| intent and a declared result artifact | verify provenance, digest, canonical encoding, and output schema; commit output and terminal evidence without running |
| output committed | verify the declared artifact against the commit; append terminal evidence with `durationMs` 0 |
| terminal evidence without the task status transition | repair the task status only |
| completed | replay the result artifact; the implementation never runs again |

Recomputation after intent rests on the digest-bound purity contract: the
runtime proves that the implementation identity, parameters, and inputs are the
intended ones and requires the output to satisfy the same schema and bounds,
but it cannot prove that the implementation is deterministic. A crash after
intent and before any output evidence therefore reruns trusted code on that
contract, not on observed evidence.

Output conflict fails closed: a second result artifact for the same producer
terminalizes the execution as `failed` at stage `support-output`, and a
committed artifact that disagrees with the declared one is a persistence error.
Journal, lease, and artifact-store errors during support execution are thrown
rather than converted into task failure. A `running` support task found after
restart with no in-process execution is cancelled directly during stop and is
otherwise repaired or recomputed by the ladder above.

### Worktree handoff recovery

A completed worktree child inserts the handoff step between artifact import
and release intent. A retry or resume attempt gets a fresh pi-subagent
worktree per attempt, and only the final settled attempt's handoff is
imported; prior attempts' handoff identities stay in `priorSettlements`. A new
generation gets a new preflight, baseline, subagent run, and worktree, and the
previous generation's handoff artifact remains declared under its own
`producerExecutionId`. Restart repairs the step from the durable prefix:

| Durable prefix | Recovery |
| --- | --- |
| `artifact-imported`, no handoff evidence | export again when the settlement carries a handoff (the content-addressed blob deduplicates), declare and import once; record absence when it does not |
| `.patch` blob present, no `artifact-declared` | safe orphan; re-export yields identical bytes for the same commit pair, then declare and import |
| `artifact-declared`, no `task-execution-handoff-imported` | append the import event only, without another export call |
| `task-execution-handoff-imported` or `task-execution-handoff-absent` | proceed to release intent |
| terminal `cleanup-blocked` at stage `handoff-import` | explicit reconciliation reconciles the child, persists any replacement observation and settlement, and retries the import; the import event's recovery branch deletes the terminal |
| terminal `cleanup-blocked` at stage `handoff-import` whose export is refused by the bound | the retried import proves the refusal again and supersedes the terminal with `failed` at the same stage ("Workflow handoff exceeds the import bound."), so the run leaves `cleanup-blocked` instead of looping; the child stays unreleased |
| `artifact-imported`, export refused by the bound | append the `failed` terminal ("Workflow handoff exceeds the import bound.") and the task and run transitions; no release intent is ever persisted |
| `released`, handoff absent, policy `required`, no terminal | append the fixed `failed` terminal ("Completed worktree task captured no handoff.") and the task and run transitions |
| terminal `completed` whose handoff artifact is missing or unreadable | `WorkflowTaskFinalizationError` at `handoff-import` ("Completed worktree task has no durable handoff artifact."); the task status is not repaired |

### Nested execution recovery

Restart repairs an interrupted nested workflow execution from its durable
prefix in the parent journal together with the child run directory:

| Durable prefix | Recovery |
| --- | --- |
| no current execution record | ordinary readiness; a fresh record for the task's next generation with its derived `childRunId` is created |
| `task-execution-created` only | recompute intent from the declaration and the parent deadline; under one second remaining fails at `nested-launch`; resolve every declared artifact input through the verified path, merge, and validate the merged input, failing at `nested-input` on any problem |
| intent only | recompute the merged input from the same parent artifacts and require both `inputsSha256` and `resolvedInputSha256` to equal the intent; artifacts are immutable, so any read failure or digest disagreement is evidence corruption and fails closed as a thrown persistence error, never as a task failure |
| intent only, no child run directory | the atomic child record write never happened; launch is retried once under the same `childRunId` with the identical merged input and `inputArtifacts` |
| intent only, child run directory present | the existing child must match its lineage (`depth`, parent run, task, execution), definition identity, source digest, merged input, and `inputArtifacts` exactly, otherwise the task fails at `nested-launch`; a directory whose record is missing or unreadable is a persistence error and is thrown, not converted into task failure |
| launched | the child is resumed from its own journal and driven to terminal state; it is never launched again |
| settled, non-completed | terminal evidence is appended with the mapped outcome |
| settled, completed, not imported | the child output is reread with full verification and imported; failure is `cleanup-blocked` at `nested-import` |
| imported | terminal `completed` evidence is appended |
| terminal evidence without the task status transition | repair the task status only |
| completed | replay the parent-owned result artifact; the child is not consulted |

A nested settlement of `cleanup-blocked` is replaced only through explicit
parent reconciliation, which reconciles the child run, waits for its new
terminal status, and appends a replacement settlement; an import-stage
`cleanup-blocked` task retries the import on reconciliation. A `running` or
`cancelling` nested task found after restart during stop is stopped through
its child run and drained to terminal state. Journal, lease, and artifact-store
errors during nested execution are thrown rather than converted into task
failure.

No persisted `running` field proves that a scheduler or child still exists. The
bounded scheduler reselects work and reconstructs active concurrency slots from
the journal after every restart. Scheduler selection and mutations are serialized
process-wide per canonical run directory, while admitted child waits run outside
that queue and settle independently under lease fencing and journal append
serialization. It persists
readiness before launch and stores a bounded child settlement digest,
status, usage, cleanup, failure, and artifact-reference projection without raw
model output, session paths, or JavaScript promises. Completed child settlement
waits for workflow-owned artifact import; every terminal settlement waits for
required child release before task terminalization.

### Checkpoint execution recovery

A checkpoint execution passes through `created -> checkpoint-requested ->
checkpoint-decided -> terminal`. The immutable decision record in `decisions/`
(see [Decision records](#decision-records)) is the durable evidence of the
decision; the result artifact, the `task-execution-checkpoint-decided` event,
the terminal evidence, and the `-> completed` status are projections of it.
The scheduler's sweep on every pass, the executor's `request`, and the
service's `decide` repair every prefix, so the human is never asked twice for
one execution and every prefix converges on the same `decisionSha256`:

| Durable prefix | Recovery |
| --- | --- |
| no current execution record | ordinary readiness; a fresh record for the task's next generation is created (`kind: "checkpoint"`) |
| `task-execution-created` only | resolve and verify the inputs (`checkpoint-input` failure on a missing, ambiguous, or unverifiable input), compute `expiresAt = min(now + timeoutMs, deadlineAt)` when `timeoutMs` is set, append the request; under `checkpoints.headless` a `use-explicit-default` checkpoint records its default at once |
| requested, no decision record | park again (a task left `ready` is repaired to `waiting`); an `expiresAt` that has passed expires it per its policy (`block`: `failed` at `checkpoint-expired`; `use-explicit-default`: default decision) |
| requested, decision record on disk (crash after the record, before the event) | replay the record: the value is put as the result artifact (idempotent by content), declared if absent, the decided event, terminal evidence, and `-> completed` are appended; a record whose value fails the request schema is a persistence error ("Checkpoint decision record does not match its schema.") |
| requested, result artifact declared, no decided event | `putJson` is idempotent; the decided event is appended from the record; a different `result` artifact for the same execution is a conflict ("Checkpoint decision conflicts with existing decision evidence.") |
| decided, no terminal | verify the artifact's provenance, digest, canonical encoding, and schema ("Checkpoint decision artifact provenance is invalid.", "Checkpoint decision artifact could not be read and verified.", "Checkpoint decision artifact does not match its schema."), append terminal `completed` evidence and "Checkpoint decided."; a run-ending failure site reaching this prefix first commits it the same way from the projection (whose provenance and digest the reducer verified at the decided event) |
| terminal evidence without the task status transition | repair the task status only |
| completed | replay the result artifact, validated against the request schema; the approver is not consulted |

A run that ends while a checkpoint is open cancels the checkpoint first
(`task-execution-terminal` outcome `cancelled` at stage `stop`, reason
"Workflow run ended before the checkpoint was decided.", then
`waiting|ready -> cancelled`); a checkpoint already decided but not yet
terminal is committed instead (terminal `completed`, then
`waiting|ready -> completed` "Checkpoint decided."). The reducer rejects
`-> failed`, `-> interrupted`, and `-> cleanup-blocked` while any checkpoint
execution is non-terminal ("run failure leaves a checkpoint open"). The
decided event carries the record's `decidedAt`, and the reducer judges an
operator decision's timeliness by it (`decidedAt < expiresAt`) rather than by
the append time, so a record fsynced moments before `expiresAt` still replays
after the watchdog fired. A parked run that the service shut down is
settled with its lease released; a later session resumes it through `wait`,
`decide`, or `stop`, and the first drive re-parks or completes it from the
ladder above. Journal, lease, artifact-store, and decision-store errors are
thrown rather than converted into task failure.

## Decision records

`<run dir>/decisions/<bindingSha256>.json` holds one canonical JSON
`WorkflowDecisionRecord` per binding:

```ts
interface WorkflowDecisionRecord {
	schema: "pi-workflow-decision";
	contractRevision: 19;
	binding: { kind: "checkpoint"; runId; taskId; executionId; effectSha256 };
	source: "operator" | "default";
	decidedBy?: string; // 1..256; present iff source is "operator"
	reason?: string; // 1..4096
	decidedAt: string; // taken before the fsync; carried on the decided event
	valueSchemaSha256: string; // digest of the request schema
	valueSha256: string; // canonical digest of value; equals the result artifact sha256
	value: unknown;
}
```

The file is named by the digest of the binding, not of the value, so a second
decision for the same binding meets an existing file: byte-identical content
is idempotent, anything else is `WorkflowDecisionRecordError("decision record
already exists for this binding")`. Records are written `wx` to a temporary
name, fsynced, renamed, and the directory fsynced, mode `0600` under a `0700`
directory whose real path must stay inside the run ("workflow decision
directory escapes its run"). Reads refuse symlinks ("workflow decision record
may not be a symlink"), bound the size (`MAX_WORKFLOW_DECISION_RECORD_BYTES`,
1 MiB, "workflow decision record exceeds size limit"), require canonical bytes
("workflow decision record is not canonical"), the schema and consistent
provenance ("invalid workflow decision record"), the requested binding
("workflow decision record does not match its binding"), and a matching value
digest ("workflow decision record digest mismatch"); a record for another run
is refused on put and read ("workflow decision record belongs to another
run"). The store never scans the directory; records are addressed only by
binding. The store is not artifact-backed because artifacts are
content-addressed by value and cannot express "exactly one decision per
binding" or carry approver, source, and timestamp evidence; the decision value
is additionally the execution's JSON `result` artifact so dependents read it
through the ordinary verified input path.

The binding union is discriminated by `kind`. The second member is the
definition-level `source-approval` binding of the dynamic-workflows half,
`{ kind: "source-approval"; definitionIdentitySha256; sourceSha256;
contractRevision: 19 }`, stored in the same record format under
`<storeRoot>/dynamic/<sourceSha256>/decisions/<bindingSha256>.json` through
`WorkflowDecisionRecordStore.openRoot({ directory })`: outside any run, with
no journal and no lease fence, created owner-only if absent, and refusing a
directory whose real path escapes its parent ("workflow decision directory
escapes its root"). Each store admits only its own bindings: the run-scoped
store refuses `source-approval` ("workflow decision record binding does not
belong to a run") and the definition-level store refuses `checkpoint`
("workflow decision record binding does not belong to a definition store").
A `source-approval` record is always an operator decision by a human
(`source: "operator"`, `decidedBy` starting with `human:`, `valueSchemaSha256
= DYNAMIC_SOURCE_APPROVAL_SCHEMA_SHA256`, and a value whose `sourceSha256`
and `definitionIdentitySha256` equal the binding), otherwise "invalid
workflow decision record" on put and read. `deriveDecisionRecordSha256`
(the digest of the whole canonical record) is the run record's
`approvalSha256`. See [Dynamic proposals and run definition
copies](#dynamic-proposals-and-run-definition-copies).

## Dynamic proposals and run definition copies

`<storeRoot>/dynamic/` (mode `0700`, real path checked against the store root:
"dynamic workflow store escapes its root") holds one directory per proposed
source digest. `source.workflow.ts` holds the exact UTF-8 bytes the digest
names and is never rewritten. `manifest.json` and `proposal.json` are derived
data in the canonical artifact JSON form plus a trailing newline
(`canonicalDynamicDocument`), stored as one pair under
`records/<version>/` (`version` is 32 hex characters) and selected by the
pointer file `current` (`"<version>\n"`, mode `0600`); `proposal.json` is a
`DynamicWorkflowProposalRecord` (`schema: "pi-workflow-dynamic-proposal"`,
`contractRevision`, `sourceSha256`, `sourceBytes`, `manifest`,
`manifestSha256`, `hostApiSha256`, `importPolicySha256`,
`definitionIdentitySha256`, `transformer`, `proposer`, `proposedAt`,
`projectRoot`). A new digest is written into a temporary directory
`.<sha>.<pid>.<uuid>.tmp` (each file `wx`, mode `0600`, fsynced; the pair
staged under `records/` and `current` written inside it), renamed to `<sha>`
in one step, and the parent fsynced; a concurrent writer that wins the rename
(`EEXIST`/`ENOTEMPTY`) is re-read instead of overwritten. Re-proposing a
known digest under the same `hostApiSha256` writes nothing and returns the
stored proposal (a differing manifest for the same bytes is "dynamic workflow
proposal manifest differs from the stored manifest", surfaced as "Dynamic
workflow proposal store is corrupt."); under a different `hostApiSha256` (a
package upgrade) a new pair is staged as
`records/.<version>.<pid>.<uuid>.tmp`, renamed to `records/<version>`, and
`current` is replaced through a temporary file and one atomic rename, while
the source bytes and `decisions/` stay. A reader therefore sees the previous
pair up to that rename and the new pair from it, never `manifest.json` and
`proposal.json` of different pairs, whatever the crash point; superseded
pairs are removed before the next replacement, not right after the swap. A
`put` of the same source bytes whose stored pair fails verification (a
dangling or malformed `current`, an edited record) rebuilds the pair the same
way instead of failing forever; source bytes are never repaired. Mutations
are serialized per store root process-wide. The store holds
at most `MAX_DYNAMIC_PROPOSALS` (1024) digests ("dynamic workflow proposal
store is full", surfaced as `conflict` "Dynamic workflow proposal store is
full."); nothing is evicted.

Reads open each file with `O_NOFOLLOW` and refuse symlinked files or
directories ("dynamic workflow record may not be a symlink"), read the pair
`current` names (a missing file, a malformed pointer, or a missing version
directory is "invalid dynamic workflow proposal record"), bound the sizes
(`MAX_DYNAMIC_SOURCE_BYTES` 256 KiB, `MAX_DYNAMIC_MANIFEST_BYTES` 512 KiB,
`MAX_DYNAMIC_PROPOSAL_RECORD_BYTES` 64 KiB: "dynamic workflow record exceeds
size limit"), require fatal UTF-8 ("dynamic workflow record is not valid
UTF-8") and canonical bytes ("dynamic workflow record is not canonical"),
validate the record schema and `sourceBytes` ("invalid dynamic workflow
proposal record"), and recompute the digests: the source bytes must hash to
the record's `sourceSha256` and to the directory name ("dynamic workflow
source digest mismatch"), both the stored and the embedded manifest must
hash to `manifestSha256`, and `definitionIdentitySha256` must equal its
derivation from the record's digests ("dynamic workflow manifest digest
mismatch"). A
missing directory reads as absent (`not-found` "Dynamic workflow proposal
not found: dynamic:<sha>"). `proposals()` is the only directory scan in the
dynamic track: sorted digests, at most 1024, each read verified, and a
corrupt entry reported as `{ ref, issue }` rather than failing the listing.
The decision store keeps its no-scan rule.

`runs/<run-id>/definition/` is written by `run()` after the lease and journal
are open and before the run record is created, so a run record implies the
copies exist: `source.workflow.ts`, `manifest.json`, `proposal.json` (the
proposal record at run time), and `approval.json` (the canonical decision
record), each opened `wx` at mode `0600` ("Workflow run definition copy
already exists." on `EEXIST`), fsynced, then the `definition/` directory and
the run directory fsynced. On resume every file of the copy is verified,
`proposal.json` included: its `sourceSha256`, `hostApiSha256`, and
`importPolicySha256` must equal the run record's and the approval's, its
`manifestSha256` and the digest of its embedded manifest must equal the
approved `manifestSha256` together with the digest of `manifest.json`, and
its `definitionIdentitySha256` is recomputed against the record; the
definition is then built from the verified `manifest.json`. The run record carries `definitionKind:
"dynamic"`, `approvalSha256` (the digest of the copied approval record), and
`hostApiSha256`; static and nested records carry `definitionKind: "static"`
and neither digest, and a record whose kind and digests disagree, or a
dynamic record with `depth >= 1` or a `parent`, is rejected as an invalid run
record. On resume the copy is read with the same `O_NOFOLLOW`, bound, UTF-8,
and canonical discipline and is the only evidence consulted: the proposal
store and the definition-level decision store are never read for an existing
run (see [Resume](#resume)). Static runs write no `definition/` directory.

## Replay identity

A completed task is reusable only when every relevant identity matches:

```text
workflow source/version digest
stable task key and namespace
dependency artifact digests
prompt and delegated-task digest
exact model and thinking
agent definition
concrete tool implementations and grants
skills and context digests
output schema
workspace baseline
support implementation identity (support tasks)
child definition identity, source digest, authored input digest, and
  injected input artifact identities (workflow tasks)
subagent and workflow runtime revisions
```

Ambiguous duplicate matches miss. Replayed structured values are revalidated.
A replayed handoff must validate against its exact immutable baseline, which
is the journaled triple of the launch plan's `workspaceBaselineSha256` on the
preflight (pi-subagent's digest over the clean checkout HEAD, opaque to the
workflow), the settlement's `handoff.baselineHead`, and the imported
artifact's `baselineHead`: the last two must be equal and the first must be
present. The workflow never recomputes the digest from git and does not depend
on pi-subagent's internal derivation. Between generations the baseline may
legitimately differ because a new preflight was taken; the difference is
visible evidence, not an error. Cross-run replay remains unsupported.

Default policy:

- read-only tasks: replay allowed on full identity match;
- support tasks: a completed result replays from its digest-verified
  workflow-owned artifact on full identity match and is never recomputed within
  its run; registry drift fails only non-terminal support executions;
- nested workflow tasks: a completed result replays from the parent-owned
  imported artifact; child source drift changes the declaration identity and
  fails replay of the parent as declaration drift, while an already-launched
  child whose definition no longer resolves exactly fails at `nested-launch`;
- worktree tasks: a completed result replays (`loadTaskResult` reuses it)
  only when the current execution's preflight recorded
  `workspaceMode: "worktree"` and either its handoff artifact
  (`output: "handoff"`, `producerExecutionId` equal to the current execution)
  reads through `readBytes` with digest and format verification, embeds the
  imported `handoffCommit` in its first line, and carries
  `{ attemptId, baselineHead, handoffCommit }` equal to the settlement, or the
  handoff is recorded absent under an `optional` policy; otherwise the load
  fails with "Completed worktree task has no verified handoff artifact.";
- live-branch mutation: not supported by the workflow task contract;
- external web/service tasks: replay disabled unless evidence is captured as an
  immutable declared artifact.

## Service reconstruction

The workflow service resolves run IDs only through existing regular run
directories and never creates state while answering an unknown status request.
It reacquires run fencing, validates `service.json`, rediscovers the exact
trusted definition path and source identity (for a static run) or rebuilds
the definition from the run directory's verified `definition/` copy (for a
dynamic run, without consulting the proposal or decision stores), reacquires the shared subagent owner
client, and composes the same durable runtime. Provider binding happens before
new run state is created. Completed status and output reads need no subagent
acquisition. A linked child run is reconstructed by the same path from its own
directory, and its record's lineage is verified against the parent's nested
intent before the parent resumes waiting on it.

## Resume

Resume:

1. acquires or reclaims the run lease with evidence;
2. reconstructs state from journal events;
3. validates definition, input, runtime, and service compatibility;
4. reconciles active agent executions and open attempt intents by subagent
   operation ID, repairs or recomputes intended support executions, and resumes
   launched child runs without launching them again;
5. re-executes the workflow function from its entry point;
6. replays matching declarations and completed results;
7. incrementally materializes only the newly reached path;
8. continues scheduling committed ready tasks.

Version 1 refuses resume after workflow source identity changes. It does not
reinterpret prior model outputs or human decisions under changed code.

For a dynamic run step 3 verifies the `definition/` copy in this order and
refuses with the named message: a missing, oversized, non-canonical, or
schema-invalid copy ("Workflow run definition copy is missing or corrupt.");
copied source bytes whose digest differs from the record ("Dynamic workflow
source changed since the run was created."); a copied approval that is not a
valid `source-approval` record for the record's definition identity, whose
digest differs from `approvalSha256`, or whose decision is not `approved`
("Dynamic workflow approval record changed since the run was created."); a
current host API digest different from the record's ("Dynamic workflow host
API changed since the run was created."); a current import policy digest
different from the approval's ("Dynamic workflow import policy changed since
approval."); a copied manifest or proposal identity that disagrees with the
approval or record ("Dynamic workflow manifest changed since approval."); and
a different project directory ("Workflow definition, source, or project
identity changed."). Steps 5 through 7 then boot a fresh worker-thread VM for
this drive: the source is transformed and re-executed from entry, its
synchronous declarations are matched against the journaled prefix by the
same static runtime, and completed results replay through the asynchronous
barrier replies. No VM state survives a drive; a checkpoint park terminates
the worker, and the drive after the decision boots a new one.

## Retry versus resume

A retry attempt follows a durable `failed` settlement whose failure is
classified `backoff` or `manual` and listed in the task's `retry.on`; the
retrier persists `task-execution-attempt-intended`, calls pi-subagent `retry`
on the existing child run, and persists the receipt of the fresh attempt under
the same workflow task execution. A resume attempt follows a durable
`interrupted` settlement whose failure is classified `resume` and calls
`resume` on the same run under the task's `resume` policy. Both count receipted
attempts of their kind against `policy.attempts`, never exceed
`MAX_TASK_ATTEMPTS`, and stop once an intent has been declined. Neither
changes the execution generation. Resuming an interrupted workflow run is a
separate concern: it reconstructs state and continues scheduling, and a child
attempt happens only when the task policy allows it. Re-execution after
explicit invalidation, triggered through the service's `invalidate`, creates a
new workflow task-execution generation with its own preflight, operation ID,
and subagent or child run. All paths preserve prior evidence: each superseded
attempt's settlement is retained in `priorSettlements`, every prior generation
keeps its execution record and artifacts, and settled usage is summed across
every attempt of every generation of the task.

## Artifact ownership

Workflow result artifacts are canonical JSON blobs under the private run
artifact directory. Writes are content-addressed, bounded per blob and per run,
serialized process-wide, written through fsync and atomic rename, and fenced by
the workflow lease. Reads revalidate metadata, canonical encoding, size, and
content digest. Artifact identity separately binds run, producer task,
producer execution (`producerExecutionId`, required exactly when a producer
task is named), output name, schema digest, and content digest, so a new
generation's result is a distinct artifact even when its bytes equal the prior
generation's; identical canonical bytes share one content-addressed blob on
disk while the references differ. Downstream reads select the artifact whose
`producerExecutionId` is the producer's current execution; prior-generation
artifacts stay in the journal as provenance, and a child run record's
`inputArtifacts` keeps naming the exact artifact its input was derived from.
Before downstream preflight, each
explicitly named input is reread from this store and checked against its handle,
producer task, producer output schema, and journaled artifact reference. The
canonical value is projected into a bounded delegated context envelope; store
paths are never forwarded. A blob written before its declaration is a safe
recoverable orphan; restart deterministically reuses it before persisting
declaration and import evidence. The final workflow output uses the
same store without a task producer and is bound to the definition output schema.
Run completion requires a durable output-artifact commit; a crash after that
commit resumes only the final status transition.

Handoff artifacts share the same store. `putBytes` writes an exported
pi-subagent handoff as a content-addressed `<sha256>.patch` blob next to the
`<sha256>.json` result blobs, under the same process-wide mutation queue,
lease fencing, temp-file/fsync/rename path, per-run total bound (`.patch`
entries count, and any other extension is an invalid entry), and
existing-blob digest check, with `output: "handoff"`, `mediaType:
"application/x-git-format-patch"`, and `schemaSha256 =
WORKFLOW_HANDOFF_FORMAT_SHA256`, the canonical digest of the fixed format
document `{ format: "git-format-patch", mediaType, revision: 6 }`. All three
producer fields are required, and the per-blob bound is the smaller of the
store bound and `MAX_WORKFLOW_HANDOFF_BYTES` (16 MiB): "workflow handoff
artifact is empty", "workflow handoff artifact exceeds byte limit", and
"invalid workflow handoff artifact metadata" are the fixed errors. `readBytes`
revalidates the reference, run, deterministic id, media type, output, format
digest, and byte bound, requires a regular non-symlink file of the recorded
size, verifies the SHA-256, and requires the first line
`From <object id> Mon Sep 17 00:00:00 2001` ("workflow handoff artifact is not
a git-format-patch"); the embedded object id is compared to the imported
`handoffCommit` by the finalizer and the replay verifier, not by the store.
`readJson` continues to refuse any non-`application/json` reference, so a
patch can never be read as a value. One result and one handoff artifact may
coexist per producer execution, and identical handoff bytes across generations
share one blob under distinct references.

Subagent artifacts are attempt evidence. Workflow imports every artifact needed
for downstream execution, result delivery, resume, or replay using owner and
digest verification. Workflow retention never depends on an unpinned subagent
artifact that may expire independently.

A child workflow run's artifacts belong to the child. The parent imports the
child's declared output by rereading it through the child's own store with
provenance, digest, canonical-encoding, media-type, and schema verification,
validating it against the output schema captured at declaration, and writing it
as a parent-owned result artifact bound to the parent task before the parent
task completes. Values flow the other way by the same copy discipline: each
artifact input declared on a nested task is read from the parent-owned store
through the verified path at launch and merged into the child's input, which
is then persisted in the child's own `service.json`. A parent handle never
points into a child store, and a child never reads its parent's store.

### Cross-run provenance

The injected artifact identities recorded in a child's
`parent.inputArtifacts` (`{ runId, artifactId, sha256 }` per input name) are
the only cross-run artifact references the runtime persists. They are
provenance: they bind the child's input to the exact parent artifacts it was
derived from, are re-verified against the parent's intent on resume, and are
exposed on the child's service view. They are not handles. No live cross-run
read path exists: a child cannot dereference them, the artifact store never
resolves an id from another run, and a value crosses the run boundary only as
a verified copy bound by digest into the receiving run's record or store.

Worktree execution imports the child's handoff through pi-subagent's public
digest-verified `exportHandoff` into this store before the child is released;
the imported `.patch` blob and its declared reference are the only
workflow-owned handoff evidence, and the workflow never reads a subagent
worktree, branch, or ref. A pi-subagent `WorktreeRecord`, host path, branch,
or ref name alone is not a workflow-owned artifact and is never persisted;
only the `{ attemptId, baselineHead, handoffCommit }` identity is journaled.

## Finalizers

Finalizers are task records with `role: "finalizer"` in the same journal,
declared and committed with the ordinary graph and executed through the same
agent, support, or nested execution ladders. They persist no separate store.
The run ladder is `run-status-changed (running → finalizing)` →
`run-output-committed` → finalizer readiness, executions, and settlement →
`run-status-changed (finalizing → completed | completed-degraded)`; a required
finalizer that fails or is interrupted appends `finalizing → failed` or
`finalizing → interrupted`, and a required finalizer left `blocked` appends
`finalizing → failed` with reason "Workflow output finalization failed.".
Restart inside `finalizing` before the output commit selects nothing until the
static runtime recommits from its replayed value; restart after the commit
re-drives the remaining finalizers. Recovery of a failed or interrupted
finalizer is an ordinary invalidation whose closure may hold only finalizers
after the output commit; replay re-materializes it at the final barrier,
matches the committed output artifact, re-enters `finalizing`, and creates its
next execution generation.

Artifact import and subagent release are runtime steps of every agent
execution, not finalizer tasks. Retained, blocked, or unknown required cleanup
maps to `cleanup-blocked` until reconciliation or release proves the required
postcondition and returns a new mappable terminal result. Workflow retains the
original observed status and failure as evidence but does not infer a hidden
primary outcome from a subagent `cleanup-blocked` result.
