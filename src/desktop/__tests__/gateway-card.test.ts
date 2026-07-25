import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isGatewayEvent,
  isGatewayStatusView,
  isGatewayPairCodeView,
  isGatewayProbeView,
  GATEWAY_EVENT_KINDS,
  type GatewayEvent,
  type GatewayStatusView,
  type GatewayPairCodeView,
  type GatewayProbeView,
  type GatewayCountersView,
} from "../ipc/gateway-contract";

import {
  initialGatewayCardState,
  applyGatewayEvent,
  renderGatewayCard,
  renderProbeRows,
  renderCounters,
  renderPairCode,
  escapeHtml,
  type GatewayCardState,
} from "../ui/gateway-card";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TS_PATH = join(__dirname, "../ui/gateway-card.ts");
const CSS_PATH = join(__dirname, "../ui/gateway-card.css");

// ---------------------------------------------------------------------------
// Fixtures — every fixture is validated against the real wire guards from
// ../ipc/gateway-contract below, so these can never silently drift from the
// wire format.
// ---------------------------------------------------------------------------

function probeView(overrides: Partial<GatewayProbeView> = {}): GatewayProbeView {
  return {
    platform: "discord",
    mode: "real",
    detail: "DISCORD_BOT_TOKEN",
    ...overrides,
  };
}

function countersView(overrides: Partial<GatewayCountersView> = {}): GatewayCountersView {
  return {
    inbound: 42,
    outbound: 37,
    rateLimited: 3,
    ...overrides,
  };
}

function statusView(overrides: Partial<GatewayStatusView> = {}): GatewayStatusView {
  return {
    running: true,
    startedAt: 1_700_000_000_000,
    platforms: [probeView(), probeView({ platform: "slack", mode: "offline", detail: "SLACK_BOT_TOKEN" })],
    counters: countersView(),
    engine: { requested: "cloud-a", mode: "real", detail: "engine online" },
    at: 1_700_000_100_000,
    ...overrides,
  };
}

function pairView(overrides: Partial<GatewayPairCodeView> = {}): GatewayPairCodeView {
  return {
    code: "AB12-CD34",
    level: "trusted",
    expiresAt: 1_700_000_060_000,
    at: 1_700_000_000_000,
    ...overrides,
  };
}

/** Recursively freezes an object graph so any mutation attempt throws (strict mode). */
function deepFreeze<T>(obj: T): T {
  if (obj !== null && (typeof obj === "object" || typeof obj === "function")) {
    for (const key of Object.getOwnPropertyNames(obj)) {
      const value = (obj as Record<string, unknown>)[key];
      if (value !== null && (typeof value === "object" || typeof value === "function") && !Object.isFrozen(value)) {
        deepFreeze(value);
      }
    }
    Object.freeze(obj);
  }
  return obj;
}

// ===========================================================================
// Fixture sanity — every fixture used below must satisfy the real contract
// guards, so tests can never silently drift from the wire format.
// ===========================================================================

describe("fixtures satisfy the real ipc/gateway-contract guards", () => {
  it("probeView / countersView / statusView / pairView all validate", () => {
    expect(isGatewayProbeView(probeView())).toBe(true);
    expect(isGatewayProbeView(probeView({ mode: "offline" }))).toBe(true);
    expect(isGatewayStatusView(statusView())).toBe(true);
    expect(isGatewayStatusView(statusView({ engine: null, startedAt: null }))).toBe(true);
    expect(isGatewayPairCodeView(pairView())).toBe(true);
  });

  it("every constructed GatewayEvent used in this file passes isGatewayEvent", () => {
    const events: GatewayEvent[] = [
      { kind: "gateway.status", status: statusView() },
      { kind: "gateway.paircode", pair: pairView() },
      { kind: "gateway.error", message: "boom", at: 1 },
    ];
    for (const e of events) expect(isGatewayEvent(e)).toBe(true);
    expect(new Set(events.map((e) => e.kind))).toEqual(new Set(GATEWAY_EVENT_KINDS));
  });
});

