import { icon } from "./icons";
import { WorkAuditView } from "./work-audit";
import { captureFocus, restoreFocus } from "./focus";
import type { HelmRun } from "../core/helm-types";
import "./work-goals.css";

type Row = Record<string, any>;
type Rpc = (method: string, args?: Row) => Promise<any>;
type Context = { profile: string; root: string; profiles: Array<{ id: string; name: string }> };
type TaskDraft = { engineChoice?: string; id: string; title: string; prompt: string; profile: string; dependsOn: string[]; writeMode: "project" | "declared"; writes: string; acceptance: Array<{ id: string; path: string; contains: string }> };
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const label = (value: string) => ({ needs_review: "Needs review", budget_exhausted: "Budget reached", queued: "Waiting", draft: "Draft", running: "Working", completed: "Completed", failed: "Failed", interrupted: "Interrupted", unknown: "Outcome unknown", cancelled: "Stopped" })[value] ?? value;
const button = (text: string, action: string, extra = "") => `<button type="button" data-work="${action}" ${extra}>${text}</button>`;

/** Native workbench view for persisted goal execution. Drafts survive shell rerenders. */
export class WorkGoalsView {
  private host?: HTMLElement;
  private audit?: WorkAuditView;
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
  private maxConcurrent = "2";
  private checks: Array<{ id: string; path: string; contains: string }> = [];
  private nextCheck = 1;
  private tasks: TaskDraft[] = [];
  private steering: Record<string, string> = {};
  private generation = 0;
  private scopeVersion = 0;
  private renderedView = "";
  constructor(private rpc: Rpc, private openSession: (id: string) => void, private openReview?: (run: HelmRun) => Promise<void>) {}

