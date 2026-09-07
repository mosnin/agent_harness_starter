/** Chat-first native workbench. No Node imports, remote scripts or browser server. */
import type { Profile } from "../core/workbench-service";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./workbench.css";
type Row = Record<string, any>;
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const icon = (name: string) =>
  `<span class="glyph" aria-hidden="true">${({ chat: "◫", files: "⌑", memory: "✳", skills: "⌘", jobs: "◷", settings: "⚙", git: "⑂", terminal: "›_", artifact: "◇", agents: "⠿" } as Row)[name] ?? name}</span>`;
const button = (label: string, action: string, extra = "") =>
  `<button type="button" data-action="${action}" ${extra}>${label}</button>`;
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
  let quickEntry = localStorage.getItem("hades.quickEntry") === "true";
  let connected = false,
    sidebar = true,
    statusbar = true,
    archived = false,
    theme = localStorage.getItem("hades.theme") ?? "system",
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
    }
  >();
  const applyTheme = () => {
    document.documentElement.dataset.theme =
      theme === "system"
        ? matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : theme;
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
    profile = boot.profiles.find((p: Profile) => p.id === boot.activeProfile);
    project = project || boot.projects[0] || "";
    if (session) {
      const row = boot.sessions.find((s: Row) => s.id === session!.id);
      if (row) session.title = row.title;
    }
    render();
  }
  const current = () => session?.id ?? "";
  const running = () => boot.active.includes(current());
  const labelProject = (p: string) => p.split("/").filter(Boolean).at(-1) ?? p;
  function toast(e: unknown) {
    error = e instanceof Error ? e.message : String(e);
    render();
  }
  function rememberTabs() {
    localStorage.setItem("hades.tabs", JSON.stringify(tabs));
  }
  async function selectSession(id: string) {
    const meta = boot.allSessions?.find((s: Row) => s.id === id);
    if (meta && meta.profile !== profile.id) {
      profile = boot.profiles.find((p: Profile) => p.id === meta.profile);
      await refresh();
    }
    const s = await rpc("session.get", { id, profile: profile.id });
    session = s;
    project = s.root || project;
    view = "chat";
    stream = s.progress?.stream ?? "";
    activity = s.progress?.tools ?? [];
    usage = s.progress?.usage ?? {};
    pendingApproval = s.progress?.approval;
    if (!tabs.includes(id)) tabs.push(id);
    rememberTabs();
    localStorage.setItem("hades.lastSession", id);
    render();
  }
  async function newChat() {
    if (!project) {
      modal = "project";
      render();
      return;
    }
    session = await rpc("session.new", { root: project, profile: profile.id });
    tabs.push(current());
    rememberTabs();
    view = "chat";
    activity = [];
    stream = "";
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
      if (draftImages.length)
        throw new Error(
          "Wait for this turn to finish before sending image attachments.",
        );
      (queued[current()] ??= []).push(input);
      draft = "";
      render();
      return;
    }
    await tauri().core.invoke("hades_key", {
      account: profile.id + ":" + profile.provider,
      value: null,
    });
    await rpc("chat.send", {
      id: current(),
      profile: profile.id,
      root: project,
      input,
      images: draftImages,
    });
    promptHistory.push(input);
    historyIndex = promptHistory.length;
    draft = "";
    error = "";
    stream = "";
    usage = {};
    activity = [];
    session.messages.push({
      role: "user",
      content: input,
      at: Date.now(),
      images: draftImages,
    });
    draftImages = [];
    boot.active.push(current());
    render();
  }
  async function loadPane(next: string) {
    pane = pane === next ? "" : next;
    if (pane === "files" && project)
      files = await rpc("files.list", { root: project, path: folder });
    if (pane === "git" && project)
      git = await rpc("git.status", { root: project });
    if (pane === "terminal" && !selectedTerminal && project) {
      const t = await rpc("terminal.open", { root: project });
      boot.terminals.push(t);
      selectedTerminal = t.id;
    }
    render();
  }
  function heading(title: string, sub: string) {
    return `<div class="page-heading"><div><span class="eyebrow">HADES / ${esc(view.toUpperCase())}</span><h1>${title}</h1><p>${sub}</p></div></div>`;
  }
  function nav(name: string, label: string) {
    return button(
      icon(name) + label,
      "nav",
      `data-view="${name}" class="nav-item ${view === name ? "selected" : ""}"`,
    );
  }
  function render() {
    const activeEl = document.activeElement as
        | HTMLInputElement
        | HTMLTextAreaElement
        | null,
      focusId = activeEl?.id,
      selection =
        activeEl && "selectionStart" in activeEl
          ? activeEl.selectionStart
          : null;
    const transcript = root.querySelector(".transcript"),
      oldScroll = transcript?.scrollTop ?? 0,
      atEnd = transcript
        ? transcript.scrollHeight -
            transcript.scrollTop -
            transcript.clientHeight <
          70
        : true;
    root.innerHTML = `<div class="workbench ${!sidebar ? "hide-sidebar" : ""} ${location.search.includes("hud=1") ? "hud" : ""}">
   <aside class="sidebar"><div class="window-space" data-tauri-drag-region></div><div class="brand"><img src="./assets/hades-icon.png" alt="Hades logo"><strong>Hades</strong><span class="mono">[H]</span></div>
   ${button(icon("+") + "New conversation <kbd>⌘ N</kbd>", "new", 'class="new-chat"')}
   <div class="sidebar-nav">${nav("chat", "Conversations")}${nav("artifact", "Artifacts")}${nav("memory", "Memory")}${nav("skills", "Skills")}${nav("jobs", "Routines")}${nav("agents", "Command Center")}</div>
   <div class="section-label">PROJECTS ${button("+", "project", 'aria-label="Open project"')}</div><div class="project-list">${boot.projects.length ? boot.projects.map((p: string) => `<div class="project-row ${project === p ? "active" : ""}">${button(icon("files") + esc(labelProject(p)), "project-select", `data-path="${esc(p)}" title="${esc(p)}"`)}</div>`).join("") : `<p class="sidebar-hint">Open a folder to give<br>your work a home.</p>`}</div>
   <div class="section-label">${archived ? "ARCHIVED" : "RECENT"} ${button(archived ? "←" : "⋯", "archive-view", 'aria-label="Toggle archived conversations"')}</div>
   <input id="session-search" class="search" aria-label="Search conversations" placeholder="Search conversations" value="${esc(search)}">
   <div class="session-list">${
     boot.sessions
       .filter(
         (s: Row) =>
           !!s.archived === archived &&
           (!search ||
             JSON.stringify(s).toLowerCase().includes(search.toLowerCase())),
       )
       .map((s: Row) =>
         button(
           `${s.pinned ? "⌁ " : ""}${esc(s.title || "Untitled conversation")}${boot.active.includes(s.id) ? '<span class="running-dot"></span>' : ""}`,
           "session",
           `data-id="${esc(s.id)}" class="session-row ${current() === s.id ? "selected" : ""}" title="${esc(s.preview || s.id)}"`,
         ),
       )
       .join("") ||
     '<p class="sidebar-hint">Your conversations appear here.</p>'
   }</div>
   <div class="sidebar-footer"><select id="profile-switch" aria-label="Agent profile">${boot.profiles.map((p: Profile) => `<option value="${p.id}" ${p.id === profile?.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>${button(icon("settings"), "settings", 'class="icon-button" aria-label="Settings" title="Settings ⌘ ,"')}</div></aside>
   <main class="main"><header class="toolbar" data-tauri-drag-region>${button("◧", "sidebar", 'class="icon-button" aria-label="Toggle sidebar"')}<div class="breadcrumb">${esc(project ? labelProject(project) : "Your workspace")} <span>/</span> <strong>${esc(view === "chat" ? session?.title || "New conversation" : ({ artifact: "Artifacts", memory: "Memory", skills: "Skills", jobs: "Routines", agents: "Command Center" } as Row)[view])}</strong></div><div class="toolbar-actions">${button("⌕", "palette", 'class="icon-button" aria-label="Command palette" title="Command palette ⌘ K"')}${button("↗", "popout", 'class="icon-button" aria-label="Open conversation in new window"')}${button("▱", "hud", 'class="icon-button" aria-label="Floating chat"')}${button(icon("files"), "files", 'class="icon-button" aria-label="File browser"')}${button(icon("git"), "git", 'class="icon-button" aria-label="Git review"')}${button(icon("terminal"), "terminal", 'class="icon-button" aria-label="Terminal"')}</div></header>
   ${
     view === "chat" && tabs.length > 1
       ? `<div class="tabs">${tabs
           .filter((id) => boot.sessions.some((s: Row) => s.id === id))
           .map(
             (id) =>
               `<div class="tab ${id === current() ? "active" : ""}">${button(esc(boot.sessions.find((s: Row) => s.id === id)?.title || "New chat"), "session", `data-id="${id}"`)}${button("×", "tab-close", `data-id="${id}" aria-label="Close tab"`)}</div>`,
           )
           .join("")}${button("+", "new", 'aria-label="New tab"')}</div>`
       : ""
   }
   ${error ? `<div class="error" role="alert">${esc(error)}${button("×", "dismiss", 'aria-label="Dismiss error"')}</div>` : ""}
   <div class="body"><section class="primary">${view === "chat" ? chatHTML() : pageHTML()}</section>${pane ? paneHTML() : ""}</div>
   ${statusbar ? `<footer class="statusbar"><span><i class="${running() ? "busy" : ""}"></i>${running() ? "Working" : connected ? "Local backend" : "Disconnected"} <span class="muted">/</span> ${esc(profile?.name || "Connecting")}</span><span>${usage.tokensIn !== undefined ? `${usage.tokensIn.toLocaleString()} in · ${usage.tokensOut.toLocaleString()} out · ${usage.costMeasured ? "~$" + usage.usd.toFixed(4) : "price unavailable"}` : "Workspace files · ask before changes"} <span class="muted">⌘ K</span></span></footer>` : ""}</main></div>${modal ? modalHTML() : ""}`;
    bind();
    if (focusId) {
      const el = root.querySelector<HTMLInputElement>(
        `#${CSS.escape(focusId)}`,
      );
      el?.focus();
      if (
        selection !== null &&
        el &&
        ["text", "search", "password", "textarea"].includes(el.type)
      )
        try {
          el.setSelectionRange(selection, selection);
        } catch {}
    }
    const t = root.querySelector(".transcript");
    if (t) t.scrollTop = atEnd ? t.scrollHeight : oldScroll;
  }
  function chatHTML() {
    const messages = session?.messages ?? [];
    return `${find !== "" ? `<div class="findbar"><input id="find-input" placeholder="Find in conversation" value="${esc(find === " " ? "" : find)}" aria-label="Find in conversation">${button("↓", "find-next")}${button("×", "find-close", 'aria-label="Close find"')}</div>` : ""}
  <div class="transcript" role="log" aria-label="Conversation">${!messages.length ? `<div class="welcome"><div class="welcome-mark"><img src="./assets/hades-icon.png" alt=""><span class="ascii-orbit">+ &nbsp; · &nbsp; +<br>· &nbsp; &nbsp; &nbsp; ·<br>+ &nbsp; · &nbsp; +</span></div><span class="eyebrow">A LITTLE LESS FRICTION.</span><h1>Where should we begin?</h1><p>A thought, a project, a loose end.<br>Give it to Hades and make something of it.</p><div class="starter-actions">${button("⌑ &nbsp; Open a project", "project")}${button("⌘ &nbsp; Set up your model", "settings")}${button("✳ &nbsp; Explore memory", "nav", 'data-view="memory"')}</div></div>` : messages.map((m: Row, i: number) => `<article id="message-${i}" class="message ${m.role}"><div class="message-label">${m.role === "user" ? "YOU" : `<img src="./assets/hades-icon.png" alt=""> ${esc(profile.name)}`}<time>${new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>${m.role === "assistant" ? button("♪", "speak-message", `data-index="${i}" aria-label="Read message aloud"`) : ""}${button("⧉", "copy-message", `data-index="${i}" aria-label="Copy message"`)}</div><div class="message-body">${m.images?.map((image: string) => `<img class="chat-attachment" src="${esc(image)}" alt="Attached image">`).join("") ?? ""}${formatText(m.content)}</div></article>`).join("")}
  ${running() ? `<article class="message assistant"><div class="message-label"><img src="./assets/hades-icon.png" alt="">${esc(profile.name)} <span class="working">Working<span>...</span></span></div><div class="message-body live-output">${formatText(visibleResponse(stream))}</div></article>` : ""}
  ${activity.length ? `<details class="activity" ${pendingApproval ? "open" : ""}><summary>${icon("terminal")}${activity.length} tool events</summary>${activity.map((t) => `<div><span class="mono">${esc(t.tool)} · ${esc(t.status)}</span><pre>${esc(t.output ?? t.input)}</pre></div>`).join("")}</details>` : ""}
  ${pendingApproval ? `<div class="approval" role="alert"><strong>Hades needs your approval</strong><p>${esc(pendingApproval.tool)}</p><pre>${esc(pendingApproval.input)}</pre>${button("Allow once", "approve", 'class="primary-button"')}${button("Deny", "deny")}</div>` : ""}</div>
  <div class="composer-area">${(queued[current()] ?? []).length ? `<div class="queue"><span class="eyebrow">${paused.has(current()) ? "PAUSED" : "QUEUED"} · ${queued[current()].length}</span>${queued[current()].map((q, i) => `<div><span>${esc(q.slice(0, 120))}</span>${button("Edit", "queue-edit", `data-index="${i}"`)}${button("×", "queue-delete", `data-index="${i}" aria-label="Delete queued message"`)}</div>`).join("")}${paused.has(current()) ? button("Resume queue", "queue-resume") : ""}</div>` : ""}
  <div class="attachment-tray">${draftImages.map((src, i) => `<div><img src="${esc(src)}" alt="Image attachment ${i + 1}">${button("×", "image-remove", `data-index="${i}" aria-label="Remove image"`)}</div>`).join("")}</div><form id="composer-form" class="composer"><textarea id="composer" aria-label="Message Hades" placeholder="${project ? "Ask anything, or describe what you want to make…" : "Open a project, then tell Hades what’s on your mind…"}" rows="3">${esc(draft)}</textarea><div class="composer-bottom"><div>${button("+", "attach", 'class="icon-button" aria-label="Attach files or images"')}<input id="attachments" type="file" multiple hidden accept="image/png,image/jpeg,image/gif,image/webp,text/*,.md,.json,.ts,.tsx,.py,.js,.csv,.html,.css,.yaml,.yml">${button(recording ? "■" : "◉", "voice-record", `class="icon-button ${recording ? "recording" : ""}" aria-label="${recording ? "Finish voice message" : "Record voice message"}"`)}${button(esc(session?.model || profile?.model || "Choose model") + " ⌄", "model", 'class="model-picker"')}<span class="composer-project">${project ? "⌑ " + esc(labelProject(project)) : "No project selected"}</span></div><div>${running() ? button("■", "stop", 'class="send" aria-label="Stop generation"') : `<button type="submit" class="send" aria-label="Send message">↑</button>`}</div></div></form><div class="composer-hint"><span>Return to send <span class="muted">·</span> ⇧ Return for a new line</span><span class="mono">[ make it happen ]</span></div></div>`;
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
  function pageHTML() {
    if (view === "memory")
      return `<div class="page">${heading("A mind that remembers.", "Useful context, carried from one conversation to the next.")}<div class="page-actions">${button("+ Add memory", "memory-add", 'class="primary-button"')}${button("Export", "memory-export")}</div>${
        memory.length
          ? `<div class="memory-map" aria-label="Memory constellation">${memory
              .slice(0, 16)
              .map(
                (m, i) =>
                  `<button data-action="memory-detail" data-id="${m.id}" style="--i:${i}" title="${esc(m.fact)}">✳ <span>${esc(m.fact.slice(0, 44))}</span></button>`,
              )
              .join(
                "",
              )}</div><div class="record-list">${memory.map((m) => `<div class="record"><span>${icon("memory")}</span><div><p>${esc(m.fact)}</p><small>Used ${m.accessCount} times · ${new Date(m.createdAt).toLocaleDateString()}</small></div>${button("Forget", "memory-forget", `data-id="${m.id}"`)}</div>`).join("")}</div>`
          : empty(
              "✳",
              "A fresh start.",
              "Add a preference, a useful fact, or something you want Hades to remember.",
            )
      }</div>`;
    if (view === "skills")
      return `<div class="page">${heading("A few well-honed skills.", "Reusable instructions for the way you like to work.")}<div class="page-actions">${button("+ Create skill", "skill-new", 'class="primary-button"')}</div>${skills.length ? `<div class="cards">${skills.map((s) => `<button class="library-card" data-action="skill-edit" data-name="${esc(s.name)}">${icon("skills")}<h3>${esc(s.name)}</h3><p>${esc(s.content.slice(0, 160))}</p><small>Local SKILL.md ↗</small></button>`).join("")}</div>` : empty("⌘", "Your toolkit starts here.", "Create a skill and attach its instructions to a conversation.")}</div>`;
    if (view === "jobs")
      return `<div class="page">${heading("Let the routine run.", "Recurring work, with a conversation for every run.")}<div class="page-actions">${button("+ New routine", "job-new", 'class="primary-button"')}<span class="muted">Runs while Hades is open. Changes still require approval.</span></div>${boot.jobs.length ? boot.jobs.map((j: Row) => `<div class="record"><span>${icon("jobs")}</span><div><h3>${esc(j.name)}</h3><p>${esc(j.prompt)}</p><small>${j.cron ? esc(j.cron) + " · " + esc(j.timeZone) : "Every " + j.intervalMinutes + " min"} · ${j.enabled ? "Next " + new Date(j.nextAt).toLocaleString() : "Paused"}${j.lastError ? " · " + esc(j.lastError) : ""}</small></div>${button(j.enabled ? "Pause" : "Enable", "job-toggle", `data-id="${j.id}"`)}${button("Run now", "job-run", `data-id="${j.id}"`)}</div>`).join("") : empty("◷", "Something worth repeating?", "Set up a recurring prompt for one of your projects.")}</div>`;
    if (view === "artifact") {
      return `<div class="page">${heading("The things you make.", "Files in your project, and links from the current conversation.")}<div class="page-actions">${button("Browse project files", "files", 'class="primary-button"')}</div>${artifacts.length ? artifacts.map((item: Row, i: number) => `<div class="record">${icon("artifact")}<div><p>${esc(item.path ?? item.url)}</p><small>${new Date(item.at).toLocaleString()}</small></div>${button("Preview", "artifact-open", `data-index="${i}"`)}${button("Conversation", "session", `data-id="${item.session}"`)}</div>`).join("") : empty("◇", "Room for good work.", "Use the file browser to preview, edit and open your project’s outputs.")}</div>`;
    }
    if (view === "agents")
      return `<div class="page">${heading("A place for every agent.", "Separate profiles, shared workspace tools, independent conversations.")}<div class="page-actions">${button("+ New agent", "profile-new", 'class="primary-button"')}</div><div class="cards">${boot.profiles.map((p: Profile) => `<button class="library-card" data-action="profile-select" data-id="${p.id}"><div class="agent-avatar">[${esc(p.name[0].toUpperCase())}]</div><h3>${esc(p.name)}</h3><p>${esc(p.persona || "Your general-purpose agent.")}</p><small>${esc(p.provider)} / ${esc(p.model)}</small></button>`).join("")}</div><h2>Running conversations <span class="muted">${boot.active.length}</span></h2>${boot.active.map((id: string) => `<div class="record"><i class="running-dot"></i><div>${esc(boot.sessions.find((s: Row) => s.id === id)?.title || id)}</div>${button("Open", "session", `data-id="${id}"`)}</div>`).join("") || '<p class="muted">All quiet. Start a conversation to put an agent to work.</p>'}<details class="advanced"><summary>Harness services</summary><p>Inspect Hades’ existing fleet, gateway, trust and learning services.</p>${["fleet.list", "gateway.status.get", "learning.get", "schedule.status.get"].map((kind) => button(esc(kind), "harness", `data-kind="${kind}"`)).join("")}<pre id="harness-output">${esc(modalData.harness ?? "")}</pre></details></div>`;
    return "";
  }
  function empty(mark: string, title: string, detail: string) {
    return `<div class="empty"><div class="ascii-empty">${mark}</div><h2>${title}</h2><p>${detail}</p></div>`;
  }
  function paneHTML() {
    return `<aside class="inspector"><div class="inspector-heading"><strong>${pane === "files" ? "Project files" : pane === "git" ? "Changes" : pane === "preview" ? "Preview" : "Terminal"}</strong>${button("×", "pane-close", 'aria-label="Close inspector"')}</div>${!project ? empty("⌑", "Open a project", "Choose a folder first.") : pane === "files" ? `<div class="file-path">${button("↑", "folder-up", 'aria-label="Parent folder"')}<span class="mono">${esc(folder)}</span>${button("↻", "files-refresh", 'aria-label="Refresh files"')}</div><div class="file-list">${files.map((f) => button(`${icon(f.directory ? "files" : "artifact")}${esc(f.name)}${f.directory ? " <span>›</span>" : ""}`, "file", `data-path="${esc(f.path)}" data-dir="${f.directory}" class="file-row"`)).join("")}</div>${preview ? previewHTML() : ""}` : pane === "preview" ? `<div class="preview-url"><input id="preview-url" type="url" placeholder="https://…" value="${esc(modalData.url ?? "")}">${button("Go", "preview-go")}</div>${modalData.url ? `<iframe title="Website preview" src="${esc(modalData.url)}" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"></iframe><p class="muted preview-note">Some sites block embedded previews. ${button("Open in browser", "open-link", `data-url="${esc(modalData.url)}"`)}</p>` : ""}` : pane === "git" ? `<div class="git-review"><pre class="git-status">${esc(git.status ?? "")}</pre><div class="page-actions">${button("Refresh", "git-refresh")}${button("New branch", "branch")}${button("Worktree", "worktree")}</div><label class="field">File path to stage or unstage<input id="git-path" placeholder="src/example.ts"></label>${button("Stage", "git-stage")}${button("Unstage", "git-unstage")}<label class="field">Commit message<input id="commit-message" placeholder="Describe the change"></label>${button("Commit staged", "git-commit", 'class="primary-button"')}${button("Push", "git-push")}<pre class="diff">${esc(git.diff || "No tracked file changes.")}</pre></div>` : `<div class="terminal-tabs">${boot.terminals.map((t: Row, i: number) => button(`${i + 1} ${labelProject(t.root)}`, "terminal-select", `data-id="${t.id}" class="${selectedTerminal === t.id ? "selected" : ""}"`)).join("")}${button("+", "terminal-new", 'aria-label="New terminal"')}${button("×", "terminal-close", 'aria-label="Close terminal process"')}</div><div id="terminal-host" class="terminal-host" aria-label="Interactive terminal"></div><div class="terminal-controls">${button("Ctrl C", "terminal-interrupt")}${button("Add output to chat", "terminal-context")}</div>`}</aside>`;
  }
  function previewHTML() {
    return `<section class="file-preview"><div class="inspector-heading"><strong>${esc(preview!.path)}</strong>${button("↗", "file-open", 'aria-label="Open file in default editor"')}</div>${preview!.image ? `<img src="${esc(preview!.image)}" alt="${esc(preview!.path)}">` : `<textarea id="file-content" aria-label="File contents" spellcheck="false">${esc(preview!.text)}</textarea><div class="page-actions">${button("Save changes", "file-save")}${button("Add to chat", "file-context")}</div>`}</section>`;
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
      title = modal === "profile" ? "Create an agent" : "Make Hades yours";
      content = `<div class="settings-section"><h3>Provider & model</h3>${field("Agent name", "settings-name", p.name)}<label class="field">Provider<select id="settings-provider">${["openai", "anthropic", "local"].map((v) => `<option value="${v}" ${p.provider === v ? "selected" : ""}>${v === "local" ? "Local / OpenAI compatible" : v === "openai" ? "OpenAI" : "Anthropic"}</option>`).join("")}</select></label>${field("Model ID", "settings-model", p.model)}${field("Endpoint", "settings-url", p.baseUrl)}${field("API key · saved in macOS Keychain", "settings-key", "", "password")}<p class="help">Leave the key blank to keep it. Local endpoints can run without a key.</p></div><details class="settings-section"><summary>Instructions & tools</summary><label class="field">Agent instructions<textarea id="settings-persona" rows="4">${esc(p.persona)}</textarea></label>${field("Allowed shell commands, separated by commas", "settings-shell", p.shell.join(","))}<p class="help">Host commands require your approval each time. They run with your account’s access.</p><label class="field">MCP servers (JSON)<textarea id="settings-mcp" rows="5" spellcheck="false">${esc(JSON.stringify(p.mcp ?? [], null, 2))}</textarea></label><p class="help">Each server has name, command, args and enabled fields. Enabling a server launches its command during agent turns. Tool calls require approval.</p></details><div class="settings-section"><h3>Appearance</h3><div class="segmented">${["system", "light", "dark"].map((t) => button(t[0].toUpperCase() + t.slice(1), "theme", `data-theme="${t}" class="${theme === t ? "active" : ""}"`)).join("")}</div><div class="page-actions">${button("A−", "zoom-out")}${button("A+", "zoom-in")}${button("Export profile", "profile-export")}${button("Import profile", "profile-import")}<input id="profile-import-file" type="file" accept=".json" hidden>${button("Keyboard shortcuts", "shortcuts")}</div><div class="page-actions">${button(quickEntry ? "Disable Quick Entry" : "Enable Quick Entry", "quick-entry")}${button("Keep awake", "awake-on")}${button("Allow sleep", "awake-off")}${button("Stop speech", "voice-stop")}</div><p class="help">Quick Entry: ⌘ ⇧ Space while Hades is open. Voice clips go to your profile’s speech endpoint; transcripts stay in the composer until you send.</p></div>${button("Save settings", "settings-save", 'class="primary-button wide"')}`;
    }
    if (modal === "project") {
      title = "A home for your work";
      content = `<p>Choose a folder. Hades can read its files and asks before changing them.</p>${field("Project folder", "project-path", project || boot.home || "")}<div class="page-actions">${button("Choose in Finder…", "project-pick")}${button("Open project", "project-add", 'class="primary-button"')}</div>`;
    }
    if (modal === "model") {
      title = "Model for this conversation";
      content =
        field("Model ID", "session-model", session?.model || profile.model) +
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
        button("Save skill", "skill-save", 'class="primary-button"') +
        button("Attach to chat", "skill-attach");
    }
    if (modal === "job") {
      title = "A new routine";
      content =
        field("Name", "job-name") +
        '<label class="field">Prompt<textarea id="job-prompt" rows="4"></textarea></label>' +
        field("Repeat every (minutes)", "job-interval", "60", "number") +
        field("Cron expression (optional)", "job-cron") +
        field(
          "Time zone",
          "job-timezone",
          Intl.DateTimeFormat().resolvedOptions().timeZone,
        ) +
        `<p class="help">Project: ${esc(project || "Choose a project first")}. Runs while the app is open.</p>` +
        button("Create routine", "job-save", 'class="primary-button"');
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
          ["nav-memory", "Memory", ""],
          ["nav-skills", "Skills", ""],
          ["nav-jobs", "Routines", ""],
          ["shortcuts", "Keyboard shortcuts", "⌘ /"],
        ]
          .map(([a, l, k]) =>
            button(l + `<kbd>${k}</kbd>`, a, 'class="palette-item"'),
          )
          .join("") +
        "</div>";
    }
    if (modal === "shortcuts") {
      title = "Keep your hands on the keys";
      content =
        '<div class="shortcut-list">' +
        [
          ["New conversation", "⌘ N"],
          ["Command palette", "⌘ K"],
          ["Settings", "⌘ ,"],
          ["Find in conversation", "⌘ F"],
          ["Sidebar", "⌘ B"],
          ["Inspector", "⌘ J"],
          ["Git review", "⌘ G"],
          ["New tab", "⌘ T"],
          ["Close tab", "⌘ W"],
          ["Reopen tab", "⌘ ⇧ T"],
          ["New window", "⌘ ⇧ N"],
          ["Floating chat", "⌘ ⇧ H"],
          ["Status bar", "⌘ ⇧ S"],
          ["Stop generation", "Esc"],
          ["Prompt history", "↑ / ↓ in empty composer"],
        ]
          .map(([l, k]) => `<div>${l}<kbd>${k}</kbd></div>`)
          .join("") +
        "</div>";
    }
    return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-header"><h2>${title}</h2>${button("×", "modal-close", 'class="icon-button" aria-label="Close dialog"')}</div>${content}</section></div>`;
  }
  const val = (id: string) =>
    root.querySelector<HTMLInputElement>("#" + id)?.value ?? "";
  async function navigate(next: string) {
    view = next;
    modal = "";
    if (view === "memory")
      memory = await rpc("memory.list", { profile: profile.id });
    if (view === "artifact")
      artifacts = await rpc("artifacts.list", { profile: profile.id });
    if (view === "skills")
      skills = await rpc("skills.list", { profile: profile.id });
    render();
  }
  async function action(name: string, el?: HTMLElement) {
    if (name.startsWith("nav-")) return navigate(name.slice(4));
    switch (name) {
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
          project = item.root;
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
        project = await rpc("project.add", { path: val("project-path") });
        modal = "";
        await refresh();
        await newChat();
        return;
      case "project-select":
        project = el!.dataset.path!;
        session = undefined;
        folder = ".";
        preview = undefined;
        view = "chat";
        if (pane === "files")
          files = await rpc("files.list", { root: project, path: "." });
        break;
      case "settings-save": {
        const provider = val("settings-provider"),
          apiKey = val("settings-key");
        const p = await rpc("profile.save", {
          id: modal === "profile" ? undefined : profile.id,
          name: val("settings-name"),
          provider,
          model: val("settings-model"),
          baseUrl: val("settings-url"),
          persona: val("settings-persona"),
          shell: val("settings-shell"),
          mcp: val("settings-mcp") || "[]",
        });
        if (apiKey)
          await tauri().core.invoke("hades_key", {
            account: p.id + ":" + provider,
            value: apiKey,
          });
        profile = p;
        modal = "";
        await refresh();
        return;
      }
      case "model-catalog": {
        const models: string[] = await rpc("models.list", {
          profile: profile.id,
        });
        const list = root.querySelector<HTMLElement>("#model-catalog");
        if (list) {
          list.replaceChildren();
          for (const model of models) {
            const item = document.createElement("button");
            item.className = "palette-item";
            item.textContent = model;
            item.onclick = () => {
              const input =
                root.querySelector<HTMLInputElement>("#session-model");
              if (input) input.value = model;
            };
            list.append(item);
          }
          if (!models.length)
            list.textContent =
              "This endpoint returned no models. Enter an ID manually.";
        }
        return;
      }
      case "model-save":
        if (!session) await newChat();
        if (session) {
          await rpc("session.update", {
            id: current(),
            model: val("session-model"),
            profile: profile.id,
          });
          session.model = val("session-model");
        }
        modal = "";
        break;
      case "theme":
        theme = el!.dataset.theme!;
        localStorage.setItem("hades.theme", theme);
        applyTheme();
        root
          .querySelectorAll<HTMLElement>("[data-action=theme]")
          .forEach((b) =>
            b.classList.toggle("active", b.dataset.theme === theme),
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
        });
        preview!.text = val("file-content");
        error = "Saved " + preview!.path;
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
        modal = "job";
        break;
      case "job-save":
        await rpc("job.save", {
          name: val("job-name"),
          prompt: val("job-prompt"),
          intervalMinutes: Number(val("job-interval")),
          cron: val("job-cron"),
          timeZone: val("job-timezone"),
          root: project,
          profile: profile.id,
        });
        modal = "";
        await refresh();
        break;
      case "job-toggle":
        await rpc("job.toggle", {
          id: el!.dataset.id,
          enabled: !boot.jobs.find((j: Row) => j.id === el!.dataset.id).enabled,
        });
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
        error =
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
        error = quickEntry
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
        break;
      case "harness":
        await tauri().core.invoke("hades_command", {
          cmd: { kind: el!.dataset.kind },
        });
        return;
    }
    render();
    if (modal)
      root
        .querySelector<HTMLInputElement>(
          ".modal input, .modal textarea, .modal button",
        )
        ?.focus();
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

  function bind() {
    root.querySelectorAll<HTMLElement>("[data-action]").forEach(
      (el) =>
        (el.onclick = () => {
          void action(el.dataset.action!, el).catch(toast);
        }),
    );
    const input = (id: string, cb: (v: string) => void) => {
      const el = root.querySelector<HTMLInputElement>("#" + id);
      if (el) el.oninput = () => cb(el.value);
    };
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
        profile = undefined!;
        void rpc("profile.select", { id: profileSelect.value })
          .then(() => {
            session = undefined;
            tabs = [];
            return refresh();
          })
          .catch(toast);
      };
    const providerSelect =
      root.querySelector<HTMLSelectElement>("#settings-provider");
    if (providerSelect)
      providerSelect.onchange = () => {
        root.querySelector<HTMLInputElement>("#settings-url")!.value =
          providerSelect.value === "anthropic"
            ? "https://api.anthropic.com"
            : providerSelect.value === "local"
              ? "http://localhost:11434/v1"
              : "https://api.openai.com/v1";
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
          fontFamily: "Menlo, monospace",
          fontSize: 11,
          theme: {
            background: "#181b18",
            foreground: "#d6dfd1",
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
        const observer = new ResizeObserver(() => {
          setTimeout(() => {
            if (node.isConnected) fit.fit();
          }, 0);
        });
        observer.observe(node);
        item = { terminal, fit, node, observer };
        terminalViews.set(id, item);
        terminal.write(
          boot.terminals.find((t: Row) => t.id === id)?.output ?? "",
        );
      }
      host.append(item.node);
      item.fit.fit();
      item.terminal.focus();
    }
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Tab" && modal) {
      const elements = Array.from(
        root.querySelectorAll<HTMLElement>(
          ".modal button:not([hidden]),.modal input,.modal select,.modal textarea",
        ),
      ).filter((el) => el.offsetParent !== null);
      if (e.shiftKey && document.activeElement === elements[0]) {
        e.preventDefault();
        elements.at(-1)?.focus();
      } else if (!e.shiftKey && document.activeElement === elements.at(-1)) {
        e.preventDefault();
        elements[0]?.focus();
      }
    }
    if (e.key === "Escape") {
      if (modal) {
        modal = "";
        render();
      } else if (find) {
        find = "";
        render();
      } else if (running()) void action("stop").catch(toast);
      return;
    }
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
    if ((e.target as HTMLElement)?.closest(".xterm") && !e.metaKey) return;
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase(),
      actions: Row = {
        n: e.shiftKey ? "popout" : "new",
        t: e.shiftKey ? "tab-reopen" : "new",
        k: "palette",
        p: "palette",
        ",": "settings",
        b: "sidebar",
        j: "files",
        g: "git",
        h: e.shiftKey ? "hud" : undefined,
        w: "tab-close",
        "/": "shortcuts",
      };
    if (key === "f") {
      e.preventDefault();
      find = " ";
      render();
      root.querySelector<HTMLInputElement>("#find-input")?.focus();
      return;
    }
    if (key === "s" && e.shiftKey) {
      e.preventDefault();
      statusbar = !statusbar;
      render();
      return;
    }
    if (actions[key]) {
      e.preventDefault();
      void action(actions[key]).catch(toast);
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
            stream = "";
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
        if (e.kind === "desktop.tool") {
          activity.push(e);
          if (e.status === "done") stream = "";
        }
        if (e.kind === "desktop.usage") usage = e;
        if (e.kind === "desktop.error") {
          error = e.message;
          paused.add(current());
        }
        if (e.kind === "desktop.approval") pendingApproval = e;
        if (!e.kind.startsWith("desktop."))
          modalData.harness = JSON.stringify(e, null, 2);
        render();
      },
    );
    await refresh();
    await Promise.all(
      boot.profiles.map((p: Profile) =>
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
    unlisten?.();
    document.removeEventListener("keydown", onKey);
    for (const item of terminalViews.values()) {
      item.observer.disconnect();
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