// ===========================================================================
// initialGatewayCardState
// ===========================================================================

describe("initialGatewayCardState", () => {
  it("starts with no status, no pairCode, no error", () => {
    expect(initialGatewayCardState()).toEqual({ status: null, pairCode: null, error: null });
  });
});

// ===========================================================================
// applyGatewayEvent — reducer semantics + purity
// ===========================================================================

describe("applyGatewayEvent — semantics", () => {
  it("gateway.status replaces status wholesale and clears any prior error", () => {
    const prior: GatewayCardState = deepFreeze({ status: null, pairCode: null, error: "stale error" });
    const event: GatewayEvent = deepFreeze({ kind: "gateway.status", status: statusView() });
    const next = applyGatewayEvent(prior, event);
    expect(next.status).toEqual(statusView());
    expect(next.error).toBeNull();
  });

  it("gateway.status leaves pairCode untouched", () => {
    const prior: GatewayCardState = deepFreeze({ status: null, pairCode: pairView(), error: null });
    const event: GatewayEvent = deepFreeze({ kind: "gateway.status", status: statusView() });
    const next = applyGatewayEvent(prior, event);
    expect(next.pairCode).toEqual(pairView());
  });

  it("gateway.paircode replaces pairCode wholesale, leaving status and error untouched", () => {
    const prior: GatewayCardState = deepFreeze({ status: statusView(), pairCode: null, error: "still failing" });
    const event: GatewayEvent = deepFreeze({ kind: "gateway.paircode", pair: pairView() });
    const next = applyGatewayEvent(prior, event);
    expect(next.pairCode).toEqual(pairView());
    expect(next.status).toEqual(statusView());
    expect(next.error).toBe("still failing");
  });

  it("gateway.error records the message while preserving last-known status and pairCode", () => {
    const prior: GatewayCardState = deepFreeze({ status: statusView(), pairCode: pairView(), error: null });
    const event: GatewayEvent = deepFreeze({ kind: "gateway.error", message: "poll failed", at: 5 });
    const next = applyGatewayEvent(prior, event);
    expect(next.error).toBe("poll failed");
    expect(next.status).toEqual(statusView());
    expect(next.pairCode).toEqual(pairView());
  });
});

describe("applyGatewayEvent — purity", () => {
  it("never mutates a deep-frozen input state or event, and always returns a new object", () => {
    const prior: GatewayCardState = deepFreeze({ status: statusView(), pairCode: pairView(), error: null });

    const statusEvent: GatewayEvent = deepFreeze({ kind: "gateway.status", status: statusView({ at: 2 }) });
    expect(() => applyGatewayEvent(prior, statusEvent)).not.toThrow();
    const afterStatus = applyGatewayEvent(prior, statusEvent);
    expect(afterStatus).not.toBe(prior);
    expect(prior.status).toEqual(statusView()); // original untouched

    const pairEvent: GatewayEvent = deepFreeze({ kind: "gateway.paircode", pair: pairView({ code: "ZZ99-ZZ99" }) });
    expect(() => applyGatewayEvent(prior, pairEvent)).not.toThrow();
    const afterPair = applyGatewayEvent(prior, pairEvent);
    expect(afterPair).not.toBe(prior);
    expect(prior.pairCode).toEqual(pairView());

    const errorEvent: GatewayEvent = deepFreeze({ kind: "gateway.error", message: "x", at: 1 });
    expect(() => applyGatewayEvent(prior, errorEvent)).not.toThrow();
    const afterError = applyGatewayEvent(prior, errorEvent);
    expect(afterError).not.toBe(prior);
    expect(prior.error).toBeNull();
  });

  it("does not alias the incoming status/pair objects' containing state (returns a fresh top-level object)", () => {
    const prior: GatewayCardState = deepFreeze(initialGatewayCardState());
    const event: GatewayEvent = deepFreeze({ kind: "gateway.status", status: statusView() });
    const next = applyGatewayEvent(prior, event);
    expect(next).not.toBe(prior);
  });
});

