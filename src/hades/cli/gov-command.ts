/**
 * `hades gov <group> <sub>` — the terminal operator surface over the
 * governance stack: identity, capability tokens, the tamper-evident audit
 * chain, signed policy, and the real air-gap.
 *
 *   hades gov identity show|new|rotate|revoke|verify
 *   hades gov token mint|attenuate|inspect|check
 *   hades gov audit tail|verify|checkpoint|prove|export
 *   hades gov policy show|init|lint|set|test
 *   hades gov airgap status|probe|run
 *   hades gov doctor
 *   hades gov help
 *
 * Terminal-free (returns `{ code, lines }`) so it unit-tests without a shell
 * or real stdout, matching the rest of `src/hades/cli/*`. Plain aligned
 * ASCII only — this product's front end is the terminal, never a browser.
 *
 * Every number and status printed here is measured by REAL code on this
 * machine: `identity` reads a real ed25519 keypair and a real self-signed
 * document, `token` mints/attenuates/checks real macaroon-style capability
 * chains, `audit` reads/verifies the real hash-chained + Merkle-checkpointed
 * log from its own bytes, `policy` loads a real signed-and-verified policy
 * bundle (fail-closed, never a fabricated pass), and `airgap` probes/engages
 * the REAL egress seams of this process. Nothing here is a stand-in.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CliResult } from "./cli";
import { GovKeystore, govRoot } from "../gov/keystore";
import {
  GovIdentity,
  agentIdFromPublicKey,
  govCanonicalize,
  verifyGovSignature,
  verifyRotationHistory,
} from "../gov/identity";
import {
  CapabilityIssuer,
  CapabilityEnforcer,
  type CapabilityGrant,
  type CapabilityCaveat,
  type CapabilityRequest,
  type CapabilityDecision,
  type GovCapabilityToken,
} from "../gov/capability";
import { DurableReplayGuard } from "../gov/replay-guard";
import { GovAuditChain, type AuditOutcome } from "../gov/audit-chain";
import { inclusionProof, verifyInclusion, merkleRoot } from "../gov/audit-proof";
import { PolicyStore } from "../gov/policy-store";
import { parsePolicyDocument, DEFAULT_GOV_POLICY, type PolicyRequest } from "../gov/policy";
import { probeAirgap, activeAirgapSessions, AirgapViolationError } from "../gov/airgap";
import { runAirgappedTask, formatAirgapRunReport, type AirgappedTaskContext } from "../gov/airgap-run";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface GovStack {
  keystore: GovKeystore;
  issuer: CapabilityIssuer;
  enforcer: CapabilityEnforcer;
  chain: GovAuditChain;
  policy: PolicyStore;
  dataDir: string;
}

export interface GovCommandDeps {
  root: () => GovStack;
  readFile?: (p: string) => string;
  fileExists?: (p: string) => boolean;
  /** Used only by `gov audit export --out <file>`; defaults to a real
   *  atomic-ish `writeFileSync`. Injectable so the export path is testable
   *  without writing to the developer's filesystem. */
  writeFile?: (p: string, contents: string) => void;
  now?: () => number;
}

/**
 * Lazy, cached, real. Constructing this object never mints a key, opens the
 * audit chain, or touches `<dataDir>/gov` — that all happens the first time
 * `deps.root()` is actually CALLED by a subcommand handler, and is cached
 * for the rest of the process after that (same discipline as
 * `defaultTrustDeps`/`openTrustStack`).
 *
 * The stack's members are themselves lazy accessors, not eagerly-built
 * values, and this is load-bearing rather than mere hygiene: building the
 * issuer/enforcer/policy stack requires the identity's public key, so an
 * eager `root()` would call `keystore.load()` — and therefore GENERATE an
 * identity on a virgin dataDir — before the handler that was asked to do it
 * ever ran. `hades gov identity new` would then find the key already on
 * disk and be unable to honestly report that it created one. With lazy
 * members, whichever handler first touches the identity is the one that
 * genuinely resolves it, and `load()`'s `source` ("generated" vs
 * "persisted" vs "env") is the truth about what happened. Each member is
 * built at most once per process and shared thereafter.
 */
export function defaultGovDeps(): GovCommandDeps {
  let cached: GovStack | undefined;
  return {
    root: () => {
      if (!cached) {
        const env = process.env;
        const dataDir = env.HADES_DATA_DIR ?? ".hades";
        const dir = govRoot(dataDir);
        const keystore = GovKeystore.open({ dir, env });

        let issuer: CapabilityIssuer | undefined;
        let enforcer: CapabilityEnforcer | undefined;
        let chain: GovAuditChain | undefined;
        let policy: PolicyStore | undefined;

        cached = {
          keystore,
          dataDir,
          get issuer(): CapabilityIssuer {
            if (!issuer) issuer = new CapabilityIssuer(keystore.load().identity);
            return issuer;
          },
          get enforcer(): CapabilityEnforcer {
            // A DURABLE replay guard, not an in-memory one, and not omitted.
            // `CapabilityEnforcer` skips the `max-uses` check entirely when
            // no UseCounter is supplied and skips nonce replay entirely when
            // no ReplayGuard is — so an enforcer built without them would
            // wave through exactly the caveats an operator reached for
            // `max-uses`/`nonce` to get. The CLI is a fresh process per
            // invocation, so the state has to survive on disk or those
            // caveats mean nothing across two `hades gov token check` runs.
            if (!enforcer) {
              const guard = DurableReplayGuard.open({ file: join(dir, "replay.json") });
              enforcer = new CapabilityEnforcer({
                trustedIssuerPublicKeys: [keystore.load().identity.publicKeyHex()],
                replayGuard: guard,
                useCounter: guard,
              });
            }
            return enforcer;
          },
          get chain(): GovAuditChain {
            if (!chain) chain = GovAuditChain.open({ dir });
            return chain;
          },
          get policy(): PolicyStore {
            if (!policy) policy = PolicyStore.open({ dir: join(dir, "policy"), trustedSignerPublicKeys: [keystore.load().identity.publicKeyHex()] });
            return policy;
          },
        };
      }
      return cached;
    },
  };
}

// ---------------------------------------------------------------------------
// Small local helpers (own copies, matching every other src/hades/cli/*
// command — see trust-command.ts's note)
// ---------------------------------------------------------------------------

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/**
 * Strips ASCII control characters (0x00-0x1F, 0x7F) from any string that did
 * not originate in this file before it is echoed into an output line — same
 * discipline as `sanitize` in backends-command.ts, and it matters more here
 * than anywhere else in the CLI: an audit entry's `actor`/`action`/
 * `resource`, a token's grant patterns, a policy rule id and every deny
 * reason are all attacker-influenceable strings, and this command's whole
 * job is to let an operator TRUST what it prints. An unfiltered ESC
 * sequence in an actor name could otherwise repaint the screen and forge a
 * "RESULT: valid" / "VERIFIED" line. `--json` output is not passed through
 * this — JSON.stringify already escapes control characters, and mangling
 * bytes inside a machine-readable dump would be its own lie.
 */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1F\x7F]/g, "");
}

