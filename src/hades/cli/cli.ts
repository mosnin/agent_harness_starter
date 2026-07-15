import type { ModelCommand } from "../models/command";
import type { LocalPluginRegistry } from "../plugins/registry";
import type { SkillPackCatalog } from "../skill-packs/pack";
import type { SkillRegistry } from "../../swarm-runtime/skills/skill";
import type { MemoryStore } from "../memory/store";
import type { InMemoryTrajectoryStore } from "../research/recorder";
import type { RoleRegistry } from "../teams/role";
import { TeamFormer } from "../teams/former";

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
  trajectories?: InMemoryTrajectoryStore;
  /** Role catalog for `hades team`. */
  roles?: RoleRegistry;
  /** Launch the interactive chat REPL (long-running). */
  onChat?: (args: string[]) => Promise<CliResult> | CliResult;
  /** Launch the messaging gateway (long-running). */
  onGateway?: (args: string[]) => Promise<CliResult> | CliResult;
}

const SUBCOMMANDS = ["chat", "gateway", "team", "model", "skills", "plugins", "memory", "learn", "help", "version"] as const;

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
        "  gateway              Start the messaging gateway (Slack/Telegram/…)",
        "  model [use <id>]     Show or switch the active model",
        "  skills [packs]       List skills / available skill packs",
        "  plugins [list]       List available plugins",
        "  memory <search|add>  Search or add long-term memories",
        "  team <roles|plan>    List roles / preview a team for an objective",
        "  learn stats          Show the recorded-trajectory dataset size",
        "  version              Print the version",
        "  help                 Show this help",
      ],
    };
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

  private memory(args: string[]): CliResult {
    if (!this.deps.memory) return { code: 1, lines: ["Memory is not configured."] };
    const [sub, ...rest] = args;
    const arg = rest.join(" ");
    if (sub === "add") {
      if (!arg) return { code: 1, lines: ["Usage: hades memory add <fact>"] };
      this.deps.memory.add({ fact: arg, source: "cli", salience: 0.8 });
      return { code: 0, lines: [`Remembered: ${arg}`] };
    }
    if (sub === "search" || sub === undefined) {
      const hits = this.deps.memory.search(arg || "", { limit: 10 });
      if (!hits.length) return { code: 0, lines: ["No matching memories."] };
      return { code: 0, lines: hits.map((h) => `• ${h.fact}`) };
    }
    return { code: 1, lines: [`Unknown memory command: ${sub}`] };
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
