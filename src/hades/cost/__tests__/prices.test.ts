/**
 * Price-table tests.
 *
 * The property under test is not "the arithmetic is right" (it is one
 * multiply-add). It is that the module REFUSES TO GUESS: an unpriced model
 * must be impossible to fold into a total as `$0`, because every per-dollar
 * metric in `../../bench/vtph.ts` divides by spend and a fabricated zero
 * inflates all of them.
 */
import { describe, expect, it } from "vitest";
import {
  MODEL_PRICES,
  PRICES_FILE_VAR,
  loadPriceTableFromEnv,
  lookupPrice,
  priceCall,
  toPriceEntries,
  type ModelPrice,
} from "../prices";
import { DEFAULT_PRICES, computeCost } from "../../models/client";

describe("price table", () => {
  it("prices a known model from measured tokens", () => {
    const priced = priceCall("gpt-4o-mini", 50, 10, MODEL_PRICES);
    expect(priced.priced).toBe(true);
    // 50/1e6*0.15 + 10/1e6*0.60 — the exact figure the loopback stub produces.
    if (priced.priced) expect(priced.usd).toBeCloseTo(0.0000135, 12);
  });

  it("returns UNKNOWN — not $0 — for a model it does not know", () => {
    const priced = priceCall("llama-3.3-70b-local", 1_000_000, 1_000_000);
    expect(priced.priced).toBe(false);
    // The load-bearing assertion: `null`, so `total += usd` cannot silently
    // add nothing. A `0` here would read as "this model is free".
    expect(priced.usd).toBeNull();
    if (!priced.priced) expect(priced.reason).toBe("no-published-price");
  });

  it("matches model ids EXACTLY — a dated snapshot is not its family", () => {
    expect(lookupPrice("gpt-4o").known).toBe(true);
    expect(lookupPrice("gpt-4o-2024-11-20").known).toBe(false);
  });

  it("every shipped entry cites a source and a repo edit date", () => {
    for (const p of MODEL_PRICES) {
      expect(p.source.length).toBeGreaterThan(0);
      expect(p.lastEditedInRepo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.inputUsdPerMTok).toBeGreaterThan(0);
      expect(p.outputUsdPerMTok).toBeGreaterThan(0);
    }
  });

  it("does not let a broken provider report subtract from a bill", () => {
    const priced = priceCall("gpt-4o", -1_000_000, 10, MODEL_PRICES);
    expect(priced.priced).toBe(true);
    if (priced.priced) expect(priced.usd).toBeGreaterThan(0);
  });

  it("is the SINGLE source of truth behind DEFAULT_PRICES (no second table)", () => {
    // If someone re-adds a hand-written table to models/client.ts, this fails.
    expect(DEFAULT_PRICES).toEqual(toPriceEntries(MODEL_PRICES));
    for (const p of MODEL_PRICES) {
      expect(computeCost(p.model, 1e6, 0, DEFAULT_PRICES)).toBeCloseTo(p.inputUsdPerMTok, 9);
    }
  });
});

describe("operator override (HADES_PRICES_FILE)", () => {
  const good: ModelPrice[] = [
    {
      model: "my-local-model",
      inputUsdPerMTok: 0.05,
      outputUsdPerMTok: 0.1,
      source: "internal rate card",
      lastEditedInRepo: "2026-01-01",
    },
  ];

  it("uses the builtin table when the variable is unset", () => {
    const res = loadPriceTableFromEnv({}, () => {
      throw new Error("must not read a file");
    });
    expect(res.source).toBe("builtin");
    expect(res.problem).toBeUndefined();
    expect(res.table).toBe(MODEL_PRICES);
  });

  it("adopts a well-formed override and reports where it came from", () => {
    const res = loadPriceTableFromEnv({ [PRICES_FILE_VAR]: "/rates.json" }, () => JSON.stringify(good));
    expect(res.source).toBe("/rates.json");
    expect(res.problem).toBeUndefined();
    expect(priceCall("my-local-model", 1e6, 0, res.table)).toMatchObject({ priced: true, usd: 0.05 });
  });

  it("NAMES the problem rather than silently using the builtin numbers", () => {
    const unreadable = loadPriceTableFromEnv({ [PRICES_FILE_VAR]: "/nope.json" }, () => {
      throw new Error("ENOENT");
    });
    expect(unreadable.table).toBe(MODEL_PRICES);
    expect(unreadable.problem).toContain("/nope.json");
    expect(unreadable.problem).toContain("using the builtin table");

    const malformed = loadPriceTableFromEnv({ [PRICES_FILE_VAR]: "/bad.json" }, () => "{not json");
    expect(malformed.problem).toContain("not valid JSON");

    const wrongShape = loadPriceTableFromEnv({ [PRICES_FILE_VAR]: "/x.json" }, () =>
      JSON.stringify([{ model: "m", inputUsdPerMTok: "free", outputUsdPerMTok: 1 }]),
    );
    expect(wrongShape.problem).toContain("inputUsdPerMTok");
    expect(wrongShape.table).toBe(MODEL_PRICES);
  });

  it("rejects a negative price rather than crediting the run", () => {
    const res = loadPriceTableFromEnv({ [PRICES_FILE_VAR]: "/x.json" }, () =>
      JSON.stringify([{ model: "m", inputUsdPerMTok: -1, outputUsdPerMTok: 1 }]),
    );
    expect(res.problem).toContain(">= 0");
  });

  it("never invents provenance for an override entry that omits it", () => {
    const res = loadPriceTableFromEnv({ [PRICES_FILE_VAR]: "/x.json" }, () =>
      JSON.stringify([{ model: "m", inputUsdPerMTok: 1, outputUsdPerMTok: 2 }]),
    );
    expect(res.table[0].source).toContain("operator override");
    expect(res.table[0].lastEditedInRepo).toContain("override file");
  });
});
