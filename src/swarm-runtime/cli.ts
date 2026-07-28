/**
 * hermes-swarm — a lightweight CLI for the swarm runtime.
 *
 * Commands:
 *   hermes-swarm run "<objective>"     Run a goal once and print the result
 *   hermes-swarm serve                 Start the control server + web dashboard
 *   hermes-swarm doctor                Check which isolation backends are available
 *
 * Global flags:
 *   --mode inline|process|docker   Isolation backend (default: inline)
 *   --workers N                    Worker pool size (default: 3)
 *   --caps a,b,c                   Worker capabilities (default: research,code,analysis)
 *   --port N                       Dashboard port for `serve` (default: 8080)
 *   --control-port N               Worker control-plane port (default: 8787)
 *   --image NAME                   Worker docker image (docker mode)
 *   --host H                       Bind host (default: 127.0.0.1)
 *   --json                         Machine-readable output for `run`
 *   -h, --help                     Print usage and exit 0 (anywhere in argv)
 *
 * Engine flags (run; see run-engine.ts for the full decision table):
 *   --provider NAME                LLM provider (env fallback: SWARM_PROVIDER)
 *   --model ID                     Model id (env fallback: SWARM_MODEL)
 *   --base-url URL                 Endpoint override (custom Ollama/vLLM host)
 *   --offline                      Force the deterministic offline executor
 *
 * API keys are NEVER flags: each provider reads its documented env var
 * (OPENAI_API_KEY, ANTHROPIC_API_KEY, …) so keys never land in shell history
 * or `ps` output.
 *
 * ## Why this entry point reaches up into `src/hades`
 *
 * A CLI is a composition root: its job is to decide which real parts get wired
 * together. `run` and `serve` therefore hand the manager's verification gate
 * the STYX correctness bridge (`src/hades/trust/swarm-bridge.ts`), so the
 * answer to a goal whose objective carries a machine-checkable `SPEC:`
 * reference is checked for being RIGHT and not merely well-evidenced. Without
 * it this CLI would happily print `=== goal COMPLETED ===` over a silently
 * wrong answer, which is exactly what it did before.
 *
 * The library layer stays clean: `server/build-swarm.ts` declares a `gate`
 * option and imports nothing from `src/hades`, exactly like its
 * `decorateProvider` seam — so only entry points know both sides. Nor is this
 * a new dependency direction: `distributed/` already imports `src/hades/**` in
 * seven non-test modules and `index.ts` re-exports them.
 */
import { buildSwarm, type SwarmMode } from "./server/build-swarm";
import { SwarmServer } from "./server/swarm-server";
import { DockerProvider } from "./providers/docker";
import { LocalProcessProvider } from "./providers/local-process";
import { renderTui } from "./tui/render";
import { installGracefulShutdown } from "./lifecycle/shutdown";
import { describeRunEngine, formatEngineLine, resolveRunEngine, type RunEngineDecision } from "./run-engine";
import { CostMeter, formatCostLine } from "../hades/cost/meter";
import { appendRunCost, costJournalPath } from "../hades/cost/journal";
import { createChat } from "./worker/providers";
import { LLMExecutor } from "./worker/llm-executor";
import type { TaskExecutor } from "./worker/executor";
import type { GateConfig } from "./verification/gate";
import { createSwarmTrustBridge } from "../hades/trust/swarm-bridge";

interface Flags {
  mode: SwarmMode;
  workers: number;
  caps: string[];
  port: number;
  controlPort: number;
  image?: string;
  host: string;
  managerUrl?: string;
  dockerNetwork?: string;
  authToken?: string;
  json: boolean;
  help: boolean;
  /** --provider (run): LLM provider name; env fallback SWARM_PROVIDER. */
  provider?: string;
  /** --model (run): model id; env fallback SWARM_MODEL. */
  model?: string;
  /** --base-url (run): provider endpoint override. */
  baseUrl?: string;
  /** --offline (run): force the deterministic executor even when keys exist. */
  offline: boolean;
  _: string[];
}

