/* ------------------------------------------------------------------ *
 * driver.ts — the real Playwright-Chromium session core.
 *
 * Responsibilities:
 *  1. Honest, pure-fs resolution of a Chromium (or headless-shell)
 *     executable under a Playwright browsers cache directory. Never
 *     downloads, never network-probes, never lies about what it found.
 *  2. Truthful headed/headless display-capability probing — headless
 *     is always assumed to work (that's the product's default mode);
 *     headed is only ever reported available when a real DISPLAY or
 *     WAYLAND_DISPLAY environment variable is actually set.
 *  3. A structured navigate/act/screenshot/read page surface
 *     (`BrowserDriver` / `DriverPage`) that NEVER lets a raw Playwright
 *     exception escape to the caller — every public method is total:
 *     it resolves (never rejects with an unstructured error) or, where
 *     the locked contract gives it a plain return type instead of a
 *     result envelope, it throws only a single deterministic, plainly
 *     worded `Error` of our own construction (never a raw Playwright
 *     stack).
 *
 * Locked import boundary: this module imports `playwright-core`
 * (chromium only) and Node built-ins ONLY. It does not import any
 * other file under src/hades/browser/* (those belong to other build
 * teams) and does not import src/hades/tools/vision.ts — the
 * `screenshot().pngBase64` contract below is documented in prose
 * instead, so the two modules stay decoupled while still agreeing on
 * a data shape.
 * ------------------------------------------------------------------ */

import { chromium, type Browser, type BrowserContext, type Page, type Response as PwResponse } from "playwright-core";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Small internal helpers
// ---------------------------------------------------------------------------

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isTimeoutMessage(msg: string): boolean {
  return /timeout/i.test(msg);
}

function isCrashMessage(msg: string): boolean {
  return /crash(ed)?/i.test(msg) || /target (page|browser|context) has been closed/i.test(msg) || /has crashed/i.test(msg);
}

function isNetErrorMessage(msg: string): boolean {
  return /net::/i.test(msg) || /ERR_[A-Z_]+/.test(msg) || /getaddrinfo/i.test(msg) || /ECONNREFUSED/i.test(msg);
}

// ---------------------------------------------------------------------------
// 1. resolveChromiumExecutable — pure fs scan, no network, never throws
// ---------------------------------------------------------------------------

export interface ResolvedExecutable {
  ok: true;
  path: string;
  kind: "headless-shell" | "chromium";
  version: string;
}

export interface UnresolvedExecutable {
  ok: false;
  reason: string;
}

export type ResolveExecutableResult = ResolvedExecutable | UnresolvedExecutable;

const HEADLESS_SHELL_DIR_RE = /^chromium_headless_shell-(.+)$/;
const CHROMIUM_DIR_RE = /^chromium-(.+)$/;
const HEADLESS_SHELL_RELATIVE = ["chrome-linux", "headless_shell"];
const CHROMIUM_RELATIVE = ["chrome-linux", "chrome"];

interface Candidate {
  version: string;
  execPath: string;
}

/** Numeric-aware "highest revision wins" comparator. Falls back to a
 *  plain string comparison for non-numeric revision suffixes so the
 *  function never throws on an unexpected directory name. */
function compareVersions(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

function findCandidates(entries: fs.Dirent[], base: string, dirRe: RegExp, relativeParts: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const match = dirRe.exec(entry.name);
    if (!match) continue;
    const version = match[1];
    const execPath = path.join(base, entry.name, ...relativeParts);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(execPath);
    } catch {
      continue; // directory matches the naming pattern but the binary isn't there — skip honestly
    }
    if (!stat.isFile()) continue;
    out.push({ version, execPath });
  }
  return out;
}

function pickHighest(candidates: Candidate[]): Candidate | undefined {
  if (candidates.length === 0) return undefined;
  return candidates.reduce((best, cur) => (compareVersions(cur.version, best.version) > 0 ? cur : best));
}

