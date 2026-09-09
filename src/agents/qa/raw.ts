/**
 * Frame QA on the raw capture, before any treatment — SKILL.md step 2.
 *
 * Same mechanism as the export pass, one stage earlier and far cheaper: a dead-end CTA, a leaked
 * cookie banner or the wrong window is caught before an export is paid for, and the answer is a
 * reshoot (optionally with a different story) rather than a regrade.
 */

import { z } from "zod";
import type { Beat } from "../tools/cap/types";
import { AgentError } from "../errors/index";
import {
	type ExtractedFrame,
	type FrameEnv,
	type FrameSample,
	extractFrames,
} from "./frames";
import {
	type VisionQaModel,
	assertConfident,
	parseQaResponse,
	toVisionFrames,
} from "./model";
import { refineLocatedFinding } from "./review";

export const RawCheckSchema = z.enum([
	"capture_target",
	"cookie_banner",
	"cta_dead_end",
	"tail_bleed",
]);
export type RawCheck = z.infer<typeof RawCheckSchema>;

export const RawDecisionSchema = z.enum(["proceed", "reshoot"]);
export type RawDecision = z.infer<typeof RawDecisionSchema>;

export const StorySchema = z.enum(["click", "scroll"]);
export type Story = z.infer<typeof StorySchema>;

export const RAW_CHECKS: RawCheck[] = [
	"capture_target",
	"cookie_banner",
	"cta_dead_end",
	"tail_bleed",
];

export const RAW_CHECK_PROMPTS: Record<RawCheck, string> = {
	capture_target:
		"capture_target — the frames show the window and content the shoot was aimed at, and nothing left over from a previous shoot.",
	cookie_banner:
		"cookie_banner — no cookie or consent banner, and no other modal the shoot should have dismissed, is visible in any frame.",
	cta_dead_end:
		"cta_dead_end — the click did not dead-end: the destination is real content, not a booking calendar, a login form, a paywall or an error page.",
	tail_bleed:
		"tail_bleed — the end of the clip is clean: no desktop, wallpaper or Finder window bleeding into the edges or the bottom of the capture.",
};

export const RawFindingSchema = z
	.object({
		check: RawCheckSchema,
		status: z.enum(["pass", "fail"]),
		beatId: z.string().min(1).nullable(),
		sampleId: z.string().min(1).nullable(),
		defect: z.string().min(1),
		remedy: z.enum(["none", "reshoot"]),
	})
	.superRefine(refineLocatedFinding);
export type RawFinding = z.infer<typeof RawFindingSchema>;

export const RawQaResponseSchema = z
	.object({
		decision: RawDecisionSchema,
		confidence: z.number().min(0).max(1),
		summary: z.string().min(1),
		suggestedStory: StorySchema.nullable(),
		findings: z.array(RawFindingSchema).min(1),
	})
	.superRefine((response, ctx) => {
		for (const check of RAW_CHECKS) {
			const seen = response.findings.filter((finding) => finding.check === check);
			if (seen.length !== 1) {
				ctx.addIssue({
					code: "custom",
					path: ["findings"],
					message: `expected exactly one finding for "${check}", got ${seen.length}`,
				});
			}
		}
		const failing = response.findings.some((finding) => finding.status === "fail");
		if (failing && response.decision === "proceed") {
			ctx.addIssue({
				code: "custom",
				path: ["decision"],
				message: "cannot proceed on footage whose own findings fail — the export would be wasted",
			});
		}
	});
export type RawQaResponse = z.infer<typeof RawQaResponseSchema>;

export interface RawQaReport {
	decision: RawDecision;
	confidence: number;
	summary: string;
	suggestedStory: Story | null;
	findings: RawFinding[];
	frames: Array<{ sampleId: string; imageRef: string }>;
}

export class RawFootageRejectedError extends AgentError {
	readonly report: RawQaReport;

