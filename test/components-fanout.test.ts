import type { ExactModelRequest } from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { WorkflowComponentError } from "../src/components/errors.js";
import {
	dedupeFindings,
	FINDING_SEVERITIES,
	type Finding,
	findingSeverityRank,
	MAX_FINDINGS,
	mergeReviewReports,
	ReviewReportSchema,
	ReviewSynthesisSchema,
} from "../src/components/finding.js";
import {
	forEach,
	MAX_FOR_EACH_ITEMS,
	projectFanOutBudget,
} from "../src/components/for-each.js";
import {
	MAX_REVIEW_LENSES,
	type ReviewLens,
	type ReviewTaskRequest,
	resolveReviewKeys,
	reviewFanOut,
} from "../src/components/review-fan-out.js";
import type {
	AgentTaskAuthoringRequest,
	SettledTaskResult,
	TaskHandle,
	WorkflowContext,
} from "../src/definition.js";
import type { WorkflowEventInput } from "../src/events.js";
import { WorkflowTaskMaterializer } from "../src/materializer.js";

// W0-COMP-B acceptance. Every expectation below is the plan-loop spec
// (sections 2.2, 2.3 and 5) or the replay laws of
// `composition-and-plan-loop-analysis.md`, not the components' implementation.
// The lowering assertions drive the REAL materializer: a component's
// declarations must be byte-identical to the hand-written `ctx.fanOut` /
// `ctx.fanIn` they claim to be, identities included.

const RUN_ID = "workflow_components";
const DEFINITION_IDENTITY = "a".repeat(64);
const INPUT_DIGEST = "b".repeat(64);
const MODEL: ExactModelRequest = {
	provider: "github-copilot",
	id: "gpt-5.6-sol",
	thinking: "medium",
};
const DIVERSE_MODEL: ExactModelRequest = {
	provider: "github-copilot",
	id: "gpt-5.6-luna",
	thinking: "medium",
};

const WorkSchema = Type.Object(
	{ summary: Type.String() },
	{ additionalProperties: false },
);

function limits(cost = 3) {
	return {
		cumulativeRuntimeMs: 600_000,
		attemptTimeoutMs: 600_000,
		totalTokens: 400_000,
		cost,
		outputBytes: 65_536,
		workspaceWriteBytes: 0,
		retries: 1,
		resumes: 1,
	};
}

function readOnlyRequest(goal: string, cost = 3) {
	return {
		agent: "reviewer",
		task: { goal, context: [], instructions: ["Return structured output."] },
		contextMode: "fresh" as const,
		tools: ["read", "grep", "find", "ls"],
		preloadSkills: [],
		contextScopes: ["project" as const],
		workspace: { mode: "read-only" as const, cwd: "/repo" },
		limits: limits(cost),
		retry: { attempts: 1, on: ["backoff" as const] },
	};
}

function workRequest(
	id: string,
	cost = 3,
): AgentTaskAuthoringRequest<typeof WorkSchema> {
	return {
		...readOnlyRequest(`Do ${id}`, cost),
		agent: "implementer",
		outputSchema: WorkSchema,
	};
}

/** A worktree producer, so a review subject can carry a real handoff handle. */
function worktreeRequest(): AgentTaskAuthoringRequest<
	typeof WorkSchema,
	{ readonly mode: "worktree"; readonly cwd: string }
> {
	return {
		...workRequest("implement"),
		workspace: { mode: "worktree", cwd: "/repo" },
		limits: { ...limits(), workspaceWriteBytes: 2 * 1024 * 1024 * 1024 },
	};
}

type Outcome = SettledTaskResult<unknown>;

interface Harness {
	readonly ctx: WorkflowContext<unknown>;
	readonly logs: readonly string[];
	/** Closes the final epoch and returns every `task-declared` event. */
	finish(final: readonly TaskHandle<unknown>[]): readonly WorkflowEventInput[];
}

/**
 * A context whose declarations go through the real `WorkflowTaskMaterializer`
 * exactly as `src/static-runtime.ts` lowers them, with scripted barrier
 * outcomes. Same run id and same digests in every harness, so two runs that
 * declare the same graph produce byte-identical events and identities.
 */
