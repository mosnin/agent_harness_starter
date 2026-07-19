import type { ModelCommand } from "../models/command";
import type { LocalPluginRegistry } from "../plugins/registry";
import type { SkillPackCatalog } from "../skill-packs/pack";
import type { SkillRegistry } from "../../swarm-runtime/skills/skill";
import type { MemoryStore } from "../memory/store";
import type { SessionStore } from "../memory/session-store";
import { InMemorySessionStore } from "../memory/session-store";
import { searchSessionsFts } from "../memory/session-search";
import type { InMemoryTrajectoryStore } from "../research/recorder";
import type { RoleRegistry } from "../teams/role";
import type { ToolsetManager } from "../tools/manager";
import { TeamFormer } from "../teams/former";
import { execEnabledRegistry } from "../exec/index";
import { runHierarchyCommand } from "./hierarchy-command";
import { runBenchCommand } from "./bench-command";
import { runSkillCommand } from "./skills-command";
import { runTuiCommand } from "./tui-command";
import { runExecCommand } from "./exec-command";
import { runToolsCommand } from "./tools-command";
import { runMemoryCommand } from "./memory-command";
import type { MemoryGuardDeps } from "./memory-command";

export interface CliResult {
  code: number;
  lines: string[];
}

export interface HadesCliDeps {
  version?: string;
  models?: ModelCommand;
  plugins?: LocalPluginRegistry;
  skillPacks?: SkillPackCatalog;
  skills?: SkillRegistry;
  memory?: MemoryStore;
  /** Session history for `hades memory search/timeline/show/summarize`.
   *  Absent -> those subcommands honestly report an empty history. */
  sessions?: SessionStore;
  /** Session summarizer for `hades memory summarize`; always reports its
   *  real mode (llm vs extractive) — extractive is never passed off as LLM. */
  summarizeSession?: (sessionId: string) => Promise<{ summary: string; mode: "llm" | "extractive" }>;
  /** STYX memory write-guard for `hades memory flags` + gate-aware `add`. */
  memoryGuard?: MemoryGuardDeps;
  trajectories?: InMemoryTrajectoryStore;
  /** Role catalog for `hades team`. */
  roles?: RoleRegistry;
  /** Tool catalog manager for `hades tools`; when present, `hades exec` also
   *  runs programs against the enabled catalog tools (+ builtins). */
  toolset?: ToolsetManager;
  /** Launch the interactive chat REPL (long-running). */
  onChat?: (args: string[]) => Promise<CliResult> | CliResult;
  /** Launch the messaging gateway (long-running). */
  onGateway?: (args: string[]) => Promise<CliResult> | CliResult;
}

const SUBCOMMANDS = ["chat", "tui", "gateway", "team", "model", "skills", "plugins", "memory", "learn", "tools", "exec", "browser", "help", "version"] as const;

/**
 * The unified `hades` command router — terminal-free so it unit-tests without a
 * shell. `run(argv)` dispatches the first token to a subcommand and returns
 * `{ code, lines }`; a thin bin script prints the lines and exits with the code.
 * Subcommands delegate to the same pieces the REPL uses (ModelCommand, the
 * plugin/skill-pack registries, the memory store), so behavior is consistent
 * across surfaces.
 */
export class HadesCli {
  private readonly version: string;
  /** Lazily-created empty session store used when no real one is configured. */
  private fallbackSessions?: InMemorySessionStore;

  constructor(private readonly deps: HadesCliDeps = {}) {
    this.version = deps.version ?? "0.1.0";
  }

