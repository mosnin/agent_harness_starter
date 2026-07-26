/**
 * `hades memory <sub>` — search, browse, summarize, and moderate Hades'
 * long-term memory (facts) and session history from the terminal.
 *
 *   hades memory search <query> [--limit N] [--json]
 *   hades memory timeline [--since <ISO|Nd>] [--until <ISO|Nd>] [--json]
 *   hades memory show <session-id>
 *   hades memory summarize <session-id>
 *   hades memory flags [list] [--json]
 *   hades memory flags resolve <id> <accept-new|keep-existing|supersede>
 *   hades memory add <fact>
 *   hades memory help
 *
 * Terminal-free (returns `{ code, lines }`) so it unit-tests without a shell
 * or real stdout, matching the rest of `src/hades/cli/*`.
 *
 * Every real engine — the FTS session index, the STYX memory guard — is
 * consumed only through the structural `MemoryCommandDeps` seam below (plus
 * the type-only `MemoryStore`/`SessionStore` contracts). This file never
 * value-imports `../memory/fts` or a guard module, so it compiles and tests
 * completely independently of whoever wires the real engines together;
 * central integration is responsible for passing the real ones in.
 */
import type { CliResult } from "./cli";
import type { MemoryStore, MemorySearchResult } from "../memory/store";
import type { SessionStore, SessionRecord } from "../memory/session-store";

/** One `hades memory search` session hit — deliberately a plain structural
 *  shape (not `SessionSearchResult`) so any FTS-backed search function can
 *  satisfy it without importing this module's types. */
export interface MemorySessionHit {
  id: string;
  score: number;
  snippet: string;
  title?: string;
  startedAt: number;
}

export interface MemoryFlagRecord {
  id: string;
  verdict: { reasons: string[] };
  candidate: { fact: string };
  at: number;
  resolution?: string;
}

export interface MemoryGuardDeps {
  flags(): MemoryFlagRecord[];
  resolve(id: string, resolution: "accept-new" | "keep-existing" | "supersede"): boolean;
  /**
   * Optional gate-aware write (structurally satisfied by
   * `GuardedMemoryStore.addChecked`). When present, `hades memory add` routes
   * through it and reports a quarantined write honestly — flag id, reasons,
   * and how to resolve — instead of claiming "Remembered" for a fact that
   * never landed in durable memory.
   */
  addChecked?(input: { fact: string; source?: string; salience?: number; tags?: string[] }): {
    verdict: { passed: boolean; reasons: string[] };
    flagged?: { id: string };
  };
}

export interface MemoryCommandDeps {
  memory: MemoryStore;
  sessions: SessionStore;
  searchSessions: (query: string, opts?: { limit?: number }) => MemorySessionHit[];
  summarize?: (sessionId: string) => Promise<{ summary: string; mode: "llm" | "extractive" }>;
  guard?: MemoryGuardDeps;
  now?: () => number;
}

const RESOLUTIONS = ["accept-new", "keep-existing", "supersede"] as const;
type Resolution = (typeof RESOLUTIONS)[number];

const USAGE = [
  "Usage: hades memory <command>",
  "",
  "Commands:",
  "  search <query> [--limit N] [--json]   Search sessions and remembered facts",
  "  timeline [--since S] [--until S]      List sessions chronologically",
  "           [--json]                       (S is an ISO date or '7d'/'24h')",
  "  show <session-id>                     Print a session's full transcript",
  "  summarize <session-id>                Summarize a session",
  "  flags [list] [--json]                 List pending memory-guard flags",
  "  flags resolve <id> <resolution>       Resolve a flag",
  "                                           resolution: accept-new | keep-existing | supersede",
  "  add <fact>                            Remember a new fact",
  "  help                                  Show this help",
];

