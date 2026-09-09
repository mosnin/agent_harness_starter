import { describe, expect, it } from "vitest";
import {
	createCapToolPack,
	observationFingerprint,
	summarizeFrame,
} from "../tools/cap/tools";
import type { ObservationSummary } from "../tools/cap/tools";
import {
	createInMemoryDesktopSessionStore,
	type DesktopSessionStore,
	type DirectorClient,
} from "../tools/cap/client";
import { DesktopAuthorizationError } from "../tools/cap/authorization";
import {
	InputActionSchema,
	StoryboardSchema,
	TargetSchema,
	denyAllGuard,
	requiredScopesForCommand,
	scopeForAction,
	type CapScope,
	type DirectorCommand,
	type DirectorCommandResult,
	type ObservationFrame,
	type SessionLease,
	type Storyboard,
} from "../tools/cap/types";
import { getTool } from "../tools/registry";
import { NEUTRAL_CAMERA } from "../tools/cap/storyboard";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

function makeLease(overrides: Partial<SessionLease> = {}): SessionLease {
	return {
		sessionId: "sess-1",
		runId: "run-1",
		grantedScopes: {
			scopes: ["observe_screen", "control_pointer", "control_keyboard", "record", "edit", "export"],
		},
		guard: {
			...denyAllGuard(),
			allowedBundleIds: ["com.apple.Safari"],
			redactedTitlePatterns: ["1Password"],
			requireStepApproval: false,
		},
		startedAtUnixMs: NOW - 1_000,
		expiresAtUnixMs: NOW + 600_000,
		...overrides,
	};
}

function makeFrame(overrides: Partial<ObservationFrame> = {}): ObservationFrame {
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
			title: "Cap — Safari",
			bounds: { x: 0, y: 0, width: 1440, height: 900 },
		},
		elements: [],
		maskedRegions: [],
		redactedWindows: [],
		...overrides,
	};
}

interface Recorder {
	client: DirectorClient;
	sent: DirectorCommand[];
}

function makeClient(
	reply: (command: DirectorCommand) => DirectorCommandResult | Promise<DirectorCommandResult>
): Recorder {
	const sent: DirectorCommand[] = [];
	return {
		sent,
		client: {
			async send(command) {
				sent.push(command);
				return reply(command);
			},
		},
	};
}

let packCounter = 0;

function makePack(
	options: {
		reply?: (command: DirectorCommand) => DirectorCommandResult | Promise<DirectorCommandResult>;
		lease?: SessionLease | null;
	} = {}
) {
	packCounter += 1;
	const store: DesktopSessionStore = createInMemoryDesktopSessionStore({ now: () => NOW });
	if (options.lease !== null) store.grantLease(options.lease ?? makeLease());

	const outcomes: Array<{ sessionId: string; outcome: "ok" | "failed" }> = [];
	const recorder = makeClient(
		options.reply ?? (() => ({ type: "observed", frame: makeFrame() }) as DirectorCommandResult)
	);

	const pack = createCapToolPack({
		client: recorder.client,
		sessions: store,
		namespace: `capt${packCounter}`,
		nowUnixMs: () => NOW,
		onCommandOutcome: (sessionId, outcome) => outcomes.push({ sessionId, outcome }),
	});

	return { pack, store, sent: recorder.sent, outcomes };
}

async function expectDenied(promise: Promise<unknown>, capCode: string) {
	await expect(promise).rejects.toBeInstanceOf(DesktopAuthorizationError);
	await promise.catch((error: unknown) => {
		expect((error as DesktopAuthorizationError).capCode).toBe(capCode);
	});
}

// ── Schemas ───────────────────────────────────────────────────────────────────