function parseArgs(argv: string[]): Flags {
  const f: Flags = {
    mode: "inline",
    workers: 3,
    caps: ["research", "code", "analysis"],
    port: 8080,
    controlPort: 8787,
    host: "127.0.0.1",
    json: false,
    help: false,
    offline: false,
    _: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--mode": f.mode = next() as SwarmMode; break;
      case "--workers": f.workers = parseInt(next(), 10); break;
      case "--caps": f.caps = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--port": f.port = parseInt(next(), 10); break;
      case "--control-port": f.controlPort = parseInt(next(), 10); break;
      case "--image": f.image = next(); break;
      case "--manager-url": f.managerUrl = next(); break;
      case "--docker-network": f.dockerNetwork = next(); break;
      case "--host": f.host = next(); break;
      case "--auth-token": f.authToken = next(); break;
      case "--provider": f.provider = next(); break;
      case "--model": f.model = next(); break;
      case "--base-url": f.baseUrl = next(); break;
      case "--offline": f.offline = true; break;
      case "--json": f.json = true; break;
      // A flag, not a positional: pushing "help" onto `_` here once made
      // `run --help` execute a swarm goal literally named "help".
      case "-h": case "--help": f.help = true; break;
      default: f._.push(a);
    }
  }
  return f;
}

const HELP = `hermes-swarm — lightweight dockerized agent swarm

USAGE
  hermes-swarm run "<objective>"   [flags]
  hermes-swarm serve               [flags]
  hermes-swarm tui                 [--manager-url URL | --host --port]
  hermes-swarm doctor

FLAGS
  --mode inline|process|docker   isolation backend (default inline)
  --workers N                    pool size (default 3)
  --caps a,b,c                   capabilities (default research,code,analysis)
  --port N                       dashboard port (serve; default 8080)
  --control-port N               worker control-plane port (default 8787)
  --image NAME                   worker docker image (docker mode)
  --host H                       bind host (default 127.0.0.1)
  --json                         machine-readable run output
  -h, --help                     print usage and exit

ENGINE FLAGS (run)
  --provider NAME                openai|anthropic|nous|openrouter|together|groq|local
                                 (env fallback: SWARM_PROVIDER)
  --model ID                     model id (env fallback: SWARM_MODEL)
  --base-url URL                 endpoint override, e.g. a custom Ollama/vLLM host
  --offline                      force the deterministic offline executor

ENGINE
  run prints one honest "engine:" line before starting. With no flags it
  auto-selects from ANTHROPIC_API_KEY, then OPENAI_API_KEY; with neither it
  runs the deterministic offline executor and says so. A named provider whose
  key env var is unset is a hard error (never a silent mock). API keys are
  read ONLY from each provider's env var (e.g. OPENAI_API_KEY) — never from
  flags — so keys stay out of shell history and ps output. --provider local
  (Ollama/vLLM) needs no key. Model-backed runs are inline-mode only;
  process/docker workers pick their executor from the worker environment.

VERIFICATION
  Every worker result is scored by the manager's verification gate (grounding:
  claims, evidence, traceability). run and serve additionally wire the STYX
  T1-reference oracle: when the objective embeds a machine-checkable
  SPEC:{json} line, the goal's final answer is RECOMPUTED and compared, and a
  mismatch fails the goal instead of printing it as COMPLETED. That is the only
  check here that can refute an answer for being WRONG rather than unevidenced;
  with no SPEC: line it abstains and changes nothing.`;

