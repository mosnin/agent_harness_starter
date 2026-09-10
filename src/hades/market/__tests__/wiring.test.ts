/**
 * `openMarket()` — the central assembly every market surface shares.
 *
 * This suite proves the wiring is REAL, not decorative:
 *  - the market's trusted issuer is genuinely THIS INSTALL's trust-gate
 *    ed25519 identity, read from `<dataDir>/trust/signing-key`, so a
 *    certificate minted by `hades trust` adjudicates here (and one minted by
 *    a different key does not);
 *  - reading the market NEVER mints a signing key as a side effect;
 *  - every durable artifact round-trips across a simulated process restart,
 *    including the certificate replay registry (so a spent certificate stays
 *    spent);
 *  - a TAMPERED reputation ledger is REFUSED, not silently accepted, and the
 *    refusal is reported rather than swallowed.
 *
 * Real ed25519 throughout (seeded, no `Math.random`), real files in a real
 * temp dir, real hash chains. `now` is always explicit.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openMarket, marketStatus, resolveMarketIssuer, MARKET_REPUTATION_FILE } from "../wiring";
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
  const d = mkdtempSync(join(tmpdir(), "hades-market-wiring-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write a real trust-gate signing key exactly where `openTrustStack` puts it. */
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

// ===========================================================================

describe("openMarket — trusted issuer is the install's own trust-gate identity", () => {
  it("reads the PERSISTED trust key and trusts exactly it", () => {
    const dataDir = tempDataDir();
    const ca = plantSigningKey(dataDir, 21);
    const stack = openMarket({ dataDir, env: EMPTY_ENV });
    expect(stack.issuerPublicKeyHex).toBe(ca.publicKeyHex());
    expect(stack.issuerKeySource).toBe("persisted");
    expect(stack.trustedIssuers).toEqual([ca.publicKeyHex().toLowerCase()]);
  });

  it("a certificate signed by that identity adjudicates as VERIFIED end to end", async () => {
    const dataDir = tempDataDir();
    const ca = plantSigningKey(dataDir, 22);
    const stack = openMarket({ dataDir, env: EMPTY_ENV });
    const result = await stack.adjudicator.adjudicate(
      {
        taskId: "task-alpha",
        participantId: "alice",
        outputText: OUTPUT,
        claimedPCorrect: 0.9,
        certificate: await ca.issue(payload()),
        traceJson: TRACE,
        submittedAt: NOW,
      },
      NOW,
    );
    expect(result.status).toBe("verified");
    expect(result.codes).toEqual([]);
  });

  it("a certificate signed by a DIFFERENT real key is rejected as untrusted-issuer", async () => {
    const dataDir = tempDataDir();
    plantSigningKey(dataDir, 23);
    const stranger = new CertificateAuthority(generatePrivateKeyHex(seededRng(99)));
    const stack = openMarket({ dataDir, env: EMPTY_ENV });
    const result = await stack.adjudicator.adjudicate(
      {
        taskId: "task-alpha",
        participantId: "alice",
        outputText: OUTPUT,
        claimedPCorrect: 0.9,
        certificate: await stranger.issue(payload()),
        traceJson: TRACE,
        submittedAt: NOW,
      },
      NOW,
    );
    expect(result.status).toBe("fabricated");
    expect(result.codes).toContain("untrusted-issuer");
  });

  it("with NO trust identity yet, the market honestly trusts NOBODY and never mints a key as a side effect", () => {
    const dataDir = tempDataDir();
    const stack = openMarket({ dataDir, env: EMPTY_ENV });
    expect(stack.issuerPublicKeyHex).toBe("");
    expect(stack.issuerKeySource).toBe("absent");
    expect(stack.trustedIssuers).toEqual([]);
    // Reading the market must not create a signing key.
    expect(existsSync(join(dataDir, "trust", "signing-key"))).toBe(false);
  });

  it("HADES_STYX_KEY takes precedence and is reported as `env`", () => {
    const dataDir = tempDataDir();
    plantSigningKey(dataDir, 24);
    const envCa = new CertificateAuthority(generatePrivateKeyHex(seededRng(77)));
    const resolved = resolveMarketIssuer(dataDir, {
      ...EMPTY_ENV,
      HADES_STYX_KEY: generatePrivateKeyHex(seededRng(77)),
    });
    expect(resolved.source).toBe("env");
    expect(resolved.publicKeyHex).toBe(envCa.publicKeyHex());
  });

  it("a malformed extra issuer is DROPPED and reported, never silently widening the trusted set", () => {
    const dataDir = tempDataDir();
    const ca = plantSigningKey(dataDir, 25);
    const stack = openMarket({ dataDir, env: EMPTY_ENV, extraIssuers: ["not-a-key", "ZZZZ"] });
    expect(stack.trustedIssuers).toEqual([ca.publicKeyHex().toLowerCase()]);
    expect(stack.loadErrors.issuers).toBeDefined();
  });
});

