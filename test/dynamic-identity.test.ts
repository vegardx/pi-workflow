import { describe, expect, it } from "vitest";
import {
	DYNAMIC_ASYNC_METHODS,
	DYNAMIC_CONTEXT_METHODS,
	DYNAMIC_CONTEXT_PROPERTIES,
	DYNAMIC_RPC_MESSAGE_TYPES,
	DYNAMIC_SYNC_METHODS,
	DYNAMIC_TRANSFORMER,
	DYNAMIC_TRANSFORMER_VERSION,
} from "../src/dynamic/constants.js";
import type { DynamicSupportHelperSpec } from "../src/dynamic/contracts.js";
import {
	deriveDynamicHostApiSha256,
	deriveDynamicImportPolicySha256,
} from "../src/dynamic/identity.js";
import { installedDynamicTransformerVersion } from "../src/dynamic/transformer-identity.js";

/**
 * Pinned `hostApiSha256` (revision 18 dynamic spec, section 9).
 *
 * `deriveDynamicHostApiSha256()` is a build-time constant over everything the
 * VM frontend exposes to dynamic source. This literal is the only place the
 * value is written down, so any change to an input fails this test and forces
 * a deliberate review. Bump rule:
 *
 * - The digest is stored in every proposal record and every `source-approval`
 *   decision; a changed digest therefore invalidates EVERY existing dynamic
 *   approval (approved sources drop back to `proposed` and must be
 *   re-approved by an operator). Update the literal only when that outcome is
 *   intended, and say so in the commit message.
 * - Behavioural changes to the shim, the RPC bridge, or the worker that no
 *   constant captures (a method that starts returning a different shape, a
 *   new stubbed global, a barrier rule change) MUST bump
 *   `DYNAMIC_HOST_API_REVISION`, which is itself an input and thus rotates
 *   this digest. Never change semantics without rotating the digest.
 *
 * Inputs covered by construction (all inside `deriveDynamicHostApiSha256`):
 * `DYNAMIC_HOST_API_REVISION`, `WORKFLOW_CONTRACT_REVISION`,
 * `DYNAMIC_BUILTIN_MODULES`, `DYNAMIC_SHIM_EXPORTS`,
 * `DYNAMIC_CONTEXT_PROPERTIES`, `DYNAMIC_CONTEXT_METHODS`,
 * `DYNAMIC_SYNC_METHODS`, `DYNAMIC_ASYNC_METHODS`,
 * `DYNAMIC_RPC_MESSAGE_TYPES`, the determinism-aid globals list
 * (`Date`, `Math.random`, `console`), `DYNAMIC_VM_CODE_GENERATION`,
 * `DYNAMIC_VM_RESOURCE_LIMITS`, every `DYNAMIC_VM_*_MS` timeout,
 * `MAX_DYNAMIC_SOURCE_BYTES`, `MAX_DYNAMIC_MANIFEST_BYTES`,
 * `MAX_DYNAMIC_RPC_MESSAGES`, `MAX_DYNAMIC_RPC_MESSAGE_BYTES`,
 * `MAX_DYNAMIC_RPC_ARGS`, `MAX_DYNAMIC_HANDLE_REFS`,
 * `MAX_DYNAMIC_VM_ERROR_CHARS`, and `DYNAMIC_TRANSFORMER` (name, version,
 * mode, and every option). Deliberately excluded (spec section 2):
 * `MAX_DYNAMIC_PROPOSALS`, `MAX_DYNAMIC_PROPOSAL_RECORD_BYTES`,
 * `MAX_DYNAMIC_APPROVAL_RENDER_BYTES`, `DYNAMIC_REF_PREFIX`,
 * `DYNAMIC_REF_PATTERN`.
 */
const HOST_API_SHA256 =
	"7bfd62636553197b4897d475e89ddf7e5cb0f0217bee0c1de0a092151d199eba";

/** `deriveDynamicImportPolicySha256([])`: builtin modules only. */
const IMPORT_POLICY_EMPTY_SHA256 =
	"4c21c9f762e1e82a6f0dfbdef0328633a92fb570027b6e0a890f176c5fb7b33c";
