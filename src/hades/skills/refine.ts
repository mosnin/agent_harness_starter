/**
 * Refine-on-use — deterministic SKILL.md improvement after a GATE-VERIFIED use.
 *
 * `synthesize.ts` answers "does a trajectory earn a new skill". This module
 * answers the follow-up question: once a skill exists and gets *used*, how
 * does it get *better* — learned caveats, tool-list corrections, a version
 * bump, an auditable trail — without ever letting a use that didn't actually
 * pass verification (or that failed) widen what the skill is allowed to do.
 *
 * The central invariant, restated because it is the entire point of this
 * module: **`tools` (the skill's capability allowlist) can only ever grow
 * from a tool that succeeded (`ok: true`) inside a trajectory that (a) carries
 * a certificate whose real ed25519 signature verifies, and (b) itself
 * succeeded (`trajectory.success === true`)**. A forged certificate never
 * verifies, so it contributes nothing. A verified-but-failed trajectory can
 * still teach the skill something (a caveat), but it can never add a tool.
 * Nothing in this file can ever remove that check — every path that ends in
 * `manifest.tools` growing runs through exactly one function,
 * {@link computeToolAdditions}, which is the only place `ok === true` and
 * `trajectory.success === true` are checked together.
 *
 * State (which certificates already contributed, the accumulated caveats,
 * the per-tool consecutive-failure streak, the full op history) lives in a
 * single fenced ```hades-refinements JSON block appended to the end of the
 * skill's `instructions` body — deliberately named differently from
 * `synthesize.ts`'s ```hades-provenance block so both can coexist in one
 * SKILL.md. Every value embedded from trajectory/certificate text (tool
 * summaries, task descriptions, objectives) is sanitized the same way
 * `synthesize.ts` sanitizes trajectory text before it touches the body, so a
 * hostile `ToolEvent.summary` can never break the frontmatter, forge a fence,
 * or smuggle a second ledger block into the file.
 *
 * Pure aside from the required `async` certificate checks: no fs, no env, no
 * ambient clock (the caller injects `now`).
 *
 * @module hades/skills/refine
 */

import type { GoalTrajectory } from "../research/recorder";
import {
  type VerificationCertificate,
  sha256Hex,
  verifyCertificate,
} from "../styx/certificate";
import {
  type SkillManifest,
  parseSkillFile,
  serializeSkillFile,
  validateSkillManifest,
} from "./skill-file";

// ---------------------------------------------------------------------------
// Public types (locked contract)
// ---------------------------------------------------------------------------

/** A single gate-verified use of a skill: the trajectory it ran plus the certificate attesting it. */
export interface VerifiedUse {
  skillName: string;
  trajectory: GoalTrajectory;
  certificate: VerificationCertificate;
  at: number;
}

export type RefineOpKind =
  | "add-caveat"
  | "add-tool"
  | "drop-dead-tool"
  | "update-when-to-use"
  | "bump-version";

export interface RefineOp {
  kind: RefineOpKind;
  detail: string;
  evidenceCertSha256: string;
}

export interface RefineResult {
  ok: boolean;
  changed: boolean;
  manifest?: SkillManifest;
  content?: string;
  /** The NEW ops applied by this call (not the cumulative ledger history). */
  ops: RefineOp[];
  rejected: Array<{ reason: string }>;
  /** Human-readable, one line per op (from `ops`, not the cumulative history). */
  changelog: string;
}

export interface RefineOptions {
  now?: number;
  /** Max learned-caveat bullets retained; oldest evicted first. Default 12. */
  maxCaveats?: number;
  /** Consecutive verified-use failures (no intervening success) before a listed tool is dropped. Default 3. */
  dropToolAfterConsecutiveFailures?: number;
}

// ---------------------------------------------------------------------------
// Internal ledger (persisted state) — superset of what extractRefinementLedger exposes
// ---------------------------------------------------------------------------

const ALL_OP_KINDS: ReadonlySet<RefineOpKind> = new Set([
  "add-caveat",
  "add-tool",
  "drop-dead-tool",
  "update-when-to-use",
  "bump-version",
]);

