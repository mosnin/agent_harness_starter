import { describe, expect, it, vi } from "vitest";
import {
	createDirectorTeam,
	runOperatorLoop,
	runReviewLoop,
	OPENAI_COMPUTER_USE_MODEL,
	type OperatorDecision,
	type OperatorLoopOptions,
} from "../definitions/director";
import type { ObservationSummary } from "../tools/cap/tools";
import type { ActToolResult } from "../tools/cap/tools";
import type { InputAction } from "../tools/cap/types";

const CLICK: InputAction = {
	type: "click",
	target: { type: "element", elementId: "el-1" },
	button: "left",
	clickCount: 1,
};

function observation(overrides: Partial<ObservationSummary> = {}): ObservationSummary {
	return {
		sessionId: "sess-1",
		frameId: "frame-1",
		imageRef: "cap://frames/frame-1",
		width: 1440,
		height: 900,
		capturedAtUnixMs: 0,
		display: {
			displayId: "disp-1",
			width: 1440,
			height: 900,
			scaleFactor: 2,
			isPrimary: true,
		},
		focusedWindow: {
			windowId: "win-1",
			bundleId: "com.apple.Safari",
			title: "Cap — Safari",
			bounds: { x: 0, y: 0, width: 1440, height: 900 },
		},
		redactedWindows: [],
		maskedRegions: [],
		elementCount: 1,
		elementsTruncated: false,
		elements: [
			{
				elementId: "el-1",
				role: "AXButton",
				title: "Continue",
				value: null,
				identifier: null,
				bounds: { x: 0, y: 0, width: 10, height: 10 },
				enabled: true,
				focused: false,
			},
		],
		...overrides,
	};
}

function actResult(beatId?: string): ActToolResult {
	return {
		sessionId: "sess-1",
		action: "click",
		scope: "control_pointer",
		beat: beatId
			? { beatId, offsetMs: 1_000, kind: "action", label: beatId, landmark: null }
			: null,
	};
}

function loopOptions(overrides: Partial<OperatorLoopOptions> = {}): OperatorLoopOptions {
	return {
		sessionId: "sess-1",
		goal: "record a demo of search",
		observe: async () => observation(),
		decide: async () => ({ type: "act", action: CLICK }) as OperatorDecision,
		act: async () => actResult(),
		...overrides,
	};
}

