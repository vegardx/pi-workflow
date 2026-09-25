import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as root from "../src/index.js";
import * as runtime from "../src/runtime/index.js";
import { WORKFLOW_COMMAND, WORKFLOW_SUBCOMMANDS } from "../src/ui/commands.js";
import {
	WORKFLOW_WIDGET_KEY,
	WORKFLOW_WIDGET_SHORTCUT,
} from "../src/ui/widget.js";

// Pins for the 1.0 API freeze (docs/contracts.md "Public API and stability").
// Every list below is a literal: a failing diff is either a mistake to revert
// or a deliberate change that updates the pin in the same commit, with the
// version bump the stability rule requires.

const ROOT_FIXTURE = "./fixtures/public-api/root-exports.json";
const RUNTIME_FIXTURE = "./fixtures/public-api/runtime-exports.json";

const WORKFLOW_SERVICE_METHODS = [
	"decide",
	"decideSource",
	"exportHandoff",
	"hostDelegationCeiling",
	"inspect",
	"inspectProposal",
	"invalidate",
	"list",
	"listRuns",
	"logs",
	"previewInvalidation",
	"project",
	"proposals",
	"propose",
	"prune",
	"reconcile",
	"registerRoot",
	"resume",
	"retry",
	"run",
	"shutdown",
	"status",
	"stop",
	"subscribe",
	"validate",
	"wait",
] as const;

const WORKFLOW_TOOL_NAMES = [
	"workflow_list",
	"workflow_validate",
	"workflow_run",
	"workflow_status",
	"workflow_wait",
	"workflow_stop",
	"workflow_reconcile",
	"workflow_runs",
	"workflow_inspect",
	"workflow_logs",
	"workflow_invalidate",
	"workflow_retry",
	"workflow_resume",
	"workflow_propose",
] as const;

const WORKFLOW_SUBCOMMAND_GRAMMAR = [
	"list",
	"runs",
	"prune",
	"validate",
	"run",
	"approve",
	"reject",
	"show",
	"status",
	"logs",
	"wait",
	"stop",
	"reconcile",
	"invalidate",
	"retry",
	"resume",
	"decide",
] as const;

const WORKFLOW_CONTEXT_PROPERTIES = [
	"cwd",
	"input",
	"runId",
	"signal",
] as const;

const WORKFLOW_CONTEXT_METHODS = [
	"agent",
	"checkpoint",
	"fanIn",
	"fanOut",
	"finalize",
	"handoff",
	"log",
	"phase",
	"pipeline",
	"result",
	"results",
	"settled",
	"support",
	"workflow",
] as const;

const PACKAGE_EXPORTS = {
	".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
	"./extension": {
		types: "./dist/extension.d.ts",
		import: "./dist/extension.js",
	},
	"./runtime": {
		types: "./dist/runtime/index.d.ts",
		import: "./dist/runtime/index.js",
	},
	// W0-COMP-A: the component library. A third built entry, additive under
	// the freeze: it declares no contract and re-exports nothing from the two
	// pinned entries, so neither fixture above moves.
	"./components": {
		types: "./dist/components/index.d.ts",
		import: "./dist/components/index.js",
	},
	// W1-PROVIDER: the service-provider seam. A fifth built entry, additive
	// under the freeze: it re-exports only view types, so neither fixture
	// above moves.
	"./service-provider": {
		types: "./dist/service-provider.d.ts",
		import: "./dist/service-provider.js",
	},
	"./package.json": "./package.json",
} as const;

interface PackageJson {
	version: string;
	main: string;
	types: string;
	exports: Record<string, unknown>;
	pi: { extensions: string[] };
}

interface Compatibility {
	piWorkflow: {
		version: string;
		api: {
			version: string;
			frozenSurfaces: string[];
			entryPoints: Record<string, string>;
			exportList: string;
		};
	};
}

function here(relative: string): URL {
	return new URL(relative, import.meta.url);
}

async function readJson<T>(relative: string): Promise<T> {
	return JSON.parse(await readFile(here(relative), "utf8")) as T;
}

async function readFixture(relative: string): Promise<string[]> {
	return readJson<string[]>(relative);
}

function exportNames(module: object): string[] {
	return Object.keys(module).sort();
}

