import { describe, expect, it, vi } from "vitest";
import type { Beat } from "../tools/cap/types";
import type { FrameEnv } from "../qa/frames";
import { QaLowConfidenceError, QaVerdictInvalidError, type VisionQaModel } from "../qa/model";
import {
	RAW_CHECKS,
	RawFootageRejectedError,
	type RawFinding,
	assertRawFootageUsable,
	planRawSamples,
	rawDisplayPath,
	runRawFootageQa,
} from "../qa/raw";

const BEATS: Beat[] = [
	{ beatId: "b1", offsetMs: 900, kind: "action", label: "click Book a demo", landmark: null },
	{ beatId: "b2", offsetMs: 4_200, kind: "reveal", label: "destination header", landmark: null },
	{ beatId: "b3", offsetMs: 5_000, kind: "idle", label: "dwell", landmark: null },
];

function frameEnv(): FrameEnv {
	return {
		run: async () => ({ code: 0, stdout: "", stderr: "" }),
		sizeOf: async () => 4096,
		ensureDir: async () => {},
		ffmpegBin: "ffmpeg",
		ffprobeBin: "ffprobe",
	};
}

function passing(check: (typeof RAW_CHECKS)[number]): RawFinding {
	return {
		check,
		status: "pass",
		beatId: null,
		sampleId: null,
		defect: "Nothing wrong in any sampled frame.",
		remedy: "none",
	};
}

function rawResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		decision: "proceed",
		confidence: 0.9,
		summary: "Right window, no banner, the click landed on real content.",
		suggestedStory: null,
		findings: RAW_CHECKS.map(passing),
		...overrides,
	};
}

function modelReturning(payload: unknown): VisionQaModel {
	return async () => payload;
}

function input(overrides: Record<string, unknown> = {}) {
	return {
		projectPath: "/tmp/cap-demo/acme/acme.cap",
		outputDir: "/tmp/qa-raw",
		durationMs: 11_000,
		beats: BEATS,
		expected: { windowTitle: "Acme — Safari", ctaText: "Book a demo", story: "click" as const },
		...overrides,
	};
}

describe("rawDisplayPath", () => {
	it("points at the segment the cap recording writes", () => {
		expect(rawDisplayPath("/tmp/acme.cap")).toBe(
			"/tmp/acme.cap/content/segments/segment-0/display.mp4"
		);
		expect(rawDisplayPath("/tmp/acme.cap/")).toBe(
			"/tmp/acme.cap/content/segments/segment-0/display.mp4"
		);
	});
});

describe("planRawSamples", () => {
	it("samples the opening, the non-idle beats and the tail", () => {
		const samples = planRawSamples(BEATS, 11_000);
		expect(samples.map((s) => [s.sampleId, s.timestampMs])).toEqual([
			["raw-opening", 250],
			["raw-beat-1", 900],
			["raw-beat-2", 4_200],
			["raw-tail", 10_800],
		]);
	});

	it("always keeps the opening and the tail when the budget is small", () => {
		const samples = planRawSamples(BEATS, 11_000, { maxFrames: 2 });
		expect(samples.map((s) => s.sampleId)).toEqual(["raw-opening", "raw-tail"]);
	});

	it("folds beats at or past the tail into the tail frame, so a short capture costs one look", () => {
		const samples = planRawSamples(BEATS, 1_000);
		expect(samples.map((s) => s.sampleId)).toEqual(["raw-opening", "raw-tail"]);
	});
});

describe("runRawFootageQa", () => {
	it("proceeds on a clean capture and returns frame references", async () => {
		const report = await runRawFootageQa(input(), {
			env: frameEnv(),
			model: modelReturning(rawResponse()),
		});
		expect(report.decision).toBe("proceed");
		expect(report.frames[0].imageRef).toBe("file:///tmp/qa-raw/raw-opening.png");
		expect(() => assertRawFootageUsable(report)).not.toThrow();
	});

	it("stops a dead-end CTA before an export is paid for", async () => {
		const exportVideo = vi.fn();
		const report = await runRawFootageQa(input(), {
			env: frameEnv(),
			model: modelReturning(
				rawResponse({
					decision: "reshoot",
					suggestedStory: "scroll",
					summary: "The CTA dead-ends at a booking calendar.",
					findings: [
						passing("capture_target"),
						passing("cookie_banner"),
						passing("tail_bleed"),
						{
							check: "cta_dead_end",
							status: "fail",
							beatId: "b2",
							sampleId: "raw-beat-2",
							defect: "The click lands on a Cal.com booking grid, not product content.",
							remedy: "reshoot",
						},
					],
				})
			),
		});

		expect(report.decision).toBe("reshoot");
		expect(report.suggestedStory).toBe("scroll");

		const thrown = (() => {
			try {
				assertRawFootageUsable(report);
				exportVideo();
				return null;
			} catch (error) {
				return error;
			}
		})();

		expect(thrown).toBeInstanceOf(RawFootageRejectedError);
		expect((thrown as RawFootageRejectedError).remediation).toContain("scroll");
		expect((thrown as RawFootageRejectedError).message).toContain("booking grid");
		expect(exportVideo).not.toHaveBeenCalled();
	});

	it("flags a leaked cookie banner against the frame it is visible in", async () => {
		const report = await runRawFootageQa(input(), {
			env: frameEnv(),
			model: modelReturning(
				rawResponse({
					decision: "reshoot",
					findings: [
						passing("capture_target"),
						passing("cta_dead_end"),
						passing("tail_bleed"),
						{
							check: "cookie_banner",
							status: "fail",
							beatId: null,
							sampleId: "raw-opening",
							defect: "A consent banner covers the lower third of the opening frame.",
							remedy: "reshoot",
						},
					],
				})
			),
		});
		expect(report.findings.find((f) => f.check === "cookie_banner")?.sampleId).toBe(
			"raw-opening"
		);
	});

	it("rejects a malformed verdict rather than proceeding", async () => {
		await expect(
			runRawFootageQa(input(), {
				env: frameEnv(),
				model: modelReturning({ decision: "proceed" }),
			})
		).rejects.toBeInstanceOf(QaVerdictInvalidError);
	});

	it("rejects a proceed that contradicts its own failing findings", async () => {
		await expect(
			runRawFootageQa(input(), {
				env: frameEnv(),
				model: modelReturning(
					rawResponse({
						findings: [
							passing("capture_target"),
							passing("cookie_banner"),
							passing("tail_bleed"),
							{
								check: "cta_dead_end",
								status: "fail",
								beatId: "b2",
								sampleId: "raw-beat-2",
								defect: "The click lands on a login form.",
								remedy: "reshoot",
							},
						],
					})
				),
			})
		).rejects.toThrow(/cannot proceed/);
	});

	it("refuses to proceed on a low-confidence look", async () => {
		await expect(
			runRawFootageQa(input(), {
				env: frameEnv(),
				model: modelReturning(rawResponse({ confidence: 0.25 })),
			})
		).rejects.toBeInstanceOf(QaLowConfidenceError);
	});

	it("needs a project or a video path", async () => {
		await expect(
			runRawFootageQa(input({ projectPath: undefined }), {
				env: frameEnv(),
				model: modelReturning(rawResponse()),
			})
		).rejects.toMatchObject({ code: "QA_RAW_INPUT_INVALID" });
	});

	it("surfaces a missing ffmpeg before it asks the model anything", async () => {
		const model = vi.fn(modelReturning(rawResponse()));
		await expect(
			runRawFootageQa(input(), {
				env: {
					...frameEnv(),
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
