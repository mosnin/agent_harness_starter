import { describe, expect, it } from "vitest";
import {
	blockAfterKillSwitch,
	blockUnconsentedPointerAndKeyboard,
	createDesktopPolicy,
	desktopGovernanceContext,
	desktopGovernanceRules,
	escalateOnRepeatedFailures,
	rateLimitDesktopActions,
	requireActiveLeaseForIntrusiveScope,
	requireStepApproval,
	restrictToAllowedApplications,
	withDesktopGovernance,
	type DesktopGovernanceContextInput,
} from "../governance/desktop-policy";
import { evaluate, GovernancePolicyViolationError } from "../governance/policy";
import { createComplianceTracker } from "../governance/compliance";
import { denyAllGuard, type SessionLease } from "../tools/cap/types";
import type { ToolDefinition } from "../tools/types";
import type { PluginRunContext } from "../types";
import { z } from "zod";
import { INTRUSIVE_SCOPES, ScopeSchema } from "../runner/protocol";

const NOW = 1_700_000_000_000;

function lease(overrides: Partial<SessionLease> = {}): SessionLease {
	return {
		sessionId: "sess-1",
		runId: "run-1",
		grantedScopes: { scopes: ["observe_screen", "control_pointer", "control_keyboard"] },
		guard: {
			...denyAllGuard(),
			allowedBundleIds: ["com.apple.Safari"],
			requireStepApproval: false,
		},
		startedAtUnixMs: NOW - 1_000,
		expiresAtUnixMs: NOW + 600_000,
		...overrides,
	};
}

function ctx(overrides: Partial<DesktopGovernanceContextInput> = {}) {
	return desktopGovernanceContext({
		agentId: "director-operator",
		action: "tool:cap_act",
		lease: lease(),
		sessionStatus: "active",
		killSwitchEngaged: false,
		requiredScopes: ["control_pointer"],
		stepApproved: false,
		actionCount: 1,
		consecutiveFailures: 0,
		nowUnixMs: NOW,
		...overrides,
	});
}

describe("requireActiveLeaseForIntrusiveScope", () => {
	const rule = requireActiveLeaseForIntrusiveScope();

	it("is not violated when an intrusive scope runs under a live lease", async () => {
		expect(await rule.check(ctx())).toBe(false);
	});

	it("is violated when there is no lease at all", async () => {
		expect(await rule.check(ctx({ lease: null }))).toBe(true);
	});

	it("is violated when the lease has expired", async () => {
		expect(await rule.check(ctx({ lease: lease({ expiresAtUnixMs: NOW - 1 }) }))).toBe(true);
	});

	it("is violated when the session is no longer active", async () => {
		expect(await rule.check(ctx({ sessionStatus: "paused" }))).toBe(true);
	});

	it("ignores read-only observation, which needs no lease-gated scope", async () => {
		expect(
			await rule.check(
				ctx({ action: "tool:cap_observe", requiredScopes: ["observe_screen"], lease: null })
			)
		).toBe(false);
	});

	it("ignores actions outside the desktop capability", async () => {
		expect(await rule.check(ctx({ action: "tool:web_search", lease: null }))).toBe(false);
	});

	it("carries critical risk, because unconsented control is the worst case", () => {
		expect(rule.risk).toBe("critical");
		expect(rule.blocking).toBe(true);
	});
});

describe("blockUnconsentedPointerAndKeyboard", () => {
	const rule = blockUnconsentedPointerAndKeyboard();

	it("is not violated when the scope was consented to", async () => {
		expect(await rule.check(ctx({ requiredScopes: ["control_keyboard"] }))).toBe(false);
	});

	it("is violated when the lease never granted that control scope", async () => {
		expect(
			await rule.check(
				ctx({
					lease: lease({ grantedScopes: { scopes: ["observe_screen"] } }),
					requiredScopes: ["control_pointer"],
				})
			)
		).toBe(true);
	});

	it("is not violated for scopes that are not pointer or keyboard", async () => {
		expect(
			await rule.check(
				ctx({
					lease: lease({ grantedScopes: { scopes: ["observe_screen"] } }),
					requiredScopes: ["record"],
				})
			)
		).toBe(false);
	});

	it("is tagged critical", () => {
		expect(rule.risk).toBe("critical");
	});
});

