import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
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
it("uses PKCE, rejects callback mix-up and consumes state exactly once", async () => {
  const f = fixture(),
    start = await f.service.connect("p", "stored"),
    url = new URL(start.authorizationUrl),
    state = url.searchParams.get("state")!;
  expect(state.length).toBeGreaterThan(40);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  await expect(
    f.service.callback(`ai.hades.desktop:/oauth/operate?state=${state}&code=c`),
  ).rejects.toThrow("match");
  await expect(
    f.service.callback(
      `ai.hades.desktop:/oauth/stored?state=${state}&code=c&iss=https://evil.invalid`,
    ),
  ).rejects.toThrow("issuer");
  await f.service.callback(
    `ai.hades.desktop:/oauth/stored?state=${state}&code=c`,
  );
  const body = f.fetcher.mock.calls.find(([url]) =>
    String(url).endsWith("/token"),
  )![1].body as URLSearchParams;
  expect(
    createHash("sha256").update(body.get("code_verifier")!).digest("base64url"),
  ).toBe(url.searchParams.get("code_challenge"));
  await expect(
    f.service.callback(`ai.hades.desktop:/oauth/stored?state=${state}&code=c`),
  ).rejects.toThrow("expired");
  expect(f.service.data("p", "stored").total).toBe(1);
});
it("expires state and stores tokens only as authenticated scope-bound ciphertext", async () => {
  const f = fixture(),
    start = await f.service.connect("p", "stored");
  f.setTime(800000);
  await expect(
    f.service.callback(
      `ai.hades.desktop:/oauth/stored?state=${new URL(start.authorizationUrl).searchParams.get("state")}&code=c`,
    ),
  ).rejects.toThrow("expired");
  const c = f.seed("one");
  f.seed("two");
  const db = f.store.db;
  const row = db
    .prepare("SELECT token FROM plugin_connections WHERE profile=?")
    .get("one");
  expect(row.token).not.toContain("SECRET");
  db.prepare("UPDATE plugin_connections SET token=? WHERE profile=?").run(
    row.token,
    "two",
  );
  expect(() => f.store.tokens(f.store.get("two", "stored"))).toThrow(
    "unlocked",
  );
  expect(f.store.tokens(c).accessToken).toBe("SECRET_ACCESS");
});
it("shares one in-flight refresh instead of refusing its concurrent consumer as uncertain", async () => {
  const f = fixture(),
    c = f.seed(),
    hold = deferred();
  f.setTime(4000000);
  f.fetcher.mockImplementationOnce(async () => hold.promise);
  const first = (f.service as any).token(c);
  const second = (f.service as any).token(c);
  const both = Promise.all([first, second]);
  hold.done(
    response({
      token_type: "Bearer",
      access_token: "NEW",
      refresh_token: "ROTATED",
      expires_in: 3600,
      scope: "read write",
    }),
  );
  await expect(both).resolves.toHaveLength(2);
  expect(f.fetcher).toHaveBeenCalledOnce();
});
it("applies ordered change tombstones followed by recreation in the same batch", async () => {
  const f = fixture();
  f.seed();
  await f.service.sync("p", "stored");
  f.definition.adapter!.changes = async () => ({
    cursor: "c2",
    changes: [
      { deleted: { collection: "items", id: "one" } },
      {
        record: {
          id: "one",
          collection: "items",
          title: "Recreated",
          revision: "2",
          data: {},
        },
      },
    ],
  });
  await f.service.sync("p", "stored");
  expect(f.service.data("p", "stored").records.map((r) => r.title)).toEqual([
    "Recreated",
  ]);
});
it("accepts an explicitly cleared UI search query", () => {
  const f = fixture();
  f.seed();
  expect(() => f.service.data("p", "stored", { query: "" })).not.toThrow();
});
it("retains previous data/cursor after tenant drift or incomplete changes", async () => {
  const f = fixture();
  f.seed();
  await f.service.sync("p", "stored");
  f.definition.adapter!.changes = async () => ({
    cursor: "c2",
    changes: [],
    hasMore: true,
  });
  await expect(f.service.sync("p", "stored")).rejects.toThrow();
  expect(f.store.get("p", "stored").cursor).toBe("c1");
  expect(f.service.data("p", "stored").total).toBe(1);
  f.fetcher.mockResolvedValueOnce(
    response({ ...f.account, tenantId: "foreign" }),
  );
  await expect(f.service.sync("p", "stored")).rejects.toThrow(
    "account changed",
  );
  expect(f.service.data("p", "stored").account?.tenantId).toBe("tenant");
});
it("retains uncertain writes without replay and rechecks grants immediately before effect", async () => {
  const f = fixture();
  f.seed();
  const input = {
    key: "request",
    collection: "items",
    id: "one",
    operation: "update",
    expectedRevision: "1",
    data: { title: "Changed" },
  };
  f.fetcher.mockImplementation(async (url: any) => {
    if (String(url).endsWith("/write")) throw Error("lost acknowledgement");
    return response(f.account);
  });
  expect((await f.service.write("p", "stored", input)).status).toBe("unknown");
  expect((await f.service.write("p", "stored", input)).status).toBe("unknown");
  expect(f.write).toHaveBeenCalledOnce();
  await expect(
    f.service.write("p", "stored", { ...input, data: { other: true } }),
  ).rejects.toThrow("different");
  f.service.permissions("p", "stored", true, false);
  await expect(
    f.service.write("p", "stored", { ...input, key: "other" }),
  ).rejects.toThrow("not granted");
});
it("does not send a write after refreshed OAuth scopes remove write access", async () => {
  const f = fixture();
  f.seed();
  f.setTime(4000000);
  f.fetcher.mockImplementation(async (url: any) =>
    response(
      String(url).endsWith("/token")
        ? {
            token_type: "Bearer",
            access_token: "READ_ONLY",
            refresh_token: "ROTATED",
            expires_in: 3600,
            scope: "read",
          }
        : { ok: true },
    ),
  );
  const receipt = await f.service.write("p", "stored", {
    key: "scope-loss",
    collection: "items",
    id: "one",
    operation: "update",
    expectedRevision: "1",
    data: { title: "Forbidden" },
  });
  expect(
    f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/write")),
  ).toHaveLength(0);
  expect(receipt.status).not.toBe("applied");
});
it("never refreshes again after an uncertain rotation and fences disconnected snapshot results", async () => {
  const f = fixture(),
    c = f.seed();
  f.setTime(4000000);
  f.fetcher.mockRejectedValueOnce(Error("rotation ack lost"));
  await expect((f.service as any).token(c)).rejects.toThrow();
  await expect((f.service as any).token(c)).rejects.toThrow("unknown");
  expect(f.fetcher).toHaveBeenCalledOnce();
  const other = fixture();
  other.seed();
  const hold = deferred();
  other.snapshot.mockImplementationOnce(async () => hold.promise);
  const syncing = other.service.sync("p", "stored");
  await vi.waitFor(() => expect(other.snapshot).toHaveBeenCalledOnce());
  await other.service.disconnect("p", "stored");
  hold.done({
    records: [
      { id: "late", collection: "items", title: "Old account", data: {} },
    ],
  });
  await expect(syncing).rejects.toThrow("changed");
  expect(other.service.data("p", "stored").total).toBe(0);
});
it("rejects duplicate snapshot IDs without replacing saved records", async () => {
  const f = fixture();
  f.seed();
  await f.service.sync("p", "stored");
  f.snapshot.mockResolvedValueOnce({
    records: [
      {
        id: "duplicate",
        collection: "items",
        title: "a",
        revision: "1",
        data: { safe: true },
      },
      {
        id: "duplicate",
        collection: "items",
        title: "b",
        revision: "1",
        data: { safe: true },
      },
    ],
    cursor: "bad",
  });
  await expect(f.service.sync("p", "stored")).rejects.toThrow("duplicate");
  expect(f.service.data("p", "stored").records[0].id).toBe("one");
  expect(f.store.get("p", "stored").cursor).toBe("c1");
});
it("refuses token-bearing requests to unapproved origins and bounds JSON responses", async () => {
  const { boundedPluginJson } = await import("../core/ecosystem-http");
  const fetcher = vi.fn(async (_url: any, _init?: any) =>
    response({ ok: true }),
  );
  await expect(
    boundedPluginJson(
      fetcher,
      ["https://fixture.invalid"],
      "https://fixture.invalid.evil.test/data",
      { headers: { Authorization: "Bearer SECRET" } },
    ),
  ).rejects.toThrow("approved");
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(
    new Response("x", {
      headers: {
        "content-type": "application/json",
        "content-length": String(5 * 1024 * 1024),
      },
    }),
  );
  await expect(
    boundedPluginJson(
      fetcher,
      ["https://fixture.invalid"],
      "https://fixture.invalid/data",
    ),
  ).rejects.toThrow("too large");
  await boundedPluginJson(
    fetcher,
    ["https://fixture.invalid"],
    "https://fixture.invalid/data",
  );
  expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
  });
});
it("rejects writes if agent permission is removed while token refresh is pending", async () => {
  const f = fixture();
  f.seed();
  f.setTime(4000000);
  const hold = deferred();
  f.fetcher.mockImplementationOnce(async () => hold.promise);
  const writing = f.service.write("p", "stored", {
    key: "revocation",
    collection: "items",
    id: "one",
    operation: "update",
    expectedRevision: "1",
    data: {},
  });
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
  f.service.permissions("p", "stored", true, false);
  hold.done(
    response({
      token_type: "Bearer",
      access_token: "NEW",
      expires_in: 3600,
      scope: "read write",
    }),
  );
  expect((await writing).status).not.toBe("applied");
  expect(
    f.fetcher.mock.calls.some(([url]) => String(url).endsWith("/write")),
  ).toBe(false);
});
it("keeps an unknown write across disconnect and same-account reconnect", async () => {
  const f = fixture();
  f.seed();
  const input = {
    key: "durable-key",
    collection: "items",
    id: "one",
    operation: "update",
    expectedRevision: "1",
    data: {},
  };
  f.fetcher.mockImplementation(async (url: any) => {
    if (String(url).endsWith("/write")) throw Error("lost acknowledgement");
    return response(f.account);
  });
  expect((await f.service.write("p", "stored", input)).status).toBe("unknown");
  const c = f.store.get("p", "stored");
  await f.service.disconnect("p", "stored");
  f.store.save(
    { ...c, generation: "reconnected" },
    {
      accessToken: "NEW",
      expiresAt: 9999999,
      scopes: ["read", "write"],
      clientId: "native",
    },
  );
  expect((await f.service.write("p", "stored", input)).status).toBe("unknown");
  expect(f.write).toHaveBeenCalledOnce();
});
it("drains successive cursor pages in order before committing", async () => {
  const f = fixture();
  f.seed();
  await f.service.sync("p", "stored");
  const calls: string[] = [];
  f.definition.adapter!.changes = async (_request, _account, cursor) => {
    calls.push(cursor!);
    return cursor === "c1"
      ? {
          cursor: "c2",
          hasMore: true,
          changes: [{ deleted: { collection: "items", id: "one" } }],
        }
      : {
          cursor: "c3",
          hasMore: false,
          changes: [
            {
              record: {
                collection: "items",
                id: "one",
                title: "Restored",
                data: {},
              },
            },
          ],
        };
  };
  await f.service.sync("p", "stored");
  expect(calls).toEqual(["c1", "c2"]);
  expect(f.store.get("p", "stored").cursor).toBe("c3");
  expect(f.service.data("p", "stored").records[0].title).toBe("Restored");
});
it("rejects a full record when current provider identity has moved tenants", async () => {
  const f = fixture();
  f.seed();
  const record = vi.fn(async () => ({
    id: "one",
    collection: "items",
    title: "Foreign full record",
    data: {},
  }));
  f.definition.adapter!.record = record;
  f.fetcher.mockResolvedValue(response({ ...f.account, tenantId: "foreign" }));
  await expect(
    f.service.record("p", "stored", "items", "one", true),
  ).rejects.toThrow("account changed");
  expect(record).not.toHaveBeenCalled();
});
it("caches a public DCR client per profile without repeating registration", async () => {
  const f = fixture();
  f.definition.oauth!.clientId = undefined;
  f.definition.oauth!.registrationEndpoint = "https://fixture.invalid/register";
  f.fetcher.mockImplementation(async (url: any) =>
    response(
      String(url).endsWith("/register")
        ? { client_id: "registered", token_endpoint_auth_method: "none" }
        : f.account,
    ),
  );
  const first = await f.service.connect("p", "stored");
  expect(new URL(first.authorizationUrl).searchParams.get("client_id")).toBe(
    "registered",
  );
  await f.service.connect("p", "stored");
  expect(
    f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/register")),
  ).toHaveLength(1);
  await f.service.connect("other", "stored");
  expect(
    f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/register")),
  ).toHaveLength(2);
});
it("fences a full-record response after local agent permission is removed", async () => {
  const f = fixture();
  f.seed();
  const hold = deferred();
  const record = vi.fn(async () => hold.promise);
  f.definition.adapter!.record = record;
  const reading = f.service.record("p", "stored", "items", "one", true);
  await vi.waitFor(() => expect(record).toHaveBeenCalledOnce());
  f.service.permissions("p", "stored", false, false);
  hold.done({ id: "one", collection: "items", title: "Late", data: {} });
  await expect(reading).rejects.toThrow("removed");
});

