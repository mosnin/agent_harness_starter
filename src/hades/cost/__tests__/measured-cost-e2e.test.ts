/**
 * END-TO-END proof that the measured cost is MEASURED.
 *
 * Unit tests can only show the arithmetic is consistent with itself. What has
 * to be demonstrated here is stronger and is the whole point of the feature:
 * the tokens and dollars a run reports come from **the bytes a real provider
 * actually sent back**, not from a constant baked into the harness.
 *
 * So this file starts the REAL `scripts/stub-llm.mjs` as a REAL subprocess on
 * loopback, points `hades chat` at it over real HTTP, and then:
 *
 *   1. reads the stub's `usage` block by calling it directly, and asserts the
 *      run's reported tokens equal THAT — a trace, not a coincidence;
 *   2. runs two turns and shows the total doubles, which a constant could not;
 *   3. re-runs against `--usage off` (the same stub, no usage block) and shows
 *      the answer becomes UNKNOWN rather than a flattering $0;
 *   4. re-runs with an unpriced model id and shows tokens stay measured while
 *      dollars go UNKNOWN;
 *   5. reads the durable journal back through `hades cost` and gets the same
 *      figures out of a different process's file.
 *
 * No API key, no external network, no fabricated number anywhere.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runChatCommand, type ChatCommandDeps } from "../../cli/chat-command";
import { runCostCommand } from "../../cli/cost-command";
import { InMemoryMemoryStore } from "../../memory/store";
import { InMemorySessionStore } from "../../memory/session-store";
import { costJournalPath, readRunCosts, recomputeRunReport } from "../journal";
import { priceCall } from "../prices";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const STUB = join(REPO_ROOT, "scripts", "stub-llm.mjs");

/** Ask the OS for a free loopback port, then release it for the stub. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

interface Stub {
  baseUrl: string;
  proc: ChildProcess;
}

/** Boot `scripts/stub-llm.mjs` and wait for its real listening banner. */
async function startStub(usage: "on" | "off"): Promise<Stub> {
  const port = await freePort();
  const proc = spawn(process.execPath, [STUB, "--port", String(port), "--mode", "solve", "--usage", usage], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("stub-llm did not start in time")), 15_000);
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  return { baseUrl: `http://127.0.0.1:${port}/v1`, proc };
}

function stopStub(stub: Stub | undefined): void {
  stub?.proc.kill("SIGKILL");
}

/** Chat deps over in-memory stores and a throwaway data dir. */
function chatDeps(over: Partial<ChatCommandDeps> & { dataDir: string; env: ChatCommandDeps["env"] }): ChatCommandDeps {
  return {
    memory: new InMemoryMemoryStore(),
    sessions: new InMemorySessionStore(),
    ...over,
  };
}

function envFor(stub: Stub, model?: string): Record<string, string | undefined> {
  return {
    OPENAI_API_KEY: "sk-loopback-not-a-real-key",
    OPENAI_BASE_URL: stub.baseUrl,
    ...(model ? { HADES_CHAT_MODEL: model } : {}),
  };
}

/** The `cost:` summary line `hades chat` appends to its output. */
function costLine(lines: string[]): string {
  const line = lines.find((l) => l.startsWith("cost:"));
  if (!line) throw new Error(`no cost line in output:\n${lines.join("\n")}`);
  return line;
}

