import { parse } from "@babel/parser";
import amaro from "amaro";
import { DYNAMIC_BUILTIN_MODULES, DYNAMIC_TRANSFORMER } from "./constants.js";

export class DynamicTransformError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DynamicTransformError";
	}
}

export interface DynamicTransformInput {
	/** TypeScript source exactly as proposed. */
	readonly source: string;
	/** `dynamic:<sourceSha256>.workflow.ts`; appears in stack traces only. */
	readonly filename: string;
	/**
	 * Module specifiers of the registered support helpers; together with
	 * `DYNAMIC_BUILTIN_MODULES` these are the keys of the injected `__modules`.
	 */
	readonly supportModuleSpecifiers?: readonly string[];
}

export interface DynamicTransformOutput {
	/**
	 * `(async function (__modules, __exports, __import, __importNamespace) {
	 * "use strict"; ... })` — evaluate, then call with the module table.
	 */
	readonly code: string;
}

type Statement = ReturnType<typeof parse>["program"]["body"][number];
type Edit = {
	readonly start: number;
	readonly end: number;
	readonly text: string;
};

const EXPORT_SHAPE =
	"dynamic workflow source must have exactly one default export and no named exports";

function range(node: { start?: number | null; end?: number | null }): {
	start: number;
	end: number;
} {
	if (typeof node.start !== "number" || typeof node.end !== "number") {
		throw new DynamicTransformError(
			"transformed dynamic workflow source does not parse",
		);
	}
	return { start: node.start, end: node.end };
}

function errorMessage(error: unknown): string {
	if (typeof error === "object" && error !== null && "message" in error) {
		return String((error as { message: unknown }).message);
	}
	return String(error);
}

function importedName(
	imported: { type: string; name?: string; value?: string },
	fallback: string,
): string {
	if (imported.type === "Identifier" && typeof imported.name === "string") {
		return imported.name;
	}
	if (imported.type === "StringLiteral" && typeof imported.value === "string") {
		return imported.value;
	}
	return fallback;
}

function rewriteImport(
	node: Extract<Statement, { type: "ImportDeclaration" }>,
	available: ReadonlySet<string>,
): Edit {
	const { start, end } = range(node);
	const specifier = node.source.value;
	if (!available.has(specifier)) {
		throw new DynamicTransformError(
			`dynamic workflow import ${specifier} is not available`,
		);
	}
	const module = JSON.stringify(specifier);
	const declarators: string[] = [];
	for (const entry of node.specifiers) {
		switch (entry.type) {
			case "ImportDefaultSpecifier":
				declarators.push(
					`${entry.local.name} = __import(${module}, "default")`,
				);
				break;
			case "ImportNamespaceSpecifier":
				declarators.push(`${entry.local.name} = __importNamespace(${module})`);
				break;
			case "ImportSpecifier":
				declarators.push(
					`${entry.local.name} = __import(${module}, ${JSON.stringify(
						importedName(entry.imported, entry.local.name),
					)})`,
				);
				break;
		}
	}
	return {
		start,
		end,
		text: declarators.length === 0 ? ";" : `const ${declarators.join(", ")};`,
	};
}

function rewriteDefaultExport(
	node: Extract<Statement, { type: "ExportDefaultDeclaration" }>,
	js: string,
): Edit {
	const { start, end } = range(node);
	const declaration = range(node.declaration);
	const text = js.slice(declaration.start, declaration.end);
	const isDeclaration =
		node.declaration.type === "FunctionDeclaration" ||
		node.declaration.type === "ClassDeclaration";
	return {
		start,
		end,
		text: isDeclaration
			? `__exports.default = ${text};`
			: `__exports.default = (${text});`,
	};
}

/**
 * Full TypeScript through amaro (swc-wasm) in transform mode with exactly the
 * options Node passes, then a range-exact rewrite of the surviving value
 * imports into `__import`/`__importNamespace` calls and of the default export
 * into `__exports.default`. Pure: the same bytes always yield the same code,
 * so nothing is persisted.
 */
export function transformDynamicSource(
	input: DynamicTransformInput,
): DynamicTransformOutput {
	let js: string;
	try {
		js = amaro.transformSync(input.source, {
			mode: DYNAMIC_TRANSFORMER.mode,
			sourceMap: DYNAMIC_TRANSFORMER.options.sourceMap,
			filename: input.filename,
			deprecatedTsModuleAsError:
				DYNAMIC_TRANSFORMER.options.deprecatedTsModuleAsError,
			transform: { ...DYNAMIC_TRANSFORMER.options.transform },
		}).code;
	} catch (error) {
		throw new DynamicTransformError(errorMessage(error), { cause: error });
	}
	let ast: ReturnType<typeof parse>;
	try {
		ast = parse(js, {
			sourceType: "module",
			plugins: ["importAttributes", "topLevelAwait"],
		});
	} catch (error) {
		throw new DynamicTransformError(
			"transformed dynamic workflow source does not parse",
			{ cause: error },
		);
	}
	const available = new Set<string>([
		...DYNAMIC_BUILTIN_MODULES,
		...(input.supportModuleSpecifiers ?? []),
	]);
	const edits: Edit[] = [];
	let defaultExports = 0;
	for (const node of ast.program.body) {
		switch (node.type) {
			case "ImportDeclaration":
				edits.push(rewriteImport(node, available));
				break;
			case "ExportDefaultDeclaration":
				defaultExports += 1;
				edits.push(rewriteDefaultExport(node, js));
				break;
			case "ExportNamedDeclaration":
			case "ExportAllDeclaration":
				throw new DynamicTransformError(EXPORT_SHAPE);
			default:
				break;
		}
	}
	if (defaultExports !== 1) throw new DynamicTransformError(EXPORT_SHAPE);
	let rewritten = js;
	for (const edit of edits.sort((a, b) => b.start - a.start)) {
		rewritten = `${rewritten.slice(0, edit.start)}${edit.text}${rewritten.slice(edit.end)}`;
	}
	return {
		code: `(async function (__modules, __exports, __import, __importNamespace) { "use strict";\n${rewritten}\n})`,
	};
}

/**
 * The `__import`/`__importNamespace` pair the wrapper receives, over a table
 * of frozen module objects keyed by specifier.
 */
export function createDynamicImporters(
	modules: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): {
	__import(specifier: string, name: string): unknown;
	__importNamespace(specifier: string): Readonly<Record<string, unknown>>;
} {
	const __importNamespace = (
		specifier: string,
	): Readonly<Record<string, unknown>> => {
		if (!Object.hasOwn(modules, specifier)) {
			throw new Error(
				`Dynamic workflow import ${JSON.stringify(specifier)} is not available.`,
			);
		}
		return modules[specifier] as Readonly<Record<string, unknown>>;
	};
	const __import = (specifier: string, name: string): unknown => {
		const module = __importNamespace(specifier);
		if (!Object.hasOwn(module, name)) {
			throw new Error(
				`Dynamic workflow import ${JSON.stringify(specifier)} has no export ${JSON.stringify(name)}.`,
			);
		}
		return module[name];
	};
	return { __import, __importNamespace };
}
