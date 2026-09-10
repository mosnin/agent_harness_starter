import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkbenchService, type WorkbenchEvent } from "../core/workbench-service";
import { ExecutionJournal } from "../core/execution-journal";
import { HelmService } from "../core/helm-service";
import { HelmSourceChecks } from "../core/helm-source-checks";
vi.mock("../core/webhook-service", async () => ({ WebhookService: (await import("./fixtures/offline-webhooks")).OfflineWebhookFixture }));

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); });
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "hades-shutdown-")), events: WorkbenchEvent[] = [];
  const service = new WorkbenchService(home, event => events.push(event), { NODE_ENV: "test", HADES_WEBHOOK_PORT: "0" });
  cleanup.push(async () => { await service.close().catch(() => {}); rmSync(home, { recursive: true, force: true }); });
  return { home, service, events, internal: service as any };
}

it("revokes every producer before a checkpoint failure and waits for asynchronous cleanup", async () => {
  const f = fixture(), receipts = deferred(), turn = deferred();
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  f.internal.active.set("chat", controllers[0]); f.internal.roomRuns.set("room", controllers[1]); f.internal.spatialPending.set("capture", controllers[2]);
  f.internal.turns.set("chat", turn.promise);
  const workClose = f.internal.work.close.bind(f.internal.work);
  vi.spyOn(f.internal.work, "close").mockImplementation(() => {
    expect(controllers.every(controller => controller.signal.aborted)).toBe(true);
    workClose(); throw new Error("Injected checkpoint failure");
  });
  const codeClose = f.internal.helmCode.close.bind(f.internal.helmCode);
  vi.spyOn(f.internal.helmCode, "close").mockImplementation(async () => { await codeClose(); await receipts.promise; });
  const orcaClose = vi.spyOn(f.internal.helmOrcaRuntime, "close"), historyClose = vi.spyOn(f.internal.journal, "close");
  const closing = f.service.close(); let finished = false; void closing.catch(() => {}).then(() => { finished = true; });
  expect(f.service.close()).toBe(closing);
  expect(orcaClose).toHaveBeenCalledOnce(); expect(historyClose).not.toHaveBeenCalled();
  await expect(f.service.dispatch("work.list", {})).rejects.toThrow("closing");
  receipts.resolve(); await Promise.resolve(); expect(finished).toBe(false);
  turn.resolve(); await expect(closing).rejects.toThrow("work checkpoint");
  expect(historyClose).toHaveBeenCalledOnce();
});

it("retains a late interrupted-turn receipt before closing execution history", async () => {
  const f = fixture(); await f.service.dispatch("project.add", { path: f.home });
  const session = await f.service.dispatch("session.new", { root: f.home }) as { id: string };
  const result = deferred(); f.internal.turns.set(session.id, result.promise);
  const closing = f.service.close();
  f.internal.emit({ kind: "desktop.error", session: session.id, message: "Interrupted after the tool result was retained" });
  f.internal.emit({ kind: "desktop.done", session: session.id });
  result.resolve(); await closing;
  const journal = new ExecutionJournal(join(f.home, "execution-journal.sqlite"));
  try { expect(journal.restore("default", session.id)?.error).toContain("tool result was retained"); }
  finally { journal.close(); }
  // A late observer event after drain cannot read a closed history database.
  f.internal.progress.delete(session.id);
  expect(() => f.internal.emit({ kind: "desktop.done", session: session.id })).not.toThrow();
});

it("waits for the consistent snapshot and rejects new admission while closing", async () => {
  const f = fixture(), snapshot = deferred<string>();
  const pending = f.internal.withMaintenanceSnapshot(() => snapshot.promise);
  const workClose = vi.spyOn(f.internal.work, "close"), closing = f.service.close();
  expect(workClose).not.toHaveBeenCalled(); expect(f.service.close()).toBe(closing);
  await expect(f.service.dispatch("project.add", { path: f.home })).rejects.toThrow("closing");
  snapshot.resolve("saved"); expect(await pending).toBe("saved"); await closing;
  expect(workClose).toHaveBeenCalledOnce();
});

it("waits for an admitted non-conversation call and refuses its later child admission", async () => {
  const f = fixture(), admitted = deferred(), release = deferred();
  const call = f.service.withMaintenanceAdmission(async () => { admitted.resolve(); await release.promise; return f.service.dispatch("project.add", { path: f.home }); });
  await admitted.promise;
  const closing = f.service.close(); let finished = false; void closing.then(() => { finished = true; });
  await Promise.resolve(); expect(finished).toBe(false);
  release.resolve(); await expect(call).rejects.toThrow("closing"); await closing;
});

it("aborts all Helm workers even if the first retained run cannot be read", async () => {
  const home = mkdtempSync(join(tmpdir(), "helm-shutdown-"));
  const helm = new HelmService(home, () => {}), first = new AbortController(), second = new AbortController(), done = deferred();
  (helm as any).live.set("missing-run", { controller: first, done: done.promise });
  (helm as any).live.set("also-missing", { controller: second, done: done.promise });
  const closing = helm.close(); expect(helm.close()).toBe(closing);
  expect(first.signal.aborted && second.signal.aborted).toBe(true);
  done.resolve(); await expect(closing).rejects.toThrow("checkpoint"); rmSync(home, { recursive: true, force: true });
});

it("waits for stopped source checks even when receipt storage is unreadable", async () => {
  const home = mkdtempSync(join(tmpdir(), "checks-shutdown-"));
  const checks = new HelmSourceChecks(home, { review() { throw new Error("unused"); }, fingerprint: async () => "unused" });
  const controller = new AbortController(), done = deferred();
  (checks as any).live.set("unreadable", { controller, done: done.promise });
  vi.spyOn(checks as any, "all").mockImplementation(() => { throw new Error("Injected storage failure"); });
  const closing = checks.close(); expect(controller.signal.aborted).toBe(true); expect(checks.close()).toBe(closing);
  done.resolve(); await expect(closing).rejects.toThrow("checkpoint"); rmSync(home, { recursive: true, force: true });
});
