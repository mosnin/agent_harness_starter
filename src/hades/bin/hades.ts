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
    onGateway: () => ({ code: 0, lines: ["Gateway is available via the ConnectorHub API (see docs)."] }),
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
