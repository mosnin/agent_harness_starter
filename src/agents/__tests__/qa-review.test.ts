import { describe, expect, it, vi } from "vitest";
import type { Beat, CameraPose, Storyboard } from "../tools/cap/types";
import type { FrameEnv } from "../qa/frames";
import {
	QaLowConfidenceError,
	QaVerdictInvalidError,
	type VisionQaModel,
	type VisionQaRequest,
} from "../qa/model";
import {
	VISION_CHECKS,
	type QaFinding,
	deriveDecision,
	planExportSamples,
	runExportQa,
	toReviewVerdict,
} from "../qa/review";

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
			recordingSegment: 0,
			transitionDurationMs: 0,
		},
		{
			shotId: "s2",
			sourceStartMs: 4_000,
			sourceEndMs: 9_000,
			camera: CAMERA,
			aimBeatId: "b2",
			transitionIn: "cut",
			recordingSegment: 0,
			transitionDurationMs: 0,
		},
	],
	background: { type: "gradient", fromHex: "E4DCF8", toHex: "C6BAEA" },
	cursor: { synthesize: true, size: 1, smoothing: 0.5 },
	music: "lofi-cinematic-pulsebox",
	captions: null,
};

interface AudioLevels {
	meanDb: number;
	maxDb: number;
}

function frameEnv(audio: { tail?: AudioLevels | null; body?: AudioLevels | null } = {}): FrameEnv {
	const tail = audio.tail === undefined ? { meanDb: -44, maxDb: -30 } : audio.tail;
	const body = audio.body === undefined ? { meanDb: -21, maxDb: -6 } : audio.body;
	let audioCall = 0;

	return {
		run: async (_bin, args) => {
			if (!args.includes("volumedetect")) return { code: 0, stdout: "", stderr: "" };
			const levels = audioCall++ === 0 ? tail : body;
			if (levels === null) {
				return { code: 1, stdout: "", stderr: "Stream map 'a:0' matches no streams." };
			}
			return {
				code: 0,
				stdout: "",
				stderr: `mean_volume: ${levels.meanDb} dB\nmax_volume: ${levels.maxDb} dB\n`,
			};
		},
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

function visionResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		decision: "accept",
		confidence: 0.92,
		summary: "Both beats read; no bleed, no spinner.",
		findings: VISION_CHECKS.map(passing),
		...overrides,
	};
}

function modelReturning(payload: unknown): VisionQaModel {
	return async () => payload;
}

function input(overrides: Record<string, unknown> = {}) {
	return {
		exportPath: "/tmp/demo-demo.mp4",
		outputDir: "/tmp/qa",
		storyboard: STORYBOARD,
		beats: BEATS,
		measuredFps: 57.94,
		exportedFps: 57.94,
		exportedDurationMs: 9_000,
		music: "lofi-cinematic-pulsebox",
		...overrides,
	};
}

describe("planExportSamples", () => {
	it("samples every shot's aim beat and the clip tail, in export time", () => {
		const samples = planExportSamples(STORYBOARD, BEATS);
		expect(samples.map((s) => [s.sampleId, s.timestampMs])).toEqual([
			["shot-1-beat", 1_200],
			["shot-1-tail", 3_880],
			["shot-2-beat", 6_000],
			["shot-2-tail", 8_880],
		]);
	});

	it("keeps the beat frames and the final tail when the frame budget is tight", () => {
		const samples = planExportSamples(STORYBOARD, BEATS, { maxFrames: 3 });
		expect(samples.map((s) => s.sampleId)).toEqual([
			"shot-1-beat",
			"shot-2-beat",
			"shot-2-tail",
		]);
	});

	it("falls back to a mid-shot frame when a shot has no logged aim beat", () => {
		const boardless: Storyboard = {
			...STORYBOARD,
			shots: [{ ...STORYBOARD.shots[0], aimBeatId: null }],
		};
		const samples = planExportSamples(boardless, BEATS);
		expect(samples[0].timestampMs).toBe(1_600);
		expect(samples[0].beatId).toBeNull();
	});
});

