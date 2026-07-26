/* ------------------------------------------------------------------ *
 * browser — a `web` category CatalogEntry: the product-facing surface
 * of the Playwright-Chromium browsing stack.
 *
 * This file defines the EXECUTION SEAM (`BrowseRequest` / `BrowsePassage`
 * / `BrowseOutcome` / `BrowseRunner`) that central integration wires up
 * from the real engine (`driver.ts` navigates/acts, `extract.ts` turns a
 * page into hash-cited passages, `trace.ts` builds the hash-chained
 * event ledger and its root). This module never imports those files
 * directly — they belong to other build teams in this cycle — so the
 * runner is always INJECTED via `BrowserToolOptions.runner`, exactly
 * like `fetch_extract`'s `fetchFn` or `image_gen`'s provider key. When
 * no runner is wired in (or Chromium itself is not actually installed),
 * this tool is honest about it: it serves a clearly `"[mock]"`-labelled,
 * deterministic stand-in and NEVER pretends to have browsed anything.
 *
 * REAL mode requires BOTH:
 *   1. a `runner: BrowseRunner` was injected, AND
 *   2. `probeChromium(browsersPath)` finds an actual installed Chromium
 *      (or headless-shell) executable on disk.
 * Mode is decided ONCE, at construction time — never per call, and never
 * from any signal the caller can spoof through the input JSON.
 *
 * The Chromium probe below is this module's OWN small, independent
 * filesystem check (readdir + stat, no network, no spawn). It is
 * deliberately NOT `driver.ts#resolveChromiumExecutable` — importing
 * that module would violate the no-cross-team-import boundary for this
 * file. The two checks are reconciled at central-integration time (both
 * scan the same `chromium_headless_shell-<rev>/chrome-linux/headless_shell`
 * and `chromium-<rev>/chrome-linux/chrome` layout under a Playwright browsers
 * cache directory); until then this probe stands on its own honest
 * fs-scan rather than trusting an unverified claim.
 *
 * INPUT is a strict JSON object: only `op:"browse"` is understood. Every
 * rejection path returns a single, LOCKED, machine-readable error code
 * (`"bad-json" | "bad-op" | "bad-url" | "bad-actions" | "bad-field"`) so
 * callers can branch on the failure without parsing prose. Hostile input
 * (huge strings, prototype-pollution-shaped keys, wrong-typed fields,
 * oversized action arrays, non-http(s) schemes such as `javascript:`,
 * `data:`, `file:`) is rejected fast and specifically, never crashes the
 * process and never silently coerces.
 *
 * OUTPUT is a single-line JSON object with a LOCKED field order. Real
 * mode maps the injected runner's `BrowseOutcome` onto that shape
 * verbatim; mock mode is fully deterministic from the input alone (same
 * url in ⇒ byte-identical output out, forever) — no network, no clock,
 * no randomness, ever, in mock mode.
 * ------------------------------------------------------------------ */

import type { CatalogEntry, ToolFactoryOptions } from "../tools/catalog";
import type { Tool, ToolResult } from "../agent/tools";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Locked execution seam — central integration composes the real runner
// from driver.ts + extract.ts + trace.ts and injects it as `opts.runner`.
// ---------------------------------------------------------------------------

/** One scripted browser interaction. `kind` is intentionally an open
 *  string here (this module does not own the action vocabulary — the
 *  real driver does); this seam only validates SHAPE, not semantics. */
export interface BrowseAction {
  kind: string;
  selector?: string;
  text?: string;
  value?: string;
  key?: string;
  deltaY?: number;
}

export interface BrowseRequest {
  url: string;
  question?: string;
  maxBytes: number;
  actions: BrowseAction[];
}

export interface BrowsePassage {
  text: string;
  sourceUrl: string;
  selectorPath: string;
  sha256: string;
}

export interface BrowseOutcome {
  ok: boolean;
  url: string;
  finalUrl: string;
  title: string;
  content: string;
  passages: BrowsePassage[];
  traceRoot: string;
  eventCount: number;
  truncated: boolean;
  error?: string;
}