describe("applyGatewayEvent — event-order matrix", () => {
  it("status -> error -> status: the second status clears the error again", () => {
    let s = initialGatewayCardState();
    s = applyGatewayEvent(s, { kind: "gateway.status", status: statusView({ at: 1 }) });
    expect(s.error).toBeNull();

    s = applyGatewayEvent(s, { kind: "gateway.error", message: "poll failed", at: 2 });
    expect(s.error).toBe("poll failed");
    expect(s.status).toEqual(statusView({ at: 1 }));

    s = applyGatewayEvent(s, { kind: "gateway.status", status: statusView({ at: 3 }) });
    expect(s.error).toBeNull();
    expect(s.status).toEqual(statusView({ at: 3 }));
  });

  it("paircode -> status: the pairCode survives an unrelated status refresh", () => {
    let s = initialGatewayCardState();
    s = applyGatewayEvent(s, { kind: "gateway.paircode", pair: pairView() });
    expect(s.pairCode).toEqual(pairView());

    s = applyGatewayEvent(s, { kind: "gateway.status", status: statusView() });
    expect(s.pairCode).toEqual(pairView());
    expect(s.status).toEqual(statusView());
  });

  it("error-before-any-status: the error lane is set with status and pairCode still null", () => {
    let s = initialGatewayCardState();
    s = applyGatewayEvent(s, { kind: "gateway.error", message: "no gateway attached to this sidecar", at: 1 });
    expect(s.error).toBe("no gateway attached to this sidecar");
    expect(s.status).toBeNull();
    expect(s.pairCode).toBeNull();
  });

  it("interleaving: status -> paircode -> error -> status -> error leaves the expected final shape", () => {
    let s = initialGatewayCardState();
    s = applyGatewayEvent(s, { kind: "gateway.status", status: statusView({ at: 1 }) });
    s = applyGatewayEvent(s, { kind: "gateway.paircode", pair: pairView({ code: "AAAA-1111" }) });
    s = applyGatewayEvent(s, { kind: "gateway.error", message: "err-1", at: 2 });
    s = applyGatewayEvent(s, { kind: "gateway.status", status: statusView({ at: 3, running: false }) });
    expect(s.error).toBeNull(); // cleared by the fresh status
    s = applyGatewayEvent(s, { kind: "gateway.error", message: "err-2", at: 4 });

    expect(s.error).toBe("err-2");
    expect(s.status).toEqual(statusView({ at: 3, running: false }));
    expect(s.pairCode).toEqual(pairView({ code: "AAAA-1111" })); // survived every intervening event
  });

  it("paircode -> paircode: the newer pairCode wholly replaces the older one", () => {
    let s = initialGatewayCardState();
    s = applyGatewayEvent(s, { kind: "gateway.paircode", pair: pairView({ code: "OLD1-OLD1" }) });
    s = applyGatewayEvent(s, { kind: "gateway.paircode", pair: pairView({ code: "NEW2-NEW2" }) });
    expect(s.pairCode).toEqual(pairView({ code: "NEW2-NEW2" }));
  });
});

// ---------------------------------------------------------------------------
// Exhaustiveness guard — compile-level proof plus a runtime default-arm
// unreachability check exercised the same way learning-surface.test.ts /
// fleet-view.test.ts prove their own reducers/switches are exhaustive.
// ---------------------------------------------------------------------------

