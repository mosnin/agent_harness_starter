import { captureFocus, restoreFocus } from "./focus";
import { icon } from "./icons";
import type {
  PluginView,
  PluginRecord,
  PluginData,
  PluginAccount,
} from "../core/ecosystem-types";
export type {
  PluginView,
  PluginRecord,
  PluginData,
} from "../core/ecosystem-types";

export const ecosystemPlugins = [
  { id: "stored", name: "Stored" },
  { id: "operate", name: "Operate" },
  { id: "scalar", name: "Scalar" },
  { id: "company-os", name: "Company OS" },
  { id: "cadre", name: "Cadre" },
  { id: "glove", name: "Glove" },
  { id: "govern", name: "Govern" },
] as const;

export type PluginStatus = PluginView["status"];
type Rpc = (method: string, args?: Record<string, unknown>) => Promise<any>;
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const statuses: Record<PluginStatus, string> = {
  disconnected: "Not connected",
  connecting: "Awaiting sign-in",
  connected: "Connected",
  syncing: "Syncing",
  stale: "Sync needed",
  error: "Needs attention",
  unavailable: "Unavailable",
};
const readable = (plugin?: PluginView) =>
  !!plugin?.account &&
  ["connected", "syncing", "stale", "error"].includes(plugin.status);
const accountKey = (account?: PluginAccount) =>
  JSON.stringify([account?.id, account?.tenantId]);
const scopeKey = (plugin?: PluginView) =>
  JSON.stringify([...(plugin?.scopes ?? [])].sort());
const syncLabels = {
  live: "Live updates",
  changes: "Change feed",
  polling: "Periodic snapshots",
  manual: "Manual sync",
  unavailable: "Sync unavailable",
};
const dateLabel = (value?: string | number) => {
  if (value === undefined || value === "") return "Not synced yet";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
    : "Time unavailable";
};
const control = (action: string, label: string, disabled = false, extra = "") =>
  `<button type="button" id="ecosystem-${action}" data-ecosystem-action="${action}" ${disabled ? "disabled" : ""} ${extra}>${label}</button>`;
const PAGE_LIMIT = 100;
const DETAIL_LIMIT = 32_000;

/** Plain account content is never interpreted as HTML or executable Markdown. */
function readableFields(data: unknown, limit: number) {
  let remaining = Math.min(limit, 64_000),
    nodes = 0,
    clipped = false;
  const label = (key: string) =>
    key
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .replace(/^./, (first) => first.toUpperCase());
  const text = (value: string) => {
    const length = Math.min(value.length, Math.max(0, remaining));
    remaining -= length;
    if (length < value.length) clipped = true;
    return esc(value.slice(0, length)) + (length < value.length ? "…" : "");
  };
  const render = (value: unknown, depth = 0): string => {
    if (remaining <= 0 || ++nodes > 200 || depth > 5) {
      clipped = true;
      return '<span class="help">See all fields below.</span>';
    }
    if (value === null || value === undefined)
      return '<span class="help">Not set</span>';
    if (typeof value === "string")
      return text(value) || '<span class="help">Empty</span>';
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (typeof value === "number") return text(String(value));
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (const item of value) {
        if (remaining <= 0 || nodes >= 200) {
          clipped = true;
          break;
        }
        items.push(`<li>${render(item, depth + 1)}</li>`);
      }
      return items.length
        ? `<ul>${items.join("")}</ul>`
        : '<span class="help">No items</span>';
    }
    if (typeof value === "object") {
      const fields: string[] = [];
      for (const [key, item] of Object.entries(value)) {
        if (remaining <= 0 || nodes >= 200) {
          clipped = true;
          break;
        }
        fields.push(
          `<div class="ecosystem-field"><dt>${text(label(key))}</dt><dd>${render(item, depth + 1)}</dd></div>`,
        );
      }
      return fields.length
        ? `<dl class="ecosystem-fields">${fields.join("")}</dl>`
        : '<span class="help">No fields</span>';
    }
    return text(String(value));
  };
  const html = render(data);
  return `${html}${clipped ? '<p class="help">This reading view is shortened. Open All fields to inspect the complete record.</p>' : ""}`;
}

/** Account data stays native. Only the authorization URL crosses into the system browser. */
export class EcosystemPluginsView {
  private host?: HTMLElement;
  private profile = "";
  private pluginId = "stored";
  private plugin?: PluginView;
  private records: PluginRecord[] = [];
  private collections: string[] = [];
  private selected?: number;
  private query = "";
  private collection = "";
  private offsets = [0];
  private nextOffset?: number;
  private total = 0;
  private loading = false;
  private busy = "";
  private error = "";
  private notice = "";
  private generation = 0;
  private pageGeneration = 0;
  private operation = 0;
  private poll?: ReturnType<typeof setTimeout>;
  private polls = 0;
  private pageClipped = false;
  private detailLoading = false;
  private detailError = "";
  private detailGeneration = 0;
  private noticePending = false;
  private detailLimit = DETAIL_LIMIT;
  private detailSource: "service" | "snapshot" = "snapshot";
  private metadataRequest = 0;
  private rawFieldsOpen = false;
  private connectionAccess: "read" | "write" = "read";