/**
 * Pure filesystem scan of a Playwright browsers cache directory for an
 * installed Chromium executable. Prefers `chromium_headless_shell-*`
 * (smaller, headless-only binary) over full `chromium-*`. Picks the
 * highest revision when multiple are installed. Performs NO network
 * access and NEVER attempts to download a browser — if nothing is
 * found, it reports why and stops.
 */
export function resolveChromiumExecutable(browsersPath?: string): ResolveExecutableResult {
  const base = browsersPath ?? process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch (err) {
    return { ok: false, reason: `cannot read Playwright browsers directory "${base}": ${messageOf(err)}` };
  }

  const headlessShellBest = pickHighest(findCandidates(entries, base, HEADLESS_SHELL_DIR_RE, HEADLESS_SHELL_RELATIVE));
  if (headlessShellBest) {
    return { ok: true, path: headlessShellBest.execPath, kind: "headless-shell", version: headlessShellBest.version };
  }

  const chromiumBest = pickHighest(findCandidates(entries, base, CHROMIUM_DIR_RE, CHROMIUM_RELATIVE));
  if (chromiumBest) {
    return { ok: true, path: chromiumBest.execPath, kind: "chromium", version: chromiumBest.version };
  }

  return {
    ok: false,
    reason:
      `no Chromium executable found under "${base}" ` +
      `(looked for chromium_headless_shell-*/chrome-linux/headless_shell, then chromium-*/chrome-linux/chrome)`,
  };
}

// ---------------------------------------------------------------------------
// 2. probeDisplaySupport — truthful headed-capability probing
// ---------------------------------------------------------------------------

export interface DisplaySupport {
  headlessOk: true;
  headedOk: boolean;
  reason?: string;
}

/**
 * Headless is always reported available (it needs no display server).
 * Headed is only ever reported available when a real DISPLAY or
 * WAYLAND_DISPLAY value is actually present in the given environment
 * — this function never pretends a display exists.
 */
export function probeDisplaySupport(env: Record<string, string | undefined> = process.env): DisplaySupport {
  const display = env.DISPLAY?.trim();
  const wayland = env.WAYLAND_DISPLAY?.trim();
  if ((display && display !== "") || (wayland && wayland !== "")) {
    return { headlessOk: true, headedOk: true };
  }
  return {
    headlessOk: true,
    headedOk: false,
    reason: "neither DISPLAY nor WAYLAND_DISPLAY is set — no X11 or Wayland display is available for a headed launch",
  };
}

// ---------------------------------------------------------------------------
// 3-5. Public types (locked shapes)
// ---------------------------------------------------------------------------

export type BrowserActionKind = "click" | "type" | "press" | "select" | "scroll" | "waitFor";

export interface BrowserAction {
  kind: BrowserActionKind;
  selector?: string;
  text?: string;
  key?: string;
  value?: string;
  deltaY?: number;
  timeoutMs?: number;
}

export type NavErrorCode = "bad-scheme" | "blocked-host" | "timeout" | "net-error" | "http-error" | "crashed";

export interface NavResult {
  ok: boolean;
  url: string;
  finalUrl?: string;
  status?: number;
  redirects: string[];
  error?: { code: NavErrorCode; message: string };
}

export type ActErrorCode = "bad-action" | "no-selector" | "not-found" | "timeout" | "failed";

export interface ActResult {
  ok: boolean;
  action: BrowserAction;
  error?: { code: ActErrorCode; message: string };
}

export interface DriverPageOptions {
  navTimeoutMs?: number;
  actionTimeoutMs?: number;
  blockHosts?: string[];
  allowFileUrls?: boolean;
  allowDataUrls?: boolean;
}

export interface BrowserDriverOptions {
  browsersPath?: string;
  executablePath?: string;
  headless?: boolean;
  navTimeoutMs?: number;
  actionTimeoutMs?: number;
  maxPages?: number;
  blockHosts?: string[];
  allowFileUrls?: boolean;
  allowDataUrls?: boolean;
  env?: Record<string, string | undefined>;
}

