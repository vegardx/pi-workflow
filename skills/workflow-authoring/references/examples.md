# pi-workflow authoring examples

Every fenced `ts` block below is a complete `*.workflow.ts` module. The test
`test/skill-examples.test.ts` writes each block to a trusted project root and
loads it through the real definition loader, so the examples cannot drift from
the loader's import and schema rules. Agent names (`researcher`, `reviewer`,
`implementer`) are placeholders for named agents that must exist in the
project or global agent directory at preflight.

## Linear: one agent task returned as the output

```ts
import { defineWorkflow } from "@vegardx/pi-workflow";
import { Type } from "typebox";

const InputSchema = Type.Object(
	{ question: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const AnswerSchema = Type.Object(
	{ answer: Type.String(), sources: Type.Array(Type.String()) },
	{ additionalProperties: false },
);
const limits = {
	cumulativeRuntimeMs: 600_000,
	attemptTimeoutMs: 300_000,
	cost: 2,
	outputBytes: 65_536,
	workspaceWriteBytes: 0,
	retries: 0,
	resumes: 0,
};

export default defineWorkflow({
	meta: {
		name: "linear-answer",
		description: "Answer one question from the repository",
		version: 1,
		budget: { cost: 5, childRuntimeMs: 1_800_000 },
		timeoutMs: 3_600_000,
	},
	inputSchema: InputSchema,
	outputSchema: AnswerSchema,
	run(ctx) {
		ctx.phase("answer");
		return ctx.agent("answer", {
			agent: "researcher",
			task: {
				goal: `Answer this question about the repository: ${ctx.input.question}`,
				context: [],
				instructions: ["Return only conclusions supported by files you read."],
			},
			contextMode: "fresh",
			tools: ["read", "grep", "find", "ls"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: ctx.cwd },
			outputSchema: AnswerSchema,
			limits,
		});
	},
});
```

## Complete DAG: declare everything, then return the last handle

Both tasks are materialized before anything runs. `inputs` carries the data;
`after` is redundant here because an input implies order, but it documents
the intent.

```ts
import { defineWorkflow } from "@vegardx/pi-workflow";
import { Type } from "typebox";

const InputSchema = Type.Object(
	{ feature: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const PlanSchema = Type.Object(
	{ steps: Type.Array(Type.String(), { minItems: 1 }) },
	{ additionalProperties: false },
);
const ReviewSchema = Type.Object(
	{ approved: Type.Boolean(), notes: Type.Array(Type.String()) },
	{ additionalProperties: false },
);
const limits = {
	cumulativeRuntimeMs: 600_000,
	attemptTimeoutMs: 300_000,
	cost: 2,
	outputBytes: 65_536,
	workspaceWriteBytes: 0,
	retries: 0,
	resumes: 0,
};

export default defineWorkflow({
	meta: {
		name: "implement-review",
		description: "Plan a feature and review the plan",
		version: 1,
		budget: { cost: 5, childRuntimeMs: 1_800_000 },
		timeoutMs: 3_600_000,
		concurrency: 2,
	},
	inputSchema: InputSchema,
	outputSchema: ReviewSchema,
	run(ctx) {
		const plan = ctx.agent("plan", {
			agent: "implementer",
			task: {
				goal: `Plan the implementation of: ${ctx.input.feature}`,
				context: [],
				instructions: ["List concrete, ordered steps."],
			},
			contextMode: "fresh",
			tools: ["read", "grep", "find", "ls"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: ctx.cwd },
			outputSchema: PlanSchema,
			limits,
		});
		return ctx.agent("review", {
			agent: "reviewer",
			task: {
				goal: "Review the plan supplied as the `plan` input",
				context: [],
				instructions: ["Approve only if every step is verifiable."],
			},
			contextMode: "fresh",
			tools: ["read"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: ctx.cwd },
			outputSchema: ReviewSchema,
			limits,
			after: [plan.ref],
			inputs: { plan: plan.output },
		});
	},
});
```

## Result-dependent branch: await a barrier, then declare more

The `fix` task is declared only when the review rejects. Everything before
`ctx.result` is deterministic; the branch depends only on the barrier value.

