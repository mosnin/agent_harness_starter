import { describe, expect, it } from "vitest";
import {
	BOUNDARY_TOLERANCE_MS,
	buildStoryboard,
	storyboardDurationMs,
	validateStoryboard,
	NEUTRAL_CAMERA,
	StoryboardInvalidError,
} from "../tools/cap/storyboard";
import { composeStoryboard } from "../definitions/director";
import { DEFAULT_EDITORIAL_LIMITS } from "../tools/cap/types";
import type { Beat, Shot, Storyboard } from "../tools/cap/types";

const LIMITS = DEFAULT_EDITORIAL_LIMITS;

function beat(overrides: Partial<Beat> & Pick<Beat, "beatId" | "offsetMs">): Beat {
	return {
		kind: "action",
		label: overrides.beatId,
		landmark: { x: 0.2, y: 0.3, width: 0.2, height: 0.1 },
		...overrides,
	};
}

function shot(overrides: Partial<Shot> & Pick<Shot, "shotId">): Shot {
	return {
		sourceStartMs: 0,
		sourceEndMs: 3_000,
		camera: NEUTRAL_CAMERA,
		aimBeatId: null,
		transitionIn: "none",
		recordingSegment: 0,
		transitionDurationMs: 0,
		...overrides,
	};
}

function storyboardOf(shots: Shot[]): Storyboard {
	return {
		version: 1,
		projectPath: "/tmp/demo.cap",
		sourceFps: 59.7,
		shots,
		background: { type: "solid", hex: "#000000" },
		cursor: { synthesize: true, size: 1, smoothing: 0.7 },
		music: null,
		captions: null,
	};
}

describe("buildStoryboard", () => {
	const beats: Beat[] = [
		beat({ beatId: "b1", offsetMs: 1_200, kind: "action" }),
		beat({ beatId: "b2", offsetMs: 4_000, kind: "typing" }),
		beat({ beatId: "b3", offsetMs: 7_500, kind: "reveal" }),
		beat({ beatId: "b4", offsetMs: 7_600, kind: "idle" }),
		beat({ beatId: "b5", offsetMs: 9_000, kind: "transition" }),
	];

	it("produces a storyboard that satisfies the editorial limits", () => {
		const storyboard = buildStoryboard({
			projectPath: "/tmp/demo.cap",
			sourceFps: 59.7,
			durationMs: 30_000,
			beats,
		});
		expect(validateStoryboard(storyboard, { limits: LIMITS, beats })).toEqual([]);
		expect(storyboardDurationMs(storyboard)).toBeLessThanOrEqual(LIMITS.maxTotalMs);
		expect(storyboard.shots.length).toBeLessThanOrEqual(LIMITS.maxShots);
	});

	it("never aims a shot at an idle or transition beat", () => {
		const storyboard = buildStoryboard({
			projectPath: "/tmp/demo.cap",
			sourceFps: 60,
			durationMs: 30_000,
			beats,
		});
		const aimed = storyboard.shots.map((s) => s.aimBeatId).filter(Boolean);
		expect(aimed).not.toContain("b4");
		expect(aimed).not.toContain("b5");
	});

	it("uses one motion system: the first shot enters cold, the rest cut", () => {
		const storyboard = buildStoryboard({
			projectPath: "/tmp/demo.cap",
			sourceFps: 60,
			durationMs: 30_000,
			beats,
		});
		expect(storyboard.shots[0].transitionIn).toBe("none");
		for (const s of storyboard.shots.slice(1)) expect(s.transitionIn).toBe("cut");
	});

	it("drops beats that would create a shot under the minimum length", () => {
		const dense = Array.from({ length: 10 }, (_, i) =>
			beat({ beatId: `d${i}`, offsetMs: 1_000 + i * 200 })
		);
		const storyboard = buildStoryboard({
			projectPath: "/tmp/demo.cap",
			sourceFps: 60,
			durationMs: 20_000,
			beats: dense,
		});
		for (const s of storyboard.shots) {
			expect(s.sourceEndMs - s.sourceStartMs).toBeGreaterThanOrEqual(LIMITS.minShotMs);
		}
	});

	it("falls back to one establishing shot when nothing was worth cutting to", () => {
		const storyboard = buildStoryboard({
			projectPath: "/tmp/demo.cap",
			sourceFps: 60,
			durationMs: 30_000,
			beats: [beat({ beatId: "i1", offsetMs: 500, kind: "idle" })],
		});
		expect(storyboard.shots).toHaveLength(1);
		expect(storyboard.shots[0].transitionIn).toBe("none");
		expect(storyboardDurationMs(storyboard)).toBe(LIMITS.maxTotalMs);
	});

	it("synthesizes the cursor, because synthetic input leaves no recorded one", () => {
		const storyboard = buildStoryboard({
			projectPath: "/tmp/demo.cap",
			sourceFps: 60,
			durationMs: 10_000,
			beats,
		});
		expect(storyboard.cursor.synthesize).toBe(true);
	});
});

