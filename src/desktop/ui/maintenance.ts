type Row = Record<string, any>;
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

/** Native workbench maintenance page. File/folder selection is injected by the
 * native shell; this view cannot browse arbitrary disk paths on its own. */
export class MaintenanceView {
  private host?: HTMLElement;
  private diagnostics: Row = {};
  private rows: Row[] = [];
  private path = "";
  private verified?: Row;
  private busy = false;
  private error = "";
  private notice = "";
  private generation = 0;
  constructor(private rpc: (method: string, args?: Row) => Promise<any>, private chooseFolder: () => Promise<string | undefined>, private chooseFile?: () => Promise<string | undefined>) {}
  mount(host: HTMLElement) { this.host = host; this.render(); }
  async open() { await this.refresh(); }
  async refresh() {
    const generation = ++this.generation;
    try {
      const [diagnostics, rows] = await Promise.all([this.rpc("maintenance.diagnostics"), this.rpc("maintenance.list")]);
      if (generation !== this.generation) return;
      this.diagnostics = diagnostics; this.rows = rows; this.render();
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }
  private fail(error: unknown) { this.error = error instanceof Error ? error.message : String(error); this.render(); }
  private render() {
    if (!this.host) return;
    this.host.innerHTML = `<div class="page maintenance-page"><div class="page-heading"><h1>Maintenance</h1><p>Keep a private backup and inspect local runtime health.</p></div>
      ${this.error ? `<p class="inline-notice" role="alert">${esc(this.error)}</p>` : ""}${this.notice ? `<p role="status">${esc(this.notice)}</p>` : ""}
      <section><h2>Backups</h2><p class="help">Backups contain private conversations, memory, settings and execution history. Provider credentials, auth homes and project files are excluded. Choose a private folder; active work must finish before a consistent backup can begin.</p>
      <div class="page-actions"><button type="button" data-maintenance="create" class="primary-button" ${this.busy ? "disabled" : ""}>Create backup…</button><button type="button" data-maintenance="refresh" ${this.busy ? "disabled" : ""}>Refresh</button></div>
      ${this.rows.length ? this.rows.map((row, index) => `<div class="record"><div><strong>${esc(new Date(row.createdAt).toLocaleString())}</strong><p class="help">${esc(size(row.bytes))} · ${esc(row.files)} files${row.exists ? "" : " · File moved or unavailable"}</p><p class="help">${esc(row.path)}</p></div><button type="button" data-maintenance="select" data-index="${index}" ${this.busy || !row.exists ? "disabled" : ""}>Verify</button></div>`).join("") : '<p class="help">No backups created by this installation yet.</p>'}</section>
      <section><h2>Review and import</h2><p class="help">Verify a backup before importing. Import creates a new isolated folder for review; it never replaces your current data. Routines, connections and computer control stay disabled in the staged copy.</p>
      <label class="field">Backup file<input name="backupPath" type="text" value="${esc(this.path)}" placeholder="/path/to/Hades-backup.hades-backup.json" ${this.busy ? "disabled" : ""}></label>
      <div class="page-actions">${this.chooseFile ? `<button type="button" data-maintenance="browse" ${this.busy ? "disabled" : ""}>Choose backup…</button>` : ""}<button type="button" data-maintenance="verify" ${this.busy || !this.path ? "disabled" : ""}>Verify backup</button><button type="button" data-maintenance="stage" ${this.busy || !this.verified || this.verified.path !== this.path ? "disabled" : ""}>Stage import…</button></div>
      ${this.verified ? `<p role="status">Verified ${esc(this.verified.files.length)} files · ${esc(size(this.verified.totalBytes))}</p><p class="help">${esc(this.verified.scope)}</p><details><summary>Included files</summary>${this.verified.files.map((file: Row) => `<p class="help">${esc(file.path)} · ${esc(size(file.bytes))}</p>`).join("")}</details>` : ""}</section>
      <section><h2>Local diagnostics</h2><p class="help">${esc(this.diagnostics.os)} ${esc(this.diagnostics.release)} · ${esc(this.diagnostics.arch)} · Node ${esc(this.diagnostics.node)}${this.diagnostics.disk ? " · " + esc(size(this.diagnostics.disk.freeBytes)) + " free" : ""}</p>
      ${(this.diagnostics.runtime ?? []).map((item: Row) => `<div class="record"><span>${esc(item.name)}</span><span>${item.exists ? "Present" : "Missing"}</span></div>`).join("")}
      ${(this.diagnostics.schemas ?? []).map((item: Row) => `<div class="record"><span>${esc(item.name)}</span><span>${item.integrity === "ok" ? "Integrity check passed" : esc(item.error ?? "Check failed")}</span></div>`).join("")}
      <p class="help">${esc(this.diagnostics.scope ?? "Local checks do not establish provider connectivity or a security audit verdict.")}</p><button type="button" data-maintenance="support" ${this.busy ? "disabled" : ""}>Export support report…</button><p class="help">Support reports include runtime and schema metadata. They omit conversations, memory, credentials and project paths.</p></section></div>`;
    const input = this.host.querySelector<HTMLInputElement>('input[name="backupPath"]');
    if (input) input.oninput = () => { this.path = input.value; this.verified = undefined; this.host?.querySelector<HTMLButtonElement>('[data-maintenance="verify"]')?.toggleAttribute("disabled", this.busy || !this.path); this.host?.querySelector<HTMLButtonElement>('[data-maintenance="stage"]')?.setAttribute("disabled", ""); };
    this.host.querySelectorAll<HTMLButtonElement>("[data-maintenance]").forEach(button => button.onclick = () => { void this.action(button.dataset.maintenance!, Number(button.dataset.index)).catch(error => this.fail(error)); });
  }
  private async action(action: string, index: number) {
    if (this.busy) return;
    if (action === "refresh") return this.refresh();
    if (action === "browse") { const path = await this.chooseFile?.(); if (path) { this.path = path; this.verified = undefined; this.render(); } return; }
    if (action === "select") { const row = this.rows[index]; if (!row) return; this.path = row.path; this.verified = undefined; action = "verify"; }
    this.busy = true; this.error = ""; this.notice = ""; this.render();
    try {
      if (action === "verify") this.verified = await this.rpc("maintenance.verify", { path: this.path });
      else if (action === "create" || action === "support") {
        const destination = await this.chooseFolder(); if (!destination) return;
        const result = await this.rpc(`maintenance.${action}`, { destination });
        this.notice = `${action === "create" ? "Private backup saved" : "Support report saved"}: ${result.path}`;
        if (action === "create") { this.path = result.path; this.verified = undefined; }
        await this.refresh();
      } else if (action === "stage" && this.verified?.path === this.path) {
        const destination = await this.chooseFolder(); if (!destination) return;
        const result = await this.rpc("maintenance.stage", { path: this.path, destination, expectedSha256: this.verified.sha256 });
        this.notice = `Imported into a new review folder: ${result.path}. Your current Hades data remains unchanged. Read IMPORT-REVIEW.json before using the staged data.`;
      }
    } finally { this.busy = false; this.render(); }
  }
}
