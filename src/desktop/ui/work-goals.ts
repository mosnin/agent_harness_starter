import { icon } from "./icons";

type Row = Record<string, any>;
type Rpc = (method: string, args?: Row) => Promise<any>;
type Context = { profile: string; root: string; profiles: Array<{ id: string; name: string }> };
type TaskDraft = { id: string; title: string; prompt: string; profile: string; dependsOn: string[] };
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const label = (value: string) => ({ needs_review: "Needs review", budget_exhausted: "Budget reached", queued: "Waiting", draft: "Draft", running: "Working", completed: "Completed", failed: "Failed", interrupted: "Interrupted", cancelled: "Stopped" })[value] ?? value;
const button = (text: string, action: string, extra = "") => `<button type="button" data-work="${action}" ${extra}>${text}</button>`;

/** Native workbench view for persisted goal execution. Drafts survive shell rerenders. */
export class WorkGoalsView {
  private host?: HTMLElement;
  private goals: Row[] = [];
  private selected?: Row;
  private context?: Context;
  private creating = false;
  private busy = false;
  private error = "";
  private notice = "";
  private objective = "";
  private maxTokens = "300000";
  private maxMinutes = "60";
  private maxRounds = "8";
  private checks: Array<{ id: string; path: string; contains: string }> = [];
  private nextCheck = 1;
  private tasks: TaskDraft[] = [];
  private steering: Record<string, string> = {};
  private generation = 0;
  constructor(private rpc: Rpc, private openSession: (id: string) => void) {}

