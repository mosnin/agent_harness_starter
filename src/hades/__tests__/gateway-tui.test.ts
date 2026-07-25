import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GatewayTuiSession,
  mirrorEventToTrafficRow,
  probesToPaneRows,
  type GatewayTuiTimers,
} from "../cli/gateway-tui";
import { InMemoryConnector } from "../gateway/in-memory-connector";
import { RateLimiter } from "../gateway/rate-limiter";
import { BadgeStamper, type BadgeEvidence } from "../gateway/badge";
import type { PlatformProbe } from "../gateway/process";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";
import type { GateDecision } from "../styx/gate";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  type CertificatePayload,
  type VerificationCertificate,
} from "../styx/certificate";

// ---------------------------------------------------------------------------
// fixtures — same conventions as gateway-badge.test.ts
// ---------------------------------------------------------------------------

const TRACE_JSON = JSON.stringify({ steps: [{ tool: "exec", ok: true }] });

function fixedRng(fill: number): (bytes: number) => Uint8Array {
  return (bytes: number) => new Uint8Array(bytes).fill(fill);
}

function makePayload(outputText: string, overrides: Partial<CertificatePayload> = {}): CertificatePayload {
  return {
    outputSha256: sha256Hex(outputText),
    taskId: "goal-tui-0001",
    verifierTier: "T2-genrm",
    ensembleScore: 0.93,
    pCorrect: 0.965,
    epsilon: 0.02,
    traceSha256: sha256Hex(TRACE_JSON),
    verifierVersions: ["exec-oracle@1.2.0"],
    issuedAt: 1_753_315_200_000,
    ...overrides,
  };
}

async function issueCert(outputText: string): Promise<VerificationCertificate> {
  const ca = new CertificateAuthority(generatePrivateKeyHex(fixedRng(7)));
  return ca.issue(makePayload(outputText));
}

function emitDecision(overrides: Partial<GateDecision> = {}): GateDecision {
  return { emit: true, score: 0.93, threshold: 0.9, pCorrectEstimate: 0.965, ...overrides };
}

function abstainDecision(overrides: Partial<GateDecision> = {}): GateDecision {
  return { emit: false, score: 0.62, threshold: 0.9, pCorrectEstimate: 0, ...overrides };
}

/** A counting, manually-tickable fake timer surface — no real scheduling ever happens in this suite. */
function makeFakeTimers(): GatewayTuiTimers & {
  tick: () => void;
  setCount: number;
  clearCount: number;
  lastMs: number | undefined;
} {
  let handler: (() => void) | undefined;
  const state = {
    setCount: 0,
    clearCount: 0,
    lastMs: undefined as number | undefined,
    setInterval: (fn: () => void, ms: number): unknown => {
      state.setCount += 1;
      state.lastMs = ms;
      handler = fn;
      return { id: state.setCount };
    },
    clearInterval: (_h: unknown): void => {
      state.clearCount += 1;
    },
    tick: (): void => {
      handler?.();
    },
  };
  return state;
}

