import { icon } from "./icons";
type Row = Record<string, any>;
type Context = { profile: string; root: string; profiles: Array<{ id: string; name: string }>; projects: string[] };
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const button = (text: string, action: string, extra = "") => `<button type="button" data-webhook="${action}" ${extra}>${text}</button>`;

export class WebhooksView {
  private host?: HTMLElement;
  private context?: Context;
  private rows: Row[] = [];
  private status: Row = {};
  private draft?: Row;
  private token = "";
  private created?: Row;
  private history?: { id: string; rows: Row[] };
  private error = "";
  private notice = "";
  private busy = false;
  private generation = 0;
  constructor(private rpc: (method: string, args?: Row) => Promise<any>, private openSession: (id: string) => void) {}
  async open(context: Context) {
    if (this.context?.profile !== context.profile) { this.draft = undefined; this.history = undefined; this.token = ""; this.created = undefined; this.error = ""; this.notice = ""; this.rows = []; }
    this.context = context; await this.refresh();
  }
  mount(host: HTMLElement) { this.host = host; this.render(); }
  async refresh() {
    if (!this.context) return;
    const generation = ++this.generation, profile = this.context.profile;
    try {
      this.status = await this.rpc("webhook.status");
      const [rows, events] = await Promise.all([this.rpc("webhook.list", { profile }), this.history ? this.rpc("webhook.events", { id: this.history.id, profile }) : Promise.resolve(undefined)]);
      if (generation !== this.generation) return;
      this.rows = rows; if (this.history && events) this.history.rows = events; this.render();
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }
  private fail(error: unknown) { this.error = error instanceof Error ? error.message : String(error); this.render(); }
  private render() {
    if (!this.host || !this.context) return;
    const active = this.host.contains(document.activeElement) ? document.activeElement as HTMLInputElement : undefined;
    const focus = active?.name ? { name: active.name, start: active.selectionStart, end: active.selectionEnd } : undefined;
    const draft = this.draft;
    this.host.innerHTML = `<div class="page webhook-page"><div class="page-heading"><h1>Webhooks</h1><p>Let trusted local services wake an agent when an event arrives.</p></div>
      ${this.error ? `<p class="inline-notice" role="alert">${esc(this.error)}</p>` : ""}${this.notice ? `<p role="status">${esc(this.notice)}</p>` : ""}
      <p class="help">${this.status.running ? "Listening on this Mac" : "Listener unavailable"}${this.status.baseUrl ? " · " + esc(this.status.baseUrl) : ""}. Each event uses the agent’s normal tool approvals.</p>${this.status.error ? `<p class="inline-notice">${esc(this.status.error)}</p>` : ""}
      ${this.token ? `<section class="webhook-secret"><h2>Save your access token</h2><p>This token is shown once. Send it as a Bearer token in the Authorization header; keep it out of URLs.</p><label class="field">Access token<input name="issuedToken" type="password" readonly value="${esc(this.token)}" autocomplete="off"></label><div class="page-actions">${button("Copy token", "copy-token")}${button("I saved it", "dismiss-token")}</div><p class="help">Endpoint: ${esc(this.created?.url)}</p></section>` : ""}
      ${draft ? `<form><h2>${draft.id ? "Edit subscription" : "New subscription"}</h2><label class="field">Name<input name="name" required maxlength="160" value="${esc(draft.name)}"></label><label class="field">Agent<select name="profile" ${draft.id ? "disabled" : ""}>${this.context.profiles.map(p => `<option value="${esc(p.id)}" ${draft.profile === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label><label class="field">Project<select name="root" required>${this.context.projects.map(project => `<option value="${esc(project)}" ${draft.root === project ? "selected" : ""}>${esc(project)}</option>`).join("")}</select></label><label class="field">Saved task instructions<textarea name="prompt" rows="4" required maxlength="16000">${esc(draft.prompt)}</textarea></label><label class="field">Accepted event names<textarea name="events" rows="2" required placeholder="build.finished&#10;report.requested">${esc(draft.events.join("\n"))}</textarea></label><p class="help">One event name per line. Incoming JSON must include a unique id, an accepted event name, and payload data. Repeated IDs are deduplicated; conflicting payloads are rejected.</p><div class="page-actions"><button type="submit" class="primary-button" ${this.busy || !this.context.projects.length ? "disabled" : ""}>${this.busy ? "Saving…" : "Save subscription"}</button>${button("Cancel", "cancel")}</div></form>` : `<div class="page-actions">${button(icon("+") + "New subscription", "new", `class="primary-button" ${this.busy || this.token || this.rows.length >= 10 ? "disabled" : ""}`)}${button("Refresh status", "refresh")}</div><div>${this.rows.length ? this.rows.map(item => `<section class="record"><div><h3>${esc(item.name)}</h3><p class="help">${item.enabled ? "Enabled" : "Disabled"} · ${esc(item.events.join(", "))}</p><p class="webhook-url">${esc(item.url)}</p></div><div class="row-actions">${button("Copy endpoint", "copy", `data-id="${item.id}"`)}${button("Edit", "edit", `data-id="${item.id}"`)}${button(item.enabled ? "Disable" : "Enable", "toggle", `data-id="${item.id}"`)}${button("Events", "events", `data-id="${item.id}"`)}${button("Remove", "remove", `data-id="${item.id}"`)}</div></section>`).join("") : '<p class="help">No subscriptions for this agent. Add one to start receiving events.</p>'}</div>`}
      ${this.history ? `<section><h2>Recent events</h2><p class="help">${esc(this.rows.find(item => item.id === this.history!.id)?.name)} · Interrupted events are retained and never replayed automatically.</p>${this.history.rows.map(event => `<div class="record"><div><strong>${esc(event.event)}</strong><p class="help">${esc(event.eventId)} · ${esc(event.status)} · ${new Date(event.at).toLocaleString()}</p>${event.error ? `<p>${esc(event.error)}</p>` : ""}</div>${event.session ? button("Conversation", "session", `data-session="${esc(event.session)}"`) : ""}</div>`).join("") || '<p class="help">No events received yet.</p>'}</section>` : ""}</div>`;
    this.host.querySelectorAll<HTMLElement>("[data-webhook]").forEach(el => el.onclick = () => { void this.action(el.dataset.webhook!, el.dataset.id, el.dataset.session).catch(error => this.fail(error)); });
    this.host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("form input, form textarea, form select").forEach(el => { const update = () => { if (this.draft) this.draft[el.name] = el.name === "events" ? el.value.split("\n") : el.value; }; el.oninput = update; el.onchange = update; });
    this.host.querySelector("form")?.addEventListener("submit", event => { event.preventDefault(); void this.save().catch(error => this.fail(error)); });
    if (focus) { const next = [...this.host.querySelectorAll<HTMLInputElement>("input, textarea, select")].find(el => el.name === focus.name); next?.focus({ preventScroll: true }); if (next && ["text", "textarea", "password"].includes(next.type) && focus.start !== null && focus.end !== null) next.setSelectionRange(focus.start, focus.end); }
  }
  private async save() {
    if (!this.draft || this.busy) return;
    const draft = this.draft, scope = this.context!.profile;
    this.busy = true; this.error = ""; this.render();
    try {
      const args = { ...draft, events: draft.events.map((item: string) => item.trim()).filter(Boolean) };
      if (draft.id) await this.rpc("webhook.update", args);
      else {
        const result = await this.rpc("webhook.create", args);
        if (this.context?.profile === scope) { this.token = result.token; this.created = result.subscription; }
      }
      if (this.context?.profile === scope) { this.draft = undefined; this.notice = draft.profile !== scope ? "Subscription saved under the selected agent. Switch to that agent to manage it." : "Subscription saved."; await this.refresh(); }
    } finally { this.busy = false; this.render(); }
  }
  private async action(action: string, id?: string, session?: string) {
    const profile = this.context!.profile;
    this.error = ""; this.notice = "";
    const item = this.rows.find(row => row.id === id);
    if (action === "new") this.draft = { name: "", profile, root: this.context!.root || this.context!.projects[0] || "", prompt: "", events: ["task.requested"], enabled: true };
    else if (action === "cancel") this.draft = undefined;
    else if (action === "edit") this.draft = structuredClone(item);
    else if (action === "toggle") { await this.rpc("webhook.update", { id, profile, enabled: !item!.enabled }); await this.refresh(); }
    else if (action === "remove") { await this.rpc("webhook.remove", { id, profile }); if (this.history?.id === id) this.history = undefined; await this.refresh(); }
    else if (action === "events") this.history = { id: id!, rows: await this.rpc("webhook.events", { id, profile }) };
    else if (action === "copy") { await navigator.clipboard.writeText(item!.url); this.notice = "Endpoint copied."; }
    else if (action === "copy-token") { await navigator.clipboard.writeText(this.token); this.notice = "Token copied."; }
    else if (action === "dismiss-token") { this.token = ""; this.created = undefined; }
    else if (action === "session") this.openSession(session!);
    else if (action === "refresh") await this.refresh();
    this.render();
  }
}