describe("cap wire schemas", () => {
	it("models InputAction as a discriminated union, not a loose object", () => {
		const click = InputActionSchema.parse({
			type: "click",
			target: { type: "elementQuery", role: "AXButton", title: "Continue" },
			button: "left",
			clickCount: 1,
		});
		expect(click.type).toBe("click");

		expect(InputActionSchema.safeParse({ type: "teleport", x: 1 }).success).toBe(false);
		expect(
			InputActionSchema.safeParse({
				type: "click",
				target: { type: "point", point: { x: 0.5, y: 0.5, space: "normalized_display" } },
				button: "left",
				clickCount: -1,
			}).success
		).toBe(false);
	});

	it("camelCases every wire field, including inside tagged-union variants", () => {
		expect(TargetSchema.safeParse({ type: "element", elementId: "el-1" }).success).toBe(true);
		expect(TargetSchema.safeParse({ type: "element", element_id: "el-1" }).success).toBe(false);
		expect(InputActionSchema.safeParse({ type: "wait", durationMs: 10 }).success).toBe(true);
		expect(InputActionSchema.safeParse({ type: "wait", duration_ms: 10 }).success).toBe(false);
	});

	it("maps each action to its least-privilege scope", () => {
		const cases: Array<[string, CapScope]> = [
			["moveTo", "control_pointer"],
			["typeText", "control_keyboard"],
			["launchApplication", "control_applications"],
			["wait", "observe_screen"],
		];
		const actions: Record<string, unknown> = {
			moveTo: { type: "moveTo", target: { type: "element", elementId: "e" }, durationMs: 200 },
			typeText: { type: "typeText", text: "hi", charsPerMinute: 400 },
			launchApplication: {
				type: "launchApplication",
				bundleId: "com.apple.Safari",
				waitForWindowMs: 3000,
			},
			wait: { type: "wait", durationMs: 10 },
		};
		for (const [name, scope] of cases) {
			expect(scopeForAction(InputActionSchema.parse(actions[name]))).toBe(scope);
		}
	});

	it("derives command scopes the way the Rust Command::required_scopes does", () => {
		const commands: DirectorCommand[] = [
			{ type: "observe", request: { includeElements: false } },
			{ type: "listWindows" },
			{ type: "recordingStop" },
			{
				type: "export",
				request: { projectPath: "/a.cap", outputPath: "/a.mp4", resolution: "source" },
			},
		];
		expect(commands.map(requiredScopesForCommand)).toEqual([
			["observe_screen"],
			["observe_screen"],
			["record"],
			["export"],
		]);
	});
});

// ── Registry hygiene ──────────────────────────────────────────────────────────

describe("createCapToolPack registration", () => {
	it("gives each pack instance distinct tool names so one does not overwrite the other", () => {
		const a = makePack();
		const b = makePack();
		expect(a.pack.observe.name).not.toBe(b.pack.observe.name);
		expect(getTool(a.pack.observe.name)).toBe(a.pack.observe);
		expect(getTool(b.pack.observe.name)).toBe(b.pack.observe);
	});

	it("marks intrusive tools as requiring approval", () => {
		const { pack } = makePack();
		expect(pack.act.requiresApproval).toBe(true);
		expect(pack.recordingStart.requiresApproval).toBe(true);
		expect(pack.observe.requiresApproval).toBeUndefined();
	});
});

// ── Observation ───────────────────────────────────────────────────────────────

