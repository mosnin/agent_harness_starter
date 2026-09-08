/**
 * Director Protocol v1 — TypeScript mirror of `cap-hades/crates/hades-protocol`.
 *
 * Wire subtleties that are easy to get wrong (verified against the Rust source):
 *   - `#[serde(rename_all = "camelCase")]` on an *enum* renames the VARIANTS, not the fields
 *     of its struct variants — those need the attribute repeated on each variant. Every
 *     struct variant in the crate now carries it, so EVERY object key on the wire is
 *     camelCase; the crate has a test that walks serialized output and rejects any key
 *     containing an underscore. A snake_case key here would be a bug.
 *   - `Envelope` is tagged with `kind`; every other tagged union uses `type`.
 *   - Plain unit enums (Scope, ErrorCode, …) still have snake_case *values* — those are
 *     variant names, not keys, and `rename_all = "snake_case"` is set on them deliberately.
 */

import { z } from "zod";

/** Wire-compatibility version. A runner refuses a control plane advertising a different major. */
export const PROTOCOL_VERSION = "1.0.0";
export const PROTOCOL_MAJOR = 1;

/** Returns the major component of a semver-ish protocol string, or null if unparseable. */
export function protocolMajor(version: string): number | null {
	const match = /^(\d+)\./.exec(version);
	if (!match) return null;
	const major = Number.parseInt(match[1], 10);
	return Number.isNaN(major) ? null : major;
}

export function isCompatibleProtocol(version: string): boolean {
	return protocolMajor(version) === PROTOCOL_MAJOR;
}

const u64 = z.number().int().min(0);
const u32 = z.number().int().min(0);
const f64 = z.number();

// ── scope.rs ─────────────────────────────────────────────────────────────────

export const ScopeSchema = z.enum([
	"observe_screen",
	"control_pointer",
	"control_keyboard",
	"control_applications",
	"record",
	"edit",
	"export",
	"upload",
]);
export type Scope = z.infer<typeof ScopeSchema>;

export const INTRUSIVE_SCOPES: readonly Scope[] = [
	"control_pointer",
	"control_keyboard",
	"control_applications",
	"upload",
];

export function isIntrusiveScope(scope: Scope): boolean {
	return INTRUSIVE_SCOPES.includes(scope);
}

export const ScopeSetSchema = z.object({
	scopes: z.array(ScopeSchema),
});
export type ScopeSet = z.infer<typeof ScopeSetSchema>;

/** Mirrors `ScopeSet::new` — sorted and deduped so wire comparison is stable. */
export function scopeSet(scopes: Iterable<Scope>): ScopeSet {
	return { scopes: [...new Set(scopes)].sort() };
}

export function scopeSetContains(set: ScopeSet, scope: Scope): boolean {
	return set.scopes.includes(scope);
}

// ── session.rs ───────────────────────────────────────────────────────────────

export const SessionGuardSchema = z.object({
	allowedBundleIds: z.array(z.string()),
	redactedTitlePatterns: z.array(z.string()),
	idleTimeoutMs: u64,
	maxDurationMs: u64,
	requireStepApproval: z.boolean(),
});
export type SessionGuard = z.infer<typeof SessionGuardSchema>;

/** Mirrors `SessionGuard::deny_all` — a misconfigured caller must fail closed. */
export function denyAllGuard(): SessionGuard {
	return {
		allowedBundleIds: [],
		redactedTitlePatterns: [],
		idleTimeoutMs: 60_000,
		maxDurationMs: 15 * 60_000,
		requireStepApproval: true,
	};
}

export const SessionLeaseSchema = z.object({
	sessionId: z.string(),
	runId: z.string(),
	grantedScopes: ScopeSetSchema,
	guard: SessionGuardSchema,
	startedAtUnixMs: u64,
	expiresAtUnixMs: u64,
});
export type SessionLease = z.infer<typeof SessionLeaseSchema>;

