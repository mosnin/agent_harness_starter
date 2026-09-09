import { captureFocus, restoreFocus } from "./focus";
import "./helm.css";
import { HelmCodeFrame } from "./helm-code";

type Rpc = (method: string, args?: Record<string, unknown>) => Promise<any>;
type Context = { root: string; profile: string; profileName?: string; projects: string[] };
import type {
  HelmAgent as Agent,
  HelmRun as Run,
  HelmDiff,
} from "../core/helm-types";
import type { HelmPreviewReceipt } from "../core/helm-preview";
import type { HelmSourceCheckReceipt } from "../core/helm-source-checks";
import type { HelmIntegrationReview } from "../core/helm-integration";
import type { HelmHandoff as BrowserDraft } from "../core/helm-handoff";
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
const runStatus = (run: Run) =>
  run.status === "needs_review" && run.checks?.some((check) => check.finishedAt && !check.passed)
    ? "Checks failed · review needed"
    : status(run.status);
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
  private handoffs: BrowserDraft[] = [];
  private handoffId?: string;
  private handoffTitle?: string;
  private previews: HelmPreviewReceipt[] = [];
  private previewsLoaded = false;
  private previewUrl = "";
  private previewRequests = new Map<string, string>();
  private sourceCheck?: HelmSourceCheckReceipt;
  private sourceSeconds = "300";
  private integration?: HelmIntegrationReview;
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
      if (this.handoffId && this.handoffs.find((draft) => draft.id === this.handoffId)?.status !== "draft") {
        this.handoffId = undefined;
        this.handoffTitle = undefined;
      }
      this.handoffs = [];
      this.selected = undefined;
      this.runs = [];
      this.notes = [];
      this.contextIds.clear();
      this.noteEditor = undefined;
      this.diff = "";
      this.diffMeta = undefined;
      this.integration = undefined;
      this.sourceCheck = undefined;
      this.previews = [];
      this.previewsLoaded = false;
      this.previewUrl = "";
      this.error = "";
      this.notice = "";
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
      const [agents, runs, notes, selected, reviews, handoffs] = await Promise.all([
        this.rpc("helm.agents", refreshAgents ? { refresh: true } : {}),
        root ? this.rpc("helm.list", { root, profile }) : Promise.resolve([]),
        root ? this.rpc("helm.context.list", { root }) : Promise.resolve([]),
        this.selected
          ? this.rpc("helm.get", { id: this.selected.id, profile })
          : Promise.resolve(undefined),
        this.selected && this.selected.status !== "starting" ? this.rpc("helm.integration.list", { id: this.selected.id, profile }) : Promise.resolve([]),
        this.rpc("helm.handoff.list", { profile }),
      ]);
      if (generation !== this.generation) return;
      this.handoffs = Array.isArray(handoffs) ? handoffs : [];
      this.agents = agents;
      this.runs = runs;
      this.notes = notes;
      if (selected) {
        this.selected = selected;
        this.integration = this.reviewFor(selected, reviews);
        await this.loadSourceChecks();
        if (generation !== this.generation) return;
      }
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
  private handoffInbox() {
    if (!this.handoffs.length) return "";
    return `<section class="helm-handoffs" aria-label="Browser coding drafts"><h2>From Hades Browser</h2><p class="help">Review the notebook, choose the destination project and Hades profile, then select a coding agent and start explicitly. Receiving a draft never starts an agent.</p>${this.handoffs.map((draft) => `<article class="helm-note"><strong>${esc(draft.notebook.title)}</strong><p>${esc(draft.prompt)}</p><details><summary>Notebook and sources · ${esc(draft.notebook.sources.length)}</summary><pre class="helm-output" tabindex="0" aria-label="Browser notebook">${esc(draft.notebook.body)}</pre>${draft.notebook.sources.map((source) => `<p class="help">${esc(source.title)} · ${esc(source.url)} · Retrieved ${esc(new Date(source.retrievedAt).toLocaleString())}${button("Open source", "docs", `data-url="${esc(source.url)}"`)}</p>`).join("")}</details>${draft.status === "draft" ? button(this.handoffId === draft.id ? "Draft selected" : "Use draft", "handoff-use", `data-id="${esc(draft.id)}"`) : `<p role="status" class="help">${draft.status === "started" ? `Task started${draft.runId ? ` · ${esc(draft.runId)}` : ""}. Open its destination project${draft.root ? ` ${esc(draft.root)}` : ""} to review it in Tasks.` : "Dispatch is pending or uncertain. Inspect existing tasks before taking further action; this draft will not be started again."}</p>${draft.status === "started" && draft.runId ? button("Open linked task", "select", `data-id="${esc(draft.runId)}"`) : ""}`}</article>`).join("")}</section>`;
  }
  private readiness(agent?: Agent) {
    if (!agent) return "Choose a coding agent.";
    const check = agent.readiness;
    if (!check) return agent.installed
      ? `${agentName(agent.id)} is installed${agent.version ? ` · ${agent.version}` : ""}. ${agent.id === "hades" ? "Uses your selected Hades profile." : "Account and model access are not yet verified."}`
      : `${agentName(agent.id)} is not installed. Set it up, then refresh agents.`;
    const probe = { available: agent.id === "hades" ? "Executor available" : "CLI responds", missing: "Not installed", failed: "Setup check failed", "timed-out": "Setup check timed out" }[check.probe];
    const auth = { unknown: "Login unverified", "signed-in": "Local login present", "signed-out": "Sign-in needed" }[check.auth];
    return `${agentName(agent.id)} · ${probe} · ${auth}. Model access unverified. ${check.nextStep}`;
  }
  private form() {
    const selected = this.agents.find((a) => a.id === this.agent);
    const handoffBlocked = !!this.handoffId && this.handoffs.find((draft) => draft.id === this.handoffId)?.status !== "draft";
    return `<form data-helm-form="start" class="helm-start"><div class="page-heading"><h1>Build with Helm</h1><p>Give a coding agent a focused task. Review its changes and checks in one place.</p></div>
      ${this.handoffId ? `<p class="inline-notice">Browser draft: ${esc(this.handoffTitle)}. Destination: ${esc(this.context?.root || "Choose a project")} · Hades profile: ${esc(this.context?.profileName || this.context?.profile)}. ${handoffBlocked ? "This draft was already claimed or its status is unavailable. Inspect its recorded task; do not restart it." : "Notebook evidence is attached when you start this task."}</p>` : ""}<label class="field">What should change?<textarea id="helm-prompt" data-helm-field="prompt" rows="4" maxlength="20000" placeholder="Fix the failing checkout test and explain the change." required>${esc(this.prompt)}</textarea></label>
      <div class="helm-fields"><label class="field">Coding agent<select id="helm-agent" data-helm-field="agent">${this.agents.map((a) => `<option value="${esc(a.id)}" ${a.id === this.agent ? "selected" : ""}>${esc(agentName(a.id))}${a.installed ? "" : " · not installed"}</option>`).join("")}</select></label><label class="field">Time limit · minutes<input id="helm-minutes" data-helm-field="maxMinutes" type="number" min="1" max="240" value="${esc(this.maxMinutes)}" required></label></div>
      <div class="helm-readiness" role="status"><span>${esc(this.readiness(selected))}</span>${button(this.loading ? "Checking agents…" : "Refresh agents", "refresh", `aria-disabled="${this.loading || this.busy}"`)}${selected?.readiness ? `<small>Last checked ${esc(new Date(selected.readiness.checkedAt).toLocaleString())}. No coding task was sent.</small>` : ""}</div>
      <details class="helm-agent-setup"><summary>Set up ${esc(agentName(this.agent))}</summary><p class="help">${this.agent === "hades" ? "Hades uses the profile selected in the lower-left corner. Manage its provider and model in Hades Settings." : this.agent === "codex" ? "Sign in with ChatGPT in Hades Settings, then refresh agents. Hades uses its own Codex account storage; signing in to a standalone terminal installation may use a different account." : `Install ${esc(agentName(this.agent))} if needed, then open it in a terminal with ${esc(this.agent)} and complete its sign-in flow. Return here and refresh agents. Availability does not confirm account or model access.`}</p><div class="page-actions">${this.agent !== "hades" ? button("Open setup documentation", "docs", `data-url="${esc(AGENT_DOCS[this.agent] ?? "")}"`) : ""}${button("Refresh agents", "refresh")}</div></details>
      <p class="help">Helm works in a separate checkout from the latest local commit. These local agents can run commands with your account’s permissions. Uncommitted changes in your current folder are not included.</p>
      <details class="helm-advanced"><summary>Model, checks and context</summary><label class="field">Model for this task · optional<input type="text" autocorrect="off" autocapitalize="off" autocomplete="off" spellcheck="false" id="helm-model" data-helm-field="model" value="${esc(this.model)}" placeholder="Use the agent’s configured model" maxlength="200"></label><p class="help">Use a model supported by this agent and account. This overrides only this task, not your global configuration.</p>${this.checkForm()}<fieldset class="helm-context-picker"><legend>Attach saved project context</legend>${this.notes.length ? this.notes.map((note) => `<label><input type="checkbox" data-helm-context="${esc(note.id)}" ${this.contextIds.has(note.id) ? "checked" : ""}>${esc(note.title)} <span class="muted">${esc(note.kind)}</span></label>`).join("") : '<p class="help">No saved context yet. Add a decision or constraint in Project context.</p>'}</fieldset><p class="help">Selected context is copied into this task when it starts. Later edits do not change a running task.</p></details>
      <div class="page-actions"><button class="primary-button" type="submit" ${this.busy || this.loading || !this.context?.root || !selected?.installed || handoffBlocked ? "disabled" : ""}>${this.busy ? "Please wait…" : "Start coding task"}</button><span class="help">Changes remain local for your review.</span></div></form>`;
  }
  private checkForm(destination = "task checkout") {
    return `<label class="helm-check"><input type="checkbox" id="helm-use-check" data-helm-field="useCheck" ${this.useCheck ? "checked" : ""}>Run a verification command</label><div class="helm-fields"><label class="field">Executable<input type="text" autocorrect="off" autocapitalize="off" autocomplete="off" spellcheck="false" id="helm-check-command" data-helm-field="command" value="${esc(this.command)}" placeholder="npm"></label><label class="field">Arguments · JSON array<input type="text" autocorrect="off" autocapitalize="off" autocomplete="off" spellcheck="false" id="helm-check-args" data-helm-field="args" value="${esc(this.args)}" placeholder='["test"]'></label></div><p class="help">Commands run directly in the ${esc(destination)}. Shell pipelines and redirects are not used.</p>`;
  }
  private reviewFor(run: Run, reviews: unknown): HelmIntegrationReview | undefined {
    if (!Array.isArray(reviews)) return undefined;
    const scoped = reviews.filter((review: HelmIntegrationReview) => review.runId === run.id && review.root === run.root);
    return scoped.find((review: HelmIntegrationReview) => review.status === "applying" || review.status === "unknown") ?? scoped[0];
  }
  private async loadSourceChecks() {
    const review = this.integration;
    this.sourceCheck = undefined;
    if (!review || review.status !== "applied") return;
    const { root, profile } = this.context!;
    const rows = await this.rpc("helm.source.list", { id: review.runId, reviewId: review.id, profile });
    if (this.integration?.id !== review.id || this.context?.root !== root || this.context?.profile !== profile) return;
    this.sourceCheck = Array.isArray(rows) ? rows.find((row: HelmSourceCheckReceipt) => row.reviewId === review.id && row.runId === review.runId && row.root === root) : undefined;
    await this.loadPreviews();
  }
  private async loadPreviews() {
    const run = this.selected;
    this.previewsLoaded = false;
    if (!run?.handoffId) { this.previews = []; return; }
    const { root, profile } = this.context!;
    const rows = await this.rpc("helm.preview.list", { id: run.id, profile });
    if (this.selected?.id !== run.id || this.context?.root !== root || this.context?.profile !== profile) return;
    this.previews = Array.isArray(rows) ? rows.filter((row: HelmPreviewReceipt) => row.runId === run.id && row.root === root) : [];
    this.previewsLoaded = true;
    if (!this.previewUrl) this.previewUrl = this.previews.find((row) => row.sourceCheckId === this.sourceCheck?.id)?.url ?? "";
  }
  private previewPanel() {
    if (!this.selected?.handoffId) return "";
    return `<section aria-label="Local preview in Hades Browser"><h3>Preview in Hades Browser</h3><p class="help">Enter the URL of a local server you have already started. Helm opens a tab in the original Browser workspace; it does not start a server or verify page behavior.</p>${this.previews.map((receipt) => `<p class="inline-notice">${esc(receipt.url)} · ${receipt.status === "opened" ? "Tab opened; inspect the page to verify behavior." : receipt.status === "failed" ? "Browser refused the preview. Review the recorded error." : "Opening outcome unconfirmed. Inspect Hades Browser before another action; this request will not be replayed."}${receipt.error ? ` ${esc(receipt.error)}` : ""}</p>`).join("")}${button("Refresh preview status", "preview-refresh")}${this.sourceCheck?.status === "passed" ? `<form data-helm-form="preview"><label class="field">Local preview URL<input id="helm-preview-url" data-helm-field="previewUrl" type="url" value="${esc(this.previewUrl)}" placeholder="http://localhost:3000" maxlength="4000" autocorrect="off" autocapitalize="off" spellcheck="false" required></label><button type="submit" class="primary-button" ${this.busy || !this.previewsLoaded ? "disabled" : ""}>Open in Hades Browser</button></form>` : '<p class="help">Pass fresh source checks before opening a preview.</p>'}</section>`;
  }
  private sourceChecksPanel() {
    const receipt = this.sourceCheck;
    const running = receipt?.status === "running";
    const label = receipt ? { running: "Source checks running", passed: "Source checks passed", failed: "Source checks failed", interrupted: "Source checks interrupted · not replayed", cancelled: "Source checks stopped", stale: "Source changed · fresh checks needed" }[receipt.status] : "Source not checked yet";
    return `<section class="helm-source-checks" aria-label="Source project verification"><h3>Check the source project</h3><p role="status">${esc(label)}</p><p class="help">These commands run in ${esc(this.context?.root)} with your local account permissions. They verify the applied source separately from the isolated task.</p>${receipt?.error ? `<p class="inline-notice">${esc(receipt.error)}</p>` : ""}${receipt ? `<p class="help">Receipt ${esc(receipt.id)} · Limit ${esc(receipt.maxSeconds)} seconds${receipt.after ? ` · Source fingerprint ${esc(receipt.after)}` : ""}</p>${receipt.checks.map((check) => `<p class="help">Command: ${esc(check.command)} ${esc(JSON.stringify(check.args))}</p>`).join("")}${receipt.results.map((result) => `<details><summary>${esc(result.command)} ${esc(result.args.join(" "))} · Exit ${esc(result.exitCode ?? "unavailable")}</summary><pre class="helm-output" tabindex="0" aria-label="Source check output">${esc(result.output)}</pre>${result.truncated ? '<p class="help">Output truncated.</p>' : ""}${result.error ? `<p class="help">${esc(result.error)}</p>` : ""}</details>`).join("")}${button("Refresh source results", "source-refresh")}` : ""}${running ? button("Stop source checks", "source-cancel", this.busy ? "disabled" : "") : `<form data-helm-form="source-checks">${this.checkForm("source project")}<label class="field">Source check time limit · seconds<input id="helm-source-seconds" data-helm-field="sourceSeconds" type="number" min="1" max="300" value="${esc(this.sourceSeconds)}" required></label><button type="submit" class="primary-button" ${this.busy ? "disabled" : ""}>Run source checks</button></form>`}${this.previewPanel()}</section>`;
  }
  private integrationPanel() {
    const review = this.integration;
    if (!review || review.runId !== this.selected?.id || review.root !== this.context?.root) return "";
    return `<section class="helm-integration" aria-label="Review changes for source project"><h2>Review for source project</h2><p class="help">Destination: ${esc(review.root)}. These changes modify the source folder. The source needs new checks after applying; task checks cover only the isolated checkout.</p><p class="help">Source snapshot: ${esc(review.sourceRevision)} · Task revision: ${esc(review.revision)}</p><pre class="helm-output" id="helm-integration-patch" tabindex="0" aria-label="Full patch to apply">${esc(review.patch)}</pre>${review.status === "prepared" ? button("Apply reviewed changes", "integration-apply", `class="primary-button" ${this.busy ? "disabled" : ""}`) : `<p role="status" class="inline-notice">${review.status === "applied" ? "Applied to source. Run checks in the source project before relying on the result." : "Application outcome is uncertain. Inspect the source and check the saved review status before taking further action."}</p>${button("Refresh application status", "integration-status")}`}${button("Open source terminal", "source-terminal")}${review.status === "applied" ? this.sourceChecksPanel() : ""}</section>`;
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
      content = `<p class="helm-objective">${esc(run.prompt)}</p>${run.error ? `<p class="inline-notice" role="alert">${esc(run.error)}</p>` : ""}<dl class="helm-facts"><div><dt>Agent</dt><dd>${esc(agentName(run.agent))}</dd></div><div><dt>Requested model</dt><dd>${esc(run.model || "Agent configuration · actual model not reported")}</dd></div><div><dt>Time limit</dt><dd>${esc(run.maxMinutes)} minutes</dd></div><div><dt>Branch</dt><dd>${esc(run.branch || "Preparing checkout")}</dd></div><div><dt>Starting revision</dt><dd>${esc(run.baseSha?.slice(0, 12) || "Not recorded")}</dd></div><div><dt>Source project</dt><dd>${esc(run.root)}</dd></div><div><dt>Task checkout</dt><dd>${esc(run.workspace || "Preparing checkout")}</dd></div>${run.owner ? `<div><dt>Owner</dt><dd>${esc(run.owner)}</dd></div>` : ""}${run.parentSession ? `<div><dt>Delegated from</dt><dd>${esc(run.parentSession)} ${button("Open parent conversation", "parent")}</dd></div>` : ""}</dl>${run.sourceDirty ? '<p class="inline-notice">This task started from the recorded commit. Uncommitted changes in the original project were excluded.</p>' : ""}${run.sourceDirty || run.exclusions.length ? `<details><summary>Preparation notes</summary>${run.exclusions.length ? `<ul>${run.exclusions.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>` : '<p class="help">Uncommitted project changes were excluded from the task checkout.</p>'}</details>` : ""}<p class="help">${run.status === "interrupted" ? "This task was interrupted and has not been restarted. Review its changes and output before deciding whether to create another task." : run.status === "cancelled" ? "This task was stopped. Its checkout remains available for review; starting another task is a separate action." : run.status === "verified" ? "The recorded checks passed at the recorded revision. Review the diff before merging." : live(run) ? "Output updates here while the agent works. You can stop the task at any time." : "Review the changes and recorded checks before accepting this work."}</p><div class="page-actions">${button("Review changes", "tab", 'data-tab="changes"')}${button("Read output", "tab", 'data-tab="output"')}${!live(run) ? button("Use task again", "reuse") : ""}${!live(run) ? button("Save reviewed outcome", "outcome") : ""}</div>`;
    if (this.tab === "changes")
      content = `<div class="page-actions">${button("Refresh changes", "diff")}${run.status === "verified" && !["applying", "unknown"].includes(this.integration?.status ?? "") ? button("Review for source project", "integration-prepare", this.busy ? "disabled" : "") : `<span class="help">${["applying", "unknown"].includes(this.integration?.status ?? "") ? "Inspect the source and reconcile the saved application status before preparing another review." : "Run passing checks on the current task changes before applying them to the source."}</span>`}${button("Open files", "workspace", 'data-pane="files"')}${button("Open terminal", "workspace", 'data-pane="terminal"')}</div>${this.diffMeta?.stale ? '<p class="inline-notice">The checkout changed since verification. Run checks again before relying on the earlier result.</p>' : ""}${this.diffMeta?.truncated ? '<p class="help">This diff is truncated. Open the task terminal to review the complete changes.</p>' : ""}<pre class="helm-output helm-diff" tabindex="0" aria-label="Task changes">${esc(this.diff || "Choose Refresh changes to inspect the task checkout.")}</pre>${this.integrationPanel()}`;
    if (this.tab === "output")
      content = `<pre class="helm-output" tabindex="0" aria-label="Agent output">${esc(run.output || (live(run) ? "Waiting for output…" : "No output was recorded."))}</pre>${run.outputTruncated ? '<p class="inline-notice">Only the retained output is shown; earlier output was truncated.</p>' : ""}`;
    if (this.tab === "checks")
      content = `<p class="help">${run.verificationRevision ? `Checks recorded at ${esc(run.verificationRevision)}. Passing checks does not merge changes.` : "No verified revision yet."}</p>${(run.checks ?? []).map((check) => `<article class="helm-check-result"><strong>${check.passed ? "Passed" : check.finishedAt ? "Failed" : "Not run"} · ${esc(check.command)} ${esc(check.args.join(" "))}</strong><span class="help">${check.exitCode !== undefined ? `Exit ${esc(check.exitCode)}` : ""}${check.revision ? ` · ${esc(check.revision.slice(0, 12))}` : ""}</span><details><summary>Command output</summary><pre class="helm-output" tabindex="0" aria-label="Verification output">${esc(check.output || "No output recorded.")}</pre></details></article>`).join("") || '<p class="help">No checks recorded for this task.</p>'}<form data-helm-form="verify">${this.checkForm()}<button class="primary-button" type="submit" ${this.busy || live(run) ? "disabled" : ""}>Run checks</button></form>`;
    if (this.tab === "context")
      content = `<p class="help">This is the context copied into this task when it started. It stays unchanged when project notes are edited.</p><pre class="helm-output" tabindex="0" aria-label="Task context snapshot">${esc(run.contextSnapshot || "No saved context was attached.")}</pre>`;

    return `<div class="helm-detail"><div class="page-heading"><h1 title="${esc(run.title)}">${esc(run.title)}</h1><p><span class="helm-status helm-status--${esc(run.status)}">${esc(runStatus(run))}</span> · ${new Date(run.updatedAt).toLocaleString()}</p></div><div class="page-actions">${live(run) ? button("Stop task", "cancel", 'class="danger-button"') : ""}${run.sessionId ? button("Open conversation", "session") : ""}</div><nav class="helm-tabs" aria-label="Task details">${sections.map(([id, label]) => button(label, "tab", `data-tab="${id}" aria-pressed="${this.tab === id}" class="${this.tab === id ? "active" : ""}"`)).join("")}</nav><section class="helm-detail-content">${content}</section></div>`;
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
    return `<section class="helm-code-panel ${this.codeReady ? "is-ready" : ""}"><div class="helm-code-heading"><div><h1>${this.codeReady ? "Coding workspace" : "Code with Helm"}</h1>${this.codeReady ? "" : '<p class="help">The OpenCode coding workspace, integrated into Hades.</p>'}</div>${this.codeReady ? `<div class="page-actions"><span class="help" title="${esc(this.codeInfo?.revision)}">OpenCode ${esc(this.codeInfo?.version)}</span>${button(this.busy ? "Closing workspace…" : "Close coding workspace", "code-close", `title="Stop this workspace’s local coding server" ${this.busy ? "disabled" : ""}`)}</div>` : button(this.busy ? "Opening workspace…" : "Open coding workspace", "code-open", `class="primary-button" ${this.busy ? "disabled" : ""}`)}</div>${this.codeReady ? '<div class="helm-code-viewport"></div>' : '<p class="help">Code edits files directly in the selected project. Choose Tasks &amp; context for an isolated task checkout. Open this project to work with sessions, agents, code changes and the terminal. Your saved tasks and project context are in Tasks &amp; context.</p>'}</section>`;
  }
  private render() {
    if (!this.host) return;
    const expanded = new Map([...this.host.querySelectorAll<HTMLDetailsElement>("details[id]")].map((el) => [el.id, el.open]));
    // Give action and disclosure controls stable identities before focus is captured.
    const focus = captureFocus(this.host),
      scroll = this.host.scrollTop;
    this.host.innerHTML = `<div class="helm-page"><header class="helm-project-bar"><div><strong>Helm</strong><span class="muted">Coding in Hades</span></div><label class="helm-project-select">Project<select id="helm-project" data-helm-field="project" aria-label="Helm project"><option value="">Choose a project</option>${this.context?.projects.map((root) => `<option value="${esc(root)}" ${root === this.context?.root ? "selected" : ""}>${esc(root.split("/").filter(Boolean).pop() ?? root)}</option>`).join("")}</select></label>${button("Open folder…", "project")}${this.context?.root ? `<p class="helm-scope help">Source: <span>${esc(this.context.root)}</span> · Hades profile: <span>${esc(this.context.profileName || this.context.profile)}</span></p>` : ""}</header><nav class="helm-destinations" aria-label="Helm workspace">${button("Code", "destination-code", `aria-pressed="${this.destination === "code"}"`)}${button("Tasks &amp; context", "destination-tasks", `aria-pressed="${this.destination === "tasks"}"`)}</nav>${this.error ? `<p class="inline-notice" role="alert">${esc(this.error)}</p>` : ""}${this.notice ? `<p role="status" class="helm-notice">${esc(this.notice)}</p>` : ""}${this.destination === "tasks" ? this.handoffInbox() : ""}${!this.context?.root ? '<div class="page-heading"><h1>Choose a project</h1><p>Open a repository to start a coding task with Helm.</p></div>' : this.destination === "code" ? this.codePanel() : `<div class="helm-layout"><aside class="helm-task-list" aria-label="Coding tasks">${button("New coding task", "new", 'class="primary-button"')}<div class="helm-task-list-heading"><strong>Tasks</strong>${this.loading ? '<span role="status" class="help">Updating…</span>' : ""}</div>${this.runs.map((run) => button(`<strong>${esc(run.title)}</strong><small>${esc(runStatus(run))} · ${esc(agentName(run.agent))}</small>`, "select", `data-id="${esc(run.id)}" class="helm-task ${this.selected?.id === run.id && !this.creating ? "active" : ""}" aria-pressed="${this.selected?.id === run.id && !this.creating}"`)).join("") || '<p class="help">Your coding tasks stay here, including interrupted work.</p>'}</aside><main class="helm-content">${this.creating || !this.selected ? this.form() : this.detail()}${this.contextPanel()}</main></div>`}</div>`;
    this.code.attach(this.host.querySelector<HTMLElement>(".helm-code-viewport") ?? undefined);
    const disclosureCounts = new Map<string, number>();
    this.host
      .querySelectorAll<HTMLDetailsElement>("details")
      .forEach((el) => {
        const label = el.querySelector("summary")?.textContent ?? "";
        const count = disclosureCounts.get(label) ?? 0;
        disclosureCounts.set(label, count + 1);
        el.id = `helm-disclosure-${encodeURIComponent(`${this.destination}:${this.creating ? "new" : this.selected?.id}:${label}:${count}`)}`;
        el.querySelector("summary")!.id = `${el.id}-summary`;
        if (expanded.has(el.id) && !(this.noteEditor && el.classList.contains("helm-project-context"))) el.open = expanded.get(el.id)!;
      });
    const actionCounts = new Map<string, number>();
    this.host.querySelectorAll<HTMLElement>("[data-helm]").forEach((el) => {
      const key = `${el.dataset.helm}-${el.dataset.id ?? el.dataset.tab ?? ""}`;
      const count = actionCounts.get(key) ?? 0;
      actionCounts.set(key, count + 1);
      el.id ||= `helm-action-${key}-${count}`;
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
    if (field === "previewUrl") this.previewUrl = target.value;
    if (field === "sourceSeconds") this.sourceSeconds = target.value;
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
        if (this.handoffId && this.handoffs.find((draft) => draft.id === this.handoffId)?.status !== "draft") throw new Error("This Browser draft is already claimed or unavailable. Inspect its recorded task before continuing.");
        const run = await this.rpc("helm.start", {
          root,
          profile,
          agent: this.agent,
          prompt: this.prompt.trim(),
          model: this.model.trim() || undefined,
          maxMinutes,
          checks: this.checks(),
          contextIds: [...this.contextIds],
          ...(this.handoffId ? { handoffId: this.handoffId, title: this.handoffTitle?.slice(0, 160) } : {}),
        }).catch(async (error) => { if (this.handoffId) await this.refresh(); throw error; });
        if (this.context?.root !== root || this.context?.profile !== profile)
          return;
        this.selected = run;
        this.creating = false;
        this.tab = "overview";
        this.prompt = "";
        this.handoffId = undefined;
        this.handoffTitle = undefined;
        await this.refresh();
      } else if (kind === "preview") {
        const run = this.selected!, source = this.sourceCheck;
        if (!run.handoffId || source?.status !== "passed" || !this.previewsLoaded) throw new Error("Load the saved preview status and pass current source checks first.");
        let url: URL;
        try { url = new URL(this.previewUrl.trim()); } catch { throw new Error("Enter a complete local URL such as http://localhost:3000."); }
        if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.port || url.username || url.password) throw new Error("Use HTTP(S) localhost, 127.0.0.1 or [::1], with an explicit port and no credentials.");
        const key = JSON.stringify([run.id, profile, source.id, url.href]);
        const retained = this.previews.find((row) => row.sourceCheckId === source.id && row.url === url.href);
        const requestId = retained?.id ?? this.previewRequests.get(key) ?? crypto.randomUUID();
        this.previewRequests.set(key, requestId);
        const receipt = await this.rpc("helm.preview.open", { id: run.id, sourceCheckId: source.id, profile, url: url.href, requestId });
        if (this.selected?.id === run.id && this.context?.root === root && this.context?.profile === profile) this.previews = [receipt, ...this.previews.filter((row) => row.id !== receipt.id)];
      } else if (kind === "source-checks") {
        const review = this.integration;
        if (!review || review.status !== "applied") throw new Error("Apply the reviewed patch before running source checks.");
        const checks = this.checks(), maxSeconds = Number(this.sourceSeconds);
        if (!checks.length) throw new Error("Select Run a verification command and review its executable and arguments first.");
        if (!Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 300) throw new Error("Choose a source check time limit from 1 to 300 seconds.");
        const receipt = await this.rpc("helm.source.start", { id: review.runId, reviewId: review.id, profile, checks, maxSeconds });
        if (this.context?.root === root && this.context?.profile === profile && this.integration?.id === review.id) this.sourceCheck = receipt;
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
        if (this.selected?.id !== id || this.context?.root !== root || this.context?.profile !== profile) return;
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
    if (action === "refresh" && (this.loading || this.busy)) return;
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
    if (action === "handoff-use") {
      if (this.busy || this.loading) return;
      const draft = this.handoffs.find((item) => item.id === element.dataset.id);
      if (!draft || draft.status !== "draft") throw new Error("This Browser draft is no longer available to start.");
      this.handoffId = draft.id;
      this.handoffTitle = draft.notebook.title;
      this.prompt = draft.prompt;
      this.creating = true;
      this.render();
      this.host?.querySelector<HTMLElement>(this.context?.root ? "#helm-prompt" : "#helm-project")?.focus();
      return;
    }
    if (action === "preview-refresh") return this.perform(async () => { await this.loadPreviews(); });
    if (action === "source-refresh") return this.perform(async () => { await this.loadSourceChecks(); });
    if (action === "source-cancel") return this.perform(async () => {
      const review = this.integration!, receipt = this.sourceCheck!, { root, profile } = this.context!;
      const result = await this.rpc("helm.source.cancel", { id: review.runId, reviewId: review.id, sourceCheckId: receipt.id, profile });
      if (this.context?.root === root && this.context?.profile === profile && this.integration?.id === review.id) this.sourceCheck = result;
    });
    if (action === "source-terminal") return this.actions.openWorkspace(this.context!.root, "terminal");
    if (action === "integration-prepare") return this.perform(async () => {
      const run = this.selected!, { root, profile } = this.context!;
      if (["applying", "unknown"].includes(this.integration?.status ?? "")) throw new Error("Inspect the source and reconcile the previous application before preparing another review.");
      this.integration = undefined;
      const review: HelmIntegrationReview = await this.rpc("helm.integration.prepare", { id: run.id, profile });
      if (this.selected?.id !== run.id || this.context?.root !== root || this.context?.profile !== profile) return;
      if (review.runId !== run.id || review.root !== root || typeof review.patch !== "string" || !review.patch) throw new Error("The review did not match this task and source project.");
      this.integration = review;
    });
    if (action === "integration-apply") {
      const review = this.integration;
      const displayed = this.host?.querySelector("#helm-integration-patch")?.textContent;
      if (!review || review.status !== "prepared" || displayed !== review.patch) throw new Error("Prepare and read the complete patch before applying changes.");
      return this.perform(async () => {
        const { root, profile } = this.context!;
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(displayed));
        const patchDigest = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        review.status = "unknown"; // Never offer automatic retry after a lost acknowledgement.
        const result = await this.rpc("helm.integration.apply", { id: review.runId, reviewId: review.id, profile, patchDigest });
        if (this.integration?.id !== review.id || this.context?.root !== root || this.context?.profile !== profile) return;
        this.integration = result;
        await this.loadSourceChecks();
      });
    }
    if (action === "integration-status") return this.perform(async () => {
      const review = this.integration!, { root, profile } = this.context!;
      const result = await this.rpc("helm.integration.get", { id: review.runId, reviewId: review.id, profile });
      if (this.integration?.id === review.id && this.context?.root === root && this.context?.profile === profile) { this.integration = result; await this.loadSourceChecks(); }
    });
    if (action === "project") return this.actions.chooseProject();
    if (action === "new") {
      this.handoffId = undefined;
      this.handoffTitle = undefined;
      this.prompt = "";
      this.creating = true;
      this.error = "";
      this.render();
      this.host?.querySelector<HTMLElement>("#helm-prompt")?.focus();
      return;
    }
    if (action === "note-new") {
      this.noteEditor = { kind: "note", title: "", body: "" };
      this.render();
      this.host?.querySelector<HTMLElement>("#helm-note-title")?.focus();
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
      this.handoffId = undefined;
      this.handoffTitle = undefined;
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
        const { root, profile } = this.context!;
        const selected = await this.rpc("helm.get", { id: element.dataset.id, profile });
        if (this.context?.root !== root || this.context?.profile !== profile) return;
        if (selected.root !== root) throw new Error("Open the linked task’s source project and Hades profile before selecting it.");
        const reviews = selected.status === "starting" ? [] : await this.rpc("helm.integration.list", { id: selected.id, profile });
        if (this.context?.root !== root || this.context?.profile !== profile) return;
        this.selected = selected;
        this.integration = this.reviewFor(selected, reviews);
        await this.loadSourceChecks();
        if (this.context?.root !== root || this.context?.profile !== profile) return;
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
      const id = this.selected!.id;
      const { root, profile } = this.context!;
      const result = await this.rpc("helm.diff", { id, profile });
      if (this.selected?.id !== id || this.context?.root !== root || this.context?.profile !== profile) return;
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