/** `deriveDynamicImportPolicySha256([digestHelper])`. */
const IMPORT_POLICY_DIGEST_SHA256 =
	"6f81a47d6eec42168193896f65ef551f4b3f8b748db22ea31153409f92039c78";
/** `deriveDynamicImportPolicySha256([digestHelper, summarizeHelper])`. */
const IMPORT_POLICY_BOTH_SHA256 =
	"7bd3a0515f4ba16208047e40ab628fe16a3eaec90b25da5f89a8a61b0a8d8440";

const digestHelper: DynamicSupportHelperSpec = {
	name: "digest",
	moduleSpecifier: "@acme/tools",
	revision: 1,
	implementationSha256: "b".repeat(64),
	parametersSchema: { type: "object", additionalProperties: false },
	outputSchema: { type: "string" },
	exportName: "digest",
};

const summarizeHelper: DynamicSupportHelperSpec = {
	name: "summarize",
	moduleSpecifier: "@acme/tools",
	revision: 2,
	implementationSha256: "c".repeat(64),
	parametersSchema: {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
		additionalProperties: false,
	},
	outputSchema: { type: "string" },
	exportName: "summarize",
};

describe("dynamic host API identity", () => {
	it("pins hostApiSha256 to its recorded literal", () => {
		expect(deriveDynamicHostApiSha256()).toBe(HOST_API_SHA256);
	});

	it("pins the surface lists the digest is computed over", () => {
		// Readable diffs for the list-shaped inputs; the digest above already
		// fails on any change, these say which list moved.
		expect([...DYNAMIC_CONTEXT_PROPERTIES]).toEqual([
			"cwd",
			"input",
			"runId",
			"signal",
		]);
		expect([...DYNAMIC_CONTEXT_METHODS]).toEqual([
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
		]);
		expect([...DYNAMIC_SYNC_METHODS]).toEqual([
			"agent",
			"agentInNamespace",
			"checkpoint",
			"finalize",
			"log",
			"phase",
			"support",
			"workflow",
		]);
		expect([...DYNAMIC_ASYNC_METHODS]).toEqual([
			"handoff",
			"result",
			"results",
			"settled",
		]);
		expect([...DYNAMIC_RPC_MESSAGE_TYPES]).toEqual([
			"abort",
			"await",
			"call",
			"done",
			"failed",
			"ready",
			"reply",
			"start",
		]);
	});

	it("pins the transformer identity to the installed amaro", () => {
		expect(DYNAMIC_TRANSFORMER_VERSION).toBe("1.2.0");
		expect(DYNAMIC_TRANSFORMER.name).toBe("amaro");
		expect(DYNAMIC_TRANSFORMER.version).toBe(DYNAMIC_TRANSFORMER_VERSION);
		expect(installedDynamicTransformerVersion()).toBe(
			DYNAMIC_TRANSFORMER_VERSION,
		);
	});
});

describe("dynamic import policy identity", () => {
	it("pins the empty helper set", () => {
		expect(deriveDynamicImportPolicySha256([])).toBe(
			IMPORT_POLICY_EMPTY_SHA256,
		);
		expect(IMPORT_POLICY_EMPTY_SHA256).not.toBe(HOST_API_SHA256);
	});

	it("pins a fixed helper fixture independent of registration order", () => {
		expect(deriveDynamicImportPolicySha256([digestHelper])).toBe(
			IMPORT_POLICY_DIGEST_SHA256,
		);
		expect(
			deriveDynamicImportPolicySha256([digestHelper, summarizeHelper]),
		).toBe(IMPORT_POLICY_BOTH_SHA256);
		expect(
			deriveDynamicImportPolicySha256([summarizeHelper, digestHelper]),
		).toBe(IMPORT_POLICY_BOTH_SHA256);
	});

	it("includes exportName in the digest", () => {
		expect(
			deriveDynamicImportPolicySha256([
				{ ...digestHelper, exportName: "renamed" },
			]),
		).not.toBe(IMPORT_POLICY_DIGEST_SHA256);
		expect(
			deriveDynamicImportPolicySha256([
				{ ...digestHelper, exportName: "renamed" },
			]),
		).not.toBe(IMPORT_POLICY_EMPTY_SHA256);
	});
});
