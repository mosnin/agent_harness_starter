import { describe, expect, it, vi } from "vitest";
import {
	createFrameQaReview,
	isQaUnavailable,
	runFrameQaReviewLoop,
	runReviewLoop,
	type ReviewVerdict,
} from "../definitions/director";
import type { Beat, CameraPose, Storyboard } from "../tools/cap/types";
import type { FrameEnv } from "../qa/frames";
import type { VisionQaModel } from "../qa/model";
import { VISION_CHECKS, type ExportQaInput, type QaFinding } from "../qa/review";

const CAMERA: CameraPose = {
	zoom: 0.8,
	tiltX: 11,
	tiltY: 10,
	rotateX: -4,
	roll: 0,
	rotateY: 0,
	fov: 45,
	focusX: 0.5,
	focusY: 0.5,
	focusSize: 0.55,
};

const BEATS: Beat[] = [
	{ beatId: "b1", offsetMs: 1_200, kind: "action", label: "click Get started", landmark: null },
	{ beatId: "b2", offsetMs: 6_000, kind: "typing", label: "type the query", landmark: null },
];

const STORYBOARD: Storyboard = {
	version: 1,
	projectPath: "/tmp/demo.cap",
	sourceFps: 57.94,
	shots: [
		{
			shotId: "s1",
			sourceStartMs: 0,
			sourceEndMs: 4_000,
			camera: CAMERA,
			aimBeatId: "b1",
			transitionIn: "cut",
		},
		{
			shotId: "s2",
			sourceStartMs: 4_000,
			sourceEndMs: 9_000,
			camera: CAMERA,
			aimBeatId: "b2",
			transitionIn: "cut",
		},
	],
	background: { type: "gradient", fromHex: "E4DCF8", toHex: "C6BAEA" },
	cursor: { synthesize: true, size: 1, smoothing: 0.5 },
	music: null,
	captions: null,
};

function frameEnv(): FrameEnv {
	return {
		run: async () => ({ code: 0, stdout: "", stderr: "" }),
		sizeOf: async () => 4096,
		ensureDir: async () => {},
		ffmpegBin: "ffmpeg",
		ffprobeBin: "ffprobe",
	};
}

function passing(check: (typeof VISION_CHECKS)[number]): QaFinding {
	return {
		check,
		status: "pass",
		beatId: null,
		shotId: null,
		sampleId: null,
		defect: "Nothing wrong in any sampled frame.",
		remedy: "none",
	};
}

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		decision: "accept",
		confidence: 0.9,
		summary: "Both beats read.",
		findings: VISION_CHECKS.map(passing),
		...overrides,
	};
}

const BLEED = response({
	decision: "reshoot",
	summary: "Desktop bleed in the second shot.",
	findings: [
		passing("beat_readable"),
		passing("typing_aim"),
		passing("loading_leak"),
		{
			check: "window_bleed",
			status: "fail",
			beatId: "b2",
			shotId: "s2",
			sampleId: "shot-2-tail",
			defect: "The desktop wallpaper fills the bottom strip of the frame.",
			remedy: "reshoot",
		},
	],
});

const SPINNER = response({
	decision: "re_export",
	summary: "A spinner leaks into the first cut.",
	findings: [
		passing("beat_readable"),
		passing("typing_aim"),
		passing("window_bleed"),
		{
			check: "loading_leak",
			status: "fail",
			beatId: "b1",
			shotId: "s1",
			sampleId: "shot-1-tail",
			defect: "A loading spinner is still on screen at the cut point.",
			remedy: "re_export",
		},
	],
});

function input(overrides: Partial<ExportQaInput> = {}): ExportQaInput {
	return {
		exportPath: "/tmp/demo-demo.mp4",
		outputDir: "/tmp/qa",
		storyboard: STORYBOARD,
		beats: BEATS,
		measuredFps: 57.94,
		exportedFps: 57.94,
		exportedDurationMs: 9_000,
		music: null,
		...overrides,
	};
}

function modelQueue(payloads: unknown[]): VisionQaModel {
	let index = 0;
	return async () => payloads[Math.min(index++, payloads.length - 1)];
}

describe("createFrameQaReview", () => {
	it("produces a verdict the review loop already knows how to route", async () => {
		const review = createFrameQaReview({
			input: input(),
			deps: { env: frameEnv(), model: modelQueue([response()]) },
		});
		const verdict: ReviewVerdict = await review(0);
		expect(verdict.verdict).toBe("accept");
		expect(verdict.notes).toBe("Both beats read.");
	});

	it("hands each pass the export that pass is meant to look at", async () => {
		const seen: number[] = [];
		const review = createFrameQaReview({
			input: (pass) => {
				seen.push(pass);
				return input({ exportPath: `/tmp/demo-pass-${pass}.mp4` });
			},
			deps: { env: frameEnv(), model: modelQueue([SPINNER, response()]) },
		});

		await review(0);
		await review(1);
		expect(seen).toEqual([0, 1]);
	});
});