  async open(context: Context) {
    if (this.context?.profile !== context.profile) {
      this.selected = undefined; this.creating = false; this.tasks = []; this.steering = {}; this.error = ""; this.notice = "";
    }
    this.context = context;
    await this.refresh();
  }
  async refresh() {
    if (!this.context) return;
    const generation = ++this.generation;
    const profile = this.context.profile, id = this.selected?.id;
    try {
      const [goals, selected] = await Promise.all([
        this.rpc("work.list", { profile }),
        id ? this.rpc("work.get", { id, profile }) : Promise.resolve(undefined),
      ]);
      if (generation !== this.generation) return;
      this.goals = goals; this.selected = selected; this.render();
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }
  mount(host: HTMLElement) { this.host = host; this.render(); }
  private fail(error: unknown) { this.error = error instanceof Error ? error.message : String(error); this.render(); }
  private form() {
    const context = this.context!;
    return `<form data-work-form><div class="page-heading"><h1>New work</h1><p>Define the outcome and the tasks needed to get there.</p></div>
      <label class="field">Goal<textarea name="objective" required rows="3" placeholder="What should be finished?">${esc(this.objective)}</textarea></label>
      <p class="help">Project: <span class="mono">${esc(context.root || "Choose a project first")}</span></p>
      <div class="work-tasks">${this.tasks.map((task, index) => `<fieldset class="work-task-draft"><legend>Task ${index + 1}</legend>
        <label class="field">Title<input data-task="${task.id}" name="title" required value="${esc(task.title)}" placeholder="Describe this step"></label>
        <label class="field">Instructions<textarea data-task="${task.id}" name="prompt" rows="3" required>${esc(task.prompt)}</textarea></label>
        <label class="field">Agent<select data-task="${task.id}" name="profile">${context.profiles.map(p => `<option value="${esc(p.id)}" ${task.profile === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
        ${index ? `<fieldset class="work-dependencies"><legend>Start after</legend>${this.tasks.slice(0, index).map(before => `<label><input type="checkbox" data-task="${task.id}" name="dependsOn" value="${before.id}" ${task.dependsOn.includes(before.id) ? "checked" : ""}>${esc(before.title || "Task " + (this.tasks.indexOf(before) + 1))}</label>`).join("")}</fieldset>` : ""}
        ${this.tasks.length > 1 ? button("Remove task", "remove", `data-task="${task.id}"`) : ""}</fieldset>`).join("")}</div>
      ${button(icon("+") + "Add task", "add", this.tasks.length >= 16 ? "disabled" : "")}
      <div class="work-limits"><label class="field">Token limit<input type="number" min="1000" max="10000000" step="1000" name="maxTokens" value="${esc(this.maxTokens)}" required></label><label class="field">Time limit (minutes)<input type="number" min="1" max="1440" name="maxMinutes" value="${esc(this.maxMinutes)}" required></label><label class="field">Turn limit per task<input type="number" min="1" max="64" name="maxRounds" value="${esc(this.maxRounds)}" required></label></div>
      <details class="advanced"><summary>Check the results</summary>${this.checks.map((check, index) => `<fieldset class="work-task-draft"><legend>Output ${index + 1}</legend><label class="field">Expected output file<input data-check="${check.id}" name="expected" value="${esc(check.path)}" placeholder="reports/summary.md"></label><label class="field">Required text (optional)<input data-check="${check.id}" name="contains" value="${esc(check.contains)}" placeholder="A phrase that must appear in this file"></label>${button("Remove output check", "check-remove", `data-check="${check.id}"`)}</fieldset>`).join("")}${button(icon("+") + "Add output check", "check-add", this.checks.length >= 32 ? "disabled" : "")}<p class="help">Hades checks every listed file after the tasks finish. Without an output check, finished work stays in Needs review.</p></details>
      <div class="page-actions"><button type="submit" class="primary-button" ${this.busy || !context.root ? "disabled" : ""}>${this.busy ? "Saving…" : "Save work"}</button>${button("Cancel", "back")}</div></form>`;
  }
  private detail() {
    const goal = this.selected!;
    const reserved = goal.tasks.reduce((total: number, task: Row) => total + (task.reservedTokens ?? 0), 0);
    const resumable = ["needs_review", "cancelled", "budget_exhausted"].includes(goal.status);
    return `<div class="page-actions">${button(icon("back") + "All work", "back")}${button("Refresh", "refresh")}</div><div class="page-heading"><h1>${esc(goal.objective)}</h1><p>${esc(label(goal.status))} · ${(goal.tokens ?? 0).toLocaleString()} / ${Number(goal.maxTokens).toLocaleString()} reported tokens · ${esc(goal.maxMinutes)} min limit</p>${reserved ? `<p class="help">${Number(reserved).toLocaleString()} tokens reserved for calls whose usage is not yet known. This is separate from reported usage.</p>` : ""}</div>
      ${goal.error ? `<p class="inline-notice" role="alert">${esc(goal.error)}</p>` : ""}
      ${resumable ? `<div class="work-limits"><label class="field">Total token limit<input name="resumeTokens" type="number" min="${Math.max(1000, (goal.tokens ?? 0) + reserved + 1000)}" max="10000000" step="1000" value="${goal.status === "budget_exhausted" ? Math.min(10000000, Math.max(goal.maxTokens, (goal.tokens ?? 0) + reserved) + 100000) : goal.maxTokens}"></label><label class="field">Total time limit (minutes)<input name="resumeMinutes" type="number" min="${Math.floor((goal.elapsedMs ?? 0) / 60000) + 1}" max="1440" value="${goal.status === "budget_exhausted" ? Math.min(1440, Number(goal.maxMinutes) + 60) : goal.maxMinutes}"></label><label class="field">Turn limit per task<input name="resumeRounds" type="number" min="${Math.max(0, ...goal.tasks.map((task: Row) => task.rounds ?? 0)) + 1}" max="64" value="${Math.min(64, Math.max(goal.maxRounds ?? 8, ...goal.tasks.map((task: Row) => (task.rounds ?? 0) + 1)))}"></label></div>` : ""}
      <div class="page-actions">${goal.status === "running" ? button("Stop work", "stop", this.busy ? "disabled" : "") : goal.status === "draft" ? button("Run work", "run", `class="primary-button" ${this.busy ? "disabled" : ""}`) : ["needs_review", "cancelled", "budget_exhausted"].includes(goal.status) ? button("Resume unfinished tasks", "resume", this.busy ? "disabled" : "") : ""}</div>
      ${["needs_review", "cancelled", "budget_exhausted"].includes(goal.status) ? '<p class="help">Review saved activity before resuming. Approved actions from interrupted tasks may already have happened.</p>' : ""}
      ${goal.acceptance?.length ? `<section class="work-task"><h2>Output checks</h2>${goal.acceptance.map((check: Row) => `<p><strong>${esc(check.path)}</strong>${check.contains ? `<br><span class="help">Must contain: ${esc(check.contains)}</span>` : '<br><span class="help">File must exist</span>'}</p>`).join("")}</section>` : ""}
      ${goal.evidence?.length ? `<section class="work-task"><h2>Recorded file checks</h2><p class="help">These checks identify the file contents recorded when verification ran.</p>${goal.evidence.map((item: Row) => `<p>${esc(item.path)} <span class="help">· ${Number(item.bytes).toLocaleString()} bytes</span><br><code class="work-evidence-hash">SHA-256 ${esc(item.sha256)}</code></p>`).join("")}</section>` : ""}
      <div class="work-tasks">${goal.tasks.map((task: Row) => `<section class="work-task"><div class="work-task-heading"><h2>${esc(task.title)}</h2><span>${esc(task.pendingApproval ? "Waiting for approval" : label(task.status))}</span></div><p class="help">${esc(this.context!.profiles.find(p => p.id === task.profile)?.name ?? task.profile)}${task.dependsOn?.length ? " · After " + task.dependsOn.map((id: string) => esc(goal.tasks.find((t: Row) => t.id === id)?.title ?? id)).join(", ") : ""}</p>
      ${task.reservedTokens ? `<p class="help">${Number(task.reservedTokens).toLocaleString()} tokens reserved · usage not yet known</p>` : ""}${task.error ? `<p class="inline-notice">${esc(task.error)}</p>` : ""}${task.answer ? `<details><summary>Result</summary><pre class="work-answer">${esc(task.answer)}</pre></details>` : ""}
      ${task.session ? button(task.pendingApproval ? "Review approval" : "Open conversation & approvals", "session", `data-session="${esc(task.session)}"`) : ""}
      <details class="advanced"><summary>Add instructions</summary><label class="field">Follow-up for ${esc(task.title)}<textarea data-steering="${esc(task.id)}" rows="2">${esc(this.steering[task.id] ?? "")}</textarea></label><p class="help">Saved for the next task turn. This does not interrupt a running action.</p>${button("Save instructions", "message", `data-task="${esc(task.id)}" ${this.busy ? "disabled" : ""}`)}</details></section>`).join("")}</div>`;
  }
  private render() {
    if (!this.host || !this.context) return;
    // Preserve focus through incoming state updates; inputs are kept in state on input.
    const active = this.host.contains(document.activeElement) ? document.activeElement as HTMLInputElement : undefined;
    const key = active ? { name: active.name, task: active.dataset.task, check: active.dataset.check, steering: active.dataset.steering, start: active.selectionStart, end: active.selectionEnd } : undefined;
    const expanded = [...this.host.querySelectorAll<HTMLDetailsElement>("details")].map(item => item.open);
    this.host.innerHTML = `<div class="page work-page">${this.error ? `<p class="inline-notice" role="alert">${esc(this.error)}</p>` : ""}${this.notice ? `<p role="status">${esc(this.notice)}</p>` : ""}${this.creating ? this.form() : this.selected ? this.detail() : `<div class="page-heading"><h1>Work</h1><p>Goals, delegated tasks and their saved results.</p></div><div class="page-actions">${button("New work", "new", 'class="primary-button"')}${button("Refresh", "refresh")}</div>${this.goals.length ? this.goals.map(goal => `<div class="record"><div><h3>${esc(goal.objective)}</h3><small>${esc(label(goal.status))} · ${goal.tasks?.length ?? 0} tasks</small></div>${button("Open", "open", `data-id="${esc(goal.id)}"`)}</div>`).join("") : '<p class="help">Create a goal to organize work across your agents.</p>'}`}</div>`;
    this.host.querySelectorAll<HTMLDetailsElement>("details").forEach((item, index) => { if (expanded[index] !== undefined) item.open = expanded[index]; });
    this.host.querySelectorAll<HTMLElement>("[data-work]").forEach(el => el.onclick = () => { void this.action(el.dataset.work!, el).catch(error => this.fail(error)); });
    this.host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select").forEach(el => {
      const update = () => {
        if (el.dataset.steering) this.steering[el.dataset.steering] = el.value;
        else if (el.dataset.check) {
          const check = this.checks.find(item => item.id === el.dataset.check);
          if (check) { if (el.name === "expected") check.path = el.value; else if (el.name === "contains") check.contains = el.value; }
        } else if (el.dataset.task) {
          const task = this.tasks.find(t => t.id === el.dataset.task)!;
          if (el.name === "dependsOn") task.dependsOn = (el as HTMLInputElement).checked ? [...new Set([...task.dependsOn, el.value])] : task.dependsOn.filter(id => id !== el.value);
          else if (el.name === "profile" || el.name === "title" || el.name === "prompt") task[el.name] = el.value;
        } else if (["objective", "maxTokens", "maxMinutes", "maxRounds"].includes(el.name)) (this as any)[el.name] = el.value;
      };
      el.oninput = update; el.onchange = update;
    });
    this.host.querySelector<HTMLFormElement>("form")?.addEventListener("submit", event => { event.preventDefault(); void this.save().catch(error => this.fail(error)); });
    if (key) {
      const next = [...this.host.querySelectorAll<HTMLInputElement>("input, textarea, select")].find(el => key.steering ? el.dataset.steering === key.steering : el.name === key.name && el.dataset.task === key.task && el.dataset.check === key.check);
      next?.focus({ preventScroll: true });
      if (next && key.start !== null && key.end !== null && ["text", "textarea"].includes(next.type)) next.setSelectionRange(key.start, key.end);
    }
  }
  private async save() {
    if (this.busy) return;
    if (this.checks.some(check => check.contains.trim() && !check.path.trim())) throw new Error("Choose an output file for each required-text check.");
    this.busy = true; this.error = ""; this.render();
    try {
      this.selected = await this.rpc("work.create", { objective: this.objective, root: this.context!.root, profile: this.context!.profile, tasks: this.tasks, maxTokens: Number(this.maxTokens), maxMinutes: Number(this.maxMinutes), maxRounds: Number(this.maxRounds), acceptance: this.checks.filter(check => check.path.trim()).map(check => ({ path: check.path.trim(), ...(check.contains.trim() ? { contains: check.contains.trim() } : {}) })) });
      this.creating = false; this.notice = "Work saved. Review the tasks, then run it.";
    } finally { this.busy = false; this.render(); }
  }
  private async action(action: string, el: HTMLElement) {
    this.error = ""; this.notice = "";
    if (action === "new") {
      this.creating = true; this.objective = ""; this.nextCheck = 2; this.checks = [{ id: "check1", path: "", contains: "" }];
      this.tasks = [{ id: "task1", title: "", prompt: "", profile: this.context!.profile, dependsOn: [] }];
    } else if (action === "check-add") {
      if (this.checks.length >= 32) return;
      this.checks.push({ id: "check" + this.nextCheck++, path: "", contains: "" });
    } else if (action === "check-remove") {
      this.checks = this.checks.filter(check => check.id !== el.dataset.check);
    } else if (action === "add") {
      if (this.tasks.length >= 16) return;
      const id = "task" + (Math.max(...this.tasks.map(task => Number(task.id.slice(4)))) + 1);
      this.tasks.push({ id, title: "", prompt: "", profile: this.context!.profile, dependsOn: [] });
    } else if (action === "remove") {
      this.tasks = this.tasks.filter(t => t.id !== el.dataset.task).map(t => ({ ...t, dependsOn: t.dependsOn.filter(id => id !== el.dataset.task) }));
    } else if (action === "back") { this.creating = false; this.selected = undefined; await this.refresh(); }
    else if (action === "refresh") await this.refresh();
    else if (action === "open") this.selected = await this.rpc("work.get", { id: el.dataset.id, profile: this.context!.profile });
    else if (action === "session") this.openSession(el.dataset.session!);
    else if (action === "message") {
      const task = el.dataset.task!, input = this.steering[task]?.trim();
      if (!input) throw new Error("Write instructions first.");
      await this.rpc("work.message", { id: this.selected!.id, task, input, profile: this.context!.profile });
      this.steering[task] = ""; this.notice = "Instructions saved for the next task turn.";
    } else if (["run", "stop", "resume"].includes(action)) {
      const limits = action === "resume" ? {
        maxTokens: Number(this.host?.querySelector<HTMLInputElement>('[name="resumeTokens"]')?.value),
        maxMinutes: Number(this.host?.querySelector<HTMLInputElement>('[name="resumeMinutes"]')?.value),
        maxRounds: Number(this.host?.querySelector<HTMLInputElement>('[name="resumeRounds"]')?.value),
      } : {};
      this.busy = true; this.render();
      try { await this.rpc("work." + action, { id: this.selected!.id, profile: this.context!.profile, ...limits }); await this.refresh(); }
      finally { this.busy = false; }
    }
    this.render();
  }
}
