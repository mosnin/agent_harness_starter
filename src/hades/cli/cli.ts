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
import { runSkillEvolveCommand } from "./skill-evolve-command";
import { runTuiCommand } from "./tui-command";
import { runExecCommand } from "./exec-command";
import { runToolsCommand } from "./tools-command";
import { runMemoryCommand } from "./memory-command";
import type { MemoryGuardDeps } from "./memory-command";
import { runProfileCommand } from "./profile-command";
import type { ProfileCommandDeps } from "./profile-command";
import { runBackendsCommand } from "./backends-command";
import type { BackendsCommandDeps } from "./backends-command";
import { runShowdownCommand } from "./showdown-command";
import { runShowdownLiveCommand } from "./showdown-live-command";
import { runShowdownVerifyCommand, runShowdownReadyCommand } from "./showdown-verify-command";
import { runLiveShowdown, verifyLiveArtifacts } from "../bench/showdown-live";
import { runSkillsHubCommand } from "./skills-hub-command";
import type { ScheduleCommandDeps } from "./schedule-command";
import type { StateCommandDeps } from "./state-command";
import type { MigrateCommandDeps } from "./migrate-command";
import type { InstallCommandDeps } from "./install-command";
import type { TrustCommandDeps } from "./trust-command";
import type { MarketCommandDeps } from "./market-command";
import type { RouteCommandDeps } from "./route-command";
import type { EvalCliDeps } from "./eval-command";
import type { DatasetCliDeps } from "./dataset-command";
import { join } from "node:path";

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
  /** Phase-5 dialectic user model for `hades profile`. A lazy factory so
   *  building the CLI never touches the profile's persistence path unless
   *  the profile command is actually run; the result is cached after the
   *  first call so repeated subcommands share one store instance. */
  profile?: () => ProfileCommandDeps;
  /** Phase-6 remote-compute fleet for `hades backends`. A lazy factory so
   *  building the CLI never constructs the BackendManager/ledger (or probes
   *  docker) unless a backends subcommand is actually run; the result is
   *  cached after the first call so repeated subcommands share one fleet. */
  backends?: () => BackendsCommandDeps;
  /** Phase-9 scheduler (`hades schedule`). A lazy factory so building the
   *  CLI never opens the on-disk job store (or the delivery router's crypto
   *  stack) unless a schedule subcommand actually runs; the result is cached
   *  after the first call so repeated subcommands share one store instance.
   *  Absent -> `defaultScheduleDeps()` (env-driven data dir, builtin `note`
   *  executor, zero-sender verified delivery router — `hades schedule status`
   *  reports that wiring honestly). */
  schedule?: () => ScheduleCommandDeps;
  /** Shared workspace store (`hades state`). A lazy factory so building the
   *  CLI never opens `<dataDir>/state` (nor takes its cross-process lock)
   *  unless a state subcommand actually runs; the result is cached after the
   *  first call so repeated subcommands share one store instance and one
   *  actor identity. Absent -> `defaultStateDeps()`, which resolves the same
   *  `<dataDir>/state` root and the same persisted `cli` actor id, but
   *  without the real session/memory engine adapters `buildHadesCli` wires. */
  state?: () => StateCommandDeps;
  /** Migration off Hermes/OpenClaw (`hades migrate`). A lazy factory so
   *  building the CLI never probes the filesystem for foreign installs (nor
   *  opens this install's memory/session stores) unless a migrate subcommand
   *  actually runs; the result is cached after the first call so `plan` and
   *  `apply` in one process share one set of engine handles. Absent ->
   *  `defaultMigrateDeps()` (real `process.env`/home/platform, the same
   *  `$HADES_DATA_DIR|.hades` data directory every other surface uses). */
  migrate?: () => MigrateCommandDeps;
  /** Installer/portable-bundle surface (`hades install`). A lazy factory so
   *  building the CLI never probes the host (platform, PATH, writability)
   *  unless an install subcommand actually runs; cached after the first call.
   *  Absent -> `defaultInstallDeps()` (real `$HADES_REPO_ROOT`-or-cwd repo
   *  root and the version read from that root's real package.json). */
  install?: () => InstallCommandDeps;
  /** Unified trust gate (`hades trust`). A lazy factory so building the CLI
   *  never mints/reads the ed25519 signing key, opens the hash-chained
   *  budget ledger, or loads the persisted conformal calibration unless a
   *  trust subcommand actually runs; the result is cached after the first
   *  call so `calibrate` and `admit` in one process share one stack (one
   *  registry, one CA identity, one budget chain). Absent ->
   *  `defaultTrustDeps()` over the same `$HADES_DATA_DIR|.hades` data
   *  directory every other surface uses. */
  trust?: () => TrustCommandDeps;
  /** Verified-work market (`hades market`). Lazy for the same reason `trust`
   *  is: building the CLI must never touch `<dataDir>/market`, read the
   *  signing identity, or deserialize a reputation ledger. Cached after the
   *  first market subcommand runs, so one process shares one ledger, one
   *  economy and one replay registry across subcommands. */
  market?: () => MarketCommandDeps;
  /** Budget-constrained router (`hades route`). Lazy for the same reason
   *  `market` is: building the CLI must never touch `<dataDir>/routing`,
   *  deserialize a bandit posterior, or re-fit the conformal gate. Cached
   *  after the first route subcommand runs, so one process shares one arm
   *  catalog, one measured cost model, one budget and one hash-chained
   *  routing ledger across subcommands. */
  route?: () => RouteCommandDeps;
  /** Continuous eval + the never-regress gate (`hades eval`). Lazy for the
   *  same reason `route` is, and for one more: `EvalHistoryLedger` takes a
   *  real cross-process lock on `<dataDir>/eval`, so constructing it eagerly
   *  would make every unrelated `hades` invocation contend for it. Cached
   *  after the first eval subcommand runs, so one process shares one
   *  hash-chained history ledger, one gate policy and one verdict journal.
   *  Absent -> `defaultEvalCliDeps()` over the same `$HADES_DATA_DIR|.hades`
   *  data directory every other surface uses. */
  eval?: () => EvalCliDeps;
  /** Verified-trajectory data flywheel (`hades dataset`). Lazy for the same
   *  reason `eval` is: `VerifiedTrajectoryCorpus` takes a real cross-process
   *  lock on `<dataDir>/dataset/corpus/.lock` and writes a header on
   *  construction, so building the CLI — or running `hades dataset help` —
   *  must never open it. Cached after the first dataset subcommand runs, so
   *  one process shares one hash-chained corpus across subcommands.
   *  Absent -> `defaultDatasetCliDeps()` over the same `$HADES_DATA_DIR|.hades`
   *  data directory every other surface uses. */
  dataset?: () => DatasetCliDeps;
  /** Skill-library directory for `hades skills hub` (agentskills.io interop).
   *  Absent -> `$HADES_SKILLS_DIR`, else `<HADES_DATA_DIR|.hades>/skills` —
   *  the same convention `hades skill` uses. */
  skillsDir?: string;
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

