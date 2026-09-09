/**
 * Relative-to-absolute resolution for refinement knobs.
 *
 * "Tighter" is not a number. Resolving it additively ("+0.3 zoom") makes the same note behave
 * wildly differently depending on where the shot already sits and lets a chain of notes walk the
 * pose off the end of the scale. Instead a relative adjustment moves a *fraction of the distance
 * that is still available in the direction asked for*:
 *
 *     increase:  value + (max - value) * fraction
 *     decrease:  value - (value - min) * fraction
 *
 * So "tighter, moderately" on a shot at 1.0 zoom (bounds 1.0-2.5) lands at 1.45, and the same note
 * on a shot already at 1.6 lands at 1.87 — a smaller absolute step, because there is less room
 * left. It is monotone, it can never cross the bound, and repeated application converges on the
 * bound instead of overshooting it.
 *
 * Angles resolve differently: "less tilt" means *toward level*, not toward the negative bound, so a
 * decrease on a signed axis moves the value toward zero and an increase pushes further out in the
 * sign it already has.
 *
 * `absolute` always names the resulting value of the knob and `scale` always multiplies the
 * current one. Both come from a model and neither is trusted: they are clamped to the bounds, and
 * every clamp is recorded as a `ClampNote` so a caller can see that the number it asked for is not
 * the number it got. Clamping applies only to knob ranges — never to anything the editorial rules
 * govern, which is rejected instead.
 */

import type { Adjustment, ClampNote, PoseAxis } from "./types";

export interface Bounds {
	min: number;
	max: number;
}

export const ZOOM_BOUNDS: Bounds = { min: 1, max: 2.5 };

/**
 * Camera angles are degrees (`hades-director/src/camera.rs` builds rotation matrices from them;
 * its reference pose is tiltX 26, tiltY -22, roll 1). Past 45 degrees the content plane goes
 * edge-on and the frame stops reading as a screen recording.
 */
export const POSE_AXIS_BOUNDS: Record<PoseAxis, Bounds> = {
	tiltX: { min: -45, max: 45 },
	tiltY: { min: -45, max: 45 },
	rotateX: { min: -45, max: 45 },
	rotateY: { min: -45, max: 45 },
	roll: { min: -30, max: 30 },
};

/** A dolly longer than two seconds eats a whole shot at these editorial limits. */
export const TRANSITION_DURATION_BOUNDS: Bounds = { min: 0, max: 2_000 };

/** Fraction of the remaining travel a relative adjustment consumes. */
export const RELATIVE_FRACTIONS: Record<"slight" | "moderate" | "strong", number> = {
	slight: 0.15,
	moderate: 0.3,
	strong: 0.5,
};

/** Matches `OUTPUT_DECIMALS` in `hades-director/src/lib.rs`, so a pose round-trips unchanged. */
const POSE_DECIMALS = 1_000_000;

export function roundPose(value: number): number {
	return Math.round(value * POSE_DECIMALS) / POSE_DECIMALS;
}

export function clampWithNote(
	value: number,
	bounds: Bounds,
	path: string,
	clamps: ClampNote[]
): number {
	if (value < bounds.min) {
		clamps.push({ path, requested: value, applied: bounds.min, bound: "min" });
		return bounds.min;
	}
	if (value > bounds.max) {
		clamps.push({ path, requested: value, applied: bounds.max, bound: "max" });
		return bounds.max;
	}
	return value;
}

/** Resolution for a one-directional knob, where "less" means "toward the minimum". */
export function resolveBounded(
	current: number,
	adjustment: Adjustment,
	bounds: Bounds,
	path: string,
	clamps: ClampNote[]
): number {
	const start = current;
	switch (adjustment.kind) {
		case "relative": {
			const fraction = RELATIVE_FRACTIONS[adjustment.magnitude];
			const next =
				adjustment.direction === "increase"
					? start + (bounds.max - start) * fraction
					: start - (start - bounds.min) * fraction;
			return roundPose(clampWithNote(next, bounds, path, clamps));
		}
		case "scale":
			return roundPose(clampWithNote(start * adjustment.factor, bounds, path, clamps));
		case "absolute":
			return roundPose(clampWithNote(adjustment.value, bounds, path, clamps));
	}
}

/** Resolution for a signed axis, where "less" means "toward level" rather than "toward the floor". */
export function resolveSigned(
	current: number,
	adjustment: Adjustment,
	bounds: Bounds,
	path: string,
	clamps: ClampNote[]
): number {
	const start = current;
	switch (adjustment.kind) {
		case "relative": {
			const fraction = RELATIVE_FRACTIONS[adjustment.magnitude];
			const next =
				adjustment.direction === "decrease"
					? start - start * fraction
					: start + ((start < 0 ? bounds.min : bounds.max) - start) * fraction;
			return roundPose(clampWithNote(next, bounds, path, clamps));
		}
		case "scale":
			return roundPose(clampWithNote(start * adjustment.factor, bounds, path, clamps));
		case "absolute":
			return roundPose(clampWithNote(adjustment.value, bounds, path, clamps));
	}
}

/**
 * The duration a span adjustment asks for, in milliseconds.
 *
 * Deliberately unclamped: a shot's length is governed by the editorial rules (`minShotMs`,
 * `maxTotalMs`), and quietly pulling a request back inside them is exactly the failure mode this
 * module exists to avoid. An impossible length is produced here and rejected by the validator,
 * with the rule that rejected it named.
 */
export function resolveDurationMs(currentMs: number, adjustment: Adjustment): number {
	switch (adjustment.kind) {
		case "relative": {
			const fraction = RELATIVE_FRACTIONS[adjustment.magnitude];
			const scale = adjustment.direction === "increase" ? 1 + fraction : 1 - fraction;
			return Math.round(currentMs * scale);
		}
		case "scale":
			return Math.round(currentMs * adjustment.factor);
		case "absolute":
			return Math.round(adjustment.value);
	}
}
