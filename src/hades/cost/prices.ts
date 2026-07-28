/**
 * The per-model price table — and, more importantly, the ONE place that is
 * allowed to say "I do not know what this model costs".
 *
 * ## Why this module exists
 *
 * The whole product thesis is correct-work-per-dollar (`../bench/vtph.ts`:
 * V-TPH$ and the trust-adjusted Verified Yield). Every one of those metrics
 * divides by spend. That makes an *understated* dollar figure the most
 * flattering possible error: a run whose true cost was $0.02 but which
 * reports $0.01 doubles its own headline. A run that reports $0 for an
 * unpriced model does not merely score well — it scores INFINITELY well,
 * because the metric's floored denominator (`max(totalUsd, 1e-9)`) turns a
 * fabricated zero into a division by nothing.
 *
 * So the rule this module enforces is narrow and absolute:
 *
 *   **An unpriced model contributes UNKNOWN, never $0.**
 *
 * {@link priceCall} returns a discriminated union — `{ priced: true, usd }`
 * or `{ priced: false, usd: null }` — so a caller cannot accidentally add an
 * unpriced call into a running total. `null` does not sum; `0` does. The type
 * system is doing the honesty enforcement here, which is the only kind of
 * enforcement that survives a refactor.
 *
 * ## What the numbers are, and what they are NOT
 *
 * {@link MODEL_PRICES} is a **transcription of the vendors' published list
 * prices**, per entry, with the page it was transcribed from in `source` and
 * the date the entry was last edited in this repository in `lastEditedInRepo`.
 *
 * That date is exactly what it says: when the line was last touched HERE. It
 * is **not** evidence that the vendor's page still says the same thing today.
 * Nothing in this process re-fetches a pricing page — there is no network
 * call in this file and there never should be, because a benchmark whose
 * numbers move when a vendor edits a web page is not reproducible.
 *
 * Consequences, stated plainly rather than buried:
 *
 *   - These are LIST prices: no batch discount, no prompt-cache discount, no
 *     negotiated enterprise rate, no long-context surcharge tier. A real bill
 *     can differ in either direction.
 *   - They can go stale. A deployment that needs authoritative numbers
 *     supplies its own table — see {@link loadPriceTableFromEnv} and the
 *     `HADES_PRICES_FILE` environment variable — and every consumer in this
 *     codebase takes the table as a parameter for exactly that reason.
 *   - A model that is not in the table is reported UNKNOWN. Adding a
 *     guessed-by-analogy price to make a total look complete would be the
 *     precise failure this module exists to prevent.
 *
 * ## Purity
 *
 * No `Date.now()`, no `Math.random()`, no network. {@link loadPriceTableFromEnv}
 * is the only function that touches the filesystem, and it does so only when
 * the operator explicitly points an environment variable at a file.
 *
 * @module hades/cost/prices
 */

// ---------------------------------------------------------------------------
// The price record
// ---------------------------------------------------------------------------

/**
 * One model's published list price, in USD per 1e6 (one million) tokens —
 * the unit every vendor quotes, kept verbatim so a reader can diff this table
 * against a pricing page without doing arithmetic in their head.
 */
export interface ModelPrice {
  /** Exact model id, as sent on the wire. Matching is exact — see {@link lookupPrice}. */
  model: string;
  /** USD per 1e6 input (prompt) tokens. */
  inputUsdPerMTok: number;
  /** USD per 1e6 output (completion) tokens. */
  outputUsdPerMTok: number;
  /** The published page this number was transcribed from. */
  source: string;
  /**
   * The date this LINE was last edited in this repository (ISO yyyy-mm-dd).
   * NOT a claim that the vendor's page still agrees — nothing re-checks it.
   * Surfaced by `hades cost prices` so a stale table is visible, not silent.
   */
  lastEditedInRepo: string;
}

/**
 * Published list prices for the models this build knows about.
 *
 * Ids are kept in sync with `../models/defaults.ts` (the Claude catalog the
 * model registry ships) and with the OpenAI-dialect ids the run/chat paths
 * default to. An id absent from this list is UNKNOWN, not free.
 */
