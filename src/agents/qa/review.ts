/**
 * Frame QA on the rendered export — SKILL.md step 4, the pass that separates the ~95% agent
 * path from the ~70% deterministic one.
 *
 * Two of the six checks are measurements rather than judgements (`fps_judder` from the capture
 * rate, `music_fade` from the audio tail), so they are computed here and handed to the model as
 * context instead of being guessed from stills. The model's own decision may be more severe than
 * its findings imply, never less: a downgrade is a fail-open and is rejected.
 */

import { z } from "zod";
import type { Beat, Storyboard } from "../tools/cap/types";
import {
	type ExtractedFrame,
	type FrameEnv,
	type FrameSample,
	extractFrames,
	probeAudioWindow,
} from "./frames";
import {
	type VisionQaModel,
	assertConfident,
	parseQaResponse,
	toVisionFrames,
} from "./model";

export const QaCheckSchema = z.enum([
	"beat_readable",
	"typing_aim",
	"window_bleed",
	"loading_leak",
	"fps_judder",
	"music_fade",
]);
export type QaCheck = z.infer<typeof QaCheckSchema>;

export const QaDecisionSchema = z.enum(["accept", "reshoot", "re_export"]);
export type QaDecision = z.infer<typeof QaDecisionSchema>;

export const QaRemedySchema = z.enum(["none", "reshoot", "re_export"]);
export type QaRemedy = z.infer<typeof QaRemedySchema>;

/** The checks a still frame can answer. The rest are measured. */
export const VISION_CHECKS: QaCheck[] = [
	"beat_readable",
	"typing_aim",
	"window_bleed",
	"loading_leak",
];

/** What a defect in each check costs: only a bad capture is worth another shoot. */
export const REMEDY_FOR_CHECK: Record<QaCheck, Exclude<QaRemedy, "none">> = {
	beat_readable: "re_export",
	typing_aim: "re_export",
	window_bleed: "reshoot",
	loading_leak: "re_export",
	fps_judder: "re_export",
	music_fade: "re_export",
};

export const CHECK_PROMPTS: Record<QaCheck, string> = {
	beat_readable:
		"beat_readable — every beat frame reads: the content the beat promised is legible and framed, not cropped or pushed so tight it stops reading. Browser-window captures fill the 3D card more than the full-desktop captures the poses were tuned on, so a shot that reads ~30% too tight needs the zoom backed off.",
	typing_aim:
		"typing_aim — a typing beat is aimed at the text-entry point (the caret, at the start of the field's text), not the centre of the field.",
	window_bleed:
		"window_bleed — no window chrome, desktop, wallpaper or Finder window bleeds in at the edges of the frame, and nothing bleeds into the bottom of a clip tail.",
	loading_leak:
		"loading_leak — no loading spinner, skeleton or blur-up placeholder leaks into a shot tail; cuts land on loaded content.",
	fps_judder:
		"fps_judder — the export rate matches the real capture rate (measured below); forcing 60 on a ~58fps capture judders.",
	music_fade:
		"music_fade — the music fades out at the tail instead of stopping dead (measured below).",
};

export interface FindingRefinementCtx {
	addIssue: (issue: { code: "custom"; path: PropertyKey[]; message: string }) => void;
}

export interface LocatedFinding {
	status: "pass" | "fail";
	beatId: string | null;
	shotId?: string | null;
	sampleId: string | null;
	defect: string;
	remedy: string;
}

/** A verdict nobody can act on is not a verdict: a failure must name a place and a defect. */
export function refineLocatedFinding(
	finding: LocatedFinding,
	ctx: FindingRefinementCtx
): void {
	if (finding.status === "pass") return;
	if (finding.remedy === "none") {
		ctx.addIssue({
			code: "custom",
			path: ["remedy"],
			message: 'a failing check must name a remedy, not "none"',
		});
	}
	if (!finding.beatId && !finding.shotId && !finding.sampleId) {
		ctx.addIssue({
			code: "custom",
			path: ["beatId"],
			message: "a failing check must name the beat, shot or frame the defect is in",
		});
	}
	if (finding.defect.trim().length < 12) {
		ctx.addIssue({
			code: "custom",
			path: ["defect"],
			message: "a failing check must describe the defect, not just restate the check",
		});
	}
}