```ts
import { defineWorkflow } from "@vegardx/pi-workflow";
import { Type } from "typebox";

const InputSchema = Type.Object(
	{ module: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const ReviewSchema = Type.Object(
	{ approved: Type.Boolean(), findings: Type.Array(Type.String()) },
	{ additionalProperties: false },
);
const OutputSchema = Type.Object(
	{ approved: Type.Boolean(), findings: Type.Array(Type.String()) },
	{ additionalProperties: false },
);
const limits = {
	cumulativeRuntimeMs: 600_000,
	attemptTimeoutMs: 300_000,
	cost: 2,
	outputBytes: 65_536,
	workspaceWriteBytes: 0,
	retries: 0,
	resumes: 0,
};

export default defineWorkflow({
	meta: {
		name: "review-branch",
		description: "Review a module and propose fixes when it is rejected",
		version: 1,
		budget: { cost: 6, childRuntimeMs: 1_800_000 },
		timeoutMs: 3_600_000,
	},
	inputSchema: InputSchema,
	outputSchema: OutputSchema,
	async run(ctx) {
		const review = ctx.agent("review", {
			agent: "reviewer",
			task: {
				goal: `Review the module at ${ctx.input.module}`,
				context: [],
				instructions: ["Report concrete findings with file references."],
			},
			contextMode: "fresh",
			tools: ["read", "grep"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: ctx.cwd },
			outputSchema: ReviewSchema,
			limits,
		});
		const decision = await ctx.result(review);
		if (decision.approved) {
			return { approved: true, findings: decision.findings };
		}
		ctx.phase("propose-fixes");
		return ctx.agent("fix", {
			agent: "implementer",
			task: {
				goal: "Propose fixes for the findings supplied as the `review` input",
				context: [],
				instructions: ["Return one proposed fix per finding."],
			},
			contextMode: "fresh",
			tools: ["read", "grep"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: ctx.cwd },
			outputSchema: OutputSchema,
			limits,
			inputs: { review: review.output },
		});
	},
});
```

## Fan-out and fan-in

`fanOut` declares one task per item in the `items` namespace with stable keys
`item-<index>`; `fanIn` aggregates them under matching input names. The
optional per-item tasks are read through `ctx.settled`, so one failing item
degrades rather than fails the run.

```ts
import { defineWorkflow } from "@vegardx/pi-workflow";
import { Type } from "typebox";

const InputSchema = Type.Object(
	{ files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 16 }) },
	{ additionalProperties: false },
);
const SummarySchema = Type.Object(
	{ file: Type.String(), summary: Type.String() },
	{ additionalProperties: false },
);
const ReportSchema = Type.Object(
	{ overview: Type.String(), summarized: Type.Integer({ minimum: 0 }) },
	{ additionalProperties: false },
);
const limits = {
	cumulativeRuntimeMs: 600_000,
	attemptTimeoutMs: 300_000,
	cost: 1,
	outputBytes: 65_536,
	workspaceWriteBytes: 0,
	retries: 0,
	resumes: 0,
};

export default defineWorkflow({
	meta: {
		name: "summarize-items",
		description: "Summarize each file, then write one report",
		version: 1,
		budget: { cost: 20, childRuntimeMs: 3_600_000 },
		timeoutMs: 3_600_000,
		concurrency: 4,
	},
	inputSchema: InputSchema,
	outputSchema: ReportSchema,
	async run(ctx) {
		const summaries = ctx.fanOut("items", ctx.input.files, {
			key: (_file, index) => `item-${index}`,
			task: (file) => ({
				agent: "researcher",
				task: {
					goal: `Summarize the file ${file}`,
					context: [],
					instructions: ["Two sentences at most."],
				},
				contextMode: "fresh",
				tools: ["read"],
				preloadSkills: [],
				contextScopes: ["project"],
				workspace: { mode: "read-only", cwd: ctx.cwd },
				outputSchema: SummarySchema,
				limits,
				disposition: "optional",
			}),
		});
		const settled = await ctx.settled(summaries);
		const fulfilled = summaries.filter(
			(_handle, index) => settled[index]?.status === "fulfilled",
		);
		if (fulfilled.length === 0) {
			return { overview: "No file could be summarized.", summarized: 0 };
		}
		return ctx.fanIn("report", fulfilled, {
			inputKey: (_source, index) => `summary-${index}`,
			task: {
				agent: "researcher",
				task: {
					goal: "Write one overview from the summary inputs",
					context: [],
					instructions: [
						`Set summarized to ${fulfilled.length}.`,
						"Mention every summarized file once.",
					],
				},
				contextMode: "fresh",
				tools: [],
				preloadSkills: [],
				contextScopes: ["project"],
				workspace: { mode: "read-only", cwd: ctx.cwd },
				outputSchema: ReportSchema,
				limits,
			},
		});
	},
});
```

