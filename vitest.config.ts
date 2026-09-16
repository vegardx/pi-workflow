import { statSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

// Journal, artifact, and lease tests are fsync-bound. On Ubuntu CI every
// heavy file ran four to eight times slower than locally and a third slower
// again between identical runs (runs 34819667769 and 34820196853), so tests
// that take one to two seconds locally routinely exceeded the 5 s default.
// Timeouts are safety nets, not assertions; one suite-wide bound replaces
// the per-test load allowances.
//
// CI runs the suite as `--shard=N/4`. Vitest's default sharding hashes each
// path and slices the sorted list into contiguous ranges, so the heavy files
// can land together by chance (run 35107628792: shard 3 took 649 s while
// shard 2 took 170 s). This sequencer orders files by size, a stable proxy
// for their weight, and deals them round-robin so every shard receives an
// even share of the heavy suites. Within a shard the default order applies.
class BalancedShardSequencer extends BaseSequencer {
	override async shard(
		files: TestSpecification[],
	): Promise<TestSpecification[]> {
		const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 };
		const ordered = [...files].sort((left, right) => {
			const bySize =
				statSync(right.moduleId).size - statSync(left.moduleId).size;
			return bySize !== 0 ? bySize : left.moduleId < right.moduleId ? -1 : 1;
		});
		return ordered.filter((_, position) => position % count === index - 1);
	}
}

export default defineConfig({
	test: {
		testTimeout: 60_000,
		hookTimeout: 60_000,
		sequence: { sequencer: BalancedShardSequencer },
	},
});
