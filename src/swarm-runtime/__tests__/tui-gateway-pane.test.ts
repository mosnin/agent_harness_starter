import { describe, it, expect } from "vitest";
import {
  gatewayPaneInit,
  gatewayPaneApplyStatus,
  gatewayPaneAppendTraffic,
  gatewayPaneApplyBadge,
  gatewayPaneKey,
  renderGatewayPane,
  sanitizePreview,
  type GatewayPaneState,
  type GatewayPaneProbeRow,
  type GatewayPaneCounters,
  type GatewayPaneTrafficRow,
  type GatewayPaneEngineRow,
} from "../tui/gateway-pane";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const probes: GatewayPaneProbeRow[] = [
  { platform: "telegram", mode: "real", detail: "via HADES_TELEGRAM_TOKEN" },
  { platform: "discord", mode: "offline", detail: "missing HADES_DISCORD_TOKEN" },
  { platform: "email", mode: "real", detail: "via HADES_EMAIL_ADDRESS, HADES_EMAIL_IMAP_HOST" },
];

const counters: GatewayPaneCounters = { inbound: 42, outbound: 17, rateLimited: 3 };

const engine: GatewayPaneEngineRow = {
  requested: "hades-default",
  mode: "real",
  detail: "resolved via HADES_ENGINE_URL",
};

const mockEngine: GatewayPaneEngineRow = {
  requested: "hades-default",
  mode: "mock",
  detail: "no engine URL configured; using deterministic mock",
};

function trafficRow(i: number, overrides: Partial<GatewayPaneTrafficRow> = {}): GatewayPaneTrafficRow {
  return {
    direction: i % 2 === 0 ? "in" : "out",
    platform: "telegram",
    user: `user-${i}`,
    preview: `message body ${i}`,
    at: 1_700_000_000_000 + i,
    ...overrides,
  };
}

function trafficList(n: number): GatewayPaneTrafficRow[] {
  return Array.from({ length: n }, (_, i) => trafficRow(i));
}

function fullState(overrides: Partial<GatewayPaneState> = {}): GatewayPaneState {
  return {
    probes,
    counters,
    engine,
    traffic: trafficList(5),
    badges: { verified: 10, abstained: 2, unverified: 1 },
    selected: 0,
    scroll: 0,
    height: 6,
    ...overrides,
  };
}

const CONTROL_OR_ESC_RE = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const codePointLen = (s: string) => [...s].length;

function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === "object") {
    Object.getOwnPropertyNames(obj).forEach((key) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const value = (obj as any)[key];
      if (value !== null && typeof value === "object") deepFreeze(value);
    });
    Object.freeze(obj);
  }
  return obj;
}

// ---------------------------------------------------------------------------
// gatewayPaneInit
// ---------------------------------------------------------------------------

