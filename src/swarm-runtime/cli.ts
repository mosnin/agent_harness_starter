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
 */
import { buildSwarm, type SwarmMode } from "./server/build-swarm";
import { SwarmServer } from "./server/swarm-server";
import { DockerProvider } from "./providers/docker";
import { LocalProcessProvider } from "./providers/local-process";

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
  json: boolean;
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
      case "--json": f.json = true; break;
      case "-h": case "--help": f._.push("help"); break;
      default: f._.push(a);
    }
  }
  return f;
}

const HELP = `hermes-swarm — lightweight dockerized agent swarm

USAGE
  hermes-swarm run "<objective>"   [flags]
  hermes-swarm serve               [flags]
  hermes-swarm doctor

FLAGS
  --mode inline|process|docker   isolation backend (default inline)
  --workers N                    pool size (default 3)
  --caps a,b,c                   capabilities (default research,code,analysis)
  --port N                       dashboard port (serve; default 8080)
  --control-port N               worker control-plane port (default 8787)
  --image NAME                   worker docker image (docker mode)
  --host H                       bind host (default 127.0.0.1)
  --json                         machine-readable run output`;

async function cmdDoctor(): Promise<void> {
  const docker = await new DockerProvider({ image: "x" }).isAvailable();
  const proc = await new LocalProcessProvider({ workerEntry: "x" }).isAvailable();
  console.log("hermes-swarm doctor");
  console.log(`  inline   : ✓ always available`);
  console.log(`  process  : ${proc ? "✓" : "✗"} child-process isolation`);
  console.log(`  docker   : ${docker ? "✓ daemon reachable" : "✗ docker not found / daemon down"}`);
}

async function cmdRun(f: Flags): Promise<void> {
  const objective = f._.slice(1).join(" ").trim();
  if (!objective) {
    console.error('error: provide an objective, e.g. hermes-swarm run "summarize the repo"');
    process.exit(1);
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
  });
  const m = swarm.manager;
  if (!f.json) {
    m.on("worker:spawned", (r) => console.error(`  · worker ${r.workerId} spawned (${swarm.mode})`));
    m.on("worker:killed", (r, reason) => console.error(`  ⚠ worker ${r.workerId} KILLED: ${reason}`));
    m.on("task:verified", (t) => console.error(`  ✓ verified: ${t.description.slice(0, 60)}`));
    m.on("task:rejected", (t) => console.error(`  ✗ rejected: ${t.description.slice(0, 60)}`));
    m.on("task:failed", (t, reason) => console.error(`  ✗ failed: ${t.id.slice(0, 8)} — ${reason}`));
  }
  await swarm.start();
  const goal = await m.runGoal(objective);
  await swarm.stop();

  if (f.json) {
    console.log(JSON.stringify({ status: goal.status, synthesis: goal.synthesis, goalId: goal.id }, null, 2));
  } else {
    console.log(`\n=== goal ${goal.status.toUpperCase()} ===`);
    console.log(typeof goal.synthesis === "string" ? goal.synthesis : JSON.stringify(goal.synthesis, null, 2));
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
  });
  const server = new SwarmServer(swarm, { port: f.port, host: f.host });
  await server.listen();
  console.log(`hermes-swarm dashboard → http://${f.host}:${f.port}  (mode=${f.mode}, workers=${f.workers})`);
  console.log("press Ctrl+C to stop");
  const shutdown = async () => {
    console.log("\nshutting down…");
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const f = parseArgs(process.argv.slice(2));
  const cmd = f._[0];
  if (!cmd || cmd === "help") { console.log(HELP); return; }
  switch (cmd) {
    case "run": return cmdRun(f);
    case "serve": return cmdServe(f);
    case "doctor": return cmdDoctor();
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
