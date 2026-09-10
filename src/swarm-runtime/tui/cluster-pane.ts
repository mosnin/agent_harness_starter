/**
 * cluster-pane.ts — pure, deterministic CLUSTER pane for the interactive TUI
 * (`hades tui`).
 *
 * Renders the multi-node layer's live state: every node's SWIM health, its
 * in-flight leased tasks and load, who currently holds leadership, plus the
 * coordinator's exactly-once accounting (verified / failed / reassigned) and
 * the certificate tally behind it.
 *
 * Every function here is a pure string-in/string-out or state-in/state-out
 * transform: no I/O, no timers, no ANSI escapes, no `Date.now()`, no
 * randomness, and no imports at all. Data arrives as plain JSON-compatible
 * rows the orchestrator populates directly from `ClusterNodeSnapshot`
 * (`swarm-runtime/distributed/cluster-node.ts`), `CoordinatorStats`
 * (`cluster-coordinator.ts`) and `ChaosRunReport` (`cluster-chaos.ts`) — a
 * STRUCTURAL, not import, match, exactly how `route-pane.ts` and
 * `market-pane.ts` match their producers with zero adapter code.
 *
 * Visual conventions match `route-pane.ts` / `render.ts`: `╭─╮ │ ├ ┤ ╰─╯` box
 * drawing, a default width of 72 code points, and a hard clamp — no line this
 * module emits ever exceeds the requested width. Width is measured in Unicode
 * code points (via `[...s].length`) so multi-byte text never desyncs the
 * border.
 *
 * Honesty discipline (this pane reports on whether distributed work actually
 * completed — it must never let an incomplete or unverified run read as a
 * finished one):
 *  - Every number prints verbatim from the row. This module never derives,
 *    sums, or invents a metric of its own; the one comparison it makes
 *    (`verified === submitted`) is a plain equality over two given numbers.
 *  - A run whose `tasksVerified` is short of `tasksSubmitted` renders a
 *    full-width INCOMPLETE alert. A partial distributed run is not a result.
 *  - `certificatesInvalid > 0` renders a full-width alert: a signature that
 *    does not bind the bytes it claims to is a trust failure, not a stat.
 *  - `duplicateVerifications > 0` renders a full-width alert: exactly-once is
 *    the whole point of the fencing/ledger layer, so a breach must be loud.
 *  - A node whose health is not `alive` is annotated with what that means for
 *    its leases, never left as a bare word.
 *  - `leaderId === null` renders as `NO LEADER — placement is blocked
 *    (no quorum)`, because a blank cell would read as "fine".
 *  - Free text (`nodeId`, `health`, `leaderId`) is run through a local
 *    `sanitize` that strips C0/C1 control characters and ESC before it is laid
 *    into a rendered line, so no gossiped node id from a peer machine can
 *    inject cursor moves, colour codes, or terminal-clear sequences into a
 *    local operator's terminal.
 */

// ---------------------------------------------------------------------------
// Row/state shapes (plain, JSON-compatible — no imports)
// ---------------------------------------------------------------------------

/**
 * One cluster node.
 *
 * Structural match for `ClusterNodeSnapshot`
 * (`swarm-runtime/distributed/cluster-node.ts`) with `inFlight` reduced to its
 * count: `nodeId`, `health`, `liveWorkers`, `load`, `completed`, `handedBack`,
 * `abandoned`, `epoch` and `leaderId` line up field for field.
 */
export interface ClusterPaneNodeRow {
  nodeId: string;
  /** `alive` | `draining` | `left` | `crashed` (or a SWIM `suspect`/`dead`). */
  health: string;
  /** Leases currently executing on this node. */
  inFlight: number;
  liveWorkers: number;
  /** In-flight tasks as a fraction of this node's own concurrency cap. */
  load: number;
  completed: number;
  handedBack: number;
  abandoned: number;
  epoch: number;
  /** Who this node believes leads; null when it sees no quorum-backed leader. */
  leaderId: string | null;
}

/**
 * Coordinator-wide accounting.
 *
 * Structural match for `CoordinatorStats` (`cluster-coordinator.ts`) plus the
 * certificate/duplicate tallies `ChaosRunReport` (`cluster-chaos.ts`) measures
 * over a run.
 */
