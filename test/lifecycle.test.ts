import { describe, expect, it } from "vitest";
import {
	InvalidWorkflowRunTransitionError,
	InvalidWorkflowTaskTransitionError,
	transitionWorkflowRunStatus,
	transitionWorkflowTaskStatus,
} from "../src/lifecycle.js";

describe("workflow lifecycle", () => {
	it("allows a durable successful run path", () => {
		expect(transitionWorkflowRunStatus("created", "running")).toBe("running");
		expect(transitionWorkflowRunStatus("running", "finalizing")).toBe(
			"finalizing",
		);
		expect(transitionWorkflowRunStatus("finalizing", "completed")).toBe(
			"completed",
		);
	});

	it("rejects transitions out of completed runs", () => {
		expect(() => transitionWorkflowRunStatus("completed", "running")).toThrow(
			InvalidWorkflowRunTransitionError,
		);
	});

	it("represents launched queued and stopping tasks", () => {
		expect(transitionWorkflowTaskStatus("ready", "waiting")).toBe("waiting");
		expect(transitionWorkflowTaskStatus("ready", "cancelling")).toBe(
			"cancelling",
		);
	});

	it("lets a waiting checkpoint be cancelled directly", () => {
		expect(transitionWorkflowTaskStatus("waiting", "cancelled")).toBe(
			"cancelled",
		);
	});

	it("allows task retry attempts without replacing task identity", () => {
		expect(transitionWorkflowTaskStatus("failed", "running")).toBe("running");
		expect(transitionWorkflowTaskStatus("interrupted", "running")).toBe(
			"running",
		);
	});

	it("lets interrupted children settle without release", () => {
		expect(transitionWorkflowTaskStatus("cancelling", "interrupted")).toBe(
			"interrupted",
		);
		expect(transitionWorkflowRunStatus("finalizing", "interrupted")).toBe(
			"interrupted",
		);
	});

	it("allows completed tasks to be invalidated but not restarted directly", () => {
		expect(transitionWorkflowTaskStatus("completed", "invalidated")).toBe(
			"invalidated",
		);
		expect(() => transitionWorkflowTaskStatus("completed", "running")).toThrow(
			InvalidWorkflowTaskTransitionError,
		);
	});

	it("keeps cleanup-blocked distinct until cleanup resolves", () => {
		expect(transitionWorkflowTaskStatus("cleanup-blocked", "failed")).toBe(
			"failed",
		);
		expect(transitionWorkflowRunStatus("cleanup-blocked", "finalizing")).toBe(
			"finalizing",
		);
	});
});