function makeClock(startAt = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = startAt;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const VERIFIED_TEXT = "The swarm converged on a verified answer.";
const ABSTAIN_TEXT = "I don't have enough confidence to answer.";

async function buildEvidenceHandler(): Promise<(msg: InboundMessage) => Promise<OutboundReply & { evidence?: BadgeEvidence }>> {
  const cert = await issueCert(VERIFIED_TEXT);
  return async (msg: InboundMessage): Promise<OutboundReply & { evidence?: BadgeEvidence }> => {
    if (msg.text === "verify-me") {
      return { text: VERIFIED_TEXT, accepted: true, evidence: { decision: emitDecision(), certificate: cert } };
    }
    if (msg.text === "abstain-me") {
      return { text: ABSTAIN_TEXT, accepted: true, evidence: { decision: abstainDecision() } };
    }
    if (msg.text === "boom") {
      throw new Error("handler exploded");
    }
    if (msg.text === "ignore-me") {
      return { text: "", accepted: false };
    }
    return { text: `echo: ${msg.text}`, accepted: true };
  };
}

let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // No code path in gateway-tui.ts may touch process.stdout — paint is
  // fully injected. Fail loudly if anything ever does.
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  expect(stdoutSpy).not.toHaveBeenCalled();
  stdoutSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// mirrorEventToTrafficRow / probesToPaneRows — pure adapters
// ---------------------------------------------------------------------------

describe("mirrorEventToTrafficRow", () => {
  it("preserves direction/platform/user and stamps the given timestamp verbatim", () => {
    const row = mirrorEventToTrafficRow({ direction: "in", platform: "telegram", user: "u1", text: "hi" }, 4242);
    expect(row).toEqual({ direction: "in", platform: "telegram", user: "u1", preview: "hi", at: 4242 });
  });

  it("truncates long text with an honest trailing ellipsis and never fabricates the visible content", () => {
    const long = "x".repeat(5000);
    const row = mirrorEventToTrafficRow({ direction: "out", platform: "discord", user: "u2", text: long }, 1);
    expect(row.preview.length).toBeLessThan(long.length);
    expect(row.preview.endsWith("…")).toBe(true);
    expect(row.preview.startsWith("x".repeat(20))).toBe(true);
  });

  it("leaves short text completely untouched (no ellipsis when nothing was cut)", () => {
    const row = mirrorEventToTrafficRow({ direction: "in", platform: "slack", user: "u3", text: "short" }, 1);
    expect(row.preview).toBe("short");
  });

  it("is pure: a frozen input is never mutated and repeated calls are deterministic", () => {
    const e = Object.freeze({ direction: "in" as const, platform: "email", user: "u4", text: "hello there" });
    const a = mirrorEventToTrafficRow(e, 99);
    const b = mirrorEventToTrafficRow(e, 99);
    expect(a).toEqual(b);
    expect(e).toEqual({ direction: "in", platform: "email", user: "u4", text: "hello there" });
  });

  it("code-point-safely truncates multi-byte text without splitting a surrogate pair", () => {
    const emoji = "😀".repeat(300); // each 😀 is a surrogate pair
    const row = mirrorEventToTrafficRow({ direction: "in", platform: "whatsapp", user: "u5", text: emoji }, 1);
    // No lone surrogate / replacement character should appear.
    expect(row.preview).not.toMatch(/�/);
    expect(row.preview.endsWith("…")).toBe(true);
  });
});

describe("probesToPaneRows", () => {
  it("maps real/offline probes faithfully — an offline platform can never appear live", () => {
    const probes: PlatformProbe[] = [
      { platform: "telegram", mode: "real", detail: "via HADES_TELEGRAM_TOKEN" },
      { platform: "discord", mode: "offline", detail: "missing HADES_DISCORD_TOKEN, DISCORD_BOT_TOKEN" },
    ];
    const rows = probesToPaneRows(probes);
    expect(rows).toEqual([
      { platform: "telegram", mode: "real", detail: "via HADES_TELEGRAM_TOKEN" },
      { platform: "discord", mode: "offline", detail: "missing HADES_DISCORD_TOKEN, DISCORD_BOT_TOKEN" },
    ]);
    expect(rows.find((r) => r.platform === "discord")?.mode).toBe("offline");
  });

  it("returns fresh copies — mutating the input afterward never affects the mapped rows", () => {
    const probes: PlatformProbe[] = [{ platform: "signal", mode: "real", detail: "via X" }];
    const rows = probesToPaneRows(probes);
    probes[0].detail = "MUTATED";
    expect(rows[0].detail).toBe("via X");
  });
});

// ---------------------------------------------------------------------------
// GatewayTuiSession — end-to-end wiring
// ---------------------------------------------------------------------------

describe("GatewayTuiSession", () => {
  it("end-to-end: an inbound message produces exactly one 'in' and one 'out' row, and a genuinely verified reply lands its real badge in both app state and counters()", async () => {
    const handler = await buildEvidenceHandler();
    const connector = new InMemoryConnector("generic");
    const timers = makeFakeTimers();
    const clock = makeClock();

    const session = new GatewayTuiSession({
      handler,
      connectors: [connector],
      report: [{ platform: "generic", mode: "real", detail: "in-memory" }],
      timers,
      now: clock.now,
    });

    await session.start();
    const reply = await connector.receive({ user: "alice", text: "verify-me" });
    expect(reply.accepted).toBe(true);

    const state = session.app().gatewayState();
    expect(state.traffic).toHaveLength(2);
    expect(state.traffic[0]).toMatchObject({ direction: "in", platform: "generic", user: "alice" });
    expect(state.traffic[0].preview).toContain("verify-me");
    expect(state.traffic[1]).toMatchObject({ direction: "out", platform: "generic", user: "alice" });
    expect(state.traffic[1].preview).toContain("The swarm converged");

    expect(state.badges).toEqual({ verified: 1, abstained: 0, unverified: 0 });
    expect(session.counters()).toEqual({
      inbound: 1,
      outbound: 1,
      badges: { verified: 1, abstained: 0, unverified: 0 },
    });

    await session.stop();
  });

  it("end-to-end: a reply that genuinely abstains (gate emit:false) lands 'abstained', never promoted by an attached certificate", async () => {
    const handler = await buildEvidenceHandler();
    const connector = new InMemoryConnector("generic");
    const timers = makeFakeTimers();

    const session = new GatewayTuiSession({ handler, connectors: [connector], report: [], timers });
    await session.start();
    await connector.receive({ user: "bob", text: "abstain-me" });

    expect(session.app().gatewayState().badges).toEqual({ verified: 0, abstained: 1, unverified: 0 });
    expect(session.counters().badges).toEqual({ verified: 0, abstained: 1, unverified: 0 });

    await session.stop();
  });

  it("a reply with no evidence at all genuinely renders 'unverified' — never fabricated as verified", async () => {
    const handler = await buildEvidenceHandler();
    const connector = new InMemoryConnector("generic");
    const session = new GatewayTuiSession({ handler, connectors: [connector], report: [], timers: makeFakeTimers() });
    await session.start();
    await connector.receive({ user: "carl", text: "plain message" });

    expect(session.counters().badges).toEqual({ verified: 0, abstained: 0, unverified: 1 });
    await session.stop();
  });

  it("no fabrication: with zero inbound messages, the traffic feed stays empty and badges stay null across many idle repaint ticks", async () => {
    const handler = await buildEvidenceHandler();
    const timers = makeFakeTimers();
    const paint = vi.fn();
    const session = new GatewayTuiSession({ handler, connectors: [], report: [], timers, paint });

    await session.start();
    for (let i = 0; i < 50; i++) timers.tick();

    const state = session.app().gatewayState();
    expect(state.traffic).toEqual([]);
    expect(state.badges).toBeNull();
    expect(session.counters()).toEqual({ inbound: 0, outbound: 0, badges: { verified: 0, abstained: 0, unverified: 0 } });
    expect(paint).not.toHaveBeenCalled();

    await session.stop();
  });

  it("an empty-text (ignored) reply is never assessed or badged, matching BadgeStamper.wrap's own convention", async () => {
    const handler = await buildEvidenceHandler();
    const connector = new InMemoryConnector("generic");
    const session = new GatewayTuiSession({ handler, connectors: [connector], report: [], timers: makeFakeTimers() });
    await session.start();

    const reply = await connector.receive({ user: "dana", text: "ignore-me" });
    expect(reply.text).toBe("");

    const state = session.app().gatewayState();
    // The inbound leg still genuinely arrived...
    expect(state.traffic).toHaveLength(1);
    expect(state.traffic[0].direction).toBe("in");
    // ...but nothing was assessed for an empty-text reply.
    expect(state.badges).toBeNull();
    expect(session.counters()).toEqual({ inbound: 1, outbound: 0, badges: { verified: 0, abstained: 0, unverified: 0 } });

    await session.stop();
  });

  it("rate-limited messages short-circuit exactly as ConnectorHub.route() does: no mirror at all, no traffic row, no badge", async () => {
    const handler = await buildEvidenceHandler();
    const connector = new InMemoryConnector("generic");
    const rateLimiter = new RateLimiter({ capacity: 1, refillMs: 60_000, now: () => 0 });
    const session = new GatewayTuiSession({
      handler,
      connectors: [connector],
      report: [],
      timers: makeFakeTimers(),
      rateLimiter,
    });
    await session.start();

    const first = await connector.receive({ user: "eve", text: "hello" });
    expect(first.accepted).toBe(true);
    const second = await connector.receive({ user: "eve", text: "hello again" });
    expect(second.accepted).toBe(false); // rejected by the rate limiter

    const state = session.app().gatewayState();
    // Only the first exchange (in + out) was ever mirrored.
    expect(state.traffic).toHaveLength(2);
    expect(session.counters()).toEqual({ inbound: 1, outbound: 1, badges: { verified: 0, abstained: 0, unverified: 1 } });
    // The rejection text was still genuinely delivered back to the connector
    // (InMemoryConnector.receive always sends a non-empty reply) — it just
    // never entered the mirrored traffic feed.
    expect(connector.sent).toHaveLength(2);
    expect(connector.sent[1].text).not.toContain("echo:");

    await session.stop();
  });

  it("flood: pushing more rows than the pane cap evicts the oldest without corrupting selection/scroll", async () => {
    const handler = await buildEvidenceHandler();
    const connector = new InMemoryConnector("generic");
    const session = new GatewayTuiSession({ handler, connectors: [connector], report: [], timers: makeFakeTimers() });
    await session.start();

    const N = 210; // > the pane's 200-row cap; each message yields 2 rows (in + out)
    for (let i = 0; i < N; i++) {
      await connector.receive({ user: "flood", text: `msg-${i}` });
    }

    const state = session.app().gatewayState();
    expect(state.traffic).toHaveLength(200);
    // The newest row must be the last message's outbound echo.
    expect(state.traffic[state.traffic.length - 1].preview).toContain(`msg-${N - 1}`);
    // The oldest surviving row must NOT be the very first message (it was evicted).
    expect(state.traffic[0].preview).not.toBe("msg-0");
    expect(state.traffic[0].direction).toBe("in");
    const survivingIndex = Number(state.traffic[0].preview.replace("msg-", ""));
    expect(survivingIndex).toBeGreaterThan(0);
    // Selection/scroll stay in-bounds — no corruption.
    expect(state.selected).toBeGreaterThanOrEqual(0);
    expect(state.selected).toBeLessThan(state.traffic.length);
    expect(state.scroll).toBeGreaterThanOrEqual(0);
    expect(state.scroll).toBeLessThanOrEqual(Math.max(0, state.traffic.length - state.height));

    await session.stop();
  });

  it("repaint coalescing: N rapid events between ticks yield exactly one paint; an idle tick yields zero; repaintMs is respected", async () => {
    const handler = await buildEvidenceHandler();
    const connector = new InMemoryConnector("generic");
    const timers = makeFakeTimers();
    const paint = vi.fn();
    const session = new GatewayTuiSession({
      handler,
      connectors: [connector],
      report: [],
      timers,
      paint,
      repaintMs: 250,
    });
    await session.start();
    expect(timers.lastMs).toBe(250);

    await connector.receive({ user: "f1", text: "one" });
    await connector.receive({ user: "f2", text: "two" });
    await connector.receive({ user: "f3", text: "three" });

    timers.tick();
    expect(paint).toHaveBeenCalledTimes(1);
    expect(paint).toHaveBeenCalledWith(session.app().frame());

    // Idle tick — nothing changed since the last paint.
    timers.tick();
    expect(paint).toHaveBeenCalledTimes(1);

    // A single new event, then a tick, yields exactly one more paint.
    await connector.receive({ user: "f4", text: "four" });
    timers.tick();
    expect(paint).toHaveBeenCalledTimes(2);

    await session.stop();
  });

  it("lifecycle: start() is idempotent (no re-registered timer, no re-started connectors)", async () => {
    const handler = await buildEvidenceHandler();
    const connector = new InMemoryConnector("generic");
    const timers = makeFakeTimers();
    const session = new GatewayTuiSession({ handler, connectors: [connector], report: [], timers });

    const first = await session.start();
    expect(timers.setCount).toBe(1);
    expect(connector.isRunning()).toBe(true);

    const second = await session.start();
    expect(timers.setCount).toBe(1); // no second interval registered
    expect(second).toEqual(first);

    await session.stop();
  });

  it("lifecycle: stop() stops every connector, clears the repaint interval, and a post-stop inbound event mutates nothing", async () => {
    const handler = await buildEvidenceHandler();
    const connector = new InMemoryConnector("generic");
    const timers = makeFakeTimers();
    const session = new GatewayTuiSession({ handler, connectors: [connector], report: [], timers });

    await session.start();
    await connector.receive({ user: "g1", text: "hi" });
    expect(connector.isRunning()).toBe(true);

    await session.stop();
    expect(connector.isRunning()).toBe(false);
    expect(timers.clearCount).toBe(1);

    const beforeState = JSON.stringify(session.app().gatewayState());
    const beforeCounters = session.counters();

    // The connector itself refuses to route once stopped — this proves no
    // post-stop event can reach the session.
    await expect(connector.receive({ user: "g1", text: "after-stop" })).rejects.toThrow();

    expect(JSON.stringify(session.app().gatewayState())).toBe(beforeState);
    expect(session.counters()).toEqual(beforeCounters);

    // stop() again is a clean no-op.
    await session.stop();
    expect(timers.clearCount).toBe(1);
  });

  it("error isolation: a throwing handler is logged, never shown as a successful badged reply, and the session stays alive", async () => {
    const handler = await buildEvidenceHandler();
    const connector = new InMemoryConnector("generic");
    const log = vi.fn();
    const session = new GatewayTuiSession({ handler, connectors: [connector], report: [], timers: makeFakeTimers(), log });
    await session.start();

    const failed = await connector.receive({ user: "h1", text: "boom" });
    expect(failed.accepted).toBe(false);
    expect(failed.text).toBe("");

    // `start()` itself logs one informational line; the error line is the
    // one that actually matters here.
    const errorLines = log.mock.calls.map((c) => String(c[0])).filter((line) => line.includes("handler exploded"));
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain("generic:h1");

    let state = session.app().gatewayState();
    // The inbound leg genuinely arrived; the failed exchange has no outbound
    // row and contributed no badge (never shown as a successful reply).
    expect(state.traffic).toHaveLength(1);
    expect(state.traffic[0].direction).toBe("in");
    expect(state.badges).toBeNull();
    expect(session.counters()).toEqual({ inbound: 1, outbound: 0, badges: { verified: 0, abstained: 0, unverified: 0 } });

    // The session survives — a subsequent normal message still processes.
    const ok = await connector.receive({ user: "h1", text: "hello again" });
    expect(ok.accepted).toBe(true);
    state = session.app().gatewayState();
    expect(state.traffic).toHaveLength(3);
    expect(state.badges).toEqual({ verified: 0, abstained: 0, unverified: 1 });

    await session.stop();
  });

  it("probesToPaneRows seeds the PLATFORMS section at start, faithfully reflecting real/offline modes", async () => {
    const handler = await buildEvidenceHandler();
    const report: PlatformProbe[] = [
      { platform: "telegram", mode: "real", detail: "via HADES_TELEGRAM_TOKEN" },
      { platform: "signal", mode: "offline", detail: "missing HADES_SIGNAL_URL, HADES_SIGNAL_NUMBER" },
    ];
    const session = new GatewayTuiSession({ handler, connectors: [], report, timers: makeFakeTimers() });
    await session.start();

    const state = session.app().gatewayState();
    expect(state.probes).toEqual(report);
    expect(state.probes.find((p) => p.platform === "signal")?.mode).toBe("offline");

    await session.stop();
  });

  it("counters() agrees exactly with app pane state at every step (cross-assert), including through the badge-stamper path", async () => {
    const cert = await issueCert(VERIFIED_TEXT);
    const handler = async (msg: InboundMessage): Promise<OutboundReply & { evidence?: BadgeEvidence }> => {
      if (msg.text === "v") return { text: VERIFIED_TEXT, accepted: true, evidence: { decision: emitDecision(), certificate: cert } };
      return { text: "plain", accepted: true };
    };
    const connector = new InMemoryConnector("generic");
    const badgeStamper = new BadgeStamper();
    const session = new GatewayTuiSession({
      handler,
      connectors: [connector],
      report: [],
      timers: makeFakeTimers(),
      badgeStamper,
    });
    await session.start();

    await connector.receive({ user: "z1", text: "v" });
    await connector.receive({ user: "z2", text: "plain" });
    await connector.receive({ user: "z1", text: "v" });

    const state = session.app().gatewayState();
    const counters = session.counters();
    expect(counters.inbound).toBe(3);
    expect(counters.outbound).toBe(3);
    expect(counters.badges).toEqual(state.badges);
    // The wire text was actually stamped by the injected BadgeStamper.
    expect(connector.sent[0].text).toContain("verified");

    await session.stop();
  });

  it("a session with zero connectors starts and stops cleanly (no platforms to route through)", async () => {
    const handler = await buildEvidenceHandler();
    const session = new GatewayTuiSession({ handler, connectors: [], report: [], timers: makeFakeTimers() });
    const result = await session.start();
    expect(result.connectors).toBe(0);
    expect(result.platforms).toEqual([]);
    await session.stop();
  });
});
