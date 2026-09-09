import { describe, expect, it, vi } from "vitest";
import {
	BOUNDARY_TOLERANCE_MS,
	type Edit,
	type EditInterpreter,
	type EditorialContext,
	type InterpretRequest,
	RELATIVE_FRACTIONS,
	ZOOM_BOUNDS,
	applyEdits,
	applyRefinement,
	diffStoryboards,
	phraseInterpreter,
	refineStoryboard,
	renderDiff,
	staticInterpreter,
	validateEditorial,
} from "../refine";
import { NEUTRAL_CAMERA } from "../tools/cap/storyboard";
import type { Beat, CameraPose, Shot, Storyboard } from "../tools/cap/types";

function pose(overrides: Partial<CameraPose> = {}): CameraPose {
	return { ...NEUTRAL_CAMERA, ...overrides };
}

function shot(overrides: Partial<Shot> & Pick<Shot, "shotId">): Shot {
	return {
		sourceStartMs: 0,
		sourceEndMs: 3_000,
		camera: pose(),
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
		music: "calm-loop",
		captions: null,
	};
}

const BEATS: Beat[] = [
	{ beatId: "b1", offsetMs: 1_000, kind: "action", label: "Sign up", landmark: null },
	{ beatId: "b2", offsetMs: 4_000, kind: "typing", label: "pricing page", landmark: null },
	{ beatId: "b3", offsetMs: 7_000, kind: "reveal", label: "the dashboard", landmark: null },
	{ beatId: "b4", offsetMs: 7_100, kind: "idle", label: "settle", landmark: null },
];

const CONTEXT: EditorialContext = { beats: BEATS };

/** Every cut lands exactly on a content beat, so the baseline breaks no editorial rule. */
function cleanStoryboard(): Storyboard {
	return storyboardOf([
		shot({
			shotId: "shot-1",
			sourceStartMs: 800,
			sourceEndMs: 4_000,
			aimBeatId: "b1",
			camera: pose({ zoom: 1, tiltX: 20 }),
			transitionIn: "none",
			recordingSegment: 0,
			transitionDurationMs: 0,
		}),
		shot({
			shotId: "shot-2",
			sourceStartMs: 4_000,
			sourceEndMs: 7_000,
			aimBeatId: "b2",
			camera: pose({ zoom: 1.6 }),
			transitionIn: "cut",
			recordingSegment: 0,
			transitionDurationMs: 0,
		}),
		shot({
			shotId: "shot-3",
			sourceStartMs: 7_000,
			sourceEndMs: 9_000,
			aimBeatId: "b3",
			camera: pose({ zoom: 1.35 }),
			transitionIn: "cut",
			recordingSegment: 0,
			transitionDurationMs: 0,
		}),
	]);
}

/** The same cut as the Cinematographer builds it: a 400ms lead-in puts shot 2 off its beat. */
function leadInStoryboard(): Storyboard {
	const board = cleanStoryboard();
	board.shots[0].sourceEndMs = 3_600;
	board.shots[1].sourceStartMs = 3_600;
	return board;
}

function codesOf(outcome: ReturnType<typeof applyRefinement>): string[] {
	return outcome.status === "rejected" ? outcome.issues.map((issue) => issue.code) : [];
}

