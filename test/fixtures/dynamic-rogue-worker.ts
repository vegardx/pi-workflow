import { parentPort, workerData } from "node:worker_threads";
import { MAX_DYNAMIC_RPC_MESSAGE_BYTES } from "../../src/dynamic/constants.js";
import type { DynamicVmMessage } from "../../src/dynamic/rpc.js";

/**
 * A worker that misbehaves on purpose (spec 11.4 "protocol"). The host boots
 * it through `overrides.workerEntry`; the scenario travels in
 * `workerData.source`, which the real worker would transform. Every scenario
 * waits for `start` and (unless told otherwise) posts a valid `ready` first,
 * so what follows is the only violation the host sees. Overlapping `call`s
 * cannot be staged from a worker: the host answers each `call` inside its
 * message handler (deadlock rule R1), so the guard's overlap rule is covered
 * at the guard level in test/dynamic-rpc.test.ts.
 */
const port = parentPort;
if (!port) throw new Error("fixture requires a parent port");
const scenario = String((workerData as { source: unknown }).source);

const manifest = {
	meta: {
		name: "rogue",
		description: "Misbehaving worker",
		version: 1,
		budget: { cost: 1, childRuntimeMs: 60_000 },
		timeoutMs: 60_000,
		concurrency: 1,
	},
	inputSchema: { type: "object", additionalProperties: false },
	outputSchema: { type: "object", additionalProperties: false },
};
const runId = "workflow_rogue0001";
const taskRef = { runId, taskId: "task_unknown" };
const handleRef = {
	kind: "task-handle" as const,
	ref: taskRef,
	output: { runId, producerTaskId: "task_unknown", output: "result" as const },
};

function post(message: DynamicVmMessage | Record<string, unknown>): void {
	port?.postMessage(message);
}

port.once("message", () => {
	// Keep the thread alive so the host observes the violation, not an exit.
	setInterval(() => undefined, 1_000);
	switch (scenario) {
		case "no-ready":
			return;
		case "before-ready":
			post({ type: "call", id: 1, method: "log", args: ["early"] });
			return;
	}
	post({ type: "ready", manifest });
	switch (scenario) {
		case "double-ready":
			post({ type: "ready", manifest });
			return;
		case "invalid-message":
			post({ type: "bogus" });
			return;
		case "oversized":
			post({
				type: "done",
				result: {
					kind: "value",
					value: "x".repeat(MAX_DYNAMIC_RPC_MESSAGE_BYTES),
				},
			});
			return;
		case "too-many": {
			// `ready` was message 1; awaits with contiguous ids fill the budget
			// and the first one past it trips the count bound. Replies are
			// ignored: the fixture never blocks.
			const budget = 65_536;
			for (let id = 1; id <= budget; id += 1) {
				post({ type: "await", id, method: "results", handles: [] });
			}
			return;
		}
		case "non-contiguous":
			post({ type: "await", id: 5, method: "results", handles: [] });
			return;
		case "unknown-return-task":
			post({ type: "done", result: { kind: "task", ref: taskRef } });
			return;
		case "unknown-return-artifact":
			post({
				type: "done",
				result: { kind: "artifact", ref: handleRef.output },
			});
			return;
		case "hang":
			return;
		case "exit":
			process.exit(3);
			return;
		case "throw":
			setImmediate(() => {
				throw new Error("kaboom");
			});
			return;
		default:
			post({
				type: "failed",
				error: { name: "Error", message: `unknown scenario ${scenario}` },
			});
	}
});
