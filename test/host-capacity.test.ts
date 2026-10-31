import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	readWorkflowJournalUnleased,
	type WorkflowJournalEvent,
} from "../src/persistence/journal.js";
import { WorkflowRunRecordStore } from "../src/run-record.js";
import {
	createWorkflowService,
	type WorkflowService,
	WorkflowServiceError,
} from "../src/service.js";
import {
	ANSWER_SCHEMA,
	agentBody,
	attemptProvider,
	COMPLETED,
	root,
} from "./fixtures/attempt-provider.js";

// pi-subagent 0.20.0 publishes the host's concurrent VM slots, shared by every
// seat and every run. A run whose definition fans out wider than that is
// clamped to the slots at creation, so its scheduler does not start attempts
// that could only queue inside pi-subagent's slot wait.

const services: WorkflowService[] = [];

afterEach(async () => {
	while (services.length > 0) await services.pop()?.shutdown();
});

function fanOut(name: string, concurrency: number): string {
	return `export default {
  schema: "pi-workflow-definition",
  meta: { name: ${JSON.stringify(name)}, description: "Fan-out", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 3600000, concurrency: ${concurrency} },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: ${ANSWER_SCHEMA},
  async run(ctx) {
    const a = ${agentBody("a")};
    const b = ${agentBody("b")};
    const c = ${agentBody("c")};
    const [ra] = await ctx.results([a, b, c]);
    return { answer: ra.answer };
  }
};
`;
}

function nesting(name: string, child: string, concurrency: number): string {
	return `export default {
  schema: "pi-workflow-definition",
  meta: { name: ${JSON.stringify(name)}, description: "Nests a fan-out", version: 1, budget: { cost: 1000, childRuntimeMs: 3600000 }, timeoutMs: 3600000, concurrency: ${concurrency} },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: ${ANSWER_SCHEMA},
  async run(ctx) {
    const child = ctx.workflow("child", { workflow: ${JSON.stringify(child)}, input: {} });
    const [result] = await ctx.results([child]);
    return { answer: result.answer };
  }
};
`;
}

async function project(files: Record<string, string>) {
	const base = root("capacity");
	const cwd = path.join(base, "project");
	const workflows = path.join(cwd, "workflows");
	await mkdir(workflows, { recursive: true });
	for (const [name, source] of Object.entries(files)) {
		await writeFile(path.join(workflows, `${name}.workflow.ts`), source);
	}
	return {
		cwd,
		agentDir: path.join(base, "agent"),
		storeRoot: path.join(cwd, "state"),
	};
}

async function serviceOn(
	fixture: Awaited<ReturnType<typeof project>>,
	delegated: ReturnType<typeof attemptProvider>,
): Promise<WorkflowService> {
	const service = await createWorkflowService({
		...fixture,
		projectTrusted: () => true,
		subagents: delegated.provider,
	});
	services.push(service);
	return service;
}

/**
 * Holds every child's `wait` until released and records how many children
 * were in flight at once: the scheduler's real fan-out, not its declaration.
 */
function gate(delegated: ReturnType<typeof attemptProvider>) {
	const wait = vi.mocked(delegated.ownerClient.wait);
	const settle = wait.getMockImplementation();
	if (!settle) throw new Error("the fixture's wait has no implementation");
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	const counts = { inFlight: 0, peak: 0 };
	wait.mockImplementation(async (...args) => {
		counts.inFlight += 1;
		counts.peak = Math.max(counts.peak, counts.inFlight);
		await opened;
		counts.inFlight -= 1;
		return settle(...args);
	});
	return { counts, open };
}

async function events(
	storeRoot: string,
	runId: string,
): Promise<readonly WorkflowJournalEvent[]> {
	return (await readWorkflowJournalUnleased(storeRoot, runId)).events;
}

async function runCreated(storeRoot: string, runId: string) {
	const first = (await events(storeRoot, runId))[0];
	if (first?.type !== "run-created") throw new Error("no run-created event");
	return first.data as { concurrencyClamp?: unknown };
}

async function recordConcurrency(
	storeRoot: string,
	runId: string,
): Promise<number> {
	const record = await WorkflowRunRecordStore.readFrom(
		path.join(storeRoot, "runs", runId),
		runId as never,
	);
	return record.concurrency;
}

