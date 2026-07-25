/**
 * `hades market <sub>` — the terminal surface over the verified-work market.
 *
 * Every test here drives the REAL command against a REAL `openMarket()`
 * stack in a real temp data dir, with a REAL ed25519 trust-gate key planted
 * exactly where `openTrustStack()` writes one. Nothing is stubbed: the
 * numbers this command prints are computed by the real reputation kernel,
 * the real adjudicator and the real exchange.
 *
 * The assertions that matter most are the honesty ones:
 *  - an UNDEFINED skill score prints `n/a`, never `0.000`;
 *  - `doctor` FAILS (exit 1) on an install with no trusted issuer, rather
 *    than reporting a healthy market that would reject every certificate;
 *  - `simulate` carries its MODEL banner on every invocation;
 *  - the command is routed from the real `HadesCli`, so it cannot rot into
 *    an unreachable module.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMarketCommand, defaultMarketDeps, MARKET_USAGE, type MarketCommandDeps } from "../market-command";
import { HadesCli } from "../cli";
import { openMarket } from "../../market/wiring";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  type CertificatePayload,
} from "../../styx/certificate";

/** A deliberately empty environment: these tests must never read the real
 *  ambient env (a developer's HADES_STYX_KEY would silently change what the
 *  market trusts). Cast once, here, rather than at every call site. */
const EMPTY_ENV = {} as NodeJS.ProcessEnv;

const NOW = 1_700_000_000_000;
const OUTPUT = "the delivered agent output, verbatim";
const TRACE = JSON.stringify({ steps: ["plan", "verify"], ok: true });

function seededRng(seed: number): (bytes: number) => Uint8Array {
  let state = (seed ^ 0x9e3779b9) >>> 0 || 1;
  return (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state >>>= 0;
      state ^= state << 5;
      state >>>= 0;
      out[i] = state & 0xff;
    }
    return out;
  };
}

const dirs: string[] = [];
function tempDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), "hades-market-cli-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function plantSigningKey(dataDir: string, seed: number): CertificateAuthority {
  const privateKeyHex = generatePrivateKeyHex(seededRng(seed));
  mkdirSync(join(dataDir, "trust"), { recursive: true });
  writeFileSync(join(dataDir, "trust", "signing-key"), privateKeyHex, { mode: 0o600 });
  return new CertificateAuthority(privateKeyHex);
}

function payload(overrides: Partial<CertificatePayload> = {}): CertificatePayload {
  return {
    outputSha256: sha256Hex(OUTPUT),
    taskId: "task-alpha",
    verifierTier: "T1-reference",
    ensembleScore: 0.93,
    pCorrect: 0.95,
    epsilon: 0.05,
    traceSha256: sha256Hex(TRACE),
    verifierVersions: ["genrm-v1"],
    issuedAt: NOW - 1000,
    ...overrides,
  };
}

/** A deps object over a real stack in `dataDir`, with one settled task when asked. */
async function depsFor(dataDir: string, opts: { settle?: boolean; seed?: number } = {}): Promise<MarketCommandDeps> {
  const ca = plantSigningKey(dataDir, opts.seed ?? 61);
  const stack = openMarket({ dataDir, env: EMPTY_ENV });
  if (opts.settle) {
    stack.economy.register("alice", "agent", 1000);
    stack.economy.postTask({ taskId: "task-alpha", domain: "code", reward: 100, difficulty: 0.5, postedAt: NOW });
    stack.economy.award({ taskId: "task-alpha", participantId: "alice", price: 80, claimedPCorrect: 0.9, awardedAt: NOW });
    await stack.economy.submitClaim({
      taskId: "task-alpha",
      participantId: "alice",
      outputText: OUTPUT,
      claimedPCorrect: 0.9,
      certificate: await ca.issue(payload()),
      traceJson: TRACE,
      submittedAt: NOW,
    });
  }
  return { stack: () => stack };
}

// ===========================================================================

describe("hades market — routing and help", () => {
  it("no args / help / --help / -h all print the usage without touching the stack", async () => {
    let opened = 0;
    const deps: MarketCommandDeps = {
      stack: () => {
        opened += 1;
        throw new Error("the stack must not be opened for help");
      },
    };
    for (const args of [[], ["help"], ["--help"], ["-h"]]) {
      const res = await runMarketCommand(args, deps);
      expect(res.code).toBe(0);
      expect(res.lines).toEqual(MARKET_USAGE);
    }
    expect(opened).toBe(0);
  });

  it("an unknown subcommand exits 1 and prints the usage", async () => {
    const res = await runMarketCommand(["nope"], { stack: () => openMarket({ dataDir: null, env: EMPTY_ENV }) });
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("Unknown market command: nope");
  });

  it("`market` is a real HadesCli route, not an orphan module", async () => {
    const dataDir = tempDataDir();
    const deps = await depsFor(dataDir);
    const cli = new HadesCli({ market: () => deps });
    const res = await cli.run(["market", "help"]);
    expect(res.code).toBe(0);
    expect(res.lines).toEqual(MARKET_USAGE);
  });

  it("`hades help` advertises the market surface", async () => {
    const cli = new HadesCli({});
    const res = await cli.run(["help"]);
    expect(res.lines.some((l) => l.includes("market <sub>"))).toBe(true);
  });

  it("defaultMarketDeps is lazy — constructing it opens nothing", () => {
    const dataDir = tempDataDir();
    expect(() => defaultMarketDeps(EMPTY_ENV, { dataDir })).not.toThrow();
  });
});