/** Symmetric difference, so a failing pin names what moved. */
function diff(
	actual: readonly string[],
	pinned: readonly string[],
): { added: string[]; removed: string[] } {
	const pinnedSet = new Set(pinned);
	const actualSet = new Set(actual);
	return {
		added: actual.filter((name) => !pinnedSet.has(name)),
		removed: pinned.filter((name) => !actualSet.has(name)),
	};
}

function majorOf(version: string): number {
	const major = /^(\d+)\./.exec(version)?.[1];
	if (major === undefined) throw new Error(`not a semver string: ${version}`);
	return Number(major);
}

/** Function-valued members of the object and its prototypes below Object. */
function methodNames(value: object): string[] {
	const names = new Set<string>();
	for (
		let current: object | null = value;
		current !== null && current !== Object.prototype;
		current = Object.getPrototypeOf(current)
	) {
		for (const name of Object.getOwnPropertyNames(current)) {
			if (name === "constructor") continue;
			const descriptor = Object.getOwnPropertyDescriptor(current, name);
			if (typeof descriptor?.value === "function") names.add(name);
		}
	}
	return [...names].sort();
}

async function* sourceFiles(directory: string): AsyncGenerator<string> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) yield* sourceFiles(entryPath);
		else if (entry.isFile() && entry.name.endsWith(".ts")) yield entryPath;
	}
}

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const SRC_DIR = path.resolve(
	path.dirname(new URL(import.meta.url).pathname),
	"../src",
);
const ROOT_INDEX = path.join(SRC_DIR, "index.ts");
const RUNTIME_INDEX = path.join(SRC_DIR, "runtime", "index.ts");

describe("public API export lists", () => {
	it("pins the root entry to root-exports.json", async () => {
		const pinned = await readFixture(ROOT_FIXTURE);
		const actual = exportNames(root);
		expect(diff(actual, pinned)).toEqual({ added: [], removed: [] });
		expect(actual).toEqual(pinned);
		expect(pinned).toHaveLength(197);
	});

	it("pins the runtime entry to runtime-exports.json", async () => {
		const pinned = await readFixture(RUNTIME_FIXTURE);
		const actual = exportNames(runtime);
		expect(diff(actual, pinned)).toEqual({ added: [], removed: [] });
		expect(actual).toEqual(pinned);
		expect(pinned).toHaveLength(138);
	});

	it("exports every name from exactly one entry point", async () => {
		const rootNames = new Set(await readFixture(ROOT_FIXTURE));
		const runtimeNames = await readFixture(RUNTIME_FIXTURE);
		expect(runtimeNames.filter((name) => rootNames.has(name))).toEqual([]);
		expect(
			Object.keys(runtime).filter((name) => Object.hasOwn(root, name)),
		).toEqual([]);
	});

	it("keeps both fixtures sorted and unique", async () => {
		for (const fixture of [ROOT_FIXTURE, RUNTIME_FIXTURE]) {
			const names = await readFixture(fixture);
			expect(names).toEqual([...new Set(names)].sort());
			for (const name of names) expect(typeof name).toBe("string");
		}
	});

	it("keeps the dynamic shim a subset of the root", async () => {
		const rootNames = new Set(await readFixture(ROOT_FIXTURE));
		expect(
			runtime.DYNAMIC_SHIM_EXPORTS.filter((name) => !rootNames.has(name)),
		).toEqual([]);
		expect([...runtime.DYNAMIC_SHIM_EXPORTS]).toEqual([
			"DEFAULT_WORKFLOW_CONCURRENCY",
			"MAX_WORKFLOW_CONCURRENCY",
			"WORKFLOW_CONTRACT_REVISION",
			"defineSupportTask",
			"defineWorkflow",
			"isArtifactHandle",
			"isTaskHandle",
			"isWorkflowDefinition",
		]);
	});
});