async function fanOutAgainst(maxSlots: number) {
	const fixture = await project({ wide: fanOut("wide", 8) });
	const delegated = attemptProvider([COMPLETED], { maxSlots });
	const held = gate(delegated);
	const service = await serviceOn(fixture, delegated);
	const { runId } = await service.run("wide", {});
	return { fixture, delegated, held, service, runId };
}

describe("host VM slots", () => {
	it("clamps a definition's concurrency to the host's slots and starts no more children than that", async () => {
		const { fixture, delegated, held, service, runId } = await fanOutAgainst(2);

		try {
			await vi.waitFor(() => expect(held.counts.inFlight).toBe(2), {
				// A poll bound, not an allowance: each launch is fsync-bound on CI.
				timeout: 30_000,
			});
			// Give the scheduler every chance to start the third child early.
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(delegated.ownerClient.launch).toHaveBeenCalledTimes(2);
		} finally {
			held.open();
		}
		const finished = await service.wait(runId);
		expect(finished.status).toBe("completed");
		expect(delegated.ownerClient.launch).toHaveBeenCalledTimes(3);
		expect(held.counts.peak).toBe(2);

		expect(await recordConcurrency(fixture.storeRoot, runId)).toBe(2);
		expect(await runCreated(fixture.storeRoot, runId)).toMatchObject({
			concurrencyClamp: { concurrency: 8, maxSlots: 2 },
		});
		const logs = await service.logs(runId);
		const clamps = logs.entries.filter((entry) =>
			entry.message.startsWith("Concurrency clamped"),
		);
		expect(clamps).toEqual([
			expect.objectContaining({
				kind: "run",
				message:
					"Concurrency clamped from 8 to 2: the host has 2 VM slots, shared by every run.",
			}),
		]);
	});

	it("leaves a definition that fits the host's slots unclamped and unlogged", async () => {
		const { fixture, held, service, runId } = await fanOutAgainst(16);

		try {
			await vi.waitFor(() => expect(held.counts.inFlight).toBe(3), {
				// A poll bound, not an allowance: each launch is fsync-bound on CI.
				timeout: 30_000,
			});
		} finally {
			held.open();
		}
		expect((await service.wait(runId)).status).toBe("completed");

		expect(await recordConcurrency(fixture.storeRoot, runId)).toBe(8);
		expect(await runCreated(fixture.storeRoot, runId)).not.toHaveProperty(
			"concurrencyClamp",
		);
		const logs = await service.logs(runId);
		expect(
			logs.entries.some((entry) =>
				entry.message.startsWith("Concurrency clamped"),
			),
		).toBe(false);
	});

	it("clamps a nested run on its own: the slots are host-wide, not partitioned", async () => {
		const fixture = await project({
			parent: nesting("parent", "fan-child", 8),
			"fan-child": fanOut("fan-child", 8),
		});
		const delegated = attemptProvider([COMPLETED], { maxSlots: 2 });
		const service = await serviceOn(fixture, delegated);
		const { runId } = await service.run("parent", {});
		expect((await service.wait(runId)).status).toBe("completed");

		const childRunId = (await events(fixture.storeRoot, runId))
			.map((event) => (event.data as { childRunId?: string }).childRunId)
			.find((id) => id !== undefined);
		if (!childRunId) throw new Error("the parent journalled no child run");

		expect(await recordConcurrency(fixture.storeRoot, runId)).toBe(2);
		expect(await recordConcurrency(fixture.storeRoot, childRunId)).toBe(2);
		expect(await runCreated(fixture.storeRoot, childRunId)).toMatchObject({
			concurrencyClamp: { concurrency: 8, maxSlots: 2 },
		});
	});

	it("refuses a binding that reports no valid slot count before the run exists", async () => {
		const fixture = await project({ wide: fanOut("wide", 8) });
		const delegated = attemptProvider([COMPLETED], { maxSlots: 0 });
		const service = await serviceOn(fixture, delegated);

		const refusal = await service.run("wide", {}).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(refusal).toBeInstanceOf(WorkflowServiceError);
		expect(refusal).toMatchObject({
			code: "validation",
			message: "The subagent binding reports no valid host VM slot count.",
		});
		expect(delegated.ownerClient.launch).not.toHaveBeenCalled();
	});
});
