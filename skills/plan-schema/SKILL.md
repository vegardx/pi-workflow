---
name: plan-schema
description: Reference tables for the pi-maestro plan document — deliverables, tasks, stage kinds, policy dials, the default stage list, and the validation rules a stored plan already passed. Use when reading, reviewing, or patching a plan; preloaded by the plan-review workflow.
---

# The pi-maestro plan document

A **reference**, not a tutorial: tables only. A plan is *what was authored* —
never run state. It is stored at `schemaVersion: 3`; `stages` and `policy` are
optional, and a document with neither is valid and gets the defaults below.

pi-workflow does not own this schema. It mirrors what it needs
(`workflows/plan-to-ship.workflow.ts`, `workflows/plan-review.workflow.ts`) and
admits the rest, so a plan may carry fields not listed here.

## Plan

| Field | Type | Notes |
| --- | --- | --- |
| `slug` | string | `^[a-z0-9][a-z0-9-]{0,63}$`; names the run and the branch |
| `title` | string | non-empty |
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
| `stages` | `Stage[]?` | absent = the default list below |

## Task

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | id pattern, unique within the deliverable |
| `title` | string | non-empty |
| `body` | string? | |
| `by` | `{lens, tier?, diverse?, skill?, model?}?` | present ⇒ this task is a **review**, and seeds a lens; absent ⇒ the deliverable's own worker does it. `by` marks a REVIEW task; an implementation task must not carry it — a deliverable whose every task carries `by` is one that nothing writes |

### `by`, field by field

| Field | Required | Values |
| --- | --- | --- |
| `lens` | **required** | the **lens id pattern** `^[a-z][a-z0-9-]{0,63}$` — never empty, never a leading digit or hyphen; it is the fan-out key |
| `tier` | optional | `light` \| `standard` \| `heavy` — **the one to reach for**; the host resolves the reviewer |
| `diverse` | optional | boolean: a reviewer from another model family |
| `skill` | optional | an ambient skill name, id pattern |
| `model` | optional | **only ever** a concrete `provider/model` — never a bare model name, a tier word, or a role. **Prefer `tier` and omit `model`:** a plan that pins one runs only where that model exists |

The lens id pattern is **not** the id pattern above: a lens id may not start
with a digit, because it reaches pi-workflow as a fan-out namespace.

## Stage kinds (`use`)

`use` names a **plan stage kind**, not a component: the plan's vocabulary and
the library that lowers it may diverge.

| `use` | Fields | Rules |
| --- | --- | --- |
| `implement` | `id`, `tools?` | exactly one per stage list; `tools` are tool **names**, never commands or paths |
| `verify-and-fix` | `id`, `maxRounds?` (0\|1\|2 **fix** rounds), `escalate?` (`thinking`\|`none`) | must come after `implement` |
| `review-fan-out` | `id`, `lenses` (1–16 of `{id, tier?, diverse?, skill?, model?}`), `synthesis?` (`required`\|`optional`\|`none`) | each `lenses[].id` is **required** and matches the lens id pattern `^[a-z][a-z0-9-]{0,63}$`; `tier`/`diverse`/`skill`/`model` are exactly the `by` fields above, `model` only ever `provider/model`; duplicate lens ids get `-2`, `-3` by declaration ordinal |
| `gate` | `id`, `question`, `show?` | **last** in its deliverable; `show` names sibling stages declared *earlier*; `question` may not contain a path or code |
| `dynamic` | `id`, `brief` | **reserved**: validation refuses it with "dynamic stages are not compiled yet" |

Every `id` matches the id pattern and is unique within its deliverable, because
it becomes a workflow namespace. There is no `sub-workflow` kind.

## Policy

| Field | Values | Default |
| --- | --- | --- |
| `effort` | `cheap` \| `standard` \| `deep` | `standard` |
| `gates` | `approve-plan` \| `approve-plan+ship` \| `every-deliverable` | `approve-plan+ship` |
| `reviewDefault` | `{tier?, diverse?}` | `{tier: "standard", diverse: false}` |
| `maxFixRounds` | 0 \| 1 \| 2 | 0 cheap / 1 standard / 2 deep |
| `publish` | `{mode: none\|branch\|pr, base?}` | `{mode: "none"}` |

`publish.base` must be a valid Git ref name. `mode: "pr"` needs `gh` at
**readiness** time, not at validation time.

## The default stage list

A deliverable with no `stages` compiles as if it declared, in order:

1. `{use: "implement", id: "implement"}`
2. `{use: "verify-and-fix", id: "verify", maxRounds: <policy.maxFixRounds>}`
3. `{use: "review-fan-out", id: "review", synthesis: "optional", lenses: […]}` —
   one lens per task carrying `by`, with `tier`/`diverse` from `by` falling back
   to `policy.reviewDefault`. **Omitted entirely when no task carries `by`.**

Gates are *not* in the default list: `approve-plan` and `ship` come from
`policy.gates`, applied by the compiler.

## What a stored plan has already passed

A plan reaching a reviewer went through `inspectPlan`, which reports **every**
error at once. It already holds that: ids are unique and well-formed; every
deliverable has ≥1 task; `after`/`reads` resolve, `reads ⊆ after`, and there are
no cycles; a `reads` edge **inside one repository is refused by name** (every
worktree branches from the same baseline, and a fan-out has no per-item
`after`); every repo path is an existing working-tree root; stage lists satisfy
the table above; policy values are in vocabulary.

A dirty working tree is a **warning**, not an error.

So: do not re-report a rule from this section. What is left to review is whether
the plan does what was asked, and whether the graph it compiled into is the
graph this plan describes.

## Patching a plan

A finding's `patch` is RFC 6902-shaped — `{op: "add" | "replace" | "remove",
path, value?}` — and `path`, like a finding's `where`, is an RFC 6901 pointer
into the plan document (`/deliverables/0/tasks/1/by/tier`). Accepting a finding
applies the patch to the stored plan and re-runs `inspectPlan`; it is never a
re-prompt, so a patch that needs a human to fill in a blank is not a patch.
