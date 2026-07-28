/**
 * market/wiring — the ONE assembly of the verified-work market that every
 * surface (CLI, desktop sidecar, TUI) shares.
 *
 * This is the central-integration counterpart of `../trust/wiring.ts`, and it
 * is deliberately built the same way and on the same data root, because the
 * two subsystems are two halves of one claim:
 *
 *   the trust gate ISSUES a certificate  ->  the market PRICES it.
 *
 *   - The trust stack's ed25519 identity (`<dataDir>/trust/signing-key`) is
 *     the market's default TRUSTED ISSUER. A certificate minted by
 *     `hades trust admit` in a terminal is therefore accepted verbatim by
 *     `hades market` and by the desktop `market.*` lane — same key, same
 *     epsilon, same tier vocabulary. Nothing is re-implemented and nothing is
 *     stubbed: if the key on disk changes, previously-issued certificates
 *     stop adjudicating, which is the correct and honest behaviour.
 *   - Everything durable lives under `<dataDir>/market/`:
 *       reputation.json  — the hash-chained `ReputationLedger`, re-verified
 *                          from its own bytes on every open.
 *       economy.json     — accounts, escrow, treasury, awards, settlements.
 *       replay.json      — the `ClaimAdjudicator` replay registry, so a
 *                          certificate spent in one process cannot be
 *                          re-spent by the next one.
 *
 * REAL-VS-MOCK POLICY. Every number any surface prints from this stack is
 * produced by the real modules: real ed25519 verification (`../styx/certificate`),
 * the real Brier settlement rule (`../styx/market`), the real Murphy-decomposed
 * reputation kernel (`./reputation`), the real escrow/slashing state machine
 * (`./economy`) and the real second-price trust-gated order book
 * (`./exchange`). The only simulated thing in this subsystem is
 * `./convergence`, which is explicitly labelled a MODEL wherever it is
 * surfaced and is never mixed into these live numbers.
 *
 * Loading is fail-soft PER FILE and never silent: a corrupt or tampered
 * artifact leaves that component empty and records the reason in
 * {@link MarketStack.loadErrors} for the surfaces to print. A ledger whose
 * hash chain does not verify is REFUSED (not loaded and not silently
 * accepted) — see {@link MarketStack.chainOk}.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CertificateAuthority } from "../styx/certificate";
import { TIER_ORDER, type TierId } from "../styx/tiers";
import { ClaimAdjudicator, defaultClaimPolicy, type ClaimPolicy } from "./claims";
import { Economy, defaultEconomyPolicy, type EconomyPolicy } from "./economy";
import { ReputationLedger, type ParticipantId, type Standing } from "./reputation";
import { WorkExchange, type ShrinkageOptions } from "./exchange";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const MARKET_REPUTATION_FILE = "reputation.json";
export const MARKET_ECONOMY_FILE = "economy.json";
export const MARKET_REPLAY_FILE = "replay.json";

/** Every market artifact lives under `<dataDir>/market`. */
export function marketRoot(dataDir: string): string {
  return join(dataDir, "market");
}

// ---------------------------------------------------------------------------
// Options / stack
// ---------------------------------------------------------------------------

export interface MarketStackOptions {
  /** `$HADES_DATA_DIR` or `.hades` when omitted. Pass `null` for a fully in-memory stack. */
  dataDir?: string | null;
  env?: Record<string, string | undefined>;
  /**
   * Additional hex ed25519 public keys accepted as certificate issuers, on
   * top of this install's own trust-gate identity. Anything unparseable is
   * dropped (and reported in {@link MarketStack.loadErrors}) rather than
   * silently widening the trusted set.
   */
  extraIssuers?: readonly string[];
  /** Overrides merged over {@link defaultClaimPolicy}'s output. */
  claimPolicy?: Partial<ClaimPolicy>;
  /** Overrides merged over {@link defaultEconomyPolicy}'s output. */
  economyPolicy?: Partial<EconomyPolicy>;
  shrinkage?: ShrinkageOptions;
  /** Injected for tests; defaults to the real `process.env`-driven trust key resolution. */
  trustedIssuerResolver?: (dataDir: string | null, env: Record<string, string | undefined>) => { publicKeyHex: string; source: string };
}

export interface MarketStack {
  reputation: ReputationLedger;
  adjudicator: ClaimAdjudicator;
  economy: Economy;
  exchange: WorkExchange;
  claimPolicy: ClaimPolicy;
  economyPolicy: EconomyPolicy;
  /** `<dataDir>/market`, or `null` for an in-memory stack. */
  root: string | null;
  /** The trust-gate public key this market accepts certificates from. */
  issuerPublicKeyHex: string;
  /** Where that key came from — `env` | `persisted` | `generated` | `ephemeral`. */
  issuerKeySource: string;
  /** Every accepted issuer, lowercased (the trust-gate key plus `extraIssuers`). */
  trustedIssuers: readonly string[];
  /** True iff the persisted reputation chain re-verified from its own bytes. */
  chainOk: boolean;
  /** Per-artifact reason a persisted file could not be loaded. Empty on a clean open. */
  loadErrors: Record<string, string>;
  /** Persist the whole stack back to {@link MarketStack.root}. No-op for an in-memory stack. */
  save(): void;
}

