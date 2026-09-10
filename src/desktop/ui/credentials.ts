import { captureFocus, restoreFocus } from "./focus";
type Row = Record<string, any>;
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export class CredentialsView {
  private host?: HTMLElement;
  private profile = "";
  private rows: Row[] = [];
  private adding = false;
  private busy = false;
  private error = "";
  private draft = { provider: "openrouter", label: "", key: "" };
  private generation = 0;
  constructor(private rpc: (method: string, args?: Row) => Promise<any>, private keychain: (account: string, value: string) => Promise<unknown>) {}
  async open(profile: string) {
    if (profile !== this.profile) { this.profile = profile; this.rows = []; this.adding = false; this.draft = { provider: "openrouter", label: "", key: "" }; }
    await this.refresh();
  }
  mount(host: HTMLElement) { this.host = host; this.render(); }
  async refresh() { const generation = ++this.generation; const rows = await this.rpc("credential.list", { profile: this.profile }); if (generation === this.generation) { this.rows = rows; this.render(); } }
  private render() {
    if (!this.host) return;
    const focus = captureFocus(this.host);
    this.host.innerHTML = `<div class="page"><h1>Credentials</h1><p class="help">API keys stay in macOS Keychain. Codex uses its separate subscription sign-in.</p><p class="help">Enabled keys rotate after a provider rejects a key or reports a rate limit. Interrupted responses are never retried with another key. When no pooled keys are enabled, Hades uses the key in Settings.</p>${this.error ? `<p role="alert" class="inline-notice">${esc(this.error)}</p>` : ""}<div class="page-actions"><button data-credential="add">Add key</button><button data-credential="refresh">Refresh</button></div>${this.adding ? `<form><label class="field">Provider<select name="provider">${["openrouter", "openai", "anthropic"].map(p => `<option value="${p}" ${p === this.draft.provider ? "selected" : ""}>${p === "openrouter" ? "OpenRouter" : p === "openai" ? "OpenAI" : "Anthropic"}</option>`).join("")}</select></label><label class="field">Label<input name="label" maxlength="80" required value="${esc(this.draft.label)}" placeholder="Primary key"></label><label class="field">API key<input name="key" type="password" autocomplete="off" required value="${esc(this.draft.key)}"></label><div class="page-actions"><button type="submit" ${this.busy ? "disabled" : ""}>Save in Keychain</button><button type="button" data-credential="cancel">Cancel</button></div></form>` : ""}${this.rows.map(row => `<div class="record"><div><h3>${esc(row.label)}</h3><p>${esc(row.provider)} · ${esc(row.masked ?? "No key saved")} · ${esc(({ ready: "Ready", disabled: "Disabled", missing: "Missing key", rejected: "Needs attention", cooling_down: "Waiting for rate limit" } as Row)[row.status])}</p>${row.error ? `<p class="help">${esc(row.error)}</p>` : ""}</div><button data-credential="toggle" data-id="${esc(row.id)}">${row.enabled && row.status !== "rejected" ? "Disable" : row.status === "rejected" ? "Try again" : "Enable"}</button><button data-credential="remove" data-id="${esc(row.id)}">Remove</button></div>`).join("") || '<p class="help">No pooled keys for this agent. A single key saved in Settings continues to work.</p>'}</div>`;
    this.host.querySelectorAll<HTMLButtonElement>("button").forEach((el, index) => { el.id = "credential-action-" + (el.dataset.credential || "save") + (el.dataset.id || index); el.disabled = this.busy; });
    this.host.querySelectorAll<HTMLElement>("[data-credential]").forEach(el => el.onclick = () => { void this.action(el.dataset.credential!, el.dataset.id).catch(error => { this.error = error instanceof Error ? error.message : "Could not update credentials"; this.render(); }); });
    this.host.querySelectorAll<HTMLInputElement | HTMLSelectElement>("form input, form select").forEach(el => { el.id = "credential-field-" + el.name; el.oninput = () => { this.draft[el.name as keyof typeof this.draft] = el.value; }; el.onchange = el.oninput; });
    this.host.querySelector("form")?.addEventListener("submit", event => { event.preventDefault(); void this.save(); });
    restoreFocus(this.host, focus);
  }
  private async save() {
    if (this.busy) return;
    const profile = this.profile, draft = { ...this.draft };
    if (!draft.key.trim() || !draft.label.trim()) { this.error = "Enter a label and API key"; this.render(); return; }
    this.busy = true; this.error = ""; this.render();
    let entry: Row | undefined;
    try {
      entry = await this.rpc("credential.add", { profile, provider: draft.provider, label: draft.label });
      await this.keychain(entry!.account, draft.key.trim());
      await this.rpc("credential.update", { id: entry!.id, profile, enabled: true });
      if (profile === this.profile) this.adding = false;
    } catch (error) { this.error = error instanceof Error ? error.message : "Could not save the key"; }
    finally { this.draft.key = ""; draft.key = ""; this.busy = false; await this.refresh().catch(() => this.render()); }
  }
  private async action(action: string, id?: string) {
    if (this.busy) return;
    this.error = "";
    if (action === "add") { this.adding = true; this.render(); return; }
    if (action === "cancel") { this.adding = false; this.draft.key = ""; this.render(); return; }
    const row = this.rows.find(item => item.id === id), profile = this.profile;
    this.busy = true; this.render();
    try {
    if (row && action === "remove") { await this.keychain(row.account, ""); await this.rpc("credential.remove", { id, profile }); }
    if (row && action === "toggle") await this.rpc("credential.update", { id, profile, enabled: row.status === "rejected" || !row.enabled });
    await this.refresh();
    } finally { this.busy = false; this.render(); }
  }
}
