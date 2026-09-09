/**
 * Editorial re-validation for a refined storyboard.
 *
 * `src/agents/tools/cap/storyboard.ts` already encodes the limits the Cinematographer plans
 * against, so those checks are reused rather than restated here. What this module adds is the rest
 * of `ValidationError` from `hades-director/src/validate.rs` — the rules a *refinement* can break
 * that a freshly built storyboard cannot: a duplicated id after a reorder, an inverted span after a
 * trim, an aim pointed at a beat that is not in the log, a cut dragged off its content beat.
 *
 * Two of the Rust rules cannot be mirrored from a storyboard alone and take explicit context
 * instead of being guessed at:
 *
 *   `ShotOutsideRecording` needs the measured length of the recorded file, which is not in the
 *   storyboard — pass `recordingDurationMs`.
 *
 *   `MotionSystemsStacked` counts the 2D zoom segments of the *base project configuration* the
 *   compiler is asked to build on (`compile.rs` reads `options.base.timeline.zoom_segments`), not
 *   anything the storyboard carries — pass `zoomSegments`.
 *
 * The boundary rule is checked in source time rather than video time. `align_beats` rebases the
 * log onto the video by a single tail-anchored shift, so the distance between a shot boundary and
 * a beat is the same in both clocks; the mirror is exact except for beats the alignment clamps to
 * the first frame, which this module cannot see.
 */

import type { Beat, BeatKind, EditorialLimits, Shot, Storyboard } from "../runner/protocol";
import { shotDurationMs, storyboardDurationMs, validateStoryboard } from "../tools/cap/storyboard";
import { DEFAULT_EDITORIAL_LIMITS } from "../tools/cap/types";
import type { RefineIssue, RefineIssueCode } from "./types";

/** `BOUNDARY_TOLERANCE_MS` in `hades-director/src/validate.rs`. */
export const BOUNDARY_TOLERANCE_MS = 250;

/** Mirrors `is_content_cut`: idle is the only kind a camera cut may not land on. */
export function isContentCut(kind: BeatKind): boolean {
	return kind !== "idle";
}

export interface EditorialContext {
	limits?: EditorialLimits;
	beats?: Beat[];
	/** Measured length of the recorded file, for `ShotOutsideRecording`. */
	recordingDurationMs?: number;
	boundaryToleranceMs?: number;
	/** 2D zoom segments the base project configuration already carries. */
	zoomSegments?: number;
}

const REUSED_CODES: Record<string, RefineIssueCode> = {
	no_shots: "no_shots",
	too_many_shots: "too_many_shots",
	shot_too_short: "shot_too_short",
	shot_not_ordered: "overlapping_shots",
	total_too_long: "total_too_long",
	cut_without_content: "cut_without_content",
	mixed_motion_systems: "mixed_motion_systems",
};

function poseIsFinite(shot: Shot): boolean {
	const c = shot.camera;
	return [
		c.zoom,
		c.tiltX,
		c.tiltY,
		c.roll,
		c.rotateX,
		c.rotateY,
		c.fov,
		c.focusX,
		c.focusY,
		c.focusSize,
	].every((value) => Number.isFinite(value));
}

function reusedSeverity(
	code: RefineIssueCode,
	storyboard: Storyboard,
	limits: EditorialLimits,
	shotId: string | undefined
): number | undefined {
	if (code === "total_too_long") return storyboardDurationMs(storyboard);
	if (code === "too_many_shots") return storyboard.shots.length;
	if (code === "shot_too_short") {
		const shot = storyboard.shots.find((candidate) => candidate.shotId === shotId);
		return shot ? limits.minShotMs - shotDurationMs(shot) : undefined;
	}
	return undefined;
}

