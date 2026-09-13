import { bindChatCommands } from "./chat-command-picker";
import { ChatWorkActivity } from "./chat-work-activity";
import { actionSummary } from "./action-summary";
import "./chat-work-controls.css";
import { SpatialView } from "./spatial";
import "./spatial.css";
import { ManagementView, managementViews } from "./management";
import { WorkGoalsView } from "./work-goals";
import { ChannelsView } from "./channels";
import { ShellHooksView } from "./shell-hooks";
import { MaintenanceView } from "./maintenance";
import { BrowserView } from "./browser";
import { CredentialsView } from "./credentials";
import { CompanyOsSettingsView, EcosystemPluginsView, ecosystemPlugins } from "./ecosystem-plugins";
import { WebhooksView } from "./webhooks";
import { SlackView } from "./slack-view";
import { TeamChatView } from "./team-chat";
import { WorkspaceEditor } from "./workspace-editor";
import { captureFocus, restoreFocus, dialogFocusable } from "./focus";
import { icon } from "./icons";
/** Chat-first native workbench. No Node imports, remote scripts or browser server. */
import { providers } from "./providers";
import type { Profile } from "../core/workbench-service";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { terminalRendering } from "./terminal-rendering";
import { toolActivityCards } from "./tool-activity";
import "@xterm/xterm/css/xterm.css";
import "./workbench.css";
import "./workbench-design.css";
import "./conversation-shell.css";
import "./ecosystem-plugins.css";
import {
  shortcutDefaults,
  parseShortcuts,
  eventShortcut,
  formatShortcut,
  parseTheme,
  themeMapping,
} from "./preferences";
type Row = Record<string, any>;
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const button = (label: string, action: string, extra = "") => {
  const accessibleLabel = extra.match(/aria-label="([^"]+)"/)?.[1];
  return `<button type="button" data-action="${action}" ${/^<span class="glyph"[^]*<\/svg><\/span>$/.test(label) ? "data-icon-only" : ""} ${extra}${accessibleLabel && !extra.includes('title="') ? ` title="${accessibleLabel}"` : ""}>${label}</button>`;
};
const field = (label: string, id: string, value = "", type = "text") =>
  `<label class="field">${label}<input id="${id}" type="${type}" value="${esc(value)}" autocomplete="off"></label>`;
