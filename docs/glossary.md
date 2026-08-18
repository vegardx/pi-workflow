# Glossary

Subagent terms are owned by the
[`pi-subagent` glossary](https://github.com/vegardx/pi-subagent/blob/main/docs/glossary.md).
This document owns workflow terminology.

| Term | Definition |
| --- | --- |
| Workflow definition | Reusable, versioned orchestration program or declarative definition. |
| Static workflow | Trusted saved workflow authored before execution. |
| Dynamic workflow | Task-specific workflow program generated at runtime and executed through a bounded host API. |
| Workflow registry | Ordered collection of discovered definitions with provenance and collision rules. |
| Workflow run | One execution of a workflow definition with concrete input. |
| Phase | Progress label grouping related effects; it is not independently schedulable. |
| Task | One stable-keyed effect materialized by a workflow run. |
| Task execution | One generation of physical execution for a task; retry creates a new generation. |
| Agent task | Task executed through `SubagentService`. |
| Support task | Deterministic local code executed without a model. |
| Stable task key | Workflow-authored identity that remains stable across resume and replay. |
| Order dependency | Readiness edge requiring another task to settle without consuming its output. |
| Data dependency | Edge requiring another task's artifact as input. |
| Fan-out | Materializing multiple independent tasks from bounded input. |
| Fan-in | Reducing multiple task results into a later task. |
| Pipeline | Applying sequential stages to one or more items. |
| Artifact | Durable bounded output associated with a run or task. |
| Handoff | Bounded data supplied from one task to another. |
| Structured output | Schema-validated result produced through a terminating tool. |
| Checkpoint | Durable human decision that gates later work. |
| Effect interpreter | Runtime that re-executes a workflow function and resolves stable-keyed effects from journal state or live execution. |
| Journal | Append-only lifecycle event record. |
| Snapshot | Derived current state reconstructed from journal events. |
| Projection | Bounded state view for UI, prompts, or APIs. |
| Retry | New attempt of a task after a classified failure. |
| Resume | Continue an interrupted workflow from durable state. |
| Replay | Reuse a completed task result whose full identity still matches. |
| Invalidation | Mark a result unusable because an input, dependency, or runtime identity changed. |
| Reconcile | Compare persisted workflow state with subagent and workspace reality. |
| Finalizer | Required or advisory cleanup/commit action after workflow execution. |
| Maestro plan | A downstream delivery-domain document compiled into workflow operations; it is not a workflow runtime concept. |
