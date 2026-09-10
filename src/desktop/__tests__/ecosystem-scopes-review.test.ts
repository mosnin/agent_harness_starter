import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canWritePlugin,
  grantedPluginCapabilities,
} from "../core/ecosystem-capabilities";
import { ECOSYSTEM_PLUGINS } from "../core/ecosystem-catalog";
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

const input = {
  key: "independent-write",
  collection: "items",
  id: "one",
  operation: "update",
  expectedRevision: "1",
  data: { name: "Changed" },
};
it("independent: disabling writes after identity preflight prevents POST and records rejected", async () => {
  const f = fixture();
  f.seed();
  const entered = deferred(),
    release = deferred();
  f.write.mockImplementation(async (request: any) => {
    entered.done(null);
    await release.promise;
    return request("https://fixture.invalid/write", { method: "POST" });
  });
  const job = f.service.write("p", "stored", input);
  await entered.promise;
  f.service.permissions("p", "stored", true, false);
  release.done(null);
  const receipt = await job;
  expect(
    f.fetcher.mock.calls.some(([url]) => String(url).endsWith("/write")),
  ).toBe(false);
  expect(receipt.status).toBe("rejected");
});
it("independent: refresh between snapshot pages rejects the mixed projection and clears prior fields", async () => {
  const f = fixture(),
    c = f.seed();
  f.definition.oauth!.scopes.push("private");
  f.store.save(
    { ...c, scopes: ["read", "write", "private"], cursor: "old" },
    { ...f.store.tokens(c), scopes: ["read", "write", "private"] },
  );
  f.store.commit(
    f.store.get("p", "stored"),
    [
      {
        id: "old",
        collection: "items",
        title: "Private",
        data: { secret: "PRIVATE" },
      },
    ],
    true,
  );
  let pages = 0;
  f.definition.adapter!.snapshot = async (request) => {
    pages++;
    if (pages === 1) {
      f.setTime(4000000);
      return {
        records: [
          {
            id: "one",
            collection: "items",
            title: "Old grant",
            data: { secret: "PRIVATE" },
          },
        ],
        cursor: "new",
        nextPage: "two",
      };
    }
    await request("https://fixture.invalid/page");
    return { records: [], cursor: "new" };
  };
  await expect(f.service.sync("p", "stored")).rejects.toThrow(
    "permissions changed during sync",
  );
  expect(f.store.records("p", "stored")).toEqual([]);
  expect(f.store.get("p", "stored").cursor).toBeUndefined();
  expect(f.store.get("p", "stored").status).toBe("stale");
});
it("independent: retained successful receipt suppresses old payload without repeating effects", async () => {
  const f = fixture();
  f.seed();
  f.fetcher.mockImplementation(async (url: any) =>
    response(
      String(url).endsWith("/me") ? f.account : { secret: "OLDER_SCOPE" },
    ),
  );
  const first = await f.service.write("p", "stored", input);
  expect(first.status).toBe("applied");
  expect(first.result).toEqual({ secret: "OLDER_SCOPE" });
  const second = await f.service.write("p", "stored", input);
  expect(second.status).toBe("applied");
  expect(second).not.toHaveProperty("result");
  expect(f.write).toHaveBeenCalledTimes(1);
});
it("independent: Govern legacy rename never grants new metadata/configuration fields", () => {
  const d = ECOSYSTEM_PLUGINS.find((d) => d.id === "govern")!;
  const legacy = ["agents:read", "agents:write"];
  expect(
    canWritePlugin(d, legacy, {
      ...input,
      collection: "agents",
      operation: "rename",
      data: { name: "New" },
    }),
  ).toBe(true);
  expect(
    canWritePlugin(d, legacy, {
      ...input,
      collection: "agents",
      operation: "agent.update",
      data: { description: "New" },
    }),
  ).toBe(false);
  const metadata = [...legacy, "agents:metadata:write"];
  expect(
    canWritePlugin(d, metadata, {
      ...input,
      collection: "agents",
      operation: "agent.update",
      data: { description: "New" },
    }),
  ).toBe(true);
  expect(
    canWritePlugin(d, metadata, {
      ...input,
      collection: "agents",
      operation: "agent.update",
      data: { provider: "openai" },
    }),
  ).toBe(false);
  const optional = {
    ...d,
    capabilities: {
      ...d.capabilities!,
      readScopes: { policies: ["policies:read"] },
    },
  };
  expect(grantedPluginCapabilities(optional, metadata)?.reads).not.toContain(
    "policies",
  );
});

