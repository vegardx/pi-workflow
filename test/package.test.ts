import { access, readFile } from "node:fs/promises";
import { SUBAGENT_RUNTIME_CONTRACT } from "@vegardx/pi-subagent";
import { describe, expect, it } from "vitest";
import {
	WORKFLOW_CONTRACT_REVISION,
	WORKFLOW_RUNTIME_CONTRACT,
} from "../src/contracts.js";
import { DYNAMIC_TRANSFORMER_VERSION } from "../src/dynamic/constants.js";

interface PackageJson {
	name?: string;
	version?: string;
	private?: boolean;
	main?: string;
	types?: string;
	files?: string[];
	engines?: { node?: string };
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	exports?: Record<string, unknown>;
	pi?: { extensions?: string[]; skills?: string[]; workflows?: string[] };
}

interface Compatibility {
	schema: string;
	piWorkflow: {
		package: string;
		version: string;
		contractRevision: number;
		features: { checkpoints: boolean; dynamicWorkflows: boolean };
		api: {
			version: string;
			frozenSurfaces: string[];
			entryPoints: Record<string, string>;
			exportList: string;
		};
	};
	piSubagent: {
		package: string;
		peerRange: string;
		contractRevision: number;
		requiredFeatures: Record<string, boolean>;
		ciCommit: string;
	};
	pi: { packages: string[]; peerRange: string };
	node: { engines: string; ci: string };
	typebox: { peerRange: string };
	transformer: { package: string; version: string };
	hosts: Array<{
		platform: string;
		status: "qualified" | "build-only";
		evidence: string[];
	}>;
}

async function readJson<T>(relative: string): Promise<T> {
	return JSON.parse(
		await readFile(new URL(relative, import.meta.url), "utf8"),
	) as T;
}

describe("package contract", () => {
	it("ships the frozen root, extension, and runtime entries", async () => {
		const packageJson = await readJson<PackageJson>("../package.json");
		expect(packageJson.name).toBe("@vegardx/pi-workflow");
		expect(packageJson.version).toBe("2.0.0");
		expect(packageJson.private).not.toBe(true);
		expect(packageJson.main).toBe("./dist/index.js");
		expect(packageJson.types).toBe("./dist/index.d.ts");
		expect(packageJson.engines?.node).toBe(">=23.6.0");
		expect(
			packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"],
		).toBe(">=0.85.0 <0.86");
		expect(packageJson.peerDependencies?.["@earendil-works/pi-server"]).toBe(
			">=0.85.0 <0.86",
		);
		expect(packageJson.peerDependencies?.["@earendil-works/pi-tui"]).toBe(
			">=0.85.0 <0.86",
		);
		// The TUI package is a peer like the other Pi packages, listed in order.
		expect(Object.keys(packageJson.peerDependencies ?? {})).toEqual(
			[...Object.keys(packageJson.peerDependencies ?? {})].sort(),
		);
		expect(packageJson.peerDependencies?.["@vegardx/pi-subagent"]).toBe(
			"0.11.0",
		);
		expect(packageJson.peerDependencies?.typebox).toBe(">=1.3.14 <2");
		expect(packageJson.exports).toEqual({
			".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
			"./extension": {
				types: "./dist/extension.d.ts",
				import: "./dist/extension.js",
			},
			"./runtime": {
				types: "./dist/runtime/index.d.ts",
				import: "./dist/runtime/index.js",
			},
			"./package.json": "./package.json",
		});
	});

	it("declares the extension, both bundled skills, and the builtin workflows to Pi", async () => {
		const packageJson = await readJson<PackageJson>("../package.json");
		expect(packageJson.pi).toEqual({
			extensions: ["./dist/extension.js"],
			skills: ["./skills"],
			workflows: ["./workflows"],
		});
		expect(packageJson.files).toEqual(
			expect.arrayContaining([
				"dist",
				"docs",
				"skills",
				"workflows",
				"compatibility.json",
			]),
		);
		// The declared root is the directory the extension registers as its
		// builtin root, and it holds the shipped definitions.
		await expect(
			access(new URL("../workflows/plan-to-ship.workflow.ts", import.meta.url)),
		).resolves.toBeUndefined();
		// W3: the agents plan-to-ship names travel in the same directory as
		// templates. `files: ["workflows"]` ships them; discovery ignores them
		// because they are not `*.workflow.*`.
		for (const agent of ["planner", "implementer", "reviewer"]) {
			await expect(
				access(new URL(`../workflows/agents/${agent}.md`, import.meta.url)),
			).resolves.toBeUndefined();
		}
		const skill = await readFile(
			new URL("../skills/workflow-authoring/SKILL.md", import.meta.url),
			"utf8",
		);
		expect(skill.startsWith("---\nname: workflow-authoring\n")).toBe(true);
		await expect(
			access(
				new URL(
					"../skills/workflow-authoring/references/examples.md",
					import.meta.url,
				),
			),
		).resolves.toBeUndefined();
		const operating = await readFile(
			new URL("../skills/workflows/SKILL.md", import.meta.url),
			"utf8",
		);
		expect(operating.startsWith("---\nname: workflows\n")).toBe(true);
	});
});