/** `sanitize` for a value that may not be a string (e.g. an optional field). */
function s(text: string | undefined): string {
  return text === undefined ? "" : sanitize(text);
}

function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const out = [headers.map((h, i) => pad(h, widths[i])).join("  ")];
  out.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) out.push(row.map((c, i) => pad(c ?? "", widths[i])).join("  "));
  return out;
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function flagValues(args: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) out.push(args[i + 1]);
  }
  return out;
}

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function numberFlag(args: readonly string[], name: string): { value?: number; error?: string } {
  const raw = flagValue(args, name);
  if (raw === undefined) return {};
  const value = Number(raw);
  if (!Number.isFinite(value)) return { error: `${name} must be a finite number; got ${JSON.stringify(raw)}` };
  return { value };
}

function jsonResult(value: unknown, code = 0): CliResult {
  return { code, lines: JSON.stringify(value, null, 2).split("\n") };
}

function fail(prefix: string, message: string): CliResult {
  return { code: 1, lines: [`gov ${prefix}: ${sanitize(message)}`] };
}

function unknown(group: string, sub: string | undefined, usage: readonly string[]): CliResult {
  return { code: 1, lines: [`Unknown gov ${group} command: ${sub === undefined ? "(none)" : sanitize(sub)}`, "", ...usage] };
}

function parseArgsMap(args: readonly string[], name: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const raw of flagValues(args, name)) {
    const eq = raw.indexOf("=");
    if (eq < 0) continue;
    out[raw.slice(0, eq)] = raw.slice(eq + 1);
  }
  return out;
}

function readerFor(deps: GovCommandDeps): { exists: (p: string) => boolean; read: (p: string) => string } {
  return {
    exists: deps.fileExists ?? existsSync,
    read: deps.readFile ?? ((p: string) => readFileSync(p, "utf8")),
  };
}

// ---------------------------------------------------------------------------
// Usage blocks
// ---------------------------------------------------------------------------

const IDENTITY_USAGE: string[] = [
  "Usage: hades gov identity <command>",
  "",
  "Commands:",
  "  show [--json]                        Show this agent's real ed25519 identity",
  "  new [--json]                         Ensure an identity exists (creates one on",
  "                                        a virgin dataDir; never silently replaces one)",
  "  rotate [--reason R] [--json]         Rotate to a fresh key with a signed continuity record",
  "  revoke --key <hex> --reason R [--json]   Add a public key to the durable revocation list",
  "  verify [--json]                      Re-verify the self-signed doc + rotation history",
];

const TOKEN_USAGE: string[] = [
  "Usage: hades gov token <command>",
  "",
  "Commands:",
  '  mint --subject S [--grant "resource=action1,action2" ...]',
  "       [--audience A] [--ttl MS] [--max-uses N] [--path-under P]",
  "       [--allow-host H ...] [--airgap-only] [--json]",
  "                                                Mint a real capability token",
  "  attenuate --token <file.json> --holder-key <hex>",
  '            [--grant "resource=action1,action2" ...] [--ttl MS]',
  "            [--max-uses N] [--path-under P] [--allow-host H ...] [--airgap-only] [--json]",
  "                                                Narrow a token, signed by its holder",
  "  inspect --token <file.json> [--json]         Decode + signature-check a token file",
  "  check --token <file.json> --subject S --action A --resource R",
  "        [--at MS] [--airgapped] [--nonce N] [--arg k=v ...] [--json]",
  "                                                Authorize one REAL request (exit 2 = DENY).",
  "                                                This is an authorization, not a preview: an",
  "                                                allowed request consumes a `max-uses` use and",
  "                                                burns --nonce durably, so replay is caught",
  "                                                across separate CLI invocations.",
];

const AUDIT_USAGE: string[] = [
  "Usage: hades gov audit <command>",
  "",
  "Commands:",
  "  tail [--n N] [--actor A] [--action A] [--outcome O] [--json]  Last N entries",
  "  verify [--json]                       Re-verify the chain from its own bytes",
  "  checkpoint [--json]                   Sign + persist a Merkle checkpoint over the chain",
  "  prove --seq N [--json]                Emit + self-check an inclusion proof for entry N",
  "  export [--out <file>] [--json]        Dump every entry (--out writes JSONL to a",
  "                                        real file; without it, prints to stdout)",
];

const POLICY_USAGE: string[] = [
  "Usage: hades gov policy <command>",
  "",
  "Commands:",
  "  show [--json]                         Show the current signed policy bundle status",
  "  init [--force] [--json]               Sign + persist DEFAULT_GOV_POLICY (refuses to",
  "                                        overwrite an existing policy without --force)",
  "  lint [--json]                         Lint the loaded policy for reachability issues",
  "  set --file <doc.json> [--json]        Sign + persist a new policy document (version must increase)",
  "  test --subject S --action A --resource R [--at MS] [--airgapped]",
  "       [--role R ...] [--capability C ...] [--risk-remaining N] [--arg k=v ...] [--json]",
];

const AIRGAP_USAGE: string[] = [
  "Usage: hades gov airgap <command>",
  "",
  "Commands:",
  "  status [--json]      Report the default air-gap policy (this CLI process is stateless —",
  "                        nothing stays engaged between invocations; see `probe`/`run`)",
  "  probe [--json]        Dry-run: report which real egress seams CAN be neutralized",
  "  run [--json] [--allow-loopback] [--allow-host H ...] [--task-id ID]",
  "                        Engage the REAL air-gap and run a self-check task under it,",
  "                        producing a real verified certificate + audit trail",
];

const GOV_USAGE: string[] = [
  "Usage: hades gov <group> <command>",
  "",
  ...IDENTITY_USAGE.map((l) => (l.startsWith("Usage") ? "identity:" : l)),
  "",
  ...TOKEN_USAGE.map((l) => (l.startsWith("Usage") ? "token:" : l)),
  "",
  ...AUDIT_USAGE.map((l) => (l.startsWith("Usage") ? "audit:" : l)),
  "",
  ...POLICY_USAGE.map((l) => (l.startsWith("Usage") ? "policy:" : l)),
  "",
  ...AIRGAP_USAGE.map((l) => (l.startsWith("Usage") ? "airgap:" : l)),
  "",
  "doctor [--json]          End-to-end wiring self-check (exit 0 iff healthy)",
  "help                     Show this help",
];

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function runGovCommand(argv: readonly string[], deps: GovCommandDeps): Promise<CliResult> {
  const [group, ...rest] = argv;
  switch (group) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return { code: 0, lines: GOV_USAGE };
    case "identity":
      return runIdentityCommand(rest, deps);
    case "token":
      return runTokenCommand(rest, deps);
    case "audit":
      return runAuditCommand(rest, deps);
    case "policy":
      return runPolicyCommand(rest, deps);
    case "airgap":
      return runAirgapCommand(rest, deps);
    case "doctor":
      return doctor(rest, deps);
    default:
      return { code: 1, lines: [`Unknown gov command: ${sanitize(group)}`, "", ...GOV_USAGE] };
  }
}

