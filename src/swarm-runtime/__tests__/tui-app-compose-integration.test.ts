/**
 * Central-integration tests for this cycle's TUI capabilities as wired into
 * the real `TuiApp` (src/swarm-runtime/tui/app.ts): the multi-line compose
 * editor, slash-command autocomplete (including intent execution), durable
 * history recall (pure reducer side), the INTERRUPT overlay, and the three
 * new panes (HISTORY / VERIFY LANE / STREAM). Every test drives the real
 * `handleKey`/`frame` surface — no reducer is called in isolation here; the
 * point is that the wiring, not just the modules, works.
 */
import { describe, it, expect, vi } from "vitest";
import { TuiApp, type TuiController } from "../tui/app";
import { keyToAction } from "../tui/keymap";
import { normalizeSwarmEvent } from "../tui/tool-stream";
import { HistoryRecorder } from "../tui/history";
import type { RecallEntry } from "../tui/recall";
import type { TuiState } from "../tui/render";

const sampleState: TuiState = {
  mode: "inline",
  workers: [{ workerId: "w-1", status: "idle" }],
  tasks: [{ description: "first task", status: "verified" }],
};

function fakeController(extra: Partial<TuiController> = {}): TuiController & {
  dispatchGoal: ReturnType<typeof vi.fn>;
  scalePool: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  recordRecall: ReturnType<typeof vi.fn>;
} {
  return {
    dispatchGoal: vi.fn(),
    scalePool: vi.fn(),
    cancel: vi.fn(),
    recordRecall: vi.fn(),
    ...extra,
  } as never;
}

function type(app: TuiApp, text: string): void {
  for (const ch of text) app.handleKey(ch);
}

const entries: RecallEntry[] = [
  { text: "oldest goal", at: 1, kind: "goal" },
  { text: "/fleet", at: 2, kind: "slash" },
  { text: "newest goal", at: 3, kind: "goal" },
];

describe("compose editor wired into TuiApp", () => {
  it("multi-line editing via Alt-Enter submits the joined text and records recall", () => {
    const controller = fakeController();
    const app = new TuiApp({ controller });

    app.handleKey("g");
    type(app, "line one");
    app.handleKey("\x1b\r"); // Alt-Enter -> newline
    type(app, "line two");
    expect(app.composeState().lines).toEqual(["line one", "line two"]);

    app.handleKey("\r");
    expect(app.mode()).toBe("view");
    expect(controller.dispatchGoal).toHaveBeenCalledWith("line one\nline two");
    expect(controller.recordRecall).toHaveBeenCalledWith("line one\nline two", "goal");
  });

  it("Enter on an empty buffer submits nothing and stays in compose", () => {
    const controller = fakeController();
    const app = new TuiApp({ controller });
    app.handleKey("g");
    app.handleKey("\r");
    expect(app.mode()).toBe("compose");
    expect(controller.dispatchGoal).not.toHaveBeenCalled();
  });

  it("a trailing backslash continues the line instead of submitting", () => {
    const controller = fakeController();
    const app = new TuiApp({ controller });
    app.handleKey("g");
    type(app, "part one\\");
    app.handleKey("\r");
    expect(app.mode()).toBe("compose");
    expect(controller.dispatchGoal).not.toHaveBeenCalled();
    type(app, "part two");
    app.handleKey("\r");
    expect(controller.dispatchGoal).toHaveBeenCalledWith("part one\npart two");
  });

  it("frame() shows the compose box, cursor, and submit preview", () => {
    const app = new TuiApp({ controller: fakeController() });
    app.handleKey("g");
    type(app, "wow");
    const out = app.frame();
    expect(out).toContain("COMPOSE");
    expect(out).toContain("wow▏");
    expect(out).toContain("> goal: wow");
  });

  it("Ctrl-C in compose mode still quits", () => {
    const app = new TuiApp({ controller: fakeController() });
    app.handleKey("g");
    expect(app.handleKey("\x03")).toEqual({ quit: true });
  });
});