describe("editorial validation mirrored from hades-director/src/validate.rs", () => {
	it("passes a storyboard whose every cut lands on a content beat", () => {
		expect(validateEditorial(cleanStoryboard(), CONTEXT)).toEqual([]);
	});

	it("catches a duplicate shot id", () => {
		const board = cleanStoryboard();
		board.shots[2].shotId = "shot-1";
		expect(validateEditorial(board, CONTEXT).map((i) => i.code)).toContain("duplicate_shot_id");
	});

	it("catches an inverted span as an empty shot", () => {
		const board = cleanStoryboard();
		board.shots[1].sourceEndMs = 4_000;
		expect(validateEditorial(board, CONTEXT).map((i) => i.code)).toContain("empty_shot");
	});

	it("catches a non-finite pose on the axes the Rust checker inspects", () => {
		const board = cleanStoryboard();
		board.shots[0].camera.zoom = Number.NaN;
		expect(validateEditorial(board, CONTEXT).map((i) => i.code)).toContain("non_finite_pose");
	});

	it("catches an aim at a beat that is not in the log", () => {
		const board = cleanStoryboard();
		board.shots[1].aimBeatId = "ghost";
		expect(validateEditorial(board, CONTEXT).map((i) => i.code)).toContain("unknown_aim_beat");
	});

	it("catches a shot that lands outside the recorded video", () => {
		const board = cleanStoryboard();
		const issues = validateEditorial(board, { ...CONTEXT, recordingDurationMs: 8_000 });
		expect(issues.map((i) => i.code)).toContain("shot_outside_recording");
	});

	it("reports stacked motion systems from the base project's zoom segments", () => {
		const issues = validateEditorial(cleanStoryboard(), { ...CONTEXT, zoomSegments: 2 });
		expect(issues.map((i) => i.code)).toContain("motion_systems_stacked");
	});

	it("distinguishes a cut that misses every beat from one that lands mid-idle", () => {
		const beats: Beat[] = [
			{ beatId: "c1", offsetMs: 1_000, kind: "action", label: "open", landmark: null },
			{ beatId: "c2", offsetMs: 5_000, kind: "idle", label: "settle", landmark: null },
			{ beatId: "c3", offsetMs: 8_000, kind: "reveal", label: "done", landmark: null },
		];
		const midIdle = storyboardOf([
			shot({ shotId: "s1", sourceStartMs: 900, sourceEndMs: 5_050, aimBeatId: "c1" }),
			shot({
				shotId: "s2",
				sourceStartMs: 5_050,
				sourceEndMs: 8_400,
				aimBeatId: "c3",
				transitionIn: "cut",
				recordingSegment: 0,
				transitionDurationMs: 0,
			}),
		]);
		expect(validateEditorial(midIdle, { beats }).map((i) => i.code)).toContain(
			"boundary_mid_idle"
		);

		const nowhereNear = storyboardOf([
			shot({ shotId: "s1", sourceStartMs: 900, sourceEndMs: 3_000, aimBeatId: "c1" }),
			shot({
				shotId: "s2",
				sourceStartMs: 3_000,
				sourceEndMs: 8_400,
				aimBeatId: "c3",
				transitionIn: "cut",
				recordingSegment: 0,
				transitionDurationMs: 0,
			}),
		]);
		expect(validateEditorial(nowhereNear, { beats }).map((i) => i.code)).toContain(
			"boundary_not_on_beat"
		);
	});

	it("uses the Rust boundary tolerance", () => {
		expect(BOUNDARY_TOLERANCE_MS).toBe(250);
	});
});

