/**
 * Portable full-text search engine over recorded sessions — the Hermes-FTS5
 * analogue for Hades. A hand-rolled positional inverted index with real BM25F
 * ranking (per-field weighting + per-field length normalization), phrase and
 * prefix queries, highlighted snippet extraction, and versioned JSON
 * serialization. Zero dependencies beyond the language itself.
 *
 * Design notes (read before touching the scoring math):
 *
 *  - Every string that flows through the index — document field text, query
 *    text — is first run through `normalizeText`: NFKC normalization followed
 *    by `toLowerCase()`. Tokenization, positional postings, and snippet
 *    extraction all operate on this canonical form. That is a deliberate
 *    choice: NFKC and case-folding can change a string's length (a ligature
 *    like "ﬁ" expands to "fi"; "İ".toLowerCase() expands to two UTF-16 units).
 *    By always tokenizing and slicing the *same* normalized string, highlight
 *    offsets are correct by construction — there is never a raw-vs-normalized
 *    length mismatch to reconcile. The cost is that displayed snippets are
 *    lowercase; that's an acceptable, explicit trade for offset correctness.
 *  - Offsets returned by `ftsTokenize` are UTF-16 code-unit indices (ordinary
 *    JS string indices) into that normalized string, so callers can always
 *    `normalizedText.slice(start, end)` directly — including across
 *    surrogate-pair (astral-plane / emoji) boundaries, which the tokenizer
 *    regex (`\p{L}\p{N}` with the `u` flag) respects natively.
 *  - Positional postings enable true phrase search: postings store the
 *    sequential token index within a field, and phrase matching checks that
 *    consecutive query terms occupy consecutive positions in the same field.
 *  - The vocabulary is kept as a sorted array (rebuilt lazily on mutation) so
 *    prefix queries binary-search to the start of the matching range instead
 *    of scanning every term.
 */

const IDF_FLOOR = 1e-9;
const DEFAULT_K1 = 1.2;
const DEFAULT_B = 0.75;
const DEFAULT_LIMIT = 10;
const SNIPPET_WINDOW = 200;
const DEFAULT_FIELD_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  title: 2.5,
  summary: 1.8,
  content: 1.0,
});

/** Thrown for every recoverable FTS error: duplicate ids, malformed serialized payloads, etc. */
export class FtsIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FtsIndexError";
  }
}

function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/**
 * Tokenizes `text` into unicode letter/digit runs. Internally normalizes via
 * NFKC + lowercase first (see module docs), so `term` values are already
 * folded, and `start`/`end` are UTF-16 code-unit offsets into that normalized
 * form — safe to use with `text.normalize("NFKC").toLowerCase().slice(start, end)`.
 * Self-contained: no dependency on ./store's tokenizer.
 */
