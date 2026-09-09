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

/**
 * Everything a human needs to answer one question after the agent gives up: is my app broken, or
 * is the agent? "Failed" alone cannot answer it, so each field here is the evidence the agent
 * already had at the moment it stopped.
 */
export interface StudioFailure {
	/** What went wrong, in the words the control plane used. */
	message: string;
	/** Director Protocol `ErrorCode` (e.g. `target_ambiguous`) or the harness code. */
	code?: string | null;
	/** The protocol's own `remediation` — what to change so the next attempt works. */
	remediation?: string | null;
	/** The step that was in flight, so the failure is anchored to a place in the plan. */
	stepId?: string | null;
	stepIndex?: number | null;
	stepLabel?: string | null;
	toolName?: string | null;
	/** The element the agent was reaching for, in plain language. */
	target?: string | null;
	/** How many on-screen elements matched that description. >1 is the ambiguity itself. */
	candidateCount?: number | null;
	/** Short descriptions of the elements it was choosing between, when the runner sent them. */
	candidates?: string[];
	/** The frame the agent was looking at when it stopped — the screen it actually saw. */
	observationFrameId?: string | null;
	observationImageUrl?: string | null;
	observationCapturedAtUnixMs?: number | null;
	atUnixMs: number;
}

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
	/** What the agent was reaching for on this step, kept so a later failure can name it. */
	target?: string | null;
	failure?: StudioFailure | null;
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

/** One application the plan will touch, named the way the user names it — not by bundle id. */
export interface StudioDryRunApplication {
	bundleId: string;
	name: string;
	/** False when the session guard's `allowedBundleIds` does not cover it. */
	allowed?: boolean;
}

export interface StudioDryRunStep {
	id: string;
	/** Plain language: "Open Safari", "Click Continue". */
	label: string;
	actionType?: string | null;
	scope: CapScope;
	application?: string | null;
	estimatedMs?: number | null;
	/** True when this step will stop and ask before it runs. */
	requiresApproval?: boolean;
}

/**
 * The plan, shown before anything moves the cursor. Purely data: the Studio does not compute a
 * plan and does not issue a protocol command for one — the control plane supplies this and the
 * Studio renders it, so consent happens before the first action rather than after it.
 */
export interface StudioDryRun {
	/** One sentence naming what the agent intends to do. */
	summary: string;
	steps: StudioDryRunStep[];
	applications: StudioDryRunApplication[];
	/** Every scope the plan needs, whether or not the session already holds it. */
	scopes: CapScope[];
	estimatedDurationMs?: number | null;
	generatedAtUnixMs?: number | null;
	/** Set while the plan is being fetched, so the surface can say so rather than look empty. */
	loading?: boolean;
}

export interface StudioState {
	session: StudioSession | null;
	observation: StudioObservation | null;
	steps: StudioStep[];
	approvals: StudioApproval[];
	artifacts: StudioArtifact[];
	/** Transport-level or protocol-level failure worth surfacing above the timeline. */
	error: string | null;
	/** The structured form of `error`, when the failure came from a step. */
	failure: StudioFailure | null;
}

export const EMPTY_STUDIO_STATE: StudioState = {
	session: null,
	observation: null,
	steps: [],
	approvals: [],
	artifacts: [],
	error: null,
	failure: null,
};
