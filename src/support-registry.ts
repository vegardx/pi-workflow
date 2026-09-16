import {
	type SupportTaskRegistration,
	supportRegistrationIdentity,
} from "./support.js";

/**
 * The support task implementations the shipped Pi extension hands to
 * `createWorkflowService({ supportTasks })`.
 *
 * A support implementation is **host-process code**: the support task executor
 * calls `execute` directly in Pi's process, with Pi's authority, outside every
 * VM, worktree, and subagent boundary. So the trust rule is narrow and
 * deliberate:
 *
 * - Only **package or builtin** code may provide one. Registrations are
 *   compiled into this package (`BUILTIN_SUPPORT_TASKS`) or installed by an
 *   embedder that is already running in the host process
 *   (`registerSupportTask`). There is no manifest key, no filesystem scan, and
 *   no project-provided registration: a project workflow is authoring input,
 *   never an implementation source, and Pi project trust does not extend to
 *   running arbitrary project code in-process.
 * - A dynamic workflow source cannot reach this module at all; its
 *   `registration()` shim throws, and helpers reach it only as the declarative
 *   descriptors the service publishes.
 * - Registering also widens the definition registry's import gate: the service
 *   derives `allowedSupportImports` from each registration's
 *   `moduleSpecifier`, so a static workflow may import exactly the specifiers
 *   registered here and nothing else. Registering a helper is therefore an
 *   authority decision, not a convenience.
 */
export const BUILTIN_SUPPORT_TASKS: readonly SupportTaskRegistration[] =
	Object.freeze([]);

export const SUPPORT_REGISTRY_DUPLICATE_MESSAGE =
	"Duplicate support task implementation:";
export const SUPPORT_REGISTRY_NOT_EXECUTABLE_MESSAGE =
	"Support task implementation is not executable.";

/** Host-process registrations installed through `registerSupportTask`. */
const installed = new Map<string, SupportTaskRegistration>();

/**
 * Installs one host-process support implementation the extension's service
 * will resolve, and returns an idempotent removal.
 *
 * The extension snapshots the registry when it constructs its service, so a
 * registration must be installed before the first workflow call in a session;
 * a later one applies to the next service (a different `cwd`, or a new
 * process). Identity is validated here so a malformed registration fails at
 * its source rather than at service construction.
 */
export function registerSupportTask(
	registration: SupportTaskRegistration,
): () => void {
	if (typeof registration.execute !== "function") {
		throw new Error(SUPPORT_REGISTRY_NOT_EXECUTABLE_MESSAGE);
	}
	supportRegistrationIdentity(registration);
	if (
		installed.has(registration.name) ||
		BUILTIN_SUPPORT_TASKS.some((builtin) => builtin.name === registration.name)
	) {
		throw new Error(
			`${SUPPORT_REGISTRY_DUPLICATE_MESSAGE} ${registration.name}`,
		);
	}
	installed.set(registration.name, registration);
	let removed = false;
	return () => {
		if (removed) return;
		removed = true;
		if (installed.get(registration.name) === registration) {
			installed.delete(registration.name);
		}
	};
}

/**
 * Every registration the extension passes as `supportTasks`: this package's
 * builtins first, then host-process registrations, each sorted by name so the
 * constructed registry does not depend on registration order. Empty by
 * default — pi-workflow ships no builtin support implementation yet — which is
 * why `ctx.support` still resolves nothing unless a helper was registered,
 * while the wiring itself is live.
 */
export function supportTaskRegistrations(): readonly SupportTaskRegistration[] {
	const byName = new Map<string, SupportTaskRegistration>();
	for (const registration of BUILTIN_SUPPORT_TASKS) {
		byName.set(registration.name, registration);
	}
	for (const registration of installed.values()) {
		byName.set(registration.name, registration);
	}
	return Object.freeze(
		[...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
	);
}
