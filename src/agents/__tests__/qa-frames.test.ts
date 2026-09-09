import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	FfmpegMissingError,
	FrameExtractionError,
	VideoProbeError,
	type FfmpegExitResult,
	type FrameEnv,
	type FrameSample,
	createNodeFrameEnv,
	extractFrames,
	probeAudioWindow,
	probeVideo,
} from "../qa/frames";

const PROBE_JSON = JSON.stringify({
	programs: [],
	streams: [
		{
			codec_type: "video",
			avg_frame_rate: "5794/100",
			r_frame_rate: "60/1",
			nb_frames: "696",
			duration: "12.010000",
		},
	],
	format: { duration: "12.010000" },
});

function env(overrides: Partial<FrameEnv> = {}): FrameEnv {
	return {
		run: async () => ({ code: 0, stdout: "", stderr: "" }),
		sizeOf: async () => 2048,
		ensureDir: async () => {},
		ffmpegBin: "ffmpeg",
		ffprobeBin: "ffprobe",
		...overrides,
	};
}

function sample(overrides: Partial<FrameSample> = {}): FrameSample {
	return {
		sampleId: "shot-1-beat",
		label: "shot 1 — action beat",
		timestampMs: 1_500,
		role: "beat",
		...overrides,
	};
}

function enoent(bin: string): Error {
	return Object.assign(new Error(`spawn ${bin} ENOENT`), { code: "ENOENT" });
}

describe("probeVideo", () => {
	it("reports the real capture rate rather than the nominal one", async () => {
		const probe = await probeVideo(
			"/tmp/demo.mp4",
			env({ run: async () => ({ code: 0, stdout: PROBE_JSON, stderr: "" }) })
		);
		expect(probe.durationMs).toBe(12_010);
		expect(probe.fps).toBeCloseTo(57.94, 2);
		expect(probe.frameCount).toBe(696);
	});

	it("names the binary when ffprobe is not installed", async () => {
		await expect(
			probeVideo(
				"/tmp/demo.mp4",
				env({
					run: async () => {
						throw enoent("ffprobe");
					},
				})
			)
		).rejects.toMatchObject({
			name: "FfmpegMissingError",
			code: "QA_FFMPEG_MISSING",
			binary: "ffprobe",
		});
	});

	it("fails loudly when the probe returns no duration", async () => {
		await expect(
			probeVideo(
				"/tmp/demo.mp4",
				env({
					run: async () => ({
						code: 0,
						stdout: JSON.stringify({ streams: [{ codec_type: "video" }] }),
						stderr: "",
					}),
				})
			)
		).rejects.toBeInstanceOf(VideoProbeError);
	});
});

