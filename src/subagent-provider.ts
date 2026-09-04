import type {
	EventBus,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	SUBAGENT_RUNTIME_CONTRACT,
	type SubagentClient,
	type SubagentService,
} from "@vegardx/pi-subagent";
import {
	acquireSubagentService,
	SubagentServiceProviderError,
} from "@vegardx/pi-subagent/service-provider";
import { Value } from "typebox/value";
import {
	isCompatibleSubagentContract,
	type WorkflowRunId,
	WorkflowRunIdSchema,
} from "./contracts.js";

type CompleteMethodList<T, TMethods extends readonly (keyof T)[]> =
	Exclude<keyof T, TMethods[number]> extends never ? TMethods : never;

const SERVICE_METHOD_NAMES = [
	"forOwner",
	"listRuns",
	"inspectRun",
	"runLogs",
	"subscribe",
	"prune",
	"shutdown",
] as const satisfies readonly (keyof SubagentService)[];
const SERVICE_METHODS: CompleteMethodList<
	SubagentService,
	typeof SERVICE_METHOD_NAMES
> = SERVICE_METHOD_NAMES;

const CLIENT_METHOD_NAMES = [
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
] as const satisfies readonly (keyof SubagentClient)[];
const CLIENT_METHODS: CompleteMethodList<
	SubagentClient,
	typeof CLIENT_METHOD_NAMES
> = CLIENT_METHOD_NAMES;

function hasMethods<T extends object>(
	value: unknown,
	methods: readonly (keyof T)[],
): value is T {
	if (typeof value !== "object" || value === null) return false;
	return methods.every(
		(method) => typeof value[method as keyof object] === "function",
	);
}

export type WorkflowSubagentProviderErrorCode =
	| "missing"
	| "duplicate"
	| "incompatible"
	| "acquisition"
	| "replaced";

export class WorkflowSubagentProviderError extends Error {
	constructor(
		readonly code: WorkflowSubagentProviderErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "WorkflowSubagentProviderError";
	}
}

export interface WorkflowSubagentBinding {
	readonly workflowRunId: WorkflowRunId;
	readonly ownerId: string;
	readonly client: SubagentClient;
}

export interface WorkflowSubagentProvider {
	bind(workflowRunId: WorkflowRunId): Promise<WorkflowSubagentBinding>;
}

function ownerId(workflowRunId: WorkflowRunId): string {
	return `pi-workflow:${workflowRunId}`;
}

export function createWorkflowSubagentProvider(
	events: EventBus,
	context: ExtensionContext,
): WorkflowSubagentProvider {
	let pinnedService: SubagentService | undefined;
	let tail = Promise.resolve();

	async function bindCurrent(
		workflowRunId: WorkflowRunId,
	): Promise<WorkflowSubagentBinding> {
		if (!Value.Check(WorkflowRunIdSchema, workflowRunId)) {
			throw new WorkflowSubagentProviderError(
				"incompatible",
				"Invalid workflow run identity for subagent owner binding.",
			);
		}
		if (!isCompatibleSubagentContract(SUBAGENT_RUNTIME_CONTRACT)) {
			throw new WorkflowSubagentProviderError(
				"incompatible",
				"The installed pi-subagent runtime contract is incompatible.",
			);
		}

		let service: SubagentService;
		try {
			service = await acquireSubagentService(events, context);
		} catch (error) {
			if (error instanceof SubagentServiceProviderError) {
				throw new WorkflowSubagentProviderError(error.code, error.message, {
					cause: error,
				});
			}
			throw new WorkflowSubagentProviderError(
				"acquisition",
				"Failed to acquire the shared pi-subagent service.",
				{ cause: error },
			);
		}
		if (!hasMethods<SubagentService>(service, SERVICE_METHODS)) {
			throw new WorkflowSubagentProviderError(
				"incompatible",
				"The pi-subagent provider returned an invalid service.",
			);
		}
		if (pinnedService && service !== pinnedService) {
			throw new WorkflowSubagentProviderError(
				"replaced",
				"The shared pi-subagent service changed during this workflow runtime.",
			);
		}
		pinnedService = service;

		const registration = Object.freeze({
			id: ownerId(workflowRunId),
			workflowRunId,
		});
		let client: SubagentClient;
		try {
			client = service.forOwner(registration);
		} catch (error) {
			throw new WorkflowSubagentProviderError(
				"acquisition",
				"Failed to bind the subagent client to the workflow run.",
				{ cause: error },
			);
		}
		if (!hasMethods<SubagentClient>(client, CLIENT_METHODS)) {
			throw new WorkflowSubagentProviderError(
				"incompatible",
				"The pi-subagent service returned an invalid owner client.",
			);
		}
		return Object.freeze({
			workflowRunId,
			ownerId: registration.id,
			client,
		});
	}

	return Object.freeze({
		bind(workflowRunId: WorkflowRunId) {
			const result = tail.then(() => bindCurrent(workflowRunId));
			tail = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
	});
}