  constructor(
    private rpc: Rpc,
    private openUrl: (url: string) => Promise<unknown>,
    private unlock: () => Promise<unknown>,
  ) {}

  async open(profile: string, pluginId: string) {
    if (!ecosystemPlugins.some((plugin) => plugin.id === pluginId)) return;
    if (profile === this.profile && pluginId === this.pluginId && this.busy)
      return;
    if (profile !== this.profile || pluginId !== this.pluginId) {
      this.invalidate();
      this.profile = profile;
      this.pluginId = pluginId;
      this.plugin = undefined;
      this.records = [];
      this.collections = [];
      this.selected = undefined;
      this.query = "";
      this.collection = "";
      this.error = "";
      this.notice = "";
      this.connectionAccess = "read";
    }
    this.polls = 0;
    await this.refresh();
  }

  mount(host?: HTMLElement) {
    if (!host && this.host) this.invalidate();
    this.host = host;
    this.render();
    this.schedulePoll();
  }

  dispose() {
    this.invalidate();
    this.host = undefined;
  }

  changed() {
    if (!this.host?.isConnected) return;
    this.noticePending = true;
    if (this.loading || this.busy || this.detailLoading) return;
    if (this.selected !== undefined) {
      const request = ++this.metadataRequest,
        generation = this.generation,
        account = accountKey(this.plugin?.account);
      void this.rpc("ecosystem.list", { profile: this.profile })
        .then((plugins: PluginView[]) => {
          if (
            request !== this.metadataRequest ||
            generation !== this.generation
          )
            return;
          const plugin = plugins.find((row) => row.id === this.pluginId);
          if (
            accountKey(plugin?.account) !== account ||
            scopeKey(plugin) !== scopeKey(this.plugin)
          ) {
            void this.refresh();
            return;
          }
          this.plugin = plugin;
          this.render();
        })
        .catch(() => {});
      this.render();
      return;
    }
    this.noticePending = false;
    void this.refresh();
  }

  private async loadDetail(index: number) {
    const record = this.records[index];
    if (!record) return;
    const generation = this.generation,
      pageGeneration = this.pageGeneration,
      request = ++this.detailGeneration,
      account = this.plugin?.account;
    this.selected = index;
    this.detailLoading = true;
    this.detailError = "";
    this.detailLimit = DETAIL_LIMIT;
    this.detailSource = "snapshot";
    this.rawFieldsOpen = false;
    this.render();
    this.host
      ?.querySelector<HTMLElement>("#ecosystem-detail-title")
      ?.focus({ preventScroll: true });
    try {
      const result: {
        record: PluginRecord;
        account: PluginAccount;
        source?: "service" | "snapshot";
      } = await this.rpc("ecosystem.record", {
        profile: this.profile,
        pluginId: this.pluginId,
        collection: record.collection,
        id: record.id,
      });
      if (
        request !== this.detailGeneration ||
        generation !== this.generation ||
        pageGeneration !== this.pageGeneration ||
        this.selected !== index
      )
        return;
      if (
        !result?.record ||
        accountKey(result.account) !== accountKey(account) ||
        result.record.id !== record.id ||
        result.record.collection !== record.collection
      )
        throw new Error(
          "Record identity changed. Refresh the account to load its data.",
        );
      this.records[index] = result.record;
      this.detailSource = result.source ?? "snapshot";
    } catch (error) {
      if (request === this.detailGeneration && generation === this.generation)
        this.detailError = this.message(error);
    } finally {
      if (request === this.detailGeneration) {
        this.detailLoading = false;
        this.render();
        if (this.noticePending) this.changed();
      }
    }
  }

  private invalidate() {
    ++this.generation;
    ++this.pageGeneration;
    ++this.operation;
    ++this.detailGeneration;
    ++this.metadataRequest;
    this.detailLoading = false;
    this.detailError = "";
    this.noticePending = false;
    this.busy = "";
    this.loading = false;
    clearTimeout(this.poll);
    this.poll = undefined;
  }

