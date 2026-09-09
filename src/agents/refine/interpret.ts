/**
 * The model seam.
 *
 * Interpretation of a note is the only part of refinement that wants a language model, so it is
 * the only part behind an interface. Everything downstream — resolution, application, validation,
 * diffing — is pure and runs identically whether the edits came from a provider, from a fixture,
 * or from the offline phrase reader below. Tests inject an interpreter and never reach the network.
 *
 * Interpreter output is untrusted: it arrives as `unknown` and is parsed with `EditListSchema`, so
 * a malformed or hallucinated operation becomes a rejection rather than a partially applied edit.
 */

import { z } from "zod";
import type { Beat, Storyboard } from "../runner/protocol";
import { targetIndex } from "./apply";
import {
	type Adjustment,
	type AdjustmentMagnitude,
	type Edit,
	EditListSchema,
	type ShotTarget,
} from "./types";

export interface InterpretRequest {
	note: string;
	storyboard: Storyboard;
	beats?: Beat[];
}

export interface EditInterpreter {
	interpret(request: InterpretRequest): Promise<unknown> | unknown;
}

const InterpreterOutputSchema = z.union([
	EditListSchema,
	z.object({ edits: EditListSchema }).transform((value) => value.edits),
]);

export interface ParsedEdits {
	ok: boolean;
	edits: Edit[];
	message?: string;
}

export function parseInterpreterOutput(output: unknown): ParsedEdits {
	const parsed = InterpreterOutputSchema.safeParse(output);
	if (!parsed.success) {
		return {
			ok: false,
			edits: [],
			message: parsed.error.issues
				.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
				.join("; "),
		};
	}
	return { ok: true, edits: parsed.data };
}

/** An interpreter that returns a fixed edit list. The hermetic default for tests. */
export function staticInterpreter(edits: Edit[]): EditInterpreter {
	return { interpret: () => edits };
}

const MAGNITUDE_PHRASES: Array<[RegExp, AdjustmentMagnitude]> = [
	[/\b(a lot|much|way|far|considerably)\b/, "strong"],
	[/\b(a bit|a touch|slightly|a little|marginally)\b/, "slight"],
];

function magnitudeOf(note: string): AdjustmentMagnitude {
	for (const [pattern, magnitude] of MAGNITUDE_PHRASES) {
		if (pattern.test(note)) return magnitude;
	}
	return "moderate";
}

function relative(direction: "increase" | "decrease", note: string): Adjustment {
	return { kind: "relative", direction, magnitude: magnitudeOf(note) };
}

function targetOf(note: string, request: InterpretRequest): ShotTarget | undefined {
	const numbered = /\bshot\s+(\d+)\b/.exec(note);
	if (numbered) return { by: "index", index: Number(numbered[1]) };
	if (/\b(opener|opening|first shot|intro)\b/.test(note)) return { by: "ordinal", ordinal: "first" };
	if (/\b(last shot|final shot|closer|ending|outro)\b/.test(note))
		return { by: "ordinal", ordinal: "last" };

	const beats = request.beats ?? [];
	for (const beat of beats) {
		const label = beat.label.trim().toLowerCase();
		if (label.length === 0 || !note.includes(label)) continue;
		const shot = request.storyboard.shots.find((candidate) => candidate.aimBeatId === beat.beatId);
		if (shot) return { by: "id", shotId: shot.shotId };
	}
	return undefined;
}

/**
 * A deterministic, offline reader for the handful of note shapes this feature was specified
 * against. It is a stand-in for a model, not a natural-language understander: it recognises a fixed
 * vocabulary and stays silent on anything else, which is why an unrecognised note produces no edits
 * and is rejected rather than guessed at.
 */
export function phraseInterpreter(): EditInterpreter {
	return {
		interpret(request: InterpretRequest): Edit[] {
			const note = request.note.toLowerCase();
			const edits: Edit[] = [];
			const target = targetOf(note, request);

			if (/\b(lose|drop|kill|remove|no)\b[^.]*\bmusic\b/.test(note)) {
				edits.push({ op: "setMusic", track: null });
			}

			if (/\b(tighter|tighten|closer|punch in|push in)\b/.test(note) && target) {
				edits.push({ op: "adjustZoom", target, amount: relative("increase", note) });
			} else if (/\b(wider|widen|pull back|looser|back off)\b/.test(note) && target) {
				edits.push({ op: "adjustZoom", target, amount: relative("decrease", note) });
			}

			if (/\bless tilt\b|\bflatten\b|\bless angle\b/.test(note)) {
				const tiltTarget: ShotTarget = target ?? { by: "ordinal", ordinal: "first" };
				edits.push({
					op: "adjustPoseAxis",
					target: tiltTarget,
					axis: "tiltX",
					amount: relative("decrease", note),
				});
				edits.push({
					op: "adjustPoseAxis",
					target: tiltTarget,
					axis: "tiltY",
					amount: relative("decrease", note),
				});
			}

			if (/\bdead air\b|\btrim the (start|head|top)\b/.test(note)) {
				const trimTarget: ShotTarget = /\b(end|tail)\b/.test(note)
					? { by: "ordinal", ordinal: "last" }
					: { by: "ordinal", ordinal: "first" };
				edits.push({
					op: "adjustSpan",
					target: trimTarget,
					edge: /\b(end|tail)\b/.test(note) ? "end" : "start",
					amount: relative("decrease", note),
				});
			} else if (/\b(hold|longer|linger|stay on)\b/.test(note) && target) {
				edits.push({ op: "adjustSpan", target, edge: "end", amount: relative("increase", note) });
			} else if (/\b(shorter|quicker|faster|snappier)\b/.test(note) && target) {
				edits.push({ op: "adjustSpan", target, edge: "end", amount: relative("decrease", note) });
			}

			return edits.filter((edit) => !("target" in edit) || targetIndex(request.storyboard.shots, edit.target) >= 0);
		},
	};
}
