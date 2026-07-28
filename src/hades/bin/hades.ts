#!/usr/bin/env node
/**
 * `hades` — the unified CLI entrypoint. Resolves config from the environment,
 * wires the full CLI, runs the requested subcommand, prints its output, and
 * exits with its code. The command logic lives in {@link HadesCli}; this file is
 * only the thin process shell (argv → config → run → print → exit).
 */
import { loadConfig } from "../config/config";
import { buildHadesCli } from "../cli/build";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const config = loadConfig({ env: process.env });
  const cli = buildHadesCli(config, {
    // `onChat` is deliberately NOT overridden here: buildHadesCli wires the
    // real REPL (`../cli/chat-command.ts`) to the same memory/session stores
    // it builds for every other command, so chat and `hades memory` share one
    // store. Passing a handler here would replace that real composition.
    // The real multi-platform messaging gateway (`hades gateway start|status|
    // pair|send|bench`). Loaded lazily so `hades help` never pays for the
    // gateway stack; composed by buildGatewayDepsFromEnv from this process's
    // real config + env (probe lines only ever name env VARIABLE NAMES, never
    // values). The agent engine is env-resolved honestly: the real,
    // STYX-certified swarm engine ONLY behind HADES_GATEWAY_ENGINE=swarm plus
    // a real provider key — and only for `start`, which actually runs it;
    // every other subcommand gets a pure probe of what `start` would build.
    // Every other combination is the honest, self-announcing `[mock]` echo
    // engine, and the probe line says so.
    onGateway: async (args) => {
      const [{ runGatewayCommand }, { buildGatewayDepsFromEnv }] = await Promise.all([
        import("../cli/gateway-command"),
        import("../cli/gateway-deps"),
      ]);
      const forStart = args[0] === "start" && !args.includes("--probe");
      const deps = await buildGatewayDepsFromEnv(config, process.env, { forStart });
      // `start` is long-running and streams its lines live through io.write
      // (and blocks until a signal); everything it streams is also in
      // result.lines, so once anything was streamed we return no lines —
      // otherwise main() would print the same output a second time.
      let streamed = 0;
      const result = await runGatewayCommand(args, deps, {
        write: (line) => {
          streamed += 1;
          console.log(line);
        },
      });
      return streamed > 0 ? { code: result.code, lines: [] } : result;
    },
  });
  // The wordmark is a front-door affordance, not decoration: it prints only
  // for a bare `hades` / `hades help` on a real TTY. Piped output, CI, --json
  // consumers and every other subcommand get clean, unadorned text — see
  // shouldShowBanner/shouldUseColor for the policy.
  const bare = argv.length === 0 || argv[0] === "help";
  if (bare) {
    const { renderBanner, shouldShowBanner, shouldUseColor } = await import("../cli/banner");
    const isTTY = Boolean(process.stdout.isTTY);
    if (shouldShowBanner(process.env, isTTY)) {
      console.log(
        renderBanner({
          color: shouldUseColor(process.env, isTTY),
          width: process.stdout.columns ?? 80,
          tagline: "the agent you can prove",
        })
      );
      console.log("");
    }
  }

  const result = await cli.run(argv);
  for (const line of result.lines) console.log(line);
  return result.code;
}

// Only auto-run when invoked directly (not when imported by a test).
const invokedDirectly = process.argv[1]?.endsWith("hades.ts") || process.argv[1]?.endsWith("hades.js");
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  );
}
