---
name: plan-schema
description: Reference tables for the pi-maestro plan document — deliverables, work tasks, the reviews list, policy dials, the stage list the compiler derives, and the validation rules a stored plan already passed. Use when reading, reviewing, or patching a plan; preloaded by a reviewer that is shown one.
---

# The pi-maestro plan document

A **reference**, not a tutorial: tables only. A plan is *what was authored* —
never run state, and never a graph. The document is written by pi-maestro's
plan-mode exit and handed to `plan-to-ship` by value. It is stored at
`schemaVersion: 5`; `reviews` and `policy` are optional, and a document with
neither is valid and gets the defaults below.

**Version 5** says a task is **work only** and moves review routing to
`deliverables[].reviews`; it also deletes authored stages — the compiler derives
the stage list from `reviews` and `policy`, and a plan never writes one. There
is **no migration** from v3 or v4. Each deleted key parses and is then refused
**by name** at compile, one sentence each:

| key | refused because |
| --- | --- |
| `tasks[].review` | v4's review block: *plan schema v5 moved review routing to `deliverables[].reviews`; a task is work only* |
| `tasks[].by` | v3's name for the same block, same destination |
| `deliverables[].stages` | *plan schema v5 does not author stages; the compiler derives them from `reviews` and `policy`* |

`plan-to-ship` refuses such a plan before its first task is declared, so the
refusal costs nothing — and `workflow_validate` still answers `valid: true`,
because a schema error about an unexpected property is not something a person
can act on.

pi-workflow does not own this schema. It mirrors what it needs
(`workflows/plan-to-ship.workflow.ts`) and
admits the rest, so a plan may carry fields not listed here.

## Plan

| Field | Type | Notes |
| --- | --- | --- |
| `slug` | string | `^[a-z0-9][a-z0-9-]{0,63}$`; names the run and the branch |
| `title` | string | non-empty |
| `body` | string? | prose for the whole plan |
| `repos` | `{key, path}[]` | ≥1; `key` matches the id pattern; `path` must be an existing Git working-tree **root** |
| `deliverables` | `Deliverable[]` | ≥1 |
| `policy` | `PlanPolicy?` | the dials, on the document so the digest covers them |

## Deliverable

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | id pattern, unique in the plan, becomes a workflow namespace |
| `title` | string | non-empty |
| `body` | string? | prose for the implementer |
| `after` | string[] | **ordering only**; ids must exist; no self-edge; no cycles |
| `reads` | string[] | ⊆ `after`; reading is not the same as waiting |
| `repo` | string? | a `repos[].key`; absent = the plan's first |
| `tasks` | `Task[]` | ≥1 — "a deliverable is work, or it is nothing" |
| `reviews` | `Review[]?` | 0–16 lenses; absent == `[]` == no review stage |

## Task

**Work only.** A task has no `review`, no `by`, and no kind field: what a task
says is what someone writes.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | id pattern, unique within the deliverable |
| `title` | string | non-empty |
| `body` | string? | |

## Review

One entry per point of view the deliverable's handoff is reviewed through. The
list is the whole review story: **absent or empty means no review stage is
compiled at all**, and duplicate `lens` ids get `-2`, `-3` by declaration
ordinal, which is what the fan-out keys become.

| Field | Required | Values |
| --- | --- | --- |
| `lens` | **required** | the **lens id pattern** `^[a-z][a-z0-9-]{0,63}$` — never empty, never a leading digit or hyphen; it is the fan-out key |
| `tier` | optional | `light` \| `standard` \| `heavy` — **the one to reach for**; the host resolves the reviewer |
| `diverse` | optional | boolean: a reviewer from another model family |
| `skill` | optional | an ambient skill name, id pattern |
| `model` | optional | **only ever** a concrete `provider/model` — never a bare model name, a tier word, or a role. **Prefer `tier` and omit `model`:** a plan that pins one runs only where that model exists |

The lens id pattern is **not** the id pattern above: a lens id may not start
with a digit, because it reaches pi-workflow as a fan-out namespace.

## Policy

| Field | Values | Default |
| --- | --- | --- |
| `effort` | `cheap` \| `standard` \| `deep` | `standard` |
| `gates` | `ship` \| `every-deliverable` | `ship` |
| `reviewDefault` | `{tier?, diverse?}` | `{tier: "standard", diverse: false}` |
| `maxFixRounds` | 0 \| 1 \| 2 | 0 cheap / 1 standard / 2 deep |
| `publish` | `{mode: none\|branch\|pr, base?}` | `{mode: "none"}` |

`publish.base` must be a valid Git ref name. `mode: "pr"` needs `gh` at
**readiness** time, not at validation time. The host attaches `policy` from
what the person answered in its dialogs — the model never writes it, and a
blind plan review raises no finding against `/policy`.

## The compiled stage list — derived, never authored

Not part of the plan. This is what `plan-to-ship` produces from every
deliverable, in order, and what the compiled stage document shows:

1. `{use: "implement", id: "implement"}`
2. `{use: "verify-and-fix", id: "verify", maxRounds: <policy.maxFixRounds + 1>}`
   — the plan counts FIX rounds, a compiled document counts VERIFY rounds
3. `{use: "review-fan-out", id: "review", synthesis: "optional", lenses: […]}` —
   one lens per `reviews[]` entry, with `tier`/`diverse` falling back to
   `policy.reviewDefault`. **Omitted entirely when `reviews` is empty.**

Gates are *not* stages: a per-deliverable gate and `ship` come from
`policy.gates`, applied by the compiler, and a compiled deliverable never
carries a `gate`. There is no gate before the work and no "no gates" value: the
START of the run is the approval, and the `ship` decision is what a receipt is
checked against. `approve-plan` and `approve-plan+ship` were removed and are
refused by name at compile.

## What a stored plan has already passed

A plan reaching a reviewer went through `inspectPlan`, which reports **every**
error at once. It already holds that: ids are unique and well-formed; every
deliverable has ≥1 task; `after`/`reads` resolve, `reads ⊆ after`, and there are
no cycles; a `reads` edge **inside one repository is refused by name** (every
worktree branches from the same baseline, and a fan-out has no per-item
`after`); every repo path is an existing working-tree root; every `reviews[]`
entry satisfies the table above; policy values are in vocabulary.

A dirty working tree is a **warning**, not an error.

So: do not re-report a rule from this section. What is left to review is whether
the plan does what was asked, and whether the graph it compiled into is the
graph this plan describes.

## Patching a plan

A finding's `patch` is RFC 6902-shaped — `{op: "add" | "replace" | "remove",
path, value?}` — and `path`, like a finding's `where`, is an RFC 6901 pointer
into the plan document (`/deliverables/0/reviews/1/tier`). Accepting a
finding applies the patch to the stored plan and re-runs `inspectPlan`; it is
never a re-prompt, so a patch that needs a human to fill in a blank is not a
patch.
