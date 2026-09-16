import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
	DYNAMIC_TRANSFORMER,
	DYNAMIC_TRANSFORMER_VERSION,
} from "./constants.js";

export { DYNAMIC_TRANSFORMER, DYNAMIC_TRANSFORMER_VERSION };

/**
 * The installed transformer must be the exact version named in
 * `hostApiSha256`; amaro does not export its package.json, so the version is
 * read from the package directory that `require.resolve("amaro")` lands in.
 */
export function installedDynamicTransformerVersion(): string | undefined {
	try {
		const require = createRequire(import.meta.url);
		const entry = require.resolve("amaro");
		const manifestPath = path.join(
			path.dirname(path.dirname(entry)),
			"package.json",
		);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			name?: unknown;
			version?: unknown;
		};
		if (manifest.name !== "amaro" || typeof manifest.version !== "string") {
			return undefined;
		}
		return manifest.version;
	} catch {
		return undefined;
	}
}

/** Called at service construction and in the worker before any transform. */
export function assertDynamicTransformerVersion(): void {
	if (installedDynamicTransformerVersion() !== DYNAMIC_TRANSFORMER_VERSION) {
		throw new Error("dynamic workflow transformer version mismatch");
	}
}
