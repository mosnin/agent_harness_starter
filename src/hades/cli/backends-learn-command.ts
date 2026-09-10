/**
 * `hades backends learn` — surfaces `SwarmLearningStatus` on the CLI,
 * honestly distinguishing a live in-process loop from a durable snapshot
 * (`FileLearningStatusStore`, `../backends/learning-status-store.ts`) and
 * from having nothing recorded at all yet.
 *
 * This module never recomputes or reinterprets a single figure: rendering is
 * entirely delegated to the real `renderLearningReport`
 * (`../backends/swarm-learning.ts`) — the only thing this file adds is a
 * one-line `source:` header (live vs. snapshot, with the snapshot's age) and
 * control-character sanitization of every dynamic string before it reaches
 * the terminal.
 */

import type { CliResult } from "./cli";
import { renderLearningReport, type SwarmLearningLoop, type SwarmLearningStatus } from "../backends/swarm-learning";
import { FileLearningStatusStore, LEARNING_STATUS_VERSION, type PersistedLearningStatus } from "../backends/learning-status-store";

// ===========================================================================
// Public types
// ===========================================================================

export interface BackendsLearnCommandDeps {
  store: FileLearningStatusStore;
  /** The live loop, when a swarm is running in-process. When present, `show`
   *  and `json` always report against it (never the possibly-stale on-disk
   *  snapshot) and are labelled `source: live`. */
  loop?: SwarmLearningLoop;
  /** ms clock, default `() => Date.now()`. Injectable for deterministic
   *  age-of-snapshot rendering in tests. */
  now?: () => number;
}

// ===========================================================================
// Internals
// ===========================================================================

/** Strips ASCII control characters (0x00-0x1F, 0x7F) from any string before
 *  it is echoed into an output line — same convention as
 *  `backends-command.ts`'s local `sanitize`, deliberately re-implemented
 *  here rather than imported (own-files-only import discipline). Guards
 *  against a crafted arm name / usdNote / elapsedMsNote injecting ANSI or
 *  CR/LF sequences into the CLI's output stream. */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1F\x7F]/g, "");
}

function sanitizeLines(lines: string[]): string[] {
  return lines.map(sanitize);
}

const NOTHING_RECORDED_LINE =
  "No learning status recorded yet — run a swarm with the learning loop attached.";

const USAGE: string[] = [
  "Usage: hades backends learn <subcommand>",
  "",
  "Subcommands:",
  "  show    Render the learning status report (default when no subcommand given)",
  "  json    Print the learning status as JSON (envelope includes a source field)",
  "  help    Show this help",
  "",
  "source: \"live\" when a swarm's learning loop is attached in-process for this",
  "process; otherwise the most recently persisted snapshot on disk, labelled",
  "with how long ago it was saved. Nothing recorded yet is reported honestly,",
  "never guessed at.",
];

function formatAge(ms: number): string {
  const clamped = ms < 0 ? 0 : ms;
  const sec = Math.floor(clamped / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const days = Math.floor(hr / 24);
  return `${days}d`;
}

function snapshotHeader(at: number, nowMs: number): string {
  const iso = new Date(at).toISOString();
  const age = formatAge(nowMs - at);
  return `source: snapshot (saved ${iso}, ${age} ago)`;
}

// ===========================================================================
// Subcommands
// ===========================================================================

async function cmdShow(deps: BackendsLearnCommandDeps): Promise<CliResult> {
  if (deps.loop) {
    const status: SwarmLearningStatus = deps.loop.status();
    return { code: 0, lines: sanitizeLines(["source: live", ...renderLearningReport(status)]) };
  }

  const snapshot = await deps.store.load();
  if (!snapshot) {
    return { code: 0, lines: [NOTHING_RECORDED_LINE] };
  }

  const now = deps.now ?? (() => Date.now());
  const header = snapshotHeader(snapshot.at, now());
  return { code: 0, lines: sanitizeLines([header, ...renderLearningReport(snapshot.status)]) };
}

async function cmdJson(deps: BackendsLearnCommandDeps): Promise<CliResult> {
  const now = deps.now ?? (() => Date.now());

  if (deps.loop) {
    const persisted: PersistedLearningStatus = {
      version: LEARNING_STATUS_VERSION,
      at: now(),
      status: deps.loop.status(),
    };
    const envelope = { ...persisted, source: "live" as const };
    return { code: 0, lines: [JSON.stringify(envelope)] };
  }

  const snapshot = await deps.store.load();
  if (!snapshot) {
    return { code: 0, lines: [NOTHING_RECORDED_LINE] };
  }
  const envelope = { ...snapshot, source: "snapshot" as const };
  return { code: 0, lines: [JSON.stringify(envelope)] };
}

// ===========================================================================
// Entry point
// ===========================================================================

/**
 * Routes `hades backends learn [subcommand]`. `show` is the default when
 * `args` is empty. An unknown subcommand exits with code 1 and the usage
 * lines; `help` (and the empty/`show` paths) always exit 0.
 */
export async function runBackendsLearnCommand(args: string[], deps: BackendsLearnCommandDeps): Promise<CliResult> {
  const subcommand = args[0] ?? "show";

  switch (subcommand) {
    case "show":
      return cmdShow(deps);
    case "json":
      return cmdJson(deps);
    case "help":
      return { code: 0, lines: USAGE };
    default:
      return { code: 1, lines: [`Unknown subcommand: ${sanitize(subcommand)}`, ...USAGE] };
  }
}