describe("measured cost, end to end against a real loopback provider", () => {
  let stub: Stub | undefined;
  let dataDir: string;

  beforeAll(async () => {
    stub = await startStub("on");
    dataDir = mkdtempSync(join(tmpdir(), "hades-cost-e2e-"));
  }, 30_000);

  afterAll(() => {
    stopStub(stub);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("reports the tokens the provider ACTUALLY sent back", async () => {
    // Ground truth straight off the wire: what does this stub really report?
    const probe = await fetch(`${stub!.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "probe" }] }),
    });
    const wire = (await probe.json()) as { usage?: { prompt_tokens: number; completion_tokens: number } };
    expect(wire.usage).toBeDefined();

    const res = await runChatCommand(["--once", "hello"], chatDeps({ dataDir, env: envFor(stub!), costJournal: null }));
    expect(res.code).toBe(0);

    const line = costLine(res.lines);
    // The measured counts must equal the provider's own numbers.
    expect(line).toContain(`${wire.usage!.prompt_tokens} / ${wire.usage!.completion_tokens} (measured) tokens`);
    // …and the dollars must be exactly those counts at the published price.
    const expected = priceCall("gpt-4o-mini", wire.usage!.prompt_tokens, wire.usage!.completion_tokens);
    expect(expected.priced).toBe(true);
    if (expected.priced) expect(line).toContain(`$${Number(expected.usd.toPrecision(4))}`);
    // A real clock ran.
    expect(line).toMatch(/wall=\d+(\.\d+)? m?s/);
  }, 30_000);

  it("scales with the number of real calls — a constant could not", async () => {
    const one = await runChatCommand(["--once", "a"], chatDeps({ dataDir, env: envFor(stub!), costJournal: null }));
    // Two turns down one piped session = two real round trips.
    const io = { write: () => {}, writeLine: () => {} };
    const lines: string[] = [];
    const two = await runChatCommand(
      [],
      chatDeps({
        dataDir,
        env: envFor(stub!),
        costJournal: null,
        input: Object.assign(streamOf(["a", "b"]), { isTTY: false }),
        io: { ...io, writeLine: (l: string) => void lines.push(l) },
      }),
    );
    expect(two.code).toBe(0);

    expect(costLine(one.lines)).toContain("50 / 10 (measured) tokens over 1 call(s)");
    expect(costLine(lines)).toContain("100 / 20 (measured) tokens over 2 call(s)");
  }, 30_000);

  it("writes a durable record that `hades cost` reads back with the same figures", async () => {
    const journal = costJournalPath(dataDir);
    const chat = await runChatCommand(
      ["--once", "record me"],
      chatDeps({ dataDir, env: envFor(stub!), costJournal: journal }),
    );
    expect(chat.code).toBe(0);

    const history = readRunCosts(journal);
    expect(history.records).toHaveLength(1);
    // The record stores the CALLS; the report is recomputed from them.
    const report = recomputeRunReport(history.records[0]);
    expect(report.tokensIn).toBe(50);
    expect(report.tokensOut).toBe(10);
    expect(report.usd).toBeCloseTo(0.0000135, 12);
    expect(history.records[0].calls[0].latencyMs).toBeGreaterThanOrEqual(0);

    // And the surface a user actually types agrees.
    const cost = runCostCommand(["last"], { env: {}, journalPath: journal });
    const out = cost.lines.join("\n");
    expect(cost.code).toBe(0);
    expect(out).toContain("50 / 10 (measured)");
    expect(out).toContain("$0.0000135");
    // The stub answers as `stub-model` while the request asked for
    // gpt-4o-mini — a real mismatch, surfaced rather than hidden.
    expect(out).toContain("gpt-4o-mini -> stub-model");
  }, 30_000);

  it("reports UNKNOWN dollars — not $0 — for a model with no published price", async () => {
    const res = await runChatCommand(
      ["--once", "unpriced"],
      chatDeps({ dataDir, env: envFor(stub!, "llama-3.3-70b-local"), costJournal: null }),
    );
    const line = costLine(res.lines);
    // Tokens are still MEASURED: the provider reported them.
    expect(line).toContain("50 / 10");
    // Dollars are not, and the model is named.
    expect(line).toContain("UNKNOWN");
    expect(line).toContain("llama-3.3-70b-local");
    expect(line).not.toMatch(/\$0\b/);
  }, 30_000);

  it("the [mock] brain measures nothing and records nothing", async () => {
    const journal = join(dataDir, "mock-runs.jsonl");
    const res = await runChatCommand(
      ["--once", "no key here"],
      chatDeps({ dataDir, env: {}, costJournal: journal }),
    );
    expect(res.lines[0]).toContain("[mock]");
    // No cost line at all: a mock made no provider call, so it has no cost —
    // and a "$0.00" row would be indistinguishable from a real free run.
    expect(res.lines.some((l) => l.startsWith("cost:"))).toBe(false);
    expect(readRunCosts(journal).missing).toBe(true);
  }, 30_000);
});

describe("a provider that reports no usage block", () => {
  let stub: Stub | undefined;
  let dataDir: string;

  beforeAll(async () => {
    stub = await startStub("off");
    dataDir = mkdtempSync(join(tmpdir(), "hades-cost-e2e-nousage-"));
  }, 30_000);

  afterAll(() => {
    stopStub(stub);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("counts the call but reports UNKNOWN tokens and UNKNOWN spend", async () => {
    const res = await runChatCommand(
      ["--once", "hello"],
      chatDeps({ dataDir, env: envFor(stub!), costJournal: null }),
    );
    const line = costLine(res.lines);
    expect(line).toContain("1 call(s)");
    expect(line).toContain("UNKNOWN");
    // The failure this whole feature exists to prevent: a real call that
    // consumed real tokens being recorded as free.
    expect(line).not.toContain("$0.00");
    expect(line).not.toContain("0 / 0");
  }, 30_000);
});

/** A minimal readable stream of lines, for the piped-chat driver. */
function streamOf(lines: string[]): NodeJS.ReadableStream {
  return Readable.from(lines.map((l) => `${l}\n`));
}
