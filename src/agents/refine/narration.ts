/**
 * A spoken script derived from the beat log.
 *
 * The beat log already knows when every meaningful moment happened, what kind it was and what it
 * was called, so a script built from it is synchronised to the footage by construction rather than
 * timed by hand afterwards. Each narratable beat gets a slot that runs until the next narratable
 * beat, and a line that has to fit inside it.
 *
 * Fitting is enforced, not hoped for. A line that overruns its slot pushes every later line late
 * and desynchronises the whole script, which is worse than having no script: the overrunning line
 * is dropped, or shortened to the number of words its slot can actually hold, and either way the
 * caller is told which line it was.
 *
 * Output is text only. No TTS: synthesis is out of scope, and the numbers below are a speaking-rate
 * budget rather than a measurement of any particular voice.
 */

import { z } from "zod";
import type { Beat, BeatKind, Storyboard } from "../runner/protocol";

/**
 * 150 words per minute.
 *
 * Unhurried explanatory narration — documentary voice-over, audiobooks, product demos — sits in the
 * 140-160 wpm band; conversational speech runs faster, up to about 190, and reads as rushed over a
 * screen recording where the viewer is also reading the screen. 150 is the middle of that band and
 * divides evenly: exactly 400ms per word, which keeps every budget in this module an integer.
 *
 * It is deliberately a conservative estimate. Underestimating the rate makes a line fit that could
 * have been longer; overestimating it ships a script that overruns in the booth.
 */
export const NARRATION_WORDS_PER_MINUTE = 150;

export const NARRATION_MS_PER_WORD = 60_000 / NARRATION_WORDS_PER_MINUTE;

/**
 * Silence kept at the end of every slot so a line lands before the next beat rather than on top of
 * it. Roughly one word's worth, which is about the length of the breath between two sentences.
 */
export const NARRATION_TAIL_MS = 400;

const NARRATABLE_KINDS: ReadonlySet<BeatKind> = new Set<BeatKind>([
	"action",
	"reveal",
	"typing",
	"transition",
]);

export interface NarrationSlot {
	beatId: string;
	kind: BeatKind;
	label: string;
	/** Position on the timeline the script is written against, in milliseconds. */
	startMs: number;
	endMs: number;
	/** How much of the slot a line may occupy: its length less `NARRATION_TAIL_MS`. */
	budgetMs: number;
}

export interface NarrationSlotInput {
	beats: Beat[];
	/** Length of the source recording, used to close the last slot. */
	durationMs: number;
	/**
	 * When given, slots are placed on the *cut* timeline: beats outside every shot are dropped and
	 * the rest are rebased onto the running output time, so the script matches the video that will
	 * be rendered rather than the raw footage.
	 */
	storyboard?: Storyboard;
}

function narratable(beats: Beat[]): Beat[] {
	return beats
		.filter((beat) => NARRATABLE_KINDS.has(beat.kind))
		.slice()
		.sort((a, b) => a.offsetMs - b.offsetMs || a.beatId.localeCompare(b.beatId));
}

interface PlacedBeat {
	beat: Beat;
	startMs: number;
	/** End of the shot the beat sits in, on the same timeline. */
	limitMs: number;
}

function placeOnSource(beats: Beat[], durationMs: number): PlacedBeat[] {
	return beats.map((beat) => ({ beat, startMs: beat.offsetMs, limitMs: durationMs }));
}

function placeOnCut(beats: Beat[], storyboard: Storyboard): PlacedBeat[] {
	const placed: PlacedBeat[] = [];
	let outputStartMs = 0;
	for (const shot of storyboard.shots) {
		const span = Math.max(0, shot.sourceEndMs - shot.sourceStartMs);
		for (const beat of beats) {
			if (beat.offsetMs < shot.sourceStartMs || beat.offsetMs >= shot.sourceEndMs) continue;
			placed.push({
				beat,
				startMs: outputStartMs + (beat.offsetMs - shot.sourceStartMs),
				limitMs: outputStartMs + span,
			});
		}
		outputStartMs += span;
	}
	return placed.sort((a, b) => a.startMs - b.startMs || a.beat.beatId.localeCompare(b.beat.beatId));
}

