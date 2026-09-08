import { describe, expect, it } from "vitest";
import {
	createStudioReducer,
	resolveApproval,
} from "../../../components/Studio/reducer";
import {
	currentStep,
	formatBytes,
	formatDuration,
	isSessionLive,
	scopeLabel,
	sessionStatusText,
} from "../../../components/Studio/format";
import { EMPTY_STUDIO_STATE } from "../../../components/Studio/types";
import type { StudioSession, StudioState, StudioStep } from "../../../components/Studio/types";
import type { AgentEvent } from "../types";

const NOW = 1_700_000_000_000;

const reduce = createStudioReducer({
	now: () => NOW,
	resolveImageUrl: (ref) => `/api/studio/frame?ref=${encodeURIComponent(ref)}`,
});

function apply(events: AgentEvent[], initial: StudioState = EMPTY_STUDIO_STATE): StudioState {
	return events.reduce(reduce, initial);
}

function session(overrides: Partial<StudioSession> = {}): StudioSession {
	return {
		sessionId: "sess-1",
		runId: "run-1",
		status: "active",
		grantedScopes: ["observe_screen", "control_pointer"],
		startedAtUnixMs: NOW - 1_000,
		expiresAtUnixMs: NOW + 60_000,
		killSwitchEngaged: false,
		...overrides,
	};
}

describe("studio reducer", () => {
	it("turns a tool call into a running step with a human-readable label", () => {
		const state = apply([
			{
				type: "tool_call",
				callId: "c1",
				name: "cap_act",
				input: {
					sessionId: "sess-1",
					action: { type: "click", target: { type: "element", elementId: "e1" } },
					beatLabel: "click Continue",
				},
			},
		]);
		expect(state.steps).toHaveLength(1);
		expect(state.steps[0].label).toBe("click Continue");
		expect(state.steps[0].scope).toBe("control_pointer");
		expect(state.steps[0].status).toBe("running");
	});

	it("derives the keyboard scope from the action, not the tool name", () => {
		const state = apply([
			{
				type: "tool_call",
				callId: "c1",
				name: "cap_act",
				input: { action: { type: "typeText", text: "hi", charsPerMinute: 400 } },
			},
		]);
		expect(state.steps[0].scope).toBe("control_keyboard");
	});

	it("resolves an observation frame to a URL and never carries image bytes", () => {
		const state = apply([
			{ type: "tool_call", callId: "c1", name: "cap_observe", input: {} },
			{
				type: "tool_result",
				callId: "c1",
				name: "cap_observe",
				output: {
					frameId: "f1",
					imageRef: "cap://frames/f1",
					width: 1440,
					height: 900,
					capturedAtUnixMs: NOW,
					focusedWindow: { title: "Cap — Safari" },
					redactedWindows: ["1Password"],
				},
			},
		]);
		expect(state.observation?.imageUrl).toBe("/api/studio/frame?ref=cap%3A%2F%2Fframes%2Ff1");
		expect(state.observation?.focusedWindowTitle).toBe("Cap — Safari");
		expect(state.observation?.redactedWindows).toEqual(["1Password"]);
		expect(state.steps[0].status).toBe("succeeded");
	});

	it("collects the export as an artifact", () => {
		const state = apply([
			{ type: "tool_call", callId: "c9", name: "cap_export", input: {} },
			{
				type: "tool_result",
				callId: "c9",
				name: "cap_export",
				output: { outputPath: "/tmp/demo.mp4", durationMs: 11_400, fps: 58.2, bytes: 4_500_000 },
			},
		]);
		expect(state.artifacts).toHaveLength(1);
		expect(state.artifacts[0]).toMatchObject({ kind: "export", path: "/tmp/demo.mp4" });
	});

	it("surfaces approval_required, which AgentChat drops on the floor", () => {
		const state = apply([
			{
				type: "approval_required",
				runId: "run-1",
				approvalId: "ap-1",
				toolName: "cap_act",
				description: "Click Continue in Safari",
				input: { action: { type: "click" } },
			},
		]);
		expect(state.approvals).toHaveLength(1);
		expect(state.approvals[0].summary).toBe("Click Continue in Safari");
		expect(state.approvals[0].scopes).toEqual(["control_pointer"]);
	});

	it("ignores a duplicate approval for the same id", () => {
		const event: AgentEvent = {
			type: "approval_required",
			runId: "run-1",
			approvalId: "ap-1",
			toolName: "cap_act",
			description: "Click Continue",
			input: {},
		};
		expect(apply([event, event]).approvals).toHaveLength(1);
	});

	it("drops an approval once it has been answered", () => {
		const state = apply([
			{
				type: "approval_required",
				runId: "run-1",
				approvalId: "ap-1",
				toolName: "cap_act",
				description: "Click Continue",
				input: {},
			},
		]);
		expect(resolveApproval(state, "ap-1").approvals).toHaveLength(0);
	});

	it("marks the running step failed and surfaces the error with its remediation", () => {
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
		expect(state.error).toContain("re-grant the lease");
	});

	it("attaches progress detail to the step in flight", () => {
		const state = apply([
			{ type: "tool_call", callId: "c1", name: "cap_export", input: {} },
			{ type: "progress", stage: "export", fraction: 0.4, detail: "Rendering shot 2 of 4" },
		]);
		expect(state.steps[0].detail).toBe("Rendering shot 2 of 4");
	});
});

describe("studio formatting", () => {
	it("names scopes in words a non-engineer reads", () => {
		expect(scopeLabel("control_keyboard")).toBe("Type on your keyboard");
		expect(scopeLabel("observe_screen")).toBe("See your screen");
	});

	it("treats a session as live only while the lease actually holds", () => {
		expect(isSessionLive(session(), NOW)).toBe(true);
		expect(isSessionLive(session({ killSwitchEngaged: true }), NOW)).toBe(false);
		expect(isSessionLive(session({ status: "paused" }), NOW)).toBe(false);
		expect(isSessionLive(session({ expiresAtUnixMs: NOW - 1 }), NOW)).toBe(false);
		expect(isSessionLive(null, NOW)).toBe(false);
	});

	it("says the kill switch stopped things, ahead of the raw status", () => {
		expect(sessionStatusText(session({ killSwitchEngaged: true }))).toBe(
			"Stopped by kill switch"
		);
		expect(sessionStatusText(session())).toBe("Agent is driving your Mac");
		expect(sessionStatusText(null)).toBe("No session");
	});

	it("picks the running step as the current action, else the latest", () => {
		const steps: StudioStep[] = [
			{
				id: "a",
				index: 0,
				label: "one",
				actionType: "click",
				scope: "control_pointer",
				status: "succeeded",
				atUnixMs: NOW,
			},
			{
				id: "b",
				index: 1,
				label: "two",
				actionType: "typeText",
				scope: "control_keyboard",
				status: "running",
				atUnixMs: NOW,
			},
		];
		expect(currentStep(steps)?.id).toBe("b");
		expect(currentStep([steps[0]])?.id).toBe("a");
		expect(currentStep([])).toBeNull();
	});

	it("formats durations and sizes", () => {
		expect(formatDuration(11_400)).toBe("11s");
		expect(formatDuration(75_000)).toBe("1m 15s");
		expect(formatDuration(-1)).toBe("—");
		expect(formatBytes(4_500_000)).toBe("4.3 MB");
		expect(formatBytes(512)).toBe("512 B");
	});
});
