/**
 * `hades gateway` — the real multi-platform messaging gateway CLI. No
 * subcommand ever prints a credential value: every line comes from
 * {@link PlatformProbe.detail} (variable names only) or plain status/traffic
 * data.
 *
 * @module hades/cli/gateway-command
 */
import type { CliResult } from "./cli";
import type { GatewayCliDeps } from "./gateway-deps";
import type { PlatformProbe } from "../gateway/process";
import { runGatewayBench, formatGatewayBenchReport } from "../gateway/gateway-bench";

export interface GatewayCommandIo {
  write: (line: string) => void;
  /** Resolves when `start` should stop waiting and shut the gateway down. Default: never resolves on its own — wired to OS signals instead. */
  wait?: () => Promise<void>;
}

const DEFAULT_IO: GatewayCommandIo = { write: () => {} };

function probeTable(platforms: PlatformProbe[]): string[] {
  const rows = platforms.map((p) => `  ${p.platform.padEnd(9)} ${p.mode.padEnd(8)} ${p.detail}`);
  return ["platform  mode     detail", ...rows];
}

function usageLines(): string[] {
  return [
    "Usage: hades gateway <start|status|pair|send|bench|help> [args]",
    "",
    "  start [--probe] [--schedule]             Start the gateway (long-running); --probe reports connector status and exits without starting; --schedule also runs the cron scheduler with verified delivery through the gateway's own connectors",
    "  status                                    Show running state, per-platform connector status, and traffic counters",
    "  pair [--owner]                            Issue a one-time pairing code (trusted by default; owner with --owner)",
    "  send <platform> <user|channel> <text...>  Proactively deliver a message through a connected platform",
    "  bench                                     Run the real six-platform continuity bench (fake transports, mock engine) and print its report",
    "  help                                      Show this help",
  ];
}

function help(): CliResult {
  return { code: 0, lines: ["hades gateway — real multi-platform messaging gateway", "", ...usageLines()] };
}

/** One honest engine line: mode + requested + detail (variable NAMES only — never a credential). Empty when no probe was wired. */
function engineLines(deps: GatewayCliDeps): string[] {
  const p = deps.engineProbe;
  if (!p) return [];
  return [`engine: ${p.mode} (requested ${p.requested}) — ${p.detail}`];
}

function statusLines(deps: GatewayCliDeps): string[] {
  const s = deps.process.status();
  const runningLine = s.running
    ? `gateway: running (since ${new Date(s.startedAt ?? Date.now()).toISOString()})`
    : "gateway: stopped";
  return [
    runningLine,
    ...probeTable(s.platforms),
    ...engineLines(deps),
    `counters: inbound=${s.counters.inbound} outbound=${s.counters.outbound} rateLimited=${s.counters.rateLimited}`,
  ];
}

async function runStart(args: string[], deps: GatewayCliDeps, io: GatewayCommandIo): Promise<CliResult> {
  if (args.includes("--probe")) {
    const lines = [
      "gateway: --probe (not started)",
      ...probeTable(deps.process.status().platforms),
      ...engineLines(deps),
    ];
    for (const line of lines) io.write(line);
    return { code: 0, lines };
  }

  if (args.includes("--schedule")) {
    return runStartWithSchedule(deps, io);
  }

  const started = await deps.process.start();
  const startLines = [
    ...probeTable(started.platforms),
    ...engineLines(deps),
    "gateway: started — waiting for messages (Ctrl+C to stop).",
  ];
  for (const line of startLines) io.write(line);

  // Default: block forever, but still install real OS signal handlers so a
  // real `Ctrl+C` gracefully stops connectors even though this promise
  // (deliberately) never resolves on its own.
  const wait =
    io.wait ??
    (() =>
      new Promise<void>(() => {
        deps.process.installSignalHandlers(process);
      }));
  await wait();

  await deps.process.stop();
  // The engine's swarm manager (if `start` resolved a real one) is torn down
  // only after the connectors have stopped — no in-flight turn is orphaned.
  await deps.engineShutdown?.();
  const stopLines = ["gateway: stopped."];
  for (const line of stopLines) io.write(line);

  return { code: 0, lines: [...startLines, ...stopLines] };
}

/**
 * `hades gateway start --schedule` — the gateway <-> scheduler co-runtime:
 * one `ScheduledGatewayRuntime` running the REAL `SchedulerRunner` poll loop
 * over the durable `<dataDir>/schedule.json` job store, delivering through
 * the gateway's OWN live connectors (STYX-gated: a scheduled result without
 * real verification evidence lands as an honest abstention, never a
 * "verified" badge), with every delivery receipt appended to the
 * hash-chained ledger `hades schedule receipts` re-verifies.
 *
 * The shutdown ordering is the co-runtime's own contract: scheduler poll
 * loop first, in-flight fires drained, gateway connectors stopped, and only
 * then the engine's swarm manager torn down. The final outcome tally printed
 * is the runtime's real per-`RunOutcome` count — a byte-exact mirror of what
 * landed in the job store's run history, never a synthesized number.
 */