describe("slash-command autocomplete wired into TuiApp", () => {
  it("typing /fl opens the popup, Tab accepts the single match, Enter executes the pane intent", () => {
    const refreshFleet = vi.fn();
    const controller = fakeController({ refreshFleet });
    const app = new TuiApp({ controller });

    app.handleKey("g");
    type(app, "/fl");
    expect(app.autocompleteState().open).toBe(true);
    expect(app.frame()).toContain("/*fl*eet");

    app.handleKey("\t"); // single match -> accept directly
    expect(app.composeState().lines[0]).toBe("/fleet ");
    expect(app.autocompleteState().open).toBe(false);

    app.handleKey("\r"); // submit the completed command
    expect(app.mode()).toBe("view");
    expect(app.activePane()).toBe("fleet");
    expect(refreshFleet).toHaveBeenCalled();
    expect(controller.recordRecall).toHaveBeenCalledWith("/fleet", "slash");
    expect(controller.dispatchGoal).not.toHaveBeenCalled();
  });

  it("a fully-typed command's exact-match popup submits through on Enter (no accept deadlock)", () => {
    const app = new TuiApp({ controller: fakeController() });
    app.handleKey("g");
    type(app, "/quit");
    expect(app.autocompleteState().open).toBe(true);
    expect(app.handleKey("\r")).toEqual({ quit: true });
  });

  it("/goal with arguments dispatches them as the objective", () => {
    const controller = fakeController();
    const app = new TuiApp({ controller });
    app.handleKey("g");
    type(app, "/goal fix the leak");
    app.handleKey("\r");
    expect(app.mode()).toBe("view");
    expect(controller.dispatchGoal).toHaveBeenCalledWith("fix the leak");
  });

  it("/scale-up and /cancel execute their controller intents", () => {
    const controller = fakeController();
    const app = new TuiApp({ controller });
    app.handleKey("g");
    type(app, "/scale-up");
    app.handleKey("\r");
    expect(controller.scalePool).toHaveBeenCalledWith(1);

    app.handleKey("g");
    type(app, "/cancel");
    app.handleKey("\r");
    expect(controller.cancel).toHaveBeenCalledTimes(1);
  });

  it("/verify, /stream and /history open this cycle's panes", () => {
    for (const [cmd, pane] of [
      ["/verify", "verify"],
      ["/stream", "stream"],
      ["/history", "history"],
    ] as const) {
      const app = new TuiApp({ controller: fakeController() });
      app.handleKey("g");
      type(app, cmd);
      app.handleKey("\r");
      expect(app.activePane()).toBe(pane);
    }
  });

  it("an unknown slash command is an honest no-op: stays in compose, dispatches nothing", () => {
    const controller = fakeController();
    const app = new TuiApp({ controller });
    app.handleKey("g");
    type(app, "/nope-not-a-command");
    app.handleKey("\r");
    expect(app.mode()).toBe("compose");
    expect(controller.dispatchGoal).not.toHaveBeenCalled();
    expect(controller.recordRecall).not.toHaveBeenCalled();
  });

  it("two-stage Esc: first closes the popup, second cancels compose", () => {
    const app = new TuiApp({ controller: fakeController() });
    app.handleKey("g");
    type(app, "/f");
    expect(app.autocompleteState().open).toBe(true);
    app.handleKey("\x1b");
    expect(app.autocompleteState().open).toBe(false);
    expect(app.mode()).toBe("compose");
    app.handleKey("\x1b");
    expect(app.mode()).toBe("view");
  });
});

describe("history recall wired into TuiApp", () => {
  it("Up on a fresh empty buffer recalls newest-first; Down walks back to the draft", () => {
    const app = new TuiApp({ controller: fakeController() });
    app.setRecallEntries(entries);
    app.handleKey("g");

    app.handleKey("\x1b[A");
    expect(app.composeState().lines.join("\n")).toBe("newest goal");
    expect(app.frame()).toContain("(history 1/3)");

    app.handleKey("\x1b[A");
    expect(app.composeState().lines.join("\n")).toBe("/fleet");

    app.handleKey("\x1b[B");
    expect(app.composeState().lines.join("\n")).toBe("newest goal");

    app.handleKey("\x1b[B"); // past the newest entry -> restore the (empty) draft
    expect(app.composeState().lines.join("\n")).toBe("");
  });

  it("Up on a non-empty buffer moves the cursor, not history", () => {
    const app = new TuiApp({ controller: fakeController() });
    app.setRecallEntries(entries);
    app.handleKey("g");
    type(app, "abc");
    app.handleKey("\x1b[A");
    expect(app.composeState().lines.join("\n")).toBe("abc");
  });

  it("Ctrl-R reverse search narrows, shows the bar, and Enter accepts into the buffer", () => {
    const controller = fakeController();
    const app = new TuiApp({ controller });
    app.setRecallEntries(entries);
    app.handleKey("g");

    app.handleKey("\x12");
    expect(app.frame()).toContain("(reverse-i-search)");
    type(app, "oldest");
    expect(app.composeState().lines.join("\n")).toBe("oldest goal");

    app.handleKey("\r"); // accept the match (does not submit)
    expect(app.mode()).toBe("compose");
    expect(app.composeState().lines.join("\n")).toBe("oldest goal");
    expect(controller.dispatchGoal).not.toHaveBeenCalled();

    app.handleKey("\r"); // now submit it
    expect(controller.dispatchGoal).toHaveBeenCalledWith("oldest goal");
  });

  it("a failed search renders the honest failed bar and Esc restores the draft", () => {
    const app = new TuiApp({ controller: fakeController() });
    app.setRecallEntries(entries);
    app.handleKey("g");
    type(app, "my draft");
    app.handleKey("\x12");
    type(app, "zzz-no-match");
    expect(app.frame()).toContain("(failed reverse-i-search)");
    app.handleKey("\x1b");
    expect(app.composeState().lines.join("\n")).toBe("my draft");
    expect(app.mode()).toBe("compose");
  });
});

