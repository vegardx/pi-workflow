/**
 * The one refusal type of `@vegardx/pi-workflow/components`.
 *
 * A component refuses at DECLARATION time: the throw happens while the source
 * function is building its requests, before the materializer sees anything, so
 * a misuse never becomes a persisted task and never reaches a replay. The
 * runtime's own refusals keep their own type (`WorkflowMaterializationError`)
 * and their own messages; this one names a library rule the runtime cannot
 * check, such as "a gate the session cannot ask field by field".
 */
export class WorkflowComponentError extends Error {
	/** The component that refused: `"gate"`, `"envelope"`, and so on. */
	readonly component: string;

	constructor(component: string, message: string) {
		super(message);
		this.name = "WorkflowComponentError";
		this.component = component;
	}
}