describe("runOperatorLoop", () => {
	it("stops when the model reports the goal is met", async () => {
		let step = 0;
		const result = await runOperatorLoop(
			loopOptions({
				observe: async (i) => observation({ frameId: `f${i}`, elementCount: i + 1 }),
				decide: async () =>
					step++ === 0
						? ({ type: "act", action: CLICK, beatLabel: "click continue" } as OperatorDecision)
						: ({ type: "done", summary: "search results shown" } as OperatorDecision),
				act: async () => actResult("b1"),
			})
		);

		expect(result.stoppedBy).toBe("completed");
		expect(result.summary).toBe("search results shown");
		expect(result.steps).toHaveLength(2);
		expect(result.beats.map((b) => b.beatId)).toEqual(["b1"]);
	});

	it("enforces the step cap when the model never finishes", async () => {
		const act = vi.fn(async () => actResult());
		const result = await runOperatorLoop(
			loopOptions({
				observe: async (i) => observation({ elementCount: i }),
				act,
				maxSteps: 4,
			})
		);

		expect(result.stoppedBy).toBe("max_steps");
		expect(result.steps).toHaveLength(4);
		expect(act).toHaveBeenCalledTimes(4);
	});

	it("detects a stall from identical consecutive observations", async () => {
		const act = vi.fn(async () => actResult());
		const result = await runOperatorLoop(
			loopOptions({ act, stallLimit: 2, maxSteps: 20 })
		);

		expect(result.stoppedBy).toBe("stalled");
		expect(result.summary).toMatch(/did not change/);
		expect(act).toHaveBeenCalledTimes(2);
	});

	it("does not call a stall when the screen keeps changing", async () => {
		const result = await runOperatorLoop(
			loopOptions({
				observe: async (i) => observation({ elementCount: i }),
				stallLimit: 2,
				maxSteps: 5,
			})
		);
		expect(result.stoppedBy).toBe("max_steps");
	});

	it("resets the stall counter when the screen changes again", async () => {
		const screens = [0, 0, 1, 1, 2, 2, 3];
		const result = await runOperatorLoop(
			loopOptions({
				observe: async (i) => observation({ elementCount: screens[i] ?? 9 }),
				stallLimit: 2,
				maxSteps: 7,
			})
		);
		expect(result.stoppedBy).toBe("max_steps");
		expect(result.steps).toHaveLength(7);
	});

	it("honours the wall-clock hard stop", async () => {
		let clock = 0;
		const result = await runOperatorLoop(
			loopOptions({
				observe: async (i) => observation({ elementCount: i }),
				now: () => {
					clock += 400;
					return clock;
				},
				hardStopMs: 1_000,
				maxSteps: 50,
			})
		);
		expect(result.stoppedBy).toBe("hard_stop");
		expect(result.steps.length).toBeLessThan(50);
	});

	it("stops immediately when the kill switch is engaged", async () => {
		let engaged = false;
		const act = vi.fn(async () => {
			engaged = true;
			return actResult();
		});
		const result = await runOperatorLoop(
			loopOptions({
				observe: async (i) => observation({ elementCount: i }),
				act,
				isKillSwitchEngaged: () => engaged,
				maxSteps: 10,
			})
		);
		expect(result.stoppedBy).toBe("kill_switch");
		expect(act).toHaveBeenCalledTimes(1);
	});

	it("stops when the caller's signal aborts", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await runOperatorLoop(loopOptions({ signal: controller.signal }));
		expect(result.stoppedBy).toBe("aborted");
		expect(result.steps).toHaveLength(0);
	});

	it("records a give-up decision instead of grinding", async () => {
		const result = await runOperatorLoop(
			loopOptions({
				decide: async () => ({ type: "give_up", reason: "needs a password" }),
			})
		);
		expect(result.stoppedBy).toBe("gave_up");
		expect(result.summary).toBe("needs a password");
	});

	it("gives up after repeated action failures rather than looping on a broken target", async () => {
		const result = await runOperatorLoop(
			loopOptions({
				observe: async (i) => observation({ elementCount: i }),
				act: async () => {
					throw new Error("target not found");
				},
				errorLimit: 2,
				maxSteps: 10,
			})
		);
		expect(result.stoppedBy).toBe("repeated_errors");
		expect(result.steps).toHaveLength(2);
		expect(result.steps[1].error).toBe("target not found");
	});
});

describe("runReviewLoop", () => {
	it("accepts on the first clean pass", async () => {
		const result = await runReviewLoop({
			review: async () => ({ verdict: "accept", notes: "looks right" }),
		});
		expect(result).toEqual({
			passes: [{ verdict: "accept", notes: "looks right" }],
			accepted: true,
			stoppedBy: "accepted",
		});
	});

	it("re-exports then accepts, calling the regrade hook once", async () => {
		const onReExport = vi.fn(async () => {});
		const onReshoot = vi.fn(async () => {});
		const verdicts = [
			{ verdict: "re_export" as const, notes: "fps forced to 60 on a 58fps capture" },
			{ verdict: "accept" as const, notes: "matches the measured rate" },
		];
		const result = await runReviewLoop({
			review: async (pass) => verdicts[pass],
			onReExport,
			onReshoot,
		});
		expect(result.accepted).toBe(true);
		expect(onReExport).toHaveBeenCalledTimes(1);
		expect(onReshoot).not.toHaveBeenCalled();
	});

	it("hands the defect back after the pass budget is spent", async () => {
		const onReshoot = vi.fn(async () => {});
		const result = await runReviewLoop({
			review: async () => ({ verdict: "reshoot", notes: "window chrome fills the frame" }),
			onReshoot,
			maxPasses: 2,
		});
		expect(result.accepted).toBe(false);
		expect(result.stoppedBy).toBe("max_passes");
		expect(onReshoot).toHaveBeenCalledTimes(2);
	});
});

