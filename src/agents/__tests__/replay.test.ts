import { describe, expect, it } from "vitest";
import {
	createInMemoryDesktopSessionStore,
	type DirectorClient,
} from "../tools/cap/client";
import { createCapToolPack } from "../tools/cap/tools";
import { denyAllGuard } from "../tools/cap/types";
import type {
	DirectorCommand,
	DirectorCommandResult,
	ObservationFrame,
	Rect,
	SessionLease,
	Storyboard,
	UiElement,
} from "../tools/cap/types";
import { NEUTRAL_CAMERA } from "../tools/cap/storyboard";
import {
	ReplayPlanError,
	buildReplayPlan,
	inspectShootRecord,
	queryForElement,
	renderReplayPlan,
	strongestCriterion,
} from "../replay/plan";
import type { ResolvedElement, ShootAction, ShootRecord } from "../replay/plan";
import { runReplay } from "../replay/run";
import { buildTimeWarp, diffReplay, renderReplayDiff } from "../replay/diff";
import {
	DEFAULT_REGRESSION_POLICY,
	STRICT_REGRESSION_POLICY,
	evaluateReplay,
	renderVerdict,
} from "../replay/verdict";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

function rect(x: number, y: number, width: number, height: number): Rect {
	return { x, y, width, height };
}

function makeLease(): SessionLease {
	return {
		sessionId: "sess-1",
		runId: "run-1",
		grantedScopes: {
			scopes: [
				"observe_screen",
				"control_pointer",
				"control_keyboard",
				"record",
				"edit",
				"export",
			],
		},
		guard: {
			...denyAllGuard(),
			allowedBundleIds: ["com.apple.Safari"],
			requireStepApproval: false,
		},
		startedAtUnixMs: NOW - 1_000,
		expiresAtUnixMs: NOW + 600_000,
	};
}

type ElementOverrides = Partial<UiElement> & { elementId: string; role: string };

function el(overrides: ElementOverrides): UiElement {
	return {
		title: null,
		value: null,
		identifier: null,
		bounds: rect(0, 0, 10, 10),
		enabled: true,
		focused: false,
		children: [],
		...overrides,
	};
}

function newProjectButton(overrides: Partial<UiElement> = {}): UiElement {
	return el({
		elementId: "el-new",
		role: "AXButton",
		title: "New Project",
		identifier: "new-project-button",
		bounds: rect(100, 200, 120, 32),
		...overrides,
	});
}

function nameField(overrides: Partial<UiElement> = {}): UiElement {
	return el({
		elementId: "el-name",
		role: "AXTextField",
		title: "Project name",
		identifier: "project-name",
		bounds: rect(100, 300, 240, 28),
		focused: true,
		...overrides,
	});
}

function saveButton(overrides: Partial<UiElement> = {}): UiElement {
	return el({
		elementId: "el-save",
		role: "AXButton",
		title: "Save",
		identifier: "save-button",
		bounds: rect(400, 600, 80, 32),
		...overrides,
	});
}

function unchangedScreen(): UiElement[] {
	return [newProjectButton(), nameField(), saveButton()];
}

function makeFrame(
	elements: UiElement[],
	maskedRegions: Rect[] = []
): ObservationFrame & { maskedRegions: Rect[] } {
	return {
		frameId: "frame-1",
		imageRef: "cap://frames/frame-1",
		width: 1920,
		height: 1080,
		capturedAtUnixMs: NOW,
		display: {
			displayId: "disp-1",
			width: 1920,
			height: 1080,
			scaleFactor: 2,
			isPrimary: true,
		},
		focusedWindow: {
			windowId: "win-1",
			bundleId: "com.apple.Safari",
			title: "Studio",
			bounds: rect(0, 0, 1440, 900),
		},
		elements,
		redactedWindows: [],
		maskedRegions,
	};
}

