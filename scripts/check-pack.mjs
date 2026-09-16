import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const subagentRoot = path.resolve(root, "../pi-subagent");
const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-workflow-pack-"));
const archives = path.join(temporary, "archives");
const project = path.join(temporary, "project");
// Export lists pinned by test/public-api.test.ts and by this check (spec D5):
// the tarball and the source are held to the same fixtures.
const rootExportList = "test/fixtures/public-api/root-exports.json";
const runtimeExportList = "test/fixtures/public-api/runtime-exports.json";
const qualificationNote = "docs/qualification.md";

async function readJson(filePath) {
	return JSON.parse(await readFile(filePath, "utf8"));
}

async function readExportList(relative) {
	const names = await readJson(path.join(root, relative));
	if (
		!Array.isArray(names) ||
		names.some((name) => typeof name !== "string") ||
		new Set(names).size !== names.length ||
		names.join("\n") !== [...names].sort().join("\n")
	) {
		throw new Error(
			`${relative} must be a sorted array of unique export names`,
		);
	}
	return names;
}

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
		"CHANGELOG.md",
		"LICENSE",
		"README.md",
		"compatibility.json",
		"docs/compatibility.md",
		qualificationNote,
		"skills/workflow-authoring/SKILL.md",
		"skills/workflow-authoring/references/examples.md",
		"skills/workflows/SKILL.md",
		"dist/attempts.d.ts",
		"dist/attempts.js",
		"dist/checkpoint-executor.d.ts",
		"dist/checkpoint-executor.js",
		"dist/decision-store.d.ts",
		"dist/decision-store.js",
		"dist/dynamic/approval.d.ts",
		"dist/dynamic/approval.js",
		"dist/dynamic/constants.d.ts",
		"dist/dynamic/constants.js",
		"dist/dynamic/contracts.d.ts",
		"dist/dynamic/contracts.js",
		"dist/dynamic/decision-contracts.d.ts",
		"dist/dynamic/decision-contracts.js",
		"dist/dynamic/definition.d.ts",
		"dist/dynamic/definition.js",
		"dist/dynamic/execution-error.d.ts",
		"dist/dynamic/execution-error.js",
		"dist/dynamic/identity.d.ts",
		"dist/dynamic/identity.js",
		"dist/dynamic/proposal-store.d.ts",
		"dist/dynamic/proposal-store.js",
		"dist/dynamic/rpc.d.ts",
		"dist/dynamic/rpc.js",
		"dist/dynamic/run-definition.d.ts",
		"dist/dynamic/run-definition.js",
		"dist/dynamic/shim.d.ts",
		"dist/dynamic/shim.js",
		"dist/dynamic/source.d.ts",
		"dist/dynamic/source.js",
		"dist/dynamic/transformer-identity.d.ts",
		"dist/dynamic/transformer-identity.js",
		"dist/dynamic/transformer.d.ts",
		"dist/dynamic/transformer.js",
		"dist/dynamic/vm-host.d.ts",
		"dist/dynamic/vm-host.js",
		"dist/dynamic/worker.d.ts",
		"dist/dynamic/worker.js",
		"dist/extension.d.ts",
		"dist/extension.js",
		"dist/index.d.ts",
		"dist/index.js",
		"dist/nested-run-executor.d.ts",
		"dist/nested-run-executor.js",
		"dist/runtime/index.d.ts",
		"dist/runtime/index.js",
		"dist/support-executor.d.ts",
		"dist/support-executor.js",
		"dist/support.d.ts",
		"dist/support.js",
		"dist/task-retrier.d.ts",
		"dist/task-retrier.js",
		"dist/tools.d.ts",
		"dist/tools.js",
		"dist/ui/commands.d.ts",
		"dist/ui/commands.js",
		"dist/ui/format.d.ts",
		"dist/ui/format.js",
		"dist/ui/inspector.d.ts",
		"dist/ui/inspector.js",
		"dist/ui/tool-render.d.ts",
		"dist/ui/tool-render.js",
		"dist/ui/widget.d.ts",
		"dist/ui/widget.js",
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
	// Every host evidence path shipped under docs/ must be in the tarball so a
	// consumer can read the cited report from the installed package.
	const compatibility = await readJson(path.join(root, "compatibility.json"));
	for (const host of compatibility.hosts ?? []) {
		for (const evidence of host.evidence ?? []) {
			if (evidence.startsWith("docs/") && !paths.has(evidence)) {
				throw new Error(`host evidence is not packed: ${evidence}`);
			}
		}
	}
	// Release 1.0.0 (contract revision 18) adds dist/runtime/index.*,
	// docs/qualification.md, and CHANGELOG.md: measured 145 entries and
	// 2009 KiB unpacked when the comment was refreshed (revision 18 before the
	// freeze: 125 entries and 1762 KiB; before that 100 entries and 1536 KiB).
	// Bounds: 160 entries (10% headroom) and 2560 KiB (about 27% headroom;
	// 2048 KiB would have left 39 KiB, less than one docs revision). amaro is
	// a dependency and is not packed.
	if (workflow.entryCount > 160 || workflow.unpackedSize > 2560 * 1024) {
		throw new Error(
			`packed package exceeds release bounds: ${workflow.entryCount} entries, ${Math.ceil(workflow.unpackedSize / 1024)} KiB unpacked`,
		);
	}
	process.stdout.write(
		`packed ${workflow.filename}: ${workflow.entryCount} entries, ${Math.ceil(workflow.unpackedSize / 1024)} KiB unpacked (bounds 160 entries, 2560 KiB)\n`,
	);
	const rootExports = await readExportList(rootExportList);
	const runtimeExports = await readExportList(runtimeExportList);

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
	const smoke = await execFileAsync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`
const workflow = await import("@vegardx/pi-workflow");
const runtime = await import("@vegardx/pi-workflow/runtime");
const extension = await import("@vegardx/pi-workflow/extension");
const subagent = await import("@vegardx/pi-subagent");
const provider = await import("@vegardx/pi-subagent/service-provider");
const { readFile } = await import("node:fs/promises");
// D4: the manifest is an exported entry, read through the exports map.
const manifest = (await import("@vegardx/pi-workflow/package.json", { with: { type: "json" } })).default;
if (manifest?.name !== "@vegardx/pi-workflow" || manifest.version !== "1.1.0") throw new Error("packed ./package.json export did not return the 1.1.0 manifest");
// Spec 2.4 items 2-4: both entry points export exactly the pinned lists, the
// lists are disjoint, and deep dist/ paths are not reachable.
const pinned = {
	root: { list: ${JSON.stringify(rootExportList)}, expected: ${JSON.stringify(rootExports)}, actual: Object.keys(workflow).sort() },
	runtime: { list: ${JSON.stringify(runtimeExportList)}, expected: ${JSON.stringify(runtimeExports)}, actual: Object.keys(runtime).sort() },
};
for (const [entry, { list, expected, actual }] of Object.entries(pinned)) {
	const missing = expected.filter((name) => !actual.includes(name));
	const unexpected = actual.filter((name) => !expected.includes(name));
	if (missing.length > 0 || unexpected.length > 0 || actual.length !== expected.length) {
		throw new Error("packed " + entry + " exports differ from " + list + ": missing " + JSON.stringify(missing) + ", unexpected " + JSON.stringify(unexpected));
	}
}
const shared = pinned.root.actual.filter((name) => pinned.runtime.actual.includes(name));
if (shared.length > 0) throw new Error("no export may appear in both entry points: " + shared.join(", "));
for (const deep of ["@vegardx/pi-workflow/dist/index.js", "@vegardx/pi-workflow/dist/reducer.js", "@vegardx/pi-workflow/dist/runtime/index.js", "@vegardx/pi-workflow/runtime/index.js", "@vegardx/pi-workflow/compatibility.json"]) {
	let code = "resolved";
	try { await import(deep); } catch (error) { code = error?.code ?? String(error); }
	if (code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw new Error("deep import " + deep + " must reject with ERR_PACKAGE_PATH_NOT_EXPORTED, got " + code);
}
process.stdout.write("packed exports: root " + pinned.root.actual.length + ", runtime " + pinned.runtime.actual.length + ", disjoint\\n");
const compatibility = JSON.parse(await readFile("node_modules/@vegardx/pi-workflow/compatibility.json", "utf8"));
const subagentManifest = JSON.parse(await readFile("node_modules/@vegardx/pi-subagent/package.json", "utf8"));
const skill = await readFile("node_modules/@vegardx/pi-workflow/skills/workflow-authoring/SKILL.md", "utf8");
const operatingSkill = await readFile("node_modules/@vegardx/pi-workflow/skills/workflows/SKILL.md", "utf8");
if (
	workflow.WORKFLOW_RUNTIME_CONTRACT.schema !== "pi-workflow-runtime" ||
	!workflow.isCompatibleSubagentContract(subagent.SUBAGENT_RUNTIME_CONTRACT) ||
	typeof provider.acquireSubagentService !== "function" ||
	typeof runtime.WorkflowRunJournal?.open !== "function" ||
	typeof runtime.acquireWorkflowRunLease !== "function" ||
	typeof workflow.createWorkflowSubagentProvider !== "function" ||
	typeof runtime.createWorkflowTaskLauncher !== "function" ||
	typeof runtime.createWorkflowSequentialScheduler !== "function" ||
	typeof runtime.WorkflowArtifactStore?.open !== "function" ||
	typeof runtime.createWorkflowTaskFinalizer !== "function" ||
	typeof runtime.createStaticWorkflowRuntime !== "function" ||
	typeof workflow.createWorkflowService !== "function" ||
	workflow.DEFAULT_MAX_WORKFLOW_COST !== 1000 ||
	!workflow.WorkflowBudgetSchema ||
	typeof workflow.defineSupportTask !== "function" ||
	typeof runtime.createWorkflowSupportTaskExecutor !== "function" ||
	typeof runtime.supportRegistrationIdentity !== "function" ||
	typeof runtime.deriveSupportImplementationIdentitySha256 !== "function" ||
	!workflow.SupportTaskExecutionRecordSchema ||
	!workflow.SupportTaskTerminalEvidenceSchema ||
	typeof runtime.createWorkflowNestedRunExecutor !== "function" ||
	typeof runtime.deriveNestedWorkflowRunId !== "function" ||
	!workflow.NestedWorkflowTaskSpecSchema ||
	!workflow.NestedWorkflowTerminalEvidenceSchema ||
	!workflow.NestedWorkflowInputArtifactsSchema ||
	workflow.WORKFLOW_CONTRACT_REVISION !== 18 ||
	workflow.WORKFLOW_RUNTIME_CONTRACT.features.worktrees !== true ||
	workflow.WORKFLOW_RUNTIME_CONTRACT.features.checkpoints !== true ||
	workflow.WORKFLOW_RUNTIME_CONTRACT.features.dynamicWorkflows !== true ||
	typeof runtime.createDynamicWorkflowDefinition !== "function" ||
	typeof runtime.createDynamicDiscoveredWorkflow !== "function" ||
	typeof runtime.deriveDynamicHostApiSha256 !== "function" ||
	typeof runtime.deriveDynamicImportPolicySha256 !== "function" ||
	typeof runtime.deriveDynamicDefinitionIdentitySha256 !== "function" ||
	typeof runtime.extractDynamicWorkflowManifest !== "function" ||
	typeof workflow.deriveDecisionRecordSha256 !== "function" ||
	!workflow.DynamicWorkflowProposalViewSchema ||
	!workflow.DynamicWorkflowProposalRecordSchema ||
	!workflow.SourceApprovalDecisionBindingSchema ||
	!workflow.Sha256Schema ||
	!workflow.WorkflowMetaSchema ||
	manifest.dependencies?.amaro !== "1.2.0" ||
	!workflow.CheckpointTaskSpecSchema ||
	!workflow.CheckpointTaskRequestSchema ||
	!workflow.CheckpointTerminalEvidenceSchema ||
	typeof runtime.createWorkflowCheckpointTaskExecutor !== "function" ||
	typeof runtime.cancelOpenWorkflowCheckpoints !== "function" ||
	typeof runtime.CHECKPOINT_RUN_ENDING_REASON !== "string" ||
	typeof runtime.WorkflowDecisionRecordStore?.open !== "function" ||
	!workflow.WorkflowDecisionRecordSchema ||
	!workflow.CheckpointDecisionBindingSchema ||
	typeof workflow.deriveDecisionBindingSha256 !== "function" ||
	typeof runtime.isStaticWorkflowParked !== "function" ||
	typeof runtime.pendingCheckpoints !== "function" ||
	!workflow.WorkflowDecideOptionsSchema ||
	!workflow.WorkflowPendingCheckpointViewSchema ||
	!workflow.WorkflowHandoffDescriptorSchema ||
	workflow.MAX_WORKFLOW_HANDOFF_BYTES !== 16 * 1024 * 1024 ||
	typeof runtime.verifyWorkflowHandoffEvidence !== "function" ||
	subagent.SUBAGENT_RUNTIME_CONTRACT.features.handoffExport !== true ||
	subagent.SUBAGENT_RUNTIME_CONTRACT.contractRevision !== 6 ||
	workflow.MAX_NESTED_WORKFLOW_DEPTH !== 4 ||
	workflow.MAX_TASK_EXECUTION_GENERATIONS !== 16 ||
	workflow.WORKFLOW_RUNTIME_CONTRACT.features.supportTaskExecution !== true ||
	workflow.WORKFLOW_RUNTIME_CONTRACT.features.nestedWorkflows !== true ||
	workflow.WORKFLOW_RUNTIME_CONTRACT.features.nestedArtifactInputs !== true ||
	workflow.WORKFLOW_RUNTIME_CONTRACT.features.retryAttempts !== true ||
	workflow.WORKFLOW_RUNTIME_CONTRACT.features.resumeAttempts !== true ||
	workflow.WORKFLOW_RUNTIME_CONTRACT.features.executionGenerations !== true ||
	workflow.WORKFLOW_RUNTIME_CONTRACT.features.transactionalInvalidation !== true || workflow.WORKFLOW_RUNTIME_CONTRACT.features.finalizers !== true || workflow.WORKFLOW_RUNTIME_CONTRACT.features.operatorAttempts !== true || !workflow.TaskRoleSchema ||
	typeof runtime.invalidationClosure !== "function" ||
	typeof runtime.createWorkflowTaskRetrier !== "function" ||
	!workflow.AgentRetryPolicySchema ||
	typeof extension.default !== "function" ||
	manifest.pi?.extensions?.[0] !== "./dist/extension.js"
) throw new Error("packed exports are unavailable or incompatible");
if (
	!Array.isArray(workflow.WORKFLOW_TOOL_DECLARATIONS) ||
	!Object.isFrozen(workflow.WORKFLOW_TOOL_DECLARATIONS) ||
	workflow.WORKFLOW_TOOL_DECLARATIONS.map((tool) => tool.name).join(",") !== "workflow_list,workflow_validate,workflow_run,workflow_status,workflow_wait,workflow_stop,workflow_reconcile,workflow_runs,workflow_inspect,workflow_logs,workflow_invalidate,workflow_retry,workflow_resume,workflow_propose" ||
	!workflow.WORKFLOW_TOOL_DECLARATIONS.every((tool) => typeof tool.execute === "function" && tool.parameters?.type === "object" && typeof tool.output?.type === "string" && typeof tool.summarizeCall === "function" && typeof tool.summarizeResult === "function") ||
	!workflow.WorkflowServiceRunViewSchema ||
	!workflow.WorkflowRunPageSchema ||
	!workflow.WorkflowRunInspectionSchema ||
	!workflow.WorkflowLogPageSchema ||
	typeof workflow.WorkflowInvalidationPreviewSchema !== "object" ||
	typeof runtime.invalidationPreview !== "function" ||
	typeof workflow.workflowToolText !== "function" ||
	!workflow.WorkflowDefinitionSummarySchema
) throw new Error("packed tool declaration table is unavailable or incomplete");
if (
	!Array.isArray(manifest.pi?.skills) ||
	manifest.pi.skills.length !== 1 ||
	manifest.pi.skills[0] !== "./skills" ||
	!/^---\\nname: workflow-authoring\\n/.test(skill) ||
	!/^---\\nname: workflows\\n/.test(operatingSkill)
) throw new Error("packed authoring and operating skills are not declared in the pi manifest");
if (
	workflow.WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.contractRevision !== subagent.SUBAGENT_RUNTIME_CONTRACT.contractRevision ||
	compatibility.piWorkflow.version !== manifest.version ||
	compatibility.piWorkflow.version !== "1.1.0" ||
	compatibility.piWorkflow.api?.version !== "1.1.0" ||
	JSON.stringify(compatibility.piWorkflow.api.frozenSurfaces) !== JSON.stringify(["authoring", "service", "contract", "extension"]) ||
	JSON.stringify(compatibility.piWorkflow.api.entryPoints) !== JSON.stringify({ ".": "frozen", "./extension": "frozen", "./runtime": "unfrozen" }) ||
	compatibility.piWorkflow.api.exportList !== ${JSON.stringify(rootExportList)} ||
	!compatibility.hosts?.find((host) => host.platform === "macos-arm64")?.evidence?.includes(${JSON.stringify(qualificationNote)}) ||
	compatibility.piWorkflow.contractRevision !== workflow.WORKFLOW_CONTRACT_REVISION ||
	compatibility.piWorkflow.features?.checkpoints !== workflow.WORKFLOW_RUNTIME_CONTRACT.features.checkpoints ||
	compatibility.piWorkflow.features?.dynamicWorkflows !== workflow.WORKFLOW_RUNTIME_CONTRACT.features.dynamicWorkflows ||
	compatibility.transformer?.package !== "amaro" ||
	compatibility.transformer?.version !== manifest.dependencies?.amaro ||
	compatibility.piSubagent.contractRevision !== subagent.SUBAGENT_RUNTIME_CONTRACT.contractRevision ||
	compatibility.piSubagent.peerRange !== manifest.peerDependencies?.["@vegardx/pi-subagent"] ||
	compatibility.piSubagent.peerRange !== subagentManifest.version
) throw new Error("packed compatibility matrix disagrees with the packed contracts");
// Live smoke: the packed dist/dynamic/vm-host.js must resolve and boot the
// packed dist/dynamic/worker.js (spec 12.3); the production manifest watchdog
// (DYNAMIC_VM_MANIFEST_TIMEOUT_MS) bounds the boot.
const source = [
	'import { defineWorkflow } from "@vegardx/pi-workflow";',
	"export default defineWorkflow({",
	'\tmeta: { name: "pack-check", description: "Pack check", version: 1, budget: { cost: 1, childRuntimeMs: 60000 }, timeoutMs: 60000 },',
	'\tinputSchema: { type: "object", properties: {}, additionalProperties: false },',
	'\toutputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },',
	"\tasync run() { return { ok: true }; },",
	"});",
	"",
].join("\\n");
const startedAt = performance.now();
const m = await runtime.extractDynamicWorkflowManifest({ source, supportHelpers: [] });
const elapsedMs = Math.round(performance.now() - startedAt);
if (m.meta.name !== "pack-check" || m.meta.version !== 1) throw new Error("packed dynamic worker did not produce the expected manifest");
if (elapsedMs > workflow.DYNAMIC_VM_MANIFEST_TIMEOUT_MS) throw new Error("packed dynamic manifest smoke exceeded the manifest watchdog");
process.stdout.write(\`dynamic manifest smoke: \${elapsedMs} ms (watchdog \${workflow.DYNAMIC_VM_MANIFEST_TIMEOUT_MS} ms)\\n\`);
`,
		],
		{ cwd: project, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
	);
	process.stdout.write(smoke.stdout);
} finally {
	await rm(temporary, { recursive: true, force: true });
}
