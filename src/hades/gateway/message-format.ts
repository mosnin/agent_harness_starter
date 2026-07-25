/**
 * Per-platform message formatting: max-length limits, markdown-vs-plain
 * styling, chunking of over-long replies, and rendering of the trust badge
 * line (see ./badge.ts) into each platform's preferred style.
 *
 * Pure: no I/O, no clock, no gateway runtime imports — this module only
 * needs to know the shape of a {@link StampedReply} (imported as a
 * type-only, erased-at-build reference from ./badge to avoid a runtime
 * circular dependency with the module that renders badges by default).
 *
 * @module hades/gateway/message-format
 */

import type { StampedReply } from "./badge";

// ---------------------------------------------------------------------------
// Platform table (LOCKED)
// ---------------------------------------------------------------------------

export interface PlatformFormat {
  maxChars: number;
  style: "markdown" | "plain";
}

/**
 * Per-platform delivery limits and text style. Unknown platforms — including
 * this codebase's own "cli" / "generic" gateway platforms — fall through to
 * the generic {4000, plain} entry rather than throwing, since new delivery
 * surfaces should degrade safely instead of failing formatting.
 */
export function platformFormat(platform: string): PlatformFormat {
  switch (platform) {
    case "telegram":
      return { maxChars: 4096, style: "markdown" };
    case "discord":
      return { maxChars: 2000, style: "markdown" };
    case "slack":
      return { maxChars: 40000, style: "markdown" };
    case "whatsapp":
      return { maxChars: 65536, style: "plain" };
    case "signal":
      return { maxChars: 2000, style: "plain" };
    case "email":
      return { maxChars: 100000, style: "plain" };
    default:
      return { maxChars: 4000, style: "plain" };
  }
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Find the best place to cut `text` at or before `max` UTF-16 code units,
 * preferring (in order) a paragraph boundary ("\n\n"), a line boundary
 * ("\n"), a word boundary (" "), or — failing all of those — a hard cut that
 * never lands inside a surrogate pair.
 *
 * The boundary character(s) are kept at the end of `head` so no leading
 * whitespace is introduced into `rest`.
 */
function splitAt(text: string, max: number): { head: string; rest: string } {
  if (text.length <= max) return { head: text, rest: "" };

  const window = text.slice(0, max);

  const paraIdx = window.lastIndexOf("\n\n");
  if (paraIdx > 0) {
    return { head: text.slice(0, paraIdx + 2), rest: text.slice(paraIdx + 2) };
  }

  const lineIdx = window.lastIndexOf("\n");
  if (lineIdx > 0) {
    return { head: text.slice(0, lineIdx + 1), rest: text.slice(lineIdx + 1) };
  }

  const wordIdx = window.lastIndexOf(" ");
  if (wordIdx > 0) {
    return { head: text.slice(0, wordIdx + 1), rest: text.slice(wordIdx + 1) };
  }

  // Hard split: never sever a surrogate pair — if the cut point falls
  // between a high surrogate and its low surrogate, back off by one so the
  // whole astral codepoint moves wholly into the next chunk.
  let cut = max;
  if (
    cut > 0 &&
    cut < text.length &&
    isHighSurrogate(text.charCodeAt(cut - 1)) &&
    isLowSurrogate(text.charCodeAt(cut))
  ) {
    cut -= 1;
  }
  if (cut <= 0) cut = 1; // pathological max<2 straddling a pair: still make progress
  return { head: text.slice(0, cut), rest: text.slice(cut) };
}

/** Greedily split `text` into chunks of at most `max` UTF-16 code units each. */
function rawSplit(text: string, max: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const { head, rest: nextRest } = splitAt(rest, max);
    if (head.length === 0) {
      // Should be unreachable given splitAt's guards, but never emit an
      // empty chunk or spin forever.
      chunks.push(rest.slice(0, 1));
      rest = rest.slice(1);
      continue;
    }
    chunks.push(head);
    rest = nextRest;
  }
  return chunks;
}

function markerLength(i: number, n: number): number {
  return ` (${i}/${n})`.length;
}

/**
 * Split `text` for delivery on `platform`, respecting that platform's
 * maxChars. When more than one chunk results, each chunk gets a trailing
 * " (i/n)" continuation marker — reserving room for it up front so every
 * chunk, marker included, still fits within maxChars. Prefers paragraph
 * boundaries, then line boundaries, then word boundaries, then a hard split
 * that never severs a UTF-16 surrogate pair. Never returns an empty chunk;
 * an empty input returns [].
 */
export function chunkMessage(text: string, platform: string): string[] {
  if (text.length === 0) return [];

  const { maxChars } = platformFormat(platform);
  if (text.length <= maxChars) return [text];

  // Fixed-point search: the marker reserved for each chunk depends on how
  // many chunks there are (more chunks -> more digits -> longer marker),
  // and the chunk count depends on how much room is left after reserving
  // the marker. Iterate until the reserve computed from the resulting chunk
  // count no longer exceeds the reserve that produced those chunks.
  let reserve = 0;
  let chunks: string[] = [];
  let n = 0;
  const MAX_ITERATIONS = 32;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const effectiveMax = maxChars - reserve;
    if (effectiveMax <= 0) {
      throw new RangeError(
        `chunkMessage: maxChars (${maxChars}) for platform "${platform}" is too small to fit continuation markers`,
      );
    }
    chunks = rawSplit(text, effectiveMax);
    n = chunks.length;
    // digits(i) <= digits(n) for all 1<=i<=n, so the marker for (n,n) is the
    // longest any chunk will actually carry — a safe, if conservative, bound.
    const neededReserve = n > 1 ? markerLength(n, n) : 0;
    if (neededReserve <= reserve) break;
    reserve = neededReserve;
  }

  if (n <= 1) return chunks;
  return chunks.map((chunk, idx) => `${chunk} (${idx + 1}/${n})`);
}

// ---------------------------------------------------------------------------
// Badge rendering
// ---------------------------------------------------------------------------

/**
 * Render a {@link StampedReply}'s trust badge as a single line of text,
 * styled for the given platform. The text is derived entirely from the
 * already-assessed `s` — this function has no way to fabricate a badge, it
 * only ever describes the one it was given.
 */
export function renderBadge(s: StampedReply, platform: string): string {
  const { style } = platformFormat(platform);
  const markdown = style === "markdown";

  if (s.badge === "verified") {
    const p = (s.pCorrect ?? 0).toFixed(2);
    const fp = s.certFingerprint ?? "";
    return markdown
      ? `✅ *verified* — p≥${p} · cert ${fp}`
      : `✅ verified — p≥${p} · cert ${fp}`;
  }

  if (s.badge === "abstained") {
    return markdown ? `⚠️ *abstained* — ${s.reason}` : `⚠️ abstained — ${s.reason}`;
  }

  return "◻︎ unverified";
}
