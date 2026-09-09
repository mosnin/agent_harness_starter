/**
 * The typed edit vocabulary for conversational storyboard refinement.
 *
 * A note like "tighter on shot 2" is never applied as free text: it is interpreted into one of
 * these operations, parsed, applied by a pure function, and re-validated against the editorial
 * rules before anything is returned.
 */

import { z } from "zod";
import { BackgroundSchema, type Storyboard, TransitionSchema } from "../runner/protocol";

export const ShotTargetSchema = z.discriminatedUnion("by", [
	z.object({ by: z.literal("id"), shotId: z.string().min(1) }),
	z.object({ by: z.literal("index"), index: z.number().int().min(1) }),
	z.object({ by: z.literal("ordinal"), ordinal: z.enum(["first", "last"]) }),
]);
export type ShotTarget = z.infer<typeof ShotTargetSchema>;

export const AdjustmentMagnitudeSchema = z.enum(["slight", "moderate", "strong"]);
export type AdjustmentMagnitude = z.infer<typeof AdjustmentMagnitudeSchema>;

export const AdjustmentDirectionSchema = z.enum(["increase", "decrease"]);
export type AdjustmentDirection = z.infer<typeof AdjustmentDirectionSchema>;

/**
 * How much to move a knob. `relative` is the interesting case: it carries an intent
 * ("tighter", "a lot longer") and is resolved against the value the shot already has, so the same
 * note lands differently on a shot at 1.0 zoom and one at 1.6. `absolute` and `scale` carry a
 * number, which is never trusted: both are clamped and every clamp is reported.
 */
export const AdjustmentSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("relative"),
		direction: AdjustmentDirectionSchema,
		magnitude: AdjustmentMagnitudeSchema,
	}),
	z.object({ kind: z.literal("scale"), factor: z.number() }),
	z.object({ kind: z.literal("absolute"), value: z.number() }),
]);
export type Adjustment = z.infer<typeof AdjustmentSchema>;

export const PoseAxisSchema = z.enum(["tiltX", "tiltY", "rotateX", "rotateY", "roll"]);
export type PoseAxis = z.infer<typeof PoseAxisSchema>;

export const SpanEdgeSchema = z.enum(["start", "end"]);
export type SpanEdge = z.infer<typeof SpanEdgeSchema>;

export const EditSchema = z.discriminatedUnion("op", [
	z.object({ op: z.literal("adjustZoom"), target: ShotTargetSchema, amount: AdjustmentSchema }),
	z.object({
		op: z.literal("adjustPoseAxis"),
		target: ShotTargetSchema,
		axis: PoseAxisSchema,
		amount: AdjustmentSchema,
	}),
	z.object({
		op: z.literal("adjustSpan"),
		target: ShotTargetSchema,
		edge: SpanEdgeSchema,
		amount: AdjustmentSchema,
	}),
	z.object({ op: z.literal("setAim"), target: ShotTargetSchema, beatId: z.string().min(1).nullable() }),
	z.object({ op: z.literal("setTransition"), target: ShotTargetSchema, transition: TransitionSchema }),
	z.object({
		op: z.literal("adjustTransitionDuration"),
		target: ShotTargetSchema,
		amount: AdjustmentSchema,
	}),
	z.object({ op: z.literal("setBackground"), background: BackgroundSchema }),
	z.object({ op: z.literal("setMusic"), track: z.string().min(1).nullable() }),
	z.object({ op: z.literal("reorderShots"), order: z.array(z.string().min(1)).min(1) }),
]);
export type Edit = z.infer<typeof EditSchema>;

export const EditListSchema = z.array(EditSchema);

export type EditOp = Edit["op"];

/**
 * Issue codes. The first block mirrors `ValidationError` in `hades-director/src/validate.rs`; the
 * second covers failures of the refinement itself, before the editorial rules ever run.
 */
export const REFINE_ISSUE_CODES = [
	"no_shots",
	"too_many_shots",
	"duplicate_shot_id",
	"empty_shot",
	"overlapping_shots",
	"shot_too_short",
	"shot_outside_recording",
	"total_too_long",
	"boundary_not_on_beat",
	"boundary_mid_idle",
	"unknown_aim_beat",
	"non_finite_pose",
	"motion_systems_stacked",
	"mixed_motion_systems",
	"cut_without_content",
	"unresolved_target",
	"not_a_permutation",
	"uninterpretable_note",
	"malformed_edits",
	"no_edits",
] as const;

export type RefineIssueCode = (typeof REFINE_ISSUE_CODES)[number];

export interface RefineIssue {
	code: RefineIssueCode;
	message: string;
	shotId?: string;
	/**
	 * How bad this instance is, in the units of the rule it came from. Only compared against
	 * another issue with the same code and shot, to tell an edit that worsened a pre-existing
	 * violation from one that merely left it alone.
	 */
	severity?: number;
}

/** A number the caller asked for that was pulled back to a bound, recorded rather than swallowed. */
export interface ClampNote {
	path: string;
	requested: number;
	applied: number;
	bound: "min" | "max";
}

export interface DiffChange {
	path: string;
	before: string;
	after: string;
}

export interface StoryboardDiff {
	changes: DiffChange[];
}

export interface RefinementBase {
	edits: Edit[];
	diff: StoryboardDiff;
	clamps: ClampNote[];
}

export interface RefinementApplied extends RefinementBase {
	status: "applied";
	storyboard: Storyboard;
	/** Rules the input storyboard already broke and this edit neither caused nor worsened. */
	carriedOver: RefineIssue[];
}

export interface RefinementPreview extends RefinementBase {
	status: "preview";
	storyboard: Storyboard;
	carriedOver: RefineIssue[];
}

export interface RefinementRejected extends RefinementBase {
	status: "rejected";
	reason: string;
	issues: RefineIssue[];
}

export type RefinementOutcome = RefinementApplied | RefinementPreview | RefinementRejected;
