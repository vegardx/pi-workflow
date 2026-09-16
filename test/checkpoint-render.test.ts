import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	CHECKPOINT_DECIDE_INSTRUCTION,
	CHECKPOINT_JSON_ANSWER_SHAPE,
	checkpointSchemaSummary,
	checkpointTaskKey,
	MAX_CHECKPOINT_FLAT_PROPERTIES,
	MAX_CHECKPOINT_RENDER_BYTES,
	MAX_CHECKPOINT_SCHEMA_SUMMARY_LENGTH,
	renderCheckpointInputs,
	renderCheckpointPrompt,
} from "../src/checkpoint-render.js";

const RUN_ID = "workflow_renderfixture01";
const NOW = Date.parse("2026-09-15T12:05:00.000Z");
const EXPIRES_AT = "2026-09-15T12:09:00.000Z";

describe("checkpointSchemaSummary", () => {
	it("names the answer shape of every schema the guided form asks field by field", () => {
		expect(checkpointSchemaSummary({ type: "boolean" })).toBe("true or false");
		expect(checkpointSchemaSummary({ enum: ["ship", "hold"] })).toBe(
			'one of: "ship", "hold"',
		);
		expect(checkpointSchemaSummary({ const: "ship" })).toBe('one of: "ship"');
		expect(
			checkpointSchemaSummary({
				anyOf: [{ const: "ship" }, { const: "hold" }],
			}),
		).toBe('one of: "ship", "hold"');
		expect(
			checkpointSchemaSummary({ oneOf: [{ const: true }, { const: false }] }),
		).toBe("one of: true, false");
		expect(checkpointSchemaSummary({ type: "string" })).toBe("text");
		expect(checkpointSchemaSummary({ type: "number" })).toBe("a number");
		expect(
			checkpointSchemaSummary({ type: "integer", minimum: 1, maximum: 5 }),
		).toBe("a whole number between 1 and 5");
		expect(checkpointSchemaSummary({ type: "integer", minimum: 1 })).toBe(
			"a whole number, at least 1",
		);
		expect(checkpointSchemaSummary({ type: "number", maximum: 5 })).toBe(
			"a number, at most 5",
		);
		expect(
			checkpointSchemaSummary({
				type: "object",
				properties: {
					proceed: { type: "boolean" },
					note: { type: "string" },
				},
				required: ["proceed"],
			}),
		).toBe("{ proceed: boolean, note?: string }");
		// Required properties lead, whatever order the schema stores them in.
		expect(
			checkpointSchemaSummary({
				type: "object",
				properties: {
					note: { type: "string" },
					proceed: { type: "boolean" },
				},
				required: ["proceed"],
			}),
		).toBe("{ proceed: boolean, note?: string }");
		expect(
			checkpointSchemaSummary({
				type: "object",
				properties: { pick: { enum: ["a", "b"] } },
				required: ["pick"],
			}),
		).toBe('{ pick: "a" | "b" }');
	});

	it("falls back to JSON for everything the form answers in an editor", () => {
		for (const schema of [
			{ type: "array", items: { type: "string" } },
			{ type: "object" },
			{ type: "object", properties: {} },
			{
				type: "object",
				properties: { nested: { type: "object", properties: {} } },
			},
			{ oneOf: [{ type: "object" }, { const: "ship" }] },
			{ type: ["string", "null"] },
			{},
			"not a schema",
			undefined,
			null,
			[{ type: "boolean" }],
		]) {
			expect(checkpointSchemaSummary(schema)).toBe(
				CHECKPOINT_JSON_ANSWER_SHAPE,
			);
		}
		const wide = {
			type: "object",
			properties: Object.fromEntries(
				Array.from(
					{ length: MAX_CHECKPOINT_FLAT_PROPERTIES + 1 },
					(_, index) => [`field${index}`, { type: "boolean" }],
				),
			),
		};
		expect(checkpointSchemaSummary(wide)).toBe(CHECKPOINT_JSON_ANSWER_SHAPE);
		// One property short of the bound is still asked field by field.
		const narrow = {
			type: "object",
			properties: Object.fromEntries(
				Array.from({ length: MAX_CHECKPOINT_FLAT_PROPERTIES }, (_, index) => [
					`field${index}`,
					{ type: "boolean" },
				]),
			),
		};
		expect(checkpointSchemaSummary(narrow)).toContain("field0?: boolean");
	});

	it("stays one bounded line whatever the schema names", () => {
		const summary = checkpointSchemaSummary({
			enum: Array.from({ length: 64 }, (_, index) => `choice-${index}`),
		});
		expect(summary.length).toBeLessThanOrEqual(
			MAX_CHECKPOINT_SCHEMA_SUMMARY_LENGTH,
		);
		expect(summary.endsWith("…")).toBe(true);
		expect(summary).not.toContain("\n");
		const twelve = checkpointSchemaSummary({
			enum: Array.from({ length: 13 }, (_, index) => index),
		});
		expect(twelve).toBe(
			`one of: ${Array.from({ length: 12 }, (_, index) => index).join(", ")}, …`,
		);
		const multiline = checkpointSchemaSummary({
			type: "object",
			properties: { "a\nb": { type: "string" } },
		});
		expect(multiline).toBe("{ a b?: string }");
	});
});