describe("applyGatewayEvent — exhaustiveness", () => {
  // Compile-level proof: gateway-card.ts's `applyGatewayEvent` default arm
  // assigns `e` to a `never`-typed local (`const _exhaustive: never = e`).
  // If a new kind is ever added to the `GatewayEvent` union in
  // ../ipc/gateway-contract.ts without a matching `case` being added to
  // `applyGatewayEvent`, that assignment stops type-checking and
  // `npx tsc --noEmit -p tsconfig.lib.json` fails — this file (and the whole
  // build) will not compile. The switch below mirrors that same shape at
  // the test level to additionally prove full runtime coverage.
  function assertNeverEvent(x: never): string {
    throw new Error(`uncovered GatewayEvent kind: ${JSON.stringify(x)}`);
  }
  function classify(e: GatewayEvent): string {
    switch (e.kind) {
      case "gateway.status":
        return "status";
      case "gateway.paircode":
        return "paircode";
      case "gateway.error":
        return "error";
      default:
        return assertNeverEvent(e);
    }
  }

  it("every real GatewayEvent kind is covered at runtime (the default arm is unreachable)", () => {
    const fixtures: Record<(typeof GATEWAY_EVENT_KINDS)[number], GatewayEvent> = {
      "gateway.status": { kind: "gateway.status", status: statusView() },
      "gateway.paircode": { kind: "gateway.paircode", pair: pairView() },
      "gateway.error": { kind: "gateway.error", message: "x", at: 0 },
    };
    for (const kind of GATEWAY_EVENT_KINDS) {
      expect(() => classify(fixtures[kind])).not.toThrow();
    }
  });

  it("gateway-card.ts's applyGatewayEvent source contains the `never`-typed exhaustiveness guard", () => {
    const src = readFileSync(TS_PATH, "utf8");
    expect(src).toMatch(/const _exhaustive:\s*never\s*=\s*e;/);
  });
});

// ===========================================================================
// renderCounters
// ===========================================================================

describe("renderCounters", () => {
  it("renders the exact numbers from the wire", () => {
    const html = renderCounters(countersView({ inbound: 100, outbound: 7, rateLimited: 0 }));
    expect(html).toContain("inbound 100");
    expect(html).toContain("outbound 7");
    expect(html).toContain("rate-limited 0");
  });

  it("never fabricates non-zero counters when the wire says zero", () => {
    const html = renderCounters(countersView({ inbound: 0, outbound: 0, rateLimited: 0 }));
    expect(html).toContain("inbound 0");
    expect(html).toContain("outbound 0");
    expect(html).toContain("rate-limited 0");
  });
});

// ===========================================================================
// renderProbeRows — mode honesty
// ===========================================================================

describe("renderProbeRows", () => {
  it("renders an explicit empty state for zero platforms, never a blank table", () => {
    const html = renderProbeRows([]);
    expect(html).not.toContain("<table");
    expect(html).toContain("gateway-probes--empty");
    expect(html).toContain("no platforms probed");
  });

  it("renders a real-mode probe with the gateway-badge--real class and never gateway-badge--offline", () => {
    const html = renderProbeRows([probeView({ platform: "discord", mode: "real" })]);
    expect(html).toContain("gateway-badge--real");
    expect(html).not.toContain("gateway-badge--offline");
    expect(html).toContain("discord");
    expect(html).toContain(">real<");
  });

  it("renders an offline-mode probe with the gateway-badge--offline class and never gateway-badge--real", () => {
    const html = renderProbeRows([probeView({ platform: "slack", mode: "offline" })]);
    expect(html).toContain("gateway-badge--offline");
    expect(html).not.toContain("gateway-badge--real");
    expect(html).toContain("slack");
    expect(html).toContain(">offline<");
  });

  it("a mixed platform list renders each platform's own true mode independently", () => {
    const html = renderProbeRows([
      probeView({ platform: "discord", mode: "real" }),
      probeView({ platform: "slack", mode: "offline" }),
      probeView({ platform: "telegram", mode: "real" }),
    ]);
    const rows = html.split("</tr>");
    const discordRow = rows.find((r) => r.includes("discord"))!;
    const slackRow = rows.find((r) => r.includes("slack"))!;
    const telegramRow = rows.find((r) => r.includes("telegram"))!;
    expect(discordRow).toContain("gateway-badge--real");
    expect(slackRow).toContain("gateway-badge--offline");
    expect(telegramRow).toContain("gateway-badge--real");
  });

  it("renders the detail string (env var name) verbatim per platform", () => {
    const html = renderProbeRows([probeView({ detail: "DISCORD_BOT_TOKEN" })]);
    expect(html).toContain("DISCORD_BOT_TOKEN");
  });
});