it("refuses a new write when current provider account changes before dispatch", async () => {
  const f = fixture();
  f.seed();
  f.fetcher.mockResolvedValue(response({ ...f.account, tenantId: "foreign" }));
  try {
    const result = await f.service.write("p", "stored", {
      key: "tenant-move",
      collection: "items",
      id: "one",
      operation: "update",
      expectedRevision: "1",
      data: {},
    });
    expect(result.status).not.toBe("applied");
  } catch (error) {
    expect(String(error)).toContain("account changed");
  }
  expect(f.write).not.toHaveBeenCalled();
});
it("reopens a retained unknown write from SQLite without another provider effect", async () => {
  const f = fixture();
  f.seed();
  const input = {
    key: "restart-key",
    collection: "items",
    id: "one",
    operation: "update",
    expectedRevision: "1",
    data: {},
  };
  f.fetcher.mockImplementation(async (url: any) => {
    if (String(url).endsWith("/write")) throw Error("uncertain");
    return response(f.account);
  });
  await f.service.write("p", "stored", input);
  await f.service.close();
  const reopened = new EcosystemService(
    f.dir,
    () => {},
    [f.definition],
    f.fetcher,
    () => 100000,
  );
  reopened.unlock("a".repeat(64));
  clean.unshift(async () => reopened.close());
  expect((await reopened.write("p", "stored", input)).status).toBe("unknown");
  expect(f.write).toHaveBeenCalledOnce();
});

