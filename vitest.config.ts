import { defineConfig } from "vitest/config";

// Journal, artifact, and lease tests are fsync-bound. On Ubuntu CI every
// heavy file ran four to eight times slower than locally and a third slower
// again between identical runs (runs 34819667769 and 34820196853), so tests
// that take one to two seconds locally routinely exceeded the 5 s default.
// Timeouts are safety nets, not assertions; one suite-wide bound replaces
// the per-test load allowances.
export default defineConfig({
	test: {
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
});
