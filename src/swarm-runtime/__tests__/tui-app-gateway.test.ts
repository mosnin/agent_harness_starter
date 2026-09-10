/**
 * Central-integration tests for the GATEWAY pane inside TuiApp: the `w` key
 * toggles the pane (asking central wiring for a fresh probe on open), the
 * pane renders the honest empty states until real data arrives, feed/apply
 * methods drive the pure gateway-pane reducers, navigation keys scroll the
 * TRAFFIC feed, and esc/q returns to the dashboard.
 */
import { describe, it, expect, vi } from "vitest";
import { TuiApp } from "../tui/app";
import { keyToAction } from "../tui/keymap";
import type { GatewayPaneTrafficRow } from "../tui/gateway-pane";

function traffic(i: number): GatewayPaneTrafficRow {
  return { direction: i % 2 === 0 ? "in" : "out", platform: "telegram", user: `u${i}`, preview: `msg ${i}`, at: i };
}

describe("keymap: w toggles the GATEWAY pane", () => {
  it("maps w to the gateway pane action in view mode, and to plain input in compose mode", () => {
    expect(keyToAction("w", "view")).toEqual({ kind: "pane", pane: "gateway" });
    expect(keyToAction("w", "compose")).toEqual({ kind: "input", char: "w" });
  });
});

describe("TuiApp: GATEWAY pane", () => {
  it("w opens the pane (requesting a refresh from central wiring), renders honest empties, and w/esc/q leave it", () => {
    const refreshGateway = vi.fn();
    const app = new TuiApp({
      controller: {
        dispatchGoal: () => {},
        scalePool: () => {},
        cancel: () => {},
        refreshGateway,
      },
    });

    expect(app.activePane()).toBe("dashboard");
    app.handleKey("w");
    expect(app.activePane()).toBe("gateway");
    expect(refreshGateway).toHaveBeenCalledTimes(1);

    const frame = app.frame();
    expect(frame).toContain("GATEWAY");
    expect(frame).toContain("no connectors probed yet");
    expect(frame).toContain("engine: not attached");
    expect(frame).toContain("no traffic yet");
    expect(frame).toContain("no assessed replies yet");
    // Footer switched to the pane's own hints.
    expect(frame).toContain("[r] refresh");

    // r while open re-requests fresh data.
    app.handleKey("r");
    expect(refreshGateway).toHaveBeenCalledTimes(2);

    // Toggle back with w; reopen; escape out; reopen; q backs out (never quits from the pane).
    app.handleKey("w");
    expect(app.activePane()).toBe("dashboard");
    app.handleKey("w");
    app.handleKey("\x1b");
    expect(app.activePane()).toBe("dashboard");
    app.handleKey("w");
    const res = app.handleKey("q");
    expect(res.quit).toBeUndefined();
    expect(app.activePane()).toBe("dashboard");
    expect(refreshGateway).toHaveBeenCalledTimes(4); // one per open
  });

  it("applyGatewayStatus feeds real probe/engine rows into the frame — a mock engine always shows the literal word mock", () => {
    const app = new TuiApp({});
    app.handleKey("w");
    app.applyGatewayStatus({
      probes: [
        { platform: "telegram", mode: "offline", detail: "missing HADES_TELEGRAM_TOKEN, TELEGRAM_BOT_TOKEN" },
        { platform: "slack", mode: "real", detail: "via HADES_SLACK_TOKEN" },
      ],
      counters: { inbound: 3, outbound: 2, rateLimited: 1 },
      engine: { requested: "echo", mode: "mock", detail: "using the mock echo engine" },
    });

    const frame = app.frame();
    expect(frame).toContain("PLATFORMS (2)");
    expect(frame).toContain("telegram");
    expect(frame).toContain("missing HADES_TELEGRAM_TOKEN");
    expect(frame).toContain("via HADES_SLACK_TOKEN");
    expect(frame).toContain("in=3");
    expect(frame).toContain("out=2");
    expect(frame).toContain("limited=1");
    expect(frame).toContain("mode=mock");
    expect(frame).not.toContain("no connectors probed yet");
  });

  it("traffic + badge feeds render, and navigation keys drive the TRAFFIC selection", () => {
    const app = new TuiApp({});
    app.handleKey("w");
    for (let i = 0; i < 20; i++) app.applyGatewayTraffic(traffic(i));
    app.applyGatewayBadge("verified");
    app.applyGatewayBadge("unverified");
    app.applyGatewayBadge("verified");

    expect(app.gatewayState().traffic).toHaveLength(20);
    expect(app.gatewayState().badges).toEqual({ verified: 2, abstained: 0, unverified: 1 });
    expect(app.frame()).toContain("verified=2");
    expect(app.frame()).toContain("unverified=1");

    // end jumps to the last row, home back to the first, arrows step.
    app.handleKey("end");
    expect(app.gatewayState().selected).toBe(19);
    app.handleKey("up");
    expect(app.gatewayState().selected).toBe(18);
    app.handleKey("home");
    expect(app.gatewayState().selected).toBe(0);
    app.handleKey("\x1b[B"); // ANSI down
    expect(app.gatewayState().selected).toBe(1);
    app.handleKey("pagedown");
    expect(app.gatewayState().selected).toBe(1 + app.gatewayState().height);

    // Selection marker is visible in the rendered TRAFFIC section.
    expect(app.frame()).toContain("▸");
  });

  it("gateway keys never leak into the dashboard: after leaving the pane, w-nav keys act on tasks again", () => {
    const app = new TuiApp({});
    app.setState({ tasks: [{ description: "a", status: "pending" }, { description: "b", status: "pending" }] });
    app.handleKey("w");
    app.handleKey("q"); // back to dashboard
    const before = app.frame();
    app.handleKey("down"); // dashboard nav, not pane nav
    expect(app.activePane()).toBe("dashboard");
    expect(before).toContain("[w] gateway"); // dashboard footer advertises the pane
  });

  it("compose mode is never hijacked by the pane: typing w composes text", () => {
    const app = new TuiApp({});
    app.handleKey("g"); // compose mode
    app.handleKey("w");
    app.handleKey("o");
    app.handleKey("w");
    expect(app.mode()).toBe("compose");
    expect(app.activePane()).toBe("dashboard");
    expect(app.frame()).toContain("> goal: wow");
  });
});