describe("relative adjustments resolve against the value the shot already has", () => {
	it("resolves 'tighter' differently on a wide shot and a tight one", () => {
		const edits = (index: number): Edit[] => [
			{
				op: "adjustZoom",
				target: { by: "index", index },
				amount: { kind: "relative", direction: "increase", magnitude: "moderate" },
			},
		];

		const board = cleanStoryboard();
		const wide = applyEdits(board, edits(1)).storyboard.shots[0].camera.zoom;
		const tight = applyEdits(board, edits(2)).storyboard.shots[1].camera.zoom;

		expect(wide).toBeCloseTo(1 + (ZOOM_BOUNDS.max - 1) * RELATIVE_FRACTIONS.moderate, 6);
		expect(tight).toBeCloseTo(1.6 + (ZOOM_BOUNDS.max - 1.6) * RELATIVE_FRACTIONS.moderate, 6);
		expect(wide).toBeCloseTo(1.45, 6);
		expect(tight).toBeCloseTo(1.87, 6);
		expect(wide - 1).toBeGreaterThan(tight - 1.6);
	});

	it("never crosses the bound, however many times it is applied", () => {
		let board = cleanStoryboard();
		for (let i = 0; i < 50; i++) {
			board = applyEdits(board, [
				{
					op: "adjustZoom",
					target: { by: "id", shotId: "shot-2" },
					amount: { kind: "relative", direction: "increase", magnitude: "strong" },
				},
			]).storyboard;
		}
		expect(board.shots[1].camera.zoom).toBeLessThanOrEqual(ZOOM_BOUNDS.max);
		expect(board.shots[1].camera.zoom).toBeCloseTo(ZOOM_BOUNDS.max, 4);
	});

	it("is a no-op when the knob is already against the bound it is asked to move toward", () => {
		const result = applyEdits(cleanStoryboard(), [
			{
				op: "adjustZoom",
				target: { by: "id", shotId: "shot-1" },
				amount: { kind: "relative", direction: "decrease", magnitude: "strong" },
			},
		]);
		expect(result.storyboard.shots[0].camera.zoom).toBe(ZOOM_BOUNDS.min);
		expect(result.clamps).toEqual([]);
	});

	it("moves a signed axis toward level rather than toward the negative bound", () => {
		const result = applyEdits(cleanStoryboard(), [
			{
				op: "adjustPoseAxis",
				target: { by: "id", shotId: "shot-1" },
				axis: "tiltX",
				amount: { kind: "relative", direction: "decrease", magnitude: "moderate" },
			},
		]);
		expect(result.storyboard.shots[0].camera.tiltX).toBeCloseTo(20 * 0.7, 6);
	});
});

describe("model numbers are clamped, and the clamp is reported", () => {
	it("clamps an unbounded absolute zoom and records what was asked for", () => {
		const result = applyEdits(cleanStoryboard(), [
			{
				op: "adjustZoom",
				target: { by: "id", shotId: "shot-1" },
				amount: { kind: "absolute", value: 9_999 },
			},
		]);
		expect(result.storyboard.shots[0].camera.zoom).toBe(ZOOM_BOUNDS.max);
		expect(result.clamps).toEqual([
			{ path: "shots[0].camera.zoom", requested: 9_999, applied: ZOOM_BOUNDS.max, bound: "max" },
		]);
	});

	it("clamps a runaway scale factor", () => {
		const result = applyEdits(cleanStoryboard(), [
			{
				op: "adjustZoom",
				target: { by: "id", shotId: "shot-2" },
				amount: { kind: "scale", factor: 100 },
			},
		]);
		expect(result.storyboard.shots[1].camera.zoom).toBe(ZOOM_BOUNDS.max);
		expect(result.clamps[0]?.bound).toBe("max");
	});

	it("clamps a transition duration to the sane ceiling", () => {
		const result = applyEdits(cleanStoryboard(), [
			{
				op: "adjustTransitionDuration",
				target: { by: "id", shotId: "shot-2" },
				amount: { kind: "absolute", value: 60_000 },
			},
		]);
		expect(result.storyboard.shots[1]).toMatchObject({ transitionDurationMs: 2_000 });
		expect(result.clamps[0]?.requested).toBe(60_000);
	});

	it("clamps the source timeline at zero rather than producing negative time", () => {
		const result = applyEdits(cleanStoryboard(), [
			{
				op: "adjustSpan",
				target: { by: "id", shotId: "shot-1" },
				edge: "start",
				amount: { kind: "absolute", value: 50_000 },
			},
		]);
		expect(result.storyboard.shots[0].sourceStartMs).toBe(0);
		expect(result.clamps[0]).toMatchObject({ path: "shots[0].sourceStartMs", bound: "min" });
	});
});