// ---------------------------------------------------------------------------
// gov identity
// ---------------------------------------------------------------------------

function identityLines(loaded: ReturnType<GovKeystore["load"]>): string[] {
  return [
    `agentId         ${sanitize(loaded.identity.agentId())}`,
    `publicKey       ${sanitize(loaded.identity.publicKeyHex())}`,
    `source          ${sanitize(loaded.source)}`,
    `roles           ${loaded.doc.doc.roles.map(sanitize).join(", ") || "(none)"}`,
    `rotations       ${loaded.rotations.length}`,
    `issuedAt        ${loaded.doc.doc.issuedAt}`,
  ];
}

async function runIdentityCommand(args: readonly string[], deps: GovCommandDeps): Promise<CliResult> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
      return { code: 0, lines: IDENTITY_USAGE };
    case "show": {
      const stack = deps.root();
      const loaded = stack.keystore.load();
      if (hasFlag(rest, "--json")) {
        return jsonResult({
          agentId: loaded.identity.agentId(),
          publicKey: loaded.identity.publicKeyHex(),
          source: loaded.source,
          roles: loaded.doc.doc.roles,
          rotations: loaded.rotations.length,
          issuedAt: loaded.doc.doc.issuedAt,
        });
      }
      return { code: 0, lines: ["GOVERNANCE IDENTITY", "=".repeat(72), ...identityLines(loaded)] };
    }
    case "new": {
      const stack = deps.root();
      // The keystore's own `source` is the authority on what just happened —
      // "generated" only ever comes back from a load() that actually minted
      // and persisted a new keypair, so this reports creation iff creation
      // occurred and never overwrites an identity that was already there.
      const loaded = stack.keystore.load();
      const created = loaded.source === "generated";
      if (hasFlag(rest, "--json")) {
        return jsonResult({ created, source: loaded.source, agentId: loaded.identity.agentId(), publicKey: loaded.identity.publicKeyHex() });
      }
      const headline = created
        ? "identity CREATED — a fresh ed25519 keypair was generated and persisted"
        : loaded.source === "env"
          ? "identity supplied by $HADES_GOV_KEY — nothing was created and nothing was written to disk"
          : "identity already existed — left untouched (this command never replaces a key; use `gov identity rotate`)";
      return { code: 0, lines: [headline, ...identityLines(loaded)] };
    }
    case "rotate": {
      const stack = deps.root();
      const reason = flagValue(rest, "--reason") ?? "operator-requested rotation";
      let loaded: ReturnType<GovKeystore["load"]>;
      try {
        loaded = stack.keystore.rotate(reason);
      } catch (err) {
        return fail("identity rotate", err instanceof Error ? err.message : String(err));
      }
      if (hasFlag(rest, "--json")) {
        return jsonResult({ rotated: true, reason, agentId: loaded.identity.agentId(), publicKey: loaded.identity.publicKeyHex(), rotations: loaded.rotations.length });
      }
      return { code: 0, lines: [`identity rotated (reason: ${sanitize(reason)})`, ...identityLines(loaded)] };
    }
    case "revoke": {
      const stack = deps.root();
      const key = flagValue(rest, "--key");
      const reason = flagValue(rest, "--reason");
      if (key === undefined) return fail("identity revoke", "--key <hex> is required");
      if (reason === undefined) return fail("identity revoke", "--reason <text> is required");
      try {
        stack.keystore.revoke(key, reason);
      } catch (err) {
        return fail("identity revoke", err instanceof Error ? err.message : String(err));
      }
      if (hasFlag(rest, "--json")) return jsonResult({ revoked: key, reason });
      return { code: 0, lines: [`revoked public key ${sanitize(key)} (reason: ${sanitize(reason)})`] };
    }
    case "verify": {
      const stack = deps.root();
      const loaded = stack.keystore.load();
      const canonical = govCanonicalize(loaded.doc.doc);
      const docSigOk = verifyGovSignature(loaded.doc.signerPublicKey, canonical, loaded.doc.signature);
      const genesisPublicKey = loaded.rotations.length > 0 ? loaded.rotations[0].record.oldPublicKey : loaded.identity.publicKeyHex();
      const rotationCheck = verifyRotationHistory(loaded.rotations, { genesisPublicKey });
      const currentMatches = rotationCheck.currentPublicKey === loaded.identity.publicKeyHex();
      const ok = docSigOk && rotationCheck.ok && currentMatches;
      if (hasFlag(rest, "--json")) {
        return jsonResult({ ok, docSignatureValid: docSigOk, rotationHistoryValid: rotationCheck.ok, currentKeyMatches: currentMatches, failures: rotationCheck.failures }, ok ? 0 : 1);
      }
      const lines = ["IDENTITY VERIFICATION", "=".repeat(72)];
      lines.push(`self-signed doc signature   ${docSigOk ? "VALID" : "INVALID"}`);
      lines.push(`rotation history            ${rotationCheck.ok ? "VALID" : "INVALID"} (${loaded.rotations.length} rotation(s))`);
      lines.push(`current key matches history ${currentMatches ? "YES" : "NO"}`);
      if (!rotationCheck.ok) {
        for (const f of rotationCheck.failures) lines.push(`  [${sanitize(f.code)}] ${sanitize(f.detail)}`);
      }
      lines.push("");
      lines.push(ok ? "RESULT: valid" : "RESULT: INVALID");
      return { code: ok ? 0 : 1, lines };
    }
    default:
      return unknown("identity", sub, IDENTITY_USAGE);
  }
}

// ---------------------------------------------------------------------------
// gov token
// ---------------------------------------------------------------------------

function parseGrant(raw: string): { grant?: CapabilityGrant; error?: string } {
  const eq = raw.indexOf("=");
  if (eq < 0) return { error: `--grant "${raw}" must be of the form <resource>=<action1,action2,...>` };
  const resource = raw.slice(0, eq).trim();
  const actions = raw
    .slice(eq + 1)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (resource.length === 0 || actions.length === 0) {
    return { error: `--grant "${raw}" must have a non-empty resource and at least one action` };
  }
  return { grant: { resource, actions } };
}

