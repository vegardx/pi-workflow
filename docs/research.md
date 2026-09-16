# Implementation research

The design is informed by source inspection of existing MIT implementations.
Concept adoption does not imply compatibility or source copying. Pinned source
identities are recorded in the [research source ledger](research-sources.md).

## Primary references

### `pi-workflow-engine`

Primary workflow implementation reference:

- trusted TypeScript definitions;
- strict terminating structured output;
- shared run semaphore and limits;
- structured progress events;
- required finalizers;
- fail-closed worktrees with patch capture;
- behavior/environment-bound replay;
- bounded and redacted run records;
- `getAgentDir()` workflow discovery.

### `@agwab/pi-workflow`

Adopt as concepts:

- scheduler separate from subagent execution;
- order edges distinct from data edges;
- durable run/task ownership;
- explicit artifacts and dependency reads;
- transactional dependency invalidation;
- conservative supervisor recovery.

### `pi-dynamic-workflows`

Adopt as concepts:

- executable capability contract used for docs and tests;
- journaled human checkpoints;
- run navigation and lifecycle controls;
- reusable verify, judge, retry, and gate patterns.

Reject silent worktree fallback, positional-only replay, model ranking by name or
price, and an independent basic web implementation.

### `pi-subagents`

Adopt stable keyed children, acknowledged steering receipts, bounded
worker-thread dynamic orchestration, and explicit observation of all child
launches.

### `pi-baton`

Use its narrow implement/review/fix transition shape as a possible compiler into
the general workflow API, not as a second runtime.

## Source adaptation

Before copying a substantial implementation:

1. record repository, commit, file, and license;
2. decide concept reimplementation versus source adaptation;
3. retain MIT notices for copied or substantial portions;
4. port relevant tests before changing behavior;
5. document intentional divergence.

## Replay cost of a bounded loop (2026-09-16)

Measured for W0-MEASURE, the gate on whether a generic `loopUntil` — unbounded
rounds, each adding barriers — can be a component, and on where
`verifyAndFix`'s round cap belongs. `test/replay-cost.test.ts` holds the
harness; the heavy configurations run under `RUN_REPLAY_COST=1` and CI runs the
small one.

### What was measured

`docs/contracts.md` states exact-prefix replay: **every** drive re-executes the
definition's `run` from entry and every already-crossed barrier re-awaits
against the journal. So a run's resume cost is a function of the barriers and
journal records it has already accumulated, and a loop that adds barriers
without bound adds that cost to every later drive — after a crash, after a
checkpoint decision, and after any operator re-drive.

The synthetic graph is the compiled shape of `plan-to-ship`: an `approve-plan`
gate at the root, then per deliverable `implement` → *R* verify/fix rounds →
*L* review lenses settled together → synthesis, then a `ship` gate. Every round
is taken, so the graph is the worst case `verifyAndFix` admits budget for.
Barriers are `2 + D·(3 + 2R) + 1`; tasks are `2 + D·(2 + 2R + L)`.

Real `WorkflowRunJournal` (fsync per append) and `WorkflowArtifactStore`, the
fake-scheduler harness the runtime tests use, and only the subagent faked — an
agent's own latency is the one cost a round cap cannot change. A crash is a
copy of the store whose journal is truncated to a complete-record prefix ending
at a task completion; the resuming lease fences the crashed writer, the journal
is opened cold (no warm reduction or parse cache), and the drive replays.

`performance.now()`, medians over the sample count each row reports. Apple
M5 Max, APFS, Node 24.16, pi-workflow at revision 18. Other agents' suites ran
on the same machine, so absolute wall times carry perhaps ±40 % of run-to-run
spread; the *shape* of the growth reproduced across every run.

### (a) Counts at completion, and the 4 × 2 × 3 graph

`D=4, R=2, L=3` completes with **38 tasks, 31 barriers, 595 journal events,
392 KiB of journal and a 185 KiB projection** (the runtime bounds a projection
at 900 KiB). That is ~15.8 journal records per task.