  private async refresh() {
    const generation = ++this.generation,
      profile = this.profile,
      pluginId = this.pluginId;
    ++this.pageGeneration;
    ++this.detailGeneration;
    ++this.metadataRequest;
    this.detailLoading = false;
    this.detailError = "";
    this.noticePending = false;
    clearTimeout(this.poll);
    this.poll = undefined;
    this.loading = true;
    this.error = "";
    this.records = [];
    this.selected = undefined;
    this.nextOffset = undefined;
    this.offsets = [0];
    this.render();
    try {
      const plugins: PluginView[] = await this.rpc("ecosystem.list", {
        profile,
      });
      if (generation !== this.generation) return;
      const plugin = Array.isArray(plugins)
        ? plugins.find((item) => item.id === pluginId)
        : undefined;
      if (accountKey(plugin?.account) !== accountKey(this.plugin?.account)) {
        this.query = "";
        this.collection = "";
      }
      this.plugin = plugin;
      this.collections = plugin?.collections ?? [];
      if (this.collection && !this.collections.includes(this.collection))
        this.collection = "";
      if (readable(plugin)) await this.loadPage(generation);
    } catch (error) {
      if (generation === this.generation) {
        this.plugin = undefined;
        this.error = this.message(error);
      }
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.render();
        this.schedulePoll();
        if (this.noticePending) this.changed();
      }
    }
  }

  private async loadPage(generation = this.generation) {
    const pageGeneration = ++this.pageGeneration;
    const offset = this.offsets.at(-1)!;
    this.loading = true;
    this.error = "";
    this.records = [];
    this.selected = undefined;
    this.nextOffset = undefined;
    this.pageClipped = false;
    this.render();
    try {
      const page: PluginData = await this.rpc("ecosystem.data", {
        profile: this.profile,
        pluginId: this.pluginId,
        ...(this.collection ? { collection: this.collection } : {}),
        ...(this.query.trim() ? { query: this.query.trim() } : {}),
        offset,
      });
      if (
        generation !== this.generation ||
        pageGeneration !== this.pageGeneration
      )
        return;
      if (!page || !Array.isArray(page.records))
        throw new Error("The account data could not be read. Try refreshing.");
      // A concurrent reconnect must never label one account's records as another account.
      if (accountKey(page.account) !== accountKey(this.plugin?.account)) {
        this.plugin = undefined;
        throw new Error(
          "The connected account changed. Refresh to load its data.",
        );
      }
      this.plugin = {
        ...this.plugin!,
        status: page.status,
        lastSyncedAt: page.lastSyncedAt,
      };
      if (!readable(this.plugin)) return;
      this.records = page.records.slice(0, PAGE_LIMIT);
      this.pageClipped = page.records.length > PAGE_LIMIT;
      this.collections = Array.isArray(page.collections)
        ? page.collections
        : this.collections;
      this.total =
        Number.isSafeInteger(page.total) && page.total >= 0
          ? page.total
          : this.records.length;
      this.nextOffset =
        !this.pageClipped &&
        Number.isSafeInteger(page.nextOffset) &&
        page.nextOffset! > offset
          ? page.nextOffset
          : undefined;
    } catch (error) {
      if (
        generation === this.generation &&
        pageGeneration === this.pageGeneration
      )
        this.error = this.message(error);
    } finally {
      if (
        generation === this.generation &&
        pageGeneration === this.pageGeneration
      ) {
        this.loading = false;
        this.render();
      }
    }
  }

  private schedulePoll() {
    clearTimeout(this.poll);
    this.poll = undefined;
    if (
      !this.host?.isConnected ||
      this.loading ||
      this.busy ||
      this.polls >= 12 ||
      !["connecting", "syncing"].includes(this.plugin?.status ?? "")
    )
      return;
    this.poll = setTimeout(() => {
      this.poll = undefined;
      ++this.polls;
      void this.refresh();
    }, 5000);
  }

  private message(error: unknown) {
    return error instanceof Error
      ? error.message
      : "The request could not be completed.";
  }

  private async mutate(
    action: string,
    access?: { agentRead: boolean; agentWrite: boolean },
  ) {
    if (
      (this.busy && action !== "disconnect") ||
      (!this.plugin && action !== "unlock")
    )
      return;
    const operation = ++this.operation;
    ++this.generation;
    ++this.pageGeneration;
    clearTimeout(this.poll);
    this.poll = undefined;
    const profile = this.profile,
      pluginId = this.pluginId;
    this.busy = action;
    this.error = "";
    this.notice = "";
    this.loading = false;
    if (action === "connect" || action === "disconnect") {
      this.records = [];
      this.selected = undefined;
      this.nextOffset = undefined;
    }
    this.render();
    try {
      if (action === "connect") {
        await this.unlock();
        if (operation !== this.operation) return;
        const result: { authorizationUrl: string; requestId: string } =
          await this.rpc("ecosystem.connect", {
            profile,
            pluginId,
            access: this.connectionAccess,
          });
        if (operation !== this.operation) return;
        const url = new URL(result.authorizationUrl);
        if (url.protocol !== "https:" || url.username || url.password)
          throw new Error("This sign-in URL could not be opened.");
        await this.openUrl(url.href);
        if (operation !== this.operation) return;
        this.notice =
          "Complete sign-in in your browser, then return here. Connection status will update here.";
      } else if (action === "unlock") {
        await this.unlock();
        if (operation !== this.operation) return;
        this.notice = "Saved accounts unlocked. Checking connection status.";
      } else {
        const result = await this.rpc("ecosystem." + action, {
          profile,
          pluginId,
          ...(access ?? {}),
        });
        if (operation !== this.operation) return;
        this.notice =
          action === "disconnect"
            ? result?.reason ||
              "Account disconnected. Write receipts remain on this Mac to prevent duplicate changes."
            : action === "permissions"
              ? "Agent access updated."
              : "Sync completed. Check the last synced time for freshness.";
      }
      if (operation !== this.operation) return;
      this.busy = "";
      this.polls = 0;
      await this.refresh();
    } catch (error) {
      if (operation === this.operation) this.error = this.message(error);
    } finally {
      if (operation === this.operation) {
        this.busy = "";
        this.render();
        this.schedulePoll();
      }
    }
  }

  private render() {
    if (!this.host) return;
    const focus = captureFocus(this.host),
      scroll = this.host.querySelector(".ecosystem-page")?.scrollTop ?? 0;
    const plugin = this.plugin,
      name = ecosystemPlugins.find((item) => item.id === this.pluginId)!.name;
    const canRead = readable(plugin),
      busy = !!this.busy;
    const canWrite =
      !plugin?.capabilities || plugin.capabilities.writes.length > 0;
    const status = plugin
      ? (statuses[plugin.status] ?? "Status unavailable")
      : this.loading
        ? "Loading connection"
        : "Unavailable";
    const grants = plugin?.account
      ? `<section class="ecosystem-access" aria-labelledby="ecosystem-access-heading"><div><h2 id="ecosystem-access-heading">Agent access</h2><p>For this Hades profile, within the permissions granted by ${esc(name)}.</p></div><div class="ecosystem-grants">${(["Read", "Write"] as const).map((label) => `<label class="ecosystem-toggle"><input id="ecosystem-agent-${label.toLowerCase()}" type="checkbox" role="switch" ${plugin[label === "Read" ? "agentRead" : "agentWrite"] ? "checked" : ""} ${busy || this.loading || !canRead || (label === "Write" && !canWrite) ? "disabled" : ""}><span><strong>${label === "Read" ? "Read account data" : "Write account data"}</strong><small>${label === "Read" ? "Let agents retrieve connected records." : canWrite ? "Each change still requires approval in chat." : "Reconnect to grant supported write actions."}</small></span></label>`).join("")}</div></section>`
      : "";
    const actions = `${plugin && plugin.status !== "unavailable" ? `<label class="ecosystem-connection-access">Connection access<select id="ecosystem-connection-access" ${busy || this.loading ? "disabled" : ""}><option value="read" ${this.connectionAccess === "read" ? "selected" : ""}>Read account data</option><option value="write" ${this.connectionAccess === "write" ? "selected" : ""}>Read and write account data</option></select></label>` : ""}${control("unlock", this.busy === "unlock" ? "Unlocking…" : "Unlock saved accounts", busy || this.loading)}${control("refresh", this.loading ? "Refreshing…" : plugin?.status === "connecting" ? "Check connection" : "Refresh", this.loading || busy)}${plugin && plugin.status !== "unavailable" ? control("connect", this.busy === "connect" ? "Opening sign-in…" : plugin.account || plugin.status === "connecting" ? "Reconnect" : "Connect account", busy || this.loading, 'class="primary-button"') : ""}${canRead ? control("sync", this.busy === "sync" ? "Requesting sync…" : "Sync now", busy || this.loading || plugin?.status === "syncing") : ""}${plugin && (plugin.account || plugin.status === "connecting" || this.busy === "connect") ? control("disconnect", this.busy === "disconnect" ? "Disconnecting…" : "Disconnect", this.busy === "disconnect") : ""}`;
    this.host.innerHTML = `<div class="page ecosystem-page"><div class="page-heading ecosystem-heading"><div><span class="ecosystem-eyebrow">Plugins</span><h1>${esc(name)}</h1><p>${esc(plugin?.description || "Connect your account to browse its data and manage agent access.")}</p></div><span class="ecosystem-status" data-status="${esc(plugin?.status ?? "unavailable")}" role="status">${esc(status)}</span></div>
      ${this.error ? `<p class="ecosystem-notice" role="alert">${esc(this.error)}</p>` : ""}${this.notice ? `<p class="ecosystem-notice" role="status">${esc(this.notice)}</p>` : ""}
      <section class="ecosystem-account" aria-label="${esc(name)} account"><div class="ecosystem-account-identity">${icon("agents")}<div><h2>${esc(plugin?.account?.name || (this.loading ? "Loading account…" : "No connected account"))}</h2>${plugin?.origin ? `<p>${esc(plugin.origin)}</p>` : ""}${plugin?.account ? `<details><summary>Account details</summary><dl><dt>Account ID</dt><dd>${esc(plugin.account.id)}</dd>${plugin.account.tenantId ? `<dt>Organization</dt><dd>${esc(plugin.account.tenantId)}</dd>` : ""}</dl></details>` : ""}</div></div><div class="ecosystem-freshness"><span>Last synced</span><strong>${esc(dateLabel(plugin?.lastSyncedAt))}</strong>${plugin ? `<span>${esc(syncLabels[plugin.syncMode] ?? "Sync mode unavailable")}</span>` : ""}</div><div class="ecosystem-actions">${actions}</div>${plugin?.reason ? `<p class="ecosystem-reason">${esc(plugin.reason)}</p>` : !plugin && !this.loading && !this.error ? '<p class="ecosystem-reason">Connection details are not available. Refresh to try again.</p>' : ""}</section>
      ${grants}
      ${plugin?.account ? `<details class="ecosystem-scopes"><summary>Granted account permissions</summary><p>These permissions come from ${esc(name)}. Agent access switches can restrict their use; they cannot add permissions.</p>${plugin.scopes?.length ? `<ul>${plugin.scopes.map((scope) => `<li>${esc(scope)}</li>`).join("")}</ul>` : "<p>No account permissions reported.</p>"}</details>` : ""}
      ${plugin?.capabilities ? `<details class="ecosystem-scopes"><summary>Available data and actions</summary><p>Browse ${plugin.capabilities.reads.map(esc).join(", ")} records exposed by this connection.</p>${plugin.capabilities.writes.length ? `<ul>${plugin.capabilities.writes.map((write) => `<li>${esc(write.description)}</li>`).join("")}</ul>` : "<p>This connection provides read access.</p>"}</details>` : ""}
      ${this.noticePending && this.selected !== undefined ? `<div class="ecosystem-notice" role="status">Account sync status changed. ${control("refresh-data", "Refresh this view", this.loading || busy)}</div>` : ""}
      ${canRead ? this.dataHTML() : `<div class="ecosystem-empty" role="status"><h2>${this.loading ? "Loading your connection" : plugin?.status === "connecting" ? "Finish connecting your account" : plugin?.status === "unavailable" ? "Connection unavailable" : "Your account data will appear here"}</h2><p>${this.loading ? "Checking this profile’s connection status." : plugin?.status === "connecting" ? "Complete authorization in your browser. You can check the connection or disconnect at any time." : plugin?.status === "unavailable" ? esc(plugin.reason || "This connection is not available yet.") : `Connect ${esc(name)} to browse records. Agent access is controlled above once connected.`}</p></div>`}
    </div>`;
    this.bind();
    this.host.querySelector(".ecosystem-page")!.scrollTop = scroll;
    restoreFocus(this.host, focus);
  }

  private dataHTML() {
    const offset = this.offsets.at(-1)!;
    const selected =
      this.selected === undefined ? undefined : this.records[this.selected];
    return `<section class="ecosystem-data" aria-labelledby="ecosystem-data-heading"><div class="ecosystem-data-heading"><h2 id="ecosystem-data-heading">Account data</h2><span>${this.loading ? "Loading records…" : `${this.total.toLocaleString()} records`}</span></div><form id="ecosystem-filter" class="ecosystem-filter"><label>Collection<select id="ecosystem-collection" ${this.loading || this.busy ? "disabled" : ""}><option value="">All collections</option>${this.collections.map((collection) => `<option value="${esc(collection)}" ${collection === this.collection ? "selected" : ""}>${esc(collection)}</option>`).join("")}</select></label><label>Search saved fields<input id="ecosystem-query" type="search" maxlength="200" placeholder="Search this account" value="${esc(this.query)}" ${this.busy ? "disabled" : ""}></label><button id="ecosystem-search" type="submit" ${this.loading || this.busy ? "disabled" : ""}>Search</button></form>
      <div class="ecosystem-browser ${selected ? "has-detail" : ""}"><div class="ecosystem-records" aria-busy="${this.loading}">${this.loading ? '<p class="ecosystem-empty" role="status">Loading records…</p>' : this.records.length ? `<ul aria-label="Account records">${this.records.map((record, index) => `<li><button type="button" id="ecosystem-record-${index}" data-ecosystem-record="${index}" aria-pressed="${this.selected === index}" aria-controls="ecosystem-detail"><span class="ecosystem-record-title">${esc(record.title || record.id)}</span><span class="ecosystem-record-meta">${esc(record.collection)}${record.updatedAt !== undefined ? ` · ${esc(dateLabel(record.updatedAt))}` : ""}</span>${icon("right")}</button></li>`).join("")}</ul>` : `<div class="ecosystem-empty" role="status"><h3>${this.error ? "Records could not be loaded" : this.query || this.collection ? "No matching records" : "No records yet"}</h3><p>${this.error ? "Refresh to try again." : this.query || this.collection ? "Try another search or collection." : "Sync this account to check for available data."}</p></div>`}<nav class="ecosystem-pagination" aria-label="Record pages"><span>${this.records.length ? `${offset + 1}–${offset + this.records.length} of ${this.total.toLocaleString()}` : "No records shown"}</span>${control("previous", "Previous", this.offsets.length < 2 || this.loading || !!this.busy, 'aria-label="Previous page"')}${control("next", "Next", this.nextOffset === undefined || this.loading || !!this.busy, 'aria-label="Next page"')}</nav>${this.pageClipped ? '<p class="ecosystem-notice" role="status">This response exceeded the page limit. Showing the first 100 records; refresh or narrow your search.</p>' : ""}</div><aside id="ecosystem-detail" class="ecosystem-detail" aria-label="Record details">${selected ? this.detailHTML(selected) : '<div class="ecosystem-empty"><h3>Record details</h3><p>Select a record to see its fields.</p></div>'}</aside></div></section>`;
  }

  private detailHTML(record: PluginRecord) {
    let data: string;
    try {
      data = JSON.stringify(record.data, null, 2) ?? "No data";
    } catch {
      data = "This record could not be displayed.";
    }
    const clipped = data.length > this.detailLimit;
    return `<div class="ecosystem-detail-heading"><h3 id="ecosystem-detail-title" tabindex="-1">${esc(record.title || record.id)}</h3>${control("close-detail", icon("close"), false, 'aria-label="Close record details"')}</div><dl><dt>Collection</dt><dd>${esc(record.collection)}</dd><dt>Record ID</dt><dd>${esc(record.id)}</dd>${record.revision !== undefined ? `<dt>Revision</dt><dd>${esc(record.revision)}</dd>` : ""}${record.updatedAt !== undefined ? `<dt>Updated</dt><dd>${esc(dateLabel(record.updatedAt))}</dd>` : ""}</dl><h4>Content</h4>${this.detailLoading ? '<p role="status">Loading record…</p>' : `<p class="help">${this.detailSource === "service" ? "Read from the connected service." : "From the latest saved snapshot."}</p>`}${this.detailError ? `<p role="alert">${esc(this.detailError)} Saved fields are shown below.</p>` : ""}<div class="ecosystem-reading" aria-label="Record content">${readableFields(record.data, this.detailLimit)}</div><details id="ecosystem-raw-fields" class="ecosystem-raw-fields" ${this.rawFieldsOpen ? "open" : ""}><summary>All fields</summary><pre aria-label="Record fields">${esc(data.slice(0, this.detailLimit))}</pre></details>${clipped ? `<p class="help">Showing ${this.detailLimit.toLocaleString()} of ${data.length.toLocaleString()} characters in All fields.</p>${control("more-fields", "Show remaining fields", this.detailLoading)}` : ""}`;
  }

  private bind() {
    const connectionAccess = this.host!.querySelector<HTMLSelectElement>(
      "#ecosystem-connection-access",
    );
    if (connectionAccess)
      connectionAccess.onchange = () => {
        this.connectionAccess =
          connectionAccess.value === "write" ? "write" : "read";
      };
    const raw = this.host!.querySelector<HTMLDetailsElement>(
      "#ecosystem-raw-fields",
    );
    if (raw)
      raw.ontoggle = () => {
        if (raw.isConnected) this.rawFieldsOpen = raw.open;
      };
    const detail = this.host!.querySelector<HTMLElement>("#ecosystem-detail");
    if (detail)
      detail.onkeydown = (event) => {
        if (event.key !== "Escape" || this.selected === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        const index = this.selected;
        this.selected = undefined;
        ++this.detailGeneration;
        this.detailLoading = false;
        this.render();
        this.host
          ?.querySelector<HTMLElement>(`#ecosystem-record-${index}`)
          ?.focus();
        if (this.noticePending) this.changed();
      };
    this.host!.querySelectorAll<HTMLButtonElement>(
      "[data-ecosystem-action]",
    ).forEach(
      (button) =>
        (button.onclick = () => {
          const action = button.dataset.ecosystemAction!;
          if (action === "refresh" || action === "refresh-data") {
            this.polls = 0;
            void this.refresh();
          } else if (action === "previous" || action === "next") {
            if (action === "previous" && this.offsets.length > 1)
              this.offsets.pop();
            else if (action === "next" && this.nextOffset !== undefined)
              this.offsets.push(this.nextOffset);
            else return;
            void this.loadPage();
          } else if (action === "more-fields") {
            this.detailLimit = Number.MAX_SAFE_INTEGER;
            this.rawFieldsOpen = true;
            this.render();
            this.host
              ?.querySelector<HTMLElement>("#ecosystem-detail-title")
              ?.focus({ preventScroll: true });
          } else if (action === "close-detail") {
            const index = this.selected;
            this.selected = undefined;
            ++this.detailGeneration;
            this.detailLoading = false;
            this.render();
            this.host
              ?.querySelector<HTMLElement>(`#ecosystem-record-${index}`)
              ?.focus();
            if (this.noticePending) this.changed();
          } else void this.mutate(action);
        }),
    );
    this.host!.querySelectorAll<HTMLButtonElement>(
      "[data-ecosystem-record]",
    ).forEach(
      (button) =>
        (button.onclick = () => {
          void this.loadDetail(Number(button.dataset.ecosystemRecord));
        }),
    );
    const query =
      this.host!.querySelector<HTMLInputElement>("#ecosystem-query");
    if (query)
      query.oninput = () => {
        this.query = query.value.slice(0, 200);
      };
    this.host!.querySelector<HTMLFormElement>(
      "#ecosystem-filter",
    )?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.loading || this.busy) return;
      this.offsets = [0];
      void this.loadPage();
    });
    const collection = this.host!.querySelector<HTMLSelectElement>(
      "#ecosystem-collection",
    );
    if (collection)
      collection.onchange = () => {
        this.collection = collection.value;
        this.offsets = [0];
        void this.loadPage();
      };
    for (const label of ["read", "write"]) {
      const input = this.host!.querySelector<HTMLInputElement>(
        "#ecosystem-agent-" + label,
      );
      if (input)
        input.onchange = () => {
          if (!this.plugin || this.busy) return;
          const access = {
            agentRead:
              label === "read"
                ? input.checked
                : input.checked || this.plugin.agentRead,
            agentWrite:
              label === "write"
                ? input.checked
                : input.checked && this.plugin.agentWrite,
          };
          // Render only the last acknowledged grants until the scoped request succeeds.
          void this.mutate("permissions", access);
        };
    }
  }
}

