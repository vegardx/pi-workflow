---
name: workflow-components
description: Reference tables for @vegardx/pi-workflow/components — what each component lowers to, its key rule, its refusals, the effort envelope, the shared Finding, and the compiled stage document. Use when reading or reviewing a compiled workflow graph; preloaded by the plan-review workflow.
---

# The component library

A **reference**, not a tutorial: tables only. `@vegardx/pi-workflow/components`
is pure TypeScript over `WorkflowContext` that declares only existing runtime
primitives. **After materialization a component is indistinguishable from
hand-written authoring** — no contract revision, no frozen shape, nothing in
the runtime. The patterns in `workflow-authoring` are the primary artifact; a
component is their executable form.

## The three replay laws

Every component obeys all three, which is what makes a re-execution declare the
identical prefix:

1. **Keys** are a pure function of (namespace, declaration ordinal, a
   caller-supplied stable id). Never a clock, a hash of prose, an index into
   data that post-dates a barrier, or a random value.
2. **Fan-out data** originates in `ctx.input` or in a value a barrier already
   returned.
3. **Effort, model and budget** choices are table lookups keyed by `ctx.input`
   (and, in a bounded loop, the round ordinal).

A graph that breaks one of these is a replay bug, not a style problem.

## Components

| Component | Lowers to | Key rule | Refuses at declaration |
| --- | --- | --- | --- |
| `gate(ctx, key, {question, show?, schema, headless?, timeoutMs, default?})` | `ctx.checkpoint` | key literal; `show` → `inputs` | a schema that is not a flat object of 1–8 leaves — no gate silently degrades to a raw JSON editor; a `question` that is not a question |
| `envelope(effort, stage)` | `meta.budget` + per-task `limits`/`model` | pure table keyed by `(effort, stage)` | an unknown effort or stage name |
| `forEach(ctx, ns, items, {idOf, task, disposition?})` | `ctx.fanOut` | `key(item) = idOf(item)` | >64 items; a duplicate id; an `idOf` reading an optional field; a budget over-projection |
| `reviewFanOut(ctx, ns, lenses, {subject, synthesis, diversity})` | `ctx.fanOut` (`optional`) + `ctx.settled` + optional `ctx.fanIn` | `key = lens.id`; duplicates take `-2`, `-3` **by declaration ordinal** | >16 lenses |
| `verifyAndFix(ctx, ns, {implementation, check, effort, maxRounds, escalate, verify, agent})` | a fixed bounded loop of `ctx.agent` + `ctx.result` | flat keys `<ns>-verify-<n>` / `<ns>-fix-<n>`, `n` from 1 | `maxRounds` outside `0..MAX_VERIFY_ROUNDS`; a worst-case budget the run cannot admit |

`maxRounds` counts **verify** rounds, so at most `maxRounds - 1` fixers run and
a fix is never left unchecked. `escalate: "thinking"` moves every fixer one rung
up the ladder; verifiers never escalate, and escalating past `deep` is refused.
`checkRan: false` escalates to a human and never counts as green.

Deferred, on purpose: `sequence` (`ctx.pipeline` is one line), `branch`,
`retrying`, `loopUntil`, `mapReduce`, `dynamicStage`, `subWorkflow`.

## The effort envelope

`envelope(effort, stage)` → `{effort, stage, thinking, model, limits,
budgetShare}`. Stages: `refine`, `implement`, `verify`, `fix`, `review`,
`synthesis`, `record`. `implement` and `fix` write in a worktree; every other
stage is read-only with `workspaceWriteBytes: 0`.

| effort | refine | implement | verify | fix | review | synthesis | record |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `cheap` | low | low | low | low | low | low | low |
| `standard` | medium | medium | low | medium | medium | medium | low |
| `deep` | high | high | medium | high | high | high | low |

A lens `tier` outranks the effort column (`light`→low, `standard`→medium,
`heavy`→high); an exact `provider/model` pin outranks both.
`workflowBudgetFor(shares)` is the `meta.budget` a graph of those shares needs;
the scheduler admits a task only while `settled + reserved + candidate ≤
meta.budget`.

## The shared `Finding`

One shape for every reviewer in every workflow.

| Field | Values |
| --- | --- |
| `id` | `^[a-z0-9][a-z0-9-]{0,63}$` |
| `severity` | `blocking` \| `major` \| `minor` |
| `kind` | `gap` \| `graph` \| `budget` \| `risk` \| `ambiguity` |
| `where` | RFC 6901 pointer into the reviewed document (≤512) |
| `what` | ≤2048, actionable in one reading |
| `patch?` | RFC 6902-shaped `{op: add\|replace\|remove, path, value?}` |

Merging is a **deterministic rail**, never a model call: two findings are the
same when `kind`, `where` and the normalized `what` agree; the survivor is the
most severe, ties to the lower declaration ordinal; output order is severity,
ordinal, id, `where`; duplicate ids take `-2`, `-3` in output order. A blocking
finding forces `request-changes` even from a lens that approved.

## The compiled stage document

What `plan-to-ship` compiles a plan into and `plan-review` reads —
`CompiledStageDocumentSchema`, exported from the same entry point. It is the
**graph, not prose**, and it is closed (`additionalProperties: false`). A plan
never authors it: the compiler derives each deliverable's stages from the
deliverable's `reviews` list and the plan's `policy`.

```jsonc
{ "deliverables": [ { "id": "<plan deliverable id>", "stages": [ /* below */ ] } ],
  "effort": "cheap" | "standard" | "deep",
  "gates":  "ship" | "every-deliverable" }
```

| `use` | Fields |
| --- | --- |
| `implement` | `id`, `tools?` |
| `verify-and-fix` | `id`, `maxRounds` (0–3 **verify** rounds = plan fix rounds + 1), `escalate?` |
| `review-fan-out` | `id`, `lenses` (≤16 of `{id, tier?, diverse?, skill?, model?}`), `synthesis?` |
| `gate` | `id`, `question`, `show?` |

`dynamic` and `sub-workflow` cannot appear: the plan has no stage vocabulary to
name them with, and the second does not exist. Nor does a `gate`, in practice:
`gates` alone says where a person is asked, so `plan-to-ship` derives
`implement`, `verify-and-fix` and — only when the deliverable's `reviews` list
is non-empty — `review-fan-out`, and nothing else.

## Builtin workflows assembled from the library

| Ref | In | Out |
| --- | --- | --- |
| `deep-review` | `{subject, lenses?, effort, synthesis?, maxFindings?}` | `{verdict, findings, coverage, synthesis?}` |
| `plan-review` | `{plan, planDigest, intent, compiled, projection, effort}` | `{verdict: ready\|gaps\|blocked, findings (≤32), notes?}` |

`plan-review` is the one definition a service consumer may start headlessly, so
it declares **no checkpoint, no worktree and no handoff** — the property
`headlessBuiltinViolations` checks, since `workflow_validate` cannot.
