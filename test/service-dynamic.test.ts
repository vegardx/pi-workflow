import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SubagentClient } from "@vegardx/pi-subagent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKFLOW_CONTRACT_REVISION } from "../src/contracts.js";
import {
	deriveDecisionBindingSha256,
	deriveDecisionRecordSha256,
	type WorkflowDecisionRecord,
	WorkflowDecisionRecordStore,
} from "../src/decision-store.js";
import { validateJsonSchemaDocument } from "../src/definition.js";
import {
	createSourceApprovalRecord,
	type DynamicWorkflowProposalView,
	MSG_ALREADY_APPROVED,
	MSG_APPROVAL_INVALID,
	MSG_APPROVAL_MISMATCH,
	MSG_APPROVAL_OTHER_PROJECT,
	MSG_IMPORT_POLICY_CHANGED_SINCE_APPROVAL,
	MSG_NOT_APPROVED,
	MSG_PROPOSAL_NOT_FOUND,
	MSG_PROPOSAL_OTHER_PROJECT,
	MSG_PROPOSAL_STALE_HOST_API,
	MSG_PROPOSAL_STALE_IMPORT_POLICY,
	MSG_REJECTED,
	sourceApprovalBinding,
} from "../src/dynamic/approval.js";
import {
	DYNAMIC_TRANSFORMER,
	MAX_DYNAMIC_SOURCE_BYTES,
} from "../src/dynamic/constants.js";
import type {
	DynamicSupportHelperSpec,
	DynamicWorkflowProposalRecord,
} from "../src/dynamic/contracts.js";
import {
	deriveDynamicDefinitionIdentitySha256,
	deriveDynamicHostApiSha256,
	deriveDynamicImportPolicySha256,
} from "../src/dynamic/identity.js";
import {
	canonicalDynamicDocument,
	DYNAMIC_CURRENT_RECORDS_FILE,
	DYNAMIC_DECISIONS_DIRECTORY,
	DYNAMIC_MANIFEST_FILE,
	DYNAMIC_PROPOSAL_FILE,
	DYNAMIC_RECORDS_DIRECTORY,
	DYNAMIC_SOURCE_FILE,
} from "../src/dynamic/proposal-store.js";
import {
	DYNAMIC_APPROVAL_FILE,
	DYNAMIC_RUN_DEFINITION_DIRECTORY,
	MSG_APPROVAL_CHANGED,
	MSG_HOST_API_CHANGED,
	MSG_MANIFEST_CHANGED,
	MSG_PROJECT_CHANGED,
	MSG_SOURCE_CHANGED,
} from "../src/dynamic/run-definition.js";
import {
	deriveDynamicSourceSha256,
	dynamicRef,
} from "../src/dynamic/source.js";
import { deriveJsonValueSha256 } from "../src/execution.js";
import type { WorkflowJournalEvent } from "../src/persistence/journal.js";
import {
	createWorkflowService,
	type WorkflowService,
	WorkflowServiceError,
	type WorkflowServiceOptions,
} from "../src/service.js";
import type { WorkflowServiceRunView } from "../src/service-views.js";
import type {
	WorkflowSubagentBinding,
	WorkflowSubagentProvider,
} from "../src/subagent-provider.js";
import {
	defineSupportTask,
	type SupportTaskExecutionContext,
} from "../src/support.js";

/*
 * Spec 11.3: the host API digest is a build-time constant, so a package
 * upgrade is simulated by replacing `deriveDynamicHostApiSha256` for the
 * service instance that decides, runs, or resumes. The worker thread has its
 * own module graph and is unaffected.
 */
vi.mock("../src/dynamic/identity.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/dynamic/identity.js")>();
	return {
		...actual,
		deriveDynamicHostApiSha256: vi.fn(actual.deriveDynamicHostApiSha256),
	};
});
const identity = await vi.importActual<
	typeof import("../src/dynamic/identity.js")
>("../src/dynamic/identity.js");
const HOST_API_SHA256 = identity.deriveDynamicHostApiSha256();
const FOREIGN_HOST_API_SHA256 = "f".repeat(64);

function simulateHostApiChange(): void {
	vi.mocked(deriveDynamicHostApiSha256).mockReturnValue(
		FOREIGN_HOST_API_SHA256,
	);
}

afterEach(() => {
	vi.mocked(deriveDynamicHostApiSha256).mockImplementation(
		identity.deriveDynamicHostApiSha256,
	);
});

/*
 * Fixtures: one registered support helper importable by dynamic sources
 * (spec 10), a static project definition proving `list()` stays static-only
 * (D11), and dynamic TypeScript sources exercising the real VM.
 */

const TOOLS_MODULE = "@vegardx/workflow-tools";
const ANSWER_SCHEMA = Type.Object({ answer: Type.String() });
type UpperContext = SupportTaskExecutionContext<{ value: string }>;

const upper = defineSupportTask({
	name: `${TOOLS_MODULE}/upper`,
	moduleSpecifier: TOOLS_MODULE,
	revision: 1,
	implementationSha256: "a".repeat(64),
	parametersSchema: Type.Object({ value: Type.String() }),
	outputSchema: ANSWER_SCHEMA,
});
const upperExecute = ({ parameters }: UpperContext) => ({
	answer: parameters.value.toUpperCase(),
});
/** The service publishes the registration's identity and normalised schemas (spec 10). */
const UPPER_REGISTRATION = upper.registration(upperExecute, {
	exportName: "upper",
});
const UPPER_HELPER: DynamicSupportHelperSpec = {
	name: UPPER_REGISTRATION.name,
	moduleSpecifier: UPPER_REGISTRATION.moduleSpecifier,
	revision: UPPER_REGISTRATION.revision,
	implementationSha256: UPPER_REGISTRATION.implementationSha256,
	parametersSchema: validateJsonSchemaDocument(
		UPPER_REGISTRATION.parametersSchema,
		"support registration parameters schema",
	) as DynamicSupportHelperSpec["parametersSchema"],
	outputSchema: validateJsonSchemaDocument(
		UPPER_REGISTRATION.outputSchema,
		"support registration output schema",
	) as DynamicSupportHelperSpec["outputSchema"],
	exportName: "upper",
};
const IMPORT_POLICY_SHA256 = deriveDynamicImportPolicySha256([UPPER_HELPER]);
/** Registry without an importable helper: a different import policy (D7). */
const IMPORT_POLICY_WITHOUT_HELPERS = deriveDynamicImportPolicySha256([]);

const PROPOSER = { kind: "tool", via: "workflow_propose" } as const;
const APPROVER = {
	kind: "human",
	via: "/workflow approve",
	sessionId: "session-1",
} as const;
const REJECTER = { kind: "human", via: "/workflow reject" } as const;
const DECISION = { proceed: true };
const TRUST_REQUIRED_MESSAGE = "Dynamic workflows require project trust.";
const REF_INVALID_MESSAGE = "Invalid dynamic workflow reference.";
const STATIC_FAILURE_REASON = "Static workflow source execution failed.";