export interface CompanyOsSettingsStatus {
  enabled: boolean;
  configuredEnabled?: boolean;
  available?: boolean;
  message?: string;
  autoUpdate: boolean;
  version: string;
  revision: string;
  sha256: string;
  integrity: string;
  package: string;
  runtime: string;
  schedulingEnabled: boolean;
  rollbackAvailable: boolean;
  latest: {
    state: string;
    version?: string;
    checkedAt?: number;
    message?: string;
  };
}

/** Framework settings are separate from the Company OS account connection. */
export class CompanyOsSettingsView {
  private host?: HTMLElement;
  private profile = "";
  private status?: CompanyOsSettingsStatus;
  private busy = "";
  private error = "";
  private generation = 0;
  private detailsOpen = false;
  constructor(private rpc: Rpc) {}

  mount(host?: HTMLElement, profile?: string) {
    this.detailsOpen =
      this.host?.querySelector<HTMLDetailsElement>("details")?.open ??
      this.detailsOpen;
    this.host = host;
    if (!host) {
      if (this.profile) {
        ++this.generation;
        this.profile = "";
        this.status = undefined;
        this.busy = "";
      }
      return;
    }
    if (profile && profile !== this.profile) {
      ++this.generation;
      this.profile = profile;
      this.status = undefined;
      this.error = "";
      void this.load();
    } else this.render();
  }