export interface ClusterPaneSummary {
  tasksSubmitted: number;
  tasksVerified: number;
  tasksFailed: number;
  pending: number;
  leased: number;
  reassignments: number;
  /** Reports refused because their fencing token was stale or never issued. */
  staleReportsRejected: number;
  /** Two replicas that disagreed — surfaced, never silently overwritten. */
  conflicts: number;
  /** An exactly-once breach. Any value > 0 is an alert. */
  duplicateVerifications: number;
  certificatesValid: number;
  /** A certificate that did not bind the bytes it claimed to. > 0 is an alert. */
  certificatesInvalid: number;
  /** Real wall-clock span of the measured run, in ms. */
  makespanMs: number;
}

export interface ClusterPaneState {
  rows: ClusterPaneNodeRow[];
  summary: ClusterPaneSummary | null;
  selected: number;
  showDetail: boolean;
}

export const CLUSTER_PANE_DEFAULT_WIDTH = 72;

export function initClusterPane(
  rows: readonly ClusterPaneNodeRow[],
  summary: ClusterPaneSummary | null = null,
): ClusterPaneState {
  return { rows: [...rows], summary, selected: 0, showDetail: false };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Strip C0/C1 control characters and ESC so a gossiped node id from another
 *  machine cannot inject cursor moves, colour codes or terminal-clear
 *  sequences into this operator's terminal. */
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

function fixed(n: number, digits: number): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

/** Who leads, in the pane's own words. A blank cell would read as "fine". */
export function leaderCell(row: ClusterPaneNodeRow): string {
  if (row.leaderId === null || row.leaderId === "") return "NO LEADER";
  return sanitize(row.leaderId);
}

/**
 * The one-line consequence for a node. This is the field that must never let
 * a crashed or departed node read as a normal, healthy row.
 */
export function nodeNote(row: ClusterPaneNodeRow): string {
  switch (row.health) {
    case "crashed":
      return `CRASHED: ${row.abandoned} lease(s) abandoned — reclaimed only on TTL/SWIM timeout`;
    case "dead":
      return "DEAD (SWIM timed it out): its leases are reclaimed and reassigned";
    case "suspect":
      return "SUSPECT: no gossip recently — not yet reclaimed, no new work placed";
    case "left":
      return `LEFT gracefully: ${row.handedBack} lease(s) handed back for reassignment`;
    case "draining":
      return `DRAINING: finishing ${row.inFlight} lease(s), accepting no new work`;
    default:
      break;
  }
  if (row.leaderId === null || row.leaderId === "") {
    return "alive but sees NO LEADER — this node's view has no quorum";
  }
  if (row.inFlight === 0) return `idle: ${row.liveWorkers} live worker(s), ${row.completed} completed`;
  return `running ${row.inFlight} lease(s) on ${row.liveWorkers} worker(s)`;
}

function clampSelection(state: ClusterPaneState, next: number): number {
  if (state.rows.length === 0) return 0;
  if (next < 0) return 0;
  if (next >= state.rows.length) return state.rows.length - 1;
  return next;
}

// ---------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------

/**
 * Advance pane state for one key. Unknown keys return the SAME state object
 * (referential equality), so a caller can cheaply skip a re-render.
 *
 *  - `j` / `down`  — next node
 *  - `k` / `up`    — previous node
 *  - `g` / `home`  — first node
 *  - `G` / `end`   — last node
 *  - `enter` / `l` — toggle the detail block for the selected node
 *  - `escape`      — close the detail block
 */
export function clusterPaneKey(state: ClusterPaneState, key: string): ClusterPaneState {
  switch (key) {
    case "j":
    case "down": {
      const selected = clampSelection(state, state.selected + 1);
      return selected === state.selected ? state : { ...state, selected };
    }
    case "k":
    case "up": {
      const selected = clampSelection(state, state.selected - 1);
      return selected === state.selected ? state : { ...state, selected };
    }
    case "g":
    case "home": {
      const selected = clampSelection(state, 0);
      return selected === state.selected ? state : { ...state, selected };
    }
    case "G":
    case "end": {
      const selected = clampSelection(state, state.rows.length - 1);
      return selected === state.selected ? state : { ...state, selected };
    }
    case "enter":
    case "l":
      return { ...state, showDetail: !state.showDetail };
    case "escape":
      return state.showDetail ? { ...state, showDetail: false } : state;
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function border(kind: "top" | "mid" | "bottom", w: number): string {
  const inner = "─".repeat(Math.max(0, w - 2));
  if (kind === "top") return `╭${inner}╮`;
  if (kind === "bottom") return `╰${inner}╯`;
  return `├${inner}┤`;
}

function row(content: string, w: number): string {
  const inner = Math.max(0, w - 4);
  return `│ ${padTo(clamp(sanitize(content), inner), inner)} │`;
}

/**
 * Render the pane. Never exceeds `width` code points on any line, and always
 * renders an explicit line for the empty case rather than a bare box.
 */
export function renderClusterPane(state: ClusterPaneState, w = CLUSTER_PANE_DEFAULT_WIDTH): string[] {
  const paneWidth = Math.max(24, Math.floor(w));
  const lines: string[] = [];
  lines.push(border("top", paneWidth));
  lines.push(row("CLUSTER", paneWidth));
  lines.push(border("mid", paneWidth));

  if (state.rows.length === 0) {
    lines.push(row("no cluster nodes — this install is running single-node", paneWidth));
    if (state.summary !== null) {
      lines.push(border("mid", paneWidth));
      lines.push(...summaryLines(state.summary, paneWidth));
    }
    lines.push(border("bottom", paneWidth));
    return lines;
  }

  const header =
    padTo("NODE", 16) + padTo("HEALTH", 10) + padTo("FLY", 5) + padTo("WRK", 5) + padTo("LOAD", 6) + "LEADER";
  lines.push(row(header, paneWidth));

  const selected = clampSelection(state, state.selected);
  for (let i = 0; i < state.rows.length; i++) {
    const r = state.rows[i];
    const marker = i === selected ? "›" : " ";
    const line =
      padTo(`${marker}${sanitize(r.nodeId)}`, 16) +
      padTo(sanitize(r.health).slice(0, 9), 10) +
      padTo(String(r.inFlight), 5) +
      padTo(String(r.liveWorkers), 5) +
      padTo(fixed(r.load, 2), 6) +
      leaderCell(r);
    lines.push(row(line, paneWidth));
  }

  lines.push(border("mid", paneWidth));
  for (const r of state.rows) {
    lines.push(row(`${padTo(sanitize(r.nodeId), 16)} ${nodeNote(r)}`, paneWidth));
  }

  if (state.showDetail) {
    const r = state.rows[selected];
    lines.push(border("mid", paneWidth));
    lines.push(row(`DETAIL  ${sanitize(r.nodeId)}`, paneWidth));
    lines.push(row(`  health                ${sanitize(r.health)}`, paneWidth));
    lines.push(row(`  in-flight leases      ${r.inFlight}`, paneWidth));
    lines.push(row(`  live workers          ${r.liveWorkers}`, paneWidth));
    lines.push(row(`  load                  ${fixed(r.load, 4)}`, paneWidth));
    lines.push(row(`  completed             ${r.completed}`, paneWidth));
    lines.push(row(`  handed back           ${r.handedBack}`, paneWidth));
    lines.push(row(`  abandoned             ${r.abandoned}`, paneWidth));
    lines.push(row(`  membership epoch      ${r.epoch}`, paneWidth));
    lines.push(row(`  leader (this view)    ${leaderCell(r)}`, paneWidth));
    lines.push(row(`  consequence           ${nodeNote(r)}`, paneWidth));
  }

  if (state.summary !== null) {
    lines.push(border("mid", paneWidth));
    lines.push(...summaryLines(state.summary, paneWidth));
  }

  lines.push(border("bottom", paneWidth));
  return lines;
}

function summaryLines(s: ClusterPaneSummary, paneWidth: number): string[] {
  const out: string[] = [];
  out.push(
    row(
      `TASKS    ${s.tasksVerified}/${s.tasksSubmitted} verified  ${s.tasksFailed} failed  ` +
        `${s.pending} pending  ${s.leased} leased`,
      paneWidth,
    ),
  );
  out.push(
    row(
      `LEASES   ${s.reassignments} reassigned  ${s.staleReportsRejected} stale-fencing refused  ` +
        `${s.conflicts} conflict(s)`,
      paneWidth,
    ),
  );
  out.push(
    row(`CERTS    ${s.certificatesValid} valid  ${s.certificatesInvalid} invalid  over ${s.makespanMs}ms`, paneWidth),
  );
  if (s.tasksVerified !== s.tasksSubmitted) {
    // Deliberately short enough to survive the default-width clamp intact: a
    // truncated completeness alert is a defeated one.
    out.push(row("RUN      INCOMPLETE — not every submitted task was verified", paneWidth));
  }
  if (s.certificatesInvalid > 0) {
    out.push(row("CERTS    INVALID SIGNATURE(S) — output is NOT certified", paneWidth));
  }
  if (s.duplicateVerifications > 0) {
    out.push(row(`EXACTLY-ONCE BREACHED — ${s.duplicateVerifications} duplicate verification(s)`, paneWidth));
  }
  return out;
}