export type BrowseRunner = (req: BrowseRequest) => Promise<BrowseOutcome>;

// ---------------------------------------------------------------------------
// Locked public ids
// ---------------------------------------------------------------------------

export const BROWSER_TOOL_ID = "browser";
export const BROWSER_VERIFIER_ID = "verify.browser";

const TOOL_NAME = BROWSER_TOOL_ID;

export interface BrowserToolOptions extends ToolFactoryOptions {
  /** Playwright browsers cache directory to probe. Defaults to
   *  `opts.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers"`. */
  browsersPath?: string;
  /** The real browse implementation, composed at central-integration
   *  time from driver.ts + extract.ts + trace.ts. Undefined ⇒ mock. */
  runner?: BrowseRunner;
  /** Override the Chromium-installed probe (tests inject a stub).
   *  Defaults to `defaultProbeChromium`. */
  probeChromium?: (browsersPath: string) => boolean;
}

// ---------------------------------------------------------------------------
// Default Chromium probe — independent, pure fs-scan, never throws.
// ---------------------------------------------------------------------------

const HEADLESS_SHELL_DIR_RE = /^chromium_headless_shell-.+$/;
const CHROMIUM_DIR_RE = /^chromium-.+$/;

/**
 * True iff `browsersPath` contains an installed Chromium (preferring the
 * smaller `chromium_headless_shell-*` layout, falling back to full
 * `chromium-*`) with its executable actually present on disk. Pure
 * filesystem read — no spawn, no network, no download attempt. Any
 * filesystem error (missing directory, permission denied, ...) is
 * reported honestly as "not found" rather than thrown.
 */