## Pipeline: namespaced stages chained through explicit inputs

Stages are ordinary agent tasks in the `analysis` namespace. There is no
implicit previous-result injection; each stage names the artifact it consumes.

```ts
import { defineWorkflow } from "@vegardx/pi-workflow";
import { Type } from "typebox";

const InputSchema = Type.Object(
	{ directory: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const InventorySchema = Type.Object(
	{ files: Type.Array(Type.String()) },
	{ additionalProperties: false },
);
const FindingsSchema = Type.Object(
	{ findings: Type.Array(Type.String()) },
	{ additionalProperties: false },
);
const limits = {
	cumulativeRuntimeMs: 600_000,
	attemptTimeoutMs: 300_000,
	cost: 2,
	outputBytes: 65_536,
	workspaceWriteBytes: 0,
	retries: 0,
	resumes: 0,
};

export default defineWorkflow({
	meta: {
		name: "analysis-pipeline",
		description: "Inventory a directory, then review the inventory",
		version: 1,
		budget: { cost: 5, childRuntimeMs: 1_800_000 },
		timeoutMs: 3_600_000,
	},
	inputSchema: InputSchema,
	outputSchema: FindingsSchema,
	run(ctx) {
		return ctx.pipeline("analysis", (stage) => {
			const collect = stage.agent("collect", {
				agent: "researcher",
				task: {
					goal: `List the source files under ${ctx.input.directory}`,
					context: [],
					instructions: ["Return relative paths only."],
				},
				contextMode: "fresh",
				tools: ["find", "ls"],
				preloadSkills: [],
				contextScopes: ["project"],
				workspace: { mode: "read-only", cwd: ctx.cwd },
				outputSchema: InventorySchema,
				limits,
			});
			return stage.agent("review", {
				agent: "reviewer",
				task: {
					goal: "Review the files listed in the `inventory` input",
					context: [],
					instructions: ["Report one finding per problem."],
				},
				contextMode: "fresh",
				tools: ["read"],
				preloadSkills: [],
				contextScopes: ["project"],
				workspace: { mode: "read-only", cwd: ctx.cwd },
				outputSchema: FindingsSchema,
				limits,
				inputs: { inventory: collect.output },
			});
		});
	},
});
```

## Support task: deterministic host-process step over an agent result

The workflow declares the support task; the embedder registers the matching
implementation with `createWorkflowService({ supportTasks:
[digest.registration(execute)] })`. The identity fields must match that
registration exactly or the task fails at `support-resolution`.

```ts
import { defineSupportTask, defineWorkflow } from "@vegardx/pi-workflow";
import { Type } from "typebox";

const InputSchema = Type.Object(
	{ topic: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const DocSchema = Type.Object(
	{ title: Type.String(), body: Type.String() },
	{ additionalProperties: false },
);
const DigestSchema = Type.Object(
	{ algorithm: Type.Literal("sha256"), digest: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
	{ additionalProperties: false },
);
const limits = {
	cumulativeRuntimeMs: 600_000,
	attemptTimeoutMs: 300_000,
	cost: 2,
	outputBytes: 65_536,
	workspaceWriteBytes: 0,
	retries: 0,
	resumes: 0,
};

const digest = defineSupportTask({
	name: "digest",
	moduleSpecifier: "@example/workflow-support",
	revision: 1,
	implementationSha256:
		"6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
	parametersSchema: Type.Object(
		{ algorithm: Type.Literal("sha256") },
		{ additionalProperties: false },
	),
	outputSchema: DigestSchema,
});

export default defineWorkflow({
	meta: {
		name: "digest-support",
		description: "Draft a document and digest it in-process",
		version: 1,
		budget: { cost: 5, childRuntimeMs: 1_800_000 },
		timeoutMs: 3_600_000,
	},
	inputSchema: InputSchema,
	outputSchema: DigestSchema,
	run(ctx) {
		const draft = ctx.agent("draft", {
			agent: "researcher",
			task: {
				goal: `Draft a short document about ${ctx.input.topic}`,
				context: [],
				instructions: ["Use only facts from the repository."],
			},
			contextMode: "fresh",
			tools: ["read", "grep"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: ctx.cwd },
			outputSchema: DocSchema,
			limits,
		});
		return ctx.support(
			"hash",
			digest({ parameters: { algorithm: "sha256" }, inputs: { doc: draft.output } }),
		);
	},
});
```

