# pi-workflow

Custom workflow runtime for [Pi](https://pi.dev).

This repository contains the durable static execution core and Pi extension for
trusted read-only agent workflows, durable deterministic support-task
execution, and bounded nested static workflows executed as linked child runs.
Dynamic workflows, writer tasks, operator-triggered retry, and polished UI
remain unavailable.

## Goal

Provide one reusable workflow engine with:

- trusted TypeScript workflow authoring and a later bounded dynamic frontend;
- typed task/artifact handles that materialize a declarative durable graph;
- stable tasks, explicit order/data dependencies, parallelism, pipelines,
  bounded fan-out/fan-in, and bounded nested workflows;
- schema-validated agent results and deterministic support tasks;
- declared cost/runtime budgets, optional total-token guards, and durable
  wall-clock deadlines;
- append-only lifecycle state, leases, fencing, resume, retry, replay, and
  reconciliation;
- fail-closed persistence, required finalizers, and bounded UI;
- physical child execution delegated to the exact extension-owned
  `SubagentService`.

```text
TypeScript effects
      ↓
validated TaskSpec graph
      ↓
journal + scheduler + recovery
      ↓
shared pi-subagent service (agent tasks)
in-process support executor (support tasks)
linked child workflow run (nested workflow tasks)
```

Workflows without result-dependent branches can materialize their complete DAG
before execution. Data-dependent workflows materialize the same graph
incrementally across explicit result barriers.

`pi-workflow` owns orchestration. It does not spawn private child runtimes or
own publication, push, pull-request, merge, release, or deployment policy.

## Documentation

- [Glossary](docs/glossary.md)
- [Architecture](docs/architecture.md)
- [Contracts](docs/contracts.md)
- [Authority model](docs/authority.md)
- [Persistence and recovery](docs/persistence.md)
- [Failure taxonomy](docs/failures.md)
- [Threat model](docs/threat-model.md)
- [Acceptance inventory](docs/acceptance.md)
- [Implementation research](docs/research.md)
- [Research source ledger](docs/research-sources.md)
- [Roadmap](docs/roadmap.md)
- [macOS arm64 Phase 1 qualification](docs/qualification/macos-arm64-phase1.md)
- [macOS arm64 artifact pipeline qualification](docs/qualification/macos-arm64-artifact-pipeline.md)
- [macOS arm64 bounded parallel qualification](docs/qualification/macos-arm64-parallel.md)
- [macOS arm64 settled-result qualification](docs/qualification/macos-arm64-settled.md)
- [macOS arm64 bounded fan-out qualification](docs/qualification/macos-arm64-fan-out.md)
- [macOS arm64 bounded fan-in qualification](docs/qualification/macos-arm64-fan-in.md)
- [macOS arm64 pipeline builder qualification](docs/qualification/macos-arm64-pipeline.md)

## Dependency

[`pi-subagent`](https://github.com/vegardx/pi-subagent) owns every physical
agent run and attempt. Its extension registers a lazy provider on Pi's event bus.
Workflow acquires that exact service through the public typed provider export,
checks the exact runtime contract, and never constructs or shuts down a second
execution service.

## Pi tools

The packaged extension registers:

```text
workflow_list      workflow_validate  workflow_run
workflow_status    workflow_wait      workflow_stop
workflow_reconcile
```

`workflow_run` returns a durable run ID immediately. Use `workflow_wait` for the
bounded result or `workflow_stop` to persist stop intent, abort in-process
support work, and drain active child work.

## Support tasks

Trusted packages define typed descriptor helpers with `defineSupportTask` and
pass the matching `helper.registration(execute)` objects to
`createWorkflowService({ supportTasks })`. Workflows declare them with
`ctx.support(key, helper({ parameters, inputs }))`. The runtime resolves each
persisted descriptor against that constructor registry by exact implementation
identity, runs the implementation in the host process without a subagent,
model, VM, or worktree, and commits the output as a workflow-owned artifact.
The public entry points are `createWorkflowSupportTaskExecutor`,
`supportRegistrationIdentity`, `deriveSupportImplementationIdentitySha256`,
`SupportTaskExecutionRecordSchema`, and `SupportTaskTerminalEvidenceSchema`;
see [Contracts](docs/contracts.md#support-task-execution).

## Nested workflows

A workflow can run another discovered workflow as a linked child run:

```ts
export default defineWorkflow({
	meta: {
		name: "nest-parent",
		description: "Parent",
		version: 1,
		budget: { cost: 5, childRuntimeMs: 120_000 },
		timeoutMs: 600_000,
	},
	inputSchema: InputSchema,
	outputSchema: OutputSchema,
	run(ctx) {
		const task = ctx.agent("draft", {
			agent: "researcher",
			task: { goal: "Draft the document", context: [], instructions: [] },
			contextMode: "fresh",
			tools: ["read"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: ctx.cwd },
			limits: limits.readOnly,
			outputSchema: DocSchema,
		});
		return ctx.workflow("child", {
			workflow: "echo-child",
			input: { value: ctx.input.value },
			inputs: { doc: task.output },
		});
	},
});
```

The child is resolved by name from the same discovery pass and trust gate as
the parent. Its identity, source digest, schemas, budget, timeout, and
concurrency are captured at declaration together with the authored `input`
and any named artifact `inputs`, and the task is lowered into a
`kind: "workflow"` record. Artifact inputs follow the merged-input rule: each
producer becomes an order dependency, the authored `input` must be an object
without a key equal to an input name, and at launch every verified artifact
value is merged into it as a top-level key (`{ value, doc }` above), validated
against the child's input schema and the 900 KiB bound, and launched as the
child's plain `ctx.input`. Without artifact inputs the authored input is
validated at declaration. Execution launches a separate durable run with its
own journal, lease, artifact store, and subagent owner binding; the parent
reserves the child's declared budget, caps the child's deadline at its own,
records the injected artifact identities in the child's run record, and
imports the child's verified output as a parent-owned artifact before the task
completes. Depth is bounded at 0 through 3, a run may declare at most 64
workflow tasks, and recursion along the ancestor chain is rejected. The public
entry points are `createWorkflowNestedRunExecutor`,
`deriveNestedWorkflowRunId`, `NestedWorkflowTaskSpecSchema`,
`NestedWorkflowInputArtifactsSchema`, `NestedWorkflowTerminalEvidenceSchema`,
and `MAX_NESTED_WORKFLOW_DEPTH`; see
[Contracts](docs/contracts.md#nested-workflow-tasks).

## Retry and resume

An agent request may declare how many fresh pi-subagent attempts the runtime
may make on the same child run after a classified failure:

```ts
const draft = ctx.agent("draft", {
	agent: "researcher",
	task: { goal: "Draft the document", context: [], instructions: [] },
	contextMode: "fresh",
	tools: ["read"],
	preloadSkills: [],
	contextScopes: ["project"],
	workspace: { mode: "read-only", cwd: ctx.cwd },
	limits: { ...limits.readOnly, retries: 3, resumes: 1 },
	outputSchema: DocSchema,
	retry: { attempts: 2, on: ["backoff", "manual"] },
	resume: { attempts: 1 },
});
```

`retry` applies to a `failed` child whose failure is classified `backoff` or
`manual` (`on` defaults to `["backoff"]`); `resume` applies to an `interrupted`
child whose failure is classified `resume`. Each `attempts` value is 1 through
10 and may not exceed the request's own `limits.retries` or `limits.resumes`.
Every attempt is recorded under the same task execution: intent is persisted
before the owner client's `retry` or `resume` call, the receipt after it, and
each attempt's settlement evidence is retained so budget usage sums across
attempts. pi-subagent enforces backoff; the runtime waits until `retryAt`,
bounded by the workflow deadline and stop signal, and declines the attempt when
either arrives first. Failures classified `never` or `reconcile` are never
retried, and there is no operator-triggered retry yet. The public entry points
are `createWorkflowTaskRetrier`, `AgentRetryPolicySchema`,
`AgentResumePolicySchema`, `settledAgentUsage`, and
`currentSubagentAttemptId`; see
[Contracts](docs/contracts.md#retry-and-resume-attempts).

## Invalidation and re-execution

A durably `failed` or `interrupted` run can be re-driven from a chosen task
with `service.invalidate(runId, causeTaskId, reason)`. One `task-invalidated`
event records the cause, its exact transitive dependents, and the epochs
abandoned after the barrier that exposed them; the restarted drive replays the
on-path prefix exactly, re-materializes the invalidated tasks, and executes
each as a new task-execution generation with a fresh preflight, operation ID,
and subagent or child run. Abandoned declarations stay as history and are never
scheduled, a later declaration may readopt an abandoned key with an unchanged
request, result artifacts bind to the execution that produced them, and every
generation's settled usage counts against the budget. The public entry points
are `invalidationClosure` and `MAX_TASK_EXECUTION_GENERATIONS`; the run view
lists every task with its generation and abandoned marker, and there is no Pi
tool for invalidation yet; see
[Contracts](docs/contracts.md#durable-effect-interpretation).

## Development

Until `@vegardx/pi-subagent` is published, development resolves it from the
sibling `../pi-subagent` checkout. CI checks out the exact qualified commit and
builds it before running:

```text
npm run check
```

## License

MIT