describe("observation results", () => {
	it("returns a frame reference and never inline image bytes", async () => {
		const { pack, sent } = makePack({
			reply: () => ({
				type: "observed",
				frame: makeFrame({
					elements: Array.from({ length: 80 }, (_, i) => ({
						elementId: `el-${i}`,
						role: "AXButton",
						title: "x".repeat(400),
						value: null,
						identifier: null,
						bounds: { x: 0, y: 0, width: 10, height: 10 },
						enabled: true,
						focused: false,
						children: [],
					})),
				}),
			}),
		});

		const result = await pack.observe.execute(
			{ sessionId: "sess-1", request: { includeElements: true } },
			{}
		);

		expect(sent).toHaveLength(1);
		expect(result.imageRef).toBe("cap://frames/frame-1");
		expect(JSON.stringify(result)).not.toContain("data:image");
		expect(result.elementCount).toBe(80);
		expect(result.elements).toHaveLength(60);
		expect(result.elementsTruncated).toBe(true);
		expect(result.elements[0].title?.length).toBeLessThanOrEqual(121);
	});

	it("refuses an inline base64 frame from the runner", () => {
		expect(() =>
			summarizeFrame("sess-1", makeFrame({ imageRef: "data:image/png;base64,AAAA" }), 10)
		).toThrow(DesktopAuthorizationError);
	});

	it("fingerprints screen content, not the per-capture frame id", () => {
		const base = summarizeFrame("sess-1", makeFrame(), 10);
		const sameScreen = summarizeFrame(
			"sess-1",
			makeFrame({ frameId: "frame-2", imageRef: "cap://frames/frame-2", capturedAtUnixMs: NOW + 5 }),
			10
		);
		const different = summarizeFrame(
			"sess-1",
			makeFrame({
				focusedWindow: {
					windowId: "win-2",
					bundleId: "com.apple.Safari",
					title: "Other",
					bounds: { x: 0, y: 0, width: 10, height: 10 },
				},
			}),
			10
		);
		expect(observationFingerprint(base)).toBe(observationFingerprint(sameScreen));
		expect(observationFingerprint(base)).not.toBe(observationFingerprint(different as ObservationSummary));
	});

	it("withholds windows whose titles match the guard's redaction patterns", async () => {
		const { pack } = makePack({
			reply: () => ({
				type: "windows",
				redacted: [],
				windows: [
					{
						windowId: "w1",
						bundleId: "com.apple.Safari",
						title: "Cap — Safari",
						bounds: { x: 0, y: 0, width: 1, height: 1 },
					},
					{
						windowId: "w2",
						bundleId: "com.agilebits.onepassword",
						title: "My 1Password Vault",
						bounds: { x: 0, y: 0, width: 1, height: 1 },
					},
				],
			}),
		});

		const result = await pack.listWindows.execute({ sessionId: "sess-1" }, {});
		expect(result.count).toBe(1);
		expect(result.windows[0].windowId).toBe("w1");
	});
});

// ── Deny paths — these run inside execute, with no plugins involved ────────────

