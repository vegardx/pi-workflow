import path from "node:path";
import {
	defineWorkflow,
	type WorkflowContext,
	type WorkflowDefinition,
} from "../definition.js";
import { deriveJsonValueSha256 } from "../execution.js";
import type { WorkflowRunJournal } from "../persistence/journal.js";
import type { DiscoveredWorkflow } from "../registry.js";
import {
	isStaticWorkflowParkSignal,
	type WorkflowHostBridge,
	workflowHostBridge,
} from "../static-runtime.js";
import type {
	DynamicSupportHelperSpec,
	DynamicWorkflowManifest,
	DynamicWorkflowProposalRecord,
} from "./contracts.js";
import { DynamicWorkflowExecutionError } from "./execution-error.js";
import {
	deriveDynamicHostApiSha256,
	deriveDynamicImportPolicySha256,
} from "./identity.js";
import {
	readRunDefinitionCopy,
	verifyRunDefinitionCopy,
} from "./run-definition.js";
import { deriveDynamicSourceSha256 } from "./source.js";
import {
	createDynamicVm,
	type DynamicVm,
	type DynamicVmBridgeOverrides,
	type DynamicVmOptions,
	MSG_BRIDGE_REQUIRES_STATIC_CONTEXT,
	MSG_EXECUTION_ABORTED,
	MSG_MANIFEST_CHANGED,
	MSG_VM_CRASHED,
} from "./vm-host.js";

/** `DiscoveredWorkflow.source` of every proposal-backed definition. */
export const DYNAMIC_WORKFLOW_SOURCE = "proposal";

/**
 * Creates the host side of one VM. Production code always uses
 * {@link createDynamicVm}; tests inject a fake so the bridge is exercised
 * without a worker thread.
 */
export type DynamicVmFactory = (options: DynamicVmOptions) => DynamicVm;

/** `start.seed` of a run's VM (spec 7.4): a pure function of the run id. */
export function deriveDynamicVmSeed(runId: string): string {
	return deriveJsonValueSha256({ kind: "dynamic-vm-seed", runId });
}

export interface DynamicWorkflowDefinitionOptions {
	readonly manifest: DynamicWorkflowManifest;
	readonly source: string;
	/** Derived from `source` when omitted. */
	readonly sourceSha256?: string;
	readonly supportHelpers: readonly DynamicSupportHelperSpec[];
	/** The run's `createdAt`; `Date.parse` of it fixes the VM clock. */
	readonly createdAt: string;
	/** Watchdogs from the service's `dynamic` option; limits are tests only. */
	readonly overrides?: DynamicVmBridgeOverrides;
	/** Tests: proves a fresh worker per drive. */
	readonly onBoot?: (info: { readonly threadId: number }) => void;
	/** Tests only: replaces the real worker host. */
	readonly createVm?: DynamicVmFactory;
}

function hostBridgeOf(
	ctx: WorkflowContext<unknown>,
): WorkflowHostBridge | undefined {
	const bridge = (
		ctx as WorkflowContext<unknown> & {
			readonly [workflowHostBridge]?: WorkflowHostBridge;
		}
	)[workflowHostBridge];
	return bridge !== undefined && typeof bridge.agentInNamespace === "function"
		? bridge
		: undefined;
}

/**
 * Maps whatever escapes the host to the D9 failure reason the static runtime
 * records. Host errors already carry their stage; a park signal is passed
 * through untouched so the static runtime parks; anything else is a host
 * fault, reported as a VM crash (section 6.5) under the fixed reason: the
 * fault's own message may name file system paths, so it travels only as the
 * cause and never into the journal.
 */
function hostFailure(error: unknown): unknown {
	if (
		isStaticWorkflowParkSignal(error) ||
		error instanceof DynamicWorkflowExecutionError
	) {
		return error;
	}
	return new DynamicWorkflowExecutionError("exit", MSG_VM_CRASHED, {
		cause: error,
	});
}

/**
 * The dynamic definition (spec 8): a `WorkflowDefinition` whose `meta` and
 * schemas come from the approved manifest and whose `run(ctx)` boots one VM
 * per drive through the host, hands it the static-runtime context, and always
 * terminates the worker. A checkpoint park is rethrown as the very same
 * object so the static runtime parks instead of failing; every other failure
 * is a `DynamicWorkflowExecutionError` whose message becomes the
 * `run-status-changed -> failed` reason.
 */
