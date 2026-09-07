/** Subscription inference through OpenAI's official, bundled app-server.
 * Credentials belong to Codex in a Hades-specific home, never to the webview.
 */
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatRequest, ChatResponse, ModelClient } from "./client";

type Json = Record<string, any>;
type InferenceThread = { id: string; signature: string; prefix: string[]; touched: number; busy: boolean };
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A constrained final message is one Hades action, never executable commentary. */
const FILE_ACTIONS = ["read", "write", "append", "list", "stat", "mkdir", "delete"];
export function codexActionSchema(tools: NonNullable<ChatRequest["tools"]> = []) {
  const textInput = { type: "string", description: "The exact input string for tools other than file_ops." };
  const fileInput = { type: "object", additionalProperties: false, required: ["op", "path", "content", "maxBytes"], properties: {
    op: { type: "string", enum: FILE_ACTIONS }, path: { type: "string" },
    content: { type: ["string", "null"], description: "Exact file contents as a string. Do not serialize these contents into another JSON string. Null for operations without contents." },
    maxBytes: { type: ["integer", "null"], minimum: 0, description: "Read byte limit, or null for the default." },
  } };
  return { type: "object", additionalProperties: false, required: ["kind", "tool", "input", "answer"], properties: {
    kind: { type: "string", enum: tools.length ? ["tool", "answer"] : ["answer"] },
    tool: { type: "string", enum: ["", ...tools.map(t => t.name)] },
    input: tools.some(t => t.name === "file_ops") ? { anyOf: [textInput, fileInput] } : textInput,
    answer: { type: "string" },
  } };
}
export function decodeCodexAction(text: string, tools: NonNullable<ChatRequest["tools"]> = []): string {
  let action: any;
  try { action = JSON.parse(text); } catch { throw new Error("Codex returned an invalid structured action. No tool was executed."); }
  if (!action || typeof action !== "object" || Array.isArray(action) ||
      Object.keys(action).sort().join(",") !== "answer,input,kind,tool" ||
      ![action.kind, action.tool, action.answer].every(v => typeof v === "string"))
    throw new Error("Codex returned an invalid structured action. No tool was executed.");
  if (action.kind === "tool" && tools.some(t => t.name === action.tool) && !action.answer) {
    let input: string;
    if (typeof action.input === "string") input = action.input;
    else {
      const value = action.input;
      if (action.tool !== "file_ops" || !value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).sort().join(",") !== "content,maxBytes,op,path" || !FILE_ACTIONS.includes(value.op) ||
          typeof value.path !== "string" || !value.path || (value.content !== null && typeof value.content !== "string") ||
          (["write", "append"].includes(value.op) && typeof value.content !== "string") ||
          (value.maxBytes !== null && (!Number.isSafeInteger(value.maxBytes) || value.maxBytes < 0)))
        throw new Error("Codex returned an invalid typed file action. No tool was executed.");
      input = JSON.stringify({ op: value.op, path: value.path, ...(value.content === null ? {} : { content: value.content }),
        ...(value.maxBytes === null ? {} : { maxBytes: value.maxBytes }) });
    }
    return `TOOL: ${action.tool}\nINPUT: ${input}`;
  }
  if (action.kind === "answer" && !action.tool && action.input === "" && action.answer.trim()) return `ANSWER: ${action.answer}`;
  throw new Error("Codex returned an ambiguous or unsupported action. No tool was executed.");
}

type ActionItem = { text: string; phase?: string | null; complete: boolean };
class StructuredActionError extends Error {
  constructor(message: string, readonly usage: { tokensIn: number; tokensOut: number; cachedInputTokens: number }) { super(message); }
}
/** Unknown phases may contain commentary. Only a unique schema-valid action is
 * executable. Explicit final phases are never replaced by a guessed candidate. */
