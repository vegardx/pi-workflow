/**
 * Leaf module: the dynamic-workflow failure class (spec section 8) and the two
 * bootstrap wire names the worker and its host agree on. It has no imports so
 * `vm-host.ts`, `worker.ts`, `definition.ts`, and tests share it without a
 * cycle and without loading the worker entry (which boots on import when a
 * parent port exists); the static runtime recognises the error by `name`.
 */

export type DynamicWorkflowExecutionStage =
	| "boot"
	| "transform"
	| "manifest"
	| "source"
	| "protocol"
	| "watchdog"
	| "memory"
	| "exit"
	| "abort";

/** Name the static runtime's catch matches (it cannot import this module). */
export const DYNAMIC_WORKFLOW_EXECUTION_ERROR_NAME =
	"DynamicWorkflowExecutionError";

/**
 * A VM drive failure with its exact `-> failed` reason as `message` (D9).
 * Messages are bounded to 4096 characters by every constructor site.
 */
export class DynamicWorkflowExecutionError extends Error {
	constructor(
		readonly stage: DynamicWorkflowExecutionStage,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = DYNAMIC_WORKFLOW_EXECUTION_ERROR_NAME;
	}
}

export function isDynamicWorkflowExecutionError(
	error: unknown,
): error is DynamicWorkflowExecutionError {
	return error instanceof DynamicWorkflowExecutionError;
}

/** `failed.error.name` of a worker bootstrap failure before the transform (spec 7.3 steps 1-2). */
export const DYNAMIC_BOOT_ERROR_NAME = "DynamicBootError";

/**
 * `failed.error.name` a worker posts when the host's `abort` reaches it before
 * `ready` (spec 6.4): the thread ends cleanly and the host maps the failure to
 * stage "abort" only when it did abort, so source code cannot spoof the stage.
 */
export const DYNAMIC_ABORT_ERROR_NAME = "DynamicAbortError";

/** Tests-only worker argv flag carrying `overrides.syncWaitMs` (spec 8). */
export const DYNAMIC_SYNC_WAIT_ARGV_PREFIX =
	"--pi-workflow-dynamic-sync-wait-ms=";

/** Reads the tests-only sync-wait override from a worker's argv, if any. */
export function syncWaitMsFromArgv(
	argv: readonly string[],
): number | undefined {
	for (const argument of argv) {
		if (!argument.startsWith(DYNAMIC_SYNC_WAIT_ARGV_PREFIX)) continue;
		const value = Number(argument.slice(DYNAMIC_SYNC_WAIT_ARGV_PREFIX.length));
		if (Number.isInteger(value) && value > 0) return value;
	}
	return undefined;
}
