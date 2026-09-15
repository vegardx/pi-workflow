import { access, readFile } from "node:fs/promises";
import { SUBAGENT_RUNTIME_CONTRACT } from "@vegardx/pi-subagent";
import { describe, expect, it } from "vitest";
import {
	WORKFLOW_CONTRACT_REVISION,
	WORKFLOW_RUNTIME_CONTRACT,
} from "../src/contracts.js";

interface PackageJson {
	name?: string;
	version?: string;
	private?: boolean;
	main?: string;
	types?: string;
	files?: string[];
	engines?: { node?: string };
	peerDependencies?: Record<string, string>;
	exports?: Record<string, unknown>;
	pi?: { extensions?: string[]; skills?: string[] };
}

interface Compatibility {
	schema: string;
	piWorkflow: { package: string; version: string; contractRevision: number };
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
	it("ships one public runtime entry", async () => {
		const packageJson = await readJson<PackageJson>("../package.json");
		expect(packageJson.name).toBe("@vegardx/pi-workflow");
		expect(packageJson.version).toBe("0.1.0");
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
			"0.10.0",
		);
		expect(packageJson.peerDependencies?.typebox).toBe(">=1.3.14 <2");
		expect(packageJson.exports?.["."]).toEqual({
			types: "./dist/index.d.ts",
			import: "./dist/index.js",
		});
	});

	it("declares the extension and the authoring skill to Pi", async () => {
		const packageJson = await readJson<PackageJson>("../package.json");
		expect(packageJson.pi).toEqual({
			extensions: ["./dist/extension.js"],
			skills: ["./skills"],
		});
		expect(packageJson.files).toEqual(
			expect.arrayContaining(["dist", "docs", "skills", "compatibility.json"]),
		);
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
	});

	it("loads the public module", async () => {
		const publicApi = await import("../src/index.js");
		expect(publicApi.WORKFLOW_RUNTIME_CONTRACT.schema).toBe(
			"pi-workflow-runtime",
		);
		expect(
			publicApi.WORKFLOW_TOOL_DECLARATIONS.map((tool) => tool.name),
		).toEqual([
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
		]);
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
			`| \`WORKFLOW_CONTRACT_REVISION\` | ${WORKFLOW_CONTRACT_REVISION} |`,
		);
	});
});
