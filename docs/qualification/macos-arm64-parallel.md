# Bounded parallel qualification — macOS arm64

Date: 2026-09-11

## Environment

```text
macOS arm64
Node.js 24.16.0
Pi 0.85.0
pi-workflow candidate: feat/parallel-execution
pi-subagent: 55e84bd731e2017510ee85b2df898e7f2d3679f2
model: github-copilot/gpt-5.6-luna:low
```

## Real parallel result barrier

A trusted workflow declared two independent read-only tasks, set definition
concurrency to 2, and awaited both through one `ctx.results` barrier. A fresh Pi
print-mode process loaded the packaged extension and completed:

```text
workflow_e3e7d5bf2b21449e980c2f94be13ef7b
{"first":"alpha","second":"beta"}
```

The journal proves both launch receipts were durable before either child
settlement:

```text
launch receipt sequences: 10, 16
child settlement sequences: 19, 28
```

Both children used distinct subagent runs and Gondolin attempts. The result
tuple retained declaration order. Unit coverage independently resolves the
second child first and verifies both settlements remain valid. Both outputs were
imported into the workflow artifact store, both child
runs were released, and the final output artifact committed before
`finalizing -> completed`.

No credential marker appeared in the workflow run directory and no QEMU process
remained after completion.

## Graceful shutdown with two active children

A second fresh Pi process launched a workflow whose two agents were blocked in
separate 30-second guest commands. After both launch receipts were durable, the
Pi process received `SIGTERM`:

```text
workflow_2ae450bd84de4fdf92077697f2a66c87
launch receipts: 10, 16
child settlements: 22, 30
release receipts: 24, 32
terminal executions: 25, 33
final status: cancelled
```

Shutdown persisted run and task stop intent, interrupted and settled both
children, released both subagent runs, terminalized both tasks, and exited only
after `stopping -> cancelled`. Both settlements reported proved sandbox cleanup.
No credential marker appeared in the workflow run directory and no QEMU process
remained.

## Result

The persisted effective concurrency now controls execution. Scheduler selection
and journal mutation remain serialized in materialization order, while admitted
child waits settle independently outside the mutation queue. Process-local
claims prevent duplicate waits within one scheduler instance; restart derives
active work from durable launch receipts rather than those claims.
