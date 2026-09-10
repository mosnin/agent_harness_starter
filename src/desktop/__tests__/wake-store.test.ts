import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WakeStore } from "../core/wake-store";

const dirs: string[] = [], stores: WakeStore[] = [];
afterEach(() => { for (const store of stores) store.close(); stores.length = 0; for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.length = 0; });
const task = { job: "daily", profile: "writer", root: "/project", name: "Daily", prompt: "Inspect changes" };
function setup() { const dir = mkdtempSync(join(tmpdir(), "hades-wakes-")); dirs.push(dir); let now = 1000; const path = join(dir, "wakes.sqlite"); const open = () => { const store = new WakeStore(path, () => now); stores.push(store); return store; }; return { open, advance: (ms: number) => { now += ms; } }; }
describe("durable wake inbox", () => {
  it("deduplicates persisted occurrences and rejects changed content", () => {
    const { open } = setup(), a = open();
    const wake = a.enqueue("schedule", "daily:1000", task);
    const b = open();
    expect(b.enqueue("schedule", "daily:1000", { ...task })).toEqual(wake);
    expect(() => b.enqueue("schedule", "daily:1000", { ...task, prompt: "Different action" })).toThrow("different content");
    expect(b.all()).toHaveLength(1);
  });
  it("allows one active owner per profile across independent connections", () => {
    const { open } = setup(), a = open(), b = open();
    a.enqueue("schedule", "first", task); a.enqueue("schedule", "second", task);
    const first = a.claim("worker-a")!;
    expect(b.claim("worker-b")).toBeUndefined();
    expect(a.settle(first, "completed")).toBe(true);
    expect(b.claim("worker-b")?.id).not.toBe(first.id);
  });
  it("quarantines expired effects and fences stale completion and renewal", () => {
    const { open, advance } = setup(), a = open(), b = open();
    a.enqueue("hook", "event-1", task);
    const running = a.claim("worker-a", 100)!;
    expect(a.bind(running, "saved-session")).toBe(true);
    advance(100);
    expect(b.claim("worker-b")).toBeUndefined();
    expect(b.get(running.id)).toMatchObject({ status: "interrupted", session: "saved-session" });
    expect(a.settle(running, "completed")).toBe(false);
    expect(a.renew(running)).toBe(false);
  });
  it("persists cancellation and rejects stale success", () => {
    const { open } = setup(), a = open();
    const queued = a.enqueue("peer", "message-1", task);
    const running = a.claim("worker")!;
    expect(a.cancel(queued.id)).toBe(true);
    expect(a.settle(running, "completed")).toBe(false);
    expect(open().get(queued.id)?.status).toBe("cancelled");
  });
  it("respects due times and persists work before dispatch", () => {
    const { open, advance } = setup();
    open().enqueue("schedule", "future", task, 2000);
    const restarted = open(); expect(restarted.claim("worker")).toBeUndefined();
    advance(1000); expect(restarted.claim("worker")?.task).toEqual(task);
  });
  it("only interrupts the closing owner's work", () => {
    const { open } = setup(), a = open();
    a.enqueue("manual", "one", task); a.enqueue("manual", "two", { ...task, profile: "reviewer" });
    const one = a.claim("first")!, two = a.claim("second")!;
    a.interruptOwner("first");
    expect(a.get(one.id)?.status).toBe("interrupted");
    expect(a.get(two.id)?.status).toBe("running");
  });
});