async function runStartWithSchedule(deps: GatewayCliDeps, io: GatewayCommandIo): Promise<CliResult> {
  if (!deps.schedule) {
    return {
      code: 1,
      lines: [
        "gateway: --schedule requires deps built by buildGatewayDepsFromEnv({ forStart: true }) — no schedule runtime factory is wired into these deps.",
      ],
    };
  }

  const build = deps.schedule({
    onEvent: (e) => {
      if (e.kind === "scheduler") io.write(`scheduler: ${e.scheduler?.kind ?? "event"} — ${e.detail}`);
    },
  });

  const status = await build.runtime.start();
  const startLines = [
    ...probeTable(status.gateway.platforms),
    ...engineLines(deps),
    `schedule: ${status.jobs} job(s) in ${build.storePath}`,
    `schedule: delivery receipts ledger at ${build.receiptsPath}`,
    "gateway+scheduler: started — waiting for messages and due jobs (Ctrl+C to stop).",
  ];
  for (const line of startLines) io.write(line);

  const wait =
    io.wait ??
    (() =>
      new Promise<void>(() => {
        build.runtime.installSignalHandlers(process);
      }));
  await wait();

  await build.runtime.stop();
  await deps.engineShutdown?.();

  const finalStatus = build.runtime.status();
  const o = finalStatus.outcomes;
  const stopLines = [
    "gateway+scheduler: stopped.",
    `schedule outcomes this run: delivered=${o.delivered} abstained=${o.abstained} withheld=${o.withheld} failed=${o.failed} skipped=${o.skipped}`,
  ];
  for (const line of stopLines) io.write(line);

  return { code: 0, lines: [...startLines, ...stopLines] };
}

function runStatus(deps: GatewayCliDeps): CliResult {
  return { code: 0, lines: statusLines(deps) };
}

function runPair(args: string[], deps: GatewayCliDeps): CliResult {
  const owner = args.includes("--owner");
  const issued = deps.pairing.issuePairingCode(owner ? "owner" : "trusted");
  const ttlMin = Math.max(1, Math.round((issued.expiresAt - Date.now()) / 60_000));
  return {
    code: 0,
    lines: [
      `Pairing code: ${issued.code}`,
      `Level: ${owner ? "owner" : "trusted"}`,
      `Expires in ~${ttlMin} min. Redeem from the new handle with "/pair ${issued.code}".`,
    ],
  };
}

async function runSend(args: string[], deps: GatewayCliDeps): Promise<CliResult> {
  const [platform, target, ...textParts] = args;
  if (!platform || !target || textParts.length === 0) {
    return { code: 1, lines: ["Usage: hades gateway send <platform> <user|channel> <text...>"] };
  }
  const text = textParts.join(" ");
  const ok = await deps.process.deliver(platform, { user: target, channel: target }, text);
  if (!ok) {
    return { code: 1, lines: [`Failed to send: platform "${platform}" is offline or not connected.`] };
  }
  return { code: 0, lines: [`Sent to ${platform}:${target}.`] };
}

/**
 * `bench` delegates to team gateway-agent-bench's `runGatewayBench` — the
 * real six-platform continuity bench (all six real connector classes, fake
 * transports, the real `PairingGuard`/`ContinuityRouter`/`BadgeStamper`
 * pipeline over the honest mock `echoEngine`) — and prints its measured
 * report via `formatGatewayBenchReport`. It never touches `deps` at all: the
 * bench builds its own isolated stack so it can't be skewed by whatever
 * connectors/state this CLI invocation happens to be carrying.
 *
 * The bench is a real, independently-owned module the CLI has no control
 * over — a throw there (rather than a resolved report) must never crash the
 * CLI or print a raw stack trace, so it is reported honestly as a failed
 * `bench` invocation instead.
 */
async function runBench(): Promise<CliResult> {
  try {
    const report = await runGatewayBench();
    return { code: 0, lines: formatGatewayBenchReport(report) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { code: 1, lines: [`gateway bench failed: ${reason}`] };
  }
}

/**
 * Dispatch a `hades gateway` invocation. Terminal-free — everything routes
 * through `deps` (and `io` for `start`'s live streaming), so it unit-tests
 * without a shell or a real process.
 */
export async function runGatewayCommand(args: string[], deps: GatewayCliDeps, io: GatewayCommandIo = DEFAULT_IO): Promise<CliResult> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
      return help();
    case "start":
      return runStart(rest, deps, io);
    case "status":
      return runStatus(deps);
    case "pair":
      return runPair(rest, deps);
    case "send":
      return runSend(rest, deps);
    case "bench":
      return runBench();
    default:
      return { code: 1, lines: [`Unknown gateway subcommand: "${sub}"`, "", ...usageLines()] };
  }
}
