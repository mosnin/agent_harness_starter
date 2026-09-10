import { describe, expect, it } from "vitest";
import { ECOSYSTEM_PLUGINS } from "../core/ecosystem-catalog";
import {
  canWritePlugin,
  grantedPluginCapabilities,
} from "../core/ecosystem-capabilities";
import type {
  EcosystemId,
  PluginAccount,
  PluginRequest,
  PluginRecord,
  PluginWrite,
} from "../core/ecosystem-types";

// Source-coupled DTO fixtures, not live interoperability. Read at 2026-09-10:
// Stored agentwiki37ef3df: web/src/app/oauth/userinfo/route.ts; source patch
// /2026-09-10/stored-oauth-source-patch/source/web/{src/app/api/v1/oauth/memories/route.ts,src/lib/oauth/hades-client.ts}.
// Operate /Users/preston/operate-companyos-connect: src/app/api/companyos/v1/{account,snapshot,installation,write,changes,events}/route.ts.
// Scalar Sicarii7922be8 /2026-09-06/sicarii-ui-reference: src/lib/oauth-contact-data.ts; src/app/oauth/userinfo/route.ts.
// Company OS /Users/preston/company-os-web: convex/oauth{,Http,Policy}.ts and app/api/plugins/v1/*/route.ts.
// Govern /Users/preston/govern-remediation-integration/src/lib/hades-oauth.ts.
// Cadre /2026-09-05/cadre-revamp/rakazo/packages/core/src/node/hades-oauth.ts.
// Glove /2026-09-06/glove-audit/source: convex/hadesOAuth{,Store}.ts,
// convex/_lib/hadesOAuthContract.ts, lib/hades/transport.ts.
const definitions = {
  stored: {
    origin: "https://stored.to",
    path: "/api/v1/oauth/memories",
    scopes: ["openid", "profile", "org:read", "memory:read", "memory:write"],
    audience: "https://stored.to/api",
    client: "sto_client_hades_desktop_v1",
  },
  operate: {
    origin: "https://www.operate.to",
    path: "/api/companyos/v1/snapshot",
    scopes: [
      "companyos:account:read",
      "companyos:data:read",
      "companyos:data:write",
    ],
    audience: "https://www.operate.to/api/companyos",
    client: undefined,
  },
  scalar: {
    origin: "https://tryscalar.xyz",
    path: "/api/oauth/contacts",
    scopes: ["openid", "profile", "crm:read", "crm:write"],
    audience: undefined,
    client: undefined,
  },
  "company-os": {
    origin: "https://www.companyos.sh",
    path: "/api/plugins/v1/snapshot",
    scopes: [
      "companyos:account:read",
      "companyos:data:read",
      "companyos:data:write",
    ],
    audience: "https://www.companyos.sh/api/plugins/v1",
    client: "hades-desktop-companyos-v1",
  },
  cadre: {
    origin: "https://cadre.to",
    path: "/api/hades/records",
    scopes: [
      "bots:read",
      "tasks:read",
      "spaces:read",
      "bots:write",
      "bots:content:write",
      "bots:instructions:read",
    ],
    audience: undefined,
    client: "hades-desktop-cadre",
  },
  glove: {
    origin: "https://glove.so",
    path: "/api/hades/records",
    scopes: [
      "products:read",
      "sessions:read",
      "recordings:read",
      "workspaces:read",
      "products:write",
      "products:update",
      "knowledge:read",
      "knowledge:write",
      "transcripts:read",
      "outcomes:read",
    ],
    audience: undefined,
    client: "hades-desktop-glove",
  },
  govern: {
    origin: "https://govern.sh",
    path: "/api/hades/records",
    scopes: [
      "agents:read",
      "policies:read",
      "workspaces:read",
      "agents:write",
      "agents:metadata:write",
      "agents:configuration:write",
      "policies:metadata:write",
    ],
    audience: undefined,
    client: "hades-desktop-govern",
  },
} as const;
function plugin(id: EcosystemId) {
  const found = ECOSYSTEM_PLUGINS.find((row) => row.id === id)!;
  expect(found.adapter, id + " source adapter").toBeDefined();
  return found;
}
function transport(...responses: unknown[]) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const request: PluginRequest = async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (!responses.length) throw Error("Unexpected provider request");
    return responses.shift();
  };
  return { request, calls };
}
const who: PluginAccount = {
  id: "human",
  tenantId: "tenant",
  name: "Workspace",
};
const record: PluginRecord = {
  id: "record",
  collection: "memories",
  title: "Title",
  revision: "7",
  updatedAt: 1770000000000,
  data: { content: "Complete content" },
};
const projected = {
  id: "document",
  type: "document",
  version: "7",
  updatedAt: "2026-02-02T02:40:00.000Z",
  data: { title: "Document", content: { summary: "Full content" } },
};
function sourceProjection(id: "operate" | "company-os") {
  return id === "company-os"
    ? projected
    : {
        id: "operate:task:task-id",
        type: "task",
        version: "a".repeat(64),
        updatedAt: projected.updatedAt,
        data: { title: "Task", description: "Complete description" },
      };
}
const native = ["cadre", "glove", "govern"] as const;

