import { describe, expect, it } from "vitest";
import {
	BackgroundSchema,
	CaptureTargetSchema,
	CommandResultSchema,
	CommandSchema,
	EnvelopeSchema,
	PROTOCOL_MAJOR,
	PROTOCOL_VERSION,
	RunnerEventSchema,
	TargetSchema,
	commandRequiresActiveSession,
	denyAllGuard,
	envelopeJsonSchema,
	isCompatibleProtocol,
	isIntrusiveScope,
	parseEnvelopeFrame,
	protocolMajor,
	requiredScopeForAction,
	requiredScopesForCommand,
	safeParseEnvelope,
	scopeSet,
} from "@/agents/runner/protocol";

const clickCommandEnvelope = {
	kind: "command",
	id: "cmd-1",
	token: "jwt",
	command: {
		type: "act",
		action: {
			type: "click",
			target: { type: "elementQuery", role: "AXButton", title: "Continue", identifier: null, nth: null },
			button: "left",
			clickCount: 1,
		},
		beatLabel: "click continue",
	},
};

describe("protocol version", () => {
	it("matches the Rust constants", () => {
		expect(PROTOCOL_VERSION).toBe("1.0.0");
		expect(PROTOCOL_MAJOR).toBe(1);
		expect(protocolMajor("1.4.2")).toBe(1);
		expect(protocolMajor("2.0.0")).toBe(2);
		expect(protocolMajor("garbage")).toBeNull();
		expect(isCompatibleProtocol("1.9.0")).toBe(true);
		expect(isCompatibleProtocol("2.0.0")).toBe(false);
	});
});

describe("envelope acceptance", () => {
	it("accepts the command envelope from the Rust roundtrip test", () => {
		expect(EnvelopeSchema.safeParse(clickCommandEnvelope).success).toBe(true);
	});

	it("accepts the progress event envelope from the Rust roundtrip test", () => {
		const parsed = EnvelopeSchema.safeParse({
			kind: "event",
			event: { type: "progress", sessionId: "s-1", stage: "export", fraction: 0.5, detail: null },
		});
		expect(parsed.success).toBe(true);
	});

	it("accepts every command result variant shape", () => {
		const reply = {
			kind: "reply",
			id: "cmd-2",
			result: { type: "storyboardApplied", projectPath: "/tmp/a.cap" },
		};
		expect(EnvelopeSchema.safeParse(reply).success).toBe(true);
	});

	it("accepts a failure envelope", () => {
		const failure = {
			kind: "failure",
			id: "cmd-3",
			error: { code: "permission_missing", message: "Accessibility is off", remediation: "Open Settings" },
		};
		expect(EnvelopeSchema.safeParse(failure).success).toBe(true);
	});
});

describe("every wire key is camelCase", () => {
	// Container-level rename_all on a Rust enum renames VARIANTS, not the fields of struct
	// variants — each variant must repeat the attribute. Seven variants across five enums were
	// missing it and leaked snake_case keys; they now carry it, and the crate has a test that
	// rejects any serialized key containing an underscore. These lock the TS mirror to that.
	it("Command::Handshake carries protocolVersion", () => {
		expect(CommandSchema.safeParse({ type: "handshake", protocolVersion: "1.0.0" }).success).toBe(true);
		expect(CommandSchema.safeParse({ type: "handshake", protocol_version: "1.0.0" }).success).toBe(false);
	});

	it("Target::Element carries elementId", () => {
		expect(TargetSchema.safeParse({ type: "element", elementId: "e1" }).success).toBe(true);
		expect(TargetSchema.safeParse({ type: "element", element_id: "e1" }).success).toBe(false);
	});

	it("InputAction::Wait carries durationMs, like every other action", () => {
		expect(CommandSchema.safeParse({ type: "act", action: { type: "wait", durationMs: 10 } }).success).toBe(true);
		expect(CommandSchema.safeParse({ type: "act", action: { type: "wait", duration_ms: 10 } }).success).toBe(false);
		expect(
			CommandSchema.safeParse({
				type: "act",
				action: { type: "moveTo", target: { type: "element", elementId: "e1" }, durationMs: 200 },
			}).success,
		).toBe(true);
	});

	it("RunnerEvent::Heartbeat carries unixMs", () => {
		expect(RunnerEventSchema.safeParse({ type: "heartbeat", unixMs: 1 }).success).toBe(true);
		expect(RunnerEventSchema.safeParse({ type: "heartbeat", unix_ms: 1 }).success).toBe(false);
	});

	it("CommandResult::StoryboardApplied carries projectPath", () => {
		expect(CommandResultSchema.safeParse({ type: "storyboardApplied", projectPath: "/a.cap" }).success).toBe(true);
		expect(CommandResultSchema.safeParse({ type: "storyboardApplied", project_path: "/a.cap" }).success).toBe(false);
	});

	it("CaptureTarget carries displayId / windowId", () => {
		expect(CaptureTargetSchema.safeParse({ type: "display", displayId: "d1" }).success).toBe(true);
		expect(CaptureTargetSchema.safeParse({ type: "display", display_id: "d1" }).success).toBe(false);
		expect(CaptureTargetSchema.safeParse({ type: "window", windowId: "w1" }).success).toBe(true);
		expect(
			CaptureTargetSchema.safeParse({
				type: "area",
				displayId: "d1",
				bounds: { x: 0, y: 0, width: 10, height: 10 },
			}).success,
		).toBe(true);
	});

	it("Background::Gradient carries fromHex / toHex", () => {
		expect(BackgroundSchema.safeParse({ type: "gradient", fromHex: "#000", toHex: "#fff" }).success).toBe(true);
		expect(BackgroundSchema.safeParse({ type: "gradient", from_hex: "#000", to_hex: "#fff" }).success).toBe(false);
	});

	it("no schema key in the whole envelope contract contains an underscore", () => {
		const schema = envelopeJsonSchema();
		const offenders: string[] = [];
		const walk = (node: unknown, path: string): void => {
			if (Array.isArray(node)) {
				node.forEach((item, i) => walk(item, `${path}[${i}]`));
				return;
			}
			if (!node || typeof node !== "object") return;
			for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
				if (key === "properties" && value && typeof value === "object") {
					for (const property of Object.keys(value as Record<string, unknown>)) {
						if (property.includes("_")) offenders.push(`${path}.${property}`);
					}
				}
				walk(value, `${path}.${key}`);
			}
		};
		walk(schema, "$");
		expect(offenders).toEqual([]);
	});

	it("Envelope discriminates on kind, everything else on type", () => {
		expect(EnvelopeSchema.safeParse({ ...clickCommandEnvelope, kind: undefined, type: "command" }).success).toBe(
			false,
		);
	});
});

