---
name: workflow-components
description: Reference tables for @vegardx/pi-workflow/components — what each component lowers to, its key rule, its refusals, the stage envelope, the shared Finding, and the compiled stage document. Use when reading or reviewing a compiled workflow graph; preloaded by a reviewer that is shown one.
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
3. **Limit and budget** choices are table lookups keyed by the stage, and a
   **model** is either an exact one a definition pinned or the literal
   `"inherit"`, which the runtime resolved once at run start. Never a clock, an
   environment variable, or a measurement.

A graph that breaks one of these is a replay bug, not a style problem.

## Components

| Component | Lowers to | Key rule | Refuses at declaration |
| --- | --- | --- | --- |
| `gate(ctx, key, {question, show?, schema, headless?, timeoutMs, default?})` | `ctx.checkpoint` | key literal; `show` → `inputs` | a schema that is not a flat object of 1–8 leaves — no gate silently degrades to a raw JSON editor; a `question` that is not a question |
| `envelope(stage)` | `meta.budget` + per-task `limits`/`thinking` | pure table keyed by `stage` alone | an unknown stage name |
| `forEach(ctx, ns, items, {idOf, task, disposition?})` | `ctx.fanOut` | `key(item) = idOf(item)` | >64 items; a duplicate id; an `idOf` reading an optional field; a budget over-projection |
| `reviewFanOut(ctx, ns, lenses, {subject, synthesis, diversity})` | `ctx.fanOut` (`optional`) + `ctx.settled` + optional `ctx.fanIn` | `key = lens.id`; duplicates take `-2`, `-3` **by declaration ordinal** | >16 lenses |
| `verifyHandoff(ctx, key, {handoff, check, model, request})` | one `ctx.agent` at the hand-off (`startAtInput`), no barrier | key literal; a second check takes a second key | a blank `check.command`; a subject that is not a worktree handle; a bad `model`; a request naming `outputSchema`, `model`, `limits`, the `patch` input, or another workspace start; a budget the run cannot admit |
| `reviewLenses(ctx, ns, lenses, {subject, review, model?})` | `ctx.fanOut` (`optional`, read-only at the subject's one hand-off) + `ctx.settled` | `key = lens.id`, `-2`, `-3` by ordinal | >16 lenses; a lens with no exact model; a subject without exactly one hand-off; a lens that is not read-only |

A verifier verifies and never fixes; `checkRan: false` is unverified, never
green, and nothing to fix. The agent that wrote the change answers the report
in its own session (an agent task with `continueFrom`), and a second
`verifyHandoff` checks what it handed back.

The review record is pure functions over barrier values, and the harness that
runs them **merges without judging**:

| Function | Does |
| --- | --- |
| `clusterFindings(reviewers)` | one lens's findings at one place (same file, lines within ±2 of the first, or both file-level) become one cluster `c1..cn`, in location order |
| `normalizeCandidates(reviewers, clusters)` | what a merge-only model is offered, or `undefined` with fewer than two reporting lenses or one lens's clusters only |
| `applyModelMerges(clusters, reviewers, answer)` | applies `{merges: [[id, id, …]]}` or refuses it whole: an unknown or repeated id, a group of one, any other field |
| `implementerView(clusters, reviewers)` | `{items: [{id, claim, location, evidence}]}` by file then line — no severity, lens, model, agreement or suggestion |
| `checkResumeReport(view, report)` | every shown id exactly once, in a `resumeReportSchema` answer |
| `reviewerEntries`, `withDispositions`, `reviewCounts` | the `ReviewsRecordSchema` record's rows, its dispositions, and the counts a gate states |

| Field | Values |
| --- | --- |
| `LensReportSchema.findings[]` | `{claim (≤1024), location: {file (≤512), line?}, evidence (≤4096), severity: high\|medium\|low, suggestion? (≤2048)}`, ≤64 |
| `ReviewsRecordSchema` | `{deliverable, handoffCommit, reviewers: [{reviewerKey, lens, model, thinking?, alias?, tier?, family?, attemptId?, status, findings}], clusters: [{id, claim, location, severity, reportedBy, agreement: {count, of}, suggestions, raw, disposition?}], normalizer: {mode, model?, alias?, tier?, family?, promptDigest?}}` |
| a disposition | `{kind: fixed\|declined\|out-of-scope, reasoning (≤2048)}` |

Deferred, on purpose: `sequence` (`ctx.pipeline` is one line), `branch`,
`retrying`, `loopUntil`, `mapReduce`, `dynamicStage`, `subWorkflow`.

## The stage envelope

**There is no effort dial.** `envelope(stage)` → `{stage, thinking, limits,
budgetShare}`, one fixed row per stage — the numbers the removed dial's
`standard` column measured. Stages: `refine`, `implement`, `verify`, `fix`,
`review`, `synthesis`, `record`. `implement` and `fix` write in a worktree; every
other stage is read-only with `workspaceWriteBytes: 0`.

| refine | implement | verify | fix | review | synthesis | record |
| --- | --- | --- | --- | --- | --- | --- |
| medium | medium | low | medium | medium | medium | low |

The table names no model. A model is set PER ROLE: an exact
`{provider, id, thinking}`, `"inherit"` — the host session's own model and
thinking level, which pi-workflow resolves once at run start and records on the
run — or `modelRole: { persona, tier, family? }`, which the host's router
resolves (tiers `fast | light | normal | frontier`; an authored review names
`light` or `normal`, and `reviewTierRefusal` names why the other two are
refused). There is no tier-to-thinking table: the router decides the thinking
level. The `thinking` column applies only to an exact pin that carries none of
its own, such as a plan's `provider/model` lens pin. `GATE_TIMEOUT_MS` is one number, 24 hours, and
`WORKTREE_MEMORY_BYTES` is 2 GiB for every worktree stage.
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

What `plan-to-ship` compiles a plan into, and what a reader checks a plan against —
`CompiledStageDocumentSchema`, exported from the same entry point. It is the
**graph, not prose**, and it is closed (`additionalProperties: false`). A plan
never authors it: the compiler derives each deliverable's stages from the
deliverable's `reviews` list and the plan's `policy`.

```jsonc
{ "deliverables": [ { "id": "<plan deliverable id>", "stages": [ /* below */ ] } ],
  "gates":  "ship" | "every-deliverable" | "none" }
```

| `use` | Fields |
| --- | --- |
| `implement` | `id`, `tools?` |
| `check` | `id` — `check`, or `recheck` for the check after a resume |
| `review-fan-out` | `id`, `lenses` (≤16 of `{id, tier?, diverse?, skill?, model?}`) |
| `normalize` | `id` — the harness's clustering and the merge-only model call |
| `resume` | `id` — the implementer answering the check and the review |
| `adjudicate` | `id` — a judge ruling on what the implementer contested |
| `gate` | `id`, `question`, `show?` |

`dynamic` and `sub-workflow` cannot appear: the plan has no stage vocabulary to
name them with, and the second does not exist. Nor does a `gate`, in practice:
`gates` alone says where a person is asked, so `plan-to-ship` derives
`implement` and `check`, then — only when the deliverable's `reviews` list is
non-empty — `review-fan-out` and `normalize`, then — under `policy.resumes: 1`
— `resume` and the `recheck` `check`, then — with both — `adjudicate`, and
nothing else.

## Builtin workflows assembled from the library

| Ref | In | Out |
| --- | --- | --- |
| `deep-review` | `{subject, lenses?, synthesis?, maxFindings?}` | `{verdict, findings, coverage, synthesis?}` |

`deep-review` declares **no checkpoint, no worktree and no handoff** — the
structural property `headlessBuiltinViolations` reports on, since
`workflow_validate` cannot. That makes it a graph nobody has to be asked about;
it does not make it startable without a model turn, which only
`BUILTIN_STARTABLE_WORKFLOWS` decides.
