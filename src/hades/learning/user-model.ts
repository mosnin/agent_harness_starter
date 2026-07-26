import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryRecord } from "../memory/store";

export interface UserTrait {
  attribute: string;
  value: string;
  confidence: number;
  evidence: string[];
  updatedAt: number;
  /** How many times the belief was revised (dialectic churn). */
  revisions: number;
}

export interface Assertion {
  attribute: string;
  value: string;
  confidence?: number;
  evidence?: string;
  now?: number;
}

export type TraitDeriver = (memories: MemoryRecord[]) => Array<Omit<Assertion, "now">>;

type Decision = "created" | "reinforced" | "revised" | "ignored";

/**
 * Decide, dialectically, how a new assertion updates an existing belief:
 *  - no prior belief → create it;
 *  - same value → reinforce (raise confidence, merge evidence);
 *  - conflicting value with higher confidence → revise (thesis → antithesis →
 *    new synthesis);
 *  - conflicting value with lower/equal confidence → keep the current belief.
 * Pure and exported for testing.
 */
export function reconcile(existing: UserTrait | undefined, incoming: Assertion): Decision {
  if (!existing) return "created";
  if (normalize(existing.value) === normalize(incoming.value)) return "reinforced";
  return (incoming.confidence ?? 0.5) > existing.confidence ? "revised" : "ignored";
}

/**
 * A durable, evolving model of the user — the Honcho-style dialectic layer. It
 * turns scattered memories into stable beliefs ("prefers TypeScript", "based in
 * Berlin"), reconciling new evidence against old so the picture sharpens across
 * sessions instead of contradicting itself. This is what lets Hades build a
 * deepening model of who you are.
 */
export class UserModel {
  protected traits = new Map<string, UserTrait>();

  assert(a: Assertion): Decision {
    const key = a.attribute.toLowerCase();
    const existing = this.traits.get(key);
    const decision = reconcile(existing, a);
    const now = a.now ?? this.now();
    const conf = clamp01(a.confidence ?? 0.5);

    switch (decision) {
      case "created":
        this.traits.set(key, {
          attribute: a.attribute,
          value: a.value,
          confidence: conf,
          evidence: a.evidence ? [a.evidence] : [],
          updatedAt: now,
          revisions: 0,
        });
        break;
      case "reinforced": {
        const t = existing!;
        t.confidence = clamp01(t.confidence + (1 - t.confidence) * 0.3); // asymptotic toward 1
        if (a.evidence && !t.evidence.includes(a.evidence)) t.evidence.push(a.evidence);
        t.updatedAt = now;
        break;
      }
      case "revised":
        this.traits.set(key, {
          attribute: a.attribute,
          value: a.value,
          confidence: conf,
          evidence: a.evidence ? [a.evidence] : [],
          updatedAt: now,
          revisions: (existing!.revisions ?? 0) + 1,
        });
        break;
      case "ignored":
        break;
    }
    this.persist();
    return decision;
  }

  get(attribute: string): UserTrait | undefined {
    return this.traits.get(attribute.toLowerCase());
  }
  all(): UserTrait[] {
    return [...this.traits.values()].sort((a, b) => b.confidence - a.confidence);
  }

  /** Build/extend the model from stored memories via an (optional) deriver. */
  ingest(memories: MemoryRecord[], deriver: TraitDeriver = deriveTraitsFromMemories): void {
    for (const a of deriver(memories)) this.assert(a);
  }

  /** Prose description of the user, most-confident traits first. */
  describe(): string {
    const traits = this.all().filter((t) => t.confidence >= 0.3);
    if (traits.length === 0) return "No durable model of the user yet.";
    return (
      "What Hades knows about the user:\n" +
      traits.map((t) => `- ${t.attribute}: ${t.value} (${(t.confidence * 100) | 0}% confident)`).join("\n")
    );
  }

  toJSON(): UserTrait[] {
    return this.all();
  }

  protected now(): number {
    return Date.now();
  }
  protected persist(): void {}
}

/** File-backed user model — durable across sessions. */
export class FileUserModel extends UserModel {
  constructor(private readonly path: string) {
    super();
    try {
      const arr = JSON.parse(readFileSync(path, "utf8")) as UserTrait[];
      for (const t of arr) this.traits.set(t.attribute.toLowerCase(), t);
    } catch {
      /* fresh */
    }
  }
  protected override persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      /* exists */
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.toJSON()));
    renameSync(tmp, this.path);
  }
}

/** Offline trait extraction from memory facts. */
export function deriveTraitsFromMemories(memories: MemoryRecord[]): Array<Omit<Assertion, "now">> {
  const out: Array<Omit<Assertion, "now">> = [];
  const rules: Array<{ re: RegExp; attribute: string }> = [
    { re: /name is ([A-Za-z][\w' -]{1,40})/i, attribute: "name" },
    { re: /(?:based|lives?) in ([A-Za-z][\w' -]{1,40})/i, attribute: "location" },
    { re: /prefers? ([^.\n]{2,60})/i, attribute: "preference" },
    { re: /(?:uses|works with|works on) ([^.\n]{2,60})/i, attribute: "stack" },
  ];
  for (const m of memories) {
    for (const r of rules) {
      const match = m.fact.match(r.re);
      if (match) {
        out.push({ attribute: r.attribute, value: match[1].trim(), confidence: m.salience, evidence: m.fact });
      }
    }
  }
  return out;
}

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