describe("an edit that breaks an editorial rule is rejected, not clamped", () => {
	it("rejects a shot trimmed below the minimum instead of pinning it to the minimum", () => {
		const outcome = applyRefinement(
			cleanStoryboard(),
			[
				{
					op: "adjustSpan",
					target: { by: "id", shotId: "shot-2" },
					edge: "end",
					amount: { kind: "absolute", value: 500 },
				},
			],
			{ context: CONTEXT }
		);

		expect(outcome.status).toBe("rejected");
		expect(codesOf(outcome)).toContain("shot_too_short");
		expect(outcome).not.toHaveProperty("storyboard");
		if (outcome.status === "rejected") expect(outcome.reason).toContain("shot-2");
	});

	it("rejects a hold that pushes the cut past the twelve-second maximum", () => {
		const outcome = applyRefinement(
			cleanStoryboard(),
			[
				{
					op: "adjustSpan",
					target: { by: "id", shotId: "shot-3" },
					edge: "end",
					amount: { kind: "absolute", value: 8_000 },
				},
			],
			{ context: CONTEXT }
		);
		expect(codesOf(outcome)).toContain("total_too_long");
	});

	it("rejects an extension that runs a shot into the next one", () => {
		const outcome = applyRefinement(
			cleanStoryboard(),
			[
				{
					op: "adjustSpan",
					target: { by: "id", shotId: "shot-1" },
					edge: "end",
					amount: { kind: "absolute", value: 5_000 },
				},
			],
			{ context: CONTEXT }
		);
		expect(codesOf(outcome)).toContain("overlapping_shots");
	});

	it("rejects a trim that drags a cut off its content beat", () => {
		const outcome = applyRefinement(
			cleanStoryboard(),
			[
				{
					op: "adjustSpan",
					target: { by: "id", shotId: "shot-2" },
					edge: "start",
					amount: { kind: "relative", direction: "decrease", magnitude: "moderate" },
				},
			],
			{ context: CONTEXT }
		);
		expect(codesOf(outcome)).toContain("boundary_not_on_beat");
	});

	it("rejects a reorder, because the protocol cannot express out-of-order playback", () => {
		const outcome = applyRefinement(
			cleanStoryboard(),
			[{ op: "reorderShots", order: ["shot-2", "shot-1", "shot-3"] }],
			{ context: CONTEXT }
		);
		expect(codesOf(outcome)).toContain("overlapping_shots");
	});

	it("rejects an order that is not a permutation of the shots it has", () => {
		const outcome = applyRefinement(
			cleanStoryboard(),
			[{ op: "reorderShots", order: ["shot-2", "shot-9", "shot-3"] }],
			{ context: CONTEXT }
		);
		expect(codesOf(outcome)).toEqual(["not_a_permutation"]);
	});

	it("rejects an edit aimed at a shot that does not exist", () => {
		const outcome = applyRefinement(
			cleanStoryboard(),
			[
				{
					op: "adjustZoom",
					target: { by: "index", index: 9 },
					amount: { kind: "relative", direction: "increase", magnitude: "slight" },
				},
			],
			{ context: CONTEXT }
		);
		expect(codesOf(outcome)).toEqual(["unresolved_target"]);
	});
});

describe("a violation the storyboard arrived with is not blamed on the edit", () => {
	it("applies an unrelated edit and reports the pre-existing violation as carried over", () => {
		const outcome = applyRefinement(leadInStoryboard(), [{ op: "setMusic", track: null }], {
			context: CONTEXT,
		});

		expect(outcome.status).toBe("applied");
		if (outcome.status !== "applied") return;
		expect(outcome.storyboard.music).toBeNull();
		expect(outcome.carriedOver.map((issue) => issue.code)).toEqual(["boundary_not_on_beat"]);
	});

	it("rejects the same edit under `all`, which is the compiler's own posture", () => {
		const outcome = applyRefinement(leadInStoryboard(), [{ op: "setMusic", track: null }], {
			context: CONTEXT,
			strictness: "all",
		});
		expect(codesOf(outcome)).toContain("boundary_not_on_beat");
	});

	it("still rejects an edit that makes the pre-existing violation worse", () => {
		const outcome = applyRefinement(
			leadInStoryboard(),
			[
				{
					op: "adjustSpan",
					target: { by: "id", shotId: "shot-2" },
					edge: "start",
					amount: { kind: "relative", direction: "decrease", magnitude: "moderate" },
				},
			],
			{ context: CONTEXT }
		);
		expect(codesOf(outcome)).toContain("boundary_not_on_beat");
	});
});