## Nested workflow with an artifact input

The parent passes the authored `input` plus the `doc` artifact; at launch the
runtime merges them into `{ topic, doc }`, which the child's `inputSchema`
must accept. Both definitions live in the same discovery roots.

```ts
import { defineWorkflow } from "@vegardx/pi-workflow";
import { Type } from "typebox";

const InputSchema = Type.Object(
	{ topic: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const DocSchema = Type.Object(
	{ title: Type.String(), body: Type.String() },
	{ additionalProperties: false },
);
const VerdictSchema = Type.Object(
	{ verdict: Type.String(), wordCount: Type.Integer({ minimum: 0 }) },
	{ additionalProperties: false },
);
const limits = {
	cumulativeRuntimeMs: 600_000,
	attemptTimeoutMs: 300_000,
	cost: 2,
	outputBytes: 65_536,
	workspaceWriteBytes: 0,
	retries: 0,
	resumes: 0,
};

export default defineWorkflow({
	meta: {
		name: "nested-parent",
		description: "Draft a document and hand it to a child workflow",
		version: 1,
		budget: { cost: 10, childRuntimeMs: 3_600_000 },
		timeoutMs: 3_600_000,
	},
	inputSchema: InputSchema,
	outputSchema: VerdictSchema,
	run(ctx) {
		const draft = ctx.agent("draft", {
			agent: "researcher",
			task: {
				goal: `Draft a document about ${ctx.input.topic}`,
				context: [],
				instructions: ["Keep it under 300 words."],
			},
			contextMode: "fresh",
			tools: ["read"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: ctx.cwd },
			outputSchema: DocSchema,
			limits,
		});
		return ctx.workflow<{ verdict: string; wordCount: number }>("assess", {
			workflow: "nested-child",
			input: { topic: ctx.input.topic },
			inputs: { doc: draft.output },
		});
	},
});
```

```ts
import { defineWorkflow } from "@vegardx/pi-workflow";
import { Type } from "typebox";

const DocSchema = Type.Object(
	{ title: Type.String(), body: Type.String() },
	{ additionalProperties: false },
);
const InputSchema = Type.Object(
	{ topic: Type.String({ minLength: 1 }), doc: DocSchema },
	{ additionalProperties: false },
);
const VerdictSchema = Type.Object(
	{ verdict: Type.String(), wordCount: Type.Integer({ minimum: 0 }) },
	{ additionalProperties: false },
);
const limits = {
	cumulativeRuntimeMs: 600_000,
	attemptTimeoutMs: 300_000,
	cost: 2,
	outputBytes: 65_536,
	workspaceWriteBytes: 0,
	retries: 0,
	resumes: 0,
};

export default defineWorkflow({
	meta: {
		name: "nested-child",
		description: "Assess a document merged into the input",
		version: 1,
		budget: { cost: 3, childRuntimeMs: 900_000 },
		timeoutMs: 1_800_000,
	},
	inputSchema: InputSchema,
	outputSchema: VerdictSchema,
	run(ctx) {
		return ctx.agent("assess", {
			agent: "reviewer",
			task: {
				goal: `Assess the document titled "${ctx.input.doc.title}" about ${ctx.input.topic}`,
				context: [ctx.input.doc.body],
				instructions: ["Count the words in the context and give a one-line verdict."],
			},
			contextMode: "fresh",
			tools: [],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: ctx.cwd },
			outputSchema: VerdictSchema,
			limits,
		});
	},
});
```

## Retry and resume policies

`retry.attempts` may not exceed `limits.retries`, and `resume.attempts` may
not exceed `limits.resumes`. `on` lists the failure classes that admit a fresh
attempt.