| Drive | n | median ms | cold journal open ms | appends | append ms | runtime `readState` | `readState` ms | scheduler drives |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| from scratch | 3 | 7479 | — | 595 | 6607 | 159 | 245 | — |
| resume @ 25 % | 2 | 6278 | 176 | 441 | 5369 | 138 | 239 | 28 |
| resume @ 50 % | 2 | 5059 | 571 | 299 | 4144 | 120 | 204 | 19 |
| resume @ 75 % | 2 | 3738 | 1357 | 141 | 2158 | 100 | 112 | 9 |
| resume @ 100 % | 3 | 2483 | 2237 | 5 | 66 | 81 | 88 | 0 |

"100 %" is a crash after the last task completed and before the run closed: no
work remains, so the 2 483 ms is **pure replay** and the 2 237 ms cold open is
paid on top. A resume is never more expensive than the drive that produced the
journal, and gets cheaper the later the crash — replay never overtakes
execution.

The from-scratch drive is fsync-bound: 6 607 of 7 479 ms (88 %) is durable
appends. The marginal cost of one more loop round *going forward* is therefore
**linear** — about 16 appends. The quadratic cost appears only on replay.

### (c) The same graph at D = 8

`D=8, R=2, L=3`: **74 tasks, 59 barriers, 1 163 events, 769 KiB journal,
364 KiB projection**.

| Drive | n | median ms | cold journal open ms | appends | append ms | runtime `readState` | `readState` ms | scheduler drives |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| from scratch | 1 | 19 425 | — | 1 163 | 17 339 | 299 | 519 | — |
| resume @ 50 % | 1 | 14 737 | 2 058 | 583 | 11 432 | 224 | 441 | 37 |
| resume @ 100 % | 1 | 8 435 | 8 053 | 5 | 98 | 149 | 116 | 0 |

Doubling the deliverables doubles the work (2.6× the from-scratch drive) but
**quadruples pure replay**: 2 483 ms → 8 435 ms, and the cold open 2 237 ms →
8 053 ms. A full crash resume of the 8-deliverable graph costs 16.5 s of
runtime overhead before a single agent runs again.

### (d) How the cost scales with barriers

Pure replay, crash after the last task completed:

| Shape | barriers B | events E | journal KiB | projection KiB | cold open ms | replay ms | ms / barrier | µs / (B × E) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D1-R2-L3 | 10 | 169 | 109 | 51 | 206 | 279 | 27.9 | 164.9 |
| D2-R2-L3 | 17 | 311 | 203 | 96 | 603 | 725 | 42.6 | 137.1 |
| D4-R2-L3 | 31 | 595 | 392 | 185 | 2 122 | 2 337 | 75.4 | 126.7 |
| D8-R2-L3 | 59 | 1 163 | 769 | 364 | 7 954 | 8 377 | 142.0 | 122.1 |

- Linear fit: `ms = -2034 + 169.7·B`, **R² = 0.968**, and the intercept is
  negative — the line cannot be the law.
- Quadratic fit: `ms = 41.0 - 0.44·B + 2.402·B²`, **R² = 1.0000**. The
  quadratic term is 99.8 % of the measured replay at B = 59.

Because B and E move together here, the honest normalised law is
**replay ≈ 122 µs × B × E** (the last column converges), and the cold open is
separately **≈ 5.9 µs × E²**. Both predict the D = 8 point to within 1 %
(8.37 s and 7.98 s against 8.38 s and 7.95 s measured).

### Why it is quadratic

Two places, both O(state) work repeated O(B) or O(E) times. Neither was
changed here.

1. **`src/reducer.ts:3098` `assertValidState`** runs
   `Value.Check(WorkflowStateProjectionSchema, state)` *and*
   `JSON.stringify(state)` over the whole projection after **every** event, so a
   cold reduction of E events is Θ(E²). Measured: 206 ms at 169 events →
   7 954 ms at 1 163 events — 6.9× the events for 38.7× the time (exponent
   1.87). At D = 8 this is 8.0 s of a 16.5 s resume, 49 % of the total.
   Validating the delta the event touched, and tracking the serialised size
   incrementally, would make the cold open linear.
