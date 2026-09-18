// `modelRole` and the routing port (spec 2.5).
//
// The load-bearing claim is that routing happens BEFORE hashing: a declaration
// that asked for a role and one that named the model the router picked are the
// same task, byte for byte and identity for identity. Everything else here
// guards that claim — mutual exclusion, the replay re-use that stops a
// host-dependent resolution from re-rolling mid-run, the two fixed refusals,
// and the `max` -> `xhigh` mapping onto pi-subagent's shorter ladder.

import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AgentTaskSpec } from "../src/contracts.js";
import type { WorkflowEventInput } from "../src/events.js";
import {
	WorkflowMaterializationError,
	WorkflowTaskMaterializer,
} from "../src/materializer.js";
import type { WorkflowJournalEvent } from "../src/persistence/journal.js";
import { reduceWorkflowEvents } from "../src/reducer.js";
import {
	exactModelRequest,
	exactThinkingLevel,
	MODEL_ROLE_EXCLUSIVE_MESSAGE,
	MODEL_ROLE_THINKING_LEVELS,
	MODEL_ROLE_TIERS,
	MODEL_ROUTING_MISSING_MESSAGE,
	type ModelResolution,
	type ModelRoleRequest,
	ModelRoutingError,
	type ModelRoutingPort,
	type StaticModelRoutingTable,
	staticModelRouting,
} from "../src/runtime/model-routing.js";

const definitionIdentitySha256 = "a".repeat(64);
const inputSha256 = "b".repeat(64);
const runId = "workflow_modelrole";

const TABLE: StaticModelRoutingTable = {
	provider: "github-copilot",
	id: "gpt-5.6-sol",
	otherFamily: { provider: "github-copilot", id: "gpt-5.6-luna" },
	thinking: { light: "low", standard: "medium", heavy: "high" },
	defaultThinking: "medium",
};

const HEAVY_ROLE: ModelRoleRequest = { persona: "code-review", tier: "heavy" };
/** What the table resolves HEAVY_ROLE to, written by hand. */
const HEAVY_MODEL = {
	provider: "github-copilot",
	id: "gpt-5.6-sol",
	thinking: "high",
} as const;

function request(overrides: Record<string, unknown> = {}) {
	return {
		agent: "researcher",
		task: {
			goal: "Answer",
			context: [],
			instructions: ["Return structured output."],
		},
		contextMode: "fresh" as const,
		tools: ["read", "grep", "find", "ls"],
		preloadSkills: [],
		contextScopes: ["project" as const],
		workspace: { mode: "read-only" as const, cwd: "/repo" },
		outputSchema: Type.Object({ answer: Type.String() }),
		limits: {
			cumulativeRuntimeMs: 300_000,
			attemptTimeoutMs: 300_000,
			totalTokens: 1_000_000,
			cost: 100,
			outputBytes: 1_048_576,
			workspaceWriteBytes: 0,
			retries: 1,
			resumes: 1,
		},
		...overrides,
	};
}

function materializer(
	options: {
		readonly modelRouting?: ModelRoutingPort;
		readonly previousState?: ReturnType<typeof reduceWorkflowEvents>;
	} = {},
): WorkflowTaskMaterializer {
	return new WorkflowTaskMaterializer({
		runId,
		definitionIdentitySha256,
		inputSha256,
		...(options.modelRouting === undefined
			? {}
			: { modelRouting: options.modelRouting }),
		...(options.previousState === undefined
			? {}
			: { previousState: options.previousState }),
	});
}

/** Declare one agent task under key `work` and close the epoch. */
function commitOne(
	modelRouting: ModelRoutingPort | undefined,
	agentRequest: ReturnType<typeof request>,
): readonly WorkflowEventInput[] {
	const runtime = materializer(
		modelRouting === undefined ? {} : { modelRouting },
	);
	const handle = runtime.agent("work", agentRequest);
	return runtime.closeEpoch("final", [handle]).events;
}