  private async load() {
    const generation = ++this.generation;
    this.busy = "load";
    this.error = "";
    this.render();
    try {
      const status = await this.rpc("companyos.status", {
        profile: this.profile,
      });
      if (generation !== this.generation) return;
      if (
        !status ||
        typeof status.enabled !== "boolean" ||
        typeof status.version !== "string"
      ) {
        this.error = status?.reason || "Company OS settings are unavailable.";
        return;
      }
      this.status = status;
    } catch (error) {
      if (generation === this.generation)
        this.error =
          error instanceof Error
            ? error.message
            : "Could not load framework settings.";
    } finally {
      if (generation === this.generation) {
        this.busy = "";
        this.render();
      }
    }
  }

  private async change(action: string, value?: boolean) {
    if (this.busy || !this.status) return;
    const generation = ++this.generation,
      profile = this.profile,
      status = this.status;
    this.busy = action;
    this.error = "";
    this.render();
    try {
      if (action === "enabled" || action === "autoUpdate")
        await this.rpc("companyos.configure", { profile, [action]: value });
      else if (action === "rollback")
        await this.rpc("companyos.rollback", {
          profile,
          expectedActiveSha: status.sha256,
        });
      else
        await this.rpc("companyos.check", {
          profile,
          apply: action === "apply",
        });
      if (generation === this.generation) await this.load();
    } catch (error) {
      if (generation === this.generation)
        this.error =
          error instanceof Error
            ? error.message
            : "Could not update framework settings.";
    } finally {
      if (generation === this.generation) {
        this.busy = "";
        this.render();
      }
    }
  }

