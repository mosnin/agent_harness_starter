import type { CapScope, SessionEndReason } from "@/agents/tools/cap/types";

export type StudioSessionStatus = "idle" | "pending" | "active" | "paused" | "ended";

export interface StudioSession {
	sessionId: string;
	runId: string;
	status: StudioSessionStatus;
	grantedScopes: CapScope[];
	startedAtUnixMs: number;
	expiresAtUnixMs: number;
	killSwitchEngaged: boolean;
	endReason?: SessionEndReason | null;
}

export interface StudioObservation {
	frameId: string;
	/** Resolved at the edge from the protocol's `imageRef`; never inline base64. */
	imageUrl: string;
	width: number;
	height: number;
	capturedAtUnixMs: number;
	focusedWindowTitle: string | null;
	redactedWindows: string[];
}

export type StudioStepStatus = "pending" | "running" | "succeeded" | "failed";

export interface StudioStep {
	id: string;
	index: number;
	/** What the agent is trying to accomplish, in plain language. */
	label: string;
	actionType: string;
	scope: CapScope;
	status: StudioStepStatus;
	atUnixMs: number;
	detail?: string | null;
	beatLabel?: string | null;
}

export interface StudioApproval {
	approvalId: string;
	toolName: string;
	summary: string;
	scopes: CapScope[];
	requestedAtUnixMs: number;
	/** Serialized tool input, shown so the human can see exactly what was asked for. */
	details?: string | null;
}

export type StudioArtifactKind = "recording" | "project" | "storyboard" | "export";

export interface StudioArtifact {
	id: string;
	kind: StudioArtifactKind;
	label: string;
	path: string;
	durationMs?: number | null;
	fps?: number | null;
	bytes?: number | null;
}

export interface StudioState {
	session: StudioSession | null;
	observation: StudioObservation | null;
	steps: StudioStep[];
	approvals: StudioApproval[];
	artifacts: StudioArtifact[];
	/** Transport-level or protocol-level failure worth surfacing above the timeline. */
	error: string | null;
}

export const EMPTY_STUDIO_STATE: StudioState = {
	session: null,
	observation: null,
	steps: [],
	approvals: [],
	artifacts: [],
	error: null,
};
