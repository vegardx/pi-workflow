# Pipeline builder qualification — macOS arm64

Date: 2026-09-10

A fresh Pi 0.85 process loaded the packaged revision-7 workflow candidate. A
trusted workflow used `ctx.pipeline("analysis", builder)` to declare `collect`
and `review` stages. The review stage explicitly consumed the collect artifact.

```text
workflow_d633bdbaf9754d37aedeed976cbe26a5
{"approved":"pipeline-data"}
```

Both task records persisted namespace `["analysis"]`; the review task had one
named `input` artifact and its producer order dependency. The collect output was
imported and released before review launch. Review output became the final
workflow artifact and the run completed.

No credential marker appeared in the run directory and no QEMU process remained.