function harness(settled: readonly Outcome[] = []): Harness {
	const materializer = new WorkflowTaskMaterializer({
		runId: RUN_ID,
		definitionIdentitySha256: DEFINITION_IDENTITY,
		inputSha256: INPUT_DIGEST,
	});
	const logs: string[] = [];
	const events: WorkflowEventInput[] = [];
	const ctx = {
		input: {},
		runId: RUN_ID,
		cwd: "/repo",
		signal: new AbortController().signal,
		phase() {},
		log(message: string) {
			logs.push(message);
		},
		agent(key: string, request: AgentTaskAuthoringRequest<typeof WorkSchema>) {
			return materializer.agent(key, request);
		},
		fanOut(
			namespace: string,
			items: readonly unknown[],
			options: {
				key: (item: unknown, index: number) => string;
				task: (
					item: unknown,
					index: number,
				) => AgentTaskAuthoringRequest<typeof WorkSchema>;
			},
		) {
			return Object.freeze(
				items.map((item, index) =>
					materializer.agentInNamespace(
						[namespace],
						options.key(item, index),
						options.task(item, index),
					),
				),
			);
		},
		fanIn(
			key: string,
			sources: readonly TaskHandle<unknown>[],
			options: {
				inputKey: (source: TaskHandle<unknown>, index: number) => string;
				task: AgentTaskAuthoringRequest<typeof WorkSchema>;
			},
		) {
			if (Object.hasOwn(options.task, "inputs")) {
				throw new Error("Workflow fan-in options are invalid.");
			}
			return materializer.agent(key, {
				...options.task,
				inputs: Object.fromEntries(
					sources.map((source, index) => [
						options.inputKey(source, index),
						source.output,
					]),
				),
			});
		},
		async settled(tasks: readonly TaskHandle<unknown>[]) {
			events.push(...materializer.closeEpoch("settled", tasks).events);
			return tasks.map(
				(_task, index) =>
					settled[index] ?? {
						status: "fulfilled" as const,
						value: { verdict: "approve", findings: [] },
					},
			);
		},
	} as unknown as WorkflowContext<unknown>;
	return {
		ctx,
		logs,
		finish(final) {
			events.push(...materializer.closeEpoch("final", final).events);
			return events.filter((event) => event.type === "task-declared");
		},
	};
}

function rejected(message: string): Outcome {
	return {
		status: "rejected",
		taskId: "task_unused",
		outcome: "failed",
		failure: { message },
	};
}

function fulfilled(value: unknown): Outcome {
	return { status: "fulfilled", value };
}

function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		id: "missing-test",
		severity: "major",
		kind: "gap",
		where: "/deliverables/0",
		what: "The change has no test.",
		...overrides,
	};
}

