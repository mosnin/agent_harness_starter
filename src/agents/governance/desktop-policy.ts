/**
 * Governance rules for the desktop-control capability.
 *
 * Every rule follows the framework convention: `check()` returning **true** means the rule was
 * VIOLATED. Rules read a typed metadata bag off the `GovernanceContext`; build it with
 * `desktopGovernanceContext` so the shape stays consistent between the tool pack, the operator
 * loop and the Studio surface.
 *
 * This policy is defence in depth. The authorization that always runs lives inside each cap
 * tool's `execute` (`src/agents/tools/cap/authorization.ts`), because the orchestrator never
 * applies plugins. Start this policy in shadow mode (`mode: "shadow"`) so a first rollout records
 * what it would have blocked without breaking a live shoot.
 */

import { withGovernance } from "./plugin";
import type { GovernancePluginOptions } from "./plugin";
import { createGovernancePolicy } from "./policy";
import type { GovernancePolicy } from "./policy";
import type { GovernanceContext, GovernanceRule } from "./types";
import type { HarnessPlugin } from "../types";
import { isIntrusiveScope } from "../tools/cap/types";
import type { CapScope, SessionLease } from "../tools/cap/types";
import type { DesktopSession, DesktopSessionStatus } from "../tools/cap/client";

export interface DesktopGovernanceMetadata {
	sessionId?: string;
	lease?: SessionLease | null;
	sessionStatus?: DesktopSessionStatus;
	killSwitchEngaged?: boolean;
	/** Scopes the pending command needs, from `requiredScopesForCommand`. */
	requiredScopes?: CapScope[];
	/** Bundle identifier the pending command targets, when it targets an application. */
	bundleId?: string;
	/** Whether the human approved this specific step. */
	stepApproved?: boolean;
	/** Commands issued in the current rate-limit window. */
	actionCount?: number;
	/** Consecutive failed commands on this session. */
	consecutiveFailures?: number;
	nowUnixMs?: number;
}

export interface DesktopGovernanceContextInput extends DesktopGovernanceMetadata {
	agentId: string;
	userId?: string;
	threadId?: string;
	/** e.g. "tool:cap_act". */
	action: string;
	content?: string;
}

export function desktopGovernanceContext(
	input: DesktopGovernanceContextInput
): GovernanceContext {
	const { agentId, userId, threadId, action, content, ...metadata } = input;
	return {
		agentId,
		userId,
		threadId,
		action,
		content,
		metadata: metadata as Record<string, unknown>,
		timestamp: metadata.nowUnixMs ?? Date.now(),
	};
}

/**
 * `withGovernance` builds its own context and nests the tool input under `metadata.input`, so the
 * desktop bag is read from either place. When the rules run through the plugin they can only see
 * what the tool input carries — another reason the authoritative check lives inside the tool.
 */
function meta(ctx: GovernanceContext): DesktopGovernanceMetadata {
	const raw = (ctx.metadata ?? {}) as Record<string, unknown>;
	const direct = raw as DesktopGovernanceMetadata;
	const hasDesktopKeys =
		"lease" in raw || "requiredScopes" in raw || "killSwitchEngaged" in raw;
	if (hasDesktopKeys) return direct;
	const nested = raw.input;
	return nested && typeof nested === "object"
		? (nested as DesktopGovernanceMetadata)
		: direct;
}

/** Default prefixes that mark an action as desktop control. */
export const DESKTOP_ACTION_PREFIXES = ["tool:cap_", "desktop:"];

function isDesktopAction(ctx: GovernanceContext, prefixes: string[]): boolean {
	return prefixes.some((prefix) => ctx.action.startsWith(prefix));
}

function requestedScopes(ctx: GovernanceContext): CapScope[] {
	return meta(ctx).requiredScopes ?? [];
}

function leaseIsLive(m: DesktopGovernanceMetadata): boolean {
	if (!m.lease) return false;
	if (m.killSwitchEngaged) return false;
	if (m.sessionStatus !== undefined && m.sessionStatus !== "active") return false;
	const now = m.nowUnixMs ?? Date.now();
	return now < m.lease.expiresAtUnixMs;
}