async function cmdDoctor(f: Flags): Promise<void> {
  const docker = await new DockerProvider({ image: "x" }).isAvailable();
  const proc = await new LocalProcessProvider({ workerEntry: "x" }).isAvailable();
  console.log("hermes-swarm doctor");
  console.log(`  inline   : ✓ always available`);
  console.log(`  process  : ${proc ? "✓" : "✗"} child-process isolation`);
  console.log(`  docker   : ${docker ? "✓ daemon reachable" : "✗ docker not found / daemon down"}`);
  // Same pure decision table `run` uses — reported without building anything,
  // and without aborting doctor when the engine config is broken.
  try {
    const decision = resolveRunEngine(
      { provider: f.provider, model: f.model, baseUrl: f.baseUrl, offline: f.offline },
      process.env,
    );
    console.log(`  engine   : ${describeRunEngine(decision)}`);
  } catch (e) {
    console.log(`  engine   : ✗ misconfigured — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Cap on one chat HTTP round-trip for CLI-built engines, so a dead or
 * misconfigured endpoint fails fast with a clear transport error instead of
 * hanging a worker (generous enough for a real long completion).
 */
const CHAT_TIMEOUT_MS = 120_000;

/**
 * The gate configuration every CLI-built swarm gets: the default grounding
 * checks PLUS the STYX correctness bridge.
 *
 * Built fresh per command rather than shared at module scope so `--help` and
 * `doctor` construct nothing. The bridge itself needs no key, no data
 * directory and no network call, and abstains — leaving the score untouched —
 * on every result that is not the goal's answer to a `SPEC:`-bearing
 * objective, so wiring it in is additive: it can decline a provably wrong
 * answer and can never accept one the grounding checks would have refused.
 */
function cliGateConfig(): GateConfig {
  return { externalVerifier: createSwarmTrustBridge() };
}

async function cmdRun(f: Flags): Promise<void> {
  const objective = f._.slice(1).join(" ").trim();
  if (!objective) {
    console.error('error: provide an objective, e.g. hermes-swarm run "summarize the repo"');
    console.log(HELP);
    process.exit(1);
  }

  // Decide the engine BEFORE building anything. A misconfigured real engine
  // (named provider, missing key env var) is a hard error naming the exact
  // variable — never a silent fallback to the offline executor.
  let decision: RunEngineDecision;
  try {
    decision = resolveRunEngine(
      { provider: f.provider, model: f.model, baseUrl: f.baseUrl, offline: f.offline },
      process.env,
    );
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (decision.kind === "real" && f.mode !== "inline") {
    console.error(
      `error: --provider/--model configure the inline engine only; --mode ${f.mode} workers select ` +
        "their executor from the worker environment (SWARM_MODEL + SWARM_API_KEY/OPENAI_API_KEY). " +
        "Rerun with --mode inline, or pass --offline.",
    );
    process.exit(1);
  }

  // The ONE honest engine line, printed before the run starts. It names env
  // VARIABLE NAMES only, never values, and goes to stderr with the rest of
  // the progress output so --json stdout stays machine-readable.
  console.error(formatEngineLine(decision));

  let executor: TaskExecutor | undefined;
  // Measured cost for a REAL run. The meter only ever receives observations
  // from a live provider round trip (`worker/providers.ts` → `onUsage`), so
  // an offline run records nothing rather than a $0 that would be
  // indistinguishable from a real run that happened to be free.
  const meter = new CostMeter();
  const runStartedAt = Date.now();
  if (decision.kind === "real") {
    // Mirror engine-select.ts's real path exactly: a ChatFn wrapped in
    // `new LLMExecutor(chat)` and handed to the inline swarm factory. Like
    // that path, there is NO LLM-backed planning here — engine-select wires
    // no planner — which is also why `model` is deliberately not forwarded to
    // buildSwarm (its plannerFromEnv would otherwise add an LLMPlanner).
    const chat = createChat({
      provider: decision.provider,
      model: decision.model,
      baseUrl: decision.baseUrl,
      timeoutMs: CHAT_TIMEOUT_MS,
      onUsage: (obs) => void meter.record(obs),
    });
    executor = new LLMExecutor(chat);
  }

  const swarm = await buildSwarm({
    mode: f.mode,
    capabilities: f.caps,
    poolSize: f.workers,
    controlPort: f.controlPort,
    controlHost: f.host,
    workerImage: f.image,
    managerUrl: f.managerUrl,
    dockerNetwork: f.dockerNetwork,
    executor,
    gate: cliGateConfig(),
  });
  const m = swarm.manager;
  if (!f.json) {
    m.on("worker:spawned", (r) => console.error(`  · worker ${r.workerId} spawned (${swarm.mode})`));
    m.on("worker:killed", (r, reason) => console.error(`  ⚠ worker ${r.workerId} KILLED: ${reason}`));
    m.on("task:verified", (t) => console.error(`  ✓ verified: ${t.description.slice(0, 60)}`));
    // Surface the failing checks' details (e.g. the worker's actual transport
    // error against a dead endpoint), not just that a rejection happened.
    m.on("task:rejected", (t, report) => {
      const detail = (report?.checks ?? [])
        .filter((c) => !c.passed && c.detail)
        .map((c) => c.detail)
        .join("; ");
      console.error(`  ✗ rejected: ${t.description.slice(0, 60)}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
    });
    m.on("task:failed", (t, reason) => console.error(`  ✗ failed: ${t.id.slice(0, 8)} — ${reason}`));
  }
  await swarm.start();
  const goal = await m.runGoal(objective);
  await swarm.stop();

  if (f.json) {
    console.log(JSON.stringify({ status: goal.status, synthesis: goal.synthesis, goalId: goal.id }, null, 2));
  } else {
    console.log(`\n=== goal ${goal.status.toUpperCase()} ===`);
    const synthesis =
      typeof goal.synthesis === "string" ? goal.synthesis : JSON.stringify(goal.synthesis, null, 2);
    // JSON.stringify(undefined) is undefined — a failed goal has no synthesis.
    console.log(synthesis ?? "(no synthesis — goal did not complete)");
  }

  // The measured cost of the run, on stderr with the rest of the progress
  // output so `--json` stdout stays machine-readable. Only for a real engine:
  // an offline run consulted no provider and has nothing to bill. The figure
  // is MEASURED (provider-reported tokens x a cited list price, real clock)
  // or explicitly UNKNOWN — never a modeled stand-in.
  if (decision.kind === "real") {
    const wallClockMs = Date.now() - runStartedAt;
    console.error(formatCostLine(meter.report(), { wallClockMs }));
    const journal = costJournalPath(process.env.HADES_DATA_DIR ?? ".hades");
    const problem = appendRunCost(journal, {
      v: 1,
      runId: `swarm-${runStartedAt.toString(36)}-${goal.id.slice(0, 6)}`,
      surface: "swarm-run",
      startedAt: runStartedAt,
      wallClockMs,
      model: decision.model,
      provider: decision.provider,
      calls: meter.calls(),
      report: meter.report(),
    });
    // Reported, not swallowed: nobody is told their spend was recorded when
    // it was not. It is not fatal — the work itself succeeded.
    if (problem) console.error(`cost: NOT recorded to ${journal} — ${problem}`);
  }

  process.exit(goal.status === "completed" ? 0 : 1);
}