```ts
import { defineWorkflow } from "@vegardx/pi-workflow";
import { Type } from "typebox";

const InputSchema = Type.Object(
	{ subject: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const DocSchema = Type.Object(
	{ title: Type.String(), body: Type.String() },
	{ additionalProperties: false },
);

export default defineWorkflow({
	meta: {
		name: "resilient-draft",
		description: "Draft with bounded retry and resume attempts",
		version: 1,
		budget: { cost: 10, childRuntimeMs: 3_600_000 },
		timeoutMs: 7_200_000,
	},
	inputSchema: InputSchema,
	outputSchema: DocSchema,
	run(ctx) {
		return ctx.agent("draft", {
			agent: "researcher",
			task: {
				goal: `Draft a document about ${ctx.input.subject}`,
				context: [],
				instructions: ["Cite the files you relied on."],
			},
			contextMode: "fresh",
			tools: ["read", "grep"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: ctx.cwd },
			outputSchema: DocSchema,
			limits: {
				cumulativeRuntimeMs: 1_800_000,
				attemptTimeoutMs: 600_000,
				totalTokens: 400_000,
				cost: 4,
				outputBytes: 65_536,
				workspaceWriteBytes: 0,
				retries: 3,
				resumes: 1,
			},
			retry: { attempts: 2, on: ["backoff", "manual"] },
			resume: { attempts: 1 },
		});
	},
});
```

## Worktree task with a handoff consumed by a read-only reviewer

The `implement` task runs in an isolated pi-subagent worktree
(`workspace.mode: "worktree"`, `workspaceWriteBytes >= 1`). Its handoff is
imported as a workflow-owned `git format-patch` artifact before the child is
released; `ctx.handoff` resolves the descriptor (identity, digest, size; never
paths or bytes), and `implement.handoff` feeds the reviewer the same
descriptor as an input. Under the default `handoff: "required"` policy a child
that changed nothing fails the task, so the descriptor is defined once the
barrier resolves.

```ts
import { defineWorkflow } from "@vegardx/pi-workflow";
import { Type } from "typebox";

const InputSchema = Type.Object(
	{ change: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const SummarySchema = Type.Object(
	{ summary: Type.String(), files: Type.Array(Type.String()) },
	{ additionalProperties: false },
);
const ReviewSchema = Type.Object(
	{ approved: Type.Boolean(), notes: Type.Array(Type.String()) },
	{ additionalProperties: false },
);
const readOnly = {
	cumulativeRuntimeMs: 600_000,
	attemptTimeoutMs: 300_000,
	cost: 2,
	outputBytes: 65_536,
	workspaceWriteBytes: 0,
	retries: 0,
	resumes: 0,
};
const writer = {
	...readOnly,
	cumulativeRuntimeMs: 1_800_000,
	attemptTimeoutMs: 900_000,
	cost: 6,
	workspaceWriteBytes: 64 * 1024 * 1024,
};

export default defineWorkflow({
	meta: {
		name: "worktree-implement",
		description: "Implement a change in a worktree, then review its handoff",
		version: 1,
		budget: { cost: 10, childRuntimeMs: 3_600_000 },
		timeoutMs: 7_200_000,
	},
	inputSchema: InputSchema,
	outputSchema: ReviewSchema,
	async run(ctx) {
		const implement = ctx.agent("implement", {
			agent: "implementer",
			task: {
				goal: `Implement this change: ${ctx.input.change}`,
				context: [],
				instructions: ["Change only the files the task requires."],
			},
			contextMode: "fresh",
			tools: ["read", "grep", "find", "ls", "edit", "write"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "worktree", cwd: ctx.cwd },
			handoff: "required",
			outputSchema: SummarySchema,
			limits: writer,
		});
		const handoff = await ctx.handoff(implement);
		ctx.phase(handoff ? "review-handoff" : "review-summary");
		return ctx.agent("review", {
			agent: "reviewer",
			task: {
				goal: "Review the change described by the `summary` and `handoff` inputs",
				context: [],
				instructions: [
					"The handoff input is identity (baseline, commit, digest), not patch bytes.",
					"Approve only when the summary matches the declared files.",
				],
			},
			contextMode: "fresh",
			tools: ["read", "grep"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: ctx.cwd },
			outputSchema: ReviewSchema,
			limits: readOnly,
			inputs: { summary: implement.output, handoff: implement.handoff },
		});
	},
});
```

## Finalizers: required record and advisory announcement

Both finalizers are declared and never awaited or returned; the run returns
the ordinary `report` handle. They execute only after the output is committed:
the required support finalizer must complete for the run to succeed, while a
failing advisory agent finalizer only degrades it.

