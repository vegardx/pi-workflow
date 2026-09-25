/**
 * Carrying a cause's message across a seam, without carrying anything else.
 *
 * Both provider seams in this package end in a fixed message so that no
 * internal error text, and no stack, reaches a consumer. Fixed is right; empty
 * is not. When the real failure is itself a *fixed, sanitized* message - the
 * ones `@vegardx/pi-subagent` and this package construct from literals - the
 * wrapper says it, because the alternative is what happened on 2026-09-17: a
 * whole session spent on "Failed to acquire the shared pi-subagent service."
 * while the store was plainly saying "run record uses contract revision 6;
 * expected 7. Discard incompatible persisted state before continuing."
 *
 * Two gates, both required. The error's `name` must be one this package knows
 * builds its message from literals - matched by name, because an error thrown
 * in another module graph fails `instanceof`. And the message must still look
 * like a fixed one: a single short line with no host path and no URL. A
 * message that fails either gate is dropped, not trimmed.
 */

/**
 * Error names whose messages are fixed strings by construction: every one is
 * built from literals and identities in `@vegardx/pi-subagent` or here, and
 * none interpolates a host path, a URL, or another error's text.
 */
const SANITIZED_ERROR_NAMES: ReadonlySet<string> = new Set([
	// @vegardx/pi-subagent
	"SubagentServiceProviderError",
	"IncompatibleContractRevisionError",
	"PersistenceCorruptionError",
	"OperationConflictError",
	"RunLeaseUnavailableError",
	"RunLeaseFencedError",
	// @vegardx/pi-workflow
	"WorkflowSubagentProviderError",
	"WorkflowServiceProviderError",
	"WorkflowServiceError",
]);

/** A fixed message is one line; anything longer is a report, not a reason. */
const MAX_DETAIL_LENGTH = 300;

/** How far down a `cause` chain to look before giving up. */
const MAX_DEPTH = 5;

/** Host paths, file URLs, and multi-line text never belong in a fixed message. */
function looksSanitized(message: string): boolean {
	if (message.length === 0 || message.length > MAX_DETAIL_LENGTH) return false;
	if (/[\r\n\t]/.test(message)) return false;
	if (/(^|[\s(<"'])[/~]/.test(message)) return false;
	if (/[A-Za-z]:\\/.test(message)) return false;
	if (/[a-z][a-z0-9+.-]*:\/\//i.test(message)) return false;
	return true;
}

function nameOf(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const name = (error as { name?: unknown }).name;
	return typeof name === "string" ? name : undefined;
}

function messageOf(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const message = (error as { message?: unknown }).message;
	return typeof message === "string" ? message.trim() : undefined;
}

/**
 * The first fixed, sanitized message in `error`'s cause chain, or `undefined`
 * when nothing in it qualifies.
 */
export function sanitizedCauseDetail(error: unknown): string | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < MAX_DEPTH && current !== undefined; depth += 1) {
		const name = nameOf(current);
		const message = messageOf(current);
		if (
			name !== undefined &&
			message !== undefined &&
			SANITIZED_ERROR_NAMES.has(name) &&
			looksSanitized(message)
		) {
			return message;
		}
		current = (current as { cause?: unknown } | null)?.cause;
	}
	return undefined;
}

/**
 * `message`, with the cause's own fixed message appended when there is one.
 * The wrapper's message never changes shape otherwise, so a consumer matching
 * on the fixed prefix keeps matching.
 */
export function withSanitizedCause(message: string, error: unknown): string {
	const detail = sanitizedCauseDetail(error);
	if (detail === undefined) return message;
	// The cause already ends a sentence of its own often enough that a second
	// full stop reads badly; one separator, one message, nothing else.
	return `${message.replace(/[.]$/, "")}: ${detail}`;
}

/**
 * Why a task did not complete, as one sanitized sentence a host may post into a
 * person's conversation.
 *
 * Every view in this package exposes a failure CODE and never a failure
 * MESSAGE, and `test/service-read.test.ts` pins it: an inspection carries "no
 * child prose". A classified failure's `message` is up to 4096 characters of
 * whatever the child or the provider said, and its `guidance` is written for an
 * operator of pi-subagent, not for a person reading a conversation. Neither
 * travels here.
 *
 * What travels is the CLOSED vocabularies the journal already carries — the
 * delegated run's status, the failure code, its origin, its retry class, or the
 * workflow failure stage — composed into one sentence. That is strictly more
 * than "provider-transient" and strictly less than prose, which is the whole
 * point: a host that can only say a code sends a person looking, and a host that
 * repeats a child's words has leaked them.
 */
export function sanitizedTaskFailureCause(
	evidence:
		| {
				readonly kind: string;
				readonly status?: string;
				readonly stage?: string;
				readonly failure?: {
					readonly code: string;
					readonly origin: string;
					readonly retry: string;
				};
		  }
		| undefined,
	outcome: string,
): string {
	if (evidence?.kind === "subagent") {
		const failure = evidence.failure;
		if (!failure) {
			return `The delegated run ended ${evidence.status ?? outcome} with no classified failure.`;
		}
		return `The delegated run ${evidence.status ?? outcome}: ${failure.code} (origin ${failure.origin}, retry ${failure.retry}).`;
	}
	if (evidence?.kind === "workflow") {
		return `The run failed at ${evidence.stage ?? "an unnamed stage"}.`;
	}
	if (evidence?.kind === "support" || evidence?.kind === "nested") {
		return `The ${evidence.kind} task ended ${outcome}.`;
	}
	return `The task ended ${outcome}.`;
}
