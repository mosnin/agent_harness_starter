import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EcosystemService } from "../core/ecosystem-service";
import { ECOSYSTEM_PLUGINS } from "../core/ecosystem-catalog";
import type { PluginConnection, PluginRecord } from "../core/ecosystem-types";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});
const ids = [1, 2, 3, 4, 5].map(
  (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
);
const account = { id: "human", tenantId: "workspace", name: "Workspace" };
const row = (
  collection: string,
  id: string,
  label = "initial",
): PluginRecord => ({
  id,
  collection,
  title: label,
  revision: "a".repeat(64),
  updatedAt: 1,
  data: { name: label },
});
function fixture(readOnly = false) {
  const dir = mkdtempSync(join(tmpdir(), "scalar-client-review-"));
  let version = "initial",
    failure = false,
    foreign = false,
    badStatus = false;
  const observed: string[] = [];
  const writes: unknown[] = [];
  const definition = ECOSYSTEM_PLUGINS.find((d) => d.id === "scalar")!;
  const fetcher = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://tryscalar.xyz");
      if (url.pathname === "/oauth/userinfo")
        return Response.json({
          sub: "human",
          workspace: { id: "workspace", name: "Workspace" },
        });
      if (url.pathname !== "/api/oauth/records")
        throw Error("Unexpected fixture endpoint");
      if (init?.method === "POST") {
        const value = JSON.parse(String(init.body));
        writes.push(value);
        return Response.json({
          status: badStatus ? "rejected" : "applied",
          record: row(value.collection, foreign ? ids[4] : value.id, "updated"),
        });
      }
      const collection = url.searchParams.get("collection")!;
      observed.push(collection + ":" + (url.searchParams.get("page") ?? ""));
      if (failure && collection === "pipelines")
        return Response.json(
          { error: "fixture late failure" },
          { status: 503 },
        );
      if (url.searchParams.has("id"))
        return Response.json({
          record: row(
            collection,
            foreign ? ids[4] : url.searchParams.get("id")!,
            version,
          ),
        });
      if (collection === "contacts")
        return Response.json(
          url.searchParams.has("page")
            ? { records: [row(collection, ids[1], version)] }
            : { records: [row(collection, ids[0], version)], nextPage: ids[0] },
        );
      if (collection === "companies") return Response.json({ records: [] });
      const id =
        collection === "activities"
          ? ids[2]
          : collection === "pipelines"
            ? ids[3]
            : ids[4];
      return Response.json({ records: [row(collection, id, version)] });
    },
  );
  const service = new EcosystemService(
    dir,
    () => {},
    [definition],
    fetcher,
    () => 100000,
  );
  service.unlock("a".repeat(64));
  const store = (
    service as unknown as {
      store: {
        save(c: PluginConnection, t: unknown): void;
        get(p: string, id: string): PluginConnection;
      };
    }
  ).store;
  const scopes = readOnly
    ? ["openid", "profile", "crm:read"]
    : ["openid", "profile", "crm:read", "crm:write"];
  store.save(
    {
      profile: "p",
      pluginId: "scalar",
      generation: "fixture-generation",
      status: "connected",
      account,
      agentRead: true,
      // A retained toggle cannot override a newly read-only provider grant.
      agentWrite: true,
      scopes,
    },
    {
      accessToken: "FIXTURE_ACCESS",
      refreshToken: "FIXTURE_REFRESH",
      expiresAt: 3700000,
      clientId: "native",
      scopes,
    },
  );
  cleanup.push(async () => {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    service,
    store,
    observed,
    writes,
    fetcher,
    change: () => {
      version = "new";
    },
    fail: () => {
      failure = true;
    },
    foreign: () => {
      foreign = true;
    },
    badStatus: () => {
      badStatus = true;
    },
  };
}
it("actual sync traverses five collections, continuing past empty and paginated results without checkpoint", async () => {
  const f = fixture();
  await f.service.sync("p", "scalar");
  expect(f.observed).toEqual([
    "contacts:",
    "contacts:" + ids[0],
    "companies:",
    "activities:",
    "pipelines:",
    "pipelineEntries:",
  ]);
  const saved = f.service.data("p", "scalar");
  expect(saved.total).toBe(5);
  expect(f.store.get("p", "scalar").cursor).toBeUndefined();
  await f.service.sync("p", "scalar");
  expect(f.observed.filter((s) => s === "contacts:")).toHaveLength(2);
});
it("a failed later collection leaves the entire previous cache intact", async () => {
  const f = fixture();
  await f.service.sync("p", "scalar");
  const before = f.service.data("p", "scalar");
  f.change();
  f.fail();
  await expect(f.service.sync("p", "scalar")).rejects.toThrow();
  const after = f.service.data("p", "scalar");
  expect(after.records).toEqual(before.records);
  expect(after.total).toBe(5);
  expect(JSON.stringify(after.records)).not.toContain('"new"');
});
it("detail uses exact collection/id and rejects a foreign response identity", async () => {
  const f = fixture();
  await f.service.sync("p", "scalar");
  const result = await f.service.record(
    "p",
    "scalar",
    "contacts",
    ids[0],
    true,
  );
  expect(result.account).toEqual(account);
  expect(result.record.id).toBe(ids[0]);
  f.foreign();
  await expect(
    f.service.record("p", "scalar", "contacts", ids[0], true),
  ).rejects.toThrow();
});
it("write sends exact source DTO and read-only grant never dispatches a mutation", async () => {
  const f = fixture();
  await f.service.sync("p", "scalar");
  const input = {
    key: ids[1],
    collection: "contacts",
    id: ids[0],
    operation: "update",
    expectedRevision: "a".repeat(64),
    data: { notes: "Approved note" },
  };
  expect((await f.service.write("p", "scalar", input)).status).toBe("applied");
  expect(f.writes).toEqual([input]);
  const readOnly = fixture(true);
  await readOnly.service.sync("p", "scalar");
  await expect(readOnly.service.write("p", "scalar", input)).rejects.toThrow(
    "write access",
  );
  expect(readOnly.writes).toEqual([]);
});

it("a wrong-record write acknowledgement remains unknown and never reports applied", async () => {
  const f = fixture();
  await f.service.sync("p", "scalar");
  f.foreign();
  const input = {
    key: ids[1],
    collection: "contacts",
    id: ids[0],
    operation: "update",
    expectedRevision: "a".repeat(64),
    data: { notes: "Approved note" },
  };
  expect((await f.service.write("p", "scalar", input)).status).toBe("unknown");
  expect((await f.service.write("p", "scalar", input)).status).toBe("unknown");
  expect(f.writes).toHaveLength(1);
});

it("a negative provider acknowledgement is not accepted as an applied mutation", async () => {
  const f = fixture();
  await f.service.sync("p", "scalar");
  f.badStatus();
  const input = {
    key: ids[1],
    collection: "contacts",
    id: ids[0],
    operation: "update",
    expectedRevision: "a".repeat(64),
    data: { notes: "Approved note" },
  };
  expect((await f.service.write("p", "scalar", input)).status).toBe("unknown");
  expect(f.writes).toHaveLength(1);
});
