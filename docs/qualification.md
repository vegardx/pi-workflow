# 1.0.0 qualification

Status: **not yet performed.** This note is the checklist the owner runs on
macOS arm64 before tagging `v1.0.0`. Every item under "Exercised by hand" is
unchecked until it has been run; an unchecked item is not a claim. The
per-feature reports under [`docs/qualification/`](qualification/) record the
earlier host runs (revisions 1 through 7) and are not repeated here.

## Environment

Fill in at qualification time. The pi-subagent commit must be the one that
actually ran; the earlier reports record `55e84bd731e2017510ee85b2df898e7f2d3679f2`,
while CI pins `e42cd28f2f970872a1a460079efc1a992c0bd7c9` (pi-subagent 0.11.0,
contract revision 7).

| Component | Value |
| --- | --- |
| Host | macOS arm64 (Darwin 25.6.0) |
| Node.js | 24.16.0 |
| Pi (`@earendil-works/pi-coding-agent`) | 0.85.0 |
| pi-subagent | 0.11.0 @ `<commit>` |
| pi-workflow | 1.0.0 @ `<commit>` |
| Tarball | `<npm pack filename>` sha256 `<sha256>` |
| Model | `<provider/model>` |
| Date | `<YYYY-MM-DD>` |

## Exercised by hand (macOS arm64)

Setup: `npm pack` the checkout, install the tarball together with the
pi-subagent tarball into a fresh `PI_CODING_AGENT_DIR`, register the
extension, and open a trusted project with a `workflows/` root. Record the
command run and the observed result next to each item when it is checked.

- [ ] **Extension load.** Start Pi; the extension loads from
      `@vegardx/pi-workflow/extension` (`pi.extensions` points at
      `./dist/extension.js`) without warnings from this package.
- [ ] **`/workflow` grammar.** Type `/workflow ` and confirm the completions
      offer the sixteen subcommands `list`, `runs`, `validate`, `run`,
      `approve`, `reject`, `show`, `status`, `logs`, `wait`, `stop`,
      `reconcile`, `invalidate`, `retry`, `resume`, `decide`; `/workflow help`
      is refused with "Unknown workflow command: help. Expected one of …"
      naming the same sixteen; `/workflow list` prints the trusted
      definitions.
- [ ] **Widget.** With one run ongoing, the two-line `pi-workflow` widget
      appears below the editor (`workflows ongoing: …`); it is hidden once
      no run is ongoing or needs action.
- [ ] **Inspector.** `alt+w` opens the inspector without interrupting input;
      `enter` drills into a run and its task details; `?` shows the help
      screen; `escape` closes it.
- [ ] **Static run through a Gondolin child.** On a read-only single-agent
      workflow (the phase-1 scenario), a model in the session calls
      `workflow_list`, `workflow_validate`, `workflow_run`, `workflow_wait`;
      then `workflow_status`, `workflow_runs`, `workflow_inspect`, and
      `workflow_logs` read the completed run. The child ran in a pi-subagent
      Gondolin VM, the output artifact was imported, the child was released,
      and no QEMU process remained. Record the run id and output.