it("independent: narrowed initial refresh abandons old changes cursor and uses a new snapshot", async () => {
  const f = fixture(),
    c = f.seed();
  f.definition.oauth!.scopes.push("private");
  f.store.save(
    { ...c, scopes: ["read", "write", "private"], cursor: "old" },
    {
      ...f.store.tokens(c),
      expiresAt: 0,
      scopes: ["read", "write", "private"],
    },
  );
  const changes = vi.fn(async () => ({ changes: [], cursor: "old-next" }));
  f.definition.adapter!.changes = changes;
  await f.service.sync("p", "stored");
  expect(changes).not.toHaveBeenCalled();
  expect(f.snapshot).toHaveBeenCalledOnce();
  expect(f.store.get("p", "stored").cursor).toBe("c1");
});
it("independent: full record response from a prior scope cannot cross narrowing refresh", async () => {
  const f = fixture(),
    c = f.seed();
  f.definition.oauth!.scopes.push("private");
  f.store.save(
    { ...c, scopes: ["read", "write", "private"] },
    { ...f.store.tokens(c), scopes: ["read", "write", "private"] },
  );
  f.definition.adapter!.record = async (request) => {
    f.setTime(4000000);
    await request("https://fixture.invalid/detail");
    return {
      id: "one",
      collection: "items",
      title: "Old",
      data: { secret: "OLD_SCOPE" },
    };
  };
  await expect(
    f.service.record("p", "stored", "items", "one", true),
  ).rejects.toThrow("permissions changed");
});

it("independent: scope revocation after identity preflight prevents POST and records rejected", async () => {
  const f = fixture();
  f.seed();
  const entered = deferred(),
    release = deferred();
  f.write.mockImplementation(async (request: any) => {
    entered.done(null);
    await release.promise;
    return request("https://fixture.invalid/write", { method: "POST" });
  });
  const job = f.service.write("p", "stored", input);
  await entered.promise;
  f.setTime(4000000);
  f.fetcher.mockImplementation(async (url: any) =>
    response(
      String(url).endsWith("/token")
        ? {
            token_type: "Bearer",
            access_token: "REDUCED",
            refresh_token: "NEXT",
            expires_in: 3600,
            scope: "read",
          }
        : f.account,
    ),
  );
  release.done(null);
  const receipt = await job;
  expect(
    f.fetcher.mock.calls.some(([url]) => String(url).endsWith("/write")),
  ).toBe(false);
  expect(receipt.status).toBe("rejected");
});

it("independent: dispatched POST with a lost acknowledgement remains unknown", async () => {
  const f = fixture();
  f.seed();
  f.fetcher.mockImplementation(async (url: any) => {
    if (String(url).endsWith("/write")) throw new Error("Lost acknowledgement");
    return response(f.account);
  });
  expect((await f.service.write("p", "stored", input)).status).toBe("unknown");
  expect(
    f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/write")),
  ).toHaveLength(1);
  expect((await f.service.write("p", "stored", input)).status).toBe("unknown");
  expect(f.write).toHaveBeenCalledOnce();
});

it("independent: a pre-aborted write has a rejected receipt and performs no fetch", async () => {
  const f = fixture();
  f.seed();
  const controller = new AbortController();
  controller.abort();
  expect(
    (await f.service.write("p", "stored", input, controller.signal)).status,
  ).toBe("rejected");
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.write).not.toHaveBeenCalled();
});

it("independent: invalid connection access leaves an existing account and credentials intact", async () => {
  const f = fixture(),
    c = f.seed();
  const before = f.store.tokens(c);
  await expect(
    f.service.connect("p", "stored", "administrator"),
  ).rejects.toThrow("Choose read");
  expect(f.store.get("p", "stored")).toEqual(c);
  expect(f.store.tokens(c)).toEqual(before);
  expect(f.fetcher).not.toHaveBeenCalled();
});

it("independent: omitted token scope remains bound to the selected read-only request", async () => {
  const f = fixture();
  const result = await f.service.connect("p", "stored", "read");
  const url = new URL(result.authorizationUrl);
  expect(url.searchParams.get("scope")).toBe("read");
  f.fetcher.mockImplementation(async (target: any) =>
    response(
      String(target).endsWith("/token")
        ? {
            token_type: "Bearer",
            access_token: "READ_ONLY",
            refresh_token: "READ_REFRESH",
            expires_in: 3600,
          }
        : f.account,
    ),
  );
  await f.service.callback(
    `ai.hades.desktop:/oauth/stored?state=${url.searchParams.get("state")}&code=fixture&iss=https://fixture.invalid`,
  );
  const c = f.store.get("p", "stored");
  expect(c.scopes).toEqual(["read"]);
  expect(f.store.tokens(c).scopes).toEqual(["read"]);
  expect(() => f.service.permissions("p", "stored", true, true)).toThrow(
    "supported write",
  );
});

it("independent: a read connection rejects an explicitly overgranted token before account lookup", async () => {
  const f = fixture();
  const result = await f.service.connect("p", "stored", "read");
  const state = new URL(result.authorizationUrl).searchParams.get("state");
  await expect(
    f.service.callback(
      `ai.hades.desktop:/oauth/stored?state=${state}&code=fixture&iss=https://fixture.invalid`,
    ),
  ).rejects.toThrow();
  expect(
    f.fetcher.mock.calls.some(([url]) => String(url).endsWith("/me")),
  ).toBe(false);
  expect(f.store.get("p", "stored").account).toBeUndefined();
});
