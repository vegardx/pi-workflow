import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { Worker } from "node:worker_threads";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { canonicalArtifactJson } from "../src/artifact-store.js";
import { WORKFLOW_CONTRACT_REVISION } from "../src/contracts.js";
import {
	DYNAMIC_HOST_API_REVISION,
	DYNAMIC_TRANSFORMER,
	MAX_DYNAMIC_PROPOSALS,
	MAX_DYNAMIC_SOURCE_BYTES,
} from "../src/dynamic/constants.js";
import {
	DYNAMIC_SOURCE_APPROVAL_SCHEMA_SHA256,
	type DynamicSupportHelperSpec,
	DynamicWorkflowProposalRecordSchema,
} from "../src/dynamic/contracts.js";
import {
	deriveDynamicDefinitionIdentitySha256,
	deriveDynamicHostApiSha256,
	deriveDynamicImportPolicySha256,
} from "../src/dynamic/identity.js";
import {
	canonicalDynamicDocument,
	createDynamicWorkflowProposalRecord,
	DynamicWorkflowProposalStore,
	validateDynamicWorkflowManifest,
	WorkflowDynamicStoreError,
	WorkflowDynamicStoreFullError,
} from "../src/dynamic/proposal-store.js";
import {
	assertDynamicSourceBounds,
	assertDynamicSourceImports,
	assertDynamicSourceIntake,
	assertDynamicSourceRules,
	DynamicSourceIntakeError,
	deriveDynamicSourceSha256,
	dynamicRef,
	isDynamicRef,
	parseDynamicRef,
} from "../src/dynamic/source.js";
import {
	createDynamicImporters,
	DynamicTransformError,
	transformDynamicSource,
} from "../src/dynamic/transformer.js";
import {
	assertDynamicTransformerVersion,
	installedDynamicTransformerVersion,
} from "../src/dynamic/transformer-identity.js";
import { deriveJsonValueSha256 } from "../src/execution.js";

const digest = "a".repeat(64);
const revision = WORKFLOW_CONTRACT_REVISION;

const linearSource = `import { defineWorkflow } from "@vegardx/pi-workflow";
import { Type } from "typebox";

const InputSchema = Type.Object(
	{ question: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const AnswerSchema = Type.Object(
	{ answer: Type.String() },
	{ additionalProperties: false },
);

export default defineWorkflow({
	meta: {
		name: "linear-answer",
		description: "Answer one question from the repository",
		version: 1,
		budget: { cost: 5, childRuntimeMs: 1_800_000 },
		timeoutMs: 3_600_000,
	},
	inputSchema: InputSchema,
	outputSchema: AnswerSchema,
	run(ctx) {
		ctx.phase("answer");
		return ctx.agent("answer", {} as never);
	},
});
`;

const manifest = {
	meta: {
		name: "linear-answer",
		description: "Answer one question from the repository",
		version: 1,
		budget: { cost: 5, childRuntimeMs: 1_800_000 },
		timeoutMs: 3_600_000,
		concurrency: 4,
	},
	inputSchema: {
		type: "object",
		properties: { question: { type: "string", minLength: 1 } },
		required: ["question"],
		additionalProperties: false,
	},
	outputSchema: {
		type: "object",
		properties: { answer: { type: "string" } },
		required: ["answer"],
		additionalProperties: false,
	},
};

const helper: DynamicSupportHelperSpec = {
	name: "digest",
	moduleSpecifier: "@acme/tools",
	revision: 1,
	implementationSha256: "b".repeat(64),
	parametersSchema: { type: "object", additionalProperties: false },
	outputSchema: { type: "string" },
	exportName: "digest",
};

function root(): string {
	return path.resolve(".pi", "test-dynamic-source", randomUUID());
}

function intake(source: unknown, allowed: readonly string[] = []) {
	return assertDynamicSourceIntake(source, { allowedSupportImports: allowed });
}

