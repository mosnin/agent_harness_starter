import type { AgentEvent } from "@/agents/types";
import type { CapScope } from "@/agents/tools/cap/types";
import type {
	StudioApproval,
	StudioArtifact,
	StudioFailure,
	StudioObservation,
	StudioState,
	StudioStep,
} from "./types";

/**
 * Pure event → state reduction, kept out of the components so the surface can be reasoned about
 * (and tested) without a DOM. The container owns transport; this owns meaning.
 */

export interface StudioReducerOptions {
	/** Turns a protocol `imageRef` into something an <img> can load. */
	resolveImageUrl?: (imageRef: string) => string;
	now?: () => number;
}

const TOOL_SUFFIXES = {
	observe: "_observe",
	act: "_act",
	recordingStart: "_recording_start",
	recordingStop: "_recording_stop",
	applyStoryboard: "_apply_storyboard",
	exportVideo: "_export",
} as const;

function isTool(name: string, suffix: string): boolean {
	return name.endsWith(suffix);
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function scopeOf(value: unknown): CapScope {
	const scope = str(value);
	return (scope ?? "observe_screen") as CapScope;
}

function labelForToolCall(name: string, input: unknown): string {
	const record = asRecord(input);
	if (isTool(name, TOOL_SUFFIXES.act)) {
		const action = asRecord(record.action);
		const beat = str(record.beatLabel);
		return beat ?? `${str(action.type) ?? "act"} on your Mac`;
	}
	if (isTool(name, TOOL_SUFFIXES.observe)) return "Look at the screen";
	if (isTool(name, TOOL_SUFFIXES.recordingStart)) return "Start recording";
	if (isTool(name, TOOL_SUFFIXES.recordingStop)) return "Stop recording";
	if (isTool(name, TOOL_SUFFIXES.applyStoryboard)) return "Apply the storyboard";
	if (isTool(name, TOOL_SUFFIXES.exportVideo)) return "Render the video";
	return name;
}

function actionTypeOf(name: string, input: unknown): string {
	const record = asRecord(input);
	const action = asRecord(record.action);
	return str(action.type) ?? name;
}

function scopeForToolCall(name: string, input: unknown): CapScope {
	if (isTool(name, TOOL_SUFFIXES.act)) {
		const action = asRecord(asRecord(input).action);
		switch (str(action.type)) {
			case "typeText":
			case "keyPress":
				return "control_keyboard";
			case "focusApplication":
			case "launchApplication":
				return "control_applications";
			case "wait":
				return "observe_screen";
			default:
				return "control_pointer";
		}
	}
	if (isTool(name, TOOL_SUFFIXES.recordingStart) || isTool(name, TOOL_SUFFIXES.recordingStop)) {
		return "record";
	}
	if (isTool(name, TOOL_SUFFIXES.applyStoryboard)) return "edit";
	if (isTool(name, TOOL_SUFFIXES.exportVideo)) return "export";
	return "observe_screen";
}

function observationFrom(
	output: unknown,
	resolveImageUrl: (imageRef: string) => string
): StudioObservation | null {
	const frame = asRecord(output);
	const imageRef = str(frame.imageRef);
	const frameId = str(frame.frameId);
	if (!imageRef || !frameId) return null;
	const window = asRecord(frame.focusedWindow);
	const redacted = Array.isArray(frame.redactedWindows)
		? frame.redactedWindows.filter((w): w is string => typeof w === "string")
		: [];
	return {
		frameId,
		imageUrl: resolveImageUrl(imageRef),
		width: num(frame.width) ?? 0,
		height: num(frame.height) ?? 0,
		capturedAtUnixMs: num(frame.capturedAtUnixMs) ?? 0,
		focusedWindowTitle: str(window.title),
		redactedWindows: redacted,
	};
}

function artifactFrom(name: string, output: unknown, id: string): StudioArtifact | null {
	const record = asRecord(output);
	if (isTool(name, TOOL_SUFFIXES.recordingStart)) {
		const path = str(record.projectPath);
		return path
			? { id, kind: "recording", label: str(record.recordingId) ?? "Recording", path }
			: null;
	}
	if (isTool(name, TOOL_SUFFIXES.recordingStop)) {
		const path = str(record.projectPath);
		return path
			? {
					id,
					kind: "project",
					label: str(record.recordingId) ?? "Recording",
					path,
					durationMs: num(record.durationMs),
					fps: num(record.measuredFps),
				}
			: null;
	}
	if (isTool(name, TOOL_SUFFIXES.applyStoryboard)) {
		const path = str(record.projectPath);
		return path
			? {
					id,
					kind: "storyboard",
					label: `${num(record.shotCount) ?? 0} shots`,
					path,
				}
			: null;
	}
	if (isTool(name, TOOL_SUFFIXES.exportVideo)) {
		const path = str(record.outputPath);
		return path
			? {
					id,
					kind: "export",
					label: "Demo video",
					path,
					durationMs: num(record.durationMs),
					fps: num(record.fps),
					bytes: num(record.bytes),
				}
			: null;
	}
	return null;
}

/**
 * Names the thing the agent was reaching for. A `Target` is one of three shapes and only the
 * query form carries anything a human recognises, so the point and element forms fall back to
 * something at least locatable rather than to nothing at all.
 */
function describeTarget(value: unknown): string | null {
	const target = asRecord(value);
	switch (str(target.type)) {
		case "elementQuery": {
			const parts = [str(target.title), str(target.role), str(target.identifier)].filter(
				(part): part is string => part !== null && part !== ""
			);
			const nth = num(target.nth);
			const described = parts.length > 0 ? parts.join(" · ") : "an unnamed element";
			return nth !== null ? `${described} (match ${nth + 1})` : described;
		}
		case "element":
			return str(target.elementId) ? `element ${str(target.elementId)}` : null;
		case "point": {
			const point = asRecord(target.point);
			const x = num(point.x);
			const y = num(point.y);
			return x !== null && y !== null ? `the point ${Math.round(x)}, ${Math.round(y)}` : null;
		}
		default:
			return null;
	}
}

function targetForToolCall(input: unknown): string | null {
	const action = asRecord(asRecord(input).action);
	return describeTarget(action.target) ?? describeTarget(action.from);
}

/**
 * `target_ambiguous` is only legible with the number of things that matched. The control plane
 * should send it as a field; until it does, the count is read out of the message the runner
 * already writes ("3 elements match …").
 */
function candidateCountFrom(event: Record<string, unknown>, message: string): number | null {
	const structured = num(event.candidateCount);
	if (structured !== null) return structured;
	const listed = Array.isArray(event.candidates) ? event.candidates.length : null;
	if (listed !== null) return listed;
	const matched = /(\d+)\s+(?:candidates?|elements?|matches?|windows?)/i.exec(message);
	return matched ? Number.parseInt(matched[1], 10) : null;
}

function candidateLabelsFrom(event: Record<string, unknown>): string[] {
	if (!Array.isArray(event.candidates)) return [];
	return event.candidates
		.map((candidate) => {
			if (typeof candidate === "string") return candidate;
			const record = asRecord(candidate);
			const parts = [str(record.title), str(record.role), str(record.identifier)].filter(
				(part): part is string => part !== null && part !== ""
			);
			return parts.length > 0 ? parts.join(" · ") : (str(record.elementId) ?? "");
		})
		.filter((label) => label !== "");
}

function approvalScopes(input: unknown, toolName: string): CapScope[] {
	const record = asRecord(input);
	if (Array.isArray(record.requiredScopes)) {
		return record.requiredScopes.map(scopeOf);
	}
	return [scopeForToolCall(toolName, input)];
}

export function createStudioReducer(options: StudioReducerOptions = {}) {
	const resolveImageUrl = options.resolveImageUrl ?? ((imageRef: string) => imageRef);
	const now = options.now ?? (() => Date.now());

	return function studioReducer(state: StudioState, event: AgentEvent): StudioState {
		switch (event.type) {
			case "tool_call": {
				const step: StudioStep = {
					id: event.callId,
					index: state.steps.length,
					label: labelForToolCall(event.name, event.input),
					actionType: actionTypeOf(event.name, event.input),
					scope: scopeForToolCall(event.name, event.input),
					status: "running",
					atUnixMs: now(),
					beatLabel: str(asRecord(event.input).beatLabel),
					target: targetForToolCall(event.input),
				};
				return { ...state, steps: [...state.steps, step] };
			}

			case "tool_result": {
				const steps = state.steps.map((step) =>
					step.id === event.callId ? { ...step, status: "succeeded" as const } : step
				);
				const observation = isTool(event.name, TOOL_SUFFIXES.observe)
					? (observationFrom(event.output, resolveImageUrl) ?? state.observation)
					: state.observation;
				const artifact = artifactFrom(event.name, event.output, event.callId);
				return {
					...state,
					steps,
					observation,
					artifacts: artifact ? [...state.artifacts, artifact] : state.artifacts,
				};
			}

			case "approval_required": {
				if (state.approvals.some((a) => a.approvalId === event.approvalId)) return state;
				const approval: StudioApproval = {
					approvalId: event.approvalId,
					toolName: event.toolName,
					summary: event.description || labelForToolCall(event.toolName, event.input),
					scopes: approvalScopes(event.input, event.toolName),
					requestedAtUnixMs: now(),
					details: JSON.stringify(event.input, null, 2),
				};
				return { ...state, approvals: [...state.approvals, approval] };
			}

			case "progress": {
				const steps = state.steps.map((step, i) =>
					i === state.steps.length - 1 && step.status === "running"
						? { ...step, detail: event.detail ?? event.stage }
						: step
				);
				return { ...state, steps };
			}

			case "error": {
				const raw = asRecord(event);
				const failing = [...state.steps].reverse().find((step) => step.status === "running");
				const failure: StudioFailure = {
					message: event.error,
					code: event.code ?? null,
					remediation: event.remediation ?? null,
					stepId: failing?.id ?? null,
					stepIndex: failing?.index ?? null,
					stepLabel: failing?.label ?? null,
					toolName: event.toolName ?? null,
					target: failing?.target ?? str(raw.target) ?? null,
					candidateCount: candidateCountFrom(raw, event.error),
					candidates: candidateLabelsFrom(raw),
					observationFrameId: state.observation?.frameId ?? null,
					observationImageUrl: state.observation?.imageUrl ?? null,
					observationCapturedAtUnixMs: state.observation?.capturedAtUnixMs ?? null,
					atUnixMs: now(),
				};
				const steps = state.steps.map((step) =>
					step.status === "running"
						? { ...step, status: "failed" as const, detail: event.error, failure }
						: step
				);
				return {
					...state,
					steps,
					failure,
					error: event.remediation ? `${event.error} — ${event.remediation}` : event.error,
				};
			}

			case "done": {
				const steps = state.steps.map((step) =>
					step.status === "running" ? { ...step, status: "succeeded" as const } : step
				);
				return { ...state, steps };
			}

			default:
				return state;
		}
	};
}

export function resolveApproval(state: StudioState, approvalId: string): StudioState {
	return {
		...state,
		approvals: state.approvals.filter((a) => a.approvalId !== approvalId),
	};
}