// ---------------------------------------------------------------------------
// Trusted-issuer resolution (shares `<dataDir>/trust/signing-key` with the gate)
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;

function normalizeIssuerKey(raw: string): string | null {
  const hex = raw.trim().toLowerCase();
  return HEX64.test(hex) ? hex : null;
}

/**
 * Resolve the public half of this install's trust-gate signing identity,
 * WITHOUT minting one: reading is enough for the market (it only ever
 * verifies), and minting a key as a side effect of `hades market status`
 * would be a surprising, persistent mutation. When no key exists yet the
 * source is reported as `absent` and the market simply trusts nobody until
 * the trust gate has been used at least once.
 */
export function resolveMarketIssuer(
  dataDir: string | null,
  env: Record<string, string | undefined>,
): { publicKeyHex: string; source: string } {
  const fromEnv = env.HADES_STYX_KEY;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    try {
      return { publicKeyHex: new CertificateAuthority(fromEnv.trim()).publicKeyHex(), source: "env" };
    } catch {
      /* fall through — an unusable env key is not a reason to trust nobody silently */
    }
  }
  if (dataDir !== null) {
    const keyPath = join(dataDir, "trust", "signing-key");
    if (existsSync(keyPath)) {
      try {
        const stored = readFileSync(keyPath, "utf8").trim();
        return { publicKeyHex: new CertificateAuthority(stored).publicKeyHex(), source: "persisted" };
      } catch {
        /* fall through */
      }
    }
  }
  return { publicKeyHex: "", source: "absent" };
}

// ---------------------------------------------------------------------------
// openMarket
// ---------------------------------------------------------------------------

function readIfPresent(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * Assemble the real market stack over `<dataDir>/market`, restoring every
 * durable artifact that is present and readable.
 */
export function openMarket(opts: MarketStackOptions = {}): MarketStack {
  const env = opts.env ?? process.env;
  const dataDir = opts.dataDir === undefined ? (env.HADES_DATA_DIR ?? ".hades") : opts.dataDir;
  const root = dataDir === null ? null : marketRoot(dataDir);
  const loadErrors: Record<string, string> = {};

  const resolver = opts.trustedIssuerResolver ?? resolveMarketIssuer;
  const issuer = resolver(dataDir, env);

  const trusted: string[] = [];
  if (issuer.publicKeyHex.length > 0) {
    const norm = normalizeIssuerKey(issuer.publicKeyHex);
    if (norm) trusted.push(norm);
  }
  for (const extra of opts.extraIssuers ?? []) {
    if (typeof extra !== "string") {
      loadErrors.issuers = "extraIssuers must be hex ed25519 public keys (a non-string entry was dropped)";
      continue;
    }
    const norm = normalizeIssuerKey(extra);
    if (norm === null) {
      loadErrors.issuers = `dropped an issuer that is not a 64-char hex ed25519 public key: ${JSON.stringify(extra.slice(0, 24))}`;
      continue;
    }
    if (!trusted.includes(norm)) trusted.push(norm);
  }

  const claimPolicy: ClaimPolicy = { ...defaultClaimPolicy(trusted), ...opts.claimPolicy, trustedIssuers: trusted };
  const economyPolicy: EconomyPolicy = { ...defaultEconomyPolicy(), ...opts.economyPolicy };

  // ---- reputation ledger ---------------------------------------------------
  let reputation = new ReputationLedger();
  let chainOk = true;
  if (root !== null) {
    try {
      const raw = readIfPresent(join(root, MARKET_REPUTATION_FILE));
      if (raw !== null) {
        const loaded = ReputationLedger.deserialize(raw);
        const verdict = loaded.verifyChain();
        if (!verdict.ok) {
          chainOk = false;
          loadErrors[MARKET_REPUTATION_FILE] = `hash chain does not verify (first break: participant "${verdict.brokenAt?.participantId}", seq ${verdict.brokenAt?.seq}) — the persisted reputation ledger was REFUSED, not loaded`;
        } else {
          reputation = loaded;
        }
      }
    } catch (err) {
      chainOk = false;
      loadErrors[MARKET_REPUTATION_FILE] = err instanceof Error ? err.message : String(err);
    }
  }

  // ---- adjudicator + replay registry --------------------------------------
  const adjudicator = new ClaimAdjudicator(claimPolicy);
  if (root !== null) {
    try {
      const raw = readIfPresent(join(root, MARKET_REPLAY_FILE));
      if (raw !== null) adjudicator.loadReplayRegistry(raw);
    } catch (err) {
      loadErrors[MARKET_REPLAY_FILE] = err instanceof Error ? err.message : String(err);
    }
  }

  // ---- economy -------------------------------------------------------------
  let economy: Economy | null = null;
  if (root !== null && chainOk) {
    try {
      const raw = readIfPresent(join(root, MARKET_ECONOMY_FILE));
      if (raw !== null) economy = Economy.deserialize(raw, { adjudicator });
    } catch (err) {
      loadErrors[MARKET_ECONOMY_FILE] = err instanceof Error ? err.message : String(err);
    }
  }
  if (economy === null) {
    economy = new Economy({ adjudicator, reputation, policy: economyPolicy });
  } else {
    // A restored economy carries its own ledger (serialized inside it); that
    // is the authoritative one, so the exchange must read the SAME object.
    reputation = economy.reputation();
  }

  const exchange = new WorkExchange({
    reputation,
    standingOf: (id: ParticipantId): Standing => {
      try {
        return economy!.standing(id);
      } catch {
        return "active";
      }
    },
    shrinkage: opts.shrinkage,
  });

  const stack: MarketStack = {
    reputation,
    adjudicator,
    economy,
    exchange,
    claimPolicy,
    economyPolicy,
    root,
    issuerPublicKeyHex: issuer.publicKeyHex,
    issuerKeySource: issuer.source,
    trustedIssuers: trusted,
    chainOk,
    loadErrors,
    save(): void {
      if (root === null) return;
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, MARKET_REPUTATION_FILE), stack.reputation.serialize(), { mode: 0o600 });
      writeFileSync(join(root, MARKET_ECONOMY_FILE), stack.economy.serialize(), { mode: 0o600 });
      writeFileSync(join(root, MARKET_REPLAY_FILE), stack.adjudicator.serializeReplayRegistry(), { mode: 0o600 });
    },
  };
  return stack;
}

