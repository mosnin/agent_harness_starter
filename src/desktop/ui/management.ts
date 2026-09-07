import { captureFocus, restoreFocus } from "./focus";
/** Native workbench management screens, backed only by supervised sidecar RPC. */
type Row = Record<string, any>;
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const date = (at: number) => new Date(at).toLocaleString();
const bytes = (n: number | null) => n === null ? "Unavailable" : `${(n / 1024 ** 3).toFixed(1)} GB`;
const action = (label: string, name: string, attrs = "") => `<button type="button" data-manage="${name}" ${attrs}>${label}</button>`;
const options = (values: string[], current: string) => values.map(value => `<option value="${value}" ${current === value ? "selected" : ""}>${value[0].toUpperCase() + value.slice(1)}</option>`).join("");
export const managementViews = new Set(["sessions", "system", "activity", "mcp", "computer"]);
export class ManagementView {
  private host?: HTMLElement;
  private scope = "";
  private project = "";
  private name = "";
  private view = "";
  private data: any;
  private error = "";
  private busy = false;
  private request = 0;
  private query = "";
  private state = "all";
  private source = "all";
  private offset = 0;
  private errors = false;
  private before?: number;
  private cursors: Array<number | undefined> = [];
  private edit?: Row;
  private tools?: { name: string; rows: Row[] };
  constructor(private rpc: (method: string, args?: Row) => Promise<any>, private openSession: (id: string) => void,
    private navigate: (view: string) => void, private download: (name: string, value: unknown) => void) {}
  async open(view: string, profile: string, name: string, project: string) {
    if (this.view !== view || this.scope !== profile) {
      this.data = undefined; this.error = ""; this.edit = undefined; this.tools = undefined;
      this.offset = 0; this.before = undefined; this.cursors = [];
    }
    this.view = view; this.scope = profile; this.name = name; this.project = project;
    await this.load();
  }
  private async load() {
    const request = ++this.request;
    this.busy = true; this.error = ""; this.paint();
    try {
      const result = await this.rpc(({ sessions: "sessions.list", system: "system.status", activity: "activity.list", mcp: "mcp.list", computer: "computer.status" } as Row)[this.view],
        { profile: this.scope, query: this.query, state: this.state, source: this.source, offset: this.offset, before: this.before, errors: this.errors });
      if (request === this.request) this.data = result;
    } catch (e) { if (request === this.request) this.error = e instanceof Error ? e.message : String(e); }
    finally { if (request === this.request) { this.busy = false; this.paint(); } }
  }
  html() { return '<div id="management-host" class="page management-page"></div>'; }
  bind(host: HTMLElement) { this.host = host; this.paint(); }
  private paint() {
    if (!this.host?.isConnected) return;
    const focus = captureFocus(this.host);
    const title = ({ sessions: "Conversations", system: "System", activity: "Activity", mcp: "MCP servers", computer: "Computer control" } as Row)[this.view];
    this.host.innerHTML = `<div class="page-heading management-heading"><div><h1>${title ?? "Loading"}</h1><p>${this.view === "computer" ? "Access on this Mac" : escape(this.name) + " · Agent profile"}</p></div>${action(this.busy ? "Refreshing…" : "Refresh", "refresh", this.busy ? "disabled" : "")}</div>${this.error ? `<p class="inline-notice" role="alert">${escape(this.error)}</p>` : ""}${this.content()}`;
    restoreFocus(this.host, focus);
    this.host.querySelectorAll<HTMLElement>("[data-manage]").forEach(el => el.onclick = () => { void this.act(el.dataset.manage!, el).catch(error => { this.error = String(error instanceof Error ? error.message : error); this.paint(); }); });
    this.host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select").forEach(input => input.addEventListener("input", () => {
      if (input.id === "history-query") this.query = input.value;
      if (input.id === "history-state") this.state = input.value;
      if (input.id === "history-source") this.source = input.value;
      if (!this.edit) return;
      if (input.id === "session-title") this.edit.title = input.value;
      if (input.id === "mcp-name") this.edit.name = input.value;
      if (input.id === "mcp-command") this.edit.command = input.value;
      if (input.id === "mcp-args") this.edit.args = input.value.split("\n");
      if (input.id === "mcp-enabled") this.edit.enabled = (input as HTMLInputElement).checked;
    }));
    this.host.querySelector<HTMLFormElement>("#conversation-filters")?.addEventListener("submit", e => {
      e.preventDefault(); this.query = this.value("history-query"); this.state = this.value("history-state"); this.source = this.value("history-source"); this.offset = 0; void this.load();
    });
  }
  private value(id: string) { return this.host?.querySelector<HTMLInputElement>(`#${id}`)?.value ?? ""; }
  private content(): string {
    const d = this.data;
    if (this.view === "sessions") {
      const stats = d?.stats;
      return `${stats ? `<div class="metric-strip">${[[stats.total,"Conversations"],[stats.running,"Working now"],[stats.archived,"Archived"],[stats.messages,"Messages"]].map(([n,label]) => `<div><strong>${Number(n).toLocaleString()}</strong><span>${label}</span></div>`).join("")}</div>` : ""}
        <form id="conversation-filters" class="management-filters"><label class="grow">Search messages<input id="history-query" type="search" placeholder="Search the full conversation" value="${escape(this.query)}"></label><label>Status<select id="history-state">${options(["all","current","running","archived"],this.state)}</select></label><label>Source<select id="history-source">${options(["all","desktop","routine","slack","team","unknown"],this.source)}</select></label><button type="submit">Search</button></form>
        <div class="management-list">${d?.rows?.map((s: Row) => `<article class="management-row"><div class="grow">${action(escape(s.title),"open",`data-id="${s.id}" class="row-title"`)}<p class="row-meta">${escape(s.source === "unknown" ? "Earlier conversation" : s.source)} · ${s.count} messages · ${escape(date(s.updatedAt))}${s.running ? " · Working" : s.archived ? " · Archived" : ""}</p>${s.snippet ? `<p class="session-excerpt">${escape(s.snippet)}</p>` : ""}</div><div class="row-actions">${action("Rename","rename",`data-id="${s.id}"`)}${action("Export","export",`data-id="${s.id}"`)}${action(s.archived ? "Restore" : "Archive","archive",`data-id="${s.id}" ${s.running ? "disabled" : ""}`)}</div></article>`).join("") || `<p class="management-empty">${this.busy ? "Loading conversations…" : "No conversations match these filters."}</p>`}</div>
        ${d ? `<div class="pagination"><span>${d.total ? `${d.offset + 1}–${Math.min(d.offset + 50,d.total)} of ${d.total}` : "0 conversations"}</span>${action("Previous","previous",this.offset === 0 ? "disabled" : "")}${action("Next","next",this.offset + 50 >= d.total ? "disabled" : "")}</div>` : ""}
        ${this.edit ? `<section class="management-editor"><h2>Rename conversation</h2><label class="field">Title<input id="session-title" value="${escape(this.edit.title)}" maxlength="160"></label><div class="page-actions">${action("Save title","save-title")}${action("Cancel","cancel")}</div></section>` : ""}`;
    }
    if (this.view === "computer") return `<section class="management-section"><h2>Let agents use this Mac</h2><p>When enabled, agents can inspect the foreground app and capture the selected display, including other visible windows. Clicks, typing, and other input actions ask for your approval. Screenshots are sent to the selected model and retained with the local conversation record.</p><p class="help">Use a model that supports images. This bridge requires macOS 14 or later. An action must refer to a recent observation; Hades checks the app and window before input. Prefer accessibility elements for precise actions.</p><div class="page-actions">${action(d?.enabled ? "Turn off computer access" : "Enable computer access", "computer-toggle", d?.enabled ? "" : 'class="primary-button"')}</div></section>
      <section class="management-section"><h2>macOS permissions</h2><dl class="system-facts"><div><dt>Accessibility</dt><dd>${d?.accessibility === true ? "Allowed" : d?.accessibility === false ? "Not granted" : "Unavailable"}</dd></div><div><dt>Screen Recording</dt><dd>${d?.screenRecording === true ? "Allowed" : d?.screenRecording === false ? "Not granted" : "Unavailable"}</dd></div></dl>${action("Request permissions…","computer-permissions")}<p class="help">macOS may ask you to enable Hades or its helper in System Settings. Restart Hades after granting Screen Recording, then refresh this page.</p></section>
      <section class="management-section"><h2>Stop at any time</h2><p class="help">Turn off access here or use Stop computer control in the toolbar. This cancels pending bridge requests and invalidates all observations. An input already sent to macOS cannot be undone by stopping.</p></section>`;
    if (this.view === "system") {
      if (!d?.at) return '<p class="management-empty">Reading this Mac…</p>';
      return `<section class="management-section"><h2>This Mac</h2><dl class="system-facts">${[["Operating system",`${d.os} ${d.release}`],["Architecture",d.arch],["CPU cores",d.cores],["Free physical memory",`${bytes(d.memoryFree)} of ${bytes(d.memoryTotal)}`],["Available disk space",`${bytes(d.diskAvailable)} of ${bytes(d.diskTotal)}`],["App uptime",d.processUptime < 60 ? "Less than a minute" : `${Math.floor(d.processUptime / 60)} ${d.processUptime < 120 ? "minute" : "minutes"}`]].map(([key,value]) => `<div><dt>${key}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl><p class="help">Updated ${escape(date(d.at))}. Free physical memory does not measure macOS memory pressure.</p></section>
      <section class="management-section"><h2>Agent activity</h2><div class="metric-strip">${[[d.active,"Working"],[d.routines,"Routines"],[d.mcp,"MCP servers"]].map(([n,label]) => `<div><strong>${n}</strong><span>${label}</span></div>`).join("")}</div><div class="page-actions">${action("Conversations","go-sessions")}${action("Routines","go-jobs")}${action("Activity history","go-activity")}${action("MCP servers","go-mcp")}</div></section>
      <section class="management-section"><h2>Recorded model usage</h2>${d.usage?.turns ? `<dl class="system-facts"><div><dt>Input tokens</dt><dd>${Number(d.usage.tokensIn).toLocaleString()}</dd></div><div><dt>Output tokens</dt><dd>${Number(d.usage.tokensOut).toLocaleString()}</dd></div><div><dt>Usage reports</dt><dd>${d.usage.turns}</dd></div></dl><p class="help">Recorded since ${escape(date(d.usage.since))}. Includes reported usage for unsuccessful turns. Earlier runs are not backfilled.</p>` : '<p class="help">No model usage recorded yet. New agent turns will appear here.</p>'}</section>`;
    }
    if (this.view === "activity") return `<div class="management-filters">${action(this.errors ? "Show all activity" : "Show errors only","errors")}<p class="help">Persisted run metadata. Open a conversation to inspect its content.</p></div><div class="management-list">${d?.map((e: Row) => `<article class="management-row"><div class="grow"><strong>${escape(({done:"Turn ended",usage:"Model usage recorded",error:"Agent reported an error",approval:"Approval requested",tool:e.status === "running" ? "Tool started" : e.status === "error" ? "Tool reported an error" : "Tool returned"} as Row)[e.kind])}</strong><p class="row-meta">${escape(date(e.at))}${e.tool ? ` · ${escape(e.tool)}` : ""}${e.kind === "usage" ? ` · ${Number(e.tokensIn).toLocaleString()} in / ${Number(e.tokensOut).toLocaleString()} out` : ""}</p></div>${action("Conversation","open",`data-id="${e.session}"`)}</article>`).join("") || '<p class="management-empty">No recorded activity for this agent.</p>'}</div><div class="pagination">${action("Newer","newer",!this.cursors.length ? "disabled" : "")}${action("Older","older",d?.length < 100 || !d ? "disabled" : "")}</div>`;
    if (this.view === "mcp") return `<p class="help">Local servers extend this agent’s tools. Enabled commands start on the next agent turn; tool calls require approval.</p><div class="page-actions">${action("Add server","add",'class="primary-button"')}${action("Extension bundles","go-plugins")}</div><div class="management-list">${d?.map((m: Row) => `<article class="management-row"><div class="grow"><strong>${escape(m.name)}</strong><p class="row-meta">${m.enabled ? "Enabled for next turn" : "Disabled"}</p><code>${escape(m.command)}</code></div><div class="row-actions">${action("Edit","edit",`data-id="${escape(m.name)}"`)}${action("Inspect tools","inspect",`data-id="${escape(m.name)}" ${!this.project || this.busy ? "disabled" : ""}`)}</div></article>`).join("") || '<p class="management-empty">No standalone MCP servers configured.</p>'}</div>${!this.project ? '<p class="help">Open a project before inspecting a server.</p>' : ''}
      ${this.edit ? `<section class="management-editor"><h2>${this.edit.original ? "Edit" : "Add"} MCP server</h2><label class="field">Name<input id="mcp-name" value="${escape(this.edit.name)}" placeholder="filesystem"></label><label class="field">Executable<input id="mcp-command" value="${escape(this.edit.command)}" placeholder="/path/to/server"></label><label class="field">Arguments · one per line<textarea id="mcp-args" rows="3">${escape(this.edit.args.join("\n"))}</textarea></label><label class="check-field"><input id="mcp-enabled" type="checkbox" ${this.edit.enabled ? "checked" : ""}> Enable for agent turns</label><p class="help">This command runs with your account’s access. Inspect tools starts the command, reads its tool catalog, and closes it.</p><div class="page-actions">${action("Save server","save-mcp")}${action("Cancel","cancel")}${this.edit.original ? action("Remove server","remove-mcp") : ""}</div></section>` : ''}
      ${this.tools ? `<section class="management-section"><h2>${escape(this.tools.name)} tools</h2><p class="help">Retrieved from the server just now. Descriptions are provided by the server.</p>${this.tools.rows.map(t => `<div class="tool-description"><strong>${escape(t.name)}</strong><p>${escape(t.description)}</p></div>`).join("") || '<p>No tools advertised.</p>'}</section>` : ''}`;
    return "";
  }
  private async act(name: string, el: HTMLElement) {
    if (name.startsWith("go-")) { this.navigate(name.slice(3)); return; }
    const id = el.dataset.id!;
    switch (name) {
      case "refresh": await this.load(); return;
      case "computer-toggle": await this.rpc("computer.configure", {enabled:!this.data?.enabled}); break;
      case "computer-permissions": await this.rpc("computer.permissions", {}); break;
      case "open": this.openSession(id); return;
      case "next": this.offset += 50; break;
      case "previous": this.offset = Math.max(0,this.offset - 50); break;
      case "errors": this.errors = !this.errors; this.before = undefined; this.cursors = []; break;
      case "older": this.cursors.push(this.before); this.before = this.data.at(-1).id; break;
      case "newer": this.before = this.cursors.pop(); break;
      case "export": this.download(`conversation-${id}.json`, await this.rpc("session.export", { id, profile: this.scope })); return;
      case "archive": await this.rpc("session.update", { id, profile: this.scope, archived: !this.data.rows.find((s: Row) => s.id === id).archived }); break;
      case "rename": this.edit = { ...this.data.rows.find((s: Row) => s.id === id) }; this.paint(); return;
      case "save-title": {
        const title = this.value("session-title").trim(); if (!title) throw new Error("Enter a conversation title.");
        await this.rpc("session.update", { id: this.edit!.id, profile: this.scope, title }); this.edit = undefined; break;
      }
      case "add": this.edit = { name:"", command:"", args:[], enabled:false }; this.paint(); return;
      case "edit": this.edit = { ...this.data.find((m: Row) => m.name === id), original: id }; this.paint(); return;
      case "cancel": this.edit = undefined; this.paint(); return;
      case "save-mcp":
        await this.rpc("mcp.save", { profile: this.scope, original: this.edit!.original, name:this.value("mcp-name"), command:this.value("mcp-command"), args:this.value("mcp-args").split("\n").filter(s => s.length), enabled:this.host!.querySelector<HTMLInputElement>("#mcp-enabled")!.checked }); this.edit = undefined; break;
      case "remove-mcp": await this.rpc("mcp.remove", { profile:this.scope, name:this.edit!.original }); this.edit = undefined; break;
      case "inspect": {
        const request = ++this.request;
        this.busy = true; this.paint();
        try {
          const rows = await this.rpc("mcp.inspect", { profile:this.scope, name:id, root:this.project });
          if (request === this.request) this.tools = { name:id, rows };
        } finally { if (request === this.request) { this.busy = false; this.paint(); } } return;
      }
    }
    await this.load();
  }
}