describe("deriveDecision", () => {
	it("takes the most expensive remedy any finding asks for", () => {
		expect(deriveDecision([passing("beat_readable")])).toBe("accept");
		expect(
			deriveDecision([
				{ ...passing("loading_leak"), status: "fail", sampleId: "shot-1-tail", remedy: "re_export", defect: "spinner in the tail" },
			])
		).toBe("re_export");
		expect(
			deriveDecision([
				{ ...passing("loading_leak"), status: "fail", sampleId: "shot-1-tail", remedy: "re_export", defect: "spinner in the tail" },
				{ ...passing("window_bleed"), status: "fail", shotId: "s2", remedy: "reshoot", defect: "desktop along the bottom" },
			])
		).toBe("reshoot");
	});
});

describe("runExportQa", () => {
	it("accepts a clean export and hands the model frame references, never image data", async () => {
		const seen: VisionQaRequest[] = [];
		const model: VisionQaModel = async (request) => {
			seen.push(request);
			return visionResponse();
		};

		const report = await runExportQa(input(), { env: frameEnv(), model });

		expect(report.decision).toBe("accept");
		expect(report.findings).toHaveLength(6);
		expect(report.frames.map((f) => f.imageRef)).toEqual([
			"file:///tmp/qa/shot-1-beat.png",
			"file:///tmp/qa/shot-1-tail.png",
			"file:///tmp/qa/shot-2-beat.png",
			"file:///tmp/qa/shot-2-tail.png",
		]);
		for (const frame of seen[0].frames) {
			expect(frame.imageRef).toMatch(/^file:\/\//);
			expect(JSON.stringify(frame)).not.toMatch(/base64/);
		}
		expect(seen[0].responseSchema).toMatchObject({ type: "object" });
		expect(seen[0].instructions).toContain("text-entry point");
	});

	it("routes a bleed named against a specific beat to a reshoot", async () => {
		const model = modelReturning(
			visionResponse({
				decision: "reshoot",
				summary: "The second beat has the desktop along the bottom edge.",
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
						defect: "Desktop wallpaper and a Finder window bleed into the bottom 8% of the frame.",
						remedy: "reshoot",
					},
				],
			})
		);

		const report = await runExportQa(input(), { env: frameEnv(), model });
		const verdict = toReviewVerdict(report);

		expect(report.decision).toBe("reshoot");
		expect(verdict.verdict).toBe("reshoot");
		expect(verdict.shotId).toBe("s2");
		expect(verdict.notes).toContain("beat b2");
		expect(verdict.notes).toContain("Finder");
	});

	it("keeps a re-export-only defect off the reshoot branch", async () => {
		const model = modelReturning(
			visionResponse({
				decision: "re_export",
				summary: "A blur-up placeholder leaks into the first cut.",
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
						defect: "The hero image is still blurring up two frames before the cut.",
						remedy: "re_export",
					},
				],
			})
		);

		const report = await runExportQa(input(), { env: frameEnv(), model });
		expect(report.decision).toBe("re_export");
		expect(toReviewVerdict(report).verdict).toBe("re_export");
	});

	it("catches the 58-vs-60 judder even when the model is happy", async () => {
		const report = await runExportQa(
			input({ exportedFps: 60 }),
			{ env: frameEnv(), model: modelReturning(visionResponse()) }
		);

		expect(report.decision).toBe("re_export");
		const fps = report.findings.find((f) => f.check === "fps_judder");
		expect(fps?.status).toBe("fail");
		expect(fps?.defect).toContain("judders");
	});

	it("fails the music check when the track stops dead instead of fading", async () => {
		const report = await runExportQa(input(), {
			env: frameEnv({ tail: { meanDb: -20.4, maxDb: -6 }, body: { meanDb: -21, maxDb: -6 } }),
			model: modelReturning(visionResponse()),
		});

		expect(report.decision).toBe("re_export");
		expect(report.findings.find((f) => f.check === "music_fade")?.status).toBe("fail");
	});

	it("passes the music check when the tail fades to silence", async () => {
		const report = await runExportQa(input(), {
			env: frameEnv({ tail: null }),
			model: modelReturning(visionResponse()),
		});
		expect(report.decision).toBe("accept");
	});

	it("does not judge music fades when no track was requested", async () => {
		const report = await runExportQa(input({ music: null }), {
			env: frameEnv({ tail: { meanDb: -20.4, maxDb: -6 }, body: { meanDb: -21, maxDb: -6 } }),
			model: modelReturning(visionResponse()),
		});
		expect(report.decision).toBe("accept");
	});

	it("rejects a malformed verdict instead of treating it as an accept", async () => {
		await expect(
			runExportQa(input(), {
				env: frameEnv(),
				model: modelReturning({ decision: "accept", confidence: 1 }),
			})
		).rejects.toBeInstanceOf(QaVerdictInvalidError);
	});

	it("rejects a verdict that skips a check", async () => {
		await expect(
			runExportQa(input(), {
				env: frameEnv(),
				model: modelReturning(
					visionResponse({ findings: [passing("beat_readable"), passing("typing_aim")] })
				),
			})
		).rejects.toThrow(/window_bleed/);
	});

	it("rejects a defect that names neither a beat, a shot nor a frame", async () => {
		await expect(
			runExportQa(input(), {
				env: frameEnv(),
				model: modelReturning(
					visionResponse({
						decision: "re_export",
						findings: [
							passing("typing_aim"),
							passing("window_bleed"),
							passing("loading_leak"),
							{
								check: "beat_readable",
								status: "fail",
								beatId: null,
								shotId: null,
								sampleId: null,
								defect: "Something reads a bit tight somewhere.",
								remedy: "re_export",
							},
						],
					})
				),
			})
		).rejects.toThrow(/name the beat, shot or frame/);
	});

	it("rejects a model that accepts while its own findings fail", async () => {
		await expect(
			runExportQa(input(), {
				env: frameEnv(),
				model: modelReturning(
					visionResponse({
						decision: "accept",
						findings: [
							passing("typing_aim"),
							passing("window_bleed"),
							passing("loading_leak"),
							{
								check: "beat_readable",
								status: "fail",
								beatId: "b1",
								shotId: "s1",
								sampleId: "shot-1-beat",
								defect: "The hero headline is cropped by the 3D card edge.",
								remedy: "re_export",
							},
						],
					})
				),
			})
		).rejects.toThrow(/less severe/);
	});

	it("refuses to accept on a low-confidence look", async () => {
		await expect(
			runExportQa(input(), {
				env: frameEnv(),
				model: modelReturning(visionResponse({ confidence: 0.3 })),
			})
		).rejects.toBeInstanceOf(QaLowConfidenceError);
	});

	it("still reports a defect found with low confidence", async () => {
		const report = await runExportQa(input({ exportedFps: 60 }), {
			env: frameEnv(),
			model: modelReturning(visionResponse({ confidence: 0.2 })),
		});
		expect(report.decision).toBe("re_export");
		expect(report.confidence).toBe(0.2);
	});

	it("propagates a missing ffmpeg rather than reporting a clean export", async () => {
		const model = vi.fn(modelReturning(visionResponse()));
		const env = frameEnv();
		await expect(
			runExportQa(input(), {
				env: {
					...env,
					run: async () => {
						throw Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
					},
				},
				model,
			})
		).rejects.toMatchObject({ code: "QA_FFMPEG_MISSING" });
		expect(model).not.toHaveBeenCalled();
	});
});

describe("verdict severity ordering", () => {
	it("rejects a re_export decision whose own findings demand a reshoot", async () => {
		await expect(
			runExportQa(input(), {
				env: frameEnv(),
				model: modelReturning(
					visionResponse({
						decision: "re_export",
						findings: [
							passing("beat_readable"),
							passing("typing_aim"),
							passing("loading_leak"),
							{
								check: "window_bleed",
								status: "fail",
								beatId: "b1",
								shotId: "s1",
								sampleId: "shot-1-beat",
								defect: "Finder window chrome bleeds in along the right edge.",
								remedy: "reshoot",
							},
						],
					})
				),
			})
		).rejects.toBeInstanceOf(QaVerdictInvalidError);
	});

	it("lets a model be more severe than its findings, never less", async () => {
		const report = await runExportQa(input(), {
			env: frameEnv(),
			model: modelReturning(visionResponse({ decision: "reshoot", confidence: 0.4 })),
		});
		expect(report.decision).toBe("reshoot");
	});
});