describe("INTERRUPT overlay wired into TuiApp", () => {
  const goal = { goalId: "g-77", objective: "ship the release" };

  it("Esc on the dashboard with no running goal opens nothing", () => {
    const app = new TuiApp({ controller: fakeController() });
    app.handleKey("\x1b");
    expect(app.interruptState().phase).toBe("idle");
    expect(app.frame()).not.toContain("INTERRUPT");
  });

  it("Esc opens the overlay on the running goal; Esc again (menu) closes it untouched", () => {
    const controller = fakeController();
    const app = new TuiApp({ controller });
    app.setActiveGoal(goal);

    app.handleKey("\x1b");
    expect(app.interruptState().phase).toBe("menu");
    const out = app.frame();
    expect(out).toContain("INTERRUPT");
    expect(out).toContain("g-77");
    expect(out).toContain("ship the release");

    app.handleKey("\x1b");
    expect(app.interruptState().phase).toBe("idle");
    expect(controller.cancel).not.toHaveBeenCalled();
    expect(controller.dispatchGoal).not.toHaveBeenCalled();
  });

  it("abort requires explicit confirmation and calls abortGoal with the goalId", () => {
    const abortGoal = vi.fn();
    const controller = fakeController({ abortGoal });
    const app = new TuiApp({ controller });
    app.setActiveGoal(goal);

    app.handleKey("\x1b");
    app.handleKey("a");
    expect(app.interruptState().phase).toBe("confirm-abort");
    expect(app.frame()).toContain("Abort goal g-77");
    expect(abortGoal).not.toHaveBeenCalled();

    app.handleKey("n"); // back out
    expect(app.interruptState().phase).toBe("menu");
    app.handleKey("a");
    app.handleKey("y"); // confirm
    expect(abortGoal).toHaveBeenCalledWith("g-77");
    expect(app.interruptState().phase).toBe("idle");
    expect(app.activeGoalInfo()).toBeNull();
  });

  it("abort falls back to controller.cancel() when abortGoal is not wired", () => {
    const controller = fakeController();
    const app = new TuiApp({ controller });
    app.setActiveGoal(goal);
    app.handleKey("\x1b");
    app.handleKey("a");
    app.handleKey("y");
    expect(controller.cancel).toHaveBeenCalledTimes(1);
  });

  it("redirect types an instruction and hands redirectGoal the locked objective format", () => {
    const redirectGoal = vi.fn();
    const controller = fakeController({ redirectGoal });
    const app = new TuiApp({ controller });
    app.setActiveGoal(goal);

    app.handleKey("\x1b");
    app.handleKey("d");
    type(app, "focus on the login bug");
    app.handleKey("\r");

    expect(redirectGoal).toHaveBeenCalledTimes(1);
    const [gid, objective] = redirectGoal.mock.calls[0] as [string, string];
    expect(gid).toBe("g-77");
    expect(objective).toContain("REDIRECT: focus on the login bug");
    expect(objective).toContain("ship the release");
    expect(controller.recordRecall).toHaveBeenCalledWith(objective, "redirect");
    expect(app.interruptState().phase).toBe("idle");
  });

  it("redirect falls back to cancel-then-dispatch (in that order) without redirectGoal", () => {
    const order: string[] = [];
    const controller = fakeController();
    controller.cancel.mockImplementation(() => order.push("cancel"));
    controller.dispatchGoal.mockImplementation(() => order.push("dispatch"));
    const app = new TuiApp({ controller });
    app.setActiveGoal(goal);

    app.handleKey("\x1b");
    app.handleKey("i");
    type(app, "new plan");
    app.handleKey("\r");
    expect(order).toEqual(["cancel", "dispatch"]);
  });

  it("the overlay closes when the goal ends underneath it", () => {
    const app = new TuiApp({ controller: fakeController() });
    app.setActiveGoal(goal);
    app.handleKey("\x1b");
    expect(app.interruptState().phase).toBe("menu");
    app.setActiveGoal(null);
    expect(app.interruptState().phase).toBe("idle");
  });

  it("/interrupt opens the overlay only while a goal is running", () => {
    const app = new TuiApp({ controller: fakeController() });
    app.handleKey("g");
    type(app, "/interrupt");
    app.handleKey("\r");
    expect(app.interruptState().phase).toBe("idle");

    app.setActiveGoal(goal);
    app.handleKey("g");
    type(app, "/interrupt");
    app.handleKey("\r");
    expect(app.interruptState().phase).toBe("menu");
  });
});

