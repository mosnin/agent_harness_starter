import { describe, it, expect } from "vitest";
import { loadConfig, configFromEnv, DEFAULT_CONFIG } from "../config/config";
import { I18n, defaultI18n } from "../config/i18n";

describe("loadConfig", () => {
  it("returns defaults with a derived memory path", () => {
    const c = loadConfig();
    expect(c.locale).toBe("en");
    expect(c.dataDir).toBe(".hades");
    expect(c.memoryPath).toBe(".hades/memory.json");
  });

  it("layers defaults < file < env < overrides", () => {
    const c = loadConfig({
      file: { model: "file-model", locale: "es" },
      env: { HADES_MODEL: "env-model" },
      overrides: { locale: "fr" },
    });
    expect(c.model).toBe("env-model"); // env beats file
    expect(c.locale).toBe("fr"); // override beats env/file
  });

  it("shallow-merges the gateway object across layers", () => {
    const c = loadConfig({
      file: { gateway: { trigger: "/swarm" } },
      env: { HADES_GATEWAY_ALLOWED_USERS: "u1, u2" },
    });
    expect(c.gateway.trigger).toBe("/swarm"); // preserved
    expect(c.gateway.allowedUsers).toEqual(["u1", "u2"]);
  });

  it("parses list-valued env vars", () => {
    const partial = configFromEnv({ HADES_PLUGINS: "kanban, browser ,achievements" });
    expect(partial.plugins).toEqual(["kanban", "browser", "achievements"]);
  });

  it("respects an explicit memoryPath over the derived default", () => {
    const c = loadConfig({ overrides: { memoryPath: "/custom/mem.json" } });
    expect(c.memoryPath).toBe("/custom/mem.json");
  });

  it("does not mutate DEFAULT_CONFIG", () => {
    loadConfig({ overrides: { plugins: ["x"] } });
    expect(DEFAULT_CONFIG.plugins).toEqual([]);
  });
});

describe("I18n", () => {
  it("translates with interpolation", () => {
    const i18n = defaultI18n("en");
    expect(i18n.t("memory.remembered", { fact: "pnpm" })).toBe("Remembered: pnpm");
  });

  it("uses the active locale and falls back to default for missing keys", () => {
    const i18n = new I18n(undefined, "es");
    expect(i18n.t("repl.welcome")).toContain("Bienvenido");
    // Not in the Spanish catalog → falls back to English.
    expect(i18n.t("cli.help.title")).toContain("learning agent");
  });

  it("returns the key itself when unknown, keeping unfilled placeholders", () => {
    const i18n = defaultI18n();
    expect(i18n.t("no.such.key")).toBe("no.such.key");
    expect(i18n.t("model.switched")).toBe("Switched to {model}.");
  });

  it("can switch locale at runtime and lists available locales", () => {
    const i18n = defaultI18n("en");
    expect(i18n.t("repl.goodbye")).toBe("Goodbye.");
    i18n.setLocale("es");
    expect(i18n.t("repl.goodbye")).toBe("Adiós.");
    expect(i18n.availableLocales().sort()).toEqual(["en", "es"]);
  });
});
