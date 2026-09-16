import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import workflowExtension from "../src/extension.js";
import type { WorkflowService } from "../src/service.js";
import { createWorkflowService } from "../src/service.js";

// The service factory is the only slow step of `session_start`; replacing it
// lets two starts overlap deterministically and exposes every subscription.
vi.mock("../src/service.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/service.js")>()),
	createWorkflowService: vi.fn(),
}));

type Handler = (...args: unknown[]) => Promise<void> | void;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

function fakeService() {
	const unsubscribe = vi.fn();
	const service = {
		listRuns: vi.fn(async () => ({
			runs: [],
			total: 0,
			issues: [],
			issuesTruncated: 0,
			generatedAt: "2026-09-15T12:05:00.000Z",
		})),
		subscribe: vi.fn(() => unsubscribe),
		shutdown: vi.fn(async () => {}),
	};
	return { service: service as unknown as WorkflowService, unsubscribe };
}

function capture() {
	const handlers = new Map<string, Handler>();
	workflowExtension({
		events: { on: vi.fn(), emit: vi.fn() },
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI);
	const start = handlers.get("session_start");
	const shutdown = handlers.get("session_shutdown");
	if (!start || !shutdown) throw new Error("session hooks missing");
	return { start, shutdown };
}

function tuiContext(setWidget: ReturnType<typeof vi.fn>) {
	return {
		cwd: "/tmp/pi-workflow-widget-test",
		mode: "tui",
		hasUI: true,
		isProjectTrusted: () => true,
		ui: { notify: vi.fn(), setWidget },
	};
}

describe("widget controller lifecycle across overlapping session starts", () => {
	it("keeps exactly one subscribed controller when a reload overlaps a pending start", async () => {
		const { start, shutdown } = capture();
		const { service, unsubscribe } = fakeService();
		const opening = deferred<WorkflowService>();
		vi.mocked(createWorkflowService).mockReturnValueOnce(opening.promise);
		vi.mocked(createWorkflowService).mockResolvedValueOnce(service);
		const setWidget = vi.fn();
		const context = tuiContext(setWidget);

		// The first start is stuck opening the service when the reload arrives.
		const first = start({ reason: "startup" }, context);
		const second = start({ reason: "reload" }, context);
		opening.resolve(service);
		await Promise.all([first, second]);

		// Only the reload installed a controller: one widget subscription and
		// one parked-run observer subscription, one refresh each.
		expect(service.subscribe).toHaveBeenCalledTimes(2);
		expect(service.listRuns).toHaveBeenCalledTimes(2);
		expect(unsubscribe).not.toHaveBeenCalled();
		expect(setWidget).toHaveBeenCalledWith("pi-workflow", undefined, {
			placement: "belowEditor",
		});

		await shutdown({ reason: "quit" }, context);
		expect(unsubscribe).toHaveBeenCalledTimes(2);
		expect(service.shutdown).toHaveBeenCalledTimes(1);
		expect(setWidget.mock.calls.at(-1)).toEqual(["pi-workflow", undefined]);
	});

	it("stops the earlier controller when a reload overlaps its first refresh", async () => {
		const { start, shutdown } = capture();
		const { service, unsubscribe } = fakeService();
		const firstPage =
			deferred<Awaited<ReturnType<WorkflowService["listRuns"]>>>();
		vi.mocked(service.listRuns)
			.mockReturnValueOnce(firstPage.promise as never)
			.mockResolvedValueOnce({
				runs: [],
				total: 0,
				issues: [],
				issuesTruncated: 0,
				generatedAt: "2026-09-15T12:05:00.000Z",
			} as never);
		vi.mocked(createWorkflowService).mockResolvedValue(service);
		const setWidget = vi.fn();
		const context = tuiContext(setWidget);

		// The first controller is subscribed and awaiting its page when the
		// reload arrives; the reload stops it before installing its own.
		const first = start({ reason: "startup" }, context);
		await vi.waitFor(() => expect(service.subscribe).toHaveBeenCalledTimes(1));
		const second = start({ reason: "reload" }, context);
		firstPage.resolve({
			runs: [],
			total: 0,
			issues: [],
			issuesTruncated: 0,
			generatedAt: "2026-09-15T12:05:00.000Z",
		} as never);
		await Promise.all([first, second]);

		// The superseded start installed no observer: two widget controllers
		// and the surviving one's observer.
		expect(service.subscribe).toHaveBeenCalledTimes(3);
		expect(unsubscribe).toHaveBeenCalledTimes(1);

		await shutdown({ reason: "quit" }, context);
		expect(unsubscribe).toHaveBeenCalledTimes(3);
	});

	it("installs nothing when shutdown arrives while a start is still opening the service", async () => {
		const { start, shutdown } = capture();
		const { service } = fakeService();
		const opening = deferred<WorkflowService>();
		vi.mocked(createWorkflowService).mockReturnValueOnce(opening.promise);
		const setWidget = vi.fn();
		const context = tuiContext(setWidget);

		const pending = start({ reason: "startup" }, context);
		const stopped = shutdown({ reason: "quit" }, context);
		opening.resolve(service);
		await Promise.all([pending, stopped]);

		expect(service.subscribe).not.toHaveBeenCalled();
		expect(service.listRuns).not.toHaveBeenCalled();
	});
});
