import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "commit-msg.mjs");
const dir = mkdtempSync(join(tmpdir(), "commit-msg-"));
let count = 0;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The hook's contract is the exit status and what it prints, so the tests
// drive the script exactly as git does: with the path of a message file.
function run(message: string) {
	const file = join(dir, `MSG_${count++}`);
	writeFileSync(file, message);
	const result = spawnSync(process.execPath, [SCRIPT, file], {
		encoding: "utf8",
	});
	return { status: result.status, stderr: result.stderr };
}

describe("commit-msg hook", () => {
	it.each([
		"feat: add a thing",
		"fix(core): handle the empty case",
		"feat!: drop the old flag",
		"chore(maestro)!: bump the contract",
		"refactor: x",
		"docs: a",
		"test: a",
		"style: a",
		"perf: a",
		"ci: a",
		"build: a",
		`feat: ${"a".repeat(72)}`,
		"feat: subject\n\nA body line that is far longer than seventy-two characters is never checked.\n\nClaude-Session: https://example.com/x",
	])("accepts %j", (message) => {
		expect(run(message)).toEqual({ status: 0, stderr: "" });
	});

	it.each([
		"Merge branch 'main' into feature",
		"fixup! feat: add a thing",
		"squash! anything at all",
		'Revert "feat: add a thing"',
		"",
		"# only a comment\n",
	])("passes %j through unchecked", (message) => {
		expect(run(message).status).toBe(0);
	});

	it("ignores comment lines before the header", () => {
		expect(run("# Please enter the message\nfix: real header\n").status).toBe(
			0,
		);
		expect(run("# fix: looks valid\nbad header\n").status).toBe(1);
	});

	it.each([
		"feature: add a thing",
		"Fix: add a thing",
		"wip: add a thing",
		"chore(): empty scope",
		"chore(a b): spaced scope",
		"feat:missing space",
		"feat:  leading space",
		"feat !: misplaced bang",
		"add a thing",
	])("rejects %j as malformed", (message) => {
		const result = run(message);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`rejected header: ${message}`);
		expect(result.stderr).toContain("type(scope): subject");
		expect(result.stderr).toContain("example: feat(scope): add the thing");
	});

	it("rejects a subject over 72 characters", () => {
		const message = `feat(core): ${"a".repeat(73)}`;
		const result = run(message);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`rejected header: ${message}`);
		expect(result.stderr).toContain("at most 72 characters (is 73)");
	});
});
