# Persistence and recovery

## Storage

```text
<cwd>/.pi/workflow/runs/<run-id>/
  service.json
  run.json
  events.jsonl
  definition/
  tasks/<task-id>/
  artifacts/
  checkpoints/
  finalizers/
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
15 rejects revision-1 through revision-14 leases, journals, snapshots, and run
records; no migration or dual-format reader is provided. Revision 15 accepts
only the declared run, workflow phase/log effect, task, artifact, barrier,
output-commit, and task-execution events. Agent task-execution evidence records
generation creation, the latest preflight before launch intent, uncertain launch
and reconciled absence or a launch receipt, child observation, bounded terminal
child settlement, zero or more retry or resume attempts (each an intent followed
by a receipt with the next observation and settlement, or by a decline),
artifact import, release intent and receipt, and terminal outcome in that
order. Support task-execution evidence records generation
creation, support intent, output commit, and terminal outcome in that order.
Nested workflow task-execution evidence records generation creation, nested
intent, nested launch, nested settlement, nested output import, and terminal
outcome in that order. Each event family is accepted only on an execution of
its own kind: subagent-shaped events are rejected on support and workflow
executions, support events on agent and workflow executions, and nested events
on agent and support executions. An
expired preflight may be replaced only before launch intent is persisted. A
preflight from an older workflow fencing generation is also replaced because
pi-subagent preflight grants are intentionally process-local.
`run.json` is a bounded typed projection rebuilt from those events and is returned only when it exactly equals reduction of the
complete current journal. A valid older snapshot is ignored until rebuilt.
Unknown, divergent, corrupt, or future-version records fail closed.

Each run has a single-writer lease backed by an OS-owned localhost listener.
Every workflow state write and workflow-owned effect carries its monotonic
fencing generation. The OS releases ownership when the process dies; a live
owner keeps the listener and prevents replacement. The persisted lease record
is observational and supplies the next generation, not proof of liveness.
Lease ports are deterministic from run identity; a collision or unrelated local
listener fails safe as temporary unavailability rather than selecting another
port without shared authority.
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
invalidation. Revision 15 admits generations 1 through
`MAX_TASK_EXECUTION_GENERATIONS = 16`. `task-execution-created` requires the
generation to equal one more than the executions already recorded for the
task, the task to be `ready` and on-path, and no current execution:
re-materialization detaches the terminal previous execution, and the new
execution becomes `currentExecutionId` while every prior execution keeps its
evidence. The
execution ID, subagent operation ID, and nested `childRunId` are derived per
generation. The execution record
is discriminated by `kind: "agent" | "support" | "workflow"`; all kinds share
the derived execution ID, run, task, generation, and task identity digest.

An agent execution (`kind: "agent"`) owns one subagent run and contains:

- generation number and task identity;
- budget allocation and cumulative usage baseline;
- one subagent operation ID and preflight identity;
- initial launch intent and receipt;
- the initial child attempt and every retry or resume attempt: its intent,
  its receipt or decline, and the superseded attempt's settlement evidence;
- imported artifacts;
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

Revision 15 records subagent retry and resume attempts under the existing
agent task execution. A new execution generation, created only after explicit
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
```

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
Replayed repository patches or handoffs must validate against their exact
immutable baseline.

Default policy:

- read-only tasks: replay allowed on full identity match;
- support tasks: a completed result replays from its digest-verified
  workflow-owned artifact on full identity match and is never recomputed within
  its run; registry drift fails only non-terminal support executions;
- nested workflow tasks: a completed result replays from the parent-owned
  imported artifact; child source drift changes the declaration identity and
  fails replay of the parent as declaration drift, while an already-launched
  child whose definition no longer resolves exactly fails at `nested-launch`;
- isolated worktree tasks: replay allowed only with verified retained handoff
  evidence and exact baseline;
- live-branch mutation: not supported by the workflow task contract;
- external web/service tasks: replay disabled unless evidence is captured as an
  immutable declared artifact.

## Service reconstruction

The workflow service resolves run IDs only through existing regular run
directories and never creates state while answering an unknown status request.
It reacquires run fencing, validates `service.json`, rediscovers the exact
trusted definition path and source identity, reacquires the shared subagent owner
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

The initial read-only slice imports structured/output artifacts only. Worktree
execution is rejected until pi-subagent exposes bounded handoff content through
a public digest-verified export. A persisted `WorktreeRecord`, host path, branch,
or commit name alone is not a workflow-owned artifact and cannot satisfy this
requirement.

## Finalizers

Required finalizers, including artifact import and subagent release, settle
before workflow success. Advisory UI, metrics, or retention finalizers may fail
without failing an otherwise valid run, but produce `completed-degraded` and
remain visible. Retained, blocked, or unknown required cleanup maps to
`cleanup-blocked` until reconciliation or release proves the required
postcondition and returns a new mappable terminal result. Workflow retains the
original observed status and failure as evidence but does not infer a hidden
primary outcome from a subagent `cleanup-blocked` result.
