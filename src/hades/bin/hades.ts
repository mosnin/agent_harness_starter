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
    onChat: () => ({ code: 0, lines: ["Interactive chat is available via the Hades REPL API (see docs)."] }),
    // The real multi-platform messaging gateway (`hades gateway start|status|
    // pair|send|bench`). Loaded lazily so `hades help` never pays for the
    // gateway stack; composed by buildGatewayDeps from this process's real
    // config + env (probe lines only ever name env VARIABLE NAMES, never
    // values). The default agent engine is the honest, self-announcing
    // `[mock]` echo engine — a real swarm engine is opt-in via
    // buildGatewayDeps overrides, never silently substituted.
    onGateway: async (args) => {
      const [{ runGatewayCommand }, { buildGatewayDeps }] = await Promise.all([
        import("../cli/gateway-command"),
        import("../cli/gateway-deps"),
      ]);
      const deps = buildGatewayDeps(config, process.env);
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
