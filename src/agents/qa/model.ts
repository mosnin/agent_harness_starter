/**
 * The seam between a QA pass and whatever looks at the frames.
 *
 * Every pass goes through `VisionQaModel`, so tests fake the model instead of calling a provider.
 * A response that does not satisfy the pass's schema raises `QaVerdictInvalidError` rather than
 * degrading to an accept: a QA gate that fails open is worse than no gate at all.
 */

import type { z } from "zod";
import { AgentError } from "../errors/index";
import type { ExtractedFrame } from "./frames";
import { config } from "../lib/config";

export interface VisionQaFrame {
	sampleId: string;
	label: string;
	timestampMs: number;
	imageRef: string;
	path: string;
	beatId?: string | null;
	shotId?: string | null;
}

export interface VisionQaRequest {
	system: string;
	instructions: string;
	/** JSON Schema of the verdict the pass will accept, derived from the Zod schema. */
	responseSchema: unknown;
	frames: VisionQaFrame[];
}

export interface VisionQaModel {
	(request: VisionQaRequest): Promise<unknown>;
}

export class QaVerdictError extends AgentError {}

export class QaVerdictInvalidError extends QaVerdictError {
	readonly issues: string[];

	constructor(pass: string, issues: string[]) {
		super(
			`The ${pass} QA model returned a verdict that does not satisfy the schema: ${issues.join("; ")}.`,
			"QA_VERDICT_INVALID",
			"Treat the pass as not run — never as an accept. Re-ask the model, or hand the export to a human."
		);
		this.name = "QaVerdictInvalidError";
		this.issues = issues;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export class QaLowConfidenceError extends QaVerdictError {
	readonly confidence: number;

	constructor(pass: string, confidence: number, minimum: number, summary: string) {
		super(
			`The ${pass} QA model reported ${confidence.toFixed(2)} confidence, below the ${minimum.toFixed(2)} floor: "${summary}".`,
			"QA_VERDICT_LOW_CONFIDENCE",
			"Do not ship on an uncertain look. Sample more frames or hand the export to a human."
		);
		this.name = "QaLowConfidenceError";
		this.confidence = confidence;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export function toVisionFrames(frames: ExtractedFrame[]): VisionQaFrame[] {
	return frames.map((frame) => ({
		sampleId: frame.sampleId,
		label: frame.label,
		timestampMs: frame.timestampMs,
		imageRef: frame.imageRef,
		path: frame.path,
		beatId: frame.beatId ?? null,
		shotId: frame.shotId ?? null,
	}));
}

export function parseQaResponse<T extends z.ZodType>(
	pass: string,
	schema: T,
	raw: unknown
): z.infer<T> {
	const result = schema.safeParse(raw);
	if (result.success) return result.data;
	const issues = result.error.issues.map((issue) => {
		const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
		return `${path}: ${issue.message}`;
	});
	throw new QaVerdictInvalidError(pass, issues);
}

export function assertConfident(
	pass: string,
	confidence: number,
	minimum: number,
	summary: string
): void {
	if (confidence < minimum) {
		throw new QaLowConfidenceError(pass, confidence, minimum, summary);
	}
}

export interface OpenAiVisionQaModelOptions {
	apiKey?: string;
	model?: string;
	baseUrl?: string;
	maxOutputTokens?: number;
	/** Injected for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
	/** Injected for tests; defaults to reading the PNG off disk. */
	readImage?: (path: string) => Promise<string>;
}

interface OpenAiChatResponse {
	choices?: Array<{ message?: { content?: string | null } }>;
}

async function readImageAsDataUrl(path: string): Promise<string> {
	const { readFile } = await import("node:fs/promises");
	const bytes = await readFile(path);
	return `data:image/png;base64,${bytes.toString("base64")}`;
}

/**
 * The project's computer-use provider is OpenAI (`src/agents/lib/config.ts`), so the default QA
 * eyes are an OpenAI vision model. Frames are base64-encoded here, on the wire to the provider
 * only — the transcript and every tool result keep the `imageRef`.
 */
export function createOpenAiVisionQaModel(
	options: OpenAiVisionQaModelOptions = {}
): VisionQaModel {
	const apiKey = options.apiKey ?? config.openai.apiKey;
	const model = options.model ?? config.openai.model;
	const baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
	const doFetch = options.fetchImpl ?? fetch;
	const readImage = options.readImage ?? readImageAsDataUrl;

	return async (request) => {
		if (!apiKey) {
			throw new AgentError(
				"No OpenAI API key is configured, so the frames cannot be reviewed.",
				"QA_MODEL_UNCONFIGURED",
				"Set OPENAI_API_KEY, or inject a VisionQaModel of your own."
			);
		}

		const content: Array<Record<string, unknown>> = [
			{
				type: "text",
				text: [
					request.instructions,
					"",
					"Reply with JSON only, matching this JSON Schema:",
					JSON.stringify(request.responseSchema),
					"",
					"Frames, in order:",
					...request.frames.map(
						(frame, index) =>
							`${index + 1}. ${frame.label} — sampleId=${frame.sampleId}, t=${frame.timestampMs}ms${frame.beatId ? `, beatId=${frame.beatId}` : ""}${frame.shotId ? `, shotId=${frame.shotId}` : ""}`
					),
				].join("\n"),
			},
		];

		for (const frame of request.frames) {
			content.push({
				type: "image_url",
				image_url: { url: await readImage(frame.path), detail: "high" },
			});
		}

		const response = await doFetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				max_tokens: options.maxOutputTokens ?? 1500,
				response_format: { type: "json_object" },
				messages: [
					{ role: "system", content: request.system },
					{ role: "user", content },
				],
			}),
		});

		if (!response.ok) {
			const body = await response.text();
			throw new AgentError(
				`OpenAI QA request failed with ${response.status}: ${body.slice(0, 500)}`,
				"QA_MODEL_REQUEST_FAILED",
				"Retry the pass; do not ship the export on a failed QA request."
			);
		}

		const payload = (await response.json()) as OpenAiChatResponse;
		const text = payload.choices?.[0]?.message?.content;
		if (!text) {
			throw new QaVerdictInvalidError("vision", ["the model returned an empty message"]);
		}

		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new QaVerdictInvalidError("vision", [
				`the model returned text that is not JSON: ${text.slice(0, 200)}`,
			]);
		}
	};
}
