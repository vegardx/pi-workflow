import { createHash } from "node:crypto";
import type { SupportImplementation } from "./contracts.js";

/*
 * Leaf module: the canonical JSON digest every pi-workflow identity is built
 * from. It reproduces pi-subagent's `canonicalSha256` (sorted keys, `-0`
 * normalised to `0`, non-finite numbers, `undefined` fields, and cycles
 * refused) so the dynamic-workflow worker can derive support identities
 * without loading the pi-subagent module graph; `test/execution.test.ts`
 * pins the two implementations to each other.
 */

function normalize(value: unknown, seen: Set<object>): unknown {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("non-finite canonical number");
		return Object.is(value, -0) ? 0 : value;
	}
	if (Array.isArray(value)) return value.map((item) => normalize(item, seen));
	if (typeof value !== "object") {
		throw new Error(`non-serializable canonical value: ${typeof value}`);
	}
	if (seen.has(value)) throw new Error("cyclic canonical value");
	seen.add(value);
	try {
		const record = value as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) {
			if (record[key] === undefined) {
				throw new Error(`undefined canonical field: ${key}`);
			}
			result[key] = normalize(record[key], seen);
		}
		return result;
	} finally {
		seen.delete(value);
	}
}

/** Canonical JSON text of `value`: the bytes every digest below hashes. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(normalize(value, new Set()));
}

export function deriveJsonValueSha256(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function deriveSupportImplementationIdentitySha256(
	implementation: SupportImplementation,
): string {
	return deriveJsonValueSha256({
		implementationSha256: implementation.implementationSha256,
		moduleSpecifier: implementation.moduleSpecifier,
		name: implementation.name,
		outputSchema: implementation.outputSchema,
		parametersSchema: implementation.parametersSchema,
		revision: implementation.revision,
	});
}