async function cmdServe(f: Flags): Promise<void> {
  const swarm = await buildSwarm({
    mode: f.mode,
    capabilities: f.caps,
    poolSize: f.workers,
    controlPort: f.controlPort,
    controlHost: f.host,
    workerImage: f.image,
    managerUrl: f.managerUrl,
    dockerNetwork: f.dockerNetwork,
    // Same gate as `run`: a goal dispatched from the dashboard is the same
    // product surface and must not be held to a weaker bar than the terminal.
    gate: cliGateConfig(),
  });
  const server = new SwarmServer(swarm, { port: f.port, host: f.host, authToken: f.authToken });
  await server.listen();
  console.log(`hermes-swarm dashboard → http://${f.host}:${f.port}  (mode=${f.mode}, workers=${f.workers})`);
  console.log("press Ctrl+C to stop");
  installGracefulShutdown(() => server.close(), { log: (m) => console.log(m), timeoutMs: 15_000 });
}

async function cmdTui(f: Flags): Promise<void> {
  const url = f.managerUrl ?? `http://${f.host}:${f.port}`;
  console.log(`hermes-swarm tui → polling ${url}/api/state (Ctrl+C to exit)`);
  const tick = async () => {
    try {
      const res = await fetch(`${url}/api/state`);
      const state = await res.json();
      process.stdout.write("\x1b[2J\x1b[H" + renderTui(state) + "\n");
    } catch (e) {
      process.stdout.write("\x1b[2J\x1b[H" + `cannot reach ${url}: ${e instanceof Error ? e.message : e}\n`);
    }
  };
  await tick();
  const timer = setInterval(tick, 1000);
  const stop = () => { clearInterval(timer); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function main(): Promise<void> {
  const f = parseArgs(process.argv.slice(2));
  const cmd = f._[0];
  // -h/--help anywhere in argv prints usage and exits 0 before any command
  // (worker pools included) is ever built.
  if (f.help || !cmd || cmd === "help") { console.log(HELP); return; }
  switch (cmd) {
    case "run": return cmdRun(f);
    case "serve": return cmdServe(f);
    case "tui": return cmdTui(f);
    case "doctor": return cmdDoctor(f);
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