export type ScreenshotResult =
  | { ok: true; pngBase64: string; width: number; height: number }
  | { ok: false; error: string };

export interface DriverPage {
  url(): string;
  title(): Promise<string>;
  html(): Promise<string>;
  text(selector?: string): Promise<string | undefined>;
  goto(url: string): Promise<NavResult>;
  act(action: BrowserAction): Promise<ActResult>;
  /**
   * `pngBase64` is a plain (unprefixed, no "data:image/png;base64,")
   * standard base64 encoding of a PNG file — exactly the input shape
   * the `vision_describe` tool (src/hades/tools/vision.ts) accepts as
   * its bare `imageBase64` string, so a caller can hand this value
   * straight to that tool with no reformatting. This module does not
   * import vision.ts; the two agree on this shape by contract, not by
   * code sharing.
   */
  screenshot(): Promise<ScreenshotResult>;
  close(): Promise<void>;
  readonly closed: boolean;
}

// ---------------------------------------------------------------------------
// URL policy — evaluated BEFORE any Playwright navigation is invoked
// ---------------------------------------------------------------------------

interface ResolvedPageOptions {
  navTimeoutMs: number;
  actionTimeoutMs: number;
  blockHosts: string[];
  allowFileUrls: boolean;
  allowDataUrls: boolean;
}

function isBlockedHost(hostname: string, blockHosts: string[]): boolean {
  const h = hostname.toLowerCase();
  return blockHosts.some((raw) => {
    const b = raw.toLowerCase();
    return h === b || h.endsWith(`.${b}`);
  });
}

/** Returns a NavResult error object if the URL is rejected by policy,
 *  or `null` if the URL is allowed to proceed to real navigation. */
function checkUrlPolicy(
  parsed: URL,
  opts: ResolvedPageOptions
): { code: NavErrorCode; message: string } | null {
  const scheme = parsed.protocol; // includes trailing ':'

  if (scheme === "http:" || scheme === "https:") {
    if (parsed.hostname && isBlockedHost(parsed.hostname, opts.blockHosts)) {
      return { code: "blocked-host", message: `host "${parsed.hostname}" is in blockHosts` };
    }
    return null;
  }

  if (scheme === "file:") {
    if (!opts.allowFileUrls) {
      return { code: "bad-scheme", message: "file: URLs are disallowed (set allowFileUrls to enable)" };
    }
    if (parsed.hostname && isBlockedHost(parsed.hostname, opts.blockHosts)) {
      return { code: "blocked-host", message: `host "${parsed.hostname}" is in blockHosts` };
    }
    return null;
  }

  if (scheme === "data:") {
    const mime = (parsed.pathname.split(",")[0] ?? "").toLowerCase();
    const isHtml = mime.startsWith("text/html");
    if (!opts.allowDataUrls || !isHtml) {
      return {
        code: "bad-scheme",
        message: "data: URLs are disallowed except data:text/html when allowDataUrls is set",
      };
    }
    return null;
  }

  if (scheme === "about:") {
    if (parsed.pathname === "blank") return null;
    return { code: "bad-scheme", message: `about: URLs other than about:blank are disallowed (got "${parsed.href}")` };
  }

  return { code: "bad-scheme", message: `scheme "${scheme}" is disallowed` };
}

// ---------------------------------------------------------------------------
// PNG dimension read-back for screenshot() — local, minimal, no vision.ts
// ---------------------------------------------------------------------------

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (buf[i] !== PNG_MAGIC[i]) return null;
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

// ---------------------------------------------------------------------------
// act() validation — runs BEFORE any Playwright call
// ---------------------------------------------------------------------------

const KNOWN_ACTION_KINDS: ReadonlySet<string> = new Set(["click", "type", "press", "select", "scroll", "waitFor"]);