describe("forEach", () => {
	const items = [
		{ id: "alpha", title: "Alpha" },
		{ id: "beta", title: "Beta" },
		{ id: "gamma", title: "Gamma" },
	] as const;

	it("lowers to the hand-written ctx.fanOut byte for byte", () => {
		const component = harness();
		const lowered = forEach(component.ctx, "work", items, {
			idOf: (item) => item.id,
			task: (item) => workRequest(item.id),
		});
		const hand = harness();
		const written = hand.ctx.fanOut("work", items, {
			key: (item) => item.id,
			task: (item) => workRequest(item.id),
		});
		expect(lowered).toHaveLength(3);
		expect(JSON.stringify(component.finish(lowered))).toBe(
			JSON.stringify(hand.finish(written)),
		);
	});

	it("keys a task from its stable id, not from its position", () => {
		const straight = harness();
		const forward = forEach(straight.ctx, "work", items, {
			idOf: (item) => item.id,
			task: (item) => workRequest(item.id),
		});
		const reversed = harness();
		const backward = forEach(reversed.ctx, "work", [...items].reverse(), {
			idOf: (item) => item.id,
			task: (item) => workRequest(item.id),
		});
		const byId = (
			handles: readonly TaskHandle<unknown>[],
			order: readonly { id: string }[],
		) =>
			Object.fromEntries(
				order.map((item, index) => [
					item.id,
					handles[index]?.ref.taskId as string,
				]),
			);
		expect(byId(backward, [...items].reverse())).toEqual(byId(forward, items));
	});

	it("declares identically across materializations", () => {
		const first = harness();
		const second = harness();
		const declare = (h: Harness) =>
			h.finish(
				forEach(h.ctx, "work", items, {
					idOf: (item) => item.id,
					task: (item) => workRequest(item.id),
				}),
			);
		expect(JSON.stringify(declare(first))).toBe(
			JSON.stringify(declare(second)),
		);
	});

	it("declares nothing for an empty item list", () => {
		const empty = harness();
		expect(
			forEach(empty.ctx, "work", [] as readonly { id: string }[], {
				idOf: (item) => item.id,
				task: (item) => workRequest(item.id),
			}),
		).toEqual([]);
	});

	it("applies a default disposition and keeps an explicit one", () => {
		const h = harness();
		const handles = forEach(h.ctx, "work", items, {
			idOf: (item) => item.id,
			disposition: "optional",
			task: (item) =>
				item.id === "beta"
					? { ...workRequest(item.id), disposition: "required" as const }
					: workRequest(item.id),
		});
		const declared = h
			.finish(handles)
			.map((event) =>
				event.type === "task-declared" && event.data.task.spec.kind === "agent"
					? [event.data.task.spec.key, event.data.task.spec.disposition]
					: [],
			);
		expect(declared).toEqual([
			["alpha", "optional"],
			["beta", "required"],
			["gamma", "optional"],
		]);
	});

	it("refuses more than 64 items", () => {
		const h = harness();
		const many = Array.from({ length: MAX_FOR_EACH_ITEMS + 1 }, (_v, i) => ({
			id: `item-${i}`,
		}));
		expect(() =>
			forEach(h.ctx, "work", many, {
				idOf: (item) => item.id,
				task: (item) => workRequest(item.id),
			}),
		).toThrow(
			'forEach("work") declares 65 items; a fan-out admits at most 64.',
		);
	});

	it("refuses a duplicate id", () => {
		const h = harness();
		expect(() =>
			forEach(h.ctx, "work", [{ id: "alpha" }, { id: "alpha" }], {
				idOf: (item) => item.id,
				task: (item) => workRequest(item.id),
			}),
		).toThrow(
			'forEach("work") got the duplicate id "alpha" for items 0 and 1; every fan-out key must be unique in its namespace.',
		);
	});

	it("refuses an id read from a field the input does not require", () => {
		const h = harness();
		expect(() =>
			forEach(
				h.ctx,
				"work",
				[{ id: "alpha", optional: undefined as string | undefined }],
				{
					idOf: (item) => item.optional as string,
					task: (item) => workRequest(item.id),
				},
			),
		).toThrow(/forEach\("work"\) got the invalid id undefined for item 0/u);
	});

	it("refuses an id that is not a task key", () => {
		const h = harness();
		expect(() =>
			forEach(h.ctx, "work", [{ id: "Alpha" }], {
				idOf: (item) => item.id,
				task: (item) => workRequest(item.id),
			}),
		).toThrow(/got the invalid id "Alpha" for item 0/u);
	});

	it("refuses an unstable id", () => {
		const h = harness();
		let counter = 0;
		expect(() =>
			forEach(h.ctx, "work", [{ id: "alpha" }], {
				idOf: () => `item-${counter++}`,
				task: (item) => workRequest(item.id),
			}),
		).toThrow(
			'forEach("work") got the unstable id "item-0" then "item-1" for item 0; a fan-out key must be a pure function of the item.',
		);
	});

	it("refuses a projected worst case that does not fit the budget", () => {
		const h = harness();
		expect(() =>
			forEach(h.ctx, "work", items, {
				idOf: (item) => item.id,
				task: (item) => workRequest(item.id, 10),
				budget: { cost: 20, childRuntimeMs: 3_600_000 },
			}),
		).toThrow(
			'forEach("work") projects 30 cost over 3 item(s), which exceeds the run budget of 20.',
		);
		expect(() =>
			forEach(h.ctx, "work", items, {
				idOf: (item) => item.id,
				task: (item) => workRequest(item.id),
				budget: { cost: 100, totalTokens: 500_000, childRuntimeMs: 3_600_000 },
			}),
		).toThrow(/projects 1200000 total tokens over 3 item\(s\)/u);
		expect(() =>
			forEach(h.ctx, "work", items, {
				idOf: (item) => item.id,
				task: (item) => workRequest(item.id),
				budget: { cost: 100, childRuntimeMs: 1_000_000 },
			}),
		).toThrow(/projects 1800000 ms of child runtime over 3 item\(s\)/u);
	});

	it("refuses an invalid namespace", () => {
		const h = harness();
		expect(() =>
			forEach(h.ctx, "Work" as never, items, {
				idOf: (item) => item.id,
				task: (item) => workRequest(item.id),
			}),
		).toThrow('forEach namespace "Work" must match ^[a-z][a-z0-9-]*$.');
	});

	it("refuses through the library's one refusal type", () => {
		const h = harness();
		try {
			forEach(h.ctx, "work", [{ id: "alpha" }, { id: "alpha" }], {
				idOf: (item) => item.id,
				task: (item) => workRequest(item.id),
			});
			throw new Error("forEach accepted a duplicate id");
		} catch (error) {
			expect(error).toBeInstanceOf(WorkflowComponentError);
			expect((error as WorkflowComponentError).component).toBe("forEach");
		}
	});

	it("projects a fan-out budget the way the scheduler reserves one", () => {
		expect(
			projectFanOutBudget([workRequest("a", 4), workRequest("b", 6)]),
		).toEqual({ cost: 10, totalTokens: 800_000, childRuntimeMs: 1_200_000 });
	});
});

