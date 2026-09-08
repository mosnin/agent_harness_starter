import type { AgentEvent } from "@/agents/types";
import type { CapScope } from "@/agents/tools/cap/types";
import type {
	StudioApproval,
	StudioArtifact,
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
				const steps = state.steps.map((step) =>
					step.status === "running"
						? { ...step, status: "failed" as const, detail: event.error }
						: step
				);
				return { ...state, steps, error: event.remediation ? `${event.error} — ${event.remediation}` : event.error };
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
