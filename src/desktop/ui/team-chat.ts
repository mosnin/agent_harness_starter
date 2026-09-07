import { captureFocus, restoreFocus } from "./focus";
type Row = Record<string, any>;
type Rpc = (method: string, args?: Row) => Promise<any>;
const el = (tag: string, text = "", cls = "") => { const node = document.createElement(tag); node.textContent = text; node.className = cls; return node; };
export class TeamChatView {
  readonly node = el("div", "", "team-chat");
  private state: Row = { connected: false };
  private channel = "";
  private messages: Row[] = [];
  private draft = "";
  private requestId = crypto.randomUUID();
  private replyTo?: string;
  private busy = false;
  private polling = false;
  private error = "";
  private timer: ReturnType<typeof setInterval>;
  private controls = { endpoint: "", name: "", team: "", invite: "" };
  private setupMode: "create" | "join" = "create";
  constructor(private rpc: Rpc, private native: (action: string, args: Row) => Promise<unknown>, private ask: (channel: string, input: string, requestId: string) => Promise<void>) {
    this.timer = setInterval(() => { if (this.node.isConnected && this.state.connected) void this.refresh(false); }, 2500);
    this.paint();
  }
  mount(host: HTMLElement) { host.append(this.node); void this.refresh(false); }
  private button(label: string, action: () => any, primary = false) {
    const b = el("button", label, primary ? "primary-button" : "") as HTMLButtonElement;
    b.disabled = this.busy;
    b.onclick = async () => {
      if (this.busy) return;
      this.busy = true; this.error = ""; b.disabled = true;
      try { await action(); } catch (e) { this.error = e instanceof Error ? e.message : String(e); }
      finally { this.busy = false; this.paint(); }
    }; return b;
  }
  private field(label: string, key: keyof typeof this.controls, password = false) {
    const node = el("label", label, "field"), input = document.createElement("input");
    input.id = "team-setup-" + key;
    input.type = password ? "password" : "text"; input.value = this.controls[key]; input.autocomplete = "off";
    input.oninput = () => { this.controls[key] = input.value; }; node.append(input); return node;
  }
  async refresh(force = true) {
    if (this.polling) return;
    this.polling = true;
    try {
      const next = await this.rpc("team.status");
      const changed = JSON.stringify(next) !== JSON.stringify(this.state);
      this.state = next;
      if (next.connected) {
        if (!next.channels.some((c: Row) => c.id === this.channel)) { this.channel = next.channels[0]?.id ?? ""; this.messages = []; }
        if (this.channel) {
          const rows: Row[] = await this.rpc("team.messages", { channel: this.channel, after: this.messages.at(-1)?.seq ?? 0 });
          const ids = new Set(this.messages.map(m => m.id));
          this.messages.push(...rows.filter(m => !ids.has(m.id)));
          if (rows.length && this.node.isConnected) await this.rpc("team.read", { channel: this.channel, seq: this.messages.at(-1)!.seq });
          if (force || changed || rows.length) this.paint();
        }
      } else if (force || changed) this.paint();
    } catch (e) { this.error = e instanceof Error ? e.message : "Connection lost. Retrying…"; this.paint(); }
    finally { this.polling = false; }
  }
  private paint() {
    const focus = captureFocus(this.node);
    const membersExpanded = this.node.querySelector<HTMLDetailsElement>(".team-members")?.open ?? false;
    const sidebarScroll = this.node.querySelector(".team-sidebar")?.scrollTop ?? 0;
    const setupScroll = this.node.querySelector(".team-setup")?.scrollTop ?? 0;
    const recoveryExpanded = this.node.querySelector<HTMLDetailsElement>(".team-recovery")?.open ?? false;
    const oldLog = this.node.querySelector(".team-messages");
    const scrollTop = oldLog?.scrollTop ?? 0;
    const atBottom = !oldLog || oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 80;
    this.node.replaceChildren();
    if (!this.state.connected) {
      const page = el("div", "", "page team-setup"); const heading = el("div", "", "page-heading"); heading.append(el("h1", "Team chat"), el("p", "A shared place for people and Hades agents.")); page.append(heading);
      if (this.state.message) page.append(el("p", this.state.message, "inline-notice"));
      if (this.error) page.append(el("p", this.error, "inline-notice"));
      const modes = el("div", "", "segmented team-setup-modes");
      for (const mode of ["create", "join"] as const) {
        const choose = this.button(mode === "create" ? "Create a team" : "Join a team", () => { this.setupMode = mode; });
        choose.id = "team-mode-" + mode; choose.setAttribute("aria-pressed", String(this.setupMode === mode)); choose.classList.toggle("active", this.setupMode === mode); modes.append(choose);
      }
      page.append(modes, this.field("Your name", "name"));
      const create = el("section", "", "settings-section"); create.append(el("h2", "Create a team"), this.field("Team name", "team"), this.button("Create on this Mac", async () => { await this.native("create", { name: this.controls.team, owner: this.controls.name }); await this.refresh(); }, true), el("p", "This Mac hosts the team while Hades is open. For other Macs, expose the service through HTTPS or run the team server on your own host.", "help"));
      const join = el("section", "", "settings-section"); join.append(el("h2", "Join a team"), this.field("Team server · https://…", "endpoint"), this.field("Invitation code", "invite", true), this.button("Join team", async () => { await this.native("join", { endpoint: this.controls.endpoint, invite: this.controls.invite, name: this.controls.name }); this.controls.invite = ""; await this.refresh(); }));
      const recovery = el("details", "", "team-recovery") as HTMLDetailsElement;
      recovery.open = recoveryExpanded;
      recovery.append(el("summary", "Connection recovery"), el("p", "Use these controls if an earlier connection was interrupted.", "help"), this.button("Retry saved connection", () => this.refresh()), this.button("Finish saving connection", async () => { await this.native("resume", {}); await this.refresh(); }));
      page.append(this.setupMode === "create" ? create : join, recovery); this.node.append(page); page.scrollTop = setupScroll; restoreFocus(this.node, focus); return;
    }
    const sidebar = el("aside", "", "team-sidebar"); sidebar.append(el("h2", this.state.name));
    for (const channel of this.state.channels) {
      const b = this.button(`# ${channel.name}${channel.unread ? ` (${channel.unread})` : ""}`, async () => { this.channel = channel.id; this.messages = []; this.replyTo = undefined; await this.refresh(); });
      b.id = "team-channel-" + channel.id; b.setAttribute("aria-current", channel.id === this.channel ? "page" : "false"); b.classList.toggle("selected", channel.id === this.channel); sidebar.append(b);
    }
    sidebar.append(this.button("New channel", async () => {
      const name = window.prompt("Channel name (lowercase, no spaces)");
      if (!name) return; const created = await this.rpc("team.channel", { name }); this.channel = created.id; this.messages = []; await this.refresh();
    }));
    const members = el("details", "", "team-members"); const memberSummary = el("summary", "Members"); memberSummary.id = "team-members-toggle"; members.append(memberSummary); (members as HTMLDetailsElement).open = membersExpanded;
    for (const member of this.state.members) {
      const row = el("div", "", "team-member"); row.append(el("span", `${member.name}${member.role === "owner" ? " · owner" : ""}`));
      if (this.state.member.role === "owner" && member.id !== this.state.member.id) row.append(this.button("Remove", async () => {
        if (window.confirm(`Remove ${member.name}'s access to this team?`)) { await this.rpc("team.revoke", { member: member.id }); await this.refresh(); }
      })); members.append(row);
    }
    sidebar.append(members, this.button("Disconnect", async () => { await this.rpc("team.disconnect"); this.messages = []; this.channel = ""; await this.refresh(); }));
    if (this.state.member.role === "owner") sidebar.append(this.button("Invite someone", async () => {
      const result = await this.rpc("team.invite");
      this.error = `One-use invitation (expires in 24 hours): ${result.invite}\nTeam server: ${this.state.endpoint}${this.state.local ? "\nUse your public HTTPS address when sharing with another Mac." : ""}`;
    }));
    sidebar.append(el("p", this.state.local ? "Hosted on this Mac" : this.state.endpoint, "help"));
    const failures = (this.state.deliveries ?? []).filter((d: Row) => d.status === "failed" || d.status === "ready");
    for (const delivery of failures) sidebar.append(el("p", delivery.error ?? "Agent reply not yet delivered", "help"), this.button("Retry agent reply", async () => { await this.rpc("team.publish", { id: delivery.id }); await this.refresh(); }));
    const main = el("section", "", "team-main"); main.append(el("h2", "# " + (this.state.channels.find((c: Row) => c.id === this.channel)?.name ?? "general")));
    if (this.error) { const notice = el("div", "", "inline-notice"); notice.append(el("p", this.error), this.button("Dismiss", () => { this.error = ""; })); main.append(notice); }
    const log = el("div", "", "team-messages"); log.setAttribute("role", "log"); log.setAttribute("aria-label", "Team messages");
    if (this.messages.length >= 100) log.append(this.button("Load earlier messages", async () => {
      const older = await this.rpc("team.messages", { channel: this.channel, before: this.messages[0].seq });
      const ids = new Set(this.messages.map(m => m.id)); this.messages.unshift(...older.filter((m: Row) => !ids.has(m.id)));
    }));
    if (!this.messages.length) log.append(el("p", "No messages yet. Start the conversation.", "help"));
    for (const message of this.messages) {
      const article = el("article", "", "team-message");
      const label = el("div", "", "message-label"); label.append(el("strong", message.agent ? `${message.agent} · via ${message.sender}` : message.sender), el("time", new Date(message.at).toLocaleString()), this.button("Reply", () => { this.replyTo = message.id; }));
      article.append(label);
      if (message.replyTo) article.append(el("p", "↳ " + (this.messages.find(m => m.id === message.replyTo)?.content.slice(0, 100) ?? "Earlier message"), "team-reply"));
      article.append(el("p", message.content, "team-message-content")); log.append(article);
    }
    const composer = el("div", "", "team-composer");
    if (this.replyTo) composer.append(el("span", "Replying to a message"), this.button("Cancel reply", () => { this.replyTo = undefined; }));
    const input = document.createElement("textarea"); input.id = "team-message"; input.rows = 3; input.placeholder = "Message your team…"; input.setAttribute("aria-label", "Team message"); input.value = this.draft; input.oninput = () => { this.draft = input.value; }; composer.append(input);
    const actions = el("div", "", "page-actions");
    actions.append(el("span", "Only Ask agent starts a local agent turn.", "help"), this.button("Ask agent", async () => { if (!this.draft.trim()) return; const sent = this.draft; await this.ask(this.channel, sent, this.requestId); if (this.draft === sent) this.draft = ""; this.requestId = crypto.randomUUID(); }), this.button("Send", async () => {
      if (!this.draft.trim()) return;
      const sent = this.draft;
      await this.rpc("team.send", { channel: this.channel, content: sent, requestId: this.requestId, replyTo: this.replyTo });
      if (this.draft === sent) this.draft = ""; this.replyTo = undefined; this.requestId = crypto.randomUUID(); await this.refresh();
    }, true));
    composer.append(actions); main.append(log, composer); this.node.append(sidebar, main);
    log.scrollTop = atBottom ? log.scrollHeight : scrollTop;
    sidebar.scrollTop = sidebarScroll;
    restoreFocus(this.node, focus);
  }
  destroy() { clearInterval(this.timer); }
}
