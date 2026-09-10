import { describe, it, expect, vi } from "vitest";
import { createApp, type Bridge } from "../ui/renderer";
import type { Command, AppEvent } from "../ipc/contract";

/**
 * A fake `Bridge`: captures every `Command` sent by the controller, and lets
 * a test push `AppEvent`s straight through to whatever handler `createApp`
 * registered via `onEvent`, so `createApp` can be exercised end to end with
 * no real sidecar and no DOM.
 */
function makeFakeBridge() {
  const sent: Command[] = [];
  let handler: ((e: AppEvent) => void) | null = null;

  const bridge: Bridge = {
    send(cmd) {
      sent.push(cmd);
    },
    onEvent(cb) {
      handler = cb;
      return () => {
        handler = null;
      };
    },
    async start() {
      // no-op: this fake needs no wiring beyond construction
    },
    async stop() {
      handler = null;
    },
  };

  return {
    bridge,
    sent,
    push(ev: AppEvent) {
      handler?.(ev);
    },
    get subscribed() {
      return handler !== null;
    },
  };
}

describe("createApp", () => {
  it("renders the shell with the run view active by default", () => {
    const { bridge } = makeFakeBridge();
    const app = createApp(bridge);
    const html = app.html();
    expect(html).toContain('class="app-shell"');
    expect(html).toContain('class="sidebar"');
    expect(html).toContain('data-active="run"');
    expect(html).toContain("run-composer");
  });

  it("re-renders and reflects a new task after a task.upsert event", () => {
    const { bridge, push } = makeFakeBridge();
    const rendered: string[] = [];
    const app = createApp(bridge, { onRender: (html) => rendered.push(html) });

    push({
      kind: "task.upsert",
      task: {
        id: "t-1",
        description: "unique-task-marker",
        status: "pending",
        requiredCapabilities: [],
        attempts: 0,
        maxAttempts: 3,
      },
    });

    expect(app.getState().tasks).toHaveLength(1);
    expect(app.html()).toContain("unique-task-marker");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered[rendered.length - 1]).toContain("unique-task-marker");
  });

  it("switches content when setNav moves to trust", () => {
    const { bridge } = makeFakeBridge();
    const app = createApp(bridge);

    const before = app.html();
    expect(before).toContain('data-active="run"');

    app.setNav("trust");
    const after = app.html();
    expect(after).toContain('data-active="trust"');
    expect(after).toContain("trust-view__hero");
  });

  it("switches content for skills and workers nav keys", () => {
    const { bridge } = makeFakeBridge();
    const app = createApp(bridge);

    app.setNav("skills");
    expect(app.html()).toContain('class="skills view"');

    app.setNav("workers");
    expect(app.html()).toContain("Worker pool");
  });

  it("dispatchIntent sends a goal.dispatch Command via the bridge", () => {
    const { bridge, sent } = makeFakeBridge();
    const app = createApp(bridge);

    app.dispatchIntent({ cmd: "goal.dispatch", value: "do X" });

    expect(sent).toEqual([{ kind: "goal.dispatch", objective: "do X" }]);
  });

  it("an unknown intent sends nothing and does not throw", () => {
    const { bridge, sent } = makeFakeBridge();
    const app = createApp(bridge);

    expect(() => app.dispatchIntent({ cmd: "not.a.real.command" })).not.toThrow();
    expect(sent).toHaveLength(0);
  });

  it("calls onRender once per pushed event", () => {
    const { bridge, push } = makeFakeBridge();
    const onRender = vi.fn();
    createApp(bridge, { onRender });

    push({ kind: "runtime.status", running: true, mode: "inline", poolSize: 2 });
    push({ kind: "runtime.status", running: false, mode: "", poolSize: 0 });

    expect(onRender).toHaveBeenCalledTimes(2);
  });

  it("destroy unsubscribes from the bridge so later pushes are ignored", () => {
    const fake = makeFakeBridge();
    const app = createApp(fake.bridge);

    expect(fake.subscribed).toBe(true);
    app.destroy();
    expect(fake.subscribed).toBe(false);

    // Pushing after destroy is a no-op (handler was cleared) and must not throw.
    expect(() => fake.push({ kind: "runtime.status", running: true, mode: "inline", poolSize: 1 })).not.toThrow();
    expect(app.getState().running).toBe(false);
  });

  it("never throws when the bridge itself throws on send", () => {
    const throwingBridge: Bridge = {
      send() {
        throw new Error("sidecar pipe closed");
      },
      onEvent() {
        return () => {};
      },
      async start() {},
      async stop() {},
    };
    const app = createApp(throwingBridge);
    expect(() => app.dispatchIntent({ cmd: "goal.dispatch", value: "do X" })).not.toThrow();
  });
});
