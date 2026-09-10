// Independent negatives; offline seeded-store fixture adapted from author stream suite.
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
it("failed stream catch-up is one sync attempt, not an immediate duplicate fallback",async()=>{
 const f=fixture();await f.service.sync('p','stored');f.setTime(130000);
 f.setEvents(async()=>new Response(new ReadableStream(),{headers:{'content-type':'text/event-stream'}}));
 f.setChanges(async()=>new Response(null,{status:503}));
 f.service.tick();await f.drain();expect(f.changeCalls()).toBe(1);
 f.setTime(145000);f.service.tick();await f.drain();expect(f.changeCalls()).toBe(1);
 f.setTime(160000);f.service.tick();await f.drain();expect(f.changeCalls()).toBe(2);
});
it("pause during an in-flight fallback preserves cursor and cancels reconnect",async()=>{
 const f=fixture();await f.service.sync('p','stored');f.setTime(130000);
 let resolve!:(value:Response)=>void;f.setChanges(()=>new Promise(r=>{resolve=r;}));f.service.tick();
 await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));const pausing=f.service.pauseBackground();
 resolve(json({cursor:'late',changes:[{deleted:{collection:'items',id:'one'}}]}));await pausing;
 expect(f.store.get('p','stored')?.cursor).toBe('c1');expect(f.service.data('p','stored').total).toBe(2);
 f.setTime(190000);f.service.tick();expect(f.changeCalls()).toBe(1);
});
it("bounded stream lifetime rotation catches up once and resumes only one live watch",async()=>{
 const f=fixture();await f.service.sync('p','stored');let rotation:AbortController|undefined;
 const timeout=AbortSignal.timeout.bind(AbortSignal);
 const spy=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{if(ms===60000){rotation=new AbortController();return rotation.signal;}return timeout(ms);});
 try{
  f.setEvents(async()=>new Response(new ReadableStream(),{headers:{'content-type':'text/event-stream'}}));
  f.service.tick();await vi.waitFor(()=>expect(f.service.list('p')[0].syncMode).toBe('live'));
  expect(f.changeCalls()).toBe(1);f.setTime(160000);rotation!.abort(new DOMException('fixture lifetime','TimeoutError'));await f.drain();
  // Reader cancellation may settle as normal EOF or lifetime error; neither may duplicate a data attempt.
  const afterRotation=f.changeCalls();expect([1,2]).toContain(afterRotation);expect(f.service.list('p')[0].syncMode).not.toBe('live');
  f.setTime(175000);f.service.tick();f.service.tick();await vi.waitFor(()=>expect(f.service.list('p')[0].syncMode).toBe('live'));
  expect(f.changeCalls()).toBe(afterRotation+1);await f.service.pauseBackground();
 }finally{spy.mockRestore();}
});
