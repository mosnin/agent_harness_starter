import { captureFocus, restoreFocus } from "./focus";
type Row = Record<string, any>;
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const button = (label: string, action: string, id = "") => `<button type="button" data-hook="${action}" data-id="${esc(id)}">${label}</button>`;
type Context = { profile: string; root: string; projects: string[] };
export class ShellHooksView {
  private host?: HTMLElement; private context?: Context; private rows: Row[] = []; private draft?: Row; private review?: string; private error = ""; private busy = false; private generation = 0;
  constructor(private rpc: (method: string, args?: Row) => Promise<any>) {}
  mount(host: HTMLElement) { this.host = host; this.render(); }
  async open(context: Context) { if (this.context?.profile !== context.profile) { this.rows = []; this.draft = undefined; this.review = undefined; this.error = ""; } this.context = context; await this.refresh(); }
  async refresh() { if (!this.context) return; const generation = ++this.generation; try { const rows = await this.rpc("hook.list", { profile: this.context.profile }); if (generation === this.generation) { this.rows = rows; this.render(); } } catch (e) { if (generation === this.generation) this.fail(e); } }
  private fail(e: unknown) { this.error = e instanceof Error ? e.message : String(e); this.render(); }
  private render() {
    if (!this.host || !this.context) return; const focus = captureFocus(this.host), d = this.draft;
    this.host.innerHTML = `<div class="page"><div class="page-heading"><h1>Hooks</h1><p>Run a script before or after an approved tool call.</p></div>${this.error ? `<p role="alert" class="inline-notice">${esc(this.error)}</p>` : ""}<p class="help">Hooks run on this Mac with your user’s file access. Add scripts you trust. Tool input arrives on standard input; credentials and your shell environment are not inherited. Changing a script or its settings requires approval again.</p>${d ? `<form><h2>${d.id ? "Edit hook" : "New hook"}</h2><label class="field">Name<input name="name" required maxlength="100" value="${esc(d.name)}"></label><label class="field">Project<select name="root" required>${this.context.projects.map(root => `<option value="${esc(root)}" ${root === d.root ? "selected" : ""}>${esc(root)}</option>`).join("")}</select></label><label class="field">When<select name="phase"><option value="pre_tool" ${d.phase === "pre_tool" ? "selected" : ""}>Before an approved tool runs</option><option value="post_tool" ${d.phase === "post_tool" ? "selected" : ""}>After a tool finishes</option></select></label><label class="field">Executable script<input name="executable" required placeholder="/absolute/path/check.sh" value="${esc(d.executable)}"></label><p class="help">Use the executable script itself, with a shebang. Scripts and any dependencies they load are your responsibility.</p><label class="field">Arguments · one per line<textarea name="arguments" rows="2">${esc(d.arguments)}</textarea></label><label class="field">Tool name · optional<input name="matcher" placeholder="file_ops" value="${esc(d.matcher)}"></label><label class="field">Timeout in seconds<input name="timeoutSeconds" type="number" required min="1" max="30" value="${d.timeoutSeconds}"></label><div class="page-actions"><button type="submit" class="primary-button">Save for review</button>${button("Cancel", "cancel")}</div></form>` : `<div class="page-actions">${button("New hook", "new")}${button("Refresh", "refresh")}</div>${this.rows.map(row => `<section class="record"><div><h3>${esc(row.name)}</h3><p class="help">${row.status === "active" ? "Active" : row.status === "needs_review" ? "Needs review" : "Inactive"} · ${row.phase === "pre_tool" ? "Before tool" : "After tool"} · ${esc(row.matcher || "All tools")} · ${row.timeoutSeconds}s</p><p>${esc(row.executable)}</p><p class="help">Project: ${esc(row.root)}</p>${row.args?.length ? `<p class="help">Arguments: ${row.args.map(esc).join(" · ")}</p>` : ""}${row.error ? `<p role="alert">${esc(row.error)}</p>` : ""}${this.review === row.id ? `<div class="inline-notice"><label><input type="checkbox" data-consent-check> I trust this script and the files or programs it loads to run with my user access.</label><div class="page-actions"><button type="button" data-hook="approve" data-id="${row.id}" disabled>Approve this hook</button>${button("Cancel", "cancel-review")}</div></div>` : ""}</div><div class="row-actions">${row.status === "active" ? button("Disable", "disable", row.id) : button("Review", "review", row.id)}${button("Edit", "edit", row.id)}${button("Remove", "remove", row.id)}</div></section>`).join("") || '<p class="help">No hooks for this agent.</p>'}`}</div>`;
    this.host.querySelectorAll<HTMLButtonElement>("button").forEach(el => { el.id = "hook-action-" + (el.dataset.hook || "save") + (el.dataset.id || ""); if (this.busy) el.disabled = true; });
    this.host.querySelector<HTMLInputElement>("[data-consent-check]")?.addEventListener("change", event => { const approve = this.host!.querySelector<HTMLButtonElement>('[data-hook="approve"]'); if (approve) approve.disabled = this.busy || !(event.target as HTMLInputElement).checked; });
    this.host.querySelectorAll<HTMLElement>("[data-hook]").forEach(el => el.onclick = () => { void this.action(el.dataset.hook!, el.dataset.id).catch(e => this.fail(e)); });
    this.host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("form input, form select, form textarea").forEach(el => { el.id = "hook-field-" + el.name; const update = () => { if (this.draft) this.draft[el.name] = el.name === "timeoutSeconds" ? Number(el.value) : el.value; }; el.oninput = update; el.onchange = update; });
    this.host.querySelector("form")?.addEventListener("submit", e => { e.preventDefault(); void this.action("save").catch(error => this.fail(error)); }); restoreFocus(this.host, focus);
  }
  private async action(action: string, id?: string) {
    if (this.busy || !this.context) return; const profile = this.context.profile; this.error = "";
    if (action === "new") this.draft = { name: "", root: this.context.root || this.context.projects[0], phase: "pre_tool", executable: "", arguments: "", matcher: "", timeoutSeconds: 10 };
    else if (action === "edit") { const row = this.rows.find(r => r.id === id)!; this.draft = { ...row, arguments: row.args.join("\n") }; }
    else if (action === "cancel") this.draft = undefined;
    else if (action === "review") this.review = id;
    else if (action === "cancel-review") this.review = undefined;
    else {
      this.busy = true;
      try {
        if (action === "save") { const d = this.draft!; await this.rpc("hook.save", { ...d, args: d.arguments ? d.arguments.split("\n") : [], profile }); if (this.context.profile === profile) this.draft = undefined; }
        else if (action === "approve" || action === "disable") { if (action === "approve" && !this.host?.querySelector<HTMLInputElement>("[data-consent-check]")?.checked) return; await this.rpc("hook.consent", { id, profile, approved: action === "approve" }); if (this.context.profile === profile) this.review = undefined; }
        else if (action === "remove") await this.rpc("hook.remove", { id, profile });
        if (this.context.profile === profile) await this.refresh();
      } finally { this.busy = false; }
    }
    this.render();
  }
}
