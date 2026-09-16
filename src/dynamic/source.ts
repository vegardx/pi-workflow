import { createHash } from "node:crypto";
import { parse } from "@babel/parser";
import {
	assertSupportedImports,
	WorkflowDefinitionLoadError,
} from "../registry.js";
import {
	DYNAMIC_REF_PATTERN,
	DYNAMIC_REF_PREFIX,
	MAX_DYNAMIC_SOURCE_BYTES,
} from "./constants.js";

/**
 * An intake refusal. `code` is the WorkflowServiceError code the service
 * rethrows it under; `message` is final.
 */
export class DynamicSourceIntakeError extends Error {
	constructor(
		readonly code: "validation",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "DynamicSourceIntakeError";
	}
}

export interface DynamicSourceIdentity {
	readonly sourceSha256: string;
	readonly sourceBytes: number;
}

/** `dynamic:<sourceSha256>` -> digest; anything else -> `undefined`. */
export function parseDynamicRef(ref: unknown): string | undefined {
	if (typeof ref !== "string" || !DYNAMIC_REF_PATTERN.test(ref)) {
		return undefined;
	}
	return ref.slice(DYNAMIC_REF_PREFIX.length);
}

export function isDynamicRef(ref: unknown): ref is `dynamic:${string}` {
	return typeof ref === "string" && ref.startsWith(DYNAMIC_REF_PREFIX);
}

export function dynamicRef(sourceSha256: string): `dynamic:${string}` {
	return `${DYNAMIC_REF_PREFIX}${sourceSha256}`;
}

/** sha256 over the UTF-8 bytes of the source exactly as proposed. */
export function deriveDynamicSourceSha256(source: string): string {
	return createHash("sha256").update(source, "utf8").digest("hex");
}

function invalid(message: string, cause?: unknown): DynamicSourceIntakeError {
	return new DynamicSourceIntakeError(
		"validation",
		message,
		cause === undefined ? undefined : { cause },
	);
}

/**
 * Type, emptiness, size, and UTF-8 bounds; returns the source identity.
 */
export function assertDynamicSourceBounds(
	source: unknown,
): DynamicSourceIdentity {
	if (typeof source !== "string") {
		throw invalid("Dynamic workflow source must be a string.");
	}
	const sourceBytes = Buffer.byteLength(source, "utf8");
	if (sourceBytes < 1) throw invalid("Dynamic workflow source is empty.");
	if (sourceBytes > MAX_DYNAMIC_SOURCE_BYTES) {
		throw invalid(
			`Dynamic workflow source exceeds ${MAX_DYNAMIC_SOURCE_BYTES} bytes.`,
		);
	}
	const encoded = Buffer.from(source, "utf8");
	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
	} catch (error) {
		throw invalid("Dynamic workflow source is not valid UTF-8.", error);
	}
	if (decoded !== source || source.includes("�")) {
		throw invalid("Dynamic workflow source is not valid UTF-8.");
	}
	return Object.freeze({
		sourceSha256: deriveDynamicSourceSha256(source),
		sourceBytes,
	});
}

/**
 * The registry's import gate applied to a dynamic source: allowed imports are
 * exactly `@vegardx/pi-workflow`, `typebox`, and the registered support
 * module specifiers; its messages are forwarded verbatim.
 */
export function assertDynamicSourceImports(
	source: string,
	sourceSha256: string,
	allowedSupportImports: Iterable<string>,
): void {
	try {
		assertSupportedImports(
			source,
			dynamicRef(sourceSha256),
			new Set(allowedSupportImports),
		);
	} catch (error) {
		if (error instanceof WorkflowDefinitionLoadError) {
			throw invalid(error.message, error);
		}
		throw error;
	}
}

type ModuleNode = Record<string, unknown> & { readonly type: string };

/**
 * Dynamic-only rules: no `import.meta`; exactly one default export and no
 * named or re-exports. Top-level await is permitted (parity with the static
 * loader's `async: true`).
 */
export function assertDynamicSourceRules(source: string): void {
	let ast: unknown;
	try {
		ast = parse(source, {
			sourceType: "module",
			plugins: ["typescript", "importAttributes", "topLevelAwait"],
		});
	} catch (error) {
		throw invalid("workflow definition syntax is invalid", error);
	}
	let defaultExports = 0;
	let otherExports = 0;
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const child of value) visit(child);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		const node = value as ModuleNode;
		if (node.type === "MetaProperty") {
			throw invalid("dynamic workflow source may not use import.meta");
		}
		if (node.type === "ExportDefaultDeclaration") defaultExports += 1;
		if (
			node.type === "ExportNamedDeclaration" ||
			node.type === "ExportAllDeclaration"
		) {
			otherExports += 1;
		}
		for (const [key, child] of Object.entries(node)) {
			if (key === "loc" || key === "start" || key === "end") continue;
			visit(child);
		}
	};
	visit(ast);
	if (defaultExports !== 1 || otherExports !== 0) {
		throw invalid(
			"dynamic workflow source must have exactly one default export and no named exports",
		);
	}
}

/**
 * The whole intake gate of `service.propose` before the manifest VM: bounds,
 * the registry import gate, and the dynamic-only rules, in that order.
 */
export function assertDynamicSourceIntake(
	source: unknown,
	options: { readonly allowedSupportImports: Iterable<string> },
): DynamicSourceIdentity {
	const identity = assertDynamicSourceBounds(source);
	assertDynamicSourceImports(
		source as string,
		identity.sourceSha256,
		options.allowedSupportImports,
	);
	assertDynamicSourceRules(source as string);
	return identity;
}
