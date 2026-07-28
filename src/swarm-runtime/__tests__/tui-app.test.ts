import { describe, it, expect, vi, type Mock } from "vitest";
import { TuiApp, type TuiController } from "../tui/app";
import { keyToAction } from "../tui/keymap";
import type { TuiState } from "../tui/render";

const sample: TuiState = {
  mode: "docker",
  groundingRate: 0.92,
  metrics: {
    goals: { total: 3, completed: 2, failed: 0, aborted: 0, running: 1 },
    tasks: { total: 9, verified: 7, failed: 0, pending: 1, dispatched: 1 },
    workers: { total: 3, idle: 2, busy: 1, killed: 0, dead: 0 },
    verification: { total: 8, accepted: 7, rejected: 1, avgScore: 0.88, groundingRate: 0.92 },
    usage: { toolCalls: 24, costUsd: 0.0123 },
  },
  workers: [
    { workerId: "w-1", status: "idle", capabilities: ["research"] },
    { workerId: "w-2", status: "busy", capabilities: ["code"] },
  ],
  tasks: [
    { description: "Investigate the objective from the research angle", status: "verified" },
    { description: "Synthesize a grounded answer", status: "dispatched" },
  ],
  logs: [{ workerId: "w-2", line: "running task ab12" }],
};

function fakeController(): TuiController & {
  // Typed mocks: `vi.fn<Signature>()` keeps the spy assignable to the real
  // callback type. A bare `vi.fn()` widens to `Mock<Procedure>`, which no
  // longer satisfies the concrete handler signatures these stand in for.
  dispatchGoal: Mock<(objective: string) => void>;
  scalePool: Mock<(delta: number) => void>;
  cancel: Mock<() => void>;
} {
  return {
    dispatchGoal: vi.fn<(objective: string) => void>(),
    scalePool: vi.fn<(delta: number) => void>(),
    cancel: vi.fn<() => void>(),
  };
}

describe("keyToAction", () => {
  it("maps view-mode single keys to commands", () => {
    expect(keyToAction("g", "view")).toEqual({ kind: "dispatch", objective: "" });
    expect(keyToAction("+", "view")).toEqual({ kind: "scale", delta: 1 });
    expect(keyToAction("-", "view")).toEqual({ kind: "scale", delta: -1 });
    expect(keyToAction("c", "view")).toEqual({ kind: "cancel" });
    expect(keyToAction("?", "view")).toEqual({ kind: "toggle-help" });
    expect(keyToAction("q", "view")).toEqual({ kind: "quit" });
    expect(keyToAction("\x03", "view")).toEqual({ kind: "quit" });
    expect(keyToAction("\x1b[B", "view")).toEqual({ kind: "nav", dir: 1 });
    expect(keyToAction("\x1b[A", "view")).toEqual({ kind: "nav", dir: -1 });
  });

  it("maps compose-mode keys to input/submit/backspace/quit", () => {
    expect(keyToAction("a", "compose")).toEqual({ kind: "input", char: "a" });
    expect(keyToAction("\r", "compose")).toEqual({ kind: "submit" });
    expect(keyToAction("\x7f", "compose")).toEqual({ kind: "backspace" });
    expect(keyToAction("\x03", "compose")).toEqual({ kind: "quit" });
  });
});

describe("TuiApp", () => {
  it("starts in view mode", () => {
    const app = new TuiApp();
    expect(app.mode()).toBe("view");
  });

  it("'g' enters compose mode, typing builds the objective, Enter submits and returns to view", () => {
    const controller = fakeController();
    const app = new TuiApp({ controller });

    app.handleKey("g");
    expect(app.mode()).toBe("compose");

    for (const ch of "fix the bug") app.handleKey(ch);
    expect(app.frame()).toContain("fix the bug");

    const result = app.handleKey("\r");
    expect(result.quit).toBeUndefined();
    expect(app.mode()).toBe("view");
    expect(controller.dispatchGoal).toHaveBeenCalledWith("fix the bug");
  });

  it("backspace edits the compose buffer", () => {
    const controller = fakeController();
    const app = new TuiApp({ controller });

    app.handleKey("g");
    for (const ch of "hello") app.handleKey(ch);
    app.handleKey("\x7f");
    app.handleKey("\x7f");
    app.handleKey("\r");

    expect(controller.dispatchGoal).toHaveBeenCalledWith("hel");
  });

  it("'+' and '-' call scalePool with +1/-1", () => {
    const controller = fakeController();
    const app = new TuiApp({ controller });

    app.handleKey("+");
    app.handleKey("-");
    app.handleKey("-");

    expect(controller.scalePool).toHaveBeenNthCalledWith(1, 1);
    expect(controller.scalePool).toHaveBeenNthCalledWith(2, -1);
    expect(controller.scalePool).toHaveBeenNthCalledWith(3, -1);
  });

  it("'c' in view mode calls controller.cancel", () => {
    const controller = fakeController();
    const app = new TuiApp({ controller });

    app.handleKey("c");
    expect(controller.cancel).toHaveBeenCalledTimes(1);
  });

  it("'q' and Ctrl-C return {quit:true}", () => {
    const app = new TuiApp();
    expect(app.handleKey("q")).toEqual({ quit: true });
    expect(app.handleKey("\x03")).toEqual({ quit: true });
  });

  it("frame() contains the rendered swarm state plus a footer of keybindings", () => {
    const app = new TuiApp({ width: 72 });
    app.setState(sample);
    const out = app.frame();

    expect(out).toContain("HERMES·SWARM");
    expect(out).toContain("w-1");
    expect(out).toContain("Synthesize a grounded answer");
    expect(out).toContain("[q] quit");
    expect(out).toContain("[g] new goal");
  });

  it("'?' toggles a help overlay in and out of frame()", () => {
    const app = new TuiApp();
    app.setState(sample);

    expect(app.frame()).not.toContain("HELP");
    app.handleKey("?");
    expect(app.frame()).toContain("HELP");
    app.handleKey("?");
    expect(app.frame()).not.toContain("HELP");
  });

  it("Escape in compose mode cancels back to view without dispatching", () => {
    const controller = fakeController();
    const app = new TuiApp({ controller });

    app.handleKey("g");
    app.handleKey("x");
    app.handleKey("\x1b");

    expect(app.mode()).toBe("view");
    expect(controller.dispatchGoal).not.toHaveBeenCalled();
  });
});
