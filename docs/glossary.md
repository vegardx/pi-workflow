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
| Task execution | One generation of task execution; an agent-task execution owns one subagent run and its retry/resume attempts, while explicit invalidation creates a new generation. |
| Agent task | Task executed through the extension-owned `SubagentService`. |
| Support task | Deterministic trusted local code executed without a model. |
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
| Retry | Fresh subagent attempt within the existing agent-task execution after a classified failure. |
| Resume | Continue an interrupted workflow run and, when needed, create a fresh subagent attempt within the existing task execution. |
| Re-execution | New task-execution generation after explicit invalidation of an earlier result or dependency. |
| Replay | Reuse a completed task result whose full identity still matches. |
| Invalidation | Mark a result unusable because an input, dependency, or runtime identity changed. |
| Reconcile | Compare persisted workflow state with subagent and workspace reality. |
| Finalizer | Required or advisory settlement effect after ordinary workflow execution. |
| Maestro plan | Delivery-domain intent that may later be lowered into workflow effects; it is not a workflow runtime concept. |