interface InternalLedger {
  /** Cert hashes already folded into a refinement round, in application order. */
  certSha256s: string[];
  /** Full cumulative op history across every round that has ever run. */
  ops: RefineOp[];
  /** Rendered, sanitized, already-hash-tagged caveat bullet lines (FIFO-capped). */
  caveats: string[];
  /** Per-tool trailing consecutive-failure streak (only tools currently tracked). */
  toolStreaks: Record<string, number>;
  /** Last `now` a round actually changed something. Informational only. */
  lastRefinedAt: number | null;
}

function emptyLedger(): InternalLedger {
  return { certSha256s: [], ops: [], caveats: [], toolStreaks: {}, lastRefinedAt: null };
}

const REFINEMENTS_FENCE_OPEN = "```hades-refinements";
const REFINEMENTS_FENCE_CLOSE = "```";
const REFINEMENTS_FENCE_RE = /```hades-refinements\r?\n([\s\S]*?)\r?\n```/;
/** Marks the start of our appended block so it can be found & replaced verbatim. */
const BLOCK_SENTINEL = "<!-- hades-refine:block -->";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isRefineOp(v: unknown): v is RefineOp {
  if (!isPlainObject(v)) return false;
  return (
    typeof v.kind === "string" &&
    ALL_OP_KINDS.has(v.kind as RefineOpKind) &&
    typeof v.detail === "string" &&
    typeof v.evidenceCertSha256 === "string"
  );
}

/**
 * Locate OUR ledger fence, disambiguated from any other `hades-refinements`
 * -shaped text that might already be sitting in the body (a hand-authored
 * document, a garbage/malformed fence a previous round appended after
 * without being able to parse, etc). Every block we ever write is prefixed
 * with {@link BLOCK_SENTINEL}, so scoping the fence search to the text after
 * the LAST sentinel occurrence guarantees we always read back the block we
 * ourselves most recently wrote rather than an unrelated earlier fence.
 */
function findOurFenceMatch(instructions: string): RegExpExecArray | null {
  const idx = instructions.lastIndexOf(BLOCK_SENTINEL);
  const scope = idx === -1 ? instructions : instructions.slice(idx);
  return REFINEMENTS_FENCE_RE.exec(scope);
}

