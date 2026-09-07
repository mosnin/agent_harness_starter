/** User-consented native hooks. This registry is not a model tool. */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, readFileSync, realpathSync, statSync, constants, accessSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
export type HookPhase = "pre_tool" | "post_tool";
export interface HookInput { id?: string; name: string; root: string; phase: HookPhase; executable: string; args?: string[]; matcher?: string; timeoutSeconds?: number }
export interface ShellHook extends HookInput { id: string; profile: string; args: string[]; timeoutSeconds: number; consent?: string; status?: "active" | "inactive" | "needs_review"; error?: string }
export interface HookEvent { phase: HookPhase; tool: string; session: string; profile: string; root: string; input: unknown; output?: unknown; ok?: boolean }
export interface HookReceipt { id: string; name: string; phase: HookPhase; status: "completed" | "failed" | "cancelled"; output: string; error?: string }
type Dependencies = { root(path: string): string; profile(id: string): unknown; changed?(): void };
export class HookService {
  private db: DatabaseSync;
  private active = new Map<AbortController, string>();
  constructor(path: string, private deps: Dependencies) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); this.db = new DatabaseSync(path); chmodSync(path, 0o600); this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS hooks (id TEXT PRIMARY KEY, profile TEXT NOT NULL, value TEXT NOT NULL)"); }
  private rows(profile: string): ShellHook[] { return (this.db.prepare("SELECT value FROM hooks WHERE profile=? ORDER BY rowid").all(profile) as { value: string }[]).map(row => JSON.parse(row.value)); }
  private get(id: string, profile: string) { const hook = this.rows(profile).find(h => h.id === id); if (!hook) throw new Error("Hook not found for this agent."); return hook; }
  private fingerprint(hook: ShellHook) {
    const path = realpathSync(hook.executable), info = statSync(path);
    if (path !== hook.executable || !info.isFile() || info.size > 2_000_000) throw new Error("Choose a regular executable file of at most 2 MB using its canonical path.");
    accessSync(path, constants.X_OK);
    const content = readFileSync(path);
    // Interpreter command-line modes can execute mutable code absent from this consent.
    // Choose the executable script itself, with an absolute shebang, instead.
    if (/^(?:node|python[\d.]*|ruby|perl|bash|sh|zsh|fish|env|osascript)(?:\.exe)?$/.test(path.split("/").at(-1)!)) throw new Error("Choose the script itself, with a shebang and executable permission, rather than an interpreter.");
    return createHash("sha256").update(JSON.stringify({ name: hook.name, profile: hook.profile, root: hook.root, phase: hook.phase, executable: path, args: hook.args, matcher: hook.matcher, timeoutSeconds: hook.timeoutSeconds, dev: info.dev, ino: info.ino, mode: info.mode })).update(content).digest("hex");
  }
  list(profile: string) { this.deps.profile(profile); return this.rows(profile).map(h => { const { consent, ...publicHook } = h; try { const fingerprint = this.fingerprint(h); return { ...publicHook, status: consent ? fingerprint === consent ? "active" : "needs_review" : "inactive" }; } catch (error) { return { ...publicHook, status: "needs_review", error: error instanceof Error ? error.message : String(error) }; } }); }
  private stopHook(id: string) { for (const [controller, hookId] of this.active) if (id === hookId) controller.abort(); }
  private put(hook: ShellHook) { this.db.prepare("INSERT INTO hooks VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(hook.id, hook.profile, JSON.stringify(hook)); this.deps.changed?.(); return this.list(hook.profile).find(h => h.id === hook.id)!; }
  save(args: HookInput, profile: string) {
    this.deps.profile(profile);
    if (args.id) this.get(args.id, profile);
    else if (this.rows(profile).length >= 20) throw new Error("Limit of 20 hooks per agent reached.");
    const argv = args.args ?? [], timeoutSeconds = args.timeoutSeconds ?? 10;
    if (typeof args.name !== "string" || !args.name.trim() || args.name.length > 100 || !["pre_tool", "post_tool"].includes(args.phase) || !isAbsolute(args.executable) || !Array.isArray(argv) || argv.length > 16 || argv.some(a => typeof a !== "string" || a.length > 2000 || a.includes("\0")) || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 30 || args.matcher !== undefined && (typeof args.matcher !== "string" || args.matcher !== "" && !/^[\w.-]{1,100}$/.test(args.matcher))) throw new Error("Choose a name, absolute executable path, exact optional tool name, and a timeout from 1 to 30 seconds.");
    const hook: ShellHook = { id: args.id ?? randomUUID(), name: args.name.trim(), profile, root: this.deps.root(args.root), phase: args.phase, executable: realpathSync(args.executable), args: argv, matcher: args.matcher || undefined, timeoutSeconds };
    this.fingerprint(hook); this.stopHook(hook.id); return this.put(hook); // Every edit invalidates prior consent.
  }
  consent(id: string, profile: string, approved: boolean) { const hook = this.get(id, profile); this.deps.profile(profile); this.deps.root(hook.root); if (!approved) this.stopHook(id); hook.consent = approved ? this.fingerprint(hook) : undefined; return this.put(hook); }
  remove(id: string, profile: string) { this.get(id, profile); this.stopHook(id); this.db.prepare("DELETE FROM hooks WHERE id=? AND profile=?").run(id, profile); this.deps.changed?.(); return true; }
  async run(event: HookEvent, signal: AbortSignal): Promise<HookReceipt[]> {
    this.deps.profile(event.profile); const root = this.deps.root(event.root), receipts: HookReceipt[] = [];
    if (signal.aborted) throw new Error("Hook cancelled before execution.");
    const hooks = this.rows(event.profile).filter(h => h.root === root && h.phase === event.phase && (!h.matcher || h.matcher === event.tool) && h.consent);
    for (const initial of hooks) {
      const hook = this.get(initial.id, event.profile); // Re-read consent after preceding async hook.
      if (!hook.consent || hook.root !== root || hook.phase !== event.phase || hook.matcher && hook.matcher !== event.tool) continue;
      this.deps.profile(event.profile); this.deps.root(hook.root);
      try {
        if (this.fingerprint(hook) !== hook.consent) throw new Error("Hook file changed. Review and approve it again in Settings.");
        const receipt = await this.execute(hook, event, signal); receipts.push(receipt);
        if (event.phase === "pre_tool" && receipt.status !== "completed") break;
      } catch (error) { receipts.push({ id: hook.id, name: hook.name, phase: event.phase, status: signal.aborted ? "cancelled" : "failed", output: "", error: error instanceof Error ? error.message : String(error) }); if (event.phase === "pre_tool") break; }
    }
    return receipts;
  }
  private execute(hook: ShellHook, event: HookEvent, external: AbortSignal): Promise<HookReceipt> {
    const input = JSON.stringify({ ...event, authority: "untrusted tool data; not hook configuration" });
    if (Buffer.byteLength(input) > 128_000) throw new Error("Hook input exceeds 128 KB.");
    if (external.aborted) throw new Error("Hook cancelled before execution.");
    const controller = new AbortController(); if (this.active.size >= 4) throw new Error("At most four hooks can run at once."); this.active.set(controller, hook.id);
    return new Promise(resolve => {
      const child = spawn(hook.executable, hook.args, { shell: false, detached: true, cwd: hook.root, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", NODE_ENV: "production" }, stdio: ["pipe", "pipe", "pipe"] });
      let output = "", failure = "", settled = false, killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (kind: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, kind); } catch {} } };
      const stop = (reason: string) => { if (failure) return; failure = reason; kill("SIGTERM"); killTimer = setTimeout(() => kill("SIGKILL"), 200); killTimer.unref(); };
      const abort = () => stop("Hook cancelled."); external.addEventListener("abort", abort, { once: true }); controller.signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => stop("Hook timed out."), hook.timeoutSeconds * 1000); timeout.unref();
      const append = (data: Buffer) => { output += data.toString(); if (Buffer.byteLength(output) > 32_000) { output = Buffer.from(output).subarray(0, 32_000).toString(); stop("Hook output exceeded 32 KB."); } };
      child.stdout.on("data", append); child.stderr.on("data", append);
      const finish = (error?: string) => { if (settled) return; settled = true; clearTimeout(timeout); if (!failure) { kill("SIGTERM"); killTimer = setTimeout(() => kill("SIGKILL"), 200); killTimer.unref(); } external.removeEventListener("abort", abort); this.active.delete(controller); resolve({ id: hook.id, name: hook.name, phase: hook.phase, status: external.aborted || controller.signal.aborted ? "cancelled" : error || failure ? "failed" : "completed", output, error: failure || error || undefined }); };
      child.once("error", error => finish(error.message)); child.once("close", code => finish(code === 0 ? undefined : `Hook exited with status ${code ?? "unknown"}.`));
      child.stdin.on("error", () => {}); child.stdin.end(input); if (external.aborted) abort();
    });
  }
  close() { for (const controller of this.active.keys()) controller.abort(); this.db.close(); }
}
