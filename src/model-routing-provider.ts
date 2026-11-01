import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
	isModelResolution,
	type ModelResolution,
	type ModelRoleRequest,
	ModelRoutingError,
	type ModelRoutingPort,
} from "./runtime/model-routing.js";

/**
 * The model-routing provider: how a host hands this runtime its router over
 * Pi's event bus, so the package that owns routing and the package that owns
 * workflows never import each other.
 *
 * The protocol is pi-subagent's session-model provider, verbatim in shape: one
 * request channel, a request that carries a `respond` callback, and a
 * synchronous emit-and-collect. Zero answers is no router; more than one is a
 * host misconfiguration this runtime refuses rather than picks from.
 *
 * pi-workflow owns this channel and its schema string. A router package
 * registers against it; nothing here names one.
 */
const MODEL_ROUTING_REQUEST_CHANNEL =
	"@vegardx/pi-workflow/model-routing-provider/request/v1";

type ModelRoutingRequest = {
	schema: "pi-workflow-model-routing-request-v1";
	respond(port: ModelRoutingPort | undefined): void;
};

export class ModelRoutingProviderError extends Error {
	constructor(
		readonly code: "duplicate" | "invalid",
		message: string,
	) {
		super(message);
		this.name = "ModelRoutingProviderError";
	}
}

function isModelRoutingRequest(value: unknown): value is ModelRoutingRequest {
	if (typeof value !== "object" || value === null) return false;
	const request = value as Partial<ModelRoutingRequest>;
	return (
		request.schema === "pi-workflow-model-routing-request-v1" &&
		typeof request.respond === "function"
	);
}

function collect(events: EventBus): Array<ModelRoutingPort | undefined> {
	const answers: Array<ModelRoutingPort | undefined> = [];
	const request: ModelRoutingRequest = {
		schema: "pi-workflow-model-routing-request-v1",
		respond(port) {
			answers.push(port);
		},
	};
	events.emit(MODEL_ROUTING_REQUEST_CHANNEL, request);
	return answers;
}

/**
 * A port carries functions, so no schema can check it: this is the structural
 * check a schema would have made. `id` keeps the run record's own bound.
 */
function isModelRoutingPort(value: unknown): value is ModelRoutingPort {
	if (typeof value !== "object" || value === null) return false;
	const port = value as Partial<Record<keyof ModelRoutingPort, unknown>>;
	return (
		typeof port.resolve === "function" &&
		(port.authorized === undefined || typeof port.authorized === "function") &&
		(port.id === undefined ||
			(typeof port.id === "string" &&
				port.id.length > 0 &&
				port.id.length <= 128))
	);
}

/**
 * The host's port, with every answer checked. A resolution that does not
 * satisfy the contract, or a router that throws something other than a
 * `ModelRoutingError`, becomes a named `ModelRoutingError` whose message is
 * ours: what a foreign router threw may carry paths or credentials, and the
 * materializer records the message as failure evidence.
 */
function checkedPort(port: ModelRoutingPort): ModelRoutingPort {
	const resolve = (role: ModelRoleRequest): ModelResolution => {
		let resolution: unknown;
		try {
			resolution = port.resolve(role);
		} catch (error) {
			if (error instanceof ModelRoutingError) throw error;
			throw new ModelRoutingError(
				`the model routing provider failed to resolve persona ${JSON.stringify(role.persona)}`,
			);
		}
		if (!isModelResolution(resolution)) {
			throw new ModelRoutingError(
				`the model routing provider answered persona ${JSON.stringify(role.persona)} with a resolution that violates the contract`,
			);
		}
		return resolution;
	};
	const authorized = port.authorized;
	return Object.freeze({
		resolve,
		...(authorized === undefined
			? {}
			: {
					authorized: (model: Parameters<typeof authorized>[0]) =>
						authorized.call(port, model) === true,
				}),
		...(port.id === undefined ? {} : { id: port.id }),
	});
}

/**
 * Register the one router this host answers `modelRole` declarations with.
 * Returns the unregistration handle. A second registration is refused: two
 * routers would make which model a run gets depend on listener order.
 */
export function registerModelRoutingProvider(
	events: EventBus,
	port: ModelRoutingPort,
): () => void {
	if (collect(events).length !== 0) {
		throw new ModelRoutingProviderError(
			"duplicate",
			"A pi-workflow model routing provider is already registered.",
		);
	}
	return events.on(MODEL_ROUTING_REQUEST_CHANNEL, (value) => {
		if (!isModelRoutingRequest(value)) return;
		value.respond(port);
	});
}

/**
 * The host's router, checked and wrapped, or `undefined` when no host has
 * registered one or the registered provider has none to give. Fails closed on
 * a duplicate registration or a port that does not satisfy the contract
 * rather than routing through something no host stands behind.
 */
export function resolveModelRouting(
	events: EventBus,
): ModelRoutingPort | undefined {
	const answers = collect(events);
	if (answers.length === 0) return undefined;
	if (answers.length !== 1) {
		throw new ModelRoutingProviderError(
			"duplicate",
			`Expected one pi-workflow model routing provider, received ${answers.length}.`,
		);
	}
	const port = answers[0];
	if (port === undefined) return undefined;
	if (!isModelRoutingPort(port)) {
		throw new ModelRoutingProviderError(
			"invalid",
			"The registered pi-workflow model routing provider answered with a port that violates the contract.",
		);
	}
	return checkedPort(port);
}
