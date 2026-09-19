/**
 * Zero-RTT evidence cards from tool results.
 *
 * Qwen hallucinates when the only facts live in a raw tool blob it can ignore.
 * Harvest appends a short card to `jevEvidence` so postflight can ground the draft.
 * No System One call — this is the citation-verifier "code splits, Jev scores" split.
 * Secrets are stripped here so the next prompt never sees a leaked key.
 */

import { redactSecrets } from "./redact";

export function harvestToolEvidence(toolName: string, output: unknown): string {
  if (output == null) return "";
  const text = redactSecrets(extractReadable(output)).text;
  if (!text.trim()) return "";
  return `[${toolName}] ${text}`.slice(0, 1500);
}

export function mergeEvidence(existing: unknown, card: string, max = 8000): string {
  const prior = redactSecrets(String(existing ?? "")).text.trim();
  const next = redactSecrets(card).text.trim();
  if (!next) return prior;
  return (prior ? `${prior}\n${next}` : next).slice(0, max);
}

function extractReadable(output: unknown): string {
  if (typeof output === "string") return output;
  if (typeof output !== "object") return String(output);
  const rec = output as Record<string, unknown>;
  const preferred = [rec.stdout, rec.text, rec.content, rec.snippet, rec.result, rec.output];
  for (const value of preferred) {
    if (typeof value === "string" && value.trim()) return value;
  }
  if (Array.isArray(rec.results)) {
    return rec.results
      .slice(0, 5)
      .map((row) => {
        if (!row || typeof row !== "object") return String(row);
        const item = row as Record<string, unknown>;
        return String(item.content ?? item.snippet ?? item.title ?? "");
      })
      .filter(Boolean)
      .join("\n");
  }
  try {
    return JSON.stringify(output);
  } catch {
    return "";
  }
}
