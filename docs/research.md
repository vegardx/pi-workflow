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
