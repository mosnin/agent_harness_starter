import { describe, expect, it } from "vitest";
import { light, dark, cssVars, type ThemeTokens } from "@/desktop/ui/theme";

function keySet(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort();
}

function relativeLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

describe("theme tokens", () => {
  it("light and dark define exactly the same top-level token groups", () => {
    expect(keySet(light as unknown as Record<string, unknown>)).toEqual(
      keySet(dark as unknown as Record<string, unknown>)
    );
  });

  it("light and dark define the same color keys (no missing token in a theme)", () => {
    expect(keySet(light.color)).toEqual(keySet(dark.color));
  });

  it("light and dark agree on space, radius, shadow, and type sub-keys", () => {
    expect(keySet(light.space)).toEqual(keySet(dark.space));
    expect(keySet(light.radius)).toEqual(keySet(dark.radius));
    expect(keySet(light.shadow)).toEqual(keySet(dark.shadow));
    expect(keySet(light.motion)).toEqual(keySet(dark.motion));
    expect(keySet(light.type.family)).toEqual(keySet(dark.type.family));
    expect(keySet(light.type.size)).toEqual(keySet(dark.type.size));
    expect(keySet(light.type.weight)).toEqual(keySet(dark.type.weight));
  });

  it("required semantic + core color keys are present in both themes", () => {
    const required = ["bg", "surface", "ink", "accent", "ok", "warn", "bad"];
    for (const theme of [light, dark]) {
      for (const key of required) {
        expect(theme.color[key], `missing color.${key}`).toBeTruthy();
      }
    }
  });

  it("cssVars emits a :root{...} block containing every color variable", () => {
    for (const theme of [light, dark] as ThemeTokens[]) {
      const css = cssVars(theme);
      expect(css.startsWith(":root{")).toBe(true);
      expect(css.endsWith("}")).toBe(true);
      for (const key of Object.keys(theme.color)) {
        expect(css).toContain(`--color-${key}:${theme.color[key]};`);
      }
    }
  });

  it("accent is a distinct color from ink in both themes", () => {
    expect(light.color.accent.toLowerCase()).not.toBe(light.color.ink.toLowerCase());
    expect(dark.color.accent.toLowerCase()).not.toBe(dark.color.ink.toLowerCase());
  });

  it("bg vs ink have strong contrast (hex luminance differs substantially)", () => {
    const lightContrast = Math.abs(
      relativeLuminance(light.color.bg) - relativeLuminance(light.color.ink)
    );
    const darkContrast = Math.abs(
      relativeLuminance(dark.color.bg) - relativeLuminance(dark.color.ink)
    );
    expect(lightContrast).toBeGreaterThan(0.5);
    expect(darkContrast).toBeGreaterThan(0.5);
  });

  it("dark bg is darker than light bg", () => {
    expect(relativeLuminance(dark.color.bg)).toBeLessThan(relativeLuminance(light.color.bg));
  });
});