```ts
import { defineSupportTask, defineWorkflow } from "@vegardx/pi-workflow";
import { Type } from "typebox";

const InputSchema = Type.Object(
	{ topic: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const ReportSchema = Type.Object(
	{ title: Type.String(), body: Type.String() },
	{ additionalProperties: false },
);
const RecordSchema = Type.Object(
	{ recorded: Type.Boolean() },
	{ additionalProperties: false },
);
const AnnouncementSchema = Type.Object(
	{ summary: Type.String() },
	{ additionalProperties: false },
);
const limits = {
	cumulativeRuntimeMs: 600_000,
	attemptTimeoutMs: 300_000,
	cost: 2,
	outputBytes: 65_536,
	workspaceWriteBytes: 0,
	retries: 0,
	resumes: 0,
};

const record = defineSupportTask({
	name: "record-report",
	moduleSpecifier: "@example/workflow-support",
	revision: 1,
	implementationSha256:
		"d4735e3a265e16eee03f59718b9b5d03019c07d8b6c51f90da3a666eec13ab35",
	parametersSchema: Type.Object(
		{ channel: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	outputSchema: RecordSchema,
});

export default defineWorkflow({
	meta: {
		name: "finalized-report",
		description: "Write a report, then record and announce it",
		version: 1,
		budget: { cost: 6, childRuntimeMs: 1_800_000 },
		timeoutMs: 3_600_000,
	},
	inputSchema: InputSchema,
	outputSchema: ReportSchema,
	run(ctx) {
		const report = ctx.agent("report", {
			agent: "researcher",
			task: {
				goal: `Write a short report about ${ctx.input.topic}`,
				context: [],
				instructions: ["Use only facts from the repository."],
			},
			contextMode: "fresh",
			tools: ["read", "grep"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: ctx.cwd },
			outputSchema: ReportSchema,
			limits,
		});
		ctx.finalize("record", {
			kind: "required",
			support: record({
				parameters: { channel: "audit" },
				inputs: { report: report.output },
			}),
		});
		ctx.finalize("announce", {
			kind: "advisory",
			agent: {
				agent: "researcher",
				task: {
					goal: "Summarize the report supplied as the `report` input in one sentence",
					context: [],
					instructions: ["Do not add facts that the report does not contain."],
				},
				contextMode: "fresh",
				tools: [],
				preloadSkills: [],
				contextScopes: ["project"],
				workspace: { mode: "read-only", cwd: ctx.cwd },
				outputSchema: AnnouncementSchema,
				limits,
				after: [report.ref],
				inputs: { report: report.output },
			},
		});
		return report;
	},
});
```

## Checkpoint gating a worktree writer

The `approve` checkpoint shows the approver the plan and parks the run until a
person decides (`headless: "block"`, one hour). Only after a `proceed: true`
decision does the worktree writer run; a rejection returns without writing.
Only a person decides it: a model must never decide a checkpoint, and the
operator answers through `/workflow decide` in an interactive Pi session.
The optional `tone` checkpoint takes its default when nobody answers within
ten minutes or when the embedder runs the service headless.