describe("frozen service surface", () => {
	it("exposes exactly the pinned WorkflowService methods", async () => {
		const base = await mkdtemp(path.join(os.tmpdir(), "pi-workflow-api-"));
		const cwd = path.join(base, "project");
		await mkdir(path.join(cwd, "workflows"), { recursive: true });
		const subagents: root.WorkflowSubagentProvider = {
			bind: async () => {
				throw new Error("no subagent binding in the API pin");
			},
		};
		const service = await root.createWorkflowService({
			cwd,
			agentDir: path.join(base, "agent"),
			storeRoot: path.join(cwd, "state"),
			projectTrusted: () => true,
			subagents,
		});
		try {
			expect(methodNames(service)).toEqual([...WORKFLOW_SERVICE_METHODS]);
			expect(WORKFLOW_SERVICE_METHODS).toHaveLength(26);
		} finally {
			await service.shutdown();
			await rm(base, { recursive: true, force: true });
		}
	});

	it("pins the WorkflowContext members the dynamic host mirrors", () => {
		expect([...runtime.DYNAMIC_CONTEXT_PROPERTIES]).toEqual([
			...WORKFLOW_CONTEXT_PROPERTIES,
		]);
		expect([...runtime.DYNAMIC_CONTEXT_METHODS]).toEqual([
			...WORKFLOW_CONTEXT_METHODS,
		]);
		expect(WORKFLOW_CONTEXT_PROPERTIES).toHaveLength(4);
		expect(WORKFLOW_CONTEXT_METHODS).toHaveLength(14);
	});

	it("pins the WorkflowServiceError codes and run actions", () => {
		expect([...root.WORKFLOW_RUN_ACTIONS]).toEqual([
			"stop",
			"wait",
			"reconcile",
			"invalidate",
			"retry",
			"resume",
			"decide",
		]);
		expect([...root.IMPLEMENTED_WORKFLOW_RUN_ACTIONS].sort()).toEqual(
			[...root.WORKFLOW_RUN_ACTIONS].sort(),
		);
		const error = new root.WorkflowServiceError("validation", "pinned");
		expect(error.name).toBe("WorkflowServiceError");
		expect(error.code).toBe("validation");
	});
});

describe("frozen extension surface", () => {
	it("pins the fourteen tool declarations in table order", () => {
		expect(Object.isFrozen(root.WORKFLOW_TOOL_DECLARATIONS)).toBe(true);
		expect(root.WORKFLOW_TOOL_DECLARATIONS.map((tool) => tool.name)).toEqual([
			...WORKFLOW_TOOL_NAMES,
		]);
		expect(WORKFLOW_TOOL_NAMES).toHaveLength(14);
		for (const tool of root.WORKFLOW_TOOL_DECLARATIONS) {
			expect(typeof tool.label).toBe("string");
			expect(typeof tool.description).toBe("string");
			expect(Array.isArray(tool.promptGuidelines)).toBe(true);
			expect((tool.parameters as { type?: unknown }).type).toBe("object");
			expect(typeof (tool.output as { type?: unknown }).type).toBe("string");
			expect(typeof tool.execute).toBe("function");
			expect(typeof tool.summarizeCall).toBe("function");
			expect(typeof tool.summarizeResult).toBe("function");
		}
	});

	it("pins the /workflow grammar, widget key, and shortcut", () => {
		expect(WORKFLOW_COMMAND).toBe("workflow");
		expect([...WORKFLOW_SUBCOMMANDS]).toEqual([...WORKFLOW_SUBCOMMAND_GRAMMAR]);
		expect(WORKFLOW_SUBCOMMAND_GRAMMAR).toHaveLength(17);
		expect(WORKFLOW_WIDGET_KEY).toBe("pi-workflow");
		expect(WORKFLOW_WIDGET_SHORTCUT).toBe("alt+w");
	});
});

describe("entry point hygiene", () => {
	it("keeps every src module off the index modules", async () => {
		const offenders: string[] = [];
		const indexImport =
			/(?:from\s*|import\s*\(\s*)"((?:\.\.?\/)[^"]*\/index\.js|\.\/index\.js)"/g;
		for await (const file of sourceFiles(SRC_DIR)) {
			if (file === ROOT_INDEX || file === RUNTIME_INDEX) continue;
			const source = await readFile(file, "utf8");
			for (const match of source.matchAll(indexImport)) {
				offenders.push(`${path.relative(SRC_DIR, file)} -> ${match[1]}`);
			}
		}
		expect(offenders).toEqual([]);
		// The two entries never import each other either.
		for (const index of [ROOT_INDEX, RUNTIME_INDEX]) {
			expect((await readFile(index, "utf8")).match(indexImport)).toBeNull();
		}
	});

	it("keeps src/runtime/index.ts to re-export blocks", async () => {
		const source = stripComments(await readFile(RUNTIME_INDEX, "utf8"));
		const reexportBlocks =
			/^(?:\s*export\s*\{[^{}]*\}\s*from\s*"\.\.\/[A-Za-z0-9_./-]+\.js";)+\s*$/;
		expect(reexportBlocks.test(source)).toBe(true);
		expect(source).not.toMatch(/export\s+\*/);
		expect(source).not.toMatch(/^\s*import\s/m);
	});

	it("keeps src/index.ts to re-export blocks", async () => {
		const source = stripComments(await readFile(ROOT_INDEX, "utf8"));
		const reexportBlocks =
			/^(?:\s*export\s*\{[^{}]*\}\s*from\s*"\.\/[A-Za-z0-9_./-]+\.js";)+\s*$/;
		expect(reexportBlocks.test(source)).toBe(true);
		expect(source).not.toMatch(/export\s+\*/);
	});
});

