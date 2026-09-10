import type {
  PluginAdapter,
  PluginDefinition,
  PluginCapabilities,
  PluginRecord,
  PluginRequest,
} from "./ecosystem-types";

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid account data response");
  return value as Record<string, any>;
}
function value(v: unknown, max = 512): string {
  if (typeof v !== "string" || !v || v.length > max)
    throw new Error("Incomplete connected-service response");
  return v;
}
/** Endpoint identities and response shapes are source-reviewed; availability is not a production assertion. */
function projection(input: unknown): PluginRecord {
  const row = object(input),
    data = object(row.data);
  if (typeof row.version !== "string" && typeof row.version !== "number")
    throw new Error("Record revision is missing");
  const at =
    typeof row.updatedAt === "number"
      ? row.updatedAt
      : Date.parse(String(row.updatedAt));
  return {
    id: value(row.id),
    collection: value(row.type),
    title: String(data.name ?? data.title ?? row.id).slice(0, 500),
    revision: String(row.version),
    ...(Number.isFinite(at) ? { updatedAt: at } : {}),
    data,
  };
}
function account(input: unknown) {
  const v = object(input),
    subject = object(v.subject),
    tenant = object(v.tenant);
  return {
    id: value(subject.id),
    tenantId: value(tenant.id),
    name:
      typeof tenant.label === "string"
        ? tenant.label.slice(0, 200)
        : value(tenant.id),
  };
}
async function projectionChanges(
  request: PluginRequest,
  endpoint: string,
  cursor: string,
) {
  const url = new URL(endpoint);
  url.searchParams.set("limit", "100");
  url.searchParams.set("cursor", cursor);
  const result = object(await request(url.href));
  if (!Array.isArray(result.changes))
    throw new Error("Invalid account change feed");
  return {
    cursor: value(result.nextCursor, 4096),
    hasMore: result.hasMore === true,
    resetSnapshot: result.resetSnapshot === true,
    changes: result.changes.map((input: unknown) => {
      const row = object(input);
      return row.deleted
        ? { deleted: { collection: value(row.type), id: value(row.objectId) } }
        : { record: projection(row.object) };
    }),
  };
}
/** Product-owned scoped transport. Only source-defined operations are dispatched. */
function nativeAdapter(
  origin: string,
  capabilities: PluginCapabilities,
): PluginAdapter {
  return {
    account(input) {
      const claims = object(input),
        row = object(claims.account);
      return {
        id: value(claims.sub),
        tenantId: value(row.tenantId),
        name: value(row.name),
      };
    },
    async snapshot(request, _account, page) {
      const url = new URL("/api/hades/records", origin);
      if (page) url.searchParams.set("page", page);
      const result = object(await request(url.href));
      if (!Array.isArray(result.records))
        throw new Error("Invalid account snapshot");
      return {
        records: result.records as PluginRecord[],
        ...(result.nextPage ? { nextPage: value(result.nextPage, 4096) } : {}),
        cursor: value(result.cursor, 4096),
      };
    },
    async changes(request, _account, cursor) {
      const url = new URL("/api/hades/changes", origin);
      url.searchParams.set("cursor", cursor);
      const result = object(await request(url.href));
      if (!Array.isArray(result.changes))
        throw new Error("Invalid account change feed");
      return {
        changes: result.changes,
        cursor: value(result.cursor, 4096),
        hasMore: result.hasMore === true,
        resetSnapshot: result.resetSnapshot === true,
      };
    },
    async write(request, _account, input) {
      const supported = capabilities.writes.find(
        (write) =>
          write.collection === input.collection &&
          write.operation === input.operation,
      );
      if (
        !supported ||
        !Object.keys(input.data).length ||
        Object.keys(input.data).some(
          (key) => !supported.fields.includes(key),
        ) ||
        supported.requiredFields?.some(
          (key) => !Object.hasOwn(input.data, key),
        ) ||
        (input.operation === "rename" && typeof input.data.name !== "string")
      )
        throw new Error("Choose a supported operation and its allowed fields");
      return request(new URL("/api/hades/records", origin).href, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
    },
    ...(capabilities.detail === "service"
      ? {
          async record(
            request: PluginRequest,
            _account: unknown,
            collection: string,
            id: string,
          ) {
            if (!capabilities.reads.includes(collection))
              throw new Error("Unsupported collection");
            const url = new URL("/api/hades/records", origin);
            url.searchParams.set("collection", collection);
            url.searchParams.set("id", id);
            return object(await request(url.href)).record as PluginRecord;
          },
        }
      : {}),
  };
}
function nativeOAuth(
  origin: string,
  id: "cadre" | "govern" | "glove",
  scopes: string[],
  writeScopes: string[],
  readScopes = scopes.filter((scope) => !writeScopes.includes(scope)),
) {
  const endpoint = (path: string) => new URL("/api/hades/" + path, origin).href;
  return {
    issuer: origin,
    authorizationEndpoint: endpoint("authorize"),
    tokenEndpoint: endpoint("token"),
    userInfoEndpoint: endpoint("userinfo"),
    revocationEndpoint: endpoint("revoke"),
    clientId: "hades-desktop-" + id,
    scopes,
    readScopes,
    writeScopes,
    allowedOrigins: [origin],
  };
}
const CADRE_CAPABILITIES: PluginCapabilities = {
  reads: ["bots", "tasks", "spaces"],
  detail: "snapshot",
  writes: [
    {
      collection: "bots",
      operation: "rename",
      fields: ["name"],
      requiredFields: ["name"],
      requiredScopes: ["bots:write"],
      description: "Rename an authorized agent.",
      keyFormat: "url-safe",
    },
    {
      collection: "bots",
      operation: "update",
      fields: ["name", "description"],
      requiredScopes: ["bots:content:write"],
      description:
        "Edit an owned agent’s name or description with a revision check. Requires additional account consent.",
      keyFormat: "url-safe",
    },
  ],
};
const GOVERN_CAPABILITIES: PluginCapabilities = {
  reads: ["agents", "policies", "workspaces"],
  detail: "snapshot",
  writes: [
    {
      collection: "agents",
      operation: "rename",
      fields: ["name"],
      requiredFields: ["name"],
      requiredScopes: ["agents:write"],
      description: "Rename an agent.",
      keyFormat: "url-safe",
    },
    {
      collection: "agents",
      operation: "agent.update",
      fields: ["name", "description", "provider", "model"],
      requiredScopes: ["agents:read", "agents:metadata:write"],
      fieldScopes: {
        provider: ["agents:configuration:write"],
        model: ["agents:configuration:write"],
      },
      description:
        "Edit agent name and description. Provider and model edits require separate configuration consent. Requires current workspace owner or admin.",
      keyFormat: "url-safe",
    },
    {
      collection: "policies",
      operation: "policy.update",
      fields: ["name", "description"],
      requiredScopes: ["policies:read", "policies:metadata:write"],
      description:
        "Edit policy name and description with a revision check. Requires current workspace owner or admin and separate metadata consent.",
      keyFormat: "url-safe",
    },
  ],
};
const GLOVE_CAPABILITIES: PluginCapabilities = {
  reads: [
    "products",
    "sessions",
    "recordings",
    "workspaces",
    "knowledge",
    "transcripts",
    "outcomes",
  ],
  readScopes: {
    knowledge: ["knowledge:read"],
    transcripts: ["transcripts:read"],
    outcomes: ["outcomes:read"],
  },
  detail: "service",
  writes: [
    {
      collection: "products",
      operation: "rename",
      fields: ["name"],
      requiredFields: ["name"],
      requiredScopes: ["products:write"],
      description: "Rename an authorized product.",
      keyFormat: "url-safe",
    },
    {
      collection: "products",
      operation: "update",
      fields: [
        "name",
        "audience",
        "valueProposition",
        "pricingSummary",
        "forbiddenClaims",
        "painPoints",
        "topFeatures",
        "competitors",
      ],
      requiredScopes: ["products:read", "products:update"],
      description:
        "Edit product content and feature lists with a revision check. Requires product management and additional account consent.",
      keyFormat: "url-safe",
    },
    {
      collection: "knowledge",
      operation: "update",
      fields: ["title", "content", "category", "status"],
      requiredScopes: ["knowledge:read", "knowledge:write"],
      description:
        "Edit knowledge content, category and publication status with a revision check. Requires knowledge management permission.",
      keyFormat: "url-safe",
    },
  ],
};
export const ECOSYSTEM_PLUGINS: readonly PluginDefinition[] = [
  {
    id: "stored",
    name: "Stored",
    origin: "https://stored.to",
    description: "Shared memories and knowledge.",
    capabilities: {
      reads: ["memories"],
      detail: "snapshot",
      writes: [
        {
          collection: "memories",
          operation: "update",
          fields: ["content"],
          requiredFields: ["content"],
          description:
            "Update memory content on a supported workspace engine with a revision check.",
          keyFormat: "url-safe",
        },
      ],
    },
    // Defined by the reviewed Stored provisioning source. Deployment and the
    // operator registration receipt are release gates, not an existing-client claim.
    oauth: {
      issuer: "https://stored.to",
      authorizationEndpoint: "https://stored.to/oauth/authorize",
      tokenEndpoint: "https://stored.to/oauth/token",
      revocationEndpoint: "https://stored.to/oauth/revoke",
      userInfoEndpoint: "https://stored.to/oauth/userinfo",
      resource: "https://stored.to/api",
      clientId: "sto_client_hades_desktop_v1",
      scopes: ["openid", "profile", "org:read", "memory:read", "memory:write"],
      readScopes: ["org:read", "memory:read"],
      writeScopes: ["memory:write"],
      allowedOrigins: ["https://stored.to"],
    },
    adapter: {
      account(input) {
        const row = object(input);
        value(row.org_role);
        return {
          id: value(row.sub),
          tenantId: value(row.org_id),
          name: value(row.org_name),
        };
      },
      async snapshot(request, _account, page) {
        const url = new URL("https://stored.to/api/v1/oauth/memories");
        if (page) url.searchParams.set("page", page);
        const result = object(await request(url.href));
        if (!Array.isArray(result.records))
          throw new Error("Invalid Stored memory snapshot");
        return {
          records: result.records as PluginRecord[],
          ...(result.nextPage
            ? { nextPage: value(result.nextPage, 4096) }
            : {}),
        };
      },
      async write(request, _account, input) {
        if (
          input.collection !== "memories" ||
          input.operation !== "update" ||
          typeof input.data.content !== "string" ||
          Object.keys(input.data).some((key) => key !== "content")
        )
          throw new Error(
            "Use the supported memory update operation with content",
          );
        return request("https://stored.to/api/v1/oauth/memories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: input.key,
            id: input.id,
            operation: "update",
            expectedRevision: input.expectedRevision,
            data: input.data,
          }),
        });
      },
    },
  },
  {
    id: "operate",
    name: "Operate",
    origin: "https://www.operate.to",
    description: "Projects, tasks and workspace activity.",
    capabilities: {
      reads: ["workspace", "space", "project", "list", "task", "agent", "run"],
      detail: "snapshot",
      writes: [
        {
          collection: "task",
          operation: "task.update",
          fields: ["title", "description"],
          requiredFields: ["title", "description"],
          description:
            "Update task title and description with the observed revision. Requires workspace owner or admin.",
          keyFormat: "url-safe",
        },
      ],
    },
    oauth: {
      issuer: "https://www.operate.to",
      authorizationEndpoint: "https://www.operate.to/oauth/authorize",
      tokenEndpoint: "https://www.operate.to/oauth/token",
      registrationEndpoint: "https://www.operate.to/oauth/register",
      revocationEndpoint: "https://www.operate.to/oauth/revoke",
      userInfoEndpoint: "https://www.operate.to/api/companyos/v1/account",
      resource: "https://www.operate.to/api/companyos",
      scopes: [
        "companyos:account:read",
        "companyos:data:read",
        "companyos:data:write",
      ],
      readScopes: ["companyos:data:read"],
      writeScopes: ["companyos:data:write"],
      allowedOrigins: ["https://www.operate.to"],
    },
    adapter: {
      account,
      eventsEndpoint: "https://www.operate.to/api/companyos/v1/events",
      async initialize(request, _account, installationId) {
        await request("https://www.operate.to/api/companyos/v1/installation", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ externalInstallationId: installationId }),
        });
      },
      async snapshot(request, _account, page) {
        const url = new URL("https://www.operate.to/api/companyos/v1/snapshot");
        url.searchParams.set("limit", "200");
        if (page) url.searchParams.set("cursor", page);
        const v = object(await request(url.href));
        if (!Array.isArray(v.objects))
          throw new Error("Invalid Operate snapshot");
        return {
          records: v.objects.map(projection),
          ...(typeof v.nextCursor === "string"
            ? { nextPage: v.nextCursor }
            : {}),
          cursor: value(v.checkpoint, 4096),
        };
      },
      changes: (request, _account, cursor) =>
        projectionChanges(
          request,
          "https://www.operate.to/api/companyos/v1/changes",
          cursor,
        ),
      async write(request, _account, input) {
        if (
          input.collection !== "task" ||
          input.operation !== "task.update" ||
          Object.keys(input.data).some(
            (key) => !["title", "description"].includes(key),
          )
        )
          throw new Error(
            "Use the supported task.update operation with title and description",
          );
        return request("https://www.operate.to/api/companyos/v1/write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...input.data,
            operation: "task.update",
            id: input.id,
            expectedVersion: input.expectedRevision,
            idempotencyKey: input.key,
          }),
        });
      },
    },
  },
  {
    id: "scalar",
    name: "Scalar",
    origin: "https://tryscalar.xyz",
    description: "Contacts, relationships and revenue workflows.",
    capabilities: {
      reads: ["contacts"],
      detail: "snapshot",
      writes: [
        {
          collection: "contacts",
          operation: "update",
          fields: ["name", "notes"],
          description:
            "Update contact name or notes. Other contact fields are not exposed by this connector.",
          keyFormat: "uuid",
        },
      ],
    },
    oauth: {
      issuer: "https://tryscalar.xyz",
      authorizationEndpoint: "https://tryscalar.xyz/oauth/authorize",
      tokenEndpoint: "https://tryscalar.xyz/oauth/token",
      registrationEndpoint: "https://tryscalar.xyz/oauth/register",
      revocationEndpoint: "https://tryscalar.xyz/oauth/revoke",
      userInfoEndpoint: "https://tryscalar.xyz/oauth/userinfo",
      scopes: ["openid", "profile", "crm:read", "crm:write"],
      readScopes: ["crm:read"],
      writeScopes: ["crm:write"],
      allowedOrigins: ["https://tryscalar.xyz"],
    },
    adapter: {
      account(input) {
        const v = object(input),
          workspace = object(v.workspace);
        return {
          id: value(v.sub),
          tenantId: value(workspace.id),
          name: value(workspace.name ?? v.name ?? v.sub),
        };
      },
      async snapshot(request, _account, page) {
        const url = new URL("https://tryscalar.xyz/api/oauth/contacts");
        if (page) url.searchParams.set("page", page);
        const v = object(await request(url.href));
        if (!Array.isArray(v.records))
          throw new Error("Invalid Scalar contact response");
        return {
          records: v.records as PluginRecord[],
          ...(typeof v.nextPage === "string" ? { nextPage: v.nextPage } : {}),
        };
      },
      async write(request, _account, input) {
        if (input.collection !== "contacts" || input.operation !== "update")
          throw new Error("Choose the supported contacts update operation");
        if (
          !/^[a-f0-9-]{36}$/.test(input.key) ||
          Object.keys(input.data).some(
            (key) => !["name", "notes"].includes(key),
          )
        )
          throw new Error("Use a UUID key and supported contact fields");
        return request("https://tryscalar.xyz/api/oauth/contacts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: input.key,
            id: input.id,
            expectedRevision: input.expectedRevision,
            operation: "update",
            data: input.data,
          }),
        });
      },
    },
  },
  {
    id: "company-os",
    name: "Company OS",
    origin: "https://www.companyos.sh",
    description: "Companies, documents, decisions and shared work.",
    capabilities: {
      reads: ["document"],
      detail: "service",
      writes: [
        {
          collection: "document",
          operation: "document.update",
          fields: ["title", "content", "message", "templateVersion"],
          requiredFields: ["title", "content", "message", "templateVersion"],
          description:
            "Append a document revision to the active main branch. Supply a revision message and the integer templateVersion from the full record.",
          keyFormat: "url-safe",
        },
      ],
    },
    oauth: {
      issuer: "https://www.companyos.sh",
      authorizationEndpoint: "https://www.companyos.sh/oauth/authorize",
      tokenEndpoint: "https://www.companyos.sh/oauth/token",
      revocationEndpoint: "https://www.companyos.sh/oauth/revoke",
      userInfoEndpoint: "https://www.companyos.sh/api/plugins/v1/account",
      resource: "https://www.companyos.sh/api/plugins/v1",
      clientId: "hades-desktop-companyos-v1",
      scopes: [
        "companyos:account:read",
        "companyos:data:read",
        "companyos:data:write",
      ],
      readScopes: ["companyos:data:read"],
      writeScopes: ["companyos:data:write"],
      allowedOrigins: ["https://www.companyos.sh"],
    },
    adapter: {
      account,
      eventsEndpoint: "https://www.companyos.sh/api/plugins/v1/events",
      async snapshot(request, _account, page) {
        const url = new URL("https://www.companyos.sh/api/plugins/v1/snapshot");
        url.searchParams.set("limit", "100");
        if (page) url.searchParams.set("cursor", page);
        const v = object(await request(url.href));
        if (!Array.isArray(v.objects))
          throw new Error("Invalid Company OS snapshot");
        return {
          records: v.objects.map(projection),
          ...(typeof v.nextCursor === "string"
            ? { nextPage: v.nextCursor }
            : {}),
          cursor: value(v.checkpoint, 4096),
        };
      },
      changes: (request, _account, cursor) =>
        projectionChanges(
          request,
          "https://www.companyos.sh/api/plugins/v1/changes",
          cursor,
        ),
      async record(request, _account, collection, id) {
        if (collection !== "document")
          throw new Error("Unsupported Company OS collection");
        return projection(
          await request(
            "https://www.companyos.sh/api/plugins/v1/records/" +
              encodeURIComponent(id),
          ),
        );
      },
      async write(request, _account, input) {
        if (
          input.collection !== "document" ||
          input.operation !== "document.update"
        )
          throw new Error("Choose the supported document.update operation");
        if (
          Object.keys(input.data).some(
            (key) =>
              !["title", "content", "message", "templateVersion"].includes(key),
          )
        )
          throw new Error("Unsupported document update field");
        return request("https://www.companyos.sh/api/plugins/v1/write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...input.data,
            operation: "document.update",
            id: input.id,
            expectedVersion: input.expectedRevision,
            idempotencyKey: input.key,
          }),
        });
      },
    },
  },
  {
    id: "cadre",
    name: "Cadre",
    origin: "https://cadre.to",
    description: "Your workforce, tasks and workspaces.",
    oauth: nativeOAuth(
      "https://cadre.to",
      "cadre",
      [
        "bots:read",
        "tasks:read",
        "spaces:read",
        "bots:write",
        "bots:content:write",
        "bots:instructions:read",
      ],
      ["bots:write", "bots:content:write"],
      ["bots:read", "tasks:read", "spaces:read"],
    ),
    adapter: nativeAdapter("https://cadre.to", CADRE_CAPABILITIES),
    capabilities: CADRE_CAPABILITIES,
  },
  {
    id: "glove",
    name: "Glove",
    origin: "https://glove.so",
    description: "Demos, sessions and product workflows.",
    oauth: nativeOAuth(
      "https://glove.so",
      "glove",
      [
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
      ["products:write", "products:update", "knowledge:write"],
      ["products:read", "sessions:read", "recordings:read", "workspaces:read"],
    ),
    adapter: nativeAdapter("https://glove.so", GLOVE_CAPABILITIES),
    capabilities: GLOVE_CAPABILITIES,
  },
  {
    id: "govern",
    name: "Govern",
    origin: "https://govern.sh",
    description: "Workspace identities, agents and policies.",
    oauth: nativeOAuth(
      "https://govern.sh",
      "govern",
      [
        "agents:read",
        "policies:read",
        "workspaces:read",
        "agents:write",
        "agents:metadata:write",
        "agents:configuration:write",
        "policies:metadata:write",
      ],
      [
        "agents:write",
        "agents:metadata:write",
        "agents:configuration:write",
        "policies:metadata:write",
      ],
    ),
    adapter: nativeAdapter("https://govern.sh", GOVERN_CAPABILITIES),
    capabilities: GOVERN_CAPABILITIES,
  },
];