describe("reviewFanOut", () => {
	const lenses: readonly ReviewLens[] = [{ id: "contracts" }, { id: "replay" }];
	const subject = { title: "The handoff" };
	const review = (goal: string): ReviewTaskRequest => readOnlyRequest(goal);

	async function fanOut(
		h: Harness,
		options: {
			lenses?: readonly ReviewLens[];
			synthesis?: "required" | "optional" | "none";
			diversity?: boolean;
			synthesize?: boolean;
		} = {},
	) {
		return reviewFanOut(h.ctx, "review", options.lenses ?? lenses, {
			subject,
			model: MODEL,
			...(options.diversity === false
				? {}
				: { diversity: { model: DIVERSE_MODEL } }),
			synthesis: options.synthesis ?? "optional",
			...(options.synthesize === false
				? {}
				: {
						synthesize: () => ({
							...readOnlyRequest("Synthesize the review."),
							agent: "planner",
						}),
					}),
			review: (lens) => review(`Review through the "${lens.lens.id}" lens.`),
		});
	}

	it("lowers to the hand-written fan-out, settle, and fan-in byte for byte", async () => {
		const component = harness();
		const result = await fanOut(component);
		expect(result.synthesis).toBeDefined();
		const componentEvents = component.finish([
			result.synthesis as TaskHandle<unknown>,
		]);

		const hand = harness();
		const reviewers = hand.ctx.fanOut("review", [...lenses], {
			key: (lens) => lens.id,
			task: (lens) => ({
				...review(`Review through the "${lens.id}" lens.`),
				model: MODEL,
				outputSchema: ReviewReportSchema,
				disposition: "optional" as const,
				inputs: {},
			}),
		});
		await hand.ctx.settled(reviewers);
		const synthesis = hand.ctx.fanIn("review-synthesis", reviewers, {
			inputKey: (_source, index) => lenses[index]?.id as string,
			task: {
				...readOnlyRequest("Synthesize the review."),
				agent: "planner",
				outputSchema: ReviewSynthesisSchema,
			},
		});
		expect(JSON.stringify(componentEvents)).toBe(
			JSON.stringify(hand.finish([synthesis])),
		);
	});

	it("keys a lens by its id and de-duplicates by declaration ordinal", () => {
		expect(
			resolveReviewKeys("review", [
				{ id: "contracts" },
				{ id: "replay" },
				{ id: "contracts" },
				{ id: "contracts" },
			]),
		).toEqual(["contracts", "replay", "contracts-2", "contracts-3"]);
	});

	it("keeps every key when the lens list is reordered", () => {
		const first = resolveReviewKeys("review", [
			{ id: "contracts" },
			{ id: "replay" },
			{ id: "contracts" },
		]);
		const second = resolveReviewKeys("review", [
			{ id: "replay" },
			{ id: "contracts" },
			{ id: "contracts" },
		]);
		expect(first).toEqual(["contracts", "replay", "contracts-2"]);
		expect(second).toEqual(["replay", "contracts", "contracts-2"]);
		expect([...first].sort()).toEqual([...second].sort());
	});

	it("refuses a de-duplicated key that another lens claims", () => {
		expect(() =>
			resolveReviewKeys("review", [
				{ id: "contracts" },
				{ id: "contracts" },
				{ id: "contracts-2" },
			]),
		).toThrow(
			/de-duplicates to "contracts-2", which another lens already claims/u,
		);
	});

	it("carries the reviewed subject to every lens as inputs", async () => {
		const h = harness();
		const producer = h.ctx.agent("implement", worktreeRequest());
		const result = await reviewFanOut(h.ctx, "review", lenses, {
			subject: {
				title: "The handoff",
				inputs: {
					summary: producer.output,
					handoff: producer.handoff,
				},
			},
			model: MODEL,
			synthesis: "none",
			review: () => review("Review the handoff."),
		});
		expect(result.coverage.map((entry) => entry.lens)).toEqual([
			"contracts",
			"replay",
		]);
		const declared = h
			.finish([])
			.flatMap((event) =>
				event.type === "task-declared" && event.data.task.spec.kind === "agent"
					? [
							[
								event.data.task.spec.key,
								Object.keys(event.data.task.spec.inputs).sort(),
							],
						]
					: [],
			);
		expect(declared).toEqual([
			["implement", []],
			["contracts", ["handoff", "summary"]],
			["replay", ["handoff", "summary"]],
		]);
	});

	it("resolves diversity by pin, then seam, then the caller's default", async () => {
		const h = harness();
		const result = await reviewFanOut(
			h.ctx,
			"review",
			[
				{ id: "plain" },
				{ id: "diverse", diverse: true },
				{
					id: "pinned",
					diverse: true,
					model: { provider: "anthropic", id: "opus", thinking: "high" },
				},
			],
			{
				subject,
				model: MODEL,
				diversity: { model: DIVERSE_MODEL },
				synthesis: "none",
				review: () => review("Review it."),
			},
		);
		expect(result.lenses.map((lens) => lens.model?.id)).toEqual([
			MODEL.id,
			DIVERSE_MODEL.id,
			"opus",
		]);
		expect(result.lenses.map((lens) => lens.diverseStandIn)).toEqual([
			false,
			true,
			false,
		]);
		// Exactly one disclosure, and it says the answer is a stand-in.
		expect(h.logs).toHaveLength(1);
		expect(h.logs[0]).toMatch(/stand-in; model routing is not installed yet/u);
	});

	it("refuses a diverse lens with no routing seam", async () => {
		const h = harness();
		await expect(
			reviewFanOut(h.ctx, "review", [{ id: "diverse", diverse: true }], {
				subject,
				model: MODEL,
				synthesis: "none",
				review: () => review("Review it."),
			}),
		).rejects.toThrow(
			'reviewFanOut("review") lens "diverse" asks for another model family, but no diverse model is configured; pin an exact `model` on the lens or pass `diversity`.',
		);
	});

	it("refuses through the library's one refusal type", async () => {
		const h = harness();
		const error = await fanOut(h, { lenses: [{ id: "Contracts" }] }).catch(
			(reason: unknown) => reason,
		);
		expect(error).toBeInstanceOf(WorkflowComponentError);
		expect((error as WorkflowComponentError).component).toBe("reviewFanOut");
		expect((error as Error).message).toMatch(
			/got the invalid lens id "Contracts" at ordinal 0/u,
		);
	});

	it("refuses more than 16 lenses", async () => {
		const h = harness();
		await expect(
			fanOut(h, {
				lenses: Array.from({ length: MAX_REVIEW_LENSES + 1 }, (_v, i) => ({
					id: `lens-${i}`,
				})),
			}),
		).rejects.toThrow(
			'reviewFanOut("review") declares 17 lenses; at most 16 are allowed.',
		);
	});

	it("refuses a reviewer that is not read-only", async () => {
		const h = harness();
		await expect(
			reviewFanOut(h.ctx, "review", lenses, {
				subject,
				model: MODEL,
				synthesis: "none",
				review: () => ({
					...readOnlyRequest("Review it."),
					workspace: { mode: "worktree" as const, cwd: "/repo" },
				}),
			}),
		).rejects.toThrow(
			'reviewFanOut("review") lens "contracts" must review read-only; declare { mode: "read-only", cwd }.',
		);
	});

	it("refuses a reviewer input that shadows the subject", async () => {
		const h = harness();
		const producer = h.ctx.agent("implement", worktreeRequest());
		await expect(
			reviewFanOut(h.ctx, "review", lenses, {
				subject: { title: "s", inputs: { summary: producer.output } },
				model: MODEL,
				synthesis: "none",
				review: () => ({
					...readOnlyRequest("Review it."),
					inputs: { summary: producer.output },
				}),
			}),
		).rejects.toThrow(
			/lens "contracts" declares the input "summary", which the reviewed subject already provides/u,
		);
	});

	it("refuses a synthesis with no synthesize function", async () => {
		const h = harness();
		await expect(fanOut(h, { synthesize: false })).rejects.toThrow(
			'reviewFanOut("review") asks for a optional synthesis but declares no `synthesize` function.',
		);
	});

	it("declares no reducer when synthesis is none", async () => {
		const h = harness();
		const result = await fanOut(h, { synthesis: "none" });
		expect(result.synthesis).toBeUndefined();
		const keys = h
			.finish([])
			.flatMap((event) =>
				event.type === "task-declared" ? [event.data.task.spec.key] : [],
			);
		expect(keys).toEqual(["contracts", "replay"]);
	});

	it("degrades through settled results when a reviewer fails", async () => {
		const h = harness([
			fulfilled({
				verdict: "request-changes",
				findings: [finding({ severity: "blocking" })],
			}),
			rejected("reviewer died"),
			fulfilled({ verdict: "approve", findings: [] }),
		]);
		const result = await fanOut(h, {
			lenses: [{ id: "contracts" }, { id: "replay" }, { id: "budget" }],
		});
		expect(result.coverage).toEqual([
			{ lens: "contracts", reported: true, verdict: "request-changes" },
			{ lens: "replay", reported: false },
			{ lens: "budget", reported: true, verdict: "approve" },
		]);
		expect(result.reviews[1]?.failure?.message).toBe("reviewer died");
		expect(result.verdict).toBe("request-changes");
		expect(result.findings).toHaveLength(1);
		// The reducer depends only on the lenses that reported: a data dependency
		// on the failed one would block it instead of informing it.
		const synthesis = h
			.finish([result.synthesis as TaskHandle<unknown>])
			.flatMap((event) =>
				event.type === "task-declared" &&
				event.data.task.spec.key === "review-synthesis" &&
				event.data.task.spec.kind === "agent"
					? [Object.keys(event.data.task.spec.inputs).sort()]
					: [],
			);
		expect(synthesis).toEqual([["budget", "contracts"]]);
	});

	it("declares no reducer for an optional synthesis nobody reported to", async () => {
		const h = harness([rejected("one"), rejected("two")]);
		const result = await fanOut(h);
		expect(result.synthesis).toBeUndefined();
		expect(result.verdict).toBe("approve");
		expect(result.coverage.every((entry) => !entry.reported)).toBe(true);
	});

	it("fails a required synthesis nobody reported to", async () => {
		const h = harness([rejected("one"), rejected("two")]);
		await expect(fanOut(h, { synthesis: "required" })).rejects.toThrow(
			'reviewFanOut("review") requires a synthesis, but no lens reported.',
		);
	});
});