describe("tool-level authorization", () => {
	it("denies every command when there is no session lease, without calling the client", async () => {
		const { pack, sent } = makePack({ lease: null });
		await expectDenied(
			pack.observe.execute({ sessionId: "sess-1", request: { includeElements: false } }, {}),
			"no_active_session"
		);
		expect(sent).toHaveLength(0);
	});

	it("denies a command whose scope the lease does not grant", async () => {
		const { pack, sent } = makePack({
			lease: makeLease({ grantedScopes: { scopes: ["observe_screen"] } }),
		});
		await expectDenied(
			pack.act.execute(
				{
					sessionId: "sess-1",
					action: { type: "typeText", text: "hello", charsPerMinute: 400 },
				},
				{}
			),
			"scope_denied"
		);
		expect(sent).toHaveLength(0);
	});

	it("denies an expired lease", async () => {
		const { pack } = makePack({ lease: makeLease({ expiresAtUnixMs: NOW - 1 }) });
		await expectDenied(
			pack.observe.execute({ sessionId: "sess-1", request: { includeElements: false } }, {}),
			"session_expired"
		);
	});

	it("denies everything once the kill switch is engaged", async () => {
		const { pack, store, sent } = makePack();
		store.engageKillSwitch("sess-1");
		await expectDenied(
			pack.observe.execute({ sessionId: "sess-1", request: { includeElements: false } }, {}),
			"no_active_session"
		);
		expect(sent).toHaveLength(0);
	});

	it("denies an application outside the guard's allow list", async () => {
		const { pack } = makePack({
			lease: makeLease({
				grantedScopes: { scopes: ["observe_screen", "control_applications"] },
			}),
		});
		await expectDenied(
			pack.act.execute(
				{
					sessionId: "sess-1",
					action: {
						type: "launchApplication",
						bundleId: "com.apple.Terminal",
						waitForWindowMs: 2000,
					},
				},
				{}
			),
			"application_not_allowed"
		);
	});

	it("requires a granted per-step approval when the guard demands one", async () => {
		const { pack, store } = makePack({
			lease: makeLease({ guard: { ...denyAllGuard(), allowedBundleIds: ["com.apple.Safari"] } }),
		});
		const action = {
			type: "click" as const,
			target: { type: "element" as const, elementId: "el-1" },
			button: "left" as const,
			clickCount: 1,
		};

		await expectDenied(
			pack.act.execute({ sessionId: "sess-1", action }, {}),
			"approval_required"
		);
		await expectDenied(
			pack.act.execute({ sessionId: "sess-1", action, approvalId: "ap-1" }, {}),
			"approval_required"
		);

		store.approveStep("sess-1", "ap-1");
		const packWithBeat = makePack({
			lease: makeLease({ guard: { ...denyAllGuard(), allowedBundleIds: ["com.apple.Safari"] } }),
			reply: () => ({ type: "acted", beat: null }),
		});
		packWithBeat.store.approveStep("sess-1", "ap-1");
		const result = await packWithBeat.pack.act.execute(
			{ sessionId: "sess-1", action, approvalId: "ap-1" },
			{}
		);
		expect(result.scope).toBe("control_pointer");
	});

	it("records command outcomes so governance counters can see failures", async () => {
		const { pack, outcomes } = makePack({
			reply: () => {
				throw new Error("runner exploded");
			},
		});
		await expect(
			pack.observe.execute({ sessionId: "sess-1", request: { includeElements: false } }, {})
		).rejects.toThrow("runner exploded");
		expect(outcomes).toEqual([{ sessionId: "sess-1", outcome: "failed" }]);
	});
});

// ── Storyboard gate ───────────────────────────────────────────────────────────

describe("apply_storyboard", () => {
	function storyboard(overrides: Partial<Storyboard> = {}): Storyboard {
		return StoryboardSchema.parse({
			version: 1,
			projectPath: "/tmp/demo.cap",
			sourceFps: 60,
			shots: [
				{
					shotId: "s1",
					sourceStartMs: 0,
					sourceEndMs: 4_000,
					camera: NEUTRAL_CAMERA,
					aimBeatId: null,
					transitionIn: "none",
					recordingSegment: 0,
					transitionDurationMs: 0,
				},
			],
			background: { type: "solid", hex: "#000000" },
			cursor: { synthesize: true, size: 1, smoothing: 0.7 },
			music: null,
			captions: null,
			...overrides,
		});
	}

	it("applies a storyboard inside the editorial limits", async () => {
		const { pack, sent } = makePack({
			reply: () => ({ type: "storyboardApplied", projectPath: "/tmp/demo.cap" }),
		});
		const result = await pack.applyStoryboard.execute(
			{ sessionId: "sess-1", storyboard: storyboard() },
			{}
		);
		expect(result).toEqual({ projectPath: "/tmp/demo.cap", shotCount: 1 });
		expect(sent).toHaveLength(1);
	});

	it("rejects an over-long storyboard before it reaches the runner", async () => {
		const { pack, sent } = makePack({
			reply: () => ({ type: "storyboardApplied", projectPath: "/tmp/demo.cap" }),
		});
		await expect(
			pack.applyStoryboard.execute(
				{
					sessionId: "sess-1",
					storyboard: storyboard({
						shots: [
							{
								shotId: "s1",
								sourceStartMs: 0,
								sourceEndMs: 30_000,
								camera: NEUTRAL_CAMERA,
								aimBeatId: null,
								transitionIn: "none",
								recordingSegment: 0,
								transitionDurationMs: 0,
							},
						],
					}),
				},
				{}
			)
		).rejects.toThrow(/editorial limits/i);
		expect(sent).toHaveLength(0);
	});
});
