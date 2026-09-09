/**
 * Tool-level authorization for desktop control.
 *
 * `src/agents/orchestrator.ts` builds agents with `resolveAgentTools` + `toOpenAITool` and never
 * calls `wrapTools`, so security, governance and approval plugins do not run for orchestrated
 * agents. Every cap tool therefore calls `authorizeDesktopCommand` inside its own `execute`, which
 * runs on every path — plugin-wrapped or not.
 */

import { SecurityError } from "../../errors/index";
import type { DesktopSessionReader } from "./client";
import {
	bundleIdForAction,
	isIntrusiveScope,
	requiredScopesForCommand,
	guardAllowsBundle,
} from "./types";
import type { CapErrorCode, CapScope, DirectorCommand, SessionLease } from "./types";

export class DesktopAuthorizationError extends SecurityError {
	/** Director Protocol `ErrorCode` this denial maps to. */
	readonly capCode: CapErrorCode;
	readonly sessionId: string;

	constructor(
		capCode: CapErrorCode,
		message: string,
		sessionId: string,
		remediation?: string
	) {
		super(message, `DESKTOP_${capCode.toUpperCase()}`, remediation);
		this.name = "DesktopAuthorizationError";
		this.capCode = capCode;
		this.sessionId = sessionId;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export interface DesktopAuthorizationInput {
	sessionId: string;
	command: DirectorCommand;
	/** Identifier of the approval the human granted for this step, when one was required. */
	approvalId?: string;
	nowUnixMs?: number;
}

export interface DesktopAuthorizationGrant {
	lease: SessionLease;
	requiredScopes: CapScope[];
	intrusive: boolean;
}

export function authorizeDesktopCommand(
	sessions: DesktopSessionReader,
	input: DesktopAuthorizationInput
): DesktopAuthorizationGrant {
	const { sessionId, command } = input;
	const nowUnixMs = input.nowUnixMs ?? Date.now();
	const session = sessions.getSession(sessionId);

	if (!session) {
		throw new DesktopAuthorizationError(
			"no_active_session",
			`No session lease for "${sessionId}". A human must grant a lease before the agent can touch the machine.`,
			sessionId,
			"Start a paired session from the Studio consent screen."
		);
	}

	if (session.killSwitchEngaged) {
		throw new DesktopAuthorizationError(
			"no_active_session",
			`Session "${sessionId}" was stopped by the kill switch.`,
			sessionId,
			"Grant a new lease to resume; the previous one cannot be revived."
		);
	}

	if (session.status !== "active") {
		throw new DesktopAuthorizationError(
			"no_active_session",
			`Session "${sessionId}" is ${session.status}, not active.`,
			sessionId
		);
	}

	const { lease } = session;

	if (nowUnixMs >= lease.expiresAtUnixMs) {
		throw new DesktopAuthorizationError(
			"session_expired",
			`Session lease "${sessionId}" expired at ${lease.expiresAtUnixMs}.`,
			sessionId,
			"Ask the user to re-grant the lease."
		);
	}

	const requiredScopes = requiredScopesForCommand(command);
	const granted = new Set<CapScope>(lease.grantedScopes.scopes);
	const missing = requiredScopes.filter((scope) => !granted.has(scope));

	if (missing.length > 0) {
		throw new DesktopAuthorizationError(
			"scope_denied",
			`Session "${sessionId}" is missing scope(s): ${missing.join(", ")}.`,
			sessionId,
			`Re-request the lease with ${missing.join(", ")} granted.`
		);
	}

	if (command.type === "act") {
		const bundleId = bundleIdForAction(command.action);
		if (bundleId !== undefined && !guardAllowsBundle(lease.guard, bundleId)) {
			throw new DesktopAuthorizationError(
				"application_not_allowed",
				`Application "${bundleId}" is not in the session guard's allow list.`,
				sessionId,
				"Add the bundle id to allowedBundleIds when granting the lease."
			);
		}
	}

	const intrusive = requiredScopes.some(isIntrusiveScope);

	if (lease.guard.requireStepApproval && intrusive) {
		const approved =
			input.approvalId !== undefined &&
			sessions.isStepApproved(sessionId, input.approvalId);
		if (!approved) {
			throw new DesktopAuthorizationError(
				"approval_required",
				`Session "${sessionId}" requires per-step approval for ${requiredScopes.join(", ")}.`,
				sessionId,
				"Approve the pending step in Studio, then retry with its approvalId."
			);
		}
	}

	return { lease, requiredScopes, intrusive };
}

/**
 * `data:` carries the bytes inline whatever media type it claims; `blob:` names memory inside a
 * single browsing context, which no other consumer can dereference. Neither is a reference.
 */
const INLINE_IMAGE_PATTERN = /^\s*(?:data|blob):/i;

/**
 * Observation frames must reference image bytes out of band. Inlining a screenshot would put
 * megabytes of base64 into the transcript for every step of a minutes-long session.
 */
export function assertObservationIsReference(imageRef: string, sessionId: string): void {
	if (INLINE_IMAGE_PATTERN.test(imageRef) || imageRef.length > 2048) {
		throw new DesktopAuthorizationError(
			"internal",
			"Runner returned an inline image payload; observation frames must carry an out-of-band imageRef.",
			sessionId,
			"Fix the runner to upload the frame and return a reference."
		);
	}
}