/** Parse + shape-validate the full internal ledger. Never throws; `null` on anything malformed. */
function readInternalLedger(instructions: string): InternalLedger | null {
  if (typeof instructions !== "string") return null;
  const match = findOurFenceMatch(instructions);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (!isPlainObject(parsed)) return null;

    const certSha256s = parsed.certSha256s;
    if (!Array.isArray(certSha256s) || !certSha256s.every((h) => typeof h === "string")) return null;

    const ops = parsed.ops;
    if (!Array.isArray(ops) || !ops.every(isRefineOp)) return null;

    const caveats = parsed.caveats;
    if (!Array.isArray(caveats) || !caveats.every((c) => typeof c === "string")) return null;

    const toolStreaks = parsed.toolStreaks;
    if (!isPlainObject(toolStreaks)) return null;
    const streaks: Record<string, number> = {};
    for (const [k, v] of Object.entries(toolStreaks)) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
      streaks[k] = v;
    }

    const lastRefinedAt = parsed.lastRefinedAt;
    if (lastRefinedAt !== null && typeof lastRefinedAt !== "number") return null;

    return {
      certSha256s: [...(certSha256s as string[])],
      ops: [...(ops as RefineOp[])],
      caveats: [...(caveats as string[])],
      toolStreaks: streaks,
      lastRefinedAt: (lastRefinedAt as number | null) ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Read the two contractually-required fields out of a skill's `instructions`
 * body. Returns `null` (never throws) when no well-formed ledger fence is
 * present — mirrors `synthesize.ts`'s `extractProvenance`.
 */
export function extractRefinementLedger(
  instructions: string
): { certSha256s: string[]; ops: RefineOp[] } | null {
  const full = readInternalLedger(instructions);
  if (!full) return null;
  return { certSha256s: [...full.certSha256s], ops: [...full.ops] };
}

// ---------------------------------------------------------------------------
// Sanitization — mirrors synthesize.ts's sanitizeForBody exactly on purpose.
// Neutralizes fence breakouts (```), inert-but-mirrored `---` line escaping,
// and flattens embedded newlines so untrusted text can never become a new
// markdown/frontmatter line of its own.
// ---------------------------------------------------------------------------

function sanitizeText(raw: unknown): string {
  return String(raw ?? "")
    .replace(/```/g, "'''")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => (line.trim() === "---" ? "\\-\\-\\-" : line))
    .join(" ")
    .trim();
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen).trimEnd() + "…";
}

// ---------------------------------------------------------------------------
// Certificate hashing — a deterministic per-certificate fingerprint used to
// dedupe/apply evidence, WITHOUT needing `canonicalize` (not part of this
// module's import contract). ed25519 signatures from `CertificateAuthority`
// are deterministic (RFC 8032-style, no injected entropy), so
// sha256(signature:publicKey) is a stable fingerprint of "this exact signed
// certificate" for any certificate that actually verifies.
// ---------------------------------------------------------------------------

function certFingerprint(cert: VerificationCertificate): string {
  const sig = typeof cert?.signature === "string" ? cert.signature : "";
  const pub = typeof cert?.publicKey === "string" ? cert.publicKey : "";
  return sha256Hex(`${sig}:${pub}`);
}

// ---------------------------------------------------------------------------
// refineSkill
// ---------------------------------------------------------------------------

interface Candidate {
  use: VerifiedUse;
  hash: string;
}

/** Distinct tool outcome for one tool within one use's trajectory. */
type ToolOutcome = "success" | "failure" | "absent";

function toolOutcomeIn(trajectory: GoalTrajectory, tool: string): ToolOutcome {
  let sawFailure = false;
  for (const task of Array.isArray(trajectory?.tasks) ? trajectory.tasks : []) {
    for (const ev of Array.isArray(task?.tools) ? task.tools : []) {
      if (ev.tool !== tool) continue;
      if (ev.ok === true) return "success";
      sawFailure = true;
    }
  }
  return sawFailure ? "failure" : "absent";
}

export async function refineSkill(
  currentContent: string,
  uses: VerifiedUse[],
  opts?: RefineOptions
): Promise<RefineResult> {
  const now = opts?.now ?? Date.now();
  const maxCaveats = opts?.maxCaveats ?? 12;
  const dropThreshold = opts?.dropToolAfterConsecutiveFailures ?? 3;

  // ---- 1. Parse & validate the base document -----------------------------
  let parsedBase: ReturnType<typeof parseSkillFile>;
  try {
    parsedBase = parseSkillFile(currentContent);
  } catch (err) {
    return {
      ok: false,
      changed: false,
      ops: [],
      rejected: [{ reason: `currentContent could not be parsed as SKILL.md: ${errMsg(err)}` }],
      changelog: "",
    };
  }
  const baseManifest = parsedBase.manifest;
  const baseValidation = validateSkillManifest(baseManifest);
  if (!baseValidation.valid) {
    return {
      ok: false,
      changed: false,
      ops: [],
      rejected: [{ reason: `currentContent's manifest is invalid: ${baseValidation.errors.join("; ")}` }],
      changelog: "",
    };
  }

  // ---- 2. Recover prior refinement state ----------------------------------
  const { baseBody } = splitOffOurBlock(baseManifest.instructions ?? "");
  const oldLedger = readInternalLedger(baseManifest.instructions ?? "") ?? emptyLedger();
  const appliedHashes = new Set(oldLedger.certSha256s);

  const rejected: Array<{ reason: string }> = [];

  // ---- 3. Verify + classify every use --------------------------------------
  const candidates: Candidate[] = [];
  for (const use of Array.isArray(uses) ? uses : []) {
    if (!isPlainObject(use) || typeof use.skillName !== "string") {
      rejected.push({ reason: "malformed use entry (missing skillName) — ignored." });
      continue;
    }
    if (use.skillName !== baseManifest.name) {
      rejected.push({
        reason: `use.skillName "${use.skillName}" does not match target skill "${baseManifest.name}" — ignored.`,
      });
      continue;
    }
    let verified = false;
    try {
      verified = await verifyCertificate(use.certificate);
    } catch {
      verified = false;
    }
    if (!verified) {
      rejected.push({
        reason: `certificate for a use of "${use.skillName}" recorded at ${String(
          use.at
        )} failed ed25519 verification — contributes nothing.`,
      });
      continue;
    }
    const hash = certFingerprint(use.certificate);
    if (appliedHashes.has(hash)) {
      // Already folded into a previous refinement round — not new, not rejected.
      continue;
    }
    candidates.push({ use, hash });
  }

  // ---- 4. Canonical ordering: deterministic regardless of input order -----
  candidates.sort((a, b) => {
    const at = (a.use.at ?? 0) - (b.use.at ?? 0);
    if (at !== 0) return at;
    return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
  });

  if (candidates.length === 0) {
    return { ok: true, changed: false, manifest: baseManifest, content: currentContent, ops: [], rejected, changelog: "" };
  }

  // ---- 5. add-tool — ONLY from ok:true events inside success:true trajectories
  const workingTools = [...(baseManifest.tools ?? [])];
  const { ops: addToolOps, added: addedToolNames } = computeToolAdditions(candidates, workingTools);
  for (const t of addedToolNames) workingTools.push(t);

  // ---- 6. drop-dead-tool — sequential streak scan over the (post-add) tool set
  const streaks: Record<string, number> = { ...oldLedger.toolStreaks };
  for (const t of addedToolNames) streaks[t] = streaks[t] ?? 0;
  const dropResult = computeDeadToolDrops(candidates, workingTools, streaks, dropThreshold);
  for (const name of dropResult.dropped) {
    const idx = workingTools.indexOf(name);
    if (idx !== -1) workingTools.splice(idx, 1);
    delete streaks[name];
  }
  for (const r of dropResult.blockedLastTool) {
    rejected.push({
      reason: `tool "${r}" met the consecutive-failure drop threshold but is the skill's last remaining tool; dropping it would leave an invalid manifest, so it was kept.`,
    });
  }

  // ---- 7. add-caveat — any failing tool event inside any verified use ------
  const caveatOps = computeCaveats(candidates);

  // ---- 8. update-when-to-use — new objectives observed in successful uses --
  const whenToUseOp = computeWhenToUseUpdate(candidates, baseManifest.whenToUse);

  // ---- 9. Assemble this round's ops (bump-version last, exactly once) -----
  const newOps: RefineOp[] = [...addToolOps, ...caveatOps, ...dropResult.ops];
  if (whenToUseOp) newOps.push(whenToUseOp.op);

  if (newOps.length === 0) {
    // A wholly uneventful round (already-known tools, no failures, nothing
    // new to say): leave the document byte-identical rather than churn the
    // ledger for no observable reason.
    return { ok: true, changed: false, manifest: baseManifest, content: currentContent, ops: [], rejected, changelog: "" };
  }

  const versionResult = bumpVersion(baseManifest.version);
  const bumpEvidence = candidates[0].hash;
  const bumpOp: RefineOp = {
    kind: "bump-version",
    detail: versionResult.warning
      ? `Version was unset or unparsable (${versionResult.warning}); reset to ${versionResult.next}. (evidence ${bumpEvidence.slice(0, 12)})`
      : `Version bumped ${baseManifest.version ?? "(unset)"} -> ${versionResult.next} (patch). (evidence ${bumpEvidence.slice(0, 12)})`,
    evidenceCertSha256: bumpEvidence,
  };
  newOps.push(bumpOp);

  // ---- 10. Build the new manifest ------------------------------------------
  const newManifest: SkillManifest = {
    ...baseManifest,
    tools: workingTools,
    version: versionResult.next,
    ...(whenToUseOp ? { whenToUse: whenToUseOp.text } : {}),
  };

  const newCaveats = fifoCap([...oldLedger.caveats, ...caveatOps.map((op) => op.detail)], maxCaveats);
  const newLedger: InternalLedger = {
    certSha256s: [...oldLedger.certSha256s, ...candidates.map((c) => c.hash)],
    ops: [...oldLedger.ops, ...newOps],
    caveats: newCaveats,
    toolStreaks: streaks,
    lastRefinedAt: now,
  };

  newManifest.instructions = `${baseBody.replace(/\s+$/, "")}\n${renderBlock(newLedger)}`;

  // ---- 11. Never emit anything that doesn't re-parse & re-validate --------
  let content: string;
  try {
    content = serializeSkillFile(newManifest);
    const reparsed = parseSkillFile(content);
    const reValidation = validateSkillManifest(reparsed.manifest);
    if (!reValidation.valid) {
      return {
        ok: false,
        changed: false,
        ops: [],
        rejected: [
          ...rejected,
          { reason: `refinement would have produced an invalid manifest (${reValidation.errors.join("; ")}); discarded.` },
        ],
        changelog: "",
      };
    }
    if (reparsed.manifest.name !== baseManifest.name) {
      // Structural canary: refinement must never change identity.
      return {
        ok: false,
        changed: false,
        ops: [],
        rejected: [...rejected, { reason: "refinement would have altered the skill's name; discarded." }],
        changelog: "",
      };
    }
  } catch (err) {
    return {
      ok: false,
      changed: false,
      ops: [],
      rejected: [...rejected, { reason: `refinement failed to round-trip through parseSkillFile: ${errMsg(err)}` }],
      changelog: "",
    };
  }

  const changelog = newOps.map((op) => `- [${op.kind}] ${op.detail}`).join("\n");

  return { ok: true, changed: true, manifest: newManifest, content, ops: newOps, rejected, changelog };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// add-tool — the sole widening path, and the sole place the two required
// checks (verified ok:true event, trajectory.success === true) are enforced
// together.
// ---------------------------------------------------------------------------

function computeToolAdditions(
  candidates: Candidate[],
  existingTools: string[]
): { ops: RefineOp[]; added: string[] } {
  const known = new Set(existingTools);
  const ops: RefineOp[] = [];
  const added: string[] = [];

  for (const c of candidates) {
    if (c.use.trajectory?.success !== true) continue; // failed trajectory: never widens tools
    for (const task of Array.isArray(c.use.trajectory.tasks) ? c.use.trajectory.tasks : []) {
      for (const ev of Array.isArray(task?.tools) ? task.tools : []) {
        if (ev.ok !== true) continue; // only a genuinely successful tool event
        const tool = typeof ev.tool === "string" ? ev.tool.trim() : "";
        if (tool === "" || known.has(tool)) continue;
        known.add(tool);
        added.push(tool);
        const summary = sanitizeText(ev.summary ?? task.description ?? "");
        ops.push({
          kind: "add-tool",
          detail: `Added tool \`${sanitizeText(tool)}\` — succeeded (ok:true) inside a verified, successful trajectory${
            summary ? `: ${truncate(summary, 180)}` : "."
          } (evidence ${c.hash.slice(0, 12)})`,
          evidenceCertSha256: c.hash,
        });
      }
    }
  }

  return { ops, added };
}

// ---------------------------------------------------------------------------
// drop-dead-tool — sequential per-tool consecutive-failure scan.
// ---------------------------------------------------------------------------

function computeDeadToolDrops(
  candidates: Candidate[],
  workingTools: string[],
  streaks: Record<string, number>,
  dropThreshold: number
): { ops: RefineOp[]; dropped: string[]; blockedLastTool: string[] } {
  const ops: RefineOp[] = [];
  const dropped: string[] = [];
  const blockedLastTool: string[] = [];
  const alreadyWarned = new Set<string>();
  // Mutable "still tracked" view of the tool set as drops happen mid-scan.
  const live = new Set(workingTools);

  for (const c of candidates) {
    for (const tool of [...live]) {
      const outcome = toolOutcomeIn(c.use.trajectory, tool);
      if (outcome === "success") {
        streaks[tool] = 0;
        continue;
      }
      if (outcome === "absent") continue; // does not break or extend the streak
      // outcome === "failure"
      streaks[tool] = (streaks[tool] ?? 0) + 1;
      if (streaks[tool] < dropThreshold) continue;

      if (live.size <= 1) {
        if (!alreadyWarned.has(tool)) {
          alreadyWarned.add(tool);
          blockedLastTool.push(tool);
        }
        continue; // never drop the last remaining tool
      }

      live.delete(tool);
      dropped.push(tool);
      ops.push({
        kind: "drop-dead-tool",
        detail: `Dropped tool \`${sanitizeText(tool)}\` — failed in ${streaks[tool]} consecutive verified use(s) with no success in the window. (evidence ${c.hash.slice(0, 12)})`,
        evidenceCertSha256: c.hash,
      });
    }
  }

  return { ops, dropped, blockedLastTool };
}

// ---------------------------------------------------------------------------
// add-caveat — first observed failure per tool this round.
// ---------------------------------------------------------------------------

function computeCaveats(candidates: Candidate[]): RefineOp[] {
  const seen = new Set<string>();
  const ops: RefineOp[] = [];

  for (const c of candidates) {
    for (const task of Array.isArray(c.use.trajectory?.tasks) ? c.use.trajectory.tasks : []) {
      for (const ev of Array.isArray(task?.tools) ? task.tools : []) {
        if (ev.ok !== false) continue;
        const tool = typeof ev.tool === "string" ? ev.tool.trim() : "";
        if (tool === "" || seen.has(tool)) continue;
        seen.add(tool);
        const rawSummary = ev.summary ?? task.description ?? "";
        const summary = truncate(sanitizeText(rawSummary), 220) || "no summary was recorded";
        ops.push({
          kind: "add-caveat",
          detail: `Tool \`${sanitizeText(tool)}\` failed: ${summary} (evidence ${c.hash.slice(0, 12)})`,
          evidenceCertSha256: c.hash,
        });
      }
    }
  }

  return ops;
}

// ---------------------------------------------------------------------------
// update-when-to-use — new distinct objectives observed in successful uses.
// ---------------------------------------------------------------------------

function computeWhenToUseUpdate(
  candidates: Candidate[],
  currentWhenToUse: string | undefined
): { op: RefineOp; text: string } | null {
  const existing = currentWhenToUse ?? "";
  const additions: string[] = [];
  const seen = new Set<string>();
  let evidenceHash: string | null = null;

  for (const c of candidates) {
    if (c.use.trajectory?.success !== true) continue;
    const obj = truncate(sanitizeText(c.use.trajectory.objective ?? ""), 150);
    if (obj === "" || seen.has(obj) || existing.includes(obj)) continue;
    seen.add(obj);
    additions.push(obj);
    if (evidenceHash === null) evidenceHash = c.hash;
    if (additions.length >= 3) break; // bound growth per round
  }

  if (additions.length === 0 || evidenceHash === null) return null;

  const addendum = `Also observed handling: ${additions.join("; ")}.`;
  const text = truncate(existing.trim() === "" ? addendum : `${existing.trim()} ${addendum}`, 700);

  return {
    op: {
      kind: "update-when-to-use",
      detail: `Extended "when to use" guidance with ${additions.length} newly observed objective(s). (evidence ${evidenceHash.slice(0, 12)})`,
      evidenceCertSha256: evidenceHash,
    },
    text,
  };
}

// ---------------------------------------------------------------------------
// bump-version
// ---------------------------------------------------------------------------

function bumpVersion(current: string | undefined): { next: string; warning?: string } {
  const v = typeof current === "string" ? current.trim() : "";
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) {
    return { next: "0.1.0", warning: v === "" ? "no version was set" : `"${v}" is not valid semver` };
  }
  const major = m[1];
  const minor = m[2];
  const patch = Number(m[3]) + 1;
  return { next: `${major}.${minor}.${patch}` };
}