const tauri = () => (globalThis as any).__TAURI__;
export function mountWorkbench(root: HTMLElement) {
  let boot: Row = {
      profiles: [],
      projects: [],
      sessions: [],
      active: [],
      jobs: [],
      terminals: [],
    },
    profile: Profile,
    session: Row | undefined,
    project = "",
    view = "chat",
    pane = "",
    folder = ".",
    files: Row[] = [],
    preview: Row | undefined;
  let recorder: MediaRecorder | undefined,
    recording = false,
    recordingTimer: ReturnType<typeof setTimeout> | undefined;
  let draftImages: string[] = [];
  let draft = "",
    error = "",
    sessionError = "",
    notice = "",
    modal = "",
    modalData: Row = {},
    search = "",
    find = "",
    stream = "",
    activity: Row[] = [],
    usage: Row = {},
    pendingApproval: Row | undefined;
  let memory: Row[] = [],
    skills: Row[] = [],
    artifacts: Row[] = [],
    git: Row = {},
    selectedTerminal = "",
    terminalInput = "",
    queued: Record<string, string[]> = {},
    paused = new Set<string>(),
    promptHistory: string[] = [],
    historyIndex = 0;
  let plugins: Row[] = [];
  let ecosystemPluginId = "stored";
  let harnessItems: Row[] = [];
  let codexAccount: Row = { connected: false }, codexPending = false;
  let codexModels: string[] = [], codexModelsError = "Catalog not loaded", codexCatalogLoaded = false, codexCatalogVersion = 0;
  let room: Row | undefined,
    roomDraft = "";
  let bindings = parseShortcuts({});
  let importedTheme: ReturnType<typeof parseTheme> | undefined;
  try {
    bindings = parseShortcuts(
      JSON.parse(localStorage.getItem("hades.shortcuts") ?? "{}"),
    );
  } catch {
    /* retain usable defaults */
  }
  try {
    const saved = localStorage.getItem("hades.importedTheme");
    if (saved) importedTheme = parseTheme(saved);
  } catch {
    /* discard malformed preferences */
  }
  let localEndpoint =
    localStorage.getItem("hades.ollama") ?? "http://127.0.0.1:11434";
  let localState: Row = { models: [] },
    localError = "",
    checkpoints: Row[] = [];
  let quickEntry = localStorage.getItem("hades.quickEntry") === "true";
  let connected = false,
    sidebar = !matchMedia("(max-width: 800px)").matches,
    taskInspector = localStorage.getItem("hades.taskInspector") === "true",
    statusbar = false,
    historyOpen = false,
    codingHistory: Row[] = [],
    codingDrafts: Row[] = [],
    archived = false,
    theme = localStorage.getItem("hades.theme") ?? "dark",
    fontSize = Number(localStorage.getItem("hades.zoom") ?? 14),
    tabs: string[] = JSON.parse(localStorage.getItem("hades.tabs") ?? "[]"),
    closedTabs: string[] = [],
    unlisten: (() => void) | undefined;
  const terminalViews = new Map<
    string,
    {
      terminal: Terminal;
      fit: FitAddon;
      node: HTMLElement;
      observer: ResizeObserver;
      rendering: ReturnType<typeof terminalRendering>;
    }
  >();
  const slackView = new SlackView(rpc, (account, value) => tauri().core.invoke("hades_key", { account, value }), () => ({ root: project, profile: profile?.id ?? "", name: profile?.name ?? "your agent" }), id => { void action("session", { dataset: { id } } as unknown as HTMLElement).catch(toast); });
  const teamChat = new TeamChatView(rpc, (action, args) => tauri().core.invoke("hades_team", { action, args }), async (channel, input, requestId) => {
    if (!project) throw new Error("Open a project before asking an agent.");
    if (profile.provider !== "codex") await tauri().core.invoke("hades_key", { account: profile.id + ":" + profile.provider, value: null });
    const result = await rpc("team.ask", { channel, input, root: project, profile: profile.id, requestId });
    await refresh(); await selectSession(result.session);
  });
  const management = new ManagementView(rpc, id => { void selectSession(id).catch(toast); }, next => { void navigate(next).catch(toast); }, (name, value) => download(name, JSON.stringify(value, null, 2)));
  const spatial = new SpatialView(rpc, () => { render(); root.querySelector<HTMLElement>('[data-action="spatial-open"]')?.focus(); });
  const workGoals = new WorkGoalsView(rpc, id => { void selectSession(id).catch(toast); }, async run => {
    if (run.owner !== profile.id) throw new Error("Open the owning profile before reviewing these changes.");
    if (project !== run.root) { setProject(run.root); await newChat(run.root); }
    view = "chat"; historyOpen = false; render();
    await chatWork.reviewRun(run);
  }, () => { historyOpen = false; draft = "/team "; render(); root.querySelector<HTMLTextAreaElement>("#composer")?.focus(); });
  const browserView = new BrowserView(rpc, (account, value) => tauri().core.invoke("hades_key", { account, value }));
  const credentials = new CredentialsView(rpc, (account, value) => tauri().core.invoke("hades_key", { account, value }));
  const ecosystem = new EcosystemPluginsView(rpc, url => rpc("link.open", { url }), () => tauri().core.invoke("hades_ecosystem_unlock"));
  const companyOsSettings = new CompanyOsSettingsView(rpc);
  const webhooks = new WebhooksView(rpc, id => { void selectSession(id).catch(toast); });
  const channels = new ChannelsView(rpc, () => { void navigate("team").catch(toast); }, (account, value) => tauri().core.invoke("hades_key", { account, value }));
  const hooks = new ShellHooksView(rpc);
  const pickMaintenance = async (directory: boolean): Promise<string | undefined> => {
    const path = await tauri().dialog.open({ directory, multiple: false, title: directory ? "Choose a private backup folder" : "Choose a Hades backup" });
    return typeof path === "string" ? path : undefined;
  };
  const maintenance = new MaintenanceView(rpc, () => pickMaintenance(true), () => pickMaintenance(false));
  const webhookContext = () => ({ profile: profile.id, root: project, profiles: boot.profiles, projects: boot.projects });
  const chatWork = new ChatWorkActivity(rpc, id => { void selectSession(id).catch(toast); }, value => { draft = value; render(); root.querySelector<HTMLTextAreaElement>("#composer")?.focus(); });
  const workContext = () => ({ profile: profile.id, root: project, profiles: boot.profiles });
  const editor = new WorkspaceEditor(rpc, text => { draft += text; view = "chat"; render(); }, toast);
  const applyTheme = () => {
    document.documentElement.dataset.theme =
      theme === "system"
        ? matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : theme === "custom"
          ? (importedTheme?.base ?? "dark")
          : theme;
    for (const variable of Object.values(themeMapping))
      document.documentElement.style.removeProperty(variable);
    if (theme === "custom" && importedTheme)
      for (const [key, value] of Object.entries(importedTheme.colors))
        document.documentElement.style.setProperty(key, value);
    document.documentElement.style.fontSize = `${fontSize}px`;
  };
  applyTheme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener(
    "change",
    applyTheme,
  );
  async function rpc(method: string, args: Row = {}): Promise<any> {
    const response = await tauri().core.invoke("hades_request", {
      cmd: { kind: "desktop.request", id: crypto.randomUUID(), method, args },
    });
    if (response.error) throw new Error(response.error);
    return response.result;
  }
  async function refresh() {
    boot = await rpc("boot", { profile: profile?.id });
    connected = true;
    if (!session) {
      usage = {};
      activity = [];
      stream = "";
      pendingApproval = undefined;
    }
    profile = boot.profiles.find((p: Profile) => p.id === boot.activeProfile);
    setProject(project || boot.projects[0] || "");
    if (session) {
      const row = boot.sessions.find((s: Row) => s.id === session!.id);
      if (row) session.title = row.title;
    }
    if (managementViews.has(view)) await management.open(view, profile.id, profile.name, project);
    if (historyOpen) await workGoals.open(workContext());
    if (view === "webhooks") await webhooks.open(webhookContext());
    if (view === "browser") await browserView.open({ profile: profile.id, root: project, name: profile.name });
    if (view === "credentials") await credentials.open(profile.id);
    if (view === "ecosystem") { const loading = ecosystem.open(profile.id, ecosystemPluginId); render(); await loading; }
    if (view === "channels") await channels.open(webhookContext());
    if (view === "hooks") await hooks.open(webhookContext());
    if (view === "maintenance") await maintenance.open();
    if (view === "chat" && session) artifacts = await rpc("artifacts.list", {profile:profile.id});
    render();
  }
  const current = () => session?.id ?? "";
  const running = () => boot.active.includes(current());
  const labelProject = (p: string) => p.split("/").filter(Boolean).at(-1) ?? p;
  function toast(e: unknown) {
    notice = "";
    error = e instanceof Error ? e.message : String(e);
    render();
  }
  function rememberTabs() {
    localStorage.setItem("hades.tabs", JSON.stringify(tabs));
  }
  let sessionSelection = 0;
  async function selectSession(id: string) {
    const selection = ++sessionSelection;
    historyOpen = false; codingHistory = [];
    const meta = boot.allSessions?.find((s: Row) => s.id === id);
    if (meta && meta.profile !== profile.id) {
      profile = boot.profiles.find((p: Profile) => p.id === meta.profile);
      await refresh();
    }
    const selectedProfile = profile.id;
    const [s, outputs] = await Promise.all([
      rpc("session.get", { id, profile: selectedProfile }),
      rpc("artifacts.list", { profile: selectedProfile }),
    ]);
    if (selection !== sessionSelection || profile.id !== selectedProfile) return;
    session = s;
    artifacts = outputs;
    modal = "";
    setProject(s.root || project);
    view = "chat";
    stream = s.progress?.stream ?? "";
    activity = s.progress?.journal?.length ? s.progress.journal : s.progress?.tools ?? [];
    usage = s.progress?.usage ?? {};
    pendingApproval = s.progress?.approval;
    error = sessionError = s.progress?.error ?? (s.progress?.interrupted ? "This task was interrupted. Review its saved activity before continuing." : "");
    notice = "";
    if (!tabs.includes(id)) tabs.push(id);
    rememberTabs();
    localStorage.setItem("hades.lastSession", id);
    render();
  }
  async function newChat(rootOverride?: string) {
    historyOpen = false;
    session = await rpc("session.new", { ...(rootOverride ? {root:rootOverride} : project && !session?.managedWorkspace ? {root:project} : {}), profile: profile.id });
    if (session?.root) setProject(session.root);
    tabs.push(current());
    rememberTabs();
    localStorage.setItem("hades.lastSession", current());
    view = "chat";
    activity = [];
    stream = "";
    usage = {};
    pendingApproval = undefined;
    error = "";
    notice = "";
    await refresh();
    render();
    root.querySelector<HTMLTextAreaElement>("#composer")?.focus();
  }
  async function send(input = draft) {
    if (!input.trim()) return;
    if (!session) {
      await newChat();
      if (!session) return;
    }
    if (running()) {
      if (draftImages.length || spatial.attachments.length)
        throw new Error(
          "Wait for this turn to finish before sending image or spatial attachments.",
        );
      (queued[current()] ??= []).push(input);
      draft = "";
      render();
      return;
    }
    const sendScope = {sessionId: current(), profile: profile.id, root: project};
    const spatialIds = spatial.attachments;
    if (profile.provider !== "codex") await tauri().core.invoke("hades_key", {
      account: profile.id + ":" + profile.provider,
      value: null,
    });
    if (current() !== sendScope.sessionId || profile.id !== sendScope.profile || project !== sendScope.root) throw new Error("Conversation changed. Review your draft before sending.");
    await rpc("chat.send", {
      id: current(),
      profile: profile.id,
      root: project,
      input,
      images: draftImages,
      spatialIds,
    });
    spatial.sent(spatialIds, sendScope);
    if (current() !== sendScope.sessionId || profile.id !== sendScope.profile || project !== sendScope.root) return;
    promptHistory.push(input);
    historyIndex = promptHistory.length;
    draft = "";
    error = "";
    stream = "";
    usage = {};
    session.messages.push({
      role: "user",
      content: input,
      at: Date.now(),
      images: draftImages,
    });
    draftImages = [];
    if (!boot.active.includes(current())) boot.active.push(current());
    render();
  }
  function setProject(next: string) {
    if (project === next) return;
    project = next;
    folder = "."; files = []; preview = undefined; git = {}; pane = "";
    selectedTerminal = boot.terminals?.find((terminal: Row) => terminal.root === next)?.id ?? "";
  }
  async function loadPane(next: string) {
    pane = pane === next ? "" : next;
    const requestRoot = project, requestFolder = folder;
    if (pane === "files" && project) {
      const result = await rpc("files.list", { root: requestRoot, path: requestFolder });
      if (project !== requestRoot || folder !== requestFolder || pane !== "files") return;
      files = result;
    }
    if (pane === "git" && project) {
      const result = await rpc("git.status", { root: requestRoot });
      if (project !== requestRoot || pane !== "git") return;
      git = result;
    }
    if (pane === "terminal" && !selectedTerminal && project) {
      const t = await rpc("terminal.open", { root: project });
      boot.terminals.push(t);
      if (project !== requestRoot || pane !== "terminal") return;
      selectedTerminal = t.id;
    }
    render();
  }
  function heading(title: string, sub: string) {
    return `<div class="page-heading"><div><h1>${title}</h1><p>${sub}</p></div></div>`;
  }
  function nav(name: string, label: string) {
    return button(
      icon(name) + label,
      "nav",
      `data-view="${name}" aria-current="${view === name ? "page" : "false"}" class="nav-item ${view === name ? "selected" : ""}"`,
    );
  }
  function ecosystemNavigation(open: boolean) {
    return `<details class="sidebar-plugins" ${open ? "open" : ""}><summary id="plugins-dropdown">${icon("plugins")}<span>Plugins</span>${icon("chevron")}</summary><nav aria-label="Plugins">${ecosystemPlugins.map(plugin => button(`<span class="ecosystem-nav-mark" aria-hidden="true">${plugin.name[0]}</span>${plugin.name}`, "ecosystem-open", `data-plugin="${plugin.id}" class="nav-item ${view === "ecosystem" && ecosystemPluginId === plugin.id ? "selected" : ""}" aria-current="${view === "ecosystem" && ecosystemPluginId === plugin.id ? "page" : "false"}"`)).join("")}</nav></details>`;
  }
  let renderedModal = "";
  let modalReturnFocus: ReturnType<typeof captureFocus>;
  let renderedPane = "";
  function render() {
    const visibleError = view !== "chat" && error === sessionError ? "" : error;
    const modalKey = `${modal}:${profile?.id ?? ""}`;
    const paneKey = `${pane}:${project}:${preview?.path ?? ""}`;
    const modalChanged = renderedModal !== modalKey;
    const hadModal = !!root.querySelector(".modal");
    const savedFocus = captureFocus(root);
    if (modal && !hadModal) modalReturnFocus = savedFocus;
    const savedFields = [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      [!modalChanged ? ".modal input[id], .modal textarea[id], .modal select[id]" : "", renderedPane === paneKey ? ".inspector input[id], .inspector textarea[id]" : ""].filter(Boolean).join(",") || "[data-no-preserved-fields]",
    )].filter(el => el.type !== "file").map(el => ({ id: el.id, value: el.value, checked: (el as HTMLInputElement).checked }));
    const savedDetails = !modalChanged ? [...root.querySelectorAll<HTMLDetailsElement>(".modal details")].filter(el => !el.closest("#company-os-settings")).map(el => el.open) : [];
    const projectsOpen = root.querySelector<HTMLDetailsElement>(".sidebar-projects")?.open ?? false;
    const ecosystemOpen = root.querySelector<HTMLDetailsElement>(".sidebar-plugins")?.open ?? view === "ecosystem";
    const sidebarScroll = root.querySelector(".sidebar-content")?.scrollTop ?? 0;
    const terminalFocused = !!document.activeElement?.closest(".terminal-surface");
    const terminalWasVisible = !!root.querySelector("#terminal-host");
    renderedModal = modalKey;
    renderedPane = paneKey;
    const transcript = root.querySelector(".transcript"),
      oldScroll = transcript?.scrollTop ?? 0,
      atEnd = transcript
        ? transcript.scrollHeight -
            transcript.scrollTop -
            transcript.clientHeight <
          70
        : true;
    const visibleTabs = tabs.filter(id => boot.sessions.some((s: Row) => s.id === id));
    root.innerHTML = `<div class="workbench ${!sidebar ? "hide-sidebar" : ""} ${view === "chat" && !historyOpen && !session?.messages?.length ? "conversation-empty" : ""} ${location.search.includes("hud=1") ? "hud" : ""}">
   <aside class="sidebar" id="sidebar" aria-label="Workspace navigation"><div class="window-space" data-tauri-drag-region></div><div class="sidebar-content"><div class="brand"><img src="./assets/hades-icon.png" alt="Hades logo"><strong>Hades</strong></div>
   ${button(icon("+") + `<span class="truncate">New chat</span><kbd>${esc(formatShortcut(bindings.new))}</kbd>`, "new", 'class="new-chat"')}
   <nav class="sidebar-nav" aria-label="Main">${button(icon("activity") + "Activity", "conversation-history", 'class="nav-item"')}${ecosystemNavigation(ecosystemOpen)}<details class="sidebar-more"><summary>More</summary>${nav("workspace", "Workspace")}${nav("team", "Team chat")}${nav("jobs", "Scheduled")}${nav("agents", "Agents")}${nav("tools", "Tools & connections")}${nav("system", "System")}</details></nav>
   <details class="sidebar-projects" ${projectsOpen ? "open" : ""}><summary>Projects</summary><div class="section-label">Project folders ${button(icon("+"), "project", 'aria-label="Open project"')}</div><div class="project-list">${boot.projects.length ? boot.projects.map((p: string) => `<div class="project-row ${project === p ? "active" : ""}">${button(icon("files") + `<span class="truncate">${esc(labelProject(p))}</span>`, "project-select", `data-path="${esc(p)}" title="${esc(p)}"`)}${button(icon("close"), "project-hide", `data-path="${esc(p)}" class="hide-project" aria-label="Hide project ${esc(labelProject(p))}"`)}</div>`).join("") : `<p class="sidebar-hint">Open a project folder.</p>`}</div>
   </details><div class="section-label">${archived ? "Archived" : "Recent"} ${button(icon(archived ? "back" : "more"), "archive-view", 'aria-label="Toggle archived conversations"')}</div>
   <input id="session-search" class="search" aria-label="Search conversations" placeholder="Search conversations" value="${esc(search)}">
   <div class="session-list">${
     boot.sessions
       .filter(
         (s: Row) =>
           (!s.workGoal || s.id === current() || !!search) &&
           !!s.archived === archived &&
           (!search ||
             JSON.stringify(s).toLowerCase().includes(search.toLowerCase())),
       )
       .map((s: Row) =>
         button(
           `${s.pinned ? icon("pin") : ""}${esc(s.title || "Untitled conversation")}${boot.active.includes(s.id) ? '<span class="running-dot"></span>' : ""}`,
           "session",
           `data-id="${esc(s.id)}" class="session-row ${current() === s.id ? "selected" : ""}" title="${esc(s.preview || s.id)}"`,
         ),
       )
       .join("") ||
     '<p class="sidebar-hint">Your conversations appear here.</p>'
   }</div>
   </div><div class="sidebar-footer"><select id="profile-switch" aria-label="Agent profile">${boot.profiles.map((p: Profile) => `<option value="${p.id}" ${p.id === profile?.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>${button(icon("settings"), "settings", `class="icon-button" aria-label="Settings" title="Settings ${esc(formatShortcut(bindings.settings))}"`)}</div></aside>
   ${button("", "sidebar", 'class="sidebar-scrim" aria-label="Close sidebar" tabindex="-1"')}<main class="main"><header class="toolbar" data-tauri-drag-region>${button(icon("sidebar"), "sidebar", 'id="toggle-sidebar" class="icon-button" aria-label="Toggle sidebar" aria-controls="sidebar" aria-expanded="' + sidebar + '"')}<div class="breadcrumb">${icon(view === "ecosystem" ? "plugins" : view)}<strong>${esc(view === "chat" ? session?.title || "New conversation" : ({ helm: "Helm", browser: "Hades Browser", channels: "Channels", hooks: "Hooks", maintenance: "Maintenance", credentials: "Credentials", webhooks: "Webhooks", work: "Work", tools: "Tools & connections", sessions: "Conversations", system: "System", activity: "Activity", mcp: "MCP servers", computer: "Computer control", slack: "Slack", harness: "Harness", team: "Team chat", workspace: "Workspace", artifact: "Artifacts", memory: "Memory", skills: "Skills", jobs: "Routines", agents: "Agents", models: "Local models", rooms: "Team rooms", plugins: "Extensions", ecosystem: ecosystemPlugins.find(plugin => plugin.id === ecosystemPluginId)?.name || "Plugins" } as Row)[view])}</strong></div><div class="toolbar-actions">${["helm", "work"].includes(view) ? button("Back to conversation", "nav-chat") : ""}${boot.computerEnabled ? button("Stop computer control", "computer-stop", 'class="computer-stop"') : ""}${button(icon("search"), "palette", `class="icon-button" aria-label="Command palette" title="Command palette ${esc(formatShortcut(bindings.palette))}"`)}${view === "chat" ? button(icon("files"), "files", 'class="icon-button" aria-label="File browser"') : ""}${view === "chat" ? button(icon("git"), "git", 'class="icon-button" aria-label="Git review"') : ""}${view === "chat" ? button(icon("terminal"), "terminal", 'class="icon-button" aria-label="Terminal"') : ""}${view === "chat" ? button(icon("sidebar-right"), "task-inspector", 'class="icon-button" aria-label="Task details" aria-pressed="' + taskInspector + '"') : ""}<details class="toolbar-menu"><summary id="window-actions" class="icon-button" aria-label="Window actions" title="Window actions">${icon("more")}</summary><div>${button(icon("external") + "New window", "popout")}${button(icon("floating") + "Floating chat", "hud")}</div></details></div></header>
   ${
     view === "chat" && visibleTabs.length > 1
       ? `<div class="tabs">${tabs
           .filter((id) => boot.sessions.some((s: Row) => s.id === id))
           .map(
             (id) =>
               `<div class="tab ${id === current() ? "active" : ""}">${button(esc(boot.sessions.find((s: Row) => s.id === id)?.title || "New chat"), "session", `data-id="${id}"`)}${button(icon("close"), "tab-close", `data-id="${id}" aria-label="Close tab"`)}</div>`,
           )
           .join("")}${button(icon("+"), "new", 'aria-label="New tab"')}</div>`
       : ""
   }
   ${visibleError || notice ? `<div class="error ${visibleError ? "" : "notice"}" role="${visibleError ? "alert" : "status"}">${esc(visibleError || notice)}${button(icon("close"), "dismiss", `aria-label="${visibleError ? "Dismiss error" : "Dismiss notification"}"`)}</div>` : ""}
   <div class="body"><section class="primary">${view === "chat" ? chatHTML() : view === "workspace" ? workspaceHTML() : view === "channels" ? '<div id="channels-host"></div>' : view === "hooks" ? '<div id="hooks-host"></div>' : view === "maintenance" ? '<div id="maintenance-host"></div>' : view === "browser" ? '<div id="browser-host"></div>' : view === "credentials" ? '<div id="credentials-host"></div>' : view === "ecosystem" ? '<div id="ecosystem-host"></div>' : view === "webhooks" ? '<div id="webhooks-host"></div>' : view === "team" ? '<div id="team-chat-host"></div>' : view === "slack" ? '<div id="slack-host"></div>' : pageHTML()}</section>${pane ? paneHTML() : view === "chat" && taskInspector ? taskInspectorHTML() : ""}</div>
   ${statusbar ? `<footer class="statusbar"><span><i class="${running() ? "busy" : connected ? "connected" : ""}"></i>${running() ? "Working" : connected ? "Ready" : "Disconnected"} <span class="muted">/</span> ${esc(profile?.name || "Connecting")}</span><span>${usage.tokensIn !== undefined ? `${usage.tokensIn.toLocaleString()} in · ${usage.tokensOut.toLocaleString()} out · ${usage.costMeasured ? "~$" + usage.usd.toFixed(4) : profile?.provider === "codex" ? "subscription" : "price unavailable"}` : "Workspace files · ask before changes"} <span class="muted">${esc(formatShortcut(bindings.palette))}</span></span></footer>` : ""}</main></div>${modal ? modalHTML() : ""}`;
    for (const field of savedFields) { const input = root.querySelector<HTMLInputElement>(`#${CSS.escape(field.id)}`); if (input) { input.value = field.value; if (field.checked !== undefined) input.checked = field.checked; } }
    [...root.querySelectorAll<HTMLDetailsElement>(".modal details")].filter(el => !el.closest("#company-os-settings")).forEach((el, i) => { if (savedDetails[i] !== undefined) el.open = savedDetails[i]; });
    const savedProvider = savedFields.find(f => f.id === "settings-provider")?.value;
    if (savedProvider) { const codex = root.querySelector<HTMLElement>("#codex-connection"), api = root.querySelector<HTMLElement>("#api-connection"); if (codex) codex.hidden = savedProvider !== "codex"; if (api) api.hidden = savedProvider === "codex"; }
    bind();
    const channelsHost = root.querySelector<HTMLElement>("#channels-host");
    if (channelsHost) channels.mount(channelsHost);
    const hooksHost = root.querySelector<HTMLElement>("#hooks-host");
    if (hooksHost) hooks.mount(hooksHost);
    const maintenanceHost = root.querySelector<HTMLElement>("#maintenance-host");
    if (maintenanceHost) maintenance.mount(maintenanceHost);
    const browserHost = root.querySelector<HTMLElement>("#browser-host");
    if (browserHost) browserView.mount(browserHost);
    const credentialHost = root.querySelector<HTMLElement>("#credentials-host");
    if (credentialHost) credentials.mount(credentialHost);
    ecosystem.mount(root.querySelector<HTMLElement>("#ecosystem-host") ?? undefined);
    companyOsSettings.mount(root.querySelector<HTMLElement>("#company-os-settings") ?? undefined, profile?.id);
    const webhookHost = root.querySelector<HTMLElement>("#webhooks-host");
    if (webhookHost) webhooks.mount(webhookHost);
    spatial.setScope(view === "chat" && session ? {sessionId:current(), profile:profile.id, root:project} : undefined);
    const spatialHost = root.querySelector<HTMLElement>("#spatial-host");
    if (spatialHost) spatial.mount(spatialHost);
    chatWork.mount(root.querySelector<HTMLElement>("#chat-work-activity") ?? undefined, view === "chat" && session ? {id:current(),profile:profile.id,root:project,delegatedWork:session.delegatedWork,helmRuns:session.helmRuns,orcaIntents:session.orcaIntents} : undefined);
    const workHost = root.querySelector<HTMLElement>("#work-goals-host");
    if (workHost) workGoals.mount(workHost);
    const editorHost = root.querySelector<HTMLElement>("#workspace-editor-host");
    if (editorHost) editor.mount(editorHost, project);
    const teamHost = root.querySelector<HTMLElement>("#team-chat-host");
    if (teamHost) teamChat.mount(teamHost);
    const slackHost = root.querySelector<HTMLElement>("#slack-host");
    if (slackHost) slackView.mount(slackHost);
    const managementHost = root.querySelector<HTMLElement>("#management-host");
    if (managementHost) management.bind(managementHost);
    const sidebarContent = root.querySelector(".sidebar-content");
    if (sidebarContent) sidebarContent.scrollTop = sidebarScroll;
    root.querySelector<HTMLElement>(".workbench")!.inert = !!modal;
    if (modal && (modalChanged || !savedFocus)) {
      const dialog = root.querySelector<HTMLElement>(".modal")!;
      const candidates = dialogFocusable(dialog);
      (candidates.find(el => el.matches("input, textarea, select")) ?? candidates[0] ?? dialog).focus({ preventScroll: true });
    } else if (!modal && hadModal) {
      if (!restoreFocus(root, modalReturnFocus)) root.querySelector<HTMLElement>("#composer, #toggle-sidebar")?.focus({ preventScroll: true });
      modalReturnFocus = undefined;
    } else {
      if (!restoreFocus(root, savedFocus) && modal) {
        const dialog = root.querySelector<HTMLElement>(".modal")!;
        (dialogFocusable(dialog)[0] ?? dialog).focus({ preventScroll: true });
      }
      if (!modal && pane === "terminal" && (terminalFocused || !terminalWasVisible)) terminalViews.get(selectedTerminal)?.terminal.focus();
    }
    const t = root.querySelector(".transcript");
    if (t) t.scrollTop = atEnd ? t.scrollHeight : oldScroll;
  }
  function chatHTML() {
    const messages = session?.messages ?? [];
    const tools = toolActivityCards(activity, running());
    const hookReceipts = activity.filter(event => event.kind === "desktop.hook");
    return `${find !== "" ? `<div class="findbar"><input id="find-input" placeholder="Find in conversation" value="${esc(find === " " ? "" : find)}" aria-label="Find in conversation">${button(icon("down"), "find-next", 'aria-label="Next match"')}${button(icon("close"), "find-close", 'aria-label="Close find"')}</div>` : ""}
  <div class="transcript" role="log" aria-label="Conversation">${!messages.length ? `<div class="welcome"><img class="conversation-mark" src="./assets/hades-icon.png" alt=""><h1>What would you like to get done?</h1><p>Describe the outcome. Hades can write code, use your apps, and coordinate a team here.</p></div>` : messages.map((m: Row, i: number) => `<article id="message-${i}" class="message ${m.role}"><div class="message-label">${m.role === "user" ? "You" : `<img src="./assets/hades-icon.png" alt=""> ${esc(profile.name)}`}<time>${new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>${m.role === "assistant" ? button(icon("speaker"), "speak-message", `data-index="${i}" aria-label="Read message aloud"`) : ""}${button(icon("copy"), "copy-message", `data-index="${i}" aria-label="Copy message"`)}</div><div class="message-body">${m.images?.map((image: string) => `<img class="chat-attachment" src="${esc(image)}" alt="Attached image">`).join("") ?? ""}${formatText(m.content)}</div></article>`).join("")}
  ${running() ? `<article class="message assistant"><div class="message-label"><img src="./assets/hades-icon.png" alt="">${esc(profile.name)} <span class="working">Working<span>...</span></span></div><div class="message-body live-output">${formatText(visibleResponse(stream))}</div></article>` : ""}
  ${tools.length ? `<details class="activity" ${pendingApproval ? "open" : ""}><summary>${icon("terminal")}${tools.length} tool ${tools.length === 1 ? "call" : "calls"}</summary>${tools.map(t => `<div class="tool-activity-card"><span class="mono">${esc(t.tool)} · ${t.status}</span>${t.input !== undefined ? `<div class="help">Input</div><pre>${esc(t.input)}</pre>` : ""}${t.output !== undefined ? `<div class="help">Result</div><pre>${esc(t.output)}</pre>` : ""}</div>`).join("")}</details>` : ""}
  <div id="chat-work-activity"></div>
  ${historyOpen ? `<section class="conversation-history" aria-label="Saved activity"><header><h2>Saved activity</h2>${button("Close activity", "conversation-history")}</header><p class="help">Previous tasks and changes. New work starts in the conversation below.</p><details open><summary>Team tasks</summary><div id="work-goals-host"></div></details><details><summary>Browser and capture drafts</summary>${codingDrafts.map(item=>`<article><strong>${esc(item.notebook.title)}</strong><p>${esc(item.prompt)}</p>${item.status==="draft"?button("Use in conversation","conversation-draft",`data-id="${esc(item.id)}"`):`<p class="help">${esc(item.status)}</p>`}</article>`).join("") || '<p class="help">No drafts available.</p>'}</details><details><summary>Code changes</summary>${codingHistory.map(run => button(esc(run.title || run.prompt?.slice(0,80) || "Coding task") + " · " + esc(run.status), "conversation-review", `data-id="${esc(run.id)}"`)).join("") || '<p class="help">No coding tasks for this project.</p>'}</details></section>` : ""}
  ${hookReceipts.length ? `<details class="activity hook-activity"><summary>${icon("hooks")}${hookReceipts.length} hook ${hookReceipts.length === 1 ? "receipt" : "receipts"}</summary>${hookReceipts.map(h => `<div class="hook-receipt"><span>${esc(h.name)} · ${h.phase === "pre_tool" ? "Before" : "After"} ${esc(h.tool)} · ${esc(h.status)}</span>${h.output ? `<pre>${esc(h.output)}</pre>` : ""}${h.message ? `<p class="help">${esc(h.message)}</p>` : ""}</div>`).join("")}</details>` : ""}
  ${pendingApproval ? `<div class="approval" role="alert"><strong>Hades needs your approval</strong>${actionSummary(pendingApproval.tool,pendingApproval.input)}${button("Allow once", "approve", 'class="primary-button"')}${button("Deny", "deny")}</div>` : ""}</div>
  <div class="composer-area">${(queued[current()] ?? []).length ? `<div class="queue"><span class="eyebrow">${paused.has(current()) ? "PAUSED" : "QUEUED"} · ${queued[current()].length}</span>${queued[current()].map((q, i) => `<div><span>${esc(q.slice(0, 120))}</span>${button("Edit", "queue-edit", `data-index="${i}"`)}${button(icon("close"), "queue-delete", `data-index="${i}" aria-label="Delete queued message"`)}</div>`).join("")}${paused.has(current()) ? button("Resume queue", "queue-resume") : ""}</div>` : ""}
  <div id="spatial-host"></div><div class="attachment-tray">${draftImages.map((src, i) => `<div><img src="${esc(src)}" alt="Image attachment ${i + 1}">${button(icon("close"), "image-remove", `data-index="${i}" aria-label="Remove image"`)}</div>`).join("")}</div><div id="chat-command-options" class="chat-command-options" hidden></div><form id="composer-form" class="composer"><textarea id="composer" aria-label="Message Hades" placeholder="Message Hades, or type / for commands…" rows="2">${esc(draft)}</textarea><div class="composer-bottom"><div>${button("Point at something", "spatial-open", 'class="composer-spatial"')}${button(icon("+"), "attach", 'class="icon-button" aria-label="Attach files or images"')}<input id="attachments" type="file" multiple hidden accept="image/png,image/jpeg,image/gif,image/webp,text/*,.md,.json,.ts,.tsx,.py,.js,.csv,.html,.css,.yaml,.yml">${button(icon("files") + `<span class="truncate">${project && !session?.managedWorkspace ? esc(labelProject(project)) : "Attach project"}</span>`, "project", 'class="composer-project"')}</div><div>${button(`<span class="truncate">${esc(session?.model || profile?.model || "Choose model")}</span>` + icon("chevron"), "model", 'class="model-picker"')}${button(icon(recording ? "stop" : "microphone"), "voice-record", `class="icon-button ${recording ? "recording" : ""}" aria-label="${recording ? "Finish voice message" : "Record voice message"}" ${!["local", "openai"].includes(profile?.provider) ? 'disabled title="Choose an OpenAI API or compatible speech provider to record voice"' : ""}`)}${running() ? button(icon("stop"), "stop", 'class="send" aria-label="Stop generation"') : `<button type="submit" class="send" aria-label="Send message">${icon("up")}</button>`}</div></div></form>${!messages.length ? `<div class="outcome-shortcuts">${button("Build or fix code", "conversation-starter", 'data-command="code"')}${button("Research in the browser", "conversation-starter", 'data-command="browser"')}${button("Work with a team", "conversation-starter", 'data-command="team"')}</div>` : ""}<div class="composer-hint"><span>Type / for skills and goals <span class="muted">·</span> Return to send <span class="muted">·</span> ⇧ Return for a new line</span></div></div>`;
  }
  function formatText(content: string) {
    return esc(content)
      .replace(
        /```([^\n]*)\n([\s\S]*?)```/g,
        '<pre class="code"><span class="code-lang">$1</span><code>$2</code></pre>',
      )
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>");
  }
  function workspaceHTML() {
    return `<div class="ide"><div class="ide-tools">${button("Open project", "project")}${button("Files", "files")}${button("Changes", "git")}${button("Terminal", "terminal")}${button("Preview", "web-preview")}${button("Checkpoints", "checkpoints")}</div><div id="workspace-editor-host"></div></div>`;
  }
  function taskInspectorHTML() {
    const outputs = artifacts.filter(a => a.session === current());
    return `<aside class="task-inspector" aria-label="Task details"><div class="task-card"><section><div class="task-card-heading"><span>Outputs</span>${button(icon("+"), "nav", 'data-view="artifact" aria-label="View artifacts"')}</div>${outputs.length ? outputs.slice(0,5).map(a => button(icon("artifact") + esc(a.path || a.url), "artifact-open", `data-index="${artifacts.indexOf(a)}"`)).join("") : '<p>Files and results from this task.</p>'}${button("View all outputs", "nav", 'data-view="artifact"')}</section><section><div class="task-card-heading">Agent</div><p class="task-agent">${icon("agents")}${esc(profile?.name)}<span>${running() ? "Working" : "Idle"}</span></p>${button("Manage agents", "nav", 'data-view="agents"')}</section><section><div class="task-card-heading">Computer use</div><p>${boot.computerEnabled ? "Access enabled · input asks for approval" : "Access is off"}</p>${button(boot.computerEnabled ? "Stop computer control" : "Manage access", boot.computerEnabled ? "computer-stop" : "nav", boot.computerEnabled ? "" : 'data-view="computer"')}</section><section><div class="task-card-heading">Context</div>${button(icon("files") + esc(project ? (session?.managedWorkspace ? "Attach project" : labelProject(project)) : "Attach project"), "project")}${button(icon("memory") + "Memory", "nav", 'data-view="memory"')}</section></div></aside>`;
  }
  function toolsHTML() {
    const groups = [
      ["Agent capabilities", [["skills","Skills","Reusable instructions"],["memory","Memory","Saved context and preferences"],["computer","Computer control","Screen and accessibility tools"],["models","Local models","Manage models on this Mac"]]],
      ["Connections", [["browser","Hades Browser","Connect your agent to the companion browser"],["credentials","Credentials","Manage provider key pools"],["mcp","MCP servers","Add and inspect tool servers"],["ecosystem","Plugins","Connected accounts and agent access"],["plugins","Extensions","Install skill and tool bundles"],["webhooks","Webhooks","Wake agents from local services"],["channels","Channels","Connect Slack and manage member access"],["slack","Slack activity","Review bot tasks and replies"],["rooms","Team rooms","Collaborate across agent profiles"]]],
      ["Workspace", [["artifact","Artifacts","Files and results"],["activity","Activity","Recorded tools, approvals and usage"],["hooks","Hooks","Run scripts around approved tool calls"],["maintenance","Maintenance","Backups and local diagnostics"],["harness","Command library","Advanced Hades commands"]]],
    ] as Array<[string,Array<[string,string,string]>]>;
    return `<div class="page tools-page">${heading("Tools & connections", "Capabilities and connections for " + esc(profile?.name || "your agent") + ".")}${groups.map(([label,items]) => `<section class="tools-group"><h2>${label}</h2>${items.map(([id,name,detail]) => `<button type="button" class="tool-route" data-action="nav" data-view="${id}">${icon(id)}<span><strong>${name}</strong><small>${detail}</small></span>${icon("right")}</button>`).join("")}</section>`).join("")}</div>`;
  }
  function pageHTML() {
    if (view === "tools") return toolsHTML();
    if (managementViews.has(view)) return management.html();
    if (view === "harness") return `<div class="page">${heading("Harness", "The complete Hades command library. Commands run in the integrated terminal.")}<p class="help">Harness state is kept in this profile’s harness folder. Provider credentials come from the current profile. External services need their own setup; synthetic modes keep their labels.</p><input id="harness-search" class="search" placeholder="Find a capability" aria-label="Search harness capabilities"><div class="harness-list">${harnessItems.map(item => `<div class="record harness-item"><div><h3>${esc(item.name)}</h3><p>${esc(item.description)}</p><small>${esc(item.group)} · hades ${esc(item.command)}</small></div>${button("Open", "harness-choose", `data-command="${item.command}"`)}</div>`).join("")}</div></div>`;

    if (view === "plugins")
      return `<div class="page">${heading("Extensions", "Install skill and MCP bundles for the current agent profile.")}<div class="page-actions">${button("Install a plugin", "plugin-import", 'class="primary-button"')}${button("Example manifest", "plugin-example")}<input id="plugin-import-file" type="file" accept=".json" hidden></div><p class="help">Review every package before installing. New packages start disabled. Enabling MCP servers allows their commands to launch on the next turn; tool calls still require approval.</p>${plugins.map((x) => `<div class="record"><div><h3>${esc(x.manifest.name)} <span class="muted">${esc(x.manifest.version)}</span></h3><p>${esc(x.manifest.description)}</p><small>${x.manifest.skills.length} skills · ${x.manifest.mcp.length} MCP servers · ${x.enabled ? "Enabled" : "Disabled"}</small></div>${button("Review", "plugin-review", `data-name="${esc(x.manifest.name)}"`)}${button(x.enabled ? "Disable" : "Enable", "plugin-toggle", `data-name="${esc(x.manifest.name)}" data-enabled="${!x.enabled}"`)}${button("Remove", "plugin-remove", `data-name="${esc(x.manifest.name)}"`)}</div>`).join("") || empty("[ + ]", "No extensions installed", "Install a local Hades plugin manifest, or start with the example.")}</div>`;
    if (view === "rooms") {
      if (!room)
        return `<div class="page">${heading("Team rooms", "Give a task to a team. Each profile contributes in order, with its own tools and memory.")}<div class="page-actions">${button("New room", "room-new", 'class="primary-button"')}</div><div class="cards">${(boot.rooms ?? []).map((r: Row) => `<button class="library-card" data-action="room-open" data-id="${r.id}"><h3>${esc(r.name)}</h3><p>${r.members.map((id: string) => esc(boot.profiles.find((p: Profile) => p.id === id)?.name ?? id)).join(" → ")}</p><small>${r.running ? "Working" : `${r.count} messages`} · ${esc(labelProject(r.root))}</small></button>`).join("")}</div>${!boot.rooms?.length ? empty("[ · · ]", "No team rooms", "Create two agent profiles, then add them to a room.") : ""}</div>`;
      return `<div class="page room-page"><div class="page-actions">${button("← All rooms", "rooms-back")}<span class="muted">${room.members.map((id: string) => esc(boot.profiles.find((p: Profile) => p.id === id)?.name ?? id)).join(" → ")}</span></div><h1>${esc(room.name)}</h1><p class="help">${esc(room.root)} · One response per agent in each round.</p><div class="room-messages">${room.messages.map((m: Row) => `<article class="message ${m.role}"><div class="message-label">${m.role === "user" ? "You" : esc(boot.profiles.find((p: Profile) => p.id === m.profile)?.name)}${m.session ? button("Open conversation", "session", `data-id="${m.session}"`) : ""}</div><div class="message-body">${formatText(m.content)}</div></article>`).join("")}</div>${room.error ? `<p class="inline-notice">${esc(room.error)}</p>` : ""}${(room.pending ?? []).map((p: Row) => `<div class="inline-notice"><strong>${esc(boot.profiles.find((x: Profile) => x.id === p.profile)?.name)} needs approval</strong><pre>${esc(p.tool)} ${esc(p.input)}</pre>${button("Approve", "room-approve", `data-id="${p.id}" data-allow="true"`)}${button("Decline", "room-approve", `data-id="${p.id}" data-allow="false"`)}</div>`).join("")}<div class="room-composer"><textarea id="room-draft" rows="3" placeholder="Give your team a task…" aria-label="Message your team">${esc(roomDraft)}</textarea><div class="page-actions"><span class="help">${room.running ? "Your team is working…" : "Uses each member’s configured provider."}</span>${button(room.running ? "Stop round" : "Send to team", room.running ? "room-stop" : "room-send", 'class="primary-button"')}</div></div></div>`;
    }
    if (view === "models")
      return `<div class="page">${heading("Local models", "Run models on your Mac with Ollama.")}<div class="local-connect">${field("Ollama address", "local-endpoint", localEndpoint)}${button("Connect / refresh", "local-refresh", 'class="primary-button"')}${button("Get Ollama", "open-link", 'data-url="https://ollama.com/download/mac"')}</div>${localError ? `<p class="inline-notice">${esc(localError)}</p>` : `<p class="help">${localState.models.length} installed models · ${esc(localEndpoint)}</p>`}<h2>Download a model</h2><div class="local-connect">${field("Model name from the Ollama library", "local-model", "", "text")}${button("Download", "local-pull")}${button("Browse library", "open-link", 'data-url="https://ollama.com/library"')}</div><p class="help">Models can require several GB of storage and memory. Downloads start only when you choose Download.</p><div id="downloads">${downloadHTML()}</div><h2>On this Mac</h2>${localState.models.length ? localState.models.map((m: Row) => `<div class="record"><div><h3>${esc(m.name)}</h3><small>${(Number(m.size) / 1e9).toFixed(1)} GB · ${esc(m.details?.parameter_size ?? "")}</small></div>${button("Use model", "local-use", `data-model="${esc(m.name)}"`)}${button("Remove", "local-remove", `data-model="${esc(m.name)}"`)}</div>`).join("") : empty("[ · ]", "No local models", "Start Ollama, then download a model or connect to your existing library.")}</div>`;
    if (view === "memory")
      return `<div class="page">${heading("Memory", "Useful context, carried from one conversation to the next.")}<div class="page-actions">${button("Add memory", "memory-add", 'class="primary-button"')}${button("Export", "memory-export")}</div>${
        memory.length
          ? `<div class="record-list">${memory.map((m) => `<div class="record"><span>${icon("memory")}</span><div><p>${esc(m.fact)}</p><small>Used ${m.accessCount} times · ${new Date(m.createdAt).toLocaleDateString()}</small></div>${button("Details", "memory-detail", `data-id="${m.id}"`)}${button("Forget", "memory-forget", `data-id="${m.id}"`)}</div>`).join("")}</div>`
          : empty(
              "✳",
              "A fresh start.",
              "Add a preference, a useful fact, or something you want Hades to remember.",
            )
      }</div>`;
    if (view === "skills")
      return `<div class="page">${heading("Skills", "Reusable instructions for the way you like to work.")}<div class="page-actions">${button("Create skill", "skill-new", 'class="primary-button"')}${button("Install SKILL.md", "skill-import")}<input id="skill-import-file" type="file" accept=".md" hidden></div>${skills.length ? `<div class="cards">${skills.map((s) => `<button class="library-card" data-action="skill-edit" data-name="${esc(s.name)}">${icon("skills")}<h3>${esc(s.name)}</h3><p>${esc(s.content.slice(0, 160))}</p><small>Local SKILL.md</small></button>`).join("")}</div>` : empty("⌘", "No skills yet", "Create a skill and attach its instructions to a conversation.")}</div>`;
    if (view === "jobs")
      return `<div class="page">${heading("Routines", "Recurring work, with a conversation for every run.")}<div class="page-actions">${button("New routine", "job-new", 'class="primary-button"')}<span class="muted">Runs while Hades is open. Changes still require approval.</span></div>${boot.jobs.length ? boot.jobs.map((j: Row) => `<div class="record"><span>${icon("jobs")}</span><div><h3>${esc(j.name)}</h3><p>${esc(j.prompt)}</p><small>${j.cron ? esc(j.cron) + " · " + esc(j.timeZone) : "Every " + j.intervalMinutes + " min"} · ${j.enabled ? "Next " + new Date(j.nextAt).toLocaleString() : "Paused"}${j.lastStatus ? " · " + esc(({queued:"Queued",running:"Running",completed:"Finished",failed:"Failed",interrupted:"Needs review",cancelled:"Cancelled"} as Row)[j.lastStatus] ?? j.lastStatus) : ""}${j.lastError ? " · " + esc(j.lastError) : ""}</small></div>${j.session ? button("Open conversation", "session", `data-id="${j.session}"`) : ""}${button("Edit", "job-edit", `data-id="${j.id}"`)}<details class="routine-actions"><summary aria-label="Routine actions">${icon("more")}</summary><div>${button(j.enabled ? "Pause" : "Enable", "job-toggle", `data-id="${j.id}"`)}${button("Run history", "job-history", `data-id="${j.id}"`)}${button("Remove routine", "job-remove", `data-id="${j.id}"`)}</div></details>${["queued", "running"].includes(j.lastStatus) ? button("Stop run", "job-cancel", `data-id="${j.runId}"`) : button("Run now", "job-run", `data-id="${j.id}"`)}</div>`).join("") : empty("◷", "No routines yet", "Set up a recurring prompt for one of your projects.")}</div>`;
    if (view === "artifact") {
      return `<div class="page">${heading("Artifacts", "Files in your project, and links from the current conversation.")}<div class="page-actions">${button("Browse project files", "files", 'class="primary-button"')}</div>${artifacts.length ? artifacts.map((item: Row, i: number) => `<div class="record">${icon("artifact")}<div><p>${esc(item.path ?? item.url)}</p><small>${new Date(item.at).toLocaleString()}</small></div>${button("Preview", "artifact-open", `data-index="${i}"`)}${button("Conversation", "session", `data-id="${item.session}"`)}</div>`).join("") : empty("◇", "No artifacts yet", "Use the file browser to preview, edit and open your project’s outputs.")}</div>`;
    }
    if (view === "agents")
      return `<div class="page">${heading("Agents", "Separate profiles, shared workspace tools, independent conversations.")}<div class="page-actions">${button("New agent", "profile-new", 'class="primary-button"')}</div><div class="cards">${boot.profiles.map((p: Profile) => `<button class="library-card" data-action="profile-select" data-id="${p.id}"><h3>${esc(p.name)}</h3><p>${esc(p.persona || "Your general-purpose agent.")}</p><small>${esc(p.provider)} / ${esc(p.model)}</small></button>`).join("")}</div><h2>Running conversations <span class="muted">${boot.active.length}</span></h2>${boot.active.map((id: string) => `<div class="record"><i class="running-dot"></i><div>${esc(boot.sessions.find((s: Row) => s.id === id)?.title || id)}</div>${button("Open", "session", `data-id="${id}"`)}</div>`).join("") || '<p class="muted">No conversations running.</p>'}<details class="advanced"><summary>Harness services</summary><p>Inspect Hades’ existing fleet, gateway, trust and learning services.</p>${["fleet.list", "gateway.status.get", "learning.get", "schedule.status.get"].map((kind) => button(esc(kind), "harness", `data-kind="${kind}"`)).join("")}<pre id="harness-output">${esc(modalData.harness ?? "")}</pre></details></div>`;
    return "";
  }
  function downloadHTML() {
    return (boot.downloads ?? [])
      .map(
        (d: Row) =>
          `<div class="record"><div><h3>${esc(d.model)}</h3><small>${esc(d.status)}${d.total ? ` · ${Math.min(100, Math.round(((d.completed ?? 0) / d.total) * 100))}%` : ""}${d.error ? " · " + esc(d.error) : ""}</small>${d.total && !d.done ? `<progress value="${Number(d.completed ?? 0)}" max="${Number(d.total)}" aria-label="Download progress"></progress>` : ""}</div>${!d.done ? button("Cancel", "local-cancel", `data-id="${d.id}"`) : ""}</div>`,
      )
      .join("");
  }
  function empty(mark: string, title: string, detail: string) {
    return `<div class="empty"><h2>${title}</h2><p>${detail}</p></div>`;
  }
  function paneHTML() {
    return `<aside class="inspector"><div class="inspector-heading"><strong>${pane === "files" ? "Project files" : pane === "git" ? "Changes" : pane === "preview" ? "Preview" : "Terminal"}</strong>${button(icon("close"), "pane-close", 'aria-label="Close inspector"')}</div>${!project ? empty("⌑", "Open a project", "Choose a folder first.") : pane === "files" ? `<div class="file-path">${button(icon("up"), "folder-up", 'aria-label="Parent folder"')}<span class="mono">${esc(folder)}</span>${button(icon("refresh"), "files-refresh", 'aria-label="Refresh files"')}</div><div class="file-list">${files.map((f) => button(`${icon(f.directory ? "files" : "artifact")}<span class="truncate">${esc(f.name)}</span>${f.directory ? icon("right") : ""}`, "file", `data-path="${esc(f.path)}" data-dir="${f.directory}" class="file-row"`)).join("")}</div>${preview ? previewHTML() : ""}` : pane === "preview" ? `<div class="preview-url"><input id="preview-url" aria-label="Preview address" type="url" placeholder="https://…" value="${esc(modalData.url ?? "")}">${button("Go", "preview-go")}</div>${modalData.url ? `<iframe title="Website preview" src="${esc(modalData.url)}" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"></iframe><p class="muted preview-note">Some sites block embedded previews. ${button("Open in browser", "open-link", `data-url="${esc(modalData.url)}"`)}</p>` : ""}` : pane === "git" ? `<div class="git-review"><pre class="git-status">${esc(git.status ?? "")}</pre><div class="page-actions">${button("Refresh", "git-refresh")}${button("Checkpoints", "checkpoints")}${button("New branch", "branch")}${button("Worktree", "worktree")}</div><label class="field">File path to stage or unstage<input id="git-path" placeholder="src/example.ts"></label>${button("Stage", "git-stage")}${button("Unstage", "git-unstage")}<label class="field">Commit message<input id="commit-message" placeholder="Describe the change"></label>${button("Commit staged", "git-commit", 'class="primary-button"')}${button("Push", "git-push")}<pre class="diff">${esc(git.diff || "No tracked file changes.")}</pre></div>` : `<div class="terminal-tabs">${boot.terminals.map((t: Row, i: number) => button(`${i + 1} ${labelProject(t.root)}`, "terminal-select", `data-id="${t.id}" class="${selectedTerminal === t.id ? "selected" : ""}"`)).join("")}${button(icon("+"), "terminal-new", 'aria-label="New terminal"')}${button(icon("close"), "terminal-close", 'aria-label="Close terminal process"')}</div><div id="terminal-host" class="terminal-host" aria-label="Interactive terminal"></div><div class="terminal-controls">${button("Ctrl C", "terminal-interrupt")}${button("Add output to chat", "terminal-context")}</div>`}</aside>`;
  }
  function previewHTML() {
    return `<section class="file-preview"><div class="inspector-heading"><strong>${esc(preview!.path)}</strong>${button(icon("external"), "file-open", 'aria-label="Open file in default editor"')}</div>${preview!.image ? `<img src="${esc(preview!.image)}" alt="${esc(preview!.path)}">` : `<textarea id="file-content" aria-label="File contents" spellcheck="false">${esc(preview!.text)}</textarea><div class="page-actions">${button("Save changes", "file-save")}${button("Add to chat", "file-context")}</div>`}</section>`;
  }
  function codexHTML() {
    return `<div class="provider-account"><strong>${codexAccount.connected ? "Connected to ChatGPT" : "Use your Codex subscription"}</strong><p class="help">${codexAccount.connected ? esc([codexAccount.email, codexAccount.plan].filter(Boolean).join(" · ")) : "Sign in with the ChatGPT account that includes Codex. No API key needed."}</p><div class="page-actions">${button(codexPending ? "Waiting for sign-in…" : codexAccount.connected ? "Sign out" : "Sign in with ChatGPT", codexAccount.connected ? "codex-logout" : "codex-login", codexPending ? "disabled" : 'class="primary-button"')}${codexPending ? button("Cancel", "codex-cancel") : button("Refresh status", "codex-status")}</div><p class="help" id="codex-error" role="status"></p></div>`;
  }
  const providerCatalogs = new Map<string,string[]>();
  let modelCatalogVersion = 0;
  function settingsModelHTML(provider:string,selected:string,endpoint = profile?.baseUrl ?? "") {
    if(provider!=="codex"){const models=providerCatalogs.get(JSON.stringify([profile?.id,provider,endpoint]));return `<select id="settings-model">${!models?.includes(selected)?`<option value="${esc(selected)}" selected>${esc(selected)} — ${models?"unavailable in current catalog":"saved selection"}</option>`:""}${(models??[]).map(model=>`<option value="${esc(model)}" ${model===selected?"selected":""}>${esc(model)}</option>`).join("")}</select><span class="help" id="settings-catalog-status">${models?"Models from your provider":"Load available models from your provider."}</span>`;}
    const missing=!codexModels.includes(selected);
    return `<select id="settings-model">${missing?`<option value="${esc(selected)}" selected>${esc(selected)} — ${codexCatalogLoaded?"unavailable in current catalog":"saved selection"}</option>`:""}${codexModels.map(model=>`<option value="${esc(model)}" ${model===selected?"selected":""}>${esc(model)}</option>`).join("")}</select><span class="help" id="settings-catalog-status">${esc(codexModelsError || "Models available to your connected ChatGPT account")}</span>`;
  }
  async function updateCodex() {
    const version=++codexCatalogVersion,profileId=profile.id;
    let account:Row;
    try { account = await rpc("codex.status"); }
    catch (e) { account = { connected: false, message: String(e) }; }
    if(version!==codexCatalogVersion||profile.id!==profileId)return;
    codexAccount=account;codexModels=[];codexCatalogLoaded=false;codexModelsError="Connect ChatGPT to load its model catalog.";
    if(account.connected){
      try{const models=await rpc("codex.models");if(version!==codexCatalogVersion||profile.id!==profileId)return;codexModels=models;codexCatalogLoaded=true;codexModelsError=models.length?"":"No models returned by this account.";}
      catch(e){if(version!==codexCatalogVersion||profile.id!==profileId)return;codexModelsError=String(e);}
    }
    const panel = root.querySelector<HTMLElement>("#codex-connection");
    if (panel) { panel.innerHTML = codexHTML(); panel.querySelector<HTMLElement>("#codex-error")!.textContent = codexAccount.message ?? ""; }
    const modelHost=root.querySelector<HTMLElement>("#settings-model-control");
    if(modelHost&&root.querySelector<HTMLSelectElement>("#settings-provider")?.value==="codex"){
      const selected=root.querySelector<HTMLInputElement>("#settings-model")?.value??profile.model;
      modelHost.innerHTML=settingsModelHTML("codex",selected);
    }
  }
  function modalHTML() {
    let title = "",
      content = "";
    if (modal === "settings" || modal === "profile") {
      const p =
        modal === "profile"
          ? {
              id: "",
              name: "",
              provider: "openai",
              model: "gpt-4o-mini",
              baseUrl: "https://api.openai.com/v1",
              persona: "",
              shell: [],
              mcp: [],
            }
          : profile;
      title = modal === "profile" ? "New agent" : "Settings";
      content = `<div class="settings-section"><h3>Provider & model</h3><label class="field">Provider<select id="settings-provider">${Object.entries(providers).map(([v, item]) => `<option value="${v}" ${p.provider === v ? "selected" : ""}>${item.label}</option>`).join("")}</select></label><div id="codex-connection" ${p.provider !== "codex" ? "hidden" : ""}>${codexHTML()}</div><label class="field">Model<span id="settings-model-control">${settingsModelHTML(p.provider,p.model,p.baseUrl)}</span></label>${button("Refresh available models", "settings-model-catalog")}<div id="api-connection" ${p.provider === "codex" ? "hidden" : ""}>${field("Endpoint", "settings-url", p.baseUrl)}${field("API key", "settings-key", "", "password")}<p class="help">Saved in macOS Keychain. Leave blank to keep your existing key.</p></div></div><details class="settings-section"><summary>Profile & advanced instructions</summary>${field("Profile name (optional)", "settings-name", p.name)}<label class="field">Agent instructions<textarea id="settings-persona" rows="4">${esc(p.persona)}</textarea></label>${field("Allowed shell commands, separated by commas", "settings-shell", p.shell.join(","))}<p class="help">Host commands require your approval each time. They run with your account’s access.</p><p class="help">Manage MCP servers from the sidebar. ${p.mcp?.length ?? 0} servers configured for this profile.</p></details>${modal === "settings" ? '<div id="company-os-settings"></div>' : ""}<details class="settings-section"><summary>Appearance & preferences</summary><div class="segmented">${["system", "light", "dark"].map((t) => button(t[0].toUpperCase() + t.slice(1), "theme", `data-theme="${t}" aria-pressed="${theme === t}" class="${theme === t ? "active" : ""}"`)).join("")}</div><div class="page-actions">${button("A−", "zoom-out", 'aria-label="Decrease text size"')}${button("A+", "zoom-in", 'aria-label="Increase text size"')}${button("Export profile", "profile-export")}${button("Import profile", "profile-import")}<input id="profile-import-file" type="file" accept=".json" hidden>${button("Keyboard shortcuts", "shortcuts")}${button("Import VS Code theme", "theme-import")}<input id="theme-import-file" type="file" accept=".json,.jsonc" hidden>${importedTheme ? button(esc(importedTheme.name), "theme", 'data-theme="custom"') : ""}</div><div class="page-actions">${button(quickEntry ? "Disable Quick Entry" : "Enable Quick Entry", "quick-entry")}${button("Keep awake", "awake-on")}${button("Allow sleep", "awake-off")}${button("Stop speech", "voice-stop")}</div><p class="help">Quick Entry: ⌘ ⇧ Space while Hades is open. Voice clips go to your profile’s speech endpoint; transcripts stay in the composer until you send.</p></details>${button("Save settings", "settings-save", 'class="primary-button wide"')}`;
    }
    if (modal === "harness-command") {
      title = "hades " + modalData.command;
      content = `<p class="help">Run this command in your project’s terminal. Start with help to see its options.</p>${field("Arguments (JSON array)", "harness-args", modalData.command === "help" || modalData.command === "version" || modalData.command === "doctor" ? "[]" : '["--help"]')}<p class="help">Example: ["status"]. The command runs only when you click Run.</p>${button("Run in terminal", "harness-launch", 'class="primary-button"')}`;
    }
    if (modal === "project") {
      title = "Open project";
      content = `<p>Choose a folder. Hades can read its files and asks before changing them.</p>${field("Project folder", "project-path", project || boot.home || "")}<div class="page-actions">${button("Choose in Finder…", "project-pick")}${button("Open project", "project-add", 'class="primary-button"')}</div>`;
    }
    if (modal === "model") {
      title = "Model for this conversation";
      content =
        `<label class="field">Model<select id="session-model"><option value="${esc(session?.model || profile.model)}">${esc(session?.model || profile.model)} — saved selection</option></select></label>` +
        '<p class="help">Uses the current profile’s provider. Your profile default stays the same.</p>' +
        button("Browse available models", "model-catalog") +
        '<div id="model-catalog" class="palette-list"></div>' +
        button("Use model", "model-save", 'class="primary-button"');
    }
    if (modal === "memory") {
      title = "Remember this";
      content =
        '<label class="field">A useful fact<textarea id="memory-fact" rows="5"></textarea></label>' +
        button("Add memory", "memory-save", 'class="primary-button"');
    }
    if (modal === "skill") {
      title = modalData.name ? "Edit skill" : "Create a skill";
      content =
        field(
          "Name (letters, numbers, hyphens)",
          "skill-name",
          modalData.name ?? "",
        ) +
        `<label class="field">Instructions<textarea id="skill-content" rows="10" spellcheck="false">${esc(modalData.content ?? "---\nname: my-skill\ndescription: When to use this skill\n---\n\n")}</textarea></label>` +
        (modalData.readonly
          ? '<p class="help">Installed by an extension. Edit its manifest to change the original, or attach it to your chat.</p>'
          : button("Save skill", "skill-save", 'class="primary-button"')) +
        button("Attach to chat", "skill-attach");
    }
    if (modal === "job") {
      const job = modalData.job;
      title = job ? "Edit routine" : "New routine";
      content = field("Name", "job-name", job?.name ?? "") +
        `<label class="field">Prompt<textarea id="job-prompt" rows="4">${esc(job?.prompt ?? "")}</textarea></label>` +
        `<label class="field">Schedule<select id="job-schedule"><option value="interval" ${job?.cron ? "" : "selected"}>Repeat at an interval</option><option value="cron" ${job?.cron ? "selected" : ""}>Custom schedule</option></select></label>` +
        `<div id="job-interval-fields">${field("Repeat every (minutes)", "job-interval", String(job?.intervalMinutes ?? 60), "number")}</div>` +
        `<div id="job-cron-fields">${field("Cron expression", "job-cron", job?.cron ?? "")}${field("Time zone", "job-timezone", job?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)}<p class="help">Five fields: minute, hour, day, month, weekday. For example, 0 9 * * 1-5 runs at 9 a.m. on weekdays.</p></div>` +
        `<p class="help">Project: ${esc(job?.root || project || "Choose a project first")}. Runs while Hades is open. Edits apply to future runs; queued runs retain their original instructions.</p>` +
        button(job ? "Save routine" : "Create routine", "job-save", 'class="primary-button"');
    }
    if (modal === "job-history") {
      title = "Run history · " + esc(modalData.job?.name);
      content = `<p class="help">Latest 100 runs, newest first. Finished means the agent returned an answer; inspect its conversation to verify the outcome.</p>${[...modalData.runs].reverse().map((r:Row) => `<div class="record"><div><h3>${esc(({completed:"Finished",interrupted:"Needs review",queued:"Queued",running:"Working",failed:"Failed",cancelled:"Cancelled"} as Row)[r.status])}</h3><small>${new Date(r.createdAt).toLocaleString()}</small>${r.error ? `<p>${esc(r.error)}</p>` : ""}</div>${r.session ? button("Open conversation", "session", `data-id="${r.session}"`) : ""}</div>`).join("") || '<p class="help">This routine has not run yet.</p>'}`;
    }
    if (modal === "rename") {
      title = "Name this conversation";
      content =
        field("Title", "rename-title", session?.title ?? "") +
        button("Save", "rename-save", 'class="primary-button"') +
        button("Pin / unpin", "pin") +
        button("Archive conversation", "archive");
    }
    if (modal === "branch" || modal === "worktree") {
      title = modal === "branch" ? "Create a branch" : "Create a worktree";
      content =
        field("Branch name", "branch-name") +
        button("Create", "branch-save", 'class="primary-button"');
    }
    if (modal === "confirm") {
      title = modalData.title;
      content = `<p>${esc(modalData.description)}</p>${button("Cancel", "modal-close")}${button("Continue", "confirm", 'class="primary-button"')}`;
    }
    if (modal === "palette") {
      title = "What would you like to do?";
      content =
        '<input id="palette-search" class="palette-search" placeholder="Search actions…" aria-label="Search actions"><div class="palette-list">' +
        [
          ["new", "New conversation", "⌘ N"],
          ["project", "Open project", ""],
          ["settings", "Settings", "⌘ ,"],
          ["files", "File browser", "⌘ J"],
          ["git", "Review changes", "⌘ G"],
          ["terminal", "Terminal", "⌃ `"],
          ["web-preview", "Website preview", ""],
          ["rename", "Rename, pin or archive conversation", ""],
          ["session-export", "Export conversation", ""],
          ["hud", "Floating chat", "⌘ ⇧ H"],
          ["popout", "New window", "⌘ ⇧ N"],
          ["nav-tools", "Tools & connections", ""],
          ["nav-sessions", "Conversation history", ""],
          ["nav-computer", "Computer control", ""],
          ["nav-mcp", "MCP servers", ""],
          ["nav-activity", "Activity history", ""],
          ["nav-system", "System", ""],
          ["nav-memory", "Memory", ""],
          ["nav-skills", "Skills", ""],
          ["nav-jobs", "Routines", ""],
          ["nav-models", "Local models", ""],
          ["nav-rooms", "Team rooms", ""],
          ["nav-ecosystem", "Plugins — connected accounts", ""],
          ["nav-plugins", "Extensions", ""],
          ["checkpoints", "Review file checkpoints", ""],
          ["shortcuts", "Keyboard shortcuts", "⌘ /"],
        ]
          .map(([a, l, k]) =>
            button(
              l +
                `<kbd>${esc(bindings[a] ? bindings[a].replace("mod+", "⌘ ").replace("shift+", "⇧ ").replace("alt+", "⌥ ").toUpperCase() : k)}</kbd>`,
              a,
              'class="palette-item"',
            ),
          )
          .join("") +
        "</div>";
    }
    if (modal === "plugin") {
      const p = modalData.plugin;
      title = `Review ${p.name}`;
      content = `<p>${esc(p.description)}</p><p class="help">Version ${esc(p.version)} · Installs into ${esc(profile.name)}</p>${p.skills.map((s: Row) => `<details class="advanced"><summary>Skill: ${esc(s.name)}</summary><pre>${esc(s.content)}</pre></details>`).join("")}${p.mcp.map((m: Row) => `<div class="inline-notice"><strong>MCP: ${esc(m.name)}</strong><pre>${esc([m.command, ...m.args].map((x) => JSON.stringify(x)).join(" "))}</pre><p class="help">This command runs with your account’s access when the plugin is enabled and a turn starts.</p></div>`).join("")}${modalData.content ? button("Install disabled", "plugin-install", 'class="primary-button wide"') : ""}`;
    }
    if (modal === "room-new") {
      title = "Bring your team together";
      content = `${field("Room name", "room-name")}<label class="field">Project<select id="room-root">${boot.projects.map((p: string) => `<option value="${esc(p)}" ${project === p ? "selected" : ""}>${esc(labelProject(p))}</option>`).join("")}</select></label><p class="help">Choose two to eight profiles. They respond in the order shown.</p><div class="room-roster">${boot.profiles.map((p: Profile) => `<label><input type="checkbox" name="room-member" value="${p.id}"><span><strong>${esc(p.name)}</strong><small>${esc(p.provider)} / ${esc(p.model)}</small></span></label>`).join("")}</div>${button("Create room", "room-create", 'class="primary-button wide"')}`;
    }
    if (modal === "shortcuts") {
      title = "Keyboard shortcuts";
      content = `<p class="help">Use mod for Command, for example mod+k or mod+shift+k. System editing keys stay reserved.</p><div class="shortcut-list">${Object.entries(
        shortcutDefaults,
      )
        .map(([key, d]) => field(d.label, "shortcut-" + key, bindings[key]))
        .join(
          "",
        )}</div><p class="help">Quick Entry: ⌘ ⇧ Space · Stop generation: Esc · Terminal: Control \`</p>${button("Save shortcuts", "shortcuts-save", 'class="primary-button"')}${button("Restore defaults", "shortcuts-reset")}`;
    }
    if (modal === "checkpoints") {
      title = "A way back";
      content = `<p class="help">Approved file edits and editor saves, newest first. Restore checks for later changes. Shell and MCP changes are not captured.</p>${checkpoints.map((c) => `<div class="record"><div><h3>${esc(c.path)}</h3><small>${new Date(c.at).toLocaleString()} · ${c.restoredAt ? "Restored" : !c.ready ? "Interrupted edit" : c.created ? "Created" : c.deleted ? "Deleted" : "Edited"}</small></div>${button("Review", "checkpoint-review", `data-id="${c.id}"`)}</div>`).join("") || empty("[ ↶ ]", "No edits to restore yet.", "Hades saves checkpoints as it edits files.")}`;
    }
    if (modal === "checkpoint") {
      title = "Review checkpoint";
      const c = modalData.checkpoint;
      content = `<p class="mono">${esc(c.path)}</p><p class="help">${c.restoredAt ? "Already restored." : c.conflict ? "This file has newer changes or the edit was interrupted. Automatic restore is unavailable." : "Restore the file to its saved contents before this edit."}</p><div class="checkpoint-compare"><div><h3>Before</h3><pre>${esc(c.before ?? "[File did not exist]")}</pre></div><div><h3>After</h3><pre>${esc(c.after ?? "[File removed]")}</pre></div></div>${button("Back", "checkpoints")}${!c.conflict && !c.restoredAt ? button("Restore this edit", "checkpoint-restore", 'class="primary-button"') : ""}`;
    }
    return `<div class="modal-backdrop"><section class="modal" role="dialog" tabindex="-1" aria-modal="true" aria-label="${esc(title)}"><div class="modal-header"><h2>${title}</h2>${button(icon("close"), "modal-close", 'class="icon-button" aria-label="Close dialog"')}</div>${content}</section></div>`;
  }
  const val = (id: string) =>
    root.querySelector<HTMLInputElement>("#" + id)?.value ?? "";
  async function navigate(next: string): Promise<void> {
    if (next === "work" || next === "helm") return action("conversation-history");
    view = next;
    if (view !== "ecosystem") ecosystem.mount(undefined);
    if (!["chat", "workspace"].includes(view)) pane = "";
    if (matchMedia("(max-width: 800px)").matches) sidebar = false;
    if (view === "workspace" && project) { pane = "files"; folder = "."; files = await rpc("files.list", { root: project, path: folder }); }

    modal = "";
    if (managementViews.has(view)) await management.open(view, profile.id, profile.name, project);
    if (historyOpen) await workGoals.open(workContext());
    if (view === "webhooks") await webhooks.open(webhookContext());
    if (view === "browser") await browserView.open({ profile: profile.id, root: project, name: profile.name });
    if (view === "credentials") await credentials.open(profile.id);
    if (view === "ecosystem") { const loading = ecosystem.open(profile.id, ecosystemPluginId); render(); await loading; }
    if (view === "channels") await channels.open(webhookContext());
    if (view === "hooks") await hooks.open(webhookContext());
    if (view === "maintenance") await maintenance.open();
    if (view === "memory")
      memory = await rpc("memory.list", { profile: profile.id });
    if (view === "artifact")
      artifacts = await rpc("artifacts.list", { profile: profile.id });
    if (view === "models") await loadLocal();
    if (view === "harness") harnessItems = await rpc("harness.catalog");
    if (view === "plugins")
      plugins = await rpc("plugins.list", { profile: profile.id });
    if (view === "skills")
      skills = await rpc("skills.list", { profile: profile.id });
    render();
  }
  async function loadLocal() {
    try {
      localState = await rpc("local.list", { endpoint: localEndpoint });
      localError = "";
      boot.downloads = localState.downloads;
    } catch (e) {
      localError = e instanceof Error ? e.message : "Could not reach Ollama";
      localState = { models: [] };
    }
  }
  async function action(name: string, el?: HTMLElement) {
    if (name.startsWith("nav-")) return navigate(name.slice(4));
    switch (name) {
      case "conversation-starter":
        draft = `/${el?.dataset.command ?? "goal"} `; view = "chat"; render(); root.querySelector<HTMLTextAreaElement>("#composer")?.focus(); return;
      case "conversation-history":
        view = "chat"; historyOpen = !historyOpen;
        if (historyOpen) { await workGoals.open(workContext()); codingHistory = project ? await rpc("helm.list", {root:project,profile:profile.id}) : []; codingDrafts = (await rpc("helm.handoff.list",{profile:profile.id})).filter((item:Row)=>!item.root || item.root===project); }
        render(); return;
      case "conversation-draft": {
        const selected = codingDrafts.find(item=>item.id===el?.dataset.id && item.status==="draft");
        if(!selected)return;
        draft=`/code Use browser draft ${selected.id} (${selected.notebook.title}). Read it with helm_handoffs and retain its handoffId when delegating. ${selected.prompt}`;
        historyOpen=false;render();root.querySelector<HTMLTextAreaElement>("#composer")?.focus();return;
      }
      case "conversation-review": {
        const run = codingHistory.find(item => item.id === el?.dataset.id);
        if (!run) return;
        if (!session || session.root !== run.root) await newChat(run.root);
        historyOpen = false; render(); await chatWork.reviewRun(run); return;
      }
      case "ecosystem-open": {
        const id = el?.dataset.plugin;
        if (!ecosystemPlugins.some(plugin => plugin.id === id)) return;
        ecosystemPluginId = id!;
        const dropdown = root.querySelector<HTMLDetailsElement>(".sidebar-plugins");
        if (dropdown) dropdown.open = true;
        return navigate("ecosystem");
      }
      case "spatial-open": {
        if (!session) await newChat();
        if (!session) return;
        spatial.setScope({sessionId:current(),profile:profile.id,root:project});
        await spatial.open();
        return;
      }
      case "harness-choose": modal = "harness-command"; modalData = { command: el!.dataset.command }; break;
      case "harness-launch": {
        if (profile.provider !== "codex") await tauri().core.invoke("hades_key", { account: profile.id + ":" + profile.provider, value: null });
        const t = await rpc("harness.launch", { command: modalData.command, args: val("harness-args"), root: project, profile: profile.id });
        boot.terminals.push(t); selectedTerminal = t.id; pane = "terminal"; modal = ""; break;
      }
      case "tab-new":
        return action("new");
      case "quick-open":
        return action("palette");
      case "plugin-import":
        root.querySelector<HTMLInputElement>("#plugin-import-file")?.click();
        return;
      case "plugin-example":
        download(
          "writing-tools.hades-plugin.json",
          JSON.stringify(
            {
              format: "hades-plugin-v1",
              name: "writing-tools",
              version: "1.0.0",
              description:
                "A concise editing skill. No process or network permissions.",
              skills: [
                {
                  name: "editor",
                  content:
                    "When asked to edit prose, preserve meaning, use concrete verbs, and remove repetition. Explain material edits briefly.",
                },
              ],
              mcp: [],
            },
            null,
            2,
          ),
        );
        return;
      case "plugin-review":
        modal = "plugin";
        modalData = {
          plugin: plugins.find((x) => x.manifest.name === el!.dataset.name)!
            .manifest,
        };
        break;
      case "plugin-install":
        await rpc("plugins.install", {
          profile: profile.id,
          content: modalData.content,
        });
        await navigate("plugins");
        return;
      case "plugin-toggle": {
        const name = el!.dataset.name,
          enabled = el!.dataset.enabled === "true";
        if (enabled) {
          modal = "confirm";
          modalData = {
            title: `Enable ${name}?`,
            description:
              "Its skills will guide this agent and its MCP commands may launch on the next turn. Review the package’s commands before enabling it. Tool calls require approval.",
            confirm: async () => {
              await rpc("plugins.toggle", {
                profile: profile.id,
                name,
                enabled,
              });
              plugins = await rpc("plugins.list", { profile: profile.id });
            },
          };
        } else {
          await rpc("plugins.toggle", { profile: profile.id, name, enabled });
          await navigate("plugins");
          return;
        }
        break;
      }
      case "plugin-remove": {
        const name = el!.dataset.name;
        modal = "confirm";
        modalData = {
          title: `Remove ${name}?`,
          description:
            "Remove this package from the profile. A reinstallable copy is kept in the profile’s removed-plugins folder. Changes take effect on the next turn.",
          confirm: async () => {
            await rpc("plugins.remove", { profile: profile.id, name });
            plugins = await rpc("plugins.list", { profile: profile.id });
          },
        };
        break;
      }
      case "room-new":
        modal = "room-new";
        break;
      case "room-create":
        room = await rpc("room.create", {
          name: val("room-name"),
          root: val("room-root"),
          members: [
            ...root.querySelectorAll<HTMLInputElement>(
              'input[name="room-member"]:checked',
            ),
          ].map((x) => x.value),
        });
        setProject(room!.root);
        view = "rooms";
        modal = "";
        await refresh();
        return;
      case "room-open":
        room = await rpc("room.get", { id: el!.dataset.id });
        roomDraft = "";
        setProject(room!.root);
        view = "rooms";
        break;
      case "rooms-back":
        room = undefined;
        await refresh();
        return;
      case "room-send":
        await rpc("room.send", { id: room!.id, input: roomDraft });
        roomDraft = "";
        room = await rpc("room.get", { id: room!.id });
        break;
      case "room-stop":
        await rpc("room.stop", { id: room!.id });
        return;
      case "room-approve":
        await rpc("approval.reply", {
          id: el!.dataset.id,
          allow: el!.dataset.allow === "true",
        });
        room = await rpc("room.get", { id: room!.id });
        break;
      case "find":
        find = " ";
        render();
        root.querySelector<HTMLInputElement>("#find-input")?.focus();
        return;
      case "statusbar":
        statusbar = !statusbar;
        break;
      case "shortcuts-save":
        bindings = parseShortcuts(
          Object.fromEntries(
            Object.keys(shortcutDefaults).map((k) => [k, val("shortcut-" + k)]),
          ),
        );
        localStorage.setItem("hades.shortcuts", JSON.stringify(bindings));
        modal = "";
        break;
      case "shortcuts-reset":
        bindings = parseShortcuts({});
        localStorage.removeItem("hades.shortcuts");
        break;
      case "theme-import":
        root.querySelector<HTMLInputElement>("#theme-import-file")?.click();
        return;
      case "skill-import":
        root.querySelector<HTMLInputElement>("#skill-import-file")?.click();
        return;
      case "local-refresh":
        localEndpoint = val("local-endpoint") || localEndpoint;
        await loadLocal();
        if (!localError) localStorage.setItem("hades.ollama", localEndpoint);
        break;
      case "local-pull": {
        const endpoint = val("local-endpoint"),
          model = val("local-model");
        const d = await rpc("local.pull", { endpoint, model });
        boot.downloads = [
          ...(boot.downloads ?? []).filter((x: Row) => x.id !== d.id),
          d,
        ];
        break;
      }
      case "local-cancel":
        await rpc("local.cancel", { id: el!.dataset.id });
        return;
      case "local-use": {
        if (localError) throw new Error("Connect to Ollama first");
        const p = await rpc("profile.save", {
          name: el!.dataset.model,
          provider: "local",
          model: el!.dataset.model,
          baseUrl: localState.endpoint + "/v1",
          persona: "",
          shell: "",
          mcp: "[]",
        });
        profile = p;
        session = undefined;
        tabs = [];
        view = "chat";
        await refresh();
        return;
      }
      case "local-remove": {
        const model = el!.dataset.model;
        modal = "confirm";
        modalData = {
          title: "Remove this local model?",
          description: `Remove ${model} from Ollama on this Mac. You can download it again.`,
          confirm: async () => {
            await rpc("local.remove", { endpoint: localState.endpoint, model });
            await loadLocal();
          },
        };
        break;
      }
      case "checkpoints":
        if (!project) throw new Error("Open a project first");
        checkpoints = await rpc("checkpoint.list", { root: project });
        modal = "checkpoints";
        break;
      case "checkpoint-review":
        modalData.checkpoint = await rpc("checkpoint.inspect", {
          root: project,
          id: el!.dataset.id,
        });
        modal = "checkpoint";
        break;
      case "checkpoint-restore": {
        const c = modalData.checkpoint;
        modal = "confirm";
        modalData = {
          title: "Restore this file edit?",
          description: `Restore ${c.path} to its saved contents before this edit. Newer changes will block the restore.`,
          confirm: async () => {
            await rpc("checkpoint.restore", { root: project, id: c.id });
            if (pane === "git")
              git = await rpc("git.status", { root: project });
            preview = undefined;
          },
        };
        break;
      }
      case "new":
        modal = "";
        await newChat();
        return;
      case "nav":
        await navigate(el!.dataset.view!);
        return;
      case "session":
        await selectSession(el!.dataset.id!);
        return;
      case "settings":
      case "project":
      case "model":
      case "memory":
      case "palette":
      case "shortcuts":
      case "rename":
      case "branch":
      case "worktree":
        modal = name;
        if(name==="settings"){void updateCodex().catch(toast);void action("settings-model-catalog").catch(toast);}
        if(name==="model")void action("model-catalog").catch(toast);
        break;
      case "memory-add":
        modal = "memory";
        break;
      case "profile-new":
        modal = "profile";
        break;
      case "artifact-open": {
        const item = artifacts[Number(el!.dataset.index)];
        if (item.url) {
          pane = "preview";
          modalData.url = item.url;
        } else {
          setProject(item.root);
          pane = "files";
          folder = ".";
          files = await rpc("files.list", { root: project, path: "." });
          preview = await rpc("files.read", { root: project, path: item.path });
        }
        break;
      }
      case "profile-select":
        profile = undefined!;
        await rpc("profile.select", { id: el!.dataset.id });
        session = undefined;
        tabs = [];
        await refresh();
        view = "chat";
        break;
      case "session-export":
        download(
          "hades-conversation.json",
          JSON.stringify(
            await rpc("session.export", { id: current(), profile: profile.id }),
            null,
            2,
          ),
        );
        return;
      case "profile-export":
        download(
          `${profile.name}.hades.json`,
          JSON.stringify(
            await rpc("profile.export", { id: profile.id }),
            null,
            2,
          ),
        );
        return;
      case "modal-close":
        modal = "";
        break;
      case "project-hide": {
        const hidden = el!.dataset.path;
        await rpc("project.hide", { path: hidden });
        if (project === hidden) {
          setProject("");
          session = undefined;
          pane = "";
          preview = undefined;
        }
        await refresh();
        return;
      }
      case "project-pick": {
        const path = await tauri().dialog.open({
          directory: true,
          multiple: false,
          title: "Choose a Hades project",
        });
        if (path)
          root.querySelector<HTMLInputElement>("#project-path")!.value = path;
        return;
      }
      case "project-add":
        setProject(await rpc("project.add", { path: val("project-path") }));
        session = undefined;
        modal = "";
        await refresh();
        if (view !== "helm") await newChat();
        return;
      case "project-select":
        setProject(el!.dataset.path!);
        session = undefined;
        folder = ".";
        preview = undefined;
        view = "chat";
        if (pane === "files")
          files = await rpc("files.list", { root: project, path: "." });
        break;
      case "codex-status": await updateCodex(); return;
      case "codex-login": {
        if (codexPending) return;
        codexPending = true; render();
        try { await rpc("codex.login"); await updateCodex(); }
        catch (error) { codexPending = false; throw error; }
        return;
      }
      case "codex-cancel":
        await rpc("codex.cancel"); codexPending = false; await updateCodex(); return;
      case "codex-logout":
        await rpc("codex.logout"); await updateCodex(); return;
      case "settings-save": {
        const provider = val("settings-provider"),
          apiKey = val("settings-key");
        const p = await rpc("profile.save", {
          id: modal === "profile" ? undefined : profile.id,
          name: val("settings-name").trim() || (modal === "profile" ? "Hades" : profile.name),
          provider,
          model: val("settings-model"),
          baseUrl: val("settings-url"),
          persona: val("settings-persona"),
          shell: val("settings-shell"),
        });
        if (apiKey && provider !== "codex")
          await tauri().core.invoke("hades_key", {
            account: p.id + ":" + provider,
            value: apiKey,
          });
        profile = p;
        modal = "";
        await refresh();
        return;
      }
      case "settings-model-catalog":
      case "model-catalog": {
        const settings=name==="settings-model-catalog",version=++modelCatalogVersion,profileId=profile.id;
        await Promise.resolve();
        const provider=settings?(root.querySelector<HTMLSelectElement>("#settings-provider")?.value??profile.provider):profile.provider;
        const endpoint=settings?val("settings-url"):profile.baseUrl;
        const target=settings?"settings-model":"session-model";
        const status=settings?"settings-catalog-status":"model-catalog";
        try{
          const models:string[]=await rpc(provider==="codex"?"codex.models":settings?"models.catalog":"models.list",provider==="codex"?{}:settings?{provider,baseUrl:endpoint,profile:profileId}:{profile:profileId});
          if(version!==modelCatalogVersion||profile.id!==profileId)return;
          if(settings&&(root.querySelector<HTMLSelectElement>("#settings-provider")?.value!==provider||val("settings-url")!==endpoint))return;
          const select=root.querySelector<HTMLSelectElement>(`#${target}`);if(!select)return;
          const selected=select.value;providerCatalogs.set(JSON.stringify([profileId,provider,endpoint]),models);
          select.innerHTML=`${!models.includes(selected)?`<option value="${esc(selected)}">${esc(selected)} — unavailable in current catalog</option>`:""}${models.map(model=>`<option value="${esc(model)}">${esc(model)}</option>`).join("")}`;select.value=selected;
          const message=root.querySelector<HTMLElement>(`#${status}`);if(message)message.textContent=models.length?"Choose a model available from this provider.":"No models returned. Check the connection and retry.";
        }catch(e){if(version!==modelCatalogVersion||profile.id!==profileId)return;const message=root.querySelector<HTMLElement>(`#${status}`);if(message)message.textContent=`Catalog unavailable: ${String(e)}. Retry when connected.`;}
        return;
      }
      case "model-save": {
        const selectedModel = val("session-model");
        if (!session) await newChat();
        if (session) {
          await rpc("session.update", {
            id: current(),
            model: selectedModel,
            profile: profile.id,
          });
          session.model = selectedModel;
        }
        modal = "";
        break;
      }
      case "theme":
        theme = el!.dataset.theme!;
        localStorage.setItem("hades.theme", theme);
        applyTheme();
        root
          .querySelectorAll<HTMLElement>("[data-action=theme]")
          .forEach((b) =>
            { b.classList.toggle("active", b.dataset.theme === theme); b.setAttribute("aria-pressed", String(b.dataset.theme === theme)); },
          );
        return;
      case "zoom-in":
      case "zoom-out":
        fontSize = Math.min(
          20,
          Math.max(12, fontSize + (name === "zoom-in" ? 1 : -1)),
        );
        localStorage.setItem("hades.zoom", String(fontSize));
        applyTheme();
        for (const item of terminalViews.values()) { item.terminal.options.fontSize = Math.round(fontSize * 13 / 14); item.fit.fit(); }
        return;
      case "sidebar":
        sidebar = !sidebar;
        break;
      case "archive-view":
        archived = !archived;
        break;
      case "rename-save":
        await rpc("session.update", {
          id: current(),
          title: val("rename-title"),
          profile: profile.id,
        });
        session!.title = val("rename-title");
        modal = "";
        await refresh();
        return;
      case "pin":
        await rpc("session.update", {
          id: current(),
          pinned: !session?.pinned,
          profile: profile.id,
        });
        session!.pinned = !session!.pinned;
        modal = "";
        await refresh();
        return;
      case "archive":
        await rpc("session.update", {
          id: current(),
          archived: true,
          profile: profile.id,
        });
        tabs = tabs.filter(id => id !== current());
        rememberTabs();
        localStorage.removeItem("hades.lastSession");
        session = undefined;
        modal = "";
        await refresh();
        return;
      case "tab-close": {
        const id = el?.dataset.id ?? current();
        closedTabs.push(id);
        tabs = tabs.filter((x) => x !== id);
        rememberTabs();
        if (id === current()) {
          session = undefined;
          if (tabs.length) await selectSession(tabs.at(-1)!);
        }
        break;
      }
      case "tab-reopen": {
        const id = closedTabs.pop();
        if (id) await selectSession(id);
        break;
      }
      case "popout":
        await tauri().core.invoke("hades_window", {
          action: "window",
          session: current(),
        });
        modal = "";
        break;
      case "hud":
        await tauri().core.invoke("hades_window", {
          action: "hud",
          session: current(),
        });
        modal = "";
        break;
      case "files":
      case "git":
      case "terminal":
        modal = "";
        await loadPane(name);
        return;
      case "web-preview":
        pane = "preview";
        modal = "";
        break;
      case "preview-go": {
        const url = new URL(val("preview-url"));
        if (!["http:", "https:"].includes(url.protocol))
          throw new Error("Use an HTTP or HTTPS address");
        modalData.url = url.href;
        break;
      }
      case "open-link":
        await rpc("link.open", { url: el!.dataset.url });
        return;
      case "pane-close":
        pane = "";
        break;
      case "file":
        if (view === "workspace" && el!.dataset.dir !== "true") { await editor.open(project, el!.dataset.path!); return; }
        if (el!.dataset.dir === "true") {
          folder = el!.dataset.path!;
          files = await rpc("files.list", { root: project, path: folder });
          preview = undefined;
        } else
          preview = await rpc("files.read", {
            root: project,
            path: el!.dataset.path,
          });
        break;
      case "folder-up":
        folder = folder.includes("/")
          ? folder.slice(0, folder.lastIndexOf("/"))
          : ".";
        preview = undefined;
        files = await rpc("files.list", { root: project, path: folder });
        break;
      case "files-refresh":
        files = await rpc("files.list", { root: project, path: folder });
        break;
      case "file-save":
        await rpc("files.save", {
          root: project,
          path: preview!.path,
          content: val("file-content"),
          expectedRevision: preview!.revision,
        });
        preview = await rpc("files.read", { root: project, path: preview!.path });
        error = "";
        notice = "Saved " + preview!.path;
        break;
      case "file-open":
        await rpc("files.open", { root: project, path: preview!.path });
        return;
      case "file-context":
        draft += `\n\nFile: ${preview!.path}\n\`\`\`\n${val("file-content")}\n\`\`\``;
        view = "chat";
        break;
      case "git-refresh":
        git = await rpc("git.status", { root: project });
        break;
      case "git-stage":
      case "git-unstage":
        await rpc("git.action", {
          root: project,
          action: name === "git-stage" ? "stage" : "unstage",
          path: val("git-path"),
        });
        git = await rpc("git.status", { root: project });
        break;
      case "git-commit":
        if (!val("commit-message").trim())
          throw new Error("Write a commit message first");
        await rpc("git.action", {
          root: project,
          action: "commit",
          message: val("commit-message"),
        });
        git = await rpc("git.status", { root: project });
        break;
      case "git-push":
        modal = "confirm";
        modalData = {
          title: "Push this branch?",
          description:
            "Send the current branch’s commits to its configured remote.",
          confirm: async () => {
            await rpc("git.action", { root: project, action: "push" });
            git = await rpc("git.status", { root: project });
          },
        };
        break;
      case "confirm":
        await modalData.confirm();
        modal = "";
        break;
      case "branch-save":
        await rpc("git.action", {
          root: project,
          action: modal === "worktree" ? "worktree" : "branch",
          name: val("branch-name"),
          create: true,
        });
        modal = "";
        await refresh();
        git = await rpc("git.status", { root: project });
        break;
      case "terminal-new": {
        const t = await rpc("terminal.open", { root: project });
        boot.terminals.push(t);
        selectedTerminal = t.id;
        break;
      }
      case "terminal-select":
        selectedTerminal = el!.dataset.id!;
        break;
      case "terminal-close":
        await rpc("terminal.close", { id: selectedTerminal });
        terminalViews.get(selectedTerminal)?.observer.disconnect();
        terminalViews.get(selectedTerminal)?.rendering.dispose();
        terminalViews.get(selectedTerminal)?.terminal.dispose();
        terminalViews.delete(selectedTerminal);
        boot.terminals = boot.terminals.filter(
          (t: Row) => t.id !== selectedTerminal,
        );
        selectedTerminal = boot.terminals[0]?.id ?? "";
        break;
      case "terminal-interrupt":
        await rpc("terminal.write", { id: selectedTerminal, input: "\u0003" });
        return;
      case "terminal-context":
        draft +=
          "\n\nTerminal output:\n" +
          (terminalViews.get(selectedTerminal)?.terminal.getSelection() ||
            stripAnsi(
              boot.terminals.find((t: Row) => t.id === selectedTerminal)
                ?.output ?? "",
            ).slice(-16_000));
        view = "chat";
        break;
      case "memory-save":
        await rpc("memory.add", {
          profile: profile.id,
          fact: val("memory-fact"),
        });
        modal = "";
        await navigate("memory");
        return;
      case "memory-forget": {
        const id = el!.dataset.id;
        modal = "confirm";
        modalData = {
          title: "Forget this memory?",
          description: memory.find((m) => m.id === id)?.fact,
          confirm: async () => {
            await rpc("memory.forget", { id, profile: profile.id });
            memory = await rpc("memory.list", { profile: profile.id });
          },
        };
        break;
      }
      case "memory-detail":
        draft =
          "Recall and explain this memory: " +
          memory.find((m) => m.id === el!.dataset.id)?.fact;
        view = "chat";
        break;
      case "memory-export":
        download("hades-memory.json", JSON.stringify(memory, null, 2));
        return;
      case "skill-new":
        modal = "skill";
        modalData = {};
        break;
      case "skill-edit":
        modal = "skill";
        modalData = skills.find((s) => s.name === el!.dataset.name)!;
        break;
      case "skill-save":
        await rpc("skills.save", {
          profile: profile.id,
          name: val("skill-name"),
          content: val("skill-content"),
        });
        modal = "";
        await navigate("skills");
        return;
      case "skill-attach":
        draft += "\n\nApply this skill for the task:\n" + val("skill-content");
        view = "chat";
        modal = "";
        break;
      case "job-new":
        modalData = {}; modal = "job";
        break;
      case "job-save":
        if (val("job-schedule") === "cron" && !val("job-cron").trim()) throw new Error("Enter a cron expression for the custom schedule.");
        await rpc("job.save", {
          id: modalData.job?.id,
          name: val("job-name"),
          prompt: val("job-prompt"),
          intervalMinutes: Number(val("job-interval")),
          cron: val("job-schedule") === "cron" ? val("job-cron") : "",
          timeZone: val("job-schedule") === "cron" ? val("job-timezone") : "",
          root: modalData.job?.root || project,
          profile: profile.id,
        });
        modal = "";
        await refresh();
        break;
      case "job-edit":
        modalData = {job:boot.jobs.find((j:Row) => j.id === el!.dataset.id)}; modal = "job"; break;
      case "job-history":
        modalData = {job:boot.jobs.find((j:Row) => j.id === el!.dataset.id),runs:await rpc("job.runs", {id:el!.dataset.id,profile:profile.id})}; modal = "job-history"; break;
      case "job-remove": {
        const id = el!.dataset.id;
        modal = "confirm"; modalData = {title:"Remove routine?",description:"This removes future scheduling. Conversations and recorded runs remain available. Stop any pending run first.",confirm:async () => { await rpc("job.remove", {id,profile:profile.id}); await refresh(); }}; break;
      }
      case "job-toggle":
        await rpc("job.toggle", {
          id: el!.dataset.id,
          enabled: !boot.jobs.find((j: Row) => j.id === el!.dataset.id).enabled,
        });
        await refresh();
        return;
      case "task-inspector":
        taskInspector = !taskInspector; localStorage.setItem("hades.taskInspector", String(taskInspector)); break;
      case "computer-stop":
        await rpc("computer.stop");
        await refresh();
        return;
      case "job-cancel":
        await rpc("job.cancel", { id: el!.dataset.id });
        await refresh();
        return;
      case "job-run":
        await rpc("job.run", { id: el!.dataset.id });
        await refresh();
        return;
      case "stop":
        paused.add(current());
        await rpc("chat.stop", { id: current() });
        break;
      case "approve":
      case "deny":
        await rpc("approval.reply", {
          id: pendingApproval!.id,
          allow: name === "approve",
        });
        pendingApproval = undefined;
        break;
      case "queue-edit":
        draft = queued[current()].splice(Number(el!.dataset.index), 1)[0];
        break;
      case "queue-delete":
        queued[current()].splice(Number(el!.dataset.index), 1);
        break;
      case "queue-resume":
        paused.delete(current());
        if (!running()) {
          const q = queued[current()]?.shift();
          if (q) await send(q);
        }
        break;
      case "voice-record":
        if (recording) {
          recorder?.stop();
          recording = false;
          clearTimeout(recordingTimer);
        } else {
          const media = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          const chunks: BlobPart[] = [];
          recorder = new MediaRecorder(media, { mimeType: "audio/mp4" });
          recorder.ondataavailable = (e) => chunks.push(e.data);
          recorder.onstop = () => {
            media.getTracks().forEach((t) => t.stop());
            recording = false;
            render();
            const reader = new FileReader();
            reader.onload = () =>
              void rpc("voice.transcribe", {
                profile: profile.id,
                audio: String(reader.result).split(",")[1],
              })
                .then((transcript) => {
                  draft += (draft ? "\n" : "") + transcript;
                  render();
                })
                .catch(toast);
            reader.readAsDataURL(new Blob(chunks, { type: "audio/mp4" }));
          };
          recorder.start();
          recording = true;
          recordingTimer = setTimeout(() => {
            if (recorder?.state === "recording") recorder.stop();
          }, 120_000);
        }
        break;
      case "speak-message":
        await rpc("voice.speak", {
          text: session!.messages[Number(el!.dataset.index)].content,
        });
        return;
      case "voice-stop":
        await rpc("voice.stop");
        return;
      case "awake-on":
      case "awake-off":
        await rpc("awake.set", { enabled: name === "awake-on" });
        error = "";
        notice =
          name === "awake-on"
            ? "Hades will keep this Mac awake while the app is running."
            : "Normal sleep behavior restored.";
        break;
      case "quick-entry":
        await tauri().core.invoke("hades_quick_entry", {
          enabled: !quickEntry,
        });
        quickEntry = !quickEntry;
        localStorage.setItem("hades.quickEntry", String(quickEntry));
        error = "";
        notice = quickEntry
          ? "Quick Entry enabled: ⌘ ⇧ Space"
          : "Quick Entry disabled";
        break;
      case "profile-import":
        root.querySelector<HTMLInputElement>("#profile-import-file")!.click();
        return;
      case "copy-message":
        await navigator.clipboard.writeText(
          session!.messages[Number(el!.dataset.index)].content,
        );
        return;
      case "image-remove":
        draftImages.splice(Number(el!.dataset.index), 1);
        break;
      case "attach":
        root.querySelector<HTMLInputElement>("#attachments")!.click();
        return;
      case "find-close":
        find = "";
        break;
      case "find-next": {
        const q = val("find-input").toLowerCase();
        const matches = Array.from(
          root.querySelectorAll<HTMLElement>(".message-body"),
        ).filter((el) => el.textContent?.toLowerCase().includes(q));
        const index = Number(modalData.findIndex ?? -1) + 1;
        modalData.findIndex = index;
        matches[index % matches.length]?.scrollIntoView({
          block: "center",
          behavior: "smooth",
        });
        return;
      }
      case "dismiss":
        error = "";
        notice = "";
        break;
      case "harness":
        await tauri().core.invoke("hades_command", {
          cmd: { kind: el!.dataset.kind },
        });
        return;
    }
    render();
    if (modal)
      (
        root.querySelector<HTMLInputElement>(
          '.modal input:not([type="hidden"]), .modal textarea, .modal select',
        ) ?? root.querySelector<HTMLButtonElement>(".modal button")
      )?.focus();
  }
  async function attachFiles(list: FileList | File[]) {
    for (const file of Array.from(list)) {
      if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
        if (file.size > 6_000_000 || draftImages.length >= 5)
          throw new Error("Attach up to five images, at most 6 MB each.");
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("Could not read image"));
          reader.readAsDataURL(file);
        });
        draftImages.push(data);
        continue;
      }
      if (file.size > 90_000)
        throw new Error(
          `${file.name} is too large; text attachments must be under 90 KB.`,
        );
      if (file.type === "application/pdf")
        throw new Error(
          "PDF extraction is not available. Attach exported text or images instead.",
        );
      const attached = `\n\nAttached file: ${file.name}\n\`\`\`\n${await file.text()}\n\`\`\``;
      if (draft.length + attached.length > 100_000)
        throw new Error(
          "The message and attachments exceed 100,000 characters.",
        );
      draft += attached;
    }
    render();
  }

  root.addEventListener("click", e => {
    const menu = root.querySelector<HTMLDetailsElement>(".toolbar-menu[open]");
    if (menu && !menu.contains(e.target as Node)) menu.open = false;
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (el && !el.hasAttribute("disabled")) void action(el.dataset.action!, el).catch(toast);
  });
  function bind() {
    const input = (id: string, cb: (v: string) => void) => {
      const el = root.querySelector<HTMLInputElement>("#" + id);
      if (el) el.oninput = () => cb(el.value);
    };
    const routineSchedule = root.querySelector<HTMLSelectElement>("#job-schedule");
    if (routineSchedule) {
      const updateSchedule = () => {
        root.querySelector<HTMLElement>("#job-cron-fields")!.hidden = routineSchedule.value !== "cron";
        root.querySelector<HTMLElement>("#job-interval-fields")!.hidden = routineSchedule.value === "cron";
      };
      routineSchedule.onchange = updateSchedule; updateSchedule();
    }
    input("harness-search", v => root.querySelectorAll<HTMLElement>(".harness-item").forEach(item => item.hidden = !item.textContent!.toLowerCase().includes(v.toLowerCase())));
    input("composer", (v) => {
      draft = v;
    });
    input("session-search", (v) => {
      search = v;
      render();
    });
    input("find-input", (v) => {
      find = v || " ";
    });
    input("terminal-input", (v) => {
      terminalInput = v;
    });
    input("palette-search", (v) =>
      root
        .querySelectorAll<HTMLElement>(".palette-item")
        .forEach(
          (el) =>
            (el.hidden = !el
              .textContent!.toLowerCase()
              .includes(v.toLowerCase())),
        ),
    );
    const form = root.querySelector<HTMLFormElement>("#composer-form");
    if (form)
      form.onsubmit = (e) => {
        e.preventDefault();
        void send().catch(toast);
      };
    const terminalForm = root.querySelector<HTMLFormElement>("#terminal-form");
    if (terminalForm)
      terminalForm.onsubmit = (e) => {
        e.preventDefault();
        void rpc("terminal.write", {
          id: selectedTerminal,
          input: terminalInput + "\n",
        })
          .then(() => {
            terminalInput = "";
            const el = root.querySelector<HTMLInputElement>("#terminal-input");
            if (el) el.value = "";
          })
          .catch(toast);
      };
    const composer = root.querySelector<HTMLTextAreaElement>("#composer");
    if (composer) bindChatCommands(composer, root.querySelector<HTMLElement>("#chat-command-options")!, value => { draft = value; }, () => rpc("skills.list", {profile:profile.id}));
    if (composer)
      composer.onkeydown = (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          void send().catch(toast);
        }
        if (
          (e.key === "ArrowUp" || e.key === "ArrowDown") &&
          (!draft || historyIndex < promptHistory.length)
        ) {
          e.preventDefault();
          historyIndex = Math.max(
            0,
            Math.min(
              promptHistory.length,
              historyIndex + (e.key === "ArrowUp" ? -1 : 1),
            ),
          );
          draft = promptHistory[historyIndex] ?? "";
          composer.value = draft;
        }
      };
    const importFile = root.querySelector<HTMLInputElement>(
      "#profile-import-file",
    );
    if (importFile)
      importFile.onchange = () => {
        const file = importFile.files?.[0];
        if (file)
          void file
            .text()
            .then((content) => rpc("profile.import", { content }))
            .then(() => {
              modal = "";
              session = undefined;
              profile = undefined!;
              return refresh();
            })
            .catch(toast);
      };
    const attachments = root.querySelector<HTMLInputElement>("#attachments");
    if (attachments)
      attachments.onchange = () =>
        void attachFiles(attachments.files ?? []).catch(toast);
    const profileSelect =
      root.querySelector<HTMLSelectElement>("#profile-switch");
    if (profileSelect)
      profileSelect.onchange = () => {
        const nextProfile = boot.profiles.find((p: Profile) => p.id === profileSelect.value);
        void rpc("profile.select", { id: profileSelect.value })
          .then(() => {
            ++sessionSelection;
            profile = nextProfile;
            session = undefined;
            artifacts = [];
            tabs = [];
            rememberTabs();
            localStorage.removeItem("hades.lastSession");
            return refresh();
          })
          .catch(toast);
      };
    const roomInput = root.querySelector<HTMLTextAreaElement>("#room-draft");
    if (roomInput)
      roomInput.oninput = () => {
        roomDraft = roomInput.value;
      };
    const pluginFile = root.querySelector<HTMLInputElement>(
      "#plugin-import-file",
    );
    if (pluginFile)
      pluginFile.onchange = () =>
        void (async () => {
          const f = pluginFile.files?.[0];
          if (!f) return;
          if (f.size > 250_000)
            throw new Error("Plugin file is limited to 250 KB");
          const content = await f.text(),
            plugin = await rpc("plugins.inspect", { content });
          modalData = { content, plugin };
          modal = "plugin";
          render();
        })().catch(toast);
    const themeFile =
      root.querySelector<HTMLInputElement>("#theme-import-file");
    if (themeFile)
      themeFile.onchange = () =>
        void (async () => {
          const f = themeFile.files?.[0];
          if (!f) return;
          if (f.size > 1_000_000)
            throw new Error("Theme file is limited to 1 MB");
          const content = await f.text();
          importedTheme = parseTheme(content);
          localStorage.setItem("hades.importedTheme", content);
          theme = "custom";
          localStorage.setItem("hades.theme", theme);
          applyTheme();
        })().catch(toast);
    const skillFile =
      root.querySelector<HTMLInputElement>("#skill-import-file");
    if (skillFile)
      skillFile.onchange = () =>
        void (async () => {
          const f = skillFile.files?.[0];
          if (!f) return;
          if (f.size > 100_000) throw new Error("Skill is limited to 100 KB");
          modalData = {
            name: f.name
              .replace(/\.md$/i, "")
              .replace(/[^a-zA-Z0-9_-]/g, "-")
              .toLowerCase(),
            content: await f.text(),
          };
          modal = "skill";
          render();
        })().catch(toast);
    const providerSelect =
      root.querySelector<HTMLSelectElement>("#settings-provider");
    if (providerSelect) providerSelect.onchange = () => {
      const item = providers[providerSelect.value as keyof typeof providers];
      root.querySelector<HTMLInputElement>("#settings-url")!.value = item.url;
      root.querySelector<HTMLElement>("#settings-model-control")!.innerHTML = settingsModelHTML(providerSelect.value,item.model,item.url);
      root.querySelector<HTMLInputElement>("#settings-key")!.value = "";
      root.querySelector<HTMLElement>("#api-connection")!.hidden = !item.key;
      root.querySelector<HTMLElement>("#codex-connection")!.hidden = item.key;
      if (!item.key) void updateCodex().catch(toast);
      void action("settings-model-catalog").catch(toast);
    };
    root
      .querySelector(".breadcrumb strong")
      ?.addEventListener("dblclick", () => {
        if (session) {
          modal = "rename";
          render();
        }
      });
    const backdrop = root.querySelector(".modal-backdrop");
    backdrop?.addEventListener("click", (e) => {
      if (e.target === backdrop) {
        modal = "";
        render();
      }
    });
    const host = root.querySelector<HTMLElement>("#terminal-host");
    if (host && selectedTerminal) {
      let item = terminalViews.get(selectedTerminal);
      if (!item) {
        const id = selectedTerminal,
          node = document.createElement("div");
        node.className = "terminal-surface";
        const terminal = new Terminal({
          fontFamily: "SFMono-Regular, Menlo, monospace",
          fontSize: Math.round(fontSize * 13 / 14),
          theme: {
            background: "#1c1c1e",
            foreground: "#f1f1f3",
            cursor: "#e16b58",
          },
          cursorBlink: true,
          screenReaderMode: true,
          scrollback: 5000,
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        host.append(node);
        terminal.open(node);
        terminal.onData(
          (input) => void rpc("terminal.write", { id, input }).catch(toast),
        );
        terminal.onResize(
          ({ cols, rows }) =>
            void rpc("terminal.resize", { id, cols, rows }).catch(toast),
        );
        terminal.attachCustomKeyEventHandler((e) => !e.metaKey);
        const rendering = terminalRendering(terminal, node, () => fit.fit());
        const observer = new ResizeObserver(() => rendering.recover());
        observer.observe(node);
        item = { terminal, fit, node, observer, rendering };
        terminalViews.set(id, item);
        terminal.write(
          boot.terminals.find((t: Row) => t.id === id)?.output ?? "",
        );
      }
      host.append(item.node);
      item.terminal.options.fontSize = Math.round(fontSize * 13 / 14);
      item.rendering.recover();

    }
  }
  function onKey(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    if (e.key === "Tab" && modal) {
      const dialog = root.querySelector<HTMLElement>(".modal");
      const elements = dialog ? dialogFocusable(dialog) : [];
      const active = document.activeElement as HTMLElement;
      if (!elements.includes(active) || (e.shiftKey ? active === elements[0] : active === elements.at(-1))) {
        e.preventDefault();
        (e.shiftKey ? elements.at(-1) : elements[0])?.focus();
      }
      return;
    }
    if (e.key === "Escape") {
      const windowMenu = root.querySelector<HTMLDetailsElement>(".toolbar-menu[open]");
      if (windowMenu && !modal) { windowMenu.open = false; root.querySelector<HTMLElement>("#window-actions")?.focus(); return; }
      if (modal) {
        modal = "";
        render();
      } else if (find) {
        find = "";
        render();
      } else if (sidebar && matchMedia("(max-width: 800px)").matches) {
        sidebar = false; render(); root.querySelector<HTMLElement>("#toggle-sidebar")?.focus();
      } else if (pane) { pane = ""; render(); }
      else if (running()) void action("stop").catch(toast);
      return;
    }
    if (modal) return;
    if (e.ctrlKey && e.key === "`") {
      e.preventDefault();
      void action("terminal").catch(toast);
      return;
    }
    if (e.ctrlKey && e.key === "Tab" && tabs.length) {
      e.preventDefault();
      const i = tabs.indexOf(current());
      void selectSession(
        tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length],
      ).catch(toast);
      return;
    }
    if ((e.target as HTMLElement)?.closest(".cm-editor") && ["s", "f", "g", "h", "z", "a", "c", "v", "x"].includes(e.key.toLowerCase())) return;
    if ((e.target as HTMLElement)?.closest(".xterm") && !e.metaKey) return;
    if (!(e.metaKey || e.ctrlKey)) return;
    const binding = Object.entries(bindings).find(
      ([, key]) => key === eventShortcut(e),
    )?.[0];
    if (binding) {
      e.preventDefault();
      void action(binding).catch(toast);
    }
  }
  document.addEventListener("keydown", onKey);
  root.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  root.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files.length)
      void attachFiles(e.dataTransfer.files).catch(toast);
  });
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  async function start() {
    root.innerHTML =
      '<div class="boot-error"><h2>Opening your workspace…</h2></div>';
    if (!tauri()?.core) {
      root.innerHTML =
        '<div class="boot-error"><h1>Open Hades.app</h1><p>This interface connects through its native Mac app. Run ./script/build_and_run.sh to launch it.</p></div>';
      return;
    }
    unlisten = await tauri().event.listen(
      "hades_event",
      ({ payload: e }: { payload: Row }) => {
        if(e.kind==='desktop.ecosystem'){if(view==='ecosystem'&&e.profile===profile.id)ecosystem.changed();return;}
        if (e.kind === "desktop.channels.changed" || e.kind === "desktop.slack.changed") {
          if (view === "channels") void channels.refresh();
        }
        if (e.kind === "desktop.browser.changed" && view === "browser") void browserView.refresh();
        if (e.kind === "desktop.hooks.changed" && view === "hooks") void hooks.refresh();
        if (e.kind === "desktop.webhook") {
          if (view === "webhooks") void webhooks.refresh();
          return;
        }
        if (e.kind === "desktop.helm") { if(view === "chat")void chatWork.refresh(); return; }
        if (e.kind === "desktop.work") {
          if(view === "chat" && (!e.profile || e.profile === profile.id))void chatWork.refresh();
          if (view === "work" && (!e.profile || e.profile === profile.id)) void workGoals.refresh();
          if (historyOpen && (!e.profile || e.profile === profile.id)) void workGoals.refresh();
          return;
        }
        if (e.kind === "desktop.codex.auth") {
          codexPending = false; void updateCodex(); return;
        }
        if (
          room &&
          ((e.kind === "desktop.room" && e.id === room.id) ||
            (["desktop.approval", "desktop.done"].includes(e.kind) &&
              Object.values(room.sessions).includes(e.session)))
        ) {
          const roomId = room.id;
          void rpc("room.get", { id: roomId })
            .then((updated) => {
              if (room?.id === roomId) {
                room = updated;
                if (view === "rooms") render();
              }
            })
            .catch(toast);
        }
        if (e.kind === "desktop.download") {
          boot.downloads = [
            ...(boot.downloads ?? []).filter((d: Row) => d.id !== e.id),
            e,
          ];
          if (view === "models") {
            const downloads = root.querySelector("#downloads");
            if (downloads) {
              downloads.innerHTML = downloadHTML();
              downloads
                .querySelectorAll<HTMLElement>("button[data-action]")
                .forEach(
                  (b) =>
                    (b.onclick = () =>
                      void action(b.dataset.action!, b).catch(toast)),
                );
            }
            if (e.done) void loadLocal().then(render).catch(toast);
          }
          return;
        }
        if (e.kind === "desktop.disconnected") {
          connected = false;
          error = "The local backend stopped. Restart Hades to reconnect.";
          render();
          return;
        }
        if (e.kind === "desktop.changed") {
          clearTimeout(refreshTimer);
          refreshTimer = setTimeout(() => {
            if (!modal) void refresh().catch(toast);
          }, 200);
          return;
        }
        if (e.kind === "desktop.terminal") {
          const t = boot.terminals.find((t: Row) => t.id === e.id);
          if (t) t.output = (t.output + e.chunk).slice(-200_000);
          terminalViews.get(e.id)?.terminal.write(e.chunk);
          return;
        }
        if (e.kind === "desktop.done") {
          boot.active = boot.active.filter((id: string) => id !== e.session);
          if (e.session === current()) {
            activity = [...activity, e].slice(-512);
            stream = "";
            pendingApproval = undefined;
            const q = !paused.has(current())
              ? queued[current()]?.shift()
              : undefined;
            if (q) void send(q).catch(toast);
          }
          void refresh().catch(toast);
          return;
        }
        if (e.session && e.session !== current()) return;
        if (e.kind === "desktop.delta") {
          stream += e.chunk;
          const el = root.querySelector(".live-output");
          if (el) el.textContent = visibleResponse(stream);
          return;
        }
        if (e.kind === "desktop.session") {
          session = { ...session, ...e.record, title: session?.title };
        }
        if (e.kind === "desktop.started") {
          activity = [...activity, e].slice(-512);
          if (!boot.active.includes(e.session)) boot.active.push(e.session);
        }
        if (e.kind === "desktop.hook") activity = [...activity, e].slice(-512);
        if (e.kind === "desktop.tool") {
          activity = [...activity, e].slice(-512);
          if (e.status === "done") stream = "";
        }
        if (e.kind === "desktop.usage") usage = e;
        if (e.kind === "desktop.error") {
          error = sessionError = e.message;
          paused.add(current());
        }
        if (e.kind === "desktop.approval") pendingApproval = e;
        if (!e.kind.startsWith("desktop."))
          modalData.harness = JSON.stringify(e, null, 2);
        render();
      },
    );
    await refresh();
    await Promise.all(["team-access", "slack-bot", "slack-app", ...(boot.credentialAccounts ?? [])].map(account => tauri().core.invoke("hades_key", { account, value: null }).catch(toast)));
    await Promise.all(
      boot.profiles.filter((p: Profile) => p.provider !== "codex").map((p: Profile) =>
        tauri()
          .core.invoke("hades_key", {
            account: p.id + ":" + p.provider,
            value: null,
          })
          .catch(toast),
      ),
    );
    if (quickEntry)
      await tauri()
        .core.invoke("hades_quick_entry", { enabled: true })
        .catch(toast);
    const requested =
      new URLSearchParams(location.search).get("session") ||
      localStorage.getItem("hades.lastSession");
    if (
      requested &&
      boot.sessions.some(
        (s: Row) =>
          s.id === requested &&
          (!s.archived || new URLSearchParams(location.search).has("session")),
      )
    )
      await selectSession(requested);
  }
  void start().catch(toast);
  window.addEventListener("beforeunload", () => {
    ecosystem.dispose();
    companyOsSettings.mount(undefined);
    teamChat.destroy();
    slackView.destroy();
    editor.destroy();
    chatWork.dispose();
    unlisten?.();
    document.removeEventListener("keydown", onKey);
    for (const item of terminalViews.values()) {
      item.observer.disconnect();
      item.rendering.dispose();
      item.terminal.dispose();
    }
  });
}
function stripAnsi(s: string) {
  return s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[^\n\t\x20-\uFFFF]/g, "");
}
function download(name: string, content: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([content], { type: "application/json" }),
  );
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function visibleResponse(text: string) {
  if (/^TOOL:|^T(?:O(?:O(?:L)?)?)?$/i.test(text.trim())) return "";
  return text.replace(/^ANSWER:\s*/i, "");
}
