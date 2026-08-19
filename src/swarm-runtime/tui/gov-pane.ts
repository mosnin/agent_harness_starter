/**
 * gov-pane.ts — pure, deterministic GOVERNANCE pane for the interactive TUI
 * (`hades tui`).
 *
 * Renders the governance stack's live posture: this agent's ed25519 identity
 * and whether its self-signed document actually verifies, the tamper-evident
 * audit chain's length/head and its INDEPENDENT verdict, the active policy,
 * and whether egress is currently blocked.
 *
 * Every function here is a pure string-in/string-out or state-in/state-out
 * transform: no I/O, no timers, no ANSI escapes, no `Date.now()`, no
 * randomness, and no imports from `src/hades/**` or anywhere outside this
 * file's own declarations. Data arrives as plain JSON-compatible rows the
 * orchestrator populates from the same `gov.*` views the desktop lane uses
 * (`src/desktop/ipc/gov-contract.ts`) — a STRUCTURAL, not import, match,
 * exactly how `trust-gate-pane.ts` and `skill-trust-pane.ts` match their
 * hades-side producers with zero adapter code.
 *
 * Visual conventions match `trust-gate-pane.ts` / `schedule-pane.ts`:
 * `╭─╮ │ ├ ┤ ╰─╯` box drawing, a default width of 72 code points, and a hard
 * clamp — no line this module emits ever exceeds the requested width. Width
 * is measured in Unicode code points so multi-byte text never desyncs the
 * border.
 *
 * Honesty discipline (this pane reports security posture, so a reassuring
 * mis-render is worse here than anywhere else in the TUI):
 *  - A BROKEN audit chain renders "BROKEN at #<n>", never a bare count that
 *    could read as healthy. Verified and broken can never both display.
 *  - An identity whose document fails verification renders "UNVERIFIED"
 *    beside the key, not just the key.
 *  - Air-gap renders what actually enforces it; "not enforced" is stated
 *    plainly rather than left blank.
 *  - The pane NEVER displays private key material or token secrets — the
 *    views it consumes do not carry them, and it derives nothing.
 *  - Read-only: this pane has no key bindings that mutate anything. Minting,
 *    rotation, revocation and policy edits live on `hades gov` at a terminal.
 */

// ---------------------------------------------------------------------------
// Row shapes — structurally matching the `gov.*` wire views.
// ---------------------------------------------------------------------------

export interface GovPaneIdentity {
  /** PUBLIC key hex. Never a private half. */
  publicKeyHex: string;
  generation: number;
  keySource: string;
  documentVerified: boolean;
  revokedCount: number;
}

export interface GovPaneAudit {
  length: number;
  headHash: string;
  verified: boolean;
  /** Index of the first broken entry; absent/undefined when verified. */
  brokenAtIndex?: number;
}

export interface GovPanePolicy {
  ruleCount: number;
  digest: string;
  isDefault: boolean;
}

export interface GovPaneAirgap {
  egressBlocked: boolean;
  enforcedBy: string;
}

export interface GovPaneState {
  identity: GovPaneIdentity | null;
  audit: GovPaneAudit | null;
  policy: GovPanePolicy | null;
  airgap: GovPaneAirgap | null;
  /** Set when a `gov.error` arrived; rendered instead of stale values. */
  error: string | null;
}

export const DEFAULT_WIDTH = 72;