function failure(fn: () => unknown): Error {
	try {
		fn();
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected a failure");
}

function proposalRecord(source: string, importPolicySha256 = "c".repeat(64)) {
	return createDynamicWorkflowProposalRecord({
		sourceSha256: deriveDynamicSourceSha256(source),
		sourceBytes: Buffer.byteLength(source, "utf8"),
		manifest,
		importPolicySha256,
		proposer: { kind: "tool", via: "workflow_propose" },
		proposedAt: "2026-09-15T10:00:00.000Z",
		projectRoot: "/projects/demo",
	});
}

describe("dynamic references", () => {
	it("parses dynamic:<sha256> and nothing else", () => {
		expect(parseDynamicRef(`dynamic:${digest}`)).toBe(digest);
		expect(dynamicRef(digest)).toBe(`dynamic:${digest}`);
		expect(parseDynamicRef(`dynamic:${"A".repeat(64)}`)).toBeUndefined();
		expect(parseDynamicRef(`dynamic:${"a".repeat(63)}`)).toBeUndefined();
		expect(parseDynamicRef(`dynamic:${digest} `)).toBeUndefined();
		expect(parseDynamicRef("linear-answer")).toBeUndefined();
		expect(parseDynamicRef(undefined)).toBeUndefined();
		expect(isDynamicRef("dynamic:nope")).toBe(true);
		expect(isDynamicRef("workflows/a.workflow.ts")).toBe(false);
	});

	it("digests the UTF-8 bytes of the source exactly as proposed", () => {
		const source = "export default 1; // ✓\n";
		expect(deriveDynamicSourceSha256(source)).toBe(
			createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex"),
		);
		expect(deriveDynamicSourceSha256(source)).not.toBe(
			deriveDynamicSourceSha256(`${source}\n`),
		);
	});
});

describe("dynamic source bounds", () => {
	it("refuses non-strings, empty, and oversized sources", () => {
		expect(failure(() => assertDynamicSourceBounds(42)).message).toBe(
			"Dynamic workflow source must be a string.",
		);
		expect(failure(() => assertDynamicSourceBounds("")).message).toBe(
			"Dynamic workflow source is empty.",
		);
		const oversized = "x".repeat(MAX_DYNAMIC_SOURCE_BYTES + 1);
		expect(failure(() => assertDynamicSourceBounds(oversized)).message).toBe(
			"Dynamic workflow source exceeds 262144 bytes.",
		);
		const multibyte = "é".repeat(MAX_DYNAMIC_SOURCE_BYTES / 2 + 1);
		expect(failure(() => assertDynamicSourceBounds(multibyte)).message).toBe(
			"Dynamic workflow source exceeds 262144 bytes.",
		);
		expect(
			assertDynamicSourceBounds("x".repeat(MAX_DYNAMIC_SOURCE_BYTES))
				.sourceBytes,
		).toBe(MAX_DYNAMIC_SOURCE_BYTES);
	});

	it("refuses sources that are not valid UTF-8", () => {
		expect(
			failure(() => assertDynamicSourceBounds("export default 1; \uD800"))
				.message,
		).toBe("Dynamic workflow source is not valid UTF-8.");
		expect(
			failure(() => assertDynamicSourceBounds("export default 1; �")).message,
		).toBe("Dynamic workflow source is not valid UTF-8.");
		const identity = assertDynamicSourceBounds("export default 1; // ✓");
		expect(identity.sourceBytes).toBe(
			Buffer.byteLength("export default 1; // ✓", "utf8"),
		);
		expect(identity.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("names its errors", () => {
		const error = failure(() => assertDynamicSourceBounds(""));
		expect(error).toBeInstanceOf(DynamicSourceIntakeError);
		expect(error.name).toBe("DynamicSourceIntakeError");
		expect((error as DynamicSourceIntakeError).code).toBe("validation");
	});
});

describe("dynamic source import gate", () => {
	it("forwards the registry messages verbatim", () => {
		const cases: readonly [string, string][] = [
			[
				'import { readFile } from "node:fs";\nexport default 1;\n',
				`workflow import node:fs is not identity-bound by contract revision ${revision}`,
			],
			[
				'import { digest } from "@acme/tools";\nexport default 1;\n',
				`workflow import @acme/tools is not identity-bound by contract revision ${revision}`,
			],
			[
				'export * from "typebox";\nexport default 1;\n',
				`workflow import typebox is not identity-bound by contract revision ${revision}`.replace(
					"typebox",
					"typebox",
				),
			],
			[
				// Babel parses import() as a CallExpression whose callee is Import.
				'const m = await import("typebox");\nexport default m;\n',
				`dynamic imports and CommonJS require are not supported by contract revision ${revision}`,
			],
			[
				'const fs = require("node:fs");\nexport default fs;\n',
				`dynamic imports and CommonJS require are not supported by contract revision ${revision}`,
			],
			[
				'import fs = require("node:fs");\nexport default fs;\n',
				`TypeScript import assignment is not supported by contract revision ${revision}`,
			],
			["export default {", "workflow definition syntax is invalid"],
		];
		for (const [source, message] of cases.slice(0, 2)) {
			const error = failure(() => intake(source));
			expect(error).toBeInstanceOf(DynamicSourceIntakeError);
			expect(error.message).toBe(message);
		}
		for (const [source, message] of cases.slice(3)) {
			expect(failure(() => intake(source)).message).toBe(message);
		}
	});

	it("re-exports of an allowed module pass the gate but fail the export rule", () => {
		const source = 'export { Type } from "typebox";\nexport default 1;\n';
		expect(() =>
			assertDynamicSourceImports(source, deriveDynamicSourceSha256(source), []),
		).not.toThrow();
		expect(failure(() => intake(source)).message).toBe(
			"dynamic workflow source must have exactly one default export and no named exports",
		);
	});

	it("admits registered support module specifiers only", () => {
		const source = 'import { digest } from "@acme/tools";\nexport default 1;\n';
		expect(intake(source, ["@acme/tools"]).sourceSha256).toBe(
			deriveDynamicSourceSha256(source),
		);
		expect(failure(() => intake(source, ["@acme/other"])).message).toBe(
			`workflow import @acme/tools is not identity-bound by contract revision ${revision}`,
		);
	});
});

describe("dynamic-only source rules", () => {
	it("refuses import.meta anywhere", () => {
		expect(
			failure(() =>
				assertDynamicSourceRules(
					"const u = import.meta.url;\nexport default u;\n",
				),
			).message,
		).toBe("dynamic workflow source may not use import.meta");
		expect(
			failure(() =>
				assertDynamicSourceRules(
					"function f() { return { m: import.meta }; }\nexport default f;\n",
				),
			).message,
		).toBe("dynamic workflow source may not use import.meta");
	});

	it("requires exactly one default export and no named exports", () => {
		const shape =
			"dynamic workflow source must have exactly one default export and no named exports";
		expect(
			failure(() => assertDynamicSourceRules("const x = 1;\n")).message,
		).toBe(shape);
		expect(
			failure(() =>
				assertDynamicSourceRules("export const x = 1;\nexport default x;\n"),
			).message,
		).toBe(shape);
		expect(
			failure(() =>
				assertDynamicSourceRules(
					"const x = 1;\nexport { x };\nexport default 2;\n",
				),
			).message,
		).toBe(shape);
		expect(
			failure(() =>
				assertDynamicSourceRules(
					'export * from "typebox";\nexport default 2;\n',
				),
			).message,
		).toBe(shape);
		expect(() => assertDynamicSourceRules(linearSource)).not.toThrow();
		expect(() =>
			assertDynamicSourceRules(
				"const v = await Promise.resolve(1);\nexport default v;\n",
			),
		).not.toThrow();
	});

	it("applies bounds, the gate, and the rules in order", () => {
		expect(failure(() => intake("")).message).toBe(
			"Dynamic workflow source is empty.",
		);
		expect(
			failure(() => intake('import "node:fs";\nconst u = import.meta;\n'))
				.message,
		).toBe(
			`workflow import node:fs is not identity-bound by contract revision ${revision}`,
		);
		expect(intake(linearSource)).toEqual({
			sourceSha256: deriveDynamicSourceSha256(linearSource),
			sourceBytes: Buffer.byteLength(linearSource, "utf8"),
		});
	});
});

describe("dynamic transformer", () => {
	const filename = `dynamic:${digest}.workflow.ts`;

	function run(
		source: string,
		modules: Record<string, Readonly<Record<string, unknown>>>,
		supportModuleSpecifiers: readonly string[] = [],
	) {
		const { code } = transformDynamicSource({
			source,
			filename,
			supportModuleSpecifiers,
		});
		const factory = vm.runInNewContext(code, {}, { filename }) as (
			...args: unknown[]
		) => Promise<void>;
		const exports: { default?: unknown } = {};
		const importers = createDynamicImporters(modules);
		return factory(
			modules,
			exports,
			importers.__import,
			importers.__importNamespace,
		).then(() => exports);
	}

	it("is pinned to the installed amaro version", () => {
		expect(installedDynamicTransformerVersion()).toBe(
			DYNAMIC_TRANSFORMER.version,
		);
		expect(() => assertDynamicTransformerVersion()).not.toThrow();
		expect(DYNAMIC_TRANSFORMER.name).toBe("amaro");
		expect(DYNAMIC_TRANSFORMER.mode).toBe("transform");
	});

	it("lowers full TypeScript and erases type-only imports", async () => {
		const source = `import type { Anything } from "node:fs";
import { type TSchema, Type } from "typebox";
enum Mode { Fast = 1, Slow = 2 }
class Box { constructor(public readonly value: number) {} }
namespace Names { export const inner = "n"; }
const schema = Type.Object({}) satisfies TSchema;
export default { mode: Mode.Slow, box: new Box(3).value, inner: Names.inner, schema };
`;
		const { code } = transformDynamicSource({ source, filename });
		expect(
			code.startsWith(
				'(async function (__modules, __exports, __import, __importNamespace) { "use strict";\n',
			),
		).toBe(true);
		expect(code.endsWith("\n})")).toBe(true);
		expect(code).not.toContain("node:fs");
		expect(code).not.toContain("enum ");
		expect(code).not.toContain("satisfies");
		expect(code).toContain('const Type = __import("typebox", "Type");');
		const exports = await run(source, {
			typebox: Object.freeze({ Type: { Object: (v: unknown) => v } }),
		});
		expect(exports.default).toEqual({
			mode: 2,
			box: 3,
			inner: "n",
			schema: {},
		});
	});

	it("rewrites every import form and the default export", async () => {
		const source = `import Type from "typebox";
import { Value as V, Kind } from "typebox";
import * as tb from "typebox";
import "typebox";
import { digest } from "@acme/tools";
export default function build() { return [Type, V, Kind, tb, digest]; }
`;
		const { code } = transformDynamicSource({
			source,
			filename,
			supportModuleSpecifiers: ["@acme/tools"],
		});
		expect(code).toContain('const Type = __import("typebox", "default");');
		expect(code).toContain(
			'const V = __import("typebox", "Value"), Kind = __import("typebox", "Kind");',
		);
		expect(code).toContain('const tb = __importNamespace("typebox");');
		expect(code).toContain('const digest = __import("@acme/tools", "digest");');
		expect(code).toMatch(/__exports\.default = function build\(\)/);
		expect(code).not.toContain("import ");
		expect(code).not.toContain("export ");
		const typebox = Object.freeze({ default: "T", Value: "V", Kind: "K" });
		const exports = await run(
			source,
			{ typebox, "@acme/tools": Object.freeze({ digest: "D" }) },
			["@acme/tools"],
		);
		expect((exports.default as () => unknown[])()).toEqual([
			"T",
			"V",
			"K",
			typebox,
			"D",
		]);
	});

	it("rewrites class and expression default exports", async () => {
		const klass = await run(
			"export default class Thing { static id = 7 }\n",
			{},
		);
		expect((klass.default as { id: number }).id).toBe(7);
		const value = await run(
			"const v = { a: 1 };\nexport default v as const;\n",
			{},
		);
		expect(value.default).toEqual({ a: 1 });
		expect(
			transformDynamicSource({ source: "export default 1 + 1;\n", filename })
				.code,
		).toContain("__exports.default = (1 + 1);");
	});

	it("refuses unavailable imports, named exports, and deprecated modules", () => {
		const failing = (source: string, specifiers: readonly string[] = []) =>
			failure(() =>
				transformDynamicSource({
					source,
					filename,
					supportModuleSpecifiers: specifiers,
				}),
			);
		let error = failing(
			'import { readFile } from "node:fs";\nexport default 1;\n',
		);
		expect(error).toBeInstanceOf(DynamicTransformError);
		expect(error.name).toBe("DynamicTransformError");
		expect(error.message).toBe(
			"dynamic workflow import node:fs is not available",
		);
		error = failing(
			'import { digest } from "@acme/tools";\nexport default 1;\n',
		);
		expect(error.message).toBe(
			"dynamic workflow import @acme/tools is not available",
		);
		expect(failing("export const x = 1;\nexport default x;\n").message).toBe(
			"dynamic workflow source must have exactly one default export and no named exports",
		);
		expect(failing("const x = 1;\n").message).toBe(
			"dynamic workflow source must have exactly one default export and no named exports",
		);
		expect(failing("module Foo {}\nexport default 1;\n").message).toContain(
			"`module` keyword is not supported",
		);
		expect(failing("const x: = 1;\nexport default x;\n").message).toContain(
			"Unexpected token",
		);
	});

	it("throws structured errors from the injected importers", () => {
		const importers = createDynamicImporters({
			typebox: Object.freeze({ Type: 1 }),
		});
		expect(importers.__import("typebox", "Type")).toBe(1);
		expect(() => importers.__import("nope", "x")).toThrow(
			'Dynamic workflow import "nope" is not available.',
		);
		expect(() => importers.__importNamespace("nope")).toThrow(
			'Dynamic workflow import "nope" is not available.',
		);
		expect(() => importers.__import("typebox", "x")).toThrow(
			'Dynamic workflow import "typebox" has no export "x".',
		);
		expect(() => importers.__import("typebox", "toString")).toThrow(
			'Dynamic workflow import "typebox" has no export "toString".',
		);
	});

	it("is byte-stable across calls and across workers", async () => {
		const first = transformDynamicSource({ source: linearSource, filename });
		const second = transformDynamicSource({ source: linearSource, filename });
		expect(second.code).toBe(first.code);
		const fromWorker = () =>
			new Promise<string>((resolve, reject) => {
				const worker = new Worker(
					new URL("./fixtures/dynamic-transform-worker.ts", import.meta.url),
					{
						execArgv: ["--import", "tsx"],
						workerData: { source: linearSource, filename },
					},
				);
				worker.once("message", (message: string) => resolve(message));
				worker.once("error", reject);
				worker.once("exit", (code) => {
					if (code !== 0) reject(new Error(`worker exited ${code}`));
				});
			});
		const [a, b] = await Promise.all([fromWorker(), fromWorker()]);
		expect(a).toBe(first.code);
		expect(b).toBe(first.code);
	});
});

describe("dynamic identities", () => {
	it("derives a stable host API digest from the constants", () => {
		expect(deriveDynamicHostApiSha256()).toMatch(/^[a-f0-9]{64}$/);
		expect(deriveDynamicHostApiSha256()).toBe(deriveDynamicHostApiSha256());
		expect(DYNAMIC_HOST_API_REVISION).toBe(1);
		expect(DYNAMIC_SOURCE_APPROVAL_SCHEMA_SHA256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("derives an order-independent import policy digest", () => {
		const other: DynamicSupportHelperSpec = {
			...helper,
			name: "other",
			exportName: "other",
		};
		expect(deriveDynamicImportPolicySha256([helper, other])).toBe(
			deriveDynamicImportPolicySha256([other, helper]),
		);
		expect(deriveDynamicImportPolicySha256([helper])).not.toBe(
			deriveDynamicImportPolicySha256([]),
		);
		expect(deriveDynamicImportPolicySha256([helper])).not.toBe(
			deriveDynamicImportPolicySha256([{ ...helper, exportName: "renamed" }]),
		);
		expect(deriveDynamicImportPolicySha256([helper])).not.toBe(
			deriveDynamicImportPolicySha256([
				{ ...helper, implementationSha256: "d".repeat(64) },
			]),
		);
	});

	it("composes the definition identity canonically", () => {
		const parts = {
			sourceSha256: "1".repeat(64),
			manifestSha256: "2".repeat(64),
			hostApiSha256: "3".repeat(64),
		};
		expect(deriveDynamicDefinitionIdentitySha256(parts)).toBe(
			deriveJsonValueSha256({
				contractRevision: revision,
				hostApiSha256: parts.hostApiSha256,
				kind: "dynamic-workflow",
				manifestSha256: parts.manifestSha256,
				sourceSha256: parts.sourceSha256,
			}),
		);
		expect(deriveDynamicDefinitionIdentitySha256(parts)).not.toBe(
			deriveDynamicDefinitionIdentitySha256({
				...parts,
				hostApiSha256: "4".repeat(64),
			}),
		);
	});
});

describe("dynamic proposal records", () => {
	it("validates manifests on the host side", () => {
		expect(validateDynamicWorkflowManifest(manifest)).toEqual(manifest);
		expect(
			Object.isFrozen(validateDynamicWorkflowManifest(manifest).meta),
		).toBe(true);
		for (const broken of [
			{ ...manifest, meta: { ...manifest.meta, concurrency: undefined } },
			{ ...manifest, inputSchema: { type: "nope" } },
			{ ...manifest, outputSchema: { type: "object", required: "answer" } },
			{ ...manifest, extra: 1 },
			null,
		]) {
			const error = failure(() => validateDynamicWorkflowManifest(broken));
			expect(error).toBeInstanceOf(DynamicSourceIntakeError);
			expect(error.message).toBe("Dynamic workflow manifest is invalid.");
		}
	});

	it("derives every digest of the record by construction", () => {
		const record = proposalRecord(linearSource);
		expect(Value.Check(DynamicWorkflowProposalRecordSchema, record)).toBe(true);
		expect(record.manifestSha256).toBe(deriveJsonValueSha256(manifest));
		expect(record.hostApiSha256).toBe(deriveDynamicHostApiSha256());
		expect(record.definitionIdentitySha256).toBe(
			deriveDynamicDefinitionIdentitySha256(record),
		);
		expect(record.transformer).toEqual(
			JSON.parse(JSON.stringify(DYNAMIC_TRANSFORMER)),
		);
		expect(record.sourceBytes).toBe(Buffer.byteLength(linearSource, "utf8"));
		expect(Object.isFrozen(record.manifest)).toBe(true);
	});
});

describe("dynamic proposal store", () => {
	async function fixture() {
		const storeRoot = root();
		const store = await DynamicWorkflowProposalStore.open({ storeRoot });
		const record = proposalRecord(linearSource);
		return { storeRoot, store, record, sha: record.sourceSha256 };
	}

	it("opens <storeRoot>/dynamic owner-only", async () => {
		const { storeRoot, store } = await fixture();
		expect(store.root).toBe(path.join(storeRoot, "dynamic"));
		expect((await stat(store.root)).mode & 0o777).toBe(0o700);
		expect(await store.count()).toBe(0);
		expect(await store.list()).toEqual([]);
		const again = await DynamicWorkflowProposalStore.open({ storeRoot });
		expect(again.root).toBe(store.root);
	});

	it("rejects a dynamic directory that escapes its root", async () => {
		const storeRoot = root();
		const outside = path.join(storeRoot, "outside");
		await mkdir(outside, { recursive: true });
		await symlink(outside, path.join(storeRoot, "dynamic"));
		await expect(
			DynamicWorkflowProposalStore.open({ storeRoot }),
		).rejects.toThrow("dynamic workflow store escapes its root");
	});

	it("creates the layout with exact bytes and owner-only modes", async () => {
		const { store, record, sha } = await fixture();
		const result = await store.put({ source: linearSource, record });
		expect(result.created).toBe(true);
		expect(result.replaced).toBe(false);
		const directory = path.join(store.root, sha);
		expect(result.proposal.directory).toBe(directory);
		expect(result.proposal.path).toBe(
			path.join(directory, "source.workflow.ts"),
		);
		expect(result.proposal.decisionsDirectory).toBe(
			path.join(directory, "decisions"),
		);
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		// The record pair lives in a versioned directory named by `current`.
		const records = result.proposal.recordsDirectory;
		const version = path.basename(records);
		expect(version).toMatch(/^[a-f0-9]{32}$/);
		expect(records).toBe(path.join(directory, "records", version));
		expect((await stat(path.join(directory, "records"))).mode & 0o777).toBe(
			0o700,
		);
		expect((await stat(records)).mode & 0o777).toBe(0o700);
		for (const [target, content] of [
			[
				path.join(directory, "source.workflow.ts"),
				Buffer.from(linearSource, "utf8"),
			],
			[path.join(directory, "current"), Buffer.from(`${version}\n`, "utf8")],
			[path.join(records, "manifest.json"), canonicalDynamicDocument(manifest)],
			[path.join(records, "proposal.json"), canonicalDynamicDocument(record)],
		] as const) {
			expect(await readFile(target)).toEqual(content);
			expect((await stat(target)).mode & 0o777).toBe(0o600);
		}
		expect(await readFile(path.join(records, "proposal.json"), "utf8")).toBe(
			`${canonicalArtifactJson(record).toString("utf8")}\n`,
		);
		expect(result.proposal.record).toEqual(record);
		expect(result.proposal.source).toBe(linearSource);
		expect(Object.isFrozen(result.proposal.record.manifest)).toBe(true);
		expect(await store.read(sha)).toEqual(result.proposal);
		expect(await store.count()).toBe(1);
	});

	it("is idempotent for the same digest under the same host API", async () => {
		const { store, record } = await fixture();
		const first = await store.put({ source: linearSource, record });
		const second = await store.put({
			source: linearSource,
			record: { ...record, proposedAt: "2026-09-16T00:00:00.000Z" },
		});
		expect(second.created).toBe(false);
		expect(second.replaced).toBe(false);
		expect(second.proposal).toEqual(first.proposal);
		const changed = proposalRecord(linearSource, "d".repeat(64));
		await expect(
			store.put({
				source: linearSource,
				record: {
					...changed,
					manifest: {
						...manifest,
						meta: { ...manifest.meta, description: "changed" },
					},
					manifestSha256: deriveJsonValueSha256({
						...manifest,
						meta: { ...manifest.meta, description: "changed" },
					}),
					definitionIdentitySha256: deriveDynamicDefinitionIdentitySha256({
						sourceSha256: changed.sourceSha256,
						hostApiSha256: changed.hostApiSha256,
						manifestSha256: deriveJsonValueSha256({
							...manifest,
							meta: { ...manifest.meta, description: "changed" },
						}),
					}),
				},
			}),
		).rejects.toThrow(
			"dynamic workflow proposal manifest differs from the stored manifest",
		);
	});

	it("rewrites proposal.json when the host API changed and keeps the source", async () => {
		const { store, record, sha } = await fixture();
		const staleHostApi = "0".repeat(64);
		const stale = {
			...record,
			hostApiSha256: staleHostApi,
			definitionIdentitySha256: deriveDynamicDefinitionIdentitySha256({
				sourceSha256: record.sourceSha256,
				manifestSha256: record.manifestSha256,
				hostApiSha256: staleHostApi,
			}),
		};
		const first = await store.put({ source: linearSource, record: stale });
		expect(first.created).toBe(true);
		// A decision of the previous identity stays on disk (D8).
		const decisions = first.proposal.decisionsDirectory;
		await mkdir(decisions, { mode: 0o700 });
		await writeFile(path.join(decisions, "keep.json"), "{}\n");
		const replaced = await store.put({ source: linearSource, record });
		expect(replaced.created).toBe(false);
		expect(replaced.replaced).toBe(true);
		expect(replaced.proposal.record).toEqual(record);
		const directory = path.join(store.root, sha);
		const version = path.basename(replaced.proposal.recordsDirectory);
		expect(replaced.proposal.recordsDirectory).not.toBe(
			first.proposal.recordsDirectory,
		);
		expect(await readFile(path.join(directory, "current"), "utf8")).toBe(
			`${version}\n`,
		);
		expect(
			await readFile(
				path.join(replaced.proposal.recordsDirectory, "proposal.json"),
			),
		).toEqual(canonicalDynamicDocument(record));
		expect(
			await readFile(path.join(directory, "source.workflow.ts"), "utf8"),
		).toBe(linearSource);
		expect(await readFile(path.join(decisions, "keep.json"), "utf8")).toBe(
			"{}\n",
		);
		// The superseded pair is reaped lazily, by the next replacement, so a
		// reader that resolved the old pointer still finds its files.
		expect(
			await readFile(
				path.join(first.proposal.recordsDirectory, "proposal.json"),
			),
		).toEqual(canonicalDynamicDocument(stale));
		const third = proposalRecord(linearSource, "e".repeat(64));
		const other = {
			...third,
			hostApiSha256: "1".repeat(64),
			definitionIdentitySha256: deriveDynamicDefinitionIdentitySha256({
				sourceSha256: third.sourceSha256,
				manifestSha256: third.manifestSha256,
				hostApiSha256: "1".repeat(64),
			}),
		};
		const again = await store.put({ source: linearSource, record: other });
		expect(again.replaced).toBe(true);
		await expect(stat(first.proposal.recordsDirectory)).rejects.toThrow();
		expect(await readFile(path.join(directory, "current"), "utf8")).toBe(
			`${path.basename(again.proposal.recordsDirectory)}\n`,
		);
		expect(await store.count()).toBe(1);
	});

	it("swaps the record pair atomically and repairs an inconsistent one", async () => {
		const { store, record, sha } = await fixture();
		const staleHostApi = "0".repeat(64);
		const stale = {
			...record,
			hostApiSha256: staleHostApi,
			definitionIdentitySha256: deriveDynamicDefinitionIdentitySha256({
				sourceSha256: record.sourceSha256,
				manifestSha256: record.manifestSha256,
				hostApiSha256: staleHostApi,
			}),
		};
		const first = await store.put({ source: linearSource, record: stale });
		const directory = path.join(store.root, sha);
		const pointer = path.join(directory, "current");
		const oldVersion = path.basename(first.proposal.recordsDirectory);
		const newVersion = "f".repeat(32);
		const staged = path.join(directory, "records", newVersion);
		// Crash prefix 1: the new pair is staged, `current` still names the old
		// one. Readers see the old pair.
		await mkdir(staged, { mode: 0o700 });
		await writeFile(
			path.join(staged, "manifest.json"),
			canonicalDynamicDocument(record.manifest),
		);
		await writeFile(
			path.join(staged, "proposal.json"),
			canonicalDynamicDocument(record),
		);
		expect((await store.read(sha))?.record).toEqual(stale);
		// Crash prefix 2: `current` was swapped. Readers see the new pair; the
		// old one is still on disk and harmless.
		await writeFile(pointer, `${newVersion}\n`);
		const swapped = await store.read(sha);
		expect(swapped?.record).toEqual(record);
		expect(swapped?.recordsDirectory).toBe(staged);
		expect(
			await readFile(
				path.join(directory, "records", oldVersion, "proposal.json"),
			),
		).toEqual(canonicalDynamicDocument(stale));
		// A dangling or malformed pointer fails closed; `put` of the same bytes
		// rebuilds the pair instead of failing forever.
		await writeFile(pointer, `${"a".repeat(32)}\n`);
		await expect(store.read(sha)).rejects.toThrow(
			"invalid dynamic workflow proposal record",
		);
		await expect(store.list()).resolves.toEqual([
			{
				ref: `dynamic:${sha}`,
				issue: "invalid dynamic workflow proposal record",
			},
		]);
		let repaired = await store.put({ source: linearSource, record });
		expect(repaired.created).toBe(false);
		expect(repaired.replaced).toBe(true);
		expect(repaired.proposal.record).toEqual(record);
		expect((await store.read(sha))?.record).toEqual(record);
		await writeFile(pointer, "not a version\n");
		await expect(store.read(sha)).rejects.toThrow(
			"invalid dynamic workflow proposal record",
		);
		await writeFile(pointer, "a".repeat(32));
		await expect(store.read(sha)).rejects.toThrow(
			"invalid dynamic workflow proposal record",
		);
		// An edited record in the current pair is inconsistent: read fails
		// closed, put rebuilds.
		repaired = await store.put({ source: linearSource, record });
		expect(repaired.replaced).toBe(true);
		await writeFile(
			path.join(repaired.proposal.recordsDirectory, "proposal.json"),
			canonicalDynamicDocument({ ...record, manifestSha256: "0".repeat(64) }),
		);
		await expect(store.read(sha)).rejects.toThrow(
			"dynamic workflow manifest digest mismatch",
		);
		repaired = await store.put({ source: linearSource, record });
		expect(repaired.replaced).toBe(true);
		expect((await store.read(sha))?.record).toEqual(record);
		// Repair never rewrites source bytes: with the source itself altered,
		// put fails closed with the read failure.
		await writeFile(
			path.join(directory, "source.workflow.ts"),
			`${linearSource}\n`,
		);
		await expect(store.put({ source: linearSource, record })).rejects.toThrow(
			"invalid dynamic workflow proposal record",
		);
		await writeFile(path.join(directory, "source.workflow.ts"), linearSource);
		expect((await store.read(sha))?.record).toEqual(record);
		expect(await store.count()).toBe(1);
	});

	it("never lets a concurrent read observe a mixed pair while the host API rewrite runs", async () => {
		const { store, record, sha } = await fixture();
		const staleHostApi = "0".repeat(64);
		const stale = {
			...record,
			hostApiSha256: staleHostApi,
			definitionIdentitySha256: deriveDynamicDefinitionIdentitySha256({
				sourceSha256: record.sourceSha256,
				manifestSha256: record.manifestSha256,
				hostApiSha256: staleHostApi,
			}),
		};
		await store.put({ source: linearSource, record: stale });
		let settled = false;
		const replacement = store
			.put({ source: linearSource, record })
			.finally(() => {
				settled = true;
			});
		const seen = new Set<string>();
		let reads = 0;
		while (!settled) {
			const proposal = await store.read(sha);
			if (proposal === undefined) throw new Error("proposal vanished");
			seen.add(proposal.record.hostApiSha256);
			reads += 1;
		}
		expect((await replacement).replaced).toBe(true);
		expect(reads).toBeGreaterThan(0);
		expect(
			[...seen].every((h) => h === staleHostApi || h === record.hostApiSha256),
		).toBe(true);
		expect((await store.read(sha))?.record).toEqual(record);
	});

	it("refuses inconsistent records before touching the store", async () => {
		const { store, record } = await fixture();
		await expect(
			store.put({ source: `${linearSource}\n`, record }),
		).rejects.toThrow("dynamic workflow source digest mismatch");
		await expect(
			store.put({
				source: linearSource,
				record: { ...record, manifestSha256: "0".repeat(64) },
			}),
		).rejects.toThrow("dynamic workflow manifest digest mismatch");
		await expect(
			store.put({
				source: linearSource,
				record: { ...record, schema: "nope" } as never,
			}),
		).rejects.toThrow("invalid dynamic workflow proposal record");
		expect(await store.count()).toBe(0);
		expect(() => store.directoryFor("nope")).toThrow(
			"invalid dynamic workflow source digest",
		);
	});

	it("returns undefined for unknown digests and refuses corrupt records", async () => {
		const { store, record, sha } = await fixture();
		expect(await store.read("f".repeat(64))).toBeUndefined();
		const { proposal } = await store.put({ source: linearSource, record });
		const directory = path.join(store.root, sha);
		const proposalPath = path.join(proposal.recordsDirectory, "proposal.json");
		await writeFile(proposalPath, JSON.stringify(record, null, 2));
		await expect(store.read(sha)).rejects.toThrow(
			"dynamic workflow record is not canonical",
		);
		await writeFile(
			proposalPath,
			canonicalDynamicDocument({ ...record, contractRevision: 18 }),
		);
		await expect(store.read(sha)).rejects.toThrow(
			"invalid dynamic workflow proposal record",
		);
		await writeFile(
			proposalPath,
			canonicalDynamicDocument({ ...record, manifestSha256: "0".repeat(64) }),
		);
		await expect(store.read(sha)).rejects.toThrow(
			"dynamic workflow manifest digest mismatch",
		);
		// The identity is recomputed on read as it is on put: an edited
		// identity string with intact digests is refused.
		await writeFile(
			proposalPath,
			canonicalDynamicDocument({
				...record,
				definitionIdentitySha256: "0".repeat(64),
			}),
		);
		await expect(store.read(sha)).rejects.toThrow(
			"dynamic workflow manifest digest mismatch",
		);
		await writeFile(proposalPath, canonicalDynamicDocument(record));
		expect((await store.read(sha))?.record).toEqual(record);
		const manifestPath = path.join(proposal.recordsDirectory, "manifest.json");
		await writeFile(
			manifestPath,
			canonicalDynamicDocument({
				...manifest,
				meta: { ...manifest.meta, version: 2 },
			}),
		);
		await expect(store.read(sha)).rejects.toThrow(
			"dynamic workflow manifest digest mismatch",
		);
		await writeFile(manifestPath, canonicalDynamicDocument(manifest));
		await writeFile(
			path.join(directory, "source.workflow.ts"),
			`${linearSource}\n`,
		);
		await expect(store.read(sha)).rejects.toThrow(
			"invalid dynamic workflow proposal record",
		);
		await writeFile(
			path.join(directory, "source.workflow.ts"),
			linearSource.replace("answer", "answeR"),
		);
		await expect(store.read(sha)).rejects.toThrow(
			"dynamic workflow source digest mismatch",
		);
		await writeFile(
			path.join(directory, "source.workflow.ts"),
			Buffer.concat([
				Buffer.from(linearSource.slice(0, -2)),
				Buffer.from([0xff, 0xfe]),
			]),
		);
		await expect(store.read(sha)).rejects.toThrow(
			"dynamic workflow record is not valid UTF-8",
		);
	});

	it("refuses symlinked records and directories", async () => {
		const { store, record, sha } = await fixture();
		await store.put({ source: linearSource, record });
		const directory = path.join(store.root, sha);
		const elsewhere = path.join(path.dirname(store.root), "elsewhere.ts");
		await writeFile(elsewhere, linearSource);
		const sourcePath = path.join(directory, "source.workflow.ts");
		await writeFile(sourcePath, "");
		const { rm } = await import("node:fs/promises");
		await rm(sourcePath);
		await symlink(elsewhere, sourcePath);
		await expect(store.read(sha)).rejects.toThrow(
			"dynamic workflow record may not be a symlink",
		);
		const other = "e".repeat(64);
		await symlink(directory, path.join(store.root, other));
		await expect(store.read(other)).rejects.toThrow(
			"dynamic workflow record may not be a symlink",
		);
		const listing = await store.list();
		expect(listing).toEqual([
			{
				ref: `dynamic:${sha}`,
				issue: "dynamic workflow record may not be a symlink",
			},
		]);
	});

	it("lists proposals sorted with issues for corrupt entries", async () => {
		const { store, record } = await fixture();
		const second = `${linearSource}// two\n`;
		const third = `${linearSource}// three\n`;
		const records = [record, proposalRecord(second), proposalRecord(third)];
		const sources = [linearSource, second, third];
		const stored = [];
		for (const [index, entry] of records.entries()) {
			stored.push(
				await store.put({ source: sources[index] as string, record: entry }),
			);
		}
		await mkdir(path.join(store.root, "not-a-digest"));
		await writeFile(
			path.join(store.root, "0".repeat(64)),
			"file, not a directory",
		);
		await writeFile(
			path.join(stored[2]?.proposal.recordsDirectory ?? "", "proposal.json"),
			"{}",
		);
		const listing = await store.list();
		const sorted = records.map((entry) => entry.sourceSha256).sort();
		expect(listing.map((entry) => entry.ref)).toEqual(
			sorted.map((sha) => `dynamic:${sha}`),
		);
		for (const entry of listing) {
			if (entry.ref === `dynamic:${records[2]?.sourceSha256}`) {
				expect(entry).toEqual({
					ref: entry.ref,
					issue: "dynamic workflow record is not canonical",
				});
			} else {
				expect("proposal" in entry).toBe(true);
			}
		}
		expect(await store.count()).toBe(3);
	});

	it("caps the store at MAX_DYNAMIC_PROPOSALS digests", async () => {
		const { store, record } = await fixture();
		await Promise.all(
			Array.from({ length: MAX_DYNAMIC_PROPOSALS }, (_, index) =>
				mkdir(
					path.join(
						store.root,
						createHash("sha256").update(String(index)).digest("hex"),
					),
				),
			),
		);
		expect(await store.count()).toBe(MAX_DYNAMIC_PROPOSALS);
		const error = await store
			.put({ source: linearSource, record })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(WorkflowDynamicStoreFullError);
		expect(error).toBeInstanceOf(WorkflowDynamicStoreError);
		expect((error as Error).message).toBe(
			"dynamic workflow proposal store is full",
		);
		expect(await store.read(record.sourceSha256)).toBeUndefined();
	});

	it("serializes concurrent puts of one digest", async () => {
		const { store, record } = await fixture();
		const results = await Promise.all([
			store.put({ source: linearSource, record }),
			store.put({ source: linearSource, record }),
			store.put({ source: linearSource, record }),
		]);
		expect(results.map((result) => result.created)).toEqual([
			true,
			false,
			false,
		]);
		expect(await store.count()).toBe(1);
	});
});
