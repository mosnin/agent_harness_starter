/**
 * Director Protocol tool pack.
 *
 * `createCapToolPack` closes over an injected client and session reader, the way
 * `tools/sandbox/shell.ts` closes over a `SandboxToolConfig` — but every pack gets its own tool
 * name prefix, because `registerTool` overwrites an existing entry with the same name and two
 * packs sharing a name would silently share one registry slot.
 *
 * Every `execute` calls `authorizeDesktopCommand` before it touches the client. That check is the
 * one that always runs: the orchestrator never applies plugins.
 */

import { z } from "zod";
import { registerTool } from "../registry";
import type { ToolContext, ToolDefinition } from "../types";
import {
	assertObservationIsReference,
	authorizeDesktopCommand,
	DesktopAuthorizationError,
} from "./authorization";
import type { DesktopSessionReader, DirectorClient } from "./client";
import { assertStoryboardValid } from "./storyboard";
import {
	DEFAULT_EDITORIAL_LIMITS,
	ExportRequestSchema,
	InputActionSchema,
	ObserveRequestSchema,
	StartRecordingRequestSchema,
	StoryboardSchema,
	captureGeometry,
	observationExtensions,
	scopeForAction,
	guardRedactsTitle,
} from "./types";
import type {
	Beat,
	DirectorCommand,
	DirectorCommandResult,
	EditorialLimits,
	ObservationFrame,
	Rect,
	UiElement,
	WindowInfo,
} from "./types";

export interface CapToolPackOptions {
	client: DirectorClient;
	sessions: DesktopSessionReader;
	/**
	 * Prefix for every tool name in this pack. Two packs must not share one — the registry keys
	 * on name and the later `registerTool` wins.
	 */
	namespace?: string;
	/** Editorial limits enforced before a storyboard is sent to the runner. */
	limits?: EditorialLimits;
	/** Maximum accessibility elements returned to the model per observation. */
	maxElements?: number;
	/** Called after each command so governance counters can track failures and rate. */
	onCommandOutcome?: (sessionId: string, outcome: "ok" | "failed") => void;
	nowUnixMs?: () => number;
}

const sessionFields = {
	sessionId: z
		.string()
		.min(1)
		.describe("Identifier of the user-granted session lease this command runs under"),
	approvalId: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Identifier of the human approval for this step. Required when the session guard sets requireStepApproval and the command needs an intrusive scope."
		),
};

export interface ObservationSummary {
	sessionId: string;
	frameId: string;
	imageRef: string;
	width: number;
	height: number;
	capturedAtUnixMs: number;
	display: ObservationFrame["display"];
	focusedWindow: WindowInfo | null;
	redactedWindows: string[];
	/**
	 * Protocol v1.2 `maskedRegions`: areas blacked out in the image itself. An element whose
	 * bounds fall inside one cannot be visually verified from this frame.
	 */
	maskedRegions?: Rect[];
	elementCount: number;
	elementsTruncated: boolean;
	elements: Array<{
		elementId: string;
		role: string;
		title: string | null;
		value: string | null;
		identifier: string | null;
		bounds: UiElement["bounds"];
		enabled: boolean;
		focused: boolean;
	}>;
}

