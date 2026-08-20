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

Lifecycle events are append-only, versioned, and the source of truth. `run.json`
is a bounded projection rebuilt from events. Corrupt or future-version records
are isolated and fail closed.

Each run has a single-writer lease with a monotonic fencing generation carried
by every workflow state write and workflow-owned effect. Reclamation requires
proof that the prior owner process is absent in addition to heartbeat expiry, so
a live stale scheduler cannot coexist with a replacement owner. Subagent calls
use their owner binding and stable operation IDs because the current public
service does not accept a caller fencing token. Every external side effect still
requires durable intent followed by a durable receipt.

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
result barriers. The still-valid ordered prefix must match exactly. A new suffix
may extend the last reached path. Explicit re-execution that replaces a concrete result transactionally
invalidates its downstream epochs before a different branch can materialize;
those prior records become abandoned history. Duplicate keys, ambiguous
matches, changed requests, or insertion/removal/reordering inside a valid prefix
fail closed.

## Task execution records

A logical task may have multiple execution generations after explicit
invalidation. Each agent-task execution generation owns one subagent run and
contains:

- generation number and task identity;
- budget allocation and cumulative usage baseline;
- one subagent operation ID and preflight identity;
- initial launch intent and receipt;
- every child retry/resume attempt and control receipt;
- imported artifacts;
- terminal classification.

Subagent retry and resume add attempts to the existing task execution. A new
execution generation requires a new preflight, operation ID, launch intent, and
subagent run.

No persisted `running` field proves that a scheduler or child still exists.

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