/** Element as the shoot recorded it, with its index among same-role siblings. */
function baselineOf(element: UiElement, ordinal: number): ResolvedElement {
	return {
		elementId: element.elementId,
		role: element.role,
		title: element.title ?? null,
		identifier: element.identifier ?? null,
		bounds: element.bounds,
		enabled: element.enabled,
		focused: element.focused,
		ordinal,
	};
}

const STORYBOARD: Storyboard = {
	version: 1,
	projectPath: "/tmp/demo.cap",
	sourceFps: 60,
	shots: [
		{
			shotId: "shot-1",
			sourceStartMs: 600,
			sourceEndMs: 3_600,
			camera: NEUTRAL_CAMERA,
			aimBeatId: "b1",
			transitionIn: "none",
			recordingSegment: 0,
			transitionDurationMs: 0,
		},
		{
			shotId: "shot-2",
			sourceStartMs: 3_600,
			sourceEndMs: 6_100,
			camera: NEUTRAL_CAMERA,
			aimBeatId: "b2",
			transitionIn: "cut",
			recordingSegment: 0,
			transitionDurationMs: 0,
		},
		{
			shotId: "shot-3",
			sourceStartMs: 6_100,
			sourceEndMs: 8_000,
			camera: NEUTRAL_CAMERA,
			aimBeatId: "b3",
			transitionIn: "cut",
			recordingSegment: 0,
			transitionDurationMs: 0,
		},
	],
	background: { type: "solid", hex: "#000000" },
	cursor: { synthesize: true, size: 1, smoothing: 0.7 },
	music: null,
	captions: null,
};

interface ShootOptions {
	/** Drop the accessibility identifiers, leaving role + title as the strongest handle. */
	withoutIdentifiers?: boolean;
	actions?: ShootAction[];
}

function makeShoot(options: ShootOptions = {}): ShootRecord {
	const strip = options.withoutIdentifiers === true;
	const newButton = newProjectButton(strip ? { identifier: null } : {});
	const field = nameField(strip ? { identifier: null } : {});
	const save = saveButton(strip ? { identifier: null } : {});

	const actions: ShootAction[] = options.actions ?? [
		{
			beatId: "b1",
			elapsedMs: 900,
			action: {
				type: "click",
				target: { type: "elementQuery", role: "AXButton", title: "New Project" },
				button: "left",
				clickCount: 1,
			},
			resolved: { target: baselineOf(newButton, 0) },
		},
		{
			beatId: "b2",
			elapsedMs: 2_400,
			action: { type: "typeText", text: "Hades", charsPerMinute: 400 },
			resolved: { focus: baselineOf(field, 0) },
		},
		{
			beatId: "b3",
			elapsedMs: 1_100,
			action: {
				type: "click",
				target: { type: "elementQuery", role: "AXButton", title: "Save" },
				button: "left",
				clickCount: 1,
			},
			resolved: { target: baselineOf(save, 1) },
		},
	];

	return {
		storyboard: STORYBOARD,
		durationMs: 8_000,
		measuredFps: 58.4,
		capture: { width: 1920, height: 1080 },
		beats: [
			{
				beatId: "b1",
				offsetMs: 1_000,
				kind: "action",
				label: "Click New Project",
				landmark: rect(0.05, 0.18, 0.06, 0.03),
			},
			{ beatId: "b2", offsetMs: 4_000, kind: "typing", label: "Type the project name" },
			{ beatId: "b3", offsetMs: 6_500, kind: "action", label: "Click Save" },
		],
		actions,
	};
}

// ── Harness ───────────────────────────────────────────────────────────────────

interface Harness {
	pack: ReturnType<typeof createCapToolPack>;
	sent: DirectorCommand[];
}

let packCounter = 0;

