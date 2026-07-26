/**
 * Tests for `src/hades/migrate/ir.ts` -- the canonical migration IR.
 *
 * Exercises real behavior: `canonicalJson`'s determinism/refusals,
 * `itemHash`'s cross-run stability (a frozen expected digest, not just
 * "hash(x) === hash(x)"), `validateBundle`'s full catalogue of violations,
 * and `mergeBundles`' order-independence and collision reporting.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  CanonicalJsonError,
  ITEM_KEY_SCHEMES,
  canonicalJson,
  itemHash,
  makeItem,
  mergeBundles,
  validateBundle,
  type ArtifactKind,
  type MigrationBundle,
  type MigrationItem,
} from "../ir";
import type { JsonValue } from "../../state/record";

function emptyStats() {
  return { filesScanned: 0, bytesRead: 0, truncated: false };
}

function bundle(overrides: Partial<MigrationBundle> = {}): MigrationBundle {
  return {
    vendor: "hermes",
    layout: "hermes-dotfile",
    root: "/home/u/.hermes",
    items: [],
    unimportable: [],
    readErrors: [],
    stats: emptyStats(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// canonicalJson
// ---------------------------------------------------------------------------

describe("canonicalJson", () => {
  it("sorts object keys deterministically at every level, insertion order irrelevant", () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array element order (order is meaningful for arrays)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it("round-trips primitives, null, nested structures", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson("hi")).toBe('"hi"');
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson({ arr: [1, { x: null }, "y"] })).toBe('{"arr":[1,{"x":null},"y"]}');
  });

  it("rejects NaN", () => {
    expect(() => canonicalJson(NaN as unknown as JsonValue)).toThrow(CanonicalJsonError);
  });

  it("rejects Infinity and -Infinity", () => {
    expect(() => canonicalJson(Infinity as unknown as JsonValue)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(-Infinity as unknown as JsonValue)).toThrow(CanonicalJsonError);
  });

  it("rejects -0 as ambiguous with 0", () => {
    expect(() => canonicalJson(-0 as unknown as JsonValue)).toThrow(CanonicalJsonError);
    expect(canonicalJson(0)).toBe("0"); // plain 0 is fine
  });

  it("rejects circular references in objects", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => canonicalJson(obj as unknown as JsonValue)).toThrow(CanonicalJsonError);
  });

  it("rejects circular references in arrays", () => {
    const arr: unknown[] = [1, 2];
    arr.push(arr);
    expect(() => canonicalJson(arr as unknown as JsonValue)).toThrow(CanonicalJsonError);
  });

  it("rejects undefined and bigint", () => {
    expect(() => canonicalJson(undefined as unknown as JsonValue)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(BigInt(1) as unknown as JsonValue)).toThrow(CanonicalJsonError);
  });

  it("enforces a documented depth limit rather than blowing the stack", () => {
    let deep: JsonValue = 0;
    for (let i = 0; i < 200; i++) deep = { n: deep };
    expect(() => canonicalJson(deep)).toThrow(CanonicalJsonError);

    // Well within the limit still works.
    let shallow: JsonValue = 0;
    for (let i = 0; i < 10; i++) shallow = { n: shallow };
    expect(() => canonicalJson(shallow)).not.toThrow();
  });

  it("is total for repeated calls -- deterministic and side-effect free (no shared mutable state across calls)", () => {
    const v: JsonValue = { z: 1, a: [1, 2, { q: "r", p: "o" }] };
    const first = canonicalJson(v);
    for (let i = 0; i < 5; i++) expect(canonicalJson(v)).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// itemHash
// ---------------------------------------------------------------------------

describe("itemHash", () => {
  it("is stable across key insertion order in the value", () => {
    const h1 = itemHash("config", "config:model.default", { provider: "anthropic", name: "x" });
    const h2 = itemHash("config", "config:model.default", { name: "x", provider: "anthropic" });
    expect(h1).toBe(h2);
  });

  it("matches a frozen expected digest (stable across process runs, not just self-consistent)", () => {
    // sha256 over canonicalJson({"kind":"memory","key":"memory:abc","value":"the sky is blue"})
    const payload = { kind: "memory", key: "memory:abc", value: "the sky is blue" };
    const expected = createHash("sha256").update(canonicalJson(payload as JsonValue), "utf8").digest("hex");
    const actual = itemHash("memory" as ArtifactKind, "memory:abc", "the sky is blue");
    expect(actual).toBe(expected);
    // Frozen literal (independently computed with node -e against
    // '{"key":"memory:abc","kind":"memory","value":"the sky is blue"}') so a future
    // accidental change to canonicalJson/itemHash is caught even if this test file's own
    // computation above were somehow also wrong.
    expect(actual).toBe("cfd5c9110dd703b03e4e7dde4ec9463004b6171c8fbb8d4f1ec7cbf51b2b7d97");
  });

  it("differs when kind, key, or value differ", () => {
    const base = itemHash("config", "config:a.b", "v");
    expect(itemHash("model" as ArtifactKind, "config:a.b", "v")).not.toBe(base);
    expect(itemHash("config", "config:a.c", "v")).not.toBe(base);
    expect(itemHash("config", "config:a.b", "w")).not.toBe(base);
  });

  it("is real sha256, not a stub returning a constant", () => {
    const h1 = itemHash("skill", "skill:foo", { a: 1 });
    const h2 = itemHash("skill", "skill:bar", { a: 1 });
    expect(h1).not.toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// makeItem
// ---------------------------------------------------------------------------

describe("makeItem", () => {
  it("computes hash consistent with itemHash", () => {
    const item = makeItem({
      kind: "skill",
      key: "skill:web-search",
      value: { source: "hermes" },
      origin: { path: "/home/u/.hermes/skills/web-search" },
      confidence: 0.9,
    });
    expect(item.hash).toBe(itemHash("skill", "skill:web-search", { source: "hermes" }));
  });
});

// ---------------------------------------------------------------------------
// ITEM_KEY_SCHEMES
// ---------------------------------------------------------------------------

describe("ITEM_KEY_SCHEMES", () => {
  it("documents every ArtifactKind", () => {
    const kinds: ArtifactKind[] = [
      "config",
      "model",
      "memory",
      "context-file",
      "session",
      "skill",
      "secret",
      "tool-state",
      "unknown",
    ];
    for (const k of kinds) {
      expect(typeof ITEM_KEY_SCHEMES[k]).toBe("string");
      expect(ITEM_KEY_SCHEMES[k].length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// validateBundle
// ---------------------------------------------------------------------------

describe("validateBundle", () => {
  it("accepts a well-formed bundle with items of every kind", () => {
    const items: MigrationItem[] = [
      makeItem({ kind: "config", key: "config:model.default", value: "claude", origin: { path: "/r/config.json" }, confidence: 1 }),
      makeItem({ kind: "model", key: "model:selection", value: { name: "claude" }, origin: { path: "/r/model.json" }, confidence: 1 }),
      makeItem({
        kind: "memory",
        key: `memory:${createHash("sha256").update("fact").digest("hex").slice(0, 16)}`,
        value: "fact",
        origin: { path: "/r/memory/1.json" },
        confidence: 0.8,
      }),
      makeItem({ kind: "context-file", key: "context:README.md", value: "# hi", origin: { path: "/r/context/README.md" }, confidence: 0.7 }),
      makeItem({ kind: "session", key: "session:abc-123", value: { turns: 3 }, origin: { path: "/r/sessions/abc-123.json" }, confidence: 0.5 }),
      makeItem({ kind: "skill", key: "skill:web-search", value: { source: "hermes" }, origin: { path: "/r/skills/web-search" }, confidence: 1 }),
      makeItem({
        kind: "secret",
        key: "secret:OPENAI_API_KEY",
        value: { present: true, source: ".env" },
        origin: { path: "/r/.env" },
        confidence: 1,
      }),
      makeItem({ kind: "tool-state", key: "tool-state:browser", value: { cookiesCleared: true }, origin: { path: "/r/tool-state/browser.json" }, confidence: 0.6 }),
      makeItem({ kind: "unknown", key: "unknown:weird.bin", value: "opaque", origin: { path: "/r/weird.bin" }, confidence: 0.1 }),
    ];
    const result = validateBundle(bundle({ items }));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects an invalid vendor", () => {
    const result = validateBundle({ ...bundle(), vendor: "not-a-vendor" as never });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("invalid vendor"))).toBe(true);
  });

  it("rejects empty layout/root", () => {
    const result = validateBundle({ ...bundle(), layout: "", root: "" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("layout"))).toBe(true);
    expect(result.errors.some((e) => e.includes("root"))).toBe(true);
  });

  it("rejects a key that violates its kind's grammar", () => {
    const bad = makeItem({ kind: "memory", key: "not-the-right-shape", value: "x", origin: { path: "/p" }, confidence: 1 });
    const result = validateBundle(bundle({ items: [bad] }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("does not match the required grammar"))).toBe(true);
  });

  it("rejects a context-file key containing a path-traversal segment", () => {
    const bad = makeItem({ kind: "context-file", key: "context:../../etc/passwd", value: "x", origin: { path: "/p" }, confidence: 1 });
    const result = validateBundle(bundle({ items: [bad] }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("path-traversal"))).toBe(true);
  });

  it("rejects duplicate item keys (same kind+key)", () => {
    const a = makeItem({ kind: "config", key: "config:model.default", value: "a", origin: { path: "/p1" }, confidence: 1 });
    const b = makeItem({ kind: "config", key: "config:model.default", value: "b", origin: { path: "/p2" }, confidence: 1 });
    const result = validateBundle(bundle({ items: [a, b] }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("duplicate item key"))).toBe(true);
  });

  it("rejects out-of-range confidence", () => {
    const tooHigh = makeItem({ kind: "config", key: "config:a", value: "x", origin: { path: "/p" }, confidence: 1.5 });
    const tooLow = makeItem({ kind: "config", key: "config:b", value: "x", origin: { path: "/p" }, confidence: -0.1 });
    const result = validateBundle(bundle({ items: [tooHigh, tooLow] }));
    expect(result.ok).toBe(false);
    expect(result.errors.filter((e) => e.includes("out of range")).length).toBe(2);
  });

  it("rejects a hash mismatch (tampered item)", () => {
    const item = makeItem({ kind: "config", key: "config:a", value: "x", origin: { path: "/p" }, confidence: 1 });
    const tampered: MigrationItem = { ...item, value: "y" }; // value changed, hash stale
    const result = validateBundle(bundle({ items: [tampered] }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("hash mismatch"))).toBe(true);
  });

  it("rejects a secret item whose value carries a private key block", () => {
    const item = makeItem({
      kind: "secret",
      key: "secret:MY_KEY",
      value: "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----",
      origin: { path: "/p/.ssh/id_rsa" },
      confidence: 1,
    });
    const result = validateBundle(bundle({ items: [item] }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("raw key material"))).toBe(true);
  });

  it("rejects a secret item whose value carries an OpenAI-style API key", () => {
    const item = makeItem({
      kind: "secret",
      key: "secret:OPENAI_API_KEY",
      value: { preview: "sk-abcdefghijklmnopqrstuvwxyz0123456789" },
      origin: { path: "/p/.env" },
      confidence: 1,
    });
    const result = validateBundle(bundle({ items: [item] }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("raw key material"))).toBe(true);
  });

  it("rejects a secret item whose value carries a long high-entropy hex/base64 blob nested in an object", () => {
    const item = makeItem({
      kind: "secret",
      key: "secret:GENERIC_TOKEN",
      value: { nested: { deeper: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9" } },
      origin: { path: "/p/.env" },
      confidence: 1,
    });
    const result = validateBundle(bundle({ items: [item] }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("raw key material"))).toBe(true);
  });

  it("accepts a secret item whose value is a plain descriptor (no key material)", () => {
    const item = makeItem({
      kind: "secret",
      key: "secret:OPENAI_API_KEY",
      value: { envVar: "OPENAI_API_KEY", present: true, source: ".env" },
      origin: { path: "/p/.env" },
      confidence: 1,
    });
    const result = validateBundle(bundle({ items: [item] }));
    expect(result.ok).toBe(true);
  });

  it("rejects malformed unimportable/readErrors entries", () => {
    const result = validateBundle(
      bundle({
        unimportable: [{ path: "", kind: "config", reason: "" }],
        readErrors: [{ path: "", reason: "" }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("unimportable[0].path"))).toBe(true);
    expect(result.errors.some((e) => e.includes("unimportable[0].reason"))).toBe(true);
    expect(result.errors.some((e) => e.includes("readErrors[0].path"))).toBe(true);
    expect(result.errors.some((e) => e.includes("readErrors[0].reason"))).toBe(true);
  });

  it("rejects malformed stats", () => {
    const result = validateBundle(bundle({ stats: { filesScanned: -1, bytesRead: NaN, truncated: "no" as unknown as boolean } }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("filesScanned"))).toBe(true);
    expect(result.errors.some((e) => e.includes("bytesRead"))).toBe(true);
    expect(result.errors.some((e) => e.includes("truncated"))).toBe(true);
  });

  it("collects every violation rather than stopping at the first", () => {
    const bad = makeItem({ kind: "config", key: "bad-key", value: "x", origin: { path: "/p" }, confidence: 5 });
    const result = validateBundle({ ...bundle(), vendor: "nope" as never, items: [bad] });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3); // invalid vendor + bad grammar + out-of-range confidence
  });
});

// ---------------------------------------------------------------------------
// mergeBundles
// ---------------------------------------------------------------------------

describe("mergeBundles", () => {
  it("throws on an empty array", () => {
    expect(() => mergeBundles([])).toThrow(RangeError);
  });

  it("is order-independent for disjoint inputs", () => {
    const a = bundle({
      items: [makeItem({ kind: "config", key: "config:a", value: "1", origin: { path: "/a" }, confidence: 1 })],
      stats: { filesScanned: 1, bytesRead: 10, truncated: false },
    });
    const b = bundle({
      items: [makeItem({ kind: "config", key: "config:b", value: "2", origin: { path: "/b" }, confidence: 1 })],
      stats: { filesScanned: 2, bytesRead: 20, truncated: true },
    });
    const c = bundle({
      items: [makeItem({ kind: "session", key: "session:s1", value: {}, origin: { path: "/c" }, confidence: 1 })],
      stats: { filesScanned: 3, bytesRead: 30, truncated: false },
    });

    const forward = mergeBundles([a, b, c]);
    const backward = mergeBundles([c, b, a]);
    const shuffled = mergeBundles([b, c, a]);

    expect(forward).toEqual(backward);
    expect(forward).toEqual(shuffled);
    expect(forward.items.map((i) => i.key)).toEqual(["config:a", "config:b", "session:s1"]);
    expect(forward.stats).toEqual({ filesScanned: 6, bytesRead: 60, truncated: true });
  });

  it("collapses an identical item observed in two bundles instead of duplicating it", () => {
    const item = makeItem({ kind: "config", key: "config:a", value: "1", origin: { path: "/a" }, confidence: 0.6, notes: ["n1"] });
    const sameAgain = makeItem({ kind: "config", key: "config:a", value: "1", origin: { path: "/a2" }, confidence: 0.9, notes: ["n2"] });
    const merged = mergeBundles([bundle({ items: [item] }), bundle({ items: [sameAgain] })]);
    expect(merged.items).toHaveLength(1);
    expect(merged.items[0].confidence).toBe(0.9); // higher of the two
    expect(merged.items[0].notes).toEqual(["n1", "n2"]);
  });

  it("reports every collision (same kind+key, different value) rather than dropping silently", () => {
    const winner = makeItem({ kind: "config", key: "config:a", value: "winner", origin: { path: "/a-high" }, confidence: 0.9 });
    const loser = makeItem({ kind: "config", key: "config:a", value: "loser", origin: { path: "/a-low" }, confidence: 0.2 });
    const merged = mergeBundles([bundle({ items: [loser] }), bundle({ items: [winner] })]);

    expect(merged.items).toHaveLength(1);
    expect(merged.items[0].value).toBe("winner");
    expect(merged.unimportable).toHaveLength(1);
    expect(merged.unimportable[0].path).toBe("/a-low");
    expect(merged.unimportable[0].reason).toMatch(/merge collision/);
  });

  it("collision winner selection (and thus the whole merge) is order-independent", () => {
    const winner = makeItem({ kind: "config", key: "config:a", value: "winner", origin: { path: "/a-high" }, confidence: 0.9 });
    const loser = makeItem({ kind: "config", key: "config:a", value: "loser", origin: { path: "/a-low" }, confidence: 0.2 });
    const forward = mergeBundles([bundle({ items: [winner] }), bundle({ items: [loser] })]);
    const backward = mergeBundles([bundle({ items: [loser] }), bundle({ items: [winner] })]);
    expect(forward).toEqual(backward);
  });

  it("de-duplicates identical unimportable/readErrors entries across bundles", () => {
    const merged = mergeBundles([
      bundle({ unimportable: [{ path: "/x", kind: "unknown", reason: "binary" }], readErrors: [{ path: "/y", reason: "EACCES" }] }),
      bundle({ unimportable: [{ path: "/x", kind: "unknown", reason: "binary" }], readErrors: [{ path: "/y", reason: "EACCES" }] }),
    ]);
    expect(merged.unimportable).toHaveLength(1);
    expect(merged.readErrors).toHaveLength(1);
  });

  it("picks vendor/layout/root/version deterministically when inputs disagree, independent of order", () => {
    const h = bundle({ vendor: "hermes", layout: "hermes-dotfile", root: "/h", version: "1.0.0" });
    const o = bundle({ vendor: "openclaw", layout: "openclaw-dotfile", root: "/o", version: "2.0.0" });
    const forward = mergeBundles([h, o]);
    const backward = mergeBundles([o, h]);
    expect(forward.vendor).toBe(backward.vendor);
    expect(forward.layout).toBe(backward.layout);
    expect(forward.root).toBe(backward.root);
    expect(forward.version).toBe(backward.version);
    // "hermes" < "openclaw" lexicographically
    expect(forward.vendor).toBe("hermes");
  });

  it("produces a bundle that itself passes validateBundle", () => {
    const a = bundle({ items: [makeItem({ kind: "skill", key: "skill:x", value: { a: 1 }, origin: { path: "/a" }, confidence: 1 })] });
    const b = bundle({ items: [makeItem({ kind: "skill", key: "skill:y", value: { a: 1 }, origin: { path: "/b" }, confidence: 1 })] });
    const merged = mergeBundles([a, b]);
    expect(validateBundle(merged).ok).toBe(true);
  });
});