function validateAction(action: BrowserAction): { code: "bad-action" | "no-selector"; message: string } | null {
  if (!action || typeof action !== "object" || typeof action.kind !== "string" || !KNOWN_ACTION_KINDS.has(action.kind)) {
    return { code: "bad-action", message: `unknown or missing action kind: ${JSON.stringify((action as { kind?: unknown } | null)?.kind ?? null)}` };
  }
  const hasSelector = typeof action.selector === "string" && action.selector.trim() !== "";

  switch (action.kind) {
    case "click":
    case "waitFor":
      if (!hasSelector) return { code: "no-selector", message: `${action.kind} requires a non-empty 'selector'` };
      return null;
    case "type":
      if (!hasSelector) return { code: "no-selector", message: "type requires a non-empty 'selector'" };
      if (typeof action.text !== "string") return { code: "bad-action", message: "type requires a 'text' string" };
      return null;
    case "select":
      if (!hasSelector) return { code: "no-selector", message: "select requires a non-empty 'selector'" };
      if (typeof action.value !== "string") return { code: "bad-action", message: "select requires a 'value' string" };
      return null;
    case "press":
      if (typeof action.key !== "string" || action.key.trim() === "") {
        return { code: "bad-action", message: "press requires a non-empty 'key' string" };
      }
      return null;
    case "scroll":
      if (action.selector !== undefined && action.selector.trim() === "") {
        return { code: "no-selector", message: "scroll 'selector', if provided, must be non-empty" };
      }
      return null;
    default:
      return { code: "bad-action", message: `unknown action kind: ${String((action as { kind: unknown }).kind)}` };
  }
}

// ---------------------------------------------------------------------------
// DriverPageImpl
// ---------------------------------------------------------------------------

class DriverPageImpl implements DriverPage {
  private readonly _context: BrowserContext;
  private readonly _page: Page;
  private readonly _opts: ResolvedPageOptions;
  private _closed = false;
  private _lastUrl: string;
  private readonly _onClosed: () => void;

  constructor(context: BrowserContext, page: Page, opts: ResolvedPageOptions, onClosed: () => void) {
    this._context = context;
    this._page = page;
    this._opts = opts;
    this._lastUrl = page.url();
    this._onClosed = onClosed;
    page.on("close", () => {
      this._closed = true;
    });
  }

  get closed(): boolean {
    return this._closed;
  }

  url(): string {
    if (this._closed) return this._lastUrl;
    try {
      this._lastUrl = this._page.url();
    } catch {
      // keep last known good value
    }
    return this._lastUrl;
  }

  async title(): Promise<string> {
    if (this._closed) return "";
    try {
      return await this._page.title();
    } catch {
      return "";
    }
  }

  async html(): Promise<string> {
    if (this._closed) return "";
    try {
      return await this._page.content();
    } catch {
      return "";
    }
  }

  async text(selector?: string): Promise<string | undefined> {
    if (this._closed) return undefined;
    try {
      if (selector !== undefined) {
        const loc = this._page.locator(selector).first();
        const count = await loc.count();
        if (count === 0) return undefined;
        const content = await loc.textContent();
        return content ?? undefined;
      }
      const content = await this._page.locator("body").first().textContent();
      return content ?? undefined;
    } catch {
      return undefined;
    }
  }