describe("gatewayPaneInit", () => {
  it("starts with no probes, zeroed real counters, no engine, no traffic, and no badge assessments", () => {
    const st = gatewayPaneInit();
    expect(st.probes).toEqual([]);
    expect(st.counters).toEqual({ inbound: 0, outbound: 0, rateLimited: 0 });
    expect(st.engine).toBeNull();
    expect(st.traffic).toEqual([]);
    expect(st.badges).toBeNull();
    expect(st.selected).toBe(0);
    expect(st.scroll).toBe(0);
    expect(st.height).toBeGreaterThan(0);
  });

  it("honors a custom height and floors/clamps to >= 1", () => {
    expect(gatewayPaneInit(12).height).toBe(12);
    expect(gatewayPaneInit(0).height).toBe(1);
    expect(gatewayPaneInit(-5).height).toBe(1);
    expect(gatewayPaneInit(3.9).height).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// sanitizePreview
// ---------------------------------------------------------------------------

describe("sanitizePreview", () => {
  it("passes through plain text unchanged when under the cap", () => {
    expect(sanitizePreview("hello world", 100)).toBe("hello world");
  });

  it("strips ESC and other C0 control characters, leaving surrounding text intact", () => {
    const withAnsi = "\x1b[31mred\x1b[0m text";
    const out = sanitizePreview(withAnsi, 100);
    expect(out).not.toMatch(CONTROL_OR_ESC_RE);
    expect(out).toContain("red");
    expect(out).toContain("text");
    expect(out).toBe("[31mred[0m text");
  });

  it("strips C1 control characters", () => {
    const out = sanitizePreview("abc", 100);
    expect(out).toBe("abc");
  });

  it("collapses \\n, \\r, and \\r\\n to a single ⏎", () => {
    expect(sanitizePreview("a\nb", 100)).toBe("a⏎b");
    expect(sanitizePreview("a\rb", 100)).toBe("a⏎b");
    expect(sanitizePreview("a\r\nb", 100)).toBe("a⏎b");
    expect(sanitizePreview("a\r\n\r\nb", 100)).toBe("a⏎⏎b");
  });

  it("truncates by code point, appending … only when truncation actually happened", () => {
    expect(sanitizePreview("hello", 5)).toBe("hello");
    expect(sanitizePreview("hello!", 5)).toBe("hell…");
    expect(codePointLen(sanitizePreview("hello!", 5))).toBe(5);
  });

  it("truncates multi-code-point emoji without splitting a surrogate pair", () => {
    const flood = "🚀".repeat(50); // each 🚀 is one code point (surrogate pair in UTF-16)
    const out = sanitizePreview(flood, 10);
    expect(codePointLen(out)).toBe(10);
    expect(out.endsWith("…")).toBe(true);
    // no lone surrogate at the cut point
    expect(out).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("handles max <= 0 by returning an empty string", () => {
    expect(sanitizePreview("hello", 0)).toBe("");
    expect(sanitizePreview("hello", -3)).toBe("");
  });

  it("handles max === 1 by returning exactly the ellipsis when truncation is needed", () => {
    expect(sanitizePreview("hello", 1)).toBe("…");
    expect(sanitizePreview("h", 1)).toBe("h");
  });

  it("does not crash on lone surrogates and never lets one survive as a raw control byte", () => {
    const lone = "a\uD800b\uDFFFc";
    const out = sanitizePreview(lone, 100);
    expect(out).not.toMatch(CONTROL_OR_ESC_RE);
  });
});

// ---------------------------------------------------------------------------
// renderGatewayPane — empty-state honesty
// ---------------------------------------------------------------------------

describe("renderGatewayPane — empty state honesty", () => {
  it('renders "no connectors probed yet" for an empty probes list', () => {
    const st = gatewayPaneInit();
    const out = renderGatewayPane(st);
    expect(out.some((l) => l.includes("no connectors probed yet"))).toBe(true);
  });

  it('renders "no traffic yet" for an empty traffic feed', () => {
    const st = gatewayPaneInit();
    const out = renderGatewayPane(st);
    expect(out.some((l) => l.includes("no traffic yet"))).toBe(true);
  });

  it('renders "engine: not attached" when engine is null', () => {
    const st = gatewayPaneInit();
    const out = renderGatewayPane(st);
    expect(out.some((l) => l.includes("engine: not attached"))).toBe(true);
  });

  it('renders "no assessed replies yet" when badges is null (never a fabricated 0/0/0)', () => {
    const st = gatewayPaneInit();
    const out = renderGatewayPane(st);
    expect(out.some((l) => l.includes("no assessed replies yet"))).toBe(true);
    expect(out.some((l) => l.includes("verified=0"))).toBe(false);
  });

  it("a real, counted 0/0/0 tally after assessment renders distinctly from the null case", () => {
    const st: GatewayPaneState = { ...gatewayPaneInit(), badges: { verified: 0, abstained: 0, unverified: 0 } };
    const out = renderGatewayPane(st);
    expect(out.some((l) => l.includes("no assessed replies yet"))).toBe(false);
    expect(out.some((l) => l.includes("verified=0") && l.includes("abstained=0") && l.includes("unverified=0"))).toBe(
      true
    );
  });

  it("is deterministic for the empty state", () => {
    const a = renderGatewayPane(gatewayPaneInit());
    const b = renderGatewayPane(gatewayPaneInit());
    expect(a).toEqual(b);
  });

  for (const width of [40, 72, 100]) {
    it(`clamps every line to <= width=${width} for the empty state`, () => {
      const out = renderGatewayPane(gatewayPaneInit(), width);
      for (const line of out) expect(codePointLen(line)).toBeLessThanOrEqual(width);
    });
  }
});

// ---------------------------------------------------------------------------
// renderGatewayPane — populated state
// ---------------------------------------------------------------------------

describe("renderGatewayPane — populated state", () => {
  it("headers report real section counts", () => {
    const out = renderGatewayPane(fullState()).join("\n");
    expect(out).toContain(`PLATFORMS (${probes.length})`);
    expect(out).toContain(`TRAFFIC (${trafficList(5).length})`);
  });

  it("prints counters verbatim from the snapshot, never derived", () => {
    const out = renderGatewayPane(fullState()).join("\n");
    expect(out).toContain("in=42");
    expect(out).toContain("out=17");
    expect(out).toContain("limited=3");
  });

  it("prints large counter values verbatim without truncation corruption", () => {
    const bigCounters: GatewayPaneCounters = { inbound: 123456789, outbound: 987654321, rateLimited: 555000111 };
    const out = renderGatewayPane(fullState({ counters: bigCounters }), 120).join("\n");
    expect(out).toContain("in=123456789");
    expect(out).toContain("out=987654321");
    expect(out).toContain("limited=555000111");
  });

  it("renders each probe's real mode (real/offline) and detail, never fabricated", () => {
    const out = renderGatewayPane(fullState(), 120).join("\n");
    expect(out).toMatch(/telegram\s+real/);
    expect(out).toMatch(/discord\s+offline/);
    expect(out).toContain("missing HADES_DISCORD_TOKEN");
  });

  it("renders an attached real engine honestly", () => {
    const out = renderGatewayPane(fullState({ engine }), 120).join("\n");
    expect(out).toContain("requested=hades-default");
    expect(out).toContain("mode=real");
  });

  it('a mock engine is never displayed without the literal word "mock"', () => {
    const out = renderGatewayPane(fullState({ engine: mockEngine }), 120).join("\n");
    expect(out).toContain("mode=mock");
    expect(out).not.toContain("mode=real");
  });

  it("renders the real badge tally verbatim", () => {
    const out = renderGatewayPane(fullState(), 120).join("\n");
    expect(out).toContain("verified=10");
    expect(out).toContain("abstained=2");
    expect(out).toContain("unverified=1");
  });

  it("marks the selected traffic row with ▸", () => {
    const st = fullState({ traffic: trafficList(5), selected: 2, scroll: 0, height: 6 });
    const out = renderGatewayPane(st, 120);
    const selLine = out.find((l) => l.includes("user-2"));
    expect(selLine).toBeDefined();
    expect(selLine).toContain("▸");
    const otherLine = out.find((l) => l.includes("user-0"));
    expect(otherLine).not.toContain("▸");
  });

  it("renders traffic direction honestly (IN vs OUT)", () => {
    const st = fullState({
      traffic: [trafficRow(0, { direction: "in" }), trafficRow(1, { direction: "out" })],
      selected: 0,
      scroll: 0,
      height: 6,
    });
    const out = renderGatewayPane(st, 120);
    expect(out.find((l) => l.includes("user-0"))).toMatch(/IN /);
    expect(out.find((l) => l.includes("user-1"))).toMatch(/OUT/);
  });

  it("renders the traffic event's `at` timestamp verbatim", () => {
    const st = fullState({ traffic: [trafficRow(0, { at: 1_700_000_012_345 })], selected: 0, scroll: 0, height: 6 });
    const out = renderGatewayPane(st, 120).join("\n");
    expect(out).toContain("1700000012345");
  });

  it("is deterministic for a populated state", () => {
    const a = renderGatewayPane(fullState());
    const b = renderGatewayPane(fullState());
    expect(a).toEqual(b);
  });

  for (const width of [40, 72, 100]) {
    it(`clamps every line to <= width=${width} for a populated state`, () => {
      const out = renderGatewayPane(fullState(), width);
      for (const line of out) expect(codePointLen(line)).toBeLessThanOrEqual(width);
    });
  }
});

// ---------------------------------------------------------------------------
// Width-clamp property test across widths with hostile content
// ---------------------------------------------------------------------------

describe("renderGatewayPane — width discipline under adversarial input", () => {
  const ansiUser = "\x1b[31mred-alert-user\x1b[0m";
  const boxDrawUser = "╭─│├┤╰─╯" + "─".repeat(50);
  const emojiFlood = "🔥".repeat(4000);
  const cjk = "危険なメッセージ本文をここに書き込んでテストする文字列連続体";
  const loneSurrogates = "lead\uD800tail\uDFFFend";

  const hostileState: GatewayPaneState = {
    probes: [
      { platform: ansiUser, mode: "real", detail: emojiFlood },
      { platform: cjk, mode: "offline", detail: loneSurrogates },
      { platform: boxDrawUser, mode: "real", detail: "y".repeat(500) },
    ],
    counters: { inbound: 999999, outbound: 888888, rateLimited: 777777 },
    engine: { requested: ansiUser, mode: "mock", detail: cjk },
    traffic: [
      { direction: "in", platform: ansiUser, user: boxDrawUser, preview: emojiFlood, at: 1_700_000_000_000 },
      { direction: "out", platform: cjk, user: loneSurrogates, preview: "x\x1b[2Jclear\x07bell", at: 1_700_000_000_001 },
      { direction: "in", platform: "p3", user: "u3", preview: "多行\nメッセージ\r\nテスト", at: 1_700_000_000_002 },
    ],
    badges: { verified: 1, abstained: 0, unverified: 0 },
    selected: 0,
    scroll: 0,
    height: 4,
  };

  for (const width of [20, 24, 32, 40, 56, 72, 90, 100, 120]) {
    it(`hard-clamps every line to <= width=${width} and strips every control byte`, () => {
      const out = renderGatewayPane(hostileState, width);
      expect(out.length).toBeGreaterThan(0);
      for (const line of out) {
        expect(codePointLen(line)).toBeLessThanOrEqual(width);
        expect(line).not.toMatch(CONTROL_OR_ESC_RE);
      }
    });
  }

  it("never emits a raw ESC byte anywhere in the frame regardless of width", () => {
    for (const width of [20, 72, 120]) {
      const out = renderGatewayPane(hostileState, width);
      for (const line of out) expect(line).not.toContain("\x1b");
    }
  });
});

// ---------------------------------------------------------------------------
// gatewayPaneApplyStatus
// ---------------------------------------------------------------------------

describe("gatewayPaneApplyStatus", () => {
  it("replaces probes and counters wholesale", () => {
    const st = gatewayPaneInit();
    const next = gatewayPaneApplyStatus(st, { probes, counters });
    expect(next.probes).toEqual(probes);
    expect(next.counters).toEqual(counters);
  });

  it("sets engine when the snapshot explicitly supplies it", () => {
    const st = gatewayPaneInit();
    const next = gatewayPaneApplyStatus(st, { probes, counters, engine });
    expect(next.engine).toEqual(engine);
  });

  it("sets engine to null when the snapshot explicitly supplies null", () => {
    const st = gatewayPaneApplyStatus(gatewayPaneInit(), { probes, counters, engine });
    const next = gatewayPaneApplyStatus(st, { probes, counters, engine: null });
    expect(next.engine).toBeNull();
  });

  it("leaves engine untouched when the snapshot omits the engine key entirely", () => {
    const st = gatewayPaneApplyStatus(gatewayPaneInit(), { probes, counters, engine });
    const next = gatewayPaneApplyStatus(st, { probes, counters });
    expect(next.engine).toEqual(engine);
  });

  it("is pure: returns a new object and never mutates state or the snapshot (deep-frozen)", () => {
    const before = gatewayPaneInit();
    const beforeCopy = JSON.parse(JSON.stringify(before));
    const snapshot = deepFreeze({ probes: probes.map((p) => ({ ...p })), counters: { ...counters }, engine: { ...engine } });
    const next = gatewayPaneApplyStatus(before, snapshot);
    expect(next).not.toBe(before);
    expect(before).toEqual(beforeCopy);
    expect(next.probes).toEqual(probes);
  });
});

// ---------------------------------------------------------------------------
// gatewayPaneAppendTraffic
// ---------------------------------------------------------------------------

describe("gatewayPaneAppendTraffic", () => {
  it("appends to the end of the feed, preserving chronological order", () => {
    let st = gatewayPaneInit();
    st = gatewayPaneAppendTraffic(st, trafficRow(0));
    st = gatewayPaneAppendTraffic(st, trafficRow(1));
    expect(st.traffic.map((r) => r.user)).toEqual(["user-0", "user-1"]);
  });

  it("evicts the oldest row once the cap is exceeded, preserving order of survivors", () => {
    let st = gatewayPaneInit();
    for (let i = 0; i < 5; i++) st = gatewayPaneAppendTraffic(st, trafficRow(i), 3);
    expect(st.traffic.map((r) => r.user)).toEqual(["user-2", "user-3", "user-4"]);
    // the specific evicted rows are gone
    expect(st.traffic.find((r) => r.user === "user-0")).toBeUndefined();
    expect(st.traffic.find((r) => r.user === "user-1")).toBeUndefined();
    expect(st.traffic.length).toBe(3);
  });

  it("defaults the cap to 200", () => {
    let st = gatewayPaneInit();
    for (let i = 0; i < 250; i++) st = gatewayPaneAppendTraffic(st, trafficRow(i));
    expect(st.traffic.length).toBe(200);
    expect(st.traffic[0].user).toBe("user-50");
    expect(st.traffic[199].user).toBe("user-249");
  });

  it("shifts selection left by the eviction count to track the same logical row where possible", () => {
    let st: GatewayPaneState = { ...gatewayPaneInit(5), traffic: trafficList(5), selected: 4, scroll: 0 };
    // cap to 5: appending a 6th row evicts exactly 1 (the oldest, user-0)
    st = gatewayPaneAppendTraffic(st, trafficRow(5), 5);
    expect(st.traffic.map((r) => r.user)).toEqual(["user-1", "user-2", "user-3", "user-4", "user-5"]);
    // previously-selected user-4 was at index 4; after eviction it is at index 3
    expect(st.traffic[st.selected].user).toBe("user-4");
  });

  it("keeps scroll/selection within bounds after eviction even if selection previously pointed at an evicted row", () => {
    let st: GatewayPaneState = { ...gatewayPaneInit(5), traffic: trafficList(5), selected: 0, scroll: 0 };
    st = gatewayPaneAppendTraffic(st, trafficRow(5), 5);
    expect(st.selected).toBeGreaterThanOrEqual(0);
    expect(st.selected).toBeLessThan(st.traffic.length);
    expect(st.scroll).toBeGreaterThanOrEqual(0);
  });

  it("is pure: returns a new object and never mutates state or the row (deep-frozen)", () => {
    const before = deepFreeze({ ...gatewayPaneInit(), traffic: trafficList(2) });
    const beforeCopy = JSON.parse(JSON.stringify(before));
    const row = deepFreeze(trafficRow(99));
    const next = gatewayPaneAppendTraffic(before as GatewayPaneState, row);
    expect(next).not.toBe(before);
    expect(before).toEqual(beforeCopy);
    expect(next.traffic.length).toBe(3);
    expect(next.traffic[2]).toEqual(row);
  });
});

// ---------------------------------------------------------------------------
// gatewayPaneApplyBadge
// ---------------------------------------------------------------------------

describe("gatewayPaneApplyBadge", () => {
  it("transitions badges from null to a real, counted tally on the first assessment", () => {
    const st = gatewayPaneInit();
    const next = gatewayPaneApplyBadge(st, "verified");
    expect(next.badges).toEqual({ verified: 1, abstained: 0, unverified: 0 });
  });

  it("accumulates counts across repeated assessments", () => {
    let st = gatewayPaneInit();
    st = gatewayPaneApplyBadge(st, "verified");
    st = gatewayPaneApplyBadge(st, "verified");
    st = gatewayPaneApplyBadge(st, "abstained");
    st = gatewayPaneApplyBadge(st, "unverified");
    st = gatewayPaneApplyBadge(st, "unverified");
    st = gatewayPaneApplyBadge(st, "unverified");
    expect(st.badges).toEqual({ verified: 2, abstained: 1, unverified: 3 });
  });

  it("is pure: returns a new object and never mutates state", () => {
    const before = deepFreeze({ ...gatewayPaneInit(), badges: { verified: 1, abstained: 1, unverified: 1 } });
    const beforeCopy = JSON.parse(JSON.stringify(before));
    const next = gatewayPaneApplyBadge(before as GatewayPaneState, "verified");
    expect(next).not.toBe(before);
    expect(before).toEqual(beforeCopy);
    expect(next.badges).toEqual({ verified: 2, abstained: 1, unverified: 1 });
  });
});

// ---------------------------------------------------------------------------
// gatewayPaneKey — full key matrix across feed sizes
// ---------------------------------------------------------------------------

describe("gatewayPaneKey", () => {
  const sizes = [0, 1, 6, 7, 500]; // 0, 1, exactly height, height+1, and a large feed
  const HEIGHT = 6;

  for (const n of sizes) {
    describe(`feed size ${n}`, () => {
      const base: GatewayPaneState = { ...gatewayPaneInit(HEIGHT), traffic: trafficList(n), selected: 0, scroll: 0 };

      it("selection always stays within [0, length-1] (or 0 for empty) across the full key matrix", () => {
        const keys: Array<"up" | "down" | "pageup" | "pagedown" | "home" | "end"> = [
          "up",
          "down",
          "pageup",
          "pagedown",
          "home",
          "end",
        ];
        let st = base;
        for (let i = 0; i < 20; i++) {
          const key = keys[i % keys.length];
          st = gatewayPaneKey(st, key);
          if (n === 0) {
            expect(st.selected).toBe(0);
            expect(st.scroll).toBe(0);
          } else {
            expect(st.selected).toBeGreaterThanOrEqual(0);
            expect(st.selected).toBeLessThan(n);
            expect(st.scroll).toBeGreaterThanOrEqual(0);
            expect(st.scroll).toBeLessThanOrEqual(Math.max(0, n - HEIGHT));
            // scroll always keeps the selection visible
            expect(st.selected).toBeGreaterThanOrEqual(st.scroll);
            expect(st.selected).toBeLessThan(st.scroll + HEIGHT);
          }
        }
      });

      it("home lands exactly on index 0 with scroll pinned to 0", () => {
        const st = gatewayPaneKey({ ...base, selected: Math.max(0, n - 1), scroll: Math.max(0, n - HEIGHT) }, "home");
        expect(st.selected).toBe(0);
        expect(st.scroll).toBe(0);
      });

      it("end lands exactly on the last index with scroll pinned to the bottom-most window", () => {
        const st = gatewayPaneKey(base, "end");
        if (n === 0) {
          expect(st.selected).toBe(0);
          expect(st.scroll).toBe(0);
        } else {
          expect(st.selected).toBe(n - 1);
          expect(st.scroll).toBe(Math.max(0, n - HEIGHT));
        }
      });

      it("up does not wrap below 0", () => {
        const st = gatewayPaneKey(base, "up");
        expect(st.selected).toBe(0);
      });

      it("down moves by exactly one row within bounds", () => {
        const st = gatewayPaneKey(base, "down");
        expect(st.selected).toBe(n === 0 ? 0 : Math.min(1, n - 1));
      });

      it("pagedown moves by exactly the visible window height (clamped)", () => {
        const st = gatewayPaneKey(base, "pagedown");
        if (n === 0) {
          expect(st.selected).toBe(0);
        } else {
          expect(st.selected).toBe(Math.min(HEIGHT, n - 1));
        }
      });

      it("pageup from the end moves back by exactly the visible window height (clamped)", () => {
        const atEnd = gatewayPaneKey(base, "end");
        const st = gatewayPaneKey(atEnd, "pageup");
        if (n === 0) {
          expect(st.selected).toBe(0);
        } else {
          expect(st.selected).toBe(Math.max(0, n - 1 - HEIGHT));
        }
      });

      it("is pure: returns a new object and never mutates state (deep-frozen)", () => {
        const frozen = deepFreeze({ ...base, traffic: base.traffic.map((r) => ({ ...r })) });
        const beforeCopy = JSON.parse(JSON.stringify(frozen));
        const next = gatewayPaneKey(frozen as GatewayPaneState, "down");
        expect(next).not.toBe(frozen);
        expect(frozen).toEqual(beforeCopy);
      });
    });
  }

  it("scrolling down through a large feed keeps scroll monotonically non-decreasing under repeated `down`", () => {
    let st: GatewayPaneState = { ...gatewayPaneInit(HEIGHT), traffic: trafficList(500), selected: 0, scroll: 0 };
    let lastScroll = 0;
    for (let i = 0; i < 500; i++) {
      st = gatewayPaneKey(st, "down");
      expect(st.scroll).toBeGreaterThanOrEqual(lastScroll);
      lastScroll = st.scroll;
    }
    expect(st.selected).toBe(499);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: badges tally never renders zeros that were not actually counted
// ---------------------------------------------------------------------------

describe("badge tally honesty — null vs real zero", () => {
  it("null and a real {0,0,0} tally render distinct, non-overlapping messages", () => {
    const nullOut = renderGatewayPane({ ...gatewayPaneInit() }).join("\n");
    const zeroOut = renderGatewayPane({ ...gatewayPaneInit(), badges: { verified: 0, abstained: 0, unverified: 0 } }).join(
      "\n"
    );
    expect(nullOut).toContain("no assessed replies yet");
    expect(zeroOut).not.toContain("no assessed replies yet");
    expect(zeroOut).toContain("verified=0");
    expect(zeroOut).toContain("abstained=0");
    expect(zeroOut).toContain("unverified=0");
  });
});
