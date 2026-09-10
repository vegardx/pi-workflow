# Bounded fan-in qualification — macOS arm64

Date: 2026-09-10

A fresh Pi 0.85 process loaded the packaged revision-6 workflow candidate. Three
namespaced fan-out agents produced workflow-owned JSON artifacts. One
`ctx.fanIn()` aggregate agent consumed them under explicit stable input names.

```text
workflow_21f7241dec23447bbcb98a087f6d65d5
{"values":["alpha","beta","gamma"]}
```

The aggregate task record contained exactly `item-0`, `item-1`, and `item-2` as
artifact inputs and all three producer task references as order dependencies.
The three source launch receipts were sequences 12, 18, and 24; the aggregate
launched at sequence 58 only after source import, release, and completion. The
aggregate received bounded canonical envelopes rather than artifact-store paths.

All four child runs released, the workflow completed, no credential marker
appeared in the run directory, and no QEMU process remained.