export function validateEditorial(
	storyboard: Storyboard,
	context: EditorialContext = {}
): RefineIssue[] {
	const limits = context.limits ?? DEFAULT_EDITORIAL_LIMITS;
	const tolerance = context.boundaryToleranceMs ?? BOUNDARY_TOLERANCE_MS;
	const issues: RefineIssue[] = [];

	for (const issue of validateStoryboard(storyboard, { limits, beats: context.beats })) {
		const code = REUSED_CODES[issue.code];
		if (!code) continue;
		const mapped: RefineIssue = { code, message: issue.message };
		if (issue.shotId !== undefined) mapped.shotId = issue.shotId;
		const severity = reusedSeverity(code, storyboard, limits, issue.shotId);
		if (severity !== undefined) mapped.severity = severity;
		issues.push(mapped);
	}

	if (storyboard.shots.length === 0) return issues;

	const zoomSegments = context.zoomSegments ?? 0;
	if (zoomSegments > 0) {
		issues.push({
			code: "motion_systems_stacked",
			message: `The project stacks ${zoomSegments} 2D zoom segment(s) on ${storyboard.shots.length} 3D camera shot(s); pick one motion system.`,
			severity: zoomSegments,
		});
	}

	const beats = context.beats;
	const beatIds = new Set((beats ?? []).map((beat) => beat.beatId));
	const contentBeats = (beats ?? []).filter((beat) => isContentCut(beat.kind));
	const seen = new Set<string>();

	storyboard.shots.forEach((shot, index) => {
		if (seen.has(shot.shotId)) {
			issues.push({
				code: "duplicate_shot_id",
				message: `Shot ${shot.shotId} has a duplicate id.`,
				shotId: shot.shotId,
			});
		}
		seen.add(shot.shotId);

		if (!(shot.sourceEndMs > shot.sourceStartMs)) {
			issues.push({
				code: "empty_shot",
				message: `Shot ${shot.shotId} ends at ${shot.sourceEndMs}ms, at or before its start of ${shot.sourceStartMs}ms.`,
				shotId: shot.shotId,
				severity: shot.sourceStartMs - shot.sourceEndMs,
			});
		}

		if (!poseIsFinite(shot)) {
			issues.push({
				code: "non_finite_pose",
				message: `Shot ${shot.shotId} has a non-finite camera pose.`,
				shotId: shot.shotId,
			});
		}

		if (beats !== undefined && shot.aimBeatId != null && !beatIds.has(shot.aimBeatId)) {
			issues.push({
				code: "unknown_aim_beat",
				message: `Shot ${shot.shotId} aims at beat ${shot.aimBeatId}, which is not in the beat log.`,
				shotId: shot.shotId,
			});
		}

		if (context.recordingDurationMs !== undefined) {
			const outside =
				shot.sourceStartMs >= context.recordingDurationMs ||
				shot.sourceEndMs > context.recordingDurationMs;
			if (outside) {
				issues.push({
					code: "shot_outside_recording",
					message: `Shot ${shot.shotId} lands outside the recorded video, which is ${context.recordingDurationMs}ms long.`,
					shotId: shot.shotId,
					severity: shot.sourceEndMs - context.recordingDurationMs,
				});
			}
		}

		if (index === 0 || beats === undefined) return;

		const boundary = shot.sourceStartMs;
		const nearestContent = nearestBeat(contentBeats, boundary);
		if (nearestContent && nearestContent.distance <= tolerance) return;

		const nearestAny = nearestBeat(beats, boundary);
		if (nearestAny && nearestAny.distance <= tolerance && !isContentCut(nearestAny.beat.kind)) {
			issues.push({
				code: "boundary_mid_idle",
				message: `Shot ${shot.shotId} cuts at ${boundary}ms, mid-idle on beat ${nearestAny.beat.beatId}; a camera cut must be a content cut.`,
				shotId: shot.shotId,
				severity: nearestAny.distance,
			});
			return;
		}

		const distance = nearestAny ? nearestAny.distance : Number.POSITIVE_INFINITY;
		issues.push({
			code: "boundary_not_on_beat",
			message: `Shot ${shot.shotId} cuts at ${boundary}ms, ${distance}ms from the nearest beat (tolerance ${tolerance}ms); a camera cut must be a content cut.`,
			shotId: shot.shotId,
			severity: distance,
		});
	});

	return issues;
}

function nearestBeat(beats: Beat[], atMs: number): { beat: Beat; distance: number } | undefined {
	let best: { beat: Beat; distance: number } | undefined;
	for (const beat of beats) {
		const distance = Math.abs(beat.offsetMs - atMs);
		if (best === undefined || distance < best.distance) best = { beat, distance };
	}
	return best;
}

function issueKey(issue: RefineIssue): string {
	return `${issue.code}:${issue.shotId ?? ""}`;
}

/**
 * Which of `after`'s violations this edit is answerable for.
 *
 * A storyboard can arrive already breaking a rule — the Cinematographer's lead-in, for instance,
 * routinely starts a shot further than the boundary tolerance from its beat. Rejecting a note
 * because of damage it did not do is its own kind of lie, so an issue counts as introduced when it
 * is new for that rule and shot, or when it is measurably worse than it was before.
 */
export function introducedIssues(before: RefineIssue[], after: RefineIssue[]): RefineIssue[] {
	const worst = new Map<string, number>();
	for (const issue of before) {
		const key = issueKey(issue);
		const severity = issue.severity ?? 0;
		const current = worst.get(key);
		worst.set(key, current === undefined ? severity : Math.max(current, severity));
	}
	return after.filter((issue) => {
		const previous = worst.get(issueKey(issue));
		if (previous === undefined) return true;
		return (issue.severity ?? 0) > previous;
	});
}

export function carriedOverIssues(before: RefineIssue[], after: RefineIssue[]): RefineIssue[] {
	const introduced = new Set(introducedIssues(before, after));
	return after.filter((issue) => !introduced.has(issue));
}
