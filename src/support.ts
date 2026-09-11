import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Ajv } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import * as addFormatsModule from "ajv-formats";
import type { Static, TSchema } from "typebox";
import type {
	ReplayPolicy,
	TaskDisposition,
	TaskKey,
	TaskRef,
} from "./contracts.js";
import {
	type ArtifactHandle,
	validateJsonSchemaDocument,
} from "./definition.js";

const addFormats = (addFormatsModule.default ??
	addFormatsModule) as unknown as FormatsPlugin;
const SUPPORT_NAME = /^[a-zA-Z0-9@][a-zA-Z0-9@._/-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface SupportTaskDescriptor<TOutputSchema extends TSchema> {
	readonly schema: "pi-workflow-support-task-descriptor";
	readonly implementation: string;
	readonly moduleSpecifier: string;
	readonly revision: number;
	readonly implementationSha256: string;
	readonly parameters: unknown;
	readonly parametersSchema: TSchema;
	readonly outputSchema: TOutputSchema;
	readonly disposition?: TaskDisposition;
	readonly after?: readonly TaskRef[];
	readonly inputs?: Readonly<Record<TaskKey, ArtifactHandle<unknown>>>;
	readonly replay?: ReplayPolicy;
}

export interface SupportTaskHelperOptions<
	TParametersSchema extends TSchema,
	TOutputSchema extends TSchema,
> {
	readonly name: string;
	readonly moduleSpecifier: string;
	readonly revision: number;
	readonly implementationSha256: string;
	readonly parametersSchema: TParametersSchema;
	readonly outputSchema: TOutputSchema;
}

export interface SupportTaskCall<TParameters> {
	readonly parameters: TParameters;
	readonly disposition?: TaskDisposition;
	readonly after?: readonly TaskRef[];
	readonly inputs?: Readonly<Record<TaskKey, ArtifactHandle<unknown>>>;
	readonly replay?: ReplayPolicy;
}

export interface SupportTaskHelper<
	TParametersSchema extends TSchema,
	TOutputSchema extends TSchema,
> {
	(
		input: SupportTaskCall<Static<TParametersSchema>>,
	): SupportTaskDescriptor<TOutputSchema>;
	readonly implementation: string;
	readonly moduleSpecifier: string;
	readonly revision: number;
	readonly implementationSha256: string;
	readonly parametersSchema: TParametersSchema;
	readonly outputSchema: TOutputSchema;
	registration(
		execute: SupportTaskRegistration<
			TParametersSchema,
			TOutputSchema
		>["execute"],
	): SupportTaskRegistration<TParametersSchema, TOutputSchema>;
}

export interface SupportTaskExecutionContext<TParameters = unknown> {
	readonly parameters: TParameters;
	readonly inputs: Readonly<Record<string, unknown>>;
	readonly signal: AbortSignal;
}

export interface SupportTaskRegistration<
	TParametersSchema extends TSchema = TSchema,
	TOutputSchema extends TSchema = TSchema,
> extends SupportTaskHelperOptions<TParametersSchema, TOutputSchema> {
	execute(
		context: SupportTaskExecutionContext<Static<TParametersSchema>>,
	): Promise<Static<TOutputSchema>> | Static<TOutputSchema>;
}

function cloneFrozen<T>(value: T, label: string): T {
	let json: string | undefined;
	try {
		json = JSON.stringify(value);
	} catch (error) {
		throw new Error(`${label} is not JSON-serializable`, { cause: error });
	}
	if (json === undefined) throw new Error(`${label} is not JSON-serializable`);
	const cloned = JSON.parse(json) as T;
	if (!isDeepStrictEqual(value, cloned)) {
		throw new Error(`${label} is not losslessly JSON-serializable`);
	}
	const freeze = (entry: unknown): void => {
		if (typeof entry !== "object" || entry === null || Object.isFrozen(entry)) {
			return;
		}
		for (const child of Object.values(entry)) freeze(child);
		Object.freeze(entry);
	};
	freeze(cloned);
	return cloned;
}

function validateIdentity(
	options: SupportTaskHelperOptions<TSchema, TSchema>,
): void {
	if (
		!SUPPORT_NAME.test(options.name) ||
		!SUPPORT_NAME.test(options.moduleSpecifier) ||
		!Number.isSafeInteger(options.revision) ||
		options.revision < 1 ||
		!SHA256.test(options.implementationSha256)
	) {
		throw new Error("invalid support task implementation identity");
	}
}

export function defineSupportTask<
	TParametersSchema extends TSchema,
	TOutputSchema extends TSchema,
>(
	options: SupportTaskHelperOptions<TParametersSchema, TOutputSchema>,
): SupportTaskHelper<TParametersSchema, TOutputSchema> {
	validateIdentity(options);
	const parametersSchema = validateJsonSchemaDocument(
		options.parametersSchema,
		"support task parameters schema",
	) as TParametersSchema;
	const outputSchema = validateJsonSchemaDocument(
		options.outputSchema,
		"support task output schema",
	) as TOutputSchema;
	const ajv = new Ajv({ allErrors: true, strict: true, validateSchema: true });
	addFormats(ajv);
	const validate = ajv.compile(parametersSchema);
	const helper = (input: SupportTaskCall<Static<TParametersSchema>>) => {
		const parameters = cloneFrozen(input.parameters, "support task parameters");
		if (!validate(parameters)) {
			throw new Error("support task parameters do not match their schema");
		}
		return Object.freeze({
			schema: "pi-workflow-support-task-descriptor" as const,
			implementation: options.name,
			moduleSpecifier: options.moduleSpecifier,
			revision: options.revision,
			implementationSha256: options.implementationSha256,
			parameters,
			parametersSchema,
			outputSchema,
			...(input.disposition ? { disposition: input.disposition } : {}),
			...(input.after ? { after: Object.freeze([...input.after]) } : {}),
			...(input.inputs ? { inputs: Object.freeze({ ...input.inputs }) } : {}),
			...(input.replay ? { replay: input.replay } : {}),
		});
	};
	return Object.freeze(
		Object.assign(helper, {
			implementation: options.name,
			moduleSpecifier: options.moduleSpecifier,
			revision: options.revision,
			implementationSha256: options.implementationSha256,
			parametersSchema,
			outputSchema,
			registration(
				execute: SupportTaskRegistration<
					TParametersSchema,
					TOutputSchema
				>["execute"],
			) {
				return Object.freeze({
					name: options.name,
					moduleSpecifier: options.moduleSpecifier,
					revision: options.revision,
					implementationSha256: options.implementationSha256,
					parametersSchema,
					outputSchema,
					execute,
				});
			},
		}),
	);
}

export function supportRegistrationIdentity(
	registration: SupportTaskRegistration,
): string {
	validateIdentity({ ...registration });
	const parametersSchema = validateJsonSchemaDocument(
		registration.parametersSchema,
		"support registration parameters schema",
	);
	const outputSchema = validateJsonSchemaDocument(
		registration.outputSchema,
		"support registration output schema",
	);
	return createHash("sha256")
		.update(
			JSON.stringify({
				implementation: registration.name,
				moduleSpecifier: registration.moduleSpecifier,
				revision: registration.revision,
				implementationSha256: registration.implementationSha256,
				parametersSchema,
				outputSchema,
			}),
		)
		.digest("hex");
}
