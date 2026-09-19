/**
 * Zero-RTT jailbreak block using the existing pattern detector.
 *
 * Jev still scores ambiguous injection. Canned overrides ("ignore previous
 * instructions", DAN, fake system tags) are decided in process so they never
 * ride to TypeSafe and never wait on a 70–500ms hop.
 */

import { hasLocalInjection } from "../guardrails/injection";
import type { PolicyDecision } from "./types";

export { hasLocalInjection };

export function localInjectionBlock(node: string): PolicyDecision {
  return { action: "block", value: "injection", reason: "injection-local", node };
}

export function hasLocalInjectionIn(value: unknown, depth = 0): boolean {
  if (depth > 6 || value == null) return false;
  if (typeof value === "string") return hasLocalInjection(value);
  if (Array.isArray(value)) return value.some((item) => hasLocalInjectionIn(item, depth + 1));
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((child) =>
      hasLocalInjectionIn(child, depth + 1)
    );
  }
  return false;
}