/** The one declared agent spec out of a committed epoch. */
function agentSpec(events: readonly WorkflowEventInput[]): AgentTaskSpec {
	const declaration = events.find((event) => event.type === "task-declared");
	if (declaration?.type !== "task-declared") {
		throw new Error("no task was declared");
	}
	const spec = declaration.data.task.spec;
	if (spec.kind !== "agent") throw new Error("declared task is not an agent");
	return spec;
}

function project(
	events: readonly WorkflowEventInput[],
): ReturnType<typeof reduceWorkflowEvents> {
	const all: WorkflowEventInput[] = [
		{ type: "run-created", data: { definitionIdentitySha256, inputSha256 } },
		...events,
	];
	const records: WorkflowJournalEvent[] = all.map((event, index) => ({
		schema: "pi-workflow-event",
		contractRevision: 20,
		sequence: index + 1,
		eventId: `event-${index + 1}`,
		timestamp: "2026-09-16T00:00:00.000Z",
		runId,
		ownerId: "test",
		leaseId: "lease-test",
		fencingGeneration: 1,
		type: event.type,
		data: event.data,
	}));
	return reduceWorkflowEvents(records);
}

/** A run whose first materialization routed the `work` task through the table. */
function routedRun(): ReturnType<typeof reduceWorkflowEvents> {
	return project(
		commitOne(staticModelRouting(TABLE), request({ modelRole: HEAVY_ROLE })),
	);
}

describe("mutual exclusion", () => {
	it("refuses a declaration carrying both model and modelRole", () => {
		expect(() =>
			materializer({ modelRouting: staticModelRouting(TABLE) }).agent(
				"both",
				request({ model: HEAVY_MODEL, modelRole: HEAVY_ROLE }),
			),
		).toThrow(MODEL_ROLE_EXCLUSIVE_MESSAGE);
	});

	it("refuses before the router is consulted", () => {
		// The pair is a mistake in the definition; the router's opinion of the
		// role is irrelevant and must not become the reported reason.
		const unreachable: ModelRoutingPort = {
			resolve() {
				throw new ModelRoutingError("the router should never be asked");
			},
		};
		expect(() =>
			materializer({ modelRouting: unreachable }).agent(
				"both",
				request({ model: HEAVY_MODEL, modelRole: HEAVY_ROLE }),
			),
		).toThrow(MODEL_ROLE_EXCLUSIVE_MESSAGE);
	});

	it("refuses with a WorkflowMaterializationError, like every other bad request", () => {
		expect(() =>
			materializer({ modelRouting: staticModelRouting(TABLE) }).agent(
				"both",
				request({ model: HEAVY_MODEL, modelRole: HEAVY_ROLE }),
			),
		).toThrow(WorkflowMaterializationError);
	});
});

describe("resolution before hashing", () => {
	it("produces the identity of the hand-written exact model", () => {
		// THE claim: `modelRole` is an authoring convenience, never an identity
		// event. Two definitions that differ only in how they asked for a model,
		// and that resolve alike, are the same task.
		const routed = agentSpec(
			commitOne(staticModelRouting(TABLE), request({ modelRole: HEAVY_ROLE })),
		);
		const exact = agentSpec(
			commitOne(undefined, request({ model: HEAVY_MODEL })),
		);
		expect(routed).toEqual(exact);
		expect(routed.identitySha256).toBe(exact.identitySha256);
	});

	it("leaves the materialized request with no trace of the role", () => {
		// `AgentTaskRequestSchema` is `additionalProperties: false`, so a leaked
		// `modelRole` would fail validation rather than ride along quietly — but
		// the assertion is the contract, not the accident that enforces it.
		const routed = agentSpec(
			commitOne(staticModelRouting(TABLE), request({ modelRole: HEAVY_ROLE })),
		);
		expect(routed.request).not.toHaveProperty("modelRole");
		expect(routed.request.model).toEqual(HEAVY_MODEL);
	});

	it("follows the resolved model, not the request that produced it", () => {
		// Two tiers the table answers differently are two identities; a tier and
		// an effort that land on the same model are one.
		const heavy = agentSpec(
			commitOne(staticModelRouting(TABLE), request({ modelRole: HEAVY_ROLE })),
		);
		const light = agentSpec(
			commitOne(
				staticModelRouting(TABLE),
				request({ modelRole: { persona: "code-review", tier: "light" } }),
			),
		);
		const sameModelAnotherWay = agentSpec(
			commitOne(
				staticModelRouting(TABLE),
				request({
					modelRole: { persona: "explorer", tier: "light", effort: "high" },
				}),
			),
		);
		expect(light.identitySha256).not.toBe(heavy.identitySha256);
		expect(sameModelAnotherWay.identitySha256).toBe(heavy.identitySha256);
	});
});