const DEFINITION_NAME = "dynamic-upper";
const INPUT_SCHEMA = {
	type: "object",
	properties: { value: { type: "string" } },
	required: ["value"],
	additionalProperties: false,
};
const OUTPUT_SCHEMA = {
	type: "object",
	properties: { answer: { type: "string" } },
	required: ["answer"],
	additionalProperties: false,
};
const META = {
	name: DEFINITION_NAME,
	description: "Uppercases the input through a support task",
	version: 1,
	budget: { cost: 10, childRuntimeMs: 600_000 },
	timeoutMs: 600_000,
	concurrency: 2,
};
/** What the manifest VM must extract for every `dynamicSource` (spec 3.2 step 7). */
const MANIFEST = {
	meta: META,
	inputSchema: INPUT_SCHEMA,
	outputSchema: OUTPUT_SCHEMA,
};
const CHECKPOINT_SCHEMA = {
	type: "object",
	properties: { proceed: { type: "boolean" } },
	required: ["proceed"],
	additionalProperties: false,
};

/**
 * A full-TypeScript dynamic source (type alias, `as` casts, annotations) whose
 * body runs inside the VM against the static-runtime context.
 */
function dynamicSource(body: string): string {
	return `import { defineWorkflow } from "@vegardx/pi-workflow";
import { upper } from "@vegardx/workflow-tools";

type Shouted = { answer: string };

export default defineWorkflow({
	meta: ${JSON.stringify(META)},
	inputSchema: ${JSON.stringify(INPUT_SCHEMA)},
	outputSchema: ${JSON.stringify(OUTPUT_SCHEMA)},
	async run(ctx) {
		const input = ctx.input as { value: string };
${body}
	},
});
`;
}

/** One phase, one support task, one `result` barrier, one output. */
const UPPER_SOURCE = dynamicSource(`		ctx.phase("shout");
		const plan = ctx.support("plan", upper({ parameters: { value: input.value } }));
		const shouted: Shouted = await ctx.result(plan);
		return { answer: shouted.answer };`);

/** Parks at a required block checkpoint; answers from the decision. */
const CHECKPOINT_SOURCE = dynamicSource(`		ctx.phase("review");
		const approve = ctx.checkpoint("approve", { schema: ${JSON.stringify(CHECKPOINT_SCHEMA)}, prompt: "Approve the plan?", headless: "block", timeoutMs: 300000 });
		const decision = (await ctx.result(approve)) as { proceed: boolean };
		return { answer: decision.proceed ? "approved" : "declined" };`);

/** Throws after one declaration (D9). */
const THROWING_SOURCE = dynamicSource(`		ctx.phase("boom");
		throw new Error("boom");`);

/** Names its own manifest as a nested child: never discovered (section 0). */
const SELF_NESTING_SOURCE = dynamicSource(`		ctx.phase("nest");
		return ctx.workflow("child", { workflow: ${JSON.stringify(DEFINITION_NAME)}, input: { value: input.value } });`);

function staticDefinition(name: string, body: string): string {
	return `export default {
  schema: "pi-workflow-definition",
  meta: { name: ${JSON.stringify(name)}, description: "Static workflow", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 600000, concurrency: 1 },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  async run(ctx) {
    ${body}
  }
};
`;
}

const STATIC_NAME = "static-echo";

interface Fixture {
	readonly cwd: string;
	readonly agentDir: string;
	readonly storeRoot: string;
}

function root(name: string): string {
	return path.resolve(".pi", "test-service-dynamic", `${name}-${randomUUID()}`);
}

async function fixture(name: string): Promise<Fixture> {
	const base = root(name);
	const cwd = path.join(base, "project");
	const agentDir = path.join(base, "agent");
	const storeRoot = path.join(cwd, "state");
	await mkdir(path.join(cwd, "workflows"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		path.join(cwd, "workflows", `${STATIC_NAME}.workflow.ts`),
		staticDefinition(STATIC_NAME, `return { answer: "static" };`),
	);
	return { cwd, agentDir, storeRoot };
}

/** A second project directory beside the fixture's, sharing nothing. */
async function otherProject(fx: Fixture): Promise<string> {
	const directory = path.join(path.dirname(fx.cwd), "other-project");
	await mkdir(directory, { recursive: true });
	return directory;
}

const CLIENT_METHODS = [
	"preflight",
	"launch",
	"findByOperation",
	"status",
	"listRuns",
	"logs",
	"wait",
	"interrupt",
	"steer",
	"followUp",
	"retry",
	"resume",
	"reconcile",
	"release",
	"abandon",
	"pin",
	"unpin",
	"exportArtifact",
] as const;

/** Dynamic runs here never reach pi-subagent; every call is a failure. */
function client(): SubagentClient {
	const methods: Record<string, unknown> = {};
	for (const method of CLIENT_METHODS) {
		methods[method] = vi.fn(async () => {
			throw new Error(`unexpected subagent call: ${method}`);
		});
	}
	return methods as unknown as SubagentClient;
}

function provider(): WorkflowSubagentProvider {
	return {
		bind: vi.fn(
			async (runId: string) =>
				({
					workflowRunId: runId,
					ownerId: `pi-workflow:${runId}`,
					client: client(),
				}) satisfies WorkflowSubagentBinding,
		),
	};
}

function serviceFor(
	fx: Fixture,
	options: Partial<WorkflowServiceOptions> = {},
): Promise<WorkflowService> {
	return createWorkflowService({
		...fx,
		projectTrusted: () => true,
		subagents: provider(),
		supportTasks: [upper.registration(upperExecute, { exportName: "upper" })],
		// Source-mode workers boot in 3-34 s under full-suite load; production
		// keeps DYNAMIC_VM_MANIFEST_TIMEOUT_MS / DYNAMIC_VM_BOOT_TIMEOUT_MS.
		dynamic: { bootTimeoutMs: 60_000 },
		...options,
	});
}

/** The same helper registered without an export name: not importable (spec 10). */
function withoutImportableHelpers(): Partial<WorkflowServiceOptions> {
	return { supportTasks: [upper.registration(upperExecute)] };
}

/** Fails fast with a named label instead of hanging the whole suite. */
function bounded<T>(
	promise: Promise<T>,
	label: string,
	ms = 50_000,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`${label} did not settle within ${ms}ms`)),
			ms,
		);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

async function refused(
	promise: Promise<unknown>,
	code: WorkflowServiceError["code"],
	message: string,
): Promise<void> {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught, `expected refusal: ${message}`).toBeInstanceOf(
		WorkflowServiceError,
	);
	expect(caught).toMatchObject({ code, message });
}

