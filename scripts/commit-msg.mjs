import { readFileSync } from "node:fs";
import process from "node:process";

// The rule lives in the workspace AGENTS.md; this script is its enforcement.
const TYPES = [
	"feat",
	"fix",
	"refactor",
	"docs",
	"chore",
	"test",
	"style",
	"perf",
	"ci",
	"build",
];
const HEADER = new RegExp(`^(${TYPES.join("|")})(\\([^()\\s]+\\))?!?: \\S.*$`);
const MAX_SUBJECT = 72;
const EXAMPLE = "feat(scope): add the thing";

// Git writes these itself, or aborts on them, so they are not ours to judge.
const PASS_THROUGH = [/^Merge /, /^fixup! /, /^squash! /, /^Revert "/];

/** @param {string} message */
function header(message) {
	for (const line of message.split("\n")) {
		if (line.startsWith("#")) continue;
		const trimmed = line.trimEnd();
		if (trimmed !== "") return trimmed;
	}
	return "";
}

/**
 * @param {string} message
 * @returns {{ ok: true } | { ok: false, header: string, rule: string }}
 */
export function validate(message) {
	const line = header(message);
	if (line === "" || PASS_THROUGH.some((pattern) => pattern.test(line))) {
		return { ok: true };
	}
	if (!HEADER.test(line)) {
		return {
			ok: false,
			header: line,
			rule: `header must be "type(scope): subject" with type one of ${TYPES.join(", ")}; scope and "!" are optional`,
		};
	}
	const subject = line.slice(line.indexOf(": ") + 2);
	if (subject.length > MAX_SUBJECT) {
		return {
			ok: false,
			header: line,
			rule: `subject must be at most ${MAX_SUBJECT} characters (is ${subject.length})`,
		};
	}
	return { ok: true };
}

function main() {
	const path = process.argv[2];
	if (!path) {
		console.error("usage: node scripts/commit-msg.mjs <commit-msg-file>");
		process.exit(2);
	}
	const result = validate(readFileSync(path, "utf8"));
	if (result.ok) return;
	console.error(`commit-msg: rejected header: ${result.header}`);
	console.error(`commit-msg: ${result.rule}`);
	console.error(`commit-msg: example: ${EXAMPLE}`);
	process.exit(1);
}

if (import.meta.filename === process.argv[1]) main();