export function createDynamicWorkflowDefinition(
	options: DynamicWorkflowDefinitionOptions,
): WorkflowDefinition {
	const { manifest, source, supportHelpers, createdAt } = options;
	const sourceSha256 =
		options.sourceSha256 ?? deriveDynamicSourceSha256(source);
	const createVm = options.createVm ?? createDynamicVm;
	const manifestSha256 = deriveJsonValueSha256(manifest);
	const epochMs = Date.parse(createdAt);
	/** Spec 8 step 4: the VM's manifest must equal the approved one. */
	const onReady = (ready: DynamicWorkflowManifest): void => {
		if (deriveJsonValueSha256(ready) !== manifestSha256) {
			throw new DynamicWorkflowExecutionError("manifest", MSG_MANIFEST_CHANGED);
		}
	};
	return defineWorkflow({
		meta: manifest.meta,
		inputSchema: manifest.inputSchema,
		outputSchema: manifest.outputSchema,
		async run(ctx: WorkflowContext<unknown>): Promise<unknown> {
			if (ctx.signal.aborted) {
				throw new DynamicWorkflowExecutionError("abort", MSG_EXECUTION_ABORTED);
			}
			if (hostBridgeOf(ctx) === undefined) {
				throw new DynamicWorkflowExecutionError(
					"protocol",
					MSG_BRIDGE_REQUIRES_STATIC_CONTEXT,
				);
			}
			// One worker per drive: the host spawns it inside `run` and posts
			// `start` from the context (`input`, `runId`, `cwd`) and these options.
			const vm = createVm({
				source,
				sourceSha256,
				supportHelpers,
				epochMs,
				seed: deriveDynamicVmSeed(ctx.runId),
				...(options.overrides === undefined
					? {}
					: { overrides: options.overrides }),
				...(options.onBoot === undefined ? {} : { onBoot: options.onBoot }),
				onReady,
			});
			try {
				return await vm.run(ctx);
			} catch (error) {
				throw hostFailure(error);
			} finally {
				// The worker is discarded whatever happened; a terminate failure
				// must not replace the park signal or the primary error.
				await vm.terminate().catch(() => undefined);
			}
		},
	}) as WorkflowDefinition;
}

export interface DynamicDiscoveredWorkflowOptions {
	readonly proposal: DynamicWorkflowProposalRecord;
	/**
	 * The manifest the definition is built from; `proposal.manifest` when
	 * omitted. Resume passes the run copy's verified `manifest.json`.
	 */
	readonly manifest?: DynamicWorkflowManifest;
	readonly source: string;
	readonly supportHelpers: readonly DynamicSupportHelperSpec[];
	readonly createdAt: string;
	/** `<storeRoot>/dynamic/<sha>/source.workflow.ts` (or the run copy). */
	readonly path: string;
	/** Watchdogs from the service's `dynamic` option; limits are tests only. */
	readonly bridge?: DynamicVmBridgeOverrides;
	/** Tests only: replaces the real worker host. */
	readonly createVm?: DynamicVmFactory;
}

/**
 * The `DiscoveredWorkflow` the service hands to `compose` for a dynamic run
 * (spec 5.4): scope `"dynamic"`, source `"proposal"`, and the proposal's
 * path-free identity, so a dynamic run never collides with a static one.
 */
export function createDynamicDiscoveredWorkflow(
	options: DynamicDiscoveredWorkflowOptions,
): DiscoveredWorkflow {
	const { proposal } = options;
	return Object.freeze({
		definition: createDynamicWorkflowDefinition({
			manifest: options.manifest ?? proposal.manifest,
			source: options.source,
			sourceSha256: proposal.sourceSha256,
			supportHelpers: options.supportHelpers,
			createdAt: options.createdAt,
			...(options.bridge === undefined ? {} : { overrides: options.bridge }),
			...(options.createVm === undefined ? {} : { createVm: options.createVm }),
		}),
		identity: Object.freeze({
			sourceSha256: proposal.sourceSha256,
			identitySha256: proposal.definitionIdentitySha256,
		}),
		path: options.path,
		root: path.dirname(options.path),
		scope: "dynamic",
		source: DYNAMIC_WORKFLOW_SOURCE,
	});
}

export interface DynamicWorkflowRecord {
	readonly cwd: string;
	readonly createdAt: string;
	readonly definitionPath: string;
	readonly definitionIdentitySha256: string;
	readonly definitionSourceSha256: string;
	readonly approvalSha256: string;
	readonly hostApiSha256: string;
}

/**
 * `workflowForRecord` for `definitionKind: "dynamic"` (spec 5.4 steps 1-8):
 * the run directory copy is the only evidence consulted. Refusals surface as
 * `DynamicRunDefinitionError` with the spec's exact messages.
 */
export async function dynamicWorkflowForRecord(options: {
	readonly record: DynamicWorkflowRecord;
	readonly journal: Pick<WorkflowRunJournal, "directory">;
	readonly cwd: string;
	readonly supportHelpers: readonly DynamicSupportHelperSpec[];
	/** Watchdogs from the service's `dynamic` option; limits are tests only. */
	readonly bridge?: DynamicVmBridgeOverrides;
	/** Tests only: replaces the real worker host. */
	readonly createVm?: DynamicVmFactory;
}): Promise<DiscoveredWorkflow> {
	const { record } = options;
	const copy = await readRunDefinitionCopy(options.journal);
	const verified = verifyRunDefinitionCopy({
		copy,
		record,
		current: {
			cwd: options.cwd,
			hostApiSha256: deriveDynamicHostApiSha256(),
			importPolicySha256: deriveDynamicImportPolicySha256(
				options.supportHelpers,
			),
		},
	});
	return createDynamicDiscoveredWorkflow({
		proposal: verified.proposal,
		manifest: verified.manifest,
		source: verified.source,
		supportHelpers: options.supportHelpers,
		createdAt: record.createdAt,
		path: record.definitionPath,
		...(options.bridge === undefined ? {} : { bridge: options.bridge }),
		...(options.createVm === undefined ? {} : { createVm: options.createVm }),
	});
}