// ===========================================================================
// renderPairCode — TTL-aware honesty
// ===========================================================================

describe("renderPairCode", () => {
  it("renders an explicit empty state for a null pair code", () => {
    const html = renderPairCode(null, 1_700_000_000_000);
    expect(html).toContain("gateway-paircode--empty");
    expect(html).toContain("no pairing code issued yet");
  });

  it("renders the code and a positive countdown when well before expiry", () => {
    const p = pairView({ code: "AB12-CD34", expiresAt: 1_700_000_060_000 });
    const html = renderPairCode(p, 1_700_000_000_000); // 60s remaining
    expect(html).toContain("gateway-paircode--active");
    expect(html).toContain("AB12-CD34");
    expect(html).toContain("expires in 60s");
  });

  it("floors partial-second remaining time down to whole seconds", () => {
    const p = pairView({ code: "AB12-CD34", expiresAt: 1_700_000_000_999 });
    const html = renderPairCode(p, 1_700_000_000_000); // 999ms -> 0s remaining, but still > 0
    expect(html).toContain("expires in 0s");
    expect(html).toContain("AB12-CD34");
  });

  it("renders the literal 'expired' state and suppresses the code text exactly at expiresAt", () => {
    const p = pairView({ code: "AB12-CD34", expiresAt: 1_700_000_000_000 });
    const html = renderPairCode(p, 1_700_000_000_000); // remainingMs === 0 -> expired
    expect(html).toContain("gateway-paircode--expired");
    expect(html).toContain("expired");
    expect(html).not.toContain("AB12-CD34");
  });

  it("renders the literal 'expired' state and suppresses the code text well past expiry", () => {
    const p = pairView({ code: "AB12-CD34", expiresAt: 1_700_000_000_000 });
    const html = renderPairCode(p, 1_700_000_099_000); // 99s past expiry
    expect(html).toContain("gateway-paircode--expired");
    expect(html).not.toContain("AB12-CD34");
    expect(html).not.toContain("expires in");
  });

  it("renders the trusted/owner level badge honestly", () => {
    const trusted = renderPairCode(pairView({ level: "trusted" }), 1_700_000_000_000);
    expect(trusted).toContain("gateway-badge--trusted");
    expect(trusted).not.toContain("gateway-badge--owner");

    const owner = renderPairCode(pairView({ level: "owner" }), 1_700_000_000_000);
    expect(owner).toContain("gateway-badge--owner");
    expect(owner).not.toContain("gateway-badge--trusted");
  });
});

// ===========================================================================
// renderGatewayCard — empty / error / full states
// ===========================================================================

