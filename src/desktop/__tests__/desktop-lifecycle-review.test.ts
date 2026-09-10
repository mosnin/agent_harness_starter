import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// The production webhook constructor listens even with port 0. This review
// explicitly replaces it; no listening socket or provider is used.
vi.mock("../core/webhook-service", () => ({ WebhookService: class {
  pauseAdmission() { return () => {}; }
  close() {}
} }));
import { WorkbenchService } from "../core/workbench-service";
import { DesktopRequestQueue } from "../core/desktop-request-queue";
import { scheduleDesktopRequest } from "../core/desktop-request-routing";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function flush() { for (let n = 0; n < 20; n++) await Promise.resolve(); }

it.each([
  ["voice.stop", {}],
  ["spatial.workflow", { operation: "cancel", sessionId: "session", tabId: "tab", profile: "default" }],
])("review: %s cancellation reaches its handler while an unrelated mutation waits", async (method, args) => {
  const queue = new DesktopRequestQueue(), hold = deferred(), seen: string[] = [];
  const first = queue.submit({ id: "held", method: "fixture.mutation" }, "serial", () => hold.promise);
  const control = scheduleDesktopRequest(queue, { id: "stop", method: method as string, args }, {
    handle: async request => { seen.push(request.method); },
    rejected: (_request, error) => { throw error; },
  });
  try { await flush(); expect(seen).toEqual([method]); }
  finally { hold.resolve(); await Promise.all([first, control]); await queue.close(); }
});

it("review: closing from a synchronous admission callback cannot close history before that admitted call settles", async () => {
  const home = mkdtempSync(join(tmpdir(), "hades-review-lifetime-"));
  const service = new WorkbenchService(home, () => {}, { NODE_ENV: "test", HADES_WEBHOOK_PORT: "0", HADES_BROWSER_RUNTIME: "0" });
  const internal = service as any, hold = deferred();
  cleanup.push(async () => { hold.resolve(); await service.close().catch(() => {}); rmSync(home, { recursive: true, force: true }); });
  const historyClose = vi.spyOn(internal.journal, "close");
  let closing!: Promise<void>;
  const admitted = service.withMaintenanceAdmission(() => { closing = service.close(); return hold.promise; });
  try { await flush(); expect(historyClose).not.toHaveBeenCalled(); }
  finally { hold.resolve(); await admitted; await closing; }
});

it("review: thrown response sinks do not poison later scheduled requests", async () => {
  const queue = new DesktopRequestQueue(), seen: string[] = [];
  const first = scheduleDesktopRequest(queue, { id: "first", method: "fixture" }, {
    handle: async () => { throw new Error("Injected handler/output failure"); },
    rejected: () => { throw new Error("Injected error-output failure"); },
  });
  const next = scheduleDesktopRequest(queue, { id: "next", method: "fixture" }, {
    handle: async request => { seen.push(request.id); }, rejected: () => {},
  });
  await Promise.all([first, next]); expect(seen).toEqual(["next"]); await queue.close();
});

it("review: EOF begins revocation, rejects queued work and joins admitted control before draining", async () => {
  const queue = new DesktopRequestQueue(), held = deferred(), signals: AbortSignal[] = [], seen: string[] = [];
  const first = queue.submit({ id: "active", method: "fixture" }, "serial", (_r, context) => { signals.push(context.signal); return held.promise; });
  const control = queue.submit({ id: "stop", method: "chat.stop" }, "control", (_r, context) => { signals.push(context.signal); return held.promise; });
  const queued = scheduleDesktopRequest(queue, { id: "queued", method: "fixture" }, {
    handle: async () => { seen.push("unexpected execution"); }, rejected: request => { seen.push(request.id + " cancelled"); },
  });
  let drained = false; const closing = queue.close().then(() => { drained = true; });
  await queued; expect(seen).toEqual(["queued cancelled"]); expect(signals.every(signal => signal.aborted)).toBe(true); expect(drained).toBe(false);
  held.resolve(); await Promise.all([first, control, closing]); expect(drained).toBe(true);
});