export function defaultProbeChromium(browsersPath: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(browsersPath, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    let execPath: string | null = null;
    if (HEADLESS_SHELL_DIR_RE.test(entry.name)) {
      execPath = path.join(browsersPath, entry.name, "chrome-linux", "headless_shell");
    } else if (CHROMIUM_DIR_RE.test(entry.name)) {
      execPath = path.join(browsersPath, entry.name, "chrome-linux", "chrome");
    }
    if (execPath === null) continue;
    try {
      if (fs.statSync(execPath).isFile()) return true;
    } catch {
      // Directory name matched the pattern but the binary isn't actually
      // there (partial/broken install) — keep scanning honestly.
      continue;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Input protocol — strict JSON, LOCKED error codes
// ---------------------------------------------------------------------------

export type BrowseErrorCode = "bad-json" | "bad-op" | "bad-url" | "bad-actions" | "bad-field";

interface ParsedBrowseInput {
  url: string;
  question?: string;
  maxBytes: number;
  actions: BrowseAction[];
}

type ParseOutcome = { ok: true; value: ParsedBrowseInput } | { ok: false; code: BrowseErrorCode; detail: string };

const DEFAULT_MAX_BYTES = 200_000;
const MIN_MAX_BYTES = 1_000;
const MAX_MAX_BYTES = 1_000_000;
const MAX_ACTIONS = 16;
const MAX_INPUT_CHARS = 2_000_000; // ~2MB of JSON text — reject huge input fast, before parsing.

function clampMaxBytes(n: number): number {
  const floored = Math.floor(n);
  return Math.max(MIN_MAX_BYTES, Math.min(MAX_MAX_BYTES, floored));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function validateUrl(raw: unknown): { ok: true; url: string } | { ok: false } {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false };
  return { ok: true, url: raw };
}

function validateAction(raw: unknown): { ok: true; action: BrowseAction } | { ok: false; code: BrowseErrorCode } {
  if (!isPlainObject(raw)) return { ok: false, code: "bad-actions" };
  const kind = raw.kind;
  if (typeof kind !== "string" || kind.length === 0) return { ok: false, code: "bad-field" };

  const action: BrowseAction = { kind };

  for (const field of ["selector", "text", "value", "key"] as const) {
    const v = raw[field];
    if (v === undefined) continue;
    if (typeof v !== "string") return { ok: false, code: "bad-field" };
    action[field] = v;
  }

  if (raw.deltaY !== undefined) {
    if (typeof raw.deltaY !== "number" || !Number.isFinite(raw.deltaY)) return { ok: false, code: "bad-field" };
    action.deltaY = raw.deltaY;
  }

  return { ok: true, action };
}

/**
 * Strictly validate a raw JSON string against the locked `browser` input
 * protocol. Total: never throws, always returns a discriminated result.
 * Malformed keys such as `__proto__` / `constructor` are read as plain
 * own-enumerable JSON properties (that is what `JSON.parse` produces —
 * it never mutates `Object.prototype`) and cause no pollution because
 * this function only ever reads named fields off the parsed object; it
 * never merges/spreads/assigns the parsed object itself anywhere.
 */
export function validateBrowseInput(input: string): ParseOutcome {
  if (typeof input !== "string" || input.length > MAX_INPUT_CHARS) {
    return { ok: false, code: "bad-json", detail: "input exceeds maximum size" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { ok: false, code: "bad-json", detail: "input is not valid JSON" };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, code: "bad-json", detail: "input must be a JSON object" };
  }

  const op = parsed.op;
  if (op !== "browse") {
    return { ok: false, code: "bad-op", detail: `unsupported op ${JSON.stringify(op)}; expected "browse"` };
  }

  const urlResult = validateUrl(parsed.url);
  if (!urlResult.ok) {
    return { ok: false, code: "bad-url", detail: "'url' must be a non-empty http(s) URL" };
  }

  let question: string | undefined;
  if (parsed.question !== undefined) {
    if (typeof parsed.question !== "string") {
      return { ok: false, code: "bad-field", detail: "'question' must be a string" };
    }
    question = parsed.question;
  }

  let maxBytes = DEFAULT_MAX_BYTES;
  if (parsed.maxBytes !== undefined) {
    if (typeof parsed.maxBytes !== "number" || !Number.isFinite(parsed.maxBytes)) {
      return { ok: false, code: "bad-field", detail: "'maxBytes' must be a finite number" };
    }
    maxBytes = clampMaxBytes(parsed.maxBytes);
  }

  let actions: BrowseAction[] = [];
  if (parsed.actions !== undefined) {
    if (!Array.isArray(parsed.actions)) {
      return { ok: false, code: "bad-actions", detail: "'actions' must be an array" };
    }
    if (parsed.actions.length > MAX_ACTIONS) {
      return { ok: false, code: "bad-actions", detail: `'actions' exceeds maximum of ${MAX_ACTIONS} items` };
    }
    const validated: BrowseAction[] = [];
    for (const raw of parsed.actions) {
      const result = validateAction(raw);
      if (!result.ok) {
        return { ok: false, code: result.code, detail: `invalid action: ${JSON.stringify(raw)}` };
      }
      validated.push(result.action);
    }
    actions = validated;
  }

  const value: ParsedBrowseInput = { url: urlResult.url, maxBytes, actions };
  if (question !== undefined) value.question = question;
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

export interface BrowserToolOutput {
  mode: "real" | "mock";
  op: "browse";
  url: string;
  finalUrl: string;
  title: string;
  content: string;
  passages: BrowsePassage[];
  traceRoot: string;
  eventCount: number;
  truncated: boolean;
  note?: string;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Mock path — fully deterministic from `url` alone, no network, no clock.
// ---------------------------------------------------------------------------

function buildMockOutput(url: string, reason: string): BrowserToolOutput {
  const content = `[mock] browse of ${url} — no Chromium executable or runner available; deterministic stand-in.`;
  const passage: BrowsePassage = {
    text: content,
    sourceUrl: url,
    selectorPath: "mock:0",
    sha256: sha256Hex(content),
  };
  return {
    mode: "mock",
    op: "browse",
    url,
    finalUrl: url,
    title: "[mock] browser",
    content,
    passages: [passage],
    traceRoot: sha256Hex(`mock-trace:${url}`),
    eventCount: 0,
    truncated: false,
    note: `[mock] ${reason}`,
  };
}

// ---------------------------------------------------------------------------
// Real path — runner outcome mapped verbatim onto the locked output shape.
// ---------------------------------------------------------------------------

function buildRealOutput(req: BrowseRequest, outcome: BrowseOutcome): BrowserToolOutput {
  return {
    mode: "real",
    op: "browse",
    url: outcome.url,
    finalUrl: outcome.finalUrl,
    title: outcome.title,
    content: outcome.content,
    passages: outcome.passages,
    traceRoot: outcome.traceRoot,
    eventCount: outcome.eventCount,
    truncated: outcome.truncated,
  };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

const DESCRIPTION =
  'Browse a web page with a real Chromium session. Input is strict JSON ' +
  '{"op":"browse","url":string (http/https),"question"?:string,' +
  '"maxBytes"?:number (default 200000, clamped to [1000,1000000]),' +
  '"actions"?:[{"kind":string,"selector"?:string,"text"?:string,"value"?:string,' +
  '"key"?:string,"deltaY"?:number}] (max 16)}. Returns single-line JSON ' +
  '{"mode":"real"|"mock","op":"browse","url","finalUrl","title","content",' +
  '"passages":[{"text","sourceUrl","selectorPath","sha256"}],"traceRoot",' +
  '"eventCount","truncated","note"?}. Runs for real only when both a browse ' +
  "runner is wired in and an installed Chromium executable is actually found " +
  "on disk; otherwise serves a clearly \"[mock]\"-labelled deterministic " +
  "stand-in without touching the network.";

/**
 * Build the `browser` CatalogEntry. Mode is decided ONCE, at construction
 * time, from `opts.runner` and `opts.probeChromium(browsersPath)` — never
 * per call, and never from anything the caller's input JSON can control.
 */
export function createBrowserTool(opts: BrowserToolOptions = {}): CatalogEntry {
  const browsersPath = opts.browsersPath ?? opts.env?.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  const probe = opts.probeChromium ?? defaultProbeChromium;
  const runner = opts.runner;

  let chromiumFound = false;
  try {
    chromiumFound = probe(browsersPath);
  } catch {
    // A hostile/throwing probe override must not crash tool construction —
    // treat it the same as "not found", honestly.
    chromiumFound = false;
  }

  const mode: "real" | "mock" = runner !== undefined && chromiumFound ? "real" : "mock";

  const mockReason: string =
    runner === undefined && !chromiumFound
      ? "no browse runner was provided and no Chromium executable was found; deterministic stand-in used."
      : runner === undefined
        ? "no browse runner was provided; deterministic stand-in used."
        : `no Chromium executable was found under "${browsersPath}"; deterministic stand-in used.`;

  const run: Tool["run"] = async (input: string): Promise<ToolResult> => {
    const validated = validateBrowseInput(input);
    if (!validated.ok) {
      return { ok: false, output: JSON.stringify({ error: validated.code, detail: validated.detail }) };
    }
    const { url, question, maxBytes, actions } = validated.value;

    if (mode === "mock") {
      return { ok: true, output: JSON.stringify(buildMockOutput(url, mockReason)) };
    }

    const req: BrowseRequest = { url, maxBytes, actions };
    if (question !== undefined) req.question = question;

    let outcome: BrowseOutcome;
    try {
      outcome = await (runner as BrowseRunner)(req);
    } catch (err) {
      return { ok: false, output: JSON.stringify({ error: "browse-failed", detail: messageOf(err) }) };
    }

    if (!outcome || outcome.ok !== true) {
      const detail = outcome && typeof outcome.error === "string" ? outcome.error : "browse failed";
      return { ok: false, output: JSON.stringify({ error: "browse-failed", detail }) };
    }

    return { ok: true, output: JSON.stringify(buildRealOutput(req, outcome)) };
  };

  const tool: Tool = {
    name: TOOL_NAME,
    description: DESCRIPTION,
    run,
  };

  return {
    tool,
    id: BROWSER_TOOL_ID,
    category: "web",
    mode,
    requiresNetwork: true,
    requiredEnvKeys: [],
    verifierId: BROWSER_VERIFIER_ID,
  };
}