describe("renderGatewayCard — empty / error / full states", () => {
  it("renders an honest 'no gateway status received yet' message with no status, no error, no pairCode", () => {
    const html = renderGatewayCard(initialGatewayCardState(), { nowMs: 1_700_000_000_000 });
    expect(html).toContain("no gateway status received yet");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("gateway-counters__stat");
  });

  it("never renders zeroed counters or an empty-but-real-looking table when status is absent", () => {
    const html = renderGatewayCard(initialGatewayCardState(), { nowMs: 1 });
    expect(html).not.toMatch(/inbound 0/);
    expect(html).not.toContain("gateway-probes-table");
  });

  it("renders the error lane alongside the empty status message when there is an error but no status yet", () => {
    const html = renderGatewayCard({ status: null, pairCode: null, error: "no gateway attached to this sidecar" }, { nowMs: 1 });
    expect(html).toContain("gateway-error");
    expect(html).toContain("no gateway attached to this sidecar");
    expect(html).toContain("no gateway status received yet");
  });

  it("still renders an already-issued pairCode even before the first status arrives", () => {
    const html = renderGatewayCard({ status: null, pairCode: pairView(), error: null }, { nowMs: 1_700_000_000_000 });
    expect(html).toContain("gateway-paircode--active");
    expect(html).toContain(pairView().code);
    expect(html).toContain("no gateway status received yet");
  });

  it("renders the full card (header + probes + counters + pairing) once a status is present", () => {
    const html = renderGatewayCard({ status: statusView(), pairCode: pairView(), error: null }, { nowMs: 1_700_000_000_000 });
    expect(html).toContain("gateway-card__header");
    expect(html).toContain("gateway-probes-table");
    expect(html).toContain("gateway-counters");
    expect(html).toContain("gateway-paircode");
    expect(html).not.toContain("gateway-error");
    expect(html).not.toContain("no gateway status received yet");
  });

  it("retains the last-known status and probe table while the error lane is shown", () => {
    const html = renderGatewayCard({ status: statusView(), pairCode: null, error: "gateway.status.get failed" }, { nowMs: 1_700_000_000_000 });
    expect(html).toContain("gateway-error");
    expect(html).toContain("gateway.status.get failed");
    expect(html).toContain("gateway-probes-table"); // last-known data still rendered
    expect(html).toContain("gateway-counters__stat");
  });

  it("renders the running badge honestly for a running vs stopped gateway", () => {
    const running = renderGatewayCard({ status: statusView({ running: true }), pairCode: null, error: null }, { nowMs: 1 });
    expect(running).toContain("gateway-badge--running");
    expect(running).not.toContain("gateway-badge--stopped");

    const stopped = renderGatewayCard({ status: statusView({ running: false }), pairCode: null, error: null }, { nowMs: 1 });
    expect(stopped).toContain("gateway-badge--stopped");
    expect(stopped).not.toContain("gateway-badge--running");
  });

  it("renders 'never started' when startedAt is null, and the real started time otherwise", () => {
    const neverStarted = renderGatewayCard({ status: statusView({ startedAt: null }), pairCode: null, error: null }, { nowMs: 1 });
    expect(neverStarted).toContain("never started");

    const started = renderGatewayCard({ status: statusView({ startedAt: 1_700_000_000_000 }), pairCode: null, error: null }, { nowMs: 1 });
    expect(started).not.toContain("never started");
    expect(started).toContain("started 2023-11-14");
  });

  it("renders the engine mode honestly, and 'engine: none' when no engine probe was configured", () => {
    const real = renderGatewayCard({ status: statusView({ engine: { requested: "x", mode: "real", detail: "d" } }), pairCode: null, error: null }, { nowMs: 1 });
    expect(real).toContain("gateway-badge--engine-real");
    expect(real).toContain("engine: real");

    const mock = renderGatewayCard({ status: statusView({ engine: { requested: "x", mode: "mock", detail: "d" } }), pairCode: null, error: null }, { nowMs: 1 });
    expect(mock).toContain("gateway-badge--engine-mock");
    expect(mock).toContain("engine: mock");

    const none = renderGatewayCard({ status: statusView({ engine: null }), pairCode: null, error: null }, { nowMs: 1 });
    expect(none).toContain("gateway-badge--engine-none");
    expect(none).toContain("engine: none");
  });
});

// ---------------------------------------------------------------------------
// Render determinism
// ---------------------------------------------------------------------------

describe("renderGatewayCard — determinism", () => {
  it("identical state + nowMs yields byte-identical output, across every state shape", () => {
    const cases: Array<{ state: GatewayCardState; nowMs: number }> = [
      { state: initialGatewayCardState(), nowMs: 1 },
      { state: { status: null, pairCode: null, error: "boom" }, nowMs: 2 },
      { state: { status: statusView(), pairCode: null, error: null }, nowMs: 1_700_000_000_000 },
      { state: { status: statusView(), pairCode: pairView(), error: "still failing" }, nowMs: 1_700_000_030_000 },
      { state: { status: statusView(), pairCode: pairView(), error: null }, nowMs: 1_700_000_060_000 }, // exactly expired
      { state: { status: statusView({ platforms: [] }), pairCode: null, error: null }, nowMs: 1 },
    ];

    for (const { state, nowMs } of cases) {
      const a = renderGatewayCard(state, { nowMs });
      const b = renderGatewayCard(state, { nowMs });
      expect(a).toBe(b);
    }
  });

  it("does not mutate the input state across repeated renders", () => {
    const state: GatewayCardState = deepFreeze({ status: statusView(), pairCode: pairView(), error: "x" });
    expect(() => renderGatewayCard(state, { nowMs: 1 })).not.toThrow();
    expect(() => renderGatewayCard(state, { nowMs: 2 })).not.toThrow();
  });
});