/**
 * Build the caveat list from flags. These are REAL caveats the enforcer
 * genuinely evaluates — `max-uses` and the nonce guard are only meaningful
 * because `defaultGovDeps()` wires a durable UseCounter/ReplayGuard, so a
 * limit set here survives the process that set it.
 */
function parseCaveats(args: readonly string[]): { caveats?: CapabilityCaveat[]; error?: string } {
  const caveats: CapabilityCaveat[] = [];
  const maxUses = numberFlag(args, "--max-uses");
  if (maxUses.error) return { error: maxUses.error };
  if (maxUses.value !== undefined) {
    if (!Number.isInteger(maxUses.value) || maxUses.value < 1) {
      return { error: `--max-uses must be an integer >= 1; got ${JSON.stringify(flagValue(args, "--max-uses"))}` };
    }
    caveats.push({ kind: "max-uses", uses: maxUses.value });
  }
  const pathUnder = flagValue(args, "--path-under");
  if (pathUnder !== undefined) caveats.push({ kind: "path-under", root: pathUnder });
  const hosts = flagValues(args, "--allow-host");
  if (hosts.length > 0) caveats.push({ kind: "host-allowlist", hosts });
  if (hasFlag(args, "--airgap-only")) caveats.push({ kind: "airgap-only", required: true });
  return { caveats };
}

function parseGrants(args: readonly string[]): { grants?: CapabilityGrant[]; error?: string } {
  const grants: CapabilityGrant[] = [];
  for (const raw of flagValues(args, "--grant")) {
    const parsed = parseGrant(raw);
    if (parsed.error) return { error: parsed.error };
    grants.push(parsed.grant!);
  }
  return { grants };
}

function isLikelyToken(v: unknown): v is GovCapabilityToken {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.schema === "hades.gov.capability.v1" &&
    typeof o.tokenId === "string" &&
    typeof o.signature === "string" &&
    typeof o.signerPublicKey === "string" &&
    typeof o.issuerPublicKey === "string" &&
    typeof o.issuer === "string" &&
    typeof o.subject === "string" &&
    Array.isArray(o.grants) &&
    Array.isArray(o.caveats)
  );
}