export function selectCodexAction(items: ActionItem[], tools: NonNullable<ChatRequest["tools"]> = []): string {
  const finals = items.filter(item => item.phase === "final_answer");
  if (finals.length) {
    if (finals.length !== 1) throw new Error("Codex returned multiple explicit final actions. No tool was executed.");
    return decodeCodexAction(finals[0].text, tools);
  }
  const actions: string[] = [];
  for (const item of items.filter(item => item.phase !== "commentary")) {
    try { actions.push(decodeCodexAction(item.text, tools)); } catch { /* Non-action prose is not executable. */ }
  }
  if (actions.length !== 1) throw new Error(`Codex returned ${actions.length ? "multiple" : "missing"} structured final actions. No tool was executed.`);
  return actions[0];
}

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
  private inferenceThreads = new Map<string, InferenceThread>();
  private activeSessions = new Set<string>();
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
      this.write({ id: message.id, error: { code: -32601, message: "Native execution is disabled. Return a structured Hades action instead." } });
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
    let previous: StructuredActionError | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.infer(attempt ? { ...req, messages: [...req.messages, { role: "user", content:
          "Your last inference response did not contain exactly one valid structured action. Hades executed no action from that response. Inspect the supplied history and return exactly one action matching the JSON schema. Do not repeat completed actions merely to recover the response format." }] } : req);
        if (previous && req.transportSessionId) {
          const state = this.inferenceThreads.get(req.transportSessionId);
          if (state) state.prefix = [...req.messages.filter(m => m.role !== "system").map(fingerprint), fingerprint({ role: "assistant", content: response.text })];
        }
        return previous ? { ...response, tokensIn: response.tokensIn + previous.usage.tokensIn, tokensOut: response.tokensOut + previous.usage.tokensOut,
          cachedInputTokens: (response.cachedInputTokens ?? 0) + previous.usage.cachedInputTokens } : response;
      } catch (error) {
        if (attempt || !(error instanceof StructuredActionError) || req.signal?.aborted || error.usage.tokensIn + error.usage.tokensOut <= 0) throw error;
        previous = error;
      }
    }
    throw new Error("Codex structured inference did not complete");
  }
  private async infer(req: ChatRequest): Promise<ChatResponse> {
    req.signal?.throwIfAborted();
    if (!(await this.status()).connected) throw new Error("Sign in with ChatGPT in Settings to use your Codex subscription.");
    const system = req.messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
    const history = req.messages.filter(m => m.role !== "system");
    const tools = req.tools ?? [];
    const signature = fingerprint([req.model, system, tools]);
    const hashes = history.map(fingerprint);
    const key = req.transportSessionId;
    if (key && this.activeSessions.has(key)) throw new Error("This Codex inference session already has an active turn.");
    if (key) this.activeSessions.add(key);
    try {
      let cached = key ? this.inferenceThreads.get(key) : undefined;
      if (cached?.busy) throw new Error("This Codex inference session already has an active turn.");
      // Exact prefix matching prevents reuse across compacted context, changed images,
      // profile/model changes or a caller accidentally recycling a session identifier.
      if (cached && (cached.signature !== signature || hashes.length <= cached.prefix.length ||
          !cached.prefix.every((hash, i) => hashes[i] === hash))) {
        this.inferenceThreads.delete(key!);
        await this.request("thread/unsubscribe", { threadId: cached.id }, 5000).catch(() => {});
        cached = undefined;
      }
      const offset = cached?.prefix.length ?? 0;
      if (!cached) {
        const { thread } = await this.request("thread/start", {
          model: req.model, modelProvider: "openai", cwd: this.workspace,
          ephemeral: true, sandbox: "read-only", approvalPolicy: "never",
          baseInstructions: system,
          developerInstructions: [
            "You are the reasoning engine for Hades. Return exactly one action matching the supplied JSON schema.",
            "The JSON action envelope replaces the older TOOL/INPUT/ANSWER text format in the base instructions.",
            "Hades executes tool actions on the user's actual project, obtains approvals and returns real results on the next turn.",
            "The native Codex sandbox is isolated and has no project access; its read-only status does not restrict Hades tools.",
            "To inspect or modify the project, return a tool action using an available Hades tool. Do not invoke native tools.",
            "Use project-relative file paths for Hades tools. Never prepend the isolated Codex working directory to a project path.",
            "Keep tool and input empty strings for answers; keep answer empty for tool actions. Report completion only after verifying requested work.",
          ...(tools.some(t => t.name === "file_ops") ? ["For file_ops, always use the typed input object with op, path, content, maxBytes. Put source code directly in content, preserving its exact quotes and newlines. Do not serialize a second JSON document inside input. Set unused content and maxBytes to null. For other tools, use their documented input string."] : []),
            "Available Hades tools: " + JSON.stringify(tools),
          ].join("\n"),
        });
        cached = { id: thread.id, signature, prefix: [], touched: Date.now(), busy: false };
        if (key) this.inferenceThreads.set(key, cached);
      }
      const state = cached;
      state.busy = true;
      let turnId = "", tokensIn = 0, tokensOut = 0, cachedInputTokens = 0, success = false, keepAlive = false;
      const messages = new Map<string, ActionItem>();
      let resolveTurn!: (v: ChatResponse) => void, rejectTurn!: (e: Error) => void;
      const done = new Promise<ChatResponse>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
      const listener = (method: string, p: Json) => {
        if (method === "hades/disconnected") return rejectTurn(new Error(p.message));
        if (p.threadId !== state.id || (turnId && p.turnId && p.turnId !== turnId)) return;
        if (method === "turn/started") turnId = p.turn.id;
        if (method === "item/agentMessage/delta") {
          const id = p.itemId ?? "legacy";
          const item = messages.get(id) ?? { text: "", complete: false };
          item.text += p.delta; messages.set(id, item);
          if ([...messages.values()].reduce((n, m) => n + m.text.length, 0) > 4_000_000)
            rejectTurn(new Error("Codex response exceeded its limit."));
        }
        if ((method === "item/started" || method === "item/completed") && p.item?.type === "agentMessage") {
          const item = p.item;
          messages.set(item.id, { text: item.text ?? messages.get(item.id)?.text ?? "", phase: item.phase, complete: method === "item/completed" });
        }
        if (method === "thread/tokenUsage/updated") {
          // total accumulates across a persistent thread. last belongs to this turn.
          const usage = p.tokenUsage.last ?? p.tokenUsage.total;
          tokensIn = usage.inputTokens; tokensOut = usage.outputTokens; cachedInputTokens = usage.cachedInputTokens ?? 0;
        }
        if (method === "turn/completed") {
          if (!turnId || p.turn.id !== turnId) return;
          if (p.turn.status !== "completed") return rejectTurn(new Error(p.turn.error?.message ?? "Codex turn was interrupted."));
          try {
            // Completed turn snapshots can include messages whose per-item
            // completion notifications were absent. Merge by identity, never by order.
            for (const item of p.turn.items ?? []) if (item.type === "agentMessage" && typeof item.id === "string") {
              messages.set(item.id, { text: item.text ?? messages.get(item.id)?.text ?? "", phase: item.phase, complete: true });
            }
            const items = [...messages.values()];
            let validActions = 0;
            for (const item of items.filter(item => item.phase !== "commentary")) try { decodeCodexAction(item.text, tools); validActions++; } catch {}
            this.emit({ kind: "desktop.codex.transport", thread: state.id, turn: p.turn.id, status: p.turn.status,
              snapshotItems: p.turn.items?.length ?? 0, itemsView: p.turn.itemsView ?? "unspecified", validActions,
              items: items.map(item => ({ phase: item.phase ?? "unknown", chars: item.text.length, complete: item.complete })) });
            const text = selectCodexAction(items, tools);
            req.onText?.(text);
            resolveTurn({ text, tokensIn, tokensOut, cachedInputTokens, usd: 0, costMeasured: false, model: req.model, provider: "codex" });
          } catch (error) { rejectTurn(new StructuredActionError(error instanceof Error ? error.message : String(error), { tokensIn, tokensOut, cachedInputTokens })); }
        }
      };
      const abort = () => { rejectTurn(new Error("Codex request cancelled.")); };
      const timeout = setTimeout(() => rejectTurn(new Error("Codex response timed out. Try again.")), 180_000);
      this.listeners.add(listener); req.signal?.addEventListener("abort", abort, { once: true });
      void done.catch(() => {});
      try {
        req.signal?.throwIfAborted();
        const input: Json[] = [];
        for (const message of history.slice(offset)) {
          input.push({ type: "text", text: `${message.role.toUpperCase()}:\n${message.content}`, text_elements: [] });
          for (const url of message.images ?? []) input.push({ type: "image", url });
        }
        const started = await Promise.race([
          this.request("turn/start", { threadId: state.id, input, outputSchema: codexActionSchema(tools) }),
          done.then(() => null),
        ]);
        if (started) turnId = started.turn.id;
        req.signal?.throwIfAborted();
        const result = await done;
        state.prefix = [...hashes, fingerprint({ role: "assistant", content: result.text })];
        state.touched = Date.now(); success = true; keepAlive = result.text.startsWith("TOOL:");
        return result;
      } finally {
        clearTimeout(timeout); req.signal?.removeEventListener("abort", abort); this.listeners.delete(listener);
        state.busy = false;
        if (!success && turnId) await this.request("turn/interrupt", { threadId: state.id, turnId }, 5000).catch(() => {});
        if (!success || !key || !keepAlive) {
          if (key && this.inferenceThreads.get(key) === state) this.inferenceThreads.delete(key);
          await this.request("thread/unsubscribe", { threadId: state.id }, 5000).catch(() => {});
        }
        const idle = [...this.inferenceThreads.entries()].filter(([, t]) => !t.busy).sort((a, b) => a[1].touched - b[1].touched);
        while (this.inferenceThreads.size > 16 && idle.length) {
          const [oldKey, old] = idle.shift()!;
          this.inferenceThreads.delete(oldKey);
          await this.request("thread/unsubscribe", { threadId: old.id }, 5000).catch(() => {});
        }
      }
    } finally { if (key) this.activeSessions.delete(key); }
  }
  async releaseSession(id: string) {
    const state = this.inferenceThreads.get(id);
    if (!state) return;
    if (state.busy || this.activeSessions.has(id)) throw new Error("Cannot release an active Codex inference session");
    this.inferenceThreads.delete(id);
    await this.request("thread/unsubscribe", { threadId: state.id }, 5000).catch(() => {});
  }
  close() {
    const proc = this.proc; this.proc = undefined; this.ready = undefined;
    this.inferenceThreads.clear(); this.activeSessions.clear();
    for (const listener of this.listeners) listener("hades/disconnected", { message: "Codex connection closed." });
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Codex connection closed.")); }
    this.pending.clear();
    const workspace = this.workspace; this.workspace = undefined;
    const cleanup = () => { if (workspace) rmSync(workspace, { recursive: true, force: true }); };
    if (proc && proc.exitCode === null && proc.signalCode === null) { proc.once("exit", cleanup); proc.stdin.end(); const kill = setTimeout(() => proc.kill(), 1500); kill.unref(); proc.once("exit", () => clearTimeout(kill)); } else cleanup();
  }
}