describe("findings", () => {
	it("orders severity blocking, major, minor", () => {
		expect([...FINDING_SEVERITIES]).toEqual(["blocking", "major", "minor"]);
		expect(findingSeverityRank("blocking")).toBeLessThan(
			findingSeverityRank("major"),
		);
		expect(findingSeverityRank("major")).toBeLessThan(
			findingSeverityRank("minor"),
		);
	});

	it("collapses the same finding and keeps its most severe report", () => {
		const merged = dedupeFindings([
			{
				lens: "replay",
				ordinal: 1,
				finding: finding({ severity: "minor", what: "The change has no test" }),
			},
			{
				lens: "contracts",
				ordinal: 0,
				finding: finding({ severity: "blocking" }),
			},
			{
				lens: "budget",
				ordinal: 2,
				finding: finding({ id: "slow", where: "/deliverables/1" }),
			},
		]);
		expect(merged.map((entry) => [entry.id, entry.severity])).toEqual([
			["missing-test", "blocking"],
			["slow", "major"],
		]);
	});

	it("makes surviving ids unique by output order", () => {
		const merged = dedupeFindings([
			{ lens: "a", ordinal: 0, finding: finding({ where: "/a" }) },
			{ lens: "b", ordinal: 1, finding: finding({ where: "/b" }) },
			{ lens: "c", ordinal: 2, finding: finding({ where: "/c" }) },
		]);
		expect(merged.map((entry) => entry.id)).toEqual([
			"missing-test",
			"missing-test-2",
			"missing-test-3",
		]);
	});

	it("keeps at most the cap, dropping the least severe tail", () => {
		const many = Array.from({ length: MAX_FINDINGS + 4 }, (_v, index) => ({
			lens: "a",
			ordinal: index,
			finding: finding({
				severity: index === 0 ? ("blocking" as const) : ("minor" as const),
				where: `/deliverables/${index}`,
			}),
		}));
		const merged = dedupeFindings(many);
		expect(merged).toHaveLength(MAX_FINDINGS);
		expect(merged[0]?.severity).toBe("blocking");
		expect(dedupeFindings(many, { max: 2 })).toHaveLength(2);
	});

	it("asks for changes on a blocking finding even when the lens approved", () => {
		expect(
			mergeReviewReports([
				{
					lens: "contracts",
					ordinal: 0,
					report: {
						verdict: "approve",
						findings: [finding({ severity: "blocking" })],
					},
				},
			]).verdict,
		).toBe("request-changes");
		expect(mergeReviewReports([]).verdict).toBe("approve");
		expect(
			mergeReviewReports([
				{
					lens: "contracts",
					ordinal: 0,
					report: { verdict: "request-changes", findings: [] },
				},
			]).verdict,
		).toBe("request-changes");
	});

	it("is pure: no mutation, frozen results, identical answers", () => {
		const input = [
			{ lens: "a", ordinal: 0, finding: finding() },
			{ lens: "b", ordinal: 1, finding: finding({ severity: "blocking" }) },
		];
		const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
		const first = dedupeFindings(input);
		const second = dedupeFindings(input);
		expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
		expect(first).toEqual(second);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first[0])).toBe(true);
		expect(Object.isFrozen(FINDING_SEVERITIES)).toBe(true);
	});
});