describe("renderCheckpointInputs", () => {
	it("renders text as text and every other value as pretty JSON", () => {
		expect(
			renderCheckpointInputs({
				plan: "Ship on Friday.\nHold the migration.",
				handoff: { kind: "worktree", sha256: "abc" },
				count: 3,
			}),
		).toBe(
			[
				"plan:",
				"  Ship on Friday.",
				"  Hold the migration.",
				"",
				"handoff:",
				"  {",
				'    "kind": "worktree",',
				'    "sha256": "abc"',
				"  }",
				"",
				"count:",
				"  3",
			].join("\n"),
		);
		expect(renderCheckpointInputs({})).toBe("");
	});

	it("gives each input an equal share and ends a cut block with the notice", () => {
		const budget = 512;
		const rendered = renderCheckpointInputs(
			{ short: "fits", long: "x".repeat(4096) },
			{ budget, run: RUN_ID },
		);
		expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(budget);
		expect(rendered).toContain("short:\n  fits");
		expect(rendered).toContain(
			`/workflow show ${RUN_ID} for the full artifact.`,
		);
		// The notice names the share, not the whole budget.
		expect(rendered).toMatch(/… input cut at 255 bytes;/);
		// An input that fits is never cut.
		expect(rendered.split("\n\n")[0]).toBe("short:\n  fits");
	});

	it("stays within the render bound for inputs at the contract maximum", () => {
		const inputs = Object.fromEntries(
			Array.from({ length: 64 }, (_, index) => [
				`input${index}`,
				"y".repeat(8192),
			]),
		);
		const rendered = renderCheckpointInputs(inputs);
		expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(
			MAX_CHECKPOINT_RENDER_BYTES,
		);
		expect(rendered.startsWith("input0:")).toBe(true);
		expect(rendered).toContain("/workflow show <run> for the full artifact.");
	});

	it("returns the notice alone when the budget cannot hold one block", () => {
		const rendered = renderCheckpointInputs(
			{ plan: "x".repeat(1024) },
			{ budget: 16, run: RUN_ID },
		);
		expect(rendered).toBe(
			`… input cut at 16 bytes; /workflow show ${RUN_ID} for the full artifact.`,
		);
	});
});

describe("renderCheckpointPrompt", () => {
	const task = {
		namespace: ["release"],
		key: "approve",
		checkpoint: {
			prompt: "Approve the plan before the writer runs?",
			schema: {
				type: "object",
				properties: { proceed: { type: "boolean" } },
				required: ["proceed"],
			},
			expiresAt: EXPIRES_AT,
			inputs: { plan: "Ship on Friday." },
		},
	} as const;

	it("shows the header, the prompt, the inputs, and the answer shape", () => {
		expect(renderCheckpointPrompt(task, { runId: RUN_ID }, NOW)).toBe(
			[
				`Checkpoint release/approve · run ${RUN_ID.slice(0, 12)}… · expires in 4m`,
				"",
				"Approve the plan before the writer runs?",
				"",
				"Inputs:",
				"plan:",
				"  Ship on Friday.",
				"",
				"Answer: { proceed: boolean }",
			].join("\n"),
		);
		expect(checkpointTaskKey(task)).toBe("release/approve");
	});

	it("omits the expiry and the input section when the checkpoint has none", () => {
		const open = {
			namespace: [],
			key: "open",
			checkpoint: { prompt: "Proceed?", schema: { type: "boolean" } },
		};
		expect(renderCheckpointPrompt(open, { runId: "workflow_1" }, NOW)).toBe(
			[
				"Checkpoint open · run workflow_1",
				"",
				"Proceed?",
				"",
				"Answer: true or false",
			].join("\n"),
		);
	});

	it("stays within the render bound with a maximal prompt and maximal inputs", () => {
		const rendered = renderCheckpointPrompt(
			{
				namespace: [],
				key: "wordy",
				checkpoint: {
					prompt: "p".repeat(4096),
					schema: { type: "string" },
					inputs: Object.fromEntries(
						Array.from({ length: 64 }, (_, index) => [
							`input${index}`,
							"z".repeat(8192),
						]),
					),
				},
			},
			{ runId: RUN_ID },
			NOW,
		);
		expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(
			MAX_CHECKPOINT_RENDER_BYTES,
		);
		expect(rendered).toContain("p".repeat(4096));
		expect(rendered).toContain("input0:");
	});
});

describe("the decide instruction", () => {
	it("tells a model to surface the question and stop", () => {
		expect(CHECKPOINT_DECIDE_INSTRUCTION).toBe(
			"A person must answer this checkpoint. Pi prompts them in the session; surface the question and stop. Never decide it yourself, and do not poll the run.",
		);
		expect(MAX_CHECKPOINT_RENDER_BYTES).toBe(16 * 1024);
	});

	it("stays pure: no pi-tui, no service, and no path in the rendered text", async () => {
		const source = await readFile(
			path.resolve("src/checkpoint-render.ts"),
			"utf8",
		);
		expect(source).not.toMatch(/@earendil-works\/pi-tui/);
		expect(source).not.toMatch(/from\s+"\.\/service\.js"/);
		expect(source).not.toMatch(/node:fs/);
		// Only the two pure formatters reach this module from the UI layer.
		expect(source).toMatch(
			/import \{ formatUntil, shortId \} from "\.\/ui\/format\.js";/,
		);
	});
});