describe("validateStoryboard", () => {
	it("accepts a storyboard inside every limit", () => {
		expect(validateStoryboard(storyboardOf([shot({ shotId: "s1" })]))).toEqual([]);
	});

	it("flags a total cut over twelve seconds", () => {
		const issues = validateStoryboard(
			storyboardOf([shot({ shotId: "s1", sourceStartMs: 0, sourceEndMs: 13_000 })])
		);
		expect(issues.map((i) => i.code)).toContain("total_too_long");
	});

	it("flags a shot under the minimum length", () => {
		const issues = validateStoryboard(
			storyboardOf([shot({ shotId: "s1", sourceStartMs: 0, sourceEndMs: 400 })])
		);
		expect(issues.map((i) => i.code)).toContain("shot_too_short");
	});

	it("flags more shots than the limit allows", () => {
		const shots = Array.from({ length: LIMITS.maxShots + 1 }, (_, i) =>
			shot({
				shotId: `s${i}`,
				sourceStartMs: i * 1_500,
				sourceEndMs: i * 1_500 + 1_400,
				aimBeatId: `b${i}`,
				transitionIn: i === 0 ? "none" : "cut",
				recordingSegment: 0,
				transitionDurationMs: 0,
			})
		);
		const issues = validateStoryboard(storyboardOf(shots));
		expect(issues.map((i) => i.code)).toContain("too_many_shots");
	});

	it("flags a camera cut that is not a content cut", () => {
		const shots = [
			shot({ shotId: "s1", sourceStartMs: 0, sourceEndMs: 2_000 }),
			shot({
				shotId: "s2",
				sourceStartMs: 2_000,
				sourceEndMs: 4_000,
				aimBeatId: null,
				transitionIn: "cut",
				recordingSegment: 0,
				transitionDurationMs: 0,
			}),
		];
		expect(validateStoryboard(storyboardOf(shots)).map((i) => i.code)).toContain(
			"cut_without_content"
		);
	});

	it("flags a cut aimed at an idle beat, or at a beat outside its own span", () => {
		const beats: Beat[] = [
			beat({ beatId: "idle", offsetMs: 2_500, kind: "idle" }),
			beat({ beatId: "far", offsetMs: 9_000, kind: "action" }),
		];
		const shots = [
			shot({ shotId: "s1", sourceStartMs: 0, sourceEndMs: 2_000 }),
			shot({
				shotId: "s2",
				sourceStartMs: 2_000,
				sourceEndMs: 4_000,
				aimBeatId: "idle",
				transitionIn: "cut",
				recordingSegment: 0,
				transitionDurationMs: 0,
			}),
			shot({
				shotId: "s3",
				sourceStartMs: 4_000,
				sourceEndMs: 6_000,
				aimBeatId: "far",
				transitionIn: "cut",
				recordingSegment: 0,
				transitionDurationMs: 0,
			}),
		];
		const codes = validateStoryboard(storyboardOf(shots), { beats }).map((i) => i.code);
		expect(codes.filter((c) => c === "cut_without_content")).toHaveLength(2);
	});

	it("flags mixing cuts with dollies — one motion system only", () => {
		const shots = [
			shot({ shotId: "s1", sourceStartMs: 0, sourceEndMs: 2_000 }),
			shot({
				shotId: "s2",
				sourceStartMs: 2_000,
				sourceEndMs: 4_000,
				aimBeatId: "b2",
				transitionIn: "cut",
				recordingSegment: 0,
				transitionDurationMs: 0,
			}),
			shot({
				shotId: "s3",
				sourceStartMs: 4_000,
				sourceEndMs: 6_000,
				aimBeatId: "b3",
				transitionIn: "dolly",
				recordingSegment: 0,
				transitionDurationMs: 0,
			}),
		];
		expect(validateStoryboard(storyboardOf(shots)).map((i) => i.code)).toContain(
			"mixed_motion_systems"
		);
	});

	it("flags shots that run out of order", () => {
		const shots = [
			shot({ shotId: "s1", sourceStartMs: 4_000, sourceEndMs: 6_000 }),
			shot({
				shotId: "s2",
				sourceStartMs: 1_000,
				sourceEndMs: 3_000,
				aimBeatId: "b2",
				transitionIn: "cut",
				recordingSegment: 0,
				transitionDurationMs: 0,
			}),
		];
		expect(validateStoryboard(storyboardOf(shots)).map((i) => i.code)).toContain(
			"shot_not_ordered"
		);
	});

	it("rejects an empty storyboard", () => {
		expect(validateStoryboard(storyboardOf([]))[0].code).toBe("no_shots");
	});
});

