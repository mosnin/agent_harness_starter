import type { CapScope } from "@/agents/tools/cap/types";
import type { StudioSession, StudioStep } from "./types";

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