- [ ] **Checkpoint decide.** A workflow with a `headless: "block"` checkpoint
      that declares `inputs` parks: `workflow_wait` returns the `waiting` view
      at once with `parked: true` and one entry in `pendingCheckpoints`
      carrying `taskKey`, `prompt`, `schemaSummary`, `inputsSummary`, and
      `instruction`, and `availableActions` lists `decide`. Pi prompts in the
      session within a moment, showing the prompt, the run, the expiry, the
      declared inputs, and the answer shape, and asks the decision field by
      field; the widget's first line reads `waiting for you: <prompt>`.
      Dismissing a dialog (escape) records nothing: the run stays parked, the
      widget line and `/workflow decide` still offer it, and the same
      execution is not asked again. Answering and confirming records one
      decision with `decidedBy: "pi-session"`, the task completes with
      "Checkpoint decided.", and the run completes. On a second parked run,
      `/workflow decide <run> <task>` without JSON opens the same form, the
      inspector's "Decide a checkpoint" entry opens it too, and `/workflow
      decide <run> <task> <json>` still asks for the fixed confirmation and
      records the decision.
- [ ] **Propose / approve / reject / run.** `workflow_propose { source }`
      returns `dynamic:<sha256>` with `runnable: false`; `workflow_run` on
      that reference is refused with "Dynamic workflow source is not approved
      for the current host API."; `/workflow approve dynamic:<sha256>` renders
      the proposal, confirms, and writes the approval; `workflow_run
      dynamic:<sha256>` then completes and the run view shows
      `definitionKind: "dynamic"`. `/workflow reject dynamic:<sha256>` on a
      second proposal is final: `workflow_run` on it is refused with "Dynamic
      workflow source was rejected."
- [ ] **Stop / reconcile / retry.** `/workflow stop <run>` on a running run
      confirms, persists stop intent, drains the child, and ends the run
      `cancelled`. `/workflow reconcile <run>` on a completed or cancelled run
      returns its reconcile view without changing state. `/workflow retry
      <run> <task-key>` on a task that failed under an unsatisfiable output
      schema is offered only while `availableActions` lists `retry`,
      confirms, and re-executes the task as a new generation.
- [ ] **Both entries from the packed tarball.** From the install directory:
      `node --input-type=module -e 'const w = await import("@vegardx/pi-workflow"); const r = await import("@vegardx/pi-workflow/runtime"); const m = await import("@vegardx/pi-workflow/package.json", { with: { type: "json" } }); console.log(Object.keys(w).length, Object.keys(r).length, m.default.version)'`
      prints the root and runtime export counts matching
      `test/fixtures/public-api/root-exports.json` and
      `runtime-exports.json` and `1.0.0`; `import("@vegardx/pi-workflow/dist/index.js")`
      rejects with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Paste the output. (This
      is the pack-check smoke run by hand; `npm run pack:check` asserts the
      same against the same tarball.)

## Exercised on CI (Linux x64, `ubuntu-latest`, Node.js 24.16.0)

Per `.github/workflows/ci.yml`, against pi-subagent
`e42cd28f2f970872a1a460079efc1a992c0bd7c9` built from source:

- `npx biome check .`, `npx tsc --noEmit` (including the type-shape fixture
  `test/public-api.types.ts`), `npm run build`, `npm run pack:check` (packed
  file list, both entry points and `./package.json` loading from the
  installed tarball, export lists equal to the fixtures, disjointness, deep
  `dist/` paths rejected, the packed pi-subagent contract check, the dynamic
  manifest smoke), and `npm audit --audit-level=low`;
- `npx vitest run` in four shards with fake subagent clients (64 files and
  1444 tests at the base commit, plus the public-API suite), on a tmpfs
  `.pi/`.

CI has no real Pi session, model, or Gondolin VM.

## Unit-tested only (no host run for 1.0.0)

Covered by the vitest suites and the packed-contract check, never by a
by-hand run on any host:

- worktree agent tasks and handoff import (owner decision for 1.0.0: no
  worktree task has run against a packed pi-subagent on any host; the freeze
  changes API shape, not this behaviour);
- support tasks, nested workflows and artifact inputs into children, retry
  and resume attempts, execution generations, invalidation and
  re-execution, required and advisory finalizers, interrupted-child
  retention and operator `resume`;
- checkpoint expiry policies (`headless: "block"` failing at stage
  `checkpoint-expired`, `headless: "use-explicit-default"` recording its
  default, `createWorkflowService({ checkpoints: { headless: true } })`);
- dynamic VM memory-limit, watchdog, and abort paths, RPC bounds, and
  fresh-VM recovery;
- the revision-19 guest memory grant: an agent task `memoryBytes` reaching a
  real Gondolin VM, a real pi-subagent refusal of an over-ceiling request, and
  a real `workspace-budget` refusal from an exhausted `workspaceWriteBytes`.
  All three are covered by unit tests and the packed-contract check against
  pi-subagent 0.11.0 only; no host run has exercised them;
- lease contention and fencing, journal corruption, and restart recovery.

## Not exercised

- Linux with a real Pi session, model, or Gondolin VM (CI is build and
  fake-client evidence only);
- any platform other than macOS arm64 and Linux x64;
- a nested run in an interactive session;
- a checkpoint inside a nested child run (see below).

## Known defects and follow-ups

- **A checkpoint in a nested child run cannot be decided.**
  `WorkflowService.decide` refuses a nested run ("Nested workflow runs are
  decided through their parent run."), the `decide` action is never offered
  for one, and no path decides a nested child's checkpoint through the parent
  yet (`docs/contracts.md`, "Parking"). A `headless: "block"` checkpoint in a
  child therefore parks until its `timeoutMs` expires (the child fails at
  stage `checkpoint-expired`) or the parent is stopped (the child's checkpoint
  is cancelled with "Workflow run ended before the checkpoint was decided.");
  a `use-explicit-default` checkpoint continues on its default. Authors
  should put checkpoints in the root workflow. Tracked as post-1.0 work in
  `docs/roadmap.md`; adding a decision path is additive.
- **The support-execution deadline test is load-sensitive.**
  `test/support-execution.test.ts` "aborts an in-flight support task when the
  workflow deadline expires" uses a real 1 s `timeoutMs`; under full-suite
  contention on one runner real-clock expiries were observed late
  (`.github/workflows/ci.yml`, run 35099072360), which is why CI shards the
  suite. Sharding is a mitigation, not a fix; the test is not skipped.

## Result

`<Pending: filled in by the owner after every item above is checked. State
the tarball, the commits, and whether 1.0.0 is qualified on macOS arm64 for
the exercised list; anything unchecked stays listed as not exercised.>`
