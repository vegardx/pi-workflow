# Persistence and recovery

## Storage

```text
<cwd>/.pi/workflow-runs/<run-id>/
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
checkpoint values, context, artifacts, and results are bounded.
Credential-shaped metadata is redacted. Source-derived sensitive content that
must be retained is stored as private artifact data, not copied into indexes or
ordinary diagnostics.

## Journal and snapshot

Lifecycle events are append-only, versioned, and the source of truth. Revision
1 accepts only the declared run, task, artifact, barrier, and task-execution
events. Task-execution evidence records generation creation, the latest
preflight before launch intent, uncertain launch and reconciled absence or a
launch receipt, child observation, bounded terminal child settlement, artifact
import, release intent and receipt, and terminal outcome in that order. An
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
result barriers. Each declaration records its global materialization sequence,
epoch, and position within that epoch. Materialization rejects epochs whose
individual events or resulting projection exceed persistence bounds before any
of that epoch is appended. The still-valid ordered prefix must match exactly. A
new suffix
may extend the last reached path. Explicit re-execution that replaces a concrete result transactionally
invalidates its downstream epochs before a different branch can materialize;
those prior records become abandoned history. The current reducer validates and
records exact transitive invalidation, while materializer replay of invalidated
state remains unavailable until task-execution generations land in phase 3.
Duplicate keys, ambiguous
matches, changed requests, or insertion/removal/reordering inside a valid prefix
fail closed.

## Task execution records

A logical task may have multiple execution generations after explicit
invalidation. Revision 1 currently admits generation 1 only; later generations
remain unavailable until transactional invalidation lands. Each agent-task
execution generation owns one subagent run and
contains:

- generation number and task identity;
- budget allocation and cumulative usage baseline;
- one subagent operation ID and preflight identity;
- initial launch intent and receipt;
- the initial child attempt in Phase 1;
- imported artifacts;
- terminal classification.

Phase 3 adds subagent retry/resume attempts and control receipts to the existing
task execution. A new execution generation requires a new preflight, operation
ID, launch intent, and subagent run.

No persisted `running` field proves that a scheduler or child still exists.
The sequential scheduler reselects work from the journal after every restart.
Scheduler mutations are serialized process-wide per canonical run directory, in
addition to lease fencing and journal append serialization. It persists
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
subagent and workflow runtime revisions
```

Ambiguous duplicate matches miss. Replayed structured values are revalidated.
Replayed repository patches or handoffs must validate against their exact
immutable baseline.

Default policy:

- read-only tasks: replay allowed on full identity match;
- isolated worktree tasks: replay allowed only with verified retained handoff
  evidence and exact baseline;
- live-branch mutation: not supported by the workflow task contract;
- external web/service tasks: replay disabled unless evidence is captured as an
  immutable declared artifact.

## Resume

Resume:

1. acquires or reclaims the run lease with evidence;
2. reconstructs state from journal events;
3. validates definition, input, runtime, and service compatibility;
4. reconciles active task executions and subagent operation IDs;
5. re-executes the workflow function from its entry point;
6. replays matching declarations and completed results;
7. incrementally materializes only the newly reached path;
8. continues scheduling committed ready tasks.

Version 1 refuses resume after workflow source identity changes. It does not
reinterpret prior model outputs or human decisions under changed code.

## Retry versus resume

Retry after a classified agent-task failure calls pi-subagent `retry` on the
existing child run and records its fresh attempt and VM under the same workflow
task execution. Resume continues an interrupted workflow run and records a
subagent `resume` attempt under that same execution. Re-execution after explicit
dependency invalidation creates a new workflow task-execution generation,
preflight, operation ID, and child run. All paths preserve prior evidence and
cumulative budget usage.

## Artifact ownership

Workflow result artifacts are canonical JSON blobs under the private run
artifact directory. Writes are content-addressed, bounded per blob and per run,
serialized process-wide, written through fsync and atomic rename, and fenced by
the workflow lease. Reads revalidate metadata, canonical encoding, size, and
content digest. Artifact identity separately binds run, producer task, output
name, schema digest, and content digest. A blob written before its declaration
is a safe recoverable orphan; restart deterministically reuses it before
persisting declaration and import evidence.

Subagent artifacts are attempt evidence. Workflow imports every artifact needed
for downstream execution, result delivery, resume, or replay using owner and
digest verification. Workflow retention never depends on an unpinned subagent
artifact that may expire independently.

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