  async open(context: Context) {
    if (this.context?.profile !== context.profile || this.context?.root !== context.root) {
      this.audit?.dispose(); this.audit = undefined;
      this.scopeVersion++; this.busy = false; this.objective = ""; this.checks = [];
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
  async selectGoal(id: string, taskId?: string) {
    if (!this.context) return;
    const generation = ++this.generation, scope = this.scopeVersion, profile = this.context.profile;
    const goal = await this.rpc("work.get", { id, profile });
    if (generation !== this.generation || scope !== this.scopeVersion) return;
    if (goal?.id !== id || (goal.profile && goal.profile !== profile)) throw new Error("The work result did not match this goal and profile.");
    this.selected = goal; this.creating = false; this.error = ""; this.notice = ""; this.render();
    if (taskId) {
      const task = this.host?.querySelector<HTMLElement>(`[data-work-task="${CSS.escape(taskId)}"]`);
      task?.focus({ preventScroll: true }); task?.scrollIntoView?.({ block: "nearest" });
    }
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
        <label class="field">Execution engine<select data-task="${task.id}" name="engineChoice">${[["hades","Hades agent"],["codex","Orca · Codex"],["claude","Orca · Claude"],["opencode","Orca · Helm"]].map(([value,name])=>`<option value="${value}" ${(task.engineChoice??"hades")===value?"selected":""}>${name}</option>`).join("")}</select></label><p class="help">Orca requires its packaged runtime and provider setup. It owns an isolated worktree. Provider token usage is unmeasured; the Work token allocation stays reserved. Review exited output in Helm, apply the reviewed changes, run source checks, then explicitly accept the task result before dependent tasks proceed. Resume reconciles the saved worker; it does not start a replacement.</p>
        <details class="advanced"><summary>Edit ownership and task checks</summary><label class="field">Edit coordination<select data-task="${task.id}" name="writeMode"><option value="project" ${task.writeMode === "project" ? "selected" : ""}>Reserve the entire project</option><option value="declared" ${task.writeMode === "declared" ? "selected" : ""}>Declare files or directories</option></select></label><label class="field">Declared edit paths<textarea data-task="${task.id}" name="writes" rows="2" placeholder="src/components
reports/summary.md">${esc(task.writes)}</textarea></label><p class="help">Choose declared paths to use this list: one project-relative file or directory per line, no wildcards. An empty declared list means no edits declared. Coordinates edits between tasks; tool permissions still apply.</p>
        ${task.acceptance.map(check => `<fieldset class="work-task-draft"><legend>Task output</legend><label class="field">Expected task file<input data-task="${task.id}" data-task-check="${check.id}" name="taskExpected" value="${esc(check.path)}" placeholder="reports/summary.md"></label><label class="field">Required task text (optional)<input data-task="${task.id}" data-task-check="${check.id}" name="taskContains" value="${esc(check.contains)}"></label>${button("Remove task check", "task-check-remove", `data-task="${task.id}" data-task-check="${check.id}"`)}</fieldset>`).join("")}${button("Add task output check", "task-check-add", `data-task="${task.id}" ${task.acceptance.length >= 32 ? "disabled" : ""}`)}<p class="help">A task needs checked output receipts before dependent tasks can proceed. A finished conversation alone does not verify its output.</p></details>
        ${index ? `<fieldset class="work-dependencies"><legend>Start after</legend>${this.tasks.slice(0, index).map(before => `<label><input type="checkbox" data-task="${task.id}" name="dependsOn" value="${before.id}" ${task.dependsOn.includes(before.id) ? "checked" : ""}>${esc(before.title || "Task " + (this.tasks.indexOf(before) + 1))}</label>`).join("")}</fieldset>` : ""}
        ${this.tasks.length > 1 ? button("Remove task", "remove", `data-task="${task.id}"`) : ""}</fieldset>`).join("")}</div>
      ${button(icon("+") + "Add task", "add", this.tasks.length >= 16 ? "disabled" : "")}
      <details class="advanced"><summary>Team concurrency and budget</summary><label class="field">Tasks at once<input type="number" min="1" max="8" name="maxConcurrent" value="${esc(this.maxConcurrent)}" required></label><p class="help">Independent tasks can run together when their edit reservations do not overlap.</p><div class="work-limits"><label class="field">Token limit<input type="number" min="1000" max="10000000" step="1000" name="maxTokens" value="${esc(this.maxTokens)}" required></label><label class="field">Time limit (minutes)<input type="number" min="1" max="1440" name="maxMinutes" value="${esc(this.maxMinutes)}" required></label><label class="field">Turn limit per task<input type="number" min="1" max="64" name="maxRounds" value="${esc(this.maxRounds)}" required></label></div></details>
      <details class="advanced"><summary>Check the results</summary>${this.checks.map((check, index) => `<fieldset class="work-task-draft"><legend>Output ${index + 1}</legend><label class="field">Expected output file<input data-check="${check.id}" name="expected" value="${esc(check.path)}" placeholder="reports/summary.md"></label><label class="field">Required text (optional)<input data-check="${check.id}" name="contains" value="${esc(check.contains)}" placeholder="A phrase that must appear in this file"></label>${button("Remove output check", "check-remove", `data-check="${check.id}"`)}</fieldset>`).join("")}${button(icon("+") + "Add output check", "check-add", this.checks.length >= 32 ? "disabled" : "")}<p class="help">Hades checks every listed file after the tasks finish. Without an output check, finished work stays in Needs review.</p></details>
      <div class="page-actions"><button type="submit" class="primary-button" ${this.busy || !context.root ? "disabled" : ""}>${this.busy ? "Saving…" : "Save work"}</button>${button("Cancel", "back")}</div></form>`;
  }
  private orcaReview(task: Row) {
    if (task.engine?.kind !== "orca") return "";
    const receipt = task.orcaAcceptance;
    const accepted = receipt && task.status === "completed";
    const reviewable = task.engine.dispatchIntent === true && ["failed", "interrupted", "cancelled", "needs_review"].includes(task.status);
    const children = this.selected!.tasks.filter((child: Row) => child.dependsOn?.includes(task.id)).map((child: Row) => child.title);
    return `<section class="work-orca-review" aria-label="Orca result review"><strong>${accepted ? "Task result accepted" : receipt ? "Previous result acceptance" : "Review the task result"}</strong>${receipt ? `<p class="help">${esc(new Date(receipt.acceptedAt).toLocaleString())} · Review ${esc(receipt.reviewId)}<br>Source check ${esc(receipt.sourceCheckId)}</p><details><summary>Accepted source contents</summary><code class="work-evidence-hash">${esc(receipt.sourceRevision)}</code><p class="help">Patch SHA-256 ${esc(receipt.patchDigest)}</p></details>` : '<p class="help">Worker exit does not verify the result. Helm provides a review snapshot, checks, and explicit source application.</p>'}${children.length ? `<p class="help">${accepted ? "Dependent tasks can be considered when Work resumes" : "Dependent tasks wait for acceptance"}: ${children.map(esc).join(", ")}.</p>` : ""}${this.openReview && (reviewable || receipt) ? button(receipt ? "Open reviewed result" : "Review changes", "orca-review", `data-task="${esc(task.id)}" ${this.busy ? "disabled" : ""} ${receipt ? "" : 'class="primary-button"'}`) : ""}${reviewable && !receipt ? '<p class="help">Opens in Helm. No changes are applied to the source project by this action.</p>' : ""}</section>`;
  }
  private sourceOperations() {
    const goal = this.selected!;
    const operations = Array.isArray(goal.sourceOperations) ? goal.sourceOperations.filter((operation: Row) => operation.goal === goal.id && operation.root === goal.root && ["active", "unconfirmed"].includes(operation.state)) : [];
    if (!operations.length) return "";
    const names: Record<string, string> = { verify: "Checking the review snapshot", prepare: "Preparing the source review", apply: "Applying reviewed changes", source: "Checking the source project", accept: "Accepting the task result" };
    return `<section class="work-task work-source-operations" aria-label="Source operation status"><h2>Source project activity</h2>${operations.map((operation: Row) => `<article><strong>${esc(names[String(operation.kind).split(":")[0]] ?? "Source project operation")}</strong><p role="status">${operation.state === "active" ? "In progress" : "Outcome unconfirmed"}${operation.cancelled ? " · Stop requested" : ""}</p><p class="help">${esc(goal.tasks.find((task: Row) => task.id === operation.task)?.title ?? "This work")} · Started ${esc(new Date(operation.started).toLocaleString())}</p>${operation.state === "unconfirmed" ? '<p class="help">The project stays reserved until the saved outcome is confirmed.</p>' : ""}${operation.state === "unconfirmed" && typeof operation.kind === "string" && operation.kind.startsWith("apply:") ? button("Check application status", "source-reconcile", `data-operation="${esc(operation.id)}" ${this.busy ? "disabled" : ""}`) : ""}</article>`).join("")}</section>`;
  }
  private detail() {
    const goal = this.selected!;
    const reserved = goal.tasks.reduce((total: number, task: Row) => total + (task.reservedTokens ?? 0), 0);
    const finished = goal.tasks.filter((task: Row) => task.status === "completed").length;
    const attention = goal.tasks.filter((task: Row) => task.pendingApproval || ["failed", "interrupted", "unknown"].includes(task.status)).length;
    const resumable = ["needs_review", "cancelled", "budget_exhausted"].includes(goal.status);
    return `<div class="page-actions">${button(icon("back") + "All work", "back")}${button("Refresh", "refresh")}</div><div class="page-heading"><h1>${esc(goal.objective)}</h1><p>${esc(label(goal.status))} · ${(goal.tokens ?? 0).toLocaleString()} / ${Number(goal.maxTokens).toLocaleString()} reported tokens · ${esc(goal.maxMinutes)} min limit</p>${reserved ? `<p class="help">${Number(reserved).toLocaleString()} tokens reserved for calls whose usage is not yet known. This is separate from reported usage.</p>` : ""}</div>
      <div class="work-team-summary" aria-label="Work team summary"><div><span>Tasks finished</span><strong>${finished} / ${goal.tasks.length}</strong></div><div><span>Needs attention</span><strong>${attention}</strong></div><div><span>Team concurrency</span><strong>${esc(goal.maxConcurrent ?? 2)} at once</strong><span>${Math.floor((goal.elapsedMs ?? 0) / 60000)} min elapsed</span></div></div><p class="help">Project: <span class="mono">${esc(goal.root ?? this.context!.root)}</span></p>
      ${goal.error ? `<p class="inline-notice" role="alert">${esc(goal.error)}</p>` : ""}
      ${this.sourceOperations()}
      ${resumable ? `<details class="advanced"><summary>Adjust team limits before resuming</summary><label class="field">Tasks at once<input name="resumeConcurrent" type="number" min="1" max="8" value="${esc(goal.maxConcurrent ?? 2)}"></label><div class="work-limits"><label class="field">Total token limit<input name="resumeTokens" type="number" min="${Math.max(1000, (goal.tokens ?? 0) + reserved + 1000)}" max="10000000" step="1000" value="${goal.status === "budget_exhausted" ? Math.min(10000000, Math.max(goal.maxTokens, (goal.tokens ?? 0) + reserved) + 100000) : goal.maxTokens}"></label><label class="field">Total time limit (minutes)<input name="resumeMinutes" type="number" min="${Math.floor((goal.elapsedMs ?? 0) / 60000) + 1}" max="1440" value="${goal.status === "budget_exhausted" ? Math.min(1440, Number(goal.maxMinutes) + 60) : goal.maxMinutes}"></label><label class="field">Turn limit per task<input name="resumeRounds" type="number" min="${Math.max(0, ...goal.tasks.map((task: Row) => task.rounds ?? 0)) + 1}" max="64" value="${Math.min(64, Math.max(goal.maxRounds ?? 8, ...goal.tasks.map((task: Row) => (task.rounds ?? 0) + 1)))}"></label></div></details>` : ""}
      <div class="page-actions">${goal.status === "running" ? button("Stop work", "stop", this.busy ? "disabled" : "") : goal.status === "draft" ? button("Run work", "run", `class="primary-button" ${this.busy ? "disabled" : ""}`) : ["needs_review", "cancelled", "budget_exhausted"].includes(goal.status) ? button("Resume unfinished tasks", "resume", this.busy ? "disabled" : "") : ""}</div>
      ${["needs_review", "cancelled", "budget_exhausted"].includes(goal.status) ? '<p class="help">Review saved activity before resuming. Approved actions from interrupted tasks may already have happened.</p>' : ""}
      ${goal.acceptance?.length ? `<section class="work-task"><h2>Output checks</h2>${goal.acceptance.map((check: Row) => `<p><strong>${esc(check.path)}</strong>${check.contains ? `<br><span class="help">Must contain: ${esc(check.contains)}</span>` : '<br><span class="help">File must exist</span>'}</p>`).join("")}</section>` : ""}
      ${goal.evidence?.length ? `<section class="work-task"><h2>Recorded file checks</h2><p class="help">These checks identify the file contents recorded when verification ran.</p>${goal.evidence.map((item: Row) => `<p>${esc(item.path)} <span class="help">· ${Number(item.bytes).toLocaleString()} bytes</span><br><code class="work-evidence-hash">SHA-256 ${esc(item.sha256)}</code></p>`).join("")}</section>` : ""}
      <div class="work-tasks">${goal.tasks.map((task: Row) => `<section class="work-task" data-work-task="${esc(task.id)}" tabindex="-1"><div class="work-task-heading"><h2>${esc(task.title)}</h2><span>${esc(task.pendingApproval ? "Waiting for approval" : label(task.status))}</span></div><p class="help">${esc(this.context!.profiles.find(p => p.id === task.profile)?.name ?? task.profile)}${task.engine?.kind === "orca" ? " · Orca / " + esc(({codex:"Codex",claude:"Claude",opencode:"Helm"} as Record<string,string>)[task.engine.agent] ?? task.engine.agent) + " · " + esc(task.engine.requestId) : ""}${task.dependsOn?.length ? " · After " + task.dependsOn.map((id: string) => esc(goal.tasks.find((t: Row) => t.id === id)?.title ?? id)).join(", ") : ""}</p>
      <p class="help"><strong>Edit coordination:</strong> ${task.writes === undefined ? "Entire project reserved" : task.writes.length ? esc(task.writes.join(", ")) : "No edits declared"}. Tool permissions still apply.</p>
      ${task.acceptance?.length ? `<details><summary>Task output checks · ${task.evidence?.length ?? 0} recorded receipts</summary>${task.acceptance.map((check: Row) => `<p>${esc(check.path)}${check.contains ? ` · Must contain: ${esc(check.contains)}` : " · File must exist"}</p>`).join("")}${(task.evidence ?? []).map((item: Row) => `<p>${esc(item.path)} · ${Number(item.bytes).toLocaleString()} bytes<br><code class="work-evidence-hash">SHA-256 ${esc(item.sha256)}</code></p>`).join("")}</details>` : '<p class="help">Output unchecked · no task output checks configured.</p>'}
      ${this.orcaReview(task)}
      ${task.attempts?.length ? `<details><summary>Attempt history · ${task.attempts.length}</summary>${task.attempts.map((attempt: Row) => `<div class="work-attempt"><strong>Attempt ${esc(attempt.number)} · ${esc(label(attempt.status))}</strong><p class="help">${esc(new Date(attempt.startedAt).toLocaleString())}${attempt.finishedAt ? " → " + esc(new Date(attempt.finishedAt).toLocaleString()) : ""} · ${attempt.tokens === undefined ? "Usage unknown" : Number(attempt.tokens).toLocaleString() + " reported tokens"}${attempt.reservedTokens ? " · " + Number(attempt.reservedTokens).toLocaleString() + " reserved tokens" : ""}</p>${attempt.error ? `<p>${esc(attempt.error)}</p>` : ""}${attempt.session ? button("Inspect attempt conversation", "session", `data-session="${esc(attempt.session)}"`) : ""}</div>`).join("")}</details>` : ""}
      ${["interrupted", "unknown"].includes(task.status) ? '<p class="work-attention">Inspect the saved conversation and current files before resuming. The last action may have happened.</p>' : ""}
      ${task.reservedTokens ? `<p class="help">${Number(task.reservedTokens).toLocaleString()} tokens reserved · usage not yet known</p>` : ""}${task.error ? `<p class="inline-notice">${esc(task.error)}</p>` : ""}${task.answer ? `<details><summary>Result</summary><pre class="work-answer">${esc(task.answer)}</pre></details>` : ""}
      ${task.session ? button(task.pendingApproval ? "Review approval" : "Open conversation & approvals", "session", `data-session="${esc(task.session)}"`) : ""}
      ${task.messages?.length ? `<details class="work-pending"><summary>${task.messages.length} pending instruction${task.messages.length === 1 ? "" : "s"}</summary><p class="help">Queued for a future task turn; not yet confirmed as applied.</p>${task.messages.map((message: Row) => `<p>${esc(message.input)}</p>`).join("")}</details>` : ""}
      <details class="advanced"><summary>Add instructions</summary><label class="field">Follow-up for ${esc(task.title)}<textarea data-steering="${esc(task.id)}" rows="2">${esc(this.steering[task.id] ?? "")}</textarea></label><p class="help">Saved for the next task turn. This does not interrupt a running action.</p>${button("Save instructions", "message", `data-task="${esc(task.id)}" ${this.busy ? "disabled" : ""}`)}</details></section>`).join("")}</div>`;
  }
  private render() {
    if (!this.host || !this.context) return;
    this.audit?.captureViewState();
    const actionFocus = captureFocus(this.host), scroll = this.host.scrollTop;
    // Preserve focus through incoming state updates; inputs are kept in state on input.
    const active = this.host.contains(document.activeElement) && document.activeElement?.matches("input, textarea, select") ? document.activeElement as HTMLInputElement : undefined;
    const key = active ? { name: active.name, task: active.dataset.task, check: active.dataset.check, taskCheck: active.dataset.taskCheck, steering: active.dataset.steering, start: active.selectionStart, end: active.selectionEnd } : undefined;
    const viewKey = `${this.scopeVersion}:${this.creating ? "create" : this.selected?.id ?? "list"}`;
    const expanded = this.renderedView === viewKey ? [...this.host.querySelectorAll<HTMLDetailsElement>("details")].filter(item => !item.closest(".work-audit")).map(item => item.open) : [];
    this.renderedView = viewKey;
    const scope = this.scopeVersion;
    const auditScope = !this.creating && this.selected ? { goalId: String(this.selected.id), profile: this.context.profile, root: String(this.selected.root ?? this.context.root) } : undefined;
    if (!auditScope || !this.audit?.matches(auditScope)) { this.audit?.dispose(); this.audit = auditScope ? new WorkAuditView(this.rpc, auditScope) : undefined; }
    this.host.innerHTML = `<div class="page work-page">${this.error ? `<p class="inline-notice" role="alert">${esc(this.error)}</p>` : ""}${this.notice ? `<p role="status">${esc(this.notice)}</p>` : ""}${this.creating ? this.form() : this.selected ? this.detail() : `<div class="page-heading"><h1>Work</h1><p>Goals, delegated tasks and their saved results.</p></div><div class="page-actions">${button("New work", "new", 'class="primary-button"')}${button("Refresh", "refresh")}</div>${this.goals.length ? this.goals.map(goal => `<div class="record"><div><h3>${esc(goal.objective)}</h3><small>${esc(label(goal.status))} · ${goal.tasks?.length ?? 0} tasks</small></div>${button("Open", "open", `data-id="${esc(goal.id)}"`)}</div>`).join("") : '<p class="help">Create a goal to organize work across your agents.</p>'}`}</div>`;
    this.host.querySelectorAll<HTMLDetailsElement>("details").forEach((item, index) => { if (expanded[index] !== undefined) item.open = expanded[index]; });
    if (this.audit) this.audit.mount(this.host.querySelector<HTMLElement>(".work-page")!);
    this.host.querySelectorAll<HTMLElement>("[data-work]").forEach((el, index) => {
      el.id = `work-action-${encodeURIComponent([this.selected?.id ?? "list", el.dataset.work, el.dataset.task ?? el.dataset.operation ?? el.dataset.id ?? el.dataset.check ?? "", index].join(":"))}`;
      el.onclick = () => { void this.action(el.dataset.work!, el).catch(error => { if (scope === this.scopeVersion) this.fail(error); }); };
    });
    this.host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select").forEach(el => {
      const update = () => {
        if (el.dataset.steering) this.steering[el.dataset.steering] = el.value;
        else if (el.dataset.taskCheck) {
          const check = this.tasks.find(task => task.id === el.dataset.task)?.acceptance.find(check => check.id === el.dataset.taskCheck);
          if (check) { if (el.name === "taskExpected") check.path = el.value; else if (el.name === "taskContains") check.contains = el.value; }
        }
        else if (el.dataset.check) {
          const check = this.checks.find(item => item.id === el.dataset.check);
          if (check) { if (el.name === "expected") check.path = el.value; else if (el.name === "contains") check.contains = el.value; }
        } else if (el.dataset.task) {
          const task = this.tasks.find(t => t.id === el.dataset.task)!;
          if (el.name === "dependsOn") task.dependsOn = (el as HTMLInputElement).checked ? [...new Set([...task.dependsOn, el.value])] : task.dependsOn.filter(id => id !== el.value);
          else if (el.name === "writeMode") task.writeMode = el.value === "declared" ? "declared" : "project";
          else if (["profile", "title", "prompt", "writes", "engineChoice"].includes(el.name)) (task as any)[el.name] = el.value;
        } else if (["objective", "maxTokens", "maxMinutes", "maxRounds", "maxConcurrent"].includes(el.name)) (this as any)[el.name] = el.value;
      };
      el.oninput = update; el.onchange = update;
    });
    this.host.querySelector<HTMLFormElement>("form")?.addEventListener("submit", event => { event.preventDefault(); void this.save().catch(error => { if (scope === this.scopeVersion) this.fail(error); }); });
    if (key) {
      const next = [...this.host.querySelectorAll<HTMLInputElement>("input, textarea, select")].find(el => key.steering ? el.dataset.steering === key.steering : el.name === key.name && el.dataset.task === key.task && el.dataset.check === key.check && el.dataset.taskCheck === key.taskCheck);
      next?.focus({ preventScroll: true });
      if (next && key.start !== null && key.end !== null && ["text", "textarea"].includes(next.type)) next.setSelectionRange(key.start, key.end);
    } else restoreFocus(this.host, actionFocus);
    this.host.scrollTop = scroll;
  }
  private async save() {
    if (this.busy) return;
    if (this.checks.some(check => check.contains.trim() && !check.path.trim())) throw new Error("Choose an output file for each required-text check.");
    if (this.tasks.some(task => task.acceptance.some(check => check.contains.trim() && !check.path.trim()))) throw new Error("Choose a task output file for each required-text check.");
    const tasks = this.tasks.map(({ writeMode, writes, acceptance, engineChoice, ...task }) => ({ ...task, engine: !engineChoice || engineChoice === "hades" ? {kind:"hades"} : {kind:"orca",agent:engineChoice}, ...(writeMode === "declared" ? { writes: writes.split(/\r?\n/).map(path => path.trim()).filter(Boolean) } : {}), acceptance: acceptance.filter(check => check.path.trim()).map(check => ({ path: check.path.trim(), ...(check.contains.trim() ? { contains: check.contains.trim() } : {}) })) }));
    const scope = this.scopeVersion;
    this.busy = true; this.error = ""; this.render();
    try {
      const selected = await this.rpc("work.create", { objective: this.objective, root: this.context!.root, profile: this.context!.profile, tasks, maxConcurrent: Number(this.maxConcurrent), maxTokens: Number(this.maxTokens), maxMinutes: Number(this.maxMinutes), maxRounds: Number(this.maxRounds), acceptance: this.checks.filter(check => check.path.trim()).map(check => ({ path: check.path.trim(), ...(check.contains.trim() ? { contains: check.contains.trim() } : {}) })) });
      if (scope !== this.scopeVersion) return;
      this.selected = selected; this.creating = false; this.notice = "Work saved. Review the tasks, then run it.";
    } finally { if (scope === this.scopeVersion) { this.busy = false; this.render(); } }
  }
  private async action(action: string, el: HTMLElement) {
    if (this.busy && ["message", "run", "stop", "resume", "orca-review", "source-reconcile"].includes(action)) return;
    const scope = this.scopeVersion;
    this.error = ""; this.notice = "";
    if (action === "new") {
      this.creating = true; this.objective = ""; this.nextCheck = 2; this.checks = [{ id: "check1", path: "", contains: "" }];
      this.tasks = [{ id: "task1", title: "", prompt: "", profile: this.context!.profile, dependsOn: [], writeMode: "project", writes: "", acceptance: [] }];
    } else if (action === "task-check-add") {
      const task = this.tasks.find(task => task.id === el.dataset.task);
      if (task && task.acceptance.length < 32) task.acceptance.push({ id: "check" + this.nextCheck++, path: "", contains: "" });
    } else if (action === "task-check-remove") {
      const task = this.tasks.find(task => task.id === el.dataset.task);
      if (task) task.acceptance = task.acceptance.filter(check => check.id !== el.dataset.taskCheck);
    } else if (action === "check-add") {
      if (this.checks.length >= 32) return;
      this.checks.push({ id: "check" + this.nextCheck++, path: "", contains: "" });
    } else if (action === "check-remove") {
      this.checks = this.checks.filter(check => check.id !== el.dataset.check);
    } else if (action === "add") {
      if (this.tasks.length >= 16) return;
      const id = "task" + (Math.max(...this.tasks.map(task => Number(task.id.slice(4)))) + 1);
      this.tasks.push({ id, title: "", prompt: "", profile: this.context!.profile, dependsOn: [], writeMode: "project", writes: "", acceptance: [] });
    } else if (action === "remove") {
      this.tasks = this.tasks.filter(t => t.id !== el.dataset.task).map(t => ({ ...t, dependsOn: t.dependsOn.filter(id => id !== el.dataset.task) }));
    } else if (action === "back") { this.creating = false; this.selected = undefined; await this.refresh(); }
    else if (action === "refresh") await this.refresh();
    else if (action === "open") { await this.selectGoal(el.dataset.id!); }
    else if (action === "session") this.openSession(el.dataset.session!);
    else if (action === "source-reconcile") {
      const goal = this.selected!, operation = goal.sourceOperations?.find((item: Row) => item.id === el.dataset.operation);
      if (!operation || operation.goal !== goal.id || operation.root !== goal.root || operation.state !== "unconfirmed" || typeof operation.kind !== "string" || !operation.kind.startsWith("apply:")) return;
      const profile = this.context!.profile;
      this.busy = true; this.render();
      try {
        await this.rpc("work.source.reconcile", { id: operation.id, profile });
        if (scope !== this.scopeVersion || this.selected?.id !== goal.id) return;
        this.notice = "Saved application status checked."; await this.refresh();
      } catch (error) { if (scope === this.scopeVersion && this.selected?.id === goal.id) this.fail(error); }
      finally { if (scope === this.scopeVersion) { this.busy = false; this.render(); } }
    }
    else if (action === "orca-review") {
      const goal = this.selected!, task = goal.tasks.find((item: Row) => item.id === el.dataset.task);
      if (!this.openReview || task?.engine?.kind !== "orca" || !task.engine.requestId) return;
      if (!task.orcaAcceptance && (task.engine.dispatchIntent !== true || !["failed", "interrupted", "cancelled", "needs_review"].includes(task.status))) return;
      const profile = this.context!.profile, requestId = task.engine.requestId, attemptId = task.attempts?.at(-1)?.id;
      const current = () => {
        const selected = this.selected, latest = selected?.tasks.find((item: Row) => item.id === task.id);
        return scope === this.scopeVersion && selected?.id === goal.id && latest?.engine?.requestId === requestId && (!attemptId || latest.attempts?.at(-1)?.id === attemptId);
      };
      this.busy = true; this.render();
      try {
        const result = task.orcaAcceptance
          ? { goal, run: await this.rpc("helm.get", { id: task.orcaAcceptance.runId, profile }) }
          : await this.rpc("work.orca.import", { id: goal.id, task: task.id, profile });
        if (!current()) return;
        const run = result?.run, origin = run?.workOrigin;
        if (result?.goal?.id !== goal.id || result.goal.root !== goal.root || result.goal.profile !== profile || run?.root !== goal.root || run.owner !== profile || !run.id || run.orcaOrigin?.intentId !== requestId || origin?.goalId !== goal.id || origin.taskId !== task.id || origin.ownerProfile !== profile || origin.taskProfile !== task.profile || origin.requestId !== requestId || !origin.attemptId || (attemptId && origin.attemptId !== attemptId) || (task.orcaAcceptance && run.id !== task.orcaAcceptance.runId)) throw new Error("The review snapshot did not match this Work task and attempt.");
        this.selected = result.goal;
        await this.openReview(run);
      } catch (error) { if (current()) this.fail(error); }
      finally { if (scope === this.scopeVersion) { this.busy = false; this.render(); } }
    }
    else if (action === "message") {
      const task = el.dataset.task!, input = this.steering[task]?.trim();
      if (!input) throw new Error("Write instructions first.");
      this.busy = true; this.render();
      try {
        await this.rpc("work.message", { id: this.selected!.id, task, input, profile: this.context!.profile });
        if (scope !== this.scopeVersion) return;
        if (this.steering[task]?.trim() === input) this.steering[task] = "";
        this.notice = "Instructions saved for the next task turn.";
        await this.refresh();
      } finally { if (scope === this.scopeVersion) this.busy = false; }
    } else if (["run", "stop", "resume"].includes(action)) {
      const limits = action === "resume" ? {
        maxConcurrent: Number(this.host?.querySelector<HTMLInputElement>('[name="resumeConcurrent"]')?.value),
        maxTokens: Number(this.host?.querySelector<HTMLInputElement>('[name="resumeTokens"]')?.value),
        maxMinutes: Number(this.host?.querySelector<HTMLInputElement>('[name="resumeMinutes"]')?.value),
        maxRounds: Number(this.host?.querySelector<HTMLInputElement>('[name="resumeRounds"]')?.value),
      } : {};
      this.busy = true; this.render();
      try { await this.rpc("work." + action, { id: this.selected!.id, profile: this.context!.profile, ...limits }); await this.refresh(); }
      finally { if (scope === this.scopeVersion) this.busy = false; }
    }
    this.render();
  }
}