function makeHarness(frames: UiElement[][], options: { lease?: boolean; masked?: Rect[] } = {}): Harness {
	packCounter += 1;
	const store = createInMemoryDesktopSessionStore({ now: () => NOW });
	if (options.lease !== false) store.grantLease(makeLease());

	const sent: DirectorCommand[] = [];
	let observed = 0;
	const client: DirectorClient = {
		async send(command): Promise<DirectorCommandResult> {
			sent.push(command);
			switch (command.type) {
				case "observe": {
					const elements = frames[Math.min(observed, frames.length - 1)] ?? [];
					observed += 1;
					return { type: "observed", frame: makeFrame(elements, options.masked ?? []) };
				}
				case "act":
					return { type: "acted", beat: null };
				default:
					throw new Error(`unexpected command ${command.type}`);
			}
		},
	};

	const pack = createCapToolPack({
		client,
		sessions: store,
		namespace: `replay${packCounter}`,
		nowUnixMs: () => NOW,
	});
	return { pack, sent };
}

/** Deterministic clock: one value per `now()` call, holding the last value once exhausted. */
function clockFrom(values: number[]): () => number {
	let index = 0;
	return () => values[Math.min(index++, values.length - 1)];
}

/** `runReplay` calls now() once at the start, twice per step, and once at the end. */
const STEADY_CLOCK = () => clockFrom([0, 0, 1_000, 1_000, 4_000, 4_000, 6_500, 8_000]);
const SLOW_CLOCK = () => clockFrom([0, 0, 2_000, 2_000, 8_000, 8_000, 13_000, 16_000]);

async function replayAgainst(
	frames: UiElement[][],
	options: {
		shoot?: ShootRecord;
		/** Clock factory: each replay gets a fresh sequence of timestamps. */
		clock?: () => () => number;
		lease?: boolean;
		masked?: Rect[];
		continueAfterBreak?: boolean;
	} = {}
) {
	const shoot = options.shoot ?? makeShoot();
	const plan = buildReplayPlan(shoot);
	const harness = makeHarness(frames, { lease: options.lease, masked: options.masked });
	const run = await runReplay({
		pack: harness.pack,
		plan,
		sessionId: "sess-1",
		now: options.clock ? options.clock() : STEADY_CLOCK(),
		continueAfterBreak: options.continueAfterBreak,
	});
	return { plan, run, sent: harness.sent, diff: diffReplay(plan, run) };
}

// ── Plan ──────────────────────────────────────────────────────────────────────