describe("the rest of the edit vocabulary", () => {
	it("changes the background, the aim and the transition", () => {
		const outcome = applyRefinement(
			cleanStoryboard(),
			[
				{ op: "setBackground", background: { type: "wallpaper", name: "dunes" } },
				{ op: "setAim", target: { by: "id", shotId: "shot-3" }, beatId: "b1" },
				{ op: "setTransition", target: { by: "id", shotId: "shot-2" }, transition: "dolly" },
				{ op: "setTransition", target: { by: "id", shotId: "shot-3" }, transition: "dolly" },
				{
					op: "adjustTransitionDuration",
					target: { by: "id", shotId: "shot-3" },
					amount: { kind: "relative", direction: "increase", magnitude: "moderate" },
				},
			],
			{ context: CONTEXT }
		);

		expect(outcome.status).toBe("applied");
		if (outcome.status !== "applied") return;
		expect(outcome.storyboard.background).toEqual({ type: "wallpaper", name: "dunes" });
		expect(outcome.storyboard.shots[2].aimBeatId).toBe("b1");
		expect(outcome.storyboard.shots[2].transitionIn).toBe("dolly");
		expect(outcome.storyboard.shots[2]).toMatchObject({ transitionDurationMs: 600 });
	});

	it("rejects a transition change that mixes two motion systems", () => {
		const board = cleanStoryboard();
		board.shots[1].transitionIn = "cut";
		const outcome = applyRefinement(
			board,
			[{ op: "setTransition", target: { by: "id", shotId: "shot-3" }, transition: "dolly" }],
			{ context: CONTEXT, strictness: "all" }
		);
		expect(codesOf(outcome)).toContain("mixed_motion_systems");
	});
});

describe("dry run and determinism", () => {
	it("previews without committing and without touching the input", () => {
		const board = cleanStoryboard();
		const snapshot = structuredClone(board);

		const outcome = applyRefinement(
			board,
			[
				{
					op: "adjustZoom",
					target: { by: "index", index: 2 },
					amount: { kind: "relative", direction: "increase", magnitude: "moderate" },
				},
			],
			{ context: CONTEXT, dryRun: true }
		);

		expect(outcome.status).toBe("preview");
		expect(board).toEqual(snapshot);
		if (outcome.status !== "preview") return;
		expect(outcome.diff.changes).toEqual([
			{ path: "shots[1].camera.zoom", before: "1.6", after: "1.87" },
		]);
		expect(renderDiff(outcome.diff)).toBe("shots[1].camera.zoom: 1.6 -> 1.87");
	});

	it("leaves the input alone on a committed refinement too", () => {
		const board = cleanStoryboard();
		const snapshot = structuredClone(board);
		applyRefinement(board, [{ op: "setMusic", track: "upbeat" }], { context: CONTEXT });
		expect(board).toEqual(snapshot);
	});

	it("renders an empty diff for an edit that changes nothing", () => {
		const board = cleanStoryboard();
		expect(diffStoryboards(board, board).changes).toEqual([]);
		expect(renderDiff({ changes: [] })).toBe("no changes");
	});

	it("produces byte-identical results across runs", async () => {
		const run = () =>
			refineStoryboard({
				storyboard: cleanStoryboard(),
				note: "tighter on shot 2",
				interpreter: phraseInterpreter(),
				beats: BEATS,
			});
		const [first, second] = await Promise.all([run(), run()]);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});
});

