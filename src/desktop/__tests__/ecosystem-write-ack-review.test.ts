import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EcosystemService } from "../core/ecosystem-service";
import { ECOSYSTEM_PLUGINS } from "../core/ecosystem-catalog";
import type {
  PluginConnection,
  EcosystemId,
  PluginWrite,
} from "../core/ecosystem-types";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});
const id = "11111111-1111-4111-8111-111111111111",
  key = "22222222-2222-4222-8222-222222222222",
  hash = "a".repeat(64);
const native = ["cadre", "govern", "glove"];
function contract(plugin: EcosystemId) {
  const collection = {
    stored: "memories",
    operate: "task",
    scalar: "contacts",
    "company-os": "document",
    cadre: "bots",
    govern: "agents",
    glove: "products",
  }[plugin];
  const operation =
    plugin === "operate"
      ? "task.update"
      : plugin === "company-os"
        ? "document.update"
        : native.includes(plugin)
          ? "rename"
          : "update";
  const data =
    plugin === "stored"
      ? { content: "Approved" }
      : plugin === "operate"
        ? { title: "Task", description: "Approved" }
        : plugin === "company-os"
          ? {
              title: "Document",
              content: "Approved",
              message: "Edit",
              templateVersion: 1,
            }
          : plugin === "scalar"
            ? { notes: "Approved" }
            : { name: "Approved" };
  return {
    key,
    id: plugin === "operate" ? "operate:task:" + id : id,
    collection,
    operation,
    expectedRevision:
      plugin === "company-os" || native.includes(plugin) ? "1" : hash,
    data,
  } as PluginWrite;
}
function userinfo(plugin: EcosystemId) {
  if (plugin === "stored")
    return {
      sub: "human",
      org_id: "tenant",
      org_name: "Tenant",
      org_role: "owner",
    };
  if (plugin === "scalar")
    return { sub: "human", workspace: { id: "tenant", name: "Tenant" } };
  if (native.includes(plugin))
    return {
      sub: "human",
      account: { id: "unused-business-id", tenantId: "tenant", name: "Tenant" },
    };
  return {
    subject: { id: "human" },
    tenant: { id: "tenant", label: "Tenant" },
  };
}
function ack(plugin: EcosystemId, input: PluginWrite): Record<string, unknown> {
  if (plugin === "operate")
    return { id: input.id, version: hash, replayed: false };
  if (plugin === "company-os")
    return { id: input.id, version: "2", contentHash: hash, replayed: false };
  return {
    status: "applied",
    ...(native.includes(plugin) ? { key } : {}),
    record: {
      id,
      collection: input.collection,
      title: "Approved",
      revision: ["scalar", "stored"].includes(plugin) ? hash : "2",
      updatedAt: 1,
      data: input.data,
    },
  };
}
function fixture(plugin: EcosystemId, body: unknown) {
  const definition = ECOSYSTEM_PLUGINS.find((d) => d.id === plugin)!,
    dir = mkdtempSync(join(tmpdir(), "write-ack-review-"));
  let dispatches = 0;
  const make = () =>
    new EcosystemService(
      dir,
      () => {},
      [definition],
      async (url, init) => {
        expect(new URL(String(url)).origin).toBe(definition.origin);
        if (String(url) === definition.oauth!.userInfoEndpoint)
          return Response.json(userinfo(plugin));
        expect(init?.method).toBe("POST");
        dispatches++;
        return Response.json(body);
      },
      () => 100000,
    );
  let service = make();
  service.unlock("a".repeat(64));
  const store = (
    service as unknown as {
      store: { save(c: PluginConnection, t: unknown): void };
    }
  ).store;
  const scopes = definition.oauth!.scopes;
  store.save(
    {
      profile: "p",
      pluginId: plugin,
      generation: "fixture",
      status: "connected",
      account: { id: "human", tenantId: "tenant", name: "Tenant" },
      agentRead: true,
      agentWrite: true,
      scopes,
    },
    {
      accessToken: "FIXTURE_ACCESS",
      refreshToken: "FIXTURE_REFRESH",
      expiresAt: 3700000,
      clientId: definition.oauth!.clientId ?? "native",
      scopes,
    },
  );
  cleanup.push(async () => {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get service() {
      return service;
    },
    count: () => dispatches,
    restart: async () => {
      await service.close();
      service = make();
      service.unlock("a".repeat(64));
    },
  };
}
for (const plugin of [
  "stored",
  "operate",
  "scalar",
  "company-os",
  "cadre",
  "govern",
  "glove",
] as const) {
  it(plugin + " accepts its actual source acknowledgement shape", async () => {
    const input = contract(plugin),
      f = fixture(plugin, ack(plugin, input));
    expect((await f.service.write("p", plugin, input)).status).toBe("applied");
    expect(f.count()).toBe(1);
  });
  for (const mode of ["empty", "wrong-id", "rejected"]) {
    it(
      plugin +
        " keeps " +
        mode +
        " successful HTTP acknowledgement unknown with durable no-retry",
      async () => {
        const input = contract(plugin);
        let body = ack(plugin, input);
        if (mode === "empty") body = {};
        else if (mode === "rejected") body = { ...body, status: "rejected" };
        else if (body.record)
          body = {
            ...body,
            record: { ...(body.record as object), id: "other" },
          };
        else body = { ...body, id: "other" };
        const f = fixture(plugin, body);
        expect((await f.service.write("p", plugin, input)).status).toBe(
          "unknown",
        );
        expect((await f.service.write("p", plugin, input)).status).toBe(
          "unknown",
        );
        expect(f.count()).toBe(1);
        await f.restart();
        expect((await f.service.write("p", plugin, input)).status).toBe(
          "unknown",
        );
        expect(f.count()).toBe(1);
      },
    );
  }
  if (native.includes(plugin))
    it(
      plugin + " refuses changed native request key without replay",
      async () => {
        const input = contract(plugin),
          f = fixture(plugin, { ...ack(plugin, input), key: "other-key" });
        expect((await f.service.write("p", plugin, input)).status).toBe(
          "unknown",
        );
        expect((await f.service.write("p", plugin, input)).status).toBe(
          "unknown",
        );
        expect(f.count()).toBe(1);
      },
    );
}
for (const plugin of ["cadre", "govern", "glove"] as const)
  it(
    plugin +
      " rejects a noncanonical native revision and retains uncertainty after reopen",
    async () => {
      const input = contract(plugin),
        body = ack(plugin, input);
      const f = fixture(plugin, {
        ...body,
        record: { ...(body.record as object), revision: "01" },
      });
      expect((await f.service.write("p", plugin, input)).status).toBe(
        "unknown",
      );
      await f.restart();
      expect((await f.service.write("p", plugin, input)).status).toBe(
        "unknown",
      );
      expect(f.count()).toBe(1);
    },
  );