export const MODEL_PRICES: readonly ModelPrice[] = [
  // --- Anthropic / Claude -------------------------------------------------
  // Source: https://www.anthropic.com/pricing (standard API list pricing;
  // no batch / prompt-cache / long-context tier applied).
  {
    model: "claude-opus-4-1",
    inputUsdPerMTok: 15,
    outputUsdPerMTok: 75,
    source: "https://www.anthropic.com/pricing — Claude Opus tier, standard API list price",
    lastEditedInRepo: "2026-07-28",
  },
  {
    model: "claude-sonnet-5",
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
    source: "https://www.anthropic.com/pricing — Claude Sonnet tier, standard API list price",
    lastEditedInRepo: "2026-07-28",
  },
  {
    model: "claude-haiku-4-5-20251001",
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 5,
    source: "https://www.anthropic.com/pricing — Claude Haiku 4.5, standard API list price",
    lastEditedInRepo: "2026-07-28",
  },
  {
    model: "claude-fable-5",
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 5,
    // NOT transcribed from a published page: this model has no list price on
    // anthropic.com/pricing at time of writing. The figure is an ANALOGY to
    // the Haiku tier, which the module's own rule forbids presenting as a
    // cited source. Labelled as derived so a reader can discount it.
    source: "DERIVED (not published): no list price available; assumed equal to the Haiku tier",
    lastEditedInRepo: "2026-07-28",
  },
  // --- OpenAI-dialect -----------------------------------------------------
  // Source: https://openai.com/api/pricing (standard list pricing; no batch
  // or cached-input discount applied).
  {
    model: "gpt-4o",
    inputUsdPerMTok: 2.5,
    outputUsdPerMTok: 10,
    source: "https://openai.com/api/pricing — gpt-4o, standard (non-batch, non-cached) list price",
    lastEditedInRepo: "2026-07-28",
  },
  {
    model: "gpt-4o-mini",
    inputUsdPerMTok: 0.15,
    outputUsdPerMTok: 0.6,
    source: "https://openai.com/api/pricing — gpt-4o-mini, standard (non-batch, non-cached) list price",
    lastEditedInRepo: "2026-07-28",
  },
  {
    model: "gpt-4.1",
    inputUsdPerMTok: 2,
    outputUsdPerMTok: 8,
    source: "https://openai.com/api/pricing — gpt-4.1, standard (non-batch, non-cached) list price",
    lastEditedInRepo: "2026-07-28",
  },
  {
    model: "gpt-4.1-mini",
    inputUsdPerMTok: 0.4,
    outputUsdPerMTok: 1.6,
    source: "https://openai.com/api/pricing — gpt-4.1-mini, standard (non-batch, non-cached) list price",
    lastEditedInRepo: "2026-07-28",
  },
];

/**
 * One line, printed by every cost surface, that keeps the reader from
 * mistaking a transcription for a receipt. Kept here (not in the renderer) so
 * every surface says the same thing.
 */
export const PRICE_TABLE_CAVEAT =
  "prices are transcribed vendor LIST prices (no batch/cache/enterprise discount) and are not " +
  "re-checked at runtime; override with HADES_PRICES_FILE";

// ---------------------------------------------------------------------------
// Lookup — the "I do not know" path is a first-class result
// ---------------------------------------------------------------------------

/** Result of {@link lookupPrice}: found, or explicitly not found. */
export type PriceLookup =
  | { known: true; price: ModelPrice }
  | { known: false; model: string };

/**
 * Look a model up by EXACT id. No prefix matching, no "close enough" family
 * fallback: `gpt-4o-2024-11-20` is not `gpt-4o`, and pretending otherwise
 * would silently bill a dated snapshot at a price nobody checked. An
 * operator who knows two ids share a price says so in their own table.
 */
export function lookupPrice(
  model: string,
  table: readonly ModelPrice[] = MODEL_PRICES,
): PriceLookup {
  const price = table.find((p) => p.model === model);
  return price ? { known: true, price } : { known: false, model };
}

/**
 * Cost of ONE call, or an explicit refusal to guess.
 *
 * `priced: false` carries `usd: null` — deliberately not `0` and not
 * `undefined`. `null` is the value that (a) fails `typeof x === "number"`
 * guards, (b) survives `JSON.stringify` round-trips into the run journal, and
 * (c) makes `total += usd` a type error rather than a silent understatement.
 */
export type PricedCall =
  | { priced: true; usd: number; price: ModelPrice }
  | { priced: false; usd: null; model: string; reason: "no-published-price" };

/**
 * Price a single call from REAL measured token counts:
 *
 *   tokensIn / 1e6 * inputUsdPerMTok + tokensOut / 1e6 * outputUsdPerMTok
 *
 * Pure. Negative token counts are treated as 0 (a provider reporting a
 * negative usage count is broken, and letting it subtract from a bill would
 * be a free credit); non-finite counts propagate as-is so a caller cannot
 * mistake NaN for a real charge.
 */
export function priceCall(
  model: string,
  tokensIn: number,
  tokensOut: number,
  table: readonly ModelPrice[] = MODEL_PRICES,
): PricedCall {
  const found = lookupPrice(model, table);
  if (!found.known) {
    return { priced: false, usd: null, model, reason: "no-published-price" };
  }
  const inTok = Number.isFinite(tokensIn) ? Math.max(0, tokensIn) : tokensIn;
  const outTok = Number.isFinite(tokensOut) ? Math.max(0, tokensOut) : tokensOut;
  const usd =
    (inTok / 1e6) * found.price.inputUsdPerMTok +
    (outTok / 1e6) * found.price.outputUsdPerMTok;
  return { priced: true, usd, price: found.price };
}