  async run(argv: string[]): Promise<CliResult> {
    const [sub, ...rest] = argv;
    switch (sub) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        return this.help();
      case "version":
      case "--version":
      case "-v":
        return { code: 0, lines: [`hades ${this.version}`] };
      case "model":
        return this.model(rest);
      case "skills":
        return this.skills(rest);
      case "plugins":
        return this.plugins(rest);
      case "memory":
        return this.memory(rest);
      case "learn":
        return this.learn(rest);
      case "team":
        return this.team(rest);
      case "hierarchy":
        return runHierarchyCommand(rest);
      case "bench":
        return runBenchCommand(rest);
      case "skill":
        return runSkillCommand(rest);
      case "tui":
        return runTuiCommand(rest);
      case "tools":
        return this.tools(rest);
      case "exec":
        return this.exec(rest);
      case "browser":
        return this.browser(rest);
      case "chat":
        return this.deps.onChat ? this.deps.onChat(rest) : { code: 1, lines: ["chat is not available in this build."] };
      case "gateway":
        return this.deps.onGateway
          ? this.deps.onGateway(rest)
          : { code: 1, lines: ["gateway is not available in this build."] };
      default:
        return { code: 1, lines: [`Unknown command: ${sub}`, `Run \`hades help\` for usage.`] };
    }
  }

  private help(): CliResult {
    return {
      code: 0,
      lines: [
        `hades ${this.version} — the learning agent on top of the swarm`,
        "",
        "Usage: hades <command> [args]",
        "",
        "Commands:",
        "  chat                 Start the interactive REPL (memory + swarm)",
        "  tui                  Live keyboard-driven terminal dashboard over the swarm",
        "  gateway              Start the messaging gateway (Slack/Telegram/…)",
        "  model [use <id>]     Show or switch the active model",
        "  skills [packs]       List skills / available skill packs",
        "  plugins [list]       List available plugins",
        "  memory <sub>         Search facts + past sessions (FTS), timeline/show/summarize,",
        "                       guard flags, add (search/timeline/show/summarize/flags/add)",
        "  team <roles|plan>    List roles / preview a team for an objective",
        "  hierarchy <sub>      Swarm benchmarks: head-to-head/makespan/chaos/fuzz/stats",
        "  bench vtph           Verified-tasks-per-hour-per-dollar scoreboard",
        "  skill <sub>          Create/list/validate SKILL.md skills (new/list/show/validate)",
        "  tools <sub>          List/enable/disable the tool catalog (list/enable/disable/info)",
        "  exec <run|bench>     Run one program that chains tools (JS/Python, STYX-traced)",
        "  browser <sub>        Real Chromium browsing: open <url> / bench / probe (STYX-traced)",
        "  learn stats          Show the recorded-trajectory dataset size",
        "  version              Print the version",
        "  help                 Show this help",
      ],
    };
  }

  private tools(args: string[]): CliResult {
    if (!this.deps.toolset) return { code: 1, lines: ["The tool catalog is not configured in this build."] };
    return runToolsCommand(args, { manager: this.deps.toolset });
  }

  /** `hades exec` over the enabled catalog tools (+ builtins) when a toolset
   *  is configured; the plain builtin registry otherwise. A catalog/builtin
   *  name collision is a configuration bug — surfaced, never papered over. */
  private exec(args: string[]): Promise<CliResult> | CliResult {
    if (!this.deps.toolset) return runExecCommand(args);
    try {
      const registry = execEnabledRegistry(this.deps.toolset.buildRegistry());
      return runExecCommand(args, { registry });
    } catch (err) {
      return { code: 1, lines: [err instanceof Error ? err.message : String(err)] };
    }
  }

  /** `hades browser open|bench|probe` — the Phase 3 browsing surface.
   *  The command module and its real deps (which statically pull
   *  `playwright-core`) are loaded lazily so CLI startup never pays for
   *  the browser stack, and an install without playwright-core degrades
   *  to an honest one-line error instead of a crashed CLI. */
  private async browser(args: string[]): Promise<CliResult> {
    const lines: string[] = [];
    try {
      const [{ buildBrowserCommand }, { defaultBrowserCliDeps }] = await Promise.all([
        import("./browser-command"),
        import("./browser-deps"),
      ]);
      const command = buildBrowserCommand(
        defaultBrowserCliDeps({ stdout: (l) => lines.push(l), stderr: (l) => lines.push(l) })
      );
      const code = await command.run(args);
      return { code, lines };
    } catch (err) {
      lines.push(`browser support unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return { code: 1, lines };
    }
  }

  private model(args: string[]): CliResult {
    if (!this.deps.models) return { code: 1, lines: ["Model management is not configured."] };
    const res = this.deps.models.run(args);
    return { code: res.ok ? 0 : 1, lines: res.lines };
  }

  private skills(args: string[]): CliResult {
    const [sub] = args;
    if (sub === "packs") {
      if (!this.deps.skillPacks) return { code: 1, lines: ["No skill-pack catalog configured."] };
      const packs = this.deps.skillPacks.list();
      if (!packs.length) return { code: 0, lines: ["No skill packs available."] };
      return { code: 0, lines: packs.map((p) => `${p.name} — ${p.description} [${p.skills.join(", ")}]`) };
    }
    if (!this.deps.skills) return { code: 1, lines: ["No skill registry configured."] };
    const skills = this.deps.skills.list();
    if (!skills.length) return { code: 0, lines: ["No skills registered."] };
    return { code: 0, lines: skills.map((s) => `${s.name} — ${s.description} (${s.capabilities.join(", ")})`) };
  }

  private plugins(args: string[]): CliResult {
    void args;
    if (!this.deps.plugins) return { code: 1, lines: ["No plugin registry configured."] };
    const plugins = this.deps.plugins.available();
    if (!plugins.length) return { code: 0, lines: ["No plugins available."] };
    return { code: 0, lines: plugins.map((p) => `${p.name}${p.description ? ` — ${p.description}` : ""}`) };
  }

  /** `hades memory <sub>` — the full memory surface (search over facts AND
   *  past sessions via the BM25F FTS index, timeline/show/summarize, the STYX
   *  write-guard's flags workflow, add). Delegates to `runMemoryCommand`; this
   *  method only assembles the real deps. With no session store configured a
   *  real empty in-memory one is used, so session subcommands honestly report
   *  an empty history instead of erroring. */
  private memory(args: string[]): Promise<CliResult> | CliResult {
    const memory = this.deps.memory;
    if (!memory) return { code: 1, lines: ["Memory is not configured."] };
    const sessions = this.deps.sessions ?? (this.fallbackSessions ??= new InMemorySessionStore());
    return runMemoryCommand(
      {
        memory,
        sessions,
        searchSessions: (query, opts) => searchSessionsFts(sessions, query, opts),
        summarize: this.deps.summarizeSession,
        guard: this.deps.memoryGuard,
      },
      args
    );
  }

  private async team(args: string[]): Promise<CliResult> {
    if (!this.deps.roles) return { code: 1, lines: ["Team roles are not configured."] };
    const [sub, ...rest] = args;
    if (sub === "roles" || sub === undefined) {
      const lines = this.deps.roles.list().map((r) => `${r.name} — ${r.capabilities.join(", ")}`);
      return { code: 0, lines: lines.length ? lines : ["No roles registered."] };
    }
    if (sub === "plan") {
      const objective = rest.join(" ");
      if (!objective) return { code: 1, lines: ["Usage: hades team plan <objective>"] };
      try {
        const former = new TeamFormer(this.deps.roles);
        const team = await former.form({ objective });
        const counts = new Map<string, number>();
        for (const s of team.roster) counts.set(s.role, (counts.get(s.role) ?? 0) + 1);
        const roster = [...counts.entries()].map(([role, n]) => `  ${role} ×${n}`);
        return { code: 0, lines: [`Team ${team.teamId} (${team.roster.length} agents):`, ...roster] };
      } catch (err) {
        return { code: 1, lines: [err instanceof Error ? err.message : String(err)] };
      }
    }
    return { code: 1, lines: [`Unknown team command: ${sub}`] };
  }

  private learn(args: string[]): CliResult {
    const [sub] = args;
    if (sub && sub !== "stats") return { code: 1, lines: [`Unknown learn command: ${sub}`] };
    const n = this.deps.trajectories?.size() ?? 0;
    return { code: 0, lines: [`Recorded trajectories: ${n}`] };
  }
}

export const HADES_SUBCOMMANDS = SUBCOMMANDS;
