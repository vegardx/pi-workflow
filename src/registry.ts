import { createHash } from "node:crypto";
import { lstat, opendir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "@babel/parser";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { WORKFLOW_CONTRACT_REVISION } from "./contracts.js";
import {
	defineWorkflow,
	isWorkflowDefinition,
	type WorkflowDefinition,
} from "./definition.js";
import { sanitizedDefinitionProblem } from "./sanitized-cause.js";

const MAX_DEFINITION_BYTES = 1024 * 1024;
const MAX_DEFINITIONS = 256;
const MAX_DISCOVERY_ENTRIES = 4096;
const MAX_DISCOVERY_DEPTH = 8;
const MAX_REGISTERED_ROOTS = 32;
const DEFINITION_FILE = /\.workflow\.(?:ts|mts|js|mjs)$/;
/**
 * Specifiers a definition may import. The package root and the component
 * library are trusted package code (the same trade the root import already
 * makes: a definition's source identity covers its own bytes, not the
 * package's); the runtime subpath stays excluded because its exports are
 * unfrozen engine internals.
 */
const ALLOWED_STATIC_IMPORTS = new Set([
	"@vegardx/pi-workflow",
	"@vegardx/pi-workflow/components",
	"typebox",
]);

/**
 * `"dynamic"` names a proposal-backed definition (dynamic-workflow spec 5.4);
 * it is never a registered root and `discoverWorkflows` never yields it.
 */
export type WorkflowRootScope =
	| "project"
	| "global"
	| "package"
	| "builtin"
	| "dynamic";

export interface WorkflowRoot {
	readonly path: string;
	readonly scope: WorkflowRootScope;
	readonly source: string;
}

export interface WorkflowDefinitionIdentity {
	readonly sourceSha256: string;
	readonly identitySha256: string;
}

export interface DiscoveredWorkflow {
	readonly definition: WorkflowDefinition;
	readonly identity: WorkflowDefinitionIdentity;
	readonly path: string;
	readonly root: string;
	readonly scope: WorkflowRootScope;
	readonly source: string;
}

/**
 * One definition file that discovery could not turn into a definition.
 *
 * Discovery is per file: a file that does not load, does not parse, defines no
 * definition, escapes its root, or repeats a name already taken becomes one of
 * these instead of an exception for every other file. `problem` is one
 * sanitized sentence (see {@link sanitizedDefinitionProblem}) and `path` is the
 * file's path relative to its root — the only path a view of a problem shows.
 * `definitionPath` is the resolved absolute path, which the service uses to
 * answer a ref naming the broken file and never puts in a view.
 */
export interface DiscoveredWorkflowProblem {
	readonly path: string;
	readonly definitionPath: string;
	readonly root: string;
	readonly scope: WorkflowRootScope;
	readonly source: string;
	readonly problem: string;
}

/** What one discovery found: the definitions that loaded, and the files that did not. */
export interface WorkflowDiscovery {
	readonly workflows: readonly DiscoveredWorkflow[];
	readonly problems: readonly DiscoveredWorkflowProblem[];
}

export class WorkflowDefinitionLoadError extends Error {
	constructor(
		message: string,
		readonly definitionPath?: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "WorkflowDefinitionLoadError";
	}
}

export class WorkflowDefinitionTrustError extends Error {
	constructor(readonly definitionPaths: readonly string[]) {
		super("project workflow definitions require project trust");
		this.name = "WorkflowDefinitionTrustError";
	}
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

async function exists(directory: string): Promise<boolean> {
	try {
		return (await stat(directory)).isDirectory();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function definitionFiles(
	root: string,
	budget: { entries: number; definitions: number },
): Promise<string[]> {
	const files: string[] = [];
	const visit = async (directory: string, depth: number): Promise<void> => {
		if (depth > MAX_DISCOVERY_DEPTH) {
			throw new WorkflowDefinitionLoadError(
				`workflow discovery exceeds depth ${MAX_DISCOVERY_DEPTH}`,
				directory,
			);
		}
		const entries = [];
		for await (const entry of await opendir(directory)) {
			budget.entries += 1;
			if (budget.entries > MAX_DISCOVERY_ENTRIES) {
				throw new WorkflowDefinitionLoadError(
					`workflow discovery exceeds ${MAX_DISCOVERY_ENTRIES} entries`,
					root,
				);
			}
			entries.push(entry);
		}
		for (const entry of entries.sort((left, right) =>
			left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
		)) {
			if (entry.isSymbolicLink()) {
				throw new WorkflowDefinitionLoadError(
					"workflow definition roots may not contain symlinks",
					path.join(directory, entry.name),
				);
			}
			const candidate = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(candidate, depth + 1);
			} else if (entry.isFile() && DEFINITION_FILE.test(entry.name)) {
				files.push(candidate);
				budget.definitions += 1;
				if (budget.definitions > MAX_DEFINITIONS) {
					throw new WorkflowDefinitionLoadError(
						`workflow discovery exceeds ${MAX_DEFINITIONS} definitions`,
						root,
					);
				}
			}
		}
	};
	await visit(root, 0);
	return files;
}

async function readDefinitionSource(filePath: string): Promise<string> {
	const metadata = await lstat(filePath);
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new WorkflowDefinitionLoadError(
			"workflow definition must be a regular file",
			filePath,
		);
	}
	if (metadata.size > MAX_DEFINITION_BYTES) {
		throw new WorkflowDefinitionLoadError(
			"workflow definition exceeds size limit",
			filePath,
		);
	}
	const content = await readFile(filePath);
	if (content.byteLength > MAX_DEFINITION_BYTES) {
		throw new WorkflowDefinitionLoadError(
			"workflow definition exceeds size limit",
			filePath,
		);
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch (error) {
		throw new WorkflowDefinitionLoadError(
			"workflow definition is not valid UTF-8",
			filePath,
			{ cause: error },
		);
	}
}

/** The one `assertSupportedImports` refusal that is a parse failure, not a policy one. */
const DEFINITION_SYNTAX_INVALID = "workflow definition syntax is invalid";

export function assertSupportedImports(
	source: string,
	filePath: string,
	allowedSupportImports: ReadonlySet<string>,
): void {
	let ast: unknown;
	try {
		ast = parse(source, {
			sourceType: "module",
			plugins: ["typescript", "importAttributes", "topLevelAwait"],
		});
	} catch (error) {
		throw new WorkflowDefinitionLoadError(DEFINITION_SYNTAX_INVALID, filePath, {
			cause: error,
		});
	}
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const child of value) visit(child);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		const node = value as Record<string, unknown>;
		const type = node.type;
		if (
			type === "ImportDeclaration" ||
			type === "ExportNamedDeclaration" ||
			type === "ExportAllDeclaration"
		) {
			const sourceNode = node.source as { value?: unknown } | undefined;
			if (
				typeof sourceNode?.value === "string" &&
				!ALLOWED_STATIC_IMPORTS.has(sourceNode.value) &&
				!allowedSupportImports.has(sourceNode.value)
			) {
				throw new WorkflowDefinitionLoadError(
					`workflow import ${sourceNode.value} is not identity-bound by contract revision ${WORKFLOW_CONTRACT_REVISION}`,
					filePath,
				);
			}
		}
		if (type === "ImportExpression") {
			throw new WorkflowDefinitionLoadError(
				`dynamic workflow imports are not supported by contract revision ${WORKFLOW_CONTRACT_REVISION}`,
				filePath,
			);
		}
		if (type === "CallExpression") {
			const callee = node.callee as
				| { type?: unknown; name?: unknown }
				| undefined;
			if (callee?.type === "Import" || callee?.name === "require") {
				throw new WorkflowDefinitionLoadError(
					`dynamic imports and CommonJS require are not supported by contract revision ${WORKFLOW_CONTRACT_REVISION}`,
					filePath,
				);
			}
		}
		if (type === "TSImportEqualsDeclaration") {
			throw new WorkflowDefinitionLoadError(
				`TypeScript import assignment is not supported by contract revision ${WORKFLOW_CONTRACT_REVISION}`,
				filePath,
			);
		}
		for (const [key, child] of Object.entries(node)) {
			if (key === "loc" || key === "start" || key === "end") continue;
			visit(child);
		}
	};
	visit(ast);
}

function definitionIdentity(
	definition: WorkflowDefinition,
	filePath: string,
	source: string,
): WorkflowDefinitionIdentity {
	const sourceSha256 = sha256(source);
	return {
		sourceSha256,
		identitySha256: sha256(
			JSON.stringify({
				contractRevision: WORKFLOW_CONTRACT_REVISION,
				path: filePath,
				sourceSha256,
				meta: definition.meta,
				inputSchema: definition.inputSchema,
				outputSchema: definition.outputSchema,
			}),
		),
	};
}

export async function discoverWorkflows(options: {
	cwd: string;
	agentDir?: string;
	projectTrusted: boolean;
	registeredRoots?: readonly WorkflowRoot[];
	allowedSupportImports?: readonly string[];
}): Promise<WorkflowDiscovery> {
	const cwd = await realpath(options.cwd);
	const allowedSupportImports = new Set(options.allowedSupportImports ?? []);
	if (allowedSupportImports.size > 64) {
		throw new WorkflowDefinitionLoadError(
			"workflow support import registry exceeds 64 modules",
		);
	}
	const registeredRoots = [...(options.registeredRoots ?? [])];
	if (registeredRoots.length > MAX_REGISTERED_ROOTS) {
		throw new WorkflowDefinitionLoadError(
			`workflow registry exceeds ${MAX_REGISTERED_ROOTS} registered roots`,
		);
	}
	for (const root of registeredRoots) {
		if (root.scope !== "package" && root.scope !== "builtin") {
			throw new WorkflowDefinitionLoadError(
				"registered workflow roots must use package or builtin scope",
				root.path,
			);
		}
	}
	registeredRoots.sort((left, right) => {
		const leftRank = left.scope === "package" ? 0 : 1;
		const rightRank = right.scope === "package" ? 0 : 1;
		if (leftRank !== rightRank) return leftRank - rightRank;
		return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
	});
	// Most trusted first, because the first file to claim a name keeps it and
	// every later claim is that file's problem: a root trusted by its install
	// (a registered `package` or `builtin` root, then the agent directory) is
	// visited before a project's own, so a project can never take a name a
	// builtin defines.
	const roots: WorkflowRoot[] = [
		...registeredRoots,
		{
			path: path.join(options.agentDir ?? getAgentDir(), "workflows"),
			scope: "global",
			source: "agent-directory",
		},
		{ path: path.join(cwd, "workflows"), scope: "project", source: "project" },
		{
			path: path.join(cwd, ".pi", "workflows"),
			scope: "project",
			source: "project-config",
		},
	];
	const discoveredRoots: Array<{
		root: WorkflowRoot;
		canonical: string;
		files: string[];
	}> = [];
	const seenRoots = new Map<string, WorkflowRoot>();
	const budget = { entries: 0, definitions: 0 };
	for (const root of roots) {
		if (!(await exists(root.path))) continue;
		const canonical = await realpath(root.path);
		if (root.scope === "project" && !options.projectTrusted) {
			throw new WorkflowDefinitionTrustError([canonical]);
		}
		const existingRoot = seenRoots.get(canonical);
		if (existingRoot) {
			throw new WorkflowDefinitionLoadError(
				`duplicate workflow root ${canonical}: ${existingRoot.source} and ${root.source}`,
				canonical,
			);
		}
		seenRoots.set(canonical, root);
		const files = await definitionFiles(canonical, budget);
		discoveredRoots.push({ root, canonical, files });
	}

	const jiti = createJiti(import.meta.url, {
		fsCache: false,
		moduleCache: false,
		interopDefault: true,
	});
	const workflows: DiscoveredWorkflow[] = [];
	const problems: DiscoveredWorkflowProblem[] = [];
	const names = new Map<string, string>();
	for (const { root, canonical, files } of discoveredRoots) {
		for (const filePath of files) {
			// The file's own path relative to the root it was found under: the only
			// path a problem carries, and stable across hosts. `filePath` comes from
			// walking `canonical`, so this never climbs out of the root even when
			// the resolved target does.
			const relative = path
				.relative(canonical, filePath)
				.split(path.sep)
				.join("/");
			const resolved = await realpath(filePath);
			const record = (problem: string): void => {
				problems.push(
					Object.freeze({
						path: relative,
						definitionPath: resolved,
						root: canonical,
						scope: root.scope,
						source: root.source,
						problem,
					}),
				);
			};
			if (!resolved.startsWith(`${canonical}${path.sep}`)) {
				record("escapes its root");
				continue;
			}
			const source = await readDefinitionSource(resolved);
			try {
				assertSupportedImports(source, resolved, allowedSupportImports);
			} catch (error) {
				// A file that does not parse is this file's problem. An import the
				// contract does not admit is still the contract's refusal: the gate
				// decides what a definition may be, not whether this one loaded.
				if (
					error instanceof WorkflowDefinitionLoadError &&
					error.message === DEFINITION_SYNTAX_INVALID
				) {
					record(sanitizedDefinitionProblem(error, relative));
					continue;
				}
				throw error;
			}
			let loaded: unknown;
			try {
				const module = await jiti.evalModule(source, {
					filename: resolved,
					async: true,
					forceTranspile: true,
				});
				loaded = (module as { default?: unknown }).default ?? module;
			} catch (error) {
				record(sanitizedDefinitionProblem(error, relative));
				continue;
			}
			if (!isWorkflowDefinition(loaded)) {
				record("has no valid default definition");
				continue;
			}
			const definition = defineWorkflow({
				meta: loaded.meta,
				inputSchema: loaded.inputSchema,
				outputSchema: loaded.outputSchema,
				run: loaded.run,
			});
			const existing = names.get(definition.meta.name);
			if (existing) {
				// The first file to claim a name keeps it, and roots are visited
				// most-trusted first, so this is always the less trusted or later
				// file — never the builtin.
				record(
					`duplicate workflow name ${definition.meta.name}, also defined by ${existing}`,
				);
				continue;
			}
			names.set(definition.meta.name, relative);
			const identity = Object.freeze(
				definitionIdentity(definition, resolved, source),
			);
			workflows.push(
				Object.freeze({
					definition,
					identity,
					path: resolved,
					root: canonical,
					scope: root.scope,
					source: root.source,
				}),
			);
		}
	}
	return Object.freeze({
		workflows: Object.freeze(workflows),
		problems: Object.freeze(problems),
	});
}
