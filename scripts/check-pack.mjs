import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const subagentRoot = path.resolve(root, "../pi-subagent");
const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-workflow-pack-"));
const archives = path.join(temporary, "archives");
const project = path.join(temporary, "project");

async function pack(cwd) {
	const { stdout } = await execFileAsync(
		"npm",
		["pack", "--ignore-scripts", "--json", "--pack-destination", archives],
		{ cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
	);
	const [result] = JSON.parse(stdout);
	if (!result || !Array.isArray(result.files) || !result.filename) {
		throw new Error(`npm pack did not return a file manifest for ${cwd}`);
	}
	return result;
}

try {
	await mkdir(archives, { recursive: true });
	await mkdir(project, { recursive: true });
	const workflow = await pack(root);
	const subagent = await pack(subagentRoot);
	const paths = new Set(workflow.files.map((file) => file.path));
	for (const required of [
		"LICENSE",
		"README.md",
		"dist/index.d.ts",
		"dist/index.js",
		"package.json",
	]) {
		if (!paths.has(required)) {
			throw new Error(`packed file missing: ${required}`);
		}
	}
	for (const filePath of paths) {
		if (filePath.startsWith("src/") || filePath.startsWith("test/")) {
			throw new Error(`development source leaked into package: ${filePath}`);
		}
	}
	if (workflow.entryCount > 100 || workflow.unpackedSize > 1024 * 1024) {
		throw new Error("packed package exceeds release bounds");
	}

	await writeFile(
		path.join(project, "package.json"),
		'{"name":"pi-workflow-pack-check","private":true,"type":"module"}\n',
		"utf8",
	);
	await execFileAsync(
		"npm",
		[
			"install",
			"--ignore-scripts",
			"--no-package-lock",
			"--no-audit",
			"--no-fund",
			path.join(archives, subagent.filename),
			path.join(archives, workflow.filename),
		],
		{ cwd: project, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
	);
	await execFileAsync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			'const workflow = await import("@vegardx/pi-workflow"); const subagent = await import("@vegardx/pi-subagent"); const provider = await import("@vegardx/pi-subagent/service-provider"); if (workflow.WORKFLOW_RUNTIME_CONTRACT.schema !== "pi-workflow-runtime" || !workflow.isCompatibleSubagentContract(subagent.SUBAGENT_RUNTIME_CONTRACT) || typeof provider.acquireSubagentService !== "function" || typeof workflow.WorkflowRunJournal?.open !== "function" || typeof workflow.acquireWorkflowRunLease !== "function" || typeof workflow.createWorkflowSubagentProvider !== "function" || typeof workflow.createWorkflowTaskLauncher !== "function") throw new Error("packed exports are unavailable or incompatible");',
		],
		{ cwd: project, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
	);
} finally {
	await rm(temporary, { recursive: true, force: true });
}
