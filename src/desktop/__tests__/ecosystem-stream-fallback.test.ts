import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EcosystemService } from "../core/ecosystem-service";
import { EcosystemStore } from "../core/ecosystem-store";
import type {
  PluginDefinition,
  PluginConnection,
  PluginChanges,
  PluginPage,
} from "../core/ecosystem-types";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
const row = (id: string, title: string, revision = "1") => ({
  id,
  collection: "items",
  title,
  revision,
  data: { title },
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "stream-fallback-"));
  let now = 100000;
  const account = { id: "human", tenantId: "tenant", name: "Account" };
  let events = () => Promise.resolve(new Response(null, { status: 503 }));
  let changes = () =>
    Promise.resolve(
      json({
        cursor: "c2",
        changes: [
          { record: row("one", "UI edit", "2") },
          { deleted: { collection: "items", id: "two" } },
        ],
      }),
    );
  const fetcher = vi.fn(async (url: Parameters<typeof fetch>[0]) =>
    String(url).endsWith("/events")
      ? events()
      : String(url).includes("/changes")
        ? changes()
        : String(url).endsWith("/snapshot")
          ? json({
              cursor: "c1",
              records: [row("one", "Old"), row("two", "Deleted later")],
            })
          : json(account),
  );
  const definition: PluginDefinition = {
    id: "stored",
    name: "Fixture",
    origin: "https://fixture.invalid",
    description: "Offline",
    oauth: {
      issuer: "https://fixture.invalid",
      authorizationEndpoint: "https://fixture.invalid/authorize",
      tokenEndpoint: "https://fixture.invalid/token",
      userInfoEndpoint: "https://fixture.invalid/me",
      clientId: "native",
      scopes: ["read", "write"],
      readScopes: ["read"],
      writeScopes: ["write"],
      allowedOrigins: ["https://fixture.invalid"],
    },
    adapter: {
      account: (v) => v as typeof account,
      eventsEndpoint: "https://fixture.invalid/events",
      snapshot: async (request) =>
        (await request("https://fixture.invalid/snapshot")) as PluginPage,
      changes: async (request, _account, cursor) =>
        (await request(
          "https://fixture.invalid/changes?cursor=" + cursor,
        )) as PluginChanges,
    },
  };
  const service = new EcosystemService(
    dir,
    () => {},
    [definition],
    fetcher,
    () => now,
  );
  service.unlock("a".repeat(64));
  const store = (service as unknown as { store: EcosystemStore }).store;
  const c: PluginConnection = {
    profile: "p",
    pluginId: "stored",
    generation: "generation",
    status: "connected",
    account,
    agentRead: true,
    agentWrite: true,
    scopes: ["read", "write"],
  };
  store.save(c, {
    accessToken: "fixture-token",
    expiresAt: 9000000,
    scopes: ["read", "write"],
    clientId: "native",
  });
  cleanup.push(async () => {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    service,
    store,
    fetcher,
    c,
    setTime: (value: number) => (now = value),
    setEvents: (fn: typeof events) => (events = fn),
    setChanges: (fn: typeof changes) => (changes = fn),
    changeCalls: () =>
      fetcher.mock.calls.filter(([url]) => String(url).includes("/changes"))
        .length,
    async drain() {
      await vi.waitFor(() =>
        expect(
          (service as unknown as { background: Map<string, unknown> })
            .background.size,
        ).toBe(0),
      );
    },
  };
}
it("normal remote edit and deletion reach SQLite during503 streaming outage, deduplicated at30second cadence", async () => {
  const f = fixture();
  await f.service.sync("p", "stored");
  f.setTime(130000);
  f.service.tick();
  f.service.tick();
  await f.drain();
  expect(f.service.data("p", "stored").records.map((r) => r.title)).toEqual([
    "UI edit",
  ]);
  expect(f.store.get("p", "stored")?.cursor).toBe("c2");
  expect(f.changeCalls()).toBe(1);
  expect(f.service.list("p")[0]).toMatchObject({
    status: "stale",
    syncMode: "changes",
  });
  f.setTime(145000);
  f.service.tick();
  await f.drain();
  expect(f.changeCalls()).toBe(1);
  f.setTime(160000);
  f.service.tick();
  await f.drain();
  expect(f.changeCalls()).toBe(2);
});
it.each([401, 403])(
  "does not poll after stream authorization denial %i",
  async (status) => {
    const f = fixture();
    await f.service.sync("p", "stored");
    f.setTime(130000);
    f.setEvents(async () => new Response(null, { status }));
    f.service.tick();
    await f.drain();
    expect(f.changeCalls()).toBe(0);
    expect(f.service.list("p")[0]).toMatchObject({
      status: "error",
      agentRead: false,
      agentWrite: false,
    });
    f.setTime(190000);
    f.service.tick();
    await f.drain();
    expect(f.changeCalls()).toBe(0);
  },
);
it("failed fallback preserves the complete old cache and cursor, then respects the attempt cooldown", async () => {
  const f = fixture();
  await f.service.sync("p", "stored");
  f.setTime(130000);
  f.setChanges(async () => new Response(null, { status: 503 }));
  f.service.tick();
  await f.drain();
  expect(f.service.data("p", "stored").records.map((r) => r.title)).toEqual([
    "Old",
    "Deleted later",
  ]);
  expect(f.store.get("p", "stored")?.cursor).toBe("c1");
  f.setTime(145000);
  f.service.tick();
  await f.drain();
  expect(f.changeCalls()).toBe(1);
});
it("recovers to live only after an actual open stream catches up; unavailable does not cause duplicate catch-up", async () => {
  const f = fixture();
  await f.service.sync("p", "stored");
  f.setTime(130000);
  f.service.tick();
  await f.drain();
  f.setTime(145000);
  f.setEvents(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode("event: unavailable\ndata: {}\n\n"),
            );
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  f.service.tick();
  await f.drain();
  expect(f.changeCalls()).toBe(2);
  expect(f.service.list("p")[0]).toMatchObject({
    status: "stale",
    syncMode: "changes",
  });
  f.setTime(160000);
  f.setEvents(
    async () =>
      new Response(new ReadableStream(), {
        headers: { "content-type": "text/event-stream" },
      }),
  );
  f.service.tick();
  await vi.waitFor(() =>
    expect(f.service.list("p")[0]).toMatchObject({
      status: "connected",
      syncMode: "live",
    }),
  );
  expect(f.changeCalls()).toBe(3);
  await f.service.pauseBackground();
});
it.each(["pause", "close", "disconnect"])(
  "late503 after %s cannot start fallback",
  async (action) => {
    const f = fixture();
    await f.service.sync("p", "stored");
    f.setTime(130000);
    let resolve!: (v: Response) => void;
    f.setEvents(() => new Promise((r) => (resolve = r)));
    f.service.tick();
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    const stopping =
      action === "pause"
        ? f.service.pauseBackground()
        : action === "close"
          ? f.service.close()
          : f.service.disconnect("p", "stored");
    resolve(new Response(null, { status: 503 }));
    await stopping;
    await f.drain();
    expect(f.changeCalls()).toBe(0);
  },
);
it.each(["generation", "scopes"])(
  "late fallback cannot replace cache after %s changes",
  async (kind) => {
    const f = fixture();
    await f.service.sync("p", "stored");
    f.setTime(130000);
    let resolve!: (v: Response) => void;
    f.setChanges(() => new Promise((r) => (resolve = r)));
    f.service.tick();
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    const current = f.store.get("p", "stored")!;
    if (kind === "generation") f.store.remove("p", "stored");
    f.store.save({
      ...current,
      ...(kind === "generation"
        ? { generation: "replacement", cursor: undefined }
        : { scopes: ["read"], agentWrite: false }),
    });
    resolve(
      json({
        cursor: "c2",
        changes: [
          { record: row("one", "Late foreign row", "2") },
          { deleted: { collection: "items", id: "two" } },
        ],
      }),
    );
    await f.drain();
    expect(f.service.data("p", "stored").records.map((r) => r.title)).toEqual(
      kind === "generation" ? [] : ["Old", "Deleted later"],
    );
    expect(f.store.get("p", "stored")?.cursor).toBe(
      kind === "generation" ? undefined : "c1",
    );
    if (kind === "scopes")
      expect(f.service.list("p")[0].agentWrite).toBe(false);
  },
);
it("revoked event ends authorization without additional fallback", async () => {
  const f = fixture();
  await f.service.sync("p", "stored");
  f.setTime(130000);
  f.setEvents(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("event: revoked\ndata: {}\n\n"));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  f.service.tick();
  await f.drain();
  expect(f.changeCalls()).toBe(1);
  expect(f.service.list("p")[0]).toMatchObject({
    status: "error",
    agentRead: false,
    agentWrite: false,
  });
  f.setTime(190000);
  f.service.tick();
  await f.drain();
  expect(f.changeCalls()).toBe(1);
});
it("pause drains an in-flight fallback and refuses its late cache replacement", async () => {
  const f = fixture();
  await f.service.sync("p", "stored");
  f.setTime(130000);
  let resolve!: (v: Response) => void;
  f.setChanges(() => new Promise((r) => (resolve = r)));
  f.service.tick();
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  const pause = f.service.pauseBackground();
  resolve(
    json({
      cursor: "c2",
      changes: [{ deleted: { collection: "items", id: "two" } }],
    }),
  );
  await pause;
  expect(f.store.get("p", "stored")?.cursor).toBe("c1");
  expect(f.service.data("p", "stored").records).toHaveLength(2);
  f.setTime(190000);
  f.service.tick();
  expect(f.changeCalls()).toBe(1);
});
it("fallback authorization denial disables permissions and blocks further background requests", async () => {
  const f = fixture();
  await f.service.sync("p", "stored");
  f.setTime(130000);
  f.setChanges(async () => new Response(null, { status: 403 }));
  f.service.tick();
  await f.drain();
  expect(f.service.list("p")[0]).toMatchObject({
    status: "error",
    agentRead: false,
    agentWrite: false,
  });
  const calls = f.fetcher.mock.calls.length;
  f.setTime(190000);
  f.service.tick();
  expect(f.fetcher).toHaveBeenCalledTimes(calls);
});