export const SessionStateSchema = z.enum(["pending", "active", "paused", "ended"]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const SessionEndReasonSchema = z.enum([
	"completed",
	"control_plane_cancelled",
	"user_kill_switch",
	"idle_timeout",
	"max_duration_reached",
	"guard_violation",
	"runner_shutdown",
	"transport_lost",
]);
export type SessionEndReason = z.infer<typeof SessionEndReasonSchema>;

// ── input.rs ─────────────────────────────────────────────────────────────────

export const PointSpaceSchema = z.enum([
	"normalized_display",
	"normalized_window",
	"display_pixels",
]);
export type PointSpace = z.infer<typeof PointSpaceSchema>;

export const PointSchema = z.object({
	x: f64,
	y: f64,
	space: PointSpaceSchema,
});
export type Point = z.infer<typeof PointSchema>;

export const MouseButtonSchema = z.enum(["left", "right", "middle"]);
export type MouseButton = z.infer<typeof MouseButtonSchema>;

export const KeyModifierSchema = z.enum([
	"command",
	"shift",
	"option",
	"control",
	"function",
]);
export type KeyModifier = z.infer<typeof KeyModifierSchema>;

export const TargetSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("point"), point: PointSchema }),
	z.object({ type: z.literal("element"), elementId: z.string() }),
	z.object({
		type: z.literal("elementQuery"),
		role: z.string().nullish(),
		title: z.string().nullish(),
		identifier: z.string().nullish(),
		nth: u32.nullish(),
	}),
]);
export type Target = z.infer<typeof TargetSchema>;

export const InputActionSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("moveTo"), target: TargetSchema, durationMs: u64 }),
	z.object({
		type: z.literal("click"),
		target: TargetSchema,
		button: MouseButtonSchema,
		clickCount: u32,
	}),
	z.object({
		type: z.literal("drag"),
		from: TargetSchema,
		to: TargetSchema,
		button: MouseButtonSchema,
		durationMs: u64,
	}),
	z.object({
		type: z.literal("scroll"),
		target: TargetSchema,
		deltaX: f64,
		deltaY: f64,
		durationMs: u64,
	}),
	z.object({ type: z.literal("typeText"), text: z.string(), charsPerMinute: u32 }),
	z.object({
		type: z.literal("keyPress"),
		key: z.string(),
		modifiers: z.array(KeyModifierSchema),
	}),
	z.object({ type: z.literal("wait"), durationMs: u64 }),
	z.object({ type: z.literal("focusApplication"), bundleId: z.string() }),
	z.object({
		type: z.literal("launchApplication"),
		bundleId: z.string(),
		waitForWindowMs: u64,
	}),
]);
export type InputAction = z.infer<typeof InputActionSchema>;

/** Mirrors `InputAction::required_scope` — least privilege per action. */
export function requiredScopeForAction(action: InputAction): Scope {
	switch (action.type) {
		case "moveTo":
		case "click":
		case "drag":
		case "scroll":
			return "control_pointer";
		case "typeText":
		case "keyPress":
			return "control_keyboard";
		case "focusApplication":
		case "launchApplication":
			return "control_applications";
		case "wait":
			return "observe_screen";
	}
}

// ── observe.rs ───────────────────────────────────────────────────────────────

export const RectSchema = z.object({
	x: f64,
	y: f64,
	width: f64,
	height: f64,
});
export type Rect = z.infer<typeof RectSchema>;

export const DisplayInfoSchema = z.object({
	displayId: z.string(),
	width: u32,
	height: u32,
	scaleFactor: f64,
	isPrimary: z.boolean(),
});
export type DisplayInfo = z.infer<typeof DisplayInfoSchema>;

export const WindowInfoSchema = z.object({
	windowId: z.string(),
	bundleId: z.string(),
	title: z.string(),
	bounds: RectSchema,
});
export type WindowInfo = z.infer<typeof WindowInfoSchema>;

export const UiElementSchema = z.object({
	elementId: z.string(),
	role: z.string(),
	title: z.string().nullish(),
	value: z.string().nullish(),
	identifier: z.string().nullish(),
	bounds: RectSchema,
	enabled: z.boolean(),
	focused: z.boolean(),
	children: z.array(z.string()),
});
export type UiElement = z.infer<typeof UiElementSchema>;

export const ObservationFrameSchema = z.object({
	frameId: z.string(),
	imageRef: z.string(),
	width: u32,
	height: u32,
	capturedAtUnixMs: u64,
	display: DisplayInfoSchema,
	focusedWindow: WindowInfoSchema.nullish(),
	elements: z.array(UiElementSchema),
	redactedWindows: z.array(z.string()),
});
export type ObservationFrame = z.infer<typeof ObservationFrameSchema>;

