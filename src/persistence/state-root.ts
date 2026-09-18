import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Where a project's durable run state lives.
 *
 * Run state — runs, leases, prune trash, and dynamic workflow proposals — is
 * not project content. It is machine-local recovery state about work done in
 * a project, so it lives under the Pi agent directory, keyed by the project
 * path, exactly as Pi keys its own sessions directory:
 *
 * ```text
 * <agentDir>/sessions/<projectKey>/   Pi's own session files
 * <agentDir>/workflow/<projectKey>/   this package's run state
 * ```
 *
 * A project's sessions and its runs are then sibling folders under one key.
 *
 * Workflow **definitions** are the opposite: `<cwd>/workflows`,
 * `<cwd>/.pi/workflows` and `<cwd>/.pi/agents` are source and discovery, are
 * read and reviewed with the project, and stay in the project.
 */

/** The `workflow` directory under the agent dir; the project key's parent. */
export const WORKFLOW_STATE_DIR_NAME = "workflow";

/**
 * Pi's project-key encoding, reimplemented here because Pi does not export
 * it (`core/session-manager.ts`, `getDefaultSessionDirPath`): the resolved
 * path with its leading separator dropped, every remaining separator and
 * colon turned into `-`, wrapped in `--`. `/Users/x/src/proj` becomes
 * `--Users-x-src-proj--`.
 *
 * Pi resolves with `utils/paths.ts` `resolvePath`, which normalizes and
 * `path.resolve`s but deliberately does **not** call `realpath`: a symlinked
 * project path keys separately from its real path, for sessions and so for
 * runs too. This mirrors that, so the two directories never drift apart.
 *
 * If Pi ever changes its encoding the two stop being siblings; the pinned
 * literal in `test/state-root.test.ts` is what catches that.
 */
export function encodeWorkflowProjectKey(cwd: string): string {
	const resolved = path.resolve(cwd);
	return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * The store root `createWorkflowService` takes for a project. `agentDir`
 * defaults to the host's (`getAgentDir()`); every caller that can name one —
 * an embedder, a test — passes it, so nothing writes to the real agent
 * directory by accident.
 */
export function workflowStateRoot(cwd: string, agentDir?: string): string {
	return path.join(
		path.resolve(agentDir ?? getAgentDir()),
		WORKFLOW_STATE_DIR_NAME,
		encodeWorkflowProjectKey(cwd),
	);
}