// ---------------------------------------------------------------------------
// Body block rendering / stripping
// ---------------------------------------------------------------------------

function fifoCap(items: string[], max: number): string[] {
  if (max <= 0) return [];
  if (items.length <= max) return items;
  return items.slice(items.length - max);
}

/**
 * Split the previously-appended refine block off the tail of `instructions`,
 * returning everything before it untouched. If our sentinel is absent (never
 * refined before, or hand-authored content) the whole body is the base.
 */
function splitOffOurBlock(instructions: string): { baseBody: string } {
  const idx = instructions.indexOf(BLOCK_SENTINEL);
  if (idx === -1) return { baseBody: instructions };
  return { baseBody: instructions.slice(0, idx).replace(/\s+$/, "") };
}

function renderBlock(ledger: InternalLedger): string {
  const bulletsMd = ledger.caveats.length > 0 ? ledger.caveats.map((c) => `- ${c}`).join("\n") : "_No caveats learned yet._";

  const ledgerJson = {
    certSha256s: ledger.certSha256s,
    ops: ledger.ops,
    caveats: ledger.caveats,
    toolStreaks: ledger.toolStreaks,
    lastRefinedAt: ledger.lastRefinedAt,
  };
  const fence = `${REFINEMENTS_FENCE_OPEN}\n${JSON.stringify(ledgerJson, null, 2)}\n${REFINEMENTS_FENCE_CLOSE}`;

  return [
    "",
    BLOCK_SENTINEL,
    "## Learned caveats",
    "",
    bulletsMd,
    "",
    "This section is maintained automatically by the deterministic skill-refinement",
    "engine after each STYX-gate-verified use. Do not hand-edit the ledger fence below —",
    "future refinements re-derive all state from it and will overwrite manual edits.",
    "",
    fence,
    "",
  ].join("\n");
}