it("clears formerly authorized cached fields and resumes from a new snapshot when refresh narrows optional scopes", async () => {
  const f = fixture(),
    c = f.seed();
  c.scopes.push("instructions:read");
  f.definition.oauth!.scopes.push("instructions:read");
  f.store.save(c, {
    accessToken: "OLD",
    refreshToken: "REFRESH",
    expiresAt: 3700000,
    scopes: c.scopes,
    clientId: "native",
  });
  f.store.commit(
    { ...c, cursor: "old-wide-checkpoint" },
    [
      {
        collection: "items",
        id: "one",
        title: "Sensitive",
        data: { instructions: "previously authorized" },
      },
    ],
    true,
  );
  const changes = vi.fn(async () => ({ cursor: "old-next", changes: [] }));
  f.definition.adapter!.changes = changes;
  f.setTime(4000000);
  await (f.service as any).token(c);
  expect(f.service.data("p", "stored").records).toEqual([]);
  expect(f.store.get("p", "stored").cursor).toBeUndefined();
  expect(f.store.tokens(f.store.get("p", "stored")).scopes).toEqual([
    "read",
    "write",
  ]);
  await f.service.sync("p", "stored");
  expect(changes).not.toHaveBeenCalled();
  expect(f.snapshot).toHaveBeenCalledOnce();
  expect(f.service.data("p", "stored").records[0].data).toEqual({ safe: true });
});
it("fences an in-flight full record after optional OAuth read consent is removed", async () => {
  const f = fixture(),
    c = f.seed();
  c.scopes.push("instructions:read");
  f.definition.oauth!.scopes.push("instructions:read");
  f.store.save(c, {
    accessToken: "OLD",
    refreshToken: "REFRESH",
    expiresAt: 3700000,
    scopes: c.scopes,
    clientId: "native",
  });
  const hold = deferred();
  const record = vi.fn(async () => hold.promise);
  f.definition.adapter!.record = record;
  const reading = f.service.record("p", "stored", "items", "one", true);
  await vi.waitFor(() => expect(record).toHaveBeenCalledOnce());
  f.setTime(4000000);
  await (f.service as any).token(c);
  hold.done({
    collection: "items",
    id: "one",
    title: "Late old scope",
    data: { instructions: "private" },
  });
  await expect(reading).rejects.toThrow("permissions changed");
});
it("never re-exposes historical receipt content when suppressing a duplicate write", async () => {
  const f = fixture();
  f.seed();
  const input = {
    key: "retained-private-content",
    collection: "items",
    id: "one",
    operation: "update",
    expectedRevision: "1",
    data: {},
  };
  f.fetcher.mockImplementation(async (url: any) =>
    response(
      String(url).endsWith("/write")
        ? { record: { instructions: "original authorized payload" } }
        : f.account,
    ),
  );
  expect((await f.service.write("p", "stored", input)).result).toEqual({
    record: { instructions: "original authorized payload" },
  });
  const replay = await f.service.write("p", "stored", input);
  expect(replay.status).toBe("applied");
  expect(replay.result).toBeUndefined();
  expect(f.write).toHaveBeenCalledOnce();
});

