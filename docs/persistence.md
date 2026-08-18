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
checkpoint values, context, artifacts, and results are bounded. Credential-shaped
metadata is redacted, while unavoidable source-derived secrets are treated as
sensitive artifact content with explicit retention.

## Journal and snapshot

Lifecycle events are append-only, versioned, and the source of truth. `run.json`
is a bounded projection rebuilt from events. Corrupt or future-version records
are isolated and fail closed.

Each run has a single-writer lease with a monotonic fencing token carried by
every state write and external command. Reclamation requires owner/process
evidence in addition to heartbeat expiry. External side effects require
persisted intent followed by a durable receipt.

Events carry schema version, sequence number, event ID, timestamp, owner, and
fencing token. Appends and snapshots use crash-safe write/fsync/rename rules.
Recovery ignores one provably torn tail record, rejects interior corruption,
and isolates unknown future event versions.

## Replay identity

A completed task is reusable only when all relevant inputs match:

```text
workflow source/version digest
stable task key
dependency artifact digests
prompt and system-prompt digest
exact model and thinking
agent definition
concrete tool implementations and grants
skills and context digests
output schema
workspace baseline
runtime version
```

Ambiguous duplicate matches miss. Replayed structured values are revalidated.
Replayed patches must validate against the exact immutable baseline.

Default policy:

- read-only tasks: replay allowed on full identity match;
- isolated patch tasks: replay allowed only with a validated retained patch;
- live-branch mutation: replay disabled unless exact postconditions are restored;
- external web/service tasks: replay disabled unless evidence is captured as an
  immutable declared artifact.

## Resume

Resume reconstructs the snapshot, validates workflow source compatibility, and
re-executes the workflow function from its entry point through the effect
interpreter. Matching completed effects replay; active effects reconcile;
missing or invalidated effects execute live; old unobserved effects become
abandoned history. It never treats a persisted `running` field as proof that a
child still exists.

## Retry versus resume

Retry creates a new task execution after a classified failure. Resume continues
the workflow run after interruption. Both create new subagent attempts through
`SubagentService` and preserve prior evidence.

## Artifact ownership

Subagent artifacts are attempt evidence. Workflow imports or pins every artifact
needed for downstream execution, resume, or replay using owner and digest
verification. Workflow retention cannot depend on a subagent artifact that may
expire independently.

## Finalizers

Required finalizers, including worktree cleanup and artifact commit, must settle
before workflow success. Advisory UI, metrics, or retention finalizers may fail
without replacing an otherwise valid result, but their failure remains visible.
