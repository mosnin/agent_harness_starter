/**
 * hermes-swarm CLI — engine selection at the real process boundary.
 *
 * Companion to `cli.test.ts` (same spawn-the-real-CLI pattern) pinning the
 * audited defect's fix: the shipped CLI can now run a real model engine, and
 * it is HONEST about which engine a run gets:
 *
 *  - a keyless run prints the offline engine line and still completes;
 *  - `--offline` beats an exported provider key and says "explicitly
 *    requested" — a key in the environment must not silently flip a run
 *    to a real engine the user opted out of;
 *  - `SWARM_PROVIDER=openai` with no `OPENAI_API_KEY` exits non-zero naming
 *    that exact variable on stderr — never a silent fallback to mock;
 *  - `--provider local` against a dead 127.0.0.1 port really attempts the
 *    connection and fails FAST with a clear transport error (no hang, no
 *    external network: the endpoint is a loopback port nothing listens on);
 *  - and, against a loopback endpoint that behaves like a competent model, the
 *    CLI prints the CORRECT answer but DECLINES a confidently-formatted wrong
 *    one — the audited defect was `=== goal COMPLETED === / 42` on a task
 *    whose answer is 8, and the first fix for it declined the right answer too.
 *
 * Every spawn scrubs all provider key vars and SWARM_* engine config from the
 * child env, then injects only what the test declares, so results are
 * identical on a dev box with real keys exported and in CI.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS } from "../worker/providers";
import { computeSpec, type ReferenceSpec } from "../../hades/styx/reference-spec";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const CLI_TS = join(REPO_ROOT, "src", "swarm-runtime", "cli.ts");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");

/** One tsx spawn is ~2s cold; leave generous headroom for a loaded CI box. */
const SPAWN_TIMEOUT_MS = 60_000;

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI through tsx with a scrubbed engine environment plus `extraEnv`.
 * Scrubbing covers every provider key var in the {@link PROVIDERS} directory
 * (the same source of truth the CLI reads) plus the SWARM_* engine config, so
 * auto-selection can never see a real key from the host machine.
 */
function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<CliRun> {
  const env = { ...process.env };
  for (const cfg of Object.values(PROVIDERS)) {
    if (cfg.apiKeyEnv) delete env[cfg.apiKeyEnv];
  }
  delete env.SWARM_API_KEY;
  delete env.SWARM_PROVIDER;
  delete env.SWARM_MODEL;
  delete env.SWARM_BASE_URL;
  delete env.OPENAI_BASE_URL;
  Object.assign(env, extraEnv);
  return new Promise((resolve, reject) => {
    execFile(
      TSX_BIN,
      [CLI_TS, ...args],
      { cwd: REPO_ROOT, env, timeout: SPAWN_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error && (error.killed || typeof error.code !== "number")) {
          reject(new Error(`CLI spawn failed (${error.message})\nstderr: ${stderr}`));
          return;
        }
        resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
      }
    );
  });
}