function readToken(deps: GovCommandDeps, path: string): { token?: GovCapabilityToken; error?: string } {
  const { exists, read } = readerFor(deps);
  if (!exists(path)) return { error: `token file not found: ${path}` };
  let raw: string;
  try {
    raw = read(path);
  } catch (err) {
    return { error: `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isLikelyToken(parsed)) return { error: `${path} does not have the shape of a GovCapabilityToken` };
  return { token: parsed };
}

/** Re-derives the exact signature+issuer-identity check `CapabilityEnforcer` performs internally — this module never re-implements the enforcement chain, only this one self-contained structural check for `inspect`. */
function tokenSignatureValid(t: GovCapabilityToken): boolean {
  if (t.issuerPublicKey !== t.signerPublicKey) return false;
  if (t.issuer !== agentIdFromPublicKey(t.issuerPublicKey)) return false;
  const { signature, ...body } = t;
  return verifyGovSignature(t.signerPublicKey, govCanonicalize(body), signature);
}

async function runTokenCommand(args: readonly string[], deps: GovCommandDeps): Promise<CliResult> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
      return { code: 0, lines: TOKEN_USAGE };
    case "mint": {
      const stack = deps.root();
      const subject = flagValue(rest, "--subject");
      if (subject === undefined) return fail("token mint", "--subject is required");
      const parsedGrants = parseGrants(rest);
      if (parsedGrants.error) return fail("token mint", parsedGrants.error);
      const ttl = numberFlag(rest, "--ttl");
      if (ttl.error) return fail("token mint", ttl.error);
      const audience = flagValue(rest, "--audience");
      const parsedCaveats = parseCaveats(rest);
      if (parsedCaveats.error) return fail("token mint", parsedCaveats.error);
      let token: GovCapabilityToken;
      try {
        token = stack.issuer.mint({
          subject,
          grants: parsedGrants.grants ?? [],
          ...(parsedCaveats.caveats && parsedCaveats.caveats.length > 0 ? { caveats: parsedCaveats.caveats } : {}),
          ...(audience !== undefined ? { audience } : {}),
          ...(ttl.value !== undefined ? { ttlMs: ttl.value } : {}),
        });
      } catch (err) {
        return fail("token mint", err instanceof Error ? err.message : String(err));
      }
      if (hasFlag(rest, "--json")) return jsonResult(token);
      return { code: 0, lines: ["MINTED TOKEN", "=".repeat(72), JSON.stringify(token, null, 2)] };
    }
    case "attenuate": {
      const stack = deps.root();
      const tokenFile = flagValue(rest, "--token");
      const holderKey = flagValue(rest, "--holder-key");
      if (tokenFile === undefined) return fail("token attenuate", "--token <file.json> is required");
      if (holderKey === undefined) return fail("token attenuate", "--holder-key <hex> is required");
      const loadedToken = readToken(deps, tokenFile);
      if (loadedToken.error) return fail("token attenuate", loadedToken.error);
      let holder: GovIdentity;
      try {
        holder = GovIdentity.fromPrivateKey(holderKey);
      } catch (err) {
        return fail("token attenuate", `--holder-key is invalid: ${err instanceof Error ? err.message : String(err)}`);
      }
      const parsedGrants = parseGrants(rest);
      if (parsedGrants.error) return fail("token attenuate", parsedGrants.error);
      const ttl = numberFlag(rest, "--ttl");
      if (ttl.error) return fail("token attenuate", ttl.error);
      // Attenuation may only ever NARROW, so new caveats are ADDED to the
      // parent's (never replacing them) — dropping a parent caveat is one of
      // the widening dimensions `isAttenuation` rejects outright.
      const attenCaveats = parseCaveats(rest);
      if (attenCaveats.error) return fail("token attenuate", attenCaveats.error);
      let child: GovCapabilityToken;
      try {
        child = stack.issuer.attenuate(loadedToken.token!, holder, {
          ...(parsedGrants.grants && parsedGrants.grants.length > 0 ? { grants: parsedGrants.grants } : {}),
          ...(attenCaveats.caveats && attenCaveats.caveats.length > 0 ? { caveats: [...loadedToken.token!.caveats, ...attenCaveats.caveats] } : {}),
          ...(ttl.value !== undefined ? { ttlMs: ttl.value } : {}),
        });
      } catch (err) {
        return fail("token attenuate", err instanceof Error ? err.message : String(err));
      }
      if (hasFlag(rest, "--json")) return jsonResult(child);
      return { code: 0, lines: ["ATTENUATED TOKEN", "=".repeat(72), JSON.stringify(child, null, 2)] };
    }
    case "inspect": {
      const tokenFile = flagValue(rest, "--token");
      if (tokenFile === undefined) return fail("token inspect", "--token <file.json> is required");
      const loadedToken = readToken(deps, tokenFile);
      if (loadedToken.error) return fail("token inspect", loadedToken.error);
      const t = loadedToken.token!;
      const sigValid = tokenSignatureValid(t);
      if (hasFlag(rest, "--json")) return jsonResult({ token: t, signatureValid: sigValid }, sigValid ? 0 : 1);
      const lines = ["TOKEN", "=".repeat(72)];
      lines.push(`tokenId          ${sanitize(t.tokenId)}`);
      lines.push(`issuer           ${sanitize(t.issuer)}`);
      lines.push(`subject          ${sanitize(t.subject)}`);
      lines.push(`depth            ${t.depth}`);
      lines.push(`issuedAt         ${t.issuedAt}`);
      lines.push(`expiresAt        ${t.expiresAt}`);
      lines.push(`signature        ${sigValid ? "VALID" : "INVALID"}`);
      lines.push("");
      lines.push("GRANTS");
      lines.push(...table(["RESOURCE", "ACTIONS"], t.grants.map((g) => [sanitize(g.resource), g.actions.map(sanitize).join(",")])));
      if (t.caveats.length > 0) {
        lines.push("");
        lines.push("CAVEATS");
        for (const c of t.caveats) lines.push(`  ${JSON.stringify(c)}`); // JSON.stringify escapes control chars
      }
      return { code: sigValid ? 0 : 1, lines };
    }
    case "check": {
      const stack = deps.root();
      const tokenFile = flagValue(rest, "--token");
      const subject = flagValue(rest, "--subject");
      const action = flagValue(rest, "--action");
      const resource = flagValue(rest, "--resource");
      if (tokenFile === undefined) return fail("token check", "--token <file.json> is required");
      if (subject === undefined) return fail("token check", "--subject is required");
      if (action === undefined) return fail("token check", "--action is required");
      if (resource === undefined) return fail("token check", "--resource is required");
      const loadedToken = readToken(deps, tokenFile);
      if (loadedToken.error) return fail("token check", loadedToken.error);
      const at = numberFlag(rest, "--at");
      if (at.error) return fail("token check", at.error);
      const req: CapabilityRequest = {
        subject,
        action,
        resource,
        at: at.value ?? deps.now?.() ?? Date.now(),
        airgapped: hasFlag(rest, "--airgapped"),
        ...(flagValue(rest, "--nonce") !== undefined ? { nonce: flagValue(rest, "--nonce")! } : {}),
        args: parseArgsMap(rest, "--arg"),
      };
      const decision: CapabilityDecision = stack.enforcer.authorize([loadedToken.token!], req);
      if (hasFlag(rest, "--json")) return jsonResult(decision, decision.allow ? 0 : 2);
      const lines = ["AUTHORIZATION CHECK", "=".repeat(72)];
      lines.push(`decision   ${decision.allow ? "ALLOW" : "DENY"}`);
      lines.push(`code       ${sanitize(decision.code)}`);
      lines.push(`reason     ${sanitize(decision.reason)}`);
      return { code: decision.allow ? 0 : 2, lines };
    }
    default:
      return unknown("token", sub, TOKEN_USAGE);
  }
}

// ---------------------------------------------------------------------------
// gov audit
// ---------------------------------------------------------------------------

function isAuditOutcomeFlag(v: string | undefined): v is AuditOutcome {
  return v !== undefined && (["allow", "deny", "abstain", "info", "error"] as const).includes(v as AuditOutcome);
}

async function runAuditCommand(args: readonly string[], deps: GovCommandDeps): Promise<CliResult> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
      return { code: 0, lines: AUDIT_USAGE };
    case "tail": {
      const stack = deps.root();
      const nFlag = numberFlag(rest, "--n");
      if (nFlag.error) return fail("audit tail", nFlag.error);
      const n = nFlag.value !== undefined ? Math.max(0, Math.floor(nFlag.value)) : 20;
      const actor = flagValue(rest, "--actor");
      const action = flagValue(rest, "--action");
      const outcomeRaw = flagValue(rest, "--outcome");
      if (outcomeRaw !== undefined && !isAuditOutcomeFlag(outcomeRaw)) {
        return fail("audit tail", `--outcome must be one of allow|deny|abstain|info|error; got "${outcomeRaw}"`);
      }
      const all = stack.chain.entries({
        ...(actor !== undefined ? { actor } : {}),
        ...(action !== undefined ? { action } : {}),
        ...(outcomeRaw !== undefined ? { outcome: outcomeRaw as AuditOutcome } : {}),
      });
      const tail = n > 0 ? all.slice(-n) : all;
      if (hasFlag(rest, "--json")) return jsonResult(tail);
      if (tail.length === 0) return { code: 0, lines: ["(no matching audit entries)"] };
      return {
        code: 0,
        lines: [
          `AUDIT TAIL (${tail.length} of ${all.length} matching)`,
          "",
          ...table(
            ["SEQ", "AT", "ACTOR", "ACTION", "RESOURCE", "OUTCOME", "CODE"],
            tail.map((e) => [String(e.seq), String(e.at), sanitize(e.actor), sanitize(e.action), sanitize(e.resource), e.outcome, s(e.code)]),
          ),
        ],
      };
    }
    case "verify": {
      const stack = deps.root();
      const v = stack.chain.verify();
      if (hasFlag(rest, "--json")) return jsonResult(v, v.ok ? 0 : 1);
      const lines = ["AUDIT CHAIN VERIFICATION", "=".repeat(72)];
      lines.push(`entries    ${v.entries}`);
      lines.push(`result     ${v.ok ? "VERIFIED" : "FAILED"}`);
      if (!v.ok) {
        lines.push(`broken at  seq ${v.brokenAt ?? "?"}`);
        for (const f of v.failures) lines.push(`  [${sanitize(f.code)}] seq=${f.seq ?? "?"} ${sanitize(f.detail)}`);
      }
      return { code: v.ok ? 0 : 1, lines };
    }
    case "checkpoint": {
      const stack = deps.root();
      const identity = stack.keystore.load().identity;
      const at = deps.now?.() ?? Date.now();
      const cp = stack.chain.checkpoint(identity, at);
      if (hasFlag(rest, "--json")) return jsonResult(cp);
      return {
        code: 0,
        lines: [
          "CHECKPOINT SIGNED",
          "=".repeat(72),
          `treeSize   ${cp.treeSize}`,
          `root       ${cp.root}`,
          `headSha256 ${cp.headSha256}`,
          `at         ${cp.at}`,
          `signer     ${cp.signerPublicKey}`,
        ],
      };
    }
    case "prove": {
      const stack = deps.root();
      const seqFlag = numberFlag(rest, "--seq");
      if (seqFlag.error) return fail("audit prove", seqFlag.error);
      if (seqFlag.value === undefined) return fail("audit prove", "--seq N is required");
      const seq = Math.floor(seqFlag.value);

      // A fresh, from-bytes verification FIRST — a proof is never emitted
      // against a chain this process cannot currently trust; this is also
      // exactly what makes tampering with the on-disk file, then calling
      // `prove` again, visibly fail rather than silently returning a stale
      // proof.
      const verification = stack.chain.verify();
      if (!verification.ok) {
        const first = verification.failures[0];
        return fail(
          "audit prove",
          `refusing to prove inclusion against a chain that fails verification (${first?.code ?? "unknown"} at seq ${verification.brokenAt ?? "?"}: ${first?.detail ?? "unknown"})`,
        );
      }

      const leaves = stack.chain.leafHashes();
      if (seq < 0 || seq >= leaves.length) {
        return fail("audit prove", `--seq ${seq} is out of range (chain has ${leaves.length} entries)`);
      }
      const proof = inclusionProof(leaves, seq);
      const root = merkleRoot(leaves);
      const verified = verifyInclusion(leaves[seq], proof, root);
      if (hasFlag(rest, "--json")) return jsonResult({ seq, root, proof, verified }, verified ? 0 : 1);
      return {
        code: verified ? 0 : 1,
        lines: [
          "INCLUSION PROOF",
          "=".repeat(72),
          `seq        ${seq}`,
          `treeSize   ${proof.treeSize}`,
          `root       ${root}`,
          `path       [${proof.path.length} step(s)]`,
          `self-check ${verified ? "PASSED" : "FAILED"}`,
        ],
      };
    }
    case "export": {
      const stack = deps.root();
      const entries = stack.chain.entries();
      const out = flagValue(rest, "--out");
      if (out !== undefined) {
        // A machine-consumable dump goes to a real file rather than being
        // smuggled through stdout — the whole point of exporting an audit
        // log is to hand the exact bytes to something else. JSONL, one
        // entry per line, in chain order: the same shape the chain stores,
        // so a consumer can re-verify it without reformatting.
        const body = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "");
        const write = deps.writeFile ?? ((p: string, c: string) => writeFileSync(p, c, "utf8"));
        try {
          write(out, body);
        } catch (err) {
          return fail("audit export", `cannot write ${out}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (hasFlag(rest, "--json")) return jsonResult({ written: out, entries: entries.length, bytes: Buffer.byteLength(body, "utf8") });
        return { code: 0, lines: [`wrote ${entries.length} audit entr${entries.length === 1 ? "y" : "ies"} (${Buffer.byteLength(body, "utf8")} bytes) to ${sanitize(out)}`] };
      }
      if (hasFlag(rest, "--json")) return jsonResult(entries);
      return {
        code: 0,
        lines: [
          `AUDIT EXPORT (${entries.length} entries)`,
          "",
          ...table(
            ["SEQ", "AT", "ACTOR", "ACTION", "RESOURCE", "OUTCOME", "ENTRY-SHA256"],
            entries.map((e) => [String(e.seq), String(e.at), sanitize(e.actor), sanitize(e.action), sanitize(e.resource), e.outcome, e.entrySha256.slice(0, 16) + "..."]),
          ),
        ],
      };
    }
    default:
      return unknown("audit", sub, AUDIT_USAGE);
  }
}

