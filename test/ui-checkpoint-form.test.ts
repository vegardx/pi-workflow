import { describe, expect, it, vi } from "vitest";
import type { WorkflowRunId, WorkflowTaskId } from "../src/contracts.js";
import type { WorkflowServiceRunView } from "../src/service-views.js";
import {
	CHECKPOINT_EXPIRED_MESSAGE,
	CHECKPOINT_OPTIONAL_HINT,
	CHECKPOINT_SKIP_OPTION,
	type CheckpointDialogOptions,
	type CheckpointFormOptions,
	type CheckpointFormTask,
	type CheckpointFormUi,
	collectCheckpointDecision,
	MAX_CHECKPOINT_FORM_ATTEMPTS,
} from "../src/ui/checkpoint-form.js";

const RUN_ID = "workflow_form0000000000000000000" as WorkflowRunId;
const TASK_ID = "task_form0001" as WorkflowTaskId;
const NOW = Date.parse("2026-09-16T12:00:00.000Z");

interface Recorded {
	kind: "select" | "input" | "confirm" | "editor" | "notify";
	title: string;
	options?: string[];
	message?: string;
	prefill?: string;
	level?: string;
	opts?: CheckpointDialogOptions | undefined;
}

/** A scripted `ctx.ui`: every dialog records its call and shifts one answer. */
function fakeUi(script: readonly unknown[]) {
	const calls: Recorded[] = [];
	const answers = [...script];
	const next = () => (answers.length > 0 ? answers.shift() : undefined);
	const ui: CheckpointFormUi = {
		async select(title, options, opts) {
			calls.push({ kind: "select", title, options: [...options], opts });
			return next() as string | undefined;
		},
		async input(title, _placeholder, opts) {
			calls.push({ kind: "input", title, opts });
			return next() as string | undefined;
		},
		async confirm(title, message, opts) {
			calls.push({ kind: "confirm", title, message, opts });
			const answer = next();
			return answer === undefined ? true : (answer as boolean);
		},
		async editor(title, prefill) {
			calls.push({ kind: "editor", title, ...(prefill ? { prefill } : {}) });
			return next() as string | undefined;
		},
		notify(message, level) {
			calls.push({
				kind: "notify",
				title: message,
				...(level ? { level } : {}),
			});
		},
	};
	return { ui, calls, remaining: () => answers.length };
}

function task(
	schema: unknown,
	checkpoint: Partial<CheckpointFormTask["checkpoint"]> = {},
): CheckpointFormTask {
	return {
		id: TASK_ID,
		namespace: ["review"],
		key: "approve",
		checkpoint: {
			prompt: "Approve the plan?",
			schema: schema as CheckpointFormTask["checkpoint"]["schema"],
			...checkpoint,
		},
	};
}

const runView = {
	runId: RUN_ID,
	status: "completed",
} as WorkflowServiceRunView;

function fakeService(
	...outcomes: readonly (Error | undefined)[]
): CheckpointFormOptions["service"] & {
	decide: ReturnType<typeof vi.fn>;
} {
	const queue = [...outcomes];
	const decide = vi.fn(async () => {
		const failure = queue.shift();
		if (failure) throw failure;
		return runView;
	});
	return { decide } as never;
}

function options(
	service: CheckpointFormOptions["service"],
	extra: Partial<CheckpointFormOptions> = {},
): CheckpointFormOptions {
	return { service, now: () => NOW, ...extra };
}

const run = { runId: RUN_ID };