export const QaFindingSchema = z
	.object({
		check: QaCheckSchema,
		status: z.enum(["pass", "fail"]),
		beatId: z.string().min(1).nullable(),
		shotId: z.string().min(1).nullable(),
		sampleId: z.string().min(1).nullable(),
		defect: z.string().min(1),
		remedy: QaRemedySchema,
	})
	.superRefine(refineLocatedFinding);
export type QaFinding = z.infer<typeof QaFindingSchema>;

const SEVERITY: Record<QaDecision, number> = { accept: 0, re_export: 1, reshoot: 2 };

export function deriveDecision(findings: QaFinding[]): QaDecision {
	let decision: QaDecision = "accept";
	for (const finding of findings) {
		if (finding.status !== "fail") continue;
		const remedy: QaDecision = finding.remedy === "none" ? "re_export" : finding.remedy;
		if (SEVERITY[remedy] > SEVERITY[decision]) decision = remedy;
	}
	return decision;
}

function moreSevere(a: QaDecision, b: QaDecision): QaDecision {
	return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/** What the vision model must return: one finding for each check a still can answer. */
export const VisionQaResponseSchema = z
	.object({
		decision: QaDecisionSchema,
		confidence: z.number().min(0).max(1),
		summary: z.string().min(1),
		findings: z.array(QaFindingSchema).min(1),
	})
	.superRefine((response, ctx) => {
		for (const check of VISION_CHECKS) {
			const seen = response.findings.filter((finding) => finding.check === check);
			if (seen.length !== 1) {
				ctx.addIssue({
					code: "custom",
					path: ["findings"],
					message: `expected exactly one finding for "${check}", got ${seen.length}`,
				});
			}
		}
		const derived = deriveDecision(response.findings);
		if (SEVERITY[response.decision] < SEVERITY[derived]) {
			ctx.addIssue({
				code: "custom",
				path: ["decision"],
				message: `decision "${response.decision}" is less severe than its own findings require ("${derived}")`,
			});
		}
	});
export type VisionQaResponse = z.infer<typeof VisionQaResponseSchema>;

export const QaReportSchema = z.object({
	pass: z.number().int().min(0),
	decision: QaDecisionSchema,
	confidence: z.number().min(0).max(1),
	summary: z.string().min(1),
	findings: z.array(QaFindingSchema),
	frames: z.array(z.object({ sampleId: z.string(), imageRef: z.string() })),
});
export type QaReport = z.infer<typeof QaReportSchema>;

export interface ExportQaInput {
	exportPath: string;
	outputDir: string;
	storyboard: Storyboard;
	beats: Beat[];
	/** The rate the capture really ran at, from `recordingStop`. */
	measuredFps: number;
	/** The rate the export was rendered at, from the export result. */
	exportedFps: number;
	exportedDurationMs: number;
	music?: string | null;
	pass?: number;
	maxFrames?: number;
	tailMarginMs?: number;
	/** Rate difference tolerated before it is called judder. Default 0.6fps. */
	fpsToleranceFps?: number;
	/** Drop the tail must show against the body to count as a fade. Default 6dB. */
	minFadeDropDb?: number;
	fadeWindowMs?: number;
	/** Below this the pass is treated as not run, never as an accept. Default 0.6. */
	minConfidence?: number;
}

export interface ExportQaDeps {
	env: FrameEnv;
	model: VisionQaModel;
}

function beatById(beats: Beat[]): Map<string, Beat> {
	return new Map(beats.map((beat) => [beat.beatId, beat]));
}

/**
 * Where to look: the aim point of every shot, plus the tails where a spinner or the desktop
 * leaks in. SKILL.md pulls four beat frames by hand; the plan generalises that to the cut.
 */
export function planExportSamples(
	storyboard: Storyboard,
	beats: Beat[],
	options: { maxFrames?: number; tailMarginMs?: number } = {}
): FrameSample[] {
	const maxFrames = options.maxFrames ?? 8;
	const tailMarginMs = options.tailMarginMs ?? 120;
	const byId = beatById(beats);

	const required: FrameSample[] = [];
	const optional: FrameSample[] = [];
	let exportOffsetMs = 0;

	storyboard.shots.forEach((shot, index) => {
		const durationMs = Math.max(0, shot.sourceEndMs - shot.sourceStartMs);
		const aim = shot.aimBeatId ? byId.get(shot.aimBeatId) : undefined;
		const withinShotMs = aim
			? Math.min(Math.max(aim.offsetMs - shot.sourceStartMs, 0), Math.max(durationMs - 1, 0))
			: Math.round(durationMs * 0.4);

		required.push({
			sampleId: `shot-${index + 1}-beat`,
			label: aim
				? `shot ${index + 1} — ${aim.kind} beat "${aim.label}"`
				: `shot ${index + 1} — mid-shot (no aim beat logged)`,
			timestampMs: exportOffsetMs + withinShotMs,
			role: "beat",
			beatId: aim?.beatId ?? null,
			shotId: shot.shotId,
		});

		const tail: FrameSample = {
			sampleId: `shot-${index + 1}-tail`,
			label: `shot ${index + 1} — tail (checks bleed and loading leaks at the cut)`,
			timestampMs: Math.max(exportOffsetMs, exportOffsetMs + durationMs - tailMarginMs),
			role: "tail",
			beatId: aim?.beatId ?? null,
			shotId: shot.shotId,
		};
		if (index === storyboard.shots.length - 1) required.push(tail);
		else optional.push(tail);

		exportOffsetMs += durationMs;
	});

	const samples = required.slice(0, maxFrames);
	for (const sample of optional) {
		if (samples.length >= maxFrames) break;
		samples.push(sample);
	}
	return samples.sort((a, b) => a.timestampMs - b.timestampMs);
}

function fpsFinding(input: ExportQaInput): QaFinding {
	const tolerance = input.fpsToleranceFps ?? 0.6;
	const delta = Math.abs(input.exportedFps - input.measuredFps);
	if (delta <= tolerance) {
		return {
			check: "fps_judder",
			status: "pass",
			beatId: null,
			shotId: null,
			sampleId: null,
			defect: `Exported at ${input.exportedFps.toFixed(2)}fps against a measured ${input.measuredFps.toFixed(2)}fps capture.`,
			remedy: "none",
		};
	}
	return {
		check: "fps_judder",
		status: "fail",
		beatId: null,
		shotId: null,
		sampleId: null,
		defect: `Exported at ${input.exportedFps.toFixed(2)}fps against a measured ${input.measuredFps.toFixed(2)}fps capture — a ${delta.toFixed(2)}fps mismatch judders. Re-export at the source rate.`,
		remedy: "re_export",
	};
}

async function musicFinding(input: ExportQaInput, env: FrameEnv): Promise<QaFinding> {
	const base: Pick<QaFinding, "check" | "beatId" | "shotId" | "sampleId"> = {
		check: "music_fade",
		beatId: null,
		shotId: null,
		sampleId: null,
	};
	if (!input.music) {
		return {
			...base,
			status: "pass",
			defect: "No music track was requested, so there is no fade to check.",
			remedy: "none",
		};
	}

	const fadeWindowMs = input.fadeWindowMs ?? 1_500;
	const minDrop = input.minFadeDropDb ?? 6;
	const tailStartMs = Math.max(0, input.exportedDurationMs - fadeWindowMs);
	const bodyStartMs = Math.max(0, Math.round(input.exportedDurationMs / 2) - fadeWindowMs / 2);

	const tail = await probeAudioWindow(
		input.exportPath,
		{ startMs: tailStartMs, durationMs: fadeWindowMs },
		env
	);
	const body = await probeAudioWindow(
		input.exportPath,
		{ startMs: bodyStartMs, durationMs: fadeWindowMs },
		env
	);

	if (body === null) {
		return {
			...base,
			status: "fail",
			defect: `Music "${input.music}" was requested but the export carries no measurable audio.`,
			remedy: "re_export",
		};
	}
	if (tail === null) {
		return {
			...base,
			status: "pass",
			defect: `Music "${input.music}" fades to silence over the last ${fadeWindowMs}ms.`,
			remedy: "none",
		};
	}

	const drop = body.meanDb - tail.meanDb;
	if (drop >= minDrop) {
		return {
			...base,
			status: "pass",
			defect: `Music drops ${drop.toFixed(1)}dB over the last ${fadeWindowMs}ms.`,
			remedy: "none",
		};
	}
	return {
		...base,
		status: "fail",
		defect: `Music "${input.music}" ends at ${tail.meanDb.toFixed(1)}dB against a ${body.meanDb.toFixed(1)}dB body — only ${drop.toFixed(1)}dB of fade over the last ${fadeWindowMs}ms, so it stops dead.`,
		remedy: "re_export",
	};
}

const SYSTEM_PROMPT = [
	"You are the frame-QA reviewer on a cinematic product-demo pipeline.",
	"You are shown stills pulled from a rendered export, in order, each labelled with the beat and shot it came from.",
	"You never approve a frame you cannot actually see, and you never report a defect without naming the beat, shot or frame it is in.",
].join(" ");

function buildInstructions(input: ExportQaInput, measured: QaFinding[]): string {
	return [
		"Review these frames from the rendered export and return one finding per visual check.",
		"",
		"Checks:",
		...VISION_CHECKS.map((check) => `- ${CHECK_PROMPTS[check]}`),
		"",
		"Already measured for you (do not re-judge these, they are merged into the final verdict):",
		...measured.map((finding) => `- ${finding.check}: ${finding.status} — ${finding.defect}`),
		"",
		`Export: ${input.exportPath} — ${input.exportedDurationMs}ms, ${input.storyboard.shots.length} shots.`,
		"",
		"Rules for your answer:",
		'- "decision" is "accept" only when every finding passes; "reshoot" when the footage itself is unusable; "re_export" when the footage is fine but the cut, aim or render is wrong.',
		'- A failing finding must set "beatId", "shotId" or "sampleId", and "defect" must say what is wrong and where — not a restatement of the check.',
		'- "confidence" is your own confidence in this review, 0 to 1. If the frames do not let you judge a check, say so in the defect and lower the confidence rather than passing it.',
	].join("\n");
}

export async function runExportQa(
	input: ExportQaInput,
	deps: ExportQaDeps
): Promise<QaReport> {
	const pass = input.pass ?? 0;
	const samples = planExportSamples(input.storyboard, input.beats, {
		maxFrames: input.maxFrames,
		tailMarginMs: input.tailMarginMs,
	});

	const frames: ExtractedFrame[] = await extractFrames(
		{
			videoPath: input.exportPath,
			outputDir: input.outputDir,
			samples,
			durationMs: input.exportedDurationMs,
		},
		deps.env
	);

	const measured: QaFinding[] = [fpsFinding(input), await musicFinding(input, deps.env)];

	const raw = await deps.model({
		system: SYSTEM_PROMPT,
		instructions: buildInstructions(input, measured),
		responseSchema: z.toJSONSchema(VisionQaResponseSchema, { io: "output" }),
		frames: toVisionFrames(frames),
	});

	const response = parseQaResponse("export", VisionQaResponseSchema, raw);
	const findings = [...response.findings, ...measured];
	const decision = moreSevere(response.decision, deriveDecision(findings));

	if (decision === "accept") {
		assertConfident("export", response.confidence, input.minConfidence ?? 0.6, response.summary);
	}

	return {
		pass,
		decision,
		confidence: response.confidence,
		summary: response.summary,
		findings,
		frames: frames.map((frame) => ({ sampleId: frame.sampleId, imageRef: frame.imageRef })),
	};
}

export function failingFindings(report: QaReport): QaFinding[] {
	return report.findings.filter((finding) => finding.status === "fail");
}

/** Flattens a report into the shape `runReviewLoop` consumes. */
export function toReviewVerdict(report: QaReport): {
	verdict: QaDecision;
	notes: string;
	shotId: string | null;
} {
	const failures = failingFindings(report);
	const located = failures.find((finding) => finding.shotId) ?? failures[0];
	const notes =
		failures.length === 0
			? report.summary
			: [
					report.summary,
					...failures.map((finding) => {
						const where = [
							finding.shotId ? `shot ${finding.shotId}` : null,
							finding.beatId ? `beat ${finding.beatId}` : null,
							finding.sampleId ? `frame ${finding.sampleId}` : null,
						]
							.filter(Boolean)
							.join(", ");
						return `${finding.check}${where ? ` (${where})` : ""}: ${finding.defect}`;
					}),
				].join(" | ");

	return { verdict: report.decision, notes, shotId: located?.shotId ?? null };
}
