/**
 * Dynamic-workflow constants. Every value here except the store and UI caps
 * marked "not in hostApi" feeds `deriveDynamicHostApiSha256()`; changing one
 * invalidates every recorded approval, which is the intent.
 */

/** Bump on any shim or RPC semantic change that no constant captures. */
export const DYNAMIC_HOST_API_REVISION = 1;
export const DYNAMIC_REF_PREFIX = "dynamic:";
export const DYNAMIC_REF_PATTERN = /^dynamic:[a-f0-9]{64}$/;
export const MAX_DYNAMIC_SOURCE_BYTES = 256 * 1024;
/** Store cap, not in hostApi. */
export const MAX_DYNAMIC_PROPOSALS = 1024;
/** Not in hostApi. */
export const MAX_DYNAMIC_PROPOSAL_RECORD_BYTES = 64 * 1024;
export const MAX_DYNAMIC_MANIFEST_BYTES = 512 * 1024;
/** VM -> host messages per drive. */
export const MAX_DYNAMIC_RPC_MESSAGES = 65_536;
/** Above MAX_WORKFLOW_ARTIFACT_BYTES (16 MiB) plus envelope. */
export const MAX_DYNAMIC_RPC_MESSAGE_BYTES = 17 * 1024 * 1024;
export const MAX_DYNAMIC_RPC_ARGS = 4;
export const MAX_DYNAMIC_HANDLE_REFS = 256;
export const MAX_DYNAMIC_VM_ERROR_CHARS = 1_024;
/** UI only, not in hostApi. */
export const MAX_DYNAMIC_APPROVAL_RENDER_BYTES = 64 * 1024;
export const DYNAMIC_VM_BOOT_TIMEOUT_MS = 10_000;
export const DYNAMIC_VM_MANIFEST_TIMEOUT_MS = 5_000;
export const DYNAMIC_VM_COMPUTE_TIMEOUT_MS = 30_000;
export const DYNAMIC_VM_SYNC_WAIT_MS = 30_000;
export const DYNAMIC_VM_ABORT_GRACE_MS = 1_000;
export const DYNAMIC_VM_RESOURCE_LIMITS = Object.freeze({
	maxOldGenerationSizeMb: 256,
	maxYoungGenerationSizeMb: 32,
	codeRangeSizeMb: 16,
	stackSizeMb: 4,
});
export const DYNAMIC_VM_CODE_GENERATION = Object.freeze({
	strings: false,
	wasm: false,
});
/** Equals the registry's ALLOWED_STATIC_IMPORTS. */
export const DYNAMIC_BUILTIN_MODULES = Object.freeze([
	"@vegardx/pi-workflow",
	"typebox",
] as const);
export const DYNAMIC_SHIM_EXPORTS = Object.freeze([
	"DEFAULT_WORKFLOW_CONCURRENCY",
	"MAX_WORKFLOW_CONCURRENCY",
	"WORKFLOW_CONTRACT_REVISION",
	"defineSupportTask",
	"defineWorkflow",
	"isArtifactHandle",
	"isTaskHandle",
	"isWorkflowDefinition",
] as const);
export const DYNAMIC_CONTEXT_PROPERTIES = Object.freeze([
	"cwd",
	"input",
	"runId",
	"signal",
] as const);
/** Exactly WorkflowContext (revision 17 added `handoff`). */
export const DYNAMIC_CONTEXT_METHODS = Object.freeze([
	"agent",
	"checkpoint",
	"fanIn",
	"fanOut",
	"finalize",
	"handoff",
	"log",
	"phase",
	"pipeline",
	"result",
	"results",
	"settled",
	"support",
	"workflow",
] as const);
export const DYNAMIC_SYNC_METHODS = Object.freeze([
	"agent",
	"agentInNamespace",
	"checkpoint",
	"finalize",
	"log",
	"phase",
	"support",
	"workflow",
] as const);
export const DYNAMIC_ASYNC_METHODS = Object.freeze([
	"handoff",
	"result",
	"results",
	"settled",
] as const);
/** Message types of the RPC union (`rpc.ts` re-exports this list). */
export const DYNAMIC_RPC_MESSAGE_TYPES = Object.freeze([
	"abort",
	"await",
	"call",
	"done",
	"failed",
	"ready",
	"reply",
	"start",
] as const);
export const DYNAMIC_TRANSFORMER_VERSION = "1.2.0";
export const DYNAMIC_TRANSFORMER = Object.freeze({
	name: "amaro",
	version: DYNAMIC_TRANSFORMER_VERSION,
	mode: "transform",
	options: Object.freeze({
		deprecatedTsModuleAsError: true,
		sourceMap: false,
		transform: Object.freeze({
			verbatimModuleSyntax: true,
			nativeClassProperties: true,
			noEmptyExport: true,
			importNotUsedAsValues: "preserve",
		}),
	}),
} as const);
