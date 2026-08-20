import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface PackageJson {
	name?: string;
	version?: string;
	private?: boolean;
	main?: string;
	types?: string;
	engines?: { node?: string };
	peerDependencies?: Record<string, string>;
	exports?: Record<string, unknown>;
}

describe("package contract", () => {
	it("ships one public runtime entry", async () => {
		const packageJson = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		) as PackageJson;
		expect(packageJson.name).toBe("@vegardx/pi-workflow");
		expect(packageJson.version).toBe("0.1.0");
		expect(packageJson.private).not.toBe(true);
		expect(packageJson.main).toBe("./dist/index.js");
		expect(packageJson.types).toBe("./dist/index.d.ts");
		expect(packageJson.engines?.node).toBe(">=23.6.0");
		expect(packageJson.peerDependencies?.["@vegardx/pi-subagent"]).toBe(
			"0.9.0",
		);
		expect(packageJson.peerDependencies?.typebox).toBe(">=1.3.14 <2");
		expect(packageJson.exports?.["."]).toEqual({
			types: "./dist/index.d.ts",
			import: "./dist/index.js",
		});
	});

	it("loads the public module", async () => {
		const publicApi = await import("../src/index.js");
		expect(publicApi.WORKFLOW_RUNTIME_CONTRACT.schema).toBe(
			"pi-workflow-runtime",
		);
	}, 15_000);
});