// ---------------------------------------------------------------------------
// gov policy
// ---------------------------------------------------------------------------

async function runPolicyCommand(args: readonly string[], deps: GovCommandDeps): Promise<CliResult> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
      return { code: 0, lines: POLICY_USAGE };
    case "show": {
      const stack = deps.root();
      const result = stack.policy.load();
      if (hasFlag(rest, "--json")) {
        return jsonResult(
          {
            status: result.status,
            reason: result.reason,
            doc: result.bundle?.doc,
            signerPublicKey: result.bundle?.signerPublicKey,
          },
          result.status === "ok" ? 0 : 1,
        );
      }
      const lines = ["POLICY", "=".repeat(72), `status    ${result.status}`, `reason    ${sanitize(result.reason)}`];
      if (result.bundle) {
        lines.push(`name      ${sanitize(result.bundle.doc.name)}`);
        lines.push(`version   ${result.bundle.doc.version}`);
        lines.push(`rules     ${result.bundle.doc.rules.length}`);
        lines.push(`default   ${result.bundle.doc.defaultEffect}`);
        lines.push(`signer    ${sanitize(result.bundle.signerPublicKey)}`);
      }
      return { code: result.status === "ok" ? 0 : 1, lines };
    }
    case "init": {
      // DEFAULT_GOV_POLICY is a real, lint-clean, default-deny document that
      // ships with this build; without this subcommand the only way to
      // install it was to hand-write the JSON, which left `gov doctor`
      // failing "policy absent" out of the box with no in-CLI remedy.
      // Installing it is a genuine sign-and-persist through the real
      // PolicyStore — never a file copy that skips the signature.
      const stack = deps.root();
      const existing = stack.policy.load();
      const force = hasFlag(rest, "--force");
      if (existing.status !== "absent" && !force) {
        return fail(
          "policy init",
          `a policy is already present (status "${existing.status}"): ${existing.reason}. ` +
            "Refusing to overwrite it — pass --force to replace it, or use `gov policy set --file` to install a specific document.",
        );
      }
      // A replacement must still clear the store's own anti-rollback rule, so
      // bump past whatever version history already records rather than
      // silently re-saving v1 and being refused.
      const doc = force && existing.bundle ? { ...DEFAULT_GOV_POLICY, version: existing.bundle.doc.version + 1 } : DEFAULT_GOV_POLICY;
      const identity = stack.keystore.load().identity;
      let bundle;
      try {
        bundle = stack.policy.save(doc, identity);
      } catch (err) {
        return fail("policy init", err instanceof Error ? err.message : String(err));
      }
      // Read the policy back through the REAL store rather than trusting the
      // save: this proves the bytes that landed on disk load and
      // signature-verify, and yields a real engine to lint with.
      const readBack = stack.policy.load();
      const findings = readBack.status === "ok" ? readBack.engine.lint() : [];
      const ok = readBack.status === "ok";
      if (hasFlag(rest, "--json")) {
        return jsonResult(
          {
            installed: ok,
            replaced: existing.status !== "absent",
            name: bundle.doc.name,
            version: bundle.doc.version,
            rules: bundle.doc.rules.length,
            readBackStatus: readBack.status,
            lintFindings: findings,
          },
          ok ? 0 : 1,
        );
      }
      return {
        code: ok ? 0 : 1,
        lines: [
          `${existing.status === "absent" ? "installed" : "replaced"} the default policy "${sanitize(bundle.doc.name)}" v${bundle.doc.version} (${bundle.doc.rules.length} rules, default ${bundle.doc.defaultEffect})`,
          `signed by ${sanitize(bundle.signerPublicKey)}`,
          `read-back  ${readBack.status}: ${sanitize(readBack.reason)}`,
          findings.length === 0 ? "lint: clean" : `lint: ${findings.length} finding(s): ${findings.map((f) => f.code).join(", ")}`,
        ],
      };
    }
    case "lint": {
      const stack = deps.root();
      const result = stack.policy.load();
      if (result.status !== "ok") {
        return fail("policy lint", `cannot lint — policy did not load "ok" (${result.status}: ${result.reason})`);
      }
      const findings = result.engine.lint();
      if (hasFlag(rest, "--json")) return jsonResult({ findings }, findings.length === 0 ? 0 : 1);
      if (findings.length === 0) return { code: 0, lines: ["no lint findings — policy looks clean"] };
      return {
        code: 1,
        lines: [
          `${findings.length} LINT FINDING(S)`,
          "",
          ...table(["CODE", "RULES", "DETAIL"], findings.map((f) => [f.code, f.ruleIds.map(sanitize).join(","), sanitize(f.detail)])),
        ],
      };
    }
    case "set": {
      const stack = deps.root();
      const file = flagValue(rest, "--file");
      if (file === undefined) return fail("policy set", "--file <doc.json> is required");
      const { exists, read } = readerFor(deps);
      if (!exists(file)) return fail("policy set", `file not found: ${file}`);
      let raw: string;
      try {
        raw = read(file);
      } catch (err) {
        return fail("policy set", `cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return fail("policy set", `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      const parsedDoc = parsePolicyDocument(parsed);
      if (!parsedDoc.ok) return fail("policy set", `invalid policy document: ${parsedDoc.errors.join("; ")}`);
      const identity = stack.keystore.load().identity;
      let bundle;
      try {
        bundle = stack.policy.save(parsedDoc.doc, identity);
      } catch (err) {
        return fail("policy set", err instanceof Error ? err.message : String(err));
      }
      if (hasFlag(rest, "--json")) return jsonResult(bundle);
      return { code: 0, lines: [`policy "${sanitize(bundle.doc.name)}" v${bundle.doc.version} saved, signed by ${sanitize(bundle.signerPublicKey)}`] };
    }
    case "test": {
      const stack = deps.root();
      const subject = flagValue(rest, "--subject");
      const action = flagValue(rest, "--action");
      const resource = flagValue(rest, "--resource");
      if (subject === undefined) return fail("policy test", "--subject is required");
      if (action === undefined) return fail("policy test", "--action is required");
      if (resource === undefined) return fail("policy test", "--resource is required");
      const at = numberFlag(rest, "--at");
      if (at.error) return fail("policy test", at.error);
      const risk = numberFlag(rest, "--risk-remaining");
      if (risk.error) return fail("policy test", risk.error);
      const result = stack.policy.load();
      const req: PolicyRequest = {
        subject,
        action,
        resource,
        at: at.value ?? deps.now?.() ?? Date.now(),
        airgapped: hasFlag(rest, "--airgapped"),
        subjectRoles: flagValues(rest, "--role"),
        capabilities: flagValues(rest, "--capability"),
        ...(risk.value !== undefined ? { riskRemaining: risk.value } : {}),
        args: parseArgsMap(rest, "--arg"),
      };
      const decision = result.engine.explain(req);
      if (hasFlag(rest, "--json")) return jsonResult({ policyStatus: result.status, decision }, decision.effect === "allow" ? 0 : 2);
      const lines = ["POLICY TEST", "=".repeat(72), `policy status  ${result.status}`, `effect         ${decision.effect}`, `rule           ${decision.ruleId === undefined ? "(default)" : sanitize(decision.ruleId)}`, `reason         ${sanitize(decision.reason)}`];
      if (decision.obligations.length > 0) {
        lines.push("obligations:");
        for (const o of decision.obligations) lines.push(`  ${JSON.stringify(o)}`);
      }
      return { code: decision.effect === "allow" ? 0 : 2, lines };
    }
    default:
      return unknown("policy", sub, POLICY_USAGE);
  }
}

