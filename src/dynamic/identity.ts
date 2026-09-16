import { WORKFLOW_CONTRACT_REVISION } from "../contracts.js";
import {
	deriveJsonValueSha256,
	deriveSupportImplementationIdentitySha256,
} from "../execution.js";
import {
	DYNAMIC_ASYNC_METHODS,
	DYNAMIC_BUILTIN_MODULES,
	DYNAMIC_CONTEXT_METHODS,
	DYNAMIC_CONTEXT_PROPERTIES,
	DYNAMIC_HOST_API_REVISION,
	DYNAMIC_RPC_MESSAGE_TYPES,
	DYNAMIC_SHIM_EXPORTS,
	DYNAMIC_SYNC_METHODS,
	DYNAMIC_TRANSFORMER,
	DYNAMIC_VM_ABORT_GRACE_MS,
	DYNAMIC_VM_BOOT_TIMEOUT_MS,
	DYNAMIC_VM_CODE_GENERATION,
	DYNAMIC_VM_COMPUTE_TIMEOUT_MS,
	DYNAMIC_VM_MANIFEST_TIMEOUT_MS,
	DYNAMIC_VM_RESOURCE_LIMITS,
	DYNAMIC_VM_SYNC_WAIT_MS,
	MAX_DYNAMIC_HANDLE_REFS,
	MAX_DYNAMIC_MANIFEST_BYTES,
	MAX_DYNAMIC_RPC_ARGS,
	MAX_DYNAMIC_RPC_MESSAGE_BYTES,
	MAX_DYNAMIC_RPC_MESSAGES,
	MAX_DYNAMIC_SOURCE_BYTES,
	MAX_DYNAMIC_VM_ERROR_CHARS,
} from "./constants.js";
import type { DynamicSupportHelperSpec } from "./contracts.js";

/**
 * Replaces the registry's path-bearing identity for dynamic definitions; a
 * dynamic run therefore never collides with a static identity.
 */
export function deriveDynamicDefinitionIdentitySha256(value: {
	readonly sourceSha256: string;
	readonly manifestSha256: string;
	readonly hostApiSha256: string;
}): string {
	return deriveJsonValueSha256({
		contractRevision: WORKFLOW_CONTRACT_REVISION,
		hostApiSha256: value.hostApiSha256,
		kind: "dynamic-workflow",
		manifestSha256: value.manifestSha256,
		sourceSha256: value.sourceSha256,
	});
}

/**
 * Build-time constant over every constant the VM frontend exposes to dynamic
 * source. Behavioural changes to the shim or bridge that no constant captures
 * must bump `DYNAMIC_HOST_API_REVISION`.
 */
export function deriveDynamicHostApiSha256(): string {
	return deriveJsonValueSha256({
		builtinModules: [...DYNAMIC_BUILTIN_MODULES].sort(),
		codeGeneration: DYNAMIC_VM_CODE_GENERATION,
		contextMethods: [...DYNAMIC_CONTEXT_METHODS].sort(),
		contextProperties: [...DYNAMIC_CONTEXT_PROPERTIES].sort(),
		contractRevision: WORKFLOW_CONTRACT_REVISION,
		globals: ["Date", "Math.random", "console"],
		hostApiRevision: DYNAMIC_HOST_API_REVISION,
		limits: {
			abortGraceMs: DYNAMIC_VM_ABORT_GRACE_MS,
			bootTimeoutMs: DYNAMIC_VM_BOOT_TIMEOUT_MS,
			computeTimeoutMs: DYNAMIC_VM_COMPUTE_TIMEOUT_MS,
			manifestTimeoutMs: DYNAMIC_VM_MANIFEST_TIMEOUT_MS,
			maxHandleRefs: MAX_DYNAMIC_HANDLE_REFS,
			maxManifestBytes: MAX_DYNAMIC_MANIFEST_BYTES,
			maxMessageBytes: MAX_DYNAMIC_RPC_MESSAGE_BYTES,
			maxMessages: MAX_DYNAMIC_RPC_MESSAGES,
			maxRpcArgs: MAX_DYNAMIC_RPC_ARGS,
			maxSourceBytes: MAX_DYNAMIC_SOURCE_BYTES,
			maxVmErrorChars: MAX_DYNAMIC_VM_ERROR_CHARS,
			resourceLimits: DYNAMIC_VM_RESOURCE_LIMITS,
			syncWaitMs: DYNAMIC_VM_SYNC_WAIT_MS,
		},
		rpc: {
			asyncMethods: [...DYNAMIC_ASYNC_METHODS].sort(),
			messageTypes: [...DYNAMIC_RPC_MESSAGE_TYPES].sort(),
			syncMethods: [...DYNAMIC_SYNC_METHODS].sort(),
		},
		shimExports: [...DYNAMIC_SHIM_EXPORTS].sort(),
		transformer: DYNAMIC_TRANSFORMER,
	});
}

/**
 * Registry-derived, separate from the host API: it depends on the embedder's
 * support registrations, not the package. Order-independent.
 */
export function deriveDynamicImportPolicySha256(
	helpers: readonly DynamicSupportHelperSpec[],
): string {
	return deriveJsonValueSha256({
		builtinModules: [...DYNAMIC_BUILTIN_MODULES].sort(),
		support: [...helpers]
			.map((helper) => ({
				exportName: helper.exportName,
				implementationIdentitySha256:
					deriveSupportImplementationIdentitySha256(helper),
				moduleSpecifier: helper.moduleSpecifier,
			}))
			.sort((a, b) =>
				`${a.moduleSpecifier} ${a.exportName}`.localeCompare(
					`${b.moduleSpecifier} ${b.exportName}`,
				),
			),
	});
}