	constructor(report: RawQaReport) {
		const defects = report.findings
			.filter((finding) => finding.status === "fail")
			.map((finding) => `${finding.check}: ${finding.defect}`)
			.join("; ");
		super(
			`The raw capture failed QA before treatment: ${defects || report.summary}`,
			"QA_RAW_FOOTAGE_REJECTED",
			report.suggestedStory
				? `Reshoot with the "${report.suggestedStory}" story before spending an export.`
				: "Reshoot with a better landmark before spending an export."
		);
		this.name = "RawFootageRejectedError";
		this.report = report;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

/** Where `cap record` leaves the raw display capture inside a `.cap` project. */
export function rawDisplayPath(projectPath: string): string {
	return `${projectPath.replace(/\/$/, "")}/content/segments/segment-0/display.mp4`;
}

export interface RawQaInput {
	/** The `.cap` project directory, or a video path when `videoPath` is set directly. */
	projectPath?: string;
	videoPath?: string;
	outputDir: string;
	durationMs: number;
	beats: Beat[];
	expected?: {
		windowTitle?: string | null;
		bundleId?: string | null;
		ctaText?: string | null;
		story?: Story | null;
	};
	maxFrames?: number;
	openingMs?: number;
	tailMarginMs?: number;
	minConfidence?: number;
}

export interface RawQaDeps {
	env: FrameEnv;
	model: VisionQaModel;
}

/** The opening frame, every beat worth looking at, and the tail — SKILL.md's "a few beat frames". */
export function planRawSamples(
	beats: Beat[],
	durationMs: number,
	options: { maxFrames?: number; openingMs?: number; tailMarginMs?: number } = {}
): FrameSample[] {
	const maxFrames = Math.max(2, options.maxFrames ?? 6);
	const openingMs = options.openingMs ?? 250;
	const tailMarginMs = options.tailMarginMs ?? 200;

	const opening: FrameSample = {
		sampleId: "raw-opening",
		label: "opening frame — checks the captured window and any leaked banner",
		timestampMs: Math.min(openingMs, Math.max(0, durationMs - 1)),
		role: "opening",
	};
	const tail: FrameSample = {
		sampleId: "raw-tail",
		label: "clip tail — checks desktop or Finder bleed at the end of the capture",
		timestampMs: Math.max(0, durationMs - tailMarginMs),
		role: "tail",
	};

	const middle = beats
		.filter((beat) => beat.kind !== "idle" && beat.offsetMs < tail.timestampMs)
		.sort((a, b) => a.offsetMs - b.offsetMs)
		.slice(0, Math.max(0, maxFrames - 2))
		.map<FrameSample>((beat, index) => ({
			sampleId: `raw-beat-${index + 1}`,
			label: `${beat.kind} beat "${beat.label}" — checks where this landed`,
			timestampMs: beat.offsetMs,
			role: "beat",
			beatId: beat.beatId,
		}));

	return [opening, ...middle, tail].sort((a, b) => a.timestampMs - b.timestampMs);
}

const SYSTEM_PROMPT = [
	"You are the frame-QA reviewer on a cinematic product-demo pipeline, looking at the raw capture before it is treated.",
	"Your job is to catch a wasted export: the wrong window, a leaked banner, a click that dead-ended, or a dirty clip tail.",
	"You never report a defect without naming the beat or frame it is in.",
].join(" ");

function buildInstructions(input: RawQaInput): string {
	const expected = input.expected ?? {};
	return [
		"These frames come from an untreated screen capture, in order. Return one finding per check.",
		"",
		"Checks:",
		...RAW_CHECKS.map((check) => `- ${RAW_CHECK_PROMPTS[check]}`),
		"",
		"What the shoot intended:",
		`- window title: ${expected.windowTitle ?? "(not recorded)"}`,
		`- application: ${expected.bundleId ?? "(not recorded)"}`,
		`- clicked CTA: ${expected.ctaText ?? "(none — this was a scroll story)"}`,
		`- story: ${expected.story ?? "(auto)"}`,
		`- capture length: ${input.durationMs}ms`,
		"",
		"Rules for your answer:",
		'- "decision" is "proceed" only when every check passes; otherwise "reshoot".',
		'- "suggestedStory" is "scroll" when the click dead-ends and the page would show better as a scroll of its own sections, "click" when a scroll missed the story, otherwise null.',
		'- A failing finding must set "beatId" or "sampleId", and "defect" must say what is wrong and where.',
		'- "confidence" is your own confidence in this review, 0 to 1. Lower it rather than passing a check the frames do not let you judge.',
	].join("\n");
}

export async function runRawFootageQa(
	input: RawQaInput,
	deps: RawQaDeps
): Promise<RawQaReport> {
	const videoPath =
		input.videoPath ?? (input.projectPath ? rawDisplayPath(input.projectPath) : undefined);
	if (!videoPath) {
		throw new AgentError(
			"Raw QA needs either a projectPath or a videoPath.",
			"QA_RAW_INPUT_INVALID",
			"Pass the `.cap` project directory returned by recordingStop."
		);
	}

	const samples = planRawSamples(input.beats, input.durationMs, {
		maxFrames: input.maxFrames,
		openingMs: input.openingMs,
		tailMarginMs: input.tailMarginMs,
	});

	const frames: ExtractedFrame[] = await extractFrames(
		{
			videoPath,
			outputDir: input.outputDir,
			samples,
			durationMs: input.durationMs,
		},
		deps.env
	);

	const raw = await deps.model({
		system: SYSTEM_PROMPT,
		instructions: buildInstructions(input),
		responseSchema: z.toJSONSchema(RawQaResponseSchema, { io: "output" }),
		frames: toVisionFrames(frames),
	});

	const response = parseQaResponse("raw footage", RawQaResponseSchema, raw);
	if (response.decision === "proceed") {
		assertConfident(
			"raw footage",
			response.confidence,
			input.minConfidence ?? 0.6,
			response.summary
		);
	}

	return {
		decision: response.decision,
		confidence: response.confidence,
		summary: response.summary,
		suggestedStory: response.suggestedStory,
		findings: response.findings,
		frames: frames.map((frame) => ({ sampleId: frame.sampleId, imageRef: frame.imageRef })),
	};
}

/** The gate itself: stop the pipeline before the export when the capture is not usable. */
export function assertRawFootageUsable(report: RawQaReport): void {
	if (report.decision !== "proceed") throw new RawFootageRejectedError(report);
}