// ---------------------------------------------------------------------------
// gov airgap
// ---------------------------------------------------------------------------

async function runAirgapCommand(args: readonly string[], deps: GovCommandDeps): Promise<CliResult> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
      return { code: 0, lines: AIRGAP_USAGE };
    case "status": {
      // Read from the REAL live-session registry rather than asserting a
      // constant "not engaged": an air-gap engaged anywhere in this process
      // (a `withAirgap` block, an in-flight `runAirgappedTask`) is genuinely
      // in force, and an operator surface that hardcodes the answer would be
      // wrong exactly when being wrong matters. In a one-shot CLI invocation
      // this correctly reports zero live sessions — because there are zero,
      // not because it was told to say so.
      const live = activeAirgapSessions();
      const reports = live.map((sess) => sess.report());
      const status = {
        engaged: live.length > 0,
        liveSessions: live.length,
        sealed: reports.length > 0 && reports.every((r) => r.sealed),
        policies: reports.map((r) => r.policy),
        note:
          "each `hades gov airgap` invocation is a fresh process, so a one-shot CLI run reports zero live sessions; " +
          "use `probe` for a real neutralizability check or `run` to execute a real air-gapped task.",
      };
      if (hasFlag(rest, "--json")) return jsonResult(status);
      const lines = ["AIR-GAP STATUS", "=".repeat(72)];
      lines.push(`engaged        ${status.engaged ? "YES" : "no"} (${live.length} live session(s) in this process)`);
      if (status.engaged) {
        lines.push(`sealed         ${status.sealed ? "YES" : "NO"}`);
        for (let i = 0; i < reports.length; i++) {
          const p = reports[i].policy;
          lines.push(
            `  session[${i}]  allowLoopback=${p.allowLoopback ?? false} allowUnixSocket=${p.allowUnixSocket ?? false} allowHosts=[${(p.allowHosts ?? []).map(sanitize).join(",")}]`,
          );
        }
      }
      lines.push("");
      lines.push(status.note);
      return { code: 0, lines };
    }
    case "probe": {
      const report = probeAirgap();
      if (hasFlag(rest, "--json")) return jsonResult(report, report.sealed ? 0 : 1);
      const lines = ["AIR-GAP PROBE (dry run against the real process)", "=".repeat(72)];
      lines.push(...table(["SEAM", "NEUTRALIZED", "HOW", "DETAIL"], report.seams.map((st) => [st.seam, st.neutralized ? "yes" : "NO", st.how, sanitize(st.detail)])));
      lines.push("");
      lines.push(`sealed   ${report.sealed ? "YES" : "NO"}`);
      if (report.unverifiableSeams.length > 0) lines.push(`unverifiable: ${report.unverifiableSeams.join(", ")}`);
      return { code: report.sealed ? 0 : 1, lines };
    }
    case "run": {
      const stack = deps.root();
      const identity = stack.keystore.load().identity;
      const allowLoopback = hasFlag(rest, "--allow-loopback");
      const allowHosts = flagValues(rest, "--allow-host");
      const taskId = flagValue(rest, "--task-id") ?? "gov-airgap-selfcheck";
      const nowFn = deps.now ?? (() => Date.now());

      const task = {
        id: taskId,
        prompt: "hades gov airgap run: attempt a canary network call (expect it blocked) and one over-privileged capability request (expect it denied).",
        run: async (ctx: AirgappedTaskContext): Promise<string> => {
          let canaryBlocked = false;
          try {
            await fetch("https://hades-airgap-canary.invalid/ping");
          } catch (err) {
            canaryBlocked = err instanceof AirgapViolationError;
          }
          const decision = ctx.authorize({
            subject: identity.agentId(),
            action: "net:egress",
            resource: "net:hades-airgap-canary.invalid",
            at: nowFn(),
          });
          ctx.audit({
            at: nowFn(),
            actor: identity.agentId(),
            action: "airgap.selfcheck",
            resource: "canary",
            outcome: "info",
            payload: { canaryBlocked, capabilityDenied: !decision.allow },
          });
          return `canary-blocked=${canaryBlocked} capability-denied=${!decision.allow}`;
        },
      };

      const result = await runAirgappedTask({
        dataDir: stack.dataDir,
        identity,
        now: nowFn,
        policy: { allowLoopback, allowHosts },
        task,
      });

      if (hasFlag(rest, "--json")) return jsonResult(result, result.verified ? 0 : 1);
      return { code: result.verified ? 0 : 1, lines: formatAirgapRunReport(result) };
    }
    default:
      return unknown("airgap", sub, AIRGAP_USAGE);
  }
}

