import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { envelope, WORKSPACE_WRITE_BYTES } from "../src/components/envelope.js";
import { WorkflowComponentError } from "../src/components/errors.js";
import {
	CheckReportSchema,
	type VerifyContext,
	type VerifyHandoffOptions,
	verifyHandoff,
} from "../src/components/verify.js";
import type { TaskKey, WorkflowBudget } from "../src/contracts-core.js";
import type {
	AgentTaskAuthoringRequest,
	TaskHandle,
	WorktreeTaskHandle,
} from "../src/definition.js";
import type { WorkflowEventInput } from "../src/events.js";
import { WorkflowTaskMaterializer } from "../src/materializer.js";

// `verifyHandoff` verifies and never fixes: one verifier at the hand-off,
// declared without a barrier. The lowering assertions drive the REAL
// materializer: what the component declares must be byte-identical to the
// hand-written `ctx.agent` it claims to be, task identity included.

const RUN_ID = "workflow_components";
const DEFINITION_IDENTITY = "a".repeat(64);
const INPUT_DIGEST = "b".repeat(64);
const MODEL = envelope("implement").model;
const SESSION_MODEL = {
	provider: "anthropic",
	id: "claude-session",
	thinking: "high",
} as const;

const ImplementationSchema = Type.Object(
	{ summary: Type.String() },
	{ additionalProperties: false },
);

function implementRequest(): AgentTaskAuthoringRequest<
	typeof ImplementationSchema,
	{ readonly mode: "worktree"; readonly cwd: string }
> {
	return {
		agent: "implementer",
		task: {
			goal: "Implement the deliverable",
			context: [],
			instructions: ["Leave the change in the working tree."],
		},
		contextMode: "fresh",
		tools: ["read", "edit", "write", "bash"],
		preloadSkills: [],
		contextScopes: ["project"],
		workspace: { mode: "worktree", cwd: "/repo" },
		handoff: "required",
		outputSchema: ImplementationSchema,
		limits: envelope("implement").limits,
		model: MODEL,
	};
}

function verifyRequest() {
	return {
		agent: "verifier",
		task: {
			goal: "Run `npm run check` over the patch",
			context: [],
			instructions: [
				"The workspace starts at the `patch` hand-off; run the check.",
				"Report the check truthfully; `checkRan` is true only if it completed.",
			],
		},
		contextMode: "fresh" as const,
		tools: ["read", "grep", "find", "ls", "bash"],
		preloadSkills: [],
		contextScopes: ["project" as const],
		workspace: { mode: "worktree" as const, cwd: "/repo" },
		retry: { attempts: 1, on: ["backoff" as const] },
	};
}

function harness(sessionModel?: typeof SESSION_MODEL) {
	const materializer = new WorkflowTaskMaterializer({
		runId: RUN_ID,
		definitionIdentitySha256: DEFINITION_IDENTITY,
		inputSha256: INPUT_DIGEST,
		...(sessionModel === undefined ? {} : { sessionModel }),
	});
	const ctx = {
		agent(key: string, request: AgentTaskAuthoringRequest<never>) {
			return materializer.agent(key, request);
		},
	} as unknown as VerifyContext;
	const implement = materializer.agent(
		"implement",
		implementRequest(),
	) as WorktreeTaskHandle<unknown>;
	return {
		ctx,
		materializer,
		implement,
		declared(final: readonly TaskHandle<unknown>[]) {
			const events: WorkflowEventInput[] = [
				...materializer.closeEpoch("final", final).events,
			];
			return new Map(
				events.flatMap((event) =>
					event.type === "task-declared" &&
					event.data.task.spec.kind === "agent"
						? [[event.data.task.spec.key, event.data.task.spec]]
						: [],
				),
			);
		},
	};
}

function options(
	implement: WorktreeTaskHandle<unknown>,
	overrides: Partial<VerifyHandoffOptions> = {},
): VerifyHandoffOptions {
	return {
		handoff: implement,
		check: { command: "npm run check", install: "npm ci" },
		model: MODEL,
		request: verifyRequest(),
		...overrides,
	};
}

