import {
	type DelegatedTask,
	MAX_RESUME_MESSAGE_BYTES,
} from "@vegardx/pi-subagent";

/**
 * A continuation is an agent task that runs as the next attempt of another
 * task's child run (`request.continueFrom`, revision 24): pi-subagent resumes
 * that run's session in a worktree checked out at its latest hand-off
 * (`resume(runId, { continueFromHandoff: true, message })`, feature
 * `resumeAtHandoff`). The child reruns its own launch plan, so the only thing
 * the continuation adds is one user message: this rendering of its delegated
 * task. Task inputs are data and order dependencies of the continuation; they
 * are not projected into the message.
 */

/** The bound pi-subagent places on a resume message, re-exported for authors. */
export const MAX_CONTINUATION_MESSAGE_BYTES = MAX_RESUME_MESSAGE_BYTES;

/** The one user message a continuation sends: goal, context, instructions. */
export function renderContinuationMessage(task: DelegatedTask): string {
	return [
		task.goal,
		...(task.context.length > 0 ? ["", "Context:", ...task.context] : []),
		"",
		"Instructions:",
		...task.instructions.map((instruction) => `- ${instruction}`),
	].join("\n");
}

/** True when the rendered message fits pi-subagent's bound. */
export function continuationMessageFits(task: DelegatedTask): boolean {
	return (
		Buffer.byteLength(renderContinuationMessage(task), "utf8") <=
		MAX_CONTINUATION_MESSAGE_BYTES
	);
}