// ---------------------------------------------------------------------------
// Interop with the pre-existing PriceEntry shape
// ---------------------------------------------------------------------------

/**
 * The legacy `PriceEntry` shape from `../models/client.ts`, declared
 * structurally rather than imported so this module has NO import edge back
 * into the model client (which imports this one). Same fields, same units.
 */
export interface LegacyPriceEntry {
  model: string;
  inPerMTok: number;
  outPerMTok: number;
}

/**
 * Project the table into the `PriceEntry[]` shape `../models/client.ts` and
 * `../routing/arms.ts` already consume, so `DEFAULT_PRICES` is a *view* of
 * this table rather than a second copy of the numbers. One table, no drift.
 */
export function toPriceEntries(
  table: readonly ModelPrice[] = MODEL_PRICES,
): LegacyPriceEntry[] {
  return table.map((p) => ({
    model: p.model,
    inPerMTok: p.inputUsdPerMTok,
    outPerMTok: p.outputUsdPerMTok,
  }));
}

// ---------------------------------------------------------------------------
// Operator override — the answer to "your list price is stale"
// ---------------------------------------------------------------------------

/** Env var naming a JSON file of {@link ModelPrice} records to use instead. */
export const PRICES_FILE_VAR = "HADES_PRICES_FILE";

/** Outcome of {@link loadPriceTableFromEnv}. `source` is always safe to print. */
export interface PriceTableResolution {
  table: readonly ModelPrice[];
  /** `"builtin"`, or the PATH the operator pointed the env var at. */
  source: "builtin" | string;
  /**
   * Present iff the operator asked for an override and it could not be used.
   * The table then stays BUILTIN and this string says why — an unreadable
   * override never silently downgrades to the shipped numbers unannounced.
   */
  problem?: string;
}

/**
 * Resolve the price table for this process.
 *
 * With `HADES_PRICES_FILE` unset: the builtin table, `source: "builtin"`.
 * With it set: parse that file as a JSON array of {@link ModelPrice}. A file
 * that is missing, unparseable, or not an array of well-formed entries does
 * NOT throw and does NOT silently vanish — the builtin table is returned with
 * a populated `problem`, which every surface prints. The failure mode this
 * avoids is an operator believing their corrected prices are in effect when a
 * typo in the path means they are not.
 *
 * `readFile` is injectable so this is unit-testable with no real filesystem.
 */
export function loadPriceTableFromEnv(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): PriceTableResolution {
  const path = env[PRICES_FILE_VAR];
  if (!path) return { table: MODEL_PRICES, source: "builtin" };

  let raw: string;
  try {
    raw = readFile(path);
  } catch (err) {
    return {
      table: MODEL_PRICES,
      source: "builtin",
      problem: `${PRICES_FILE_VAR}=${path} could not be read (${errText(err)}) — using the builtin table`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      table: MODEL_PRICES,
      source: "builtin",
      problem: `${PRICES_FILE_VAR}=${path} is not valid JSON (${errText(err)}) — using the builtin table`,
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      table: MODEL_PRICES,
      source: "builtin",
      problem: `${PRICES_FILE_VAR}=${path} must contain a JSON ARRAY of price entries — using the builtin table`,
    };
  }

  const table: ModelPrice[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = coercePrice(parsed[i], path);
    if (typeof entry === "string") {
      return {
        table: MODEL_PRICES,
        source: "builtin",
        problem: `${PRICES_FILE_VAR}=${path} entry ${i}: ${entry} — using the builtin table`,
      };
    }
    table.push(entry);
  }
  return { table, source: path };
}

/** Validate one override entry. Returns the entry, or a reason string. */
function coercePrice(value: unknown, path: string): ModelPrice | string {
  if (typeof value !== "object" || value === null) return "not an object";
  const o = value as Record<string, unknown>;
  if (typeof o.model !== "string" || o.model.length === 0) return "missing string `model`";
  const inUsd = o.inputUsdPerMTok;
  const outUsd = o.outputUsdPerMTok;
  if (typeof inUsd !== "number" || !Number.isFinite(inUsd) || inUsd < 0) {
    return "`inputUsdPerMTok` must be a finite number >= 0";
  }
  if (typeof outUsd !== "number" || !Number.isFinite(outUsd) || outUsd < 0) {
    return "`outputUsdPerMTok` must be a finite number >= 0";
  }
  return {
    model: o.model,
    inputUsdPerMTok: inUsd,
    outputUsdPerMTok: outUsd,
    // Provenance is optional in an override file, but it is never invented:
    // an entry that names no source says so, naming the file it came from.
    source: typeof o.source === "string" && o.source ? o.source : `operator override (${path})`,
    lastEditedInRepo:
      typeof o.lastEditedInRepo === "string" && o.lastEditedInRepo ? o.lastEditedInRepo : "n/a (override file)",
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