describe("refusals", () => {
	it("refuses a modelRole with no routing installed, naming the way out", () => {
		expect(() =>
			materializer().agent("work", request({ modelRole: HEAVY_ROLE })),
		).toThrow(MODEL_ROUTING_MISSING_MESSAGE);
	});

	it("still accepts an exact model with no routing installed", () => {
		expect(() =>
			materializer().agent("work", request({ model: HEAVY_MODEL })),
		).not.toThrow();
	});

	it("refuses an unresolvable role, carrying the router's own reason", () => {
		expect(() =>
			materializer({
				modelRouting: staticModelRouting({
					...TABLE,
					personas: ["code-review"],
				}),
			}).agent("work", request({ modelRole: { persona: "nobody" } })),
		).toThrow(/model role "nobody" did not resolve: .*has no row for persona/);
	});

	it("refuses a router that answers with something that is not a model", () => {
		const bogus: ModelRoutingPort = {
			resolve: () =>
				({
					provider: "",
					id: "",
					thinking: "louder",
				}) as unknown as ModelResolution,
		};
		expect(() =>
			materializer({ modelRouting: bogus }).agent(
				"work",
				request({ modelRole: HEAVY_ROLE }),
			),
		).toThrow(/did not resolve to a model; declare an exact model\./);
	});

	it('refuses a family: "other" request a table cannot answer', () => {
		const { otherFamily: _none, ...noOther } = TABLE;
		expect(() =>
			materializer({ modelRouting: staticModelRouting(noOther) }).agent(
				"work",
				request({
					modelRole: { persona: "code-review", family: "other" },
				}),
			),
		).toThrow(/no other-family row/);
	});
});

describe("replay", () => {
	it("re-uses the stored resolution instead of re-resolving", () => {
		// The host rerouted between the two materializations. Replay must not
		// notice: re-resolving a host-dependent pick would change task identity
		// mid-run, which is exactly what the persisted path cannot absorb.
		const previousState = routedRun();
		let asked = 0;
		const rerouting: ModelRoutingPort = {
			resolve(): ModelResolution {
				asked += 1;
				return {
					provider: "somewhere-else",
					id: "another-model",
					thinking: "low",
					source: "tier",
				};
			},
		};
		const runtime = materializer({ modelRouting: rerouting, previousState });
		const handle = runtime.agent("work", request({ modelRole: HEAVY_ROLE }));
		expect(asked).toBe(0);
		const persisted = Object.values(previousState.tasks)[0];
		expect(handle.ref.taskId).toBe(persisted?.task.id);
	});

	it("re-uses it even when the replaying host has no router at all", () => {
		// A resume on a host with no routing must not fail a task whose model was
		// decided and persisted long ago.
		const previousState = routedRun();
		expect(() =>
			materializer({ previousState }).agent(
				"work",
				request({ modelRole: HEAVY_ROLE }),
			),
		).not.toThrow();
	});

	it("fails by name when the stored model is no longer authorized", () => {
		// Revalidating authorization is the ONE thing replay re-asks. A model the
		// host has lost fails the task visibly rather than silently rerouting.
		const previousState = routedRun();
		const revoked: ModelRoutingPort = {
			resolve() {
				throw new ModelRoutingError("the router should never be asked");
			},
			authorized: () => false,
		};
		expect(() =>
			materializer({ modelRouting: revoked, previousState }).agent(
				"work",
				request({ modelRole: HEAVY_ROLE }),
			),
		).toThrow(
			/model github-copilot\/gpt-5\.6-sol stored for role "code-review" is no longer authorized/,
		);
	});
});

