import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

/**
 * The variable Pi reads for its agent directory (`config.ts` `ENV_AGENT_DIR`,
 * which the package does not export).
 */
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

/**
 * Points `getAgentDir()` at a throwaway directory for the current test.
 *
 * Run state lives under the agent directory now, so a test that boots the
 * extension would otherwise write into the developer's real `~/.pi/agent`.
 * The assertion is the guard: if Pi ever renames the variable this throws
 * instead of silently writing there. Callers pair it with
 * `vi.unstubAllEnvs()`.
 */
export async function useTempAgentDir(agentDir: string): Promise<string> {
	const resolved = path.resolve(agentDir);
	await mkdir(resolved, { recursive: true });
	vi.stubEnv(ENV_AGENT_DIR, resolved);
	if (getAgentDir() !== resolved) {
		throw new Error(`${ENV_AGENT_DIR} no longer selects the agent directory`);
	}
	return resolved;
}