describe("createDirectorTeam", () => {
	const toolNames = {
		observe: "cap_observe",
		listWindows: "cap_list_windows",
		act: "cap_act",
		recordingStart: "cap_recording_start",
		recordingStop: "cap_recording_stop",
		applyStoryboard: "cap_apply_storyboard",
		exportVideo: "cap_export",
	};

	it("wires four roles and keeps the planner away from the machine", () => {
		const team = createDirectorTeam({ toolNames });
		expect(team.all.map((a) => a.name)).toEqual([
			"director-planner",
			"director-operator",
			"director-cinematographer",
			"director-reviewer",
		]);
		expect(team.planner.boundaries?.blockedTools).toContain("cap_act");
		expect(team.planner.tools).not.toContain("cap_act");
	});

	it("runs the operator on the computer-use model and requires approval for input", () => {
		const team = createDirectorTeam({ toolNames });
		expect(team.operator.model).toBe(OPENAI_COMPUTER_USE_MODEL);
		expect(team.operator.constraints?.requireApproval).toContain("cap_act");
		expect(team.operator.plugins?.some((p) => p.name === "approvals")).toBe(true);
		expect(team.operator.plugins?.some((p) => p.name === "security")).toBe(true);
	});

	it("respects a namespaced tool pack", () => {
		const team = createDirectorTeam({
			toolNames: { ...toolNames, act: "demo_act", observe: "demo_observe" },
		});
		expect(team.operator.tools).toContain("demo_act");
		expect(team.operator.constraints?.requireApproval).toContain("demo_act");
	});
});

describe("runOperatorLoop mid-step stops", () => {
	it("does not act once the kill switch engages while the model is deciding", async () => {
		const act = vi.fn(async () => actResult());
		let engaged = false;
		const result = await runOperatorLoop(
			loopOptions({
				act,
				isKillSwitchEngaged: () => engaged,
				decide: async () => {
					engaged = true;
					return { type: "act", action: CLICK };
				},
				maxSteps: 5,
			})
		);
		expect(act).not.toHaveBeenCalled();
		expect(result.stoppedBy).toBe("kill_switch");
		expect(result.steps).toHaveLength(1);
		expect(result.steps[0].result).toBeUndefined();
	});

	it("does not act once the caller aborts while the model is deciding", async () => {
		const act = vi.fn(async () => actResult());
		const controller = new AbortController();
		const result = await runOperatorLoop(
			loopOptions({
				act,
				signal: controller.signal,
				decide: async () => {
					controller.abort();
					return { type: "act", action: CLICK };
				},
				maxSteps: 5,
			})
		);
		expect(act).not.toHaveBeenCalled();
		expect(result.stoppedBy).toBe("aborted");
	});

	it("calls a stall at exactly stallLimit repeats and not one before", async () => {
		const stalled = vi.fn(async () => actResult());
		const stalledRun = await runOperatorLoop(
			loopOptions({ act: stalled, stallLimit: 3, maxSteps: 20 })
		);
		expect(stalledRun.stoppedBy).toBe("stalled");
		expect(stalled).toHaveBeenCalledTimes(3);

		const screens = [0, 0, 0, 1];
		const changing = vi.fn(async () => actResult());
		const changingRun = await runOperatorLoop(
			loopOptions({
				act: changing,
				observe: async (i) => observation({ elementCount: screens[i] ?? 9 }),
				stallLimit: 3,
				maxSteps: 4,
			})
		);
		expect(changingRun.stoppedBy).toBe("max_steps");
		expect(changing).toHaveBeenCalledTimes(4);
	});
});

describe("runReviewLoop indeterminate passes", () => {
	it("never converts a review that keeps throwing into an accept", async () => {
		const onReshoot = vi.fn(async () => {});
		const onReExport = vi.fn(async () => {});
		const onIndeterminate = vi.fn(async () => {});
		const result = await runReviewLoop({
			review: async () => {
				throw new Error("model returned garbage");
			},
			onReshoot,
			onReExport,
			onIndeterminate,
			maxPasses: 3,
		});
		expect(result.accepted).toBe(false);
		expect(result.stoppedBy).toBe("qa_failed");
		expect(result.passes).toEqual([]);
		expect(result.indeterminate).toHaveLength(3);
		expect(onIndeterminate).toHaveBeenCalledTimes(3);
		expect(onReshoot).not.toHaveBeenCalled();
		expect(onReExport).not.toHaveBeenCalled();
	});
});