describe("verifyHandoff lowering", () => {
	it("declares one verifier at the hand-off, under the caller's key, with no barrier", () => {
		const h = harness();
		const verifier = verifyHandoff(h.ctx, "check-d0", options(h.implement));
		const spec = h.declared([verifier]).get("check-d0");
		if (spec?.kind !== "agent") throw new Error("no verifier");
		expect(spec.request).toMatchObject({
			model: MODEL,
			handoff: "optional",
			workspace: { mode: "worktree", cwd: "/repo", startAtInput: "patch" },
			limits: {
				...envelope("verify").limits,
				workspaceWriteBytes: WORKSPACE_WRITE_BYTES,
			},
		});
		expect(spec.request.outputSchema).toEqual(
			JSON.parse(JSON.stringify(CheckReportSchema)),
		);
		expect(Object.keys(spec.inputs)).toEqual(["patch"]);
		expect(spec.inputs.patch?.output).toBe("handoff");
	});

	it("is the hand-written declaration, identity included", () => {
		const component = harness();
		const verifier = verifyHandoff(
			component.ctx,
			"check-d0",
			options(component.implement),
		);
		const hand = harness();
		const written = hand.materializer.agent("check-d0", {
			...verifyRequest(),
			handoff: "optional",
			workspace: { mode: "worktree", cwd: "/repo", startAtInput: "patch" },
			outputSchema: CheckReportSchema,
			model: MODEL,
			limits: {
				...envelope("verify").limits,
				workspaceWriteBytes: WORKSPACE_WRITE_BYTES,
			},
			inputs: { patch: hand.implement.handoff },
		});
		expect(component.declared([verifier]).get("check-d0")).toEqual(
			hand.declared([written]).get("check-d0"),
		);
	});

	it("keeps a read-only verifier read-only, without a write grant or handoff policy", () => {
		const h = harness();
		const verifier = verifyHandoff(
			h.ctx,
			"check-d0",
			options(h.implement, {
				request: {
					...verifyRequest(),
					workspace: { mode: "read-only", cwd: "/repo" },
				},
			}),
		);
		const spec = h.declared([verifier]).get("check-d0");
		if (spec?.kind !== "agent") throw new Error("no verifier");
		expect(spec.request.limits).toEqual(envelope("verify").limits);
		expect(Object.hasOwn(spec.request, "handoff")).toBe(false);
	});

	it("lowers `inherit` to the run's session model and refuses it without one", () => {
		const h = harness(SESSION_MODEL);
		const verifier = verifyHandoff(
			h.ctx,
			"check-d0",
			options(h.implement, { model: "inherit" }),
		);
		expect(h.declared([verifier]).get("check-d0")?.request).toMatchObject({
			model: SESSION_MODEL,
		});
		const bare = harness();
		expect(() =>
			verifyHandoff(
				bare.ctx,
				"check-d0",
				options(bare.implement, { model: "inherit" }),
			),
		).toThrow(
			/declares model: "inherit", but the run resolved no session model/,
		);
	});

	it("applies a default disposition and keeps an explicit one", () => {
		const h = harness();
		const defaulted = verifyHandoff(
			h.ctx,
			"check-a",
			options(h.implement, { disposition: "optional" }),
		);
		const explicit = verifyHandoff(
			h.ctx,
			"check-b",
			options(h.implement, {
				disposition: "optional",
				request: { ...verifyRequest(), disposition: "required" },
			}),
		);
		const declared = h.declared([defaulted, explicit]);
		expect(declared.get("check-a")?.disposition).toBe("optional");
		expect(declared.get("check-b")?.disposition).toBe("required");
	});
});

describe("verifyHandoff refusals", () => {
	function refusal(overrides: Partial<VerifyHandoffOptions>, key = "check") {
		const h = harness();
		return () =>
			verifyHandoff(h.ctx, key as TaskKey, options(h.implement, overrides));
	}

	it.each([
		["a key that is not a task key", {}, "Check", /is not a task key/],
		[
			"a blank check command",
			{ check: { command: " " } },
			"check",
			/declares no check command/,
		],
		[
			"a model that is neither exact nor inherit",
			{ model: "fast" as never },
			"check",
			/declare an exact \{provider, id, thinking\} or "inherit"/,
		],
		[
			"a request that declares its own output schema",
			{
				request: {
					...verifyRequest(),
					outputSchema: CheckReportSchema,
				} as never,
			},
			"check",
			/declares `outputSchema`, which the component owns/,
		],
		[
			"a request that declares its own limits",
			{
				request: {
					...verifyRequest(),
					limits: envelope("verify").limits,
				} as never,
			},
			"check",
			/declares `limits`, which the component owns/,
		],
		[
			"a workspace that starts elsewhere",
			{
				request: {
					...verifyRequest(),
					workspace: {
						mode: "worktree" as const,
						cwd: "/repo",
						startAtInput: "other",
					},
				},
			},
			"check",
			/starts its workspace at "other", but the component starts it at the handoff it wires as "patch"/,
		],
	])("refuses %s", (_label, overrides, key, message) => {
		const run = refusal(overrides as Partial<VerifyHandoffOptions>, key);
		expect(run).toThrow(WorkflowComponentError);
		expect(run).toThrow(message);
	});

	it("refuses a non-worktree subject", () => {
		const h = harness();
		const reader = h.materializer.agent("reader", {
			...implementRequest(),
			workspace: { mode: "read-only", cwd: "/repo" },
			handoff: undefined,
			limits: envelope("review").limits,
		} as never);
		expect(() =>
			verifyHandoff(
				h.ctx,
				"check",
				options(h.implement, { handoff: reader as never }),
			),
		).toThrow(/needs a worktree task handle/);
	});

	it("refuses an input the component wires", () => {
		const h = harness();
		expect(() =>
			verifyHandoff(
				h.ctx,
				"check",
				options(h.implement, {
					request: {
						...verifyRequest(),
						inputs: { patch: h.implement.output },
					},
				}),
			),
		).toThrow(/declares the input "patch", which the component wires/);
	});

	it("refuses a verifier the run budget cannot admit, before declaring it", () => {
		const share = envelope("verify").budgetShare;
		const budget: WorkflowBudget = {
			cost: share.cost - 1,
			totalTokens: share.totalTokens,
			childRuntimeMs: share.childRuntimeMs,
		};
		const h = harness();
		expect(() =>
			verifyHandoff(h.ctx, "check", options(h.implement, { budget })),
		).toThrow(/exceeds the run budget/);
		expect([...h.declared([h.implement]).keys()]).toEqual(["implement"]);
	});
});