export const ObserveRequestSchema = z.object({
	displayId: z.string().nullish(),
	includeElements: z.boolean(),
	maxDimension: u32.nullish(),
});
export type ObserveRequest = z.infer<typeof ObserveRequestSchema>;

// ── record.rs ────────────────────────────────────────────────────────────────

export const CaptureTargetSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("display"), displayId: z.string() }),
	z.object({ type: z.literal("window"), windowId: z.string() }),
	z.object({ type: z.literal("area"), displayId: z.string(), bounds: RectSchema }),
]);
export type CaptureTarget = z.infer<typeof CaptureTargetSchema>;

export const RecordingModeSchema = z.enum(["studio", "instant"]);
export type RecordingMode = z.infer<typeof RecordingModeSchema>;

export const StartRecordingRequestSchema = z.object({
	target: CaptureTargetSchema,
	mode: RecordingModeSchema,
	captureSystemAudio: z.boolean(),
	captureMicrophone: z.boolean(),
	captureCamera: z.boolean(),
	fps: u32.nullish(),
});
export type StartRecordingRequest = z.infer<typeof StartRecordingRequestSchema>;

export const RecordingHandleSchema = z.object({
	recordingId: z.string(),
	projectPath: z.string(),
	startedAtUnixMs: u64,
});
export type RecordingHandle = z.infer<typeof RecordingHandleSchema>;

export const BeatKindSchema = z.enum([
	"action",
	"reveal",
	"typing",
	"transition",
	"idle",
]);
export type BeatKind = z.infer<typeof BeatKindSchema>;

export const BeatSchema = z.object({
	beatId: z.string(),
	offsetMs: u64,
	kind: BeatKindSchema,
	label: z.string(),
	landmark: RectSchema.nullish(),
});
export type Beat = z.infer<typeof BeatSchema>;

export const StopRecordingResultSchema = z.object({
	recordingId: z.string(),
	projectPath: z.string(),
	durationMs: u64,
	measuredFps: f64,
	beats: z.array(BeatSchema),
});
export type StopRecordingResult = z.infer<typeof StopRecordingResultSchema>;

// ── edit.rs ──────────────────────────────────────────────────────────────────

export const TransitionSchema = z.enum(["cut", "dolly", "none"]);
export type Transition = z.infer<typeof TransitionSchema>;

export const CameraPoseSchema = z.object({
	zoom: f64,
	tiltX: f64,
	tiltY: f64,
	rotateX: f64,
	// Defaulted on the Rust side, so a storyboard omitting them still deserializes; pinning them
	// to 0/0/45 makes the reference poses unreproducible.
	roll: f64.default(0),
	rotateY: f64.default(0),
	fov: f64.default(45),
	focusX: f64,
	focusY: f64,
	focusSize: f64,
});
export type CameraPose = z.infer<typeof CameraPoseSchema>;

export const ShotSchema = z.object({
	shotId: z.string(),
	sourceStartMs: u64,
	sourceEndMs: u64,
	camera: CameraPoseSchema,
	aimBeatId: z.string().nullish(),
	transitionIn: TransitionSchema,
});
export type Shot = z.infer<typeof ShotSchema>;

export const BackgroundSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("gradient"), fromHex: z.string(), toHex: z.string() }),
	z.object({ type: z.literal("solid"), hex: z.string() }),
	z.object({ type: z.literal("wallpaper"), name: z.string() }),
]);
export type Background = z.infer<typeof BackgroundSchema>;

export const CursorStyleSchema = z.object({
	synthesize: z.boolean(),
	size: f64,
	smoothing: f64,
});
export type CursorStyle = z.infer<typeof CursorStyleSchema>;

export const CaptionStyleSchema = z.object({
	enabled: z.boolean(),
	fontSize: f64,
});
export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;

