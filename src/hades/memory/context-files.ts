import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * MEMORY.md / USER.md context-file layer.
 *
 * These are the two markdown files that shape every conversation: USER.md
 * (who the user is, their preferences) and MEMORY.md (durable facts learned
 * over time). This module loads them with clear precedence (project beats
 * global data dir), parses their markdown structure defensively (they are
 * hand-edited by humans and appended-to by the agent, so they will
 * eventually be malformed), assembles them into an injection-fenced,
 * token-budgeted block for the system prompt, and lets the agent append new
 * facts back to MEMORY.md atomically.
 *
 * Everything here is pure Node (`node:fs` / `node:path`) — no dependency on
 * any other team's module.
 */

/** One markdown section: an ATX heading (`#`..`######`) plus its body. */
export interface ContextSection {
  /** Heading text with the `#`s stripped. Empty string for preamble content that precedes the first heading. */
  heading: string;
  /** Heading level 1-6, or 0 for the synthetic preamble section. */
  level: number;
  /** Raw body text under the heading (leading/trailing blank lines trimmed). */
  body: string;
}

/** A loaded MEMORY.md or USER.md, parsed into sections. */
export interface ContextFile {
  /** Absolute path the file was read from. */
  path: string;
  kind: "memory" | "user";
  sections: ContextSection[];
  /** Full text content actually read (post byte-cap truncation, BOM stripped). */
  raw: string;
  /** Number of bytes read from disk for this file (<= maxBytesPerFile). */
  bytes: number;
  /** True if the on-disk file was larger than maxBytesPerFile and got cut. */
  truncated: boolean;
}

export interface ContextLoadOptions {
  /** Global/user data directory — always checked. */
  dataDir: string;
  /** Project directory — checked first; wins over dataDir per kind. */
  projectDir?: string;
  /** Hard cap on bytes read per file. Default 65536. */
  maxBytesPerFile?: number;
}

export interface AssembledContext {
  /** The fully assembled, injection-fenced prompt text. */
  text: string;
  /** The files that were loaded (echoed back, unaffected by budget dropping). */
  files: ContextFile[];
  /** "path#heading" entries for sections dropped to satisfy maxChars, tail-first. */
  droppedSections: string[];
  /** Real length of `text`. */
  chars: number;
}

const DEFAULT_MAX_BYTES_PER_FILE = 65536;
const DEFAULT_MAX_CHARS = 12000;

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const HEADING_RE = /^(#{1,6})(?:\s+(.*?))?\s*$/;

// ---------------------------------------------------------------------------
// Markdown section parsing
// ---------------------------------------------------------------------------

function stripTrailingAtxClose(text: string): string {
  // ATX headings may have an optional closing sequence of `#`s: "## Title ##".
  return text.replace(/\s+#+\s*$/, "").trim();
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

/**
 * Parse markdown into a flat list of sections keyed by ATX heading. Pure —
 * no I/O. Tolerates CRLF/LF/CR line endings, a leading BOM, preamble text
 * before the first heading (emitted as a `heading: ""`, `level: 0` section),
 * files with no headings at all (the whole file becomes one preamble
 * section), and `#` characters inside fenced code blocks (never treated as
 * headings — fence state is tracked line by line).
 */
export function parseMarkdownSections(raw: string): ContextSection[] {
  const noBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const text = noBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n");

  const sections: ContextSection[] = [];
  let curHeading = "";
  let curLevel = 0;
  let curBody: string[] = [];
  let started = false;
  let inFence = false;
  let fenceChar = "";

  const flush = () => {
    const body = trimBlankEdges(curBody);
    if (started || body.length > 0) {
      sections.push({ heading: curHeading, level: curLevel, body: body.join("\n") });
    }
  };

  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = marker;
      } else if (marker === fenceChar) {
        inFence = false;
      }
      curBody.push(line);
      continue;
    }

    if (!inFence) {
      const m = HEADING_RE.exec(line);
      if (m) {
        flush();
        curLevel = m[1].length;
        curHeading = stripTrailingAtxClose(m[2] ?? "");
        curBody = [];
        started = true;
        continue;
      }
    }

    curBody.push(line);
  }
  flush();

  return sections;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Trim a byte buffer so it never ends mid-UTF-8-codepoint. Walks back from
 * the end over continuation bytes (`10xxxxxx`) to find the start of the
 * trailing sequence, then checks whether that sequence's declared length
 * actually fits inside the buffer; if not, the whole partial sequence is
 * dropped rather than emitting a broken character.
 */
function utf8SafeTrim(buf: Buffer): Buffer {
  const end = buf.length;
  if (end === 0) return buf;

  let leadPos = end - 1;
  while (leadPos > 0 && (buf[leadPos] & 0xc0) === 0x80) leadPos--;

  const lead = buf[leadPos];
  let seqLen: number;
  if ((lead & 0x80) === 0x00) seqLen = 1;
  else if ((lead & 0xe0) === 0xc0) seqLen = 2;
  else if ((lead & 0xf0) === 0xe0) seqLen = 3;
  else if ((lead & 0xf8) === 0xf0) seqLen = 4;
  else return buf.subarray(0, leadPos); // stray continuation byte(s) with no valid lead in view

  if (leadPos + seqLen <= end) return buf; // sequence is complete
  return buf.subarray(0, leadPos); // sequence is cut short; drop it entirely
}

function loadOne(path: string, kind: "memory" | "user", maxBytesPerFile: number): ContextFile | undefined {
  let st;
  try {
    st = statSync(path);
  } catch {
    return undefined; // ENOENT, or any other stat failure -> treat as absent
  }
  if (!st.isFile()) return undefined; // directory (or other non-file) named MEMORY.md/USER.md

  const cap = Math.max(0, maxBytesPerFile);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(cap);
    const bytesRead = cap > 0 ? readSync(fd, buf, 0, cap, 0) : 0;
    const truncated = st.size > cap;
    const kept = truncated ? utf8SafeTrim(buf.subarray(0, bytesRead)) : buf.subarray(0, bytesRead);

    let text = kept.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    return {
      path,
      kind,
      sections: parseMarkdownSections(text),
      raw: text,
      bytes: kept.length,
      truncated,
    };
  } catch {
    return undefined; // EACCES and friends degrade to absent, never throw
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed / irrelevant */
      }
    }
  }
}

