import { captureFocus, restoreFocus } from "./focus";
import "./helm.css";
import { HelmCodeFrame } from "./helm-code";

type Rpc = (method: string, args?: Record<string, unknown>) => Promise<any>;
type Context = { root: string; profile: string; projects: string[] };
import type {
  HelmAgent as Agent,
  HelmRun as Run,
  HelmDiff,
} from "../core/helm-types";
type Note = {
  id: string;
  parentId?: string;
  title: string;
  body: string;
  kind: "decision" | "constraint" | "note" | "outcome";
  createdAt: number;
  updatedAt: number;
};
type Callbacks = {
  chooseProject(): void;
  selectProject(root: string): Promise<void>;
  openWorkspace(
    root: string,
    pane: "files" | "git" | "terminal",
  ): Promise<void>;
  openSession(id: string): void;
};
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const button = (label: string, action: string, extra = "") =>
  `<button type="button" data-helm="${action}" ${extra}>${label}</button>`;
const status = (value: string) =>
  ({
    starting: "Starting",
    running: "Working",
    needs_review: "Ready for review",
    verified: "Checks passed",
    failed: "Failed",
    cancelled: "Stopped",
    interrupted: "Interrupted",
  })[value] ?? value;
const AGENT_NAMES: Record<string, string> = {
  hades: "Hades",
  codex: "Codex",
  claude: "Claude Code",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  grok: "Grok Build",
};
const AGENT_DOCS: Record<string, string> = {
  codex: "https://developers.openai.com/codex/cli/reference/",
  claude: "https://code.claude.com/docs/en/cli-usage",
  gemini: "https://geminicli.com/docs/reference/configuration/",
  opencode: "https://opencode.ai/docs/cli/",
  grok: "https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md",
};
const agentName = (id: string) => AGENT_NAMES[id] ?? id;
const live = (run?: Run) =>
  !!run && ["starting", "running"].includes(run.status);

/** Native coding workspace. All process, Git, and verification authority stays in the sidecar. */
export class HelmView {
  private host?: HTMLElement;
  private destination: "code" | "tasks" = "code";
  private code = new HelmCodeFrame((url) => {
    void this.rpc("link.open", { url }).catch((error) => {
      this.error = message(error);
      this.render();
    });
  });
  private codeScope = "";
  private codeReady = false;
  private codeInfo?: { version: string; revision: string; fork: string };