export const StoryboardSchema = z.object({
	version: u32,
	projectPath: z.string(),
	sourceFps: f64,
	shots: z.array(ShotSchema),
	background: BackgroundSchema,
	cursor: CursorStyleSchema,
	music: z.string().nullish(),
	captions: CaptionStyleSchema.nullish(),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

export const EditorialLimitsSchema = z.object({
	maxTotalMs: u64,
	minShotMs: u64,
	maxShots: u32,
});
export type EditorialLimits = z.infer<typeof EditorialLimitsSchema>;

export const DEFAULT_EDITORIAL_LIMITS: EditorialLimits = {
	maxTotalMs: 12_000,
	minShotMs: 1_200,
	maxShots: 6,
};

export const ExportResolutionSchema = z.enum(["source", "hd", "four_k"]);
export type ExportResolution = z.infer<typeof ExportResolutionSchema>;

export const ExportRequestSchema = z.object({
	projectPath: z.string(),
	outputPath: z.string(),
	fps: u32.nullish(),
	resolution: ExportResolutionSchema,
});
export type ExportRequest = z.infer<typeof ExportRequestSchema>;

export const ExportResultSchema = z.object({
	outputPath: z.string(),
	durationMs: u64,
	fps: f64,
	bytes: u64,
});
export type ExportResult = z.infer<typeof ExportResultSchema>;

// ── error.rs ─────────────────────────────────────────────────────────────────

export const ErrorCodeSchema = z.enum([
	"protocol_version_mismatch",
	"unauthenticated",
	"token_expired",
	"scope_denied",
	"no_active_session",
	"session_already_active",
	"session_expired",
	"user_kill_switch",
	"guard_violation",
	"approval_required",
	"approval_denied",
	"permission_missing",
	"target_not_found",
	"target_ambiguous",
	"application_not_allowed",
	"recording_already_active",
	"no_recording_active",
	"storyboard_invalid",
	"export_failed",
	"internal",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ProtocolErrorSchema = z.object({
	code: ErrorCodeSchema,
	message: z.string(),
	remediation: z.string().nullish(),
});
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

export function protocolError(
	code: ErrorCode,
	message: string,
	remediation?: string,
): ProtocolError {
	return remediation === undefined
		? { code, message }
		: { code, message, remediation };
}

// ── envelope.rs ──────────────────────────────────────────────────────────────

export const PermissionStatusSchema = z.object({
	screenRecording: z.boolean(),
	accessibility: z.boolean(),
	microphone: z.boolean(),
	camera: z.boolean(),
});
export type PermissionStatus = z.infer<typeof PermissionStatusSchema>;

export const RunnerInfoSchema = z.object({
	runnerId: z.string(),
	protocolVersion: z.string(),
	capVersion: z.string(),
	os: z.string(),
	osVersion: z.string(),
	arch: z.string(),
	permissions: PermissionStatusSchema,
});
export type RunnerInfo = z.infer<typeof RunnerInfoSchema>;

export const CommandSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("handshake"), protocolVersion: z.string() }),
	z.object({
		type: z.literal("sessionStart"),
		runId: z.string(),
		requestedScopes: ScopeSetSchema,
		guard: SessionGuardSchema,
	}),
	z.object({ type: z.literal("sessionEnd"), reason: SessionEndReasonSchema }),
	z.object({ type: z.literal("observe"), request: ObserveRequestSchema }),
	z.object({ type: z.literal("listWindows") }),
	z.object({
		type: z.literal("act"),
		action: InputActionSchema,
		beatLabel: z.string().nullish(),
	}),
	z.object({ type: z.literal("recordingStart"), request: StartRecordingRequestSchema }),
	z.object({ type: z.literal("recordingStop") }),
	z.object({ type: z.literal("applyStoryboard"), storyboard: StoryboardSchema }),
	z.object({ type: z.literal("export"), request: ExportRequestSchema }),
]);
export type Command = z.infer<typeof CommandSchema>;

/** Mirrors `Command::required_scopes`. Both the lease and the capability token must grant all of these. */
export function requiredScopesForCommand(command: Command): Scope[] {
	switch (command.type) {
		case "handshake":
		case "sessionStart":
		case "sessionEnd":
			return [];
		case "observe":
		case "listWindows":
			return ["observe_screen"];
		case "act":
			return [requiredScopeForAction(command.action)];
		case "recordingStart":
		case "recordingStop":
			return ["record"];
		case "applyStoryboard":
			return ["edit"];
		case "export":
			return ["export"];
	}
}