export function narrationSlots(input: NarrationSlotInput): NarrationSlot[] {
	const beats = narratable(input.beats);
	const placed =
		input.storyboard === undefined
			? placeOnSource(beats, Math.max(0, input.durationMs))
			: placeOnCut(beats, input.storyboard);

	return placed.map((entry, index) => {
		const next = placed[index + 1];
		const endMs = next === undefined ? entry.limitMs : Math.min(next.startMs, entry.limitMs);
		const slotMs = Math.max(0, endMs - entry.startMs);
		return {
			beatId: entry.beat.beatId,
			kind: entry.beat.kind,
			label: entry.beat.label,
			startMs: entry.startMs,
			endMs: entry.startMs + slotMs,
			budgetMs: Math.max(0, slotMs - NARRATION_TAIL_MS),
		};
	});
}

export const NarrationDraftSchema = z.object({ beatId: z.string().min(1), text: z.string() });
export type NarrationDraft = z.infer<typeof NarrationDraftSchema>;

const NarrationWriterOutputSchema = z.union([
	z.array(NarrationDraftSchema),
	z
		.record(z.string(), z.string())
		.transform((value) =>
			Object.entries(value).map(([beatId, text]) => ({ beatId, text }))
		),
]);

export interface NarrationWriter {
	write(slots: NarrationSlot[]): Promise<unknown> | unknown;
}

const KIND_TEMPLATES: Record<BeatKind, (label: string) => string> = {
	action: (label) => `Click ${label}.`,
	reveal: (label) => `Here is ${label}.`,
	typing: (label) => `Type ${label}.`,
	transition: (label) => `${label} loads.`,
	idle: (label) => `${label}.`,
};

/** The hermetic default: a line per beat, derived from its kind and label. No provider. */
export function labelNarrationWriter(): NarrationWriter {
	return {
		write(slots: NarrationSlot[]): NarrationDraft[] {
			return slots.map((slot) => ({
				beatId: slot.beatId,
				text: KIND_TEMPLATES[slot.kind](slot.label),
			}));
		},
	};
}

export function countWords(text: string): number {
	return text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
}

export function spokenDurationMs(text: string): number {
	return countWords(text) * NARRATION_MS_PER_WORD;
}

export type OverrunPolicy = "reject" | "shorten";

export interface NarrationLine {
	beatId: string;
	startMs: number;
	budgetMs: number;
	spokenMs: number;
	text: string;
	wordCount: number;
	shortened: boolean;
}

export type NarrationIssueCode =
	| "line_overruns_slot"
	| "slot_too_short"
	| "unknown_beat"
	| "empty_line"
	| "malformed_draft";

export interface NarrationIssue {
	code: NarrationIssueCode;
	message: string;
	beatId?: string;
}

export interface NarrationScript {
	lines: NarrationLine[];
	issues: NarrationIssue[];
	wordsPerMinute: number;
	/** End of the last slot, so a caller can see the script covers the cut. */
	durationMs: number;
}

export interface ComposeNarrationOptions {
	overrun?: OverrunPolicy;
}

function shorten(text: string, maxWords: number): string {
	const words = text.trim().split(/\s+/).slice(0, maxWords);
	const joined = words.join(" ").replace(/[,;:]+$/, "");
	return /[.!?]$/.test(joined) ? joined : `${joined}.`;
}