describe("thinking mapping", () => {
	it("maps max onto pi-subagent's xhigh and passes everything else through", () => {
		// pi-maestro's ladder has seven rungs; pi-subagent's has six.
		expect(exactThinkingLevel("max")).toBe("xhigh");
		for (const level of MODEL_ROLE_THINKING_LEVELS) {
			if (level === "max") continue;
			expect(exactThinkingLevel(level)).toBe(level);
		}
	});

	it("lowers a max resolution to xhigh in the materialized request", () => {
		const maxed: ModelRoutingPort = {
			resolve: () => ({
				provider: "p",
				id: "m",
				thinking: "max",
				source: "tier",
			}),
		};
		expect(
			agentSpec(commitOne(maxed, request({ modelRole: HEAVY_ROLE }))).request
				.model,
		).toEqual({ provider: "p", id: "m", thinking: "xhigh" });
	});

	it("drops everything but the three identity-bearing fields", () => {
		// Evidence must not enter the hash: two hosts that agree on the model but
		// disagree about why would otherwise produce two identities for one task.
		expect(
			exactModelRequest({
				provider: "p",
				id: "m",
				thinking: "max",
				source: "fallback",
				persona: "code-review",
				tier: "heavy",
				family: "OpenAI",
				alias: "Sol",
				fallbackReason: "every heavy alias was unavailable",
			}),
		).toEqual({ provider: "p", id: "m", thinking: "xhigh" });
	});
});

describe("the static table port", () => {
	const port = staticModelRouting(TABLE);

	it("answers every tier from the table and reports that it is a stand-in", () => {
		for (const tier of MODEL_ROLE_TIERS) {
			const resolution = port.resolve({ persona: "code-review", tier });
			expect(resolution).toMatchObject({
				provider: TABLE.provider,
				id: TABLE.id,
				thinking: TABLE.thinking[tier],
				source: "static",
				tier,
			});
			// A table that answers every tier with one model must never read as a
			// tier walk that happened to agree.
			expect(resolution.fallbackReason).toContain("constant table");
		}
	});

	it("uses the default thinking level when no tier is named", () => {
		expect(port.resolve({ persona: "code-review" }).thinking).toBe(
			TABLE.defaultThinking,
		);
	});

	it("lets an explicit effort outrank the tier column", () => {
		expect(
			port.resolve({ persona: "code-review", tier: "light", effort: "max" })
				.thinking,
		).toBe("max");
	});

	it('answers family: "other" from its own row', () => {
		expect(
			port.resolve({ persona: "code-review", family: "other" }),
		).toMatchObject({ provider: "github-copilot", id: "gpt-5.6-luna" });
		expect(port.resolve({ persona: "code-review", family: "same" }).id).toBe(
			TABLE.id,
		);
	});

	it("is pure: the same role always resolves to the same model", () => {
		expect(port.resolve(HEAVY_ROLE)).toEqual(port.resolve(HEAVY_ROLE));
	});

	it("bounds itself to the personas it was given", () => {
		const bounded = staticModelRouting({ ...TABLE, personas: ["code-review"] });
		expect(() => bounded.resolve({ persona: "explorer" })).toThrow(
			ModelRoutingError,
		);
	});

	it("identifies itself for run evidence and authorizes its own models", () => {
		expect(port.id).toBe("static-table");
		expect(port.authorized?.({ provider: TABLE.provider, id: TABLE.id })).toBe(
			true,
		);
	});
});
