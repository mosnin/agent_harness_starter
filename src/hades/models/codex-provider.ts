/** Subscription inference through OpenAI's official, bundled app-server.
 * Credentials belong to Codex in a Hades-specific home, never to the webview.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatRequest, ChatResponse, ModelClient } from "./client";

type Json = Record<string, any>;
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
export type CodexStatus = { connected: boolean; email?: string; plan?: string; message?: string };

export function codexBinary(env: Record<string, string | undefined> = process.env): string {
  if (env.HADES_CODEX_BIN) return env.HADES_CODEX_BIN;
  const packaged = join(dirname(process.execPath), "codex");
  if (existsSync(packaged)) return packaged;
  const target = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl"}`;
  const local = join(process.cwd(), "node_modules", "@openai", `codex-${process.platform}-${process.arch}`, "vendor", target, "bin", "codex");
  if (existsSync(local)) return local;
  throw new Error("Codex runtime is missing. Reinstall Hades or set HADES_CODEX_BIN to the official Codex executable.");
}

export class CodexProvider implements ModelClient {
  private proc?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(method: string, params: Json) => void>();
  private loginId?: string;
  private workspace?: string;
  constructor(private home: string, private emit: (event: Json) => void = () => {}, private env: Record<string, string | undefined> = process.env) {}

  private async start() {
    if (this.ready) return this.ready;
    this.ready = this.launch();
    try { await this.ready; } catch (error) { this.close(); throw error; }
  }
  private async launch() {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    this.workspace = mkdtempSync(join(tmpdir(), "hades-inference-"));
    // This is an inference adapter. Hades supplies all tool results and approvals.
    // No user Codex config, plugins, MCP servers, hooks or workspace files load.
    const config = [
      'model_provider="openai"', 'forced_login_method="chatgpt"',
      'cli_auth_credentials_store="keyring"', 'web_search="disabled"',
      'sandbox_mode="read-only"', 'approval_policy="never"',
      'features.shell_tool=false', 'features.unified_exec=false',
      'features.apply_patch_freeform=false', 'features.apps=false',
      'features.plugins=false', 'features.hooks=false', 'features.codex_hooks=false',
      'features.multi_agent=false', 'features.js_repl=false',
      'features.image_generation=false', 'features.browser_use=false',
      'features.computer_use=false', 'features.memories=false',
      'features.shell_snapshot=false', 'features.remote_control=false',
      'features.tool_suggest=false', 'features.code_mode=false',
      'features.workspace_dependencies=false', 'features.realtime_conversation=false',
    ];
    const childEnv: NodeJS.ProcessEnv = { ...this.env, NODE_ENV: this.env.NODE_ENV === "development" || this.env.NODE_ENV === "test" ? this.env.NODE_ENV : "production", CODEX_HOME: this.home };
    delete childEnv.OPENAI_API_KEY;
    delete childEnv.CODEX_API_KEY;
    delete childEnv.CODEX_ACCESS_TOKEN;
    const proc = spawn(codexBinary(this.env), ["app-server", ...config.flatMap(c => ["-c", c])], {
      cwd: this.workspace, env: childEnv, stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    proc.stderr.resume(); // Never forward auth/runtime diagnostics to the webview.
    proc.stdin.on("error", () => this.fail(new Error("Codex connection closed. Try again.")));
    proc.on("error", () => this.fail(new Error("Could not start the Codex runtime. Reinstall Hades.")));
    proc.on("exit", () => {
      if (this.proc === proc) this.fail(new Error("Codex stopped. Try again."));
    });
    let buffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", chunk => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (line.length > 4_000_000) { buffer = ""; return this.fail(new Error("Codex response exceeded its limit.")); }
        try { this.receive(JSON.parse(line)); } catch { buffer = ""; return this.fail(new Error("Invalid Codex response.")); }
      }
      if (buffer.length > 4_000_000) { buffer = ""; this.fail(new Error("Codex response exceeded its limit.")); }
    });
    await this.request("initialize", { clientInfo: { name: "hades", title: "Hades", version: "0.1.0" }, capabilities: {} });
    this.write({ method: "initialized", params: {} });
  }
  private write(message: Json) { this.proc?.stdin.write(JSON.stringify(message) + "\n"); }
  private request(method: string, params: Json, timeout = 30_000): Promise<any> {
    if (!this.proc || this.pending.size >= 256) return Promise.reject(new Error("Codex is unavailable or busy. Try again."));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out. Try again.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  private receive(message: Json) {
    if (message.method && message.id !== undefined) {
      // Unexpected native tool/permission requests can never bypass Hades approvals.
      this.write({ id: message.id, error: { code: -32601, message: "Use Hades tools through the supplied text protocol." } });
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`Codex: ${String(message.error.message ?? "Request failed").slice(0, 1000)}`));
      else pending.resolve(message.result);
      return;
    }
    const p = message.params ?? {};
    if (message.method === "account/login/completed") {
      this.loginId = undefined;
      this.emit({ kind: "desktop.codex.auth", success: p.success === true, message: p.success ? "Connected to ChatGPT." : "Sign-in did not complete. Try again." });
    }
    for (const listener of this.listeners) listener(message.method, p);
  }
  private fail(error: Error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.close();
  }
  async status(): Promise<CodexStatus> {
    await this.start();
    const { account } = await this.request("account/read", { refreshToken: false });
    return { connected: account?.type === "chatgpt", email: account?.email, plan: account?.planType };
  }
  async login() {
    await this.start();
    if (this.loginId) await this.cancelLogin();
    const result = await this.request("account/login/start", { type: "chatgpt" });
    const url = new URL(result.authUrl);
    if (url.protocol !== "https:" || !["auth.openai.com", "chatgpt.com", "auth0.openai.com"].includes(url.hostname)) throw new Error("Codex returned an unexpected sign-in address.");
    this.loginId = result.loginId;
    return { url: url.href };
  }
  async cancelLogin() {
    if (this.loginId) await this.request("account/login/cancel", { loginId: this.loginId });
    this.loginId = undefined;
    return true;
  }
  async logout() { await this.start(); await this.cancelLogin(); await this.request("account/logout", {}); return true; }
  async models(): Promise<string[]> {
    await this.start();
    const models: string[] = [];
    let cursor: string | null = null;
    do {
      const result = await this.request("model/list", { cursor, limit: 100, includeHidden: false });
      models.push(...result.data.map((m: Json) => m.model));
      cursor = result.nextCursor;
    } while (cursor && models.length < 500);
    return models;
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    req.signal?.throwIfAborted();
    if (!(await this.status()).connected) throw new Error("Sign in with ChatGPT in Settings to use your Codex subscription.");
    const { thread } = await this.request("thread/start", {
      model: req.model, modelProvider: "openai", cwd: this.workspace,
      ephemeral: true, sandbox: "read-only", approvalPolicy: "never",
      baseInstructions: req.messages.filter(m => m.role === "system").map(m => m.content).join("\n\n") +
        "\nYou are Hades' inference engine. Follow the supplied TOOL/INPUT/ANSWER protocol exactly. Never invoke native Codex tools. Hades executes tools and supplies their results.",
    });
    let turnId = "", output = "", tokensIn = 0, tokensOut = 0;
    let resolveTurn!: (v: ChatResponse) => void, rejectTurn!: (e: Error) => void;
    const done = new Promise<ChatResponse>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    // Attach the handler before turn/start: notifications may precede its response.
    const listener = (method: string, p: Json) => {
      if (method === "hades/disconnected") return rejectTurn(new Error(p.message));
      if (p.threadId !== thread.id) return;
      if (method === "turn/started") turnId = p.turn.id;
      if (method === "item/agentMessage/delta") {
        output += p.delta;
        if (output.length > 4_000_000) return rejectTurn(new Error("Codex response exceeded its limit."));
        req.onText?.(p.delta);
      }
      if (method === "thread/tokenUsage/updated") {
        tokensIn = p.tokenUsage.total.inputTokens; tokensOut = p.tokenUsage.total.outputTokens;
      }
      if (method === "turn/completed") {
        if (p.turn.status !== "completed") rejectTurn(new Error(p.turn.error?.message ?? "Codex turn was interrupted."));
        else resolveTurn({ text: output, tokensIn, tokensOut, usd: 0, costMeasured: false, model: req.model, provider: "codex" });
      }
    };
    const abort = () => { rejectTurn(new Error("Codex request cancelled.")); };
    const timeout = setTimeout(() => rejectTurn(new Error("Codex response timed out. Try again.")), 180_000);
    this.listeners.add(listener); req.signal?.addEventListener("abort", abort, { once: true });
    // Prevent a disconnect/abort during turn/start from becoming an unhandled rejection.
    void done.catch(() => {});
    try {
      req.signal?.throwIfAborted();
      const history = req.messages.filter(m => m.role !== "system");
      const input: Json[] = [{ type: "text", text: history.map(m => `${m.role.toUpperCase()}:\n${m.content}`).join("\n\n"), text_elements: [] }];
      for (const m of history) for (const url of m.images ?? []) input.push({ type: "image", url });
      const started = await this.request("turn/start", { threadId: thread.id, input });
      turnId = started.turn.id;
      req.signal?.throwIfAborted();
      return await done;
    } finally {
      clearTimeout(timeout); req.signal?.removeEventListener("abort", abort); this.listeners.delete(listener);
      if (turnId) await this.request("turn/interrupt", { threadId: thread.id, turnId }, 5000).catch(() => {});
      await this.request("thread/unsubscribe", { threadId: thread.id }, 5000).catch(() => {});
    }
  }
  close() {
    const proc = this.proc; this.proc = undefined; this.ready = undefined;
    for (const listener of this.listeners) listener("hades/disconnected", { message: "Codex connection closed." });
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Codex connection closed.")); }
    this.pending.clear();
    const workspace = this.workspace; this.workspace = undefined;
    const cleanup = () => { if (workspace) rmSync(workspace, { recursive: true, force: true }); };
    if (proc && proc.exitCode === null && proc.signalCode === null) { proc.once("exit", cleanup); proc.stdin.end(); const kill = setTimeout(() => proc.kill(), 1500); kill.unref(); proc.once("exit", () => clearTimeout(kill)); } else cleanup();
  }
}
