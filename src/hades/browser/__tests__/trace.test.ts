import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import {
  BrowserTraceLedger,
  TRACE_GENESIS,
  canonicalizeTraceEvent,
  traceCertificateFields,
  verifyTraceChain,
  type BrowserTraceEvent,
  type BrowserTraceKind,
  type TracedEventRecord,
} from "../trace";

import { sha256Hex } from "../../styx/certificate";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Independent cross-check of payload hashing: base64(bytes) -> sha256 hex,
 *  computed directly via node:crypto (not through the module under test) to
 *  guard against accidental double-hashing / drift. */
function independentPayloadSha256(payload: string | Uint8Array): string {
  const bytes = payload instanceof Uint8Array ? payload : Buffer.from(payload, "utf8");
  const b64 = Buffer.from(bytes).toString("base64");
  return createHash("sha256").update(b64, "utf8").digest("hex");
}

/** Independent cross-check of the chain-hash formula via node:crypto directly. */
function independentSha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function cloneRecords(recs: readonly TracedEventRecord[]): TracedEventRecord[] {
  return JSON.parse(JSON.stringify(recs)) as TracedEventRecord[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ALL_KINDS: BrowserTraceKind[] = ["navigate", "act", "screenshot", "extract"];

function otherKind(k: BrowserTraceKind): BrowserTraceKind {
  const idx = ALL_KINDS.indexOf(k);
  return ALL_KINDS[(idx + 1) % ALL_KINDS.length]!;
}

function mutateValue(v: unknown): unknown {
  if (typeof v === "string") return v + "_mutated";
  if (typeof v === "number") return v + 1;
  if (typeof v === "boolean") return !v;
  return { mutated: true };
}

function buildFixtureLedger(): BrowserTraceLedger {
  const clockValues = [1_000, 2_000, 3_000, 4_000];
  let i = 0;
  const ledger = new BrowserTraceLedger({ now: () => clockValues[i++]! });
  ledger.append("navigate", { url: "https://example.com", status: 200 });
  ledger.append("act", { action: "click", selector: "#btn", ok: true }, "click-payload-bytes");
  ledger.append(
    "screenshot",
    { width: 1024, height: 768 },
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  ledger.append("extract", { passageCount: 3, url: "https://example.com/page" });
  return ledger;
}

// ---------------------------------------------------------------------------
// TRACE_GENESIS
// ---------------------------------------------------------------------------

describe("TRACE_GENESIS", () => {
  it("equals sha256('hades.browser.trace.v1') computed independently via node:crypto", () => {
    expect(TRACE_GENESIS).toBe(independentSha256("hades.browser.trace.v1"));
  });

  it("is a 64-char lowercase hex string", () => {
    expect(TRACE_GENESIS).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches sha256Hex directly (byte-identical with the certificate engine)", () => {
    expect(TRACE_GENESIS).toBe(sha256Hex("hades.browser.trace.v1"));
  });
});

// ---------------------------------------------------------------------------
// canonicalizeTraceEvent
// ---------------------------------------------------------------------------

describe("canonicalizeTraceEvent", () => {
  it("emits the locked top-level field order [seq, at, kind, detail]", () => {
    const event: BrowserTraceEvent = {
      seq: 0,
      at: 1000,
      kind: "navigate",
      detail: { b: 2, a: 1 },
    };
    expect(canonicalizeTraceEvent(event)).toBe(
      '{"seq":0,"at":1000,"kind":"navigate","detail":{"a":1,"b":2}}',
    );
  });

  it("appends payloadSha256 last when present", () => {
    const event: BrowserTraceEvent = {
      seq: 2,
      at: 3000,
      kind: "screenshot",
      detail: { width: 10, height: 20 },
      payloadSha256: "deadbeef",
    };
    expect(canonicalizeTraceEvent(event)).toBe(
      '{"seq":2,"at":3000,"kind":"screenshot","detail":{"height":20,"width":10},"payloadSha256":"deadbeef"}',
    );
  });

  it("omits payloadSha256 entirely when undefined (does not throw, does not emit key)", () => {
    const event: BrowserTraceEvent = { seq: 0, at: 1, kind: "navigate", detail: {} };
    const out = canonicalizeTraceEvent(event);
    expect(out).not.toContain("payloadSha256");
    expect(out).toBe('{"seq":0,"at":1,"kind":"navigate","detail":{}}');
  });

  it("is key-order independent: {a,b} and {b,a} canonicalize identically", () => {
    const e1: BrowserTraceEvent = { seq: 0, at: 1, kind: "act", detail: { a: 1, b: 2, c: 3 } };
    const e2: BrowserTraceEvent = { seq: 0, at: 1, kind: "act", detail: { c: 3, a: 1, b: 2 } };
    expect(canonicalizeTraceEvent(e1)).toBe(canonicalizeTraceEvent(e2));
  });

  it("sorts keys recursively through nested objects and preserves array order", () => {
    const event: BrowserTraceEvent = {
      seq: 0,
      at: 1,
      kind: "extract",
      detail: {
        z: { y: 2, x: 1 },
        list: [{ b: 1, a: 2 }, 3, "str"],
      },
    };
    expect(canonicalizeTraceEvent(event)).toBe(
      '{"seq":0,"at":1,"kind":"extract","detail":{"list":[{"a":2,"b":1},3,"str"],"z":{"x":1,"y":2}}}',
    );
  });

  it("is deterministic across repeated calls on structurally-equal-but-freshly-built objects", () => {
    const build = (): BrowserTraceEvent => ({
      seq: 5,
      at: 999,
      kind: "act",
      detail: { selector: "#x", nested: { k1: "v1", k2: [1, 2, 3] } },
    });
    expect(canonicalizeTraceEvent(build())).toBe(canonicalizeTraceEvent(build()));
  });

  it("round-trips unicode strings (astral plane, combining marks) byte-identically", () => {
    const astral = "𝔘𝔫𝔦𝔠𝔬𝔡𝔢 🎉🚀 \u{1F600}";
    const combining = "é"; // "e" + combining acute accent (NOT precomposed é)
    const event: BrowserTraceEvent = {
      seq: 1,
      at: 2,
      kind: "extract",
      detail: { astral, combining },
    };
    const canon = canonicalizeTraceEvent(event);
    const parsed = JSON.parse(canon) as { detail: { astral: string; combining: string } };
    expect(parsed.detail.astral).toBe(astral);
    expect(parsed.detail.combining).toBe(combining);
    expect(parsed.detail.combining).not.toBe("é"); // not silently normalized to precomposed é
    // and re-canonicalizing is byte-identical
    expect(canonicalizeTraceEvent(event)).toBe(canon);
  });

  it("throws TypeError for a non-object event", () => {
    expect(() => canonicalizeTraceEvent(null as unknown as BrowserTraceEvent)).toThrow(TypeError);
  });

  describe("throws a descriptive Error naming the offending path for non-JSON-safe values", () => {
    const cases: Array<{ name: string; detail: Record<string, unknown>; pathFragment: string }> = [
      { name: "undefined value", detail: { a: undefined }, pathFragment: "detail.a" },
      { name: "function value", detail: { a: () => 1 }, pathFragment: "detail.a" },
      { name: "bigint value", detail: { a: 10n }, pathFragment: "detail.a" },
      { name: "symbol value", detail: { a: Symbol("x") }, pathFragment: "detail.a" },
      { name: "NaN", detail: { a: Number.NaN }, pathFragment: "detail.a" },
      { name: "Infinity", detail: { a: Number.POSITIVE_INFINITY }, pathFragment: "detail.a" },
      { name: "-Infinity", detail: { a: Number.NEGATIVE_INFINITY }, pathFragment: "detail.a" },
      {
        name: "undefined nested in an array",
        detail: { a: { b: [1, undefined] } },
        pathFragment: "detail.a.b[1]",
      },
      { name: "Date instance", detail: { a: new Date() }, pathFragment: "detail.a" },
      { name: "Map instance", detail: { nested: { m: new Map() } }, pathFragment: "detail.nested.m" },
    ];

    for (const c of cases) {
      it(`${c.name} -> path mentions "${c.pathFragment}"`, () => {
        const event: BrowserTraceEvent = { seq: 0, at: 1, kind: "navigate", detail: c.detail };
        expect(() => canonicalizeTraceEvent(event)).toThrow(new RegExp(escapeRegExp(c.pathFragment)));
      });
    }
  });

  it("throws for circular references, naming the cyclic path", () => {
    const inner: Record<string, unknown> = { a: 1 };
    inner.self = inner;
    const event: BrowserTraceEvent = { seq: 0, at: 1, kind: "navigate", detail: { nested: inner } };
    expect(() => canonicalizeTraceEvent(event)).toThrow(/circular reference/);
  });

  it("does NOT falsely flag non-circular shared references (same object reused, not cyclic)", () => {
    const shared = { x: 1 };
    const event: BrowserTraceEvent = {
      seq: 0,
      at: 1,
      kind: "navigate",
      detail: { first: shared, second: shared },
    };
    expect(() => canonicalizeTraceEvent(event)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// BrowserTraceLedger — basic behavior
// ---------------------------------------------------------------------------

describe("BrowserTraceLedger", () => {
  it("starts empty: length 0, rootHash === TRACE_GENESIS", () => {
    const ledger = new BrowserTraceLedger({ now: () => 1 });
    expect(ledger.length).toBe(0);
    expect(ledger.rootHash()).toBe(TRACE_GENESIS);
    expect(ledger.records()).toEqual([]);
  });

  it("assigns dense seq starting at 0 and increments by 1 each append", () => {
    const ledger = new BrowserTraceLedger({ now: () => 1 });
    const r0 = ledger.append("navigate", { url: "a" });
    const r1 = ledger.append("act", { action: "click" });
    const r2 = ledger.append("screenshot", { width: 1 });
    expect([r0.seq, r1.seq, r2.seq]).toEqual([0, 1, 2]);
    expect(ledger.length).toBe(3);
  });

  it("uses the injected clock for `at`, not the real clock", () => {
    const values = [111, 222, 333];
    let idx = 0;
    const ledger = new BrowserTraceLedger({ now: () => values[idx++]! });
    const r0 = ledger.append("navigate", { url: "a" });
    const r1 = ledger.append("navigate", { url: "b" });
    const r2 = ledger.append("navigate", { url: "c" });
    expect([r0.at, r1.at, r2.at]).toEqual(values);
  });

  it("defaults to the real Date.now clock when no `now` is injected", () => {
    const ledger = new BrowserTraceLedger();
    const before = Date.now();
    const rec = ledger.append("navigate", { url: "https://x" });
    const after = Date.now();
    expect(rec.at).toBeGreaterThanOrEqual(before);
    expect(rec.at).toBeLessThanOrEqual(after);
  });

  it("first record's prevHash is TRACE_GENESIS; rootHash tracks the last record's hash", () => {
    const ledger = new BrowserTraceLedger({ now: () => 42 });
    const r0 = ledger.append("navigate", { url: "a" });
    expect(r0.prevHash).toBe(TRACE_GENESIS);
    expect(ledger.rootHash()).toBe(r0.hash);

    const r1 = ledger.append("act", { action: "click" });
    expect(r1.prevHash).toBe(r0.hash);
    expect(ledger.rootHash()).toBe(r1.hash);
  });

  it("hash = sha256Hex(prevHash + \"\\n\" + canonicalizeTraceEvent(event)) exactly", () => {
    const ledger = new BrowserTraceLedger({ now: () => 555 });
    const rec = ledger.append("navigate", { url: "https://example.com" });
    const event: BrowserTraceEvent = { seq: 0, at: 555, kind: "navigate", detail: { url: "https://example.com" } };
    const expected = sha256Hex(TRACE_GENESIS + "\n" + canonicalizeTraceEvent(event));
    expect(rec.hash).toBe(expected);
  });

  it("rejects non-object detail (array) before mutating ledger state", () => {
    const ledger = new BrowserTraceLedger({ now: () => 1 });
    expect(() => ledger.append("navigate", [] as unknown as Record<string, unknown>)).toThrow(TypeError);
    expect(ledger.length).toBe(0);
  });

  it("rejects non-JSON-safe detail before mutating ledger state (no partial append)", () => {
    const ledger = new BrowserTraceLedger({ now: () => 1 });
    ledger.append("navigate", { url: "a" }); // one good record first
    expect(() => ledger.append("act", { bad: undefined })).toThrow(/undefined value at detail\.bad/);
    expect(ledger.length).toBe(1); // unchanged — the bad append never landed
    expect(ledger.rootHash()).toBe(ledger.records()[0]!.hash);
  });

  describe("payload hashing", () => {
    it("never stores the payload itself, only its sha256", () => {
      const ledger = new BrowserTraceLedger({ now: () => 1 });
      const rec = ledger.append("screenshot", { width: 1 }, "super-secret-png-bytes-not-stored");
      expect(JSON.stringify(rec)).not.toContain("super-secret-png-bytes-not-stored");
      expect(rec.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("omits payloadSha256 when no payload is given", () => {
      const ledger = new BrowserTraceLedger({ now: () => 1 });
      const rec = ledger.append("extract", { passageCount: 1 });
      expect(rec.payloadSha256).toBeUndefined();
      expect("payloadSha256" in rec).toBe(false);
    });

    it("produces equal payloadSha256 for a string and the Uint8Array of its UTF-8 bytes", () => {
      const ledger = new BrowserTraceLedger({ now: () => 1 });
      const text = "hello world — with an em dash and 🎉";
      const bytes = new TextEncoder().encode(text);
      const recString = ledger.append("act", { n: 1 }, text);
      const recBytes = ledger.append("act", { n: 2 }, bytes);
      expect(recString.payloadSha256).toBeDefined();
      expect(recString.payloadSha256).toBe(recBytes.payloadSha256);
    });

    it("matches an independent node:crypto computation of base64(bytes) -> sha256", () => {
      const ledger = new BrowserTraceLedger({ now: () => 1 });
      const rec = ledger.append("act", { n: 1 }, "hello world");
      expect(rec.payloadSha256).toBe(independentPayloadSha256("hello world"));
    });

    it("a 1-byte payload change flips the resulting record hash, isolated from seq/at/kind/detail", () => {
      const detail = { note: "same" };
      const evtA: BrowserTraceEvent = {
        seq: 0,
        at: 12345,
        kind: "act",
        detail,
        payloadSha256: independentPayloadSha256("hello world"),
      };
      const evtB: BrowserTraceEvent = {
        seq: 0,
        at: 12345,
        kind: "act",
        detail,
        payloadSha256: independentPayloadSha256("hello worle"), // last byte changed
      };
      expect(evtA.payloadSha256).not.toBe(evtB.payloadSha256);
      const hashA = sha256Hex(TRACE_GENESIS + "\n" + canonicalizeTraceEvent(evtA));
      const hashB = sha256Hex(TRACE_GENESIS + "\n" + canonicalizeTraceEvent(evtB));
      expect(hashA).not.toBe(hashB);
    });
  });

  describe("defensive copies", () => {
    it("records() returns copies: mutating the returned array does not affect the ledger", () => {
      const ledger = new BrowserTraceLedger({ now: () => 1 });
      ledger.append("navigate", { url: "a" });
      const recs = ledger.records();
      recs.push({ seq: 99, at: 99, kind: "navigate", detail: {}, prevHash: "x", hash: "y" });
      recs[0]!.seq = 12345;
      expect(ledger.length).toBe(1);
      expect(ledger.records()[0]!.seq).toBe(0);
      expect(ledger.records().length).toBe(1);
    });

    it("records() deep-copies detail: mutating a nested field does not corrupt the ledger", () => {
      const ledger = new BrowserTraceLedger({ now: () => 1 });
      ledger.append("navigate", { url: "a", tags: ["x", "y"] });
      const recs = ledger.records();
      (recs[0]!.detail.tags as string[]).push("INJECTED");
      recs[0]!.detail.url = "CORRUPTED";
      const fresh = ledger.records();
      expect(fresh[0]!.detail.url).toBe("a");
      expect(fresh[0]!.detail.tags).toEqual(["x", "y"]);
      // and the chain still verifies (internal state genuinely untouched)
      expect(verifyTraceChain(ledger.records()).ok).toBe(true);
    });

    it("append() defensive-copies the caller's detail object at call time", () => {
      const ledger = new BrowserTraceLedger({ now: () => 1 });
      const detail = { url: "https://a" };
      const rec = ledger.append("navigate", detail);
      detail.url = "MUTATED-AFTER-APPEND";
      expect(rec.detail.url).toBe("https://a");
      expect(ledger.records()[0]!.detail.url).toBe("https://a");
    });

    it("the record returned by append() is itself a defensive copy", () => {
      const ledger = new BrowserTraceLedger({ now: () => 1 });
      const rec = ledger.append("navigate", { url: "https://a" });
      rec.detail.url = "MUTATED";
      (rec as { seq: number }).seq = 999;
      expect(ledger.records()[0]!.detail.url).toBe("https://a");
      expect(ledger.records()[0]!.seq).toBe(0);
    });
  });

  it("determinism: two ledgers with the same injected clock and inputs produce byte-identical records and rootHash", () => {
    const makeLedger = (): BrowserTraceLedger => {
      const values = [10, 20, 30];
      let idx = 0;
      const ledger = new BrowserTraceLedger({ now: () => values[idx++]! });
      ledger.append("navigate", { url: "https://example.com", status: 200 });
      ledger.append("act", { action: "click", selector: "#go" }, "payload-bytes");
      ledger.append("extract", { passageCount: 2 });
      return ledger;
    };

    const l1 = makeLedger();
    const l2 = makeLedger();
    expect(l1.records()).toEqual(l2.records());
    expect(l1.rootHash()).toBe(l2.rootHash());
  });
});

// ---------------------------------------------------------------------------
// verifyTraceChain
// ---------------------------------------------------------------------------

describe("verifyTraceChain", () => {
  it("an empty array verifies ok with rootHash === TRACE_GENESIS and length 0", () => {
    const result = verifyTraceChain([]);
    expect(result).toEqual({ ok: true, rootHash: TRACE_GENESIS, length: 0 });
  });

  it("a real multi-event ledger verifies ok and matches ledger.rootHash()", () => {
    const ledger = buildFixtureLedger();
    const result = verifyTraceChain(ledger.records());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rootHash).toBe(ledger.rootHash());
      expect(result.length).toBe(4);
    }
  });

  it("rejects a non-array input as malformed at index 0", () => {
    const result = verifyTraceChain(null as unknown as TracedEventRecord[]);
    expect(result).toEqual({ ok: false, index: 0, reason: "malformed" });
  });

  describe("systematic single-field mutation detection over a real fixture", () => {
    const baseline = buildFixtureLedger().records();

    it("sanity: the unmodified baseline verifies ok", () => {
      expect(verifyTraceChain(baseline).ok).toBe(true);
    });

    function checkMutation(index: number, mutate: (r: TracedEventRecord) => void, expectedReason: string): void {
      const mutated = cloneRecords(baseline);
      mutate(mutated[index]!);
      const result = verifyTraceChain(mutated);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect({ index: result.index, reason: result.reason }).toEqual({
          index,
          reason: expectedReason,
        });
      }
    }

    it("detects mutation of every field of every record in the fixture", () => {
      for (let i = 0; i < baseline.length; i++) {
        const rec = baseline[i]!;

        checkMutation(i, (r) => {
          r.seq = r.seq + 1;
        }, "seq-gap");

        checkMutation(i, (r) => {
          r.at = r.at + 1;
        }, "hash-mismatch");

        checkMutation(i, (r) => {
          r.kind = otherKind(r.kind);
        }, "hash-mismatch");

        for (const key of Object.keys(rec.detail)) {
          checkMutation(i, (r) => {
            r.detail[key] = mutateValue(r.detail[key]);
          }, "hash-mismatch");
        }

        if (rec.payloadSha256 !== undefined) {
          checkMutation(i, (r) => {
            const h = r.payloadSha256!;
            r.payloadSha256 = h.slice(0, -1) + (h.endsWith("0") ? "1" : "0");
          }, "hash-mismatch");
        }

        checkMutation(i, (r) => {
          r.prevHash = r.prevHash.slice(0, -1) + (r.prevHash.endsWith("0") ? "1" : "0");
        }, i === 0 ? "genesis-mismatch" : "chain-break");

        checkMutation(i, (r) => {
          r.hash = r.hash.slice(0, -1) + (r.hash.endsWith("0") ? "1" : "0");
        }, "hash-mismatch");
      }
    });
  });

  it("detects swapping two adjacent records", () => {
    const baseline = buildFixtureLedger().records();
    const recs = cloneRecords(baseline);
    const tmp = recs[1]!;
    recs[1] = recs[2]!;
    recs[2] = tmp;
    const result = verifyTraceChain(recs);
    expect(result.ok).toBe(false);
  });

  it("detects deleting an interior record (seq-gap or chain-break)", () => {
    const baseline = buildFixtureLedger().records();
    const recs = cloneRecords(baseline);
    recs.splice(1, 1); // remove the 2nd record
    const result = verifyTraceChain(recs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["seq-gap", "chain-break"]).toContain(result.reason);
    }
  });

  it("truncating the tail changes rootHash; the shorter prefix still verifies as a valid (shorter) chain", () => {
    const baseline = buildFixtureLedger().records();
    const full = verifyTraceChain(baseline);
    const truncated = verifyTraceChain(cloneRecords(baseline).slice(0, 2));
    expect(full.ok).toBe(true);
    expect(truncated.ok).toBe(true);
    if (full.ok && truncated.ok) {
      expect(truncated.rootHash).not.toBe(full.rootHash);
      expect(truncated.length).toBe(2);
    }
  });

  it("detects an appended forged record with a self-consistent hash but wrong prevHash (chain-break)", () => {
    const baseline = buildFixtureLedger().records();
    const recs = cloneRecords(baseline);
    const forgedEvent: BrowserTraceEvent = {
      seq: recs.length,
      at: 9999,
      kind: "act",
      detail: { forged: true },
    };
    const wrongPrev = sha256Hex("a-completely-different-chain-entirely");
    expect(wrongPrev).not.toBe(recs[recs.length - 1]!.hash);
    // self-consistent: hash IS correctly derived from (wrongPrev, forgedEvent) — an attacker who
    // computed the hash formula correctly but grafted onto the wrong ancestor.
    const forgedHash = sha256Hex(wrongPrev + "\n" + canonicalizeTraceEvent(forgedEvent));
    recs.push({ ...forgedEvent, prevHash: wrongPrev, hash: forgedHash });

    const result = verifyTraceChain(recs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.index).toBe(recs.length - 1);
      expect(result.reason).toBe("chain-break");
    }
  });

  it("detects a genesis-mismatch even when the first record's hash is self-consistent with its (wrong) prevHash", () => {
    const wrongPrev = sha256Hex("not-the-real-genesis");
    const event: BrowserTraceEvent = { seq: 0, at: 1000, kind: "navigate", detail: { url: "https://x" } };
    const hash = sha256Hex(wrongPrev + "\n" + canonicalizeTraceEvent(event));
    const record: TracedEventRecord = { ...event, prevHash: wrongPrev, hash };

    const result = verifyTraceChain([record]);
    expect(result).toEqual({ ok: false, index: 0, reason: "genesis-mismatch" });
  });

  describe("malformed record shapes", () => {
    const good: TracedEventRecord = {
      seq: 0,
      at: 1000,
      kind: "navigate",
      detail: { url: "https://x" },
      prevHash: TRACE_GENESIS,
      hash: sha256Hex(TRACE_GENESIS + "\n" + canonicalizeTraceEvent({ seq: 0, at: 1000, kind: "navigate", detail: { url: "https://x" } })),
    };

    function expectMalformed(record: unknown): void {
      const result = verifyTraceChain([record as TracedEventRecord]);
      expect(result).toEqual({ ok: false, index: 0, reason: "malformed" });
    }

    it("rejects an invalid kind string", () => {
      expectMalformed({ ...good, kind: "click" });
    });

    it("rejects detail as an array", () => {
      expectMalformed({ ...good, detail: [] });
    });

    it("rejects detail as null", () => {
      expectMalformed({ ...good, detail: null });
    });

    it("rejects a non-numeric seq", () => {
      expectMalformed({ ...good, seq: "0" });
    });

    it("rejects a non-integer seq", () => {
      expectMalformed({ ...good, seq: 0.5 });
    });

    it("rejects a negative seq", () => {
      expectMalformed({ ...good, seq: -1 });
    });

    it("rejects a NaN `at`", () => {
      expectMalformed({ ...good, at: Number.NaN });
    });

    it("rejects an Infinity `at`", () => {
      expectMalformed({ ...good, at: Number.POSITIVE_INFINITY });
    });

    it("rejects a non-string prevHash", () => {
      expectMalformed({ ...good, prevHash: 12345 });
    });

    it("rejects a missing/undefined hash", () => {
      const { hash: _drop, ...rest } = good;
      expectMalformed(rest);
    });

    it("rejects a non-string payloadSha256", () => {
      expectMalformed({ ...good, payloadSha256: 42 });
    });

    it("rejects a null record", () => {
      expectMalformed(null);
    });

    it("rejects a primitive record", () => {
      expectMalformed("not-a-record");
    });
  });
});

// ---------------------------------------------------------------------------
// traceCertificateFields
// ---------------------------------------------------------------------------

describe("traceCertificateFields", () => {
  it("returns traceRoot/eventCount/firstAt/lastAt for a valid multi-event chain", () => {
    const ledger = buildFixtureLedger();
    const recs = ledger.records();
    const fields = traceCertificateFields(recs);
    expect(fields.traceRoot).toBe(ledger.rootHash());
    expect(fields.eventCount).toBe(4);
    expect(fields.firstAt).toBe(recs[0]!.at);
    expect(fields.lastAt).toBe(recs[recs.length - 1]!.at);
  });

  it("works for a single-event chain (firstAt === lastAt)", () => {
    const ledger = new BrowserTraceLedger({ now: () => 777 });
    ledger.append("navigate", { url: "https://x" });
    const fields = traceCertificateFields(ledger.records());
    expect(fields.eventCount).toBe(1);
    expect(fields.firstAt).toBe(777);
    expect(fields.lastAt).toBe(777);
  });

  it("throws, never certifying, when the chain fails verifyTraceChain", () => {
    const ledger = buildFixtureLedger();
    const recs = cloneRecords(ledger.records());
    recs[1]!.at = recs[1]!.at + 1; // corrupt -> hash-mismatch at index 1
    expect(() => traceCertificateFields(recs)).toThrow(/index 1/);
    expect(() => traceCertificateFields(recs)).toThrow(/hash-mismatch/);
  });

  it("throws on an empty trace (no honest firstAt/lastAt to report)", () => {
    expect(() => traceCertificateFields([])).toThrow(/empty/i);
  });
});
