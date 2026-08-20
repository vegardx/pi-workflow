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

const MAX_DEFINITION_BYTES = 1024 * 1024;
const MAX_DEFINITIONS = 256;
const MAX_DISCOVERY_ENTRIES = 4096;
const MAX_DISCOVERY_DEPTH = 8;
const MAX_REGISTERED_ROOTS = 32;
const DEFINITION_FILE = /\.workflow\.(?:ts|mts|js|mjs)$/;
const ALLOWED_STATIC_IMPORTS = new Set(["@vegardx/pi-workflow", "typebox"]);

export type WorkflowRootScope = "project" | "global" | "package" | "builtin";

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

function assertSupportedImports(source: string, filePath: string): void {
	let ast: unknown;
	try {
		ast = parse(source, {
			sourceType: "module",
			plugins: ["typescript", "importAttributes", "topLevelAwait"],
		});
	} catch (error) {
		throw new WorkflowDefinitionLoadError(
			"workflow definition syntax is invalid",
			filePath,
			{ cause: error },
		);
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
				!ALLOWED_STATIC_IMPORTS.has(sourceNode.value)
			) {
				throw new WorkflowDefinitionLoadError(
					`workflow import ${sourceNode.value} is not identity-bound by contract revision 1`,
					filePath,
				);
			}
		}
		if (type === "ImportExpression") {
			throw new WorkflowDefinitionLoadError(
				"dynamic workflow imports are not supported by contract revision 1",
				filePath,
			);
		}
		if (type === "CallExpression") {
			const callee = node.callee as
				| { type?: unknown; name?: unknown }
				| undefined;
			if (callee?.type === "Import" || callee?.name === "require") {
				throw new WorkflowDefinitionLoadError(
					"dynamic imports and CommonJS require are not supported by contract revision 1",
					filePath,
				);
			}
		}
		if (type === "TSImportEqualsDeclaration") {
			throw new WorkflowDefinitionLoadError(
				"TypeScript import assignment is not supported by contract revision 1",
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
}): Promise<readonly DiscoveredWorkflow[]> {
	const cwd = await realpath(options.cwd);
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
	const roots: WorkflowRoot[] = [
		{ path: path.join(cwd, "workflows"), scope: "project", source: "project" },
		{
			path: path.join(cwd, ".pi", "workflows"),
			scope: "project",
			source: "project-config",
		},
		{
			path: path.join(options.agentDir ?? getAgentDir(), "workflows"),
			scope: "global",
			source: "agent-directory",
		},
		...registeredRoots,
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
	const names = new Map<string, string>();
	for (const { root, canonical, files } of discoveredRoots) {
		for (const filePath of files) {
			const resolved = await realpath(filePath);
			if (!resolved.startsWith(`${canonical}${path.sep}`)) {
				throw new WorkflowDefinitionLoadError(
					"workflow definition escapes its root",
					filePath,
				);
			}
			const source = await readDefinitionSource(resolved);
			assertSupportedImports(source, resolved);
			let loaded: unknown;
			try {
				const module = await jiti.evalModule(source, {
					filename: resolved,
					async: true,
					forceTranspile: true,
				});
				loaded = (module as { default?: unknown }).default ?? module;
			} catch (error) {
				throw new WorkflowDefinitionLoadError(
					"workflow definition module failed to load",
					resolved,
					{ cause: error },
				);
			}
			if (!isWorkflowDefinition(loaded)) {
				throw new WorkflowDefinitionLoadError(
					"workflow module has no valid default definition",
					resolved,
				);
			}
			const definition = defineWorkflow({
				meta: loaded.meta,
				inputSchema: loaded.inputSchema,
				outputSchema: loaded.outputSchema,
				run: loaded.run,
			});
			const existing = names.get(definition.meta.name);
			if (existing) {
				throw new WorkflowDefinitionLoadError(
					`duplicate workflow name ${definition.meta.name}: ${existing} and ${resolved}`,
					resolved,
				);
			}
			names.set(definition.meta.name, resolved);
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
	return Object.freeze(workflows);
}
