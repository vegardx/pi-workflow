import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	type ModelResolution,
	type ModelRoutingPort,
	ModelRoutingProviderError,
	registerModelRoutingProvider,
	resolveModelRouting,
} from "../src/index.js";
import { ModelRoutingError } from "../src/runtime/index.js";

/** The protocol's channel, spelled out: it is the contract, not an export. */
const MODEL_ROUTING_REQUEST_CHANNEL =
	"@vegardx/pi-workflow/model-routing-provider/request/v1";

const RESOLUTION: ModelResolution = Object.freeze({
	provider: "test-provider",
	id: "routed-model",
	thinking: "medium",
	source: "tier",
	persona: "code-review",
	tier: "normal",
	family: "alpha",
	alias: "routed",
});

function port(overrides: Partial<ModelRoutingPort> = {}): ModelRoutingPort {
	return { id: "test-router", resolve: () => RESOLUTION, ...overrides };
}

function providerError(run: () => unknown): ModelRoutingProviderError {
	try {
		run();
	} catch (error) {
		if (error instanceof ModelRoutingProviderError) return error;
		throw error;
	}
	throw new Error("expected a ModelRoutingProviderError");
}

describe("model routing provider", () => {
	it("answers nothing when no host registered a router", () => {
		expect(resolveModelRouting(createEventBus())).toBeUndefined();
	});

	it("resolves the registered port through the bus", () => {
		const events = createEventBus();
		registerModelRoutingProvider(events, port());
		const resolved = resolveModelRouting(events);
		expect(resolved?.id).toBe("test-router");
		expect(resolved?.resolve({ persona: "code-review", tier: "normal" })).toBe(
			RESOLUTION,
		);
	});

	it("unregisters through the handle it returns", () => {
		const events = createEventBus();
		const unregister = registerModelRoutingProvider(events, port());
		unregister();
		expect(resolveModelRouting(events)).toBeUndefined();
	});

	it("refuses a second registration with the duplicate code", () => {
		const events = createEventBus();
		registerModelRoutingProvider(events, port());
		const error = providerError(() =>
			registerModelRoutingProvider(events, port()),
		);
		expect(error.code).toBe("duplicate");
	});

	it("fails closed when two providers answer", () => {
		const events = createEventBus();
		registerModelRoutingProvider(events, port());
		// A second listener that bypassed the registration's own refusal.
		events.on(MODEL_ROUTING_REQUEST_CHANNEL, (request) => {
			(request as { respond(value: unknown): void }).respond(port());
		});
		const error = providerError(() => resolveModelRouting(events));
		expect(error.code).toBe("duplicate");
		expect(error.message).toBe(
			"Expected one pi-workflow model routing provider, received 2.",
		);
	});

	it("treats a provider that answers undefined as no router", () => {
		const events = createEventBus();
		events.on(MODEL_ROUTING_REQUEST_CHANNEL, (request) => {
			(request as { respond(value: unknown): void }).respond(undefined);
		});
		expect(resolveModelRouting(events)).toBeUndefined();
	});

	const answersOne = (): number => 1;
	it.each<[string, unknown]>([
		["a port with no resolve", { id: "x" }],
		["a resolve that is not a function", { resolve: "yes" }],
		[
			"an authorized that is not a function",
			{ resolve: answersOne, authorized: true },
		],
		["an empty id", { resolve: answersOne, id: "" }],
		["an id over 128 characters", { resolve: answersOne, id: "r".repeat(129) }],
		["a non-object", "router"],
	])("fails closed with the invalid code on %s", (_label, answer) => {
		const events = createEventBus();
		events.on(MODEL_ROUTING_REQUEST_CHANNEL, (request) => {
			(request as { respond(value: unknown): void }).respond(answer);
		});
		const error = providerError(() => resolveModelRouting(events));
		expect(error.code).toBe("invalid");
	});

	it("turns a resolution that violates the contract into a ModelRoutingError", () => {
		const events = createEventBus();
		registerModelRoutingProvider(
			events,
			port({
				resolve: () =>
					({ ...RESOLUTION, tier: "heavy" }) as unknown as ModelResolution,
			}),
		);
		const resolved = resolveModelRouting(events);
		expect(() => resolved?.resolve({ persona: "code-review" })).toThrow(
			ModelRoutingError,
		);
		expect(() => resolved?.resolve({ persona: "code-review" })).toThrow(
			'the model routing provider answered persona "code-review" with a resolution that violates the contract',
		);
	});

	it("replaces a foreign router error with a message of its own", () => {
		const events = createEventBus();
		registerModelRoutingProvider(
			events,
			port({
				resolve: () => {
					throw new Error("ENOENT: /home/someone/.config/router.json");
				},
			}),
		);
		const resolved = resolveModelRouting(events);
		let thrown: unknown;
		try {
			resolved?.resolve({ persona: "code-review" });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ModelRoutingError);
		expect((thrown as Error).message).toBe(
			'the model routing provider failed to resolve persona "code-review"',
		);
		expect((thrown as Error).message).not.toContain("/home");
	});

	it("passes a router's own ModelRoutingError through unchanged", () => {
		const events = createEventBus();
		registerModelRoutingProvider(
			events,
			port({
				resolve: () => {
					throw new ModelRoutingError("no allowance for persona x");
				},
			}),
		);
		expect(() =>
			resolveModelRouting(events)?.resolve({ persona: "x" }),
		).toThrow("no allowance for persona x");
	});

	it("forwards authorization to the host's port", () => {
		const events = createEventBus();
		const asked: string[] = [];
		registerModelRoutingProvider(
			events,
			port({
				authorized: (model) => {
					asked.push(`${model.provider}/${model.id}`);
					return model.id === "routed-model";
				},
			}),
		);
		const resolved = resolveModelRouting(events);
		expect(resolved?.authorized?.({ provider: "p", id: "routed-model" })).toBe(
			true,
		);
		expect(resolved?.authorized?.({ provider: "p", id: "gone" })).toBe(false);
		expect(asked).toEqual(["p/routed-model", "p/gone"]);
	});
});