function truncate(value: string | null | undefined, max = 120): string | null {
	if (value === null || value === undefined) return null;
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function summarizeFrame(
	sessionId: string,
	frame: ObservationFrame,
	maxElements: number
): ObservationSummary {
	assertObservationIsReference(frame.imageRef, sessionId);

	const elements = frame.elements.slice(0, maxElements).map((element) => ({
		elementId: element.elementId,
		role: element.role,
		title: truncate(element.title),
		value: truncate(element.value),
		identifier: element.identifier ?? null,
		bounds: element.bounds,
		enabled: element.enabled,
		focused: element.focused,
	}));

	return {
		sessionId,
		frameId: frame.frameId,
		imageRef: frame.imageRef,
		width: frame.width,
		height: frame.height,
		capturedAtUnixMs: frame.capturedAtUnixMs,
		display: frame.display,
		focusedWindow: frame.focusedWindow ?? null,
		redactedWindows: frame.redactedWindows,
		maskedRegions: observationExtensions(frame).maskedRegions,
		elementCount: frame.elements.length,
		elementsTruncated: frame.elements.length > elements.length,
		elements,
	};
}

/** A stable fingerprint of what is on screen, used by the operator loop to detect a stall. */
export function observationFingerprint(observation: ObservationSummary): string {
	const window = observation.focusedWindow;
	const elements = observation.elements
		.map((e) => `${e.elementId}:${e.role}:${e.title ?? ""}:${e.value ?? ""}:${e.focused ? 1 : 0}`)
		.join("|");
	return [
		observation.display.displayId,
		window?.windowId ?? "",
		window?.title ?? "",
		observation.elementCount,
		elements,
	].join("§");
}

export interface CapToolPack {
	observe: ToolDefinition<z.ZodTypeAny, ObservationSummary>;
	listWindows: ToolDefinition<z.ZodTypeAny, { count: number; windows: WindowInfo[] }>;
	act: ToolDefinition<z.ZodTypeAny, ActToolResult>;
	recordingStart: ToolDefinition<
		z.ZodTypeAny,
		{ recordingId: string; projectPath: string; startedAtUnixMs: number }
	>;
	recordingStop: ToolDefinition<z.ZodTypeAny, RecordingStopResult>;
	applyStoryboard: ToolDefinition<z.ZodTypeAny, { projectPath: string; shotCount: number }>;
	exportVideo: ToolDefinition<
		z.ZodTypeAny,
		{ outputPath: string; durationMs: number; fps: number; bytes: number }
	>;
	toolNames: string[];
	all: ToolDefinition[];
}

export interface ActToolResult {
	sessionId: string;
	action: string;
	scope: string;
	beat: Beat | null;
}

export interface RecordingStopResult {
	recordingId: string;
	projectPath: string;
	durationMs: number;
	measuredFps: number;
	/** Protocol v1.2 capture geometry, in physical pixels. Zero when the runner predates v1.2. */
	width: number;
	height: number;
	beatCount: number;
	beats: Beat[];
}

function unexpected(
	sessionId: string,
	expected: DirectorCommandResult["type"],
	actual: string
): DesktopAuthorizationError {
	return new DesktopAuthorizationError(
		"internal",
		`Runner replied "${actual}" to a command expecting "${expected}".`,
		sessionId
	);
}

export function createCapToolPack(options: CapToolPackOptions): CapToolPack {
	const {
		client,
		sessions,
		namespace = "cap",
		limits = DEFAULT_EDITORIAL_LIMITS,
		maxElements = 60,
		onCommandOutcome,
	} = options;
	const nowUnixMs = options.nowUnixMs ?? (() => Date.now());

	async function dispatch(
		sessionId: string,
		command: DirectorCommand,
		approvalId: string | undefined,
		ctx: ToolContext
	): Promise<DirectorCommandResult> {
		authorizeDesktopCommand(sessions, {
			sessionId,
			command,
			approvalId,
			nowUnixMs: nowUnixMs(),
		});

		try {
			const result = await client.send(command, { sessionId, signal: ctx.signal });
			onCommandOutcome?.(sessionId, "ok");
			return result;
		} catch (error) {
			onCommandOutcome?.(sessionId, "failed");
			throw error;
		}
	}

	const observe = registerTool({
		name: `${namespace}_observe`,
		category: "desktop",
		description:
			"Capture one observation of the paired Mac: an out-of-band screenshot reference plus the focused window and, optionally, the accessibility element tree. Returns a frame reference, never image bytes.",
		parameters: z.object({
			...sessionFields,
			request: ObserveRequestSchema.describe(
				"Which display to capture, whether to include the accessibility tree, and the longest-edge downscale"
			),
		}),
		async execute({ sessionId, approvalId, request }, ctx) {
			const result = await dispatch(
				sessionId,
				{ type: "observe", request },
				approvalId,
				ctx
			);
			if (result.type !== "observed") throw unexpected(sessionId, "observed", result.type);
			return summarizeFrame(sessionId, result.frame, maxElements);
		},
	});

	const listWindows = registerTool({
		name: `${namespace}_list_windows`,
		category: "desktop",
		description:
			"List the windows currently open on the paired Mac. Windows whose titles match the session guard's redaction patterns are withheld.",
		parameters: z.object(sessionFields),
		async execute({ sessionId, approvalId }, ctx) {
			const result = await dispatch(sessionId, { type: "listWindows" }, approvalId, ctx);
			if (result.type !== "windows") throw unexpected(sessionId, "windows", result.type);
			const guard = sessions.getSession(sessionId)?.lease.guard;
			const windows = guard
				? result.windows.filter((w) => !guardRedactsTitle(guard, w.title))
				: result.windows;
			return { count: windows.length, windows };
		},
	});

	const act = registerTool({
		name: `${namespace}_act`,
		category: "desktop",
		description:
			"Drive the paired Mac with one synthetic input action: move, click, drag, scroll, type, press a key, wait, or focus/launch an application. Prefer element targets over raw points — they survive layout changes.",
		requiresApproval: true,
		parameters: z.object({
			...sessionFields,
			action: InputActionSchema.describe("The single input action to perform"),
			beatLabel: z
				.string()
				.min(1)
				.optional()
				.describe(
					"Short description of what this action accomplishes, logged as a beat the storyboard can aim a shot at"
				),
		}),
		async execute({ sessionId, approvalId, action, beatLabel }, ctx): Promise<ActToolResult> {
			const result = await dispatch(
				sessionId,
				{ type: "act", action, beatLabel: beatLabel ?? null },
				approvalId,
				ctx
			);
			if (result.type !== "acted") throw unexpected(sessionId, "acted", result.type);
			return {
				sessionId,
				action: action.type,
				scope: scopeForAction(action),
				beat: result.beat ?? null,
			};
		},
	});

	const recordingStart = registerTool({
		name: `${namespace}_recording_start`,
		category: "desktop",
		description:
			"Start a Cap recording on the paired Mac. Use studio mode — instant recordings are not editable afterwards, so the storyboard cannot be applied to them.",
		requiresApproval: true,
		parameters: z.object({
			...sessionFields,
			request: StartRecordingRequestSchema.describe("Capture target, mode and audio/camera tracks"),
		}),
		async execute({ sessionId, approvalId, request }, ctx) {
			const result = await dispatch(
				sessionId,
				{ type: "recordingStart", request },
				approvalId,
				ctx
			);
			if (result.type !== "recordingStarted") {
				throw unexpected(sessionId, "recordingStarted", result.type);
			}
			return { ...result.handle };
		},
	});

	const recordingStop = registerTool({
		name: `${namespace}_recording_stop`,
		category: "desktop",
		description:
			"Stop the active recording and return the project path, the measured capture frame rate and the beat log of everything the agent did while recording.",
		parameters: z.object(sessionFields),
		async execute({ sessionId, approvalId }, ctx): Promise<RecordingStopResult> {
			const result = await dispatch(sessionId, { type: "recordingStop" }, approvalId, ctx);
			if (result.type !== "recordingStopped") {
				throw unexpected(sessionId, "recordingStopped", result.type);
			}
			const stopped = result.result;
			const geometry = captureGeometry(stopped);
			return {
				recordingId: stopped.recordingId,
				projectPath: stopped.projectPath,
				durationMs: stopped.durationMs,
				measuredFps: stopped.measuredFps,
				width: geometry.width,
				height: geometry.height,
				beatCount: stopped.beats.length,
				beats: stopped.beats,
			};
		},
	});

	const applyStoryboard = registerTool({
		name: `${namespace}_apply_storyboard`,
		category: "desktop",
		description:
			"Apply an editorial storyboard to a recorded Cap project. Rejected locally before it reaches the runner if it breaks the editorial limits: 12s total, no shot under the minimum, one motion system, and every cut aimed at a content beat.",
		parameters: z.object({
			...sessionFields,
			storyboard: StoryboardSchema.describe("The declarative storyboard to compile"),
		}),
		async execute({ sessionId, approvalId, storyboard }, ctx) {
			assertStoryboardValid(storyboard, { limits });
			const result = await dispatch(
				sessionId,
				{ type: "applyStoryboard", storyboard },
				approvalId,
				ctx
			);
			if (result.type !== "storyboardApplied") {
				throw unexpected(sessionId, "storyboardApplied", result.type);
			}
			return { projectPath: result.projectPath, shotCount: storyboard.shots.length };
		},
	});

	const exportVideo = registerTool({
		name: `${namespace}_export`,
		category: "desktop",
		description:
			"Render a Cap project to a video file. Omit fps to inherit the measured capture rate — forcing a rate the capture did not hit produces judder.",
		parameters: z.object({
			...sessionFields,
			request: ExportRequestSchema.describe("Project path, output path, resolution and optional fps"),
		}),
		async execute({ sessionId, approvalId, request }, ctx) {
			const result = await dispatch(sessionId, { type: "export", request }, approvalId, ctx);
			if (result.type !== "exported") throw unexpected(sessionId, "exported", result.type);
			return { ...result.result };
		},
	});

	const all = [
		observe,
		listWindows,
		act,
		recordingStart,
		recordingStop,
		applyStoryboard,
		exportVideo,
	] as unknown as ToolDefinition[];

	return {
		observe: observe as unknown as CapToolPack["observe"],
		listWindows: listWindows as unknown as CapToolPack["listWindows"],
		act: act as unknown as CapToolPack["act"],
		recordingStart: recordingStart as unknown as CapToolPack["recordingStart"],
		recordingStop: recordingStop as unknown as CapToolPack["recordingStop"],
		applyStoryboard: applyStoryboard as unknown as CapToolPack["applyStoryboard"],
		exportVideo: exportVideo as unknown as CapToolPack["exportVideo"],
		toolNames: all.map((t) => t.name),
		all,
	};
}
