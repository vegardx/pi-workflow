# Phase 1 qualification — macOS arm64

Date: 2026-09-07

## Environment

| Component | Qualified value |
| --- | --- |
| Host | macOS 26.6.2, arm64 |
| Node.js | 24.16.0 |
| Pi | 0.85.0 |
| Model | `github-copilot/gpt-5.6-luna:low` |
| pi-web | `d747380f97d9785c0d083e756e15dcf8fb8358b1` |
| pi-subagent | `55e84bd731e2017510ee85b2df898e7f2d3679f2` |
| pi-workflow | `8e86d2a24bc4f8b46bb58fe192198fc6fc1a0d7a` |

The Radical AI extension emitted an unrelated warning that its own tested Pi
range ended before 0.85. The selected GitHub Copilot model and the three owned
packages loaded and executed normally.

## Successful real workflow

A fresh Pi print-mode process loaded the packaged workflow extension alongside
the configured standalone pi-subagent and pi-web extensions. A trusted project
workflow declared one read-only named agent using host-brokered `search` and
`fetch`. The parent invoked `workflow_list`, `workflow_validate`, `workflow_run`,
and `workflow_wait`.

The first drive exposed a real integration defect: pi-subagent canonicalized the
tool grant to `fetch,read,search`, while workflow compared it to caller order
`search,fetch,read`. The task failed before launch. A direct provider preflight
proved the grant and named agent were valid. PR #17 changed tool, skill, and
context-scope comparison to canonical unique-set comparison while retaining
exact value-bearing launch identity checks.

The corrected run completed:

```text
workflow_e0c08860e8ae4af4bb67f21112e2c5bd
Pi Coding Agent
https://pi.dev/
```

Durable evidence proved:

- one launch intent and one launch receipt;
- one subagent run and initial attempt;
- completed structured output with a bound result digest;
- workflow-owned artifact declaration and import;
- child release receipt;
- terminal execution and completed task;
- final workflow output artifact commit;
- `finalizing -> completed`;
- proved sandbox cleanup and no remaining QEMU process.

The child used 9 uncached input tokens, 156 output tokens, 8,135 cache-read
tokens, and 5,558 cache-write tokens over 7,752 ms. Cache telemetry remained
non-budget consumption as defined by pi-subagent.

A separate fresh Pi process called `workflow_status` and `workflow_wait` for the
completed run and returned the exact persisted output without launching another
child:

```text
REPLAY_OK completed Pi Coding Agent https://pi.dev/
```

No `API_KEY`, authorization, bearer, Exa-key, or Context7-key marker appeared in
the workflow run record, journal, or workflow-owned artifacts.

## Graceful shutdown

A delayed real child reached a durable active launch receipt in:

```text
workflow_5a40d2074bd74840ba5ea4a2f664c2aa
```

The actual Pi Node process received `SIGTERM`. Session shutdown persisted run
stop intent and task cancellation intent before interrupting the child. It then
persisted `stopping`, cancelled child settlement, release intent and receipt,
terminal execution evidence, task cancellation, and `stopping -> cancelled`.
The process exited only after the drain completed. No QEMU process remained.

## Abrupt shutdown and conservative recovery

A delayed child reached a durable active launch receipt in:

```text
workflow_02849296ed084df0b5d439f5d550c088
```

The actual Pi Node process received `SIGKILL`. QEMU PID 14143 remained, proving
that abrupt parent loss does not itself guarantee VM cleanup. A replacement Pi
process reconstructed the workflow without a second launch receipt and retained
`cleanup-blocked`. Direct pi-subagent reconciliation matched and removed the
stale VM; the child then became `interrupted` with resume guidance.

Workflow intentionally remains `cleanup-blocked` because Phase 1 does not grant
automatic child resume or destructive abandonment. PR #17 adds explicit
cleanup reconciliation, replacement settlement evidence, and repeated release
handling when reconciliation produces a releasable terminal status. An
`interrupted` child remains action-required rather than being mislabeled as
success or ordinary failure.

This is accepted conservative recovery evidence, not a claim that abrupt runs
automatically resume.

## Result

The Phase 1 static vertical slice is qualified for normal execution, completed
replay, graceful shutdown, and conservative abrupt recovery on macOS arm64.
Explicit interrupted-child resume remains Phase 3 work. Ordinary CI continues
to provide Ubuntu build and portability evidence only.
