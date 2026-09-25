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

/**
 * Module specifiers are bare names by the import gate, so a specifier that
 * looks like a path or a URL is not one this package would admit and is
 * dropped rather than shown.
 */
const BARE_SPECIFIER =
	/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i;

/** Node's two codes for "that specifier resolves to nothing". */
const MODULE_NOT_FOUND_CODES: ReadonlySet<string> = new Set([
	"MODULE_NOT_FOUND",
	"ERR_MODULE_NOT_FOUND",
]);

/** The package every definition imports; its absence has its own advice. */
const PI_WORKFLOW_SPECIFIER = "@vegardx/pi-workflow";

/** The advice that turns an unresolvable pi-workflow into something to do. */
const PI_WORKFLOW_ADVICE =
	"the project must be able to resolve pi-workflow, for example through a dependency or link";

/** An error class name is one identifier; anything else is not a name. */
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** A parser message is one line; a report is not a reason. */
const MAX_PARSE_DETAIL = 200;

function codeOf(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

/** `error` and its causes, outermost first, bounded by {@link MAX_DEPTH}. */
function causeChain(error: unknown): readonly unknown[] {
	const chain: unknown[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < MAX_DEPTH && current !== undefined; depth += 1) {
		chain.push(current);
		current = (current as { cause?: unknown } | null)?.cause;
	}
	return chain;
}

function moduleNotFoundSpecifier(
	chain: readonly unknown[],
): string | undefined {
	for (const link of chain) {
		const message = messageOf(link) ?? "";
		if (
			!MODULE_NOT_FOUND_CODES.has(codeOf(link) ?? "") &&
			!/Cannot find (?:module|package) /.test(message)
		) {
			continue;
		}
		const specifier = /Cannot find (?:module|package) ['"]([^'"\n]+)['"]/.exec(
			message,
		)?.[1];
		if (
			specifier !== undefined &&
			specifier.length <= 128 &&
			BARE_SPECIFIER.test(specifier)
		) {
			return specifier;
		}
	}
	return undefined;
}

function parseDetail(chain: readonly unknown[]): string | undefined {
	for (const link of chain) {
		if (nameOf(link) !== "SyntaxError") continue;
		const first = (messageOf(link) ?? "")
			.split("\n", 1)[0]
			?.slice(0, MAX_PARSE_DETAIL)
			.trim();
		if (first !== undefined && looksSanitized(first)) return first;
	}
	return undefined;
}

/**
 * Why one definition file did not load, as one sentence a person can act on.
 *
 * The same two gates the rest of this module applies: the only cause text that
 * travels is a module specifier that looks like one and a parser's first line
 * that looks like a fixed message, and the only path that travels is
 * `definitionPath` — the file's own path relative to its root, which the caller
 * supplies. Everything else collapses to the class of the failure, so no stack,
 * no host path, and no dependency's prose reaches a view.
 */
export function sanitizedDefinitionProblem(
	error: unknown,
	definitionPath: string,
): string {
	const chain = causeChain(error);
	const specifier = moduleNotFoundSpecifier(chain);
	if (specifier !== undefined) {
		const sentence = `cannot resolve module '${specifier}' from ${definitionPath}`;
		// The root and its subpaths are the same missing package and the same fix.
		return specifier === PI_WORKFLOW_SPECIFIER ||
			specifier.startsWith(`${PI_WORKFLOW_SPECIFIER}/`)
			? `${sentence} — ${PI_WORKFLOW_ADVICE}`
			: sentence;
	}
	const parse = parseDetail(chain);
	if (parse !== undefined) return `does not parse: ${parse}`;
	const name = nameOf(error);
	return `failed to load: ${name !== undefined && ERROR_NAME.test(name) ? name : "Error"}`;
}
