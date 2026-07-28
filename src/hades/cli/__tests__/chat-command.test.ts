/**
 * `hades chat` at the real process boundary.
 *
 * The audit's #1 product-fatal finding was that `hades chat` — the first
 * command in `hades help` — was a one-line stub, so the agent could not be
 * talked to at all. A unit test of the brain cannot catch a regression back
 * to that state (the stub never reached the brain), so these tests spawn the
 * REAL CLI through tsx, exactly like `swarm-runtime/__tests__/cli.test.ts`.
 *
 * The "real provider" case is served by a throwaway OpenAI-compatible server
 * on 127.0.0.1, so the keyed path is genuinely exercised — request made,
 * response rendered — without a key, a bill, or a packet leaving the box.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const CLI_TS = join(REPO_ROOT, "src", "hades", "bin", "hades.ts");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");

/** One tsx spawn is ~2s cold; leave headroom for a loaded CI box. */
const SPAWN_TIMEOUT_MS = 60_000;

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

let dataDir: string;
let stub: Server;
let stubPort: number;
let stubCalls = 0;

const STUB_REPLY = "PONG-FROM-STUB-7719";

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hades-chat-test-"));
  stub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      stubCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "stub",
          object: "chat.completion",
          model: "stub-model",
          choices: [{ index: 0, message: { role: "assistant", content: STUB_REPLY }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stubPort = (stub.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * Run the real CLI. Ambient provider keys are stripped so a keyed dev box can
 * never turn a mock-mode assertion into a live API call; `extraEnv` opts a
 * single test back in, pointed at the local stub.
 */
function runCli(args: string[], extraEnv: Record<string, string> = {}, stdin?: string): Promise<CliRun> {
  const env: Record<string, string | undefined> = { ...process.env, HADES_DATA_DIR: dataDir };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.HADES_CHAT_MODEL;
  delete env.ANTHROPIC_BASE_URL;
  delete env.OPENAI_BASE_URL;
  // The stub is on loopback: never let a configured proxy intercept it.
  env.NO_PROXY = "*";
  env.no_proxy = "*";
  Object.assign(env, extraEnv);

  return new Promise((resolve) => {
    const child = execFile(
      TSX_BIN,
      [CLI_TS, ...args],
      { env: env as NodeJS.ProcessEnv, timeout: SPAWN_TIMEOUT_MS, cwd: REPO_ROOT },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : 0;
        resolve({ code, stdout, stderr });
      },
    );
    if (stdin !== undefined) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
  });
}

describe("hades chat — one-shot mode", () => {
  it("answers with the honest [mock] brain when no provider key is set", async () => {
    const { code, stdout } = await runCli(["chat", "--once", "hello there"]);
    expect(code).toBe(0);
    expect(stdout).toContain("chat engine: [mock] echo (no provider key)");
    expect(stdout).toContain("[mock]");
    expect(stdout).toContain("hello there");
    // The stub of old: a bare pointer at "the Hades REPL API".
    expect(stdout).not.toContain("available via the Hades REPL API");
  });

  it("calls a real provider endpoint and renders its reply", async () => {
    const before = stubCalls;
    const { code, stdout } = await runCli(["chat", "--once", "ping"], {
      OPENAI_API_KEY: "sk-test-not-a-real-key",
      OPENAI_BASE_URL: `http://127.0.0.1:${stubPort}/v1`,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("chat engine: real (provider=openai");
    expect(stdout).toContain("via OPENAI_API_KEY");
    expect(stdout).toContain(STUB_REPLY);
    expect(stdout).not.toContain("[mock]");
    // The key VALUE must never be echoed anywhere.
    expect(stdout).not.toContain("sk-test-not-a-real-key");
    expect(stubCalls).toBeGreaterThan(before);
  });

  it("errors instead of guessing when --once has no message", async () => {
    const { code, stdout } = await runCli(["chat", "--once"]);
    expect(code).toBe(1);
    expect(stdout).toContain("--once requires a message");
  });
});

describe("hades chat — piped stdin", () => {
  it("runs one turn per line and exits at EOF", async () => {
    const { code, stdout } = await runCli(["chat"], {}, "first message\nsecond message\n");
    expect(code).toBe(0);
    expect(stdout).toContain("first message");
    expect(stdout).toContain("second message");
  });

  it("dispatches slash commands through the real REPL registry", async () => {
    const { code, stdout } = await runCli(["chat"], {}, "/remember pipelines run on fridays\n/recall fridays\n");
    expect(code).toBe(0);
    expect(stdout).toContain("Remembered: pipelines run on fridays");
    // /recall reads the same guarded store back.
    expect(stdout).toContain("pipelines run on fridays");
  });

  it("shares one memory store with `hades memory` (not a second private one)", async () => {
    await runCli(["chat"], {}, "/remember chat and memory share a store\n");
    const { code, stdout } = await runCli(["memory", "search", "share"]);
    expect(code).toBe(0);
    expect(stdout).toContain("chat and memory share a store");
  });
});