  private context?: Context;
  private agents: Agent[] = [];
  private runs: Run[] = [];
  private notes: Note[] = [];
  private selected?: Run;
  private creating = true;
  private loading = false;
  private busy = false;
  private error = "";
  private notice = "";
  private prompt = "";
  private agent = "hades";
  private model = "";
  private maxMinutes = "30";
  private command = "npm";
  private args = '["test"]';
  private useCheck = false;
  private contextIds = new Set<string>();
  private tab: "overview" | "changes" | "checks" | "context" | "output" =
    "overview";
  private diff = "";
  private diffMeta?: HelmDiff;
  private noteEditor?: Partial<Note>;
  private generation = 0;
  constructor(
    private rpc: Rpc,
    private actions: Callbacks,
  ) {}
  async open(context: Context) {
    if (
      this.context?.root !== context.root ||
      this.context?.profile !== context.profile
    ) {
      this.code.attach();
      this.codeReady = this.codeScope === `${context.root}\n${context.profile}`;
      this.selected = undefined;
      this.runs = [];
      this.notes = [];
      this.contextIds.clear();
      this.noteEditor = undefined;
      this.creating = true;
    }
    this.context = context;
    await this.refresh();
  }
  mount(host: HTMLElement) {
    this.host = host;
    this.render();
  }
  async refresh(refreshAgents = false) {
    if (!this.context) return;
    const generation = ++this.generation;
    const { root, profile } = this.context;
    this.loading = true;
    this.render();
    try {
      const [agents, runs, notes, selected] = await Promise.all([
        this.rpc("helm.agents", refreshAgents ? { refresh: true } : {}),
        root ? this.rpc("helm.list", { root, profile }) : Promise.resolve([]),
        root ? this.rpc("helm.context.list", { root }) : Promise.resolve([]),
        this.selected
          ? this.rpc("helm.get", { id: this.selected.id, profile })
          : Promise.resolve(undefined),
      ]);
      if (generation !== this.generation) return;
      this.agents = agents;
      this.runs = runs;
      this.notes = notes;
      if (selected) this.selected = selected;
      if (!this.agents.some((a) => a.id === this.agent))
        this.agent =
          this.agents.find((a) => a.installed)?.id ??
          this.agents[0]?.id ??
          "hades";
    } catch (error) {
      if (generation === this.generation) this.error = message(error);
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.render();
      }
    }
  }
  private async perform(action: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    this.notice = "";
    this.render();
    try {
      await action();
    } catch (error) {
      this.error = message(error);
    } finally {
      this.busy = false;
      this.render();
    }
  }
  private checks(): Array<{ command: string; args: string[] }> {
    if (!this.useCheck) return [];
    const command = this.command.trim();
    if (!command || /[;&|<>`\n\r$]/.test(command))
      throw new Error(
        "Enter one executable, such as npm. Put its arguments in the arguments field.",
      );
    let args: unknown;
    try {
      args = JSON.parse(this.args);
    } catch {
      throw new Error('Arguments must be a JSON array, such as ["test"].');
    }
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))
      throw new Error("Every command argument must be text.");
    return [{ command, args }];
  }
  private form() {
    const selected = this.agents.find((a) => a.id === this.agent);
    return `<form data-helm-form="start" class="helm-start"><div class="page-heading"><h1>Build with Helm</h1><p>Give a coding agent a focused task. Review its changes and checks in one place.</p></div>
      <label class="field">What should change?<textarea id="helm-prompt" data-helm-field="prompt" rows="4" maxlength="20000" placeholder="Fix the failing checkout test and explain the change." required>${esc(this.prompt)}</textarea></label>
      <div class="helm-fields"><label class="field">Coding agent<select id="helm-agent" data-helm-field="agent">${this.agents.map((a) => `<option value="${esc(a.id)}" ${a.id === this.agent ? "selected" : ""}>${esc(agentName(a.id))}${a.installed ? "" : " · not installed"}</option>`).join("")}</select></label><label class="field">Time limit · minutes<input id="helm-minutes" data-helm-field="maxMinutes" type="number" min="1" max="240" value="${esc(this.maxMinutes)}" required></label></div>
      <div class="helm-readiness">${selected?.installed ? `<span class="helm-dot"></span><span>${esc(agentName(selected.id))} is available${selected.version ? ` · ${esc(selected.version)}` : ""}. ${selected.id === "hades" ? "Uses your selected Hades profile." : "Its own account and permissions are checked when it starts."}</span>` : `<span>${esc(selected ? agentName(selected.id) : "Agent")} is not available. Install or configure it, then refresh agents.</span>`}${button("Refresh agents", "refresh")}</div>
      <details class="helm-agent-setup"><summary>Set up ${esc(agentName(this.agent))}</summary><p class="help">${this.agent === "hades" ? "Hades uses the profile selected in the lower-left corner. Manage its provider and model in Hades Settings." : `Install ${esc(agentName(this.agent))} if needed, then open it in a terminal with ${esc(this.agent)} and complete its sign-in flow. Return here and refresh agents. Availability does not confirm account or model access.`}</p><div class="page-actions">${this.agent !== "hades" ? button("Open setup documentation", "docs", `data-url="${esc(AGENT_DOCS[this.agent] ?? "")}"`) : ""}${button("Refresh agents", "refresh")}</div></details>
      <p class="help">Helm works in a separate checkout from the latest local commit. Uncommitted changes in your current folder are not included.</p>
      <details class="helm-advanced"><summary>Model, checks and context</summary><label class="field">Model for this task · optional<input type="text" autocorrect="off" autocapitalize="off" autocomplete="off" spellcheck="false" id="helm-model" data-helm-field="model" value="${esc(this.model)}" placeholder="Use the agent’s configured model" maxlength="200"></label><p class="help">Use a model supported by this agent and account. This overrides only this task, not your global configuration.</p>${this.checkForm()}<fieldset class="helm-context-picker"><legend>Attach saved project context</legend>${this.notes.length ? this.notes.map((note) => `<label><input type="checkbox" data-helm-context="${esc(note.id)}" ${this.contextIds.has(note.id) ? "checked" : ""}>${esc(note.title)} <span class="muted">${esc(note.kind)}</span></label>`).join("") : '<p class="help">No saved context yet. Add a decision or constraint in Project context.</p>'}</fieldset><p class="help">Selected context is copied into this task when it starts. Later edits do not change a running task.</p></details>
      <div class="page-actions"><button class="primary-button" type="submit" ${this.busy || this.loading || !this.context?.root || !selected?.installed ? "disabled" : ""}>${this.busy ? "Starting…" : "Start coding task"}</button><span class="help">Changes remain local for your review.</span></div></form>`;
  }
  private checkForm() {
    return `<label class="helm-check"><input type="checkbox" id="helm-use-check" data-helm-field="useCheck" ${this.useCheck ? "checked" : ""}>Run a verification command</label><div class="helm-fields"><label class="field">Executable<input type="text" autocorrect="off" autocapitalize="off" autocomplete="off" spellcheck="false" id="helm-check-command" data-helm-field="command" value="${esc(this.command)}" placeholder="npm"></label><label class="field">Arguments · JSON array<input type="text" autocorrect="off" autocapitalize="off" autocomplete="off" spellcheck="false" id="helm-check-args" data-helm-field="args" value="${esc(this.args)}" placeholder='["test"]'></label></div><p class="help">Commands run directly in the task checkout. Shell pipelines and redirects are not used.</p>`;
  }
  private detail() {
    const run = this.selected!;
    const sections: Array<[typeof this.tab, string]> = [
      ["overview", "Overview"],
      ["changes", "Changes"],
      ["checks", "Checks"],
      ["context", "Context"],
      ["output", "Output"],
    ];
    let content = "";
    if (this.tab === "overview")
      content = `<p class="helm-objective">${esc(run.prompt)}</p>${run.error ? `<p class="inline-notice" role="alert">${esc(run.error)}</p>` : ""}<dl class="helm-facts"><div><dt>Agent</dt><dd>${esc(agentName(run.agent))}</dd></div><div><dt>Model</dt><dd>${esc(run.model || "Agent default")}</dd></div><div><dt>Time limit</dt><dd>${esc(run.maxMinutes)} minutes</dd></div><div><dt>Branch</dt><dd>${esc(run.branch || "Preparing checkout")}</dd></div><div><dt>Starting revision</dt><dd>${esc(run.baseSha?.slice(0, 12) || "Not recorded")}</dd></div><div><dt>Task folder</dt><dd>${esc(run.workspace || "Preparing checkout")}</dd></div>${run.owner ? `<div><dt>Owner</dt><dd>${esc(run.owner)}</dd></div>` : ""}${run.parentSession ? `<div><dt>Delegated from</dt><dd>${esc(run.parentSession)} ${button("Open parent conversation", "parent")}</dd></div>` : ""}</dl>${run.sourceDirty ? '<p class="inline-notice">This task started from the recorded commit. Uncommitted changes in the original project were excluded.</p>' : ""}${run.sourceDirty || run.exclusions.length ? `<details><summary>Preparation notes</summary>${run.exclusions.length ? `<ul>${run.exclusions.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>` : '<p class="help">Uncommitted project changes were excluded from the task checkout.</p>'}</details>` : ""}<p class="help">${run.status === "verified" ? "The recorded checks passed at the recorded revision. Review the diff before merging." : live(run) ? "Output updates here while the agent works. You can stop the task at any time." : "Review the changes and recorded checks before accepting this work."}</p><div class="page-actions">${button("Review changes", "tab", 'data-tab="changes"')}${button("Read output", "tab", 'data-tab="output"')}${!live(run) ? button("Use task again", "reuse") : ""}${!live(run) ? button("Save reviewed outcome", "outcome") : ""}</div>`;
    if (this.tab === "changes")
      content = `<div class="page-actions">${button("Refresh changes", "diff")}${button("Open files", "workspace", 'data-pane="files"')}${button("Open terminal", "workspace", 'data-pane="terminal"')}</div>${this.diffMeta?.stale ? '<p class="inline-notice">The checkout changed since verification. Run checks again before relying on the earlier result.</p>' : ""}${this.diffMeta?.truncated ? '<p class="help">This diff is truncated. Open the task terminal to review the complete changes.</p>' : ""}<pre class="helm-output helm-diff" tabindex="0" aria-label="Task changes">${esc(this.diff || "Choose Refresh changes to inspect the task checkout.")}</pre>`;
    if (this.tab === "output")
      content = `<pre class="helm-output" tabindex="0" aria-label="Agent output">${esc(run.output || (live(run) ? "Waiting for output…" : "No output was recorded."))}</pre>`;
    if (this.tab === "checks")
      content = `<p class="help">${run.verificationRevision ? `Checks recorded at ${esc(run.verificationRevision)}. Passing checks does not merge changes.` : "No verified revision yet."}</p>${(run.checks ?? []).map((check) => `<article class="helm-check-result"><strong>${check.passed ? "Passed" : check.finishedAt ? "Failed" : "Not run"} · ${esc(check.command)} ${esc(check.args.join(" "))}</strong><span class="help">${check.exitCode !== undefined ? `Exit ${esc(check.exitCode)}` : ""}${check.revision ? ` · ${esc(check.revision.slice(0, 12))}` : ""}</span><details><summary>Command output</summary><pre class="helm-output">${esc(check.output || "No output recorded.")}</pre></details></article>`).join("") || '<p class="help">No checks recorded for this task.</p>'}<form data-helm-form="verify">${this.checkForm()}<button class="primary-button" type="submit" ${this.busy || live(run) ? "disabled" : ""}>Run checks</button></form>`;
    if (this.tab === "context")
      content = `<p class="help">This is the context copied into this task when it started. It stays unchanged when project notes are edited.</p><pre class="helm-output" tabindex="0" aria-label="Task context snapshot">${esc(run.contextSnapshot || "No saved context was attached.")}</pre>`;

    return `<div class="helm-detail"><div class="page-heading"><h1 title="${esc(run.title)}">${esc(run.title)}</h1><p><span class="helm-status helm-status--${esc(run.status)}">${esc(status(run.status))}</span> · ${new Date(run.updatedAt).toLocaleString()}</p></div><div class="page-actions">${live(run) ? button("Stop task", "cancel", 'class="danger-button"') : ""}${run.sessionId ? button("Open conversation", "session") : ""}</div><nav class="helm-tabs" aria-label="Task details">${sections.map(([id, label]) => button(label, "tab", `data-tab="${id}" aria-pressed="${this.tab === id}" class="${this.tab === id ? "active" : ""}"`)).join("")}</nav><section class="helm-detail-content">${content}</section></div>`;
  }
  private contextPanel() {
    const note = this.noteEditor;
    return `<details class="helm-project-context" ${note ? "open" : ""}><summary>Project context <span class="muted">${this.notes.length} saved</span></summary><p class="help">Keep decisions, constraints, and reviewed outcomes with this project.</p>${button("Add context", "note-new")}${
      note
        ? `<form data-helm-form="note"><label class="field">Title<input id="helm-note-title" data-helm-note="title" value="${esc(note.title ?? "")}" maxlength="160" required></label><label class="field">Content<textarea id="helm-note-body" data-helm-note="body" rows="4" required>${esc(note.body ?? "")}</textarea></label><div class="helm-fields"><label class="field">Kind<select id="helm-note-kind" data-helm-note="kind">${["decision", "constraint", "note", "outcome"].map((kind) => `<option ${note.kind === kind ? "selected" : ""}>${kind}</option>`).join("")}</select></label><label class="field">Parent<select id="helm-note-parent" data-helm-note="parentId"><option value="">Top level</option>${this.notes
            .filter((n) => n.id !== note.id)
            .map(
              (n) =>
                `<option value="${esc(n.id)}" ${note.parentId === n.id ? "selected" : ""}>${esc(n.title)}</option>`,
            )
            .join(
              "",
            )}</select></label></div><div class="page-actions"><button class="primary-button" type="submit" ${this.busy ? "disabled" : ""}>Save context</button>${button("Cancel", "note-cancel")}</div></form>`
        : ""
    }<div class="helm-context-tree">${this.notes.map((n) => `<article class="helm-note" ${n.parentId ? 'data-nested="true"' : ""}><div><strong>${esc(n.title)}</strong><small>${esc(n.kind)}${n.parentId ? ` · under ${esc(this.notes.find((p) => p.id === n.parentId)?.title ?? "unavailable parent")}` : ""}</small></div><p>${esc(n.body)}</p><div class="page-actions">${button("Edit", "note-edit", `data-id="${esc(n.id)}"`)}${button("Delete", "note-delete", `data-id="${esc(n.id)}"`)}</div></article>`).join("")}</div></details>`;
  }
  private codePanel() {
    return `<section class="helm-code-panel ${this.codeReady ? "is-ready" : ""}"><div class="helm-code-heading"><div><h1>${this.codeReady ? "Coding workspace" : "Code with Helm"}</h1>${this.codeReady ? "" : '<p class="help">The OpenCode coding workspace, integrated into Hades.</p>'}</div>${this.codeReady ? `<div class="page-actions"><span class="help" title="${esc(this.codeInfo?.revision)}">OpenCode ${esc(this.codeInfo?.version)}</span>${button(this.busy ? "Closing workspace…" : "Close coding workspace", "code-close", `title="Stop this workspace’s local coding server" ${this.busy ? "disabled" : ""}`)}</div>` : button(this.busy ? "Opening workspace…" : "Open coding workspace", "code-open", `class="primary-button" ${this.busy ? "disabled" : ""}`)}</div>${this.codeReady ? '<div class="helm-code-viewport"></div>' : '<p class="help">Open this project to work with sessions, agents, code changes and the terminal. Your saved tasks and project context are in Tasks &amp; context.</p>'}</section>`;
  }
  private render() {
    if (!this.host) return;
    const expanded = [
      ...this.host.querySelectorAll<HTMLDetailsElement>("details"),
    ].map((el) => el.open);
    const focus = captureFocus(this.host),
      scroll = this.host.scrollTop;
    this.host.innerHTML = `<div class="helm-page"><header class="helm-project-bar"><div><strong>Helm</strong><span class="muted">Coding in Hades</span></div><label class="helm-project-select">Project<select id="helm-project" data-helm-field="project" aria-label="Helm project"><option value="">Choose a project</option>${this.context?.projects.map((root) => `<option value="${esc(root)}" ${root === this.context?.root ? "selected" : ""}>${esc(root.split("/").filter(Boolean).pop() ?? root)}</option>`).join("")}</select></label>${button("Open folder…", "project")}</header><nav class="helm-destinations" aria-label="Helm workspace">${button("Code", "destination-code", `aria-pressed="${this.destination === "code"}"`)}${button("Tasks &amp; context", "destination-tasks", `aria-pressed="${this.destination === "tasks"}"`)}</nav>${this.error ? `<p class="inline-notice" role="alert">${esc(this.error)}</p>` : ""}${this.notice ? `<p role="status" class="helm-notice">${esc(this.notice)}</p>` : ""}${!this.context?.root ? '<div class="page-heading"><h1>Choose a project</h1><p>Open a repository to start a coding task with Helm.</p></div>' : this.destination === "code" ? this.codePanel() : `<div class="helm-layout"><aside class="helm-task-list" aria-label="Coding tasks">${button("New coding task", "new", 'class="primary-button"')}<div class="helm-task-list-heading"><strong>Tasks</strong>${this.loading ? '<span role="status" class="help">Updating…</span>' : ""}</div>${this.runs.map((run) => button(`<strong>${esc(run.title)}</strong><small>${esc(status(run.status))} · ${esc(agentName(run.agent))}</small>`, "select", `data-id="${esc(run.id)}" class="helm-task ${this.selected?.id === run.id && !this.creating ? "active" : ""}" aria-pressed="${this.selected?.id === run.id && !this.creating}"`)).join("") || '<p class="help">Your coding tasks stay here, including interrupted work.</p>'}</aside><main class="helm-content">${this.creating || !this.selected ? this.form() : this.detail()}${this.contextPanel()}</main></div>`}</div>`;
    this.code.attach(this.host.querySelector<HTMLElement>(".helm-code-viewport") ?? undefined);
    this.host
      .querySelectorAll<HTMLDetailsElement>("details")
      .forEach((el, index) => {
        if (
          expanded[index] !== undefined &&
          !(this.noteEditor && el.classList.contains("helm-project-context"))
        )
          el.open = expanded[index];
      });
    this.host.scrollTop = scroll;
    restoreFocus(this.host, focus);
    this.host.onclick = (event) => {
      const target = (event.target as Element).closest<HTMLElement>(
        "[data-helm]",
      );
      if (target)
        void this.action(target.dataset.helm!, target).catch((error) => {
          this.error = message(error);
          this.render();
        });
    };
    this.host.oninput = (event) => this.input(event.target as HTMLInputElement);
    this.host.onchange = (event) => {
      const target = event.target as HTMLInputElement;
      this.input(target);
      if (target.dataset.helmField === "project")
        void this.actions.selectProject(target.value).catch((error) => {
          this.error = message(error);
          this.render();
        });
      if (target.dataset.helmField === "agent") this.render();
    };
    this.host.onsubmit = (event) => {
      const form = event.target as HTMLFormElement;
      if (!form.dataset.helmForm) return;
      event.preventDefault();
      void this.submit(form.dataset.helmForm);
    };
  }
  private input(target: HTMLInputElement) {
    const field = target.dataset.helmField;
    if (field === "prompt") this.prompt = target.value;
    if (field === "agent") {
      if (this.agent !== target.value) this.model = "";
      this.agent = target.value;
    }
    if (field === "model") this.model = target.value;
    if (field === "maxMinutes") this.maxMinutes = target.value;
    if (field === "command") this.command = target.value;
    if (field === "args") this.args = target.value;
    if (field === "useCheck") this.useCheck = target.checked;
    if (target.dataset.helmContext) {
      if (target.checked) this.contextIds.add(target.dataset.helmContext);
      else this.contextIds.delete(target.dataset.helmContext);
    }
    if (target.dataset.helmNote && this.noteEditor)
      Object.assign(this.noteEditor, {
        [target.dataset.helmNote]: target.value,
      });
  }
  private async submit(kind: string) {
    await this.perform(async () => {
      const { root, profile } = this.context!;
      if (kind === "start") {
        if (
          !root ||
          !this.prompt.trim() ||
          !this.agents.find((a) => a.id === this.agent)?.installed
        )
          throw new Error(
            "Choose a project, available agent, and a task first.",
          );
        const maxMinutes = Number(this.maxMinutes);
        if (
          !Number.isInteger(maxMinutes) ||
          maxMinutes < 1 ||
          maxMinutes > 240
        )
          throw new Error("Choose a time limit from 1 to 240 minutes.");
        const run = await this.rpc("helm.start", {
          root,
          profile,
          agent: this.agent,
          prompt: this.prompt.trim(),
          model: this.model.trim() || undefined,
          maxMinutes,
          checks: this.checks(),
          contextIds: [...this.contextIds],
        });
        if (this.context?.root !== root || this.context?.profile !== profile)
          return;
        this.selected = run;
        this.creating = false;
        this.tab = "overview";
        this.prompt = "";
        await this.refresh();
      } else if (kind === "verify") {
        const checks = this.checks();
        if (!checks.length)
          throw new Error(
            "Select Run a verification command and enter the command to run.",
          );
        const id = this.selected!.id;
        const verified = await this.rpc("helm.verify", {
          id,
          profile,
          checks,
        });
        if (this.selected?.id === id && this.context?.profile === profile)
          this.selected = verified;
        this.notice = "Verification finished. Review the recorded results.";
        await this.refresh();
      } else if (kind === "note") {
        const note = this.noteEditor!;
        await this.rpc("helm.context.save", {
          root,
          ...note,
          parentId: note.parentId || undefined,
          ...(note.id ? { expectedUpdatedAt: note.updatedAt } : {}),
        });
        if (this.noteEditor === note) this.noteEditor = undefined;
        await this.refresh();
      }
    });
  }
  private async action(action: string, element: HTMLElement) {
    if (action === "docs") {
      await this.rpc("link.open", { url: element.dataset.url });
      return;
    }
    if (action === "destination-code" || action === "destination-tasks") {
      this.destination = action === "destination-code" ? "code" : "tasks";
      this.render();
      return;
    }
    if (action === "code-close") return this.perform(async () => {
      if (!this.context?.root) return;
      const { root, profile } = this.context;
      await this.rpc("helm.code.close", { root, profile });
      if (this.codeScope !== `${root}\n${profile}`) return;
      this.code.dispose();
      this.codeScope = "";
      this.codeReady = false;
      this.codeInfo = undefined;
      this.notice = "Coding workspace closed. Its local coding server has stopped.";
    });
    if (action === "code-open") return this.perform(async () => {
      if (!this.context?.root) throw new Error("Choose a project first.");
      const { root, profile } = this.context;
      const scope = `${root}\n${profile}`;
      const result = await this.rpc("helm.code.open", { root, profile });
      if (this.context?.root !== root || this.context?.profile !== profile) return;
      const frameUrl = new URL(result.url);
      const flags = new URLSearchParams(frameUrl.hash.slice(1));
      flags.set("helm_theme", document.documentElement.dataset.theme === "dark" ? "dark" : "light");
      frameUrl.hash = flags.toString();
      this.code.open(frameUrl.href, scope);
      this.codeScope = scope;
      this.codeReady = true;
      this.codeInfo = result;
    });
    if (action === "project") return this.actions.chooseProject();
    if (action === "new") {
      this.creating = true;
      this.error = "";
      this.render();
      return;
    }
    if (action === "note-new") {
      this.noteEditor = { kind: "note", title: "", body: "" };
      this.render();
      return;
    }
    if (action === "note-cancel") {
      this.noteEditor = undefined;
      this.render();
      return;
    }
    if (action === "note-edit") {
      this.noteEditor = {
        ...this.notes.find((n) => n.id === element.dataset.id)!,
      };
      this.render();
      return;
    }
    if (action === "tab") {
      this.tab = element.dataset.tab as typeof this.tab;
      this.render();
      if (this.tab === "changes") await this.loadDiff();
      return;
    }
    if (action === "reuse") {
      this.prompt = this.selected!.prompt;
      this.agent = this.selected!.agent;
      this.model = this.selected!.model ?? "";
      this.maxMinutes = String(this.selected!.maxMinutes);
      this.creating = true;
      this.render();
      return;
    }
    if (action === "outcome") {
      this.noteEditor = {
        kind: "outcome",
        title: `Reviewed: ${this.selected!.title}`,
        body: `Task: ${this.selected!.id}\nBranch: ${this.selected!.branch}\n\nReview outcome: `,
      };
      this.render();
      return;
    }
    if (action === "workspace")
      return this.actions.openWorkspace(
        this.selected!.workspace,
        element.dataset.pane as "files" | "git" | "terminal",
      );
    if (action === "session")
      return this.actions.openSession(this.selected!.sessionId!);
    if (action === "parent")
      return this.actions.openSession(this.selected!.parentSession!);
    if (action === "diff") return this.loadDiff();
    await this.perform(async () => {
      if (action === "refresh") await this.refresh(true);
      if (action === "select") {
        this.selected = await this.rpc("helm.get", {
          id: element.dataset.id,
          profile: this.context!.profile,
        });
        this.creating = false;
        this.tab = "overview";
        this.diff = "";
        this.diffMeta = undefined;
        const check = this.selected?.requestedChecks?.[0];
        this.useCheck = !!check;
        if (check) {
          this.command = check.command;
          this.args = JSON.stringify(check.args);
        }
      }
      if (action === "cancel") {
        await this.rpc("helm.cancel", {
          id: this.selected!.id,
          profile: this.context!.profile,
        });
        await this.refresh();
      }
      if (action === "note-delete") {
        await this.rpc("helm.context.delete", {
          root: this.context!.root,
          id: element.dataset.id,
        });
        this.contextIds.delete(element.dataset.id!);
        await this.refresh();
      }
    });
  }
  private async loadDiff() {
    await this.perform(async () => {
      const result = await this.rpc("helm.diff", {
        id: this.selected!.id,
        profile: this.context!.profile,
      });
      this.diffMeta = result;
      this.diff = result.text || "No changes in the task checkout.";
    });
  }
}
function message(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const field of [record.message, record.error])
      if (typeof field === "string") return field;
  }
  return "This operation could not finish. Check the agent setup and try again.";
}