// ===========================================================================

describe("openMarket — durability across a process restart", () => {
  it("reputation, economy and replay registry all survive save() + re-open", async () => {
    const dataDir = tempDataDir();
    const ca = plantSigningKey(dataDir, 31);

    const first = openMarket({ dataDir, env: EMPTY_ENV });
    first.economy.register("alice", "agent", 1000);
    first.economy.postTask({ taskId: "task-alpha", domain: "code", reward: 100, difficulty: 0.5, postedAt: NOW });
    first.economy.award({ taskId: "task-alpha", participantId: "alice", price: 80, claimedPCorrect: 0.9, awardedAt: NOW });
    const settled = await first.economy.submitClaim({
      taskId: "task-alpha",
      participantId: "alice",
      outputText: OUTPUT,
      claimedPCorrect: 0.9,
      certificate: await ca.issue(payload()),
      traceJson: TRACE,
      submittedAt: NOW,
    });
    expect(settled.status).toBe("verified");
    first.save();

    const second = openMarket({ dataDir, env: EMPTY_ENV });
    expect(second.loadErrors).toEqual({});
    expect(second.chainOk).toBe(true);
    expect(second.economy.account("alice")).toEqual(first.economy.account("alice"));
    expect(second.economy.treasury()).toBe(first.economy.treasury());
    expect(second.economy.history()).toEqual(first.economy.history());
    expect(second.adjudicator.seenCertificates()).toBe(1);
    expect(second.reputation.verifyChain().ok).toBe(true);
    expect(second.reputation.entries("alice").length).toBe(1);
  });

  it("a certificate spent BEFORE the restart cannot be re-spent by a thief AFTER it", async () => {
    const dataDir = tempDataDir();
    const ca = plantSigningKey(dataDir, 32);
    const cert = await ca.issue(payload());

    const first = openMarket({ dataDir, env: EMPTY_ENV });
    const spent = await first.adjudicator.adjudicate(
      {
        taskId: "task-alpha",
        participantId: "alice",
        outputText: OUTPUT,
        claimedPCorrect: 0.9,
        certificate: cert,
        traceJson: TRACE,
        submittedAt: NOW,
      },
      NOW,
    );
    expect(spent.status).toBe("verified");
    first.save();

    const second = openMarket({ dataDir, env: EMPTY_ENV });
    const theft = await second.adjudicator.adjudicate(
      {
        taskId: "task-alpha",
        participantId: "mallory",
        outputText: OUTPUT,
        claimedPCorrect: 0.9,
        certificate: cert,
        traceJson: TRACE,
        submittedAt: NOW + 1,
      },
      NOW + 1,
    );
    expect(theft.status).toBe("fabricated");
    expect(theft.codes).toContain("replayed-certificate");
  });

  it("the exchange reads the SAME restored ledger the economy does (not a second, empty copy)", async () => {
    const dataDir = tempDataDir();
    const ca = plantSigningKey(dataDir, 33);
    const first = openMarket({ dataDir, env: EMPTY_ENV });
    first.economy.register("alice", "agent", 1000);
    first.economy.postTask({ taskId: "task-alpha", domain: "code", reward: 100, postedAt: NOW });
    first.economy.award({ taskId: "task-alpha", participantId: "alice", price: 80, claimedPCorrect: 0.9, awardedAt: NOW });
    await first.economy.submitClaim({
      taskId: "task-alpha",
      participantId: "alice",
      outputText: OUTPUT,
      claimedPCorrect: 0.9,
      certificate: await ca.issue(payload()),
      traceJson: TRACE,
      submittedAt: NOW,
    });
    first.save();

    const second = openMarket({ dataDir, env: EMPTY_ENV });
    expect(second.reputation).toBe(second.economy.reputation());
    const explained = second.exchange.explain(
      "task-beta",
      [
        {
          participantId: "alice",
          taskId: "task-beta",
          price: 10,
          claimedPCorrect: 0.9,
          capability: { domain: "code", tags: [] },
        },
      ],
      NOW + 10,
    );
    expect(explained).toContain("alice");
  });

  it("in-memory mode (dataDir: null) persists nothing and save() is a no-op", () => {
    const stack = openMarket({ dataDir: null, env: EMPTY_ENV });
    expect(stack.root).toBeNull();
    expect(() => stack.save()).not.toThrow();
    expect(marketStatus(stack).root).toBeNull();
  });
});

