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
		// W2-PLANREVIEW: the two short reference skills `plan-review` preloads
		// by NAME. Pi discovers a skill only from a directory containing
		// SKILL.md - a loose `.md` under a subdirectory is not discovered - so
		// each reference is its own directory or the blind reviewer fails
		// preflight with "preload skill not found".
		"skills/plan-schema/SKILL.md",
		"skills/workflow-components/SKILL.md",
		// The package-provided (`builtin` scope) definitions: shipped as
		// `.workflow.ts` sources, loaded by the same jiti loader that reads a
		// project definition, and resolved from their own location inside the
		// installed package.
		"workflows/plan-to-ship.workflow.ts",
		"workflows/deep-review.workflow.ts",
		"workflows/plan-review.workflow.ts",
		"workflows/deep-research.workflow.ts",
		// W3: the agent definitions the builtin workflows name. They are not
		// installed anywhere: a run composed from this root carries
		// `workflows/agents` to pi-subagent as the request's `agentRoots`,
		// which resolves them under `package` scope in any project. Packing
		// them is therefore what makes a builtin definition runnable at all.
		"workflows/agents/implementer.md",
		"workflows/agents/planner.md",
		"workflows/agents/reviewer.md",
		"workflows/agents/lens-reviewer.md",
		"workflows/agents/plan-reviewer.md",
		"workflows/agents/researcher.md",
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
		// W0-COMP-A: the component library's own entry point.
		"dist/components/index.d.ts",
		"dist/components/index.js",
		// W2-PLANREVIEW: the compiled stage document, shared by the compiler
		// that produces it and the reviewer that reads it.
		"dist/components/compiled-stages.d.ts",
		"dist/components/compiled-stages.js",
		"dist/service-provider.d.ts",
		"dist/service-provider.js",
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
	// Release 1.1.0 adds the skills/workflows operating skill,
	// workflows/plan-to-ship.workflow.ts, and the three workflows/agents/*.md
	// templates: measured 156 entries and 2182 KiB unpacked. Release 1.0.0
	// (contract revision 18) added dist/runtime/index.*, docs/qualification.md,
	// and CHANGELOG.md: 145 entries and 2009 KiB unpacked (revision 18 before
	// the freeze: 125 entries and 1762 KiB; before that 100 entries and
	// 1536 KiB).
	// Bounds: 208 entries and 2816 KiB. Measured 156 entries / 2182 KiB at 1.1.0
	// (builtin workflow, three agent templates and two skills added since the
	// 145 / 2009 KiB freeze measurement); 160 entries left four spare, so the
	// entry bound was raised deliberately. amaro is a dependency and is not
	// packed. Unreleased at W2-PLANREVIEW: 186 entries / 2486 KiB, after the
	// component library, the service-provider entry, deep-review, plan-review,
	// two agent templates and two reference skills - 14 entries and 74 KiB
	// spare. Unreleased at W2-PTS + W4-INSPECT: 186 entries / 2577 KiB (the
	// plan-to-ship compiler's README, CHANGELOG and skill prose), 17 KiB over
	// the old 2560 KiB bound, so the bounds were raised deliberately to 208
	// entries and 2688 KiB (22 entries and 111 KiB spare). The next thing this
	// package ships records its own measurement here rather than nudging
	// them silently.
	// W3-RESEARCH is that next thing, and does exactly that. Unreleased with
	// deep-research and its researcher template: measured 188 entries and
	// 2620 KiB unpacked - two entries and 43 KiB over the row above (the
	// definition, the researcher template, and the README, CHANGELOG,
	// contracts and two skill-table edits). Those 43 KiB would leave under
	// 70 KiB of the 111 KiB above, which is below the 74 KiB that the
	// W2-PLANREVIEW row already called the point to raise at, so the SIZE
	// bound is raised deliberately to 2816 KiB and this measurement keeps
	// 196 KiB spare. The ENTRY bound stays at 208: 20 spare entries is still
	// ample, and two slices in a row have added prose rather than files.
	// W5-PRUNE records its own measurement in turn: unreleased with
	// `/workflow prune` (the store-level retention module and its docs and
	// README prose) the package measures 192 entries and 2675 KiB unpacked -
	// four entries and 55 KiB over the row above. Both bounds stand as they
	// are, with 16 entries and 141 KiB spare.
	if (workflow.entryCount > 208 || workflow.unpackedSize > 2816 * 1024) {
		throw new Error(
			`packed package exceeds release bounds: ${workflow.entryCount} entries, ${Math.ceil(workflow.unpackedSize / 1024)} KiB unpacked`,
		);
	}
	process.stdout.write(
		`packed ${workflow.filename}: ${workflow.entryCount} entries, ${Math.ceil(workflow.unpackedSize / 1024)} KiB unpacked (bounds 208 entries, 2816 KiB)\n`,
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
const components = await import("@vegardx/pi-workflow/components");
const workflowProvider = await import("@vegardx/pi-workflow/service-provider");
const extension = await import("@vegardx/pi-workflow/extension");
const subagent = await import("@vegardx/pi-subagent");
const provider = await import("@vegardx/pi-subagent/service-provider");
const { readFile } = await import("node:fs/promises");
// D4: the manifest is an exported entry, read through the exports map.
const manifest = (await import("@vegardx/pi-workflow/package.json", { with: { type: "json" } })).default;
if (manifest?.name !== "@vegardx/pi-workflow" || manifest.version !== "2.0.0") throw new Error("packed ./package.json export did not return the 2.0.0 manifest");
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
// W0-COMP-A: the third entry exists, carries the library, and is disjoint from
// the two pinned entries. Its own list is not pinned; ./components is unfrozen.
const componentNames = Object.keys(components).sort();
if (typeof components.gate !== "function" || typeof components.envelope !== "function" || !components.CompiledStageDocumentSchema || !components.FindingSchema) {
	throw new Error("packed ./components entry does not export the component library");
}
const sharedComponents = componentNames.filter((name) => pinned.root.actual.includes(name) || pinned.runtime.actual.includes(name));
if (sharedComponents.length > 0) throw new Error("./components may not repeat a pinned export: " + sharedComponents.join(", "));
// W1-PROVIDER: the fifth entry carries the seam, the allowlist is frozen, and
// it repeats no pinned export. Its own list is not pinned; ./service-provider
// is unfrozen.
const providerNames = Object.keys(workflowProvider).sort();
if (
	typeof workflowProvider.registerWorkflowServiceProvider !== "function" ||
	typeof workflowProvider.acquireWorkflowService !== "function" ||
	typeof workflowProvider.isCompatibleWorkflowProvider !== "function" ||
	typeof workflowProvider.headlessBuiltinViolations !== "function" ||
	typeof workflowProvider.WorkflowServiceProviderError !== "function" ||
	!Object.isFrozen(workflowProvider.BUILTIN_HEADLESS_WORKFLOWS) ||
	workflowProvider.BUILTIN_HEADLESS_WORKFLOWS.join(",") !== "plan-review"
) {
	throw new Error("packed ./service-provider entry does not export the provider seam");
}
const sharedProvider = providerNames.filter((name) => pinned.root.actual.includes(name) || pinned.runtime.actual.includes(name) || componentNames.includes(name));
if (sharedProvider.length > 0) throw new Error("./service-provider may not repeat a pinned export: " + sharedProvider.join(", "));
for (const deep of ["@vegardx/pi-workflow/dist/index.js", "@vegardx/pi-workflow/dist/reducer.js", "@vegardx/pi-workflow/dist/runtime/index.js", "@vegardx/pi-workflow/runtime/index.js", "@vegardx/pi-workflow/dist/components/index.js", "@vegardx/pi-workflow/components/index.js", "@vegardx/pi-workflow/dist/service-provider.js", "@vegardx/pi-workflow/compatibility.json"]) {
	let code = "resolved";
	try { await import(deep); } catch (error) { code = error?.code ?? String(error); }
	if (code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw new Error("deep import " + deep + " must reject with ERR_PACKAGE_PATH_NOT_EXPORTED, got " + code);
}
process.stdout.write("packed exports: root " + pinned.root.actual.length + ", runtime " + pinned.runtime.actual.length + ", components " + componentNames.length + ", service-provider " + providerNames.length + ", disjoint\\n");
const compatibility = JSON.parse(await readFile("node_modules/@vegardx/pi-workflow/compatibility.json", "utf8"));
const subagentManifest = JSON.parse(await readFile("node_modules/@vegardx/pi-subagent/package.json", "utf8"));
const skill = await readFile("node_modules/@vegardx/pi-workflow/skills/workflow-authoring/SKILL.md", "utf8");
const operatingSkill = await readFile("node_modules/@vegardx/pi-workflow/skills/workflows/SKILL.md", "utf8");
const planSchemaSkill = await readFile("node_modules/@vegardx/pi-workflow/skills/plan-schema/SKILL.md", "utf8");
const componentsSkill = await readFile("node_modules/@vegardx/pi-workflow/skills/workflow-components/SKILL.md", "utf8");
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
	workflow.WORKFLOW_CONTRACT_REVISION !== 19 ||
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
	subagent.SUBAGENT_RUNTIME_CONTRACT.features.vmMemoryCeiling !== true ||
	subagent.SUBAGENT_RUNTIME_CONTRACT.features.workspaceBudgetRefusal !== true ||
	subagent.SUBAGENT_RUNTIME_CONTRACT.contractRevision !== 7 ||
	workflow.WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.features.vmMemoryCeiling !== true ||
	workflow.WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.features.workspaceBudgetRefusal !== true ||
	workflow.WORKFLOW_HANDOFF_FORMAT_SHA256 !== subagent.canonicalSha256({ format: "git-format-patch", mediaType: subagent.HANDOFF_EXPORT_MEDIA_TYPE, revision: 7 }) ||
	workflow.AgentTaskRequestSchema.properties?.memoryBytes === undefined ||
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
	!/^---\\nname: workflows\\n/.test(operatingSkill) ||
	// W2-PLANREVIEW: the two preloaded references, whose frontmatter name is
	// the name plan-review asks for by preloadSkills.
	!/^---\\nname: plan-schema\\n/.test(planSchemaSkill) ||
	!/^---\\nname: workflow-components\\n/.test(componentsSkill)
) throw new Error("packed authoring and operating skills are not declared in the pi manifest");
if (
	!Array.isArray(manifest.pi?.workflows) ||
	manifest.pi.workflows.length !== 1 ||
	manifest.pi.workflows[0] !== "./workflows"
) throw new Error("packed builtin workflow root is not declared in the pi manifest");
if (
	workflow.WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.contractRevision !== subagent.SUBAGENT_RUNTIME_CONTRACT.contractRevision ||
	compatibility.piWorkflow.version !== manifest.version ||
	compatibility.piWorkflow.version !== "2.0.0" ||
	compatibility.piWorkflow.api?.version !== "2.0.0" ||
	JSON.stringify(compatibility.piWorkflow.api.frozenSurfaces) !== JSON.stringify(["authoring", "service", "contract", "extension"]) ||
	JSON.stringify(compatibility.piWorkflow.api.entryPoints) !== JSON.stringify({ ".": "frozen", "./extension": "frozen", "./runtime": "unfrozen", "./components": "unfrozen", "./service-provider": "unfrozen" }) ||
	compatibility.piWorkflow.api.exportList !== ${JSON.stringify(rootExportList)} ||
	!compatibility.hosts?.find((host) => host.platform === "macos-arm64")?.evidence?.includes(${JSON.stringify(qualificationNote)}) ||
	compatibility.piWorkflow.contractRevision !== workflow.WORKFLOW_CONTRACT_REVISION ||
	compatibility.piWorkflow.features?.checkpoints !== workflow.WORKFLOW_RUNTIME_CONTRACT.features.checkpoints ||
	compatibility.piWorkflow.features?.dynamicWorkflows !== workflow.WORKFLOW_RUNTIME_CONTRACT.features.dynamicWorkflows ||
	compatibility.transformer?.package !== "amaro" ||
	compatibility.transformer?.version !== manifest.dependencies?.amaro ||
	compatibility.piSubagent.contractRevision !== subagent.SUBAGENT_RUNTIME_CONTRACT.contractRevision ||
	compatibility.piSubagent.peerRange !== manifest.peerDependencies?.["@vegardx/pi-subagent"] ||
	compatibility.piSubagent.peerRange !== subagentManifest.version ||
	compatibility.piSubagent.requiredFeatures?.vmMemoryCeiling !== true ||
	compatibility.piSubagent.requiredFeatures?.workspaceBudgetRefusal !== true
) throw new Error("packed compatibility matrix disagrees with the packed contracts");
// F1 smoke: the packed extension registers the package's own workflows/ as a
// builtin root, so workflow_list and workflow_validate reach the shipped
// definition from an untrusted project, and the definition's
// "@vegardx/pi-workflow" import resolves from its own location inside the
// installed package.
const path = (await import("node:path")).default;
const builtinRoot = path.resolve("node_modules/@vegardx/pi-workflow/workflows");
const tools = [];
const hooks = new Map();
extension.default({
	events: { on() {}, emit() {} },
	registerTool(tool) { tools.push(tool); },
	registerCommand() {},
	registerShortcut() {},
	on(event, handler) { hooks.set(event, handler); },
});
const toolContext = { cwd: process.cwd(), isProjectTrusted: () => false, ui: { notify() {} } };
const callTool = async (name, params) => {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error("packed extension did not register " + name);
	const result = await tool.execute(name, params, new AbortController().signal, undefined, toolContext);
	return JSON.parse(result.content[0].text);
};
try {
	const listed = await callTool("workflow_list", {});
	const builtin = listed.find((entry) => entry.name === "plan-to-ship");
	if (!builtin || builtin.scope !== "builtin" || builtin.source !== "package" || path.dirname(builtin.path) !== builtinRoot) {
		throw new Error("packed workflow_list did not discover the builtin root: " + JSON.stringify(listed));
	}
	for (const ref of ["plan-to-ship", "deep-review", "plan-review", "deep-research"]) {
		const validated = await callTool("workflow_validate", { ref });
		if (validated.valid !== true || validated.workflow?.scope !== "builtin") {
			throw new Error("packed workflow_validate refused the builtin definition " + ref + ": " + JSON.stringify(validated));
		}
	}
	process.stdout.write("builtin workflow root: " + builtin.name + " (" + builtin.scope + "/" + builtin.source + ") discovered from the packed install without project trust\\n");
} finally {
	await hooks.get("session_shutdown")?.({ reason: "quit" }, toolContext);
}
// W3 smoke: the packed agent templates parse under the packed pi-subagent's
// own discovery, so "copy these three files into <agentDir>/agents" is an
// instruction that works against the tarball a consumer installed. The
// workflow cannot ship them into place; only a person can.
const packedAgents = await subagent.discoverAgents([
	{ scope: "package", directory: path.resolve("node_modules/@vegardx/pi-workflow/workflows/agents"), trusted: true },
]);
for (const required of ["implementer", "lens-reviewer", "plan-reviewer", "planner", "researcher", "reviewer"]) {
	const agent = packedAgents.get(required);
	if (!agent) throw new Error("packed agent template is missing or unparsable: " + required);
	if (required === "implementer" && (agent.limitCeiling.workspaceWriteBytes < 2 * 1024 * 1024 * 1024 || !agent.workspaceModes.includes("worktree"))) {
		throw new Error("packed implementer template no longer covers the workflow's worktree request");
	}
}
process.stdout.write("agent templates: " + [...packedAgents.keys()].sort().join(", ") + " parse from the packed install\\n");
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
