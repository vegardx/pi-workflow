import { acquireWorkflowRunLease } from "../../src/persistence/run-lease.js";

const root = process.argv[2];
const runId = process.argv[3] as `workflow_${string}` | undefined;
if (!root || !runId) throw new Error("expected lease root and workflow run ID");

const lease = await acquireWorkflowRunLease({
	storeRoot: root,
	runId,
	ownerId: "lease-worker",
});
process.stdout.write(`${JSON.stringify(lease.record)}\n`);
setInterval(() => {}, 60_000);