describe("runFrameQaReviewLoop", () => {
	it("routes a defect named against a beat to the reshoot branch", async () => {
		const onReshoot = vi.fn<(verdict: ReviewVerdict, pass: number) => Promise<void>>(
			async () => {}
		);
		const onReExport = vi.fn(async () => {});

		const result = await runFrameQaReviewLoop({
			input: input(),
			deps: { env: frameEnv(), model: modelQueue([BLEED, response()]) },
			onReshoot,
			onReExport,
		});

		expect(result.accepted).toBe(true);
		expect(onReshoot).toHaveBeenCalledTimes(1);
		expect(onReExport).not.toHaveBeenCalled();
		const [verdict] = onReshoot.mock.calls[0];
		expect(verdict.shotId).toBe("s2");
		expect(verdict.notes).toContain("beat b2");
	});

	it("keeps a re-export-only defect off the reshoot branch", async () => {
		const onReshoot = vi.fn(async () => {});
		const onReExport = vi.fn(async () => {});

		const result = await runFrameQaReviewLoop({
			input: input(),
			deps: { env: frameEnv(), model: modelQueue([SPINNER, response()]) },
			onReshoot,
			onReExport,
		});

		expect(result.accepted).toBe(true);
		expect(onReExport).toHaveBeenCalledTimes(1);
		expect(onReshoot).not.toHaveBeenCalled();
	});

	it("terminates at maxPasses when the defect never clears", async () => {
		const onReExport = vi.fn(async () => {});
		const result = await runFrameQaReviewLoop({
			input: input(),
			deps: { env: frameEnv(), model: modelQueue([SPINNER]) },
			onReExport,
			maxPasses: 3,
		});

		expect(result.accepted).toBe(false);
		expect(result.stoppedBy).toBe("max_passes");
		expect(result.passes).toHaveLength(3);
		expect(onReExport).toHaveBeenCalledTimes(3);
	});

	it("never turns a malformed verdict into an accept", async () => {
		const onReshoot = vi.fn(async () => {});
		const onReExport = vi.fn(async () => {});
		const onIndeterminate = vi.fn<(error: Error, pass: number) => Promise<void>>(
			async () => {}
		);

		const result = await runFrameQaReviewLoop({
			input: input(),
			deps: { env: frameEnv(), model: modelQueue([{ decision: "accept" }]) },
			onReshoot,
			onReExport,
			onIndeterminate,
			maxPasses: 2,
		});

		expect(result.accepted).toBe(false);
		expect(result.stoppedBy).toBe("qa_failed");
		expect(result.passes).toHaveLength(0);
		expect(result.indeterminate).toHaveLength(2);
		expect(result.indeterminate?.[0].code).toBe("QA_VERDICT_INVALID");
		expect(onReshoot).not.toHaveBeenCalled();
		expect(onReExport).not.toHaveBeenCalled();
		expect(onIndeterminate).toHaveBeenCalledTimes(2);
		expect(isQaUnavailable(onIndeterminate.mock.calls[0][0])).toBe(true);
	});

	it("never turns a low-confidence look into an accept", async () => {
		const result = await runFrameQaReviewLoop({
			input: input(),
			deps: { env: frameEnv(), model: modelQueue([response({ confidence: 0.2 })]) },
			maxPasses: 1,
		});
		expect(result.accepted).toBe(false);
		expect(result.indeterminate?.[0].code).toBe("QA_VERDICT_LOW_CONFIDENCE");
	});

	it("recovers when a later pass returns a usable verdict", async () => {
		const result = await runFrameQaReviewLoop({
			input: input(),
			deps: { env: frameEnv(), model: modelQueue([{ nonsense: true }, response()]) },
			maxPasses: 3,
		});
		expect(result.accepted).toBe(true);
		expect(result.indeterminate).toHaveLength(1);
	});

	it("stops the loop when the QA infrastructure itself is missing", async () => {
		const result = await runFrameQaReviewLoop({
			input: input(),
			deps: {
				env: {
					...frameEnv(),
					run: async () => {
						throw Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
					},
				},
				model: modelQueue([response()]),
			},
			maxPasses: 2,
		});
		expect(result.accepted).toBe(false);
		expect(result.stoppedBy).toBe("qa_failed");
		expect(result.indeterminate?.[0].code).toBe("QA_FFMPEG_MISSING");
	});
});

describe("runReviewLoop", () => {
	it("keeps the injected seam for callers that supply their own review", async () => {
		const result = await runReviewLoop({
			review: async () => ({ verdict: "accept", notes: "looks right" }),
		});
		expect(result.accepted).toBe(true);
		expect(result.indeterminate).toBeUndefined();
	});
});