describe("replay plan", () => {
	it("derives an element query from role, title and identifier, keeping the beat label as the anchor", () => {
		const plan = buildReplayPlan(makeShoot());

		expect(plan.steps.map((step) => step.stepId)).toEqual(["step-1", "step-2", "step-3"]);
		expect(plan.steps[0].label).toBe("Click New Project");
		expect(plan.steps[0].targets[0].query).toEqual({
			role: "AXButton",
			title: "New Project",
			identifier: "new-project-button",
			nth: 0,
		});
		expect(plan.steps[0].targets[0].criterion).toBe("identifier");
		expect(plan.steps[0].targets[0].required).toBe(true);

		// A typing beat carries a focus expectation that is verified, never clicked.
		expect(plan.steps[1].targets[0].slot).toBe("focus");
		expect(plan.steps[1].targets[0].required).toBe(false);

		expect(renderReplayPlan(plan)).toContain("identifier=new-project-button");
	});

	it("falls back to role + title when the shoot had no accessibility identifier", () => {
		const plan = buildReplayPlan(makeShoot({ withoutIdentifiers: true }));
		expect(plan.steps[0].targets[0].criterion).toBe("roleAndTitle");
	});

	it("refuses a plan whose step can only be reproduced from raw coordinates", () => {
		const shoot = makeShoot({
			actions: [
				{
					beatId: "b1",
					elapsedMs: 900,
					action: {
						type: "click",
						target: {
							type: "point",
							point: { x: 0.31, y: 0.42, space: "normalized_display" },
						},
						button: "left",
						clickCount: 1,
					},
				},
			],
		});

		const issues = inspectShootRecord(shoot);
		expect(issues.map((issue) => issue.code)).toContain("coordinate_only_target");
		expect(issues.every((issue) => issue.severity === "refusal")).toBe(true);

		expect(() => buildReplayPlan(shoot)).toThrow(ReplayPlanError);
		try {
			buildReplayPlan(shoot);
		} catch (error) {
			expect(error).toBeInstanceOf(ReplayPlanError);
			expect((error as ReplayPlanError).issues[0].code).toBe("coordinate_only_target");
			expect((error as ReplayPlanError).message).toContain("clicks whatever now sits there");
		}
	});

	it("refuses a session-scoped element handle, which is a coordinate by another name", () => {
		const shoot = makeShoot({
			actions: [
				{
					beatId: "b1",
					elapsedMs: 900,
					action: {
						type: "click",
						target: { type: "element", elementId: "el-4213" },
						button: "left",
						clickCount: 1,
					},
				},
			],
		});
		expect(() => buildReplayPlan(shoot)).toThrow(/element handle "el-4213"/);
	});

	it("refuses an element that carries no role, title or identifier at all", () => {
		const shoot = makeShoot({
			actions: [
				{
					beatId: "b1",
					elapsedMs: 900,
					action: {
						type: "click",
						target: { type: "elementQuery", role: "AXButton" },
						button: "left",
						clickCount: 1,
					},
					resolved: {
						target: { role: "", title: null, identifier: null, bounds: rect(0, 0, 1, 1) },
					},
				},
			],
		});
		expect(() => buildReplayPlan(shoot)).toThrow(ReplayPlanError);
		expect(strongestCriterion(queryForElement({ role: "", bounds: rect(0, 0, 1, 1) }))).toBeNull();
	});
});

// ── Drift classification ──────────────────────────────────────────────────────