// ===========================================================================

describe("openMarket — a tampered ledger is REFUSED, not silently accepted", () => {
  it("a corrupted reputation.json is reported and the ledger is not loaded", async () => {
    const dataDir = tempDataDir();
    const ca = plantSigningKey(dataDir, 41);
    const first = openMarket({ dataDir, env: EMPTY_ENV });
    first.economy.register("alice", "agent", 1000);
    first.economy.postTask({ taskId: "task-alpha", domain: "code", reward: 100, postedAt: NOW });
    first.economy.award({ taskId: "task-alpha", participantId: "alice", price: 80, claimedPCorrect: 0.9, awardedAt: NOW });
    await first.economy.submitClaim({
      taskId: "task-alpha",
      participantId: "alice",
      outputText: OUTPUT,
      claimedPCorrect: 0.9,
      certificate: await ca.issue(payload()),
      traceJson: TRACE,
      submittedAt: NOW,
    });
    first.save();

    // Tamper with a recorded claim — the hash chain must catch it.
    const path = join(dataDir, "market", MARKET_REPUTATION_FILE);
    const tampered = readFileSync(path, "utf8").replace('"claimedP":0.9', '"claimedP":0.99');
    expect(tampered).not.toBe(readFileSync(path, "utf8"));
    writeFileSync(path, tampered);

    const second = openMarket({ dataDir, env: EMPTY_ENV });
    expect(second.chainOk).toBe(false);
    expect(second.loadErrors[MARKET_REPUTATION_FILE]).toContain("hash chain does not verify");
    // Refused, not loaded: the stack comes up on a clean ledger rather than a
    // tampered one, and the economy is likewise not restored from it.
    expect(second.reputation.entries().length).toBe(0);
    expect(marketStatus(second).chainOk).toBe(false);
  });

  it("a structurally invalid reputation.json is reported rather than swallowed", () => {
    const dataDir = tempDataDir();
    mkdirSync(join(dataDir, "market"), { recursive: true });
    writeFileSync(join(dataDir, "market", MARKET_REPUTATION_FILE), "{not json");
    const stack = openMarket({ dataDir, env: EMPTY_ENV });
    expect(stack.chainOk).toBe(false);
    expect(stack.loadErrors[MARKET_REPUTATION_FILE]).toBeDefined();
  });
});

// ===========================================================================

describe("marketStatus — the view every surface renders from", () => {
  it("reports an UNDEFINED skill score as scoreDefined:false, never as a bare 0", async () => {
    const dataDir = tempDataDir();
    const ca = plantSigningKey(dataDir, 51);
    const stack = openMarket({ dataDir, env: EMPTY_ENV });
    stack.economy.register("alice", "agent", 1000);
    stack.economy.postTask({ taskId: "task-alpha", domain: "code", reward: 100, postedAt: NOW });
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

    const view = marketStatus(stack);
    const alice = view.participants.find((p) => p.id === "alice");
    expect(alice).toBeDefined();
    expect(alice!.n).toBe(1);
    expect(alice!.scoreDefined).toBe(false);
    expect(view.settlements).toBe(1);
    expect(view.fabrications).toBe(0);
    expect(view.certificatesSpent).toBe(1);
    expect(view.chainOk).toBe(true);
  });

  it("an empty market reports zeroed totals and no participants (never a fabricated cohort)", () => {
    const view = marketStatus(openMarket({ dataDir: null, env: EMPTY_ENV }));
    expect(view.participants).toEqual([]);
    expect(view.settlements).toBe(0);
    expect(view.fabrications).toBe(0);
    expect(view.certificatesSpent).toBe(0);
    expect(view.totalTokens).toBe(view.treasury);
  });
});