describe("STREAM pane wired into TuiApp", () => {
  it("o opens the pane and renders normalized events; f cycles the source filter", () => {
    const app = new TuiApp({ controller: fakeController() });
    const a = normalizeSwarmEvent("log", ["w-1", "hello from one"], 10);
    const b = normalizeSwarmEvent("log", ["w-2", "hello from two"], 11);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    app.applyStreamEvent(a!);
    app.applyStreamEvent(b!);

    app.handleKey("o");
    expect(app.activePane()).toBe("stream");
    const out = app.frame();
    expect(out).toContain("[LOG] w-1 hello from one");
    expect(out).toContain("[LOG] w-2 hello from two");

    app.handleKey("f");
    expect(app.toolStreamState().filter).toBe("w-1");
    expect(app.frame()).not.toContain("hello from two");

    app.handleKey("q");
    expect(app.activePane()).toBe("dashboard");
  });

  it("keymap: o maps to the stream pane in view mode, plain input in compose", () => {
    expect(keyToAction("o", "view")).toEqual({ kind: "pane", pane: "stream" });
    expect(keyToAction("o", "compose")).toEqual({ kind: "input", char: "o" });
  });
});

describe("VERIFY LANE pane wired into TuiApp", () => {
  it("v opens the lane; rulings and the tally reflect applied events; V-TPH$ stays honest", () => {
    const app = new TuiApp({ controller: fakeController() });
    app.applyVerifyEvent({ type: "run-start", at: 1000 });
    app.applyVerifyEvent({ type: "task", at: 1001, taskId: "t-1", description: "do the thing", ruling: "pending" });
    app.applyVerifyEvent({
      type: "task",
      at: 1002,
      taskId: "t-1",
      description: "do the thing",
      ruling: "accept",
      report: { verdict: "accept", score: 0.91 },
    });

    app.handleKey("v");
    expect(app.activePane()).toBe("verify");
    const out = app.frame();
    expect(out).toContain("VERIFY LANE");
    expect(out).toContain("accept=1 abstain=0 reject=0 pending=0");
    expect(out).toContain("91%");
    // No real vtph input fed yet -> honest n/a, never a fabricated figure.
    expect(out).toContain("V-TPH$ n/a (run too short)");

    app.setVtphInput({ verifiedCount: 6, wallMs: 3600000, costUsd: 2 });
    expect(app.frame()).toContain("V-TPH$ 3.0");
  });

  it("a revise verdict renders as abstain, never as accept", () => {
    const app = new TuiApp({ controller: fakeController() });
    app.applyVerifyEvent({
      type: "task",
      at: 1,
      taskId: "t-9",
      description: "shaky work",
      ruling: "accept",
      report: { verdict: "revise", score: 0.4 },
    });
    app.handleKey("v");
    expect(app.frame()).toContain("accept=0 abstain=1 reject=0 pending=0");
  });

  it("keymap: v maps to the verify pane in view mode", () => {
    expect(keyToAction("v", "view")).toEqual({ kind: "pane", pane: "verify" });
  });
});

describe("HISTORY pane wired into TuiApp", () => {
  it("h opens the run list; arrows scrub the replay of recorded frames", () => {
    const recorder = new HistoryRecorder();
    recorder.beginRun("g-1", "ship the release", 1000);
    recorder.recordFrame(sampleState, 1001);
    recorder.recordFrame({ ...sampleState, tasks: [{ description: "second task", status: "dispatched" }] }, 1002);
    recorder.endRun("completed", 2000);

    const app = new TuiApp({ controller: fakeController() });
    app.setHistoryRuns(recorder.list());

    app.handleKey("h");
    expect(app.activePane()).toBe("history");
    let out = app.frame();
    expect(out).toContain("ship the release");
    expect(out).toContain("[frame 1/2]");
    expect(out).toContain("first task"); // the replayed frame itself is rendered

    app.handleKey("\x1b[C"); // scrub right
    out = app.frame();
    expect(out).toContain("[frame 2/2]");
    expect(out).toContain("second task");

    app.handleKey("\x1b[H"); // home -> first frame
    expect(app.frame()).toContain("[frame 1/2]");
  });

  it("renders the honest empty state with no recorded runs", () => {
    const app = new TuiApp({ controller: fakeController() });
    app.handleKey("h");
    expect(app.frame()).toContain("(no goal runs recorded)");
  });

  it("keymap: h maps to the history pane in view mode", () => {
    expect(keyToAction("h", "view")).toEqual({ kind: "pane", pane: "history" });
  });
});