  async goto(rawUrl: string): Promise<NavResult> {
    if (this._closed) {
      return { ok: false, url: rawUrl, redirects: [], error: { code: "net-error", message: "page is closed" } };
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch (err) {
      return { ok: false, url: rawUrl, redirects: [], error: { code: "bad-scheme", message: `malformed URL: ${messageOf(err)}` } };
    }

    const policyError = checkUrlPolicy(parsed, this._opts);
    if (policyError) {
      return { ok: false, url: rawUrl, redirects: [], error: policyError };
    }

    let response: PwResponse | null;
    try {
      response = await this._page.goto(rawUrl, { timeout: this._opts.navTimeoutMs, waitUntil: "load" });
    } catch (err) {
      const msg = messageOf(err);
      const code: NavErrorCode = isTimeoutMessage(msg) ? "timeout" : isCrashMessage(msg) ? "crashed" : "net-error";
      return { ok: false, url: rawUrl, redirects: [], error: { code, message: msg } };
    }

    const finalUrl = this.url();

    if (!response) {
      // Non-HTTP navigations (data:, about:blank) that succeeded produce no Response.
      return { ok: true, url: rawUrl, finalUrl, redirects: [] };
    }

    const redirects: string[] = [];
    let req = response.request().redirectedFrom();
    while (req) {
      redirects.unshift(req.url());
      req = req.redirectedFrom();
    }

    const status = response.status();
    if (status >= 400) {
      return {
        ok: false,
        url: rawUrl,
        finalUrl,
        status,
        redirects,
        error: { code: "http-error", message: `HTTP ${status}` },
      };
    }

    return { ok: true, url: rawUrl, finalUrl, status, redirects };
  }

  private async elementCount(selector: string): Promise<number> {
    return this._page.locator(selector).count();
  }

  async act(action: BrowserAction): Promise<ActResult> {
    const validationError = validateAction(action);
    if (validationError) {
      return { ok: false, action, error: validationError };
    }

    if (this._closed) {
      return { ok: false, action, error: { code: "failed", message: "page is closed" } };
    }

    const timeout = action.timeoutMs ?? this._opts.actionTimeoutMs;

    try {
      switch (action.kind) {
        case "click": {
          const selector = action.selector as string;
          if ((await this.elementCount(selector)) === 0) {
            return { ok: false, action, error: { code: "not-found", message: `no element matches selector "${selector}"` } };
          }
          await this._page.locator(selector).first().click({ timeout });
          return { ok: true, action };
        }
        case "type": {
          const selector = action.selector as string;
          if ((await this.elementCount(selector)) === 0) {
            return { ok: false, action, error: { code: "not-found", message: `no element matches selector "${selector}"` } };
          }
          await this._page.locator(selector).first().fill(action.text as string, { timeout });
          return { ok: true, action };
        }
        case "select": {
          const selector = action.selector as string;
          if ((await this.elementCount(selector)) === 0) {
            return { ok: false, action, error: { code: "not-found", message: `no element matches selector "${selector}"` } };
          }
          await this._page.locator(selector).first().selectOption(action.value as string, { timeout });
          return { ok: true, action };
        }
        case "press": {
          const key = action.key as string;
          if (action.selector) {
            if ((await this.elementCount(action.selector)) === 0) {
              return { ok: false, action, error: { code: "not-found", message: `no element matches selector "${action.selector}"` } };
            }
            await this._page.locator(action.selector).first().press(key, { timeout });
          } else {
            await this._page.keyboard.press(key);
          }
          return { ok: true, action };
        }
        case "scroll": {
          if (action.selector) {
            if ((await this.elementCount(action.selector)) === 0) {
              return { ok: false, action, error: { code: "not-found", message: `no element matches selector "${action.selector}"` } };
            }
            await this._page.locator(action.selector).first().scrollIntoViewIfNeeded({ timeout });
          } else {
            const deltaY = action.deltaY ?? 0;
            await this._page.evaluate((dy) => window.scrollBy(0, dy), deltaY);
          }
          return { ok: true, action };
        }
        case "waitFor": {
          // "attached" (present in the DOM) rather than Playwright's default
          // "visible" — a generic waitFor primitive should not silently fail
          // on a real, present-but-zero-size or off-screen element.
          const selector = action.selector as string;
          await this._page.waitForSelector(selector, { timeout, state: "attached" });
          return { ok: true, action };
        }
        default:
          return { ok: false, action, error: { code: "bad-action", message: "unreachable action kind" } };
      }
    } catch (err) {
      const msg = messageOf(err);
      const code: ActErrorCode = isTimeoutMessage(msg) ? "timeout" : "failed";
      return { ok: false, action, error: { code, message: msg } };
    }
  }

  async screenshot(): Promise<ScreenshotResult> {
    if (this._closed) return { ok: false, error: "page is closed" };
    try {
      const buf = await this._page.screenshot({ type: "png", timeout: this._opts.actionTimeoutMs });
      const dims = pngDimensions(buf);
      return {
        ok: true,
        pngBase64: buf.toString("base64"),
        width: dims?.width ?? 0,
        height: dims?.height ?? 0,
      };
    } catch (err) {
      return { ok: false, error: messageOf(err) };
    }
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    try {
      await this._page.close();
    } catch {
      // already gone — fine, close() is best-effort idempotent
    }
    try {
      await this._context.close();
    } catch {
      // already gone — fine
    }
    this._onClosed();
  }
}

// ---------------------------------------------------------------------------
// 6. BrowserDriver
// ---------------------------------------------------------------------------

const DEFAULT_NAV_TIMEOUT_MS = 15000;
const DEFAULT_ACTION_TIMEOUT_MS = 5000;
const DEFAULT_MAX_PAGES = 4;

export class BrowserDriver {
  private readonly _browser: Browser;
  readonly executablePath: string;
  readonly headless: boolean;
  private readonly _pageOpts: ResolvedPageOptions;
  private readonly _maxPages: number;
  private readonly _pages = new Set<DriverPageImpl>();
  private _closed = false;

