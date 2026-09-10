# Settled-result qualification — macOS arm64

Date: 2026-09-10

A fresh Pi 0.85 process loaded the packaged revision-4 workflow candidate. The
trusted workflow declared two optional tasks behind one `ctx.settled()` barrier:
one valid named agent and one intentionally missing agent. Concurrency was 2.

```text
workflow_4096e72771724624a8bab8a4e003c6cf
{
  "failure": "Subagent preflight failed before launch.",
  "fulfilled": "fulfilled",
  "rejected": "rejected"
}
```

The missing agent durably failed at preflight without a child launch. The valid
sibling launched in Gondolin, completed, imported its workflow-owned artifact,
and released. The settled barrier returned declaration-ordered fulfilled and
rejected records, including bounded workflow failure evidence. The run finished
`completed-degraded`, preserving optional-task disposition rather than failing
the workflow source because one admitted scheduler lane rejected after durable
task failure.

Journal evidence records barrier kind `settled`, one failed task, one completed
task, and final `completed-degraded`. No credential marker appeared in the run
directory and no QEMU process remained.
