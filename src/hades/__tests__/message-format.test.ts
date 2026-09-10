import { describe, expect, it } from "vitest";

import {
  chunkMessage,
  platformFormat,
  renderBadge,
  type PlatformFormat,
} from "../gateway/message-format";
import type { StampedReply } from "../gateway/badge";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const MARKER_RE = / \((\d+)\/(\d+)\)$/;

function stripMarker(chunk: string): string {
  return chunk.replace(MARKER_RE, "");
}

/** True iff `s` contains no isolated (unpaired) UTF-16 surrogate code unit. */
function hasNoLoneSurrogates(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Deterministic word-salad of exactly `len` UTF-16 code units, no newlines. */
function wordSalad(len: number): string {
  const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota"];
  let out = "";
  let i = 0;
  while (out.length < len) {
    out += (out.length > 0 ? " " : "") + words[i % words.length];
    i++;
  }
  return out.slice(0, len);
}

// ---------------------------------------------------------------------------
// platformFormat
// ---------------------------------------------------------------------------

describe("platformFormat", () => {
  it.each<[string, PlatformFormat]>([
    ["telegram", { maxChars: 4096, style: "markdown" }],
    ["discord", { maxChars: 2000, style: "markdown" }],
    ["slack", { maxChars: 40000, style: "markdown" }],
    ["whatsapp", { maxChars: 65536, style: "plain" }],
    ["signal", { maxChars: 2000, style: "plain" }],
    ["email", { maxChars: 100000, style: "plain" }],
  ])("matches the locked table for %s", (platform, expected) => {
    expect(platformFormat(platform)).toEqual(expected);
  });

  it("falls back to {4000, plain} for any unrecognized platform, including this repo's own cli/generic gateway platforms", () => {
    for (const platform of ["cli", "generic", "irc", "sms", "", "Slack"]) {
      expect(platformFormat(platform)).toEqual({ maxChars: 4000, style: "plain" });
    }
  });
});

// ---------------------------------------------------------------------------
// chunkMessage
// ---------------------------------------------------------------------------

describe("chunkMessage", () => {
  it("empty string returns []", () => {
    expect(chunkMessage("", "discord")).toEqual([]);
  });

  it("text of exactly maxChars is returned as a single unmarked chunk", () => {
    const text = "y".repeat(2000); // discord maxChars
    const chunks = chunkMessage(text, "discord");
    expect(chunks).toEqual([text]);
    expect(chunks[0]).not.toMatch(MARKER_RE);
  });

  it("text shorter than maxChars is a single unmarked chunk", () => {
    const text = "short reply";
    expect(chunkMessage(text, "signal")).toEqual([text]);
  });

  it("10k-char paragraphless text on discord: every chunk <= 2000 chars, all carry (i/n) markers, content is preserved exactly", () => {
    const text = wordSalad(10_000);
    expect(text).not.toContain("\n");
    const { maxChars } = platformFormat("discord");
    const chunks = chunkMessage(text, "discord");

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(maxChars);
      expect(c.length).toBeGreaterThan(0);
    }
    // every chunk carries a marker, all sharing the same total n
    const totals = new Set<string>();
    chunks.forEach((c, idx) => {
      const m = c.match(MARKER_RE);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBe(idx + 1);
      totals.add(m![2]);
    });
    expect(totals.size).toBe(1);
    expect(Number([...totals][0])).toBe(chunks.length);
    // reconstructing the stripped chunks recovers the original text exactly
    expect(chunks.map(stripMarker).join("")).toBe(text);
  });

  it("prefers paragraph boundaries over mid-paragraph splits", () => {
    // Two paragraphs whose combined length forces a split; the first
    // paragraph alone fits comfortably under maxChars, so the natural break
    // is at the "\n\n", not mid-word inside either paragraph.
    const platform = "signal"; // maxChars 2000, plain
    const { maxChars } = platformFormat(platform);
    const paraA = wordSalad(1200);
    const paraB = wordSalad(1200);
    const text = `${paraA}\n\n${paraB}`;
    expect(text.length).toBeGreaterThan(maxChars); // forces a split

    const chunks = chunkMessage(text, platform);
    expect(chunks.length).toBe(2);
    const firstStripped = stripMarker(chunks[0]);
    expect(firstStripped.endsWith("\n\n")).toBe(true);
    expect(firstStripped).toBe(`${paraA}\n\n`);
    expect(stripMarker(chunks[1])).toBe(paraB);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(maxChars);
  });

  it("falls back to a word boundary when there is no paragraph or line boundary in range", () => {
    const platform = "signal";
    const { maxChars } = platformFormat(platform);
    const text = wordSalad(maxChars * 2 + 137);
    const chunks = chunkMessage(text, platform);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(maxChars);
      const stripped = stripMarker(c);
      // never cuts a word in half: each chunk's content, once the marker is
      // stripped, starts and ends on a word (no leading/trailing partial
      // token boundary artifacts beyond the single joining space already
      // consumed by the split).
      expect(stripped.startsWith(" ")).toBe(false);
    }
    expect(chunks.map(stripMarker).join("")).toBe(text);
  });

  it("an astral-plane emoji straddling the max-chars boundary is moved wholly into the next chunk, never splitting the surrogate pair", () => {
    const platform = "signal"; // maxChars 2000, plain, no markdown escaping to worry about
    const { maxChars } = platformFormat(platform);
    // One leading ASCII byte offsets every emoji pair so that a hard cut at
    // exactly `maxChars` code units would otherwise land inside a pair.
    const emoji = "🎉"; // U+1F389, a surrogate pair, .length === 2
    const text = "a" + emoji.repeat(1200); // no spaces/newlines: forces hard split
    expect(text.length).toBeGreaterThan(maxChars);

    const chunks = chunkMessage(text, platform);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const stripped = stripMarker(c);
      expect(stripped.length).toBeGreaterThan(0);
      expect(stripped.length).toBeLessThanOrEqual(maxChars);
      expect(hasNoLoneSurrogates(stripped)).toBe(true);
      expect(stripped.isWellFormed()).toBe(true);
    }
    // Reassembling recovers the exact original text — no codepoint lost,
    // duplicated, or corrupted at the cut.
    expect(chunks.map(stripMarker).join("")).toBe(text);
  });

  it("every chunk, marker included, stays within maxChars across every locked platform for a large input", () => {
    for (const platform of ["telegram", "discord", "slack", "whatsapp", "signal", "email", "cli"]) {
      const { maxChars } = platformFormat(platform);
      const text = wordSalad(maxChars * 5 + 777);
      const chunks = chunkMessage(text, platform);
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(c.length).toBeLessThanOrEqual(maxChars);
        expect(c.length).toBeGreaterThan(0);
      }
      expect(chunks.map(stripMarker).join("")).toBe(text);
    }
  });
});