/** Build the metadata bag for a pending command from live session state. */
export function desktopMetadataFromSession(
	session: DesktopSession | undefined,
	pending: { requiredScopes: CapScope[]; bundleId?: string; stepApproved?: boolean },
	nowUnixMs = Date.now()
): DesktopGovernanceMetadata {
	return {
		sessionId: session?.lease.sessionId,
		lease: session?.lease ?? null,
		sessionStatus: session?.status,
		killSwitchEngaged: session?.killSwitchEngaged ?? false,
		actionCount: session?.actionCount,
		consecutiveFailures: session?.consecutiveFailures,
		requiredScopes: pending.requiredScopes,
		bundleId: pending.bundleId,
		stepApproved: pending.stepApproved,
		nowUnixMs,
	};
}

export interface DesktopPolicyOptions {
	/** Action prefixes the rules apply to. Default: `DESKTOP_ACTION_PREFIXES`. */
	actionPrefixes?: string[];
	/** Consecutive failures that trigger escalation. Default 3. */
	failureThreshold?: number;
	/** Maximum desktop commands per rate-limit window. Default 60. */
	maxActionsPerWindow?: number;
	/** Label for the rate-limit window, used in the rule description. Default "minute". */
	windowLabel?: string;
}

// ── Rules ─────────────────────────────────────────────────────────────────────

/** No intrusive scope without a live, user-granted lease. */
export function requireActiveLeaseForIntrusiveScope(
	options: DesktopPolicyOptions = {}
): GovernanceRule {
	const prefixes = options.actionPrefixes ?? DESKTOP_ACTION_PREFIXES;
	return {
		id: "desktop.require-active-lease",
		description:
			"Intrusive desktop control attempted without a live, user-granted session lease.",
		risk: "critical",
		blocking: true,
		check(ctx) {
			if (!isDesktopAction(ctx, prefixes)) return false;
			if (!requestedScopes(ctx).some(isIntrusiveScope)) return false;
			return !leaseIsLive(meta(ctx));
		},
	};
}

/** Pointer and keyboard control require that exact scope to have been consented to. */
export function blockUnconsentedPointerAndKeyboard(
	options: DesktopPolicyOptions = {}
): GovernanceRule {
	const prefixes = options.actionPrefixes ?? DESKTOP_ACTION_PREFIXES;
	const controlScopes: CapScope[] = ["control_pointer", "control_keyboard"];
	return {
		id: "desktop.block-unconsented-control",
		description:
			"Pointer or keyboard control attempted without the user consenting to that scope.",
		risk: "critical",
		blocking: true,
		check(ctx) {
			if (!isDesktopAction(ctx, prefixes)) return false;
			const needed = requestedScopes(ctx).filter((scope) => controlScopes.includes(scope));
			if (needed.length === 0) return false;
			const granted = meta(ctx).lease?.grantedScopes.scopes ?? [];
			return needed.some((scope) => !granted.includes(scope));
		},
	};
}

/** Once the human hits the kill switch, nothing else may run on that session. */
export function blockAfterKillSwitch(options: DesktopPolicyOptions = {}): GovernanceRule {
	const prefixes = options.actionPrefixes ?? DESKTOP_ACTION_PREFIXES;
	return {
		id: "desktop.kill-switch-engaged",
		description: "Desktop command issued after the user engaged the kill switch.",
		risk: "critical",
		blocking: true,
		check(ctx) {
			if (!isDesktopAction(ctx, prefixes)) return false;
			return meta(ctx).killSwitchEngaged === true;
		},
	};
}

/** A guard that demands per-step approval must actually have one for this step. */
export function requireStepApproval(options: DesktopPolicyOptions = {}): GovernanceRule {
	const prefixes = options.actionPrefixes ?? DESKTOP_ACTION_PREFIXES;
	return {
		id: "desktop.require-step-approval",
		description:
			"Intrusive step ran without the per-step approval the session guard requires.",
		risk: "high",
		blocking: true,
		check(ctx) {
			if (!isDesktopAction(ctx, prefixes)) return false;
			const m = meta(ctx);
			if (m.lease?.guard.requireStepApproval !== true) return false;
			if (!requestedScopes(ctx).some(isIntrusiveScope)) return false;
			return m.stepApproved !== true;
		},
	};
}

