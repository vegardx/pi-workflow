import { canonicalSha256 } from "@vegardx/pi-subagent";
import { ReviewsRecordSchema } from "./components/review-record.js";
import { defineSupportTask, type SupportTaskRegistration } from "./support.js";

/**
 * `pi-workflow/reviews-record`: the builtin support task that commits a
 * review record a definition computed as a task artifact.
 *
 * A definition merges its lenses' findings on a deterministic rail
 * (`clusterFindings`, `applyModelMerges`, `withDispositions`), but a value
 * computed inside `run` is not an artifact, and a gate, a downstream task and
 * a receipt read artifacts. This task is the bridge: its parameters ARE the
 * record, validated against `ReviewsRecordSchema` at declaration, and its
 * execution returns them unchanged. It reads no input, touches no file and
 * holds no authority beyond writing its own output, which is why it is the one
 * implementation this package ships (`BUILTIN_SUPPORT_TASKS`).
 */
export const REVIEWS_RECORD_SUPPORT_NAME = "pi-workflow/reviews-record";
const REVISION = 2;

export const reviewsRecordTask = defineSupportTask({
	name: REVIEWS_RECORD_SUPPORT_NAME,
	moduleSpecifier: "@vegardx/pi-workflow",
	revision: REVISION,
	implementationSha256: canonicalSha256({
		name: REVIEWS_RECORD_SUPPORT_NAME,
		revision: REVISION,
		behaviour: "returns its parameters unchanged",
	}),
	parametersSchema: ReviewsRecordSchema,
	outputSchema: ReviewsRecordSchema,
});

export const reviewsRecordRegistration: SupportTaskRegistration =
	reviewsRecordTask.registration(({ parameters }) => parameters);
