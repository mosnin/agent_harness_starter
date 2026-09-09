/**
 * Deterministic storyboard diffing, so a refinement can be shown before it is committed.
 *
 * Shots are keyed by position rather than by id: a reorder is a real change and keying by id would
 * render it as nothing at all. Ordering of the change list is document order, which is stable for
 * a given pair of storyboards regardless of how the edits were expressed.
 */

import type { Background, CameraPose, Storyboard } from "../runner/protocol";
import { shotExtensions } from "../tools/cap/types";
import type { DiffChange, StoryboardDiff } from "./types";

function formatValue(value: string | number | boolean | null): string {
	return value === null ? "none" : String(value);
}

function backgroundEntries(background: Background): Array<[string, string]> {
	switch (background.type) {
		case "gradient":
			return [
				["background.type", "gradient"],
				["background.fromHex", background.fromHex],
				["background.toHex", background.toHex],
			];
		case "solid":
			return [
				["background.type", "solid"],
				["background.hex", background.hex],
			];
		case "wallpaper":
			return [
				["background.type", "wallpaper"],
				["background.name", background.name],
			];
	}
}

const POSE_KEYS: Array<keyof CameraPose> = [
	"zoom",
	"tiltX",
	"tiltY",
	"rotateX",
	"rotateY",
	"roll",
	"fov",
	"focusX",
	"focusY",
	"focusSize",
];

export function flattenStoryboard(storyboard: Storyboard): Map<string, string> {
	const flat = new Map<string, string>();
	flat.set("projectPath", storyboard.projectPath);
	flat.set("sourceFps", formatValue(storyboard.sourceFps));
	flat.set("music", formatValue(storyboard.music ?? null));
	for (const [path, value] of backgroundEntries(storyboard.background)) flat.set(path, value);
	flat.set("cursor.synthesize", formatValue(storyboard.cursor.synthesize));
	flat.set("cursor.size", formatValue(storyboard.cursor.size));
	flat.set("cursor.smoothing", formatValue(storyboard.cursor.smoothing));
	flat.set("shots.length", formatValue(storyboard.shots.length));

	storyboard.shots.forEach((shot, index) => {
		const prefix = `shots[${index}]`;
		const extensions = shotExtensions(shot);
		flat.set(`${prefix}.shotId`, shot.shotId);
		flat.set(`${prefix}.sourceStartMs`, formatValue(shot.sourceStartMs));
		flat.set(`${prefix}.sourceEndMs`, formatValue(shot.sourceEndMs));
		flat.set(`${prefix}.aimBeatId`, formatValue(shot.aimBeatId ?? null));
		flat.set(`${prefix}.transitionIn`, shot.transitionIn);
		flat.set(`${prefix}.transitionDurationMs`, formatValue(extensions.transitionDurationMs));
		flat.set(`${prefix}.recordingSegment`, formatValue(extensions.recordingSegment));
		for (const key of POSE_KEYS) {
			flat.set(`${prefix}.camera.${key}`, formatValue(shot.camera[key]));
		}
	});

	return flat;
}

export function diffStoryboards(before: Storyboard, after: Storyboard): StoryboardDiff {
	const left = flattenStoryboard(before);
	const right = flattenStoryboard(after);
	const changes: DiffChange[] = [];

	for (const [path, value] of left) {
		const next = right.get(path);
		if (next === undefined) {
			changes.push({ path, before: value, after: "removed" });
			continue;
		}
		if (next !== value) changes.push({ path, before: value, after: next });
	}
	for (const [path, value] of right) {
		if (!left.has(path)) changes.push({ path, before: "absent", after: value });
	}

	return { changes };
}

export function renderDiff(diff: StoryboardDiff): string {
	if (diff.changes.length === 0) return "no changes";
	return diff.changes.map((change) => `${change.path}: ${change.before} -> ${change.after}`).join("\n");
}