describe("source-reviewed native account catalog", () => {
  it.each(Object.keys(definitions) as EcosystemId[])(
    "%s pins exact origin, scopes, public client and resource",
    (id) => {
      const actual = plugin(id),
        source = definitions[id];
      expect(actual.origin).toBe(source.origin);
      expect(actual.unavailableReason).toBeUndefined();
      expect(actual.oauth).toMatchObject({
        issuer: source.origin,
        allowedOrigins: [source.origin],
        scopes: [...source.scopes],
      });
      expect(actual.oauth?.clientId).toBe(source.client);
      expect(actual.oauth?.resource).toBe(source.audience);
      for (const endpoint of [
        actual.oauth!.authorizationEndpoint,
        actual.oauth!.tokenEndpoint,
        actual.oauth!.userInfoEndpoint,
        actual.oauth!.revocationEndpoint,
      ])
        expect(new URL(endpoint!).origin).toBe(source.origin);
      const prefix = native.includes(id as (typeof native)[number])
        ? "/api/hades"
        : "/oauth";
      expect(new URL(actual.oauth!.authorizationEndpoint).pathname).toBe(
        prefix + "/authorize",
      );
      expect(new URL(actual.oauth!.tokenEndpoint).pathname).toBe(
        prefix + "/token",
      );
      expect(
        actual.oauth!.writeScopes.every((scope) =>
          source.scopes.includes(scope as never),
        ),
      ).toBe(true);
    },
  );
  it("preserves explicit human and tenant identities for Stored, Scalar and projection services", () => {
    expect(
      plugin("stored").adapter!.account({
        sub: "user-s",
        org_id: "org-s",
        org_name: "Stored org",
        org_role: "admin",
      }),
    ).toEqual({ id: "user-s", tenantId: "org-s", name: "Stored org" });
    expect(() =>
      plugin("stored").adapter!.account({
        sub: "user-s",
        org_name: "Name",
        org_role: "admin",
      }),
    ).toThrow();
    expect(
      plugin("scalar").adapter!.account({
        sub: "user-c",
        workspace: { id: "crm-account", name: "CRM", role: "member" },
      }),
    ).toEqual({ id: "user-c", tenantId: "crm-account", name: "CRM" });
    for (const id of ["operate", "company-os"] as const)
      expect(
        plugin(id).adapter!.account({
          subject: { id: "user" },
          tenant: { id: "workspace", label: "Chosen workspace" },
          roles: ["owner"],
        }),
      ).toEqual({
        id: "user",
        tenantId: "workspace",
        name: "Chosen workspace",
      });
  });
  it.each(native)(
    "%s maps explicit human sub and provider tenant separately",
    (id) => {
      // Govern exposes workspace account identity; Cadre/Glove bind tenant:actor.
      const accountId = id === "govern" ? "tenant" : "tenant:actor";
      expect(
        plugin(id).adapter!.account({
          sub: "actor",
          name: "Org",
          account: { id: accountId, tenantId: "tenant", name: "Org" },
          iss: definitions[id].origin,
        }),
      ).toEqual({ id: "actor", tenantId: "tenant", name: "Org" });
      expect(() =>
        plugin(id).adapter!.account({
          sub: "actor",
          account: { id: accountId, name: "Org" },
        }),
      ).toThrow();
    },
  );
  it.each(["stored", "scalar", ...native] as const)(
    "%s retains common record and page fields exactly",
    async (id) => {
      const source = definitions[id],
        fixture = {
          ...record,
          collection:
            id === "stored"
              ? "memories"
              : id === "scalar"
                ? "contacts"
                : id === "cadre"
                  ? "bots"
                  : id === "glove"
                    ? "products"
                    : "agents",
        };
      const io = transport({
        records: [fixture],
        nextPage: "next-page",
        ...(native.includes(id as (typeof native)[number])
          ? { cursor: "41" }
          : {}),
      });
      const result = await plugin(id).adapter!.snapshot(
        io.request,
        who,
        "prior-page",
      );
      expect(result.records).toEqual([fixture]);
      expect(result.nextPage).toBe("next-page");
      expect(result.cursor).toBe(
        native.includes(id as (typeof native)[number]) ? "41" : undefined,
      );
      expect(io.calls[0].url.origin + io.calls[0].url.pathname).toBe(
        source.origin + source.path,
      );
      expect(io.calls[0].url.searchParams.get("page")).toBe("prior-page");
    },
  );
  it.each(["operate", "company-os"] as const)(
    "%s maps projection pages and preserves first-page change checkpoint",
    async (id) => {
      const io = transport(
        {
          objects: [sourceProjection(id)],
          nextCursor: "page+/=",
          checkpoint: "first-checkpoint",
        },
        { objects: [], nextCursor: null, checkpoint: "first-checkpoint" },
      );
      const adapter = plugin(id).adapter!,
        first = await adapter.snapshot(io.request, who),
        last = await adapter.snapshot(io.request, who, first.nextPage);
      expect(first).toMatchObject({
        records: [
          {
            id: sourceProjection(id).id,
            collection: sourceProjection(id).type,
            title: sourceProjection(id).data.title,
            revision: sourceProjection(id).version,
            updatedAt: Date.parse(projected.updatedAt),
            data: sourceProjection(id).data,
          },
        ],
        nextPage: "page+/=",
        cursor: "first-checkpoint",
      });
      expect(last).toEqual({ records: [], cursor: "first-checkpoint" });
      expect(io.calls[1].url.searchParams.get("cursor")).toBe("page+/=");
      expect(io.calls[0].url.searchParams.get("limit")).toBe(
        id === "operate" ? "200" : "100",
      );
    },
  );
  it("uses Operate PUT installation registration with the exact stable ID", async () => {
    const io = transport({ status: "active" });
    await plugin("operate").adapter!.initialize!(
      io.request,
      who,
      "hades:installation",
    );
    expect(io.calls[0].url.href).toBe(
      "https://www.operate.to/api/companyos/v1/installation",
    );
    expect(io.calls[0].init?.method).toBe("PUT");
    expect(JSON.parse(String(io.calls[0].init?.body))).toEqual({
      externalInstallationId: "hades:installation",
    });
  });
  it.each(["operate", "company-os"] as const)(
    "%s retains reset and equal-version tombstones through delta mapping",
    async (id) => {
      const io = transport({
        changes: [
          {
            eventId: "a",
            deleted: false,
            objectId: sourceProjection(id).id,
            type: sourceProjection(id).type,
            object: sourceProjection(id),
          },
          {
            eventId: "b",
            deleted: true,
            objectId: sourceProjection(id).id,
            type: sourceProjection(id).type,
            version: sourceProjection(id).version,
          },
        ],
        nextCursor: "next+/=",
        hasMore: true,
        resetSnapshot: true,
      });
      const result = await plugin(id).adapter!.changes!(
        io.request,
        who,
        "previous+/=",
        new AbortController().signal,
      );
      expect(result).toMatchObject({
        cursor: "next+/=",
        hasMore: true,
        resetSnapshot: true,
        changes: [
          {
            record: {
              id: sourceProjection(id).id,
              revision: sourceProjection(id).version,
            },
          },
          {
            deleted: {
              collection: sourceProjection(id).type,
              id: sourceProjection(id).id,
            },
          },
        ],
      });
      expect(io.calls[0].url.searchParams.get("cursor")).toBe("previous+/=");
    },
  );
  it.each(native)(
    "%s passes ordered source deltas and tombstones without inventing live mode",
    async (id) => {
      const changes = [
        { record },
        { deleted: { collection: record.collection, id: record.id } },
      ];
      const io = transport({ changes, cursor: "42", hasMore: true });
      expect(
        await plugin(id).adapter!.changes!(
          io.request,
          who,
          "41",
          new AbortController().signal,
        ),
      ).toMatchObject({ changes, cursor: "42", hasMore: true });
      expect(io.calls[0].url.pathname).toBe("/api/hades/changes");
      expect(plugin(id).adapter!.eventsEndpoint).toBeUndefined();
    },
  );
  it("retains Company OS full document content and encoded record ID", async () => {
    const io = transport(projected);
    expect(
      (
        await plugin("company-os").adapter!.record!(
          io.request,
          who,
          "document",
          "doc/id",
        )
      ).data,
    ).toEqual(projected.data);
    expect(io.calls[0].url.pathname).toBe("/api/plugins/v1/records/doc%2Fid");
  });
});
const writes: Record<
  EcosystemId,
  {
    collection: string;
    operation: string;
    data: Record<string, unknown>;
    endpoint: string;
  }