async function journalEvents(
	storeRoot: string,
	runId: string,
): Promise<WorkflowJournalEvent[]> {
	const journal = await readFile(
		path.join(storeRoot, "runs", runId, "events.jsonl"),
		"utf8",
	);
	const complete = journal.endsWith("\n")
		? journal
		: journal.slice(0, journal.lastIndexOf("\n") + 1);
	return complete
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as WorkflowJournalEvent);
}

type StatusChange = { from: string; to: string; reason?: string };

async function statusChanges(
	storeRoot: string,
	runId: string,
): Promise<StatusChange[]> {
	return (await journalEvents(storeRoot, runId))
		.filter((event) => event.type === "run-status-changed")
		.map((event) => event.data as StatusChange);
}

async function readJson<T>(filePath: string): Promise<T> {
	return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function proposalDirectory(fx: Fixture, sha: string): string {
	return path.join(fx.storeRoot, "dynamic", sha);
}

function decisionsDirectory(fx: Fixture, sha: string): string {
	return path.join(proposalDirectory(fx, sha), DYNAMIC_DECISIONS_DIRECTORY);
}

/** `<storeRoot>/dynamic/<sha>/records/<version>`: the pair `current` names (spec 3.3). */
async function recordsDirectory(fx: Fixture, sha: string): Promise<string> {
	const directory = proposalDirectory(fx, sha);
	const current = await readFile(
		path.join(directory, DYNAMIC_CURRENT_RECORDS_FILE),
		"utf8",
	);
	expect(current).toMatch(/^[a-f0-9]{32}\n$/);
	return path.join(directory, DYNAMIC_RECORDS_DIRECTORY, current.slice(0, -1));
}

/** `<storeRoot>/dynamic/<sha>/decisions/<bindingSha256>.json` (spec 4.2). */
function approvalPath(fx: Fixture, view: DynamicWorkflowProposalView): string {
	return path.join(
		decisionsDirectory(fx, view.sourceSha256),
		`${deriveDecisionBindingSha256(sourceApprovalBinding(view))}.json`,
	);
}

function runDefinitionDirectory(fx: Fixture, runId: string): string {
	return path.join(
		fx.storeRoot,
		"runs",
		runId,
		DYNAMIC_RUN_DEFINITION_DIRECTORY,
	);
}

async function readProposalRecord(
	fx: Fixture,
	sha: string,
): Promise<DynamicWorkflowProposalRecord> {
	return readJson<DynamicWorkflowProposalRecord>(
		path.join(await recordsDirectory(fx, sha), DYNAMIC_PROPOSAL_FILE),
	);
}

/** Rewrites a canonical JSON document after `mutate`, keeping it canonical. */
async function rewriteCanonical<T>(
	filePath: string,
	mutate: (value: T) => void,
): Promise<void> {
	const value = await readJson<T>(filePath);
	mutate(value);
	await writeFile(filePath, canonicalDynamicDocument(value));
}

/** Flips one byte inside a string value; the document stays canonical. */
async function flipByte(filePath: string, marker: string): Promise<void> {
	const text = await readFile(filePath, "utf8");
	const at = text.indexOf(marker) + marker.length;
	expect(at).toBeGreaterThan(marker.length);
	const replacement = text[at] === "3" ? "4" : "3";
	await writeFile(
		filePath,
		`${text.slice(0, at)}${replacement}${text.slice(at + 1)}`,
	);
}

function checkpointTask(view: WorkflowServiceRunView) {
	const task = (view.tasks ?? []).find((entry) => entry.kind === "checkpoint");
	if (!task) throw new Error("missing checkpoint task view");
	return task;
}

async function propose(
	service: WorkflowService,
	source: string,
): Promise<DynamicWorkflowProposalView> {
	return bounded(service.propose(source, { proposer: PROPOSER }), "propose");
}

async function approved(
	service: WorkflowService,
	source: string,
): Promise<DynamicWorkflowProposalView> {
	const view = await propose(service, source);
	return service.decideSource(view.ref, {
		decision: "approved",
		approver: APPROVER,
	});
}

/**
 * A dynamic run parked at its checkpoint under a service that has shut down:
 * the durable state a restarted service resumes from (spec 5.4).
 */
async function parkedRun(name: string) {
	const fx = await fixture(name);
	const service = await serviceFor(fx);
	let view: DynamicWorkflowProposalView;
	let runId: string;
	let taskId: string;
	try {
		view = await approved(service, CHECKPOINT_SOURCE);
		runId = (await service.run(view.ref, { value: "park" })).runId;
		const parked = await bounded(service.wait(runId), "park");
		expect(parked).toMatchObject({ status: "waiting", parked: true });
		taskId = checkpointTask(parked).id;
	} finally {
		await bounded(service.shutdown(), "shutdown");
	}
	return {
		fx,
		view,
		runId,
		taskId,
		definition: runDefinitionDirectory(fx, runId),
		changesBefore: await statusChanges(fx.storeRoot, runId),
	};
}

type ParkedRun = Awaited<ReturnType<typeof parkedRun>>;

/**
 * Spec 11.3: a restarted service refuses to resume a tampered run with the
 * exact reason and appends no `run-status-changed` beyond what existed. The
 * lease-free status read still serves the durable parked state.
 */
async function resumeRefused(
	parked: ParkedRun,
	message: string,
	options: Partial<WorkflowServiceOptions> = {},
	code: WorkflowServiceError["code"] = "validation",
): Promise<void> {
	const service = await serviceFor(parked.fx, options);
	try {
		await refused(service.wait(parked.runId), code, message);
		await expect(service.status(parked.runId)).resolves.toMatchObject({
			status: "waiting",
		});
	} finally {
		await bounded(service.shutdown(), "shutdown");
	}
	expect(await statusChanges(parked.fx.storeRoot, parked.runId)).toEqual(
		parked.changesBefore,
	);
}

describe("dynamic workflow proposals", () => {
	it("proposes a source and returns an unrunnable view backed by the store layout", async () => {
		const fx = await fixture("propose");
		const service = await serviceFor(fx);
		try {
			const sha = deriveDynamicSourceSha256(UPPER_SOURCE);
			const view = await propose(service, UPPER_SOURCE);
			const manifestSha256 = deriveJsonValueSha256(MANIFEST);
			expect(view).toEqual({
				ref: dynamicRef(sha),
				sourceSha256: sha,
				sourceBytes: Buffer.byteLength(UPPER_SOURCE, "utf8"),
				manifest: MANIFEST,
				manifestSha256,
				hostApiSha256: HOST_API_SHA256,
				importPolicySha256: IMPORT_POLICY_SHA256,
				definitionIdentitySha256: deriveDynamicDefinitionIdentitySha256({
					sourceSha256: sha,
					manifestSha256,
					hostApiSha256: HOST_API_SHA256,
				}),
				transformer: JSON.parse(JSON.stringify(DYNAMIC_TRANSFORMER)),
				proposer: PROPOSER,
				proposedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
				runnable: false,
				path: path.join(
					await realpath(fx.storeRoot),
					"dynamic",
					sha,
					DYNAMIC_SOURCE_FILE,
				),
			});
			expect(view.decision).toBeUndefined();

			// Spec 3.3: exact source bytes, canonical manifest and record in the
			// pair `current` names.
			const directory = proposalDirectory(fx, sha);
			const records = await recordsDirectory(fx, sha);
			expect(await readFile(path.join(directory, DYNAMIC_SOURCE_FILE))).toEqual(
				Buffer.from(UPPER_SOURCE, "utf8"),
			);
			expect(await readFile(path.join(records, DYNAMIC_MANIFEST_FILE))).toEqual(
				canonicalDynamicDocument(MANIFEST),
			);
			const record = await readProposalRecord(fx, sha);
			expect(record).toMatchObject({
				schema: "pi-workflow-dynamic-proposal",
				contractRevision: WORKFLOW_CONTRACT_REVISION,
				sourceSha256: sha,
				manifestSha256,
				hostApiSha256: HOST_API_SHA256,
				importPolicySha256: IMPORT_POLICY_SHA256,
				definitionIdentitySha256: view.definitionIdentitySha256,
				proposer: PROPOSER,
				proposedAt: view.proposedAt,
				projectRoot: await realpath(fx.cwd),
			});
			expect(await readFile(path.join(records, DYNAMIC_PROPOSAL_FILE))).toEqual(
				canonicalDynamicDocument(record),
			);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("lists proposals through proposals(), not list()", async () => {
		const fx = await fixture("proposals");
		const service = await serviceFor(fx);
		try {
			expect(await service.proposals()).toEqual([]);
			const view = await propose(service, UPPER_SOURCE);
			expect(await service.proposals()).toEqual([view]);
			// D11: `list()` stays static-only.
			expect(
				(await service.list()).workflows.map((entry) => entry.name),
			).toEqual([STATIC_NAME]);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("inspects a proposal with its source text", async () => {
		const fx = await fixture("inspect");
		const service = await serviceFor(fx);
		try {
			const view = await propose(service, UPPER_SOURCE);
			expect(await service.inspectProposal(view.ref)).toEqual({
				...view,
				source: UPPER_SOURCE,
			});
			const missing = "0".repeat(64);
			await refused(
				service.inspectProposal(dynamicRef(missing)),
				"not-found",
				MSG_PROPOSAL_NOT_FOUND(missing),
			);
			await refused(
				service.inspectProposal("dynamic:not-a-digest"),
				"validation",
				REF_INVALID_MESSAGE,
			);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("returns the existing view when the same source is proposed again", async () => {
		const fx = await fixture("idempotent");
		const service = await serviceFor(fx);
		try {
			const first = await propose(service, UPPER_SOURCE);
			const again = await service.propose(UPPER_SOURCE, {
				proposer: { kind: "api", via: "test" },
			});
			expect(again).toEqual(first);
			expect(await service.proposals()).toHaveLength(1);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("refuses sources outside the intake bounds with exact messages", async () => {
		const fx = await fixture("bounds");
		const service = await serviceFor(fx);
		try {
			await refused(
				propose(service, ""),
				"validation",
				"Dynamic workflow source is empty.",
			);
			await refused(
				propose(service, "x".repeat(MAX_DYNAMIC_SOURCE_BYTES + 1)),
				"validation",
				`Dynamic workflow source exceeds ${MAX_DYNAMIC_SOURCE_BYTES} bytes.`,
			);
			await refused(
				propose(service, "\uD800 export default 1;"),
				"validation",
				"Dynamic workflow source is not valid UTF-8.",
			);
			await refused(
				propose(service, 42 as unknown as string),
				"validation",
				"Dynamic workflow source must be a string.",
			);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("applies the registry import gate to dynamic sources verbatim", async () => {
		const fx = await fixture("import-gate");
		const service = await serviceFor(fx);
		try {
			await refused(
				propose(service, `import fs from "node:fs";\nexport default fs;\n`),
				"validation",
				`workflow import node:fs is not identity-bound by contract revision ${WORKFLOW_CONTRACT_REVISION}`,
			);
			await refused(
				propose(
					service,
					`import { defineWorkflow } from "@vegardx/pi-workflow";\nconst fs = require("node:fs");\nexport default defineWorkflow({} as never);\n`,
				),
				"validation",
				`dynamic imports and CommonJS require are not supported by contract revision ${WORKFLOW_CONTRACT_REVISION}`,
			);
			await refused(
				propose(service, "const x: = 1;\nexport default x;\n"),
				"validation",
				"workflow definition syntax is invalid",
			);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("refuses import.meta and any export shape but one default export", async () => {
		const fx = await fixture("export-shape");
		const service = await serviceFor(fx);
		const exportShape =
			"dynamic workflow source must have exactly one default export and no named exports";
		try {
			await refused(
				propose(
					service,
					`import { defineWorkflow } from "@vegardx/pi-workflow";\nexport const helper = 1;\nexport default defineWorkflow({} as never);\n`,
				),
				"validation",
				exportShape,
			);
			await refused(
				propose(service, "const definition = 1;\n"),
				"validation",
				exportShape,
			);
			await refused(
				propose(
					service,
					`export { Type } from "typebox";\nexport default 1;\n`,
				),
				"validation",
				exportShape,
			);
			await refused(
				propose(
					service,
					`import { defineWorkflow } from "@vegardx/pi-workflow";\nconst here = import.meta.url;\nexport default defineWorkflow({} as never);\n`,
				),
				"validation",
				"dynamic workflow source may not use import.meta",
			);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("refuses a proposer that fails the schema", async () => {
		const fx = await fixture("proposer");
		const service = await serviceFor(fx);
		try {
			await refused(
				service.propose(UPPER_SOURCE, {
					proposer: { kind: "model", via: "workflow_propose" } as never,
				}),
				"validation",
				"Invalid dynamic workflow proposer.",
			);
			await refused(
				service.propose(UPPER_SOURCE, {} as never),
				"validation",
				"Invalid dynamic workflow proposer.",
			);
			expect(await service.proposals()).toEqual([]);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("reports a manifest extraction failure with the bridge reason", async () => {
		const fx = await fixture("manifest-failure");
		const service = await serviceFor(fx);
		try {
			await refused(
				propose(
					service,
					`import { defineWorkflow } from "@vegardx/pi-workflow";\nexport default { nope: true };\n`,
				),
				"validation",
				"Dynamic workflow manifest extraction failed: Dynamic workflow source execution failed: DynamicDefinitionError: workflow module has no valid default definition",
			);
			expect(await service.proposals()).toEqual([]);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("refuses invalid dynamic options at construction", async () => {
		const fx = await fixture("dynamic-options");
		for (const dynamic of [
			null,
			"fast",
			[],
			{ bootTimeoutMs: 0 },
			{ bootTimeoutMs: 1.5 },
			{ bootTimeoutMs: "1" },
			{ bootTimeoutMs: 2_147_483_648 },
			{ computeTimeoutMs: -1 },
			{ computeTimeoutMs: Number.POSITIVE_INFINITY },
			{ computeTimeoutMs: Number.NaN },
			// Closed: limits and worker entries never pass through the service.
			{ bootTimeoutMs: 1, resourceLimits: { maxOldGenerationSizeMb: 1 } },
			{ workerEntry: new URL("file:///rogue-worker.js") },
			{ syncWaitMs: 1 },
		]) {
			await refused(
				serviceFor(fx, {
					dynamic: dynamic as unknown as NonNullable<
						WorkflowServiceOptions["dynamic"]
					>,
				}),
				"validation",
				"Workflow service dynamic options are invalid.",
			);
		}
	});

	it("applies the configured boot watchdog to manifest extraction", async () => {
		const fx = await fixture("boot-timeout");
		const service = await serviceFor(fx, { dynamic: { bootTimeoutMs: 1 } });
		try {
			await refused(
				propose(service, UPPER_SOURCE),
				"validation",
				"Dynamic workflow manifest extraction failed: Dynamic workflow VM did not boot within 1 ms.",
			);
			expect(await service.proposals()).toEqual([]);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("requires project trust on every dynamic surface", async () => {
		const fx = await fixture("untrusted");
		const trusted = await serviceFor(fx);
		let ref: string;
		try {
			ref = (await propose(trusted, UPPER_SOURCE)).ref;
		} finally {
			await bounded(trusted.shutdown(), "shutdown");
		}
		const service = await serviceFor(fx, { projectTrusted: () => false });
		try {
			await refused(
				service.propose(UPPER_SOURCE, { proposer: PROPOSER }),
				"validation",
				TRUST_REQUIRED_MESSAGE,
			);
			await refused(
				service.inspectProposal(ref),
				"validation",
				TRUST_REQUIRED_MESSAGE,
			);
			await refused(service.proposals(), "validation", TRUST_REQUIRED_MESSAGE);
			await refused(
				service.decideSource(ref, { decision: "approved", approver: APPROVER }),
				"validation",
				TRUST_REQUIRED_MESSAGE,
			);
			await refused(
				service.run(ref, { value: "x" }),
				"validation",
				TRUST_REQUIRED_MESSAGE,
			);
			await refused(
				service.validate(ref),
				"validation",
				TRUST_REQUIRED_MESSAGE,
			);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});
});

describe("decideSource", () => {
	it("approves a proposal and records the human decision under decisions/", async () => {
		const fx = await fixture("approve");
		const service = await serviceFor(fx);
		try {
			const proposed = await propose(service, UPPER_SOURCE);
			const view = await service.decideSource(proposed.ref, {
				decision: "approved",
				approver: APPROVER,
			});
			expect(view).toEqual({
				...proposed,
				decision: {
					decision: "approved",
					approver: APPROVER,
					approvedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
					approvalSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				},
				runnable: true,
			});
			const record = await readJson<WorkflowDecisionRecord>(
				approvalPath(fx, view),
			);
			expect(record).toMatchObject({
				schema: "pi-workflow-decision",
				contractRevision: WORKFLOW_CONTRACT_REVISION,
				binding: sourceApprovalBinding(view),
				source: "operator",
				decidedBy: `human:${APPROVER.via}`,
				decidedAt: view.decision?.approvedAt,
				value: {
					schema: "pi-workflow-source-approval",
					sourceSha256: view.sourceSha256,
					manifestSha256: view.manifestSha256,
					hostApiSha256: HOST_API_SHA256,
					importPolicySha256: IMPORT_POLICY_SHA256,
					definitionIdentitySha256: view.definitionIdentitySha256,
					decision: "approved",
					approver: APPROVER,
					approvedAt: view.decision?.approvedAt,
					projectRoot: await realpath(fx.cwd),
				},
			});
			expect(record.reason).toBeUndefined();
			expect(deriveDecisionRecordSha256(record)).toBe(
				view.decision?.approvalSha256,
			);
			expect(await service.inspectProposal(view.ref)).toEqual({
				...view,
				source: UPPER_SOURCE,
			});
			expect(await service.proposals()).toEqual([view]);
			expect(await service.validate(view.ref, { value: "x" })).toEqual({
				valid: true,
				workflow: {
					name: DEFINITION_NAME,
					description: META.description,
					version: 1,
					concurrency: 2,
					budget: META.budget,
					timeoutMs: META.timeoutMs,
					scope: "dynamic",
					source: "proposal",
					path: view.path,
					identitySha256: view.definitionIdentitySha256,
					// A dynamic proposal declares no `needs`, so the conservative
					// reading applies and `declared` says it was not the source's.
					needs: { workspace: "worktree", declared: false },
				},
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("keeps a rejection final: re-propose, approve, and run all see it", async () => {
		const fx = await fixture("reject");
		const service = await serviceFor(fx);
		try {
			const proposed = await propose(service, UPPER_SOURCE);
			const rejected = await service.decideSource(proposed.ref, {
				decision: "rejected",
				approver: REJECTER,
				reason: "Not this one.",
			});
			expect(rejected).toEqual({
				...proposed,
				decision: {
					decision: "rejected",
					approver: REJECTER,
					approvedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
					approvalSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
					reason: "Not this one.",
				},
				runnable: false,
			});
			expect(
				await readJson<WorkflowDecisionRecord>(approvalPath(fx, rejected)),
			).toMatchObject({
				decidedBy: `human:${REJECTER.via}`,
				reason: "Not this one.",
				value: { decision: "rejected", reason: "Not this one." },
			});
			// D6: re-proposing a rejected digest returns the rejection.
			expect(await propose(service, UPPER_SOURCE)).toEqual(rejected);
			await refused(
				service.decideSource(proposed.ref, {
					decision: "approved",
					approver: APPROVER,
				}),
				"conflict",
				MSG_REJECTED,
			);
			await refused(
				service.run(proposed.ref, { value: "x" }),
				"validation",
				MSG_REJECTED,
			);
			await refused(service.validate(proposed.ref), "validation", MSG_REJECTED);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("refuses a second decision once approved", async () => {
		const fx = await fixture("decide-twice");
		const service = await serviceFor(fx);
		try {
			const view = await approved(service, UPPER_SOURCE);
			for (const decision of ["approved", "rejected"] as const) {
				await refused(
					service.decideSource(view.ref, { decision, approver: APPROVER }),
					"conflict",
					MSG_ALREADY_APPROVED,
				);
			}
			expect(await service.inspectProposal(view.ref)).toEqual({
				...view,
				source: UPPER_SOURCE,
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("validates the reference and the decision options", async () => {
		const fx = await fixture("decide-options");
		const service = await serviceFor(fx);
		try {
			const view = await propose(service, UPPER_SOURCE);
			await refused(
				service.decideSource(view.ref, {
					decision: "approved",
					approver: { kind: "model", via: "workflow_propose" } as never,
				}),
				"validation",
				"Invalid dynamic workflow approver.",
			);
			await refused(
				service.decideSource(view.ref, {
					decision: "maybe" as never,
					approver: APPROVER,
				}),
				"validation",
				"Invalid dynamic workflow decision.",
			);
			await refused(
				service.decideSource(view.ref, {
					decision: "approved",
					approver: APPROVER,
					reason: "",
				}),
				"validation",
				"Invalid dynamic workflow decision reason.",
			);
			const missing = "1".repeat(64);
			await refused(
				service.decideSource(dynamicRef(missing), {
					decision: "approved",
					approver: APPROVER,
				}),
				"not-found",
				MSG_PROPOSAL_NOT_FOUND(missing),
			);
			await refused(
				service.decideSource("dynamic:nope", {
					decision: "approved",
					approver: APPROVER,
				}),
				"validation",
				REF_INVALID_MESSAGE,
			);
			expect(
				(await service.inspectProposal(view.ref)).decision,
			).toBeUndefined();
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("refuses to decide a proposal that predates the current host API", async () => {
		const fx = await fixture("stale-host-api");
		const first = await serviceFor(fx);
		let ref: string;
		try {
			ref = (await propose(first, UPPER_SOURCE)).ref;
		} finally {
			await bounded(first.shutdown(), "shutdown");
		}
		simulateHostApiChange();
		const service = await serviceFor(fx);
		try {
			await refused(
				service.decideSource(ref, { decision: "approved", approver: APPROVER }),
				"validation",
				MSG_PROPOSAL_STALE_HOST_API,
			);
			await refused(
				service.run(ref, { value: "x" }),
				"validation",
				MSG_PROPOSAL_STALE_HOST_API,
			);
			expect(await service.inspectProposal(ref)).toMatchObject({
				hostApiSha256: HOST_API_SHA256,
				runnable: false,
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("refuses to decide a proposal whose import policy changed", async () => {
		const fx = await fixture("stale-import-policy");
		const first = await serviceFor(fx);
		let ref: string;
		try {
			ref = (await propose(first, UPPER_SOURCE)).ref;
		} finally {
			await bounded(first.shutdown(), "shutdown");
		}
		const service = await serviceFor(fx, withoutImportableHelpers());
		try {
			expect(IMPORT_POLICY_WITHOUT_HELPERS).not.toBe(IMPORT_POLICY_SHA256);
			await refused(
				service.decideSource(ref, { decision: "approved", approver: APPROVER }),
				"validation",
				MSG_PROPOSAL_STALE_IMPORT_POLICY,
			);
			await refused(
				service.run(ref, { value: "x" }),
				"validation",
				MSG_IMPORT_POLICY_CHANGED_SINCE_APPROVAL,
			);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("refuses a proposal that belongs to another project", async () => {
		const fx = await fixture("other-project");
		const first = await serviceFor(fx);
		let ref: string;
		try {
			ref = (await propose(first, UPPER_SOURCE)).ref;
		} finally {
			await bounded(first.shutdown(), "shutdown");
		}
		const service = await serviceFor(fx, { cwd: await otherProject(fx) });
		try {
			await refused(
				service.decideSource(ref, { decision: "approved", approver: APPROVER }),
				"validation",
				MSG_PROPOSAL_OTHER_PROJECT,
			);
			await refused(
				service.run(ref, { value: "x" }),
				"validation",
				MSG_PROPOSAL_OTHER_PROJECT,
			);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});
});

describe("running dynamic workflows", () => {
	it("refuses to run or validate an unapproved proposal", async () => {
		const fx = await fixture("unapproved");
		const service = await serviceFor(fx);
		try {
			const view = await propose(service, UPPER_SOURCE);
			await refused(
				service.run(view.ref, { value: "x" }),
				"validation",
				MSG_NOT_APPROVED,
			);
			await refused(service.validate(view.ref), "validation", MSG_NOT_APPROVED);
			await refused(
				service.run("dynamic:xyz", { value: "x" }),
				"validation",
				REF_INVALID_MESSAGE,
			);
			const missing = "2".repeat(64);
			await refused(
				service.run(dynamicRef(missing), { value: "x" }),
				"not-found",
				MSG_PROPOSAL_NOT_FOUND(missing),
			);
			expect((await service.listRuns()).runs).toEqual([]);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("runs an approved source through the VM to completion with the definition copy", async () => {
		const fx = await fixture("run");
		const service = await serviceFor(fx);
		try {
			const view = await approved(service, UPPER_SOURCE);
			await refused(
				service.run(view.ref, { value: 7 }),
				"validation",
				"Workflow input does not match its schema.",
			);
			const receipt = await service.run(view.ref, { value: "hello" });
			expect(receipt).toEqual({
				runId: expect.stringMatching(/^workflow_/),
				status: "created",
			});
			const final = await bounded(service.wait(receipt.runId), "wait");
			expect(final).toMatchObject({
				status: "completed",
				definitionName: DEFINITION_NAME,
				depth: 0,
				output: { answer: "HELLO" },
				dynamic: {
					ref: view.ref,
					sourceSha256: view.sourceSha256,
					approvalSha256: view.decision?.approvalSha256,
					hostApiSha256: HOST_API_SHA256,
				},
			});
			expect(final.parked).toBeUndefined();
			expect(
				final.tasks?.map((task) => [task.kind, task.key, task.status]),
			).toEqual([["support", "plan", "completed"]]);

			// Spec 5.2: the record names the dynamic definition and its digests.
			const record = await readJson<Record<string, unknown>>(
				path.join(fx.storeRoot, "runs", receipt.runId, "service.json"),
			);
			expect(record).toMatchObject({
				runId: receipt.runId,
				depth: 0,
				definitionKind: "dynamic",
				definitionName: DEFINITION_NAME,
				definitionPath: view.path,
				definitionIdentitySha256: view.definitionIdentitySha256,
				definitionSourceSha256: view.sourceSha256,
				approvalSha256: view.decision?.approvalSha256,
				hostApiSha256: HOST_API_SHA256,
				cwd: await realpath(fx.cwd),
				input: { value: "hello" },
			});
			expect(record.parent).toBeUndefined();

			// Spec 4.4: the per-run source, manifest, and proposal copies are
			// byte-identical to the store; the approval copy is the canonical
			// decision record plus exactly one trailing newline.
			const definition = runDefinitionDirectory(fx, receipt.runId);
			const records = await recordsDirectory(fx, view.sourceSha256);
			expect(
				await readFile(path.join(definition, DYNAMIC_SOURCE_FILE)),
			).toEqual(Buffer.from(UPPER_SOURCE, "utf8"));
			expect(
				await readFile(path.join(definition, DYNAMIC_MANIFEST_FILE)),
			).toEqual(await readFile(path.join(records, DYNAMIC_MANIFEST_FILE)));
			expect(
				await readFile(path.join(definition, DYNAMIC_PROPOSAL_FILE)),
			).toEqual(await readFile(path.join(records, DYNAMIC_PROPOSAL_FILE)));
			const storedApproval = await readFile(approvalPath(fx, view));
			const copiedApproval = await readFile(
				path.join(definition, DYNAMIC_APPROVAL_FILE),
			);
			expect(storedApproval.at(-1)).not.toBe(0x0a);
			expect(copiedApproval).toEqual(
				Buffer.concat([storedApproval, Buffer.from("\n", "utf8")]),
			);
			expect(JSON.parse(copiedApproval.toString("utf8"))).toEqual(
				JSON.parse(storedApproval.toString("utf8")),
			);

			const events = await journalEvents(fx.storeRoot, receipt.runId);
			expect(events[0]).toMatchObject({
				type: "run-created",
				data: {
					definitionIdentitySha256: view.definitionIdentitySha256,
					inputSha256: deriveJsonValueSha256({ value: "hello" }),
				},
			});
			const changes = await statusChanges(fx.storeRoot, receipt.runId);
			expect(changes.map((change) => change.to)).not.toContain("failed");
			expect(changes.at(-1)?.to).toBe("completed");
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("parks at a checkpoint and completes after the decision with a fresh drive", async () => {
		const fx = await fixture("park");
		const service = await serviceFor(fx);
		try {
			const view = await approved(service, CHECKPOINT_SOURCE);
			const receipt = await service.run(view.ref, { value: "park" });
			const parked = await bounded(service.wait(receipt.runId), "park");
			expect(parked).toMatchObject({
				status: "waiting",
				parked: true,
				dynamic: { ref: view.ref },
			});
			const task = checkpointTask(parked);
			expect(task).toMatchObject({
				kind: "checkpoint",
				key: "approve",
				status: "waiting",
			});
			expect(parked.pendingCheckpoints).toHaveLength(1);
			await service.decide(receipt.runId, task.id, {
				decision: DECISION,
				approver: "vegard",
			});
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({
				status: "completed",
				output: { answer: "approved" },
			});
			const changes = await statusChanges(fx.storeRoot, receipt.runId);
			expect(changes.map((change) => change.to)).not.toContain("failed");
			expect(changes.at(-1)?.to).toBe("completed");
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("resumes a parked run after a restart from the verified definition copy", async () => {
		const parked = await parkedRun("resume");
		const service = await serviceFor(parked.fx);
		try {
			const view = await bounded(service.wait(parked.runId), "re-park");
			expect(view).toMatchObject({
				status: "waiting",
				parked: true,
				dynamic: { ref: parked.view.ref },
			});
			expect(checkpointTask(view).id).toBe(parked.taskId);
			await service.decide(parked.runId, parked.taskId, {
				decision: DECISION,
				approver: "vegard",
			});
			await expect(
				bounded(service.wait(parked.runId), "wait"),
			).resolves.toMatchObject({
				status: "completed",
				output: { answer: "approved" },
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("records a throwing source as the exact D9 failure reason", async () => {
		const fx = await fixture("throws");
		const service = await serviceFor(fx);
		try {
			const view = await approved(service, THROWING_SOURCE);
			const receipt = await service.run(view.ref, { value: "boom" });
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({ status: "failed" });
			const changes = await statusChanges(fx.storeRoot, receipt.runId);
			// D9: the exact dynamic reason; `from` is whatever status the source
			// failed in (a phase alone does not start the run).
			expect(changes.at(-1)).toMatchObject({
				to: "failed",
				reason: "Dynamic workflow source execution failed: Error: boom",
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("applies the configured boot watchdog to every run drive", async () => {
		const fx = await fixture("run-boot-timeout");
		const approver = await serviceFor(fx);
		let ref: string;
		try {
			ref = (await approved(approver, UPPER_SOURCE)).ref;
		} finally {
			await bounded(approver.shutdown(), "shutdown");
		}
		const service = await serviceFor(fx, { dynamic: { bootTimeoutMs: 1 } });
		try {
			const receipt = await service.run(ref, { value: "hello" });
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({ status: "failed" });
			expect(
				(await statusChanges(fx.storeRoot, receipt.runId)).at(-1),
			).toMatchObject({
				to: "failed",
				reason: "Dynamic workflow VM did not boot within 1 ms.",
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("never runs a dynamic definition as a nested child", async () => {
		const fx = await fixture("nested");
		const service = await serviceFor(fx);
		try {
			const view = await approved(service, SELF_NESTING_SOURCE);
			// A static parent naming the proposal: not a definition name.
			await writeFile(
				path.join(fx.cwd, "workflows", "parent.workflow.ts"),
				staticDefinition(
					"parent",
					`return ctx.workflow("child", { workflow: ${JSON.stringify(view.ref)}, input: {} });`,
				),
			);
			const parent = await service.run("parent", {});
			await expect(
				bounded(service.wait(parent.runId), "parent"),
			).resolves.toMatchObject({ status: "failed" });
			expect(
				(await statusChanges(fx.storeRoot, parent.runId)).at(-1),
			).toMatchObject({ to: "failed", reason: STATIC_FAILURE_REASON });

			// Dynamic source naming its own manifest: only discovered static
			// definitions resolve as children (spec 5.4).
			const receipt = await service.run(view.ref, { value: "nest" });
			await expect(
				bounded(service.wait(receipt.runId), "wait"),
			).resolves.toMatchObject({ status: "failed" });
			expect(
				(await statusChanges(fx.storeRoot, receipt.runId)).at(-1),
			).toMatchObject({
				to: "failed",
				reason:
					"Dynamic workflow source execution failed: StaticWorkflowRuntimeError: Nested workflow definition is not discovered.",
			});
			expect(
				(await service.list()).workflows.map((entry) => entry.name).sort(),
			).toEqual(["parent", STATIC_NAME]);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});
});

describe("approval tampering (spec 11.3)", () => {
	it("refuses to resume when the copied source bytes changed", async () => {
		const parked = await parkedRun("tamper-source");
		const sourcePath = path.join(parked.definition, DYNAMIC_SOURCE_FILE);
		await writeFile(
			sourcePath,
			`${await readFile(sourcePath, "utf8")}// tampered\n`,
		);
		await resumeRefused(parked, MSG_SOURCE_CHANGED);
	});

	it("refuses to resume when the copied approval decision was flipped", async () => {
		const parked = await parkedRun("tamper-decision");
		await rewriteCanonical<WorkflowDecisionRecord>(
			path.join(parked.definition, DYNAMIC_APPROVAL_FILE),
			(record) => {
				(record.value as { decision: string }).decision = "rejected";
				record.valueSha256 = deriveJsonValueSha256(record.value);
			},
		);
		await resumeRefused(parked, MSG_APPROVAL_CHANGED);
	});

	it("refuses to resume when a single byte of the copied approval changed", async () => {
		const parked = await parkedRun("tamper-byte");
		await flipByte(
			path.join(parked.definition, DYNAMIC_APPROVAL_FILE),
			'"approvedAt":"',
		);
		await resumeRefused(parked, MSG_APPROVAL_CHANGED);
	});

	it("refuses to resume when the copied manifest changed", async () => {
		const parked = await parkedRun("tamper-manifest");
		await rewriteCanonical<{ meta: { description: string } }>(
			path.join(parked.definition, DYNAMIC_MANIFEST_FILE),
			(manifest) => {
				manifest.meta.description = "tampered";
			},
		);
		await resumeRefused(parked, MSG_MANIFEST_CHANGED);
	});

	it("refuses to resume under a changed host API", async () => {
		const parked = await parkedRun("tamper-host-api");
		simulateHostApiChange();
		await resumeRefused(parked, MSG_HOST_API_CHANGED);
	});

	it("refuses to resume under a changed import policy", async () => {
		const parked = await parkedRun("tamper-import-policy");
		await resumeRefused(
			parked,
			MSG_IMPORT_POLICY_CHANGED_SINCE_APPROVAL,
			withoutImportableHelpers(),
		);
	});

	it("refuses to resume from another project directory", async () => {
		const parked = await parkedRun("tamper-cwd");
		await resumeRefused(parked, MSG_PROJECT_CHANGED, {
			cwd: await otherProject(parked.fx),
		});
	});

	it("refuses to run on a forged store approval decided by a model", async () => {
		const fx = await fixture("forge-model");
		const service = await serviceFor(fx);
		try {
			const view = await propose(service, UPPER_SOURCE);
			const forged = {
				...createSourceApprovalRecord({
					proposal: await readProposalRecord(fx, view.sourceSha256),
					decision: "approved",
					approver: APPROVER,
					approvedAt: "2026-09-15T10:00:00.000Z",
					projectRoot: await realpath(fx.cwd),
				}),
				decidedBy: "model:workflow_propose",
			};
			await mkdir(decisionsDirectory(fx, view.sourceSha256), {
				recursive: true,
			});
			await writeFile(
				approvalPath(fx, view),
				canonicalDynamicDocument(forged).subarray(0, -1),
			);
			await refused(
				service.run(view.ref, { value: "x" }),
				"persistence",
				MSG_APPROVAL_INVALID,
			);
			await refused(
				service.validate(view.ref),
				"persistence",
				MSG_APPROVAL_INVALID,
			);
			expect((await service.listRuns()).runs).toEqual([]);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("refuses to run on a forged store approval with a wrong value digest", async () => {
		const fx = await fixture("forge-digest");
		const service = await serviceFor(fx);
		try {
			const view = await propose(service, UPPER_SOURCE);
			const forged = {
				...createSourceApprovalRecord({
					proposal: await readProposalRecord(fx, view.sourceSha256),
					decision: "approved",
					approver: APPROVER,
					approvedAt: "2026-09-15T10:00:00.000Z",
					projectRoot: await realpath(fx.cwd),
				}),
				valueSha256: "0".repeat(64),
			};
			await mkdir(decisionsDirectory(fx, view.sourceSha256), {
				recursive: true,
			});
			await writeFile(
				approvalPath(fx, view),
				canonicalDynamicDocument(forged).subarray(0, -1),
			);
			await refused(
				service.run(view.ref, { value: "x" }),
				"persistence",
				MSG_APPROVAL_INVALID,
			);
			expect((await service.listRuns()).runs).toEqual([]);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("refuses to run on an approval recorded for another project", async () => {
		const fx = await fixture("forge-project");
		const service = await serviceFor(fx);
		try {
			const view = await propose(service, UPPER_SOURCE);
			const store = await WorkflowDecisionRecordStore.openRoot({
				directory: decisionsDirectory(fx, view.sourceSha256),
			});
			await store.put(
				createSourceApprovalRecord({
					proposal: await readProposalRecord(fx, view.sourceSha256),
					decision: "approved",
					approver: APPROVER,
					approvedAt: "2026-09-15T10:00:00.000Z",
					projectRoot: await otherProject(fx),
				}),
			);
			await refused(
				service.run(view.ref, { value: "x" }),
				"validation",
				MSG_APPROVAL_OTHER_PROJECT,
			);
			expect(await service.inspectProposal(view.ref)).toMatchObject({
				decision: { decision: "approved" },
				runnable: true,
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("refuses to run on an approval that does not match the proposal", async () => {
		const fx = await fixture("forge-mismatch");
		const service = await serviceFor(fx);
		try {
			const view = await propose(service, UPPER_SOURCE);
			const proposal = await readProposalRecord(fx, view.sourceSha256);
			const record = createSourceApprovalRecord({
				proposal: { ...proposal, manifestSha256: "9".repeat(64) },
				decision: "approved",
				approver: APPROVER,
				approvedAt: "2026-09-15T10:00:00.000Z",
				projectRoot: await realpath(fx.cwd),
			});
			const store = await WorkflowDecisionRecordStore.openRoot({
				directory: decisionsDirectory(fx, view.sourceSha256),
			});
			await store.put(record);
			await refused(
				service.run(view.ref, { value: "x" }),
				"validation",
				MSG_APPROVAL_MISMATCH,
			);
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});

	it("resumes from the run copy after the store decision is deleted; new runs refuse", async () => {
		const parked = await parkedRun("delete-decision");
		await rm(approvalPath(parked.fx, parked.view));
		const service = await serviceFor(parked.fx);
		try {
			const view = await bounded(service.wait(parked.runId), "re-park");
			expect(view).toMatchObject({ status: "waiting", parked: true });
			await service.decide(parked.runId, checkpointTask(view).id, {
				decision: DECISION,
				approver: "vegard",
			});
			await expect(
				bounded(service.wait(parked.runId), "wait"),
			).resolves.toMatchObject({
				status: "completed",
				output: { answer: "approved" },
			});
			await refused(
				service.run(parked.view.ref, { value: "again" }),
				"validation",
				MSG_NOT_APPROVED,
			);
			expect(await service.inspectProposal(parked.view.ref)).toMatchObject({
				runnable: false,
			});
		} finally {
			await bounded(service.shutdown(), "shutdown");
		}
	});
});