  private render() {
    if (!this.host) return;
    const saved = captureFocus(this.host),
      detailsOpen =
        this.host.querySelector<HTMLDetailsElement>("details")?.open ??
        this.detailsOpen;
    const status = this.status,
      busy = !!this.busy;
    const latest = status?.latest ?? { state: "not_checked" };
    const updateLabel: Record<string, string> = {
      not_checked: "Updates have not been checked",
      current: "Latest compatible version installed",
      available: `Version ${latest.version ?? ""} is available`,
      updated: "Framework updated",
      incompatible: "A newer version needs a compatible Hades release",
      cancelled: "Update check cancelled",
      error: "Update check failed",
    };
    this.host.innerHTML = `<section class="settings-section company-os-settings" aria-labelledby="company-os-settings-title"><h3 id="company-os-settings-title">Company OS</h3><p class="help">Use the Company OS framework in this agent profile. Connect a Company OS account separately from Plugins.</p>${this.error ? `<p class="ecosystem-notice" role="alert">${esc(this.error)}</p>` : ""}${status?.available === false ? `<p class="ecosystem-notice" role="alert">Company OS is paused. ${esc(status.message || "The framework could not be verified. Restore a verified version or reinstall Hades.")}</p>` : ""}${!status ? `<p class="help" role="status">${busy ? "Loading framework settings…" : "Framework settings unavailable."}</p><button id="company-os-retry" type="button" ${busy ? "disabled" : ""}>Refresh framework settings</button>` : `<div class="company-os-controls"><label class="ecosystem-toggle"><input id="company-os-enabled" type="checkbox" role="switch" ${(status.configuredEnabled ?? status.enabled) ? "checked" : ""} ${busy ? "disabled" : ""}><span><strong>Enable Company OS</strong><small>Use /company-os instructions with Hades’ existing permissions and approvals.</small></span></label><label class="ecosystem-toggle"><input id="company-os-auto-update" type="checkbox" role="switch" ${status.autoUpdate ? "checked" : ""} ${busy ? "disabled" : ""}><span><strong>Automatically install updates</strong><small>Install compatible, verified releases when updates are checked.</small></span></label></div><p class="help">These switches save immediately.</p><div class="company-os-version"><strong>Version ${esc(status.version)}</strong><span>${status.integrity === "verified" ? "Content verified" : "Integrity not verified"}</span></div><p class="help">${status.runtime === "instructions-only" ? "Framework instructions are available locally." : status.runtime === "unavailable" ? "Framework instructions are unavailable." : esc(status.runtime)} ${status.schedulingEnabled ? "Framework scheduling is enabled." : "Framework scheduling is off."}</p><p class="help" role="status">${esc(updateLabel[latest.state] ?? latest.state)}${latest.checkedAt ? ` · Checked ${esc(dateLabel(latest.checkedAt))}` : ""}${latest.message ? ` · ${esc(latest.message)}` : ""}</p><div class="ecosystem-actions"><button id="company-os-refresh" type="button" ${busy ? "disabled" : ""}>Refresh status</button><button id="company-os-check" type="button" ${busy ? "disabled" : ""}>${this.busy === "check" ? "Checking…" : status.autoUpdate ? "Check and update" : "Check for updates"}</button>${latest.state === "available" ? `<button id="company-os-apply" type="button" ${busy ? "disabled" : ""}>${this.busy === "apply" ? "Updating…" : "Install update"}</button>` : ""}${status.rollbackAvailable ? `<button id="company-os-rollback" type="button" ${busy ? "disabled" : ""}>Restore previous version</button>` : ""}</div><details ${detailsOpen ? "open" : ""}><summary id="company-os-version-details">Version details</summary><dl><dt>Package</dt><dd>${esc(status.package)}</dd><dt>Revision</dt><dd>${esc(status.revision)}</dd><dt>Content digest</dt><dd>${esc(status.sha256)}</dd></dl><p class="help">Framework version changes apply across Hades profiles.</p></details>`}</section>`;
    const retry = this.host.querySelector<HTMLButtonElement>(
      "#company-os-retry, #company-os-refresh",
    );
    if (retry)
      retry.onclick = () => {
        void this.load();
      };
    for (const [id, action] of [
      ["company-os-enabled", "enabled"],
      ["company-os-auto-update", "autoUpdate"],
    ]) {
      const input = this.host.querySelector<HTMLInputElement>("#" + id);
      if (input)
        input.onchange = () => {
          void this.change(action, input.checked);
        };
    }
    for (const action of ["check", "apply", "rollback"]) {
      const button = this.host.querySelector<HTMLButtonElement>(
        "#company-os-" + action,
      );
      if (button)
        button.onclick = () => {
          void this.change(action);
        };
    }
    restoreFocus(this.host, saved);
  }
}