describe("compatibility matrix", () => {
	it("matches the manifest, the contract constants, and the CI workflow", async () => {
		const compatibility = await readJson<Compatibility>(
			"../compatibility.json",
		);
		const packageJson = await readJson<PackageJson>("../package.json");
		const subagentPackage = await readJson<PackageJson>(
			"../node_modules/@vegardx/pi-subagent/package.json",
		);
		const ci = await readFile(
			new URL("../.github/workflows/ci.yml", import.meta.url),
			"utf8",
		);
		const ciSubagentCommit = ci.match(
			/repository: vegardx\/pi-subagent\n\s+ref: ([0-9a-f]{40})\n/,
		)?.[1];
		const ciNode = ci.match(/node-version: (\S+)\n/)?.[1];

		expect(compatibility.schema).toBe("pi-workflow-compatibility");
		expect(compatibility.piWorkflow).toEqual({
			package: packageJson.name,
			version: packageJson.version,
			contractRevision: WORKFLOW_CONTRACT_REVISION,
			features: {
				checkpoints: WORKFLOW_RUNTIME_CONTRACT.features.checkpoints,
				dynamicWorkflows: WORKFLOW_RUNTIME_CONTRACT.features.dynamicWorkflows,
			},
			api: {
				version: "2.0.0",
				frozenSurfaces: ["authoring", "service", "contract", "extension"],
				entryPoints: {
					".": "frozen",
					"./extension": "frozen",
					"./runtime": "unfrozen",
				},
				exportList: "test/fixtures/public-api/root-exports.json",
			},
		});
		expect(compatibility.piWorkflow.version).toBe("2.0.0");
		expect(compatibility.piWorkflow.api.version).toBe(packageJson.version);
		await expect(
			access(
				new URL(
					`../${compatibility.piWorkflow.api.exportList}`,
					import.meta.url,
				),
			),
		).resolves.toBeUndefined();
		expect(WORKFLOW_CONTRACT_REVISION).toBe(19);
		expect(compatibility.piWorkflow.features).toEqual({
			checkpoints: true,
			dynamicWorkflows: true,
		});
		expect(compatibility.piSubagent.package).toBe("@vegardx/pi-subagent");
		expect(compatibility.piSubagent.peerRange).toBe(
			packageJson.peerDependencies?.["@vegardx/pi-subagent"],
		);
		expect(compatibility.piSubagent.peerRange).toBe(subagentPackage.version);
		expect(compatibility.piSubagent.contractRevision).toBe(
			WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.contractRevision,
		);
		expect(compatibility.piSubagent.contractRevision).toBe(
			SUBAGENT_RUNTIME_CONTRACT.contractRevision,
		);
		expect(compatibility.piSubagent.requiredFeatures).toEqual(
			WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.features,
		);
		expect(compatibility.piSubagent.ciCommit).toBe(ciSubagentCommit);
		expect(compatibility.pi.packages).toEqual([
			"@earendil-works/pi-coding-agent",
			"@earendil-works/pi-server",
			"@earendil-works/pi-tui",
		]);
		for (const name of compatibility.pi.packages) {
			expect(packageJson.peerDependencies?.[name]).toBe(
				compatibility.pi.peerRange,
			);
		}
		expect(compatibility.node.engines).toBe(packageJson.engines?.node);
		expect(compatibility.node.ci).toBe(ciNode);
		expect(compatibility.typebox.peerRange).toBe(
			packageJson.peerDependencies?.typebox,
		);
		expect(compatibility.transformer).toEqual({
			package: "amaro",
			version: DYNAMIC_TRANSFORMER_VERSION,
		});
		expect(packageJson.dependencies?.amaro).toBe(DYNAMIC_TRANSFORMER_VERSION);
	});

	it("cites existing evidence for every host status", async () => {
		const compatibility = await readJson<Compatibility>(
			"../compatibility.json",
		);
		const doc = await readFile(
			new URL("../docs/compatibility.md", import.meta.url),
			"utf8",
		);
		expect(
			compatibility.hosts.map((host) => [host.platform, host.status]),
		).toEqual([
			["macos-arm64", "qualified"],
			["linux-x64", "build-only"],
		]);
		for (const host of compatibility.hosts) {
			expect(host.evidence.length).toBeGreaterThan(0);
			for (const evidence of host.evidence) {
				await expect(
					access(new URL(`../${evidence}`, import.meta.url)),
				).resolves.toBeUndefined();
			}
		}
		expect(doc).toContain("| macOS arm64 | Qualified |");
		expect(doc).toContain("| Linux x64 | Build-only |");
		expect(doc).toContain(`\`${compatibility.piSubagent.ciCommit}\``);
		expect(doc).toContain(
			`| \`WORKFLOW_CONTRACT_REVISION\` | ${WORKFLOW_CONTRACT_REVISION}`,
		);
	});
});