/** Applications outside the guard's allow list are off limits even inside a live lease. */
export function restrictToAllowedApplications(
	options: DesktopPolicyOptions = {}
): GovernanceRule {
	const prefixes = options.actionPrefixes ?? DESKTOP_ACTION_PREFIXES;
	return {
		id: "desktop.application-not-allowed",
		description: "Desktop command targeted an application outside the session guard allow list.",
		risk: "high",
		blocking: true,
		check(ctx) {
			if (!isDesktopAction(ctx, prefixes)) return false;
			const m = meta(ctx);
			if (!m.bundleId) return false;
			const allowed = m.lease?.guard.allowedBundleIds ?? [];
			return !allowed.includes(m.bundleId);
		},
	};
}

/** Repeated failures mean the agent is lost on someone's desktop — escalate rather than grind. */
export function escalateOnRepeatedFailures(
	options: DesktopPolicyOptions = {}
): GovernanceRule {
	const prefixes = options.actionPrefixes ?? DESKTOP_ACTION_PREFIXES;
	const threshold = options.failureThreshold ?? 3;
	return {
		id: "desktop.repeated-failures",
		description: `Desktop session hit ${threshold} consecutive command failures.`,
		risk: "high",
		blocking: false,
		check(ctx) {
			if (!isDesktopAction(ctx, prefixes)) return false;
			const failures = meta(ctx).consecutiveFailures ?? 0;
			return failures >= threshold;
		},
	};
}

/** Bound how fast an agent may drive the machine. */
export function rateLimitDesktopActions(options: DesktopPolicyOptions = {}): GovernanceRule {
	const prefixes = options.actionPrefixes ?? DESKTOP_ACTION_PREFIXES;
	const max = options.maxActionsPerWindow ?? 60;
	const windowLabel = options.windowLabel ?? "minute";
	return {
		id: "desktop.rate-limit",
		description: `More than ${max} desktop commands per ${windowLabel}.`,
		risk: "medium",
		blocking: false,
		check(ctx) {
			if (!isDesktopAction(ctx, prefixes)) return false;
			const count = meta(ctx).actionCount;
			return count !== undefined && count > max;
		},
	};
}

export function desktopGovernanceRules(
	options: DesktopPolicyOptions = {}
): GovernanceRule[] {
	return [
		blockAfterKillSwitch(options),
		requireActiveLeaseForIntrusiveScope(options),
		blockUnconsentedPointerAndKeyboard(options),
		restrictToAllowedApplications(options),
		requireStepApproval(options),
		escalateOnRepeatedFailures(options),
		rateLimitDesktopActions(options),
	];
}

export interface DesktopPolicyConfig extends DesktopPolicyOptions {
	name?: string;
	/**
	 * "shadow" records violations without blocking — use it for the first rollout.
	 * "enforce" blocks. Default "enforce".
	 */
	mode?: "enforce" | "shadow";
}

export function createDesktopPolicy(config: DesktopPolicyConfig = {}): GovernancePolicy {
	return createGovernancePolicy({
		name: config.name ?? "desktop-control",
		rules: desktopGovernanceRules(config),
		defaultOutcome: "allowed",
		onViolation: config.mode === "shadow" ? "flag" : "block",
	});
}

/**
 * Governance plugin preconfigured for desktop control. `auditOnly` is derived from `mode`, so
 * shadow mode neither blocks nor throws while still recording every decision.
 */
export function withDesktopGovernance(
	config: DesktopPolicyConfig & Omit<GovernancePluginOptions, "policy" | "auditOnly"> = {}
): HarnessPlugin {
	const { name, mode, actionPrefixes, failureThreshold, maxActionsPerWindow, windowLabel, ...pluginOptions } =
		config;
	return withGovernance({
		...pluginOptions,
		policy: createDesktopPolicy({
			name,
			mode,
			actionPrefixes,
			failureThreshold,
			maxActionsPerWindow,
			windowLabel,
		}),
		auditOnly: mode === "shadow",
	});
}
