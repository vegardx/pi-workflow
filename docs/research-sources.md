# Research source ledger

Initial architecture research inspected these source snapshots. Behavioral claims
must cite a pinned snapshot before source is adapted.

| Project | Repository | Snapshot | License | Focus |
| --- | --- | --- | --- | --- |
| Pi | <https://github.com/earendil-works/pi-mono> | installed `@earendil-works/pi-coding-agent` 0.84.2 | MIT | SDK, RPC, resources, models, sessions |
| vegardx/pi-subagent | <https://github.com/vegardx/pi-subagent> | `317793f90260f801cac4bb55124eccd5ca83cc7b` | MIT | owned journal, lease, fencing, and crash-safe persistence patterns |
| pi-subagent | <https://github.com/AgwaB/pi-subagent> | `34cdcb04ec94e35d030b2dd77df7aede841b9f8d` | MIT | execution substrate and recovery |
| pi-workflow | <https://github.com/AgwaB/pi-workflow> | `aed281903a07cfa59e54277bb66de9e6c3f865ab` | MIT | artifact graph, leases, invalidation |
| pi-workflow-engine | <https://github.com/timbrinded/pi-workflow-engine> | `b594e32a5f3eb07e12593022a856bb21bdaf4ded` | MIT | typed workflow, replay identity, structured output, worktrees |
| pi-dynamic-workflows | <https://github.com/QuintinShaw/pi-dynamic-workflows> | `f1e05aa766b729788e9c53892cfa0dd940aa36e1` | MIT | capability contract, checkpoints, workflow UI |
| pi-subagents | <https://github.com/nicobailon/pi-subagents> | `8c5269b22253c0cf5af690199fda384dc40b8e0c` | MIT | stable keyed children and steering |
| pi-crew | <https://github.com/melihmucuk/pi-crew> | `47503f068258be488ae028696b35a1ebaacf6f75` | MIT | delegation and owner routing |
| pi-baton | <https://github.com/eiei114/pi-baton> | `9fda443e86c32cbcb363f72e7ff88aeb8f170409` | MIT declaration; notice requires verification | Narrow review state machine |

A later research pass must source-inspect remaining candidates before adoption,
including tintinweb/pi-subagents, pi-subagentura, pi-workflow-os,
@davidorex/pi-workflows, pi-stef agent-workflows, @parke.dev/pi-subagent, and
Firstp1ck workflow runtimes.
