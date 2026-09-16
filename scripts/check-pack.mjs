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
		"compatibility.json",
		"docs/compatibility.md",
		"skills/workflow-authoring/SKILL.md",
		"skills/workflow-authoring/references/examples.md",
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
	// Revision 18 ships dist/dynamic/* and the checkpoint modules: 125 entries
	// and 1762 KiB unpacked when the bounds were set (previously 100 entries
	// and 1536 KiB). The bounds are the next round values with headroom for
	// docs growth only; amaro is a dependency and is not packed.
	if (workflow.entryCount > 160 || workflow.unpackedSize > 2048 * 1024) {
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
	const smoke = await execFileAsync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`
const workflow = await import("@vegardx/pi-workflow");
const extension = await import("@vegardx/pi-workflow/extension");
const subagent = await import("@vegardx/pi-subagent");
const provider = await import("@vegardx/pi-subagent/service-provider");
const { readFile } = await import("node:fs/promises");
const manifest = JSON.parse(await readFile("node_modules/@vegardx/pi-workflow/package.json", "utf8"));
const compatibility = JSON.parse(await readFile("node_modules/@vegardx/pi-workflow/compatibility.json", "utf8"));
const subagentManifest = JSON.parse(await readFile("node_modules/@vegardx/pi-subagent/package.json", "utf8"));
const skill = await readFile("node_modules/@vegardx/pi-workflow/skills/workflow-authoring/SKILL.md", "utf8");
if (
	workflow.WORKFLOW_RUNTIME_CONTRACT.schema !== "pi-workflow-runtime" ||
	!workflow.isCompatibleSubagentContract(subagent.SUBAGENT_RUNTIME_CONTRACT) ||
	typeof provider.acquireSubagentService !== "function" ||
	typeof workflow.WorkflowRunJournal?.open !== "function" ||
	typeof workflow.acquireWorkflowRunLease !== "function" ||
	typeof workflow.createWorkflowSubagentProvider !== "function" ||
	typeof workflow.createWorkflowTaskLauncher !== "function" ||
	typeof workflow.createWorkflowSequentialScheduler !== "function" ||
	typeof workflow.WorkflowArtifactStore?.open !== "function" ||
	typeof workflow.createWorkflowTaskFinalizer !== "function" ||
	typeof workflow.createStaticWorkflowRuntime !== "function" ||
	typeof workflow.createWorkflowService !== "function" ||
	workflow.DEFAULT_MAX_WORKFLOW_COST !== 1000 ||
	!workflow.WorkflowBudgetSchema ||
	typeof workflow.defineSupportTask !== "function" ||
	typeof workflow.createWorkflowSupportTaskExecutor !== "function" ||
	typeof workflow.supportRegistrationIdentity !== "function" ||
	typeof workflow.deriveSupportImplementationIdentitySha256 !== "function" ||
	!workflow.SupportTaskExecutionRecordSchema ||
	!workflow.SupportTaskTerminalEvidenceSchema ||
	typeof workflow.createWorkflowNestedRunExecutor !== "function" ||
	typeof workflow.deriveNestedWorkflowRunId !== "function" ||
	!workflow.NestedWorkflowTaskSpecSchema ||
	!workflow.NestedWorkflowTerminalEvidenceSchema ||
	!workflow.NestedWorkflowInputArtifactsSchema ||
	workflow.WORKFLOW_CONTRACT_REVISION !== 18 ||
	workflow.WORKFLOW_RUNTIME_CONTRACT.features.worktrees !== true ||
	workflow.WORKFLOW_RUNTIME_CONTRACT.features.checkpoints !== true ||
	workflow.WORKFLOW_RUNTIME_CONTRACT.features.dynamicWorkflows !== true ||
	typeof workflow.createDynamicWorkflowDefinition !== "function" ||
	typeof workflow.createDynamicDiscoveredWorkflow !== "function" ||
	typeof workflow.deriveDynamicHostApiSha256 !== "function" ||
	typeof workflow.deriveDynamicImportPolicySha256 !== "function" ||
	typeof workflow.deriveDynamicDefinitionIdentitySha256 !== "function" ||
	typeof workflow.extractDynamicWorkflowManifest !== "function" ||
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
	typeof workflow.createWorkflowCheckpointTaskExecutor !== "function" ||
	typeof workflow.cancelOpenWorkflowCheckpoints !== "function" ||
	typeof workflow.CHECKPOINT_RUN_ENDING_REASON !== "string" ||
	typeof workflow.WorkflowDecisionRecordStore?.open !== "function" ||
	!workflow.WorkflowDecisionRecordSchema ||
	!workflow.CheckpointDecisionBindingSchema ||
	typeof workflow.deriveDecisionBindingSha256 !== "function" ||
	typeof workflow.isStaticWorkflowParked !== "function" ||
	typeof workflow.pendingCheckpoints !== "function" ||
	!workflow.WorkflowDecideOptionsSchema ||
	!workflow.WorkflowPendingCheckpointViewSchema ||
	!workflow.WorkflowHandoffDescriptorSchema ||
	workflow.MAX_WORKFLOW_HANDOFF_BYTES !== 16 * 1024 * 1024 ||
	typeof workflow.verifyWorkflowHandoffEvidence !== "function" ||
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
	typeof workflow.invalidationClosure !== "function" ||
	typeof workflow.createWorkflowTaskRetrier !== "function" ||
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
	typeof workflow.invalidationPreview !== "function" ||
	typeof workflow.workflowToolText !== "function" ||
	!workflow.WorkflowDefinitionSummarySchema
) throw new Error("packed tool declaration table is unavailable or incomplete");
if (
	!Array.isArray(manifest.pi?.skills) ||
	manifest.pi.skills.length !== 1 ||
	manifest.pi.skills[0] !== "./skills" ||
	!/^---\\nname: workflow-authoring\\n/.test(skill)
) throw new Error("packed authoring skill is not declared in the pi manifest");
if (
	workflow.WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.contractRevision !== subagent.SUBAGENT_RUNTIME_CONTRACT.contractRevision ||
	compatibility.piWorkflow.version !== manifest.version ||
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
const m = await workflow.extractDynamicWorkflowManifest({ source, supportHelpers: [] });
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