export function initGovPane(input: Partial<GovPaneState> = {}): GovPaneState {
  return {
    identity: input.identity ?? null,
    audit: input.audit ?? null,
    policy: input.policy ?? null,
    airgap: input.airgap ?? null,
    error: input.error ?? null,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Strip C0/C1 control characters and ESC so upstream text cannot inject
 *  cursor moves, colour codes or terminal-clear sequences into the pane. */
function sanitize(s: string): string {
  let out = "";
  for (const ch of String(s ?? "")) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

function width(s: string): number {
  return [...s].length;
}

function clamp(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  if (max <= 1) return chars.slice(0, Math.max(0, max)).join("");
  return chars.slice(0, max - 1).join("") + "…";
}

function padTo(s: string, w: number): string {
  const len = width(s);
  return len >= w ? clamp(s, w) : s + " ".repeat(w - len);
}

function border(kind: "top" | "mid" | "bottom", w: number): string {
  const fill = "─".repeat(Math.max(0, w - 2));
  if (kind === "top") return `╭${fill}╮`;
  if (kind === "mid") return `├${fill}┤`;
  return `╰${fill}╯`;
}

function row(text: string, w: number): string {
  return `│${padTo(sanitize(text), Math.max(0, w - 2))}│`;
}

/** Short key form for display: first 8 and last 8 hex chars. */
export function shortKey(hex: string): string {
  const clean = sanitize(hex);
  if (clean.length <= 20) return clean;
  return `${clean.slice(0, 8)}…${clean.slice(-8)}`;
}

/**
 * The audit chain's one-line verdict. A broken chain ALWAYS names the failing
 * index — this is the line that must never let tampering read as health.
 */
export function auditVerdict(audit: GovPaneAudit): string {
  if (!audit.verified) {
    return audit.brokenAtIndex === undefined
      ? "BROKEN (index unknown)"
      : `BROKEN at #${audit.brokenAtIndex}`;
  }
  return audit.length === 0 ? "verified (empty)" : "verified";
}

/** The identity's one-line verdict — an unverified document says so. */
export function identityVerdict(id: GovPaneIdentity): string {
  return id.documentVerified ? "verified" : "UNVERIFIED";
}

/** Air-gap in one line; never blank, never implying enforcement that is absent. */
export function airgapVerdict(a: GovPaneAirgap): string {
  const by = sanitize(a.enforcedBy).trim();
  if (!a.egressBlocked) return `egress ALLOWED (${by.length > 0 ? by : "not enforced"})`;
  return `egress blocked (${by.length > 0 ? by : "enforcement unnamed"})`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export function renderGovPane(state: GovPaneState, w = DEFAULT_WIDTH): string[] {
  const paneWidth = Math.max(24, Math.floor(w));
  const lines: string[] = [];
  lines.push(border("top", paneWidth));
  lines.push(row("GOVERNANCE", paneWidth));
  lines.push(border("mid", paneWidth));

  if (state.error !== null) {
    // An error replaces the values rather than sitting beside possibly-stale
    // ones: a security pane must not show yesterday's "verified" next to a
    // failure to read today's.
    lines.push(row(`error: ${state.error}`, paneWidth));
    lines.push(border("bottom", paneWidth));
    return lines;
  }

  const empty =
    state.identity === null && state.audit === null && state.policy === null && state.airgap === null;
  if (empty) {
    lines.push(row("no governance data reported", paneWidth));
    lines.push(border("bottom", paneWidth));
    return lines;
  }

  const label = 10;

  if (state.identity !== null) {
    const id = state.identity;
    lines.push(row(padTo("identity", label) + `${shortKey(id.publicKeyHex)}  ${identityVerdict(id)}`, paneWidth));
    lines.push(
      row(padTo("", label) + `gen ${id.generation} · ${sanitize(id.keySource)} · ${id.revokedCount} revoked`, paneWidth)
    );
  }

  if (state.audit !== null) {
    const a = state.audit;
    lines.push(row(padTo("audit", label) + `${a.length} entries  ${auditVerdict(a)}`, paneWidth));
    if (a.headHash.length > 0) {
      lines.push(row(padTo("", label) + `head ${shortKey(a.headHash)}`, paneWidth));
    }
  }

  if (state.policy !== null) {
    const p = state.policy;
    const which = p.isDefault ? "built-in default" : `digest ${shortKey(p.digest)}`;
    lines.push(row(padTo("policy", label) + `${p.ruleCount} rules  ${which}`, paneWidth));
  }

  if (state.airgap !== null) {
    lines.push(row(padTo("airgap", label) + airgapVerdict(state.airgap), paneWidth));
  }

  lines.push(border("bottom", paneWidth));
  return lines;
}
