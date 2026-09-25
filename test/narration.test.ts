import { describe, expect, it } from "vitest";
import {
	isNarratedFailure,
	isNarratedTerminalStatus,
	MAX_NARRATION_SUMMARY_LENGTH,
	NARRATED_TASK_KINDS,
	narrationSummary,
	taskNarration,
} from "../src/narration.js";
import { sanitizedTaskFailureCause } from "../src/sanitized-cause.js";

// What a host needs to narrate a run, as a pure derivation over a task key.
// Every expectation is the documented key convention of
// `workflows/plan-to-ship.workflow.ts`, never this module's implementation.

describe("taskNarration", () => {
	it.each([
		["implement-d0", [], "implement", "d0"],
		["check-d0", [], "check", "d0"],
		["check-d0-verify-1", [], "check", "d0-verify-1"],
		["synthesis-d0", [], "synthesis", "d0"],
		["fix-d0", [], "fix", "d0"],
		["refine", [], "refine", undefined],
		["fix-my-thing", [], "fix", "my-thing"],
	] as const)(
		"narrates %s as %s of %s",
		(key, namespace, taskKind, deliverable) => {
			const narration = taskNarration({
				namespace: [...namespace],
				key,
				kind: "agent",
			});
			expect(narration.stage).toBe(key);
			expect(narration.taskKind).toBe(taskKind);
			expect(narration.deliverable).toBe(deliverable);
		},
	);

	it("narrates a fan-out member as its namespace's kind, with the full stage key", () => {
		// A lens IS a review, and the stage key a person is shown is the path.
		const narration = taskNarration({
			namespace: ["review-d0"],
			key: "correctness",
			kind: "agent",
		});
		expect(narration).toMatchObject({
			stage: "review-d0/correctness",
			taskKind: "review",
			deliverable: "d0",
		});
	});

	it("narrates every checkpoint as a gate, whatever it is called", () => {
		for (const key of ["ship", "approve-d0", "anything"]) {
			expect(
				taskNarration({ namespace: [], key, kind: "checkpoint" }).taskKind,
			).toBe("gate");
		}
	});

	it("answers `other` for a key this convention does not name", () => {
		// A project definition names its tasks as it likes; `other` plus the key
		// is exactly as much as this package can truthfully say about it.
		for (const key of ["draft", "summarise-things", "x-d0"]) {
			const narration = taskNarration({ namespace: [], key, kind: "agent" });
			expect(narration.taskKind).toBe("other");
			expect(narration.deliverable).toBeUndefined();
			expect(narration.stage).toBe(key);
		}
	});

	it("carries a summary and a cause only when it is given them", () => {
		const bare = taskNarration({ namespace: [], key: "refine", kind: "agent" });
		expect("summary" in bare).toBe(false);
		expect("cause" in bare).toBe(false);
		const full = taskNarration({
			namespace: [],
			key: "refine",
			kind: "agent",
			summary: "Refined.",
			cause: "The task ended failed.",
		});
		expect(full).toMatchObject({
			summary: "Refined.",
			cause: "The task ended failed.",
		});
	});

	it("names the eight kinds a narrator branches on", () => {
		expect([...NARRATED_TASK_KINDS]).toEqual([
			"implement",
			"check",
			"review",
			"synthesis",
			"fix",
			"gate",
			"refine",
			"other",
		]);
	});
});

describe("narrationSummary", () => {
	it("prefers the agent's own words", () => {
		expect(
			narrationSummary({ summary: "Edited a.txt", files: ["a.txt"] }),
		).toBe("Edited a.txt");
		expect(narrationSummary({ verdict: "One lens asked for a test." })).toBe(
			"One lens asked for a test.",
		);
		expect(narrationSummary({ answer: "42" })).toBe("42");
		expect(narrationSummary({ synthesis: "Agreed." })).toBe("Agreed.");
	});

	it("renders a structured result it has never seen", () => {
		const summary = narrationSummary({
			findings: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
			checkPassed: true,
		});
		expect(summary).toBe("{findings: [4 item(s)], checkPassed: true}");
	});

	it("collapses whitespace and cuts to the bound", () => {
		expect(narrationSummary({ summary: " a \n\n b " })).toBe("a b");
		const long = narrationSummary({ summary: "x".repeat(5_000) });
		expect(long?.length).toBe(MAX_NARRATION_SUMMARY_LENGTH);
		expect(long?.endsWith("…")).toBe(true);
	});

	it("answers undefined for a value with nothing to say", () => {
		for (const value of [undefined, null, "", "   ", [], {}]) {
			expect(narrationSummary(value)).toBeUndefined();
		}
	});
});

describe("sanitizedTaskFailureCause", () => {
	it("composes a subagent failure from the closed vocabularies", () => {
		expect(
			sanitizedTaskFailureCause(
				{
					kind: "subagent",
					status: "failed",
					failure: { code: "model-output", origin: "model", retry: "never" },
				},
				"failed",
			),
		).toBe(
			"The delegated run failed: model-output (origin model, retry never).",
		);
	});

	it("carries no child prose, whatever the failure said", () => {
		// `test/service-read.test.ts` pins that an inspection carries no child
		// prose: a classified failure's message is up to 4096 characters of
		// whatever the child or the provider said. The cause is composed, never
		// quoted, so there is nothing to leak and nothing to gate.
		// The parameter type has no `message` at all, so a caller cannot pass one
		// even by accident; this widens it only to prove the sentence ignores it.
		const failure = {
			code: "sandbox",
			origin: "sandbox",
			retry: "backoff",
			message: "could not open /Users/someone/secret/file.ts",
		};
		const cause = sanitizedTaskFailureCause(
			{ kind: "subagent", status: "failed", failure },
			"failed",
		);
		expect(cause).toBe(
			"The delegated run failed: sandbox (origin sandbox, retry backoff).",
		);
		expect(cause).not.toContain("/Users");
	});

	it("names the workflow stage when the runtime failed rather than the child", () => {
		expect(
			sanitizedTaskFailureCause(
				{ kind: "workflow", stage: "handoff-import" },
				"failed",
			),
		).toBe("The run failed at handoff-import.");
	});

	it("says something even with no classified failure at all", () => {
		expect(
			sanitizedTaskFailureCause(
				{ kind: "subagent", status: "failed" },
				"failed",
			),
		).toBe("The delegated run ended failed with no classified failure.");
	});

	it("falls back to the outcome when there is no evidence", () => {
		expect(sanitizedTaskFailureCause(undefined, "interrupted")).toBe(
			"The task ended interrupted.",
		);
	});
});

describe("the terminal predicates", () => {
	it("counts every status a narrator reports on, and no live one", () => {
		for (const status of [
			"completed",
			"failed",
			"cancelled",
			"interrupted",
			"invalidated",
			"blocked",
			"cleanup-blocked",
		] as const) {
			expect(isNarratedTerminalStatus(status)).toBe(true);
		}
		for (const status of [
			"pending",
			"ready",
			"running",
			"waiting",
			"cancelling",
		] as const) {
			expect(isNarratedTerminalStatus(status)).toBe(false);
		}
	});

	it("calls every outcome but `completed` a failure", () => {
		expect(isNarratedFailure(undefined)).toBe(false);
		expect(isNarratedFailure("completed")).toBe(false);
		for (const outcome of [
			"failed",
			"cancelled",
			"interrupted",
			"cleanup-blocked",
		] as const) {
			expect(isNarratedFailure(outcome)).toBe(true);
		}
	});
});