/** Reserve a loopback port, then free it: connecting to it is refused fast. */
function unusedLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describe("hermes-swarm CLI — honest engine line", () => {
  it("keyless run prints the offline engine line, exactly once, and completes", async () => {
    const res = await runCli(["run", "summarize the fixture repo", "--caps", "research"]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain(
      "engine: deterministic offline executor (no provider key detected — set ANTHROPIC_API_KEY or OPENAI_API_KEY, or pass --provider local for Ollama/vLLM)"
    );
    expect(res.stderr.match(/engine: /g)?.length).toBe(1);
    expect(res.stderr).not.toContain("engine: real");
    expect(res.stdout).toMatch(/=== goal COMPLETED ===/);
  }, SPAWN_TIMEOUT_MS);

  it("--offline wins even with a provider key exported, and says it was requested", async () => {
    const res = await runCli(
      ["run", "summarize the fixture repo", "--caps", "research", "--offline"],
      { OPENAI_API_KEY: "sk-fake" }
    );
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("engine: deterministic offline executor (explicitly requested via --offline)");
    expect(res.stderr).not.toContain("engine: real");
    // The fake key's VALUE must never be echoed anywhere.
    expect(res.stdout + res.stderr).not.toContain("sk-fake");
    expect(res.stdout).toMatch(/=== goal COMPLETED ===/);
  }, SPAWN_TIMEOUT_MS);
});

describe("hermes-swarm CLI — missing key is a hard error, never a silent mock", () => {
  it("SWARM_PROVIDER=openai with OPENAI_API_KEY unset exits non-zero naming the variable", async () => {
    const res = await runCli(["run", "x"], { SWARM_PROVIDER: "openai" });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("OPENAI_API_KEY");
    // It must fail before any swarm is built — no workers, no goal verdict.
    expect(res.stderr).not.toMatch(/worker .* spawned/);
    expect(res.stdout).not.toMatch(/=== goal/);
  }, SPAWN_TIMEOUT_MS);

  it("--provider openai (flag form) fails the same way", async () => {
    const res = await runCli(["run", "x", "--provider", "openai"]);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("OPENAI_API_KEY");
  }, SPAWN_TIMEOUT_MS);
});

describe("hermes-swarm CLI — real engine path (loopback only, no external network)", () => {
  it("--provider local against an unused 127.0.0.1 port attempts the connection and fails fast", async () => {
    const port = await unusedLoopbackPort();
    const base = `http://127.0.0.1:${port}`;
    const startedAt = Date.now();
    const res = await runCli([
      "run",
      "ping the endpoint",
      "--provider", "local",
      "--model", "test-model",
      "--base-url", base,
      "--workers", "1",
      "--caps", "research",
    ]);
    const elapsedMs = Date.now() - startedAt;

    // It honestly announced a real engine pointed at the loopback endpoint…
    expect(res.stderr).toContain(`engine: real (provider=local model=test-model via ${base}, no API key required)`);
    // …really attempted the connection (refused, with the endpoint named)…
    expect(res.stderr).toContain(`chat request to ${base} failed before any response`);
    expect(res.stderr).toContain("ECONNREFUSED");
    // …and failed the run rather than silently degrading to the offline executor.
    expect(res.code).not.toBe(0);
    expect(res.stdout).toMatch(/=== goal FAILED ===/);
    expect(res.stdout).not.toMatch(/=== goal COMPLETED ===/);
    // Fail-fast, not a hang: refused loopback connects resolve instantly; the
    // bound is generous only for slow CI spawns of tsx itself.
    expect(elapsedMs).toBeLessThan(30_000);
  }, SPAWN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Correctness, not just grounding — at the real process boundary
// ---------------------------------------------------------------------------

/**
 * A loopback OpenAI-compatible endpoint that answers like a COMPETENT model on
 * a swarm plan: prose for the planner's fan-out subtasks, the requested value
 * for the final synthesis task. Every reply is well-grounded (its evidence is
 * quoted verbatim out of the prompt it was given), so the gate's six grounding
 * checks pass either way and the only thing that can separate a right run from
 * a wrong one is a CORRECTNESS check.
 *
 * That distinction is the point. `scripts/stub-llm.mjs --mode solve` returns
 * the reference answer for EVERY task including the fan-out ones, so it cannot
 * see the regression where a swarm refutes an intermediate result for not
 * being the final answer. This one can.
 */
function startCompetentModel(finalAnswer: (specLine: string) => string): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const payload = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
      const prompt = (payload.messages ?? [])
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n");
      const specLine =
        prompt
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("SPEC:"))
          .pop() ?? "";
      const synthesizing = /TASK:\s*Synthesize/.test(prompt);
      const answer = synthesizing
        ? finalAnswer(specLine)
        : "From this angle the objective is a deterministic computation to be recomputed at synthesis time.";
      // Cite a verbatim slice of the prompt so `evidence-traceable` passes on
      // its merits — a model that grounds badly would fail the gate for a
      // reason that has nothing to do with what these tests measure.
      const quoted = (prompt.split("\n").find((l) => l.startsWith("TASK:")) ?? prompt).slice(0, 80);
      const content = JSON.stringify({
        answer,
        claims: [
          {
            statement: synthesizing ? `The answer is ${answer}.` : "The task was read in full.",
            evidence: [quoted],
            confidence: 0.9,
          },
        ],
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "stub",
          object: "chat.completion",
          model: "competent-stub",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        }),
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** Recomputed by the shipped ground-truth function — never hard-coded here. */
const CLI_SPEC: ReferenceSpec = { family: "arithmetic", start: 5, ops: [["add", 3]] };
const CLI_TRUTH = computeSpec(CLI_SPEC);
const CLI_OBJECTIVE = [
  "Compute the result of the arithmetic below.",
  "Respond with only the exact result and nothing else.",
  `SPEC:${JSON.stringify(CLI_SPEC)}`,
].join("\n");

describe("hermes-swarm CLI — a wrong answer is declined, not printed as COMPLETED", () => {
  async function runAgainstModel(answer: (specLine: string) => string): Promise<CliRun> {
    const model = await startCompetentModel(answer);
    try {
      return await runCli([
        "run",
        CLI_OBJECTIVE,
        "--provider", "local",
        "--model", "competent-stub",
        "--base-url", `${model.baseUrl}/v1`,
        "--workers", "1",
        "--caps", "general",
      ]);
    } finally {
      await model.close();
    }
  }

  it("prints the CORRECT answer and exits 0 when the model actually solves the task", async () => {
    // The regression guard: verification that declines correct work is not
    // "safe", it is broken. This must pass before the next test means anything.
    const res = await runAgainstModel((specLine) => {
      const spec = JSON.parse(specLine.slice("SPEC:".length)) as ReferenceSpec;
      return computeSpec(spec);
    });
    expect(res.stdout).toMatch(/=== goal COMPLETED ===/);
    expect(res.stdout).toContain(CLI_TRUTH);
    expect(res.code).toBe(0);
  }, SPAWN_TIMEOUT_MS);

  it("FAILS the goal on a confidently-formatted wrong answer", async () => {
    const res = await runAgainstModel(() => "42");
    expect(res.stdout).toMatch(/=== goal FAILED ===/);
    expect(res.stdout).not.toMatch(/=== goal COMPLETED ===/);
    expect(res.code).not.toBe(0);
    // And it says WHY, naming the recomputed truth — a rejection nobody can
    // audit is barely better than a silent acceptance.
    expect(res.stderr).toContain("independently REFUTED");
    expect(res.stderr).toContain("reference-mismatch:arithmetic");
    expect(res.stderr).toContain(CLI_TRUTH);
  }, SPAWN_TIMEOUT_MS);

  it("leaves an objective with no SPEC: reference alone — it completes as always", async () => {
    const model = await startCompetentModel(() => "the release shipped on Tuesday");
    try {
      const res = await runCli([
        "run",
        "Summarize the release notes in one sentence.",
        "--provider", "local",
        "--model", "competent-stub",
        "--base-url", `${model.baseUrl}/v1`,
        "--workers", "1",
        "--caps", "general",
      ]);
      expect(res.stdout).toMatch(/=== goal COMPLETED ===/);
      expect(res.code).toBe(0);
    } finally {
      await model.close();
    }
  }, SPAWN_TIMEOUT_MS);
});
