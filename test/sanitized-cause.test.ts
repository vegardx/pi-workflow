import { describe, expect, it } from "vitest";
import {
	sanitizedCauseDetail,
	withSanitizedCause,
} from "../src/sanitized-cause.js";

/**
 * The seam carries a cause's own message only when that message is fixed by
 * construction. These are the two gates: a known error name, and a message
 * that still looks like a fixed one.
 */

/** An error as it arrives from another module graph: name, message, cause. */
function foreign(name: string, message: string, cause?: unknown): unknown {
	const error = new Error(message, cause === undefined ? {} : { cause });
	error.name = name;
	return error;
}

const REVISION_REFUSAL =
	"run record uses contract revision 6; expected 7. Discard incompatible persisted state before continuing.";

describe("sanitized cause detail", () => {
	it("carries a fixed message from a known pi-subagent error", () => {
		expect(
			sanitizedCauseDetail(
				foreign("IncompatibleContractRevisionError", REVISION_REFUSAL),
			),
		).toBe(REVISION_REFUSAL);
		expect(
			sanitizedCauseDetail(
				foreign(
					"SubagentServiceProviderError",
					"No pi-subagent service provider is registered.",
				),
			),
		).toBe("No pi-subagent service provider is registered.");
	});

	it("finds the fixed message beneath an unnamed wrapper", () => {
		const wrapped = new Error("wrapper", {
			cause: foreign("PersistenceCorruptionError", "invalid run record JSON"),
		});
		expect(sanitizedCauseDetail(wrapped)).toBe("invalid run record JSON");
	});

	it("drops a message from an error this package does not know", () => {
		expect(
			sanitizedCauseDetail(new Error("ENOENT: open failed")),
		).toBeUndefined();
		expect(
			sanitizedCauseDetail(foreign("TypeError", "x is not a function")),
		).toBeUndefined();
	});

	it("drops a known error whose message stopped looking fixed", () => {
		const cases = [
			"failed reading /Users/someone/.config/pi/agent/subagents/service",
			"failed at file:///opt/pi/service.js",
			"failed\n  at Object.<anonymous>",
			`failed: ${"detail ".repeat(60)}`,
			"failed at C:\\Users\\someone\\store",
		];
		for (const message of cases) {
			expect(
				sanitizedCauseDetail(foreign("PersistenceCorruptionError", message)),
			).toBeUndefined();
		}
	});

	it("stops walking a cause chain rather than following it forever", () => {
		let deep: unknown = foreign(
			"RunLeaseFencedError",
			"run lease fenced: run_deep",
		);
		for (let depth = 0; depth < 6; depth += 1) {
			deep = new Error("wrapper", { cause: deep });
		}
		expect(sanitizedCauseDetail(deep)).toBeUndefined();
	});

	it("ignores a cycle and a non-error cause", () => {
		const cyclic = new Error("wrapper") as Error & { cause?: unknown };
		cyclic.cause = cyclic;
		expect(sanitizedCauseDetail(cyclic)).toBeUndefined();
		expect(sanitizedCauseDetail("plain string")).toBeUndefined();
		expect(sanitizedCauseDetail(undefined)).toBeUndefined();
	});
});

describe("withSanitizedCause", () => {
	it("appends the cause to the fixed message, with one separator", () => {
		expect(
			withSanitizedCause(
				"Failed to acquire the shared pi-subagent service.",
				foreign("IncompatibleContractRevisionError", REVISION_REFUSAL),
			),
		).toBe(
			`Failed to acquire the shared pi-subagent service: ${REVISION_REFUSAL}`,
		);
	});

	it("leaves the fixed message exactly as it was when nothing qualifies", () => {
		expect(
			withSanitizedCause(
				"Failed to acquire the shared pi-subagent service.",
				new Error("ENOENT: /var/folders/x"),
			),
		).toBe("Failed to acquire the shared pi-subagent service.");
	});
});
