import { parentPort, workerData } from "node:worker_threads";
import { Value } from "typebox/value";
import {
	DYNAMIC_ABORT_ERROR_NAME,
	DYNAMIC_BOOT_ERROR_NAME,
	syncWaitMsFromArgv,
} from "./execution-error.js";
import {
	DynamicAbortMessageSchema,
	type DynamicStartMessage,
	DynamicStartMessageSchema,
	type DynamicVmError,
	type DynamicVmMessage,
	type DynamicWorkerData,
	isDynamicWorkerData,
	toDynamicVmError,
} from "./rpc.js";
import {
	createDynamicModules,
	createDynamicVmContext,
	createVmWorkflowContext,
	dynamicManifestOf,
	evaluateDynamicSource,
	normalizeDynamicDefinition,
} from "./shim.js";
import { transformDynamicSource } from "./transformer.js";
import { assertDynamicTransformerVersion } from "./transformer-identity.js";

/*
 * Worker entry (spec 7.3). Both modes boot identically up to `ready`; manifest
 * mode then exits, run mode hands the main channel to the shim session. Every
 * failure before `ready` is reported as one `failed` message and the thread
 * exits, so the host never waits on a silent worker beyond its boot watchdog.
 */

export const MSG_WORKER_DATA_INVALID =
	"Dynamic workflow worker data is invalid.";
export const MSG_WORKER_NO_START =
	"Dynamic workflow worker did not receive start.";

function bootError(message: string): DynamicVmError {
	return { name: DYNAMIC_BOOT_ERROR_NAME, message };
}

type ParentPort = NonNullable<typeof parentPort>;

/**
 * Reports one `failed` message and ends the thread. The host receives the
 * message before the worker's `exit` event (Node drains the port first), so
 * the ladder settles on `failed` alone. An observer that terminates the
 * worker as soon as the message arrives, while the thread is still tearing
 * down, sees `terminate()`'s exit code (1) instead of `code`; the VM host
 * never reads the code after `failed`, and a test that asserts it must wait
 * for the natural exit.
 */
function failAndExit(
	port: ParentPort,
	error: DynamicVmError,
	code: number,
): never {
	port.postMessage({ type: "failed", error } satisfies DynamicVmMessage);
	process.exit(code);
}

/**
 * Boot inbox: a listener stays attached from the first host message until the
 * shim takes the channel, so nothing the host posts while the worker
 * transforms and evaluates is dropped. `start` resolves `first`; an `abort`
 * (spec 6.4) at any point before `ready` ends the thread cleanly with a
 * `failed` the host maps to stage "abort"; any other message before `ready`
 * is out of protocol and ignored.
 */
function bootInbox(port: ParentPort): {
	readonly first: Promise<unknown>;
	release(): void;
} {
	let resolveFirst: ((message: unknown) => void) | undefined;
	const first = new Promise<unknown>((resolve) => {
		resolveFirst = resolve;
	});
	const listener = (message: unknown): void => {
		if (Value.Check(DynamicAbortMessageSchema, message)) {
			failAndExit(
				port,
				{ name: DYNAMIC_ABORT_ERROR_NAME, message: message.reason },
				0,
			);
		}
		if (resolveFirst !== undefined) {
			resolveFirst(message);
			resolveFirst = undefined;
		}
	};
	port.on("message", listener);
	return { first, release: () => port.off("message", listener) };
}

async function main(port: ParentPort): Promise<void> {
	const post = (message: DynamicVmMessage): void => port.postMessage(message);

	// 1. Transformer pin and workerData shape.
	try {
		assertDynamicTransformerVersion();
	} catch (error) {
		failAndExit(port, bootError(toDynamicVmError(error).message), 1);
	}
	if (!isDynamicWorkerData(workerData)) {
		failAndExit(port, bootError(MSG_WORKER_DATA_INVALID), 1);
	}
	const data: DynamicWorkerData = workerData;

	// 2. `start` must be the first host message in both modes; an `abort`
	// before `ready` ends the thread from the inbox.
	const inbox = bootInbox(port);
	const first = await inbox.first;
	if (!Value.Check(DynamicStartMessageSchema, first)) {
		failAndExit(port, bootError(MSG_WORKER_NO_START), 1);
	}
	const start: DynamicStartMessage = first;

	// 3. Transform under the worker's resource limits (D1).
	let code: string;
	try {
		code = transformDynamicSource({
			source: data.source,
			filename: data.filename,
			supportModuleSpecifiers: data.supportHelpers.map(
				(helper) => helper.moduleSpecifier,
			),
		}).code;
	} catch (error) {
		failAndExit(port, toDynamicVmError(error), 1);
	}

	// 4-6. Module table, sealed context, evaluation, normalisation.
	let definition: ReturnType<typeof normalizeDynamicDefinition>;
	try {
		const modules = createDynamicModules(data.supportHelpers);
		const context = createDynamicVmContext({
			filename: data.filename,
			epochMs: start.epochMs,
			seed: start.seed,
		});
		const loaded = await evaluateDynamicSource({
			context,
			code,
			filename: data.filename,
			modules,
		});
		definition = normalizeDynamicDefinition(loaded);
	} catch (error) {
		failAndExit(port, toDynamicVmError(error), 1);
	}

	// 7. Manifest.
	post({ type: "ready", manifest: dynamicManifestOf(definition) });
	if (data.mode === "manifest") process.exit(0);

	// 8. Run: the shim owns the main channel from here on.
	const syncWaitMs = syncWaitMsFromArgv(process.argv);
	const session = createVmWorkflowContext(start, {
		post,
		syncBuffer: data.syncBuffer,
		syncPort: data.syncPort,
		...(syncWaitMs === undefined ? {} : { syncWaitMs }),
	});
	inbox.release();
	port.on("message", session.deliver);
	void session.run(definition);
}

if (parentPort) {
	const port = parentPort;
	main(port).catch((error: unknown) => {
		port.postMessage({
			type: "failed",
			error: toDynamicVmError(error),
		} satisfies DynamicVmMessage);
		process.exit(1);
	});
}
