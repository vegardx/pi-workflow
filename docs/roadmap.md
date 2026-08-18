# Roadmap

## Phase 0 — contracts

- glossary and ownership boundary;
- workflow/run/task identity;
- static definition API;
- SubagentService compatibility contract;
- authority model and project trust;
- run/task state machines;
- persistence, replay, and failure taxonomy;
- acceptance-test inventory.

## Phase 1 — static workflow MVP

Unit development uses a fake SubagentService matching the documented contract.
Packed integration waits for a pi-subagent release exposing all required
features.

- TypeScript workflow discovery via `getAgentDir()` and project roots;
- package root registration;
- workflow list and validation;
- sequential agent tasks;
- exact model/tool requests through SubagentService;
- strict structured outputs;
- foreground cancellation and result.

## Phase 2 — orchestration

- parallel and settled parallel;
- pipelines and bounded fan-out;
- stages and progress events;
- deterministic support tasks;
- nested static workflows with bounded depth;
- concurrency, task, token, and time limits.

## Phase 3 — durability

- journal and bounded snapshots;
- run leases;
- status, logs, wait, and stop;
- retry and resume;
- replay identity and invalidation;
- subagent/workspace reconciliation;
- required finalizers;
- checkpoints.

## Phase 4 — product surface

- persistent widget and inspector;
- packed integration tests with pi-subagent;
- workflow authoring skill;
- first stable static-workflow API.

## Phase 5 — dynamic workflows

- worker-thread VM;
- bounded host API;
- generated-source review and approval;
- stable task and budget enforcement;
- dynamic recovery rules.

## Initial non-goals

- private subagent runtime;
- publication and PR policy;
- generated web wrappers;
- web source caching;
- schedules;
- unbounded recursive workflows;
- arbitrary dynamic imports;
- distributed or cross-machine workers.