```ts
import { defineWorkflow } from "@vegardx/pi-workflow";
import { Type } from "typebox";

const InputSchema = Type.Object(
	{ change: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const PlanSchema = Type.Object(
	{ steps: Type.Array(Type.String()), risk: Type.String() },
	{ additionalProperties: false },
);
const ApprovalSchema = Type.Object(
	{ proceed: Type.Boolean(), note: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);
const ToneSchema = Type.Union([Type.Literal("formal"), Type.Literal("casual")]);
const SummarySchema = Type.Object(
	{ summary: Type.String() },
	{ additionalProperties: false },
);
const OutputSchema = Type.Object(
	{ approved: Type.Boolean(), summary: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);
const readOnly = {
	cumulativeRuntimeMs: 600_000,
	attemptTimeoutMs: 300_000,
	cost: 2,
	outputBytes: 65_536,
	workspaceWriteBytes: 0,
	retries: 0,
	resumes: 0,
};

export default defineWorkflow({
	meta: {
		name: "approved-implement",
		description: "Plan, ask a human, then implement in a worktree",
		version: 1,
		budget: { cost: 8, childRuntimeMs: 1_800_000 },
		timeoutMs: 7_200_000,
	},
	inputSchema: InputSchema,
	outputSchema: OutputSchema,
	async run(ctx) {
		const plan = ctx.agent("plan", {
			agent: "researcher",
			task: {
				goal: `Plan the change: ${ctx.input.change}`,
				context: [],
				instructions: ["List the steps and the main risk."],
			},
			contextMode: "fresh",
			tools: ["read", "grep"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: ctx.cwd },
			outputSchema: PlanSchema,
			limits: readOnly,
		});
		const approve = ctx.checkpoint("approve", {
			schema: ApprovalSchema,
			prompt: "Approve the plan before the writer runs?",
			headless: "block",
			timeoutMs: 3_600_000,
			inputs: { plan: plan.output },
		});
		const tone = ctx.checkpoint("tone", {
			schema: ToneSchema,
			prompt: "Which tone should the summary use?",
			headless: "use-explicit-default",
			default: "formal",
			timeoutMs: 600_000,
			disposition: "optional",
		});
		const decision = await ctx.result(approve);
		if (!decision.proceed) return { approved: false };
		const implement = ctx.agent("implement", {
			agent: "implementer",
			task: {
				goal: "Implement the approved plan supplied as the `plan` input",
				context: [],
				instructions: ["Follow the plan; do not widen the change."],
			},
			contextMode: "fresh",
			tools: ["read", "grep", "edit", "write"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "worktree", cwd: ctx.cwd },
			handoff: "required",
			limits: { ...readOnly, workspaceWriteBytes: 64 * 1024 * 1024 },
			outputSchema: SummarySchema,
			after: [approve.ref],
			inputs: { plan: plan.output, tone: tone.output },
		});
		const result = await ctx.result(implement);
		return { approved: true, summary: result.summary };
	},
});
```

## Dynamic workflow: the same source proposed through `workflow_propose`

Nothing in the source says "dynamic". Saved as a `*.workflow.ts` file it is a
static definition; passed as the `source` of `workflow_propose` it becomes the
proposal `dynamic:<sha256>` that a human approves with `/workflow approve`
before `workflow_run` accepts the reference. It obeys the two dynamic-only
rules (no `import.meta`, exactly one default export and no named exports)
and reads neither the clock nor the environment before its barrier, so the
fresh VM that boots on every drive replays it exactly. The optional `deep`
task is declared only after the triage result is known.

```ts
import { defineWorkflow } from "@vegardx/pi-workflow";
import { Type } from "typebox";

const InputSchema = Type.Object(
	{ issue: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const TriageSchema = Type.Object(
	{
		severity: Type.Union([
			Type.Literal("low"),
			Type.Literal("high"),
		]),
		summary: Type.String(),
	},
	{ additionalProperties: false },
);
const ReportSchema = Type.Object(
	{ severity: Type.String(), summary: Type.String(), files: Type.Array(Type.String()) },
	{ additionalProperties: false },
);
const limits = {
	cumulativeRuntimeMs: 600_000,
	attemptTimeoutMs: 300_000,
	cost: 2,
	outputBytes: 65_536,
	workspaceWriteBytes: 0,
	retries: 0,
	resumes: 0,
};

export default defineWorkflow({
	meta: {
		name: "dynamic-triage",
		description: "Triage an issue and investigate it further when it is severe",
		version: 1,
		budget: { cost: 6, childRuntimeMs: 1_800_000 },
		timeoutMs: 3_600_000,
	},
	inputSchema: InputSchema,
	outputSchema: ReportSchema,
	async run(ctx) {
		ctx.phase("triage");
		const triage = ctx.agent("triage", {
			agent: "researcher",
			task: {
				goal: `Triage this issue against the repository: ${ctx.input.issue}`,
				context: [],
				instructions: ["Classify the severity as low or high and summarize why."],
			},
			contextMode: "fresh",
			tools: ["read", "grep"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: ctx.cwd },
			outputSchema: TriageSchema,
			limits,
		});
		const result = await ctx.result(triage);
		if (result.severity === "low") {
			return { severity: result.severity, summary: result.summary, files: [] };
		}
		ctx.phase("investigate");
		return ctx.agent("deep", {
			agent: "researcher",
			task: {
				goal: "List the files involved in the issue summarized by the `triage` input",
				context: [],
				instructions: ["Return relative paths only; keep the summary unchanged."],
			},
			contextMode: "fresh",
			tools: ["read", "grep", "find"],
			preloadSkills: [],
			contextScopes: ["project"],
			workspace: { mode: "read-only", cwd: ctx.cwd },
			outputSchema: ReportSchema,
			limits,
			inputs: { triage: triage.output },
		});
	},
});
```
