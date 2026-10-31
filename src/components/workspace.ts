import type { TaskKey } from "../contracts-core.js";
import type { WorkspaceAuthoringRequest } from "../definition.js";
import { WorkflowComponentError } from "./errors.js";

/**
 * The caller's workspace, started at the handoff the component wires under
 * `input`: the host checks it out at that hand-off's commit, so the change is
 * already in the tree when the agent starts. The start is the component's to
 * own; a caller that names another input is refused rather than overwritten.
 */
export function startAtHandoff<TWorkspace extends WorkspaceAuthoringRequest>(
	component: string,
	label: string,
	workspace: TWorkspace,
	input: TaskKey,
): TWorkspace {
	if (
		workspace.startAtInput !== undefined &&
		workspace.startAtInput !== input
	) {
		throw new WorkflowComponentError(
			component,
			`${label} starts its workspace at ${JSON.stringify(workspace.startAtInput)}, but the component starts it at the handoff it wires as ${JSON.stringify(input)}.`,
		);
	}
	return { ...workspace, startAtInput: input };
}
