import { captureFocus, restoreFocus } from "./focus";
import type { HelmRun } from "../core/helm-types";
import "./helm-orca.css";
type Scope = { root: string; profile: string };
type Rpc = (method: string, args?: Record<string, unknown>) => Promise<any>;
type Input = { requestId: string; prompt: string; agent: string; model?: string };
type State = { records: any[]; selected?: string; prompt: string; agent: string; model: string; pending?: Input; output: string; truncated: boolean };
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const label = (s: string) => ({ starting: "Starting", ready: "Dispatch acknowledged", failed: "Failed", unknown: "Outcome unknown", stopping: "Stopping", stopped: "Stopped", needs_review: "Needs review" })[s] ?? "Outcome unknown";
const button = (text: string, action: string, disabled = false, id = "") => '<button type="button" data-orca="' + action + '" data-id="' + esc(id) + '" id="orca-action-' + action + '-' + esc(id) + '" ' + (disabled ? "disabled" : "") + '>' + text + '</button>';
export class HelmOrcaView {
  private host?: HTMLElement;
  private scope?: Scope;
  private key = "";
  private states = new Map<string, State>();
  private generation = 0;
  private busy = false;
  private stopping = false;
  private error = "";
  private info?: { state: string; message: string; sourceRevision: string };
  private timer?: ReturnType<typeof setTimeout>;
  private polling = false;
  private effectEpoch = 0;
  private pollDelay = 4000;
  private stopTimer() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private visibilityChanged = () => this.schedule();
  dispose() { document.removeEventListener("visibilitychange", this.visibilityChanged); this.stopTimer(); this.generation++; this.host = undefined; this.busy = false; }
  private visible() {
    if (!this.host?.isConnected || this.host.closest('[hidden], [aria-hidden="true"]') || document.visibilityState === "hidden") return false;
    for (let el: HTMLElement | null = this.host; el; el = el.parentElement) {
      const style = getComputedStyle(el); if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }
  private activeRecords() { return this.state.records.filter(r => ["starting","ready","stopping","unknown"].includes(r.state)); }
  private schedule() {
    this.stopTimer();
    if (!this.visible() || !this.scope || !this.activeRecords().length) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.poll(); }, this.pollDelay);
  }
  private async poll() {
    if (!this.visible()) return;
    if (this.busy || this.polling) { this.schedule(); return; }
    const generation = this.generation, epoch = this.effectEpoch, scope = { ...this.scope! };
    const current = () => generation === this.generation && epoch === this.effectEpoch && this.visible();
    this.polling = true;
    const before = JSON.stringify(this.state.records);
    try {
      // List recovers saved intents without reconciling mutations. Only acknowledged
      // worker IDs receive the read-only workerShow refresh.
      const records = await this.rpc("helm.orca.list", scope);
      if (!current()) return;
      this.state.records = this.owned(records);
      for (const record of this.activeRecords().filter(r => r.dispatchId && r.runId)) {
        if (!current() || this.busy) break;
        const result = await this.rpc("helm.orca.refresh", { ...scope, id: record.id });
        if (!current()) return;
        if (result?.id !== record.id || !this.owned([result]).length) throw Error("Orca returned another worker identity");
        this.state.records = this.state.records.map(r => r.id === result.id ? result : r);
      }
      this.pollDelay = before === JSON.stringify(this.state.records) ? 30000 : 4000;
      this.error = "";
    } catch (error) {
      if (current()) { this.error = "Worker refresh paused: " + (error instanceof Error ? error.message : String(error)); this.pollDelay = 30000; }
    } finally {
      this.polling = false;
      if (current()) this.render();
      this.schedule();
    }
  }
  constructor(private rpc: Rpc, private openReview?: (run: HelmRun) => Promise<void>) {}
  setScope(scope: Scope) {
    const key = JSON.stringify([scope.root, scope.profile]);
    if (key === this.key) return;
    this.stopTimer(); this.pollDelay = 4000;
    this.key = key; this.scope = { root: scope.root, profile: scope.profile }; this.generation++; this.busy = false; this.stopping = false; this.error = ""; this.info = undefined;
    if (!this.states.has(key)) this.states.set(key, { records: [], prompt: "", agent: "codex", model: "", output: "", truncated: false });
    this.render();
  }
  private get state() { return this.states.get(this.key)!; }
  mount(host?: HTMLElement) { document.removeEventListener("visibilitychange", this.visibilityChanged); if (host) document.addEventListener("visibilitychange", this.visibilityChanged); if (host !== this.host) { this.stopTimer(); this.generation++; this.busy = false; } this.host = host; this.render(); }
  private owned(records: any) { return Array.isArray(records) ? records.filter(r => r?.root === this.scope?.root && r?.profile === this.scope?.profile) : []; }
  async open() {
    if (!this.scope?.root) return;
    const scope = { ...this.scope }, generation = this.generation;
    await this.perform(async () => {
      const [info, records] = await Promise.all([this.rpc("helm.orca.info", scope), this.rpc("helm.orca.list", scope)]);
      if (generation !== this.generation) return;
      this.info = info; this.state.records = this.owned(records);
      if (this.state.pending && this.state.records.some(r => r.id === this.state.pending?.requestId)) {
        this.state.selected = this.state.pending.requestId; this.state.pending = undefined;
      }
    });
  }
  private async perform(work: () => Promise<void>) {
    if (this.busy) return;
    const generation = this.generation;
    this.effectEpoch++;
    this.busy = true; this.error = ""; this.render();
    try { await work(); } catch (e) { if (generation === this.generation) this.error = e instanceof Error ? e.message : String(e); }
    finally { if (generation === this.generation) { this.busy = false; this.render(); } }
  }
  private reviewControl(record: any) {
    if (!this.openReview || record.active || !record.runId || !record.dispatchId || !["needs_review", "stopped", "failed"].includes(record.state)) return "";
    return button("Review changes in Helm", "import", this.busy);
  }
  private render() {
    if (!this.host || !this.scope) return;
    const s = this.state, selected = s.records.find(r => r.id === s.selected);
    const focus = captureFocus(this.host), scroll = this.host.scrollTop;
    const childScroll = [...this.host.querySelectorAll<HTMLElement>("aside, main, pre, textarea")].map(el => [el.scrollTop, el.scrollLeft]);
    const openDetails = [...this.host.querySelectorAll("details")].map(el => el.open);
    const counts = {active:s.records.filter(r => ["starting","ready","stopping"].includes(r.state)).length, uncertain:s.records.filter(r => r.state === "unknown").length, review:s.records.filter(r => r.state === "needs_review").length};
    const availability = this.info?.state === "packaged";
    const modelPreference = s.agent === "opencode" && !s.pending
      ? '<p class="help">Uses the provider default in this Orca version.</p>'
      : '<details><summary>Model preference</summary><label class="field">Requested model<input id="orca-model" maxlength="200" value="' + esc(s.model) + '" placeholder="Provider default" ' + (s.pending ? "disabled" : "") + '></label><p class="help">Requested preference; actual model is not yet reported.</p></details>';
    const form = '<form><label class="field">Task<textarea id="orca-prompt" rows="5" maxlength="20000" required ' + (s.pending ? "disabled" : "") + '>' + esc(s.prompt) + '</textarea></label><label class="field">Coding agent<select id="orca-agent" ' + (s.pending ? "disabled" : "") + '>' + [["codex","Codex"],["claude","Claude Code"],["opencode","Helm"]].map(([id,name]) => '<option value="' + id + '" ' + (s.agent === id ? "selected" : "") + '>' + name + '</option>').join("") + '</select></label>' + modelPreference + (s.pending ? '<p role="status">Acknowledgement is pending or uncertain. Refresh to find the retained intent, or retry the exact same request. Editing is paused to prevent duplicate tasks.</p>' + button("Request stop", "stop-pending", this.stopping) : "") + '<button type="submit" class="primary-button" ' + (this.busy || !availability ? "disabled" : "") + '>' + (this.busy ? "Working…" : s.pending ? "Retry same request" : "Start Orca task") + '</button><p class="help">Orca owns the worker and checkout. Reviewed integration remains a separate step.</p></form>';
    const detail = selected ? '<h2>' + esc(label(selected.state)) + '</h2><p>' + esc(selected.input.prompt) + '</p><dl><dt>Agent</dt><dd>' + esc(selected.input.agent === "opencode" ? "Helm" : selected.input.agent) + '</dd><dt>Requested model</dt><dd>' + esc(selected.input.model || "Provider default · actual model not reported") + '</dd><dt>Worker slot</dt><dd>' + (selected.active ? "Active or uncertain" : "Released") + '</dd></dl><p class="help">' + (selected.state === "ready" ? "Dispatch was acknowledged; completion has not been verified. Inspect the worker and changes." : selected.state === "unknown" ? "Outcome uncertain. Reconcile this retained request before sending replacement work." : selected.state === "needs_review" ? "Worker exited. Review changes and run independent checks before accepting output." : "Inspect saved state and output before continuing.") + '</p>' + (selected.error ? '<p class="inline-notice" role="alert">' + esc(selected.error) + '</p>' : "") + '<div class="page-actions">' + button("Refresh worker state","refresh-one",this.busy) + button("Reconcile request","recover",this.busy) + button("Read worker output","read",this.busy || !selected.dispatchId) + button("Stop worker","stop",this.busy || !selected.active) + this.reviewControl(selected) + '</div>' + (s.output ? '<pre class="orca-output" tabindex="0" aria-label="Orca worker output">' + esc(s.output) + '</pre>' + (s.truncated ? '<p class="help">Only bounded retained output is shown.</p>' : "") : "") + '<details><summary>Dispatch details</summary><p>Task ' + esc(selected.id) + ' · Run ' + esc(selected.runId || "not acknowledged") + ' · Dispatch ' + esc(selected.dispatchId || "not acknowledged") + '</p><pre class="orca-output">' + esc(JSON.stringify(selected.receipt ?? {},null,2).slice(0,16000)) + '</pre><p class="help">Receipt display is limited to 16,000 characters.</p></details>' : form;
    this.host.innerHTML = '<section class="helm-orca" aria-label="Orca workers"><header><div><h1>Orca</h1><p class="help">Coding tasks in Orca-managed workers and checkouts.</p></div>' + button("Refresh workers","refresh",this.busy) + '</header><div class="orca-availability" role="status"><strong>' + (availability ? "Runtime artifact available" : this.info?.state === "invalid" ? "Runtime integrity check failed" : this.info ? "Runtime not installed" : "Checking runtime") + '</strong><p>' + esc(this.info?.message ?? "Load runtime status before starting.") + '</p>' + (availability ? '<p class="help">Artifact presence does not confirm provider sign-in or readiness. Starting may require provider setup.</p>' : "") + '</div>' + (this.error ? '<p class="inline-notice" role="alert">' + esc(this.error) + '</p>' : "") + '<p class="orca-counts" role="status">' + counts.active + ' active · ' + counts.uncertain + ' uncertain · ' + counts.review + ' need review</p><div class="orca-layout"><aside aria-label="Orca task list">' + button("New Orca task","new",this.busy || !!s.pending) + (s.records.map(r => button('<strong>' + esc(r.input.prompt.slice(0,80)) + '</strong><span>' + esc(label(r.state)) + '</span>',"select",this.busy || !!s.pending,r.id)).join("") || '<p class="help">No Orca workers in this project and profile.</p>') + '</aside><main>' + detail + '</main></div></section>';
    this.host.querySelectorAll<HTMLElement>('[data-orca="select"]').forEach(el => el.setAttribute("aria-pressed", String(el.dataset.id === s.selected)));
    this.host.querySelectorAll<HTMLElement>("[data-orca]").forEach(el => { el.onclick = () => { void this.action(el.dataset.orca!,el.dataset.id); }; });
    for (const field of ["prompt","agent","model"]) {
      const el = this.host.querySelector<HTMLInputElement>("#orca-" + field);
      if (el) { const update = () => {
        if (s.pending || (field === "model" && s.agent === "opencode")) return;
        (s as any)[field] = el.value;
        if (field === "agent") { if (s.agent === "opencode") s.model = ""; this.render(); }
      }; el.oninput = update; el.onchange = update; }
    }
    this.host.querySelector("form")?.addEventListener("submit", e => { e.preventDefault(); void this.start(); });
    this.host.querySelectorAll("details").forEach((el,i) => { el.open = openDetails[i] ?? false; });
    this.host.querySelectorAll<HTMLElement>("aside, main, pre, textarea").forEach((el,i) => { el.scrollTop = childScroll[i]?.[0] ?? 0; el.scrollLeft = childScroll[i]?.[1] ?? 0; });
    this.host.scrollTop = scroll; restoreFocus(this.host,focus);
    this.schedule();
  }
  private accept(record: any) {
    const valid = this.owned([record])[0];
    if (!valid) throw Error("Orca returned a record from another project or profile");
    this.state.records = [valid,...this.state.records.filter(r => r.id !== valid.id)]; this.state.selected = valid.id;
  }
  private async start() {
    if (this.busy || this.info?.state !== "packaged" || !this.scope) return;
    const state = this.state, scope = { ...this.scope }, generation = this.generation;
    const model = state.agent === "opencode" && !state.pending ? "" : state.model.trim();
    if (!state.prompt.trim()) { this.error = "Describe the coding task first."; this.render(); return; }
    if (state.prompt.length > 20000 || state.prompt.includes(String.fromCharCode(0)) || model.startsWith("-") || model.length > 200 || !["claude", "codex", "opencode"].includes(state.agent)) { this.error = "Check the task, agent and model preference before starting."; this.render(); return; }
    state.pending ??= { requestId: crypto.randomUUID(),prompt: state.prompt.trim(),agent: state.agent,...(model ? {model} : {}) };
    const pending = { ...state.pending };
    await this.perform(async () => {
      const record = await this.rpc("helm.orca.start",{...scope,...pending});
      if (generation !== this.generation) return;
      if (record?.id !== pending.requestId) throw Error("Orca returned a different request identity");
      this.accept(record); state.pending = undefined;
    });
  }
  private async action(action: string,id?: string) {
    if (action === "stop-pending") {
      if (!this.state.pending || !this.scope || this.stopping) return;
      const scope = { ...this.scope }, id = this.state.pending.requestId;
      const generation = ++this.generation;
      this.busy = false; this.stopping = true;
      await this.perform(async () => {
        const record = await this.rpc("helm.orca.stop", { ...scope, id });
        if (generation !== this.generation) return;
        if (record?.id !== id) throw Error("Orca returned another worker identity");
        if (record.cancelledBeforeAdmission === true) {
          if (record.root !== scope.root || record.profile !== scope.profile || record.workerState !== "not_found_at_inspection") throw Error("Orca returned an invalid queued cancellation receipt");
          this.error = "Queued request cancelled. No worker was found when checked.";
        } else this.accept(record);
        this.state.pending = undefined;
      });
      if (generation === this.generation) { this.stopping = false; this.render(); }
      return;
    }
    if (action === "refresh") return this.open();
    if (action === "new" || action === "select") {
      if (this.busy || this.state.pending) return;
      this.state.selected = action === "select" ? id : undefined; if (action === "new") { this.state.prompt = ""; this.state.model = ""; } this.state.output = ""; this.state.truncated = false; this.render(); return;
    }
    const selected = this.state.records.find(r => r.id === this.state.selected);
    if (!selected || !this.scope) return;
    const scope = { ...this.scope }, generation = this.generation, selectedId = selected.id;
    await this.perform(async () => {
      if (action === "import") {
        if (!this.openReview || !this.reviewControl(selected)) return;
        const run = await this.rpc("helm.orca.import", { ...scope, id: selectedId });
        if (generation !== this.generation || this.state.selected !== selectedId) return;
        if (!run?.id || run.root !== scope.root || run.owner !== scope.profile || run.orcaOrigin?.intentId !== selectedId || run.orcaOrigin.runId !== selected.runId || run.orcaOrigin.dispatchId !== selected.dispatchId || (selected.runtimeId && run.orcaOrigin.runtimeId !== selected.runtimeId)) throw Error("The review snapshot did not match this Orca worker.");
        await this.openReview(run);
        return;
      }
      const result = await this.rpc("helm.orca." + (action === "refresh-one" ? "refresh" : action),{...scope,id:selectedId});
      if (generation !== this.generation || this.state.selected !== selectedId) return;
      if (action === "read") {
        if (typeof result?.output !== "string") throw Error("Orca returned invalid output");
        this.state.output = result.output.slice(-32000); this.state.truncated = !!result.truncated || result.output.length > 32000;
      } else { if (result?.id !== selectedId) throw Error("Orca returned another worker identity"); this.accept(result); }
    });
  }
}
