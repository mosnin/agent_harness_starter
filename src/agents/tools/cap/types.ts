/**
 * Cap tool-pack view of the Director Protocol.
 *
 * The wire schemas live in Team E's `src/agents/runner/protocol.ts`; this module re-exports what
 * the tool pack uses and adds only what is specific to driving the runner from a tool: the
 * command subset the pack exposes, and the guard predicates the tools evaluate locally.
 */

import { z } from "zod";
import {
	type Command,
	type CommandResult,
	type InputAction,
	type ObservationFrame,
	RectSchema,
	type SessionGuard,
	type Shot,
	type StopRecordingResult,
	requiredScopeForAction,
	requiredScopesForCommand as protocolRequiredScopes,
} from "../../runner/protocol";

export {
	BeatKindSchema,
	BeatSchema,
	CaptureTargetSchema,
	DEFAULT_EDITORIAL_LIMITS,
	ErrorCodeSchema,
	ExportRequestSchema,
	ExportResolutionSchema,
	InputActionSchema,
	KeyModifierSchema,
	MouseButtonSchema,
	ObservationFrameSchema,
	ObserveRequestSchema,
	PROTOCOL_VERSION as CAP_PROTOCOL_VERSION,
	PointSchema,
	PointSpaceSchema,
	ProtocolErrorSchema,
	RectSchema,
	RecordingHandleSchema,
	RecordingModeSchema,
	ScopeSchema as CapScopeSchema,
	ScopeSetSchema,
	SessionEndReasonSchema,
	SessionGuardSchema,
	SessionLeaseSchema,
	ShotSchema,
	StartRecordingRequestSchema,
	StopRecordingResultSchema,
	StoryboardSchema,
	TargetSchema,
	TransitionSchema,
	UiElementSchema,
	WindowInfoSchema,
	denyAllGuard,
	isIntrusiveScope,
} from "../../runner/protocol";

export type {
	Background,
	Beat,
	BeatKind,
	CameraPose,
	CaptionStyle,
	CaptureTarget,
	CursorStyle,
	EditorialLimits,
	ExportRequest,
	ExportResult,
	InputAction,
	ObservationFrame,
	ObserveRequest,
	Rect,
	RecordingHandle,
	ErrorCode as CapErrorCode,
	ProtocolError as ProtocolErrorPayload,
	Scope as CapScope,
	ScopeSet,
	SessionEndReason,
	SessionGuard,
	SessionLease,
	Shot,
	StartRecordingRequest,
	StopRecordingResult,
	Storyboard,
	Target,
	Transition,
	UiElement,
	WindowInfo,
} from "../../runner/protocol";

/** The commands this tool pack exposes: the work commands, never session lifecycle. */
export type DirectorCommand = Extract<
	Command,
	{
		type:
			| "observe"
			| "listWindows"
			| "act"
			| "recordingStart"
			| "recordingStop"
			| "applyStoryboard"
			| "export";
	}
>;

export type DirectorCommandResult = Extract<
	CommandResult,
	{
		type:
			| "observed"
			| "windows"
			| "acted"
			| "recordingStarted"
			| "recordingStopped"
			| "storyboardApplied"
			| "exported";
	}
>;

export const scopeForAction = requiredScopeForAction;

export function requiredScopesForCommand(command: DirectorCommand) {
	return protocolRequiredScopes(command);
}

/** The bundle identifier an action targets, when it targets one. */
export function bundleIdForAction(action: InputAction): string | undefined {
	return action.type === "focusApplication" || action.type === "launchApplication"
		? action.bundleId
		: undefined;
}

export function guardAllowsBundle(guard: SessionGuard, bundleId: string): boolean {
	return guard.allowedBundleIds.includes(bundleId);
}

/** Mirrors `SessionGuard::is_redacted_title` — case-insensitive substring match. */
export function guardRedactsTitle(guard: SessionGuard, title: string): boolean {
	const lowered = title.toLowerCase();
	return guard.redactedTitlePatterns.some((p) => lowered.includes(p.toLowerCase()));
}

// ── Director Protocol v1.2 additions ─────────────────────────────────────────
//
// `src/agents/runner/protocol.ts` still mirrors v1.0.0 and is owned by another team, so the v1.2
// fields the replay pipeline reads are decoded here instead. Each schema mirrors the Rust
// `#[serde(default)]` on the corresponding field, so a v1.0 payload parses and yields the same
// default the crate would.

const u32 = z.number().int().min(0);
const u64 = z.number().int().min(0);

/** `ObservationFrame::masked_regions` — pixels blacked out before encoding. */
export const ObservationExtensionsSchema = z.object({
	maskedRegions: z.array(RectSchema).default([]),
});
export type ObservationExtensions = z.infer<typeof ObservationExtensionsSchema>;

export function observationExtensions(frame: ObservationFrame): ObservationExtensions {
	return ObservationExtensionsSchema.parse(frame);
}

/** `StopRecordingResult::width` / `height` — capture geometry in physical pixels. */
export const CaptureGeometrySchema = z.object({
	width: u32.default(0),
	height: u32.default(0),
});
export type CaptureGeometry = z.infer<typeof CaptureGeometrySchema>;

export function captureGeometry(result: StopRecordingResult): CaptureGeometry {
	return CaptureGeometrySchema.parse(result);
}

/** `Shot::recording_segment` / `transition_duration_ms`. */
export const ShotExtensionsSchema = z.object({
	recordingSegment: u32.default(0),
	transitionDurationMs: u64.default(0),
});
export type ShotExtensions = z.infer<typeof ShotExtensionsSchema>;

export function shotExtensions(shot: Shot): ShotExtensions {
	return ShotExtensionsSchema.parse(shot);
}