describe("the interpreter seam", () => {
	it("never reaches a provider: the injected interpreter sees the note and the storyboard", async () => {
		const interpret = vi.fn((_request: InterpretRequest): Edit[] => []);
		const interpreter: EditInterpreter = { interpret };
		const outcome = await refineStoryboard({
			storyboard: cleanStoryboard(),
			note: "make it pop",
			interpreter,
			beats: BEATS,
		});

		expect(interpret).toHaveBeenCalledTimes(1);
		expect(interpret.mock.calls[0]?.[0]).toMatchObject({ note: "make it pop" });
		expect(codesOf(outcome)).toEqual(["uninterpretable_note"]);
	});

	it("rejects interpreter output that does not typecheck rather than applying part of it", async () => {
		const interpreter: EditInterpreter = {
			interpret: () => [{ op: "adjustZoom", target: { by: "index", index: 1 }, amount: 3 }],
		};
		const outcome = await refineStoryboard({
			storyboard: cleanStoryboard(),
			note: "tighter on shot 1",
			interpreter,
			beats: BEATS,
		});
		expect(codesOf(outcome)).toEqual(["malformed_edits"]);
	});

	it("accepts an interpreter that wraps its edits in an object", async () => {
		const interpreter: EditInterpreter = {
			interpret: () => ({ edits: [{ op: "setMusic", track: null }] }),
		};
		const outcome = await refineStoryboard({
			storyboard: cleanStoryboard(),
			note: "lose the music",
			interpreter,
			beats: BEATS,
		});
		expect(outcome.status).toBe("applied");
	});

	it("applies a fixed edit list through the static interpreter", async () => {
		const outcome = await refineStoryboard({
			storyboard: cleanStoryboard(),
			note: "irrelevant",
			interpreter: staticInterpreter([{ op: "setMusic", track: "sparse-piano" }]),
			beats: BEATS,
		});
		expect(outcome.status).toBe("applied");
		if (outcome.status === "applied") expect(outcome.storyboard.music).toBe("sparse-piano");
	});
});

describe("the offline phrase reader", () => {
	it("reads 'tighter on shot 2' as a relative zoom on the second shot", async () => {
		const outcome = await refineStoryboard({
			storyboard: cleanStoryboard(),
			note: "tighter on shot 2",
			interpreter: phraseInterpreter(),
			beats: BEATS,
		});
		expect(outcome.edits).toEqual([
			{
				op: "adjustZoom",
				target: { by: "index", index: 2 },
				amount: { kind: "relative", direction: "increase", magnitude: "moderate" },
			},
		]);
		expect(outcome.status).toBe("applied");
	});

	it("reads 'lose the music'", async () => {
		const outcome = await refineStoryboard({
			storyboard: cleanStoryboard(),
			note: "lose the music",
			interpreter: phraseInterpreter(),
			beats: BEATS,
		});
		expect(outcome.status).toBe("applied");
		if (outcome.status === "applied") expect(outcome.storyboard.music).toBeNull();
	});

	it("reads 'less tilt on the opener' as two axes moving toward level", async () => {
		const outcome = await refineStoryboard({
			storyboard: cleanStoryboard(),
			note: "less tilt on the opener",
			interpreter: phraseInterpreter(),
			beats: BEATS,
		});
		expect(outcome.status).toBe("applied");
		if (outcome.status !== "applied") return;
		expect(outcome.storyboard.shots[0].camera.tiltX).toBeCloseTo(14, 6);
		expect(outcome.edits.map((edit) => edit.op)).toEqual(["adjustPoseAxis", "adjustPoseAxis"]);
	});

	it("reads 'cut the dead air at the start' as a head trim on the opening shot", async () => {
		const outcome = await refineStoryboard({
			storyboard: cleanStoryboard(),
			note: "cut the dead air at the start",
			interpreter: phraseInterpreter(),
			beats: BEATS,
		});
		expect(outcome.status).toBe("applied");
		if (outcome.status !== "applied") return;
		expect(outcome.storyboard.shots[0].sourceStartMs).toBeGreaterThan(800);
		expect(outcome.storyboard.shots[0].sourceEndMs).toBe(4_000);
	});

	it("finds the shot by the beat label the note mentions", async () => {
		const outcome = await refineStoryboard({
			storyboard: cleanStoryboard(),
			note: "hold the pricing page longer",
			interpreter: phraseInterpreter(),
			beats: BEATS,
		});
		expect(outcome.edits).toEqual([
			{
				op: "adjustSpan",
				target: { by: "id", shotId: "shot-2" },
				edge: "end",
				amount: { kind: "relative", direction: "increase", magnitude: "moderate" },
			},
		]);
		expect(codesOf(outcome)).toContain("overlapping_shots");
	});

	it("scales the magnitude with the hedging in the note", async () => {
		const outcome = await refineStoryboard({
			storyboard: cleanStoryboard(),
			note: "a bit tighter on shot 1",
			interpreter: phraseInterpreter(),
			beats: BEATS,
		});
		expect(outcome.edits[0]).toMatchObject({ amount: { magnitude: "slight" } });
	});
});