describe("blockAfterKillSwitch", () => {
	const rule = blockAfterKillSwitch();

	it("is not violated while the kill switch is untouched", async () => {
		expect(await rule.check(ctx())).toBe(false);
	});

	it("is violated for any desktop command once the kill switch is engaged", async () => {
		expect(
			await rule.check(
				ctx({
					action: "tool:cap_observe",
					requiredScopes: ["observe_screen"],
					killSwitchEngaged: true,
				})
			)
		).toBe(true);
	});
});

describe("requireStepApproval", () => {
	const rule = requireStepApproval();
	const strict = lease({ guard: { ...denyAllGuard(), allowedBundleIds: ["com.apple.Safari"] } });

	it("is not violated when the guard does not demand per-step approval", async () => {
		expect(await rule.check(ctx())).toBe(false);
	});

	it("is violated when the guard demands approval and none was granted", async () => {
		expect(await rule.check(ctx({ lease: strict, stepApproved: false }))).toBe(true);
	});

	it("is not violated once the human approved the step", async () => {
		expect(await rule.check(ctx({ lease: strict, stepApproved: true }))).toBe(false);
	});

	it("is not violated for a non-intrusive command under a strict guard", async () => {
		expect(
			await rule.check(
				ctx({ lease: strict, requiredScopes: ["observe_screen"], stepApproved: false })
			)
		).toBe(false);
	});
});

describe("restrictToAllowedApplications", () => {
	const rule = restrictToAllowedApplications();

	it("is not violated for an allowed bundle", async () => {
		expect(await rule.check(ctx({ bundleId: "com.apple.Safari" }))).toBe(false);
	});

	it("is violated for a bundle outside the allow list", async () => {
		expect(await rule.check(ctx({ bundleId: "com.apple.Terminal" }))).toBe(true);
	});

	it("is not violated when the command targets no application", async () => {
		expect(await rule.check(ctx())).toBe(false);
	});
});

describe("escalateOnRepeatedFailures", () => {
	const rule = escalateOnRepeatedFailures({ failureThreshold: 3 });

	it("is not violated below the threshold", async () => {
		expect(await rule.check(ctx({ consecutiveFailures: 2 }))).toBe(false);
	});

	it("is violated at the threshold", async () => {
		expect(await rule.check(ctx({ consecutiveFailures: 3 }))).toBe(true);
	});

	it("escalates rather than blocks", () => {
		expect(rule.blocking).toBe(false);
		expect(rule.risk).toBe("high");
	});
});

describe("rateLimitDesktopActions", () => {
	const rule = rateLimitDesktopActions({ maxActionsPerWindow: 10 });

	it("is not violated inside the budget", async () => {
		expect(await rule.check(ctx({ actionCount: 10 }))).toBe(false);
	});

	it("is violated once the budget is exceeded", async () => {
		expect(await rule.check(ctx({ actionCount: 11 }))).toBe(true);
	});

	it("is not violated when no count is supplied", async () => {
		expect(await rule.check(ctx({ actionCount: undefined }))).toBe(false);
	});
});