// ---------------------------------------------------------------------------
// Reporting views — the shape every surface renders from
// ---------------------------------------------------------------------------

export interface MarketParticipantView {
  id: ParticipantId;
  kind: string;
  balance: number;
  escrowed: number;
  standing: Standing;
  settledN: number;
  fabricatedN: number;
  /** null when the participant has no recorded reputation events at all. */
  score: number | null;
  /** null when the participant's realized outcomes carry no variance (skill score undefined). */
  scoreDefined: boolean;
  n: number;
  passRate: number | null;
  brier: number | null;
  decayedBrier: number | null;
  calibrationGap: number | null;
}

export interface MarketStatusView {
  root: string | null;
  issuerPublicKeyHex: string;
  issuerKeySource: string;
  trustedIssuers: string[];
  acceptedTiers: string[];
  maxEpsilon: number;
  requireTraceBinding: boolean;
  treasury: number;
  totalTokens: number;
  participants: MarketParticipantView[];
  openAwards: number;
  settlements: number;
  fabrications: number;
  certificatesSpent: number;
  chainOk: boolean;
  loadErrors: Array<{ artifact: string; message: string }>;
}

const UNCERTAINTY_EPS = 1e-9;

/** Build the whole status view from REAL stack state — no derived guesses. */
export function marketStatus(stack: MarketStack): MarketStatusView {
  const participants: MarketParticipantView[] = stack.economy.accounts().map((a) => {
    const s = stack.reputation.state(a.id);
    return {
      id: a.id,
      kind: a.kind,
      balance: a.balance,
      escrowed: a.escrowed,
      standing: a.standing,
      settledN: a.settledN,
      fabricatedN: a.fabricatedN,
      score: s ? s.score : null,
      scoreDefined: s ? s.fabricatedN > 0 || s.decomposition.uncertainty > UNCERTAINTY_EPS : false,
      n: s ? s.n : 0,
      passRate: s ? s.passRate : null,
      brier: s ? s.brier : null,
      decayedBrier: s ? s.decayedBrier : null,
      calibrationGap: s ? s.calibrationGap : null,
    };
  });

  const history = stack.economy.history();
  return {
    root: stack.root,
    issuerPublicKeyHex: stack.issuerPublicKeyHex,
    issuerKeySource: stack.issuerKeySource,
    trustedIssuers: [...stack.trustedIssuers],
    acceptedTiers: [...stack.claimPolicy.acceptedTiers],
    maxEpsilon: stack.claimPolicy.maxEpsilon,
    requireTraceBinding: stack.claimPolicy.requireTraceBinding,
    treasury: stack.economy.treasury(),
    totalTokens: stack.economy.totalTokens(),
    participants,
    openAwards: stack.economy.openAwards().length,
    settlements: history.length,
    fabrications: history.filter((r) => r.status === "fabricated").length,
    certificatesSpent: stack.adjudicator.seenCertificates(),
    chainOk: stack.chainOk,
    loadErrors: Object.entries(stack.loadErrors).map(([artifact, message]) => ({ artifact, message })),
  };
}

/** Every tier this build understands, weakest last — the vocabulary a surface should offer. */
export function marketTiers(): readonly TierId[] {
  return TIER_ORDER;
}