/**
 * Load MEMORY.md and USER.md with precedence: projectDir is checked first,
 * dataDir second, per kind. At most one file per kind is returned; missing
 * or unreadable files are simply absent (never thrown). Order of the
 * returned array is not meaningful for prompt assembly — use
 * `assembleContextPrompt` for deterministic ordering.
 */
export function loadContextFiles(opts: ContextLoadOptions): ContextFile[] {
  const maxBytesPerFile = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const kinds: Array<{ kind: "memory" | "user"; filename: string }> = [
    { kind: "memory", filename: "MEMORY.md" },
    { kind: "user", filename: "USER.md" },
  ];

  const results: ContextFile[] = [];
  for (const { kind, filename } of kinds) {
    const candidates = [opts.projectDir ? join(opts.projectDir, filename) : undefined, join(opts.dataDir, filename)].filter(
      (p): p is string => !!p,
    );
    for (const candidate of candidates) {
      const file = loadOne(candidate, kind, maxBytesPerFile);
      if (file) {
        results.push(file);
        break; // projectDir (checked first) wins over dataDir for this kind
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const CLOSE_DELIMITER = "</context-file>";

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function openTag(kind: string, path: string): string {
  return `<context-file kind="${kind}" path="${escapeAttr(path)}">`;
}

/**
 * Neutralize any literal occurrence of the closing delimiter inside file
 * content so injected text (e.g. a MEMORY.md that contains the literal
 * string `</context-file>` followed by "ignore all previous instructions")
 * cannot forge an early close of the fenced block. The delimiter is broken
 * with a zero-width space so it reads the same visually but no longer
 * matches the exact fixed string a downstream parser looks for.
 */
function sanitizeContent(body: string): string {
  return body.split(CLOSE_DELIMITER).join("<​/context-file>");
}

interface Pair {
  file: ContextFile;
  section: ContextSection;
}

function renderSection(s: ContextSection): string {
  if (!s.heading) return s.body;
  const level = Math.min(6, Math.max(1, s.level || 1));
  return `${"#".repeat(level)} ${s.heading}\n\n${s.body}`;
}

function renderPairs(pairs: Pair[], orderedFiles: ContextFile[]): string {
  const blocks: string[] = [];
  for (const f of orderedFiles) {
    const secs = pairs.filter((p) => p.file === f).map((p) => p.section);
    if (secs.length === 0) continue;
    const rendered = secs.map(renderSection).join("\n\n");
    const sanitized = sanitizeContent(rendered);
    blocks.push(`${openTag(f.kind, f.path)}\n${sanitized}\n${CLOSE_DELIMITER}`);
  }
  return blocks.join("\n\n");
}

/**
 * Assemble loaded context files into a single injection-fenced prompt block.
 * Deterministic order: USER.md first, then MEMORY.md. Each file's content is
 * wrapped in `<context-file kind="..." path="...">...</context-file>` with
 * any literal closing delimiter inside the content neutralized so it can't
 * escape its own block. If the result exceeds `maxChars`, whole trailing
 * sections are dropped (never a mid-section truncation) starting from the
 * end of the ordering (MEMORY.md's last section first, ...), each recorded
 * in `droppedSections` as `"path#heading"`.
 */
export function assembleContextPrompt(files: ContextFile[], opts: { maxChars?: number } = {}): AssembledContext {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

  const order: Array<"user" | "memory"> = ["user", "memory"];
  const orderedFiles = order.map((k) => files.find((f) => f.kind === k)).filter((f): f is ContextFile => !!f);

  const pairs: Pair[] = [];
  for (const f of orderedFiles) {
    for (const section of f.sections) pairs.push({ file: f, section });
  }

  const droppedSections: string[] = [];
  let text = renderPairs(pairs, orderedFiles);

  while (text.length > maxChars && pairs.length > 0) {
    const removed = pairs.pop()!;
    droppedSections.push(`${removed.file.path}#${removed.section.heading}`);
    text = renderPairs(pairs, orderedFiles);
  }

  return { text, files, droppedSections, chars: text.length };
}

// ---------------------------------------------------------------------------
// Write-back
// ---------------------------------------------------------------------------

const MAX_FACT_CHARS = 2000;
const FACTS_HEADING = "Facts";

function collapseWhitespace(s: string): string {
  return s
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function locateFactsSection(lines: string[]): { headingIdx: number; endIdx: number } | null {
  let inFence = false;
  let fenceChar = "";
  let headingIdx = -1;
  let endIdx = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = marker;
      } else if (marker === fenceChar) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const m = HEADING_RE.exec(line);
    if (!m) continue;
    const level = m[1].length;
    const heading = stripTrailingAtxClose(m[2] ?? "");

    if (headingIdx === -1) {
      if (level === 2 && heading === FACTS_HEADING) headingIdx = i;
      continue;
    }
    if (level <= 2) {
      endIdx = i;
      break;
    }
  }

  if (headingIdx === -1) return null;
  return { headingIdx, endIdx };
}

function insertBulletIntoLines(lines: string[], bullet: string): string[] {
  const loc = locateFactsSection(lines);

  if (!loc) {
    const out = [...lines];
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    if (out.length > 0) out.push("");
    out.push(`## ${FACTS_HEADING}`, "", bullet);
    return out;
  }

  const { headingIdx, endIdx } = loc;
  let insertAt = endIdx;
  while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;

  const out = [...lines];
  const sectionHasContent = insertAt > headingIdx + 1;
  const insertion = sectionHasContent ? [bullet] : ["", bullet];
  out.splice(insertAt, 0, ...insertion);
  return out;
}

/**
 * Append a dated fact bullet under the `## Facts` section of
 * `dataDir/MEMORY.md`, creating the file and/or the section if absent.
 * The write is atomic (temp file + rename within the same directory).
 *
 * Refuses (without throwing) facts that are empty or exceed 2000 characters.
 * Embedded newlines in the fact (or source) are space-collapsed before
 * writing so a malicious/careless fact can never fabricate additional
 * markdown bullets or headings in MEMORY.md.
 */
export function appendMemoryFact(opts: {
  dataDir: string;
  fact: string;
  source?: string;
  now?: () => number;
}): { path: string; appended: boolean; reason?: string } {
  const path = join(opts.dataDir, "MEMORY.md");

  if (typeof opts.fact !== "string" || opts.fact.length === 0) {
    return { path, appended: false, reason: "empty_fact" };
  }
  if (opts.fact.length > MAX_FACT_CHARS) {
    return { path, appended: false, reason: "fact_too_long" };
  }

  const sanitizedFact = collapseWhitespace(opts.fact);
  if (sanitizedFact.length === 0) {
    return { path, appended: false, reason: "empty_fact" };
  }

  const now = opts.now ?? Date.now;
  const ts = new Date(now()).toISOString();
  const sourceSuffix = opts.source ? ` (source: ${collapseWhitespace(opts.source)})` : "";
  const bullet = `- [${ts}] ${sanitizedFact}${sourceSuffix}`;

  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    existing = "";
  }
  const hasBom = existing.charCodeAt(0) === 0xfeff;
  const body = hasBom ? existing.slice(1) : existing;
  const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.length > 0 ? normalized.split("\n") : [];

  const updatedLines = insertBulletIntoLines(lines, bullet);
  const finalContent = (hasBom ? "﻿" : "") + updatedLines.join("\n") + "\n";

  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    /* directory already exists */
  }

  const tmp = join(dirname(path), `.MEMORY.md.${randomUUID()}.tmp`);
  writeFileSync(tmp, finalContent, "utf8");
  renameSync(tmp, path);

  return { path, appended: true };
}