describe("collectCheckpointDecision dialogs per schema shape", () => {
	it("asks a boolean as a select of JSON literals and records the answer", async () => {
		const { ui, calls } = fakeUi(["true — yes", true]);
		const service = fakeService();
		const outcome = await collectCheckpointDecision(
			{ ui },
			task({ type: "boolean" }),
			run,
			options(service),
		);
		expect(calls[0]?.kind).toBe("select");
		expect(calls[0]?.options).toEqual(["true — yes", "false — no"]);
		// The first dialog carries the shared body: prompt and answer shape.
		expect(calls[0]?.title).toContain("Approve the plan?");
		expect(calls[0]?.title).toContain("Answer: true or false");
		expect(calls[0]?.title).toContain("Decide review/approve");
		expect(calls[1]?.kind).toBe("confirm");
		expect(calls[1]?.title).toBe("Decide review/approve?");
		expect(calls[1]?.message).toContain("Decision: true");
		expect(calls[1]?.message).toContain(
			"The decision is recorded once, immutably, and the run continues from it.",
		);
		expect(service.decide).toHaveBeenCalledWith(RUN_ID, TASK_ID, {
			decision: true,
			approver: "pi-session",
		});
		expect(outcome).toEqual({
			decision: true,
			view: runView,
			taskKey: "review/approve",
		});
	});

	it("lists an enum's default first and marks it", async () => {
		const { ui, calls } = fakeUi(['"hold" — default']);
		const service = fakeService();
		const outcome = await collectCheckpointDecision(
			{ ui },
			task({ enum: ["ship", "hold", "revise"], default: "hold" }),
			run,
			options(service),
		);
		expect(calls[0]?.options).toEqual([
			'"hold" — default',
			'"ship"',
			'"revise"',
		]);
		expect(outcome?.decision).toBe("hold");
	});

	it("asks a string with the hint and the default in the title", async () => {
		const { ui, calls } = fakeUi(["ship it"]);
		const service = fakeService();
		const outcome = await collectCheckpointDecision(
			{ ui },
			task({ type: "string" }, { default: "none" }),
			run,
			options(service),
		);
		expect(calls[0]?.kind).toBe("input");
		// `input` ignores its placeholder, so the hint and default are in the title.
		expect(calls[0]?.title).toContain("text");
		expect(calls[0]?.title).toContain('Default: "none"');
		expect(outcome?.decision).toBe("ship it");
	});

	it("re-asks a number until it parses and satisfies its bounds", async () => {
		const { ui, calls } = fakeUi(["nope", "9", "4"]);
		const service = fakeService();
		const outcome = await collectCheckpointDecision(
			{ ui },
			task({ type: "integer", minimum: 1, maximum: 5 }),
			run,
			options(service),
		);
		expect(calls.filter((call) => call.kind === "input")).toHaveLength(3);
		expect(calls[1]?.title).toContain("Enter a whole number.");
		expect(calls[2]?.title).toContain("Enter a number of at most 5.");
		expect(outcome?.decision).toBe(4);
		// The shape hint comes from the shared one-line summary.
		expect(calls[0]?.title).toContain("a whole number between 1 and 5");
	});

	it("asks a flat object field by field, required first, optional skippable", async () => {
		const { ui, calls } = fakeUi([
			"true — yes",
			"",
			CHECKPOINT_SKIP_OPTION,
			true,
		]);
		const service = fakeService();
		const outcome = await collectCheckpointDecision(
			{ ui },
			task({
				type: "object",
				properties: {
					note: { type: "string" },
					urgent: { type: "boolean" },
					proceed: { type: "boolean" },
				},
				required: ["proceed"],
				additionalProperties: false,
			}),
			run,
			options(service),
		);
		const dialogs = calls.filter((call) => call.kind !== "confirm");
		expect(dialogs.map((call) => call.title.split("\n").at(-2))).toEqual([
			"proceed",
			`note ${CHECKPOINT_OPTIONAL_HINT}`,
			`urgent ${CHECKPOINT_OPTIONAL_HINT}`,
		]);
		expect(dialogs[2]?.options).toEqual([
			"true — yes",
			"false — no",
			CHECKPOINT_SKIP_OPTION,
		]);
		// Skipped optional properties are omitted, never sent as null.
		expect(outcome?.decision).toEqual({ proceed: true });
	});

	it("falls back to one JSON editor prefilled from the schema", async () => {
		const { ui, calls } = fakeUi(['{"items":["a"]}']);
		const service = fakeService();
		const outcome = await collectCheckpointDecision(
			{ ui },
			task({
				type: "object",
				properties: { items: { type: "array", items: { type: "string" } } },
				required: ["items"],
			}),
			run,
			options(service),
		);
		expect(calls[0]?.kind).toBe("editor");
		expect(calls[0]?.prefill).toBe('{\n  "items": []\n}');
		expect(outcome?.decision).toEqual({ items: ["a"] });
	});

	it("re-opens the editor with the reason when the text is not JSON", async () => {
		const { ui, calls } = fakeUi(["{oops", '{"items":[]}']);
		const service = fakeService();
		const outcome = await collectCheckpointDecision(
			{ ui },
			task({ type: "array", items: { type: "string" } }),
			run,
			options(service),
		);
		expect(calls[1]?.title).toContain("Checkpoint decision is not valid JSON.");
		expect(calls[1]?.prefill).toBe("{oops");
		expect(outcome?.decision).toEqual({ items: [] });
	});

	it("checks the expiry itself before opening an editor that has no timeout", async () => {
		const { ui, calls } = fakeUi([]);
		const service = fakeService();
		const outcome = await collectCheckpointDecision(
			{ ui },
			task(
				{ type: "array" },
				{ expiresAt: new Date(NOW - 1_000).toISOString() },
			),
			run,
			options(service),
		);
		expect(outcome).toBeUndefined();
		expect(calls).toEqual([
			{ kind: "notify", title: CHECKPOINT_EXPIRED_MESSAGE, level: "warning" },
		]);
		expect(service.decide).not.toHaveBeenCalled();
	});
});