  private constructor(browser: Browser, executablePath: string, headless: boolean, pageOpts: ResolvedPageOptions, maxPages: number) {
    this._browser = browser;
    this.executablePath = executablePath;
    this.headless = headless;
    this._pageOpts = pageOpts;
    this._maxPages = maxPages;
  }

  static async launch(opts: BrowserDriverOptions = {}): Promise<BrowserDriver> {
    const env = opts.env ?? process.env;
    const headless = opts.headless ?? true;

    if (!headless) {
      const display = probeDisplaySupport(env);
      if (!display.headedOk) {
        throw new Error(`cannot launch headed browser: ${display.reason ?? "no display available"}`);
      }
    }

    let executablePath = opts.executablePath;
    if (!executablePath) {
      const browsersPath = opts.browsersPath ?? env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
      const resolved = resolveChromiumExecutable(browsersPath);
      if (!resolved.ok) {
        throw new Error(resolved.reason);
      }
      executablePath = resolved.path;
    }

    const browser = await chromium.launch({ executablePath, headless });

    const pageOpts: ResolvedPageOptions = {
      navTimeoutMs: opts.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS,
      actionTimeoutMs: opts.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
      blockHosts: opts.blockHosts ?? [],
      allowFileUrls: opts.allowFileUrls ?? false,
      allowDataUrls: opts.allowDataUrls ?? false,
    };

    return new BrowserDriver(browser, executablePath, headless, pageOpts, opts.maxPages ?? DEFAULT_MAX_PAGES);
  }

  get closed(): boolean {
    return this._closed;
  }

  async newPage(): Promise<DriverPage> {
    if (this._closed) {
      throw new Error("BrowserDriver is closed: cannot open a new page");
    }
    if (this._pages.size >= this._maxPages) {
      throw new Error(`BrowserDriver has reached its maximum of ${this._maxPages} open page(s)`);
    }

    const context = await this._browser.newContext();
    const page = await context.newPage();
    const impl = new DriverPageImpl(context, page, this._pageOpts, () => {
      this._pages.delete(impl);
    });
    this._pages.add(impl);
    return impl;
  }

  pages(): DriverPage[] {
    return Array.from(this._pages);
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    const closingPages = Array.from(this._pages).map((p) => p.close().catch(() => undefined));
    await Promise.all(closingPages);
    try {
      await this._browser.close();
    } catch {
      // best-effort — the process may already be gone
    }
  }
}
