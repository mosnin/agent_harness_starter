import type { NormalizationStrategy } from "./types";

export function normalizeVector(v: number[], strategy: NormalizationStrategy): number[] {
  if (strategy === "none") {
    return [...v];
  }

  if (strategy === "l2") {
    const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    if (norm === 0) return [...v];
    return v.map((x) => x / norm);
  }

  if (strategy === "l1") {
    const norm = v.reduce((sum, x) => sum + Math.abs(x), 0);
    if (norm === 0) return [...v];
    return v.map((x) => x / norm);
  }

  if (strategy === "minmax") {
    const min = Math.min(...v);
    const max = Math.max(...v);
    const range = max - min;
    if (range === 0) return [...v];
    return v.map((x) => (x - min) / range);
  }

  // Should never reach here with strict typing, but satisfy TypeScript
  return [...v];
}