describe("replay drift classification", () => {
	it("classifies an unchanged flow as matched and never sends a coordinate target", async () => {
		const { run, sent } = await replayAgainst([unchangedScreen()]);

		expect(run.status).toBe("matched");
		expect(run.steps.map((step) => step.status)).toEqual(["matched", "matched", "matched"]);

		const acted = sent.filter((command) => command.type === "act");
		expect(acted).toHaveLength(3);
		for (const command of acted) {
			if (command.type !== "act") continue;
			if (command.action.type === "click") {
				expect(command.action.target.type).toBe("element");
			}
		}
		expect(JSON.stringify(sent)).not.toContain("normalized_display");
	});

	it("classifies a renamed button as drift, not breakage, when the identifier still holds", async () => {
		const screen = [newProjectButton(), nameField(), saveButton({ title: "Save changes" })];
		const { run } = await replayAgainst([screen]);

		const step = run.steps[2];
		expect(step.status).toBe("drifted");
		expect(run.status).toBe("drifted");
		const target = step.targets[0];
		expect(target.criterion).toBe("identifier");
		expect(target.drift).toContain("renamed");
		expect(target.drift).not.toContain("weaker_match");
		expect(target.resolved?.title).toBe("Save changes");
		expect(target.breakage).toBeNull();
	});

	it("classifies a rename with no identifier as drift found by a weaker criterion", async () => {
		const shoot = makeShoot({ withoutIdentifiers: true });
		const screen = [
			newProjectButton({ identifier: null }),
			nameField({ identifier: null }),
			saveButton({ identifier: null, title: "Save changes" }),
		];
		const { run } = await replayAgainst([screen], { shoot });

		const target = run.steps[2].targets[0];
		expect(run.steps[2].status).toBe("drifted");
		expect(target.baselineCriterion).toBe("roleAndTitle");
		expect(target.criterion).toBe("roleAndOrder");
		expect(target.drift).toEqual(expect.arrayContaining(["weaker_match", "renamed"]));
	});

	it("classifies a moved-but-identical element as drift", async () => {
		const screen = [
			newProjectButton(),
			nameField(),
			saveButton({ bounds: rect(880, 600, 80, 32) }),
		];
		const { run, diff } = await replayAgainst([screen]);

		const target = run.steps[2].targets[0];
		expect(run.steps[2].status).toBe("drifted");
		expect(target.drift).toEqual(["moved"]);
		expect(target.boundsDelta).toEqual({ dx: 480, dy: 0, dWidth: 0, dHeight: 0 });

		// Capture geometry from protocol v1.2 turns the pixel delta into a share of the frame.
		const rendered = diff.steps[2].targets[0].description;
		expect(rendered).toContain("moved 480px, 0px");
		expect(rendered).toContain("25.0%");
	});

	it("classifies a removed button as breakage and refuses to re-find it by role alone", async () => {
		const screen = [newProjectButton(), nameField()];
		const { run } = await replayAgainst([unchangedScreen(), unchangedScreen(), screen]);

		expect(run.steps[2].status).toBe("broken");
		expect(run.steps[2].targets[0].breakage).toBe("unresolved");
		expect(run.steps[2].targets[0].resolved).toBeNull();
		expect(run.status).toBe("broken");
	});

	it("stops after breakage and reports the remaining steps as never attempted", async () => {
		const screen = [nameField(), saveButton()];
		const { run, diff } = await replayAgainst([screen]);

		expect(run.steps).toHaveLength(1);
		expect(run.steps[0].status).toBe("broken");
		expect(run.skippedStepIds).toEqual(["step-2", "step-3"]);
		expect(diff.summary).toMatchObject({ broken: 1, skipped: 2, matched: 0, drifted: 0 });
	});

	it("treats a disabled element as breakage, not drift", async () => {
		const screen = [newProjectButton(), nameField(), saveButton({ enabled: false })];
		const { run } = await replayAgainst([unchangedScreen(), unchangedScreen(), screen]);

		expect(run.steps[2].status).toBe("broken");
		expect(run.steps[2].targets[0].breakage).toBe("element_disabled");
	});

	it("treats a lost focus expectation as drift, because the flow still runs", async () => {
		const screen = [newProjectButton(), nameField({ focused: false }), saveButton()];
		const { run } = await replayAgainst([unchangedScreen(), screen, unchangedScreen()]);

		expect(run.steps[1].status).toBe("drifted");
		expect(run.steps[1].targets[0].drift).toContain("focus_lost");
	});

	it("reports an element hidden under a v1.2 masked region as unverifiable", async () => {
		const { run, diff } = await replayAgainst([unchangedScreen()], {
			masked: [rect(380, 580, 200, 80)],
		});

		expect(run.steps[2].targets[0].visuallyMasked).toBe(true);
		expect(diff.notes.join(" ")).toContain("masked region");
	});

	it("keeps enforcing the session lease inside execute, with no plugins involved", async () => {
		const { run, sent } = await replayAgainst([unchangedScreen()], { lease: false });

		expect(sent).toHaveLength(0);
		expect(run.steps[0].status).toBe("broken");
		expect(run.steps[0].targets[0].breakage).toBe("observation_failed");
		expect(run.steps[0].error).toContain("No session lease");
	});

	it("surfaces a truncated element list as its own breakage reason rather than a false negative", async () => {
		const filler = Array.from({ length: 80 }, (_, i) =>
			el({ elementId: `pad-${i}`, role: "AXStaticText", title: `pad ${i}` })
		);
		const { run } = await replayAgainst([filler]);

		expect(run.steps[0].targets[0].breakage).toBe("element_list_truncated");
	});
});

// ── Diff ──────────────────────────────────────────────────────────────────────