2. **`src/materializer.ts:1171`** (`closeEpoch`'s replay branch) does
   `structuredClone(this.projectedState)` per barrier, so replaying B barriers
   clones the projection B times: Θ(B × state). At D = 8 that is 59 clones of a
   364 KiB projection, ≈ 21 MB, and it accounts for essentially all of the
   8 435 ms drive — journal reads are 116 ms and appends 98 ms, 2.5 % together.

The journal's own optimisations are *not* a hot spot. `readState` re-reads the
whole file every time (149 reads × 769 KiB ≈ 112 MB at D = 8), but the
byte-prefix parse cache and the resume-from-last-reduction keep the total to
116 ms — 1.4 % of the drive. They are what stops replay from being cubic.

### What this means for `loopUntil` and for `verifyAndFix`

Projecting the two laws over `maxFixRounds` on the 4-deliverable plan (each
extra round adds 2 barriers and 2 tasks per deliverable, ≈ 8 barriers and
126 journal records overall):

| maxFixRounds | tasks | barriers | events | projection KiB | replay ms | cold open ms | resume total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 22 | 15 | 343 | ~108 | 630 | 690 | **1.3 s** |
| 1 | 30 | 23 | 469 | ~147 | 1 320 | 1 300 | **2.6 s** |
| 2 (today's cap) | 38 | 31 | 595 | 185 | 2 340 | 2 090 | **4.4 s** (measured 4.5 s) |
| 3 | 46 | 39 | 721 | ~225 | 3 430 | 3 070 | **6.5 s** |
| 4 | 54 | 47 | 847 | ~264 | 4 860 | 4 230 | **9.1 s** |
| 6 | 70 | 63 | 1 099 | ~343 | 8 450 | 7 130 | **15.6 s** |
| 10 | 102 | 95 | 1 603 | ~500 | 18 600 | 15 200 | **33.8 s** |
| 20 | 182 | 175 | 2 863 | ~892 | 61 100 | 48 400 | **110 s** |

The last row is where the runtime stops the run by itself: a projection of
~4.9 KiB per task meets `MAX_WORKFLOW_STATE_BYTES` (900 KiB) at about 180
tasks, well before `MAX_MATERIALIZED_TASKS` (256) and nowhere near
`MAX_MATERIALIZATION_EPOCHS` (4 096). **An unbounded loop does not run
forever; it fails materialization after roughly 180 tasks, having made every
intervening drive quadratically slower.**

**`loopUntil` as specified — unbounded rounds — is not affordable, and should
stay deferred.** Not because a single resume is slow (16.5 s of overhead
against a run whose agents cost minutes each is noise) but because:

- the cost is paid on *every* drive, and a `plan-to-ship` run drives at least
  three times (`approve-plan`, `ship`, and any crash or operator re-drive), so
  an unbounded loop multiplies a quadratic term by the number of parks;
- the growth is quadratic in a quantity the author cannot see, while the
  forward cost the author *does* see is linear — the feedback is misleading;
- the terminal failure mode is a materialization refusal at ~180 tasks, which
  is a bad error for a loop whose author believed it was unbounded;
- a budget projected at compile time (`project()`, §2.4) cannot bound an
  unbounded loop, so the "refuse at compile time rather than block admission
  mid-run" property is lost.

If `loopUntil` is ever built, it must take a **mandatory, `ctx.input`-derived
round bound**, which makes it exactly `verifyAndFix` generalised — so the
measurement argues for generalising the existing bounded loop rather than for a
new unbounded primitive.

**`verifyAndFix` should keep `maxFixRounds: 0 | 1 | 2`.** At the cap, a
4-deliverable plan's worst-case resume is 4.4 s — under 0.2 % of any realistic
run — and the graph sits at 21 % of the projection bound. **3 is the highest
cap that is still comfortable** (6.5 s, 25 % of the bound); past 4 the resume
cost doubles every two rounds while the marginal value of another fix round
falls, and at 6 a single deliverable-heavy plan already spends a third of the
projection bound on fix rounds nobody reviewed. There is no measurement-driven
reason to raise the cap above 2 today; the spec's default of 0 at `cheap`,
1 at `standard` and 2 at `deep` is on the right side of every curve.

### Unresolved (spec §7 Q1)

Whether AgwaB's `compiled.json` binds to the spec digest on resume is still
unverified — no source was inspected for this measurement. Until it is, the
comparison to record is our own: exact-prefix replay re-derives the graph from
the definition on every drive and refuses a journal whose definition or input
identity changed, which is a stated correctness property, and the numbers above
are what it costs.
