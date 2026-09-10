import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { EcosystemStore } from "./ecosystem-store";
import { boundedPluginJson, PluginHttpError } from "./ecosystem-http";
import { streamPluginEvents } from "./ecosystem-events";
import { ECOSYSTEM_PLUGINS } from "./ecosystem-catalog";
import {
  canWritePlugin,
  grantedPluginCapabilities,
} from "./ecosystem-capabilities";
import type {
  EcosystemId,
  PluginAccount,
  PluginAdapter,
  PluginConnection,
  PluginData,
  PluginDefinition,
  PluginRecord,
  PluginRequest,
  PluginTokens,
  PluginView,
  PluginWrite,
  PluginWriteReceipt,
} from "./ecosystem-types";

const bounded = (v: unknown, max = 512): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max || v.includes("\0"))
    throw new Error("Invalid plugin value");
  return v;
};
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Invalid service response");
  return v as Record<string, unknown>;
};
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
const digest = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
const scopeIdentity = (scopes: string[]) => digest([...scopes].sort());
const MAX_RECORDS = 10_000,
  MAX_DATA_BYTES = 20 * 1024 * 1024;
interface Pending {
  profile: string;
  pluginId: EcosystemId;
  generation: string;
  verifier: string;
  state: string;
  clientId: string;
  expiresAt: number;
  redirect: string;
  scopes: string[];
}

