import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ecosystemTools } from "../core/ecosystem-tools";

import { EcosystemService } from "../core/ecosystem-service";
import type {
  PluginDefinition,
  PluginConnection,
} from "../core/ecosystem-types";
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of clean.splice(0)) await fn();
});
const response = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
const deferred = () => {
  let done!: (v: any) => void;
  const promise = new Promise<any>((r) => (done = r));
  return { done, promise };
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ecosystem-review-"));
  let time = 100000;
  const account = { id: "account", tenantId: "tenant", name: "Fixture" };
  const snapshot = vi.fn(async () => ({
    records: [
      {
        id: "one",
        collection: "items",
        title: "First",
        revision: "1",
        data: { safe: true },
      },
    ],
    cursor: "c1",
  }));
  const write = vi.fn(async (request: any, _a: any, input: any) =>
    request("https://fixture.invalid/write", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
  const definition: PluginDefinition = {
    id: "stored",
    name: "Fixture",
    origin: "https://fixture.invalid",
    description: "Offline fixture",
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
    adapter: { account: (v) => v as typeof account, snapshot, write },
  };
  const fetcher = vi.fn(async (url: any, _init?: any) =>
    response(
      String(url).endsWith("/token")
        ? {
            token_type: "Bearer",
            access_token: "SECRET_ACCESS",
            refresh_token: "SECRET_REFRESH",
            expires_in: 3600,
            scope: "read write",
          }
        : String(url).endsWith("/me")
          ? account
          : { ok: true },
    ),
  );
  const service = new EcosystemService(
    dir,
    () => {},
    [definition],
    fetcher,
    () => time,
  );
  service.unlock("a".repeat(64));
  const store = (service as any).store;
  const seed = (profile = "p") => {
    const c: PluginConnection = {
      profile,
      pluginId: "stored",
      generation: "generation-" + profile,
      status: "connected",
      account,
      agentRead: true,
      agentWrite: true,
      scopes: ["read", "write"],
    };
    store.save(c, {
      accessToken: "SECRET_ACCESS",
      refreshToken: "SECRET_REFRESH",
      expiresAt: time + 3600000,
      scopes: ["read", "write"],
      clientId: "native",
    });
    return c;
  };
  clean.push(async () => {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    service,
    store,
    seed,
    fetcher,
    definition,
    account,
    snapshot,
    write,
    setTime: (v: number) => (time = v),
  };
}

it("independent fresh read refuses failed provider refresh rather than returning saved content", async () => {
  const f = fixture();
  f.seed();
  await f.service.sync("p", "stored");
  f.fetcher.mockRejectedValueOnce(Error("Offline fixture"));
  await expect(f.service.read("p", "stored")).rejects.toThrow("Offline");
  const cached = await f.service.read("p", "stored", { freshness: "cached" });
  expect(cached.source).toBe("snapshot");
  expect(cached.records[0].title).toBe("First");
  expect(cached).not.toHaveProperty("checkedAt");
});
it("independent continuation binds content, filters and account generation but ignores unchanged refresh", async () => {
  const f = fixture();
  const c = f.seed();
  const first = await f.service.read("p", "stored");
  await f.service.sync("p", "stored");
  expect(
    (
      await f.service.read("p", "stored", {
        expectedSnapshotId: first.snapshotId,
      })
    ).snapshotId,
  ).toBe(first.snapshotId);
  await expect(
    f.service.read("p", "stored", {
      expectedSnapshotId: first.snapshotId,
      query: "First",
    }),
  ).rejects.toThrow("filters changed");
  f.store.commit(
    f.store.get("p", "stored"),
    [{ id: "one", collection: "items", title: "Updated", data: {} }],
    true,
  );
  await expect(
    f.service.read("p", "stored", { expectedSnapshotId: first.snapshotId }),
  ).rejects.toThrow("filters changed");
  const token = f.store.tokens(c);
  f.store.remove("p", "stored");
  f.store.save({ ...c, generation: "new-account-generation" }, token);
  f.store.commit(
    f.store.get("p", "stored"),
    [
      {
        id: "one",
        collection: "items",
        title: "First",
        revision: "1",
        data: { safe: true },
      },
    ],
    true,
  );
  await expect(
    f.service.read("p", "stored", { expectedSnapshotId: first.snapshotId }),
  ).rejects.toThrow("filters changed");
});
it("independent cancelled reader detaches promptly from an existing background sync without exposing late data", async () => {
  const f = fixture();
  f.seed();
  const entered = deferred(),
    release = deferred();
  f.snapshot.mockImplementation(async () => {
    entered.done(null);
    await release.promise;
    return { records: [], cursor: "later" };
  });
  const background = f.service.sync("p", "stored");
  await entered.promise;
  const c = new AbortController();
  const read = f.service.read("p", "stored", {}, c.signal);
  c.abort(Error("reader stopped"));
  await expect(read).rejects.toThrow("reader stopped");
  release.done(null);
  await background;
});
it("independent read sharing non-agent sync still refuses data after agent permission removal", async () => {
  const f = fixture();
  f.seed();
  const entered = deferred(),
    release = deferred();
  f.snapshot.mockImplementation(async () => {
    entered.done(null);
    await release.promise;
    return { records: [], cursor: "later" };
  });
  const background = f.service.sync("p", "stored");
  await entered.promise;
  const read = f.service.read("p", "stored");
  f.service.permissions("p", "stored", false, false);
  release.done(null);
  await background;
  await expect(read).rejects.toThrow("Agent read");
});
it("independent actual read tool keeps every large-record identity discoverable across snapshot-bound pages", async () => {
  const f = fixture();
  f.seed();
  f.definition.adapter!.snapshot = async () => ({
    cursor: "large",
    records: Array.from({ length: 75 }, (_, n) => ({
      id: String(n).padStart(3, "0"),
      collection: "items",
      title: "Record " + n,
      data: { body: "🔥".repeat(10000) },
    })),
  });
  const tool = ecosystemTools(
    f.service,
    "p",
    new AbortController().signal,
  ).find((t) => t.name === "plugins_read")!;
  const ids: string[] = [];
  let args: Record<string, unknown> = { pluginId: "stored" };
  for (let page = 0; page < 5; page++) {
    const result = await tool.run(JSON.stringify(args));
    expect(result.ok).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThan(128 * 1024);
    const parsed = JSON.parse(result.output);
    for (const row of parsed.records) {
      expect(row.dataOmitted).toBe(true);
      ids.push(row.id);
    }
    if (parsed.nextOffset === undefined) break;
    args = {
      pluginId: "stored",
      offset: parsed.nextOffset,
      expectedSnapshotId: parsed.snapshotId,
    };
  }
  expect(ids).toHaveLength(75);
  expect(new Set(ids).size).toBe(75);
  expect(
    f.fetcher.mock.calls.filter(([u]) => String(u).endsWith("/me")),
  ).toHaveLength(1);
});

it("independent scope narrowing invalidates cached continuation even when record bytes stay the same", async () => {
  const f = fixture(),
    c = f.seed();
  const first = await f.service.read("p", "stored");
  const current = f.store.get("p", "stored");
  f.store.commit(
    { ...current, scopes: ["read"], agentWrite: false },
    f.store.records("p", "stored"),
    true,
    [],
    { ...f.store.tokens(c), scopes: ["read"] },
  );
  await expect(
    f.service.read("p", "stored", {
      expectedSnapshotId: first.snapshotId,
      freshness: "cached",
    }),
  ).rejects.toThrow("filters changed");
});