// ---------------------------------------------------------------------------
// renderBadge
// ---------------------------------------------------------------------------

describe("renderBadge", () => {
  const verified: StampedReply = {
    badge: "verified",
    reason: "gate emitted and certificate cryptographically matches this reply",
    certFingerprint: "abc123def456",
    pCorrect: 0.9812,
  };
  const abstained: StampedReply = {
    badge: "abstained",
    reason: "gate abstained: score 0.620 below threshold 0.900",
  };
  const unverified: StampedReply = {
    badge: "unverified",
    reason: "certificate did not match this message",
  };

  it("markdown: verified", () => {
    expect(renderBadge(verified, "discord")).toBe(
      "✅ *verified* — p≥0.98 · cert abc123def456",
    );
  });

  it("markdown: abstained", () => {
    expect(renderBadge(abstained, "telegram")).toBe(
      "⚠️ *abstained* — gate abstained: score 0.620 below threshold 0.900",
    );
  });

  it("markdown: unverified", () => {
    expect(renderBadge(unverified, "slack")).toBe("◻︎ unverified");
  });

  it("plain: verified", () => {
    expect(renderBadge(verified, "signal")).toBe(
      "✅ verified — p≥0.98 · cert abc123def456",
    );
  });

  it("plain: abstained", () => {
    expect(renderBadge(abstained, "whatsapp")).toBe(
      "⚠️ abstained — gate abstained: score 0.620 below threshold 0.900",
    );
  });

  it("plain: unverified", () => {
    expect(renderBadge(unverified, "email")).toBe("◻︎ unverified");
  });

  it("plain style never contains markdown asterisks", () => {
    expect(renderBadge(verified, "signal")).not.toContain("*");
    expect(renderBadge(abstained, "email")).not.toContain("*");
  });
});