describe("extractFrames", () => {
	it("returns file references and never inline image data", async () => {
		const frames = await extractFrames(
			{
				videoPath: "/tmp/demo.mp4",
				outputDir: "/tmp/qa",
				samples: [sample()],
				durationMs: 12_000,
			},
			env()
		);
		expect(frames).toHaveLength(1);
		expect(frames[0].path).toBe("/tmp/qa/shot-1-beat.png");
		expect(frames[0].imageRef).toBe("file:///tmp/qa/shot-1-beat.png");
		expect(frames[0].imageRef).not.toMatch(/base64/);
		expect(frames[0].clamped).toBe(false);
	});

	it("seeks before the input, the way the skill's ffmpeg line does", async () => {
		const run = vi.fn<(bin: string, args: string[]) => Promise<FfmpegExitResult>>(
			async () => ({ code: 0, stdout: "", stderr: "" })
		);
		await extractFrames(
			{
				videoPath: "/tmp/demo.mp4",
				outputDir: "/tmp/qa",
				samples: [sample({ timestampMs: 2_250 })],
				durationMs: 12_000,
			},
			env({ run })
		);
		expect(run).toHaveBeenCalledWith("ffmpeg", [
			"-y",
			"-ss",
			"2.250",
			"-i",
			"/tmp/demo.mp4",
			"-frames:v",
			"1",
			"/tmp/qa/shot-1-beat.png",
		]);
	});

	it("clamps a timestamp past the end of the video back inside it", async () => {
		const frames = await extractFrames(
			{
				videoPath: "/tmp/demo.mp4",
				outputDir: "/tmp/qa",
				samples: [sample({ timestampMs: 30_000 })],
				durationMs: 12_010,
			},
			env()
		);
		expect(frames[0].clamped).toBe(true);
		expect(frames[0].requestedTimestampMs).toBe(30_000);
		expect(frames[0].timestampMs).toBe(11_910);
	});

	it("can be told to reject a timestamp past the end instead", async () => {
		await expect(
			extractFrames(
				{
					videoPath: "/tmp/demo.mp4",
					outputDir: "/tmp/qa",
					samples: [sample({ timestampMs: 30_000 })],
					durationMs: 12_010,
					pastEnd: "error",
				},
				env()
			)
		).rejects.toMatchObject({
			name: "FrameExtractionError",
			code: "QA_FRAME_EXTRACTION_FAILED",
			timestampMs: 30_000,
		});
	});

	it("probes for the duration when the caller did not measure it", async () => {
		const run = vi.fn(async (bin: string) =>
			bin === "ffprobe"
				? { code: 0, stdout: PROBE_JSON, stderr: "" }
				: { code: 0, stdout: "", stderr: "" }
		);
		const frames = await extractFrames(
			{
				videoPath: "/tmp/demo.mp4",
				outputDir: "/tmp/qa",
				samples: [sample({ timestampMs: 99_000 })],
			},
			env({ run })
		);
		expect(run.mock.calls[0][0]).toBe("ffprobe");
		expect(frames[0].timestampMs).toBe(11_910);
	});

	it("rejects a zero-byte frame rather than reviewing a blank image", async () => {
		await expect(
			extractFrames(
				{
					videoPath: "/tmp/demo.mp4",
					outputDir: "/tmp/qa",
					samples: [sample()],
					durationMs: 12_000,
				},
				env({ sizeOf: async () => 0 })
			)
		).rejects.toThrow(/zero-byte/);
	});

	it("surfaces an actionable install hint when ffmpeg is missing", async () => {
		const error = await extractFrames(
			{
				videoPath: "/tmp/demo.mp4",
				outputDir: "/tmp/qa",
				samples: [sample()],
				durationMs: 12_000,
			},
			env({
				run: async () => {
					throw enoent("ffmpeg");
				},
			})
		).catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(FfmpegMissingError);
		const missing = error as FfmpegMissingError;
		expect(missing.message).toContain("ffmpeg");
		expect(missing.remediation).toContain("brew install ffmpeg");
	});

	it("reports the ffmpeg failure when the extract exits non-zero", async () => {
		await expect(
			extractFrames(
				{
					videoPath: "/tmp/demo.mp4",
					outputDir: "/tmp/qa",
					samples: [sample()],
					durationMs: 12_000,
				},
				env({ run: async () => ({ code: 1, stdout: "", stderr: "Invalid data found" }) })
			)
		).rejects.toBeInstanceOf(FrameExtractionError);
	});

	it("writes real frames through the node environment without spawning ffmpeg", async () => {
		const dir = await mkdtemp(join(tmpdir(), "qa-frames-"));
		const fixture = await readFile(
			join(__dirname, "fixtures", "frame-1x1.png")
		);
		const nodeEnv = createNodeFrameEnv({
			run: async (_bin, args) => {
				await writeFile(args[args.length - 1], fixture);
				return { code: 0, stdout: "", stderr: "" };
			},
		});

		const frames = await extractFrames(
			{
				videoPath: "/tmp/demo.mp4",
				outputDir: join(dir, "frames"),
				samples: [sample()],
				durationMs: 12_000,
			},
			nodeEnv
		);
		expect(frames[0].bytes).toBe(fixture.byteLength);
	});
});

describe("probeAudioWindow", () => {
	it("reads the mean and max level of a window", async () => {
		const levels = await probeAudioWindow(
			"/tmp/demo.mp4",
			{ startMs: 10_000, durationMs: 1_500 },
			env({
				run: async () => ({
					code: 0,
					stdout: "",
					stderr:
						"[Parsed_volumedetect_0 @ 0x1] mean_volume: -31.4 dB\n[Parsed_volumedetect_0 @ 0x1] max_volume: -12.0 dB\n",
				}),
			})
		);
		expect(levels).toEqual({ meanDb: -31.4, maxDb: -12 });
	});

	it("returns null when the file has no audio stream", async () => {
		const levels = await probeAudioWindow(
			"/tmp/demo.mp4",
			{ startMs: 0, durationMs: 1_500 },
			env({
				run: async () => ({
					code: 1,
					stdout: "",
					stderr: "Stream map 'a:0' matches no streams.",
				}),
			})
		);
		expect(levels).toBeNull();
	});
});

describe("extractFrames at the edges", () => {
	it("clamps a timestamp exactly equal to the duration back inside the video", async () => {
		const frames = await extractFrames(
			{
				videoPath: "/tmp/demo.mp4",
				outputDir: "/tmp/qa",
				samples: [sample({ timestampMs: 12_010 })],
				durationMs: 12_010,
			},
			env()
		);
		expect(frames[0].clamped).toBe(true);
		expect(frames[0].timestampMs).toBe(11_910);
	});

	it("bounds the stderr it repeats from a chatty ffmpeg", async () => {
		const chatty = "frame=    1 fps=0.0 q=0.0 size=       0kB time=00:00:00.00 bitrate=N/A\n".repeat(20_000);
		const failure: unknown = await extractFrames(
			{
				videoPath: "/tmp/demo.mp4",
				outputDir: "/tmp/qa",
				samples: [sample()],
				durationMs: 12_010,
			},
			env({ run: async () => ({ code: 1, stdout: "", stderr: chatty }) })
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(FrameExtractionError);
		expect((failure as FrameExtractionError).message.length).toBeLessThan(1_000);
	});
});
