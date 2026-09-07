import { captureFocus, restoreFocus } from "./focus";
type Row = Record<string, any>;
type Context = { profile: string; root: string; name: string };
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Pairing is explicit. The webview never retrieves a saved token from Keychain. */
export class BrowserView {
  private host?: HTMLElement;
  private context: Context = { profile: "", root: "", name: "" };
  private state: Row = {};
  private endpoint = "";
  private token = "";
  private busy = false;
  private error = "";
  constructor(private rpc: (method: string, args?: Row) => Promise<any>, private keychain: (account: string, value: string | null) => Promise<unknown>) {}
  async open(context: Context) {
    if (this.context.profile !== context.profile || this.context.root !== context.root) this.token = "";
    this.context = { ...context };
    await this.refresh();
  }
  mount(host: HTMLElement) { this.host = host; this.render(); }
  async refresh() {
    this.state = await this.rpc("browser.status");
    if (!this.endpoint) this.endpoint = this.state.endpoint || "";
    this.render();
  }
  private render() {
    if (!this.host) return;
    const focus = captureFocus(this.host);
    const same = this.state.profile === this.context.profile && this.state.root === this.context.root;
    this.host.innerHTML = `<div class="page"><h1>Hades Browser</h1><p class="help">Let your agent work with tabs, read pages and interact with websites in the companion Mac app.</p>
      <div class="record"><div><h3>${this.state.connected ? "Connected" : "Not connected"}</h3><p>${this.state.connected ? `${esc(this.state.endpoint)}${same ? " · This agent and workspace" : " · Another agent or workspace"}` : "Open Hades Browser, then copy its endpoint and pairing token from Settings → Agent bridge."}</p></div><button id="browser-refresh" data-browser="refresh">Refresh</button></div>
      ${this.error ? `<p class="inline-notice" role="alert">${esc(this.error)}</p>` : ""}
      <form><label class="field">Browser endpoint<input id="browser-endpoint" autocomplete="off" spellcheck="false" placeholder="ws://127.0.0.1:PORT" required value="${esc(this.endpoint)}"></label>
      <label class="field">Pairing token<input id="browser-token" type="password" autocomplete="off" spellcheck="false" placeholder="Paste a token, or use the saved token" value="${esc(this.token)}"></label>
      <p class="help">Connect ${esc(this.context.name)} to ${esc(this.context.root || "a workspace you select in the sidebar")}. The token stays in macOS Keychain. Website content is sent to this agent’s selected model when it uses browser tools.</p>
      <div class="page-actions"><button id="browser-connect" type="submit" ${!this.context.root ? "disabled" : ""}>${this.state.connected ? "Reconnect with this agent" : "Connect"}</button>${this.state.connected ? '<button id="browser-disconnect" type="button" data-browser="disconnect">Disconnect and stop tasks</button>' : ""}<button id="browser-forget" type="button" data-browser="forget">Forget token</button></div></form>
      <p class="help">Browser access also needs permission in Hades Browser. You can pause or cancel there, or stop the task in Hades Agent. Reopening either app does not resume browser actions automatically.</p></div>`;
    const endpoint = this.host.querySelector<HTMLInputElement>("#browser-endpoint")!;
    const token = this.host.querySelector<HTMLInputElement>("#browser-token")!;
    endpoint.oninput = () => { this.endpoint = endpoint.value; };
    token.oninput = () => { this.token = token.value; };
    this.host.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled ||= this.busy; });
    this.host.querySelector("form")!.onsubmit = event => { event.preventDefault(); void this.action("connect"); };
    this.host.querySelectorAll<HTMLButtonElement>("[data-browser]").forEach(button => { button.onclick = () => { void this.action(button.dataset.browser!); }; });
    restoreFocus(this.host, focus);
  }
  private async action(action: string) {
    if (this.busy) return;
    const context = { ...this.context }, token = this.token.trim(), endpoint = this.endpoint.trim();
    this.busy = true; this.error = ""; this.render();
    try {
      if (action === "connect") {
        if (!context.root) throw new Error("Select a workspace before connecting");
        // Validate and revoke any old binding before loading a credential.
        await this.rpc("browser.configure", { endpoint, enabled: true, profile: context.profile, root: context.root });
        const configured = await this.keychain("hades-browser", token || null);
        if (configured === false) throw new Error("Paste the pairing token from Hades Browser");
        await this.rpc("browser.connect");
      } else if (action === "disconnect" || action === "forget") {
        await this.rpc("browser.disconnect");
        if (action === "forget") await this.keychain("hades-browser", "");
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Could not update the browser connection";
      if (token) this.error = this.error.replaceAll(token, "[redacted]");
    } finally {
      this.token = ""; this.busy = false;
      await this.refresh().catch(() => this.render());
    }
  }
}
