/**
 * `hades chat` — the interactive REPL, wired to a real conversation brain.
 *
 * This is the command that turns the tested-but-unreachable REPL stack
 * (`../repl/`) into a product surface. It composes exactly the pieces the
 * rest of the CLI already builds — the guarded memory store, the session
 * store, the model command — with the brain resolved by
 * `../chat/brain.ts`, and drives them in one of three modes:
 *
 * - **one-shot** (`hades chat --once "message"`): a single turn, reply on
 *   stdout, exit 0. This is the scriptable/CI surface — no TTY required.
 * - **piped** (`echo "message" | hades chat`): stdin is not a TTY, so each
 *   line is fed as a turn and the process exits at EOF. Same composition.
 * - **interactive** (`hades chat` on a TTY): the full {@link Repl} with
 *   multiline input, history and slash commands.
 *
 * All three run through the SAME {@link ConversationalAgent} handler, so
 * memory retrieval, user-model injection, context files and session
 * persistence behave identically — a one-shot turn is a real turn, not a
 * shortcut around the loop.
 *
 * Honesty rules inherited from the rest of the CLI: exactly one `chat
 * engine:` line is printed before the first turn, and it names environment
 * variable NAMES and model/provider words only — never a key value. With no
 * provider key the brain is the self-announcing `[mock]` echo; there is no
 * path that fabricates a model answer.
 *
 * @module hades/cli/chat-command
 */

import { createInterface } from "node:readline";
import { ConversationalAgent } from "../repl/agent";
import type { ReplIO } from "../repl/core";
import { resolveChatBrain, formatChatEngineLine, type ResolvedChatBrain } from "../chat/brain";
import type { MemoryStore } from "../memory/store";
import type { SessionStore } from "../memory/session-store";
import type { ModelCommand } from "../models/command";
import type { CliResult } from "./cli";

export interface ChatCommandDeps {
  memory: MemoryStore;
  sessions: SessionStore;
  models?: ModelCommand;
  /** Data dir for MEMORY.md / USER.md context files (see repl/agent.ts). */
  dataDir: string;
  /** Environment used for brain resolution. Injected so tests stay pure. */
  env: Record<string, string | undefined>;
  /** Override brain resolution (tests inject a fake transport). */
  resolve?: typeof resolveChatBrain;
  /** Where interactive/piped output goes. Defaults to stdout. */
  io?: ReplIO;
  /** Input stream for piped/interactive mode. Defaults to process.stdin. */
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
}

const USAGE = [
  "Usage: hades chat [--once <message>]",
  "",
  "  (no args)          Interactive REPL on a TTY; reads piped stdin otherwise.",
  "  --once <message>   Run exactly one turn, print the reply, exit.",
  "",
  "Engine: ANTHROPIC_API_KEY is preferred, then OPENAI_API_KEY. With neither,",
  "the brain is an honest, self-announcing [mock] echo. HADES_CHAT_MODEL",
  "overrides the model; ANTHROPIC_BASE_URL / OPENAI_BASE_URL override the",
  "endpoint (API keys are read only from the environment, never from flags).",
];

/** Build the agent that backs every mode — one composition, three drivers. */
function buildAgent(deps: ChatCommandDeps, resolved: ResolvedChatBrain): ConversationalAgent {
  return new ConversationalAgent({
    brain: resolved.brain,
    memory: deps.memory,
    sessions: deps.sessions,
    ...(deps.models ? { models: deps.models } : {}),
    contextFiles: { dataDir: deps.dataDir },
  });
}

/** stdout-backed {@link ReplIO}. */
function stdoutIo(): ReplIO {
  return {
    write: (chunk) => process.stdout.write(chunk),
    writeLine: (line) => process.stdout.write(`${line}\n`),
  };
}

/**
 * Run `hades chat`. Returns a {@link CliResult}; in interactive/piped mode the
 * output is streamed live through the io sink and `lines` comes back empty so
 * the caller does not print it twice (same convention as `onGateway` in
 * `../bin/hades.ts`).
 */
export async function runChatCommand(args: string[], deps: ChatCommandDeps): Promise<CliResult> {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    return { code: 0, lines: USAGE };
  }

  const resolved = (deps.resolve ?? resolveChatBrain)(deps.env);
  const engineLine = formatChatEngineLine(resolved);

  // ── one-shot ──────────────────────────────────────────────────────────────
  const onceIdx = args.indexOf("--once");
  if (onceIdx !== -1) {
    const message = args.slice(onceIdx + 1).join(" ").trim();
    if (!message) {
      return { code: 1, lines: ["error: --once requires a message", "", ...USAGE] };
    }
    const agent = buildAgent(deps, resolved);
    const reply = await agent.handler(message, () => {}, new AbortController().signal);
    return { code: 0, lines: [engineLine, reply] };
  }

  // ── piped / interactive ───────────────────────────────────────────────────
  const io = deps.io ?? stdoutIo();
  const input = deps.input ?? process.stdin;
  const agent = buildAgent(deps, resolved);
  const repl = agent.repl(io, { prompt: "hades> " });

  io.writeLine(engineLine);
  const interactive = input.isTTY === true;
  if (interactive) io.writeLine("Type /help for commands, /exit to quit.");

  const rl = createInterface({ input, terminal: false });
  let exited = false;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === "/exit" || trimmed === "/quit") {
      exited = true;
      break;
    }
    await repl.feedLine(line);
  }
  rl.close();

  if (interactive && !exited) io.writeLine("");
  return { code: 0, lines: [] };
}
