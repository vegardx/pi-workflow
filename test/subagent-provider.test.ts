import {
	createEventBus,
	type EventBus,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	SUBAGENT_RUNTIME_CONTRACT,
	type SubagentClient,
	type SubagentService,
} from "@vegardx/pi-subagent";
import { registerSubagentServiceProvider } from "@vegardx/pi-subagent/service-provider";
import { describe, expect, it, vi } from "vitest";
import {
	createWorkflowSubagentProvider,
	WorkflowSubagentProviderError,
} from "../src/subagent-provider.js";

const context = {} as ExtensionContext;

function client(): SubagentClient {
	return {
		preflight: vi.fn(),
		launch: vi.fn(),
		findByOperation: vi.fn(),
		status: vi.fn(),
		listRuns: vi.fn(),
		logs: vi.fn(),
		wait: vi.fn(),
		interrupt: vi.fn(),
		steer: vi.fn(),
		followUp: vi.fn(),
		retry: vi.fn(),
		resume: vi.fn(),
		reconcile: vi.fn(),
		release: vi.fn(),
		abandon: vi.fn(),
		pin: vi.fn(),
		unpin: vi.fn(),
		exportArtifact: vi.fn(),
	} as unknown as SubagentClient;
}

function service(ownerClient = client()): SubagentService {
	return {
		forOwner: vi.fn(() => ownerClient),
		listRuns: vi.fn(),
		inspectRun: vi.fn(),
		runLogs: vi.fn(),
		subscribe: vi.fn(() => () => {}),
		prune: vi.fn(),
		shutdown: vi.fn(),
	} as unknown as SubagentService;
}

function incompatibleEvents(): EventBus {
	return {
		on() {
			return () => {};
		},
		emit(_channel, value) {
			const request = value as { respond(provider: unknown): void };
			request.respond({
				contract: {
					...SUBAGENT_RUNTIME_CONTRACT,
					features: {
						...SUBAGENT_RUNTIME_CONTRACT.features,
						structuredOutput: false,
					},
				},
				acquire: async () => service(),
			});
		},
	};
}

describe("workflow subagent provider", () => {
	it("lazily acquires the exact shared service and binds run ownership", async () => {
		const events = createEventBus();
		const shared = service();
		const acquire = vi.fn(async () => shared);
		registerSubagentServiceProvider(events, acquire);
		const provider = createWorkflowSubagentProvider(events, context);

		expect(acquire).not.toHaveBeenCalled();
		const first = await provider.bind("workflow_first");
		const second = await provider.bind("workflow_second");

		expect(acquire).toHaveBeenCalledTimes(2);
		expect(shared.forOwner).toHaveBeenNthCalledWith(1, {
			id: "pi-workflow:workflow_first",
			workflowRunId: "workflow_first",
		});
		expect(shared.forOwner).toHaveBeenNthCalledWith(2, {
			id: "pi-workflow:workflow_second",
			workflowRunId: "workflow_second",
		});
		expect(first.ownerId).toBe("pi-workflow:workflow_first");
		expect(second.client).toBe(first.client);
		expect("service" in first).toBe(false);
		expect("shutdown" in first).toBe(false);
		expect(shared.shutdown).not.toHaveBeenCalled();
	});

	it("fails before owner binding when the provider is missing", async () => {
		const provider = createWorkflowSubagentProvider(createEventBus(), context);
		await expect(provider.bind("workflow_missing")).rejects.toMatchObject({
			code: "missing",
		});
	});

	it("rejects duplicate and incompatible providers", async () => {
		const duplicateEvents = createEventBus();
		registerSubagentServiceProvider(duplicateEvents, async () => service());
		registerSubagentServiceProvider(duplicateEvents, async () => service());
		await expect(
			createWorkflowSubagentProvider(duplicateEvents, context).bind(
				"workflow_duplicate",
			),
		).rejects.toMatchObject({ code: "duplicate" });
		await expect(
			createWorkflowSubagentProvider(incompatibleEvents(), context).bind(
				"workflow_incompatible",
			),
		).rejects.toMatchObject({ code: "incompatible" });
	});

	it("rejects malformed services and owner clients", async () => {
		const badServiceEvents = createEventBus();
		registerSubagentServiceProvider(
			badServiceEvents,
			async () => ({ forOwner: vi.fn() }) as unknown as SubagentService,
		);
		await expect(
			createWorkflowSubagentProvider(badServiceEvents, context).bind(
				"workflow_badservice",
			),
		).rejects.toMatchObject({ code: "incompatible" });

		const badClientEvents = createEventBus();
		registerSubagentServiceProvider(badClientEvents, async () =>
			service({ preflight: vi.fn() } as unknown as SubagentClient),
		);
		await expect(
			createWorkflowSubagentProvider(badClientEvents, context).bind(
				"workflow_badclient",
			),
		).rejects.toMatchObject({ code: "incompatible" });
	});

	it("detects provider removal and compatible service replacement", async () => {
		const events = createEventBus();
		const firstService = service();
		const unregister = registerSubagentServiceProvider(
			events,
			async () => firstService,
		);
		const provider = createWorkflowSubagentProvider(events, context);
		await provider.bind("workflow_initial");
		unregister();

		await expect(provider.bind("workflow_removed")).rejects.toMatchObject({
			code: "missing",
		});

		const secondService = service();
		registerSubagentServiceProvider(events, async () => secondService);
		await expect(provider.bind("workflow_replaced")).rejects.toMatchObject({
			code: "replaced",
		});
		expect(secondService.forOwner).not.toHaveBeenCalled();
	});

	it("classifies provider and owner-binding acquisition failures", async () => {
		const providerEvents = createEventBus();
		registerSubagentServiceProvider(providerEvents, async () => {
			throw new Error("provider failed");
		});
		await expect(
			createWorkflowSubagentProvider(providerEvents, context).bind(
				"workflow_providerfailure",
			),
		).rejects.toMatchObject({ code: "acquisition" });

		const ownerEvents = createEventBus();
		const shared = service();
		vi.mocked(shared.forOwner).mockImplementation(() => {
			throw new Error("owner failed");
		});
		registerSubagentServiceProvider(ownerEvents, async () => shared);
		await expect(
			createWorkflowSubagentProvider(ownerEvents, context).bind(
				"workflow_ownerfailure",
			),
		).rejects.toMatchObject({ code: "acquisition" });
	});

	it("rejects invalid run identities before provider acquisition", async () => {
		const events = createEventBus();
		const acquire = vi.fn(async () => service());
		registerSubagentServiceProvider(events, acquire);
		const provider = createWorkflowSubagentProvider(events, context);

		await expect(provider.bind("invalid" as never)).rejects.toBeInstanceOf(
			WorkflowSubagentProviderError,
		);
		expect(acquire).not.toHaveBeenCalled();
	});

	it("serializes concurrent initial bindings onto one pinned service", async () => {
		const events = createEventBus();
		const shared = service();
		const acquire = vi.fn(async () => shared);
		registerSubagentServiceProvider(events, acquire);
		const provider = createWorkflowSubagentProvider(events, context);

		const [first, second] = await Promise.all([
			provider.bind("workflow_concurrentone"),
			provider.bind("workflow_concurrenttwo"),
		]);
		expect(first.client).toBe(second.client);
		expect(acquire).toHaveBeenCalledTimes(2);
	});
});
