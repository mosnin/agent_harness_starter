import type { CapScope } from "@/agents/tools/cap/types";
import type { StudioDryRun, StudioFailure, StudioSession, StudioStep } from "./types";

const SCOPE_LABELS: Record<CapScope, string> = {
	observe_screen: "See your screen",
	control_pointer: "Move and click your pointer",
	control_keyboard: "Type on your keyboard",
	control_applications: "Open and focus applications",
	record: "Start and stop recordings",
	edit: "Edit the recording project",
	export: "Render a video file",
	upload: "Upload the video to Cap",
};

/** Plain-language name for a scope, for a consent surface a non-engineer reads. */
export function scopeLabel(scope: CapScope): string {
	return SCOPE_LABELS[scope] ?? scope;
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0
		? `${minutes}m ${String(seconds).padStart(2, "0")}s`
		: `${seconds}s`;
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "—";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

export function formatClock(unixMs: number): string {
	if (!Number.isFinite(unixMs)) return "—";
	return new Date(unixMs).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

export function leaseRemainingMs(session: StudioSession, nowUnixMs: number): number {
	return Math.max(0, session.expiresAtUnixMs - nowUnixMs);
}

/**
 * Whether the agent currently holds authority over the machine. The kill switch reads from this,
 * so it must be true only when a live lease exists and the switch has not been pulled.
 */
export function isSessionLive(session: StudioSession | null, nowUnixMs: number): boolean {
	if (!session) return false;
	if (session.killSwitchEngaged) return false;
	if (session.status !== "active") return false;
	return nowUnixMs < session.expiresAtUnixMs;
}

/** The one step a human needs to read to know what the agent is doing right now. */
export function currentStep(steps: StudioStep[]): StudioStep | null {
	for (let i = steps.length - 1; i >= 0; i--) {
		if (steps[i].status === "running") return steps[i];
	}
	return steps.at(-1) ?? null;
}

export function describeStep(step: StudioStep): string {
	const suffix = step.beatLabel ? ` — ${step.beatLabel}` : "";
	return `${step.label}${suffix}`;
}

const STATUS_TEXT: Record<StudioSession["status"], string> = {
	idle: "No session",
	pending: "Waiting for your consent",
	active: "Agent is driving your Mac",
	paused: "Paused",
	ended: "Session ended",
};

export function sessionStatusText(session: StudioSession | null): string {
	if (!session) return STATUS_TEXT.idle;
	if (session.killSwitchEngaged) return "Stopped by kill switch";
	return STATUS_TEXT[session.status];
}

/**
 * Plain-language name for a Director Protocol error code. Codes reach the Studio in three
 * spellings — the protocol's own `target_ambiguous`, the tool layer's `DESKTOP_TARGET_AMBIGUOUS`
 * and the stream's `RUNNER_SESSION_EXPIRED` — so all three normalise to the same entry.
 */
const FAILURE_CODE_LABELS: Record<string, string> = {
	target_ambiguous: "More than one thing on screen matched",
	target_not_found: "Nothing on screen matched",
	permission_missing: "macOS has not granted a permission the agent needs",
	application_not_allowed: "That application is outside the ones you allowed",
	scope_denied: "The agent asked for an authority you did not grant",
	guard_violation: "A guard rule you set blocked the step",
	approval_denied: "You denied this step",
	approval_required: "The step needs your approval first",
	session_expired: "The session lease ran out",
	no_active_session: "There is no live session on this Mac",
	session_already_active: "Another session already holds this Mac",
	user_kill_switch: "You stopped the agent",
	token_expired: "The session's capability token expired",
	unauthenticated: "The runner is not paired",
	recording_already_active: "A recording was already running",
	no_recording_active: "No recording was running",
	storyboard_invalid: "The storyboard was rejected",
	export_failed: "Rendering the video failed",
	protocol_version_mismatch: "The runner speaks a different protocol version",
	internal: "The runner hit an internal error",
};

export function normalizeFailureCode(code: string | null | undefined): string | null {
	if (!code) return null;
	return code.toLowerCase().replace(/^(?:desktop|runner|cap)_/, "");
}

export function failureCodeLabel(code: string | null | undefined): string | null {
	const normalized = normalizeFailureCode(code);
	return normalized ? (FAILURE_CODE_LABELS[normalized] ?? null) : null;
}

const FALLBACK_REMEDIATION: Record<string, string> = {
	target_ambiguous:
		"Narrow the description — give the agent a title or identifier that matches one element.",
	target_not_found:
		"Check the screen capture below: if what the agent wanted is not there, your app is in a different state than the plan assumed.",
	permission_missing:
		"Open System Settings → Privacy & Security and grant the permission, then start a new session.",
	application_not_allowed: "Add the application to the allowed list, or let the agent skip it.",
	scope_denied: "Grant the scope when you start the next session, or narrow what you asked for.",
	session_expired: "Start a new session — leases are short on purpose.",
};

/**
 * What the user can actually do. The protocol's own `remediation` wins; the fallback exists so a
 * failure is never a dead end even when the control plane sends none.
 */
export function failureRemediation(failure: StudioFailure): string | null {
	if (failure.remediation) return failure.remediation;
	const normalized = normalizeFailureCode(failure.code);
	return normalized ? (FALLBACK_REMEDIATION[normalized] ?? null) : null;
}

/** "Step 7" — the place in the plan the run stopped, one-based the way the timeline shows it. */
export function failureStepLabel(failure: StudioFailure): string | null {
	if (failure.stepIndex == null) return null;
	const position = `Step ${failure.stepIndex + 1}`;
	return failure.stepLabel ? `${position} · ${failure.stepLabel}` : position;
}

export function dryRunDurationMs(dryRun: StudioDryRun): number | null {
	if (dryRun.estimatedDurationMs != null) return dryRun.estimatedDurationMs;
	const summed = dryRun.steps.reduce((total, step) => total + (step.estimatedMs ?? 0), 0);
	return summed > 0 ? summed : null;
}

/** Scopes the plan needs that the live session does not already hold. */
export function dryRunMissingScopes(
	dryRun: StudioDryRun,
	session: StudioSession | null
): CapScope[] {
	const held = new Set(session?.grantedScopes ?? []);
	return dryRun.scopes.filter((scope) => !held.has(scope));
}