// ===========================================================================
// XSS resistance — every interpolated value is escaped
// ===========================================================================

describe("escapeHtml", () => {
  it("escapes &, <, >, \", ' individually", () => {
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml(">")).toBe("&gt;");
    expect(escapeHtml('"')).toBe("&quot;");
    expect(escapeHtml("'")).toBe("&#39;");
  });

  it("leaves unicode text untouched", () => {
    expect(escapeHtml("パイプライン 🚀")).toBe("パイプライン 🚀");
  });
});

describe("renderGatewayCard — XSS resistance", () => {
  it("escapes a hostile platform name (script-tag payload)", () => {
    const evilPlatform = "<script>alert(1)</script>";
    const html = renderGatewayCard(
      { status: statusView({ platforms: [probeView({ platform: evilPlatform })] }), pairCode: null, error: null },
      { nowMs: 1 }
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes a hostile probe detail string", () => {
    const evilDetail = '"><img src=x onerror=alert(1)>';
    const html = renderProbeRows([probeView({ detail: evilDetail })]);
    expect(html).not.toMatch(/<img[^>]*onerror/);
  });

  it("escapes a hostile platform name inside the data-platform attribute", () => {
    const evilPlatform = '"><img src=x onerror=alert(1)>';
    const html = renderProbeRows([probeView({ platform: evilPlatform })]);
    expect(html).not.toMatch(/<img[^>]*onerror/);
    expect(html).not.toMatch(/data-platform="[^"]*<img/);
  });

  it("escapes a hostile error message", () => {
    const evilMessage = '<script>alert("x")</script>\'quoted\'';
    const html = renderGatewayCard({ status: null, pairCode: null, error: evilMessage }, { nowMs: 1 });
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;x&quot;");
    expect(html).toContain("&#39;quoted&#39;");
  });

  it("escapes a hostile pairing code and unicode content, and never leaks it raw", () => {
    const evilCode = "<script>steal()</script>";
    const html = renderPairCode(pairView({ code: evilCode, expiresAt: 1_700_000_060_000 }), 1_700_000_000_000);
    expect(html).not.toContain("<script>steal()</script>");
    expect(html).toContain("&lt;script&gt;steal()&lt;/script&gt;");
  });

  it("escapes ampersands and quotes inside a pairing code", () => {
    const html = renderPairCode(
      pairView({ code: `AB&"'12`, expiresAt: 1_700_000_060_000 }),
      1_700_000_000_000
    );
    expect(html).not.toContain(`AB&"'12`);
    expect(html).toContain("AB&amp;&quot;&#39;12");
  });

  it("renders unicode platform names, error messages, and pair codes without corruption", () => {
    const html = renderGatewayCard(
      {
        status: statusView({ platforms: [probeView({ platform: "télégram 📡" })] }),
        pairCode: pairView({ code: "コード-1234", expiresAt: 1_700_000_060_000 }),
        error: "エラー発生 ⚠️",
      },
      { nowMs: 1_700_000_000_000 }
    );
    expect(html).toContain("télégram 📡");
    expect(html).toContain("コード-1234");
    expect(html).toContain("エラー発生 ⚠️");
  });
});