describe("replay diff", () => {
	it("keeps the projected cut inside its editorial limits when timing holds", async () => {
		const { diff } = await replayAgainst([unchangedScreen()]);

		expect(diff.editorial.baselineTotalMs).toBe(7_400);
		expect(diff.editorial.projectedTotalMs).toBe(7_400);
		expect(diff.editorial.withinLimits).toBe(true);
		expect(diff.editorial.issues).toEqual([]);
	});

	it("reports a replay that stretches the cut past the twelve-second limit", async () => {
		const { diff } = await replayAgainst([unchangedScreen()], { clock: SLOW_CLOCK });

		expect(diff.status).toBe("matched");
		expect(diff.editorial.projectedTotalMs).toBe(14_800);
		expect(diff.editorial.withinLimits).toBe(false);
		expect(diff.editorial.issues.map((issue) => issue.code)).toContain("total_too_long");
		expect(diff.timing.regressions.map((regression) => regression.stepId)).toEqual([
			"step-1",
			"step-2",
			"step-3",
		]);
		expect(renderReplayDiff(diff)).toContain("violated");
	});

	it("renders deterministically", async () => {
		const first = await replayAgainst([unchangedScreen()]);
		const second = await replayAgainst([unchangedScreen()]);
		expect(renderReplayDiff(first.diff)).toBe(renderReplayDiff(second.diff));
	});

	it("warps baseline time onto replay time monotonically", () => {
		const warp = buildTimeWarp([
			{ baselineMs: 0, replayMs: 0 },
			{ baselineMs: 1_000, replayMs: 2_000 },
			{ baselineMs: 4_000, replayMs: 1_500 },
			{ baselineMs: 8_000, replayMs: 9_000 },
		]);
		expect(warp(0)).toBe(0);
		expect(warp(1_000)).toBe(2_000);
		// The out-of-order anchor is pinned forward rather than dropped.
		expect(warp(4_000)).toBe(2_000);
		expect(warp(8_000)).toBe(9_000);
		expect(warp(2_500)).toBeGreaterThanOrEqual(warp(1_000));
	});
});

// ── Verdict ───────────────────────────────────────────────────────────────────

describe("regression verdict", () => {
	it("fails on breakage and passes drift through as a warning by default", async () => {
		const broken = await replayAgainst([[newProjectButton(), nameField()]], {
			shoot: makeShoot(),
			clock: STEADY_CLOCK,
		});
		const brokenVerdict = evaluateReplay(broken.diff);
		expect(brokenVerdict.status).toBe("fail");
		expect(brokenVerdict.exitCode).toBe(1);
		expect(brokenVerdict.findings.map((finding) => finding.code)).toContain("steps_broken");

		const drifted = await replayAgainst([
			[newProjectButton(), nameField(), saveButton({ title: "Save changes" })],
		]);
		const driftVerdict = evaluateReplay(drifted.diff);
		expect(driftVerdict.status).toBe("warn");
		expect(driftVerdict.exitCode).toBe(0);
		expect(driftVerdict.findings.map((finding) => finding.code)).toEqual(["steps_drifted"]);
		expect(renderVerdict(driftVerdict)).toContain("drift=warn");
	});

	it("fails on drift under the strict policy", async () => {
		const drifted = await replayAgainst([
			[newProjectButton(), nameField(), saveButton({ title: "Save changes" })],
		]);
		const verdict = evaluateReplay(drifted.diff, STRICT_REGRESSION_POLICY);
		expect(verdict.status).toBe("fail");
		expect(verdict.exitCode).toBe(1);
	});

	it("passes a broken replay when the policy explicitly ignores breakage", async () => {
		const broken = await replayAgainst([[newProjectButton(), nameField()]]);
		const verdict = evaluateReplay(broken.diff, {
			...DEFAULT_REGRESSION_POLICY,
			onBroken: "ignore",
			onSkipped: "ignore",
			onEditorial: "ignore",
		});
		expect(verdict.status).toBe("pass");
		expect(verdict.exitCode).toBe(0);
		expect(verdict.findings).toEqual([]);
		expect(renderVerdict(verdict)).toContain("breakage=ignore");
	});

	it("escalates drift to a failure once it exceeds the configured budget", async () => {
		const drifted = await replayAgainst([
			[
				newProjectButton({ title: "Start a project" }),
				nameField(),
				saveButton({ title: "Save changes" }),
			],
		]);
		expect(drifted.diff.summary.drifted).toBe(2);

		const lenient = evaluateReplay(drifted.diff, {
			...DEFAULT_REGRESSION_POLICY,
			maxDriftedSteps: 2,
		});
		expect(lenient.status).toBe("warn");

		const strictBudget = evaluateReplay(drifted.diff, {
			...DEFAULT_REGRESSION_POLICY,
			maxDriftedSteps: 1,
		});
		expect(strictBudget.status).toBe("fail");
		expect(strictBudget.findings.map((finding) => finding.code)).toContain(
			"drift_budget_exceeded"
		);
	});

	it("fails when the projected cut no longer fits, even with every step intact", async () => {
		const { diff } = await replayAgainst([unchangedScreen()], { clock: SLOW_CLOCK });
		const verdict = evaluateReplay(diff);
		expect(diff.status).toBe("matched");
		expect(verdict.status).toBe("fail");
		expect(verdict.findings.map((finding) => finding.code)).toEqual(["editorial_violated"]);
	});

	it("carries the policy it was judged under", async () => {
		const { diff } = await replayAgainst([unchangedScreen()]);
		const verdict = evaluateReplay(diff);
		expect(verdict.status).toBe("pass");
		expect(verdict.policy).toEqual(DEFAULT_REGRESSION_POLICY);
		expect(renderVerdict(verdict)).toContain("nothing drifted, nothing broke.");
	});
});