// B2 (1.0 API freeze): matrix rows for the api block and docs/compatibility.md.
describe("compatibility matrix 1.0", () => {
	interface CompatibilityApi {
		piWorkflow: {
			version: string;
			api?: {
				version: string;
				frozenSurfaces: string[];
				entryPoints: Record<string, string>;
				exportList: string;
			};
		};
		hosts: Array<{ platform: string; evidence: string[] }>;
	}

	it("records the API version, frozen surfaces, and entry-point status", async () => {
		const compatibility = await readJson<CompatibilityApi>(
			"../compatibility.json",
		);
		const packageJson = await readJson<PackageJson>("../package.json");
		expect(compatibility.piWorkflow.version).toBe("2.0.0");
		expect(compatibility.piWorkflow.api).toEqual({
			version: "2.0.0",
			frozenSurfaces: ["authoring", "service", "contract", "extension"],
			entryPoints: {
				".": "frozen",
				"./extension": "frozen",
				"./runtime": "unfrozen",
			},
			exportList: "test/fixtures/public-api/root-exports.json",
		});
		expect(compatibility.piWorkflow.api?.version).toBe(packageJson.version);
		// Every entry point with a status is exported; ./package.json is the
		// manifest and carries no status.
		expect(
			Object.keys(packageJson.exports ?? {}).filter(
				(entry) => entry !== "./package.json",
			),
		).toEqual(Object.keys(compatibility.piWorkflow.api?.entryPoints ?? {}));
		expect(packageJson.exports?.["./package.json"]).toBe("./package.json");
		expect(packageJson).not.toHaveProperty("typesVersions");
		const exportList = await readJson<string[]>(
			`../${compatibility.piWorkflow.api?.exportList}`,
		);
		expect(exportList).toEqual([...exportList].sort());
		expect(
			compatibility.hosts.find((host) => host.platform === "macos-arm64")
				?.evidence,
		).toContain("docs/qualification.md");
	});

	it("states the 2.0.0 rows in docs/compatibility.md", async () => {
		const compatibility = await readJson<CompatibilityApi>(
			"../compatibility.json",
		);
		const rootExports = await readJson<string[]>(
			"../test/fixtures/public-api/root-exports.json",
		);
		const runtimeExports = await readJson<string[]>(
			"../test/fixtures/public-api/runtime-exports.json",
		);
		const doc = await readFile(
			new URL("../docs/compatibility.md", import.meta.url),
			"utf8",
		);
		expect(doc).toContain("| `@vegardx/pi-workflow` | 2.0.0 |");
		expect(doc).toContain(
			`| API version | ${compatibility.piWorkflow.api?.version} |`,
		);
		expect(doc).toContain(
			`| Frozen surfaces | ${compatibility.piWorkflow.api?.frozenSurfaces.join(", ")} |`,
		);
		expect(doc).toContain(
			"| Entry points | `.` frozen, `./extension` frozen, `./runtime` unfrozen",
		);
		expect(doc).toContain(
			`| Pinned export lists | \`.\`: ${rootExports.length} value exports, \`./runtime\`: ${runtimeExports.length} value exports;`,
		);
		expect(doc).toContain(
			"| TypeScript module resolution | `node16`, `nodenext`, or `bundler`",
		);
		expect(doc).toContain("no `typesVersions`");
		expect(doc).toContain(
			`| \`WORKFLOW_CONTRACT_REVISION\` | ${WORKFLOW_CONTRACT_REVISION} | \`src/contracts-core.ts\` (re-exported by \`src/contracts.ts\`); 2.0.0 raises it from 18`,
		);
		expect(doc).toContain(
			"| Required `@vegardx/pi-subagent` | `0.11.0` (exact; raised from `0.10.0` by 2.0.0) |",
		);
		expect(doc).toContain(
			`| Required pi-subagent contract revision | ${WORKFLOW_RUNTIME_CONTRACT.requiredSubagent.contractRevision} |`,
		);
		expect(doc).toContain("| `vmMemoryCeiling` | `true` |");
		expect(doc).toContain("| `workspaceBudgetRefusal` | `true` |");
		expect(doc).toContain("[`docs/qualification.md`](qualification.md)");
		// F1: the builtin root is part of the packaged surface.
		expect(doc).toContain("| Builtin workflow root | `workflows/`");
	});
});
