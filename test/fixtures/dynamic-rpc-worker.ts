import { parentPort, workerData } from "node:worker_threads";
import {
	type DynamicCallMessage,
	type DynamicReplyMessage,
	requestDynamicCallSync,
} from "../../src/dynamic/rpc.js";

/**
 * Exercises the VM side of the synchronous bridge from a real worker: each
 * scripted call blocks on `Atomics.wait` until the host answers on the sync
 * port, and the outcome (reply or thrown error) is reported on the main
 * channel as `{ type: "outcome", ... }`.
 */
const data = workerData as {
	syncBuffer: SharedArrayBuffer;
	syncPort: import("node:worker_threads").MessagePort;
	calls: readonly Omit<DynamicCallMessage, "type">[];
	waitMs?: number;
};

const port = parentPort;
if (!port) throw new Error("fixture requires a parent port");

for (const call of data.calls) {
	let outcome:
		| { type: "outcome"; reply: DynamicReplyMessage }
		| { type: "outcome"; error: { name: string; message: string } };
	try {
		const reply = requestDynamicCallSync({
			syncBuffer: data.syncBuffer,
			syncPort: data.syncPort,
			post: (message) => port.postMessage(message),
			message: { type: "call", ...call },
			...(data.waitMs === undefined ? {} : { waitMs: data.waitMs }),
		});
		outcome = { type: "outcome", reply };
	} catch (error) {
		const thrown = error as { name?: string; message?: string };
		outcome = {
			type: "outcome",
			error: { name: String(thrown.name), message: String(thrown.message) },
		};
	}
	port.postMessage(outcome);
}
port.postMessage({ type: "finished" });