describe("replay audit", () => {
	it("refuses a fallback candidate that carries a different identifier", async () => {
		const screen = [newProjectButton(), nameField(), saveButton({ identifier: "save-button-v2" })];
		const { run } = await replayAgainst([unchangedScreen(), unchangedScreen(), screen]);

		expect(run.steps[2].status).toBe("broken");
		expect(run.steps[2].targets[0].breakage).toBe("unresolved");
		expect(run.steps[2].targets[0].resolved).toBeNull();
	});

	it("degrades the time warp gracefully with zero, one and duplicate anchors", () => {
		const identity = buildTimeWarp([]);
		expect(identity(0)).toBe(0);
		expect(identity(4_321)).toBe(4_321);

		const shifted = buildTimeWarp([{ baselineMs: 1_000, replayMs: 1_500 }]);
		expect(shifted(0)).toBe(500);
		expect(shifted(1_000)).toBe(1_500);
		expect(shifted(8_000)).toBe(8_500);

		const duplicated = buildTimeWarp([
			{ baselineMs: 0, replayMs: 0 },
			{ baselineMs: 0, replayMs: 900 },
			{ baselineMs: 8_000, replayMs: 8_000 },
		]);
		for (const ms of [0, 1, 4_000, 8_000, 9_000]) expect(Number.isFinite(duplicated(ms))).toBe(true);
		expect(duplicated(4_000)).toBeGreaterThanOrEqual(duplicated(1));
	});

	it("honours a policy that ignores every category", async () => {
		const { diff } = await replayAgainst([[nameField(), saveButton()]], { clock: SLOW_CLOCK });
		expect(diff.summary.broken).toBe(1);
		expect(diff.summary.skipped).toBe(2);

		const lenient = evaluateReplay(diff, {
			onBroken: "ignore",
			onDrift: "ignore",
			onEditorial: "ignore",
			onTimingRegression: "ignore",
			onSkipped: "ignore",
			maxDriftedSteps: null,
		});
		expect(lenient.status).toBe("pass");
		expect(lenient.exitCode).toBe(0);
		expect(lenient.findings).toEqual([]);

		const strict = evaluateReplay(diff, STRICT_REGRESSION_POLICY);
		expect(strict.status).toBe("fail");
		expect(strict.findings.map((finding) => finding.code)).toContain("steps_broken");
	});
});
