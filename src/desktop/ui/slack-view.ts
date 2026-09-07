import manifest from "../../../docs/integration/slack-app-manifest.json";
type Row = Record<string, any>;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** Stable native-webview component; background status never replaces a form draft. */
export class SlackView {
  readonly node = document.createElement("div");
  private state: Row = {};
  private channels = "";
  private users = "";
  private loaded = false;
  private busy = false;
  private error = "";
  private available: Row[] = [];
  private timer: ReturnType<typeof setInterval>;
  constructor(private rpc: (method: string, args?: Row) => Promise<any>, private key: (account: string, value: string | null) => Promise<any>, private context: () => { root: string; profile: string; name: string }, private openSession: (id: string) => void) {
    this.node.className = "page slack-page";
    this.timer = setInterval(() => { if (this.node.isConnected && !this.node.contains(document.activeElement)) void this.refresh(); }, 3000);
  }
  mount(host: HTMLElement) { host.append(this.node); if (!this.loaded) void this.refresh(); }
  private async refresh() {
    try { this.state = await this.rpc("slack.status");
      if (!this.loaded) { this.channels = this.state.config?.channels.join(", ") ?? ""; this.users = this.state.config?.users.join(", ") ?? ""; this.loaded = true; }
      if (!this.node.contains(document.activeElement)) this.paint();
    } catch (e) { this.error = String(e); this.paint(); }
  }
  private async run(action: () => Promise<any>) {
    if (this.busy) return; this.busy = true;
    this.node.querySelectorAll<HTMLButtonElement>("button").forEach(b => b.disabled = true);
    try { this.error = ""; await action(); this.state = await this.rpc("slack.status"); }
    catch (e) { this.error = e instanceof Error ? e.message : String(e); }
    finally { this.busy = false; this.paint(); }
  }
  private paint() {
    const s = this.state, c = this.context();
    this.node.innerHTML = `<h2>Slack</h2><p class="page-description">Mention your Hades agent in a Slack thread. Replies stay in that thread.</p>
      <div class="record"><div><h3>${esc(s.connection ?? "Loading")}</h3><p>${s.config ? esc(s.config.root) : "Choose a project and agent in Hades, then save the connection settings below."}</p></div><button data-command="connect" ${!s.config ? "disabled" : ""}>${s.enabled ? "Disconnect" : "Connect"}</button></div>
      ${this.error ? `<p class="inline-notice" role="alert">${esc(this.error)}</p>` : ""}
      <details class="advanced" ${!s.config ? "open" : ""}><summary>Connection settings</summary>
      <p class="help">Save uses ${esc(c.name)} in ${esc(c.root || "the project you select")}. Only allowed members’ explicit mentions are accepted. Commands and file changes use Hades’ desktop approvals. The Mac must stay awake with Hades open.</p>
      <p class="help">Create a Slack app using the app manifest below. Install it in your workspace, then invite its bot into the channels you allow.</p>
      <div class="page-actions"><button data-command="manifest">Copy app manifest</button><button data-command="apps">Open Slack apps</button></div><label class="field">Bot token<input id="slack-bot-token" type="password" autocomplete="off" placeholder="${s.hasBotToken ? "Saved in Keychain" : "xoxb-…"}" ${s.enabled ? "disabled" : ""}></label>
      <label class="field">Socket Mode app token<input id="slack-app-token" type="password" autocomplete="off" placeholder="${s.hasAppToken ? "Saved in Keychain" : "xapp-… · connections:write"}" ${s.enabled ? "disabled" : ""}></label>
      <label class="field">Allowed channel IDs<input id="slack-channels" value="${esc(this.channels)}" placeholder="C0123456789, C9876543210" ${s.enabled ? "disabled" : ""}></label>
      <label class="field">Allowed member IDs<input id="slack-users" value="${esc(this.users)}" placeholder="U0123456789" ${s.enabled ? "disabled" : ""}></label>
      <div class="page-actions"><button data-command="save" ${s.enabled ? "disabled" : ""}>Save settings</button><button data-command="channels">List bot channels</button></div>
      ${this.available.map(channel => `<p class="help">#${esc(channel.name)} · <code>${esc(channel.id)}</code></p>`).join("")}</details>
      <h3>Requests</h3>${(s.jobs ?? []).length ? s.jobs.map((j: Row) => `<div class="record"><div><h3>${esc(j.input.slice(0, 100))}</h3><p>${esc(j.status)} · ${esc(j.channel)} · ${esc(j.user)}</p>${j.error ? `<p class="help">${esc(j.error)}</p>` : ""}</div>${j.session ? `<button data-session="${esc(j.session)}">Open conversation</button>` : ""}${j.status === "ready" ? `<button data-publish="${esc(j.id)}">Publish reply</button>` : ""}</div>`).join("") : '<p class="help">No requests yet. Connect, then mention the bot in an allowed channel.</p>'}`;
    this.node.querySelector<HTMLInputElement>("#slack-channels")!.oninput = e => this.channels = (e.target as HTMLInputElement).value;
    this.node.querySelector<HTMLInputElement>("#slack-users")!.oninput = e => this.users = (e.target as HTMLInputElement).value;
    this.node.querySelectorAll<HTMLButtonElement>("button").forEach(b => b.onclick = () => {
      if (b.dataset.session) return this.openSession(b.dataset.session);
      void this.run(async () => {
        if (b.dataset.command === "manifest") return navigator.clipboard.writeText(JSON.stringify(manifest, null, 2));
        if (b.dataset.command === "apps") return this.rpc("link.open", { url: "https://api.slack.com/apps" });
        if (b.dataset.publish) return this.rpc("slack.publish", { id: b.dataset.publish });
        if (b.dataset.command === "connect") return this.rpc(s.enabled ? "slack.disconnect" : "slack.connect");
        if (b.dataset.command === "channels") { this.available = await this.rpc("slack.channels"); return; }
        const bot = this.node.querySelector<HTMLInputElement>("#slack-bot-token")!.value;
        const app = this.node.querySelector<HTMLInputElement>("#slack-app-token")!.value;
        if (bot) { await this.key("slack-bot", bot); this.node.querySelector<HTMLInputElement>("#slack-bot-token")!.value = ""; }
        if (app) { await this.key("slack-app", app); this.node.querySelector<HTMLInputElement>("#slack-app-token")!.value = ""; }
        await this.rpc("slack.configure", { ...c, channels: this.channels.split(/[\s,]+/).filter(Boolean), users: this.users.split(/[\s,]+/).filter(Boolean) });
      });
    });
  }
  destroy() { clearInterval(this.timer); }
}