describe("refinement audit", () => {
	it("rejects two edits that are each legal alone but together overrun the cut", () => {
		const holdLast: Edit = {
			op: "adjustSpan",
			target: { by: "id", shotId: "shot-3" },
			edge: "end",
			amount: { kind: "absolute", value: 5_500 },
		};
		const openEarlier: Edit = {
			op: "adjustSpan",
			target: { by: "id", shotId: "shot-1" },
			edge: "start",
			amount: { kind: "absolute", value: 4_000 },
		};
		expect(applyRefinement(cleanStoryboard(), [holdLast], { context: CONTEXT }).status).toBe(
			"applied"
		);
		expect(applyRefinement(cleanStoryboard(), [openEarlier], { context: CONTEXT }).status).toBe(
			"applied"
		);
		const both = applyRefinement(cleanStoryboard(), [holdLast, openEarlier], { context: CONTEXT });
		expect(both.status).toBe("rejected");
		expect(codesOf(both)).toContain("total_too_long");
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"rejects a span adjustment of %s instead of applying it",
		(value) => {
			const outcome = applyRefinement(
				cleanStoryboard(),
				[
					{
						op: "adjustSpan",
						target: { by: "id", shotId: "shot-3" },
						edge: "end",
						amount: { kind: "absolute", value },
					},
				],
				{ context: CONTEXT }
			);
			expect(outcome.status).toBe("rejected");
			expect(codesOf(outcome)).toContain("malformed_edits");
		}
	);

	it.each(["adjustZoom", "adjustTransitionDuration"] as const)(
		"rejects a non-finite %s rather than clamping it",
		(op) => {
			const outcome = applyRefinement(
				cleanStoryboard(),
				[{ op, target: { by: "id", shotId: "shot-2" }, amount: { kind: "scale", factor: Number.NaN } }],
				{ context: CONTEXT }
			);
			expect(outcome.status).toBe("rejected");
			expect(codesOf(outcome)).toContain("malformed_edits");
		}
	);

	it("rejects a non-finite pose axis edit rather than applying it", () => {
		const outcome = applyRefinement(
			cleanStoryboard(),
			[
				{
					op: "adjustPoseAxis",
					target: { by: "id", shotId: "shot-1" },
					axis: "roll",
					amount: { kind: "absolute", value: Number.NaN },
				},
			],
			{ context: CONTEXT }
		);
		expect(outcome.status).toBe("rejected");
	});

	it("reports a NaN span as an empty shot", () => {
		const board = cleanStoryboard();
		board.shots[2].sourceEndMs = Number.NaN;
		expect(validateEditorial(board, CONTEXT).map((i) => i.code)).toContain("empty_shot");
	});

	it.each(["roll", "rotateY", "fov"] as const)(
		"catches a non-finite %s, which the Rust checker also inspects",
		(axis) => {
			const board = cleanStoryboard();
			board.shots[0].camera[axis] = Number.NaN;
			expect(validateEditorial(board, CONTEXT).map((i) => i.code)).toContain("non_finite_pose");
		}
	);

	it("is a no-op with no clamp note when 'tighter' lands on a shot already at maximum zoom", () => {
		const board = cleanStoryboard();
		board.shots[1].camera.zoom = ZOOM_BOUNDS.max;
		const result = applyEdits(board, [
			{
				op: "adjustZoom",
				target: { by: "id", shotId: "shot-2" },
				amount: { kind: "relative", direction: "increase", magnitude: "strong" },
			},
		]);
		expect(result.storyboard.shots[1].camera.zoom).toBe(ZOOM_BOUNDS.max);
		expect(result.clamps).toEqual([]);
	});
});