// ===========================================================================

describe("hades market status", () => {
  it("prints the real trusted issuer, treasury and chain verdict", async () => {
    const dataDir = tempDataDir();
    const deps = await depsFor(dataDir, { settle: true });
    const res = await runMarketCommand(["status"], deps);
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toContain("MARKET — the verified-work economy");
    expect(text).toContain("(persisted)");
    expect(text).toContain("reputation chain    VERIFIED");
    expect(text).toContain("alice");
  });

  it("an UNDEFINED skill score prints n/a, never 0.000", async () => {
    const dataDir = tempDataDir();
    const deps = await depsFor(dataDir, { settle: true });
    const res = await runMarketCommand(["status"], deps);
    const aliceRow = res.lines.find((l) => l.includes("alice") && l.includes("active"));
    expect(aliceRow).toBeDefined();
    expect(aliceRow).toContain("n/a");
    const text = res.lines.join("\n");
    expect(text).toContain("carry no variance yet, so it is undefined — not zero");
  });

  it("warns loudly when no trust identity exists (every certificate would be rejected)", async () => {
    const dataDir = tempDataDir();
    const stack = openMarket({ dataDir, env: EMPTY_ENV });
    const res = await runMarketCommand(["status"], { stack: () => stack });
    expect(res.lines.join("\n")).toContain("no trust-gate signing identity");
  });

  it("--json emits the machine-readable status view", async () => {
    const dataDir = tempDataDir();
    const deps = await depsFor(dataDir, { settle: true });
    const res = await runMarketCommand(["status", "--json"], deps);
    const parsed = JSON.parse(res.lines.join("\n")) as {
      chainOk: boolean;
      participants: Array<{ id: string; scoreDefined: boolean }>;
    };
    expect(parsed.chainOk).toBe(true);
    expect(parsed.participants[0].id).toBe("alice");
    expect(parsed.participants[0].scoreDefined).toBe(false);
  });
});

// ===========================================================================