it("binds read-only OAuth consent to the pending connection and refuses extra token scopes", async () => {
  const f = fixture(),
    start = await f.service.connect("p", "stored", "read"),
    url = new URL(start.authorizationUrl);
  expect(url.searchParams.get("scope")).toBe("read");
  await expect(
    f.service.callback(
      `ai.hades.desktop:/oauth/stored?state=${url.searchParams.get("state")}&code=overbroad`,
    ),
  ).rejects.toThrow("did not finish");
  expect(
    f.fetcher.mock.calls.some(([url]) => String(url).endsWith("/me")),
  ).toBe(false);
  const next = await f.service.connect("p", "stored", "read");
  f.fetcher.mockImplementation(async (url: any) =>
    response(
      String(url).endsWith("/token")
        ? {
            token_type: "Bearer",
            access_token: "READ_ONLY",
            expires_in: 3600,
            scope: "read",
          }
        : f.account,
    ),
  );
  await f.service.callback(
    `ai.hades.desktop:/oauth/stored?state=${new URL(next.authorizationUrl).searchParams.get("state")}&code=read-grant`,
  );
  expect(f.service.list("p")[0].scopes).toEqual(["read"]);
  expect(() => f.service.permissions("p", "stored", true, true)).toThrow(
    "write capability",
  );
});
