# Bounded fan-out qualification — macOS arm64

Date: 2026-09-10

A fresh Pi 0.85 process loaded the packaged revision-5 workflow candidate. The
trusted workflow used `ctx.fanOut("items", ...)` to declare three stable item
keys with concurrency 3, then consumed the handles through `ctx.settled()`.

```text
workflow_a590f458ebe24a23bcc14ee04488e76c
["alpha","beta","gamma"]
```

All three task records persisted namespace `["items"]`. Launch receipts at
sequences 11, 17, and 23 were durable before the first child settlement at
sequence 26. Results retained input order. Every child output was imported and
released before the final workflow output committed and the run completed.

No credential marker appeared in the run directory and no QEMU process remained.