/** Mirrors `Command::requires_active_session`. */
export function commandRequiresActiveSession(command: Command): boolean {
	return (
		command.type !== "handshake" &&
		command.type !== "sessionStart" &&
		command.type !== "sessionEnd"
	);
}

export const CommandResultSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("handshake"), runner: RunnerInfoSchema }),
	z.object({ type: z.literal("sessionStarted"), lease: SessionLeaseSchema }),
	z.object({ type: z.literal("sessionEnded"), reason: SessionEndReasonSchema }),
	z.object({ type: z.literal("observed"), frame: ObservationFrameSchema }),
	z.object({ type: z.literal("windows"), windows: z.array(WindowInfoSchema) }),
	z.object({ type: z.literal("acted"), beat: BeatSchema.nullish() }),
	z.object({ type: z.literal("recordingStarted"), handle: RecordingHandleSchema }),
	z.object({ type: z.literal("recordingStopped"), result: StopRecordingResultSchema }),
	z.object({ type: z.literal("storyboardApplied"), projectPath: z.string() }),
	z.object({ type: z.literal("exported"), result: ExportResultSchema }),
]);
export type CommandResult = z.infer<typeof CommandResultSchema>;

export const RunnerEventSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("progress"),
		sessionId: z.string(),
		stage: z.string(),
		fraction: z.number().min(0).max(1).nullish(),
		detail: z.string().nullish(),
	}),
	z.object({ type: z.literal("beatLogged"), sessionId: z.string(), beat: BeatSchema }),
	z.object({
		type: z.literal("sessionEnded"),
		sessionId: z.string(),
		reason: SessionEndReasonSchema,
	}),
	z.object({ type: z.literal("killSwitchEngaged"), sessionId: z.string() }),
	z.object({
		type: z.literal("approvalRequested"),
		sessionId: z.string(),
		approvalId: z.string(),
		summary: z.string(),
	}),
	z.object({ type: z.literal("heartbeat"), unixMs: u64 }),
]);
export type RunnerEvent = z.infer<typeof RunnerEventSchema>;

export const EnvelopeSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("command"),
		id: z.string(),
		token: z.string(),
		command: CommandSchema,
	}),
	z.object({ kind: z.literal("reply"), id: z.string(), result: CommandResultSchema }),
	z.object({ kind: z.literal("failure"), id: z.string(), error: ProtocolErrorSchema }),
	z.object({ kind: z.literal("event"), event: RunnerEventSchema }),
]);
export type Envelope = z.infer<typeof EnvelopeSchema>;

export type CommandEnvelope = Extract<Envelope, { kind: "command" }>;
export type ReplyEnvelope = Extract<Envelope, { kind: "reply" }>;
export type FailureEnvelope = Extract<Envelope, { kind: "failure" }>;
export type EventEnvelope = Extract<Envelope, { kind: "event" }>;

/**
 * Inbound runner frames are untrusted: every one is validated here rather than cast.
 * A parse failure is a protocol error, never a silent coercion.
 */
export function safeParseEnvelope(
	raw: unknown,
): { ok: true; envelope: Envelope } | { ok: false; error: ProtocolError } {
	const parsed = EnvelopeSchema.safeParse(raw);
	if (parsed.success) return { ok: true, envelope: parsed.data };
	const issue = parsed.error.issues[0];
	const path = issue?.path.join(".") ?? "";
	return {
		ok: false,
		error: protocolError(
			"internal",
			`Malformed envelope${path ? ` at "${path}"` : ""}: ${issue?.message ?? "unknown"}`,
			"The runner sent a frame that does not match Director Protocol v1.",
		),
	};
}

/** Parses a raw WebSocket text frame. Returns a ProtocolError for both bad JSON and bad shape. */
export function parseEnvelopeFrame(
	frame: string,
): { ok: true; envelope: Envelope } | { ok: false; error: ProtocolError } {
	let json: unknown;
	try {
		json = JSON.parse(frame);
	} catch {
		return {
			ok: false,
			error: protocolError("internal", "Frame is not valid JSON."),
		};
	}
	return safeParseEnvelope(json);
}

/** JSON Schema for the envelope — useful for publishing the contract to non-TS consumers. */
export function envelopeJsonSchema(): Record<string, unknown> {
	return z.toJSONSchema(EnvelopeSchema, { io: "input" }) as Record<string, unknown>;
}