describe("component purity", () => {
	it("keeps no state between calls", async () => {
		const items = [{ id: "alpha" }, { id: "beta" }] as const;
		const first = harness();
		const second = harness();
		const declare = (h: Harness) =>
			JSON.stringify(
				h.finish(
					forEach(h.ctx, "work", items, {
						idOf: (item) => item.id,
						task: (item) => workRequest(item.id),
					}),
				),
			);
		// Interleaved: the second harness declares before the first finishes.
		const secondEvents = declare(second);
		expect(declare(first)).toBe(secondEvents);
	});

	it("does not mutate the lens list or the requests it is given", async () => {
		const h = harness();
		const given: ReviewLens[] = [{ id: "contracts" }, { id: "contracts" }];
		const snapshot = JSON.parse(JSON.stringify(given)) as unknown;
		const request = readOnlyRequest("Review it.");
		const result = await reviewFanOut(h.ctx, "review", given, {
			subject: { title: "s" },
			model: MODEL,
			synthesis: "none",
			review: () => request,
		});
		expect(JSON.parse(JSON.stringify(given))).toEqual(snapshot);
		expect(Object.hasOwn(request, "outputSchema")).toBe(false);
		expect(Object.hasOwn(request, "disposition")).toBe(false);
		expect(result.lenses.map((lens) => lens.key)).toEqual([
			"contracts",
			"contracts-2",
		]);
		expect(Object.isFrozen(result)).toBe(true);
	});
});