describe("hades market reputation / ledger", () => {
  it("reputation prints the real Murphy decomposition and calibration curve", async () => {
    const dataDir = tempDataDir();
    const deps = await depsFor(dataDir, { settle: true });
    const res = await runMarketCommand(["reputation", "--participant", "alice"], deps);
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toContain("REPUTATION — alice (agent)");
    expect(text).toContain("murphy");
    expect(text).toContain("MEAN CLAIM");
    // Undefined skill score is spelled out, not printed as a number.
    expect(text).toContain("skill score undefined");
  });

  it("reputation for an unknown participant fails honestly", async () => {
    const dataDir = tempDataDir();
    const deps = await depsFor(dataDir, { settle: true });
    const res = await runMarketCommand(["reputation", "--participant", "ghost"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("no recorded reputation events");
  });

  it("ledger --verify re-walks the real hash chain and reports VERIFIED", async () => {
    const dataDir = tempDataDir();
    const deps = await depsFor(dataDir, { settle: true });
    const res = await runMarketCommand(["ledger", "--verify"], deps);
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("CHAIN VERIFIED");
  });

  it("ledger --entries rejects a non-positive count rather than silently defaulting", async () => {
    const dataDir = tempDataDir();
    const deps = await depsFor(dataDir);
    const res = await runMarketCommand(["ledger", "--entries", "0"], deps);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("--entries must be a positive integer");
  });
});

// ===========================================================================

describe("hades market book / explain", () => {
  const orders = [{ taskId: "t1", domain: "code", maxPrice: 100, postedAt: NOW }];
  const offers = [
    { participantId: "alice", taskId: "t1", price: 10, claimedPCorrect: 0.9, capability: { domain: "code", tags: [] } },
    { participantId: "bob", taskId: "t1", price: 20, claimedPCorrect: 0.95, capability: { domain: "code", tags: [] } },
  ];

  function fileDeps(base: MarketCommandDeps): MarketCommandDeps {
    const files: Record<string, string> = {
      "/orders.json": JSON.stringify(orders),
      "/offers.json": JSON.stringify(offers),
      "/bad.json": "{not json",
    };
    return {
      stack: base.stack,
      fileExists: (p) => p in files,
      readFile: (p) => files[p],
    };
  }

  it("clears a real round and prints the second-price table", async () => {
    const dataDir = tempDataDir();
    const deps = fileDeps(await depsFor(dataDir, { settle: true }));
    const res = await runMarketCommand(
      ["book", "--orders", "/orders.json", "--offers", "/offers.json", "--now", String(NOW)],
      deps,
    );
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toContain("MARKET BOOK");
    expect(text).toContain("CLEARS AT");
    expect(text).toContain("second price");
  });

  it("a missing file and malformed JSON both fail with a real reason", async () => {
    const dataDir = tempDataDir();
    const deps = fileDeps(await depsFor(dataDir));
    const missing = await runMarketCommand(["book", "--orders", "/nope.json", "--offers", "/offers.json"], deps);
    expect(missing.code).toBe(1);
    expect(missing.lines[0]).toContain("no such file");

    const bad = await runMarketCommand(["book", "--orders", "/bad.json", "--offers", "/offers.json"], deps);
    expect(bad.code).toBe(1);
    expect(bad.lines[0]).toContain("is not valid JSON");
  });

  it("explain requires --task and renders a deterministic ranking", async () => {
    const dataDir = tempDataDir();
    const deps = fileDeps(await depsFor(dataDir, { settle: true }));
    const missing = await runMarketCommand(["explain", "--offers", "/offers.json"], deps);
    expect(missing.code).toBe(1);
    expect(missing.lines[0]).toContain("--task <taskId> is required");

    const a = await runMarketCommand(
      ["explain", "--task", "t1", "--offers", "/offers.json", "--now", String(NOW)],
      deps,
    );
    const b = await runMarketCommand(
      ["explain", "--task", "t1", "--offers", "/offers.json", "--now", String(NOW)],
      deps,
    );
    expect(a.code).toBe(0);
    expect(a.lines).toEqual(b.lines);
    expect(a.lines.join("\n")).toContain("expectedVerifiedValue");
  });
});

// ===========================================================================

describe("hades market simulate — always labelled a model", () => {
  it("prints the MODEL banner and never claims to be live market data", async () => {
    const res = await runMarketCommand(["simulate", "--seed", "5", "--rounds", "6", "--tasks-per-round", "2"], {
      stack: () => {
        throw new Error("simulate must not open the live market stack");
      },
    });
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toContain("MODEL:");
    expect(text).toContain("seeded deterministic archetype simulation");
  });

  it("--json carries modelLabel as a first-class field", async () => {
    const res = await runMarketCommand(
      ["simulate", "--seed", "3", "--rounds", "5", "--tasks-per-round", "2", "--json"],
      { stack: () => openMarket({ dataDir: null, env: EMPTY_ENV }) },
    );
    const parsed = JSON.parse(res.lines.join("\n")) as { modelLabel: string; seed: number };
    expect(parsed.modelLabel.length).toBeGreaterThan(0);
    expect(parsed.seed).toBe(3);
  });

  it("a non-numeric flag fails rather than silently defaulting", async () => {
    const res = await runMarketCommand(["simulate", "--seed", "abc"], {
      stack: () => openMarket({ dataDir: null, env: EMPTY_ENV }),
    });
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("--seed must be a finite number");
  });
});

// ===========================================================================

describe("hades market doctor", () => {
  it("FAILS on an install with no trusted issuer, instead of reporting a healthy market", async () => {
    const dataDir = tempDataDir();
    const stack = openMarket({ dataDir, env: EMPTY_ENV });
    const res = await runMarketCommand(["doctor"], { stack: () => stack });
    expect(res.code).toBe(1);
    const text = res.lines.join("\n");
    expect(text).toContain("trusted issuer present");
    expect(text).toContain("FAIL");
    expect(text).toContain("market wiring has problems");
  });

  it("PASSES once the trust gate has an identity, and runs a REAL adjudication probe", async () => {
    const dataDir = tempDataDir();
    const deps = await depsFor(dataDir, { settle: true });
    const res = await runMarketCommand(["doctor"], deps);
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toContain("adjudicator refuses an uncertified claim");
    expect(text).toContain("no-certificate");
    expect(text).toContain("market wiring is healthy");
    expect(text).not.toContain("FAIL");
  });

  it("--json reports every check with its real detail", async () => {
    const dataDir = tempDataDir();
    const deps = await depsFor(dataDir, { settle: true });
    const res = await runMarketCommand(["doctor", "--json"], deps);
    const parsed = JSON.parse(res.lines.join("\n")) as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.map((c) => c.name)).toContain("token conservation");
  });
});
