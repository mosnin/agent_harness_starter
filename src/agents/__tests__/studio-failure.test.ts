import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../types";
import { createStudioReducer } from "../../../components/Studio/reducer";
import {
	dryRunDurationMs,
	dryRunMissingScopes,
	failureCodeLabel,
	failureRemediation,
	failureStepLabel,
	normalizeFailureCode,
} from "../../../components/Studio/format";
import { EMPTY_STUDIO_STATE } from "../../../components/Studio/types";
import type { StudioDryRun, StudioSession, StudioState } from "../../../components/Studio/types";

const reduce = createStudioReducer({
	resolveImageUrl: (ref) => `https://frames.test/${ref}`,
	now: () => 1_700_000_000_000,
});

function apply(events: AgentEvent[]): StudioState {
	return events.reduce(reduce, EMPTY_STUDIO_STATE);
}

const OBSERVED: AgentEvent[] = [
	{ type: "tool_call", callId: "obs", name: "cap_observe", input: {} },
	{
		type: "tool_result",
		callId: "obs",
		name: "cap_observe",
		output: {
			frameId: "frame-9",
			imageRef: "frame-9.png",
			width: 1440,
			height: 900,
			capturedAtUnixMs: 1_699_999_000_000,
			focusedWindow: { title: "Safari" },
			redactedWindows: [],
		},
	},
];

describe("studio failure legibility", () => {
	it("names the element the agent was reaching for when it stopped", () => {
		const state = apply([
			{
				type: "tool_call",
				callId: "c7",
				name: "cap_act",
				input: {
					action: {
						type: "click",
						target: { type: "elementQuery", role: "AXButton", title: "Continue" },
					},
				},
			},
			{ type: "error", error: "4 elements match that description.", code: "target_ambiguous" },
		]);

		expect(state.failure?.target).toBe("Continue · AXButton");
		expect(state.steps[0].target).toBe("Continue · AXButton");
	});

	it("reads the candidate count out of the message when nothing structured carries it", () => {
		const state = apply([
			{ type: "tool_call", callId: "c1", name: "cap_act", input: {} },
			{ type: "error", error: "4 elements match that description.", code: "target_ambiguous" },
		]);
		expect(state.failure?.candidateCount).toBe(4);
	});

	it("prefers a structured candidate list over the message", () => {
		const state = apply([
			{ type: "tool_call", callId: "c1", name: "cap_act", input: {} },
			{
				type: "error",
				error: "Ambiguous target.",
				code: "target_ambiguous",
				candidates: [
					{ elementId: "e1", role: "AXButton", title: "Continue" },
					{ elementId: "e2", role: "AXButton", title: "Continue to checkout" },
				],
			} as AgentEvent,
		]);
		expect(state.failure?.candidateCount).toBe(2);
		expect(state.failure?.candidates).toEqual([
			"Continue · AXButton",
			"Continue to checkout · AXButton",
		]);
	});

	it("anchors the failure to a place in the plan", () => {
		const state = apply([
			{ type: "tool_call", callId: "c1", name: "cap_observe", input: {} },
			{ type: "tool_result", callId: "c1", name: "cap_observe", output: {} },
			{ type: "tool_call", callId: "c2", name: "cap_act", input: { beatLabel: "Click Continue" } },
			{ type: "error", error: "Nope.", code: "target_not_found", toolName: "cap_act" },
		]);

		const failure = state.failure;
		if (!failure) throw new Error("expected a structured failure");
		expect(failure.stepIndex).toBe(1);
		expect(failure.stepId).toBe("c2");
		expect(failureStepLabel(failure)).toBe("Step 2 · Click Continue");
		expect(failure.toolName).toBe("cap_act");
	});

	it("carries the frame the agent was looking at into the failure", () => {
		const state = apply([
			...OBSERVED,
			{ type: "tool_call", callId: "c2", name: "cap_act", input: {} },
			{ type: "error", error: "Nope.", code: "target_not_found" },
		]);

		expect(state.failure?.observationFrameId).toBe("frame-9");
		expect(state.failure?.observationImageUrl).toBe("https://frames.test/frame-9.png");
		expect(state.failure?.observationCapturedAtUnixMs).toBe(1_699_999_000_000);
	});

	it("attaches the same failure to the step that was running", () => {
		const state = apply([
			{ type: "tool_call", callId: "c1", name: "cap_act", input: {} },
			{
				type: "error",
				error: "Session lease expired",
				code: "DESKTOP_SESSION_EXPIRED",
				remediation: "Ask the user to re-grant the lease.",
			},
		]);

		expect(state.steps[0].status).toBe("failed");
		expect(state.steps[0].failure?.remediation).toBe("Ask the user to re-grant the lease.");
		expect(state.error).toContain("re-grant the lease");
	});

	it("describes point and element targets a human cannot otherwise place", () => {
		const point = apply([
			{
				type: "tool_call",
				callId: "c1",
				name: "cap_act",
				input: {
					action: {
						type: "moveTo",
						target: { type: "point", point: { x: 120.4, y: 88.6, space: "display_pixels" } },
					},
				},
			},
		]);
		expect(point.steps[0].target).toBe("the point 120, 89");

		const element = apply([
			{
				type: "tool_call",
				callId: "c1",
				name: "cap_act",
				input: { action: { type: "click", target: { type: "element", elementId: "e-42" } } },
			},
		]);
		expect(element.steps[0].target).toBe("element e-42");
	});
});