export function composeNarration(
	slots: NarrationSlot[],
	drafts: NarrationDraft[],
	options: ComposeNarrationOptions = {}
): NarrationScript {
	const policy = options.overrun ?? "reject";
	const bySlot = new Map(slots.map((slot) => [slot.beatId, slot]));
	const lines: NarrationLine[] = [];
	const issues: NarrationIssue[] = [];

	for (const draft of drafts) {
		const slot = bySlot.get(draft.beatId);
		if (slot === undefined) {
			issues.push({
				code: "unknown_beat",
				message: `Draft line for beat ${draft.beatId} has no slot in this cut.`,
				beatId: draft.beatId,
			});
			continue;
		}

		const words = countWords(draft.text);
		if (words === 0) {
			issues.push({
				code: "empty_line",
				message: `Draft line for beat ${draft.beatId} is empty.`,
				beatId: draft.beatId,
			});
			continue;
		}

		const spokenMs = words * NARRATION_MS_PER_WORD;
		if (spokenMs <= slot.budgetMs) {
			lines.push({
				beatId: slot.beatId,
				startMs: slot.startMs,
				budgetMs: slot.budgetMs,
				spokenMs,
				text: draft.text.trim(),
				wordCount: words,
				shortened: false,
			});
			continue;
		}

		const maxWords = Math.floor(slot.budgetMs / NARRATION_MS_PER_WORD);
		if (policy === "reject" || maxWords < 1) {
			issues.push({
				code: maxWords < 1 ? "slot_too_short" : "line_overruns_slot",
				message:
					maxWords < 1
						? `Beat ${slot.beatId} has ${slot.budgetMs}ms of speakable room, not enough for a single word at ${NARRATION_WORDS_PER_MINUTE}wpm.`
						: `Line for beat ${slot.beatId} needs ${spokenMs}ms at ${NARRATION_WORDS_PER_MINUTE}wpm but its slot holds ${slot.budgetMs}ms.`,
				beatId: slot.beatId,
			});
			continue;
		}

		const text = shorten(draft.text, maxWords);
		lines.push({
			beatId: slot.beatId,
			startMs: slot.startMs,
			budgetMs: slot.budgetMs,
			spokenMs: maxWords * NARRATION_MS_PER_WORD,
			text,
			wordCount: maxWords,
			shortened: true,
		});
		issues.push({
			code: "line_overruns_slot",
			message: `Line for beat ${slot.beatId} was shortened from ${words} to ${maxWords} word(s) to fit ${slot.budgetMs}ms.`,
			beatId: slot.beatId,
		});
	}

	lines.sort((a, b) => a.startMs - b.startMs || a.beatId.localeCompare(b.beatId));

	return {
		lines,
		issues,
		wordsPerMinute: NARRATION_WORDS_PER_MINUTE,
		durationMs: slots.reduce((end, slot) => Math.max(end, slot.endMs), 0),
	};
}

export interface BuildNarrationScriptInput extends NarrationSlotInput, ComposeNarrationOptions {
	writer?: NarrationWriter;
}

export async function buildNarrationScript(
	input: BuildNarrationScriptInput
): Promise<NarrationScript> {
	const slots = narrationSlots(input);
	const writer = input.writer ?? labelNarrationWriter();
	const raw = await writer.write(slots);
	const parsed = NarrationWriterOutputSchema.safeParse(raw);

	if (!parsed.success) {
		return {
			lines: [],
			issues: [
				{
					code: "malformed_draft",
					message: `The writer returned lines that do not typecheck: ${parsed.error.issues
						.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
						.join("; ")}.`,
				},
			],
			wordsPerMinute: NARRATION_WORDS_PER_MINUTE,
			durationMs: slots.reduce((end, slot) => Math.max(end, slot.endMs), 0),
		};
	}

	const options: ComposeNarrationOptions = {};
	if (input.overrun !== undefined) options.overrun = input.overrun;
	return composeNarration(slots, parsed.data, options);
}

export function formatTimestamp(ms: number): string {
	const total = Math.max(0, Math.round(ms));
	const minutes = Math.floor(total / 60_000);
	const seconds = Math.floor((total % 60_000) / 1_000);
	const millis = total % 1_000;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function seconds(ms: number): string {
	return `${(ms / 1_000).toFixed(1)}s`;
}

/** Plain-text script with timestamps. Deterministic for a given script. */
export function renderNarrationScript(script: NarrationScript): string {
	const header = `# Narration — ${script.lines.length} line(s), ${formatTimestamp(script.durationMs)} of cut, ${script.wordsPerMinute} wpm`;
	const body = script.lines.map(
		(line) =>
			`[${formatTimestamp(line.startMs)}] ${line.text}  (${seconds(line.spokenMs)} of ${seconds(line.budgetMs)}${line.shortened ? ", shortened" : ""})`
	);
	const footer = script.issues.map((issue) => `! ${issue.code}: ${issue.message}`);
	return [header, ...body, ...footer].join("\n");
}