describe("envelope rejection — this is a security boundary", () => {
	it("rejects an unknown envelope kind", () => {
		const result = safeParseEnvelope({ kind: "sneak", id: "x" });
		expect(result.ok).toBe(false);
	});

	it("rejects an unknown command type", () => {
		expect(safeParseEnvelope({ kind: "command", id: "1", token: "t", command: { type: "rm_rf" } }).ok).toBe(false);
	});

	it("rejects an unknown scope", () => {
		expect(
			safeParseEnvelope({
				kind: "command",
				id: "1",
				token: "t",
				command: {
					type: "sessionStart",
					runId: "r",
					requestedScopes: { scopes: ["root_shell"] },
					guard: denyAllGuard(),
				},
			}).ok,
		).toBe(false);
	});

	it("rejects a missing required field", () => {
		expect(safeParseEnvelope({ kind: "reply", id: "1" }).ok).toBe(false);
	});

	it("rejects a wrong-typed field", () => {
		expect(
			safeParseEnvelope({
				kind: "command",
				id: "1",
				token: "t",
				command: { type: "act", action: { type: "typeText", text: "hi", charsPerMinute: "fast" } },
			}).ok,
		).toBe(false);
	});

	it("rejects a fraction outside 0..1", () => {
		expect(
			RunnerEventSchema.safeParse({ type: "progress", sessionId: "s", stage: "x", fraction: 1.5 }).success,
		).toBe(false);
	});

	it("rejects non-JSON and non-object frames", () => {
		expect(parseEnvelopeFrame("not json").ok).toBe(false);
		expect(parseEnvelopeFrame("null").ok).toBe(false);
		expect(parseEnvelopeFrame('"a string"').ok).toBe(false);
	});

	it("strips unknown keys rather than trusting them", () => {
		const parsed = EnvelopeSchema.safeParse({ ...clickCommandEnvelope, injected: "payload" });
		expect(parsed.success).toBe(true);
		if (parsed.success) expect("injected" in parsed.data).toBe(false);
	});

	it("returns a ProtocolError describing the failure", () => {
		const result = safeParseEnvelope({ kind: "failure", id: "1", error: { code: "nope", message: "m" } });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("internal");
			expect(result.error.message).toContain("Malformed envelope");
		}
	});
});

describe("scope derivation mirrors the Rust impls", () => {
	it("maps input actions to least-privilege scopes", () => {
		expect(requiredScopeForAction({ type: "typeText", text: "hi", charsPerMinute: 400 })).toBe("control_keyboard");
		expect(
			requiredScopeForAction({ type: "launchApplication", bundleId: "com.apple.Safari", waitForWindowMs: 3000 }),
		).toBe("control_applications");
		expect(requiredScopeForAction({ type: "wait", durationMs: 10 })).toBe("observe_screen");
	});

	it("gives lifecycle commands no scopes and work commands theirs", () => {
		const handshake = { type: "handshake", protocolVersion: PROTOCOL_VERSION } as const;
		expect(requiredScopesForCommand(handshake)).toEqual([]);
		expect(commandRequiresActiveSession(handshake)).toBe(false);

		const exportCmd = {
			type: "export",
			request: { projectPath: "/tmp/a.cap", outputPath: "/tmp/a.mp4", fps: null, resolution: "source" },
		} as const;
		expect(requiredScopesForCommand(exportCmd)).toEqual(["export"]);
		expect(commandRequiresActiveSession(exportCmd)).toBe(true);
	});

	it("dedupes and sorts scope sets and reports intrusive scopes", () => {
		const set = scopeSet(["observe_screen", "control_pointer", "observe_screen"]);
		expect(set.scopes).toEqual(["control_pointer", "observe_screen"]);
		expect(isIntrusiveScope("control_pointer")).toBe(true);
		expect(isIntrusiveScope("observe_screen")).toBe(false);
	});

	it("defaults the guard to denying every application", () => {
		const guard = denyAllGuard();
		expect(guard.allowedBundleIds).toEqual([]);
		expect(guard.requireStepApproval).toBe(true);
	});
});

describe("json schema export", () => {
	it("produces a JSON Schema for the envelope", () => {
		const schema = envelopeJsonSchema();
		expect(Object.keys(schema)).toContain("oneOf");
		expect(Array.isArray(schema.oneOf)).toBe(true);
	});
});