describe("collectCheckpointDecision dismissal and confirmation", () => {
	it("records nothing when a field dialog is dismissed", async () => {
		const { ui, calls } = fakeUi([undefined]);
		const service = fakeService();
		await expect(
			collectCheckpointDecision(
				{ ui },
				task({ type: "boolean" }),
				run,
				options(service),
			),
		).resolves.toBeUndefined();
		expect(calls).toHaveLength(1);
		expect(service.decide).not.toHaveBeenCalled();
	});

	it("records nothing when a later field of an object is dismissed", async () => {
		const { ui } = fakeUi(["true — yes", undefined]);
		const service = fakeService();
		await expect(
			collectCheckpointDecision(
				{ ui },
				task({
					type: "object",
					properties: {
						proceed: { type: "boolean" },
						note: { type: "string" },
					},
					required: ["proceed", "note"],
				}),
				run,
				options(service),
			),
		).resolves.toBeUndefined();
		expect(service.decide).not.toHaveBeenCalled();
	});

	it("records nothing when the final confirm is declined", async () => {
		const { ui, calls } = fakeUi(["true — yes", false]);
		const service = fakeService();
		await expect(
			collectCheckpointDecision(
				{ ui },
				task({ type: "boolean" }),
				run,
				options(service),
			),
		).resolves.toBeUndefined();
		expect(calls.at(-1)?.kind).toBe("confirm");
		expect(service.decide).not.toHaveBeenCalled();
	});
});

describe("collectCheckpointDecision and the service's validation", () => {
	it("re-asks with the service's refusal as the dialog title", async () => {
		const refusal = new Error("Checkpoint decision does not match its schema.");
		const { ui, calls } = fakeUi(["true — yes", true, "false — no", true]);
		const service = fakeService(refusal);
		const outcome = await collectCheckpointDecision(
			{ ui },
			task({ type: "boolean" }),
			run,
			options(service),
		);
		const selects = calls.filter((call) => call.kind === "select");
		expect(selects).toHaveLength(2);
		expect(selects[1]?.title.startsWith(refusal.message)).toBe(true);
		expect(service.decide).toHaveBeenCalledTimes(2);
		expect(outcome?.decision).toBe(false);
	});

	it("gives up after the attempt cap and records nothing", async () => {
		const refusal = new Error("Checkpoint decision does not match its schema.");
		const { ui, calls } = fakeUi(
			Array.from({ length: MAX_CHECKPOINT_FORM_ATTEMPTS }, () => [
				"true — yes",
				true,
			]).flat(),
		);
		const service = fakeService(
			...Array.from({ length: MAX_CHECKPOINT_FORM_ATTEMPTS }, () => refusal),
		);
		await expect(
			collectCheckpointDecision(
				{ ui },
				task({ type: "boolean" }),
				run,
				options(service),
			),
		).resolves.toBeUndefined();
		expect(service.decide).toHaveBeenCalledTimes(MAX_CHECKPOINT_FORM_ATTEMPTS);
		expect(calls.at(-1)).toEqual({
			kind: "notify",
			title: refusal.message,
			level: "warning",
		});
	});

	it("ends on a refusal the form cannot fix", async () => {
		const { ui, calls } = fakeUi(["true — yes", true]);
		const service = fakeService(new Error("Checkpoint is already decided."));
		await expect(
			collectCheckpointDecision(
				{ ui },
				task({ type: "boolean" }),
				run,
				options(service),
			),
		).resolves.toBeUndefined();
		expect(service.decide).toHaveBeenCalledTimes(1);
		expect(calls.at(-1)).toEqual({
			kind: "notify",
			title: "Checkpoint is already decided.",
			level: "warning",
		});
	});

	it("passes the expiry countdown and the abort signal to every dialog", async () => {
		const controller = new AbortController();
		const { ui, calls } = fakeUi(["true — yes", true]);
		const service = fakeService();
		await collectCheckpointDecision(
			{ ui },
			task(
				{ type: "boolean" },
				{ expiresAt: new Date(NOW + 60_000).toISOString() },
			),
			run,
			options(service, { signal: controller.signal }),
		);
		for (const call of calls) {
			expect(call.opts).toEqual({
				timeout: 60_000,
				signal: controller.signal,
			});
		}
		expect(calls).toHaveLength(2);
	});

	it("passes no dialog options when the checkpoint has no expiry or signal", async () => {
		const { ui, calls } = fakeUi(["true — yes", true]);
		await collectCheckpointDecision(
			{ ui },
			task({ type: "boolean" }),
			run,
			options(fakeService()),
		);
		expect(calls.every((call) => call.opts === undefined)).toBe(true);
	});

	it("records the reason and the approver it was given", async () => {
		const { ui } = fakeUi(["true — yes", true]);
		const service = fakeService();
		await collectCheckpointDecision(
			{ ui },
			task({ type: "boolean" }),
			run,
			options(service, { reason: "Reviewed the plan" }),
		);
		expect(service.decide).toHaveBeenCalledWith(RUN_ID, TASK_ID, {
			decision: true,
			approver: "pi-session",
			reason: "Reviewed the plan",
		});
	});
});
