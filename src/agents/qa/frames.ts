/**
 * Frame extraction for the QA passes.
 *
 * ffmpeg/ffprobe are reached through an injected `FrameEnv` so the QA tests never spawn a
 * process. Extracted frames are handed on as file references (`imageRef`), never as inline
 * base64 — the same rule the Rust `ObservationFrame` follows, and the reason a minutes-long
 * session does not flood the transcript.
 */

import { z } from "zod";
import { AgentError } from "../errors/index";

export interface FfmpegExitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface FfmpegRunner {
	(bin: string, args: string[]): Promise<FfmpegExitResult>;
}

export interface FrameEnv {
	run: FfmpegRunner;
	sizeOf: (path: string) => Promise<number>;
	ensureDir: (path: string) => Promise<void>;
	ffmpegBin: string;
	ffprobeBin: string;
}

export class FfmpegMissingError extends AgentError {
	readonly binary: string;

	constructor(binary: string) {
		super(
			`Could not run "${binary}": the binary is not on PATH, so no frame could be extracted and the video was not reviewed.`,
			"QA_FFMPEG_MISSING",
			`Install ffmpeg (macOS: \`brew install ffmpeg\`, which also provides ffprobe) or pass an absolute path for "${binary}" when building the frame environment.`
		);
		this.name = "FfmpegMissingError";
		this.binary = binary;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export class FrameExtractionError extends AgentError {
	readonly videoPath: string;
	readonly timestampMs: number | null;

	constructor(
		message: string,
		videoPath: string,
		timestampMs: number | null,
		remediation: string
	) {
		super(message, "QA_FRAME_EXTRACTION_FAILED", remediation);
		this.name = "FrameExtractionError";
		this.videoPath = videoPath;
		this.timestampMs = timestampMs;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export class VideoProbeError extends AgentError {
	constructor(message: string, remediation: string) {
		super(message, "QA_VIDEO_PROBE_FAILED", remediation);
		this.name = "VideoProbeError";
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export type FrameRole = "beat" | "tail" | "opening";

export interface FrameSample {
	sampleId: string;
	label: string;
	timestampMs: number;
	role: FrameRole;
	beatId?: string | null;
	shotId?: string | null;
}

export interface ExtractedFrame extends FrameSample {
	path: string;
	/** Out-of-band reference to the PNG. Never an inline payload. */
	imageRef: string;
	bytes: number;
	requestedTimestampMs: number;
	clamped: boolean;
}

export interface VideoProbe {
	durationMs: number;
	fps: number;
	frameCount: number | null;
}

export interface AudioWindowLevels {
	meanDb: number;
	maxDb: number;
}

export type PastEndPolicy = "clamp" | "error";

export interface ExtractFramesOptions {
	videoPath: string;
	outputDir: string;
	samples: FrameSample[];
	/** Skips the ffprobe round-trip when the caller already measured the video. */
	durationMs?: number;
	pastEnd?: PastEndPolicy;
	/** How far before the last frame a clamped timestamp lands. Default 100ms. */
	tailMarginMs?: number;
}

const FfprobeStreamSchema = z.object({
	codec_type: z.string().optional(),
	nb_frames: z.string().optional(),
	avg_frame_rate: z.string().optional(),
	r_frame_rate: z.string().optional(),
	duration: z.string().optional(),
});

const FfprobeOutputSchema = z.object({
	streams: z.array(FfprobeStreamSchema).optional(),
	format: z.object({ duration: z.string().optional() }).optional(),
});

const MEAN_VOLUME = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/;
const MAX_VOLUME = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/;
const NO_AUDIO_STREAM = /matches no streams|does not contain any stream|Output file .* does not contain any stream/i;

function isMissingBinary(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const code = (error as { code?: unknown }).code;
	if (code === "ENOENT") return true;
	const message = (error as { message?: unknown }).message;
	return typeof message === "string" && message.includes("ENOENT");
}

async function runOrExplain(
	env: FrameEnv,
	bin: string,
	args: string[]
): Promise<FfmpegExitResult> {
	try {
		return await env.run(bin, args);
	} catch (error) {
		if (isMissingBinary(error)) throw new FfmpegMissingError(bin);
		throw error;
	}
}

function parseRate(value: string | undefined): number | null {
	if (!value) return null;
	const [num, den] = value.split("/");
	const numerator = Number(num);
	const denominator = den === undefined ? 1 : Number(den);
	if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
		return null;
	}
	const rate = numerator / denominator;
	return rate > 0 ? rate : null;
}

function parseSeconds(value: string | undefined): number | null {
	if (!value) return null;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function timestampArg(ms: number): string {
	return (Math.max(0, ms) / 1000).toFixed(3);
}

function tail(text: string, max = 400): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

function safeName(sampleId: string): string {
	return sampleId.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function createNodeFrameEnv(overrides: Partial<FrameEnv> = {}): FrameEnv {
	const run: FfmpegRunner = async (bin, args) => {
		const { execFile } = await import("node:child_process");
		return await new Promise<FfmpegExitResult>((resolve, reject) => {
			execFile(
				bin,
				args,
				{ maxBuffer: 8 * 1024 * 1024, windowsHide: true },
				(error, stdout, stderr) => {
					if (error && isMissingBinary(error)) {
						reject(error);
						return;
					}
					const code =
						error && typeof (error as { code?: unknown }).code === "number"
							? ((error as { code: number }).code as number)
							: error
								? 1
								: 0;
					resolve({ code, stdout: String(stdout), stderr: String(stderr) });
				}
			);
		});
	};

	return {
		run,
		sizeOf: async (path) => {
			const { stat } = await import("node:fs/promises");
			try {
				return (await stat(path)).size;
			} catch {
				return 0;
			}
		},
		ensureDir: async (path) => {
			const { mkdir } = await import("node:fs/promises");
			await mkdir(path, { recursive: true });
		},
		ffmpegBin: "ffmpeg",
		ffprobeBin: "ffprobe",
		...overrides,
	};
}

/**
 * The measurement SKILL.md step 3 asks for before choosing an export rate: the real capture
 * rate is often ~58 rather than 60, and forcing 60 judders.
 */
export async function probeVideo(videoPath: string, env: FrameEnv): Promise<VideoProbe> {
	const result = await runOrExplain(env, env.ffprobeBin, [
		"-v",
		"error",
		"-select_streams",
		"v:0",
		"-show_entries",
		"stream=nb_frames,duration,avg_frame_rate,r_frame_rate:format=duration",
		"-print_format",
		"json",
		videoPath,
	]);

	if (result.code !== 0) {
		throw new VideoProbeError(
			`ffprobe could not read "${videoPath}" (exit ${result.code}): ${tail(result.stderr)}`,
			"Check that the recording finished and that the path points at the segment's display.mp4."
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new VideoProbeError(
			`ffprobe returned output that is not JSON for "${videoPath}": ${tail(result.stdout)}`,
			"Confirm the ffprobe build supports `-print_format json`."
		);
	}

	const probe = FfprobeOutputSchema.safeParse(parsed);
	if (!probe.success) {
		throw new VideoProbeError(
			`ffprobe JSON did not match the expected shape for "${videoPath}".`,
			"Confirm the ffprobe build supports `-print_format json`."
		);
	}

	const stream = probe.data.streams?.[0];
	const seconds =
		parseSeconds(stream?.duration) ?? parseSeconds(probe.data.format?.duration);
	if (seconds === null) {
		throw new VideoProbeError(
			`ffprobe reported no duration for "${videoPath}".`,
			"The file is probably truncated or still being written — stop the recording before QA."
		);
	}

	const frameCountRaw = Number(stream?.nb_frames);
	const frameCount = Number.isFinite(frameCountRaw) && frameCountRaw > 0 ? frameCountRaw : null;
	const fps =
		parseRate(stream?.avg_frame_rate) ??
		parseRate(stream?.r_frame_rate) ??
		(frameCount === null ? null : frameCount / seconds);

	if (fps === null) {
		throw new VideoProbeError(
			`ffprobe reported no frame rate for "${videoPath}".`,
			"Re-run the capture; a stream without a rate cannot be checked for judder."
		);
	}

	return { durationMs: Math.round(seconds * 1000), fps, frameCount };
}

/** Mean/max dBFS across a window of the audio track, or null when the file has no audio. */
export async function probeAudioWindow(
	videoPath: string,
	window: { startMs: number; durationMs: number },
	env: FrameEnv
): Promise<AudioWindowLevels | null> {
	const result = await runOrExplain(env, env.ffmpegBin, [
		"-hide_banner",
		"-nostats",
		"-ss",
		timestampArg(window.startMs),
		"-t",
		timestampArg(window.durationMs),
		"-i",
		videoPath,
		"-map",
		"a:0",
		"-af",
		"volumedetect",
		"-f",
		"null",
		"-",
	]);

	if (NO_AUDIO_STREAM.test(result.stderr)) return null;
	if (result.code !== 0) {
		throw new FrameExtractionError(
			`ffmpeg could not measure the audio of "${videoPath}" (exit ${result.code}): ${tail(result.stderr)}`,
			videoPath,
			window.startMs,
			"Check the export actually carries the music track before judging its fades."
		);
	}

	const mean = MEAN_VOLUME.exec(result.stderr);
	const max = MAX_VOLUME.exec(result.stderr);
	if (!mean || !max) return null;
	return { meanDb: Number(mean[1]), maxDb: Number(max[1]) };
}

export async function extractFrames(
	options: ExtractFramesOptions,
	env: FrameEnv
): Promise<ExtractedFrame[]> {
	const { videoPath, outputDir, samples, pastEnd = "clamp", tailMarginMs = 100 } = options;
	if (samples.length === 0) return [];

	const needsDuration =
		options.durationMs === undefined &&
		samples.some((sample) => sample.timestampMs > 0);
	const durationMs =
		options.durationMs ?? (needsDuration ? (await probeVideo(videoPath, env)).durationMs : 0);

	await env.ensureDir(outputDir);

	const frames: ExtractedFrame[] = [];
	for (const sample of samples) {
		const requested = Math.max(0, Math.round(sample.timestampMs));
		let timestampMs = requested;
		let clamped = false;

		if (durationMs > 0 && requested >= durationMs) {
			if (pastEnd === "error") {
				throw new FrameExtractionError(
					`Frame "${sample.sampleId}" was requested at ${requested}ms but "${videoPath}" is only ${durationMs}ms long.`,
					videoPath,
					requested,
					"Align the beat log to the video before sampling — the capture can be shorter than the event log, so anchor to the tail."
				);
			}
			timestampMs = Math.max(0, durationMs - tailMarginMs);
			clamped = true;
		}

		const path = `${outputDir.replace(/\/$/, "")}/${safeName(sample.sampleId)}.png`;
		const result = await runOrExplain(env, env.ffmpegBin, [
			"-y",
			"-ss",
			timestampArg(timestampMs),
			"-i",
			videoPath,
			"-frames:v",
			"1",
			path,
		]);

		if (result.code !== 0) {
			throw new FrameExtractionError(
				`ffmpeg failed to extract "${sample.sampleId}" at ${timestampMs}ms from "${videoPath}" (exit ${result.code}): ${tail(result.stderr)}`,
				videoPath,
				timestampMs,
				"Re-check the video path and the requested timestamp before re-running QA."
			);
		}

		const bytes = await env.sizeOf(path);
		if (bytes === 0) {
			throw new FrameExtractionError(
				`ffmpeg wrote a zero-byte frame for "${sample.sampleId}" at ${timestampMs}ms of "${videoPath}".`,
				videoPath,
				timestampMs,
				"The seek landed past the last decodable frame; sample earlier or re-measure the duration. QA cannot pass on a frame nobody can see."
			);
		}

		frames.push({
			...sample,
			timestampMs,
			requestedTimestampMs: requested,
			clamped,
			path,
			imageRef: `file://${path}`,
			bytes,
		});
	}

	return frames;
}
