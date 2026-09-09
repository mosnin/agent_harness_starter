/**
 * `(Storyboard, Edit[]) -> Storyboard`, as a pure function.
 *
 * Nothing here consults the editorial rules: the job is to produce exactly what the note asked
 * for, including a storyboard that is now illegal, so the validator can say which rule it broke.
 * The only values pulled back are knob ranges and the zero floor on the source timeline, and each
 * of those is recorded as a `ClampNote`.
 */

import type { Shot, Storyboard } from "../runner/protocol";
import {
	POSE_AXIS_BOUNDS,
	TRANSITION_DURATION_BOUNDS,
	ZOOM_BOUNDS,
	clampWithNote,
	resolveBounded,
	resolveDurationMs,
	resolveSigned,
} from "./resolve";
import type { ClampNote, Edit, RefineIssue, ShotTarget } from "./types";

export interface ApplyEditsResult {
	storyboard: Storyboard;
	clamps: ClampNote[];
	/** Operational failures — a target that matched nothing, an order that is not a permutation. */
	issues: RefineIssue[];
}

const SOURCE_TIME_BOUNDS = { min: 0, max: Number.MAX_SAFE_INTEGER };

export function normalizeShot(shot: Shot): Shot {
	return { ...shot, camera: { ...shot.camera } };
}

export function describeTarget(target: ShotTarget): string {
	switch (target.by) {
		case "id":
			return `shot ${target.shotId}`;
		case "index":
			return `shot ${target.index}`;
		case "ordinal":
			return `the ${target.ordinal} shot`;
	}
}

export function targetIndex(shots: readonly Shot[], target: ShotTarget): number {
	switch (target.by) {
		case "id":
			return shots.findIndex((shot) => shot.shotId === target.shotId);
		case "index":
			return target.index <= shots.length ? target.index - 1 : -1;
		case "ordinal":
			if (shots.length === 0) return -1;
			return target.ordinal === "first" ? 0 : shots.length - 1;
	}
}

export function applyEdits(storyboard: Storyboard, edits: Edit[]): ApplyEditsResult {
	const clamps: ClampNote[] = [];
	const issues: RefineIssue[] = [];
	let shots = storyboard.shots.map(normalizeShot);
	let background = storyboard.background;
	let music = storyboard.music ?? null;

	for (const edit of edits) {
		if (edit.op === "setBackground") {
			background = edit.background;
			continue;
		}
		if (edit.op === "setMusic") {
			music = edit.track;
			continue;
		}
		if (edit.op === "reorderShots") {
			const reordered = reorder(shots, edit.order);
			if (reordered === undefined) {
				issues.push({
					code: "not_a_permutation",
					message: `Reorder [${edit.order.join(", ")}] is not a permutation of [${shots
						.map((shot) => shot.shotId)
						.join(", ")}].`,
				});
				continue;
			}
			shots = reordered;
			continue;
		}

		const index = targetIndex(shots, edit.target);
		if (index < 0) {
			issues.push({
				code: "unresolved_target",
				message: `${describeTarget(edit.target)} does not exist in a storyboard of ${shots.length} shot(s).`,
			});
			continue;
		}
		const requested = requestedNumber(edit);
		if (requested !== null && !Number.isFinite(requested)) {
			issues.push({
				code: "malformed_edits",
				message: `${edit.op} on ${describeTarget(edit.target)} asks for ${String(requested)}, which is not a number that can be applied or clamped.`,
			});
			continue;
		}
		shots[index] = applyShotEdit(shots[index], index, edit, clamps);
	}

	return {
		storyboard: { ...storyboard, shots, background, music },
		clamps,
		issues,
	};
}

type ShotEdit = Extract<Edit, { target: ShotTarget }>;

/** The literal number an edit carries, or null when it carries an intent rather than a number. */
function requestedNumber(edit: ShotEdit): number | null {
	if (!("amount" in edit)) return null;
	switch (edit.amount.kind) {
		case "relative":
			return null;
		case "scale":
			return edit.amount.factor;
		case "absolute":
			return edit.amount.value;
	}
}

function applyShotEdit(
	shot: Shot,
	index: number,
	edit: ShotEdit,
	clamps: ClampNote[]
): Shot {
	const prefix = `shots[${index}]`;
	switch (edit.op) {
		case "adjustZoom":
			return {
				...shot,
				camera: {
					...shot.camera,
					zoom: resolveBounded(
						shot.camera.zoom,
						edit.amount,
						ZOOM_BOUNDS,
						`${prefix}.camera.zoom`,
						clamps
					),
				},
			};
		case "adjustPoseAxis": {
			const camera = { ...shot.camera };
			camera[edit.axis] = resolveSigned(
				camera[edit.axis],
				edit.amount,
				POSE_AXIS_BOUNDS[edit.axis],
				`${prefix}.camera.${edit.axis}`,
				clamps
			);
			return { ...shot, camera };
		}
		case "adjustSpan": {
			const duration = shot.sourceEndMs - shot.sourceStartMs;
			const next = resolveDurationMs(duration, edit.amount);
			if (edit.edge === "end") {
				return { ...shot, sourceEndMs: shot.sourceStartMs + next };
			}
			const start = clampWithNote(
				shot.sourceEndMs - next,
				SOURCE_TIME_BOUNDS,
				`${prefix}.sourceStartMs`,
				clamps
			);
			return { ...shot, sourceStartMs: start };
		}
		case "setAim":
			return { ...shot, aimBeatId: edit.beatId };
		case "setTransition":
			return { ...shot, transitionIn: edit.transition };
		case "adjustTransitionDuration":
			return {
				...shot,
				transitionDurationMs: Math.round(
					resolveBounded(
						shot.transitionDurationMs,
						edit.amount,
						TRANSITION_DURATION_BOUNDS,
						`${prefix}.transitionDurationMs`,
						clamps
					)
				),
			};
	}
}

function reorder(shots: Shot[], order: string[]): Shot[] | undefined {
	if (order.length !== shots.length) return undefined;
	const byId = new Map(shots.map((shot) => [shot.shotId, shot]));
	if (byId.size !== shots.length) return undefined;
	const next: Shot[] = [];
	for (const shotId of order) {
		const shot = byId.get(shotId);
		if (shot === undefined) return undefined;
		byId.delete(shotId);
		next.push(shot);
	}
	return byId.size === 0 ? next : undefined;
}