// ===========================================================================
// CSS coverage: every class emitted by gateway-card.ts exists in
// gateway-card.css, and every gateway-* class in the CSS is actually emitted
// somewhere by the TS — a bidirectional diff so the two files can never
// drift apart, mirroring the fleet-view.ts / learning-card.ts precedent.
// ===========================================================================

describe("gateway-card.css <-> gateway-card.ts class coverage", () => {
  const css = readFileSync(CSS_PATH, "utf8");

  it("is real, non-empty CSS", () => {
    expect(css).toContain("{");
    expect(css).toContain("}");
    expect(css.trim().length).toBeGreaterThan(0);
  });

  it("introduces no raw hex colors outside tokens.css — every color must be a var(--...) reference", () => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(withoutComments).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  function collectEmittedClasses(): Set<string> {
    const htmls = [
      renderGatewayCard(initialGatewayCardState(), { nowMs: 1 }),
      renderGatewayCard({ status: null, pairCode: null, error: "boom" }, { nowMs: 1 }),
      renderGatewayCard({ status: null, pairCode: pairView(), error: null }, { nowMs: 1 }),
      renderGatewayCard({ status: statusView(), pairCode: pairView(), error: null }, { nowMs: 1_700_000_000_000 }),
      renderGatewayCard(
        { status: statusView({ running: false, startedAt: null, engine: null }), pairCode: null, error: "still failing" },
        { nowMs: 1 }
      ),
      renderGatewayCard(
        { status: statusView({ engine: { requested: "x", mode: "mock", detail: "d" } }), pairCode: null, error: null },
        { nowMs: 1 }
      ),
      renderGatewayCard({ status: statusView({ platforms: [] }), pairCode: null, error: null }, { nowMs: 1 }),
      renderGatewayCard(
        { status: statusView(), pairCode: pairView({ level: "owner", expiresAt: 1_700_000_060_000 }), error: null },
        { nowMs: 1_700_000_000_000 } // active
      ),
      renderGatewayCard(
        { status: statusView(), pairCode: pairView({ expiresAt: 1_700_000_000_000 }), error: null },
        { nowMs: 1_700_000_060_000 } // expired
      ),
      renderProbeRows([probeView({ mode: "real" }), probeView({ mode: "offline" })]),
      renderProbeRows([]),
      renderCounters(countersView()),
      renderPairCode(null, 1),
    ];

    const classNames = new Set<string>();
    for (const html of htmls) {
      for (const match of html.matchAll(/class="([^"]*)"/g)) {
        for (const cls of match[1].split(/\s+/).filter(Boolean)) {
          classNames.add(cls);
        }
      }
    }
    return classNames;
  }

  function collectCssSelectorClasses(): Set<string> {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const classNames = new Set<string>();
    // Matches `.some-class` (and `.some-class--modifier`) tokens anywhere a
    // selector would use them; excludes pseudo-classes/elements which never
    // start with a class-name character sequence following a dot immediately
    // after another identifier char (not a concern here — plain `.foo` shape
    // only, matching the fleet-view.ts precedent's selector regex family).
    for (const match of withoutComments.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) {
      classNames.add(match[1]);
    }
    return classNames;
  }

  it("every class name emitted by renderGatewayCard/renderProbeRows/renderCounters/renderPairCode has a matching selector in gateway-card.css", () => {
    const emitted = collectEmittedClasses();
    expect(emitted.size).toBeGreaterThan(10);

    const cssClasses = collectCssSelectorClasses();
    for (const cls of emitted) {
      expect(cssClasses.has(cls), `expected gateway-card.css to define a selector for .${cls}`).toBe(true);
    }
  });

  it("every gateway-* class defined in gateway-card.css is actually emitted by the TS module (no dead CSS)", () => {
    const emitted = collectEmittedClasses();
    const cssClasses = collectCssSelectorClasses();
    for (const cls of cssClasses) {
      if (!cls.startsWith("gateway-")) continue;
      expect(emitted.has(cls), `expected gateway-card.ts to emit .${cls} somewhere (found only in CSS)`).toBe(true);
    }
  });
});