describe("package entry points", () => {
	it("maps exactly five exports to built files", async () => {
		const packageJson = await readJson<PackageJson>("../package.json");
		expect(packageJson.exports).toEqual(PACKAGE_EXPORTS);
		expect(Object.keys(packageJson.exports)).toEqual([
			".",
			"./extension",
			"./runtime",
			"./components",
			"./service-provider",
			"./package.json",
		]);
		expect(packageJson.main).toBe(PACKAGE_EXPORTS["."].import);
		expect(packageJson.types).toBe(PACKAGE_EXPORTS["."].types);
		expect(packageJson.pi.extensions).toEqual([
			PACKAGE_EXPORTS["./extension"].import,
		]);
		for (const entry of Object.values(PACKAGE_EXPORTS)) {
			const targets =
				typeof entry === "string" ? [entry] : Object.values(entry);
			for (const target of targets) {
				await expect(access(here(`../${target}`))).resolves.toBeUndefined();
			}
		}
	});

	it("loads the built entries with the pinned export lists", async () => {
		const builtRoot = (await import("../dist/index.js")) as object;
		const builtRuntime = (await import("../dist/runtime/index.js")) as object;
		const builtExtension = (await import("../dist/extension.js")) as {
			default: unknown;
		};
		expect(exportNames(builtRoot)).toEqual(await readFixture(ROOT_FIXTURE));
		expect(exportNames(builtRuntime)).toEqual(
			await readFixture(RUNTIME_FIXTURE),
		);
		expect(typeof builtExtension.default).toBe("function");
	});

	it("exports the component library as its own disjoint entry", async () => {
		// The library is additive: a third entry point whose names appear in
		// neither pinned fixture, so no frozen surface moves with it. Its own
		// export list is not pinned - `./components` is unfrozen.
		const components = (await import("../src/components/index.js")) as object;
		const names = exportNames(components);
		expect(names).toContain("gate");
		expect(names).toContain("envelope");
		const rootNames = new Set(await readFixture(ROOT_FIXTURE));
		const runtimeNames = new Set(await readFixture(RUNTIME_FIXTURE));
		expect(
			names.filter((name) => rootNames.has(name) || runtimeNames.has(name)),
		).toEqual([]);
		const built = (await import("../dist/components/index.js")) as object;
		expect(exportNames(built)).toEqual(names);
	});

	it("records the frozen API in the compatibility matrix", async () => {
		const packageJson = await readJson<PackageJson>("../package.json");
		const compatibility = await readJson<Compatibility>(
			"../compatibility.json",
		);
		const api = compatibility.piWorkflow.api;
		// 2.0.0: the revision-19 bump refuses revision-18 persisted state, which
		// the stability policy makes a major. Every frozen shape below is
		// unchanged; `AgentTaskRequestSchema` only gained optional `memoryBytes`.
		expect(api.version).toBe("2.0.0");
		expect(majorOf(api.version)).toBe(majorOf(packageJson.version));
		expect(api.frozenSurfaces).toEqual([
			"authoring",
			"service",
			"contract",
			"extension",
		]);
		expect(api.entryPoints).toEqual({
			".": "frozen",
			"./extension": "frozen",
			"./runtime": "unfrozen",
			"./components": "unfrozen",
			"./service-provider": "unfrozen",
		});
		expect(Object.keys(api.entryPoints)).toEqual(
			Object.keys(PACKAGE_EXPORTS).filter((key) => key !== "./package.json"),
		);
		expect(api.exportList).toBe("test/fixtures/public-api/root-exports.json");
		expect(await readJson<string[]>(`../${api.exportList}`)).toEqual(
			await readFixture(ROOT_FIXTURE),
		);
	});
});
