# Glossary

Subagent terms are owned by the
[`pi-subagent` glossary](https://github.com/vegardx/pi-subagent/blob/main/docs/glossary.md).
This document owns workflow terminology.

| Term | Definition |
| --- | --- |
| Workflow definition | Reusable, versioned orchestration program with input/output schemas. |
| Static workflow | Trusted saved TypeScript workflow authored before execution. |
| Dynamic workflow | Task-specific workflow program executed through a bounded host API. |
| Workflow registry | Ordered collection of discovered definitions with provenance and collision rules. |
| Workflow run | One execution of a workflow definition with concrete validated input. |
| Phase | Progress label grouping related effects; it is not independently schedulable. |
| Effect declaration | Stable-keyed authoring call that requests a task or artifact without directly performing it. |
| Effect materializer | Interpreter that validates declarations and commits declarative graph records. |
| Task handle | Opaque, non-thenable authoring reference to a workflow task. |
| Artifact handle | Opaque authoring reference to a task output or committed workflow artifact. |
| Materialized graph | Durable declarative task and dependency records discovered from workflow effects. |
| Task | One stable-keyed effect materialized by a workflow run. |
| Task execution | One generation of task execution, discriminated by kind; an agent-task execution owns one subagent run together with its initial attempt and every retry or resume attempt recorded under it, a support-task execution owns one in-process computation bound to its implementation identity, a nested workflow task execution owns one linked child workflow run named by its deterministic child run ID, and explicit invalidation creates the next contiguous generation (at most 16) once the previous execution is terminal and re-materialization has detached it, after which the new execution becomes the task's current execution while every prior execution keeps its evidence. |
| Agent task | Task executed through the extension-owned `SubagentService`. |
| Support task | Deterministic trusted registered code executed in the host process without a model, subagent, VM, or worktree; its output is a workflow-owned result artifact. |
| Nested workflow task | Task of kind `workflow` declared with `ctx.workflow(key, { workflow, input, inputs? })` that captures a child definition's identity, source digest, schemas, budget, timeout, concurrency, authored input, and named artifact inputs at declaration and executes it as a linked child run; its output is a parent-owned result artifact imported from the child. |
| Child workflow run | Separate durable workflow run launched by a nested workflow task, with its own journal, lease, artifact store, subagent owner binding `pi-workflow:<childRunId>`, budget, and deadline; it re-executes its own trusted source exactly like a root run and is addressable by its own run ID. |
| Lineage | Persisted nesting relationship of a run: its `depth` (0 through 3) and, for a child run, `parent { runId, taskId, executionId, ancestorDefinitionIdentities, inputArtifacts }`; verified exactly, injected input artifacts included, before an existing child run is adopted and used to reject recursion at declaration. |
| Injected input | A parent artifact named in a nested workflow task's `inputs` whose verified value is read at launch and merged as a top-level key into the child's authored input; recorded in the child's lineage as `{ runId, artifactId, sha256 }` and in the parent's nested intent by digest. It is a provenance record and a copied value, never a cross-run read path. |
| Support registry | Immutable map of support-task registrations supplied when the workflow service is constructed; never persisted and resolved again on every restart. |
| Implementation identity | Canonical digest of a support implementation's name, module specifier, revision, implementation digest, parameters schema, and output schema. |
| Support intent | Durable record of the implementation, parameter, and input digests a support execution computes from; persisted before the implementation runs. |
| Stable task key | Workflow-authored identity unique within its namespace across resume and replay. |
| Order dependency | Readiness edge requiring another task to settle without consuming its output. |
| Data dependency | Edge requiring another task's verified artifact as input. |
| Execution barrier | Explicit request for one or more concrete task results, allowing the scheduler to run until they settle. |
| Fan-out | Materializing multiple independent tasks from bounded input. |
| Fan-in | Reducing multiple task results into a later task. |
| Pipeline | Typed authoring helper that materializes sequential task dependencies. |
| Artifact | Durable bounded output owned by a workflow run or task. |
| Handoff | Bounded verified data or repository evidence supplied from one task to another. |
| Structured output | Schema-validated result produced through the subagent terminating tool. |
| Checkpoint | Durable human decision that gates later work. |
| Journal | Append-only lifecycle event record and source of truth. |
| Snapshot | Derived current state reconstructed from journal events. |
| Projection | Bounded state view for UI, prompts, or APIs. |
| Retry | Fresh subagent attempt on the same child run, obtained through the owner client's `retry`, recorded under the existing agent-task execution after a durable `failed` settlement classified `backoff` or `manual` and admitted by the task's `retry` policy. |
| Resume | Fresh subagent attempt on the same child run, obtained through the owner client's `resume`, recorded under the existing agent-task execution after a durable `interrupted` settlement classified `resume` and admitted by the task's `resume` policy; distinct from resuming a workflow run, which reconstructs state from the journal. |
| Attempt ordinal | Position of a subagent attempt within its agent-task execution: 1 for the initial attempt, then contiguous from 2 for each intended retry or resume, at most 21; carried on every attempt event and on subagent settlement evidence. |
| Re-execution | New task-execution generation created for a task re-materialized after explicit invalidation; it receives a fresh preflight, operation ID, and subagent run or child run, and its result artifact binds to the new execution. |
| Replay | Reuse a completed task result whose full identity still matches. |
| Invalidation | Durable `task-invalidated` event naming a cause task, the exact closure of the cause and its transitive dependents, and the exact epochs abandoned after the exposing barrier; triggered only through the service's `invalidate` on a settled `failed` or `interrupted` run and verified by the reducer. |
| Exposing barrier | First on-path barrier whose task IDs intersect an invalidation closure; every on-path epoch after it is abandoned, and nothing is abandoned when no barrier exposes the closure. |
| Abandoned | Declaration or barrier recorded in an epoch after the exposing barrier of an invalidation, or an effect sequenced after that barrier; retained with `abandoned: true` as history, never scheduled, never counted as unsettled or required work, never a dependency of path tasks, and still charged for its settled usage. |
| Readoption | Re-declaration of an abandoned task by a declaration beyond the on-path prefix with the same `(namespace, key)` and identity digest; the same task ID returns to the path with fresh sequence, epoch, and position fields and keeps its status, commit, and current execution. |
| Reconcile | Compare persisted workflow state with subagent and workspace reality. |
| Finalizer | Required or advisory settlement effect after ordinary workflow execution. |
| Maestro plan | Delivery-domain intent that may later be lowered into workflow effects; it is not a workflow runtime concept. |
