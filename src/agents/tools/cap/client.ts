/**
 * Transport-agnostic seam between the cap tool pack and the paired `cap-runner` daemon.
 *
 * Tools never open a socket themselves: they take a `DirectorClient` and a `DesktopSessionReader`.
 * Team E's transport implements the client; tests pass a fake.
 */

import type {
	DirectorCommand,
	DirectorCommandResult,
	SessionEndReason,
	SessionLease,
} from "./types";

export interface DirectorSendOptions {
	sessionId: string;
	signal?: AbortSignal;
}

export interface DirectorClient {
	send(
		command: DirectorCommand,
		options: DirectorSendOptions
	): Promise<DirectorCommandResult>;
}

export type DesktopSessionStatus = "pending" | "active" | "paused" | "ended";

export interface DesktopSession {
	lease: SessionLease;
	status: DesktopSessionStatus;
	killSwitchEngaged: boolean;
	endReason?: SessionEndReason;
	/** Actions issued inside the current rate-limit window. */
	actionCount: number;
	/** Consecutive failed commands; resets on success. */
	consecutiveFailures: number;
	lastActivityUnixMs: number;
}

/** Read side used by tool-level authorization. */
export interface DesktopSessionReader {
	getSession(sessionId: string): DesktopSession | undefined;
	/** True when the human has approved the pending step identified by `approvalId`. */
	isStepApproved(sessionId: string, approvalId: string): boolean;
}

export interface DesktopSessionStore extends DesktopSessionReader {
	grantLease(lease: SessionLease): DesktopSession;
	engageKillSwitch(sessionId: string): void;
	endSession(sessionId: string, reason: SessionEndReason): void;
	approveStep(sessionId: string, approvalId: string): void;
	revokeStepApproval(sessionId: string, approvalId: string): void;
	recordOutcome(sessionId: string, outcome: "ok" | "failed"): void;
	resetActionWindow(sessionId: string): void;
	snapshot(): DesktopSession[];
}

export interface DesktopSessionStoreOptions {
	now?: () => number;
}

export function createInMemoryDesktopSessionStore(
	options: DesktopSessionStoreOptions = {}
): DesktopSessionStore {
	const now = options.now ?? (() => Date.now());
	const sessions = new Map<string, DesktopSession>();
	const approvals = new Map<string, Set<string>>();

	const mutate = (sessionId: string, fn: (session: DesktopSession) => void) => {
		const session = sessions.get(sessionId);
		if (session) fn(session);
	};

	return {
		getSession(sessionId) {
			return sessions.get(sessionId);
		},

		isStepApproved(sessionId, approvalId) {
			return approvals.get(sessionId)?.has(approvalId) ?? false;
		},

		grantLease(lease) {
			const session: DesktopSession = {
				lease,
				status: "active",
				killSwitchEngaged: false,
				actionCount: 0,
				consecutiveFailures: 0,
				lastActivityUnixMs: now(),
			};
			sessions.set(lease.sessionId, session);
			approvals.set(lease.sessionId, new Set());
			return session;
		},

		engageKillSwitch(sessionId) {
			mutate(sessionId, (session) => {
				session.killSwitchEngaged = true;
				session.status = "ended";
				session.endReason = "user_kill_switch";
			});
			approvals.get(sessionId)?.clear();
		},

		endSession(sessionId, reason) {
			mutate(sessionId, (session) => {
				session.status = "ended";
				session.endReason = reason;
			});
			approvals.get(sessionId)?.clear();
		},

		approveStep(sessionId, approvalId) {
			const existing = approvals.get(sessionId) ?? new Set<string>();
			existing.add(approvalId);
			approvals.set(sessionId, existing);
		},

		revokeStepApproval(sessionId, approvalId) {
			approvals.get(sessionId)?.delete(approvalId);
		},

		recordOutcome(sessionId, outcome) {
			mutate(sessionId, (session) => {
				session.actionCount += 1;
				session.consecutiveFailures =
					outcome === "failed" ? session.consecutiveFailures + 1 : 0;
				session.lastActivityUnixMs = now();
			});
		},

		resetActionWindow(sessionId) {
			mutate(sessionId, (session) => {
				session.actionCount = 0;
			});
		},

		snapshot() {
			return Array.from(sessions.values()).map((s) => ({ ...s }));
		},
	};
}