export class EcosystemService {
  private readonly store: EcosystemStore;
  private pending = new Map<string, Pending>();
  private connectIntents = new Map<string, string>();
  private controllers = new Map<string, AbortController>();
  private jobs = new Map<string, Promise<unknown>>();
  private refreshes = new Map<string, Promise<PluginTokens>>();
  private retryAt = new Map<string, number>();
  private watches = new Set<string>();
  private interruptedWatches = new Set<string>();
  private fallbackAt = new Map<string, number>();
  private failedBackgroundSyncUntil = new Map<string, number>();
  private backgroundPaused = false;
  private background = new Map<
    string,
    { controller: AbortController; job: Promise<unknown> }
  >();
  private reconnects = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  constructor(
    dataDir: string,
    private emit: (profile: string) => void,
    private definitions: readonly PluginDefinition[] = ECOSYSTEM_PLUGINS,
    private fetcher: typeof fetch = fetch,
    private now = Date.now,
  ) {
    this.store = new EcosystemStore(join(dataDir, "ecosystem.sqlite"));
    for (const connection of this.store.all())
      if (["connected", "syncing", "connecting"].includes(connection.status))
        this.store.save({
          ...connection,
          status: "stale",
          reason: "Unlock Plugins to reconnect and refresh account data.",
        });
  }
  unlock(key: string) {
    if (this.closed) throw new Error("Plugins are closed");
    this.store.unlock(key);
    return { unlocked: true };
  }
  private definition(id: unknown): PluginDefinition {
    const d = this.definitions.find((d) => d.id === id);
    if (!d) throw new Error("Unknown plugin");
    return d;
  }
  private available(id: unknown) {
    const d = this.definition(id);
    if (!d.oauth || !d.adapter)
      throw new Error(d.unavailableReason ?? "This plugin is not available");
    return d as PluginDefinition &
      Required<Pick<PluginDefinition, "oauth" | "adapter">>;
  }
  private identity(profile: string, id: EcosystemId) {
    return JSON.stringify([bounded(profile, 100), id]);
  }
  private active(c: PluginConnection) {
    if (
      this.closed ||
      this.store.get(c.profile, c.pluginId)?.generation !== c.generation
    )
      throw new Error("Account connection changed or Plugins closed");
    return this.store.get(c.profile, c.pluginId)!;
  }
  private controller(c: PluginConnection) {
    const key = this.identity(c.profile, c.pluginId);
    let controller = this.controllers.get(key);
    if (!controller) {
      controller = new AbortController();
      this.controllers.set(key, controller);
    }
    return controller;
  }
  private signal(c: PluginConnection, signal?: AbortSignal) {
    const base = this.controller(c).signal;
    return signal ? AbortSignal.any([base, signal]) : base;
  }
  private changed(c: PluginConnection) {
    this.emit(c.profile);
  }
  private update(c: PluginConnection, patch: Partial<PluginConnection>) {
    const next = { ...this.active(c), ...patch };
    this.store.save(next);
    this.changed(next);
    return next;
  }
  private track<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.jobs.get(key);
    if (existing) return existing as Promise<T>;
    const job = Promise.resolve().then(run);
    this.jobs.set(key, job);
    void job
      .finally(() => {
        if (this.jobs.get(key) === job) this.jobs.delete(key);
      })
      .catch(() => {});
    return job;
  }
  list(profile: string): PluginView[] {
    bounded(profile, 100);
    return this.definitions.map((d) => {
      const c = this.store.get(profile, d.id);
      return {
        id: d.id,
        name: d.name,
        origin: d.origin,
        description: d.description,
        capabilities: c?.account
          ? grantedPluginCapabilities(d, c.scopes)
          : d.capabilities,
        status:
          !d.oauth || !d.adapter
            ? "unavailable"
            : (c?.status ?? "disconnected"),
        reason: !d.oauth || !d.adapter ? d.unavailableReason : c?.reason,
        account: c?.account,
        collections: [
          ...new Set(
            this.store.records(profile, d.id).map((r) => r.collection),
          ),
        ],
        lastSyncedAt: c?.lastSyncedAt,
        agentRead: c?.agentRead ?? false,
        agentWrite: c?.agentWrite ?? false,
        scopes: c?.scopes ?? [],
        syncMode: !d.adapter
          ? "unavailable"
          : c && this.watches.has(c.generation)
            ? "live"
            : d.adapter.changes
              ? "changes"
              : "polling",
      };
    });
  }
  async connect(
    profile: string,
    pluginId: unknown,
    access: unknown = "write",
  ): Promise<{ authorizationUrl: string; requestId: string }> {
    const d = this.available(pluginId);
    bounded(profile, 100);
    if (access !== "read" && access !== "write")
      throw new Error("Choose read or read and write account access");
    const requestedScopes = d.oauth.scopes.filter(
      (scope) => access === "write" || !d.oauth.writeScopes.includes(scope),
    );
    if (!this.store.unlocked)
      throw new Error("Unlock Plugins in macOS Keychain first");
    // Local disconnect happens synchronously; retain this new intent before
    // waiting for remote revocation. A later Disconnect or Connect supersedes it.
    const revocation = this.disconnect(profile, d.id);
    const key = this.identity(profile, d.id),
      intent = randomUUID();
    this.connectIntents.set(key, intent);
    await revocation;
    if (this.closed) throw new Error("Plugins are closed");
    if (this.connectIntents.get(key) !== intent)
      throw new Error("Account connection changed");
    this.connectIntents.delete(key);
    const c: PluginConnection = {
      profile,
      pluginId: d.id,
      generation: randomUUID(),
      status: "connecting",
      agentRead: false,
      agentWrite: false,
      scopes: [],
    };
    this.store.save(c);
    this.changed(c);
    return this.track("connect:" + c.generation, async () => {
      try {
        const redirect = `ai.hades.desktop:/oauth/${d.id}`;
        let clientId = d.oauth.clientId ?? this.store.client(profile, d.id);
        if (!clientId && d.oauth.registrationEndpoint) {
          const v = object(
            await this.json(d, d.oauth.registrationEndpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                client_name: "Hades Agent",
                redirect_uris: [redirect],
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                token_endpoint_auth_method: "none",
              }),
              signal: this.signal(c),
            }),
          );
          clientId = bounded(v.client_id, 1024);
          if (
            v.token_endpoint_auth_method &&
            v.token_endpoint_auth_method !== "none"
          )
            throw new Error("Service did not register a public native client");
        }
        this.active(c);
        if (!clientId)
          throw new Error(
            "This service has not registered Hades as a native OAuth client",
          );
        this.store.saveClient(profile, d.id, clientId);
        for (const [key, p] of this.pending)
          if (p.expiresAt <= this.now()) this.pending.delete(key);
        if (this.pending.size >= 32)
          throw new Error(
            "Finish or cancel an existing account connection first",
          );
        const state = randomBytes(32).toString("base64url"),
          verifier = randomBytes(32).toString("base64url");
        this.pending.set(state, {
          profile,
          pluginId: d.id,
          generation: c.generation,
          verifier,
          state,
          clientId,
          expiresAt: this.now() + 600_000,
          redirect,
          scopes: requestedScopes,
        });
        const url = new URL(d.oauth.authorizationEndpoint);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", clientId);
        url.searchParams.set("redirect_uri", redirect);
        url.searchParams.set("scope", requestedScopes.join(" "));
        url.searchParams.set("state", state);
        url.searchParams.set(
          "code_challenge",
          createHash("sha256").update(verifier).digest("base64url"),
        );
        url.searchParams.set("code_challenge_method", "S256");
        if (d.oauth.resource)
          url.searchParams.set("resource", d.oauth.resource);
        return { authorizationUrl: url.href, requestId: c.generation };
      } catch (error) {
        if (this.store.get(profile, d.id)?.generation === c.generation)
          this.update(c, {
            status: "error",
            reason:
              "Could not start account connection. Check service availability and native client registration.",
          });
        throw error;
      }
    });
  }
  /** Native OS callback only; no renderer RPC accepts OAuth codes or vault material. */
  async callback(raw: string) {
    const url = new URL(bounded(raw, 16_384));
    const states = url.searchParams.getAll("state");
    if (states.length !== 1) throw new Error("Invalid OAuth state");
    const p = this.pending.get(states[0]);
    if (!p || p.expiresAt <= this.now())
      throw new Error(
        "This account connection expired. Start again in Plugins.",
      );
    const base = new URL(p.redirect);
    if (
      url.protocol !== base.protocol ||
      url.host !== base.host ||
      url.pathname !== base.pathname ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error("OAuth callback does not match this connection");
    const d = this.available(p.pluginId);
    if (
      url.searchParams.has("iss") &&
      (url.searchParams.getAll("iss").length !== 1 ||
        url.searchParams.get("iss") !== d.oauth.issuer)
    )
      throw new Error("OAuth issuer does not match this connection");
    this.pending.delete(p.state);
    const c = this.store.get(p.profile, p.pluginId);
    if (!c || c.generation !== p.generation)
      throw new Error("Account connection changed");
    return this.track("callback:" + p.generation, async () => {
      try {
        if (url.searchParams.has("error"))
          throw new Error("Account connection was not authorized");
        const codes = url.searchParams.getAll("code");
        if (codes.length !== 1) throw new Error("Invalid authorization code");
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          code: bounded(codes[0], 8192),
          client_id: p.clientId,
          redirect_uri: p.redirect,
          code_verifier: p.verifier,
        });
        if (d.oauth.resource) body.set("resource", d.oauth.resource);
        const tokens = this.parseTokens(
          await this.json(d, d.oauth.tokenEndpoint, {
            method: "POST",
            body,
            signal: this.signal(c),
          }),
          d,
          p.clientId,
          undefined,
          p.scopes,
        );
        this.active(c);
        const account = d.adapter.account(
          await this.json(d, d.oauth.userInfoEndpoint, {
            headers: { Authorization: `Bearer ${tokens.accessToken}` },
            signal: this.signal(c),
          }),
        );
        this.validateAccount(account);
        this.active(c);
        const next = {
          ...c,
          account,
          scopes: tokens.scopes,
          status: "connected" as const,
          reason: undefined,
        };
        this.store.save(next, tokens);
        this.changed(next);
        await d.adapter.initialize?.(
          this.request(next),
          account,
          `hades:${this.store.installationId}:${digest(c.profile).slice(0, 16)}`,
        );
        await this.sync(p.profile, p.pluginId);
        return { connected: true, pluginId: p.pluginId };
      } catch (error) {
        if (this.store.get(c.profile, c.pluginId)?.generation === c.generation)
          this.update(c, {
            status: "error",
            reason:
              "Account connection did not finish. Reconnect to authorize this account.",
          });
        throw new Error(
          "Account connection did not finish. Reconnect in Plugins.",
        );
      }
    });
  }
  private validateAccount(a: PluginAccount) {
    bounded(a.id);
    bounded(a.tenantId);
    bounded(a.name);
  }
  private json(
    d: PluginDefinition & { oauth: NonNullable<PluginDefinition["oauth"]> },
    url: string,
    init?: RequestInit,
    onDispatch?: () => void,
  ) {
    const fetcher: typeof fetch = onDispatch
      ? (target, options) => {
          onDispatch();
          return this.fetcher(target, options);
        }
      : this.fetcher;
    return boundedPluginJson(fetcher, d.oauth.allowedOrigins, url, init);
  }
  private parseTokens(
    input: unknown,
    d: PluginDefinition & { oauth: NonNullable<PluginDefinition["oauth"]> },
    clientId: string,
    old?: PluginTokens,
    requestedScopes = d.oauth.scopes,
  ): PluginTokens {
    const v = object(input);
    if (
      typeof v.token_type !== "string" ||
      v.token_type.toLowerCase() !== "bearer"
    )
      throw new Error("Expected a bearer token");
    const scopes =
      v.scope === undefined
        ? (old?.scopes ?? requestedScopes)
        : bounded(v.scope, 4096).split(/\s+/);
    if (
      scopes.some((s) => !(old?.scopes ?? requestedScopes).includes(s)) ||
      d.oauth.readScopes.some((s) => !scopes.includes(s))
    )
      throw new Error("The account did not grant the requested read access");
    if (
      typeof v.expires_in !== "number" ||
      !Number.isFinite(v.expires_in) ||
      v.expires_in <= 0 ||
      v.expires_in > 365 * 86400
    )
      throw new Error("Service returned an invalid token lifetime");
    const refreshToken =
      v.refresh_token === undefined
        ? old?.refreshToken
        : bounded(v.refresh_token, 16384);
    return {
      accessToken: bounded(v.access_token, 16384),
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt: this.now() + v.expires_in * 1000,
      scopes,
      clientId,
    };
  }
  private async token(c: PluginConnection): Promise<PluginTokens> {
    this.active(c);
    const key = c.generation,
      existing = this.refreshes.get(key);
    if (existing) return existing;
    const token = this.store.tokens(c);
    if (token.refreshUncertain)
      throw new Error(
        "Reconnect this account: the previous token refresh result is unknown",
      );
    if (token.expiresAt > this.now() + 30_000) return token;
    const job = (async () => {
      const d = this.available(c.pluginId);
      if (!token.refreshToken)
        throw new Error("This account expired. Reconnect in Plugins.");
      this.store.save(this.active(c), { ...token, refreshUncertain: true });
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
        client_id: token.clientId,
      });
      if (d.oauth.resource) body.set("resource", d.oauth.resource);
      const refreshed = this.parseTokens(
        await this.json(d, d.oauth.tokenEndpoint, {
          method: "POST",
          body,
          signal: this.signal(c),
        }),
        d,
        token.clientId,
        token,
      );
      const current = this.active(c);
      if (scopeIdentity(current.scopes) !== scopeIdentity(refreshed.scopes)) {
        // A saved projection may contain fields protected by an optional scope.
        // Clear it atomically with the reduced grant, including its old checkpoint.
        const next = {
          ...current,
          scopes: refreshed.scopes,
          agentWrite: current.agentWrite && canWritePlugin(d, refreshed.scopes),
          status: "stale" as const,
          reason:
            "Account permissions changed. Sync to load the currently authorized data.",
          cursor: undefined,
          lastSyncedAt: undefined,
        };
        this.store.commit(next, [], true, [], refreshed);
        this.changed(next);
      } else
        this.store.save({ ...current, scopes: refreshed.scopes }, refreshed);
      return refreshed;
    })();
    this.refreshes.set(key, job);
    void job.finally(() => this.refreshes.delete(key)).catch(() => {});
    return job;
  }
  private request(
    c: PluginConnection,
    signal?: AbortSignal,
    agentWrite = false,
    agentRead = false,
    writeInput?: PluginWrite,
    onWriteDispatch?: () => void,
  ): PluginRequest {
    return async (url, init = {}) => {
      const token = await this.token(c);
      const current = this.active(c);
      const d = this.available(c.pluginId);
      if (
        agentRead &&
        (!current.agentRead ||
          d.oauth.readScopes.some((s) => !token.scopes.includes(s)))
      )
        throw new Error("Agent read access was removed");
      if (
        agentWrite &&
        (!current.agentRead ||
          !current.agentWrite ||
          !canWritePlugin(d, token.scopes, writeInput))
      )
        throw new Error("Agent write access was removed");
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token.accessToken}`);
      return this.json(
        d,
        url,
        {
          ...init,
          headers,
          signal: this.signal(c, signal),
        },
        agentWrite &&
          !["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase())
          ? onWriteDispatch
          : undefined,
      );
    };
  }
  private validateRecords(records: PluginRecord[]) {
    if (!Array.isArray(records) || records.length > MAX_RECORDS)
      throw new Error("Plugin snapshot exceeds its record limit");
    const seen = new Set<string>();
    for (const r of records) {
      bounded(r.id);
      bounded(r.collection, 100);
      bounded(r.title, 500);
      if (r.revision !== undefined) bounded(r.revision, 512);
      if (r.updatedAt !== undefined && !Number.isFinite(r.updatedAt))
        throw new Error("Invalid record time");
      const key = JSON.stringify([r.collection, r.id]);
      if (seen.has(key))
        throw new Error("Plugin snapshot contains duplicate record identities");
      seen.add(key);
    }
    if (Buffer.byteLength(JSON.stringify(records)) > MAX_DATA_BYTES)
      throw new Error("Plugin snapshot exceeds its data limit");
  }
  private async snapshot(
    adapter: PluginAdapter,
    request: PluginRequest,
    account: PluginAccount,
  ) {
    const records: PluginRecord[] = [],
      pages = new Set<string>();
    let nextPage: string | undefined, cursor: string | undefined;
    do {
      const page = await adapter.snapshot(request, account, nextPage);
      if (!Array.isArray(page.records))
        throw new Error("Invalid plugin snapshot");
      records.push(...page.records);
      this.validateRecords(records);
      if (page.cursor !== undefined) {
        bounded(page.cursor, 4096);
        if (cursor !== undefined && cursor !== page.cursor)
          throw new Error("Snapshot checkpoint changed during pagination");
        cursor = page.cursor;
      }
      nextPage = page.nextPage;
      if (nextPage) {
        bounded(nextPage, 4096);
        if (pages.has(nextPage) || pages.size >= 100)
          throw new Error("Plugin pagination did not make progress");
        pages.add(nextPage);
      }
    } while (nextPage);
    return { records, cursor };
  }
  async sync(
    profile: string,
    id: unknown,
    signal?: AbortSignal,
    agent = false,
  ): Promise<PluginView> {
    const d = this.available(id),
      c = this.store.get(profile, d.id);
    if (!c?.account) throw new Error("Connect this account first");
    if (agent && !c.agentRead)
      throw new Error("Agent read access is not enabled for this plugin");
    return this.track("sync:" + c.generation, async () => {
      this.update(c, { status: "syncing", reason: undefined });
      try {
        const request = this.request(c, signal, false, agent);
        const observed = d.adapter.account(
          await request(d.oauth.userInfoEndpoint),
        );
        this.validateAccount(observed);
        if (
          observed.id !== c.account!.id ||
          observed.tenantId !== c.account!.tenantId
        )
          throw new Error("The service account changed. Reconnect.");
        const scoped = this.active(c),
          scopes = scopeIdentity(scoped.scopes),
          assertScopes = () => {
            if (agent && !this.active(c).agentRead)
              throw new Error("Agent read access was removed");
            if (scopeIdentity(this.active(c).scopes) !== scopes)
              throw new Error(
                "Account permissions changed during sync. Sync again.",
              );
          };
        let records: PluginRecord[] = [];
        if (d.adapter.changes && scoped.cursor) {
          const merged = new Map(
            this.store
              .records(profile, d.id)
              .map((r) => [JSON.stringify([r.collection, r.id]), r]),
          );
          let checkpoint = scoped.cursor,
            pages = 0,
            events = 0,
            hasMore = false,
            resets = 0;
          do {
            const changes = await d.adapter.changes(
              request,
              c.account!,
              checkpoint,
              this.signal(c, signal),
            );
            bounded(changes.cursor, 4096);
            if (
              !Array.isArray(changes.changes) ||
              ++pages > 100 ||
              (events += changes.changes.length) > 20_000
            )
              throw new Error("Change feed exceeds its batch limit");
            if (changes.hasMore && changes.cursor === checkpoint)
              throw new Error("Change feed did not advance its cursor");
            if (changes.resetSnapshot) {
              if (++resets > 3)
                throw new Error(
                  "Account visibility is changing. Refresh again when it settles.",
                );
              const snapshot = await this.snapshot(
                d.adapter,
                request,
                c.account!,
              );
              merged.clear();
              for (const row of snapshot.records)
                merged.set(JSON.stringify([row.collection, row.id]), row);
              // Resume from the replacement snapshot's starting checkpoint. Old
              // feed pages must not overwrite newer records or restore revoked rows.
              checkpoint = snapshot.cursor ?? changes.cursor;
              hasMore =
                snapshot.cursor !== undefined || changes.hasMore === true;
              continue;
            } else
              for (const change of changes.changes) {
                if ("record" in change) {
                  this.validateRecords([change.record]);
                  merged.set(
                    JSON.stringify([
                      change.record.collection,
                      change.record.id,
                    ]),
                    change.record,
                  );
                } else {
                  bounded(change.deleted.collection, 100);
                  bounded(change.deleted.id);
                  merged.delete(
                    JSON.stringify([
                      change.deleted.collection,
                      change.deleted.id,
                    ]),
                  );
                }
              }
            checkpoint = changes.cursor;
            hasMore = changes.hasMore === true;
          } while (hasMore);
          records = [...merged.values()];
          this.validateRecords(records);
          this.active(c);
          assertScopes();
          signal?.throwIfAborted();
          this.store.commit(
            {
              ...this.active(c),
              status: this.interruptedWatches.has(c.generation)
                ? "stale"
                : "connected",
              reason: this.interruptedWatches.has(c.generation)
                ? "Live updates are interrupted. Account data is refreshing periodically."
                : undefined,
              lastSyncedAt: this.now(),
              cursor: checkpoint,
            },
            records,
            true,
          );
        } else {
          const snapshot = await this.snapshot(d.adapter, request, c.account!);
          this.active(c);
          assertScopes();
          signal?.throwIfAborted();
          this.store.commit(
            {
              ...this.active(c),
              status: this.interruptedWatches.has(c.generation)
                ? "stale"
                : "connected",
              reason: this.interruptedWatches.has(c.generation)
                ? "Live updates are interrupted. Account data is refreshing periodically."
                : undefined,
              lastSyncedAt: this.now(),
              cursor: snapshot.cursor,
            },
            snapshot.records,
            true,
          );
        }
        this.changed(c);
        return this.list(profile).find((v) => v.id === d.id)!;
      } catch (error) {
        if (this.store.get(profile, d.id)?.generation === c.generation) {
          const revoked =
            error instanceof PluginHttpError &&
            [401, 403].includes(error.status);
          this.update(c, {
            status: revoked ? "error" : "stale",
            ...(revoked ? { agentRead: false, agentWrite: false } : {}),
            reason: revoked
              ? "This account needs authorization again. Reconnect in Plugins."
              : "Account data could not refresh. The saved data may be out of date.",
          });
        }
        throw error;
      }
    });
  }
  data(
    profile: string,
    id: unknown,
    input: { collection?: unknown; query?: unknown; offset?: unknown } = {},
    agent = false,
  ): PluginData {
    const d = this.definition(id),
      c = this.store.get(profile, d.id);
    if (agent && !c?.agentRead)
      throw new Error("Agent read access is not enabled for this plugin");
    const view = this.list(profile).find((v) => v.id === d.id)!;
    const offset = input.offset ?? 0;
    if (
      !Number.isSafeInteger(offset) ||
      Number(offset) < 0 ||
      Number(offset) > MAX_RECORDS
    )
      throw new Error("Invalid page offset");
    const query =
        input.query === undefined || input.query === ""
          ? ""
          : bounded(input.query, 200).toLowerCase(),
      collection =
        input.collection === undefined || input.collection === ""
          ? undefined
          : bounded(input.collection, 100);
    const records = this.store
      .records(profile, d.id)
      .filter(
        (r) =>
          (!collection || r.collection === collection) &&
          (!query ||
            r.title.toLowerCase().includes(query) ||
            JSON.stringify(r.data).toLowerCase().includes(query)),
      );
    return {
      records: records.slice(Number(offset), Number(offset) + 50),
      collections: view.collections,
      total: records.length,
      ...(Number(offset) + 50 < records.length
        ? { nextOffset: Number(offset) + 50 }
        : {}),
      status: view.status,
      lastSyncedAt: view.lastSyncedAt,
      account: view.account,
      ...(c?.snapshotId
        ? { snapshotId: digest({ snapshot: c.snapshotId, collection, query }) }
        : {}),
    };
  }
  /** Fresh first page, explicitly version-bound continuation or requested offline cache. */
  async read(
    profile: string,
    id: unknown,
    input: {
      collection?: unknown;
      query?: unknown;
      offset?: unknown;
      freshness?: unknown;
      expectedSnapshotId?: unknown;
    } = {},
    signal?: AbortSignal,
  ) {
    const d = this.available(id),
      c = this.store.get(profile, d.id);
    if (!c?.account || !c.agentRead)
      throw new Error("Agent read access is not enabled for this plugin");
    const initial = this.data(profile, d.id, input, true);
    const expected = input.expectedSnapshotId,
      freshness =
        input.freshness ?? (expected !== undefined ? "cached" : "refresh");
    if (freshness !== "refresh" && freshness !== "cached")
      throw new Error("Choose refresh or cached data freshness");
    if (
      expected !== undefined &&
      (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected))
    )
      throw new Error("Use the returned snapshotId for continuation");
    if (Number(input.offset ?? 0) > 0 && expected === undefined)
      throw new Error(
        "Further pages require expectedSnapshotId from the first page",
      );
    if (expected !== undefined && expected !== initial.snapshotId)
      throw new Error(
        "Account data or filters changed. Read again from the first page.",
      );
    signal?.throwIfAborted();
    if (freshness === "refresh") {
      const job = this.sync(profile, d.id, signal, true);
      // A background refresh may already own the shared sync. Cancelling this
      // reader must return promptly without assuming that separate work stopped.
      if (signal)
        await new Promise<void>((resolve, reject) => {
          const cancel = () =>
            reject(signal.reason ?? new Error("Plugin read cancelled"));
          signal.addEventListener("abort", cancel, { once: true });
          const finish = () => signal.removeEventListener("abort", cancel);
          void job.then(
            () => {
              finish();
              resolve();
            },
            (error) => {
              finish();
              reject(error);
            },
          );
          if (signal.aborted) {
            finish();
            cancel();
          }
        });
      else await job;
    }
    signal?.throwIfAborted();
    this.active(c);
    const page = this.data(profile, d.id, input, true);
    if (expected !== undefined && expected !== page.snapshotId)
      throw new Error(
        "Account data changed during refresh. Read again from the first page.",
      );
    return {
      ...page,
      source:
        freshness === "refresh"
          ? ("service-sync" as const)
          : ("snapshot" as const),
      ...(freshness === "refresh" ? { checkedAt: this.now() } : {}),
    };
  }
  permissions(profile: string, id: unknown, read: unknown, write: unknown) {
    if (
      typeof read !== "boolean" ||
      typeof write !== "boolean" ||
      (write && !read)
    )
      throw new Error("Writes require agent read access");
    const d = this.available(id),
      c = this.store.get(profile, d.id);
    if (!c?.account) throw new Error("Connect this account first");
    if (write && !canWritePlugin(d, c.scopes))
      throw new Error(
        "This service has not granted a supported write capability",
      );
    this.update(c, { agentRead: read, agentWrite: write });
    return this.list(profile).find((v) => v.id === d.id)!;
  }
  async record(
    profile: string,
    id: unknown,
    collection: unknown,
    recordId: unknown,
    agent = false,
    signal?: AbortSignal,
  ): Promise<{
    record: PluginRecord;
    account: PluginAccount;
    source: "service" | "snapshot";
    lastSyncedAt?: number;
  }> {
    const d = this.available(id),
      c = this.store.get(profile, d.id);
    bounded(collection, 100);
    bounded(recordId);
    if (!c?.account) throw new Error("Connect this account first");
    if (agent && !c.agentRead)
      throw new Error("Agent read access is not enabled for this plugin");
    return this.track(
      `record:${c.generation}:${agent}:${JSON.stringify([collection, recordId])}`,
      async () => {
        const request = this.request(c, signal, false, agent),
          observed = d.adapter.account(await request(d.oauth.userInfoEndpoint));
        this.validateAccount(observed);
        if (
          observed.id !== c.account!.id ||
          observed.tenantId !== c.account!.tenantId
        )
          throw new Error("The service account changed. Reconnect.");
        const scopes = scopeIdentity(this.active(c).scopes);
        const result = d.adapter.record
          ? await d.adapter.record(
              request,
              c.account!,
              collection as string,
              recordId as string,
            )
          : this.store
              .records(profile, d.id)
              .find((r) => r.collection === collection && r.id === recordId);
        this.active(c);
        if (scopeIdentity(this.active(c).scopes) !== scopes)
          throw new Error(
            "Account permissions changed during this read. Read again.",
          );
        if (agent && !this.active(c).agentRead)
          throw new Error("Agent read access was removed");
        signal?.throwIfAborted();
        if (!result) throw new Error("Record not found");
        this.validateRecords([result]);
        if (result.id !== recordId || result.collection !== collection)
          throw new Error("Record response identity changed");
        return {
          record: result,
          account: c.account!,
          source: d.adapter.record ? "service" : "snapshot",
          lastSyncedAt: c.lastSyncedAt,
        };
      },
    );
  }
  async write(
    profile: string,
    id: unknown,
    input: PluginWrite,
    signal?: AbortSignal,
  ): Promise<PluginWriteReceipt> {
    const d = this.available(id),
      c = this.store.get(profile, d.id);
    if (
      !c?.account ||
      !c.agentRead ||
      !c.agentWrite ||
      !canWritePlugin(d, c.scopes)
    )
      throw new Error("Agent write access is not granted");
    bounded(input.key, 100);
    bounded(input.collection, 100);
    bounded(input.id);
    bounded(input.operation, 100);
    bounded(input.expectedRevision);
    object(input.data);
    if (!canWritePlugin(d, c.scopes, input))
      throw new Error(
        "This operation or its fields require additional account permission",
      );
    if (Buffer.byteLength(JSON.stringify(input)) > 64 * 1024)
      throw new Error("Plugin write exceeds 64 KiB");
    const fingerprint = digest(input),
      previous = this.store.receipt(c, input.key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new Error("This write key is already bound to different input");
      // Retained receipts suppress duplicate effects. Their old response payload
      // may contain data from an earlier grant, so do not re-expose that payload.
      const { result: _result, ...retained } = previous;
      return retained;
    }
    const receipt: PluginWriteReceipt = {
      key: input.key,
      status: "pending",
      fingerprint,
      at: this.now(),
      accountId: c.account.id,
      tenantId: c.account.tenantId,
    };
    this.store.saveReceipt(c, receipt);
    return this.track("write:" + c.generation + ":" + input.key, async () => {
      let dispatched = false;
      try {
        signal?.throwIfAborted();
        const current = this.active(c);
        if (!current.agentWrite)
          throw new Error("Agent write access was removed");
        const request = this.request(c, signal, true, false, input, () => {
            dispatched = true;
          }),
          observed = d.adapter.account(await request(d.oauth.userInfoEndpoint));
        this.validateAccount(observed);
        if (
          observed.id !== c.account!.id ||
          observed.tenantId !== c.account!.tenantId
        )
          throw new Error("The service account changed. Reconnect.");
        this.active(c);
        signal?.throwIfAborted();
        const scopes = scopeIdentity(this.active(c).scopes);
        const result = await d.adapter.write!(request, c.account!, input);
        this.active(c);
        if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024)
          throw new Error("Write receipt is too large");
        const done = { ...receipt, status: "applied" as const, result };
        this.store.saveReceipt(c, done);
        this.update(c, {
          status: "stale",
          reason: "A change was submitted. Refresh to see the service record.",
        });
        if (scopeIdentity(this.active(c).scopes) !== scopes) {
          const { result: _result, ...retained } = done;
          return retained;
        }
        return done;
      } catch (error) {
        const failed = {
          ...receipt,
          status:
            !dispatched ||
            (error instanceof PluginHttpError &&
              [400, 401, 403, 404, 409, 412, 422].includes(error.status))
              ? ("rejected" as const)
              : ("unknown" as const),
        };
        this.store.saveReceipt(c, failed);
        return failed;
      }
    });
  }
  async disconnect(profile: string, id: unknown) {
    const d = this.definition(id),
      c = this.store.get(profile, d.id);
    bounded(profile, 100);
    const key = this.identity(profile, d.id);
    this.connectIntents.delete(key);
    this.controllers.get(key)?.abort();
    this.controllers.delete(key);
    for (const [state, p] of this.pending)
      if (p.profile === profile && p.pluginId === d.id)
        this.pending.delete(state);
    if (c) {
      clearTimeout(this.reconnects.get(c.generation));
      this.reconnects.delete(c.generation);
      this.retryAt.delete(c.generation);
      this.fallbackAt.delete(c.generation);
      this.failedBackgroundSyncUntil.delete(c.generation);
      this.interruptedWatches.delete(c.generation);
      this.watches.delete(c.generation);
      this.background.get(c.generation)?.controller.abort();
    }
    let token: PluginTokens | undefined;
    try {
      if (c) token = this.store.tokens(c);
    } catch {
      /* Locked vault never prevents local disconnect. */
    }
    this.store.remove(profile, d.id);
    this.emit(profile);
    if (token && d.oauth?.revocationEndpoint) {
      return this.track("revoke:" + (c?.generation ?? key), async () => {
        try {
          await this.json(
            d as PluginDefinition & {
              oauth: NonNullable<PluginDefinition["oauth"]>;
            },
            d.oauth!.revocationEndpoint!,
            {
              method: "POST",
              body: new URLSearchParams({
                client_id: token!.clientId,
                token: token!.refreshToken ?? token!.accessToken,
                token_type_hint: token!.refreshToken
                  ? "refresh_token"
                  : "access_token",
              }),
            },
          );
          return { disconnected: true, revoked: true };
        } catch {
          return {
            disconnected: true,
            revoked: false,
            reason:
              "Saved account data was removed. Remote revocation was not confirmed; review connected apps in the service. Write receipts are retained to prevent duplicate changes.",
          };
        }
      });
    }
    return {
      disconnected: true,
      revoked: false,
      ...(c?.account
        ? {
            reason:
              "Saved records and credentials were removed. Remote revocation could not be confirmed; review connected apps in the service. Write receipts remain on this Mac to prevent duplicate changes.",
          }
        : {}),
    };
  }
  private async syncBackgroundWatch(c: PluginConnection, signal: AbortSignal) {
    this.active(c);
    signal.throwIfAborted();
    if (this.now() < (this.failedBackgroundSyncUntil.get(c.generation) ?? 0))
      throw new Error("Account refresh is waiting after a failed attempt");
    this.fallbackAt.set(c.generation, this.now());
    try {
      await this.sync(c.profile, c.pluginId, signal);
      this.active(c);
      signal.throwIfAborted();
      this.failedBackgroundSyncUntil.delete(c.generation);
    } catch (error) {
      if (
        !this.closed &&
        !signal.aborted &&
        this.store.get(c.profile, c.pluginId)?.generation === c.generation
      )
        this.failedBackgroundSyncUntil.set(c.generation, this.now() + 30_000);
      throw error;
    }
  }
  /** Host schedules this only while the application runs; no invented background cloud worker. */
  tick() {
    if (this.closed || this.backgroundPaused || !this.store.unlocked) return;
    for (const c of this.store.all())
      if (
        c.account &&
        c.status !== "error" &&
        this.now() >= (this.retryAt.get(c.generation) ?? 0)
      ) {
        const d = this.available(c.pluginId);
        if (this.background.has(c.generation)) continue;
        if (d.adapter.eventsEndpoint) {
          this.startBackground(c, "watch", async (signal) => {
            let delay = 1000;
            try {
              const token = await this.token(c);
              this.active(c);
              signal.throwIfAborted();
              await streamPluginEvents(
                this.fetcher,
                d.oauth.allowedOrigins,
                d.adapter.eventsEndpoint!,
                token.accessToken,
                signal,
                async () => {
                  this.active(c);
                  signal.throwIfAborted();
                  await this.syncBackgroundWatch(c, signal);
                  this.active(c);
                  signal.throwIfAborted();
                  this.interruptedWatches.delete(c.generation);
                  this.watches.add(c.generation);
                  this.update(c, { status: "connected", reason: undefined });
                },
                () => {
                  this.update(c, {
                    status: "error",
                    agentRead: false,
                    agentWrite: false,
                    reason:
                      "The service revoked this connection. Reconnect in Plugins.",
                  });
                },
              );
            } catch (error) {
              delay = 15_000;
              if (
                !this.closed &&
                !signal.aborted &&
                this.store.get(c.profile, c.pluginId)?.generation ===
                  c.generation
              ) {
                this.watches.delete(c.generation);
                const revoked =
                  error instanceof PluginHttpError &&
                  [401, 403].includes(error.status);
                this.update(c, {
                  status: revoked ? "error" : "stale",
                  ...(revoked ? { agentRead: false, agentWrite: false } : {}),
                  reason: revoked
                    ? "This account needs authorization again. Reconnect in Plugins."
                    : "Live updates are interrupted. Saved data may be out of date.",
                });
                if (
                  !revoked &&
                  !this.backgroundPaused &&
                  this.active(c).status !== "error"
                ) {
                  this.interruptedWatches.add(c.generation);
                  const last = Math.max(
                    this.fallbackAt.get(c.generation) ?? 0,
                    this.active(c).lastSyncedAt ?? 0,
                  );
                  if (this.now() - last >= 30_000) {
                    // Same owned background job/signal, with the normal account/scope and atomic cursor checks.
                    // Record attempts too: a failing data API must not create a tight polling loop.
                    try {
                      signal.throwIfAborted();
                      await this.syncBackgroundWatch(c, signal);
                    } catch {
                      /* sync retains its precise authorization/freshness failure; never promote it here. */
                    }
                  }
                }
              }
            } finally {
              this.watches.delete(c.generation);
              if (!this.closed) {
                this.retryAt.set(c.generation, this.now() + delay);
                this.emit(c.profile);
              }
              if (
                !this.closed &&
                !this.backgroundPaused &&
                this.store.get(c.profile, c.pluginId)?.generation ===
                  c.generation
              ) {
                const timer = setTimeout(() => {
                  this.reconnects.delete(c.generation);
                  this.tick();
                }, delay);
                timer.unref?.();
                this.reconnects.set(c.generation, timer);
              }
            }
          });
        } else if (
          !d.adapter.eventsEndpoint &&
          (!c.lastSyncedAt || this.now() - c.lastSyncedAt >= 30_000)
        ) {
          this.retryAt.set(c.generation, this.now() + 30_000);
          this.startBackground(c, "poll", (signal) =>
            this.sync(c.profile, c.pluginId, signal),
          );
        }
      }
  }
  private startBackground(
    c: PluginConnection,
    kind: string,
    run: (signal: AbortSignal) => Promise<unknown>,
  ) {
    const controller = new AbortController(),
      job = this.track(kind + ":" + c.generation, () =>
        run(this.signal(c, controller.signal)),
      );
    this.background.set(c.generation, { controller, job });
    void job
      .finally(() => {
        if (this.background.get(c.generation)?.job === job)
          this.background.delete(c.generation);
      })
      .catch(() => {});
  }
  async pauseBackground() {
    this.backgroundPaused = true;
    for (const timer of this.reconnects.values()) clearTimeout(timer);
    this.reconnects.clear();
    for (const task of this.background.values()) task.controller.abort();
    await Promise.allSettled(
      [...this.background.values()].map((task) => task.job),
    );
  }
  resumeBackground() {
    if (this.closed) return;
    this.backgroundPaused = false;
    this.retryAt.clear();
    this.tick();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.pending.clear();
    this.connectIntents.clear();
    for (const controller of this.controllers.values()) controller.abort();
    await this.pauseBackground();
    await Promise.allSettled([
      ...this.jobs.values(),
      ...this.refreshes.values(),
    ]);
    this.store.close();
  }
}