const SUBCOMMANDS = ["chat", "tui", "gateway", "schedule", "state", "migrate", "install", "trust", "market", "route", "cluster", "eval", "dataset", "team", "model", "skills", "plugins", "memory", "profile", "backends", "showdown", "learn", "tools", "exec", "browser", "help", "version"] as const;

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
  /** Cached result of the lazy `deps.profile` factory (see HadesCliDeps). */
  private profileDeps?: ProfileCommandDeps;
  /** Cached result of the lazy `deps.backends` factory (see HadesCliDeps). */
  private backendsDeps?: BackendsCommandDeps;
  /** Cached result of the lazy `deps.schedule` factory (see HadesCliDeps). */
  private scheduleDeps?: ScheduleCommandDeps;
  /** Cached result of the lazy `deps.state` factory (see HadesCliDeps). */
  private stateDeps?: StateCommandDeps;
  /** Cached result of the lazy `deps.migrate` factory (see HadesCliDeps). */
  private migrateDeps?: MigrateCommandDeps;
  /** Cached result of the lazy `deps.install` factory (see HadesCliDeps). */
  private installDeps?: InstallCommandDeps;
  /** Cached result of the lazy `deps.trust` factory (see HadesCliDeps). */
  private trustDeps?: TrustCommandDeps;
  /** Cached result of the lazy `deps.market` factory (see HadesCliDeps). */
  private marketDeps?: MarketCommandDeps;
  /** Cached result of the lazy `deps.route` factory (see HadesCliDeps). */
  private routeDeps?: RouteCommandDeps;
  /** Cached result of the lazy `deps.eval` factory (see HadesCliDeps). */
  private evalDeps?: EvalCliDeps;
  /** Cached result of the lazy `deps.dataset` factory (see HadesCliDeps). */
  private datasetDeps?: DatasetCliDeps;

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
      case "profile":
        return this.profile(rest);
      case "backends":
        return this.backends(rest);
      case "showdown":
        return this.showdown(rest);
      case "learn":
        return this.learn(rest);
      case "team":
        return this.team(rest);
      case "hierarchy":
        return runHierarchyCommand(rest);
      case "bench":
        return runBenchCommand(rest);
      case "skill":
        return this.skill(rest);
      case "tui":
        return runTuiCommand(rest);
      case "tools":
        return this.tools(rest);
      case "exec":
        return this.exec(rest);
      case "browser":
        return this.browser(rest);
      case "schedule":
        return this.schedule(rest);
      case "state":
        return this.state(rest);
      case "migrate":
        return this.migrate(rest);
      case "install":
        return this.install(rest);
      case "trust":
        return this.trust(rest);
      case "market":
        return this.market(rest);
      case "route":
        return this.route(rest);
      case "cluster":
        return this.cluster(rest);
      case "eval":
        return this.eval(rest);
      case "dataset":
        return this.dataset(rest);
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
        "  gateway <sub>        Multi-platform messaging gateway: start/status/pair/send/bench",
        "                       (telegram, discord, slack, whatsapp, signal, email — DM pairing,",
        "                       cross-channel continuity, STYX trust badges)",
        "  model [use <id>]     Show or switch the active model",
        "  skills [packs]       List skills / available skill packs",
        "  skills hub <sub>     agentskills.io interop: import/export/check skill",
        "                       packages (injection-scanned, path-traversal-safe)",
        "  plugins [list]       List available plugins",
        "  memory <sub>         Search facts + past sessions (FTS), timeline/show/summarize,",
        "                       guard flags, add (search/timeline/show/summarize/flags/add)",
        "  profile <sub>        Dialectic user model: show/why/learn/sync/audit/bench",
        "                       (evidence-backed beliefs, STYX-audited, tamper-evident ledger)",
        "  backends <sub>       Remote-compute fleet: list/probe/provision/status/hibernate/",
        "                       wake/terminate/sweep/logs/verify/reconcile/route (STYX hash-chained",
        "                       ledger + cost-aware UCB1 routing bandit)",
        "  team <roles|plan>    List roles / preview a team for an objective",
        "  hierarchy <sub>      Swarm benchmarks: head-to-head/makespan/chaos/fuzz/stats",
        "  bench vtph           Verified-tasks-per-hour-per-dollar scoreboard",
        "  showdown <sub>       Swarm vs self-trusting baseline (run/verify) — the honest,",
        "                       hash-chain-audited V-TPH$ scoreboard demo. `live`/`live-verify`",
        "                       run the REAL keyed exit lane (budgeted, sha256 manifested);",
        "                       `verify --dir <path>` byte-audits a published live run dir,",
        "                       `ready` reports keyed-live readiness (exit 0 iff ready)",
        "  backends learn       Swarm learning-loop status (live or durable snapshot)",
        "  skill <sub>          Create/list/validate SKILL.md skills (new/list/show/validate)",
        "                       + skill evolution: synth (SKILL.md from a GATE-VERIFIED",
        "                       trajectory), refine (fold verified uses back in), track",
        "                       (hash-chained Brier/Wilson record), track-batch (record",
        "                       gated verdicts in bulk, idempotent), trust (demotion",
        "                       policy; `trust show` = read-only fail-closed report),",
        "                       holdout (paired candidate-vs-incumbent exit gate)",
        "  tools <sub>          List/enable/disable the tool catalog (list/enable/disable/info)",
        "  exec <run|bench>     Run one program that chains tools (JS/Python, STYX-traced)",
        "  browser <sub>        Real Chromium browsing: open <url> / bench / probe (STYX-traced)",
        "  schedule <sub>       Cron scheduler + verified delivery: add/list/remove/run/status/receipts",
        "                       (5-field Vixie cron, IANA timezones + DST, misfire policies,",
        "                       durable job store; output only ever delivered as \"verified\"",
        "                       when the STYX gate + ed25519 certificate say so)",
        "  state <sub>          Shared workspace store (sessions/memory/config/skills):",
        "                       status/list/get/set/delete/export/import/sync/watch/doctor",
        "                       (hash-chained journal, CRDT merge, cross-process safe —",
        "                       the SAME <dataDir>/state root the desktop app reads live)",
        "  migrate <sub>        Move a real Hermes/OpenClaw install into Hades:",
        "                       scan/plan/apply/report/selftest (deterministic plan,",
        "                       transactional apply with hash-chained receipts + rollback,",
        "                       API keys never printed; `apply` is a DRY RUN without --yes)",
        "  install <sub>        Install/verify this build on a real machine:",
        "                       plan/bundle/verify/doctor (launcher + PATH plan, portable",
        "                       bundle with a sha256 manifest, tamper-checking verify)",
        "  trust <sub>          The unified trust gate every emitted output passes:",
        "                       status/verifiers/calibrate/admit/budget/riskeval/doctor",
        "                       (one registry over every shipped verifier, per-domain",
        "                       split-conformal thresholds fitted from REAL labeled runs,",
        "                       ed25519 certificates, and a hash-chained trust budget;",
        "                       an uncalibrated or non-discriminating domain is reported",
        "                       as such and abstains — it is never given a fake threshold)",
        "  market <sub>         The verified-work market a certificate is priced in:",
        "                       status/reputation/ledger/book/explain/simulate/doctor",
        "                       (hash-chained Brier reputation, certificate-gated claim",
        "                       adjudication over the SAME ed25519 identity the trust gate",
        "                       signs with, escrow/slashing/standing, and a second-price",
        "                       order book ranked by reputation-adjusted value per dollar;",
        "                       `simulate` is the only synthetic subcommand and says so)",
        "  route <sub>          The budget-constrained, risk-controlled router:",
        "                       status/arms/explain/record/ledger/bench/doctor",
        "                       (provider x model arm space priced from the REAL price",
        "                       table, a measured $/token cost model, a budgeted Thompson",
        "                       bandit, a split-conformal silent-wrong gate and a",
        "                       hash-chained routing ledger; an arm with no published",
        "                       price reports `unpriced`, never a $0 that reads as free,",
        "                       and `bench` refuses to run rather than simulate)",
        "  cluster <sub>        Run one swarm across many nodes: status/nodes/run/bench/chaos/",
        "                       autoscale",
        "                       (SWIM membership + leader election, fencing-token leases,",
        "                       signed federation links between every pair of nodes, and an",
        "                       exactly-once verified-result ledger — a task counts as done",
        "                       only once a REAL gate accepted it and a REAL ed25519",
        "                       certificate binds the exact bytes produced). `bench` and",
        "                       `chaos` build and actually execute an in-process fabric on",
        "                       this machine and report only measured numbers; `chaos` runs",
        "                       a seeded fault schedule (worker kills, node crashes, link",
        "                       partitions) and the same seed reproduces the same schedule.",
        "                       `autoscale` is a DRY RUN: it plans the per-node worker counts",
        "                       against the SAME registered backends `hades backends` shows,",
        "                       and provisions nothing",
        "  eval <sub>           Continuous eval + the never-regress gate:",
        "                       status/run/gate/bisect/history",
        "                       (measures THIS revision against the real eval suite,",
        "                       records it to a hash-chained history, compares it to a",
        "                       real baseline with an exact McNemar test, and REFUSES a",
        "                       regression -- `gate` and `run --gate` exit 2 on BLOCK and",
        "                       `history --verify` exits 3 on a broken chain, so either",
        "                       is a CI merge gate as-is. `bisect` binary-searches the",
        "                       recorded history for the revision that caused it. An",
        "                       unmeasured lane reports NaN and says why; it is never a",
        "                       fabricated 0 that would read as a passing measurement)",
        "  dataset <sub>        Verified-trajectory data flywheel:",
        "                       export/import/stats/verify/finetune",
        "                       (admits ONLY gate-verified trajectories into a",
        "                       hash-chained corpus -- an unverified or tampered one is",
        "                       provably excluded -- and exports a byte-reproducible",
        "                       sharded dataset with a hash-pinned manifest. `verify`",
        "                       RECOMPUTES everything from the bytes on disk and trusts",
        "                       nothing the manifest claims: exit 2 = the dataset failed",
        "                       audit, exit 3 = the corpus's own chain is broken, so it",
        "                       is a CI gate as-is. `finetune` is OFF by default and",
        "                       spawns nothing without --enable, a REAL local model and a",
        "                       clean audit; no loss/accuracy is ever synthesized)",
        "  learn stats          Show the recorded-trajectory dataset size",
        "  version              Print the version",
        "  help                 Show this help",
      ],
    };
  }

  /** `hades showdown <sub>` — the honest V-TPH$ scoreboard demo. `run`/`verify`
   *  (modeled or real) go to `runShowdownCommand`; the LIVE exit lane
   *  (`live` / `live-verify` — keyed, billed, wall-clock-budgeted, sha256
   *  manifested) goes to `runShowdownLiveCommand` wired to the real
   *  `runLiveShowdown`/`verifyLiveArtifacts` engine and the real process env
   *  (key NAMES only are ever printed, never key material). */
  private async showdown(args: string[]): Promise<CliResult> {
    const [sub, ...rest] = args;
    // `hades showdown ready` — honest keyed-live-run readiness report for
    // THIS environment (thin wrapper over the real preflightLiveShowdown);
    // exit 0 iff ready, so CI can gate on it.
    if (sub === "ready") {
      return runShowdownReadyCommand({ env: process.env, cwd: process.cwd() });
    }
    // `hades showdown verify --dir <path>` (flag form) — the INDEPENDENT
    // byte-level manifest auditor for a published `runs/live-*` directory
    // (../bench/live-manifest-verify.ts). The positional form
    // `hades showdown verify <dir>` keeps its original meaning below:
    // re-verify a run dir's audit.jsonl hash chain (runShowdownCommand).
    if (sub === "verify" && rest.includes("--dir")) {
      return runShowdownVerifyCommand(rest, { env: process.env, cwd: process.cwd() });
    }
    if (sub === "live" || sub === "live-verify") {
      // `hades showdown live help` (or --help/-h) is a help request for the
      // live lane, not a run missing its flags.
      const argv =
        sub === "live" && (rest[0] === "help" || rest[0] === "--help" || rest[0] === "-h")
          ? ["help"]
          : [sub, ...rest];
      const lines: string[] = [];
      const code = await runShowdownLiveCommand(argv, {
        run: runLiveShowdown,
        verify: verifyLiveArtifacts,
        env: process.env,
        write: (line) => lines.push(line),
      });
      return { code, lines };
    }
    return runShowdownCommand(args);
  }

  /** `hades skill <sub>` — authoring (`new/list/show/validate`, skills-command)
   *  plus the Phase-10 skill-evolution surface (`synth/refine/track/trust`,
   *  skill-evolve-command): synthesis from GATE-VERIFIED trajectories,
   *  refine-on-use, the hash-chained Brier/Wilson track record, and the
   *  demotion trust policy. Both subsurfaces share the same skills dir
   *  ($HADES_SKILLS_DIR, default <HADES_DATA_DIR|.hades>/skills), so a
   *  synthesized skill is immediately visible to `skill list`, the TUI, and
   *  the desktop Skills view. */
  private skill(args: string[]): Promise<CliResult> | CliResult {
    const [sub] = args;
    if (
      sub === "synth" ||
      sub === "refine" ||
      sub === "track" ||
      sub === "track-batch" ||
      sub === "trust" ||
      sub === "holdout"
    ) {
      return runSkillEvolveCommand(args);
    }
    return runSkillCommand(args);
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

  /** `hades schedule add|list|remove|run|status` — the Phase 9 scheduler +
   *  verified-delivery surface. Loaded lazily so `hades help` never pays for
   *  the job store or the delivery router's ed25519 stack; deps come from the
   *  injected lazy factory when configured (buildHadesCli wires config.dataDir
   *  + persistence there), else `defaultScheduleDeps()` — both cached so
   *  repeated subcommands in one process share one store instance. */
  private async schedule(args: string[]): Promise<CliResult> {
    const { runScheduleCommand, defaultScheduleDeps } = await import("./schedule-command");
    if (!this.scheduleDeps) {
      this.scheduleDeps = this.deps.schedule ? this.deps.schedule() : defaultScheduleDeps();
    }
    return runScheduleCommand(args, this.scheduleDeps);
  }

  /** `hades state status|list|get|set|delete|export|import|sync|watch|doctor`
   *  — the terminal surface over the shared, hash-chained workspace store at
   *  `<dataDir>/state`, the SAME root the desktop app's `state.*` IPC lane
   *  and any other surface open. Loaded lazily so `hades help` never opens
   *  the store (or takes its cross-process lock); deps come from the injected
   *  lazy factory when configured (`buildHadesCli` wires the real session +
   *  memory engine adapters there), else `defaultStateDeps()`. Cached so
   *  repeated subcommands in one process share one store instance. */
  private async state(args: string[]): Promise<CliResult> {
    const { runStateCommand, defaultStateDeps } = await import("./state-command");
    if (!this.stateDeps) {
      this.stateDeps = this.deps.state ? this.deps.state() : defaultStateDeps();
    }
    return runStateCommand(args, this.stateDeps);
  }

  /** `hades migrate scan|plan|apply|report|selftest` — the one-command move
   *  off a real Hermes/OpenClaw install: discover it, read it into the
   *  canonical IR, plan it deterministically, and (only with `--yes`) apply
   *  it transactionally into THIS install's `<dataDir>`. Loaded lazily so
   *  `hades help` never probes the filesystem for foreign installs; deps come
   *  from the injected lazy factory when configured (`buildHadesCli` wires
   *  this install's real dataDir there), else `defaultMigrateDeps()`. Cached
   *  so `plan` and `apply` in one process share one set of engine handles. */
  private async migrate(args: string[]): Promise<CliResult> {
    const { runMigrateCommand, defaultMigrateDeps } = await import("./migrate-command");
    if (!this.migrateDeps) {
      this.migrateDeps = this.deps.migrate ? this.deps.migrate() : defaultMigrateDeps();
    }
    return runMigrateCommand(args, this.migrateDeps);
  }

  /** `hades install plan|bundle|verify|doctor` — the real installer planner
   *  and portable-bundle builder (`../install/**`). Loaded lazily so
   *  `hades help` never probes the host machine; deps come from the injected
   *  lazy factory when configured, else `defaultInstallDeps()`. Cached so
   *  repeated subcommands in one process share one host probe. */
  private async install(args: string[]): Promise<CliResult> {
    const { runInstallCommand, defaultInstallDeps } = await import("./install-command");
    if (!this.installDeps) {
      this.installDeps = this.deps.install ? this.deps.install() : defaultInstallDeps();
    }
    return runInstallCommand(args, this.installDeps);
  }

  /** `hades trust status|verifiers|calibrate|admit|budget|riskeval|doctor` —
   *  the unified trust gate. The deps factory is lazy AND cached so a single
   *  process shares one registry, one ed25519 signing identity, one
   *  hash-chained budget and one persisted calibration across subcommands;
   *  the dynamic import keeps the ed25519/fs cost off every other command's
   *  startup path. */
  private async trust(args: string[]): Promise<CliResult> {
    const { runTrustCommand, defaultTrustDeps } = await import("./trust-command");
    if (!this.trustDeps) {
      this.trustDeps = this.deps.trust ? this.deps.trust() : defaultTrustDeps();
    }
    return runTrustCommand(args, this.trustDeps);
  }

  /** `hades market status|reputation|ledger|book|explain|simulate|doctor` —
   *  the verified-work market. Lazy AND cached for the same reasons `trust`
   *  is: one process shares one reputation ledger, one economy and one
   *  certificate replay registry across subcommands, and the dynamic import
   *  keeps the ed25519/fs cost off every other command's startup path. */
  private async market(args: string[]): Promise<CliResult> {
    const { runMarketCommand, defaultMarketDeps } = await import("./market-command");
    if (!this.marketDeps) {
      this.marketDeps = this.deps.market ? this.deps.market() : defaultMarketDeps();
    }
    return runMarketCommand(args, this.marketDeps);
  }

  /** `hades route status|arms|explain|record|ledger|bench|doctor` — the
   *  budget-constrained router. Lazy AND cached for the same reasons
   *  `market` is: one process shares one arm catalog, one measured cost
   *  model, one bandit posterior/budget and one hash-chained routing ledger
   *  across subcommands, and the dynamic import keeps the fs/deserialize
   *  cost off every other command's startup path. */
  private async route(args: string[]): Promise<CliResult> {
    const { runRouteCommand, defaultRouteDeps } = await import("./route-command");
    if (!this.routeDeps) {
      this.routeDeps = this.deps.route ? this.deps.route() : defaultRouteDeps();
    }
    return runRouteCommand(args, this.routeDeps);
  }

  /** `hades cluster status|nodes|run|bench|chaos|autoscale` — the multi-node surface.
   *  Every subcommand actually BUILDS a real in-process cluster fabric (one
   *  real inline `SwarmManager` + real verification gate + real ed25519
   *  certificates per node, real SWIM membership, real signed federation
   *  links), runs the work, and tears it down; nothing is a cached or
   *  precomputed figure. Deliberately NOT cached across invocations the way
   *  `trust`/`market`/`route` are: there is no persistent cluster daemon, so
   *  holding a fabric open between subcommands would leak worker pools and
   *  timers for no benefit. The import is dynamic so `hades help` (and every
   *  other subcommand) never pays to load the swarm manager, the federation
   *  stack, or the ed25519 layer. */
  private async cluster(args: string[]): Promise<CliResult> {
    const { runClusterCommand } = await import("./cluster-command");
    return runClusterCommand(args, {
      // `cluster autoscale` plans against the SAME BackendManager
      // `hades backends` drives — one registered fleet, two surfaces — so a
      // plan can only ever name backends this install really has. The
      // factory stays lazy AND cached (shared with `hades backends`), and is
      // only invoked by the autoscale subcommand itself; absent, autoscale
      // refuses rather than planning against an invented backend list.
      ...(this.deps.backends
        ? {
            backends: () => {
              this.backendsDeps ??= (this.deps.backends as () => BackendsCommandDeps)();
              return {
                registry: this.backendsDeps.manager.registry,
                descriptors: this.backendsDeps.manager.descriptors(),
              };
            },
          }
        : {}),
    });
  }

  /** `hades eval status|run|gate|bisect|history` — the continuous-eval and
   *  never-regress surface. Lazy AND cached for the same reasons `route` is:
   *  the eval history ledger is a cross-process-locked, hash-chained on-disk
   *  file, so one process must share ONE `EvalHistoryLedger` across
   *  subcommands rather than open (and lock) it twice; the dynamic import
   *  also keeps the measurement engine, the risk lane and the git revision
   *  resolver off every other command's startup path.
   *
   *  Note this is the ONLY `hades` subcommand that can exit with 2 or 3:
   *  2 means the never-regress gate genuinely BLOCKED a measured regression
   *  and 3 means the history chain failed verification, so `hades eval gate`
   *  and `hades eval history --verify` can each be a CI merge gate directly. */
  private async eval(args: string[]): Promise<CliResult> {
    const { runEvalCommand } = await import("./eval-command");
    if (!this.evalDeps) {
      const { defaultEvalCliDeps } = await import("./eval-deps");
      this.evalDeps = this.deps.eval ? this.deps.eval() : defaultEvalCliDeps();
    }
    return runEvalCommand(args, this.evalDeps);
  }

  /** `hades dataset export|import|stats|verify|finetune` — the
   *  verified-trajectory data flywheel. Lazy AND cached for the same reasons
   *  `eval` is: the corpus is a cross-process-locked, hash-chained on-disk
   *  ledger, so one process must share ONE `VerifiedTrajectoryCorpus` across
   *  subcommands rather than open (and lock) it twice; the dynamic import
   *  also keeps the encoder, the gzip exporter and the ed25519 auditor off
   *  every other command's startup path.
   *
   *  Like `eval`, this subcommand can exit with 2 or 3: 2 means
   *  `verify` found the dataset's own bytes untrustworthy and 3 means the
   *  corpus it claims to be built from has a broken hash chain, so
   *  `hades dataset verify --with-corpus` is a CI gate as-is. */
  private async dataset(args: string[]): Promise<CliResult> {
    const { runDatasetCommand } = await import("./dataset-command");
    if (!this.datasetDeps) {
      const { defaultDatasetCliDeps } = await import("./dataset-deps");
      this.datasetDeps = this.deps.dataset ? this.deps.dataset() : defaultDatasetCliDeps();
    }
    return runDatasetCommand(args, this.datasetDeps);
  }

  private model(args: string[]): CliResult {
    if (!this.deps.models) return { code: 1, lines: ["Model management is not configured."] };
    const res = this.deps.models.run(args);
    return { code: res.ok ? 0 : 1, lines: res.lines };
  }

  private skills(args: string[]): Promise<CliResult> | CliResult {
    const [sub] = args;
    if (sub === "hub") {
      // agentskills.io / open-skill-format interop: import/export/check skill
      // packages against the on-disk skill library (`hades skill`'s dir).
      const libraryDir =
        this.deps.skillsDir ??
        process.env.HADES_SKILLS_DIR ??
        join(process.env.HADES_DATA_DIR ?? ".hades", "skills");
      return runSkillsHubCommand(args.slice(1), { libraryDir });
    }
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

  /** `hades profile <sub>` — the Phase-5 dialectic user model surface
   *  (show/why/learn/sync/audit/bench). Deps are built lazily on first use
   *  and cached, so a `hades help` never touches the profile store. */
  private profile(args: string[]): Promise<CliResult> | CliResult {
    if (!this.deps.profile) return { code: 1, lines: ["The user profile is not configured in this build."] };
    try {
      this.profileDeps ??= this.deps.profile();
    } catch (err) {
      return { code: 1, lines: [err instanceof Error ? err.message : String(err)] };
    }
    return runProfileCommand(this.profileDeps, args);
  }

  /** `hades backends <sub>` — the Phase-6 remote-compute fleet surface
   *  (list/probe/provision/status/hibernate/wake/terminate/sweep/logs/verify).
   *  Deps are built lazily on first use and cached, so a `hades help` never
   *  constructs the BackendManager, the provenance ledger, or a docker probe. */
  private backends(args: string[]): Promise<CliResult> | CliResult {
    if (!this.deps.backends) return { code: 1, lines: ["The backend fleet is not configured in this build."] };
    try {
      this.backendsDeps ??= this.deps.backends();
    } catch (err) {
      return { code: 1, lines: [err instanceof Error ? err.message : String(err)] };
    }
    return runBackendsCommand(args, this.backendsDeps);
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
