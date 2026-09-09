/**
 * Storyboard construction and validation against `EditorialLimits`.
 *
 * The three rules the Rust compiler enforces are encoded here so the Cinematographer fails at
 * planning time rather than at `applyStoryboard`:
 *   1. twelve seconds total, at most `maxShots`, no shot shorter than `minShotMs`;
 *   2. a camera cut must be a content cut — every cut aims at a non-idle beat inside its span;
 *   3. one motion system — a storyboard cuts or it dollies, never both.
 */

import { AgentError } from "../../errors/index";
import {
	DEFAULT_EDITORIAL_LIMITS,
	type Background,
	type Beat,
	type CameraPose,
	type CursorStyle,
	type EditorialLimits,
	type Shot,
	type Storyboard,
	type Transition,
} from "./types";

export interface StoryboardIssue {
	code:
		| "no_shots"
		| "too_many_shots"
		| "shot_too_short"
		| "shot_not_ordered"
		| "total_too_long"
		| "cut_without_content"
		| "mixed_motion_systems";
	message: string;
	shotId?: string;
}

export class StoryboardInvalidError extends AgentError {
	readonly issues: StoryboardIssue[];

	constructor(issues: StoryboardIssue[]) {
		super(
			`Storyboard violates editorial limits: ${issues.map((i) => i.message).join("; ")}`,
			"STORYBOARD_INVALID",
			"Re-cut the storyboard so every shot aims at a logged beat and the total stays inside the limit."
		);
		this.name = "StoryboardInvalidError";
		this.issues = issues;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export function shotDurationMs(shot: Shot): number {
	return shot.sourceEndMs - shot.sourceStartMs;
}

export function storyboardDurationMs(storyboard: Storyboard): number {
	return storyboard.shots.reduce((total, shot) => total + shotDurationMs(shot), 0);
}

export interface ValidateStoryboardOptions {
	limits?: EditorialLimits;
	/** Beat log from the shoot. Supplied, cuts are checked against real content boundaries. */
	beats?: Beat[];
}

export function validateStoryboard(
	storyboard: Storyboard,
	options: ValidateStoryboardOptions = {}
): StoryboardIssue[] {
	const limits = options.limits ?? DEFAULT_EDITORIAL_LIMITS;
	const issues: StoryboardIssue[] = [];
	const { shots } = storyboard;

	if (shots.length === 0) {
		return [{ code: "no_shots", message: "A storyboard needs at least one shot." }];
	}

	if (shots.length > limits.maxShots) {
		issues.push({
			code: "too_many_shots",
			message: `${shots.length} shots exceeds the limit of ${limits.maxShots}.`,
		});
	}

	let previousEnd = -1;
	for (const shot of shots) {
		const duration = shotDurationMs(shot);
		if (duration < limits.minShotMs) {
			issues.push({
				code: "shot_too_short",
				message: `Shot ${shot.shotId} is ${duration}ms, below the ${limits.minShotMs}ms minimum.`,
				shotId: shot.shotId,
			});
		}
		if (shot.sourceStartMs < previousEnd) {
			issues.push({
				code: "shot_not_ordered",
				message: `Shot ${shot.shotId} starts before the previous shot ended.`,
				shotId: shot.shotId,
			});
		}
		previousEnd = shot.sourceEndMs;
	}

	const total = storyboardDurationMs(storyboard);
	if (total > limits.maxTotalMs) {
		issues.push({
			code: "total_too_long",
			message: `Total cut is ${total}ms, over the ${limits.maxTotalMs}ms limit.`,
		});
	}

	const beatsById = new Map((options.beats ?? []).map((beat) => [beat.beatId, beat]));
	for (const shot of shots.slice(1)) {
		if (shot.transitionIn !== "cut") continue;
		const beat = shot.aimBeatId ? beatsById.get(shot.aimBeatId) : undefined;
		const contentful =
			shot.aimBeatId !== null &&
			shot.aimBeatId !== undefined &&
			(options.beats === undefined ||
				(beat !== undefined &&
					beat.kind !== "idle" &&
					beat.offsetMs >= shot.sourceStartMs &&
					beat.offsetMs <= shot.sourceEndMs));
		if (!contentful) {
			issues.push({
				code: "cut_without_content",
				message: `Shot ${shot.shotId} cuts without aiming at a content beat inside its span.`,
				shotId: shot.shotId,
			});
		}
	}

	const motions = new Set<Transition>(
		shots.slice(1).map((shot) => shot.transitionIn).filter((t) => t !== "none")
	);
	if (motions.size > 1) {
		issues.push({
			code: "mixed_motion_systems",
			message: `Storyboard mixes motion systems: ${Array.from(motions).sort().join(" + ")}.`,
		});
	}

	return issues;
}

export function assertStoryboardValid(
	storyboard: Storyboard,
	options: ValidateStoryboardOptions = {}
): void {
	const issues = validateStoryboard(storyboard, options);
	if (issues.length > 0) throw new StoryboardInvalidError(issues);
}

export const NEUTRAL_CAMERA: CameraPose = {
	zoom: 1,
	tiltX: 0,
	tiltY: 0,
	rotateX: 0,
	roll: 0,
	rotateY: 0,
	fov: 45,
	focusX: 0.5,
	focusY: 0.5,
	focusSize: 1,
};

export const DEFAULT_CURSOR: CursorStyle = {
	synthesize: true,
	size: 1,
	smoothing: 0.7,
};

export const DEFAULT_BACKGROUND: Background = {
	type: "gradient",
	fromHex: "#0f172a",
	toHex: "#1e293b",
};

export interface BuildStoryboardInput {
	projectPath: string;
	sourceFps: number;
	durationMs: number;
	beats: Beat[];
	limits?: EditorialLimits;
	/**
	 * Milliseconds of run-up kept before the beat a shot aims at. Clamped below
	 * BOUNDARY_TOLERANCE_MS, because the run-up is exactly the distance between a shot boundary
	 * and its aim beat, and the compiler rejects a boundary further than that from a beat.
	 */
	leadInMs?: number;
	/** Length of the final shot when nothing follows it. Default 2500. */
	tailShotMs?: number;
	background?: Background;
	cursor?: CursorStyle;
	music?: string | null;
}

const AIMABLE_BEATS = new Set(["action", "reveal", "typing"]);

function punchIn(beat: Beat): CameraPose {
	if (!beat.landmark) return { ...NEUTRAL_CAMERA, zoom: 1.15 };
	const { x, y, width, height } = beat.landmark;
	return {
		...NEUTRAL_CAMERA,
		zoom: beat.kind === "typing" ? 1.6 : 1.35,
		tiltX: 0,
		tiltY: 0,
		rotateX: 0,
		focusX: clamp01(x + width / 2),
		focusY: clamp01(y + height / 2),
		focusSize: Math.min(1, Math.max(0.2, Math.max(width, height))),
	};
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/**
 * Compile a beat log into a storyboard that satisfies the editorial limits by construction.
 * Beats that are idle or pure transitions are never aimed at, so every cut lands on content.
 */
/**
 * Mirrors BOUNDARY_TOLERANCE_MS in crates/hades-director/src/validate.rs. A shot boundary further
 * than this from the beat it aims at is rejected as a cut that does not land on content.
 */
export const BOUNDARY_TOLERANCE_MS = 250;

/** Kept strictly inside the tolerance so a boundary is never rejected at the limit. */
export const MAX_LEAD_IN_MS = BOUNDARY_TOLERANCE_MS - 50;

export const DEFAULT_LEAD_IN_MS = MAX_LEAD_IN_MS;

export function buildStoryboard(input: BuildStoryboardInput): Storyboard {
	const limits = input.limits ?? DEFAULT_EDITORIAL_LIMITS;
	const leadInMs = Math.min(input.leadInMs ?? DEFAULT_LEAD_IN_MS, MAX_LEAD_IN_MS);
	const tailShotMs = Math.max(limits.minShotMs, input.tailShotMs ?? 2_500);
	const duration = Math.max(0, input.durationMs);

	const candidates = input.beats
		.filter((beat) => AIMABLE_BEATS.has(beat.kind))
		.slice()
		.sort((a, b) => a.offsetMs - b.offsetMs);

	const anchors: Array<{ start: number; beat: Beat }> = [];
	for (const beat of candidates) {
		const start = Math.max(0, Math.min(beat.offsetMs - leadInMs, duration));
		const previous = anchors.at(-1);
		if (previous && start - previous.start < limits.minShotMs) continue;
		if (anchors.length >= limits.maxShots) break;
		anchors.push({ start, beat });
	}

	const shots: Shot[] = [];
	let budget = limits.maxTotalMs;

	if (anchors.length === 0) {
		const end = Math.min(duration, limits.maxTotalMs);
		shots.push({
			shotId: "shot-1",
			sourceStartMs: 0,
			sourceEndMs: end,
			camera: NEUTRAL_CAMERA,
			aimBeatId: null,
			transitionIn: "none",
			recordingSegment: 0,
			transitionDurationMs: 0,
		});
			return assemble(input, shots);
	}

	for (let i = 0; i < anchors.length; i++) {
		const { start, beat } = anchors[i];
		const naturalEnd =
			i < anchors.length - 1
				? anchors[i + 1].start
				: Math.min(duration, start + tailShotMs);
		let end = Math.min(duration, Math.max(naturalEnd, start + limits.minShotMs));

		if (end - start > budget) end = start + budget;
		const span = end - start;
		if (span < limits.minShotMs) break;

		shots.push({
			shotId: `shot-${shots.length + 1}`,
			sourceStartMs: start,
			sourceEndMs: end,
			camera: punchIn(beat),
			aimBeatId: beat.beatId,
			transitionIn: shots.length === 0 ? "none" : "cut",
			recordingSegment: 0,
			transitionDurationMs: 0,
		});
		budget -= span;
		if (budget < limits.minShotMs) break;
	}

	if (shots.length === 0) {
		shots.push({
			shotId: "shot-1",
			sourceStartMs: 0,
			sourceEndMs: Math.min(duration, limits.maxTotalMs),
			camera: NEUTRAL_CAMERA,
			aimBeatId: null,
			transitionIn: "none",
			recordingSegment: 0,
			transitionDurationMs: 0,
		});
	}

	return assemble(input, shots);
}

function assemble(input: BuildStoryboardInput, shots: Shot[]): Storyboard {
	return {
		version: 1,
		projectPath: input.projectPath,
		sourceFps: input.sourceFps,
		shots,
		background: input.background ?? DEFAULT_BACKGROUND,
		cursor: input.cursor ?? DEFAULT_CURSOR,
		music: input.music ?? null,
		captions: null,
	};
}