// ---------------------------------------------------------------------------
// gov doctor
// ---------------------------------------------------------------------------

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

async function doctor(args: readonly string[], deps: GovCommandDeps): Promise<CliResult> {
  const checks: DoctorCheck[] = [];
  let stack: GovStack;
  try {
    stack = deps.root();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const failed: DoctorCheck[] = [{ name: "open gov stack", ok: false, detail }];
    return hasFlag(args, "--json")
      ? jsonResult({ ok: false, checks: failed }, 1)
      : { code: 1, lines: ["GOV DOCTOR", "=".repeat(72), `[FAIL] open gov stack: ${sanitize(detail)}`] };
  }

  let loaded: ReturnType<GovKeystore["load"]>;
  try {
    loaded = stack.keystore.load();
    checks.push({ name: "identity resolved", ok: true, detail: `source=${loaded.source} agentId=${loaded.identity.agentId()} rotations=${loaded.rotations.length}` });
  } catch (err) {
    checks.push({ name: "identity resolved", ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  const chainVerify = stack.chain.verify();
  checks.push({
    name: "audit chain verifies",
    ok: chainVerify.ok,
    detail: chainVerify.ok
      ? `${chainVerify.entries} entr${chainVerify.entries === 1 ? "y" : "ies"} recomputed clean`
      : `${chainVerify.failures[0]?.code ?? "?"} at seq ${chainVerify.brokenAt ?? "?"}: ${chainVerify.failures[0]?.detail ?? ""}`,
  });

  const policyResult = stack.policy.load();
  checks.push({
    name: "policy loaded & signed",
    ok: policyResult.status === "ok",
    detail: `${policyResult.status}: ${policyResult.reason}`,
  });
  if (policyResult.status === "ok") {
    const lint = policyResult.engine.lint();
    const blocking = lint.filter((f) => f.code !== "unbounded-wildcard");
    checks.push({
      name: "policy lints clean",
      ok: blocking.length === 0,
      detail: lint.length === 0 ? "no findings" : `${lint.length} finding(s): ${lint.map((f) => f.code).join(", ")}`,
    });
  }

  const airgapReport = probeAirgap();
  checks.push({
    name: "air-gap seams neutralizable",
    ok: airgapReport.sealed,
    detail:
      `${airgapReport.seams.filter((s) => s.neutralized).length}/${airgapReport.seams.length} neutralized` +
      (airgapReport.unverifiableSeams.length > 0 ? `; unverifiable: ${airgapReport.unverifiableSeams.join(", ")}` : ""),
  });

  // End-to-end proof: mint a scoped token and check that both an in-grant
  // and an out-of-grant request behave as expected — never trust that the
  // wiring "must" work without actually exercising it.
  if (loaded!) {
    try {
      const probeIssuer = new CapabilityIssuer(loaded.identity);
      const probeEnforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [loaded.identity.publicKeyHex()] });
      const probeToken = probeIssuer.mint({ subject: loaded.identity.agentId(), grants: [{ resource: "tool:*", actions: ["tool:invoke"] }] });
      const allowed = probeEnforcer.authorize([probeToken], { subject: loaded.identity.agentId(), action: "tool:invoke", resource: "tool:echo", at: probeToken.issuedAt + 1 });
      const denied = probeEnforcer.authorize([probeToken], { subject: loaded.identity.agentId(), action: "net:egress", resource: "net:example.com", at: probeToken.issuedAt + 1 });
      checks.push({
        name: "capability round-trip",
        ok: allowed.allow && !denied.allow,
        detail: `in-grant allowed=${allowed.allow} out-of-grant denied=${!denied.allow} (code=${denied.code})`,
      });
    } catch (err) {
      checks.push({ name: "capability round-trip", ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  const ok = checks.every((c) => c.ok);
  if (hasFlag(args, "--json")) return jsonResult({ ok, checks }, ok ? 0 : 1);

  const lines = ["GOV DOCTOR", "=".repeat(72)];
  for (const c of checks) lines.push(`[${c.ok ? "PASS" : "FAIL"}] ${pad(c.name, 30)} ${sanitize(c.detail)}`);
  lines.push("");
  lines.push(ok ? "RESULT: healthy" : "RESULT: NOT healthy — see the FAIL lines above");
  return { code: ok ? 0 : 1, lines };
}
