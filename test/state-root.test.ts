import { randomUUID } from "node:crypto";
import path from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	encodeWorkflowProjectKey,
	WORKFLOW_STATE_DIR_NAME,
	workflowStateRoot,
} from "../src/persistence/state-root.js";
import { useTempAgentDir } from "./fixtures/agent-dir.js";

function scratch(name: string): string {
	return path.resolve(".pi", "test-state-root", `${name}-${randomUUID()}`);
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("the project key", () => {
	// The pin. A project's sessions and its runs are sibling directories under
	// one key, so this encoding is Pi's and not ours to choose: if Pi changes
	// it, this literal is what fails.
	it("encodes a project path exactly as Pi encodes its sessions directory", () => {
		expect(encodeWorkflowProjectKey("/Users/x/src/proj")).toBe(
			"--Users-x-src-proj--",
		);
	});

	it("drops only the leading separator and rewrites separators and colons", () => {
		expect(encodeWorkflowProjectKey("/")).toBe("----");
		expect(encodeWorkflowProjectKey("/a")).toBe("--a--");
		expect(encodeWorkflowProjectKey("/srv/repos/a:b/proj")).toBe(
			"--srv-repos-a-b-proj--",
		);
		// Dots, dashes and spaces survive: only separators and colons move.
		expect(encodeWorkflowProjectKey("/home/dev/.local/my repo-2")).toBe(
			"--home-dev-.local-my repo-2--",
		);
	});

	it("resolves the path first, so two spellings of one project agree", () => {
		expect(encodeWorkflowProjectKey("/Users/x/src/proj/")).toBe(
			"--Users-x-src-proj--",
		);
		expect(encodeWorkflowProjectKey("/Users/x/src/other/../proj")).toBe(
			"--Users-x-src-proj--",
		);
	});

	// Stronger than the literal: Pi itself computes the key here, so a
	// divergence in either direction is caught even before Pi ships it.
	it("equals the key Pi names its own sessions directory with", async () => {
		const agentDir = await useTempAgentDir(scratch("sessions"));
		const cwd = path.join(scratch("project"), "proj");
		const sessionDir = SessionManager.create(cwd).getSessionDir();
		expect(path.dirname(sessionDir)).toBe(path.join(agentDir, "sessions"));
		expect(path.basename(sessionDir)).toBe(encodeWorkflowProjectKey(cwd));
	});
});

describe("the workflow state root", () => {
	it("is the project key under the agent dir's workflow directory", () => {
		expect(workflowStateRoot("/Users/x/src/proj", "/agent")).toBe(
			path.join("/agent", "workflow", "--Users-x-src-proj--"),
		);
		expect(WORKFLOW_STATE_DIR_NAME).toBe("workflow");
	});

	it("is a sibling of the project's sessions directory", async () => {
		const agentDir = await useTempAgentDir(scratch("sibling"));
		const cwd = "/Users/x/src/proj";
		expect(workflowStateRoot(cwd, agentDir)).toBe(
			path.join(agentDir, "workflow", path.basename(workflowStateRoot(cwd))),
		);
		expect(path.dirname(path.dirname(workflowStateRoot(cwd, agentDir)))).toBe(
			agentDir,
		);
	});

	it("keys two projects apart and one project together", () => {
		expect(workflowStateRoot("/a/one", "/agent")).not.toBe(
			workflowStateRoot("/a/two", "/agent"),
		);
		expect(workflowStateRoot("/a/one", "/agent")).toBe(
			workflowStateRoot("/a/one/", "/agent"),
		);
	});

	it("falls back to the host's agent dir when none is given", async () => {
		const agentDir = await useTempAgentDir(scratch("host"));
		expect(getAgentDir()).toBe(agentDir);
		expect(workflowStateRoot("/Users/x/src/proj")).toBe(
			path.join(agentDir, "workflow", "--Users-x-src-proj--"),
		);
	});

	it("never places state inside the project", () => {
		const cwd = "/Users/x/src/proj";
		expect(workflowStateRoot(cwd, "/agent").startsWith(cwd)).toBe(false);
	});
});