> = {
  stored: {
    collection: "memories",
    operation: "update",
    data: { content: "New content" },
    endpoint: "/api/v1/oauth/memories",
  },
  scalar: {
    collection: "contacts",
    operation: "update",
    data: { name: "Contact", notes: "Notes" },
    endpoint: "/api/oauth/contacts",
  },
  operate: {
    collection: "task",
    operation: "task.update",
    data: { title: "Task", description: "Description" },
    endpoint: "/api/companyos/v1/write",
  },
  "company-os": {
    collection: "document",
    operation: "document.update",
    data: {
      title: "Document",
      content: { summary: "Summary" },
      message: "Approved update",
      templateVersion: 1,
    },
    endpoint: "/api/plugins/v1/write",
  },
  cadre: {
    collection: "bots",
    operation: "rename",
    data: { name: "Bot" },
    endpoint: "/api/hades/records",
  },
  glove: {
    collection: "products",
    operation: "rename",
    data: { name: "Product" },
    endpoint: "/api/hades/records",
  },
  govern: {
    collection: "agents",
    operation: "rename",
    data: { name: "Agent" },
    endpoint: "/api/hades/records",
  },
};
describe("source-owned write DTOs", () => {
  it("reads full Glove records through the source detail endpoint and limits optional collections to consent", async () => {
    const definition = plugin("glove"),
      record = {
        id: "knowledge-doc",
        collection: "knowledge",
        title: "Full knowledge",
        revision: "9",
        data: { content: "Complete product knowledge" },
      },
      io = transport({ record, related: [], cursor: "9" });
    expect(
      await definition.adapter!.record!(
        io.request,
        who,
        "knowledge",
        "knowledge-doc",
      ),
    ).toEqual(record);
    expect(io.calls[0].url.pathname).toBe("/api/hades/records");
    expect(io.calls[0].url.searchParams.get("collection")).toBe("knowledge");
    expect(io.calls[0].url.searchParams.get("id")).toBe("knowledge-doc");
    expect(
      grantedPluginCapabilities(definition, definition.oauth!.readScopes)!
        .reads,
    ).toEqual(["products", "sessions", "recordings", "workspaces"]);
    expect(
      grantedPluginCapabilities(definition, definition.oauth!.scopes)!.reads,
    ).toContain("transcripts");
  });
  it.each([
    [
      "products",
      { audience: "Sales teams", topFeatures: ["Real demos"] },
      "products:update",
    ],
    [
      "knowledge",
      { content: "Complete updated knowledge", status: "draft" },
      "knowledge:write",
    ],
  ] as const)(
    "Glove %s updates require new consent and use actual product fields",
    async (collection, data, writeScope) => {
      const definition = plugin("glove"),
        legacy = [
          ...definition.oauth!.readScopes,
          "products:write",
          "knowledge:read",
        ],
        input: PluginWrite = {
          key: "durable-plugin-write",
          collection,
          operation: "update",
          id: "owned-record",
          expectedRevision: "4",
          data: structuredClone(data),
        },
        io = transport({ status: "applied" });
      expect(canWritePlugin(definition, legacy, input)).toBe(false);
      expect(canWritePlugin(definition, [...legacy, writeScope], input)).toBe(
        true,
      );
      await definition.adapter!.write!(io.request, who, input);
      expect(JSON.parse(String(io.calls[0].init?.body))).toEqual(input);
      await expect(
        definition.adapter!.write!(io.request, who, {
          ...input,
          data: { productId: "other-parent" },
        }),
      ).rejects.toThrow("allowed fields");
      expect(io.calls).toHaveLength(1);
    },
  );
  it.each([
    [
      "cadre",
      "bots",
      "update",
      { description: "Actual agent description" },
      "bots:content:write",
    ],
    [
      "govern",
      "agents",
      "agent.update",
      { description: "Actual agent description" },
      "agents:metadata:write",
    ],
    [
      "govern",
      "policies",
      "policy.update",
      { description: "Actual policy description" },
      "policies:metadata:write",
    ],
  ] as const)(
    "%s %s/%s requires new consent and preserves its exact envelope",
    async (id, collection, operation, data, extraScope) => {
      const definition = plugin(id),
        legacy = [
          ...definition.oauth!.readScopes,
          id === "cadre" ? "bots:write" : "agents:write",
        ],
        input: PluginWrite = {
          key: "idempotent-write-key",
          collection,
          operation,
          id: "owned-record",
          expectedRevision: "7",
          data,
        },
        io = transport({ status: "applied" });
      expect(canWritePlugin(definition, legacy)).toBe(true);
      expect(canWritePlugin(definition, legacy, input)).toBe(false);
      expect(canWritePlugin(definition, [...legacy, extraScope], input)).toBe(
        true,
      );
      await definition.adapter!.write!(io.request, who, input);
      expect(JSON.parse(String(io.calls[0].init?.body))).toEqual(input);
      expect(
        grantedPluginCapabilities(definition, legacy)!.writes.map(
          (w) => w.operation,
        ),
      ).toEqual(["rename"]);
    },
  );
  it("requires configuration consent for Govern provider/model fields independently of metadata consent", () => {
    const definition = plugin("govern"),
      scopes = [...definition.oauth!.readScopes, "agents:metadata:write"],
      input: PluginWrite = {
        key: "idempotent-write-key",
        collection: "agents",
        operation: "agent.update",
        id: "owned-record",
        expectedRevision: "7",
        data: { model: "new-model" },
      };
    expect(canWritePlugin(definition, scopes, input)).toBe(false);
    expect(
      canWritePlugin(
        definition,
        [...scopes, "agents:configuration:write"],
        input,
      ),
    ).toBe(true);
    expect(
      grantedPluginCapabilities(definition, scopes)!.writes.find(
        (w) => w.operation === "agent.update",
      )!.fields,
    ).toEqual(["name", "description"]);
    expect(
      canWritePlugin(definition, definition.oauth!.scopes, {
        ...input,
        data: { apiKey: "never" },
      }),
    ).toBe(false);
  });
  it.each(Object.keys(writes) as EcosystemId[])(
    "%s emits its actual conditional mutation envelope",
    async (id) => {
      const source = writes[id],
        input: PluginWrite = {
          ...source,
          key: "12345678-1234-4234-8234-123456789abc",
          id:
            id === "operate"
              ? "operate:task:task-id"
              : "12345678-1234-4234-8234-123456789abc",
          expectedRevision: native.includes(id as (typeof native)[number])
            ? "7"
            : "a".repeat(64),
        };
      delete (input as Partial<typeof source>).endpoint;
      const io = transport({ status: "applied" });
      await plugin(id).adapter!.write!(io.request, who, input);
      expect(io.calls[0].url.href).toBe(
        definitions[id].origin + source.endpoint,
      );
      expect(io.calls[0].init?.method).toBe("POST");
      const body = JSON.parse(String(io.calls[0].init?.body));
      const expected =
        id === "operate" || id === "company-os"
          ? {
              ...source.data,
              operation: source.operation,
              id: input.id,
              expectedVersion: input.expectedRevision,
              idempotencyKey: input.key,
            }
          : native.includes(id as (typeof native)[number])
            ? input
            : {
                key: input.key,
                id: input.id,
                expectedRevision: input.expectedRevision,
                operation: source.operation,
                data: source.data,
              };
      expect(body).toEqual(expected);
      expect(body).not.toHaveProperty("accessToken");
      expect(body).not.toHaveProperty("resource");
      expect(plugin(id).capabilities!.writes).toContainEqual(
        expect.objectContaining({
          collection: source.collection,
          operation: source.operation,
          fields: expect.arrayContaining(Object.keys(source.data)),
        }),
      );
    },
  );
  it.each(Object.keys(writes) as EcosystemId[])(
    "%s refuses fields outside the source mutation before dispatch",
    async (id) => {
      const io = transport({}),
        source = writes[id];
      await expect(
        plugin(id).adapter!.write!(io.request, who, {
          key: "12345678-1234-4234-8234-123456789abc",
          id: "target",
          collection: source.collection,
          operation: source.operation,
          expectedRevision: "7",
          data: { ...source.data, apiKey: "not-allowed" },
        }),
      ).rejects.toThrow();
      expect(io.calls).toEqual([]);
    },
  );
  it("requires all Company OS mandatory source fields in the advertised write capability", () => {
    expect(plugin("company-os").capabilities!.writes[0].requiredFields).toEqual(
      expect.arrayContaining([
        "title",
        "content",
        "message",
        "templateVersion",
      ]),
    );
  });
});