describe("composeStoryboard", () => {
	it("returns a validated storyboard for a normal shoot", () => {
		const beats: Beat[] = [
			beat({ beatId: "b1", offsetMs: 1_000 }),
			beat({ beatId: "b2", offsetMs: 5_000, kind: "reveal" }),
		];
		const storyboard = composeStoryboard({
			projectPath: "/tmp/demo.cap",
			sourceFps: 58.2,
			durationMs: 20_000,
			beats,
		});
		expect(validateStoryboard(storyboard, { beats })).toEqual([]);
	});

	it("throws StoryboardInvalidError rather than shipping an unusable cut", () => {
		expect(() =>
			composeStoryboard({
				projectPath: "/tmp/demo.cap",
				sourceFps: 60,
				durationMs: 300,
				beats: [beat({ beatId: "b1", offsetMs: 100 })],
			})
		).toThrow(StoryboardInvalidError);
	});
});

describe("shot boundaries land within the compiler's beat tolerance", () => {
	it("keeps every non-first boundary inside BOUNDARY_TOLERANCE_MS of its aim beat", () => {
		const beats: Beat[] = [
			{ beatId: "b1", offsetMs: 1_200, kind: "action", label: "open pricing", landmark: null },
			{ beatId: "b2", offsetMs: 4_000, kind: "reveal", label: "pricing shown", landmark: null },
			{ beatId: "b3", offsetMs: 7_500, kind: "action", label: "pick a plan", landmark: null },
		];
		const board = buildStoryboard({ projectPath: "/tmp/p.cap", durationMs: 11_000, sourceFps: 58.2, beats });
		const byId = new Map(beats.map((beat) => [beat.beatId, beat]));

		for (const shot of board.shots.slice(1)) {
			const beat = shot.aimBeatId ? byId.get(shot.aimBeatId) : undefined;
			if (!beat) continue;
			expect(Math.abs(shot.sourceStartMs - beat.offsetMs)).toBeLessThanOrEqual(BOUNDARY_TOLERANCE_MS);
		}
	});

	it("clamps a caller's oversized lead-in rather than emitting a boundary the compiler rejects", () => {
		const beats: Beat[] = [
			{ beatId: "b1", offsetMs: 1_000, kind: "action", label: "one", landmark: null },
			{ beatId: "b2", offsetMs: 5_000, kind: "action", label: "two", landmark: null },
		];
		const board = buildStoryboard({
			projectPath: "/tmp/p.cap",
			durationMs: 9_000,
			sourceFps: 58.2,
			beats,
			leadInMs: 4_000,
		});

		const second = board.shots[1];
		expect(second).toBeDefined();
		expect(Math.abs((second?.sourceStartMs ?? 0) - 5_000)).toBeLessThanOrEqual(BOUNDARY_TOLERANCE_MS);
	});
});