describe("failure formatting", () => {
	it("normalises the three spellings a code reaches the Studio in", () => {
		expect(normalizeFailureCode("target_ambiguous")).toBe("target_ambiguous");
		expect(normalizeFailureCode("DESKTOP_TARGET_AMBIGUOUS")).toBe("target_ambiguous");
		expect(normalizeFailureCode("RUNNER_SESSION_EXPIRED")).toBe("session_expired");
		expect(normalizeFailureCode(null)).toBeNull();
	});

	it("gives every protocol code a plain-language headline", () => {
		expect(failureCodeLabel("target_ambiguous")).toBe("More than one thing on screen matched");
		expect(failureCodeLabel("DESKTOP_PERMISSION_MISSING")).toMatch(/macOS has not granted/);
		expect(failureCodeLabel("not_a_real_code")).toBeNull();
	});

	it("prefers the protocol's remediation and falls back when there is none", () => {
		expect(
			failureRemediation({
				message: "x",
				code: "target_ambiguous",
				remediation: "Use the accessibility identifier.",
				atUnixMs: 0,
			})
		).toBe("Use the accessibility identifier.");
		expect(
			failureRemediation({ message: "x", code: "target_ambiguous", atUnixMs: 0 })
		).toMatch(/narrow the description/i);
		expect(failureRemediation({ message: "x", code: "internal", atUnixMs: 0 })).toBeNull();
	});
});

describe("dry-run formatting", () => {
	const session: StudioSession = {
		sessionId: "s1",
		runId: "r1",
		status: "active",
		grantedScopes: ["observe_screen"],
		startedAtUnixMs: 0,
		expiresAtUnixMs: 1_000,
		killSwitchEngaged: false,
	};

	const dryRun: StudioDryRun = {
		summary: "Record a walkthrough.",
		steps: [
			{ id: "1", label: "Open Safari", scope: "control_applications", estimatedMs: 3_000 },
			{ id: "2", label: "Click Continue", scope: "control_pointer", estimatedMs: 1_500 },
		],
		applications: [{ bundleId: "com.apple.Safari", name: "Safari" }],
		scopes: ["observe_screen", "control_pointer", "control_applications"],
	};

	it("sums per-step estimates when no total is supplied", () => {
		expect(dryRunDurationMs(dryRun)).toBe(4_500);
		expect(dryRunDurationMs({ ...dryRun, estimatedDurationMs: 42_000 })).toBe(42_000);
		expect(dryRunDurationMs({ ...dryRun, steps: [] })).toBeNull();
	});

	it("reports only the authority the session does not already hold", () => {
		expect(dryRunMissingScopes(dryRun, session)).toEqual([
			"control_pointer",
			"control_applications",
		]);
		expect(dryRunMissingScopes(dryRun, null)).toEqual(dryRun.scopes);
	});
});