describe("createDesktopPolicy", () => {
	it("blocks unconsented control in enforce mode", async () => {
		const policy = createDesktopPolicy();
		const decision = await evaluate(
			policy,
			ctx({ lease: lease({ grantedScopes: { scopes: ["observe_screen"] } }) })
		);
		expect(decision.outcome).toBe("blocked");
		expect(decision.risk).toBe("critical");
	});

	it("reports the kill switch first, ahead of every other rule", async () => {
		const policy = createDesktopPolicy();
		const decision = await evaluate(policy, ctx({ killSwitchEngaged: true, lease: null }));
		expect(decision.ruleId).toBe("desktop.kill-switch-engaged");
	});

	it("allows a well-formed command", async () => {
		const decision = await evaluate(createDesktopPolicy(), ctx());
		expect(decision.outcome).toBe("allowed");
	});

	it("flags instead of blocking in shadow mode", async () => {
		const decision = await evaluate(
			createDesktopPolicy({ mode: "shadow" }),
			ctx({ lease: null })
		);
		expect(decision.outcome).toBe("flagged");
		expect(decision.ruleId).toBe("desktop.require-active-lease");
	});

	it("covers every rule in the set", () => {
		expect(desktopGovernanceRules().map((r) => r.id)).toEqual([
			"desktop.kill-switch-engaged",
			"desktop.require-active-lease",
			"desktop.block-unconsented-control",
			"desktop.application-not-allowed",
			"desktop.require-step-approval",
			"desktop.repeated-failures",
			"desktop.rate-limit",
		]);
	});
});

describe("withDesktopGovernance", () => {
	const runCtx = { agentName: "director-operator" } as unknown as PluginRunContext;

	function fakeTool(executed: string[]): ToolDefinition {
		return {
			name: "cap_act",
			description: "act",
			parameters: z.object({ requiredScopes: z.array(z.string()) }),
			async execute() {
				executed.push("ran");
				return "ok";
			},
		} as unknown as ToolDefinition;
	}

	it("blocks an unconsented tool call in enforce mode", async () => {
		const executed: string[] = [];
		const plugin = withDesktopGovernance({ agentId: "director-operator" });
		const [wrapped] = plugin.wrapTools?.([fakeTool(executed)], runCtx, new Map()) as ToolDefinition[];

		await expect(
			wrapped.execute({ requiredScopes: ["control_pointer"], lease: null }, {})
		).rejects.toBeInstanceOf(GovernancePolicyViolationError);
		expect(executed).toHaveLength(0);
	});

	it("records but does not block in shadow mode", async () => {
		const executed: string[] = [];
		const compliance = createComplianceTracker();
		const plugin = withDesktopGovernance({
			agentId: "director-operator",
			mode: "shadow",
			compliance,
		});
		const [wrapped] = plugin.wrapTools?.([fakeTool(executed)], runCtx, new Map()) as ToolDefinition[];

		await expect(
			wrapped.execute({ requiredScopes: ["control_pointer"], lease: null }, {})
		).resolves.toBe("ok");
		expect(executed).toEqual(["ran"]);
		expect(compliance.query({}).length).toBeGreaterThan(0);
	});
});

describe("desktop rules at the boundaries", () => {
	it("treats a lease as dead at the exact instant it expires, the way the tool does", async () => {
		const rule = requireActiveLeaseForIntrusiveScope();
		expect(await rule.check(ctx({ lease: lease({ expiresAtUnixMs: NOW }) }))).toBe(true);
		expect(await rule.check(ctx({ lease: lease({ expiresAtUnixMs: NOW + 1 }) }))).toBe(false);
	});

	it("gates exactly the scopes the protocol calls intrusive", async () => {
		const rule = requireActiveLeaseForIntrusiveScope();
		for (const scope of INTRUSIVE_SCOPES) {
			expect(await rule.check(ctx({ lease: null, requiredScopes: [scope] }))).toBe(true);
		}
		const passive = ScopeSchema.options.filter((scope) => !INTRUSIVE_SCOPES.includes(scope));
		expect(passive).toEqual(["observe_screen", "record", "edit", "export"]);
		for (const scope of passive) {
			expect(await rule.check(ctx({ lease: null, requiredScopes: [scope] }))).toBe(false);
		}
	});

	it("does not fire the kill-switch rule on a non-desktop action", async () => {
		expect(
			await blockAfterKillSwitch().check(
				ctx({ action: "tool:web_search", killSwitchEngaged: true })
			)
		).toBe(false);
	});
});