export function ftsTokenize(text: string): Array<{ term: string; start: number; end: number }> {
  const normalized = normalizeText(text);
  const tokens: Array<{ term: string; start: number; end: number }> = [];
  const re = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    tokens.push({ term: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

export interface FtsDocument {
  id: string;
  fields: Record<string, string>;
}

export interface FtsMatch {
  id: string;
  score: number;
  matchedTerms: string[];
  snippet: {
    field: string;
    text: string;
    highlights: Array<[number, number]>;
  };
}

export interface FtsQueryOptions {
  limit?: number;
  prefix?: boolean;
  phrase?: boolean;
  requireAll?: boolean;
}

export interface InvertedIndexOptions {
  fieldWeights?: Record<string, number>;
  k1?: number;
  b?: number;
}

interface DocEntry {
  /** Normalized (NFKC + lowercased) text per field — see module docs. */
  fields: Record<string, string>;
  /** Token count per field, used for BM25 length normalization. */
  fieldTokenCount: Record<string, number>;
}

interface FtsIndexEnvelopeV1 {
  v: 1;
  k1: number;
  b: number;
  fieldWeights: Record<string, number>;
  fieldTotalLength: Record<string, number>;
  docs: Array<{ id: string; fields: Record<string, string>; fieldTokenCount: Record<string, number> }>;
  postings: Array<{ term: string; entries: Array<{ docId: string; fields: Record<string, number[]> }> }>;
}

/**
 * A positional inverted index with BM25F ranking, phrase/prefix query
 * support, and versioned JSON serialization. See module-level docs for the
 * normalization and offset conventions.
 */
export class InvertedIndex {
  private readonly fieldWeights: Record<string, number>;
  private readonly k1: number;
  private readonly b: number;

  /** term -> docId -> field -> sorted-by-insertion positional postings. */
  private postings = new Map<string, Map<string, Map<string, number[]>>>();
  private docsMap = new Map<string, DocEntry>();
  /** Sum of field token counts across every indexed doc (0 for docs missing the field). */
  private fieldTotalLength: Record<string, number> = {};

  private sortedTerms: string[] = [];
  private sortedTermsDirty = true;

  constructor(opts: InvertedIndexOptions = {}) {
    this.fieldWeights = opts.fieldWeights ? { ...opts.fieldWeights } : { ...DEFAULT_FIELD_WEIGHTS };
    this.k1 = opts.k1 ?? DEFAULT_K1;
    this.b = opts.b ?? DEFAULT_B;
  }

  /** Indexes a new document. Throws FtsIndexError if `doc.id` already exists — use update() to replace. */
  add(doc: FtsDocument): void {
    if (this.docsMap.has(doc.id)) {
      throw new FtsIndexError(`cannot add document: id "${doc.id}" already exists; use update() to replace it`);
    }
    this.indexDocument(doc);
  }

  /** Upsert: replaces the document if `doc.id` exists (fully reclaiming its old postings first), else inserts it. */
  update(doc: FtsDocument): void {
    if (this.docsMap.has(doc.id)) {
      this.removeInternal(doc.id);
    }
    this.indexDocument(doc);
  }

  /** Removes a document, fully reclaiming its postings and adjusting length stats. Returns whether it existed. */
  remove(id: string): boolean {
    if (!this.docsMap.has(id)) return false;
    this.removeInternal(id);
    return true;
  }

  has(id: string): boolean {
    return this.docsMap.has(id);
  }

  size(): number {
    return this.docsMap.size;
  }

  search(query: string, opts: FtsQueryOptions = {}): FtsMatch[] {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    if (limit <= 0) return [];
    const prefix = opts.prefix ?? false;
    const phrase = opts.phrase ?? false;
    const requireAll = opts.requireAll ?? false;

    const queryTokens = ftsTokenize(query);
    if (queryTokens.length === 0) return [];

    const N = this.docsMap.size;
    if (N === 0) return [];

    this.rebuildSortedTermsIfNeeded();

    const terms = queryTokens.map((t) => t.term);
    return phrase
      ? this.searchPhrase(terms, { prefix }, N, limit)
      : this.searchTerms(terms, { prefix, requireAll }, N, limit);
  }

  serialize(): string {
    const docs: FtsIndexEnvelopeV1["docs"] = [];
    for (const [id, entry] of this.docsMap) {
      docs.push({ id, fields: entry.fields, fieldTokenCount: entry.fieldTokenCount });
    }
    const postings: FtsIndexEnvelopeV1["postings"] = [];
    for (const [term, byDoc] of this.postings) {
      const entries: FtsIndexEnvelopeV1["postings"][number]["entries"] = [];
      for (const [docId, fieldMap] of byDoc) {
        entries.push({ docId, fields: Object.fromEntries(fieldMap) });
      }
      postings.push({ term, entries });
    }
    const envelope: FtsIndexEnvelopeV1 = {
      v: 1,
      k1: this.k1,
      b: this.b,
      fieldWeights: this.fieldWeights,
      fieldTotalLength: this.fieldTotalLength,
      docs,
      postings,
    };
    return JSON.stringify(envelope);
  }

  static deserialize(json: string): InvertedIndex {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      throw new FtsIndexError(`cannot deserialize index: invalid JSON (${(err as Error).message})`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new FtsIndexError("cannot deserialize index: payload must be a JSON object");
    }
    const env = parsed as Record<string, unknown>;
    if (env.v !== 1) {
      throw new FtsIndexError(`cannot deserialize index: unsupported version ${JSON.stringify(env.v)}`);
    }

    const k1 = env.k1;
    const b = env.b;
    if (typeof k1 !== "number" || !Number.isFinite(k1)) {
      throw new FtsIndexError("cannot deserialize index: malformed k1");
    }
    if (typeof b !== "number" || !Number.isFinite(b)) {
      throw new FtsIndexError("cannot deserialize index: malformed b");
    }

    const fieldWeights = InvertedIndex.expectNumberRecord(env.fieldWeights, "fieldWeights");
    const fieldTotalLength = InvertedIndex.expectNumberRecord(env.fieldTotalLength, "fieldTotalLength");

    if (!Array.isArray(env.docs)) throw new FtsIndexError("cannot deserialize index: malformed docs array");
    const docIds = new Set<string>();
    const docs: FtsIndexEnvelopeV1["docs"] = [];
    for (const d of env.docs) {
      if (typeof d !== "object" || d === null || Array.isArray(d)) {
        throw new FtsIndexError("cannot deserialize index: malformed doc entry");
      }
      const dd = d as Record<string, unknown>;
      if (typeof dd.id !== "string" || dd.id.length === 0) {
        throw new FtsIndexError("cannot deserialize index: doc missing a valid id");
      }
      if (docIds.has(dd.id)) {
        throw new FtsIndexError(`cannot deserialize index: duplicate doc id "${dd.id}"`);
      }
      if (typeof dd.fields !== "object" || dd.fields === null || Array.isArray(dd.fields)) {
        throw new FtsIndexError(`cannot deserialize index: doc "${dd.id}" has malformed fields`);
      }
      for (const v of Object.values(dd.fields as Record<string, unknown>)) {
        if (typeof v !== "string") {
          throw new FtsIndexError(`cannot deserialize index: doc "${dd.id}" has a non-string field value`);
        }
      }
      const fieldTokenCount = InvertedIndex.expectNumberRecord(dd.fieldTokenCount, `doc "${dd.id}" fieldTokenCount`);
      docIds.add(dd.id);
      docs.push({ id: dd.id, fields: dd.fields as Record<string, string>, fieldTokenCount });
    }

    if (!Array.isArray(env.postings)) throw new FtsIndexError("cannot deserialize index: malformed postings array");
    const postings: FtsIndexEnvelopeV1["postings"] = [];
    for (const p of env.postings) {
      if (typeof p !== "object" || p === null || Array.isArray(p)) {
        throw new FtsIndexError("cannot deserialize index: malformed posting entry");
      }
      const pp = p as Record<string, unknown>;
      if (typeof pp.term !== "string") throw new FtsIndexError("cannot deserialize index: posting missing term");
      if (!Array.isArray(pp.entries)) {
        throw new FtsIndexError(`cannot deserialize index: posting "${pp.term}" has malformed entries`);
      }
      const entries: FtsIndexEnvelopeV1["postings"][number]["entries"] = [];
      for (const e of pp.entries) {
        if (typeof e !== "object" || e === null || Array.isArray(e)) {
          throw new FtsIndexError(`cannot deserialize index: posting "${pp.term}" has a malformed entry`);
        }
        const ee = e as Record<string, unknown>;
        if (typeof ee.docId !== "string") {
          throw new FtsIndexError(`cannot deserialize index: posting "${pp.term}" entry missing docId`);
        }
        if (!docIds.has(ee.docId)) {
          throw new FtsIndexError(`cannot deserialize index: posting "${pp.term}" references unknown document id "${ee.docId}"`);
        }
        if (typeof ee.fields !== "object" || ee.fields === null || Array.isArray(ee.fields)) {
          throw new FtsIndexError(`cannot deserialize index: posting "${pp.term}" entry has malformed fields`);
        }
        const fieldsRec: Record<string, number[]> = {};
        for (const [fieldName, positions] of Object.entries(ee.fields as Record<string, unknown>)) {
          if (!Array.isArray(positions) || positions.some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 0)) {
            throw new FtsIndexError(
              `cannot deserialize index: posting "${pp.term}" has malformed positions for field "${fieldName}"`,
            );
          }
          fieldsRec[fieldName] = positions as number[];
        }
        entries.push({ docId: ee.docId, fields: fieldsRec });
      }
      postings.push({ term: pp.term, entries });
    }

    const idx = new InvertedIndex({ fieldWeights, k1, b });
    for (const d of docs) {
      idx.docsMap.set(d.id, { fields: d.fields, fieldTokenCount: d.fieldTokenCount });
    }
    idx.fieldTotalLength = { ...fieldTotalLength };
    for (const p of postings) {
      const byDoc = new Map<string, Map<string, number[]>>();
      for (const e of p.entries) {
        byDoc.set(e.docId, new Map(Object.entries(e.fields)));
      }
      idx.postings.set(p.term, byDoc);
    }
    idx.sortedTermsDirty = true;
    return idx;
  }

  // ---- internals -----------------------------------------------------

  private static expectNumberRecord(value: unknown, label: string): Record<string, number> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new FtsIndexError(`cannot deserialize index: malformed ${label}`);
    }
    const rec = value as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new FtsIndexError(`cannot deserialize index: malformed ${label} value for "${k}"`);
      }
    }
    return rec as Record<string, number>;
  }

  private indexDocument(doc: FtsDocument): void {
    const fields: Record<string, string> = {};
    const fieldTokenCount: Record<string, number> = {};
    for (const [field, rawText] of Object.entries(doc.fields)) {
      fields[field] = normalizeText(rawText);
      const tokens = ftsTokenize(rawText);
      fieldTokenCount[field] = tokens.length;
      this.fieldTotalLength[field] = (this.fieldTotalLength[field] ?? 0) + tokens.length;
      tokens.forEach((tok, position) => this.addPosting(tok.term, doc.id, field, position));
    }
    this.docsMap.set(doc.id, { fields, fieldTokenCount });
  }

  private removeInternal(id: string): void {
    const entry = this.docsMap.get(id);
    if (!entry) return;
    for (const [field, text] of Object.entries(entry.fields)) {
      const distinctTerms = new Set(ftsTokenize(text).map((t) => t.term));
      for (const term of distinctTerms) this.removeFieldPostings(term, id, field);
      this.fieldTotalLength[field] = Math.max(0, (this.fieldTotalLength[field] ?? 0) - (entry.fieldTokenCount[field] ?? 0));
    }
    this.docsMap.delete(id);
  }

  private addPosting(term: string, docId: string, field: string, position: number): void {
    let byDoc = this.postings.get(term);
    if (!byDoc) {
      byDoc = new Map();
      this.postings.set(term, byDoc);
      this.sortedTermsDirty = true;
    }
    let byField = byDoc.get(docId);
    if (!byField) {
      byField = new Map();
      byDoc.set(docId, byField);
    }
    let positions = byField.get(field);
    if (!positions) {
      positions = [];
      byField.set(field, positions);
    }
    positions.push(position);
  }

  private removeFieldPostings(term: string, docId: string, field: string): void {
    const byDoc = this.postings.get(term);
    if (!byDoc) return;
    const byField = byDoc.get(docId);
    if (!byField) return;
    byField.delete(field);
    if (byField.size === 0) byDoc.delete(docId);
    if (byDoc.size === 0) {
      this.postings.delete(term);
      this.sortedTermsDirty = true;
    }
  }

  private rebuildSortedTermsIfNeeded(): void {
    if (!this.sortedTermsDirty) return;
    this.sortedTerms = [...this.postings.keys()].sort();
    this.sortedTermsDirty = false;
  }

  /** First index in sortedTerms whose value is >= target. */
  private lowerBound(target: string): number {
    let lo = 0;
    let hi = this.sortedTerms.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sortedTerms[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** All vocabulary terms starting with `prefix`, found via binary search into the sorted term array. */
  private expandPrefix(prefix: string): string[] {
    if (prefix.length === 0) return [];
    const start = this.lowerBound(prefix);
    const result: string[] = [];
    for (let i = start; i < this.sortedTerms.length; i++) {
      const term = this.sortedTerms[i];
      if (!term.startsWith(prefix)) break;
      result.push(term);
    }
    return result;
  }

  private avgFieldLength(field: string, N: number): number {
    if (N <= 0) return 0;
    return (this.fieldTotalLength[field] ?? 0) / N;
  }

  /** 0.5-smoothed IDF, floored above zero so a term present in every document still yields a finite, non-negative score. */
  private idf(N: number, df: number): number {
    if (N <= 0 || df <= 0) return IDF_FLOOR;
    const raw = Math.log((N - df + 0.5) / (df + 0.5));
    return raw > IDF_FLOOR ? raw : IDF_FLOOR;
  }

  private searchTerms(
    queryTerms: string[],
    opts: { prefix: boolean; requireAll: boolean },
    N: number,
    limit: number,
  ): FtsMatch[] {
    const distinctTerms = [...new Set(queryTerms)];
    const docScore = new Map<string, number>();
    const docFieldStrength = new Map<string, Map<string, number>>();
    const docQueryTermsMatched = new Map<string, Set<string>>();
    const docVocabTermsMatched = new Map<string, Set<string>>();

    for (const qTerm of distinctTerms) {
      const vocabTerms = opts.prefix ? this.expandPrefix(qTerm) : this.postings.has(qTerm) ? [qTerm] : [];
      for (const vTerm of vocabTerms) {
        const byDoc = this.postings.get(vTerm);
        if (!byDoc) continue;
        const df = byDoc.size;
        if (df === 0) continue;
        const idfVal = this.idf(N, df);

        for (const [docId, fieldMap] of byDoc) {
          const docEntry = this.docsMap.get(docId);
          if (!docEntry) continue;

          let pseudoTF = 0;
          let strengthMap = docFieldStrength.get(docId);
          for (const [field, positions] of fieldMap) {
            const tf = positions.length;
            if (tf === 0) continue;
            const weight = this.fieldWeights[field] ?? 1;
            const fieldLen = docEntry.fieldTokenCount[field] ?? 0;
            const avgLen = this.avgFieldLength(field, N);
            const lenNorm = avgLen > 0 ? 1 - this.b + this.b * (fieldLen / avgLen) : 1;
            const safeNorm = lenNorm > 0 ? lenNorm : 1;
            const fieldContribution = (weight * tf) / safeNorm;
            pseudoTF += fieldContribution;

            if (!strengthMap) {
              strengthMap = new Map();
              docFieldStrength.set(docId, strengthMap);
            }
            strengthMap.set(field, (strengthMap.get(field) ?? 0) + idfVal * fieldContribution);
          }
          if (pseudoTF <= 0) continue;

          const contribution = (idfVal * pseudoTF * (this.k1 + 1)) / (this.k1 + pseudoTF);
          docScore.set(docId, (docScore.get(docId) ?? 0) + contribution);

          let vocabSet = docVocabTermsMatched.get(docId);
          if (!vocabSet) {
            vocabSet = new Set();
            docVocabTermsMatched.set(docId, vocabSet);
          }
          vocabSet.add(vTerm);

          let qSet = docQueryTermsMatched.get(docId);
          if (!qSet) {
            qSet = new Set();
            docQueryTermsMatched.set(docId, qSet);
          }
          qSet.add(qTerm);
        }
      }
    }

    if (opts.requireAll) {
      for (const docId of [...docScore.keys()]) {
        const matchedCount = docQueryTermsMatched.get(docId)?.size ?? 0;
        if (matchedCount < distinctTerms.length) docScore.delete(docId);
      }
    }

    return this.finalizeResults(
      docScore,
      docFieldStrength,
      (docId) => [...(docVocabTermsMatched.get(docId) ?? new Set<string>())].sort(),
      (docId, field) => {
        const fieldText = this.docsMap.get(docId)?.fields[field] ?? "";
        return this.matchedPositionsInField(fieldText, docVocabTermsMatched.get(docId));
      },
      limit,
    );
  }

  private searchPhrase(queryTerms: string[], opts: { prefix: boolean }, N: number, limit: number): FtsMatch[] {
    const n = queryTerms.length;
    const lastIdx = n - 1;
    const slots: string[][] = queryTerms.map((t, i) => {
      if (opts.prefix && i === lastIdx) return this.expandPrefix(t);
      return this.postings.has(t) ? [t] : [];
    });
    if (slots.some((s) => s.length === 0)) return [];

    let candidateDocIds: Set<string> | undefined;
    for (const slotTerms of slots) {
      const slotDocIds = new Set<string>();
      for (const t of slotTerms) {
        const byDoc = this.postings.get(t);
        if (!byDoc) continue;
        for (const docId of byDoc.keys()) slotDocIds.add(docId);
      }
      const previous = candidateDocIds;
      const next: Set<string> = previous ? new Set([...previous].filter((d) => slotDocIds.has(d))) : slotDocIds;
      candidateDocIds = next;
      if (next.size === 0) return [];
    }
    if (!candidateDocIds || candidateDocIds.size === 0) return [];

    const docFieldHits = new Map<string, Map<string, number[]>>();
    for (const docId of candidateDocIds) {
      const docEntry = this.docsMap.get(docId);
      if (!docEntry) continue;
      for (const field of Object.keys(docEntry.fields)) {
        const positionsPerSlot: number[][] = slots.map((slotTerms) => {
          const merged: number[] = [];
          for (const t of slotTerms) {
            const p = this.postings.get(t)?.get(docId)?.get(field);
            if (p) merged.push(...p);
          }
          merged.sort((a, b) => a - b);
          return merged;
        });
        const starts = InvertedIndex.phraseStartPositions(positionsPerSlot);
        if (starts.length > 0) {
          let fieldMap = docFieldHits.get(docId);
          if (!fieldMap) {
            fieldMap = new Map();
            docFieldHits.set(docId, fieldMap);
          }
          fieldMap.set(field, starts);
        }
      }
    }

    const df = docFieldHits.size;
    if (df === 0) return [];
    const idfVal = this.idf(N, df);

    const docScore = new Map<string, number>();
    const docFieldStrength = new Map<string, Map<string, number>>();

    for (const [docId, fieldMap] of docFieldHits) {
      const docEntry = this.docsMap.get(docId);
      if (!docEntry) continue;
      let pseudoTF = 0;
      let strengthMap = docFieldStrength.get(docId);
      for (const [field, starts] of fieldMap) {
        const tf = starts.length;
        const weight = this.fieldWeights[field] ?? 1;
        const fieldLen = docEntry.fieldTokenCount[field] ?? 0;
        const avgLen = this.avgFieldLength(field, N);
        const lenNorm = avgLen > 0 ? 1 - this.b + this.b * (fieldLen / avgLen) : 1;
        const safeNorm = lenNorm > 0 ? lenNorm : 1;
        const fieldContribution = (weight * tf) / safeNorm;
        pseudoTF += fieldContribution;

        if (!strengthMap) {
          strengthMap = new Map();
          docFieldStrength.set(docId, strengthMap);
        }
        strengthMap.set(field, (strengthMap.get(field) ?? 0) + idfVal * fieldContribution);
      }
      if (pseudoTF <= 0) continue;
      const contribution = (idfVal * pseudoTF * (this.k1 + 1)) / (this.k1 + pseudoTF);
      docScore.set(docId, contribution);
    }

    return this.finalizeResults(
      docScore,
      docFieldStrength,
      () => queryTerms.slice(),
      (docId, field) => {
        const starts = docFieldHits.get(docId)?.get(field) ?? [];
        const result = new Set<number>();
        for (const p of starts) for (let k = 0; k < n; k++) result.add(p + k);
        return result;
      },
      limit,
    );
  }

  private static phraseStartPositions(positionsPerTerm: number[][]): number[] {
    if (positionsPerTerm.length === 0 || positionsPerTerm.some((arr) => arr.length === 0)) return [];
    let candidates = positionsPerTerm[0];
    for (let i = 1; i < positionsPerTerm.length; i++) {
      const nextSet = new Set(positionsPerTerm[i]);
      candidates = candidates.filter((p) => nextSet.has(p + i));
    }
    return candidates;
  }

  private matchedPositionsInField(fieldText: string, vocabSet: Set<string> | undefined): Set<number> {
    const result = new Set<number>();
    if (!vocabSet || vocabSet.size === 0) return result;
    ftsTokenize(fieldText).forEach((t, i) => {
      if (vocabSet.has(t.term)) result.add(i);
    });
    return result;
  }

  private finalizeResults(
    docScore: Map<string, number>,
    docFieldStrength: Map<string, Map<string, number>>,
    matchedTermsOf: (docId: string) => string[],
    matchedPositionsOf: (docId: string, field: string) => Set<number>,
    limit: number,
  ): FtsMatch[] {
    const results: FtsMatch[] = [];
    for (const [docId, score] of docScore) {
      if (!(score > 0)) continue;
      const docEntry = this.docsMap.get(docId);
      if (!docEntry) continue;

      const strengthMap = docFieldStrength.get(docId);
      let bestField: string | null = null;
      let bestStrength = -Infinity;
      if (strengthMap) {
        for (const [field, s] of strengthMap) {
          if (s > bestStrength) {
            bestStrength = s;
            bestField = field;
          }
        }
      }
      if (bestField === null) {
        const names = Object.keys(docEntry.fields);
        bestField = names.length > 0 ? names[0] : null;
      }

      let snippetField = bestField ?? "";
      let snippetText = "";
      let highlights: Array<[number, number]> = [];
      if (bestField !== null) {
        const fieldText = docEntry.fields[bestField] ?? "";
        const built = this.buildSnippet(fieldText, matchedPositionsOf(docId, bestField));
        snippetText = built.text;
        highlights = built.highlights;
      }

      results.push({
        id: docId,
        score,
        matchedTerms: matchedTermsOf(docId),
        snippet: { field: snippetField, text: snippetText, highlights },
      });
    }

    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return results.slice(0, limit);
  }

  /** Extracts the highest-density ~200-char window around matched-token positions, with offset-correct highlights. */
  private buildSnippet(fieldText: string, matchedPositions: Set<number>): { text: string; highlights: Array<[number, number]> } {
    const textLen = fieldText.length;
    if (matchedPositions.size === 0) {
      return { text: fieldText.slice(0, Math.min(SNIPPET_WINDOW, textLen)), highlights: [] };
    }
    const tokens = ftsTokenize(fieldText);
    const matchOffsets: Array<{ start: number; end: number }> = [];
    tokens.forEach((t, i) => {
      if (matchedPositions.has(i)) matchOffsets.push({ start: t.start, end: t.end });
    });
    if (matchOffsets.length === 0) {
      return { text: fieldText.slice(0, Math.min(SNIPPET_WINDOW, textLen)), highlights: [] };
    }

    let bestLeft = 0;
    let bestRight = 0;
    let bestCount = 0;
    let left = 0;
    for (let right = 0; right < matchOffsets.length; right++) {
      while (left < right && matchOffsets[right].end - matchOffsets[left].start > SNIPPET_WINDOW) {
        left++;
      }
      const count = right - left + 1;
      if (count > bestCount) {
        bestCount = count;
        bestLeft = left;
        bestRight = right;
      }
    }

    const coveredStart = matchOffsets[bestLeft].start;
    const coveredEnd = matchOffsets[bestRight].end;
    const coveredLen = coveredEnd - coveredStart;
    const pad = Math.max(0, SNIPPET_WINDOW - coveredLen);
    let winStart = Math.max(0, coveredStart - Math.floor(pad / 2));
    let winEnd = Math.min(textLen, winStart + SNIPPET_WINDOW);
    winStart = Math.max(0, winEnd - SNIPPET_WINDOW);

    const highlights: Array<[number, number]> = [];
    for (const m of matchOffsets) {
      const s = Math.max(m.start, winStart);
      const e = Math.min(m.end, winEnd);
      if (e > s) highlights.push([s - winStart, e - winStart]);
    }

    return { text: fieldText.slice(winStart, winEnd), highlights };
  }
}