// ---------------------------------------------------------------------------
// small local formatting helpers (own copies — see module docs)
// ---------------------------------------------------------------------------

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function renderTable(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const widths = headers.map((h, col) => Math.max(h.length, ...rows.map((r) => r[col].length)));
  const renderRow = (cols: string[]): string => cols.map((c, i) => pad(c, widths[i])).join("  ").trimEnd();
  return [renderRow(headers), ...rows.map(renderRow)];
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1))}…` : clean;
}

function isoOf(ms: number | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// ---------------------------------------------------------------------------
// arg parsing helpers
// ---------------------------------------------------------------------------

/** Pulls a boolean `--flag` out of `args` wherever it appears. */
function extractBoolFlag(args: string[], flag: string): { present: boolean; rest: string[] } {
  const idx = args.indexOf(flag);
  if (idx === -1) return { present: false, rest: args };
  return { present: true, rest: [...args.slice(0, idx), ...args.slice(idx + 1)] };
}

/** Pulls a `--flag value` pair out of `args` wherever it appears. `present`
 *  is true whenever the flag token itself was found, even if the following
 *  value is missing (so callers can tell "absent" from "malformed"). */
function extractValueFlag(args: string[], flag: string): { present: boolean; value: string | undefined; rest: string[] } {
  const idx = args.indexOf(flag);
  if (idx === -1) return { present: false, value: undefined, rest: args };
  const value = args[idx + 1];
  const rest = value === undefined ? [...args.slice(0, idx), ...args.slice(idx + 1)] : [...args.slice(0, idx), ...args.slice(idx + 2)];
  return { present: true, value, rest };
}

/** Parses a positive-integer `--limit` value. Returns `{ error }` for a
 *  missing or non-positive-integer value so callers reject it honestly
 *  instead of silently passing NaN downstream. */
function parseLimit(raw: string | undefined, present: boolean, flagName = "--limit"): { limit?: number; error?: string } {
  if (!present) return {};
  if (raw === undefined) return { error: `${flagName} requires a value` };
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return { error: `Invalid ${flagName} value: ${raw}` };
  }
  return { limit: n };
}

/** Parses '--since'/'--until' style time specs: an ISO date/time string, or
 *  a relative offset from `now` like '7d' or '24h'. Returns undefined for
 *  anything malformed — callers turn that into an honest code-1 error
 *  instead of silently computing NaN. */
function parseTimeSpec(raw: string, now: number): number | undefined {
  const rel = raw.match(/^(\d+)(d|h)$/i);
  if (rel) {
    const amount = Number(rel[1]);
    const unitMs = rel[2].toLowerCase() === "d" ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
    return now - amount * unitMs;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

async function cmdSearch(deps: MemoryCommandDeps, args: string[]): Promise<CliResult> {
  let rest = args;
  const jsonFlag = extractBoolFlag(rest, "--json");
  rest = jsonFlag.rest;
  const limitFlag = extractValueFlag(rest, "--limit");
  rest = limitFlag.rest;

  const { limit, error } = parseLimit(limitFlag.value, limitFlag.present);
  if (error) return { code: 1, lines: [error] };

  const query = rest.join(" ").trim();
  if (!query) return { code: 1, lines: ["Usage: hades memory search <query> [--limit N] [--json]"] };

  const opts = limit !== undefined ? { limit } : undefined;
  const sessionHits = deps.searchSessions(query, opts);
  const factHits = deps.memory.search(query, opts);

  if (jsonFlag.present) {
    const payload = {
      query,
      sessions: sessionHits.map((h) => ({
        id: h.id,
        score: h.score,
        title: h.title ?? null,
        startedAt: isoOf(h.startedAt),
        snippet: h.snippet,
      })),
      facts: factHits.map((h) => ({
        id: h.id,
        score: h.score,
        fact: h.fact,
        salience: h.salience,
        tags: h.tags,
        source: h.source ?? null,
        createdAt: isoOf(h.createdAt),
      })),
    };
    return { code: 0, lines: [JSON.stringify(payload, null, 2)] };
  }

  const lines: string[] = [];
  lines.push(`Sessions matching "${query}":`);
  if (sessionHits.length === 0) {
    lines.push("  (no matching sessions)");
  } else {
    const table = renderTable(
      ["SCORE", "STARTED", "ID", "TITLE", "SNIPPET"],
      sessionHits.map((h) => [h.score.toFixed(3), isoOf(h.startedAt) ?? "-", h.id, h.title ?? "(untitled)", truncate(h.snippet, 60)]),
    );
    lines.push(...table.map((l) => `  ${l}`));
  }
  lines.push("");
  lines.push(`Facts matching "${query}":`);
  if (factHits.length === 0) {
    lines.push("  (no matching facts)");
  } else {
    const table = renderTable(
      ["SCORE", "FACT"],
      factHits.map((h: MemorySearchResult) => [h.score.toFixed(3), truncate(h.fact, 80)]),
    );
    lines.push(...table.map((l) => `  ${l}`));
  }
  return { code: 0, lines };
}

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

function cmdTimeline(deps: MemoryCommandDeps, args: string[]): CliResult {
  let rest = args;
  const jsonFlag = extractBoolFlag(rest, "--json");
  rest = jsonFlag.rest;
  const sinceFlag = extractValueFlag(rest, "--since");
  rest = sinceFlag.rest;
  const untilFlag = extractValueFlag(rest, "--until");
  rest = untilFlag.rest;

  if (rest.length > 0) {
    return { code: 1, lines: [`Unexpected argument: ${rest[0]}`, "Usage: hades memory timeline [--since S] [--until S] [--json]"] };
  }

  const now = deps.now ? deps.now() : Date.now();

  let since: number | undefined;
  if (sinceFlag.present) {
    if (sinceFlag.value === undefined) return { code: 1, lines: ["--since requires a value"] };
    since = parseTimeSpec(sinceFlag.value, now);
    if (since === undefined) return { code: 1, lines: [`Invalid --since value: ${sinceFlag.value}`] };
  }
  let until: number | undefined;
  if (untilFlag.present) {
    if (untilFlag.value === undefined) return { code: 1, lines: ["--until requires a value"] };
    until = parseTimeSpec(untilFlag.value, now);
    if (until === undefined) return { code: 1, lines: [`Invalid --until value: ${untilFlag.value}`] };
  }

  const sessions = deps.sessions
    .all()
    .filter((s) => (since === undefined || s.startedAt >= since) && (until === undefined || s.startedAt <= until))
    .sort((a, b) => a.startedAt - b.startedAt);

  if (jsonFlag.present) {
    const payload = sessions.map((s) => ({
      id: s.id,
      title: s.title ?? null,
      startedAt: isoOf(s.startedAt),
      endedAt: isoOf(s.endedAt),
      messageCount: s.messages.length,
    }));
    return { code: 0, lines: [JSON.stringify(payload, null, 2)] };
  }

  if (sessions.length === 0) return { code: 0, lines: ["No sessions recorded."] };

  const table = renderTable(
    ["STARTED", "MESSAGES", "ID", "TITLE"],
    sessions.map((s) => [isoOf(s.startedAt) ?? "-", String(s.messages.length), s.id, s.title ?? "(untitled)"]),
  );
  return { code: 0, lines: table };
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

function formatTranscriptLines(session: SessionRecord): string[] {
  if (session.messages.length === 0) return ["(no messages recorded)"];
  return session.messages.map((m) => `[${isoOf(m.at) ?? "-"}] ${m.role}: ${m.content}`);
}

function cmdShow(deps: MemoryCommandDeps, args: string[]): CliResult {
  const id = args[0];
  if (!id) return { code: 1, lines: ["Usage: hades memory show <session-id>"] };
  const session = deps.sessions.get(id);
  if (!session) return { code: 1, lines: [`No such session: ${id}`] };

  const lines: string[] = [
    `session:  ${session.id}`,
    `title:    ${session.title ?? "(untitled)"}`,
    `started:  ${isoOf(session.startedAt) ?? "-"}`,
    `ended:    ${isoOf(session.endedAt) ?? "(in progress)"}`,
    `tags:     ${session.tags.length ? session.tags.join(", ") : "(none)"}`,
    "",
    ...formatTranscriptLines(session),
  ];
  return { code: 0, lines };
}

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

async function cmdSummarize(deps: MemoryCommandDeps, args: string[]): Promise<CliResult> {
  const id = args[0];
  if (!id) return { code: 1, lines: ["Usage: hades memory summarize <session-id>"] };
  if (!deps.summarize) return { code: 1, lines: ["Summarization is not configured in this build."] };
  const session = deps.sessions.get(id);
  if (!session) return { code: 1, lines: [`No such session: ${id}`] };

  try {
    const { summary, mode } = await deps.summarize(id);
    return {
      code: 0,
      lines: [`mode: ${mode}`, "", summary.trim() ? summary : "(empty summary)"],
    };
  } catch (err) {
    return { code: 1, lines: [err instanceof Error ? err.message : String(err)] };
  }
}

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------

function cmdFlagsList(deps: MemoryCommandDeps, guard: MemoryGuardDeps, args: string[]): CliResult {
  const jsonFlag = extractBoolFlag(args, "--json");
  const flags = guard.flags();

  if (jsonFlag.present) {
    const payload = flags.map((f) => ({
      id: f.id,
      at: isoOf(f.at),
      fact: f.candidate.fact,
      reasons: f.verdict.reasons,
      resolution: f.resolution ?? null,
    }));
    return { code: 0, lines: [JSON.stringify(payload, null, 2)] };
  }

  if (flags.length === 0) return { code: 0, lines: ["No pending memory flags."] };

  const table = renderTable(
    ["ID", "AT", "FACT", "REASONS", "RESOLUTION"],
    flags.map((f) => [
      f.id,
      isoOf(f.at) ?? "-",
      truncate(f.candidate.fact, 50),
      truncate(f.verdict.reasons.join("; "), 40) || "-",
      f.resolution ?? "(pending)",
    ]),
  );
  return { code: 0, lines: table };
}

function cmdFlagsResolve(guard: MemoryGuardDeps, args: string[]): CliResult {
  const [id, resolution] = args;
  const usage = "Usage: hades memory flags resolve <id> <accept-new|keep-existing|supersede>";
  if (!id || !resolution) return { code: 1, lines: [usage] };
  if (!RESOLUTIONS.includes(resolution as Resolution)) {
    return { code: 1, lines: [`Invalid resolution: ${resolution}`, usage] };
  }
  const ok = guard.resolve(id, resolution as Resolution);
  if (!ok) return { code: 1, lines: [`No such flag: ${id}`] };
  return { code: 0, lines: [`Resolved ${id} as ${resolution}.`] };
}

function cmdFlags(deps: MemoryCommandDeps, args: string[]): CliResult {
  if (!deps.guard) return { code: 1, lines: ["The memory guard is not configured in this build."] };
  // `--json` is valid with or without the explicit `list` action (the usage
  // line advertises `flags [list] [--json]`), so extract it before dispatch.
  const jsonFlag = extractBoolFlag(args, "--json");
  const [action, ...rest] = jsonFlag.rest;
  const listArgs = jsonFlag.present ? [...rest, "--json"] : rest;
  if (action === undefined || action === "list") return cmdFlagsList(deps, deps.guard, listArgs);
  if (action === "resolve") return cmdFlagsResolve(deps.guard, rest);
  return { code: 1, lines: [`Unknown flags command: ${action}`, "Run `hades memory help` for usage."] };
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

function cmdAdd(deps: MemoryCommandDeps, args: string[]): CliResult {
  const fact = args.join(" ").trim();
  if (!fact) return { code: 1, lines: ["Usage: hades memory add <fact>"] };

  // When the STYX write-guard exposes its gate-aware add, use it so a
  // quarantined write is reported honestly instead of claiming success.
  if (deps.guard?.addChecked) {
    const { verdict, flagged } = deps.guard.addChecked({ fact, source: "cli", salience: 0.8 });
    if (verdict.passed) return { code: 0, lines: [`Remembered: ${fact}`] };
    return {
      code: 1,
      lines: [
        `Quarantined (not written): ${fact}`,
        `  reasons: ${verdict.reasons.join(", ") || "(none reported)"}`,
        ...(flagged ? [`  flag id: ${flagged.id}`, `  resolve with: hades memory flags resolve ${flagged.id} <accept-new|keep-existing|supersede>`] : []),
      ],
    };
  }

  deps.memory.add({ fact, source: "cli", salience: 0.8 });
  return { code: 0, lines: [`Remembered: ${fact}`] };
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

export async function runMemoryCommand(deps: MemoryCommandDeps, args: string[]): Promise<CliResult> {
  const [sub, ...rest] = args;

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { code: 0, lines: USAGE };
  }

  switch (sub) {
    case "search":
      return cmdSearch(deps, rest);
    case "timeline":
      return cmdTimeline(deps, rest);
    case "show":
      return cmdShow(deps, rest);
    case "summarize":
      return cmdSummarize(deps, rest);
    case "flags":
      return cmdFlags(deps, rest);
    case "add":
      return cmdAdd(deps, rest);
    default:
      return { code: 1, lines: [`Unknown memory command: ${sub}`, "Run `hades memory help` for usage."] };
  }
}
