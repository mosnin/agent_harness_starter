import { describe, expect, it } from "vitest";
import {
	NARRATION_MS_PER_WORD,
	NARRATION_TAIL_MS,
	NARRATION_WORDS_PER_MINUTE,
	type NarrationWriter,
	buildNarrationScript,
	composeNarration,
	countWords,
	formatTimestamp,
	labelNarrationWriter,
	narrationSlots,
	renderNarrationScript,
	spokenDurationMs,
} from "../refine";
import { NEUTRAL_CAMERA } from "../tools/cap/storyboard";
import type { Beat, Shot, Storyboard } from "../tools/cap/types";

const BEATS: Beat[] = [
	{ beatId: "n1", offsetMs: 1_000, kind: "action", label: "Sign up", landmark: null },
	{
		beatId: "n2",
		offsetMs: 4_000,
		kind: "typing",
		label: "your email address here",
		landmark: null,
	},
	{ beatId: "n3", offsetMs: 7_000, kind: "reveal", label: "the dashboard", landmark: null },
	{ beatId: "n4", offsetMs: 7_100, kind: "idle", label: "settle", landmark: null },
];

function shot(shotId: string, sourceStartMs: number, sourceEndMs: number): Shot {
	return {
		shotId,
		sourceStartMs,
		sourceEndMs,
		camera: { ...NEUTRAL_CAMERA },
		aimBeatId: null,
		transitionIn: "none",
		recordingSegment: 0,
		transitionDurationMs: 0,
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

describe("the speaking-rate budget", () => {
	it("is 150 words per minute, which is exactly 400ms a word", () => {
		expect(NARRATION_WORDS_PER_MINUTE).toBe(150);
		expect(NARRATION_MS_PER_WORD).toBe(400);
	});

	it("measures a line by its words", () => {
		expect(countWords("  Click   Sign up. ")).toBe(3);
		expect(countWords("   ")).toBe(0);
		expect(spokenDurationMs("Click Sign up.")).toBe(1_200);
	});
});

describe("slots come from the beat log", () => {
	it("runs each narratable beat until the next one, less the tail gap", () => {
		const slots = narrationSlots({ beats: BEATS, durationMs: 9_000 });
		expect(slots.map((slot) => slot.beatId)).toEqual(["n1", "n2", "n3"]);
		expect(slots[0]).toMatchObject({ startMs: 1_000, endMs: 4_000, budgetMs: 3_000 - NARRATION_TAIL_MS });
		expect(slots[2]).toMatchObject({ startMs: 7_000, endMs: 9_000, budgetMs: 1_600 });
	});

	it("rebases onto the cut when a storyboard is given, dropping footage the cut removed", () => {
		const board = storyboardOf([shot("shot-1", 1_000, 5_000), shot("shot-2", 6_000, 9_000)]);
		const beats: Beat[] = [
			...BEATS,
			{ beatId: "n5", offsetMs: 5_500, kind: "action", label: "off camera", landmark: null },
		];
		const slots = narrationSlots({ beats, durationMs: 9_000, storyboard: board });

		expect(slots.map((slot) => slot.beatId)).toEqual(["n1", "n2", "n3"]);
		expect(slots.map((slot) => slot.startMs)).toEqual([0, 3_000, 5_000]);
		expect(slots[1]).toMatchObject({ endMs: 4_000, budgetMs: 600 });
	});
});

describe("a line has to fit its slot", () => {
	it("writes a script from the beat log that fits", async () => {
		const script = await buildNarrationScript({ beats: BEATS, durationMs: 9_000 });

		expect(script.issues).toEqual([]);
		expect(script.lines.map((line) => line.text)).toEqual([
			"Click Sign up.",
			"Type your email address here.",
			"Here is the dashboard.",
		]);
		for (const line of script.lines) expect(line.spokenMs).toBeLessThanOrEqual(line.budgetMs);
	});

	it("rejects a line that cannot be spoken in its slot, naming the line", async () => {
		const writer: NarrationWriter = {
			write: (slots) =>
				slots.map((slot) => ({
					beatId: slot.beatId,
					text:
						slot.beatId === "n3"
							? "And here at last is the dashboard everything so far has been building toward."
							: "Short line.",
				})),
		};
		const script = await buildNarrationScript({ beats: BEATS, durationMs: 9_000, writer });

		expect(script.lines.map((line) => line.beatId)).toEqual(["n1", "n2"]);
		expect(script.issues).toHaveLength(1);
		expect(script.issues[0]).toMatchObject({ code: "line_overruns_slot", beatId: "n3" });
		expect(script.issues[0]?.message).toContain("1600ms");
	});

	it("shortens to the word count the slot can hold when asked to", async () => {
		const writer: NarrationWriter = {
			write: (slots) =>
				slots.map((slot) => ({
					beatId: slot.beatId,
					text: "And here at last is the dashboard everything has been building toward.",
				})),
		};
		const script = await buildNarrationScript({
			beats: BEATS,
			durationMs: 9_000,
			writer,
			overrun: "shorten",
		});

		const last = script.lines.at(-1);
		expect(last).toMatchObject({ beatId: "n3", shortened: true, wordCount: 4 });
		expect(last?.text).toBe("And here at last.");
		expect(last?.spokenMs).toBeLessThanOrEqual(last?.budgetMs ?? 0);
		expect(script.issues.every((issue) => issue.code === "line_overruns_slot")).toBe(true);
	});

	it("drops a line outright when the slot cannot hold a single word", async () => {
		const beats: Beat[] = [
			{ beatId: "t1", offsetMs: 0, kind: "action", label: "Open", landmark: null },
			{ beatId: "t2", offsetMs: 300, kind: "reveal", label: "the panel", landmark: null },
		];
		const script = await buildNarrationScript({ beats, durationMs: 4_000, overrun: "shorten" });

		expect(script.lines.map((line) => line.beatId)).toEqual(["t2"]);
		expect(script.issues[0]).toMatchObject({ code: "slot_too_short", beatId: "t1" });
	});

	it("catches the overrun the cut introduces, not the one the raw footage would have hidden", async () => {
		const board = storyboardOf([shot("shot-1", 1_000, 5_000), shot("shot-2", 6_000, 9_000)]);
		const loose = await buildNarrationScript({ beats: BEATS, durationMs: 9_000 });
		const tight = await buildNarrationScript({
			beats: BEATS,
			durationMs: 9_000,
			storyboard: board,
		});

		expect(loose.issues).toEqual([]);
		expect(tight.issues.map((issue) => issue.beatId)).toEqual(["n2"]);
	});

	it("flags a draft line for a beat that is not in this cut", () => {
		const slots = narrationSlots({ beats: BEATS, durationMs: 9_000 });
		const script = composeNarration(slots, [{ beatId: "nope", text: "Hello." }]);
		expect(script.issues[0]).toMatchObject({ code: "unknown_beat", beatId: "nope" });
		expect(script.lines).toEqual([]);
	});

	it("rejects writer output that does not typecheck", async () => {
		const writer = { write: () => [{ beatId: "n1" }] };
		const script = await buildNarrationScript({ beats: BEATS, durationMs: 9_000, writer });
		expect(script.issues[0]?.code).toBe("malformed_draft");
		expect(script.lines).toEqual([]);
	});

	it("accepts a writer that keys its lines by beat id", async () => {
		const writer: NarrationWriter = {
			write: () => ({ n1: "One.", n2: "Two.", n3: "Three." }),
		};
		const script = await buildNarrationScript({ beats: BEATS, durationMs: 9_000, writer });
		expect(script.lines.map((line) => line.text)).toEqual(["One.", "Two.", "Three."]);
	});
});

describe("the rendered script", () => {
	it("carries a timestamp and a budget for every line", async () => {
		const script = await buildNarrationScript({ beats: BEATS, durationMs: 9_000 });
		const text = renderNarrationScript(script);

		expect(text.split("\n")).toEqual([
			"# Narration — 3 line(s), 00:09.000 of cut, 150 wpm",
			"[00:01.000] Click Sign up.  (1.2s of 2.6s)",
			"[00:04.000] Type your email address here.  (2.0s of 2.6s)",
			"[00:07.000] Here is the dashboard.  (1.6s of 1.6s)",
		]);
	});

	it("formats timestamps past a minute", () => {
		expect(formatTimestamp(0)).toBe("00:00.000");
		expect(formatTimestamp(72_345)).toBe("01:12.345");
	});

	it("is identical across runs for the same beats and the same writer", async () => {
		const first = await buildNarrationScript({
			beats: BEATS,
			durationMs: 9_000,
			writer: labelNarrationWriter(),
		});
		const second = await buildNarrationScript({
			beats: BEATS,
			durationMs: 9_000,
			writer: labelNarrationWriter(),
		});

		expect(first).toEqual(second);
		expect(renderNarrationScript(first)).toBe(renderNarrationScript(second));
	});

	it("orders lines by start time regardless of the order the writer returned them in", () => {
		const slots = narrationSlots({ beats: BEATS, durationMs: 9_000 });
		const script = composeNarration(slots, [
			{ beatId: "n3", text: "Third." },
			{ beatId: "n1", text: "First." },
			{ beatId: "n2", text: "Second." },
		]);
		expect(script.lines.map((line) => line.text)).toEqual(["First.", "Second.", "Third."]);
	});
});
